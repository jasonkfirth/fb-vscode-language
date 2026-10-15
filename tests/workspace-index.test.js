/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/workspace-index.test.js

    Purpose:

        Verify the reusable FreeBASIC workspace analysis cache.

    Responsibilities:

        - index declarations and occurrences across multiple documents
        - replace stale symbols after a document changes
        - remove deleted files from all index views

    This file intentionally does NOT contain:

        - VS Code extension-host startup
        - filesystem access
        - provider presentation behavior
*/

const test = require("node:test");
const assert = require("node:assert/strict");

const { FreeBasicWorkspaceIndex } = require("../lib/workspace-index");

function createUri(filePath) {
    return {
        fsPath: filePath,
        toString() {
            return `file://${filePath}`;
        }
    };
}

function createDocument(uri, text, version = 1) {
    return {
        getText() {
            return text;
        },
        languageId: "freebasic",
        uri,
        version
    };
}

function createVscodeMock(documents, settings = {}) {
    return {
        workspace: {
            fs: {
                async readFile(uri) {
                    const document = documents.get(uri.toString());
                    if (!document) {
                        throw new Error("Document was removed.");
                    }
                    return Buffer.from(document.getText(), "utf8");
                }
            },
            async findFiles(_include, _exclude, maxFiles) {
                return [...documents.values()].slice(0, maxFiles).map((document) => document.uri);
            },
            getConfiguration() {
                return {
                    get(name, defaultValue) {
                        return settings[name] ?? defaultValue;
                    }
                };
            },
            textDocuments: [],
            async openTextDocument(uri) {
                const document = documents.get(uri.toString());
                if (!document) {
                    throw new Error("Document was removed.");
                }
                return document;
            }
        }
    };
}

test("workspace index finds simple and qualified declarations", async () => {
    const firstUri = createUri("/workspace/first.bas");
    const secondUri = createUri("/workspace/second.bi");
    const documents = new Map([
        [firstUri.toString(), createDocument(firstUri, [
            "Namespace Demo",
            "Sub Work()",
            "    Print SharedValue",
            "End Sub",
            "End Namespace"
        ].join("\n"))],
        [secondUri.toString(), createDocument(secondUri, "Dim Shared SharedValue As Integer")]
    ]);
    const index = new FreeBasicWorkspaceIndex(createVscodeMock(documents), "freebasic");

    await index.ensureInitialized();

    const qualified = await index.findDeclarations("Demo.Work");
    const occurrences = await index.findOccurrences("SharedValue");

    assert.equal(qualified.length, 1);
    assert.equal(qualified[0].declaration.type, "sub");
    assert.equal(occurrences.length, 2);
    assert.equal(index.getAllDeclarations().length, 3);
});

test("workspace index can provide source resolution beside a remote compiler model", async () => {
    const uri = createUri("/workspace/module.bas");
    const documents = new Map([[uri.toString(), createDocument(uri, "Dim sourceValue As Integer")]]);
    const index = new FreeBasicWorkspaceIndex(createVscodeMock(documents), "freebasic");
    const compilerModel = { remote: true, semanticSidecarOnly: false };
    index.compilerAnalysis = { getModel: () => compilerModel };
    await index.ensureInitialized();

    const compiler = index.getSemanticModel(uri);
    const source = index.getSemanticModel(uri, { sourceOnly: true });

    assert.equal(compiler, compilerModel);
    assert.notEqual(source, compilerModel);
    assert.equal(source.resolveAt(uri, 0, 6)[0].name, "sourceValue");
});

test("workspace index supplies transitive include paths as compiler dependency hints", () => {
    const root = createUri("/workspace/main.bas");
    const header = createUri("/workspace/include/api.bi");
    const nested = createUri("/workspace/include/types.bi");
    const unrelated = createUri("/workspace/other.bi");
    const index = new FreeBasicWorkspaceIndex({ Uri: { file: createUri } }, "freebasic");
    index.documents.set(root.toString(), { uri: root, includeUris: new Set([header.toString()]) });
    index.documents.set(header.toString(), { uri: header, includeUris: new Set([nested.toString()]) });
    index.documents.set(nested.toString(), { uri: nested, includeUris: new Set([header.toString()]) });
    index.documents.set(unrelated.toString(), { uri: unrelated, includeUris: new Set() });

    assert.deepEqual(index.includeDependencyHints(root.fsPath), [header.fsPath, nested.fsPath]);
    assert.deepEqual(index.includeDependencyHints(unrelated.fsPath), []);
    assert.deepEqual(index.includeDependencyHints("/workspace/not-indexed.bas"), []);
});

