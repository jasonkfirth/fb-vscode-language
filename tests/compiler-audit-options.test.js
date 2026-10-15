/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-audit-options.test.js
    Purpose: Validate bounded compiler audit and benchmark input handling.
    Responsibilities: check dialect, target, option profiles, and source-scan bounds.
    Does not contain: compiler invocation or corpus analysis.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CATEGORIES, parseNativeCorpusArguments, executeWithEaccesRetry, measureExpressionParserRouteCoverage, measureNamedExpressionFamilyCoverage, fullDefaultExpressionRouteCoverageFailures } = require("../tools/audit-native-corpus");
const { prepareTestEnvironment } = require("../tools/run-unit-tests");
const { compilerIncludeDependencyHints, measure: measureWorkspaceBenchmark } = require("../tools/benchmark-compiler-workspace");
const { auditExpressionRoutes } = require("../tools/audit-compiler-expression-routes");
const { QUIRK_EXPRESSION_HOOKS, QUIRK_EXPRESSION_FOCUSED_FAMILIES } = require("../tools/compiler-expression-hooks");
const {
    extractCompilerKeywords,
    listCompilerSourceFiles,
    resolveCompilerSourcePath,
    resolveFreeBasicRoot
} = require("../tools/audit-freebasic-coverage");
const {
    IMPLICIT_CALL_CATEGORIES,
    MATRIX_PROFILES,
    parseMatrixArguments,
    summarizeProfile,
    hasSemanticBindingCoverageGap
} = require("../tools/audit-native-matrix");

test("unit test setup preserves explicit native compiler paths", () => {
    const environment = {
        FREEBASIC_ROOT: "/custom/freebasic",
        FBC_EXECUTABLE: "/custom/freebasic/bin/fbc",
        FBC_EDITOR_EXECUTABLE: "/custom/fbc-editor"
    };

    assert.deepEqual(prepareTestEnvironment(environment), environment);
});

test("compiler audits resolve current build-group and legacy flat source layouts", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-source-layout-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const compilerRoot = path.join(root, "src", "compiler");
    const symbolDirectory = path.join(compilerRoot, "symbols");
    const parserDirectory = path.join(compilerRoot, "parser", "expressions");
    fs.mkdirSync(symbolDirectory, { recursive: true });
    fs.mkdirSync(parserDirectory, { recursive: true });
    fs.mkdirSync(path.join(root, "mk"), { recursive: true });
    fs.writeFileSync(path.join(root, "mk", "compiler-sources.mk"),
        "FBC_SOURCE_GROUPS := \\\n symbols \\\n parser/expressions\n");
    fs.writeFileSync(path.join(symbolDirectory, "symb-keyword.bas"),
        '( @"NEWWORD", FB_TK_NEWWORD, FB_TKCLASS_KEYWORD )\n');
    fs.writeFileSync(path.join(parserDirectory, "parser-expr-sample.bas"),
        "function cSample() as ASTNODE ptr\n return NULL\nend function\n");

    assert.equal(resolveFreeBasicRoot(root), root);
    assert.deepEqual(listCompilerSourceFiles(compilerRoot), [
        "parser/expressions/parser-expr-sample.bas",
        "symbols/symb-keyword.bas"
    ]);
    assert.equal(resolveCompilerSourcePath(compilerRoot, "symb-keyword.bas"),
        path.join(symbolDirectory, "symb-keyword.bas"));
    assert.ok(extractCompilerKeywords(compilerRoot).has("NEWWORD"));

    const routes = auditExpressionRoutes({
        root,
        parserHooks: { "parser-expr-sample.bas": ["cSample"] }
    });
    assert.equal(routes.unowned.length, 0);
    assert.equal(routes.staleGeneric.length, 0);
    assert.equal(routes.routes[0].owner, "generic parser wrapper");

    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fb-source-flat-"));
    t.after(() => fs.rmSync(legacyRoot, { recursive: true, force: true }));
    const legacyCompilerRoot = path.join(legacyRoot, "src", "compiler");
    fs.mkdirSync(legacyCompilerRoot, { recursive: true });
    fs.writeFileSync(path.join(legacyCompilerRoot, "symb-keyword.bas"),
        '( @"OLDWORD", FB_TK_OLDWORD, FB_TKCLASS_KEYWORD )\n');
    assert.equal(resolveFreeBasicRoot(legacyRoot), legacyRoot);
    assert.ok(extractCompilerKeywords(legacyCompilerRoot).has("OLDWORD"));
});

