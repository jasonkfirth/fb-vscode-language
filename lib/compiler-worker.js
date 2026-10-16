/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-worker.js
    Purpose: Run analysis work in a worker while retaining native child ownership.
    Responsibilities: bound requests, cancel stale work, and own worker cleanup.
    Does not contain: compiler semantics, decoded-result caching, or editor APIs.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { performance } = require("perf_hooks");
const { DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS, MAX_ANALYSIS_BYTES, analysisArguments } = require("./compiler-analysis");
const { CompilerProcessSupervisor } = require("./compiler-process-supervisor");

// One worker bounds concurrent native graphs. Queued input is limited in both
// count and bytes, independent of the runtime's separate 32 MiB trace cache.
const MAX_REQUESTS = 16;
const MAX_QUEUED_BYTES = 2 * MAX_ANALYSIS_BYTES;
const COMPILER_WORKER_BUSY = "FBC_WORKER_BUSY";
const SHUTDOWN_GRACE_MS = 1500;

function workerBusyError(message) {
    const error = new Error(message);
    error.code = COMPILER_WORKER_BUSY;
    return error;
}

class HostProcessLaunchQueue {
    constructor(schedule = (callback) => setImmediate(callback)) {
        this.schedule = schedule;
        this.entries = [];
        this.sequence = 0;
        this.scheduled = false;
    }

    enqueue(launch, priority = 0) {
        if (typeof launch !== "function" || !Number.isSafeInteger(priority)) throw new TypeError("Invalid host process launch request.");
        const entry = { launch, priority, sequence: ++this.sequence };
        const index = this.entries.findIndex((candidate) => candidate.priority > priority ||
            candidate.priority === priority && candidate.sequence > entry.sequence);
        if (index < 0) this.entries.push(entry);
        else this.entries.splice(index, 0, entry);
        this.scheduleNext();
    }

    scheduleNext() {
        if (this.scheduled || !this.entries.length) return;
        this.scheduled = true;
        this.schedule(() => {
            this.scheduled = false;
            const entry = this.entries.shift();
            try {
                entry?.launch();
            } finally {
                this.scheduleNext();
            }
        });
    }
}

const hostProcessLaunchQueue = new HostProcessLaunchQueue();

class CompilerAnalysisWorker {
    constructor(workerPath = path.join(__dirname, "compiler-worker-entry.js"), warning = () => {}, canExecute = () => true, onModelEvicted = () => {}, processSupervisor = null) {
        this.workerPath = workerPath;
        this.warning = warning;
        this.canExecute = canExecute;
        this.onModelEvicted = onModelEvicted;
        this.ownsProcessSupervisor = !processSupervisor;
        this.processSupervisor = processSupervisor || new CompilerProcessSupervisor(undefined,
            (message) => warning(`Compiler process supervisor: ${message}`));
        this.worker = null;
        this.pending = [];
        this.active = null;
        this.bytes = 0;
        this.sequence = 0;
        this.disposed = false;
        this.shuttingDown = null;
        this.stopping = null;
        this.models = new Set();
        this.projects = new Set();
        this.idleWaiters = new Set();
    }

    analyze(options, preparation = null) {
        return this.submitAnalysis(options, preparation, null);
    }

    beginWorkspace(buffers, query, limit, signal) {
        return this.bufferRequest("workspace-begin", { query, limit }, buffers, signal);
    }

    indexWorkspace(options, context) {
        if (typeof context?.id !== "string") return Promise.reject(new Error("Invalid workspace symbol pass."));
        return this.submitAnalysis(options, null, null, { id: context.id });
    }

    finishWorkspace(id, buffers, signal) {
        return this.bufferRequest("workspace-finish", { workspaceId: id }, buffers, signal);
    }

    discardWorkspace(workspaceId) { this.worker?.postMessage({ type: "workspace-discard", workspaceId }); }

