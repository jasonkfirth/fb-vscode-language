/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-analysis-service.test.js
    Purpose: Protect the lifecycle and trust boundary of compiler snapshots.
    Responsibilities: capture unsaved inputs and reject untrusted or stale work.
    Does not contain: compiler launching or editor-host assertions.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CompilerAnalysisService } = require("../lib/compiler-analysis-service");
const { analysisContext, projectContexts } = require("../lib/compiler-contexts");
const { BoundedTextMap } = require("../lib/bounded-text-map");

function setup(t, analyze) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-analysis-service-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    fs.writeFileSync(filePath, "Dim value As Long\n");
    const uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    const document = { uri, languageId: "freebasic", isDirty: false, version: 1, getText: () => fs.readFileSync(filePath, "utf8") };
    const values = { "analysis.compilerPath": "bridge" };
    const workspace = {
        isTrusted: true, textDocuments: [document],
        getWorkspaceFolder: () => ({ uri: { fsPath: directory } }),
        getConfiguration: () => ({ get: (name, fallback) => values[name] ?? fallback })
    };
    const index = { documents: new Map([[uri.toString(), { uri }]]), ensureInitialized: async () => true, getDependentModules: () => [], notifyChange() {} };
    const vscode = { workspace, Uri: { file: (file) => ({ scheme: "file", fsPath: file, toString: () => `file://${file}` }), from: (value) => ({ ...value, toString: () => `${value.scheme}:${value.path}?${value.query}` }) }, window: { showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {} } };
    const result = { text: "Dim value As Long\n", origins: [{ filePath, line: 0, generated: false }], dependencies: [filePath] };
    let calls = 0;
    const service = new CompilerAnalysisService(vscode, index, { appendLine() {} }, async (options) => { calls++; return analyze ? analyze(options, result) : result; });
    t.after(() => service.dispose());
    return { service, document, workspace, vscode, filePath, directory, values, calls: () => calls };
}

function headerContext(fixture) {
    const uri = fixture.vscode.Uri.file(path.join(fixture.directory, "types.bi"));
    fs.writeFileSync(uri.fsPath, "Type ValueType As Long\n");
    const header = { uri, languageId: "freebasic", getText: () => "Type ValueType As Double\n" };
    fixture.workspace.textDocuments.push(header);
    fixture.values["analysis.projectContexts"] = [{ name: "double", modules: ["main.bas"], arguments: ["-d", "DOUBLE_VALUE"] }, { name: "normal", modules: ["main.bas"] }];
    fixture.values["analysis.activeContext"] = { name: "double", module: "main.bas" };
    return header;
}

test("manual checks select overlay analysis only for dirty inputs with the editor bridge", (t) => {
    const fixture = setup(t);
    assert.equal(fixture.service.shouldAnalyzeUnsavedBuffers(fixture.document), false);

    fixture.document.isDirty = true;
    assert.equal(fixture.service.shouldAnalyzeUnsavedBuffers(fixture.document), true,
        "a dirty root can be checked from its editor buffer when the bridge is configured");
    fixture.document.isDirty = false;

    const headerUri = fixture.vscode.Uri.file(path.join(fixture.directory, "header.bi"));
    fixture.workspace.textDocuments.push({
        uri: headerUri,
        languageId: "freebasic",
        isDirty: true,
        getText: () => "Type EditorValue As Long\n"
    });
    assert.equal(fixture.service.shouldAnalyzeUnsavedBuffers(fixture.document), true,
        "an unsaved open header should be included when checking a saved root module");

    fixture.values["analysis.compilerPath"] = "";
    assert.equal(fixture.service.shouldAnalyzeUnsavedBuffers(fixture.document), false,
        "ordinary fbc diagnostics remain on their saved-file path without the editor bridge");
});

test("expanded text cache enforces entry and UTF-8 byte bounds with incremental accounting", () => {
    const cache = new BoundedTextMap(3, 7);
    cache.set("old", "é");
    cache.set("stable", "abc");
    cache.set("old", "😀");
    assert.equal(cache.bytes, 7, "replacing a key must subtract its prior UTF-8 byte length");

    cache.set("new", "x");
    assert.deepEqual([...cache], [["stable", "abc"], ["new", "x"]],
        "oldest text should be evicted until both retention bounds hold");
    assert.equal(cache.bytes, 4);

    cache.delete("stable");
    assert.equal(cache.bytes, 1);
    cache.clear();
    assert.equal(cache.bytes, 0);

    const entryBound = new BoundedTextMap(2, 100);
    entryBound.set("one", "1").set("two", "2").set("three", "3");
    assert.deepEqual([...entryBound.keys()], ["two", "three"]);
    assert.equal(entryBound.bytes, 2);

    const oversized = new BoundedTextMap(2, 3);
    oversized.set("too-large", "four");
    assert.equal(oversized.size, 0, "one item larger than the byte budget must not be retained");
    assert.equal(oversized.bytes, 0);
});

test("workspace symbol worker concurrency is configurable and capped", async (t) => {
    const fixture = setup(t);
    const service = new CompilerAnalysisService(fixture.vscode, fixture.service.index, { appendLine() {} });
    t.after(() => service.dispose());

    fixture.values["index.workspaceConcurrency"] = 2;
    const parallel = service.getWorkspaceWorkers();
    assert.equal(parallel.length, 2);

    fixture.values["index.workspaceConcurrency"] = 1;
    const serial = service.getWorkspaceWorkers();
    assert.equal(serial.length, 1);
    assert.notEqual(serial[0], parallel[0]);
    assert.ok(parallel.every((worker) => worker.disposed), "Superseded workers must release their queue and cache owners.");

    fixture.values["index.workspaceConcurrency"] = 100;
    const capped = service.getWorkspaceWorkers();
    assert.equal(capped.length, 2, "Invalidly large configuration must stay within the memory bound.");
    assert.ok(serial[0].disposed, "Replaced workers must be shut down.");
});

