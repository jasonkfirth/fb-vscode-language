/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-diagnostics.js

    Purpose:

        Run the real FreeBASIC compiler in compile-only mode and translate its
        textual and structured diagnostics into editor-neutral records.

    Responsibilities:

        - execute fbc without a command shell
        - isolate compiler output in a temporary directory
        - bound execution time and captured output
        - parse FreeBASIC error and warning locations
        - use FBCDIA physical points when the compiler provides them

    This file intentionally does NOT contain:

        - VS Code diagnostics or user-interface calls
        - workspace trust policy
        - automatic save-event behavior
*/

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const {
    attachStructuredDiagnosticData,
    compilerDoesNotSupportStructuredDiagnostics,
    decodeCompilerDiagnosticSidecar
} = require("./compiler-diagnostic-sidecar");

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
    const diagnosticSidecarPath = path.join(temporaryDirectory, "compiler.fbcdia");
    const configuredArguments = options.compilerArguments || [];
    const baseCompilerArguments = [
        ...configuredArguments,
        "-c",
        "-maxerr",
        String(options.maxErrors || DEFAULT_MAX_ERRORS),
        "-o",
        objectPath,
        options.filePath
    ];
    const requestStructuredDiagnostics = options.structuredDiagnostics !== false &&
        !configuredArguments.some((argument) => argument.toLowerCase() === "-semantic-diagnostics");
    let compilerArguments = requestStructuredDiagnostics
        ? [...configuredArguments, "-semantic-diagnostics", diagnosticSidecarPath, ...baseCompilerArguments.slice(configuredArguments.length)]
        : baseCompilerArguments;

    try {
        const executeCompiler = (arguments_) => executeBoundedProcess({
            arguments: arguments_,
            command: options.compilerPath,
            cwd: options.cwd || path.dirname(options.filePath),
            processSupervisor: options.processSupervisor,
            maxOutputBytes: options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES,
            timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
            signal: options.signal
        });
        let execution = await executeCompiler(compilerArguments);
        let output = [execution.stdout, execution.stderr].filter(Boolean).join("\n");
        if (requestStructuredDiagnostics && compilerDoesNotSupportStructuredDiagnostics(output)) {
            compilerArguments = baseCompilerArguments;
            execution = await executeCompiler(compilerArguments);
            output = [execution.stdout, execution.stderr].filter(Boolean).join("\n");
        }

        let structuredDiagnostics = [];
        let structuredDiagnosticSources = [];
        let structuredDiagnosticSourcesComplete = false;
        if (requestStructuredDiagnostics && compilerArguments !== baseCompilerArguments &&
            !execution.cancelled && !execution.timedOut && !execution.outputTruncated && !execution.signal) {
            try {
                if (fs.statSync(diagnosticSidecarPath).size <= 64 * 1024 * 1024) {
                    const sidecar = decodeCompilerDiagnosticSidecar(fs.readFileSync(diagnosticSidecarPath), {
                        cwd: options.cwd || path.dirname(options.filePath),
                        compilerExitCode: execution.exitCode
                    });
                    structuredDiagnostics = sidecar.diagnostics;
                    /* SRC records include opened headers even when they have no diagnostics. */
                    structuredDiagnosticSources = sidecar.sources;
                    structuredDiagnosticSourcesComplete = true;
                }
            } catch {
                /* Line-based output remains available if an older compiler omits this artifact. */
            }
        }
        const cwd = options.cwd || path.dirname(options.filePath);
        const diagnostics = attachStructuredDiagnosticData(parseCompilerOutput(output), structuredDiagnostics, cwd);
        if (!structuredDiagnosticSourcesComplete) {
            structuredDiagnosticSources = [...new Set([
                path.resolve(cwd, options.filePath),
                ...diagnostics.map((diagnostic) => path.resolve(cwd, diagnostic.filePath))
            ])];
        }

        return {
            ...execution,
            arguments: compilerArguments,
            diagnostics,
            diagnosticSources: structuredDiagnosticSources,
            diagnosticSourcesComplete: structuredDiagnosticSourcesComplete,
            output
        };
    } finally {
        /* The directory name comes directly from mkdtempSync(), not user input. */
        fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
}

