/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-analysis-service.js
    Purpose: Manage on-demand compiler snapshots of disk and editor buffers.
    Responsibilities: enforce trust, reject stale snapshots, provide expanded text.
    Does not contain: compiler building, inferred preprocessing, or editing files.
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS, MAX_ANALYSIS_BYTES, compilerMissingIncludeState, decodeCompilerSourceBuffer } = require("./compiler-analysis");
const { COMPILER_WORKER_BUSY, CompilerAnalysisWorker } = require("./compiler-worker");
const { CompilerProcessSupervisor } = require("./compiler-process-supervisor");
const { executeBoundedProcess } = require("./compiler-diagnostics");
const { CompilerCompatibilityService } = require("./compiler-compatibility");
const { performance } = require("perf_hooks");
const { CompilerSemanticModel } = require("./compiler-semantic-model");
const { analysisContext, projectContexts } = require("./compiler-contexts");
const { CompilerRemoteModel } = require("./compiler-remote-model");
const { compilerExecutableIdentity } = require("./compiler-model-store");
const { resolveCompilerPath } = require("./compiler-path");
const { compilerWorkspaceSymbols, WORKSPACE_INDEX_WORKER_COUNT } = require("./compiler-workspace-service");
const { BoundedTextMap } = require("./bounded-text-map");
const {
    compilerByRefFunctionResultAssignmentRange,
    compilerConstantConversionOverflowRange,
    compilerConstantConversionOverflowPointRange,
    compilerDiagnosticContextLabel,
    compilerDiagnosticGuidance,
    compilerDeclarationSuffixConflictRange,
    compilerForCounterWrapRange,
    compilerErrorResumeNextRange,
    compilerForNextCounterMismatchRange,
    compilerLineInputBufferCapacityRange,
    compilerMissingClosingQuoteRange,
    compilerPossibleEscapeStringRange,
    compilerRedundantNewAnyInitializerRange,
    compilerImplicitVariableAllocationRange,
    compilerMeaninglessNextVariableRange,
    compilerIgnoredDeclarationSuffixRange,
    compilerImplicitParameterPassingModeRange,
    compilerParameterDefaultMismatchRange,
    compilerProcedureSignatureMismatchRange,
    compilerSuspiciousPointerAssignmentRange,
    compilerFunctionPointerMismatchRange,
    compilerOperatorWarningTokenRange,
    compilerConstQualifierWarningRange,
    compilerLargeStackWarningRange,
    compilerImplicitConversionRange,
    physicalDiagnosticRange,
    physicalPointMatchesDiagnosticText
} = require("./compiler-diagnostic-sidecar");

/* Status menus need a reason, not an unbounded compiler transcript. */
const MAX_EDITOR_FAILURE_MESSAGE_LENGTH = 512;

function sameBuffers(first, second) {
    return first?.size === second.size && [...first].every(([file, text]) => second.get(file) === text);
}

class CompilerAnalysisService {
    constructor(vscode, index, output, analyze = null, executeCompatibilityProbe = null) {
        this.vscode = vscode;
        this.index = index;
        this.output = output;
        this.processSupervisor = analyze ? null : new CompilerProcessSupervisor(undefined,
            (message) => output.appendLine(`Compiler process supervisor: ${message}`));
        this.analysisWorker = analyze ? null : new CompilerAnalysisWorker(undefined, (message) => output.appendLine(message), () => vscode.workspace.isTrusted, (id) => this.expireModel(id), this.processSupervisor);
        this.workspaceWorkers = null;
        this.workspaceWorkerDisposals = [];
        this.disposing = null;
        this.disposed = false;
        this.backgroundModels = !analyze;
        this.analyze = analyze || ((options) => this.analysisWorker.analyze(options));
        this.snapshots = new Map();
        this.onDemandFailures = new WeakMap();
        this.expanded = new BoundedTextMap(8, MAX_ANALYSIS_BYTES);
        this.running = new Map();
        this.runningBuffers = new Map();
        this.runningContexts = new Map();
        this.runningPromises = new Map();
        this.generation = 0;
        this.snapshotSequence = 0;
        this.pendingTimer = null;
        this.pendingModules = new Set();
        this.diagnosticCollection = vscode.languages?.createDiagnosticCollection("freebasic-analysis");
        this.snapshotChangeEmitter = vscode.EventEmitter ? new vscode.EventEmitter() : null;
        this.onDidChangeSnapshot = this.snapshotChangeEmitter?.event;
        this.analysisChangeEmitter = vscode.EventEmitter ? new vscode.EventEmitter() : null;
        this.onDidChangeAnalysis = this.analysisChangeEmitter?.event;
        this.compilerCompatibility = new CompilerCompatibilityService(
            executeCompatibilityProbe || ((options) => executeBoundedProcess({
                ...options,
                processSupervisor: this.processSupervisor
            })),
            () => { if (!this.disposed) this.analysisChangeEmitter?.fire(); }
        );
    }

    notifySnapshotChange(sources) {
        const entries = sources && typeof sources[Symbol.iterator] === "function" ? [...sources] : [];
        const uris = [...new Set(entries.map((source) =>
            typeof source === "string" ? source : source?.uri?.toString?.()
        ).filter(Boolean))];
        if (uris.length) this.snapshotChangeEmitter?.fire(uris);
    }

    async checkCurrent(document, showResult = true, token = null) {
        let context;
        try { context = this.contextFor(document.uri); }
        catch { return this.check(document, showResult, token); }
        const signature = context.signature;
        const version = document.version;
        const generation = this.generation;
        const pending = this.check(document, showResult, token);
        const state = this.runningContexts.get(this.vscode.Uri.file(context.filePath).toString());
        const result = await pending;
        const changedSource = /^Compiler (?:snapshot source changed|source changed while being captured)(?:[.:]|$)/
            .test(state?.errorMessage || "");
        if (result || generation === this.generation && !changedSource || this.disposed || token?.isCancellationRequested ||
            !this.vscode.workspace.isTrusted || document.version !== version) return result;
        try {
            if (this.contextFor(document.uri).signature !== signature) return false;
        } catch { return false; }
        /* A watcher or a changed closed dependency can retire a manual pass.
           Retry once for the same document/build; each pass still freezes
           and validates its own inputs. Never retry ordinary compiler errors
           or follow edits and context selection. */
        this.output.appendLine("Compiler analysis: retrying after snapshot invalidation.");
        return this.check(document, showResult, token);
    }