test("untrusted and unnamed documents never launch compiler analysis", async (t) => {
    const fixture = setup(t);
    fixture.workspace.isTrusted = false;
    assert.equal(await fixture.service.check(fixture.document), false);
    fixture.workspace.isTrusted = true;
    fixture.document.uri = { scheme: "untitled" };
    assert.equal(await fixture.service.check(fixture.document), false);
    assert.equal(fixture.calls(), 0);
});

test("dirty named buffers are passed as immutable compiler overlays", async (t) => {
    const fixture = setup(t, (options, result) => {
        assert.equal(options.overlays.get(fixture.filePath), "Dim pendingValue As Double\n");
        assert.equal(options.exportSemanticExpressions, true, "prepared editor models must request physical compiler expression facts");
        assert.equal(options.timeoutMs, 60000, "native analysis uses its bounded long-module default");
        return { ...result, text: options.overlays.get(fixture.filePath) };
    });
    fixture.document.isDirty = true;
    fixture.document.getText = () => "Dim pendingValue As Double\n";
    assert.equal(await fixture.service.check(fixture.document), true);
    assert.equal(fs.readFileSync(fixture.filePath, "utf8"), "Dim value As Long\n");
    assert.ok(fixture.service.getModel(fixture.document.uri));
});

test("worker-backed analysis types a broken unsaved root that has no disk file", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const source = "Dim pendingValue As Double\nPrint pendingValue +\nPrint pendingValue + 1\n";
    const fixture = setup(t, (options, result) => ({
        ...result,
        text: source,
        origins: [{ filePath: options.filePath, line: 0, generated: false }],
        dependencies: [options.filePath]
    }));
    const filePath = path.join(fixture.directory, "new-unsaved.bas");
    fixture.values["analysis.compilerPath"] = process.env.FBC_EDITOR_EXECUTABLE;
    fixture.document.uri = fixture.vscode.Uri.file(filePath);
    fixture.document.isDirty = true;
    fixture.document.getText = () => source;
    fixture.document.version = 2;

    assert.equal(await fixture.service.check(fixture.document, false), true,
        "direct on-demand analysis must use the captured root instead of requiring a disk file");
    assert.ok(fixture.service.getModel(fixture.document.uri));
    assert.equal(fs.existsSync(filePath), false);

    const messages = [];
    const service = new CompilerAnalysisService(fixture.vscode, fixture.service.index, { appendLine: (message) => messages.push(message) });
    t.after(() => service.dispose());
    assert.equal(fs.existsSync(filePath), false, "the compiler must receive the editor overlay, not a synthetic disk copy");
    assert.equal(await service.check(fixture.document, false), true, messages.join("\n"));

    const model = service.getModel(fixture.document.uri);
    assert.ok(model?.remote, "production analysis must retain the prepared worker snapshot");
    assert.equal(model.partial, true, "the broken line must remain visible as a compiler diagnostic");
    const expressionStart = { line: 2, character: "Print ".length };
    const expressionEnd = { line: 2, character: "Print pendingValue + 1".length };
    const expression = await model.expressionAt(fixture.document.uri, expressionStart, expressionEnd);
    assert.equal(expression?.typeName.toLowerCase(), "double");
    assert.equal(expression?.provisional, false, "a later independent expression must remain authoritative");
    assert.equal(fs.existsSync(filePath), false, "analysis must leave the unsaved root off disk");
});

test("native analysis honors its dedicated timeout setting", async (t) => {
    const fixture = setup(t, (options, result) => {
        assert.equal(options.timeoutMs, 90000);
        return result;
    });
    fixture.values["analysis.timeoutMs"] = 90000;
    assert.equal(await fixture.service.check(fixture.document), true);
});

test("the configured diagnostics compiler can supply a sidecar-only type snapshot without an editor bridge", async (t) => {
    const fixture = setup(t, (options, result) => {
        assert.equal(options.compilerPath, "plain-fbc");
        assert.equal(options.semanticModelOnly, true);
        return { ...result, semanticSidecarOnly: true, semanticExpressions: [] };
    });
    fixture.values["analysis.compilerPath"] = "";
    fixture.values["compiler.path"] = "plain-fbc";

    assert.equal(fixture.service.isConfigured(fixture.document.uri), false,
        "sidecar-only expression analysis must not enable native symbol search or project rename");
    assert.equal(await fixture.service.check(fixture.document), true);
    assert.equal(fixture.calls(), 1);
});

test("on-demand editor requests prepare and reuse a compiler expression model", async (t) => {
    const fixture = setup(t, (options, result) => {
        assert.equal(options.exportSemanticExpressions, true);
        assert.equal(options.exportSemanticBindings, false,
            "ordinary on-demand editor models should not pay for full binding facts");
        assert.equal(options.semanticModelOnly, true);
        return {
            ...result,
            semanticSidecarOnly: true,
            semanticModelSchemaVersion: 27,
            semanticExpressions: [{
                id: 1,
                physical: true,
                filePath: fixture.filePath,
                startLine: 1,
                startColumn: 4,
                endLine: 1,
                endColumn: 9,
                astClass: 0,
                operator: -1,
                operatorCode: "",
                operatorKind: "none",
                dtype: 16,
                symbol: 0,
                subtype: 0,
                typeName: "long"
            }]
        };
    });
    fixture.values["analysis.compilerPath"] = "";
    fixture.values["compiler.path"] = "plain-fbc";

    assert.equal(await fixture.service.getModelForEditor(fixture.document), null,
        "sidecar-only type analysis must not replace symbol/member providers");
    assert.equal(fixture.calls(), 0);
    const first = await fixture.service.getModelForEditor(fixture.document, null, true);
    assert.ok(first);
    const expression = first.expressionAt(fixture.document.uri,
        { line: 0, character: 4 }, { line: 0, character: 9 });
    assert.equal(expression?.typeName.toLowerCase(), "long");
    assert.equal(expression?.semanticSource, "compiler-sidecar");
    assert.equal(fixture.calls(), 1);

    const second = await fixture.service.getModelForEditor(fixture.document, null, true);
    assert.equal(second, first, "repeated provider requests must reuse the current compiler snapshot");
    assert.equal(fixture.calls(), 1, "a current on-demand snapshot must not launch another compiler pass");
});

