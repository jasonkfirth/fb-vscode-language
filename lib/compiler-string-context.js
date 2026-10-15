/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-string-context.js

    Purpose:

        Combine the source scanner with compiler-confirmed string escape mode
        at a cursor position.

    Responsibilities:

        - request an exact escape range only for ambiguous escaped quotes
        - keep cursor offsets aligned with compiler snapshots without BOMs
        - leave ordinary source-only context checks synchronous and cheap

    This file intentionally does NOT contain:

        - string or comment parsing
        - compiler process management
        - editor provider behavior
*/

const { getCodeContext } = require("./freebasic-parser");

async function compilerAwareCodeContext(workspaceIndex, document, offset, linePrefix, token = null) {
    const text = document.getText();
    const sourceContext = getCodeContext(text, offset);
    if (sourceContext !== "code" || !String(linePrefix || "").includes(String.raw`\"`)) {
        return { context: sourceContext, defaultEscapedStringRanges: [] };
    }

    const model = workspaceIndex.compilerAnalysis?.getModel?.(document.uri);
    if (!model || token?.isCancellationRequested) {
        return { context: sourceContext, defaultEscapedStringRanges: [] };
    }
    const offsetAdjustment = text.startsWith("\uFEFF") ? 1 : 0;
    const compilerOffset = offset - offsetAdjustment;
    let range = null;
    try {
        range = model.remote
            ? await model.query("compilerDefaultEscapedStringRangeAt", document.uri, { offset: compilerOffset }, token)
            : model.compilerDefaultEscapedStringRangeAt?.(document.uri, compilerOffset) || null;
    } catch {
        return { context: sourceContext, defaultEscapedStringRanges: [] };
    }
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 0 || range.end <= range.start || compilerOffset < range.start || compilerOffset >= range.end) {
        return { context: sourceContext, defaultEscapedStringRanges: [] };
    }
    const defaultEscapedStringRanges = offsetAdjustment
        ? [{ start: range.start + offsetAdjustment, end: range.end + offsetAdjustment }]
        : [range];
    return {
        context: getCodeContext(text, offset, defaultEscapedStringRanges),
        defaultEscapedStringRanges
    };
}

module.exports = { compilerAwareCodeContext };

/* end of lib/compiler-string-context.js */
