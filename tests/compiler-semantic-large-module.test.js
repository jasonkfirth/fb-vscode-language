/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/compiler-semantic-large-module.test.js
    Purpose: Verify bounded semantic analysis of the external AZdecrypt module.
    Responsibilities: Preserve filtered expression types and the complete dependency inventory.
    Does not contain: schema fixtures, artificial compiler results, or editor APIs.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { analyzeSavedModule, decodeCompilerSourceBuffer } = require("../lib/compiler-analysis");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");
const { resolveFreeBasicRoot } = require("../tools/audit-freebasic-coverage");

/* The unit runner isolates test files in separate processes. Keep this corpus
   run out of the schema suite so its earlier model allocations cannot carry
   into a resource-sensitive compiler check. The offline timeout allows competing
   CPU-heavy work; it does not change editor deadlines or semantic assertions. */
const LARGE_MODULE_ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;

test("large modules keep requested expression facts within the sidecar bound", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const root = "/home/jkfirth/fb_corpus";
    const compilerRoot = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "azdecrypt/AZdecrypt/Source/AZdecrypt/AZdecrypt.bas");
    if (!fs.existsSync(filePath)) return t.skip("the compatibility corpus does not include AZdecrypt");
    const source = decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath).replace(/^\uFEFF/, "");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: [
            "-mt",
            "-i", path.join(compilerRoot, "inc"),
            "-i", path.join(compilerRoot, "tests/fbcunit/inc"),
            "-i", path.join(root, "azdecrypt/AZdecrypt/Source/omaGUI-main"),
            "-i", path.dirname(filePath),
            "-i", path.join(root, "compat")
        ],
        overlays: new Map([[filePath, source]]),
        semanticSourceFiles: [filePath],
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        timeoutMs: LARGE_MODULE_ANALYSIS_TIMEOUT_MS
    });

    assert.equal(analysis.semanticSidecarOnly, true,
        "large preprocessing should use the trace-free sidecar pass");
    assert.equal(analysis.partial, false);
    assert.ok(analysis.dependencies.length > 100,
        "the sidecar must retain the complete include inventory even when expression export is filtered");
    assert.ok(analysis.semanticExpressions.length > 0);
    assert.ok(analysis.semanticExpressions.every((expression) => !expression.physical || expression.filePath === filePath),
        "expression facts should cover the requested root and not overflow on unopened includes");

    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/fb-corpus/azdecrypt.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const fact = analysis.semanticExpressions.find((expression) => expression.physical && expression.filePath === filePath);
    assert.ok(fact);
    const typed = model.expressionAt(sourceUri,
        { line: fact.startLine - 1, character: fact.startColumn },
        { line: fact.endLine - 1, character: fact.endColumn });
    assert.equal(typed?.semanticSource, "compiler-sidecar");
    assert.equal(typed?.typeName.toLowerCase(), fact.typeName.toLowerCase());
    assert.equal(typed?.provisional, false);
});

/* end of tests/compiler-semantic-large-module.test.js */