test("on-demand stock-sidecar requests can upgrade to compiler binding facts", async (t) => {
    const fixture = setup(t, (options, result) => {
        assert.equal(options.semanticModelOnly, true);
        assert.equal(options.exportSemanticBindings, true);
        return {
            ...result,
            semanticSidecarOnly: true,
            semanticModelSchemaVersion: 27,
            semanticBindings: [{
                symbol: 1,
                role: "declaration",
                physical: true,
                filePath: fixture.filePath,
                startLine: 1,
                startColumn: 4,
                endLine: 1,
                endColumn: 9,
                name: "value"
            }]
        };
    });
    fixture.values["analysis.compilerPath"] = "";
    fixture.values["compiler.path"] = "plain-fbc";

    const model = await fixture.service.getModelForEditor(fixture.document, null, false, true);

    assert.ok(model?.semanticSidecarOnly);
    assert.equal(model.semanticBindingsAvailable, true);
    assert.equal(model.semanticBindings[0].name, "value");
    assert.equal(fixture.calls(), 1);
});

test("on-demand macro binding requests retain full macro signatures", async (t) => {
    const fixture = setup(t, (options, result) => {
        assert.equal(options.semanticModelOnly, true);
        assert.equal(options.exportSemanticBindings, true);
        assert.equal(options.compactSemanticMacros, false,
            "compiler-selected macro signatures must remain available to the editor model");
        return { ...result, semanticSidecarOnly: true, semanticModelSchemaVersion: 27 };
    });
    fixture.values["analysis.compilerPath"] = "";
    fixture.values["compiler.path"] = "plain-fbc";

    const model = await fixture.service.getModelForEditor(fixture.document, null, false, true, true);

    assert.ok(model?.semanticSidecarOnly);
    assert.equal(model.semanticBindingsAvailable, true);
    assert.equal(model.semanticMacroBindingsAvailable, true);
    assert.equal(fixture.calls(), 1);
});

test("on-demand analysis stays opt-out and retries failed inputs only after their version changes", async (t) => {
    const disabled = setup(t, () => { throw new Error("disabled analysis must not launch fbc"); });
    disabled.values["analysis.run"] = "off";
    assert.equal(await disabled.service.getModelForEditor(disabled.document), null);
    assert.equal(disabled.calls(), 0);

    const failed = setup(t, () => { throw new Error("compiler is not ready"); });
    assert.equal(await failed.service.getModelForEditor(failed.document), null);
    assert.equal(await failed.service.getModelForEditor(failed.document), null);
    assert.equal(failed.calls(), 1, "the same failed request must be throttled instead of retried for every provider call");

    failed.document.version++;
    assert.equal(await failed.service.getModelForEditor(failed.document), null);
    assert.equal(failed.calls(), 2, "a new document version must be eligible for a fresh compiler attempt");
});

test("on-demand sidecar analysis does not read dirty roots from disk", async (t) => {
    const fixture = setup(t, () => { throw new Error("plain fbc must not receive an unsaved root"); });
    fixture.values["analysis.compilerPath"] = "";
    fixture.values["compiler.path"] = "plain-fbc";
    fixture.document.isDirty = true;
    assert.equal(await fixture.service.getModelForEditor(fixture.document, null, true), null);
    assert.equal(fixture.calls(), 0);
});

test("sidecar-only compiler analysis rejects an unsaved root before launching fbc", async (t) => {
    const fixture = setup(t, () => { throw new Error("plain compiler must not receive unsaved source"); });
    fixture.values["analysis.compilerPath"] = "";
    fixture.values["compiler.path"] = "plain-fbc";
    fixture.document.isDirty = true;

    assert.equal(await fixture.service.check(fixture.document), false);
    assert.equal(fixture.calls(), 0);
});

test("source edits invalidate accepted snapshots", async (t) => {
    const fixture = setup(t);
    assert.equal(await fixture.service.check(fixture.document), true);
    assert.ok(fixture.service.getModel(fixture.document.uri));
    fs.writeFileSync(fixture.filePath, "Dim changedValue As String\n");
    assert.equal(fixture.service.getModel(fixture.document.uri), null);
});

test("rebuilding a stable bridge symlink invalidates compiler snapshots", { skip: process.platform === "win32" }, async (t) => {
    const fixture = setup(t, (options, result) => {
        assert.equal(options.compilerPath, fs.realpathSync(fixture.values["analysis.compilerPath"]));
        return result;
    });
    const bridgePath = path.join(fixture.directory, "fbc-editor-current");
    fs.symlinkSync(process.execPath, bridgePath);
    fixture.values["analysis.compilerPath"] = bridgePath;

    assert.equal(await fixture.service.check(fixture.document), true);
    assert.ok(fixture.service.getModel(fixture.document.uri));

    fs.unlinkSync(bridgePath);
    fs.symlinkSync("/bin/true", bridgePath);
    assert.equal(fixture.service.getModel(fixture.document.uri), null,
        "a new build behind the stable path must not reuse snapshots from the old compiler image");
});

test("delayed document events retain matching snapshots and cancel stale request inputs", async (t) => {
    const fixture = setup(t, (options, result) => ({ ...result, text: options.overlays.get(fixture.filePath) }));
    fixture.document.isDirty = true;
    fixture.document.getText = () => "Dim currentValue As Double\n";
    assert.equal(await fixture.service.check(fixture.document), true);
    fixture.service.documentChanged(fixture.document);
    assert.ok(fixture.service.getModel(fixture.document.uri), "A delayed event must not discard the exact captured buffer");

    let aborted = false;
    const controller = { abort: () => { aborted = true; } };
    fixture.service.running.set("file:///pending.bas", controller);
    fixture.service.runningBuffers.set("file:///pending.bas", new Map([[fixture.filePath, "Dim oldValue As Long\n"]]));
    fixture.service.documentChanged(fixture.document);
    assert.equal(aborted, true, "A request with older immutable input must be stopped");
});