test("native corpus distinguishes owned parser routes from routes exercised by tests", () => {
    const coverage = measureExpressionParserRouteCoverage({ cAtom: 5, cVariable: 2 }, {
        "parser-expr-atom.bas": ["cAtom", "cParentExpression"],
        "parser-expr-variable.bas": ["cVariable"]
    });
    assert.equal(coverage.total, 3);
    assert.equal(coverage.exercised, 2);
    assert.deepEqual(coverage.unexercised, [{ file: "parser-expr-atom.bas", name: "cParentExpression" }]);
    assert.deepEqual(coverage.routes.map(({ file, name, executions, exercised }) => ({ file, name, executions, exercised })), [
        { file: "parser-expr-atom.bas", name: "cAtom", executions: 5, exercised: true },
        { file: "parser-expr-atom.bas", name: "cParentExpression", executions: 0, exercised: false },
        { file: "parser-expr-variable.bas", name: "cVariable", executions: 2, exercised: true }
    ]);
});

test("native corpus reports quirk parser routes separately from fixture-only routes", () => {
    const coverage = measureNamedExpressionFamilyCoverage({ cArrayFunct: 2, cScreenFunct: 1 }, [
        ["parser-quirk-array.bas", "cArrayFunct"],
        ["parser-quirk-console.bas", "cScreenFunct"],
        ["parser-quirk-sfx.bas", "cSfxFunct"]
    ], ["cScreenFunct"]);

    assert.equal(coverage.total, 3);
    assert.equal(coverage.exercised, 2);
    assert.equal(coverage.corpusRequired, 2);
    assert.equal(coverage.corpusExercised, 1);
    assert.deepEqual(coverage.unexercised, [{ file: "parser-quirk-sfx.bas", name: "cSfxFunct" }]);
    assert.deepEqual(coverage.fixtureOnlyUnexercised, []);
    assert.deepEqual(coverage.routes.map(({ file, name, fixtureOnly }) => ({ file, name, fixtureOnly })), [
        { file: "parser-quirk-array.bas", name: "cArrayFunct", fixtureOnly: false },
        { file: "parser-quirk-console.bas", name: "cScreenFunct", fixtureOnly: true },
        { file: "parser-quirk-sfx.bas", name: "cSfxFunct", fixtureOnly: false }
    ]);
});

test("native quirk coverage uses the compiler hook inventory and fixture-only list", () => {
    const coverage = measureNamedExpressionFamilyCoverage({}, QUIRK_EXPRESSION_HOOKS, QUIRK_EXPRESSION_FOCUSED_FAMILIES);

    assert.equal(coverage.total, 23);
    assert.equal(coverage.corpusRequired, 19);
    assert.deepEqual(coverage.unexercised.map((route) => route.name).sort(),
        QUIRK_EXPRESSION_HOOKS.map(([, name]) => name).filter((name) => !QUIRK_EXPRESSION_FOCUSED_FAMILIES.includes(name)).sort());
    assert.deepEqual(coverage.fixtureOnlyUnexercised.map((route) => route.name).sort(), [...QUIRK_EXPRESSION_FOCUSED_FAMILIES].sort());
});

test("full default-FB corpus audits require each expression route report to be complete", () => {
    const reports = [
        { name: "generic routes", coverage: { unexercised: [{ file: "parser-expr-atom.bas", name: "cParentExpression" }] } },
        { name: "quirk routes", coverage: { unexercised: [] } },
        { name: "exceptional routes", coverage: { unexercised: [] } }
    ];

    assert.deepEqual(fullDefaultExpressionRouteCoverageFailures(reports, { languageMode: "fb" }), [{
        file: "<generic routes-coverage>",
        error: "Full default-FB corpus did not execute generic routes: cParentExpression"
    }]);
    assert.deepEqual(fullDefaultExpressionRouteCoverageFailures(reports, { languageMode: "fblite" }), []);
    assert.deepEqual(fullDefaultExpressionRouteCoverageFailures(reports, { languageMode: "fb", categories: ["expressions"] }), []);
});