    project(options) {
        try {
            if (!Array.isArray(options.jobs) || !options.jobs.length || options.jobs.length > 128) throw new Error("Compiler refactoring requires 1 to 128 module/configuration pairs.");
            if (typeof options.root !== "string" || !path.isAbsolute(options.root) || /[\0\r\n\t]/.test(options.root) || typeof options.selectedKey !== "string" || /[\0\r\n\t]/.test(options.selectedKey)) throw new Error("Invalid compiler project root or selected declaration.");
            const jobs = options.jobs.map((job) => {
                if (typeof job.name !== "string" || !job.name.trim() || typeof job.filePath !== "string" || !path.isAbsolute(job.filePath) || !/\.bas$/i.test(job.filePath) || /[\0\r\n\t]/.test(job.filePath)) throw new Error("Invalid compiler project job.");
                return { name: job.name, filePath: job.filePath, compilerArguments: analysisArguments(job.compilerArguments) };
            });
            const request = {
                jobs,
                root: options.root,
                selectedKey: options.selectedKey,
                oldName: options.oldName,
                newName: options.newName,
                referencesOnly: options.referencesOnly === true,
                semanticMacroReferences: options.semanticMacroReferences === true,
                includeDeclaration: options.includeDeclaration === true,
                declarationsOnly: options.declarationsOnly === true
            };
            return this.submitAnalysis({ ...options, filePath: jobs[0].filePath, compilerArguments: [] }, null, request);
        } catch (error) { return Promise.reject(error); }
    }

    verifyProject(projectId, buffers, signal) {
        if (!this.projects.has(projectId)) return Promise.reject(new Error("The compiler project validation has expired."));
        return this.bufferRequest("verify-project", { projectId }, buffers, signal);
    }

