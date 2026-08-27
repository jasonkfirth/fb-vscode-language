/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/compiler-diagnostics.test.js

    Purpose:

        Verify safe compiler option handling and FreeBASIC diagnostic parsing.

    Responsibilities:

        - cover errors, warnings, source excerpts, and missing line numbers
        - reject unsafe or malformed compiler inputs
        - verify diagnostic path and numeric boundary helpers

    This file intentionally does NOT contain:

        - a dependency on an installed fbc executable
        - VS Code extension-host tests
        - filesystem modification
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
    parseCompilerOutput,
    validateCompilerOptions
} = require("../lib/compiler-diagnostics");
const {
    FreeBasicCompilerService,
    clampInteger,
    resolveDiagnosticPath
} = require("../lib/compiler-service");

function createCompilerServiceMock() {
    const messages = [];
    return {
        messages,
        vscode: {
            Uri: {
                parse(value) {
                    return { toString: () => value };
                }
            },
            window: {
                showErrorMessage(message) {
                    messages.push(message);
                },
                showInformationMessage() {},
                showWarningMessage() {}
            },
            workspace: {
                getConfiguration() {
                    return {
                        get(_name, defaultValue) {
                            return defaultValue;
                        }
                    };
                },
                isTrusted: true
            }
        }
    };
}

test("parseCompilerOutput handles current fbc errors and warnings", () => {
    const diagnostics = parseCompilerOutput([
        "FreeBASIC Compiler - Version 1.20.3",
        "source.bas(17) error 289: Expected sub, found 'worker' in 'threadcall worker()'",
        "library.o() warning 21(3): Object files or libraries with mixed language (-lang) options"
    ].join("\n"));

    assert.deepEqual(diagnostics, [
        {
            code: 289,
            filePath: "source.bas",
            line: 16,
            message: "Expected sub, found 'worker'",
            severity: "error",
            sourceText: "threadcall worker()",
            warningLevel: null
        },
        {
            code: 21,
            filePath: "library.o",
            line: 0,
            message: "Object files or libraries with mixed language (-lang) options",
            severity: "warning",
            sourceText: "",
            warningLevel: 3
        }
    ]);
});

test("validateCompilerOptions accepts command names but requires absolute source paths", () => {
    assert.doesNotThrow(() => validateCompilerOptions({
        compilerArguments: ["-w", "pedantic"],
        compilerPath: "fbc",
        filePath: path.resolve("tests/fixtures/declarations.bas")
    }));
    assert.throws(
        () => validateCompilerOptions({ compilerPath: "fbc", filePath: "relative.bas" }),
        /absolute path/
    );
    assert.throws(
        () => validateCompilerOptions({
            compilerArguments: ["safe", "bad\0argument"],
            compilerPath: "fbc",
            filePath: path.resolve("tests/fixtures/declarations.bas")
        }),
        /valid string/
    );
    assert.throws(
        () => validateCompilerOptions({
            compilerPath: "fbc",
            filePath: path.resolve("tests/fixtures/declarations.bas"),
            timeoutMs: 0
        }),
        /positive integer/
    );
});

test("diagnostic helpers clamp settings and normalize relative source paths", () => {
    assert.equal(clampInteger(500000, 1000, 300000), 300000);
    assert.equal(clampInteger("30000", 1000, 300000), 1000);
    assert.equal(
        resolveDiagnosticPath("/workspace/project", "includes/types.bi"),
        path.normalize("/workspace/project/includes/types.bi")
    );
    assert.equal(resolveDiagnosticPath("/workspace/project", "module.o"), "");
    assert.equal(resolveDiagnosticPath("/workspace/project", "MODULE.O"), "");
});

test("compiler service ignores an older failed run after a newer run completes", async () => {
    const pendingRuns = [];
    const mock = createCompilerServiceMock();
    const collection = {
        clear() {},
        delete() {},
        set() {}
    };
    const output = {
        appendLine() {}
    };
    const service = new FreeBasicCompilerService(
        mock.vscode,
        () => new Promise((resolve, reject) => pendingRuns.push({ reject, resolve })),
        collection,
        output
    );
    const uri = {
        fsPath: "/workspace/module.bas",
        scheme: "file",
        toString() {
            return "file:///workspace/module.bas";
        }
    };
    const document = {
        isDirty: false,
        languageId: "freebasic",
        uri
    };

    const firstCheck = service.checkDocument(document);
    const secondCheck = service.checkDocument(document);
    pendingRuns[1].resolve({ diagnostics: [], exitCode: 0, output: "", timedOut: false });
    const secondResult = await secondCheck;
    pendingRuns[0].reject(new Error("old compiler failure"));
    const firstResult = await firstCheck;

    assert.equal(secondResult.diagnosticCount, 0);
    assert.equal(firstResult.stale, true);
    assert.deepEqual(mock.messages, []);
});

/* end of tests/compiler-diagnostics.test.js */