test("workspace benchmark hints scan transitive includes safely and discard capped graphs", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-workspace-hints-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const main = path.join(root, "main.bas");
    const header = path.join(root, "header.bi");
    const nested = path.join(root, "nested.bi");
    fs.writeFileSync(main, '#include "header.bi"\n');
    fs.writeFileSync(header, '#include once "nested.bi"\n#include "nested.bi"\n');
    fs.writeFileSync(nested, '#include "header.bi"\n');

    const scanned = compilerIncludeDependencyHints([main], []);
    assert.deepEqual(scanned.hints.get(path.resolve(main)), [path.resolve(header), path.resolve(nested)]);
    assert.equal(scanned.totalHintPaths, 2, "transitive cycles and repeated includes must be deduplicated");
    assert.equal(scanned.skippedModules, 0);
    assert.ok(scanned.scannedSourceBytes > 0);
    assert.equal(scanned.scanLimitReached, false);

    const cappedMain = path.join(root, "capped.bas");
    const includeNames = [];
    for (let index = 0; index <= 500; index++) {
        const name = `capped-${index}.bi`;
        includeNames.push(name);
        fs.writeFileSync(path.join(root, name), "");
    }
    fs.writeFileSync(cappedMain, includeNames.map((name) => `#include "${name}"`).join("\n"));
    const capped = compilerIncludeDependencyHints([cappedMain], []);
    assert.deepEqual(capped.hints.get(path.resolve(cappedMain)), [], "a partial graph must never be offered as a complete hint");
    assert.equal(capped.skippedModules, 1);
    assert.equal(capped.totalHintPaths, 0);
});

test("workspace benchmark separates event-loop utilization from process scheduling counters", async () => {
    const measured = await measureWorkspaceBenchmark(() => new Promise((resolve) => setTimeout(resolve, 15)));
    assert.ok(measured.elapsedMs >= 10);
    assert.ok(Number.isFinite(measured.largestPauseMs));
    assert.ok(measured.processUsage.userCpuMs >= 0);
    assert.ok(measured.processUsage.systemCpuMs >= 0);
    assert.ok(measured.processUsage.voluntaryContextSwitches >= 0);
    assert.ok(measured.processUsage.involuntaryContextSwitches >= 0);
    assert.ok(measured.processUsage.maximumResidentSetKiB > 0);
    assert.ok(measured.eventLoopUsage.activeMs >= 0);
    assert.ok(measured.eventLoopUsage.idleMs >= 0);
    assert.ok(measured.eventLoopUsage.utilization >= 0 && measured.eventLoopUsage.utilization <= 1);
});

test("native QB matrix covers the dedicated corpus on each supported target", () => {
    assert.deepEqual(parseMatrixArguments(["--profile=QB"]), {
        profileName: "qb",
        profile: MATRIX_PROFILES.qb,
        timeoutMs: 10000
    });
    assert.deepEqual(MATRIX_PROFILES.qb, {
        languageMode: "qb",
        categories: ["qb"],
        architectures: ["x86-32", "x86-64", "aarch64"]
    });
    assert.equal(parseMatrixArguments(["--profile=qb", "--timeout-ms=60000"]).timeoutMs, 60000);
    assert.throws(() => parseMatrixArguments([]), /exactly one native matrix profile/);
    assert.throws(() => parseMatrixArguments(["--profile=qb", "--profile=qb"]), /exactly one native matrix profile/);
    assert.throws(() => parseMatrixArguments(["--profile=unknown"]), /Unknown native matrix profile/);
    assert.throws(() => parseMatrixArguments(["--profile=qb", "--timeout-ms=300001"]), /timeout must be an integer/);
    assert.throws(() => parseMatrixArguments(["--profile=qb", "--unrestricted-compiler-args"]), /Unknown native matrix arguments/);
});

test("native QB full-corpus profile covers all categories on each supported target", () => {
    const options = parseMatrixArguments(["--profile=qb-full"]);
    assert.equal(options.profileName, "qb-full");
    assert.deepEqual(options.profile, MATRIX_PROFILES["qb-full"]);
    assert.equal(options.profile.languageMode, "qb");
    assert.deepEqual(options.profile.categories, CATEGORIES);
    assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
    assert.equal(options.timeoutMs, 60000);
});

test("native FBLite expression matrix covers compiler-heavy categories with a stress-file bound", () => {
    const options = parseMatrixArguments(["--profile=fblite-expressions"]);
    assert.equal(options.profileName, "fblite-expressions");
    assert.deepEqual(options.profile, MATRIX_PROFILES["fblite-expressions"]);
    assert.deepEqual(options.profile.categories, ["expressions", "compound", "overload", "pointers", "structs", "numbers", "string"]);
    assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
    assert.equal(options.profile.requireAllGenericExpressionRoutes, true);
    assert.equal(options.timeoutMs, 60000);
    assert.equal(parseMatrixArguments(["--profile=fblite-expressions", "--timeout-ms=30000"]).timeoutMs, 30000);
});

