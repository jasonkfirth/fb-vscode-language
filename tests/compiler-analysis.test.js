/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-analysis.test.js
    Purpose: Validate compiler origins and conservative editor projections.
    Responsibilities: check protocol bounds, unsafe arguments, active symbols.
    Does not contain: compiler building or a simulated preprocessor.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("node:child_process");
const { executeBoundedProcess } = require("../lib/compiler-diagnostics");
const { MAX_ANALYSIS_BYTES, analysisArguments, analyzeSavedModule, compilerSemanticTemporaryConstructions, decodeCompilerSourceBuffer, decodePreprocessed } = require("../lib/compiler-analysis");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");
const { CompilerUri } = require("../lib/compiler-model-store");
const { ARCHITECTURE_ARGUMENTS, isBoundedAnalysisFailure, isIncompleteAnalysisFailure, measureExpressionCoverage, measureSemanticSidecarCoverage, measureSemanticBindingCoverage, measureSemanticCallKindCoverage, semanticCallKindCoverageFailures, parseNativeCorpusArguments } = require("../tools/audit-native-corpus");
const { getReferenceSignatures } = require("../lib/language-reference");
const { EXPRESSION_PARSER_HOOKS, instrumentLexer, instrumentProcedures, instrumentSourceIO, instrumentExpressions, instrumentRecovery, instrumentSemanticCoordinates, instrumentSemanticSourceFilter } = require("../tools/build-compiler-bridge");
const { listCompilerSourceFiles, resolveCompilerSourcePath, resolveFreeBasicRoot } = require("../tools/audit-freebasic-coverage");
const { auditExpressionRoutes } = require("../tools/audit-compiler-expression-routes");
const { auditCallRoutes } = require("../tools/audit-compiler-call-routes");
const { SYMBOL_FILES, instrumentSymbols } = require("../tools/compiler-symbol-hooks");
const { EXPRESSION_FILES, QUIRK_EXPRESSION_FAMILIES, QUIRK_EXPRESSION_FOCUSED_FAMILIES, EXCEPTIONAL_EXPRESSION_FAMILY_HOOKS, TYPE_LAYOUT_EXPRESSION_HOOKS, instrumentExpressionGraph } = require("../tools/compiler-expression-hooks");
const { replaceOnce } = require("../tools/build-compiler-bridge");
const { expressionGraphSignature } = require("../lib/compiler-expressions");
const { queryCompilerModel } = require("../lib/compiler-model-queries");
const { TOKEN_TYPES } = require("../lib/semantic-token-data");
const { SCOPE_FILES, instrumentScopes } = require("../tools/compiler-scope-hooks");
const { MACRO_FILES, instrumentMacros } = require("../tools/compiler-macro-hooks");
const { PREPROCESSOR_FILES, instrumentPreprocessor } = require("../tools/compiler-preprocessor-hooks");
const { createSymbolDecoder } = require("../lib/compiler-symbols");
const { projectNativeTokens } = require("../lib/compiler-origins");

function uri(filePath) { return { fsPath: filePath, toString: () => `file://${filePath}` }; }
function marker(file, line, generated = false) { return `''@fb-editor-v1 ${line + 1} ${generated ? 1 : 0} ${Buffer.from(file).toString("hex")}`; }
function marker2(file, serial, line, generated = false) { return marker(file, line, generated).replace("v1", `v2 ${serial}`); }
function binding(kind, serial, column, id, name) { return `''@fb-editor-bind ${kind} ${serial} ${column} ${id} ${Buffer.from(name).toString("hex")}`; }

test("temporary construction inputs require closed observations and mapped source receipts", () => {
    const fixture = () => ({ schemaVersion: 27, recovery: false,
        capabilities: [{ module: 1, feature: "temporary-construction-inputs", coverage: "available" }],
        sourceContexts: [{ id: 4, file: 2, module: 1 }], sourceFiles: [{ id: 2, kind: "regular", filePath: "/workspace/main.bas" }],
        properties: [{ module: 1, domain: "symbol", identity: 7, name: "temporary-construction:1", value: "11\t3\t4\t0" },
            { module: 1, domain: "symbol", identity: 1, name: "temporary-construction-count:1", value: "1" }],
        physicalLocations: [{ domain: "source-context", subject: 4, role: "temporary-construction:1", source: 4,
            startLine: 8, startColumn: 9, endLine: 8, endColumn: 14, status: "mapped" }]
    });
    assert.deepEqual(compilerSemanticTemporaryConstructions(fixture(), "/workspace"), [{ kind: "explicit-constructor",
        owner: 7, type: 7, target: 11, physical: true, filePath: "/workspace/main.bas",
        startLine: 8, startColumn: 9, endLine: 8, endColumn: 14 }]);
    for (const mutate of [
        (sidecar) => { sidecar.recovery = true; },
        (sidecar) => { sidecar.properties.pop(); },
        (sidecar) => { sidecar.properties[1].value = "2"; },
        (sidecar) => { sidecar.properties[1].value = "5001"; },
        (sidecar) => { sidecar.properties.push(sidecar.properties[0]); },
        (sidecar) => { sidecar.properties[0].provisional = true; },
        (sidecar) => { sidecar.properties[0].value = "11\t3\t4\t1"; },
        (sidecar) => { sidecar.properties[0].value = "11\t3\t99\t0"; },
        (sidecar) => { sidecar.physicalLocations = []; },
        (sidecar) => { sidecar.physicalLocations[0].status = "unmapped"; },
        (sidecar) => { sidecar.physicalLocations.push(sidecar.physicalLocations[0]); }
    ]) {
        const sidecar = fixture();
        mutate(sidecar);
        assert.deepEqual(compilerSemanticTemporaryConstructions(sidecar, "/workspace"), []);
    }
});

test("expression type coverage audit checks deduplicated ranges and native identities", () => {
    const position = (character) => ({ line: 0, character });
    const typed = (character, dtype, subtype, typeName) => ({ start: position(character), end: position(character + 1), dtype, subtype, typeName });
    const syntax = (character, dtype, subtype, typeName) => ({ kind: "syntax", start: position(character), end: position(character + 1), dtype, subtype, typeName });
    const coverage = measureExpressionCoverage({
        expressions: [typed(0, 20, 8, "Widget"), typed(0, 52, 8, "Widget Ptr"), typed(1, 8, 0, "Integer"), typed(2, 16, 0, "Double")],
        expressionGraph: { nodes: [syntax(0, 20, 8, "Widget"), syntax(0, 52, 8, "Widget Ptr"), syntax(2, 17, 0, "Double"), syntax(3, 32, 0, "String")] }
    });
    assert.deepEqual(coverage, { typedRanges: 3, syntaxRanges: 3, coveredRanges: 2, missingSyntax: 1, missingTypes: 1, invalidMissingTypes: 0, provisionalMissingTypes: 0, unmarkedRecoveryTypes: 1, typeMismatches: 1 });
});

test("compiler FOR-entry inlay query maps only complete physical skipped-loop facts", () => {
    const filePath = "/workspace/for-entry.bas";
    const text = "' Ω\r\nFor loopIndex = 3 To 1\r\nNext\r\n";
    const lineOffsets = [0];
    for (const match of text.matchAll(/\r\n|\r|\n/g)) lineOffsets.push(match.index + match[0].length);
    const document = { text, lineOffsets };
    const skipped = {
        filePath,
        result: "skip",
        startLine: 2,
        startColumn: 0,
        endLine: 2,
        endColumn: 3,
        provisional: false
    };
    const model = Object.create(CompilerSemanticModel.prototype);
    Object.assign(model, {
        partial: false,
        semanticForEntryResults: [
            skipped,
            { ...skipped },
            { ...skipped, provisional: true },
            { ...skipped, filePath: "/workspace/other.bas" }
        ],
        getDocument: () => document,
        compilerTypeInlayHints: () => [],
        compilerParameterInlayHints: () => []
    });

    const loopLine = text.split(/\r\n|\r|\n/)[1];
    const request = {
        uri: { scheme: "file", fsPath: filePath },
        position: { line: 1, character: 0 },
        end: { line: 1, character: loopLine.length }
    };
    const result = queryCompilerModel(model, "compilerInlayHints", request, () => {});

    assert.deepEqual(result.forEntries, [{
        position: { line: 1, character: 3 },
        label: "body skipped",
        tooltip: "The compiler's initial FOR test fails; the loop body is not entered."
    }]);

    model.semanticForEntryResults.push({ ...skipped, result: "enter" });
    assert.deepEqual(queryCompilerModel(model, "compilerInlayHints", request, () => {}).forEntries, [],
        "conflicting compiler observations at one physical loop header must not produce an inlay");
});

test("partial expression coverage flags untyped ranges without recovery provenance", () => {
    const syntaxNode = (line, invalid, provisional) => ({
        kind: "syntax",
        start: { line, character: 0 },
        end: { line, character: 1 },
        dtype: 8,
        subtype: 0,
        typeName: "integer",
        invalid,
        provisional
    });
    const coverage = measureExpressionCoverage({
        expressions: [],
        expressionGraph: { nodes: [
            syntaxNode(0, true, true),
            syntaxNode(1, false, true),
            syntaxNode(2, false, false)
        ] }
    });

    assert.equal(coverage.missingTypes, 3);
    assert.equal(coverage.invalidMissingTypes, 1);
    assert.equal(coverage.provisionalMissingTypes, 1);
    assert.equal(coverage.unmarkedRecoveryTypes, 1);
});

test("native semantic-binding coverage checks binding and implicit-call ranges", () => {
    const filePath = path.resolve("semantic-binding-audit.bas");
    const source = { uri: uri(filePath), text: "Dim value As Integer\n" };
    const coverage = measureSemanticBindingCoverage({
        semanticModelCounts: { bindingCount: 6, implicitCallCount: 5 },
        semanticBindings: [
            { symbol: 1, physical: true, filePath, startLine: 1, startColumn: 4, endLine: 1, endColumn: 9 },
            { symbol: 2, physical: true, filePath: `${filePath}.missing`, startLine: 1, startColumn: 0, endLine: 1, endColumn: 5 },
            { symbol: 3, physical: true, filePath, startLine: 1, startColumn: 4, endLine: 1, endColumn: 99 }
        ],
        semanticImplicitCalls: [
            { kind: "default-constructor", physical: true, targetSignature: "sig1", filePath, startLine: 1, startColumn: 4, endLine: 1, endColumn: 9 },
            { kind: "argument-constructor", physical: true, targetSignature: "", filePath, startLine: 1, startColumn: 4, endLine: 1, endColumn: 99 },
            { kind: "temporary-destructor", physical: false, targetSignature: "sig2", filePath: `${filePath}.missing`, startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }
        ]
    }, [source]);

    assert.equal(coverage.files, 1);
    assert.equal(coverage.bindingRecords, 6);
    assert.equal(coverage.bindings, 3);
    assert.equal(coverage.nonPhysicalBindings, 3);
    assert.equal(coverage.implicitCallRecords, 5);
    assert.equal(coverage.implicitCalls, 3);
    assert.equal(coverage.nonPhysicalImplicitCalls, 3);
    assert.equal(coverage.invalidRecordCounts, 0);
    assert.deepEqual(coverage.callsByKind, {
        "default-constructor": 1,
        "argument-constructor": 1,
        "temporary-destructor": 1
    });
    assert.equal(coverage.missingSources, 1);
    assert.equal(coverage.outOfBoundsRanges, 2);
    assert.equal(coverage.invalidPhysicalRanges, 0);
    assert.equal(coverage.invalidSignatures, 1);
});

test("native semantic-binding coverage rejects totals smaller than projectable facts", () => {
    const filePath = path.resolve("semantic-binding-count-audit.bas");
    const source = { uri: uri(filePath), text: "value\n" };
    const coverage = measureSemanticBindingCoverage({
        semanticModelCounts: { bindingCount: 0, implicitCallCount: 0 },
        semanticBindings: [{ physical: true, filePath, startLine: 1, startColumn: 0, endLine: 1, endColumn: 5 }],
        semanticImplicitCalls: [{ kind: "default-constructor", physical: true, targetSignature: "sig2", filePath, startLine: 1, startColumn: 0, endLine: 1, endColumn: 5 }]
    }, [source]);

    assert.equal(coverage.bindingRecords, 1);
    assert.equal(coverage.implicitCallRecords, 1);
    assert.equal(coverage.nonPhysicalBindings, 0);
    assert.equal(coverage.nonPhysicalImplicitCalls, 0);
    assert.equal(coverage.invalidRecordCounts, 2);
});

test("native binding audit distinguishes supported, missing, and unexpected implicit-call kinds", () => {
    const coverage = measureSemanticCallKindCoverage({
        "default-constructor": 3,
        "temporary-destructor": 0,
        "new-call-kind": 1
    }, ["temporary-destructor", "default-constructor", "argument-constructor", "default-constructor"]);

    assert.deepEqual(coverage, {
        supported: ["argument-constructor", "default-constructor", "temporary-destructor"],
        exercised: ["default-constructor"],
        missing: ["argument-constructor", "temporary-destructor"],
        unexpected: ["new-call-kind"]
    });
});

test("full default-FB binding audits require every supported implicit-call kind", () => {
    const coverage = measureSemanticCallKindCoverage({ "default-constructor": 1 }, ["default-constructor", "argument-constructor"]);

    assert.deepEqual(semanticCallKindCoverageFailures(coverage, { languageMode: "fb" }), [{
        file: "<implicit-call-kind-coverage>",
        error: "Full default-FB corpus did not exercise supported implicit-call kinds: argument-constructor"
    }]);
    assert.deepEqual(semanticCallKindCoverageFailures(coverage, { languageMode: "fb", categories: ["expressions"] }), []);
    assert.deepEqual(semanticCallKindCoverageFailures({ ...coverage, unexpected: ["future-kind"] }, { languageMode: "qb", categories: ["qb"] }), [{
        file: "<implicit-call-kind-coverage>",
        error: "Native corpus emitted unsupported implicit-call kinds: future-kind"
    }]);
});

test("native corpus audit distinguishes the documented trace-output bound", () => {
    assert.equal(isBoundedAnalysisFailure(new Error("Compiler analysis exceeded its 32 MiB output limit.")), true);
    assert.equal(isBoundedAnalysisFailure(new Error("Compiler analysis timed out.")), false);
    assert.equal(isBoundedAnalysisFailure("Compiler analysis exceeded its 32 MiB output limit."), false);
});

test("native corpus audit distinguishes a compiler that stopped before its terminal record", () => {
    assert.equal(isIncompleteAnalysisFailure(new Error("The compiler did not finish writing its analysis snapshot.")), true);
    assert.equal(isIncompleteAnalysisFailure(new Error("Compiler token origin has no physical source dependency.")), false);
});

test("native corpus audit identifies sidecar-supplemented and overridden trace types", () => {
    const filePath = path.resolve("semantic-audit.bas");
    const source = { uri: uri(filePath), text: "first second" };
    const facts = [
        { physical: true, filePath, startLine: 1, startColumn: 0, endLine: 1, endColumn: 5, dtype: 8, typeName: "Integer" },
        { physical: true, filePath, startLine: 1, startColumn: 6, endLine: 1, endColumn: 12, dtype: 16, typeName: "Double" }
    ];
    const model = {
        expressionAtTraceOnly(_uri, start) {
            return start.character === 0 ? null : { dtype: 8, typeName: "Integer" };
        },
        expressionAtCompilerSidecarOnly(_uri, start) {
            return start.character === 0
                ? { dtype: 8, typeName: "Integer", semanticSource: "compiler-sidecar", provisional: false }
                : { dtype: 16, typeName: "Double", semanticSource: "compiler-sidecar", provisional: false };
        },
        expressionAt() { return { dtype: 8, typeName: "Integer", semanticSource: "compiler-sidecar" }; },
        isCompilerSidecarRangeAmbiguous() { return false; }
    };

    const coverage = measureSemanticSidecarCoverage({ semanticExpressions: facts }, model, [source]);

    assert.equal(coverage.traceMissing, 1);
    assert.equal(coverage.supplemented, 1);
    assert.equal(coverage.traceTypeMismatches, 1);
    assert.equal(coverage.overridden, 1);
    assert.equal(coverage.sidecarOnlyCompared, 2);
    assert.equal(coverage.sidecarOnlyAvailable, 2);
    assert.equal(coverage.sidecarOnlyMissing, 0);
    assert.equal(coverage.sidecarOnlyTypeMismatches, 0);
    assert.equal(coverage.sidecarOnlyStatusMismatches, 0);
    assert.deepEqual(coverage.traceDifferences.map(({ line, column, expected, actual, reason }) =>
        [line, column, expected, actual, reason]), [
        [1, 0, "Integer", undefined, "trace expression is missing"],
        [1, 6, "Double", "Integer", "trace type differs from compiler semantic model"]
    ]);
});

test("native corpus audit classifies conflicting sidecar facts as explicit ambiguity", () => {
    const filePath = path.resolve("semantic-ambiguous-audit.bas");
    const source = { uri: uri(filePath), text: "value\n" };
    const facts = [
        { physical: true, filePath, startLine: 1, startColumn: 0, endLine: 1, endColumn: 5, dtype: 5, typeName: "Short" },
        { physical: true, filePath, startLine: 1, startColumn: 0, endLine: 1, endColumn: 5, dtype: 8, typeName: "Integer" }
    ];
    const traced = { dtype: 5, typeName: "Short" };
    const model = {
        expressionAtTraceOnly() { return traced; },
        expressionAtCompilerSidecarOnly() { return null; },
        expressionAt() { return traced; },
        isCompilerSidecarRangeAmbiguous() { return true; }
    };

    const coverage = measureSemanticSidecarCoverage({ semanticExpressions: facts }, model, [source]);

    assert.equal(coverage.traceTypeMismatches, 1);
    assert.equal(coverage.ambiguous, 1, "One conflicting source range is one ambiguity even when it has multiple facts.");
    assert.equal(coverage.sidecarOnlyAmbiguous, 2);
    assert.equal(coverage.missing, 0);
    assert.equal(coverage.typeMismatches, 0, "A contradictory sidecar does not invalidate the retained compiler trace answer.");

    const unsafeModel = {
        ...model,
        expressionAt() { return { ...traced, semanticSource: "compiler-sidecar" }; }
    };
    const unsafeCoverage = measureSemanticSidecarCoverage({ semanticExpressions: facts }, unsafeModel, [source]);
    assert.equal(unsafeCoverage.typeMismatches, 2, "An ambiguous sidecar answer must never be selected for editor queries.");
});

test("native corpus audit applies one explicit language mode to both compiler passes", () => {
    assert.deepEqual(parseNativeCorpusArguments([
        "--semantic-sidecar", "--category=expressions", "--language-mode=QB"
    ]), {
        semanticSidecar: true,
        semanticBindings: false,
        categories: ["expressions"],
        languageMode: "qb",
        timeoutMs: 10000,
        compilerArguments: ["-lang", "qb"]
    });
    assert.deepEqual(parseNativeCorpusArguments([]), {
        semanticSidecar: false,
        semanticBindings: false,
        categories: undefined,
        languageMode: "fb",
        timeoutMs: 10000,
        compilerArguments: []
    });
    assert.throws(() => parseNativeCorpusArguments(["--language-mode=unknown"]), /Unknown native corpus language mode/);
    assert.throws(() => parseNativeCorpusArguments(["--language-mode=fb", "--language-mode=qb"]), /at most one/);
    assert.throws(() => parseNativeCorpusArguments(["--category=missing"]), /Unknown native corpus categories/);
    assert.deepEqual(parseNativeCorpusArguments(["--semantic-bindings", "--category=structs"]), {
        semanticSidecar: false,
        semanticBindings: true,
        categories: ["structs"],
        languageMode: "fb",
        timeoutMs: 10000,
        compilerArguments: []
    });
    assert.throws(() => parseNativeCorpusArguments(["--semantic-sidecar", "--semantic-bindings"]), /not both/);
});

test("native corpus audit applies target architecture identically to both compilers", () => {
    assert.deepEqual(parseNativeCorpusArguments([
        "--semantic-sidecar", "--category=expressions", "--language-mode=fb", "--architecture=x86-32"
    ]), {
        semanticSidecar: true,
        semanticBindings: false,
        categories: ["expressions"],
        languageMode: "fb",
        timeoutMs: 10000,
        compilerArguments: ["-lang", "fb", "-arch", "386"]
    });
    assert.deepEqual(parseNativeCorpusArguments(["--architecture=X86-64"]), {
        semanticSidecar: false,
        semanticBindings: false,
        categories: undefined,
        languageMode: "fb",
        timeoutMs: 10000,
        compilerArguments: ["-arch", "x86_64"]
    });
    const architectureTargets = [
        ["armv4", "armv4"], ["armv5", "armv5te"], ["armv6", "armv6"],
        ["armv6-fp", "armv6+fp"], ["armv7", "armv7-a"], ["armv7-fp", "armv7-a+fp"],
        ["aarch64", "aarch64"], ["powerpc", "powerpc"], ["powerpc64", "powerpc64"],
        ["powerpc64le", "powerpc64le"], ["riscv32", "riscv32"], ["riscv64", "riscv64"],
        ["s390x", "s390x"], ["loongarch64", "loongarch64"], ["mips32", "mips32"],
        ["mips32el", "mips32el"], ["mips64", "mips64"], ["mips64el", "mips64el"]
    ];
    for (const [name, compilerName] of architectureTargets) {
        assert.deepEqual(
            parseNativeCorpusArguments([`--architecture=${name.toUpperCase()}`]).compilerArguments,
            ["-arch", compilerName],
            `${name} must map to FreeBASIC's canonical architecture name`
        );
    }
    assert.throws(() => parseNativeCorpusArguments(["--architecture=wasm32"]), /Unknown native corpus target architecture/);
    assert.throws(() => parseNativeCorpusArguments(["--architecture=x86-32", "--architecture=x86-64"]), /at most one/);
});

test("unprojectable compiler symbol uses are withheld and disable rename for that identity", () => {
    const decoder = createSymbolDecoder(
        (hex) => Buffer.from(hex, "hex").toString("utf8"),
        (value, minimum = 0) => {
            const number = Number(value);
            if (!Number.isSafeInteger(number) || number < minimum) throw new Error("Invalid fixture integer.");
            return number;
        }
    );
    assert.equal(decoder.read("''@fb-editor-symbol 1 1 8 0 0 0 0 0 0 0 52454d 496e7465676572"), true);
    assert.equal(decoder.read("''@fb-editor-use declaration 1 5 1 52454d"), true);
    assert.equal(decoder.read("''@fb-editor-use reference 2 1 1 52454d"), true);
    const graph = decoder.finish(new Map([[1, 0], [2, 1]]), [" dim", " = 564356"], new Set(), 14);
    assert.deepEqual(graph.uses, []);
    assert.deepEqual(graph.nonRenameable, [1]);
});

test("native corpus architecture map stays accepted by the built FreeBASIC compiler", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, () => {
    for (const [name, arguments_] of Object.entries(ARCHITECTURE_ARGUMENTS)) {
        const target = execFileSync(process.env.FBC_EDITOR_EXECUTABLE, [...arguments_, "-print", "target"], {
            encoding: "utf8",
            timeout: 5000
        }).trim();
        assert.notEqual(target, "", `${name} must resolve to a compiler target`);
    }
});

test("LLVM lowers constant pointer dereferences without requiring a backing register", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, (t) => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-llvm-constant-pointer-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    for (const name of ["deref-cast-const-1.bas", "deref-field-cast-const.bas"]) {
        const sourcePath = path.join(root, "tests/pointers", name);
        const outputPath = path.join(directory, `${name}.ll`);
        execFileSync(process.env.FBC_EDITOR_EXECUTABLE, [
            "-gen", "llvm", "-r", "-z", "nocmdline", "-o", outputPath, sourcePath
        ], { cwd: root, encoding: "utf8", timeout: 10000 });

        const ir = fs.readFileSync(outputPath, "utf8");
        assert.match(ir, /inttoptr i\d+ 0 to i\d+\*/i, `${name} should lower its constant address`);
        assert.match(ir, /load i\d+, i\d+\* %vr\d+/i, `${name} should load through the converted pointer`);
    }
});

test("cancelling an oversized-trace retry aborts its trace-free compiler pass", { timeout: 10000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-cancel-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "cancel.bas");
    const source = "Print 1 + 2\n";
    fs.writeFileSync(filePath, source);

    const controller = new AbortController();
    let calls = 0;
    let startFallback;
    const fallbackStarted = new Promise((resolve) => { startFallback = resolve; });
    const execute = ({ arguments: compilerArguments, signal }) => {
        calls++;
        if (calls === 1) {
            const outputPath = compilerArguments[compilerArguments.indexOf("-o") + 1];
            fs.writeFileSync(outputPath, "");
            fs.truncateSync(outputPath, MAX_ANALYSIS_BYTES + 1);
        } else {
            startFallback();
        }

        return new Promise((resolve) => {
            const finish = () => resolve({
                exitCode: 1,
                stdout: "",
                stderr: "",
                cancelled: true,
                timedOut: false,
                outputTruncated: false,
                signal: null
            });
            if (signal.aborted) finish();
            else signal.addEventListener("abort", finish, { once: true });
        });
    };

    const pending = analyzeSavedModule({
        compilerPath: "unused-test-compiler",
        filePath,
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        signal: controller.signal
    }, undefined, execute);

    try {
        await fallbackStarted;
        controller.abort();
        await assert.rejects(pending, /Compiler analysis was cancelled/);
        assert.equal(calls, 2, "the size-limited trace should reach exactly one fallback pass");
    } finally {
        controller.abort();
    }
});

test("older schema compilers without FBCDIA retry analysis without the optional flag", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-diagnostic-compatibility-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "compatibility.bas");
    const source = "Print 1\n";
    fs.writeFileSync(filePath, source);
    const calls = [];
    const execute = async ({ arguments: compilerArguments }) => {
        calls.push(compilerArguments);
        if (compilerArguments.includes("-semantic-diagnostics")) {
            return { exitCode: 1, stdout: "", stderr: "fbc: unrecognized option 'semantic-diagnostics'", cancelled: false, timedOut: false, outputTruncated: false, signal: "" };
        }
        fs.writeFileSync(compilerArguments[compilerArguments.indexOf("-o") + 1], source);
        return { exitCode: 0, stdout: "", stderr: "", cancelled: false, timedOut: false, outputTruncated: false, signal: "" };
    };
    const decode = (text) => ({
        text,
        origins: [],
        dependencies: [filePath],
        protocolVersion: 14,
        completion: { errorCount: 0, reachedEnd: true },
        tokenOrigins: [],
        macroGraph: { nodes: [] }
    });

    const analysis = await analyzeSavedModule({
        compilerPath: "compatibility-test-compiler",
        filePath,
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true,
        allowErrors: true
    }, decode, execute);

    assert.equal(analysis.text, source);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("-semantic-diagnostics"));
    assert.equal(calls[1].includes("-semantic-diagnostics"), false);
});

test("compiler expression route inventory assigns every native AST parser", () => {
    const report = auditExpressionRoutes({ root: resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || ""), parserHooks: EXPRESSION_PARSER_HOOKS });
    assert.ok(report.files.length >= 50, "The complete upstream parser source set unexpectedly shrank.");
    assert.ok(report.routes.length >= 70, "The upstream AST parser route inventory unexpectedly shrank.");
    assert.deepEqual(report.routes.filter((route) => route.definitions > 1).map(({ key, definitions }) => ({ key, definitions })), [
        { key: "parser-expr-variable.bas:cVariableEx", definitions: 2 }
    ], "AST parser overload changes need an explicit bridge-coverage review.");
    assert.deepEqual(report.unowned, []);
    assert.deepEqual(report.duplicateOwnership, []);
    assert.deepEqual(report.staleGeneric, []);
    assert.deepEqual(report.staleOwners, []);
    assert.deepEqual(report.definitionDrift, []);
    const owners = new Map(report.routes.map((route) => [route.key, route.owner]));
    for (const route of [
        "parser-decl-symb-init.bas:cInitializer",
        "parser-proccall-args.bas:cProcArgList",
        "parser-proccall.bas:cProcCall"
    ]) assert.ok(owners.has(route), `${route} must remain inside the compiler parser inventory.`);
});

test("compiler selected-call inventory assigns every active implicit call builder", () => {
    const report = auditCallRoutes({ root: resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "") });
    assert.ok(report.routes.length >= 25, "The upstream compiler selected-call inventory unexpectedly shrank.");
    assert.deepEqual(report.unowned, []);
    assert.deepEqual(report.staleOwners, []);
    assert.deepEqual(report.staleFiles, []);
    assert.deepEqual(report.drift, []);
    assert.deepEqual(report.unclassified, []);
    assert.deepEqual(report.staleClassifications, []);
    assert.deepEqual(report.implicitCallRoutes.unowned, []);
    assert.deepEqual(report.implicitCallRoutes.staleOwners, []);
    assert.deepEqual(report.implicitCallRoutes.staleRoutes, []);
    assert.deepEqual(report.implicitCallRoutes.drift, []);
    assert.deepEqual(report.implicitCallRoutes.kindDrift, []);
    assert.deepEqual(report.implicitCallRoutes.unsupportedKinds, []);
    assert.deepEqual(report.implicitCallRoutes.unemittedKinds, []);
    assert.deepEqual(report.implicitCallRoutes.missingBridgeKinds, []);
    assert.deepEqual(report.implicitCallRoutes.supportedKinds, report.implicitCallRoutes.emittedKinds);
    assert.deepEqual(report.implicitCallRoutes.supportedKinds, [
        "argument-constructor", "default-constructor", "delete-destructor", "destructor-call",
        "initializer-constructor", "new-constructor", "redim-constructor", "return-constructor",
        "scope-exit-destructor", "temporary-destructor"
    ]);
    const routeByKey = new Map(report.routes.map((route) => [route.routeKey, route]));
    assert.equal(routeByKey.get("parser-expr-variable.bas:cMemberDeref:astBuildCall").sourceOccurrence, "mixed-source");
    assert.equal(routeByKey.get("ast-node-assign.bas:hTryAssignOvl:astBuildCall").sourceOccurrence, "operator-syntax");
    assert.equal(routeByKey.get("ast-node-assign.bas:hTryAssignOvl:astBuildCtorCall").sourceOccurrence, "implicit-source");
    assert.equal(routeByKey.get("ast-node-proc.bas:hCallCtorList:astBuildDtorCall").sourceOccurrence, "compiler-generated");
    const implicitRouteByKey = new Map(report.implicitCallRoutes.routes.map((route) => [route.routeKey, route]));
    assert.equal(implicitRouteByKey.get("parser-decl-var.bas:hBuildAutoVarInitializer:fbSemanticModelExportImplicitCall").emittedKinds["initializer-constructor"], 1);
    assert.equal(implicitRouteByKey.get("parser-quirk-mem.bas:cOperatorNew:fbSemanticModelExportImplicitCall").emittedKinds["new-constructor"], 3);
    assert.equal(implicitRouteByKey.get("semantic-model.bas:fbSemanticModelExportScopeExitDestructor:hSemanticModelEmitImplicitCall").emittedKinds["scope-exit-destructor"], 1);
});

test("native expression fixtures execute every generic parser route", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const observed = new Set();
    for (const name of ["compiler-types.bas", "compiler-expression-surface.bas", "compiler-expression-chains.bas", "compiler-expression-operations.bas"]) {
        const filePath = path.resolve(__dirname, "integration/workspace", name);
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
        for (const node of analysis.expressionGraph.nodes) {
            for (const family of node.families || (node.family ? [node.family] : [])) observed.add(family);
        }
    }
    const required = Object.values(EXPRESSION_PARSER_HOOKS).flat().sort();
    assert.deepEqual(required.filter((family) => !observed.has(family)), [], "Every generic expression-parser route must emit bounded source provenance.");
    const exceptional = EXCEPTIONAL_EXPRESSION_FAMILY_HOOKS.map(([, family]) => family);
    assert.deepEqual(exceptional.filter((family) => !observed.has(family)), [], "Every exceptional written-call route must emit bounded source provenance.");
});

