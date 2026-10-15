/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/semantic-model.test.js

    Purpose:

        Exercise declaration identity and type resolution on representative
        FreeBASIC source, independent of editor presentation.

    Responsibilities:

        - distinguish local, module, and aggregate names
        - verify aliases, namespaces, inheritance, and member chains
        - protect reference and cursor coordinates through source edits

    This file intentionally does NOT contain:

        - VS Code mocks
        - compiler execution
        - timing-sensitive assertions
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFreeBasicText, maskFreeBasicText, findCallContext } = require("../lib/freebasic-parser");
const { FreeBasicSemanticModel, tokenize } = require("../lib/semantic-model");

function modelFor(text) {
    const uri = { toString: () => "file:///workspace/example.bas" };
    const model = new FreeBasicSemanticModel([{ uri, parsed: parseFreeBasicText(text) }]);
    return {
        model, uri,
        resolve(line, column) { return model.resolveAt(uri, line, column); },
        members(line, column) { return model.completeMembers(uri, line, column)?.map((entry) => entry.name); }
    };
}

test("fields and locals with equal names have distinct reference sets", () => {
    const { model, resolve } = modelFor([
        "Type Item", "    value As Long", "End Type", "Dim itemValue As Item",
        "Sub Work()", "    Dim value As Long", "    itemValue.value = value", "End Sub",
        "Print itemValue.value", "' value is not code", 'Print "value"'
    ].join("\n"));
    const field = resolve(6, 15)[0];
    const local = resolve(6, 23)[0];
    assert.equal(field.declaration.type, "field");
    assert.equal(local.declaration.line, 5);
    assert.deepEqual(model.references(field).map((entry) => entry.occurrence.line), [1, 6, 8]);
    assert.deepEqual(model.references(local).map((entry) => entry.occurrence.line), [5, 6]);
});

test("block scope shadowing resolves to the nearest declaration", () => {
    const { resolve } = modelFor([
        "Sub Work()", " Dim value As Long", " Scope", "  Dim value As String",
        "  Print value", " End Scope", " Print value", "End Sub",
        "Sub Other()", " Print value", "End Sub"
    ].join("\n"));
    assert.equal(resolve(4, 9)[0].declaration.line, 3);
    assert.equal(resolve(6, 8)[0].declaration.line, 1);
    assert.deepEqual(resolve(9, 8), []);
});

test("forward labels resolve within their procedure scope", () => {
    const { model, resolve } = modelFor([
        "Sub Work()",
        "    Goto finish",
        "    Print 1",
        "finish:",
        "    Print 2",
        "End Sub",
        "Sub Other()",
        "    Goto finish",
        "End Sub"
    ].join("\n"));

    const target = resolve(1, 11)[0];
    assert.equal(target.declaration.type, "label");
    assert.equal(target.declaration.name, "finish");
    assert.deepEqual(model.references(target, false).map((entry) => entry.occurrence.line), [1]);
    assert.deepEqual(resolve(7, 11), [], "a procedure-local label must not leak into another procedure");
});

test("namespace imports, aliases, and pointer members use the declared type", () => {
    const { members, resolve } = modelFor([
        "Namespace Geometry", " Type Point", "  x As Long", " End Type", "End Namespace",
        "Using Geometry", "Type PointAlias As Point", "Dim pointPtr As PointAlias Ptr",
        "pointPtr->x = 1", "pointPtr->"
    ].join("\n"));
    assert.deepEqual(members(9, 10), ["x"]);
    assert.equal(resolve(8, 11)[0].declaration.line, 2);
});

test("inheritance includes public base fields and hides private members", () => {
    const { members } = modelFor([
        "Type BaseType", " x As Long", " Private:", " hidden As Long", "End Type",
        "Type Child Extends BaseType", " y As Long", "End Type", "Dim c As Child", "c."
    ].join("\n"));
    assert.deepEqual(members(9, 2)?.sort(), ["x", "y"]);
});

test("member chains, array elements, and function results retain their types", () => {
    const { members } = modelFor([
        "Type Point", " x As Long", "End Type", "Type Shape", " position As Point", "End Type",
        "Declare Function MakeShape() As Shape", "Dim items(3) As Shape", "items(0).position.", "MakeShape()."
    ].join("\n"));
    assert.deepEqual(members(8, 18), ["x"]);
    assert.deepEqual(members(9, 12), ["position"]);
});

test("a variable sharing its type name does not cause recursive resolution", () => {
    const { members } = modelFor("Type Point\n x As Long\nEnd Type\nDim point As Point\npoint.");
    assert.deepEqual(members(4, 6), ["x"]);
});

