/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/audit-native-corpus.js
    Purpose: Audit native expression snapshots against upstream compiler tests.
    Responsibilities: compare preprocessing parity, report incomplete analyses,
        and retain coverage measurements.
    Does not contain: upstream edits, test-program execution, or a type oracle.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { MAX_ANALYSIS_BYTES, analyzeSavedModule, decodeCompilerSourceBuffer } = require("../lib/compiler-analysis");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");
const { positionOffset, normalizeTypeName } = require("../lib/semantic-model");
const { CompilerAnalysisWorker } = require("../lib/compiler-worker");
const { queryCompilerModel } = require("../lib/compiler-model-queries");
const { executeBoundedProcess } = require("../lib/compiler-diagnostics");
const { resolveFreeBasicRoot } = require("./audit-freebasic-coverage");
const { EXPRESSION_PARSER_HOOKS } = require("./compiler-expression-parser-hooks");
const { QUIRK_EXPRESSION_HOOKS, QUIRK_EXPRESSION_FOCUSED_FAMILIES, EXCEPTIONAL_EXPRESSION_FAMILY_HOOKS, TYPE_LAYOUT_EXPRESSION_HOOKS } = require("./compiler-expression-hooks");
const { auditImplicitCallRoutes } = require("./audit-compiler-call-routes");

const NATIVE_AUDIT_MAX_ERRORS = 50;
const DEFAULT_NATIVE_AUDIT_TIMEOUT_MS = 10000;
const MAX_NATIVE_AUDIT_TIMEOUT_MS = 300000;
const TRANSIENT_SPAWN_RETRY_DELAYS_MS = Object.freeze([25, 100, 250]);

// These portable upstream categories exercise expression and declaration
// grammar, recovery, preprocessing, overloads, legacy quirk forms, and the
// standard runtime APIs. Intentional compile failures are included. Backend,
// operating-system, interactive, and performance suites remain excluded.
// Both compilers receive identical explicit options; source-level #cmdline
// cannot redirect output or invoke tools.
const CATEGORIES = [
    "boolean", "command-sweep", "compound", "const", "dim", "expressions",
    "file", "fblite", "functions", "gfx", "namespace", "numbers", "overload", "pointers",
    "pp", "qb", "quirk", "scopes", "sfx", "string", "structs", "syntax",
    "threads", "typedef", "udt-wstring", "udt-zstring", "virtual", "visibility",
    "wstring", "console"
];
const LANGUAGE_MODE_ARGUMENTS = Object.freeze({
    fb: ["-lang", "fb"],
    fblite: ["-lang", "fblite"],
    qb: ["-lang", "qb"],
    deprecated: ["-lang", "deprecated"]
});
/* FBC selects these code generators with -gen. Several compiler semantic
   paths, including intrinsic ABI type construction, depend on this choice. */
const BACKEND_ARGUMENTS = Object.freeze({
    gas: ["-gen", "gas"],
    gcc: ["-gen", "gcc"],
    clang: ["-gen", "clang"],
    llvm: ["-gen", "llvm"],
    gas64: ["-gen", "gas64"]
});
/* Keep canonical names in sync with FBC's cputypeinfo table in fb.bas. The
   corpus uses -pp, so these targets exercise compiler layout and ABI choices
   without requiring a native assembler for each architecture. */
const ARCHITECTURE_ARGUMENTS = Object.freeze({
    "x86-32": ["-arch", "386"],
    "x86-64": ["-arch", "x86_64"],
    armv4: ["-arch", "armv4"],
    armv5: ["-arch", "armv5te"],
    armv6: ["-arch", "armv6"],
    "armv6-fp": ["-arch", "armv6+fp"],
    armv7: ["-arch", "armv7-a"],
    "armv7-fp": ["-arch", "armv7-a+fp"],
    aarch64: ["-arch", "aarch64"],
    powerpc: ["-arch", "powerpc"],
    powerpc64: ["-arch", "powerpc64"],
    powerpc64le: ["-arch", "powerpc64le"],
    riscv32: ["-arch", "riscv32"],
    riscv64: ["-arch", "riscv64"],
    s390x: ["-arch", "s390x"],
    loongarch64: ["-arch", "loongarch64"],
    mips32: ["-arch", "mips32"],
    mips32el: ["-arch", "mips32el"],
    mips64: ["-arch", "mips64"],
    mips64el: ["-arch", "mips64el"]
});

function parseNativeCorpusArguments(arguments_) {
    const semanticSidecar = arguments_.includes("--semantic-sidecar");
    const semanticBindings = arguments_.includes("--semantic-bindings");
    const extendedSyntaxFlags = arguments_.filter((argument) => argument === "--extended-syntax");
    const categories = arguments_.filter((argument) => argument.startsWith("--category=")).map((argument) => argument.slice("--category=".length));
    const modes = arguments_.filter((argument) => argument.startsWith("--language-mode=")).map((argument) => argument.slice("--language-mode=".length).toLowerCase());
    const architectures = arguments_.filter((argument) => argument.startsWith("--architecture=")).map((argument) => argument.slice("--architecture=".length).toLowerCase());
    const backends = arguments_.filter((argument) => argument.startsWith("--backend=")).map((argument) => argument.slice("--backend=".length).toLowerCase());
    const timeouts = arguments_.filter((argument) => argument.startsWith("--timeout-ms=")).map((argument) => argument.slice("--timeout-ms=".length));
    const unknown = arguments_.filter((argument) => argument !== "--semantic-sidecar" && argument !== "--semantic-bindings" && argument !== "--extended-syntax" &&
        !argument.startsWith("--category=") && !argument.startsWith("--language-mode=") &&
        !argument.startsWith("--architecture=") && !argument.startsWith("--backend=") &&
        !argument.startsWith("--timeout-ms="));
    if (unknown.length) throw new Error(`Unknown native corpus audit arguments: ${unknown.join(", ")}`);
    if (modes.length > 1) throw new Error("Choose at most one native corpus language mode.");
    if (architectures.length > 1) throw new Error("Choose at most one native corpus target architecture.");
    if (backends.length > 1) throw new Error("Choose at most one native corpus code-generation backend.");
    if (timeouts.length > 1) throw new Error("Choose at most one native corpus analysis timeout.");
    if (extendedSyntaxFlags.length > 1) throw new Error("Choose the native corpus extended-syntax profile at most once.");
    if (semanticSidecar && semanticBindings) throw new Error("Choose either expression-sidecar or full binding-sidecar coverage, not both.");
    const mode = modes[0];
    if (mode && !Object.prototype.hasOwnProperty.call(LANGUAGE_MODE_ARGUMENTS, mode)) {
        throw new Error(`Unknown native corpus language mode: ${mode}`);
    }
    const architecture = architectures[0];
    if (architecture && !Object.prototype.hasOwnProperty.call(ARCHITECTURE_ARGUMENTS, architecture)) {
        throw new Error(`Unknown native corpus target architecture: ${architecture}`);
    }
    const backend = backends[0];
    if (backend && !Object.prototype.hasOwnProperty.call(BACKEND_ARGUMENTS, backend)) {
        throw new Error(`Unknown native corpus code-generation backend: ${backend}`);
    }
    if (backend === "gas" && architecture && architecture !== "x86-32") {
        throw new Error("The GAS code-generation backend requires --architecture=x86-32.");
    }
    if (backend === "gas64" && architecture && architecture !== "x86-64") {
        throw new Error("The GAS64 code-generation backend requires --architecture=x86-64.");
    }
    const timeoutMs = timeouts.length ? Number(timeouts[0]) : DEFAULT_NATIVE_AUDIT_TIMEOUT_MS;
    if ((timeouts.length && !/^\d+$/.test(timeouts[0])) || !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 || timeoutMs > MAX_NATIVE_AUDIT_TIMEOUT_MS) {
        throw new Error(`Native corpus analysis timeout must be an integer from 1 to ${MAX_NATIVE_AUDIT_TIMEOUT_MS} milliseconds.`);
    }
    const unknownCategories = categories.filter((category) => !CATEGORIES.includes(category));
    if (unknownCategories.length) throw new Error(`Unknown native corpus categories: ${unknownCategories.join(", ")}`);
    return {
        semanticSidecar,
        semanticBindings,
        categories: categories.length ? categories : undefined,
        languageMode: mode || "fb",
        timeoutMs,
        compilerArguments: [
            ...(mode ? LANGUAGE_MODE_ARGUMENTS[mode] : []),
            ...(architecture ? ARCHITECTURE_ARGUMENTS[architecture] : []),
            ...(backend ? BACKEND_ARGUMENTS[backend] : []),
            ...(extendedSyntaxFlags.length ? ["-exx"] : [])
        ]
    };
}

