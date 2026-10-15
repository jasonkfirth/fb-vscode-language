/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/benchmark-compiler-workspace.js
    Purpose: Measure cold and repeated native workspace-symbol searches.
    Responsibilities: exercise bounded summary caching across real modules.
    Does not contain: synthetic declarations, compiler edits, or latency gates.
*/

const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { performance, PerformanceObserver } = require("perf_hooks");
const { randomUUID } = require("crypto");
const { MAX_ANALYSIS_BYTES, decodeCompilerSourceBuffer } = require("../lib/compiler-analysis");
const { CompilerAnalysisWorker } = require("../lib/compiler-worker");
const { CompilerProcessSupervisor } = require("../lib/compiler-process-supervisor");
const { indexWorkspaceJobs, WORKSPACE_INDEX_WORKER_COUNT } = require("../lib/compiler-workspace-service");
const { BoundedTextMap } = require("../lib/bounded-text-map");

const MAX_HINTS_PER_MODULE = 500;
const MAX_TOTAL_HINTS = 100000;
const MAX_TOTAL_HINT_BYTES = 4 * 1024 * 1024;
const MAX_HINT_SOURCE_FILES = 5000;
const MAX_HINT_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_HINT_SCAN_BYTES = 256 * 1024 * 1024;
const { listCompilerSourceFiles, resolveCompilerSourcePath, resolveFreeBasicRoot } = require("./audit-freebasic-coverage");

const FOREGROUND_PROBE_INTERVAL_MS = 5000;

async function measure(operation) {
    const started = performance.now();
    let previous = started, largestPauseMs = 0, ticks = 0;
    const cpuStarted = process.cpuUsage();
    const resourcesStarted = process.resourceUsage();
    const eventLoopStarted = performance.eventLoopUtilization();
    const garbageCollectionPauses = [];
    const garbageCollectionObserver = new PerformanceObserver((list) => {
        garbageCollectionPauses.push(...list.getEntries().map((entry) => entry.duration));
    });
    garbageCollectionObserver.observe({ entryTypes: ["gc"] });
    const timer = setInterval(() => {
        const now = performance.now();
        largestPauseMs = Math.max(largestPauseMs, now - previous);
        previous = now;
        ticks++;
    }, 5);
    try {
        const value = await operation();
        const elapsedMs = performance.now() - started;
        const cpu = process.cpuUsage(cpuStarted);
        const resources = process.resourceUsage();
        const eventLoop = performance.eventLoopUtilization(eventLoopStarted);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await new Promise((resolve) => setImmediate(resolve));
        garbageCollectionPauses.push(...garbageCollectionObserver.takeRecords().map((entry) => entry.duration));
        return {
            value,
            elapsedMs,
            largestPauseMs,
            ticks,
            processUsage: {
                userCpuMs: cpu.user / 1000,
                systemCpuMs: cpu.system / 1000,
                voluntaryContextSwitches: Math.max(0,
                    resources.voluntaryContextSwitches - resourcesStarted.voluntaryContextSwitches),
                involuntaryContextSwitches: Math.max(0,
                    resources.involuntaryContextSwitches - resourcesStarted.involuntaryContextSwitches),
                maximumResidentSetKiB: resources.maxRSS
            },
            eventLoopUsage: {
                activeMs: eventLoop.active,
                idleMs: eventLoop.idle,
                utilization: eventLoop.utilization
            },
            garbageCollection: {
                count: garbageCollectionPauses.length,
                totalMs: garbageCollectionPauses.reduce((sum, pause) => sum + pause, 0),
                maximumMs: garbageCollectionPauses.reduce((maximum, pause) => Math.max(maximum, pause), 0)
            }
        };
    } finally {
        clearInterval(timer);
        garbageCollectionObserver.disconnect();
    }
}

function compilerModules(root, requestedMaximum) {
    const directory = path.join(root, "src/compiler");
    const files = listCompilerSourceFiles(directory).map((relativePath) => path.join(directory, relativePath));
    if (!files.length || files.length > 5000) throw new Error("The compiler source module inventory is empty or exceeds 5000 modules.");
    const maximum = requestedMaximum ?? files.length;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > files.length) {
        throw new Error(`FBC_WORKSPACE_BENCHMARK_MAX_MODULES must be between 1 and ${files.length}.`);
    }
    return files.slice(0, maximum);
}

