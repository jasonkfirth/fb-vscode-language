/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/workspace-index.js

    Purpose:

        Maintain one reusable analysis cache for FreeBASIC documents in the
        active VS Code workspace.

    Responsibilities:

        - cache parsed documents by URI and version
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

const DEFAULT_MAX_WORKSPACE_FILES = 5000;

/* ------------------------------------------------------------------------- */
/* Workspace cache                                                           */
/* ------------------------------------------------------------------------- */

class FreeBasicWorkspaceIndex {
    constructor(vscode, languageId) {
        this.vscode = vscode;
        this.languageId = languageId;
        this.documents = new Map();
        this.symbols = new Map();
        this.initializationPromise = null;
        this.generation = 0;
    }

    getParsedDocument(document) {
        const uriKey = document.uri.toString();
        const cached = this.documents.get(uriKey);

        if (cached && cached.version === document.version) {
            return cached.parsed;
        }

        const parsed = parseFreeBasicText(document.getText());
        this.replaceDocument(uriKey, document.uri, document.version, parsed);
        return parsed;
    }

    async ensureInitialized(token) {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        const generation = this.generation;
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

    async initialize(token, generation) {
        const configuration = this.vscode.workspace.getConfiguration("freebasic");
        const maxFiles = Math.max(
            1,
            configuration.get("index.maxFiles", DEFAULT_MAX_WORKSPACE_FILES)
        );
        const exclude = configuration.get(
            "index.exclude",
            "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}"
        );
        const uris = await this.vscode.workspace.findFiles(
            "**/*.{bas,bi,BAS,BI}",
            exclude,
            maxFiles
        );

        for (const uri of uris) {
            if (generation !== this.generation || (token && token.isCancellationRequested)) {
                return false;
            }

            await this.refreshUri(uri, generation);
        }
        return generation === this.generation;
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

    async refreshUri(uri, expectedGeneration = this.generation) {
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
            if (expectedGeneration === this.generation) {
                const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
                const parsed = parseFreeBasicText(text);
                this.replaceDocument(uri.toString(), uri, null, parsed);
            }
        } catch (error) {
            if (expectedGeneration === this.generation) {
                /* The file can disappear between discovery and the read. */
                this.removeUri(uri);
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
        if (!this.documents.has(uriKey)) {
            return;
        }

        this.removeSymbolsForUri(uriKey);
        this.documents.delete(uriKey);
    }

    invalidateWorkspace() {
        this.generation++;
        this.documents.clear();
        this.symbols.clear();
        this.initializationPromise = null;
    }

    replaceDocument(uriKey, uri, version, parsed) {
        this.removeSymbolsForUri(uriKey);
        const symbolKeys = new Set();

        for (const declaration of parsed.declarations) {
            symbolKeys.add(this.addSymbol(uriKey, uri, declaration.name, declaration));

            if (normalizeIdentifier(declaration.qualifiedName) !== normalizeIdentifier(declaration.name)) {
                symbolKeys.add(this.addSymbol(uriKey, uri, declaration.qualifiedName, declaration));
            }
        }

        this.documents.set(uriKey, { parsed, symbolKeys, uri, version });
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