function executeBoundedProcess(options) {
    if (options.processSupervisor) {
        const { processSupervisor, ...request } = options;
        if (!request.env) request.env = process.env;
        return processSupervisor.execute(request);
    }
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            resolve({ exitCode: -1, cancelled: true, outputTruncated: false, timedOut: false, signal: "", stdout: "", stderr: "" });
            return;
        }
        const profileOutput = options.profileOutput === true;
        const spawnStarted = profileOutput ? performance.now() : 0;
        const child = childProcess.spawn(options.command, options.arguments, {
            cwd: options.cwd,
            env: options.env || process.env,
            shell: false,
            windowsHide: true,
            /* A Unix process group includes assemblers launched by fbc. */
            detached: process.platform !== "win32"
        });
        const spawnCallMs = profileOutput ? performance.now() - spawnStarted : 0;
        // The analysis host tracks native-child ownership across worker exits.
        // This internal observer is not a configurable compiler argument.
        let reportedProcess = Boolean(child.pid);
        if (reportedProcess) options.onProcess?.(child.pid);
        const releaseProcess = () => {
            if (!reportedProcess) return;
            reportedProcess = false;
            options.onProcess?.(null);
        };
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let outputTruncated = false;
        let timedOut = false;
        let cancelled = false;
        let forceKillTimeout = null;
        let outputChunkCount = 0, totalOutputChunkHandlerMs = 0;
        let maximumOutputChunkHandlerMs = 0, maximumOutputChunkBytes = 0;

        const killCompiler = (signal = "SIGTERM") => {
            try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch (error) {
                if (error.code !== "ESRCH") child.kill(signal);
            }
        };
        const stopCompiler = () => {
            killCompiler();
            if (!forceKillTimeout) forceKillTimeout = setTimeout(() => killCompiler("SIGKILL"), 1000);
        };
        const abort = () => { cancelled = true; stopCompiler(); };
        options.signal?.addEventListener("abort", abort, { once: true });

        const appendOutput = (current, chunk) => {
            const chunkHandlerStarted = profileOutput ? performance.now() : 0;
            const chunkBytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remainingBytes = Math.max(0, options.maxOutputBytes - outputBytes);

            if (remainingBytes === 0) {
                outputTruncated = true;
                if (profileOutput) {
                    const handlerMs = performance.now() - chunkHandlerStarted;
                    outputChunkCount++;
                    totalOutputChunkHandlerMs += handlerMs;
                    maximumOutputChunkHandlerMs = Math.max(maximumOutputChunkHandlerMs, handlerMs);
                    maximumOutputChunkBytes = Math.max(maximumOutputChunkBytes, chunkBytes.length);
                }
                return current;
            }

            const acceptedBytes = chunkBytes.subarray(0, remainingBytes);
            outputBytes += acceptedBytes.length;
            if (acceptedBytes.length < chunkBytes.length) {
                outputTruncated = true;
            }
            current.push(acceptedBytes);
            if (profileOutput) {
                const handlerMs = performance.now() - chunkHandlerStarted;
                outputChunkCount++;
                totalOutputChunkHandlerMs += handlerMs;
                maximumOutputChunkHandlerMs = Math.max(maximumOutputChunkHandlerMs, handlerMs);
                maximumOutputChunkBytes = Math.max(maximumOutputChunkBytes, chunkBytes.length);
            }
            return current;
        };

        child.stdout.on("data", (chunk) => {
            appendOutput(stdout, chunk);
        });
        child.stderr.on("data", (chunk) => {
            appendOutput(stderr, chunk);
        });

        const timeout = setTimeout(() => {
            timedOut = true;
            stopCompiler();
        }, options.timeoutMs);

        child.once("error", (error) => {
            releaseProcess();
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            if (forceKillTimeout) {
                clearTimeout(forceKillTimeout);
            }
            reject(error);
        });

        child.once("close", (exitCode, signal) => {
            releaseProcess();
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            if (forceKillTimeout) {
                clearTimeout(forceKillTimeout);
            }
            const finalizeStarted = profileOutput ? performance.now() : 0;
            const stderrText = Buffer.concat(stderr).toString("utf8");
            const stdoutText = Buffer.concat(stdout).toString("utf8");
            const outputProfile = profileOutput ? {
                spawnCallMs,
                outputBytes,
                outputChunkCount,
                totalOutputChunkHandlerMs,
                maximumOutputChunkHandlerMs,
                maximumOutputChunkBytes,
                outputFinalizeMs: performance.now() - finalizeStarted
            } : undefined;
            resolve({
                exitCode: typeof exitCode === "number" ? exitCode : -1,
                cancelled,
                outputTruncated,
                signal: signal || "",
                stderr: stderrText,
                stdout: stdoutText,
                timedOut,
                ...(outputProfile ? { outputProfile } : {})
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

    if (options.structuredDiagnostics !== undefined && typeof options.structuredDiagnostics !== "boolean") {
        throw new TypeError("structuredDiagnostics must be a boolean.");
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
