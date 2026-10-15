/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-process-supervisor.js
    Purpose: Keep synchronous compiler launches out of the editor host.
    Responsibilities: own the runner process, forward bounded requests, reap replies.
    Does not contain: compiler parsing, source validation, or editor policy.
*/

const { fork } = require("child_process");
const path = require("path");
const { performance } = require("perf_hooks");

const RUNNER_START_TIMEOUT_MS = 10000;
const RUNNER_SHUTDOWN_TIMEOUT_MS = 1500;
const MAX_PENDING_REQUESTS = 32;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const ORPHAN_REAP_WAIT_MS = 2000;

function cancelledResult() {
    return { exitCode: -1, cancelled: true, outputTruncated: false, timedOut: false, signal: "", stdout: "", stderr: "" };
}

function validateRequest(options) {
    if (!options || typeof options !== "object" || typeof options.command !== "string" ||
        !options.command || options.command.includes("\0") || !path.isAbsolute(options.cwd) ||
        options.cwd.includes("\0") || !Array.isArray(options.arguments) ||
        options.arguments.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
        throw new TypeError("Invalid supervised compiler command.");
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300000 ||
        !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 ||
        options.maxOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        throw new TypeError("Invalid supervised compiler limits.");
    }
    if (options.env !== undefined && (!options.env || typeof options.env !== "object" || Array.isArray(options.env) ||
        Object.entries(options.env).some(([name, value]) => !name || /[=\0]/.test(name) || typeof value !== "string" || value.includes("\0")))) {
        throw new TypeError("Invalid supervised compiler environment.");
    }
}

class CompilerProcessSupervisor {
    constructor(runnerPath = path.join(__dirname, "compiler-process-runner.js"), warning = () => {}) {
        this.runnerPath = runnerPath;
        this.warning = warning;
        this.child = null;
        this.starting = null;
        this.ready = false;
        this.sequence = 0;
        this.pending = new Map();
        this.disposed = false;
        this.disposing = null;
        this.startTimer = null;
        this.failedChildren = new WeakSet();
        this.pendingRunnerStartCallMs = null;
    }

    execute(options) {
        try {
            validateRequest(options);
            if (options.signal?.aborted) return Promise.resolve(cancelledResult());
            if (this.disposed) throw new Error("The compiler process supervisor has been disposed.");
            if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error("The compiler process queue is full.");
            if (this.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Compiler process request identities are exhausted.");
        } catch (error) {
            return Promise.reject(error);
        }

        const request = {
            id: ++this.sequence,
            options: {
                command: options.command,
                arguments: [...options.arguments],
                cwd: options.cwd,
                env: options.env ? { ...options.env } : undefined,
                timeoutMs: options.timeoutMs,
                maxOutputBytes: options.maxOutputBytes,
                profileOutput: options.profileOutput === true
            },
            signal: options.signal,
            onProcess: options.onProcess,
            resolve: null,
            reject: null,
            resolveDone: null,
            done: null,
            abort: null,
            sent: false,
            settled: false,
            pid: null
        };

        const result = new Promise((resolve, reject) => {
            request.resolve = resolve;
            request.reject = reject;
        });
        request.done = new Promise((resolve) => { request.resolveDone = resolve; });
        request.abort = () => this.cancel(request);
        this.pending.set(request.id, request);
        request.signal?.addEventListener("abort", request.abort, { once: true });
        if (request.signal?.aborted) request.abort();

        if (!request.settled) {
            void this.start().then((child) => {
                if (request.settled || this.pending.get(request.id) !== request) return;
                if (request.signal?.aborted) {
                    this.finish(request, null, cancelledResult());
                    return;
                }
                if (request.options.profileOutput && this.pendingRunnerStartCallMs !== null) {
                    request.supervisorStartCallMs = this.pendingRunnerStartCallMs;
                    this.pendingRunnerStartCallMs = null;
                }
                request.sent = true;
                this.refChild(child);
                child.send({ type: "execute", id: request.id, options: request.options }, (error) => {
                    if (error) this.finish(request, error);
                });
            }, (error) => this.finish(request, error));
        }

        return result;
    }

    start() {
        if (this.disposed) return Promise.reject(new Error("The compiler process supervisor has been disposed."));
        if (this.child && this.ready) return Promise.resolve(this.child);
        if (this.starting) return this.starting;

        const environment = { ...process.env };
        if (process.versions.electron && !environment.ELECTRON_RUN_AS_NODE) environment.ELECTRON_RUN_AS_NODE = "1";
        let child;
        const spawnStarted = performance.now();
        try {
            child = fork(this.runnerPath, [], {
                cwd: path.dirname(this.runnerPath),
                env: environment,
                execArgv: [],
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                serialization: "advanced"
            });
        } catch (error) {
            return Promise.reject(error);
        }
        this.pendingRunnerStartCallMs = performance.now() - spawnStarted;
        this.child = child;
        this.ready = false;
        this.starting = new Promise((resolve, reject) => {
            let settled = false;
            const finishStart = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(this.startTimer);
                this.startTimer = null;
                if (error) reject(error);
                else resolve(child);
            };
            this.startTimer = setTimeout(() => {
                finishStart(new Error("Compiler process runner did not become ready."));
                child.kill();
            }, RUNNER_START_TIMEOUT_MS);
            child.on("message", (message) => {
                if (message?.type === "ready") {
                    this.ready = true;
                    finishStart();
                    if (this.pending.size) this.refChild(child);
                    else this.unrefChild(child);
                    return;
                }
                this.message(child, message);
            });
            child.once("error", (error) => {
                finishStart(error);
                this.runnerFailed(child, error);
            });
            child.once("disconnect", () => {
                this.runnerFailed(child, new Error("Compiler process runner disconnected."));
            });
            child.once("exit", (code, signal) => {
                const error = new Error(`Compiler process runner exited (${code ?? signal ?? "unknown"}).`);
                finishStart(error);
                this.runnerFailed(child, error);
            });
        }).finally(() => {
            if (this.child === child) this.starting = null;
        });
        this.refChild(child);
        return this.starting;
    }

