/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/freebasic-formatter.js

    Purpose:

        Provide safe, indentation-only formatting for FreeBASIC documents.

    Responsibilities:

        - derive block indentation from parser-recognized statements
        - preserve all source text except leading whitespace on supported lines
        - leave ambiguous, continued, and oversized input unchanged
        - ignore compiler-confirmed inactive regions without editing their text

    This file intentionally does NOT contain:

        - token spacing or stylistic rewrites
        - compiler execution or semantic edits
        - VS Code API objects
*/

const {
    findStandaloneLineCommentLines,
    getFoldingCloseKind,
    getFoldingOpenKind,
    parseFreeBasicText
} = require("./freebasic-parser");

const MAX_FORMAT_TEXT_LENGTH = 2_000_000;
const MAX_FORMAT_LINES = 100_000;
const MAX_INDENT_DEPTH = 128;
/* Match the compiler's bounded inactive-region query. */
const MAX_INACTIVE_RANGES = 5000;

function formatFreeBasicIndentation(text, parsed = null, options = {}, ignoredRanges = [], lexicalOverrides = null) {
    if (typeof text !== "string" || text.length > MAX_FORMAT_TEXT_LENGTH) return [];
    options = options && typeof options === "object" ? options : {};

    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length > MAX_FORMAT_LINES) return [];
    const formattingText = maskInactiveSource(text, ignoredRanges);
    if (formattingText === null) return [];
    const currentParsed = parsed?.text === text ? parsed : null;
    const lexical = lexicalOverrides || currentParsed || {};
    const source = formattingText === text && !lexicalOverrides ? currentParsed || parseFreeBasicText(text)
        : parseFreeBasicText(formattingText, lexical.remIdentifierOffsets, lexical.defaultEscapedStringRanges, lexical.remKeywordDisabledLineOffsets);
    const statements = source.statements || [];
    const commentLines = findStandaloneLineCommentLines(formattingText, lexical.remIdentifierOffsets,
        lexical.defaultEscapedStringRanges, lexical.remKeywordDisabledLineOffsets);
    const statementsByLine = new Map();
    const touchedCounts = new Uint16Array(lines.length);

    for (const statement of statements) {
        const startLine = statement.startLine;
        const endLine = statement.endLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            startLine < 0 || endLine < startLine || endLine >= lines.length) continue;

        const list = statementsByLine.get(startLine) || [];
        list.push(statement);
        statementsByLine.set(startLine, list);
        for (let line = startLine; line <= endLine; line++) {
            if (touchedCounts[line] < 2) touchedCounts[line]++;
        }
    }

    const indentUnit = options.insertSpaces === false
        ? "\t"
        : " ".repeat(Number.isSafeInteger(options.tabSize) && options.tabSize > 0 ? Math.min(options.tabSize, 16) : 4);
    const blocks = [];
    const edits = [];

    for (let line = 0; line < lines.length; line++) {
        const lineStatements = statementsByLine.get(line) || [];
        if (lineStatements.length > 1 && lineStatements.every((statement) => statement.startLine === line && statement.endLine === line)) {
            if (!applySameLineBlockClosures(lineStatements, blocks)) return [];
            continue;
        }
        const structuralStatement = lineStatements.length === 1 ? lineStatements[0] : null;
        let canTrackStructure = Boolean(structuralStatement);
        if (canTrackStructure) {
            for (let statementLine = structuralStatement.startLine; statementLine <= structuralStatement.endLine; statementLine++) {
                if (touchedCounts[statementLine] > 1) {
                    canTrackStructure = false;
                    break;
                }
            }
        }
        const code = canTrackStructure ? String(structuralStatement.maskedText || "").trim() : "";
        let desiredDepth = blocks.length;
        let closeKind = null;
        let branchKind = null;

        if (code) {
            closeKind = getFoldingCloseKind(code);
            if (/^#else(?:if|ifdef|ifndef)?\b/i.test(code)) branchKind = "preprocessorIf";
            else if (/^else(?:if)?\b/i.test(code)) branchKind = "if";
            else if (/^case\b/i.test(code)) branchKind = "select";

            if (hasAmbiguousBlockBoundary(blocks, branchKind || closeKind)) return [];

            if (branchKind) {
                const index = lastBlockIndex(blocks, branchKind);
                if (index >= 0) desiredDepth = index;
            } else if (closeKind) {
                const index = lastBlockIndex(blocks, closeKind);
                if (index >= 0) desiredDepth = index;
            }
        }

        const lineText = lines[line];
        const indentation = lineText.match(/^[\t ]*/)[0];
        const hasCode = lineText.slice(indentation.length).length > 0;
        const isStandaloneComment = commentLines.has(line) && lineStatements.length <= 1 && touchedCounts[line] <= 1 &&
            (!structuralStatement || !String(structuralStatement.maskedText || "").trim());
        const supportedLine = isStandaloneComment || code && structuralStatement &&
            structuralStatement.startLine === structuralStatement.endLine && lineStatements.length === 1 &&
            touchedCounts[line] === 1;
        if (hasCode && supportedLine) {
            const replacement = indentUnit.repeat(Math.min(MAX_INDENT_DEPTH, desiredDepth));
            if (replacement !== indentation) {
                edits.push({ line, start: 0, end: indentation.length, newText: replacement });
            }
        }

        if (!code || !canTrackStructure) continue;
        if (branchKind) continue;
        if (closeKind) {
            const index = lastBlockIndex(blocks, closeKind);
            if (index >= 0) blocks.splice(index);
            continue;
        }

        const openKind = getFoldingOpenKind(code);
        if (openKind) {
            if (blocks.length >= MAX_INDENT_DEPTH) return [];
            blocks.push(openKind);
        }
    }

    return edits;
}

