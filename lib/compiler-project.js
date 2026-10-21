/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-project.js
    Purpose: Adapt compiler-bound project navigation and renames for VS Code.
    Responsibilities: capture editor context, reject stale replies, return locations/edits.
    Does not contain: native graph construction, source writes, or implicit workspace discovery.
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

function publicationBuffersMatch(first, second, consumedIndices) {
    if (sameBuffers(first, second)) return true;
    if (!Array.isArray(consumedIndices) || consumedIndices.length > first.size) return false;
    const paths = [...first.keys()];
    if (consumedIndices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= paths.length) ||
        new Set(consumedIndices).size !== consumedIndices.length) return false;
    // Only closures of compiler-unconsumed buffers may trail verification.
    // Edits, new buffers, and consumed closures retain the final host guard.
    for (const [file, text] of second) if (!first.has(file) || first.get(file) !== text) return false;
    return consumedIndices.every((index) => second.has(paths[index]));
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
    const tokenOffset = document.offsetAt(position) - position.character + match.index;
    return /(?:^|\r?\n)\s*option\s+nokeyword\b[^\r\n]*\brem\b/i.test(
        document.getText().slice(0, tokenOffset)
    );
}

class CompilerProject {
    // An injected analyzer exercises the same transaction without a worker in
    // fault-injection tests. Production always uses the service-owned worker.
    constructor(vscode, service, analyze = null) { this.vscode = vscode; this.service = service; this.analyze = analyze; }

    contextJobs(uri, root, callHierarchy = false) {
        const configuration = this.vscode.workspace.getConfiguration("freebasic", uri);
        if (callHierarchy && configuration.get("analysis.run", "onDemand") === "off") {
            throw new Error("Native Call Hierarchy is disabled while analysis.run is off.");
        }
        const configured = configuration.get("analysis.projectContexts", []);
        if (callHierarchy && Array.isArray(configured) && configured.length === 0) {
            // Read-only hierarchy needs only the current translation unit.
            // Rename and project references still require explicit contexts;
            // invalid configured contexts never silently become a local scan.
            const context = this.service.contextFor(uri);
            return [{ name: context.name ?? "current", filePath: context.filePath,
                compilerArguments: [...context.compilerArguments] }];
        }
        return projectContexts(configuration, root);
    }

