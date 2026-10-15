/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/bracket-diagnostics.test.js

    Purpose:

        Verify editor feedback for unmatched FreeBASIC delimiters.

    Responsibilities:

        - cover matching, missing, and mismatched bracket pairs
        - ensure comments and strings do not produce false diagnostics
        - protect the language configuration's native pair support

    This file intentionally does NOT contain:

        - VS Code host integration tests
        - compiler syntax validation
        - grammar-generation tests
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { findBracketProblems } = require("../lib/bracket-diagnostics");

test("all three bracket kinds are accepted when properly nested", () => {
    assert.deepEqual(findBracketProblems("Call ({value[0]})"), []);
});

test("each unclosed opening bracket points to its source character", () => {
    const source = "Dim value = (1 + [2 + {3";
    const problems = findBracketProblems(source);

    assert.deepEqual(problems.map((problem) => [source.slice(problem.start, problem.end), problem.code]), [
        ["(", "unclosed-bracket"],
        ["[", "unclosed-bracket"],
        ["{", "unclosed-bracket"]
    ]);
    assert.deepEqual(problems.map((problem) => problem.message), [
        "Unclosed '('; expected ')'.",
        "Unclosed '['; expected ']'.",
        "Unclosed '{'; expected '}'."
    ]);
    assert.deepEqual(problems.map((problem) => [problem.expectedClosing, problem.fixOffset]), [
        [")", source.length],
        ["]", source.length],
        ["}", source.length]
    ]);
    assert.deepEqual(problems.map((problem) => problem.expectedClosings), ["}])", "}]", "}"]);
});

test("strings, apostrophe and REM comments, and nested block comments are ignored", () => {
    const source = [
        'Print "([{}] and doubled "" quotes"',
        "Print 1 ' ([{",
        "REM ([{",
        "/' outer ([{ /' nested )]} '/ still ([{ '/",
        "Call ({value[0]})"
    ].join("\r\n");

    assert.deepEqual(findBracketProblems(source), []);
});

test("brackets remain visible after OPTION NOKEYWORD REM", () => {
    const source = "Option NoKeyword REM\nREM = (1\n";
    const problem = findBracketProblems(source)[0];

    assert.equal(problem.code, "unclosed-bracket");
    assert.equal(source.slice(problem.start, problem.end), "(");
});

test("compiler-confirmed REM identifiers remain visible inside conditional OPTION blocks", () => {
    const source = "#if 1\nOption NoKeyword REM\n#endif\nREM = REM + (1\n";
    const optionLineStart = source.indexOf("Option NoKeyword REM");

    assert.deepEqual(findBracketProblems(source), [],
        "the source-only scanner must not infer the compiler's conditional option state");
    const problems = findBracketProblems(source, [], null, [optionLineStart]);
    assert.deepEqual(problems.map((problem) => [source.slice(problem.start, problem.end), problem.code]), [
        ["(", "unclosed-bracket"]
    ]);
});

test("compiler-confirmed conditional OPTION ESCAPE ranges mask escaped string literals", () => {
    const source = String.raw`#if 1
Option Escape
#endif
Print "inside \" ([)]"
Print (1)`;
    const statementStart = source.indexOf("Print");
    const statementEnd = source.indexOf("\n", statementStart);
    const escapedStringRange = [{ start: statementStart, end: statementEnd }];

    assert.ok(findBracketProblems(source).some((problem) => problem.code === "unexpected-closing-bracket"),
        "without compiler option context, the source-only scan cannot know that the quote is escaped");
    assert.deepEqual(findBracketProblems(source, [], null, null, escapedStringRange), [],
        "the compiler-confirmed escape mode must keep bracket characters inside the literal masked");
});

test("mismatched nesting identifies the opener and any later stray closer", () => {
    const source = "([)]";
    const problems = findBracketProblems(source);

    assert.deepEqual(problems.map((problem) => [
        source.slice(problem.start, problem.end),
        problem.code
    ]), [
        ["[", "unclosed-bracket"],
        ["]", "unexpected-closing-bracket"]
    ]);
    assert.deepEqual(problems[0] && [problems[0].expectedClosing, problems[0].fixOffset], ["]", source.indexOf(")")]);
    assert.equal(problems[0].expectedClosings, "]");
});

