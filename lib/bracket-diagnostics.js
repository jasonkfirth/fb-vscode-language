/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/bracket-diagnostics.js

    Purpose:

        Find unmatched source delimiters for immediate editor feedback.

    Responsibilities:

        - ignore delimiters inside FreeBASIC strings and comments
        - identify unclosed opening and unmatched closing delimiters
        - preserve offsets for VS Code diagnostic ranges

    This file intentionally does NOT contain:

        - full FreeBASIC syntax validation
        - compiler or workspace access
        - VS Code API objects
*/

const { maskFreeBasicText } = require("./freebasic-parser");

const CLOSING_FOR_OPENING = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"]
]);
const OPENING_FOR_CLOSING = new Map([...CLOSING_FOR_OPENING].map(([opening, closing]) => [closing, opening]));
/* Avoid unbounded Quick Fix text for pathological nesting. */
const MAX_BRACKET_FIX_CLOSERS = 32;

function expectedClosingSequence(stack, openingIndex) {
    if (stack.length - openingIndex > MAX_BRACKET_FIX_CLOSERS) return "";
    let result = "";
    for (let index = stack.length - 1; index >= openingIndex; index--) {
        result += CLOSING_FOR_OPENING.get(stack[index].character);
    }
    return result;
}

function findBracketProblems(text, ignoredRanges = [], remIdentifierOffsets = null,
    compilerRemKeywordDisabledLineOffsets = null, defaultEscapedStringRanges = null) {
    const source = String(text ?? "");
    const masked = maskFreeBasicText(source, remIdentifierOffsets,
        compilerRemKeywordDisabledLineOffsets, defaultEscapedStringRanges);
    const stack = [];
    /* Per-kind indexes keep malformed nesting from triggering repeated scans. */
    const openersByCharacter = new Map([...CLOSING_FOR_OPENING.keys()].map((character) => [character, []]));
    const problems = [];
    const replacementCandidates = new Map();
    const ranges = (Array.isArray(ignoredRanges) ? ignoredRanges : [])
        .filter((range) => Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end) &&
            range.start >= 0 && range.start < range.end && range.end <= masked.length)
        .sort((first, second) => first.start - second.start || first.end - second.end);
    let ignoredRangeIndex = 0;

    for (let offset = 0; offset < masked.length; offset++) {
        while (ignoredRangeIndex < ranges.length && ranges[ignoredRangeIndex].end <= offset) ignoredRangeIndex++;
        const ignored = ranges[ignoredRangeIndex];
        if (ignored && ignored.start <= offset && offset < ignored.end) continue;

        const character = masked[offset];

        if (CLOSING_FOR_OPENING.has(character)) {
            const opening = { character, offset, stackIndex: stack.length };
            stack.push(opening);
            openersByCharacter.get(character).push(opening);
            continue;
        }

        const expectedOpening = OPENING_FOR_CLOSING.get(character);
        if (!expectedOpening) continue;

        const top = stack.at(-1);
        if (top?.character === expectedOpening) {
            stack.pop();
            openersByCharacter.get(top.character).pop();
            continue;
        }

        const matching = openersByCharacter.get(expectedOpening).at(-1);
        if (!matching) {
            const problem = {
                start: offset,
                end: offset + 1,
                code: "unexpected-closing-bracket",
                message: `Unexpected '${character}'; no matching '${expectedOpening}' is open.`
            };
            if (stack.length === 1) {
                replacementCandidates.set(offset, {
                    openingOffset: stack[0].offset,
                    closing: CLOSING_FOR_OPENING.get(stack[0].character)
                });
            }
            problems.push(problem);
            continue;
        }

        for (let index = stack.length - 1; index > matching.stackIndex; index--) {
            const unmatched = stack[index];
            const expectedClosing = CLOSING_FOR_OPENING.get(unmatched.character);
            openersByCharacter.get(unmatched.character).pop();
            problems.push({
                start: unmatched.offset,
                end: unmatched.offset + 1,
                code: "unclosed-bracket",
                message: `'${unmatched.character}' is not closed before '${character}'; expected '${expectedClosing}'.`,
                expectedClosing,
                expectedClosings: expectedClosingSequence(stack, index),
                fixOffset: offset
            });
        }

        openersByCharacter.get(matching.character).pop();
        stack.length = matching.stackIndex;
    }

    for (let index = 0; index < stack.length; index++) {
        const opening = stack[index];
        const expectedClosing = CLOSING_FOR_OPENING.get(opening.character);
        problems.push({
            start: opening.offset,
            end: opening.offset + 1,
            code: "unclosed-bracket",
            message: `Unclosed '${opening.character}'; expected '${expectedClosing}'.`,
            expectedClosing,
            expectedClosings: expectedClosingSequence(stack, index),
            fixOffset: source.length
        });
    }

    if (stack.length === 1) {
        const remainingOpening = stack[0];
        const candidates = problems.filter((problem) => {
            const candidate = replacementCandidates.get(problem.start);
            return candidate?.openingOffset === remainingOpening.offset;
        });
        if (candidates.length === 1) {
            candidates[0].replacementClosing = replacementCandidates.get(candidates[0].start).closing;
        }
    }

    return problems.sort((left, right) => left.start - right.start);
}

module.exports = { findBracketProblems };

/* end of lib/bracket-diagnostics.js */