test("native default FB expression matrix covers compiler-heavy categories on each target", () => {
    const options = parseMatrixArguments(["--profile=fb-expressions"]);
    assert.equal(options.profileName, "fb-expressions");
    assert.deepEqual(options.profile, MATRIX_PROFILES["fb-expressions"]);
    assert.equal(options.profile.languageMode, "fb");
    assert.deepEqual(options.profile.categories, ["expressions", "compound", "overload", "pointers", "structs", "numbers", "string"]);
    assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
    assert.equal(options.profile.requireAllGenericExpressionRoutes, true);
    assert.equal(options.timeoutMs, 60000);
});

test("native default-FB implicit-call matrix requires all sidecar call kinds per target", () => {
    const options = parseMatrixArguments(["--profile=fb-implicit-calls"]);
    assert.equal(options.profileName, "fb-implicit-calls");
    assert.deepEqual(options.profile, MATRIX_PROFILES["fb-implicit-calls"]);
    assert.equal(options.profile.languageMode, "fb");
    assert.deepEqual(options.profile.categories, IMPLICIT_CALL_CATEGORIES);
    assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
    assert.equal(options.profile.semanticBindings, true);
    assert.equal(options.profile.requireAllImplicitCallKinds, true);
    assert.equal(options.timeoutMs, 60000);
});

test("legacy implicit-call matrices require the supported dialect-specific call kinds", () => {
    for (const [name, mode, categories, required] of [
        ["fblite-implicit-calls", "fblite", IMPLICIT_CALL_CATEGORIES, ["default-constructor", "destructor-call"]],
        ["deprecated-implicit-calls", "deprecated", IMPLICIT_CALL_CATEGORIES, ["default-constructor", "destructor-call"]],
        ["qb-implicit-calls", "qb", ["dim", "functions", "structs"], ["destructor-call"]]
    ]) {
        const options = parseMatrixArguments([`--profile=${name}`]);
        assert.deepEqual(options.profile, MATRIX_PROFILES[name]);
        assert.equal(options.profile.languageMode, mode);
        assert.deepEqual(options.profile.categories, categories);
        assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
        assert.equal(options.profile.semanticBindings, true);
        assert.deepEqual(options.profile.requiredImplicitCallKinds, required);
        assert.equal(options.timeoutMs, 60000);
    }
});

test("native FB full-corpus profile covers all categories on each supported target", () => {
    const options = parseMatrixArguments(["--profile=fb-full"]);
    assert.equal(options.profileName, "fb-full");
    assert.deepEqual(options.profile, MATRIX_PROFILES["fb-full"]);
    assert.equal(options.profile.languageMode, "fb");
    assert.deepEqual(options.profile.categories, CATEGORIES);
    assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
    assert.equal(options.timeoutMs, 60000);
});

test("native FBLite full-corpus profile covers all categories on each supported target", () => {
    const options = parseMatrixArguments(["--profile=fblite-full"]);
    assert.equal(options.profileName, "fblite-full");
    assert.deepEqual(options.profile, MATRIX_PROFILES["fblite-full"]);
    assert.equal(options.profile.languageMode, "fblite");
    assert.deepEqual(options.profile.categories, CATEGORIES);
    assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
    assert.equal(options.timeoutMs, 60000);
});

test("native deprecated expression matrix covers compiler-heavy categories on each target", () => {
    const options = parseMatrixArguments(["--profile=deprecated-expressions"]);
    assert.equal(options.profileName, "deprecated-expressions");
    assert.deepEqual(options.profile, MATRIX_PROFILES["deprecated-expressions"]);
    assert.equal(options.profile.languageMode, "deprecated");
    assert.deepEqual(options.profile.categories, ["expressions", "compound", "overload", "pointers", "structs", "numbers", "string"]);
    assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
    assert.equal(options.profile.requireAllGenericExpressionRoutes, true);
    assert.equal(options.timeoutMs, 60000);
});

