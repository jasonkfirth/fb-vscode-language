/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-language-status.test.js
    Purpose: Verify passive compiler-state presentation and subscription cleanup.
    Responsibilities: cover availability, progress, context, and editor changes.
    Does not contain: compiler execution, source parsing, or real editor profiles.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { compilerLanguageStatus, createCompilerLanguageStatus } = require("../lib/compiler-language-status");

function fixture() {
    const file = (filePath) => ({ scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` });
    const document = { languageId: "freebasic", uri: file("/project/main.bas"), isDirty: false };
    const state = { document, compiler: { compilerPath: "fbc", semanticModelOnly: true },
        context: { name: "debug", filePath: "/project/main.bas", signature: "debug-signature" }, model: null, rootValid: true, mode: "onDemand", compatibility: null };
    const events = Object.fromEntries(["active", "changed", "saved", "closed", "config", "trust", "analysis", "snapshot"].map((name) => {
        const listeners = new Set();
        return [name, { listeners,
            listen(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
            fire(value) { for (const listener of [...listeners]) listener(value); } }];
    }));
    let updates = 0, disposals = 0, text;
    const item = { get text() { return text; }, set text(value) { text = value; updates++; }, dispose() { disposals++; } };
    const vscode = {
        LanguageStatusSeverity: { Information: 0, Warning: 1 }, Uri: { file },
        languages: { createLanguageStatusItem(id, selector) {
            assert.equal(id, "freebasic.compiler");
            assert.deepEqual(selector, { language: "freebasic" });
            return item;
        } },
        window: { activeTextEditor: { document }, onDidChangeActiveTextEditor: events.active.listen },
        workspace: { isTrusted: true, getConfiguration: () => ({ get: () => state.mode }),
            onDidChangeTextDocument: events.changed.listen, onDidSaveTextDocument: events.saved.listen,
            onDidCloseTextDocument: events.closed.listen, onDidChangeConfiguration: events.config.listen,
            onDidGrantWorkspaceTrust: events.trust.listen }
    };
    const analysis = {
        running: new Map(), runningContexts: new Map(), snapshots: new Map(), onDemandFailures: new WeakMap(),
        analysisCompilerFor: () => state.compiler,
        compilerCompatibilityFor: () => state.compatibility,
        contextFor: () => { if (state.contextError) throw new Error(state.contextError); return state.context; },
        getModel: () => state.model, modelForSnapshot: () => state.rootValid,
        onDidChangeAnalysis: events.analysis.listen, onDidChangeSnapshot: events.snapshot.listen,
        check() { assert.fail("status must never request analysis"); }
    };
    return { state, vscode, analysis, events, item, status: () => compilerLanguageStatus(vscode, analysis, state.document),
        updates: () => updates, disposals: () => disposals };
}

test("compiler status explains trust, unnamed sources, and missing configuration", () => {
    const { state, vscode, status } = fixture();
    vscode.workspace.isTrusted = false;
    assert.equal(status().text, "FBC: restricted");
    assert.equal(status().command.command, "workbench.trust.manage");
    vscode.workspace.isTrusted = true;
    state.document.uri.scheme = "untitled";
    assert.equal(status().text, "FBC: name source file");
    state.document.uri.scheme = "freebasic-preprocessed";
    assert.equal(status().text, "FBC: expanded source");
    state.document.uri.scheme = "file";
    state.compiler.compilerPath = "";
    assert.equal(status().text, "FBC: not configured");
    assert.deepEqual(status().command.arguments, ["freebasic.compiler.path"]);
});

test("compiler status explains version checks and older-compiler limited mode", () => {
    const { state, status } = fixture();
    state.compatibility = { state: "checking" };
    assert.equal(status().text, "FBC: checking version");
    assert.match(status().detail, /Syntax highlighting and source editing remain available/);

    state.compatibility = {
        state: "unsupported",
        version: "1.20.0",
        message: "FreeBASIC 1.20.0 does not provide the schema-27 semantic model required for compiler-backed analysis. Syntax highlighting, source-based editor features, and ordinary compiler checks remain available. Use FBC 1.20.4 or newer for compiler-backed analysis."
    };
    assert.equal(status().text, "FBC: limited mode");
    assert.match(status().detail, /1\.20\.0/);
    assert.match(status().detail, /ordinary compiler checks remain available/);
    assert.deepEqual(status().command.arguments, ["freebasic.compiler.path"]);
    state.compiler.semanticModelOnly = false;
    assert.deepEqual(status().command.arguments, ["freebasic.analysis.compilerPath"]);
});

test("compiler status reports only current running work and distinguishes complete and partial models", () => {
    const { state, analysis, status } = fixture();
    const key = state.document.uri.toString();
    const controller = new AbortController();
    analysis.running.set(key, controller);
    analysis.runningContexts.set(key, { signature: state.context.signature });
    assert.equal(status().text, "FBC: analyzing");
    assert.equal(status().busy, true);
    assert.match(status().detail, /sidecar.*debug.*main\.bas/);
    analysis.runningContexts.set(key, { signature: "obsolete-build" });
    assert.equal(status().busy, false, "work for an obsolete context must not claim the current build is busy");
    analysis.runningContexts.set(key, { signature: state.context.signature });
    controller.abort();
    assert.equal(status().busy, false);
    state.compiler.semanticModelOnly = false;
    state.model = { partial: false };
    assert.equal(status().text, "FBC: ready");
    assert.match(status().detail, /editor bridge/);
    state.model.partial = true;
    assert.equal(status().text, "FBC: partial analysis");
    assert.equal(status().severity, 1);
});

test("compiler status distinguishes missing and compiler-excluded header contexts", () => {
    const { state, analysis, status } = fixture();
    state.document.uri.fsPath = "/project/types.bi";
    state.document.uri.toString = () => "file:///project/types.bi";
    state.contextError = "Select a translation unit for this header.";
    assert.equal(status().text, "FBC: select header context");
    assert.equal(status().command.command, "freebasic.selectCompilerContext");
    state.contextError = null;
    analysis.snapshots.set("file:///project/main.bas", { context: state.context, sources: [] });
    assert.equal(status().text, "FBC: header not included");
    state.rootValid = false;
    assert.equal(status().text, "FBC: on demand", "expired root facts must not label the header as excluded");
});

test("compiler status explains stock-sidecar dirty buffers and retryable failures", () => {
    const { state, analysis, status } = fixture();
    state.document.isDirty = true;
    assert.equal(status().text, "FBC: save for analysis");
    assert.equal(status().command.command, "workbench.action.files.save");
    state.compiler.semanticModelOnly = false;
    assert.equal(status().text, "FBC: on demand");
    analysis.onDemandFailures.set(state.document, { retryAfter: Date.now() + 30000 });
    assert.equal(status().text, "FBC: retry analysis");
    assert.equal(status().command.command, "freebasic.analyzeModule");
    analysis.onDemandFailures.set(state.document, { retryAfter: 0 });
    assert.equal(status().text, "FBC: on demand");
});

test("compiler status reflects analysis policy without preparing a compiler model", () => {
    const { state, status } = fixture();
    for (const [mode, text] of [["off", "manual analysis"], ["onSave", "waiting for save"],
        ["onChange", "analysis on change"], ["onDemand", "on demand"]]) {
        state.mode = mode;
        assert.equal(status().text, `FBC: ${text}`);
    }
});

test("language-status subscriptions coalesce editor events and stop after disposal", async () => {
    const fixtureState = fixture();
    const { state, vscode, analysis, events, item, updates, disposals } = fixtureState;
    const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
    const status = createCompilerLanguageStatus(vscode, analysis);
    await flush();
    assert.equal(item.name, "FreeBASIC Compiler");
    assert.equal(item.text, "FBC: on demand");
    const key = state.document.uri.toString();
    analysis.running.set(key, new AbortController());
    analysis.runningContexts.set(key, { signature: state.context.signature });
    for (let index = 0; index < 10; index++) events.analysis.fire();
    await flush();
    assert.equal(updates(), 2, "a burst of service events needs only one status refresh");
    assert.equal(item.busy, true);
    analysis.running.clear();
    state.model = { partial: false };
    events.snapshot.fire([]);
    events.analysis.fire();
    await flush();
    assert.equal(item.text, "FBC: ready");
    assert.equal(item.busy, false);
    state.model = null;
    state.mode = "onSave";
    events.config.fire({ affectsConfiguration: (name) => name === "freebasic" });
    await flush();
    assert.equal(item.text, "FBC: waiting for save");
    const activeDocument = { ...state.document, isDirty: true };
    vscode.window.activeTextEditor = { document: activeDocument };
    events.active.fire();
    await flush();
    assert.equal(item.text, "FBC: save for analysis");
    activeDocument.isDirty = false;
    events.saved.fire(activeDocument);
    await flush();
    assert.equal(item.text, "FBC: waiting for save");
    events.active.fire();
    const beforeDispose = updates();
    status.dispose();
    status.dispose();
    for (const event of Object.values(events)) assert.equal(event.listeners.size, 0);
    await flush();
    assert.equal(updates(), beforeDispose, "a queued refresh must not write a disposed language-status item");
    assert.equal(disposals(), 1);
});

/* end of compiler-language-status.test.js */