test("anonymous aggregates expose their fields and WITH resolves implicit members", () => {
    const { members, resolve } = modelFor([
        "Type Event", " Union", "  x As Long", "  y As Long", " End Union", "End Type",
        "Dim e As Event", "With e", " .x = 1", " .", "End With"
    ].join("\n"));
    assert.equal(resolve(8, 2)[0].declaration.name, "x");
    assert.deepEqual(members(9, 2)?.sort(), ["x", "y"]);
});

test("UTF-16 tokens and call offsets survive Unicode text and CRLF", () => {
    const source = 'Dim value As Long\r\nPrint "😀", value\r\nPrint Sin(1, ';
    const masked = maskFreeBasicText(source);
    assert.equal(masked.length, source.length);
    const value = tokenize(source).tokens.filter((token) => token.name === "value").at(-1);
    assert.equal(value.startColumn, 12);
    assert.equal(source.slice(value.offset, value.end), "value");
    assert.equal(findCallContext(source, source.length).name, "Sin");
    assert.equal(findCallContext(source, source.length).activeParameter, 1);
});

test("macro token-pasting operators stay separate from FreeBASIC hash suffixes", () => {
    const tokens = tokenize("#define JOIN(prefix, suffix) prefix##suffix\nDim precise# As Double\nPrint 1#\n").tokens;
    const paste = tokens.find((token) => token.name === "##");
    assert.equal(paste.kind, "punctuation");
    assert.equal(tokens[paste.index - 1].name, "prefix");
    assert.equal(tokens[paste.index + 1].name, "suffix");
    assert.ok(tokens.some((token) => token.name === "precise#" && token.kind === "identifier"));
    assert.ok(tokens.some((token) => token.name === "1#" && token.kind === "number"));
});

test("colon-separated declarations keep their physical positions", () => {
    const { resolve } = modelFor("Sub Work(): Dim value As Long: Print value: End Sub");
    const entries = resolve(0, 38);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].declaration.startColumn, 16);
});

test("declares and implementations share identity while overloads remain guarded", () => {
    const { model, resolve } = modelFor([
        "Declare Sub Work(ByVal first As Long)", "Sub Work(ByVal second As Long)",
        " Print second", "End Sub", "Work(1)"
    ].join("\n"));
    const target = resolve(4, 2)[0];
    assert.equal(model.declarationTargets([target])[0].declaration.line, 1);
    assert.deepEqual(model.references(target).map((entry) => entry.occurrence.line), [0, 1, 4]);
    assert.equal(model.renameProblem(target, "Different"), null);
});

test("rename rejects block capture and inherited member collisions", () => {
    const { model, resolve } = modelFor([
        "Type Parent", " taken As Long", "End Type", "Type Child Extends Parent", " value As Long", "End Type",
        "Sub Work()", " Dim outerValue As Long", " Scope", "  Dim localValue As Long", "  Print localValue, outerValue", " End Scope", "End Sub"
    ].join("\n"));
    assert.match(model.renameProblem(resolve(4, 2)[0], "taken"), /inherited/);
    assert.match(model.renameProblem(resolve(10, 10)[0], "outerValue"), /capture/);
});

test("lookup follows transitive includes and excludes unrelated modules", () => {
    const uri = (name) => ({ toString: () => `file:///workspace/${name}` });
    const main = uri("main.bas");
    const header = uri("types.bi");
    const nested = uri("nested.bi");
    const unrelated = uri("unrelated.bas");
    const model = new FreeBasicSemanticModel([
        { uri: main, parsed: parseFreeBasicText('Dim p As Point\np.x = 1\nPrint privateValue'), includeUris: new Set([header.toString()]) },
        { uri: header, parsed: parseFreeBasicText('#include once "nested.bi"'), includeUris: new Set([nested.toString()]) },
        { uri: nested, parsed: parseFreeBasicText('Type Point\n x As Long\nEnd Type') },
        { uri: unrelated, parsed: parseFreeBasicText('Dim privateValue As Long') }
    ]);
    assert.equal(model.resolveAt(main, 1, 2)[0].document.key, nested.toString());
    assert.deepEqual(model.resolveAt(main, 2, 10), []);
});

test("rename refuses conditionally duplicated locals", () => {
    const { model, resolve } = modelFor([
        "Sub Work()", " #if FEATURE", "  Dim value As Long", " #else",
        "  Dim value As String", " #endif", " Print value", "End Sub"
    ].join("\n"));
    assert.match(model.renameProblem(resolve(2, 7)[0]), /multiple declarations/);
});

/* end of tests/semantic-model.test.js */
