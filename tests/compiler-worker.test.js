/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/compiler-worker.test.js
    Purpose: Verify native worker isolation, cache identity, and request lifetime.
    Responsibilities: cover cancellation, queue limits, cleanup, and native parity.
    Does not contain: normal editor profile changes or compiler instrumentation.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { CompilerAnalysisWorker, HostProcessLaunchQueue } = require("../lib/compiler-worker");
const { CompilerTraceCache } = require("../lib/compiler-worker-runtime");
const { analyzeSavedModule, decodePreprocessed } = require("../lib/compiler-analysis");

function setup(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-worker-test-"));
    const filePath = path.join(directory, "main.bas");
    fs.writeFileSync(filePath, "Dim workerValue As Long\n");
    const worker = new CompilerAnalysisWorker(path.join(__dirname, "fixtures/compiler-worker.js"));
    t.after(async () => { await worker.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    const options = { compilerPath: process.execPath, filePath, overlays: new Map([[filePath, "Dim workerValue As Long\n"]]), timeoutMs: 5000 };
    return { worker, options };
}

test("host process launch queue yields between supervisor dispatches", () => {
    const scheduled = [];
    const launched = [];
    const queue = new HostProcessLaunchQueue((callback) => scheduled.push(callback));

    queue.enqueue(() => launched.push("workspace-first"), 1);
    queue.enqueue(() => launched.push("workspace-second"), 1);
    queue.enqueue(() => launched.push("interactive"), 0);
    assert.equal(scheduled.length, 1);

    scheduled.shift()();
    assert.deepEqual(launched, ["interactive"], "foreground work should move ahead of queued indexing spawns");
    assert.equal(scheduled.length, 1, "only one supervisor request should be scheduled per event-loop turn");
    scheduled.shift()();
    assert.deepEqual(launched, ["interactive", "workspace-first"]);
    scheduled.shift()();
    assert.deepEqual(launched, ["interactive", "workspace-first", "workspace-second"]);
});

test("trace cache reuses only exact compiler output and bounds retained bytes and entries", () => {
    const cache = new CompilerTraceCache(1024 * 1024, 2);
    const trace = (text) => `''@fb-editor-v1 1 0 ${Buffer.from("main.bas").toString("hex")}\n${text}`;
    const decode = (text, cwd = process.cwd()) => cache.decode(trace(text), cwd, () => {});
    const first = decode("Dim cacheValue As Long\n");
    assert.equal(first.hit, false);
    first.analysis.text = "mutated by a consumer";
    const again = decode("Dim cacheValue As Long\n");
    assert.equal(again.hit, true);
    assert.equal(again.analysis.text, "\nDim cacheValue As Long\n");
    assert.equal(decode("Dim cacheValue As Long\n", path.join(process.cwd(), "elsewhere")).hit, false);
    assert.equal(decode("Dim cacheValue As Double\n").hit, false);
    assert.equal(cache.entries.size, 2);
    assert.equal(decode("Dim cacheValue As Long\n").hit, false, "Least-recently-used traces are evicted");
    assert.ok(cache.bytes <= cache.maxBytes);
    const small = new CompilerTraceCache(1, 2);
    assert.equal(small.decode(trace("Dim value As Long\n"), process.cwd(), () => {}).hit, false);
    assert.equal(small.bytes, 0);
    cache.clear();
    assert.equal(cache.bytes, 0);
    assert.equal(cache.entries.size, 0);
});

test("decoder cancellation interrupts synchronous trace parsing and never populates its cache", () => {
    let checks = 0;
    const cancel = () => { if (++checks === 3) throw new Error("cancelled checkpoint"); };
    assert.throws(() => decodePreprocessed("Dim value As Long\n".repeat(2000), process.cwd(), cancel), /cancelled checkpoint/);
    assert.equal(checks, 3);
    const cache = new CompilerTraceCache();
    assert.throws(() => cache.decode("Dim value As Long\n", process.cwd(), () => { throw new Error("cancelled"); }), /cancelled/);
    assert.equal(cache.entries.size, 0);
});

test("persistent worker returns independent native records and reuses exact trace decoding", async (t) => {
    const { worker, options } = setup(t);
    assert.equal(worker.worker, null, "Construction alone must not start a thread");
    const first = await worker.analyze({
        ...options,
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        requireSemanticModel: true,
        allowSemanticSidecarFallback: false
    });
    assert.ok(first.workerStats.threadId > 0);
    assert.equal(first.workerStats.cacheHit, false);
    assert.equal(first.semanticExport, true, "the worker must preserve the full semantic sidecar request");
    assert.equal(first.semanticBindingsExport, true);
    assert.equal(first.semanticModelRequired, true);
    assert.equal(first.semanticSidecarFallback, false);
    first.text = "consumer mutation";
    const second = await worker.analyze(options);
    assert.equal(second.text, "\n" + options.overlays.get(options.filePath));
    assert.equal(second.workerStats.threadId, first.workerStats.threadId);
    assert.equal(second.workerStats.cacheHit, true);
    worker.cancelAll();
    assert.equal((await worker.analyze(options)).workerStats.cacheHit, false);
    assert.equal(worker.bytes, 0);
});

test("prepared worker models can be released independently", async (t) => {
    const { worker, options } = setup(t);
    const preparation = {
        requestedFile: options.filePath,
        expandedUri: { scheme: "freebasic-preprocessed", value: "freebasic-preprocessed:/release-test.bas", path: "/release-test.bas" }
    };
    const first = await worker.analyze(options, preparation);
    const second = await worker.analyze({
        ...options,
        overlays: new Map([[options.filePath, "Dim secondWorkerValue As Double\nPrint secondWorkerValue\n"]])
    }, preparation);
    const input = { uri: { scheme: "file", fsPath: options.filePath }, openFiles: [options.filePath] };
    assert.ok(worker.models.has(first.snapshotId));
    assert.ok(worker.models.has(second.snapshotId));

    assert.equal(worker.releaseModel(first.snapshotId), true);
    assert.equal(worker.releaseModel(first.snapshotId), false);
    assert.equal(worker.models.has(first.snapshotId), false);
    assert.equal(worker.models.has(second.snapshotId), true);
    await assert.rejects(worker.query(first.snapshotId, "validate", input), /expired/);
    assert.equal((await worker.query(second.snapshotId, "validate", input)).result, true);
});

test("queued buffers and arguments are immutable and cancelled requests cannot publish late replies", async (t) => {
    const { worker, options } = setup(t);
    const controller = new AbortController();
    const first = worker.analyze({ ...options, compilerArguments: ["-d", "wait"], signal: controller.signal });
    const rejected = assert.rejects(first, /cancelled/);
    const arguments_ = ["-d", "original"];
    const second = worker.analyze({ ...options, compilerArguments: arguments_ });
    options.overlays.set(options.filePath, "Dim changedValue As Double\n");
    arguments_[1] = "mutated";
    controller.abort();
    await rejected;
    const result = await second;
    assert.equal(result.mode, "original");
    assert.equal(result.source, "Dim workerValue As Long\n");
    assert.equal(worker.bytes, 0);
    assert.equal(worker.active, null);
});

test("persistent workers receive a fresh environment snapshot for each queued request", async (t) => {
    const { worker, options } = setup(t);
    const previous = process.env.FB_VSCODE_WORKER_TEST;
    t.after(() => {
        if (previous === undefined) delete process.env.FB_VSCODE_WORKER_TEST;
        else process.env.FB_VSCODE_WORKER_TEST = previous;
    });
    process.env.FB_VSCODE_WORKER_TEST = "first";
    assert.equal((await worker.analyze(options)).environmentValue, "first");
    process.env.FB_VSCODE_WORKER_TEST = "second";
    const second = worker.analyze({ ...options, compilerArguments: ["-d", "wait"] });
    process.env.FB_VSCODE_WORKER_TEST = "third";
    const third = worker.analyze(options);
    process.env.FB_VSCODE_WORKER_TEST = "later";
    assert.equal((await second).environmentValue, "second");
    assert.equal((await third).environmentValue, "third");
});

test("worker rejects excessive queues and invalid inputs without leaking request ownership", async (t) => {
    const { worker, options } = setup(t);
    await assert.rejects(worker.analyze({ ...options, compilerArguments: ["-x", "output"] }), /does not accept/);
    await assert.rejects(worker.analyze({ ...options, timeoutMs: -1 }), /timeout/);
    assert.equal(worker.worker, null);
    const waiting = Array.from({ length: 16 }, () => worker.analyze({ ...options, compilerArguments: ["-d", "wait"] }));
    const settled = Promise.allSettled(waiting);
    await assert.rejects(worker.analyze(options), /queue is full/);
    worker.cancelAll();
    assert.ok((await settled).every((result) => result.status === "rejected"));
    await worker.dispose();
    assert.equal(worker.bytes, 0);
    assert.equal(worker.pending.length, 0);
    await assert.rejects(worker.analyze(options), /disposed/);
});

test("stalled decoding is terminated without blocking the editor thread or retaining temporary files", async (t) => {
    const { worker, options } = setup(t);
    const pending = worker.analyze({ ...options, compilerArguments: ["-d", "busy"], timeoutMs: 150 });
    const directory = worker.active.directory;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
        await assert.rejects(pending, /timed out/);
        const next = await worker.analyze(options);
        assert.equal(next.mode, "normal");
        assert.ok(ticks >= 5, "The caller's event loop must remain responsive while the worker is busy");
        assert.equal(fs.existsSync(directory), false);
    } finally { clearInterval(timer); }
});

test("queued request bytes are bounded independently of request count", async (t) => {
    const { worker, options } = setup(t);
    const overlays = new Map([[options.filePath, " ".repeat(24 * 1024 * 1024)]]);
    const waiting = [worker.analyze({ ...options, overlays, compilerArguments: ["-d", "wait"] }), worker.analyze({ ...options, overlays, compilerArguments: ["-d", "wait"] })];
    const settled = Promise.allSettled(waiting);
    await assert.rejects(worker.analyze({ ...options, overlays }), /64 MiB/);
    worker.cancelAll();
    assert.ok((await settled).every((result) => result.status === "rejected"));
    await worker.dispose();
    assert.equal(worker.bytes, 0);
});

test("worker crashes reclaim native child processes and temporary files before restarting", async (t) => {
    const { worker, options } = setup(t);
    const pending = worker.analyze({ ...options, compilerArguments: ["-d", "crash-child"] });
    const directory = worker.active.directory;
    const rejected = assert.rejects(pending, /Deliberate compiler worker crash/);
    let pid;
    for (let attempt = 0; attempt < 400 && !pid; attempt++) {
        pid = worker.active?.pid;
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await rejected;
    assert.ok(pid > 0);
    await worker.stopping;
    const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { assert.equal(error.code, "ESRCH"); return false; } };
    for (let attempt = 0; attempt < 100 && alive(); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(), false, "A crashed worker must not leave its compiler child running");
    assert.equal(fs.existsSync(directory), false);
    assert.equal((await worker.analyze(options)).mode, "normal");
});

test("malformed worker replies reject the request instead of throwing in the editor host", async (t) => {
    const { worker, options } = setup(t);
    await assert.rejects(worker.analyze({ ...options, compilerArguments: ["-d", "bad-reply"] }), /Invalid compiler worker response/);
    assert.equal((await worker.analyze(options)).mode, "normal");
});

test("disposal waits for a running child to be reaped and its temporary directory removed", async (t) => {
    const { worker, options } = setup(t);
    const pending = worker.analyze({ ...options, compilerArguments: ["-d", "live-child"] });
    const rejected = assert.rejects(pending, /invalidated/);
    const directory = worker.active.directory;
    let pid;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
        pid = worker.active?.pid;
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(pid > 0);
    await worker.dispose();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(fs.existsSync(directory), false);
    assert.equal(worker.bytes, 0);
});

test("real native worker results match direct analysis across repeats and unsaved changes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const worker = new CompilerAnalysisWorker();
    t.after(() => worker.dispose());
    const filePath = path.join(__dirname, "integration/workspace/compiler-types.bas");
    const options = { compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, "Dim nativeValue As Long\nPrint nativeValue\n"]]), allowErrors: true };
    const direct = await analyzeSavedModule(options);
    const first = await worker.analyze(options);
    const second = await worker.analyze(options);
    const stats = second.workerStats;
    delete first.workerStats;
    delete second.workerStats;
    assert.deepEqual(first, direct);
    assert.deepEqual(second, direct);
    assert.equal(stats.cacheHit, true);
    options.overlays.set(filePath, "Dim nativeValue As Double\nPrint nativeValue +\nPrint nativeValue\n");
    const changed = await worker.analyze(options);
    assert.equal(changed.workerStats.cacheHit, false);
    assert.equal(changed.partial, true);
    assert.ok(changed.expressions.some((expression) => expression.typeName === "double"));
});

