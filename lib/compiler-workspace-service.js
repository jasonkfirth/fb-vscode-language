/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-workspace-service.js
    Purpose: Coordinate native workspace symbol requests across workspace folders.
    Responsibilities: discover modules, capture contexts, and reject stale results.
    Does not contain: source parsing, native graphs, or inferred header contexts.
*/

const path = require("path");
const { performance } = require("perf_hooks");
const { projectContexts, analysisContext } = require("./compiler-contexts");
const { DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS } = require("./compiler-analysis");
const { compilerExecutableIdentity } = require("./compiler-model-store");
const { unpackWorkspaceSymbol, workspaceSymbolKey, workspaceSymbolKeyFromPacked, WORKSPACE_SYMBOL_STRIDE } = require("./compiler-workspace-symbols");

/* Keep the CPU-heavy symbol walk parallel but separate from editor analysis. */
const WORKSPACE_INDEX_WORKER_COUNT = 2;

function folders(service) {
    return (service.vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === "file");
}

function settingsSignature(service) {
    const windowConfiguration = service.vscode.workspace.getConfiguration("freebasic", null);
    return JSON.stringify(folders(service).map((folder) => {
        const configuration = service.vscode.workspace.getConfiguration("freebasic", folder.uri);
        const names = ["analysis.compilerPath", "analysis.timeoutMs", "analysis.projectContexts", "analysis.activeContext", "compiler.arguments", "includePaths", "index.exclude", "index.maxFiles", "index.maxSymbolResults", "index.workspaceConcurrency"];
        const compilerPath = service.compilerPathFor?.(folder.uri) || configuration.get("analysis.compilerPath", "");
        return [folder.uri.toString(), compilerExecutableIdentity(compilerPath, folder.uri.fsPath),
            ...names.map((name) => name === "analysis.compilerPath"
            ? service.compilerPathFor?.(folder.uri) || configuration.get(name)
            : ["index.exclude", "index.maxFiles", "index.maxSymbolResults", "index.workspaceConcurrency"].includes(name) ? windowConfiguration.get(name)
            : configuration.get(name))];
    }));
}

