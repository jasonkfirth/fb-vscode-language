/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/textmate.test.js

    Purpose:

        Exercise syntax coloring through VS Code's actual TextMate and
        Oniguruma engines.

    Responsibilities:

        - verify comments and strings do not leak into subsequent code
        - verify numeric and directive scopes in representative source
        - validate all compiled grammar expressions

    This file intentionally does NOT contain:

        - a substitute regular expression engine
        - grammar generation
        - VS Code host startup
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Registry, parseRawGrammar } = require("vscode-textmate");
const { loadWASM, OnigScanner, OnigString } = require("vscode-oniguruma");

const grammarPath = path.join(__dirname, "../syntaxes/freebasic.tmLanguage.json");
const onigLib = loadWASM(fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"))).then(() => ({
    createOnigScanner: (sources) => new OnigScanner(sources),
    createOnigString: (text) => new OnigString(text)
}));
const registry = new Registry({ onigLib, loadGrammar: async () => parseRawGrammar(fs.readFileSync(grammarPath, "utf8"), grammarPath) });

async function scopesFor(lines) {
    const grammar = await registry.loadGrammar("source.freebasic");
    const results = [];
    let state;
    for (const line of lines) {
        const result = grammar.tokenizeLine(line, state);
        state = result.ruleStack;
        results.push(result.tokens);
    }
    return (line, column) => results[line].find((token) => token.startIndex <= column && token.endIndex > column)?.scopes || [];
}

test("actual TextMate tokenization keeps strings and nested comments bounded", async () => {
    const scopes = await scopesFor([
        'If Inkey$ <> "" Then Print "ready"',
        '/\' outer /\' nested \'/ still a comment',
        '\'/ Dim value As Long',
        'Print !"a\\\"b", value',
        'Print value'
    ]);
    assert.ok(scopes(0, 28).some((scope) => scope.startsWith("string")));
    assert.ok(scopes(1, 28).some((scope) => scope.startsWith("comment")));
    assert.ok(scopes(2, 4).includes("storage.modifier.freebasic"));
    assert.equal(scopes(3, 17).some((scope) => scope.startsWith("string")), false);
    assert.equal(scopes(4, 6).some((scope) => /^(?:string|comment)/.test(scope)), false);
});

test("actual TextMate tokenization recognizes current numbers and directives", async () => {
    const scopes = await scopesFor(['#ifdef __FB_GFXLIB3__', 'Dim n As ULongInt = &hFFFFFFFFFFFFFFFFull', 'Print .5, 1d-3', '#endif', 'Print MidiPlaying()']);
    assert.ok(scopes(0, 2).some((scope) => /preprocessor/.test(scope)));
    assert.ok(scopes(1, 23).some((scope) => scope.startsWith("constant.numeric")));
    assert.ok(scopes(2, 7).some((scope) => scope.startsWith("constant.numeric")));
    assert.ok(scopes(2, 11).some((scope) => scope.startsWith("constant.numeric")));
    assert.ok(scopes(4, 8).includes("support.function.freebasic"));
});

test("actual TextMate tokenization recognizes opt-in serialization names", async () => {
    const scopes = await scopesFor([
        "Print Serialize(1)",
        "Print Deserialize(payload, destination)",
        "Print __FB_SERIALIZE(1)",
        "Print __FB_DESERIALIZE(payload, destination)"
    ]);
    for (let line = 0; line < 4; line++) {
        assert.ok(scopes(line, 6).includes("support.function.freebasic"),
            "both public macros and compiler intrinsic spellings should be colored as callable names");
    }
});

/* end of tests/textmate.test.js */
