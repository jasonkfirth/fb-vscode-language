const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { findDeclarationByName, parseFreeBasicText, splitDimVariables, stripComments } = require("../lib/freebasic-parser");
const { loadGrammarSourceFile } = require("../lib/grammar-data");

function readFixture(name) {
    return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

test("grammar source loads expected symbol groups", () => {
    const grammarData = loadGrammarSourceFile(path.join(__dirname, "..", "syntaxes", "source", "freebasic.grammar-source.json"));

    assert.ok(grammarData.keywords.includes("FUNCTION"));
    assert.ok(grammarData.runtimeFunctions.includes("THREADCREATE"));
    assert.ok(grammarData.graphicsFunctions.includes("SCREENRES"));
    assert.ok(grammarData.symbolicConstants.includes("SC_ESCAPE"));
});

test("stripComments removes apostrophe comments", () => {
    assert.equal(stripComments("Dim value As Integer ' comment"), "Dim value As Integer ");
});

test("splitDimVariables handles typed and suffixed variables", () => {
    assert.deepEqual(splitDimVariables("value As Integer, otherValue As Integer"), ["value", "otherValue"]);
    assert.deepEqual(splitDimVariables("name$, count%, ratio#"), ["name", "count", "ratio"]);
    assert.deepEqual(splitDimVariables("array(0 To 10) As Integer, rawBuffer"), ["array", "rawBuffer"]);
});

test("parseFreeBasicText traces core declarations", () => {
    const parsed = parseFreeBasicText(readFixture("declarations.bas"));

    assert.ok(findDeclarationByName(parsed.declarations, "Demo"));
    assert.ok(findDeclarationByName(parsed.declarations, "APP_NAME"));
    assert.ok(findDeclarationByName(parsed.declarations, "Person"));
    assert.ok(findDeclarationByName(parsed.declarations, "ColorMode"));
    assert.ok(findDeclarationByName(parsed.declarations, "PrintMessage"));
    assert.ok(findDeclarationByName(parsed.declarations, "BuildPerson"));
    assert.ok(findDeclarationByName(parsed.declarations, "counter"));
    assert.ok(findDeclarationByName(parsed.declarations, "workerHandle"));
    assert.ok(findDeclarationByName(parsed.declarations, "externalFlag"));
});

test("parseFreeBasicText preserves namespace containers", () => {
    const parsed = parseFreeBasicText(readFixture("declarations.bas"));
    const buildPerson = findDeclarationByName(parsed.declarations, "BuildPerson");

    assert.equal(buildPerson.containerName, "Demo");
    assert.equal(buildPerson.type, "function");
});

test("parseFreeBasicText handles common Dim forms", () => {
    const parsed = parseFreeBasicText(readFixture("dim-forms.bas"));

    assert.ok(findDeclarationByName(parsed.declarations, "value"));
    assert.ok(findDeclarationByName(parsed.declarations, "alpha"));
    assert.ok(findDeclarationByName(parsed.declarations, "beta"));
    assert.ok(findDeclarationByName(parsed.declarations, "title"));
    assert.ok(findDeclarationByName(parsed.declarations, "subtitle"));
    assert.ok(findDeclarationByName(parsed.declarations, "array"));
    assert.ok(findDeclarationByName(parsed.declarations, "rawBuffer"));
    assert.ok(findDeclarationByName(parsed.declarations, "name"));
    assert.ok(findDeclarationByName(parsed.declarations, "count"));
    assert.ok(findDeclarationByName(parsed.declarations, "ratio"));
});

test("generated grammar keeps empty-string comparisons self-contained", () => {
    const grammarPath = path.join(__dirname, "..", "syntaxes", "freebasic.tmLanguage.json");
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
    const stringPattern = grammar.repository.strings.patterns[0];
    const stringRegex = new RegExp(stringPattern.match, "g");
    const lines = readFixture("string-regressions.bas").split(/\r?\n/);

    assert.equal(lines[0].match(stringRegex)?.length, 1);
    assert.equal(lines[1].match(stringRegex)?.length, 1);
    assert.equal(lines[2].match(stringRegex)?.length, 1);
    assert.equal(lines[4].match(stringRegex)?.length, 1);
    assert.equal(lines[4].match(stringRegex)?.[0], "\"\"\"\"");
});