test("partial snapshots publish captured-buffer diagnostics and clear them on invalidation", async (t) => {
    const fixture = setup(t, (options, result) => {
        assert.equal(options.allowErrors, true);
        const diagnostic = { filePath: fixture.filePath, line: 500, code: 9, severity: "error", message: "Expected expression" };
        return { ...result, partial: true, completion: { errorCount: 1, reachedEnd: true }, diagnostics: [diagnostic, diagnostic] };
    });
    fixture.vscode.Range = class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = { set: (uri, diagnostics) => published.set(uri.toString(), diagnostics), clear: () => published.clear(), dispose() {} };
    assert.equal(await fixture.service.check(fixture.document), true);
    assert.equal(fixture.service.getModel(fixture.document.uri).partial, true);
    const diagnostics = published.get(fixture.document.uri.toString());
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].source, "fbc (buffer)");
    assert.equal(diagnostics[0].range.start.line, 1);
    fixture.service.invalidate();
    assert.equal(published.size, 0);
});

test("compiler diagnostics use validated physical points instead of whole-line ranges", async (t) => {
    const fixture = setup(t, (_options, result) => ({
        ...result,
        diagnostics: [{
            filePath: fixture.filePath,
            line: 0,
            code: 42,
            severity: "error",
            message: "Variable not declared, value",
            compilerContext: "unresolved-variable",
            compilerDetail: "The name was not found in this scope.",
            physicalPoint: { line: 0, character: 4 }
        }]
    }));
    fixture.vscode.Range = class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = { set: (uri, diagnostics) => published.set(uri.toString(), diagnostics), clear: () => published.clear(), dispose() {} };

    assert.equal(await fixture.service.check(fixture.document), true);
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.equal(diagnostic.range.start.character, 4);
    assert.equal(diagnostic.range.end.character, 5);
    assert.match(diagnostic.message, /The name was not found in this scope/);
});

test("FOR counter wrap warnings underline the compiler-pointed limit token", (t) => {
    const fixture = setup(t);
    const source = "Sub CounterWrapProbe()\n    For counter As UByte = 0 To 255\n    Next\nEnd Sub\n";
    fixture.vscode.Range = class {
        constructor(startLine, startChar, endLine, endChar) {
            this.start = { line: startLine, character: startChar };
            this.end = { line: endLine, character: endChar };
        }
    };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    const lineText = source.split("\n")[1];
    const limitCharacter = lineText.indexOf("255");
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 1,
            code: 45,
            severity: "warning",
            message: "FOR counter variable is unable to exceed limit value",
            physicalPoint: { line: 1, character: limitCharacter }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual([
        diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character
    ], [1, limitCharacter, 1, limitCharacter + 1]);
});

test("suspicious pointer assignment warnings underline the compiler-pointed operand", (t) => {
    const fixture = setup(t);
    const source = "intPointer = doublePointer\n";
    fixture.vscode.Range = class {
        constructor(startLine, startChar, endLine, endChar) {
            this.start = { line: startLine, character: startChar };
            this.end = { line: endLine, character: endChar };
        }
    };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    const pointerCharacter = source.indexOf("doublePointer");
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 0,
            code: 4,
            severity: "warning",
            message: "Suspicious pointer assignment",
            physicalPoint: { line: 0, character: pointerCharacter }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual([
        diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character
    ], [0, pointerCharacter, 0, pointerCharacter + "doublePointer".length]);
});

test("function-pointer mismatch warnings underline the compiler-selected target", (t) => {
    const fixture = setup(t);
    const source = "callback = @targetProcedure\n";
    fixture.vscode.Range = class {
        constructor(startLine, startChar, endLine, endChar) {
            this.start = { line: startLine, character: startChar };
            this.end = { line: endLine, character: endChar };
        }
    };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    const targetCharacter = source.indexOf("targetProcedure");
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 0,
            code: 41,
            severity: "warning",
            message: "Return type mismatch in function pointer",
            compilerCustomText: " in function pointer",
            physicalPoint: { line: 0, character: targetCharacter }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual([
        diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character
    ], [0, targetCharacter, 0, targetCharacter + "targetProcedure".length]);
});

test("parameter-default mismatch warnings underline the implementation name", (t) => {
    const fixture = setup(t);
    const source = "Sub Consume(value As Integer = 2)\nEnd Sub\n";
    fixture.vscode.Range = class {
        constructor(startLine, startChar, endLine, endChar) {
            this.start = { line: startLine, character: startChar };
            this.end = { line: endLine, character: endChar };
        }
    };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    const procedureName = source.indexOf("Consume");
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 1,
            code: 36,
            severity: "warning",
            message: "Mismatching parameter initializer, at parameter 1 (value) of Consume()",
            physicalPoint: { line: 0, character: procedureName }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual([
        diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character
    ], [0, procedureName, 0, procedureName + "Consume".length]);
});

test("parameter overflow warnings keep a broad range when FBC points at the call delimiter", (t) => {
    const fixture = setup(t);
    const source = "TakeByte(300)\n";
    fixture.vscode.Range = class {
        constructor(startLine, startChar, endLine, endChar) {
            this.start = { line: startLine, character: startChar };
            this.end = { line: endLine, character: endChar };
        }
    };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    const callEndCharacter = source.indexOf(")");
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 0,
            code: 47,
            severity: "warning",
            message: "Overflow in constant conversion, at parameter 1 (value) of TAKEBYTE()",
            compilerDetail: "at parameter 1 (value) of TAKEBYTE()",
            physicalPoint: { line: 0, character: callEndCharacter }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual([
        diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character
    ], [0, 0, 0, source.trimEnd().length]);
});

