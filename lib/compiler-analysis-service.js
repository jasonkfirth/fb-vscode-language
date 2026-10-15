/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-analysis-service.js
    Purpose: Manage on-demand compiler snapshots of disk and editor buffers.
    Responsibilities: enforce trust, reject stale snapshots, provide expanded text.
    Does not contain: compiler building, inferred preprocessing, or editing files.
*/

const fs = require("fs");
const path = require("path");
const { DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS, MAX_ANALYSIS_BYTES, decodeCompilerSourceBuffer } = require("./compiler-analysis");
const { CompilerAnalysisWorker } = require("./compiler-worker");
const { CompilerProcessSupervisor } = require("./compiler-process-supervisor");
const { performance } = require("perf_hooks");
const { CompilerSemanticModel } = require("./compiler-semantic-model");
const { analysisContext, projectContexts } = require("./compiler-contexts");
const { CompilerRemoteModel } = require("./compiler-remote-model");
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

function sameBuffers(first, second) {
    return first?.size === second.size && [...first].every(([file, text]) => second.get(file) === text);
}

class CompilerAnalysisService {
    constructor(vscode, index, output, analyze = null) {
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
    }

    notifySnapshotChange(sources) {
        const entries = sources && typeof sources[Symbol.iterator] === "function" ? [...sources] : [];
        const uris = [...new Set(entries.map((source) =>
            typeof source === "string" ? source : source?.uri?.toString?.()
        ).filter(Boolean))];
        if (uris.length) this.snapshotChangeEmitter?.fire(uris);
    }

    async check(document, showResult = true, token = null, needSemanticBindings = false, needSemanticMacroBindings = false) {
        if (this.backgroundModels) return this.checkBackground(document, showResult, token, needSemanticBindings, needSemanticMacroBindings);
        let activeKey;
        let activeController;
        const cancellation = token?.onCancellationRequested?.(() => activeController?.abort());
        try {
            const workspace = this.vscode.workspace;
            if (!workspace.isTrusted) throw new Error("Compiler analysis is disabled in untrusted workspaces.");
            if (!document || document.uri.scheme !== "file" || !/\.(bas|bi)$/i.test(document.uri.fsPath)) throw new Error("Open a named FreeBASIC .bas module or .bi header first.");
            const configuration = workspace.getConfiguration("freebasic", document.uri);
            const compilerSelection = this.analysisCompilerFor(document.uri);
            const compilerPath = compilerSelection.compilerPath;
            if (!compilerPath) throw new Error("Configure freebasic.compiler.path or freebasic.analysis.compilerPath before requesting compiler analysis.");
            if (compilerSelection.semanticModelOnly && document.isDirty) throw new Error("The configured fbc semantic sidecar cannot analyze an unsaved root buffer; save it or configure the editor bridge for unsaved-buffer analysis.");
            const context = this.contextFor(document.uri, compilerSelection);
            const generation = this.generation;
            await this.index.ensureInitialized();
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
            if (/\.bi$/i.test(document.uri.fsPath) && !analysis.dependencies.includes(document.uri.fsPath)) throw new Error("The selected translation unit did not include this header. Select a module and build context that consumes it.");
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
            model.semanticBindingsAvailable = needSemanticBindings;
            model.semanticMacroBindingsAvailable = needSemanticMacroBindings;
            if (analysis.workerStats) {
                const stats = analysis.workerStats;
                this.output.appendLine(`Compiler worker ${stats.threadId}: ${Math.round(stats.roundTripMs)} ms round trip, ${Math.round(stats.decodeMs)} ms decode (${stats.cacheHit ? "cached trace" : "new trace"}), ${Math.round(performance.now() - modelStart)} ms editor model.`);
            }
            this.snapshots.set(key, { model, sources, uri, bytes, context, diagnostics: analysis.diagnostics || [] });
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
            this.output.appendLine(`Compiler analysis: ${error.message}`);
            if (showResult && !token?.isCancellationRequested) this.vscode.window.showWarningMessage(error.message);
            return false;
        } finally {
            cancellation?.dispose();
            if (activeController && this.running.get(activeKey) === activeController) {
                this.running.delete(activeKey);
                this.runningBuffers.delete(activeKey);
            }
        }
    }

