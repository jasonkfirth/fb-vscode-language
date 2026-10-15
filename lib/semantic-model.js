/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/semantic-model.js

    Purpose:

        Resolve editor symbols through scopes and declared types while keeping
        the analysis independent of VS Code presentation objects.

    Responsibilities:

        - retain token positions in UTF-16 document coordinates
        - bind declarations to lexical and aggregate scopes
        - resolve namespaces, aliases, members, and inherited members
        - identify references by declaration identity

    This file intentionally does NOT contain:

        - compiler execution or macro expansion
        - speculative conversions for overload selection
        - filesystem discovery or editor UI
*/

const { maskFreeBasicText, normalizeIdentifier } = require("./freebasic-parser");

const CALLABLE_TYPES = new Set(["sub", "function", "property", "constructor", "destructor", "operator", "macro"]);
const AGGREGATE_TYPES = new Set(["type", "class", "union", "enum"]);
const BUILTIN_TYPES = new Set(["any", "boolean", "byte", "ubyte", "short", "ushort", "integer", "uinteger", "long", "ulong", "longint", "ulongint", "single", "double", "string", "wstring", "zstring", "object"]);
const KEYWORDS = new Set(require("../syntaxes/source/freebasic.grammar-source.json").keywords.map(normalizeIdentifier));

/* ------------------------------------------------------------------------- */
/* Text and token coordinates                                                */
/* ------------------------------------------------------------------------- */

