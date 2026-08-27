/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-diagnostics.js

    Purpose:

        Run the real FreeBASIC compiler in compile-only mode and translate its
        textual diagnostics into editor-neutral records.

    Responsibilities:

        - execute fbc without a command shell
        - isolate compiler output in a temporary directory
        - bound execution time and captured output
        - parse FreeBASIC error and warning locations

    This file intentionally does NOT contain:

        - VS Code diagnostics or user-interface calls
        - workspace trust policy
        - automatic save-event behavior
*/

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_MAX_ERRORS = 50;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------------- */
/* Bounded compiler execution                                                */
/* ------------------------------------------------------------------------- */

async function runFreeBasicCompiler(options) {
    validateCompilerOptions(options);

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-vscode-check-"));
    const objectPath = path.join(temporaryDirectory, "syntax-check.o");
    const compilerArguments = [
        ...(options.compilerArguments || []),
        "-c",
        "-maxerr",
        String(options.maxErrors || DEFAULT_MAX_ERRORS),
        "-o",
        objectPath,
        options.filePath
    ];

    try {
        const execution = await executeBoundedProcess({
            arguments: compilerArguments,
            command: options.compilerPath,
            cwd: options.cwd || path.dirname(options.filePath),
            maxOutputBytes: options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES,
            timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
        });
        const output = [execution.stdout, execution.stderr]
            .filter(Boolean)
            .join("\n");

        return {
            ...execution,
            arguments: compilerArguments,
            diagnostics: parseCompilerOutput(output),
            output
        };
    } finally {
        /* The directory name comes directly from mkdtempSync(), not user input. */
        fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
}

function executeBoundedProcess(options) {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(options.command, options.arguments, {
            cwd: options.cwd,
            shell: false,
            windowsHide: true
        });
        let stdout = "";
        let stderr = "";
        let outputBytes = 0;
        let outputTruncated = false;
        let timedOut = false;
        let forceKillTimeout = null;

        const appendOutput = (current, chunk) => {
            const chunkBytes = Buffer.from(chunk);
            const remainingBytes = Math.max(0, options.maxOutputBytes - outputBytes);

            if (remainingBytes === 0) {
                outputTruncated = true;
                return current;
            }

            const acceptedBytes = chunkBytes.subarray(0, remainingBytes);
            outputBytes += acceptedBytes.length;
            if (acceptedBytes.length < chunkBytes.length) {
                outputTruncated = true;
            }
            return current + acceptedBytes.toString("utf8");
        };

        child.stdout.on("data", (chunk) => {
            stdout = appendOutput(stdout, chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr = appendOutput(stderr, chunk);
        });

        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill();
            forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 1000);
        }, options.timeoutMs);

        child.once("error", (error) => {
            clearTimeout(timeout);
            if (forceKillTimeout) {
                clearTimeout(forceKillTimeout);
            }
            reject(error);
        });

        child.once("close", (exitCode, signal) => {
            clearTimeout(timeout);
            if (forceKillTimeout) {
                clearTimeout(forceKillTimeout);
            }
            resolve({
                exitCode: typeof exitCode === "number" ? exitCode : -1,
                outputTruncated,
                signal: signal || "",
                stderr,
                stdout,
                timedOut
            });
        });
    });
}

/* ------------------------------------------------------------------------- */
/* Diagnostic parsing and input validation                                   */
/* ------------------------------------------------------------------------- */

function parseCompilerOutput(output) {
    const diagnostics = [];
    const diagnosticPattern = /^(.+?)\((\d*)\)\s+(error|warning)\s+(\d+)(?:\((\d+)\))?:\s*(.+)$/i;

    for (const line of String(output || "").split(/\r?\n/)) {
        const match = line.match(diagnosticPattern);
        if (!match) {
            continue;
        }

        const sourceMatch = match[6].match(/^(.*?)\s+in\s+'(.*)'$/);
        diagnostics.push({
            code: Number.parseInt(match[4], 10),
            filePath: match[1],
            line: match[2] ? Math.max(0, Number.parseInt(match[2], 10) - 1) : 0,
            message: (sourceMatch ? sourceMatch[1] : match[6]).trim(),
            severity: match[3].toLowerCase(),
            sourceText: sourceMatch ? sourceMatch[2] : "",
            warningLevel: match[5] ? Number.parseInt(match[5], 10) : null
        });
    }

    return diagnostics;
}

function validateCompilerOptions(options) {
    if (!options || typeof options !== "object") {
        throw new TypeError("Compiler options are required.");
    }

    if (typeof options.compilerPath !== "string" || !options.compilerPath.trim() || options.compilerPath.includes("\0")) {
        throw new TypeError("compilerPath must be a non-empty string.");
    }

    if (typeof options.filePath !== "string" || options.filePath.includes("\0") || !path.isAbsolute(options.filePath)) {
        throw new TypeError("filePath must be an absolute path.");
    }

    if (options.compilerArguments && !Array.isArray(options.compilerArguments)) {
        throw new TypeError("compilerArguments must be an array.");
    }

    for (const argument of options.compilerArguments || []) {
        if (typeof argument !== "string" || argument.includes("\0")) {
            throw new TypeError("Every compiler argument must be a valid string.");
        }
    }

    validateOptionalPositiveInteger(options.maxErrors, "maxErrors");
    validateOptionalPositiveInteger(options.maxOutputBytes, "maxOutputBytes");
    validateOptionalPositiveInteger(options.timeoutMs, "timeoutMs");
}

function validateOptionalPositiveInteger(value, name) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new TypeError(`${name} must be a positive integer.`);
    }
}

module.exports = {
    DEFAULT_MAX_ERRORS,
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_TIMEOUT_MS,
    executeBoundedProcess,
    parseCompilerOutput,
    runFreeBasicCompiler,
    validateOptionalPositiveInteger,
    validateCompilerOptions
};

/* end of lib/compiler-diagnostics.js */
