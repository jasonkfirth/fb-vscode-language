/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-member-completion.test.js
    Purpose: Verify source-member projection from compiler-selected type identities.
    Responsibilities: cover conditional declarations, batching, and stale results.
    Does not contain: compiler execution, native schema decoding, or editor profiles.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCompletionProvider } = require("../lib/editor-features");
const { FreeBasicSemanticModel } = require("../lib/semantic-model");
const { parseFreeBasicText } = require("../lib/freebasic-parser");

function fixture(fieldCount = 1) {
    const fields = Array.from({ length: fieldCount }, (_value, index) => `    active${index} As Long`);
    const text = ["Type ParentValue", "    inherited As Long", "End Type", "#ifdef FIRST_BUILD", "Type SelectedValue Extends ParentValue",
        ...fields, "#ifdef UNUSED", "    inactive As Long", "#endif", "Private:", "    hidden As Long", "End Type", "#else",
        "Type SelectedValue Extends ParentValue", "    wrongBranch As Long", "End Type", "#endif",
        "Declare Function MakeValue() As SelectedValue", "Var factory = MakeValue()", "Print factory.active0"].join("\n");
    const lines = text.split("\n");
    const uri = { scheme: "file", fsPath: "/project/main.bas", toString: () => "file:///project/main.bas" };
    const document = { uri, languageId: "freebasic", version: 1, isDirty: false, getText: () => text,
        lineAt: (line) => ({ text: lines[line] }),
        offsetAt: (position) => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character,
        positionAt: (offset) => { const prefix = text.slice(0, offset).split("\n"); return { line: prefix.length - 1, character: prefix.at(-1).length }; } };
    const source = new FreeBasicSemanticModel([{ uri, parsed: parseFreeBasicText(text) }]);
    const types = [source.entries.find((entry) => entry.name === "SelectedValue" && entry.declaration.line === 4),
        source.entries.find((entry) => entry.name === "ParentValue")];
    const typeRecords = types.map((entry) => ({ uri, declaration: entry.declaration }));
    const siteKey = (site) => `${site.line}:${site.startColumn}:${site.endColumn}`;
    const active = new Map(source.entries.filter((entry) => entry.declaration.type === "field" &&
        /^(?:active\d+|inherited|hidden)$/.test(entry.name)).map((entry) => [siteKey(entry.declaration), entry]));
    const state = { snapshotText: text, limit: 2000, partial: false, onFacts: null, modelChanged: false, context: "first-build" };
    const requests = [], batches = [];
    const query = async (operation, _uri, input) => {
        if (operation === "compilerSidecarReceiverTypeHierarchy") return typeRecords;
        assert.equal(operation, "compilerSidecarOutlineFactsAtSites");
        batches.push(input.sites.length);
        state.onFacts?.();
        return input.sites.flatMap((site) => {
            const entry = active.get(siteKey(site));
            return entry ? [{ index: site.index, compilerFacts: { compilerVisibility: entry.name === "hidden" ? "private" : "public" } }] : [];
        });
    };
    const unbound = { remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: false, partial: false,
        query, expressionAt: async () => ({ typeName: "SelectedValue", provisional: false }) };
    const bound = { ...unbound, semanticBindingsAvailable: true };
    let current = unbound;
    const completionModel = { remote: true, query: async () => ({ member: true, entries: [], hasDirectivePrefix: false }) };
    const index = {
        compilerAnalysis: {
            generation: 1,
            contextFor: () => ({ signature: state.context }),
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async (_document, _token, needTypes, needBindings) => {
                requests.push([needTypes, needBindings]);
                if (!needTypes) {
                    current = completionModel;
                    return current;
                }
                if (current === completionModel) current = unbound;
                if (needBindings) current = bound;
                current.partial = state.partial;
                return current;
            },
            getModel: () => state.modelChanged ? unbound : current,
            snapshotFor: () => ({ model: current, sources: [{ uri, text: state.snapshotText }] })
        },
        getSemanticModel: () => source
    };
    class CompletionItem { constructor(label, kind) { Object.assign(this, { label, kind }); } }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; return this; }
        appendCodeblock(value) { this.value += value; return this; }
    }
    const vscode = { CompletionItem, MarkdownString, CompletionItemKind: { Field: 1, Variable: 2 },
        workspace: { getConfiguration: () => ({ get: (name, fallback) => name === "index.maxCompletionResults" ? state.limit : fallback }) } };
    const grammar = Object.fromEntries(["preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants", "compilerDefines", "symbolicConstants"]
        .map((key) => [key, []]));
    const provider = createCompletionProvider(vscode, index, grammar);
    return { state, document, requests, batches, index, vscode,
        complete: () => provider.provideCompletionItems(document, { line: lines.length - 1, character: "Print factory.".length }) };
}

test("compiler-bound completion selects conditional types and physical member sites", async () => {
    const { complete, requests } = fixture();
    assert.deepEqual((await complete()).map((item) => item.label).sort(), ["active0", "inherited"]);
    assert.deepEqual(requests, [[false, false], [true, false], [true, true]],
        "physical bindings should be requested only after source type resolution fails");
});

test("compiler-bound completion batches member facts and respects the editor result limit", async () => {
    const { complete, batches, state } = fixture(70);
    assert.equal((await complete()).length, 71);
    assert.ok(batches.includes(64));
    assert.ok(batches.every((count) => count <= 64));
    state.limit = 2;
    assert.equal((await complete()).length, 2);
});

for (const reason of ["stale source", "edited document", "replaced model", "partial model", "closed document",
    "compiler invalidation", "changed context", "changed trust"]) {
    test(`compiler-bound completion rejects ${reason}`, async () => {
        const { complete, state, document, index, vscode } = fixture();
        if (reason === "stale source") state.snapshotText = state.snapshotText.replace("active0", "active9");
        if (reason === "edited document") state.onFacts = () => document.version++;
        if (reason === "replaced model") state.onFacts = () => { state.modelChanged = true; };
        if (reason === "partial model") state.partial = true;
        if (reason === "closed document") state.onFacts = () => { document.isClosed = true; };
        if (reason === "compiler invalidation") state.onFacts = () => { index.compilerAnalysis.generation++; };
        if (reason === "changed context") state.onFacts = () => { state.context = "second-build"; };
        if (reason === "changed trust") state.onFacts = () => { vscode.workspace.isTrusted = false; };
        assert.deepEqual(await complete(), []);
    });
}

/* end of compiler-member-completion.test.js */
