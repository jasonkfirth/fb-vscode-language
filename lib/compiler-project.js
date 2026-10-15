/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-project.js
    Purpose: Adapt compiler-bound project navigation and renames for VS Code.
    Responsibilities: capture editor context, reject stale replies, return locations/edits.
    Does not contain: native graph construction, source writes, or implicit projects.
*/

const fs = require("fs");
const path = require("path");
const { projectContexts } = require("./compiler-contexts");
const { DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS, MAX_ANALYSIS_BYTES, decodeCompilerSourceBuffer } = require("./compiler-analysis");
const { nativeIdentity, declarationKey } = require("./compiler-project-bindings");
const { runProjectTransaction, verifyProjectSources, validateRenameName } = require("./compiler-project-transaction");
const { normalizeIdentifier, parseFreeBasicText } = require("./freebasic-parser");
const { tokenize } = require("./semantic-model");

function sameBuffers(first, second) {
    return first.size === second.size && [...first].every(([file, text]) => second.get(file) === text);
}

function maskedRemIdentifierAt(document, position) {
    if (typeof document?.lineAt !== "function" || typeof document?.offsetAt !== "function" ||
        typeof document?.getText !== "function") return false;
    const lineText = document.lineAt(position.line)?.text;
    if (typeof lineText !== "string") return false;
    const match = [...lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)].find((candidate) =>
        candidate[0].toUpperCase() === "REM" && position.character >= candidate.index &&
        position.character < candidate.index + candidate[0].length
    );
    if (!match || tokenize(lineText).tokens.some((token) =>
        token.startColumn === match.index && token.endColumn === match.index + match[0].length
    )) return false;
    const tokenOffset = document.offsetAt({ line: position.line, character: match.index });
    return /(?:^|\r?\n)\s*option\s+nokeyword\b[^\r\n]*\brem\b/i.test(
        document.getText().slice(0, tokenOffset)
    );
}

class CompilerProject {
    // An injected analyzer exercises the same transaction without a worker in
    // fault-injection tests. Production always uses the service-owned worker.
    constructor(vscode, service, analyze = null) { this.vscode = vscode; this.service = service; this.analyze = analyze; }