test("native implicit method-member route follows the FreeBASIC-only grammar boundary", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-method-member-route-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "method-member.bas");
    const source = [
        "Type RouteOwner",
        " value As Integer",
        " Declare Sub SetValue()",
        "End Type",
        "Sub RouteOwner.SetValue()",
        " value = 1",
        "End Sub",
        "Dim item As RouteOwner",
        "item.SetValue()",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, source);

    const familiesFor = async (compilerArguments) => {
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments,
            allowErrors: compilerArguments.some((argument) => argument === "qb" || argument === "fblite" || argument === "deprecated")
        });
        return {
            analysis,
            families: new Set(analysis.expressionGraph.nodes.flatMap((node) => node.families || (node.family ? [node.family] : [])))
        };
    };

    const freebasic = await familiesFor(["-lang", "fb"]);
    assert.equal(freebasic.analysis.completion.errorCount, 0);
    assert.ok(freebasic.families.has("cImplicitDataMember"));

    const qb = await familiesFor(["-lang", "qb"]);
    assert.ok(qb.analysis.completion.errorCount > 0);
    assert.match(qb.analysis.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message || "", /Only valid in -lang fb/);
    assert.equal(qb.families.has("cImplicitDataMember"), false);

    const fblite = await familiesFor(["-lang", "fblite"]);
    assert.ok(fblite.analysis.completion.errorCount > 0);
    assert.match(fblite.analysis.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message || "", /Only valid in -lang fb/);
    assert.equal(fblite.families.has("cImplicitDataMember"), false);

    const deprecated = await familiesFor(["-lang", "deprecated"]);
    assert.ok(deprecated.analysis.completion.errorCount > 0);
    assert.match(deprecated.analysis.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message || "", /Only valid in -lang fb/);
    assert.equal(deprecated.families.has("cImplicitDataMember"), false);
});

test("QB mode rejects FreeBASIC-only WITH and bit-width expression routes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-qb-expression-routes-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const cases = [
        {
            name: "with",
            source: [
                "Type QbRouteRecord",
                " fieldValue As Integer",
                "End Type",
                "Dim recordValue As QbRouteRecord",
                "With recordValue",
                " Print .fieldValue",
                "End With",
                ""
            ].join("\n"),
            family: "cWithVariable",
            diagnostic: /Expected.*recordValue/
        },
        {
            name: "bit-width-intrinsic",
            source: [
                "Dim rawValue As String = \"ab\"",
                "Dim convertedValue As Integer = CVI<16>(rawValue)",
                "Print convertedValue",
                ""
            ].join("\n"),
            family: "cGtInParensOnlyExpr",
            diagnostic: /Only valid in -lang fb/
        }
    ];

    for (const entry of cases) {
        const filePath = path.join(directory, `${entry.name}.bas`);
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments: ["-lang", "qb"],
            overlays: new Map([[filePath, entry.source]]),
            allowErrors: true,
            requireSemanticModel: true
        });
        const families = new Set(analysis.expressionGraph.nodes.flatMap((node) => node.families || (node.family ? [node.family] : [])));
        assert.ok(analysis.completion.errorCount > 0, entry.name);
        assert.ok(analysis.diagnostics.some((diagnostic) => entry.diagnostic.test(diagnostic.message)), entry.name);
        assert.equal(families.has(entry.family), false, entry.name);
    }
});

test("FBLite and deprecated NEW and DELETE on a plain UDT do not invent class constructor calls", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-fblite-new-delete-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "new-delete.bas");
    const source = "Type RouteType\n value As Integer\nEnd Type\nDim item As RouteType Ptr = New RouteType\nDelete item\n";
    for (const languageMode of ["fblite", "deprecated"]) {
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments: ["-lang", languageMode],
            overlays: new Map([[filePath, source]]),
            allowErrors: true,
            exportSemanticBindings: true,
            requireSemanticModel: true
        });

        assert.equal(analysis.completion.errorCount, 0, languageMode);
        assert.equal(analysis.semanticModelCounts.implicitCallCount, 0, languageMode);
        assert.deepEqual(analysis.semanticImplicitCalls, [], languageMode);
    }
});

test("native QB multi-assignment does not export punctuation as a symbol binding", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/expressions/mult-assign.bas");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-lang", "qb", "-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
        allowErrors: true
    });

    assert.ok(analysis.dependencies.includes(filePath));
    assert.equal(analysis.completion.reachedEnd, true);
    assert.ok(!analysis.symbolGraph.uses.some((binding) => binding.name === "="),
        "the internal multi-assignment operator must not enter the source symbol binding graph");
});

test("native QB REM-suffixed symbols remain analyzable but cannot be renamed from missing -pp tokens", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/qb/suffixes2.bas");
    const compilerArguments = ["-lang", "qb", "-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")];
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, compilerArguments, allowErrors: true });
    const unavailable = new Set(analysis.symbolGraph.nonRenameable);
    const remSymbols = analysis.symbolGraph.symbols.filter((symbol) => symbol.name.toLowerCase() === "rem");
    assert.ok(remSymbols.length, "the QB compiler should retain the REM-suffixed native symbols");
    assert.ok(remSymbols.every((symbol) => unavailable.has(symbol.id)), "unprojectable REM identifiers must be non-renameable");
    assert.equal(analysis.symbolGraph.uses.some((use) => use.name.toLowerCase() === "rem"), false);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/qb-suffixes.bas" },
        analysis,
        [{ uri: uri(filePath), text: fs.readFileSync(filePath, "utf8") }]
    );
    assert.ok(model);
});

test("literal origin receipts never become identifier or recovery projections", () => {
    const filePath = path.resolve("literal-anchor.bas");
    const sourceUri = uri(filePath);
    const text = '"looksLikeName"';
    /* A presentation lexer can lack the compiler's escape options. Even if it
       exposes a word inside a literal, the native literal must remain opaque. */
    const token = { kind: "identifier", name: "looksLikeName", key: "lookslikename", offset: 1,
        end: text.length - 1, line: 0, startColumn: 1, endColumn: text.length - 1, index: 0 };
    for (const invalid of [false, true]) {
        const document = { uri: sourceUri, text, tokens: [token], lineOffsets: [0] };
        const model = { sources: new Map([[sourceUri.toString(), document]]), sourceEpochs: new Map(),
            sourceToExpanded: new Map(), expandedToSource: new Map(),
            recoverySourceToExpanded: new Map(), recoveryExpandedToSource: new Map() };
        projectNativeTokens(model, [{ kind: "source", sourceMap: 0, filePath,
            sourceStart: 0, sourceEnd: Buffer.byteLength(text), start: { line: 0, character: 0 },
            end: { line: 0, character: text.length }, epoch: 1, invalid }], document);
        for (const mapping of [model.sourceToExpanded, model.expandedToSource, model.recoverySourceToExpanded,
            model.recoveryExpandedToSource, model.sourceEpochs]) assert.equal(mapping.size, 0);
        assert.equal(document.compilerLiteralCompletionAnchors.length, 1);
    }
});

test("physical token decoding validates origins independently of logical lines", () => {
    const file = path.resolve("physical.bas"), hex = Buffer.from(file).toString("hex");
    const record = `''@fb-editor-token 1 6 11 source 20 25 ${hex}`;
    const output = ["''@fb-editor-protocol 9", `''@fb-editor-file ${hex}`, record, marker2("logical.bas", 1, 999, true), "Print value", "''@fb-editor-end 0 1"].join("\n");
    const analysis = decodePreprocessed(output, process.cwd());
    assert.equal(analysis.tokenOrigins[0].filePath, file);
    assert.equal(analysis.tokenOrigins[0].sourceStart, 20);
    assert.deepEqual(analysis.dependencies, [file]);
    for (const broken of [
        output.replace(record, record + "\n" + record),
        output.replace("1 6 11 source", "1 6 6 source"),
        output.replace("1 6 11 source", "2 6 11 source"),
        output.replace("1 6 11 source", "1 6 99 source"),
        output.replace("source 20 25", "source 25 20"),
        output.replace("source 20 25", "source 20 33554433"),
        output.replace("source 20 25", "generated 20 25"),
        output.replace(`''@fb-editor-file ${hex}`, `''@fb-editor-file 6f74686572`)
    ]) assert.throws(() => decodePreprocessed(broken, process.cwd()), /origin|range|boundary|missing|dependency/i);
});

test("native physical origins retain continued, rewritten, and remapped unsaved source", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-origins.bas");
    const saved = fs.readFileSync(filePath, "utf8");
    const header = path.join(path.dirname(filePath), "origin-buffer.bi");
    const empty = path.join(path.dirname(filePath), "origin-empty.bi");
    for (const newline of ["\n", "\r\n", "\r"]) for (const bom of ["", "\uFEFF"]) {
        const text = ('#include "origin-buffer.bi"\n' + saved + '\n#include "origin-empty.bi"\nPrint headerValue, originValue\n').replace(/\n/g, newline);
        const headerText = '#line 300 "logical-header.bi"\nDim headerValue As Double\n'.replace(/\n/g, newline);
        const options = { compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, bom + text], [header, bom + headerText], [empty, ""]]) };
        const analysis = await analyzeSavedModule(options);
        assert.deepEqual(new Set(analysis.dependencies), new Set([filePath, header, empty]));
        assert.ok(analysis.origins.some((origin) => origin?.filePath.endsWith("logical-origin.bas")));
        assert.ok(analysis.tokenOrigins.some((token) => token.kind === "generated"));
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/physical.bas" }, analysis, [{ uri: uri(filePath), text }, { uri: uri(header), text: headerText }, { uri: uri(empty), text: "" }]);
        const source = model.getDocument(uri(filePath));
        const occurrences = source.tokens.filter((token) => token.name === "originValue");
        const target = model.resolveAt(uri(filePath), occurrences[0].line, occurrences[0].startColumn)[0];
        assert.ok(target?.compilerSymbolId);
        for (const token of occurrences) assert.equal(model.resolveAt(uri(filePath), token.line, token.startColumn)[0]?.id, target.id, JSON.stringify({ newline, bom, token }));
        assert.equal(model.references(target, true).length, occurrences.length);
        assert.ok(model.references(target, true).every((reference) => reference.uri.fsPath === filePath));
        const first = occurrences[1], endLine = first.line + 1;
        assert.equal(model.expressionAt(uri(filePath), { line: first.line, character: first.startColumn }, { line: endLine, character: 5 })?.typeName, "double");
        const last = source.tokens.filter((token) => token.name === "headerValue").at(-1);
        assert.equal(model.resolveAt(uri(filePath), last.line, last.startColumn)[0]?.uri.fsPath, header);
        const generated = source.tokens.find((token) => token.name === "GENERATED_NUMBER" && !source.text.slice(source.lineOffsets[token.line]).startsWith("#define"));
        assert.match(model.resolveAt(uri(filePath), generated.line, generated.startColumn)[0]?.compilerPreprocessorId || "", /^macro:/);
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), saved);
    assert.equal(fs.existsSync(header), false);
    assert.equal(fs.existsSync(empty), false);
});

test("physical projection rejects stale ranges and never guesses an identifier position", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = "Dim value As Double\nPrint value\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, text]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    const expanded = { toString: () => "freebasic-preprocessed:/physical.bas" };
    const model = new CompilerSemanticModel(expanded, { ...analysis, tokenOrigins: [] }, [{ uri: uri(filePath), text }]);
    assert.equal(model.expandedToSource.size, 0, "Missing physical facts must not activate the old whole-line heuristic");
    const broken = structuredClone(analysis);
    broken.tokenOrigins.at(-1).sourceEnd = text.length + 1;
    assert.throws(() => new CompilerSemanticModel(expanded, broken, [{ uri: uri(filePath), text }]), /physical token boundary/);
    assert.throws(() => new CompilerSemanticModel(expanded, analysis, []), /source snapshot is missing/);
});

test("analysis only accepts bounded compile-context arguments", () => {
    assert.deepEqual(analysisArguments(["-d", "FEATURE=1", "-i", "/path with spaces", "-mt"]), ["-d", "FEATURE=1", "-i", "/path with spaces", "-mt"]);
    for (const arguments_ of [["-o", "danger"], ["-x", "danger"], ["@options"], ["-Wc", "anything"], ["-i"], ["-d", "bad\0name"], ["-z", "something"]]) assert.throws(() => analysisArguments(arguments_));
});

test("protocol decoding rejects uninstrumented compilers and malformed origins", () => {
    const file = path.resolve("some file.bas");
    const result = decodePreprocessed(`${marker(file, 3)}\nDim value As Long`, process.cwd());
    assert.equal(result.origins[1].filePath, file);
    assert.equal(result.origins[1].line, 3);
    assert.throws(() => decodePreprocessed("Print 1", process.cwd()), /source origins/);
    assert.throws(() => decodePreprocessed("''@fb-editor-v1 0 0 61\nPrint 1", process.cwd()), /Invalid/);
});

test("procedure records validate byte boundaries, output serials, identities, and versions", () => {
    const file = path.resolve("unicode.bas");
    const line = 'Print "café 🌍", Pick(1)';
    const column = line.indexOf("Pick");
    const bytes = Buffer.byteLength(line.slice(0, column));
    const output = ["''@fb-editor-protocol 2", binding("call", 1, bytes, 3, "Pick"), marker2(file, 1, 0), line].join("\n");
    const result = decodePreprocessed(output, process.cwd());
    assert.equal(result.protocolVersion, 2);
    assert.equal(result.bindings[0].startColumn, column);
    assert.equal(result.bindings[0].line, 3);
    for (const invalid of [
        output.replace(`1 ${bytes} 3`, `2 ${bytes} 3`),
        output.replace(`1 ${bytes} 3`, "1 12 3"),
        output.replace(`1 ${bytes} 3`, "1 99999 3"),
        output.replace(`1 ${bytes} 3`, `1 ${bytes} 9007199254740992`),
        output.replace("protocol 2", "protocol 99"),
        output.replace("@fb-editor-bind call", "@fb-editor-bind unknown"),
        marker2(file, 1, 0),
        output + "\n" + binding("call", 1, bytes, 4, "Pick"),
        output + "\n" + marker2(file, 1, 0) + "\n" + line,
        marker(file, 0).replace(/ [a-f\d]+$/, " ff") + "\nPrint 1",
        marker2(file, 1, 0) + "\n" + binding("declaration", 1, 0, 0, "Pick") + "\nPick"
    ]) assert.throws(() => decodePreprocessed(invalid, process.cwd()), /Invalid|Duplicate|missing|match/i);
});

test("compiler procedure IDs override spelling families and suppress unknown call targets", () => {
    const file = path.resolve("bindings.bas");
    const statements = ["Declare Function Pick(ByVal value As Long) As Long", "Declare Function Pick(ByVal value As Double) As Long", "Print Pick(1), Pick(1.0), Pick(2)"];
    const output = ["''@fb-editor-protocol 2"];
    for (const [index, line] of statements.entries()) output.push(marker2(file, index + 1, index), line);
    output.push(binding("declaration", 1, statements[0].indexOf("Pick"), 1, "Pick"), binding("declaration", 2, statements[1].indexOf("Pick"), 2, "Pick"));
    const calls = [...statements[2].matchAll(/Pick/g)].map((match) => match.index);
    for (const [index, id] of [1, 2, 0].entries()) output.push(binding("call", 3, calls[index], id, "Pick"));
    const analysis = decodePreprocessed(output.join("\n"), process.cwd());
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/bindings.bas" }, analysis, [{ uri: uri(file), text: statements.join("\n") }]);
    const first = model.resolveAt(uri(file), 2, calls[0])[0];
    const second = model.resolveAt(uri(file), 2, calls[1])[0];
    assert.notEqual(first.id, second.id);
    assert.equal(first.declaration.parameters[0].typeName, "Long");
    assert.equal(second.declaration.parameters[0].typeName, "Double");
    assert.equal(model.resolveAt(uri(file), 2, calls[2]).length, 0);
    assert.deepEqual(model.references(first, false).map((entry) => entry.occurrence.startColumn), [calls[0]]);
    assert.deepEqual(model.references(second, false).map((entry) => entry.occurrence.startColumn), [calls[1]]);
});

test("recovery protocol retracts failed regions and requires a terminal record", () => {
    const file = path.resolve("recover.bas");
    const type = Buffer.from("double").toString("hex");
    const output = ["''@fb-editor-protocol 4", marker2(file, 1, 0), "Print value +", `''@fb-editor-type 1 6 1 11 ${type}`, "''@fb-editor-invalid 1 1", "''@fb-editor-end 1 1"].join("\n");
    const result = decodePreprocessed(output, process.cwd());
    assert.deepEqual(result.completion, { errorCount: 1, reachedEnd: true });
    assert.equal(result.expressions.length, 0);
    assert.deepEqual(result.invalidLines, [2]);
    assert.throws(() => decodePreprocessed(output.replace("''@fb-editor-end 1 1", ""), process.cwd()), /finish writing/);
    const interrupted = [marker2(file, 1, 0), "Print value", "''@fb-editor-token-v11 1 6 11 source 6 11 1 0 0"].join("\n");
    const abortedBeforeMetadataFlush = [marker2(file, 1, 0), "Print value"].join("\n");
    assert.throws(() => decodePreprocessed(interrupted, process.cwd()), /finish writing/);
    assert.throws(() => decodePreprocessed(abortedBeforeMetadataFlush, process.cwd()), /finish writing/);
    assert.throws(() => decodePreprocessed(output + "\nPrint 1", process.cwd()), /terminal marker/);
    assert.throws(() => decodePreprocessed(output.replace("invalid 1 1", "invalid 2 1"), process.cwd()), /recovery region/);
});

test("positioned recovery retains expressions ending before the compiler error token", () => {
    const file = path.resolve("positioned-recovery.bas");
    const type = Buffer.from("double").toString("hex");
    const errorFile = Buffer.from(file).toString("hex");
    const output = [
        "''@fb-editor-protocol 14",
        marker2(file, 1, 0),
        "Print value +",
        `''@fb-editor-type 1 6 1 11 ${type} 16 0`,
        `''@fb-editor-type 1 6 1 13 ${type} 16 0`,
        "''@fb-editor-invalid 1 1",
        `''@fb-editor-error 1 ${errorFile} 9 1 12`,
        "''@fb-editor-end 1 1"
    ].join("\n");
    const analysis = decodePreprocessed(output, process.cwd());
    assert.deepEqual(analysis.expressions.map(({ start, end }) => [start.character, end.character]), [[6, 11]]);
    assert.deepEqual(analysis.invalidLines, [2]);
});

test("native symbol graph validates edges, aliases, classes, and token positions", () => {
    const file = path.resolve("graph.bas");
    const name = Buffer.from("value").toString("hex");
    const type = Buffer.from("long").toString("hex");
    const metadata = `''@fb-editor-symbol 1 1 11 0 0 0 0 0 0 0 ${name} ${type}`;
    const output = ["''@fb-editor-protocol 5", metadata, marker2(file, 1, 0), "Dim value As Long", `''@fb-editor-use declaration 1 4 1 ${name}`, "''@fb-editor-end 0 1"].join("\n");
    assert.equal(decodePreprocessed(output, process.cwd()).symbolGraph.uses[0].id, 1);
    for (const invalid of [
        output.replace("1 1 11 0 0 0", "1 1 11 999 0 0"),
        output.replace("use declaration 1 4 1", "use declaration 1 4 99"),
        output.replace("use declaration 1 4 1", "use declaration 1 5 1"),
        output.replace("1 1 11", "1 99 11"),
        output.replace(metadata, metadata + "\n''@fb-editor-alias 1 1"),
        output.replace(metadata, metadata + "\n" + metadata.replace("1 1 11", "1 2 11"))
    ]) assert.throws(() => decodePreprocessed(invalid, process.cwd()), /symbol|Symbol|identity/);
});

test("native dispatch metadata requires complete acyclic slot-preserving procedure edges", () => {
    const file = path.resolve("dispatch.bas");
    const metadata = (id) => `''@fb-editor-symbol ${id} 3 0 0 0 0 0 256 0 0 466F6F 766F6964`;
    const output = ["''@fb-editor-protocol 6", metadata(1), metadata(2), "''@fb-editor-dispatch 1 0 2", "''@fb-editor-dispatch 2 1 2", marker2(file, 1, 0), "Print 1", "''@fb-editor-end 0 1"].join("\n");
    assert.deepEqual(decodePreprocessed(output, process.cwd()).symbolGraph.dispatch, [{ id: 1, overridden: 0, slot: 2 }, { id: 2, overridden: 1, slot: 2 }]);
    for (const invalid of [
        output.replace("''@fb-editor-dispatch 1 0 2", ""),
        output.replace("dispatch 2 1 2", "dispatch 2 99 2"),
        output.replace("symbol 1 3", "symbol 1 1"),
        output.replace("dispatch 2 1 2", "dispatch 2 1 3"),
        output.replace("dispatch 1 0 2", "dispatch 1 0 1"),
        output.replace("dispatch 1 0 2", "dispatch 1 2 2")
    ]) assert.throws(() => decodePreprocessed(invalid, process.cwd()), /dispatch|identity|procedure|slot|override/i);
});

test("partial recovery withholds compiler-rejected virtual slots without discarding the model", () => {
    const file = path.resolve("recovered-dispatch.bas");
    const metadata = "''@fb-editor-symbol 1 3 0 0 0 0 0 256 0 0 466F6F 766F6964";
    const output = [
        "''@fb-editor-protocol 6",
        metadata,
        "''@fb-editor-dispatch 1 0 0",
        marker2(file, 1, 0),
        "Print 1",
        "''@fb-editor-invalid 1 1",
        "''@fb-editor-end 1 1"
    ].join("\n");
    const analysis = decodePreprocessed(output, process.cwd());
    assert.deepEqual(analysis.symbolGraph.dispatch, []);
    assert.deepEqual(analysis.symbolGraph.invalidDispatch, [1]);
    assert.deepEqual(analysis.recoverySymbols, [1]);
});

test("expression graph validates native edges, byte ranges, types, and recovery dependencies", () => {
    const file = path.resolve("expressions.bas");
    const leaf = "''@fb-editor-expression 1 syntax 1 6 1 11 11 0 0 0 0 0 0 6c6f6e67";
    const conversion = "''@fb-editor-expression 2 conversion 2 6 2 11 16 0 1 0 0 0 0 646f75626c65";
    const family = (id, name) => `''@fb-editor-expression-family ${id} ${Buffer.from(name).toString("hex")}`;
    const output = ["''@fb-editor-protocol 7", marker2(file, 1, 0), "Print value", leaf, family(1, "cAtom"), marker2(file, 2, 1), "Print value", conversion, "''@fb-editor-invalid 1 1", "''@fb-editor-end 1 1"].join("\n");
    const graph = decodePreprocessed(output, process.cwd()).expressionGraph;
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.nodes[0].family, "cAtom");
    const tagged = decodePreprocessed(output.replace(family(1, "cAtom"), `${family(1, "cAtom")}\n${family(1, "cMathFunct")}`), process.cwd()).expressionGraph.nodes[0];
    assert.deepEqual(tagged.families, ["cAtom", "cMathFunct"]);
    assert.ok(graph.nodes.every((node) => node.invalid), "Recovery taint follows inputs even outside the failed span");
    for (const invalid of [
        output.replace("expression 1 syntax", "expression 3 syntax"),
        output.replace("16 0 1 0 0 0 0", "16 0 2 0 0 0 0"),
        output.replace("16 0 1 0 0 0 0", "16 999 1 0 0 0 0"),
        output.replace("16 0 1 0 0 0 0", "16 0 1 0 0 9 0"),
        output.replace("16 0 1 0 0 0 0", "16 0 0 0 0 0 0"),
        output.replace("syntax 1 6 1 11", "syntax 1 6 1 99"),
        output.replace(family(1, "cAtom"), `${family(1, "cAtom")}\n${family(1, "cAtom")}`),
        output.replace(family(1, "cAtom"), family(2, "cAtom"))
    ]) assert.throws(() => decodePreprocessed(invalid, process.cwd()), /expression|conversion|procedure|boundary/i);
    const indexed = [
        "''@fb-editor-protocol 7",
        marker2(file, 1, 0), "Print value(0)",
        "''@fb-editor-expression 1 syntax 1 6 1 11 8 0 0 0 0 0 0 696e7465676572",
        "''@fb-editor-expression 2 syntax 1 12 1 13 8 0 0 0 0 0 0 696e7465676572",
        "''@fb-editor-expression 3 index 1 6 1 14 8 0 1 2 0 0 0 696e7465676572",
        "''@fb-editor-end 0 1"
    ].join("\n");
    assert.deepEqual(decodePreprocessed(indexed, process.cwd()).expressionGraph.nodes[2].inputs, [1, 2, 0]);
    assert.throws(() => decodePreprocessed(indexed.replace("1 2 0 0 0", "0 0 0 0 0"), process.cwd()), /operation/);
});

test("expression comparison preserves DAG meaning across rename offsets and independent-node ordering", () => {
    const node = (id, kind, startByte, endByte, dtype, input = 0) => ({ id, kind, startSerial: 1, startByte, endSerial: 1, endByte, dtype, subtype: 0, inputs: [input, 0, 0], target: 0, options: 0 });
    const before = { symbolGraph: { uses: [{ id: 1, outputLine: 1, byteColumn: 6, name: "value" }] }, expressionGraph: { nodes: [node(1, "syntax", 6, 11, 11), node(2, "syntax", 14, 15, 8), node(3, "conversion", 6, 11, 16, 1)] } };
    const after = { symbolGraph: { uses: [] }, expressionGraph: { nodes: [node(1, "syntax", 15, 16, 8), node(2, "syntax", 6, 12, 11), node(3, "conversion", 6, 12, 16, 2)] } };
    const expected = expressionGraphSignature(before, new Set([1]), "longer");
    assert.deepEqual(expressionGraphSignature(after), expected);
    after.expressionGraph.nodes[2].inputs[0] = 1;
    assert.notDeepEqual(expressionGraphSignature(after), expected, "A changed input is not an ordering difference");
});

test("native scope decoding checks ownership, inventory spans, shapes, and unfinished regions", () => {
    const file = path.resolve("scope.bas");
    const begin = "''@fb-editor-scope begin 1 0 1 1 10 namespace";
    const end = "''@fb-editor-scope end 1 2 13 0";
    const shape = "''@fb-editor-shape 1 0 0 0 0 0 0";
    const declaration = "''@fb-editor-declaration 1 0 1 10 1 12 0 4e53";
    const output = ["''@fb-editor-protocol 8", "''@fb-editor-symbol 1 8 0 0 0 0 0 0 0 0 4e53 -", shape, begin, declaration, marker2(file, 1, 0), "Namespace NS", marker2(file, 2, 1), "End Namespace", end, "''@fb-editor-end 0 1"].join("\n");
    const graph = decodePreprocessed(output, process.cwd()).scopeGraph;
    assert.equal(graph.scopes[0].symbol, 1);
    assert.equal(graph.declarations[0].name, "NS");
    for (const invalid of [output.replace("begin 1 0", "begin 1 1"), output.replace(end, end + "\n" + end), output.replace(declaration, declaration.replace("1 0 1 10", "1 2 1 10")), output.replace(shape, ""), output.replace(shape, shape.replace("1 0 0", "1 99 0")), output.replace("1 12 0 4e53", "1 99 0 4e53"), output.replace(end, "")]) assert.throws(() => decodePreprocessed(invalid, process.cwd()), /scope|inventory|shape|boundary/i);
    assert.ok(decodePreprocessed(output.replace(end, "").replace("end 0 1", "end 1 1"), process.cwd()).scopeGraph.scopes[0].recovered);
});

test("argument-chain recovery ignores unrelated errors between a default and its call", () => {
    const file = path.resolve("default-recovery.bas");
    const output = [
        "''@fb-editor-protocol 7",
        marker2(file, 1, 0), "Print 1",
        "''@fb-editor-expression 1 syntax 1 6 1 7 8 0 0 0 0 0 0 696e7465676572",
        marker2(file, 2, 1), "Print +",
        "''@fb-editor-invalid 2 2",
        marker2(file, 3, 2), "Print 2",
        "''@fb-editor-expression 2 syntax 3 6 3 7 8 0 0 0 0 0 0 696e7465676572",
        "''@fb-editor-expression 3 argument 1 6 3 7 8 0 0 1 2 0 1 696e7465676572",
        "''@fb-editor-end 1 1"
    ].join("\n");
    assert.equal(decodePreprocessed(output, process.cwd()).expressionGraph.nodes[2].invalid, false);
    const invalidDefault = output.replace("invalid 2 2", "invalid 1 2");
    assert.equal(decodePreprocessed(invalidDefault, process.cwd()).expressionGraph.nodes[2].invalid, true);
    for (const invalid of [output.replace("0 1 2 0 1", "1 1 2 0 1"), output.replace("0 1 2 0 1", "0 1 2 0 0")]) assert.throws(() => decodePreprocessed(invalid, process.cwd()), /argument chain/);
});

test("compiler model excludes inactive symbols and retains generated definitions", () => {
    const file = path.resolve("context.bas");
    const expandedUri = { toString: () => "freebasic-preprocessed:/context.bas" };
    const text = "#if ENABLED\nType ActiveType\n field As Long\nEnd Type\n#else\nType InactiveType\nEnd Type\n#endif\nMAKE_VALUE(value)\nPrint value.field";
    const output = [marker(file, 1), "Type ActiveType", marker(file, 2), " field As Long", marker(file, 3), "End Type", marker(file, 8, true), "Dim value As ActiveType", marker(file, 9), "Print value.field"].join("\n");
    const model = new CompilerSemanticModel(expandedUri, decodePreprocessed(output, process.cwd()), [{ uri: uri(file), text }]);
    const variable = model.resolveAt(uri(file), 9, 8)[0];
    assert.ok(variable);
    assert.equal(variable.uri.toString(), expandedUri.toString());
    assert.deepEqual(model.completeMembers(uri(file), 9, 12).map((entry) => entry.name), ["field"]);
    assert.equal(model.resolveAt(uri(file), 5, 8).length, 0);
    const field = model.resolveAt(uri(file), 9, 14)[0];
    assert.equal(field.uri.fsPath, file);
    assert.equal(field.declaration.line, 2);
    assert.match(model.renameProblem(variable), /disabled/);
});

