/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/workspace-index.js

    Purpose:

        Maintain one reusable analysis cache for FreeBASIC documents in the
        active VS Code workspace.

    Responsibilities:

        - cache parsed documents by URI, document lifetime, and version
        - index simple and qualified declaration names
        - update the index when documents or files change
        - expose bounded workspace declaration and occurrence queries

    This file intentionally does NOT contain:

        - parsing rules
        - provider presentation logic
        - compiler execution
*/

const {
    normalizeIdentifier,
    parseFreeBasicText
} = require("./freebasic-parser");
const { FreeBasicSemanticModel } = require("./semantic-model");
const { resolveIncludePath } = require("./include-paths");
const { decodeCompilerSourceBuffer } = require("./compiler-analysis");

const DEFAULT_MAX_WORKSPACE_FILES = 5000;

/* ------------------------------------------------------------------------- */
/* Workspace cache                                                           */
/* ------------------------------------------------------------------------- */

class FreeBasicWorkspaceIndex {
    constructor(vscode, languageId) {
        this.vscode = vscode;
        this.languageId = languageId;
        this.documents = new Map();
        // Versions restart when VS Code reopens a document. Weak keys and empty
        // identity tokens do not retain closed buffers or old parsed trees.
        this.documentIdentities = new WeakMap();
        this.symbols = new Map();
        this.initializationPromise = null;
        this.generation = 0;
        this.semanticModel = null;
        this.pendingReads = new Map();
        this.includesDirty = true;
        this.includePromise = null;
        this.discoveryIncomplete = false;
        this.includeIncomplete = false;
        this.skippedFiles = new Set();
        this.changeEmitter = vscode.EventEmitter ? new vscode.EventEmitter() : null;
        this.onDidChangeModel = this.changeEmitter?.event;
        this.changeQueued = false;
    }

    getParsedDocument(document) {
        const uriKey = document.uri.toString();
        const cached = this.documents.get(uriKey);
        let identity = this.documentIdentities.get(document);
        if (!identity) {
            identity = {};
            this.documentIdentities.set(document, identity);
        }

        if (cached && cached.version === document.version && cached.documentIdentity === identity) {
            return cached.parsed;
        }

        const parsed = parseFreeBasicText(document.getText());
        this.replaceDocument(uriKey, document.uri, document.version, parsed, identity);
        return parsed;
    }

    async ensureInitialized(token) {
        // Initialization belongs to the first provider's cancellation token.
        // An active waiter gets one fresh attempt if that provider was cancelled
        // or its workspace generation changed. Bound retries during settings churn.
        for (let attempt = 0; attempt < 2; attempt++) {
            const generation = this.generation;
            if (this.initializationPromise) {
                const completed = await this.initializationPromise;
                if (token?.isCancellationRequested) return false;
                if (!completed || generation !== this.generation) continue;
                await this.loadIncludes(token, generation);
                if (generation !== this.generation) continue;
                return !token?.isCancellationRequested;
            }

            const initializationPromise = this.initialize(token, generation)
                .then((completed) => {
                    if (!completed && this.initializationPromise === initializationPromise) {
                        this.initializationPromise = null;
                    }
                    return completed;
                })
                .catch((error) => {
                    if (this.initializationPromise === initializationPromise) {
                        this.initializationPromise = null;
                    }
                    throw error;
                });
            this.initializationPromise = initializationPromise;
            return this.initializationPromise;
        }
        return false;
    }

    async initialize(token, generation) {
        const configuration = this.vscode.workspace.getConfiguration("freebasic");
        const maxFiles = this.getMaximumFiles();
        const exclude = configuration.get(
            "index.exclude",
            "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}"
        );
        const uris = await this.vscode.workspace.findFiles(
            "**/*.{bas,bi,BAS,BI}",
            exclude,
            maxFiles + 1
        );
        if (generation !== this.generation) return false;
        this.discoveryIncomplete = uris.length > maxFiles;

        for (const uri of uris.slice(0, maxFiles)) {
            if (generation !== this.generation || (token && token.isCancellationRequested)) {
                return false;
            }

            await this.refreshUri(uri, generation);
        }
        await this.loadIncludes(token, generation);
        return generation === this.generation && !token?.isCancellationRequested;
    }

    async loadIncludes(token, generation = this.generation) {
        if (this.includePromise) await this.includePromise;
        if (!this.includesDirty || token?.isCancellationRequested || generation !== this.generation) return;
        /* Concurrent providers share traversal. Edits during a read require another pass. */
        const pending = (async () => {
            do {
                this.includesDirty = false;
                await this.refreshIncludes(token, generation);
            } while (this.includesDirty && !token?.isCancellationRequested && generation === this.generation);
        })();
        this.includePromise = pending;
        try {
            await pending;
        } finally {
            if (this.includePromise === pending) this.includePromise = null;
        }
    }