test("compiler-pointed operator, type, storage, and conversion warnings underline selected tokens", (t) => {
    const fixture = setup(t);
    const source = [
        "Dim flag As Boolean",
        "Dim As Integer i",
        "Print flag And 4",
        "Print i Shl 64",
        "Dim value As Const Integer = 1",
        "Dim pointer As Const Integer Ptr = Cast(Integer Ptr, @value)",
        "TakeMutable(@value)",
        "Dim largeText As String * 9999999",
        "Dim hugeArray(0 To 9999999) As Byte",
        "Print -&hFFFFFFFFFFFFFFFFu",
        ""
    ].join("\n");
    fixture.vscode.Range = class {
        constructor(startLine, startChar, endLine, endChar) {
            this.start = { line: startLine, character: startChar };
            this.end = { line: endLine, character: endChar };
        }
    };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    const lines = source.split("\n");
    const logicalValue = lines[2].indexOf("4");
    const shiftCount = lines[3].indexOf("64");
    const constValue = lines[5].indexOf("value");
    const callEnd = lines[6].indexOf(")");
    const largeSize = lines[7].indexOf("9999999");
    const largeArrayType = lines[8].indexOf("Byte");
    const oversizedLiteral = lines[9].indexOf("&h");
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [
            {
                filePath: fixture.filePath,
                line: 2,
                code: 55,
                severity: "warning",
                message: "Suspicious logic operation, mixed boolean and non-boolean operands",
                physicalPoint: { line: 2, character: logicalValue }
            },
            {
                filePath: fixture.filePath,
                line: 3,
                code: 56,
                severity: "warning",
                message: "Shift value greater than or equal to number of bits in data type",
                physicalPoint: { line: 3, character: shiftCount }
            },
            {
                filePath: fixture.filePath,
                line: 5,
                code: 57,
                severity: "warning",
                message: "CONST qualifier discarded",
                physicalPoint: { line: 5, character: constValue }
            },
            {
                filePath: fixture.filePath,
                line: 6,
                code: 58,
                severity: "warning",
                message: "CONST qualifier discarded, at parameter 1 of TAKEMUTABLE()",
                physicalPoint: { line: 6, character: callEnd }
            },
            {
                filePath: fixture.filePath,
                line: 7,
                code: 59,
                severity: "warning",
                message: "Variable too large for stack, consider making it SHARED",
                physicalPoint: { line: 7, character: largeSize }
            },
            {
                filePath: fixture.filePath,
                line: 8,
                code: 60,
                severity: "warning",
                message: "Array too large for stack, consider making it var-len or SHARED",
                physicalPoint: { line: 8, character: largeArrayType }
            },
            {
                filePath: fixture.filePath,
                line: 9,
                code: 61,
                severity: "warning",
                message: "Implicit conversion",
                physicalPoint: { line: 9, character: oversizedLiteral }
            }
        ]
    });

    fixture.service.publishDiagnostics();
    const diagnostics = published.get(fixture.document.uri.toString());
    assert.deepEqual(diagnostics.map((diagnostic) => [
        diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character
    ]), [
        [2, logicalValue, 2, logicalValue + 1],
        [3, shiftCount, 3, shiftCount + 2],
        [5, constValue, 5, constValue + "value".length],
        [6, 0, 6, lines[6].length],
        [7, largeSize, 7, largeSize + "9999999".length],
        [8, largeArrayType, 8, largeArrayType + "Byte".length],
        [9, oversizedLiteral, 9, oversizedLiteral + "&hFFFFFFFFFFFFFFFFu".length]
    ]);
});

test("constant-overflow warnings underline the compiler-pointed literal", (t) => {
    const fixture = setup(t);
    const source = "Dim narrowValue As Byte = 300\n";
    fixture.vscode.Range = class {
        constructor(startLine, startChar, endLine, endChar) {
            this.start = { line: startLine, character: startChar };
            this.end = { line: endLine, character: endChar };
        }
    };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    const literalCharacter = source.indexOf("300");
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 0,
            code: 25,
            severity: "warning",
            message: "Overflow in constant conversion",
            physicalPoint: { line: 0, character: literalCharacter }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual([
        diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character
    ], [0, literalCharacter, 0, literalCharacter + 3]);
});

test("compiler parameter-mode warnings publish the exact formal-parameter range", (t) => {
    const fixture = setup(t);
    const source = "Sub Consume(value As Integer)\nEnd Sub\n";
    const startCharacter = source.indexOf("value");
    fixture.vscode.Range = class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 0,
            code: 15,
            severity: "warning",
            message: "No explicit BYREF or BYVAL, at parameter 1 (value) of Consume()",
            sourceText: "",
            physicalPoint: { line: 0, character: startCharacter }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual(diagnostic.range.start, { line: 0, character: startCharacter });
    assert.deepEqual(diagnostic.range.end, { line: 0, character: startCharacter + "value".length });
});