test("compiler hooks still match the pinned compiler source", () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const compilerRoot = path.join(root, "src/compiler");
    const readCompilerSource = (name) => fs.readFileSync(resolveCompilerSourcePath(compilerRoot, name), "utf8").replace(/\r\n/g, "\n");
    const semanticCoordinates = instrumentSemanticCoordinates(readCompilerSource("tooling/semantic-coordinates.bas"));
    assert.doesNotMatch(semanticCoordinates, /Unmarked legacy text keeps one compiler column per source byte/);
    assert.match(semanticCoordinates, /domain = "expression"/);
    assert.match(semanticCoordinates, /if\( fbSemanticModelExpressionsOnly\( \) andalso/);
    assert.throws(() => instrumentSemanticCoordinates(""), /changed/);
    const semanticSourceFilter = instrumentSemanticSourceFilter(readCompilerSource("tooling/semantic-model.bas"));
    assert.match(semanticSourceFilter, /FB_VSCODE_SEMANTIC_SOURCE_FILTER/);
    assert.match(semanticSourceFilter, /hSemanticModelSourceAllowed/);
    assert.throws(() => instrumentSemanticSourceFilter(""), /changed/);
    const result = instrumentLexer(readCompilerSource("lex.bas"), readCompilerSource("lex.bi"));
    assert.match(result.source, /editorEmitOrigin/);
    assert.match(result.header, /editor_expanded/);
    assert.match(result.header, /editor_physical_byte/);
    assert.match(result.source, /editorEmitSourceToken/);
    assert.match(result.source, /probe.ctx.editor_probe = TRUE/);
    const names = ["symb.bi", "symb-proc.bas", "parser.bi", "parser-proccall-args.bas", "parser-expr-function.bas", "parser-proccall.bas", "parser-proc.bas"];
    const sources = Object.fromEntries(names.map((name) => [name, readCompilerSource(name)]));
    const procedures = instrumentProcedures(sources);
    assert.match(procedures["parser-proccall-args.bas"], /\*editor_target = proc/);
    assert.match(procedures["parser-proc.bas"], /editorEmitProcedure/);
    assert.throws(() => instrumentProcedures({ ...sources, "parser-proc.bas": "" }), /changed/);
    assert.match(instrumentSourceIO(readCompilerSource("fb.bas")), /open\( editorSourcePath/);
    const expressionFiles = [...new Set(listCompilerSourceFiles(compilerRoot)
        .map((name) => path.basename(name)).filter((name) => /^parser-expr-.*\.bas$/.test(name)))];
    const expressionSources = Object.fromEntries(expressionFiles.map((name) => [name, procedures[name] || readCompilerSource(name)]));
    assert.match(instrumentExpressions(expressionSources)["parser-expr-binary.bas"], /editorOriginal_cExpression/);
    const expressions = instrumentExpressions(expressionSources);
    assert.match(expressions["parser-expr-binary.bas"], /editorEmitExpression\(editor_prefix, relexpr\)/);
    for (const [file, names] of Object.entries(EXPRESSION_PARSER_HOOKS)) for (const name of names) {
        assert.match(expressionSources[file], new RegExp(`^(?:private )?function ${name}\\b`, "m"), `${file}: ${name}`);
        assert.match(expressions[file], new RegExp(`editorOriginal_${name}\\b`), `${file}: ${name}`);
    }
    const graphSources = Object.fromEntries(EXPRESSION_FILES.map((name) => [name, expressions[name] || procedures[name] || readCompilerSource(name)]));
    const graph = instrumentExpressionGraph(graphSources, replaceOnce);
    assert.match(graph["ast.bi"], /\(n\)->editor_source.identity = 0/);
    assert.match(graph["ast-node-conv.bas"], /editorOriginal_astNewCONV/);
    assert.match(graph["ast-node-conv.bas"], /editorEmitTransform\("conversion", editor_result, editor_first, editor_empty, editor_lowered/);
    assert.match(graph["ast-node-bop.bas"], /editorOriginal_astNewBOP/);
    assert.match(graph["ast-node-bop.bas"], /editorOriginal_astNewBOPWithOperands/);
    assert.match(graph["ast-node-bop.bas"], /result->editor_source.target = proc/);
    assert.match(graph["ast-node-uop.bas"], /editorOriginal_astNewUOP/);
    assert.match(graph["ast-node-iif.bas"], /editorOriginal_astNewIIF/);
    assert.match(graph["ast-node-call.bas"], /editor_source.target = sym/);
    assert.match(graph["ast-node-arg.bas"], /editorEmitArgument/);
    if (readCompilerSource("ast-node-arg.bas").includes("fbSemanticModelExportArgumentConstructor")) {
        assert.match(graph["ast-node-arg.bas"], /fbSemanticModelExportArgumentConstructor\(param, arg->sym, semantic_source_range\)/,
            "current FBC owns exact argument-constructor semantic receipts");
        assert.doesNotMatch(graph["ast-node-arg.bas"], /fbSemanticModelExportImplicitCall\(param, astGetSymbol\(arg\), "argument-constructor"/,
            "the bridge must not duplicate FBC's argument-constructor facts");
    } else {
        assert.match(graph["ast-node-arg.bas"], /fbSemanticModelExportImplicitCall\(param, astGetSymbol\(arg\), "argument-constructor", editor_semantic_site\)/);
    }
    assert.match(graph["ast-node-idx.bas"], /editorOriginal_astNewIDX/);
    const nativeSemanticMemoryOperations = /fbSemanticModel(?:ExportOperation|SourceMemoryApplication)\(semantic_operator,/
        .test(readCompilerSource("parser-quirk-mem.bas"));
    assert.match(graph["ast-node-mem.bas"], nativeSemanticMemoryOperations
        ? /semantic_operator = operator_call/
        : /editor_selected = symbGetCompOpOvlHead/);
    assert.match(graph["parser-quirk-mem.bas"], /astBuildNewOp\( op, tmp, elementsexpr, initexpr/);
    if (nativeSemanticMemoryOperations) {
        assert.match(graph["parser-quirk-mem.bas"], /editorEmitCall\(editor_start, expr, semantic_operator->sym/);
        assert.match(graph["parser-quirk-mem.bas"], /editorEmitCall\(editor_start, delete_expr, semantic_operator->sym/);
    } else {
        assert.match(graph["parser-quirk-mem.bas"], /editorEmitCall\(editor_start, editor_result, editor_target/);
    }
    assert.match(graph["parser-compound-for.bas"], /editorEmitIteratorCall/);
    assert.match(graph["parser-compound-for.bas"], /editor_target as FBSYMBOL ptr ptr/);
    assert.match(graph["ast-node-assign.bas"], /editor_call = astBuildCall\( proc, l, r \)/);
    assert.match(graph["parser-assignment.bas"], /editorEmitCall\(editor_start, l, editor_source.target/);
    assert.match(graph["ast-helper.bas"], /editorEmitTransform\("call", procexpr, editor_input/);
    assert.match(graph["ast-helper.bas"], /editor_sites\[cnt-1\]/);
    assert.match(graph["parser-expr-function.bas"], /editor_target = editor_source.target/);
    assert.match(graph["parser-quirk-thread.bas"], /editorEmitCall\(editor_start, editor_result/);
    assert.match(graph["parser-quirk-vafirst.bas"], /editorEmitTransform\("call", result, editor_input/);
    assert.match(graph["parser-quirk-math.bas"], /editorOriginal_cMathFunct/);
    assert.match(graph["parser-quirk-math.bas"], /editorExchangeExpressionFamily\("cMathFunct"\)/);
    for (const [file, names] of Object.entries(TYPE_LAYOUT_EXPRESSION_HOOKS)) for (const name of names) {
        assert.match(graphSources[file], new RegExp(`^(?:private )?function ${name}\\b`, "m"), `${file}: ${name}`);
        assert.match(graph[file], new RegExp(`editorExchangeExpressionFamily\\("${name}"\\)`), `${file}: ${name}`);
    }
    assert.throws(() => instrumentExpressionGraph({ ...graphSources, "ast.bi": "" }, replaceOnce), /changed/);
    assert.throws(() => instrumentExpressionGraph({ ...graphSources, "parser-decl-symbtype.bas": "" }, replaceOnce), /changed/);
    const recoveryFiles = ["fb.bas", "error.bas", "parser-toplevel.bas", "parser-statement.bas", "parser-decl-symbtype.bas", "parser-expr-unary.bas", "parser-quirk-math.bas", "parser-quirk-peekpoke.bas", "pp.bas"];
    const recoverySources = Object.fromEntries(recoveryFiles.map((name) => [name, readCompilerSource(name)]));
    assert.match(instrumentRecovery(recoverySources)["parser-statement.bas"], /editorInvalidateRegion/);
    assert.match(instrumentRecovery(recoverySources)["parser-decl-symbtype.bas"], /FB_VSCODE_TRACE/);
    assert.match(instrumentRecovery(recoverySources)["parser-decl-symbtype.bas"], /next physical editor statement/);
    assert.match(instrumentRecovery(recoverySources)["parser-quirk-math.bas"], /incomplete LEN\(\)\/SIZEOF\(\)/);
    assert.match(instrumentRecovery(recoverySources)["parser-quirk-peekpoke.bas"], /incomplete PEEK\(\)/);
    assert.match(instrumentRecovery(recoverySources)["parser-expr-unary.bas"], /incomplete PROCPTR\(\)/);
    assert.match(instrumentRecovery(recoverySources)["pp.bas"], /hSkipUntil\( FB_TK_EOL \)/);
    assert.throws(() => instrumentRecovery({ ...recoverySources, "error.bas": "" }), /changed/);
    const symbolSources = Object.fromEntries(SYMBOL_FILES.map((name) => [name, readCompilerSource(name)]));
    const symbols = instrumentSymbols(symbolSources, replaceOnce);
    assert.match(symbols["symb.bas"], /s->editor_symbol_id = 0/);
    assert.match(symbols["symb-proc.bas"], /editorAliasSymbol\(s, param\)/);
    const scopeSources = Object.fromEntries(SCOPE_FILES.map((name) => [name, procedures[name] || symbols[name] || readCompilerSource(name)]));
    const scopes = instrumentScopes(scopeSources, replaceOnce);
    assert.match(scopes["ast-node-scope.bas"], /editorOpenScope/);
    assert.match(scopes["parser-proc.bas"], /editorDeclareSymbol/);
    assert.match(scopes["symb-struct.bas"], /s->udt\.anonparent = NULL/);
    const macroSources = Object.fromEntries(MACRO_FILES.map((name) => [name, scopes[name] || symbols[name] || procedures[name] || readCompilerSource(name)]));
    const macros = instrumentMacros(macroSources, replaceOnce);
    assert.match(macros["pp-define.bas"], /editorEnterMacro/);
    assert.match(macros["pp-define.bas"], /incomplete macro invocation/);
    assert.match(macros["pp-define.bas"], /lexGetLookAheadChar\( \) = CHAR_LF/);
    assert.match(macros["pp.bas"], /editorAppendMap/);
    assert.match(macros["symb-define.bas"], /t->editor_map = 0/);
    const preprocessorSources = Object.fromEntries(PREPROCESSOR_FILES.map((name) => [name, macros[name] || scopes[name] || symbols[name] || procedures[name] || readCompilerSource(name)]));
    const preprocessor = instrumentPreprocessor(preprocessorSources, replaceOnce);
    assert.match(preprocessor["pp-define.bas"], /editorMacroDeclaration/);
    assert.match(preprocessor["pp-define.bas"], /errGetCount\(\) = editor_errors/);
    assert.match(preprocessor["pp.bas"], /editorMacroReference/);
    assert.match(preprocessor["parser-identifier.bas"], /editor_query/);
    assert.throws(() => instrumentPreprocessor({ ...preprocessorSources, "parser.bi": "" }, replaceOnce), /changed/);
    assert.throws(() => instrumentMacros({ ...macroSources, "pp-define.bas": "" }, replaceOnce), /changed/);
    assert.throws(() => instrumentScopes({ ...scopeSources, "ast-node-scope.bas": "" }, replaceOnce), /changed/);
    assert.throws(() => instrumentSymbols({ ...symbolSources, "parser-decl-var.bas": "" }, replaceOnce), /changed/);
});

test("native symbol identities distinguish shadowing and reconcile prototype parameters", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-symbols.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/symbols.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const entries = model.inner.entries;
    const values = entries.filter((entry) => entry.name === "value");
    assert.equal(new Set(values.map((entry) => entry.compilerSymbolId)).size, 3);
    assert.ok(values.every((entry) => entry.compilerSymbolId));
    assert.equal(new Set(values.map((entry) => entry.nativeSymbol.owner)).size, 3);
    const declaration = entries.find((entry) => entry.name === "declared");
    const implementation = entries.find((entry) => entry.name === "actual");
    assert.equal(declaration.compilerSymbolId, implementation.compilerSymbolId);
    assert.equal(model.references(implementation, true).length, 3);
    for (const kind of ["namespace", "type", "field", "const", "enum", "enumMember", "parameter", "variable", "label"]) assert.ok(entries.some((entry) => entry.declaration.type === kind && entry.compilerSymbolId), kind);
    const variable = entries.find((entry) => entry.name === "recordValue");
    assert.equal(model.typeEntries(variable)[0].name, "Record");
    const again = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    assert.deepEqual(analysis.symbolGraph, again.symbolGraph, "Pooled addresses must not become editor identities");
});

test("native inlay hints retain compiler types for implicit FBLite variables", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-implicit-inlay-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "implicit-inlay.bas");
    const source = [
        '#lang "fblite"',
        "Print implicitFirstReadValue",
        "For implicitCounter = 1 To 2",
        "Next",
        "implicitAssignmentValue = 17",
        "Input implicitInputValue",
        "Input #1, implicitFileInputValue",
        "Input \"Enter value: \"; implicitPromptInputValue",
        "Data 7",
        "Read implicitReadValue",
        "Dim explicitCounter As Long",
        "For explicitCounter = 1 To 2",
        "Next",
        "Dim explicitBeforeColon As Long: implicitColonValue = 5"
    ].join("\n");
    fs.writeFileSync(filePath, source, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    });
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/implicit-inlay.bas" },
        analysis,
        analysis.dependencies.map((dependency) => ({
            uri: uri(dependency),
            text: dependency === filePath ? source
                : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
        }))
    );
    const lines = source.split("\n");
    const hints = model.compilerTypeInlayHints(uri(filePath),
        { line: 0, character: 0 },
        { line: lines.length - 1, character: lines.at(-1).length });
    const hasIntegerHint = (name) => hints.some((hint) =>
        lines[hint.position.line].slice(0, hint.position.character).trimEnd().endsWith(name) &&
        /^integer$/i.test(hint.typeName)
    );

    const firstReadColumn = lines[1].indexOf("implicitFirstReadValue");
    const firstReadEntries = model.resolveAt(uri(filePath), 1, firstReadColumn);
    assert.equal(firstReadEntries.length, 1,
        "the native bridge should resolve a compiler-created local at its first read");
    assert.equal(firstReadEntries[0].declaration.typeName.toLowerCase(), "integer");
    const firstReadHover = queryCompilerModel(model, "hover", {
        uri: CompilerUri.file(filePath),
        position: { line: 1, character: firstReadColumn }
    }, () => {});
    assert.equal(firstReadHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
    assert.equal(firstReadHover.compilerStorageClass, "local");

    assert.ok(hasIntegerHint("implicitFirstReadValue"),
        "the compiler should type a legacy implicit variable first encountered in a read");
    assert.ok(hasIntegerHint("implicitCounter"), "the compiler should type an undeclared loop counter");
    assert.ok(hasIntegerHint("implicitAssignmentValue"), "the compiler should type an implicitly created assignment target");
    assert.ok(hasIntegerHint("implicitInputValue"), "the compiler should type an implicitly created INPUT target");
    assert.ok(hasIntegerHint("implicitFileInputValue"), "the compiler should type an implicitly created file INPUT target");
    assert.ok(hasIntegerHint("implicitPromptInputValue"), "the compiler should type an implicitly created INPUT target after a prompt");
    assert.ok(hasIntegerHint("implicitReadValue"), "the compiler should type an implicitly created READ target");
    assert.ok(hasIntegerHint("implicitColonValue"), "an unrelated explicit type in the preceding colon statement must not suppress the implicit hint");
    assert.equal(hasIntegerHint("explicitCounter"), false, "a source-declared loop counter needs no inferred type hint");

    const refactoredSource = source.replace(
        "Print implicitFirstReadValue",
        "Dim implicitFirstReadValue As Integer\nPrint implicitFirstReadValue"
    );
    fs.writeFileSync(filePath, refactoredSource, "utf8");
    const refactoredAnalysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath
    });
    assert.equal(refactoredAnalysis.partial, false);
    assert.deepEqual(refactoredAnalysis.diagnostics, [],
        "the compiler-selected first-read type should compile as an explicit local Dim");
});

test("native expression ranges support compiler-backed Expand Selection", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-expression-selection-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "selection.bas");
    const source = [
        "Sub selectExpressions()",
        "Dim a As Integer, b As Integer, c As Integer",
        "Print a + b * c",
        "End Sub"
    ].join("\n");
    fs.writeFileSync(filePath, source, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        exportSemanticExpressions: true
    });
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/selection.bas" },
        analysis,
        analysis.dependencies.map((dependency) => ({
            uri: uri(dependency),
            text: dependency === filePath ? source
                : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
        }))
    );
    const results = queryCompilerModel(model, "compilerSelectionRanges", {
        uri: { scheme: "file", fsPath: filePath },
        positions: [{ line: 2, character: 11 }]
    }, () => {});

    assert.deepEqual(results[0].map((range) => [
        range.start.line, range.start.character, range.end.line, range.end.character
    ]), [
        [2, 10, 2, 11],
        [2, 10, 2, 15],
        [2, 6, 2, 15]
    ]);
});

test("native hover retains a resolved header declaration's qualified name and physical source", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-reference-hover-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "reference-hover.bas");
    const source = [
        '#include once "fbgfx.bi"',
        "Using FB",
        "Dim pixelWidth As Long, pixelHeight As Long",
        'DrawStringSize("sample", pixelWidth, pixelHeight)'
    ].join("\n");
    fs.writeFileSync(filePath, source, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/reference-hover.bas" },
        analysis,
        analysis.dependencies.map((dependency) => ({
            uri: uri(dependency),
            text: dependency === filePath ? source
                : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
        }))
    );
    const callOffset = source.indexOf("DrawStringSize");
    const result = queryCompilerModel(model, "hover", {
        uri: { scheme: "file", fsPath: filePath },
        position: { line: 3, character: callOffset - source.lastIndexOf("\n", callOffset) - 1 + 4 }
    }, () => {});
    const declaration = result.entries.find((entry) => entry.name.toLowerCase() === "drawstringsize");

    assert.ok(declaration, "FBC should resolve the included bundled API declaration");
    assert.equal(declaration.qualifiedName, "fb.drawstringsize");
    assert.equal(path.basename(declaration.uri.fsPath).toLowerCase(), "fbgfx.bi");

    const signatureResult = queryCompilerModel(model, "signature", {
        uri: { scheme: "file", fsPath: filePath },
        position: { line: 3, character: callOffset - source.lastIndexOf("\n", callOffset) - 1 + "DrawStringSize(".length }
    }, () => {});
    const signatureDeclaration = signatureResult.entries.find((entry) => entry.name.toLowerCase() === "drawstringsize");
    assert.ok(signatureDeclaration, "Signature Help should retain the compiler-resolved overload declarations");
    const normalizeSignature = (value) => value.toLowerCase().replace(/\s+/g, " ").trim();
    assert.ok(getReferenceSignatures("fb.drawstringsize", { header: "fbgfx.bi" }).some((entry) =>
        normalizeSignature(entry.label) === normalizeSignature(signatureDeclaration.declaration.signature)
    ), `The resolved declaration should match one documented overload: ${signatureDeclaration.declaration.signature}`);
});

test("compiler-selected parameter inlay hints follow overload bindings", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-parameter-inlay-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "parameter-inlay.bas");
    const source = [
        "Function SelectValue Overload(ByVal wholeNumber As Long) As Long",
        "    Return wholeNumber",
        "End Function",
        "Function SelectValue Overload(ByVal decimalNumber As Double) As Double",
        "    Return decimalNumber",
        "End Function",
        "Function SelectValue Overload(ByVal messageText As String) As String",
        "    Return messageText",
        "End Function",
        "Type BuiltValue",
        "    value As Long",
        "    Declare Constructor(ByVal wholeCount As Long)",
        "    Declare Constructor(ByVal fractionalCount As Double)",
        "End Type",
        "Constructor BuiltValue(ByVal wholeCount As Long)",
        "    This.value = wholeCount",
        "End Constructor",
        "Constructor BuiltValue(ByVal fractionalCount As Double)",
        "    This.value = CInt(fractionalCount)",
        "End Constructor",
        "Print SelectValue(1)",
        "Print SelectValue(2.5)",
        "Print SelectValue(\"text\")",
        "Dim longBuilt As BuiltValue = BuiltValue(3)",
        "Dim doubleBuilt As BuiltValue = BuiltValue(2.5)"
    ].join("\n");
    fs.writeFileSync(filePath, source, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/parameter-inlay.bas" },
        analysis,
        analysis.dependencies.map((dependency) => ({
            uri: uri(dependency),
            text: dependency === filePath ? source
                : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
        }))
    );
    const lines = source.split("\n");
    const firstCallLine = lines.findIndex((line) => line === "Print SelectValue(1)");
    const lastCallLine = lines.indexOf("Dim doubleBuilt As BuiltValue = BuiltValue(2.5)");
    const records = queryCompilerModel(model, "compilerParameterInlayHints", {
        uri: { scheme: "file", fsPath: filePath },
        position: { line: firstCallLine, character: 0 },
        end: { line: lastCallLine, character: lines[lastCallLine].length }
    }, () => {});

    assert.deepEqual(records.map((record) => [record.position.line, record.position.character, record.label]), [
        [firstCallLine, lines[firstCallLine].indexOf("1)"), "wholeNumber:"],
        [firstCallLine + 1, lines[firstCallLine + 1].indexOf("2.5)"), "decimalNumber:"],
        [firstCallLine + 2, lines[firstCallLine + 2].indexOf("\"text\""), "messageText:"],
        [lastCallLine - 1, lines[lastCallLine - 1].lastIndexOf("3)"), "wholeCount:"],
        [lastCallLine, lines[lastCallLine].lastIndexOf("2.5)"), "fractionalCount:"]
    ]);
});

test("native selected call-argument receipts supply parameter names and modes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-selected-argument-inlay-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "selected-argument-inlay.bas");
    const source = [
        "Sub ApplyValues(ByVal expectedCount As Integer, ByRef destination As Integer)",
        "End Sub",
        "Dim suppliedCount As Integer",
        "Dim suppliedResult As Integer",
        "ApplyValues(suppliedCount, suppliedResult)",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, source, "utf8");

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        semanticModelOnly: true,
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticSidecarOnly, true);
    assert.deepEqual(analysis.semanticCallArgumentInputs.map((input) => [input.parameterName, input.passingMode]).sort(), [
        ["destination", "byref"],
        ["expectedCount", "byval"]
    ].sort());

    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/selected-argument-inlay.bas" },
        analysis,
        analysis.dependencies.map((dependency) => ({
            uri: uri(dependency),
            text: dependency === filePath ? source
                : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
        }))
    );
    model.semanticProcedureParameterModes = [];
    const callLine = source.split("\n").findIndex((line) => line.startsWith("ApplyValues("));
    const lineText = source.split("\n")[callLine];
    const records = queryCompilerModel(model, "compilerParameterInlayHints", {
        uri: { scheme: "file", fsPath: filePath },
        position: { line: callLine, character: 0 },
        end: { line: callLine, character: lineText.length }
    }, () => {});

    assert.deepEqual(records.map((record) => [record.position.character, record.label, record.passingMode])
        .sort((first, second) => first[0] - second[0]), [
            [lineText.indexOf("suppliedCount"), "expectedCount:", "byval"],
            [lineText.indexOf("suppliedResult"), "destination:", "byref"]
        ]);
});

