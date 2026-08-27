/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/parser.test.js

    Purpose:

        Verify lightweight declaration parsing and source-backed language data.

    Responsibilities:

        - test declaration and variable parsing helpers
        - test current language-data groups used by editor features
        - protect the generated quoted-string rule from regressions

    This file intentionally does NOT contain:

        - VS Code host integration tests
        - compiler execution
        - grammar generation
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
    findCallContext,
    findDeclarationByName,
    findFoldingRanges,
    findIdentifierOccurrences,
    maskFreeBasicText,
    parseFreeBasicText,
    splitDimVariables,
    stripComments
} = require("../lib/freebasic-parser");
const { loadGrammarSourceFile } = require("../lib/grammar-data");

function readFixture(name) {
    return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

test("grammar source loads expected symbol groups", () => {
    const grammarData = loadGrammarSourceFile(path.join(__dirname, "..", "syntaxes", "source", "freebasic.grammar-source.json"));

    assert.equal(grammarData.sourceVersion, "1.20.3");
    assert.ok(grammarData.preprocessorDirectives.includes("LOOKUP"));
    assert.ok(grammarData.keywords.includes("FUNCTION"));
    assert.ok(!grammarData.keywords.includes("AUDIO"));
    assert.ok(!grammarData.keywords.includes("STREAM"));
    assert.ok(grammarData.runtimeFunctions.includes("THREADCREATE"));
    assert.ok(grammarData.graphicsFunctions.includes("SCREENRES"));
    assert.ok(grammarData.graphicsFunctions.includes("GETTOUCH"));
    assert.ok(grammarData.graphicsFunctions.includes("GETXPAD"));
    assert.ok(grammarData.graphicsFunctions.includes("VOL"));
    assert.ok(grammarData.compilerDefines.includes("__FB_GFXLIB3__"));
    assert.ok(grammarData.compilerDefines.includes("__FB_NUTTX__"));
    assert.ok(grammarData.compilerDefines.includes("FB_NO_GFXLIB"));
    assert.ok(grammarData.bundledFunctions.includes("__BUILTIN_MEMCPY"));
    assert.ok(grammarData.bundledFunctions.includes("GFX3SURFACECREATE"));
    assert.ok(grammarData.bundledFunctions.includes("COMGETSTATUS"));
    assert.ok(grammarData.bundledFunctions.includes("RAWOPEN"));
    assert.ok(grammarData.bundledFunctions.includes("ECHO"));
    assert.ok(grammarData.libraryTypes.includes("COMSTATUS"));
    assert.ok(grammarData.libraryTypes.includes("EVENT"));
    assert.ok(grammarData.symbolicConstants.includes("SC_ESCAPE"));
    assert.ok(grammarData.symbolicConstants.includes("GFX_VULKAN"));
    assert.ok(grammarData.symbolicConstants.includes("EVENT_WINDOW_RESIZE"));
    assert.ok(grammarData.symbolicConstants.includes("XPAD_BUTTON_A"));
    assert.ok(grammarData.symbolicConstants.includes("GET_SCANLINE_SIZE"));
    assert.ok(grammarData.symbolicConstants.includes("SC_F12"));
});

test("stripComments removes apostrophe comments", () => {
    assert.equal(stripComments("Dim value As Integer ' comment"), "Dim value As Integer ");
});

test("source masking preserves positions while ignoring strings and comments", () => {
    const source = [
        "Dim message As String = \"that's not a comment\"",
        "Print message ' message in a comment",
        "/' message in a block comment",
        "still hidden '/ Print message"
    ].join("\n");
    const masked = maskFreeBasicText(source);
    const occurrences = findIdentifierOccurrences(source)
        .filter((occurrence) => occurrence.name.toLowerCase() === "message");

    assert.equal(masked.length, source.length);
    assert.equal(occurrences.length, 3);
    assert.deepEqual(occurrences.map((occurrence) => occurrence.line), [0, 1, 3]);
});

test("source masking handles escaped strings, REM comments, and nested block comments", () => {
    const source = [
        "Dim textValue As String = !\"quote: \\\" and apostrophe \\' remains text\"",
        "Print textValue",
        "REM textValue is hidden",
        "/' outer textValue",
        "   /' nested textValue '/",
        "   still hidden textValue '/ Print textValue"
    ].join("\n");
    const occurrences = findIdentifierOccurrences(source)
        .filter((occurrence) => occurrence.name.toLowerCase() === "textvalue");

    assert.deepEqual(occurrences.map((occurrence) => occurrence.line), [0, 1, 5]);
    assert.equal(maskFreeBasicText(source).length, source.length);
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
    assert.equal(buildPerson.parentDeclaration.name, "Demo");
    assert.equal(buildPerson.endLine, 19);
    assert.equal(buildPerson.parameters[0].name, "inputName");
    assert.equal(buildPerson.parameters[0].typeName, "String");
});

test("parseFreeBasicText traces nested members and continued signatures", () => {
    const parsed = parseFreeBasicText([
        "Namespace Tools",
        "Type Counter",
        "    Declare Constructor(ByVal initialValue As Integer)",
        "    value As Integer",
        "End Type",
        "Function SumValues(ByVal first As Integer, _",
        "                   ByVal second As Integer) As Integer",
        "    Dim result As Integer",
        "    Return first + second",
        "End Function",
        "End Namespace"
    ].join("\n"));
    const field = findDeclarationByName(parsed.declarations, "Tools.Counter.value");
    const procedure = findDeclarationByName(parsed.declarations, "Tools.SumValues");
    const local = findDeclarationByName(parsed.declarations, "result");

    assert.equal(field.type, "field");
    assert.equal(field.parentDeclaration.name, "Counter");
    assert.equal(procedure.parameters.length, 2);
    assert.equal(procedure.signature.includes("_"), false);
    assert.equal(local.parentDeclaration, procedure);
    assert.equal(procedure.endLine, 9);
});

test("parseFreeBasicText traces macro blocks, loop variables, and access sections", () => {
    const parsed = parseFreeBasicText([
        "#macro RepeatValue(value)",
        "    For index As Integer = 0 To 2",
        "#endmacro",
        "Type Holder",
        "Private:",
        "    item As Integer",
        "End Type"
    ].join("\n"));
    const macro = findDeclarationByName(parsed.declarations, "RepeatValue");
    const loopVariable = findDeclarationByName(parsed.declarations, "RepeatValue.index");
    const field = findDeclarationByName(parsed.declarations, "Holder.item");

    assert.equal(macro.endLine, 2);
    assert.equal(macro.parameters[0].name, "value");
    assert.equal(loopVariable.parentDeclaration, macro);
    assert.equal(field.type, "field");
    assert.equal(findDeclarationByName(parsed.declarations, "Private"), null);
});

test("parseFreeBasicText records include paths and precise link ranges", () => {
    const parsed = parseFreeBasicText([
        "#include once \"local.bi\"",
        "#include <fbgfx.bi>"
    ].join("\n"));

    assert.deepEqual(parsed.includes, [
        { path: "local.bi", system: false, line: 0, startColumn: 15, endColumn: 23 },
        { path: "fbgfx.bi", system: true, line: 1, startColumn: 10, endColumn: 18 }
    ]);
});

test("call context counts only top-level arguments", () => {
    const source = "result = BuildPerson(GetName(1, 2), value, \"x,y\")";
    const context = findCallContext(source, source.indexOf("value") + "value".length);

    assert.equal(context.name, "BuildPerson");
    assert.equal(context.activeParameter, 1);
});

test("folding ranges cover language blocks, preprocessor blocks, and comment regions", () => {
    const ranges = findFoldingRanges([
        "' #region Setup",
        "Dim value As Integer",
        "' #endregion",
        "#ifdef __FB_WIN32__",
        "Sub Work()",
        "    If value Then",
        "        Print value",
        "    End If",
        "End Sub",
        "#endif"
    ].join("\n"));

    assert.deepEqual(ranges, [
        { startLine: 0, endLine: 2, kind: "region" },
        { startLine: 3, endLine: 9, kind: "region" },
        { startLine: 4, endLine: 8, kind: undefined },
        { startLine: 5, endLine: 7, kind: undefined }
    ]);
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
    assert.equal(findDeclarationByName(parsed.declarations, "name").name, "name$");
    assert.equal(findDeclarationByName(parsed.declarations, "alpha").startColumn, 4);
});

test("anonymous enums expose their members without inventing a container symbol", () => {
    const parsed = parseFreeBasicText([
        "Enum",
        "    FirstValue = 1",
        "    SecondValue",
        "End Enum",
        "100: Print FirstValue"
    ].join("\n"));

    assert.equal(findDeclarationByName(parsed.declarations, "FirstValue").type, "enumMember");
    assert.equal(findDeclarationByName(parsed.declarations, "SecondValue").type, "enumMember");
    assert.equal(findDeclarationByName(parsed.declarations, "100").type, "label");
    assert.equal(parsed.declarations.some((declaration) => declaration.type === "enum"), false);
});

test("generated grammar keeps empty-string comparisons self-contained", () => {
    const grammarPath = path.join(__dirname, "..", "syntaxes", "freebasic.tmLanguage.json");
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
    const stringPattern = grammar.repository.strings.patterns.find(
        (pattern) => pattern.name === "string.quoted.double.freebasic"
    );
    const stringRegex = new RegExp(stringPattern.match, "g");
    const lines = readFixture("string-regressions.bas").split(/\r?\n/);

    assert.equal(lines[0].match(stringRegex)?.length, 1);
    assert.equal(lines[1].match(stringRegex)?.length, 1);
    assert.equal(lines[2].match(stringRegex)?.length, 1);
    assert.equal(lines[4].match(stringRegex)?.length, 1);
    assert.equal(lines[4].match(stringRegex)?.[0], "\"\"\"\"");
});

test("generated grammar keeps escape strings and nested comments self-contained", () => {
    const grammarPath = path.join(__dirname, "..", "syntaxes", "freebasic.tmLanguage.json");
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
    const escapePattern = grammar.repository.strings.patterns.find(
        (pattern) => pattern.name === "string.quoted.escape.freebasic"
    );
    const escapeRegex = new RegExp(escapePattern.match, "g");
    const source = "Print !\"quote: \\\" and apostrophe \\' remain inside\"";

    assert.deepEqual(source.match(escapeRegex), [
        "!\"quote: \\\" and apostrophe \\' remain inside\""
    ]);
    assert.deepEqual(grammar.repository.blockComment.patterns, [
        { include: "#blockComment" }
    ]);
});

test("generated grammar scopes declaration names", () => {
    const grammarPath = path.join(__dirname, "..", "syntaxes", "freebasic.tmLanguage.json");
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));

    assert.equal(
        grammar.repository.declarations.patterns[0].captures["2"].name,
        "entity.name.function.freebasic"
    );
    assert.equal(
        grammar.repository.declarations.patterns[1].captures["2"].name,
        "entity.name.type.freebasic"
    );
    assert.equal(
        grammar.repository.preprocessor.patterns[0].beginCaptures["4"].name,
        "entity.name.function.preprocessor.freebasic"
    );
});

test("generated grammar recognizes current numeric literal forms", () => {
    const grammarPath = path.join(__dirname, "..", "syntaxes", "freebasic.tmLanguage.json");
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
    const numericPattern = grammar.repository.numbers.patterns[0].match.replace(/^\(\?i\)/, "");
    const numericRegex = new RegExp(numericPattern, "gi");
    const literals = [
        "&hFEFF00FF",
        "&b101010",
        "&o755",
        "&777",
        "18446744073709551615ull",
        ".5f",
        "1.",
        "6.02e+23",
        "1.0d-4"
    ];

    for (const literal of literals) {
        numericRegex.lastIndex = 0;
        assert.equal(literal.match(numericRegex)?.[0], literal);
    }
    assert.equal("name123".match(numericRegex), null);
});

/* end of tests/parser.test.js */