/* These are pre-read hints only. The compiler's opened-file list remains the
   authority; ModelStore adds a second pass if macro or option-driven includes
   are absent from this lightweight source graph. */
function compilerIncludeDependencyHints(modules, includePaths) {
    const parsedIncludes = new Map();
    let scannedSourceBytes = 0;
    let scanLimitReached = false;
    const sourceIncludes = (filePath) => {
        const resolved = path.resolve(filePath);
        if (parsedIncludes.has(resolved)) return parsedIncludes.get(resolved);
        if (scanLimitReached) return null;
        try {
            const sourceBytes = fs.statSync(resolved).size;
            if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0 ||
                sourceBytes > MAX_HINT_SOURCE_BYTES || parsedIncludes.size >= MAX_HINT_SOURCE_FILES ||
                scannedSourceBytes + sourceBytes > MAX_HINT_SCAN_BYTES) {
                scanLimitReached = true;
                return null;
            }
            const buffer = fs.readFileSync(resolved);
            if (buffer.length > MAX_HINT_SOURCE_BYTES || scannedSourceBytes + buffer.length > MAX_HINT_SCAN_BYTES) {
                scanLimitReached = true;
                return null;
            }
            scannedSourceBytes += buffer.length;
            const text = decodeCompilerSourceBuffer(buffer, resolved).replace(/^\uFEFF/, "");
            const includes = [];
            for (const line of text.split(/\r\n|\n|\r/)) {
                const match = /^\s*#\s*include\s+(?:once\s+)?(?:"([^"\r\n]+)"|<([^>\r\n]+)>)/i.exec(line);
                if (match) includes.push({ path: match[1] || match[2], system: !match[1] });
            }
            parsedIncludes.set(resolved, includes);
            return includes;
        } catch {
            parsedIncludes.set(resolved, null);
            return null;
        }
    };
    const resolve = (sourcePath, include) => {
        if (typeof include.path !== "string" || !include.path || /[\0\r\n]/.test(include.path)) return null;
        const directories = include.system ? includePaths : [path.dirname(sourcePath), ...includePaths];
        for (const directory of directories) {
            const candidate = path.resolve(directory, include.path);
            try { if (fs.statSync(candidate).isFile()) return candidate; }
            catch { /* Unknown or macro-expanded paths stay for compiler discovery. */ }
        }
        return null;
    };

    const hints = new Map();
    let totalHintPaths = 0, totalHintBytes = 0, skippedModules = 0;
    for (const rootFile of modules) {
        const root = path.resolve(rootFile);
        const seen = new Set([root]);
        const queue = [root];
        const dependencies = [];
        let dependencyBytes = 0;
        let skipped = false;
        for (let index = 0; index < queue.length; index++) {
            const sourcePath = queue[index];
            const includes = sourceIncludes(sourcePath);
            if (!includes) {
                skipped = true;
                break;
            }
            for (const include of includes) {
                const included = resolve(sourcePath, include);
                if (!included || seen.has(included)) continue;
                const nextBytes = Buffer.byteLength(included);
                if (dependencies.length >= MAX_HINTS_PER_MODULE || totalHintPaths + dependencies.length + 1 > MAX_TOTAL_HINTS ||
                    totalHintBytes + dependencyBytes + nextBytes > MAX_TOTAL_HINT_BYTES) {
                    skipped = true;
                    break;
                }
                seen.add(included);
                dependencies.push(included);
                dependencyBytes += nextBytes;
                queue.push(included);
            }
            if (skipped) break;
        }
        if (skipped) {
            hints.set(root, []);
            skippedModules++;
            continue;
        }
        hints.set(root, dependencies);
        totalHintPaths += dependencies.length;
        totalHintBytes += dependencyBytes;
    }
    return { hints, parsedSourceCount: parsedIncludes.size, scannedSourceBytes, scanLimitReached,
        totalHintPaths, totalHintBytes, skippedModules };
}