test("native model omits uneditable generated symbol spans in FBLite query-symbol tests", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const compilerArguments = ["-lang", "fblite", "-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")];
    for (const name of ["fb_query_symbol-error-1.bas", "fb_query_symbol-error-2.bas", "fb_query_symbol-error-3.bas"]) {
        const filePath = path.join(root, "tests/syntax", name);
        const text = decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath).replace(/^\uFEFF/, "");
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments,
            overlays: new Map([[filePath, text]]),
            allowErrors: true
        });
        const model = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/fblite/${name}` },
            analysis,
            analysis.dependencies.map((dependency) => ({
                uri: uri(dependency),
                text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
            }))
        );
        const generatedUses = analysis.symbolGraph.uses.filter((binding) => binding.name === "SomeUndefinedSymbol");
        assert.ok(generatedUses.length, `${name}: the compiler should retain its query-symbol identity for analysis`);
        for (const binding of generatedUses) {
            const origin = analysis.tokenOrigins.find((token) => token.start.line === binding.line &&
                token.start.character === binding.startColumn && token.end.character === binding.endColumn);
            assert.equal(origin?.kind, "generated", `${name}: the unmatched compiler span must be explicitly generated`);
            assert.equal(origin?.sourceMap, 0, `${name}: the generated span must have no physical macro mapping`);
            assert.ok(!model.nativeBindings.some((entry) => entry.token.line === binding.line &&
                entry.token.startColumn === binding.startColumn), `${name}: the generated symbol must not become an editor occurrence`);
        }
        const declaration = model.nativeBindings.find((binding) => binding.kind === "declaration" &&
            binding.name.toLowerCase() === "fbc_fb_query_symbol_symbclass");
        assert.ok(declaration, `${name}: ordinary physical symbols must remain available`);
        assert.ok(model.expandedToSource.has(declaration.token.offset), `${name}: ordinary declarations must keep their physical origin`);
    }
});

test("native inventory preserves branch scopes, member ownership, anonymous fields, and access", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-scopes.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/native-scopes.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const lines = text.split("\n");
    const visible = (line) => model.visibleEntries(uri(filePath), line, lines[line].length);
    const branchLines = lines.flatMap((line, index) => line.trim() === "Print branchValue" ? [index] : []);
    const branches = branchLines.map((line) => visible(line).find((entry) => entry.name === "branchValue"));
    assert.deepEqual(branches.map((entry) => entry.nativeSymbol.typeName), ["long", "double"]);
    assert.notEqual(branches[0].compilerSymbolId, branches[1].compilerSymbolId);
    for (const line of branchLines) assert.equal(visible(line).find((entry) => entry.name === "ownValue").nativeSymbol.typeName, "double", "Enclosing locals shadow implicit members inside branches");
    const afterLoop = lines.findIndex((line) => line.trim() === "Print localValue");
    assert.ok(!visible(afterLoop).some((entry) => ["branchValue", "loopValue", "index"].includes(entry.name)));
    const internal = lines.findIndex((line) => line.includes("Print This.protectedValue"));
    const external = lines.findIndex((line) => line.includes("Print instance.publicValue"));
    const members = (line) => model.completeMembers(uri(filePath), line, lines[line].indexOf(".") + 1).map((entry) => entry.name);
    for (const name of ["publicValue", "ownValue", "anonymousLong", "anonymousDouble"]) assert.ok(members(external).includes(name), name);
    assert.ok(members(internal).includes("protectedValue"));
    assert.ok(!members(internal).includes("privateValue"));
    assert.ok(!members(external).some((name) => ["privateValue", "protectedValue"].includes(name)));
    assert.ok(!visible(external).some((entry) => entry.name === "ReadValue"), "An out-of-line method is not a global procedure");
    assert.ok(visible(external).some((entry) => entry.name === "reopenedValue"));
    assert.equal(analysis.scopeGraph.scopes.filter((scope) => scope.kind === "namespace").length, 2);
    assert.ok(model.inner.entries.every((entry) => entry.nativeSymbol), "The native inventory must not inherit guessed declarations");
    const omitted = { ...analysis, scopeGraph: { ...analysis.scopeGraph, declarations: analysis.scopeGraph.declarations.filter((record) => record.name !== "localValue") } };
    const nativeOnly = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/native-inventory-only.bas" }, omitted, [{ uri: uri(filePath), text }]);
    assert.ok(!nativeOnly.inner.entries.some((entry) => entry.name === "localValue"), "Presentation parsing cannot invent missing native declarations");
    assert.deepEqual((await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath })).scopeGraph, analysis.scopeGraph);
});

test("native non-call references preserve selected overloads and final namespace operands", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-reference-forms.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/reference-forms.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const lines = text.split("\n");
    const at = (line, name) => model.resolveAt(uri(filePath), line, lines[line].lastIndexOf(name) + 1)[0];
    const declared = (type) => at(lines.findIndex((line) => line.includes(`Function Pick Overload(ByVal value As ${type})`)), "Pick");
    const long = declared("Long"), double = declared("Double");
    assert.notEqual(long.compilerSymbolId, double.compilerSymbolId);
    for (const [part, target] of [["@Functions.Pick", long], ["ProcPtr(Functions.Pick,", double], ["ProcPtr(Pick)", long]]) {
        const line = lines.findIndex((line) => line.includes(part));
        assert.equal(at(line, "Pick").compilerSymbolId, target.compilerSymbolId, part);
        assert.ok(!analysis.bindings.some((binding) => binding.kind === "call" && analysis.origins[binding.line]?.line === line), "An address is a reference, not a call");
    }
    const results = lines.flatMap((line, index) => line.trim() === "Pick = value" ? [at(index, "Pick")] : []);
    assert.deepEqual(results.map((entry) => entry.compilerSymbolId), [long.compilerSymbolId, double.compilerSymbolId]);
    assert.equal(model.references(long, true).length, 5);
    assert.equal(model.references(double, true).length, 4);
    const imports = lines.findIndex((line) => line.startsWith("Using "));
    assert.equal(at(imports, "Nested").compilerSymbolId, at(lines.indexOf("    Namespace Nested"), "Nested").compilerSymbolId);
});

test("native forward types retain reference identities and refreshed dependent types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-forward-types.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/forward-types.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const named = (name) => model.inner.entries.find((entry) => entry.name === name);
    assert.equal(model.references(named("Node"), true).length, 3);
    assert.equal(model.references(named("Element"), true).length, 2);
    assert.equal(model.references(named("Opaque"), true).length, 3);
    assert.notEqual(named("Node").compilerSymbolId, named("Link").compilerSymbolId);
    assert.equal(model.typeEntries(named("earlyNode"))[0].compilerSymbolId, named("Node").compilerSymbolId);
    assert.match(named("earlyNode").nativeSymbol.typeName, /Node Ptr/i);
    assert.equal(named("FirstPointer").nativeSymbol.typeName.toLowerCase(), "long ptr");
    assert.deepEqual((await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath })).symbolGraph, analysis.symbolGraph);
});

test("native recovery retains authoritative types outside an invalid statement", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const source = "Dim value As Double\nPrint value * 2\nPrint value +\nPrint value * 3\n";
    const options = { compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, source]]) };
    await assert.rejects(analyzeSavedModule(options), /requires valid source/);
    const analysis = await analyzeSavedModule({ ...options, allowErrors: true });
    assert.equal(analysis.partial, true);
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.filePath === filePath && diagnostic.line === 2));
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/recover.bas" }, analysis, [{ uri: uri(filePath), text: source }]);
    for (const line of [1, 3]) {
        const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 15 });
        assert.equal(expression.typeName.toLowerCase(), "double");
        assert.equal(expression.provisional, false);
    }
    const prefix = model.expressionAt(uri(filePath), { line: 2, character: 6 });
    assert.equal(prefix?.typeName.toLowerCase(), "double", "a completed operand before a dangling operator remains typed");
    assert.equal(prefix?.provisional, false);
    assert.deepEqual(model.resolveAt(uri(filePath), 2, 6), []);
});

test("native recovery retains a completed prefix before a same-line syntax error", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const source = "Dim value As Double\nPrint (value * 2) +\nPrint value * 3\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true
    });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    assert.ok(analysis.errorPositions.some((error) => error.sourceFile === filePath && error.sourceLine === 1 && error.code === 9),
        "the compiler trace must identify the failing token on the partial statement");

    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/prefix-recovery.bas" }, analysis, [{ uri: uri(filePath), text: source }]);
    const lines = source.split("\n");
    const prefix = "(value * 2)";
    const prefixStart = lines[1].indexOf(prefix);
    const retained = model.expressionAt(uri(filePath), { line: 1, character: prefixStart }, { line: 1, character: prefixStart + prefix.length });
    assert.equal(retained?.typeName.toLowerCase(), "double");
    assert.equal(retained?.provisional, false);

    const malformed = "(value * 2) +";
    const malformedStart = lines[1].indexOf(malformed);
    assert.equal(model.expressionAt(uri(filePath), { line: 1, character: malformedStart }, { line: 1, character: malformedStart + malformed.length }), null,
        "the expression that includes the unexpected trailing operator remains withheld");

    const later = model.expressionAt(uri(filePath), { line: 2, character: 6 }, { line: 2, character: 15 });
    assert.equal(later?.typeName.toLowerCase(), "double");
    assert.equal(later?.provisional, false);

    const typeMismatch = "Print value + \"text\"";
    const mismatchSource = `Dim value As Double\n${typeMismatch}\nPrint value * 3\n`;
    const mismatch = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, mismatchSource]]),
        allowErrors: true
    });
    assert.ok(mismatch.errorPositions.some((error) => error.code === 20), "the control case must be a semantic type error");
    const mismatchModel = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/mismatch-recovery.bas" }, mismatch, [{ uri: uri(filePath), text: mismatchSource }]);
    const mismatchLine = mismatchSource.split("\n")[1];
    assert.equal(mismatchModel.expressionAt(uri(filePath), { line: 1, character: 6 }), null,
        "a semantic type error does not expose even its otherwise complete left operand");
    assert.equal(mismatchModel.expressionAt(uri(filePath), { line: 1, character: 6 }, { line: 1, character: mismatchLine.length }), null,
        "a type-mismatched operation must not be rescued as a valid completed prefix");
});

test("native SELECT CASE recovery keeps later accepted alternatives authoritative", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-select-case-recovery-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "case-recovery.bas");
    const sidecarPath = path.join(directory, "case-recovery-sidecar.bas");
    const savedSource = "Print 1\n";
    const source = [
        "Dim selector As Integer",
        "Dim afterCase As Double",
        "Select Case selector",
        "Case 1",
        "    Print selector + 1",
        "Case selector +",
        "    Print 0",
        "Case 3",
        "    afterCase = selector + 2",
        "End Select",
        "afterCase = 4.5"
    ].join("\n");
    fs.writeFileSync(filePath, savedSource);
    fs.writeFileSync(sidecarPath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, true);
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    assert.equal(analysis.semanticModelRecovery, true);
    assert.ok(analysis.errorPositions.some((error) => error.sourceFile === filePath && error.sourceLine === 5 && error.code === 9),
        "the missing CASE operand must remain tied to the unsaved source line");

    const sourceUri = uri(filePath);
    const sources = [{ uri: sourceUri, text: source }];
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/select-case-recovery.bas" },
        analysis,
        sources
    );
    const sidecarAnalysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath: sidecarPath,
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        semanticModelOnly: true
    });
    assert.equal(sidecarAnalysis.semanticSidecarOnly, true);
    assert.equal(sidecarAnalysis.partial, true);
    assert.deepEqual(sidecarAnalysis.completion, { errorCount: 1, reachedEnd: true });
    assert.equal(sidecarAnalysis.semanticModelRecovery, true);
    assert.ok(sidecarAnalysis.diagnostics.some((diagnostic) => diagnostic.filePath === sidecarPath && diagnostic.line === 5 && diagnostic.code === 9),
        "the trace-free compiler must report the same broken CASE operand");
    const sidecarUri = uri(sidecarPath);
    const sidecarOnlyModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/select-case-recovery-sidecar.bas" },
        sidecarAnalysis,
        [{ uri: sidecarUri, text: source }]
    );
    const lines = source.split("\n");
    const selection = (line, expression) => {
        const character = lines[line].indexOf(expression);
        assert.ok(character >= 0, `${expression} must remain in source line ${line + 1}`);
        return {
            start: { line, character },
            end: { line, character: character + expression.length }
        };
    };

    const malformed = selection(5, "selector +");
    assert.equal(model.expressionAt(sourceUri, malformed.start, malformed.end), null,
        "the CASE alternative containing the missing operand must stay withheld");
    assert.equal(sidecarOnlyModel.expressionAtCompilerSidecarOnly(sidecarUri, malformed.start, malformed.end), null,
        "the recovery sidecar must not invent a complete malformed alternative");

    const laterCase = selection(7, "3");
    const laterCaseType = model.expressionAt(sourceUri, laterCase.start, laterCase.end);
    assert.equal(laterCaseType?.typeName.toLowerCase(), "integer");
    assert.equal(laterCaseType?.provisional, false,
        "a later accepted CASE alternative remains independent of the malformed predecessor");
    const recoveredCaseType = sidecarOnlyModel.expressionAtCompilerSidecarOnly(sidecarUri, laterCase.start, laterCase.end);
    assert.equal(recoveredCaseType?.typeName.toLowerCase(), "integer");
    assert.equal(recoveredCaseType?.semanticSource, "compiler-sidecar-recovery");
    assert.equal(recoveredCaseType?.provisional, true,
        "a recovery sidecar cannot claim that later facts are complete compiler analysis");

    for (const [line, expression, typeName] of [[8, "selector + 2", "integer"], [10, "4.5", "double"]]) {
        const range = selection(line, expression);
        const typed = model.expressionAt(sourceUri, range.start, range.end);
        assert.equal(typed?.typeName.toLowerCase(), typeName, expression);
        assert.equal(typed?.provisional, false, expression);
        const recovered = sidecarOnlyModel.expressionAtCompilerSidecarOnly(sidecarUri, range.start, range.end);
        assert.equal(recovered?.typeName.toLowerCase(), typeName, expression);
        assert.equal(recovered?.provisional, true, expression);
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), savedSource,
        "native CASE recovery must leave the saved source untouched");
    assert.equal(fs.readFileSync(sidecarPath, "utf8"), source,
        "trace-free sidecar recovery must leave its saved source untouched");
});

test("native SELECT CASE recovery keeps unsaved-header facts isolated and rejects stale sidecar input", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-select-case-header-recovery-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const headerPath = path.join(directory, "case-recovery.bi");
    const rootSource = '#include once "case-recovery.bi"\nDim rootValue As Double\nrootValue = 4.5\n';
    const savedHeader = "Dim savedHeaderValue As Long\n";
    const headerSource = [
        "Dim selector As Integer",
        "Select Case selector",
        "Case 1",
        "    Print selector + 1",
        "Case selector +",
        "    Print 0",
        "Case 3",
        "    Dim headerValue As Double",
        "    headerValue = selector + 2",
        "End Select"
    ].join("\n");
    fs.writeFileSync(filePath, rootSource);
    fs.writeFileSync(headerPath, savedHeader);
    const overlays = new Map([[filePath, rootSource], [headerPath, headerSource]]);
    const options = {
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", directory],
        overlays,
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    };
    const analysis = await analyzeSavedModule(options);
    assert.equal(analysis.partial, true);
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    assert.ok(analysis.errorPositions.some((error) => error.sourceFile === headerPath && error.sourceLine === 4 && error.code === 9),
        "the parser error must keep the physical unsaved-header path and line");
    assert.ok(analysis.dependencies.includes(headerPath));

    const sources = analysis.dependencies.filter((dependency) => fs.existsSync(dependency)).map((dependency) => ({
        uri: uri(dependency),
        text: overlays.get(dependency) || decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
    }));
    const sourceFor = (file) => sources.find((source) => source.uri.fsPath === file);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/select-case-header-recovery.bas" },
        analysis,
        sources
    );
    const headerDocument = sourceFor(headerPath);
    const rootDocument = sourceFor(filePath);
    assert.ok(headerDocument);
    assert.ok(rootDocument);
    const headerLines = headerSource.split("\n");
    const headerRange = (line, text) => {
        const character = headerLines[line].indexOf(text);
        assert.ok(character >= 0, `${text} must remain in header line ${line + 1}`);
        return { start: { line, character }, end: { line, character: character + text.length } };
    };

    const malformed = headerRange(4, "selector +");
    assert.equal(model.expressionAt(headerDocument.uri, malformed.start, malformed.end), null,
        "the malformed alternative in the unsaved header must stay withheld");
    const laterCase = headerRange(6, "3");
    const laterCaseType = model.expressionAt(headerDocument.uri, laterCase.start, laterCase.end);
    assert.equal(laterCaseType?.typeName.toLowerCase(), "integer");
    assert.equal(laterCaseType?.provisional, false,
        "a later CASE alternative in the same included file remains authoritative");
    const laterBody = headerRange(8, "selector + 2");
    const laterBodyType = model.expressionAt(headerDocument.uri, laterBody.start, laterBody.end);
    assert.equal(laterBodyType?.typeName.toLowerCase(), "integer");
    assert.equal(laterBodyType?.provisional, false);
    const rootLine = rootSource.split("\n")[2];
    const rootType = model.expressionAt(rootDocument.uri,
        { line: 2, character: rootLine.indexOf("4.5") },
        { line: 2, character: rootLine.indexOf("4.5") + 3 });
    assert.equal(rootType?.typeName.toLowerCase(), "double");
    assert.equal(rootType?.provisional, false,
        "recovery in an unsaved include must not taint a separate root expression");

    await assert.rejects(analyzeSavedModule({ ...options, semanticModelOnly: true }),
        /(?:changed buffer .*requires the editor bridge for unsaved analysis|Compiler location source changed after semantic analysis)/);
    assert.equal(fs.readFileSync(filePath, "utf8"), rootSource);
    assert.equal(fs.readFileSync(headerPath, "utf8"), savedHeader);
});

test("native binary operator recovery retains later independent expression types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const operators = ["+", "-", "*", "/", "\\", "Mod", "^", "&", "And", "Or", "Xor", "Eqv", "Imp", "Shl", "Shr", "=", ">", "<", "<>", "<=", ">=", "AndAlso", "OrElse", "Is"];

    for (const operator of operators) {
        const source = `Dim value As Double\nPrint value * 2\nPrint value ${operator}\nPrint value * 3\n`;
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, source]]), allowErrors: true });
        assert.ok(analysis.completion.errorCount > 0, operator);
        assert.equal(analysis.completion.reachedEnd, true, operator);

        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/binary-operator-recovery.bas" }, analysis, [{ uri: uri(filePath), text: source }]);
        const line = source.split("\n").indexOf("Print value * 3");
        const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 15 });
        assert.equal(expression?.typeName.toLowerCase(), "double", operator);
        assert.equal(expression.provisional, false, operator);
    }
});

test("native recovery marks declarations and expressions that depend on a retracted type", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const source = [
        "Type BrokenType",
        "    value As Long",
        "    Declare Function Value() As Long",
        "End Type",
        "Function BrokenType.Value() As Long",
        "    Value = value +",
        "End Function",
        "Dim item As BrokenType",
        "Print item.value"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, source]]), allowErrors: true });
    assert.ok(analysis.partial);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/recovery-provenance.bas" }, analysis, [{ uri: uri(filePath), text: source }]);
    const item = model.resolveAt(uri(filePath), 7, 4)[0];
    assert.ok(item?.compilerSymbolId);
    assert.ok(analysis.recoverySymbols.includes(item.compilerSymbolId), "A variable with a retracted UDT subtype must not look authoritative.");
    assert.equal(item.provisional, true);
    for (const [line, character] of [[8, 6], [8, 11]]) {
        const expression = model.expressionAt(uri(filePath), { line, character });
        assert.ok(expression?.compilerExpressionId);
        assert.equal(expression.provisional, true);
    }
});

test("native recovery confines provisional state to uses of a malformed aggregate", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const original = fs.readFileSync(filePath, "utf8");
    const source = [
        "Type RecoverableRecord",
        "    known As Double",
        "    broken As Double =",
        "End Type",
        "Dim item As RecoverableRecord",
        "Print item.known * 2",
        "Dim stable As Double",
        "Print stable * 3",
        ""
    ].join("\n");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    assert.equal(analysis.partial, true);

    const declaration = (name) => analysis.scopeGraph.declarations.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    assert.equal(declaration("RecoverableRecord")?.invalid, true);
    assert.equal(declaration("known")?.invalid, true);
    assert.equal(declaration("broken")?.invalid, true);
    assert.equal(declaration("stable")?.invalid, false);

    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/malformed-aggregate-recovery.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const item = model.resolveAt(sourceUri, 4, 4)[0];
    assert.equal(item?.name.toLowerCase(), "item");
    assert.ok(analysis.recoverySymbols.includes(item.compilerSymbolId));
    assert.equal(item.provisional, true);

    const dependent = model.expressionAt(sourceUri, { line: 5, character: 6 }, { line: 5, character: 20 });
    assert.equal(dependent?.typeName.toLowerCase(), "double");
    assert.equal(dependent?.provisional, true,
        "a use of the malformed aggregate must retain its compiler type but remain provisional");
    const independent = model.expressionAt(sourceUri, { line: 7, character: 6 }, { line: 7, character: 16 });
    assert.equal(independent?.typeName.toLowerCase(), "double");
    assert.equal(independent?.provisional, false,
        "an unrelated later declaration and expression must remain authoritative");
    assert.equal(fs.readFileSync(filePath, "utf8"), original,
        "aggregate recovery analysis must not modify the saved source");
});

test("native recovery combines a malformed member declaration with an incomplete namespace", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const original = fs.readFileSync(filePath, "utf8");
    const source = [
        "Dim stable As Double = 5",
        "Print stable * 2",
        "Namespace PartialNamespace",
        "    Type RecoverableRecord",
        "        known As Double",
        "        broken As Double =",
        "    End Type",
        "    Function laterValue() As Double",
        "        Dim item As RecoverableRecord",
        "        Return item.known + 2.0",
        "    End Function",
        ""
    ].join("\n");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.ok(analysis.completion.errorCount > 0);
    assert.equal(analysis.completion.reachedEnd, true);
    assert.equal(analysis.semanticModelRecovery, true);
    assert.equal(analysis.scopeGraph.scopes.find((scope) => scope.kind === "namespace")?.recovered, true);

    const declaration = (name) => analysis.scopeGraph.declarations.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    assert.equal(declaration("RecoverableRecord")?.invalid, true);
    assert.equal(declaration("known")?.invalid, true);
    assert.equal(declaration("broken")?.invalid, true);
    assert.equal(declaration("stable")?.invalid, false);

    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/broken-member-in-recovered-namespace.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const lines = source.split("\n");
    const expression = (line, text) => {
        const start = lines[line].indexOf(text);
        assert.ok(start >= 0, `missing expression text on line ${line + 1}`);
        return model.expressionAt(sourceUri, { line, character: start }, { line, character: start + text.length });
    };
    const stable = expression(1, "stable * 2");
    assert.equal(stable?.typeName.toLowerCase(), "double");
    assert.equal(stable?.provisional, false,
        "an error in a later aggregate must not taint an earlier module expression");
    const nestedReturn = expression(9, "item.known + 2.0");
    assert.equal(nestedReturn?.typeName.toLowerCase(), "double");
    assert.equal(nestedReturn?.provisional, true,
        "a member expression depending on the malformed aggregate remains provisional");
    assert.equal(fs.readFileSync(filePath, "utf8"), original,
        "combined recovery analysis must leave the saved source unchanged");
});

test("native recovery propagates provisional symbol dependencies into typed expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const source = [
        "Function Pending() As Double",
        "    If 1 Then",
        "        Dim localValue As Double",
        "        Return localValue + 2.0",
        "    End Function"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticModelRecovery, true);
    assert.ok(analysis.scopeGraph.scopes.some((scope) => scope.kind === "procedure" && scope.recovered));

    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/recovered-procedure-expression.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const line = source.split("\n").findIndex((text) => text.includes("Return localValue"));
    const statement = source.split("\n")[line];
    const dependent = "localValue + 2.0";
    const dependentStart = statement.indexOf(dependent);
    const sidecarFact = analysis.semanticExpressions.find((fact) => fact.physical && fact.filePath === filePath &&
        fact.startLine === line + 1 && fact.startColumn === dependentStart &&
        fact.endLine === line + 1 && fact.endColumn === dependentStart + dependent.length);
    assert.equal(sidecarFact?.typeName.toLowerCase(), "double");
    assert.equal(sidecarFact?.recovery, true,
        "the compiler semantic sidecar must identify the expression as part of a recovered module");
    const dependentExpression = model.expressionAt(
        sourceUri,
        { line, character: dependentStart },
        { line, character: dependentStart + dependent.length }
    );
    assert.equal(dependentExpression?.typeName.toLowerCase(), "double");
    assert.equal(dependentExpression?.provisional, true,
        "a compiler-selected local reference owned by a recovered procedure makes its enclosing expression provisional");

    const literal = "2.0";
    const literalStart = statement.indexOf(literal);
    const literalExpression = model.expressionAt(
        sourceUri,
        { line, character: literalStart },
        { line, character: literalStart + literal.length }
    );
    assert.equal(literalExpression?.typeName.toLowerCase(), "double");
    assert.equal(literalExpression?.provisional, false,
        "an independent literal range must not inherit an adjacent recovered symbol's uncertainty");
});

test("native structural recovery marks incomplete containers, procedures, and control scopes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    for (const { label, kind, source } of [
        { label: "missing TYPE terminator", kind: "type", source: "Type PendingType\n    member As Long\n" },
        { label: "wrong TYPE terminator", kind: "type", source: "Type PendingType\n    member As Long\nEnd Union\n" },
        { label: "missing ENUM terminator", kind: "enum", source: "Enum PendingEnum\n    Member\n" },
        { label: "wrong ENUM terminator", kind: "enum", source: "Enum PendingEnum\n    Member\nEnd Type\n" },
        { label: "missing UNION terminator", kind: "union", source: "Type PendingType\n    Union\n    member As Long\n" },
        { label: "missing NAMESPACE terminator", kind: "namespace", source: "Namespace PendingNamespace\nDim member As Long\n" },
        { label: "missing procedure terminator", kind: "procedure", source: "Function PendingFunction() As Long\n    Dim member As Long\n    Return 1\n" },
        { label: "missing IF terminator", kind: "scope", source: "If 1 Then\n    Dim member As Long\n" },
        { label: "missing SELECT terminator", kind: "scope", source: "Select Case 1\nCase 1\n    Dim member As Long\n" },
        { label: "missing FOR terminator", kind: "scope", source: "For index As Integer = 0 To 1\n    Dim member As Long\n" },
        { label: "missing DO terminator", kind: "scope", source: "Do\n    Dim member As Long\n" },
        { label: "missing WHILE terminator", kind: "scope", source: "While 1\n    Dim member As Long\n" },
        { label: "missing WITH terminator", kind: "scope", source: "Type PendingWithType\n    amount As Long\nEnd Type\nDim instance As PendingWithType\nWith instance\n    Dim member As Long\n" }
    ]) {
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, source]]), allowErrors: true });
        assert.ok(analysis.partial, label);
        const scope = analysis.scopeGraph.scopes.find((entry) => entry.kind === kind);
        assert.equal(scope?.recovered, true, label);
        /* The enclosing declaration is in the parser's invalid region and is
           intentionally withheld from presentation. Its native identity must
           still taint dependent facts if later recovery retains any of them. */
        assert.ok(analysis.recoverySymbols.includes(scope.symbol), label);
    }

    const namespaceSource = "Namespace PendingNamespace\nDim member As Long\n";
    const namespaceAnalysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, namespaceSource]]),
        allowErrors: true
    });
    const namespaceModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/recovered-namespace.bas" },
        namespaceAnalysis,
        [{ uri: uri(filePath), text: namespaceSource }]
    );
    const member = namespaceModel.resolveAt(uri(filePath), 1, 4)[0];
    assert.equal(member?.name.toLowerCase(), "member");
    assert.equal(member?.provisional, true,
        "a declaration inside an unterminated namespace must not appear authoritative");
});

test("native mixed parser and structural recovery keeps later expression types provisional", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const cases = [
        {
            label: "incomplete procedure",
            scopeKind: "procedure",
            source: "Function PendingFunction() As Double\n    Dim value As Double\n    Dim broken As Double =\n    Return value * 2\n"
        },
        {
            label: "incomplete IF inside a procedure",
            scopeKind: "scope",
            source: "Sub Pending()\n    Dim value As Double\n    If value Then\n        Dim broken As Double =\n        Print value * 2\n"
        },
        {
            label: "incomplete namespace containing a procedure",
            scopeKind: "namespace",
            source: "Namespace Pending\nFunction Stable() As Double\n    Dim value As Double\n    Dim broken As Double =\n    Return value * 2\nEnd Function\n"
        }
    ];

    for (const { label, scopeKind, source } of cases) {
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            overlays: new Map([[filePath, source]]),
            allowErrors: true,
            exportSemanticExpressions: true,
            requireSemanticModel: true
        });
        assert.equal(analysis.completion.reachedEnd, true, label);
        assert.equal(analysis.completion.errorCount, 2, label);
        assert.equal(analysis.semanticModelRecovery, true, label);
        assert.equal(analysis.scopeGraph.scopes.find((scope) => scope.kind === scopeKind)?.recovered, true, label);

        const sourceUri = uri(filePath);
        const expandedUri = { toString: () => `freebasic-preprocessed:/mixed-recovery-${scopeKind}.bas` };
        const traceModel = new CompilerSemanticModel(expandedUri, analysis, [{ uri: sourceUri, text: source }]);
        const sidecarModel = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/mixed-recovery-sidecar-${scopeKind}.bas` },
            { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
            [{ uri: sourceUri, text: source }]
        );
        const lines = source.split("\n");
        const expressionLine = lines.findIndex((line) => line.includes("value * 2"));
        const expressionStart = lines[expressionLine].indexOf("value * 2");
        const start = { line: expressionLine, character: expressionStart };
        const end = { line: expressionLine, character: expressionStart + "value * 2".length };
        const traced = traceModel.expressionAt(sourceUri, start, end);
        const recovered = sidecarModel.expressionAtCompilerSidecarOnly(sourceUri, start, end);
        assert.equal(traced?.typeName.toLowerCase(), "double", label);
        assert.equal(traced?.provisional, true, label);
        assert.equal(recovered?.semanticSource, "compiler-sidecar-recovery", label);
        assert.equal(recovered?.typeName.toLowerCase(), "double", label);
        assert.equal(recovered?.provisional, true, label);

        const brokenLine = lines.findIndex((line) => line.includes("Dim broken"));
        const brokenStart = lines[brokenLine].indexOf("broken");
        const brokenEnd = lines[brokenLine].length;
        assert.equal(traceModel.expressionAt(
            sourceUri,
            { line: brokenLine, character: brokenStart },
            { line: brokenLine, character: brokenEnd }
        ), null, `${label}: the malformed initializer stays untyped in the trace model`);
        assert.equal(sidecarModel.expressionAtCompilerSidecarOnly(
            sourceUri,
            { line: brokenLine, character: brokenStart },
            { line: brokenLine, character: brokenEnd }
        ), null, `${label}: the malformed initializer stays untyped in the sidecar`);
    }
});

test("native recovery keeps accepted ELSEIF and ELSE branches after a malformed condition", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const original = fs.readFileSync(filePath, "utf8");
    const source = [
        "Function RecoveredIf() As Double",
        "    Dim value As Double",
        "    If value Then",
        "        Print value * 2",
        "    ElseIf value +",
        "        Print value * 3",
        "    Else",
        "        Print value * 4",
        "    End If",
        "    Return value * 5",
        "End Function",
        "Print 1.5"
    ].join("\n");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    assert.equal(analysis.semanticModelRecovery, true);
    assert.ok(analysis.errorPositions.some((error) => error.sourceFile === filePath && error.sourceLine === 4 && error.code === 9),
        "the incomplete ELSEIF condition must remain anchored to its source line");

    const sourceUri = uri(filePath);
    const sources = [{ uri: sourceUri, text: source }];
    const traceModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/elseif-recovery.bas" },
        analysis,
        sources
    );
    const sidecarModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/elseif-recovery-sidecar.bas" },
        { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
        sources
    );
    const lines = source.split("\n");
    const expression = (model, line, text) => {
        const character = lines[line].indexOf(text);
        assert.ok(character >= 0, `${text} must remain in source line ${line + 1}`);
        return model.expressionAt(sourceUri, { line, character }, { line, character: character + text.length });
    };

    assert.equal(expression(traceModel, 4, "value +"), null,
        "the malformed ELSEIF condition must not be presented as a complete expression");
    for (const [line, text] of [[3, "value * 2"], [5, "value * 3"], [7, "value * 4"], [9, "value * 5"], [11, "1.5"]]) {
        const traced = expression(traceModel, line, text);
        assert.equal(traced?.typeName.toLowerCase(), "double", text);
        assert.equal(traced?.provisional, false, text);

        const recovered = expression(sidecarModel, line, text);
        assert.equal(recovered?.typeName.toLowerCase(), "double", text);
        assert.equal(recovered?.semanticSource, "compiler-sidecar-recovery", text);
        assert.equal(recovered?.provisional, true, text);
    }
    assert.equal(expression(sidecarModel, 4, "value +"), null,
        "the recovery sidecar must also withhold the incomplete condition");
    assert.equal(fs.readFileSync(filePath, "utf8"), original,
        "recovery analysis must leave the saved compiler fixture unchanged");
});

test("compiler errors in an enum member preserve later expression typing", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const source = [
        "Enum RecoveredState Explicit",
        "    First = 1",
        "    Second = Cast(Long,",
        "End Enum",
        "Print 1.5 * 2.0"
    ].join("\n");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, true);
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });

    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/enum-recovery.bas" },
        analysis,
        [{ uri: uri(filePath), text: source }]
    );
    const expression = model.expressionAt(uri(filePath), { line: 4, character: 6 }, { line: 4, character: 15 });
    assert.equal(expression?.typeName.toLowerCase(), "double");
    assert.equal(expression?.provisional, false,
        "an error in one enum member must not make an independent later expression provisional");
});

test("native reference and dispatch errors retain authoritative independent expression types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const original = fs.readFileSync(filePath, "utf8");
    for (const invalid of [
        "Declare Virtual Sub Outside()",
        "Type BaseType Extends Object\nDeclare Virtual Function Pick(ByVal value As ) As Long\nEnd Type",
        "Type PtrAlias As MissingType\nDim item As PtrAlias\nPrint item.missing",
        "Using MissingNamespace",
        "Function Pick(ByVal value As Long) As Long\nPick =\nEnd Function",
        "Print Point(0, )"
    ]) {
        const text = `Dim value As Double\nPrint value * 2\n${invalid}\nPrint value * 3\n`;
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), allowErrors: true });
        assert.ok(analysis.completion.errorCount > 0, invalid);
        assert.equal(analysis.completion.reachedEnd, true);
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/reference-errors.bas" }, analysis, [{ uri: uri(filePath), text }]);
        for (const line of [1, text.trimEnd().split("\n").length - 1]) {
            const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 15 });
            assert.equal(expression?.typeName.toLowerCase(), "double", invalid);
            assert.equal(expression.provisional, false);
        }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("native type-layout parser recovery retains later independent expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    for (const invalid of ["Print Len(", "Print SizeOf(", "Print SizeOf(MissingType)", "Print SizeOf()", "Print SizeOf(MissingType"]) {
        const text = `Dim value As Double\nPrint value * 2\n${invalid}\nPrint value * 3\n`;
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), allowErrors: true });
        assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true }, invalid);
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/type-layout-recovery.bas" }, analysis, [{ uri: uri(filePath), text }]);
        for (const line of [1, 3]) {
            const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 15 });
            assert.equal(expression?.typeName.toLowerCase(), "double", invalid);
            assert.equal(expression.provisional, false, invalid);
        }
    }
    const declarationText = "Dim value As Double\nPrint value * 2\nDim typed As TypeOf(value) =\nPrint value * 3\n";
    const declarationAnalysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, declarationText]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.deepEqual(declarationAnalysis.completion, { errorCount: 1, reachedEnd: true });
    assert.equal(declarationAnalysis.semanticModelRecovery, true);
    const declarationModel = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/typeof-recovery.bas" }, declarationAnalysis, [{ uri: uri(filePath), text: declarationText }]);
    const declarationSidecarOnly = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/typeof-recovery-sidecar-only.bas" },
        { ...declarationAnalysis, expressions: [], expressionGraph: { nodes: [] } },
        [{ uri: uri(filePath), text: declarationText }]
    );
    const retained = declarationModel.expressionAt(uri(filePath), { line: 3, character: 6 }, { line: 3, character: 15 });
    assert.equal(retained?.typeName.toLowerCase(), "double", "An incomplete declaration TYPEOF() must not consume the following statement.");
    assert.equal(retained.provisional, false);
    const declarationLines = declarationText.split("\n");
    for (const [line, written] of [[1, "value * 2"], [3, "value * 3"]]) {
        const character = declarationLines[line].indexOf(written);
        const start = { line, character };
        const end = { line, character: character + written.length };
        assert.equal(declarationSidecarOnly.expressionAtTraceOnly(uri(filePath), start, end), null);
        const answer = declarationSidecarOnly.expressionAtCompilerSidecarOnly(uri(filePath), start, end);
        assert.equal(answer?.semanticSource, "compiler-sidecar-recovery");
        assert.equal(answer?.typeName.toLowerCase(), "double");
        assert.equal(answer?.provisional, true);
    }
    const temporaryTypeOfStart = declarationLines[2].lastIndexOf("value");
    assert.ok(declarationAnalysis.semanticExpressions.some((fact) => fact.recovery && fact.physical &&
        fact.startLine === 3 && fact.startColumn === temporaryTypeOfStart && fact.endColumn === temporaryTypeOfStart + "value".length),
    "The failed declaration must demonstrate that TYPEOF created a temporary physical expression fact.");
    assert.equal(declarationSidecarOnly.expressionAtCompilerSidecarOnly(
        uri(filePath),
        { line: 2, character: temporaryTypeOfStart },
        { line: 2, character: temporaryTypeOfStart + "value".length }
    ), null, "A TYPEOF operand from a failed declaration must not escape as a sidecar-only type answer.");

    const openDeclarationText = "Dim value As Double\nPrint value * 2\nDim typed As TypeOf(\nPrint value * 3\n";
    const openDeclarationAnalysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, openDeclarationText]]),
        allowErrors: true
    });
    assert.deepEqual(openDeclarationAnalysis.completion, { errorCount: 1, reachedEnd: true });
    const openDeclarationModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/typeof-open-recovery.bas" },
        openDeclarationAnalysis,
        [{ uri: uri(filePath), text: openDeclarationText }]
    );
    const afterOpenTypeOf = openDeclarationModel.expressionAt(uri(filePath), { line: 3, character: 6 }, { line: 3, character: 15 });
    assert.equal(afterOpenTypeOf?.typeName.toLowerCase(), "double");
    assert.equal(afterOpenTypeOf.provisional, false,
        "An incomplete declaration TYPEOF() must not consume the following statement.");
});

