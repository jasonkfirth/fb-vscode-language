/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-inventory.js
    Purpose: Build editor declaration and scope indexes from native records.
    Responsibilities: separate lexical regions, symbol ownership, and presentation.
    Does not contain: a declaration parser, type inference, or compiler execution.
*/

const { CALLABLE_TYPES, positionOffset } = require("./semantic-model");

// FBC stores its base type and pointer depth in these low nine dtype bits.
const FREEBASIC_DTYPE_TYPE_AND_POINTER_MASK = 0x1ff;
const MAX_SIGNATURE_DEFAULT_LENGTH = 120;

function sourceDefaultArgumentSuffix(parameter, optional) {
    if (!optional) return "";
    if (!parameter?.optional || typeof parameter.label !== "string") return " = ...";
    const separator = parameter.label.indexOf("=");
    if (separator < 0) return " = ...";
    const value = parameter.label.slice(separator + 1).replace(/[\r\n\t ]+/g, " ").trim();
    return value && value.length <= MAX_SIGNATURE_DEFAULT_LENGTH ? ` = ${value}` : " = ...";
}

function procedureReturnsVoid(symbol) {
    // A non-pointer VOID result has neither a base type nor pointer bits set.
    return (symbol.dtype & FREEBASIC_DTYPE_TYPE_AND_POINTER_MASK) === 0;
}