    async check(document, showResult = true, token = null, needSemanticBindings = false, needSemanticMacroBindings = false,
        resultState = null) {
        const checkGeneration = this.generation;
        const namedSource = this.isCompilerSource(document?.uri, document?.languageId);
        let indexInitialization = null;
        if (!this.backgroundModels && this.vscode.workspace.isTrusted && namedSource) {
            try { indexInitialization = Promise.resolve(this.index.ensureInitialized()); }
            catch (error) { indexInitialization = Promise.reject(error); }
            /* The compatibility probe may finish later; observe an early index
               failure now and rethrow it when the normal preparation awaits it. */
            indexInitialization.catch(() => {});
        }
        if (this.vscode.workspace.isTrusted && !token?.isCancellationRequested && namedSource) {
            let compatibility = this.compilerCompatibilityFor(document.uri);
            // A completed probe must not defer joining or capturing an existing
            // compiler pass. Only the first check of an executable needs I/O.
            if (compatibility.state === "checking") compatibility = await this.ensureCompilerCompatibility(document.uri);
            if (checkGeneration !== this.generation) return false;
            if (compatibility.state === "unsupported") {
                if (showResult && !token?.isCancellationRequested) this.vscode.window.showInformationMessage(compatibility.message);
                return false;
            }
        }
        if (this.backgroundModels) return this.checkBackground(document, showResult, token,
            needSemanticBindings, needSemanticMacroBindings, true, resultState);
        let activeKey;
        let activeController;
        const cancellation = token?.onCancellationRequested?.(() => activeController?.abort());
        try {
            const workspace = this.vscode.workspace;
            if (!workspace.isTrusted) throw new Error("Compiler analysis is disabled in untrusted workspaces.");
            if (!this.isCompilerSource(document?.uri, document?.languageId)) throw new Error("Open a named FreeBASIC module or header first.");
            const configuration = workspace.getConfiguration("freebasic", document.uri);
            const compilerSelection = this.analysisCompilerFor(document.uri);
            const compilerPath = compilerSelection.compilerPath;
            if (!compilerPath) throw new Error("Configure freebasic.compiler.path or freebasic.analysis.compilerPath before requesting compiler analysis.");
            if (compilerSelection.semanticModelOnly && document.isDirty) throw new Error("The configured fbc semantic sidecar cannot analyze an unsaved root buffer; save it or configure the editor bridge for unsaved-buffer analysis.");
            const context = this.contextFor(document.uri, compilerSelection);
            const generation = this.generation;
            await (indexInitialization || this.index.ensureInitialized());
            if (token?.isCancellationRequested || generation !== this.generation) return false;
            if (!workspace.isTrusted) throw new Error("Workspace trust changed while preparing compiler analysis.");
            const overlays = this.captureBuffers();
            const initialFiles = new Map();
            for (const entry of this.index.documents.values()) {
                if (entry.uri.scheme === "file") {
                    try { initialFiles.set(entry.uri.fsPath, fs.statSync(entry.uri.fsPath)); } catch { /* Report only if the compiler consumes this file. */ }
                }
            }
            if (!overlays.has(context.filePath)) initialFiles.set(context.filePath, fs.statSync(context.filePath));
            const key = this.vscode.Uri.file(context.filePath).toString();
            this.running.get(key)?.abort();
            const previousSnapshot = this.snapshots.get(key);
            this.snapshots.delete(key);
            if (previousSnapshot) this.notifySnapshotChange(previousSnapshot.sources);
            this.publishDiagnostics();
            const controller = new AbortController();
            activeKey = key;
            activeController = controller;
            this.running.set(key, controller);
            this.runningBuffers.set(key, new Map(overlays));
            this.runningContexts.set(key, { signature: context.signature, requestUri: document.uri });
            this.analysisChangeEmitter?.fire();
            this.output.appendLine(`Compiler analysis: ${context.name || "default options"}: ${context.filePath}`);
            const options = { compilerPath, filePath: context.filePath, compilerArguments: context.compilerArguments, overlays,
                semanticSourceFiles: [...new Set([context.filePath, ...overlays.keys()])],
                allowErrors: true, exportSemanticExpressions: true,
                exportSemanticBindings: needSemanticBindings || needSemanticMacroBindings,
                semanticModelOnly: compilerSelection.semanticModelOnly,
                compactSemanticMacros: !(compilerSelection.semanticModelOnly && needSemanticMacroBindings),
                signal: controller.signal, timeoutMs: configuration.get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS) };
            const current = () => {
                if (!workspace.isTrusted) {
                    this.invalidate();
                    throw new Error("Workspace trust changed during compiler analysis.");
                }
                return generation === this.generation && this.running.get(key) === controller && !controller.signal.aborted;
            };
            let analysis = await this.analyze(options);
            if (!current()) return false;
            if (analysis.dependencies.some((file) => !initialFiles.has(file) && !overlays.has(file))) {
                /* Discover compiler-only includes first, then verify a second pass
                   against pre-existing stamps. Never accept an after-only snapshot. */
                for (const file of analysis.dependencies) if (!initialFiles.has(file) && !overlays.has(file)) initialFiles.set(file, fs.statSync(file));
                analysis = await this.analyze(options);
            }
            if (!current()) return false;
            if (context.signature !== this.contextFor(document.uri).signature) throw new Error("The compiler context changed during analysis. Run analysis again.");
            if (!/\.bas$/i.test(document.uri.fsPath) && !analysis.dependencies.includes(document.uri.fsPath)) throw new Error("The selected translation unit did not include this header. Select a module and build context that consumes it.");
            const logicalFiles = analysis.protocolVersion >= 9 ? [] : analysis.origins.filter(Boolean).map((origin) => origin.filePath);
            const files = new Set([context.filePath, ...analysis.dependencies, ...logicalFiles]);
            if (files.size > 5000) throw new Error("Compiler analysis exceeded its 5000-source limit.");
            const sources = [];
            let bytes = Buffer.byteLength(analysis.text);
            for (const file of files) {
                const overlay = overlays.has(file);
                let stat;
                try { stat = fs.statSync(file); } catch (error) { if (!overlay) throw error; }
                const before = initialFiles.get(file);
                if (!overlay && (!before || before.mtimeMs !== stat.mtimeMs || before.size !== stat.size)) throw new Error(`Source was not indexed or changed during analysis: ${file}. Rebuild the index and try again.`);
                const text = (overlay ? overlays.get(file) : decodeCompilerSourceBuffer(fs.readFileSync(file), file)).replace(/^\uFEFF/, "");
                bytes += Buffer.byteLength(text);
                if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler analysis source snapshots exceeded 32 MiB.");
                sources.push({ uri: this.vscode.Uri.file(file), text, overlay, mtimeMs: stat?.mtimeMs, size: stat?.size });
            }
            if (!this.buffersMatch(overlays)) throw new Error("An editor buffer changed during compiler analysis. Run analysis again.");
            const uri = this.vscode.Uri.from({ scheme: "freebasic-preprocessed", path: `/${encodeURIComponent(key)}.bas`, query: String(++this.snapshotSequence) });
            const modelStart = performance.now();
            const model = new CompilerSemanticModel(uri, analysis, sources);
            model.semanticBindingsAvailable = analysis.semanticBindingsAvailable ?? needSemanticBindings;
            model.semanticMacroBindingsAvailable = analysis.semanticMacroBindingsAvailable ?? needSemanticMacroBindings;
            if (analysis.workerStats) {
                const stats = analysis.workerStats;
                this.output.appendLine(`Compiler worker ${stats.threadId}: ${Math.round(stats.roundTripMs)} ms round trip, ${Math.round(stats.decodeMs)} ms decode (${stats.cacheHit ? "cached trace" : "new trace"}), ${Math.round(performance.now() - modelStart)} ms editor model.`);
            }
            const missingIncludes = compilerMissingIncludeState(analysis, overlays);
            bytes += missingIncludes?.bytes || 0;
            if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler analysis source snapshots exceeded 32 MiB.");
            this.snapshots.set(key, { model, sources, uri, bytes, context, missingIncludes, requestUri: document.uri, diagnostics: analysis.diagnostics || [] });
            this.onDemandFailures.delete(document);
            const changedSources = new Set(sources.map((source) => source.uri.toString()));
            while (this.snapshots.size > 8 || [...this.snapshots.values()].reduce((sum, snapshot) => sum + snapshot.bytes, 0) > MAX_ANALYSIS_BYTES) {
                const oldestKey = this.snapshots.keys().next().value;
                const oldest = this.snapshots.get(oldestKey);
                oldest?.sources.forEach((source) => changedSources.add(source.uri.toString()));
                this.snapshots.delete(oldestKey);
            }
            this.expanded.set(uri.toString(), analysis.text);
            this.running.delete(key);
            this.runningBuffers.delete(key);
            this.runningContexts.delete(key);
            this.analysisChangeEmitter?.fire();
            this.notifySnapshotChange(changedSources);
            this.publishDiagnostics();
            this.index.notifyChange();
            if (showResult) this.vscode.window.showInformationMessage(analysis.partial
                ? `FreeBASIC retained partial compiler analysis with ${analysis.completion.errorCount} error(s). Failed regions are excluded; recovery-dependent types are provisional.`
                    : analysis.semanticSidecarOnly
                        ? analysis.semanticExpressions.length
                            ? analysis.semanticModelFallbackReason === "compiler-sidecar-only"
                                ? "FreeBASIC expression types were updated from the compiler sidecar. This compiler does not provide editor-origin tracing; native symbols, macros, and project refactoring require the editor bridge."
                                : "FreeBASIC expression types were updated from the compiler sidecar. The expanded module exceeded the trace-analysis limit, so native symbol and call details are unavailable for this snapshot."
                        : analysis.semanticModelFallbackReason === "compiler-sidecar-only"
                            ? "FreeBASIC's semantic sidecar supplied no physical expression types. Native symbols, macros, and project refactoring require the editor bridge."
                            : "FreeBASIC's expanded module exceeded the trace-analysis limit and the compiler sidecar supplied no physical expression types. Native symbol and call details are unavailable for this snapshot."
                    : analysis.semanticModelFallbackReason === "semantic-sidecar-size-limit"
                        ? "FreeBASIC compiler analysis updated from the native trace. The semantic sidecar exceeded its size limit, so additional sidecar expression facts are unavailable."
                        : "FreeBASIC compiler analysis updated from current editor buffers, including expression types and resolved calls.");
            return true;
        } catch (error) {
            if (resultState) resultState.errorMessage = error.message;
            this.output.appendLine(`Compiler analysis: ${error.message}`);
            if (showResult && !token?.isCancellationRequested) this.vscode.window.showWarningMessage(error.message);
            return false;
        } finally {
            cancellation?.dispose();
            if (activeController && this.running.get(activeKey) === activeController) {
                this.running.delete(activeKey);
                this.runningBuffers.delete(activeKey);
                this.runningContexts.delete(activeKey);
                this.analysisChangeEmitter?.fire();
            }
        }
    }

    /* A compilation belongs to its immutable inputs, not to the first editor
       provider that requested it. Each waiter owns a cancellation subscription;
       the native process stops only after the last interested waiter leaves.
       Binding upgrades transfer waiters only when those inputs still match. */
    async waitForBackground(controller, context, completion, token) {
        if (token?.isCancellationRequested) {
            if (context.consumers.size === 0) controller.abort();
            return false;
        }
        if (!completion) return false;
        if (controller.signal.aborted) {
            const next = context.replacement;
            return next ? this.waitForBackground(next.controller, next.context, next.completion, token) : false;
        }
        return new Promise((resolve) => {
            const consumer = {};
            context.consumers.add(consumer);
            let settled = false, subscription = null;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                context.consumers.delete(consumer);
                subscription?.dispose();
                controller.signal.removeEventListener("abort", aborted);
                resolve(result);
            };
            const aborted = () => {
                const next = context.replacement;
                finish(next ? this.waitForBackground(next.controller, next.context, next.completion, token) : false);
            };
            const cancel = () => {
                finish(false);
                if (context.consumers.size === 0) controller.abort();
            };
            /* Transfer interest at upgrade time, not after native cleanup.
               Otherwise a short-lived provider could cancel the stronger
               pass while the old compiler is still being reaped. */
            controller.signal.addEventListener("abort", aborted, { once: true });
            subscription = token?.onCancellationRequested?.(cancel) || null;
            if (settled) subscription?.dispose();
            if (token?.isCancellationRequested) cancel();
            completion.then((result) => {
                if (settled) return;
                const next = context.replacement;
                finish(!result && next
                    ? this.waitForBackground(next.controller, next.context, next.completion, token)
                    : result);
            }, () => finish(false));
        });
    }

    async checkBackground(document, showResult, token, needSemanticBindings = false, needSemanticMacroBindings = false,
        waitForClosedBuffers = true, resultState = null) {
        const controller = new AbortController();
        const version = document?.version;
        let key, completion, finish;
        try {
            const workspace = this.vscode.workspace;
            if (!workspace.isTrusted) throw new Error("Compiler analysis is disabled in untrusted workspaces.");
            if (!this.isCompilerSource(document?.uri, document?.languageId)) throw new Error("Open a named FreeBASIC module or header first.");
            if (token?.isCancellationRequested) return false;
            const configuration = workspace.getConfiguration("freebasic", document.uri);
            const compilerSelection = this.analysisCompilerFor(document.uri);
            const compilerPath = compilerSelection.compilerPath;
            if (!compilerPath) throw new Error("Configure freebasic.compiler.path or freebasic.analysis.compilerPath before requesting compiler analysis.");
            if (compilerSelection.semanticModelOnly && document.isDirty) throw new Error("The configured fbc semantic sidecar cannot analyze an unsaved root buffer; save it or configure the editor bridge for unsaved-buffer analysis.");
            const context = this.contextFor(document.uri, compilerSelection);
            key = this.vscode.Uri.file(context.filePath).toString();
            const resultForDocument = (completed, state) => {
                if (token?.isCancellationRequested || this.disposed || !workspace.isTrusted) return false;
                if (!completed) {
                    /* Notifications belong to callers, not the first provider.
                       Upgrades must report their final failure, not an old
                       preparation's cancellation while handing off waiters. */
                    while (state.replacement) state = state.replacement.context;
                    if (resultState) resultState.errorMessage = state.errorMessage;
                    if (showResult && state.errorMessage) this.vscode.window.showWarningMessage(state.errorMessage);
                    return false;
                }
                if (context.signature !== this.contextFor(document.uri).signature) throw new Error("The compiler context changed during analysis. Run analysis again.");
                const snapshot = this.snapshots.get(key);
                if (snapshot?.context.signature !== context.signature || !this.modelForSnapshot(snapshot)) return false;
                /* One root pass can serve several callers, but each header
                   still needs compiler-confirmed membership in that pass. */
                if (!snapshot.sources.some((source) => source.uri.toString() === document.uri.toString())) {
                    if (!state.excludedSources) state.excludedSources = new Set();
                    state.excludedSources.add(document.uri.toString());
                    throw new Error("The selected translation unit did not include this header. Select a module/build context that consumes it.");
                }
                if (showResult) this.vscode.window.showInformationMessage(snapshot.infoMessage);
                return true;
            };
            const previousSnapshot = this.snapshots.get(key);
            /* Keep usable facts while adding capabilities for the same inputs.
               Normal model queries still enforce source freshness in the worker;
               edits, context changes, and cache eviction can expire this model.
               An explicit same-capability recheck still withdraws old results. */
            const retainPrevious = previousSnapshot && (
                ((needSemanticBindings || needSemanticMacroBindings) && !previousSnapshot.model.semanticBindingsAvailable) ||
                (needSemanticMacroBindings && !previousSnapshot.model.semanticMacroBindingsAvailable)
            ) && this.getModel(document.uri) === previousSnapshot.model;
            const generation = this.generation;
            const overlays = this.captureBuffers();
            const runningContext = this.runningContexts.get(key);
            const running = this.running.get(key);
            const runningBuffers = this.runningBuffers.get(key);
            if (waitForClosedBuffers && running && !running.signal.aborted && runningContext?.signature === context.signature &&
                runningBuffers && overlays.size < runningBuffers.size &&
                [...overlays].every(([file, text]) => runningBuffers.get(file) === text)) {
                // Only closed buffers differ. Let the worker validate the
                // existing pass's actual dependencies before scheduling an
                // upgrade; do not cancel its manual callers speculatively.
                const completed = await this.waitForBackground(running, runningContext, this.runningPromises.get(key), token);
                if (token?.isCancellationRequested || document.isClosed || document.version !== version || this.disposed ||
                    !workspace.isTrusted || !sameBuffers(overlays, this.captureBuffers()) ||
                    context.signature !== this.contextFor(document.uri).signature) return false;
                const model = this.getModel(document.uri);
                if (completed && model && (model.semanticBindingsAvailable || !needSemanticBindings) &&
                    (model.semanticMacroBindingsAvailable || !needSemanticMacroBindings)) return resultForDocument(true, runningContext);
                return this.checkBackground(document, showResult, token, needSemanticBindings, needSemanticMacroBindings, false, resultState);
            }
            if (running && !running.signal.aborted && runningContext?.signature === context.signature &&
                (runningContext.semanticBindings || !needSemanticBindings) &&
                (runningContext.semanticMacroBindings || !needSemanticMacroBindings) &&
                sameBuffers(this.runningBuffers.get(key), overlays)) {
                return resultForDocument(await this.waitForBackground(running, runningContext, this.runningPromises.get(key), token), runningContext);
            }
            completion = new Promise((resolve) => { finish = resolve; });
            const requestContext = {
                signature: context.signature,
                requestUri: document.uri,
                semanticBindings: needSemanticBindings || needSemanticMacroBindings,
                semanticMacroBindings: needSemanticMacroBindings,
                modelPrepared: false,
                queueBusy: false,
                errorMessage: null,
                consumers: new Set()
            };
            if (running && runningContext?.signature === context.signature &&
                sameBuffers(this.runningBuffers.get(key), overlays)) {
                runningContext.replacement = { controller, context: requestContext, completion };
            }
            running?.abort();
            this.running.set(key, controller);
            this.runningBuffers.set(key, new Map(overlays));
            this.runningContexts.set(key, requestContext);
            this.runningPromises.set(key, completion);
            this.analysisChangeEmitter?.fire();
            if (!retainPrevious) {
                this.snapshots.delete(key);
                if (previousSnapshot) {
                    this.expanded.delete(previousSnapshot.uri.toString());
                    if (previousSnapshot.model.remote) this.analysisWorker.releaseModel(previousSnapshot.model.snapshotId);
                    this.notifySnapshotChange(previousSnapshot.sources);
                }
                this.publishDiagnostics();
            }
            const uri = this.vscode.Uri.from({ scheme: "freebasic-preprocessed", path: `/${encodeURIComponent(key)}.bas`, query: String(++this.snapshotSequence) });
            this.output.appendLine(`Compiler model: ${context.name || "default options"}: ${context.filePath}`);
            const discarded = (stage) => {
                const reasons = [];
                if (generation !== this.generation) reasons.push("generation changed");
                if (this.running.get(key) !== controller) reasons.push("request superseded");
                if (controller.signal.aborted) reasons.push("request cancelled");
                if (context.signature !== this.contextFor(document.uri).signature) reasons.push("compiler context changed");
                const reason = reasons.length ? reasons.join(", ") : "prepared model is no longer current";
                const message = `Compiler model discarded during ${stage}: ${reason}.`;
                this.output.appendLine(message);
                return false;
            };
            const prepare = async () => {
                let outcome = false, reply;
                try {
                    reply = await this.analysisWorker.analyze({ compilerPath, filePath: context.filePath, compilerArguments: context.compilerArguments, overlays,
                        semanticSourceFiles: [...new Set([context.filePath, ...overlays.keys()])],
                        allowErrors: true, exportSemanticExpressions: true,
                        exportSemanticBindings: needSemanticBindings || needSemanticMacroBindings,
                        semanticModelOnly: compilerSelection.semanticModelOnly,
                        compactSemanticMacros: !(compilerSelection.semanticModelOnly && needSemanticMacroBindings),
                        signal: controller.signal, timeoutMs: configuration.get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS) },
                    { requestedFile: context.filePath, expandedUri: { scheme: uri.scheme, value: uri.toString(), path: uri.path } });
                    requestContext.modelPrepared = true;
                    if (!workspace.isTrusted) { this.invalidate(); throw new Error("Workspace trust changed during compiler analysis."); }
                    if (generation !== this.generation || this.running.get(key) !== controller || controller.signal.aborted || context.signature !== this.contextFor(document.uri).signature) return discarded("preparation");
                    const openFiles = workspace.textDocuments.filter((entry) => entry.uri.scheme === "file").map((entry) => entry.uri.fsPath);
                    await this.analysisWorker.query(reply.snapshotId, "validate", { uri: { scheme: "file", fsPath: context.filePath }, openFiles }, controller.signal);
                    if (!workspace.isTrusted) { this.invalidate(); throw new Error("Workspace trust changed during compiler analysis."); }
                    if (generation !== this.generation || this.running.get(key) !== controller || controller.signal.aborted || context.signature !== this.contextFor(document.uri).signature) return discarded("validation");
                    const sources = reply.sources.map((source) => ({ ...source, uri: this.vscode.Uri.file(source.filePath) }));
                    const model = new CompilerRemoteModel(this, reply.snapshotId, reply.partial, reply.semanticSidecarOnly,
                        reply.semanticBindingsAvailable ?? (needSemanticBindings || needSemanticMacroBindings),
                        reply.semanticMacroBindingsAvailable ?? needSemanticMacroBindings);
                    const bytes = Buffer.byteLength(reply.text) + sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0) + (reply.missingIncludes?.bytes || 0);
                    const changedSources = new Set(sources.map((source) => source.uri.toString()));
                    if (retainPrevious) {
                        previousSnapshot.sources.forEach((source) => changedSources.add(source.uri.toString()));
                        this.expanded.delete(previousSnapshot.uri.toString());
                        if (previousSnapshot.model.remote) this.analysisWorker.releaseModel(previousSnapshot.model.snapshotId);
                    }
                    const infoMessage = reply.partial
                        ? `FreeBASIC retained partial compiler analysis with ${reply.completion.errorCount} error(s). Failed regions are excluded; recovery-dependent types are provisional.`
                        : reply.semanticSidecarOnly
                            ? reply.semanticExpressionCount
                                ? "FreeBASIC expression types were updated from the compiler sidecar. This compiler does not provide editor-origin tracing; native symbols, macros, and project refactoring require the editor bridge."
                                : "FreeBASIC's semantic sidecar supplied no physical expression types. Native symbols, macros, and project refactoring require the editor bridge."
                            : "FreeBASIC compiler analysis updated from current editor buffers, including expression types and resolved calls.";
                    const snapshot = { model, sources, uri, bytes, context, infoMessage, missingIncludes: reply.missingIncludes, requestUri: document.uri, diagnostics: reply.diagnostics };
                    this.snapshots.set(key, snapshot);
                    this.onDemandFailures.delete(document);
                    // Open source buffers are checked before and after every query;
                    // disk freshness checks stay beside the model in the worker.
                    if (this.modelForSnapshot(snapshot) !== model) return discarded("publication");
                    this.expanded.set(uri.toString(), reply.text);
                    for (const [snapshotKey, snapshot] of this.snapshots) if (!snapshot.model.available()) {
                        snapshot.sources.forEach((source) => changedSources.add(source.uri.toString()));
                        this.snapshots.delete(snapshotKey);
                    }
                    this.notifySnapshotChange(changedSources);
                    this.publishDiagnostics();
                    this.index.notifyChange();
                    const stats = reply.workerStats;
                    this.output.appendLine(`Compiler worker ${stats.threadId}: ${Math.round(stats.roundTripMs)} ms round trip, ${Math.round(stats.decodeMs)} ms decode, ${Math.round(reply.modelMs)} ms background model (${reply.declarationCount} declarations, ${reply.analysisPasses} compiler pass(es), dependency hints ${reply.dependencyCacheHit ? "reused" : "not reused"}).`);
                    outcome = true;
                    return true;
                } catch (error) {
                    requestContext.queueBusy = error.code === COMPILER_WORKER_BUSY;
                    if (!controller.signal.aborted) requestContext.errorMessage = error.message;
                    this.output.appendLine(`Compiler analysis: ${error.message}`);
                    return false;
                } finally {
                    if (reply?.snapshotId && !outcome) this.analysisWorker.releaseModel(reply.snapshotId);
                    finish?.(outcome);
                    if (this.running.get(key) === controller) {
                        this.running.delete(key);
                        this.runningBuffers.delete(key);
                        this.runningContexts.delete(key);
                        this.runningPromises.delete(key);
                        this.analysisChangeEmitter?.fire();
                    }
                }
            };
            void prepare();
            return resultForDocument(await this.waitForBackground(controller, requestContext, completion, token), requestContext);
        } catch (error) {
            if (resultState) resultState.errorMessage = error.message;
            this.output.appendLine(`Compiler analysis: ${error.message}`);
            if (showResult && !token?.isCancellationRequested) this.vscode.window.showWarningMessage(error.message);
            return false;
        }
    }

    isCompilerSource(uri, languageId = null) {
        if (uri?.scheme !== "file" || typeof uri.fsPath !== "string" || !uri.fsPath) return false;
        if (/\.(bas|bi)$/i.test(uri.fsPath)) return true;
        // File associations and explicit language-mode changes are authoritative
        // for custom headers. Do not capture unrelated plaintext/log buffers.
        if (languageId !== null) return languageId === "freebasic";
        return (this.vscode.workspace.textDocuments || []).some((document) =>
            document.uri?.scheme === "file" && document.uri.fsPath === uri.fsPath && document.languageId === "freebasic");
    }

    contextFor(uri, compilerSelection = this.analysisCompilerFor(uri)) {
        if (!this.isCompilerSource(uri)) throw new Error("Compiler contexts require a named FreeBASIC source file.");
        const configuration = this.vscode.workspace.getConfiguration("freebasic", uri);
        const root = this.vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || path.dirname(uri.fsPath);
        const context = analysisContext(configuration, root, uri.fsPath);
        const compilerIdentity = compilerExecutableIdentity(compilerSelection.compilerPath, path.dirname(context.filePath));
        return { ...context, signature: JSON.stringify([compilerSelection.compilerPath, compilerIdentity,
            compilerSelection.semanticModelOnly, context.name, context.filePath, context.compilerArguments]) };
    }

    refreshContexts() {
        /* Configuration events can arrive after a command has already started
           with the new settings. Retire only work with obsolete signatures.
           A header's resource settings belong to the original request, not
           necessarily to the translation unit that consumes it. */
        const isCurrent = (requestUri, signature) => {
            try { return this.vscode.workspace.isTrusted && this.contextFor(requestUri).signature === signature; }
            catch { return false; }
        };
        this.onDemandFailures = new WeakMap();
        const changedSources = new Set();
        let changed = false;
        for (const [key, snapshot] of this.snapshots) {
            const requestUri = snapshot.requestUri || this.vscode.Uri.file(snapshot.context.filePath);
            if (isCurrent(requestUri, snapshot.context.signature)) continue;
            snapshot.sources.forEach((source) => changedSources.add(source.uri.toString()));
            this.snapshots.delete(key);
            this.expanded.delete(snapshot.uri.toString());
            if (snapshot.model.remote) this.analysisWorker.releaseModel(snapshot.model.snapshotId);
            changed = true;
        }
        for (const [key, controller] of this.running) {
            const context = this.runningContexts.get(key);
            if (context && isCurrent(context.requestUri, context.signature)) continue;
            controller.abort();
            this.running.delete(key);
            this.runningBuffers.delete(key);
            this.runningContexts.delete(key);
            this.runningPromises.delete(key);
        }
        if (changed) {
            this.notifySnapshotChange(changedSources);
            this.publishDiagnostics();
            this.index.notifyChange();
        }
    }

    expireSnapshot(snapshot) {
        for (const [key, current] of this.snapshots) {
            if (current !== snapshot) continue;
            this.snapshots.delete(key);
            this.expanded.delete(snapshot.uri.toString());
            if (snapshot.model.remote) this.analysisWorker.releaseModel(snapshot.model.snapshotId);
            this.notifySnapshotChange(new Set(snapshot.sources.map((source) => source.uri.toString())));
            this.publishDiagnostics();
            this.index.notifyChange();
            return;
        }
    }

    expireModel(id) {
        let changed = false;
        const changedSources = new Set();
        for (const [key, snapshot] of this.snapshots) {
            if (snapshot.model.snapshotId !== id) continue;
            snapshot.sources.forEach((source) => changedSources.add(source.uri.toString()));
            this.snapshots.delete(key);
            this.expanded.delete(snapshot.uri.toString());
            changed = true;
        }
        if (changed) {
            this.notifySnapshotChange(changedSources);
            this.publishDiagnostics();
            this.index.notifyChange();
        }
    }

    snapshotFor(uri) {
        if (uri.scheme === "freebasic-preprocessed") return [...this.snapshots.values()].find((entry) => entry.uri.toString() === uri.toString()) || null;
        try {
            const context = this.contextFor(uri);
            const snapshot = this.snapshots.get(this.vscode.Uri.file(context.filePath).toString());
            return snapshot?.context.signature === context.signature && snapshot.sources.some((source) => source.uri.toString() === uri.toString()) ? snapshot : null;
        } catch { return null; }
    }

    getModel(uri) {
        if (!this.vscode.workspace.isTrusted) return null;
        const snapshot = this.snapshotFor(uri);
        return this.modelForSnapshot(snapshot);
    }

    modelForSnapshot(snapshot) {
        if (!this.vscode.workspace.isTrusted || !snapshot) return null;
        if (snapshot.model.remote && !snapshot.model.available()) return null;
        for (const source of snapshot.sources) {
            const open = this.vscode.workspace.textDocuments.find((document) => document.uri.toString() === source.uri.toString());
            // Source freshness belongs to this translation unit. Retiring it
            // must not discard other contexts or cancel independent queries.
            if (open && open.getText().replace(/^\uFEFF/, "") !== source.text) { this.expireSnapshot(snapshot); return null; }
            if (snapshot.model.remote) continue;
            if (source.overlay && open) continue;
            try {
                if (source.overlay && decodeCompilerSourceBuffer(fs.readFileSync(source.uri.fsPath), source.uri.fsPath).replace(/^\uFEFF/, "") !== source.text) { this.expireSnapshot(snapshot); return null; }
                const stat = fs.statSync(source.uri.fsPath);
                if (stat.mtimeMs !== source.mtimeMs || stat.size !== source.size) { this.expireSnapshot(snapshot); return null; }
            } catch { this.expireSnapshot(snapshot); return null; }
        }
        return snapshot.model;
    }

    async expressionForEditor(document, start, end = start, token = null) {
        const version = document.version;
        /* A binding upgrade can release the worker model while its queued
           expression query is returning. Retry once on the current snapshot,
           without retrying edits or turning an unknown expression into a loop. */
        for (let attempt = 0; attempt < 2; attempt++) {
            if (token?.isCancellationRequested || document.version !== version) return null;
            let model = this.getModel(document.uri);
            if (!model) {
                if (!await this.check(document, false, token)) return null;
                model = this.getModel(document.uri);
            }
            if (!model) continue;
            const expression = await model.expressionAt(document.uri, start, end, token);
            if (token?.isCancellationRequested || document.version !== version) return null;
            if (this.getModel(document.uri) === model) return { model, expression };
        }
        return null;
    }

    async getModelForEditor(document, token = null, needCompilerExpressionTypes = false, needSemanticBindings = false,
        needSemanticMacroBindings = false) {
        if (!document?.uri) return null;
        const current = this.getModel(document.uri);
        if (current && (!needSemanticBindings || current.semanticBindingsAvailable) &&
            (!needSemanticMacroBindings || current.semanticMacroBindingsAvailable) &&
            (!current.semanticSidecarOnly || needCompilerExpressionTypes ||
                needSemanticBindings || needSemanticMacroBindings)) return current;
        if (token?.isCancellationRequested || this.disposed) return null;

        const workspace = this.vscode.workspace;
        if (!workspace.isTrusted || !this.isCompilerSource(document.uri, document.languageId)) return null;
        const configuration = workspace.getConfiguration("freebasic", document.uri);
        if (configuration.get("analysis.run", "onDemand") !== "onDemand") return null;

        const compilerSelection = this.analysisCompilerFor(document.uri);
        if (!compilerSelection.compilerPath || compilerSelection.semanticModelOnly && document.isDirty) return null;
        if (compilerSelection.semanticModelOnly && !needCompilerExpressionTypes &&
            !needSemanticBindings && !needSemanticMacroBindings) return null;
        if (!/\.bas$/i.test(document.uri.fsPath) && !configuration.get("analysis.activeContext", null)) return null;

        let context;
        try {
            context = this.contextFor(document.uri, compilerSelection);
        } catch {
            return null;
        }

        const signatureFor = (contextSignature) => {
            /* Capture saved revisions as well as dirty ones: a header may be
               fixed and saved without changing its root's document version.
               Hash metadata so failures retain neither source text nor large
               editor-buffer lists. The timeout is part of retry eligibility. */
            const buffers = workspace.textDocuments
                .filter((entry) => this.isCompilerSource(entry.uri, entry.languageId))
                .map((entry) => `${entry.uri.toString()}:${Number.isSafeInteger(entry.version) ? entry.version : 0}:${entry.isDirty ? 1 : 0}`)
                .sort();
            const timeout = workspace.getConfiguration("freebasic", document.uri).get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS);
            return crypto.createHash("sha256").update(JSON.stringify([
                contextSignature, Number.isSafeInteger(document.version) ? document.version : 0,
                buffers, timeout, needSemanticBindings, needSemanticMacroBindings
            ])).digest("hex");
        };
        const failureSignature = signatureFor(context.signature);
        const previousFailure = this.onDemandFailures.get(document);
        if (previousFailure?.signature === failureSignature && previousFailure.retryAfter > Date.now()) return null;

        const generation = this.generation;
        const resultState = {};
        const pending = this.check(document, false, token,
            needSemanticBindings || needSemanticMacroBindings, needSemanticMacroBindings, resultState);
        const key = this.vscode.Uri.file(context.filePath).toString();
        const controller = this.running.get(key);
        const requestContext = this.runningContexts.get(key);
        const completed = await pending;
        if (token?.isCancellationRequested || this.disposed || !workspace.isTrusted) return null;

        const prepared = completed ? this.getModel(document.uri) : null;
        if (prepared && (!needSemanticBindings || prepared.semanticBindingsAvailable) &&
            (!needSemanticMacroBindings || prepared.semanticMacroBindingsAvailable)) {
            this.onDemandFailures.delete(document);
            return prepared;
        }

        /* Replacement and invalidation are not compiler failures. Check the
           successful successor first, since binding upgrades abort the original
           controller while transferring its interested providers. A prepared
           model lost during validation/publication must also remain retryable. */
        if (completed || generation !== this.generation || requestContext?.queueBusy) return null;
        const excluded = requestContext?.excludedSources?.has(document.uri.toString());
        if (!excluded && (controller?.signal.aborted || requestContext?.modelPrepared)) return null;
        try {
            if (signatureFor(this.contextFor(document.uri).signature) !== failureSignature) return null;
        } catch { return null; }

        /* Avoid launching a failed compiler request on every hover or completion.
           Source, buffer, compiler, and context changes naturally retry sooner. */
        const message = typeof resultState.errorMessage === "string"
            ? resultState.errorMessage.replace(/[\r\n\t]+/g, " ").slice(0, MAX_EDITOR_FAILURE_MESSAGE_LENGTH) : "";
        this.onDemandFailures.set(document, { signature: failureSignature, retryAfter: Date.now() + 30000, message });
        this.analysisChangeEmitter?.fire();
        return null;
    }

    isConfigured(uri) {
        return Boolean(this.compilerPathFor(uri));
    }

    shouldCheckWithAnalysis(document) {
        if (!this.isCompilerSource(document?.uri, document?.languageId) || !this.isConfigured(document.uri)) return false;
        /* Explicit checks must use the selected translation unit and defines
           even when nothing is dirty. Header context errors also belong to
           analysis, which can explain how to select their root module. */
        if (!/\.bas$/i.test(document.uri.fsPath) || document.isDirty) return true;
        if (this.vscode.workspace.getConfiguration("freebasic", document.uri).get("analysis.activeContext", null) !== null) return true;
        return (this.vscode.workspace.textDocuments || []).some((candidate) =>
            candidate?.isDirty === true && this.isCompilerSource(candidate.uri, candidate.languageId) && !/\.bas$/i.test(candidate.uri.fsPath)
        );
    }

    analysisCompilerFor(uri) {
        const bridge = this.compilerPathFor(uri);
        if (bridge) return { compilerPath: bridge, semanticModelOnly: false };

        const configuration = this.vscode.workspace.getConfiguration("freebasic", uri);
        const configured = configuration.get("compiler.path", "fbc");
        let compilerPath = resolveCompilerPath(typeof configured === "string" ? configured : "fbc");
        if (path.isAbsolute(compilerPath) && fs.existsSync(compilerPath)) {
            try { compilerPath = fs.realpathSync(compilerPath); } catch { /* Keep the configured spelling for execution and diagnostics. */ }
        }
        return { compilerPath, semanticModelOnly: Boolean(compilerPath) };
    }

    compilerCompatibilityFor(uri) {
        if (!uri?.fsPath) return { state: "unknown", version: "", message: "Compiler compatibility requires a file-backed source." };
        const compiler = this.analysisCompilerFor(uri);
        return this.compilerCompatibility.get(compiler.compilerPath, path.dirname(uri.fsPath));
    }

    ensureCompilerCompatibility(uri) {
        if (!uri?.fsPath) return Promise.resolve({ state: "unknown", version: "", message: "Compiler compatibility requires a file-backed source." });
        const compiler = this.analysisCompilerFor(uri);
        return this.compilerCompatibility.ensure(compiler.compilerPath, path.dirname(uri.fsPath));
    }

    compilerPathFor(uri) {
        const configured = this.vscode.workspace.getConfiguration("freebasic", uri).get("analysis.compilerPath", "");
        if (typeof configured !== "string" || !configured) return "";
        if (!path.isAbsolute(configured) || !fs.existsSync(configured)) return configured;
        try {
            /* The Linux builder's stable symlink changes target on each build.
               Include the target path in cache keys to prevent stale snapshots
               when a bridge is rebuilt without reloading VS Code. */
            return fs.realpathSync(configured);
        } catch {
            return configured;
        }
    }

    workspaceSymbols(query, token) { return compilerWorkspaceSymbols(this, query, token); }

    getWorkspaceWorkers() {
        if (!this.backgroundModels || this.disposed) return [];
        const configuredCount = this.vscode.workspace.getConfiguration("freebasic").get("index.workspaceConcurrency", WORKSPACE_INDEX_WORKER_COUNT);
        const workerCount = Number.isSafeInteger(configuredCount)
            ? Math.max(1, Math.min(WORKSPACE_INDEX_WORKER_COUNT, configuredCount))
            : WORKSPACE_INDEX_WORKER_COUNT;
        if (this.workspaceWorkers?.length !== workerCount) {
            const previous = this.workspaceWorkers || [];
            this.workspaceWorkers = Array.from({ length: workerCount }, () =>
                new CompilerAnalysisWorker(undefined, (message) => this.output.appendLine(message), () => this.vscode.workspace.isTrusted,
                    undefined, this.processSupervisor)
            );
            previous.forEach((worker) => worker.cancelAll());
            if (previous.length) {
                const stopping = Promise.all(previous.map((worker) => worker.dispose())).catch((error) => {
                    this.output.appendLine(`Workspace symbol worker shutdown: ${error.message}`);
                });
                this.workspaceWorkerDisposals.push(stopping);
                stopping.then(() => {
                    const index = this.workspaceWorkerDisposals.indexOf(stopping);
                    if (index >= 0) this.workspaceWorkerDisposals.splice(index, 1);
                });
            }
        }
        return this.workspaceWorkers;
    }

    async selectContext(document) {
        try {
            const workspace = this.vscode.workspace;
            if (!workspace.isTrusted) throw new Error("Compiler analysis is disabled in untrusted workspaces.");
            if (!this.isCompilerSource(document?.uri, document?.languageId)) throw new Error("Open a named FreeBASIC module or header first.");
            const root = workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
            if (!root) throw new Error("Compiler context selection requires a workspace folder.");
            const configuration = workspace.getConfiguration("freebasic", document.uri);
            const jobs = projectContexts(configuration, root).filter((job) => !/\.bas$/i.test(document.uri.fsPath) || job.filePath === document.uri.fsPath);
            if (!jobs.length) throw new Error("This module is not listed in analysis.projectContexts.");
            const selected = await this.vscode.window.showQuickPick(jobs.map((job) => ({ label: job.name, description: path.relative(root, job.filePath), detail: job.compilerArguments.join(" "), job })), { placeHolder: "Select the build and translation unit used to analyze headers" });
            if (!selected || !workspace.isTrusted) return false;
            await configuration.update("analysis.activeContext", { name: selected.job.name, module: path.relative(root, selected.job.filePath) }, this.vscode.ConfigurationTarget.WorkspaceFolder);
            this.invalidate();
            return this.check(document);
        } catch (error) {
            this.output.appendLine(`Compiler context: ${error.message}`);
            this.vscode.window.showWarningMessage(error.message);
            return false;
        }
    }

    publishDiagnostics() {
        if (!this.diagnosticCollection) return;
        const byFile = new Map();
        const seen = new Set();
        for (const snapshot of this.snapshots.values()) {
            const linesByUri = new Map();
            for (const record of snapshot.diagnostics || []) {
                const source = snapshot.sources.find((source) => source.uri.fsPath === record.filePath);
                if (!source) continue;
                const key = `${record.filePath}:${record.line}:${record.severity}:${record.code}:${record.message}`;
                if (seen.has(key)) continue;
                seen.add(key);
                let lines = linesByUri.get(source.uri.toString());
                if (!lines) {
                    lines = source.text.split(/\r\n|\n|\r/);
                    linesByUri.set(source.uri.toString(), lines);
                }
                const line = Math.max(0, Math.min(record.line, lines.length - 1));
                const text = lines[line];
                const semanticRange = compilerDeclarationSuffixConflictRange(source.text, record) ||
                    compilerIgnoredDeclarationSuffixRange(source.text, record) ||
                    compilerByRefFunctionResultAssignmentRange(source.text, record) ||
                    compilerConstantConversionOverflowRange(source.text, record) ||
                    compilerConstantConversionOverflowPointRange(source.text, record) ||
                    compilerImplicitVariableAllocationRange(source.text, record) ||
                    compilerImplicitParameterPassingModeRange(source.text, record) ||
                    compilerParameterDefaultMismatchRange(source.text, record) ||
                    compilerProcedureSignatureMismatchRange(source.text, record) ||
                    compilerForNextCounterMismatchRange(source.text, record) ||
                    compilerMeaninglessNextVariableRange(source.text, record) ||
                    compilerLineInputBufferCapacityRange(source.text, record) ||
                    compilerMissingClosingQuoteRange(source.text, record) ||
                    compilerPossibleEscapeStringRange(source.text, record) ||
                    compilerRedundantNewAnyInitializerRange(source.text, record) ||
                    compilerErrorResumeNextRange(source.text, record);
                const physical = semanticRange || compilerForCounterWrapRange(source.text, record) ||
                    compilerSuspiciousPointerAssignmentRange(source.text, record) ||
                    compilerFunctionPointerMismatchRange(source.text, record) ||
                    compilerOperatorWarningTokenRange(source.text, record) ||
                    compilerConstQualifierWarningRange(source.text, record) ||
                    compilerLargeStackWarningRange(source.text, record) ||
                    compilerImplicitConversionRange(source.text, record) ||
                    (physicalPointMatchesDiagnosticText(lines, record)
                        ? physicalDiagnosticRange(lines, record.physicalPoint)
                        : null);
                /* Prefer compiler-owned physical points; textual fbc output
                   identifies only a displayed line. Always use the captured
                   snapshot, never a post-compilation disk or editor reread. */
                const range = physical
                    ? new this.vscode.Range(physical.line, physical.startCharacter, physical.line, physical.endCharacter)
                    : new this.vscode.Range(line, text.search(/\S/) < 0 ? 0 : text.search(/\S/), line, text.length);
                const severity = record.severity === "warning" ? this.vscode.DiagnosticSeverity.Warning : this.vscode.DiagnosticSeverity.Error;
                const details = [record.compilerDetail, record.compilerCustomText]
                    .filter((detail) => detail && !record.message.includes(detail));
                const contextLabel = compilerDiagnosticContextLabel(record.compilerContext);
                const guidance = compilerDiagnosticGuidance(record);
                const diagnostic = new this.vscode.Diagnostic(range,
                    [record.message, ...details, contextLabel ? `Compiler context: ${contextLabel}` : "", guidance]
                        .filter(Boolean).join("\n\n"),
                    severity);
                diagnostic.code = record.code;
                diagnostic.source = "fbc (buffer)";
                const group = byFile.get(record.filePath) || { uri: source.uri, diagnostics: [] };
                group.diagnostics.push(diagnostic);
                byFile.set(record.filePath, group);
            }
        }
        this.diagnosticCollection.clear();
        for (const group of byFile.values()) this.diagnosticCollection.set(group.uri, group.diagnostics);
    }

    captureBuffers() {
        return new Map(this.vscode.workspace.textDocuments.filter((document) => this.isCompilerSource(document.uri, document.languageId)).map((document) => [document.uri.fsPath, document.getText()]));
    }

    buffersMatch(buffers) {
        const current = this.captureBuffers();
        for (const [file, text] of buffers) {
            if (current.has(file)) { if (current.get(file) !== text) return false; }
            else {
                try {
                    const diskText = decodeCompilerSourceBuffer(fs.readFileSync(file), file).replace(/^\uFEFF/, "");
                    if (diskText !== text.replace(/^\uFEFF/, "")) return false;
                } catch { return false; }
            }
        }
        /* A newly opened dirty header may affect an in-flight translation unit. */
        for (const [file, text] of current) if (!buffers.has(file)) {
            try {
                const diskText = decodeCompilerSourceBuffer(fs.readFileSync(file), file).replace(/^\uFEFF/, "");
                if (diskText !== text.replace(/^\uFEFF/, "")) return false;
            } catch { return false; }
        }
        return true;
    }

    schedule(document) {
        clearTimeout(this.pendingTimer);
        const affected = /\.bas$/i.test(document.uri.fsPath) ? [document.uri.toString()] : this.index.getDependentModules(document.uri).map((uri) => uri.toString());
        /* Keep the header request when its chosen root is not an open editor.
           check() reads the root from disk and overlays all current buffers. */
        if (!/\.bas$/i.test(document.uri.fsPath)) {
            try { this.contextFor(document.uri); affected.push(document.uri.toString()); } catch { /* No selected header context. */ }
        }
        for (const [key, snapshot] of this.snapshots) if (snapshot.sources.some((source) => source.uri.toString() === document.uri.toString())) affected.push(key);
        for (const key of affected) this.pendingModules.add(key);
        this.pendingTimer = setTimeout(async () => {
            const pending = new Set(this.pendingModules);
            this.pendingModules.clear();
            for (const module of this.vscode.workspace.textDocuments) {
                if (pending.has(module.uri.toString()) && this.vscode.workspace.getConfiguration("freebasic", module.uri).get("analysis.run", "off") === "onChange") await this.check(module, false);
            }
        }, 400);
    }

    documentOpened(document) {
        if (!this.isCompilerSource(document?.uri, document?.languageId)) return;
        const filePath = document.uri.fsPath, name = path.basename(filePath).toLowerCase();
        const changedSources = new Set();
        let changed = false, reschedule = false;
        for (const [key, snapshot] of this.snapshots) {
            const missing = snapshot.missingIncludes;
            if (!missing?.names.has(name) || missing.inputs.has(filePath)) continue;
            snapshot.sources.forEach((source) => changedSources.add(source.uri.toString()));
            this.snapshots.delete(key);
            this.expanded.delete(snapshot.uri.toString());
            if (snapshot.model.remote) this.analysisWorker.releaseModel(snapshot.model.snapshotId);
            /* A delayed open event must preserve a pass that already captured
               the newly available header. Older preparations are obsolete. */
            if (!this.runningBuffers.get(key)?.has(filePath)) {
                this.running.get(key)?.abort();
                if (this.vscode.workspace.getConfiguration("freebasic", this.vscode.Uri.file(snapshot.context.filePath)).get("analysis.run", "off") === "onChange") {
                    this.pendingModules.add(key);
                    reschedule = true;
                }
            }
            changed = true;
        }
        if (changed) {
            this.notifySnapshotChange(changedSources);
            this.publishDiagnostics();
            this.index.notifyChange();
        }
        if (reschedule) this.schedule(document);
    }

    documentClosed(document) {
        if (!this.isCompilerSource(document?.uri, document?.languageId)) return;
        const filePath = document.uri.fsPath;
        const captured = [...this.snapshots.values()].some((snapshot) =>
            snapshot.sources.some((source) => source.uri.fsPath === filePath)) ||
            [...this.runningBuffers.values()].some((buffers) => buffers.has(filePath));
        if (!captured) return;
        let diskText = null;
        try {
            if (fs.statSync(filePath).size <= MAX_ANALYSIS_BYTES) {
                diskText = decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath).replace(/^\uFEFF/, "");
            }
        }
        catch { /* A deleted source cannot validate a captured overlay. */ }
        const changedSources = new Set();
        const affectedModules = new Set();
        let stale = false;
        /* Replacing a preview tab closes a perfectly current saved document.
           That must not abort another module's analysis. Only discarded
           overlays whose disk contents differ invalidate compiler inputs. */
        for (const [key, snapshot] of this.snapshots) {
            if (!snapshot.sources.some((source) => source.uri.fsPath === filePath && source.text !== diskText)) continue;
            affectedModules.add(key);
            snapshot.sources.forEach((source) => changedSources.add(source.uri.toString()));
            this.snapshots.delete(key);
            this.expanded.delete(snapshot.uri.toString());
            if (snapshot.model.remote) this.analysisWorker.releaseModel(snapshot.model.snapshotId);
            stale = true;
        }
        for (const [key, controller] of this.running) {
            const buffers = this.runningBuffers.get(key);
            if (!buffers?.has(filePath) || buffers.get(filePath).replace(/^\uFEFF/, "") === diskText) continue;
            const request = this.runningContexts.get(key);
            if (this.backgroundModels && key !== document.uri.toString() &&
                request?.requestUri?.toString() !== document.uri.toString() && !affectedModules.has(key)) {
                // Pending overlays include unrelated editors. The worker's
                // mandatory source validation will reject a discarded header
                // if this compilation actually consumed it.
                continue;
            }
            controller.abort();
            this.running.delete(key);
            this.runningBuffers.delete(key);
            this.runningContexts.delete(key);
            this.runningPromises.delete(key);
            stale = true;
        }
        if (stale) {
            this.notifySnapshotChange(changedSources);
            this.publishDiagnostics();
            this.index.notifyChange();
        }
    }

    documentChanged(document) {
        if (!this.isCompilerSource(document?.uri, document?.languageId)) {
            /* Untitled and expanded editor documents are not compiler inputs.
               Their delayed edit events must not cancel a named module. */
            return;
        }
        const filePath = document.uri.fsPath;
        this.documentOpened(document);
        this.onDemandFailures.delete(document);
        const bufferText = document.getText();
        const sourceText = bufferText.replace(/^\uFEFF/, "");
        let stale = false;
        const changedSources = new Set();
        for (const [key, snapshot] of this.snapshots) {
            if (!snapshot.sources.some((source) => source.uri.fsPath === filePath && source.text !== sourceText)) continue;
            snapshot.sources.forEach((source) => changedSources.add(source.uri.toString()));
            this.snapshots.delete(key);
            this.expanded.delete(snapshot.uri.toString());
            if (snapshot.model.remote) this.analysisWorker.releaseModel(snapshot.model.snapshotId);
            stale = true;
        }
        for (const [key, controller] of this.running) {
            const buffers = this.runningBuffers.get(key);
            /* VS Code can deliver an edit event after a command captures that
               edit. Only stop requests whose immutable input still differs
               from the document now visible to the user. */
            if (buffers?.get(filePath) === bufferText) continue;
            controller.abort();
            this.running.delete(key);
            this.runningBuffers.delete(key);
            this.runningContexts.delete(key);
            this.runningPromises.delete(key);
            stale = true;
        }
        if (stale) {
            this.notifySnapshotChange(changedSources);
            this.publishDiagnostics();
            this.index.notifyChange();
        }
    }

    provideTextDocumentContent(uri) {
        return this.expanded.get(uri.toString()) ?? "' This compiler snapshot has expired. Analyze the module again.\n";
    }

    async showExpanded(document) {
        if (!document) return;
        const version = document.version;
        const current = () => !this.disposed && this.vscode.workspace.isTrusted &&
            document.isClosed !== true && document.version === version;
        if (!this.getModel(document.uri) && !await this.checkCurrent(document, false)) return;
        const initial = this.snapshotFor(document.uri);
        if (!initial || !current()) return;
        const signature = initial.context.signature;
        // Opening and assigning a language await the editor. Metadata
        // enrichment can retire that URI meanwhile; follow one successor
        // without following edits, trust changes, or another build context.
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!current()) return;
            let snapshot = this.snapshotFor(document.uri);
            if (!snapshot) {
                if (!await this.checkCurrent(document, false) || !current()) return;
                snapshot = this.snapshotFor(document.uri);
            }
            if (!snapshot || snapshot.context.signature !== signature) return;
            const selected = () => this.snapshotFor(document.uri) === snapshot && this.expanded.has(snapshot.uri.toString());
            const expanded = await this.vscode.workspace.openTextDocument(snapshot.uri);
            if (!current()) return;
            if (!selected()) continue;
            await this.vscode.languages.setTextDocumentLanguage(expanded, "freebasic");
            if (!current()) return;
            if (!selected()) continue;
            await this.vscode.window.showTextDocument(expanded, { preview: true });
            if (!current() || selected()) return;
        }
    }

    invalidate() {
        this.generation++;
        this.onDemandFailures = new WeakMap();
        for (const controller of this.running.values()) controller.abort();
        this.running.clear();
        this.runningBuffers.clear();
        this.runningContexts.clear();
        this.runningPromises.clear();
        this.analysisChangeEmitter?.fire();
        this.analysisWorker?.cancelAll();
        this.workspaceWorkers?.forEach((worker) => worker.cancelAll());
        const changedSources = new Set();
        for (const snapshot of this.snapshots.values()) {
            snapshot.sources.forEach((source) => changedSources.add(source.uri.toString()));
        }
        this.snapshots.clear();
        this.notifySnapshotChange(changedSources);
        this.diagnosticCollection?.clear();
        this.index.notifyChange();
    }

    dispose() {
        if (this.disposing) return this.disposing;
        if (this.disposed) return Promise.resolve();
        this.disposed = true;
        clearTimeout(this.pendingTimer);
        this.invalidate();
        this.expanded.clear();
        this.diagnosticCollection?.dispose();
        this.snapshotChangeEmitter?.dispose();
        this.analysisChangeEmitter?.dispose();
        const stopping = [
            ...this.workspaceWorkerDisposals,
            ...[this.analysisWorker, ...(this.workspaceWorkers || [])].filter(Boolean).map((worker) => worker.dispose())
        ];
        this.workspaceWorkerDisposals = [];
        this.disposing = Promise.all(stopping).then(() => this.processSupervisor?.dispose());
        return this.disposing;
    }
}

module.exports = { CompilerAnalysisService };

/* end of lib/compiler-analysis-service.js */