test("native declaration recovery withholds temporary LEN and SIZEOF expression facts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const original = fs.readFileSync(filePath, "utf8");
    for (const [name, expression] of [["LEN", "Len(value)"], ["SIZEOF", "SizeOf(value)"]]) {
        const text = `Dim value As String * 4\nPrint 1.0 * 2\nDim broken As String * ${expression} =\nPrint 1.0 * 3\n`;
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            overlays: new Map([[filePath, text]]),
            allowErrors: true,
            exportSemanticExpressions: true,
            requireSemanticModel: true
        });
        assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true }, name);
        assert.equal(analysis.semanticModelRecovery, true, name);

        const sourceUri = uri(filePath);
        const sidecarOnly = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/invalid-${name.toLowerCase()}-declaration.bas` },
            { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
            [{ uri: sourceUri, text }]
        );
        const lines = text.split("\n");
        for (const [line, written] of [[1, "1.0 * 2"], [3, "1.0 * 3"]]) {
            const character = lines[line].indexOf(written);
            const start = { line, character };
            const end = { line, character: character + written.length };
            assert.equal(sidecarOnly.expressionAtTraceOnly(sourceUri, start, end), null, `${name}: ${written}`);
            const answer = sidecarOnly.expressionAtCompilerSidecarOnly(sourceUri, start, end);
            assert.equal(answer?.semanticSource, "compiler-sidecar-recovery", `${name}: ${written}`);
            assert.equal(answer?.typeName.toLowerCase(), "double", `${name}: ${written}`);
            assert.equal(answer?.provisional, true, `${name}: ${written}`);
        }

        const declarationLine = lines[2];
        const expressionColumn = declarationLine.indexOf(expression);
        const expressionFact = analysis.semanticExpressions.find((fact) => fact.recovery && fact.physical &&
            fact.startLine === 3 && fact.startColumn === expressionColumn && fact.endColumn === expressionColumn + expression.length);
        assert.ok(expressionFact, `${name} must demonstrate a completed temporary expression fact on the failed declaration`);
        assert.equal(expressionFact.typeName.toLowerCase(), "integer", `${name} result type`);
        assert.equal(sidecarOnly.expressionAtCompilerSidecarOnly(
            sourceUri,
            { line: 2, character: expressionColumn },
            { line: 2, character: expressionColumn + expression.length }
        ), null, `${name} temporary expression from the failed declaration must stay unavailable`);
        const operandColumn = declarationLine.lastIndexOf("value");
        assert.ok(analysis.semanticExpressions.some((fact) => fact.recovery && fact.physical &&
            fact.startLine === 3 && fact.startColumn === operandColumn && fact.endColumn === operandColumn + "value".length),
        `${name} must also demonstrate the temporary type-layout operand fact`);
        assert.equal(sidecarOnly.expressionAtCompilerSidecarOnly(
            sourceUri,
            { line: 2, character: operandColumn },
            { line: 2, character: operandColumn + "value".length }
        ), null, `${name} temporary operand from the failed declaration must stay unavailable`);
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("native PEEK recovery retains later independent expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const text = "Dim value As Double\nPrint value * 2\nPrint Peek(\nPrint value * 3\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), allowErrors: true });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/peek-recovery.bas" }, analysis, [{ uri: uri(filePath), text }]);
    for (const line of [1, 3]) {
        const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 15 });
        assert.equal(expression?.typeName.toLowerCase(), "double");
        assert.equal(expression.provisional, false);
    }
});

test("native delimiter recovery retains later expressions across allocation, conversion, and quirk parsers", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    for (const invalid of [
        "Print New (", "Print New Long[", "Delete[", "Print CPtr(",
        "Print IIf(", "Print Mid(", "Print Instr(", "Print Line Input(",
        "Print Open(", "Print Cva_arg(", "Print *(", "Print Cast(",
        "Print Abs(", "Print Sin(", "Print Sgn(", "Print Str(",
        "Print Chr(", "Print LCase(", "Print LBound(", "Print UBound(",
        "Print CInt(", "Print Err(", "Print FreeFile(", "Print Point(",
        "Print Screen(", "Print Command(", "Print Environ(", "Print Dir(",
        "Print Timer("
    ]) {
        const text = `Dim value As Double\nPrint value * 2\n${invalid}\nPrint value * 3\n`;
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), allowErrors: true });
        assert.ok(analysis.completion.errorCount > 0, invalid);
        assert.equal(analysis.completion.reachedEnd, true, invalid);
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/delimiter-recovery.bas" }, analysis, [{ uri: uri(filePath), text }]);
        const expression = model.expressionAt(uri(filePath), { line: 3, character: 6 }, { line: 3, character: 15 });
        assert.equal(expression?.typeName.toLowerCase(), "double", invalid);
        assert.equal(expression.provisional, false, invalid);
    }
});

test("native macro argument recovery retains later independent expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    for (const [label, definition, call] of [
        ["intrinsic", "", "RGB"],
        ["source", "#define REQUIRED_VALUE(value) value\n", "REQUIRED_VALUE"]
    ]) {
        const text = definition + "Dim value As Double\nPrint value * 2\nPrint " + call + "(\nPrint value * 3\n";
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), allowErrors: true });
        assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true }, label);
        const model = new CompilerSemanticModel({ toString: () => `freebasic-preprocessed:/macro-${label}-recovery.bas` }, analysis, [{ uri: uri(filePath), text }]);
        const laterLine = text.split("\n").indexOf("Print value * 3");
        const expression = model.expressionAt(uri(filePath), { line: laterLine, character: 6 }, { line: laterLine, character: 15 });
        assert.equal(expression?.typeName.toLowerCase(), "double", label);
        assert.equal(expression.provisional, false, label);
    }
    const continued = "Dim value As Double\nPrint RGB( _\n    1, 2, 3)\nPrint value * 3\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, continued]]), allowErrors: true });
    assert.deepEqual(analysis.completion, { errorCount: 0, reachedEnd: true });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/macro-continuation.bas" }, analysis, [{ uri: uri(filePath), text: continued }]);
    const expression = model.expressionAt(uri(filePath), { line: 3, character: 6 }, { line: 3, character: 15 });
    assert.equal(expression?.typeName.toLowerCase(), "double");
    assert.equal(expression.provisional, false);
});

test("native PROCPTR recovery retains later independent expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const text = "Dim value As Double\nPrint value * 2\nPrint ProcPtr(\nPrint value * 3\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), allowErrors: true });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/procptr-recovery.bas" }, analysis, [{ uri: uri(filePath), text }]);
    for (const line of [1, 3]) {
        const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 15 });
        assert.equal(expression?.typeName.toLowerCase(), "double");
        assert.equal(expression.provisional, false);
    }
});

test("native procedure-argument recovery retains later independent expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const text = "Function ReadValue(ByVal amount As Double) As Double\n Return amount\nEnd Function\nDim value As Double\nPrint value * 2\nPrint ReadValue(\nPrint value * 3\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), allowErrors: true });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/procedure-argument-recovery.bas" }, analysis, [{ uri: uri(filePath), text }]);
    for (const line of [4, 6]) {
        const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 15 });
        assert.equal(expression?.typeName.toLowerCase(), "double");
        assert.equal(expression.provisional, false);
    }
});

test("native recovery sidecar keeps interleaved multi-error ranges safe", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const savedSource = fs.readFileSync(filePath, "utf8");
    const text = [
        "Dim recoveryValue As Double",
        "Print recoveryValue * 1",
        "Print recoveryValue +",
        "Print recoveryValue * 2",
        "Print Peek(",
        "Print recoveryValue * 3",
        "Print recoveryValue * 4",
        ""
    ].join("\n");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, text]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.deepEqual(analysis.completion, { errorCount: 2, reachedEnd: true });
    assert.equal(analysis.semanticModelRecovery, true);

    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/interleaved-recovery-errors.bas" },
        { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
        [{ uri: uri(filePath), text }]
    );
    for (const line of [1, 3, 5, 6]) {
        const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: text.split("\n")[line].length });
        assert.equal(expression?.semanticSource, "compiler-sidecar-recovery", `safe expression after error line ${line}`);
        assert.equal(expression?.typeName.toLowerCase(), "double", `safe expression after error line ${line}`);
        assert.equal(expression?.provisional, true, `recovered result after error line ${line}`);
    }
    for (const line of [2, 4]) {
        const sourceLine = text.split("\n")[line];
        const malformed = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: sourceLine.length });
        assert.equal(malformed, null, `damaged parser input on line ${line} must not receive a type`);
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), savedSource, "Analysis must leave the saved compiler fixture unchanged");
});

test("native recovery distinguishes error-limit stops from a parsed EOF", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const prefix = "Dim value As Double\nPrint value * 2\n";
    for (const [tail, reachedEnd] of [["If value Then\nPrint value * 3\n", true], [Array.from({ length: 60 }, (_, index) => `Print missing${index} +`).join("\n"), false], ["Print value +", true]]) {
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, prefix + tail]]), allowErrors: true });
        assert.equal(analysis.completion.reachedEnd, reachedEnd);
        assert.equal(analysis.partial, true);
        assert.ok(analysis.expressions.some((expression) => analysis.origins[expression.start.line]?.line === 1));
        if (!reachedEnd) assert.equal(analysis.completion.errorCount, 50);
    }
});

test("native recovery reports unsaved include errors at logical source paths", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const header = path.join(path.dirname(filePath), "buffer-recovery.bi");
    const source = '#include "buffer-recovery.bi"\nPrint known * 2\n';
    const headerText = "Dim known As Double\nPrint known +\nPrint known * 3\n";
    const overlays = new Map([[filePath, source], [header, headerText]]);
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        allowErrors: true
    });
    assert.equal(analysis.partial, true);
    assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.filePath === header && diagnostic.line === 1));
    assert.ok(analysis.expressions.some((expression) => analysis.origins[expression.start.line]?.filePath === filePath));
    assert.equal(fs.existsSync(header), false);

    const headerUri = uri(header);
    const sources = analysis.dependencies.map((dependency) => ({
        uri: uri(dependency),
        text: overlays.has(dependency) ? overlays.get(dependency) : fs.readFileSync(dependency, "utf8")
    }));
    const sidecarOnly = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/unsaved-header-recovery.bas" },
        { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
        sources
    );
    const malformed = sidecarOnly.expressionAt(headerUri, { line: 1, character: 0 }, { line: 1, character: 13 });
    assert.equal(malformed, null, "the damaged unsaved-header line must not keep a parser-recovery type");
    const later = sidecarOnly.expressionAt(headerUri, { line: 2, character: 6 }, { line: 2, character: 15 });
    assert.equal(later?.semanticSource, "compiler-sidecar-recovery");
    assert.equal(later?.typeName.toLowerCase(), "double");
    assert.equal(later?.provisional, true);
});

test("native incomplete includes retain later unsaved expression types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const source = "Dim value As Double\nPrint value * 2\n#include \nPrint value * 3\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, source]]), allowErrors: true });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.filePath === filePath && diagnostic.line === 2));
    assert.ok(analysis.origins.some((origin) => origin?.filePath === filePath && origin.line === 3));
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/incomplete-include.bas" }, analysis, [{ uri: uri(filePath), text: source }]);
    const expression = model.expressionAt(uri(filePath), { line: 3, character: 6 }, { line: 3, character: 15 });
    assert.equal(expression?.typeName.toLowerCase(), "double");
    assert.equal(expression.provisional, false);
});

test("numeric and named labels retain direct, GOSUB/RETURN, ON, IF, and RESTORE identities for native navigation", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = "10 Print 1\nGoto 10\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), compilerArguments: ["-lang", "qb"] });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/numeric-label.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const declaration = model.resolveAt(uri(filePath), 0, 0)[0];
    const reference = model.resolveAt(uri(filePath), 1, 6)[0];
    assert.equal(declaration?.declaration.type, "label");
    assert.equal(reference?.compilerSymbolId, declaration.compilerSymbolId);
    assert.deepEqual(model.references(declaration, true, { isCancellationRequested: false }).map((entry) => entry.occurrence.line), [0, 1]);
    const tokens = queryCompilerModel(model, "semanticTokens", { uri: { scheme: "file", fsPath: filePath }, position: { line: 0, character: 0 } }, () => {});
    const repeatedTokens = queryCompilerModel(model, "semanticTokens", { uri: { scheme: "file", fsPath: filePath }, position: { line: 0, character: 0 } }, () => {});
    assert.notEqual(tokens, repeatedTokens, "Cached semantic tokens must not expose the retained typed array to callers.");
    assert.deepEqual([...repeatedTokens], [...tokens]);
    assert.equal([...tokens].filter((_value, index) => index % 5 === 3 && tokens[index] === TOKEN_TYPES.indexOf("label")).length, 2);
    const namedText = "finished: Print 1\nGoto finished\n";
    const namedAnalysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, namedText]]), compilerArguments: ["-lang", "qb"] });
    const namedModel = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/named-label.bas" }, namedAnalysis, [{ uri: uri(filePath), text: namedText }]);
    const namedDeclaration = namedModel.resolveAt(uri(filePath), 0, 0)[0];
    const namedReference = namedModel.resolveAt(uri(filePath), 1, 6)[0];
    assert.equal(namedReference?.compilerSymbolId, namedDeclaration.compilerSymbolId);
    assert.deepEqual(namedModel.references(namedDeclaration, true, { isCancellationRequested: false }).map((entry) => entry.occurrence.line), [0, 1]);
    const branchText = "Option Gosub\n10 Print 1\n20 Print 2\nGosub 10\nReturn 20\nOn 1 Goto 10, 20\nOn 2 Gosub 10, 20\nIf 1 Then 10 Else 20\nfault:\nOn Error Goto fault\ndataMarker:\nData 1\nRestore dataMarker\n";
    const branchAnalysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, branchText]]), compilerArguments: ["-lang", "qb"] });
    const branchModel = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/branch-label.bas" }, branchAnalysis, [{ uri: uri(filePath), text: branchText }]);
    const branchReferences = (line, character) => branchModel.references(branchModel.resolveAt(uri(filePath), line, character)[0], true, { isCancellationRequested: false }).map((entry) => entry.occurrence.line);
    assert.deepEqual(branchReferences(1, 0), [1, 3, 5, 6, 7]);
    assert.deepEqual(branchReferences(2, 0), [2, 4, 5, 6, 7]);
    assert.deepEqual(branchReferences(8, 1), [8, 9]);
    assert.deepEqual(branchReferences(10, 1), [10, 12]);
});

test("real compiler binds overloads, prototypes, properties, and nested calls", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-overloads.bas");
    const options = { compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath };
    const analysis = await analyzeSavedModule(options);
    const repeated = await analyzeSavedModule(options);
    assert.deepEqual(repeated.bindings, analysis.bindings, "Identical translation units must not use process addresses as identities");
    const sources = analysis.dependencies.map((file) => ({ uri: uri(file), text: fs.readFileSync(file, "utf8") }));
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/overloads.bas" }, analysis, sources);
    const source = sources.find((source) => source.uri.fsPath === filePath).text;
    const lines = source.split("\n");
    const at = (statement, name, occurrence = 0) => {
        const line = lines.indexOf(statement);
        assert.ok(line >= 0, statement);
        const matches = [...statement.matchAll(new RegExp(name, "g"))];
        return model.resolveAt(uri(filePath), line, matches[occurrence].index);
    };
    const integer = at("Print SelectValue(CLng(1)), SelectValue(CDbl(1))", "SelectValue")[0];
    const floating = at("Print SelectValue(CLng(1)), SelectValue(CDbl(1))", "SelectValue", 1)[0];
    assert.equal(integer.declaration.parameters[0].typeName.toLowerCase(), "long");
    assert.equal(floating.declaration.parameters[0].typeName.toLowerCase(), "double");
    assert.notEqual(integer.id, floating.id);
    assert.equal(at("Print SelectValue(CShort(1))", "SelectValue")[0].id, integer.id, "Compiler conversion ranking selects Long");
    assert.equal(at("Print SelectValue(SelectValue(CDbl(1)))", "SelectValue")[0].id, integer.id);
    assert.equal(at("Print SelectValue(SelectValue(CDbl(1)))", "SelectValue", 1)[0].id, floating.id);
    assert.equal(at("Print Choices.SelectValue(CDbl(1))", "SelectValue")[0].id, floating.id);
    assert.equal(at('Print "café", SelectValue(CDbl(1))', "SelectValue")[0].id, floating.id);
    const method = at("Print instance.SelectValue(CDbl(1))", "SelectValue")[0];
    assert.notEqual(method.id, floating.id);
    assert.equal(method.declaration.parameters[0].typeName.toLowerCase(), "double");
    const getter = at("Print instance.CurrentValue", "CurrentValue")[0];
    const setter = at("instance.CurrentValue = SelectValue(CLng(1))", "CurrentValue")[0];
    assert.notEqual(getter.id, setter.id);
    assert.equal(getter.declaration.parameters.length, 0);
    assert.equal(setter.declaration.parameters.length, 1);
    assert.equal(at("Print MakeResult(CDbl(1)).floatingValue", "floatingValue")[0].name, "floatingValue");
    const targets = model.declarationTargets([floating]);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].uri.fsPath, filePath);
    assert.equal(lines[targets[0].declaration.line], "Function Choices.SelectValue(ByVal value As Double) As Long");
    const references = model.references(floating, false);
    assert.ok(references.every((entry) => entry.uri.fsPath === filePath), "Copied macro-body references now retain physical locations");
    assert.ok(references.some((entry) => entry.occurrence.line === lines.findIndex((line) => line.startsWith("#define SELECT_GENERATED"))));
    assert.equal(references.length, 6);
    assert.equal(model.references(integer, false).length, 4);
    assert.match(at("Print SELECT_GENERATED(CDbl(1))", "SELECT_GENERATED")[0]?.compilerPreprocessorId || "", /^macro:/);
});

test("native property expressions retain getter, setter, and indexed-getter types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-overloads.bas");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const sources = analysis.dependencies.map((dependency) => ({ uri: uri(dependency), text: fs.readFileSync(dependency, "utf8") }));
    const text = sources.find((source) => source.uri.fsPath === filePath).text;
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/property-expressions.bas" }, analysis, sources);
    const lines = text.split("\n"), output = analysis.text.split("\n");
    const expression = (spelling, type) => {
        const line = lines.indexOf(`Print ${spelling}`);
        assert.ok(line >= 0, spelling);
        const result = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 6 + spelling.length });
        assert.equal(result?.typeName.toLowerCase(), type, spelling);
        return result;
    };
    const getter = expression("instance.CurrentValue", "long");
    const indexedGetter = expression("instance.IndexedValue(2)", "double");
    const callFor = (spelling) => analysis.expressionGraph.nodes.find((node) => node.kind === "call" && output[node.start.line]?.slice(node.start.character, node.end.character) === spelling);
    const setter = callFor("instance.CurrentValue = SelectValue(CLng(1))");
    const getterCall = analysis.expressionGraph.nodes[analysis.expressionGraph.nodes[getter.compilerExpressionId - 1].inputs[0] - 1];
    const indexedGetterCall = analysis.expressionGraph.nodes[analysis.expressionGraph.nodes[indexedGetter.compilerExpressionId - 1].inputs[0] - 1];
    assert.ok(setter?.target, "The property setter must retain its compiler-selected procedure.");
    assert.ok(getterCall?.target, "The property getter must retain its compiler-selected procedure.");
    assert.ok(indexedGetterCall?.target, "The indexed property getter must retain its compiler-selected procedure.");
    assert.notEqual(getterCall.target, setter.target, "A property getter and setter are distinct compiler calls.");
    for (const call of [getterCall, setter, indexedGetterCall]) assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === call.target)?.symbolClass, 3);
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === indexedGetterCall.target)?.name, "INDEXEDVALUE");
});

test("real compiler retains static virtual targets and excludes indirect call guesses", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-dispatch.bas");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const source = fs.readFileSync(filePath, "utf8");
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/dispatch.bas" }, analysis, [{ uri: uri(filePath), text: source }]);
    const lines = source.split("\n");
    const at = (statement, name) => model.resolveAt(uri(filePath), lines.indexOf(statement), statement.indexOf(name));
    const base = at("Print baseView.Choose(1)", "Choose")[0];
    const derived = at("Print instance.Choose(1)", "Choose")[0];
    assert.ok(base.compilerProcedureId);
    assert.ok(derived.compilerProcedureId);
    assert.notEqual(base.id, derived.id);
    const methods = new Map(analysis.symbolGraph.dispatch.map((method) => [method.id, method]));
    assert.equal(methods.get(derived.compilerSymbolId).overridden, base.compilerSymbolId);
    assert.equal(methods.get(derived.compilerSymbolId).slot, methods.get(base.compilerSymbolId).slot);
    assert.match(base.qualifiedName, /baseselector\.choose/i);
    assert.match(derived.qualifiedName, /derivedselector\.choose/i);
    assert.ok(at("SharedValue(1) = PlainCall(2)", "SharedValue")[0].compilerProcedureId);
    assert.ok(at("SharedValue(1) = PlainCall(2)", "PlainCall")[0].compilerProcedureId);
    assert.ok(at("ConsumeValue 1", "ConsumeValue")[0].compilerProcedureId);
    assert.equal(analysis.bindings.some((record) => record.kind === "call" && record.name.toLowerCase() === "callback"), false);
    assert.equal(at("Print callback(1)", "callback")[0].declaration.type, "variable");
});

test("real compiler binds suffixed procedure names in legacy dialects", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-suffix-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "suffix.bas");
    const source = "Declare Function Measure%(ByVal value As Integer)\nFunction Measure%(ByVal value As Integer)\n Measure% = value\nEnd Function\nPrint Measure%(1)\n";
    fs.writeFileSync(filePath, source);
    for (const dialect of ["fblite", "qb"]) {
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, compilerArguments: ["-lang", dialect] });
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/suffix.bas" }, analysis, [{ uri: uri(filePath), text: source }]);
        const target = model.resolveAt(uri(filePath), 4, 8)[0];
        assert.ok(target?.compilerProcedureId, dialect);
    }
});

test("trace analysis survives recycled top-level UDT links during FBLite recovery", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot("");
    const filePath = path.join(root, "tests/functions/return-byref.bas");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: [
            "-lang", "fblite",
            "-i", path.join(root, "inc"),
            "-i", path.join(root, "tests/fbcunit/inc")
        ],
        allowErrors: true
    });

    assert.ok(analysis.partial, "FBLite correctly diagnoses FreeBASIC-only declarations in this source.");
    assert.ok(analysis.completion.errorCount > 0);
    assert.equal(analysis.completion.reachedEnd, true, "Trace export must survive compiler error recovery to EOF.");
    assert.ok(analysis.dependencies.includes(filePath));
});

test("native inventory retains legacy implicit variables in their compiler-selected procedure scope", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-implicit-scope-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "implicit.bas");
    const source = "Sub Inspect()\n If 1 Then\n  implicitValue = 1\n End If\n Print implicitValue\nEnd Sub\nInspect()\n";
    fs.writeFileSync(filePath, source);
    for (const dialect of ["fblite", "qb"]) {
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, compilerArguments: ["-lang", dialect] });
        const model = new CompilerSemanticModel({ toString: () => `freebasic-preprocessed:/${dialect}-scope.bas` }, analysis, [{ uri: uri(filePath), text: source }]);
        const target = model.resolveAt(uri(filePath), 4, 9)[0];
        assert.ok(target?.compilerSymbolId, dialect);
        assert.equal(target.scope.kind, "sub");
        assert.ok(model.visibleEntries(uri(filePath), 4, 15).some((entry) => entry.compilerSymbolId === target.compilerSymbolId));
        assert.ok(!model.visibleEntries(uri(filePath), 6, 8).some((entry) => entry.compilerSymbolId === target.compilerSymbolId));
    }
});

test("real compiler overlays preserve original include context without saving buffers", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-overlay-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const header = path.join(directory, "buffer.bi");
    fs.writeFileSync(filePath, "Print 1\n");
    const overlays = new Map([[filePath, '#include "buffer.bi"\nPrint pendingValue\nPrint __FILE__\n'], [header, "Dim pendingValue As Double\n"]]);
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays });
    assert.match(analysis.text, /pendingValue As Double/);
    assert.ok(analysis.text.includes(filePath));
    assert.ok(analysis.dependencies.includes(header));
    assert.equal(fs.existsSync(header), false);
    assert.equal(fs.readFileSync(filePath, "utf8"), "Print 1\n");
    assert.ok(analysis.expressions.some((expression) => expression.typeName.toLowerCase() === "double"));
});

test("compiler overlays reject ambiguous physical file aliases", { skip: !process.env.FBC_EDITOR_EXECUTABLE || process.platform === "win32" }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-overlay-alias-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const header = path.join(directory, "original.bi");
    const alias = path.join(directory, "alias.bi");
    const original = "Dim value As Long\n";
    const edited = "Dim value As Double\n";
    fs.writeFileSync(filePath, '#include "original.bi"\nPrint value\n');
    fs.writeFileSync(header, original);
    fs.symlinkSync(header, alias);
    const options = { compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath };
    const unchanged = await analyzeSavedModule({ ...options, overlays: new Map([[alias, original]]) });
    assert.ok(unchanged.dependencies.includes(header));
    await assert.rejects(analyzeSavedModule({ ...options, overlays: new Map([[alias, edited]]) }), /different path/);
    await assert.rejects(analyzeSavedModule({ ...options, overlays: new Map([[alias, edited], [header, original]]) }), /Conflicting editor buffers/);
    assert.equal(fs.readFileSync(header, "utf8"), original);
});

test("compiler overlays reject text that cannot be represented without changing source", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-overlay-encoding-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const options = { compilerPath: "unused", filePath };
    await assert.rejects(analyzeSavedModule({ ...options, overlays: new Map([[filePath, "Print \ud800"]]) }), /unmatched UTF-16 surrogate/);
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Print value\n", "utf16le")]);
    assert.equal(decodeCompilerSourceBuffer(utf16le, filePath), "\uFEFFPrint value\n");
    assert.throws(() => decodeCompilerSourceBuffer(Buffer.from([0xff, 0xfe, 0x50]), filePath), /Malformed UTF-16LE/);
});

test("compiler source decoding accepts strict UTF-16BE and UTF-32 BOM encodings", () => {
    const filePath = "encoded.bas";
    const source = "Print value\n";
    const utf16beContents = Buffer.from(source, "utf16le").swap16();
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beContents]);
    assert.equal(decodeCompilerSourceBuffer(utf16be, filePath), `\uFEFF${source}`);

    const encodeUtf32 = (text, littleEndian) => {
        const codePoints = [...text].map((character) => character.codePointAt(0));
        const contents = Buffer.alloc(codePoints.length * 4);
        codePoints.forEach((codePoint, index) => {
            if (littleEndian) contents.writeUInt32LE(codePoint, index * 4);
            else contents.writeUInt32BE(codePoint, index * 4);
        });
        return contents;
    };
    const utf32le = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), encodeUtf32(source, true)]);
    const utf32be = Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), encodeUtf32(source, false)]);
    assert.equal(decodeCompilerSourceBuffer(utf32le, filePath), `\uFEFF${source}`);
    assert.equal(decodeCompilerSourceBuffer(utf32be, filePath), `\uFEFF${source}`);
    assert.throws(() => decodeCompilerSourceBuffer(Buffer.from([0xfe, 0xff, 0xd8, 0x00]), filePath), /Malformed UTF-16BE/);
    assert.throws(() => decodeCompilerSourceBuffer(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x00]), filePath), /Malformed UTF-32LE/);
    assert.throws(() => decodeCompilerSourceBuffer(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00]), filePath), /Malformed UTF-32LE/);
});

test("unmarked Latin-1 source decodes without shifting later byte columns", () => {
    const filePath = "legacy-latin1.bas";
    const sourceBytes = Buffer.concat([
        Buffer.from('Dim caption$ = "caf'),
        Buffer.from([0xe9]),
        Buffer.from('": Print caption$\n')
    ]);
    const source = decodeCompilerSourceBuffer(sourceBytes, filePath);

    assert.equal(source, 'Dim caption$ = "café": Print caption$\n');
    assert.equal(source.indexOf("Print"), sourceBytes.indexOf(Buffer.from("Print")));
    assert.equal(decodeCompilerSourceBuffer(Buffer.from("Print café\n", "utf8"), filePath), "Print café\n");
    assert.throws(() => decodeCompilerSourceBuffer(Buffer.from([0xe9, 0x00]), filePath), /NUL character/);
});

test("physical token origins map raw Latin-1 offsets into decoded editor text", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-origin-latin1-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "legacy.bas");
    const sourceBytes = Buffer.concat([
        Buffer.from('Dim caption As String = "caf'),
        Buffer.from([0xe9]),
        Buffer.from('"\nDim amount As Double = 1.5\nPrint amount\n')
    ]);
    const source = decodeCompilerSourceBuffer(sourceBytes, filePath);
    fs.writeFileSync(filePath, sourceBytes);

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    assert.ok(analysis.tokenOrigins.some((token) => token.kind === "source" && token.filePath === filePath &&
        token.sourceStart > sourceBytes.indexOf(0xe9)),
    "the native trace must include a token after the raw single-byte character");

    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/legacy-origin.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const line = source.split("\n")[2];
    const result = model.resolveAt(sourceUri, 2, line.indexOf("amount"));
    assert.ok(result.some((entry) => entry.name.toLowerCase() === "amount"),
        "physical origin projection must find the declaration through decoded text");
});

test("native analysis overlays preserve Unicode source from UTF-16LE files", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-overlay-utf16-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const source = "Dim amount As Double = 2\nPrint amount * 3\n";
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]));
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]])
    });
    assert.ok(analysis.dependencies.includes(filePath));
    const model = new CompilerSemanticModel({ toString: () => `freebasic-preprocessed:/utf16/${path.basename(filePath)}` }, analysis, [{ uri: uri(filePath), text: source }]);
    const type = model.expressionAt(uri(filePath), { line: 1, character: 6 }, { line: 1, character: 16 });
    assert.equal(type?.typeName.toLowerCase(), "double");
});

test("native recovery keeps source dependencies when parser-context tokens were cached early", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/quirk/with-expr-declares-var-during-error-recovery-2.bas");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, allowErrors: true });
    assert.equal(analysis.partial, true);
    assert.ok(analysis.dependencies.includes(filePath));
    assert.ok(analysis.tokenOrigins.length > 0);
});

test("native #lang restart resets trace identities before the retained QB pass", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/gfx/rgb_qb.bas");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        allowErrors: true,
        compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")]
    });
    assert.equal(analysis.preprocessorGraph.declarations[0]?.id, 1);
    assert.ok(analysis.preprocessorGraph.contexts.some((context) => context.epoch === 0));
    const symbols = new Map(analysis.symbolGraph.symbols.map((symbol) => [symbol.id, symbol.name.toLowerCase()]));
    const macroNames = new Set(analysis.preprocessorGraph.declarations.map((record) => symbols.get(record.symbol)));
    assert.ok(macroNames.has("rgb_old"));
    assert.ok(macroNames.has("rgba_old"));
    assert.ok(analysis.expressionGraph.nodes.length > 0);
    const sources = analysis.dependencies.map((file) => ({ uri: uri(file), text: fs.readFileSync(file, "utf8") }));
    const expanded = { toString: () => "freebasic-preprocessed:/qb-restart/rgb_qb.bas" };
    const model = new CompilerSemanticModel(expanded, analysis, sources);
    const qualifiedCall = analysis.bindings.find((binding) => binding.kind === "call" && binding.name.toLowerCase() === "fbcu.add_suite");
    assert.ok(qualifiedCall, "The QB test contains a compiler-selected qualified procedure call.");
    const terminalStart = qualifiedCall.endColumn - "add_suite".length;
    const resolved = model.resolveAt(expanded, qualifiedCall.line, terminalStart);
    assert.equal(resolved[0]?.compilerProcedureId, qualifiedCall.id);
});

test("native expression types cover operator prefixes, casts, arrays, and inferred values", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const source = fs.readFileSync(filePath, "utf8");
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/types.bas" }, analysis, [{ uri: uri(filePath), text: source }]);
    const lines = source.split("\n");
    const typeOf = (statement, expression) => {
        const line = lines.indexOf(statement);
        const character = statement.indexOf(expression);
        assert.ok(line >= 0 && character >= 0);
        const type = model.expressionAt(uri(filePath), { line, character }, { line, character: character + expression.length });
        assert.ok(type, expression);
        return type.typeName.toLowerCase();
    };
    assert.equal(typeOf("Print CLng(1) + CLng(2) + CDbl(3)", "CLng(1) + CLng(2)"), "integer");
    assert.equal(typeOf("Print CLng(1) + CLng(2) + CDbl(3)", "CLng(1) + CLng(2) + CDbl(3)"), "double");
    assert.equal(typeOf("Print inferred * 2", "inferred * 2"), "double");
    assert.equal(typeOf("Print Sin(inferred)", "Sin(inferred)"), "double");
    assert.equal(typeOf("Print CVL(encoded)", "CVL(encoded)"), "long");
    assert.equal(typeOf("Print IIf(inferred > 0, CLng(1), CDbl(2))", "IIf(inferred > 0, CLng(1), CDbl(2))"), "double");
    assert.equal(typeOf("Print Not CLng(1)", "Not CLng(1)"), "integer");
    assert.equal(typeOf("Print ThreadCall ThreadWorker(0)", "ThreadCall ThreadWorker(0)"), "any ptr");
    const runtimeCall = analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "call" && line.slice(node.start.character, node.end.character) === "CVL(encoded)";
    });
    assert.equal(runtimeCall?.options, 2, "A compiler-created runtime helper retains its resolved call target.");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === runtimeCall.target)?.name, "FB_CVL");
    assert.equal(analysis.expressionGraph.nodes[runtimeCall.inputs[0] - 1]?.kind, "conversion");
    const threadCall = analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "call" && line.slice(node.start.character, node.end.character) === "ThreadCall ThreadWorker(0)";
    });
    assert.equal(threadCall?.options, 2, "THREADCALL is a compiler-created runtime call.");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === threadCall.target)?.name, "FB_THREADCALL");
    const threadWorkerSyntax = analysis.expressionGraph.nodes[threadCall.inputs[0] - 1];
    assert.equal(threadWorkerSyntax?.kind, "syntax");
    const threadWorkerCall = analysis.expressionGraph.nodes[threadWorkerSyntax.inputs[0] - 1];
    assert.equal(threadWorkerCall?.kind, "call");
    assert.equal(threadWorkerCall.options, 1);
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === threadWorkerCall.target)?.name.toLowerCase(), "threadworker");
    assert.equal(analysis.text.split("\n")[threadWorkerCall.start.line].slice(threadWorkerCall.start.character, threadWorkerCall.end.character), "ThreadWorker(0)");
    const implicitConstructor = analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "call" && node.options === 0 && line.slice(node.start.character, node.end.character) === "3";
    });
    assert.ok(implicitConstructor?.target, "An implicit constructor must retain its selected procedure.");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === implicitConstructor.target)?.symbolClass, 3);
    assert.equal(analysis.expressionGraph.nodes[implicitConstructor.inputs[0] - 1]?.typeName.toLowerCase(), "integer");
    assert.equal(analysis.expressionGraph.nodes[implicitConstructor.inputs[2] - 1]?.kind, "argument");
    const explicitConstructor = analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "call" && node.options === 1 && line.slice(node.start.character, node.end.character) === "WrappedValue(5)";
    });
    assert.ok(explicitConstructor?.target, "An explicit UDT constructor must retain its selected procedure.");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === explicitConstructor.target)?.symbolClass, 3);
    assert.equal(explicitConstructor.typeName.toLowerCase(), "wrappedvalue");
    assert.equal(analysis.expressionGraph.nodes[explicitConstructor.inputs[1] - 1]?.kind, "argument");
    assert.equal(typeOf("Print WrappedValue(5).value", "WrappedValue(5)"), "wrappedvalue");
    const anonymousConstructor = analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "call" && node.options === 1 && line.slice(node.start.character, node.end.character) === "Type<WrappedValue>(5)";
    });
    assert.ok(anonymousConstructor?.target, "An anonymous TYPE constructor must retain its selected procedure.");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === anonymousConstructor.target)?.symbolClass, 3);
    assert.equal(anonymousConstructor.typeName.toLowerCase(), "wrappedvalue");
    assert.equal(analysis.expressionGraph.nodes[anonymousConstructor.inputs[1] - 1]?.kind, "argument");
    assert.equal(typeOf("Print Type<WrappedValue>(5).value", "Type<WrappedValue>(5)"), "wrappedvalue");
    const allocatedConstructor = analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "call" && node.options === 1 && line.slice(node.start.character, node.end.character) === "New WrappedValue(5)";
    });
    assert.ok(allocatedConstructor?.target, "A NEW UDT constructor must retain its selected procedure.");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === allocatedConstructor.target)?.symbolClass, 3);
    assert.equal(allocatedConstructor.typeName.toLowerCase(), "wrappedvalue");
    assert.equal(analysis.expressionGraph.nodes[allocatedConstructor.inputs[1] - 1]?.kind, "argument");
    const parserFamily = (expression) => analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "syntax" && line.slice(node.start.character, node.end.character) === expression;
    })?.family;
    assert.equal(parserFamily("Type<WrappedValue>(5)"), "cAnonType");
    assert.equal(parserFamily("New WrappedValue(5)"), "cOperatorNew");
    assert.ok(analysis.expressionGraph.nodes.some((node) => node.family === "cThreadCallFunc"));
    for (const family of ["cAnonType", "cOperatorNew", "cThreadCallFunc"]) assert.ok(QUIRK_EXPRESSION_FAMILIES.includes(family));
    const indexed = analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "index" && line.slice(node.start.character, node.end.character) === "packets(0)";
    });
    assert.ok(indexed, "Fixed-array indexing must retain its receiver and index dependencies.");
    assert.ok(indexed.inputs[0] && indexed.inputs[1]);
    const dynamicLine = lines.indexOf("Print dynamicPackets(0).amount");
    const dynamicExpression = model.expressionAt(uri(filePath), { line: dynamicLine, character: 6 }, { line: dynamicLine, character: 23 });
    assert.equal(dynamicExpression?.typeName.toLowerCase(), "packet", "Dynamic-array indexing must retain the compiler-selected element type.");
    const dynamicIndex = analysis.expressionGraph.nodes.find((node) => node.kind === "index" && analysis.origins[node.start.line]?.line === dynamicLine);
    assert.equal(dynamicIndex?.typeName.toLowerCase(), "packet", "Dynamic-array indexing must retain an explicit index edge.");
    assert.equal(analysis.expressionGraph.nodes[dynamicIndex.inputs[0] - 1]?.typeName.toLowerCase(), "packet");
    assert.equal(analysis.expressionGraph.nodes[dynamicIndex.inputs[1] - 1]?.typeName.toLowerCase(), "integer");
    for (const statement of ["Print (packets(0) + packets(0)).amount", "Print dynamicPackets(0).amount", "Print CPtr(Packet Ptr, packetPtr)->amount"]) {
        const members = model.completeMembers(uri(filePath), lines.indexOf(statement), statement.indexOf("amount"));
        assert.deepEqual(members.map((entry) => entry.name), ["amount"]);
    }
});

test("native expression typing agrees with compiler semantic facts across language modes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-expression-modes-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "language-modes.bas");
    const source = [
        "Type LanguageModeProbe",
        "    amount As Double",
        "End Type",
        "Function ScaleLanguageModeValue(ByVal value As Double) As Double",
        "    ScaleLanguageModeValue = value * 2.0",
        "End Function",
        "Dim preciseValue As Double",
        "Dim integerValue As Integer",
        "Dim integerItems(0 To 1) As Integer",
        "Dim recordValue As LanguageModeProbe",
        "Print -preciseValue",
        "Print Not integerValue",
        "Print 1 + 2.0 * preciseValue",
        "Print integerValue And 3",
        "Print integerValue = 3",
        "Print \"left\" & \"right\"",
        "Print recordValue.amount",
        "Print integerItems(0)",
        "Print CInt(preciseValue)",
        "Print ScaleLanguageModeValue(preciseValue)",
        "Print Len(\"abc\")",
        "Print Abs(preciseValue)",
        "Print 1 AndAlso 2 AndAlso 3",
        "Print 1 OrElse 2 OrElse 3",
        "Print integerValue Xor 3 Xor 1",
        "Print 1 < 2 < 3",
        "Print \"left\" & \"right\" & \"tail\"",
        "Print 1 + 2 + integerValue + 4",
        "Print 1 + 2 + preciseValue + 4",
        "Print 8 Shl 1 Shl 1",
        "Print 17 Mod 5 Mod 2",
        "Print 17 \\ 5 \\ 2",
        "Print 2 * 3 * 4",
        "Print 2 ^ 3 ^ 2",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, source);

    const modes = [
        { name: "default", arguments: [] },
        { name: "FreeBASIC", arguments: ["-lang", "fb"] },
        { name: "FB-Lite", arguments: ["-lang", "fblite"] },
        { name: "QB", arguments: ["-lang", "qb"], unsupportedExpressions: ["8 Shl 1 Shl 1"] },
        { name: "deprecated", arguments: ["-lang", "deprecated"] },
        { name: "extended syntax", arguments: ["-exx"] },
        { name: "32-bit x86", arguments: ["-arch", "686", "-gen", "gas"], pointerSize: true },
        { name: "64-bit x86", arguments: ["-arch", "x86_64", "-gen", "gas64"], pointerSize: true }
    ];
    const integerType = (mode) => mode.name === "QB" ? "short" : "integer";
    const expressions = [
        { text: "-preciseValue", typeName: "double" },
        { text: "Not integerValue", typeName: integerType },
        { text: "1 + 2.0 * preciseValue", typeName: "double" },
        { text: "integerValue And 3", typeName: integerType },
        { text: "integerValue = 3", typeName: "integer" },
        { text: "\"left\" & \"right\"", typeName: "zstring" },
        { text: "recordValue.amount", typeName: "double" },
        { text: "integerItems(0)", typeName: integerType },
        { text: "CInt(preciseValue)", typeName: integerType },
        { text: "ScaleLanguageModeValue(preciseValue)", typeName: "double" },
        { text: "Len(\"abc\")", typeName: "integer" },
        { text: "Abs(preciseValue)", typeName: "double" },
        { text: "1 AndAlso 2 AndAlso 3", typeName: "integer" },
        { text: "1 OrElse 2 OrElse 3", typeName: "integer" },
        { text: "integerValue Xor 3 Xor 1", typeName: integerType },
        { text: "1 < 2 < 3", typeName: "integer" },
        { text: "\"left\" & \"right\" & \"tail\"", typeName: "zstring" },
        { text: "1 + 2 + integerValue + 4", typeName: integerType },
        { text: "1 + 2 + preciseValue + 4", typeName: "double" },
        { text: "8 Shl 1 Shl 1", typeName: integerType },
        { text: "17 Mod 5 Mod 2", typeName: integerType },
        { text: "17 \\ 5 \\ 2", typeName: integerType },
        { text: "2 * 3 * 4", typeName: integerType },
        { text: "2 ^ 3 ^ 2", typeName: "double" }
    ];
    const intermediatePrefixes = [
        { expression: "1 AndAlso 2 AndAlso 3", prefix: "1 AndAlso 2", typeName: "integer" },
        { expression: "1 OrElse 2 OrElse 3", prefix: "1 OrElse 2", typeName: "integer" },
        { expression: "integerValue Xor 3 Xor 1", prefix: "integerValue Xor 3", typeName: integerType },
        { expression: "1 < 2 < 3", prefix: "1 < 2", typeName: "integer" },
        { expression: "\"left\" & \"right\" & \"tail\"", prefix: "\"left\" & \"right\"", typeName: "zstring" },
        { expression: "1 + 2 + integerValue + 4", prefix: "1 + 2 + integerValue", typeName: integerType },
        { expression: "1 + 2 + preciseValue + 4", prefix: "1 + 2 + preciseValue", typeName: "double" },
        { expression: "8 Shl 1 Shl 1", prefix: "8 Shl 1", typeName: integerType },
        { expression: "17 Mod 5 Mod 2", prefix: "17 Mod 5", typeName: integerType },
        { expression: "17 \\ 5 \\ 2", prefix: "17 \\ 5", typeName: integerType },
        { expression: "2 * 3 * 4", prefix: "2 * 3", typeName: integerType },
        { expression: "2 ^ 3 ^ 2", prefix: "2 ^ 3", typeName: "double" }
    ];
    const sourceUri = uri(filePath);

    for (const mode of modes) {
        const unavailable = new Set(mode.unsupportedExpressions || []);
        const modeSource = source.split("\n").filter((line) => ![...unavailable].some((expression) => line.startsWith(`Print ${expression}`))).join("\n") +
            (mode.pointerSize ? "Print SizeOf(Any Ptr)\n" : "");
        fs.writeFileSync(filePath, modeSource);
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments: mode.arguments,
            overlays: new Map([[filePath, modeSource]]),
            exportSemanticExpressions: true,
            requireSemanticModel: true
        });
        assert.equal(analysis.partial, false, `${mode.name}: compiler analysis must complete`);
        const model = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/language-modes/${mode.name}` },
            analysis,
            [{ uri: sourceUri, text: modeSource }]
        );

        const modeExpressions = mode.pointerSize
            ? [...expressions, { text: "SizeOf(Any Ptr)", typeName: "integer" }]
            : expressions;
        for (const expression of modeExpressions.filter((candidate) => !unavailable.has(candidate.text))) {
            const expectedType = typeof expression.typeName === "function" ? expression.typeName(mode) : expression.typeName;
            const line = modeSource.split("\n").findIndex((value) => value.startsWith(`Print ${expression.text}`));
            assert.ok(line >= 0, `${mode.name}: missing fixture expression ${expression.text}`);
            const startColumn = modeSource.split("\n")[line].indexOf(expression.text);
            const start = { line, character: startColumn };
            const end = { line, character: startColumn + expression.text.length };
            const fact = analysis.semanticExpressions.find((item) => item.physical && item.filePath === filePath &&
                item.startLine === line + 1 && item.startColumn === startColumn &&
                item.endLine === line + 1 && item.endColumn === end.character);
            assert.ok(fact, `${mode.name}: compiler sidecar omitted ${expression.text}`);
            assert.equal(fact.typeName.toLowerCase(), expectedType, `${mode.name}: sidecar type for ${expression.text}`);
            const typed = model.expressionAt(sourceUri, start, end);
            assert.equal(typed?.typeName.toLowerCase(), expectedType, `${mode.name}: editor type for ${expression.text}`);
            const traced = model.expressionAtTraceOnly(sourceUri, start, end);
            const traceDisagrees = traced && (traced.dtype !== fact.dtype || traced.typeName.toLowerCase() !== fact.typeName.toLowerCase());
            if (!traced || traceDisagrees) {
                assert.equal(typed?.semanticSource, "compiler-sidecar", `${mode.name}: compiler fact must supply ${expression.text}`);
            }
        }
        for (const { expression, prefix, typeName } of intermediatePrefixes.filter((candidate) => !unavailable.has(candidate.expression))) {
            const expectedType = typeof typeName === "function" ? typeName(mode) : typeName;
            const line = modeSource.split("\n").findIndex((value) => value.startsWith(`Print ${expression}`));
            assert.ok(line >= 0, `${mode.name}: missing intermediate fixture ${expression}`);
            const lineText = modeSource.split("\n")[line];
            const startColumn = lineText.indexOf(prefix);
            const endColumn = startColumn + prefix.length;
            const fact = analysis.semanticExpressions.find((item) => item.physical && item.filePath === filePath &&
                item.startLine === line + 1 && item.startColumn === startColumn &&
                item.endLine === line + 1 && item.endColumn === endColumn);
            assert.ok(fact, `${mode.name}: compiler sidecar omitted completed prefix ${prefix}`);
            assert.equal(fact.typeName.toLowerCase(), expectedType, `${mode.name}: sidecar prefix type for ${prefix}`);
            const typed = model.expressionAt(sourceUri, { line, character: startColumn }, { line, character: endColumn });
            assert.equal(typed?.typeName.toLowerCase(), expectedType, `${mode.name}: editor prefix type for ${prefix}`);
        }
    }
});