test("native deprecated full-corpus profile covers all categories on each supported target", () => {
    const options = parseMatrixArguments(["--profile=deprecated-full"]);
    assert.equal(options.profileName, "deprecated-full");
    assert.deepEqual(options.profile, MATRIX_PROFILES["deprecated-full"]);
    assert.equal(options.profile.languageMode, "deprecated");
    assert.deepEqual(options.profile.categories, CATEGORIES);
    assert.deepEqual(options.profile.architectures, ["x86-32", "x86-64", "aarch64"]);
    assert.equal(options.timeoutMs, 60000);
});

test("native matrix requires parity, direct models, and prepared worker models", () => {
    const passing = summarizeProfile("x86-64", {
        files: 87,
        complete: 62,
        partial: 25,
        parity: 87,
        models: 87,
        preparedModels: 87,
        preparedSemanticTokens: 1061,
        boundedAnalysis: 0,
        incompleteAnalysis: 0,
        expressionCoverage: {
            missingSyntax: 0,
            missingTypes: 180,
            invalidMissingTypes: 180,
            provisionalMissingTypes: 0,
            unmarkedRecoveryTypes: 0,
            typeMismatches: 0
        },
        expressionParserCoverage: {
            total: 2,
            exercised: 1,
            unexercised: [{ file: "parser-expr-atom.bas", name: "cParentExpression" }],
            routes: [
                { file: "parser-expr-atom.bas", name: "cAtom", executions: 5, exercised: true },
                { file: "parser-expr-atom.bas", name: "cParentExpression", executions: 0, exercised: false }
            ]
        },
        quirkExpressionCoverage: {
            total: 1,
            exercised: 0,
            corpusRequired: 0,
            corpusExercised: 0,
            unexercised: [],
            fixtureOnlyUnexercised: [{ file: "parser-quirk-console.bas", name: "cScreenFunct" }],
            routes: [{ file: "parser-quirk-console.bas", name: "cScreenFunct", executions: 0, exercised: false, fixtureOnly: true }]
        },
        exceptionalExpressionCoverage: {
            total: 1,
            exercised: 1,
            corpusRequired: 1,
            corpusExercised: 1,
            unexercised: [],
            fixtureOnlyUnexercised: [],
            routes: [{ file: "parser-expr-function.bas", name: "cFunctionCall", executions: 4, exercised: true, fixtureOnly: false }]
        },
        typeLayoutExpressionCoverage: {
            total: 1,
            exercised: 1,
            corpusRequired: 1,
            corpusExercised: 1,
            unexercised: [],
            fixtureOnlyUnexercised: [],
            routes: [{ file: "parser-decl-symbtype.bas", name: "cTypeOrExpression", executions: 3, exercised: true, fixtureOnly: false }]
        },
        semanticSidecarCoverage: {
            files: 87,
            expressions: 790,
            missing: 0,
            typeMismatches: 0,
            sidecarOnlyMissing: 0,
            sidecarOnlyTypeMismatches: 0,
            sidecarOnlyStatusMismatches: 0,
            recoverySidecarOnlyMissing: 0,
            recoverySidecarOnlyTypeMismatches: 0,
            recoverySidecarOnlyUnprovisional: 0,
            recoveryMissing: 0,
            recoveryTypeMismatches: 0,
            recoveryUnprovisional: 0,
            recoveryUnsafeRetained: 0
        },
        failures: []
    });
    assert.equal(passing.passed, true);
    assert.equal(passing.semanticSidecarCoverage.expressions, 790);
    assert.deepEqual(passing.expressionParserCoverage, {
        total: 2,
        exercised: 1,
        unexercised: [{ file: "parser-expr-atom.bas", name: "cParentExpression" }],
        routes: [
            { file: "parser-expr-atom.bas", name: "cAtom", executions: 5, exercised: true },
            { file: "parser-expr-atom.bas", name: "cParentExpression", executions: 0, exercised: false }
        ]
    });
    assert.deepEqual(passing.quirkExpressionCoverage, {
        total: 1,
        exercised: 0,
        corpusRequired: 0,
        corpusExercised: 0,
        unexercised: [],
        fixtureOnlyUnexercised: [{ file: "parser-quirk-console.bas", name: "cScreenFunct" }],
        routes: [{ file: "parser-quirk-console.bas", name: "cScreenFunct", executions: 0, exercised: false, fixtureOnly: true }]
    });
    assert.deepEqual(passing.exceptionalExpressionCoverage, {
        total: 1,
        exercised: 1,
        corpusRequired: 1,
        corpusExercised: 1,
        unexercised: [],
        fixtureOnlyUnexercised: [],
        routes: [{ file: "parser-expr-function.bas", name: "cFunctionCall", executions: 4, exercised: true, fixtureOnly: false }]
    });
    assert.deepEqual(passing.typeLayoutExpressionCoverage, {
        total: 1,
        exercised: 1,
        corpusRequired: 1,
        corpusExercised: 1,
        unexercised: [],
        fixtureOnlyUnexercised: [],
        routes: [{ file: "parser-decl-symbtype.bas", name: "cTypeOrExpression", executions: 3, exercised: true, fixtureOnly: false }]
    });

    const missingWorkerModel = summarizeProfile("x86-64", { files: 87, parity: 87, models: 87, preparedModels: 86, failures: [] });
    assert.equal(missingWorkerModel.passed, false);

    const missingSidecarAnswer = summarizeProfile("x86-64", {
        files: 87,
        parity: 87,
        models: 87,
        preparedModels: 87,
        expressionCoverage: passing.expressionCoverage,
        semanticSidecarCoverage: { ...passing.semanticSidecarCoverage, sidecarOnlyMissing: 1 },
        failures: []
    });
    assert.equal(missingSidecarAnswer.passed, false);
});

