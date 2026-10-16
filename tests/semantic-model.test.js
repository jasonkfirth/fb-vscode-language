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
const { FreeBasicSemanticModel, isPrimitiveTypeName, sourceParameterTypeKey, tokenize } = require("../lib/semantic-model");
const { semanticTokenType } = require("../lib/semantic-token-data");

function modelFor(text) {
    const uri = { toString: () => "file:///workspace/example.bas" };
    const model = new FreeBasicSemanticModel([{ uri, parsed: parseFreeBasicText(text) }]);
    return {
        model, uri,
        resolve(line, column) { return model.resolveAt(uri, line, column); },
        members(line, column) { return model.completeMembers(uri, line, column)?.map((entry) => entry.name); }
    };
}

test("signature type keys retain qualifiers and do not treat nested types or defaults as arrays", () => {
    assert.deepEqual(sourceParameterTypeKey({ typeName: "Const Long Pointer", label: "ByVal value As Const Long Ptr" }),
        ["const long ptr", null]);
    assert.deepEqual(sourceParameterTypeKey({ typeName: "Long Ptr Ptr", label: "ByVal value As Long Ptr Ptr" }),
        ["long ptr ptr", null]);
    assert.deepEqual(sourceParameterTypeKey({ typeName: "Long", label: "values( Any, Any ) As Long" }), ["long", "any,any"]);
    assert.deepEqual(sourceParameterTypeKey({ typeName: "Long", label: "values() As Long" }), ["long", ""]);
    assert.deepEqual(sourceParameterTypeKey({ typeName: "Long", label: "Optional value = MakeValue()" }), ["long", null]);
    assert.deepEqual(sourceParameterTypeKey({ typeName: "Function(values() As Long) As Long", label: "ByVal callback As Function(values() As Long) As Long" }),
        ["function(values() as long) as long", null]);
});

test("callable identities preserve pointer depth and array dimensions across matching prototypes", () => {
    const parameters = [
        ["ByVal value As Long Ptr", "ByVal value As Long Pointer"],
        ["ByVal value As Long Ptr Ptr", "ByVal value As Long Pointer Pointer"],
        ["values(Any) As Long", "values( any ) As Long"],
        ["values(Any, Any) As Long", "values(any,any) As Long"]
    ];
    const headerUri = { toString: () => "file:///workspace/shapes.bi" };
    const sourceUri = { toString: () => "file:///workspace/shapes.bas" };
    const model = new FreeBasicSemanticModel([
        { uri: headerUri, parsed: parseFreeBasicText(parameters.map(([prototype]) => `Declare Sub ShapeProbe Overload(${prototype})`).join("\n")) },
        { uri: sourceUri, parsed: parseFreeBasicText(parameters.map(([_prototype, body]) => `Sub ShapeProbe(${body})\nEnd Sub\n`).join("")),
            includeUris: new Set([headerUri.toString()]) }
    ]);
    const prototypes = model.getDocument(headerUri).entries.filter((entry) => entry.declaration.type === "sub");
    const bodies = model.getDocument(sourceUri).entries.filter((entry) => entry.declaration.type === "sub");
    assert.equal(new Set(prototypes.map((entry) => entry.id)).size, parameters.length);
    for (let index = 0; index < parameters.length; index++) {
        assert.equal(prototypes[index].id, bodies[index].id, `prototype/body mismatch for ${parameters[index][0]}`);
    }
});

test("primitive type classification excludes aggregates and unresolved type expressions", () => {
    for (const name of ["Long", "Const Integer", "Double Ptr", "Any Pointer", "ZString * 32", "Const WString Ptr"]) {
        assert.equal(isPrimitiveTypeName(name), true, name);
    }
    for (const name of ["", "Object", "Object Ptr", "ValueAlias", "Geometry.Point", "Typeof(BuildValue())"]) {
        assert.equal(isPrimitiveTypeName(name), false, name);
    }
});

test("qualified callable tokens distinguish namespace owners from aggregate owners", () => {
    const headerUri = { toString: () => "file:///workspace/owners.bi" };
    const moduleUri = { toString: () => "file:///workspace/main.bas" };
    const header = "Namespace Helpers\nDeclare Function Calculate() As Long\nEnd Namespace\nType Widget\nnumber As Long\nDeclare Sub Touch()\nEnd Type\n";
    const source = "Function Helpers.Calculate() As Long\nReturn 1\nEnd Function\nSub Widget.Touch()\nEnd Sub\n";
    const model = new FreeBasicSemanticModel([
        { uri: headerUri, parsed: parseFreeBasicText(header) },
        { uri: moduleUri, parsed: parseFreeBasicText(source), includeUris: new Set([headerUri.toString()]) }
    ]);
    for (const entry of model.entries.filter((entry) => ["function", "sub"].includes(entry.declaration.type))) {
        assert.equal(semanticTokenType(entry), entry.name === "Calculate" ? "function" : "method", entry.declaration.name);
    }
});

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