test("native custom allocation operators retain selected NEW and DELETE calls", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = [
        "Type AllocatedValue",
        "    value As Long",
        "    Declare Operator New(ByVal size As UInteger) As Any Ptr",
        "    Declare Operator New[](ByVal size As UInteger) As Any Ptr",
        "    Declare Operator Delete(ByVal buffer As Any Ptr)",
        "    Declare Operator Delete[](ByVal buffer As Any Ptr)",
        "    Declare Destructor()",
        "End Type",
        "Operator AllocatedValue.New(ByVal size As UInteger) As Any Ptr",
        "    Return Allocate(size)",
        "End Operator",
        "Operator AllocatedValue.New[](ByVal size As UInteger) As Any Ptr",
        "    Return Allocate(size)",
        "End Operator",
        "Operator AllocatedValue.Delete(ByVal buffer As Any Ptr)",
        "    Deallocate(buffer)",
        "End Operator",
        "Operator AllocatedValue.Delete[](ByVal buffer As Any Ptr)",
        "    Deallocate(buffer)",
        "End Operator",
        "Destructor AllocatedValue()",
        "End Destructor",
        "Type PlacementAddress",
        "    value As Long",
        "End Type",
        "Operator +(ByRef address As PlacementAddress, ByVal offset As Long) As Any Ptr",
        "    Return 0",
        "End Operator",
        "Type PlainAllocatedValue",
        "    value As Long",
        "    Declare Constructor(ByVal initial As Long = 0)",
        "End Type",
        "Constructor PlainAllocatedValue(ByVal initial As Long)",
        "    value = initial",
        "End Constructor",
        "Dim placementAddress As PlacementAddress",
        "Dim placedInstance As AllocatedValue Ptr = New(placementAddress + 1) AllocatedValue",
        "Dim instance As AllocatedValue Ptr = New AllocatedValue",
        "Dim instances As AllocatedValue Ptr = New AllocatedValue[2]",
        "Dim plainInstance As PlainAllocatedValue Ptr = New PlainAllocatedValue",
        "Delete instance",
        "Delete[] instances"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    const allocations = ["New AllocatedValue", "New AllocatedValue[2]", "New PlainAllocatedValue"].map((source) => {
        const expression = analysis.expressionGraph.nodes.filter((node) => node.kind === "syntax" && spelling(node) === source).pop();
        const expectedType = source.includes("Plain") ? "plainallocatedvalue ptr" : "allocatedvalue ptr";
        assert.equal(expression?.typeName.toLowerCase(), expectedType, source);
        return expression;
    });
    assert.ok(allocations.every(Boolean));
    const allocationOwner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "ALLOCATEDVALUE")?.id;
    assert.ok(allocationOwner, "The compiler must export the allocation type.");
    const calls = ["New AllocatedValue", "New AllocatedValue[2]", "Delete instance", "Delete[] instances"].map((source) => {
        const call = analysis.expressionGraph.nodes.find((node) => node.kind === "call" && spelling(node) === source);
        assert.equal(call?.options, 2, source);
        assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === call.target)?.owner, allocationOwner, source);
        assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === call.target)?.symbolClass, 3, source);
        return call;
    });
    assert.equal(new Set(calls.map((call) => call.target)).size, 4, "Each allocation form must retain its own compiler-selected operator.");
    assert.equal(analysis.expressionGraph.nodes.some((node) =>
        node.kind === "call" && spelling(node) === "New(placementAddress + 1) AllocatedValue"
    ), false, "A placement expression's overloaded operator must not be mislabeled as Operator New.");
    const vectorCount = analysis.expressionGraph.nodes[calls[1].inputs[1] - 1];
    assert.equal(spelling(vectorCount), "2");
    assert.equal(spelling(analysis.expressionGraph.nodes[calls[2].inputs[1] - 1]), "instance");
    assert.equal(spelling(analysis.expressionGraph.nodes[calls[3].inputs[1] - 1]), "instances");
    for (const value of ["instance", "instances"]) {
        const destructor = analysis.expressionGraph.nodes.find((node) => {
            if (node.kind !== "call" || node.options !== 2 || spelling(node) !== value) return false;
            const target = analysis.symbolGraph.symbols.find((symbol) => symbol.id === node.target);
            return target?.owner === allocationOwner && (target.procedureAttributes & 0x1008) !== 0;
        });
        assert.ok(destructor, `DELETE ${value} must retain the compiler-selected destructor.`);
        assert.equal(spelling(analysis.expressionGraph.nodes[destructor.inputs[0] - 1]), value, `DELETE ${value} must depend on its written pointer expression.`);
    }
});

test("native physical operator receipts feed compiler reference CodeLens", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-operator-reference-lens-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "operator-reference-lens.bas");
    const source = [
        "Type AllocatedValue",
        "    value As Long",
        "    Declare Operator New(ByVal size As UInteger) As Any Ptr",
        "    Declare Operator New[](ByVal size As UInteger) As Any Ptr",
        "    Declare Operator Delete(ByVal buffer As Any Ptr)",
        "    Declare Operator Delete[](ByVal buffer As Any Ptr)",
        "End Type",
        "Operator AllocatedValue.New(ByVal size As UInteger) As Any Ptr",
        "    Return Allocate(size)",
        "End Operator",
        "Operator AllocatedValue.New[](ByVal size As UInteger) As Any Ptr",
        "    Return Allocate(size)",
        "End Operator",
        "Operator AllocatedValue.Delete(ByVal buffer As Any Ptr)",
        "    Deallocate(buffer)",
        "End Operator",
        "Operator AllocatedValue.Delete[](ByVal buffer As Any Ptr)",
        "    Deallocate(buffer)",
        "End Operator",
        "Type IteratorValue",
        "    value As Long",
        "    Declare Constructor(ByVal initial As Long = 0)",
        "    Declare Operator For(ByRef stepValue As IteratorValue)",
        "    Declare Operator Step(ByRef stepValue As IteratorValue)",
        "    Declare Operator Next(ByRef finish As IteratorValue, ByRef stepValue As IteratorValue) As Integer",
        "End Type",
        "Constructor IteratorValue(ByVal initial As Long)",
        "    This.value = initial",
        "End Constructor",
        "Operator IteratorValue.For(ByRef stepValue As IteratorValue)",
        "End Operator",
        "Operator IteratorValue.Step(ByRef stepValue As IteratorValue)",
        "    This.value += stepValue.value",
        "End Operator",
        "Operator IteratorValue.Next(ByRef finish As IteratorValue, ByRef stepValue As IteratorValue) As Integer",
        "    Operator = This.value <= finish.value",
        "End Operator",
        "Dim instance As AllocatedValue Ptr = New AllocatedValue",
        "Dim instances As AllocatedValue Ptr = New AllocatedValue[2]",
        "Delete instance",
        "Delete[] instances",
        "Dim current As IteratorValue",
        "For current = IteratorValue(0) To IteratorValue(2) Step IteratorValue(1)",
        "Next"
    ].join("\n");
    fs.writeFileSync(filePath, source, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/operator-reference-lens.bas" },
        analysis,
        analysis.dependencies.map((dependency) => ({
            uri: uri(dependency),
            text: dependency === filePath ? source
                : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
        }))
    );
    const result = queryCompilerModel(model, "compilerProcedureReferenceCodeLenses", {
        uri: { scheme: "file", fsPath: filePath }
    }, () => {});
    const lines = source.split("\n");
    const referenceWords = result.entries.flatMap((entry) => entry.references.map((reference) =>
        lines[reference.line].slice(reference.startColumn, reference.endColumn)
    ));

    assert.equal(result.complete, true);
    for (const word of ["New", "Delete", "For", "Step", "Next"]) {
        assert.ok(referenceWords.includes(word), `FBC's physical ${word} receipt should reach CodeLens`);
    }
    assert.equal(referenceWords.filter((word) => word === "New").length, 2);
    assert.equal(referenceWords.filter((word) => word === "Delete").length, 2);
});

test("native bit-field expression traces use the compiler remap type", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const lines = [
        "Type BitfieldTypes",
        "    As Integer signedValue:5",
        "    As UInteger unsignedValue:5",
        "    As UByte byteValue:3",
        "    As Short shortValue:3",
        "    As Boolean booleanValue:1",
        "End Type",
        "Dim value As BitfieldTypes",
        "Print value.signedValue",
        "Print value.unsignedValue",
        "Print value.byteValue",
        "Print value.shortValue",
        "Print value.booleanValue"
    ];
    const source = lines.join("\n") + "\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true
    });
    assert.equal(analysis.partial, false);

    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    for (const field of ["signedValue", "unsignedValue", "byteValue", "shortValue", "booleanValue"]) {
        const expression = `value.${field}`;
        const line = lines.findIndex((value) => value === `Print ${expression}`);
        const column = lines[line].indexOf(expression);
        const fact = analysis.semanticExpressions.find((item) => item.physical && item.filePath === filePath &&
            item.startLine === line + 1 && item.startColumn === column && item.endColumn === column + expression.length);
        assert.equal(fact?.typeName.toLowerCase(), "uinteger", `${field}: semantic expression result`);

        const trace = analysis.expressionGraph.nodes.filter((node) => node.kind === "syntax" && spelling(node) === expression).pop();
        assert.equal(trace?.typeName.toLowerCase(), fact.typeName.toLowerCase(), `${field}: bridge expression result`);
    }
});

test("native iterator operators retain FOR, STEP, and NEXT source relationships", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = [
        "Type IteratorValue",
        "    value As Long",
        "    Declare Constructor(ByVal initial As Long = 0)",
        "    Declare Operator For(ByRef stepValue As IteratorValue)",
        "    Declare Operator Step(ByRef stepValue As IteratorValue)",
        "    Declare Operator Next(ByRef finish As IteratorValue, ByRef stepValue As IteratorValue) As Integer",
        "End Type",
        "Constructor IteratorValue(ByVal initial As Long)",
        "    This.value = initial",
        "End Constructor",
        "Operator IteratorValue.For(ByRef stepValue As IteratorValue)",
        "End Operator",
        "Operator IteratorValue.Step(ByRef stepValue As IteratorValue)",
        "    This.value += stepValue.value",
        "End Operator",
        "Operator IteratorValue.Next(ByRef finish As IteratorValue, ByRef stepValue As IteratorValue) As Integer",
        "    Operator = This.value <= finish.value",
        "End Operator",
        "Dim current As IteratorValue",
        "For current = IteratorValue(0) To IteratorValue(2) Step IteratorValue(1)",
        "    Print current.value",
        "Next"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    const owner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "ITERATORVALUE")?.id;
    const forStatement = "For current = IteratorValue(0) To IteratorValue(2) Step IteratorValue(1)";
    const forCall = analysis.expressionGraph.nodes.find((node) => node.kind === "call" && node.options === 2 && spelling(node) === forStatement);
    const nextCalls = analysis.expressionGraph.nodes.filter((node) => node.kind === "call" && node.options === 2 && spelling(node) === "Next");
    assert.equal(nextCalls.length, 2, "NEXT emits the separate STEP and NEXT operator calls.");
    const stepCall = nextCalls.find((node) => node.typeName.toLowerCase() === "any");
    const nextCall = nextCalls.find((node) => node.typeName.toLowerCase() === "integer");
    for (const [name, call] of [["FOR", forCall], ["STEP", stepCall], ["NEXT", nextCall]]) {
        assert.ok(call?.target, name);
        assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === call.target)?.owner, owner, name);
    }
    assert.equal(new Set([forCall.target, stepCall.target, nextCall.target]).size, 3);
    const forInputs = analysis.expressionGraph.nodes[forCall.inputs[1] - 1];
    const nextInputs = analysis.expressionGraph.nodes[nextCall.inputs[1] - 1];
    assert.deepEqual(forInputs.inputs.slice(0, 2).map((id) => spelling(analysis.expressionGraph.nodes[id - 1])), ["current", "IteratorValue(1)"]);
    assert.deepEqual(nextInputs.inputs.map((id) => spelling(analysis.expressionGraph.nodes[id - 1])), ["current", "IteratorValue(2)", "IteratorValue(1)"]);
});

test("native UDT FOR initialization keeps written bound expressions at their source types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = [
        "Type IteratorValue",
        "    value As Long",
        "    Declare Constructor(ByVal initial As Long = 0)",
        "    Declare Operator For(ByRef stepValue As IteratorValue)",
        "    Declare Operator Step(ByRef stepValue As IteratorValue)",
        "    Declare Operator Next(ByRef finish As IteratorValue, ByRef stepValue As IteratorValue) As Integer",
        "End Type",
        "Constructor IteratorValue(ByVal initial As Long)",
        "    This.value = initial",
        "End Constructor",
        "Operator IteratorValue.For(ByRef stepValue As IteratorValue)",
        "End Operator",
        "Operator IteratorValue.Step(ByRef stepValue As IteratorValue)",
        "    This.value += stepValue.value",
        "End Operator",
        "Operator IteratorValue.Next(ByRef finish As IteratorValue, ByRef stepValue As IteratorValue) As Integer",
        "    Operator = This.value <= finish.value",
        "End Operator",
        "For current As IteratorValue = 0 To 2 Step 1",
        "Next"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, text]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/compiler-udt-for-types.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    const lines = text.split("\n");
    const line = lines.findIndex((value) => value.startsWith("For current As IteratorValue"));
    assert.ok(line >= 0);

    for (const spelling of ["0", "2", "1"]) {
        const column = lines[line].indexOf(spelling, spelling === "0" ? lines[line].indexOf("=") : 0);
        assert.ok(column >= 0, spelling);
        const fact = analysis.semanticExpressions.find((expression) => expression.physical &&
            expression.filePath === filePath && expression.startLine === line + 1 && expression.startColumn === column);
        assert.ok(fact, `compiler semantic sidecar must retain ${spelling}`);
        assert.equal(fact.typeName.toLowerCase(), "integer", spelling);
        const typed = model.expressionAt(sourceUri, { line, character: column }, { line, character: column + spelling.length });
        assert.equal(typed?.dtype, fact.dtype, spelling);
        assert.equal(typed?.typeName.toLowerCase(), "integer", spelling);
    }
});

test("native custom LET retains the selected assignment operator", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = [
        "Type AssignedValue",
        "    value As Long",
        "    Declare Constructor(ByVal initial As Long = 0)",
        "    Declare Operator Let(ByRef other As AssignedValue)",
        "End Type",
        "Constructor AssignedValue(ByVal initial As Long)",
        "    This.value = initial",
        "End Constructor",
        "Operator AssignedValue.Let(ByRef other As AssignedValue)",
        "    This.value = other.value",
        "End Operator",
        "Dim current As AssignedValue",
        "current = AssignedValue(7)"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    const assignment = analysis.expressionGraph.nodes.find((node) => node.kind === "call" && node.options === 2 && spelling(node) === "current = AssignedValue(7)");
    const owner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "ASSIGNEDVALUE")?.id;
    assert.ok(assignment?.target);
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === assignment.target)?.owner, owner);
    const operands = analysis.expressionGraph.nodes[assignment.inputs[1] - 1];
    assert.deepEqual(operands.inputs.slice(0, 2).map((id) => spelling(analysis.expressionGraph.nodes[id - 1])), ["current", "AssignedValue(7)"]);
});

test("native sidecar maps assignment and expression operands to exact operator hovers", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-assignment-hover-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "assignment-inputs.bas");
    const text = [
        "Sub Accumulate(ByVal amount As Double)",
        "    Dim total As Long",
        "    Dim computed As Double = amount + 2",
        "    Dim narrowed As Long = amount + 2",
        '    Dim message As String = "hello"',
        "    Dim conditional As Double = IIf(amount > 0, CLng(1), CDbl(2))",
        "    total += amount",
        "End Sub",
        "Function narrowReturn(ByVal returnValue As LongInt) As Byte",
        "    Return returnValue",
        "End Function",
        "Function narrowAssigned(ByVal assignedValue As LongInt) As Byte",
        "    narrowAssigned = assignedValue",
        "End Function",
        "Type HoverCompoundValue",
        "    value As Long",
        "    Declare Operator +=(ByVal amount As Long)",
        "End Type",
        "Operator HoverCompoundValue.+=(ByVal amount As Long)",
        "    This.value += amount",
        "End Operator",
        "Dim customTotal As HoverCompoundValue",
        "customTotal += 1",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        exportSemanticBindings: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    assert.equal(analysis.semanticCapabilities.find((capability) =>
        capability.feature === "parsed-expression-input-coverage")?.coverage, "available");
    assert.equal(analysis.semanticCapabilities.find((capability) =>
        capability.feature === "numeric-assignment-targets")?.coverage, "available");
    const lines = text.split("\n");
    const operatorLine = lines.findIndex((line) => line.includes("total += amount"));
    const operatorColumn = lines[operatorLine].indexOf("+=");
    const input = analysis.semanticAssignmentInputs.find((candidate) =>
        candidate.filePath === filePath && candidate.line === operatorLine && candidate.operatorCode === "add");
    assert.deepEqual({
        operatorKind: input?.operatorKind,
        leftTypeName: input?.leftTypeName,
        rightTypeName: input?.rightTypeName,
        resultTypeName: input?.resultTypeName,
        targetTypeName: input?.targetTypeName,
        line: input?.line
    }, { operatorKind: "builtin", leftTypeName: "long", rightTypeName: "double",
        resultTypeName: "double", targetTypeName: "long", line: operatorLine });

    const documentUri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/assignment-inputs.bas" },
        analysis,
        [{ uri: documentUri, text }]
    );
    const expressionLine = lines.findIndex((line) => line.includes("computed As Double = amount + 2"));
    const expressionOperatorColumn = lines[expressionLine].indexOf("+");
    const expressionFact = model.compilerSidecarFactAt(documentUri, {
        line: expressionLine, character: expressionOperatorColumn
    }, { line: expressionLine, character: expressionOperatorColumn });
    assert.equal(expressionFact?.sourceOperation?.inputCoverageAvailable, true);
    assert.deepEqual({
        operator: expressionFact?.sourceOperation?.operator,
        family: expressionFact?.sourceOperation?.family,
        leftTypeName: expressionFact?.sourceOperation?.leftTypeName,
        rightTypeName: expressionFact?.sourceOperation?.rightTypeName,
        resultTypeName: expressionFact?.sourceOperation?.resultTypeName
    }, {
        operator: "add", family: "binary", leftTypeName: "double", rightTypeName: "integer", resultTypeName: "double"
    });
    const expressionHover = queryCompilerModel(model, "hover", {
        uri: documentUri,
        position: { line: expressionLine, character: expressionOperatorColumn }
    }, () => {});
    assert.equal(expressionHover.expressionOperation?.sourceOperation?.operator, "add");
    assert.equal(expressionHover.expressionOperation?.sourceOperation?.leftTypeName, "double");

    const narrowedLine = lines.findIndex((line) => line.includes("narrowed As Long"));
    const narrowedColumn = lines[narrowedLine].lastIndexOf("+");
    const narrowedHover = queryCompilerModel(model, "hover", {
        uri: documentUri,
        position: { line: narrowedLine, character: narrowedColumn }
    }, () => {});
    assert.deepEqual({
        targetTypeName: narrowedHover.expression?.compilerAssignmentTarget?.targetTypeName,
        sourceTypeName: narrowedHover.expression?.compilerAssignmentTarget?.sourceTypeName,
        targetName: narrowedHover.expression?.compilerAssignmentTarget?.targetName,
        kind: narrowedHover.expression?.compilerAssignmentTarget?.kind
    }, { targetTypeName: "long", sourceTypeName: "double", targetName: "narrowed", kind: "initializer" });

    const messageLine = lines.findIndex((line) => line.includes('message As String = "hello"'));
    const messageColumn = lines[messageLine].indexOf('"hello"') + 1;
    const messageHover = queryCompilerModel(model, "hover", {
        uri: documentUri,
        position: { line: messageLine, character: messageColumn }
    }, () => {});
    assert.deepEqual({
        targetName: messageHover.expression?.compilerAssignmentTarget?.targetName,
        kind: messageHover.expression?.compilerAssignmentTarget?.kind
    }, { targetName: "message", kind: "initializer" });

    const returnLine = lines.findIndex((line) => line.includes("Return returnValue"));
    const returnColumn = lines[returnLine].indexOf("returnValue");
    const returnHover = queryCompilerModel(model, "hover", {
        uri: documentUri,
        position: { line: returnLine, character: returnColumn + 1 }
    }, () => {});
    assert.deepEqual({
        targetTypeName: returnHover.expression?.compilerAssignmentTarget?.targetTypeName,
        sourceTypeName: returnHover.expression?.compilerAssignmentTarget?.sourceTypeName,
        kind: returnHover.expression?.compilerAssignmentTarget?.kind
    }, { targetTypeName: "byte", sourceTypeName: "longint", kind: "return" });
    const resultAssignmentLine = lines.findIndex((line) => line.includes("narrowAssigned = assignedValue"));
    const resultAssignmentColumn = lines[resultAssignmentLine].indexOf("assignedValue");
    const resultAssignmentHover = queryCompilerModel(model, "hover", {
        uri: documentUri,
        position: { line: resultAssignmentLine, character: resultAssignmentColumn + 1 }
    }, () => {});
    assert.equal(resultAssignmentHover.expression?.compilerAssignmentTarget?.kind, "function-result-assignment");

    const iifLine = lines.findIndex((line) => line.includes("IIf(amount > 0"));
    const iifColumn = lines[iifLine].indexOf("IIf(");
    const iifHover = queryCompilerModel(model, "hover", {
        uri: documentUri,
        position: { line: iifLine, character: iifColumn + 1 }
    }, () => {});
    assert.deepEqual({
        trueType: iifHover.expression?.compilerIifInputs?.trueTypeName,
        falseType: iifHover.expression?.compilerIifInputs?.falseTypeName,
        resultType: iifHover.expression?.compilerIifInputs?.resultTypeName
    }, { trueType: "long", falseType: "double", resultType: "double" });

    const incompleteInputModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/incomplete-expression-inputs.bas" },
        {
            ...analysis,
            semanticExpressionOperands: analysis.semanticExpressionOperands.map((operation) =>
                operation.identity === expressionFact.sourceOperation.identity
                    ? { ...operation, inputCoverageAvailable: false }
                    : operation
            )
        },
        [{ uri: documentUri, text }]
    );
    const incompleteInputHover = queryCompilerModel(incompleteInputModel, "hover", {
        uri: documentUri,
        position: { line: expressionLine, character: expressionOperatorColumn }
    }, () => {});
    assert.equal(incompleteInputHover.expressionOperation, null,
        "compiler operation hovers must fail closed when the statement input receipt is unavailable");
    const hover = queryCompilerModel(model, "hover", {
        uri: documentUri,
        position: { line: operatorLine, character: operatorColumn + 1 }
    }, () => {});
    assert.equal(hover.assignmentInput?.operatorCode, "add");
    assert.equal(hover.assignmentInput?.rightTypeName, "double");

    const overloadedLine = lines.findIndex((line) => line.includes("customTotal += 1"));
    const overloadedColumn = lines[overloadedLine].indexOf("+=");
    const overloadedHover = queryCompilerModel(model, "hover", {
        uri: documentUri,
        position: { line: overloadedLine, character: overloadedColumn + 1 }
    }, () => {});
    assert.equal(overloadedHover.assignmentInput?.operatorKind, "overloaded");
    assert.equal(overloadedHover.assignmentInput?.operatorCode, "add");
});