test("implicit-allocation warnings publish the exact compiler-named variable range", (t) => {
    const fixture = setup(t);
    const source = "Sub Probe()\n    Print implicitValue\nEnd Sub\n";
    const line = 1;
    const startCharacter = source.split("\n")[line].indexOf("implicitValue");
    fixture.vscode.Range = class { constructor(startLine, startChar, endLine, endChar) { this.start = { line: startLine, character: startChar }; this.end = { line: endLine, character: endChar }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line,
            code: 7,
            severity: "warning",
            message: "Implicit variable allocation,",
            sourceText: "",
            compilerDetail: "implicitValue",
            physicalPoint: { line, character: 4 }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual(diagnostic.range.start, { line, character: startCharacter });
    assert.deepEqual(diagnostic.range.end, { line, character: startCharacter + "implicitValue".length });
});

test("multi-counter NEXT warnings use the unique compiler-named token when no physical point is supplied", (t) => {
    const fixture = setup(t);
    const source = "For outer = 1 To 2\n    For inner = 1 To 2\n    Next inner, outer\n";
    fixture.vscode.Range = class { constructor(startLine, startChar, endLine, endChar) { this.start = { line: startLine, character: startChar }; this.end = { line: endLine, character: endChar }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [
            {
                filePath: fixture.filePath,
                line: 2,
                code: 26,
                severity: "warning",
                message: "Variable following NEXT is meaningless, INNER",
                sourceText: ""
            },
            {
                filePath: fixture.filePath,
                line: 2,
                code: 26,
                severity: "warning",
                message: "Variable following NEXT is meaningless, OUTER",
                sourceText: ""
            }
        ]
    });

    fixture.service.publishDiagnostics();
    const diagnostics = published.get(fixture.document.uri.toString());
    assert.deepEqual(diagnostics.map((diagnostic) => [
        diagnostic.range.start.character,
        diagnostic.range.end.character
    ]), [[9, 14], [16, 21]]);
});

test("FBC FOR/NEXT context highlights the mismatched counter and reaches diagnostic text", (t) => {
    const fixture = setup(t);
    const source = "For outer = 1 To 2\n    Next inner\n";
    fixture.vscode.Range = class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 1,
            code: 314,
            severity: "error",
            message: "FOR/NEXT variable name mismatch",
            compilerContext: "for-next-variable-mismatch",
            physicalPoint: { line: 1, character: 9 }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual(diagnostic.range.start, { line: 1, character: 9 });
    assert.deepEqual(diagnostic.range.end, { line: 1, character: 14 });
    assert.match(diagnostic.message, /Compiler context: FOR\/NEXT counter mismatch/);
});

test("compiler warning explanations accompany diagnostic messages", (t) => {
    const fixture = setup(t);
    const source = "Sub Probe(flag As Integer, nextFlag As Integer)\nIf flag Then\nElse If nextFlag Then\nEnd If\nEnd If\nEnd Sub\nFunction MissingResult() As Integer\nEnd Function\n";
    fixture.vscode.Range = class { constructor(startLine, startChar, endLine, endChar) { this.start = { line: startLine, character: startChar }; this.end = { line: endLine, character: endChar }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 2,
            code: 38,
            severity: "warning",
            message: "'IF' statement found directly after multi-line 'ELSE'"
        }, {
            filePath: fixture.filePath,
            line: 6,
            code: 24,
            severity: "warning",
            message: "Function result was not explicitly set"
        }]
    });

    fixture.service.publishDiagnostics();
    const [ifDiagnostic, resultDiagnostic] = published.get(fixture.document.uri.toString());
    assert.match(ifDiagnostic.message,
        /This starts a nested IF\. If you meant another branch of the same conditional, use ELSEIF\./);
    assert.match(resultDiagnostic.message,
        /Set a result with Return expression or Function = expression before the function ends\./);
});