function summarizeLatency(samples) {
    const ordered = [...samples].sort((first, second) => first - second);
    const percentile = (value) => ordered.length ? ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)] : null;
    return {
        samples: ordered.length,
        medianMs: percentile(0.5),
        p95Ms: percentile(0.95),
        maximumMs: ordered.length ? ordered[ordered.length - 1] : null
    };
}

function summarizeWorkerQueryPhases(samples) {
    const fields = ["queryFreshnessBeforeMs", "modelQueryMs", "queryFreshnessAfterMs", "workerMessageDelayMs", "messageHandlerMs"];
    return Object.fromEntries(fields.map((field) => [field, summarizeLatency(samples.map((sample) => sample?.[field]).filter(Number.isFinite))]));
}

async function prepareForegroundProbe(root, compilerPath, includePaths, worker) {
    const filePath = resolveCompilerSourcePath(path.join(root, "src/compiler"), "parser-proc.bas");
    const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const lines = source.split(/\r\n|\n|\r/);
    const hoverLine = lines.findIndex((line) => line.includes("mode = cProcCallingConv("));
    assert.ok(hoverLine >= 0, "The interactive hover probe source changed.");
    const hoverStart = lines[hoverLine].indexOf("cProcCallingConv");
    const hoverInput = {
        uri: { scheme: "file", fsPath: filePath },
        openFiles: [],
        position: { line: hoverLine, character: hoverStart },
        end: { line: hoverLine, character: hoverStart + "cProcCallingConv".length }
    };
    const started = performance.now();
    const value = "freebasic-preprocessed:/workspace-interactive-probe.bas";
    const model = await worker.analyze({
        compilerPath,
        filePath,
        compilerArguments: includePaths.flatMap((includePath) => ["-i", path.resolve(includePath)]),
        allowErrors: true,
        timeoutMs: 30000
    }, { requestedFile: filePath, expandedUri: { scheme: "freebasic-preprocessed", value, path: "/workspace-interactive-probe.bas" } });
    const input = { uri: { scheme: "file", fsPath: filePath }, openFiles: [] };
    const warmTokens = await worker.query(model.snapshotId, "semanticTokens", input);
    const warmHover = await worker.query(model.snapshotId, "hover", hoverInput);
    assert.ok(warmTokens.result?.length > 0, "The foreground probe must query a real compiler-module snapshot.");
    assert.ok(warmHover.result && typeof warmHover.result === "object", "The foreground hover probe must have a compiler result.");
    return {
        file: path.relative(root, filePath),
        preparationMs: performance.now() - started,
        worker,
        snapshotId: model.snapshotId,
        input,
        hoverInput,
        semanticTokenSamples: [],
        hoverSamples: [],
        semanticTokenPhases: [],
        hoverPhases: [],
        failures: [],
        pending: null,
        timer: null,
        startSampling() {
            if (this.timer) return;
            void this.sample();
            this.timer = setInterval(() => { void this.sample(); }, FOREGROUND_PROBE_INTERVAL_MS);
        },
        stopSampling() {
            clearInterval(this.timer);
            this.timer = null;
        },
        async sample() {
            if (this.pending) return;
            this.pending = (async () => {
                let queryStarted = performance.now();
                const tokens = await worker.query(model.snapshotId, "semanticTokens", input);
                assert.ok(tokens.result?.length > 0, "Foreground semantic-token queries must retain their result during indexing.");
                this.semanticTokenSamples.push(performance.now() - queryStarted);
                if (tokens.workerStats) this.semanticTokenPhases.push(tokens.workerStats);
                queryStarted = performance.now();
                const hover = await worker.query(model.snapshotId, "hover", hoverInput);
                assert.ok(hover.result && typeof hover.result === "object", "Foreground hover queries must retain their result during indexing.");
                this.hoverSamples.push(performance.now() - queryStarted);
                if (hover.workerStats) this.hoverPhases.push(hover.workerStats);
            })().catch((error) => {
                this.failures.push(error.message);
            }).finally(() => { this.pending = null; });
        },
        async drain() { if (this.pending) await this.pending; },
        report() {
            return {
                file: this.file,
                preparationMs: this.preparationMs,
                sampleIntervalMs: FOREGROUND_PROBE_INTERVAL_MS,
                semanticTokens: summarizeLatency(this.semanticTokenSamples),
                hover: summarizeLatency(this.hoverSamples),
                semanticTokenWorkerPhases: summarizeWorkerQueryPhases(this.semanticTokenPhases),
                hoverWorkerPhases: summarizeWorkerQueryPhases(this.hoverPhases),
                failures: this.failures
            };
        }
    };
}

