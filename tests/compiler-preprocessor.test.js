/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-preprocessor.test.js
    Purpose: Verify the native preprocessor identity protocol.
    Responsibilities: test graph integrity, parameter ownership, and epochs.
    Does not contain: a simulated macro evaluator or native compiler builds.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { decodePreprocessed } = require("../lib/compiler-analysis");
const { preprocessorGraphSignature } = require("../lib/compiler-preprocessor");

test("preprocessor decoding validates parameter owners, lookup targets, and state epochs", () => {
    const hex = Buffer.from(path.resolve("preprocessor.bas")).toString("hex");
    const output = [
        "''@fb-editor-protocol 13",
        `''@fb-editor-file-v10 1 ${hex}`,
        "''@fb-editor-symbol 1 5 0 0 0 0 0 0 0 0 434f5059 766f6964",
        "''@fb-editor-shape 1 0 0 0 0 0 0",
        "''@fb-editor-map 1 2 4 0 0 0 0 4 0 0 1",
        "''@fb-editor-map 2 2 1 0 0 0 5 6 0 0 1",
        "''@fb-editor-map 3 2 1 0 0 0 7 8 0 0 1",
        "''@fb-editor-map 4 2 4 0 0 0 9 13 0 0 1",
        "''@fb-editor-macro-declaration 1 1 1 1 1 8 0",
        "''@fb-editor-macro-parameter 1 0 declaration 2 50",
        "''@fb-editor-macro-parameter 1 0 reference 3 50",
        "''@fb-editor-macro-reference 1 4 1 invoke 434f5059",
        "''@fb-editor-macro-context 1 1",
        "''@fb-editor-token-v11 1 6 7 generated 0 0 1 0 1",
        `''@fb-editor-v2 1 1 1 ${hex}`,
        "Print 1",
        "''@fb-editor-macro-reference 1 4 2 undef 434f5059",
        "''@fb-editor-macro-reference 0 4 2 query 434f5059",
        "''@fb-editor-end 0 1"
    ].join("\n");
    const analysis = decodePreprocessed(output, process.cwd());
    assert.equal(analysis.preprocessorGraph.epochs, 2);
    assert.equal(analysis.preprocessorGraph.declarations.length, 1);
    assert.equal(analysis.preprocessorGraph.parameters.length, 2);
    assert.equal(analysis.preprocessorGraph.references.length, 3);
    assert.deepEqual(analysis.preprocessorGraph.contexts, [{ sourceMap: 1, epoch: 1 }]);
    const renamed = preprocessorGraphSignature(analysis, new Set(["macro:1", "undefined:copy", "parameter:1:0"]), "Renamed");
    assert.equal(renamed.declarations[0].at(-1), "renamed");
    assert.ok(renamed.references.every((entry) => entry.at(-1) === "renamed"));
    assert.ok(renamed.parameters.every((entry) => entry.at(-1) === "renamed"));
    for (const invalid of [
        output.replace("macro-declaration 1 1 1 1", "macro-declaration 2 1 1 1"),
        output.replace("macro-declaration 1 1 1 1", "macro-declaration 1 1 1 2"),
        output.replace("macro-declaration 1 1 1 1 1", "macro-declaration 1 1 1 1 33"),
        output.replace("1 1 1 1 1 8 0", "1 1 1 1 1 16 0"),
        output.replace("1 1 1 1 1 8 0", "1 1 1 1 1 8 1"),
        output.replace("parameter 1 0 reference", "parameter 2 0 reference"),
        output.replace("parameter 1 0 reference", "parameter 1 1 reference"),
        output.replace("reference 3 50", "reference 3 51"),
        output.replace("declaration 2 50", "reference 2 50"),
        output.replace("reference 3 50", "declaration 3 50"),
        output.replace("macro-reference 1 4 1", "macro-reference 99 4 1"),
        output.replace("macro-reference 1 4 1", "macro-reference 0 4 1"),
        output.replace("macro-reference 1 4 2", "macro-reference 1 4 1"),
        output.replace("macro-reference 0 4 2", "macro-reference 0 4 1"),
        output.replace("macro-reference 1 4 1", "macro-reference 1 99 1"),
        output.replace("macro-context 1 1", "macro-context 99 1"),
        output.replace("macro-context 1 1", "macro-context 1 3"),
        output.replace("symbol 1 5", "symbol 1 1"),
        output.replace("generated 0 0 1 0 1", "generated 0 0 1 0 3"),
        output.replace("token-v11 1 6 7 generated 0 0 1 0 1", "token-v10 1 6 7 generated 0 0 1 0"),
        output.replace("''@fb-editor-end", "''@fb-editor-preprocessor-overflow\n''@fb-editor-end")
    ]) assert.throws(() => decodePreprocessed(invalid, process.cwd()), /preprocessor|macro|parameter|DEFINE|record/i);
});

test("preprocessor decoding accepts compiler-seeded identities and epochs", () => {
    const hex = Buffer.from(path.resolve("seeded-preprocessor.bas")).toString("hex");
    const output = [
        "''@fb-editor-protocol 13",
        `''@fb-editor-file-v10 1 ${hex}`,
        "''@fb-editor-symbol 1 5 0 0 0 0 0 0 0 0 434f5059 766f6964",
        "''@fb-editor-shape 1 0 0 0 0 0 0",
        "''@fb-editor-map 1 2 4 0 0 0 0 4 0 0 1",
        "''@fb-editor-map 2 2 1 0 0 0 5 6 0 0 1",
        "''@fb-editor-map 3 2 1 0 0 0 7 8 0 0 1",
        "''@fb-editor-map 4 2 4 0 0 0 9 13 0 0 1",
        "''@fb-editor-macro-context 1 1",
        "''@fb-editor-macro-reference 0 4 1 query 53454544",
        "''@fb-editor-macro-declaration 2 1 1 2 1 8 0",
        "''@fb-editor-macro-parameter 2 0 declaration 2 50",
        "''@fb-editor-macro-parameter 2 0 reference 3 50",
        "''@fb-editor-macro-reference 1 4 2 invoke 434f5059",
        "''@fb-editor-token-v11 1 6 7 generated 0 0 1 0 2",
        `''@fb-editor-v2 1 1 1 ${hex}`,
        "Print 1",
        "''@fb-editor-macro-context 1 2",
        "''@fb-editor-macro-reference 1 4 3 undef 434f5059",
        "''@fb-editor-macro-reference 0 4 3 query 434f5059",
        "''@fb-editor-end 0 1"
    ].join("\n");
    const analysis = decodePreprocessed(output, process.cwd());
    assert.equal(analysis.preprocessorGraph.epochs, 3);
    assert.deepEqual(analysis.preprocessorGraph.declarations.map((record) => record.id), [2]);
    assert.ok(analysis.preprocessorGraph.parameters.every((record) => record.declaration === 2));
    const renamed = preprocessorGraphSignature(analysis, new Set(["macro:1", "parameter:2:0"]), "Renamed");
    assert.equal(renamed.parameters[0].at(-1), "renamed");
});

/* end of compiler-preprocessor.test.js */