test("expression target matrices reject unexercised generic parser routes", () => {
    const common = {
        files: 1,
        complete: 1,
        partial: 0,
        parity: 1,
        models: 1,
        preparedModels: 1,
        preparedSemanticTokens: 1,
        boundedAnalysis: 0,
        incompleteAnalysis: 0,
        expressionCoverage: {
            missingSyntax: 0,
            missingTypes: 0,
            invalidMissingTypes: 0,
            provisionalMissingTypes: 0,
            unmarkedRecoveryTypes: 0,
            typeMismatches: 0
        },
        semanticSidecarCoverage: {
            files: 1,
            expressions: 1,
            missing: 0,
            typeMismatches: 0,
            sidecarOnlyMissing: 0,
            sidecarOnlyTypeMismatches: 0,
            sidecarOnlyStatusMismatches: 0,
            recoverySidecarOnlyMissing: 0,
            recoverySidecarOnlyTypeMismatches: 0,
            recoverySidecarOnlyUnprovisional: 0,
            recoveryMissing: 0,
            recoveryTypeMismatches: 0,
            recoveryUnprovisional: 0,
            recoveryUnsafeRetained: 0
        },
        failures: []
    };
    const missingRoute = summarizeProfile("x86-32", {
        ...common,
        expressionParserCoverage: { total: 2, exercised: 1, unexercised: [{ name: "cGtInParensOnlyExpr" }] }
    }, null, { requireAllGenericExpressionRoutes: true });
    assert.equal(missingRoute.passed, false);

    const completeRoutes = summarizeProfile("x86-32", {
        ...common,
        expressionParserCoverage: { total: 2, exercised: 2, unexercised: [] }
    }, null, { requireAllGenericExpressionRoutes: true });
    assert.equal(completeRoutes.passed, true);
    assert.equal(summarizeProfile("x86-32", undefined, new Error("audit failed"), { requireAllGenericExpressionRoutes: true }).passed, false);
});

test("implicit-call target matrices require complete physical accounting and every supported kind", () => {
    const coverage = {
        files: 10,
        bindings: 50,
        nonPhysicalBindings: 2,
        implicitCalls: 12,
        nonPhysicalImplicitCalls: 3,
        callsByKind: { "default-constructor": 5, "temporary-destructor": 7 },
        supportedCallKinds: ["default-constructor", "temporary-destructor"],
        exercisedCallKinds: ["default-constructor", "temporary-destructor"],
        missingCallKinds: [],
        unexpectedCallKinds: [],
        invalidRecordCounts: 0,
        missingSources: 0,
        outOfBoundsRanges: 0,
        invalidPhysicalRanges: 0,
        invalidSignatures: 0
    };
    assert.equal(hasSemanticBindingCoverageGap(coverage, 10, true), false);
    assert.equal(hasSemanticBindingCoverageGap({
        ...coverage,
        missingCallKinds: ["scope-exit-destructor"],
        exercisedCallKinds: ["default-constructor", "temporary-destructor"]
    }, 10, true), true);
    assert.equal(hasSemanticBindingCoverageGap(coverage, 10, {
        requiredImplicitCallKinds: ["default-constructor", "temporary-destructor"]
    }), false);
    assert.equal(hasSemanticBindingCoverageGap(coverage, 10, {
        requiredImplicitCallKinds: ["default-constructor", "destructor-call"]
    }), true);
    assert.equal(hasSemanticBindingCoverageGap({ ...coverage, nonPhysicalImplicitCalls: 3, invalidPhysicalRanges: 1 }, 10, true), true);
});