async function runSearch(workers, modules, compilerPath, includePaths, query, passName, foregroundProbe = null, options = {}) {
    const buffers = new Map();
    const limit = options.limit ?? 20000;
    const expandedCache = options.expandedCache || null;
    const progressMessages = [];
    const workspaceIds = [];
    for (const worker of workers) workspaceIds.push((await worker.beginWorkspace(buffers, query, limit)).workspaceId);
    try {
        const measured = await measure(async () => {
            const jobs = modules.map((filePath) => ({
                    compilerPath,
                    filePath,
                    compilerArguments: includePaths.flatMap((includePath) => ["-i", path.resolve(includePath)]),
                    allowErrors: true,
                    timeoutMs: 30000,
                    profileProcessOutput: true,
                    profileWorkspaceMemory: true,
                    dependencyHints: options.dependencyHints?.get(path.resolve(filePath)) || [],
                    label: filePath
            }));
            foregroundProbe?.startSampling();
            const indexStarted = performance.now();
            const indexed = await indexWorkspaceJobs(workers, jobs, workspaceIds, undefined, () => {}, (expanded) => {
                expandedCache?.set(expanded.uri, expanded.text);
            }, limit, (processed, cacheHits, total) => {
                if (processed % 25 === 0 || processed === total) progressMessages.push(`${passName}: ${processed}/${total} modules, ${cacheHits} cached.`);
            }, async () => { await foregroundProbe?.drain(); });
            const indexingJobsMs = performance.now() - indexStarted;
            foregroundProbe?.stopSampling();
            await foregroundProbe?.drain();
            if (foregroundProbe?.failures.length) throw new Error(`Foreground query failed during workspace indexing: ${foregroundProbe.failures[0]}`);
            const finishStarted = performance.now();
            const verification = await Promise.all(workers.map((worker, index) => worker.finishWorkspace(workspaceIds[index], buffers)));
            const finishWorkspaceMs = performance.now() - finishStarted;
            assert.ok(verification.every((entry) => entry.verified), "Workspace sources changed during the benchmark.");
            return {
                processed: indexed.indexed,
                cacheHits: indexed.cached,
                cacheMisses: indexed.indexed - indexed.cached,
                retainedRecords: indexed.retainedRecords,
                maximumCacheBytes: indexed.maximumCacheBytes,
                maximumRecordBytes: indexed.maximumRecordBytes,
                workerResultEntries: indexed.resultEntries,
                workerResultBytes: indexed.resultBytes,
                maximumBatchResultEntries: indexed.maximumBatchResultEntries,
                maximumBatchResultBytes: indexed.maximumBatchResultBytes,
                workspaceMemorySamples: indexed.workspaceMemorySamples,
                maximumWorkspaceMemory: indexed.maximumWorkspaceMemory,
                maximumBatchMergeMs: indexed.maximumBatchMergeMs,
                totalBatchMergeMs: indexed.totalBatchMergeMs,
                maximumBatchDispatchMs: indexed.maximumBatchDispatchMs,
                totalBatchDispatchMs: indexed.totalBatchDispatchMs,
                maximumWaitBeforeNextBatchMs: indexed.maximumWaitBeforeNextBatchMs,
                maximumWorkerMessageDelayMs: indexed.maximumWorkerMessageDelayMs,
                maximumWorkerMessageHandlerMs: indexed.maximumWorkerMessageHandlerMs,
                processRunnerExecutions: indexed.processRunnerExecutions,
                totalSupervisorStartCallMs: indexed.totalSupervisorStartCallMs,
                maximumSupervisorStartCallMs: indexed.maximumSupervisorStartCallMs,
                totalRunnerSpawnCallMs: indexed.totalRunnerSpawnCallMs,
                maximumRunnerSpawnCallMs: indexed.maximumRunnerSpawnCallMs,
                processOutputBytes: indexed.processOutputBytes,
                processOutputChunkCount: indexed.processOutputChunkCount,
                totalProcessOutputChunkHandlerMs: indexed.totalProcessOutputChunkHandlerMs,
                maximumProcessOutputChunkHandlerMs: indexed.maximumProcessOutputChunkHandlerMs,
                maximumProcessOutputChunkBytes: indexed.maximumProcessOutputChunkBytes,
                maximumProcessOutputFinalizeMs: indexed.maximumProcessOutputFinalizeMs,
                totalExecutionReplyPostMs: indexed.totalExecutionReplyPostMs,
                maximumExecutionReplyPostMs: indexed.maximumExecutionReplyPostMs,
                finishWorkspaceMs,
                maximumFinishMessageDelayMs: Math.max(0, ...verification.map((entry) => entry.workerStats?.workerMessageDelayMs || 0)),
                maximumFinishMessageHandlerMs: Math.max(0, ...verification.map((entry) => entry.workerStats?.messageHandlerMs || 0)),
                declarationCount: indexed.declarations,
                /* indexWorkspaceJobs already deduplicates by the exact symbol key. */
                resultCount: indexed.results.size,
                indexingJobsMs,
                verifiedSourceReceipts: verification.reduce((sum, entry) => sum + entry.sources, 0),
                workerCount: workers.length,
                expandedCacheEntries: expandedCache?.size || 0,
                expandedCacheBytes: expandedCache?.bytes || 0,
                foregroundQueries: foregroundProbe?.report() || null
            };
        });
        for (const message of progressMessages) console.error(message);
        return {
            ...measured.value,
            elapsedMs: measured.elapsedMs,
            largestHostPauseMs: measured.largestPauseMs,
            hostTimerTicks: measured.ticks,
            processUsage: measured.processUsage,
            eventLoopUsage: measured.eventLoopUsage,
            garbageCollection: measured.garbageCollection
        };
    } finally {
        foregroundProbe?.stopSampling();
        await foregroundProbe?.drain();
        workspaceIds.forEach((id, index) => workers[index].discardWorkspace(id));
    }
}

