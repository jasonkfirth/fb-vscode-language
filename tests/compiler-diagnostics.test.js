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
    executeBoundedProcess,
    parseCompilerOutput,
    runFreeBasicCompiler,
    validateCompilerOptions
} = require("../lib/compiler-diagnostics");
const { CompilerProcessSupervisor } = require("../lib/compiler-process-supervisor");
const {
    FreeBasicCompilerService,
    clampInteger,
    compilerDiagnosticRange,
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
        "FreeBASIC Compiler - Version 1.20.4",
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
        path.resolve("/workspace/project/includes/types.bi")
    );
    assert.equal(resolveDiagnosticPath("/workspace/project", "module.o"), "");
    assert.equal(resolveDiagnosticPath("/workspace/project", "MODULE.O"), "");
});

test("compile diagnostics use physical tokens only when captured source still matches", () => {
    class Range {
        constructor(line, character, endLine, endCharacter) {
            this.start = { line, character };
            this.end = { line: endLine, character: endCharacter };
        }
    }
    const vscode = { Range };
    const source = "Print missingValue";
    const diagnostic = {
        line: 0,
        message: "Variable not declared, missingValue",
        sourceText: source,
        compilerDetail: "missingValue",
        physicalPoint: { line: 0, character: 6 }
    };
    const matchingDocument = {
        lineCount: 1,
        getText: () => source,
        lineAt: () => ({ text: source })
    };
    const precise = compilerDiagnosticRange(vscode, matchingDocument, diagnostic);
    assert.deepEqual(precise.start, { line: 0, character: 6 });
    assert.deepEqual(precise.end, { line: 0, character: 7 });

    const pointerSource = "intPointer = doublePointer\n";
    const pointerCharacter = pointerSource.indexOf("doublePointer");
    const pointerRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => pointerSource,
        lineAt: () => ({ text: pointerSource.trimEnd() })
    }, {
        line: 0,
        message: "Suspicious pointer assignment",
        severity: "warning",
        physicalPoint: { line: 0, character: pointerCharacter }
    });
    assert.deepEqual(pointerRange.start, { line: 0, character: pointerCharacter });
    assert.deepEqual(pointerRange.end, { line: 0, character: pointerCharacter + "doublePointer".length },
        "compiler-selected pointer assignment warnings should underline the full physical source identifier");

    const defaultMismatchSource = "Sub Consume(value As Integer = 2)\nEnd Sub\n";
    const procedureNameStart = defaultMismatchSource.indexOf("Consume");
    const defaultMismatchRange = compilerDiagnosticRange(vscode, {
        lineCount: 3,
        getText: () => defaultMismatchSource,
        lineAt: (line) => ({ text: defaultMismatchSource.split("\n")[line] })
    }, {
        line: 1,
        message: "Mismatching parameter initializer, at parameter 1 (value) of Consume()",
        severity: "warning",
        physicalPoint: { line: 0, character: procedureNameStart }
    });
    assert.deepEqual(defaultMismatchRange.start, { line: 0, character: procedureNameStart });
    assert.deepEqual(defaultMismatchRange.end, { line: 0, character: procedureNameStart + "Consume".length },
        "FBC's declaration point should replace its misleading End Sub display line");

    const functionPointerSource = "callback = @targetProcedure\n";
    const functionNameStart = functionPointerSource.indexOf("targetProcedure");
    for (const message of [
        "Return type mismatch in function pointer",
        "Return method mismatch in function pointer",
        "Calling convention mismatch in function pointer",
        "Argument count mismatch in function pointer"
    ]) {
        const range = compilerDiagnosticRange(vscode, {
            lineCount: 1,
            getText: () => functionPointerSource,
            lineAt: () => ({ text: functionPointerSource.trimEnd() })
        }, {
            line: 0,
            message,
            severity: "warning",
            physicalPoint: { line: 0, character: functionNameStart }
        });
        assert.deepEqual(range.start, { line: 0, character: functionNameStart }, message);
        assert.deepEqual(range.end, { line: 0, character: functionNameStart + "targetProcedure".length }, message);
    }

    const missingPointRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => functionPointerSource,
        lineAt: () => ({ text: functionPointerSource.trimEnd() })
    }, {
        line: 0,
        message: "Return type mismatch in function pointer",
        severity: "warning"
    });
    assert.deepEqual(missingPointRange.start, { line: 0, character: 0 },
        "macro-expanded warnings without a physical source point should keep their existing fallback");
    assert.deepEqual(missingPointRange.end, { line: 0, character: functionPointerSource.trimEnd().length });

    const overflowSource = "Dim narrowValue As Byte = 300\n";
    const literalStart = overflowSource.indexOf("300");
    const overflowRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => overflowSource,
        lineAt: () => ({ text: overflowSource.trimEnd() })
    }, {
        line: 0,
        message: "Overflow in constant conversion",
        severity: "warning",
        physicalPoint: { line: 0, character: literalStart }
    });
    assert.deepEqual(overflowRange.start, { line: 0, character: literalStart });
    assert.deepEqual(overflowRange.end, { line: 0, character: literalStart + 3 },
        "compile diagnostics should underline the full simple overflowing literal");

    const parameterSource = "TakeByte(300)\n";
    const parameterClose = parameterSource.indexOf(")");
    const parameterRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => parameterSource,
        lineAt: () => ({ text: parameterSource.trimEnd() })
    }, {
        line: 0,
        message: "Overflow in constant conversion, at parameter 1 (value) of TAKEBYTE()",
        severity: "warning",
        compilerDetail: "at parameter 1 (value) of TAKEBYTE()",
        physicalPoint: { line: 0, character: parameterClose }
    });
    assert.deepEqual(parameterRange.start, { line: 0, character: 0 });
    assert.deepEqual(parameterRange.end, { line: 0, character: parameterSource.trimEnd().length },
        "a compiler point at the call delimiter must not be presented as an argument location");

    const computedSource = "Dim computed As Byte = 300 + 1\n";
    const computedValueStart = computedSource.indexOf("1");
    const computedRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => computedSource,
        lineAt: () => ({ text: computedSource.trimEnd() })
    }, {
        line: 0,
        message: "Overflow in constant conversion",
        severity: "warning",
        physicalPoint: { line: 0, character: computedValueStart }
    });
    assert.deepEqual(computedRange.start, { line: 0, character: computedValueStart });
    assert.deepEqual(computedRange.end, { line: 0, character: computedValueStart + 1 },
        "compiler-selected token points in computed conversions should narrow the range");

    const operatorSource = "Print flag And 4\nPrint i Shl 64\n";
    for (const { line, message, token } of [
        {
            line: 0,
            message: "Suspicious logic operation, mixed boolean and non-boolean operands",
            token: "4"
        },
        {
            line: 1,
            message: "Shift value greater than or equal to number of bits in data type",
            token: "64"
        }
    ]) {
        const tokenStart = operatorSource.split("\n")[line].indexOf(token);
        const range = compilerDiagnosticRange(vscode, {
            lineCount: 3,
            getText: () => operatorSource,
            lineAt: (lineNumber) => ({ text: operatorSource.split("\n")[lineNumber] })
        }, {
            line,
            message,
            severity: "warning",
            physicalPoint: { line, character: tokenStart }
        });
        assert.deepEqual(range.start, { line, character: tokenStart }, message);
        assert.deepEqual(range.end, { line, character: tokenStart + token.length }, message);
    }

    const constnessSource = "Dim value As Const Integer = 1\nDim pointer As Const Integer Ptr = Cast(Integer Ptr, @value)\n";
    const constValueStart = constnessSource.split("\n")[1].indexOf("value");
    const constnessRange = compilerDiagnosticRange(vscode, {
        lineCount: 3,
        getText: () => constnessSource,
        lineAt: (line) => ({ text: constnessSource.split("\n")[line] })
    }, {
        line: 1,
        message: "CONST qualifier discarded",
        severity: "warning",
        physicalPoint: { line: 1, character: constValueStart }
    });
    assert.deepEqual(constnessRange.start, { line: 1, character: constValueStart });
    assert.deepEqual(constnessRange.end, { line: 1, character: constValueStart + "value".length });

    const largeStringSource = "Dim largeText As String * 9999999\n";
    const largeSizeStart = largeStringSource.indexOf("9999999");
    const largeStringRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => largeStringSource,
        lineAt: () => ({ text: largeStringSource.trimEnd() })
    }, {
        line: 0,
        message: "Variable too large for stack, consider making it SHARED",
        severity: "warning",
        physicalPoint: { line: 0, character: largeSizeStart }
    });
    assert.deepEqual(largeStringRange.start, { line: 0, character: largeSizeStart });
    assert.deepEqual(largeStringRange.end, { line: 0, character: largeSizeStart + "9999999".length });

    const largeArraySource = "Dim hugeArray(0 To 9999999) As Byte\n";
    const elementTypeStart = largeArraySource.indexOf("Byte");
    const largeArrayRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => largeArraySource,
        lineAt: () => ({ text: largeArraySource.trimEnd() })
    }, {
        line: 0,
        message: "Array too large for stack, consider making it var-len or SHARED",
        severity: "warning",
        physicalPoint: { line: 0, character: elementTypeStart }
    });
    assert.deepEqual(largeArrayRange.start, { line: 0, character: elementTypeStart });
    assert.deepEqual(largeArrayRange.end, { line: 0, character: elementTypeStart + "Byte".length });

    const conversionSource = "Print -&hFFFFFFFFFFFFFFFFu\n";
    const conversionLiteralStart = conversionSource.indexOf("&h");
    const conversionRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => conversionSource,
        lineAt: () => ({ text: conversionSource.trimEnd() })
    }, {
        line: 0,
        message: "Implicit conversion",
        severity: "warning",
        physicalPoint: { line: 0, character: conversionLiteralStart }
    });
    assert.deepEqual(conversionRange.start, { line: 0, character: conversionLiteralStart });
    assert.deepEqual(conversionRange.end, { line: 0, character: conversionLiteralStart + "&hFFFFFFFFFFFFFFFFu".length });

    const mismatchSource = "For outer = 1 To 2\nNext inner\n";
    const mismatchDiagnostic = {
        line: 1,
        message: "FOR/NEXT variable name mismatch",
        sourceText: "Next inner",
        compilerContext: "for-next-variable-mismatch",
        physicalPoint: { line: 1, character: 5 }
    };
    const mismatchDocument = {
        lineCount: 2,
        getText: () => mismatchSource,
        lineAt: (line) => ({ text: mismatchSource.split("\n")[line] })
    };
    const mismatchRange = compilerDiagnosticRange(vscode, mismatchDocument, mismatchDiagnostic);
    assert.deepEqual(mismatchRange.start, { line: 1, character: 5 });
    assert.deepEqual(mismatchRange.end, { line: 1, character: 10 });

    const signatureSource = "Declare Function chooseResult() As Integer\nFunction chooseResult() As Double\n";
    const signatureLine = "Function chooseResult() As Double";
    const signatureRange = compilerDiagnosticRange(vscode, {
        lineCount: 3,
        getText: () => signatureSource,
        lineAt: (line) => ({ text: signatureSource.split("\n")[line] })
    }, {
        line: 1,
        message: "Type mismatch, at procedure declaration",
        sourceText: signatureLine,
        compilerContext: "procedure-signature-mismatch",
        physicalPoint: { line: 1, character: 9 }
    });
    assert.deepEqual(signatureRange.start, { line: 1, character: 9 });
    assert.deepEqual(signatureRange.end, { line: 1, character: 21 });

    const resumeNextSource = "On Error Resume Next\n";
    const resumeNextRange = compilerDiagnosticRange(vscode, {
        lineCount: 2,
        getText: () => resumeNextSource,
        lineAt: (line) => ({ text: resumeNextSource.split("\n")[line] })
    }, {
        line: 0,
        message: "Syntax error, found 'Resume'",
        sourceText: "On Error Resume Next",
        compilerContext: "error-resume-next-syntax",
        physicalPoint: { line: 0, character: 0 }
    });
    assert.deepEqual(resumeNextRange.start, { line: 0, character: 0 });
    assert.deepEqual(resumeNextRange.end, { line: 0, character: 20 });

    const suffixSource = "Dim AS Integer firstValue, secondValue$\n";
    const suffixStart = suffixSource.indexOf("secondValue");
    const suffixRange = compilerDiagnosticRange(vscode, {
        lineCount: 2,
        getText: () => suffixSource,
        lineAt: (line) => ({ text: suffixSource.split("\n")[line] })
    }, {
        line: 0,
        message: "Syntax error, secondValue",
        sourceText: "",
        compilerContext: "declaration-suffix-as-conflict",
        physicalPoint: { line: 0, character: suffixStart }
    });
    assert.deepEqual(suffixRange.start, { line: 0, character: suffixStart });
    assert.deepEqual(suffixRange.end, { line: 0, character: suffixStart + "secondValue$".length });

    const ignoredSuffixSource = "Dim value% As Integer\n";
    const ignoredSuffixRange = compilerDiagnosticRange(vscode, {
        lineCount: 2,
        getText: () => ignoredSuffixSource,
        lineAt: (line) => ({ text: ignoredSuffixSource.split("\n")[line] })
    }, {
        line: 0,
        severity: "warning",
        message: "Suffix ignored",
        compilerDetail: "in 'value%'",
        sourceText: "value%",
        physicalPoint: { line: 0, character: 0 }
    });
    assert.deepEqual(ignoredSuffixRange.start, { line: 0, character: 4 });
    assert.deepEqual(ignoredSuffixRange.end, { line: 0, character: 10 });

    const parameterModeSource = "Sub Consume(value As Integer)\nEnd Sub\n";
    const parameterModeStart = parameterModeSource.indexOf("value");
    const parameterModeRange = compilerDiagnosticRange(vscode, {
        lineCount: 3,
        getText: () => parameterModeSource,
        lineAt: (line) => ({ text: parameterModeSource.split("\n")[line] })
    }, {
        line: 0,
        severity: "warning",
        message: "No explicit BYREF or BYVAL, at parameter 1 (value) of Consume()",
        sourceText: "",
        physicalPoint: { line: 0, character: parameterModeStart }
    });
    assert.deepEqual(parameterModeRange.start, { line: 0, character: parameterModeStart });
    assert.deepEqual(parameterModeRange.end, { line: 0, character: parameterModeStart + "value".length });

    const implicitAllocationSource = "Sub Probe()\n    Print implicitValue\nEnd Sub\n";
    const implicitLine = 1;
    const implicitStart = implicitAllocationSource.split("\n")[implicitLine].indexOf("implicitValue");
    const implicitAllocationRange = compilerDiagnosticRange(vscode, {
        lineCount: 4,
        getText: () => implicitAllocationSource,
        lineAt: (line) => ({ text: implicitAllocationSource.split("\n")[line] })
    }, {
        line: implicitLine,
        severity: "warning",
        message: "Implicit variable allocation,",
        sourceText: "",
        compilerDetail: "implicitValue",
        physicalPoint: { line: implicitLine, character: 4 }
    });
    assert.deepEqual(implicitAllocationRange.start, { line: implicitLine, character: implicitStart });
    assert.deepEqual(implicitAllocationRange.end, {
        line: implicitLine, character: implicitStart + "implicitValue".length
    });

    const allocationWarningWithoutSourceText = compilerDiagnosticRange(vscode, {
        lineCount: 4,
        getText: () => implicitAllocationSource,
        lineAt: (line) => ({ text: implicitAllocationSource.split("\n")[line] })
    }, {
        line: implicitLine,
        severity: "warning",
        message: "Implicit variable allocation, in 'implicitValue'",
        sourceText: "",
        compilerDetail: "implicitValue",
        physicalPoint: { line: implicitLine, character: 4 }
    });
    assert.deepEqual(allocationWarningWithoutSourceText.start, { line: implicitLine, character: implicitStart });
    assert.deepEqual(allocationWarningWithoutSourceText.end, {
        line: implicitLine, character: implicitStart + "implicitValue".length
    });

    const nextWarningSource = "For index = 1 To 2\nNext index\n";
    const nextWarningRange = compilerDiagnosticRange(vscode, {
        lineCount: 3,
        getText: () => nextWarningSource,
        lineAt: (line) => ({ text: nextWarningSource.split("\n")[line] })
    }, {
        line: 1,
        severity: "warning",
        message: "Variable following NEXT is meaningless, index",
        sourceText: "",
        physicalPoint: { line: 1, character: 5 }
    });
    assert.deepEqual(nextWarningRange.start, { line: 1, character: 5 });
    assert.deepEqual(nextWarningRange.end, { line: 1, character: 10 });

    const lineInputSource = "Dim buffer As ZString Ptr\nLine Input *buffer\n";
    const lineInputRange = compilerDiagnosticRange(vscode, {
        lineCount: 3,
        getText: () => lineInputSource,
        lineAt: (line) => ({ text: lineInputSource.split("\n")[line] })
    }, {
        line: 1,
        message: "Expected ','",
        sourceText: "Line Input *buffer",
        compilerContext: "line-input-unknown-buffer-capacity",
        physicalPoint: { line: 1, character: 12 }
    });
    assert.deepEqual(lineInputRange.start, { line: 1, character: 12 });
    assert.deepEqual(lineInputRange.end, { line: 1, character: 18 });

    const unterminatedSource = "Print \"unterminated text   ";
    const unterminatedLine = unterminatedSource;
    const missingQuoteRange = compilerDiagnosticRange(vscode, {
        lineCount: 1,
        getText: () => unterminatedSource,
        lineAt: () => ({ text: unterminatedLine })
    }, {
        line: 0,
        severity: "warning",
        message: "Missing closing quote in literal string",
        physicalPoint: { line: 0, character: unterminatedLine.length }
    });
    assert.deepEqual(missingQuoteRange.start, { line: 0, character: unterminatedLine.indexOf("\"") });
    assert.deepEqual(missingQuoteRange.end, { line: 0, character: unterminatedLine.length });

    const changedText = "Print changedValue";
    const staleDocument = {
        lineCount: 1,
        getText: () => changedText,
        lineAt: () => ({ text: changedText })
    };
    const fallback = compilerDiagnosticRange(vscode, staleDocument, diagnostic);
    assert.deepEqual(fallback.start, { line: 0, character: 0 }, "an unsaved change must prevent stale physical positions");

    assert.doesNotThrow(() => compilerDiagnosticRange(vscode, matchingDocument, {
        ...diagnostic,
        physicalPoint: { line: 100, character: 0 }
    }), "an out-of-range point must fall back instead of throwing");
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