test("native sidecar resolves a macro-backed optional default for parameter help", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-formal-default-help-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "formal-default-help.bas");
    const text = [
        "#define DEFAULT_COUNT 41",
        "Sub ConsumeCount(ByVal count As Long = DEFAULT_COUNT)",
        "End Sub",
        "Sub CallCount()",
        "    ConsumeCount()",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        exportSemanticBindings: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticCapabilities.find((capability) =>
        capability.feature === "formal-default-inputs")?.coverage, "available");
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/formal-default-help.bas" },
        analysis,
        [{ uri: CompilerUri.file(filePath), text }]
    );
    const procedure = model.inner.entries.find((entry) =>
        entry.declaration.type === "sub" && entry.name.toLowerCase() === "consumecount");
    const parameter = procedure?.declaration.parameters.find((candidate) => candidate.name === "count");
    assert.deepEqual({
        kind: parameter?.compilerDefaultValue?.kind,
        value: parameter?.compilerDefaultValue?.value
    }, { kind: "signed", value: "41" });
});

test("native sidecar explains the unevaluated input type of SIZEOF", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/size-query-inputs.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticBindings: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticCapabilities.find((capability) =>
        capability.feature === "size-query-inputs")?.coverage, "available");
    const sourceUri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/size-query-inputs.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    const lines = text.split(/\r\n|\n|\r/);
    const queryLine = lines.findIndex((line) => line.toLowerCase().includes("sizeof(make_pointer"));
    const queryColumn = lines[queryLine].toLowerCase().indexOf("sizeof");
    const hover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line: queryLine, character: queryColumn + 1 }
    }, () => {});
    assert.equal(hover.expression?.compilerSizeQuery?.inputTypeName, "long ptr");
    const arrayLine = lines.findIndex((line) => line.toLowerCase().includes("sizeof(addresses)"));
    const arrayColumn = lines[arrayLine].toLowerCase().indexOf("sizeof(addresses)");
    const arrayHover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line: arrayLine, character: arrayColumn + 1 }
    }, () => {});
    assert.equal(arrayHover.expression?.compilerSizeQuery?.inputKind, "array");
});

test("native sidecar reports FBC's converted LBOUND or UBOUND dimension", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/array-bound-query-inputs.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticBindings: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticCapabilities.find((capability) =>
        capability.feature === "array-bound-query-inputs")?.coverage, "available");
    const sourceUri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/array-bound-query-inputs.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    const lines = text.split(/\r\n|\n|\r/);
    const queryLine = lines.findIndex((line) => line.includes("UBound(matrixValues, 1.6)"));
    const queryColumn = lines[queryLine].indexOf("UBound");
    const hover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line: queryLine, character: queryColumn + 1 }
    }, () => {});
    assert.deepEqual({
        kind: hover.expression?.compilerArrayBoundQuery?.kind,
        sourceTypeName: hover.expression?.compilerArrayBoundQuery?.sourceTypeName,
        selectedValue: hover.expression?.compilerArrayBoundQuery?.selectedValue
    }, { kind: "upper", sourceTypeName: "double", selectedValue: { kind: "signed", value: "2" } });
});

test("native sidecar retains original operands for explicit conversion hovers", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/numeric-assignment-targets.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticBindings: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticCapabilities.find((capability) =>
        capability.feature === "explicit-cast-inputs")?.coverage, "available");
    const sourceUri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/explicit-cast-inputs.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    const lines = text.split(/\r\n|\n|\r/);
    const castLine = lines.findIndex((line) => line.toLowerCase().includes("cint(source_value + 0.5)"));
    const castColumn = lines[castLine].toLowerCase().indexOf("cint");
    const hover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line: castLine, character: castColumn + 1 }
    }, () => {});
    assert.deepEqual({
        family: hover.expressionOperation?.sourceOperation?.family,
        operator: hover.expressionOperation?.sourceOperation?.operator,
        inputTypeName: hover.expressionOperation?.sourceOperation?.leftTypeName,
        resultTypeName: hover.expressionOperation?.sourceOperation?.resultTypeName
    }, { family: "cast", operator: "cast", inputTypeName: "double", resultTypeName: "integer" });
});

test("native sidecar reports the compiler-emitted target units for wide string literals", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/target-wide-prefixes.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);

    const sourceUri = CompilerUri.file(filePath);
    const sourceLines = text.split(/\r\n|\n|\r/);
    const line = sourceLines.findIndex((sourceLine) => sourceLine.includes('U0001F600'));
    const character = sourceLines[line].indexOf("U0001F600") + 2;
    const wideExpression = analysis.semanticExpressions.filter((expression) => expression.physical &&
        expression.filePath === filePath && expression.startLine === line + 1 &&
        String(expression.typeName || "").toLowerCase() === "wstring" && expression.startColumn <= character &&
        expression.endColumn > character).sort((first, second) =>
        (first.endColumn - first.startColumn) - (second.endColumn - second.startColumn))[0];
    assert.ok(wideExpression?.symbol > 0);
    const sourceContext = analysis.semanticSourceContexts.find((context) => context.id === wideExpression.sourceContextId);
    assert.ok(sourceContext?.module > 0);
    const properties = new Map(analysis.semanticProperties.filter((property) => property.domain === "symbol" &&
        property.module === sourceContext.module && property.identity === wideExpression.symbol)
        .map((property) => [property.name, property.value]));
    const prefix = properties.get("literal-target-wide-prefix");
    assert.equal(typeof prefix, "string");

    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/target-wide-prefixes.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    const hover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line, character }
    }, () => {});
    const targetLiteral = hover.targetWideLiteral;
    const unitBytes = Number(properties.get("literal-target-wide-unit-bytes"));
    const expectedUnits = prefix.match(/.{8}/g).slice(0, 8).map((unit) => unit.slice(-unitBytes * 2));
    assert.deepEqual({
        unitBytes: targetLiteral?.unitBytes,
        kind: targetLiteral?.kind,
        unitCount: targetLiteral?.unitCount,
        units: targetLiteral?.units
    }, {
        unitBytes,
        kind: properties.get("literal-target-wide-kind"),
        unitCount: prefix.length / 8,
        units: expectedUnits
    });
    const wideCallColumn = sourceLines[line].toLowerCase().lastIndexOf("wstr", character);
    const typeExpression = queryCompilerModel(model, "expression", {
        uri: sourceUri,
        position: { line, character: wideCallColumn + 1 }
    }, () => {});
    assert.ok(typeExpression);
    assert.deepEqual(typeExpression.targetWideLiteral, targetLiteral,
        "the expression-type command query should retain target representation details");
});

test("native sidecar explains FBC's selected integer conversion for a floating array index", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/array-subscript-inputs.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticBindings: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticCapabilities.find((capability) =>
        capability.feature === "array-subscript-inputs")?.coverage, "available");
    const sourceUri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/array-subscript-inputs.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    const lines = text.split(/\r\n|\n|\r/);
    const indexLine = lines.findIndex((line) => line.includes("fixedValues(floatingIndex)"));
    const indexColumn = lines[indexLine].indexOf("floatingIndex");
    const hover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line: indexLine, character: indexColumn + 1 }
    }, () => {});
    assert.deepEqual({
        sourceTypeName: hover.expression?.compilerArrayIndex?.sourceTypeName,
        targetTypeName: hover.expression?.compilerArrayIndex?.targetTypeName
    }, { sourceTypeName: "double", targetTypeName: "integer" });
});

test("native sidecar reports compiler-selected types for coerced binary operands", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/numeric-selected-operands.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticBindings: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticCapabilities.find((capability) =>
        capability.feature === "selected-numeric-operands")?.coverage, "available");
    const sourceUri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/numeric-selected-operands.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    const lines = text.split(/\r\n|\n|\r/);
    const comparisonLine = lines.findIndex((line) => line.includes("signed_value < unsigned_value"));
    const operatorColumn = lines[comparisonLine].indexOf("<");
    const hover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line: comparisonLine, character: operatorColumn }
    }, () => {});
    assert.deepEqual({
        sourceLeft: hover.expressionOperation?.sourceOperation?.leftTypeName,
        sourceRight: hover.expressionOperation?.sourceOperation?.rightTypeName,
        selectedLeft: hover.expression?.compilerNumericOperands?.selectedLeftTypeName,
        selectedRight: hover.expression?.compilerNumericOperands?.selectedRightTypeName
    }, { sourceLeft: "long", sourceRight: "ulong", selectedLeft: "integer", selectedRight: "integer" });
});

test("native sidecar reports SELECT CASE jump-table and comparison lowering", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/select-case-lowering.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    assert.ok(analysis.semanticCapabilities.some((capability) =>
        capability.feature === "select-case-lowering-inputs" && capability.coverage === "available"));

    const input = analysis.semanticProperties.find((property) => property.domain === "symbol" &&
        property.name.startsWith("select-case-input:") && property.value.split("\t")[3] === "constant");
    assert.ok(input);
    const construct = input.name.match(/^select-case-input:([1-9]\d*)$/)?.[1];
    const table = analysis.semanticProperties.find((property) => property.domain === "symbol" &&
        property.module === input.module && property.identity === input.identity &&
        property.name === `select-case-table:${construct}`);
    assert.ok(table);
    const inputFields = input.value.split("\t");
    const tableFields = table.value.split("\t");
    const expression = analysis.semanticExpressions.find((candidate) =>
        candidate.id === Number(inputFields[1]) && candidate.physical && candidate.filePath === filePath);
    assert.ok(expression, "the selected CASE input must join to a physical typed selector expression");

    const sourceUri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/select-case-lowering.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    const hover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line: expression.startLine - 1, character: expression.startColumn }
    }, () => {});
    assert.deepEqual(hover.selectCaseLowering, {
        kind: "jump-table",
        entries: Number(tableFields[4]),
        slots: Number(tableFields[3]) + 1
    });

    const normalInput = analysis.semanticProperties.find((property) => {
        if (property.domain !== "symbol" || !property.name.startsWith("select-case-input:")) return false;
        const fields = property.value.split("\t");
        if (fields[3] !== "normal") return false;
        const constructId = property.name.match(/^select-case-input:([1-9]\d*)$/)?.[1];
        return analysis.semanticProperties.some((candidate) => candidate.domain === "symbol" &&
            candidate.module === property.module && candidate.identity === property.identity &&
            candidate.name.startsWith("select-case-comparison:") &&
            candidate.value.split("\t")[0] === constructId);
    });
    assert.ok(normalInput);
    const normalConstruct = normalInput.name.match(/^select-case-input:([1-9]\d*)$/)?.[1];
    const normalExpressionId = Number(normalInput.value.split("\t")[1]);
    const normalExpression = analysis.semanticExpressions.find((candidate) =>
        candidate.id === normalExpressionId && candidate.physical && candidate.filePath === filePath);
    assert.ok(normalExpression);
    const comparisonCount = analysis.semanticProperties.filter((property) => property.domain === "symbol" &&
        property.module === normalInput.module && property.identity === normalInput.identity &&
        property.name.startsWith("select-case-comparison:") &&
        property.value.split("\t")[0] === normalConstruct).length;
    const normalHover = queryCompilerModel(model, "hover", {
        uri: sourceUri,
        position: { line: normalExpression.startLine - 1, character: normalExpression.startColumn }
    }, () => {});
    assert.deepEqual(normalHover.selectCaseLowering, { kind: "comparisons", count: comparisonCount });
});

test("native custom combined assignment retains the selected operator", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = [
        "Type IncrementedValue",
        "    value As Long",
        "    Declare Operator +=(ByVal amount As Long)",
        "End Type",
        "Operator IncrementedValue.+=(ByVal amount As Long)",
        "    This.value += amount",
        "End Operator",
        "Dim current As IncrementedValue",
        "current += 7"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    const assignment = analysis.expressionGraph.nodes.find((node) => node.kind === "call" && node.options === 2 && spelling(node) === "current += 7");
    const owner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "INCREMENTEDVALUE")?.id;
    assert.ok(assignment?.target);
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === assignment.target)?.owner, owner);
    const operands = analysis.expressionGraph.nodes[assignment.inputs[1] - 1];
    assert.deepEqual(operands.inputs.slice(0, 2).map((id) => spelling(analysis.expressionGraph.nodes[id - 1])), ["current", "7"]);
    const fallback = analysis.expressionGraph.nodes.find((node) => node.kind === "binary" && spelling(node) === "This.value += amount");
    assert.ok(fallback, "A non-overloaded combined assignment must retain its computed value relationship.");
    assert.equal(fallback.target, 0);
    assert.deepEqual(fallback.inputs.slice(0, 2).map((id) => spelling(analysis.expressionGraph.nodes[id - 1])), ["This.value", "amount"]);
});

test("native assignment conversion retains the selected cast operator", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = [
        "Type SourceValue",
        "    value As Long",
        "    Declare Operator Cast() As Long",
        "End Type",
        "Operator SourceValue.Cast() As Long",
        "    Return 7",
        "End Operator",
        "Dim source As SourceValue",
        "Dim destination As Long",
        "destination = source"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    const converted = analysis.expressionGraph.nodes.find((node) => node.kind === "call" && spelling(node) === "source" && node.typeName.toLowerCase() === "long");
    const owner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "SOURCEVALUE")?.id;
    assert.ok(converted?.target, "The implicit assignment conversion must retain its selected cast operator.");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === converted.target)?.owner, owner);
    assert.equal(analysis.expressionGraph.nodes[converted.inputs[0] - 1]?.typeName.toLowerCase(), "sourcevalue");
});

test("native branch conversion retains the selected cast operator", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = [
        "Type ConditionValue",
        "    value As Long",
        "    Declare Operator Cast() As Integer",
        "End Type",
        "Operator ConditionValue.Cast() As Integer",
        "    Return This.value",
        "End Operator",
        "Dim condition As ConditionValue",
        "If condition Then",
        "    Print 1",
        "End If"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    const converted = analysis.expressionGraph.nodes.find((node) => node.kind === "call" && spelling(node) === "condition" && node.typeName.toLowerCase() === "integer");
    const owner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "CONDITIONVALUE")?.id;
    assert.ok(converted?.target, "The implicit branch conversion must retain its selected cast operator.");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === converted.target)?.owner, owner);
    assert.equal(analysis.expressionGraph.nodes[converted.inputs[0] - 1]?.typeName.toLowerCase(), "conditionvalue");
});

test("native graphics image statements retain their implicit UDT pointer cast", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = [
        "Type GraphicsImageValue",
        "    buffer As Any Ptr",
        "    Declare Operator Cast() As Any Ptr",
        "End Type",
        "Operator GraphicsImageValue.Cast() As Any Ptr",
        "    Operator = This.buffer",
        "End Operator",
        "Dim imageValue As GraphicsImageValue",
        "Line imageValue, (0, 0) - (1, 1), 1"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, text]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    const owner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "GRAPHICSIMAGEVALUE");
    assert.ok(owner, "The fixture must expose its image UDT");
    const implicitCast = analysis.expressionGraph.nodes.find((node) => node.kind === "call" && spelling(node) === "imageValue");
    assert.ok(implicitCast, "The graphics statement's implicit image conversion must retain its selected cast target");
    const cast = analysis.symbolGraph.symbols.find((symbol) => symbol.id === implicitCast.target);
    assert.ok(cast, "The compiler-selected cast must retain its native symbol");
    assert.equal(cast.owner, owner.id);
    assert.equal(implicitCast.typeName.toLowerCase(), "any ptr");
    assert.equal(analysis.expressionGraph.nodes[implicitCast.inputs[0] - 1]?.typeName.toLowerCase(), "graphicsimagevalue");

    const sourceUri = uri(filePath);
    const line = text.split("\n").findIndex((value) => value.startsWith("Line imageValue"));
    const startColumn = text.split("\n")[line].indexOf("imageValue");
    const start = { line, character: startColumn };
    const end = { line, character: startColumn + "imageValue".length };
    const fact = analysis.semanticExpressions.find((expression) => expression.physical && expression.filePath === filePath &&
        expression.startLine === line + 1 && expression.startColumn === startColumn && expression.endColumn === end.character);
    assert.equal(fact?.typeName.toLowerCase(), "graphicsimagevalue", "The source expression keeps its declared UDT type");
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/graphics-image-cast.bas" },
        analysis,
        [{ uri: sourceUri, text }]
    );
    assert.equal(model.expressionAtTraceOnly(sourceUri, start, end)?.typeName.toLowerCase(), "graphicsimagevalue");
    const typed = model.expressionAt(sourceUri, start, end);
    assert.equal(typed?.typeName.toLowerCase(), "graphicsimagevalue");
});

test("native quirk expression families retain exact types and runtime helper targets", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-quirk-expressions.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || ""), "inc")],
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    const sourceDocuments = analysis.dependencies.map((dependency) => ({
        uri: uri(dependency),
        text: path.resolve(dependency) === filePath ? text
            : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
    }));
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/quirk-expressions.bas" }, analysis, sourceDocuments);
    const sidecarOnly = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/quirk-expressions-sidecar.bas" },
        { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
        sourceDocuments
    );
    const lines = text.split("\n");
    const typeOf = (expression) => {
        const statement = `Print ${expression}`;
        const line = lines.indexOf(statement);
        assert.ok(line >= 0, expression);
        const start = { line, character: 6 };
        const end = { line, character: statement.length };
        const trace = model.expressionAt(uri(filePath), start, end);
        const semantic = sidecarOnly.expressionAt(uri(filePath), start, end);
        assert.ok(trace, `${expression}: bridge trace expression`);
        assert.equal(semantic?.semanticSource, "compiler-sidecar", `${expression}: compiler semantic expression`);
        assert.equal(semantic?.typeName.toLowerCase(), trace.typeName.toLowerCase(), `${expression}: sidecar and bridge types agree`);
        return semantic.typeName.toLowerCase();
    };
    for (const [expression, type] of [
        ["CVL(encoded)", "long"], ["CVD(number)", "double"], ["CVS(number)", "single"],
        ["CVI(number)", "integer"], ["CVL(number)", "long"], ["CVLONGINT(number)", "longint"],
        ["CVSHORT(encoded)", "short"], ["CVD(encoded)", "double"], ["CVS(encoded)", "single"],
        ["CVI(encoded)", "integer"], ["CVI<16>(encoded)", "short"], ["CVI<32>(encoded)", "long"],
        ["CVI<64>(encoded)", "longint"], ["CVLONGINT(encoded)", "longint"],
        ["MKL(number)", "string"], ["Str(number)", "string"], ["Sqr(number)", "double"],
        ["MKD(number)", "string"], ["MKS(number)", "string"], ["MKI(number)", "string"],
        ["MKI<16>(number)", "string"], ["MKI<32>(number)", "string"], ["MKI<64>(number)", "string"],
        ["MKSHORT(number)", "string"], ["MKLONGINT(number)", "string"],
        ["LBound(values)", "integer"], ["Seek(1)", "longint"], ["Err", "long"], ["Color()", "ulong"],
        ["View Print()", "long"], ["Width()", "long"], ["Screen(0, 0)", "ulong"], ["Point(0, 0)", "ulong"], ["ImageCreate(1, 1)", "any ptr"], ["Music Status()", "long"], ["Capture Available()", "long"],
        ["Device Select(0)", "long"], ["IIf(number > 0, number, 0)", "integer"],
        ["Asc(encoded)", "ulong"], ["Asc(encoded, 1)", "ulong"],
        ["Chr(number)", "string"], ["WChr(number)", "wstring"],
        ["String(2, number)", "string"], ["String(2, \"x\")", "string"], ["CByte(number)", "byte"],
        ["Peek(UByte, 0)", "ubyte"],
        ["Mid(encoded, 1, 1)", "string"], ["Mid(encoded, 1)", "string"],
        ["Instr(encoded, \"x\")", "integer"], ["Instr(1, encoded, \"x\")", "integer"],
        ["Instr(1, encoded, Any \"x\")", "integer"], ["InStrRev(encoded, \"x\")", "integer"],
        ["InStrRev(encoded, Any \"x\", 1)", "integer"],
        ["Trim(encoded)", "string"], ["Trim(encoded, Any \"x\")", "string"],
        ["LTrim(encoded)", "string"], ["LTrim(encoded, Any \"x\")", "string"],
        ["RTrim(encoded)", "string"], ["RTrim(encoded, Any \"x\")", "string"],
        ["LCase(encoded)", "string"], ["LCase(encoded, 1)", "string"],
        ["UCase(encoded)", "string"], ["UCase(encoded, 1)", "string"],
        ["WStr(encoded)", "wstring"], ["WStr(number)", "wstring"], ["WString(2, number)", "wstring"],
        ["Atan2(number, number)", "double"], ["UBound(values)", "integer"], ["Timer", "double"], ["Inkey", "string"]
    ]) assert.equal(typeOf(expression), type, expression);
    const parserFamilies = new Map([
        ["CVL(encoded)", "cCVXFunct"], ["Str(number)", "cStringFunct"], ["Sqr(number)", "cMathFunct"],
        ["LBound(values)", "cArrayFunct"], ["Seek(1)", "cFileFunct"], ["Err", "cErrorFunct"],
        ["Color()", "cColorStmt"], ["View Print()", "cViewStmt"], ["Width()", "cWidthStmt"],
        ["Screen(0, 0)", "cScreenFunct"], ["Point(0, 0)", "cGfxFunct"], ["Music Status()", "cSfxFunct"],
        ["IIf(number > 0, number, 0)", "cIIFFunct"], ["CByte(number)", "cTypeConvExpr"],
        ["Peek(UByte, 0)", "cPeekFunct"],
        ["cva_arg(arguments, Integer)", "cVALISTFunct"]
    ]);
    for (const [expression, family] of parserFamilies) {
        const node = analysis.expressionGraph.nodes.find((candidate) => {
            const line = analysis.text.split("\n")[candidate.start.line] || "";
            return candidate.kind === "syntax" && line.slice(candidate.start.character, candidate.end.character) === expression;
        });
        assert.equal(node?.family, family, expression);
    }
    const serialization = analysis.expressionGraph.nodes.find((node) =>
        node.kind === "syntax" && (node.families || []).includes("cSerializationFunct"));
    assert.equal(serialization?.typeName.toLowerCase(), "string",
        "the compiler bridge should retain the result type for the macro-expanded serialization intrinsic");
    const serializationLine = analysis.text.split("\n")[serialization.start.line] || "";
    assert.equal(serializationLine.slice(serialization.start.character, serialization.end.character), "__FB_SERIALIZE(number)",
        "the parser-family trace should span the complete expanded intrinsic call");
    const nodeFamilies = (node) => node.families || (node.family ? [node.family] : []);
    const observedFamilies = new Set(analysis.expressionGraph.nodes.flatMap(nodeFamilies));
    const sampledFamilies = analysis.expressionGraph.nodes.flatMap(nodeFamilies);
    assert.equal(new Set(sampledFamilies).size, sampledFamilies.length, "Each parser family must add only one bounded provenance record per compiler invocation.");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-va-first-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const vaFirstPath = path.join(directory, "va-first.bas");
    const vaFirstText = "Sub ReadVa Cdecl(ByVal fixed As Integer, ...)\n Dim firstArgument As Any Ptr = va_first()\n Print firstArgument\nEnd Sub\n";
    fs.writeFileSync(vaFirstPath, vaFirstText);
    const vaFirst = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath: vaFirstPath,
        compilerArguments: ["-arch", "x86_64", "-gen", "gas64"],
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.ok(!vaFirst.partial, "The gas backend must retain a valid VA_FIRST expression.");
    const vaFirstUri = uri(vaFirstPath);
    const vaFirstModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/va-first-sidecar.bas" },
        { ...vaFirst, expressions: [], expressionGraph: { nodes: [] } },
        [{ uri: vaFirstUri, text: vaFirstText }]
    );
    const vaFirstLine = vaFirstText.split("\n").findIndex((line) => line.includes("va_first()"));
    const vaFirstColumn = vaFirstText.split("\n")[vaFirstLine].indexOf("va_first()");
    const vaFirstType = vaFirstModel.expressionAt(vaFirstUri,
        { line: vaFirstLine, character: vaFirstColumn },
        { line: vaFirstLine, character: vaFirstColumn + "va_first()".length });
    assert.equal(vaFirstType?.semanticSource, "compiler-sidecar", "VA_FIRST result must use compiler semantic data");
    assert.equal(vaFirstType?.typeName.toLowerCase(), "any ptr");
    const vaFirstFamilies = vaFirst.expressionGraph.nodes.flatMap(nodeFamilies);
    assert.equal(new Set(vaFirstFamilies).size, vaFirstFamilies.length);
    for (const node of vaFirst.expressionGraph.nodes) for (const family of nodeFamilies(node)) observedFamilies.add(family);
    for (const family of QUIRK_EXPRESSION_FOCUSED_FAMILIES) assert.ok(observedFamilies.has(family), `${family} focused fixture`);
    /* The successful cQuirkFunction dispatcher routes into a more specific
       wrapped parser family, so its generic tag is not stable in this fixture. */
    const coveredHere = QUIRK_EXPRESSION_FAMILIES.filter((family) => !["cAnonType", "cOperatorNew", "cThreadCallFunc", "cQuirkFunction"].includes(family));
    for (const family of coveredHere) assert.ok(observedFamilies.has(family), family);
    const runtimeTargets = new Map([
        ["CVL(encoded)", "FB_CVL"], ["CVD(number)", "FB_CVDFROMLONGINT"], ["CVS(number)", "FB_CVSFROML"],
        ["CVI(number)", "FB_CVLONGINTFROMD"], ["CVL(number)", "FB_CVLFROMS"],
        ["CVLONGINT(number)", "FB_CVLONGINTFROMD"],
        ["CVSHORT(encoded)", "FB_CVSHORT"], ["CVD(encoded)", "FB_CVD"], ["CVS(encoded)", "FB_CVS"],
        ["CVI(encoded)", "FB_CVLONGINT"], ["CVI<16>(encoded)", "FB_CVSHORT"], ["CVI<32>(encoded)", "FB_CVL"],
        ["CVI<64>(encoded)", "FB_CVLONGINT"], ["CVLONGINT(encoded)", "FB_CVLONGINT"],
        ["MKL(number)", "FB_MKL"], ["MKD(number)", "FB_MKD"], ["MKS(number)", "FB_MKS"],
        ["MKI(number)", "FB_MKI"], ["MKI<16>(number)", "FB_MKSHORT"], ["MKI<32>(number)", "FB_MKL"],
        ["MKI<64>(number)", "FB_MKLONGINT"], ["MKSHORT(number)", "FB_MKSHORT"],
        ["MKLONGINT(number)", "FB_MKLONGINT"], ["Str(number)", "FB_INTTOSTR"],
        ["Seek(1)", "FB_FILETELL"], ["Err", "FB_ERRORGETNUM"], ["Color()", "FB_COLOR"],
        ["View Print()", "FB_CONSOLEVIEW"], ["Width()", "FB_WIDTH"],
        ["Screen(0, 0)", "FB_READXY"], ["Point(0, 0)", "FB_GFXPOINT"], ["ImageCreate(1, 1)", "FB_GFXIMAGECREATE"], ["Music Status()", "FB_SFXMUSICSTATUS"],
        ["Capture Available()", "FB_SFXCAPTUREAVAILABLE"], ["Device Select(0)", "FB_SFXDEVICESELECT"],
        ["Asc(encoded)", "FB_ASC"], ["Asc(encoded, 1)", "FB_ASC"], ["Chr(number)", "FB_CHR"], ["WChr(number)", "FB_WSTRCHR"],
        ["String(2, number)", "FB_STRFILL1"], ["String(2, \"x\")", "FB_STRFILL2"],
        ["Mid(encoded, 1, 1)", "FB_STRMID"], ["Mid(encoded, 1)", "FB_STRMID"],
        ["Instr(encoded, \"x\")", "FB_STRINSTR"], ["Instr(1, encoded, \"x\")", "FB_STRINSTR"],
        ["Instr(1, encoded, Any \"x\")", "FB_STRINSTRANY"],
        ["InStrRev(encoded, \"x\")", "FB_STRINSTRREV"], ["InStrRev(encoded, Any \"x\", 1)", "FB_STRINSTRREVANY"],
        ["Trim(encoded)", "FB_TRIM"], ["Trim(encoded, Any \"x\")", "FB_TRIMANY"],
        ["LTrim(encoded)", "FB_LTRIM"], ["LTrim(encoded, Any \"x\")", "FB_LTRIMANY"],
        ["RTrim(encoded)", "FB_RTRIM"], ["RTrim(encoded, Any \"x\")", "FB_RTRIMANY"],
        ["LCase(encoded)", "FB_STRLCASE2"], ["LCase(encoded, 1)", "FB_STRLCASE2"],
        ["UCase(encoded)", "FB_STRUCASE2"], ["UCase(encoded, 1)", "FB_STRUCASE2"],
        ["WStr(encoded)", "FB_STRTOWSTR"], ["WStr(number)", "FB_INTTOWSTR"], ["WString(2, number)", "FB_WSTRFILL1"],
        ["Atan2(number, number)", "{ATAN2}"], ["Timer", ["TIMER", 1]], ["Inkey", ["INKEY", 1]]
    ]);
    for (const node of analysis.expressionGraph.nodes.filter((node) => node.kind === "call")) {
        const line = analysis.text.split("\n")[node.start.line] || "";
        const expression = line.slice(node.start.character, node.end.character);
        if (!runtimeTargets.has(expression)) continue;
        const expected = runtimeTargets.get(expression);
        const [name, options] = Array.isArray(expected) ? expected : [expected, 2];
        assert.equal(node.options, options, expression);
        assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === node.target)?.name, name, expression);
        runtimeTargets.delete(expression);
    }
    assert.deepEqual([...runtimeTargets.keys()], []);
    const cvaStatement = "Print cva_arg(arguments, Integer)";
    const cvaLine = lines.findIndex((line) => line.trim() === cvaStatement);
    assert.ok(cvaLine >= 0, cvaStatement);
    const cvaStart = lines[cvaLine].indexOf("cva_arg");
    assert.equal(model.expressionAt(uri(filePath), { line: cvaLine, character: cvaStart }, { line: cvaLine, character: cvaStart + "cva_arg(arguments, Integer)".length })?.typeName.toLowerCase(), "integer");
    const intrinsic = analysis.expressionGraph.nodes.find((node) => {
        const line = analysis.text.split("\n")[node.start.line] || "";
        return node.kind === "call" && node.target === 0 && line.slice(node.start.character, node.end.character) === "arguments";
    });
    assert.ok(intrinsic, "CVA_ARG must retain its cva_list dependency without fabricating a procedure target.");
    assert.equal(analysis.expressionGraph.nodes[intrinsic.inputs[0] - 1]?.typeName.toLowerCase(), "__va_list_tag");
});