test("real native worker preserves full compiler-binding sidecars", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-worker-semantic-sidecar-"));
    const filePath = path.join(directory, "constructors.bas");
    const source = [
        "Type WorkerValue",
        "    As Integer marker",
        "    Declare Constructor()",
        "    Declare Constructor(ByRef source As WorkerValue)",
        "    Declare Constructor(ByVal value As Long)",
        "End Type",
        "Constructor WorkerValue()",
        "    This.marker = 1",
        "End Constructor",
        "Constructor WorkerValue(ByRef source As WorkerValue)",
        "    This.marker = source.marker",
        "End Constructor",
        "Constructor WorkerValue(ByVal value As Long)",
        "    This.marker = value",
        "End Constructor",
        "Sub workerProbe()",
        "    Dim As WorkerValue defaultValue",
        "    Dim As WorkerValue arrayValues(0 To 1)",
        "    Dim As WorkerValue copiedValue = defaultValue",
        "    Dim As WorkerValue convertedValue = 7",
        "    Dim As WorkerValue Ptr allocatedValue = New WorkerValue(7)",
        "    Dim As WorkerValue Ptr allocatedArray = New WorkerValue[2]",
        "End Sub",
        "workerProbe()",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, source);
    const worker = new CompilerAnalysisWorker();
    t.after(async () => { await worker.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    const options = {
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticBindings: true,
        requireSemanticModel: true,
        allowSemanticSidecarFallback: false
    };
    const direct = await analyzeSavedModule(options);
    const result = await worker.analyze(options);
    assert.ok(direct.semanticImplicitCalls.length >= 6, "compiler analysis must export the fixture's selected constructor overloads");
    assert.deepEqual(result.semanticImplicitCalls, direct.semanticImplicitCalls);
    assert.ok(result.semanticBindings.length > 0);
});

test("cancelling active native analysis reaps the compiler promptly and keeps the worker reusable", { skip: !process.env.FBC_EDITOR_EXECUTABLE, timeout: 15000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-worker-cancel-test-"));
    const filePath = path.join(directory, "main.bas");
    const diskSource = "Print 1 + 2\n";
    fs.writeFileSync(filePath, diskSource);
    const worker = new CompilerAnalysisWorker();
    t.after(async () => { await worker.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });

    /* Enough independent expressions keep fbc busy long enough for the test
       to cancel after the real child has spawned, without relying on a
       compiler-specific benchmark file or changing the saved source. */
    const overlay = Array.from({ length: 20000 }, (_, index) => `Print ${index + 1} + ${index + 2}`).join("\n") + "\n";
    const controller = new AbortController();
    const pending = worker.analyze({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, overlay]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        signal: controller.signal,
        timeoutMs: 10000
    });
    const rejected = assert.rejects(pending, /cancelled/);
    const processWaitStarted = performance.now();
    while (!worker.active?.pid && performance.now() - processWaitStarted < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(worker.active?.pid > 0, "The worker must launch a real compiler child before cancellation");

    const processId = worker.active.pid;
    const temporaryDirectory = worker.active.directory;
    const cancelledAt = performance.now();
    controller.abort();
    await rejected;

    const cleanupDeadline = performance.now() + 5000;
    while ((worker.active || worker.stopping) && performance.now() < cleanupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const cancellationMs = performance.now() - cancelledAt;
    t.diagnostic(`Active native compiler cancellation and worker cleanup: ${cancellationMs.toFixed(1)} ms.`);
    assert.equal(worker.active, null, "The worker queue must advance after the child is reaped");
    assert.equal(worker.bytes, 0);
    assert.ok(cancellationMs < 2500, `Native cancellation should finish within the worker's shutdown grace, got ${Math.round(cancellationMs)} ms`);
    assert.equal(fs.existsSync(temporaryDirectory), false, "Cancelled analysis must remove its compiler scratch directory");
    assert.throws(() => process.kill(processId, 0), { code: "ESRCH" }, "The cancelled compiler process must no longer exist");
    assert.equal(fs.readFileSync(filePath, "utf8"), diskSource, "The unsaved overlay must never be written to disk");

    const next = await worker.analyze({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, diskSource]]),
        allowErrors: true,
        timeoutMs: 10000
    });
    assert.equal(next.partial, false, "The same worker must accept a later valid analysis");
    assert.equal(worker.bytes, 0);
});

