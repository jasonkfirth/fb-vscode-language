/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tools/audit-native-matrix.js

    Purpose:

        Run one named native corpus profile across its supported target matrix.

    Responsibilities:

        - keep cross-target compiler audits reproducible
        - compare direct and prepared-worker semantic coverage
        - fail the matrix if any target has missing models or compiler parity

    This file intentionally does NOT contain:

        - compiler instrumentation
        - source edits or fixture generation
        - inferred type rules or editor feature policy
*/

const path = require("path");
const { auditNativeCorpus, ARCHITECTURE_ARGUMENTS, CATEGORIES, LANGUAGE_MODE_ARGUMENTS } = require("./audit-native-corpus");
const { resolveFreeBasicRoot } = require("./audit-freebasic-coverage");

const IMPLICIT_CALL_CATEGORIES = Object.freeze([
    "compound", "dim", "expressions", "functions", "namespace", "overload", "pointers",
    "pp", "qb", "scopes", "structs", "typedef", "virtual", "visibility"
]);

const MATRIX_PROFILES = Object.freeze({
    qb: Object.freeze({
        languageMode: "qb",
        categories: Object.freeze(["qb"]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"])
    }),
    "qb-full": Object.freeze({
        languageMode: "qb",
        categories: Object.freeze([...CATEGORIES]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        defaultTimeoutMs: 60000
    }),
    "fb-expressions": Object.freeze({
        languageMode: "fb",
        categories: Object.freeze(["expressions", "compound", "overload", "pointers", "structs", "numbers", "string"]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        requireAllGenericExpressionRoutes: true,
        defaultTimeoutMs: 60000
    }),
    "fb-implicit-calls": Object.freeze({
        languageMode: "fb",
        categories: IMPLICIT_CALL_CATEGORIES,
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        semanticBindings: true,
        requireAllImplicitCallKinds: true,
        defaultTimeoutMs: 60000
    }),
    "fblite-implicit-calls": Object.freeze({
        languageMode: "fblite",
        categories: IMPLICIT_CALL_CATEGORIES,
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        semanticBindings: true,
        requiredImplicitCallKinds: Object.freeze(["default-constructor", "destructor-call"]),
        defaultTimeoutMs: 60000
    }),
    "deprecated-implicit-calls": Object.freeze({
        languageMode: "deprecated",
        categories: IMPLICIT_CALL_CATEGORIES,
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        semanticBindings: true,
        requiredImplicitCallKinds: Object.freeze(["default-constructor", "destructor-call"]),
        defaultTimeoutMs: 60000
    }),
    "qb-implicit-calls": Object.freeze({
        languageMode: "qb",
        categories: Object.freeze(["dim", "functions", "structs"]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        semanticBindings: true,
        requiredImplicitCallKinds: Object.freeze(["destructor-call"]),
        defaultTimeoutMs: 60000
    }),
    "fb-full": Object.freeze({
        languageMode: "fb",
        categories: Object.freeze([...CATEGORIES]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        defaultTimeoutMs: 60000
    }),
    "fblite-full": Object.freeze({
        languageMode: "fblite",
        categories: Object.freeze([...CATEGORIES]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        defaultTimeoutMs: 60000
    }),
    "fblite-expressions": Object.freeze({
        languageMode: "fblite",
        categories: Object.freeze(["expressions", "compound", "overload", "pointers", "structs", "numbers", "string"]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        requireAllGenericExpressionRoutes: true,
        defaultTimeoutMs: 60000
    }),
    "deprecated-expressions": Object.freeze({
        languageMode: "deprecated",
        categories: Object.freeze(["expressions", "compound", "overload", "pointers", "structs", "numbers", "string"]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        requireAllGenericExpressionRoutes: true,
        defaultTimeoutMs: 60000
    }),
    "deprecated-full": Object.freeze({
        languageMode: "deprecated",
        categories: Object.freeze([...CATEGORIES]),
        architectures: Object.freeze(["x86-32", "x86-64", "aarch64"]),
        defaultTimeoutMs: 60000
    })
});

function parseMatrixArguments(arguments_) {
    const profiles = arguments_.filter((argument) => argument.startsWith("--profile="));
    const timeouts = arguments_.filter((argument) => argument.startsWith("--timeout-ms="));
    const unknown = arguments_.filter((argument) => !argument.startsWith("--profile=") && !argument.startsWith("--timeout-ms="));
    if (unknown.length) throw new Error(`Unknown native matrix arguments: ${unknown.join(", ")}`);
    if (profiles.length !== 1) throw new Error("Choose exactly one native matrix profile.");
    if (timeouts.length > 1) throw new Error("Choose at most one native matrix analysis timeout.");

    const profileName = profiles[0].slice("--profile=".length).toLowerCase();
    const profile = MATRIX_PROFILES[profileName];
    if (!profile) throw new Error(`Unknown native matrix profile: ${profileName}`);

    let timeoutMs = profile.defaultTimeoutMs || 10000;
    if (timeouts.length) {
        const value = timeouts[0].slice("--timeout-ms=".length);
        timeoutMs = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
            throw new Error("Native matrix analysis timeout must be an integer from 1 to 300000 milliseconds.");
        }
    }

    return { profileName, profile, timeoutMs };
}

function summarizeSemanticCoverage(coverage) {
    if (!coverage) return null;
    const fields = [
        "files", "expressions", "compared", "directiveExpressions", "traceMissing",
        "traceTypeMismatches", "supplemented", "overridden", "ambiguous", "missing",
        "typeMismatches", "sidecarOnlyCompared", "sidecarOnlyAvailable",
        "sidecarOnlyAmbiguous", "sidecarOnlyMissing", "sidecarOnlyTypeMismatches",
        "sidecarOnlyStatusMismatches", "recoveryFiles", "recoveryFacts", "recoverySafeFacts",
        "recoverySidecarOnlyCompared", "recoverySidecarOnlyAvailable", "recoverySidecarOnlyAmbiguous",
        "recoverySidecarOnlyMissing", "recoverySidecarOnlyTypeMismatches",
        "recoverySidecarOnlyUnprovisional", "recoveryMissing", "recoveryTypeMismatches",
        "recoveryUnprovisional", "recoveryUnsafeRetained"
    ];
    return Object.fromEntries(fields.map((field) => [field, coverage[field]]));
}

function summarizeSemanticBindingCoverage(coverage) {
    if (!coverage) return null;
    return {
        files: coverage.files,
        bindings: coverage.bindings,
        nonPhysicalBindings: coverage.nonPhysicalBindings,
        implicitCalls: coverage.implicitCalls,
        nonPhysicalImplicitCalls: coverage.nonPhysicalImplicitCalls,
        callsByKind: coverage.callsByKind,
        supportedCallKinds: coverage.supportedCallKinds,
        exercisedCallKinds: coverage.exercisedCallKinds,
        missingCallKinds: coverage.missingCallKinds,
        unexpectedCallKinds: coverage.unexpectedCallKinds,
        invalidRecordCounts: coverage.invalidRecordCounts,
        missingSources: coverage.missingSources,
        outOfBoundsRanges: coverage.outOfBoundsRanges,
        invalidPhysicalRanges: coverage.invalidPhysicalRanges,
        invalidSignatures: coverage.invalidSignatures
    };
}

function hasExpressionCoverageGap(coverage) {
    if (!coverage) return true;
    return coverage.missingSyntax !== 0 || coverage.typeMismatches !== 0 ||
        coverage.provisionalMissingTypes !== 0 || coverage.unmarkedRecoveryTypes !== 0 ||
        coverage.missingTypes !== coverage.invalidMissingTypes;
}

function hasSemanticCoverageGap(coverage, expectedFiles) {
    if (!coverage || coverage.files !== expectedFiles || coverage.expressions === 0) return true;
    const zeroRequired = [
        "missing", "typeMismatches", "sidecarOnlyMissing", "sidecarOnlyTypeMismatches",
        "sidecarOnlyStatusMismatches", "recoverySidecarOnlyMissing",
        "recoverySidecarOnlyTypeMismatches", "recoverySidecarOnlyUnprovisional",
        "recoveryMissing", "recoveryTypeMismatches", "recoveryUnprovisional",
        "recoveryUnsafeRetained"
    ];
    return zeroRequired.some((field) => coverage[field] !== 0);
}

function hasSemanticBindingCoverageGap(coverage, expectedFiles, requirements = false) {
    if (!coverage || coverage.files !== expectedFiles) return true;
    const requireAllImplicitCallKinds = typeof requirements === "boolean"
        ? requirements
        : requirements?.requireAllImplicitCallKinds === true;
    const requiredCallKinds = typeof requirements === "object" && Array.isArray(requirements?.requiredImplicitCallKinds)
        ? requirements.requiredImplicitCallKinds
        : [];
    const zeroRequired = [
        "invalidRecordCounts", "missingSources", "outOfBoundsRanges", "invalidPhysicalRanges", "invalidSignatures"
    ];
    if (zeroRequired.some((field) => coverage[field] !== 0)) return true;
    if (!Array.isArray(coverage.supportedCallKinds) || !coverage.supportedCallKinds.length ||
        !Array.isArray(coverage.exercisedCallKinds) || !Array.isArray(coverage.unexpectedCallKinds) ||
        !Array.isArray(coverage.missingCallKinds) || coverage.unexpectedCallKinds.length) return true;
    const missingRequiredCallKind = requiredCallKinds.some((kind) => !coverage.exercisedCallKinds.includes(kind));
    return missingRequiredCallKind || requireAllImplicitCallKinds && (
        coverage.missingCallKinds.length !== 0 ||
        coverage.exercisedCallKinds.length !== coverage.supportedCallKinds.length
    );
}

function summarizeProfile(architecture, report, error = null, requirements = {}) {
    const failures = report?.failures || [];
    const routeCoverage = report?.expressionParserCoverage;
    const requireAllGenericExpressionRoutes = requirements.requireAllGenericExpressionRoutes === true;
    const semanticBindings = requirements.semanticBindings === true;
    const missingRequiredRoute = requireAllGenericExpressionRoutes && (
        !routeCoverage || !Number.isSafeInteger(routeCoverage.total) || routeCoverage.total < 1 ||
        routeCoverage.exercised !== routeCoverage.total || !Array.isArray(routeCoverage.unexercised) ||
        routeCoverage.unexercised.length !== 0
    );
    const semanticCoverageGap = semanticBindings
        ? hasSemanticBindingCoverageGap(report?.semanticBindingCoverage, report?.files, requirements)
        : hasSemanticCoverageGap(report?.semanticSidecarCoverage, report?.files);
    const complete = Boolean(!error && report && report.files === report.parity && report.models === report.files &&
        report.preparedModels === report.files && report.boundedAnalysis === 0 &&
        report.incompleteAnalysis === 0 && failures.length === 0 &&
        !hasExpressionCoverageGap(report.expressionCoverage) &&
        !semanticCoverageGap &&
        !missingRequiredRoute);
    return {
        architecture,
        passed: complete,
        error: error?.message,
        files: report?.files || 0,
        complete: report?.complete || 0,
        partial: report?.partial || 0,
        parity: report?.parity || 0,
        models: report?.models || 0,
        preparedModels: report?.preparedModels || 0,
        preparedSemanticTokens: report?.preparedSemanticTokens || 0,
        boundedAnalysis: report?.boundedAnalysis || 0,
        incompleteAnalysis: report?.incompleteAnalysis || 0,
        expressionCoverage: report?.expressionCoverage || null,
        /* Keep route reachability visible in per-target matrix summaries. */
        expressionParserCoverage: report?.expressionParserCoverage || null,
        quirkExpressionCoverage: report?.quirkExpressionCoverage || null,
        exceptionalExpressionCoverage: report?.exceptionalExpressionCoverage || null,
        typeLayoutExpressionCoverage: report?.typeLayoutExpressionCoverage || null,
        semanticSidecarCoverage: summarizeSemanticCoverage(report?.semanticSidecarCoverage),
        semanticBindingCoverage: summarizeSemanticBindingCoverage(report?.semanticBindingCoverage),
        failures
    };
}

async function runNativeMatrix(options) {
    const root = options.root;
    const editorCompiler = options.editorCompiler;
    const originalCompiler = options.originalCompiler || path.join(root, "bin", "fbc");
    const outcomes = [];
    for (const architecture of options.profile.architectures) {
        const arguments_ = [
            ...LANGUAGE_MODE_ARGUMENTS[options.profile.languageMode],
            ...ARCHITECTURE_ARGUMENTS[architecture]
        ];
        let report;
        let error;
        const semanticBindings = options.profile.semanticBindings === true;
        try {
            report = await auditNativeCorpus({
                root,
                editorCompiler,
                originalCompiler,
                compilerArguments: arguments_,
                categories: [...options.profile.categories],
                languageMode: options.profile.languageMode,
                semanticSidecar: !semanticBindings,
                semanticBindings,
                workerModels: true,
                timeoutMs: options.timeoutMs,
                progress: (category, group) => {
                    const detail = semanticBindings
                        ? `${group.semanticBindingCoverage.implicitCalls} implicit calls across ${Object.keys(group.semanticBindingCoverage.callsByKind).length} kinds`
                        : `${group.semanticSidecarCoverage.compared} semantic facts compared`;
                    process.stderr.write(`${architecture}/${category}: ${group.parity}/${group.files} compiler-parity checks; ${detail}.\n`);
                }
            });
        } catch (caught) {
            error = caught;
        }
        outcomes.push(summarizeProfile(
            architecture, report, error, options.profile
        ));
    }

    return {
        profile: options.profileName,
        categories: [...options.profile.categories],
        timeoutMs: options.timeoutMs,
        passed: outcomes.length === options.profile.architectures.length && outcomes.every((outcome) => outcome.passed),
        targets: outcomes
    };
}

async function main() {
    const options = parseMatrixArguments(process.argv.slice(2));
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const editorCompiler = process.env.FBC_EDITOR_EXECUTABLE;
    if (!editorCompiler) throw new Error("Set FBC_EDITOR_EXECUTABLE to the current native bridge before running this matrix.");
    const report = await runNativeMatrix({
        ...options,
        root,
        editorCompiler,
        originalCompiler: process.env.FBC_EXECUTABLE || path.join(root, "bin", "fbc")
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = {
    IMPLICIT_CALL_CATEGORIES,
    MATRIX_PROFILES,
    parseMatrixArguments,
    summarizeSemanticCoverage,
    summarizeSemanticBindingCoverage,
    hasExpressionCoverageGap,
    hasSemanticCoverageGap,
    hasSemanticBindingCoverageGap,
    summarizeProfile,
    runNativeMatrix
};

/* end of tools/audit-native-matrix.js */