test("procedure families follow shared declarations, not unrelated names or utility includes", () => {
    const uri = (name) => ({ toString: () => `file:///workspace/${name}` });
    const common = uri("common.bi"), headerA = uri("a/api.bi"), headerB = uri("b/api.bi");
    const moduleA = uri("a/main.bas"), moduleB = uri("b/main.bas"), consumer = uri("a/consumer.bas");
    const declaration = "Declare Sub FamilyBoundaryProbe()\n";
    const implementation = "Sub FamilyBoundaryProbe()\nEnd Sub\nFamilyBoundaryProbe()\n";
    const model = new FreeBasicSemanticModel([
        { uri: common, parsed: parseFreeBasicText("Const UtilityFlag = 1\n") },
        { uri: headerA, parsed: parseFreeBasicText(declaration) },
        { uri: headerB, parsed: parseFreeBasicText(declaration) },
        { uri: moduleA, parsed: parseFreeBasicText(implementation), includeUris: new Set([common.toString(), headerA.toString()]) },
        { uri: moduleB, parsed: parseFreeBasicText("FamilyBoundaryProbe()\n"), includeUris: new Set([common.toString(), headerB.toString()]) },
        { uri: consumer, parsed: parseFreeBasicText("FamilyBoundaryProbe()\n"), includeUris: new Set([headerA.toString()]) }
    ]);
    const target = model.resolveAt(moduleA, 0, "Sub F".length)[0];
    assert.equal(model.renameProblem(target, "RenamedBoundaryProbe"), null);
    assert.deepEqual([...new Set(model.references(target).map((entry) => entry.uri.toString()))].sort(),
        [headerA, moduleA, consumer].map((entry) => entry.toString()).sort(),
        "an independent header and its consumer must not be included in rename/reference results");
    const other = model.resolveAt(moduleB, 0, 2)[0];
    assert.notEqual(other.id, target.id);
    assert.deepEqual(model.declarationTargets([other]).map((entry) => entry.uri.toString()), [headerB.toString()]);
});

test("independent same-named UDT methods keep their own declaration families", () => {
    const documents = [];
    const uris = [];
    for (const name of ["first", "second"]) {
        const header = { toString: () => `file:///workspace/${name}.bi` };
        const source = { toString: () => `file:///workspace/${name}.bas` };
        uris.push(source);
        documents.push({ uri: header, parsed: parseFreeBasicText("Type Widget\nnumber As Long\nDeclare Sub Touch()\nEnd Type\n") });
        documents.push({ uri: source, includeUris: new Set([header.toString()]),
            parsed: parseFreeBasicText("Sub Widget.Touch()\nEnd Sub\nDim item As Widget\nitem.Touch()\n") });
    }
    const model = new FreeBasicSemanticModel(documents);
    const first = model.resolveAt(uris[0], 0, "Sub Widget.T".length);
    const second = model.resolveAt(uris[1], 0, "Sub Widget.T".length);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(first[0].id, second[0].id);
    assert.equal(model.renameProblem(first[0], "Retouch"), null);
    assert.deepEqual([...new Set(model.references(first[0]).map((entry) => entry.uri.toString()))].sort(),
        ["file:///workspace/first.bas", "file:///workspace/first.bi"]);
});

test("namespace families retain co-visible reopenings without unrelated namespace matches", () => {
    const uri = (name) => ({ toString: () => `file:///workspace/${name}` });
    const headerA = uri("a/api.bi"), extraA = uri("a/extra.bi"), headerB = uri("b/api.bi"), common = uri("common.bi");
    const moduleA = uri("a/main.bas"), moduleB = uri("b/main.bas"), consumer = uri("a/consumer.bas");
    const namespace = (name) => parseFreeBasicText(`Namespace Helpers\nConst ${name} = 1\nEnd Namespace\n`);
    const model = new FreeBasicSemanticModel([
        { uri: headerA, parsed: namespace("FirstValue") }, { uri: extraA, parsed: namespace("ExtraValue") },
        { uri: headerB, parsed: namespace("OtherValue") }, { uri: common, parsed: parseFreeBasicText("Const UtilityFlag = 1\n") },
        { uri: moduleA, parsed: parseFreeBasicText("Using Helpers\n"),
            includeUris: new Set([headerA.toString(), extraA.toString(), common.toString()]) },
        { uri: moduleB, parsed: parseFreeBasicText("Using Helpers\n"), includeUris: new Set([headerB.toString(), common.toString()]) },
        { uri: consumer, parsed: parseFreeBasicText("Using Helpers\n"), includeUris: new Set([headerA.toString()]) }
    ]);
    const first = model.resolveAt(moduleA, 0, "Using H".length);
    assert.equal(first.length, 1, "co-visible namespace reopenings should resolve as one namespace");
    assert.deepEqual(model.declarationTargets(first).map((entry) => entry.uri.toString()).sort(),
        [headerA.toString(), extraA.toString()].sort());
    assert.deepEqual([...new Set(model.references(first[0]).map((entry) => entry.uri.toString()))].sort(),
        [headerA, extraA, moduleA, consumer].map((entry) => entry.toString()).sort());
    const other = model.resolveAt(moduleB, 0, "Using H".length);
    assert.equal(other.length, 1);
    assert.notEqual(first[0].id, other[0].id);
    assert.deepEqual(model.declarationTargets(other).map((entry) => entry.uri.toString()), [headerB.toString()]);
    assert.match(model.renameProblem(first[0]), /requires compiler analysis/);
});

test("rename refuses conditionally duplicated locals", () => {
    const { model, resolve } = modelFor([
        "Sub Work()", " #if FEATURE", "  Dim value As Long", " #else",
        "  Dim value As String", " #endif", " Print value", "End Sub"
    ].join("\n"));
    assert.match(model.renameProblem(resolve(2, 7)[0]), /multiple declarations/);
});

/* end of tests/semantic-model.test.js */