test("BYREF result warnings explain the parentheses needed for assignment", (t) => {
    const fixture = setup(t);
    const source = [
        "Function GetReference(ByVal inputValue As Integer) ByRef As Integer",
        "    Static resultValue As Integer",
        "    Function = resultValue",
        "End Function",
        "Sub ByRefResultProbe()",
        "    GetReference(1) = 2",
        "End Sub",
        ""
    ].join("\n");
    fixture.vscode.Range = class { constructor(startLine, startChar, endLine, endChar) { this.start = { line: startLine, character: startChar }; this.end = { line: endLine, character: endChar }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 5,
            code: 52,
            severity: "warning",
            message: "'=' parsed as equality operator in function argument, not assignment to BYREF function result",
            physicalPoint: { line: 5, character: source.split("\n")[5].indexOf("= 2") + 2 }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.match(diagnostic.message,
        /If you intended to assign to the BYREF result, wrap the function call in parentheses: \(function\(arguments\)\) = value\./);
    const equals = source.split("\n")[5].indexOf("=");
    assert.deepEqual([diagnostic.range.start.line, diagnostic.range.start.character,
        diagnostic.range.end.line, diagnostic.range.end.character], [5, equals, 5, equals + 1],
    "the compiler-confirmed equality token should receive the precise warning range");
});

test("LINE INPUT capacity errors explain the required maximum character count", (t) => {
    const fixture = setup(t);
    const source = "Dim buffer As ZString Ptr\nLine Input *buffer\n";
    fixture.vscode.Range = class { constructor(line, character, endLine, endCharacter) { this.start = { line, character }; this.end = { line: endLine, character: endCharacter }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line: 1,
            code: 27,
            severity: "error",
            message: "Expected ','",
            compilerContext: "line-input-unknown-buffer-capacity",
            physicalPoint: { line: 1, character: 12 },
            sourceText: "Line Input *buffer"
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual(diagnostic.range.start, { line: 1, character: 12 });
    assert.deepEqual(diagnostic.range.end, { line: 1, character: 18 });
    assert.match(diagnostic.message,
        /LINE INPUT target has unknown buffer capacity; add a comma and maximum character count after the target/);
});

test("ANY-initializer warnings underline the full redundant NEW clause", (t) => {
    const fixture = setup(t);
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
    const line = 8;
    const initializerStart = source.split("\n")[line].indexOf("{ Any }");
    fixture.vscode.Range = class { constructor(startLine, startChar, endLine, endChar) { this.start = { line: startLine, character: startChar }; this.end = { line: endLine, character: endChar }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line,
            code: 19,
            severity: "warning",
            message: "The ANY initializer has no effect on UDT's with default constructors",
            physicalPoint: { line, character: initializerStart }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual(diagnostic.range.start, { line, character: initializerStart });
    assert.deepEqual(diagnostic.range.end, { line, character: initializerStart + "{ Any }".length });
});

test("missing-quote warnings underline the unclosed string and its insertion point", (t) => {
    const fixture = setup(t);
    const source = "Sub MissingQuoteProbe()\n    Print \"unterminated text   \nEnd Sub\n";
    const line = 1;
    const lineText = source.split("\n")[line];
    const openingQuote = lineText.indexOf("\"");
    fixture.vscode.Range = class { constructor(startLine, startChar, endLine, endChar) { this.start = { line: startLine, character: startChar }; this.end = { line: endLine, character: endChar }; } };
    fixture.vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
    fixture.vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
    const published = new Map();
    fixture.service.diagnosticCollection = {
        set: (uri, diagnostics) => published.set(uri.toString(), diagnostics),
        clear: () => published.clear(),
        dispose() {}
    };
    fixture.service.snapshots.set(fixture.document.uri.toString(), {
        sources: [{ uri: fixture.document.uri, text: source }],
        diagnostics: [{
            filePath: fixture.filePath,
            line,
            code: 1,
            severity: "warning",
            message: "Missing closing quote in literal string",
            physicalPoint: { line, character: lineText.length }
        }]
    });

    fixture.service.publishDiagnostics();
    const [diagnostic] = published.get(fixture.document.uri.toString());
    assert.deepEqual(diagnostic.range.start, { line, character: openingQuote });
    assert.deepEqual(diagnostic.range.end, { line, character: lineText.length });
});

test("in-flight invalidation cannot publish an obsolete snapshot", async (t) => {
    let finish;
    const fixture = setup(t, (_options, result) => new Promise((resolve) => { finish = () => resolve(result); }));
    const pending = fixture.service.check(fixture.document);
    await new Promise((resolve) => setImmediate(resolve));
    fixture.service.invalidate();
    finish();
    assert.equal(await pending, false);
    assert.equal(fixture.service.snapshots.size, 0);
    assert.equal(fixture.service.running.size, 0);
});

test("repeated unsaved edits cancel stale analyses and publish only the newest buffer", async (t) => {
    const requests = [];
    const fixture = setup(t, (options, result) => new Promise((resolve) => {
        const text = options.overlays.get(fixture.filePath);
        requests.push({
            text,
            signal: options.signal,
            finish: () => resolve({ ...result, text })
        });
    }));
    fixture.document.isDirty = true;

    const waitForRequest = async (count) => {
        for (let attempt = 0; attempt < 10 && requests.length < count; attempt++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(requests.length, count, `analysis revision ${count} should reach the compiler adapter`);
    };
    const revise = (text) => {
        fixture.document.getText = () => text;
        fixture.service.documentChanged(fixture.document);
        return fixture.service.check(fixture.document);
    };

    fixture.document.getText = () => "Dim firstRevision As Long\n";
    const first = fixture.service.check(fixture.document);
    await waitForRequest(1);
    const second = revise("Dim secondRevision As Double\n");
    await waitForRequest(2);
    const third = revise("Dim finalRevision As String\n");
    await waitForRequest(3);

    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(requests[2].signal.aborted, false);
    requests[0].finish();
    requests[1].finish();
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(fixture.service.snapshots.size, 0, "discarded revisions must not leave an intermediate model visible");

    requests[2].finish();
    assert.equal(await third, true);
    const snapshot = fixture.service.snapshots.get(fixture.document.uri.toString());
    assert.ok(snapshot);
    assert.equal(snapshot.sources.find((source) => source.uri.fsPath === fixture.filePath)?.text, "Dim finalRevision As String\n");
    assert.equal(fixture.service.getModel(fixture.document.uri), snapshot.model);
});

test("new compiler-only dependencies require a second verified pass", async (t) => {
    let dependency;
    const fixture = setup(t, (_options, result) => ({ ...result, dependencies: [...result.dependencies, dependency] }));
    dependency = path.join(fixture.directory, "defines.bi");
    fs.writeFileSync(dependency, "#define FEATURE 1\n");
    assert.equal(await fixture.service.check(fixture.document), true);
    assert.equal(fixture.calls(), 2);
    fs.writeFileSync(dependency, "#define FEATURE_CHANGED 1\n");
    assert.equal(fixture.service.getModel(fixture.document.uri), null);
});

test("trust lost during native work prevents snapshot publication and invalidates queued analysis", async (t) => {
    let finish;
    let dependency;
    const fixture = setup(t, (_options, result) => new Promise((resolve) => { finish = () => resolve({ ...result, dependencies: [...result.dependencies, dependency] }); }));
    dependency = path.join(fixture.directory, "discovered.bi");
    fs.writeFileSync(dependency, "Dim discoveredValue As Long\n");
    let cancelled = 0;
    fixture.service.analysisWorker = { cancelAll: () => cancelled++, dispose() {} };
    const pending = fixture.service.check(fixture.document);
    await new Promise((resolve) => setImmediate(resolve));
    fixture.workspace.isTrusted = false;
    finish();
    assert.equal(await pending, false);
    assert.equal(fixture.service.snapshots.size, 0);
    assert.equal(fixture.service.running.size, 0);
    assert.equal(cancelled, 1);
    assert.equal(fixture.calls(), 1, "Trust loss must also prevent the dependency verification pass");
});

test("on-change debounce retains affected modules across header edits and invalidation", async (t) => {
    const fixture = setup(t);
    const header = { uri: { fsPath: path.join(fixture.directory, "defines.bi"), toString: () => "file:///defines.bi" } };
    const second = { uri: { fsPath: path.join(fixture.directory, "second.bas"), toString: () => "file:///second.bas" } };
    fixture.workspace.textDocuments.push(second);
    fixture.workspace.getConfiguration = () => ({ get: (name, fallback) => name === "analysis.run" ? "onChange" : fallback });
    fixture.service.index.getDependentModules = () => [];
    fixture.service.snapshots.set(fixture.document.uri.toString(), { sources: [{ uri: header.uri }] });
    const checked = [];
    fixture.service.check = async (document) => { checked.push(document.uri.toString()); return true; };
    fixture.service.schedule(header);
    fixture.service.invalidate();
    fixture.service.schedule(second);
    fixture.service.schedule(second);
    assert.deepEqual(checked, []);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(checked, [fixture.document.uri.toString(), second.uri.toString()]);
});

test("selected headers use module options and immutable overlays with a closed module editor", async (t) => {
    let header;
    const fixture = setup(t, (options, result) => {
        assert.equal(options.filePath, fixture.filePath);
        assert.deepEqual(options.compilerArguments, ["-d", "DOUBLE_VALUE"]);
        assert.equal(options.overlays.get(header.uri.fsPath), header.getText());
        return { ...result, dependencies: [...result.dependencies, header.uri.fsPath] };
    });
    header = headerContext(fixture);
    fixture.workspace.textDocuments = [header];
    assert.equal(await fixture.service.check(header), true);
    const model = fixture.service.getModel(header.uri);
    assert.ok(model?.getDocument(header.uri));
    assert.equal(model, fixture.service.getModel(fixture.document.uri));
    assert.equal(fs.readFileSync(header.uri.fsPath, "utf8"), "Type ValueType As Long\n");
    fixture.values["analysis.activeContext"] = { name: "normal", module: "main.bas" };
    assert.equal(fixture.service.getModel(header.uri), null, "A different build cannot reuse a native snapshot");
    assert.equal(fixture.service.getModel(fixture.document.uri), null);
});

test("header analysis never guesses a module or accepts a header outside compiler dependencies", async (t) => {
    const fixture = setup(t);
    const header = headerContext(fixture);
    fixture.values["analysis.activeContext"] = null;
    assert.equal(await fixture.service.check(header), false);
    assert.equal(fixture.calls(), 0);
    fixture.values["analysis.activeContext"] = { name: "double", module: "main.bas" };
    assert.equal(await fixture.service.check(header), false);
    assert.equal(fixture.calls(), 1);
    assert.equal(fixture.service.getModel(header.uri), null);
    assert.equal(fixture.service.snapshots.size, 0);
});

test("context options changed during analysis cannot publish a snapshot", async (t) => {
    let finish;
    const fixture = setup(t, (_options, result) => new Promise((resolve) => { finish = () => resolve(result); }));
    headerContext(fixture);
    const pending = fixture.service.check(fixture.document);
    await new Promise((resolve) => setImmediate(resolve));
    fixture.values["analysis.projectContexts"][0].arguments = ["-d", "DIFFERENT_VALUE"];
    finish();
    assert.equal(await pending, false);
    assert.equal(fixture.service.snapshots.size, 0);
    assert.equal(fixture.service.running.size, 0);
});

test("invalidation during index preparation prevents compilation with an obsolete context", async (t) => {
    let finish;
    const fixture = setup(t);
    fixture.service.index.ensureInitialized = () => new Promise((resolve) => { finish = resolve; });
    const pending = fixture.service.check(fixture.document);
    fixture.service.invalidate();
    finish();
    assert.equal(await pending, false);
    assert.equal(fixture.calls(), 0);
});

test("selected header edits schedule analysis when the chosen module is closed", async (t) => {
    const fixture = setup(t);
    const header = headerContext(fixture);
    fixture.workspace.textDocuments = [header];
    fixture.values["analysis.run"] = "onChange";
    const checked = [];
    fixture.service.check = async (document) => { checked.push(document.uri.toString()); return true; };
    fixture.service.schedule(header);
    fixture.service.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(checked, [header.uri.toString()]);
});

test("context picker persists only the chosen folder context and cancellation leaves it unchanged", async (t) => {
    const fixture = setup(t);
    const header = headerContext(fixture);
    fixture.vscode.ConfigurationTarget = { WorkspaceFolder: 3 };
    const writes = [];
    fixture.workspace.getConfiguration = () => ({
        get: (name, fallback) => fixture.values[name] ?? fallback,
        update: async (name, value, target) => { writes.push([name, value, target]); fixture.values[name] = value; }
    });
    fixture.vscode.window.showQuickPick = async (items) => {
        assert.deepEqual(items.map((item) => item.label), ["double", "normal"]);
        return items[1];
    };
    let checked;
    fixture.service.check = async (document) => { checked = document; return true; };
    assert.equal(await fixture.service.selectContext(header), true);
    assert.equal(checked, header);
    assert.deepEqual(writes, [["analysis.activeContext", { name: "normal", module: "main.bas" }, 3]]);
    fixture.vscode.window.showQuickPick = async () => undefined;
    assert.equal(await fixture.service.selectContext(header), false);
    fixture.workspace.isTrusted = false;
    assert.equal(await fixture.service.selectContext(header), false);
    assert.equal(writes.length, 1);
});

test("analysis and rename share validated build contexts without silently changing module roots", () => {
    const root = process.cwd();
    const values = {
        "compiler.arguments": ["-lang", "fb"], "includePaths": ["${workspaceFolder}/headers"],
        "analysis.projectContexts": [{ name: "chosen", modules: ["main.bas", "other.bas"], arguments: ["-d", "FEATURE"] }],
        "analysis.activeContext": { name: "chosen", module: "main.bas" }
    };
    const configuration = { get: (name, fallback) => values[name] ?? fallback };
    const contexts = projectContexts(configuration, root);
    assert.deepEqual(analysisContext(configuration, root, path.join(root, "types.bi")), contexts[0]);
    assert.deepEqual(analysisContext(configuration, root, path.join(root, "other.bas")), contexts[1]);
    assert.deepEqual(contexts[0].compilerArguments, ["-lang", "fb", "-d", "FEATURE", "-i", path.join(root, "headers")]);
    assert.throws(() => analysisContext(configuration, root, path.join(root, "unlisted.bas")), /not part/);
    values["analysis.activeContext"] = { name: "missing", module: "main.bas" };
    assert.throws(() => analysisContext(configuration, root, path.join(root, "main.bas")), /not listed/);
    values["analysis.activeContext"] = "chosen";
    assert.throws(() => analysisContext(configuration, root, path.join(root, "main.bas")), /must contain/);
    values["analysis.projectContexts"].push({ name: "chosen", modules: ["other.bas"] });
    assert.throws(() => projectContexts(configuration, root), /unique/);
    values["analysis.projectContexts"].pop();
    values["analysis.projectContexts"][0].arguments = "-g";
    assert.throws(() => projectContexts(configuration, root), /arrays/);
});

/* end of tests/compiler-analysis-service.test.js */