test("native expression surface retains exact address, conversion, allocation, math, and file types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/expression-surface.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const lines = text.split("\n");
    const typeOf = (expression) => {
        const statement = `Print ${expression}`;
        const line = lines.indexOf(statement);
        assert.ok(line >= 0, expression);
        const result = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: statement.length });
        assert.ok(result?.compilerExpressionId, expression);
        assert.equal(result.provisional, false, expression);
        return result.typeName.toLowerCase();
    };
    for (const [expression, type] of [
        ["Len(encoded)", "integer"], ["SizeOf(number)", "integer"],
        ["SAdd(encoded)", "zstring * 8 const ptr"], ["StrPtr(encoded)", "zstring * 8 const ptr"],
        ["VarPtr(number)", "long ptr"], ["ProcPtr(NumberFunction)", "function() as long"],
        ["Cast(Double, number)", "double"], ["CPtr(Long Ptr, ptrValue)", "long ptr"], ["CInt<16>(number)", "short"], ["CUInt<32>(number)", "ulong"],
        ["*CPtr(Long Ptr, ptrValue)", "long"], ["New Long", "long ptr"], ["New Long[2]", "long ptr"],
        ["Abs(number)", "integer"], ["Int(number)", "integer"], ["Fix(number)", "integer"],
        ["Frac(number)", "integer"], ["Rnd()", "double"], ["Command()", "string"],
        ["Environ(\"PATH\")", "string"], ["Dir()", "string"], ["Exepath()", "string"],
        ["CurDir()", "string"], ["Date()", "string"], ["Time()", "string"]
    ]) assert.equal(typeOf(expression), type, expression);
    const lenLine = lines.indexOf("Print Len(encoded)");
    const typeLayoutInput = analysis.expressionGraph.nodes.find((node) => {
        if (node.kind !== "syntax" || analysis.origins[node.start.line]?.line !== lenLine) return false;
        const output = analysis.text.split("\n")[node.start.line] || "";
        return output.slice(node.start.character, node.end.character) === "encoded";
    });
    assert.ok((typeLayoutInput?.families || [typeLayoutInput?.family]).includes("cTypeOrExpression"), "LEN() must retain its type-or-expression parser route on the written input");
});

test("native context-sensitive type-layout expressions retain their parser routes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/context-sensitive-types.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const lines = text.split("\n");
    const nodeFor = (line, spelling, family) => analysis.expressionGraph.nodes.find((node) => {
        if (node.kind !== "syntax" || analysis.origins[node.start.line]?.line !== line || !(node.families || [node.family]).includes(family)) return false;
        return analysis.text.split("\n")[node.start.line]?.slice(node.start.character, node.end.character) === spelling;
    });
    const fixedLine = lines.indexOf("Dim fixedName As ZString * (2 + 3)");
    const signedLine = lines.indexOf("Print CInt<16>(number)");
    const unsignedLine = lines.indexOf("Print CUInt<32>(number)");
    assert.ok(nodeFor(fixedLine, "(2 + 3)", "cEqInParensOnlyExpr"));
    assert.ok(nodeFor(signedLine, "16", "cGtInParensOnlyExpr"));
    for (const [line, expression, type] of [[fixedLine, "(2 + 3)", "integer"], [signedLine, "CInt<16>(number)", "short"], [unsignedLine, "CUInt<32>(number)", "ulong"]]) {
        const character = lines[line].indexOf(expression);
        assert.equal(model.expressionAt(uri(filePath), { line, character }, { line, character: character + expression.length })?.typeName.toLowerCase(), type, expression);
    }
});

test("native type-layout parser provenance covers LEN, SIZEOF, and TYPEOF expression inputs", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    for (const [name, text, line, prefix, spelling] of [
        ["LEN", "Dim value As String = \"text\"\nPrint Len(value)\n", 1, "Len(", "value"],
        ["SIZEOF", "Dim value As Double\nPrint SizeOf(value)\n", 1, "SizeOf(", "value"],
        ["TYPEOF", "Dim sourceValue As Long = 1\nDim derived As TypeOf(sourceValue) = sourceValue\nPrint derived\n", 1, "TypeOf(", "sourceValue"]
    ]) {
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
        const sourceLine = text.split("\n")[line];
        const start = sourceLine.indexOf(spelling, sourceLine.indexOf(prefix) + prefix.length);
        const node = analysis.expressionGraph.nodes.find((candidate) => {
            if (candidate.kind !== "syntax" || analysis.origins[candidate.start.line]?.line !== line || candidate.start.character !== start) return false;
            const output = analysis.text.split("\n")[candidate.start.line] || "";
            return output.slice(candidate.start.character, candidate.end.character) === spelling;
        });
        assert.ok(node, name);
        assert.ok((node.families || [node.family]).includes("cTypeOrExpression"), name);
    }
});

test("native compound expressions retain every tested member, index, and call prefix", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-chains.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/chains.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const lines = text.split("\n");
    const chains = [
        ["roots(0)", ".child", ".leaves(1)"],
        ["rootPointer[0]", ".child", ".leaves(1)"],
        ["rootPointer", "->child", ".GetLeaf(0)"],
        ["MakeRoot()", ".child", ".leaves(0)"],
        ["CPtr(TreeTypes.Root Ptr, rootPointer)", "->child", ".GetLeaf(0)"],
        ["(*rootPointer)", ".child", ".GetLeaf(0)"],
        ["callback()", "->child", ".leaves(0)"],
        ["(**doublePointer)", ".child", ".leaves(0)"],
        ["TreeTypes.globalRoot", ".child", ".leaves(0)"]
    ];
    for (const parts of chains) {
        const statement = "Print " + parts.join("") + ".amount";
        const line = lines.indexOf(statement);
        assert.ok(line >= 0, statement);
        let prefix = "";
        for (const [index, part] of [...parts, ".amount"].entries()) {
            prefix += part;
            const expression = model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 6 + prefix.length });
            assert.ok(expression?.compilerExpressionId, prefix);
            assert.match(expression.typeName.toLowerCase(), [/(?:root(?: ptr)?)$/, /branch$/, /leaf$/, /^double$/][index], prefix);
        }
    }
    const observedFamilies = new Set(analysis.expressionGraph.nodes.flatMap((node) => node.families || (node.family ? [node.family] : [])));
    /* These parser helpers return expressions committed by deeper routines.
       Protocol 12 keeps that source route on the existing node, rather than
       manufacturing duplicate syntax ranges for the coverage report. */
    for (const family of ["cExpressionWithNIDXARRAY", "cFuncPtrOrMemberDeref", "cMethodCall", "cStrIdxOrMemberDeref", "cWithVariable", "cVariable", "cImplicitDataMember", "cVarOrDeref"]) {
        assert.ok(observedFamilies.has(family), family);
    }
    assert.ok(!analysis.expressions.some((expression) => analysis.text.split("\n")[expression.start.line].slice(expression.start.character, expression.end.character) === "GetLeaf(0).amount"), "A method fragment without its receiver is not a standalone expression");
    const indirect = analysis.expressionGraph.nodes.find((node) => node.kind === "call" && analysis.text.split("\n")[node.start.line].slice(node.start.character, node.end.character) === "callback()");
    assert.equal(indirect.target, 0, "The bridge must not invent a static target for an indirect call");
    assert.equal(indirect.options, 1);
    assert.match(analysis.expressionGraph.nodes[indirect.inputs[0] - 1].typeName, /^function\(/i);
});

test("native declaration construction retains selected default constructors", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-declarations.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const type = analysis.symbolGraph.symbols.find((symbol) => symbol.symbolClass === 10 && symbol.name.toLowerCase() === "constructedvalue");
    const constructor = analysis.symbolGraph.symbols.find((symbol) => symbol.symbolClass === 3 && symbol.owner === type?.id);
    assert.ok(type?.id);
    assert.ok(constructor?.id, "The compiler-selected default constructor must be exported.");

    const lines = analysis.text.split("\n");
    const spelling = (node) => lines[node.start.line]?.slice(node.start.character, node.end.character);
    const generated = analysis.expressionGraph.nodes.filter((node) => node.kind === "call" && node.options === 2 && node.target === constructor.id);
    assert.deepEqual(generated.map(spelling).sort(), ["items", "scalar"],
        "A scalar and each fixed-array declaration project one default-construction relationship; an unallocated dynamic array does not.");
    for (const node of generated) {
        assert.deepEqual(node.inputs, [0, 0, 0], "A declaration-triggered call has no written callee or argument nodes.");
        assert.equal(node.typeName.toLowerCase(), "constructedvalue");
    }
    assert.equal(analysis.expressionGraph.nodes.some((node) => node.kind === "call" && node.target === constructor.id && spelling(node) === "deferred"), false);
    for (const [oldName, newName, symbolClass] of [["scalar", "longScalar", 1], ["ConstructedValue", "RenamedValue", 10]]) {
        const symbol = analysis.symbolGraph.symbols.find((entry) => entry.symbolClass === symbolClass && entry.name.toLowerCase() === oldName.toLowerCase());
        assert.ok(symbol, `The declaration symbol for ${oldName} must be exported.`);
        const renamedText = text.replaceAll(oldName, newName);
        const renamed = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            overlays: new Map([[filePath, renamedText]])
        });
        assert.deepEqual(expressionGraphSignature(analysis, new Set([symbol.id]), newName), expressionGraphSignature(renamed),
            `Default-constructor provenance must remain stable when renaming ${oldName}.`);
    }
});

test("native conversion and operator-call graphs preserve written operand types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/transforms.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const nodes = analysis.expressionGraph.nodes;
    const output = analysis.text.split("\n");
    const spelling = (node) => output[node.start.line].slice(node.start.character, node.end.character);
    const prefix = "CLng(1) + CLng(2)";
    const conversion = nodes.find((node) => node.kind === "conversion" && spelling(node) === prefix && node.typeName.toLowerCase() === "double");
    assert.ok(conversion);
    assert.equal(nodes[conversion.inputs[0] - 1].typeName.toLowerCase(), "integer");
    const line = text.split("\n").findIndex((line) => line.startsWith("Print " + prefix));
    assert.equal(model.expressionAt(uri(filePath), { line, character: 6 }, { line, character: 6 + prefix.length }).typeName.toLowerCase(), "integer");
    const call = nodes.find((node) => node.kind === "call" && spelling(node) === "packets(0) + packets(0)");
    assert.ok(call?.inputs[0] && call.inputs[1]);
    assert.equal(call.options, 0);
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === call.target).symbolClass, 3);
    assert.equal(call.typeName.toLowerCase(), "packet");
    assert.deepEqual((await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath })).expressionGraph, analysis.expressionGraph);
});

test("native operation graphs retain folded operands, arbitrary call arity, and repeated dereferences", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-operations.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/operations.bas" }, analysis, [{ uri: uri(filePath), text }]);
    const nodes = analysis.expressionGraph.nodes;
    const output = analysis.text.split("\n");
    const spelling = (node) => node && node.start.line === node.end.line ? output[node.start.line].slice(node.start.character, node.end.character) : "";
    const find = (kind, expression) => nodes.find((node) => node.kind === kind && spelling(node) === expression);
    const binary = find("binary", "1 + 2 * 3");
    assert.ok(binary, "Constant folding must preserve the committed binary operation");
    assert.deepEqual(binary.inputs.slice(0, 2).map((id) => spelling(nodes[id - 1])), ["1", "2 * 3"]);
    const multiply = find("binary", "2 * 3");
    assert.deepEqual(multiply.inputs.slice(0, 2).map((id) => spelling(nodes[id - 1])), ["2", "3"]);
    for (const [expression, type] of [
        ["7 Mod 3", "integer"], ["7 \\ 3", "integer"], ["2 ^ 3", "double"], ["1 Shl 2", "integer"],
        ["1 And 3", "integer"], ["1 Or 3", "integer"], ["1 Xor 3", "integer"], ["1 Eqv 1", "integer"],
        ["0 Imp 1", "integer"], ["1 AndAlso 0", "integer"], ["1 Orelse 0", "integer"], ["runtimeValue Is RuntimeChild", "long"]
    ]) assert.equal(find("syntax", expression)?.typeName.toLowerCase(), type, expression);
    for (const family of ["cModExpression", "cIntDivExpression", "cExpExpression", "cShiftExpression", "cLogAndExpression", "cLogOrExpression", "cLogExpression", "cBoolExpression", "cIsExpression"]) {
        assert.ok(nodes.some((node) => (node.families || [node.family]).includes(family)), family);
    }
    const observedFamilies = new Set(nodes.flatMap((node) => node.families || (node.family ? [node.family] : [])));
    for (const family of ["cExpression", "cCatExpression", "cRelExpression", "cAddExpression", "cMultExpression", "cNegNotExpression", "cHighestPrecExpr", "cAtom", "cConstant", "cNumLiteral", "cStrLiteral", "cFunctionEx", "cAddrOfExpression", "cDerefExpression"]) {
        assert.ok(observedFamilies.has(family), family);
    }
    const unary = find("unary", "(1 + 2)");
    assert.equal(spelling(nodes[unary.inputs[0] - 1]), "(1 + 2)");
    for (const [body, operands, expected] of [["value > 0, 1, 2.5", ["value > 0", "1", "2.5"], "double"], ["1, 2, 3.5", ["1", "2", "3.5"], "integer"]]) {
        const conditional = find("conditional", body);
        assert.ok(conditional, body);
        assert.deepEqual(conditional.inputs.map((id) => spelling(nodes[id - 1])), operands);
        assert.equal(conditional.typeName.toLowerCase(), expected, "The compiler's constant-condition rule differs from ordinary IIf promotion");
    }
    function argumentsOf(call) {
        assert.ok(call, "The source call must be exported");
        const arguments_ = [];
        for (let id = call.inputs[1]; id;) {
            const arg = nodes[id - 1];
            assert.equal(arg.kind, "argument");
            arguments_.unshift(arg);
            id = arg.inputs[0];
        }
        return arguments_;
    }
    const direct = find("call", "Combine(CLng(1) + 2, 3, value, 4)");
    const directArgs = argumentsOf(direct);
    assert.deepEqual(directArgs.map((arg) => arg.options), [1, 2, 3, 4, 5]);
    assert.deepEqual(directArgs.slice(0, 4).map((arg) => spelling(nodes[arg.inputs[1] - 1])), ["CLng(1) + 2", "3", "value", "4"]);
    assert.equal(nodes[directArgs[0].inputs[2] - 1].typeName.toLowerCase(), "double");
    assert.equal(directArgs[4].inputs[1], 0, "An omitted default is not a fabricated written argument");
    const indirect = find("call", "callback(1, 2, value, 4, 5)");
    assert.equal(indirect.target, 0);
    assert.deepEqual(argumentsOf(indirect).map((arg) => spelling(nodes[arg.inputs[1] - 1])), ["1", "2", "value", "4", "5"]);
    const statement = find("call", "Observe 2.5, Combine(1, 2, value), value");
    assert.equal(argumentsOf(statement).length, 3);
    assert.ok(statement.target);
    assert.equal(argumentsOf(find("call", "Combine(1, 2, value)")).length, 5);
    const castConversion = nodes.find((node) => node.kind === "conversion" && spelling(node) === "castableValue" && node.typeName.toLowerCase() === "long");
    assert.ok(castConversion?.inputs[2], "An overloaded cast must retain its lowered conversion call.");
    const castCall = nodes[castConversion.inputs[2] - 1];
    assert.equal(castCall.kind, "call");
    const castTarget = analysis.symbolGraph.symbols.find((symbol) => symbol.id === castCall.target);
    assert.equal(castTarget?.symbolClass, 3);
    assert.equal(castTarget?.owner, analysis.symbolGraph.symbols.find((symbol) => symbol.name === "CASTABLE")?.id);
    const printedCast = find("call", "printableValue");
    assert.equal(printedCast?.typeName.toLowerCase(), "string");
    const printedCastTarget = analysis.symbolGraph.symbols.find((symbol) => symbol.id === printedCast.target);
    assert.equal(printedCastTarget?.symbolClass, 3);
    assert.equal(printedCastTarget?.owner, analysis.symbolGraph.symbols.find((symbol) => symbol.name === "PRINTABLE")?.id);
    const overloadedUnary = nodes.find((node) => node.kind === "unary" && spelling(nodes[node.inputs[0] - 1]) === "negativeInstance");
    assert.ok(overloadedUnary?.inputs[2], "An overloaded unary expression must retain its selected operator call.");
    const unaryCall = nodes[overloadedUnary.inputs[2] - 1];
    assert.equal(unaryCall?.kind, "call");
    const unaryTarget = analysis.symbolGraph.symbols.find((symbol) => symbol.id === unaryCall.target);
    assert.equal(unaryTarget?.symbolClass, 3);
    assert.equal(unaryTarget?.subtype, analysis.symbolGraph.symbols.find((symbol) => symbol.name === "NEGATIVEVALUE")?.id);
    for (const expression of ["New Long", "New Long[value]"]) {
        const allocation = find("syntax", expression);
        assert.equal(allocation?.typeName.toLowerCase(), "long ptr", expression);
    }
    const assignment = find("call", "firstAssignable = secondAssignable");
    assert.equal(assignment?.options, 0);
    const assignmentTarget = analysis.symbolGraph.symbols.find((symbol) => symbol.id === assignment.target);
    assert.equal(assignmentTarget?.symbolClass, 3);
    assert.equal(assignmentTarget?.owner, analysis.symbolGraph.symbols.find((symbol) => symbol.name === "ASSIGNABLE")?.id);
    const overloadedIndexLine = text.split("\n").indexOf("Print indexedInstance[0]");
    const overloadedIndexText = "indexedInstance[0]";
    const overloadedIndex = model.expressionAt(uri(filePath), { line: overloadedIndexLine, character: 6 }, { line: overloadedIndexLine, character: 6 + overloadedIndexText.length });
    assert.equal(overloadedIndex?.typeName.toLowerCase(), "double", "An overloaded [] expression keeps the selected result type.");
    const overloadedIndexCall = nodes.find((node) => node.kind === "call" && spelling(node) === "indexedInstance[0");
    assert.ok(overloadedIndexCall?.target, "An overloaded [] expression must retain its compiler-selected operator.");
    const overloadedIndexTarget = analysis.symbolGraph.symbols.find((symbol) => symbol.id === overloadedIndexCall.target);
    assert.equal(overloadedIndexTarget?.symbolClass, 3);
    assert.equal(overloadedIndexTarget?.owner, analysis.symbolGraph.symbols.find((symbol) => symbol.name === "INDEXEDVALUE")?.id);
    assert.deepEqual(overloadedIndexCall.inputs.slice(0, 2).map((id) => spelling(nodes[id - 1])), ["indexedInstance", "0"]);
    const overloadedDerefLine = text.split("\n").indexOf("Print smartInstance->amount");
    const overloadedDerefText = "smartInstance->amount";
    const overloadedDeref = model.expressionAt(uri(filePath), { line: overloadedDerefLine, character: 6 }, { line: overloadedDerefLine, character: 6 + overloadedDerefText.length });
    assert.equal(overloadedDeref?.typeName.toLowerCase(), "double", "An overloaded -> expression keeps the selected member type.");
    const overloadedDerefCall = nodes.find((node) => node.kind === "call" && analysis.origins[node.start.line]?.line === overloadedDerefLine && spelling(node) === "smartInstance");
    assert.ok(overloadedDerefCall?.target, "An overloaded -> expression must retain its compiler-selected operator.");
    const overloadedDerefTarget = analysis.symbolGraph.symbols.find((symbol) => symbol.id === overloadedDerefCall.target);
    assert.equal(overloadedDerefTarget?.symbolClass, 3);
    assert.equal(overloadedDerefTarget?.typeName, "SMARTVALUE");
    const overloadedAddressLine = text.split("\n").indexOf("Print (@addressableInstance)->amount");
    const overloadedAddressText = "@addressableInstance";
    const overloadedAddress = model.expressionAt(uri(filePath), { line: overloadedAddressLine, character: 7 }, { line: overloadedAddressLine, character: 7 + overloadedAddressText.length });
    assert.equal(overloadedAddress?.typeName.toLowerCase(), "addressablevalue ptr", "An overloaded @ expression keeps the selected pointer type.");
    const overloadedAddressCall = nodes.find((node) => node.kind === "call" && analysis.origins[node.start.line]?.line === overloadedAddressLine && spelling(node) === "addressableInstance");
    assert.ok(overloadedAddressCall?.target, "An overloaded @ expression must retain its compiler-selected operator.");
    const overloadedAddressTarget = analysis.symbolGraph.symbols.find((symbol) => symbol.id === overloadedAddressCall.target);
    assert.equal(overloadedAddressTarget?.symbolClass, 3);
    assert.equal(overloadedAddressTarget?.typeName, "ADDRESSABLEVALUE ptr");
    const varPtrLine = text.split("\n").indexOf("Print CPtr(AddressableValue Ptr, VarPtr(addressableInstance))->amount");
    const varPtrText = "VarPtr(addressableInstance)";
    const varPtrStart = "Print CPtr(AddressableValue Ptr, ".length;
    const varPtrExpression = model.expressionAt(uri(filePath), { line: varPtrLine, character: varPtrStart }, { line: varPtrLine, character: varPtrStart + varPtrText.length });
    assert.equal(varPtrExpression?.typeName.toLowerCase(), "addressablevalue ptr", "VARPTR must retain its overloaded pointer result type.");
    const varPtrCall = nodes.find((node) => node.kind === "call" && analysis.origins[node.start.line]?.line === varPtrLine && spelling(node) === "addressableInstance");
    assert.equal(varPtrCall?.target, overloadedAddressCall.target, "VARPTR must retain the same selected address operator as @.");
    const copiedOwner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "COPIEDVALUE")?.id;
    for (const expression of ["sourceCopy", "source"]) {
        const copyConstructor = nodes.find((node) => node.kind === "call" && node.options === 0 && spelling(node) === expression && analysis.symbolGraph.symbols.find((symbol) => symbol.id === node.target)?.owner === copiedOwner);
        assert.ok(copyConstructor?.target, `The copy constructor must remain connected to ${expression}.`);
    }
    const copiedArgumentLine = text.split("\n").indexOf("ObserveCopiedValue sourceCopy");
    const copiedArgumentConstructor = nodes.find((node) => node.kind === "call" && node.options === 0 && analysis.origins[node.start.line]?.line === copiedArgumentLine && spelling(node) === "sourceCopy" && analysis.symbolGraph.symbols.find((symbol) => symbol.id === node.target)?.owner === copiedOwner);
    assert.ok(copiedArgumentConstructor?.target, "A BYVAL UDT argument must retain its selected copy constructor.");
    const copiedArgumentCall = find("call", "ObserveCopiedValue sourceCopy");
    assert.deepEqual(argumentsOf(copiedArgumentCall).map((argument) => spelling(nodes[argument.inputs[1] - 1])), ["sourceCopy"]);
    const copiedArgumentConversion = nodes[argumentsOf(copiedArgumentCall)[0].inputs[2] - 1];
    assert.equal(copiedArgumentConversion?.kind, "conversion", "The BYVAL temporary is represented as the compiler's pointer conversion.");
    const copiedArgumentConversionCall = nodes[copiedArgumentConversion.inputs[0] - 1];
    assert.equal(copiedArgumentConversionCall?.kind, "call", "The written BYVAL argument must retain its converted copy-construction edge.");
    assert.equal(copiedArgumentConversionCall.target, copiedArgumentConstructor.target);
    const copiedArgumentStart = "ObserveCopiedValue ".length;
    const copiedArgumentExpression = model.expressionAt(uri(filePath), { line: copiedArgumentLine, character: copiedArgumentStart }, { line: copiedArgumentLine, character: copiedArgumentStart + "sourceCopy".length });
    assert.equal(copiedArgumentExpression?.typeName.toLowerCase(), "copiedvalue", "Compiler-created BYVAL temporaries must not replace the written operand type.");
    assert.equal(copiedArgumentExpression.provisional, false);
    const castArgumentLine = text.split("\n").indexOf("ObserveCast castableValue");
    const castArgumentCall = find("call", "ObserveCast castableValue");
    const [castArgument] = argumentsOf(castArgumentCall);
    const castArgumentSelected = nodes[castArgument.inputs[2] - 1];
    assert.equal(castArgumentSelected?.kind, "call");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === castArgumentSelected.target)?.owner, analysis.symbolGraph.symbols.find((symbol) => symbol.name === "CASTABLE")?.id);
    const castArgumentExpression = model.expressionAt(uri(filePath), { line: castArgumentLine, character: "ObserveCast ".length }, { line: castArgumentLine, character: "ObserveCast castableValue".length });
    assert.equal(castArgumentExpression?.typeName.toLowerCase(), "castable", "The written argument keeps its source type after parameter conversion.");
    assert.equal(castArgumentExpression.provisional, false);
    const byrefConstructorOwner = analysis.symbolGraph.symbols.find((symbol) => symbol.name === "BYREFCONSTRUCTED")?.id;
    const byrefConstructor = nodes.find((node) => node.kind === "call" && node.options === 0 && spelling(node) === "9" && analysis.symbolGraph.symbols.find((symbol) => symbol.id === node.target)?.owner === byrefConstructorOwner);
    assert.ok(byrefConstructor?.target, "A BYREF UDT argument must retain its selected implicit constructor.");
    const byrefArgumentCall = find("call", "ObserveByRefConstructed 9");
    const [byrefArgument] = argumentsOf(byrefArgumentCall);
    assert.equal(nodes[byrefArgument.inputs[1] - 1]?.typeName.toLowerCase(), "integer", "The written BYREF conversion operand remains an integer.");
    const byrefArgumentConversion = nodes[byrefArgument.inputs[2] - 1];
    assert.equal(byrefArgumentConversion?.kind, "conversion", "The compiler-created BYREF temporary is represented as a pointer conversion.");
    assert.equal(nodes[byrefArgumentConversion.inputs[0] - 1]?.target, byrefConstructor.target, "The converted BYREF argument must retain the selected constructor.");
    const conditionalCopy = find("conditional", "value > 0, sourceCopy, sourceCopy");
    assert.ok(conditionalCopy, "A UDT conditional must retain its complete source branches.");
    assert.deepEqual(conditionalCopy.inputs.map((id) => spelling(nodes[id - 1])), ["value > 0", "sourceCopy", "sourceCopy"]);
    const conditionalCopyConstructors = nodes.filter((node) => node.kind === "call" && node.options === 0 && node.start.line === conditionalCopy.start.line && spelling(node) === "sourceCopy" && analysis.symbolGraph.symbols.find((symbol) => symbol.id === node.target)?.owner === copiedOwner);
    assert.equal(conditionalCopyConstructors.length, 2, "Each UDT IIf branch must retain its compiler-selected copy constructor.");
    const chainedConstructor = find("call", "Constructor()");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === chainedConstructor?.target)?.owner, analysis.symbolGraph.symbols.find((symbol) => symbol.name === "CHAINEDVALUE")?.id);
    const baseConstructor = find("call", "Base()");
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === baseConstructor?.target)?.owner, analysis.symbolGraph.symbols.find((symbol) => symbol.name === "BASECHAIN")?.id);
    const line = text.split("\n").indexOf("Print **doublePointer");
    for (const [character, expected] of [[8, "long ptr ptr"], [7, "long ptr"], [6, "long"]]) {
        const expression = model.expressionAt(uri(filePath), { line, character }, { line, character: "Print **doublePointer".length });
        assert.ok(expression?.compilerExpressionId);
        assert.equal(expression.typeName.toLowerCase(), expected);
    }
    const repeated = "Print (********************chainValue).value";
    const repeatedLine = text.split("\n").indexOf(repeated);
    for (let character = 7; character < 27; character++) {
        const expression = model.expressionAt(uri(filePath), { line: repeatedLine, character }, { line: repeatedLine, character: repeated.indexOf(")") });
        assert.ok(expression?.compilerExpressionId, repeated.slice(character, repeated.indexOf(")")));
        assert.equal(expression.typeName.toLowerCase(), "chain");
    }
    const partial = text.replace("    Print first; second; third", "    Print first +");
    const recovered = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, partial]]), allowErrors: true });
    assert.ok(recovered.partial);
    const recoveredModel = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/operations-recovery.bas" }, recovered, [{ uri: uri(filePath), text: partial }]);
    const callText = "Combine(CLng(1) + 2, 3, value, 4)";
    const callLine = partial.split("\n").indexOf("Print " + callText);
    const retained = recoveredModel.expressionAt(uri(filePath), { line: callLine, character: 6 }, { line: callLine, character: 6 + callText.length });
    assert.equal(retained?.typeName.toLowerCase(), "double", "An unrelated bad procedure body must not invalidate another call's default arguments");
    assert.equal(retained.provisional, false);
});

test("real compiler selects branches and expands declaration macros", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-context.bas");
    const source = fs.readFileSync(filePath, "utf8");
    for (const alternate of [false, true]) {
        const result = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, compilerArguments: alternate ? ["-d", "ALTERNATE"] : [] });
        assert.match(result.text, /Dim Shared selected As SelectedType/i);
        assert.ok(result.origins.some((origin) => origin?.generated));
        assert.ok(result.dependencies.some((file) => file.endsWith("compiler-defines.bi")), "Macro-only includes must invalidate snapshots");
        assert.equal(result.text.includes("primaryValue"), !alternate);
        assert.equal(result.text.includes("alternateValue"), alternate);
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/real.bas" }, result, result.dependencies.map((file) => ({ uri: uri(file), text: fs.readFileSync(file, "utf8") })));
        const line = source.split("\n").findIndex((text) => text === `Print selected.${alternate ? "alternateValue" : "primaryValue"}`);
        assert.equal(model.resolveAt(uri(filePath), line, 8)[0]?.name.toLowerCase(), "selected");
        assert.equal(model.completeMembers(uri(filePath), line, 15)[0]?.name, alternate ? "alternateValue" : "primaryValue");
    }
});

test("real compiler expands multiline macros without assigning guessed source columns", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-macro-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "macro.bas");
    fs.writeFileSync(filePath, '#macro MAKE_RECORD(name)\nType name\n value As Long\nEnd Type\n#endmacro\nMAKE_RECORD(GeneratedRecord)\nDim item As GeneratedRecord\nPrint item.value\n');
    const result = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
    assert.match(result.text, /Type GeneratedRecord/i);
    const declarationLine = result.text.split("\n").findIndex((line) => /Type GeneratedRecord/i.test(line));
    assert.equal(result.origins[declarationLine].generated, true);
});

test("bridge preprocessing without tracing preserves normal output", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-plain-pp-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const outputPath = path.join(directory, "plain.pp.bas");
    for (const name of ["compiler-context.bas", "compiler-overloads.bas", "compiler-dispatch.bas", "compiler-reference-forms.bas", "compiler-forward-types.bas", "compiler-expression-chains.bas", "compiler-types.bas", "compiler-expression-operations.bas", "compiler-origins.bas", "compiler-macro-origins.bas"]) {
        const filePath = path.resolve(__dirname, "integration/workspace", name);
        const execution = await executeBoundedProcess({ command: process.env.FBC_EDITOR_EXECUTABLE, arguments: ["-pp", "-o", outputPath, filePath], cwd: directory, env: { ...process.env, FB_VSCODE_TRACE: "0" }, timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
        assert.equal(execution.exitCode, 0, execution.stderr + execution.stdout);
        const plain = fs.readFileSync(outputPath, "utf8");
        assert.equal(plain.includes("@fb-editor"), false);
        const originalCompiler = process.env.FBC_EXECUTABLE || path.join(resolveFreeBasicRoot(), "bin/fbc");
        const original = await executeBoundedProcess({ command: originalCompiler, arguments: ["-pp", "-o", outputPath, filePath], cwd: directory, timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
        assert.equal(original.exitCode, 0, original.stderr + original.stdout);
        assert.equal(fs.readFileSync(outputPath, "utf8"), plain, "Trace-disabled output must match the unmodified compiler");
        const traced = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath });
        const nonempty = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        assert.deepEqual(nonempty(plain), nonempty(traced.text));
    }
});

/* end of tests/compiler-analysis.test.js */
