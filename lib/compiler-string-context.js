/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-string-context.js

    Purpose:

        Combine the source scanner with compiler-confirmed string escape mode
        at a cursor position.

    Responsibilities:

        - request native cursor facts only for ambiguous escaped quotes
        - keep cursor offsets aligned with compiler snapshots without BOMs
        - discard stale requests and follow one cached model replacement
        - leave ordinary source-only context checks synchronous and cheap

    This file intentionally does NOT contain:

        - string or comment parsing
        - compiler process management
        - editor provider behavior
*/

const { getCodeContextDetails } = require("./freebasic-parser");
const { compilerEditorModel } = require("./editor-model");

async function compilerAwareCodeContext(workspaceIndex, document, offset, linePrefix, token = null) {
    const version = document.version;
    const unknown = { context: "unknown", defaultEscapedStringRanges: [] };
    if (token?.isCancellationRequested) return unknown;
    const text = document.getText();
    const scanned = getCodeContextDetails(text, offset);
    const sourceContext = scanned.context;
    if (!scanned.ambiguousDefaultEscapes) {
        return { context: sourceContext, defaultEscapedStringRanges: [] };
    }

    const analysis = workspaceIndex.compilerAnalysis;
    let model = analysis?.getModel?.(document.uri);
    if (!model && typeof analysis?.getModelForEditor !== "function") {
        return { context: sourceContext, defaultEscapedStringRanges: [] };
    }
    if (!model || model.semanticBindingsAvailable === false) {
        /* Lightweight expression snapshots omit accepted option contexts.
           Acquire them on demand or join the normal binding upgrade only
           for this ambiguous spelling, without requiring prior editor work. */
        model = await compilerEditorModel(workspaceIndex, document, token, false, true);
        if (!model || token?.isCancellationRequested || document.version !== version) return unknown;
    }
    const offsetAdjustment = text.startsWith("\uFEFF") ? 1 : 0;
    const compilerOffset = offset - offsetAdjustment;
    for (let attempt = 0; attempt < 2; attempt++) {
        const generation = analysis.generation;
        let result = null, failed = false;
        try {
            result = model.remote
                ? await model.query("compilerCodeContext", document.uri,
                    { offset: compilerOffset, offsetAdjustment }, token)
                : model.compilerCodeContext?.(document.uri, compilerOffset, offsetAdjustment) || null;
        } catch {
            failed = true;
        }
        if (token?.isCancellationRequested || document.version !== version) return unknown;
        const current = analysis.getModel(document.uri);
        if (current !== model || generation !== analysis.generation) {
            /* Upgrading bindings may release the queried snapshot. Use one
               cached successor; an unavailable context is not proof of code. */
            if (!current) return unknown;
            model = current;
            continue;
        }
        if (failed || !result || !["code", "string", "comment"].includes(result.context)) return unknown;
        return { ...result, defaultEscapedStringRanges: [] };
    }
    return unknown;
}

module.exports = { compilerAwareCodeContext };

/* end of lib/compiler-string-context.js */