async function executeWithEaccesRetry(execute) {
    let attempt = 0;

    while (true) {
        try {
            return await execute();
        } catch (error) {
            if (error?.code !== "EACCES" || attempt >= TRANSIENT_SPAWN_RETRY_DELAYS_MS.length) {
                throw error;
            }

            /* Keep occasional executable-start denials from invalidating
               a large corpus run while making persistent errors fail closed. */
            const delayMs = TRANSIENT_SPAWN_RETRY_DELAYS_MS[attempt];
            attempt++;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

function emptyExpressionCoverage() {
    return { completeFiles: 0, typedRanges: 0, syntaxRanges: 0, coveredRanges: 0, missingSyntax: 0, missingTypes: 0, invalidMissingTypes: 0, provisionalMissingTypes: 0, unmarkedRecoveryTypes: 0, typeMismatches: 0 };
}

function emptySemanticSidecarCoverage() {
    return {
        files: 0,
        expressions: 0,
        compared: 0,
        directiveExpressions: 0,
        traceMissing: 0,
        traceTypeMismatches: 0,
        supplemented: 0,
        overridden: 0,
        ambiguous: 0,
        missing: 0,
        typeMismatches: 0,
        traceDifferences: [],
        sidecarOnlyCompared: 0,
        sidecarOnlyAvailable: 0,
        sidecarOnlyAmbiguous: 0,
        sidecarOnlyMissing: 0,
        sidecarOnlyTypeMismatches: 0,
        sidecarOnlyStatusMismatches: 0,
        recoveryFiles: 0,
        recoveryFacts: 0,
        recoverySafeFacts: 0,
        recoverySidecarOnlyCompared: 0,
        recoverySidecarOnlyAvailable: 0,
        recoverySidecarOnlyAmbiguous: 0,
        recoverySidecarOnlyMissing: 0,
        recoverySidecarOnlyTypeMismatches: 0,
        recoverySidecarOnlyUnprovisional: 0,
        recoveryErrorLineFacts: 0,
        recoveryRetractedFacts: 0,
        recoveryNativeAnswers: 0,
        recoverySupplemented: 0,
        recoveryAmbiguous: 0,
        recoveryMissing: 0,
        recoveryTypeMismatches: 0,
        recoveryUnprovisional: 0,
        recoveryUnsafeRetained: 0,
        issues: []
    };
}

function emptySemanticBindingCoverage() {
    return {
        files: 0,
        bindingRecords: 0,
        bindings: 0,
        nonPhysicalBindings: 0,
        implicitCallRecords: 0,
        implicitCalls: 0,
        nonPhysicalImplicitCalls: 0,
        invalidRecordCounts: 0,
        callsByKind: {},
        missingSources: 0,
        outOfBoundsRanges: 0,
        invalidPhysicalRanges: 0,
        invalidSignatures: 0,
        issues: []
    };
}

/* Parser ownership alone does not prove that upstream tests exercise an AST
   route. Report generic expression-parser executions beside corpus coverage so
   an untested route remains visible instead of looking complete by inventory. */
function measureExpressionParserRouteCoverage(families = {}, parserHooks = EXPRESSION_PARSER_HOOKS) {
    const routes = [];
    for (const [file, names] of Object.entries(parserHooks)) {
        for (const name of names) {
            const executions = Number.isSafeInteger(families[name]) ? families[name] : 0;
            routes.push({ file, name, executions, exercised: executions > 0 });
        }
    }
    routes.sort((first, second) => first.file.localeCompare(second.file) || first.name.localeCompare(second.name));
    const unexercised = routes.filter((route) => !route.exercised).map(({ file, name }) => ({ file, name }));
    return { total: routes.length, exercised: routes.length - unexercised.length, unexercised, routes };
}

function measureNamedExpressionFamilyCoverage(families = {}, hooks = [], fixtureOnlyNames = []) {
    const fixtureOnly = new Set(fixtureOnlyNames);
    const routes = hooks.map(([file, name]) => {
        const executions = Number.isSafeInteger(families[name]) ? families[name] : 0;
        return { file, name, executions, exercised: executions > 0, fixtureOnly: fixtureOnly.has(name) };
    });
    routes.sort((first, second) => first.file.localeCompare(second.file) || first.name.localeCompare(second.name));
    const corpusRoutes = routes.filter((route) => !route.fixtureOnly);
    const unexercised = corpusRoutes.filter((route) => !route.exercised).map(({ file, name }) => ({ file, name }));
    const fixtureOnlyUnexercised = routes.filter((route) => route.fixtureOnly && !route.exercised).map(({ file, name }) => ({ file, name }));
    return {
        total: routes.length,
        exercised: routes.filter((route) => route.exercised).length,
        corpusRequired: corpusRoutes.length,
        corpusExercised: corpusRoutes.filter((route) => route.exercised).length,
        unexercised,
        fixtureOnlyUnexercised,
        routes
    };
}

function fullDefaultExpressionRouteCoverageFailures(routeReports, options) {
    if (options.categories || options.languageMode !== "fb") return [];
    const failures = [];
    for (const { name, coverage } of routeReports) {
        if (!Array.isArray(coverage?.unexercised)) {
            failures.push({ file: `<${name}-coverage>`, error: `Full default-FB corpus did not report ${name} coverage.` });
        } else if (coverage.unexercised.length) {
            failures.push({
                file: `<${name}-coverage>`,
                error: `Full default-FB corpus did not execute ${name}: ${coverage.unexercised.map((route) => route.name).join(", ")}`
            });
        }
    }
    return failures;
}

function measureSemanticBindingCoverage(analysis, sources) {
    if (!Array.isArray(analysis.semanticBindings) || !Array.isArray(analysis.semanticImplicitCalls)) {
        throw new Error("Full compiler semantic bindings and implicit calls are unavailable.");
    }
    const sourceByPath = new Map(sources.map((source) => [path.resolve(source.uri.fsPath), source]));
    const coverage = emptySemanticBindingCoverage();
    coverage.files = 1;
    coverage.bindings = analysis.semanticBindings.length;
    coverage.implicitCalls = analysis.semanticImplicitCalls.length;
    const physicalImplicitCalls = analysis.semanticImplicitCalls.filter((call) => call.physical === true);
    const reportedCounts = analysis.semanticModelCounts || {};
    const validateRecordCount = (name, rawCount, projectableCount, rawField, nonPhysicalField) => {
        const count = rawCount === undefined ? projectableCount : rawCount;
        if (!Number.isSafeInteger(count) || count < projectableCount) {
            coverage.invalidRecordCounts++;
            if (coverage.issues.length < 25) coverage.issues.push({
                reason: `${name} record total is invalid or smaller than its projectable facts`,
                recordCount: count,
                projectableCount
            });
            coverage[rawField] = projectableCount;
            coverage[nonPhysicalField] = 0;
            return;
        }
        coverage[rawField] = count;
        coverage[nonPhysicalField] = count - projectableCount;
    };
    validateRecordCount("semantic binding", reportedCounts.bindingCount, coverage.bindings, "bindingRecords", "nonPhysicalBindings");
    validateRecordCount("implicit call", reportedCounts.implicitCallCount, physicalImplicitCalls.length, "implicitCallRecords", "nonPhysicalImplicitCalls");
    const checkPhysicalRange = (fact, label) => {
        const recordIssue = (field, reason) => {
            coverage[field]++;
            if (coverage.issues.length < 25) coverage.issues.push({
                filePath: fact.filePath,
                startLine: fact.startLine,
                startColumn: fact.startColumn,
                endLine: fact.endLine,
                endColumn: fact.endColumn,
                kind: fact.kind || label,
                reason
            });
        };
        if (fact.physical !== true) recordIssue("invalidPhysicalRanges", `${label} is not anchored to physical source`);

        const source = sourceByPath.get(path.resolve(fact.filePath));
        if (!source) {
            recordIssue("missingSources", `${label} source is outside the captured dependency documents`);
            return;
        }
        const lines = source.text.split(/\r\n|\n|\r/);
        const startLine = lines[fact.startLine - 1];
        const endLine = lines[fact.endLine - 1];
        if (!Number.isSafeInteger(fact.startLine) || fact.startLine < 1 ||
            !Number.isSafeInteger(fact.endLine) || fact.endLine < fact.startLine ||
            !Number.isSafeInteger(fact.startColumn) || fact.startColumn < 0 ||
            !Number.isSafeInteger(fact.endColumn) || fact.endColumn < 0 ||
            startLine === undefined || endLine === undefined ||
            fact.startColumn > startLine.length || fact.endColumn > endLine.length) {
            recordIssue("outOfBoundsRanges", `${label} range is outside its physical source lines`);
        }
    };
    for (const binding of analysis.semanticBindings) checkPhysicalRange(binding, "semantic binding");
    for (const call of analysis.semanticImplicitCalls) {
        coverage.callsByKind[call.kind] = (coverage.callsByKind[call.kind] || 0) + 1;
        if (call.physical === true) checkPhysicalRange(call, "implicit call");
        if (typeof call.targetSignature !== "string" || !call.targetSignature) {
            coverage.invalidSignatures++;
            if (coverage.issues.length < 25) coverage.issues.push({
                filePath: call.filePath,
                startLine: call.startLine,
                startColumn: call.startColumn,
                endLine: call.endLine,
                endColumn: call.endColumn,
                kind: call.kind,
                reason: "implicit call has no selected target signature"
            });
        }
    }
    return coverage;
}

function addSemanticBindingCoverage(target, coverage) {
    for (const key of ["files", "bindingRecords", "bindings", "nonPhysicalBindings", "implicitCallRecords", "implicitCalls", "nonPhysicalImplicitCalls", "invalidRecordCounts", "missingSources", "outOfBoundsRanges", "invalidPhysicalRanges", "invalidSignatures"]) {
        target[key] += coverage[key] || 0;
    }
    for (const [kind, count] of Object.entries(coverage.callsByKind)) target.callsByKind[kind] = (target.callsByKind[kind] || 0) + count;
    if (target.issues.length < 25) target.issues.push(...coverage.issues.slice(0, 25 - target.issues.length));
}

function measureSemanticCallKindCoverage(callsByKind = {}, supportedKinds = []) {
    const supported = [...new Set(supportedKinds)].sort();
    const observed = Object.keys(callsByKind).filter((kind) => Number.isSafeInteger(callsByKind[kind]) && callsByKind[kind] > 0).sort();
    const observedSet = new Set(observed);
    const supportedSet = new Set(supported);
    return {
        supported,
        exercised: supported.filter((kind) => observedSet.has(kind)),
        missing: supported.filter((kind) => !observedSet.has(kind)),
        unexpected: observed.filter((kind) => !supportedSet.has(kind))
    };
}

function semanticCallKindCoverageFailures(coverage, options) {
    const failures = [];
    if (coverage.unexpected.length) failures.push({
        file: "<implicit-call-kind-coverage>",
        error: `Native corpus emitted unsupported implicit-call kinds: ${coverage.unexpected.join(", ")}`
    });
    if (!options.categories && options.languageMode === "fb" && coverage.missing.length) failures.push({
        file: "<implicit-call-kind-coverage>",
        error: `Full default-FB corpus did not exercise supported implicit-call kinds: ${coverage.missing.join(", ")}`
    });
    return failures;
}

function isBoundedAnalysisFailure(error) {
    return error instanceof Error && error.message === "Compiler analysis exceeded its 32 MiB output limit.";
}

function isIncompleteAnalysisFailure(error) {
    return error instanceof Error && error.message === "The compiler did not finish writing its analysis snapshot.";
}

function measureExpressionCoverage(analysis) {
    const rangeKey = (value) => `${value.start.line}:${value.start.character}:${value.end.line}:${value.end.character}`;
    const typed = new Map(analysis.expressions.map((expression) => [rangeKey(expression), expression]));
    const syntax = new Map(analysis.expressionGraph.nodes
        .filter((node) => node.kind === "syntax")
        .map((node) => [rangeKey(node), node]));
    const missingSyntax = [...typed.keys()].filter((key) => !syntax.has(key));
    const missingTypes = [...syntax.keys()].filter((key) => !typed.has(key));
    const invalidMissingTypes = missingTypes.filter((key) => syntax.get(key).invalid);
    const provisionalMissingTypes = missingTypes.filter((key) => {
        const node = syntax.get(key);
        return !node.invalid && node.provisional;
    });
    const unmarkedRecoveryTypes = missingTypes.length - invalidMissingTypes.length - provisionalMissingTypes.length;
    let typeMismatches = 0;
    for (const [key, expression] of typed) {
        const node = syntax.get(key);
        if (node && (expression.dtype !== node.dtype || expression.subtype !== node.subtype || expression.typeName !== node.typeName)) typeMismatches++;
    }
    return { typedRanges: typed.size, syntaxRanges: syntax.size, coveredRanges: typed.size - missingSyntax.length, missingSyntax: missingSyntax.length, missingTypes: missingTypes.length, invalidMissingTypes: invalidMissingTypes.length, provisionalMissingTypes: provisionalMissingTypes.length, unmarkedRecoveryTypes, typeMismatches };
}

function measureSemanticSidecarCoverage(analysis, model, sources) {
    const sourceByPath = new Map(sources.map((source) => {
        const filePath = path.resolve(source.uri.fsPath);
        const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
        return [key, { source, lines: source.text.split(/\r\n|\n|\r/) }];
    }));
    const coverage = { files: 1, expressions: 0, compared: 0, directiveExpressions: 0, traceMissing: 0, traceTypeMismatches: 0, supplemented: 0, overridden: 0, ambiguous: 0, missing: 0, typeMismatches: 0, traceDifferences: [], sidecarOnlyCompared: 0, sidecarOnlyAvailable: 0, sidecarOnlyAmbiguous: 0, sidecarOnlyMissing: 0, sidecarOnlyTypeMismatches: 0, sidecarOnlyStatusMismatches: 0, issues: [] };
    const ambiguousRanges = new Set();
    function recordAmbiguousRange(sourceUri, start, end) {
        const key = [sourceUri.toString(), start.line, start.character, end.line, end.character].join(":");
        if (ambiguousRanges.has(key)) return;
        ambiguousRanges.add(key);
        coverage.ambiguous++;
    }
    for (const fact of analysis.semanticExpressions) {
        if (!fact.physical) continue;
        coverage.expressions++;
        coverage.sidecarOnlyCompared++;
        const filePath = path.resolve(fact.filePath);
        const sourceSnapshot = sourceByPath.get(process.platform === "win32" ? filePath.toLowerCase() : filePath);
        if (!sourceSnapshot) {
            coverage.missing++;
            coverage.sidecarOnlyMissing++;
            coverage.issues.push({ filePath: fact.filePath, line: fact.startLine, column: fact.startColumn, typeName: fact.typeName, reason: "source snapshot is absent" });
            continue;
        }
        const { source, lines } = sourceSnapshot;
        const line = lines[fact.startLine - 1] || "";
        const start = { line: fact.startLine - 1, character: fact.startColumn };
        const end = { line: fact.endLine - 1, character: fact.endColumn };
        const sidecarOnly = model.expressionAtCompilerSidecarOnly(source.uri, start, end);
        if (!sidecarOnly) {
            if (model.isCompilerSidecarRangeAmbiguous(source.uri, start, end)) {
                coverage.sidecarOnlyAmbiguous++;
            } else {
                coverage.sidecarOnlyMissing++;
                if (coverage.issues.length < 25) coverage.issues.push({
                    filePath: fact.filePath,
                    line: fact.startLine,
                    column: fact.startColumn,
                    typeName: fact.typeName,
                    source: line.slice(0, 180),
                    reason: "compiler sidecar has no sidecar-only answer for its physical range"
                });
            }
        } else {
            const statusMatches = sidecarOnly.semanticSource === "compiler-sidecar" && sidecarOnly.provisional === false;
            const typeMatches = sidecarOnly.dtype === fact.dtype && normalizeTypeName(sidecarOnly.typeName) === normalizeTypeName(fact.typeName);
            if (!statusMatches) {
                coverage.sidecarOnlyStatusMismatches++;
                if (coverage.issues.length < 25) coverage.issues.push({
                    filePath: fact.filePath,
                    line: fact.startLine,
                    column: fact.startColumn,
                    expected: "authoritative compiler-sidecar result",
                    actual: `${sidecarOnly.semanticSource || "unknown source"}, provisional=${sidecarOnly.provisional}`,
                    source: line.slice(0, 180),
                    reason: "complete sidecar-only query did not return an authoritative result"
                });
            }
            if (!typeMatches) {
                coverage.sidecarOnlyTypeMismatches++;
                if (coverage.issues.length < 25) coverage.issues.push({
                    filePath: fact.filePath,
                    line: fact.startLine,
                    column: fact.startColumn,
                    expected: fact.typeName,
                    actual: sidecarOnly.typeName,
                    source: line.slice(0, 180),
                    reason: "sidecar-only query differs from its compiler semantic fact"
                });
            }
            if (statusMatches && typeMatches) coverage.sidecarOnlyAvailable++;
        }
        if (/^\s*#\s*(?:if|elseif|assert)\b/i.test(line)) {
            /* Directive expressions intentionally use this same sidecar as
               their editor source, so they are not an independent comparison. */
            coverage.directiveExpressions++;
            continue;
        }
        coverage.compared++;
        const traced = model.expressionAtTraceOnly(source.uri, start, end);
        if (!traced) {
            coverage.traceMissing++;
            if (coverage.traceDifferences.length < 25) coverage.traceDifferences.push({
                filePath: fact.filePath,
                line: fact.startLine,
                column: fact.startColumn,
                expected: fact.typeName,
                reason: "trace expression is missing",
                source: line.slice(0, 180)
            });
        } else if (traced.dtype !== fact.dtype || normalizeTypeName(traced.typeName) !== normalizeTypeName(fact.typeName)) {
            coverage.traceTypeMismatches++;
            if (coverage.traceDifferences.length < 25) coverage.traceDifferences.push({
                filePath: fact.filePath,
                line: fact.startLine,
                column: fact.startColumn,
                expected: fact.typeName,
                actual: traced.typeName,
                reason: "trace type differs from compiler semantic model",
                source: line.slice(0, 180)
            });
        }
        const typed = model.expressionAt(source.uri, start, end);
        if (typed?.semanticSource === "compiler-sidecar") {
            if (traced) coverage.overridden++;
            else coverage.supplemented++;
        }
        if (model.isCompilerSidecarRangeAmbiguous(source.uri, start, end)) {
            recordAmbiguousRange(source.uri, start, end);
            if (typed?.semanticSource === "compiler-sidecar") {
                coverage.typeMismatches++;
                coverage.issues.push({
                    filePath: fact.filePath,
                    line: fact.startLine,
                    column: fact.startColumn,
                    typeName: fact.typeName,
                    actual: typed.typeName,
                    source: line.slice(0, 180),
                    reason: "ambiguous compiler sidecar fact was selected for an editor query"
                });
            }
            continue;
        }
        if (!typed) {
            coverage.missing++;
            coverage.issues.push({ filePath: fact.filePath, line: fact.startLine, column: fact.startColumn, typeName: fact.typeName, source: line.slice(0, 180), reason: "editor model has no matching physical expression" });
            continue;
        }
        if (typed.dtype !== fact.dtype || normalizeTypeName(typed.typeName) !== normalizeTypeName(fact.typeName)) {
            coverage.typeMismatches++;
            coverage.issues.push({ filePath: fact.filePath, line: fact.startLine, column: fact.startColumn, expected: fact.typeName, actual: typed.typeName, source: line.slice(0, 180), reason: "editor type differs from compiler semantic model" });
        }
    }
    return coverage;
}

/* Partial compilations deliberately publish an incomplete expression sidecar.
   Audit every physical fact against the editor's safety boundary: facts on an
   error line or over source tokens retracted by recovery must stay withheld;
   an unaffected fact must either remain behind an existing native answer, be
   withheld for a genuinely ambiguous include context, or be available as a
   provisional type query. */
function measureRecoverySemanticSidecarCoverage(analysis, model, sources) {
    const coverage = {
        files: 1,
        recoveryFiles: analysis.semanticModelRecovery ? 1 : 0,
        recoveryFacts: 0,
        recoverySafeFacts: 0,
        recoverySidecarOnlyCompared: 0,
        recoverySidecarOnlyAvailable: 0,
        recoverySidecarOnlyAmbiguous: 0,
        recoverySidecarOnlyMissing: 0,
        recoverySidecarOnlyTypeMismatches: 0,
        recoverySidecarOnlyUnprovisional: 0,
        recoveryErrorLineFacts: 0,
        recoveryRetractedFacts: 0,
        recoveryNativeAnswers: 0,
        recoverySupplemented: 0,
        recoveryAmbiguous: 0,
        recoveryMissing: 0,
        recoveryTypeMismatches: 0,
        recoveryUnprovisional: 0,
        recoveryUnsafeRetained: 0,
        traceDifferences: [],
        issues: []
    };
    if (!analysis.partial) return coverage;

    const sourceByPath = new Map(sources.map((source) => {
        const filePath = path.resolve(source.uri.fsPath);
        return [process.platform === "win32" ? filePath.toLowerCase() : filePath, source];
    }));
    const errorLinesByPath = new Map();
    for (const error of analysis.errorPositions || []) {
        const filePath = path.resolve(error.sourceFile);
        const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
        const lines = errorLinesByPath.get(key) || new Set();
        lines.add(error.sourceLine);
        errorLinesByPath.set(key, lines);
    }
    const retainedRangesBySource = new Map([...model.compilerSidecarExpressions].map(([uri, facts]) => [
        uri,
        new Set(facts.map((fact) => `${fact.startOffset}:${fact.endOffset}`))
    ]));
    const queriedSafeRanges = new Set();
    function overlapsErrorLine(lines, startLine, endLine) {
        if (!lines) return false;
        for (const line of lines) if (line >= startLine && line <= endLine) return true;
        return false;
    }
    function overlapsRecoveredToken(document, start, end) {
        let low = 0;
        let high = document.tokens.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (document.tokens[middle].end <= start) low = middle + 1;
            else high = middle;
        }
        for (let index = low; index < document.tokens.length && document.tokens[index].offset < end; index++) {
            if (document.recoveryTokenOffsets.has(document.tokens[index].offset)) return true;
        }
        return false;
    }
    function addIssue(fact, reason, actual) {
        if (coverage.issues.length >= 25) return;
        coverage.issues.push({
            filePath: fact.filePath,
            line: fact.startLine,
            column: fact.startColumn,
            typeName: fact.typeName,
            actual,
            reason
        });
    }

    for (const fact of analysis.semanticExpressions || []) {
        if (fact.recovery !== true || !fact.physical) continue;
        coverage.recoveryFacts++;
        const filePath = path.resolve(fact.filePath);
        const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
        const source = sourceByPath.get(key);
        const document = source && model.sources.get(source.uri.toString());
        const lineStart = fact.startLine - 1;
        const lineEnd = fact.endLine - 1;
        if (!source || !document || lineStart < 0 || lineEnd < lineStart || lineEnd >= document.lineOffsets.length) {
            coverage.recoveryMissing++;
            addIssue(fact, "recovery fact has no valid source snapshot");
            continue;
        }
        const start = { line: lineStart, character: fact.startColumn };
        const end = { line: lineEnd, character: fact.endColumn };
        const from = positionOffset(document, start.line, start.character);
        const to = positionOffset(document, end.line, end.character);
        const range = `${from}:${to}`;
        const retained = retainedRangesBySource.get(source.uri.toString())?.has(range) || false;
        const errorLines = errorLinesByPath.get(key);
        const touchesErrorLine = overlapsErrorLine(errorLines, lineStart, lineEnd);
        const touchesRecoveredToken = overlapsRecoveredToken(document, from, to);
        if (touchesErrorLine) {
            coverage.recoveryErrorLineFacts++;
            if (retained) {
                coverage.recoveryUnsafeRetained++;
                addIssue(fact, "recovery fact on a compiler error line was retained");
            }
            continue;
        }
        if (touchesRecoveredToken) {
            coverage.recoveryRetractedFacts++;
            if (retained) {
                coverage.recoveryUnsafeRetained++;
                addIssue(fact, "recovery fact over retracted source tokens was retained");
            }
            continue;
        }

        coverage.recoverySafeFacts++;
        if (queriedSafeRanges.has(`${source.uri}:${range}`)) continue;
        queriedSafeRanges.add(`${source.uri}:${range}`);
        coverage.recoverySidecarOnlyCompared++;
        const sidecarOnly = model.expressionAtCompilerSidecarOnly(source.uri, start, end);
        if (!sidecarOnly) {
            if (model.isCompilerSidecarRangeAmbiguous(source.uri, start, end)) {
                coverage.recoverySidecarOnlyAmbiguous++;
            } else {
                coverage.recoverySidecarOnlyMissing++;
                addIssue(fact, "safe recovery fact has no sidecar-only query answer");
            }
        } else if (sidecarOnly.dtype !== fact.dtype || normalizeTypeName(sidecarOnly.typeName) !== normalizeTypeName(fact.typeName)) {
            coverage.recoverySidecarOnlyTypeMismatches++;
            addIssue(fact, "sidecar-only recovery query has a different compiler type", sidecarOnly.typeName);
        } else if (sidecarOnly.semanticSource !== "compiler-sidecar-recovery" || sidecarOnly.provisional !== true) {
            coverage.recoverySidecarOnlyUnprovisional++;
            addIssue(fact, "sidecar-only recovery query was not marked provisional", sidecarOnly.typeName);
        } else {
            coverage.recoverySidecarOnlyAvailable++;
        }
        const lineOffset = document.lineOffsets[lineStart];
        const nextOffset = document.lineOffsets[lineStart + 1] ?? document.text.length;
        const lineText = document.text.slice(lineOffset, nextOffset).replace(/[\r\n]+$/, "");
        const directiveLine = /^\s*#\s*(?:if|elseif|assert)\b/i.test(lineText);
        const traced = model.expressionAtTraceOnly(source.uri, start, end);
        const answer = model.expressionAt(source.uri, start, end);
        if (traced && !directiveLine) {
            coverage.recoveryNativeAnswers++;
            if (!answer || answer.semanticSource === "compiler-sidecar-recovery" || answer.dtype !== traced.dtype || normalizeTypeName(answer.typeName) !== normalizeTypeName(traced.typeName)) {
                coverage.recoveryUnsafeRetained++;
                addIssue(fact, "partial semantic recovery replaced or changed an existing native answer", answer?.typeName);
            }
            continue;
        }
        if (model.isCompilerSidecarRangeAmbiguous(source.uri, start, end)) {
            coverage.recoveryAmbiguous++;
            if (answer?.semanticSource === "compiler-sidecar-recovery") {
                coverage.recoveryUnsafeRetained++;
                addIssue(fact, "ambiguous recovery fact was exposed", answer.typeName);
            }
            continue;
        }
        if (answer?.semanticSource !== "compiler-sidecar-recovery") {
            coverage.recoveryMissing++;
            addIssue(fact, "safe recovery fact was not available to an expression query", answer?.typeName);
            continue;
        }
        if (answer.dtype !== fact.dtype || normalizeTypeName(answer.typeName) !== normalizeTypeName(fact.typeName)) {
            coverage.recoveryTypeMismatches++;
            addIssue(fact, "recovery expression query has a different compiler type", answer.typeName);
        }
        if (answer.provisional !== true) {
            coverage.recoveryUnprovisional++;
            addIssue(fact, "recovery expression query was not marked provisional", answer.typeName);
        }
        coverage.recoverySupplemented++;
    }
    return coverage;
}

function addSemanticSidecarCoverage(target, coverage) {
    const counters = [
        "files", "expressions", "compared", "directiveExpressions", "traceMissing",
        "traceTypeMismatches", "supplemented", "overridden", "ambiguous", "missing",
        "typeMismatches", "sidecarOnlyCompared", "sidecarOnlyAvailable", "sidecarOnlyAmbiguous",
        "sidecarOnlyMissing", "sidecarOnlyTypeMismatches", "sidecarOnlyStatusMismatches",
        "recoveryFiles", "recoveryFacts", "recoverySafeFacts", "recoverySidecarOnlyCompared",
        "recoverySidecarOnlyAvailable", "recoverySidecarOnlyAmbiguous", "recoverySidecarOnlyMissing",
        "recoverySidecarOnlyTypeMismatches", "recoverySidecarOnlyUnprovisional",
        "recoveryErrorLineFacts", "recoveryRetractedFacts", "recoveryNativeAnswers",
        "recoverySupplemented", "recoveryAmbiguous", "recoveryMissing",
        "recoveryTypeMismatches", "recoveryUnprovisional", "recoveryUnsafeRetained"
    ];
    for (const key of counters) target[key] += coverage[key] || 0;
    if (target.traceDifferences.length < 100) target.traceDifferences.push(...(coverage.traceDifferences || []).slice(0, 100 - target.traceDifferences.length));
    if (target.issues.length < 25) target.issues.push(...coverage.issues.slice(0, 25 - target.issues.length));
}

function addExpressionCoverage(target, coverage, complete) {
    if (complete) target.completeFiles++;
    for (const key of ["typedRanges", "syntaxRanges", "coveredRanges", "missingSyntax", "missingTypes", "invalidMissingTypes", "provisionalMissingTypes", "unmarkedRecoveryTypes", "typeMismatches"]) target[key] += coverage[key];
}

async function auditNativeCorpus(options) {
    const root = options.root;
    const timeoutMs = options.timeoutMs ?? DEFAULT_NATIVE_AUDIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_NATIVE_AUDIT_TIMEOUT_MS) {
        throw new Error(`Native corpus analysis timeout must be an integer from 1 to ${MAX_NATIVE_AUDIT_TIMEOUT_MS} milliseconds.`);
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-native-corpus-"));
    const outputPath = path.join(directory, "plain.pp.bas");
    const compilerArguments = [...(options.compilerArguments || []), "-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")];
    const report = { compilerArguments: [...compilerArguments], timeoutMs, files: 0, complete: 0, partial: 0, parity: 0, models: 0, boundedAnalysis: 0, bounded: [], incompleteAnalysis: 0, incomplete: [], declarations: 0, scopes: 0, mappedTokens: 0, mappedMacroTokens: 0, macroMaps: 0, preprocessorDeclarations: 0, preprocessorParameters: 0, preprocessorReferences: 0, mappedPreprocessorBindings: 0, macroKinds: {}, originKinds: {}, kinds: {}, families: {}, expressionCoverage: emptyExpressionCoverage(), expressionParserCoverage: null, quirkExpressionCoverage: null, exceptionalExpressionCoverage: null, typeLayoutExpressionCoverage: null, semanticSidecarCoverage: options.semanticSidecar ? emptySemanticSidecarCoverage() : null, semanticBindingCoverage: options.semanticBindings ? emptySemanticBindingCoverage() : null, categories: {}, failures: [], elapsedMs: 0 };
    const started = Date.now();
    const worker = options.workerModels ? new CompilerAnalysisWorker() : null;
    report.preparedModels = 0;
    report.preparedSemanticTokens = 0;
    function addKinds(target, nodes) {
        for (const node of nodes) target[node.kind] = (target[node.kind] || 0) + 1;
    }
    function addFamilies(target, nodes) {
        for (const node of nodes) {
            const families = node.families || (node.family ? [node.family] : []);
            for (const family of families) target[family] = (target[family] || 0) + 1;
        }
    }
    async function plain(compilerPath, filePath) {
        // Do not mistake a previous run's file for compiler output after an
        // early exit. The only removed file belongs to this audit's temp dir.
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        const result = await executeWithEaccesRetry(() => executeBoundedProcess({
            command: compilerPath,
            arguments: [...compilerArguments, "-z", "nocmdline", "-pp", "-maxerr", String(NATIVE_AUDIT_MAX_ERRORS), "-o", outputPath, filePath],
            cwd: path.dirname(filePath),
            env: { ...process.env, FB_VSCODE_TRACE: "0", FB_VSCODE_OVERLAY: "" },
            timeoutMs,
            maxOutputBytes: 2 * 1024 * 1024
        }));
        assert.ok(!result.signal && !result.cancelled && !result.timedOut && !result.outputTruncated, "The plain compiler did not finish normally");
        assert.ok(Number.isSafeInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= NATIVE_AUDIT_MAX_ERRORS, `Unexpected compiler exit: ${result.exitCode}`);
        assert.ok(fs.existsSync(outputPath), "The plain compiler produced no preprocessed source");
        assert.ok(fs.statSync(outputPath).size <= 32 * 1024 * 1024, "Plain compiler output exceeded the audit limit");
        return { exitCode: result.exitCode, text: fs.readFileSync(outputPath, "utf8") };
    }
    const nonempty = (text) => text.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
    try {
        for (const category of options.categories || CATEGORIES) {
            const sourceDirectory = path.join(root, "tests", category);
            const files = fs.readdirSync(sourceDirectory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".bas")).map((entry) => entry.name).sort();
            const group = { files: files.length, complete: 0, partial: 0, parity: 0, boundedAnalysis: 0, incompleteAnalysis: 0, kinds: {}, families: {}, expressionCoverage: emptyExpressionCoverage(), semanticSidecarCoverage: options.semanticSidecar ? emptySemanticSidecarCoverage() : null, semanticBindingCoverage: options.semanticBindings ? emptySemanticBindingCoverage() : null };
            report.categories[category] = group;
            for (const name of files) {
                const filePath = path.join(sourceDirectory, name);
                report.files++;
                try {
                    const sourceText = decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath).replace(/^\uFEFF/, "");
                    /* Direct and prepared queries must use the same compiler
                       capabilities and source snapshot. A binding-capable direct
                       pass has write roles that a default worker pass omits. */
                    const analysisOptions = {
                        compilerPath: options.editorCompiler,
                        filePath,
                        compilerArguments,
                        overlays: new Map([[filePath, sourceText]]),
                        allowErrors: true,
                        exportSemanticBindings: options.semanticBindings === true,
                        exportSemanticExpressions: options.semanticSidecar === true,
                        requireSemanticModel: options.semanticSidecar === true || options.semanticBindings === true,
                        timeoutMs
                    };
                    let analysis;
                    try {
                        analysis = await analyzeSavedModule(analysisOptions);
                    } catch (error) {
                        if (!isBoundedAnalysisFailure(error)) throw error;

                        /* Macro-generated trace metadata can be much larger
                           than ordinary preprocessed source. Keep the editor's
                           analysis bound intact, but still prove this compiler
                           build preserves normal preprocessing and exit status. */
                        const original = await plain(options.originalCompiler, filePath);
                        const companion = await plain(options.editorCompiler, filePath);
                        assert.equal(companion.exitCode, original.exitCode, "Bounded analysis changed the compiler's exit status");
                        assert.equal(companion.text, original.text, "Bounded analysis changed trace-disabled preprocessed source");
                        report.boundedAnalysis++;
                        group.boundedAnalysis++;
                        report.bounded.push({
                            file: `${category}/${name}`,
                            outputLimitBytes: MAX_ANALYSIS_BYTES,
                            ordinaryOutputBytes: Buffer.byteLength(original.text)
                        });
                        report.parity++;
                        group.parity++;
                        continue;
                    }
                    const sources = analysis.dependencies.map((file) => ({
                        uri: { fsPath: file, toString: () => `file://${file}` },
                        text: decodeCompilerSourceBuffer(fs.readFileSync(file), file).replace(/^\uFEFF/, "")
                    }));
                    const model = new CompilerSemanticModel({ toString: () => `freebasic-preprocessed:/${category}/${name}` }, analysis, sources);
                    if (options.semanticBindings) {
                        const bindingCoverage = measureSemanticBindingCoverage(analysis, sources);
                        addSemanticBindingCoverage(report.semanticBindingCoverage, bindingCoverage);
                        addSemanticBindingCoverage(group.semanticBindingCoverage, bindingCoverage);
                        if (bindingCoverage.invalidRecordCounts || bindingCoverage.missingSources || bindingCoverage.outOfBoundsRanges || bindingCoverage.invalidPhysicalRanges || bindingCoverage.invalidSignatures) {
                            throw new Error(`Compiler semantic facts are not source-projectable: ${bindingCoverage.invalidRecordCounts} invalid record totals, ${bindingCoverage.missingSources} missing sources, ${bindingCoverage.outOfBoundsRanges} out-of-bounds ranges, ${bindingCoverage.invalidPhysicalRanges} nonphysical ranges, ${bindingCoverage.invalidSignatures} missing signatures; examples ${JSON.stringify(bindingCoverage.issues.slice(0, 2))}`);
                        }
                    }
                    const expressionCoverage = measureExpressionCoverage(analysis);
                    addExpressionCoverage(report.expressionCoverage, expressionCoverage, !analysis.partial);
                    addExpressionCoverage(group.expressionCoverage, expressionCoverage, !analysis.partial);
                    if (!analysis.partial && (expressionCoverage.missingSyntax || expressionCoverage.missingTypes || expressionCoverage.typeMismatches)) {
                        throw new Error(`Complete compiler expression ranges are not covered by matching typed syntax nodes: ${expressionCoverage.missingSyntax} missing syntax, ${expressionCoverage.missingTypes} missing types, ${expressionCoverage.typeMismatches} type mismatches.`);
                    }
                    if (analysis.partial && expressionCoverage.unmarkedRecoveryTypes) {
                        throw new Error(`Partial compiler analysis left ${expressionCoverage.unmarkedRecoveryTypes} untyped syntax ranges without recovery provenance.`);
                    }
                    if (options.semanticSidecar) {
                        const sidecarCoverage = analysis.partial
                            ? measureRecoverySemanticSidecarCoverage(analysis, model, sources)
                            : measureSemanticSidecarCoverage(analysis, model, sources);
                        addSemanticSidecarCoverage(report.semanticSidecarCoverage, sidecarCoverage);
                        addSemanticSidecarCoverage(group.semanticSidecarCoverage, sidecarCoverage);
                        if (sidecarCoverage.missing || sidecarCoverage.typeMismatches || sidecarCoverage.sidecarOnlyMissing || sidecarCoverage.sidecarOnlyTypeMismatches || sidecarCoverage.sidecarOnlyStatusMismatches || sidecarCoverage.recoveryMissing || sidecarCoverage.recoveryTypeMismatches || sidecarCoverage.recoveryUnprovisional || sidecarCoverage.recoveryUnsafeRetained || sidecarCoverage.recoverySidecarOnlyMissing || sidecarCoverage.recoverySidecarOnlyTypeMismatches || sidecarCoverage.recoverySidecarOnlyUnprovisional) {
                            throw new Error(`Compiler semantic sidecar disagrees with editor model: ${sidecarCoverage.missing} unresolved and ${sidecarCoverage.typeMismatches} mistyped complete expressions; sidecar-only ${sidecarCoverage.sidecarOnlyMissing} unresolved, ${sidecarCoverage.sidecarOnlyTypeMismatches} mistyped, and ${sidecarCoverage.sidecarOnlyStatusMismatches} non-authoritative; recovery ${sidecarCoverage.recoveryMissing} unresolved, ${sidecarCoverage.recoveryTypeMismatches} mistyped, ${sidecarCoverage.recoveryUnprovisional} unmarked, ${sidecarCoverage.recoveryUnsafeRetained} unsafe, ${sidecarCoverage.recoverySidecarOnlyMissing} sidecar-only unresolved, ${sidecarCoverage.recoverySidecarOnlyTypeMismatches} sidecar-only mistyped, and ${sidecarCoverage.recoverySidecarOnlyUnprovisional} sidecar-only unmarked; examples ${JSON.stringify(sidecarCoverage.issues.slice(0, 2))}`);
                        }
                    }
                    report.models++;
                    if (worker) {
                        const value = `freebasic-preprocessed:/${category}/${name}`;
                        const prepared = await worker.analyze(analysisOptions, { requestedFile: filePath, expandedUri: { scheme: "freebasic-preprocessed", value, path: `/${category}/${name}` } });
                        assert.equal(prepared.declarationCount, model.inner.entries.length, "Worker preparation changed declaration inventory");
                        assert.equal(prepared.partial, analysis.partial, "Worker preparation changed recovery status");
                        const input = { uri: { scheme: "file", fsPath: filePath }, openFiles: [] };
                        const tokens = (await worker.query(prepared.snapshotId, "semanticTokens", input)).result;
                        assert.deepEqual(tokens, queryCompilerModel(model, "semanticTokens", input, () => {}), "Worker query changed semantic tokens");
                        report.preparedModels++;
                        report.preparedSemanticTokens += tokens.length / 5;
                    }
                    report.declarations += model.inner.entries.length;
                    report.scopes += analysis.scopeGraph.scopes.length;
                    report.mappedTokens += model.expandedToSource.size;
                    report.mappedMacroTokens += [...model.expandedToSource.values()].filter((origin) => origin.sourceMap).length;
                    report.macroMaps += analysis.macroGraph.nodes.length;
                    report.preprocessorDeclarations += analysis.preprocessorGraph.declarations.length;
                    report.preprocessorParameters += analysis.preprocessorGraph.parameters.filter((record) => record.kind === "declaration").length;
                    report.preprocessorReferences += analysis.preprocessorGraph.references.length;
                    report.mappedPreprocessorBindings += model.preprocessor.bindings.filter((binding) => binding.physical).length;
                    addKinds(report.macroKinds, analysis.macroGraph.nodes);
                    addKinds(report.originKinds, analysis.tokenOrigins);
                    const state = analysis.partial ? "partial" : "complete";
                    report[state]++;
                    group[state]++;
                    addKinds(report.kinds, analysis.expressionGraph.nodes);
                    addKinds(group.kinds, analysis.expressionGraph.nodes);
                    addFamilies(report.families, analysis.expressionGraph.nodes);
                    addFamilies(group.families, analysis.expressionGraph.nodes);
                    const original = await plain(options.originalCompiler, filePath);
                    const companion = await plain(options.editorCompiler, filePath);
                    assert.equal(companion.exitCode, original.exitCode, "Instrumentation changed the compiler's exit status");
                    assert.equal(companion.text, original.text, "Trace-disabled preprocessing differs from the original compiler");
                    assert.equal(analysis.completion.errorCount ? 1 : 0, original.exitCode, "Tracing changed the compiler's error outcome");
                    /* Trace recovery may deliberately retain source past a
                       compiler error where stock preprocessing stopped. The
                       separate trace-disabled pass above still proves normal
                       compiler parity for those intentionally broken files. */
                    if (!analysis.partial) {
                        assert.deepEqual(nonempty(analysis.text), nonempty(original.text), "Tracing changed preprocessed source");
                    }
                    group.parity++;
                    report.parity++;
                } catch (error) {
                    if (!isIncompleteAnalysisFailure(error)) {
                        // Assertion errors can embed megabytes of differing source.
                        // Keep the summary bounded while preserving the failing file.
                        report.failures.push({ file: `${category}/${name}`, error: error.message.slice(0, 1000) });
                        continue;
                    }
                    /* A compiler that stops before its terminal editor record
                       has not produced a semantic model. Count it separately,
                       and keep only the independently verified stock/bridge
                       preprocessing parity result. */
                    try {
                        const original = await plain(options.originalCompiler, filePath);
                        const companion = await plain(options.editorCompiler, filePath);
                        assert.equal(companion.exitCode, original.exitCode, "Incomplete analysis changed the compiler's exit status");
                        assert.equal(companion.text, original.text, "Incomplete analysis changed trace-disabled preprocessed source");
                        report.incompleteAnalysis++;
                        group.incompleteAnalysis++;
                        report.incomplete.push({ file: `${category}/${name}`, exitCode: original.exitCode });
                        report.parity++;
                        group.parity++;
                    } catch (parityError) {
                        report.failures.push({ file: `${category}/${name}`, error: parityError.message.slice(0, 1000) });
                    }
                }
            }
            options.progress?.(category, group);
        }
    } finally {
        await worker?.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    }
    if (options.semanticBindings) {
        const supportedKinds = auditImplicitCallRoutes(path.join(root, "src", "compiler")).supportedKinds;
        const applyCallKindCoverage = (coverage) => {
            const callKinds = measureSemanticCallKindCoverage(coverage.callsByKind, supportedKinds);
            coverage.supportedCallKinds = callKinds.supported;
            coverage.exercisedCallKinds = callKinds.exercised;
            coverage.missingCallKinds = callKinds.missing;
            coverage.unexpectedCallKinds = callKinds.unexpected;
            return callKinds;
        };
        const callKinds = applyCallKindCoverage(report.semanticBindingCoverage);
        for (const group of Object.values(report.categories)) applyCallKindCoverage(group.semanticBindingCoverage);
        report.failures.push(...semanticCallKindCoverageFailures(callKinds, options));
    }
    report.expressionParserCoverage = measureExpressionParserRouteCoverage(report.families);
    report.quirkExpressionCoverage = measureNamedExpressionFamilyCoverage(
        report.families, QUIRK_EXPRESSION_HOOKS, QUIRK_EXPRESSION_FOCUSED_FAMILIES
    );
    report.exceptionalExpressionCoverage = measureNamedExpressionFamilyCoverage(
        report.families, EXCEPTIONAL_EXPRESSION_FAMILY_HOOKS
    );
    const typeLayoutHooks = Object.entries(TYPE_LAYOUT_EXPRESSION_HOOKS)
        .flatMap(([file, names]) => names.map((name) => [file, name]));
    report.typeLayoutExpressionCoverage = measureNamedExpressionFamilyCoverage(report.families, typeLayoutHooks);
    report.failures.push(...fullDefaultExpressionRouteCoverageFailures([
        { name: "generic expression parser routes", coverage: report.expressionParserCoverage },
        { name: "quirk parser families", coverage: report.quirkExpressionCoverage },
        { name: "exceptional expression routes", coverage: report.exceptionalExpressionCoverage },
        { name: "type-layout expression routes", coverage: report.typeLayoutExpressionCoverage }
    ], options));
    report.elapsedMs = Date.now() - started;
    return report;
}

