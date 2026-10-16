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
    findSignatureCallContext,
    findDeclarationByName,
    findFoldingRanges,
    findIdentifierOccurrences,
    maskFreeBasicComments,
    maskFreeBasicText,
    parseFreeBasicText,
    splitDimVariables,
    stripComments
} = require("../lib/freebasic-parser");
const { loadGrammarSourceFile } = require("../lib/grammar-data");

function readFixture(name) {
    return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

test("operator declarations retain result types without borrowing constructor parameter types", () => {
    const parsed = parseFreeBasicText("Type Value\nnumber As Long\nDeclare Operator Cast() As Long\n" +
        "Declare Operator Cast() As Long Ptr\nDeclare Constructor(ByVal initial As Double)\nEnd Type\n" +
        "Operator Value.Let(ByRef other As Value)\nEnd Operator\n");
    assert.deepEqual(parsed.declarations.filter((entry) => entry.type === "operator").map((entry) => entry.typeName),
        ["Long", "Long Ptr", ""]);
    assert.equal(parsed.declarations.find((entry) => entry.type === "constructor").typeName, "");
});

test("grammar source loads expected symbol groups", () => {
    const grammarData = loadGrammarSourceFile(path.join(__dirname, "..", "syntaxes", "source", "freebasic.grammar-source.json"));

    assert.equal(grammarData.sourceVersion, "1.20.5");
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
    assert.ok(grammarData.bundledFunctions.includes("Serialize"));
    assert.ok(grammarData.bundledFunctions.includes("Deserialize"));
    assert.ok(grammarData.intrinsicFunctions.includes("__FB_SERIALIZE"));
    assert.ok(grammarData.intrinsicFunctions.includes("__FB_DESERIALIZE"));
    assert.ok(grammarData.libraryTypes.includes("COMSTATUS"));
    assert.ok(grammarData.libraryTypes.includes("EVENT"));
    assert.ok(grammarData.symbolicConstants.includes("SC_ESCAPE"));
    assert.ok(grammarData.symbolicConstants.includes("FB_SERIALIZE_INVALID"));
    assert.ok(grammarData.symbolicConstants.includes("FB_SERIALIZE_OUT_OF_MEMORY"));
    assert.ok(grammarData.symbolicConstants.includes("GFX_VULKAN"));
    assert.ok(grammarData.symbolicConstants.includes("EVENT_WINDOW_RESIZE"));
    assert.ok(grammarData.symbolicConstants.includes("XPAD_BUTTON_A"));
    assert.ok(grammarData.symbolicConstants.includes("GET_SCANLINE_SIZE"));
    assert.ok(grammarData.symbolicConstants.includes("SC_F12"));
});

test("stripComments removes apostrophe comments", () => {
    assert.equal(stripComments("Dim value As Integer ' comment"), "Dim value As Integer ");
});

test("multiple type aliases preserve name positions and do not open aggregate scopes", () => {
    const source = "Namespace Library\n Type As Long FirstType, SecondType\n Type FirstAlias As FirstType, SecondAlias As SecondType\n Type Opaque As Opaque\n Dim value As FirstAlias\nEnd Namespace\nDim outside As Long\n";
    const declarations = parseFreeBasicText(source).declarations;
    for (const name of ["FirstType", "SecondType", "FirstAlias", "SecondAlias", "Opaque"]) {
        const declaration = declarations.find((entry) => entry.name === name);
        assert.equal(declaration.detail, "Type alias");
        assert.equal(declaration.containerName, "Library");
        assert.equal(source.split("\n")[declaration.line].slice(declaration.startColumn, declaration.endColumn), name);
    }
    assert.equal(declarations.find((entry) => entry.name === "value").containerName, "Library");
    assert.equal(declarations.find((entry) => entry.name === "outside").containerName, "");
    assert.ok(!declarations.some((entry) => entry.name.toLowerCase() === "as"));
});

test("special procedure declarations preserve operator and type suffix positions", () => {
    const source = [
        "Type T",
        "\tDeclare operator[](index as Integer) as T",
        "\tDeclare Operator ()(ByVal index As Long) As Long",
        "\tDeclare constructor%()",
        "End Type",
        "Operator% +(byref left as T, byref right as T) as T",
        "End Operator",
        "Operator T.()(ByVal index As Long) As Long",
        "End Operator",
        "Operator not%(byref value as T) as T"
    ].join("\n");
    const lines = source.split("\n");
    const declarations = parseFreeBasicText(source).declarations;
    const expectedRanges = [
        { line: 1, type: "operator", selected: "[]" },
        { line: 2, type: "operator", selected: "()" },
        { line: 3, type: "constructor", selected: "%" },
        { line: 5, type: "operator", selected: "%" },
        { line: 7, type: "operator", selected: "T.()" },
        { line: 9, type: "operator", selected: "not%" }
    ];

    for (const expected of expectedRanges) {
        const declaration = declarations.find((entry) =>
            entry.line === expected.line && entry.type === expected.type
        );
        assert.ok(declaration);
        assert.equal(
            lines[declaration.line].slice(declaration.startColumn, declaration.endColumn),
            expected.selected
        );
    }
});

test("special procedure names in bodies remain calls and assignments", () => {
    const parsed = parseFreeBasicText([
        "Sub caller()",
        "\tconstructor%()",
        "\toperator% = 1",
        "End Sub",
        "Dim outside As Integer"
    ].join("\n"));
    const outside = parsed.declarations.find((entry) => entry.name === "outside");

    assert.ok(!parsed.declarations.some((entry) =>
        entry.line === 1 || entry.line === 2
    ));
    assert.equal(outside.containerName, "");
});

test("comment-only masking retains string literals and nested multiline state", () => {
    const comments = "' quoted \"comment\"\r\n/' outer\n/' nested '/\nend '/\nREM ignored\n";
    const maskedComments = maskFreeBasicComments(comments);
    assert.equal(maskedComments.length, comments.length);
    assert.match(maskedComments, /^\s*$/);
    const source = 'Print "retained literal" \' ignored\n';
    const masked = maskFreeBasicComments(source);
    assert.equal(masked.length, source.length);
    assert.ok(masked.includes('"retained literal"'));
    assert.ok(!masked.includes("ignored"));
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

test("compiler option ranges mask escaped literals in parser occurrences", () => {
    const source = String.raw`#if 1
Option Escape
#endif
Print "inside \" : Dim escapedOnlyName As Integer ([)]"`;
    const statementStart = source.indexOf("Print");
    const statementEnd = source.length;
    const ranges = [{ start: statementStart, end: statementEnd }];
    const sourceOnly = parseFreeBasicText(source);
    const compilerAware = parseFreeBasicText(source, null, ranges);

    assert.ok(sourceOnly.occurrences.some((occurrence) => occurrence.name === "escapedOnlyName"),
        "source-only parsing must not guess the conditional option state");
    assert.ok(sourceOnly.declarations.some((declaration) => declaration.name === "escapedOnlyName"),
        "an incorrect quote boundary can make string contents look like a declaration");
    assert.ok(!compilerAware.occurrences.some((occurrence) => occurrence.name === "escapedOnlyName"),
        "compiler-confirmed escape mode must hide identifiers within the literal");
    assert.ok(!compilerAware.declarations.some((declaration) => declaration.name === "escapedOnlyName"),
        "compiler-aware parsing must not invent the corresponding declaration");
    assert.equal(compilerAware.text.length, source.length, "compiler-aware masking must preserve offsets");
});

test("source masking keeps UTF-16 columns aligned after supplementary characters", () => {
    const source = 'Print "😀" + visibleName \' hiddenName\nPrint afterEmoji';
    const masked = maskFreeBasicText(source);
    const occurrences = findIdentifierOccurrences(source);
    const visibleName = occurrences.find((occurrence) => occurrence.name === "visibleName");

    assert.equal(masked.length, source.length);
    assert.equal(visibleName.startColumn, source.split("\n")[0].indexOf("visibleName"));
    assert.deepEqual(occurrences.map((occurrence) => occurrence.name), ["Print", "visibleName", "Print", "afterEmoji"]);
});

test("REM comment detection respects complete identifier boundaries", () => {
    const source = [
        "REMEMBER = 1",
        "xREM = 2",
        "REM hiddenName",
        "REM_ = 3"
    ].join("\n");

    assert.deepEqual(
        findIdentifierOccurrences(source).map((occurrence) => occurrence.name),
        ["REMEMBER", "xREM", "REM_"]
    );
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

test("OPTION NOKEYWORD REM stops treating REM identifiers as comments", () => {
    const source = [
        "Option NoKeyword REM",
        "Dim REM As Integer",
        "REM = (1 + 2)",
        "REM #region",
        "REM #endregion",
        ""
    ].join("\n");
    const maskedLines = maskFreeBasicText(source).split("\n");
    const identifiers = findIdentifierOccurrences(source);
    const ranges = findFoldingRanges(source);
    const declaration = findDeclarationByName(parseFreeBasicText(source).declarations, "REM");

    assert.equal(maskedLines[1], "Dim REM As Integer");
    assert.equal(maskedLines[2], "REM = (1 + 2)");
    assert.equal(declaration?.type, "variable");
    assert.ok(identifiers.some((occurrence) => occurrence.name === "REM" && occurrence.line === 2));
    assert.equal(ranges.some((range) => range.kind === "region"), false,
        "REM region markers are not comments once REM is removed as a keyword");
});

test("OPTION NOKEYWORD REM inside conditionals or macro bodies does not leak", () => {
    const source = [
        "#if 0",
        "Option NoKeyword REM",
        "#endif",
        "REM hiddenAfterConditional",
        "#macro DisableRem",
        "Option NoKeyword REM",
        "#endmacro",
        "REM hiddenAfterMacro",
        ""
    ].join("\n");
    const occurrences = findIdentifierOccurrences(source);

    assert.equal(occurrences.some((occurrence) => occurrence.name === "hiddenAfterConditional"), false);
    assert.equal(occurrences.some((occurrence) => occurrence.name === "hiddenAfterMacro"), false);
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

test("trailing identifier underscores do not become line continuations", () => {
    const parsed = parseFreeBasicText([
        "Dim trailing_ As Integer",
        "Dim following As Integer",
        "Dim continued As Integer = 1 _",
        "    + 2",
        "Dim afterContinuation As Integer"
    ].join("\n"));
    const declarationByName = new Map(parsed.declarations.map((declaration) => [declaration.name, declaration]));

    assert.equal(declarationByName.get("trailing_").line, 0);
    assert.equal(declarationByName.get("following").line, 1);
    assert.equal(declarationByName.get("continued").line, 2);
    assert.equal(declarationByName.get("afterContinuation").line, 4);
    assert.deepEqual(parsed.statements.map(({ startLine, endLine }) => [startLine, endLine]), [
        [0, 0], [1, 1], [2, 3], [4, 4]
    ]);
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

test("Signature Help recognizes bare calls without changing navigation call contexts", () => {
    for (const [text, name, parameter] of [
        ["Work ", "Work", 0], ["Work 1, ", "Work", 1],
        ['Work Nested(1, 2), "x,y", ', "Work", 2],
        ['Work 1, _\n "continued,arg", _\n ', "Work", 2],
        ["label: Scope.Work 1, ", "Scope.Work", 1],
        ["Call Scope.Work 1, ", "Scope.Work", 1],
        ["receiver->Work 1, ", "Work", 1],
        ["receiver . Work 1, ", "Work", 1],
        ["If condition Then Work 1, ", "Work", 1],
        ['If condition Then Work 1, "then,else" Else Other 2, ', "Other", 1]
    ]) {
        const context = findSignatureCallContext(text, text.length);
        assert.equal(context?.name, name, text);
        assert.equal(context?.activeParameter, parameter, text);
        assert.equal(context?.bare, true);
        assert.equal(findCallContext(text, text.length), null, "navigation keeps its explicit-call parser");
    }
    for (const text of ["first, second", "value = 1, 2", "Scope.Work", "' Work 1, 2", "Work 1\nvalue"]) {
        assert.equal(findSignatureCallContext(text, text.length), null, text);
    }
    const nested = "Work Nested(1, ";
    assert.equal(findSignatureCallContext(nested, nested.length)?.name, "Nested");
});

test("call context counts only top-level arguments", () => {
    const source = "result = BuildPerson(GetName(1, 2), value, \"x,y\")";
    const context = findCallContext(source, source.indexOf("value") + "value".length);

    assert.equal(context.name, "BuildPerson");
    assert.equal(context.activeParameter, 1);
});

test("call context survives multiline calls and ignores nested brace commas", () => {
    const multilineSource = "result = BuildPerson(\n    first,\n    value";
    const multilineContext = findCallContext(multilineSource, multilineSource.length);

    assert.equal(multilineContext?.name, "BuildPerson");
    assert.equal(multilineContext?.activeParameter, 1);

    const bracesSource = "result = BuildPerson({1, {2, 3}}, value)";
    const bracesContext = findCallContext(bracesSource, bracesSource.indexOf("value") + "value".length);
    assert.equal(bracesContext?.name, "BuildPerson");
    assert.equal(bracesContext?.activeParameter, 1);

    const incompleteBracesSource = "result = BuildPerson({1, {2, 3";
    const incompleteBracesContext = findCallContext(incompleteBracesSource, incompleteBracesSource.length);
    assert.equal(incompleteBracesContext?.name, "BuildPerson");
    assert.equal(incompleteBracesContext?.activeParameter, 0);
});

test("call context supports overloaded index operators and nested bracket expressions", () => {
    const source = "indexedInstance[GetIndex(1, 2), value]";
    const context = findCallContext(source, source.indexOf("value") + "value".length);

    assert.equal(context.name, "indexedInstance");
    assert.equal(context.activeParameter, 1);
    assert.equal(context.indexing, true);
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

test("REM comment regions are recognized only when REM is still a comment keyword", () => {
    assert.deepEqual(findFoldingRanges("REM #region Setup\nREM #endregion\n"), [
        { startLine: 0, endLine: 1, kind: "region" }
    ]);
});

test("folding ranges include multiline nested block comments but ignore comment-like text", () => {
    const ranges = findFoldingRanges([
        "Print \"/' not a comment\"",
        "/' outer comment",
        "    /' nested comment '/",
        "outer comment continues '/ Print 1",
        "Print 2"
    ].join("\n"));

    assert.deepEqual(ranges, [
        { startLine: 1, endLine: 3, kind: "comment" }
    ]);
});

test("folding ranges group line comments without folding inline comments or regions twice", () => {
    const ranges = findFoldingRanges([
        "' first comment",
        "' second comment",
        "REM third comment",
        "Print 1 ' inline comment",
        "' #region Documentation",
        "' region body",
        "' #endregion",
        "Print \"' not a comment\"",
        "REM final comment",
        "REM last comment"
    ].join("\n"));

    assert.deepEqual(ranges, [
        { startLine: 0, endLine: 2, kind: "comment" },
        { startLine: 4, endLine: 6, kind: "region" },
        { startLine: 8, endLine: 9, kind: "comment" }
    ]);
});

test("folding ranges group consecutive includes and USING directives as imports", () => {
    const ranges = findFoldingRanges([
        '#include "first.bi"',
        '#include once "second.bi"',
        "Using Graphics",
        "Using Geometry, Physics",
        "Print 1",
        '#include "standalone.bi"'
    ].join("\n"));

    assert.deepEqual(ranges, [
        { startLine: 0, endLine: 3, kind: "imports" }
    ]);
});

test("folding ranges cover continued statements without matching underscores in comments or strings", () => {
    const ranges = findFoldingRanges([
        "Declare Function BuildThing( _",
        "    ByVal first As Long, _",
        "    ByVal second As Long _",
        ") As Long",
        'Print "literal _"',
        "' comment _",
        "Print 1"
    ].join("\n"));

    assert.deepEqual(ranges, [
        { startLine: 0, endLine: 3 }
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
