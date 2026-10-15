/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/smoke.test.js

    Purpose:

        Verify that generated and packaged language assets are internally
        consistent with the configured FreeBASIC source tree.

    Responsibilities:

        - validate JSON assets and UTF-8 BOM policy
        - prove the checked-in TextMate grammar matches its source data
        - run the source coverage audit through its reusable interface

    This file intentionally does NOT contain:

        - file generation
        - VSIX packaging
        - VS Code host integration
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { auditCoverage, resolveFreeBasicRoot } = require("../tools/audit-freebasic-coverage");
const { generateGrammar } = require("../tools/build-freebasic-grammar");
const { selectBuilder } = require("../tools/run-vsix-builder");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const GRAMMAR_SOURCE_PATH = path.join(
    REPOSITORY_ROOT,
    "syntaxes",
    "source",
    "freebasic.grammar-source.json"
);

function readJson(relativePath) {
    const filePath = path.join(REPOSITORY_ROOT, relativePath);
    const bytes = fs.readFileSync(filePath);

    assert.notDeepEqual(
        [...bytes.subarray(0, 3)],
        [0xef, 0xbb, 0xbf],
        `${relativePath} must not contain a UTF-8 BOM`
    );

    return JSON.parse(bytes.toString("utf8"));
}

function reviveConfigurationRegex(value) {
    if (typeof value === "string") {
        return new RegExp(value);
    }
    return new RegExp(value.pattern, value.flags || "");
}

test("shipped JSON assets are valid UTF-8 without a BOM", () => {
    const packageData = readJson("package.json");
    const grammarSource = readJson("syntaxes/source/freebasic.grammar-source.json");
    const reference = readJson("data/language-reference.json");
    const lockfile = readJson("package-lock.json");

    readJson("language-configuration.json");
    readJson("snippets/freebasic.code-snippets");
    readJson("syntaxes/freebasic.tmLanguage.json");

    assert.equal(packageData.version, grammarSource.sourceVersion);
    assert.equal(packageData.version, reference.sourceVersion);
    assert.equal(packageData.version, lockfile.version);
    assert.equal(packageData.version, lockfile.packages[""].version);

    for (const [groupName, values] of Object.entries(grammarSource)) {
        if (!Array.isArray(values) || groupName === "compoundPatterns") {
            continue;
        }

        assert.equal(
            new Set(values).size,
            values.length,
            `${groupName} must not contain duplicate entries`
        );
    }
});

test("native semantic analysis has a separate bounded timeout setting", () => {
    const packageData = readJson("package.json");
    const properties = packageData.contributes.configuration.properties;
    const analysisTimeout = properties["freebasic.analysis.timeoutMs"];
    const diagnosticsTimeout = properties["freebasic.diagnostics.timeoutMs"];

    assert.equal(analysisTimeout.default, 60000);
    assert.equal(analysisTimeout.minimum, 1000);
    assert.equal(analysisTimeout.maximum, 300000);
    assert.equal(analysisTimeout.scope, "resource");
    assert.equal(diagnosticsTimeout.default, 30000,
        "raising the semantic timeout must not lengthen ordinary syntax checks");
});

test("checked-in grammar matches the source-backed generator", () => {
    const grammarSource = readJson("syntaxes/source/freebasic.grammar-source.json");
    const generatedGrammar = readJson("syntaxes/freebasic.tmLanguage.json");

    assert.deepEqual(generatedGrammar, generateGrammar(grammarSource));
});