test("prepared native recovery keeps the host responsive and later expressions typed", { skip: !process.env.FBC_EDITOR_EXECUTABLE, timeout: 20000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-worker-recovery-test-"));
    const filePath = path.join(directory, "main.bas");
    const diskSource = "Print 0\n";
    fs.writeFileSync(filePath, diskSource);
    const worker = new CompilerAnalysisWorker();
    let snapshotId;
    t.after(async () => {
        if (snapshotId) worker.releaseModel(snapshotId);
        await worker.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const expressions = Array.from({ length: 2000 }, (_, index) => `Print recoveryValue * ${index + 2}`);
    const overlay = [
        "Dim recoveryValue As Double",
        "Print recoveryValue +",
        ...expressions,
        ""
    ].join("\n");
    const options = {
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, overlay]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 15000
    };
    const preparation = {
        requestedFile: filePath,
        expandedUri: {
            scheme: "freebasic-preprocessed",
            value: "freebasic-preprocessed:/recovery-stress.bas",
            path: "/recovery-stress.bas"
        }
    };
    const finalExpression = `recoveryValue * ${expressions.length + 1}`;
    const position = {
        line: overlay.split("\n").findIndex((line) => line === `Print ${finalExpression}`),
        character: "Print ".length
    };
    assert.ok(position.line >= 0, "The final recovery expression must be present in the overlay");

    let eventLoopTicks = 0;
    const timer = setInterval(() => eventLoopTicks++, 5);
    try {
        const snapshot = await worker.analyze(options, preparation);
        snapshotId = snapshot.snapshotId;
        assert.equal(snapshot.partial, true, "The broken input must retain its native recovery status");
        assert.equal(snapshot.completion.errorCount, 1);
        assert.equal(snapshot.completion.reachedEnd, true, "Recovery must finish the large unsaved module");
        assert.ok(eventLoopTicks > 0, "Prepared compiler work must leave the editor host event loop runnable");

        const result = await worker.query(snapshotId, "expression", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: [filePath],
            position,
            end: { line: position.line, character: position.character + finalExpression.length }
        });
        assert.equal(result.result?.typeName.toLowerCase(), "double");
        assert.equal(result.result?.provisional, false, "A later independent expression must retain its compiler type");
        assert.equal(fs.readFileSync(filePath, "utf8"), diskSource, "Worker analysis must not save the overlay");
    } finally {
        clearInterval(timer);
    }
});