async function benchmarkWorkspaceSymbols(root, compilerPath, requestedMaximum, requestedConcurrency, requestedQuery, requestedResultLimit) {
    const modules = compilerModules(root, requestedMaximum);
    const concurrency = requestedConcurrency ?? WORKSPACE_INDEX_WORKER_COUNT;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > WORKSPACE_INDEX_WORKER_COUNT) {
        throw new Error(`FBC_WORKSPACE_BENCHMARK_CONCURRENCY must be an integer from 1 to ${WORKSPACE_INDEX_WORKER_COUNT}.`);
    }
    const matchingQuery = typeof requestedQuery === "string" && requestedQuery.trim().length > 0;
    if (matchingQuery && requestedQuery.length > 4096) throw new Error("FBC_WORKSPACE_BENCHMARK_QUERY exceeds the 4096-character limit.");
    const resultLimit = requestedResultLimit ?? (matchingQuery ? 1000 : 20000);
    if (!Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > 20000) {
        throw new Error("FBC_WORKSPACE_BENCHMARK_RESULT_LIMIT must be between 1 and 20000.");
    }
    const includePaths = [path.join(root, "src/compiler"), path.join(root, "inc"), path.join(root, "tests/fbcunit/inc")];
    const dependencyHintStarted = performance.now();
    const {
        hints: dependencyHints,
        parsedSourceCount: dependencyHintSourceCount,
        scannedSourceBytes: dependencyHintScannedBytes,
        scanLimitReached: dependencyHintScanLimitReached,
        totalHintPaths: dependencyHintPathCount,
        totalHintBytes: dependencyHintBytes,
        skippedModules: dependencyHintSkippedModules
    } = compilerIncludeDependencyHints(modules, includePaths);
    const dependencyHintDiscoveryMs = performance.now() - dependencyHintStarted;
    const processSupervisor = new CompilerProcessSupervisor();
    const workers = Array.from({ length: concurrency }, () =>
        new CompilerAnalysisWorker(undefined, undefined, undefined, undefined, processSupervisor));
    const foregroundWorker = new CompilerAnalysisWorker(undefined, undefined, undefined, undefined, processSupervisor);
    const missingQuery = `fbcworkspacebenchnomatch${randomUUID().replaceAll("-", "")}`;
    const query = matchingQuery ? requestedQuery : missingQuery;
    const expandedCache = new BoundedTextMap(8, MAX_ANALYSIS_BYTES);
    let foregroundProbe;
    try {
        foregroundProbe = await prepareForegroundProbe(root, compilerPath, includePaths, foregroundWorker);
        const cold = await runSearch(workers, modules, compilerPath, includePaths, query, "Cold workspace search", foregroundProbe, { limit: resultLimit, expandedCache, dependencyHints });
        const repeated = await runSearch(workers, modules, compilerPath, includePaths, query, "Repeated workspace search", null, { limit: resultLimit, expandedCache, dependencyHints });
        if (matchingQuery) {
            assert.ok(cold.resultCount > 0, "A matching benchmark query must return workspace symbols.");
            assert.ok(repeated.resultCount > 0, "The repeated matching query must return workspace symbols.");
        } else {
            assert.equal(cold.processed, modules.length);
            assert.equal(cold.resultCount, 0, "The cold measurement must scan all modules without matching a symbol.");
            assert.equal(repeated.processed, modules.length);
            assert.equal(repeated.resultCount, 0);
        }
        return {
            node: process.version,
            platform: process.platform,
            root: path.relative(process.cwd(), root),
            modules: modules.length,
            workerCount: concurrency,
            queryMode: matchingQuery ? "matching query; value withheld" : "unique no-match query; value withheld",
            resultLimit,
            dependencyHintDiscoveryMs,
            dependencyHintSourceCount,
            dependencyHintScannedBytes,
            dependencyHintScanLimitReached,
            dependencyHintPathCount,
            dependencyHintBytes,
            dependencyHintSkippedModules,
            cold,
            repeated,
            cacheHitRate: repeated.cacheHits / repeated.processed
        };
    } finally {
        if (foregroundProbe?.snapshotId) foregroundWorker.releaseModel(foregroundProbe.snapshotId);
        await Promise.all([...workers, foregroundWorker].map((worker) => worker.dispose()));
        await processSupervisor.dispose();
    }
}