test("a single open bracket identifies one safe replacement for a wrong closer", () => {
    const source = "Print (1]";
    const unexpected = findBracketProblems(source).find((problem) => problem.code === "unexpected-closing-bracket");

    assert.ok(unexpected);
    assert.equal(source.slice(unexpected.start, unexpected.end), "]");
    assert.equal(unexpected.replacementClosing, ")");

    const nested = findBracketProblems("Print ([1}").find((problem) => problem.code === "unexpected-closing-bracket");
    assert.ok(nested);
    assert.equal(nested.replacementClosing, undefined,
        "a replacement must be withheld when it would choose among nested openers");

    const closedLater = findBracketProblems("Print (1] + 2)")
        .find((problem) => problem.code === "unexpected-closing-bracket");
    assert.ok(closedLater);
    assert.equal(closedLater.replacementClosing, undefined,
        "a closer that already has a later match must not be replaced");

    const repeated = findBracketProblems("Print (1] + 2}")
        .filter((problem) => problem.code === "unexpected-closing-bracket");
    assert.equal(repeated.length, 2);
    assert.ok(repeated.every((problem) => problem.replacementClosing === undefined),
        "two stray closers must not both claim the one open bracket");
});

test("mismatched nested closers retain the complete bounded closing sequence", () => {
    const source = "([{value)";
    const problems = findBracketProblems(source);
    const unclosed = problems.filter((problem) => problem.code === "unclosed-bracket");

    assert.deepEqual(unclosed.map((problem) => problem.expectedClosings), ["}]", "}"]);
    assert.ok(unclosed.every((problem) => problem.fixOffset === source.indexOf(")")));
});

test("quick-fix closing sequences are bounded for deeply nested input", () => {
    const source = "(".repeat(34);
    const problems = findBracketProblems(source);

    assert.equal(problems[0].expectedClosings, "", "outer fixes are withheld when their insertion would exceed the text bound");
    assert.equal(problems.at(-1).expectedClosings, ")");
});

test("compiler-confirmed inactive ranges do not affect active bracket matching", () => {
    const source = "#if 0\nPrint (\n#else\nPrint (1\n#endif\n";
    const inactiveStart = source.indexOf("Print (");
    const inactiveEnd = source.indexOf("\n", inactiveStart) + 1;
    const activeStart = source.lastIndexOf("Print (") + "Print ".length;

    const problems = findBracketProblems(source, [{ start: inactiveStart, end: inactiveEnd }]);

    assert.deepEqual(problems.map((problem) => [problem.start, problem.code]), [[activeStart, "unclosed-bracket"]]);
});

test("deep mismatched input does not rescan the opening stack for each closer", () => {
    const source = "(".repeat(3000) + "]".repeat(3000);
    const problems = findBracketProblems(source);

    assert.equal(problems.length, 6000);
    assert.equal(source.slice(problems[0].start, problems[0].end), "(");
    assert.equal(problems[0].code, "unclosed-bracket");
    assert.equal(source.slice(problems.at(-1).start, problems.at(-1).end), "]");
    assert.equal(problems.at(-1).code, "unexpected-closing-bracket");
});

test("diagnostic offsets use VS Code-compatible UTF-16 positions", () => {
    const source = 'Print "😀" + (';
    const problem = findBracketProblems(source)[0];

    assert.equal(source.slice(problem.start, problem.end), "(");
    assert.equal(problem.start, source.indexOf("("));
});

test("language configuration enables native matching for each bracket kind", () => {
    const configuration = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "language-configuration.json"), "utf8"));

    for (const pair of [["(", ")"], ["[", "]"], ["{", "}"]]) {
        assert.ok(configuration.brackets.some(([opening, closing]) => opening === pair[0] && closing === pair[1]));
        assert.ok(configuration.autoClosingPairs.some(({ open, close }) => open === pair[0] && close === pair[1]));
    }
});

/* end of tests/bracket-diagnostics.test.js */