async function main() {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const editorCompiler = process.env.FBC_EDITOR_EXECUTABLE;
    if (!editorCompiler) throw new Error("Set FBC_EDITOR_EXECUTABLE to the current native bridge before running this audit.");
    const options = parseNativeCorpusArguments(process.argv.slice(2));
    const report = await auditNativeCorpus({ root, editorCompiler, ...options, workerModels: true, originalCompiler: process.env.FBC_EXECUTABLE || path.join(root, "bin/fbc"), progress: (category, group) => console.error(`${category}: ${group.parity}/${group.files} parity checks passed${options.semanticSidecar ? `; semantic sidecar ${group.semanticSidecarCoverage.compared} expressions compared` : options.semanticBindings ? `; ${group.semanticBindingCoverage.implicitCalls} implicit calls across ${Object.keys(group.semanticBindingCoverage.callsByKind).length} kinds` : ""}`) });
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { CATEGORIES, LANGUAGE_MODE_ARGUMENTS, ARCHITECTURE_ARGUMENTS, BACKEND_ARGUMENTS, DEFAULT_NATIVE_AUDIT_TIMEOUT_MS, MAX_NATIVE_AUDIT_TIMEOUT_MS, parseNativeCorpusArguments, executeWithEaccesRetry, isBoundedAnalysisFailure, isIncompleteAnalysisFailure, measureExpressionCoverage, measureSemanticSidecarCoverage, measureSemanticBindingCoverage, measureSemanticCallKindCoverage, semanticCallKindCoverageFailures, measureRecoverySemanticSidecarCoverage, measureExpressionParserRouteCoverage, measureNamedExpressionFamilyCoverage, fullDefaultExpressionRouteCoverageFailures, auditNativeCorpus };

/* end of audit-native-corpus.js */