if (require.main === module) {
    const compilerPath = process.env.FBC_EDITOR_EXECUTABLE;
    if (!compilerPath) throw new Error("Set FBC_EDITOR_EXECUTABLE to the native compiler bridge.");
    const maximum = process.env.FBC_WORKSPACE_BENCHMARK_MAX_MODULES === undefined
        ? undefined
        : Number(process.env.FBC_WORKSPACE_BENCHMARK_MAX_MODULES);
    const concurrency = process.env.FBC_WORKSPACE_BENCHMARK_CONCURRENCY === undefined
        ? undefined
        : Number(process.env.FBC_WORKSPACE_BENCHMARK_CONCURRENCY);
    const query = process.env.FBC_WORKSPACE_BENCHMARK_QUERY;
    const resultLimit = process.env.FBC_WORKSPACE_BENCHMARK_RESULT_LIMIT === undefined
        ? undefined
        : Number(process.env.FBC_WORKSPACE_BENCHMARK_RESULT_LIMIT);
    benchmarkWorkspaceSymbols(resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || ""), compilerPath, maximum, concurrency, query, resultLimit)
        .then((report) => console.log(JSON.stringify(report, null, 2)))
        .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { benchmarkWorkspaceSymbols, compilerModules, compilerIncludeDependencyHints, measure, runSearch };

/* end of benchmark-compiler-workspace.js */