async function indexWorkspaceJobs(workers, jobs, workspaceIds, signal, current, onExpanded, limit, onProgress = () => {}, waitBeforeNextBatch = async () => {}) {
    if (!Array.isArray(workers) || !workers.length || !Array.isArray(workspaceIds) || workspaceIds.length !== workers.length) {
        throw new Error("Native workspace symbol workers were not initialized.");
    }

    const results = new Map();
    let indexed = 0, cached = 0, declarations = 0, retainedRecords = 0;
    let resultEntries = 0, resultBytes = 0, maximumBatchResultEntries = 0, maximumBatchResultBytes = 0;
    let maximumBatchMergeMs = 0, totalBatchMergeMs = 0, maximumWaitBeforeNextBatchMs = 0;
    let maximumWorkerMessageDelayMs = 0, maximumWorkerMessageHandlerMs = 0;
    let maximumBatchDispatchMs = 0, totalBatchDispatchMs = 0;
    let processRunnerExecutions = 0, totalSupervisorStartCallMs = 0, maximumSupervisorStartCallMs = 0;
    let totalRunnerSpawnCallMs = 0, maximumRunnerSpawnCallMs = 0;
    let processOutputBytes = 0, processOutputChunkCount = 0;
    let totalProcessOutputChunkHandlerMs = 0, totalExecutionReplyPostMs = 0;
    let maximumProcessOutputChunkHandlerMs = 0, maximumProcessOutputChunkBytes = 0;
    let maximumProcessOutputFinalizeMs = 0, maximumExecutionReplyPostMs = 0;
    let maximumCacheBytes = 0, maximumRecordBytes = 0;
    let workspaceMemorySamples = 0;
    const maximumWorkspaceMemory = { projection: {}, afterSearch: {} };

    /*
        Use bounded waves rather than launching the whole workspace at once.
        This keeps compiler process and native-model memory bounded, preserves
        the configured module order in returned results, and limits extra work
        to at most one module per workspace worker after a result limit is met.
    */
    for (let start = 0; start < jobs.length; start += workers.length) {
        current();
        const batch = jobs.slice(start, start + workers.length);
        const batchDispatchStarted = performance.now();
        const batchRequests = batch.map((job, offset) => workers[offset].indexWorkspace(
            { ...job, signal },
            { id: workspaceIds[offset] }
        ));
        const batchDispatchMs = performance.now() - batchDispatchStarted;
        maximumBatchDispatchMs = Math.max(maximumBatchDispatchMs, batchDispatchMs);
        totalBatchDispatchMs += batchDispatchMs;
        const batchResults = await Promise.all(batchRequests);
        current();
        const batchMergeStarted = performance.now();
        let batchResultEntries = 0, batchResultBytes = 0;
        indexed += batchResults.length;
        for (const result of batchResults) {
            if (result.cached) cached++;
            declarations += result.declarations || 0;
            const entries = result.packedEntries || result.entries;
            const packedEntries = ArrayBuffer.isView(result.packedEntries);
            batchResultEntries += packedEntries ? entries.length / WORKSPACE_SYMBOL_STRIDE : entries?.length || 0;
            batchResultBytes += result.resultBytes || 0;
            if (Number.isFinite(result.workerStats?.workerMessageDelayMs)) {
                maximumWorkerMessageDelayMs = Math.max(maximumWorkerMessageDelayMs, result.workerStats.workerMessageDelayMs);
            }
            if (Number.isFinite(result.workerStats?.messageHandlerMs)) {
                maximumWorkerMessageHandlerMs = Math.max(maximumWorkerMessageHandlerMs, result.workerStats.messageHandlerMs);
            }
            for (const phase of ["projection", "afterSearch"]) {
                const sample = result.workspaceMemory?.[phase];
                if (!sample) continue;
                workspaceMemorySamples++;
                for (const [name, value] of Object.entries(sample)) {
                    if (!Number.isFinite(value)) continue;
                    maximumWorkspaceMemory[phase][name] = Math.max(maximumWorkspaceMemory[phase][name] || 0, value);
                }
            }
            const processRunnerProfile = result.workerStats?.processRunnerProfile;
            if (processRunnerProfile) {
                processRunnerExecutions += processRunnerProfile.executions;
                totalSupervisorStartCallMs += processRunnerProfile.totalSupervisorStartCallMs;
                maximumSupervisorStartCallMs = Math.max(maximumSupervisorStartCallMs, processRunnerProfile.maximumSupervisorStartCallMs);
                totalRunnerSpawnCallMs += processRunnerProfile.totalRunnerSpawnCallMs;
                maximumRunnerSpawnCallMs = Math.max(maximumRunnerSpawnCallMs, processRunnerProfile.maximumRunnerSpawnCallMs);
                processOutputBytes += processRunnerProfile.outputBytes;
                processOutputChunkCount += processRunnerProfile.outputChunkCount;
                totalProcessOutputChunkHandlerMs += processRunnerProfile.totalOutputChunkHandlerMs;
                totalExecutionReplyPostMs += processRunnerProfile.totalExecutionReplyPostMs;
                maximumProcessOutputChunkHandlerMs = Math.max(maximumProcessOutputChunkHandlerMs, processRunnerProfile.maximumOutputChunkHandlerMs);
                maximumProcessOutputChunkBytes = Math.max(maximumProcessOutputChunkBytes, processRunnerProfile.maximumOutputChunkBytes);
                maximumProcessOutputFinalizeMs = Math.max(maximumProcessOutputFinalizeMs, processRunnerProfile.maximumOutputFinalizeMs);
                maximumExecutionReplyPostMs = Math.max(maximumExecutionReplyPostMs, processRunnerProfile.maximumExecutionReplyPostMs);
            }
            if (result.cache?.retained) retainedRecords++;
            maximumRecordBytes = Math.max(maximumRecordBytes, result.cache?.recordBytes || 0);
            if (result.expanded) onExpanded(result.expanded);
        }
        onProgress(indexed, cached, jobs.length);
        maximumCacheBytes = Math.max(maximumCacheBytes, batchResults.reduce((sum, result) => sum + (result.cache?.bytes || 0), 0));

        for (const [offset, result] of batchResults.entries()) {
            const job = batch[offset];
            const packedEntries = ArrayBuffer.isView(result.packedEntries);
            const entries = packedEntries ? result.packedEntries : result.entries;
            const entryCount = packedEntries ? entries.length / WORKSPACE_SYMBOL_STRIDE : entries.length;
            for (let index = 0; index < entryCount; index++) {
                const entryOffset = index * WORKSPACE_SYMBOL_STRIDE;
                const key = packedEntries
                    ? workspaceSymbolKeyFromPacked(entries, result.strings, entryOffset)
                    : workspaceSymbolKey(entries[index]);
                const deprecated = packedEntries ? entries[entryOffset + 12] === 1 : entries[index].deprecated === true;
                const prior = results.get(key);
                if (prior) {
                    prior.contexts.add(job.label);
                    /* A symbol is deprecated in workspace search only when
                       every indexed build context agrees. */
                    prior.deprecated = prior.deprecated === true && deprecated;
                }
                else if (results.size < limit) {
                    const symbol = packedEntries ? unpackWorkspaceSymbol(entries, result.strings, entryOffset) : entries[index];
                    results.set(key, { ...symbol, deprecated: symbol.deprecated === true, contexts: new Set([job.label]) });
                }
            }
            if (results.size >= limit) break;
        }
        const batchMergeMs = performance.now() - batchMergeStarted;
        resultEntries += batchResultEntries;
        resultBytes += batchResultBytes;
        maximumBatchResultEntries = Math.max(maximumBatchResultEntries, batchResultEntries);
        maximumBatchResultBytes = Math.max(maximumBatchResultBytes, batchResultBytes);
        maximumBatchMergeMs = Math.max(maximumBatchMergeMs, batchMergeMs);
        totalBatchMergeMs += batchMergeMs;
        if (results.size >= limit) break;
        if (start + batch.length < jobs.length) {
            const progressStarted = performance.now();
            await waitBeforeNextBatch();
            maximumWaitBeforeNextBatchMs = Math.max(maximumWaitBeforeNextBatchMs, performance.now() - progressStarted);
            await new Promise((resolve) => setImmediate(resolve));
            current();
        }
    }

    return {
        results,
        indexed,
        cached,
        declarations,
        retainedRecords,
        maximumCacheBytes,
        maximumRecordBytes,
        resultEntries,
        resultBytes,
        maximumBatchResultEntries,
        maximumBatchResultBytes,
        maximumBatchMergeMs,
        totalBatchMergeMs,
        maximumBatchDispatchMs,
        totalBatchDispatchMs,
        maximumWaitBeforeNextBatchMs,
        maximumWorkerMessageDelayMs,
        maximumWorkerMessageHandlerMs,
        processRunnerExecutions,
        totalSupervisorStartCallMs,
        maximumSupervisorStartCallMs,
        totalRunnerSpawnCallMs,
        maximumRunnerSpawnCallMs,
        processOutputBytes,
        processOutputChunkCount,
        totalProcessOutputChunkHandlerMs,
        maximumProcessOutputChunkHandlerMs,
        maximumProcessOutputChunkBytes,
        maximumProcessOutputFinalizeMs,
        totalExecutionReplyPostMs,
        maximumExecutionReplyPostMs,
        workspaceMemorySamples,
        maximumWorkspaceMemory
    };
}