function maskInactiveSource(text, ignoredRanges) {
    if (!Array.isArray(ignoredRanges) || ignoredRanges.length > MAX_INACTIVE_RANGES) return null;
    // Only whole source lines can be excluded from indentation structure.
    // Preserve every UTF-16 unit and newline so parser/editor coordinates agree.
    const boundary = (offset) => offset === 0 || offset === text.length || /[\r\n]/.test(text[offset - 1]);
    const ranges = ignoredRanges.filter((range) => Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end) &&
        range.start >= 0 && range.end > range.start && range.end <= text.length && boundary(range.start) && boundary(range.end))
        .sort((left, right) => left.start - right.start || left.end - right.end);
    if (!ranges.length) return text;
    const parts = [];
    let cursor = 0;
    for (const range of ranges) {
        if (range.end <= cursor) continue;
        const start = Math.max(cursor, range.start);
        parts.push(text.slice(cursor, start), text.slice(start, range.end).replace(/[^\r\n]/g, " "));
        cursor = range.end;
    }
    parts.push(text.slice(cursor));
    return parts.join("");
}

function lastBlockIndex(blocks, kind) {
    for (let index = blocks.length - 1; index >= 0; index--) {
        if (blocks[index] === kind) return index;
    }
    return -1;
}

function hasAmbiguousBlockBoundary(blocks, kind) {
    if (!kind) return false;
    const index = lastBlockIndex(blocks, kind);
    // A missed lexical option can hide a terminator and leave a language block
    // open. Do not reindent against that broken stack. Macro replacement text
    // is allowed to contain partial language constructs.
    if (kind !== "macro" && index >= 0 && index !== blocks.length - 1) return true;
    const conditional = lastBlockIndex(blocks, "preprocessorIf");
    if (conditional < 0) return false;
    // Conditional arms can open or close language scopes that continue outside
    // the directive. A lexical stack cannot prove those layouts; leave the
    // document unchanged instead of consuming the enclosing conditional frame.
    return kind === "preprocessorIf" ? index !== blocks.length - 1 : index < conditional;
}

function applySameLineBlockClosures(statements, blocks) {
    const sameLineOpeners = [];
    for (const statement of statements) {
        const code = String(statement.maskedText || "").trim();
        if (!code) continue;

        const closeKind = getFoldingCloseKind(code);
        if (closeKind) {
            const localIndex = lastBlockIndex(sameLineOpeners, closeKind);
            if (localIndex >= 0) {
                sameLineOpeners.splice(localIndex);
                continue;
            }
            if (hasAmbiguousBlockBoundary(blocks, closeKind)) return false;
            const openIndex = lastBlockIndex(blocks, closeKind);
            if (openIndex >= 0) blocks.splice(openIndex);
            continue;
        }

        const openKind = getFoldingOpenKind(code);
        if (openKind) sameLineOpeners.push(openKind);
    }
    return true;
}

module.exports = { formatFreeBasicIndentation };

/* end of lib/freebasic-formatter.js */
