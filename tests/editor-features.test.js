/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/editor-features.test.js

    Purpose:

        Verify parser-to-editor mappings without a VS Code extension host.

    Responsibilities:

        - preserve hierarchical document symbols and parameter locations
        - verify current built-in hover classification
        - verify local include-path resolution

    This file intentionally does NOT contain:

        - provider registration
        - compiler execution
        - workspace indexing
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
    createDocumentSymbolTree,
    findScopedDocumentDeclarations,
    getBuiltInHover,
    resolveIncludePath
} = require("../lib/editor-features");
const { parseFreeBasicText } = require("../lib/freebasic-parser");
const { loadGrammarSourceFile } = require("../lib/grammar-data");

class Range {
    constructor(startLine, startColumn, endLine, endColumn) {
        this.start = { character: startColumn, line: startLine };
        this.end = { character: endColumn, line: endLine };
    }
}

class DocumentSymbol {
    constructor(name, detail, kind, range, selectionRange) {
        this.children = [];
        this.detail = detail;
        this.kind = kind;
        this.name = name;
        this.range = range;
        this.selectionRange = selectionRange;
    }
}

function createVscodeMock(includePaths = []) {
    return {
        DocumentSymbol,
        Range,
        SymbolKind: {
            Class: 4,
            Constant: 13,
            Constructor: 9,
            Enum: 10,
            EnumMember: 22,
            Field: 7,
            Function: 11,
            Key: 20,
            Method: 5,
            Namespace: 2,
            Property: 6,
            String: 14,
            Struct: 23,
            Variable: 12
        },
        Uri: {
            file(filePath) {
                return { fsPath: filePath };
            }
        },
        workspace: {
            getConfiguration() {
                return {
                    get(name, defaultValue) {
                        return name === "includePaths" ? includePaths : defaultValue;
                    }
                };
            },
            getWorkspaceFolder() {
                return null;
            }
        }
    };
}

function createDocument(text) {
    const lines = text.split("\n");
    return {
        lineCount: lines.length,
        lineAt(line) {
            return { text: lines[line] };
        }
    };
}

test("document symbols preserve containers, parameters, and local declarations", () => {
    const source = [
        "Namespace Demo",
        "Function SumValues(ByVal first As Integer, _",
        "                   ByVal second As Integer) As Integer",
        "    Dim result As Integer",
        "    Return first + second",
        "End Function",
        "End Namespace"
    ].join("\n");
    const parsed = parseFreeBasicText(source);
    const symbols = createDocumentSymbolTree(
        createVscodeMock(),
        createDocument(source),
        parsed.declarations
    );
    const procedure = symbols[0].children[0];

    assert.equal(symbols[0].name, "Demo");
    assert.equal(procedure.name, "SumValues");
    assert.deepEqual(procedure.children.map((symbol) => symbol.name), [
        "first",
        "second",
        "result"
    ]);
    assert.equal(procedure.children[1].selectionRange.start.line, 2);
});

test("document declaration lookup keeps repeated parameter names in their procedures", () => {
    const parsed = parseFreeBasicText([
        "Sub First(ByVal value As Integer)",
        "    Print value",
        "End Sub",
        "Sub Second(ByVal value As Integer)",
        "    Print value",
        "End Sub"
    ].join("\n"));
    const firstValue = findScopedDocumentDeclarations(
        parsed.declarations,
        "value",
        1,
        12
    );
    const secondValue = findScopedDocumentDeclarations(
        parsed.declarations,
        "value",
        4,
        12
    );
    const firstProcedure = findScopedDocumentDeclarations(
        parsed.declarations,
        "First",
        0,
        5
    );

    assert.equal(firstValue.length, 1);
    assert.equal(firstValue[0].parentDeclaration.name, "First");
    assert.equal(secondValue.length, 1);
    assert.equal(secondValue[0].parentDeclaration.name, "Second");
    assert.equal(firstProcedure[0].type, "sub");
});

test("built-in hover identifies current language data and its target release", () => {
    const grammarData = loadGrammarSourceFile(path.join(
        __dirname,
        "..",
        "syntaxes",
        "source",
        "freebasic.grammar-source.json"
    ));
    const hover = getBuiltInHover(grammarData, "ScreenRes");

    assert.match(hover, /graphics, input, or audio runtime function/);
    assert.match(hover, /FreeBASIC 1\.20\.3/);
});

test("include links resolve paths relative to the current source file", () => {
    const fixturePath = path.join(__dirname, "fixtures", "declarations.bas");
    const resolvedPath = resolveIncludePath(
        createVscodeMock(),
        fixturePath,
        { path: "dim-forms.bas", system: false }
    );

    assert.equal(resolvedPath, path.join(__dirname, "fixtures", "dim-forms.bas"));
});

/* end of tests/editor-features.test.js */