async function compilerWorkspaceSymbols(service, query, token) {
    const workspace = service.vscode.workspace;
    const roots = new Set(folders(service).filter((folder) => service.isConfigured(folder.uri)).map((folder) => folder.uri.fsPath));
    if (!roots.size || !workspace.isTrusted || !service.analysisWorker) return { roots, symbols: [] };
    for (const folder of folders(service)) {
        if (!roots.has(folder.uri.fsPath)) continue;
        const compatibility = await service.ensureCompilerCompatibility?.(folder.uri);
        if (compatibility?.state === "unsupported") roots.delete(folder.uri.fsPath);
    }
    if (!roots.size) return { roots, symbols: [] };
    const workers = service.getWorkspaceWorkers?.() || [service.analysisWorker];
    if (!workers.length) return { roots, symbols: [] };
    const controller = new AbortController();
    const subscription = token?.onCancellationRequested?.(() => controller.abort());
    const generation = service.generation, signature = settingsSignature(service);
    const windowConfiguration = workspace.getConfiguration("freebasic", null);
    const limitValue = windowConfiguration.get("index.maxSymbolResults", 1000);
    const limit = Number.isSafeInteger(limitValue) ? Math.max(1, Math.min(20000, limitValue)) : 1000;
    const current = () => {
        if (controller.signal.aborted || token?.isCancellationRequested || generation !== service.generation || !workspace.isTrusted) throw new Error("Native workspace symbol search was cancelled or invalidated.");
        if (settingsSignature(service) !== signature) throw new Error("Workspace symbol contexts changed during indexing.");
    };
    const workspaceIds = [];
    try {
        current();
        if (typeof service.index?.ensureInitialized === "function") {
            await service.index.ensureInitialized(token);
            current();
        }
        const jobs = [];
        for (const folder of folders(service)) {
            if (!roots.has(folder.uri.fsPath)) continue;
            const configuration = workspace.getConfiguration("freebasic", folder.uri);
            const contexts = configuration.get("analysis.projectContexts", []);
            let configured;
            if (Array.isArray(contexts) && contexts.length) configured = projectContexts(configuration, folder.uri.fsPath);
            else {
                if (!Array.isArray(contexts)) throw new Error("analysis.projectContexts must be an array.");
                const value = windowConfiguration.get("index.maxFiles", 5000);
                const maximum = Number.isSafeInteger(value) ? Math.max(1, Math.min(5000, value)) : 5000;
                const exclude = windowConfiguration.get("index.exclude", "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}");
                const uris = await workspace.findFiles(new service.vscode.RelativePattern(folder, "**/*.{bas,BAS}"), exclude, maximum + 1, token);
                current();
                if (uris.length > maximum) throw new Error("Native workspace module discovery exceeded index.maxFiles.");
                configured = uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath)).map((uri) => analysisContext(configuration, folder.uri.fsPath, uri.fsPath));
            }
            const selected = configuration.get("analysis.activeContext", null);
            if (selected !== null) {
                if (!selected || typeof selected.module !== "string") {
                    throw new Error("analysis.activeContext must contain a context name and a .bas module path.");
                }
                const selectedFile = path.resolve(folder.uri.fsPath, selected.module.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath));
                const active = analysisContext(configuration, folder.uri.fsPath, selectedFile);
                // Search every module in this build, not only the selected
                // header's translation unit. With no selection, retain the
                // labelled all-build search used for project discovery.
                configured = configured.filter((job) => job.name === active.name);
            }
            for (const job of configured) {
                jobs.push({
                    ...job,
                    compilerPath: service.compilerPathFor?.(folder.uri) || configuration.get("analysis.compilerPath", ""),
                    timeoutMs: configuration.get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS),
                    dependencyHints: service.index?.includeDependencyHints?.(job.filePath) || [],
                    label: `${folder.name || path.basename(folder.uri.fsPath)}: ${job.name || "default"}`
                });
                if (jobs.length > 5000) throw new Error("Native workspace symbols exceeded 5000 module/configuration pairs.");
            }
        }
        current();
        if (!jobs.length) {
            service.output.appendLine("Native workspace symbols require .bas modules or explicit analysis.projectContexts for headers.");
            return { roots, symbols: [] };
        }
        const buffers = service.captureBuffers();
        for (const workspaceWorker of workers) {
            const pass = await workspaceWorker.beginWorkspace(buffers, query, limit, controller.signal);
            workspaceIds.push(pass.workspaceId);
        }
        current();
        const indexedResult = await indexWorkspaceJobs(
            workers,
            jobs,
            workspaceIds,
            controller.signal,
            current,
            (expanded) => {
                service.expanded.set(expanded.uri, expanded.text);
            },
            limit,
            () => {},
            () => service.analysisWorker.waitForIdle(controller.signal)
        );
        const finalBuffers = service.captureBuffers();
        await Promise.all(workers.map((workspaceWorker, index) => workspaceWorker.finishWorkspace(workspaceIds[index], finalBuffers, controller.signal)));
        current();
        const now = service.captureBuffers();
        if (now.size !== finalBuffers.size || [...now].some(([file, text]) => finalBuffers.get(file) !== text)) throw new Error("Editor buffers changed while workspace symbols were returning.");
        const symbols = [...indexedResult.results.values()].map((entry) => ({ ...entry, uri: entry.uri.scheme === "file" ? service.vscode.Uri.file(entry.uri.fsPath) : service.vscode.Uri.parse(entry.uri.value), containerName: [entry.containerName, `[${[...entry.contexts].join(", ")}]`].filter(Boolean).join(" ") }));
        service.output.appendLine(`Native workspace symbols: ${indexedResult.indexed}/${jobs.length} contexts, ${indexedResult.cached} cached, ${symbols.length} results${indexedResult.indexed < jobs.length ? " (result limit reached)" : ""}.`);
        return { roots, symbols };
    } catch (error) {
        if (!token?.isCancellationRequested && !controller.signal.aborted && generation === service.generation) service.output.appendLine(`Native workspace symbols: ${error.message}`);
        return { roots, symbols: [] };
    } finally {
        workspaceIds.forEach((id, index) => workers[index].discardWorkspace(id));
        subscription?.dispose();
        controller.abort();
    }
}

module.exports = { compilerWorkspaceSymbols, indexWorkspaceJobs, WORKSPACE_INDEX_WORKER_COUNT };

/* end of lib/compiler-workspace-service.js */