test("package metadata contributes every runtime command and setting", () => {
    const packageData = readJson("package.json");
    const commandIds = packageData.contributes.commands.map((command) => command.command);
    const runtimeFiles = [
        "extension.js",
        "lib/compiler-diagnostics.js",
        "lib/compiler-process-supervisor.js",
        "lib/compiler-process-runner.js",
        "lib/compiler-service.js",
        "lib/compiler-analysis.js",
        "lib/compiler-recovery.js",
        "lib/compiler-symbols.js",
        "lib/compiler-expressions.js",
        "lib/compiler-scopes.js",
        "lib/compiler-inventory.js",
        "lib/compiler-origins.js",
        "lib/compiler-macros.js",
        "lib/compiler-preprocessor.js",
        "lib/compiler-preprocessor-model.js",
        "lib/compiler-project.js",
        "lib/compiler-project-bindings.js",
        "lib/compiler-project-transaction.js",
        "lib/compiler-contexts.js",
        "lib/compiler-worker.js",
        "lib/compiler-worker-runtime.js",
        "lib/compiler-worker-entry.js",
        "lib/compiler-model-store.js",
        "lib/compiler-model-queries.js",
        "lib/compiler-document-symbols.js",
        "lib/compiler-remote-model.js",
        "lib/semantic-token-data.js",
        "lib/bounded-text-map.js",
        "lib/compiler-analysis-service.js",
        "lib/compiler-workspace-symbols.js",
        "lib/compiler-workspace-service.js",
        "lib/compiler-semantic-model.js",
        "lib/compiler-semantic-sidecar.js",
        "lib/editor-features.js",
        "lib/freebasic-parser.js",
        "lib/grammar-data.js",
        "lib/workspace-index.js",
        "lib/include-paths.js",
        "lib/language-reference.js",
        "lib/semantic-model.js",
        "lib/semantic-features.js",
        "data/language-reference.json",
        "docs/reference-attribution.md",
        "docs/compiler-bridge.md",
        "docs/fdl-1.2.txt"
    ];
    const buildScripts = ["tools/build-vsix.ps1", "tools/build-vsix.sh"].map((relativePath) => ({
        relativePath,
        content: fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8")
    }));

    assert.deepEqual(commandIds, [
        "freebasic.analyzeModule",
        "freebasic.selectCompilerContext",
        "freebasic.showPreprocessed",
        "freebasic.showExpressionType",
        "freebasic.checkSyntax",
        "freebasic.rebuildWorkspaceIndex",
        "freebasic.showOutput"
    ]);
    const editorTitleCommands = packageData.contributes.menus["editor/title"].map((item) => item.command);
    assert.deepEqual(editorTitleCommands, ["freebasic.selectCompilerContext", "freebasic.analyzeModule", "freebasic.checkSyntax"]);
    assert.equal(packageData.contributes.commands.find((command) => command.command === "freebasic.analyzeModule").icon, "$(search)");
    assert.equal(packageData.contributes.commands.find((command) => command.command === "freebasic.selectCompilerContext").icon, "$(list-filter)");
    assert.deepEqual(packageData.contributes.menus["editor/context"].map((item) => item.command), [
        "freebasic.showExpressionType",
        "freebasic.showPreprocessed"
    ]);
    assert.equal(packageData.capabilities.untrustedWorkspaces.supported, "limited");
    assert.equal(packageData.contributes.configuration.properties["freebasic.compiler.path"].default, "fbc");
    assert.equal(packageData.contributes.configuration.properties["freebasic.analysis.run"].default, "onDemand");
    assert.deepEqual(packageData.contributes.configuration.properties["freebasic.analysis.run"].enum,
        ["off", "onDemand", "onSave", "onChange"]);
    assert.equal(packageData.contributes.configuration.properties["freebasic.analysis.activeContext"].default, null);
    assert.equal(packageData.contributes.configuration.properties["freebasic.index.maxFiles"].default, 5000);
    assert.equal(packageData.contributes.configuration.properties["freebasic.index.workspaceConcurrency"].default, 2);
    assert.equal(packageData.contributes.configuration.properties["freebasic.index.workspaceConcurrency"].maximum, 2);
    assert.equal(packageData.scripts["package:vsix"], "node tools/run-vsix-builder.js");
    assert.equal(packageData.scripts["package:vsix:linux"], "bash ./tools/build-vsix.sh");
    assert.equal(packageData.scripts["test:integration:vsix:linux"], "npm run package:vsix && node tools/test-packaged-extension.js");

    for (const relativePath of runtimeFiles) {
        assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, relativePath)), true);

        for (const buildScript of buildScripts) {
            assert.equal(
                buildScript.content.includes(`"${relativePath}"`),
                true,
                `${relativePath} must be included by ${buildScript.relativePath}`
            );
        }
    }
});

test("VSIX dispatcher selects the native builder", () => {
    const windowsBuilder = selectBuilder("win32", REPOSITORY_ROOT);
    const linuxBuilder = selectBuilder("linux", REPOSITORY_ROOT);

    assert.equal(windowsBuilder.command, "powershell");
    assert.equal(windowsBuilder.arguments.at(-1), path.join(REPOSITORY_ROOT, "tools", "build-vsix.ps1"));
    assert.equal(linuxBuilder.command, "bash");
    assert.equal(linuxBuilder.arguments.at(-1), path.join(REPOSITORY_ROOT, "tools", "build-vsix.sh"));
    assert.throws(
        () => selectBuilder("unsupported-platform", REPOSITORY_ROOT),
        /not configured/
    );
});

test("language configuration regular expressions are valid and case insensitive", () => {
    const configuration = readJson("language-configuration.json");
    const indentation = configuration.indentationRules;
    const folding = configuration.folding.markers;

    const increaseIndent = reviveConfigurationRegex(indentation.increaseIndentPattern);

    assert.equal(increaseIndent.test("Public Function Work()"), true);
    assert.equal(increaseIndent.test("select case value"), true);
    assert.equal(increaseIndent.test("Extern \"C++\" Lib \"sample\""), true);
    assert.equal(increaseIndent.test("Extern externalFlag As Long"), false);
    assert.equal(increaseIndent.test("Type Handle As Any Ptr"), false);
    assert.equal(reviveConfigurationRegex(indentation.decreaseIndentPattern).test("END FUNCTION"), true);
    assert.equal(reviveConfigurationRegex(indentation.indentNextLinePattern).test("#ElseIf condition"), true);
    assert.equal(reviveConfigurationRegex(folding.start).test("rem #Region setup"), false);
    assert.equal(reviveConfigurationRegex(folding.start).test("' #Region setup"), true);
    assert.equal(reviveConfigurationRegex(folding.end).test("' #ENDREGION"), true);
    assert.equal(reviveConfigurationRegex(configuration.wordPattern).test("18446744073709551615ull"), true);
});

test("language data covers the configured FreeBASIC source tree", () => {
    const freeBasicRoot = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const result = auditCoverage(GRAMMAR_SOURCE_PATH, freeBasicRoot);

    assert.deepEqual(result.errors, []);
    assert.equal(result.sourceVersion, "1.20.4");
    assert.equal(result.versionSurfaceCompatible, true);
});

/* end of tests/smoke.test.js */