    contextSignature(uri, root, callHierarchy = false) {
        const configuration = this.vscode.workspace.getConfiguration("freebasic", uri);
        return JSON.stringify([this.service.contextFor(uri).signature, this.contextJobs(uri, root, callHierarchy), configuration.get("analysis.timeoutMs", DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS)]);
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

    hasCallHierarchyContext(uri) {
        if (uri?.scheme !== "file" || !uri.fsPath || this.vscode.workspace.isTrusted === false) return false;
        const compiler = this.service.analysisCompilerFor?.(uri);
        if (!compiler?.compilerPath || !compiler.semanticModelOnly && !this.service.compilerPathFor?.(uri)) return false;
        const root = this.vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || path.dirname(uri.fsPath);
        try { return this.contextJobs(uri, root, true).length > 0; }
        catch { return false; }
    }

    async target(document, position, token, allowStockSidecar = false, needSemanticMacroBindings = false,
        lifetimeReferences = false, operatorOrigin = null, typeHierarchy = false, baseMethod = false, outgoingCalls = false, callHierarchy = false,
        contextDocument = null, moduleOutgoing = false) {
        if (moduleOutgoing && (!callHierarchy || !outgoingCalls || document.uri.scheme !== "file" || !document.uri.fsPath)) {
            throw new Error("Module outgoing projection requires a named source and a read-only hierarchy request.");
        }
        // Only read-only hierarchy may carry a known module for a header.
        // Refactoring keeps its original explicit-context boundary.
        const analysisDocument = callHierarchy && contextDocument ? contextDocument : document;
        const contextUri = analysisDocument.uri;
        const compiler = this.service.analysisCompilerFor?.(contextUri);
        const bridgePath = this.service.compilerPathFor?.(contextUri);
        if (this.service.compilerPathFor && !bridgePath &&
            !(allowStockSidecar && compiler?.semanticModelOnly)) {
            throw new Error("Compiler project refactoring requires the editor bridge. Configure freebasic.analysis.compilerPath first.");
        }
        const configuration = this.vscode.workspace.getConfiguration("freebasic", contextUri);
        const root = this.vscode.workspace.getWorkspaceFolder(contextUri)?.uri.fsPath ||
            (callHierarchy && contextUri.scheme === "file" && contextUri.fsPath ? path.dirname(contextUri.fsPath) : null);
        if (!root) throw new Error("Compiler refactoring requires a workspace folder.");
        const jobs = this.contextJobs(contextUri, root, callHierarchy);
        const signature = this.contextSignature(contextUri, root, callHierarchy);
        if (token?.isCancellationRequested) throw new Error("Compiler refactoring was cancelled.");
        const stockSidecar = allowStockSidecar && compiler?.semanticModelOnly === true;
        const needCompilerBindings = moduleOutgoing || Boolean(operatorOrigin) || lifetimeReferences || typeHierarchy || baseMethod || stockSidecar || maskedRemIdentifierAt(document, position);
        let model = needCompilerBindings
            ? await this.service.getModelForEditor?.(analysisDocument, token, false, true, needSemanticMacroBindings)
            : this.service.getModel(contextUri);
        let native = null;
        this.service.contextFor(contextUri);
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!model) {
                if (needCompilerBindings) model = await this.service.getModelForEditor?.(
                    analysisDocument, token, false, true, needSemanticMacroBindings
                );
                else if (await this.service.check(analysisDocument, false, token)) model = this.service.getModel(contextUri);
            }
            if (model?.partial) throw new Error("Compiler refactoring requires an error-free current module; provisional recovery bindings cannot select a rename target.");
            if (model?.remote) {
                if (moduleOutgoing) {
                    const valid = await model.query("validate", document.uri, {}, token, contextUri);
                    native = { occurrence: null, entries: valid === true ? [{ name: path.basename(document.uri.fsPath),
                        uri: document.uri, declaration: { type: "module", line: 0, startColumn: 0, endColumn: 0, modifiers: [] } }] : [] };
                } else if (operatorOrigin) {
                    // Re-resolve a physical native header after acquisition;
                    // never carry an operator's model-local ID into a new pass.
                    const originUri = this.vscode.Uri.file(operatorOrigin.filePath);
                    const selected = await model.query("compilerSidecarOperatorDeclarationAt", document.uri, {
                        position: { line: 0, character: 0 }, declarationOrigin: operatorOrigin,
                        kind: operatorOrigin.kind
                    }, token, contextUri);
                    const origin = selected?.origin;
                    native = { occurrence: null, entries: origin && selected.targetSymbols?.length === 1 ? [{
                        name: "operator", uri: originUri, compilerSymbolId: selected.targetSymbols[0],
                        declaration: { type: "operator", line: origin.startLine - 1,
                            endColumn: origin.startColumn + "operator".length }
                    }] : [] };
                } else if (typeHierarchy) {
                    const entries = await model.query("typeHierarchyPrepare", document.uri, { position }, token, contextUri);
                    native = { occurrence: null, entries: Array.isArray(entries) ? entries : [] };
                } else if (baseMethod) {
                    // Select the immediate native parent inside the original
                    // translation unit, without borrowing a header's context.
                    const entries = await model.query("baseDefinition", document.uri, { position }, token, contextUri);
                    native = { occurrence: null, entries: Array.isArray(entries) ? entries : [] };
                } else native = await model.query(lifetimeReferences ? "lifetimeReferenceTarget" : "target", document.uri, {
                    position, ...(lifetimeReferences && callHierarchy ? { declarationAtPosition: true } : {})
                }, token, contextUri);
                if (stockSidecar && native && !moduleOutgoing && !lifetimeReferences && !operatorOrigin && !typeHierarchy && !baseMethod) {
                    const entries = await model.query("definition", document.uri, { position }, token, contextUri);
                    native = { ...native, entries: Array.isArray(entries) ? entries : [] };
                }
            } else {
                native = null;
            }
            const stale = this.service.getModel(contextUri) !== model;
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
        if (targets.length !== 1 || !moduleOutgoing && !nativeIdentity(targets[0])) throw new Error("Compiler project rename requires one directly represented native symbol.");
        let selectedKey = moduleOutgoing ? "" : declarationKey(targets[0]);
        if (!selectedKey && !moduleOutgoing && model.remote && document.uri.scheme === "file" &&
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
        if (!selectedKey && !moduleOutgoing) throw new Error("Compiler project rename requires one directly represented native symbol.");
        if (signature !== this.contextSignature(contextUri, root, callHierarchy)) throw new Error("Compiler project contexts changed while selecting the rename target.");
        return {
            entry: targets[0], occurrence, selectedKey, root, jobs, configuration, signature, contextUri,
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
        semanticMacroReferences = false, lifetimeReferences = false, operatorOrigin = null, includeOverrides = false,
        typeHierarchy = "", baseMethod = false, incomingCalls = false, outgoingCalls = false, contextDocument = null, moduleOutgoing = false) {
        const callHierarchy = incomingCalls || outgoingCalls;
        const contextVersion = contextDocument?.version;
        const selected = await this.target(document, position, token, true, semanticMacroReferences, lifetimeReferences, operatorOrigin,
            Boolean(typeHierarchy), baseMethod, outgoingCalls, callHierarchy, contextDocument, moduleOutgoing);
        if (incomingCalls && !["sub", "function", "property"].includes(selected.entry.declaration.type) &&
            !(lifetimeReferences && ["constructor", "destructor"].includes(selected.entry.declaration.type)) &&
            !(operatorOrigin && selected.entry.declaration.type === "operator")) return null;
        if (outgoingCalls && !["sub", "function", "property", "constructor", "destructor", "operator"].includes(selected.entry.declaration.type) &&
            !(moduleOutgoing && selected.entry.declaration.type === "module")) return null;
        if (outgoingCalls && (selected.entry.declaration.modifiers?.includes("DECLARE") ||
            selected.entry.uri.fsPath !== document.uri.fsPath || operatorOrigin && operatorOrigin.kind !== "procedure-definition")) return null;
        let jobs = selected.jobs;
        if (declarationsOnly || incomingCalls || outgoingCalls) {
            // References cover every configured build; a jump must not choose
            // a body from a different build than the one that selected the call.
            const context = this.service.contextFor(selected.contextUri);
            jobs = jobs.filter((job) => context.name !== null ? job.name === context.name
                : JSON.stringify(job.compilerArguments) === JSON.stringify(context.compilerArguments));
            if (!jobs.length) return null;
        }
        if (outgoingCalls) jobs = jobs.filter((job) => job.filePath === this.service.contextFor(selected.contextUri).filePath);
        if (!jobs.length) return null;
        const controller = new AbortController();
        const subscription = token?.onCancellationRequested?.(() => controller.abort());
        const generation = this.service.generation;
        const buffers = this.service.captureBuffers();
        const cancelled = () => {
            if (token?.isCancellationRequested || controller.signal.aborted || generation !== this.service.generation ||
                !this.vscode.workspace.isTrusted) throw new Error("Compiler references were cancelled or their inputs changed.");
            if (callHierarchy && contextDocument && (contextDocument.isClosed || contextDocument.version !== contextVersion)) {
                throw new Error("The hierarchy module context changed during analysis.");
            }
            if (selected.signature !== this.contextSignature(selected.contextUri, selected.root, callHierarchy)) {
                throw new Error("Compiler project contexts changed during reference analysis.");
            }
        };
        const options = {
            compilerPath: selected.compilerPath || this.service.compilerPathFor?.(document.uri) ||
                selected.configuration.get("analysis.compilerPath", ""),
            semanticModelOnly: selected.semanticModelOnly,
            jobs,
            root: selected.root,
            selectedKey: selected.selectedKey,
            oldName: selected.entry.name,
            newName: selected.entry.name,
            referencesOnly: true,
            lifetimeReferences: lifetimeReferences === true ? selected.entry.declaration.type : "",
            operatorReferences: Boolean(operatorOrigin),
            procedureReferences: !declarationsOnly && !callHierarchy && ["sub", "function", "property"].includes(selected.entry.declaration.type),
            semanticMacroReferences: semanticMacroReferences === true,
            includeDeclaration: includeDeclaration === true,
            declarationsOnly: declarationsOnly === true,
            includeOverrides: includeOverrides === true,
            typeHierarchy,
            incomingCalls: incomingCalls === true,
            outgoingCalls: outgoingCalls === true,
            moduleOutgoingFile: moduleOutgoing ? document.uri.fsPath : "",
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
                const verified = await worker.verifyProject(reply.projectId, currentBuffers, controller.signal);
                cancelled();
                if (!publicationBuffersMatch(currentBuffers, this.service.captureBuffers(), verified.consumedBufferIndices)) {
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

    async references(document, position, includeDeclaration = false, token, semanticMacroReferences = false,
        lifetimeReferences = false, operatorOrigin = null) {
        const result = await this.projectOccurrences(document, position, includeDeclaration, false, token,
            semanticMacroReferences, lifetimeReferences, operatorOrigin);
        if (!result) return null;
        return result.records.map((entry) => new this.vscode.Location(
            this.vscode.Uri.file(entry.filePath), new this.vscode.Range(
                entry.occurrence.line, entry.occurrence.startColumn,
                entry.occurrence.endLine ?? entry.occurrence.line, entry.occurrence.endColumn
            )
        ));
    }

    async subtypes(document, position, token, transitive = false) {
        const result = await this.projectOccurrences(document, position, true, true, token,
            false, false, null, false, transitive ? "transitive" : "direct");
        if (!result) return null;
        // Only native inheritance edges select these declarations. The
        // physical binding supplies their display name and selection range.
        return result.records.filter((entry) => entry.kind === "declaration" && entry.physicalBinding === true)
            .map((entry) => ({ name: entry.name, uri: this.vscode.Uri.file(entry.filePath),
                declaration: { type: "type", line: entry.occurrence.line,
                    startColumn: entry.occurrence.startColumn, endColumn: entry.occurrence.endColumn,
                    signature: `Type ${entry.name}` } }));
    }

    async incomingCalls(document, position, token, contextDocument = null, procedureKind = "", operatorOrigin = null) {
        const lifetime = ["constructor", "destructor"].includes(procedureKind);
        const result = await this.projectOccurrences(document, position, false, false, token,
            false, lifetime, operatorOrigin, false, "", false, true, false, contextDocument);
        if (!result) return null;
        const callers = new Map();
        for (const site of result.records) {
            const caller = site.caller;
            if (!caller?.uri?.fsPath || !caller.declaration) return null;
            const declaration = caller.declaration;
            const key = `${caller.uri.fsPath}:${declaration.line}:${declaration.startColumn}:${declaration.type}`;
            const group = callers.get(key) || { ...caller, uri: this.vscode.Uri.file(caller.uri.fsPath), fromRanges: [] };
            group.fromRanges.push(site.occurrence);
            callers.set(key, group);
        }
        return [...callers.values()];
    }

    async moduleOutgoingCalls(document, token = null, contextDocument = null) {
        return this.outgoingCalls(document, { line: 0, character: 0 }, token, "", null, contextDocument, true);
    }

    async outgoingCalls(document, position, token, procedureKind = "", operatorOrigin = null, contextDocument = null, moduleOutgoing = false) {
        const lifetime = ["constructor", "destructor"].includes(procedureKind);
        const result = await this.projectOccurrences(document, position, false, false, token,
            false, lifetime, operatorOrigin, false, "", false, false, true, contextDocument, moduleOutgoing);
        if (!result) return null;
        const callees = new Map();
        for (const site of result.records) {
            const callee = site.callee;
            // Outgoing ranges belong to the item's file, not a body found in
            // another module. Header-only items retain their existing path.
            if (site.filePath !== document.uri.fsPath || !callee?.uri?.fsPath || !callee.declaration) return null;
            const declaration = callee.declaration;
            const key = `${callee.uri.fsPath}:${declaration.line}:${declaration.startColumn}:${declaration.type}`;
            const group = callees.get(key) || { ...callee, uri: this.vscode.Uri.file(callee.uri.fsPath), fromRanges: [] };
            group.fromRanges.push(site.occurrence);
            callees.set(key, group);
        }
        return [...callees.values()];
    }

    async operatorReferences(document, origin, includeDeclaration, token) {
        if (!origin || typeof origin.filePath !== "string" || !path.isAbsolute(origin.filePath) ||
            !["procedure-prototype", "procedure-definition"].includes(origin.kind) ||
            !Number.isSafeInteger(origin.startLine) || origin.startLine < 1 ||
            !Number.isSafeInteger(origin.startColumn) || origin.startColumn < 0) return null;
        // Selection is the verified header, not an editable token in this root.
        return this.references(document, { line: 0, character: 0 }, includeDeclaration, token, false, false, origin);
    }

    async operatorNavigation(document, origin, operation, token) {
        if (!origin || typeof origin.filePath !== "string" || !path.isAbsolute(origin.filePath) ||
            !["procedure-prototype", "procedure-definition"].includes(origin.kind) ||
            !Number.isSafeInteger(origin.startLine) || origin.startLine < 1 ||
            !Number.isSafeInteger(origin.startColumn) || origin.startColumn < 0) return null;
        return this.navigation(document, { line: 0, character: 0 }, operation, token, origin);
    }

    async lifetimeNavigation(document, position, operation, token) {
        return this.navigation(document, position, operation, token, null, true);
    }

    async baseMethodNavigation(document, position, token) {
        return this.navigation(document, position, "definition", token, null, false, true);
    }

    async navigation(document, position, operation, token, operatorOrigin = null, lifetimeReferences = false, baseMethod = false) {
        if (!["definition", "declaration", "implementation"].includes(operation)) return null;
        const result = await this.projectOccurrences(document, position, true, true, token, false, lifetimeReferences, operatorOrigin,
            operation === "implementation", "", baseMethod);
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
            const lifetimeKeyword = ["constructor", "destructor"].includes(selectedType) && name === selectedType;
            const matches = (parsed || []).filter((declaration) => {
                if (declaration.line !== entry.occurrence.line || declaration.endColumn < entry.occurrence.endColumn) return false;
                if (lifetimeKeyword && declaration.type === selectedType) return true;
                if (declaration.startColumn === entry.occurrence.startColumn && normalizeIdentifier(declaration.name) === name) return true;
                // The compiler binds Adjust in Api.Worker.Adjust, while the
                // parser's name span includes qualification. This is only role
                // presentation for an already-bound declaration, not name lookup.
                const declaredName = String(declaration.name || "");
                const terminal = declaredName.split(".").at(-1);
                return ["sub", "function", "property"].includes(declaration.type) && declaredName.includes(".") &&
                    declaration.endColumn - terminal.length === entry.occurrence.startColumn && normalizeIdentifier(terminal) === name;
            });
            const declaration = matches.length === 1 ? matches[0] : null;
            declarations.push({
                // Lifetime reference anchors are keywords. Present the proven
                // header's type/name span for a jump, not its family-key token.
                entry: lifetimeKeyword && declaration ? { ...entry, occurrence: {
                    ...entry.occurrence, startColumn: declaration.startColumn, endColumn: declaration.endColumn
                } } : entry,
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
                const verified = await worker.verifyProject(reply.projectId, currentBuffers, controller.signal);
                cancelled();
                if (!publicationBuffersMatch(currentBuffers, this.service.captureBuffers(), verified.consumedBufferIndices)) throw new Error("Editor buffers changed during refactoring.");
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
