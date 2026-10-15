/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-process-runner.js
    Purpose: Spawn and reap bounded compiler processes outside the editor host.
    Responsibilities: execute validated commands, capture bounded output, cancel children.
    Does not contain: request policy, compiler parsing, or editor state.
*/

const childProcess = require("child_process");
const { performance } = require("perf_hooks");

const MAX_PENDING_PROCESSES = 16;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1000;

const children = new Map();
let shuttingDown = false;

function send(message) {
    if (!process.connected) return;
    try { process.send(message, () => {}); }
    catch { /* A disconnected supervisor parent cannot consume this reply. */ }
}

function validRequest(message) {
    const options = message?.options;
    return message?.type === "execute" && Number.isSafeInteger(message.id) && message.id > 0 &&
        options && typeof options === "object" && typeof options.command === "string" && options.command.length > 0 &&
        !options.command.includes("\0") && typeof options.cwd === "string" && options.cwd.length > 0 &&
        !options.cwd.includes("\0") && Array.isArray(options.arguments) &&
        options.arguments.every((argument) => typeof argument === "string" && !argument.includes("\0")) &&
        Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 300000 &&
        Number.isSafeInteger(options.maxOutputBytes) && options.maxOutputBytes > 0 &&
        options.maxOutputBytes <= MAX_PROCESS_OUTPUT_BYTES &&
        (options.env === undefined || options.env && typeof options.env === "object" && !Array.isArray(options.env) &&
            Object.entries(options.env).every(([name, value]) => name.length > 0 && !/[=\0]/.test(name) &&
                typeof value === "string" && !value.includes("\0")));
}

function killProcess(record, signal = "SIGTERM") {
    if (!record.child?.pid) return;
    try {
        if (process.platform !== "win32") process.kill(-record.child.pid, signal);
        else record.child.kill(signal);
    } catch (error) {
        if (error.code !== "ESRCH") record.child.kill(signal);
    }
}

function stopProcess(record) {
    killProcess(record);
    if (!record.forceKillTimer) {
        record.forceKillTimer = setTimeout(() => killProcess(record, "SIGKILL"), FORCE_KILL_DELAY_MS);
    }
}

function finish(record, exitCode, signal) {
    if (record.finished) return;
    record.finished = true;
    clearTimeout(record.timeout);
    clearTimeout(record.forceKillTimer);
    children.delete(record.id);

    if (record.spawnError) {
        send({ type: "failed", id: record.id, message: record.spawnError.message || "Compiler process could not start." });
    } else {
        const finalizeStarted = record.profileOutput ? performance.now() : 0;
        const result = {
            exitCode: typeof exitCode === "number" ? exitCode : -1,
            cancelled: record.cancelled,
            outputTruncated: record.outputTruncated,
            signal: signal || "",
            stderr: Buffer.concat(record.stderr).toString("utf8"),
            stdout: Buffer.concat(record.stdout).toString("utf8"),
            timedOut: record.timedOut
        };
        if (record.profileOutput) {
            result.outputProfile = {
                spawnCallMs: record.spawnCallMs,
                outputBytes: record.outputBytes,
                outputChunkCount: record.outputChunkCount,
                totalOutputChunkHandlerMs: record.totalOutputChunkHandlerMs,
                maximumOutputChunkHandlerMs: record.maximumOutputChunkHandlerMs,
                maximumOutputChunkBytes: record.maximumOutputChunkBytes,
                outputFinalizeMs: performance.now() - finalizeStarted
            };
        }
        send({ type: "completed", id: record.id, result });
    }

    if (shuttingDown && children.size === 0) finishShutdown();
}

function finishShutdown() {
    if (process.connected) {
        send({ type: "shutdown-complete" });
        process.disconnect();
    } else {
        process.exit(0);
    }
}

function appendOutput(record, destination, chunk) {
    const chunkHandlerStarted = record.profileOutput ? performance.now() : 0;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, record.options.maxOutputBytes - record.outputBytes);
    if (remaining === 0) {
        record.outputTruncated = true;
    } else {
        const accepted = bytes.subarray(0, remaining);
        destination.push(accepted);
        record.outputBytes += accepted.length;
        if (accepted.length < bytes.length) record.outputTruncated = true;
    }
    if (record.profileOutput) {
        const handlerMs = performance.now() - chunkHandlerStarted;
        record.outputChunkCount++;
        record.totalOutputChunkHandlerMs += handlerMs;
        record.maximumOutputChunkHandlerMs = Math.max(record.maximumOutputChunkHandlerMs, handlerMs);
        record.maximumOutputChunkBytes = Math.max(record.maximumOutputChunkBytes, bytes.length);
    }
}

function startProcess(message) {
    const options = message.options;
    const profileOutput = options.profileOutput === true;
    const spawnStarted = profileOutput ? performance.now() : 0;
    let child;
    try {
        child = childProcess.spawn(options.command, options.arguments, {
            cwd: options.cwd,
            env: options.env || process.env,
            shell: false,
            windowsHide: true,
            /* Separate process groups let cancellation stop compiler tools too. */
            detached: process.platform !== "win32"
        });
    } catch (error) {
        send({ type: "failed", id: message.id, message: error.message || "Compiler process could not start." });
        return;
    }

    const record = {
        id: message.id,
        options,
        child,
        profileOutput,
        spawnCallMs: profileOutput ? performance.now() - spawnStarted : 0,
        stdout: [],
        stderr: [],
        outputBytes: 0,
        outputChunkCount: 0,
        totalOutputChunkHandlerMs: 0,
        maximumOutputChunkHandlerMs: 0,
        maximumOutputChunkBytes: 0,
        outputTruncated: false,
        cancelled: false,
        timedOut: false,
        spawnError: null,
        timeout: null,
        forceKillTimer: null,
        finished: false
    };
    children.set(record.id, record);
    if (Number.isSafeInteger(child.pid) && child.pid > 0) send({ type: "started", id: record.id, pid: child.pid });
    child.once("error", (error) => {
        record.spawnError = error;
        if (child.pid) stopProcess(record);
        else finish(record, -1, "");
    });
    child.stdout?.on("data", (chunk) => appendOutput(record, record.stdout, chunk));
    child.stderr?.on("data", (chunk) => appendOutput(record, record.stderr, chunk));
    record.timeout = setTimeout(() => {
        record.timedOut = true;
        stopProcess(record);
    }, options.timeoutMs);
    child.once("close", (exitCode, signal) => finish(record, exitCode, signal));
}

function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "execute") {
        if (shuttingDown || !validRequest(message) || children.has(message.id) || children.size >= MAX_PENDING_PROCESSES) {
            send({ type: "failed", id: message.id, message: "Invalid or excessive compiler process request." });
            return;
        }
        startProcess(message);
        return;
    }
    if (message.type === "cancel") {
        const record = children.get(message.id);
        if (record) {
            record.cancelled = true;
            stopProcess(record);
        }
        return;
    }
    if (message.type === "shutdown") {
        shuttingDown = true;
        for (const record of children.values()) {
            record.cancelled = true;
            stopProcess(record);
        }
        if (children.size === 0) finishShutdown();
    }
}

function handleDisconnect() {
    shuttingDown = true;
    for (const record of children.values()) {
        record.cancelled = true;
        stopProcess(record);
    }
    if (children.size === 0) process.exit(0);
}

process.on("message", handleMessage);
process.once("disconnect", handleDisconnect);
process.once("exit", () => {
    /* A runner crash must not leave a compiler process orphaned. */
    for (const record of children.values()) killProcess(record, "SIGKILL");
});

send({ type: "ready" });

/* end of lib/compiler-process-runner.js */