    message(child, message) {
        if (child !== this.child || !message || typeof message !== "object") return;
        if (message.type === "shutdown-complete") return;
        const request = this.pending.get(message.id);
        if (!request) {
            this.warning(`Ignoring a compiler runner reply for an expired request ${String(message.id)}.`);
            return;
        }

        if (message.type === "started") {
            if (!Number.isSafeInteger(message.pid) || message.pid < 1) {
                this.finish(request, new Error("Compiler process runner returned an invalid process identity."));
                return;
            }
            request.pid = message.pid;
            request.onProcess?.(message.pid);
            return;
        }
        if (message.type === "failed") {
            const detail = typeof message.message === "string" ? message.message.slice(0, 4096) : "Compiler process runner failed.";
            this.finish(request, new Error(detail));
            return;
        }
        if (message.type !== "completed" || !message.result || typeof message.result !== "object" ||
            typeof message.result.stdout !== "string" || typeof message.result.stderr !== "string" ||
            !Number.isSafeInteger(message.result.exitCode) || typeof message.result.cancelled !== "boolean" ||
            typeof message.result.timedOut !== "boolean" || typeof message.result.outputTruncated !== "boolean" ||
            typeof message.result.signal !== "string") {
            this.finish(request, new Error("Compiler process runner returned an invalid result."));
            return;
        }
        if (message.result.outputProfile) {
            message.result.outputProfile.runnerSpawnCallMs = message.result.outputProfile.spawnCallMs;
            delete message.result.outputProfile.spawnCallMs;
            if (request.supervisorStartCallMs !== undefined) {
                message.result.outputProfile.supervisorStartCallMs = request.supervisorStartCallMs;
            }
        }
        this.finish(request, null, message.result);
    }

    cancel(request) {
        if (request.settled || this.pending.get(request.id) !== request) return;
        if (!request.sent) {
            this.finish(request, null, cancelledResult());
            return;
        }
        const child = this.child;
        if (!child || !child.connected) {
            if (child) this.runnerFailed(child, new Error("Compiler process runner disconnected during cancellation."));
            else this.finish(request, null, { ...cancelledResult(), signal: "SIGKILL" });
            return;
        }
        this.refChild(child);
        child.send({ type: "cancel", id: request.id }, (error) => {
            if (error) this.warning(`Could not cancel compiler process ${request.pid || "before spawn"}: ${error.message}`);
        });
    }

    finish(request, error, result) {
        if (request.settled) return;
        request.settled = true;
        this.pending.delete(request.id);
        request.signal?.removeEventListener("abort", request.abort);
        request.onProcess?.(null);
        if (error) request.reject(error);
        else request.resolve(result);
        request.resolveDone();
        if (!this.pending.size) this.unrefChild(this.child);
    }

    runnerFailed(child, error) {
        if (this.failedChildren.has(child)) return;
        this.failedChildren.add(child);
        clearTimeout(this.startTimer);
        this.startTimer = null;
        if (this.child === child) {
            this.child = null;
            this.ready = false;
            this.starting = null;
        }
        const requests = [...this.pending.values()];
        for (const request of requests) if (request.pid) this.killProcessGroup(request.pid);
        void Promise.all(requests.map((request) => request.pid ? this.waitForProcessGroup(request.pid) : Promise.resolve()))
            .then(() => requests.forEach((request) => this.finish(request, error)));
    }

    killProcessGroup(pid) {
        try {
            if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
            else process.kill(pid, "SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") this.warning(`Could not stop orphaned compiler process ${pid}: ${error.message}`);
        }
    }

    async waitForProcessGroup(pid) {
        const target = process.platform === "win32" ? pid : -pid;
        const deadline = Date.now() + ORPHAN_REAP_WAIT_MS;
        while (Date.now() < deadline) {
            try { process.kill(target, 0); }
            catch (error) {
                if (error.code === "ESRCH") return;
                if (error.code !== "EPERM") this.warning(`Could not verify compiler process ${pid} cleanup: ${error.message}`);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        this.warning(`Compiler process group ${pid} did not exit after its runner failed.`);
    }

    refChild(child) {
        if (!child) return;
        child.ref();
        child.channel?.ref?.();
    }

    unrefChild(child) {
        if (!child || this.pending.size) return;
        child.unref();
        child.channel?.unref?.();
    }

    dispose() {
        if (this.disposing) return this.disposing;
        this.disposed = true;
        for (const request of [...this.pending.values()]) this.cancel(request);
        const child = this.child;
        if (!child) return Promise.all([...this.pending.values()].map((request) => request.done)).then(() => {});

        this.refChild(child);
        this.disposing = (async () => {
            await Promise.all([...this.pending.values()].map((request) => request.done));
            if (this.child !== child) return;
            await new Promise((resolve) => {
                let finished = false;
                const finish = () => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    child.kill();
                    finish();
                }, RUNNER_SHUTDOWN_TIMEOUT_MS);
                child.once("exit", finish);
                child.send({ type: "shutdown" }, (error) => {
                    if (error) {
                        this.warning(`Compiler process runner shutdown failed: ${error.message}`);
                        child.kill();
                    }
                });
            });
            if (this.child === child) {
                this.child = null;
                this.ready = false;
            }
        })();
        return this.disposing;
    }
}

module.exports = { CompilerProcessSupervisor, cancelledProcessResult: cancelledResult };

/* end of lib/compiler-process-supervisor.js */