    async refreshIncludes(token, generation) {
        const maximum = this.getMaximumFiles();
        const queue = [...this.documents.values()];
        const visited = new Set();
        this.includeIncomplete = false;
        for (let index = 0; index < queue.length; index++) {
            if (token?.isCancellationRequested || generation !== this.generation) {
                this.includesDirty = true;
                return;
            }
            const entry = queue[index];
            const key = entry.uri.toString();
            if (visited.has(key) || entry.uri.scheme && entry.uri.scheme !== "file") continue;
            visited.add(key);
            if (!entry.parsed.includes.length || !this.vscode.Uri?.file) continue;
            const includeUris = new Set();
            for (const include of entry.parsed.includes) {
                const includePath = resolveIncludePath(this.vscode, entry.uri.fsPath, include);
                if (!includePath) continue;
                const uri = this.vscode.Uri.file(includePath);
                includeUris.add(uri.toString());
                if (!this.documents.has(uri.toString()) && !this.skippedFiles.has(uri.toString())) {
                    if (this.documents.size < maximum) await this.refreshUri(uri, generation);
                    else this.includeIncomplete = true;
                }
                const dependency = this.documents.get(uri.toString());
                if (dependency && !visited.has(uri.toString())) queue.push(dependency);
            }
            if (entry.includeUris.size !== includeUris.size || [...includeUris].some((uri) => !entry.includeUris.has(uri))) {
                entry.includeUris = includeUris;
                this.semanticModel = null;
            }
        }
    }

    getMaximumFiles() {
        const value = this.vscode.workspace.getConfiguration("freebasic").get("index.maxFiles", DEFAULT_MAX_WORKSPACE_FILES);
        return Number.isInteger(value) ? Math.max(1, Math.min(100000, value)) : DEFAULT_MAX_WORKSPACE_FILES;
    }

    isIncomplete() {
        return this.discoveryIncomplete || this.includeIncomplete || this.skippedFiles.size > 0;
    }

    async findDeclarations(name, token) {
        await this.ensureInitialized(token);
        const normalizedName = normalizeIdentifier(name);
        return deduplicateDeclarationEntries(this.symbols.get(normalizedName) || []);
    }

    async findOccurrences(name, token) {
        await this.ensureInitialized(token);
        const normalizedName = normalizeIdentifier(name);
        const results = [];

        for (const entry of this.documents.values()) {
            if (token && token.isCancellationRequested) {
                break;
            }

            for (const occurrence of entry.parsed.occurrences) {
                if (normalizeIdentifier(occurrence.name) === normalizedName) {
                    results.push({ uri: entry.uri, occurrence });
                }
            }
        }

        return results;
    }

    getAllDeclarations() {
        const declarations = [];
        for (const entry of this.documents.values()) {
            for (const declaration of entry.parsed.declarations) {
                declarations.push({ uri: entry.uri, declaration });
            }
        }
        return declarations;
    }

    getSourceSemanticModel() {
        if (!this.semanticModel) this.semanticModel = new FreeBasicSemanticModel(this.documents.values());
        return this.semanticModel;
    }

    getSemanticModel(uri, options = {}) {
        const compilerModel = options.sourceOnly ? null : uri && this.compilerAnalysis?.getModel(uri);
        if (compilerModel && (options.allowSidecarOnly !== false || !compilerModel.semanticSidecarOnly)) return compilerModel;
        return this.getSourceSemanticModel();
    }

