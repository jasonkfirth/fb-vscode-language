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

function createVscodeMock(documents) {
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
                    get(_name, defaultValue) {
                        return defaultValue;
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

/* end of tests/workspace-index.test.js */