function tokenize(text, remIdentifierOffsets = null, defaultEscapedStringRanges = null) {
    const masked = maskFreeBasicText(text, remIdentifierOffsets, null, defaultEscapedStringRanges);
    const lineOffsets = [0];
    for (const match of text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
    const pattern = /(?:&h[\da-f]+|&b[01]+|&o?[0-7]+|(?:\d+\.?\d*|\.\d+)(?:[ed][+-]?\d+)?)(?:ull|ul|ll|u|l|f|d|[%!&]|#(?!#))?|[a-z_][a-z\d_]*(?:[$%!&]|#(?!#))?|##|->|<>|<=|>=|[+\-*\/=<>(),.:#\[\]]/gi;
    const tokens = [];
    let line = 0;
    for (const match of masked.matchAll(pattern)) {
        while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= match.index) line++;
        const value = match[0];
        tokens.push({
            name: value,
            key: normalizeIdentifier(value),
            kind: /^[a-z_]/i.test(value) ? "identifier" : /^[\d&]/.test(value) || /^\.\d/.test(value) ? "number" : "punctuation",
            offset: match.index,
            end: match.index + value.length,
            line,
            startColumn: match.index - lineOffsets[line],
            endColumn: match.index - lineOffsets[line] + value.length,
            index: tokens.length
        });
    }
    return { tokens, lineOffsets, masked };
}

function positionOffset(document, line, character) {
    return (document.lineOffsets[line] ?? document.text.length) + character;
}

function contains(scope, offset) {
    return offset >= scope.start && offset <= scope.end;
}

function scopeAt(document, offset) {
    let scope = document.root;
    while (true) {
        let lower = 0;
        let upper = scope.children.length;
        while (lower < upper) {
            const middle = Math.floor((lower + upper) / 2);
            if (scope.children[middle].start <= offset) lower = middle + 1;
            else upper = middle;
        }
        const child = scope.children[lower - 1];
        if (!child || !contains(child, offset)) return scope;
        scope = child;
    }
}

function leafName(declaration) {
    return declaration.name.split(".").at(-1);
}

/* ------------------------------------------------------------------------- */
/* Document scope construction                                               */
/* ------------------------------------------------------------------------- */

function createDocumentModel(uri, parsed) {
    const text = parsed.text || "";
    const lexical = tokenize(text, parsed.remIdentifierOffsets, parsed.defaultEscapedStringRanges);
    const root = { kind: "module", start: 0, end: text.length, parent: null, children: [], entries: [], byName: new Map(), imports: [], access: "public", qualifiedName: "" };
    const document = { ...lexical, text, parsed, uri, key: uri.toString(), root, entries: [], entriesByOffset: new Map() };
    const stack = [root];
    let conditionalDepth = 0;
    const declarationsByLine = new Map();
    const entryByDeclaration = new Map();
    for (const declaration of parsed.declarations) {
        const list = declarationsByLine.get(declaration.line) || [];
        list.push(declaration);
        declarationsByLine.set(declaration.line, list);
    }

    function openScope(kind, start, declaration = null) {
        const parent = stack.at(-1);
        const scope = { kind, start, end: text.length, parent, children: [], entries: [], byName: new Map(), imports: [], declaration, access: "public", qualifiedName: parent.qualifiedName };
        if (declaration && (AGGREGATE_TYPES.has(kind) || kind === "namespace")) scope.qualifiedName = declaration.qualifiedName;
        parent.children.push(scope);
        stack.push(scope);
        return scope;
    }
    function closeScope(kind, end) {
        for (let index = stack.length - 1; index > 0; index--) {
            if (stack[index].kind === kind) {
                while (stack.length > index) stack.pop().end = end;
                return;
            }
        }
    }

    for (const statement of parsed.statements || []) {
        const code = statement.maskedText.trim();
        const start = positionOffset(document, statement.startLine, statement.startColumn || 0);
        const end = positionOffset(document, statement.endLine, statement.endColumn ?? 0);
        if (/^#(?:if|ifdef|ifndef)\b/i.test(code)) conditionalDepth++;
        if (/^#endif\b/i.test(code)) conditionalDepth = Math.max(0, conditionalDepth - 1);
        const closing = code.match(/^end\s+(namespace|type|class|union|enum|sub|function|property|constructor|destructor|operator|scope|with|if|select)\b|^(next|loop|wend)\b|^#(endmacro)\b/i);
        if (closing) {
            const kind = (closing[1] || ({ next: "for", loop: "do", wend: "while" })[closing[2]?.toLowerCase()] || "macro").toLowerCase();
            closeScope(kind, end);
            continue;
        }
        if (/^(?:else(?:if)?|case)\b/i.test(code)) {
            const kind = /^case\b/i.test(code) ? "case" : "if";
            const existing = stack.at(-1);
            if (existing.kind === kind) { existing.end = Math.max(existing.start, start - 1); stack.pop(); }
            openScope(kind, start);
        }
        const accessMatch = code.match(/^(public|private|protected)\s*:/i);
        if (accessMatch) { stack.at(-1).access = accessMatch[1].toLowerCase(); continue; }
        const lexicalOpening = code.match(/^(scope|with|for|do|while)\b|^(if)\b.*\bthen\s*$|^(select)\s+case\b/i);
        if (lexicalOpening) {
            const scope = openScope((lexicalOpening[1] || lexicalOpening[2] || lexicalOpening[3]).toLowerCase(), start);
            if (scope.kind === "with") scope.expression = code.replace(/^with\s+/i, "");
        }
        const usingMatch = code.match(/^using\s+(.+)/i);
        if (usingMatch) {
            stack.at(-1).imports.push(...usingMatch[1].split(",").map((name) => ({ name: name.trim(), offset: start })));
        }

        const candidates = [];
        for (let line = statement.startLine; line <= statement.endLine; line++) {
            for (const declaration of declarationsByLine.get(line) || []) {
                const offset = positionOffset(document, line, declaration.startColumn);
                if (offset >= start && offset <= end) candidates.push(declaration);
            }
        }
        for (const declaration of candidates) {
            let scope = stack.at(-1);
            if (declaration.type === "parameter") {
                scope = entryByDeclaration.get(declaration.parentDeclaration)?.bodyScope || scope;
            }
            const name = leafName(declaration);
            const offset = positionOffset(document, declaration.line, declaration.endColumn - name.length);
            const entry = {
                uri, document, declaration, scope, name,
                key: normalizeIdentifier(name),
                qualifiedName: normalizeIdentifier(declaration.qualifiedName),
                offset,
                end: offset + name.length,
                conditional: conditionalDepth > 0,
                access: declaration.modifiers.find((modifier) => /^(public|private|protected)$/i.test(modifier))?.toLowerCase() || scope.access,
                id: `${document.key}:${offset}`
            };
            document.entries.push(entry);
            entryByDeclaration.set(declaration, entry);
            document.entriesByOffset.set(offset, entry);
            scope.entries.push(entry);
            const namedEntries = scope.byName.get(entry.key) || [];
            namedEntries.push(entry);
            scope.byName.set(entry.key, namedEntries);
            const isContainer = declaration.type === "namespace" || (AGGREGATE_TYPES.has(declaration.type) && declaration.detail !== "Type alias");
            const isCallableBody = CALLABLE_TYPES.has(declaration.type) && !declaration.modifiers.includes("DECLARE") && !/^#define\b/i.test(code);
            if (isContainer || isCallableBody) entry.bodyScope = openScope(declaration.type, start, declaration);
            else if (CALLABLE_TYPES.has(declaration.type)) {
                /* Parameter names in a prototype belong only to that prototype. */
                entry.bodyScope = { kind: "prototype", start, end, parent: scope, children: [], entries: [], byName: new Map(), imports: [], qualifiedName: scope.qualifiedName, access: "public", declaration };
                scope.children.push(entry.bodyScope);
            }
        }
        if (/^(?:type|union)\s*$/i.test(code)) openScope(code.toLowerCase(), start);
    }

    return document;
}

/* ------------------------------------------------------------------------- */
/* Workspace lookup and member resolution                                    */
/* ------------------------------------------------------------------------- */

class FreeBasicSemanticModel {
    constructor(documentEntries) {
        this.documents = new Map();
        this.byQualifiedName = new Map();
        this.entries = [];
        this.byContainer = new Map();
        this.resolutionCache = new Map();
        for (const documentEntry of documentEntries) {
            const document = createDocumentModel(documentEntry.uri, documentEntry.parsed);
            document.includeUris = documentEntry.includeUris || new Set();
            this.documents.set(document.key, document);
            for (const entry of document.entries) {
                this.entries.push(entry);
                const existing = this.byQualifiedName.get(entry.qualifiedName) || [];
                existing.push(entry);
                this.byQualifiedName.set(entry.qualifiedName, existing);
                if (!isLocal(entry)) {
                    const containerName = entry.qualifiedName.includes(".") ? entry.qualifiedName.slice(0, entry.qualifiedName.lastIndexOf(".")) : "";
                    const members = this.byContainer.get(containerName) || [];
                    members.push(entry);
                    this.byContainer.set(containerName, members);
                }
            }
        }
        for (const document of this.documents.values()) {
            document.visibleDocuments = new Set([document.key]);
            const queue = [...document.includeUris];
            for (let index = 0; index < queue.length; index++) {
                const key = queue[index];
                if (document.visibleDocuments.has(key)) continue;
                document.visibleDocuments.add(key);
                queue.push(...(this.documents.get(key)?.includeUris || []));
            }
        }
        this.bindDeclarationFamilies();
    }

    bindDeclarationFamilies() {
        for (const [name, entries] of this.byQualifiedName) {
            for (const entry of entries.filter((candidate) => candidate.declaration.type === "namespace")) entry.id = `namespace:${name}`;
            const families = new Map();
            for (const entry of entries) {
                if (!CALLABLE_TYPES.has(entry.declaration.type) || entry.declaration.type === "macro" || isLocal(entry)) continue;
                const parameters = entry.declaration.parameters.map((parameter) =>
                    `${/^byref\b/i.test(parameter.label) ? "byref" : "byval"}:${parameter.typeName.toLowerCase().replace(/\s+/g, " ")}`
                );
                const signature = `${entry.declaration.type}:${name}(${parameters.join(",")})`;
                const family = families.get(signature) || [];
                family.push(entry);
                families.set(signature, family);
            }
            for (const [signature, family] of families) {
                const definitions = family.filter((entry) => !entry.declaration.modifiers.includes("DECLARE"));
                if (definitions.length <= 1) for (const entry of family) entry.id = signature;
            }
        }
    }

    getDocument(uri) { return this.documents.get(uri.toString()); }

    tokenAt(uri, line, character) {
        const document = this.getDocument(uri);
        if (!document) return null;
        const offset = positionOffset(document, line, character);
        let lower = 0;
        let upper = document.tokens.length;
        while (lower < upper) {
            const middle = Math.floor((lower + upper) / 2);
            if (document.tokens[middle].offset <= offset) lower = middle + 1;
            else upper = middle;
        }
        let token = document.tokens[lower - 1];
        if (token?.kind !== "identifier" && token?.offset === offset) token = document.tokens[lower - 2];
        if (!token || token.kind !== "identifier" || token.end < offset) return null;
        return token ? { document, token } : null;
    }

    resolveAt(uri, line, character) {
        const context = this.tokenAt(uri, line, character);
        return context ? this.resolveToken(context.document, context.token) : [];
    }

    resolveToken(document, token, depth = 0) {
        if (depth > 32) return [];
        const cacheKey = `${document.key}:${token.offset}`;
        if (this.resolutionCache.has(cacheKey)) return this.resolutionCache.get(cacheKey);
        const declaration = document.entriesByOffset.get(token.offset);
        let result;
        if (declaration) result = [declaration];
        else {
            const previous = document.tokens[token.index - 1];
            if (previous && previous.line === token.line && [".", "->"].includes(previous.name)) {
                const receiver = document.tokens[token.index - 2];
                const scope = scopeAt(document, token.offset);
                const base = receiver && receiver.line === previous.line && this.isReceiverToken(receiver)
                    ? this.resolveReceiver(document, receiver, depth + 1)
                    : this.resolveWithReceiver(document, scope, depth + 1);
                result = this.members(base, document, scope, depth + 1).filter((entry) => entry.key === token.key);
            } else {
                result = this.resolveName(document, token.name, scopeAt(document, token.offset), token.offset, depth + 1);
                const typeContext = previous && ["as", "extends", "new"].includes(previous.key);
                const typeMatches = result.filter((entry) => AGGREGATE_TYPES.has(entry.declaration.type));
                const valueMatches = result.filter((entry) => !AGGREGATE_TYPES.has(entry.declaration.type));
                if (typeContext && typeMatches.length) result = typeMatches;
                else if (valueMatches.length) result = valueMatches;
            }
        }
        result = uniqueEntries(result);
        this.resolutionCache.set(cacheKey, result);
        return result;
    }

    resolveName(document, name, scope, offset, depth = 0) {
        if (depth > 32) return [];
        const key = normalizeIdentifier(name);
        if (key.includes(".")) {
            const [first, ...rest] = key.split(".");
            let result = this.resolveName(document, first, scope, offset, depth + 1);
            for (const member of rest) result = this.members(result, document, scope, depth + 1).filter((entry) => entry.key === member);
            return uniqueEntries(result);
        }

        for (let current = scope; current; current = current.parent) {
            let matches = (current.byName.get(key) || []).filter((entry) => this.visibleBefore(entry, offset));
            if (!matches.length && current.qualifiedName) {
                matches = (this.byQualifiedName.get(`${normalizeIdentifier(current.qualifiedName)}.${key}`) || [])
                    .filter((entry) => !isLocal(entry) && document.visibleDocuments.has(entry.document.key));
            }
            if (!matches.length && CALLABLE_TYPES.has(current.kind) && current.declaration?.name.includes(".")) {
                const ownerName = current.declaration.name.split(".").slice(0, -1).join(".");
                if (key === "this") return this.byQualifiedName.get(normalizeIdentifier(ownerName)) || [];
                const owners = this.byQualifiedName.get(normalizeIdentifier(ownerName)) || [];
                matches = this.members(owners, document, current, depth + 1).filter((entry) => entry.key === key);
            }
            if (matches.length) return uniqueEntries(matches);
            const imported = [];
            for (const importedNamespace of current.imports) {
                if (importedNamespace.offset > offset) continue;
                const namespace = normalizeIdentifier(importedNamespace.name);
                const qualified = current.qualifiedName ? `${normalizeIdentifier(current.qualifiedName)}.${namespace}` : namespace;
                imported.push(...(this.byQualifiedName.get(`${qualified}.${key}`) || this.byQualifiedName.get(`${namespace}.${key}`) || [])
                    .filter((entry) => document.visibleDocuments.has(entry.document.key)));
            }
            if (imported.length) return uniqueEntries(imported);
        }
        return uniqueEntries((this.byQualifiedName.get(key) || []).filter((entry) =>
            !isLocal(entry) && entry.access === "public" && !entry.declaration.modifiers.includes("PRIVATE") && document.visibleDocuments.has(entry.document.key)
        ));
    }

    visibleBefore(entry, offset) {
        return entry.declaration.type === "parameter" || entry.declaration.type === "label" ||
            CALLABLE_TYPES.has(entry.declaration.type) || !isLocal(entry) || entry.offset <= offset;
    }

    resolveReceiver(document, token, depth) {
        if (!token || depth > 32) return [];
        if (token.name === ")" || token.name === "]") {
            let nesting = 1;
            const close = token.name;
            const open = close === ")" ? "(" : "[";
            for (let index = token.index - 1; index >= 0; index--) {
                const candidate = document.tokens[index];
                if (candidate.name === close) nesting++;
                if (candidate.name === open) {
                    nesting--;
                    if (nesting === 0) return this.resolveReceiver(document, document.tokens[index - 1], depth + 1);
                }
            }
            return [];
        }
        return token.kind === "identifier" ? this.resolveToken(document, token, depth + 1) : [];
    }

    resolveWithReceiver(document, scope, depth) {
        for (let current = scope; current; current = current.parent) {
            if (current.kind === "with" && /^[A-Za-z_][\w.]*(?:\(\))?$/.test(current.expression || "")) {
                return this.resolveName(document, current.expression.replace(/\(\)$/, ""), current.parent, current.start, depth + 1);
            }
        }
        return [];
    }

    isReceiverToken(token) {
        return token && (token.name === ")" || token.name === "]" || token.kind === "identifier" && (!KEYWORDS.has(token.key) || ["this", "base"].includes(token.key)));
    }

    typeEntries(entry, depth = 0) {
        if (depth > 32) return [];
        const declaration = entry.declaration;
        if ((AGGREGATE_TYPES.has(declaration.type) || declaration.type === "namespace") && declaration.detail !== "Type alias") return [entry];
        let typeName = declaration.typeName;
        if (!typeName && declaration.initializer) {
            const match = declaration.initializer.match(/^(?:new\s+)?([A-Za-z_][\w.]*)\s*(?:\(|$)/i);
            if (match) typeName = match[1];
        }
        typeName = normalizeTypeName(typeName);
        if (!typeName || BUILTIN_TYPES.has(typeName)) return [];
        const types = this.resolveTypeName(entry, typeName, depth + 1);
        return uniqueEntries(types.flatMap((candidate) => this.typeEntries(candidate, depth + 1)));
    }

    resolveTypeName(entry, typeName, depth) {
        const isType = (candidate) => AGGREGATE_TYPES.has(candidate.declaration.type) || candidate.declaration.type === "namespace";
        /* A variable may have the same spelling as its type, as in Dim point As Point. */
        for (let scope = entry.scope; scope; scope = scope.parent) {
            const local = (scope.byName.get(typeName) || []).filter(isType);
            if (local.length) return local;
            const qualified = scope.qualifiedName ? `${normalizeIdentifier(scope.qualifiedName)}.${typeName}` : typeName;
            const matches = (this.byQualifiedName.get(qualified) || []).filter((candidate) => isType(candidate) && entry.document.visibleDocuments.has(candidate.document.key));
            if (matches.length) return matches;
            for (const imported of scope.imports) {
                const importedTypes = (this.byQualifiedName.get(`${normalizeIdentifier(imported.name)}.${typeName}`) || [])
                    .filter((candidate) => isType(candidate) && entry.document.visibleDocuments.has(candidate.document.key));
                if (importedTypes.length) return importedTypes;
            }
        }
        return this.resolveName(entry.document, typeName, entry.scope, entry.offset, depth + 1).filter(isType);
    }

    findVisibleTypeEntries(uri, typeName) {
        const source = this.getDocument(uri);
        const name = normalizeTypeName(typeName);
        if (!source || !name) return [];

        return uniqueEntries(this.entries.filter((entry) =>
            AGGREGATE_TYPES.has(entry.declaration.type) &&
            source.visibleDocuments.has(entry.document.key) &&
            (entry.qualifiedName === name || entry.key === name)
        ));
    }

    findUniqueVisibleType(uri, typeName) {
        const candidates = this.findVisibleTypeEntries(uri, typeName);
        return candidates.length === 1 && !candidates[0].conditional ? candidates[0] : null;
    }

    members(receivers, document, scope, depth = 0) {
        if (depth > 32) return [];
        const result = [];
        for (const receiver of receivers) {
            for (const type of this.typeEntries(receiver, depth + 1)) {
                const direct = [...(type.bodyScope?.entries || [])].filter((entry) => entry.declaration.type !== "parameter");
                const collectAnonymousMembers = (scope) => {
                    for (const child of scope?.children || []) {
                        if (!child.declaration && AGGREGATE_TYPES.has(child.kind)) {
                            direct.push(...child.entries);
                            collectAnonymousMembers(child);
                        }
                    }
                };
                collectAnonymousMembers(type.bodyScope);
                /* Namespace blocks can be reopened in another file. */
                if (type.declaration.type === "namespace") {
                    direct.push(...(this.byContainer.get(type.qualifiedName) || []).filter((entry) => document.visibleDocuments.has(entry.document.key)));
                }
                const accessible = direct.filter((entry) => this.canAccess(entry, scope));
                result.push(...accessible);
                if (type.declaration.baseType) {
                    const bases = this.resolveName(type.document, type.declaration.baseType, type.scope, type.offset, depth + 1);
                    const inherited = this.members(bases, document, scope, depth + 1);
                    const ownNames = new Set(direct.map((entry) => entry.key));
                    result.push(...inherited.filter((entry) => !ownNames.has(entry.key)));
                }
            }
        }
        return uniqueEntries(result);
    }

    canAccess(entry, scope) {
        if (entry.access === "public") return true;
        for (let current = scope; current; current = current.parent) {
            if (current === entry.scope || current.qualifiedName === entry.scope.qualifiedName && current.qualifiedName) return true;
            if (CALLABLE_TYPES.has(current.kind) && normalizeIdentifier(current.declaration?.name || "").startsWith(`${normalizeIdentifier(entry.scope.qualifiedName)}.`)) return true;
        }
        return false;
    }

    completeMembers(uri, line, character) {
        const document = this.getDocument(uri);
        if (!document) return null;
        const offset = positionOffset(document, line, character);
        const before = document.tokens.filter((token) => token.offset < offset);
        let last = before.at(-1);
        if (last?.kind === "identifier" && last.end >= offset) last = before.at(-2);
        if (!last || ![".", "->"].includes(last.name) || last.line !== line) return null;
        const scope = scopeAt(document, offset);
        const previous = document.tokens[last.index - 1];
        const receivers = previous?.line === line && this.isReceiverToken(previous)
            ? this.resolveReceiver(document, previous, 0)
            : this.resolveWithReceiver(document, scope, 0);
        return this.members(receivers, document, scope);
    }

    visibleEntries(uri, line, character, maxResults = 2000) {
        const document = this.getDocument(uri);
        if (!document) return [];
        const offset = positionOffset(document, line, character);
        const selected = new Map();
        const add = (entry) => {
            if (!selected.has(entry.key) && selected.size < maxResults) selected.set(entry.key, entry);
        };
        for (let scope = scopeAt(document, offset); scope; scope = scope.parent) {
            for (const entry of scope.entries) if (this.visibleBefore(entry, offset)) add(entry);
            for (const imported of scope.imports) {
                if (imported.offset > offset) continue;
                const owners = (this.byQualifiedName.get(normalizeIdentifier(imported.name)) || []).filter((entry) => document.visibleDocuments.has(entry.document.key));
                for (const entry of this.members(owners, document, scope)) add(entry);
            }
        }
        for (const entry of this.entries) {
            if (entry.scope.kind === "module" && entry.access === "public" && !entry.qualifiedName.includes(".") && document.visibleDocuments.has(entry.document.key)) add(entry);
        }
        return [...selected.values()];
    }

    references(target, includeDeclaration = true, token = null) {
        const result = [];
        for (const document of this.documents.values()) {
            if (token?.isCancellationRequested) return [];
            for (const occurrence of document.tokens) {
                if (occurrence.kind !== "identifier" || occurrence.key !== target.key) continue;
                const resolved = this.resolveToken(document, occurrence);
                if (resolved.length === 1 && resolved[0].id === target.id && (includeDeclaration || !document.entriesByOffset.has(occurrence.offset))) {
                    result.push({ uri: document.uri, occurrence });
                }
            }
        }
        return result;
    }

    declarationTargets(targets) {
        const result = [];
        for (const target of targets) {
            const family = this.entries.filter((entry) => entry.id === target.id);
            const definitions = family.filter((entry) => !entry.declaration.modifiers.includes("DECLARE"));
            result.push(...(definitions.length ? definitions : family));
        }
        return [...new Map(result.map((entry) => [`${entry.document.key}:${entry.offset}`, entry])).values()];
    }

    renameProblem(target, newName = null) {
        if ((target.scope.byName.get(target.key) || []).some((entry) => entry.id !== target.id)) {
            return "This scope has multiple declarations of the selected name, possibly from conditional compilation.";
        }
        if (["macro", "constructor", "destructor", "operator", "namespace"].includes(target.declaration.type)) {
            return "Rename for macros, namespaces, and special procedures requires compiler analysis.";
        }
        const related = this.entries.filter((entry) => entry.qualifiedName === target.qualifiedName && !isLocal(entry));
        if (!isLocal(target) && new Set(related.map((entry) => entry.id)).size > 1) return "This name has ambiguous declarations or overloads.";
        if (!newName) return null;
        const key = normalizeIdentifier(newName);
        for (const member of this.entries.filter((entry) => entry.id === target.id)) {
            if (member.scope.entries.some((entry) => entry.id !== target.id && entry.key === key)) return "The new name is already declared in this scope.";
            const owners = member.document.entries.filter((entry) => entry.bodyScope === member.scope);
            if (this.members(owners, member.document, member.scope).some((entry) => entry.id !== target.id && entry.key === key)) return "The new name conflicts with an inherited member.";
        }
        for (const reference of this.references(target)) {
            const document = this.getDocument(reference.uri);
            const occurrence = reference.occurrence;
            const previous = document.tokens[occurrence.index - 1];
            if (previous?.line === occurrence.line && [".", "->"].includes(previous.name)) continue;
            const matches = this.resolveName(document, newName, scopeAt(document, occurrence.offset), occurrence.offset);
            if (matches.some((entry) => entry.id !== target.id)) return "The new name would hide or capture another declaration.";
        }
        return null;
    }
}

/* ------------------------------------------------------------------------- */
/* Shared symbol helpers                                                     */
/* ------------------------------------------------------------------------- */

function normalizeTypeName(typeName) {
    return normalizeIdentifier(String(typeName || "").replace(/\b(?:const|ptr|pointer)\b/gi, "").replace(/\s*\*\s*\d+\s*$/, "").trim());
}

function isLocal(entry) {
    for (let scope = entry.scope; scope; scope = scope.parent) {
        if (CALLABLE_TYPES.has(scope.kind) || ["scope", "for", "do", "while", "if", "case", "prototype"].includes(scope.kind)) return true;
    }
    return false;
}

function uniqueEntries(entries) {
    return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

module.exports = { AGGREGATE_TYPES, CALLABLE_TYPES, FreeBasicSemanticModel, createDocumentModel, isLocal, normalizeTypeName, positionOffset, scopeAt, tokenize };

/* end of lib/semantic-model.js */