test("workspace index replaces changed symbols and removes deleted files", async () => {
    const uri = createUri("/workspace/module.bas");
    const documents = new Map([
        [uri.toString(), createDocument(uri, "Dim OldName As Integer")]
    ]);
    const index = new FreeBasicWorkspaceIndex(createVscodeMock(documents), "freebasic");

    await index.ensureInitialized();
    assert.equal((await index.findDeclarations("OldName")).length, 1);

    documents.set(uri.toString(), createDocument(uri, "Dim NewName As Integer", 2));
    await index.refreshUri(uri);

    assert.equal((await index.findDeclarations("OldName")).length, 0);
    assert.equal((await index.findDeclarations("NewName")).length, 1);

    documents.delete(uri.toString());
    await index.refreshUri(uri);
    assert.equal(index.getAllDeclarations().length, 0);
});

test("a late filesystem read cannot overwrite a newer document version", async () => {
    const uri = createUri("/workspace/race.bas");
    const vscode = createVscodeMock(new Map());
    let finishRead;
    vscode.workspace.fs.readFile = () => new Promise((resolve) => { finishRead = resolve; });
    const index = new FreeBasicWorkspaceIndex(vscode, "freebasic");
    const pending = index.refreshUri(uri);
    const current = createDocument(uri, "Dim CurrentValue As Long", 2);
    vscode.workspace.textDocuments.push(current);
    index.refreshDocument(current);
    finishRead(Buffer.from("Dim OldValue As Long"));
    await pending;
    assert.deepEqual(index.getAllDeclarations().map((entry) => entry.declaration.name), ["CurrentValue"]);
});

test("removed files cannot be resurrected by a pending read", async () => {
    const uri = createUri("/workspace/deleted.bas");
    const vscode = createVscodeMock(new Map());
    let finishRead;
    vscode.workspace.fs.readFile = () => new Promise((resolve) => { finishRead = resolve; });
    const index = new FreeBasicWorkspaceIndex(vscode, "freebasic");
    const pending = index.refreshUri(uri);
    index.removeUri(uri);
    finishRead(Buffer.from("Dim RemovedValue As Long"));
    await pending;
    assert.equal(index.getAllDeclarations().length, 0);
});

test("file and size limits mark incomplete indexes instead of silently allowing rename", async () => {
    const first = createUri("/workspace/first.bas");
    const second = createUri("/workspace/second.bas");
    const documents = new Map([
        [first.toString(), createDocument(first, "Dim FirstValue As Long")],
        [second.toString(), createDocument(second, "Dim SecondValue As Long")]
    ]);
    const index = new FreeBasicWorkspaceIndex(createVscodeMock(documents, { "index.maxFiles": 1 }), "freebasic");
    await index.ensureInitialized();
    assert.equal(index.documents.size, 1);
    assert.equal(index.isIncomplete(), true);

    documents.delete(second.toString());
    documents.set(first.toString(), createDocument(first, "'" + "x".repeat(2048)));
    const sizeIndex = new FreeBasicWorkspaceIndex(createVscodeMock(documents, { "index.maxFileSizeKB": 1 }), "freebasic");
    await sizeIndex.ensureInitialized();
    assert.equal(sizeIndex.documents.size, 0);
    assert.equal(sizeIndex.isIncomplete(), true);
    sizeIndex.refreshDocument(documents.get(first.toString()));
    assert.equal(sizeIndex.documents.size, 1, "Open documents remain available");
    assert.equal(sizeIndex.isIncomplete(), false);
});

test("unchanged provider requests reuse include traversal and cancellation is retryable", async () => {
    const uri = createUri("/workspace/main.bas");
    const documents = new Map([[uri.toString(), createDocument(uri, "Dim FirstValue As Long")]]);
    const index = new FreeBasicWorkspaceIndex(createVscodeMock(documents), "freebasic");
    assert.equal(await index.ensureInitialized({ isCancellationRequested: true }), false);
    let traversals = 0;
    const refresh = index.refreshIncludes.bind(index);
    index.refreshIncludes = async (...args) => { traversals++; return refresh(...args); };
    await index.ensureInitialized();
    const initial = traversals;
    await Promise.all([index.ensureInitialized(), index.ensureInitialized()]);
    assert.equal(traversals, initial);
    index.refreshDocument(createDocument(uri, "Dim NewValue As Long", 2));
    await index.ensureInitialized();
    assert.equal(traversals, initial + 1);
});

/* end of tests/workspace-index.test.js */