    contextSignature(uri, root) {
        const configuration = this.vscode.workspace.getConfiguration("freebasic", uri);
        return JSON.stringify([this.service.contextFor(uri).signature, projectContexts(configuration, root), configuration.get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS)]);
    }

    hasProjectContexts(uri) {
        const compiler = this.service.analysisCompilerFor?.(uri);
        if (!compiler?.compilerPath || !compiler.semanticModelOnly && !this.service.compilerPathFor?.(uri)) return false;
        const root = this.vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
        if (!root) return false;
        try {
            return projectContexts(this.vscode.workspace.getConfiguration("freebasic", uri), root).length > 0;
        } catch {
            return false;
        }
    }

    async target(document, position, token, allowStockSidecar = false, needSemanticMacroBindings = false) {
        const compiler = this.service.analysisCompilerFor?.(document.uri);
        const bridgePath = this.service.compilerPathFor?.(document.uri);
        if (this.service.compilerPathFor && !bridgePath &&
            !(allowStockSidecar && compiler?.semanticModelOnly)) {
            throw new Error("Compiler project refactoring requires the editor bridge. Configure freebasic.analysis.compilerPath first.");
        }
        const configuration = this.vscode.workspace.getConfiguration("freebasic", document.uri);
        const root = this.vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        if (!root) throw new Error("Compiler refactoring requires a workspace folder.");
        const jobs = projectContexts(configuration, root);
        const signature = this.contextSignature(document.uri, root);
        if (token?.isCancellationRequested) throw new Error("Compiler refactoring was cancelled.");
        const stockSidecar = allowStockSidecar && compiler?.semanticModelOnly === true;
        const needCompilerBindings = stockSidecar || maskedRemIdentifierAt(document, position);
        let model = needCompilerBindings
            ? await this.service.getModelForEditor?.(document, token, false, true, needSemanticMacroBindings)
            : this.service.getModel(document.uri);
        let native = null;
        this.service.contextFor(document.uri);
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!model) {
                if (needCompilerBindings) model = await this.service.getModelForEditor?.(
                    document, token, false, true, needSemanticMacroBindings
                );
                else if (await this.service.check(document, false, token)) model = this.service.getModel(document.uri);
            }
            if (model?.partial) throw new Error("Compiler refactoring requires an error-free current module; provisional recovery bindings cannot select a rename target.");
            if (model?.remote) {
                native = await model.query("target", document.uri, { position }, token);
                if (stockSidecar && native) {
                    const entries = await model.query("definition", document.uri, { position }, token);
                    native = { ...native, entries: Array.isArray(entries) ? entries : [] };
                }
            } else {
                native = null;
            }
            const stale = this.service.getModel(document.uri) !== model;
            const missingNativeTarget = !native || !native.entries?.length;
            if (!model?.remote || attempt || !stale && !missingNativeTarget) break;
            /*
                A project transaction releases retained worker models before it
                returns its preview. The worker's eviction notice can therefore
                trail the next provider request. Refresh once only when that
                stale-model condition is observed. An empty native target just
                after the transaction can have the same cause when a macro
                projection query beats the eviction notice. A genuine unresolved
                symbol gets one fresh query, then remains unresolved.
            */
            model = null;
        }
        const targets = model?.remote ? native?.entries || [] : model?.resolveAt(document.uri, position.line, position.character) || [];
        const occurrence = model?.remote ? native?.occurrence : model?.tokenAt(document.uri, position.line, position.character)?.token;
        if (targets.length !== 1 || !nativeIdentity(targets[0])) throw new Error("Compiler project rename requires one directly represented native symbol.");
        let selectedKey = declarationKey(targets[0]);
        if (!selectedKey && model.remote && document.uri.scheme === "file" &&
            targets[0].uri.scheme === "freebasic-preprocessed" &&
            Number.isSafeInteger(targets[0].compilerSymbolId) && targets[0].compilerSymbolId > 0 &&
            occurrence?.kind === "identifier" &&
            occurrence.name.toLowerCase() === targets[0].name.toLowerCase()) {
            /* A macro-generated symbol has no physical declaration token. Its
               compiler-bound direct reference is a safe temporary family
               anchor; transaction validation must still find the generated
               declaration and every editable macro contribution. */
            const startColumn = occurrence.endColumn - targets[0].name.length;
            if (startColumn >= 0) selectedKey = `${document.uri.fsPath}:${occurrence.line}:${startColumn}`;
        }
        if (!selectedKey) throw new Error("Compiler project rename requires one directly represented native symbol.");
        if (signature !== this.contextSignature(document.uri, root)) throw new Error("Compiler project contexts changed while selecting the rename target.");
        return {
            entry: targets[0], occurrence, selectedKey, root, jobs, configuration, signature,
            compilerPath: compiler?.compilerPath || bridgePath || "",
            semanticModelOnly: compiler?.semanticModelOnly === true
        };
    }

    async prepare(document, position, token) {
        const { entry, occurrence } = await this.target(document, position, token);
        const suffixLength = /[$%!#&]$/.test(occurrence.name) && !/[$%!#&]$/.test(entry.name) ? 1 : 0;
        const placeholder = suffixLength ? occurrence.name.slice(0, -suffixLength) : occurrence.name;
        return { range: new this.vscode.Range(occurrence.line, occurrence.startColumn, occurrence.line, occurrence.endColumn - suffixLength), placeholder };
    }

    async projectOccurrences(document, position, includeDeclaration, declarationsOnly, token,
        semanticMacroReferences = false) {
        const selected = await this.target(document, position, token, true, semanticMacroReferences);
        const controller = new AbortController();
        const subscription = token?.onCancellationRequested?.(() => controller.abort());
        const generation = this.service.generation;
        const buffers = this.service.captureBuffers();
        const cancelled = () => {
            if (token?.isCancellationRequested || controller.signal.aborted || generation !== this.service.generation ||
                !this.vscode.workspace.isTrusted) throw new Error("Compiler references were cancelled or their inputs changed.");
            if (selected.signature !== this.contextSignature(document.uri, selected.root)) {
                throw new Error("Compiler project contexts changed during reference analysis.");
            }
        };
        const options = {
            compilerPath: selected.compilerPath || this.service.compilerPathFor?.(document.uri) ||
                selected.configuration.get("analysis.compilerPath", ""),
            semanticModelOnly: selected.semanticModelOnly,
            jobs: selected.jobs,
            root: selected.root,
            selectedKey: selected.selectedKey,
            oldName: selected.entry.name,
            newName: selected.entry.name,
            referencesOnly: true,
            semanticMacroReferences: semanticMacroReferences === true,
            includeDeclaration: includeDeclaration === true,
            declarationsOnly: declarationsOnly === true,
            overlays: buffers,
            signal: controller.signal,
            timeoutMs: selected.configuration.get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS)
        };
        const worker = this.service.analysisWorker;
        let reply;
        try {
            cancelled();
            if (this.analyze || !worker) {
                reply = await runProjectTransaction(options, this.analyze || this.service.analyze,
                    cancelled, (message) => this.service.output.appendLine(message));
                cancelled();
                verifyProjectSources(reply.verification, this.service.captureBuffers(), cancelled);
            } else {
                reply = await worker.project(options);
                cancelled();
                const currentBuffers = this.service.captureBuffers();
                await worker.verifyProject(reply.projectId, currentBuffers, controller.signal);
                cancelled();
                if (!sameBuffers(currentBuffers, this.service.captureBuffers())) {
                    throw new Error("Editor buffers changed during reference analysis.");
                }
            }
            if (!Array.isArray(reply.references)) return null;
            return { records: reply.references, buffers, selected };
        } finally {
            if (reply?.projectId) worker.discardProject(reply.projectId);
            subscription?.dispose();
            controller.abort();
        }
    }

    async references(document, position, includeDeclaration = false, token, semanticMacroReferences = false) {
        const result = await this.projectOccurrences(document, position, includeDeclaration, false, token,
            semanticMacroReferences);
        if (!result) return null;
        return result.records.map((entry) => new this.vscode.Location(
            this.vscode.Uri.file(entry.filePath), new this.vscode.Range(
                entry.occurrence.line, entry.occurrence.startColumn,
                entry.occurrence.endLine ?? entry.occurrence.line, entry.occurrence.endColumn
            )
        ));
    }

    async navigation(document, position, operation, token) {
        if (!["definition", "declaration", "implementation"].includes(operation)) return null;
        const result = await this.projectOccurrences(document, position, true, true, token);
        if (!result) return null;
        const selectedType = result.selected.entry.declaration.type;
        const callableTypes = new Set(["sub", "function", "property", "operator", "constructor", "destructor"]);
        if (operation === "implementation" && !callableTypes.has(selectedType)) return [];

        const parsedSources = new Map();
        const declarations = [];
        for (const entry of result.records) {
            if (entry.kind !== "declaration" || entry.physicalBinding !== true ||
                typeof entry.filePath !== "string" || !path.isAbsolute(entry.filePath)) continue;
            let parsed = parsedSources.get(entry.filePath);
            if (!parsedSources.has(entry.filePath)) {
                let text = result.buffers.get(entry.filePath);
                try {
                    if (text === undefined) {
                        if (fs.statSync(entry.filePath).size > MAX_ANALYSIS_BYTES) continue;
                        text = decodeCompilerSourceBuffer(fs.readFileSync(entry.filePath), entry.filePath);
                    }
                    parsed = parseFreeBasicText(text).declarations;
                } catch {
                    parsed = null;
                }
                parsedSources.set(entry.filePath, parsed);
            }
            const name = normalizeIdentifier(entry.name);
            const matches = (parsed || []).filter((declaration) =>
                declaration.line === entry.occurrence.line &&
                declaration.startColumn === entry.occurrence.startColumn &&
                declaration.endColumn >= entry.occurrence.endColumn &&
                normalizeIdentifier(declaration.name) === name);
            const declaration = matches.length === 1 ? matches[0] : null;
            declarations.push({
                entry,
                type: declaration?.type || selectedType,
                modifiers: declaration ? declaration.modifiers : null
            });
        }

        const callable = declarations.filter((entry) => callableTypes.has(entry.type));
        const implementations = callable.filter((entry) =>
            Array.isArray(entry.modifiers) && !entry.modifiers.includes("DECLARE"));
        let selected = declarations;
        if (operation === "implementation") selected = implementations;
        else if (operation === "definition" && callable.length && implementations.length) selected = implementations;
        else if (operation === "declaration" && callable.length) {
            const prototypes = callable.filter((entry) => entry.modifiers?.includes("DECLARE"));
            if (prototypes.length) selected = prototypes;
        }

        const locations = new Map();
        for (const item of selected) {
            const entry = item.entry;
            const key = `${entry.filePath}:${entry.occurrence.line}:${entry.occurrence.startColumn}:${entry.occurrence.endColumn}`;
            if (locations.has(key)) continue;
            locations.set(key, new this.vscode.Location(
                this.vscode.Uri.file(entry.filePath), new this.vscode.Range(
                    entry.occurrence.line, entry.occurrence.startColumn,
                    entry.occurrence.endLine ?? entry.occurrence.line, entry.occurrence.endColumn
                )
            ));
        }
        return [...locations.values()];
    }

    async rename(document, position, newName, token) {
        const selected = await this.target(document, position, token);
        const oldName = selected.entry.name;
        validateRenameName(oldName, newName);
        const controller = new AbortController();
        const subscription = token?.onCancellationRequested?.(() => controller.abort());
        const generation = this.service.generation;
        const buffers = this.service.captureBuffers();
        const cancelled = () => {
            if (token?.isCancellationRequested || controller.signal.aborted || generation !== this.service.generation || !this.vscode.workspace.isTrusted) throw new Error("Compiler refactoring was cancelled or its inputs changed.");
            if (selected.signature !== this.contextSignature(document.uri, selected.root)) throw new Error("Compiler project contexts changed during refactoring.");
        };
        const options = { compilerPath: this.service.compilerPathFor?.(document.uri) || selected.configuration.get("analysis.compilerPath", ""), jobs: selected.jobs, root: selected.root, selectedKey: selected.selectedKey, oldName, newName, overlays: buffers, signal: controller.signal, timeoutMs: selected.configuration.get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS) };
        const worker = this.service.analysisWorker;
        let reply;
        try {
            cancelled();
            if (this.analyze || !worker) {
                reply = await runProjectTransaction(options, this.analyze || this.service.analyze, cancelled, (message) => this.service.output.appendLine(message));
                cancelled();
                verifyProjectSources(reply.verification, this.service.captureBuffers(), cancelled);
            } else {
                reply = await worker.project(options);
                cancelled();
                const currentBuffers = this.service.captureBuffers();
                await worker.verifyProject(reply.projectId, currentBuffers, controller.signal);
                cancelled();
                if (!sameBuffers(currentBuffers, this.service.captureBuffers())) throw new Error("Editor buffers changed during refactoring.");
            }
            const result = new this.vscode.WorkspaceEdit();
            for (const file of reply.edits) for (const occurrence of file.occurrences) {
                result.replace(this.vscode.Uri.file(file.filePath), new this.vscode.Range(occurrence.line, occurrence.startColumn, occurrence.line, occurrence.endColumn), occurrence.newText || file.newText);
            }
            if (reply.workerStats) this.service.output.appendLine(`Compiler project worker ${reply.workerStats.threadId}: ${Math.round(reply.workerStats.roundTripMs)} ms, ${reply.units} contexts, ${reply.compilerPasses} compiler passes.`);
            return result;
        } finally {
            if (reply?.projectId) worker.discardProject(reply.projectId);
            subscription?.dispose();
            controller.abort();
        }
    }
}

module.exports = { CompilerProject, projectContexts };

/* end of lib/compiler-project.js */