function installNativeInventory(model, analysis) {
    const document = [...model.documents.values()][0];
    const presentation = new Map(document.entriesByOffset);
    const symbols = new Map(analysis.symbolGraph.symbols.map((symbol) => [symbol.id, symbol]));
    const canonical = new Map(analysis.symbolGraph.canonicalIds);
    const shapes = new Map(analysis.scopeGraph.shapes.map((shape) => [shape.symbol, shape]));
    const lines = document.text.split("\n");
    const nativeScopes = new Map(analysis.scopeGraph.scopes.map((scope) => [scope.id, scope]));
    const recoverySymbols = new Set(analysis.recoverySymbols || []);
    const canonicalId = (id) => canonical.get(id) || id;
    const native = (id) => symbols.get(canonicalId(id));
    const offset = (position) => positionOffset(document, position.line, position.character);
    const names = new Map([[0, ""]]);
    function qualified(id) {
        id = canonicalId(id);
        if (names.has(id)) return names.get(id);
        const pending = [];
        const visited = new Set();
        let current = id;
        while (current && !names.has(current)) {
            if (visited.has(current)) throw new Error("Cyclic native declaration ownership.");
            visited.add(current);
            pending.push(current);
            const symbol = native(current);
            current = canonicalId(symbol?.owner || 0);
        }
        let prefix = names.get(current) || "";
        for (const member of pending.reverse()) {
            const symbol = native(member);
            // Anonymous scopes and compiler-generated module procedures do not
            // contribute source qualifiers. Actual names come from metadata.
            const name = [3, 8, 9, 10, 11].includes(symbol.symbolClass) && !/^\{fb|^fbctinf|^__fb_/i.test(symbol.name) ? symbol.name : "";
            if (name) prefix = prefix ? `${prefix}.${name}` : name;
            names.set(member, prefix);
        }
        return names.get(id);
    }
    function kindOf(symbol) {
        // These are FB_SYMBCLASS and FB_PROCATTRIB values from symb.bi, not
        // VS Code SymbolKind values. Procedure dtype zero is native VOID.
        if (symbol.symbolClass === 3) {
            const flags = symbol.procedureAttributes;
            if (flags & 4) return "constructor";
            if (flags & 0x1008) return "destructor";
            if (flags & 16) return "operator";
            if (flags & 32) return "property";
            return procedureReturnsVoid(symbol) ? "sub" : "function";
        }
        if (symbol.symbolClass === 2) return native(symbol.owner)?.symbolClass === 9 ? "enumMember" : "const";
        if (symbol.symbolClass === 10) return (shapes.get(symbol.id)?.options & 1) ? "union" : "type";
        return { 1: "variable", 4: "parameter", 7: "label", 8: "namespace", 9: "enum", 11: "class", 12: "field", 13: "type" }[symbol.symbolClass];
    }
    function emptyScope(kind, start, end, parent, symbol = 0) {
        return { kind, start, end, parent, symbol, children: [], entries: [], byName: new Map(), imports: [], access: "public", qualifiedName: symbol ? qualified(symbol) : parent?.qualifiedName || "" };
    }
    const root = emptyScope("module", 0, document.text.length, null);
    const scopes = new Map([[0, root]]);
    const scopesBySymbol = new Map();
    for (const record of analysis.scopeGraph.scopes) {
        const parent = scopes.get(record.parent);
        const symbol = native(record.symbol);
        const kind = record.kind === "procedure" ? kindOf(symbol) : record.kind;
        const scope = emptyScope(kind, offset(record.start), offset(record.end), parent, record.symbol);
        scope.nativeId = record.id;
        scope.recovered = record.recovered;
        parent.children.push(scope);
        scopes.set(record.id, scope);
        const family = scopesBySymbol.get(record.symbol) || [];
        family.push(scope);
        scopesBySymbol.set(record.symbol, family);
    }
    document.root = root;
    document.entries = [];
    document.entriesByOffset = new Map();
    const recordsByEntry = new Map();
    const entriesBySymbol = new Map();
    const entriesByOwner = new Map();
    for (const record of analysis.scopeGraph.declarations) {
        if (record.invalid) continue;
        const symbol = native(record.symbol);
        const type = kindOf(symbol);
        if (!type) continue;
        const start = offset(record.start);
        const old = presentation.get(start);
        const ownerName = qualified(symbol.owner);
        const name = record.name;
        const qualifiedName = ownerName ? `${ownerName}.${name}` : name;
        const scope = scopes.get(record.scope);
        const modifiers = [];
        if (record.prototype) modifiers.push("DECLARE");
        for (const [bit, name] of [[1, "SHARED"], [2, "STATIC"], [8, "COMMON"], [16, "EXTERN"], [32, "PUBLIC"], [64, "PRIVATE"]]) if (symbol.attributes & bit) modifiers.push(name);
        if (symbol.procedureAttributes & 0x200) modifiers.push("ABSTRACT");
        // Property getters return a value; setters are compiler-level VOID procedures.
        const declaration = {
            name, qualifiedName, type, typeName: symbol.typeName || "", baseType: qualified(shapes.get(symbol.id)?.base || 0),
            compilerBaseTypeConfirmed: Boolean(shapes.get(symbol.id)?.base),
            propertyRole: type === "property" ? (procedureReturnsVoid(symbol) ? "setter" : "getter") : "",
            detail: symbol.symbolClass === 13 ? "Type alias" : old?.declaration.detail || type,
            initializer: "", line: record.start.line, startColumn: record.start.character,
            endColumn: record.start.character + name.length, endLine: record.end.line,
            signatureEndLine: record.end.line, containerName: ownerName, containerPath: ownerName ? ownerName.split(".") : [],
            parentDeclaration: null, parameters: [], modifiers, localOnly: scope !== root,
            sourceLine: lines[record.start.line].trim(),
            // Existing parsing may supply a convenient display string, but it
            // cannot add a declaration, choose its kind, or determine its scope.
            signature: old?.declaration.signature || `${type} ${name}${symbol.typeName ? ` As ${symbol.typeName}` : ""}`
        };
        // FB_SYMBATTRIB_VIS_PRIVATE / VIS_PROTECTED differ from module PRIVATE.
        const access = symbol.attributes & 0x200000 ? "private" : symbol.attributes & 0x400000 ? "protected" : "public";
        const entry = { uri: document.uri, document, declaration, scope, name, key: name.toLowerCase(), qualifiedName: qualifiedName.toLowerCase(), offset: start, end: start + name.length, conditional: false, access, id: `compiler-symbol:${record.symbol}`, compilerSymbolId: record.symbol, nativeSymbol: symbol };
        entry.sourceParameters = old?.declaration.parameters || [];
        const body = !record.prototype && (scopesBySymbol.get(record.symbol) || []).find((candidate) => candidate.start <= offset(record.end) && candidate.end >= start);
        if (body) {
            entry.bodyScope = body;
            body.declaration = declaration;
            declaration.endLine = nativeScopes.get(body.nativeId).end.line;
        } else if (CALLABLE_TYPES.has(type)) {
            entry.bodyScope = emptyScope("prototype", start, offset(record.end), scope, record.symbol);
            entry.bodyScope.declaration = declaration;
            scope.children.push(entry.bodyScope);
        }
        document.entries.push(entry);
        document.entriesByOffset.set(start, entry);
        recordsByEntry.set(entry, record);
        const family = entriesBySymbol.get(record.symbol) || [];
        family.push(entry);
        entriesBySymbol.set(record.symbol, family);
    }
    for (const entry of document.entries) {
        const owner = canonicalId(entry.nativeSymbol.owner);
        if (entry.declaration.type === "label") {
            /* Labels belong to the native procedure table even when written
               inside an IF/FOR block. Owner zero denotes the module table. */
            entry.scope = owner === 0 ? root : scopesBySymbol.get(owner)?.[0] || entry.scope;
            entry.declaration.localOnly = entry.scope !== root;
        }
        if (["function", "sub"].includes(entry.declaration.type)) {
            const ownerSymbol = native(owner);
            const ownerKind = ownerSymbol ? kindOf(ownerSymbol) : owner === 0 ? "module" : "";
            // Native ownership, not the implementation's lexical position,
            // distinguishes namespace procedures from out-of-line methods.
            if (["type", "class", "union"].includes(ownerKind)) entry.callableKind = "method";
            else if (["module", "namespace"].includes(ownerKind)) entry.callableKind = "function";
        }
        if (([8, 9, 10, 11].includes(native(owner)?.symbolClass) || native(owner)?.symbolClass === 3 && entry.declaration.type === "variable") && entry.scope.symbol !== owner) {
            // An out-of-line implementation is physically at module level but
            // remains a member of its native namespace/type, not a new global.
            // Legacy implicit variables can likewise be promoted out of a
            // lexical IF/FOR block into their procedure's symbol table.
            entry.scope = scopesBySymbol.get(owner)?.[0] || entry.scope;
        }
        const owned = entriesByOwner.get(owner) || [];
        owned.push(entry);
        entriesByOwner.set(owner, owned);
        if (entry.declaration.type === "parameter") {
            const headers = entriesBySymbol.get(canonicalId(entry.nativeSymbol.owner)) || [];
            const parent = headers.find((candidate) => candidate.offset < entry.offset && offset(recordsByEntry.get(candidate).end) >= entry.end);
            if (parent) {
                entry.scope = parent.bodyScope;
                entry.declaration.parentDeclaration = parent.declaration;
                const shape = shapes.get(entry.nativeSymbol.id);
                const mode = shape?.parameterMode === 2 ? "ByRef" : "ByVal";
                const array = shape?.parameterMode === 3 ? "()" : "";
                const sourceParameter = parent.sourceParameters.find((parameter) =>
                    parameter.name.toLowerCase() === entry.name.toLowerCase()
                );
                /* Compiler shape owns optionality and type; source syntax only supplies its written default. */
                const defaultArgument = sourceDefaultArgumentSuffix(sourceParameter, Boolean(shape?.optional));
                const label = `${mode} ${entry.name}${array} As ${entry.nativeSymbol.typeName}${defaultArgument}`;
                parent.declaration.parameters.push({ name: entry.name, typeName: entry.nativeSymbol.typeName, label, optional: Boolean(shape?.optional) });
            } else {
                // Parameter names inside an anonymous function-pointer type do
                // not introduce locals in the surrounding procedure or module.
                entry.scope = emptyScope("prototype", entry.offset, offset(recordsByEntry.get(entry).end), entry.scope, owner);
            }
        }
        entry.scope.entries.push(entry);
        const named = entry.scope.byName.get(entry.key) || [];
        named.push(entry);
        entry.scope.byName.set(entry.key, named);
    }
    for (const record of analysis.scopeGraph.imports) {
        if (record.invalid) continue;
        const destinations = record.destination ? scopesBySymbol.get(canonicalId(record.destination)) || [] : [root];
        for (const scope of destinations) scope.imports.push({ name: qualified(record.source), offset: offset(record.position) });
    }
    const scopeWasRecovered = (scope) => {
        const visited = new Set();
        for (let current = scope; current; current = current.parent) {
            if (visited.has(current)) throw new Error("Cyclic native lexical scope.");
            visited.add(current);
            if (current.recovered) return true;
        }
        return false;
    };
    for (const entry of document.entries) {
        /* A recovered scope has no compiler-confirmed terminator. Keep its
           symbols available for the active edit, but carry that uncertainty
           into presentation rather than making unrelated module symbols
           provisional just because the translation unit is partial. */
        entry.provisional = Boolean(analysis.partial && (recoverySymbols.has(canonicalId(entry.compilerSymbolId)) || scopeWasRecovered(entry.scope) || scopeWasRecovered(entry.bodyScope)));
        entry.declaration.provisional = entry.provisional;
    }
    for (const scope of scopes.values()) scope.children.sort((left, right) => left.start - right.start);
    model.entries = document.entries;
    model.byQualifiedName = new Map();
    model.byContainer = new Map();
    model.resolutionCache.clear();
    for (const entry of document.entries) {
        const family = model.byQualifiedName.get(entry.qualifiedName) || [];
        family.push(entry);
        model.byQualifiedName.set(entry.qualifiedName, family);
        const container = entry.declaration.containerName.toLowerCase();
        const members = model.byContainer.get(container) || [];
        members.push(entry);
        model.byContainer.set(container, members);
    }
    return { scopes, scopesBySymbol, entriesBySymbol, entriesByOwner, shapes, recordsByEntry, nativeScopes };
}

module.exports = { installNativeInventory };

/* end of compiler-inventory.js */
