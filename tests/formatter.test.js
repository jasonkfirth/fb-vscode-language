/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/formatter.test.js

    Purpose:

        Verify the formatter only changes supported block indentation.

    Responsibilities:

        - cover nested and alternate block indentation
        - preserve line endings, comments, continued lines, and source tokens
        - keep unsupported same-line blocks unchanged

    This file intentionally does NOT contain:

        - VS Code extension-host tests
        - compiler execution
        - stylistic formatting expectations
*/

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDocumentFormattingProvider, createDocumentRangeFormattingProvider } = require("../lib/editor-features");
const { formatFreeBasicIndentation } = require("../lib/freebasic-formatter");
const { parseFreeBasicText } = require("../lib/freebasic-parser");

function applyIndentationEdits(text, edits) {
    const lines = text.split(/\r\n|\n|\r/);
    for (const edit of edits) {
        lines[edit.line] = `${edit.newText}${lines[edit.line].slice(edit.end)}`;
    }
    return lines.join(text.match(/\r\n|\n|\r/)?.[0] || "\n");
}

test("formatter uses native escaped-string context for code and following comments", () => {
    const source = String.raw`Sub Main()
Print "inside \" /' still quoted"
' keep comment
If 1 Then
Print 1
End If
End Sub
`;
    const escapes = [{ start: 0, end: source.length }];
    const parsed = parseFreeBasicText(source, null, escapes);
    const expected = source.split("\n");
    for (const line of [1, 2, 3, 5]) expected[line] = "    " + expected[line];
    expected[4] = "        " + expected[4];
    assert.equal(applyIndentationEdits(source, formatFreeBasicIndentation(source, parsed)), expected.join("\n"));
});

test("formatter uses native REM line policy when the option originates outside the file", () => {
    const source = "Sub Main()\nIf 1 Then\nRem = 1 : End If\nPrint 2\nEnd Sub\n";
    const lexical = { remKeywordDisabledLineOffsets: [source.indexOf("Rem")], remIdentifierOffsets: [], defaultEscapedStringRanges: [] };
    const expected = "Sub Main()\n    If 1 Then\nRem = 1 : End If\n    Print 2\nEnd Sub\n";
    assert.equal(applyIndentationEdits(source, formatFreeBasicIndentation(source, parseFreeBasicText(source), {}, [], lexical)), expected);
    assert.deepEqual(formatFreeBasicIndentation(expected), [], "missing native REM facts must not make repeat formatting undo the correct result");
});

test("formatter leaves compiler-inactive text unchanged and ignores its block structure", () => {
    const source = ["Sub Main()", "#if 0", "  End Sub", " If ignored Then ' \u{1f600}", "#endif", "If 1 Then", "Print 1", "End If", "End Sub", ""].join("\r\n");
    const inactive = { start: source.indexOf("  End Sub"), end: source.indexOf("#endif") };
    const expected = ["Sub Main()", "    #if 0", "  End Sub", " If ignored Then ' \u{1f600}", "    #endif", "    If 1 Then", "        Print 1", "    End If", "End Sub", ""].join("\r\n");
    const edits = formatFreeBasicIndentation(source, null, {}, [inactive, inactive]);
    assert.equal(applyIndentationEdits(source, edits), expected);
    assert.equal(edits.some((edit) => edit.line === 2 || edit.line === 3), false);
    assert.deepEqual(formatFreeBasicIndentation(expected), [],
        "without current branch facts a repeat format must not guess across conditional block boundaries");
});

test("formatter bounds inactive masks and rejects partial-line exclusions", () => {
    const source = "Sub Main()\nPrint 1\nEnd Sub\n";
    const partial = { start: source.indexOf("Print") + 1, end: source.indexOf("End Sub") };
    assert.deepEqual(formatFreeBasicIndentation(source, null, {}, [partial, null, { start: -1, end: source.length }]),
        formatFreeBasicIndentation(source));
    assert.deepEqual(formatFreeBasicIndentation(source, null, {}, Array(5001).fill({ start: 0, end: source.length })), []);
});

test("formatter indents nested blocks and aligns alternate branches", () => {
    const source = [
        "Sub Main()",
        "If ready Then",
        "Print \"first\"",
        "ElseIf retrying Then",
        "Select Case result",
        "Case 1",
        "Print \"second\"",
        "Case Else",
        "Print \"other\"",
        "End Select",
        "Else",
        "Print \"last\"",
        "End If",
        "End Sub",
        ""
    ].join("\r\n");
    const expected = [
        "Sub Main()",
        "    If ready Then",
        "        Print \"first\"",
        "    ElseIf retrying Then",
        "        Select Case result",
        "        Case 1",
        "            Print \"second\"",
        "        Case Else",
        "            Print \"other\"",
        "        End Select",
        "    Else",
        "        Print \"last\"",
        "    End If",
        "End Sub",
        ""
    ].join("\r\n");

    assert.equal(applyIndentationEdits(source, formatFreeBasicIndentation(source)), expected);
});