    bufferRequest(type, metadata, buffers, signal) {
        try {
            if (!(buffers instanceof Map) || buffers.size > 5000) throw new Error("Project verification requires at most 5000 named buffers.");
            let bytes = Buffer.byteLength(JSON.stringify(metadata));
            for (const [file, text] of buffers) {
                if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n\t]/.test(file) || typeof text !== "string") throw new Error("Invalid project verification buffer.");
                bytes += Buffer.byteLength(file) + Buffer.byteLength(text);
                if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Project verification buffers exceeded 32 MiB.");
            }
            return this.enqueue(type, { ...metadata, buffers: new Map(buffers) }, bytes, signal, 30000);
        } catch (error) { return Promise.reject(error); }
    }

    discardProject(projectId) {
        this.projects.delete(projectId);
        this.worker?.postMessage({ type: "discard-project", projectId });
    }

    submitAnalysis(options, preparation, project, workspace = null) {
        try {
            if (this.disposed) throw new Error("The compiler worker has been disposed.");
            if (options.signal?.aborted) throw new Error("Compiler analysis was cancelled.");
            if (this.pending.length + Number(Boolean(this.active)) >= MAX_REQUESTS) throw workerBusyError("The compiler analysis queue is full.");
            if (!path.isAbsolute(options.filePath) || !/\.bas$/i.test(options.filePath)) throw new Error("Compiler analysis requires a saved .bas module.");
            if (typeof options.compilerPath !== "string" || !options.compilerPath || options.compilerPath.includes("\0")) throw new Error("Invalid compiler executable path.");
            const arguments_ = analysisArguments(options.compilerArguments);
            // A persistent thread inherits the environment only at startup.
            // Freeze the host's current environment for each request instead
            // of using stale PATH/include-related values from that first run.
            const environment = { ...process.env };
            const overlays = options.overlays || new Map();
            if (!(overlays instanceof Map) || overlays.size > 5000) throw new Error("Compiler overlays require at most 5000 named buffers.");
            let bytes = Buffer.byteLength(options.compilerPath) + Buffer.byteLength(options.filePath);
            if (options.semanticSourceFiles !== undefined) {
                if (!Array.isArray(options.semanticSourceFiles) || options.semanticSourceFiles.length > 5000 ||
                    options.semanticSourceFiles.some((file) => typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n\t]/.test(file))) {
                    throw new Error("Compiler semantic source filter requires at most 5000 absolute paths.");
                }
                for (const file of options.semanticSourceFiles) bytes += Buffer.byteLength(file);
            }
            let dependencyHints;
            if (options.dependencyHints !== undefined) {
                if (!Array.isArray(options.dependencyHints) || options.dependencyHints.length > 5000 ||
                    options.dependencyHints.some((file) => typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n\t]/.test(file))) {
                    throw new Error("Compiler dependency hints require at most 5000 absolute paths.");
                }
                dependencyHints = [...new Set(options.dependencyHints.map((file) => path.resolve(file)))];
                for (const file of dependencyHints) bytes += Buffer.byteLength(file);
            }
            for (const argument of arguments_) bytes += Buffer.byteLength(argument);
            for (const [name, value] of Object.entries(environment)) bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
            if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler request options exceeded 32 MiB.");
            for (const [file, text] of overlays) {
                if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n\t]/.test(file) || typeof text !== "string") throw new Error("Invalid compiler overlay path or text.");
                bytes += Buffer.byteLength(text) + Buffer.byteLength(file);
                if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler overlays exceeded 32 MiB.");
            }
            const timeoutMs = options.timeoutMs ?? DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS;
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("Compiler worker timeout must be between 1 and 300000 ms.");
            if (this.bytes + bytes > MAX_QUEUED_BYTES) throw workerBusyError("Queued compiler buffers exceeded 64 MiB.");
            if (this.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Compiler worker request identities are exhausted.");
            // Strings are immutable; copying the map and option array freezes
            // the request before it waits behind another translation unit.
            const input = {
                compilerPath: options.compilerPath,
                filePath: options.filePath,
                compilerArguments: arguments_,
                dependencyHints,
                overlays: new Map(overlays),
                semanticSourceFiles: options.semanticSourceFiles ? [...options.semanticSourceFiles] : undefined,
                environment,
                allowErrors: Boolean(options.allowErrors),
                exportSemanticExpressions: Boolean(options.exportSemanticExpressions),
                exportSemanticBindings: Boolean(options.exportSemanticBindings),
                semanticModelOnly: Boolean(options.semanticModelOnly),
                compactSemanticMacros: options.compactSemanticMacros !== false,
                requireSemanticModel: Boolean(options.requireSemanticModel),
                allowSemanticSidecarFallback: options.allowSemanticSidecarFallback !== false,
                profileProcessOutput: Boolean(options.profileProcessOutput),
                profileWorkspaceMemory: Boolean(options.profileWorkspaceMemory),
                timeoutMs
            };
            if (preparation) {
                if (typeof preparation.requestedFile !== "string" || !path.isAbsolute(preparation.requestedFile) || preparation.expandedUri?.scheme !== "freebasic-preprocessed" || typeof preparation.expandedUri.value !== "string" || !preparation.expandedUri.value.startsWith("freebasic-preprocessed:")) throw new Error("Invalid compiler model preparation request.");
                input.preparation = structuredClone(preparation);
                bytes += Buffer.byteLength(JSON.stringify(input.preparation));
                if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler model preparation exceeded 32 MiB.");
            }
            if (project) {
                input.project = structuredClone(project);
                bytes += Buffer.byteLength(JSON.stringify(input.project));
                if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler project request exceeded 32 MiB.");
            }
            if (workspace) {
                input.workspace = workspace;
                bytes += Buffer.byteLength(JSON.stringify(workspace));
                if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Workspace symbol request exceeded 32 MiB.");
            }
            // Each configured job can need four discovery passes and one
            // validation pass. The whole transaction still has a five-minute
            // ceiling, including queue time, independent of child deadlines.
            const deadline = project ? Math.min(300000, timeoutMs * project.jobs.length * 5) : timeoutMs;
            return this.enqueue(workspace ? "workspace-index" : project ? "project" : preparation ? "prepare" : "analyze", input, bytes, options.signal, deadline);
        } catch (error) { return Promise.reject(error); }
    }

    query(snapshotId, operation, input, signal) {
        try {
            if (!this.models.has(snapshotId)) throw new Error("The compiler model has expired. Analyze the module again.");
            const options = { snapshotId, operation, input: structuredClone(input) };
            const bytes = Buffer.byteLength(JSON.stringify(options));
            if (bytes > 1024 * 1024) throw new Error("Compiler query input exceeded 1 MiB.");
            return this.enqueue("query", options, bytes, signal, 30000);
        } catch (error) { return Promise.reject(error); }
    }

    releaseModel(snapshotId) {
        if (typeof snapshotId !== "string" || !this.models.delete(snapshotId)) return false;
        // Reject new host queries immediately while the worker reclaims only
        // this graph, leaving unrelated translation-unit models available.
        this.worker?.postMessage({ type: "release-model", snapshotId });
        return true;
    }

    enqueue(type, input, bytes, signal, timeoutMs) {
        if (this.disposed) return Promise.reject(new Error("The compiler worker has been disposed."));
        if (signal?.aborted) return Promise.reject(new Error("Compiler analysis was cancelled."));
        /* An input that cannot fit an empty queue is a permanent size error,
           not temporary pressure that editor providers should retry. */
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_QUEUED_BYTES) {
            return Promise.reject(new Error("Compiler request size must be between 0 and 64 MiB."));
        }
        if (this.pending.length + Number(Boolean(this.active)) >= MAX_REQUESTS || this.bytes + bytes > MAX_QUEUED_BYTES) {
            return Promise.reject(workerBusyError("The compiler analysis queue is full."));
        }
        if (this.sequence === Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("Compiler worker request identities are exhausted."));
        return new Promise((resolve, reject) => {
            const entry = { id: ++this.sequence, type, options: input, bytes, resolve, reject, signal, queuedAt: performance.now(), cancellation: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), settled: false, pid: null };
            entry.abort = () => this.cancel(entry, new Error("Compiler analysis was cancelled."));
            entry.signal?.addEventListener("abort", entry.abort, { once: true });
            entry.timer = setTimeout(() => this.cancel(entry, new Error("Compiler analysis timed out while running or queued.")), timeoutMs);
            this.bytes += bytes;
            this.pending.push(entry);
            this.dispatch();
        });
    }

    start() {
        if (this.worker) return;
        // Node's structured clone preserves Maps but not class prototypes.
        // Only plain native records cross this boundary, never VS Code objects.
        // Disable inherited inspector/preload switches. The heap allowance
        // covers one expanded native graph; retained cache bytes are separate.
        const worker = new Worker(this.workerPath, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 } });
        this.worker = worker;
        worker.on("message", (message) => this.message(worker, message));
        worker.on("error", (error) => this.failed(worker, error));
        worker.on("exit", (code) => this.failed(worker, new Error(`Compiler worker exited (${code}).`)));
        worker.on("messageerror", (error) => this.failed(worker, error));
        worker.unref();
    }

    dispatch() {
        if (this.disposed || this.stopping || this.active || !this.pending.length) { this.notifyIdle(); return; }
        const entry = this.pending.shift();
        this.active = entry;
        try {
            this.start();
            if (["analyze", "prepare", "project", "workspace-index"].includes(entry.type)) entry.directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-editor-worker-"));
            entry.startedAt = performance.now();
            this.worker.ref();
            this.worker.postMessage({ type: entry.type, id: entry.id, options: { ...entry.options, temporaryDirectory: entry.directory }, cancellation: entry.cancellation.buffer });
        } catch (error) { this.failed(this.worker, error); }
    }

    message(worker, message) {
        if (worker !== this.worker) return;
        if (!message || typeof message !== "object") { this.failed(worker, new Error("Invalid compiler worker response.")); return; }
        if (message.type === "project-evicted") { this.projects.delete(message.projectId); return; }
        if (message.type === "model-evicted") {
            this.models.delete(message.snapshotId);
            this.onModelEvicted(message.snapshotId);
            return;
        }
        const entry = this.active;
        if (!entry || message.id !== entry.id) { this.failed(worker, new Error("Unexpected compiler worker reply.")); return; }
        const messageHandlerStarted = performance.now();
        if (message.type === "stop-process") { entry.processController?.abort(); return; }
        if (message.type === "progress") {
            if (entry.type !== "project" || typeof message.message !== "string" || message.message.length > 8192) { this.failed(worker, new Error("Invalid compiler project progress.")); return; }
            this.warning(message.message);
            return;
        }
        if (message.type === "execute") {
            const options = message.options;
            const directories = entry.options.project ? entry.options.project.jobs.map((job) => path.dirname(job.filePath)) : entry.options.filePath ? [path.dirname(entry.options.filePath)] : [];
            if (!["analyze", "prepare", "project", "workspace-index"].includes(entry.type) || entry.execution && !entry.processDone || !options || options.command !== entry.options.compilerPath || !Array.isArray(options.arguments) || options.arguments.some((argument) => typeof argument !== "string" || argument.includes("\0")) || ![entry.directory, ...directories].includes(options.cwd)) { this.failed(worker, new Error("Invalid compiler execution request.")); return; }
            // A preparation may discover more includes and need another pass.
            // Recheck host-owned workspace trust before every native launch,
            // not just when the original request entered the queue.
            if (!this.canExecute()) {
                worker.postMessage({ type: "execution-error", id: entry.id, message: "Compiler execution is disabled in an untrusted workspace." });
                return;
            }
            entry.processController = new AbortController();
            entry.processDone = false;
            if (entry.settled) entry.processController.abort();
            const profileOutput = entry.options.profileProcessOutput === true;
            if (profileOutput && !entry.processRunnerProfile) {
                entry.processRunnerProfile = {
                    executions: 0,
                    totalSupervisorStartCallMs: 0,
                    maximumSupervisorStartCallMs: 0,
                    totalRunnerSpawnCallMs: 0,
                    maximumRunnerSpawnCallMs: 0,
                    outputBytes: 0,
                    outputChunkCount: 0,
                    totalOutputChunkHandlerMs: 0,
                    maximumOutputChunkHandlerMs: 0,
                    maximumOutputChunkBytes: 0,
                    maximumOutputFinalizeMs: 0,
                    totalExecutionReplyPostMs: 0,
                    maximumExecutionReplyPostMs: 0
                };
            }
            let finishExecution;
            entry.execution = new Promise((resolve) => { finishExecution = resolve; });
            const finish = () => {
                entry.processDone = true;
                finishExecution();
            };
            const rejectExecution = (message) => {
                if (worker === this.worker && this.active === entry) {
                    try { worker.postMessage({ type: "execution-error", id: entry.id, message }); }
                    catch (error) { this.failed(worker, error); }
                }
                finish();
            };

            /* Dispatch one supervisor request per event-loop turn. The helper
               process owns compiler spawning and reaping outside this host. */
            const launch = () => {
                if (worker !== this.worker || this.active !== entry) {
                    finish();
                    return;
                }
                if (entry.settled || entry.processController.signal.aborted) {
                    rejectExecution("Compiler analysis was cancelled.");
                    return;
                }
                if (!this.canExecute()) {
                    rejectExecution("Compiler execution is disabled in an untrusted workspace.");
                    return;
                }

                let execution;
                try {
                    execution = this.processSupervisor.execute({ command: entry.options.compilerPath,
                        arguments: options.arguments, cwd: options.cwd, env: options.env,
                        timeoutMs: entry.options.timeoutMs, maxOutputBytes: 2 * 1024 * 1024,
                        signal: entry.processController.signal,
                        onProcess: (pid) => { entry.pid = pid; }, profileOutput });
                } catch (error) {
                    execution = Promise.reject(error);
                }

                void execution.then(
                    (result) => ({ type: "execution-result", id: entry.id, result }),
                    (error) => ({ type: "execution-error", id: entry.id, message: error.message })
                ).then((reply) => {
                    if (worker !== this.worker || this.active !== entry) {
                        finish();
                        return;
                    }
                    const outputProfile = reply.type === "execution-result" ? reply.result.outputProfile : null;
                    if (outputProfile && entry.processRunnerProfile) {
                        const profile = entry.processRunnerProfile;
                        profile.executions++;
                        profile.totalSupervisorStartCallMs += outputProfile.supervisorStartCallMs || 0;
                        profile.maximumSupervisorStartCallMs = Math.max(profile.maximumSupervisorStartCallMs, outputProfile.supervisorStartCallMs || 0);
                        profile.totalRunnerSpawnCallMs += outputProfile.runnerSpawnCallMs || 0;
                        profile.maximumRunnerSpawnCallMs = Math.max(profile.maximumRunnerSpawnCallMs, outputProfile.runnerSpawnCallMs || 0);
                        profile.outputBytes += outputProfile.outputBytes;
                        profile.outputChunkCount += outputProfile.outputChunkCount;
                        profile.totalOutputChunkHandlerMs += outputProfile.totalOutputChunkHandlerMs;
                        profile.maximumOutputChunkHandlerMs = Math.max(profile.maximumOutputChunkHandlerMs, outputProfile.maximumOutputChunkHandlerMs);
                        profile.maximumOutputChunkBytes = Math.max(profile.maximumOutputChunkBytes, outputProfile.maximumOutputChunkBytes);
                        profile.maximumOutputFinalizeMs = Math.max(profile.maximumOutputFinalizeMs, outputProfile.outputFinalizeMs);
                    }
                    const replyPostStarted = profileOutput ? performance.now() : 0;
                    try { worker.postMessage(reply); }
                    catch (error) { this.failed(worker, error); }
                    if (profileOutput && entry.processRunnerProfile) {
                        const replyPostMs = performance.now() - replyPostStarted;
                        entry.processRunnerProfile.totalExecutionReplyPostMs += replyPostMs;
                        entry.processRunnerProfile.maximumExecutionReplyPostMs = Math.max(entry.processRunnerProfile.maximumExecutionReplyPostMs, replyPostMs);
                    }
                    finish();
                });
            };
            hostProcessLaunchQueue.enqueue(launch, entry.type === "workspace-index" ? 1 : 0);
            return;
        }
        if (entry.execution && !entry.processDone) { this.failed(worker, new Error("Compiler worker replied before its child exited.")); return; }
        if (message.type === "result") {
            if (!message.analysis || typeof message.analysis !== "object") { this.failed(worker, new Error("Invalid compiler analysis result.")); return; }
            if (!entry.settled) {
                if (message.analysis.snapshotId) this.models.add(message.analysis.snapshotId);
                if (message.analysis.projectId) this.projects.add(message.analysis.projectId);
                const rawStats = message.stats && typeof message.stats === "object" ? message.stats : {};
                const { workerPostedAtNs, ...workerStats } = rawStats;
                let workerMessageDelayMs;
                if (typeof workerPostedAtNs === "string" && /^\d{1,32}$/.test(workerPostedAtNs)) {
                    const delayNanoseconds = process.hrtime.bigint() - BigInt(workerPostedAtNs);
                    if (delayNanoseconds >= 0n) workerMessageDelayMs = Number(delayNanoseconds) / 1e6;
                }
                message.analysis.workerStats = {
                    ...workerStats,
                    queueMs: entry.startedAt - entry.queuedAt,
                    roundTripMs: performance.now() - entry.startedAt,
                    ...(Number.isFinite(workerMessageDelayMs) ? { workerMessageDelayMs } : {}),
                    ...(entry.processRunnerProfile ? { processRunnerProfile: entry.processRunnerProfile } : {})
                };
                this.settle(entry, null, message.analysis);
            }
        } else if (message.type === "error") this.settle(entry, new Error(message.message));
        else { this.failed(worker, new Error("Invalid compiler worker response.")); return; }
        this.release(entry);
        this.active = null;
        worker.unref();
        this.dispatch();
        if (message.type === "result" && message.analysis?.workerStats) {
            message.analysis.workerStats.messageHandlerMs = performance.now() - messageHandlerStarted;
        }
    }

    settle(entry, error, result) {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener("abort", entry.abort);
        if (error) entry.reject(error);
        else entry.resolve(result);
    }

    cancel(entry, error) {
        this.settle(entry, error);
        Atomics.store(entry.cancellation, 0, 1);
        if (entry === this.active) {
            entry.processController?.abort();
            this.worker?.postMessage({ type: "cancel", id: entry.id });
            // A stalled decoder must not pin the queue indefinitely. Normally
            // its shared-flag checkpoints exit first; forced termination is a
            // fallback, with the native child and owned directory reclaimed.
            if (!entry.killTimer) entry.killTimer = setTimeout(() => {
                if (this.active === entry) this.failed(this.worker, new Error("Compiler worker did not acknowledge cancellation."));
            }, SHUTDOWN_GRACE_MS);
        } else {
            const index = this.pending.indexOf(entry);
            if (index >= 0) { this.pending.splice(index, 1); this.release(entry); this.dispatch(); }
        }
    }

    release(entry) {
        clearTimeout(entry.killTimer);
        this.bytes -= entry.bytes;
        if (entry.directory) {
            // Only paths created by this client's mkdtempSync() reach here.
            try { fs.rmSync(entry.directory, { recursive: true, force: true }); }
            catch (error) { this.warning(`Compiler worker temporary cleanup failed: ${entry.directory}: ${error.message}`); }
        }
    }

    failed(worker, error) {
        if (worker !== this.worker) return;
        this.worker = null;
        const expired = [...this.models];
        this.models.clear();
        this.projects.clear();
        for (const id of expired) this.onModelEvicted(id);
        const entry = this.active;
        this.active = null;
        if (entry) {
            this.settle(entry, error);
            Atomics.store(entry.cancellation, 0, 1);
            entry.processController?.abort();
        }
        // Do not retry a failed request silently. Future queued work can use
        // a fresh worker only after the old one has stopped writing its files.
        const stopped = Promise.allSettled([worker?.terminate(), entry?.execution]);
        this.stopping = stopped.catch(() => {}).then(() => {
            if (entry) this.release(entry);
            this.stopping = null;
            this.dispatch();
        });
    }

    cancelAll() {
        this.models.clear();
        this.projects.clear();
        for (const entry of [...this.pending]) this.cancel(entry, new Error("Compiler analysis was invalidated."));
        if (this.active) this.cancel(this.active, new Error("Compiler analysis was invalidated."));
        this.worker?.postMessage({ type: "clear" });
        this.notifyIdle();
    }

    waitForIdle(signal) {
        if (signal?.aborted) return Promise.reject(new Error("Compiler analysis was cancelled."));
        if (!this.active && !this.pending.length && !this.stopping) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, signal, abort: null };
            waiter.abort = () => {
                this.idleWaiters.delete(waiter);
                signal?.removeEventListener("abort", waiter.abort);
                reject(new Error("Compiler analysis was cancelled."));
            };
            signal?.addEventListener("abort", waiter.abort, { once: true });
            this.idleWaiters.add(waiter);
            if (signal?.aborted) waiter.abort();
            else this.notifyIdle();
        });
    }

    notifyIdle() {
        if (this.active || this.pending.length || this.stopping) return;
        for (const waiter of this.idleWaiters) {
            this.idleWaiters.delete(waiter);
            waiter.signal?.removeEventListener("abort", waiter.abort);
            waiter.resolve();
        }
    }

    dispose() {
        if (this.shuttingDown) return this.shuttingDown;
        this.disposed = true;
        this.cancelAll();
        const worker = this.worker;
        const stopProcessSupervisor = () => this.ownsProcessSupervisor
            ? this.processSupervisor.dispose()
            : Promise.resolve();
        if (!worker) {
            this.shuttingDown = Promise.resolve(this.stopping).then(stopProcessSupervisor);
            return this.shuttingDown;
        }
        this.shuttingDown = new Promise((resolve) => {
            const finish = () => {
                Promise.resolve(this.stopping).then(stopProcessSupervisor).then(resolve, (error) => {
                    this.warning(`Compiler process supervisor shutdown failed: ${error.message}`);
                    resolve();
                });
            };
            const timer = setTimeout(() => this.failed(worker, new Error("Compiler worker shutdown timed out.")), SHUTDOWN_GRACE_MS);
            worker.once("exit", () => { clearTimeout(timer); finish(); });
            worker.postMessage({ type: "dispose" });
        });
        return this.shuttingDown;
    }
}

module.exports = { COMPILER_WORKER_BUSY, CompilerAnalysisWorker, HostProcessLaunchQueue };

/* end of lib/compiler-worker.js */
