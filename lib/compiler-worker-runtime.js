/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-worker-runtime.js
    Purpose: Run native analysis and bounded trace decoding outside the editor.
    Responsibilities: own cancellation, exact-trace caching, and worker replies.
    Does not contain: VS Code APIs, inferred compiler results, or source edits.
*/

const { createHash } = require("crypto");
const { serialize, deserialize } = require("v8");
const { performance } = require("perf_hooks");
const { threadId } = require("worker_threads");
const { analyzeSavedModule, decodePreprocessed, MAX_ANALYSIS_BYTES } = require("./compiler-analysis");
const { CompilerModelStore } = require("./compiler-model-store");
const { queryCompilerModel } = require("./compiler-model-queries");
const { runProjectTransaction, verifyProjectSources } = require("./compiler-project-transaction");
const { CompilerWorkspaceSymbols } = require("./compiler-workspace-symbols");

/* ------------------------------------------------------------------------- */
/* Exact compiler-output cache                                               */
/* ------------------------------------------------------------------------- */

class CompilerTraceCache {
    constructor(maxBytes = MAX_ANALYSIS_BYTES, maxEntries = 8) {
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.entries = new Map();
        this.bytes = 0;
    }

    decode(source, cwd, checkCancelled) {
        checkCancelled();
        // Always run fbc first. File content alone cannot validate include
        // search order, negative file queries, or __DATE__/__TIME__ results.
        const key = createHash("sha256").update(JSON.stringify(cwd)).update(source).digest("hex");
        const cached = this.entries.get(key);
        if (cached && cached.source === source && cached.cwd === cwd) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            const analysis = deserialize(cached.encoded);
            checkCancelled();
            return { analysis, hit: true };
        }
        const analysis = decodePreprocessed(source, cwd, checkCancelled);
        checkCancelled();
        const encoded = serialize(analysis);
        const bytes = encoded.byteLength + (source.length + cwd.length) * 2;
        if (cached) { this.entries.delete(key); this.bytes -= cached.bytes; }
        if (bytes <= this.maxBytes && this.maxEntries > 0) {
            while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
                const oldest = this.entries.keys().next().value;
                this.bytes -= this.entries.get(oldest).bytes;
                this.entries.delete(oldest);
            }
            // Compare the actual source after hash lookup. Charge strings at
            // two bytes per UTF-16 code unit, plus the serialized graph buffer;
            // do not retain decoded object graphs behind this byte budget.
            this.entries.set(key, { source, cwd, encoded, bytes });
            this.bytes += bytes;
        }
        checkCancelled();
        return { analysis, hit: false };
    }

    clear() { this.entries.clear(); this.bytes = 0; }
}

/* ------------------------------------------------------------------------- */
/* Single-request worker protocol                                            */
/* ------------------------------------------------------------------------- */

