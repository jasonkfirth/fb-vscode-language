/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/editor-features.test.js

    Purpose:

        Verify parser-to-editor mappings without a VS Code extension host.

    Responsibilities:

        - preserve hierarchical document symbols and parameter locations
        - verify current built-in hover classification
        - verify compiler and bracket diagnostic Quick Fix edits
        - verify local include-path resolution
        - keep include completion edits inside literal-safe operand boundaries

    This file intentionally does NOT contain:

        - provider registration
        - compiler execution
        - workspace indexing
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    createCompletionProvider,
    createDocumentSymbolProvider,
    createDocumentSymbolRegistration,
    createDocumentLinkRegistration,
    createDocumentLinkProvider,
    createInlayHintsProvider,
    createMissingHeaderCodeActionProvider,
    createHoverProvider,
    createSignatureHelpProvider,
    createWorkspaceSymbolProvider,
    createDocumentSymbolTree,
    findScopedDocumentDeclarations,
    getBuiltInHover,
    resolveIncludePath
} = require("../lib/editor-features");
const {
    createSemanticFeatures, hasCompilerOperatorReceiptAt, hasPotentialOperatorReceiptSyntaxAt,
    hasPotentialIteratorOperatorAt, isOperatorTokenAt
} = require("../lib/semantic-features");
const { FreeBasicSemanticModel } = require("../lib/semantic-model");
const { parseFreeBasicText } = require("../lib/freebasic-parser");
const { COMPILER_MESSAGE_CODE } = require("../lib/compiler-diagnostics");
const { compilerAwareCodeContext } = require("../lib/compiler-string-context");
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
        SymbolTag: { Deprecated: 1 },
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
            getConfiguration(_section, resource) {
                return {
                    get(name, defaultValue) {
                        if (name === "index.maxCompletionResults") {
                            assert.equal(resource, null, "window-scoped completion limits must not use a document resource");
                        }
                        if (name === "compiler.path") return "fb-vscode-unavailable-test-compiler";
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
    const lineOffsets = [0];
    for (const match of text.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
    return {
        lineCount: lines.length,
        getText() { return text; },
        lineAt(line) {
            return { text: lines[line] };
        },
        offsetAt(position) {
            return (lineOffsets[position.line] ?? text.length) + position.character;
        }
    };
}

function snapshotProviderRegistrationFixture(kind, provider) {
    const listeners = Object.fromEntries(["config", "snapshot", "active"].map((name) => [name, new Set()]));
    const event = (name) => (listener) => { listeners[name].add(listener); return { dispose: () => listeners[name].delete(listener) }; };
    const document = { languageId: "freebasic", uri: { toString: () => "file:///workspace/main.bas" } };
    const registrations = [], state = { configured: true, model: null };
    const selector = { language: "freebasic" };
    const method = kind === "symbols" ? "provideDocumentSymbols" : "provideDocumentLinks";
    const register = (actualSelector, actualProvider) => {
        assert.equal(actualSelector, selector);
        assert.equal(typeof actualProvider[method], "function");
        const registration = { provider: actualProvider, disposals: 0, dispose() { this.disposals++; } };
        registrations.push(registration);
        return registration;
    };
    const vscode = { languages: { registerDocumentSymbolProvider: register, registerDocumentLinkProvider: register },
    workspace: { onDidChangeConfiguration: event("config") },
    window: { activeTextEditor: { document }, onDidChangeActiveTextEditor: event("active") } };
    const analysis = { onDidChangeSnapshot: event("snapshot"), isConfigured: () => state.configured,
        getModel: () => state.model, check() { assert.fail("registration refresh must not start compiler work"); } };
    const createRegistration = kind === "symbols" ? createDocumentSymbolRegistration : createDocumentLinkRegistration;
    const registration = createRegistration(vscode, selector, provider, analysis);
    return { document, registrations, registration, state, listeners, window: vscode.window,
        fire: (name, value) => { for (const listener of [...listeners[name]]) listener(value); },
        flush: () => new Promise((resolve) => setTimeout(resolve, 40)) };
}

function documentSymbolRegistrationFixture(provider = { provideDocumentSymbols: () => [] }) {
    return snapshotProviderRegistrationFixture("symbols", provider);
}

function documentLinkRegistrationFixture(provider = { provideDocumentLinks: () => [] }) {
    return snapshotProviderRegistrationFixture("links", provider);
}

test("include-link registration refreshes selected snapshots and include settings", async (t) => {
    const fixture = documentLinkRegistrationFixture();
    t.after(() => fixture.registration.dispose());
    fixture.fire("snapshot", ["file:///workspace/unrelated.bas"]);
    fixture.fire("config", { affectsConfiguration: () => false });
    await fixture.flush();
    assert.equal(fixture.registrations.length, 1);
    fixture.fire("snapshot", [fixture.document.uri.toString()]);
    fixture.fire("config", { affectsConfiguration: (name) => name === "freebasic.includePaths" });
    await fixture.flush();
    assert.equal(fixture.registrations.length, 2);
    assert.equal(fixture.registrations[0].disposals, 1);
});

test("include-link snapshots refresh visible split editors without activating them", async (t) => {
    const fixture = documentLinkRegistrationFixture();
    t.after(() => fixture.registration.dispose());
    const other = { languageId: "freebasic", uri: { toString: () => "file:///workspace/split.bas" } };
    fixture.window.visibleTextEditors = [{ document: fixture.document }, { document: other }];
    fixture.fire("snapshot", [other.uri.toString()]);
    await fixture.flush();
    assert.equal(fixture.registrations.length, 2, "visible include targets must not wait for editor focus");
});

test("include-link refresh waits for lookups and cannot revive a disposed provider", async () => {
    let finish, calls = 0;
    const expected = [{ target: "/workspace/selected.bi" }];
    const provider = { provideDocumentLinks(document, token) {
        assert.equal(this, provider);
        assert.ok(document && token);
        calls++;
        return new Promise((resolve) => { finish = resolve; });
    } };
    const fixture = documentLinkRegistrationFixture(provider);
    const registered = fixture.registrations[0].provider;
    fixture.fire("active", { document: fixture.document });
    const pending = registered.provideDocumentLinks(fixture.document, {});
    await fixture.flush();
    assert.equal(fixture.registrations.length, 1);
    finish(expected);
    assert.equal(await pending, expected);
    await fixture.flush();
    assert.equal(fixture.registrations.length, 2);
    const late = fixture.registrations[1].provider.provideDocumentLinks(fixture.document, {});
    fixture.fire("snapshot", [fixture.document.uri.toString()]);
    fixture.registration.dispose();
    finish(expected);
    await late;
    await fixture.flush();
    assert.equal(fixture.registrations.length, 2);
    assert.equal(fixture.registrations[1].disposals, 1);
    assert.deepEqual(await registered.provideDocumentLinks(fixture.document, {}), []);
    assert.equal(calls, 2);
    assert.ok(Object.values(fixture.listeners).every((listeners) => listeners.size === 0));
});

test("Outline registration coalesces active snapshots and relevant settings", async (t) => {
    const fixture = documentSymbolRegistrationFixture();
    t.after(() => fixture.registration.dispose());
    fixture.fire("snapshot", [fixture.document.uri.toString()]);
    fixture.fire("snapshot", [fixture.document.uri.toString()]);
    fixture.fire("config", { affectsConfiguration: (name) => name === "freebasic.analysis" });
    assert.equal(fixture.registrations.length, 1);
    await fixture.flush();
    assert.equal(fixture.registrations.length, 2);
    assert.equal(fixture.registrations[0].disposals, 1);
});

test("Outline registration ignores unrelated snapshots and settings", async (t) => {
    const fixture = documentSymbolRegistrationFixture();
    t.after(() => fixture.registration.dispose());
    fixture.fire("snapshot", ["file:///workspace/other.bas"]);
    fixture.fire("config", { affectsConfiguration: () => false });
    fixture.fire("active", { document: { ...fixture.document, languageId: "plaintext" } });
    await fixture.flush();
    assert.equal(fixture.registrations.length, 1);
});

test("Outline registration refreshes when a compiled document becomes active", async (t) => {
    const fixture = documentSymbolRegistrationFixture();
    t.after(() => fixture.registration.dispose());
    fixture.fire("active", { document: fixture.document });
    await fixture.flush();
    assert.equal(fixture.registrations.length, 2);
    fixture.state.configured = false;
    fixture.state.model = {};
    fixture.fire("active", { document: fixture.document });
    await fixture.flush();
    assert.equal(fixture.registrations.length, 3, "cached stock-FBC facts also need a fresh Outline");
    fixture.state.model = null;
    fixture.fire("active", { document: fixture.document });
    await fixture.flush();
    assert.equal(fixture.registrations.length, 3, "plain source tab changes do not require provider replacement");
});

test("Outline registration disposal cancels pending refreshes and detaches listeners", async () => {
    const fixture = documentSymbolRegistrationFixture();
    fixture.fire("snapshot", [fixture.document.uri.toString()]);
    fixture.registration.dispose();
    fixture.registration.dispose();
    await fixture.flush();
    assert.equal(fixture.registrations.length, 1);
    assert.equal(fixture.registrations[0].disposals, 1);
    assert.ok(Object.values(fixture.listeners).every((listeners) => listeners.size === 0));
});

test("Outline refresh waits for an active symbol request instead of cancelling it", async (t) => {
    let finish;
    const expected = [{ name: "CompiledOutline" }];
    const provider = { provideDocumentSymbols(document, token) {
        assert.equal(this, provider, "registration must preserve the provider receiver");
        assert.ok(document && token);
        return new Promise((resolve) => { finish = resolve; });
    } };
    const fixture = documentSymbolRegistrationFixture(provider);
    t.after(() => { finish?.(expected); fixture.registration.dispose(); });
    fixture.fire("active", { document: fixture.document });
    const pending = fixture.registrations[0].provider.provideDocumentSymbols(fixture.document, {});
    await fixture.flush();
    assert.equal(fixture.registrations.length, 1, "an activation refresh must not dispose an in-flight provider");
    fixture.fire("snapshot", [fixture.document.uri.toString()]);
    fixture.fire("config", { affectsConfiguration: (name) => name === "freebasic.analysis" });
    await fixture.flush();
    assert.equal(fixture.registrations[0].disposals, 0);
    finish(expected);
    assert.equal(await pending, expected);
    await fixture.flush();
    assert.equal(fixture.registrations.length, 2);
    assert.equal(fixture.registrations[0].disposals, 1);
});

test("Outline refresh waits for all requests and recovers after rejection", async (t) => {
    const completions = [];
    const fixture = documentSymbolRegistrationFixture({ provideDocumentSymbols() {
        return new Promise((resolve, reject) => completions.push({ resolve, reject }));
    } });
    t.after(() => { for (const completion of completions) completion.resolve([]); fixture.registration.dispose(); });
    const registered = fixture.registrations[0].provider;
    const first = registered.provideDocumentSymbols(fixture.document, {});
    const second = registered.provideDocumentSymbols(fixture.document, {});
    fixture.fire("snapshot", [fixture.document.uri.toString()]);
    completions[0].resolve([]);
    await first;
    await fixture.flush();
    assert.equal(fixture.registrations.length, 1, "another pending request still owns the registration");
    completions[1].reject(new Error("symbol query failed"));
    await assert.rejects(second, /symbol query failed/);
    await fixture.flush();
    assert.equal(fixture.registrations.length, 2, "rejection must release the pending refresh");
});

test("disposing Outline during a request cannot register again or start late work", async () => {
    let finish, calls = 0;
    const fixture = documentSymbolRegistrationFixture({ provideDocumentSymbols() {
        calls++;
        return new Promise((resolve) => { finish = resolve; });
    } });
    const provider = fixture.registrations[0].provider;
    assert.deepEqual(await provider.provideDocumentSymbols(fixture.document, { isCancellationRequested: true }), []);
    assert.equal(calls, 0);
    const pending = provider.provideDocumentSymbols(fixture.document, {});
    fixture.fire("snapshot", [fixture.document.uri.toString()]);
    fixture.registration.dispose();
    fixture.registration.dispose();
    finish([]);
    await pending;
    await fixture.flush();
    assert.equal(fixture.registrations.length, 1);
    assert.equal(fixture.registrations[0].disposals, 1);
    assert.deepEqual(await provider.provideDocumentSymbols(fixture.document, {}), []);
    assert.equal(calls, 1);
    assert.ok(Object.values(fixture.listeners).every((listeners) => listeners.size === 0));
});

test("include links follow a replaced compiler snapshot without exposing inactive includes", async () => {
    const document = createDocument('#if 0\n#include "inactive.bi"\n#endif\n#include "active.bi"\n');
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas" };
    document.version = 1;
    const vscode = createVscodeMock();
    vscode.DocumentLink = class { constructor(range, target) { Object.assign(this, { range, target }); } };
    let queries = 0, preparations = 0;
    const replacement = { remote: true, query: async () => {
        queries++;
        return [{ start: { line: 3, character: 10 }, end: { line: 3, character: 19 },
            target: "/workspace/active.bi", requested: "active.bi", outcome: "opened" }];
    } };
    let current = { remote: true, query: async () => { queries++; current = null; return null; } };
    const provider = createDocumentLinkProvider(vscode, {
        compilerAnalysis: {
            getModel: () => current,
            getModelForEditor: async (_document, _token, allowSidecar) => {
                assert.equal(allowSidecar, true);
                preparations++;
                current = replacement;
                return current;
            }
        },
        getParsedDocument: () => assert.fail("compiler-selected links must not fall back to inactive source includes")
    });
    const links = await provider.provideDocumentLinks(document);
    assert.equal(links.length, 1);
    assert.equal(links[0].target.fsPath, "/workspace/active.bi");
    assert.match(links[0].tooltip, /Resolved by FreeBASIC/);
    assert.equal(queries, 2);
    assert.equal(preparations, 1);

    current = null;
    assert.equal((await provider.provideDocumentLinks(document)).length, 1,
        "a lookup starting inside the upgrade gap must join compiler preparation before source fallback");
    assert.equal(preparations, 2);

    current = { remote: true, query: async () => { document.version++; return []; } };
    assert.deepEqual(await provider.provideDocumentLinks(document), [], "edits must not publish old link coordinates");
    current = replacement;
    assert.deepEqual(await provider.provideDocumentLinks(document, { isCancellationRequested: true }), []);
});

test("include-link retries remain bounded if every compiler snapshot is replaced", async () => {
    const document = createDocument('#include "active.bi"\n');
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas" };
    let queries = 0, preparations = 0;
    const model = { remote: true, query: async () => { queries++; current = null; return null; } };
    let current = model;
    const provider = createDocumentLinkProvider(createVscodeMock(), {
        compilerAnalysis: {
            getModel: () => current,
            getModelForEditor: async () => { preparations++; current = model; return model; }
        },
        getParsedDocument: () => assert.fail("a lost compiler result must not manufacture active includes")
    });
    assert.deepEqual(await provider.provideDocumentLinks(document), []);
    assert.equal(queries, 2);
    assert.equal(preparations, 1);
});

test("completion stays inside escaped strings when compiler option context is available", async () => {
    const source = "\uFEFF" + String.raw`#if 1
Option Escape
#endif
Print "inside \" escapedOnlyName ([)]"`;
    const document = createDocument(source);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/option-escape-completion.bas",
        toString: () => "file:///workspace/option-escape-completion.bas"
    };
    const line = document.lineAt(3).text;
    const character = line.indexOf("escapedOnlyName") + "escapedOnlyName".length;
    const requests = [];
    const model = {
        remote: true,
        async query(operation, _uri, input) {
            requests.push({ operation, offset: input.offset });
            assert.equal(operation, "compilerCodeContext");
            assert.equal(input.offset, document.offsetAt({ line: 3, character }) - 1,
                "compiler source offsets exclude the UTF-8 BOM");
            assert.equal(input.offsetAdjustment, 1);
            return { context: "string" };
        }
    };
    const workspaceIndex = {
        compilerAnalysis: {
            getModel: () => model,
            getModelForEditor() { assert.fail("completion must be suppressed before requesting source symbols"); }
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem: class CompletionItem {},
        CompletionItemKind: { Keyword: 1, Variable: 2, Function: 3, Struct: 4, Constant: 5, Operator: 6 }
    }, workspaceIndex, grammarData);

    assert.deepEqual(await provider.provideCompletionItems(document, { line: 3, character }), []);
    assert.deepEqual(requests, [{
        operation: "compilerCodeContext",
        offset: document.offsetAt({ line: 3, character }) - 1
    }]);
});

test("compiler string context rejects stale requests and follows one cached replacement", async () => {
    const source = "\uFEFF" + String.raw`#if 1
Option Escape
#endif
Print "inside \" GhostCall(1)"`;
    for (const mode of ["replacement", "cleared", "edit", "cancel", "pre-cancel", "churn", "failed edit", "failure", "ordinary code"]) {
        const document = createDocument(source);
        document.uri = { scheme: "file", fsPath: "/workspace/string-context-race.bas",
            toString: () => "file:///workspace/string-context-race.bas" };
        document.version = 1;
        const token = { isCancellationRequested: false };
        const line = document.lineAt(3).text;
        const character = line.indexOf("GhostCall") + 2;
        const offset = document.offsetAt({ line: 3, character });
        let current, queries = 0;
        const analysis = { generation: 0, getModel: () => current,
            getModelForEditor() { assert.fail("string context must not start another compiler analysis"); } };
        const third = { remote: true, query() { assert.fail("replacement retries must remain bounded"); } };
        const strong = { remote: true, async query(operation, _uri, input) {
            queries++;
            assert.equal(operation, "compilerCodeContext");
            assert.equal(input.offset, offset - 1, "BOM adjustment must not be applied twice on retry");
            assert.equal(input.offsetAdjustment, 1);
            if (mode === "churn") { current = third; analysis.generation++; }
            return { context: "string" };
        } };
        current = { remote: true, async query() {
            queries++;
            if (mode === "replacement" || mode === "churn") { current = strong; analysis.generation++; }
            if (mode === "cleared") { current = null; analysis.generation++; }
            if (mode === "edit" || mode === "failed edit") document.version++;
            if (mode === "cancel") token.isCancellationRequested = true;
            if (mode === "failed edit" || mode === "failure") throw new Error("context query failed");
            return mode === "ordinary code" ? { context: "code" } : null;
        } };
        if (mode === "pre-cancel") {
            token.isCancellationRequested = true;
            document.getText = () => assert.fail("a cancelled context request must not scan source");
        }
        const result = await compilerAwareCodeContext({ compilerAnalysis: analysis }, document, offset,
            line.slice(0, character), token);
        assert.equal(result.context, mode === "replacement" ? "string" : mode === "ordinary code" ? "code" : "unknown", mode);
        assert.equal(queries, mode === "pre-cancel" ? 0 : mode === "replacement" || mode === "churn" ? 2 : 1, mode);
        assert.deepEqual(result.defaultEscapedStringRanges, [], mode);
    }
});

test("compiler string context upgrades missing option facts and retains native call offsets", async () => {
    const source = "\uFEFF" + String.raw`#if 1
Option Escape
#endif
Print "inside \" ignored" : Work(1)`;
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/escape-after-literal.bas",
        toString: () => "file:///workspace/escape-after-literal.bas" };
    document.version = 1;
    const offset = source.indexOf("Work(") + "Work(".length;
    const callContext = { name: "Work", openParenthesisOffset: offset - 1, activeParameter: 0 };
    let current = { remote: true, semanticBindingsAvailable: false };
    let upgrades = 0;
    const strong = { remote: true, semanticBindingsAvailable: true, async query(operation, _uri, input) {
        assert.equal(operation, "compilerCodeContext");
        assert.equal(input.offset, offset - 1);
        assert.equal(input.offsetAdjustment, 1);
        return { context: "code", callContext, signatureCallContext: callContext };
    } };
    const analysis = { getModel: () => current,
        async getModelForEditor(received, token, needTypes, needBindings) {
            upgrades++;
            assert.equal(received, document);
            assert.equal(needTypes, false);
            assert.equal(needBindings, true);
            current = strong;
            return strong;
        } };
    const context = await compilerAwareCodeContext({ compilerAnalysis: analysis }, document, offset, "");
    assert.equal(context.context, "code");
    assert.deepEqual(context.callContext, callContext);
    assert.deepEqual(context.signatureCallContext, callContext);
    assert.equal(upgrades, 1);
});

test("unambiguous explicit strings and comments do not request compiler option facts", async () => {
    for (const source of [
        String.raw`Print !"inside \" text" : Work(1)`,
        String.raw`Print $"raw \" : Work(1)`,
        String.raw`' comment \"`,
        String.raw`/' comment \" '/ : Work(1)`,
        'Print "ordinary" : Work(1)',
        String.raw`Print "ordinary" : Work(1) ' \"`
    ]) {
        const document = createDocument(source);
        const analysis = { getModel() { assert.fail("unambiguous source must not query native facts"); } };
        const context = await compilerAwareCodeContext({ compilerAnalysis: analysis }, document, source.length, source);
        assert.equal(context.context, source.startsWith("'") || source.endsWith(String.raw`' \"`) ? "comment" : "code", source);
    }
});

test("ambiguous strings acquire native option facts without a cached model", async () => {
    const source = String.raw`#if 1
Option Escape
#endif
Print "inside \" ignored" : Work(1)`;
    for (const mode of ["ready", "unavailable", "edit", "cancel"]) {
        const document = createDocument(source);
        document.uri = { scheme: "file", fsPath: "/workspace/cold-escape-context.bas",
            toString: () => "file:///workspace/cold-escape-context.bas" };
        document.version = 1;
        const token = { isCancellationRequested: false };
        let current = null, requests = 0, queries = 0;
        const native = { remote: true, semanticBindingsAvailable: true, async query(operation) {
            queries++;
            assert.equal(operation, "compilerCodeContext");
            return { context: "code" };
        } };
        const index = { compilerAnalysis: {
            getModel: () => current,
            async getModelForEditor(received, _token, needTypes, needBindings) {
                requests++;
                assert.equal(received, document);
                assert.equal(needTypes, false);
                assert.equal(needBindings, true);
                if (mode === "edit") document.version++;
                if (mode === "cancel") token.isCancellationRequested = true;
                current = mode === "unavailable" ? null : native;
                return current;
            }
        } };
        const context = await compilerAwareCodeContext(index, document, source.indexOf("Work(") + 2, "", token);
        assert.equal(context.context, mode === "ready" ? "code" : "unknown", mode);
        assert.equal(requests, 1, mode);
        assert.equal(queries, mode === "ready" ? 1 : 0, mode);
    }
});

test("signature help ignores call-like text inside compiler-confirmed escaped strings", async () => {
    const source = String.raw`#if 1
Option Escape
#endif
Print "inside \" GhostCall(1)"`;
    const document = createDocument(source);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/option-escape-signature.bas",
        toString: () => "file:///workspace/option-escape-signature.bas"
    };
    const line = document.lineAt(3).text;
    const character = line.indexOf("GhostCall") + "GhostCall(".length;
    const start = source.indexOf("Print");
    const requests = [];
    const model = {
        remote: true,
        async query(operation, _uri, input) {
            requests.push(operation);
            assert.equal(operation, "compilerCodeContext");
            assert.ok(input.offset >= start);
            return { context: "string" };
        }
    };
    const workspaceIndex = {
        compilerAnalysis: {
            getModel: () => model,
            getModelForEditor() { assert.fail("signature help must be suppressed before symbol analysis"); }
        }
    };
    const provider = createSignatureHelpProvider({}, workspaceIndex);

    assert.equal(await provider.provideSignatureHelp(document, { line: 3, character }), null);
    assert.deepEqual(requests, ["compilerCodeContext"]);
});

test("type and call hierarchy ignore identifiers inside compiler-confirmed escaped strings", async () => {
    const source = String.raw`#if 1
Option Escape
#endif
Print "inside \" GhostCall(1) GhostType ([)]"`;
    const document = createDocument(source);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/option-escape-hierarchy.bas",
        toString: () => "file:///workspace/option-escape-hierarchy.bas"
    };
    const line = document.lineAt(3).text;
    const range = { start: source.indexOf("Print"), end: source.length };
    const requests = [];
    const model = {
        remote: true,
        async query(operation, _uri, input) {
            requests.push(operation);
            assert.equal(operation, "compilerCodeContext");
            assert.ok(input.offset >= range.start);
            return { context: "string" };
        }
    };
    class SemanticTokensLegend { constructor() {} }
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend }, {
        compilerAnalysis: {
            getModel: () => model,
            getModelForEditor() { assert.fail("navigation should stop before requesting semantic identities"); }
        }
    }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const callPosition = { line: 3, character: line.indexOf("GhostCall") + 2 };
    const typePosition = { line: 3, character: line.indexOf("GhostType") + 2 };

    assert.equal(await features.callHierarchy.prepareCallHierarchy(document, callPosition), null);
    assert.deepEqual(await features.typeHierarchy.prepareTypeHierarchy(document, typePosition), []);
    assert.deepEqual(requests, ["compilerCodeContext", "compilerCodeContext"]);
});

test("Type Hierarchy preserves native identifiers after escaped literals", async () => {
    class SemanticTokensLegend {}
    class TypeHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) {
            Object.assign(this, { kind, name, detail, uri, range, selectionRange });
        }
    }
    const document = createDocument("\uFEFF" + String.raw`#if 1
Option Escape
#endif
Print "inside \" ignored" : instance.value = 1`);
    document.uri = { scheme: "file", fsPath: "/workspace/hierarchy-after-string.bas",
        toString: () => "file:///workspace/hierarchy-after-string.bas" };
    const line = document.lineAt(3).text;
    const start = line.indexOf("instance");
    let queries = 0;
    const model = { remote: true, semanticBindingsAvailable: true, async query(operation, uri, input) {
        queries++;
        if (operation === "compilerCodeContext") {
            const character = input.offset + 1 - document.offsetAt({ line: 3, character: 0 });
            assert.equal(input.offsetAdjustment, 1);
            return { context: "code", maskedLinePrefix: " ".repeat(start) + line.slice(start, character) };
        }
        assert.equal(operation, "typeHierarchyPrepare");
        return [{ name: "Payload", uri, declaration: { type: "type", name: "Payload", detail: "Type",
            signature: "Type Payload", line: 0, startColumn: 5, endColumn: 12 } }];
    } };
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, TypeHierarchyItem }, {
        compilerAnalysis: { getModel: () => model, getModelForEditor: async () => model }
    }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    for (const relative of [0, 3, "instance".length]) {
        const items = await features.typeHierarchy.prepareTypeHierarchy(document, { line: 3, character: start + relative });
        assert.deepEqual(items.map((item) => item.name), ["Payload"], "cursor at identifier offset " + relative);
    }
    assert.equal(queries, 6);
});

test("iterator keyword analysis is gated by a visible matching operator candidate", () => {
    const document = createDocument("For current = 1 To 2\n");
    document.uri = { toString: () => "file:///workspace/main.bas" };
    const source = { visibleDocuments: new Set(["main"]) };
    const model = {
        getDocument: () => source,
        entries: []
    };
    const position = { line: 0, character: 1 };

    assert.equal(hasPotentialIteratorOperatorAt(model, document, position), false,
        "ordinary built-in loops should not request full binding analysis");

    model.entries.push({
        declaration: { type: "operator", name: "Operator IteratorValue.For" },
        document: { key: "iterator-header" }
    });
    assert.equal(hasPotentialIteratorOperatorAt(model, document, position), false,
        "an operator in an invisible header is not a candidate for this module");

    source.visibleDocuments.add("iterator-header");
    assert.equal(hasPotentialIteratorOperatorAt(model, document, position), true,
        "a visible matching Operator For permits compiler selection");
});

test("selection ranges include compiler-owned nested expression spans", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class EditorRange {
        constructor(start, end, endLine, endCharacter) {
            this.start = typeof start === "object" ? start : { line: start, character: end };
            this.end = typeof start === "object" ? end : { line: endLine, character: endCharacter };
        }
    }
    class SelectionRange {
        constructor(range, parent) { Object.assign(this, { range, parent }); }
    }
    class SemanticTokensLegend { constructor() {} }

    const document = createDocument("Sub pick()\nPrint a + b * c\nEnd Sub\n");
    document.positionAt = (offset) => {
        const before = document.getText().slice(0, offset);
        const line = before.split("\n").length - 1;
        return new Position(line, offset - before.lastIndexOf("\n") - 1);
    };
    document.uri = { scheme: "file", fsPath: "/workspace/selection.bas", toString: () => "file:///workspace/selection.bas" };
    const requests = [];
    const model = {
        remote: true,
        async query(operation, _uri, input) {
            requests.push({ operation, positions: input.positions });
            return [[
                { start: { line: 1, character: 10 }, end: { line: 1, character: 11 } },
                { start: { line: 1, character: 10 }, end: { line: 1, character: 15 } },
                { start: { line: 1, character: 6 }, end: { line: 1, character: 15 } }
            ]];
        }
    };
    const index = {
        compilerAnalysis: { getModelForEditor: () => model },
        getParsedDocument: (source) => parseFreeBasicText(source.getText())
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        Position,
        Range: EditorRange,
        SelectionRange,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const selections = await features.selectionRange.provideSelectionRanges(document, [{ line: 1, character: 11 }]);
    const ranges = [];
    for (let selection = selections[0]; selection; selection = selection.parent) {
        ranges.push([
            selection.range.start.line, selection.range.start.character,
            selection.range.end.line, selection.range.end.character
        ].join(","));
    }

    assert.ok(ranges.includes("1,10,1,15"), "the multiplication should be a selectable expression");
    assert.ok(ranges.includes("1,6,1,15"), "the containing sum should be a selectable expression");
    assert.deepEqual(requests, [{ operation: "compilerSelectionRanges", positions: [{ line: 1, character: 11 }] }]);
});

test("compiler reference CodeLens uses cached sidecar bindings without starting analysis", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class EditorRange {
        constructor(startLine, startColumn, endLine, endColumn) {
            this.start = { line: startLine, character: startColumn };
            this.end = { line: endLine, character: endColumn };
        }
    }
    class CodeLens {
        constructor(range, command) { Object.assign(this, { range, command }); }
    }
    class Location {
        constructor(uri, range) { Object.assign(this, { uri, range }); }
    }
    class SemanticTokensLegend { constructor() {} }

    const document = createDocument("Sub ReadValue()\nEnd Sub\n");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            requests.push(operation);
            return {
                complete: true,
                entries: [{
                    name: "ReadValue", line: 0, startColumn: 4, endColumn: 13,
                    references: [
                        { filePath: "/workspace/main.bas", line: 3, startColumn: 4, endColumn: 13 },
                        { filePath: "/workspace/other.bas", line: 8, startColumn: 0, endColumn: 9 }
                    ]
                }]
            };
        }
    };
    const index = {
        compilerAnalysis: {
            getModel: () => model,
            getModelForEditor() { throw new Error("CodeLens must not start compiler analysis"); }
        },
        onDidChangeModel: () => {}
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        Position,
        Range: EditorRange,
        CodeLens,
        Location,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const lenses = await features.callCodeLens.provideCodeLenses(document);

    assert.equal(lenses.length, 1);
    assert.equal(lenses[0].command.title, "2 references");
    assert.equal(lenses[0].command.command, "editor.action.showReferences");
    assert.equal(lenses[0].command.arguments[2].length, 2);
    assert.deepEqual(requests, ["compilerProcedureReferenceCodeLenses"]);

    model.semanticBindingsAvailable = false;
    requests.length = 0;
    assert.deepEqual(await features.callCodeLens.provideCodeLenses(document), [],
        "an expression-only snapshot must not trigger a CodeLens query without physical bindings");
    assert.deepEqual(requests, []);
});

test("stock-sidecar Type Hierarchy requests bindings and reuses the cached model", async () => {
    class TypeHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) {
            Object.assign(this, { kind, name, detail, uri, range, selectionRange });
        }
    }
    class SemanticTokensLegend { constructor() {} }

    const document = createDocument("Type Derived Extends Base\nEnd Type\n");
    document.uri = { scheme: "file", fsPath: "/workspace/hierarchy.bas", toString: () => "file:///workspace/hierarchy.bas" };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, uri, input) {
            requests.push(operation);
            const entry = (name, line, startColumn, endColumn) => ({
                name,
                uri,
                declaration: {
                    name,
                    type: "type",
                    detail: "Type",
                    line,
                    startColumn,
                    endColumn,
                    signature: `Type ${name}`
                }
            });
            if (operation === "typeHierarchyPrepare") return [entry("Derived", 0, 5, 12)];
            if (operation === "typeHierarchySupertypes") return [entry("Base", 2, 5, 9)];
            if (operation === "typeHierarchySubtypes") return [entry("Derived", 0, 5, 12)];
            assert.fail(`Unexpected hierarchy query: ${operation}`);
        }
    };
    const modelRequests = [];
    let sourceModel = null;
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async (_document, _token, needTypes, needBindings, needMacroBindings) => {
                modelRequests.push([needTypes, needBindings, needMacroBindings]);
                return model;
            },
            getModel: () => model
        },
        getSourceSemanticModel: () => sourceModel,
        isIncomplete: () => false,
        getParsedDocument() { assert.fail("stock-sidecar Type Hierarchy should not initialize source-only fallback"); },
        ensureInitialized() { assert.fail("stock-sidecar Type Hierarchy should not initialize source-only fallback"); }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        SemanticTokensLegend,
        TypeHierarchyItem
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });

    const literalDocument = createDocument("Print 1\n");
    literalDocument.uri = {
        scheme: "file",
        fsPath: "/workspace/hierarchy-literal.bas",
        toString: () => "file:///workspace/hierarchy-literal.bas"
    };
    assert.deepEqual(await features.typeHierarchy.prepareTypeHierarchy(literalDocument, { line: 0, character: 6 }), []);
    assert.deepEqual(modelRequests, [], "a numeric expression should not start stock-sidecar binding analysis");

    const scalarDocument = createDocument("Dim scalarValue As Long\nPrint scalarValue\n");
    scalarDocument.uri = {
        scheme: "file",
        fsPath: "/workspace/hierarchy-scalar.bas",
        toString: () => "file:///workspace/hierarchy-scalar.bas"
    };
    const scalarDeclaration = { declaration: { type: "variable", typeName: "Long" }, conditional: false, provisional: false };
    sourceModel = {
        resolveAt: () => [scalarDeclaration],
        typeEntries: () => []
    };
    assert.deepEqual(await features.typeHierarchy.prepareTypeHierarchy(scalarDocument, { line: 1, character: 8 }), []);
    assert.deepEqual(modelRequests, [], "a known scalar variable should not start stock-sidecar binding analysis");
    sourceModel = null;

    const prepared = await features.typeHierarchy.prepareTypeHierarchy(document, { line: 0, character: 6 });
    assert.equal(prepared[0].name, "Derived");
    const parents = await features.typeHierarchy.provideTypeHierarchySupertypes(prepared[0]);
    assert.deepEqual(parents.map((entry) => entry.name), ["Base"]);
    const children = await features.typeHierarchy.provideTypeHierarchySubtypes(parents[0]);
    assert.deepEqual(children.map((entry) => entry.name), ["Derived"]);
    assert.deepEqual(modelRequests, [[false, true, false]],
        "an explicit stock-sidecar hierarchy request should prepare physical compiler bindings once");
    assert.deepEqual(requests, ["typeHierarchyPrepare", "typeHierarchySupertypes", "typeHierarchySubtypes"]);
});

for (const [name, declaration] of [
    ["VAR result", "Var chosen = BuildValue()"],
    ["TYPEOF result", "Dim chosen As Typeof(BuildValue())"],
    ["TYPEOF alias", "Type ValueAlias As Typeof(BuildValue())\nDim chosen As ValueAlias"]
]) test(`stock-sidecar type navigation does not mistake an unknown source type for a primitive (${name})`, async () => {
    class TypeHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) {
            Object.assign(this, { kind, name, detail, uri, range, selectionRange });
        }
    }
    class SemanticTokensLegend { constructor() {} }
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    const source = ["Type BaseValue", "    value As Long", "End Type", "Type DerivedValue Extends BaseValue",
        "End Type", "Declare Function BuildValue() As DerivedValue", declaration, "Print chosen.value"].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/hierarchy.bas", toString: () => "file:///workspace/hierarchy.bas" };
    const sourceModel = new FreeBasicSemanticModel([{ uri: document.uri, parsed: parseFreeBasicText(source) }]);
    const selectedLine = source.split("\n").findIndex((line) => line.startsWith("Print chosen"));
    const position = { line: selectedLine, character: "Print c".length };
    const targets = sourceModel.resolveAt(document.uri, position.line, position.character);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].conditional, false);
    assert.deepEqual(sourceModel.typeEntries(targets[0]), [], "the source resolver cannot infer this compiler-selected type");
    const requests = [];
    const model = { remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation) {
            assert.ok(["typeHierarchyPrepare", "compilerSidecarTypeDefinition"].includes(operation));
            return [{ name: "DerivedValue", uri: document.uri,
                declaration: { name: "DerivedValue", type: "type", detail: "Type", signature: "Type DerivedValue Extends BaseValue",
                    line: 3, startColumn: 5, endColumn: 17 } }];
        } };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async (_document, _token, needTypes, needBindings) => {
                requests.push([needTypes, needBindings]);
                return model;
            },
            getModel: () => model
        },
        getSourceSemanticModel: () => sourceModel,
        isIncomplete: () => false
    };
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, TypeHierarchyItem, Location }, index,
        { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const definitions = await features.typeDefinition.provideTypeDefinition(document, position);
    assert.deepEqual(definitions.map((item) => [item.uri.fsPath, item.range.start.line]), [[document.uri.fsPath, 3]]);
    const hierarchy = await features.typeHierarchy.prepareTypeHierarchy(document, position);
    assert.deepEqual(hierarchy.map((item) => item.name), ["DerivedValue"]);
    assert.deepEqual(requests, [[true, true], [false, true]], "an unresolved source type must reach the compiler binding model");
});

for (const constructor of [false, true]) test(`source declaration and implementation navigation keep independent families (${constructor ? "constructor" : "procedure"})`, async () => {
    class SemanticTokensLegend { constructor() {} }
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    class CallHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) {
            Object.assign(this, { kind, name, detail, uri, range, selectionRange });
        }
    }
    const documents = [], inputs = [];
    const constructorParameters = ["ByVal value As Long", "ByVal value As Long Ptr", "ByVal value As Long Ptr Ptr",
        "values(Any) As Long", "values(Any, Any) As Long"];
    for (const name of ["first", "second"]) {
        const header = createDocument(constructor ? "Type Record\nnumber As Long\n" +
            constructorParameters.map((parameter) => `Declare Constructor(${parameter})\n`).join("") + "End Type\n"
            : "Declare Sub FamilyNavigationProbe()\n");
        const source = createDocument(constructor ? constructorParameters.map((parameter) =>
            `Constructor Record(${parameter.replace(/\bPtr\b/g, "Pointer")})\nnumber = 0\nEnd Constructor\n`).join("")
            : "Sub FamilyNavigationProbe()\nEnd Sub\nFamilyNavigationProbe()\n");
        for (const [document, extension] of [[header, "bi"], [source, "bas"]]) {
            const filePath = `/workspace/${name}.${extension}`;
            document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
            documents.push(document);
            inputs.push({ uri: document.uri, parsed: parseFreeBasicText(document.getText()),
                includeUris: document === source ? new Set([header.uri.toString()]) : new Set() });
        }
    }
    const model = new FreeBasicSemanticModel(inputs);
    const index = { getParsedDocument: (document) => parseFreeBasicText(document.getText()),
        ensureInitialized: async () => true, getSemanticModel: () => model, getSourceSemanticModel: () => model };
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, Location }, index,
        { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const declarationPoint = { line: 0, character: constructor ? 2 : "Sub F".length };
    const declarations = await features.declaration.provideDeclaration(documents[1], declarationPoint);
    assert.deepEqual(declarations.map((entry) => entry.uri.fsPath), ["/workspace/first.bi"]);
    const implementationPoint = constructor ? { line: 2, character: "Declare C".length } : { line: 0, character: "Declare Sub F".length };
    const implementations = await features.implementation.provideImplementation(documents[0], implementationPoint);
    assert.deepEqual(implementations.map((entry) => entry.uri.fsPath), ["/workspace/first.bas"]);
    if (!constructor) return;
    for (let index = 0; index < constructorParameters.length; index++) {
        const declarations = await features.declaration.provideDeclaration(documents[1], { line: index * 3, character: 2 });
        assert.deepEqual(declarations.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [["/workspace/first.bi", index + 2]]);
        const implementations = await features.implementation.provideImplementation(documents[0], { line: index + 2, character: "Declare C".length });
        assert.deepEqual(implementations.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [["/workspace/first.bas", index * 3]]);
    }

    const requests = [];
    const compilerModel = { remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            requests.push([operation, input]);
            return [];
        } };
    const compilerIndex = { ...index, compilerAnalysis: {
        getModelForEditor: async () => compilerModel, getModel: () => compilerModel
    } };
    const compilerFeatures = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, Location, CallHierarchyItem },
        compilerIndex, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    for (const [document, point] of [[documents[0], implementationPoint], [documents[1], { line: 0, character: "Constructor R".length }]]) {
        await compilerFeatures.reference.provideReferences(document, point, { includeDeclaration: true });
        await compilerFeatures.documentHighlight.provideDocumentHighlights(document, point);
        assert.equal(requests.length, 2);
        for (const [operation, input] of requests.splice(0)) {
            assert.ok(["references", "highlights"].includes(operation));
            assert.deepEqual(input.constructorProcedure, { filePath: "/workspace/first.bas", startLine: 1,
                declarations: [{ filePath: "/workspace/first.bi", line: 2 }, { filePath: "/workspace/first.bas", line: 0 }] },
            "compiler constructor queries must retain the connected body and declarations only");
        }
    }
    const hierarchy = await compilerFeatures.callHierarchy.prepareCallHierarchy(documents[1], { line: 0, character: "Constructor R".length });
    assert.deepEqual(hierarchy.map((entry) => entry.uri.fsPath), ["/workspace/first.bas"]);
    const headerHierarchy = await compilerFeatures.callHierarchy.prepareCallHierarchy(documents[0], implementationPoint);
    assert.deepEqual(headerHierarchy.map((entry) => entry.uri.fsPath), ["/workspace/first.bas"],
        "a constructor prototype must prepare its connected body even though the header cannot include it");
});

test("lifetime implementations retain their lexical namespace around an unqualified type name", async () => {
    class SemanticTokensLegend { constructor() {} }
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    const header = createDocument("Namespace LifetimeScope\nType Value\nnumber As Long\nDeclare Constructor()\nDeclare Destructor()\nEnd Type\nEnd Namespace\n");
    const source = createDocument("Namespace LifetimeScope\nConstructor Value()\nEnd Constructor\nDestructor Value()\nEnd Destructor\nEnd Namespace\n");
    for (const [document, extension] of [[header, "bi"], [source, "bas"]]) {
        const filePath = `/workspace/lifetime.${extension}`;
        document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    }
    const model = new FreeBasicSemanticModel([{ uri: header.uri, parsed: parseFreeBasicText(header.getText()) },
        { uri: source.uri, parsed: parseFreeBasicText(source.getText()), includeUris: new Set([header.uri.toString()]) }]);
    const index = { getParsedDocument: (document) => parseFreeBasicText(document.getText()), ensureInitialized: async () => true,
        getSemanticModel: () => model, getSourceSemanticModel: () => model };
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, Location }, index,
        { keywords: [], types: [], operatorKeywords: [], constants: [] });
    for (const [prototypeLine, bodyLine] of [[3, 1], [4, 3]]) {
        const targets = await features.implementation.provideImplementation(header, { line: prototypeLine, character: "Declare C".length });
        assert.deepEqual(targets.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[source.uri.fsPath, bodyLine]]);
    }
});

for (const namespaced of [false, true]) test(`destructor prototypes retain cleanup and body calls (namespace=${namespaced})`, async () => {
    class SemanticTokensLegend { constructor() {} }
    class CallHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); }
    }
    class CallHierarchyIncomingCall { constructor(from, fromRanges) { Object.assign(this, { from, fromRanges }); } }
    class CallHierarchyOutgoingCall { constructor(to, fromRanges) { Object.assign(this, { to, fromRanges }); } }
    const documents = [], inputs = [];
    const prefix = namespaced ? "Namespace CleanupSpace\n" : "", suffix = namespaced ? "End Namespace\n" : "";
    const lineOffset = namespaced ? 1 : 0;
    const deleteLine = namespaced ? 8 : 6;
    const typeName = namespaced ? "CleanupSpace.CleanupOwner" : "CleanupOwner";
    for (const name of ["first", "second"]) {
        const header = createDocument(prefix + "Type CleanupOwner\nnumber As Long\nDeclare Destructor()\nEnd Type\n" + suffix);
        const source = createDocument(prefix + "Sub ObserveDestruction()\nEnd Sub\nDestructor CleanupOwner()\nObserveDestruction()\nEnd Destructor\n" + suffix +
            `Dim allocated As ${typeName} Ptr = New ${typeName}\nDelete allocated\n`);
        for (const [document, extension] of [[header, "bi"], [source, "bas"]]) {
            const filePath = `/workspace/${name}.${extension}`;
            document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
            documents.push(document);
            inputs.push({ uri: document.uri, parsed: parseFreeBasicText(document.getText()),
                includeUris: document === source ? new Set([header.uri.toString()]) : new Set() });
        }
    }
    const model = new FreeBasicSemanticModel(inputs);
    const compilerModel = { remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation) {
            if (operation === "compilerSidecarCallBindingsInSnapshot") return { complete: true, calls: [] };
            if (operation === "compilerSidecarOperatorOperationsInSnapshot") return { complete: true, operations: [] };
            if (operation === "compilerSidecarOperatorExpressionsInSnapshot") return { complete: true, expressions: [] };
            assert.equal(operation, "compilerSidecarImplicitCallsInSnapshot");
            return { complete: true, calls: [{ physical: true, kind: "delete-destructor", filePath: "/workspace/first.bas",
                line: deleteLine, startColumn: 0, endLine: deleteLine, endColumn: 16, targetSymbols: [1], targetSignatures: ["Destructor CleanupOwner()"],
                procedures: [{ filePath: "/workspace/first.bas", startLine: 3 + lineOffset }] }] };
        } };
    const index = { getParsedDocument: (document) => parseFreeBasicText(document.getText()),
        ensureInitialized: async () => true, getSemanticModel: () => model, getSourceSemanticModel: () => model,
        compilerAnalysis: { getModel: () => compilerModel, getModelForEditor: async () => compilerModel } };
    const vscode = { ...createVscodeMock(), SemanticTokensLegend, CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall };
    vscode.workspace.textDocuments = documents;
    const features = createSemanticFeatures(vscode, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const prepared = await features.callHierarchy.prepareCallHierarchy(documents[0], { line: 2 + lineOffset, character: "Declare D".length });
    assert.equal(prepared.length, 1);
    const incoming = await features.callHierarchy.provideCallHierarchyIncomingCalls(prepared[0]);
    assert.deepEqual(incoming.flatMap((call) => call.fromRanges.map((range) => [call.from.uri.fsPath, range.start.line])),
        [["/workspace/first.bas", deleteLine]]);
    const outgoing = await features.callHierarchy.provideCallHierarchyOutgoingCalls(prepared[0]);
    assert.deepEqual(outgoing.map((call) => [call.to.uri.fsPath, call.to.name]), [["/workspace/first.bas", "ObserveDestruction"]]);
});

test("closed module outgoing hierarchy keeps selected constructors without duplicating ordinary calls", async () => {
    class SemanticTokensLegend { constructor() {} }
    class CallHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); }
    }
    class CallHierarchyOutgoingCall { constructor(to, fromRanges) { Object.assign(this, { to, fromRanges }); } }
    const text = fs.readFileSync(path.join(__dirname, "fixtures/namespace-initializer-calls.bas"), "utf8");
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/namespace-initializers.bas", toString: () => "file:///workspace/namespace-initializers.bas" };
    const model = new FreeBasicSemanticModel([{ uri: document.uri, parsed: parseFreeBasicText(text) }]);
    const constructorLine = text.split("\n").findIndex((line) => /^Constructor TrackedValue/.test(line));
    const constructor = model.entries.find((entry) => entry.declaration.type === "constructor" &&
        entry.declaration.line === constructorLine);
    const moduleAction = model.entries.find((entry) => entry.name === "ModuleAction");
    const calls = [];
    const moduleLines = [];
    for (const [line, lineText] of text.split("\n").entries()) {
        const match = lineText.match(/Dim (?:Shared )?([A-Za-z_]+) As TrackedValue =/);
        if (!match) continue;
        if (lineText.includes("Shared")) moduleLines.push(line);
        const startColumn = lineText.indexOf(match[1]);
        calls.push({ kind: "initializer-constructor", physical: true, filePath: document.uri.fsPath,
            line, startColumn, endLine: line, endColumn: startColumn + match[1].length,
            targetSymbols: [13], targetSignatures: ["Constructor TrackedValue(ByVal initialValue As Long)"],
            procedures: [{ filePath: document.uri.fsPath, startLine: constructorLine + 1 }] });
    }
    for (const sidecar of [true, false]) for (const closed of [true, false]) {
        let opened = 0;
        let editDuringQuery = false;
        let indexed = false;
        let includesLoaded = false;
        const queries = [];
        document.version = 1;
        const compilerModel = { remote: true, semanticSidecarOnly: sidecar, semanticBindingsAvailable: true,
            async query(operation) {
                queries.push(operation);
                if (["compilerSidecarCallBindingsInSnapshot", "compilerSidecarOperatorOperationsInSnapshot",
                    "compilerSidecarOperatorExpressionsInSnapshot"].includes(operation)) {
                    return { complete: true, calls: [], operations: [], expressions: [] };
                }
                if (operation === "compilerSidecarImplicitCallsInSnapshot") {
                    if (editDuringQuery) document.version++;
                    return { complete: true, calls };
                }
                assert.equal(operation, "callHierarchyOutgoing");
                if (editDuringQuery) document.version++;
                return [{ ...moduleAction, fromRanges: [{ line: 0, startColumn: 0, endColumn: 1 }] },
                    { ...constructor, declaration: { ...constructor.declaration, startColumn: 0, endColumn: "Constructor".length },
                        fromRanges: calls.filter((call) => moduleLines.includes(call.line)) }];
            } };
        const sourceModel = () => {
            assert.equal(indexed, true, "the loaded document must be indexed before resolving its hierarchy item");
            assert.equal(includesLoaded, true, "reopened include links must be ready before taking the source snapshot");
            return model;
        };
        const index = { getParsedDocument: (current) => { indexed = true; return parseFreeBasicText(current.getText()); },
            async loadIncludes() { assert.equal(indexed, true); includesLoaded = true; },
            getSemanticModel: sourceModel, getSourceSemanticModel: sourceModel,
            compilerAnalysis: { getModel: () => compilerModel, getModelForEditor: async () => compilerModel } };
        const baseVscode = createVscodeMock();
        const features = createSemanticFeatures({ ...baseVscode, SemanticTokensLegend, CallHierarchyItem, CallHierarchyOutgoingCall,
            SymbolKind: { ...baseVscode.SymbolKind, File: 1, Constructor: 8 },
            workspace: { ...baseVscode.workspace, textDocuments: closed ? [] : [document],
                async openTextDocument(uri) { assert.equal(uri.toString(), document.uri.toString()); opened++; return document; } }
        }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
        const moduleItem = {
            kind: 1, detail: "Module-level calls", uri: document.uri, selectionRange: new Range(0, 0, 0, 0)
        };
        const outgoing = await features.callHierarchy.provideCallHierarchyOutgoingCalls(moduleItem);
        assert.equal(outgoing.filter((call) => call.to.name === "ModuleAction").length, 1);
        const constructors = outgoing.filter((call) => call.to.kind === 8);
        assert.equal(constructors.length, 1, `${sidecar ? "stock" : "native"}: closed=${closed}`);
        assert.equal(constructors[0].to.selectionRange.start.character, 0,
            "a constructor item must select its callable keyword rather than the owner type");
        assert.equal(constructors[0].to.selectionRange.end.character, "Constructor".length);
        assert.deepEqual(constructors[0].fromRanges.map((range) => range.start.line), moduleLines,
            "local constructor sites must not be added to the module");
        assert.equal(outgoing.length, 2);
        if (!sidecar) assert.deepEqual(queries, ["callHierarchyOutgoing"],
            "native module lifetime calls must come from one worker query, not a source-only merge");
        assert.equal(opened, closed ? 1 : 0);
        editDuringQuery = true;
        assert.equal(await features.callHierarchy.provideCallHierarchyOutgoingCalls(moduleItem), null,
            "an edit during hierarchy queries must discard the result");
    }
});

test("Call Hierarchy cancellation while loading a closed document starts no compiler work", async () => {
    class SemanticTokensLegend { constructor() {} }
    const document = createDocument("Sub ClosedTarget()\nEnd Sub\n");
    document.uri = { toString: () => "file:///workspace/closed-target.bas" };
    for (const stage of ["document", "includes"]) for (const operation of ["provideCallHierarchyIncomingCalls", "provideCallHierarchyOutgoingCalls"]) {
        const token = { isCancellationRequested: false };
        let opened = 0;
        const unexpected = () => assert.fail("a cancelled load must not index or request compiler assistance");
        const baseVscode = createVscodeMock();
        const features = createSemanticFeatures({ ...baseVscode, SemanticTokensLegend,
            workspace: { ...baseVscode.workspace, textDocuments: [], async openTextDocument() {
                opened++;
                if (stage === "document") token.isCancellationRequested = true;
                return document;
            } }
        }, { getParsedDocument: stage === "document" ? unexpected : () => {}, getSemanticModel: unexpected,
            async loadIncludes() { assert.equal(stage, "includes"); token.isCancellationRequested = true; },
            compilerAnalysis: { getModel: unexpected, getModelForEditor: unexpected }
        }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
        assert.equal(await features.callHierarchy[operation]({ uri: document.uri, kind: 11,
            selectionRange: new Range(0, 0, 0, 0) }, token), null);
        assert.equal(opened, 1);
    }
});

test("native destructor incoming lookup upgrades weak facts without upgrading ordinary methods", async () => {
    class SemanticTokensLegend { constructor() {} }
    for (const [text, line, needsBindings] of [
        ["Destructor Owner()\nEnd Destructor\n", 0, true],
        ["Sub NormalMethod()\nEnd Sub\n", 0, false],
        ["Destructor Owner()\nEnd Destructor\n", 99, false]
    ]) {
        const document = createDocument(text);
        document.uri = { scheme: "file", fsPath: "/workspace/lifetime.bas", toString: () => "file:///workspace/lifetime.bas" };
        const requests = [];
        const query = async (operation) => { assert.equal(operation, "callHierarchyIncoming"); return []; };
        const weak = { remote: true, semanticSidecarOnly: false, semanticBindingsAvailable: false, query };
        const strong = { ...weak, semanticBindingsAvailable: true };
        const baseVscode = createVscodeMock();
        const features = createSemanticFeatures({ ...baseVscode, SemanticTokensLegend,
            workspace: { ...baseVscode.workspace, textDocuments: [document] }
        }, { getParsedDocument: () => parseFreeBasicText(text), compilerAnalysis: {
            getModel: () => weak,
            async getModelForEditor(_document, _token, expressions, bindings) { requests.push([expressions, bindings]); return strong; }
        } }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
        assert.deepEqual(await features.callHierarchy.provideCallHierarchyIncomingCalls({
            kind: baseVscode.SymbolKind.Method, uri: document.uri, selectionRange: new Range(line, 0, line, 0)
        }), []);
        assert.deepEqual(requests, needsBindings ? [[true, true]] : [], `${text}: line ${line}`);
    }
});

test("native lifetime references and highlights retain their native route on the first lookup", async () => {
    class SemanticTokensLegend { constructor() {} }
    for (const [header, prefix, expected] of [
        ["Destructor Owner()", "", true],
        ["Declare Destructor()", "Declare ", true],
        ["Private Destructor Owner()", "Private ", true],
        ["Constructor Owner()", "", true],
        ["Declare Constructor()", "Declare ", true],
        ["Sub NormalMethod()", "Sub ", false]
    ]) {
        const document = createDocument(header + "\n");
        document.uri = { scheme: "file", fsPath: "/workspace/lifetime-references.bas", toString: () => "file:///workspace/lifetime-references.bas" };
        const requests = [];
        const model = { remote: true, semanticSidecarOnly: false, semanticBindingsAvailable: true,
            async query(_operation, _uri, input) {
                assert.equal(input.constructorProcedure, undefined, "a stock-sidecar descriptor must not override native constructor references");
                assert.equal(input.destructorProcedure, undefined);
                return [];
            } };
        const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend }, {
            compilerAnalysis: { getModel: () => null, analysisCompilerFor: () => ({ semanticModelOnly: false }),
                async getModelForEditor(_document, _token, types, bindings) { requests.push([types, bindings]); return model; }
            }
        }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
        const position = { line: 0, character: prefix.length + 1 };
        assert.deepEqual(await features.reference.provideReferences(document, position, { includeDeclaration: true }), []);
        assert.deepEqual(requests, [[false, expected]], `references: ${header}`);
        requests.length = 0;
        assert.deepEqual(await features.documentHighlight.provideDocumentHighlights(document, position), []);
        assert.deepEqual(requests, [[false, expected]], `highlights: ${header}`);
    }
});

test("native lifetime providers follow a superseded binding upgrade", async () => {
    class SemanticTokensLegend { constructor() {} }
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    class DocumentHighlight { constructor(range, kind) { Object.assign(this, { range, kind }); } }
    for (const provider of ["references", "highlights"]) for (const retained of [true, false]) {
        const document = createDocument("Destructor Owner()\nEnd Destructor\n");
        document.version = 1;
        document.uri = { scheme: "file", fsPath: "/workspace/lifetime-upgrade.bas",
            toString: () => "file:///workspace/lifetime-upgrade.bas" };
        const reference = { uri: document.uri, occurrence: { line: 1, startColumn: 0, endColumn: 3 }, accessRole: "read" };
        let requests = 0, weakQueries = 0;
        const weak = { remote: true, semanticSidecarOnly: false, semanticBindingsAvailable: false,
            query: async () => { weakQueries++; return []; } };
        const strong = { ...weak, semanticBindingsAvailable: true,
            query: async (operation) => { assert.equal(operation, provider); return [reference]; } };
        const analysis = { generation: 0, getModel: () => retained ? weak : null,
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            async getModelForEditor(_document, _token, types, bindings) {
                assert.equal(types, false);
                assert.equal(bindings, true);
                requests++;
                if (requests === 1) {
                    if (!retained) analysis.generation++;
                    return null;
                }
                return strong;
            }
        };
        const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, Location, DocumentHighlight }, {
            compilerAnalysis: analysis,
            getParsedDocument() { assert.fail("the successor binding model should avoid source-only fallback"); },
            ensureInitialized() { assert.fail("the successor binding model should avoid workspace discovery"); }
        }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
        const position = { line: 0, character: 1 };
        const result = provider === "references"
            ? await features.reference.provideReferences(document, position, { includeDeclaration: true })
            : await features.documentHighlight.provideDocumentHighlights(document, position);
        assert.equal(result.length, 1, `${provider}: retained=${retained}`);
        assert.equal(weakQueries, 0, "lifetime lookup must not query the binding-free predecessor");
        assert.equal(requests, 2, "follow one successor, not an unbounded retry loop");
    }
});

test("semantic providers discard a model when its document changes during acquisition", async () => {
    class SemanticTokensLegend { constructor() {} }
    const document = createDocument("Destructor Owner()\nEnd Destructor\n");
    document.uri = { scheme: "file", fsPath: "/workspace/lifetime-edit.bas",
        toString: () => "file:///workspace/lifetime-edit.bas" };
    const model = { remote: true, semanticSidecarOnly: false, semanticBindingsAvailable: true,
        query() { assert.fail("an intervening edit must discard the acquired model"); } };
    for (const stage of ["compiler", "source initialization"]) {
        document.version = 1;
        const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend }, {
            compilerAnalysis: { async getModelForEditor() {
                if (stage !== "compiler") return null;
                document.version++;
                return model;
            } },
            getParsedDocument: () => parseFreeBasicText(document.getText()),
            async ensureInitialized() { document.version++; return true; },
            getSemanticModel() { assert.fail("an intervening edit must also prevent source-model fallback"); }
        }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
        assert.equal(await features.reference.provideReferences(document, { line: 0, character: 1 },
            { includeDeclaration: true }), null, stage);
    }
});

for (const withBody of [true, false]) test(`stock destructor providers send a selected lifetime descriptor (body=${withBody})`, async () => {
    class SemanticTokensLegend { constructor() {} }
    const text = withBody ? fs.readFileSync(path.join(__dirname, "fixtures/destructor-hierarchy.bas"), "utf8")
        : "Type CleanupValue\nvalue As Long\nDeclare Destructor()\nEnd Type\n";
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-cleanup.bas", toString: () => "file:///workspace/stock-cleanup.bas" };
    const parsed = parseFreeBasicText(text);
    const sourceModel = new FreeBasicSemanticModel([{ uri: document.uri, parsed }]);
    const lines = text.split("\n");
    const prototypeLine = lines.findIndex((line) => line.includes("Declare Destructor"));
    const definitionLine = withBody ? lines.findIndex((line) => /^Destructor CleanupValue/.test(line)) : prototypeLine;
    const operations = [];
    const compiler = { remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            operations.push(operation);
            assert.equal(input.constructorProcedure, undefined);
            assert.deepEqual(input.destructorProcedure, { filePath: document.uri.fsPath, startLine: definitionLine + 1,
                declarations: [{ filePath: document.uri.fsPath, line: prototypeLine },
                    ...(withBody ? [{ filePath: document.uri.fsPath, line: definitionLine }] : [])] });
            return [];
        } };
    const index = { getParsedDocument: () => parsed, ensureInitialized: async () => true,
        getSourceSemanticModel: () => sourceModel, getSemanticModel: () => sourceModel,
        compilerAnalysis: { getModel: () => compiler, getModelForEditor: async () => compiler,
            analysisCompilerFor: () => ({ semanticModelOnly: true }) },
        compilerProject: { hasProjectContexts: () => true, references() {
            assert.fail("ordinary project bindings must not replace selected destructor cleanup receipts");
        } }
    };
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend }, index,
        { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const point = { line: prototypeLine, character: lines[prototypeLine].indexOf("Destructor") + 1 };
    assert.deepEqual(await features.reference.provideReferences(document, point, { includeDeclaration: true }), []);
    assert.deepEqual(await features.documentHighlight.provideDocumentHighlights(document, point), []);
    assert.deepEqual(operations, ["references", "highlights"]);
});

test("opaque Call Hierarchy identities keep scalar and pointer CAST callers separate", async () => {
    class SemanticTokensLegend { constructor() {} }
    class CallHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) {
            Object.assign(this, { kind, name, detail, uri, range, selectionRange });
        }
    }
    class CallHierarchyIncomingCall {
        constructor(from, fromRanges) { Object.assign(this, { from, fromRanges }); }
    }
    const header = createDocument("Type CastOwner\nnumber As Long\nDeclare Operator Cast() As Long\nDeclare Operator Cast() As Long Ptr\nEnd Type\n");
    const source = createDocument("Operator CastOwner.Cast() As Long\nReturn number\nEnd Operator\n" +
        "Operator CastOwner.Cast() As Long Ptr\nReturn @number\nEnd Operator\n" +
        "Dim current As CastOwner\nPrint CLng(current)\nDim pointer As Long Ptr = Cast(Long Ptr, current)\n");
    for (const [document, extension] of [[header, "bi"], [source, "bas"]]) {
        const filePath = `/workspace/cast.${extension}`;
        document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    }
    const model = new FreeBasicSemanticModel([
        { uri: header.uri, parsed: parseFreeBasicText(header.getText()) },
        { uri: source.uri, parsed: parseFreeBasicText(source.getText()), includeUris: new Set([header.uri.toString()]) }
    ]);
    const operations = [7, 8].map((line, index) => {
        const startColumn = source.lineAt(line).text.indexOf(index ? "Cast(" : "CLng(");
        return { operatorCode: "cast", physical: true, targetSymbols: [index + 1],
            procedures: [{ filePath: source.uri.fsPath, startLine: index * 3 + 1 }], filePath: source.uri.fsPath,
            line, startColumn, endLine: line, endColumn: startColumn + 4 };
    });
    const compilerModel = { remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation) {
            if (operation === "compilerSidecarImplicitCallsInSnapshot") return { complete: true, calls: [] };
            assert.equal(operation, "compilerSidecarOperatorOperationsInSnapshot");
            return { complete: true, operations };
        } };
    const index = { getParsedDocument: (document) => parseFreeBasicText(document.getText()),
        ensureInitialized: async () => true, getSemanticModel: () => model, getSourceSemanticModel: () => model,
        compilerAnalysis: { getModelForEditor: async () => compilerModel, getModel: () => compilerModel } };
    const vscode = createVscodeMock();
    vscode.workspace.textDocuments = [header, source];
    const features = createSemanticFeatures({ ...vscode, SemanticTokensLegend, CallHierarchyItem, CallHierarchyIncomingCall }, index,
        { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const items = [];
    // Command-based editor tests drop opaque item data. Retain it here as
    // the Call Hierarchy UI does when requesting incoming calls.
    for (const [prototypeLine, callLine] of [[2, 7], [3, 8]]) {
        const prepared = await features.callHierarchy.prepareCallHierarchy(header, { line: prototypeLine, character: "Declare Operator C".length });
        assert.equal(prepared.length, 1);
        items.push(prepared[0]);
        const incoming = await features.callHierarchy.provideCallHierarchyIncomingCalls(prepared[0]);
        assert.deepEqual(incoming.flatMap((call) => call.fromRanges.map((range) => range.start.line)), [callLine],
            "retained editor item data must resolve the selected CAST result type");
    }
    assert.notEqual(items[0].data.implicitCallEntryId, items[1].data.implicitCallEntryId);
});

for (const namespaced of [false, true]) for (const operator of ["+", "Cast", "[]"]) test(`operator navigation keeps connected declarations and exact overloads (${operator}, namespace=${namespaced})`, async () => {
    class SemanticTokensLegend { constructor() {} }
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    class CallHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); }
    }
    class CallHierarchyOutgoingCall { constructor(to, fromRanges) { Object.assign(this, { to, fromRanges }); } }
    const prototype = operator === "+"
        ? "Declare Operator +(ByRef value As OperatorRecord, ByVal other As Long) As OperatorRecord"
        : operator === "Cast" ? "Declare Operator Cast() As Long" : "Declare Operator [](ByVal index As Long) ByRef As Long";
    const body = operator === "+"
        ? "Operator +(ByRef value As OperatorRecord, ByVal other As Long) As OperatorRecord\nObserveOperatorBody()\nReturn value\nEnd Operator\n"
        : operator === "Cast" ? "Operator OperatorRecord.Cast() As Long\nObserveOperatorBody()\nReturn number\nEnd Operator\n"
            : "Operator OperatorRecord.[](ByVal index As Long) ByRef As Long\nObserveOperatorBody()\nReturn number\nEnd Operator\n";
    const pointerPrototype = operator === "Cast" ? "Declare Operator Cast() As Long Ptr"
        : prototype.replace(/As Long\)/, "As Long Ptr)");
    const pointerBody = operator === "Cast" ? "Operator OperatorRecord.Cast() As Long Ptr\nObserveOperatorBody()\nReturn @number\nEnd Operator\n"
        : body.replace(/As Long\)/, "As Long Pointer)");
    const headerText = operator === "+" ? `Type OperatorRecord\nnumber As Long\nEnd Type\n${prototype}\n${pointerPrototype}\n`
        : `Type OperatorRecord\nnumber As Long\n${prototype}\n${pointerPrototype}\nEnd Type\n`;
    const bodyText = body + pointerBody + "Sub ObserveOperatorBody()\nEnd Sub\n";
    const prefix = namespaced ? "Namespace OperatorScope\n" : "", suffix = namespaced ? "End Namespace\n" : "";
    const sourceText = prefix + bodyText + suffix;
    const documents = [], inputs = [];
    for (const name of ["first", "second"]) {
        const header = createDocument(prefix + headerText + "Declare Sub ObserveOperatorBody()\n" + suffix), source = createDocument(sourceText);
        for (const [document, extension] of [[header, "bi"], [source, "bas"]]) {
            const filePath = `/workspace/${name}.${extension}`;
            document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
            documents.push(document);
            inputs.push({ uri: document.uri, parsed: parseFreeBasicText(document.getText()),
                includeUris: document === source ? new Set([header.uri.toString()]) : new Set() });
        }
    }
    const model = new FreeBasicSemanticModel(inputs);
    const index = { getParsedDocument: (document) => parseFreeBasicText(document.getText()),
        ensureInitialized: async () => true, getSemanticModel: () => model, getSourceSemanticModel: () => model };
    const vscode = { ...createVscodeMock(), SemanticTokensLegend, Location, CallHierarchyItem, CallHierarchyOutgoingCall };
    vscode.workspace.textDocuments = documents;
    const features = createSemanticFeatures(vscode, index,
        { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const prototypes = model.getDocument(documents[0].uri).entries.filter((entry) => entry.declaration.type === "operator");
    const bodies = model.getDocument(documents[1].uri).entries.filter((entry) => entry.declaration.type === "operator");
    for (let index = 0; index < prototypes.length; index++) {
        const declaration = prototypes[index].declaration, implementation = bodies[index].declaration;
        const declarations = await features.declaration.provideDeclaration(documents[1], { line: implementation.line, character: implementation.endColumn });
        assert.deepEqual(declarations.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [["/workspace/first.bi", declaration.line]]);
        for (const provider of [features.definition.provideDefinition, features.implementation.provideImplementation]) {
            const targets = await provider(documents[0], { line: declaration.line, character: declaration.endColumn });
            assert.deepEqual(targets.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [["/workspace/first.bas", implementation.line]]);
        }
        const hierarchy = await features.callHierarchy.prepareCallHierarchy(documents[0], { line: declaration.line, character: declaration.endColumn });
        assert.equal(hierarchy.length, 1);
        const outgoing = await features.callHierarchy.provideCallHierarchyOutgoingCalls(hierarchy[0]);
        assert.deepEqual(outgoing.map((call) => [call.to.uri.fsPath, call.to.name]), [["/workspace/first.bas", "ObserveOperatorBody"]],
            "an operator prototype must expose calls from its connected implementation, not an unrelated family");
    }
    const duplicate = createDocument(sourceText);
    duplicate.uri = { scheme: "file", fsPath: "/workspace/duplicate.bas", toString: () => "file:///workspace/duplicate.bas" };
    const ambiguous = new FreeBasicSemanticModel([...inputs, { uri: duplicate.uri, parsed: parseFreeBasicText(sourceText),
        includeUris: new Set([documents[0].uri.toString()]) }]);
    const ambiguousFeatures = createSemanticFeatures(vscode, { ...index, getSemanticModel: () => ambiguous, getSourceSemanticModel: () => ambiguous },
        { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const point = { line: prototypes[0].declaration.line, character: prototypes[0].declaration.endColumn };
    const prepared = await ambiguousFeatures.callHierarchy.prepareCallHierarchy(documents[0], point);
    assert.equal(prepared.length, 1);
    assert.deepEqual(await ambiguousFeatures.callHierarchy.provideCallHierarchyOutgoingCalls(prepared[0]), [],
        "two connected implementations must remain ambiguous");
});

test("stock-sidecar Type Definition uses the compiler-selected subtype location", async () => {
    class MarkdownString { constructor(value = "") { this.value = value; } }
    class Hover { constructor(contents) { this.contents = contents; } }
    class SemanticTokensLegend { constructor() {} }
    class Location {
        constructor(uri, range) { Object.assign(this, { uri, range }); }
    }

    const source = "Dim selectedValue As ParserVisibleType\n";
    const document = createDocument(source);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/type-definition.bas",
        toString: () => "file:///workspace/type-definition.bas"
    };
    const targetUri = {
        scheme: "file",
        fsPath: "/workspace/selected-type.bi",
        toString: () => "file:///workspace/selected-type.bi"
    };
    const queryRequests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queryRequests.push(operation);
            assert.equal(operation, "compilerSidecarTypeDefinition");
            return [{
                name: "CompilerSelectedType",
                uri: targetUri,
                declaration: {
                    name: "CompilerSelectedType",
                    type: "type",
                    line: 4,
                    startColumn: 5,
                    endColumn: 25
                }
            }];
        }
    };
    const modelRequests = [];
    let sourceModel = null;
    const workspaceIndex = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async (_document, _token, needTypes, needBindings, needMacroBindings) => {
                modelRequests.push([needTypes, needBindings, needMacroBindings]);
                return model;
            }
        },
        getSourceSemanticModel: () => sourceModel,
        isIncomplete: () => false,
        getParsedDocument() { assert.fail("exact sidecar type identity should return before source-name fallback"); },
        ensureInitialized() { assert.fail("exact sidecar type identity should return before source-name fallback"); }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        Location,
        MarkdownString,
        Hover,
        SemanticTokensLegend
    }, workspaceIndex, { keywords: [], types: [], operatorKeywords: [], constants: [] });

    const literalDocument = createDocument("Print 1\n");
    literalDocument.uri = {
        scheme: "file",
        fsPath: "/workspace/type-definition-literal.bas",
        toString: () => "file:///workspace/type-definition-literal.bas"
    };
    assert.deepEqual(await features.typeDefinition.provideTypeDefinition(literalDocument, { line: 0, character: 6 }), []);
    assert.deepEqual(modelRequests, [], "a numeric literal should not start stock-sidecar type-definition analysis");
    assert.deepEqual(queryRequests, []);

    const scalarDocument = createDocument("Dim scalarValue As Long\nPrint scalarValue\n");
    scalarDocument.uri = {
        scheme: "file",
        fsPath: "/workspace/type-definition-scalar.bas",
        toString: () => "file:///workspace/type-definition-scalar.bas"
    };
    sourceModel = {
        resolveAt: () => [{ declaration: { type: "variable", typeName: "Long" }, conditional: false, provisional: false }],
        typeEntries: () => []
    };
    assert.deepEqual(await features.typeDefinition.provideTypeDefinition(scalarDocument, { line: 1, character: 8 }), []);
    assert.deepEqual(modelRequests, [], "a known scalar variable should not start stock-sidecar type-definition analysis");
    assert.deepEqual(queryRequests, []);
    sourceModel = null;

    const definitions = await features.typeDefinition.provideTypeDefinition(
        document, { line: 0, character: source.indexOf("selectedValue") + 2 }
    );

    assert.deepEqual(modelRequests, [[true, true, false]],
        "stock-sidecar Type Definition should request physical bindings on demand");
    assert.deepEqual(queryRequests, ["compilerSidecarTypeDefinition"]);
    assert.deepEqual(definitions.map((entry) => [entry.uri.fsPath, entry.range.start.line,
        entry.range.start.character, entry.range.end.character]), [[
        targetUri.fsPath, 4, 5, 25
    ]]);
});

test("ordinary assignment avoids compiler operator binding work without Operator Let", () => {
    const text = "leftValue = rightValue\n";
    const document = createDocument(text);
    document.uri = { toString: () => "file:///workspace/main.bas" };
    const source = {
        lineOffsets: [0],
        root: { start: 0, end: text.length, children: [] },
        text,
        visibleDocuments: new Set(["main"])
    };
    const model = {
        entries: [],
        getDocument: () => source,
        members: () => [],
        resolveAt: () => [],
        typeEntries: () => []
    };
    const position = { line: 0, character: text.indexOf("=") };

    assert.equal(hasCompilerOperatorReceiptAt(model, document, position), false,
        "plain assignments should not request a full operator-binding sidecar");

    const aliasText = "leftValue => rightValue\n";
    const aliasDocument = createDocument(aliasText);
    aliasDocument.uri = document.uri;
    const aliasPosition = { line: 0, character: aliasText.indexOf("=>") + 1 };
    assert.equal(hasCompilerOperatorReceiptAt(model, aliasDocument, aliasPosition), false,
        "the => assignment alias should not be mistaken for overloaded equality without Operator Let");

    const valueType = { name: "AssignmentValue" };
    const letOperator = {
        declaration: { name: "Operator Let", type: "operator" },
        document: { key: "main" }
    };
    model.entries.push(letOperator);
    model.resolveAt = () => [{ declaration: { type: "variable" } }];
    model.typeEntries = () => [valueType];
    model.members = () => [letOperator];

    assert.equal(hasCompilerOperatorReceiptAt(model, document, position), true,
        "a visible Operator Let should request compiler-selected binding");

    const aliasSource = {
        lineOffsets: [0],
        root: { start: 0, end: aliasText.length, children: [] },
        text: aliasText,
        visibleDocuments: new Set(["main"])
    };
    const aliasModel = {
        entries: [letOperator],
        getDocument: () => aliasSource,
        members: () => [letOperator],
        resolveAt: () => [{ declaration: { type: "variable" } }],
        typeEntries: () => [valueType]
    };
    assert.equal(hasPotentialOperatorReceiptSyntaxAt(aliasDocument, aliasPosition), true,
        "the documented => assignment spelling should enter the receipt path");
    assert.equal(hasCompilerOperatorReceiptAt(aliasModel, aliasDocument, aliasPosition), true,
        "Operator Let detection should cover either character of =>");

    const wordText = "leftValue And rightValue\n";
    const wordDocument = createDocument(wordText);
    wordDocument.uri = document.uri;
    const wordSource = { visibleDocuments: new Set(["main"]) };
    const wordModel = { entries: [], getDocument: () => wordSource };
    const wordPosition = { line: 0, character: wordText.indexOf("And") + 1 };
    assert.equal(hasCompilerOperatorReceiptAt(wordModel, wordDocument, wordPosition), false,
        "built-in word operators should not request full operator-binding analysis without a candidate");
    wordModel.entries.push({
        declaration: { name: "Operator And", type: "operator" },
        document: { key: "main" }
    });
    assert.equal(hasCompilerOperatorReceiptAt(wordModel, wordDocument, wordPosition), true,
        "a visible word-operator overload should request its compiler receipt");
});

test("Operator Let candidate lookup follows the type of a member lvalue", () => {
    const text = "holder.value = sourceValue\n";
    const document = createDocument(text);
    document.uri = { toString: () => "file:///workspace/main.bas" };
    const valueType = { name: "AssignmentValue" };
    const holderType = { name: "AssignmentHolder" };
    const holder = { declaration: { type: "variable", name: "holder" } };
    const field = { declaration: { type: "field", name: "value" } };
    const letOperator = {
        declaration: { name: "Operator Let", type: "operator" },
        document: { key: "main" }
    };
    const source = {
        lineOffsets: [0],
        root: { start: 0, end: text.length, children: [] },
        text,
        visibleDocuments: new Set(["main"])
    };
    const fieldEnd = text.indexOf("value") + "value".length;
    const model = {
        entries: [letOperator],
        getDocument: () => source,
        resolveAt: (_uri, _line, character) => [character === fieldEnd - 1 ? field : holder],
        typeEntries: (entry) => [entry === field ? valueType : holderType],
        members: (types) => types[0] === valueType ? [letOperator] : []
    };

    assert.equal(hasCompilerOperatorReceiptAt(model, document, {
        line: 0,
        character: text.indexOf("=")
    }), true, "the field's UDT may select Operator Let even when its containing type does not");

    const indexedText = "holder.values(indexValue) = sourceValue\n";
    const indexedDocument = createDocument(indexedText);
    indexedDocument.uri = document.uri;
    const indexedSource = {
        lineOffsets: [0],
        root: { start: 0, end: indexedText.length, children: [] },
        text: indexedText,
        visibleDocuments: new Set(["main"])
    };
    const ordinaryField = { declaration: { type: "field", name: "values" } };
    const indexVariable = { declaration: { type: "variable", name: "indexValue" } };
    const indexStart = indexedText.indexOf("indexValue");
    const indexEnd = indexStart + "indexValue".length;
    const indexedModel = {
        entries: [letOperator],
        getDocument: () => indexedSource,
        resolveAt: (_uri, _line, character) => [
            character >= indexStart && character < indexEnd ? indexVariable
                : character >= indexedText.indexOf("values") && character < indexedText.indexOf("values") + 6
                    ? ordinaryField
                    : holder
        ],
        typeEntries: (entry) => [entry === indexVariable ? valueType : holderType],
        members: (types) => types[0] === valueType ? [letOperator] : []
    };
    assert.equal(hasCompilerOperatorReceiptAt(indexedModel, indexedDocument, {
        line: 0,
        character: indexedText.indexOf("=")
    }), false, "an Operator Let on an index argument must not make an ordinary array write a candidate");
});

test("source operator indexing is reserved for operator-shaped cursor positions", () => {
    const document = createDocument([
        "Print value",
        "value = other",
        "    Declare Operator Let(ByRef source As Value)"
    ].join("\n"));
    const positions = [
        { line: 0, character: "Print ".length },
        { line: 1, character: "value ".length },
        { line: 2, character: "    Declare Operator ".length + 1 }
    ];

    assert.equal(hasPotentialOperatorReceiptSyntaxAt(document, positions[0]), false,
        "ordinary symbol hovers should not construct the source operator index");
    assert.equal(hasPotentialOperatorReceiptSyntaxAt(document, positions[1]), true,
        "an assignment token remains a candidate site for overloaded assignment");
    assert.equal(hasPotentialOperatorReceiptSyntaxAt(document, positions[2]), true,
        "operator declarations remain candidate sites for source-family queries");
});

test("compound-assignment spellings qualify compiler operator receipt lookup", () => {
    const visible = { visibleDocuments: new Set(["main"]) };
    const model = { entries: [], getDocument: () => visible };
    const symbol = (name) => ({
        declaration: { type: "operator", name: `Operator ${name}` },
        document: { key: "main" }
    });
    const documentFor = (operator, word = false) => {
        const document = createDocument(`current ${operator} 7\n`);
        document.uri = { toString: () => "file:///workspace/main.bas" };
        const start = document.getText().indexOf(operator);
        return { document, position: { line: 0, character: start + (word ? 1 : 0) } };
    };
    for (const [sourceOperator, declarationOperator] of [
        ["+=", "+="], ["+=>", "+="], ["-=", "-="], ["-=>", "-="],
        ["*=", "*="], ["*=>", "*="], ["/=", "/="], ["/=>", "/="],
        ["\\=", "\\="], ["\\=>", "\\="], ["^=", "^="], ["^=>", "^="],
        ["&=", "&="], ["&=>", "&="]
    ]) {
        const { document, position } = documentFor(sourceOperator);
        model.entries = [symbol(declarationOperator)];
        assert.equal(isOperatorTokenAt(document, position), true, sourceOperator);
        assert.equal(hasPotentialOperatorReceiptSyntaxAt(document, position), true, sourceOperator);
        assert.equal(hasCompilerOperatorReceiptAt(model, document, position), true, sourceOperator);
    }
    for (const [sourceOperator, declarationOperator] of [
        ["And=", "And="], ["And=>", "And="], ["AndAlso=", "AndAlso="], ["AndAlso=>", "AndAlso="],
        ["Mod=", "Mod="], ["Mod=>", "Mod="], ["Shl=", "Shl="], ["Shl=>", "Shl="],
        ["Eqv=", "Eqv="], ["Eqv=>", "Eqv="]
    ]) {
        const { document, position } = documentFor(sourceOperator, true);
        model.entries = [symbol(declarationOperator)];
        assert.equal(isOperatorTokenAt(document, position), true, sourceOperator);
        assert.equal(hasPotentialOperatorReceiptSyntaxAt(document, position), true, sourceOperator);
        assert.equal(hasCompilerOperatorReceiptAt(model, document, position), true, sourceOperator);
    }
});

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

test("stock FBC sidecar configuration preserves the parsed document Outline", async () => {
    const source = [
        "'' @deprecated Use CurrentOutlineExample instead.",
        "Sub OutlineExample()",
        "    Print 1",
        "End Sub",
        "'' Keep this note separate from the next declaration.",
        "",
        "'' Returns the current Outline value.",
        "Sub CurrentOutlineExample()",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/outline.bas",
        toString: () => "file:///workspace/outline.bas"
    };
    const parsed = parseFreeBasicText(source);
    const analysisCalls = [];
    const workspaceIndex = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            isConfigured: () => { analysisCalls.push("configured"); return true; },
            getModel: () => { analysisCalls.push("model"); return null; },
            async check() { analysisCalls.push("check"); return false; }
        },
        getParsedDocument: () => parsed
    };
    const provider = createDocumentSymbolProvider(createVscodeMock(), workspaceIndex);
    const symbols = await provider.provideDocumentSymbols(document);

    assert.deepEqual(symbols.map((symbol) => symbol.name), ["OutlineExample", "CurrentOutlineExample"]);
    assert.deepEqual(symbols[0].tags, [1], "a leading @deprecated doc tag should mark the stock-sidecar Outline entry");
    assert.equal(symbols[1].tags, undefined, "prose documentation without @deprecated should not mark the declaration deprecated");
    assert.match(symbols[1].detail, /Returns the current Outline value\./);
    assert.deepEqual(analysisCalls, ["model"],
        "Outline may inspect a cached model but must not configure or start compiler analysis");
});

test("stock-sidecar Outline includes explicit variables masked by the source comment boundary", async () => {
    const source = [
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub OutlineRemIdentifierProbe()",
        "    Dim REM As Integer",
        "    Print REM",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/outline-conditional-rem.bas",
        toString: () => "file:///workspace/outline-conditional-rem.bas"
    };
    const parsed = parseFreeBasicText(source);
    assert.equal(parsed.declarations.some((declaration) => declaration.name === "REM"), false);
    const declarationLine = 4;
    const declarationColumn = source.split("\n")[declarationLine].indexOf("REM");
    const queryCalls = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queryCalls.push(operation);
            if (operation === "compilerSidecarOutlineFactsAtSites") return [];
            assert.equal(operation, "compilerSidecarOutlineMaskedVariables");
            return [{
                id: "sidecar:1",
                name: "REM",
                uri: { scheme: "file", fsPath: document.uri.fsPath, path: document.uri.fsPath },
                declaration: {
                    name: "REM",
                    type: "variable",
                    detail: "Variable As integer",
                    typeName: "integer",
                    signature: "variable REM As integer",
                    line: declarationLine,
                    startColumn: declarationColumn,
                    endColumn: declarationColumn + 3,
                    modifiers: [],
                    parameters: []
                },
                compilerFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    compilerStorageClass: "local"
                }
            }];
        }
    };
    const provider = createDocumentSymbolProvider(createVscodeMock(), {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline must not start compiler analysis"); }
        },
        getParsedDocument: () => parsed
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const procedure = symbols.find((symbol) => symbol.name === "OutlineRemIdentifierProbe");
    const maskedVariable = procedure?.children.find((symbol) => symbol.name === "REM");
    assert.ok(maskedVariable, "the compiler-bound declaration should appear in its procedure Outline");
    assert.equal(maskedVariable.selectionRange.start.line, declarationLine);
    assert.equal(maskedVariable.selectionRange.start.character, declarationColumn);
    assert.match(maskedVariable.detail, /As Integer/);
    assert.match(maskedVariable.detail, /storage: local/);
    assert.ok(queryCalls.includes("compilerSidecarOutlineMaskedVariables"));
});

test("editor-bridge Outline requests bindings for identifiers masked by conditional NOKEYWORD", async () => {
    const source = [
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub BridgeRemOutlineProbe()",
        "    Dim REM As Integer",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/bridge-rem-outline.bas",
        toString: () => "file:///workspace/bridge-rem-outline.bas" };
    const requests = [];
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "documentSymbols");
            return [{
                index: 0,
                parent: null,
                name: "BridgeRemOutlineProbe",
                type: "sub",
                detail: "Sub",
                range: { start: { line: 3, character: 0 }, end: { line: 5, character: 7 } },
                selection: { start: { line: 3, character: 4 }, end: { line: 3, character: 26 } }
            }, {
                index: 1,
                parent: 0,
                name: "REM",
                type: "variable",
                detail: "Variable As Integer",
                range: { start: { line: 4, character: 8 }, end: { line: 4, character: 25 } },
                selection: { start: { line: 4, character: 8 }, end: { line: 4, character: 11 } }
            }];
        }
    };
    const provider = createDocumentSymbolProvider({ ...createVscodeMock(), Range }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ compilerPath: "/compiler/fbc-editor", semanticModelOnly: false }),
            isConfigured: () => true,
            getModel: () => null,
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            },
            async check() { assert.fail("Outline already requested a binding-capable bridge model"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const procedure = symbols.find((symbol) => symbol.name === "BridgeRemOutlineProbe");
    assert.ok(procedure?.children.some((symbol) => symbol.name === "REM"));
    assert.deepEqual(requests, [[false, true]]);
});

test("cached stock-sidecar base type facts enrich the parser Outline", async () => {
    const source = "Type SidecarDerived Extends SidecarBase\nEnd Type\n";
    const document = createDocument(source);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/sidecar-base-type.bas",
        toString: () => "file:///workspace/sidecar-base-type.bas"
    };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            requests.push(operation);
            assert.equal(operation, "compilerSidecarOutlineFactsAtSites");
            return input.sites.map((site) => ({
                index: site.index,
                compilerFacts: { baseType: "SidecarBase" }
            }));
        }
    };
    const workspaceIndex = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model
        },
        getParsedDocument: () => parseFreeBasicText(source)
    };
    const symbols = await createDocumentSymbolProvider(createVscodeMock(), workspaceIndex)
        .provideDocumentSymbols(document);

    assert.equal(symbols.length, 1);
    assert.match(symbols[0].detail, /extends SidecarBase/);
    assert.deepEqual(requests, ["compilerSidecarOutlineFactsAtSites"]);
});

test("cached stock-sidecar compiler constants enrich the parser Outline without launching analysis", async () => {
    class DocumentSymbol {
        constructor(name, detail, kind, range, selectionRange) {
            Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
        }
    }
    const source = [
        "Const SidecarAnswer As Integer = 42",
        "Enum SidecarOutlineEnum",
        "    FirstCode = 10",
        "    NextCode",
        "End Enum",
        "Dim SidecarImplicitValue",
        "Dim SidecarBoundedArray(0 To 4) As Integer",
        "Dim SidecarDefaultText As String",
        "Dim SidecarInitializedText As String = \"Hello\"",
        "Type SidecarOutlineFields",
        "    Private:",
        "    privateField As Integer",
        "    Public:",
        "    publicField As Integer",
        "End Type",
        "Type SidecarOutlineAggregate",
        "    firstValue As Integer",
        "    secondValue As Integer",
        "End Type",
        "Declare Function OutlineAbiProbe Cdecl() As Integer",
        "Function OutlineVisibilityProbe() As Integer",
        "    Return 1",
        "End Function",
        "Type OutlineOverrideBase",
        "    Declare Virtual Sub Visit()",
        "End Type",
        "Type OutlineOverrideDerived Extends OutlineOverrideBase",
        "    Declare Sub Visit() Override",
        "End Type",
        "Sub OutlineExample()",
        "End Sub",
        "Sub OutlineParameterProbe(implicitParameter)",
        "End Sub",
        "Sub OutlineExplicitParameterProbe(ByVal explicitParameter As Integer)",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/outline-constant.bas",
        toString: () => "file:///workspace/outline-constant.bas" };
    const sourceLines = source.split("\n");
    const constantSites = ["SidecarAnswer", "FirstCode", "NextCode"].map((name, index) => {
        const line = sourceLines.findIndex((sourceLine) => sourceLine.includes(name));
        const startColumn = sourceLines[line].indexOf(name);
        return { index, filePath: document.uri.fsPath, line, startColumn, endColumn: startColumn + name.length };
    });
    const queryCalls = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { sites }) {
            queryCalls.push(operation);
            if (operation === "compilerSidecarConstantsAtSites") {
                assert.deepEqual(sites, constantSites);
                return sites.map((site) => ({
                    index: site.index,
                    kind: "signed",
                    value: ["42", "10", "11"][site.index]
                }));
            }
            assert.equal(operation, "compilerSidecarOutlineFactsAtSites");
            assert.deepEqual(sites.map((site) => source.split("\n")[site.line]
                .slice(site.startColumn, site.endColumn)), [
                "FirstCode", "NextCode",
                "SidecarImplicitValue", "SidecarBoundedArray", "SidecarDefaultText", "SidecarInitializedText",
                "SidecarOutlineFields", "privateField", "publicField",
                "SidecarOutlineAggregate", "firstValue", "secondValue",
                "OutlineAbiProbe", "OutlineVisibilityProbe", "OutlineOverrideBase", "Visit",
                "OutlineOverrideDerived", "Visit", "OutlineExample", "OutlineParameterProbe",
                "implicitParameter", "OutlineExplicitParameterProbe", "explicitParameter"
            ]);
            return sites.map((site) => {
                const sourceLine = source.split("\n")[site.line];
                const declarationName = sourceLine.slice(site.startColumn, site.endColumn);
                const compilerFacts = {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                };
                if (declarationName === "implicitParameter") {
                    Object.assign(compilerFacts, {
                        formalWrittenTypes: ["implicit"],
                        parameterPassing: { mode: "byref", dimensions: 0, optional: false, receiver: false },
                        properties: [{ name: "formal-written-mode", value: "0" }]
                    });
                } else if (declarationName === "explicitParameter") {
                    Object.assign(compilerFacts, {
                        formalWrittenTypes: ["as"],
                        parameterPassing: { mode: "byval", dimensions: 0, optional: false, receiver: false }
                    });
                } else if (declarationName === "SidecarBoundedArray") {
                    Object.assign(compilerFacts, {
                        formalWrittenTypes: ["as"],
                        arrayBounds: {
                            mode: "bounds", rank: 1,
                            dimensions: [{ dimension: 0, lower: 0, kind: "fixed", upper: 4 }]
                        },
                        properties: [{ name: "array-elements", value: "5" }]
                    });
                } else if (declarationName === "SidecarDefaultText") {
                    compilerFacts.scalarStringDeclaration = {
                        statement: 1, expression: 0, kind: "dim", initializerValue: null, provisional: false
                    };
                } else if (declarationName === "SidecarInitializedText") {
                    compilerFacts.scalarStringDeclaration = {
                        statement: 2, expression: 1, kind: "dim",
                        initializerValue: { kind: "bytes", value: "48656C6C6F" }, provisional: false
                    };
                } else if (declarationName === "FirstCode") {
                    compilerFacts.enumElementInput = { explicit: true, ordinal: 1 };
                } else if (declarationName === "NextCode") {
                    compilerFacts.enumElementInput = { explicit: false, ordinal: 2 };
                } else if (declarationName === "privateField") {
                    Object.assign(compilerFacts, { fieldLayout: { byteOffset: 0 }, compilerVisibility: "private" });
                } else if (declarationName === "publicField") {
                    Object.assign(compilerFacts, { fieldLayout: { byteOffset: 4 }, compilerVisibility: "public" });
                } else if ([
                    "SidecarOutlineFields", "SidecarOutlineAggregate", "OutlineOverrideBase", "OutlineOverrideDerived"
                ].includes(declarationName)) {
                    Object.assign(compilerFacts, {
                        aggregateSizeBytes: 8,
                        abstractMemberCount: 0,
                        properties: [
                            { name: "natural-alignment", value: "4" },
                            { name: "packing-alignment", value: "4" }
                        ]
                    });
                } else if (declarationName === "firstValue") {
                    Object.assign(compilerFacts, { fieldLayout: { byteOffset: 0 }, compilerVisibility: "public" });
                } else if (declarationName === "secondValue") {
                    Object.assign(compilerFacts, { fieldLayout: { byteOffset: 4 }, compilerVisibility: "public" });
                } else if (declarationName === "OutlineAbiProbe") {
                    Object.assign(compilerFacts, {
                        procedureCallingConvention: "cdecl",
                        procedureReturnsByReference: false,
                        procedureAbiPolicyInputs: [{ writtenConvention: true, managedString: false, provisional: false }],
                        properties: [{ name: "procedure-linkage", value: "c" }]
                    });
                } else if (declarationName === "OutlineVisibilityProbe") {
                    Object.assign(compilerFacts, {
                        procedureCallingConvention: "basic",
                        procedureReturnsByReference: false,
                        compilerVisibility: "private",
                        procedureWrittenVisibility: [{ statement: 1, visibility: "default", provisional: false }],
                        procedureTypingInputs: [{
                            statement: 1, role: "definition", kind: "function", resultForm: "as", provisional: false
                        }]
                    });
                } else if (declarationName === "Visit") {
                    Object.assign(compilerFacts, {
                        procedureCallingConvention: "basic",
                        procedureReturnsByReference: false,
                        ...(sourceLine.includes("Override")
                            ? { overriddenProcedure: { compilerSymbolId: 73 } } : {}),
                        properties: [{ name: "procedure-linkage", value: "basic" }]
                    });
                } else if ([
                    "OutlineExample", "OutlineParameterProbe", "OutlineExplicitParameterProbe"
                ].includes(declarationName)) {
                    Object.assign(compilerFacts, {
                        procedureCallingConvention: "basic",
                        procedureReturnsByReference: false,
                        properties: [{ name: "procedure-linkage", value: "basic" }]
                    });
                } else {
                    compilerFacts.declarationInputs = [{ writtenType: "implicit" }];
                }
                return { index: site.index, compilerFacts };
            });
        }
    };
    const provider = createDocumentSymbolProvider({
        ...createVscodeMock(),
        DocumentSymbol
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline must not start a compiler request"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const answer = symbols.find((symbol) => symbol.name === "SidecarAnswer");
    assert.ok(answer);
    assert.match(answer.detail, /compiler value: 42/i);
    const outlineEnum = symbols.find((symbol) => symbol.name === "SidecarOutlineEnum");
    assert.match(outlineEnum?.children.find((symbol) => symbol.name === "FirstCode")?.detail || "",
        /compiler value: 10/);
    assert.match(outlineEnum?.children.find((symbol) => symbol.name === "NextCode")?.detail || "",
        /compiler-assigned enum value.*compiler value: 11/);
    const implicitValue = symbols.find((symbol) => symbol.name === "SidecarImplicitValue");
    assert.ok(implicitValue);
    assert.match(implicitValue.detail, /As Integer \(implicit type\)/);
    const boundedArray = symbols.find((symbol) => symbol.name === "SidecarBoundedArray");
    assert.ok(boundedArray);
    assert.match(boundedArray.detail, /bounds: 0 to 4; 5 elements; element storage: 20 bytes/);
    assert.match(symbols.find((symbol) => symbol.name === "SidecarDefaultText")?.detail || "",
        /default String initialization/);
    assert.match(symbols.find((symbol) => symbol.name === "SidecarInitializedText")?.detail || "",
        /String initializer: bytes 0x48656C6C6F.*Hello/);
    const outlineFields = symbols.find((symbol) => symbol.name === "SidecarOutlineFields");
    const privateField = outlineFields?.children.find((symbol) => symbol.name === "privateField");
    const publicField = outlineFields?.children.find((symbol) => symbol.name === "publicField");
    assert.match(privateField?.detail || "", /offset: 0 bytes.*Private access/);
    assert.match(publicField?.detail || "", /offset: 4 bytes.*Public access/);
    const outlineAggregate = symbols.find((symbol) => symbol.name === "SidecarOutlineAggregate");
    assert.match(outlineAggregate?.detail || "", /layout: size: 8 bytes, alignment: 4 bytes, packing: 4 bytes/);
    assert.match(symbols.find((symbol) => symbol.name === "OutlineAbiProbe")?.detail || "", /ABI: C linkage, cdecl/);
    assert.match(symbols.find((symbol) => symbol.name === "OutlineVisibilityProbe")?.detail || "", /Private by scope default/);
    const overrideType = symbols.find((symbol) => symbol.name === "OutlineOverrideDerived");
    assert.match(overrideType?.children.find((symbol) => symbol.name === "Visit")?.detail || "",
        /overrides compiler-selected base method/);
    const outlineProcedure = symbols.find((symbol) => symbol.name === "OutlineParameterProbe");
    const outlineParameter = outlineProcedure?.children.find((symbol) => symbol.name === "implicitParameter");
    assert.ok(outlineParameter);
    assert.match(outlineParameter.detail, /As Integer \(implicit type\)/);
    assert.match(outlineParameter.detail, /passing: ByRef \(keyword omitted\)/);
    const explicitProcedure = symbols.find((symbol) => symbol.name === "OutlineExplicitParameterProbe");
    const explicitParameter = explicitProcedure?.children.find((symbol) => symbol.name === "explicitParameter");
    assert.ok(explicitParameter);
    assert.match(explicitParameter.detail, /passing: ByVal/);
    assert.doesNotMatch(explicitParameter.detail, /\(implicit type\)|\(inferred type\)/);
    assert.deepEqual(queryCalls.sort(), ["compilerSidecarConstantsAtSites", "compilerSidecarOutlineFactsAtSites"]);
});

test("cached stock-sidecar Outline includes compiler-created implicit locals", async () => {
    class DocumentSymbol {
        constructor(name, detail, kind, range, selectionRange) {
            Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
        }
    }
    const source = "#lang \"fblite\"\nPrint implicitModuleOutlineValue\nSub OutlineImplicitLocalProbe()\n    Input \"Value: \"; implicitOutlineValue\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/outline-implicit-local.bas",
        toString: () => "file:///workspace/outline-implicit-local.bas" };
    const name = "implicitOutlineValue";
    const moduleName = "implicitModuleOutlineValue";
    const moduleLine = 1;
    const moduleStartColumn = source.split("\n")[moduleLine].indexOf(moduleName);
    const procedureLine = 3;
    const startColumn = source.split("\n")[procedureLine].indexOf(name);
    const queryCalls = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { sites } = {}) {
            queryCalls.push(operation);
            if (operation === "compilerSidecarOutlineFactsAtSites") {
                assert.deepEqual(sites.map((site) => [site.line, source.split("\n")[site.line]
                    .slice(site.startColumn, site.endColumn)]), [[2, "OutlineImplicitLocalProbe"]]);
                return [{
                    index: 0,
                    compilerFacts: {
                        procedureCallingConvention: "basic",
                        procedureReturnsByReference: false,
                        properties: [{ name: "procedure-linkage", value: "basic" }]
                    }
                }];
            }
            assert.equal(operation, "compilerSidecarOutlineImplicitVariables");
            return [{
                name,
                line: procedureLine,
                startColumn,
                endColumn: startColumn + name.length,
                storageClass: "local",
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }, {
                name: moduleName,
                line: moduleLine,
                startColumn: moduleStartColumn,
                endColumn: moduleStartColumn + moduleName.length,
                storageClass: "local",
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }];
        }
    };
    const provider = createDocumentSymbolProvider({ ...createVscodeMock(), DocumentSymbol }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline must use only the already cached semantic model"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const moduleVariable = symbols.find((symbol) => symbol.name === moduleName);
    assert.ok(moduleVariable);
    assert.match(moduleVariable.detail, /As Integer \(implicit type\).+storage: local/);
    assert.equal(moduleVariable.selectionRange.start.line, moduleLine);
    const procedure = symbols.find((symbol) => symbol.name === "OutlineImplicitLocalProbe");
    const implicitLocal = procedure?.children.find((symbol) => symbol.name === name);
    assert.ok(implicitLocal);
    assert.match(implicitLocal.detail, /As Integer \(implicit type\).+storage: local/);
    assert.equal(implicitLocal.selectionRange.start.line, procedureLine);
    assert.equal(implicitLocal.selectionRange.start.character, startColumn);
    assert.deepEqual(queryCalls.sort(), [
        "compilerSidecarOutlineFactsAtSites", "compilerSidecarOutlineImplicitVariables"
    ]);
});

test("cached stock-sidecar Outline includes a compiler-created compound-assignment local", async () => {
    class DocumentSymbol {
        constructor(name, detail, kind, range, selectionRange) {
            Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
        }
    }
    const source = "Sub CompoundOutlineProbe()\n    implicitCompoundValue += 1\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/compound-outline.bas",
        toString: () => "file:///workspace/compound-outline.bas" };
    const name = "implicitCompoundValue";
    const line = 1;
    const startColumn = source.split("\n")[line].indexOf(name);
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input = {}) {
            requests.push(operation);
            if (operation === "compilerSidecarOutlineFactsAtSites") {
                assert.deepEqual(input.sites.map((site) => [site.line,
                    source.split("\n")[site.line].slice(site.startColumn, site.endColumn)]), [
                    [0, "CompoundOutlineProbe"]
                ]);
                return [];
            }
            assert.equal(operation, "compilerSidecarOutlineImplicitVariables");
            return [{
                name,
                line,
                startColumn,
                endColumn: startColumn + name.length,
                storageClass: "local",
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }];
        }
    };
    const provider = createDocumentSymbolProvider({ ...createVscodeMock(), DocumentSymbol }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline should use only the already cached sidecar model"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const procedure = symbols.find((symbol) => symbol.name === "CompoundOutlineProbe");
    const implicitLocal = procedure?.children.find((symbol) => symbol.name === name);
    assert.ok(implicitLocal);
    assert.match(implicitLocal.detail, /As Integer \(implicit type\).+storage: local/);
    assert.deepEqual(requests.sort(), [
        "compilerSidecarOutlineFactsAtSites", "compilerSidecarOutlineImplicitVariables"
    ]);
});

test("cached stock-sidecar Outline includes compiler-created SWAP locals", async () => {
    class DocumentSymbol {
        constructor(name, detail, kind, range, selectionRange) {
            Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
        }
    }
    const source = "Sub SwapOutlineProbe()\n    Swap implicitSwapFirst, implicitSwapSecond\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/swap-outline.bas",
        toString: () => "file:///workspace/swap-outline.bas" };
    const line = 1;
    const sourceLine = source.split("\n")[line];
    const names = ["implicitSwapFirst", "implicitSwapSecond"];
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input = {}) {
            requests.push(operation);
            if (operation === "compilerSidecarOutlineFactsAtSites") return [];
            assert.equal(operation, "compilerSidecarOutlineImplicitVariables");
            return names.map((name) => ({
                name,
                line,
                startColumn: sourceLine.indexOf(name),
                endColumn: sourceLine.indexOf(name) + name.length,
                storageClass: "local",
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }));
        }
    };
    const provider = createDocumentSymbolProvider({ ...createVscodeMock(), DocumentSymbol }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline should use only the cached sidecar model"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const procedure = symbols.find((symbol) => symbol.name === "SwapOutlineProbe");
    assert.deepEqual(procedure?.children.map((symbol) => [symbol.name, symbol.detail]), names.map((name) => [
        name, "Variable As Integer (implicit type) (storage: local)"
    ]));
    assert.deepEqual(requests.sort(), [
        "compilerSidecarOutlineFactsAtSites", "compilerSidecarOutlineImplicitVariables"
    ]);
});

test("cached stock-sidecar Outline includes implicit LSET and RSET locals", async () => {
    class DocumentSymbol {
        constructor(name, detail, kind, range, selectionRange) {
            Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
        }
    }
    const source = [
        "DefStr I",
        "Sub StringWriteOutlineProbe()",
        '    LSet implicitLeftText = "left"',
        '    RSet implicitRightText = "right"',
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/lset-rset-outline.bas",
        toString: () => "file:///workspace/lset-rset-outline.bas" };
    const lines = source.split("\n");
    const names = ["implicitLeftText", "implicitRightText"];
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input = {}) {
            requests.push(operation);
            if (operation === "compilerSidecarOutlineFactsAtSites") return [];
            assert.equal(operation, "compilerSidecarOutlineImplicitVariables");
            return names.map((name, index) => ({
                name,
                line: index + 2,
                startColumn: lines[index + 2].indexOf(name),
                endColumn: lines[index + 2].indexOf(name) + name.length,
                storageClass: "local",
                storageType: { primitive: "string", storageBytes: 12, pointerDepth: 0, isReference: false }
            }));
        }
    };
    const provider = createDocumentSymbolProvider({ ...createVscodeMock(), DocumentSymbol }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline should use only the cached sidecar model"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const procedure = symbols.find((symbol) => symbol.name === "StringWriteOutlineProbe");
    assert.deepEqual(procedure?.children.map((symbol) => [symbol.name, symbol.detail]), names.map((name) => [
        name, "Variable As String (implicit type) (storage: local)"
    ]));
    assert.deepEqual(requests.sort(), [
        "compilerSidecarOutlineFactsAtSites", "compilerSidecarOutlineImplicitVariables"
    ]);
});

test("cached stock-sidecar Outline includes an implicit GET destination", async () => {
    class DocumentSymbol {
        constructor(name, detail, kind, range, selectionRange) {
            Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
        }
    }
    const source = "Sub GetOutlineProbe()\n    Get #1, , implicitGetValue\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/get-outline.bas",
        toString: () => "file:///workspace/get-outline.bas" };
    const name = "implicitGetValue";
    const line = 1;
    const startColumn = source.split("\n")[line].indexOf(name);
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            requests.push(operation);
            if (operation === "compilerSidecarOutlineFactsAtSites") return [];
            assert.equal(operation, "compilerSidecarOutlineImplicitVariables");
            return [{
                name,
                line,
                startColumn,
                endColumn: startColumn + name.length,
                storageClass: "local",
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }];
        }
    };
    const provider = createDocumentSymbolProvider({ ...createVscodeMock(), DocumentSymbol }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline should use only the cached sidecar model"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const procedure = symbols.find((symbol) => symbol.name === "GetOutlineProbe");
    const target = procedure?.children.find((symbol) => symbol.name === name);
    assert.ok(target);
    assert.match(target.detail, /As Integer \(implicit type\).+storage: local/);
    assert.deepEqual(requests.sort(), [
        "compilerSidecarOutlineFactsAtSites", "compilerSidecarOutlineImplicitVariables"
    ]);
});

test("cached stock-sidecar Outline shows the compiler type of a new REDIM array", async () => {
    class DocumentSymbol {
        constructor(name, detail, kind, range, selectionRange) {
            Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
        }
    }
    const source = "Sub RedimOutlineProbe()\n    ReDim implicitArray(0 To 2)\n    ReDim Preserve implicitPreservedArray(0 To 2)\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/redim-outline.bas",
        toString: () => "file:///workspace/redim-outline.bas" };
    const queryCalls = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { sites }) {
            queryCalls.push(operation);
            assert.equal(operation, "compilerSidecarOutlineFactsAtSites");
            const redimSites = sites.filter((site) => ["implicitArray", "implicitPreservedArray"].includes(
                source.split("\n")[site.line].slice(site.startColumn, site.endColumn)
            ));
            assert.equal(redimSites.length, 2,
                "Outline enrichment should include both physical REDIM declaration sites");
            return redimSites.map((site) => ({
                index: site.index,
                compilerFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    compilerStorageClass: "local",
                    properties: []
                }
            }));
        }
    };
    const provider = createDocumentSymbolProvider({ ...createVscodeMock(), DocumentSymbol }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline should use only the already cached semantic model"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    const procedure = symbols.find((symbol) => symbol.name === "RedimOutlineProbe");
    const array = procedure?.children.find((symbol) => symbol.name === "implicitArray");
    const preservedArray = procedure?.children.find((symbol) => symbol.name === "implicitPreservedArray");
    assert.ok(array);
    assert.match(array.detail, /As Integer \(implicit type\).+storage: local/);
    assert.ok(preservedArray);
    assert.match(preservedArray.detail, /As Integer \(implicit type\).+storage: local/);
    assert.deepEqual(queryCalls, ["compilerSidecarOutlineFactsAtSites"]);
});

test("cached stock-sidecar Outline bounds declaration detail queries on large files", async () => {
    class DocumentSymbol {
        constructor(name, detail, kind, range, selectionRange) {
            Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
        }
    }
    const source = Array.from({ length: 257 }, (_, index) =>
        `Dim SidecarBoundedSite${String(index).padStart(3, "0")}`
    ).join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/outline-bounded-sites.bas",
        toString: () => "file:///workspace/outline-bounded-sites.bas" };
    const batches = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { sites }) {
            assert.equal(operation, "compilerSidecarOutlineFactsAtSites");
            batches.push(sites.length);
            return sites.map((site) => ({
                index: site.index,
                compilerFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    declarationInputs: [{ writtenType: "implicit" }]
                }
            }));
        }
    };
    const provider = createDocumentSymbolProvider({ ...createVscodeMock(), DocumentSymbol }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor() { assert.fail("Outline must not start a compiler request"); }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const symbols = await provider.provideDocumentSymbols(document);
    assert.equal(symbols.length, 257);
    assert.match(symbols[0].detail, /As Integer \(implicit type\)/);
    assert.match(symbols[255].detail, /As Integer \(implicit type\)/);
    assert.doesNotMatch(symbols[256].detail, /As Integer/);
    assert.deepEqual(batches, [64, 64, 64, 64], "site queries stay within the declared total and per-batch bounds");
});

test("compiler-backed Outline marks documented deprecated declarations", async () => {
    const document = createDocument("Sub OldApi()\nEnd Sub\nSub CurrentApi()\nEnd Sub\n");
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/deprecated-outline.bas",
        toString: () => "file:///workspace/deprecated-outline.bas"
    };
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "documentSymbols");
            return [
                {
                    index: 0, parent: null, name: "OldApi", type: "sub", detail: "Sub",
                    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 7 } },
                    selection: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
                    deprecated: true
                },
                {
                    index: 1, parent: null, name: "CurrentApi", type: "sub", detail: "Sub",
                    range: { start: { line: 2, character: 0 }, end: { line: 3, character: 7 } },
                    selection: { start: { line: 2, character: 4 }, end: { line: 2, character: 14 } },
                    deprecated: false
                }
            ];
        }
    };
    const provider = createDocumentSymbolProvider(createVscodeMock(), {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            isConfigured: () => true,
            getModel: () => model
        }
    });
    const symbols = await provider.provideDocumentSymbols(document);

    assert.deepEqual(symbols[0].tags, [1]);
    assert.equal(symbols[1].tags, undefined);
});

test("workspace symbols retain deprecation tags from compiler indexing", async () => {
    class SymbolInformation {
        constructor(name, kind, containerName, location) { Object.assign(this, { name, kind, containerName, location }); }
    }
    class Location {
        constructor(uri, range) { Object.assign(this, { uri, range }); }
    }
    const base = createVscodeMock();
    const oldUri = { scheme: "file", fsPath: "/workspace/old.bas" };
    const currentUri = { scheme: "file", fsPath: "/workspace/current.bas" };
    const provider = createWorkspaceSymbolProvider({
        ...base,
        SymbolInformation,
        Location,
        SymbolTag: { Deprecated: 1 },
        workspace: { ...base.workspace, workspaceFolders: [] }
    }, {
        compilerAnalysis: {
            async workspaceSymbols() {
                return {
                    roots: new Set(),
                    symbols: [
                        { name: "OldApi", type: "function", containerName: "", uri: oldUri,
                            selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, deprecated: true },
                        { name: "CurrentApi", type: "function", containerName: "", uri: currentUri,
                            selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, deprecated: false }
                    ]
                };
            }
        },
        async ensureInitialized() { return true; },
        getAllDeclarations() { return []; }
    });

    const symbols = await provider.provideWorkspaceSymbols("");
    assert.deepEqual(symbols[0].tags, [1]);
    assert.equal(symbols[1].tags, undefined);
});

test("workspace symbols merge parser results and deduplicate native locations", async () => {
    class SymbolInformation {
        constructor(name, kind, containerName, location) { Object.assign(this, { name, kind, containerName, location }); }
    }
    class Location {
        constructor(uri, range) { Object.assign(this, { uri, range }); }
    }
    const base = createVscodeMock();
    const root = "/workspace/stock-project";
    const folderUri = { scheme: "file", fsPath: root, toString: () => `file://${root}` };
    const sharedUri = {
        scheme: "file", fsPath: `${root}/shared.bas`,
        toString: () => `file://${root}/shared.bas`
    };
    const parserOnlyUri = {
        scheme: "file", fsPath: `${root}/parser-only.bas`,
        toString: () => `file://${root}/parser-only.bas`
    };
    const sharedDeclaration = {
        name: "SharedSymbol", type: "function", qualifiedName: "SharedSymbol", containerName: "",
        line: 0, startColumn: 4, endColumn: 16, modifiers: [], localOnly: false
    };
    const provider = createWorkspaceSymbolProvider({
        ...base,
        SymbolInformation,
        Location,
        workspace: {
            ...base.workspace,
            workspaceFolders: [{ name: "stock-project", uri: folderUri }],
            getWorkspaceFolder: () => ({ uri: folderUri })
        }
    }, {
        compilerAnalysis: {
            async workspaceSymbols() {
                return {
                    roots: new Set(),
                    symbols: [{
                        name: "SharedSymbol", type: "function", containerName: "", uri: sharedUri,
                        selection: { start: { line: 0, character: 4 }, end: { line: 0, character: 16 } }
                    }]
                };
            },
            analysisCompilerFor: () => ({ semanticModelOnly: false })
        },
        async ensureInitialized() { return true; },
        getAllDeclarations() {
            return [
                { uri: sharedUri, declaration: sharedDeclaration },
                { uri: parserOnlyUri, declaration: {
                    name: "ParserOnlySymbol", type: "sub", qualifiedName: "ParserOnlySymbol", containerName: "",
                    line: 1, startColumn: 4, endColumn: 20, modifiers: [], localOnly: false
                } }
            ];
        }
    });

    const symbols = await provider.provideWorkspaceSymbols("");
    assert.deepEqual(symbols.map((symbol) => symbol.name), ["SharedSymbol", "ParserOnlySymbol"]);
});

test("stock-sidecar workspace symbols skip native indexing and use parser results", async () => {
    class SymbolInformation {
        constructor(name, kind, containerName, location) { Object.assign(this, { name, kind, containerName, location }); }
    }
    class Location {
        constructor(uri, range) { Object.assign(this, { uri, range }); }
    }
    const base = createVscodeMock();
    const root = "/workspace/stock-sidecar-project";
    const folderUri = { scheme: "file", fsPath: root, toString: () => `file://${root}` };
    const sourceUri = {
        scheme: "file", fsPath: `${root}/source.bas`,
        toString: () => `file://${root}/source.bas`
    };
    const provider = createWorkspaceSymbolProvider({
        ...base,
        SymbolInformation,
        Location,
        workspace: {
            ...base.workspace,
            workspaceFolders: [{ name: "stock-sidecar-project", uri: folderUri }],
            getWorkspaceFolder: () => ({ uri: folderUri })
        }
    }, {
        compilerAnalysis: {
            async workspaceSymbols() { assert.fail("Stock FBC has no native workspace symbol inventory"); },
            analysisCompilerFor: () => ({ semanticModelOnly: true })
        },
        async ensureInitialized() { return true; },
        getAllDeclarations: () => [{ uri: sourceUri, declaration: {
            name: "ParserWorkspaceSymbol", type: "function", qualifiedName: "ParserWorkspaceSymbol",
            containerName: "", line: 0, startColumn: 9, endColumn: 30, modifiers: [], localOnly: false
        } }]
    });

    const symbols = await provider.provideWorkspaceSymbols("ParserWorkspace");
    assert.deepEqual(symbols.map((symbol) => symbol.name), ["ParserWorkspaceSymbol"]);
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

    assert.match(hover, /Initializes a graphics mode/);
    assert.match(hover, /byval width as long/);
    assert.match(hover, /FreeBASIC 1\.20\.5/);
    assert.match(getBuiltInHover(grammarData, "Sin#"), /Returns the sine of an angle/);
    assert.match(getBuiltInHover(grammarData, "GetMouse"), /`x`: x coordinate value/);
});

test("missing-header fixes recognize FBC's rejected implicit-name diagnostic", async () => {
    class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
    class CodeAction { constructor(title, kind) { Object.assign(this, { title, kind }); } }
    class WorkspaceEdit {
        constructor() { this.edits = []; }
        insert(uri, position, text) { this.edits.push({ uri, position, text }); }
    }
    const document = createDocument('Dim surface As Any Ptr = Gfx3SurfaceLoad("missing.png")\n');
    document.positionAt = (offset) => {
        const lines = document.getText().slice(0, offset).split(/\r\n|\n|\r/);
        return new Position(lines.length - 1, lines.at(-1).length);
    };
    document.uri = { scheme: "file", fsPath: "/workspace/missing-header.bas",
        toString: () => "file:///workspace/missing-header.bas" };
    const provider = createMissingHeaderCodeActionProvider({ ...createVscodeMock(), Position, CodeAction, WorkspaceEdit,
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" }
    }, { getParsedDocument: () => parseFreeBasicText(document.getText()),
        ensureInitialized: async () => true, getSemanticModel: () => null });
    const diagnostic = { source: "fbc", code: 149, severity: 0,
        message: "Implicit variables are only valid in -lang deprecated or fblite or qb, found 'Gfx3SurfaceLoad'",
        range: new Range(0, 0, 0, document.lineAt(0).text.length) };
    const actions = await provider.provideCodeActions(document, diagnostic.range, { diagnostics: [diagnostic] });
    const header = actions.find((action) => action.title.includes("fbgfx3.bi"));
    assert.ok(header);
    assert.match(header.edit.edits[0].text, /#include once "fbgfx3.bi"[\r\n]+Using fb/);
    assert.deepEqual(await provider.provideCodeActions(document, diagnostic.range, {
        diagnostics: [{ ...diagnostic, code: 999 }]
    }), []);
    assert.deepEqual(await provider.provideCodeActions(document, diagnostic.range, {
        diagnostics: [{ ...diagnostic, code: COMPILER_MESSAGE_CODE, message: "Variable not declared, Gfx3SurfaceLoad" }]
    }), [], "a user-supplied preprocessor message must not trigger compiler-specific source edits");
});

test("outer unclosed-bracket Quick Fix inserts nested closers in the required order", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class Range {
        constructor(start, end) { Object.assign(this, { start, end }); }
    }
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = "Call ([{value\n";
    const lines = source.split("\n");
    const document = {
        uri: { scheme: "file", fsPath: "/workspace/brackets.bas", toString: () => "file:///workspace/brackets.bas" },
        version: 1,
        getText: () => source,
        lineAt: (line) => ({ text: lines[line] }),
        offsetAt: (position) => position.line === 0 ? position.character : lines[0].length + position.character + 1,
        positionAt: (offset) => offset <= lines[0].length
            ? new Position(0, offset)
            : new Position(1, offset - lines[0].length - 1)
    };
    const vscode = {
        ...createVscodeMock(),
        Position,
        Range,
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const diagnostic = {
        source: "FreeBASIC brackets",
        code: "unclosed-bracket",
        range: new Range(new Position(0, source.indexOf("(")), new Position(0, source.indexOf("(") + 1))
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Insert '}])' to balance this bracket");
    assert.equal(actions[0].edit.insertion.position.line, 1);
    assert.equal(actions[0].edit.insertion.position.character, 0);
    assert.equal(actions[0].edit.insertion.text, "}])");
});

test("unexpected bracket Quick Fix offers a direct repair when one opener is unambiguous", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class Range {
        constructor(start, end) { Object.assign(this, { start, end }); }
    }
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const source = "Print (1]\n";
    const document = {
        uri: { scheme: "file", fsPath: "/workspace/bracket-replacement.bas",
            toString: () => "file:///workspace/bracket-replacement.bas" },
        version: 1,
        getText: () => source,
        lineAt: () => ({ text: source.trimEnd() }),
        offsetAt: (position) => position.character,
        positionAt: (offset) => new Position(0, offset)
    };
    const vscode = {
        ...createVscodeMock(),
        Position,
        Range,
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const closerOffset = source.indexOf("]");
    const diagnostic = {
        source: "FreeBASIC brackets",
        code: "unexpected-closing-bracket",
        range: new Range(new Position(0, closerOffset), new Position(0, closerOffset + 1))
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.deepEqual(actions.map((action) => action.title), [
        "Replace ']' with ')' to balance this bracket",
        "Remove unmatched ']'"
    ]);
    assert.equal(actions[0].isPreferred, true);
    assert.equal(actions[0].edit.replacement.text, ")");
    assert.deepEqual(actions[0].edit.replacement.range, new Range(
        new Position(0, closerOffset), new Position(0, closerOffset + 1)
    ));
    assert.ok(actions[1].edit.deletion);
});

test("ON branch lists retain label-only completion through commas and continuations", async () => {
    class CompletionItem { constructor(label, kind) { Object.assign(this, { label, kind }); } }
    class MarkdownString { constructor(value = "") { this.value = value; } }
    class SnippetString {
        constructor() { this.value = ""; }
        appendText(value) { this.value += value; }
        appendPlaceholder(value) { this.value += value; }
        appendTabstop() {}
    }
    const vscode = { ...createVscodeMock(), CompletionItem, MarkdownString, SnippetString,
        CompletionItemKind: { Reference: 17, Variable: 5, Function: 2, Keyword: 13 } };
    for (const [statement, labelsExpected] of [
        ["On selector Goto firstTarget, fin", true],
        ["On selector Gosub firstTarget, finishTarget, ", true],
        ["On Pick(1, 2) Goto firstTarget, fin", true],
        ["On selector Goto _\n        firstTarget, _\n        fin", true],
        ["On selector Gosub firstTarget, _ ' branch note\n        fin", true],
        ["If selector Then On selector Goto firstTarget, fin", true],
        ["If selector Then Goto firstTarget Else Goto fin", true],
        ["If selector Then On 1 Goto firstTarget, finishTarget Else On 2 Gosub firstTarget, fin", true],
        ["If selector Then On 1 Goto firstTarget, finishTarget Else Goto firstTarget, fin", false],
        ["On selector . Else Goto firstTarget, fin", true],
        ["On selector Goto firstTarget: Print fin", false],
        ["On selector Goto firstTarget,\n        fin", false],
        ["Goto firstTarget, fin", false],
        ["On Error Goto firstTarget, fin", false],
        ["On Local Error Goto firstTarget, fin", false],
        ["On selector Goto firstTarget,, fin", false],
        ["Print firstTarget, fin", false],
        ["Call Filter(firstTarget, fin", false],
        [["On selector Goto firstTarget, _", ...Array(128).fill("        _"), "        fin"].join("\n"), false],
        ["On selector Goto firstTarget, _\n" + " ".repeat(65536) + "fin", false]
    ]) {
        const text = ["Sub Work(ByVal selector As Long)", "    " + statement, "firstTarget:",
            "    Print 1", "finishTarget:", "    Print 2", "End Sub",
            "Sub Other()", "otherTarget:", "End Sub", ""].join("\n");
        const document = createDocument(text);
        document.uri = { scheme: "file", fsPath: "/workspace/on-label-completion.bas",
            toString: () => "file:///workspace/on-label-completion.bas" };
        const parsed = parseFreeBasicText(text);
        const model = new FreeBasicSemanticModel([{ uri: document.uri, parsed }]);
        const provider = createCompletionProvider(vscode, {
            getParsedDocument: () => parsed, ensureInitialized: async () => true,
            getSemanticModel: () => model
        }, {
            preprocessorDirectives: [], operatorKeywords: [], keywords: [], types: [],
            libraryTypes: [], typeModifiers: [], intrinsicFunctions: [], runtimeFunctions: [],
            graphicsFunctions: [], bundledFunctions: [], constants: [], compilerDefines: [], symbolicConstants: []
        });
        const lines = statement.split("\n");
        const position = { line: lines.length, character: lines.at(-1).length + (lines.length === 1 ? 4 : 0) };
        const items = await provider.provideCompletionItems(document, position);
        const labels = items.filter((item) => item.kind === vscode.CompletionItemKind.Reference).map((item) => item.label).sort();
        assert.deepEqual(labels, labelsExpected ? ["finishTarget", "firstTarget"] : [], statement);
        if (labelsExpected) assert.equal(items.length, labels.length, "label targets must not mix in variables or keywords");
    }
});

test("completion documentation preserves overloads and compiler-selected declaration facts", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const declarations = ["Long", "String"].map((typeName) => ({
        name: "ConvertValue",
        type: "function",
        detail: "Function",
        documentation: typeName === "Long" ? "@deprecated Replaced by ConvertValueV2." : "Supports strings.",
        signature: `Function ConvertValue Overload (ByVal value As ${typeName}) As ${typeName}`,
        parameters: [{ name: "value", label: `ByVal value As ${typeName}`, typeName, optional: false }],
        modifiers: []
    }));
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return {
                member: false,
                hasDirectivePrefix: false,
                entries: declarations.map((declaration) => ({
                    name: declaration.name,
                    qualifiedName: declaration.qualifiedName,
                    declaration
                }))
            };
        }
    };
    const index = { compilerAnalysis: { getModelForEditor: async () => model } };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const analysisRequests = [];
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemTag: { Deprecated: 1 },
        CompletionItemKind: { Function: 3, Operator: 4, Keyword: 5, TypeParameter: 6, Struct: 7, Constant: 8 },
        MarkdownString
    }, index, grammarData);
    const document = createDocument("Con");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const items = await provider.provideCompletionItems(document, { line: 0, character: 3 });

    assert.equal(items.length, 1);
    assert.equal(items[0].label, "ConvertValue");
    assert.equal(items[0].insertText, "ConvertValue");
    assert.match(items[0].detail, /2 signatures/);
    assert.match(items[0].documentation.value, /ByVal value As Long/);
    assert.match(items[0].documentation.value, /ByVal value As String/);
    assert.equal(items[0].tags, undefined,
        "a mixed-deprecation overload group should not mark the whole name deprecated");

    declarations.splice(0, declarations.length, {
        name: "cStringProbe",
        type: "function",
        detail: "Function",
        signature: "Declare Function cStringProbe(ByVal value As String) As Long",
        compilerHeaderLibraries: [{ kind: "inclib", value: "c-runtime", filePath: "/freebasic/inc/runtime.bi" }],
        parameters: [],
        modifiers: [],
        compilerFacts: {
            procedureCallingConvention: "cdecl",
            procedureAbiPolicyInputs: [{
                identity: 1, statement: 1, writtenConvention: false, managedString: true, provisional: false
            }],
            properties: [{ name: "procedure-linkage", value: "c", provisional: false }]
        }
    });
    const abiDocument = createDocument("cStr");
    abiDocument.uri = { scheme: "file", fsPath: "/workspace/abi-completion.bas", toString: () => "file:///workspace/abi-completion.bas" };
    const abiItems = await provider.provideCompletionItems(abiDocument, { line: 0, character: 4 });
    assert.match(abiItems[0].documentation.value,
        /Compiler-selected procedure ABI: C linkage, cdecl calling convention, calling convention not written explicitly, FreeBASIC STRING-based type in signature\./);
    assert.match(abiItems[0].documentation.value,
        /Compiler-accepted header linker input: `#inclib "c-runtime"` from `"runtime\.bi"`\./);

    declarations.splice(0, declarations.length, {
        name: "ReadValue",
        type: "function",
        detail: "Function",
        qualifiedName: "DerivedWidget.ReadValue",
        signature: "Function DerivedWidget.ReadValue() As Integer",
        documentation: "@deprecated Use ReadCurrent instead.\nReturns the widget's current value.",
        parameters: [],
        modifiers: [],
        compilerFacts: {
            overriddenProcedure: { compilerSymbolId: 44, qualifiedName: "BaseWidget.ReadValue" },
            properties: [{ name: "written-override", value: "0", provisional: false }]
        }
    });
    const overrideDocument = createDocument("Read");
    overrideDocument.uri = { scheme: "file", fsPath: "/workspace/override-completion.bas",
        toString: () => "file:///workspace/override-completion.bas" };
    const overrideItems = await provider.provideCompletionItems(overrideDocument, { line: 0, character: 4 });
    assert.match(overrideItems[0].documentation.value,
        /Compiler-selected override target:.*BaseWidget\.ReadValue/);
    assert.match(overrideItems[0].documentation.value, /optional.*Override.*not written/);
    assert.match(overrideItems[0].documentation.value, /Returns the widget's current value\./);
    assert.match(overrideItems[0].documentation.value, /Marked deprecated in source documentation\./);
    assert.deepEqual(overrideItems[0].tags, [1], "a uniquely deprecated declaration should carry VS Code's Deprecated completion tag");

    declarations.splice(0, declarations.length, {
        name: "payload",
        type: "parameter",
        detail: "Parameter",
        typeName: "Integer",
        signature: "Sub Consume(ByDesc payload() As Integer)",
        documentation: "The data carried by this descriptor.",
        parameters: [],
        modifiers: [],
        compilerFacts: {
            formalWrittenTypes: ["implicit"],
            parameterPassing: { mode: "bydesc", dimensions: -1, optional: true, receiver: false }
        }
    });
    const parameterDocument = createDocument("pay");
    parameterDocument.uri = { scheme: "file", fsPath: "/workspace/parameter-completion.bas",
        toString: () => "file:///workspace/parameter-completion.bas" };
    const parameterItems = await provider.provideCompletionItems(parameterDocument, { line: 0, character: 3 });
    assert.match(parameterItems[0].documentation.value,
        /Compiler-selected parameter passing: ByDesc \(any array rank\)\. Optional parameter\./);
    assert.match(parameterItems[0].documentation.value,
        /Compiler-selected implicit parameter type: `Integer`\./);
    assert.match(parameterItems[0].documentation.value,
        /The data carried by this descriptor\./);

    declarations.splice(0, declarations.length, {
        name: "defaultText",
        type: "variable",
        detail: "Variable",
        typeName: "String",
        signature: "Dim defaultText As String",
        parameters: [],
        modifiers: [],
        compilerFacts: {
            scalarStringDeclaration: {
                statement: 12, expression: 0, kind: "dim", sourceContext: 1, provisional: false
            }
        }
    });
    const defaultTextDocument = createDocument("def");
    defaultTextDocument.uri = { scheme: "file", fsPath: "/workspace/string-completion.bas",
        toString: () => "file:///workspace/string-completion.bas" };
    const defaultTextItems = await provider.provideCompletionItems(defaultTextDocument, { line: 0, character: 3 });
    assert.match(defaultTextItems[0].documentation.value,
        /Compiler confirms this scalar dynamic String uses its default initialization\./);

    declarations.splice(0, declarations.length, {
        name: "explicitText",
        type: "variable",
        detail: "Variable",
        typeName: "String",
        signature: 'Dim explicitText As String = "Hello"',
        parameters: [],
        modifiers: [],
        compilerFacts: {
            scalarStringDeclaration: {
                statement: 13, expression: 4, kind: "dim", sourceContext: 1, provisional: false,
                initializerValue: { kind: "bytes", value: "48656C6C6F" }
            }
        }
    });
    const explicitTextDocument = createDocument("exp");
    explicitTextDocument.uri = { scheme: "file", fsPath: "/workspace/string-initializer.bas",
        toString: () => "file:///workspace/string-initializer.bas" };
    const explicitTextItems = await provider.provideCompletionItems(explicitTextDocument, { line: 0, character: 3 });
    assert.match(explicitTextItems[0].documentation.value,
        /Compiler-confirmed scalar dynamic String initializer:.*Hello/);

    declarations.splice(0, declarations.length, {
        name: "arrayValues",
        type: "variable",
        detail: "Variable",
        typeName: "Long",
        signature: "Dim arrayValues(0 To 9) As Long",
        parameters: [],
        modifiers: [],
        compilerFacts: {
            storageType: { primitive: "integer", pointerDepth: 0, isReference: false, storageBytes: 4 },
            arrayBounds: {
                mode: "bounds",
                rank: 1,
                dimensions: [{ dimension: 0, kind: "fixed", lower: 0, upper: 9 }]
            },
            properties: [{ name: "array-elements", value: "10", provisional: false }]
        }
    });
    const arrayDocument = createDocument("arr");
    arrayDocument.uri = { scheme: "file", fsPath: "/workspace/array-completion.bas",
        toString: () => "file:///workspace/array-completion.bas" };
    const arrayItems = await provider.provideCompletionItems(arrayDocument, { line: 0, character: 3 });
    assert.match(arrayItems[0].documentation.value,
        /Compiler-selected storage width for one value in this target:.*4 bytes/);
    assert.match(arrayItems[0].documentation.value,
        /Compiler-selected array bounds in this build:.*0 to 9/);
    assert.match(arrayItems[0].documentation.value, /Compiler array element count:.*10/);

    declarations.splice(0, declarations.length, {
        name: "protectedValue",
        type: "field",
        detail: "Field",
        typeName: "Long",
        signature: "protectedValue As Long",
        parameters: [],
        modifiers: [],
        compilerFacts: {
            compilerVisibility: "protected",
            fieldLayout: { owner: 4, byteOffset: 4 },
            properties: [
                { name: "bit-position", value: "2", provisional: false },
                { name: "bit-width", value: "3", provisional: false }
            ]
        }
    });
    const fieldDocument = createDocument("prot");
    fieldDocument.uri = { scheme: "file", fsPath: "/workspace/field-completion.bas",
        toString: () => "file:///workspace/field-completion.bas" };
    const fieldItems = await provider.provideCompletionItems(fieldDocument, { line: 0, character: 4 });
    assert.match(fieldItems[0].documentation.value, /Compiler-selected visibility:.*protected/);
    assert.match(fieldItems[0].documentation.value, /Compiler-selected field offset:.*4 bytes/);
    assert.match(fieldItems[0].documentation.value, /Compiler-selected bit position: 2; width: 3 bits/);
    declarations[0].compilerFacts.compilerVisibility = "public";
    const publicFieldItems = await provider.provideCompletionItems(fieldDocument, { line: 0, character: 4 });
    assert.match(publicFieldItems[0].documentation.value, /Compiler-selected visibility: public\./);

    declarations.splice(0, declarations.length, {
        name: "ReadValue",
        type: "function",
        detail: "Function",
        qualifiedName: "Widget.ReadValue",
        signature: "Function Widget.ReadValue() As Integer",
        parameters: [],
        modifiers: [],
        compilerFacts: { compilerVisibility: "public" }
    });
    const memberDocument = createDocument("Read");
    memberDocument.uri = { scheme: "file", fsPath: "/workspace/member-completion.bas",
        toString: () => "file:///workspace/member-completion.bas" };
    const memberItems = await provider.provideCompletionItems(memberDocument, { line: 0, character: 4 });
    assert.match(memberItems[0].documentation.value, /Compiler-selected visibility: public\./);

    declarations.splice(0, declarations.length, {
        name: "AbstractWidget",
        type: "type",
        detail: "Type",
        baseType: "BaseSelector",
        signature: "Type AbstractWidget",
        parameters: [],
        modifiers: [],
        compilerFacts: {
            baseType: "BaseSelector",
            abstractMemberCount: 2,
            aggregateAccess: {
                bodyStatement: 1, count: 2,
                sections: [
                    { ordinal: 1, statement: 2, visibility: "public" },
                    { ordinal: 2, statement: 3, visibility: "private" }
                ]
            }
        }
    });
    const abstractTypeDocument = createDocument("Abs");
    abstractTypeDocument.uri = { scheme: "file", fsPath: "/workspace/abstract-completion.bas",
        toString: () => "file:///workspace/abstract-completion.bas" };
    const abstractTypeItems = await provider.provideCompletionItems(abstractTypeDocument, { line: 0, character: 3 });
    assert.match(abstractTypeItems[0].documentation.value,
        /Compiler reports 2 unimplemented abstract members; this type cannot be instantiated until they are implemented\./);
    assert.match(abstractTypeItems[0].documentation.value,
        /Compiler-selected base type: `BaseSelector`\./);
    assert.match(abstractTypeItems[0].documentation.value,
        /Compiler-confirmed member access sections: Public, Private/);
});

test("NEW completion keeps constructor snippets for type aliases", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class SnippetString {
        constructor() { this.value = ""; }
        appendText(value) { this.value += value; }
        appendPlaceholder(value, index) { this.value += `\$\{${index}:${value}\}`; }
        appendTabstop(index) { this.value += `\$${index}`; }
    }
    const text = [
        "Type SnippetTarget",
        "    Declare Constructor(ByVal amount As Long)",
        "End Type",
        "Constructor SnippetTarget(ByVal amount As Long)",
        "End Constructor",
        "Type ShortAlias As SnippetTarget",
        "Function MakeSnippetTarget() As SnippetTarget",
        "    Return ShortAlias(3)",
        "End Function",
        "Dim initializedSnippet As SnippetTarget = ShortAlias(4)",
        "Sub ConsumeSnippetTarget(ByVal value As SnippetTarget)",
        "End Sub",
        "Type OverloadedTarget",
        "    Declare Constructor(ByVal amount As Long)",
        "    Declare Constructor(ByVal label As String)",
        "End Type",
        "Type MultiAlias As OverloadedTarget",
        "Namespace CompletionSpace",
        "    Type NestedAlias As SnippetTarget",
        "End Namespace",
        "Function MakeQualifiedSnippetTarget() As SnippetTarget",
        "    Return CompletionSpace.NestedAlias(6)",
        "End Function",
        "Dim qualifiedInitialized As SnippetTarget = CompletionSpace.NestedAlias(7)",
        "Dim aliasObject As ShortAlias Ptr = New ShortAli",
        "Dim overloadedObject As MultiAlias Ptr = New MultiA",
        "Dim nestedObject As CompletionSpace.NestedAlias Ptr = New CompletionSpace.NestedAli",
        "ConsumeSnippetTarget(ShortAlias(5))"
    ].join("\n");
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/alias-constructor-completion.bas",
        toString: () => "file:///workspace/alias-constructor-completion.bas" };
    document.positionAt = (offset) => {
        const linesBefore = text.slice(0, offset).split("\n");
        return { line: linesBefore.length - 1, character: linesBefore.at(-1).length };
    };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(text)
    }]);
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Struct: 1 },
        MarkdownString,
        SnippetString
    }, {
        compilerAnalysis: { getModelForEditor: async () => null, getModel: () => null },
        getParsedDocument: (entry) => parseFreeBasicText(entry.getText()),
        ensureInitialized: async () => true,
        getSemanticModel: () => sourceModel,
        getSourceSemanticModel: () => sourceModel
    }, grammarData);

    const lines = text.split("\n");
    const qualifiedReturnLine = lines.findIndex((line) => line.includes("Return CompletionSpace.NestedAlias(6)"));
    const qualifiedInitializerLine = lines.findIndex((line) => line.includes("= CompletionSpace.NestedAlias(7)"));
    const aliasLine = lines.findIndex((line) => line.includes("New ShortAli"));
    const aliasItems = await provider.provideCompletionItems(document, {
        line: aliasLine,
        character: lines[aliasLine].length
    });
    const alias = aliasItems.find((item) => item.label === "ShortAlias");
    assert.ok(alias);
    assert.equal(alias.insertText.value, "ShortAlias(${1:amount})$0");
    const returnLine = lines.findIndex((line) => line.includes("Return ShortAlias(3)"));
    const returnNameStart = lines[returnLine].indexOf("ShortAlias");
    const returnItems = await provider.provideCompletionItems(document, {
        line: returnLine,
        character: returnNameStart + "ShortAli".length
    });
    assert.equal(returnItems.find((item) => item.label === "ShortAlias")?.insertText.value,
        "ShortAlias(${1:amount})$0",
        "Return type-constructor expressions should receive constructor snippets too");
    const initializerLine = lines.findIndex((line) => line.includes("= ShortAlias(4)"));
    const initializerNameStart = lines[initializerLine].lastIndexOf("ShortAlias");
    const initializerItems = await provider.provideCompletionItems(document, {
        line: initializerLine,
        character: initializerNameStart + "ShortAli".length
    });
    assert.equal(initializerItems.find((item) => item.label === "ShortAlias")?.insertText.value,
        "ShortAlias(${1:amount})$0",
        "initializer type-constructor expressions should receive constructor snippets too");
    for (const lineNumber of [qualifiedReturnLine, qualifiedInitializerLine]) {
        const lineText = lines[lineNumber];
        const typeStart = lineText.lastIndexOf("CompletionSpace.NestedAlias");
        const items = await provider.provideCompletionItems(document, {
            line: lineNumber,
            character: typeStart + "CompletionSpace.NestedAli".length
        });
        assert.equal(items.find((item) => item.label === "NestedAlias")?.insertText.value,
            "NestedAlias(${1:amount})$0",
            "qualified Return and initializer constructors should retain alias snippets");
    }
    const argumentLine = lines.findIndex((line) => line.includes("ConsumeSnippetTarget(ShortAlias(5))"));
    const argumentNameStart = lines[argumentLine].indexOf("ShortAlias", lines[argumentLine].indexOf("ConsumeSnippetTarget"));
    const argumentItems = await provider.provideCompletionItems(document, {
        line: argumentLine,
        character: argumentNameStart + "ShortAli".length
    });
    assert.equal(argumentItems.find((item) => item.label === "ShortAlias")?.insertText.value,
        "ShortAlias(${1:amount})$0",
        "procedure-argument type constructors should receive constructor snippets too");
    const overloadedLine = lines.findIndex((line) => line.includes("New MultiA"));
    const overloadedItems = await provider.provideCompletionItems(document, {
        line: overloadedLine,
        character: lines[overloadedLine].length
    });
    const overloadedAlias = overloadedItems.find((item) => item.label === "MultiAlias");
    assert.ok(overloadedAlias);
    assert.equal(overloadedAlias.insertText, "MultiAlias",
        "overloaded alias constructors should not guess an argument snippet");
    const qualifiedLine = lines.findIndex((line) => line.includes("New CompletionSpace.NestedAli"));
    const qualifiedLocalItems = await provider.provideCompletionItems(document, {
        line: qualifiedLine,
        character: lines[qualifiedLine].length
    });
    assert.ok(qualifiedLocalItems.some((item) => item.label === "NestedAlias"),
        JSON.stringify(qualifiedLocalItems.map((item) => [item.label, item.insertText?.value || item.insertText])));
    assert.equal(qualifiedLocalItems.find((item) => item.label === "NestedAlias")?.insertText.value,
        "NestedAlias(${1:amount})$0",
        "source-semantic completion should retain constructor snippets through a qualified namespace");

    const bindingRequests = [];
    const queries = [];
    const linesForSidecar = lines;
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            queries.push(operation);
            assert.equal(operation, "completion");
            const qualified = [qualifiedLine, qualifiedReturnLine, qualifiedInitializerLine].includes(input.position.line);
            const name = qualified ? "NestedAlias" : "ShortAlias";
            return {
                member: false,
                hasDirectivePrefix: false,
                entries: [{
                    name,
                    uri: document.uri,
                    declaration: {
                        name,
                        qualifiedName: qualified ? `CompletionSpace.${name}` : name,
                        type: "type", detail: "Type alias",
                        signature: qualified ? `Type CompletionSpace.${name} As SnippetTarget` : `Type ${name} As SnippetTarget`,
                        parameters: [], modifiers: []
                    },
                    constructorCallParameters: [{ name: "amount", optional: false }]
                }]
            };
        }
    };
    const sidecarProvider = createCompletionProvider({
        ...createVscodeMock(), CompletionItem, CompletionItemKind: { Struct: 1 }, MarkdownString, SnippetString
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            async getModelForEditor(_document, _token, needTypes, needBindings) {
                bindingRequests.push([needTypes, needBindings]);
                return sidecarModel;
            },
            getModel: () => null
        },
        getParsedDocument: (entry) => parseFreeBasicText(entry.getText()),
        getSemanticModel: () => sourceModel,
        getSourceSemanticModel: () => sourceModel
    }, grammarData);
    const sidecarItems = await sidecarProvider.provideCompletionItems(document, {
        line: aliasLine,
        character: lines[aliasLine].length
    });
    assert.equal(sidecarItems.find((item) => item.label === "ShortAlias")?.insertText.value,
        "ShortAlias(${1:amount})$0");
    const qualifiedSidecarItems = await sidecarProvider.provideCompletionItems(document, {
        line: qualifiedLine,
        character: linesForSidecar[qualifiedLine].length
    });
    assert.equal(qualifiedSidecarItems.find((item) => item.label === "NestedAlias")?.insertText.value,
        "NestedAlias(${1:amount})$0");
    const sidecarReturnItems = await sidecarProvider.provideCompletionItems(document, {
        line: returnLine,
        character: returnNameStart + "ShortAli".length
    });
    assert.equal(sidecarReturnItems.find((item) => item.label === "ShortAlias")?.insertText.value,
        "ShortAlias(${1:amount})$0");
    const sidecarInitializerItems = await sidecarProvider.provideCompletionItems(document, {
        line: initializerLine,
        character: initializerNameStart + "ShortAli".length
    });
    assert.equal(sidecarInitializerItems.find((item) => item.label === "ShortAlias")?.insertText.value,
        "ShortAlias(${1:amount})$0");
    const sidecarArgumentItems = await sidecarProvider.provideCompletionItems(document, {
        line: argumentLine,
        character: argumentNameStart + "ShortAli".length
    });
    assert.equal(sidecarArgumentItems.find((item) => item.label === "ShortAlias")?.insertText.value,
        "ShortAlias(${1:amount})$0");
    for (const lineNumber of [qualifiedReturnLine, qualifiedInitializerLine]) {
        const lineText = lines[lineNumber];
        const typeStart = lineText.lastIndexOf("CompletionSpace.NestedAlias");
        const items = await sidecarProvider.provideCompletionItems(document, {
            line: lineNumber,
            character: typeStart + "CompletionSpace.NestedAli".length
        });
        assert.equal(items.find((item) => item.label === "NestedAlias")?.insertText.value,
            "NestedAlias(${1:amount})$0");
    }
    assert.deepEqual(bindingRequests, [
        [false, true], [false, true], [false, true], [false, true], [false, true], [false, true], [false, true]
    ], "stock-sidecar explicit type calls should request declaration bindings only in constructor contexts");
    assert.deepEqual(queries, ["completion", "completion", "completion", "completion", "completion", "completion", "completion"]);
});

test("preprocessor operands complete compiler-visible macros and prior defined symbols", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class SnippetString {
        constructor(value = "") { this.value = value; }
    }
    const entries = [
        { name: "ACTIVE_FLAG", declaration: { name: "ACTIVE_FLAG", type: "macro", detail: "Compiler macro", parameters: [], modifiers: [] } },
        { name: "ACTIVE_FUNCTION", declaration: {
            name: "ACTIVE_FUNCTION", type: "macro", detail: "Compiler macro",
            signature: "ACTIVE_FUNCTION(value)",
            parameters: [{ name: "value", label: "value", optional: false }], modifiers: []
        } },
        { name: "activeValue", declaration: { name: "activeValue", type: "variable", detail: "Variable", parameters: [], modifiers: [] } },
        { name: "ActiveType", declaration: { name: "ActiveType", type: "type", detail: "Type", parameters: [], modifiers: [] } }
    ];
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return { member: false, hasDirectivePrefix: false, entries };
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    grammarData.keywords = ["If"];
    grammarData.types = ["Integer"];
    grammarData.compilerDefines = ["__FB_WIN32__"];
    grammarData.intrinsicFunctions = ["TypeOf"];
    const sourceEntries = [
        { name: "PRIOR_VALUE", declaration: { name: "PRIOR_VALUE", type: "const", detail: "Constant", line: 0, parameters: [], modifiers: [] } },
        { name: "PRIOR_FUNCTION", declaration: { name: "PRIOR_FUNCTION", type: "function", detail: "Function", line: 1, parameters: [], modifiers: [] } },
        { name: "CONDITIONAL_VALUE", conditional: true, declaration: { name: "CONDITIONAL_VALUE", type: "const", detail: "Constant", line: 2, parameters: [], modifiers: [] } },
        { name: "FUTURE_VALUE", declaration: { name: "FUTURE_VALUE", type: "const", detail: "Constant", line: 6, parameters: [], modifiers: [] } }
    ];
    const qualifiedMember = {
        name: "QualifiedValue",
        declaration: { name: "QualifiedValue", type: "const", detail: "Constant", line: 1, parameters: [], modifiers: [] }
    };
    const sourceModel = {
        visibleEntries(_uri, _line, _character, limit) { return sourceEntries.slice(0, limit); },
        completeMembers() { return [qualifiedMember]; }
    };
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Snippet: 1, Variable: 2, Struct: 3, Keyword: 4, Constant: 5, Operator: 6, Function: 7 },
        MarkdownString,
        SnippetString
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getSourceSemanticModel: () => sourceModel
    }, grammarData);
    for (const [index, line] of ["#ifdef ACTIVE", "#if defined(ACTIVE", "#undef ACTIVE"].entries()) {
        const source = ["Const PRIOR_VALUE = 1", "Function PRIOR_FUNCTION() As Integer", "End Function", line].join("\n");
        const document = createDocument(source);
        document.uri = {
            scheme: "file",
            fsPath: `/workspace/preprocessor-completion-${index}.bas`,
            toString: () => `file:///workspace/preprocessor-completion-${index}.bas`
        };
        const items = await provider.provideCompletionItems(document, { line: 3, character: line.length });
        const expectedNames = line.startsWith("#if defined")
            ? ["ACTIVE_FLAG", "ACTIVE_FUNCTION", "PRIOR_VALUE", "PRIOR_FUNCTION"]
            : ["ACTIVE_FLAG", "ACTIVE_FUNCTION"];
        assert.deepEqual(items.map((item) => item.label), expectedNames,
            `preprocessor candidates should match the operand scope in ${line}`);
        const functionMacro = items.find((item) => item.label === "ACTIVE_FUNCTION");
        assert.equal(functionMacro.insertText, "ACTIVE_FUNCTION",
            "a macro-name operand must not insert a function-like macro call snippet");
    }

    entries.splice(1);
    const expressionDocument = createDocument("#if def");
    expressionDocument.uri = { scheme: "file", fsPath: "/workspace/preprocessor-expression.bas",
        toString: () => "file:///workspace/preprocessor-expression.bas" };
    const expressionItems = await provider.provideCompletionItems(expressionDocument, { line: 0, character: 7 });
    const expressionNames = expressionItems.map((item) => item.label);
    assert.ok(expressionNames.includes("defined"), "conditional expressions should offer the preprocessor defined operator");
    assert.equal(expressionItems.find((item) => item.label === "defined").insertText.value,
        "defined(${1:MACRO})", "the preprocessor operator completion should prompt for its macro operand");
    assert.ok(expressionNames.includes("ACTIVE_FLAG"), "conditional expressions should retain compiler-visible macros");
    assert.ok(expressionNames.includes("TypeOf"), "conditional expressions should retain FBC's compile-time TYPEOF intrinsic");

    const qualifiedSource = [
        "Namespace DefinedNameProbe",
        "    Const QualifiedValue = 1",
        "End Namespace",
        "#if defined(DefinedNameProbe.Qual"
    ].join("\n");
    const qualifiedDocument = createDocument(qualifiedSource);
    qualifiedDocument.uri = { scheme: "file", fsPath: "/workspace/defined-qualified-completion.bas",
        toString: () => "file:///workspace/defined-qualified-completion.bas" };
    const qualifiedLine = qualifiedSource.split("\n")[3];
    const qualifiedItems = await provider.provideCompletionItems(qualifiedDocument,
        { line: 3, character: qualifiedLine.length });
    assert.deepEqual(qualifiedItems.map((item) => item.label), ["QualifiedValue"],
        "qualified defined-name completion should use the source model's namespace members");
});

test("compiler-backed completions include identifiers hidden by the source comment masker", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const text = [
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemIdentifierProbe()",
        "    Dim REM As Integer",
        "    Print RE",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(text);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/conditional-rem-completion.bas",
        toString: () => "file:///workspace/conditional-rem-completion.bas"
    };
    let semanticModelOnly = true;
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return {
                member: false,
                hasDirectivePrefix: false,
                entries: [{
                    id: "sidecar:1",
                    name: "REM",
                    declaration: {
                        name: "REM",
                        type: "variable",
                        detail: "Variable As Integer",
                        typeName: "integer",
                        signature: "variable REM As integer",
                        line: 4,
                        startColumn: 8,
                        endColumn: 11,
                        modifiers: [],
                        parameters: []
                    }
                }]
            };
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const analysisRequests = [];
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Variable: 1 },
        MarkdownString
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            },
            getModel: () => null
        }
    }, grammarData);
    const line = text.split("\n")[5];
    const items = await provider.provideCompletionItems(document, {
        line: 5,
        character: line.indexOf("RE") + 2
    });

    assert.deepEqual(items.map((item) => item.label), ["REM"]);
    assert.match(items[0].detail, /Integer/);
    assert.deepEqual(analysisRequests, [[false, true]],
        "typing the masked REM prefix should request compiler bindings on demand");

    semanticModelOnly = false;
    model.semanticSidecarOnly = false;
    const bridgeItems = await provider.provideCompletionItems(document, {
        line: 5,
        character: line.indexOf("RE") + 2
    });
    assert.deepEqual(bridgeItems.map((item) => item.label), ["REM"]);
    assert.deepEqual(analysisRequests, [[false, true], [false, true]],
        "the editor bridge should also supply bindings on demand for the masked prefix");
});

test("stock-sidecar completion requests runtime-name bindings after OPTION NOKEYWORD", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const source = [
        '#lang "deprecated"',
        "Option NoKeyword Abs",
        "Sub AbsProbe()",
        "    Abs = 1",
        "    Ab",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/nokeyword-abs-completion.bas",
        toString: () => "file:///workspace/nokeyword-abs-completion.bas" };
    const requests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            assert.equal(operation, "completion");
            return {
                member: false,
                hasDirectivePrefix: false,
                entries: [{
                    id: "sidecar:abs",
                    name: "Abs",
                    declaration: {
                        name: "Abs",
                        type: "variable",
                        detail: "Variable As Integer",
                        typeName: "integer",
                        signature: "variable Abs As integer",
                        line: 3,
                        startColumn: 4,
                        endColumn: 7,
                        modifiers: [],
                        parameters: []
                    }
                }]
            };
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "graphicsFunctions", "bundledFunctions", "constants", "compilerDefines",
        "symbolicConstants"
    ].map((key) => [key, []]));
    grammarData.runtimeFunctions = ["Abs"];
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Variable: 1, Function: 3 },
        MarkdownString
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            },
            getModel: () => null
        }
    }, grammarData);

    const items = await provider.provideCompletionItems(document, { line: 4, character: 6 });
    assert.deepEqual(items.map((item) => item.label), ["Abs"]);
    assert.match(items[0].detail, /Variable As Integer/);
    assert.deepEqual(requests, [[false, true]]);
    assert.deepEqual(queries, ["completion"]);
});

test("constant completions show one exact compiler value and hide conflicting facts", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const entry = {
        name: "MaximumValue",
        declaration: {
            name: "MaximumValue", type: "const", detail: "Constant", typeName: "ULongInt",
            signature: "Const MaximumValue As ULongInt", parameters: [], modifiers: [],
            compilerFacts: { constantValues: [{ kind: "unsigned", value: "18446744073709551615" }] }
        }
    };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return { member: false, hasDirectivePrefix: false, entries: [entry] };
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Constant: 1 },
        MarkdownString
    }, { compilerAnalysis: { getModelForEditor: async () => model } }, grammarData);
    const document = createDocument("Maximum");
    document.uri = { scheme: "file", fsPath: "/workspace/constants.bas", toString: () => "file:///workspace/constants.bas" };

    const exact = await provider.provideCompletionItems(document, { line: 0, character: 7 });
    assert.match(exact[0].detail, /compiler value: 18446744073709551615/,
        "64-bit unsigned constants should remain exact in the completion detail");

    entry.declaration.compilerFacts.constantValues = [
        { kind: "signed", value: "42" },
        { kind: "signed", value: "43" }
    ];
    const ambiguous = await provider.provideCompletionItems(document, { line: 0, character: 7 });
    assert.doesNotMatch(ambiguous[0].detail, /compiler value/,
        "completion must not choose among conflicting semantic values");
});

test("stock FBC completion details request values only for matching constant candidates", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const filePath = "/workspace/stock-constants.bi";
    const source = "Const SidecarMaximum As ULongInt = 42\n";
    const document = createDocument("SidecarM");
    document.uri = { scheme: "file", fsPath: "/workspace/use-constant.bas", toString: () => "file:///workspace/use-constant.bas" };
    const startColumn = source.indexOf("SidecarMaximum");
    const entry = {
        name: "SidecarMaximum",
        uri: { fsPath: filePath },
        declaration: {
            name: "SidecarMaximum", type: "const", detail: "Constant", typeName: "ULongInt",
            signature: "Const SidecarMaximum As ULongInt", line: 0,
            startColumn, endColumn: startColumn + "SidecarMaximum".length,
            parameters: [], modifiers: []
        }
    };
    const sourceModel = {
        remote: false,
        completeMembers: () => null,
        visibleEntries: () => [entry]
    };
    let completionValue = { kind: "unsigned", value: "18446744073709551615" };
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerSidecarConstantsAtSites");
            assert.equal(input.sites.length, 1);
            return [{ index: 0, ...completionValue }];
        }
    };
    const analysisRequests = [];
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            async getModelForEditor(_document, _token, needTypes, needBindings) {
                analysisRequests.push([needTypes, needBindings]);
                return needBindings ? sidecarModel : sourceModel;
            }
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Constant: 1 },
        MarkdownString
    }, index, grammarData);
    const items = await provider.provideCompletionItems(document, { line: 0, character: 8 });

    assert.deepEqual(analysisRequests, [[false, false], [false, true]],
        "the sidecar binding pass should follow only a matching constant-prefix completion request");
    assert.equal(items.length, 1);
    assert.match(items[0].detail, /compiler value: 18446744073709551615/);

    completionValue = { kind: "float64-bits", value: "0x3FF8000000000000" };
    analysisRequests.length = 0;
    const floatingItems = await provider.provideCompletionItems(document, { line: 0, character: 8 });
    assert.match(floatingItems[0].detail, /compiler value: 1\.5 \(IEEE-754 bits 0x3FF8000000000000\)/);
    assert.deepEqual(analysisRequests, [[false, false], [false, true]]);

    completionValue = { kind: "bytes", value: "48656C6C6F" };
    const stringItems = await provider.provideCompletionItems(document, { line: 0, character: 8 });
    assert.match(stringItems[0].detail, /compiler value: bytes 0x48656C6C6F \(ASCII preview: "Hello"\)/);

    analysisRequests.length = 0;
    const unmatched = createDocument("SidecarZ");
    unmatched.uri = document.uri;
    sourceModel.visibleEntries = () => [entry];
    const unmatchedItems = await provider.provideCompletionItems(unmatched, { line: 0, character: 8 });
    assert.equal(unmatchedItems.length, 1, "VS Code retains the candidate for client-side filtering");
    assert.doesNotMatch(unmatchedItems[0].detail, /compiler value/);
    assert.deepEqual(analysisRequests, [[false, false]],
        "a nonmatching prefix must not request compiler bindings");
});

test("stock FBC type completion uses compiler-confirmed base types", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const document = createDocument("Derived");
    document.uri = { scheme: "file", fsPath: "/workspace/type-completion.bas",
        toString: () => "file:///workspace/type-completion.bas" };
    const entry = {
        name: "Derived",
        uri: { fsPath: "/workspace/types.bi" },
        declaration: {
            name: "Derived", type: "type", detail: "Type", baseType: "SourceBase",
            signature: "Type Derived Extends SourceBase", line: 0, startColumn: 0, endColumn: 7,
            parameters: [], modifiers: []
        }
    };
    const sourceModel = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return { member: false, hasDirectivePrefix: false, entries: [entry] };
        }
    };
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerSidecarOutlineFactsAtSites");
            assert.deepEqual(input.sites, [{ index: 0, filePath: "/workspace/types.bi", line: 0, startColumn: 0, endColumn: 7 }]);
            return [{ index: 0, compilerFacts: { baseType: "CompilerBase" } }];
        }
    };
    const analysisRequests = [];
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            async getModelForEditor(_document, _token, needTypes, needBindings) {
                analysisRequests.push([needTypes, needBindings]);
                return needBindings ? sidecarModel : sourceModel;
            }
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Class: 1, Struct: 2, TypeParameter: 3 },
        MarkdownString
    }, index, grammarData);
    const items = await provider.provideCompletionItems(document, { line: 0, character: 7 });

    assert.equal(items.length, 1);
    assert.match(items[0].documentation.value, /Compiler-selected base type: `CompilerBase`\./);
    assert.doesNotMatch(items[0].documentation.value, /Declared base type/,
        "compiler-confirmed identity should replace the weaker source-only label");
    assert.deepEqual(analysisRequests, [[false, false], [false, true]],
        "only a matching user-defined type candidate should request the binding-capable sidecar");

    analysisRequests.length = 0;
    const unmatchedDocument = createDocument("DerivedZ");
    unmatchedDocument.uri = document.uri;
    const unmatchedItems = await provider.provideCompletionItems(unmatchedDocument, { line: 0, character: 8 });
    assert.equal(unmatchedItems.length, 1, "VS Code may retain an unmatched item for client-side filtering");
    assert.match(unmatchedItems[0].documentation.value, /Declared base type: `SourceBase`\./);
    assert.deepEqual(analysisRequests, [[false, false]],
        "an unmatched type prefix must not request compiler bindings");
});

test("stock-sidecar member completion resolves an ambiguous pointer type in its source scope", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const source = [
        "Namespace First",
        "    Type TestWidget",
        "        value As Integer",
        "    End Type",
        "End Namespace",
        "Namespace Second",
        "    Type TestWidget",
        "        otherValue As Integer",
        "    End Type",
        "End Namespace",
        "Using First",
        "Dim widgetPointer As TestWidget Ptr",
        "Function MakeWidget() As TestWidget Ptr",
        "    Return widgetPointer",
        "End Function",
        "Print MakeWidget()->value",
        "Print widgetPointer->",
        "Sub WithProbe()",
        "    With widgetPointer",
        "        ' The active WITH receiver survives comments.",
        "        .",
        "    End With",
        "End Sub"
    ].join("\n");
    const document = createDocument(source);
    document.positionAt = (offset) => {
        const lines = source.slice(0, offset).split(/\r\n|\n|\r/);
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    const filePath = "/workspace/pointer-member-completion.bas";
    document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(source)
    }]);
    assert.equal(sourceModel.findVisibleTypeEntries(document.uri, "TestWidget Ptr").length, 2,
        "the compiler's unqualified type spelling must be ambiguous globally in this fixture");
    const completionModel = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return { member: true, hasDirectivePrefix: false, entries: [] };
        }
    };
    const lines = source.split("\n");
    const functionCallLine = lines.findIndex((line) => line.startsWith("Print MakeWidget()->"));
    const pointerLine = lines.findIndex((line) => line.startsWith("Print widgetPointer->"));
    const withMemberLine = lines.findIndex((line) => line.trim() === ".");
    let expressionUnavailable = false;
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        async expressionAt(uri, position) {
            assert.equal(uri.toString(), document.uri.toString());
            if (expressionUnavailable) return null;
            const receiver = position.line === functionCallLine ? "MakeWidget()" : "widgetPointer";
            assert.deepEqual(position, {
                line: position.line,
                character: lines[position.line].indexOf(receiver) + receiver.length - 1
            });
            return {
                typeName: position.line === functionCallLine ? "TestWidget Ptr" : "Integer",
                provisional: false
            };
        }
    };
    const modelRequests = [];
    const workspaceIndex = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => completionModel,
            getModelForEditor(_document, _token, needCompilerExpressionTypes) {
                modelRequests.push(needCompilerExpressionTypes);
                return needCompilerExpressionTypes ? sidecarModel : completionModel;
            }
        },
        getSemanticModel: () => sourceModel
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        MarkdownString,
        CompletionItemKind: { Class: 1, Field: 2, Function: 3, Struct: 4, Variable: 5 }
    }, workspaceIndex, grammarData);
    const functionLine = lines[functionCallLine];
    const functionItems = await provider.provideCompletionItems(document, {
        line: functionCallLine, character: functionLine.indexOf("->") + 2
    });
    const pointerLineText = lines[pointerLine];
    const scalarResultItems = await provider.provideCompletionItems(document, {
        line: pointerLine, character: pointerLineText.length
    });
    expressionUnavailable = true;
    const recoveryItems = await provider.provideCompletionItems(document, {
        line: pointerLine, character: pointerLineText.length
    });
    const withLine = lines[withMemberLine];
    const withItems = await provider.provideCompletionItems(document, {
        line: withMemberLine, character: withLine.length
    });
    const resolveSourceReceiver = sourceModel.resolveReceiver.bind(sourceModel);
    sourceModel.resolveReceiver = () => [{ conditional: true }, { conditional: false }];
    const ambiguousItems = await provider.provideCompletionItems(document, {
        line: pointerLine, character: pointerLineText.length
    });
    sourceModel.resolveReceiver = resolveSourceReceiver;

    assert.deepEqual(functionItems.map((item) => item.label), ["value"]);
    assert.deepEqual(scalarResultItems.map((item) => item.label), ["value"]);
    assert.deepEqual(recoveryItems.map((item) => item.label), ["value"]);
    assert.deepEqual(withItems.map((item) => item.label), ["value"]);
    assert.deepEqual(ambiguousItems, [], "an ambiguous source fallback must not offer members from a guessed receiver");
    assert.deepEqual(modelRequests, [false, true, false, true, false, true, false, true, false, true],
        "member completion should prefer compiler types, resolve WITH receivers during recovery, and withhold ambiguous fallback candidates");
});

test("stock-sidecar completion shows compiler-selected types for untyped declarations", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const source = [
        "Sub CompletionTypeProbe()",
        "    Dim implicitDimValue",
        "    ReDim implicitArrayValue(0 To 2)",
        "    ReDim Preserve implicitPreservedArray(0 To 2)",
        "    implicit",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/completion-inferred-types.bas",
        toString: () => "file:///workspace/completion-inferred-types.bas" };
    const parsedDocument = parseFreeBasicText(source);
    const entries = parsedDocument.declarations.filter((declaration) => declaration.type === "variable")
        .map((declaration, index) => ({
            id: index + 1,
            name: declaration.name,
            uri: document.uri,
            declaration
        }));
    const sourceModel = {
        remote: false,
        completeMembers: () => null,
        visibleEntries: () => entries
    };
    const requests = [];
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { sites }) {
            requests.push(operation);
            assert.equal(operation, "compilerSidecarOutlineFactsAtSites");
            assert.deepEqual(sites.map((site) => [site.line, source.split("\n")[site.line]
                .slice(site.startColumn, site.endColumn)]), [
                [1, "implicitDimValue"], [2, "implicitArrayValue"], [3, "implicitPreservedArray"]
            ]);
            return sites.map((site) => ({
                index: site.index,
                    compilerFacts: {
                        storageType: {
                            primitive: site.line === 1 ? "integer" : site.line === 2 ? "double" : "string",
                            storageBytes: site.line === 1 ? 4 : site.line === 2 ? 8 : 12,
                            pointerDepth: 0,
                            isReference: false
                        },
                        compilerStorageClass: "local",
                    ...(site.line === 1 ? {
                        declarationInputs: [{
                            ordinal: 1,
                            symbol: 10,
                            writtenType: "implicit",
                            group: { identity: 1, statement: 1, kind: "dim", count: 1, provisional: false },
                            provisional: false
                        }]
                    } : {})
                }
            }));
        }
    };
    const analysisRequests = [];
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Variable: 1 },
        MarkdownString
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => sidecarModel,
            getModelForEditor(_document, _token, needTypes, needBindings) {
                analysisRequests.push([needTypes, needBindings]);
                return needBindings ? sidecarModel : sourceModel;
            }
        },
        getParsedDocument: () => parsedDocument
    }, grammarData);

    const completionLine = source.split("\n")[4];
    const items = await provider.provideCompletionItems(document, { line: 4, character: completionLine.length });
    assert.deepEqual(items.map((item) => [item.label, item.detail]), [
        ["implicitDimValue", "Variable (compiler-selected type) As Integer (storage: local)"],
        ["implicitArrayValue", "Variable (compiler-selected type) As Double (storage: local)"],
        ["implicitPreservedArray", "Variable (compiler-selected type) As String (storage: local)"]
    ]);
    assert.deepEqual(analysisRequests, [[false, false], [false, true]],
        "variable completion should request a binding-capable sidecar only for matching untyped declarations");
    assert.deepEqual(requests, ["compilerSidecarOutlineFactsAtSites"]);
});

test("stock-sidecar completion suggests only prior implicit locals from the current procedure", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const source = [
        "Data 7, 8",
        "Sub FirstImplicitProbe()",
        "    implicitValue",
        "    implicitValueFirst = 1",
        "    implicit",
        '    Input "Value: "; implicitInputValue',
        "    Read implicitReadValue",
        "    implicit",
        "End Sub",
        "Sub SecondImplicitProbe()",
        "    implicitValueSecond = 2",
        "    implicitValue",
        "End Sub",
        ""
    ].join("\n");
    const lines = source.split("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-completion.bas",
        toString: () => "file:///workspace/implicit-completion.bas" };
    let outlineQueries = 0;
    const implicitRecord = (name, line) => ({
        name,
        line,
        startColumn: lines[line].indexOf(name),
        endColumn: lines[line].indexOf(name) + name.length,
        storageClass: "local",
        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
    });
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "compilerSidecarOutlineImplicitVariables");
            outlineQueries++;
            return [
                implicitRecord("implicitValueFirst", 3),
                implicitRecord("implicitInputValue", 5),
                implicitRecord("implicitReadValue", 6),
                implicitRecord("implicitValueSecond", 10)
            ];
        }
    };
    const sourceModel = {
        remote: false,
        completeMembers: () => null,
        visibleEntries: () => []
    };
    const parsedDocument = parseFreeBasicText(source);
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Variable: 1 },
        MarkdownString
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => sourceModel,
            getModel: () => sidecarModel
        },
        getParsedDocument: () => parsedDocument
    }, grammarData);

    const beforeDeclarationLine = lines[2];
    const beforeDeclarationItems = await provider.provideCompletionItems(document, {
        line: 2, character: beforeDeclarationLine.length
    });
    assert.deepEqual(beforeDeclarationItems, [], "a future implicit declaration is not visible yet");

    const assignmentLine = lines[4];
    const assignmentItems = await provider.provideCompletionItems(document, {
        line: 4, character: assignmentLine.length
    });
    assert.deepEqual(assignmentItems.map((item) => item.label), ["implicitValueFirst"]);
    assert.match(assignmentItems[0].detail, /As Integer/);
    assert.match(assignmentItems[0].detail, /storage: local/,
        "implicit-local completions should show the compiler-selected storage scope");

    const firstLine = lines[7];
    const firstItems = await provider.provideCompletionItems(document, { line: 7, character: firstLine.length });
    assert.deepEqual(firstItems.map((item) => item.label), [
        "implicitValueFirst", "implicitInputValue", "implicitReadValue"
    ]);

    const secondLine = lines[11];
    const secondItems = await provider.provideCompletionItems(document, { line: 11, character: secondLine.length });
    assert.deepEqual(secondItems.map((item) => item.label), ["implicitValueSecond"]);
    assert.equal(outlineQueries, 1, "completion should reuse the cached implicit-variable query for this snapshot");
});

test("stock-sidecar completion finds an implicit FBLite local first encountered by a read", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const source = [
        '#lang "fblite"',
        "Print implicitModuleFirstRead",
        "Print implicitModuleF",
        "Sub FirstReadCompletionProbe()",
        "    Print implicitFirstRead",
        "    Print implicitF",
        "End Sub",
        ""
    ].join("\n");
    const lines = source.split("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/fblite-first-read-completion.bas",
        toString: () => "file:///workspace/fblite-first-read-completion.bas" };
    let outlineQueries = 0;
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "compilerSidecarOutlineImplicitVariables");
            outlineQueries++;
            return [{
                name: "implicitModuleFirstRead",
                line: 1,
                startColumn: lines[1].indexOf("implicitModuleFirstRead"),
                endColumn: lines[1].indexOf("implicitModuleFirstRead") + "implicitModuleFirstRead".length,
                storageClass: "local",
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }, {
                name: "implicitFirstRead",
                line: 4,
                startColumn: lines[4].indexOf("implicitFirstRead"),
                endColumn: lines[4].indexOf("implicitFirstRead") + "implicitFirstRead".length,
                storageClass: "local",
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }];
        }
    };
    const sourceModel = {
        remote: false,
        completeMembers: () => null,
        visibleEntries: () => []
    };
    const parsedDocument = parseFreeBasicText(source);
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const workspaceIndex = {
        getParsedDocument: () => parsedDocument,
        getSemanticModel: () => sourceModel,
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    };
    workspaceIndex.compilerAnalysis = {
        index: workspaceIndex,
        analysisCompilerFor: () => ({ semanticModelOnly: true }),
        getModel: () => sidecarModel,
        getModelForEditor: async () => sourceModel
    };
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Variable: 1 },
        MarkdownString
    }, workspaceIndex, grammarData);

    const moduleCompletionLine = lines[2];
    const moduleItems = await provider.provideCompletionItems(document, {
        line: 2,
        character: moduleCompletionLine.length
    });
    assert.deepEqual(moduleItems.map((item) => [item.label, item.detail]), [[
        "implicitModuleFirstRead", "Variable As Integer (storage: local)"
    ]], "a module-scope first-read variable should be completed after its first occurrence");

    const completionLine = lines[5];
    const items = await provider.provideCompletionItems(document, {
        line: 5,
        character: completionLine.length
    });
    assert.deepEqual(items.map((item) => [item.label, item.detail]), [[
        "implicitFirstRead", "Variable As Integer (storage: local)"
    ]]);
    assert.equal(outlineQueries, 1,
        "the cached FBC declaration occurrence should support completion after a first-read declaration");
});

test("stock-sidecar completion suggests compiler-created SWAP locals", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const source = [
        "Sub SwapCompletionProbe()",
        "    Swap implicitSwapFirst, implicitSwapSecond",
        "    implicitSwap",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/swap-completion.bas",
        toString: () => "file:///workspace/swap-completion.bas" };
    const lines = source.split("\n");
    let outlineQueries = 0;
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "compilerSidecarOutlineImplicitVariables");
            outlineQueries++;
            return ["implicitSwapFirst", "implicitSwapSecond"].map((name) => ({
                name,
                line: 1,
                startColumn: lines[1].indexOf(name),
                endColumn: lines[1].indexOf(name) + name.length,
                storageClass: "local",
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }));
        }
    };
    const sourceModel = { remote: false, completeMembers: () => null, visibleEntries: () => [] };
    const analysisRequests = [];
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Variable: 1 },
        MarkdownString
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => sidecarModel,
            getModelForEditor(_document, _token, needTypes, needBindings) {
                analysisRequests.push([needTypes, needBindings]);
                return needBindings ? sidecarModel : sourceModel;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    }, grammarData);

    const completionLine = lines[2];
    const items = await provider.provideCompletionItems(document, {
        line: 2, character: completionLine.length
    });
    assert.deepEqual(items.map((item) => [item.label, item.detail]), [
        ["implicitSwapFirst", "Variable As Integer (storage: local)"],
        ["implicitSwapSecond", "Variable As Integer (storage: local)"]
    ]);
    assert.deepEqual(analysisRequests, [[false, false]]);
    assert.equal(outlineQueries, 1, "compound SWAP locals should use the cached implicit-variable records");
});

test("Using namespace completion excludes ordinary functions and API names", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return {
                member: false,
                hasDirectivePrefix: false,
                entries: [{
                    name: "FB",
                    declaration: { name: "FB", type: "namespace", detail: "Namespace", signature: "Namespace FB", parameters: [], modifiers: [] }
                }, {
                    name: "Sin",
                    declaration: { name: "Sin", type: "function", detail: "Function", signature: "Function Sin(ByVal angle As Double)", parameters: [], modifiers: [] }
                }]
            };
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, key === "intrinsicFunctions" ? ["Sin"] : []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Module: 1, Function: 2, Operator: 3, Keyword: 4, TypeParameter: 5, Struct: 6, Constant: 7 },
        MarkdownString
    }, { compilerAnalysis: { getModelForEditor: async () => model } }, grammarData);
    const document = createDocument("Using F");
    document.uri = { scheme: "file", fsPath: "/workspace/namespaces.bas", toString: () => "file:///workspace/namespaces.bas" };
    const items = await provider.provideCompletionItems(document, { line: 0, character: 7 });

    assert.deepEqual(items.map((item) => item.label), ["FB"]);
});

test("nested Using completion keeps only child namespaces", async () => {
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return {
                member: true,
                hasDirectivePrefix: false,
                entries: [{
                    name: "Inner",
                    declaration: { name: "Inner", type: "namespace", detail: "Namespace", signature: "Namespace Outer.Inner", parameters: [], modifiers: [] }
                }, {
                    name: "Run",
                    declaration: { name: "Run", type: "function", detail: "Function", signature: "Function Outer.Run()", parameters: [], modifiers: [] }
                }]
            };
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, key === "intrinsicFunctions" ? ["Sin"] : []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        CompletionItem,
        CompletionItemKind: { Module: 1, Function: 2, Operator: 3, Keyword: 4, TypeParameter: 5, Struct: 6, Constant: 7 },
        MarkdownString
    }, { compilerAnalysis: { getModelForEditor: async () => model } }, grammarData);
    const document = createDocument("Using Outer.");
    document.uri = { scheme: "file", fsPath: "/workspace/nested-using.bas", toString: () => "file:///workspace/nested-using.bas" };
    const items = await provider.provideCompletionItems(document, { line: 0, character: document.lineAt(0).text.length });

    assert.deepEqual(items.map((item) => item.label), ["Inner"]);
});

test("bundled type completions add their unique missing header and namespace", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class CompletionItem {
        constructor(label, kind) { Object.assign(this, { label, kind }); }
    }
    class MarkdownString {
        constructor(value = "") { this.value = value; }
    }
    class SnippetString {
        constructor(value = "") { this.value = value; }
        appendText(value) { this.value += value; }
        appendPlaceholder(value, index) { this.value += `\${${index}:${value}}`; }
        appendTabstop(index) { this.value += `\${${index}}`; }
    }
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "completion");
            return { member: false, hasDirectivePrefix: false, entries: [] };
        }
    };
    const index = { compilerAnalysis: { getModelForEditor: async () => model } };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
        ].map((key) => [key, key === "libraryTypes" ? ["Event"]
            : key === "bundledFunctions" ? ["Gfx3SurfaceLoad", "Serialize", "Deserialize"] : []]));
    const provider = createCompletionProvider({
        ...createVscodeMock(),
        Position,
        CompletionItem,
        SnippetString,
        CompletionItemKind: { Struct: 7 },
        MarkdownString,
        TextEdit: { insert: (position, newText) => ({ position, newText }) }
    }, index, grammarData);
    const makeDocument = (text, filePath) => {
        const document = createDocument(text);
        document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
        document.getWordRangeAtPosition = (position) => {
            const prefix = document.lineAt(position.line).text.slice(0, position.character);
            const match = /[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.exec(prefix);
            if (!match) return null;
            const start = position.character - match[0].length;
            return { start: new Position(position.line, start), end: new Position(position.line, position.character) };
        };
        document.positionAt = (offset) => {
            let remaining = offset;
            for (let line = 0; line < text.split("\n").length; line++) {
                const lineText = document.lineAt(line).text;
                if (remaining <= lineText.length) return new Position(line, remaining);
                remaining -= lineText.length + 1;
            }
            return new Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
        };
        return document;
    };
    const source = "Sub Main()\n    Dim currentEvent As Ev\nEnd Sub\n";
    const document = makeDocument(source, "/workspace/main.bas");
    let documentTextReads = 0;
    document.getText = () => { documentTextReads++; return source; };
    const items = await provider.provideCompletionItems(document, {
        line: 1,
        character: document.lineAt(1).text.length
    });
    const event = items.find((item) => item.label === "Event");

    assert.ok(event);
    assert.match(event.detail, /adds missing header\/namespace/i);
    assert.equal(event.additionalTextEdits.length, 1);
    assert.equal(event.additionalTextEdits[0].position.line, 0);
    assert.equal(event.additionalTextEdits[0].position.character, 0);
    assert.equal(event.additionalTextEdits[0].newText, '#include once "fbgfx.bi"\nUsing FB\n');
    assert.ok(documentTextReads <= 2,
        "bundled API import completion should reuse one source snapshot instead of rereading it per candidate");
    assert.match(provider.resolveCompletionItem(event).documentation.value, /Requires `#include once "fbgfx\.bi"`; namespace `FB`/);

    const langDocument = makeDocument('#lang "fblite"\nDim currentEvent As Ev\n', "/workspace/lang.bas");
    const langItems = await provider.provideCompletionItems(langDocument, {
        line: 1,
        character: langDocument.lineAt(1).text.length
    });
    const langEvent = langItems.find((item) => item.label === "Event");
    assert.equal(langEvent.additionalTextEdits[0].position.line, 1,
        "the import belongs after #lang and before the first source statement");
    assert.equal(langEvent.additionalTextEdits[0].position.character, 0);

    const functionDocument = makeDocument("Sub Main()\n    Gfx3Sur\nEnd Sub\n", "/workspace/graphics.bas");
    const functionItems = await provider.provideCompletionItems(functionDocument, {
        line: 1,
        character: functionDocument.lineAt(1).text.length
    });
    const surfaceLoad = functionItems.find((item) => item.label === "Gfx3SurfaceLoad");
    assert.ok(surfaceLoad?.insertText instanceof SnippetString);
    assert.equal(surfaceLoad.additionalTextEdits[0].newText, '#include once "fbgfx3.bi"\nUsing fb\n');
    assert.match(provider.resolveCompletionItem(surfaceLoad).documentation.value,
        /including `fbgfx3\.bi` selects and links gfxlib3; use `-gfx3`/i);

    const serializationDocument = makeDocument("Sub Main()\n    Serialize\nEnd Sub\n", "/workspace/serialization.bas");
    const serializationItems = await provider.provideCompletionItems(serializationDocument, {
        line: 1,
        character: serializationDocument.lineAt(1).text.length
    });
    const serialize = serializationItems.find((item) => item.label === "Serialize");
    assert.ok(serialize?.additionalTextEdits?.length === 1);
    assert.equal(serialize.additionalTextEdits[0].newText, '#include once "fbserialize.bi"\n');
    assert.match(provider.resolveCompletionItem(serialize).documentation.value, /Serialize\(value\)/);

    const deserializeDocument = makeDocument("Sub Main()\n    Deserialize\nEnd Sub\n", "/workspace/deserialization.bas");
    const deserializationItems = await provider.provideCompletionItems(deserializeDocument, {
        line: 1,
        character: deserializeDocument.lineAt(1).text.length
    });
    const deserialize = deserializationItems.find((item) => item.label === "Deserialize");
    assert.equal(deserialize.additionalTextEdits[0].newText, '#include once "fbserialize.bi"\n');
    assert.match(provider.resolveCompletionItem(deserialize).documentation.value, /Deserialize\(payload, destination\)/);

    const alreadyImported = makeDocument('#include once "fbgfx.bi"\nUsing FB\nSub Main()\n    Dim currentEvent As Ev\nEnd Sub\n', "/workspace/imported.bas");
    const importedItems = await provider.provideCompletionItems(alreadyImported, {
        line: 3,
        character: alreadyImported.lineAt(3).text.length
    });
    const importedEvent = importedItems.find((item) => item.label === "Event");
    assert.ok(importedEvent);
    assert.equal(importedEvent.additionalTextEdits, undefined,
        "completion should not repeat an existing header and namespace import");
    assert.doesNotMatch(importedEvent.detail, /adds missing header\/namespace/i);

    for (const [sourceText, completionLine, description] of [
        [
            '#include once "fbgfx.bi"\nSub Helper()\nUsing FB\nEnd Sub\nSub Main()\n    Dim currentEvent As Ev\nEnd Sub\n',
            5,
            "a Using scoped to another procedure does not satisfy this completion"
        ],
        [
            '#include once "fbgfx.bi"\n#if ENABLED\nUsing FB\n#endif\nSub Main()\n    Dim currentEvent As Ev\nEnd Sub\n',
            5,
            "a conditional Using does not suppress a safe unconditional import"
        ]
    ]) {
        const scopedImports = makeDocument(sourceText, "/workspace/scoped-imports.bas");
        const scopedItems = await provider.provideCompletionItems(scopedImports, {
            line: completionLine,
            character: scopedImports.lineAt(completionLine).text.length
        });
        const scopedEvent = scopedItems.find((item) => item.label === "Event");
        assert.equal(scopedEvent.additionalTextEdits[0].newText, "Using FB\n", description);
        assert.equal(scopedEvent.additionalTextEdits[0].position.line, 1);
    }

    const lateImports = makeDocument('Sub Main()\n    Dim currentEvent As Ev\nEnd Sub\n#include once "fbgfx.bi"\nUsing FB\n',
        "/workspace/late-imports.bas");
    const lateItems = await provider.provideCompletionItems(lateImports, {
        line: 1,
        character: lateImports.lineAt(1).text.length
    });
    const lateEvent = lateItems.find((item) => item.label === "Event");
    assert.equal(lateEvent.additionalTextEdits[0].newText, '#include once "fbgfx.bi"\nUsing FB\n',
        "later directives do not make their imports available to the current completion position");
});

test("hover requests the on-demand compiler model before using the heuristic fallback", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Print value\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const requestFlags = [];
    const compilerModel = {
        remote: false,
        expressionAt(uri, position) {
            assert.equal(uri, document.uri);
            assert.deepEqual(position, { line: 0, character: 6 });
            return { typeName: "Long", provisional: false };
        },
        compilerSidecarExpressionAlternativesAt: () => [],
        tokenAt: () => null,
        resolveAt: () => []
    };
    const index = {
        compilerAnalysis: {
            getModelForEditor: async (target, _token, needExpressionTypes) => {
                assert.equal(target, document);
                requestFlags.push(needExpressionTypes);
                return compilerModel;
            },
            getModel: () => null
        },
        getParsedDocument() { throw new Error("the source heuristic must not run when the compiler model is ready"); },
        async ensureInitialized() { return true; }
    };
    const vscode = { ...createVscodeMock(), MarkdownString, Hover };
    const hoverProvider = createHoverProvider(vscode, index, {});
    const hover = await hoverProvider.provideHover(document, { line: 0, character: 6 });

    assert.deepEqual(requestFlags, [false, true],
        "the provider first requests the native model and then asks for expression types");
    assert.match(hover.contents.value, /Compiler type: `Long`/);
});

test("hover explains compiler-accepted header linker inputs", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const document = createDocument('#Inclib "fixture"\n');
    document.uri = { scheme: "file", fsPath: "/workspace/link-inputs.bi", toString: () => "file:///workspace/link-inputs.bi" };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerHeaderLibraries: [
                    { kind: "inclib", value: "fixture" },
                    { kind: "libpath", value: "where`ever\t", filePath: "/workspace/graphics.bi" }
                ]
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: 4 });
    assert.match(hover.contents.value, /Compiler-accepted header linker inputs/);
    assert.match(hover.contents.value, /`#inclib "fixture"`/);
    assert.match(hover.contents.value, /``#libpath "where`ever\\t"`` from `"graphics\.bi"`/,
        "linker values should remain safe and readable when they contain Markdown or control characters");
});

test("hover explains compiler-selected compound assignment operands", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const document = createDocument("total += amount\n");
    document.uri = { scheme: "file", fsPath: "/workspace/compound-hover.bas", toString: () => "file:///workspace/compound-hover.bas" };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                occurrence: null,
                expression: null,
                expressionAlternatives: [],
                assignmentInput: {
                    operatorCode: "add",
                    operatorKind: "builtin",
                    leftTypeName: "Long",
                    rightTypeName: "Double",
                    resultTypeName: "Double",
                    targetTypeName: "Long"
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: 7 });
    assert.match(hover.contents.value, /Compiler-selected compound addition/);
    assert.match(hover.contents.value, /source operands `Long` and `Double`/);
    assert.match(hover.contents.value, /operation result `Double`; assigned to `Long`/);
    assert.match(hover.contents.value, /built-in/);
});

test("hover explains compiler-reported expression operands only on the operator", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "value = left + right\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/expression-operation-hover.bas", toString: () => "file:///workspace/expression-operation-hover.bas" };
    const operatorColumn = source.indexOf("+");
    const expression = {
        typeName: "Double",
        operatorKind: "builtin",
        provisional: false,
        sourceOperation: {
            family: "binary",
            operator: "add",
            physical: true,
            startLine: 1,
            startColumn: operatorColumn,
            endLine: 1,
            endColumn: operatorColumn + 1,
            leftTypeName: "Long",
            rightTypeName: "Double"
        }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression, expressionOperation: expression, expressionAlternatives: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const operatorHover = await provider.provideHover(document, { line: 0, character: operatorColumn });
    assert.match(operatorHover.contents.value, /Compiler addition \(built-in\)/);
    assert.match(operatorHover.contents.value, /operand types `Long` and `Double`; result type `Double`/);

    const operandHover = await provider.provideHover(document, { line: 0, character: source.indexOf("left") });
    assert.doesNotMatch(operandHover.contents.value, /Compiler addition/);
});

test("hover describes an explicit compiler-selected cast", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Print CInt(inputValue)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/explicit-cast-hover.bas",
        toString: () => "file:///workspace/explicit-cast-hover.bas" };
    const castColumn = source.indexOf("CInt");
    const expression = {
        typeName: "Integer",
        operatorKind: "builtin",
        provisional: false,
        sourceOperation: {
            family: "cast",
            operator: "cast",
            physical: true,
            startLine: 1,
            startColumn: castColumn,
            endLine: 1,
            endColumn: castColumn + "CInt".length,
            leftTypeName: "Double"
        }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression,
                expressionOperation: expression, expressionAlternatives: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const castHover = await provider.provideHover(document, { line: 0, character: castColumn + 1 });
    assert.match(castHover.contents.value,
        /Compiler conversion \(built-in\) with operand type `Double`; result type `Integer`\./);
    const operandHover = await provider.provideHover(document, {
        line: 0, character: source.indexOf("inputValue")
    });
    assert.doesNotMatch(operandHover.contents.value, /Compiler conversion/);
});

test("hover explains original IIf input types when branch conversions differ", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Dim conditional As Double = IIf(condition, CLng(1), CDbl(2))\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/iif-input-hover.bas",
        toString: () => "file:///workspace/iif-input-hover.bas" };
    const iifColumn = source.indexOf("IIf(");
    const expression = {
        typeName: "Double",
        provisional: false,
        compilerIifInputs: {
            conditionTypeName: "Boolean",
            trueTypeName: "Long",
            falseTypeName: "Double",
            resultTypeName: "Double"
        }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], occurrence: null, expression, expressionAlternatives: [] };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: iifColumn + 1 });
    assert.match(hover.contents.value,
        /Compiler IIf input types: condition `Boolean`, true arm `Long`, false arm `Double`; result `Double`\./);
});

test("hover shows compiler-selected numeric assignment destinations only for conversions", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Dim narrowed As Long = amount + 2\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/assignment-target-hover.bas",
        toString: () => "file:///workspace/assignment-target-hover.bas" };
    const expression = {
        typeName: "Double",
        provisional: false,
        compilerAssignmentTarget: {
            kind: "initializer",
            targetName: "narrowed",
            sourceTypeName: "Double",
            targetTypeName: "Long"
        }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], occurrence: null, expression, expressionAlternatives: [] };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: source.indexOf("+") });
    assert.match(hover.contents.value,
        /Compiler-selected initializer target `narrowed`: `Long` \(expression type `Double`\)\./);
});

test("hover names a nonnumeric compiler-selected assignment destination", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = 'Dim message As String = "hello"\n';
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/string-assignment-target.bas",
        toString: () => "file:///workspace/string-assignment-target.bas" };
    const expression = {
        typeName: "string",
        provisional: false,
        compilerAssignmentTarget: { kind: "initializer", targetName: "message" }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], occurrence: null, expression, expressionAlternatives: [] };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: source.indexOf("hello") + 1 });
    assert.match(hover.contents.value, /Compiler-selected initializer destination: `message`./);
});

test("hover labels a narrowed numeric function return as a return type", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Function narrowReturn() As Byte\n    Return wideValue\nEnd Function\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/function-return-hover.bas",
        toString: () => "file:///workspace/function-return-hover.bas" };
    const returnColumn = source.split("\n")[1].indexOf("wideValue");
    const expression = {
        typeName: "LongInt",
        provisional: false,
        compilerAssignmentTarget: {
            kind: "return",
            sourceTypeName: "LongInt",
            targetTypeName: "Byte"
        }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], occurrence: null, expression, expressionAlternatives: [] };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 1, character: returnColumn + 1 });
    assert.match(hover.contents.value,
        /Compiler-selected return type: `Byte` \(expression type `LongInt`\)\./);
    expression.compilerAssignmentTarget.kind = "function-result-assignment";
    const assignmentHover = await provider.provideHover(document, { line: 1, character: returnColumn + 1 });
    assert.match(assignmentHover.contents.value,
        /Compiler-selected function result type: `Byte` \(expression type `LongInt`\)\./);
});

test("hover explains the compiler's integer conversion of a floating array index", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Print values(floatingIndex)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/array-index-hover.bas",
        toString: () => "file:///workspace/array-index-hover.bas" };
    const indexColumn = source.indexOf("floatingIndex");
    const expression = {
        typeName: "double",
        provisional: false,
        compilerArrayIndex: { sourceTypeName: "double", targetTypeName: "integer" }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], occurrence: null, expression, expressionAlternatives: [] };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: indexColumn + 1 });
    assert.match(hover.contents.value,
        /Compiler converts this `double` expression to `integer` for array indexing\./);
});

test("hover distinguishes source operand types from compiler-selected binary operand types", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "result = signedValue < unsignedValue\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/numeric-selection-hover.bas",
        toString: () => "file:///workspace/numeric-selection-hover.bas" };
    const operatorColumn = source.indexOf("<");
    const expression = {
        typeName: "boolean",
        operatorKind: "builtin",
        provisional: false,
        sourceOperation: {
            family: "binary",
            operator: "less-than",
            physical: true,
            startLine: 1,
            startColumn: operatorColumn,
            endLine: 1,
            endColumn: operatorColumn + 1,
            leftTypeName: "Long",
            rightTypeName: "ULong"
        },
        compilerNumericOperands: {
            selectedLeftTypeName: "Integer",
            selectedRightTypeName: "Integer"
        }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression,
                expressionOperation: expression, expressionAlternatives: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const operatorHover = await provider.provideHover(document, { line: 0, character: operatorColumn });
    assert.match(operatorHover.contents.value,
        /Compiler-selected operand types: `Integer` and `Integer` \(source operand types: `Long` and `ULong`\)\./);
    const operandHover = await provider.provideHover(document, { line: 0, character: source.indexOf("signedValue") });
    assert.doesNotMatch(operandHover.contents.value, /Compiler-selected operand types/);
});

test("hover explains the compiler-selected SIZEOF input without suggesting evaluation", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Print SizeOf(make_pointer())\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/sizeof-input-hover.bas",
        toString: () => "file:///workspace/sizeof-input-hover.bas" };
    const sizeColumn = source.toLowerCase().indexOf("sizeof");
    const expression = {
        typeName: "integer",
        provisional: false,
        compilerSizeQuery: { inputTypeName: "long ptr" }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], occurrence: null, expression, expressionAlternatives: [] };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: sizeColumn + 1 });
    assert.match(hover.contents.value, /Compiler SIZEOF input type/);
    assert.match(hover.contents.value, /the expression is not evaluated\./);
    expression.compilerSizeQuery = { inputKind: "array", inputTypeName: "long ptr" };
    const arrayHover = await provider.provideHover(document, { line: 0, character: sizeColumn + 1 });
    assert.match(arrayHover.contents.value, /the result is total array storage\./);
});

test("hover explains FBC's integer conversion of an LBOUND or UBOUND dimension", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Print UBound(matrixValues, dimension)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/array-bound-hover.bas",
        toString: () => "file:///workspace/array-bound-hover.bas" };
    const queryColumn = source.indexOf("UBound");
    const expression = {
        typeName: "integer",
        provisional: false,
        compilerArrayBoundQuery: {
            kind: "upper",
            sourceTypeName: "Double",
            selectedValue: { kind: "signed", value: "2" }
        }
    };
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], occurrence: null, expression, expressionAlternatives: [] };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: queryColumn + 1 });
    assert.match(hover.contents.value, /Compiler converts this UBOUND dimension from/);
    assert.match(hover.contents.value, /compiler-selected dimension:.*2/);
});

test("hover explains compiler-reported Cva_Arg operand and result types", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Print Cva_Arg(arguments, Integer)\nCva_Start(arguments, count)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/cva-arg-hover.bas",
        toString: () => "file:///workspace/cva-arg-hover.bas" };
    const operationColumn = source.indexOf("Cva_Arg");
    const expression = {
        typeName: "integer",
        operatorKind: "none",
        provisional: false,
        sourceOperation: {
            family: "runtime-macro",
            operator: "va-arg",
            physical: true,
            startLine: 1,
            startColumn: operationColumn,
            endLine: 1,
            endColumn: operationColumn + "Cva_Arg".length,
            leftTypeName: "__VA_LIST_TAG"
        }
    };
    const startLine = source.split("\n")[1];
    const startColumn = startLine.indexOf("Cva_Start");
    const startExpression = {
        typeName: "",
        operatorKind: "none",
        provisional: false,
        sourceOperation: {
            family: "runtime-macro",
            operator: "va-start",
            physical: true,
            startLine: 2,
            startColumn,
            endLine: 2,
            endColumn: startColumn + "Cva_Start".length,
            leftTypeName: "__VA_LIST_TAG",
            rightTypeName: "integer"
        }
    };
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const operationExpression = position.line === 1 ? startExpression : expression;
            return {
                entries: [], occurrence: null,
                expression: position.line === 1 ? null : expression,
                expressionOperation: operationExpression,
                expressionAlternatives: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: operationColumn + 2 });
    assert.match(hover.contents.value,
        /Compiler C vararg extraction with operand type `__VA_LIST_TAG`; result type `integer`\./);
    const startHover = await provider.provideHover(document, { line: 1, character: startColumn + 2 });
    assert.match(startHover.contents.value,
        /Compiler C vararg initialization with operand types `__VA_LIST_TAG` and `integer`\./);
    assert.doesNotMatch(startHover.contents.value, /result type/,
        "statement operations without a compiler result type must not get one guessed");
});

test("hover identifies compiler-selected array storage for an array bound query", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Print UBound(item.fixed_values)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/array-storage-hover.bas",
        toString: () => "file:///workspace/array-storage-hover.bas" };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                arrayStorageSelection: {
                    kind: "field",
                    name: "fixed_values",
                    compilerFacts: {
                        arrayBounds: {
                            mode: "bounds", rank: 1,
                            dimensions: [{ dimension: 0, kind: "fixed", lower: 0, upper: 3 }]
                        },
                        properties: [{ name: "array-elements", value: "4", provisional: false }],
                        storageType: {
                            primitive: "long", storageBytes: 4, pointerDepth: 0, isReference: false
                        }
                    }
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: source.indexOf("fixed_values") + 2 });
    assert.match(hover.contents.value, /Compiler-selected array storage: field `fixed_values`\./);
    assert.match(hover.contents.value, /Compiler-selected array bounds in this build: `0 to 3`/);
    assert.match(hover.contents.value,
        /Compiler-selected fixed-array element storage: 4 elements × 4 bytes = 16 bytes/);
});

test("hover presents compiler-confirmed field offset and visibility from the stock sidecar", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Type FieldOwner\n    fieldValue As Long\nEnd Type\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/field-layout-hover.bas",
        toString: () => "file:///workspace/field-layout-hover.bas" };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerFieldFacts: {
                    fieldLayout: { byteOffset: 4 },
                    compilerVisibility: "protected",
                    properties: [],
                    storageType: { primitive: "long", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 1, character: "    ".length + 2 });
    assert.match(hover.contents.value,
        /Compiler-selected field offset: `4 bytes` from the start of its containing aggregate/);
    assert.match(hover.contents.value, /Compiler-selected visibility: `protected`./);
});

test("stock-sidecar aggregate declaration hover requests compiler target layout facts", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Type SidecarWidget Extends SidecarBase\nEnd Type\nDim widgetValue As SidecarWidget\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/aggregate-layout-request.bas",
        toString: () => "file:///workspace/aggregate-layout-request.bas" };
    const requests = [];
    const declaration = {
        type: "type", name: "SidecarWidget", detail: "Type", line: 0,
        startColumn: "Type ".length, endColumn: "Type SidecarWidget".length,
        baseType: "SidecarBase",
        signature: "Type SidecarWidget"
    };
    const model = {
        remote: false,
        semanticSidecarOnly: false,
        resolveAt: () => [{ name: declaration.name, declaration, uri: document.uri }],
        tokenAt: () => null
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerAggregateFacts: {
                    baseType: "SidecarBase",
                    aggregateSizeBytes: 16,
                    abstractMemberCount: 2,
                    aggregateAccess: {
                        bodyStatement: 1,
                        count: 2,
                        sections: [
                            { ordinal: 1, statement: 2, visibility: "protected" },
                            { ordinal: 2, statement: 3, visibility: "private" }
                        ]
                    },
                    properties: [
                        { name: "natural-alignment", value: "8", provisional: false },
                        { name: "packing-alignment", value: "4", provisional: false }
                    ]
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes ? sidecar : model;
            }
        },
        getSemanticModel: () => model
    }, {});

    const hover = await provider.provideHover(document, {
        line: 0, character: declaration.startColumn + 2
    });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "aggregate layout should be fetched only when the user hovers an aggregate declaration");
    assert.match(hover.contents.value, /Compiler-selected aggregate layout in this target: `16 bytes`/);
    assert.match(hover.contents.value, /Compiler-selected base type: `SidecarBase`./);
    assert.equal((hover.contents.value.match(/Compiler-selected base type/g) || []).length, 1,
        "the compiler-confirmed base type should appear once in hover details");
    assert.match(hover.contents.value, /Compiler-selected natural alignment: `8 bytes`/);
    assert.match(hover.contents.value, /Compiler reports 2 unimplemented abstract members/);
    assert.match(hover.contents.value, /Compiler-confirmed member access sections: Protected, Private\./);
});

test("hover explains whether the compiler assigned an enum value implicitly", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Enum SidecarSequence\n    firstValue = 10\n    nextValue\nEnd Enum\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/enum-origin-hover.bas",
        toString: () => "file:///workspace/enum-origin-hover.bas" };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerEnumElementFacts: { explicit: false, ordinal: 2 }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 2, character: "    ".length + 2 });
    assert.match(hover.contents.value,
        /Compiler confirms this enum value was assigned implicitly \(member 2\)\./);
});

test("stock-sidecar parameter declaration hover reports compiler-selected passing mode", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Sub Take(Optional count As Integer = 1)\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/parameter-mode-request.bas",
        toString: () => "file:///workspace/parameter-mode-request.bas" };
    document.positionAt = (offset) => {
        const before = source.slice(0, offset);
        const lineStart = before.lastIndexOf("\n") + 1;
        return { line: before.split("\n").length - 1, character: offset - lineStart };
    };
    const requests = [];
    const startColumn = source.indexOf("count");
    const declaration = {
        type: "parameter", name: "count", line: 0, startColumn,
        endColumn: startColumn + "count".length, signature: "Optional count As Integer = 1"
    };
    const model = {
        remote: false,
        semanticSidecarOnly: false,
        resolveAt: () => [{ name: "count", declaration, uri: document.uri }],
        tokenAt: () => null
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerParameterFacts: {
                    parameterPassing: { mode: "byval", dimensions: 0, optional: true, receiver: false },
                    properties: [{ name: "formal-written-mode", value: "0", provisional: false }]
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes ? sidecar : model;
            }
        },
        getSemanticModel: () => model
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: startColumn + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "parameter mode details should use a full sidecar only at the parameter declaration");
    assert.match(hover.contents.value,
        /Compiler-selected parameter passing: ByVal \(default; keyword not written\)\. Optional parameter\./);
});

test("stock-sidecar parameter refactor writes the compiler-selected default passing mode", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = "Declare Sub SidecarModeProbe(value As Integer)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-parameter-mode-refactor.bas",
        toString: () => "file:///workspace/stock-parameter-mode-refactor.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const startColumn = source.indexOf("value");
    let writtenMode = "0";
    let receiver = false;
    let parameterMode = "byval";
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerParameterFacts: {
                    parameterPassing: { mode: parameterMode, dimensions: 0, optional: false, receiver },
                    properties: [{ name: "formal-written-mode", value: writtenMode }]
                },
                compilerParameterDeclarationRange: {
                    line: 0, startColumn, endColumn: startColumn + "value".length
                }
            };
        }
    };
    const analysisRequests = [];
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const modeWarning = {
        source: "fbc",
        severity: 1,
        message: "No explicit BYREF or BYVAL, at parameter 1 (value) of SidecarModeProbe()",
        range: new Range(0, startColumn, 0, startColumn + "value".length)
    };
    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "value".length), { diagnostics: [modeWarning] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make parameter passing mode explicit as 'ByVal'");
    assert.equal(actions[0].kind, "quickfix");
    assert.deepEqual(actions[0].diagnostics, [modeWarning]);
    assert.equal(actions[0].isPreferred, true);
    assert.deepEqual(actions[0].edit.insertion.position, { line: 0, character: startColumn });
    assert.equal(actions[0].edit.insertion.text, "ByVal ");

    writtenMode = "1";
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "value".length), { diagnostics: [] }), [],
    "an explicitly written mode should not be duplicated");
    writtenMode = "0";
    receiver = true;
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "value".length), { diagnostics: [] }), [],
    "a receiver parameter should not receive an explicit passing-mode edit");

    receiver = false;
    parameterMode = "byref";
    const byRefActions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "value".length), { diagnostics: [modeWarning] });
    assert.equal(byRefActions.length, 1);
    assert.equal(byRefActions[0].title, "Make parameter passing mode explicit as 'ByRef'");
    assert.equal(byRefActions[0].kind, "quickfix");
    assert.equal(byRefActions[0].edit.insertion.text, "ByRef ");
});

test("stock-sidecar parameter refactor writes FBC's implicit parameter type", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const source = [
        "Declare Sub SidecarImplicitTypeProbe(ByVal value)",
        "Declare Sub SidecarSuffixTypeProbe(ByVal suffixValue%)",
        "Declare Sub SidecarImplicitByRefTypeProbe(ByRef referenceValue)",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-parameter-type-refactor.bas",
        toString: () => "file:///workspace/stock-parameter-type-refactor.bas" };
    document.version = 1;
    const lineOffsets = [0, ...[...source.matchAll(/\n/g)].map((match) => match.index + 1)];
    document.positionAt = (offset) => {
        const line = lineOffsets.findLastIndex((lineOffset) => lineOffset <= offset);
        return { line, character: offset - lineOffsets[line] };
    };
    const implicitStartColumn = source.split("\n")[0].indexOf("value");
    const suffixStartColumn = source.split("\n")[1].indexOf("suffixValue");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const suffixType = position.line === 1;
            const byRefType = position.line === 2;
            const parameterName = suffixType ? "suffixValue%" : byRefType ? "referenceValue" : "value";
            const startColumn = suffixType ? suffixStartColumn : byRefType
                ? source.split("\n")[2].indexOf("referenceValue")
                : implicitStartColumn;
            return {
                entries: [],
                compilerParameterFacts: {
                    parameterPassing: {
                        mode: byRefType ? "byref" : "byval", dimensions: 0, optional: false, receiver: false
                    },
                    properties: [{ name: "formal-written-mode", value: "1" }],
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    formalWrittenTypes: [suffixType ? "suffix" : "implicit"]
                },
                compilerParameterDeclarationRange: {
                    line: position.line, startColumn, endColumn: startColumn + parameterName.length
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, implicitStartColumn, 0, implicitStartColumn + "value".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Add explicit parameter type 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, {
        line: 0, character: implicitStartColumn + "value".length
    });
    assert.equal(actions[0].edit.insertion.text, " As Integer");

    const suffixActions = await provider.provideCodeActions(document,
        new Range(1, suffixStartColumn, 1, suffixStartColumn + "suffixValue%".length), { diagnostics: [] });
    assert.equal(suffixActions.length, 1);
    assert.equal(suffixActions[0].title, "Replace parameter type suffix with 'As Integer'");
    assert.deepEqual(suffixActions[0].edit.replacement.range,
        new Range(1, suffixStartColumn + "suffixValue".length,
            1, suffixStartColumn + "suffixValue%".length));
    assert.equal(suffixActions[0].edit.replacement.text, " As Integer");

    const byRefName = "referenceValue";
    const byRefStartColumn = source.split("\n")[2].indexOf(byRefName);
    const byRefActions = await provider.provideCodeActions(document,
        new Range(2, byRefStartColumn, 2, byRefStartColumn + byRefName.length), { diagnostics: [] });
    assert.equal(byRefActions.length, 1);
    assert.equal(byRefActions[0].title, "Add explicit parameter type 'Integer'");
    assert.deepEqual(byRefActions[0].edit.insertion.position, {
        line: 2, character: byRefStartColumn + byRefName.length
    });
    assert.equal(byRefActions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar adds an implicit parameter type in a continued procedure header", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const source = [
        "Sub ContinuedParameterRefactorProbe( _",
        "    ByVal firstParameter, _",
        "    ByVal secondParameter, _",
        "    arrayValues( _",
        "    ), _",
        "    suffixArray%( _",
        "    ) _",
        ")",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/continued-parameter-type-refactor.bas",
        toString: () => "file:///workspace/continued-parameter-type-refactor.bas" };
    const lineOffsets = [0, ...[...source.matchAll(/\n/g)].map((match) => match.index + 1)];
    document.offsetAt = (position) => lineOffsets[position.line] + position.character;
    document.positionAt = (offset) => {
        const line = lineOffsets.findLastIndex((lineOffset) => lineOffset <= offset);
        return { line, character: offset - lineOffsets[line] };
    };
    const line = 2;
    const name = "secondParameter";
    const startColumn = document.lineAt(line).text.indexOf(name);
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const parameterName = position.line === 2 ? name : position.line === 3 ? "arrayValues" : "suffixArray%";
            const parameterStartColumn = document.lineAt(position.line).text.indexOf(parameterName);
            return {
                entries: [],
                compilerParameterFacts: {
                    parameterPassing: position.line === 2
                        ? { mode: "byval", dimensions: 0, optional: false, receiver: false }
                        : { mode: "bydesc", dimensions: -1, optional: false, receiver: false },
                    properties: [{ name: "formal-written-mode", value: position.line === 2 ? "1" : "0" }],
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    formalWrittenTypes: [position.line === 5 ? "suffix" : "implicit"]
                },
                compilerParameterDeclarationRange: {
                    line: position.line,
                    startColumn: parameterStartColumn,
                    endColumn: parameterStartColumn + parameterName.length
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Add explicit parameter type 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, {
        line,
        character: startColumn + name.length
    });
    assert.equal(actions[0].edit.insertion.text, " As Integer");

    const arrayLine = 3;
    const arrayName = "arrayValues";
    const arrayStartColumn = document.lineAt(arrayLine).text.indexOf(arrayName);
    const arrayActions = await provider.provideCodeActions(document,
        new Range(arrayLine, arrayStartColumn, arrayLine, arrayStartColumn + arrayName.length), { diagnostics: [] });
    assert.equal(arrayActions.length, 1);
    assert.equal(arrayActions[0].title, "Add explicit parameter type 'Integer'");
    assert.deepEqual(arrayActions[0].edit.insertion.position, {
        line: 4, character: document.lineAt(4).text.indexOf(")") + 1
    });
    assert.equal(arrayActions[0].edit.insertion.text, " As Integer");

    const suffixArrayLine = 5;
    const suffixArrayName = "suffixArray%";
    const suffixArrayStartColumn = document.lineAt(suffixArrayLine).text.indexOf(suffixArrayName);
    const suffixArrayActions = await provider.provideCodeActions(document,
        new Range(suffixArrayLine, suffixArrayStartColumn,
            suffixArrayLine, suffixArrayStartColumn + suffixArrayName.length), { diagnostics: [] });
    assert.equal(suffixArrayActions.length, 1);
    assert.equal(suffixArrayActions[0].title, "Replace parameter type suffix with 'As Integer'");
    assert.deepEqual(suffixArrayActions[0].edit.deletion.range,
        new Range(suffixArrayLine, suffixArrayStartColumn + "suffixArray".length,
            suffixArrayLine, suffixArrayStartColumn + suffixArrayName.length));
    assert.deepEqual(suffixArrayActions[0].edit.insertion.position, {
        line: 6, character: document.lineAt(6).text.indexOf(")") + 1
    });
    assert.equal(suffixArrayActions[0].edit.insertion.text, " As Integer");
});

test("continued parameter-mode warning offers a compiler-confirmed Quick Fix", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        "Sub ContinuedModeProbe( _",
        "    firstValue As Integer, _",
        "    secondValue As Integer _",
        ")",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/continued-parameter-mode-quickfix.bas",
        toString: () => "file:///workspace/continued-parameter-mode-quickfix.bas" };
    document.version = 1;
    const lineOffsets = [0, ...[...source.matchAll(/\n/g)].map((match) => match.index + 1)];
    document.offsetAt = (position) => lineOffsets[position.line] + position.character;
    document.positionAt = (offset) => {
        const line = lineOffsets.findLastIndex((lineOffset) => lineOffset <= offset);
        return { line, character: offset - lineOffsets[line] };
    };
    const line = 2;
    const name = "secondValue";
    const startColumn = document.lineAt(line).text.indexOf(name);
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerParameterFacts: {
                    parameterPassing: { mode: "byval", dimensions: 0, optional: false, receiver: false },
                    properties: [{ name: "formal-written-mode", value: "0", provisional: false }],
                    formalWrittenTypes: ["as"]
                },
                compilerParameterDeclarationRange: {
                    line, startColumn, endColumn: startColumn + name.length
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });
    const warning = {
        source: "fbc (buffer)",
        severity: 1,
        message: "No explicit BYREF or BYVAL, at parameter 2 (secondValue) of ContinuedModeProbe()",
        range: new Range(line, startColumn, line, startColumn + name.length)
    };

    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [warning] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make parameter passing mode explicit as 'ByVal'");
    assert.equal(actions[0].kind, "quickfix");
    assert.deepEqual(actions[0].diagnostics, [warning]);
    assert.deepEqual(actions[0].edit.insertion.position, { line, character: startColumn });
    assert.equal(actions[0].edit.insertion.text, "ByVal ");

    const unrelatedWarning = {
        ...warning,
        message: "No explicit BYREF or BYVAL, at parameter 1 (firstValue) of ContinuedModeProbe()"
    };
    const unrelatedActions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [unrelatedWarning] });
    assert.equal(unrelatedActions.length, 1);
    assert.equal(unrelatedActions[0].kind, "refactor.rewrite",
        "a warning for another parameter must not be attached to this Quick Fix");
    assert.equal(unrelatedActions[0].diagnostics, undefined);
});

test("stock-sidecar parameter refactor places an implicit array type after its rank", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = "Declare Sub SidecarImplicitArrayTypeProbe(values())\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-array-parameter-type.bas",
        toString: () => "file:///workspace/stock-array-parameter-type.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const startColumn = source.indexOf("values");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerParameterFacts: {
                    parameterPassing: { mode: "bydesc", dimensions: -1, optional: false, receiver: false },
                    properties: [{ name: "formal-written-mode", value: "0" }],
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    formalWrittenTypes: ["implicit"]
                },
                compilerParameterDeclarationRange: {
                    line: 0, startColumn, endColumn: startColumn + "values".length
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "values".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Add explicit parameter type 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, {
        line: 0, character: source.indexOf("values()") + "values()".length
    });
    assert.equal(actions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar procedure declaration hover reports compiler-selected ABI", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Declare Function AbiProbe Cdecl() ByRef As Integer\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/procedure-abi-request.bas",
        toString: () => "file:///workspace/procedure-abi-request.bas" };
    const requests = [];
    const startColumn = source.indexOf("AbiProbe");
    const declaration = {
        type: "function", name: "AbiProbe", line: 0, startColumn,
        endColumn: startColumn + "AbiProbe".length, signature: source.trim()
    };
    const model = {
        remote: false,
        semanticSidecarOnly: false,
        resolveAt: () => [{ name: "AbiProbe", declaration, uri: document.uri }],
        tokenAt: () => null
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerProcedureFacts: {
                    procedureCallingConvention: "cdecl",
                    procedureReturnsByReference: true,
                    properties: [{ name: "procedure-linkage", value: "c", provisional: false }],
                    procedureAbiPolicyInputs: [{ writtenConvention: true, managedString: false, provisional: false }]
                },
                compilerProcedureVisibilityFacts: {
                    compilerVisibility: "private",
                    procedureWrittenVisibility: [{ statement: 1, visibility: "private", provisional: false }],
                    procedureTypingInputs: [{ statement: 1, role: "prototype", kind: "function",
                        resultForm: "as", provisional: false }]
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes ? sidecar : model;
            }
        },
        getSemanticModel: () => model
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: startColumn + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "procedure ABI details should be loaded only when hovering a procedure declaration");
    assert.match(hover.contents.value,
        /Compiler-selected procedure ABI: C linkage, cdecl calling convention, ByRef return\./);
    assert.match(hover.contents.value, /Compiler-selected visibility: `private`\./);
});

test("stock-sidecar implicit assignment hover reports compiler-selected storage class", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Sub StorageProbe()\n    implicitLocal = 1\n    Input \"Prompt: \"; implicitInput\n    Get #1, , implicitGetValue\n    implicitCompound _\n        += 1\n    For implicitCounter = 1 To 2\n    Next implicitCounter\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-storage-hover.bas",
        toString: () => "file:///workspace/implicit-storage-hover.bas" };
    const requests = [];
    const model = {
        remote: false,
        semanticSidecarOnly: false,
        resolveAt: () => [],
        tokenAt: () => null
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    properties: []
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes ? sidecar : model;
            }
        },
        getSemanticModel: () => model
    }, {});

    const hover = await provider.provideHover(document, {
        line: 1, character: "    ".length + 2
    });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "an assignment-target hover should request FBC's storage fact for an unresolved name");
    assert.match(hover.contents.value, /Compiler-selected variable type: `Integer`\./);
    assert.match(hover.contents.value, /Compiler-selected storage class: `local`\./);

    requests.length = 0;
    const inputColumn = source.split("\n")[2].indexOf("implicitInput");
    const inputHover = await provider.provideHover(document, { line: 2, character: inputColumn + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "hover on a compiler-created INPUT target should request its type and storage facts");
    assert.match(inputHover.contents.value, /Compiler-selected variable type: `Integer`\./);
    assert.match(inputHover.contents.value, /Compiler-selected storage class: `local`\./);

    requests.length = 0;
    const getLine = source.split("\n")[3];
    const getColumn = getLine.indexOf("implicitGetValue");
    const getHover = await provider.provideHover(document, { line: 3, character: getColumn + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "hover on a compiler-created GET destination should request its type and storage facts");
    assert.match(getHover.contents.value, /Compiler-selected variable type: `Integer`\./);
    assert.match(getHover.contents.value, /Compiler-selected storage class: `local`\./);

    requests.length = 0;
    const compoundLine = source.split("\n")[4];
    const compoundColumn = compoundLine.indexOf("implicitCompound");
    const compoundHover = await provider.provideHover(document, { line: 4, character: compoundColumn + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "hover on a compiler-created compound-assignment target should request type and storage facts");
    assert.match(compoundHover.contents.value, /Compiler-selected variable type: `Integer`\./);
    assert.match(compoundHover.contents.value, /Compiler-selected storage class: `local`\./);

    requests.length = 0;
    const forLine = source.split("\n")[6];
    const forColumn = forLine.indexOf("implicitCounter");
    const forHover = await provider.provideHover(document, { line: 6, character: forColumn + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "hover on a compiler-created FOR counter should request its type and storage facts");
    assert.match(forHover.contents.value, /Compiler-selected variable type: `Integer`\./);
    assert.match(forHover.contents.value, /Compiler-selected storage class: `local`\./);
});

test("stock-sidecar hover resolves an implicit FBLite variable at its first read", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = '#lang "fblite"\nPrint implicitFirstRead\n';
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/fblite-first-read-hover.bas",
        toString: () => "file:///workspace/fblite-first-read-hover.bas" };
    const requests = [];
    const sourceModel = {
        resolveAt: () => [],
        tokenAt: () => null
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                occurrence: null,
                expression: null,
                expressionAlternatives: [],
                compilerStorageClass: "global",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    properties: []
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => sourceModel,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes && needSemanticBindings ? sidecar : sourceModel;
            }
        },
        getSemanticModel: () => sourceModel
    }, {});

    const column = document.lineAt(1).text.indexOf("implicitFirstRead");
    const hover = await provider.provideHover(document, { line: 1, character: column + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "hovering an unresolved variable in FBLite should request its compiler declaration facts");
    assert.match(hover.contents.value, /Compiler-selected variable type: `Integer`\./);
    assert.match(hover.contents.value, /Compiler-selected storage class: `global`\./);
});

test("stock-sidecar hover follows a REM identifier accepted by a conditional NOKEYWORD option", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemIdentifierProbe()",
        "    Dim REM As Integer",
        "    REM = 1",
        "    Print REM",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/conditional-rem-hover.bas",
        toString: () => "file:///workspace/conditional-rem-hover.bas" };
    const requests = [];
    const sourceModel = { resolveAt: () => [], tokenAt: () => null };
    const name = "REM";
    const declaration = {
        name,
        type: "variable",
        detail: "Variable As Integer",
        typeName: "integer",
        line: 5,
        startColumn: 8,
        endColumn: 8 + name.length,
        signature: "variable REM As integer",
        modifiers: [],
        parameters: []
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [{ name, declaration, compilerFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    compilerStorageClass: "local"
                }, uri: document.uri }],
                occurrence: null,
                expression: null,
                expressionAlternatives: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    properties: []
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => sourceModel,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes && needSemanticBindings ? sidecar : sourceModel;
            }
        },
        getSemanticModel: () => sourceModel
    }, {});

    const line = 7;
    const column = document.lineAt(line).text.lastIndexOf(name);
    const hover = await provider.provideHover(document, { line, character: column + 1 });
    assert.deepEqual(requests, [[false, true], [true, true]],
        "a keyword-looking token after NOKEYWORD should request an exact compiler binding");
    assert.match(hover.contents.value, /variable REM As integer/);
});

test("stock-sidecar hover uses compiler bindings for keyword and runtime spellings accepted by NOKEYWORD", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = [
        '#lang "deprecated"',
        "Option NoKeyword Abs",
        "Sub AbsIdentifierProbe()",
        "    Dim Abs As Integer",
        "    Abs = Abs + 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/nokeyword-abs-hover.bas",
        toString: () => "file:///workspace/nokeyword-abs-hover.bas" };
    const requests = [];
    const sourceModel = { resolveAt: () => [], tokenAt: () => null };
    const name = "Abs";
    const declaration = {
        name,
        type: "variable",
        detail: "Variable As Integer",
        typeName: "integer",
        line: 3,
        startColumn: 8,
        endColumn: 8 + name.length,
        signature: "variable Abs As integer",
        modifiers: [],
        parameters: []
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [{ name, declaration, compilerFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    compilerStorageClass: "local"
                }, uri: document.uri }],
                occurrence: null,
                expression: null,
                expressionAlternatives: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    properties: []
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => sourceModel,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes && needSemanticBindings ? sidecar : sourceModel;
            }
        },
        getSemanticModel: () => sourceModel
    }, {});

    const line = 4;
    const column = document.lineAt(line).text.lastIndexOf(name);
    const position = { line, character: column + 1 };
    const offsetAt = document.offsetAt;
    document.offsetAt = (actual) => {
        assert.equal(actual, position, "offsetAt must receive the editor's Position, not a synthesized plain object");
        return offsetAt(actual);
    };
    const hover = await provider.provideHover(document, position);
    assert.deepEqual(requests, [[false, false], [true, true]],
        "an unresolved keyword spelling after NOKEYWORD should request exact compiler bindings");
    assert.match(hover.contents.value, /variable Abs As integer/);
});

test("stock-sidecar inlays compiler-selected types at implicit assignment, compound, SWAP, LSET, and RSET targets", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = "Sub StorageProbe()\n    implicitLocal = 1\n    implicitCompound = 1\n    Swap implicitSwapFirst, implicitSwapSecond\n    LSet implicitLeftText = \"left\"\n    RSet implicitRightText = \"right\"\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-implicit-local-inlay.bas",
        toString: () => "file:///workspace/stock-implicit-local-inlay.bas" };
    const assignmentLine = 1;
    const lineText = document.lineAt(assignmentLine).text;
    const startColumn = lineText.indexOf("implicitLocal");
    const compoundAssignmentLine = 2;
    const compoundLineText = document.lineAt(compoundAssignmentLine).text;
    const compoundStartColumn = compoundLineText.indexOf("implicitCompound");
    const swapLine = 3;
    const swapLineText = document.lineAt(swapLine).text;
    const firstSwapStart = swapLineText.indexOf("implicitSwapFirst");
    const secondSwapStart = swapLineText.indexOf("implicitSwapSecond");
    const lsetLine = 4;
    const lsetLineText = document.lineAt(lsetLine).text;
    const leftTextStart = lsetLineText.indexOf("implicitLeftText");
    const rsetLine = 5;
    const rsetLineText = document.lineAt(rsetLine).text;
    const rightTextStart = rsetLineText.indexOf("implicitRightText");
    const analysisRequests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            const implicitVariables = [{
                position: { line: assignmentLine, character: startColumn + "implicitLocal".length },
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }, {
                position: {
                    line: compoundAssignmentLine,
                    character: compoundStartColumn + "implicitCompound".length
                },
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }, {
                    position: { line: swapLine, character: firstSwapStart + "implicitSwapFirst".length },
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }, {
                    position: { line: swapLine, character: secondSwapStart + "implicitSwapSecond".length },
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }, {
                    position: { line: lsetLine, character: leftTextStart + "implicitLeftText".length },
                    storageType: { primitive: "string", storageBytes: 12, pointerDepth: 0, isReference: false }
                }, {
                    position: { line: rsetLine, character: rightTextStart + "implicitRightText".length },
                    storageType: { primitive: "string", storageBytes: 12, pointerDepth: 0, isReference: false }
                }];
            return {
                types: [],
                implicitVariables: implicitVariables.filter((hint) =>
                    hint.position.line >= input.position.line && hint.position.line <= input.end.line
                ),
                parameters: [],
                forEntries: [],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({
            resolveAt(uri) {
                return uri.fsPath.endsWith("declared-local-inlay.bas")
                    ? [{ declaration: { type: "variable" } }]
                    : [];
            }
        })
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line: assignmentLine, character: 0 },
        end: { line: assignmentLine, character: lineText.length }
    });
    assert.deepEqual(analysisRequests, [[false, true]],
        "implicit-local types should request binding-capable stock-sidecar analysis only at potential targets");
    assert.deepEqual(hints.map((hint) => [hint.label, hint.position]), [[
        ": Integer", new Position(assignmentLine, startColumn + "implicitLocal".length)
    ]]);
    assert.ok(hints.every((hint) => /compiler-selected type: Integer/.test(hint.tooltip)));

    const compoundHints = await provider.provideInlayHints(document, {
        start: { line: compoundAssignmentLine, character: 0 },
        end: { line: compoundAssignmentLine, character: compoundLineText.length }
    });
    assert.deepEqual(analysisRequests, [[false, true], [false, true]],
        "a compound-assignment-only range should trigger the binding-capable type query");
    assert.equal(compoundHints.length, 1);
    assert.deepEqual(compoundHints[0].position,
        new Position(compoundAssignmentLine, compoundStartColumn + "implicitCompound".length));

    const swapHints = await provider.provideInlayHints(document, {
        start: { line: swapLine, character: 0 },
        end: { line: swapLine, character: swapLineText.length }
    });
    assert.deepEqual(analysisRequests, [[false, true], [false, true], [false, true]],
        "a SWAP-only range should request the binding-capable type query");
    assert.deepEqual(swapHints.map((hint) => hint.position), [
        new Position(swapLine, firstSwapStart + "implicitSwapFirst".length),
        new Position(swapLine, secondSwapStart + "implicitSwapSecond".length)
    ]);

    const lsetHints = await provider.provideInlayHints(document, {
        start: { line: lsetLine, character: 0 }, end: { line: lsetLine, character: lsetLineText.length }
    });
    const rsetHints = await provider.provideInlayHints(document, {
        start: { line: rsetLine, character: 0 }, end: { line: rsetLine, character: rsetLineText.length }
    });
    assert.deepEqual(analysisRequests, [
        [false, true], [false, true], [false, true], [false, true], [false, true]
    ], "LSET and RSET targets should request exact compiler type facts");
    assert.deepEqual(lsetHints.map((hint) => [hint.label, hint.position]), [[
        ": String", new Position(lsetLine, leftTextStart + "implicitLeftText".length)
    ]]);
    assert.deepEqual(rsetHints.map((hint) => [hint.label, hint.position]), [[
        ": String", new Position(rsetLine, rightTextStart + "implicitRightText".length)
    ]]);

    const explicitSource = "Dim declaredValue As Integer\ndeclaredValue = 1\n";
    const explicitDocument = createDocument(explicitSource);
    explicitDocument.uri = { scheme: "file", fsPath: "/workspace/declared-local-inlay.bas",
        toString: () => "file:///workspace/declared-local-inlay.bas" };
    const explicitHints = await provider.provideInlayHints(explicitDocument, {
        start: { line: 1, character: 0 },
        end: { line: 1, character: explicitDocument.lineAt(1).text.length }
    });
    assert.deepEqual(explicitHints, []);
    assert.deepEqual(analysisRequests, [
        [false, true], [false, true], [false, true], [false, true], [false, true]
    ],
        "source-resolved assignments should not request the stock sidecar type-inlay pass");
});

test("stock-sidecar inlays the compiler default type on uninitialized declarations", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = "Dim stockImplicitDeclaration\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-uninitialized-type-inlay.bas",
        toString: () => "file:///workspace/stock-uninitialized-type-inlay.bas" };
    const startColumn = source.indexOf("stockImplicitDeclaration");
    const analysisRequests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            assert.equal(input.parameterHints, false);
            return {
                types: [],
                implicitDeclarations: [{
                    position: { line: 0, character: startColumn + "stockImplicitDeclaration".length },
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }],
                parameters: [],
                forEntries: [],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: document.lineAt(0).text.length }
    });
    assert.deepEqual(analysisRequests, [[true, true]],
        "an uninitialized implicit declaration needs normalized binding and type facts");
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, ": Integer");
    assert.deepEqual(hints[0].position, new Position(0, startColumn + "stockImplicitDeclaration".length));
    assert.match(hints[0].tooltip, /compiler-selected type: Integer/);
});

test("stock-sidecar inlays compiler types on implicit REDIM and first PRESERVE arrays", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = "Sub RedimInlayProbe()\n    ReDim _\n        implicitArray(0 To 2)\n    ReDim Preserve _\n        implicitPreservedArray(0 To 2)\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-redim-inlay.bas",
        toString: () => "file:///workspace/implicit-redim-inlay.bas" };
    const line = source.split("\n")[2];
    const endColumn = line.indexOf("implicitArray") + "implicitArray".length;
    const preserveLine = source.split("\n")[4];
    const preserveEndColumn = preserveLine.indexOf("implicitPreservedArray") + "implicitPreservedArray".length;
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            const declarations = [{
                position: { line: 2, character: endColumn },
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }, {
                position: { line: 4, character: preserveEndColumn },
                storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
            }];
            return {
                types: [],
                implicitVariables: [],
                implicitDeclarations: declarations.filter((record) =>
                    record.position.line >= input.position.line && record.position.line <= input.end.line
                ),
                parameters: [],
                forEntries: [],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line: 2, character: 0 },
        end: { line: 2, character: line.length }
    });
    assert.deepEqual(requests, [[true, true]],
        "an untyped REDIM declaration should request exact compiler declaration facts");
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, ": Integer");
    assert.deepEqual(hints[0].position, new Position(2, endColumn));
    assert.match(hints[0].tooltip, /compiler-selected type: Integer/);

    const preserveHints = await provider.provideInlayHints(document, {
        start: { line: 4, character: 0 },
        end: { line: 4, character: preserveLine.length }
    });
    assert.equal(preserveHints.length, 1);
    assert.equal(preserveHints[0].label, ": Integer");
    assert.deepEqual(preserveHints[0].position, new Position(4, preserveEndColumn));
    assert.deepEqual(requests, [[true, true], [true, true]]);
});

test("stock-sidecar scalar declaration hover reports target width and String initialization", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Dim storageWidthValue As Long\nDim implicitTypeValue\nDim defaultText As String\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/storage-width-hover.bas",
        toString: () => "file:///workspace/storage-width-hover.bas" };
    const requests = [];
    const startColumn = source.indexOf("storageWidthValue");
    const declaration = {
        type: "variable", name: "storageWidthValue", typeName: "Long", line: 0, startColumn,
        endColumn: startColumn + "storageWidthValue".length, signature: "Dim storageWidthValue As Long"
    };
    const implicitTypeColumn = source.split("\n")[1].indexOf("implicitTypeValue");
    const implicitTypeDeclaration = {
        type: "variable", name: "implicitTypeValue", line: 1, startColumn: implicitTypeColumn,
        endColumn: implicitTypeColumn + "implicitTypeValue".length, signature: "Dim implicitTypeValue"
    };
    const defaultTextColumn = source.split("\n")[2].indexOf("defaultText");
    const defaultTextDeclaration = {
        type: "variable", name: "defaultText", typeName: "String", line: 2, startColumn: defaultTextColumn,
        endColumn: defaultTextColumn + "defaultText".length, signature: "Dim defaultText As String"
    };
    const model = {
        remote: false,
        semanticSidecarOnly: false,
        resolveAt: (_uri, line) => line === 0
            ? [{ name: declaration.name, declaration, uri: document.uri }]
            : line === 1
                ? [{ name: implicitTypeDeclaration.name, declaration: implicitTypeDeclaration, uri: document.uri }]
                : [{ name: defaultTextDeclaration.name, declaration: defaultTextDeclaration, uri: document.uri }],
        tokenAt: () => null
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerStorageTypeFacts: position.line === 0 ? {
                    storageType: { primitive: "long", storageBytes: 4, pointerDepth: 0, isReference: false },
                    properties: []
                } : position.line === 1 ? {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    properties: []
                } : {
                    scalarStringDeclaration: {
                        statement: 1, expression: 0, kind: "dim", sourceContext: 1,
                        initializerValue: null, provisional: false
                    },
                    properties: []
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes ? sidecar : model;
            }
        },
        getSemanticModel: () => model
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: startColumn + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "target width facts should be fetched only when hovering a variable declaration");
    assert.match(hover.contents.value,
        /Compiler-selected storage width for one value in this target: `4 bytes`\./);
    assert.doesNotMatch(hover.contents.value, /Compiler-selected variable type/,
        "written AS types should not be relabeled as implicit");

    requests.length = 0;
    const implicitHover = await provider.provideHover(document, {
        line: 1, character: implicitTypeColumn + 2
    });
    assert.deepEqual(requests, [[false, false], [true, true]]);
    assert.match(implicitHover.contents.value, /Compiler-selected variable type: `Integer`\./);

    requests.length = 0;
    const stringHover = await provider.provideHover(document, { line: 2, character: defaultTextColumn + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]]);
    assert.match(stringHover.contents.value,
        /Compiler confirms this scalar dynamic String uses its default initialization\./);
});

test("stock-sidecar header directive hovers request accepted linker inputs", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = '#inclib "sidecar-test-library"\n';
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/header-library-hover.bas",
        toString: () => "file:///workspace/header-library-hover.bas" };
    const requests = [];
    const model = { remote: false, semanticSidecarOnly: false, tokenAt: () => null, resolveAt: () => [] };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                compilerHeaderLibraries: [{ kind: "inclib", value: "sidecar-test-library", filePath: "/workspace/runtime.bi" }]
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes ? sidecar : model;
            }
        },
        getSemanticModel: () => model
    }, {});

    const hover = await provider.provideHover(document, {
        line: 0, character: source.indexOf("sidecar-test-library") + 2
    });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "an #inclib value hover should request the compiler's accepted linker input");
    assert.match(hover.contents.value,
        /Compiler-accepted header linker input: `#inclib "sidecar-test-library"`/);
});

test("stock-sidecar array hovers upgrade for array declarations and uses but not ordinary calls", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Print UBound(local_values)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/array-storage-request.bas",
        toString: () => "file:///workspace/array-storage-request.bas" };
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const requests = [];
    let resolvedEntries = [];
    let sourceDocument = document;
    const model = {
        remote: false,
        semanticSidecarOnly: false,
        getDocument: () => sourceDocument,
        resolveAt: () => resolvedEntries,
        tokenAt: () => null
    };
    const sidecar = {
        remote: true,
        semanticSidecarOnly: true,
        selection: { kind: "variable", name: "local_values" },
        compilerArrayFacts: null,
        compilerFieldFacts: null,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                arrayStorageSelection: this.selection,
                compilerArrayFacts: this.compilerArrayFacts,
                compilerFieldFacts: this.compilerFieldFacts
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            async getModelForEditor(_document, _token, needCompilerTypes, needSemanticBindings) {
                requests.push([needCompilerTypes, needSemanticBindings]);
                return needCompilerTypes ? sidecar : model;
            }
        },
        getSemanticModel: () => model
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: source.indexOf("local_values") + 2 });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "UBound should request full sidecar facts because its selected array storage is useful hover data");
    assert.ok(hover, "FBC's selected array storage should create a hover even without a local symbol entry");
    assert.match(hover.contents.value, /Compiler-selected array storage: variable `local_values`\./);

    requests.length = 0;
    sidecar.selection = null;
    const ordinarySource = "Print SomeRoutine(argument)\n";
    const ordinaryDocument = createDocument(ordinarySource);
    ordinaryDocument.uri = { scheme: "file", fsPath: "/workspace/ordinary-call-hover.bas",
        toString: () => "file:///workspace/ordinary-call-hover.bas" };
    ordinaryDocument.positionAt = (offset) => ({ line: 0, character: offset });
    const ordinaryHover = await provider.provideHover(ordinaryDocument, {
        line: 0, character: ordinarySource.indexOf("argument") + 2
    });
    assert.deepEqual(requests, [[false, false], [true, false]],
        "ordinary call arguments should not upgrade the sidecar to full binding mode");
    assert.equal(ordinaryHover, null);

    requests.length = 0;
    sidecar.selection = { kind: "variable", name: "local_values" };
    const arraySource = "Dim local_values(0 To 3) As Long\nPrint local_values(index)\n";
    const arrayDocument = createDocument(arraySource);
    arrayDocument.uri = { scheme: "file", fsPath: "/workspace/array-index-hover.bas",
        toString: () => "file:///workspace/array-index-hover.bas" };
    arrayDocument.positionAt = (offset) => ({ line: 0, character: offset });
    sourceDocument = new FreeBasicSemanticModel([{
        uri: arrayDocument.uri, parsed: parseFreeBasicText(arraySource)
    }]).getDocument(arrayDocument.uri);
    resolvedEntries = [{
        name: "local_values",
        uri: arrayDocument.uri,
        declaration: {
            type: "variable", name: "local_values", line: 0, startColumn: "Dim ".length,
            endColumn: "Dim local_values".length,
            signature: "Dim local_values(0 To 3) As Long"
        }
    }];
    const arrayHover = await provider.provideHover(arrayDocument, {
        line: 1, character: arraySource.split("\n")[1].indexOf("index") + 2
    });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "an indexed variable whose declaration has array dimensions should request the full sidecar");
    assert.match(arrayHover.contents.value, /Compiler-selected array storage: variable `local_values`\./);

    requests.length = 0;
    sidecar.selection = null;
    sidecar.compilerArrayFacts = {
        arrayBounds: {
            mode: "bounds", rank: 1,
            dimensions: [{ dimension: 0, kind: "fixed", lower: 0, upper: 3 }]
        },
        properties: [{ name: "array-elements", value: "4", provisional: false }],
        storageType: { primitive: "long", storageBytes: 4, pointerDepth: 0, isReference: false }
    };
    const declarationHover = await provider.provideHover(arrayDocument, {
        line: 0, character: "Dim ".length + 2
    });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "hovering an array declaration should request its compiler-selected shape and storage");
    assert.match(declarationHover.contents.value, /Compiler-selected array bounds in this build: `0 to 3`/);
    assert.match(declarationHover.contents.value,
        /Compiler-selected fixed-array element storage: 4 elements × 4 bytes = 16 bytes/);

    requests.length = 0;
    sidecar.compilerArrayFacts = null;
    sidecar.compilerFieldFacts = {
        fieldLayout: { byteOffset: 4 },
        compilerVisibility: "protected",
        properties: []
    };
    const fieldSource = "Type FieldOwner\n    fieldValue As Long\nEnd Type\n";
    const fieldDocument = createDocument(fieldSource);
    fieldDocument.uri = { scheme: "file", fsPath: "/workspace/field-layout-request.bas",
        toString: () => "file:///workspace/field-layout-request.bas" };
    sourceDocument = fieldDocument;
    resolvedEntries = [{
        name: "fieldValue",
        uri: fieldDocument.uri,
        declaration: {
            type: "field", name: "fieldValue", line: 1, startColumn: "    ".length,
            endColumn: "    fieldValue".length, signature: "fieldValue As Long"
        }
    }];
    const fieldHover = await provider.provideHover(fieldDocument, {
        line: 1, character: "    ".length + 2
    });
    assert.deepEqual(requests, [[false, false], [true, true]],
        "field declaration hovers should request compiler-owned layout facts");
    assert.match(fieldHover.contents.value, /Compiler-selected field offset: `4 bytes`/);
    assert.match(fieldHover.contents.value, /Compiler-selected visibility: `protected`./);
});

test("hover explains the compiler-emitted target representation of a wide literal", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = 'Print WStr(!"A")\n';
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/wide-literal.bas", toString: () => "file:///workspace/wide-literal.bas" };
    const literal = {
        unitBytes: 2,
        kind: "terminated",
        unitCount: 3,
        units: ["0041", "D83D", "DE00"]
    };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], occurrence: null, expression: null, expressionAlternatives: [], targetWideLiteral: literal };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, {
        line: 0, character: source.indexOf('"A"') + 1
    });
    assert.match(hover.contents.value,
        /Compiler target wide-string representation: 2-byte units, null-terminated\./);
    assert.match(hover.contents.value, /Unit prefix: `0041 D83D DE00`\./);
});

test("stock-sidecar hover upgrades wide-literal facts only at a wide literal", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = 'Print WStr(!"A")\n';
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-wide-literal.bas",
        toString: () => "file:///workspace/stock-wide-literal.bas" };
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const literal = { unitBytes: 4, kind: "terminated", unitCount: 1, units: ["00000041"] };
    const response = (targetWideLiteral = null) => ({
        entries: [], occurrence: null, expression: { typeName: "WString", provisional: false },
        expressionAlternatives: [], targetWideLiteral
    });
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return response();
        }
    };
    const fullModel = {
        remote: true,
        semanticSidecarOnly: true,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return response(literal);
        }
    };
    const sourceModel = {
        remote: false,
        resolveAt: () => [],
        tokenAt: () => null,
        expressionAt: () => null,
        compilerSidecarFactAt: () => null,
        compilerSidecarExpressionAlternativesAt: () => [],
        compilerConditionalDecisionAt: () => null,
        compilerDefinedNameProbeAt: () => null,
        compilerDeferredMacroReferenceAt: () => null,
        compilerHeaderLibrariesAt: () => []
    };
    const requests = [];
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            async getModelForEditor(_document, _token, expressions, bindings) {
                requests.push([expressions === true, bindings === true]);
                if (!expressions) return null;
                return bindings ? fullModel : sidecarModel;
            },
            getModel: () => null
        },
        getParsedDocument: () => ({}),
        async ensureInitialized() { return true; },
        getSemanticModel: () => sourceModel
    }, {});

    const hover = await provider.provideHover(document, {
        line: 0, character: source.indexOf('"A"') + 1
    });
    assert.deepEqual(requests, [[false, false], [true, false], [true, true]]);
    assert.match(hover.contents.value, /Compiler target wide-string representation: 4-byte units, null-terminated\./);

    const callHover = await provider.provideHover(document, {
        line: 0, character: source.indexOf("WStr") + 1
    });
    assert.doesNotMatch(callHover.contents.value, /Compiler target wide-string representation/);
    assert.deepEqual(requests.slice(3), [[false, false], [true, false]],
        "hovering the conversion name should not request full binding analysis");
});

test("hover explains compiler-selected SELECT CASE lowering", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Select Case selector\nSelect Case As Const selector\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/select-case-table.bas",
        toString: () => "file:///workspace/select-case-table.bas" };
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: { typeName: "Long", provisional: false },
                expressionAlternatives: [],
                selectCaseLowering: position.line === 0
                    ? { kind: "comparisons", count: 3 }
                    : { kind: "jump-table", slots: 5, entries: 5 }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const normalHover = await provider.provideHover(document, {
        line: 0, character: source.split("\n")[0].indexOf("selector") + 2
    });
    assert.match(normalHover.contents.value, /Compiler SELECT CASE lowering: 3 comparison tests\./);
    const hover = await provider.provideHover(document, {
        line: 1, character: source.split("\n")[1].indexOf("selector") + 2
    });
    assert.match(hover.contents.value,
        /Compiler SELECT CASE lowering: jump table with 5 slots \(5 populated entries\)\./);
});

test("stock-sidecar requests SELECT CASE lowering facts only over the selector", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Select Case As Const selector\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-select-case.bas",
        toString: () => "file:///workspace/stock-select-case.bas" };
    const lowering = { kind: "jump-table", slots: 5, entries: 5 };
    const response = (selectCaseLowering = null) => ({
        entries: [], occurrence: null, expression: { typeName: "Long", provisional: false },
        expressionAlternatives: [], selectCaseLowering
    });
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return response();
        }
    };
    const fullModel = {
        remote: true,
        semanticSidecarOnly: true,
        partial: false,
        async query(operation, uri) {
            assert.equal(operation, "hover");
            return response(uri.fsPath.endsWith("normal.bas")
                ? { kind: "comparisons", count: 3 }
                : lowering);
        }
    };
    const sourceModel = {
        remote: false,
        resolveAt: () => [],
        tokenAt: () => null,
        expressionAt: () => null,
        compilerSidecarFactAt: () => null,
        compilerSidecarExpressionAlternativesAt: () => [],
        compilerConditionalDecisionAt: () => null,
        compilerDefinedNameProbeAt: () => null,
        compilerDeferredMacroReferenceAt: () => null,
        compilerHeaderLibrariesAt: () => []
    };
    const requests = [];
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            async getModelForEditor(_document, _token, expressions, bindings) {
                requests.push([expressions === true, bindings === true]);
                if (!expressions) return null;
                return bindings ? fullModel : sidecarModel;
            },
            getModel: () => null
        },
        getParsedDocument: () => ({}),
        async ensureInitialized() { return true; },
        getSemanticModel: () => sourceModel
    }, {});

    const selectorHover = await provider.provideHover(document, {
        line: 0, character: source.indexOf("selector") + 2
    });
    assert.match(selectorHover.contents.value, /jump table with 5 slots/);
    assert.deepEqual(requests, [[false, false], [true, false], [true, true]]);

    const keywordHover = await provider.provideHover(document, { line: 0, character: 2 });
    assert.doesNotMatch(keywordHover.contents.value, /jump table with 5 slots/);
    assert.deepEqual(requests.slice(3), [[false, false], [true, false]],
        "hovering the SELECT keyword alone should not request full binding analysis");

    const normalSource = "Select Case selector\n";
    const normalDocument = createDocument(normalSource);
    normalDocument.uri = { scheme: "file", fsPath: "/workspace/stock-select-case-normal.bas",
        toString: () => "file:///workspace/stock-select-case-normal.bas" };
    const normalHover = await provider.provideHover(normalDocument, {
        line: 0, character: normalSource.indexOf("selector") + 2
    });
    assert.match(normalHover.contents.value, /Compiler SELECT CASE lowering: 3 comparison tests\./);
    assert.deepEqual(requests.slice(5), [[false, false], [true, false], [true, true]],
        "ordinary SELECT CASE hovers should also upgrade to their compiler comparison receipts");
});

test("hover upgrades sidecar-only compound assignments to full semantic facts on demand", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const document = createDocument("total += amount\n");
    document.uri = { scheme: "file", fsPath: "/workspace/compound-sidecar-hover.bas", toString: () => "file:///workspace/compound-sidecar-hover.bas" };
    const response = (assignmentInput) => ({
        entries: [], occurrence: null, expression: null, expressionAlternatives: [], assignmentInput
    });
    const sourceModel = {
        remote: false,
        resolveAt: () => [],
        tokenAt: () => null,
        expressionAt: () => null,
        compilerAssignmentInputAt: () => null,
        compilerSidecarExpressionAlternativesAt: () => [],
        compilerConditionalDecisionAt: () => null,
        compilerDefinedNameProbeAt: () => null,
        compilerDeferredMacroReferenceAt: () => null,
        compilerHeaderLibrariesAt: () => []
    };
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return response(null);
        }
    };
    const fullModel = {
        remote: true,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return response({
                operatorCode: "add", operatorKind: "builtin", rightTypeName: "Double",
                resultTypeName: "Double", targetTypeName: "Long"
            });
        }
    };
    const requests = [];
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            async getModelForEditor(_document, _token, expressionTypes, bindings) {
                requests.push([expressionTypes === true, bindings === true]);
                if (bindings) return fullModel;
                return expressionTypes ? sidecarModel : sourceModel;
            },
            getModel: () => sourceModel,
            analysisCompilerFor: () => ({ semanticModelOnly: true })
        },
        getSemanticModel: () => null
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: 7 });
    assert.ok(requests.some(([expressionTypes, bindings]) => expressionTypes && bindings),
        "assignment operands require an on-demand full sidecar rather than expression-only coverage");
    assert.match(hover.contents.value, /right source operand type `Double`/);
    assert.match(hover.contents.value, /assigned to `Long`/);
});

test("sidecar-only on-demand hover adds compiler types without replacing source symbols", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const grammarData = loadGrammarSourceFile(path.join(
        __dirname,
        "..",
        "syntaxes",
        "source",
        "freebasic.grammar-source.json"
    ));
    const source = "Print Sin(0.5)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const requests = [];
    const parserModel = {
        tokenAt(uri, line, character) {
            assert.equal(uri, document.uri);
            assert.equal(line, 0);
            assert.equal(character, 7);
            return { token: { name: "Sin" } };
        },
        resolveAt: () => []
    };
    const sidecarModel = {
        semanticSidecarOnly: true,
        remote: false,
        expressionAt(uri, position) {
            assert.equal(uri, document.uri);
            assert.deepEqual(position, { line: 0, character: 7 });
            return { typeName: "Single", provisional: false };
        },
        expressionAtCompilerSidecarOnly() {
            return { typeName: "Single", operatorCode: "sine", operatorKind: "builtin", provisional: false };
        },
        compilerSidecarExpressionAlternativesAt: () => []
    };
    const index = {
        compilerAnalysis: {
            getModelForEditor: async (_document, _token, needExpressionTypes) => {
                requests.push(needExpressionTypes);
                return needExpressionTypes ? sidecarModel : null;
            },
            getModel: () => sidecarModel
        },
        getParsedDocument: () => ({}),
        async ensureInitialized() { return true; },
        getSemanticModel: () => parserModel
    };
    const vscode = { ...createVscodeMock(), MarkdownString, Hover };
    const hoverProvider = createHoverProvider(vscode, index, grammarData);
    const hover = await hoverProvider.provideHover(document, { line: 0, character: 7 });

    assert.deepEqual(requests, [false, true]);
    assert.match(hover.contents.value, /Compiler type: `Single`/);
    assert.match(hover.contents.value, /sine of an angle/);
});

test("resolved bundled declarations include reference docs only for their matching header", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const document = createDocument("DrawStringSize(\"sample\", width, height)\n");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    let declarationPath = "/freebasic/inc/fbgfx.bi";
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [{
                    name: "DrawStringSize",
                    qualifiedName: "fb.drawstringsize",
                    uri: { fsPath: declarationPath },
                    declaration: {
                        name: "DrawStringSize",
                        type: "function",
                        signature: "declare function DrawStringSize(...) as long",
                        documentation: "@deprecated Use the next graphics release.\nMeasures text without opening a display.",
                        line: 40,
                        startColumn: 18,
                        endColumn: 32,
                        parameters: [],
                        modifiers: []
                    }
                }],
                occurrence: { name: "DrawStringSize" },
                expression: null,
                expressionAlternatives: []
            };
        }
    };
    const index = {
        compilerAnalysis: {
            getModelForEditor: async () => model,
            getModel: () => null
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, index, {});

    const bundledHover = await provider.provideHover(document, { line: 0, character: 4 });
    assert.match(bundledHover.contents.value, /Declared in fbgfx\.bi/);
    assert.match(bundledHover.contents.value, /Requires `#include once "fbgfx\.bi"`; namespace `FB`/);
    assert.match(bundledHover.contents.value, /Source reference/);
    assert.match(bundledHover.contents.value, /Measures text without opening a display\./);
    assert.match(bundledHover.contents.value, /Marked deprecated in source documentation\./);

    declarationPath = "/workspace/project/graphics.bi";
    const projectHover = await provider.provideHover(document, { line: 0, character: 4 });
    assert.match(projectHover.contents.value, /Declared in `graphics\.bi`/);
    assert.doesNotMatch(projectHover.contents.value, /Source reference/);
});

test("hover displays unambiguous compiler-confirmed numeric constants and folded values", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const document = createDocument("Print maximumValue\n");
    document.uri = { scheme: "file", fsPath: "/workspace/constants.bas", toString: () => "file:///workspace/constants.bas" };
    const entry = {
        name: "maximumValue",
        uri: { fsPath: "/workspace/constants.bas" },
        declaration: {
            name: "maximumValue", type: "const", signature: "Const maximumValue As ULongInt",
            line: 0, startColumn: 6, endColumn: 18, parameters: [], modifiers: [],
            compilerFacts: {
                constantValues: [{ kind: "unsigned", value: "18446744073709551615" }],
                storageType: { primitive: "ulongint", pointerDepth: 0, isReference: false, storageBytes: 8 }
            }
        }
    };
    let expressionConstantValues = [];
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [entry], occurrence: { name: "maximumValue" }, expression: null,
                expressionAlternatives: [], expressionConstantValues
            };
        }
    };
    const index = { compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model } };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, index, {});

    const exact = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(exact.contents.value, /Compiler constant value in this context: `18446744073709551615`/,
        "large unsigned values must remain exact decimal text");
    assert.match(exact.contents.value, /Compiler-selected storage width for one value in this target: `8 bytes`/,
        "hover should show the compiler-selected target-specific storage width");

    entry.declaration.compilerFacts.constantValues = [
        { kind: "signed", value: "42" },
        { kind: "signed", value: "43" }
    ];
    const ambiguous = await provider.provideHover(document, { line: 0, character: 10 });
    assert.doesNotMatch(ambiguous.contents.value, /Compiler constant value/,
        "conflicting facts must not choose one compiler value");

    entry.declaration.compilerFacts.constantValues = [{ kind: "signed", value: "42\nunsafe" }];
    const malformed = await provider.provideHover(document, { line: 0, character: 10 });
    assert.doesNotMatch(malformed.contents.value, /unsafe|Compiler constant value/,
        "malformed sidecar text must not be interpolated into hover markdown");

    entry.declaration.compilerFacts.constantValues = [{ kind: "float64-bits", value: "0x3FF8000000000000" }];
    const floating = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(floating.contents.value, /Compiler constant value in this context: `1\.5 \(IEEE-754 bits 0x3FF8000000000000\)`/,
        "hover should decode the exact floating-point value without discarding its source bits");

    entry.declaration.compilerFacts.constantValues = [];
    expressionConstantValues = [{ kind: "signed", value: "5" }];
    const folded = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(folded.contents.value, /Compiler constant value in this context: `5`/,
        "hover should display a compiler-folded expression value even when no symbol is under the cursor");

    expressionConstantValues = [{ kind: "bytes", value: "48656C6C6F" }];
    const foldedString = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(foldedString.contents.value,
        /Compiler constant value in this context: `bytes 0x48656C6C6F \(ASCII preview: "Hello"\)`/);

    expressionConstantValues = [];
    entry.declaration.compilerFacts.constantValues = [{ kind: "bytes", value: "48656C6C6F" }];
    const string = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(string.contents.value,
        /Compiler constant value in this context: `bytes 0x48656C6C6F \(ASCII preview: "Hello"\)`/);
    entry.declaration.compilerFacts.constantValues = [{
        kind: "wide-units",
        value: "000000630000006100000066000000E9"
    }];
    const wideString = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(wideString.contents.value,
        /Compiler constant value in this context: `wide units 0x000000630000006100000066000000E9 \(Unicode preview: "café"\)`/);

    entry.declaration.compilerFacts.storageType = {
        primitive: "integer", pointerDepth: 1, isReference: false, storageBytes: 8
    };
    const pointer = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(pointer.contents.value, /pointer value; the pointed-to storage is separate/,
        "pointer layout must not be confused with the pointed-to value");
    entry.declaration.compilerFacts.storageType = {
        primitive: "type", pointerDepth: 0, isReference: true, storageBytes: 24
    };
    const byReference = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(byReference.contents.value, /referenced value type, not an estimate of the caller's argument storage/,
        "ByRef type width must not be presented as the argument slot width");
    entry.declaration.compilerFacts.storageType = {
        primitive: "string", pointerDepth: 0, isReference: false, storageBytes: 24
    };
    const stringStorage = await provider.provideHover(document, { line: 0, character: 10 });
    assert.match(stringStorage.contents.value, /string descriptor; allocated character data is separate/,
        "dynamic string storage width must not be mistaken for allocated character data");
});

test("compiler-confirmed UDT layout sizes and array bounds appear on hovers", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const document = createDocument("Type LayoutProbe\n    Protected:\n    fieldValue As Long\nEnd Type\nDim values(-1 To 4, 1 To 3) As Long\nType PublicLayoutProbe\n    publicValue As Integer\nEnd Type\n");
    document.uri = { scheme: "file", fsPath: "/workspace/layout.bas", toString: () => "file:///workspace/layout.bas" };
    const typeEntry = {
        id: 1,
        name: "LayoutProbe",
        uri: { scheme: "file", fsPath: "/workspace/layout.bas" },
        declaration: {
            name: "LayoutProbe", type: "type", signature: "Type LayoutProbe", line: 0,
            startColumn: 5, endColumn: 16, parameters: [], modifiers: [],
            compilerFacts: {
                aggregateSizeBytes: 16,
                aggregateAccess: {
                    bodyStatement: 1, count: 1,
                    sections: [{ ordinal: 1, statement: 2, visibility: "protected" }]
                },
                properties: [
                    { name: "natural-alignment", value: "8", provisional: false },
                    { name: "packing-alignment", value: "4", provisional: false }
                ]
            }
        }
    };
    const arrayEntry = {
        id: 2,
        name: "values",
        uri: { scheme: "file", fsPath: "/workspace/layout.bas" },
        declaration: {
            name: "values", type: "variable", signature: "Dim values(-1 To 4, 1 To 3) As Long", line: 4,
            startColumn: 4, endColumn: 10, parameters: [], modifiers: [],
            compilerFacts: {
                storageType: { storageBytes: 4, pointerDepth: 0, primitive: "integer", isReference: false },
                arrayBounds: {
                    rank: 2,
                    mode: "bounds",
                    dimensions: [
                        { dimension: 0, kind: "fixed", lower: -1, upper: 4 },
                        { dimension: 1, kind: "fixed", lower: 1, upper: 3 }
                    ]
                },
                properties: [{ name: "array-elements", value: "18", provisional: false }]
            }
        }
    };
    const fieldEntry = {
        id: 3,
        name: "fieldValue",
        uri: { scheme: "file", fsPath: "/workspace/layout.bas" },
        declaration: {
            name: "fieldValue", type: "field", signature: "fieldValue As Long", line: 2,
            startColumn: 4, endColumn: 14, parameters: [], modifiers: [],
            compilerFacts: {
                fieldLayout: { owner: 1, byteOffset: 4 },
                compilerVisibility: "protected",
                properties: [
                    { name: "bit-position", value: "2", provisional: false },
                    { name: "bit-width", value: "3", provisional: false }
                ]
            }
        }
    };
    const publicFieldEntry = {
        id: 4,
        name: "publicValue",
        uri: { scheme: "file", fsPath: "/workspace/layout.bas" },
        declaration: {
            name: "publicValue", type: "field", typeName: "Integer", containerName: "PublicLayoutProbe",
            signature: "publicValue As Integer", line: 6, startColumn: 4,
            endColumn: 4 + "publicValue".length, parameters: [], modifiers: [],
            compilerFacts: { compilerVisibility: "public" }
        }
    };
    const model = {
        remote: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "hover");
            const entry = input.position.line === 2 ? fieldEntry
                : input.position.line === 4 ? arrayEntry
                    : input.position.line === 6 ? publicFieldEntry : typeEntry;
            return {
                entries: [entry],
                occurrence: { name: entry.name },
                expression: null,
                expressionAlternatives: [],
                expressionConstantValues: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: 8 });
    assert.match(hover.contents.value, /Compiler-selected aggregate layout in this target: `16 bytes`/);
    assert.match(hover.contents.value, /Compiler-selected natural alignment: `8 bytes`/);
    assert.match(hover.contents.value, /Compiler-selected packing alignment: `4 bytes`/);
    assert.match(hover.contents.value, /Compiler-confirmed member access sections: Protected\./);
    const fieldHover = await provider.provideHover(document, { line: 2, character: 8 });
    assert.match(fieldHover.contents.value,
        /Compiler-selected field offset: `4 bytes` from the start of its containing aggregate/);
    assert.match(fieldHover.contents.value, /Compiler-selected bit position: 2; width: 3 bits/);
    assert.match(fieldHover.contents.value, /Compiler-selected visibility: `protected`\./);
    const publicFieldHover = await provider.provideHover(document, { line: 6, character: 8 });
    assert.match(publicFieldHover.contents.value, /Compiler-selected visibility: public\./);
    const arrayHover = await provider.provideHover(document, { line: 4, character: 6 });
    assert.match(arrayHover.contents.value,
        /Compiler-selected array bounds in this build: `-1 to 4`, `1 to 3`/);
    assert.match(arrayHover.contents.value, /Compiler array element count: `18`/);
    assert.match(arrayHover.contents.value,
        /Compiler-selected fixed-array element storage: 18 elements × 4 bytes = 72 bytes/);
    arrayEntry.declaration.compilerFacts.properties.push({ name: "array-elements", value: "17", provisional: false });
    const conflictingCount = await provider.provideHover(document, { line: 4, character: 6 });
    assert.doesNotMatch(conflictingCount.contents.value, /Compiler array element count/,
        "conflicting sidecar counts must not override the exact compiler bounds");
    assert.doesNotMatch(conflictingCount.contents.value, /fixed-array element storage/,
        "conflicting counts must not produce a derived storage estimate");
});

test("full-model procedure hovers show compiler-selected ABI and implicit return type", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = [
        'Extern "C"',
        "Declare Function cProbe Cdecl(ByVal value As Long) As Long",
        "Declare Function cStringProbe(ByVal value As String) As Long",
        "End Extern",
        "Declare Function refProbe() ByRef As Long",
        "Declare Function implicitProbe()",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/abi.bas", toString: () => "file:///workspace/abi.bas" };
    const entry = {
        id: 1,
        name: "cProbe",
        uri: { scheme: "file", fsPath: "/workspace/abi.bas" },
        declaration: {
            name: "cProbe", type: "function", signature: "Declare Function cProbe Cdecl(ByVal value As Long) As Long",
            line: 1, startColumn: 16, endColumn: 22, parameters: [], modifiers: ["DECLARE"],
            compilerFacts: {
                procedureCallingConvention: "cdecl",
                procedureAbiPolicyInputs: [{
                    identity: 1, statement: 1, writtenConvention: true, managedString: false, provisional: false
                }],
                procedureTypingInputs: [{ kind: "function", role: "prototype", resultForm: "as", provisional: false }],
                properties: [{ name: "procedure-linkage", value: "c", provisional: false }]
            }
        }
    };
    const cStringLine = 2;
    const cStringColumn = source.split("\n")[cStringLine].indexOf("cStringProbe");
    const cStringEntry = {
        id: 4,
        name: "cStringProbe",
        uri: { scheme: "file", fsPath: "/workspace/abi.bas" },
        declaration: {
            name: "cStringProbe", type: "function",
            signature: "Declare Function cStringProbe(ByVal value As String) As Long",
            line: cStringLine, startColumn: cStringColumn, endColumn: cStringColumn + "cStringProbe".length,
            parameters: [], modifiers: ["DECLARE"],
            compilerFacts: {
                procedureCallingConvention: "cdecl",
                procedureAbiPolicyInputs: [{
                    identity: 2, statement: 2, writtenConvention: false, managedString: true, provisional: false
                }],
                procedureTypingInputs: [{ kind: "function", role: "prototype", resultForm: "as", provisional: false }],
                properties: [{ name: "procedure-linkage", value: "c", provisional: false }]
            }
        }
    };
    const refEntry = {
        id: 2,
        name: "refProbe",
        uri: { scheme: "file", fsPath: "/workspace/abi.bas" },
        declaration: {
            name: "refProbe", type: "function", signature: "Declare Function refProbe() ByRef As Long",
            line: 4, startColumn: source.split("\n")[4].indexOf("refProbe"),
            endColumn: source.split("\n")[4].indexOf("refProbe") + "refProbe".length,
            parameters: [], modifiers: ["DECLARE"],
            compilerFacts: { procedureCallingConvention: "basic", procedureReturnsByReference: true, properties: [] }
        }
    };
    const implicitLine = 5;
    const implicitColumn = source.split("\n")[implicitLine].indexOf("implicitProbe");
    const implicitEntry = {
        id: 3,
        name: "implicitProbe",
        uri: { scheme: "file", fsPath: "/workspace/abi.bas" },
        declaration: {
            name: "implicitProbe", type: "function", typeName: "Integer",
            signature: "Declare Function implicitProbe()",
            line: implicitLine, startColumn: implicitColumn, endColumn: implicitColumn + "implicitProbe".length,
            parameters: [], modifiers: ["DECLARE"],
            compilerFacts: {
                procedureTypingInputs: [{ kind: "function", role: "prototype", resultForm: "implicit", provisional: false }]
            }
        }
    };
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const selected = position.line === 1 ? entry
                : position.line === cStringLine ? cStringEntry
                    : position.line === 4 ? refEntry : implicitEntry;
            return {
                entries: [selected], occurrence: { name: selected.name }, expression: null,
                expressionAlternatives: [], expressionConstantValues: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 1, character: 20 });
    assert.match(hover.contents.value, /Compiler-selected procedure ABI: C linkage, cdecl calling convention\./);
    const cStringHover = await provider.provideHover(document, {
        line: cStringLine, character: cStringColumn + 2
    });
    assert.match(cStringHover.contents.value,
        /Compiler-selected procedure ABI: C linkage, cdecl calling convention, calling convention not written explicitly, FreeBASIC STRING-based type in signature\./);
    cStringEntry.declaration.compilerFacts.procedureAbiPolicyInputs.push({
        identity: 3, statement: 3, writtenConvention: false, managedString: false, provisional: false
    });
    const conflictingStringPolicy = await provider.provideHover(document, {
        line: cStringLine, character: cStringColumn + 2
    });
    assert.doesNotMatch(conflictingStringPolicy.contents.value, /FreeBASIC STRING-based type/,
        "conflicting source-occurrence ABI policies must not be summarized as a single declaration fact");
    const refHover = await provider.provideHover(document, {
        line: 4,
        character: source.split("\n")[4].indexOf("refProbe") + 2
    });
    assert.match(refHover.contents.value, /Compiler-selected procedure ABI: ByRef return\./);
    const implicitHover = await provider.provideHover(document, {
        line: implicitLine,
        character: implicitColumn + 2
    });
    assert.match(implicitHover.contents.value,
        /Compiler-selected implicit return type: `Integer`\./);
    assert.doesNotMatch(hover.contents.value, /Compiler-selected implicit return type/,
        "an explicitly typed function should not receive an implicit-type note");
});

test("compiler-selected default procedure policies can be written explicitly", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    const source = [
        "    Function publicDefault() As Integer",
        "    End Function",
        "Function privateDefault() As Integer",
        "End Function",
        'Extern "C"',
        "Declare Function cDefaultProbe(ByVal value As Integer) As Integer",
        "Declare Function cStringProbe(ByVal value As String) As Integer",
        "Declare Function explicitCProbe Cdecl(ByVal value As Integer) As Integer",
        "End Extern",
        'Extern "Windows"',
        "Declare Function windowsDefaultProbe(ByVal value As Integer) As Integer",
        "End Extern",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/default-visibility.bas",
        toString: () => "file:///workspace/default-visibility.bas" };
    document.version = 1;
    document.positionAt = (offset) => {
        const prefix = source.slice(0, offset);
        return { line: (prefix.match(/\n/g) || []).length, character: offset - prefix.lastIndexOf("\n") - 1 };
    };
    const makeEntry = (name, line, visibility, statement) => {
        const lineText = source.split("\n")[line];
        const startColumn = lineText.indexOf(name);
        return {
            name,
            uri: document.uri,
            declaration: {
                name, type: "function", qualifiedName: name,
                signature: lineText.trimStart(),
                line, startColumn, endColumn: startColumn + name.length,
                containerName: "", modifiers: [], parameters: [],
                compilerFacts: {
                    compilerVisibility: visibility,
                    procedureTypingInputs: [{
                        statement, role: "definition", kind: "function",
                        resultForm: "as", provisional: false
                    }],
                    procedureWrittenVisibility: [{
                        statement, visibility: "default", provisional: false
                    }]
                }
            }
        };
    };
    const entries = new Map([
        [0, makeEntry("publicDefault", 0, "public", 11)],
        [2, makeEntry("privateDefault", 2, "private", 12)]
    ]);
    const cDefaultLine = 5;
    const cDefaultText = source.split("\n")[cDefaultLine];
    const cDefaultColumn = cDefaultText.indexOf("cDefaultProbe");
    entries.set(cDefaultLine, {
        name: "cDefaultProbe",
        uri: document.uri,
        declaration: {
            name: "cDefaultProbe", type: "function", qualifiedName: "cDefaultProbe",
            signature: cDefaultText, line: cDefaultLine,
            startColumn: cDefaultColumn, endColumn: cDefaultColumn + "cDefaultProbe".length,
            containerName: "", modifiers: ["DECLARE"], parameters: [],
            compilerFacts: {
                procedureCallingConvention: "cdecl",
                procedureAbiPolicyInputs: [{
                    identity: 3, statement: 13, writtenConvention: false, managedString: false, provisional: false
                }],
                procedureTypingInputs: [{
                    statement: 13, role: "prototype", kind: "function", resultForm: "as", provisional: false
                }],
                properties: [{ name: "procedure-linkage", value: "c", provisional: false }]
            }
        }
    });
    const makeCEntry = (name, line, conventionWritten, managedString) => {
        const lineText = source.split("\n")[line];
        const startColumn = lineText.indexOf(name);
        const statement = line + 8;
        return {
            name,
            uri: document.uri,
            declaration: {
                name, type: "function", qualifiedName: name,
                signature: lineText, line, startColumn, endColumn: startColumn + name.length,
                containerName: "", modifiers: ["DECLARE"], parameters: [],
                compilerFacts: {
                    procedureCallingConvention: "cdecl",
                    procedureAbiPolicyInputs: [{
                        identity: line, statement, writtenConvention: conventionWritten,
                        managedString, provisional: false
                    }],
                    procedureTypingInputs: [{
                        statement, role: "prototype", kind: "function", resultForm: "as", provisional: false
                    }],
                    properties: [{ name: "procedure-linkage", value: "c", provisional: false }]
                }
            }
        };
    };
    entries.set(6, makeCEntry("cStringProbe", 6, false, true));
    entries.set(7, makeCEntry("explicitCProbe", 7, true, false));
    const windowsLine = 10;
    const windowsText = source.split("\n")[windowsLine];
    const windowsColumn = windowsText.indexOf("windowsDefaultProbe");
    entries.set(windowsLine, {
        name: "windowsDefaultProbe",
        uri: document.uri,
        declaration: {
            name: "windowsDefaultProbe", type: "function", qualifiedName: "windowsDefaultProbe",
            signature: windowsText, line: windowsLine,
            startColumn: windowsColumn, endColumn: windowsColumn + "windowsDefaultProbe".length,
            containerName: "", modifiers: ["DECLARE"], parameters: [],
            compilerFacts: {
                procedureCallingConvention: "stdcall-ms",
                procedureAbiPolicyInputs: [{
                    identity: 16, statement: 16, writtenConvention: false, managedString: false, provisional: false
                }],
                procedureTypingInputs: [{
                    statement: 16, role: "prototype", kind: "function", resultForm: "as", provisional: false
                }],
                properties: [{ name: "procedure-linkage", value: "windows", provisional: false }]
            }
        }
    });
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const entry = entries.get(position.line);
            return { entries: entry ? [entry] : [] };
        }
    };
    const workspaceIndex = {
        compilerAnalysis: { getModelForEditor: async () => model }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        Position,
        WorkspaceEdit
    }, workspaceIndex);
    const hoverProvider = createHoverProvider({
        ...createVscodeMock(), MarkdownString, Hover
    }, workspaceIndex, {});
    const publicDefaultColumn = source.split("\n")[0].indexOf("publicDefault");
    const publicHover = await hoverProvider.provideHover(document, {
        line: 0, character: publicDefaultColumn + 1
    });
    assert.match(publicHover.contents.value,
        /Compiler-selected visibility: `public` \(scope default; no modifier written\)\./);

    for (const [name, line, keyword] of [
        ["publicDefault", 0, "Public"],
        ["privateDefault", 2, "Private"]
    ]) {
        const lineText = source.split("\n")[line];
        const startColumn = lineText.indexOf(name);
        const actions = await provider.provideCodeActions(document,
            new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] });
        assert.equal(actions.length, 1);
        assert.equal(actions[0].title, "Make procedure visibility explicit as '" + keyword + "'");
        assert.equal(actions[0].edit.insertion.position.character, lineText.search(/\S/));
        assert.equal(actions[0].edit.insertion.text, keyword + " ");
    }
    const cDefaultActions = await provider.provideCodeActions(document,
        new Range(cDefaultLine, cDefaultColumn, cDefaultLine, cDefaultColumn + "cDefaultProbe".length),
        { diagnostics: [] });
    assert.equal(cDefaultActions.length, 1);
    assert.equal(cDefaultActions[0].title, "Make calling convention explicit as 'Cdecl'");
    assert.equal(cDefaultActions[0].edit.insertion.position.character,
        cDefaultColumn + "cDefaultProbe".length);
    assert.equal(cDefaultActions[0].edit.insertion.text, " Cdecl");
    const windowsActions = await provider.provideCodeActions(document,
        new Range(windowsLine, windowsColumn, windowsLine, windowsColumn + "windowsDefaultProbe".length),
        { diagnostics: [] });
    assert.equal(windowsActions.length, 1);
    assert.equal(windowsActions[0].title, "Make calling convention explicit as 'Stdcall'");
    assert.equal(windowsActions[0].edit.insertion.position.character,
        windowsColumn + "windowsDefaultProbe".length);
    assert.equal(windowsActions[0].edit.insertion.text, " Stdcall");
    for (const [name, line] of [["cStringProbe", 6], ["explicitCProbe", 7]]) {
        const nameColumn = source.split("\n")[line].indexOf(name);
        const actions = await provider.provideCodeActions(document,
            new Range(line, nameColumn, line, nameColumn + name.length), { diagnostics: [] });
        assert.deepEqual(actions, [],
            name === "cStringProbe"
                ? "the convention fix should not imply that managed STRING is C-compatible"
                : "a convention that FBC says is already written should not be duplicated");
    }
});

test("full-model method hover shows the compiler-selected override target", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = [
        "Type BaseSelector",
        "    Declare Virtual Function Choose(ByVal value As Long) As Long",
        "End Type",
        "Type DerivedSelector Extends BaseSelector",
        "    Declare Function Choose(ByVal value As Long) As Long",
        "End Type",
        "Type AbstractWidget Extends Object",
        "    Declare Abstract Sub Draw()",
        "End Type",
        "Function implicitResult()",
        "    Return 1",
        "End Function",
        "Sub implicitParameterProbe(ByVal implicitValue)",
        "End Sub",
        "Sub implicitArrayProbe(values())",
        "End Sub",
        "Sub defaultModeProbe(defaultModeValue As Integer)",
        "End Sub",
        "Sub suffixParameterProbe(ByVal suffixValue%)",
        "End Sub",
        "Function suffixReturn%()",
        "    Return 1",
        "End Function",
        "Dim implicitDimValue",
        "Dim implicitDimArray(1)",
        "Dim stringBoundArray(Val(\")\"))",
        "Dim suffixDimValue%",
        "Dim suffixDimArray%(1)",
        "Const implicitConstant = 42",
        "Var inferredVar = 42",
        "Dim ByRef byRefSuffixValue%",
        "Const suffixConstant% = 7",
        "Sub implicitStorageProbe()",
        "    implicitLocal = 1",
        "End Sub",
        "Sub explicitStorageProbe()",
        "    Dim explicitLocal As Integer",
        "    explicitLocal = 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/override.bas", toString: () => "file:///workspace/override.bas" };
    const methodColumn = source.split("\n")[4].indexOf("Choose");
    const abstractTypeLine = 6;
    const abstractTypeColumn = source.split("\n")[abstractTypeLine].indexOf("AbstractWidget");
    const methodEntry = {
        id: 1,
        name: "Choose",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "Choose", type: "function",
            signature: "Declare Function Choose(ByVal value As Long) As Long",
            line: 4, startColumn: methodColumn, endColumn: methodColumn + "Choose".length,
            typeName: "Long", parameters: [], modifiers: ["DECLARE"],
            compilerFacts: {
                overriddenProcedure: { compilerSymbolId: 9, qualifiedName: "BaseSelector.Choose" },
                procedureTypingInputs: [{ kind: "function", role: "prototype", resultForm: "as", provisional: false }],
                properties: [{ name: "written-override", value: "0", provisional: false }]
            }
        }
    };
    const abstractTypeEntry = {
        id: 2,
        name: "AbstractWidget",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "AbstractWidget", type: "type", signature: "Type AbstractWidget Extends Object",
            line: abstractTypeLine, startColumn: abstractTypeColumn,
            endColumn: abstractTypeColumn + "AbstractWidget".length, parameters: [], modifiers: [],
            compilerFacts: { abstractMemberCount: 1 }
        }
    };
    const implicitLine = 9;
    const implicitColumn = source.split("\n")[implicitLine].indexOf("implicitResult");
    const implicitFunctionEntry = {
        id: 3,
        name: "implicitResult",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "implicitResult", type: "function", typeName: "Integer",
            signature: "Function implicitResult()",
            line: implicitLine, startColumn: implicitColumn,
            endColumn: implicitColumn + "implicitResult".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                procedureTypingInputs: [{ kind: "function", role: "definition", resultForm: "implicit", provisional: false }]
            }
        }
    };
    const parameterLine = 12;
    const parameterColumn = source.split("\n")[parameterLine].indexOf("implicitValue");
    const implicitParameterEntry = {
        id: 4,
        name: "implicitValue",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "implicitValue", type: "parameter", typeName: "Integer",
            signature: "Sub implicitParameterProbe(ByVal implicitValue)",
            line: parameterLine, startColumn: parameterColumn,
            endColumn: parameterColumn + "implicitValue".length,
            parameters: [], modifiers: [],
            parentDeclaration: {
                name: "implicitParameterProbe", type: "sub",
                signature: "Sub implicitParameterProbe(ByVal implicitValue)",
                line: parameterLine, startColumn: 4
            },
            compilerFacts: {
                formalWrittenTypes: ["implicit"],
                parameterPassing: { mode: "byval", dimensions: 0, optional: false, receiver: false },
                properties: [{ name: "formal-written-mode", value: "1", provisional: false }]
            }
        }
    };
    const implicitArrayLine = 14;
    const implicitArrayColumn = source.split("\n")[implicitArrayLine].indexOf("values");
    const implicitArrayEntry = {
        id: 5,
        name: "values",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "values", type: "parameter", typeName: "Integer",
            signature: "Sub implicitArrayProbe(values())",
            line: implicitArrayLine, startColumn: implicitArrayColumn,
            endColumn: implicitArrayColumn + "values".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                formalWrittenTypes: ["implicit"],
                parameterPassing: { mode: "bydesc", dimensions: -1, optional: false, receiver: false }
            }
        }
    };
    const defaultModeLine = 16;
    const defaultModeColumn = source.split("\n")[defaultModeLine].indexOf("defaultModeValue");
    const defaultModeEntry = {
        id: 6,
        name: "defaultModeValue",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "defaultModeValue", type: "parameter", typeName: "Integer",
            signature: "Sub defaultModeProbe(defaultModeValue As Integer)",
            line: defaultModeLine, startColumn: defaultModeColumn,
            endColumn: defaultModeColumn + "defaultModeValue".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                formalWrittenTypes: ["as"],
                parameterPassing: { mode: "byval", dimensions: 0, optional: false, receiver: false },
                properties: [{ name: "formal-written-mode", value: "0", provisional: false }]
            }
        }
    };
    const suffixLine = 18;
    const suffixColumn = source.split("\n")[suffixLine].indexOf("suffixValue%");
    const suffixEntry = {
        id: 7,
        name: "suffixValue",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "suffixValue", type: "parameter", typeName: "Integer",
            signature: "Sub suffixParameterProbe(ByVal suffixValue)",
            line: suffixLine, startColumn: suffixColumn, endColumn: suffixColumn + "suffixValue".length,
            parameters: [], modifiers: []
        }
    };
    const suffixReturnLine = 20;
    const suffixReturnColumn = source.split("\n")[suffixReturnLine].indexOf("suffixReturn%");
    const suffixReturnEntry = {
        id: 8,
        name: "suffixReturn",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "suffixReturn", type: "function", typeName: "Integer",
            signature: "Function suffixReturn()",
            line: suffixReturnLine, startColumn: suffixReturnColumn,
            endColumn: suffixReturnColumn + "suffixReturn".length,
            parameters: [], modifiers: []
        }
    };
    const implicitDimLine = 23;
    const implicitDimColumn = source.split("\n")[implicitDimLine].indexOf("implicitDimValue");
    const implicitDimEntry = {
        id: 9,
        name: "implicitDimValue",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "implicitDimValue", type: "variable", typeName: "Integer",
            signature: "Dim implicitDimValue",
            line: implicitDimLine, startColumn: implicitDimColumn,
            endColumn: implicitDimColumn + "implicitDimValue".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                declarationInputs: [{ ordinal: 1, symbol: 91, writtenType: "implicit", group: {
                    identity: 7, statement: 7, kind: "dim", count: 1, provisional: false
                } }]
            }
        }
    };
    const implicitDimArrayLine = 24;
    const implicitDimArrayColumn = source.split("\n")[implicitDimArrayLine].indexOf("implicitDimArray");
    const implicitDimArrayEntry = {
        id: 10,
        name: "implicitDimArray",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "implicitDimArray", type: "variable", typeName: "Integer",
            signature: "Dim implicitDimArray(1)",
            line: implicitDimArrayLine, startColumn: implicitDimArrayColumn,
            endColumn: implicitDimArrayColumn + "implicitDimArray".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                declarationInputs: [{ ordinal: 1, symbol: 92, writtenType: "implicit", group: {
                    identity: 8, statement: 8, kind: "dim", count: 1, provisional: false
                } }]
            }
        }
    };
    const stringBoundLine = 25;
    const stringBoundColumn = source.split("\n")[stringBoundLine].indexOf("stringBoundArray");
    const stringBoundEntry = {
        id: 11,
        name: "stringBoundArray",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "stringBoundArray", type: "variable", typeName: "Integer",
            signature: "Dim stringBoundArray(Val(\")\"))",
            line: stringBoundLine, startColumn: stringBoundColumn,
            endColumn: stringBoundColumn + "stringBoundArray".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                declarationInputs: [{ ordinal: 1, symbol: 93, writtenType: "implicit", group: {
                    identity: 9, statement: 9, kind: "dim", count: 1, provisional: false
                } }]
            }
        }
    };
    const suffixDimLine = 26;
    const suffixDimColumn = source.split("\n")[suffixDimLine].indexOf("suffixDimValue%");
    const suffixDimEntry = {
        id: 12,
        name: "suffixDimValue",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "suffixDimValue", type: "variable", typeName: "Integer",
            signature: "Dim suffixDimValue",
            line: suffixDimLine, startColumn: suffixDimColumn,
            endColumn: suffixDimColumn + "suffixDimValue".length,
            parameters: [], modifiers: []
        }
    };
    const suffixArrayLine = 27;
    const suffixArrayColumn = source.split("\n")[suffixArrayLine].indexOf("suffixDimArray%");
    const suffixArrayEntry = {
        id: 13,
        name: "suffixDimArray",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "suffixDimArray", type: "variable", typeName: "Integer",
            signature: "Dim suffixDimArray(1)",
            line: suffixArrayLine, startColumn: suffixArrayColumn,
            endColumn: suffixArrayColumn + "suffixDimArray".length,
            parameters: [], modifiers: []
        }
    };
    const implicitConstantLine = 28;
    const implicitConstantColumn = source.split("\n")[implicitConstantLine].indexOf("implicitConstant");
    const implicitConstantEntry = {
        id: 14,
        name: "implicitConstant",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "implicitConstant", type: "const", typeName: "Integer",
            signature: "Const implicitConstant = 42",
            line: implicitConstantLine, startColumn: implicitConstantColumn,
            endColumn: implicitConstantColumn + "implicitConstant".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                declarationInputs: [{ ordinal: 1, symbol: 94, writtenType: "inferred", group: {
                    identity: 10, statement: 10, kind: "const", count: 1, provisional: false
                } }]
            }
        }
    };
    const inferredVarLine = 29;
    const inferredVarColumn = source.split("\n")[inferredVarLine].indexOf("inferredVar");
    const inferredVarEntry = {
        id: 15,
        name: "inferredVar",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "inferredVar", type: "variable", typeName: "Integer",
            signature: "Var inferredVar = 42",
            line: inferredVarLine, startColumn: inferredVarColumn,
            endColumn: inferredVarColumn + "inferredVar".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                declarationInputs: [{ ordinal: 1, symbol: 95, writtenType: "inferred", group: {
                    identity: 11, statement: 11, kind: "var", count: 1, provisional: false
                } }]
            }
        }
    };
    const byRefSuffixLine = 30;
    const byRefSuffixColumn = source.split("\n")[byRefSuffixLine].indexOf("byRefSuffixValue%");
    const byRefSuffixEntry = {
        id: 16,
        name: "byRefSuffixValue",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "byRefSuffixValue", type: "variable", typeName: "Integer",
            signature: "Dim ByRef byRefSuffixValue",
            line: byRefSuffixLine, startColumn: byRefSuffixColumn,
            endColumn: byRefSuffixColumn + "byRefSuffixValue".length,
            parameters: [], modifiers: [],
            compilerFacts: {
                declarationInputs: [{ ordinal: 1, symbol: 96, writtenType: "suffix", group: {
                    identity: 12, statement: 12, kind: "dim", count: 1, provisional: false
                } }]
            }
        }
    };
    const suffixConstantLine = 31;
    const suffixConstantColumn = source.split("\n")[suffixConstantLine].indexOf("suffixConstant%");
    const suffixConstantEntry = {
        id: 17,
        name: "suffixConstant",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "suffixConstant", type: "const", typeName: "Integer",
            signature: "Const suffixConstant = 7",
            line: suffixConstantLine, startColumn: suffixConstantColumn,
            endColumn: suffixConstantColumn + "suffixConstant".length,
            parameters: [], modifiers: []
        }
    };
    const implicitLocalLine = 33;
    const implicitLocalColumn = source.split("\n")[implicitLocalLine].indexOf("implicitLocal");
    const implicitLocalEntry = {
        id: 18,
        name: "implicitLocal",
        uri: { scheme: "file", fsPath: "/workspace/override.bas" },
        declaration: {
            name: "implicitLocal", type: "variable", typeName: "Integer",
            signature: "variable implicitLocal As Integer",
            line: implicitLocalLine, startColumn: implicitLocalColumn,
            endColumn: implicitLocalColumn + "implicitLocal".length,
            parameters: [], modifiers: [], compilerFacts: { compilerStorageClass: "local" }
        }
    };
    const explicitLocalAssignmentLine = 37;
    let hoverQueries = 0;
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            hoverQueries++;
            const entry = position.line === 4 ? methodEntry
                : position.line === implicitLine ? implicitFunctionEntry
                    : position.line === parameterLine ? implicitParameterEntry
                            : position.line === implicitArrayLine ? implicitArrayEntry
                                : position.line === defaultModeLine ? defaultModeEntry
                                    : position.line === suffixLine ? suffixEntry
                                        : position.line === suffixReturnLine ? suffixReturnEntry
                                            : position.line === implicitDimLine ? implicitDimEntry
                                                : position.line === implicitDimArrayLine ? implicitDimArrayEntry
                                                : position.line === stringBoundLine ? stringBoundEntry
                                                    : position.line === suffixDimLine ? suffixDimEntry
                                                        : position.line === suffixArrayLine ? suffixArrayEntry
                                                            : position.line === implicitConstantLine ? implicitConstantEntry
                                                                : position.line === inferredVarLine ? inferredVarEntry
                                                                    : position.line === byRefSuffixLine ? byRefSuffixEntry
                                                                        : position.line === suffixConstantLine ? suffixConstantEntry
                                                                            : position.line === implicitLocalLine ? implicitLocalEntry : abstractTypeEntry;
            return {
                entries: [entry],
                occurrence: { name: entry.name },
                expression: null,
                expressionAlternatives: [],
                expressionConstantValues: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 4, character: methodColumn + 2 });
    assert.match(hover.contents.value,
        /Compiler-selected override target: `BaseSelector\.Choose`\. The optional `Override` marker is not written\./);
    const abstractHover = await provider.provideHover(document, {
        line: abstractTypeLine,
        character: abstractTypeColumn + 2
    });
    assert.match(abstractHover.contents.value,
        /Compiler reports 1 unimplemented abstract member; this type cannot be instantiated until they are implemented\./);

    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    document.version = 1;
    document.positionAt = (offset) => {
        const prefix = source.slice(0, offset);
        return {
            line: (prefix.match(/\n/g) || []).length,
            character: offset - prefix.lastIndexOf("\n") - 1
        };
    };
    const codeActionProvider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({
            resolveAt(_uri, line) {
                return line === explicitLocalAssignmentLine ? [{ declaration: { type: "variable" } }] : [];
            }
        })
    });
    const markerActions = await codeActionProvider.provideCodeActions(document,
        new Range(4, 0, 4, source.split("\n")[4].length), { diagnostics: [] });
    assert.equal(markerActions.length, 1,
        "an explicit refactor request should offer the compiler-confirmed optional marker without a diagnostic");
    assert.equal(markerActions[0].title, "Add explicit 'Override' marker");
    assert.equal(markerActions[0].kind, "refactor.rewrite");
    assert.deepEqual(markerActions[0].edit.insertion.position, { line: 4, character: source.split("\n")[4].trimEnd().length });
    assert.equal(markerActions[0].edit.insertion.text, " Override");

    const returnTypeActions = await codeActionProvider.provideCodeActions(document,
        new Range(implicitLine, 0, implicitLine, source.split("\n")[implicitLine].length), { diagnostics: [] });
    assert.equal(returnTypeActions.length, 1);
    assert.equal(returnTypeActions[0].title, "Add explicit return type 'Integer'");
    assert.equal(returnTypeActions[0].edit.insertion.position.character, source.split("\n")[implicitLine].length);
    assert.equal(returnTypeActions[0].edit.insertion.text, " As Integer");
    implicitFunctionEntry.declaration.compilerFacts.procedureTypingInputs.push({
        identity: 2, statement: 2, kind: "function", role: "prototype", resultForm: "implicit", provisional: false
    });
    const ambiguousReturnActions = await codeActionProvider.provideCodeActions(document,
        new Range(implicitLine, 0, implicitLine, source.split("\n")[implicitLine].length), { diagnostics: [] });
    assert.equal(ambiguousReturnActions.length, 0,
        "the refactor should be withheld when more than one declaration form is present");

    const parameterActions = await codeActionProvider.provideCodeActions(document,
        new Range(parameterLine, parameterColumn, parameterLine, parameterColumn + "implicitValue".length),
        { diagnostics: [] });
    assert.equal(parameterActions.length, 1);
    assert.equal(parameterActions[0].title, "Add explicit parameter type 'Integer'");
    assert.equal(parameterActions[0].edit.insertion.position.character, parameterColumn + "implicitValue".length);
    assert.equal(parameterActions[0].edit.insertion.text, " As Integer");
    const arrayParameterActions = await codeActionProvider.provideCodeActions(document,
        new Range(implicitArrayLine, implicitArrayColumn, implicitArrayLine, implicitArrayColumn + "values".length),
        { diagnostics: [] });
    assert.equal(arrayParameterActions.length, 1,
        "the type refactor should place As after an array parameter's rank parentheses");
    assert.equal(arrayParameterActions[0].edit.insertion.position.character,
        implicitArrayColumn + "values()".length);
    assert.equal(arrayParameterActions[0].edit.insertion.text, " As Integer");
    const defaultModeActions = await codeActionProvider.provideCodeActions(document,
        new Range(defaultModeLine, defaultModeColumn, defaultModeLine, defaultModeColumn + "defaultModeValue".length),
        { diagnostics: [] });
    assert.equal(defaultModeActions.length, 1);
    assert.equal(defaultModeActions[0].title, "Make parameter passing mode explicit as 'ByVal'");
    assert.equal(defaultModeActions[0].edit.insertion.position.character, defaultModeColumn);
    assert.equal(defaultModeActions[0].edit.insertion.text, "ByVal ");
    const suffixActions = await codeActionProvider.provideCodeActions(document,
        new Range(suffixLine, suffixColumn, suffixLine, suffixColumn + "suffixValue%".length), { diagnostics: [] });
    assert.equal(suffixActions.length, 1);
    assert.equal(suffixActions[0].title, "Replace parameter type suffix with 'As Integer'");
    assert.deepEqual(suffixActions[0].edit.replacement.range,
        new Range(suffixLine, suffixColumn + "suffixValue".length, suffixLine, suffixColumn + "suffixValue%".length));
    assert.equal(suffixActions[0].edit.replacement.text, " As Integer");
    const suffixReturnActions = await codeActionProvider.provideCodeActions(document,
        new Range(suffixReturnLine, 0, suffixReturnLine, source.split("\n")[suffixReturnLine].length),
        { diagnostics: [] });
    assert.equal(suffixReturnActions.length, 1);
    assert.equal(suffixReturnActions[0].title, "Replace return type suffix with 'As Integer'");
    assert.deepEqual(suffixReturnActions[0].edit.deletion.range,
        new Range(suffixReturnLine, suffixReturnColumn + "suffixReturn".length,
            suffixReturnLine, suffixReturnColumn + "suffixReturn%".length));
    assert.equal(suffixReturnActions[0].edit.insertion.position.character,
        source.split("\n")[suffixReturnLine].length);
    assert.equal(suffixReturnActions[0].edit.insertion.text, " As Integer");
    const implicitDimActions = await codeActionProvider.provideCodeActions(document,
        new Range(implicitDimLine, implicitDimColumn, implicitDimLine,
            implicitDimColumn + "implicitDimValue".length), { diagnostics: [] });
    assert.equal(implicitDimActions.length, 1);
    assert.equal(implicitDimActions[0].title, "Add explicit variable type 'Integer'");
    assert.equal(implicitDimActions[0].edit.insertion.position.character,
        implicitDimColumn + "implicitDimValue".length);
    assert.equal(implicitDimActions[0].edit.insertion.text, " As Integer");
    const implicitArrayActions = await codeActionProvider.provideCodeActions(document,
        new Range(implicitDimArrayLine, implicitDimArrayColumn, implicitDimArrayLine,
            implicitDimArrayColumn + "implicitDimArray".length), { diagnostics: [] });
    assert.equal(implicitArrayActions.length, 1);
    assert.equal(implicitArrayActions[0].edit.insertion.position.character,
        implicitDimArrayColumn + "implicitDimArray(1)".length);
    assert.equal(implicitArrayActions[0].edit.insertion.text, " As Integer");
    const stringBoundActions = await codeActionProvider.provideCodeActions(document,
        new Range(stringBoundLine, stringBoundColumn, stringBoundLine,
            stringBoundColumn + "stringBoundArray".length), { diagnostics: [] });
    assert.equal(stringBoundActions.length, 1);
    assert.equal(stringBoundActions[0].edit.insertion.position.character,
        source.split("\n")[stringBoundLine].length);
    assert.equal(stringBoundActions[0].edit.insertion.text, " As Integer");
    const suffixDimActions = await codeActionProvider.provideCodeActions(document,
        new Range(suffixDimLine, suffixDimColumn, suffixDimLine, suffixDimColumn + "suffixDimValue%".length),
        { diagnostics: [] });
    assert.equal(suffixDimActions.length, 1);
    assert.equal(suffixDimActions[0].title, "Replace variable type suffix with 'As Integer'");
    assert.equal(suffixDimActions[0].edit.replacement.text, " As Integer");
    const suffixArrayActions = await codeActionProvider.provideCodeActions(document,
        new Range(suffixArrayLine, suffixArrayColumn, suffixArrayLine, suffixArrayColumn + "suffixDimArray%".length),
        { diagnostics: [] });
    assert.equal(suffixArrayActions.length, 1);
    assert.equal(suffixArrayActions[0].edit.deletion.range.start.character,
        suffixArrayColumn + "suffixDimArray".length);
    assert.equal(suffixArrayActions[0].edit.insertion.position.character,
        source.split("\n")[suffixArrayLine].length);
    assert.equal(suffixArrayActions[0].edit.insertion.text, " As Integer");
    const implicitConstantActions = await codeActionProvider.provideCodeActions(document,
        new Range(implicitConstantLine, implicitConstantColumn, implicitConstantLine,
            implicitConstantColumn + "implicitConstant".length), { diagnostics: [] });
    assert.equal(implicitConstantActions.length, 1);
    assert.equal(implicitConstantActions[0].title, "Add explicit constant type 'Integer'");
    assert.equal(implicitConstantActions[0].edit.insertion.position.character,
        implicitConstantColumn + "implicitConstant".length);
    assert.equal(implicitConstantActions[0].edit.insertion.text, " As Integer");
    const inferredVarActions = await codeActionProvider.provideCodeActions(document,
        new Range(inferredVarLine, inferredVarColumn, inferredVarLine,
            inferredVarColumn + "inferredVar".length), { diagnostics: [] });
    assert.equal(inferredVarActions.length, 1);
    assert.equal(inferredVarActions[0].title, "Make inferred Var type explicit as 'Integer'");
    assert.deepEqual(inferredVarActions[0].edit.replacement.range, new Range(inferredVarLine, 0, inferredVarLine, 3));
    assert.equal(inferredVarActions[0].edit.replacement.text, "Dim");
    assert.equal(inferredVarActions[0].edit.insertion.position.character,
        inferredVarColumn + "inferredVar".length);
    assert.equal(inferredVarActions[0].edit.insertion.text, " As Integer");
    const byRefSuffixActions = await codeActionProvider.provideCodeActions(document,
        new Range(byRefSuffixLine, byRefSuffixColumn, byRefSuffixLine,
            byRefSuffixColumn + "byRefSuffixValue%".length), { diagnostics: [] });
    assert.equal(byRefSuffixActions.length, 0,
        "the refactor should not place an As clause after the name of a ByRef declaration");
    const suffixConstantActions = await codeActionProvider.provideCodeActions(document,
        new Range(suffixConstantLine, suffixConstantColumn, suffixConstantLine,
            suffixConstantColumn + "suffixConstant%".length), { diagnostics: [] });
    assert.equal(suffixConstantActions.length, 1);
    assert.equal(suffixConstantActions[0].title, "Replace constant type suffix with 'As Integer'");
    assert.equal(suffixConstantActions[0].edit.replacement.text, " As Integer");
    const implicitLocalActions = await codeActionProvider.provideCodeActions(document,
        new Range(implicitLocalLine, implicitLocalColumn, implicitLocalLine,
            implicitLocalColumn + "implicitLocal".length), { diagnostics: [] });
    assert.equal(implicitLocalActions.length, 1);
    assert.equal(implicitLocalActions[0].title, "Declare implicit local as 'Integer'");
    assert.equal(implicitLocalActions[0].edit.replacement.range.start.character, implicitLocalColumn);
    assert.equal(implicitLocalActions[0].edit.replacement.range.end.character,
        implicitLocalColumn + "implicitLocal".length);
    assert.equal(implicitLocalActions[0].edit.replacement.text, "Dim implicitLocal As Integer");
    const queryCount = hoverQueries;
    const explicitLocalColumn = source.split("\n")[explicitLocalAssignmentLine].indexOf("explicitLocal");
    const explicitLocalActions = await codeActionProvider.provideCodeActions(document,
        new Range(explicitLocalAssignmentLine, explicitLocalColumn, explicitLocalAssignmentLine,
            explicitLocalColumn + "explicitLocal".length), { diagnostics: [] });
    assert.equal(explicitLocalActions.length, 0);
    assert.equal(hoverQueries, queryCount,
        "a source-resolved assignment should not start compiler analysis for an implicit-variable refactor");
});

test("compiler enum refactor writes the exact value only for implicit members", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    const source = [
        "Enum StableCode",
        "    FirstCode",
        "    ExplicitCode = 7",
        "    NextCode",
        "End Enum",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/enum-refactor.bas", toString: () => "file:///workspace/enum-refactor.bas" };
    document.version = 1;
    const makeEntry = (name, line, ordinal, explicit, value) => {
        const startColumn = source.split("\n")[line].indexOf(name);
        return {
            name,
            uri: document.uri,
            declaration: {
                name, type: "enumMember", signature: name, line, startColumn,
                endColumn: startColumn + name.length, parameters: [], modifiers: [],
                compilerFacts: {
                    enumElementInputs: [{
                        owner: 1, ordinal, filePath: document.uri.fsPath, line: line + 1,
                        startColumn, physical: true, explicit
                    }],
                    constantValues: [{ kind: "signed", value }]
                }
            }
        };
    };
    const entries = new Map([
        [1, makeEntry("FirstCode", 1, 1, false, "0")],
        [2, makeEntry("ExplicitCode", 2, 2, true, "7")],
        [3, makeEntry("NextCode", 3, 3, false, "8")]
    ]);
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const entry = entries.get(position.line);
            return { entries: entry ? [entry] : [] };
        }
    };
    let activeModel = model;
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        Position,
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => activeModel },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({
            resolveAt(_uri, line) {
                return line === 2 ? [{ declaration: { type: "enumMember" } }] : [];
            }
        })
    });

    const firstColumn = source.split("\n")[1].indexOf("FirstCode");
    const firstActions = await provider.provideCodeActions(document,
        new Range(1, firstColumn, 1, firstColumn + "FirstCode".length), { diagnostics: [] });
    assert.equal(firstActions.length, 1);
    assert.equal(firstActions[0].title, "Make enum value explicit as 0");
    assert.deepEqual(firstActions[0].edit.insertion.position, new Position(1, firstColumn + "FirstCode".length));
    assert.equal(firstActions[0].edit.insertion.text, " = 0");

    entries.get(1).declaration.compilerFacts.enumElementInputs.push({
        owner: 1, ordinal: 1, filePath: document.uri.fsPath, line: 2,
        startColumn: firstColumn, physical: true, explicit: true
    });
    const conflictingActions = await provider.provideCodeActions(document,
        new Range(1, firstColumn, 1, firstColumn + "FirstCode".length), { diagnostics: [] });
    assert.deepEqual(conflictingActions, [],
        "conflicting source occurrences must not be rewritten as an implicit enumerator");

    const explicitColumn = source.split("\n")[2].indexOf("ExplicitCode");
    const explicitActions = await provider.provideCodeActions(document,
        new Range(2, explicitColumn, 2, explicitColumn + "ExplicitCode".length), { diagnostics: [] });
    assert.deepEqual(explicitActions, [], "an explicitly initialized enum member must not receive a duplicate initializer");

    const sidecarNextColumn = source.split("\n")[3].indexOf("NextCode");
    activeModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { position }) {
            if (operation === "hover") {
                return {
                    entries: [],
                    compilerEnumElementFacts: { explicit: false, ordinal: 3 },
                    compilerEnumElementRange: {
                        line: 3,
                        startColumn: sidecarNextColumn,
                        endColumn: sidecarNextColumn + "NextCode".length
                    }
                };
            }
            assert.equal(operation, "compilerSidecarConstantAt");
            assert.deepEqual(position, { line: 3, character: sidecarNextColumn });
            return { kind: "signed", value: "8" };
        }
    };
    const sidecarActions = await provider.provideCodeActions(document,
        new Range(3, sidecarNextColumn, 3, sidecarNextColumn + "NextCode".length), { diagnostics: [] });
    assert.equal(sidecarActions.length, 1,
        "the stock semantic sidecar should support the same explicit-enum-value refactor");
    assert.equal(sidecarActions[0].title, "Make enum value explicit as 8");
    assert.equal(sidecarActions[0].edit.insertion.text, " = 8");
});

test("stock-sidecar refactor adds compiler-selected types to DIM declarations", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const source = "Dim implicitNumber\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-implicit-dim.bas",
        toString: () => "file:///workspace/stock-implicit-dim.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const declarationFacts = {
        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
        declarationInputs: [{
            ordinal: 1,
            symbol: 7,
            writtenType: "implicit",
            group: { identity: 2, statement: 1, kind: "dim", count: 1, provisional: false },
            provisional: false
        }],
        properties: []
    };
    let stockFacts = declarationFacts;
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [], compilerStorageTypeFacts: stockFacts };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const column = source.indexOf("implicitNumber");
    const actions = await provider.provideCodeActions(document,
        new Range(0, column, 0, column + "implicitNumber".length), { diagnostics: [] });
    assert.equal(actions.length, 1,
        "the stock sidecar should support the existing explicit-type refactor when it reports a complete DIM group");
    assert.equal(actions[0].title, "Add explicit variable type 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, { line: 0, character: column + "implicitNumber".length });
    assert.equal(actions[0].edit.insertion.text, " As Integer");

    stockFacts = {
        ...declarationFacts,
        declarationInputs: [{
            ...declarationFacts.declarationInputs[0],
            group: { ...declarationFacts.declarationInputs[0].group, count: 2 }
        }]
    };
    const multiSource = "Dim firstValue, secondValue\n";
    const multiDocument = createDocument(multiSource);
    multiDocument.uri = { scheme: "file", fsPath: "/workspace/stock-multi-dim.bas",
        toString: () => "file:///workspace/stock-multi-dim.bas" };
    multiDocument.version = 1;
    multiDocument.positionAt = (offset) => ({ line: 0, character: offset });
    const multiColumn = multiSource.indexOf("firstValue");
    const multiActions = await provider.provideCodeActions(multiDocument,
        new Range(0, multiColumn, 0, multiColumn + "firstValue".length), { diagnostics: [] });
    assert.equal(multiActions.length, 1,
        "a complete compiler input should permit typing one declarator within a multi-name DIM");
    assert.equal(multiActions[0].title, "Add explicit variable type 'Integer'");
    assert.deepEqual(multiActions[0].edit.insertion.position, {
        line: 0, character: multiColumn + "firstValue".length
    });
    assert.equal(multiActions[0].edit.insertion.text, " As Integer");

    stockFacts = {
        ...declarationFacts,
        declarationInputs: [{
            ...declarationFacts.declarationInputs[0],
            ordinal: 2,
            symbol: 8,
            group: { ...declarationFacts.declarationInputs[0].group, count: 2 }
        }]
    };
    const secondColumn = multiSource.indexOf("secondValue");
    const secondActions = await provider.provideCodeActions(multiDocument,
        new Range(0, secondColumn, 0, secondColumn + "secondValue".length), { diagnostics: [] });
    assert.equal(secondActions.length, 1);
    assert.deepEqual(secondActions[0].edit.insertion.position, {
        line: 0, character: secondColumn + "secondValue".length
    });
    assert.equal(secondActions[0].edit.insertion.text, " As Integer");

    stockFacts = {
        ...declarationFacts,
        declarationInputs: [{
            ...declarationFacts.declarationInputs[0],
            provisional: true,
            group: { ...declarationFacts.declarationInputs[0].group, count: 2, provisional: true }
        }]
    };
    assert.deepEqual(await provider.provideCodeActions(multiDocument,
        new Range(0, multiColumn, 0, multiColumn + "firstValue".length), { diagnostics: [] }), [],
    "provisional group facts should still withhold multi-declarator edits");

    stockFacts = declarationFacts;
    const arraySource = "Dim implicitArray(1)\n";
    const arrayDocument = createDocument(arraySource);
    arrayDocument.uri = { scheme: "file", fsPath: "/workspace/stock-array-dim.bas",
        toString: () => "file:///workspace/stock-array-dim.bas" };
    arrayDocument.version = 1;
    arrayDocument.positionAt = (offset) => ({ line: 0, character: offset });
    const arrayColumn = arraySource.indexOf("implicitArray");
    const arrayActions = await provider.provideCodeActions(arrayDocument,
        new Range(0, arrayColumn, 0, arrayColumn + "implicitArray".length), { diagnostics: [] });
    assert.equal(arrayActions.length, 1,
        "one untyped array DIM can safely reuse the compiler-selected element type");
    assert.equal(arrayActions[0].title, "Add explicit variable type 'Integer'");
    assert.equal(arrayActions[0].edit.insertion.position.character, arraySource.indexOf(")") + 1,
        "the explicit element type should follow the array bounds");
    assert.equal(arrayActions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar refactor adds compiler-selected types to Static, Common, and Extern declarations", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const declarations = [
        ["Static", "static", "implicitStaticValue"],
        ["Common", "common", "implicitCommonValue"],
        ["Extern", "extern", "implicitExternValue"]
    ];
    const source = declarations.map(([keyword, _kind, name]) => `${keyword} ${name}`).join("\n") + "\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-implicit-storage-types.bas",
        toString: () => "file:///workspace/stock-implicit-storage-types.bas" };
    document.version = 1;
    const lineOffsets = [0, ...[...source.matchAll(/\n/g)].map((match) => match.index + 1)];
    document.positionAt = (offset) => {
        let line = 0;
        while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= offset) line++;
        return { line, character: offset - lineOffsets[line] };
    };
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const groupKind = declarations[position.line][1];
            return {
                entries: [],
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    declarationInputs: [{
                        ordinal: 1,
                        symbol: 30 + position.line,
                        writtenType: "implicit",
                        group: {
                            identity: 10 + position.line,
                            statement: position.line + 1,
                            kind: groupKind,
                            count: 1,
                            provisional: false
                        },
                        provisional: false
                    }],
                    properties: []
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    for (let line = 0; line < declarations.length; line++) {
        const [, , name] = declarations[line];
        const startColumn = source.split("\n")[line].indexOf(name);
        const actions = await provider.provideCodeActions(document,
            new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] });
        assert.equal(actions.length, 1, `expected an exact type refactor for ${declarations[line][0]}`);
        assert.equal(actions[0].title, "Add explicit variable type 'Integer'");
        assert.deepEqual(actions[0].edit.insertion.position, { line, character: startColumn + name.length });
        assert.equal(actions[0].edit.insertion.text, " As Integer");
    }
});

test("stock-sidecar refactor replaces a compiler-confirmed variable type suffix", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const source = "Dim stockSuffixValue%\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-suffix-dim.bas",
        toString: () => "file:///workspace/stock-suffix-dim.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const startColumn = source.indexOf("stockSuffixValue");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    declarationInputs: [{
                        ordinal: 1,
                        symbol: 17,
                        writtenType: "suffix",
                        group: { identity: 4, statement: 1, kind: "dim", count: 1, provisional: false },
                        provisional: false
                    }],
                    properties: []
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "stockSuffixValue%".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Replace variable type suffix with 'As Integer'");
    assert.deepEqual(actions[0].edit.replacement.range,
        new Range(0, startColumn + "stockSuffixValue".length,
            0, startColumn + "stockSuffixValue%".length));
    assert.equal(actions[0].edit.replacement.text, " As Integer");
});

test("stock-sidecar array suffix refactor inserts As after the compiler-visible bounds", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const source = "Dim stockSuffixArray%(1)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-suffix-array.bas",
        toString: () => "file:///workspace/stock-suffix-array.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const startColumn = source.indexOf("stockSuffixArray");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    declarationInputs: [{
                        ordinal: 1,
                        symbol: 21,
                        writtenType: "suffix",
                        group: { identity: 9, statement: 1, kind: "dim", count: 1, provisional: false },
                        provisional: false
                    }],
                    properties: []
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "stockSuffixArray%".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Replace variable type suffix with 'As Integer'");
    assert.deepEqual(actions[0].edit.deletion.range,
        new Range(0, startColumn + "stockSuffixArray".length,
            0, startColumn + "stockSuffixArray%".length));
    assert.deepEqual(actions[0].edit.insertion.position, { line: 0, character: source.indexOf(")") + 1 });
    assert.equal(actions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar refactor writes inferred and suffix constant types", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const source = [
        "Const inferredStockConstant = 42",
        "Const suffixStockConstant% = 7",
        "Const inferredConstantPairA = 42, inferredConstantPairB = 1.5",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-constant-types.bas",
        toString: () => "file:///workspace/stock-constant-types.bas" };
    document.version = 1;
    const lineOffsets = [0, ...[...source.matchAll(/\n/g)].map((match) => match.index + 1)];
    document.positionAt = (offset) => {
        let line = 0;
        while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= offset) line++;
        return { line, character: offset - lineOffsets[line] };
    };
    const inferredColumn = source.split("\n")[0].indexOf("inferredStockConstant");
    const suffixColumn = source.split("\n")[1].indexOf("suffixStockConstant");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const suffix = position.line === 1;
            const multiConstant = position.line === 2;
            return {
                entries: [],
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    declarationInputs: [{
                        ordinal: 1,
                        symbol: suffix ? 11 : multiConstant ? 12 : 10,
                        writtenType: suffix ? "suffix" : "inferred",
                        group: {
                            identity: suffix ? 6 : multiConstant ? 7 : 5,
                            statement: position.line + 1,
                            kind: "const",
                            count: multiConstant ? 2 : 1,
                            provisional: false
                        },
                        provisional: false
                    }],
                    properties: []
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const inferredActions = await provider.provideCodeActions(document,
        new Range(0, inferredColumn, 0, inferredColumn + "inferredStockConstant".length), { diagnostics: [] });
    assert.equal(inferredActions.length, 1);
    assert.equal(inferredActions[0].title, "Add explicit constant type 'Integer'");
    assert.deepEqual(inferredActions[0].edit.insertion.position, {
        line: 0, character: inferredColumn + "inferredStockConstant".length
    });
    assert.equal(inferredActions[0].edit.insertion.text, " As Integer");

    const suffixActions = await provider.provideCodeActions(document,
        new Range(1, suffixColumn, 1, suffixColumn + "suffixStockConstant%".length), { diagnostics: [] });
    assert.equal(suffixActions.length, 1);
    assert.equal(suffixActions[0].title, "Replace constant type suffix with 'As Integer'");
    assert.deepEqual(suffixActions[0].edit.replacement.range,
        new Range(1, suffixColumn + "suffixStockConstant".length,
            1, suffixColumn + "suffixStockConstant%".length));
    assert.equal(suffixActions[0].edit.replacement.text, " As Integer");

    const pairName = "inferredConstantPairA";
    const pairColumn = source.split("\n")[2].indexOf(pairName);
    const pairActions = await provider.provideCodeActions(document,
        new Range(2, pairColumn, 2, pairColumn + pairName.length), { diagnostics: [] });
    assert.equal(pairActions.length, 1);
    assert.equal(pairActions[0].title, "Add explicit constant type 'Integer'");
    assert.deepEqual(pairActions[0].edit.insertion.position, {
        line: 2, character: pairColumn + pairName.length
    });
    assert.equal(pairActions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar refactor makes a single inferred Var type explicit", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const source = "Var stockInferredVar = 42\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-inferred-var.bas",
        toString: () => "file:///workspace/stock-inferred-var.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const startColumn = source.indexOf("stockInferredVar");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    declarationInputs: [{
                        ordinal: 1,
                        symbol: 19,
                        writtenType: "inferred",
                        group: { identity: 8, statement: 1, kind: "var", count: 1, provisional: false },
                        provisional: false
                    }],
                    properties: []
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "stockInferredVar".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make inferred Var type explicit as 'Integer'");
    assert.deepEqual(actions[0].edit.replacement.range, new Range(0, 0, 0, 3));
    assert.equal(actions[0].edit.replacement.text, "Dim");
    assert.deepEqual(actions[0].edit.insertion.position, {
        line: 0, character: startColumn + "stockInferredVar".length
    });
    assert.equal(actions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar refactor declares an implicit local with its compiler-selected type", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const source = "Sub StorageProbe()\n    implicitLocal = 1\n    Let _\n        implicitLetLocal _\n            = 2\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-implicit-local.bas",
        toString: () => "file:///workspace/stock-implicit-local.bas" };
    document.version = 1;
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const lineText = source.split("\n")[position.line];
            const targetName = lineText.includes("implicitLetLocal") ? "implicitLetLocal" : "implicitLocal";
            const startColumn = lineText.indexOf(targetName);
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                },
                compilerStorageTypeDeclarationRange: {
                    line: position.line,
                    startColumn,
                    endColumn: startColumn + targetName.length
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const column = source.split("\n")[1].indexOf("implicitLocal");
    const actions = await provider.provideCodeActions(document,
        new Range(1, column, 1, column + "implicitLocal".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.equal(actions[0].edit.replacement.text, "Dim implicitLocal As Integer");

    const letLine = source.split("\n")[3];
    const letNameStart = letLine.indexOf("implicitLetLocal");
    const letActions = await provider.provideCodeActions(document,
        new Range(3, letNameStart, 3, letNameStart + "implicitLetLocal".length), { diagnostics: [] });
    assert.equal(letActions.length, 1);
    assert.equal(letActions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual({
        line: letActions[0].edit.insertion.position.line,
        character: letActions[0].edit.insertion.position.character
    }, { line: 2, character: 0 });
    assert.equal(letActions[0].edit.insertion.text, "    Dim implicitLetLocal As Integer\n");
});

test("stock-sidecar refactor declares an implicit FBLite local before its first read", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        '#lang "fblite"',
        "Print implicitModuleFirstRead",
        "Sub FirstReadRefactorProbe()",
        "    Print implicitFirstRead",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/fblite-first-read-refactor.bas",
        toString: () => "file:///workspace/fblite-first-read-refactor.bas" };
    document.version = 1;
    const moduleLine = 1;
    const moduleName = "implicitModuleFirstRead";
    const moduleStartColumn = document.lineAt(moduleLine).text.indexOf(moduleName);
    const line = 3;
    const lineText = document.lineAt(line).text;
    const name = "implicitFirstRead";
    const startColumn = lineText.indexOf(name);
    let storageFacts = {
        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
        properties: []
    };
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const selectedName = position.line === moduleLine ? moduleName : name;
            const selectedLine = position.line === moduleLine ? moduleLine : line;
            const selectedStartColumn = position.line === moduleLine ? moduleStartColumn : startColumn;
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: storageFacts,
                compilerStorageTypeDeclarationRange: {
                    line: selectedLine,
                    startColumn: selectedStartColumn,
                    endColumn: selectedStartColumn + selectedName.length
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const moduleActions = await provider.provideCodeActions(document,
        new Range(moduleLine, moduleStartColumn, moduleLine, moduleStartColumn + moduleName.length), { diagnostics: [] });
    assert.equal(moduleActions.length, 1);
    assert.equal(moduleActions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(moduleActions[0].edit.insertion.position, new Position(moduleLine, 0));
    assert.equal(moduleActions[0].edit.insertion.text, "Dim implicitModuleFirstRead As Integer\n");

    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(line, 0));
    assert.equal(actions[0].edit.insertion.text, "    Dim implicitFirstRead As Integer\n");

    storageFacts = {
        storageType: { primitive: "integer", storageBytes: 8, pointerDepth: 1, isReference: false },
        properties: []
    };
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] }), [],
    "a first-read pointer must not be rewritten as a scalar declaration");
    storageFacts = {
        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
        arrayBounds: { mode: "runtime", rank: 1 },
        properties: []
    };
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] }), [],
    "a first-read array must not be rewritten as a scalar declaration");
});

test("implicit-allocation warning offers the compiler-typed declaration Quick Fix", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        '#lang "deprecated"',
        "Sub ImplicitAllocationProbe()",
        "    Print implicitValue + implicitValue",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-allocation-quickfix.bas",
        toString: () => "file:///workspace/implicit-allocation-quickfix.bas" };
    document.version = 1;
    const line = 2;
    const name = "implicitValue";
    const startColumn = document.lineAt(line).text.indexOf(name);
    const warning = {
        source: "fbc (buffer)",
        severity: 1,
        message: "Implicit variable allocation,\n\nimplicitValue",
        range: new Range(line, startColumn, line, startColumn + name.length)
    };
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    properties: []
                },
                compilerStorageTypeDeclarationRange: {
                    line, startColumn, endColumn: startColumn + name.length
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        Position,
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const actions = await provider.provideCodeActions(document,
        warning.range, { diagnostics: [warning] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.equal(actions[0].kind, "quickfix");
    assert.deepEqual(actions[0].diagnostics, [warning]);
    assert.equal(actions[0].isPreferred, true);
    assert.deepEqual(actions[0].edit.insertion.position, new Position(line, 0));
    assert.equal(actions[0].edit.insertion.text, "    Dim implicitValue As Integer\n");

    const repeatedSource = source;
    const repeatedLineText = repeatedSource.split("\n")[line];
    const repeatedDocument = {
        ...document,
        getText: () => repeatedSource,
        lineAt: (currentLine) => ({ text: repeatedSource.split("\n")[currentLine] })
    };
    const repeatedWarning = {
        ...warning,
        range: new Range(line, 0, line, repeatedLineText.length)
    };
    const repeatedActions = await provider.provideCodeActions(repeatedDocument,
        repeatedWarning.range, { diagnostics: [repeatedWarning] });
    assert.equal(repeatedActions.length, 1,
        "the compiler declaration binding should disambiguate a repeated read on the warning line");
    assert.equal(repeatedActions[0].kind, "quickfix");
    assert.deepEqual(repeatedActions[0].edit.insertion.position, new Position(line, 0));

    const unrelatedWarning = {
        ...repeatedWarning,
        message: "Implicit variable allocation,\n\notherValue",
        sourceText: "otherValue"
    };
    const unrelatedActions = await provider.provideCodeActions(repeatedDocument,
        unrelatedWarning.range, { diagnostics: [unrelatedWarning] });
    assert.deepEqual(unrelatedActions, [],
        "a compiler warning for another spelling must not authorize the implicit declaration edit");
});

test("stock-sidecar refactor declares a masked implicit REM local with the compiler-selected type", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemImplicitRefactorProbe()",
        "    REM = 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/rem-implicit-refactor.bas",
        toString: () => "file:///workspace/rem-implicit-refactor.bas" };
    document.version = 1;
    const line = 5;
    const startColumn = document.lineAt(line).text.indexOf("REM");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                    properties: []
                },
                compilerStorageTypeDeclarationRange: {
                    line,
                    startColumn,
                    endColumn: startColumn + "REM".length
                }
            };
        }
    };
    const analysisRequests = [];
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async (_document, _token, needExpressionTypes, needSemanticBindings) => {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });
    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + "REM".length), { diagnostics: [] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(line, 0));
    assert.equal(actions[0].edit.insertion.text, "    Dim REM As Integer\n");
    assert.deepEqual(analysisRequests, [[false, true]],
        "the masked first write should request compiler bindings on demand");
});

test("editor-bridge refactor declares a masked implicit REM local from native type facts", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub BridgeRemImplicitRefactorProbe()",
        "    REM = 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/bridge-rem-implicit-refactor.bas",
        toString: () => "file:///workspace/bridge-rem-implicit-refactor.bas" };
    const line = 5;
    const startColumn = document.lineAt(line).text.indexOf("REM");
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [{
                    name: "REM",
                    declaration: {
                        name: "REM", type: "variable", line, startColumn,
                        endColumn: startColumn + 3, signature: "variable REM As integer",
                        modifiers: [], provisional: false
                    },
                    compilerFacts: {
                        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
                        compilerStorageClass: "local"
                    }
                }]
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ compilerPath: "/compiler/fbc-editor", semanticModelOnly: false }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });
    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + "REM".length), { diagnostics: [] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.equal(actions[0].edit.insertion.text, "    Dim REM As Integer\n");
    assert.deepEqual(requests, [[false, true]]);
});

test("native bridge offers a typed refactor for an unsaved FBLite first-read local", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        '#lang "fblite"',
        "Print implicitModuleFirstRead",
        "Sub UnsavedFirstReadRefactorProbe()",
        "    Print implicitFirstRead",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/unsaved-fblite-first-read-refactor.bas",
        toString: () => "file:///workspace/unsaved-fblite-first-read-refactor.bas" };
    document.version = 1;
    document.isDirty = true;
    const moduleLine = 1;
    const moduleName = "implicitModuleFirstRead";
    const moduleStartColumn = document.lineAt(moduleLine).text.indexOf(moduleName);
    const line = 3;
    const name = "implicitFirstRead";
    const startColumn = document.lineAt(line).text.indexOf(name);
    const requests = [];
    const compilerFacts = {
        compilerStorageClass: "local",
        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
        properties: []
    };
    const model = {
        remote: true,
        semanticSidecarOnly: false,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [{
                    name,
                    declaration: {
                        type: "variable",
                        name,
                        line,
                        startColumn,
                        endColumn: startColumn + name.length,
                        typeName: "Integer",
                        provisional: false
                    },
                    compilerFacts
                }]
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: async (_document, _token, needTypes, needBindings) => {
                requests.push([needTypes, needBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(line, 0));
    assert.equal(actions[0].edit.insertion.text, "    Dim implicitFirstRead As Integer\n");
    assert.ok(requests.length > 0, "the native bridge should analyze the unsaved first-read local");

    compilerFacts.storageType.pointerDepth = 1;
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] }), [],
    "a native first-read pointer must not be rewritten as a scalar declaration");
    compilerFacts.storageType.pointerDepth = 0;
    compilerFacts.arrayBounds = { mode: "runtime", rank: 1 };
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] }), [],
    "a native first-read array must not be rewritten as a scalar declaration");

    const nativeModel = {
        remote: true,
        semanticSidecarOnly: false,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const selectedName = position.line === moduleLine ? moduleName : name;
            const selectedLine = position.line === moduleLine ? moduleLine : line;
            const selectedStartColumn = position.line === moduleLine ? moduleStartColumn : startColumn;
            return { entries: [{
                name: selectedName,
                declaration: {
                    type: "variable",
                    name: selectedName,
                    line: selectedLine,
                    startColumn: selectedStartColumn,
                    endColumn: selectedStartColumn + selectedName.length,
                    typeName: "Integer",
                    provisional: false
                },
                compilerFacts: {
                    compilerStorageClass: "local",
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            }] };
        }
    };
    document.isDirty = true;
    const nativeProvider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: async () => nativeModel
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });
    const nativeModuleActions = await nativeProvider.provideCodeActions(document,
        new Range(moduleLine, moduleStartColumn, moduleLine, moduleStartColumn + moduleName.length), { diagnostics: [] });
    assert.equal(nativeModuleActions.length, 1);
    assert.deepEqual(nativeModuleActions[0].edit.insertion.position, new Position(moduleLine, 0));
    assert.equal(nativeModuleActions[0].edit.insertion.text, "Dim implicitModuleFirstRead As Integer\n");
});

test("native bridge places an unsaved continued LET declaration before its statement", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        '#lang "deprecated"',
        "Sub UnsavedContinuedLetRefactorProbe()",
        "    Let _",
        "        implicitContinuedValue _",
        "            = 2",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/unsaved-continued-let-refactor.bas",
        toString: () => "file:///workspace/unsaved-continued-let-refactor.bas" };
    document.version = 1;
    document.isDirty = true;
    const name = "implicitContinuedValue";
    const line = 3;
    const startColumn = document.lineAt(line).text.indexOf(name);
    const compilerFacts = {
        compilerStorageClass: "local",
        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
    };
    const model = {
        remote: true,
        semanticSidecarOnly: false,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [{
                name,
                declaration: {
                    type: "variable",
                    name,
                    line,
                    startColumn,
                    endColumn: startColumn + name.length,
                    typeName: "Integer",
                    provisional: false
                },
                compilerFacts
            }] };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(2, 0));
    assert.equal(actions[0].edit.insertion.text, "    Dim implicitContinuedValue As Integer\n");
});

test("native bridge types an unsaved continued FOR counter at its physical token", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        '#lang "deprecated"',
        "Sub UnsavedContinuedForRefactorProbe()",
        "    For _",
        "        implicitLoopCounter = 1 To 3",
        "    Next implicitLoopCounter",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/unsaved-continued-for-refactor.bas",
        toString: () => "file:///workspace/unsaved-continued-for-refactor.bas" };
    document.version = 1;
    document.isDirty = true;
    const name = "implicitLoopCounter";
    const line = 3;
    const startColumn = document.lineAt(line).text.indexOf(name);
    const model = {
        remote: true,
        semanticSidecarOnly: false,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [{
                name,
                declaration: {
                    type: "variable",
                    name,
                    line,
                    startColumn,
                    endColumn: startColumn + name.length,
                    typeName: "Integer",
                    provisional: false
                },
                compilerFacts: {
                    compilerStorageClass: "local",
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            }] };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make loop counter type explicit as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(line, startColumn + name.length));
    assert.equal(actions[0].edit.insertion.text, " As Integer");
});

test("native bridge refactors unsaved INPUT, continued SWAP, and REDIM targets", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        '#lang "deprecated"',
        "Sub UnsavedInputSwapProbe()",
        '    Input "Value"; implicitInputValue',
        "    Swap implicitSwapFirst, _",
        "        implicitSwapSecond",
        "End Sub",
        "Sub UnsavedRedimProbe()",
        "    ReDim _",
        "        implicitOverlayArray(0 To 2)",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/unsaved-input-swap-refactor.bas",
        toString: () => "file:///workspace/unsaved-input-swap-refactor.bas" };
    document.version = 1;
    document.isDirty = true;
    const targets = [
        { name: "implicitInputValue", line: 2, statementLine: 2, array: false },
        { name: "implicitSwapSecond", line: 4, statementLine: 3, array: false },
        { name: "implicitOverlayArray", line: 8, statementLine: 7, array: true }
    ];
    const model = {
        remote: true,
        semanticSidecarOnly: false,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const target = targets.find((candidate) => candidate.line === position.line);
            assert.ok(target);
            const startColumn = document.lineAt(target.line).text.indexOf(target.name);
            return { entries: [{
                name: target.name,
                declaration: {
                    type: "variable",
                    name: target.name,
                    line: target.line,
                    startColumn,
                    endColumn: startColumn + target.name.length,
                    typeName: "Integer",
                    provisional: false
                },
                compilerFacts: {
                    compilerStorageClass: "local",
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            }] };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    for (const target of targets) {
        const startColumn = document.lineAt(target.line).text.indexOf(target.name);
        const actions = await provider.provideCodeActions(document,
            new Range(target.line, startColumn, target.line, startColumn + target.name.length), { diagnostics: [] });
        assert.equal(actions.length, 1);
        assert.equal(actions[0].title, target.array
            ? "Declare implicit array as 'Integer'" : "Declare implicit local as 'Integer'");
        assert.deepEqual(actions[0].edit.insertion.position, new Position(target.statementLine, 0));
        assert.equal(actions[0].edit.insertion.text, target.array
            ? `    Dim ${target.name}() As Integer\n`
            : `    Dim ${target.name} As Integer\n`);
    }
});

test("stock-sidecar refactor declares an implicit compound-assignment local", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        "Sub CompoundRefactorProbe()",
        "    implicitCompoundValue _",
        "        += 1",
        "    Dim existingCompound As Integer",
        "    existingCompound += 1",
        "    implicitSuffix% += 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-compound-refactor.bas",
        toString: () => "file:///workspace/implicit-compound-refactor.bas" };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            requests.push(position.line);
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({
            resolveAt: (_uri, line) => line === 4 ? [{ name: "existingCompound" }] : []
        })
    });

    const implicitLine = source.split("\n")[1];
    const implicitStart = implicitLine.indexOf("implicitCompoundValue");
    const actions = await provider.provideCodeActions(document,
        new Range(1, implicitStart, 1, implicitStart + "implicitCompoundValue".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(1, 0));
    assert.equal(actions[0].edit.insertion.text, "    Dim implicitCompoundValue As Integer\n");

    const existingLine = source.split("\n")[4];
    const existingStart = existingLine.indexOf("existingCompound");
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(4, existingStart, 4, existingStart + "existingCompound".length), { diagnostics: [] }), [],
    "an existing variable is not redeclared when it receives a compound update");
    const suffixLine = source.split("\n")[5];
    const suffixStart = suffixLine.indexOf("implicitSuffix%");
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(5, suffixStart, 5, suffixStart + "implicitSuffix%".length), { diagnostics: [] }), [],
    "a type suffix already makes the target type explicit");
    assert.deepEqual(requests, [1], "only the unresolved untyped compound target should query FBC");
});

test("stock-sidecar refactor declares implicit SWAP targets before the statement", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        "Sub SwapRefactorProbe()",
        "    Swap implicitSwapFirst, _",
        "        implicitSwapSecond",
        "    Dim declaredFirst As Integer, declaredSecond As Integer",
        "    Swap declaredFirst, declaredSecond",
        "    Swap suffixFirst%, suffixSecond%",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-swap-refactor.bas",
        toString: () => "file:///workspace/implicit-swap-refactor.bas" };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            requests.push(position.line);
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({
            resolveAt: (_uri, line) => line === 4 ? [{ name: "declaredFirst" }] : []
        })
    });

    const line = source.split("\n")[1];
    const startColumn = line.indexOf("implicitSwapFirst");
    const actions = await provider.provideCodeActions(document,
        new Range(1, startColumn, 1, startColumn + "implicitSwapFirst".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(1, 0));
    assert.equal(actions[0].edit.insertion.text, "    Dim implicitSwapFirst As Integer\n");

    const continuedLine = source.split("\n")[2];
    const continuedStart = continuedLine.indexOf("implicitSwapSecond");
    const continuedActions = await provider.provideCodeActions(document,
        new Range(2, continuedStart, 2, continuedStart + "implicitSwapSecond".length), { diagnostics: [] });
    assert.equal(continuedActions.length, 1);
    assert.equal(continuedActions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(continuedActions[0].edit.insertion.position, new Position(1, 0),
        "the declaration for a continued SWAP target must precede the whole statement");
    assert.equal(continuedActions[0].edit.insertion.text, "    Dim implicitSwapSecond As Integer\n");

    const existingLine = source.split("\n")[4];
    const existingStart = existingLine.indexOf("declaredFirst");
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(4, existingStart, 4, existingStart + "declaredFirst".length), { diagnostics: [] }), [],
    "an existing SWAP variable must not be turned into another declaration");
    const suffixLine = source.split("\n")[5];
    const suffixStart = suffixLine.indexOf("suffixFirst%");
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(5, suffixStart, 5, suffixStart + "suffixFirst%".length), { diagnostics: [] }), [],
    "a type suffix already makes the SWAP target type explicit");
    assert.deepEqual(requests, [1, 2], "only unresolved untyped SWAP targets should query FBC");
});

test("stock-sidecar refactor declares implicit LSET and RSET targets with compiler types", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        "DefStr I",
        "Sub StringWriteRefactorProbe()",
        "    LSet _",
        '        implicitLeftText = "left"',
        "    RSet _",
        '        implicitRightText = "right"',
        "    Dim declaredText As String",
        '    LSet declaredText = "declared"',
        '    LSet suffixText$ = "suffix"',
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/lset-rset-refactor.bas",
        toString: () => "file:///workspace/lset-rset-refactor.bas" };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            requests.push(position.line);
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "string", storageBytes: 12, pointerDepth: 0, isReference: false }
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({
            resolveAt: (_uri, line) => line === 7 ? [{ name: "declaredText" }] : []
        })
    });

    for (const [line, name, insertionLine] of [
        [3, "implicitLeftText", 2], [5, "implicitRightText", 4]
    ]) {
        const lineText = source.split("\n")[line];
        const startColumn = lineText.indexOf(name);
        const actions = await provider.provideCodeActions(document,
            new Range(line, startColumn, line, startColumn + name.length), { diagnostics: [] });
        assert.equal(actions.length, 1);
        assert.equal(actions[0].title, "Declare implicit local as 'String'");
        assert.deepEqual(actions[0].edit.insertion.position, new Position(insertionLine, 0));
        assert.equal(actions[0].edit.insertion.text, `    Dim ${name} As String\n`);
    }

    const declaredLine = source.split("\n")[7];
    const declaredStart = declaredLine.indexOf("declaredText");
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(7, declaredStart, 7, declaredStart + "declaredText".length), { diagnostics: [] }), [],
    "an existing LSET destination must not receive a second declaration");
    const suffixLine = source.split("\n")[8];
    const suffixStart = suffixLine.indexOf("suffixText$");
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(8, suffixStart, 8, suffixStart + "suffixText$".length), { diagnostics: [] }), [],
    "a type suffix already makes the LSET destination type explicit");
    assert.deepEqual(requests, [3, 5], "only new untyped LSET/RSET targets should query FBC");
});

test("stock-sidecar refactor declares implicit INPUT, READ, and GET targets using compiler types", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        'Input "Module value: "; moduleInput',
        "Sub InputReadRefactorProbe()",
        '    Input "Value: "; inputValue',
        "    Read readValue",
        "    Get #1, , getValue",
        "    Dim existingGetValue As Integer",
        "    Get #1, , existingGetValue",
        "    Dim explicitValue As Integer",
        "    Input explicitValue",
        '    Input "Continued value: " _',
        "        , continuedValue",
        "    Get #1, , _",
        "        continuedGetValue",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/input-read-refactor.bas",
        toString: () => "file:///workspace/input-read-refactor.bas" };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            requests.push(position.line);
            const primitive = position.line === 3 ? "double" : "integer";
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: {
                        primitive,
                        storageBytes: primitive === "integer" ? 4 : 8,
                        pointerDepth: 0,
                        isReference: false
                    },
                    properties: []
                }
            };
        }
    };
    const sourceModel = {
        resolveAt: (_uri, line) => [6, 8].includes(line) ? [{ name: "alreadyDeclared" }] : []
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => sourceModel
    });

    const moduleLine = source.split("\n")[0];
    const moduleStart = moduleLine.indexOf("moduleInput");
    const moduleActions = await provider.provideCodeActions(document,
        new Range(0, moduleStart, 0, moduleStart + "moduleInput".length), { diagnostics: [] });
    assert.deepEqual(moduleActions, [], "module-initializer locals must not be turned into procedure Dim declarations");
    assert.deepEqual(requests, [], "the non-local-context check should run before requesting sidecar bindings");

    const inputLine = source.split("\n")[2];
    const inputStart = inputLine.indexOf("inputValue");
    const inputActions = await provider.provideCodeActions(document,
        new Range(2, inputStart, 2, inputStart + "inputValue".length), { diagnostics: [] });
    assert.equal(inputActions.length, 1);
    assert.equal(inputActions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(inputActions[0].edit.insertion.position, new Position(2, 0));
    assert.equal(inputActions[0].edit.insertion.text, "    Dim inputValue As Integer\n");

    const continuedLine = source.split("\n")[10];
    const continuedStart = continuedLine.indexOf("continuedValue");
    const continuedActions = await provider.provideCodeActions(document,
        new Range(10, continuedStart, 10, continuedStart + "continuedValue".length), { diagnostics: [] });
    assert.equal(continuedActions.length, 1);
    assert.equal(continuedActions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(continuedActions[0].edit.insertion.position, new Position(9, 0),
        "the typed declaration must precede the continued INPUT statement, not split its continuation");
    assert.equal(continuedActions[0].edit.insertion.text, "    Dim continuedValue As Integer\n");

    const readLine = source.split("\n")[3];
    const readStart = readLine.indexOf("readValue");
    const readActions = await provider.provideCodeActions(document,
        new Range(3, readStart, 3, readStart + "readValue".length), { diagnostics: [] });
    assert.equal(readActions.length, 1);
    assert.equal(readActions[0].title, "Declare implicit local as 'Double'");
    assert.equal(readActions[0].edit.insertion.text, "    Dim readValue As Double\n");
    assert.deepEqual(requests, [2, 10, 3]);

    const getLine = source.split("\n")[4];
    const getStart = getLine.indexOf("getValue");
    const getActions = await provider.provideCodeActions(document,
        new Range(4, getStart, 4, getStart + "getValue".length), { diagnostics: [] });
    assert.equal(getActions.length, 1);
    assert.equal(getActions[0].title, "Declare implicit local as 'Integer'");
    assert.equal(getActions[0].edit.insertion.text, "    Dim getValue As Integer\n");

    const continuedGetLine = source.split("\n")[12];
    const continuedGetStart = continuedGetLine.indexOf("continuedGetValue");
    const continuedGetActions = await provider.provideCodeActions(document,
        new Range(12, continuedGetStart, 12, continuedGetStart + "continuedGetValue".length), { diagnostics: [] });
    assert.equal(continuedGetActions.length, 1);
    assert.equal(continuedGetActions[0].title, "Declare implicit local as 'Integer'");
    assert.deepEqual(continuedGetActions[0].edit.insertion.position, new Position(11, 0),
        "the typed declaration must precede the continued GET statement, not split its continuation");
    assert.equal(continuedGetActions[0].edit.insertion.text, "    Dim continuedGetValue As Integer\n");
    assert.deepEqual(requests, [2, 10, 3, 4, 12]);

    const existingGetLine = source.split("\n")[6];
    const existingGetColumn = existingGetLine.indexOf("existingGetValue");
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(6, existingGetColumn, 6, existingGetColumn + "existingGetValue".length), { diagnostics: [] }), [],
    "a source-declared GET target must not receive a duplicate declaration");

    const explicitInputColumn = source.split("\n")[8].indexOf("explicitValue");
    const explicitInputActions = await provider.provideCodeActions(document,
        new Range(8, explicitInputColumn, 8, explicitInputColumn + "explicitValue".length), { diagnostics: [] });
    assert.deepEqual(explicitInputActions, [], "an already declared INPUT target must not receive the refactor");
    assert.deepEqual(requests, [2, 10, 3, 4, 12], "a source-resolved target must not start a compiler query");
});

test("stock-sidecar refactor declares an implicit REDIM array using its compiler type", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        "Sub RedimTypeRefactorProbe()",
        "    ReDim _",
        "        implicitArray(0 To 2)",
        "    Dim existingArray() As Long",
        "    ReDim existingArray(0 To 2)",
        "    ReDim explicitlyTypedArray(0 To 2) As Double",
        "    ReDim suffixTypedArray%(0 To 2)",
        "    ReDim Preserve existingArray(0 To 3)",
        "    ReDim Preserve _",
        "        implicitPreservedArray(0 To 2)",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/redim-type-refactor.bas",
        toString: () => "file:///workspace/redim-type-refactor.bas" };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            requests.push(position.line);
            return position.line === 2 || position.line === 9
                ? {
                    entries: [],
                    compilerStorageClass: "local",
                    compilerStorageTypeFacts: {
                        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                    }
                }
                : { entries: [], compilerStorageClass: null, compilerStorageTypeFacts: null };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const implicitLine = source.split("\n")[2];
    const implicitStart = implicitLine.indexOf("implicitArray");
    const actions = await provider.provideCodeActions(document,
        new Range(2, implicitStart, 2, implicitStart + "implicitArray".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Declare implicit array as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(1, 0));
    assert.equal(actions[0].edit.insertion.text, "    Dim implicitArray() As Integer\n");

    const existingLine = source.split("\n")[4];
    const existingStart = existingLine.indexOf("existingArray");
    const existingActions = await provider.provideCodeActions(document,
        new Range(4, existingStart, 4, existingStart + "existingArray".length), { diagnostics: [] });
    assert.deepEqual(existingActions, [], "resizing an already declared array must not create a declaration action");

    for (const lineNumber of [5, 6, 7]) {
        const lineText = source.split("\n")[lineNumber];
        const name = lineNumber === 5 ? "explicitlyTypedArray" :
            lineNumber === 6 ? "suffixTypedArray%" : "existingArray";
        const start = lineText.indexOf(name);
        const lineActions = await provider.provideCodeActions(document,
            new Range(lineNumber, start, lineNumber, start + name.length), { diagnostics: [] });
        assert.deepEqual(lineActions, [],
            "explicit, suffix-typed, and already-declared PRESERVE targets must not be changed");
    }

    const preserveLine = source.split("\n")[9];
    const preserveStart = preserveLine.indexOf("implicitPreservedArray");
    const preserveActions = await provider.provideCodeActions(document,
        new Range(9, preserveStart, 9, preserveStart + "implicitPreservedArray".length), { diagnostics: [] });
    assert.equal(preserveActions.length, 1);
    assert.equal(preserveActions[0].title, "Declare implicit array as 'Integer'");
    assert.deepEqual(preserveActions[0].edit.insertion.position, new Position(8, 0));
    assert.equal(preserveActions[0].edit.insertion.text, "    Dim implicitPreservedArray() As Integer\n");
    assert.deepEqual(requests, [2, 4, 7, 9],
        "the sidecar distinguishes an existing PRESERVE resize from a first PRESERVE declaration");
});

test("stock-sidecar and native refactors write module REDIM SHARED types at the declarator", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = "ReDim Shared _\n    implicitSharedArray( _\n        0 To 2)\nReDim Preserve implicitSharedArray(0 To 3)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/redim-shared-refactor.bas",
        toString: () => "file:///workspace/redim-shared-refactor.bas" };
    const name = "implicitSharedArray";
    const line = source.split("\n")[1];
    const startColumn = line.indexOf(name);
    const boundsLine = source.split("\n")[2];
    const closeParen = boundsLine.indexOf(")");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerStorageClass: "static",
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                },
                compilerStorageTypeDeclarationRange: {
                    line: 1,
                    startColumn,
                    endColumn: startColumn + name.length
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const actions = await provider.provideCodeActions(document,
        new Range(1, startColumn, 1, startColumn + name.length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make implicit array type explicit as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(2, closeParen + 1));
    assert.equal(actions[0].edit.insertion.text, " As Integer");

    const resizeLine = source.split("\n")[3];
    const resizeStart = resizeLine.indexOf(name);
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(3, resizeStart, 3, resizeStart + name.length), { diagnostics: [] }), [],
    "the existing array's PRESERVE resize must not be refactored as a new declaration");

    const nativeModel = {
        remote: true,
        semanticSidecarOnly: false,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            return position.line === 1 ? { entries: [{
                name,
                declaration: {
                    type: "variable",
                    name,
                    line: 1,
                    startColumn,
                    endColumn: startColumn + name.length,
                    typeName: "Integer",
                    provisional: false
                },
                compilerFacts: {
                    compilerStorageClass: "static",
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            }] } : { entries: [] };
        }
    };
    const nativeProvider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: async () => nativeModel
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });
    document.isDirty = true;
    const nativeActions = await nativeProvider.provideCodeActions(document,
        new Range(1, startColumn, 1, startColumn + name.length), { diagnostics: [] });
    assert.equal(nativeActions.length, 1);
    assert.equal(nativeActions[0].title, "Make implicit array type explicit as 'Integer'");
    assert.deepEqual(nativeActions[0].edit.insertion.position, new Position(2, closeParen + 1));
    assert.equal(nativeActions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar refactor makes an implicit FOR counter type explicit", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        "Sub LoopCounterRefactorProbe()",
        "    For _",
        "        implicitLoopCounter = 1 To 3",
        "    Next implicitLoopCounter",
        "    For explicitlyTypedCounter As Integer = 1 To 3",
        "    Next explicitlyTypedCounter",
        "    Dim existingCounter As Integer",
        "    For existingCounter = 1 To 3",
        "    Next existingCounter",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/loop-counter-refactor.bas",
        toString: () => "file:///workspace/loop-counter-refactor.bas" };
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        partial: false,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            requests.push(position.line);
            return {
                entries: [],
                compilerStorageClass: "local",
                compilerStorageTypeFacts: {
                    storageType: {
                        primitive: "integer",
                        storageBytes: 4,
                        pointerDepth: 0,
                        isReference: false
                    },
                    properties: []
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        Position,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({
            resolveAt: (_uri, line) => line === 7 ? [{ name: "existingCounter" }] : []
        })
    });

    const implicitLine = source.split("\n")[2];
    const implicitStart = implicitLine.indexOf("implicitLoopCounter");
    const actions = await provider.provideCodeActions(document,
        new Range(2, implicitStart, 2, implicitStart + "implicitLoopCounter".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make loop counter type explicit as 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position,
        new Position(2, implicitStart + "implicitLoopCounter".length));
    assert.equal(actions[0].edit.insertion.text, " As Integer");

    const typedLine = source.split("\n")[4];
    const typedStart = typedLine.indexOf("explicitlyTypedCounter");
    const typedActions = await provider.provideCodeActions(document,
        new Range(4, typedStart, 4, typedStart + "explicitlyTypedCounter".length), { diagnostics: [] });
    assert.deepEqual(typedActions, [], "a counter with an explicit type must not receive the refactor");

    const existingLine = source.split("\n")[7];
    const existingStart = existingLine.indexOf("existingCounter");
    const existingActions = await provider.provideCodeActions(document,
        new Range(7, existingStart, 7, existingStart + "existingCounter".length), { diagnostics: [] });
    assert.deepEqual(existingActions, [], "a previously declared loop counter must not receive the refactor");
    assert.deepEqual(requests, [2], "only the compiler-confirmed implicit counter should request sidecar facts");
});

test("stock-sidecar procedure refactor makes compiler-selected default visibility explicit", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = "Sub SidecarVisibilityProbe()\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-visibility-refactor.bas",
        toString: () => "file:///workspace/stock-visibility-refactor.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const startColumn = source.indexOf("SidecarVisibilityProbe");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line: 0, startColumn, endColumn: startColumn + "SidecarVisibilityProbe".length
                },
                compilerProcedureVisibilityFacts: {
                    compilerVisibility: "private",
                    procedureWrittenVisibility: [{ statement: 1, visibility: "default", provisional: false }],
                    procedureTypingInputs: [{
                        statement: 1, role: "definition", kind: "sub", resultForm: "none", provisional: false
                    }]
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        Position,
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "SidecarVisibilityProbe".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make procedure visibility explicit as 'Private'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(0, 0));
    assert.equal(actions[0].edit.insertion.text, "Private ");
});

test("stock-sidecar procedure refactor writes the compiler-selected foreign calling convention", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const declarationLine = "Declare Function SidecarCDefault(ByVal value As Integer) As Integer";
    const source = `Extern \"C\"\n${declarationLine}\nEnd Extern\n`;
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-cdecl-refactor.bas",
        toString: () => "file:///workspace/stock-cdecl-refactor.bas" };
    document.version = 1;
    const declarationLineNumber = 1;
    const startColumn = declarationLine.indexOf("SidecarCDefault");
    document.positionAt = (offset) => ({ line: declarationLineNumber,
        character: offset - source.indexOf(declarationLine) });
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line: declarationLineNumber, startColumn,
                    endColumn: startColumn + "SidecarCDefault".length
                },
                compilerProcedureFacts: {
                    procedureCallingConvention: "cdecl",
                    properties: [{ name: "procedure-linkage", value: "c", provisional: false }],
                    procedureAbiPolicyInputs: [{
                        statement: 1, writtenConvention: false, managedString: false, provisional: false
                    }]
                },
                compilerProcedureVisibilityFacts: {
                    compilerVisibility: "private",
                    procedureWrittenVisibility: [{ statement: 1, visibility: "private", provisional: false }],
                    procedureTypingInputs: [{
                        statement: 1, role: "prototype", kind: "function", resultForm: "as", provisional: false
                    }]
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        Position,
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(declarationLineNumber, startColumn, declarationLineNumber, startColumn + "SidecarCDefault".length),
        { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make calling convention explicit as 'Cdecl'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(
        declarationLineNumber, startColumn + "SidecarCDefault".length));
    assert.equal(actions[0].edit.insertion.text, " Cdecl");
});

test("stock-sidecar makes the default calling convention explicit in a continued declaration", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = "Extern \"C\"\nDeclare Function ContinuedCDefault( _\n    ByVal firstValue As Long, _\n    ByVal secondValue As Long) As Long\nEnd Extern\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/continued-cdecl-refactor.bas",
        toString: () => "file:///workspace/continued-cdecl-refactor.bas" };
    document.version = 1;
    const declarationLine = 1;
    const declarationText = source.split("\n")[declarationLine];
    const startColumn = declarationText.indexOf("ContinuedCDefault");
    document.positionAt = (offset) => ({ line: declarationLine,
        character: offset - source.indexOf(declarationText) });
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line: declarationLine, startColumn,
                    endColumn: startColumn + "ContinuedCDefault".length
                },
                compilerProcedureFacts: {
                    procedureCallingConvention: "cdecl",
                    properties: [{ name: "procedure-linkage", value: "c", provisional: false }],
                    procedureAbiPolicyInputs: [{
                        statement: 1, writtenConvention: false, managedString: false, provisional: false
                    }]
                },
                compilerProcedureVisibilityFacts: {
                    procedureTypingInputs: [{
                        statement: 1, role: "prototype", kind: "function", resultForm: "as", provisional: false
                    }]
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        Position,
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(declarationLine, startColumn, declarationLine, startColumn + "ContinuedCDefault".length),
        { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Make calling convention explicit as 'Cdecl'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(
        declarationLine, startColumn + "ContinuedCDefault".length));
    assert.equal(actions[0].edit.insertion.text, " Cdecl");

    model.partial = true;
    assert.deepEqual(await provider.provideCodeActions(document,
        new Range(declarationLine, startColumn, declarationLine, startColumn + "ContinuedCDefault".length),
        { diagnostics: [] }), [], "partial compiler results must not authorize edits to continued headers");
});

test("stock-sidecar procedure refactor writes FBC's implicit function return type", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = "Function SidecarImplicitReturnProbe()\n    Return 1\nEnd Function\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-return-type-refactor.bas",
        toString: () => "file:///workspace/stock-return-type-refactor.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const startColumn = source.indexOf("SidecarImplicitReturnProbe");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line: 0, startColumn, endColumn: startColumn + "SidecarImplicitReturnProbe".length
                },
                compilerProcedureFacts: {
                    procedureCallingConvention: "basic", procedureReturnsByReference: false,
                    properties: [], procedureAbiPolicyInputs: []
                },
                compilerProcedureVisibilityFacts: {
                    compilerVisibility: "private",
                    procedureWrittenVisibility: [{ statement: 1, visibility: "private", provisional: false }],
                    procedureTypingInputs: [{
                        statement: 1, role: "definition", kind: "function", resultForm: "implicit", provisional: false
                    }]
                },
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + "SidecarImplicitReturnProbe".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Add explicit return type 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, { line: 0, character: document.lineAt(0).text.length });
    assert.equal(actions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar inserts an implicit return type at the end of a continued function header", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = "Function ContinuedImplicitReturnProbe( _\n" +
        "    ByVal firstValue As Long, _\n" +
        "    ByVal secondValue As Long)\n" +
        "    Return firstValue + secondValue\n" +
        "End Function\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/continued-return-type-refactor.bas",
        toString: () => "file:///workspace/continued-return-type-refactor.bas" };
    document.version = 1;
    const lineOffsets = [0];
    for (const match of source.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
    document.positionAt = (offset) => {
        let line = lineOffsets.length - 1;
        while (line > 0 && lineOffsets[line] > offset) line--;
        return new Position(line, offset - lineOffsets[line]);
    };
    const declarationLine = 0;
    const startColumn = source.split("\n")[declarationLine].indexOf("ContinuedImplicitReturnProbe");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line: declarationLine, startColumn,
                    endColumn: startColumn + "ContinuedImplicitReturnProbe".length
                },
                compilerProcedureVisibilityFacts: {
                    procedureTypingInputs: [{
                        statement: 1, role: "definition", kind: "function", resultForm: "implicit", provisional: false
                    }]
                },
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        Position,
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(declarationLine, startColumn, declarationLine, startColumn + "ContinuedImplicitReturnProbe".length),
        { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Add explicit return type 'Integer'");
    assert.deepEqual(actions[0].edit.insertion.position, new Position(2,
        document.lineAt(2).text.indexOf(")") + 1));
    assert.equal(actions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar procedure refactor replaces an FBC-confirmed function return suffix", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const source = "Function SidecarSuffixReturnProbe%()\n    Return 1\nEnd Function\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-return-suffix-refactor.bas",
        toString: () => "file:///workspace/stock-return-suffix-refactor.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 0, character: offset });
    const name = "SidecarSuffixReturnProbe%";
    const startColumn = source.indexOf(name);
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line: 0, startColumn, endColumn: startColumn + name.length
                },
                compilerProcedureFacts: {
                    procedureCallingConvention: "basic", procedureReturnsByReference: false,
                    properties: [], procedureAbiPolicyInputs: []
                },
                compilerProcedureVisibilityFacts: {
                    compilerVisibility: "private",
                    procedureWrittenVisibility: [{ statement: 1, visibility: "private", provisional: false }],
                    procedureTypingInputs: [{
                        statement: 1, role: "definition", kind: "function", resultForm: "suffix", provisional: false
                    }]
                },
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + name.length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Replace return type suffix with 'As Integer'");
    assert.deepEqual(actions[0].edit.deletion.range,
        new Range(0, startColumn + name.length - 1, 0, startColumn + name.length));
    assert.deepEqual(actions[0].edit.insertion.position, {
        line: 0, character: document.lineAt(0).text.length
    });
    assert.equal(actions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar replaces a function return suffix in a continued header", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const source = "Function ContinuedSuffixProbe%( _\n" +
        "    ByVal firstValue As Long, _\n" +
        "    ByVal secondValue As Long)\n" +
        "    Return firstValue + secondValue\n" +
        "End Function\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/continued-return-suffix-refactor.bas",
        toString: () => "file:///workspace/continued-return-suffix-refactor.bas" };
    document.version = 1;
    const lineOffsets = [0];
    for (const match of source.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
    document.positionAt = (offset) => {
        let line = lineOffsets.length - 1;
        while (line > 0 && lineOffsets[line] > offset) line--;
        return { line, character: offset - lineOffsets[line] };
    };
    const name = "ContinuedSuffixProbe%";
    const startColumn = source.indexOf(name);
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line: 0, startColumn, endColumn: startColumn + name.length
                },
                compilerProcedureVisibilityFacts: {
                    procedureTypingInputs: [{
                        statement: 1, role: "definition", kind: "function", resultForm: "suffix", provisional: false
                    }]
                },
                compilerStorageTypeFacts: {
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(0, startColumn, 0, startColumn + name.length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Replace return type suffix with 'As Integer'");
    assert.deepEqual(actions[0].edit.deletion.range,
        new Range(0, startColumn + name.length - 1, 0, startColumn + name.length));
    assert.deepEqual(actions[0].edit.insertion.position, {
        line: 2, character: document.lineAt(2).text.indexOf(")") + 1
    });
    assert.equal(actions[0].edit.insertion.text, " As Integer");
});

test("stock-sidecar procedure refactor adds FBC-confirmed Override markers", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        "Type BaseSelector Extends Object",
        "    Declare Virtual Function Choose(ByVal value As Long) As Long",
        "End Type",
        "Type DerivedSelector Extends BaseSelector",
        "    Declare Function Choose(ByVal value As Long) As Long",
        "End Type",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-override-refactor.bas",
        toString: () => "file:///workspace/stock-override-refactor.bas" };
    document.version = 1;
    document.positionAt = (offset) => ({ line: 4, character: offset - source.indexOf("    Declare Function Choose") });
    const line = 4;
    const lineText = document.lineAt(line).text;
    const startColumn = lineText.indexOf("Choose");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line, startColumn, endColumn: startColumn + "Choose".length
                },
                compilerProcedureFacts: {
                    procedureCallingConvention: "basic",
                    procedureReturnsByReference: false,
                    overriddenProcedure: { qualifiedName: "BaseSelector.Choose" },
                    properties: [{ name: "written-override", value: "0" }],
                    procedureAbiPolicyInputs: []
                },
                compilerProcedureVisibilityFacts: {
                    compilerVisibility: "public",
                    procedureWrittenVisibility: [{ statement: 1, visibility: "public", provisional: false }],
                    procedureTypingInputs: [{
                        statement: 1, role: "prototype", kind: "function", resultForm: "as", provisional: false
                    }]
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + "Choose".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Add explicit 'Override' marker");
    assert.deepEqual(actions[0].edit.insertion.position, {
        line, character: lineText.trimEnd().length
    });
    assert.equal(actions[0].edit.insertion.text, " Override");
});

test("stock-sidecar adds a compiler-confirmed Override after a continued method header", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const source = [
        "Type BaseSelector Extends Object",
        "    Declare Virtual Function Choose(ByVal value As Long) As Long",
        "End Type",
        "Type DerivedSelector Extends BaseSelector",
        "    Declare Function Choose( _",
        "        ByVal value As Long) As Long",
        "End Type",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/continued-override-refactor.bas",
        toString: () => "file:///workspace/continued-override-refactor.bas" };
    document.version = 1;
    document.positionAt = (offset) => {
        const prefix = source.slice(0, offset).split("\n");
        return { line: prefix.length - 1, character: prefix.at(-1).length };
    };
    const line = 4;
    const lineText = document.lineAt(line).text;
    const startColumn = lineText.indexOf("Choose");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [],
                compilerProcedureDeclarationRange: {
                    line, startColumn, endColumn: startColumn + "Choose".length
                },
                compilerProcedureFacts: {
                    overriddenProcedure: { qualifiedName: "BaseSelector.Choose" },
                    properties: [{ name: "written-override", value: "0", provisional: false }]
                }
            };
        }
    };
    const provider = createMissingHeaderCodeActionProvider({
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix", RefactorRewrite: "refactor.rewrite" },
        WorkspaceEdit
    }, {
        compilerAnalysis: { getModelForEditor: async () => model },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const actions = await provider.provideCodeActions(document,
        new Range(line, startColumn, line, startColumn + "Choose".length), { diagnostics: [] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Add explicit 'Override' marker");
    assert.deepEqual(actions[0].edit.insertion.position, {
        line: 5, character: document.lineAt(5).text.trimEnd().length
    });
    assert.equal(actions[0].edit.insertion.text, " Override");
});

test("full-model parameter hover shows compiler-selected passing mode", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = [
        "Sub ConsumeDefault(defaultValue As Integer)",
        "End Sub",
        "Sub ConsumeAnyRank(values() As Integer)",
        "End Sub",
        "Sub ConsumeMatrix(values(Any, Any) As Integer)",
        "End Sub",
        "Sub ConsumeImplicit(ByVal implicitValue)",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/parameter-mode.bas", toString: () => "file:///workspace/parameter-mode.bas" };
    const entries = [
        { line: 0, name: "defaultValue", mode: "byref", dimensions: -1,
            documentation: "The value passed to this operation." },
        { line: 2, name: "values", mode: "bydesc", dimensions: -1 },
        { line: 4, name: "values", mode: "bydesc", dimensions: 2 },
        { line: 6, name: "implicitValue", mode: "byval", dimensions: 0, writtenType: "implicit" }
    ].map(({ line, name, mode, dimensions, writtenType, documentation }) => {
        const parameterColumn = source.split("\n")[line].indexOf(name);
        return {
            id: line + 1,
            name,
            uri: { scheme: "file", fsPath: "/workspace/parameter-mode.bas" },
            declaration: {
                name,
                type: "parameter",
                typeName: "Integer",
                signature: name === "defaultValue" ? "ByRef defaultValue As Integer" :
                    name === "implicitValue" ? "ByVal implicitValue" :
                        `values(${dimensions < 0 ? "" : "Any, Any"}) As Integer`,
                line,
                startColumn: parameterColumn,
                endColumn: parameterColumn + name.length,
                documentation,
                parameters: [],
                modifiers: [],
                compilerFacts: {
                    parameterPassing: { mode, dimensions, optional: false, receiver: false },
                    formalWrittenTypes: writtenType ? [writtenType] : []
                }
            }
        };
    });
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            return {
                entries: [entries.find((entry) => entry.declaration.line === position.line)],
                occurrence: { name: entries.find((entry) => entry.declaration.line === position.line)?.name },
                expression: null,
                expressionAlternatives: [],
                expressionConstantValues: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const hover = await provider.provideHover(document, { line: 0, character: source.split("\n")[0].indexOf("defaultValue") + 2 });
    assert.match(hover.contents.value, /Compiler-selected parameter passing: ByRef\./);
    assert.match(hover.contents.value, /The value passed to this operation\./);
    assert.doesNotMatch(hover.contents.value, /Compiler-selected implicit parameter type/);

    const anyRankHover = await provider.provideHover(document, {
        line: 2,
        character: source.split("\n")[2].indexOf("values") + 2
    });
    assert.match(anyRankHover.contents.value, /Compiler-selected parameter passing: ByDesc \(any array rank\)\./);

    const matrixHover = await provider.provideHover(document, {
        line: 4,
        character: source.split("\n")[4].indexOf("values") + 2
    });
    assert.match(matrixHover.contents.value, /Compiler-selected parameter passing: ByDesc \(rank 2 array\)\./);

    const implicitTypeHover = await provider.provideHover(document, {
        line: 6,
        character: source.split("\n")[6].indexOf("implicitValue") + 2
    });
    assert.match(implicitTypeHover.contents.value,
        /Compiler-selected implicit parameter type: `Integer`\./);
});

test("full-model hover shows compiler storage when no source signature is available", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = [
        "Sub StorageProbe()",
        "    implicitLocal = 1",
        "    Dim explicitLocal As Integer",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/storage.bas", toString: () => "file:///workspace/storage.bas" };
    const makeEntry = (name, line, signature) => {
        const startColumn = source.split("\n")[line].indexOf(name);
        return {
            id: line,
            name,
            uri: { scheme: "file", fsPath: "/workspace/storage.bas" },
            declaration: {
                name, type: "variable", typeName: "Integer", signature,
                line, startColumn, endColumn: startColumn + name.length,
                parameters: [], modifiers: [], compilerFacts: { compilerStorageClass: "local" }
            }
        };
    };
    const entries = [
        makeEntry("implicitLocal", 1, "variable implicitLocal As Integer"),
        makeEntry("explicitLocal", 2, "Dim explicitLocal As Integer")
    ];
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "hover");
            const entry = entries.find((candidate) => candidate.declaration.line === position.line);
            return {
                entries: entry ? [entry] : [],
                occurrence: entry ? { name: entry.name } : null,
                expression: null,
                expressionAlternatives: [],
                expressionConstantValues: []
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model }
    }, {});

    const implicitHover = await provider.provideHover(document, { line: 1, character: 8 });
    assert.match(implicitHover.contents.value,
        /Compiler-selected storage class: `local`\./);
    const explicitHover = await provider.provideHover(document, { line: 2, character: 8 });
    assert.doesNotMatch(explicitHover.contents.value, /Compiler-selected storage class/);
});

test("stock FBC sidecar supplies constant values only for resolved constant symbols", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const source = "Const SidecarConstant As ULongInt = 42\nPrint SidecarConstant\n";
    const document = createDocument(source);
    const filePath = "/workspace/sidecar-constants.bas";
    document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    const declaration = {
        name: "SidecarConstant", uri: document.uri,
        declaration: {
            name: "SidecarConstant", type: "const", signature: "Const SidecarConstant As ULongInt",
            line: 0, startColumn: 6, endColumn: 20, parameters: [], modifiers: []
        }
    };
    const sourceModel = {
        remote: false,
        tokenAt: () => ({ token: { name: "SidecarConstant" } }),
        resolveAt: () => [declaration],
        expressionAt: () => null,
        compilerSidecarExpressionAlternativesAt: () => [],
        compilerConditionalDecisionAt: () => null,
        compilerDefinedNameProbeAt: () => null,
        compilerDeferredMacroReferenceAt: () => null
    };
    let sidecarConstant = { kind: "unsigned", value: "42" };
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            if (operation === "hover") return { entries: [], occurrence: null, expression: null, expressionAlternatives: [] };
            assert.equal(operation, "compilerSidecarConstantAt");
            return sidecarConstant;
        }
    };
    const analysisRequests = [];
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => null,
            async getModelForEditor(_document, _token, needTypes, needBindings) {
                analysisRequests.push([needTypes, needBindings]);
                return needBindings ? sidecarModel : sourceModel;
            }
        }
    };
    const grammarData = Object.fromEntries([
        "preprocessorDirectives", "operatorKeywords", "keywords", "types", "libraryTypes", "typeModifiers",
        "intrinsicFunctions", "runtimeFunctions", "graphicsFunctions", "bundledFunctions", "constants",
        "compilerDefines", "symbolicConstants"
    ].map((key) => [key, []]));
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, index, grammarData);

    const reference = await provider.provideHover(document, { line: 1, character: 9 });
    assert.match(reference.contents.value, /Compiler constant value in this context: `42`/);
    assert.deepEqual(analysisRequests, [[false, false], [true, true]],
        "only a resolved constant hover should request the binding-capable sidecar");

    sidecarConstant = { kind: "float64-bits", value: "0x3FF8000000000000" };
    const floating = await provider.provideHover(document, { line: 1, character: 9 });
    assert.match(floating.contents.value, /Compiler constant value in this context: `1\.5 \(IEEE-754 bits 0x3FF8000000000000\)`/,
        "the compiler-proven decimal should retain the exact IEEE-754 bit pattern");

    sidecarConstant = { kind: "bytes", value: "48656C6C6F" };
    const string = await provider.provideHover(document, { line: 1, character: 9 });
    assert.match(string.contents.value,
        /Compiler constant value in this context: `bytes 0x48656C6C6F \(ASCII preview: "Hello"\)`/);

    analysisRequests.length = 0;
    sourceModel.resolveAt = () => [];
    await provider.provideHover(document, { line: 1, character: 9 });
    assert.deepEqual(analysisRequests, [[false, false], [true, false]],
        "unresolved names must not pay for full sidecar bindings");
});

test("hover explains compiler-confirmed FOR entry decisions", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const document = createDocument("For loopIndex = 3 To 1\nNext\n");
    document.uri = { scheme: "file", fsPath: "/workspace/loop-entry.bas", toString: () => "file:///workspace/loop-entry.bas" };
    let forEntryResult = "skip";
    const model = {
        remote: true,
        async expressionAt() { return null; },
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [], occurrence: null, expression: null, expressionAlternatives: [],
                expressionConstantValues: [], forEntryResult
            };
        }
    };
    const index = {
        compilerAnalysis: { getModelForEditor: async () => model, getModel: () => model },
        getSourceSemanticModel: () => ({ entries: [], resolveAt: () => [] })
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, index, {});
    const hover = await provider.provideHover(document, { line: 0, character: 1 });

    assert.match(hover.contents.value,
        /Compiler FOR entry: the initial test fails, so the body is skipped\./);
    forEntryResult = "enter";
    const entered = await provider.provideHover(document, { line: 0, character: 1 });
    assert.match(entered.contents.value,
        /Compiler FOR entry: the initial test passes, so the body is entered\./);
});

test("hover explains compiler types that conflict across repeated include contexts", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const alternatives = ["integer", "string"].map((typeName, index) => ({
        typeName,
        contexts: [{ includePath: [
            { kind: "module", filePath: "/workspace/main.bas", requested: "/workspace/main.bas" },
            {
                kind: "include",
                filePath: "/workspace/shared.bi",
                requested: "shared.bi",
                directive: { filePath: "/workspace/main.bas", startLine: index === 0 ? 12 : 26 }
            }
        ] }]
    }));
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return { expression: null, expressionAlternatives: alternatives, occurrence: null, entries: [] };
        }
    };
    const index = { compilerAnalysis: { getModel: () => model } };
    const vscode = { ...createVscodeMock(), MarkdownString, Hover };
    const hoverProvider = createHoverProvider(vscode, index, {});
    const document = createDocument(`${"\n".repeat(3)}        value\n`);
    document.uri = { scheme: "file", fsPath: "/workspace/shared.bi" };
    const hover = await hoverProvider.provideHover(document, { line: 3, character: 8 });

    assert.ok(hover);
    assert.match(hover.contents.value, /depends on the include instance/);
    assert.match(hover.contents.value, /`integer`/);
    assert.match(hover.contents.value, /`string`/);
    assert.match(hover.contents.value, /main\.bas:12/);
    assert.match(hover.contents.value, /main\.bas:26/);
});

test("hover explains an unresolved deferred macro reference without inventing a target", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const text = "#define UNUSED(dummy) DEFERRED_NAME\nPrint 1\n";
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/macros.bas", toString: () => "file:///workspace/macros.bas" };
    const grammarData = loadGrammarSourceFile(path.join(__dirname, "..", "syntaxes", "source", "freebasic.grammar-source.json"));
    const requests = [];
    let outcome = "unexpanded";
    const model = {
        remote: true,
        async query(operation) {
            requests.push(operation);
            return {
                expression: null,
                expressionAlternatives: [],
                preprocessorDecision: null,
                definedNameProbe: null,
                deferredMacroReference: { name: "DEFERRED_NAME", outcome },
                occurrence: { name: "DEFERRED_NAME" },
                entries: []
            };
        }
    };
    const hoverProvider = createHoverProvider({
        ...createVscodeMock(), MarkdownString, Hover
    }, {
        compilerAnalysis: {
            getModelForEditor: async () => model,
            getModel: () => model
        }
    }, grammarData);

    const hover = await hoverProvider.provideHover(document, {
        line: 0,
        character: text.split("\n")[0].indexOf("DEFERRED_NAME") + 1
    });
    assert.deepEqual(requests, ["hover"]);
    assert.match(hover.contents.value, /Deferred macro reference: `DEFERRED_NAME`/);
    assert.match(hover.contents.value, /has not been expanded in the current compiler snapshot/);

    outcome = "ambiguous";
    const ambiguousHover = await hoverProvider.provideHover(document, {
        line: 0,
        character: text.split("\n")[0].indexOf("DEFERRED_NAME") + 1
    });
    assert.deepEqual(requests, ["hover", "hover"]);
    assert.match(ambiguousHover.contents.value, /Observed expansions select different macro definitions/);
});

test("stock-sidecar hover uses the compiler-selected variable from conditional declarations", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value) { this.value += `\n${value}\n`; }
    }
    class Hover { constructor(contents) { this.contents = contents; } }
    const text = "#if 1\nDim selectedValue As Long\n#else\nDim selectedValue As Double\n#endif\nPrint selectedValue\n";
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/conditional-hover.bas",
        toString: () => "file:///workspace/conditional-hover.bas" };
    const parsed = parseFreeBasicText(text);
    const model = new FreeBasicSemanticModel([{ uri: document.uri, parsed }]);
    const declaration = parsed.declarations.find((entry) => entry.name === "selectedValue");
    const requests = [];
    const native = {
        remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [{ uri: document.uri, name: "selectedValue", compilerSymbolId: 17, declaration }],
                expression: { typeName: "Long" }
            };
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: (_document, _token, needTypes, needBindings) => {
                requests.push([needTypes, needBindings]);
                return needTypes ? native : model;
            },
            getModel: () => model
        },
        getSemanticModel: () => model,
        getParsedDocument: () => parsed,
        ensureInitialized: async () => true
    };
    const hover = await createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, index, {})
        .provideHover(document, { line: 5, character: 8 });
    assert.match(hover.contents.value, /Dim selectedValue As Long/i);
    assert.doesNotMatch(hover.contents.value, /Dim selectedValue As Double/i,
        "the inactive declaration must not be shown as an alternative to the compiler-selected variable");
    assert.deepEqual(requests, [[false, false], [true, true]],
        "ambiguous source declarations should explicitly request FBC bindings, not depend on another provider's cache");
});

test("resolved remote symbol hovers do not build the source operator index", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value) { this.value += `\n\`\`\`freebasic\n${value}\n\`\`\``; }
    }
    class Hover {
        constructor(contents) { this.contents = contents; }
    }
    const document = createDocument("Print value\n");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return {
                entries: [{
                    uri: document.uri,
                    declaration: { line: 0, signature: "Dim value As Long" }
                }],
                occurrence: { name: "value" }
            };
        }
    };
    const index = {
        compilerAnalysis: { getModel: () => model },
        getSourceSemanticModel() { throw new Error("ordinary symbol hovers should not load the operator index"); },
        getSemanticModel() { throw new Error("ordinary symbol hovers should not load a source model"); }
    };
    const hoverProvider = createHoverProvider(
        { ...createVscodeMock(), MarkdownString, Hover }, index, {}
    );
    const hover = await hoverProvider.provideHover(document, { line: 0, character: 7 });

    assert.ok(hover);
    assert.match(hover.contents.value, /Dim value As Long/);
});

test("hover skips comments and edge whitespace without treating string apostrophes as comments", async () => {
    const requests = [];
    const model = {
        remote: true,
        async query(operation) {
            requests.push(operation);
            return null;
        }
    };
    const index = {
        compilerAnalysis: {
            getModelForEditor() {
                requests.push("analysis");
                return model;
            },
            getModel: () => model
        }
    };
    const provider = createHoverProvider(createVscodeMock(), index, {});
    const comment = createDocument("Print 1 ' hidden value\n");
    const commentPosition = { line: 0, character: comment.getText().indexOf("hidden") + 2 };

    assert.equal(await provider.provideHover(comment, commentPosition), null);
    assert.deepEqual(requests, [], "a line-comment hover should not request the compiler model");

    const whitespace = createDocument("    Print 1   \n");
    assert.equal(await provider.provideHover(whitespace, { line: 0, character: 0 }), null);
    assert.equal(await provider.provideHover(whitespace, { line: 0, character: 12 }), null);
    assert.deepEqual(requests, [], "indentation and trailing-space hovers should not request the compiler model");

    const string = createDocument('Dim text As String = "a\'b"\n');
    const stringPosition = { line: 0, character: string.getText().indexOf("'") };
    assert.equal(await provider.provideHover(string, stringPosition), null);
    assert.deepEqual(requests, ["analysis", "hover"],
        "an apostrophe inside a string must keep the normal hover path");
});

test("ordinary remote navigation, references, and highlights do not build the source operator index", async () => {
    class Location {
        constructor(uri, range) { this.uri = uri; this.range = range; }
    }
    class DocumentHighlight {
        constructor(range, kind) { this.range = range; this.kind = kind; }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const document = createDocument("Print value\n");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const requests = [];
    let accessRole = "write";
    const model = {
        remote: true,
        async query(operation) {
            requests.push(operation);
            if (["definition", "declaration"].includes(operation)) return [{
                uri: document.uri,
                name: "value",
                declaration: { line: 0, endColumn: 11, type: "variable", modifiers: [] }
            }];
            return [{ uri: document.uri, occurrence: { line: 0, startColumn: 6, endColumn: 11 },
                ...(operation === "highlights" ? { accessRole } : {}) }];
        }
    };
    const index = {
        compilerAnalysis: {
            getModelForEditor: () => model,
            getModel: () => model
        },
        getSourceSemanticModel() { throw new Error("ordinary symbols should not load the operator index"); },
        getSemanticModel() { throw new Error("ordinary symbols should not load a source model"); }
    };
    const vscode = {
        ...createVscodeMock(),
        DocumentHighlight,
        DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
        Location,
        Range,
        SemanticTokensLegend
    };
    const features = createSemanticFeatures(vscode, index, {
        keywords: [], types: [], operatorKeywords: [], constants: []
    });
    const position = { line: 0, character: 8 };
    const definitions = await features.definition.provideDefinition(document, position);
    const declarations = await features.declaration.provideDeclaration(document, position);
    const implementations = await features.implementation.provideImplementation(document, position);
    const references = await features.reference.provideReferences(document, position,
        { includeDeclaration: true });
    const highlights = await features.documentHighlight.provideDocumentHighlights(document, position);

    assert.equal(definitions.length, 1);
    assert.equal(declarations.length, 1);
    assert.equal(implementations.length, 0);
    assert.equal(references.length, 1);
    assert.equal(highlights.length, 1);
    assert.equal(highlights[0].kind, vscode.DocumentHighlightKind.Write);
    accessRole = "read";
    const readHighlights = await features.documentHighlight.provideDocumentHighlights(document, position);
    assert.equal(readHighlights[0].kind, vscode.DocumentHighlightKind.Read);
    assert.deepEqual(requests, ["definition", "declaration", "definition", "references", "highlights", "highlights"]);
});

test("resolved argument symbols do not request full compiler bindings for navigation", async () => {
    class Location {
        constructor(uri, range) { this.uri = uri; this.range = range; }
    }
    class DocumentHighlight {
        constructor(range, kind) { this.range = range; this.kind = kind; }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const document = createDocument("CallTarget(value)\n");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const target = {
        uri: document.uri,
        name: "value",
        declaration: { line: 0, endColumn: 16, type: "variable", modifiers: [] }
    };
    const requests = [];
    const bindingRequests = [];
    const model = {
        remote: true,
        async query(operation) {
            requests.push(operation);
            if (["references", "highlights"].includes(operation)) return [{
                uri: document.uri,
                occurrence: { line: 0, startColumn: 11, endColumn: 16 }
            }];
            return [target];
        }
    };
    const index = {
        compilerAnalysis: {
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                bindingRequests.push({ needExpressionTypes, needSemanticBindings });
                return model;
            },
            getModel: () => model
        },
        getSourceSemanticModel: () => ({ resolveAt: () => [target] })
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        DocumentHighlight,
        DocumentHighlightKind: { Text: 0 },
        Location,
        Range,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const position = { line: 0, character: 13 };

    const definition = await features.definition.provideDefinition(document, position);
    const declaration = await features.declaration.provideDeclaration(document, position);
    const implementation = await features.implementation.provideImplementation(document, position);
    const references = await features.reference.provideReferences(document, position,
        { includeDeclaration: true });
    const highlights = await features.documentHighlight.provideDocumentHighlights(document, position);

    assert.equal(definition.length, 1);
    assert.equal(declaration.length, 1);
    assert.equal(implementation.length, 0);
    assert.equal(references.length, 1);
    assert.equal(highlights.length, 1);
    assert.deepEqual(bindingRequests, [
        { needExpressionTypes: false, needSemanticBindings: false },
        { needExpressionTypes: false, needSemanticBindings: false },
        { needExpressionTypes: false, needSemanticBindings: false },
        { needExpressionTypes: false, needSemanticBindings: false },
        { needExpressionTypes: false, needSemanticBindings: false }
    ]);
    assert.deepEqual(requests, ["definition", "declaration", "definition", "references", "highlights"]);
});

test("stock FBC navigation requests compiler semantic bindings on demand", async () => {
    class Location {
        constructor(uri, range) { this.uri = uri; this.range = range; }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const document = createDocument("Print value\n");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const target = {
        uri: document.uri,
        name: "value",
        declaration: { line: 0, startColumn: 6, endColumn: 11, type: "variable", modifiers: [] }
    };
    const bindingRequests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            if (["definition", "declaration", "implementation"].includes(operation)) return [target];
            if (operation === "references") return [{
                uri: document.uri,
                occurrence: { line: 0, startColumn: 6, endColumn: 11 }
            }];
            return [];
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings, needSemanticMacroBindings) {
                bindingRequests.push({ needExpressionTypes, needSemanticBindings, needSemanticMacroBindings });
                return model;
            },
            getModel: () => model
        }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        Location,
        Range,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });

    const definitions = await features.definition.provideDefinition(document, { line: 0, character: 8 });
    const references = await features.reference.provideReferences(document, { line: 0, character: 8 },
        { includeDeclaration: true });
    const declarations = await features.declaration.provideDeclaration(document, { line: 0, character: 8 });
    const implementations = await features.implementation.provideImplementation(document, { line: 0, character: 8 });

    assert.equal(definitions.length, 1);
    assert.equal(references.length, 1);
    assert.equal(declarations.length, 1);
    assert.equal(implementations.length, 1);
    assert.deepEqual(bindingRequests, [
        { needExpressionTypes: false, needSemanticBindings: true, needSemanticMacroBindings: false },
        { needExpressionTypes: false, needSemanticBindings: true, needSemanticMacroBindings: false },
        { needExpressionTypes: false, needSemanticBindings: true, needSemanticMacroBindings: false },
        { needExpressionTypes: false, needSemanticBindings: true, needSemanticMacroBindings: false }
    ]);
    assert.deepEqual(queries, ["definition", "references", "declaration", "implementation"]);
});

test("numeric-label document highlights request stock FBC semantic bindings on demand", async () => {
    class DocumentHighlight {
        constructor(range, kind) { Object.assign(this, { range, kind }); }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const text = "10 Print 1\nGoto 10\n";
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/numeric-labels.bas", toString: () => "file:///workspace/numeric-labels.bas" };
    const bindingRequests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            return operation === "highlights" ? [
                { uri: document.uri, occurrence: { line: 0, startColumn: 0, endColumn: 2 }, accessRole: "read" },
                { uri: document.uri, occurrence: { line: 1, startColumn: 5, endColumn: 7 }, accessRole: "read" }
            ] : [];
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                bindingRequests.push({ needExpressionTypes, needSemanticBindings });
                return model;
            },
            getModel: () => null
        },
        getParsedDocument() {},
        async ensureInitialized() { return true; },
        getSemanticModel: () => null
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        DocumentHighlight,
        DocumentHighlightKind: { Text: 0 },
        Range,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });

    const declaration = await features.documentHighlight.provideDocumentHighlights(document, { line: 0, character: 0 });
    const reference = await features.documentHighlight.provideDocumentHighlights(document, { line: 1, character: 5 });
    const ordinaryNumber = await features.documentHighlight.provideDocumentHighlights(document, { line: 0, character: 9 });

    assert.equal(ordinaryNumber, null, "ordinary numeric expressions should not request stock-sidecar bindings");
    assert.deepEqual(declaration.map((entry) => [entry.range.start.line, entry.range.start.character,
        entry.range.end.character]), [[0, 0, 2], [1, 5, 7]]);
    assert.deepEqual(reference.map((entry) => [entry.range.start.line, entry.range.start.character,
        entry.range.end.character]), [[0, 0, 2], [1, 5, 7]]);
    assert.deepEqual(bindingRequests, [
        { needExpressionTypes: false, needSemanticBindings: true },
        { needExpressionTypes: false, needSemanticBindings: true },
        { needExpressionTypes: false, needSemanticBindings: false }
    ]);
    assert.deepEqual(queries, ["highlights", "highlights"]);
});

test("stock-sidecar highlights request bindings for REM identifiers masked inside conditional options", async () => {
    class DocumentHighlight {
        constructor(range, kind) { Object.assign(this, { range, kind }); }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    class SemanticTokens {
        constructor(data) { this.data = data; }
    }
    class SemanticTokensBuilder {
        build() { return new SemanticTokens(new Uint32Array()); }
    }
    const text = [
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemHighlightProbe()",
        "    Dim REM As Integer",
        "    REM = 1",
        "    Print REM",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/rem-highlights.bas",
        toString: () => "file:///workspace/rem-highlights.bas" };
    const bindingRequests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            queries.push(operation);
            if (operation === "highlights") {
                assert.deepEqual(input.position, { line: 6, character: text.split("\n")[6].indexOf("REM") + 1 });
                return [
                    { uri: document.uri, occurrence: { line: 4, startColumn: 8, endColumn: 11 } },
                    { uri: document.uri, occurrence: { line: 5, startColumn: 4, endColumn: 7 }, accessRole: "write" },
                    { uri: document.uri, occurrence: { line: 6, startColumn: 10, endColumn: 13 }, accessRole: "read" }
                ];
            }
            assert.equal(operation, "semanticTokens");
            return new Uint32Array([0, 10, 3, 6, 0]);
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                bindingRequests.push({ needExpressionTypes, needSemanticBindings });
                return model;
            },
            getModel: () => null
        }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        DocumentHighlight,
        DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
        Range,
        SemanticTokensLegend,
        SemanticTokens,
        SemanticTokensBuilder
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const position = { line: 6, character: text.split("\n")[6].indexOf("REM") + 1 };
    const highlights = await features.documentHighlight.provideDocumentHighlights(document, position);
    const semanticTokens = await features.semanticTokens.provideDocumentSemanticTokens(document);

    assert.deepEqual(highlights.map((highlight) => [highlight.range.start.line,
        highlight.range.start.character, highlight.kind]), [[4, 8, 0], [5, 4, 2], [6, 10, 1]]);
    assert.ok(semanticTokens.data instanceof Uint32Array);
    assert.deepEqual(bindingRequests, [
        { needExpressionTypes: false, needSemanticBindings: true },
        { needExpressionTypes: false, needSemanticBindings: true }
    ]);
    assert.deepEqual(queries, ["highlights", "semanticTokens"]);
});

test("source semantic tokens do not publish an incomplete workspace model", async () => {
    class SemanticTokensLegend {}
    class SemanticTokensBuilder {
        build() { return []; }
    }
    const document = createDocument("Function Helpers.Calculate() As Long\nEnd Function\n");
    let parsed = false;
    const index = {
        getParsedDocument() { parsed = true; },
        async ensureInitialized() { return false; },
        getSemanticModel() { assert.fail("cancelled initialization must not publish partially resolved tokens"); }
    };
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, SemanticTokensBuilder },
        index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    assert.deepEqual(await features.semanticTokens.provideDocumentSemanticTokens(document), []);
    assert.equal(parsed, true);
});

test("stock-sidecar semantic tokens request bindings for NOKEYWORD identifiers", async () => {
    class SemanticTokensLegend {
        constructor() {}
    }
    class SemanticTokens {
        constructor(data) { this.data = data; }
    }
    class SemanticTokensBuilder {
        build() { return new SemanticTokens(new Uint32Array()); }
    }
    const source = [
        '#lang "deprecated"',
        "Option NoKeyword Print",
        "Sub PrintIdentifierProbe()",
        "    Dim Print As Integer",
        "    Print = Print + 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/nokeyword-print-tokens.bas",
        toString: () => "file:///workspace/nokeyword-print-tokens.bas" };
    const requests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            assert.equal(operation, "semanticTokens");
            return new Uint32Array([0, 8, 5, 6, 2]);
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push({ needExpressionTypes, needSemanticBindings });
                return model;
            },
            getModel: () => null
        }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(), SemanticTokensLegend, SemanticTokens, SemanticTokensBuilder
    }, index, { keywords: ["print"], types: [], operatorKeywords: [], constants: [] });

    const result = await features.semanticTokens.provideDocumentSemanticTokens(document);
    assert.ok(result.data instanceof Uint32Array);
    assert.deepEqual(requests, [{ needExpressionTypes: false, needSemanticBindings: true }]);
    assert.deepEqual(queries, ["semanticTokens"]);
});

test("argument navigation follows replacement snapshots without querying a failed upgrade's predecessor", async () => {
    class SemanticTokensLegend {}
    class Location {
        constructor(uri, range) { Object.assign(this, { uri, range }); }
    }
    const document = createDocument("Print TwiceValue(createdValue + 1)\n");
    document.uri = { scheme: "file", fsPath: "/workspace/generated-variable.bas",
        toString: () => "file:///workspace/generated-variable.bas" };
    const target = { name: "createdValue", uri: document.uri, declaration: {
        name: "createdValue", type: "variable", line: 0, startColumn: 17, endColumn: 29, modifiers: []
    } };
    const sourceModel = { resolveAt: () => [] };
    let released = false, bindingRequests = 0, mode = "selected";
    let queries = [];
    const weak = { remote: true, semanticBindingsAvailable: false, async query() {
        assert.equal(released, false, "navigation must not query the released snapshot after a binding upgrade");
        return [];
    } };
    const strong = { remote: true, semanticBindingsAvailable: true, async query(operation) {
        queries.push(operation);
        return [target];
    } };
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, Location }, {
        compilerAnalysis: {
            getModelForEditor(_document, _token, _types, bindings) {
                if (bindings) {
                    released = true;
                    bindingRequests++;
                    if (mode === "unavailable" || mode === "superseded" && bindingRequests === 1) return null;
                    if (mode === "edited") document.version++;
                    return strong;
                }
                return weak;
            },
            getModel: () => weak
        },
        getSourceSemanticModel: () => sourceModel
    }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    for (const outcome of ["selected", "superseded", "unavailable", "edited"]) {
        mode = outcome;
        for (const [provider, operation] of [[features.definition, "provideDefinition"],
            [features.declaration, "provideDeclaration"], [features.implementation, "provideImplementation"]]) {
            released = false;
            bindingRequests = 0;
            document.version = 1;
            queries = [];
            const result = await provider[operation](document, { line: 0, character: 20 });
            if (mode === "unavailable" || mode === "edited") {
                assert.equal(result, null, `${operation}: ${mode}`);
                assert.deepEqual(queries, [], "an interrupted upgrade must not issue a binding query");
            } else {
                assert.equal(result.length, operation === "provideImplementation" ? 0 : 1);
                assert.ok(released && queries.length > 0);
            }
            assert.equal(bindingRequests, ["superseded", "unavailable"].includes(mode) ? 2 : 1,
                `${operation}: ${mode} must have bounded compiler requests`);
        }
    }
});

test("operator navigation keeps the replacement model when its source index cannot map the selected header", async () => {
    class SemanticTokensLegend {}
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    class DocumentHighlight { constructor(range, kind) { Object.assign(this, { range, kind }); } }
    const text = ["Type Operand", "    value As Long", "End Type",
        "Declare Operator +(ByRef left As Operand, ByRef right As Operand) As Operand",
        "Dim leftValue As Operand, rightValue As Operand", "Dim combined As Operand = leftValue + rightValue", ""].join("\n");
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/operator-fallback.bas",
        toString: () => "file:///workspace/operator-fallback.bas" };
    const source = new FreeBasicSemanticModel([{ uri: document.uri, parsed: parseFreeBasicText(text) }]);
    const header = { scheme: "file", fsPath: "/workspace/unindexed-operator.bi",
        toString: () => "file:///workspace/unindexed-operator.bi" };
    const target = { uri: header, name: "Operator +", declaration: { name: "Operator +", type: "operator",
        line: 0, startColumn: 0, endColumn: 10, modifiers: [] } };
    const position = { line: 5, character: text.split("\n")[5].indexOf("+") };
    const occurrence = { uri: document.uri, occurrence: { line: 5,
        startColumn: position.character, endColumn: position.character + 1 } };
    for (const operation of ["definition", "declaration", "implementation", "references", "highlights"]) {
        let current, released = false, staleQueries = 0, bindingRequests = 0;
        const weak = { remote: true, semanticBindingsAvailable: false,
            expressionAt: async () => ({ operatorKind: "overloaded", operatorCode: "add" }),
            async query() { if (released) staleQueries++; return null; } };
        const strong = { remote: true, semanticBindingsAvailable: true,
            async query(query) {
                if (query === "compilerSidecarOperatorOperationAt") return { complete: true, operations: [{
                    targetSymbols: [42], procedures: [{ filePath: header.fsPath, startLine: 1, endLine: 3 }]
                }] };
                assert.equal(query, operation === "implementation" ? "definition" : operation);
                return [operation === "references" || operation === "highlights" ? occurrence : target];
            } };
        current = weak;
        const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, Location, DocumentHighlight }, {
            getSourceSemanticModel: () => source,
            compilerAnalysis: { getModel: () => current,
                getModelForEditor(_document, _token, _types, bindings) {
                    if (bindings) { bindingRequests++; released = true; current = strong; }
                    return current;
                }
            }
        }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
        const result = operation === "references"
            ? await features.reference.provideReferences(document, position, { includeDeclaration: true })
            : operation === "highlights"
                ? await features.documentHighlight.provideDocumentHighlights(document, position)
                : await features[operation]["provide" + operation[0].toUpperCase() + operation.slice(1)](document, position);
        assert.equal(result.length, 1, operation);
        assert.equal(bindingRequests, 1, "an unmapped source target must not trigger another compiler pass");
        assert.equal(staleQueries, 0, "native fallback must use the replacement snapshot");
    }
});

test("stock-sidecar index navigation uses the compiler-selected overload without a bridge graph", async () => {
    class SemanticTokensLegend {}
    class DocumentHighlight {
        constructor(range, kind) { Object.assign(this, { range, kind }); }
    }
    class Location {
        constructor(uri, range) { Object.assign(this, { uri, range }); }
    }
    const source = [
        "Type Indexed",
        "    Declare Operator [](ByVal index As Long) As Long",
        "    Declare Operator [](ByVal index As Double) As Long",
        "End Type",
        "Operator Indexed.[](ByVal index As Long) As Long",
        "    Return index",
        "End Operator",
        "Operator Indexed.[](ByVal index As Double) As Long",
        "    Return index",
        "End Operator",
        "Dim item As Indexed",
        "Print item[1]",
        "Print item[CDbl(1)]",
        "Dim indexPosition As Long",
        "Print item[indexPosition]"
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/index-navigation.bas",
        toString: () => "file:///workspace/index-navigation.bas" };
    document.positionAt = (offset) => {
        const lines = source.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    const sourceModel = new FreeBasicSemanticModel([{ uri: document.uri, parsed: parseFreeBasicText(source) }]);
    let complete = true;
    const compilerModel = {
        remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            if (["definition", "declaration"].includes(operation)) return sourceModel.resolveAt(document.uri, 13, 6);
            if (["references", "highlights"].includes(operation)) return [{
                uri: document.uri, occurrence: { line: 14, startColumn: 11, endColumn: 24 }
            }];
            if (["compilerSidecarOperatorExpressions", "compilerSidecarOperatorExpressionsInSnapshot"].includes(operation)) return { complete, expressions: [{
                filePath: document.uri.fsPath, line: 11, startColumn: 6, endLine: 11, endColumn: 13,
                targetSymbols: [1], procedures: [{ filePath: document.uri.fsPath, startLine: 5, endLine: 7 }]
            }, {
                filePath: document.uri.fsPath, line: 12, startColumn: 6, endLine: 12, endColumn: 19,
                targetSymbols: [2], procedures: [{ filePath: document.uri.fsPath, startLine: 8, endLine: 10 }]
            }] };
            assert.equal(operation, "compilerSidecarOperatorExpressionAt");
            assert.equal(input.position.line, 11, "An operator declaration must not be queried as an index expression.");
            return { complete, expressions: [{ targetSymbols: [1], procedures: [{
                filePath: document.uri.fsPath, startLine: 5, endLine: 7
            }] }] };
        }
    };
    const features = createSemanticFeatures({ ...createVscodeMock(), SemanticTokensLegend, Location,
        DocumentHighlight, DocumentHighlightKind: { Text: 0 }, Uri: { file: () => document.uri }
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: () => compilerModel,
            getModel: () => compilerModel
        },
        getSourceSemanticModel: () => sourceModel
    }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const position = { line: 11, character: 11 };
    const definitions = await features.definition.provideDefinition(document, position);
    const declarations = await features.declaration.provideDeclaration(document, position);
    const implementations = await features.implementation.provideImplementation(document, position);
    assert.deepEqual(definitions.map((entry) => entry.range.start.line), [4]);
    assert.deepEqual(declarations.map((entry) => entry.range.start.line), [1]);
    assert.deepEqual(implementations.map((entry) => entry.range.start.line), [4]);
    const highlights = await features.documentHighlight.provideDocumentHighlights(document, position);
    assert.ok(highlights.some((entry) => entry.range.start.line === 11));
    assert.equal(highlights.some((entry) => entry.range.start.line === 12), false);
    const references = await features.reference.provideReferences(document, position, { includeDeclaration: true });
    assert.ok(references.some((entry) => entry.range.start.line === 11));
    assert.equal(references.some((entry) => entry.range.start.line === 12), false);
    for (const declaration of [{ line: 1, character: 22 }, { line: 4, character: 18 }]) {
        const declarationReferences = await features.reference.provideReferences(
            document, declaration, { includeDeclaration: true }
        );
        assert.ok(declarationReferences.some((entry) => entry.range.start.line === 11));
        assert.equal(declarationReferences.some((entry) => entry.range.start.line === 12), false);
        const declarationHighlights = await features.documentHighlight.provideDocumentHighlights(document, declaration);
        assert.ok(declarationHighlights.some((entry) => entry.range.start.line === 11));
        assert.equal(declarationHighlights.some((entry) => entry.range.start.line === 12), false);
    }
    const argumentPosition = { line: 14, character: 14 };
    assert.deepEqual((await features.definition.provideDefinition(document, argumentPosition))
        .map((entry) => entry.range.start.line), [13]);
    assert.deepEqual((await features.declaration.provideDeclaration(document, argumentPosition))
        .map((entry) => entry.range.start.line), [13]);
    assert.deepEqual((await features.reference.provideReferences(document, argumentPosition, { includeDeclaration: true }))
        .map((entry) => entry.range.start.line), [14]);
    assert.deepEqual((await features.documentHighlight.provideDocumentHighlights(document, argumentPosition))
        .map((entry) => entry.range.start.line), [14]);
    complete = false;
    assert.deepEqual(await features.definition.provideDefinition(document, position), []);
    assert.deepEqual(await features.documentHighlight.provideDocumentHighlights(document, position), []);
    assert.deepEqual(await features.reference.provideReferences(document, position, { includeDeclaration: true }), []);
});

test("stock-sidecar document highlights request bindings for NOKEYWORD identifiers", async () => {
    class DocumentHighlight {
        constructor(range, kind) { Object.assign(this, { range, kind }); }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const source = [
        '#lang "deprecated"',
        "Option NoKeyword Print",
        "Sub PrintIdentifierProbe()",
        "    Dim Print As Integer",
        "    Print = 1",
        "    Print = Print + 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/nokeyword-print-highlights.bas",
        toString: () => "file:///workspace/nokeyword-print-highlights.bas" };
    const requests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            assert.equal(operation, "highlights");
            return [
                { uri: document.uri, occurrence: { line: 3, startColumn: 8, endColumn: 13 } },
                { uri: document.uri, occurrence: { line: 4, startColumn: 4, endColumn: 9 }, accessRole: "write" },
                { uri: document.uri, occurrence: { line: 5, startColumn: 4, endColumn: 9 }, accessRole: "write" },
                { uri: document.uri, occurrence: { line: 5, startColumn: 12, endColumn: 17 }, accessRole: "read" }
            ];
        }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        DocumentHighlight,
        DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
        Range,
        SemanticTokensLegend
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings, needMacroBindings) {
                requests.push([needExpressionTypes, needSemanticBindings, needMacroBindings]);
                return model;
            },
            getModel: () => null
        }
    }, { keywords: ["print"], types: [], operatorKeywords: [], constants: [] });

    const position = { line: 5, character: 6 };
    const offsetAt = document.offsetAt;
    document.offsetAt = (actual) => {
        assert.equal(actual, position, "offsetAt must receive the editor's Position, not a synthesized plain object");
        return offsetAt(actual);
    };
    const highlights = await features.documentHighlight.provideDocumentHighlights(document, position);
    assert.deepEqual(highlights.map((highlight) => highlight.kind), [0, 2, 2, 1]);
    assert.deepEqual(requests, [[false, true, false]]);
    assert.deepEqual(queries, ["highlights"]);
});

test("editor-bridge definition requests bindings for a conditional REM identifier", async () => {
    class Location {
        constructor(uri, range) { Object.assign(this, { uri, range }); }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const text = [
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemDefinitionProbe()",
        "    Dim REM As Integer",
        "    Print REM",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/bridge-rem-definition.bas",
        toString: () => "file:///workspace/bridge-rem-definition.bas" };
    const line = 5;
    const startColumn = document.lineAt(line).text.indexOf("REM");
    const requests = [];
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "definition");
            return [{
                uri: document.uri,
                name: "REM",
                declaration: { type: "variable", line: 4, startColumn: 8, endColumn: 11, modifiers: [] }
            }];
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ compilerPath: "/compiler/fbc-editor", semanticModelOnly: false }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            },
            getModel: () => null
        }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        Location,
        Range,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const definitions = await features.definition.provideDefinition(document, {
        line,
        character: startColumn + 1
    });

    assert.equal(definitions.length, 1);
    assert.deepEqual(requests, [[false, true]]);
});

test("stock-sidecar macro navigation requests noncompact macro bindings only at macro sites", async () => {
    class Location {
        constructor(uri, range) { this.uri = uri; this.range = range; }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const text = "#define SidecarMacroValue 42\nPrint SidecarMacroValue\n";
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/macros.bas", toString: () => "file:///workspace/macros.bas" };
    const macro = {
        id: "source-macro-value",
        compilerPreprocessorId: "macro:1",
        name: "SidecarMacroValue",
        uri: document.uri,
        declaration: {
            name: "SidecarMacroValue", type: "macro", detail: "Compiler macro",
            line: 0, startColumn: 8, endColumn: 8 + "SidecarMacroValue".length,
            modifiers: [], parameters: []
        }
    };
    const bindingRequests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        semanticMacroBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            if (operation === "definition") return [macro];
            if (operation === "references") return [{
                uri: document.uri,
                occurrence: { line: 1, startColumn: 6, endColumn: 6 + "SidecarMacroValue".length }
            }];
            return [];
        }
    };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(text)
    }]);
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, _needTypes, needSemanticBindings, needSemanticMacroBindings) {
                bindingRequests.push({ needSemanticBindings, needSemanticMacroBindings });
                return model;
            },
            getModel: () => null
        },
        getSourceSemanticModel: () => sourceModel
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        Location,
        Range,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const usePosition = { line: 1, character: 6 };

    const definitions = await features.definition.provideDefinition(document, usePosition);
    const references = await features.reference.provideReferences(document, usePosition, { includeDeclaration: true });

    assert.equal(definitions.length, 1);
    assert.equal(references.length, 1);
    assert.deepEqual(bindingRequests, [
        { needSemanticBindings: true, needSemanticMacroBindings: true },
        { needSemanticBindings: true, needSemanticMacroBindings: true }
    ]);
    assert.deepEqual(queries, ["definition", "references"]);
});

test("stock-sidecar Signature Help requests the compiler-selected macro definition", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation {
        constructor(label) { this.label = label; this.parameters = []; }
    }
    class ParameterInformation {
        constructor(label) { this.label = label; }
    }
    const text = "#define SidecarSignatureMacro(firstValue, secondValue) firstValue\nPrint SidecarSignatureMacro(1, 2)\n";
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/macro-signature.bas", toString: () => "file:///workspace/macro-signature.bas" };
    document.positionAt = (offset) => {
        const lines = text.slice(0, offset).split(/\r\n|\n|\r/);
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(text)
    }]);
    const requests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        semanticMacroBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            return {
                context: { name: "SidecarSignatureMacro", activeParameter: 1 },
                entries: [],
                macroSignature: {
                    name: "SidecarSignatureMacro",
                    signature: "SidecarSignatureMacro(firstValue, secondValue)",
                    parameters: [
                        { label: "firstValue" },
                        { label: "secondValue" }
                    ]
                }
            };
        }
    };
    const provider = createSignatureHelpProvider({
        ...createVscodeMock(), SignatureHelp, SignatureInformation, ParameterInformation
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            async getModelForEditor(_document, _token, needTypes, needBindings, needMacroBindings) {
                requests.push({ needTypes, needBindings, needMacroBindings });
                return model;
            },
            getModel: () => null
        },
        getParsedDocument: () => parseFreeBasicText(text),
        getSourceSemanticModel: () => sourceModel
    });

    const help = await provider.provideSignatureHelp(document, {
        line: 1,
        character: text.split("\n")[1].lastIndexOf("2")
    });

    assert.equal(help.signatures.length, 1);
    assert.equal(help.signatures[0].label, "SidecarSignatureMacro(firstValue, secondValue)");
    assert.deepEqual(help.signatures[0].parameters.map((parameter) => parameter.label), ["firstValue", "secondValue"]);
    assert.equal(help.activeParameter, 1);
    assert.deepEqual(requests, [{ needTypes: false, needBindings: true, needMacroBindings: true }]);
    assert.deepEqual(queries, ["signature"]);
});

test("stock-sidecar Signature Help requests the selected constructor for Return TypeName calls", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation {
        constructor(label) { this.label = label; this.parameters = []; }
    }
    class ParameterInformation {
        constructor(label) { this.label = label; }
    }
    const text = [
        "Type SidecarSignatureChoice",
        "    value As Long",
        "    Declare Constructor(ByVal wholeCount As Long)",
        "    Declare Constructor(ByVal message As String)",
        "End Type",
        "Type SidecarSignatureChoiceAlias As SidecarSignatureChoice",
        "Type SidecarSignatureChoiceAlias2 As SidecarSignatureChoiceAlias",
        "Namespace SidecarSignatureNamespace",
        "    Type NestedChoice As SidecarSignatureChoice",
        "End Namespace",
        "Constructor SidecarSignatureChoice(ByVal wholeCount As Long)",
        "    This.value = wholeCount",
        "End Constructor",
        "Constructor SidecarSignatureChoice(ByVal message As String)",
        "    This.value = Len(message)",
        "End Constructor",
        "Function MakeSidecarSignatureChoice() As SidecarSignatureChoice",
        "    Return SidecarSignatureChoice(5)",
        "End Function",
        "Function MakeAliasedSidecarSignatureChoice() As SidecarSignatureChoice",
        "    Return SidecarSignatureChoiceAlias(6)",
        "End Function",
        "Function MakeQualifiedSidecarSignatureChoice() As SidecarSignatureChoice",
        "    Return SidecarSignatureNamespace.NestedChoice(9)",
        "End Function",
        "Dim directChoice As SidecarSignatureChoice = SidecarSignatureChoice(7)",
        "Dim aliasChoice As SidecarSignatureChoice = SidecarSignatureChoiceAlias(8)",
        "Declare Sub ConsumeSidecarSignatureChoice(ByVal marker As Long, ByVal choice As SidecarSignatureChoice)",
        "ConsumeSidecarSignatureChoice(1, SidecarSignatureChoiceAlias2(9))",
        ""
    ].join("\n");
    const document = createDocument(text);
    const filePath = "/workspace/sidecar-return-constructor-signature.bas";
    document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    document.positionAt = (offset) => {
        const lines = text.slice(0, offset).split(/\r\n|\n|\r/);
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(text)
    }]);
    const constructorLine = text.split("\n").findIndex((line) =>
        line.startsWith("Constructor SidecarSignatureChoice(ByVal wholeCount")
    );
    const requests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            assert.equal(operation, "signature");
            return {
                context: { name: "SidecarSignatureChoice", activeParameter: 0 },
                entries: [],
                selectedConstructorProcedure: {
                    symbol: 41,
                    filePath,
                    startLine: constructorLine + 1,
                    endLine: constructorLine + 3
                }
            };
        }
    };
    const provider = createSignatureHelpProvider({
        ...createVscodeMock(), SignatureHelp, SignatureInformation, ParameterInformation
    }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            async getModelForEditor(_document, _token, needTypes, needBindings, needMacroBindings) {
                requests.push({ needTypes, needBindings, needMacroBindings });
                return model;
            },
            getModel: () => null
        },
        ensureInitialized: async () => true,
        getParsedDocument: () => parseFreeBasicText(text),
        getSemanticModel: () => sourceModel,
        getSourceSemanticModel: () => sourceModel
    });
    const callLine = text.split("\n").findIndex((line) => line.includes("Return SidecarSignatureChoice(5)"));
    const line = text.split("\n")[callLine];
    const openParenthesis = line.indexOf("(", line.indexOf("Return") + "Return ".length + 1);
    const help = await provider.provideSignatureHelp(document, {
        line: callLine,
        character: openParenthesis + 1
    });

    assert.equal(help.signatures.length, 1);
    assert.match(help.signatures[0].label, /ByVal wholeCount As Long/);
    assert.equal(help.activeSignature, 0);
    const initializerLine = text.split("\n").findIndex((line) => line.startsWith("Dim directChoice"));
    const initializerText = text.split("\n")[initializerLine];
    const initializerCallee = initializerText.lastIndexOf("SidecarSignatureChoice");
    const initializerHelp = await provider.provideSignatureHelp(document, {
        line: initializerLine,
        character: initializerText.indexOf("(", initializerCallee) + 1
    });

    assert.equal(initializerHelp.signatures.length, 1);
    assert.match(initializerHelp.signatures[0].label, /ByVal wholeCount As Long/);
    const aliasReturnLine = text.split("\n").findIndex((line) => line.includes("Return SidecarSignatureChoiceAlias(6)"));
    const aliasReturnText = text.split("\n")[aliasReturnLine];
    const aliasReturnHelp = await provider.provideSignatureHelp(document, {
        line: aliasReturnLine,
        character: aliasReturnText.indexOf("(", aliasReturnText.indexOf("SidecarSignatureChoiceAlias")) + 1
    });
    assert.equal(aliasReturnHelp.signatures.length, 1,
        "source-resolved aliases should request the compiler-selected constructor signature");
    assert.match(aliasReturnHelp.signatures[0].label, /ByVal wholeCount As Long/);
    const qualifiedReturnLine = text.split("\n").findIndex((line) =>
        line.includes("Return SidecarSignatureNamespace.NestedChoice(9)")
    );
    const qualifiedReturnText = text.split("\n")[qualifiedReturnLine];
    const qualifiedReturnOpen = qualifiedReturnText.indexOf("(", qualifiedReturnText.indexOf("SidecarSignatureNamespace"));
    const qualifiedReturnHelp = await provider.provideSignatureHelp(document, {
        line: qualifiedReturnLine,
        character: qualifiedReturnOpen + 1
    });
    assert.equal(qualifiedReturnHelp.signatures.length, 1,
        "qualified constructor calls in Return expressions should request the selected signature");
    assert.match(qualifiedReturnHelp.signatures[0].label, /ByVal wholeCount As Long/);
    const aliasInitializerLine = text.split("\n").findIndex((line) => line.startsWith("Dim aliasChoice"));
    const aliasInitializerText = text.split("\n")[aliasInitializerLine];
    const aliasInitializerCallee = aliasInitializerText.indexOf("SidecarSignatureChoiceAlias");
    const aliasInitializerHelp = await provider.provideSignatureHelp(document, {
        line: aliasInitializerLine,
        character: aliasInitializerText.indexOf("(", aliasInitializerCallee) + 1
    });
    assert.equal(aliasInitializerHelp.signatures.length, 1,
        "aliased variable initializers should request the compiler-selected constructor signature");
    assert.match(aliasInitializerHelp.signatures[0].label, /ByVal wholeCount As Long/);
    const nestedLine = text.split("\n").findIndex((line) => line.includes("ConsumeSidecarSignatureChoice(1, SidecarSignatureChoiceAlias2(9))"));
    const nestedText = text.split("\n")[nestedLine];
    const nestedCallee = nestedText.lastIndexOf("SidecarSignatureChoice", nestedText.indexOf("(9)"));
    const nestedHelp = await provider.provideSignatureHelp(document, {
        line: nestedLine,
        character: nestedText.indexOf("(", nestedCallee) + 1
    });
    assert.equal(nestedHelp.signatures.length, 1,
        "nested aliased constructor calls should request the compiler-selected signature");
    assert.match(nestedHelp.signatures[0].label, /ByVal wholeCount As Long/);
    assert.deepEqual(requests, [
        { needTypes: false, needBindings: true, needMacroBindings: false },
        { needTypes: false, needBindings: true, needMacroBindings: false },
        { needTypes: false, needBindings: true, needMacroBindings: false },
        { needTypes: false, needBindings: true, needMacroBindings: false },
        { needTypes: false, needBindings: true, needMacroBindings: false },
        { needTypes: false, needBindings: true, needMacroBindings: false }
    ], "source-resolved constructor calls should request binding-capable sidecar overload selection");
    assert.deepEqual(queries, ["signature", "signature", "signature", "signature", "signature", "signature"]);
});

test("stock-sidecar macro hover requests and displays the compiler-selected signature", async () => {
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value, language) { this.value += `\n\n\`\`\`${language}\n${value}\n\`\`\``; }
    }
    class Hover { constructor(contents) { this.contents = contents; } }
    const text = [
        "#define SidecarHoverMacro(item, fallback) item",
        "Print SidecarHoverMacro(1, 2)",
        "#define SidecarHoverObjectMacro 42",
        "Print SidecarHoverObjectMacro",
        ""
    ].join("\n");
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/macro-hover.bas", toString: () => "file:///workspace/macro-hover.bas" };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(text)
    }]);
    const requests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        semanticMacroBindingsAvailable: true,
        async query(operation, _uri, input) {
            queries.push(operation);
            const objectMacro = input?.position?.line === 3;
            const name = objectMacro ? "SidecarHoverObjectMacro" : "SidecarHoverMacro";
            const signature = objectMacro ? name : `${name}(item, fallback)`;
            const definition = objectMacro
                ? "#define SidecarHoverObjectMacro 42"
                : "#define SidecarHoverMacro(item, fallback) item";
            return {
                entries: [],
                occurrence: null,
                expression: null,
                expressionAlternatives: [],
                compilerHeaderLibraries: [],
                macroSignature: {
                    name,
                    signature,
                    parameters: objectMacro ? [] : [{ label: "item" }, { label: "fallback" }],
                    sourceDefinition: definition
                }
            };
        }
    };
    const provider = createHoverProvider({ ...createVscodeMock(), MarkdownString, Hover }, {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            async getModelForEditor(_document, _token, needTypes, needBindings, needMacroBindings) {
                requests.push({ needTypes, needBindings, needMacroBindings: Boolean(needMacroBindings) });
                return needMacroBindings ? model : null;
            },
            getModel: () => null
        },
        getParsedDocument: () => parseFreeBasicText(text),
        getSourceSemanticModel: () => sourceModel,
        getSemanticModel: () => sourceModel,
        async ensureInitialized() { return true; }
    }, {});

    const hover = await provider.provideHover(document, {
        line: 1,
        character: text.split("\n")[1].indexOf("SidecarHoverMacro") + 1
    });

    assert.match(hover.contents.value, /Compiler-selected macro signature: `SidecarHoverMacro\(item, fallback\)`\./);
    assert.match(hover.contents.value, /Active compiler macro definition:/);
    assert.match(hover.contents.value, /#define SidecarHoverMacro\(item, fallback\) item/);
    const objectHover = await provider.provideHover(document, {
        line: 3,
        character: text.split("\n")[3].indexOf("SidecarHoverObjectMacro") + 1
    });
    assert.match(objectHover.contents.value, /Compiler-selected macro signature: `SidecarHoverObjectMacro`\./);
    assert.match(objectHover.contents.value, /#define SidecarHoverObjectMacro 42/);
    assert.deepEqual(requests, [
        { needTypes: false, needBindings: false, needMacroBindings: false },
        { needTypes: true, needBindings: true, needMacroBindings: true },
        { needTypes: false, needBindings: false, needMacroBindings: false },
        { needTypes: true, needBindings: true, needMacroBindings: true }
    ]);
    assert.deepEqual(queries, ["hover", "hover"]);
});

test("configured project Find References uses the compiler-bound project transaction", async () => {
    class Location {
        constructor(uri, range) { this.uri = uri; this.range = range; }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const document = createDocument("Print projectValue\n");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const locations = [
        new Location(document.uri, new Range(0, 6, 0, 18)),
        new Location({ scheme: "file", fsPath: "/workspace/other.bas", toString: () => "file:///workspace/other.bas" },
            new Range(2, 9, 2, 21))
    ];
    const queries = [];
    const projectRequests = [];
    const model = {
        remote: true,
        async query(operation) { queries.push(operation); return []; }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: () => model,
            getModel: () => model
        },
        compilerProject: {
            hasProjectContexts: () => true,
            async references(_document, _position, includeDeclaration) {
                projectRequests.push({ includeDeclaration });
                return locations;
            }
        }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        Location,
        Range,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });

    const references = await features.reference.provideReferences(document,
        { line: 0, character: 9 }, { includeDeclaration: true });

    assert.deepEqual(references, locations);
    assert.deepEqual(projectRequests, [{ includeDeclaration: true }]);
    assert.deepEqual(queries, [], "project-complete references should replace the translation-unit-only reply");
});

test("configured stock-sidecar macro Find References passes the full macro-snapshot requirement", async () => {
    class Location {
        constructor(uri, range) { this.uri = uri; this.range = range; }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const text = "#define ProjectMacroReference 42\nPrint ProjectMacroReference\n";
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/macro-references.bas", toString: () => "file:///workspace/macro-references.bas" };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(text)
    }]);
    const projectLocation = new Location(document.uri, new Range(0, 8, 0, 8 + "ProjectMacroReference".length));
    const macroBindingRequests = [];
    const projectRequests = [];
    const queries = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        semanticMacroBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            return [];
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, _needTypes, needBindings, needMacroBindings) {
                macroBindingRequests.push({ needBindings, needMacroBindings });
                return model;
            },
            getModel: () => null
        },
        compilerProject: {
            hasProjectContexts: () => true,
            async references(_document, _position, includeDeclaration, _token, macroReferences) {
                projectRequests.push({ includeDeclaration, macroReferences });
                return [projectLocation];
            }
        },
        getSourceSemanticModel: () => sourceModel
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(), Location, Range, SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });

    const references = await features.reference.provideReferences(document,
        { line: 1, character: text.split("\n")[1].indexOf("ProjectMacroReference") + 1 },
        { includeDeclaration: true });

    assert.deepEqual(references, [projectLocation]);
    assert.deepEqual(macroBindingRequests, [{ needBindings: true, needMacroBindings: true }]);
    assert.deepEqual(projectRequests, [{ includeDeclaration: true, macroReferences: true }]);
    assert.deepEqual(queries, [], "project-complete macro references should replace the local snapshot reply");
});

test("Go to Definition extends a project-local prototype to its configured implementation", async () => {
    class Location {
        constructor(uri, range) { this.uri = uri; this.range = range; }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const text = "Declare Function projectValue() As Long\n";
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const prototype = {
        id: "sidecar-project-value",
        name: "projectValue",
        compilerSymbolId: 7,
        uri: document.uri,
        declaration: {
            name: "projectValue", type: "function", detail: "Function As Long", typeName: "Long",
            line: 0, startColumn: 17, endColumn: 29, modifiers: ["DECLARE"], parameters: []
        }
    };
    const implementation = new Location(
        { scheme: "file", fsPath: "/workspace/implementation.bas", toString: () => "file:///workspace/implementation.bas" },
        new Range(4, 9, 4, 21)
    );
    const queries = [];
    const projectRequests = [];
    let symbolResolved = true;
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            queries.push(operation);
            return operation === "definition" && symbolResolved ? [prototype] : [];
        }
    };
    const sourceModel = { resolveAt: () => [prototype] };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: () => model,
            getModel: () => model
        },
        getSourceSemanticModel: () => sourceModel,
        compilerProject: {
            hasProjectContexts: () => true,
            async navigation(_document, _position, operation) {
                projectRequests.push(operation);
                return [implementation];
            }
        }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        Location,
        Range,
        SemanticTokensLegend
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });

    const definitions = await features.definition.provideDefinition(document,
        { line: 0, character: text.indexOf("projectValue") });
    const implementations = await features.implementation.provideImplementation(document,
        { line: 0, character: text.indexOf("projectValue") });

    assert.deepEqual(definitions, [implementation]);
    assert.deepEqual(implementations, [implementation]);
    assert.deepEqual(projectRequests, ["definition", "implementation"]);
    assert.deepEqual(queries, ["definition", "implementation", "definition"]);

    symbolResolved = false;
    assert.deepEqual(await features.definition.provideDefinition(document,
        { line: 0, character: text.indexOf("projectValue") }), []);
    assert.deepEqual(projectRequests, ["definition", "implementation"],
        "unresolved names should not trigger a full project scan");
    assert.deepEqual(queries, ["definition", "implementation", "definition", "definition"]);
});

test("semantic tokens reuse cached stock-sidecar read/write and readonly facts", async () => {
    class SemanticTokensLegend {
        constructor(types, modifiers) { Object.assign(this, { types, modifiers }); }
    }
    class SemanticTokensBuilder {
        constructor(legend) { this.legend = legend; this.tokens = []; }
        push(range, type, modifiers) { this.tokens.push({ range, type, modifiers }); }
        build() { return this.tokens; }
    }
    class DocumentHighlight {
        constructor(range, kind) { Object.assign(this, { range, kind }); }
    }
    const text = "accessValue = 1\nPrint accessValue\n";
    const document = createDocument(text);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/access-highlights.bas",
        toString: () => "file:///workspace/access-highlights.bas"
    };
    const occurrences = [text.indexOf("accessValue"), text.lastIndexOf("accessValue")].map((offset) => {
        const line = text.slice(0, offset).split("\n").length - 1;
        const startColumn = offset - text.lastIndexOf("\n", offset - 1) - 1;
        return {
            kind: "identifier", key: "ACCESSVALUE", name: "accessValue", offset, line,
            startColumn, endColumn: startColumn + "accessValue".length
        };
    });
    const semanticDocument = { tokens: occurrences, entries: [], entriesByOffset: new Map() };
    semanticDocument.uri = document.uri;
    const entry = {
        name: "accessValue",
        declaration: { type: "variable", modifiers: [], documentation: "@deprecated Use a replacement variable." }
    };
    const references = occurrences.map((occurrence) => ({ uri: document.uri, occurrence: {
        line: occurrence.line,
        startColumn: occurrence.startColumn,
        endColumn: occurrence.endColumn
    } }));
    const sourceModel = {
        remote: false,
        entries: [],
        getDocument: () => semanticDocument,
        resolveToken: () => [entry],
        resolveAt: () => [entry],
        references: () => references
    };
    const bindingRequests = [];
    let readonlyMode = false;
    const cachedSidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            bindingRequests.push(operation);
            if (operation === "compilerSidecarAccessRolesAtSites") {
                assert.equal(input.sites.length, 2);
                if (readonlyMode) return [{ index: 0, role: "write" }, { index: 1, readonly: true }];
                return [{ index: 0, role: "write" }, { index: 1, role: "read" }];
            }
            assert.equal(operation, "highlights");
            return references.map((entry, index) => ({
                ...entry,
                accessRole: index === 0 ? "write" : "read"
            }));
        }
    };
    const modelRequests = [];
    const index = {
        compilerAnalysis: {
            getModelForEditor: async (_document, _token, needTypes, needBindings) => {
                modelRequests.push([needTypes, needBindings]);
                return sourceModel;
            },
            getModel: () => cachedSidecarModel
        }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(), SemanticTokensLegend, SemanticTokensBuilder, DocumentHighlight,
        DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 }
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });

    const tokens = await features.semanticTokens.provideDocumentSemanticTokens(document);
    assert.deepEqual(modelRequests, [[false, false]], "sidecar access roles must not trigger another analysis pass");
    assert.deepEqual(bindingRequests, ["compilerSidecarAccessRolesAtSites"]);
    assert.ok(tokens[0].modifiers.includes("modification"));
    assert.ok(tokens.every((token) => token.modifiers.includes("deprecated")),
        "local semantic tokens should mark all references to a documented deprecated symbol");
    assert.deepEqual(tokens[1].modifiers, ["deprecated"]);

    const highlights = await features.documentHighlight.provideDocumentHighlights(document, { line: 1, character: 7 });
    assert.deepEqual(highlights.map((highlight) => highlight.kind), [2, 1],
        "cached sidecar roles should mark reads and writes without another compile");
    assert.deepEqual(modelRequests, [[false, false]],
        "document highlights should reuse the cached binding-capable sidecar without requesting another model");
    assert.deepEqual(bindingRequests, ["compilerSidecarAccessRolesAtSites", "highlights"]);
    readonlyMode = true;
    const readonlyTokens = await features.semanticTokens.provideDocumentSemanticTokens(document);
    assert.ok(readonlyTokens[1].modifiers.includes("readonly"), "readonly facts need no ACC read/write record");
    assert.ok(readonlyTokens[0].modifiers.includes("modification"));
    assert.deepEqual(modelRequests, [[false, false], [false, false]], "readonly coloring must not request binding analysis");
});

test("source hover and Call Hierarchy keep index arguments separate from the operator", async () => {
    class SemanticTokensLegend {}
    class MarkdownString {
        constructor(value = "") { this.value = value; }
        appendMarkdown(value) { this.value += value; }
        appendCodeblock(value) { this.value += `\n${value}\n`; }
    }
    class Hover { constructor(contents) { this.contents = contents; } }
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    class CallHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) {
            Object.assign(this, { kind, name, detail, uri, range, selectionRange });
        }
    }
    const text = [
        "Type IndexedValue",
        "    value As Double",
        "    Declare Operator [](ByVal index As Long) As Double",
        "End Type",
        "Function ReadIndex() As Long",
        "    Return 1",
        "End Function",
        "Dim item As IndexedValue",
        "Dim indexChoice As Long",
        "Print item[indexChoice]",
        "Print item[ReadIndex()]"
    ].join("\n");
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/index-arguments.bas",
        toString: () => "file:///workspace/index-arguments.bas" };
    document.positionAt = (offset) => {
        const prefix = text.slice(0, offset);
        return { line: prefix.split("\n").length - 1, character: offset - prefix.lastIndexOf("\n") - 1 };
    };
    const parsed = parseFreeBasicText(text);
    const model = new FreeBasicSemanticModel([{ uri: document.uri, parsed }]);
    const index = {
        getParsedDocument: () => parsed,
        getSemanticModel: () => model,
        getSourceSemanticModel: () => model,
        ensureInitialized: async () => true,
        isIncomplete: () => false
    };
    const vscode = { ...createVscodeMock(), SemanticTokensLegend, MarkdownString, Hover, Location, CallHierarchyItem };
    const features = createSemanticFeatures(vscode, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const argument = { line: 9, character: 14 };
    const hover = await createHoverProvider(vscode, index, {}).provideHover(document, argument);
    assert.match(hover.contents.value, /Dim indexChoice As Long/i);
    assert.doesNotMatch(hover.contents.value, /Operator/i);
    index.compilerAnalysis = {
        analysisCompilerFor: () => ({ semanticModelOnly: true }),
        getModelForEditor: () => null,
        getModel: () => null
    };
    const stockHover = await createHoverProvider(vscode, index, {}).provideHover(document, argument);
    assert.match(stockHover.contents.value, /Dim indexChoice As Long/i,
        "ordinary variable hover must accept semantic documents without VS Code's lineAt method");
    assert.deepEqual(await features.callHierarchy.prepareCallHierarchy(document, argument), []);
    assert.deepEqual((await features.definition.provideDefinition(document, argument))
        .map((entry) => entry.range.start.line), [8]);
    const nestedCall = await features.callHierarchy.prepareCallHierarchy(document, { line: 10, character: 13 });
    assert.deepEqual(nestedCall.map((entry) => entry.name), ["ReadIndex"]);
});

test("remote Call Hierarchy prepares ordinary calls without building the source index", async () => {
    class CallHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) {
            Object.assign(this, { kind, name, detail, uri, range, selectionRange });
        }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const document = createDocument("CallTarget()\n");
    document.uri = { scheme: "file", fsPath: "/workspace/main.bas", toString: () => "file:///workspace/main.bas" };
    const requests = [];
    const model = {
        remote: true,
        async query(operation) {
            requests.push(operation);
            return [{
                uri: document.uri,
                name: "CallTarget",
            declaration: {
                type: "function", name: "CallTarget", line: 0,
                startColumn: 0, endColumn: 10, signature: "Function CallTarget()",
                documentation: "@deprecated Use a replacement call."
            }
            }];
        }
    };
    const index = {
        compilerAnalysis: {
            getModelForEditor: () => model,
            getModel: () => model
        },
        getSourceSemanticModel() { throw new Error("ordinary calls should not build the source index"); },
        getSemanticModel() { throw new Error("ordinary calls should not build a source model"); }
    };
    const features = createSemanticFeatures({
        ...createVscodeMock(),
        CallHierarchyItem,
        SymbolTag: { Deprecated: 1 },
        SemanticTokensLegend,
        SymbolKind: { Function: 11 },
        Range
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const hierarchy = await features.callHierarchy.prepareCallHierarchy(document, { line: 0, character: 3 });

    assert.equal(hierarchy.length, 1);
    assert.equal(hierarchy[0].name, "CallTarget");
    assert.deepEqual(hierarchy[0].tags, [1]);
    assert.deepEqual(requests, ["callHierarchyPrepare"]);
});

test("stock-sidecar Call Hierarchy follows a bare call with omitted optional arguments", async () => {
    class CallHierarchyItem {
        constructor(kind, name, detail, uri, range, selectionRange) {
            Object.assign(this, { kind, name, detail, uri, range, selectionRange });
        }
    }
    class CallHierarchyIncomingCall {
        constructor(from, fromRanges) { Object.assign(this, { from, fromRanges }); }
    }
    class CallHierarchyOutgoingCall {
        constructor(to, fromRanges) { Object.assign(this, { to, fromRanges }); }
    }
    class SemanticTokensLegend {
        constructor() {}
    }
    const text = [
        "Function OptionalValue(ByVal value As Long = 7) As Long",
        "    Return value",
        "End Function",
        "Sub OptionalAction(ByVal value As Long = 7)",
        "End Sub",
        "Sub Caller()",
        "    Dim result As Long = OptionalValue",
        "    OptionalAction",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/bare-optional-call.bas",
        toString: () => "file:///workspace/bare-optional-call.bas" };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(text)
    }]);
    const callBindingModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            if (operation === "compilerSidecarCallBindingsInSnapshot") {
                return {
                complete: true,
                calls: [{
                    filePath: document.uri.fsPath,
                    line: 6,
                    startColumn: 25,
                    endColumn: 38,
                    targetSymbols: [17],
                    declarations: [{
                        filePath: document.uri.fsPath,
                        line: 0,
                        startColumn: 9,
                        endColumn: 22,
                        name: "OptionalValue"
                    }]
                }, {
                    filePath: document.uri.fsPath,
                    line: 7,
                    startColumn: 4,
                    endColumn: 18,
                    targetSymbols: [18],
                    declarations: [{
                        filePath: document.uri.fsPath,
                        line: 3,
                        startColumn: 4,
                        endColumn: 18,
                        name: "OptionalAction"
                    }]
                }]
                };
            }
            if (operation === "compilerSidecarOperatorOperationsInSnapshot") return { complete: true, operations: [] };
            if (operation === "compilerSidecarOperatorExpressionsInSnapshot") return { complete: true, expressions: [] };
            if (operation === "compilerSidecarImplicitCallsInSnapshot") return { complete: true, calls: [] };
            assert.fail(`Unexpected compiler query: ${operation}`);
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: () => sourceModel,
            getModel: () => callBindingModel
        },
        getSemanticModel: () => sourceModel,
        getSourceSemanticModel: () => sourceModel
    };
    const baseVscode = createVscodeMock();
    let opened = 0;
    const workspace = { ...baseVscode.workspace, textDocuments: [document], async openTextDocument(uri) {
        assert.equal(uri.toString(), document.uri.toString());
        opened++;
        this.textDocuments.push(document);
        return document;
    } };
    const features = createSemanticFeatures({
        ...baseVscode,
        CallHierarchyItem,
        CallHierarchyIncomingCall,
        CallHierarchyOutgoingCall,
        SemanticTokensLegend,
        SymbolKind: { File: 1, Function: 11 },
        workspace
    }, index, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const functionItem = await features.callHierarchy.prepareCallHierarchy(document, { line: 6, character: 29 });
    assert.equal(functionItem.length, 1);
    assert.equal(functionItem[0].name, "OptionalValue");
    const functionCallers = await features.callHierarchy.provideCallHierarchyIncomingCalls(functionItem[0]);
    assert.deepEqual(functionCallers.map((caller) => [caller.from.name, caller.fromRanges.length]), [["Caller", 1]]);

    const subItem = await features.callHierarchy.prepareCallHierarchy(document, { line: 7, character: 7 });
    assert.equal(subItem.length, 1);
    assert.equal(subItem[0].name, "OptionalAction");
    const subCallers = await features.callHierarchy.provideCallHierarchyIncomingCalls(subItem[0]);
    assert.deepEqual(subCallers.map((caller) => [caller.from.name, caller.fromRanges.length]), [["Caller", 1]]);

    const callerItem = await features.callHierarchy.prepareCallHierarchy(document, { line: 5, character: 5 });
    assert.equal(callerItem.length, 1);
    const callees = await features.callHierarchy.provideCallHierarchyOutgoingCalls(callerItem[0]);
    assert.deepEqual(callees.map((callee) => [callee.to.name, callee.fromRanges.length]), [
        ["OptionalValue", 1], ["OptionalAction", 1]
    ]);
    workspace.textDocuments.length = 0;
    assert.deepEqual((await features.callHierarchy.provideCallHierarchyIncomingCalls(functionItem[0]))
        .map((caller) => [caller.from.name, caller.fromRanges.length]), [["Caller", 1]],
    "closed functions must retain compiler-selected bare calls with omitted arguments");
    assert.equal(opened, 1);
    workspace.textDocuments.length = 0;
    assert.deepEqual((await features.callHierarchy.provideCallHierarchyOutgoingCalls(callerItem[0]))
        .map((callee) => [callee.to.name, callee.fromRanges.length]), [["OptionalValue", 1], ["OptionalAction", 1]]);
    assert.equal(opened, 2);
});

test("Signature Help supports bare qualified and continued procedure arguments", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation { constructor(label) { this.label = label; this.parameters = []; } }
    class ParameterInformation { constructor(label) { this.label = label; } }
    const text = 'Namespace BareScope\nDeclare Sub Work(ByVal first As Long, ByVal second As String, ByVal third As Long = 0)\nEnd Namespace\n' +
        'BareScope.Work 1, _\n "x,y", _\n 3\n';
    const document = createDocument(text);
    document.uri = { scheme: "file", fsPath: "/workspace/bare-help.bas", toString: () => "file:///workspace/bare-help.bas" };
    document.positionAt = (offset) => { const prefix = text.slice(0, offset).split("\n"); return { line: prefix.length - 1, character: prefix.at(-1).length }; };
    const model = new FreeBasicSemanticModel([{ uri: document.uri, parsed: parseFreeBasicText(text) }]);
    const index = { getParsedDocument: () => parseFreeBasicText(text), ensureInitialized: async () => true, getSemanticModel: () => model,
        getSourceSemanticModel: () => model };
    const provider = createSignatureHelpProvider({ ...createVscodeMock(), SignatureHelp, SignatureInformation, ParameterInformation }, index);
    const help = await provider.provideSignatureHelp(document, { line: 5, character: 2 });
    assert.ok(help);
    assert.match(help.signatures[0].label, /Sub Work\(/i);
    assert.equal(help.activeParameter, 2);
    const sleep = createDocument("Sleep 1, ");
    sleep.uri = document.uri;
    sleep.positionAt = (offset) => ({ line: 0, character: offset });
    const builtin = await provider.provideSignatureHelp(sleep, { line: 0, character: sleep.getText().length });
    assert.ok(builtin?.signatures.length);
    assert.equal(builtin.activeParameter, 1);
});

test("Signature Help skips compiler analysis when a trigger is outside a call", async () => {
    let modelRequests = 0;
    const provider = createSignatureHelpProvider({}, {
        compilerAnalysis: {
            getModelForEditor() {
                modelRequests++;
                throw new Error("a stray comma must not start compiler analysis");
            }
        }
    });
    for (const text of ["first, second", "Dim value As Long, other As Long", "Return value, other", "' Work 1, ", 'Work "unfinished,']) {
        const document = createDocument(text);
        const help = await provider.provideSignatureHelp(document, { line: 0, character: text.length });
        assert.equal(help, null, text);
    }
    assert.equal(modelRequests, 0);
});

test("Signature Help follows a superseded native constructor binding upgrade", async () => {
    class SignatureHelp {}
    class SignatureInformation { constructor(label) { this.label = label; } }
    class ParameterInformation { constructor(label) { this.label = label; } }
    const document = createDocument("Dim value As Choice Ptr = New Choice(CDbl(5))\n");
    document.uri = { scheme: "file", fsPath: "/workspace/constructor-upgrade.bas",
        toString: () => "file:///workspace/constructor-upgrade.bas" };
    const declaration = (typeName, id) => ({ compilerSymbolId: id,
        declaration: { type: "constructor", name: "Choice", signature: `Constructor Choice(ByVal source As ${typeName})`,
            parameters: [{ name: "source", label: `ByVal source As ${typeName}`, typeName }], modifiers: [] } });
    const entries = [declaration("Long", 1), declaration("Double", 2)];
    const context = { name: "Choice", activeParameter: 0 };
    const strong = { remote: true, semanticSidecarOnly: false, semanticBindingsAvailable: true,
        query: async () => ({ context, entries: [entries[1]], selectedCompilerSymbolId: 2 }) };
    const source = new FreeBasicSemanticModel([{ uri: document.uri, parsed: parseFreeBasicText(document.getText()) }]);
    for (const retained of [true, false]) {
        let requests = 0, weakQueries = 0;
        const weak = { remote: true, semanticSidecarOnly: false, semanticBindingsAvailable: false,
            query: async () => { weakQueries++; return { context, entries }; } };
        const analysis = {
            generation: 0,
            getModelForEditor: async (_document, _token, needTypes, needBindings) => {
                assert.equal(needTypes, false);
                assert.equal(needBindings, true);
                requests++;
                if (requests === 1) {
                    if (!retained) analysis.generation++;
                    return null;
                }
                return strong;
            },
            getModel: () => retained ? weak : null,
            analysisCompilerFor: () => ({ semanticModelOnly: false })
        };
        const provider = createSignatureHelpProvider({ ...createVscodeMock(), SignatureHelp, SignatureInformation, ParameterInformation }, {
            compilerAnalysis: analysis,
            getParsedDocument: () => parseFreeBasicText(document.getText()),
            ensureInitialized: async () => true,
            getSemanticModel: () => source
        });
        const result = await provider.provideSignatureHelp(document,
            { line: 0, character: document.getText().indexOf("Choice(CDbl") + "Choice(".length });
        assert.ok(result, retained ? "retained weak predecessor" : "cleared predecessor after invalidation");
        assert.equal(result.signatures.length, 1);
        assert.match(result.signatures[0].label, /source As Double/);
        assert.equal(weakQueries, 0, "a weak cached model cannot satisfy a request for selected-constructor facts");
        assert.equal(requests, 2, "a superseded upgrade gets one bounded retry");
    }
});

test("Signature Help activates the compiler-selected ordinary overload", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation {
        constructor(label) { this.label = label; this.parameters = []; }
    }
    class ParameterInformation {
        constructor(label) { this.label = label; }
    }
    const document = createDocument("SelectValue(1.0)");
    document.uri = { scheme: "file", fsPath: "/workspace/signatures.bas", toString: () => "file:///workspace/signatures.bas" };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "signature");
            return {
                context: { name: "SelectValue", activeParameter: 0 },
                selectedCompilerSymbolId: 22,
                entries: [
                    {
                        compilerSymbolId: 11,
                        declaration: {
                            name: "SelectValue", type: "function", signature: "Function SelectValue(ByVal value As Integer) As Integer",
                            parameters: [{ label: "ByVal value As Integer" }]
                        }
                    },
                    {
                        compilerSymbolId: 22,
                        declaration: {
                            name: "SelectValue", type: "function", signature: "Function SelectValue(ByVal value As Double) As Double",
                            parameters: [{ label: "ByVal value As Double" }]
                        }
                    }
                ]
            };
        }
    };
    const provider = createSignatureHelpProvider({ SignatureHelp, SignatureInformation, ParameterInformation }, {
        compilerAnalysis: { getModelForEditor: async () => model }
    });
    const help = await provider.provideSignatureHelp(document, {
        line: 0,
        character: "SelectValue(".length + 1
    });

    assert.equal(help.signatures.length, 2, "both visible overloads should remain available");
    assert.equal(help.activeSignature, 1, "Signature Help should activate FBC's selected Double overload");
    assert.equal(help.signatures[help.activeSignature].label,
        "Function SelectValue(ByVal value As Double) As Double");
});

test("Signature Help shows a compiler-resolved optional default value", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation {
        constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; }
    }
    class ParameterInformation {
        constructor(label, documentation) { this.label = label; this.documentation = documentation; }
    }
    const source = "ConsumeCount()\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/default-signature.bas",
        toString: () => "file:///workspace/default-signature.bas" };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "signature");
            return {
                context: { name: "ConsumeCount", activeParameter: 0 },
                entries: [{
                    declaration: {
                        name: "ConsumeCount",
                        type: "sub",
                        signature: "Sub ConsumeCount(ByVal count As Long = DEFAULT_COUNT)",
                        parameters: [{
                            label: "ByVal count As Long = DEFAULT_COUNT",
                            optional: true,
                            compilerDefaultValue: { kind: "signed", value: "41", typeName: "integer" }
                        }]
                    }
                }]
            };
        }
    };
    const provider = createSignatureHelpProvider({
        ...createVscodeMock(), SignatureHelp, SignatureInformation, ParameterInformation
    }, { compilerAnalysis: { getModelForEditor: async () => model } });
    const help = await provider.provideSignatureHelp(document, {
        line: 0, character: "ConsumeCount(".length
    });

    assert.equal(help.signatures[0].parameters[0].label, "ByVal count As Long = DEFAULT_COUNT");
    assert.match(help.signatures[0].parameters[0].documentation,
        /Compiler-resolved source default expression: `41` \(integer\)\./);
});

test("Signature Help uses manual forms for opt-in serialization intrinsics", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation {
        constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; }
    }
    class ParameterInformation {
        constructor(label, documentation) { this.label = label; this.documentation = documentation; }
    }
    const document = createDocument("Serialize(value)\nDeserialize(payload, destination)\n");
    document.uri = { scheme: "file", fsPath: "/workspace/serialization-signatures.bas", toString: () => "file:///workspace/serialization-signatures.bas" };
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "signature");
            return {
                context: position.line === 0
                    ? { name: "Serialize", activeParameter: 0 }
                    : { name: "Deserialize", activeParameter: 1 },
                entries: []
            };
        }
    };
    const provider = createSignatureHelpProvider({ SignatureHelp, SignatureInformation, ParameterInformation }, {
        compilerAnalysis: { getModelForEditor: async () => model }
    });

    const serialize = await provider.provideSignatureHelp(document, {
        line: 0,
        character: "Serialize(".length + 1
    });
    assert.deepEqual(serialize.signatures.map((signature) => signature.label), [
        "Serialize(value)", "Serialize(array())"
    ]);
    assert.match(serialize.signatures[0].parameters[0].documentation, /supported variable/);
    assert.match(serialize.signatures[0].documentation, /does not perform file or network I\/O/i);

    const deserialize = await provider.provideSignatureHelp(document, {
        line: 1,
        character: "Deserialize(payload, ".length + 1
    });
    assert.deepEqual(deserialize.signatures.map((signature) => signature.label), [
        "Deserialize(payload, destination)", "Deserialize(payload, array())"
    ]);
    assert.match(deserialize.signatures[0].parameters[1].documentation, /writable supported variable/);
    assert.match(deserialize.signatures[0].documentation, /original destination remains unchanged/i);
});

test("Signature Help explains a compiler-confirmed parameter mode when the keyword is omitted", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation {
        constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; }
    }
    class ParameterInformation {
        constructor(label, documentation) { this.label = label; this.documentation = documentation; }
    }
    const source = "consumeDefault(value)\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/default-parameter-mode.bas",
        toString: () => "file:///workspace/default-parameter-mode.bas" };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "signature");
            return {
                context: { name: "consumeDefault", activeParameter: 0 },
                entries: [{
                    declaration: {
                        name: "consumeDefault",
                        type: "sub",
                        signature: "Sub consumeDefault(value As Integer)",
                        parameters: [{
                            label: "value As Integer",
                            compilerParameterPassing: {
                                mode: "byref", modeWritten: false, dimensions: 0, optional: false, receiver: false
                            }
                        }]
                    }
                }]
            };
        }
    };
    const provider = createSignatureHelpProvider({
        ...createVscodeMock(), SignatureHelp, SignatureInformation, ParameterInformation
    }, { compilerAnalysis: { getModelForEditor: async () => model } });

    const help = await provider.provideSignatureHelp(document, {
        line: 0, character: source.indexOf("value") + 2
    });
    assert.match(help.signatures[0].parameters[0].documentation,
        /Compiler-selected parameter passing: ByRef \(default; keyword not written\)\./);
});

test("Signature Help includes compiler-selected implicit return and ABI details", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation {
        constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; }
    }
    class ParameterInformation {
        constructor(label, documentation) { this.label = label; this.documentation = documentation; }
    }
    const source = 'implicitResult(1)\ncStringProbe("text")\narrayProbe(values)';
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-signature.bas", toString: () => "file:///workspace/implicit-signature.bas" };
    const entry = {
        compilerSymbolId: 17,
        declaration: {
            name: "implicitResult",
            type: "function",
            typeName: "Integer",
            signature: "Function implicitResult(ByVal value As Integer)",
            documentation: "Returns the exact compiler-selected result.",
            parameters: [{ label: "ByVal value As Integer" }],
            compilerFacts: {
                procedureTypingInputs: [{ kind: "function", role: "definition", resultForm: "implicit", provisional: false }]
            }
        }
    };
    const abiEntry = {
        compilerSymbolId: 18,
        declaration: {
            name: "cStringProbe",
            type: "function",
            signature: "Declare Function cStringProbe(ByVal value As String) As Long",
            documentation: "@deprecated Use a replacement C declaration.",
            parameters: [{ label: "ByVal value As String" }],
            compilerHeaderLibraries: [{ kind: "inclib", value: "graphics", filePath: "/freebasic/inc/graphics.bi" }],
            compilerFacts: {
                procedureCallingConvention: "cdecl",
                procedureAbiPolicyInputs: [{
                    identity: 1, statement: 1, writtenConvention: false, managedString: true, provisional: false
                }],
                properties: [{ name: "procedure-linkage", value: "c", provisional: false }]
            }
        }
    };
    const byDescEntry = {
        compilerSymbolId: 19,
        declaration: {
            name: "arrayProbe",
            type: "sub",
            signature: "Sub arrayProbe(ByVal values() As Integer)",
            documentation: "@param[in] values The selected array.\nIts descriptor keeps the declared rank.\n@return status",
            parameters: [{
                name: "values",
                label: "ByVal values() As Integer",
                documentation: "Passes the selected array descriptor.\n\nThe selected array.\nIts descriptor keeps the declared rank.",
                compilerParameterPassing: { mode: "bydesc", dimensions: -1, optional: false, receiver: false }
            }]
        }
    };
    const model = {
        remote: true,
        async query(operation, _uri, { position }) {
            assert.equal(operation, "signature");
            const selected = position.line === 0 ? entry : position.line === 1 ? abiEntry : byDescEntry;
            return {
                context: { name: selected.declaration.name, activeParameter: 0 },
                selectedCompilerSymbolId: selected.compilerSymbolId,
                entries: [selected]
            };
        }
    };
    const provider = createSignatureHelpProvider({ SignatureHelp, SignatureInformation, ParameterInformation }, {
        compilerAnalysis: { getModelForEditor: async () => model }
    });

    const help = await provider.provideSignatureHelp(document, {
        line: 0, character: source.split("\n")[0].length - 1
    });
    const abiHelp = await provider.provideSignatureHelp(document, {
        line: 1, character: source.split("\n")[1].length - 1
    });
    assert.match(abiHelp.signatures[0].documentation,
        /Compiler-selected procedure ABI: C linkage, cdecl calling convention, calling convention not written explicitly, FreeBASIC STRING-based type in signature\./);
    assert.match(abiHelp.signatures[0].documentation,
        /Compiler-accepted header linker input: `#inclib "graphics"` from `"graphics\.bi"`\./);
    assert.match(abiHelp.signatures[0].documentation, /Marked deprecated in source documentation\./);
    const byDescHelp = await provider.provideSignatureHelp(document, {
        line: 2, character: source.split("\n")[2].length - 1
    });
    assert.match(byDescHelp.signatures[0].parameters[0].documentation,
        /Compiler-selected parameter passing: ByDesc \(any array rank\)\./);
    assert.match(byDescHelp.signatures[0].parameters[0].documentation,
        /Passes the selected array descriptor\./);
    assert.match(byDescHelp.signatures[0].parameters[0].documentation,
        /The selected array\.\nIts descriptor keeps the declared rank\./);
    assert.doesNotMatch(byDescHelp.signatures[0].parameters[0].documentation, /status/,
        "a following return tag should not be folded into parameter documentation");
    assert.equal(help.signatures[0].label, entry.declaration.signature,
        "the signature label should retain the source declaration rather than inventing an AS clause");
    assert.match(help.signatures[0].documentation, /Compiler-selected implicit return type: `Integer`\./);
    assert.match(help.signatures[0].documentation, /Returns the exact compiler-selected result\./);
});

test("stock compiler sidecar selects one exact source overload only for ambiguous calls", async () => {
    class SignatureHelp { constructor() { this.signatures = []; } }
    class SignatureInformation {
        constructor(label) { this.label = label; this.parameters = []; }
    }
    class ParameterInformation {
        constructor(label) { this.label = label; }
    }
    const source = [
        "Declare Function ConvertOverload Overload(ByVal value As Integer) As Integer",
        "Declare Function ConvertOverload Overload(ByVal value As Double) As Double",
        "Print ConvertOverload(1.0)"
    ].join("\n");
    const document = createDocument(source);
    const filePath = "/workspace/sidecar-signatures.bas";
    document.uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    document.positionAt = (offset) => {
        const prefix = source.slice(0, offset);
        return {
            line: (prefix.match(/\n/g) || []).length,
            character: offset - prefix.lastIndexOf("\n") - 1
        };
    };
    const line0 = source.split("\n")[0];
    const line1 = source.split("\n")[1];
    const declaration = (line, sourceLine, typeName) => {
        const startColumn = sourceLine.indexOf("ConvertOverload");
        return {
            uri: { fsPath: filePath },
            declaration: {
                name: "ConvertOverload", type: "function",
                signature: `Function ConvertOverload(ByVal value As ${typeName}) As ${typeName}`,
                line, startColumn, endColumn: startColumn + "ConvertOverload".length,
                parameters: [{ name: "value", label: `ByVal value As ${typeName}` }]
            }
        };
    };
    const candidates = [declaration(0, line0, "Integer"), declaration(1, line1, "Double")];
    const sourceModel = {
        remote: false,
        resolveAt() { return candidates; }
    };
    const sidecarModel = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "signature");
            return {
                context: { name: "ConvertOverload", activeParameter: 0 },
                entries: [],
                selectedSidecarDeclarations: [{
                    filePath,
                    line: 1,
                    startColumn: candidates[1].declaration.startColumn,
                    endColumn: candidates[1].declaration.endColumn
                }]
            };
        }
    };
    const requests = [];
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => null,
            async getModelForEditor(_document, _token, _needTypes, needBindings) {
                requests.push(Boolean(needBindings));
                return needBindings ? sidecarModel : sourceModel;
            }
        }
    };
    const provider = createSignatureHelpProvider({ SignatureHelp, SignatureInformation, ParameterInformation }, index);
    const help = await provider.provideSignatureHelp(document, {
        line: 2,
        character: source.split("\n")[2].indexOf("ConvertOverload(") + "ConvertOverload(".length
    });

    assert.deepEqual(requests, [false, true],
        "stock FBC binding analysis should be requested only after source resolution finds overloads");
    assert.equal(help.signatures.length, 2, "source candidates should stay visible");
    assert.equal(help.activeSignature, 1, "the selected sidecar declaration should activate the matching source signature");

    requests.length = 0;
    sourceModel.resolveAt = () => [candidates[1]];
    const single = await provider.provideSignatureHelp(document, {
        line: 2,
        character: source.split("\n")[2].indexOf("ConvertOverload(") + "ConvertOverload(".length
    });
    assert.deepEqual(requests, [false], "one source signature should not request sidecar bindings");
    assert.equal(single.activeSignature, 0);
});

test("Inlay Hints render compiler-selected parameter names on positional arguments", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const requests = [];
    const model = {
        remote: true,
        async query(operation) {
            requests.push(operation);
            return {
                types: [],
                parameters: [{
                    position: { line: 0, character: 18 },
                    label: "wholeNumber:",
                    parameterName: "wholeNumber",
                    passingMode: "byref"
                }]
            };
        }
    };
    const index = {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor(_document, _token, needExpressionTypes) {
                assert.equal(needExpressionTypes, true, "parameter hints require compiler-resolved call targets");
                return model;
            }
        },
        getParsedDocument: (document) => parseFreeBasicText(document.getText())
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, index);
    const document = createDocument("Print SelectValue(1, 2.5)\n");
    document.uri = { scheme: "file", fsPath: "/workspace/calls.bas", toString: () => "file:///workspace/calls.bas" };
    const hints = await provider.provideInlayHints(document, {
        start: { line: 0, character: 0 }, end: { line: 0, character: document.lineAt(0).text.length }
    });

    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, "wholeNumber:");
    assert.equal(hints[0].kind, 2);
    assert.equal(hints[0].paddingRight, true);
    assert.equal(hints[0].tooltip, "Compiler-selected parameter: wholeNumber (ByRef).");
    assert.deepEqual(requests, ["compilerInlayHints"]);
});

test("parameter hint labels link only validated physical declaration locations", async () => {
    class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
    class InlayHint { constructor(position, label, kind) { Object.assign(this, { position, label, kind }); } }
    class InlayHintLabelPart { constructor(value) { this.value = value; } }
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    const location = { filePath: "/workspace/api.bi", line: 2, startColumn: 20, endColumn: 31 };
    let declarationLocation = location;
    const model = { remote: true, async query() { return { types: [], parameters: [{
        position: { line: 0, character: 18 }, label: "wholeNumber:", parameterName: "wholeNumber",
        passingMode: "byval", declarationLocation
    }] }; } };
    const index = {
        compilerAnalysis: { getModel: () => null, analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: () => model },
        getParsedDocument: (document) => parseFreeBasicText(document.getText())
    };
    const provider = createInlayHintsProvider({ ...createVscodeMock(), Position, InlayHint, InlayHintLabelPart, Location,
        InlayHintKind: { Type: 1, Parameter: 2 } }, index);
    const document = createDocument("Print SelectValue(1)\n");
    document.uri = { scheme: "file", fsPath: "/workspace/calls.bas", toString: () => "file:///workspace/calls.bas" };
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: document.lineAt(0).text.length } };
    const [hint] = await provider.provideInlayHints(document, range);
    assert.ok(Array.isArray(hint.label));
    assert.equal(hint.label[0].value, "wholeNumber:");
    assert.equal(hint.label[0].location.uri.fsPath, location.filePath);
    assert.deepEqual(hint.label[0].location.range, new Range(2, 20, 2, 31));
    assert.equal(hint.tooltip, "Compiler-selected parameter: wholeNumber (ByVal).");
    for (const invalid of [undefined, { ...location, filePath: "relative.bi" }, { ...location, filePath: "/bad\0path.bi" },
        { ...location, line: -1 }, { ...location, startColumn: 31 }, { ...location, endColumn: 1.5 }]) {
        declarationLocation = invalid;
        assert.equal((await provider.provideInlayHints(document, range))[0].label, "wholeNumber:",
            "unknown or malformed locations must retain the ordinary text hint");
    }
});

test("FBC FOR-entry semantics mark a skipped loop body with an inline hint", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const requests = [];
    const model = {
        remote: true,
        async query(operation, _uri, input) {
            requests.push({ operation, parameterHints: input.parameterHints });
            return {
                types: [],
                parameters: [],
                forEntries: [{
                    position: { line: 0, character: 3 },
                    label: "body skipped",
                    tooltip: "The compiler's initial FOR test fails; the loop body is not entered."
                }]
            };
        }
    };
    const analysisRequests = [];
    const index = {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getSourceSemanticModel: () => ({ resolveAt: () => [{}] }),
        getParsedDocument: (document) => parseFreeBasicText(document.getText())
    };
    const provider = createInlayHintsProvider({ Position, InlayHint }, index);
    const document = createDocument("For loopIndex = 3 To 1\nNext\n");
    document.uri = { scheme: "file", fsPath: "/workspace/loop-entry.bas", toString: () => "file:///workspace/loop-entry.bas" };
    const hints = await provider.provideInlayHints(document, {
        start: { line: 0, character: 0 }, end: { line: 1, character: 4 }
    });

    assert.deepEqual(analysisRequests, [[false, false]],
        "the full compiler model should be requested without expression or binding export modes");
    assert.deepEqual(requests, [{ operation: "compilerInlayHints", parameterHints: false }]);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, "body skipped");
    assert.deepEqual(hints[0].position, new Position(0, 3));
    assert.equal(hints[0].tooltip, "The compiler's initial FOR test fails; the loop body is not entered.");
    assert.equal(hints[0].paddingLeft, true);
});

test("stock FBC sidecar supplies compiler-confirmed skipped-FOR hints", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = "For loopIndex = 3 To 1\nNext\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-for-entry.bas",
        toString: () => "file:///workspace/stock-for-entry.bas" };
    const analysisRequests = [];
    const loopIndexStart = source.indexOf("loopIndex");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            assert.equal(input.parameterHints, false);
            return {
                types: [],
                implicitVariables: [{
                    position: { line: 0, character: loopIndexStart + "loopIndex".length },
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }],
                parameters: [],
                forEntries: [{
                    position: { line: 0, character: 3 },
                    label: "body skipped",
                    tooltip: "FBC confirms that the loop's initial test fails."
                }],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line: 0, character: 0 },
        end: { line: 1, character: document.lineAt(1).text.length }
    });
    assert.deepEqual(analysisRequests, [[false, true]],
        "stock FOR-entry hints should request binding-capable sidecar analysis only for FOR headers");
    assert.equal(hints.length, 2);
    const skipHint = hints.find((hint) => hint.label === "body skipped");
    const typeHint = hints.find((hint) => hint.label === ": Integer");
    assert.ok(skipHint);
    assert.deepEqual(skipHint.position, new Position(0, 3));
    assert.match(skipHint.tooltip, /initial test fails/);
    assert.ok(typeHint);
    assert.deepEqual(typeHint.position, new Position(0, loopIndexStart + "loopIndex".length));
    assert.match(typeHint.tooltip, /compiler-selected type: Integer/);
});

test("constant IF inlays request current compiler facts and refuse dirty stock inputs", async () => {
    class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
    class InlayHint { constructor(position, label) { Object.assign(this, { position, label }); } }
    for (const semanticModelOnly of [true, false]) {
        const document = createDocument("If 0 Then Print 1\n");
        document.uri = { scheme: "file", fsPath: "/workspace/constant-if.bas", toString: () => "file:///workspace/constant-if.bas" };
        const requests = [];
        const model = { remote: true, semanticSidecarOnly: semanticModelOnly, semanticBindingsAvailable: true,
            async query(operation, _uri, input) {
                assert.equal(operation, "compilerInlayHints");
                assert.equal(input.parameterHints, false);
                return { types: [], parameters: [], ifConditions: [{ position: { line: 0, character: 4 },
                    label: "always false", tooltip: "The compiler proves this predicate is always false." }] };
            }
        };
        const provider = createInlayHintsProvider({ Position, InlayHint }, {
            compilerAnalysis: {
                getModel: () => null,
                analysisCompilerFor: () => ({ semanticModelOnly }),
                getModelForEditor(_document, _token, types, bindings) {
                    requests.push([types, bindings]);
                    return model;
                }
            }, getParsedDocument: (current) => parseFreeBasicText(current.getText())
        });
        const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
        const hints = await provider.provideInlayHints(document, range);
        assert.deepEqual(requests, [[false, true]]);
        assert.deepEqual(hints.map((hint) => [hint.position, hint.label]), [[new Position(0, 4), "always false"]]);
        assert.match(hints[0].tooltip, /compiler proves/);
        assert.equal(hints[0].paddingLeft, true);
        for (const source of ["#if 0\nDim value As Long\n#endif\n", "End If\n"]) {
            const nonPredicate = createDocument(source);
            nonPredicate.uri = document.uri;
            assert.deepEqual(await provider.provideInlayHints(nonPredicate, {
                start: { line: 0, character: 0 }, end: { line: 1, character: 0 }
            }), [], "preprocessor directives and closing statements must not request runtime predicate analysis");
            assert.equal(requests.length, 1);
        }
        if (semanticModelOnly) {
            document.isDirty = true;
            assert.deepEqual(await provider.provideInlayHints(document, range), []);
            assert.equal(requests.length, 1, "unsaved stock inputs must not trigger disk-backed analysis");
        }
    }
});

test("FBC control-flow hints mark only compiler-proven unreachable statements", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const analysisRequests = [];
    const model = {
        remote: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            assert.equal(input.parameterHints, false);
            return {
                types: [],
                parameters: [],
                forEntries: [],
                unreachableStatements: [{
                    position: { line: 2, character: 9 },
                    label: "unreachable",
                    tooltip: "The compiler's control-flow graph finds no reachable path to this statement in the selected build."
                }]
            };
        }
    };
    const index = {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (document) => parseFreeBasicText(document.getText())
    };
    const provider = createInlayHintsProvider({ Position, InlayHint }, index);
    const source = [
        "Sub FlowProbe()",
        "    Goto doneLabel",
        "    Print \"unreachable\"",
        "doneLabel:",
        "    Print \"reachable\"",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/flow-inlay.bas", toString: () => "file:///workspace/flow-inlay.bas" };
    const hints = await provider.provideInlayHints(document, {
        start: { line: 2, character: 0 }, end: { line: 2, character: document.lineAt(2).text.length }
    });

    assert.deepEqual(analysisRequests, [[false, false]],
        "unreachable hints use the existing full compiler model without expression or binding upgrade modes");
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, "unreachable");
    assert.deepEqual(hints[0].position, new Position(2, 9));
    assert.match(hints[0].tooltip, /no reachable path/);
});

test("stock FBC sidecar supplies compiler-proven unreachable-code hints", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = [
        "Sub FlowProbe()",
        "    Goto doneLabel",
        "    Print \"unreachable\"",
        "doneLabel:",
        "    Print \"reachable\"",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/stock-flow-inlay.bas",
        toString: () => "file:///workspace/stock-flow-inlay.bas" };
    const analysisRequests = [];
    const unreachablePosition = {
        line: 2,
        character: source.split("\n")[2].indexOf("Print")
    };
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            assert.equal(input.parameterHints, false);
            return {
                types: [],
                parameters: [],
                forEntries: [],
                unreachableStatements: [{
                    position: unreachablePosition,
                    label: "unreachable",
                    tooltip: "The compiler's control-flow graph finds no reachable path to this statement."
                }]
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line: 2, character: 0 },
        end: { line: 2, character: document.lineAt(2).text.length }
    });
    assert.deepEqual(analysisRequests, [[false, true]],
        "stock flow hints should request binding-capable sidecar analysis only for flow-control syntax");
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, "unreachable");
    assert.deepEqual(hints[0].position, new Position(unreachablePosition.line, unreachablePosition.character));
    assert.match(hints[0].tooltip, /no reachable path/);
});

test("stock FBC type Inlay Hints request sidecar expressions for initialized declarations", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        async query(operation) {
            assert.equal(operation, "compilerTypeInlayHints");
            return [{ position: { line: 0, character: 17 }, label: ": Integer", typeName: "Integer" }];
        }
    };
    const requests = [];
    const index = {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (document) => parseFreeBasicText(document.getText())
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, index);
    const document = createDocument("Dim inferredValue = 42\n");
    document.uri = { scheme: "file", fsPath: "/workspace/sidecar-types.bas", toString: () => "file:///workspace/sidecar-types.bas" };
    const hints = await provider.provideInlayHints(document, {
        start: { line: 0, character: 0 }, end: { line: 0, character: document.lineAt(0).text.length }
    });

    assert.deepEqual(requests, [[true, false]],
        "stock sidecar type hints should request expression facts without paying for binding facts");
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, ": Integer");
    assert.equal(hints[0].tooltip, "FreeBASIC compiler-selected type: Integer");
});

test("stock FBC inlays show compiler-selected implicit procedure and parameter types", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = [
        "Function inferredResult()",
        "End Function",
        "Sub inferredParameter(ByVal itemValue)",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-signature-inlays.bas",
        toString: () => "file:///workspace/implicit-signature-inlays.bas" };
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            assert.equal(input.parameterHints, false);
            return {
                types: [],
                parameters: [],
                implicitVariables: [],
                implicitDeclarations: [
                    {
                        position: { line: 0, character: "Function ".length + "inferredResult".length },
                        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                    },
                    {
                        position: { line: 2, character: source.split("\n")[2].indexOf("itemValue") + "itemValue".length },
                        storageType: { primitive: "double", storageBytes: 8, pointerDepth: 0, isReference: false }
                    }
                ]
            };
        }
    };
    const requests = [];
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    });
    const hints = await provider.provideInlayHints(document, {
        start: { line: 0, character: 0 },
        end: { line: 3, character: document.lineAt(3).text.length }
    });

    assert.deepEqual(requests, [[true, true]],
        "implicit signature type hints should use the compiler sidecar's typed binding snapshot");
    assert.deepEqual(hints.map((hint) => [hint.position.line, hint.label]), [
        [0, ": Integer"],
        [2, ": Double"]
    ]);
    assert.ok(hints.every((hint) => hint.tooltip.startsWith("FreeBASIC compiler-selected type:")));
});

test("stock FBC inlays compiler-selected types for implicit INPUT and READ targets", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = [
        'Input "Enter a number: "; inputValue',
        "Data 42",
        "Read readValue",
        "Print inputValue, readValue",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-input-read.bas",
        toString: () => "file:///workspace/implicit-input-read.bas" };
    const inputColumn = source.split("\n")[0].indexOf("inputValue");
    const readColumn = source.split("\n")[2].indexOf("readValue");
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            assert.equal(input.parameterHints, false);
            return {
                types: [],
                parameters: [],
                implicitVariables: [
                    {
                        position: { line: 0, character: inputColumn + "inputValue".length },
                        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                    },
                    {
                        position: { line: 2, character: readColumn + "readValue".length },
                        storageType: { primitive: "long", storageBytes: 4, pointerDepth: 0, isReference: false }
                    }
                ]
            };
        }
    };
    const requests = [];
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });
    const hints = await provider.provideInlayHints(document, {
        start: { line: 0, character: 0 },
        end: { line: 3, character: document.lineAt(3).text.length }
    });

    assert.deepEqual(requests, [[false, true]],
        "stock-sidecar input and read targets should request only compiler binding/type facts");
    assert.deepEqual(hints.map((hint) => [hint.position.line, hint.label]), [
        [0, ": Integer"],
        [2, ": Long"]
    ]);

    const declaredSource = "Dim existingInput As Integer\nInput existingInput\n";
    const declaredDocument = createDocument(declaredSource);
    declaredDocument.uri = { scheme: "file", fsPath: "/workspace/declared-input.bas",
        toString: () => "file:///workspace/declared-input.bas" };
    const sourceModel = {
        resolveAt(_uri, line) { return line === 1 ? [{ name: "existingInput" }] : []; }
    };
    const declaredIndex = {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor() {
                requests.push(["unexpected compiler request"]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => sourceModel
    };
    const declaredHints = await createInlayHintsProvider({ Position, InlayHint, InlayHintKind: { Type: 1 } }, declaredIndex)
        .provideInlayHints(declaredDocument, {
            start: { line: 0, character: 0 },
            end: { line: 1, character: declaredDocument.lineAt(1).text.length }
        });
    assert.deepEqual(declaredHints, [], "a source-declared INPUT target must not get an inferred type inlay");
    assert.deepEqual(requests, [[false, true]],
        "a resolved INPUT target must not start another binding-capable compiler request");
});

test("stock-sidecar inlays a continued INPUT target when only its physical target line is visible", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = [
        '#lang "deprecated"',
        "DefStr C",
        "Sub ContinuedInputProbe()",
        '    Input "Prompt" _',
        "        , continuedInput",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/continued-input.bas",
        toString: () => "file:///workspace/continued-input.bas" };
    const targetLine = 4;
    const targetColumn = source.split("\n")[targetLine].indexOf("continuedInput") + "continuedInput".length;
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "compilerInlayHints");
            return {
                types: [],
                implicitVariables: [{
                    position: { line: targetLine, character: targetColumn },
                    storageType: { primitive: "string", storageBytes: 24, pointerDepth: 0, isReference: false }
                }],
                parameters: [],
                forEntries: [],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line: targetLine, character: 0 },
        end: { line: targetLine, character: document.lineAt(targetLine).text.length }
    });
    assert.deepEqual(requests, [[false, true]],
        "a target on a continuation line must still request its exact sidecar type");
    assert.deepEqual(hints.map((hint) => [hint.position.line, hint.label]), [[targetLine, ": String"]]);
});

test("stock-sidecar inlays the compiler-selected type on an implicit GET destination", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = "Sub GetInlayProbe()\n    Get #1, , implicitGetValue\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/implicit-get-inlay.bas",
        toString: () => "file:///workspace/implicit-get-inlay.bas" };
    const line = source.split("\n")[1];
    const endColumn = line.indexOf("implicitGetValue") + "implicitGetValue".length;
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            requests.push(input.parameterHints);
            return {
                types: [],
                implicitVariables: [{
                    position: { line: 1, character: endColumn },
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }],
                parameters: [],
                forEntries: [],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line: 1, character: 0 },
        end: { line: 1, character: line.length }
    });
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, ": Integer");
    assert.deepEqual(hints[0].position, new Position(1, endColumn));
    assert.deepEqual(requests, [false], "a GET target should use only the compact sidecar type facts");
});

test("stock-sidecar requests implicit-variable facts for FBLite first reads", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = '#lang "fblite"\nPrint implicitFirstRead\n';
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/fblite-first-read.bas",
        toString: () => "file:///workspace/fblite-first-read.bas" };
    const line = document.lineAt(1).text;
    const endColumn = line.indexOf("implicitFirstRead") + "implicitFirstRead".length;
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            return {
                types: [],
                implicitVariables: [{
                    position: { line: 1, character: endColumn },
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }],
                parameters: [],
                forEntries: [],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async (_document, _token, needExpressionTypes, needSemanticBindings) => {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line: 1, character: 0 },
        end: { line: 1, character: line.length }
    });
    assert.deepEqual(requests, [[false, true]],
        "an unresolved identifier in an implicit-variable dialect should request exact declaration bindings");
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, ": Integer");
    assert.deepEqual(hints[0].position, new Position(1, endColumn));
});

test("stock-sidecar requests implicit-variable facts for a masked REM first write", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemImplicitProbe()",
        "    REM = 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/rem-first-write.bas",
        toString: () => "file:///workspace/rem-first-write.bas" };
    const line = document.lineAt(5).text;
    const endColumn = line.indexOf("REM") + "REM".length;
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "compilerInlayHints");
            return {
                types: [],
                implicitVariables: [{
                    position: { line: 5, character: endColumn },
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }],
                parameters: [],
                forEntries: [],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async (_document, _token, needExpressionTypes, needSemanticBindings) => {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });
    const hints = await provider.provideInlayHints(document, {
        start: { line: 5, character: 0 },
        end: { line: 5, character: line.length }
    });

    assert.deepEqual(requests, [[false, true]],
        "the compiler should be queried because the local tokenizer masks the REM target");
    assert.deepEqual(hints.map((hint) => [hint.label, hint.position.line, hint.position.character]), [
        [": Integer", 5, endColumn]
    ]);
});

test("stock-sidecar requests implicit-variable facts for a NOKEYWORD runtime name first write", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = [
        '#lang "deprecated"',
        "Option NoKeyword Abs",
        "Sub AbsImplicitProbe()",
        "    Abs = 1",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/nokeyword-abs-first-write.bas",
        toString: () => "file:///workspace/nokeyword-abs-first-write.bas" };
    const line = document.lineAt(3).text;
    const endColumn = line.indexOf("Abs") + "Abs".length;
    const requests = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation) {
            assert.equal(operation, "compilerInlayHints");
            return {
                types: [],
                implicitVariables: [{
                    position: { line: 3, character: endColumn },
                    storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false }
                }],
                parameters: [],
                forEntries: [],
                unreachableStatements: []
            };
        }
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            contextFor: () => ({ compilerArguments: ["-lang", "deprecated"] }),
            getModelForEditor: async (_document, _token, needExpressionTypes, needSemanticBindings) => {
                requests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });
    const hints = await provider.provideInlayHints(document, {
        start: { line: 3, character: 0 },
        end: { line: 3, character: line.length }
    });

    assert.deepEqual(requests, [[false, true]],
        "a released runtime name used as an implicit first-write should request exact compiler bindings");
    assert.deepEqual(hints.map((hint) => [hint.label, hint.position.line, hint.position.character]), [
        [": Integer", 3, endColumn]
    ]);
});

test("native bridge requests type hints for an unsaved FBLite first-read variable", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = [
        '#lang "fblite"',
        "Sub UnsavedFirstReadProbe()",
        "    Print implicitFirstRead",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/unsaved-fblite-first-read.bas",
        toString: () => "file:///workspace/unsaved-fblite-first-read.bas" };
    document.isDirty = true;
    const line = 2;
    const endColumn = document.lineAt(line).text.indexOf("implicitFirstRead") + "implicitFirstRead".length;
    const analysisRequests = [];
    const model = {
        remote: false,
        semanticSidecarOnly: false,
        compilerTypeInlayHints: () => [{
            position: { line, character: endColumn },
            label: ": Integer",
            typeName: "Integer"
        }]
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModelForEditor: async (_document, _token, needTypes, needBindings) => {
                analysisRequests.push([needTypes, needBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => ({ resolveAt: () => [] })
    });

    const hints = await provider.provideInlayHints(document, {
        start: { line, character: 0 },
        end: { line, character: document.lineAt(line).text.length }
    });
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, ": Integer");
    assert.deepEqual(hints[0].position, new Position(line, endColumn));
    assert.ok(analysisRequests.length > 0,
        "the native bridge should analyze an unsaved first-read local even though it is not a write statement");
});

test("Inlay Hints expose model refresh notifications even before producing hints", async () => {
    const listeners = new Set();
    const onDidChangeModel = (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
    };
    const provider = createInlayHintsProvider({}, {
        onDidChangeModel,
        compilerAnalysis: { getModelForEditor() { assert.fail("a refresh notification must not compile by itself"); } }
    });
    assert.equal(provider.onDidChangeInlayHints, onDidChangeModel,
        "VS Code must retain the empty provider and refresh it after compiler/context changes");
    let refreshes = 0;
    const subscription = provider.onDidChangeInlayHints(() => refreshes++);
    for (const listener of listeners) listener();
    assert.equal(refreshes, 1);
    subscription.dispose();
    for (const listener of listeners) listener();
    assert.equal(refreshes, 1, "the registration owns and disposes its refresh subscription");
});

test("stock FBC Inlay Hints request bindings only for visible calls and render selected names", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const operations = [];
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, _uri, input) {
            operations.push(operation);
            assert.equal(input.parameterHints, true);
            return {
                types: [],
                parameters: [
                    { position: { line: 0, character: 22 }, label: "wholeNumber:", parameterName: "wholeNumber" },
                    { position: { line: 0, character: 25 }, label: "fraction:", parameterName: "fraction" }
                ]
            };
        }
    };
    const analysisRequests = [];
    const index = {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings]);
                return model;
            }
        },
        getParsedDocument: (document) => parseFreeBasicText(document.getText())
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, index);
    const document = createDocument("Print ParameterTarget(7, 2.5)\n");
    document.uri = { scheme: "file", fsPath: "/workspace/sidecar-inlays.bas", toString: () => "file:///workspace/sidecar-inlays.bas" };
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: document.lineAt(0).text.length } };
    const hints = await provider.provideInlayHints(document, range);

    assert.deepEqual(analysisRequests, [[false, true]],
        "stock FBC should request binding facts without the editor bridge or expression tracing");
    assert.deepEqual(operations, ["compilerInlayHints"]);
    assert.deepEqual(hints.map((hint) => hint.label), ["wholeNumber:", "fraction:"]);
    assert.ok(hints.every((hint) => hint.kind === 2 && hint.paddingRight));

    for (const text of [
        "ParameterTarget 7, 2.5\n",
        "ParameterTarget\t7, 2.5\n",
        "Scoped.ParameterTarget 7, 2.5\n",
        "receiver->ParameterTarget 7, 2.5\n",
        "If 1 Then ParameterTarget 7, 2.5 Else ParameterTarget 8, 3.5\n",
        'ParameterTarget "literal only"\n'
    ]) {
        analysisRequests.length = 0;
        operations.length = 0;
        const bare = createDocument(text);
        bare.uri = document.uri;
        const bareHints = await provider.provideInlayHints(bare, {
            start: { line: 0, character: 0 }, end: { line: 0, character: bare.lineAt(0).text.length }
        });
        assert.deepEqual(analysisRequests, [[false, true]], text);
        assert.deepEqual(operations, ["compilerInlayHints"], text);
        assert.equal(bareHints.length, 2, text);
    }

    analysisRequests.length = 0;
    index.getSourceSemanticModel = () => ({ resolveAt: () => [{ declaration: { type: "variable", typeName: "Long" } }] });
    for (const text of ["Dim explicitValue As Long\n", "explicitValue = 7\n", "Print 1, 2\n", "' ParameterTarget 1, 2\n"]) {
        const noCalls = createDocument(text);
        noCalls.uri = { scheme: "file", fsPath: "/workspace/no-sidecar-inlays.bas", toString: () => "file:///workspace/no-sidecar-inlays.bas" };
        assert.deepEqual(await provider.provideInlayHints(noCalls, {
            start: { line: 0, character: 0 }, end: { line: 0, character: noCalls.lineAt(0).text.length }
        }), [], text);
    }
    assert.deepEqual(analysisRequests, [], "a range with no calls should not start a sidecar binding pass");
});

test("native parameter hints request receiver facts only for visible member calls", async () => {
    for (const cached of [false, true]) {
        for (const [text, bindings] of [
            ["ParameterTarget 7, 2.5", false],
            ["receiver.ParameterTarget 7, 2.5", true],
            ["receiver->ParameterTarget(7, 2.5)", true],
            ['receiver.ParameterTarget "literal only"', true]
        ]) {
            const requests = [];
            const model = {
                remote: true, semanticSidecarOnly: false,
                query: async () => ({ types: [], parameters: [] })
            };
            const document = createDocument(text);
            document.uri = { scheme: "file", fsPath: "/workspace/native-inlays.bas", toString: () => "file:///workspace/native-inlays.bas" };
            const provider = createInlayHintsProvider({}, {
                compilerAnalysis: {
                    getModel: () => cached ? model : null,
                    analysisCompilerFor: () => ({ semanticModelOnly: false }),
                    getModelForEditor(_document, _token, expressions, needBindings) {
                        requests.push([expressions, needBindings]);
                        return model;
                    }
                },
                getParsedDocument: (current) => parseFreeBasicText(current.getText())
            });
            assert.deepEqual(await provider.provideInlayHints(document, {
                start: { line: 0, character: 0 }, end: { line: 0, character: text.length }
            }), []);
            assert.deepEqual(requests, [[true, bindings]], `${cached ? "cached" : "cold"}: ${text}`);
        }
    }
});

test("stock FBC Inlay Hints request full macro facts only for source macro calls", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const source = [
        "#define InlayHintMacro(firstValue, secondValue) firstValue",
        "Print InlayHintMacro(1, 2)",
        "#if InlayHintMacro(3, 4)",
        "#endif",
        "#assert InlayHintMacro(5, 6)",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/macro-inlay-hints.bas",
        toString: () => "file:///workspace/macro-inlay-hints.bas" };
    const callLine = document.lineAt(1).text;
    const firstArgument = callLine.indexOf("1, 2") + 0;
    const secondArgument = callLine.indexOf("2)");
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(source)
    }]);
    const analysisRequests = [];
    const compactModel = {
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        semanticMacroBindingsAvailable: false
    };
    const model = {
        remote: true,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        semanticMacroBindingsAvailable: true,
        async query(operation, _uri, input) {
            assert.equal(operation, "compilerInlayHints");
            assert.equal(input.parameterHints, true);
            const evaluationLine = input.position.line;
            const evaluationCall = evaluationLine === 2 || evaluationLine === 4;
            return {
                types: [],
                parameters: evaluationCall
                    ? [
                        {
                            position: {
                                line: evaluationLine,
                                character: (evaluationLine === 2 ? "#if InlayHintMacro(" : "#assert InlayHintMacro(").length
                            },
                            label: "firstValue:", parameterName: "firstValue"
                        },
                        {
                            position: {
                                line: evaluationLine,
                                character: (evaluationLine === 2 ? "#if InlayHintMacro(3, " : "#assert InlayHintMacro(5, ").length
                            },
                            label: "secondValue:", parameterName: "secondValue"
                        }
                    ]
                    : [
                        { position: { line: 1, character: firstArgument }, label: "firstValue:", parameterName: "firstValue" },
                        { position: { line: 1, character: secondArgument }, label: "secondValue:", parameterName: "secondValue" }
                    ]
            };
        }
    };
    const index = {
        compilerAnalysis: {
            getModel: () => compactModel,
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor(_document, _token, needExpressionTypes, needSemanticBindings, needSemanticMacroBindings) {
                analysisRequests.push([needExpressionTypes, needSemanticBindings, needSemanticMacroBindings]);
                return model;
            }
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => sourceModel
    };
    const provider = createInlayHintsProvider({
        Position,
        InlayHint,
        InlayHintKind: { Type: 1, Parameter: 2 }
    }, index);
    const hints = await provider.provideInlayHints(document, {
        start: { line: 0, character: 0 }, end: { line: 1, character: callLine.length }
    });

    assert.deepEqual(analysisRequests, [[true, true, true]],
        "source macro calls need full macro facts and retain possible macro-introduced type hints");
    assert.deepEqual(hints.map((hint) => hint.label), ["firstValue:", "secondValue:"]);

    const conditionalHints = await provider.provideInlayHints(document, {
        start: { line: 2, character: 0 }, end: { line: 2, character: document.lineAt(2).text.length }
    });
    assert.deepEqual(analysisRequests, [[true, true, true], [true, true, true]],
        "compiler macro calls in #if expressions must request their selected signature facts");
    assert.deepEqual(conditionalHints.map((hint) => hint.label), ["firstValue:", "secondValue:"]);

    const assertionHints = await provider.provideInlayHints(document, {
        start: { line: 4, character: 0 }, end: { line: 4, character: document.lineAt(4).text.length }
    });
    assert.deepEqual(analysisRequests, [[true, true, true], [true, true, true], [true, true, true]],
        "compiler macro calls in #assert expressions must request their selected signature facts");
    assert.deepEqual(assertionHints.map((hint) => hint.label), ["firstValue:", "secondValue:"]);
});

test("Inlay Hints skip on-demand compiler analysis for ranges with no hintable declarations", async () => {
    const requests = [];
    const model = {
        remote: true,
        async query(operation) {
            requests.push(operation);
            return [];
        }
    };
    const index = {
        compilerAnalysis: {
            getModel: () => null,
            getModelForEditor() {
                requests.push("analysis");
                return model;
            }
        },
        getParsedDocument: (document) => parseFreeBasicText(document.getText())
    };
    const provider = createInlayHintsProvider({}, index);
    const explicit = createDocument("Dim explicitValue As Long\n");
    explicit.uri = { scheme: "file", fsPath: "/workspace/explicit.bas", toString: () => "file:///workspace/explicit.bas" };
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } };

    assert.deepEqual(await provider.provideInlayHints(explicit, range), []);
    assert.deepEqual(requests, [], "explicit declarations should not start analysis for hints that cannot appear");

    const implicit = createDocument("Dim inferredValue\n");
    implicit.uri = { scheme: "file", fsPath: "/workspace/implicit.bas", toString: () => "file:///workspace/implicit.bas" };
    assert.deepEqual(await provider.provideInlayHints(implicit, range), []);
    assert.deepEqual(requests, ["analysis", "compilerTypeInlayHints"],
        "a potentially hintable declaration should retain the compiler-owned hint query");

    const included = createDocument('#include once "types.bi"\n');
    included.uri = { scheme: "file", fsPath: "/workspace/included.bas", toString: () => "file:///workspace/included.bas" };
    assert.deepEqual(await provider.provideInlayHints(included, range), []);
    assert.deepEqual(requests, [
        "analysis", "compilerTypeInlayHints", "analysis", "compilerTypeInlayHints"
    ], "includes must bypass the source-only prefilter because expansion can introduce declarations");
});

test("native inlay hints combine implicit variable types with compiler loop results", async () => {
    class InlayHint {
        constructor(position, label, kind) { Object.assign(this, { position, label, kind }); }
    }
    const requests = [];
    const model = {
        semanticSidecarOnly: false,
        remote: true,
        async query(operation) {
            requests.push(operation);
            return operation === "compilerInlayHints"
                ? { types: [], parameters: [], forEntries: [], unreachableStatements: [] }
                : [];
        }
    };
    const sourceModel = {
        resolveAt(uri) {
            return /explicit-(?:loop|assignment|input)\.bas$/.test(uri.fsPath)
                ? [{ declaration: { type: "variable" } }]
                : [];
        }
    };
    const index = {
        compilerAnalysis: {
            getModel: () => null,
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            async getModelForEditor() {
                requests.push("analysis");
                return model;
            }
        },
        getParsedDocument: (document) => parseFreeBasicText(document.getText()),
        getSourceSemanticModel: () => sourceModel
    };
    const provider = createInlayHintsProvider({ InlayHint, InlayHintKind: { Type: 1 } }, index);
    const implicit = createDocument("For implicitCounter = 1 To 2\nNext\n");
    implicit.uri = { scheme: "file", fsPath: "/workspace/implicit-loop.bas", toString: () => "file:///workspace/implicit-loop.bas" };

    assert.deepEqual(await provider.provideInlayHints(implicit, {
        start: { line: 0, character: 0 }, end: { line: 0, character: implicit.lineAt(0).text.length }
    }), []);
    assert.deepEqual(requests, ["analysis", "compilerInlayHints"],
        "the loop counter type and compiler-confirmed entry result share the native inlay query");

    const explicit = createDocument("Dim explicitCounter As Long\nFor explicitCounter = 1 To 2\nNext\n");
    explicit.uri = { scheme: "file", fsPath: "/workspace/explicit-loop.bas", toString: () => "file:///workspace/explicit-loop.bas" };
    assert.deepEqual(await provider.provideInlayHints(explicit, {
        start: { line: 1, character: 0 }, end: { line: 1, character: explicit.lineAt(1).text.length }
    }), []);
    assert.deepEqual(requests, [
        "analysis", "compilerInlayHints", "analysis", "compilerInlayHints"
    ], "a declared counter still needs analysis for the compiler-confirmed loop entry result");

    const implicitAssignment = createDocument("implicitValue = 1\n");
    implicitAssignment.uri = { scheme: "file", fsPath: "/workspace/implicit-assignment.bas", toString: () => "file:///workspace/implicit-assignment.bas" };
    assert.deepEqual(await provider.provideInlayHints(implicitAssignment, {
        start: { line: 0, character: 0 }, end: { line: 0, character: implicitAssignment.lineAt(0).text.length }
    }), []);
    assert.deepEqual(requests, [
        "analysis", "compilerInlayHints", "analysis", "compilerInlayHints",
        "analysis", "compilerTypeInlayHints"
    ],
        "an unresolved first-use assignment should request the compiler-selected variable type");

    const explicitAssignment = createDocument("Dim existingValue As Long\nexistingValue = 1\n");
    explicitAssignment.uri = { scheme: "file", fsPath: "/workspace/explicit-assignment.bas", toString: () => "file:///workspace/explicit-assignment.bas" };
    assert.deepEqual(await provider.provideInlayHints(explicitAssignment, {
        start: { line: 1, character: 0 }, end: { line: 1, character: explicitAssignment.lineAt(1).text.length }
    }), []);
    assert.deepEqual(requests, [
        "analysis", "compilerInlayHints", "analysis", "compilerInlayHints",
        "analysis", "compilerTypeInlayHints"
    ],
        "a source-resolved assignment target should keep the analysis fast path");

    const implicitInput = createDocument("Input #1, inputValue\nInput \"Enter value: \"; promptedValue\nData 7\nRead readValue\n");
    implicitInput.uri = { scheme: "file", fsPath: "/workspace/implicit-input.bas", toString: () => "file:///workspace/implicit-input.bas" };
    assert.deepEqual(await provider.provideInlayHints(implicitInput, {
        start: { line: 0, character: 0 }, end: { line: 3, character: implicitInput.lineAt(3).text.length }
    }), []);
    assert.deepEqual(requests, [
        "analysis", "compilerInlayHints", "analysis", "compilerInlayHints",
        "analysis", "compilerTypeInlayHints",
        "analysis", "compilerTypeInlayHints"
    ], "INPUT and READ targets can receive compiler-selected types when they are implicit");

    const explicitInput = createDocument("Dim inputValue As Integer\nInput #1, inputValue\nData 7\nRead inputValue\n");
    explicitInput.uri = { scheme: "file", fsPath: "/workspace/explicit-input.bas", toString: () => "file:///workspace/explicit-input.bas" };
    assert.deepEqual(await provider.provideInlayHints(explicitInput, {
        start: { line: 1, character: 0 }, end: { line: 3, character: explicitInput.lineAt(3).text.length }
    }), []);
    assert.deepEqual(requests, [
        "analysis", "compilerInlayHints", "analysis", "compilerInlayHints",
        "analysis", "compilerTypeInlayHints",
        "analysis", "compilerTypeInlayHints"
    ], "source-resolved INPUT/READ targets should avoid redundant compiler work");
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

test("include completions retain valid quoted operands and repair incomplete or C-style delimiters", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-include-completion-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourceDirectory = path.join(directory, "source");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(path.join(sourceDirectory, "headers"));
    fs.writeFileSync(path.join(sourceDirectory, "alpha.bi"), "");
    fs.writeFileSync(path.join(sourceDirectory, "headers", "alpha.bi"), "");
    fs.writeFileSync(path.join(sourceDirectory, "alpha.txt"), "");
    if (process.platform !== "win32") {
        for (const name of ['alpha"broken.bi', "alpha\nbroken.bi", "alpha\\broken.bi"]) {
            fs.writeFileSync(path.join(sourceDirectory, name), "");
        }
    }
    const vscode = {
        ...createVscodeMock(),
        CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
        CompletionItemKind: { File: 17, Folder: 18 },
        TextEdit: { replace: (range, newText) => ({ range, newText }) }
    };
    vscode.workspace.getWorkspaceFolder = () => ({ uri: { fsPath: directory } });
    const provider = createCompletionProvider(vscode, {}, {});
    const applyCompletion = (source, item) => {
        const edits = [{ range: item.range, newText: item.insertText }, ...(item.additionalTextEdits || [])]
            .sort((first, second) => second.range.start.character - first.range.start.character);
        for (const edit of edits) source = source.slice(0, edit.range.start.character) + edit.newText + source.slice(edit.range.end.character);
        return source;
    };
    for (const [input, expected] of [
        ['#include once "al|"', '#include once "alpha.bi"'],
        ['#include "al|', '#include "alpha.bi"'],
        ['#include <al|>', '#include "alpha.bi"'],
        ['#include <al|', '#include "alpha.bi"'],
        ['#include <al|pha.bi> \' keep comment', '#include "alpha.bi" \' keep comment'],
        ['#include "headers/al|"', '#include "headers/alpha.bi"'],
        ['#include <headers/al|>', '#include "headers/alpha.bi"'],
        ['#include "al|>', '#include "alpha.bi"']
    ]) {
        const source = input.replace("|", "");
        const document = createDocument(source);
        document.uri = { scheme: "file", fsPath: path.join(sourceDirectory, "main.bas") };
        document.version = 1;
        const items = await provider.provideCompletionItems(document, { line: 0, character: input.indexOf("|") });
        assert.equal(items.length, 1, `only the literal-safe matching header should be offered for ${input}`);
        assert.equal(applyCompletion(source, items[0]), expected, input);
    }
    for (const input of ['#include "hea|', '#include <hea|>']) {
        const source = input.replace("|", "");
        const document = createDocument(source);
        document.uri = { scheme: "file", fsPath: path.join(sourceDirectory, "main.bas") };
        const items = await provider.provideCompletionItems(document, { line: 0, character: input.indexOf("|") });
        const folder = items.find((item) => item.kind === vscode.CompletionItemKind.Folder);
        assert.ok(folder);
        assert.equal(applyCompletion(source, folder), input.includes(">") ? '#include "headers/"' : '#include "headers/');
        assert.equal(folder.command.command, "editor.action.triggerSuggest");
    }
});

test("compiler FOR/NEXT mismatch offers removal and only an exact active-counter correction", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        constructor() { this.deletions = []; this.replacements = []; }
        delete(uri, range) { this.deletions.push({ uri, range }); }
        insert(uri, position, newText) { this.insertion = { uri, position, newText }; }
        replace(uri, range, newText) { this.replacements.push({ uri, range, newText }); }
    }
    const vscode = {
        ...createVscodeMock(),
        Position,
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const uri = { scheme: "file", fsPath: "/workspace/loops.bas", toString: () => "file:///workspace/loops.bas" };
    const text = "For outer = 1 To 2\n    Next inner\n";
    const lines = text.split("\n");
    const document = {
        uri,
        version: 1,
        getText: () => text,
        lineAt: (line) => ({ text: lines[line] })
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const diagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Error,
        message: "FOR/NEXT variable name mismatch\n\nCompiler context: FOR/NEXT counter mismatch",
        range: new Range(1, 0, 1, lines[1].length)
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Remove mismatched 'inner' after NEXT");
    assert.deepEqual(actions[0].edit.deletions[0].range, new Range(1, 9, 1, 14));

    const typoText = "For outer = 1 To 2\n    For inner = 1 To 2\n        Next inenr\n";
    const typoLines = typoText.split("\n");
    const typoLineOffsets = [0];
    for (const lineText of typoLines.slice(0, -1)) typoLineOffsets.push(typoLineOffsets.at(-1) + lineText.length + 1);
    const typoDocument = {
        ...document,
        getText: () => typoText,
        lineAt: (line) => ({ text: typoLines[line] }),
        offsetAt: (position) => typoLineOffsets[position.line] + position.character
    };
    const typoWorkspaceIndex = {
        getParsedDocument: (target) => parseFreeBasicText(target.getText()),
        async ensureInitialized() { return true; },
        isIncomplete() { return false; },
        getSemanticModel() {
            return {
                visibleEntries: () => [{
                    name: "outer",
                    declaration: { name: "outer", type: "variable" }
                }, {
                    name: "inner",
                    declaration: { name: "inner", type: "variable" }
                }]
            };
        }
    };
    const typoProvider = createMissingHeaderCodeActionProvider(vscode, typoWorkspaceIndex);
    const typoActions = await typoProvider.provideCodeActions(typoDocument, null, {
        diagnostics: [{ ...diagnostic, range: new Range(2, 13, 2, 18) }]
    });
    const correction = typoActions.find((action) => action.title === 'Fix typo: replace "inenr" with "inner"');
    assert.ok(correction, "a unique one-edit correction to the active nested FOR counter should be offered");
    assert.equal(correction.edit.replacements[0].newText, "inner");
    assert.deepEqual(correction.edit.replacements[0].range, new Range(2, 13, 2, 18));

    const multiTypoText = "For outer = 1 To 2\n    For inner = 1 To 2\n        Next inenr, outer\n";
    const multiTypoLines = multiTypoText.split("\n");
    const multiTypoLineOffsets = [0];
    for (const lineText of multiTypoLines.slice(0, -1)) {
        multiTypoLineOffsets.push(multiTypoLineOffsets.at(-1) + lineText.length + 1);
    }
    const multiTypoDocument = {
        ...typoDocument,
        getText: () => multiTypoText,
        lineAt: (line) => ({ text: multiTypoLines[line] }),
        offsetAt: (position) => multiTypoLineOffsets[position.line] + position.character
    };
    const multiTypoActions = await typoProvider.provideCodeActions(multiTypoDocument, null, {
        diagnostics: [{ ...diagnostic, range: new Range(2, 13, 2, 18) }]
    });
    const multiTypoCorrection = multiTypoActions.find((action) =>
        action.title === 'Fix typo: replace "inenr" with "inner"');
    assert.ok(multiTypoCorrection,
        "a compiler-pointed typo in a multi-counter NEXT should correct only the matching counter");
    assert.deepEqual(multiTypoCorrection.edit.replacements[0], {
        uri,
        range: new Range(2, 13, 2, 18),
        newText: "inner"
    });
    const unresolvedMultiActions = await typoProvider.provideCodeActions(multiTypoDocument, null, {
        diagnostics: [{
            source: "fbc (buffer)",
            severity: vscode.DiagnosticSeverity.Error,
            message: "Variable not declared, inenr\n\nCompiler context: Optional NEXT counter name must refer to a declared variable",
            range: new Range(2, 13, 2, 18)
        }]
    });
    const unresolvedMultiCorrection = unresolvedMultiActions.find((action) =>
        action.title === 'Fix typo: replace "inenr" with "inner"');
    assert.ok(unresolvedMultiCorrection,
        "a compiler-unresolved typo in a multi-counter NEXT should use the same exact counter check");
    assert.deepEqual(unresolvedMultiCorrection.edit.replacements[0], {
        uri,
        range: new Range(2, 13, 2, 18),
        newText: "inner"
    });
    const multipleTyposText = "For outer = 1 To 2\n    For inner = 1 To 2\n        Next inenr, outre\n";
    const multipleTyposLines = multipleTyposText.split("\n");
    const multipleTyposDocument = {
        ...multiTypoDocument,
        getText: () => multipleTyposText,
        lineAt: (line) => ({ text: multipleTyposLines[line] })
    };
    assert.deepEqual(await typoProvider.provideCodeActions(multipleTyposDocument, null, {
        diagnostics: [{ ...diagnostic, range: new Range(2, 13, 2, 18) }]
    }), [], "a multi-counter statement with more than one mismatch must not receive a speculative edit");

    const conditionalText = "#if ENABLED\nFor outer = 1 To 2\nNext ouetr\n#endif\n";
    const conditionalLines = conditionalText.split("\n");
    const conditionalDocument = {
        ...document,
        getText: () => conditionalText,
        lineAt: (line) => ({ text: conditionalLines[line] })
    };
    const conditionalActions = await typoProvider.provideCodeActions(conditionalDocument, null, {
        diagnostics: [{ ...diagnostic, range: new Range(2, 5, 2, 10) }]
    });
    assert.equal(conditionalActions.length, 1);
    assert.equal(conditionalActions[0].title, "Remove mismatched 'ouetr' after NEXT",
        "conditional branches do not provide a unique source-only counter correction");

    const ambiguousText = "For outer = 1 To 2\n    Next inner, outer\n";
    const ambiguousDocument = {
        ...document,
        getText: () => ambiguousText,
        lineAt: (line) => ({ text: ambiguousText.split("\n")[line] })
    };
    assert.deepEqual(await provider.provideCodeActions(ambiguousDocument, null, {
        diagnostics: [{ ...diagnostic, range: new Range(1, 0, 1, ambiguousText.split("\n")[1].length) }]
    }), [], "multi-counter NEXT statements must not receive a speculative edit");
    assert.deepEqual(await provider.provideCodeActions(document, null, {
        diagnostics: [{ ...diagnostic, message: "FOR/NEXT variable name mismatch" }]
    }), [], "the fix requires FBC's semantic diagnostic context");

    const warningText = "For index = 1 To 2\nNext index\n";
    const warningLines = warningText.split("\n");
    const warningDocument = { ...document, getText: () => warningText, lineAt: (line) => ({ text: warningLines[line] }) };
    const warning = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Variable following NEXT is meaningless, index",
        range: new Range(1, 5, 1, 10)
    };
    const warningActions = await provider.provideCodeActions(warningDocument, null, { diagnostics: [warning] });
    assert.equal(warningActions.length, 1);
    assert.equal(warningActions[0].title, "Remove meaningless 'index' after NEXT");

    const multiWarningText = "For outer = 1 To 2\n    For inner = 1 To 2\n    Next inner, outer ' retain this note\n";
    const multiWarningLines = multiWarningText.split("\n");
    const multiWarningDocument = {
        ...document,
        getText: () => multiWarningText,
        lineAt: (line) => ({ text: multiWarningLines[line] })
    };
    const multiWarning = {
        ...warning,
        message: "Variable following NEXT is meaningless, outer",
        range: new Range(2, 16, 2, 21)
    };
    const multiWarningActions = await provider.provideCodeActions(multiWarningDocument, null, {
        diagnostics: [multiWarning]
    });
    assert.equal(multiWarningActions.length, 1);
    assert.equal(multiWarningActions[0].title,
        "Split NEXT counters into separate statements and remove redundant names");
    assert.deepEqual(multiWarningActions[0].edit.replacements[0], {
        uri,
        range: new Range(2, 0, 2, multiWarningLines[2].length),
        newText: "    Next\n    Next ' retain this note"
    });

    const mismatchError = {
        ...diagnostic,
        range: new Range(1, 9, 1, 14)
    };
    const mismatchWarning = {
        ...warning,
        message: "Variable following NEXT is meaningless, inner",
        range: new Range(1, 9, 1, 14)
    };
    const mismatchText = "For outer = 1 To 2\n    Next inner\n";
    const mismatchLines = mismatchText.split("\n");
    const mismatchDocument = {
        ...document,
        getText: () => mismatchText,
        lineAt: (line) => ({ text: mismatchLines[line] })
    };
    const mismatchActions = await provider.provideCodeActions(mismatchDocument, null, {
        diagnostics: [mismatchWarning, mismatchError]
    });
    assert.deepEqual(mismatchActions.map((action) => action.title), ["Remove mismatched 'inner' after NEXT"],
        "a redundant-name warning must not hide a compiler error on the same NEXT line");

    const unresolvedText = "For outer = 1 To 2\nNext missing\n";
    const unresolvedLines = unresolvedText.split("\n");
    const unresolvedDocument = { ...document, getText: () => unresolvedText, lineAt: (line) => ({ text: unresolvedLines[line] }) };
    const unresolvedDiagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Error,
        message: "Variable not declared, missing\n\nCompiler context: Optional NEXT counter name must refer to a declared variable",
        range: new Range(1, 5, 1, 6)
    };
    const unresolvedActions = await provider.provideCodeActions(unresolvedDocument, null, { diagnostics: [unresolvedDiagnostic] });
    assert.equal(unresolvedActions.length, 1);
    assert.equal(unresolvedActions[0].title, "Remove undeclared 'missing' after NEXT");

    const unresolvedWithoutContext = {
        ...unresolvedDocument,
        uri: { scheme: "untitled", toString: () => "untitled:loops" }
    };
    assert.deepEqual(await provider.provideCodeActions(unresolvedWithoutContext, null, {
        diagnostics: [{ ...unresolvedDiagnostic, message: "Variable not declared, missing" }]
    }), [], "the removal fix requires FBC's exact NEXT-binding context");
});

test("compiler-confirmed unsupported ON ERROR RESUME NEXT offers standalone removal", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        constructor() { this.replacements = []; }
        replace(uri, range, newText) { this.replacements.push({ uri, range, newText }); }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const source = "On Error Resume Next ' keep this note\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/resume-next.bas", toString: () => "file:///workspace/resume-next.bas" };
    document.version = 1;
    const diagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Error,
        compilerContext: "error-resume-next-syntax",
        sourceText: "On Error Resume Next",
        physicalPoint: { line: 0, character: 0 },
        message: "ON ERROR RESUME NEXT is unsupported\n\nCompiler context: ON ERROR RESUME NEXT is unsupported by FreeBASIC",
        range: new Range(0, 0, 0, "On Error Resume Next".length)
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Remove unsupported 'ON ERROR RESUME NEXT' statement");
    assert.deepEqual(actions[0].edit.replacements, [{
        uri: document.uri,
        range: new Range(0, 0, 0, "On Error Resume Next".length),
        newText: ""
    }]);

    for (const inlineSource of [
        "Print 1 : On Error Resume Next\n",
        "On Error Resume Next : Print 2\n"
    ]) {
        const inlineDocument = createDocument(inlineSource);
        inlineDocument.uri = document.uri;
        inlineDocument.version = 1;
        const startCharacter = inlineSource.indexOf("On Error Resume Next");
        assert.deepEqual(await provider.provideCodeActions(inlineDocument, null, {
            diagnostics: [{
                ...diagnostic,
                sourceText: inlineSource.trim(),
                physicalPoint: { line: 0, character: startCharacter },
                range: new Range(0, startCharacter, 0, startCharacter + "On Error Resume Next".length)
            }]
        }), [], "mixed statement lines must not receive a line-removal fix");
    }
});

test("compiler case-collision context removes only a redundant same-type DIM line", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        delete(uri, range) { this.deletion = { uri, range }; }
        insert(uri, position, text) { this.insertions = [{ uri, position, text }]; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const uri = { scheme: "file", fsPath: "/workspace/case-collision.bas", toString: () => "file:///workspace/case-collision.bas" };
    const makeDocument = (text) => ({
        uri,
        version: 1,
        getText: () => text,
        lineAt: (line) => ({ text: text.split(/\r\n|\n|\r/)[line] })
    });
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const diagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Error,
        message: "Duplicated definition, value\n\nCompiler context: This variable name differs only by case from an existing declaration",
        range: new Range(1, 4, 1, 9)
    };
    const source = "Dim Value As Integer\nDim value As Integer\n";
    const actions = await provider.provideCodeActions(makeDocument(source), null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Remove duplicate declaration of 'value'");
    assert.deepEqual(actions[0].edit.deletion.range, new Range(1, 0, 2, 0));

    const duplicateWithoutContext = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Error,
        message: "Duplicated definition, value",
        range: new Range(1, 4, 1, 9)
    };
    const fallbackActions = await provider.provideCodeActions(makeDocument(source), null, {
        diagnostics: [duplicateWithoutContext]
    });
    assert.equal(fallbackActions.length, 1,
        "an exact FBC duplicate-definition diagnostic can use the same strict source proof when its context is absent");
    assert.deepEqual(await provider.provideCodeActions(makeDocument(source), null, {
        diagnostics: [{ ...duplicateWithoutContext, message: "Syntax error, value" }]
    }), [], "other compiler errors must not authorize the duplicate-declaration fix");
    assert.deepEqual(await provider.provideCodeActions(makeDocument(source), null, {
        diagnostics: [{ ...duplicateWithoutContext, source: "third-party linter" }]
    }), [], "the fallback is reserved for FBC's exact duplicate-definition diagnostic");

    const initialized = "Dim Value As Integer\nDim value As Integer = 1\n";
    assert.deepEqual(await provider.provideCodeActions(makeDocument(initialized), null, {
        diagnostics: [diagnostic]
    }), [], "an initializer can have side effects and must not be deleted");
    const mismatchedType = "Dim Value As Integer\nDim value As Double\n";
    assert.deepEqual(await provider.provideCodeActions(makeDocument(mismatchedType), null, {
        diagnostics: [diagnostic]
    }), [], "different declared types leave the intended declaration ambiguous");
    const implicitSameType = "Dim Value\nDim value\n";
    assert.equal((await provider.provideCodeActions(makeDocument(implicitSameType), null, {
        diagnostics: [{ ...diagnostic, range: new Range(1, 4, 1, 9) }]
    })).length, 1, "case-identical implicit names use the same default dialect type");
    const changedDefaultType = "Dim Value\nDefStr V-Z\nDim value\n";
    assert.deepEqual(await provider.provideCodeActions(makeDocument(changedDefaultType), null, {
        diagnostics: [{ ...diagnostic, range: new Range(2, 4, 2, 9) }]
    }), [], "an intervening DEF type rule makes two untyped declarations ambiguous");
    const separateScopes = "Sub First()\n    Dim Value As Integer\nEnd Sub\nSub Second()\n    Dim value As Integer\nEnd Sub\n";
    assert.deepEqual(await provider.provideCodeActions(makeDocument(separateScopes), null, {
        diagnostics: [{ ...diagnostic, range: new Range(4, 4, 4, 9) }]
    }), [], "same-spelled variables in different procedure scopes are not duplicates");
});

test("compiler suffix-AS context offers removal of only the conflicting type suffix", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        delete(uri, range) { this.deletion = { uri, range }; }
        insert(uri, position, text) { this.insertions = [{ uri, position, text }]; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const uri = { scheme: "file", fsPath: "/workspace/suffix-conflict.bas", toString: () => "file:///workspace/suffix-conflict.bas" };
    const text = "Dim AS Integer firstValue, secondValue$\n";
    const lines = text.split("\n");
    const document = { uri, version: 1, getText: () => text, lineAt: (line) => ({ text: lines[line] }) };
    const nameStart = text.indexOf("secondValue");
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const diagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Error,
        message: "Syntax error, secondValue\n\nCompiler context: A type suffix and AS clause cannot both specify this declaration's type",
        range: new Range(0, nameStart, 0, nameStart + "secondValue$".length)
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Remove '$' suffix from 'secondValue$' to use the DIM AS type");
    assert.deepEqual(actions[0].edit.deletion.range, new Range(0, nameStart + "secondValue".length, 0, nameStart + "secondValue$".length));
});

test("compiler Suffix ignored warning offers removal for an exact AS-typed declaration", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const uri = { scheme: "file", fsPath: "/workspace/ignored-suffix.bas", toString: () => "file:///workspace/ignored-suffix.bas" };
    const text = "Dim value% As Integer\n";
    const document = { uri, version: 1, getText: () => text, lineAt: () => ({ text: "Dim value% As Integer" }) };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const diagnostic = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Suffix ignored\n\nin 'value%'",
        range: new Range(0, 4, 0, 10)
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Remove ignored '%' suffix from 'value%' (use the AS type)");
    assert.deepEqual(actions[0].edit.deletion.range, new Range(0, 9, 0, 10));

    const multiple = "Dim value% As Integer, other As Integer\n";
    const multipleActions = await provider.provideCodeActions({
        ...document,
        getText: () => multiple,
        lineAt: () => ({ text: multiple.trimEnd() })
    }, null, { diagnostics: [diagnostic] });
    assert.equal(multipleActions.length, 1,
        "the compiler-reported suffix can be fixed when exactly one matching declarator exists");
    assert.deepEqual(multipleActions[0].edit.deletion.range, new Range(0, 9, 0, 10));

    const parameterSource = "Sub Consume(value% As Integer, otherValue As String)\nEnd Sub\n";
    const parameterDocument = {
        ...document,
        getText: () => parameterSource,
        lineAt: (line) => ({ text: parameterSource.split("\n")[line] })
    };
    const parameterStart = parameterSource.indexOf("value%");
    const parameterActions = await provider.provideCodeActions(parameterDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Suffix ignored\n\nin 'value%'",
            range: new Range(0, parameterStart, 0, parameterStart + "value%".length)
        }]
    });
    assert.equal(parameterActions.length, 1);
    assert.equal(parameterActions[0].title, "Remove ignored '%' suffix from 'value%' (use the AS type)");
    assert.deepEqual(parameterActions[0].edit.deletion.range,
        new Range(0, parameterStart + "value".length, 0, parameterStart + "value%".length));

    const continuedParameterSource = [
        "Sub ContinuedConsume( _",
        "    ByVal continuedValue% As Integer, _",
        "    otherValue As String _",
        ")",
        "End Sub",
        ""
    ].join("\n");
    const continuedParameterDocument = {
        ...document,
        getText: () => continuedParameterSource,
        lineAt: (line) => ({ text: continuedParameterSource.split("\n")[line] })
    };
    const continuedParameterStart = continuedParameterSource.split("\n")[1].indexOf("continuedValue%");
    const continuedParameterProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (target) => parseFreeBasicText(target.getText()),
        async ensureInitialized() { return true; },
        getSemanticModel() { return null; },
        isIncomplete() { return false; }
    });
    const continuedParameterActions = await continuedParameterProvider.provideCodeActions(continuedParameterDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Suffix ignored\n\nin 'continuedValue%'",
            range: new Range(1, continuedParameterStart, 1, continuedParameterStart + "continuedValue%".length)
        }]
    });
    assert.equal(continuedParameterActions.length, 1);
    assert.equal(continuedParameterActions[0].title,
        "Remove ignored '%' suffix from 'continuedValue%' (use the AS type)");
    assert.deepEqual(continuedParameterActions[0].edit.deletion.range,
        new Range(1, continuedParameterStart + "continuedValue".length,
            1, continuedParameterStart + "continuedValue%".length));

    for (const [declarationText, name] of [
        ["Dim arrayValue%(2) As Integer\n", "arrayValue%"],
        ["Dim multiValue% As Integer, otherValue As Integer\n", "multiValue%"],
        ["Const constantValue% As Integer = 1\n", "constantValue%"],
        ["Function functionValue%() As Integer\nEnd Function\n", "functionValue%"]
    ]) {
        const declarationDocument = {
            ...document,
            getText: () => declarationText,
            lineAt: (line) => ({ text: declarationText.split("\n")[line] })
        };
        const start = declarationText.indexOf(name);
        const declarationActions = await provider.provideCodeActions(declarationDocument, null, {
            diagnostics: [{
                ...diagnostic,
                message: `Suffix ignored\n\nin '${name}'`,
                range: new Range(0, start, 0, start + name.length)
            }]
        });
        assert.equal(declarationActions.length, 1, `should offer a fix for ${name}`);
        assert.deepEqual(declarationActions[0].edit.deletion.range,
            new Range(0, start + name.length - 1, 0, start + name.length));
    }

    const keywordSource = "Sub SuffixKeywordProbe()\n    Let% value = 1\nEnd Sub\n";
    const keywordDocument = {
        ...document,
        getText: () => keywordSource,
        lineAt: (line) => ({ text: keywordSource.split("\n")[line] })
    };
    const keywordLine = 1;
    const keywordStart = keywordDocument.lineAt(keywordLine).text.indexOf("Let%");
    const keywordActions = await provider.provideCodeActions(keywordDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Suffix ignored\n\nin 'Let%'",
            range: new Range(keywordLine, keywordStart, keywordLine, keywordStart + "Let%".length)
        }]
    });
    assert.equal(keywordActions.length, 1);
    assert.equal(keywordActions[0].title, "Remove ignored '%' suffix from 'Let%'");
    assert.deepEqual(keywordActions[0].edit.deletion.range,
        new Range(keywordLine, keywordStart + "Let".length, keywordLine, keywordStart + "Let%".length));
});

test("compiler ANY-initializer warning removes only the redundant vector NEW clause", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        delete(uri, range) { this.deletion = { uri, range }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = [
        "Type AnyInitTarget",
        "    value As Integer",
        "    Declare Constructor()",
        "End Type",
        "Constructor AnyInitTarget()",
        "    value = 1",
        "End Constructor",
        "Sub AnyInitProbe()",
        "    Dim values As AnyInitTarget Ptr = New AnyInitTarget[2] { Any }",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/any-init-warning.bas",
        toString: () => "file:///workspace/any-init-warning.bas" };
    const line = 8;
    const lineText = document.lineAt(line).text;
    const initializerStart = lineText.indexOf("{ Any }");
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const diagnostic = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "The ANY initializer has no effect on UDT's with default constructors",
        range: new Range(line, initializerStart, line, initializerStart + "{ Any }".length)
    };

    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Remove redundant '{ Any }' initializer");
    assert.deepEqual(actions[0].edit.deletion, {
        uri: document.uri,
        range: new Range(line, initializerStart, line, initializerStart + "{ Any }".length)
    });
});

test("compiler missing-quote warning offers an end-of-line closing quote", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, text) { this.insertion = { uri, position, text }; }
    }
    const vscode = {
        ...createVscodeMock(),
        Position,
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = "Sub MissingQuoteProbe()\n    Print \"unterminated text   \nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/missing-quote.bas",
        toString: () => "file:///workspace/missing-quote.bas" };
    const line = 1;
    const lineText = document.lineAt(line).text;
    const openingQuote = lineText.indexOf("\"");
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const diagnostic = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Missing closing quote in literal string",
        range: new Range(line, openingQuote, line, lineText.length)
    };

    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Insert missing closing quote at end of line");
    assert.deepEqual(actions[0].edit.insertion, {
        uri: document.uri,
        position: new Position(line, lineText.length),
        text: "\""
    });
});

test("BYREF-result equality warning offers the exact parenthesized-call Quick Fix", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        constructor() { this.insertions = []; }
        insert(uri, position, text) { this.insertions.push({ uri, position, text }); }
    }
    const vscode = {
        ...createVscodeMock(),
        Position,
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = [
        "Sub ByRefResultProbe()",
        "    GetReference(1) = 2",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/byref-result-fix.bas",
        toString: () => "file:///workspace/byref-result-fix.bas" };
    const lineText = document.lineAt(1).text;
    const equals = lineText.indexOf("=");
    const diagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "'=' parsed as equality operator in function argument, not assignment to BYREF function result",
        range: new Range(1, equals, 1, equals + 1)
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Wrap function call in parentheses to assign to its BYREF result");
    assert.deepEqual(actions[0].diagnostics, [diagnostic]);
    assert.deepEqual(actions[0].edit.insertions, [
        {
            uri: document.uri,
            position: new Position(1, lineText.indexOf("GetReference")),
            text: "("
        },
        {
            uri: document.uri,
            position: new Position(1, lineText.indexOf(")") + 1),
            text: ")"
        }
    ]);

    const comparison = createDocument("If GetReference(1) = 2 Then Print 1\n");
    comparison.uri = document.uri;
    assert.deepEqual(await provider.provideCodeActions(comparison, null, {
        diagnostics: [{
            ...diagnostic,
            range: new Range(0, 0, 0, comparison.lineAt(0).text.length)
        }]
    }), [], "a comparison-shaped condition must not receive an assignment rewrite");
});

test("BYREF ANY temporary warning offers a direct-variable Quick Fix only for declared variables", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        delete(uri, range) { this.deletion = { uri, range }; }
        insert(uri, position, text) { this.insertions = [{ uri, position, text }]; }
    }
    const vscode = {
        ...createVscodeMock(),
        Position,
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = [
        "Dim localValue As Integer",
        "Declare Sub ClearAny(ByRef value As Any)",
        "ClearAny(@localValue)",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/byref-any-warning.bas",
        toString: () => "file:///workspace/byref-any-warning.bas" };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(source)
    }]);
    const provider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => sourceModel
    });
    const lineText = document.lineAt(2).text;
    const diagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Suspicious address expression passed to BYREF parameter, at parameter 1 of ClearAny()",
        range: new Range(2, lineText.length - 1, 2, lineText.length)
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Pass 'localValue' directly to 'ClearAny' (BYREF)");
    assert.equal(actions[0].isPreferred, undefined,
        "removing address-of is an opt-in intent choice");
    assert.deepEqual(actions[0].edit.deletion, {
        uri: document.uri,
        range: new Range(2, lineText.indexOf("@"), 2, lineText.indexOf("localValue"))
    });

    const functionSource = [
        "Declare Function GetPointer() As Integer Ptr",
        "Declare Sub ClearAny(ByRef value As Any)",
        "ClearAny(@GetPointer())",
        ""
    ].join("\n");
    const functionDocument = createDocument(functionSource);
    functionDocument.uri = document.uri;
    const functionModel = new FreeBasicSemanticModel([{
        uri: functionDocument.uri,
        parsed: parseFreeBasicText(functionSource)
    }]);
    const functionProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => functionModel
    });
    const functionLine = functionDocument.lineAt(2).text;
    assert.deepEqual(await functionProvider.provideCodeActions(functionDocument, null, {
        diagnostics: [{
            ...diagnostic,
            range: new Range(2, functionLine.length - 1, 2, functionLine.length)
        }]
    }), [], "address-of a function result must not be removed by a variable fix");

    const scalarSource = [
        "Dim localValue As Integer",
        "Declare Sub UseScalar(ByRef value As Integer)",
        "UseScalar(@localValue)",
        ""
    ].join("\n");
    const scalarDocument = createDocument(scalarSource);
    scalarDocument.uri = document.uri;
    const scalarModel = new FreeBasicSemanticModel([{
        uri: scalarDocument.uri,
        parsed: parseFreeBasicText(scalarSource)
    }]);
    const scalarProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => scalarModel
    });
    const scalarLine = scalarDocument.lineAt(2).text;
    const scalarDiagnostic = {
        ...diagnostic,
        message: "Passing pointer to scalar, at parameter 1 (value) of UseScalar()",
        range: new Range(2, scalarLine.length - 1, 2, scalarLine.length)
    };
    const scalarActions = await scalarProvider.provideCodeActions(scalarDocument, null, {
        diagnostics: [scalarDiagnostic]
    });
    assert.equal(scalarActions.length, 1);
    assert.equal(scalarActions[0].title, "Pass 'localValue' instead of its address to 'UseScalar'");
    assert.deepEqual(scalarActions[0].edit.deletion.range,
        new Range(2, scalarLine.indexOf("@"), 2, scalarLine.indexOf("localValue")));

    const scalarToPointerSource = [
        "Dim localValue As Integer",
        "Declare Sub UsePointer(ByVal value As Integer Ptr)",
        "UsePointer(localValue)",
        ""
    ].join("\n");
    const scalarToPointerDocument = createDocument(scalarToPointerSource);
    scalarToPointerDocument.uri = document.uri;
    const scalarToPointerModel = new FreeBasicSemanticModel([{
        uri: scalarToPointerDocument.uri,
        parsed: parseFreeBasicText(scalarToPointerSource)
    }]);
    const scalarToPointerProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => scalarToPointerModel
    });
    const pointerArgumentLine = scalarToPointerDocument.lineAt(2).text;
    const scalarToPointerActions = await scalarToPointerProvider.provideCodeActions(
        scalarToPointerDocument, null, {
            diagnostics: [{
                ...scalarDiagnostic,
                message: "Passing scalar as pointer, at parameter 1 of UsePointer()",
                range: new Range(2, pointerArgumentLine.length - 1, 2, pointerArgumentLine.length)
            }]
        }
    );
    assert.equal(scalarToPointerActions.length, 1);
    assert.equal(scalarToPointerActions[0].title, "Pass the address of 'localValue' to 'UsePointer'");
    assert.deepEqual(scalarToPointerActions[0].edit.insertions, [{
        uri: scalarToPointerDocument.uri,
        position: new Position(2, pointerArgumentLine.indexOf("localValue")),
        text: "@"
    }]);

    const mismatchedPointerSource = scalarToPointerSource.replace("Integer Ptr", "Double Ptr");
    const mismatchedPointerDocument = createDocument(mismatchedPointerSource);
    mismatchedPointerDocument.uri = document.uri;
    const mismatchedPointerModel = new FreeBasicSemanticModel([{
        uri: mismatchedPointerDocument.uri,
        parsed: parseFreeBasicText(mismatchedPointerSource)
    }]);
    const mismatchedPointerProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => mismatchedPointerModel
    });
    const mismatchedLine = mismatchedPointerDocument.lineAt(2).text;
    assert.deepEqual(await mismatchedPointerProvider.provideCodeActions(mismatchedPointerDocument, null, {
        diagnostics: [{
            ...scalarDiagnostic,
            message: "Passing scalar as pointer, at parameter 1 of UsePointer()",
            range: new Range(2, mismatchedLine.length - 1, 2, mismatchedLine.length)
        }]
    }), [], "address-of must not be suggested when pointer and variable base types differ");

    const pointerScalarSource = [
        "Dim pointerValue As Integer Ptr",
        "Declare Sub UseScalar(ByRef value As Integer)",
        "UseScalar(pointerValue)",
        ""
    ].join("\n");
    const pointerScalarDocument = createDocument(pointerScalarSource);
    pointerScalarDocument.uri = document.uri;
    const pointerScalarModel = new FreeBasicSemanticModel([{
        uri: pointerScalarDocument.uri,
        parsed: parseFreeBasicText(pointerScalarSource)
    }]);
    const pointerScalarProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => pointerScalarModel
    });
    const pointerScalarLine = pointerScalarDocument.lineAt(2).text;
    const pointerScalarActions = await pointerScalarProvider.provideCodeActions(pointerScalarDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Passing pointer to scalar, at parameter 1 (value) of UseScalar()",
            range: new Range(2, pointerScalarLine.length - 1, 2, pointerScalarLine.length)
        }]
    });
    assert.equal(pointerScalarActions.length, 1);
    assert.equal(pointerScalarActions[0].title, "Dereference 'pointerValue' to pass its value to 'UseScalar'");
    assert.deepEqual(pointerScalarActions[0].edit.insertions, [{
        uri: pointerScalarDocument.uri,
        position: new Position(2, pointerScalarLine.indexOf("pointerValue")),
        text: "*"
    }]);

    const mismatchedScalarSource = pointerScalarSource.replace("Integer Ptr", "Double Ptr");
    const mismatchedScalarDocument = createDocument(mismatchedScalarSource);
    mismatchedScalarDocument.uri = document.uri;
    const mismatchedScalarModel = new FreeBasicSemanticModel([{
        uri: mismatchedScalarDocument.uri,
        parsed: parseFreeBasicText(mismatchedScalarSource)
    }]);
    const mismatchedScalarProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => mismatchedScalarModel
    });
    const mismatchedScalarLine = mismatchedScalarDocument.lineAt(2).text;
    assert.deepEqual(await mismatchedScalarProvider.provideCodeActions(mismatchedScalarDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Passing pointer to scalar, at parameter 1 (value) of UseScalar()",
            range: new Range(2, mismatchedScalarLine.length - 1, 2, mismatchedScalarLine.length)
        }]
    }), [], "a mismatched pointee type must not be dereferenced automatically");
});

test("ELSE-followed-by-IF warning offers a non-preferred ELSEIF conversion", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = "Sub ElseIfProbe()\n    If firstValue Then\n    Else If secondValue Then\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/else-if-warning.bas",
        toString: () => "file:///workspace/else-if-warning.bas" };
    const line = 2;
    const lineText = document.lineAt(line).text;
    const ifStart = lineText.indexOf("If");
    const diagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "'IF' statement found directly after multi-line 'ELSE'",
        range: new Range(line, ifStart, line, ifStart + 2)
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Change nested 'Else If' to an 'ElseIf' branch");
    assert.equal(actions[0].isPreferred, undefined,
        "the nested and chained forms differ semantically, so the opt-in fix must not be preferred");
    assert.deepEqual(actions[0].edit.replacement, {
        uri: document.uri,
        range: new Range(line, lineText.indexOf("Else"), line, lineText.indexOf("If") + 2),
        text: "ElseIf"
    });

    const unrelated = createDocument("If firstValue Then Print 1\n");
    unrelated.uri = document.uri;
    assert.deepEqual(await provider.provideCodeActions(unrelated, null, {
        diagnostics: [{ ...diagnostic, range: new Range(0, 0, 0, unrelated.lineAt(0).text.length) }]
    }), [], "the warning must match the actual Else If source spelling");
});

test("file-transfer pointer warning offers a primitive-pointer dereference", async () => {
    class Position {
        constructor(line, character) { Object.assign(this, { line, character }); }
    }
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        constructor() { this.insertions = []; }
        insert(uri, position, text) { this.insertions.push({ uri, position, text }); }
    }
    const vscode = {
        ...createVscodeMock(),
        Position,
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = [
        "Dim pointerValue As Integer Ptr",
        'Open "data.bin" For Binary As #1',
        "Put #1, 1, pointerValue",
        "Get #1, 1, pointerValue",
        "Close #1",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/file-pointer-transfer.bas",
        toString: () => "file:///workspace/file-pointer-transfer.bas" };
    const sourceModel = new FreeBasicSemanticModel([{
        uri: document.uri,
        parsed: parseFreeBasicText(source)
    }]);
    const provider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => sourceModel
    });
    const makeWarning = (currentDocument, line) => ({
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Passing Pointer, at parameter 3",
        range: new Range(line, currentDocument.lineAt(line).text.indexOf("pointerValue"),
            line, currentDocument.lineAt(line).text.indexOf("pointerValue") + "pointerValue".length)
    });
    const warnings = [makeWarning(document, 2), makeWarning(document, 3)];
    const actions = await provider.provideCodeActions(document, null, { diagnostics: warnings });

    assert.equal(actions.length, 2);
    assert.ok(actions.every((action) =>
        action.title === "Dereference 'pointerValue' to transfer the pointed-to value" &&
        action.isPreferred === undefined
    ));
    assert.deepEqual(actions.map((action) => action.edit.insertions[0]), [
        { uri: document.uri, position: new Position(2, document.lineAt(2).text.indexOf("pointerValue")), text: "*" },
        { uri: document.uri, position: new Position(3, document.lineAt(3).text.indexOf("pointerValue")), text: "*" }
    ]);

    const udtSource = [
        "Type PointerRecord",
        "    value As Integer",
        "End Type",
        "Dim pointerValue As PointerRecord Ptr",
        "Put #1, 1, pointerValue",
        ""
    ].join("\n");
    const udtDocument = createDocument(udtSource);
    udtDocument.uri = document.uri;
    const udtModel = new FreeBasicSemanticModel([{
        uri: udtDocument.uri,
        parsed: parseFreeBasicText(udtSource)
    }]);
    const udtProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => udtModel
    });
    assert.deepEqual(await udtProvider.provideCodeActions(udtDocument, null, {
        diagnostics: [makeWarning(udtDocument, 4)]
    }), [], "UDT and nonprimitive pointer storage stays a manual choice");
});

test("FOR wrap-limit warning widens inline or simply declared local counter types", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = "Sub CounterProbe()\n    For counter As UByte = 0 To 255\n    Next\nEnd Sub\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/for-counter-wrap.bas",
        toString: () => "file:///workspace/for-counter-wrap.bas" };
    const line = 1;
    const lineText = document.lineAt(line).text;
    const typeStart = lineText.indexOf("UByte");
    const limitStart = lineText.indexOf("255");
    const diagnostic = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "FOR counter variable is unable to exceed limit value",
        range: new Range(line, limitStart, line, limitStart + 3)
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Widen FOR counter to 'UShort' to avoid wraparound");
    assert.equal(actions[0].isPreferred, undefined);
    assert.deepEqual(actions[0].edit.replacement, {
        uri: document.uri,
        range: new Range(line, typeStart, line, typeStart + "UByte".length),
        text: "UShort"
    });

    const declaredCounter = createDocument("Dim counter As UByte\nFor counter = 0 To 255\nNext\n");
    declaredCounter.uri = document.uri;
    assert.deepEqual(await provider.provideCodeActions(declaredCounter, null, {
        diagnostics: [{
            ...diagnostic,
            range: new Range(1, 0, 1, declaredCounter.lineAt(1).text.length)
        }]
    }), [], "a separately declared counter is edited only when its compiler/source binding is available");

    const declaredSource = [
        "Sub CounterProbe()",
        "    Dim counter As UByte",
        "    For counter = 0 To 255",
        "    Next",
        "End Sub",
        ""
    ].join("\n");
    const declaredDocument = createDocument(declaredSource);
    declaredDocument.uri = document.uri;
    const sourceModel = new FreeBasicSemanticModel([{
        uri: declaredDocument.uri,
        parsed: parseFreeBasicText(declaredSource)
    }]);
    const declaredProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => sourceModel
    });
    const loopLine = declaredDocument.lineAt(2).text;
    const declaredLimitStart = loopLine.indexOf("255");
    const declaredActions = await declaredProvider.provideCodeActions(declaredDocument, null, {
        diagnostics: [{
            ...diagnostic,
            range: new Range(2, declaredLimitStart, 2, declaredLimitStart + 3)
        }]
    });
    const declaredTypeStart = declaredDocument.lineAt(1).text.indexOf("UByte");
    assert.equal(declaredActions.length, 1);
    assert.equal(declaredActions[0].title, "Widen FOR counter to 'UShort' to avoid wraparound");
    assert.deepEqual(declaredActions[0].edit.replacement, {
        uri: declaredDocument.uri,
        range: new Range(1, declaredTypeStart, 1, declaredTypeStart + "UByte".length),
        text: "UShort"
    });

    const globalSource = "Dim counter As UByte\nFor counter = 0 To 255\nNext\n";
    const globalDocument = createDocument(globalSource);
    globalDocument.uri = document.uri;
    const globalModel = new FreeBasicSemanticModel([{
        uri: globalDocument.uri,
        parsed: parseFreeBasicText(globalSource)
    }]);
    const globalProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => globalModel
    });
    const globalLoopLine = globalDocument.lineAt(1).text;
    const globalLimitStart = globalLoopLine.indexOf("255");
    assert.deepEqual(await globalProvider.provideCodeActions(globalDocument, null, {
        diagnostics: [{
            ...diagnostic,
            range: new Range(1, globalLimitStart, 1, globalLimitStart + 3)
        }]
    }), [], "module-level counter edits can affect external storage and remain manual");

    const compoundSource = [
        "Sub CounterProbe()",
        "    Dim counter As UByte, otherCounter As UByte",
        "    For counter = 0 To 255",
        "    Next",
        "End Sub",
        ""
    ].join("\n");
    const compoundDocument = createDocument(compoundSource);
    compoundDocument.uri = document.uri;
    const compoundModel = new FreeBasicSemanticModel([{
        uri: compoundDocument.uri,
        parsed: parseFreeBasicText(compoundSource)
    }]);
    const compoundProvider = createMissingHeaderCodeActionProvider(vscode, {
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => compoundModel
    });
    const compoundLoopLine = compoundDocument.lineAt(2).text;
    const compoundLimitStart = compoundLoopLine.indexOf("255");
    assert.deepEqual(await compoundProvider.provideCodeActions(compoundDocument, null, {
        diagnostics: [{
            ...diagnostic,
            range: new Range(2, compoundLimitStart, 2, compoundLimitStart + 3)
        }]
    }), [], "compound declarations are left to the developer to preserve their full type/storage intent");
});

test("constant-overflow warning offers a non-preferred wider type for a fitting integer literal", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = "Dim narrowValue As Byte = 300\n";
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/constant-overflow-fix.bas",
        toString: () => "file:///workspace/constant-overflow-fix.bas" };
    const literalStart = source.indexOf("300");
    const diagnostic = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Overflow in constant conversion",
        range: new Range(0, literalStart, 0, literalStart + 3)
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Widen 'narrowValue' from 'Byte' to 'Short' for this constant");
    assert.equal(actions[0].isPreferred, undefined);
    assert.deepEqual(actions[0].edit.replacement, {
        uri: document.uri,
        range: new Range(0, source.indexOf("Byte"), 0, source.indexOf("Byte") + "Byte".length),
        text: "Short"
    });

    const computed = createDocument("Dim narrowValue As Byte = 300 + 1\n");
    computed.uri = document.uri;
    assert.deepEqual(await provider.provideCodeActions(computed, null, {
        diagnostics: [{ ...diagnostic, range: new Range(0, 0, 0, computed.lineAt(0).text.length) }]
    }), [], "a computed initializer is left for the developer to resolve");
});

test("parameter-default mismatch warning aligns simple scalar defaults", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = [
        "Declare Sub Consume(value As Integer = 1)",
        "Sub Consume(value As Integer = 2)",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = { scheme: "file", fsPath: "/workspace/parameter-default-mismatch.bas",
        toString: () => "file:///workspace/parameter-default-mismatch.bas" };
    document.version = 1;
    document.positionAt = (offset) => {
        const lines = source.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    const model = {
        remote: true,
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [] };
        }
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: false }),
            getModel: () => model,
            getModelForEditor: async () => model
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, index);
    const definitionLine = document.lineAt(1).text;
    const diagnostic = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Mismatching parameter initializer, at parameter 1 (value) of Consume()",
        range: new Range(1, definitionLine.indexOf("Consume"), 1, definitionLine.indexOf("Consume") + "Consume".length)
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Use declared default '1' for parameter 'value'");
    assert.equal(actions[0].isPreferred, undefined);
    assert.deepEqual(actions[0].edit.replacement, {
        uri: document.uri,
        range: new Range(1, definitionLine.indexOf("2"), 1, definitionLine.indexOf("2") + 1),
        text: "1"
    });

    const booleanSource = [
        "Declare Sub SetFlag(flag As Boolean = True)",
        "Sub SetFlag(flag As Boolean = False)",
        "End Sub",
        ""
    ].join("\n");
    const booleanDocument = createDocument(booleanSource);
    booleanDocument.uri = document.uri;
    booleanDocument.version = 1;
    const booleanLine = booleanDocument.lineAt(1).text;
    const booleanNameStart = booleanLine.indexOf("SetFlag");
    const booleanValueStart = booleanLine.indexOf("False");
    const booleanActions = await provider.provideCodeActions(booleanDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (flag) of SetFlag()",
            range: new Range(1, booleanNameStart, 1, booleanNameStart + "SetFlag".length)
        }]
    });
    assert.equal(booleanActions.length, 1);
    assert.equal(booleanActions[0].title, "Use declared default 'True' for parameter 'flag'");
    assert.deepEqual(booleanActions[0].edit.replacement, {
        uri: booleanDocument.uri,
        range: new Range(1, booleanValueStart, 1, booleanValueStart + "False".length),
        text: "True"
    });

    const stringSource = [
        "Declare Sub SetName(value As String = \"accepted\")",
        "Sub SetName(value As String = \"rejected\")",
        "End Sub",
        ""
    ].join("\n");
    const stringDocument = createDocument(stringSource);
    stringDocument.uri = document.uri;
    stringDocument.version = 1;
    const stringLine = stringDocument.lineAt(1).text;
    const stringNameStart = stringLine.indexOf("SetName");
    const stringDefaultStart = stringLine.indexOf("\"rejected\"");
    const stringActions = await provider.provideCodeActions(stringDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (value) of SetName()",
            range: new Range(1, stringNameStart, 1, stringNameStart + "SetName".length)
        }]
    });
    assert.equal(stringActions.length, 1);
    assert.equal(stringActions[0].title, "Use declared default '\"accepted\"' for parameter 'value'");
    assert.deepEqual(stringActions[0].edit.replacement, {
        uri: stringDocument.uri,
        range: new Range(1, stringDefaultStart, 1, stringDefaultStart + "\"rejected\"".length),
        text: "\"accepted\""
    });

    const suffixedSource = [
        "Declare Sub SetBits(value As ULongInt = &hFFFFFFFFFFFFFFFFull)",
        "Sub SetBits(value As ULongInt = 1ull)",
        "End Sub",
        ""
    ].join("\n");
    const suffixedDocument = createDocument(suffixedSource);
    suffixedDocument.uri = document.uri;
    suffixedDocument.version = 1;
    const suffixedLine = suffixedDocument.lineAt(1).text;
    const suffixedNameStart = suffixedLine.indexOf("SetBits");
    const suffixedDefaultStart = suffixedLine.indexOf("1ull");
    const suffixedActions = await provider.provideCodeActions(suffixedDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (value) of SetBits()",
            range: new Range(1, suffixedNameStart, 1, suffixedNameStart + "SetBits".length)
        }]
    });
    assert.equal(suffixedActions.length, 1);
    assert.equal(suffixedActions[0].title, "Use declared default '&hFFFFFFFFFFFFFFFFull' for parameter 'value'");
    assert.deepEqual(suffixedActions[0].edit.replacement, {
        uri: suffixedDocument.uri,
        range: new Range(1, suffixedDefaultStart, 1, suffixedDefaultStart + "1ull".length),
        text: "&hFFFFFFFFFFFFFFFFull"
    });

    const floatSource = [
        "Declare Sub SetScale(value As Double = 1.25)",
        "Sub SetScale(value As Double = 2.5)",
        "End Sub",
        ""
    ].join("\n");
    const floatDocument = createDocument(floatSource);
    floatDocument.uri = document.uri;
    floatDocument.version = 1;
    const floatLine = floatDocument.lineAt(1).text;
    const floatNameStart = floatLine.indexOf("SetScale");
    const floatDefaultStart = floatLine.indexOf("2.5");
    const floatActions = await provider.provideCodeActions(floatDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (value) of SetScale()",
            range: new Range(1, floatNameStart, 1, floatNameStart + "SetScale".length)
        }]
    });
    assert.equal(floatActions.length, 1);
    assert.equal(floatActions[0].title, "Use declared default '1.25' for parameter 'value'");
    assert.deepEqual(floatActions[0].edit.replacement, {
        uri: floatDocument.uri,
        range: new Range(1, floatDefaultStart, 1, floatDefaultStart + "2.5".length),
        text: "1.25"
    });

    const suffixedFloatSource = [
        "Declare Sub SetSingle(value As Single = 1.25!)",
        "Sub SetSingle(value As Single = 2.5!)",
        "End Sub",
        ""
    ].join("\n");
    const suffixedFloatDocument = createDocument(suffixedFloatSource);
    suffixedFloatDocument.uri = document.uri;
    suffixedFloatDocument.version = 1;
    const suffixedFloatLine = suffixedFloatDocument.lineAt(1).text;
    const suffixedFloatName = suffixedFloatLine.indexOf("SetSingle");
    const suffixedFloatDefault = suffixedFloatLine.indexOf("2.5!");
    const suffixedFloatActions = await provider.provideCodeActions(suffixedFloatDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (value) of SetSingle()",
            range: new Range(1, suffixedFloatName, 1, suffixedFloatName + "SetSingle".length)
        }]
    });
    assert.equal(suffixedFloatActions.length, 1);
    assert.deepEqual(suffixedFloatActions[0].edit.replacement, {
        uri: suffixedFloatDocument.uri,
        range: new Range(1, suffixedFloatDefault, 1, suffixedFloatDefault + "2.5!".length),
        text: "1.25!"
    });

    const constantSource = [
        "Const DEFAULT_ONE As Integer = 1",
        "Const DEFAULT_TWO As Integer = 2",
        "Declare Sub UseDefault(value As Integer = DEFAULT_ONE)",
        "Sub UseDefault(value As Integer = DEFAULT_TWO)",
        "End Sub",
        ""
    ].join("\n");
    const constantDocument = createDocument(constantSource);
    constantDocument.uri = document.uri;
    constantDocument.version = 1;
    const constantLine = constantDocument.lineAt(3).text;
    const constantName = constantLine.indexOf("UseDefault");
    const constantValueStart = constantLine.indexOf("DEFAULT_TWO");
    const constantModel = new FreeBasicSemanticModel([{
        uri: constantDocument.uri,
        parsed: parseFreeBasicText(constantSource)
    }]);
    const constantProvider = createMissingHeaderCodeActionProvider(vscode, {
        ...index,
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => constantModel
    });
    const constantActions = await constantProvider.provideCodeActions(constantDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (value) of UseDefault()",
            range: new Range(3, constantName, 3, constantName + "UseDefault".length)
        }]
    });
    assert.equal(constantActions.length, 1);
    assert.equal(constantActions[0].title, "Use declared default 'DEFAULT_ONE' for parameter 'value'");
    assert.deepEqual(constantActions[0].edit.replacement, {
        uri: constantDocument.uri,
        range: new Range(3, constantValueStart, 3, constantValueStart + "DEFAULT_TWO".length),
        text: "DEFAULT_ONE"
    });

    const qualifiedConstantSource = [
        "Namespace Settings",
        "    Const DefaultColor As Integer = 1",
        "    Const OtherColor As Integer = 2",
        "End Namespace",
        "Declare Sub ChooseColor(value As Integer = Settings.DefaultColor)",
        "Sub ChooseColor(value As Integer = Settings.OtherColor)",
        "End Sub",
        ""
    ].join("\n");
    const qualifiedConstantDocument = createDocument(qualifiedConstantSource);
    qualifiedConstantDocument.uri = document.uri;
    qualifiedConstantDocument.version = 1;
    const qualifiedConstantModel = new FreeBasicSemanticModel([{
        uri: qualifiedConstantDocument.uri,
        parsed: parseFreeBasicText(qualifiedConstantSource)
    }]);
    const qualifiedConstantProvider = createMissingHeaderCodeActionProvider(vscode, {
        ...index,
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => qualifiedConstantModel
    });
    const qualifiedConstantLine = qualifiedConstantDocument.lineAt(5).text;
    const qualifiedConstantName = qualifiedConstantLine.indexOf("ChooseColor");
    const qualifiedConstantDefaultStart = qualifiedConstantLine.indexOf("Settings.OtherColor");
    const qualifiedConstantActions = await qualifiedConstantProvider.provideCodeActions(
        qualifiedConstantDocument, null, {
            diagnostics: [{
                ...diagnostic,
                message: "Mismatching parameter initializer, at parameter 1 (value) of ChooseColor()",
                range: new Range(5, qualifiedConstantName, 5, qualifiedConstantName + "ChooseColor".length)
            }]
        }
    );
    assert.equal(qualifiedConstantActions.length, 1);
    assert.equal(qualifiedConstantActions[0].title,
        "Use declared default 'Settings.DefaultColor' for parameter 'value'");
    assert.deepEqual(qualifiedConstantActions[0].edit.replacement, {
        uri: qualifiedConstantDocument.uri,
        range: new Range(5, qualifiedConstantDefaultStart, 5,
            qualifiedConstantDefaultStart + "Settings.OtherColor".length),
        text: "Settings.DefaultColor"
    });

    const macroDefaultSource = [
        "Const DEFAULT_ONE As Integer = 1",
        "Const DEFAULT_TWO As Integer = 2",
        "#define DEFAULT_ONE 99",
        "Declare Sub UseDefault(value As Integer = DEFAULT_ONE)",
        "Sub UseDefault(value As Integer = DEFAULT_TWO)",
        "End Sub",
        ""
    ].join("\n");
    const macroDefaultDocument = createDocument(macroDefaultSource);
    macroDefaultDocument.uri = document.uri;
    macroDefaultDocument.version = 1;
    const macroDefaultModel = new FreeBasicSemanticModel([{
        uri: macroDefaultDocument.uri,
        parsed: parseFreeBasicText(macroDefaultSource)
    }]);
    const macroDefaultProvider = createMissingHeaderCodeActionProvider(vscode, {
        ...index,
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => macroDefaultModel
    });
    const macroDefaultLine = macroDefaultDocument.lineAt(4).text;
    const macroDefaultName = macroDefaultLine.indexOf("UseDefault");
    assert.deepEqual(await macroDefaultProvider.provideCodeActions(macroDefaultDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (value) of UseDefault()",
            range: new Range(4, macroDefaultName, 4, macroDefaultName + "UseDefault".length)
        }]
    }), [], "a macro with the same spelling prevents a source-only constant proof");

    const variableConstantSource = [
        "Dim DEFAULT_ONE As Integer = 1",
        "Dim DEFAULT_TWO As Integer = 2",
        "Declare Sub UseDefault(value As Integer = DEFAULT_ONE)",
        "Sub UseDefault(value As Integer = DEFAULT_TWO)",
        "End Sub",
        ""
    ].join("\n");
    const variableConstantDocument = createDocument(variableConstantSource);
    variableConstantDocument.uri = document.uri;
    variableConstantDocument.version = 1;
    const variableConstantModel = new FreeBasicSemanticModel([{
        uri: variableConstantDocument.uri,
        parsed: parseFreeBasicText(variableConstantSource)
    }]);
    const variableConstantProvider = createMissingHeaderCodeActionProvider(vscode, {
        ...index,
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText()),
        getSourceSemanticModel: () => variableConstantModel
    });
    const variableConstantLine = variableConstantDocument.lineAt(3).text;
    const variableConstantName = variableConstantLine.indexOf("UseDefault");
    assert.deepEqual(await variableConstantProvider.provideCodeActions(variableConstantDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (value) of UseDefault()",
            range: new Range(3, variableConstantName, 3, variableConstantName + "UseDefault".length)
        }]
    }), [], "named defaults must resolve to a CONST rather than a mutable variable");

    const multilineSource = [
        "Declare Sub Multi( _",
        "    value As Integer = 1 _",
        ")",
        "Sub Multi( _",
        "    value As Integer = 2 _",
        ")",
        "End Sub",
        ""
    ].join("\n");
    const multilineDocument = createDocument(multilineSource);
    multilineDocument.uri = document.uri;
    multilineDocument.version = 1;
    const implementationNameStart = multilineDocument.lineAt(3).text.indexOf("Multi");
    const implementationDefault = multilineDocument.lineAt(4).text.indexOf("2");
    const multilineActions = await provider.provideCodeActions(multilineDocument, null, {
        diagnostics: [{
            ...diagnostic,
            message: "Mismatching parameter initializer, at parameter 1 (value) of Multi()",
            range: new Range(3, implementationNameStart, 3, implementationNameStart + "Multi".length)
        }]
    });
    assert.equal(multilineActions.length, 1);
    assert.equal(multilineActions[0].title, "Use declared default '1' for parameter 'value'");
    assert.deepEqual(multilineActions[0].edit.replacement, {
        uri: multilineDocument.uri,
        range: new Range(4, implementationDefault, 4, implementationDefault + 1),
        text: "1"
    });

    const ambiguousSource = [
        "Declare Sub Consume(value As Integer = 1)",
        "Declare Sub Consume(value As Integer = 3)",
        "Sub Consume(value As Integer = 2)",
        "End Sub",
        ""
    ].join("\n");
    const ambiguousDocument = createDocument(ambiguousSource);
    ambiguousDocument.uri = document.uri;
    ambiguousDocument.version = 1;
    ambiguousDocument.positionAt = (offset) => {
        const lines = ambiguousSource.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    const ambiguousLine = ambiguousDocument.lineAt(2).text;
    assert.deepEqual(await provider.provideCodeActions(ambiguousDocument, null, {
        diagnostics: [{
            ...diagnostic,
            range: new Range(2, ambiguousLine.indexOf("Consume"), 2, ambiguousLine.indexOf("Consume") + "Consume".length)
        }]
    }), [], "multiple matching declarations must not choose which default is authoritative");
});

test("enum parameter-default mismatch fix requires matching compiler enum owners", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const source = [
        "Enum Colors",
        "    Red",
        "    Blue",
        "End Enum",
        "Declare Sub Choose(value As Colors = Red)",
        "Sub Choose(value As Colors = Blue)",
        "End Sub",
        ""
    ].join("\n");
    const document = createDocument(source);
    document.uri = {
        scheme: "file",
        fsPath: "/workspace/enum-default-mismatch.bas",
        toString: () => "file:///workspace/enum-default-mismatch.bas"
    };
    document.version = 1;
    document.positionAt = (offset) => {
        const lines = source.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    let enumOwners = [{ index: 0, owner: 1 }, { index: 1, owner: 1 }];
    let expectedEnumSites = null;
    const model = {
        remote: true,
        partial: false,
        semanticSidecarOnly: true,
        semanticBindingsAvailable: true,
        async query(operation, uri, input) {
            assert.equal(operation, "compilerSidecarEnumMembersAtSites");
            assert.equal(uri, document.uri);
            assert.equal(input.sites.length, 2);
            if (expectedEnumSites) assert.deepEqual(input.sites, expectedEnumSites);
            return enumOwners;
        }
    };
    const snapshot = {
        model,
        sources: [{ uri: document.uri, text: source }]
    };
    const index = {
        compilerAnalysis: {
            analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModel: () => model,
            getModelForEditor: async () => model,
            snapshotFor: () => snapshot
        },
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, index);
    const implementationLine = document.lineAt(5).text;
    const procedureStart = implementationLine.indexOf("Choose");
    const diagnostic = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Mismatching parameter initializer, at parameter 1 (value) of Choose()",
        range: new Range(5, procedureStart, 5, procedureStart + "Choose".length)
    };

    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Use declared default 'Red' for parameter 'value'");
    assert.deepEqual(actions[0].edit.replacement, {
        uri: document.uri,
        range: new Range(5, implementationLine.indexOf("Blue"), 5, implementationLine.indexOf("Blue") + "Blue".length),
        text: "Red"
    });

    enumOwners = [{ index: 0, owner: 1 }, { index: 1, owner: 2 }];
    assert.deepEqual(await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] }), [],
        "enum members from different compiler enum owners must remain a manual edit");

    const qualifiedSource = [
        "Enum ExplicitColors Explicit",
        "    Red",
        "    Blue",
        "End Enum",
        "Declare Sub ChooseColor(value As Integer = ExplicitColors.Red)",
        "Sub ChooseColor(value As Integer = ExplicitColors.Blue)",
        "End Sub",
        ""
    ].join("\n");
    const qualifiedDocument = createDocument(qualifiedSource);
    qualifiedDocument.uri = document.uri;
    qualifiedDocument.version = 2;
    qualifiedDocument.positionAt = (offset) => {
        const lines = qualifiedSource.slice(0, offset).split("\n");
        return { line: lines.length - 1, character: lines.at(-1).length };
    };
    snapshot.sources[0].text = qualifiedSource;
    const qualifiedLine = qualifiedDocument.lineAt(5).text;
    const qualifiedProcedureStart = qualifiedLine.indexOf("ChooseColor");
    const qualifiedDeclaredMemberStart = qualifiedDocument.lineAt(4).text.lastIndexOf("Red");
    const qualifiedImplementedMemberStart = qualifiedLine.lastIndexOf("Blue");
    expectedEnumSites = [
        {
            filePath: qualifiedDocument.uri.fsPath,
            line: 4,
            startColumn: qualifiedDeclaredMemberStart,
            endColumn: qualifiedDeclaredMemberStart + "Red".length
        },
        {
            filePath: qualifiedDocument.uri.fsPath,
            line: 5,
            startColumn: qualifiedImplementedMemberStart,
            endColumn: qualifiedImplementedMemberStart + "Blue".length
        }
    ];
    enumOwners = [{ index: 0, owner: 3 }, { index: 1, owner: 3 }];
    const qualifiedDiagnostic = {
        ...diagnostic,
        message: "Mismatching parameter initializer, at parameter 1 (value) of ChooseColor()",
        range: new Range(5, qualifiedProcedureStart, 5, qualifiedProcedureStart + "ChooseColor".length)
    };
    const qualifiedActions = await provider.provideCodeActions(qualifiedDocument, null, {
        diagnostics: [qualifiedDiagnostic]
    });
    assert.equal(qualifiedActions.length, 1);
    assert.equal(qualifiedActions[0].title,
        "Use declared default 'ExplicitColors.Red' for parameter 'value'");
    assert.deepEqual(qualifiedActions[0].edit.replacement, {
        uri: qualifiedDocument.uri,
        range: new Range(5, qualifiedLine.indexOf("ExplicitColors.Blue"), 5,
            qualifiedLine.indexOf("ExplicitColors.Blue") + "ExplicitColors.Blue".length),
        text: "ExplicitColors.Red"
    });
});

test("parameter-default mismatch fix uses a unique prototype from the compiler's included sources", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        replace(uri, range, text) { this.replacement = { uri, range, text }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const rootUri = { scheme: "file", fsPath: "/workspace/project/main.bas", toString: () => "file:///workspace/project/main.bas" };
    const headerUri = { scheme: "file", fsPath: "/workspace/project/include/consume.bi", toString: () => "file:///workspace/project/include/consume.bi" };
    const rootSource = "#include \"include/consume.bi\"\nConst DEFAULT_TWO As Integer = 2\nSub Consume(value As Integer = DEFAULT_TWO)\nEnd Sub\n";
    const headerSource = "Const DEFAULT_ONE As Integer = 1\nDeclare Sub Consume(value As Integer = DEFAULT_ONE)\n";
    const document = createDocument(rootSource);
    document.uri = rootUri;
    document.version = 1;
    const sourceModel = new FreeBasicSemanticModel([
        {
            uri: rootUri,
            parsed: parseFreeBasicText(rootSource),
            includeUris: new Set([headerUri.toString()])
        },
        { uri: headerUri, parsed: parseFreeBasicText(headerSource), includeUris: new Set() }
    ]);
    const model = {
        remote: true,
        partial: false,
        async query(operation) {
            assert.equal(operation, "hover");
            return { entries: [] };
        }
    };
    const snapshot = {
        model,
        sources: [
            { uri: rootUri, text: rootSource },
            { uri: headerUri, text: headerSource }
        ]
    };
    const index = {
        compilerAnalysis: {
            getModel: () => model,
            getModelForEditor: async () => model,
            snapshotFor: () => snapshot
        },
        getSourceSemanticModel: () => sourceModel,
        getParsedDocument: (currentDocument) => parseFreeBasicText(currentDocument.getText())
    };
    const provider = createMissingHeaderCodeActionProvider(vscode, index);
    const implementationLine = document.lineAt(2).text;
    const procedureName = implementationLine.indexOf("Consume");
    const defaultValue = implementationLine.indexOf("DEFAULT_TWO");
    const diagnostic = {
        source: "fbc",
        severity: vscode.DiagnosticSeverity.Warning,
        message: "Mismatching parameter initializer, at parameter 1 (value) of Consume()",
        range: new Range(2, procedureName, 2, procedureName + "Consume".length)
    };
    const actions = await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Use declared default 'DEFAULT_ONE' for parameter 'value'");
    assert.deepEqual(actions[0].edit.replacement, {
        uri: document.uri,
        range: new Range(2, defaultValue, 2, defaultValue + "DEFAULT_TWO".length),
        text: "DEFAULT_ONE"
    });

    const rootWithPrototype = "#include \"include/consume.bi\"\nConst DEFAULT_TWO As Integer = 2\nDeclare Sub Consume(value As Integer = 3)\nSub Consume(value As Integer = DEFAULT_TWO)\nEnd Sub\n";
    const localConflictDocument = createDocument(rootWithPrototype);
    localConflictDocument.uri = rootUri;
    localConflictDocument.version = 1;
    const localConflictLine = localConflictDocument.lineAt(3).text;
    index.compilerAnalysis.snapshotFor = () => ({
        model,
        sources: [
            { uri: rootUri, text: rootWithPrototype },
            { uri: headerUri, text: headerSource }
        ]
    });
    assert.deepEqual(await provider.provideCodeActions(localConflictDocument, null, {
        diagnostics: [{
            ...diagnostic,
            range: new Range(3, localConflictLine.indexOf("Consume"), 3,
                localConflictLine.indexOf("Consume") + "Consume".length)
        }]
    }), [], "a same-file and included prototype with different defaults is ambiguous");

    const secondHeaderUri = { scheme: "file", fsPath: "/workspace/project/include/other.bi", toString: () => "file:///workspace/project/include/other.bi" };
    const ambiguousSnapshot = {
        model,
        sources: [
            { uri: rootUri, text: rootSource },
            { uri: headerUri, text: headerSource },
            { uri: secondHeaderUri, text: "Declare Sub Consume(value As Integer = 3)\n" }
        ]
    };
    index.compilerAnalysis.snapshotFor = () => ambiguousSnapshot;
    assert.deepEqual(await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] }), [],
        "multiple matching compiler-included prototypes must not choose an authoritative default");

    index.compilerAnalysis.snapshotFor = () => ({
        model,
        sources: [
            { uri: rootUri, text: rootSource },
            { uri: headerUri, text: "#if SELECTED_API\nDeclare Sub Consume(value As Integer = 1)\n#endif\n" }
        ]
    });
    assert.deepEqual(await provider.provideCodeActions(document, null, { diagnostics: [diagnostic] }), [],
        "conditional header declarations are not treated as the compiler-selected prototype");
});

test("compiler-confirmed unclosed blocks offer the exact EOF terminator", async () => {
    class CodeAction {
        constructor(title, kind) { Object.assign(this, { title, kind }); }
    }
    class WorkspaceEdit {
        insert(uri, position, newText) { this.insertion = { uri, position, newText }; }
    }
    const vscode = {
        ...createVscodeMock(),
        CodeAction,
        CodeActionKind: { QuickFix: "quickfix" },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
        WorkspaceEdit
    };
    const uri = { scheme: "file", fsPath: "/workspace/incomplete.bas", toString: () => "file:///workspace/incomplete.bas" };
    const makeDocument = (text) => ({
        uri,
        version: 1,
        getText: () => text,
        positionAt(offset) {
            const prefix = text.slice(0, offset);
            const lines = prefix.split(/\r\n|\n|\r/);
            return { line: lines.length - 1, character: lines.at(-1).length };
        }
    });
    const provider = createMissingHeaderCodeActionProvider(vscode, {});
    const procedureSource = "Sub Incomplete()\nPrint 1";
    const procedureDiagnostic = {
        source: "fbc (buffer)",
        severity: vscode.DiagnosticSeverity.Error,
        message: "Expected 'END SUB'\n\nCompiler context: Procedure declaration remains open at end of file",
        range: new Range(1, 0, 1, 7)
    };
    const procedureActions = await provider.provideCodeActions(
        makeDocument(procedureSource), null, { diagnostics: [procedureDiagnostic] }
    );
    assert.equal(procedureActions.length, 1);
    assert.equal(procedureActions[0].title, "Insert 'End Sub' at end of file");
    assert.equal(procedureActions[0].edit.insertion.newText, "\nEnd Sub");

    const nestedSource = "Function Incomplete() As Integer\r\nIf condition Then\r\nPrint 1\r\n";
    const nestedDiagnostic = {
        ...procedureDiagnostic,
        message: "Expected 'END IF'\n\nCompiler context: Procedure declaration remains open at end of file",
        range: new Range(3, 0, 3, 0)
    };
    const nestedActions = await provider.provideCodeActions(
        makeDocument(nestedSource), null, { diagnostics: [nestedDiagnostic] }
    );
    assert.equal(nestedActions[0].edit.insertion.newText, "End If\r\n", "the fix should preserve CRLF");

    assert.deepEqual(await provider.provideCodeActions(makeDocument(procedureSource), null, {
        diagnostics: [{ ...procedureDiagnostic, message: "Expected 'END SUB'" }]
    }), [], "the fix requires the compiler's unclosed-procedure context");
    const alreadyClosedSource = "Sub Incomplete()\nEnd Sub";
    assert.deepEqual(await provider.provideCodeActions(makeDocument(alreadyClosedSource), null, {
        diagnostics: [{ ...procedureDiagnostic, range: new Range(1, 0, 1, 7) }]
    }), [], "a stale diagnostic must not add a duplicate END statement");
});

/* end of tests/editor-features.test.js */