    getDependentModules(uri) {
        const affected = new Set([uri.toString()]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const entry of this.documents.values()) {
                if (affected.has(entry.uri.toString())) continue;
                if ([...entry.includeUris].some((key) => affected.has(key))) {
                    affected.add(entry.uri.toString());
                    changed = true;
                }
            }
        }
        return [...this.documents.values()].filter((entry) =>
            affected.has(entry.uri.toString()) && /\.bas$/i.test(entry.uri.fsPath || "")
        ).map((entry) => entry.uri);
    }

    includeDependencyHints(filePath) {
        if (typeof filePath !== "string" || !this.vscode.Uri?.file) return [];
        const rootKey = this.vscode.Uri.file(filePath).toString();
        const queue = [rootKey];
        const visited = new Set();
        const dependencies = [];
        for (let index = 0; index < queue.length; index++) {
            const key = queue[index];
            if (visited.has(key)) continue;
            visited.add(key);
            const entry = this.documents.get(key);
            if (!entry || entry.uri.scheme && entry.uri.scheme !== "file") continue;
            if (key !== rootKey) dependencies.push(entry.uri.fsPath);
            for (const includeUri of entry.includeUris || []) queue.push(includeUri);
        }
        return dependencies;
    }

    async refreshUri(uri, expectedGeneration = this.generation) {
        const uriKey = uri.toString();
        const readId = (this.pendingReads.get(uriKey) || 0) + 1;
        this.pendingReads.set(uriKey, readId);
        try {
            const openDocument = (this.vscode.workspace.textDocuments || [])
                .find((document) => document.uri.toString() === uri.toString());

            if (openDocument && openDocument.languageId === this.languageId) {
                if (expectedGeneration !== this.generation) {
                    return;
                }
                this.getParsedDocument(openDocument);
                return;
            }

            const bytes = await this.vscode.workspace.fs.readFile(uri);
            const latestOpenDocument = (this.vscode.workspace.textDocuments || []).find((document) => document.uri.toString() === uriKey);
            if (expectedGeneration === this.generation && this.pendingReads.get(uriKey) === readId) {
                if (latestOpenDocument?.languageId === this.languageId) {
                    this.getParsedDocument(latestOpenDocument);
                    return;
                }
                const limit = this.vscode.workspace.getConfiguration("freebasic", uri).get("index.maxFileSizeKB", 4096);
                if (bytes.length > (Number.isInteger(limit) && limit > 0 ? limit : 4096) * 1024) {
                    this.removeUri(uri);
                    this.skippedFiles.add(uriKey);
                    return;
                }
                const text = decodeCompilerSourceBuffer(Buffer.from(bytes), uri.fsPath).replace(/^\uFEFF/, "");
                const parsed = parseFreeBasicText(text);
                this.replaceDocument(uri.toString(), uri, null, parsed);
            }
        } catch (error) {
            if (expectedGeneration === this.generation && this.pendingReads.get(uriKey) === readId) {
                /* The file can disappear between discovery and the read. */
                this.removeUri(uri);
                this.skippedFiles.add(uriKey);
            }
        }
    }

    refreshDocument(document) {
        if (document.languageId === this.languageId) {
            this.getParsedDocument(document);
        }
    }

    removeUri(uri) {
        const uriKey = uri.toString();
        this.includesDirty = true;
        this.skippedFiles.delete(uriKey);
        this.pendingReads.set(uriKey, (this.pendingReads.get(uriKey) || 0) + 1);
        if (!this.documents.has(uriKey)) {
            return;
        }

        this.removeSymbolsForUri(uriKey);
        this.documents.delete(uriKey);
        this.semanticModel = null;
        this.notifyChange();
    }

    invalidateWorkspace() {
        this.generation++;
        this.documents.clear();
        this.symbols.clear();
        this.initializationPromise = null;
        this.semanticModel = null;
        this.includesDirty = true;
        this.includePromise = null;
        this.discoveryIncomplete = false;
        this.includeIncomplete = false;
        this.skippedFiles.clear();
        this.notifyChange();
    }

    replaceDocument(uriKey, uri, version, parsed, documentIdentity = null) {
        if (uri.scheme === "freebasic-preprocessed") return;
        this.semanticModel = null;
        this.includesDirty = true;
        this.skippedFiles.delete(uriKey);
        this.removeSymbolsForUri(uriKey);
        const symbolKeys = new Set();

        for (const declaration of parsed.declarations) {
            symbolKeys.add(this.addSymbol(uriKey, uri, declaration.name, declaration));

            if (normalizeIdentifier(declaration.qualifiedName) !== normalizeIdentifier(declaration.name)) {
                symbolKeys.add(this.addSymbol(uriKey, uri, declaration.qualifiedName, declaration));
            }
        }

        this.documents.set(uriKey, { parsed, symbolKeys, uri, version, documentIdentity, includeUris: new Set() });
        this.notifyChange();
    }

    notifyChange() {
        if (this.changeQueued || !this.changeEmitter) return;
        this.changeQueued = true;
        queueMicrotask(() => {
            this.changeQueued = false;
            this.changeEmitter?.fire();
        });
    }

    dispose() {
        this.changeEmitter?.dispose();
        this.changeEmitter = null;
        this.invalidateWorkspace();
    }

    addSymbol(uriKey, uri, name, declaration) {
        const normalizedName = normalizeIdentifier(name);
        const entries = this.symbols.get(normalizedName) || [];
        entries.push({ declaration, uri, uriKey });
        this.symbols.set(normalizedName, entries);
        return normalizedName;
    }

    removeSymbolsForUri(uriKey) {
        const documentEntry = this.documents.get(uriKey);
        if (!documentEntry) {
            return;
        }

        for (const name of documentEntry.symbolKeys) {
            const entries = this.symbols.get(name) || [];
            const remainingEntries = entries.filter((entry) => entry.uriKey !== uriKey);

            if (remainingEntries.length === 0) {
                this.symbols.delete(name);
            } else if (remainingEntries.length !== entries.length) {
                this.symbols.set(name, remainingEntries);
            }
        }
    }
}

/* ------------------------------------------------------------------------- */
/* Index helpers                                                             */
/* ------------------------------------------------------------------------- */

function deduplicateDeclarationEntries(entries) {
    const seen = new Set();
    const uniqueEntries = [];

    for (const entry of entries) {
        const key = `${entry.uri.toString()}:${entry.declaration.line}:${entry.declaration.startColumn}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueEntries.push(entry);
        }
    }

    return uniqueEntries;
}

module.exports = {
    DEFAULT_MAX_WORKSPACE_FILES,
    FreeBasicWorkspaceIndex,
    deduplicateDeclarationEntries
};

/* end of lib/workspace-index.js */