test("bounded processes cancel without waiting for the compiler timeout", async () => {
    const controller = new AbortController();
    const pending = executeBoundedProcess({
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(), maxOutputBytes: 1024, timeoutMs: 10000, signal: controller.signal
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
});

test("bounded processes preserve Unicode split across output chunks", async () => {
    const result = await executeBoundedProcess({
        command: process.execPath,
        arguments: ["-e", "const b=Buffer.from('café');process.stdout.write(b.subarray(0,4));setTimeout(()=>process.stdout.write(b.subarray(4)),20)"],
        cwd: process.cwd(), maxOutputBytes: 1024, timeoutMs: 10000
    });
    assert.equal(result.stdout, "café");
    assert.equal(result.exitCode, 0);
});

test("profiled processes measure only the synchronous child spawn call", async () => {
    const result = await executeBoundedProcess({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('profiled')"],
        cwd: process.cwd(), maxOutputBytes: 1024, timeoutMs: 10000, profileOutput: true
    });

    assert.equal(result.stdout, "profiled");
    assert.equal(result.exitCode, 0);
    assert.ok(Number.isFinite(result.outputProfile?.spawnCallMs));
    assert.ok(result.outputProfile.spawnCallMs >= 0);
});

test("diagnostic compiler execution can use the reusable process supervisor", async (t) => {
    const supervisor = new CompilerProcessSupervisor();
    t.after(async () => supervisor.dispose());
    const result = await executeBoundedProcess({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write(String(process.ppid))"],
        cwd: process.cwd(),
        maxOutputBytes: 1024,
        timeoutMs: 10000,
        processSupervisor: supervisor
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, String(supervisor.child.pid));
});

test("syntax diagnostics preserve compiler output through the process supervisor", async (t) => {
    const supervisor = new CompilerProcessSupervisor();
    t.after(async () => supervisor.dispose());
    const filePath = path.join(process.cwd(), "supervised-diagnostic.bas");
    const result = await runFreeBasicCompiler({
        compilerPath: process.execPath,
        filePath,
        compilerArguments: ["-e", "process.stdout.write('supervised-diagnostic.bas(1) error 17: simulated')", "--"],
        cwd: process.cwd(),
        structuredDiagnostics: false,
        timeoutMs: 10000,
        processSupervisor: supervisor
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 17);
    assert.equal(result.diagnostics[0].filePath, "supervised-diagnostic.bas");
});

test("normal compiler diagnostics retry when FBCDIA is unsupported", async () => {
    const filePath = path.resolve("fallback-diagnostic.bas");
    const script = [
        "if (process.argv.includes('-semantic-diagnostics')) {",
        "process.stderr.write(\"fbc: unrecognized option 'semantic-diagnostics'\");",
        "process.exit(1);",
        "}",
        `process.stdout.write(${JSON.stringify(`${filePath}(1) error 17: fallback diagnostic`)});`
    ].join("");
    const result = await runFreeBasicCompiler({
        compilerPath: process.execPath,
        filePath,
        compilerArguments: ["-e", script, "--"],
        structuredDiagnostics: true,
        timeoutMs: 10000
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].message, "fallback diagnostic");
    assert.equal(result.arguments.includes("-semantic-diagnostics"), false);
});

test("clearing compiler state cannot reuse an older run generation", async () => {
    const pending = [];
    const mock = createCompilerServiceMock();
    const service = new FreeBasicCompilerService(mock.vscode,
        () => new Promise((resolve) => pending.push(resolve)),
        { clear() {}, delete() {}, set() {} }, { appendLine() {} });
    const document = { isDirty: false, languageId: "freebasic", uri: { scheme: "file", fsPath: "/workspace/module.bas", toString: () => "file:///workspace/module.bas" } };
    const first = service.checkDocument(document);
    service.clearAll();
    const second = service.checkDocument(document);
    pending[0]({ diagnostics: [], exitCode: 0, output: "", timedOut: false });
    assert.equal((await first).stale, true);
    pending[1]({ diagnostics: [], exitCode: 0, output: "", timedOut: false });
    assert.equal((await second).diagnosticCount, 0);
});

/* end of tests/compiler-diagnostics.test.js */