test("prepared recovery uses dirty included headers after a syntax error without saving either buffer", { skip: !process.env.FBC_EDITOR_EXECUTABLE, timeout: 20000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-worker-overlay-recovery-test-"));
    const filePath = path.join(directory, "main.bas");
    const headerPath = path.join(directory, "types.bi");
    const diskSource = "Print 0\n";
    const diskHeader = "Type BufferRecord\n    value As Long\nEnd Type\n";
    const overlay = [
        '#include "types.bi"',
        "Dim current As BufferRecord",
        "Print current +",
        "Print current.value",
        ""
    ].join("\n");
    const overlayHeader = "Type BufferRecord\n    value As Double\nEnd Type\n";
    fs.writeFileSync(filePath, diskSource);
    fs.writeFileSync(headerPath, diskHeader);
    const worker = new CompilerAnalysisWorker();
    let snapshotId;
    t.after(async () => {
        if (snapshotId) worker.releaseModel(snapshotId);
        await worker.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const options = {
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, overlay], [headerPath, overlayHeader]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        timeoutMs: 15000
    };
    const preparation = {
        requestedFile: filePath,
        expandedUri: {
            scheme: "freebasic-preprocessed",
            value: "freebasic-preprocessed:/dirty-header-recovery.bas",
            path: "/dirty-header-recovery.bas"
        }
    };
    const warmupSource = [
        '#include "types.bi"',
        "Dim current As BufferRecord",
        "Print current.value",
        ""
    ].join("\n");
    const warmup = await worker.analyze({
        ...options,
        overlays: new Map([[filePath, warmupSource]])
    }, {
        ...preparation,
        expandedUri: {
            scheme: "freebasic-preprocessed",
            value: "freebasic-preprocessed:/dependency-warmup.bas",
            path: "/dependency-warmup.bas"
        }
    });
    assert.equal(warmup.analysisPasses, 2, "The initial prepared build should discover then freeze the disk header");
    assert.equal(warmup.dependencyCacheHit, false);
    worker.releaseModel(warmup.snapshotId);

    const expression = "current.value";
    const position = {
        line: overlay.split("\n").findIndex((line) => line === `Print ${expression}`),
        character: "Print ".length
    };
    assert.ok(position.line >= 0, "The post-recovery expression must be present in the dirty module buffer");

    let eventLoopTicks = 0;
    const timer = setInterval(() => eventLoopTicks++, 5);
    try {
        const snapshot = await worker.analyze(options, preparation);
        snapshotId = snapshot.snapshotId;
        assert.equal(snapshot.dependencyCacheHit, true, "The warmed dependency inventory should be reused only as an input-path hint");
        assert.equal(snapshot.analysisPasses, 1, "The dirty header should be captured before the only native analysis pass");
        assert.equal(snapshot.partial, true);
        assert.equal(snapshot.completion.errorCount, 1);
        assert.equal(snapshot.completion.reachedEnd, true);
        assert.ok(snapshot.dependencies.includes(headerPath), "The model must retain the included dirty header");
        assert.equal(snapshot.sources.find((source) => source.filePath === headerPath)?.text, overlayHeader);
        assert.equal(snapshot.sources.find((source) => source.filePath === headerPath)?.overlay, true);
        assert.ok(eventLoopTicks > 0, "Unsaved multi-file recovery must leave the extension host event loop runnable");

        const result = await worker.query(snapshotId, "expression", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: [filePath, headerPath],
            position,
            end: { line: position.line, character: position.character + expression.length }
        });
        assert.equal(result.result?.typeName.toLowerCase(), "double", "The post-error expression must use the unsaved header declaration");
        assert.equal(result.result?.provisional, false);
        assert.equal(fs.readFileSync(filePath, "utf8"), diskSource, "Worker analysis must not save the unsaved module");
        assert.equal(fs.readFileSync(headerPath, "utf8"), diskHeader, "Worker analysis must not save the unsaved header");
    } finally {
        clearInterval(timer);
    }
});

test("native execution is repeated when a previously missing include appears with unchanged request text", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-worker-include-test-"));
    const worker = new CompilerAnalysisWorker();
    t.after(async () => { await worker.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    const filePath = path.join(directory, "main.bas");
    fs.writeFileSync(filePath, '#include "appeared.bi"\nPrint includedValue\n');
    const options = { compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, allowErrors: true };
    const before = await worker.analyze(options);
    assert.equal(before.partial, true);
    fs.writeFileSync(path.join(directory, "appeared.bi"), "Dim includedValue As Double\n");
    const after = await worker.analyze(options);
    assert.equal(after.partial, false);
    assert.equal(after.workerStats.cacheHit, false);
    assert.ok(after.dependencies.includes(path.join(directory, "appeared.bi")));
    assert.ok(after.expressions.some((expression) => expression.typeName === "double"));
    await assert.rejects(worker.analyze({ ...options, compilerPath: path.join(directory, "missing-compiler") }), /ENOENT/);
    assert.equal((await worker.analyze(options)).partial, false, "A spawn failure must not poison the persistent worker");
});

/* end of tests/compiler-worker.test.js */