test("formatter handles declaration and preprocessor blocks with configured tabs", () => {
    const source = "Type Value\nnumber As Integer\nEnd Type\n#if defined(__FB_LANG__)\nDim item As Value\n#else\nDim item As Integer\n#endif\n";
    const expected = "Type Value\n\tnumber As Integer\nEnd Type\n#if defined(__FB_LANG__)\n\tDim item As Value\n#else\n\tDim item As Integer\n#endif\n";

    assert.equal(applyIndentationEdits(source, formatFreeBasicIndentation(source, null, { insertSpaces: false })), expected);
});

test("formatter aligns standalone comments and preserves block comments, continuations, and source text", () => {
    const source = "Sub Main()\n' keep this comment at its existing column\nCall Consume( _\n  1, _\n    2)\nPrint  \"unchanged spacing\"  ' trailing comment\nEnd Sub\n";
    const expected = "Sub Main()\n    ' keep this comment at its existing column\nCall Consume( _\n  1, _\n    2)\n    Print  \"unchanged spacing\"  ' trailing comment\nEnd Sub\n";

    assert.equal(applyIndentationEdits(source, formatFreeBasicIndentation(source)), expected);

    const blockComment = "Sub Main()\n/' block comment\n' apostrophe text within the block\n'/\nREM standalone comment\nEnd Sub\n";
    const blockExpected = "Sub Main()\n/' block comment\n' apostrophe text within the block\n'/\n    REM standalone comment\nEnd Sub\n";
    assert.equal(applyIndentationEdits(blockComment, formatFreeBasicIndentation(blockComment)), blockExpected);
});

test("formatter ignores same-line compound statements instead of inventing block depth", () => {
    const source = "If ready Then: Print \"yes\"\nPrint \"next\"\nSub Inline(): Print \"body\": End Sub\nPrint \"last\"\n";
    assert.deepEqual(formatFreeBasicIndentation(source), []);
});

test("inline closing statements close an existing block without formatting the colon line", () => {
    const source = "Sub Main()\nIf ready Then\nPrint 1\nEnd If: Print 2\nPrint 3\nEnd Sub\n";
    const expected = "Sub Main()\n    If ready Then\n        Print 1\nEnd If: Print 2\n    Print 3\nEnd Sub\n";

    assert.equal(applyIndentationEdits(source, formatFreeBasicIndentation(source)), expected);
});

test("formatter does not change blank or already formatted lines", () => {
    const source = "Sub Main()\n    If ready Then\n        Print 1\n    End If\nEnd Sub\n";
    assert.deepEqual(formatFreeBasicIndentation(source), []);
    assert.deepEqual(formatFreeBasicIndentation(`${source}${" ".repeat(2_000_001)}`), []);
    assert.deepEqual(formatFreeBasicIndentation("\n".repeat(100_000)), []);
    const deepNesting = `${"If ready Then\n".repeat(129)}${"End If\n".repeat(129)}`;
    assert.deepEqual(formatFreeBasicIndentation(deepNesting), []);
});

test("document formatter maps indentation changes to VS Code edits", async () => {
    class Range {
        constructor(startLine, startCharacter, endLine, endCharacter) {
            this.start = { line: startLine, character: startCharacter };
            this.end = { line: endLine, character: endCharacter };
        }
    }
    const text = "Sub Main()\nPrint 1\nEnd Sub\n";
    const document = { getText: () => text };
    const provider = createDocumentFormattingProvider({
        workspace: { isTrusted: true },
        Range,
        TextEdit: { replace: (range, newText) => ({ range, newText }) }
    }, {
        getParsedDocument: () => require("../lib/freebasic-parser").parseFreeBasicText(text)
    });

    const edits = await provider.provideDocumentFormattingEdits(document, { tabSize: 2, insertSpaces: true });
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].range, new Range(1, 0, 1, 0));
    assert.equal(edits[0].newText, "  ");
});

test("selection formatter returns edits only for selected lines", async () => {
    class Range {
        constructor(startLine, startCharacter, endLine, endCharacter) {
            this.start = { line: startLine, character: startCharacter };
            this.end = { line: endLine, character: endCharacter };
        }
    }
    const text = "Sub Main()\nPrint 1\nIf ready Then\nPrint 2\nEnd If\nPrint 3\nEnd Sub\n";
    const document = { getText: () => text };
    const provider = createDocumentRangeFormattingProvider({
        workspace: { isTrusted: true },
        Range,
        TextEdit: { replace: (range, newText) => ({ range, newText }) }
    }, {
        getParsedDocument: () => require("../lib/freebasic-parser").parseFreeBasicText(text)
    });

    const edits = await provider.provideDocumentRangeFormattingEdits(
        document,
        new Range(2, 0, 5, 0),
        { tabSize: 2, insertSpaces: true }
    );
    assert.deepEqual(edits.map((edit) => [edit.range.start.line, edit.newText]), [
        [2, "  "], [3, "    "], [4, "  "]
    ]);
});

/* end of tests/formatter.test.js */