function runAnalysisWorker(port, analyze = analyzeSavedModule) {
    const cache = new CompilerTraceCache();
    const models = new CompilerModelStore((snapshotId) => port.postMessage({ type: "model-evicted", snapshotId }));
    const workspaceSymbols = new CompilerWorkspaceSymbols();
    let active = null;
    let closing = false;
    let project = null, projectSequence = 0;
    const clearProject = () => {
        if (!project) return;
        clearTimeout(project.timer);
        port.postMessage({ type: "project-evicted", projectId: project.id });
        project = null;
    };
    const close = () => { cache.clear(); models.clear(); clearProject(); workspaceSymbols.clear(); port.close(); };
    const execute = (options) => new Promise((resolve, reject) => {
        // The host owns spawn/wait so a fatal worker exit cannot strand a
        // child-process handle or leave a zombie until the editor itself exits.
        // Only asynchronous process I/O runs there; file work and decoding stay
        // in this worker. Cancellation also reaches the host without waiting
        // for this thread to leave a synchronous decoder.
        if (active.execution) { reject(new Error("Concurrent compiler execution in one worker.")); return; }
        const { signal, ...input } = options;
        const abort = () => port.postMessage({ type: "stop-process", id: active.id });
        signal?.addEventListener("abort", abort, { once: true });
        active.execution = { resolve, reject, signal, abort };
        port.postMessage({ type: "execute", id: active.id, options: input });
        if (signal?.aborted) abort();
    });
    port.on("message", async (message) => {
        if (message.type === "execution-result" || message.type === "execution-error") {
            if (!active || message.id !== active.id || !active.execution) throw new Error("Unexpected compiler execution reply.");
            const execution = active.execution;
            active.execution = null;
            execution.signal?.removeEventListener("abort", execution.abort);
            if (message.type === "execution-result") execution.resolve(message.result);
            else execution.reject(new Error(message.message));
            return;
        }
        if (message.type === "cancel") {
            if (active?.id === message.id) active.controller.abort();
            return;
        }
        if (message.type === "discard-project") { if (message.projectId === project?.id) clearProject(); return; }
        // Source edits may stale one remote graph while other module models
        // remain useful, so reclamation bypasses the normal request queue.
        if (message.type === "release-model") {
            if (typeof message.snapshotId !== "string" || message.snapshotId.length > 128) throw new Error("Invalid compiler model release request.");
            models.remove(message.snapshotId);
            return;
        }
        if (message.type === "workspace-discard") { workspaceSymbols.discard(message.workspaceId); return; }
        if (message.type === "clear") { cache.clear(); models.clear(); clearProject(); workspaceSymbols.clear(); return; }
        if (message.type === "dispose") {
            closing = true;
            active?.controller.abort();
            if (!active) close();
            return;
        }
        if (!["analyze", "prepare", "query", "project", "verify-project", "workspace-begin", "workspace-index", "workspace-finish"].includes(message.type) || active || closing || !Number.isSafeInteger(message.id) || message.id < 1 || !(message.cancellation instanceof SharedArrayBuffer) || message.cancellation.byteLength !== Int32Array.BYTES_PER_ELEMENT) throw new Error("Invalid compiler worker request.");
        const controller = new AbortController();
        const cancellation = new Int32Array(message.cancellation);
        const checkCancelled = () => {
            if (Atomics.load(cancellation, 0) || controller.signal.aborted) throw new Error("Compiler analysis was cancelled.");
        };
        active = { id: message.id, controller };
        const started = performance.now();
        let decodeMs = 0, cacheHit = false, queryStats = null;
        try {
            checkCancelled();
            const run = (options) => analyze({ ...options, signal: controller.signal }, (source, cwd) => {
                const before = performance.now();
                const result = cache.decode(source, cwd, checkCancelled);
                decodeMs += performance.now() - before;
                cacheHit = result.hit;
                return result.analysis;
            }, execute);
            let analysis;
            if (message.type === "workspace-begin") {
                analysis = workspaceSymbols.begin(message.options.buffers, message.options.query, message.options.limit);
            } else if (message.type === "workspace-index") {
                analysis = await workspaceSymbols.index(message.options, message.options.workspace, models, run, checkCancelled);
            } else if (message.type === "workspace-finish") {
                analysis = workspaceSymbols.finish(message.options.workspaceId, message.options.buffers, checkCancelled);
            } else if (message.type === "project") {
                models.clear();
                cache.clear();
                clearProject();
                const result = await runProjectTransaction({ ...message.options, ...message.options.project, signal: controller.signal }, run, checkCancelled, (text) => port.postMessage({ type: "progress", id: message.id, message: text }));
                checkCancelled();
                const id = `${threadId}:project:${++projectSequence}`;
                project = { id, verification: result.verification, expiresAt: Date.now() + 30000, timer: setTimeout(clearProject, 30000) };
                const { verification, ...reply } = result;
                analysis = { ...reply, projectId: id };
            } else if (message.type === "verify-project") {
                if (!project || project.id !== message.options.projectId || project.expiresAt <= Date.now()) { clearProject(); throw new Error("The compiler project validation has expired."); }
                try {
                    verifyProjectSources(project.verification, message.options.buffers, checkCancelled);
                    analysis = { verified: true };
                } finally { clearProject(); }
            } else if (message.type === "query") {
                const { snapshotId, operation, input } = message.options;
                const beforeQueryVerification = performance.now();
                const model = models.get(snapshotId, input.openFiles || [], checkCancelled);
                const queryFreshnessBeforeMs = performance.now() - beforeQueryVerification;
                const modelQueryStarted = performance.now();
                const result = queryCompilerModel(model, operation, input, checkCancelled);
                const modelQueryMs = performance.now() - modelQueryStarted;
                const afterQueryVerification = performance.now();
                models.get(snapshotId, input.openFiles || [], checkCancelled);
                const queryFreshnessAfterMs = performance.now() - afterQueryVerification;
                queryStats = { queryFreshnessBeforeMs, modelQueryMs, queryFreshnessAfterMs };
                if (serialize(result).byteLength > 8 * 1024 * 1024) throw new Error("Compiler query result exceeded 8 MiB.");
                analysis = { result };
            } else if (message.type === "prepare") {
                analysis = await models.prepare(message.options, message.options.preparation, run, checkCancelled);
            } else {
                // Raw refactoring analyses need their own graph budget. Do not
                // retain unrelated prepared editor models alongside them.
                models.clear();
                analysis = await run(message.options);
            }
            checkCancelled();
            const stats = { threadId, analysisMs: performance.now() - started, decodeMs, cacheHit, cacheEntries: cache.entries.size, cacheBytes: cache.bytes, ...(queryStats || {}) };
            stats.workerPostedAtNs = process.hrtime.bigint().toString();
            port.postMessage({ type: "result", id: message.id, analysis, stats });
        } catch (error) {
            port.postMessage({ type: "error", id: message.id, message: String(error.message || error) });
        } finally {
            active = null;
            if (closing) close();
        }
    });
}

module.exports = { CompilerTraceCache, runAnalysisWorker };

/* end of lib/compiler-worker-runtime.js */