test("native corpus audit applies extended syntax to both compiler passes", () => {
    assert.deepEqual(parseNativeCorpusArguments([
        "--semantic-sidecar", "--category=expressions", "--language-mode=fblite",
        "--architecture=aarch64", "--extended-syntax"
    ]), {
        semanticSidecar: true,
        semanticBindings: false,
        categories: ["expressions"],
        languageMode: "fblite",
        timeoutMs: 10000,
        compilerArguments: ["-lang", "fblite", "-arch", "aarch64", "-exx"]
    });
});

test("native corpus audit exposes the dedicated FBLite source category", () => {
    assert.deepEqual(parseNativeCorpusArguments(["--category=fblite"]), {
        semanticSidecar: false,
        semanticBindings: false,
        categories: ["fblite"],
        languageMode: "fb",
        timeoutMs: 10000,
        compilerArguments: []
    });
});

test("native corpus audit applies a validated backend profile to both compiler passes", () => {
    assert.deepEqual(parseNativeCorpusArguments([
        "--semantic-sidecar", "--category=functions", "--architecture=x86-64", "--backend=clang"
    ]), {
        semanticSidecar: true,
        semanticBindings: false,
        categories: ["functions"],
        languageMode: "fb",
        timeoutMs: 10000,
        compilerArguments: ["-arch", "x86_64", "-gen", "clang"]
    });
    assert.deepEqual(parseNativeCorpusArguments(["--timeout-ms=45000"]), {
        semanticSidecar: false,
        semanticBindings: false,
        categories: undefined,
        languageMode: "fb",
        timeoutMs: 45000,
        compilerArguments: []
    });
    assert.throws(() => parseNativeCorpusArguments(["--backend=clang", "--backend=llvm"]), /at most one/);
    assert.throws(() => parseNativeCorpusArguments(["--backend=unknown"]), /Unknown native corpus code-generation backend/);
    assert.throws(() => parseNativeCorpusArguments(["--architecture=x86-64", "--backend=gas"]), /requires --architecture=x86-32/);
    assert.throws(() => parseNativeCorpusArguments(["--architecture=x86-32", "--backend=gas64"]), /requires --architecture=x86-64/);
    assert.throws(() => parseNativeCorpusArguments(["--timeout-ms=0"]), /timeout must be an integer/);
    assert.throws(() => parseNativeCorpusArguments(["--timeout-ms=300001"]), /timeout must be an integer/);
    assert.throws(() => parseNativeCorpusArguments(["--timeout-ms=1e3"]), /timeout must be an integer/);
});

test("native corpus audit rejects duplicate profiles and arbitrary compiler arguments", () => {
    assert.throws(() => parseNativeCorpusArguments(["--extended-syntax", "--extended-syntax"]), /at most once/);
    assert.throws(() => parseNativeCorpusArguments(["--compiler-argument=-o"]), /Unknown native corpus audit arguments/);
});

test("native corpus audit retries transient executable-start denials", async () => {
    let attempts = 0;
    const result = { exitCode: 0 };

    assert.equal(await executeWithEaccesRetry(async () => {
        attempts++;
        if (attempts < 3) {
            const error = new Error("transient executable-start denial");
            error.code = "EACCES";
            throw error;
        }
        return result;
    }), result);
    assert.equal(attempts, 3);
});

test("native corpus audit keeps persistent and unrelated spawn failures visible", async () => {
    let permissionAttempts = 0;
    await assert.rejects(executeWithEaccesRetry(async () => {
        permissionAttempts++;
        const error = new Error("persistent executable-start denial");
        error.code = "EACCES";
        throw error;
    }), /persistent executable-start denial/);
    assert.equal(permissionAttempts, 4);

    let otherAttempts = 0;
    await assert.rejects(executeWithEaccesRetry(async () => {
        otherAttempts++;
        const error = new Error("missing executable");
        error.code = "ENOENT";
        throw error;
    }), /missing executable/);
    assert.equal(otherAttempts, 1);
});

/* end of tests/compiler-audit-options.test.js */