    async checkBackground(document, showResult, token, needSemanticBindings = false, needSemanticMacroBindings = false) {
        const controller = new AbortController();
        const cancellation = token?.onCancellationRequested?.(() => controller.abort()) || null;
        let key, completion, finish, outcome = false, reply;
        try {
            const workspace = this.vscode.workspace;
            if (!workspace.isTrusted) throw new Error("Compiler analysis is disabled in untrusted workspaces.");
            if (!document || document.uri.scheme !== "file" || !/\.(bas|bi)$/i.test(document.uri.fsPath)) throw new Error("Open a named FreeBASIC .bas module or .bi header first.");
            if (token?.isCancellationRequested) return false;
            const configuration = workspace.getConfiguration("freebasic", document.uri);
            const compilerSelection = this.analysisCompilerFor(document.uri);
            const compilerPath = compilerSelection.compilerPath;
            if (!compilerPath) throw new Error("Configure freebasic.compiler.path or freebasic.analysis.compilerPath before requesting compiler analysis.");
            if (compilerSelection.semanticModelOnly && document.isDirty) throw new Error("The configured fbc semantic sidecar cannot analyze an unsaved root buffer; save it or configure the editor bridge for unsaved-buffer analysis.");
            const context = this.contextFor(document.uri, compilerSelection);
            const generation = this.generation;
            const overlays = this.captureBuffers();
            key = this.vscode.Uri.file(context.filePath).toString();
            const runningContext = this.runningContexts.get(key);
            const running = this.running.get(key);
            if (running && runningContext?.signature === context.signature &&
                (runningContext.semanticBindings || !needSemanticBindings) &&
                (runningContext.semanticMacroBindings || !needSemanticMacroBindings) &&
                sameBuffers(this.runningBuffers.get(key), overlays)) {
                return this.runningPromises.get(key) || false;
            }
            running?.abort();
            completion = new Promise((resolve) => { finish = resolve; });
            this.running.set(key, controller);
            this.runningBuffers.set(key, new Map(overlays));
            this.runningContexts.set(key, {
                signature: context.signature,
                semanticBindings: needSemanticBindings || needSemanticMacroBindings,
                semanticMacroBindings: needSemanticMacroBindings
            });
            this.runningPromises.set(key, completion);
            const previousSnapshot = this.snapshots.get(key);
            this.snapshots.delete(key);
            if (previousSnapshot) {
                this.expanded.delete(previousSnapshot.uri.toString());
                if (previousSnapshot.model.remote) this.analysisWorker.releaseModel(previousSnapshot.model.snapshotId);
                this.notifySnapshotChange(previousSnapshot.sources);
            }
            this.publishDiagnostics();
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
            reply = await this.analysisWorker.analyze({ compilerPath, filePath: context.filePath, compilerArguments: context.compilerArguments, overlays,
                semanticSourceFiles: [...new Set([context.filePath, ...overlays.keys()])],
                allowErrors: true, exportSemanticExpressions: true,
                exportSemanticBindings: needSemanticBindings || needSemanticMacroBindings,
                semanticModelOnly: compilerSelection.semanticModelOnly,
                compactSemanticMacros: !(compilerSelection.semanticModelOnly && needSemanticMacroBindings),
                signal: controller.signal, timeoutMs: configuration.get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS) },
            { requestedFile: document.uri.fsPath, expandedUri: { scheme: uri.scheme, value: uri.toString(), path: uri.path } });
            if (!workspace.isTrusted) { this.invalidate(); throw new Error("Workspace trust changed during compiler analysis."); }
            if (generation !== this.generation || this.running.get(key) !== controller || controller.signal.aborted || context.signature !== this.contextFor(document.uri).signature) return discarded("preparation");
            const openFiles = workspace.textDocuments.filter((entry) => entry.uri.scheme === "file").map((entry) => entry.uri.fsPath);
            await this.analysisWorker.query(reply.snapshotId, "validate", { uri: { scheme: "file", fsPath: document.uri.fsPath }, openFiles }, controller.signal);
            if (!workspace.isTrusted) { this.invalidate(); throw new Error("Workspace trust changed during compiler analysis."); }
            if (generation !== this.generation || this.running.get(key) !== controller || controller.signal.aborted || context.signature !== this.contextFor(document.uri).signature) return discarded("validation");
            const sources = reply.sources.map((source) => ({ ...source, uri: this.vscode.Uri.file(source.filePath) }));
            const model = new CompilerRemoteModel(this, reply.snapshotId, reply.partial, reply.semanticSidecarOnly,
                needSemanticBindings || needSemanticMacroBindings, needSemanticMacroBindings);
            const bytes = Buffer.byteLength(reply.text) + sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0);
            this.snapshots.set(key, { model, sources, uri, bytes, context, diagnostics: reply.diagnostics });
            this.onDemandFailures.delete(document);
            const changedSources = new Set(sources.map((source) => source.uri.toString()));
            // Open source buffers are checked before and after every query;
            // disk freshness checks stay beside the model in the worker.
            if (this.getModel(document.uri) !== model) return discarded("publication");
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
            if (showResult) this.vscode.window.showInformationMessage(reply.partial
                ? `FreeBASIC retained partial compiler analysis with ${reply.completion.errorCount} error(s). Failed regions are excluded; recovery-dependent types are provisional.`
                : reply.semanticSidecarOnly
                    ? reply.semanticExpressionCount
                        ? "FreeBASIC expression types were updated from the compiler sidecar. This compiler does not provide editor-origin tracing; native symbols, macros, and project refactoring require the editor bridge."
                        : "FreeBASIC's semantic sidecar supplied no physical expression types. Native symbols, macros, and project refactoring require the editor bridge."
                    : "FreeBASIC compiler analysis updated from current editor buffers, including expression types and resolved calls.");
            outcome = true;
            return true;
        } catch (error) {
            this.output.appendLine(`Compiler analysis: ${error.message}`);
            if (showResult && !token?.isCancellationRequested) this.vscode.window.showWarningMessage(error.message);
            return false;
        } finally {
            if (reply?.snapshotId && !outcome) this.analysisWorker.releaseModel(reply.snapshotId);
            cancellation?.dispose();
            finish?.(outcome);
            if (this.running.get(key) === controller) {
                this.running.delete(key);
                this.runningBuffers.delete(key);
                this.runningContexts.delete(key);
                this.runningPromises.delete(key);
            }
        }
    }

    contextFor(uri, compilerSelection = this.analysisCompilerFor(uri)) {
        if (uri.scheme !== "file" || !/\.(bas|bi)$/i.test(uri.fsPath)) throw new Error("Compiler contexts require a named FreeBASIC source file.");
        const configuration = this.vscode.workspace.getConfiguration("freebasic", uri);
        const root = this.vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || path.dirname(uri.fsPath);
        const context = analysisContext(configuration, root, uri.fsPath);
        return { ...context, signature: JSON.stringify([compilerSelection.compilerPath, compilerSelection.semanticModelOnly, context.name, context.filePath, context.compilerArguments]) };
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
        if (!snapshot) return null;
        if (snapshot.model.remote && !snapshot.model.available()) return null;
        for (const source of snapshot.sources) {
            const open = this.vscode.workspace.textDocuments.find((document) => document.uri.toString() === source.uri.toString());
            if (open && open.getText().replace(/^\uFEFF/, "") !== source.text) { this.invalidate(); return null; }
            if (snapshot.model.remote) continue;
            if (source.overlay && open) continue;
            try {
                if (source.overlay && decodeCompilerSourceBuffer(fs.readFileSync(source.uri.fsPath), source.uri.fsPath).replace(/^\uFEFF/, "") !== source.text) { this.invalidate(); return null; }
                const stat = fs.statSync(source.uri.fsPath);
                if (stat.mtimeMs !== source.mtimeMs || stat.size !== source.size) { this.invalidate(); return null; }
            } catch { this.invalidate(); return null; }
        }
        return snapshot.model;
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
        if (!workspace.isTrusted || document.uri.scheme !== "file" || !/\.(bas|bi)$/i.test(document.uri.fsPath)) return null;
        const configuration = workspace.getConfiguration("freebasic", document.uri);
        if (configuration.get("analysis.run", "onDemand") !== "onDemand") return null;

        const compilerSelection = this.analysisCompilerFor(document.uri);
        if (!compilerSelection.compilerPath || compilerSelection.semanticModelOnly && document.isDirty) return null;
        if (compilerSelection.semanticModelOnly && !needCompilerExpressionTypes &&
            !needSemanticBindings && !needSemanticMacroBindings) return null;
        if (/\.bi$/i.test(document.uri.fsPath) && !configuration.get("analysis.activeContext", null)) return null;

        let context;
        try {
            context = this.contextFor(document.uri, compilerSelection);
        } catch {
            return null;
        }

        const openDirtyBuffers = workspace.textDocuments
            .filter((entry) => entry.isDirty && entry.uri.scheme === "file" && /\.(bas|bi)$/i.test(entry.uri.fsPath))
            .map((entry) => `${entry.uri.toString()}:${Number.isSafeInteger(entry.version) ? entry.version : 0}`)
            .sort();
        const version = Number.isSafeInteger(document.version) ? document.version : 0;
        const failureSignature = JSON.stringify([
            context.signature, version, openDirtyBuffers, needSemanticBindings, needSemanticMacroBindings
        ]);
        const previousFailure = this.onDemandFailures.get(document);
        if (previousFailure?.signature === failureSignature && previousFailure.retryAfter > Date.now()) return null;

        const completed = await this.check(document, false, token,
            needSemanticBindings || needSemanticMacroBindings, needSemanticMacroBindings);
        if (token?.isCancellationRequested || this.disposed) return null;

        const prepared = completed ? this.getModel(document.uri) : null;
        if (prepared && (!needSemanticBindings || prepared.semanticBindingsAvailable) &&
            (!needSemanticMacroBindings || prepared.semanticMacroBindingsAvailable)) {
            this.onDemandFailures.delete(document);
            return prepared;
        }

        /* Avoid launching a failed compiler request on every hover or completion.
           Source, buffer, compiler, and context changes naturally retry sooner. */
        this.onDemandFailures.set(document, { signature: failureSignature, retryAfter: Date.now() + 30000 });
        return null;
    }

    isConfigured(uri) {
        return Boolean(this.compilerPathFor(uri));
    }

    shouldAnalyzeUnsavedBuffers(document) {
        if (!document?.uri || document.uri.scheme !== "file" ||
            !/\.(?:bas|bi)$/i.test(document.uri.fsPath || "") || !this.isConfigured(document.uri)) return false;
        if (document.isDirty) return true;
        if (!/\.bas$/i.test(document.uri.fsPath)) return false;
        return (this.vscode.workspace.textDocuments || []).some((candidate) =>
            candidate?.isDirty === true && candidate.uri?.scheme === "file" && /\.bi$/i.test(candidate.uri.fsPath || "")
        );
    }

    analysisCompilerFor(uri) {
        const bridge = this.compilerPathFor(uri);
        if (bridge) return { compilerPath: bridge, semanticModelOnly: false };

        const configuration = this.vscode.workspace.getConfiguration("freebasic", uri);
        const configured = configuration.get("compiler.path", "fbc");
        let compilerPath = typeof configured === "string" ? configured : "fbc";
        if (path.isAbsolute(compilerPath) && fs.existsSync(compilerPath)) {
            try { compilerPath = fs.realpathSync(compilerPath); } catch { /* Keep the configured spelling for execution and diagnostics. */ }
        }
        return { compilerPath, semanticModelOnly: Boolean(compilerPath) };
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
            if (!document || document.uri.scheme !== "file" || !/\.(bas|bi)$/i.test(document.uri.fsPath)) throw new Error("Open a named FreeBASIC module or header first.");
            const root = workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
            if (!root) throw new Error("Compiler context selection requires a workspace folder.");
            const configuration = workspace.getConfiguration("freebasic", document.uri);
            const jobs = projectContexts(configuration, root).filter((job) => /\.bi$/i.test(document.uri.fsPath) || job.filePath === document.uri.fsPath);
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
        return new Map(this.vscode.workspace.textDocuments.filter((document) => document.uri.scheme === "file" && /\.(bas|bi)$/i.test(document.uri.fsPath)).map((document) => [document.uri.fsPath, document.getText()]));
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
        if (/\.bi$/i.test(document.uri.fsPath)) {
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

    documentChanged(document) {
        if (!document || document.uri?.scheme !== "file" || !/\.(bas|bi)$/i.test(document.uri.fsPath)) {
            this.invalidate();
            return;
        }
        const filePath = document.uri.fsPath;
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
        return this.expanded.get(uri.toString()) || "' This compiler snapshot has expired. Analyze the module again.\n";
    }

    async showExpanded(document) {
        if (!document) return;
        if (!this.getModel(document.uri) && !await this.check(document)) return;
        const snapshot = this.snapshotFor(document.uri);
        if (!snapshot) return;
        const expanded = await this.vscode.workspace.openTextDocument(snapshot.uri);
        await this.vscode.languages.setTextDocumentLanguage(expanded, "freebasic");
        await this.vscode.window.showTextDocument(expanded, { preview: true });
    }

    invalidate() {
        this.generation++;
        this.onDemandFailures = new WeakMap();
        for (const controller of this.running.values()) controller.abort();
        this.running.clear();
        this.runningBuffers.clear();
        this.runningContexts.clear();
        this.runningPromises.clear();
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
