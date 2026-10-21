/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-model-queries.js
    Purpose: Answer editor requests without exporting the native semantic graph.
    Responsibilities: batch native queries and return bounded, acyclic records,
    including compiler-selected type and call hierarchy relationships.
    Does not contain: VS Code objects, source mutation, or a second resolver.
*/

const path = require("path");
const { CompilerUri } = require("./compiler-model-store");
const { CALLABLE_TYPES, FreeBasicSemanticModel, createDocumentModel, positionOffset, scopeAt } = require("./semantic-model");
const { getCodeContext, findCallContextInMaskedText, findSignatureCallContextInMaskedText,
    findFoldingRanges, maskFreeBasicComments, maskFreeBasicText, normalizeIdentifier, parseFreeBasicText, parseParameters,
    typedConstructorOpeningToken } = require("./freebasic-parser");
const {
    compilerSourceDeclarations: compilerSidecarNavigationSourceDeclarations,
    MAX_COMPILER_SOURCE_DECLARATION_BYTES: MAX_COMPILER_SIDECAR_NAVIGATION_SOURCE_BYTES,
    MAX_COMPILER_SOURCE_DECLARATIONS: MAX_COMPILER_SIDECAR_NAVIGATION_DECLARATIONS,
    MAX_COMPILER_SOURCE_DECLARATION_DOCUMENTS: MAX_COMPILER_SIDECAR_NAVIGATION_CACHED_DOCUMENTS,
    MAX_COMPILER_PARAMETER_INLAY_HINTS,
    MAX_COMPILER_PARAMETER_INLAY_SCAN_CHARACTERS,
    compilerParameterDeclarationLocation,
    freeBasicCallArgumentRanges
} = require("./compiler-semantic-model");
const { semanticTokenType, semanticEntryIsDeprecated, semanticEntryIsReadonly, TOKEN_TYPES, TOKEN_MODIFIERS } = require("./semantic-token-data");
const { compilerSymbolRecords } = require("./compiler-document-symbols");
const { isCompilerConstantValue } = require("./compiler-constant-values");

const semanticTokenCaches = new WeakMap();
/* Bound sidecar access-role work to each immutable model and physical document. */
const semanticAccessRoleCaches = new WeakMap();
const semanticReadonlyCaches = new WeakMap();
const expressionGraphNodeCaches = new WeakMap();
const sidecarNavigationDeclarationBindingIndexes = new WeakMap();
const sidecarReadOnlyDeclarationBindingIndexes = new WeakMap();
const sidecarCompletionReachableDeclarationBindings = new WeakMap();
const sidecarCompletionScopeDocumentCaches = new WeakMap();
const sidecarCompletionSourceModelCaches = new WeakMap();
const sidecarEnumMemberReferenceIndexes = new WeakMap();
const sidecarPhysicalBindingFileIndexes = new WeakMap();
const sidecarReadOnlyBindingFileIndexes = new WeakMap();
const sidecarBaseTypeIndexes = new WeakMap();
const sidecarNoKeywordDirectiveCaches = new WeakMap();
/* Native overload chains are immutable for the lifetime of a snapshot. */
const sidecarOverloadChainCaches = new WeakMap();
const selectedIndexOperatorTargets = new WeakMap();
const sidecarParameterHintCaches = new WeakMap();
const sidecarExplicitConstructorCallCaches = new WeakMap();
const sidecarLifetimeCallCaches = new WeakMap();
const sidecarImplicitVariableDeclarationIndexes = new WeakMap();
const COMPILER_QUERY_CANCELLATION_INTERVAL = 256;
// Token vectors are derivable from immutable snapshots; bound this LRU so a
// workspace with many open source documents cannot pin every encoded result.
const MAX_SEMANTIC_TOKEN_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_SEMANTIC_TOKEN_CACHE_DOCUMENTS = 8;
const MAX_COMPILER_SIDECAR_CALL_BINDINGS = 5000;
const MAX_COMPILER_SIDECAR_CONSTRUCTOR_CALL_CACHE_DOCUMENTS = 8;
const MAX_COMPILER_SIDECAR_COMPLETION_TYPE_CANDIDATES = 64;
const MAX_COMPILER_SIDECAR_COMPLETION_SOURCE_MODEL_CACHE_DOCUMENTS = 2;
const MAX_COMPILER_SIDECAR_COMPLETION_SOURCE_FILES = 128;
/* The FBC sidecar's named symbol-class table maps index 13 to "typedef". */
const FBC_SEMANTIC_SYMBOL_CLASS_TYPEDEF = 13;
const MAX_COMPILER_SIDECAR_SELECTED_ARGUMENT_INPUTS = 100000;
const MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS = 200000;
const MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS = 20000;
const MAX_COMPILER_SIDECAR_CODE_LENSES = 5000;
const MAX_COMPILER_SIDECAR_CODE_LENS_PARSE_BYTES = 16 * 1024 * 1024;
/* One selected procedure may have prototypes in several included contexts. */
const MAX_COMPILER_PROCEDURE_DECLARATION_SITES = 64;
const MAX_COMPILER_SIDECAR_COMPLETION_DECLARATIONS = 64;
/* One explicit hierarchy request may visit many files, but parsing stays bounded. */
const MAX_COMPILER_SIDECAR_TYPE_HIERARCHY_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_COMPILER_SIDECAR_CONSTANT_SITES = 64;
const MAX_COMPILER_SIDECAR_OUTLINE_FACT_SITES = 64;
const MAX_COMPILER_SIDECAR_OUTLINE_MASKED_DECLARATIONS = 256;
const MAX_COMPILER_SIDECAR_IMPLICIT_VARIABLE_INLAY_HINTS = 256;
const MAX_COMPILER_SIDECAR_IMPLICIT_DECLARATION_INLAY_HINTS = 256;
const COMPILER_COMPOUND_ASSIGNMENT_TARGET = /^(\s*)([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*(?:ANDALSO=|ORELSE=|SHL=|SHR=|MOD=|EQV=|IMP=|XOR=|AND=|OR=|\+=|-=|\*=|\/=|\\=|\^=|&=)/i;
const COMPILER_LSET_RSET_TARGET = /^(\s*)(?:LSET|RSET)\s+([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*=(?!=|>)/i;
/* Keep whole-document Outline enrichment inside the same bounded source slice. */
const MAX_COMPILER_SIDECAR_OUTLINE_IMPLICIT_VARIABLE_BYTES = 4 * 1024 * 1024;
/* Fail closed when one physical symbol spans an unusually large config matrix. */
const MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS = 64;
const MAX_COMPILER_SIDECAR_ACCESS_ROLE_SITES = 4000;
const MAX_COMPILER_SIDECAR_PARAMETER_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_COMPILER_SIDECAR_PARAMETER_TOTAL_SOURCE_BYTES = 16 * 1024 * 1024;
/* Bound multi-cursor selection queries sent through the worker boundary. */
const MAX_COMPILER_SELECTION_POSITIONS = 256;
const CONSTRUCTOR_IMPLICIT_CALL_KINDS = new Set([
    "argument-constructor", "default-constructor", "initializer-constructor", "new-constructor", "return-constructor", "explicit-constructor"
]);
const DESTRUCTOR_IMPLICIT_CALL_KINDS = new Set([
    "destructor-call", "temporary-destructor", "delete-destructor", "scope-exit-destructor"
]);
const TYPE_HIERARCHY_TYPES = new Set(["type", "class", "union"]);
const CALL_HIERARCHY_TYPES = new Set(["function", "sub", "property", "constructor", "destructor", "operator"]);
const SIGNATURE_CALLABLE_TYPES = new Set([...CALL_HIERARCHY_TYPES, "macro"]);
/* Keep generated callable type spellings and nested anonymous prototypes bounded. */
const MAX_PROCEDURE_POINTER_TYPE_CHARACTERS = 16 * 1024;
const MAX_PROCEDURE_POINTER_TYPE_NESTING = 64;
const MAX_PROCEDURE_POINTER_PARAMETERS = 256;
/* Bound source scanning and keep factory/index expressions readable in a popup. */
const MAX_SIGNATURE_CALLEE_CHARACTERS = 16 * 1024;
const MAX_SIGNATURE_CALLEE_LABEL_CHARACTERS = 256;
/* Defensive presentation limit, not a claim about FBC's language rank limit. */
const MAX_ARRAY_SIGNATURE_DIMENSIONS = 64;
/* The source-built bridge's dtype layout comes from compiler/symbols/symb.bi. */
const BRIDGE_DTYPE_POINTER_MASK = 0x1e0;
const BRIDGE_DTYPE_POINTER_SHIFT = 5;
/* Recovery displays a small declaration family, never a workspace name search. */
const MAX_SIGNATURE_RECOVERY_CANDIDATES = 64;
const CALL_HIERARCHY_MODULE_DETAIL = "Module-level calls";
// Namespace-owned shared storage can run constructors during module startup.
const NON_MODULE_CALL_SCOPES = new Set([
    "function", "sub", "property", "constructor", "destructor", "operator", "macro", "prototype",
    "type", "class", "union", "enum"
]);

function expressionGraphNodeIndex(graph, checkCancelled = () => {}) {
    let index = expressionGraphNodeCaches.get(graph);
    if (!index) {
        index = new Map();
        for (let position = 0; position < graph.nodes.length; position++) {
            if (position % COMPILER_QUERY_CANCELLATION_INTERVAL === 0) checkCancelled();
            const node = graph.nodes[position];
            index.set(node.id, node);
        }
        expressionGraphNodeCaches.set(graph, index);
    }
    return index;
}

function uriRecord(uri) { return { scheme: uri.scheme, fsPath: uri.fsPath, path: uri.path, value: uri.toString() }; }

function entryRecord(entry, includeMacroDefinition = false, includeQualifiedName = false) {
    const declaration = entry.declaration;
    const qualifiedName = entry.qualifiedName || declaration.qualifiedName;
    return {
        id: entry.id, name: entry.name, compilerSymbolId: entry.compilerSymbolId, compilerPreprocessorId: entry.compilerPreprocessorId,
        ...(entry.callableKind === "function" || entry.callableKind === "method" ? { callableKind: entry.callableKind } : {}),
        ...(includeQualifiedName && qualifiedName ? { qualifiedName } : {}),
        uri: uriRecord(entry.uri),
        declaration: {
            name: declaration.name, type: declaration.type, detail: declaration.detail,
            typeName: declaration.typeName || entry.nativeSymbol?.typeName || "",
            baseType: declaration.baseType || "",
            signature: declaration.signature, line: declaration.line,
            startColumn: declaration.startColumn, endColumn: declaration.endColumn,
            provisional: Boolean(declaration.provisional),
            ...(typeof declaration.documentation === "string" && declaration.documentation
                ? { documentation: declaration.documentation }
                : {}),
            compilerMacroDefinition: includeMacroDefinition === true ? declaration.compilerMacroDefinition || "" : "",
            modifiers: declaration.modifiers,
            parameters: (declaration.parameters || []).map((parameter) => ({
                name: parameter.name,
                label: parameter.label,
                typeName: parameter.typeName,
                optional: Boolean(parameter.optional),
                variadic: Boolean(parameter.variadic),
                ...(typeof parameter.documentation === "string" && parameter.documentation
                    ? { documentation: parameter.documentation }
                    : {}),
                ...(parameter.compilerParameterPassing
                    ? { compilerParameterPassing: parameter.compilerParameterPassing }
                    : {})
            })),
            compilerFacts: entry.compilerFacts || null
        }
    };
}

function navigationEntryRecord(entry) {
    /* Array callbacks receive an index and the array as extra arguments.
       Keep navigation's qualified identity without enabling macro previews. */
    return entryRecord(entry, false, true);
}

function entryRecordWithHeaderLibraries(model, entry) {
    const record = entry.declaration.type === "operator" ? callHierarchyEntryRecord(model, entry) : entryRecord(entry);
    const libraries = model.compilerHeaderLibrariesForFile?.(entry.uri?.fsPath || entry.uri?.path);
    if (libraries?.length) record.declaration.compilerHeaderLibraries = libraries;
    return record;
}

function isTypeHierarchyEntry(entry) {
    return TYPE_HIERARCHY_TYPES.has(entry?.declaration?.type) && entry.declaration.detail !== "Type alias" &&
        !entry.conditional && !entry.provisional && !entry.declaration.provisional;
}

function typeHierarchyEntries(model, targets, checkCancelled) {
    const result = new Map();
    const add = (entry) => {
        if (!isTypeHierarchyEntry(entry)) return;
        result.set(entry.id, entry);
    };
    for (const target of targets) {
        checkCancelled();
        if (isTypeHierarchyEntry(target)) add(target);
        else for (const entry of model.typeEntries(target)) add(entry);
    }
    return [...result.values()];
}

function nativeSymbolId(model, entry) {
    const id = entry.compilerSymbolId || entry.nativeSymbol?.id || 0;
    return model.canonicalSymbolIds.get(id) || id;
}

function nativeTypeFamily(model, id) {
    const canonical = model.canonicalSymbolIds.get(id) || id;
    return model.nativeFamilies.get(id) || model.nativeFamilies.get(canonical) || [];
}

function typeHierarchySupertypes(model, targets, checkCancelled) {
    const result = new Map();
    const add = (entry) => {
        if (isTypeHierarchyEntry(entry)) result.set(entry.id, entry);
    };
    for (const target of typeHierarchyEntries(model, targets, checkCancelled)) {
        checkCancelled();
        if (model.inventory && target.nativeSymbol) {
            const id = nativeSymbolId(model, target);
            const shape = model.inventory.shapes.get(id) || model.inventory.shapes.get(target.compilerSymbolId || 0);
            if (!shape?.base) continue;
            for (const entry of nativeTypeFamily(model, shape.base)) add(entry);
            continue;
        }
        if (!target.declaration.baseType) continue;
        const document = model.inner.getDocument(model.expandedUri);
        for (const entry of model.inner.findVisibleTypeEntries(document.uri, target.declaration.baseType)) add(entry);
    }
    return [...result.values()];
}

function typeHierarchySubtypes(model, targets, checkCancelled) {
    const result = new Map();
    const add = (entry) => {
        if (isTypeHierarchyEntry(entry)) result.set(entry.id, entry);
    };
    const typeTargets = typeHierarchyEntries(model, targets, checkCancelled);
    const bases = new Set(typeTargets.map((entry) => model.inventory ? nativeSymbolId(model, entry) : entry.id));
    if (!bases.size) return [];

    if (model.inventory) {
        for (const [symbolId, shape] of model.inventory.shapes) {
            checkCancelled();
            if (!shape.base || !bases.has(model.canonicalSymbolIds.get(shape.base) || shape.base)) continue;
            for (const entry of nativeTypeFamily(model, symbolId)) {
                if (model.inventory.recordsByEntry.has(entry)) add(entry);
            }
        }
    } else {
        const document = model.inner.getDocument(model.expandedUri);
        for (const entry of model.inner.entries) {
            checkCancelled();
            if (!isTypeHierarchyEntry(entry) || !entry.declaration.baseType) continue;
            const parents = model.inner.findVisibleTypeEntries(document.uri, entry.declaration.baseType);
            if (parents.some((parent) => bases.has(parent.id))) add(entry);
        }
    }
    return [...result.values()];
}

/* Implementation on a type lists descendants, while Type Hierarchy exposes
   only one level. Both use committed native inheritance, never text names. */
function compilerTypeImplementations(model, uri, document, position, resolve, checkCancelled) {
    if (model.partial) return [];
    const sidecar = model.semanticSidecarOnly;
    const selection = sidecar ? compilerSidecarTypeHierarchySelection(model, uri, document, position, checkCancelled) : null;
    const roots = sidecar ? new Set(selection?.symbol ? [selection.symbol] : [])
        : new Set(typeHierarchyEntries(model, resolve().filter((entry) => TYPE_HIERARCHY_TYPES.has(entry.declaration.type) ||
            ["variable", "field", "parameter", "extern"].includes(entry.declaration.type)), checkCancelled)
            .map((entry) => nativeSymbolId(model, entry)).filter(Boolean));
    if (roots.size !== 1) return [];
    let graph = sidecar ? compilerSidecarBaseTypeIndex(model, checkCancelled) : null;
    if (!sidecar) {
        const shapes = model.inventory?.shapes;
        if (!shapes || shapes.size > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return [];
        graph = { basesBySymbol: new Map(), subtypesByBase: new Map() };
        for (const [symbol, shape] of shapes) {
            checkCancelled();
            if (!shape.base) continue;
            const child = model.canonicalSymbolIds.get(symbol) || symbol;
            const base = model.canonicalSymbolIds.get(shape.base) || shape.base;
            const parents = graph.basesBySymbol.get(child) || new Set();
            parents.add(base);
            graph.basesBySymbol.set(child, parents);
            const children = graph.subtypesByBase.get(base) || new Set();
            children.add(child);
            graph.subtypesByBase.set(base, children);
        }
    }
    if (!graph) return [];
    const pending = [...roots], visited = new Set(roots);
    for (let index = 0; index < pending.length; index++) {
        checkCancelled();
        for (const child of graph.subtypesByBase.get(pending[index]) || []) {
            if (graph.basesBySymbol.get(child)?.size !== 1 || visited.has(child)) return [];
            visited.add(child);
            pending.push(child);
            if (pending.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return [];
        }
    }
    const descendants = pending.slice(1);
    const entries = sidecar ? compilerSidecarTypeHierarchyEntriesForSymbols(model, selection, descendants, checkCancelled) || []
        : descendants.flatMap((symbol) => nativeTypeFamily(model, symbol)).filter(isTypeHierarchyEntry);
    return [...new Map(entries.map((entry) => [`${entry.uri.toString()}:${entry.declaration.line}:${entry.declaration.startColumn}`,
        navigationEntryRecord(entry)])).values()];
}

function compilerSidecarTypeHierarchySelection(model, uri, document, position, checkCancelled) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(model.semanticBindings) ||
        model.semanticBindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    let selection = compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled);
    if (!selection?.symbol) return null;
    let declarations = compilerSidecarNavigationEntryRecords(model, selection, checkCancelled);
    if (!declarations.complete) return null;
    let entries = declarations.entries.filter(isTypeHierarchyEntry);
    if (!entries.length) {
        const typeSymbol = compilerSidecarTypeHierarchySymbol(
            compilerSidecarBaseTypeIndex(model, checkCancelled), selection.symbol
        );
        if (!typeSymbol) return null;
        selection = { ...selection, symbol: typeSymbol };
        declarations = compilerSidecarNavigationEntryRecords(model, selection, checkCancelled);
        if (!declarations.complete) return null;
        entries = declarations.entries.filter(isTypeHierarchyEntry);
    }
    return entries.length ? { ...selection, entries } : null;
}

function compilerSidecarTypeHierarchySymbol(index, symbol) {
    if (!index || !Number.isSafeInteger(symbol) || symbol < 1) return 0;
    let current = symbol;
    const visited = new Set();
    for (let depth = 0; depth < 8; depth++) {
        if (index.typeSymbols.has(current)) return current;
        if (visited.has(current)) return 0;
        visited.add(current);
        const subtypes = index.subtypesBySymbol.get(current);
        if (!subtypes || subtypes.size !== 1) return 0;
        current = subtypes.values().next().value;
    }
    return 0;
}

function compilerSidecarTypeHierarchyEntriesForSymbols(model, selection, symbols, checkCancelled) {
    const bindings = model.semanticBindings;
    if (!Array.isArray(symbols) || symbols.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS ||
        !Array.isArray(bindings) || bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    if (!symbols.length) return [];
    if (symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const requested = new Set(symbols);
    const parsedByPath = new Map();
    let parsedBytes = 0;
    const byLocation = new Map();

    for (let index = 0; index < bindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = bindings[index];
        if (!requested.has(binding.symbol) || binding.role !== "declaration" || binding.physical !== true ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath)) continue;
        const bindingPath = compilerSidecarNavigationPathKey(binding.filePath);
        const source = selection.sources.get(bindingPath);
        if (!source) return null;
        let declarations = parsedByPath.get(bindingPath);
        if (declarations === undefined) {
            const sourceBytes = Buffer.byteLength(source.text, "utf8");
            if (sourceBytes > MAX_COMPILER_SIDECAR_NAVIGATION_SOURCE_BYTES ||
                parsedBytes + sourceBytes > MAX_COMPILER_SIDECAR_TYPE_HIERARCHY_SOURCE_BYTES) return null;
            parsedBytes += sourceBytes;
            declarations = parseFreeBasicText(source.text).declarations || [];
            if (declarations.length > MAX_COMPILER_SIDECAR_NAVIGATION_DECLARATIONS) return null;
            parsedByPath.set(bindingPath, declarations);
        }
        const matched = semanticBindingToken(source, binding);
        if (!matched) return null;
        const candidates = declarations.filter((declaration) => declaration.line === matched.token.line &&
            declaration.startColumn === matched.token.startColumn && declaration.endColumn >= matched.token.endColumn &&
            normalizeIdentifier(String(declaration.name || "").split(".").at(-1)) === matched.token.key);
        if (candidates.length > 1) return null;
        const declaration = candidates[0];
        if (!declaration || !isTypeHierarchyEntry({ declaration })) continue;
        const name = source.text.slice(matched.start, matched.end);
        const entry = {
            id: `sidecar:${binding.symbol}:${source.uri.toString()}:${matched.start}`,
            name,
            compilerSymbolId: binding.symbol,
            compilerPreprocessorId: 0,
            uri: source.uri,
            declaration: {
                ...declaration,
                name,
                startColumn: matched.token.startColumn,
                endColumn: matched.token.endColumn,
                provisional: false,
                compilerMacroDefinition: "",
                modifiers: Array.isArray(declaration.modifiers) ? declaration.modifiers : [],
                parameters: Array.isArray(declaration.parameters) ? declaration.parameters : []
            }
        };
        const key = `${source.uri.toString()}:${matched.token.line}:${matched.token.startColumn}:${matched.token.endColumn}`;
        const previous = byLocation.get(key);
        if (previous && previous.compilerSymbolId !== binding.symbol) return null;
        byLocation.set(key, entry);
        if (byLocation.size > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
    }
    return [...byLocation.values()];
}

function compilerSidecarTypeDefinitionRecords(model, uri, document, position, checkCancelled, includeBases = false) {
    if (!model.semanticSidecarOnly || model.partial) return [];
    const sources = compilerSidecarNavigationSources(model);
    const selection = compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled);
    const typeIndex = compilerSidecarBaseTypeIndex(model, checkCancelled);
    if (!typeIndex) return [];
    const selectedType = selection?.symbol
        ? compilerSidecarTypeHierarchySymbol(typeIndex, selection.symbol)
        : 0;
    const expression = model.compilerSidecarFactAt?.(uri, position, position);
    const expressionType = expression?.compilerSidecarSubtypeId
        ? compilerSidecarTypeHierarchySymbol(typeIndex, expression.compilerSidecarSubtypeId)
        : 0;
    if (selectedType && expressionType && selectedType !== expressionType) return [];
    const symbol = selectedType || expressionType;
    if (!symbol) return [];
    const declarationSelection = selection?.sources
        ? { ...selection, symbol }
        : { symbol, sources };
    const symbols = [symbol];
    if (includeBases) {
        const visited = new Set(symbols);
        let current = symbol;
        while (typeIndex.basesBySymbol.has(current)) {
            checkCancelled();
            const bases = typeIndex.basesBySymbol.get(current);
            if (bases.size !== 1 || symbols.length >= MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return [];
            current = bases.values().next().value;
            if (visited.has(current)) return [];
            visited.add(current);
            symbols.push(current);
        }
    }
    const entries = compilerSidecarTypeHierarchyEntriesForSymbols(
        model, declarationSelection, symbols, checkCancelled
    );
    if (includeBases) {
        const bySymbol = new Map();
        for (const entry of entries || []) {
            if (bySymbol.has(entry.compilerSymbolId)) return [];
            bySymbol.set(entry.compilerSymbolId, entry);
        }
        if (!bySymbol.has(symbol)) return [];
        // Builtin bases without physical declarations have no source members.
        return symbols.filter((id) => bySymbol.has(id)).map((id) => entryRecord(bySymbol.get(id)));
    }
    return entries?.map(navigationEntryRecord) || [];
}

function compilerSidecarTypeHierarchySupertypes(model, selection, checkCancelled) {
    const baseTypes = compilerSidecarTypeHierarchyBaseTypes(model, checkCancelled);
    if (!baseTypes) return [];
    const bases = baseTypes.basesBySymbol.get(selection.symbol);
    if (!bases || bases.size !== 1) return [];
    const [base] = bases;
    const entries = compilerSidecarTypeHierarchyEntriesForSymbols(model, selection, [base], checkCancelled);
    return entries || [];
}

function compilerSidecarTypeHierarchySubtypes(model, selection, checkCancelled) {
    const baseTypes = compilerSidecarTypeHierarchyBaseTypes(model, checkCancelled);
    if (!baseTypes) return [];
    const symbols = [...(baseTypes.subtypesByBase.get(selection.symbol) || [])];
    if (symbols.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS ||
        symbols.some((symbol) => baseTypes.basesBySymbol.get(symbol)?.size !== 1)) return [];
    return compilerSidecarTypeHierarchyEntriesForSymbols(model, selection, symbols, checkCancelled) || [];
}

function compilerSidecarTypeHierarchyBaseTypes(model, checkCancelled) {
    return compilerSidecarBaseTypeIndex(model, checkCancelled);
}

function callHierarchyEntryKey(model, entry) {
    if (entry?.compilerProcedureId) return `procedure:${entry.compilerProcedureId}`;
    if (["operator", "constructor", "destructor"].includes(entry?.declaration?.type) && entry.compilerSymbolId) {
        return `${entry.declaration.type}:${nativeSymbolId(model, entry)}`;
    }
    return "";
}

function isCallHierarchyImplementation(entry) {
    return entry.bodyScope && entry.bodyScope.kind !== "prototype" &&
        !entry.declaration.modifiers.includes("DECLARE");
}

function callHierarchyEntries(model, targets, checkCancelled) {
    const result = new Map();
    for (const entry of targets) {
        checkCancelled();
        if (!CALL_HIERARCHY_TYPES.has(entry.declaration.type) || entry.provisional) continue;
        const key = callHierarchyEntryKey(model, entry);
        if (!key) continue;
        const current = result.get(key);
        if (!current || !isCallHierarchyImplementation(current) && isCallHierarchyImplementation(entry)) result.set(key, entry);
    }
    return [...result.values()];
}

function callHierarchyBodyEntries(model, selectedKeys = null) {
    const result = new Map();
    for (const entry of model.inner.entries) {
        const key = callHierarchyEntryKey(model, entry);
        if (!key || selectedKeys && !selectedKeys.has(key) || !isCallHierarchyImplementation(entry)) continue;
        result.set(entry.bodyScope, entry);
    }
    return result;
}

function procedureForExpandedOffset(model, offset, bodyEntries) {
    const document = model.inner.getDocument(model.expandedUri);
    for (let scope = scopeAt(document, offset); scope; scope = scope.parent) {
        const entry = bodyEntries.get(scope);
        if (entry) return entry;
    }
    return null;
}

function isModuleCallSite(model, offset) {
    const document = model.inner.getDocument(model.expandedUri);
    for (let scope = scopeAt(document, offset); scope; scope = scope.parent) {
        if (NON_MODULE_CALL_SCOPES.has(scope.kind)) return false;
    }
    return true;
}

/* Keep physical header presentation across prepared/incoming/outgoing items
   without changing the native identity that selected the callable. */
function callHierarchyEntryRecord(model, entry, includeQualifiedName = false) {
    const record = entryRecord(entry, false, includeQualifiedName);
    const declaration = entry.declaration;
    const source = model.getDocument(entry.uri);
    if (declaration.type === "operator" && source) {
        // Preprocessing can normalize a prototype's spelling. A uniquely
        // matching physical header keeps the same caption used by later
        // declaration queries and their stale-item signature guard.
        const headers = (compilerSidecarNavigationSourceDeclarations(model, source) || []).filter((header) =>
            header.type === "operator" && header.line === declaration.line &&
            header.startColumn <= declaration.startColumn && header.endColumn >= declaration.endColumn);
        if (headers.length === 1) {
            record.name = headers[0].name;
            record.declaration.signature = headers[0].signature;
            record.declaration.startColumn = headers[0].startColumn;
            record.declaration.endColumn = headers[0].endColumn;
            record.declaration.modifiers = headers[0].modifiers;
        }
    }
    if (!["constructor", "destructor"].includes(declaration.type)) return record;
    const keywords = (source?.byLine.get(declaration.line) || []).filter((token) =>
        token.key === declaration.type && token.startColumn <= declaration.startColumn && token.endColumn <= declaration.endColumn);
    if (keywords.length === 1) {
        record.declaration.startColumn = keywords[0].startColumn;
        record.declaration.endColumn = keywords[0].endColumn;
    }
    return record;
}

function moduleCallHierarchyRecord(uri, document) {
    const filePath = uri.fsPath || uri.path || uri.toString();
    const name = filePath.split(/[\\/]/).pop() || filePath;
    const lines = document?.text.split(/\r\n|\n|\r/) || [""];
    return {
        id: `module:${uri.toString()}`,
        name,
        uri: uriRecord(uri),
        declaration: {
            name,
            type: "module",
            detail: CALL_HIERARCHY_MODULE_DETAIL,
            signature: "",
            line: 0,
            startColumn: 0,
            endLine: Math.max(0, lines.length - 1),
            endColumn: lines.at(-1).length,
            provisional: false,
            modifiers: [],
            parameters: []
        }
    };
}

function sourceCallHierarchySite(model, binding, bodyEntries, checkCancelled) {
    checkCancelled();
    if (binding.kind !== "call") return null;
    if (model.isUnevaluatedExpandedOffset?.(binding.token.offset)) return null;
    const caller = procedureForExpandedOffset(model, binding.token.offset, bodyEntries);
    const physical = model.expandedToSource.get(binding.token.offset);
    if (physical?.fromMacroDefinition) return null;
    if (!physical || caller && physical.uri.toString() !== caller.uri.toString()) return null;
    if (!caller && !isModuleCallSite(model, binding.token.offset)) return null;
    return { caller, physical };
}

function implicitCallHierarchySites(model, references, bodyEntries, checkCancelled) {
    const expanded = model.inner.getDocument(model.expandedUri);
    if (!expanded) return [];
    const result = new Map();
    for (const reference of references) {
        checkCancelled();
        const occurrence = reference.occurrence;
        const positions = model.projectPositions(reference.uri, occurrence.line, occurrence.startColumn, false, true);
        for (const position of positions) {
            const offset = positionOffset(expanded, position.line, position.character);
            if (model.isUnevaluatedExpandedOffset?.(offset)) continue;
            const caller = procedureForExpandedOffset(model, offset, bodyEntries);
            if (caller && caller.uri.toString() !== reference.uri.toString()) continue;
            if (!caller && !isModuleCallSite(model, offset)) continue;
            const key = `${caller ? callHierarchyEntryKey(model, caller) : `module:${reference.uri.toString()}`}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine ?? occurrence.line}:${occurrence.endColumn}`;
            result.set(key, { caller, physical: reference });
        }
    }
    return [...result.values()];
}

function implicitIndexCallSites(model, target, bodyEntries, checkCancelled) {
    return implicitCallHierarchySites(model,
        compilerIndexOperatorReferences(model, target, null, checkCancelled), bodyEntries, checkCancelled);
}

function implicitLifetimeCallSites(model, bodyEntries, checkCancelled) {
    if (!model.semanticImplicitCalls?.length && !model.expressionGraph?.nodes?.length) return [];
    const targets = callHierarchyEntries(model, model.inner.entries.filter((entry) =>
        ["constructor", "destructor"].includes(entry.declaration.type) && entry.compilerSymbolId
    ), checkCancelled);
    const sites = [];
    // Incoming and outgoing trees must share the same selected targets,
    // physical ranges, and owning scopes, including implicit cleanup.
    for (const callee of targets) {
        checkCancelled();
        const references = compilerLifetimeReferences(model, callee, null, checkCancelled);
        for (const site of implicitCallHierarchySites(model, references, bodyEntries, checkCancelled)) {
            sites.push({ ...site, callee });
        }
    }
    return sites;
}

function callHierarchyIncoming(model, targets, checkCancelled) {
    const procedures = callHierarchyEntries(model, targets, checkCancelled);
    const targetIds = new Set(procedures.map((entry) => entry.compilerProcedureId).filter(Boolean));
    const indexOperators = procedures.filter((entry) => isIndexOperatorEntry(entry) && entry.compilerSymbolId);
    const lifetimes = procedures.filter((entry) => ["constructor", "destructor"].includes(entry.declaration.type) && entry.compilerSymbolId);
    if (!targetIds.size && !indexOperators.length && !lifetimes.length) return [];
    const bodyEntries = callHierarchyBodyEntries(model);
    const callers = new Map();
    const addCaller = (site) => {
        const occurrence = site.physical.occurrence;
        const key = site.caller
            ? callHierarchyEntryKey(model, site.caller)
            : `module:${site.physical.uri.toString()}`;
        const group = callers.get(key) || { entry: site.caller, uri: site.physical.uri, ranges: new Map() };
        group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine ?? occurrence.line}:${occurrence.endColumn}`, occurrence);
        callers.set(key, group);
    };
    for (const binding of model.procedureBindings || []) {
        checkCancelled();
        if (!targetIds.has(binding.id)) continue;
        const site = sourceCallHierarchySite(model, binding, bodyEntries, checkCancelled);
        if (!site) continue;
        addCaller(site);
    }
    for (const target of indexOperators) {
        checkCancelled();
        for (const site of implicitIndexCallSites(model, target, bodyEntries, checkCancelled)) addCaller(site);
    }
    for (const target of lifetimes) {
        checkCancelled();
        const references = compilerLifetimeReferences(model, target, null, checkCancelled);
        for (const site of implicitCallHierarchySites(model, references, bodyEntries, checkCancelled)) addCaller(site);
    }
    return [...callers.values()].map((group) => ({
        ...(group.entry ? callHierarchyEntryRecord(model, group.entry) : moduleCallHierarchyRecord(
            group.uri, model.inner.getDocument(group.uri)
        )),
        fromRanges: [...group.ranges.values()]
    }));
}

function callHierarchyOutgoing(model, targets, checkCancelled) {
    const callers = callHierarchyEntries(model, targets, checkCancelled);
    const callerKeys = new Set(callers.map((entry) => callHierarchyEntryKey(model, entry)));
    if (!callerKeys.size) return [];
    const bodyEntries = callHierarchyBodyEntries(model, callerKeys);
    const entriesByProcedureId = new Map();
    for (const entry of model.inner.entries) {
        if (!entry.compilerProcedureId || !CALL_HIERARCHY_TYPES.has(entry.declaration.type)) continue;
        const family = entriesByProcedureId.get(entry.compilerProcedureId) || [];
        family.push(entry);
        entriesByProcedureId.set(entry.compilerProcedureId, family);
    }
    const callees = new Map();
    const addCallee = (entry, occurrence) => {
        if (!entry || entry.provisional) return;
        const key = callHierarchyEntryKey(model, entry);
        if (!key) return;
        const group = callees.get(key) || { entry, ranges: new Map() };
        group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine ?? occurrence.line}:${occurrence.endColumn}`, occurrence);
        callees.set(key, group);
    };
    for (const binding of model.procedureBindings || []) {
        checkCancelled();
        if (binding.kind !== "call") continue;
        const site = sourceCallHierarchySite(model, binding, bodyEntries, checkCancelled);
        if (!site || !site.caller || !callerKeys.has(callHierarchyEntryKey(model, site.caller))) continue;
        const family = entriesByProcedureId.get(binding.id) || [];
        const callee = family.find((entry) => entry.bodyScope && entry.bodyScope.kind !== "prototype" && !entry.declaration.modifiers.includes("DECLARE")) || family[0];
        addCallee(callee, site.physical.occurrence);
    }
    const indexOperators = callHierarchyEntries(model,
        model.inner.entries.filter((entry) => isIndexOperatorEntry(entry) && entry.compilerSymbolId), checkCancelled)
        .filter((entry) => isIndexOperatorEntry(entry));
    for (const callee of indexOperators) {
        checkCancelled();
        for (const site of implicitIndexCallSites(model, callee, bodyEntries, checkCancelled)) {
            if (!site.caller || !callerKeys.has(callHierarchyEntryKey(model, site.caller))) continue;
            addCallee(callee, site.physical.occurrence);
        }
    }
    for (const site of implicitLifetimeCallSites(model, bodyEntries, checkCancelled)) {
        if (!site.caller || !callerKeys.has(callHierarchyEntryKey(model, site.caller))) continue;
        addCallee(site.callee, site.physical.occurrence);
    }
    return [...callees.values()].map((group) => ({
        ...callHierarchyEntryRecord(model, group.entry),
        fromRanges: [...group.ranges.values()]
    }));
}

function callHierarchyModuleOutgoing(model, uri, checkCancelled) {
    const bodyEntries = callHierarchyBodyEntries(model);
    const entriesByProcedureId = new Map();
    for (const entry of model.inner.entries) {
        if (!entry.compilerProcedureId || !CALL_HIERARCHY_TYPES.has(entry.declaration.type)) continue;
        const family = entriesByProcedureId.get(entry.compilerProcedureId) || [];
        family.push(entry);
        entriesByProcedureId.set(entry.compilerProcedureId, family);
    }
    const callees = new Map();
    const addCallee = (entry, occurrence) => {
        if (!entry || entry.provisional) return;
        const key = callHierarchyEntryKey(model, entry);
        if (!key) return;
        const group = callees.get(key) || { entry, ranges: new Map() };
        group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine ?? occurrence.line}:${occurrence.endColumn}`, occurrence);
        callees.set(key, group);
    };
    for (const binding of model.procedureBindings || []) {
        checkCancelled();
        const site = sourceCallHierarchySite(model, binding, bodyEntries, checkCancelled);
        if (!site || site.caller || site.physical.uri.toString() !== uri.toString()) continue;
        const family = entriesByProcedureId.get(binding.id) || [];
        const callee = family.find((entry) => entry.bodyScope && entry.bodyScope.kind !== "prototype" &&
            !entry.declaration.modifiers.includes("DECLARE")) || family[0];
        addCallee(callee, site.physical.occurrence);
    }
    const indexOperators = callHierarchyEntries(model,
        model.inner.entries.filter((entry) => isIndexOperatorEntry(entry) && entry.compilerSymbolId), checkCancelled)
        .filter((entry) => isIndexOperatorEntry(entry));
    for (const callee of indexOperators) {
        checkCancelled();
        for (const site of implicitIndexCallSites(model, callee, bodyEntries, checkCancelled)) {
            if (site.caller || site.physical.uri.toString() !== uri.toString()) continue;
            addCallee(callee, site.physical.occurrence);
        }
    }
    for (const site of implicitLifetimeCallSites(model, bodyEntries, checkCancelled)) {
        if (site.caller || site.physical.uri.toString() !== uri.toString()) continue;
        addCallee(site.callee, site.physical.occurrence);
    }
    return [...callees.values()].map((group) => ({
        ...callHierarchyEntryRecord(model, group.entry),
        fromRanges: [...group.ranges.values()]
    }));
}

function isIndexOperatorEntry(entry) {
    if (entry?.declaration?.type !== "operator") return false;
    const name = String(entry.name || entry.declaration.name).replace(/\s+/g, "").toLowerCase();
    return name === "operator[]" || name === "[" || name === "[]";
}

function selectedDeclarationEntries(model, entries) {
    return [...new Map(entries.flatMap((entry) => model.declarationTargets([entry]))
        .map((entry) => [entry.id, entry])).values()];
}

function compilerConstructorDeclarationSources(model, target) {
    if (target?.declaration?.type !== "constructor") return model.declarationSources([target]);
    const targetId = nativeSymbolId(model, target);
    const family = model.inner.entries.filter((entry) => entry.declaration.type === "constructor" &&
        targetId && nativeSymbolId(model, entry) === targetId);
    const declarations = family.filter((entry) => entry.declaration.modifiers.includes("DECLARE") ||
        entry.declaration.parentDeclaration?.modifiers.includes("DECLARE"));
    return declarations.length ? declarations : [target];
}

function selectedIndexOperatorEntries(model, entries) {
    return selectedDeclarationEntries(model, entries);
}

function indexOperatorCandidates(model, uri, document, context) {
    const receiver = document.tokens.filter((token) => token.end <= context.openParenthesisOffset).at(-1);
    if (!receiver || receiver.kind !== "identifier") return [];
    const resolved = model.resolveAt(uri, receiver.line, receiver.startColumn);
    const selected = resolved.filter(isIndexOperatorEntry);
    if (selected.length) return selected;
    const types = resolved.flatMap((entry) => model.typeEntries(entry));
    if (!types.length || !model.inner) return [];
    const projected = model.projectPosition(uri, receiver.line, receiver.startColumn);
    if (!projected) return [];
    const expanded = model.inner.getDocument(model.expandedUri);
    const offset = positionOffset(expanded, projected.line, projected.character);
    const scope = scopeAt(expanded, offset);
    return model.inner.members(types, expanded, scope).filter(isIndexOperatorEntry);
}

function recoveredIndexSignatureEntries(model, uri, document, context, checkCancelled) {
    if (!model.partial || model.semanticSidecarOnly || !model.inventory) return [];
    const receiver = document.tokens.filter((token) => token.end <= context.openParenthesisOffset).at(-1);
    if (receiver?.kind !== "identifier") return [];
    const values = compilerVisibleSignatureEntries(model, uri, receiver, checkCancelled);
    if (values.some((entry) => !entry.nativeSymbol || entry.provisional || entry.declaration.provisional ||
        !["variable", "field", "parameter", "const", "extern"].includes(entry.declaration.type) ||
        model.inventory.shapes.get(entry.nativeSymbol.id)?.dimensions !== 0 ||
        /\b(?:ptr|pointer)\s*$/i.test(entry.nativeSymbol.typeName || ""))) return [];
    let types = values.flatMap((entry) => model.typeEntries(entry));
    if (!values.length) {
        // Implicit THIS has no ordinary visible-variable declaration. Reuse
        // an independently valid exact receiver type, never infer it merely
        // from the spelling or the surrounding class/static method.
        const typed = model.expressionAt(uri, { line: receiver.line, character: receiver.startColumn },
            { line: receiver.line, character: receiver.endColumn });
        if (!typed || typed.provisional || !typed.subtype || /\b(?:ptr|pointer)\s*$/i.test(typed.typeName || "")) return [];
        types = model.nativeTypeEntries(typed.typeName, typed.subtype);
    }
    types = types.filter((entry) => TYPE_HIERARCHY_TYPES.has(entry.declaration.type) && !entry.provisional && !entry.declaration.provisional);
    if (!types.length || new Set(types.map((entry) => nativeSymbolId(model, entry))).size !== 1) return [];
    const positions = model.projectPositions(uri, receiver.line, receiver.endColumn, false, true);
    if (!positions.length || positions.length > MAX_SIGNATURE_RECOVERY_CANDIDATES) return [];
    const expanded = model.inner.getDocument(model.expandedUri);
    // Surviving receiver declarations can describe an overload list, not the
    // result or selected target of the unfinished index expression. Keep each
    // projected native caller scope's access restrictions in the intersection.
    return selectedIndexOperatorEntries(model, model.commonProjectedEntries(positions, (position) => {
        checkCancelled();
        const scope = scopeAt(expanded, positionOffset(expanded, position.line,
            Math.min(position.character, position.token?.endColumn ?? position.character)));
        for (let current = scope; current; current = current.parent) if (current.recovered) return [];
        return model.nativeMembers(types, scope).filter((entry) => isIndexOperatorEntry(entry) &&
            !entry.provisional && !entry.declaration.provisional);
    }));
}

function indexOperatorDeclarationAt(model, uri, position) {
    const source = model.getDocument(uri);
    if (!source) return [];
    return model.inner.entries.filter((entry) =>
        isIndexOperatorEntry(entry) && entry.compilerSymbolId && entry.uri.toString() === uri.toString() &&
        entry.declaration.line === position.line && position.character >= entry.declaration.startColumn &&
        position.character <= entry.declaration.endColumn
    );
}

function compilerSelectedIndexOperatorTarget(model, uri, fact, checkCancelled = () => {}) {
    checkCancelled();
    if (selectedIndexOperatorTargets.has(fact)) return selectedIndexOperatorTargets.get(fact);
    const reject = () => {
        selectedIndexOperatorTargets.set(fact, 0);
        return 0;
    };
    if (fact.provisional || !model.expressionGraph?.nodes?.length || !model.expressionAtTraceOnly) return reject();

    const expression = model.expressionAtTraceOnly(uri, fact.start, fact.end);
    if (!expression?.compilerExpressionId || expression.provisional) return reject();
    const expanded = model.inner?.getDocument(model.expandedUri);
    if (!expanded) return reject();
    const rootStart = positionOffset(expanded, expression.start.line, expression.start.character);
    const rootEnd = positionOffset(expanded, expression.end.line, expression.end.character);
    const nodes = expressionGraphNodeIndex(model.expressionGraph, checkCancelled);
    let selectedTarget = 0;

    for (const expressionId of expression.compilerExpressionIds || [expression.compilerExpressionId]) {
        checkCancelled();
        const pending = [expressionId];
        const visited = new Set();
        const calls = [];
        let visitedCount = 0;
        while (pending.length) {
            if (visitedCount++ % COMPILER_QUERY_CANCELLATION_INTERVAL === 0) checkCancelled();
            const identity = pending.pop();
            if (!identity || visited.has(identity)) continue;
            visited.add(identity);
            const node = nodes.get(identity);
            if (!node) continue;
            if (node.kind === "call" && Number.isSafeInteger(node.target) && node.target > 0 && node.start && node.end) {
                const start = positionOffset(expanded, node.start.line, node.start.character);
                const end = positionOffset(expanded, node.end.line, node.end.character);
                /* The operator call starts at the receiver and covers its
                   index arguments. A call used to produce the receiver shares
                   that start but ends earlier, so retain the widest match. */
                if (start === rootStart && end >= start && end <= rootEnd) calls.push({ end, target: node.target });
            }
            pending.push(...(node.inputs || []));
        }
        if (!calls.length) return reject();
        let furthestEnd = -1;
        for (const call of calls) if (call.end > furthestEnd) furthestEnd = call.end;
        const targets = new Set(calls.filter((call) => call.end === furthestEnd)
            .map((call) => model.canonicalSymbolIds?.get(call.target) || call.target));
        if (targets.size !== 1) return reject();
        const [target] = targets;
        if (selectedTarget && selectedTarget !== target) return reject();
        selectedTarget = target;
    }

    selectedIndexOperatorTargets.set(fact, selectedTarget);
    return selectedTarget;
}

function compilerSelectedIndexOperatorCandidates(model, uri, document, position, entries, checkCancelled) {
    const offset = positionOffset(document, position.line, position.character);
    const facts = model.compilerSidecarExpressions?.get(uri.toString()) || [];
    const fact = facts.find((candidate) => candidate.operatorCode === "index" &&
        candidate.operatorKind === "overloaded" && candidate.startOffset <= offset && candidate.endOffset > offset);
    if (!fact) return [];
    const target = compilerSelectedIndexOperatorTarget(model, uri, fact, checkCancelled);
    if (!target) return [];

    const canonicalSymbol = (entry) => model.canonicalSymbolIds?.get(entry.compilerSymbolId) || entry.compilerSymbolId || 0;
    const selected = new Set(entries.map(canonicalSymbol).filter((identity) => identity === target));
    if (selected.size !== 1) return [];
    return entries.filter((entry) => canonicalSymbol(entry) === target);
}

function compilerIndexExpressionAt(model, uri, document, position) {
    if (!model.expressionAtTraceOnly) return null;
    const offset = positionOffset(document, position.line, position.character);
    const facts = model.compilerSidecarExpressions?.get(uri.toString()) || [];
    /* A point query would normally choose the nested index argument fact. For
       Type Definition, use the enclosing index operation's result instead. */
    const fact = facts.find((candidate) => candidate.operatorCode === "index" &&
        candidate.startOffset <= offset && candidate.endOffset > offset);
    if (!fact || fact.provisional) return null;
    const expression = model.expressionAtTraceOnly(uri, fact.start, fact.end);
    if (expression && !expression.provisional) return expression;
    const sidecarFact = model.compilerSidecarFactAt?.(uri, fact.start, fact.end);
    return sidecarFact && !sidecarFact.provisional ? sidecarFact : null;
}

function compilerIndexOperatorReferences(model, target, currentUri, checkCancelled) {
    if (!isIndexOperatorEntry(target) || !target.compilerSymbolId) return [];
    const selectedTarget = model.canonicalSymbolIds?.get(target.compilerSymbolId) || target.compilerSymbolId;
    const found = new Map();
    for (const [uri, facts] of model.compilerSidecarExpressions || []) {
        if (currentUri && uri !== currentUri.toString()) continue;
        const source = model.sources.get(uri);
        if (!source) continue;
        for (const fact of facts) {
            checkCancelled();
            if (fact.operatorCode !== "index" || fact.operatorKind !== "overloaded") continue;
            if (compilerSelectedIndexOperatorTarget(model, source.uri, fact, checkCancelled) !== selectedTarget) continue;
            const occurrence = {
                line: fact.start.line,
                startColumn: fact.start.character,
                endLine: fact.end.line,
                endColumn: fact.end.character
            };
            found.set(`${uri}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, {
                uri: source.uri,
                occurrence
            });
        }
    }
    return [...found.values()];
}

function constructorEntries(model, uri, document, context, recoveredTypes = null) {
    const receiver = document.tokens.filter((token) => token.end <= context.openParenthesisOffset).at(-1);
    if (!receiver || receiver.kind !== "identifier") return [];
    const resolved = recoveredTypes || model.resolveAt(uri, receiver.line, receiver.startColumn);
    if (recoveredTypes && (model.semanticSidecarOnly || !model.inventory || resolved.some((entry) =>
        !entry.nativeSymbol || entry.provisional || entry.declaration.provisional ||
        /\b(?:ptr|pointer)\s*$/i.test(entry.nativeSymbol.typeName || "")))) return [];
    const types = resolved.filter((entry) => ["type", "class", "union"].includes(entry.declaration.type))
        .flatMap((entry) => model.typeEntries(entry))
        .filter((entry) => ["type", "class", "union"].includes(entry.declaration.type));
    if (!types.length) return [];
    if (recoveredTypes) {
        if (new Set(types.map((entry) => nativeSymbolId(model, entry))).size !== 1) return [];
        const positions = model.projectPositions(uri, receiver.line, receiver.endColumn, false, true);
        if (!positions.length || positions.length > MAX_SIGNATURE_RECOVERY_CANDIDATES) return [];
        const expanded = model.inner.getDocument(model.expandedUri);
        // This is a signature-only use of native declarations, not a value
        // binding or a committed constructor call. Intersect caller contexts
        // and apply native access before presenting an overload family.
        return selectedDeclarationEntries(model, model.commonProjectedEntries(positions, (position) => {
            const offset = positionOffset(expanded, position.line,
                Math.min(position.character, position.token?.endColumn ?? position.character));
            const scope = scopeAt(expanded, offset);
            for (let current = scope; current; current = current.parent) if (current.recovered) return [];
            if (document.tokens[receiver.index - 1]?.name !== ".") {
                // Completion folds equal names. Distinct imported type owners
                // do not become one constructor family merely because that
                // completion representative has the right spelling.
                const owners = new Set(model.inner.resolveName(expanded, receiver.name, scope, offset).filter((entry) =>
                    entry.nativeSymbol && !entry.provisional && !entry.declaration.provisional &&
                    ["type", "class", "union"].includes(entry.declaration.type) && entry.offset <= offset &&
                    model.nativeAccess(entry, scope)).map((entry) => entry.nativeSymbol.owner));
                if (owners.size > 1) return [];
            }
            return model.nativeMembers(types, scope).filter((entry) => entry.declaration.type === "constructor" &&
                !entry.provisional && !entry.declaration.provisional);
        }));
    }
    const projected = model.projectPosition(uri, receiver.line, receiver.startColumn);
    if (!projected) return [];
    const expanded = model.inner.getDocument(model.expandedUri);
    const scope = scopeAt(expanded, positionOffset(expanded, projected.line, projected.character));
    return selectedDeclarationEntries(model,
        model.inner.members(types, expanded, scope).filter((entry) => entry.declaration.type === "constructor"));
}

function recoveredTypedConstructorEntries(model, uri, document, context, checkCancelled) {
    if (!model.partial || model.semanticSidecarOnly || !model.inventory) return [];
    let start = context.typeArgumentStartOffset, end = context.typeArgumentEndOffset;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start ||
        end > document.masked.length || end - start > MAX_SIGNATURE_CALLEE_CHARACTERS) return [];
    const operand = document.masked.slice(start, end);
    const typeOf = /^\s*typeof\s*\(/i.exec(operand);
    if (typeOf) {
        const keywordStart = start + typeOf[0].search(/\btypeof\b/i);
        const keyword = document.tokens.find((token) => token.offset === keywordStart && token.kind === "identifier");
        if (!keyword) return [];
        // A native data/macro binding is not the TYPEOF keyword.
        const visible = model.visibleEntries?.(uri, keyword.line, keyword.endColumn,
            MAX_SIGNATURE_RECOVERY_CANDIDATES, keyword.name) || [];
        if (visible.some((entry) => entry.key === keyword.key && (entry.nativeSymbol || entry.compilerPreprocessorId))) return [];
        while (end > start && /\s/.test(document.masked[end - 1])) end--;
        if (document.masked[end - 1] !== ")") return [];
        start += typeOf[0].length;
        end--;
    }
    while (start < end && /\s/.test(document.masked[start])) start++;
    while (end > start && /\s/.test(document.masked[end - 1])) end--;
    const namedOperand = /^\.?[ \t]*[A-Za-z_][A-Za-z_0-9$%!#&]*(?:[ \t]*\.[ \t]*[A-Za-z_][A-Za-z_0-9$%!#&]*)*$/;
    const groupedValue = typeOf && document.masked[start] === "(" && document.masked[end - 1] === ")" &&
        namedOperand.test(document.masked.slice(start + 1, end - 1).trim());
    if (groupedValue) {
        start++;
        end--;
        while (start < end && /\s/.test(document.masked[start])) start++;
        while (end > start && /\s/.test(document.masked[end - 1])) end--;
    }
    const emptyCall = typeOf && !groupedValue && /\(\s*\)$/.exec(document.masked.slice(start, end));
    if (emptyCall) {
        // The code mask also blanks strings. Keep literal arguments from
        // masquerading as an empty list while still allowing real comments.
        if (!/^\(\s*\)$/.test(maskFreeBasicComments(document.text.slice(start + emptyCall.index, end)))) return [];
        end = start + emptyCall.index;
        while (end > start && /\s/.test(document.masked[end - 1])) end--;
    }
    if (!namedOperand.test(document.masked.slice(start, end))) return [];
    const receiver = document.tokens.find((token) => token.end === end && token.kind === "identifier");
    if (!receiver) return [];
    const entries = compilerVisibleSignatureEntries(model, uri, receiver, checkCancelled);
    const valueKinds = ["variable", "field", "parameter", "const", "extern"];
    const allowedKinds = emptyCall ? ["function"] : groupedValue ? valueKinds
        : typeOf ? ["type", "class", "union", ...valueKinds] : ["type", "class", "union"];
    if (!entries.length || entries.some((entry) => !entry.nativeSymbol || entry.provisional || entry.declaration.provisional ||
        /\b(?:ptr|pointer)\s*$/i.test(entry.nativeSymbol.typeName || "") ||
        !allowedKinds.includes(entry.declaration.type))) return [];
    // An empty factory call can reuse one native routine's declared return
    // type. Do not resolve overloads or assume missing required arguments.
    if (emptyCall) {
        const routineIds = new Set(entries.map((entry) => nativeSymbolId(model, entry)));
        const routineId = routineIds.values().next().value;
        if (routineIds.size !== 1 || !Number.isSafeInteger(routineId) || routineId < 1 ||
            entries.some((entry) => !Array.isArray(entry.declaration.parameters) ||
                entry.declaration.parameters.some((parameter) => parameter.optional !== true))) return [];
    }
    // TYPEOF operands reuse the native declaration's actual type.
    // This recovers a signature family, not the unfinished expression or a
    // committed overload. Other complex operands still need type receipts.
    const types = typeOf ? entries.flatMap((entry) => model.typeEntries(entry)) : entries;
    return constructorEntries(model, uri, document, { ...context, openParenthesisOffset: receiver.end }, types);
}

function constructorCompletionParameters(model, uri, document, position, entries, prefix, checkCancelled) {
    const normalizedPrefix = prefix.toLowerCase();
    const matches = entries.filter((entry) => {
        checkCancelled();
        const declaration = entry.declaration;
        const name = entry.name || declaration.name;
        return ["type", "class", "union"].includes(declaration.type) &&
            !entry.conditional && !entry.provisional && !declaration.provisional &&
            typeof name === "string" && name.toLowerCase().startsWith(normalizedPrefix);
    });
    if (matches.length !== 1 || !model.inner) return null;

    const completionModel = matches[0].completionSemanticModel || model;
    const types = completionModel.typeEntries(matches[0]);
    const expanded = completionModel.inner
        ? completionModel.inner.getDocument(completionModel.expandedUri)
        : completionModel.getDocument(uri);
    const projected = completionModel === model
        ? (model.projectPosition(uri, position.line, position.character) ||
            (expanded?.text === document.text ? position : null))
        : position;
    if (!types.length || !expanded || !projected) return null;
    const scope = scopeAt(expanded, positionOffset(expanded, projected.line, projected.character));
    const members = completionModel.inner
        ? completionModel.inner.members(types, expanded, scope)
        : completionModel.members(types, expanded, scope);
    const constructors = [...new Map(members.filter((entry) => entry.declaration.type === "constructor")
        .flatMap((entry) => completionModel.declarationTargets([entry]))
        .map((entry) => [entry.id, entry])).values()];
    if (constructors.length !== 1 || constructors[0].conditional || constructors[0].provisional ||
        constructors[0].declaration.provisional || !constructors[0].declaration.parameters?.length) return null;
    return { typeId: matches[0].id, parameters: constructors[0].declaration.parameters };
}

function constructorTypeCompletionParts(document, position) {
    const lineStart = document.lineOffsets[position.line];
    if (!Number.isSafeInteger(lineStart)) return null;
    const prefix = document.text.slice(lineStart, lineStart + position.character);
    const match = /((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)$/.exec(prefix);
    if (!match) return null;
    const before = prefix.slice(0, match.index).trimEnd();
    const kind = /\bNEW$/i.test(before)
        ? "new"
        : /\b(?:RETURN|PRINT)$/i.test(before) || /[=(,]$/.test(before) ? "expression" : "";
    if (!kind) return null;
    const names = match[1].split(".");
    return {
        kind,
        name: names.at(-1),
        qualifier: names.length > 1 ? names.slice(0, -1).join(".") : ""
    };
}

function newTypeCompletionPrefix(document, position) {
    const parts = constructorTypeCompletionParts(document, position);
    return parts?.kind === "new" ? parts.name : "";
}

function explicitTypeConstructorCompletionPrefix(document, position) {
    const parts = constructorTypeCompletionParts(document, position);
    return parts?.kind === "expression" ? parts.name : "";
}

function constructorTypeCompletionQualifier(document, position) {
    return constructorTypeCompletionParts(document, position)?.qualifier || "";
}

function positionAtOffset(document, offset) {
    let low = 0;
    let high = document.lineOffsets.length;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (document.lineOffsets[middle] <= offset) low = middle;
        else high = middle;
    }
    return { line: low, character: offset - document.lineOffsets[low] };
}

function compilerSelectedCallTarget(model, uri, document, context, checkCancelled) {
    if (!model.expressionAtTraceOnly || !model.expressionGraph?.nodes?.length) return 0;
    const calleeSpan = callNameSpan(document, context);
    if (!calleeSpan) return 0;
    const { start: startOffset } = calleeSpan;
    let expression;
    if (context.bare || context.memberCall) {
        /* Native extents retain bare-call boundaries and compound receivers.
           A point on the terminal method selects its call, not the nested
           factory or array operation that produced the receiver. */
        expression = model.expressionAtTraceOnly(uri, positionAtOffset(document, calleeSpan.end - 1));
    } else {
        const openIndex = document.tokens.findIndex((token) => token.offset === context.openParenthesisOffset && token.name === "(");
        if (openIndex < 0) return 0;
        let depth = 0;
        let endOffset = 0;
        for (let index = openIndex; index < document.tokens.length; index++) {
            const token = document.tokens[index];
            if (token.name === "(") depth++;
            else if (token.name === ")" && --depth === 0) {
                endOffset = token.end;
                break;
            }
        }
        if (!endOffset) return 0;
        expression = model.expressionAtTraceOnly(uri,
            positionAtOffset(document, startOffset), positionAtOffset(document, endOffset));
    }
    if (!expression?.compilerExpressionId || expression.provisional) return 0;
    const expanded = model.inner.getDocument(model.expandedUri);
    const rootStart = positionOffset(expanded, expression.start.line, expression.start.character);
    const rootEnd = positionOffset(expanded, expression.end.line, expression.end.character);
    /* NEW wraps the constructor call in an allocation expression. Anchor the
       selected call at its physical callee token, not at that outer root. */
    const callee = positionAtOffset(document, startOffset);
    const calleePosition = model.projectPosition(uri, callee.line, callee.character);
    if (!calleePosition) return 0;
    const calleeStart = positionOffset(expanded, calleePosition.line, calleePosition.character);
    const calleeEnd = calleePosition.token?.end ?? calleeStart + context.name.length;
    const nodes = expressionGraphNodeIndex(model.expressionGraph, checkCancelled);
    let selectedTarget = 0;

    for (const expressionId of expression.compilerExpressionIds || [expression.compilerExpressionId]) {
        checkCancelled();
        const pending = [expressionId];
        const visited = new Set();
        const calls = [];
        let visitedCount = 0;
        while (pending.length) {
            if (visitedCount++ % COMPILER_QUERY_CANCELLATION_INTERVAL === 0) checkCancelled();
            const identity = pending.pop();
            if (!identity || visited.has(identity)) continue;
            visited.add(identity);
            const node = nodes.get(identity);
            if (!node) continue;
            if (node.kind === "call" && !node.invalid && !node.provisional &&
                Number.isSafeInteger(node.target) && node.target > 0 && node.start && node.end) {
                const start = positionOffset(expanded, node.start.line, node.start.character);
                const end = positionOffset(expanded, node.end.line, node.end.character);
                // A method node can include its receiver before the parser's
                // member-expression range. It must cover the method token;
                // the nested factory ends before that token and cannot win.
                const matchesCallee = context.memberCall
                    ? start <= calleeStart && end >= calleeEnd
                    : start === calleeStart && start >= rootStart;
                if (matchesCallee && end >= start && end <= rootEnd) {
                    calls.push({ end, target: node.target });
                }
            }
            pending.push(...(node.inputs || []));
        }
        if (!calls.length) return 0;
        let furthestEnd = -1;
        for (const call of calls) if (call.end > furthestEnd) furthestEnd = call.end;
        const targets = new Set(calls.filter((call) => call.end === furthestEnd)
            .map((call) => model.canonicalSymbolIds?.get(call.target) || call.target));
        if (targets.size !== 1) return 0;
        const [target] = targets;
        if (selectedTarget && selectedTarget !== target) return 0;
        selectedTarget = target;
    }
    return selectedTarget;
}

function callNameSpan(document, context) {
    let end = context.openParenthesisOffset;
    while (end > 0 && /\s/.test(document.text[end - 1])) end--;
    if (context.bare) {
        /* Bare-call context keeps the terminal name for spaced/arrow member
           joins. Retain the written receiver when anchoring the native call. */
        const terminal = document.tokens.find((token) => token.kind === "identifier" && token.end === end);
        if (!terminal) return null;
        let index = terminal.index;
        while (index >= 2 && [".", "->"].includes(document.tokens[index - 1].name) &&
            document.tokens[index - 2].kind === "identifier") index -= 2;
        return { start: document.tokens[index].offset, end };
    }
    const start = end - context.name.length;
    return start >= 0 && document.text.slice(start, end) === context.name ? { start, end } : null;
}

/* Schema-27 source columns use VS Code UTF-16 units, not UTF-8 byte offsets. */
function semanticSourceColumnOffset(document, line, column) {
    if (!Number.isSafeInteger(line) || line < 0 || line >= document.lineOffsets.length ||
        !Number.isSafeInteger(column) || column < 0) return null;
    const lineStart = document.lineOffsets[line];
    const nextLine = document.lineOffsets[line + 1] ?? document.text.length;
    const lineLength = document.text.slice(lineStart, nextLine).replace(/[\r\n]+$/, "").length;
    return column <= lineLength ? lineStart + column : null;
}

function semanticBindingToken(document, binding, allowReadOnlyLocation = false) {
    if (!document || !(binding?.physical === true || allowReadOnlyLocation && binding?.readOnlyLocation === true) || !binding.filePath ||
        !Number.isSafeInteger(binding.startLine) || binding.startLine < 1 ||
        binding.startLine !== binding.endLine) return null;
    const start = semanticSourceColumnOffset(document, binding.startLine - 1, binding.startColumn);
    const end = semanticSourceColumnOffset(document, binding.endLine - 1, binding.endColumn);
    if (start === null || end === null || end <= start) return null;
    const name = normalizeIdentifier(String(binding.name || "").split(".").at(-1));
    const lineTokens = document.byLine?.get(binding.startLine - 1) || [];
    const token = lineTokens.find((candidate) =>
        candidate.offset >= start && candidate.end === end &&
        (candidate.kind === "identifier" && (!name || candidate.key === name) ||
            candidate.kind === "number" && (!name || normalizeIdentifier(candidate.name) === name)));
    if (token) return { start, end, token };
    // A recovered location is read-only evidence, not permission to undo the
    // source mask for a comment, literal or generated replacement spelling.
    if (binding.physical !== true) return null;

    /* A compiler binding is itself proof that this exact physical spelling is
       code. The lightweight source masker can still hide a keyword used as an
       identifier when its contextual option was accepted inside preprocessing. */
    const spelling = document.text.slice(start, end);
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(spelling) ||
        normalizeIdentifier(spelling) !== name || end - start !== spelling.length) return null;
    return {
        start,
        end,
        token: {
            name: spelling,
            key: normalizeIdentifier(spelling),
            kind: "identifier",
            offset: start,
            end,
            line: binding.startLine - 1,
            startColumn: binding.startColumn,
            endColumn: binding.endColumn,
            index: -1
        }
    };
}

/* Use FBC's physical binding records for navigation, but retain the source-token check. */
function compilerSidecarNavigationPathKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compilerSidecarCanonicalSymbol(model, symbol) {
    const aliases = model.compilerParameterAliases;
    if (!aliases?.has(symbol)) return symbol;
    const visited = new Set();
    while (aliases.has(symbol)) {
        if (visited.has(symbol)) return 0;
        visited.add(symbol);
        symbol = aliases.get(symbol);
        if (!symbol) return 0;
    }
    return symbol;
}

function compilerSidecarNavigationDeclarationBindingIndex(model, checkCancelled, allowReadOnlyLocation = false) {
    const cache = allowReadOnlyLocation ? sidecarReadOnlyDeclarationBindingIndexes : sidecarNavigationDeclarationBindingIndexes;
    if (cache.has(model)) {
        return cache.get(model);
    }
    if (!Array.isArray(model.semanticBindings) ||
        model.semanticBindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    const declarationsBySymbol = new Map();
    const bindings = allowReadOnlyLocation ? [...model.semanticBindings, ...(model.semanticReadOnlyBindings || [])] : model.semanticBindings;
    if (bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    for (let index = 0; index < bindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = bindings[index];
        if (binding.role !== "declaration" || !(binding.physical === true || allowReadOnlyLocation && binding.readOnlyLocation === true) ||
            !Number.isSafeInteger(binding.symbol) || binding.symbol < 1 ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath)) continue;
        const symbol = compilerSidecarCanonicalSymbol(model, binding.symbol);
        if (!symbol) continue;
        const declarations = declarationsBySymbol.get(symbol) || [];
        declarations.push(binding);
        declarationsBySymbol.set(symbol, declarations);
    }
    cache.set(model, declarationsBySymbol);
    return declarationsBySymbol;
}

function compilerSidecarCompletionReachableSources(model, selectedPath, document, position, sources, checkCancelled) {
    const selectedSource = sources.get(selectedPath);
    if (!selectedSource) return new Map();
    const reachable = new Map([[selectedPath, selectedSource]]);
    const contexts = [...(model.semanticSourceContexts?.values?.() || [])];
    const roots = contexts.filter((context) => context.kind === "module" && context.parent === 0 &&
        typeof context.filePath === "string" &&
        compilerSidecarNavigationPathKey(context.filePath) === selectedPath);
    if (roots.length !== 1) return reachable;

    const root = roots[0];
    const childrenByParent = new Map();
    for (const context of contexts) {
        const children = childrenByParent.get(context.parent) || [];
        children.push(context);
        childrenByParent.set(context.parent, children);
    }
    const rootLineStart = document.lineOffsets[position.line];
    if (!Number.isSafeInteger(rootLineStart)) return reachable;
    const reachableContexts = new Set([root.id]);
    const pending = [root];
    for (let cursor = 0; cursor < pending.length; cursor++) {
        if ((cursor & 255) === 0) checkCancelled();
        if (cursor >= MAX_COMPILER_SIDECAR_COMPLETION_SOURCE_FILES) return new Map([[selectedPath, selectedSource]]);
        const parent = pending[cursor];
        const parentPath = typeof parent.filePath === "string"
            ? compilerSidecarNavigationPathKey(parent.filePath)
            : "";
        for (const child of childrenByParent.get(parent.id) || []) {
            if (child.kind !== "include" || reachableContexts.has(child.id) ||
                typeof child.filePath !== "string" || !path.isAbsolute(child.filePath)) continue;
            const childPath = compilerSidecarNavigationPathKey(child.filePath);
            const childSource = sources.get(childPath);
            if (!childSource) continue;
            if (parent.id === root.id) {
                const directive = child.directive;
                if (!directive || typeof directive.filePath !== "string" ||
                    compilerSidecarNavigationPathKey(directive.filePath) !== parentPath ||
                    !Number.isSafeInteger(directive.startLine) || directive.startLine < 1 ||
                    !Number.isSafeInteger(directive.startColumn) || directive.startColumn < 0 ||
                    directive.startLine - 1 > position.line ||
                    directive.startLine - 1 === position.line && directive.startColumn >= position.character) continue;
            }
            reachableContexts.add(child.id);
            reachable.set(childPath, childSource);
            pending.push(child);
            if (reachable.size > MAX_COMPILER_SIDECAR_COMPLETION_SOURCE_FILES) {
                return new Map([[selectedPath, selectedSource]]);
            }
        }
    }
    return reachable;
}

function compilerSidecarCompletionDeclarationBindings(model, sourcePaths, checkCancelled) {
    let caches = sidecarCompletionReachableDeclarationBindings.get(model);
    if (!caches) {
        caches = new Map();
        sidecarCompletionReachableDeclarationBindings.set(model, caches);
    }
    const key = JSON.stringify([...sourcePaths].sort());
    if (caches.has(key)) {
        const cached = caches.get(key);
        caches.delete(key);
        caches.set(key, cached);
        return cached;
    }

    const declarationsBySymbol = compilerSidecarNavigationDeclarationBindingIndex(model, checkCancelled);
    if (!declarationsBySymbol) return null;
    const bindingsBySymbol = new Map();
    const symbolsBySite = new Map();
    let inspected = 0;
    for (const [symbol, bindings] of declarationsBySymbol) {
        for (const binding of bindings) {
            if ((inspected++ & 255) === 0) checkCancelled();
            if (!sourcePaths.has(compilerSidecarNavigationPathKey(binding.filePath))) continue;
            const declarations = bindingsBySymbol.get(symbol) || [];
            declarations.push(binding);
            bindingsBySymbol.set(symbol, declarations);
            const site = `${compilerSidecarNavigationPathKey(binding.filePath)}:${binding.startLine - 1}:` +
                `${binding.startColumn}:${binding.endColumn}`;
            const siteSymbols = symbolsBySite.get(site) || new Set();
            siteSymbols.add(symbol);
            symbolsBySite.set(site, siteSymbols);
        }
    }
    const index = { bindingsBySymbol, symbolsBySite };
    caches.set(key, index);
    while (caches.size > 2) caches.delete(caches.keys().next().value);
    return index;
}

function compilerSidecarPhysicalBindingFileIndex(model, selectedPath, checkCancelled, allowReadOnlyLocation = false) {
    const cache = allowReadOnlyLocation ? sidecarReadOnlyBindingFileIndexes : sidecarPhysicalBindingFileIndexes;
    let files = cache.get(model);
    if (!files) {
        files = new Map();
        cache.set(model, files);
    }
    if (files.has(selectedPath)) {
        const index = files.get(selectedPath);
        files.delete(selectedPath);
        files.set(selectedPath, index);
        return index;
    }
    if (!Array.isArray(model.semanticBindings) ||
        model.semanticBindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    const bindings = [];
    const candidates = allowReadOnlyLocation ? [...model.semanticBindings, ...(model.semanticReadOnlyBindings || [])] : model.semanticBindings;
    if (candidates.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    for (let index = 0; index < candidates.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = candidates[index];
        if (!(binding.physical === true || allowReadOnlyLocation && binding.readOnlyLocation === true) || !["declaration", "reference"].includes(binding.role) ||
            !Number.isSafeInteger(binding.symbol) || binding.symbol < 1 ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath) ||
            compilerSidecarNavigationPathKey(binding.filePath) !== selectedPath) continue;
        bindings.push({ binding, index: index + 1 });
    }
    files.set(selectedPath, bindings);
    while (files.size > MAX_COMPILER_SIDECAR_NAVIGATION_CACHED_DOCUMENTS) {
        files.delete(files.keys().next().value);
    }
    return bindings;
}

function compilerSidecarNavigationSources(model) {
    const sources = new Map();
    for (const source of model.sources?.values?.() || []) {
        const filePath = source.uri?.fsPath || source.uri?.path;
        if (typeof filePath !== "string" || !path.isAbsolute(filePath)) continue;
        const key = compilerSidecarNavigationPathKey(filePath);
        const previous = sources.get(key);
        if (previous && previous.text !== source.text) {
            sources.set(key, null);
        } else if (!sources.has(key)) {
            sources.set(key, source);
        }
    }
    return sources;
}

function compilerIdentifierTokenAtPosition(document, position) {
    return (document.byLine?.get(position.line) || []).some((token) =>
        token.kind === "identifier" && position.character >= token.startColumn &&
        position.character < token.endColumn);
}

function compilerIdentifierTokenAtRawPosition(document, position) {
    const lineStart = document.lineOffsets[position.line];
    const lineEnd = document.lineOffsets[position.line + 1] ?? document.text.length;
    const lineText = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
    const match = [...lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)].find((candidate) =>
        position.character >= candidate.index && position.character < candidate.index + candidate[0].length
    );
    if (!match) return false;
    const tokens = document.byLine?.get(position.line) || [];
    return !tokens.some((token) => token.kind === "identifier" && token.startColumn === match.index &&
        token.endColumn === match.index + match[0].length);
}

function compilerSidecarNoKeywordDirectiveCache(document) {
    let cache = sidecarNoKeywordDirectiveCaches.get(document);
    if (!cache || cache.text !== document.text) {
        const firstOffsets = new Map();
        if (/^\s*option\s+nokeyword\b/im.test(document.text)) {
            const maskedLines = maskFreeBasicText(document.text).split(/\r\n|\n|\r/);
            const sourceLines = document.text.split(/\r\n|\n|\r/);
            for (let line = 0; line < maskedLines.length; line++) {
                if (!/^\s*option\s+nokeyword\b/i.test(maskedLines[line]) ||
                    !Number.isSafeInteger(document.lineOffsets[line])) continue;
                const option = /^\s*option\s+nokeyword\b([^:]*)/i.exec(sourceLines[line]);
                if (!option) continue;
                const endOffset = document.lineOffsets[line] + option[0].length;
                for (const keyword of option[1].split(",")) {
                    const disabledName = normalizeIdentifier(
                        keyword.trim().match(/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/)?.[0] || ""
                    );
                    if (!disabledName || firstOffsets.has(disabledName)) continue;
                    firstOffsets.set(disabledName, endOffset);
                }
            }
        }
        cache = { text: document.text, firstOffsets };
        sidecarNoKeywordDirectiveCaches.set(document, cache);
    }
    return cache;
}

function compilerOptionNoKeywordIdentifierAtPosition(document, position) {
    if (!position || !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)) return false;
    const lineStart = document.lineOffsets[position.line];
    if (!Number.isSafeInteger(lineStart)) return false;
    const lineEnd = document.lineOffsets[position.line + 1] ?? document.text.length;
    const lineText = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
    const match = [...lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)].find((candidate) =>
        position.character >= candidate.index && position.character < candidate.index + candidate[0].length
    );
    if (!match) return false;

    const tokenOffset = lineStart + match.index;
    const cache = compilerSidecarNoKeywordDirectiveCache(document);
    const name = normalizeIdentifier(match[0]);
    const optionOffset = cache.firstOffsets.get(name);
    return Number.isSafeInteger(optionOffset) && optionOffset <= tokenOffset;
}

function compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled, allowReadOnlyLocation = false) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(model.semanticBindings) ||
        model.semanticBindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    const filePath = uri.fsPath || uri.path;
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
    const selectedPath = compilerSidecarNavigationPathKey(filePath);
    const sources = compilerSidecarNavigationSources(model);
    const source = sources.get(selectedPath);
    if (!source || source.text !== document.text) return null;

    const bindings = compilerSidecarPhysicalBindingFileIndex(model, selectedPath, checkCancelled, allowReadOnlyLocation);
    if (!bindings) return null;
    let matched = false;
    const symbols = new Set();
    for (let index = 0; index < bindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const { binding } = bindings[index];
        if (binding.startLine !== position.line + 1) continue;
        const range = semanticBindingToken(source, binding, allowReadOnlyLocation);
        if (!range || position.character < range.token.startColumn || position.character > range.token.endColumn) continue;
        matched = true;
        symbols.add(compilerSidecarCanonicalSymbol(model, binding.symbol));
        if (symbols.size > 1) break;
    }
    return matched ? {
        symbol: symbols.size === 1 ? symbols.values().next().value : 0,
        sources, allowReadOnlyLocation
    } : null;
}

/* FBC selects the declaration site; parsing recovers only syntax metadata such as DECLARE. */
function compilerSidecarNavigationEntryRecords(model, selection, checkCancelled) {
    if (!selection?.symbol) return { complete: false, entries: [] };
    const declarationBindings = compilerSidecarNavigationDeclarationBindingIndex(model, checkCancelled, selection.allowReadOnlyLocation === true);
    if (!declarationBindings) return { complete: false, entries: [] };
    const entries = new Map();
    const bindingPaths = new Map();
    const bindingPathKey = (filePath) => {
        let key = bindingPaths.get(filePath);
        if (!key) {
            key = compilerSidecarNavigationPathKey(filePath);
            bindingPaths.set(filePath, key);
        }
        return key;
    };
    for (const binding of declarationBindings.get(selection.symbol) || []) {
        checkCancelled();
        const source = selection.sources.get(bindingPathKey(binding.filePath));
        if (!source) return { complete: false, entries: [] };
        const matched = semanticBindingToken(source, binding, selection.allowReadOnlyLocation === true);
        if (!matched) return { complete: false, entries: [] };

        const cacheKey = source.uri.toString();
        const declarations = compilerSidecarNavigationSourceDeclarations(model, source);
        if (!Array.isArray(declarations)) return { complete: false, entries: [] };

        const sourceDeclarations = declarations.filter((declaration) => {
            const name = String(declaration.name || "");
            const terminalName = name.split(".").at(-1);
            /* FBC binds SetX in Sub Geometry.Point.SetX, while the source
               declaration spans the whole qualified name. Recover syntax
               metadata only when that exact terminal token closes the name. */
            const terminalStart = name.includes(".")
                ? declaration.endColumn - terminalName.length : declaration.startColumn;
            return declaration.line === matched.token.line &&
                terminalStart === matched.token.startColumn &&
                declaration.endColumn >= matched.token.endColumn &&
                normalizeIdentifier(terminalName) === matched.token.key;
        });
        if (sourceDeclarations.length > 1) return { complete: false, entries: [] };
        let parsedDeclaration = sourceDeclarations[0] || (matched.token.kind === "number" ? {
            name: matched.token.name,
            qualifiedName: matched.token.name,
            type: "label",
            detail: "Label",
            line: matched.token.line,
            startColumn: matched.token.startColumn,
            endColumn: matched.token.endColumn,
            signature: matched.token.name,
            modifiers: [],
            parameters: []
        } : null);
        let compilerFacts = null;
        if (!parsedDeclaration) {
            const implicitDeclarations = (model.semanticDeclarations || []).filter((declaration) =>
                declaration?.kind === "implicit-variable" && declaration.physical === true &&
                declaration.symbol === selection.symbol &&
                typeof declaration.filePath === "string" && path.isAbsolute(declaration.filePath) &&
                compilerSidecarNavigationPathKey(declaration.filePath) === bindingPathKey(binding.filePath) &&
                declaration.startLine === binding.startLine && declaration.startColumn === binding.startColumn &&
                declaration.endLine === binding.endLine && declaration.endColumn === binding.endColumn &&
                normalizeIdentifier(declaration.name) === matched.token.key &&
                source.text.slice(matched.start, matched.end) === declaration.name
            );
            const selectedStorageFacts = compilerStorageTypeFactsForSymbols(model, [selection.symbol]);
            const declarationInputs = selectedStorageFacts?.declarationInputs || [];
            const declarationInput = declarationInputs.length === 1 ? declarationInputs[0] : null;
            const explicitVariableDeclaration = declarationInput?.symbol === selection.symbol &&
                declarationInput.provisional === false &&
                ["dim", "static", "common", "extern", "var"].includes(declarationInput.group?.kind);
            if (implicitDeclarations.length === 1 || explicitVariableDeclaration) {
                const storageFacts = selectedStorageFacts;
                const storageClass = compilerStorageClassForHover(model, [selection.symbol]);
                if (!storageFacts?.storageType || !storageClass) return { complete: false, entries: [] };
                const typeName = storageFacts.storageType.primitive;
                const groupKind = declarationInput?.group?.kind || "";
                parsedDeclaration = {
                    name: matched.token.name,
                    qualifiedName: matched.token.name,
                    type: "variable",
                    detail: typeName ? `Variable As ${typeName}` : "Variable",
                    typeName: typeName || "",
                    line: matched.token.line,
                    startColumn: matched.token.startColumn,
                    endColumn: matched.token.endColumn,
                    signature: `variable ${matched.token.name}${typeName ? ` As ${typeName}` : ""}`,
                    modifiers: groupKind === "static" ? ["STATIC"]
                        : groupKind === "common" ? ["COMMON"]
                            : groupKind === "extern" ? ["EXTERN"]
                                : groupKind === "var" ? ["VAR"] : [],
                    parameters: [],
                    provisional: false
                };
                compilerFacts = { ...storageFacts, compilerStorageClass: storageClass };
            }
        }
        if (!parsedDeclaration) return { complete: false, entries: [] };
        const name = source.text.slice(matched.start, matched.end);
        const entry = entryRecord({
            id: `sidecar:${selection.symbol}:${cacheKey}:${matched.start}`,
            name,
            compilerSymbolId: selection.symbol,
            compilerPreprocessorId: 0,
            uri: source.uri,
            declaration: {
                ...parsedDeclaration,
                name,
                startColumn: matched.token.startColumn,
                endColumn: matched.token.endColumn,
                provisional: false,
                compilerMacroDefinition: "",
                modifiers: Array.isArray(parsedDeclaration.modifiers) ? parsedDeclaration.modifiers : [],
                parameters: Array.isArray(parsedDeclaration.parameters) ? parsedDeclaration.parameters : [],
                ...(compilerFacts ? { compilerFacts } : {})
            },
            ...(compilerFacts ? { compilerFacts } : {})
        });
        entries.set(`${source.uri.toString()}:${matched.start}:${entry.id}`, entry);
        if (entries.size > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return { complete: false, entries: [] };
    }
    return { complete: true, entries: [...entries.values()] };
}

/* Implementation follows committed override edges downward. Definition and
   Declaration retain the statically selected symbol and never use this family. */
function compilerOverrideImplementations(model, uri, document, position, resolve, checkCancelled) {
    if (model.partial) return null;
    const sidecar = model.semanticSidecarOnly;
    const selection = sidecar ? compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled) : null;
    const roots = sidecar ? new Set(selection?.symbol ? [selection.symbol] : [])
        : new Set(resolve().filter((entry) => ["sub", "function", "property"].includes(entry.declaration.type))
            .map((entry) => nativeSymbolId(model, entry)).filter(Boolean));
    if (roots.size !== 1) return null;
    const overrides = sidecar ? model.compilerProcedureOverrideTargetsBySemanticIdentity : model.compilerNativeProcedureOverrides;
    if (!overrides?.size || overrides.size > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    const children = new Map();
    for (const [child, parents] of overrides) {
        checkCancelled();
        if (parents.size !== 1) continue;
        const parent = parents.values().next().value;
        if (parent === child) return null;
        const descendants = children.get(parent) || new Set();
        descendants.add(child);
        children.set(parent, descendants);
    }
    const family = [...roots], visited = new Set(roots);
    for (let index = 0; index < family.length; index++) {
        checkCancelled();
        for (const child of children.get(family[index]) || []) {
            if (visited.has(child)) continue;
            visited.add(child);
            family.push(child);
            if (family.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
        }
    }
    if (family.length === 1) return null;
    const entries = [];
    if (sidecar) {
        for (const symbol of family) {
            const result = compilerSidecarNavigationEntryRecords(model, { ...selection, symbol }, checkCancelled);
            if (!result.complete) return null;
            entries.push(...result.entries);
        }
    } else {
        const targets = family.flatMap((symbol) => model.nativeFamilies.get(symbol) || []);
        entries.push(...model.declarationTargets(targets).map(navigationEntryRecord));
    }
    const bodies = entries.filter((entry) => ["sub", "function", "property"].includes(entry.declaration.type) &&
        !entry.declaration.provisional && !entry.declaration.modifiers.includes("DECLARE") &&
        !entry.declaration.modifiers.includes("ABSTRACT"));
    return [...new Map(bodies.map((entry) => [`${entry.uri.fsPath}:${entry.declaration.line}:${entry.declaration.startColumn}`,
        { ...entry, compilerVirtualMethod: true }])).values()];
}

/* The immediate override edge is distinct from static Definition and from the
   descendant family used by Implementation. Never infer a parent by name. */
function compilerBaseMethodDefinition(model, uri, document, position, resolve, checkCancelled) {
    if (model.partial) return [];
    const sidecar = model.semanticSidecarOnly;
    const selection = sidecar ? compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled) : null;
    const roots = sidecar ? new Set(selection?.symbol ? [selection.symbol] : [])
        : new Set(resolve().filter((entry) => ["sub", "function", "property"].includes(entry.declaration.type))
            .map((entry) => nativeSymbolId(model, entry)).filter(Boolean));
    if (roots.size !== 1) return [];
    const child = roots.values().next().value;
    const overrides = sidecar ? model.compilerProcedureOverrideTargetsBySemanticIdentity : model.compilerNativeProcedureOverrides;
    const parents = overrides?.get(child);
    if (parents?.size !== 1) return [];
    const parent = parents.values().next().value;
    if (!parent || parent === child) return [];
    checkCancelled();
    let entries;
    if (sidecar) {
        const result = compilerSidecarNavigationEntryRecords(model, { ...selection, symbol: parent }, checkCancelled);
        if (!result.complete) return [];
        entries = result.entries;
    } else {
        entries = (model.nativeFamilies.get(parent) || []).map(navigationEntryRecord);
    }
    entries = entries.filter((entry) => ["sub", "function", "property"].includes(entry.declaration.type) &&
        !entry.declaration.provisional);
    const bodies = entries.filter((entry) => !entry.declaration.modifiers.includes("DECLARE") &&
        !entry.declaration.modifiers.includes("ABSTRACT"));
    return [...new Map((bodies.length ? bodies : entries).map((entry) =>
        [`${entry.uri.fsPath}:${entry.declaration.line}:${entry.declaration.startColumn}`, entry])).values()];
}

function compilerSidecarCompletionScopeDocument(model, source) {
    let documents = sidecarCompletionScopeDocumentCaches.get(model);
    if (!documents) {
        documents = new Map();
        sidecarCompletionScopeDocumentCaches.set(model, documents);
    }
    const key = source.uri.toString();
    if (documents.has(key)) {
        const document = documents.get(key);
        documents.delete(key);
        documents.set(key, document);
        return document;
    }
    if (Buffer.byteLength(source.text, "utf8") > MAX_COMPILER_SIDECAR_NAVIGATION_SOURCE_BYTES) return null;
    const parsed = parseFreeBasicText(source.text);
    if ((parsed.declarations || []).length > MAX_COMPILER_SIDECAR_NAVIGATION_DECLARATIONS) return null;
    const document = createDocumentModel(source.uri, parsed);
    documents.set(key, document);
    while (documents.size > MAX_COMPILER_SIDECAR_NAVIGATION_CACHED_DOCUMENTS) {
        documents.delete(documents.keys().next().value);
    }
    return document;
}

function nearestCompilerCallableScope(scope) {
    for (let current = scope; current; current = current.parent) {
        if (CALLABLE_TYPES.has(current.kind)) return current;
    }
    return null;
}

function compilerSidecarCompletionScopeContains(declarationScope, completionScope) {
    if (!declarationScope || !completionScope) return false;
    let current = completionScope;
    while (current && current !== declarationScope) current = current.parent;
    return Boolean(current);
}

function compilerSidecarCompletionScopeIdentity(scope) {
    if (scope?.kind === "module") return "module";
    if (!["namespace", "type", "class", "union"].includes(scope?.kind)) return "";
    const name = normalizeIdentifier(scope.qualifiedName || "");
    return name ? `${scope.kind}:${name}` : "";
}

function compilerSidecarCompletionNamespaceId(model, selectedPath, scopeDocument, completionScope, declarationBindingIndex) {
    let namespaceScope = completionScope;
    while (namespaceScope && namespaceScope.kind !== "namespace") namespaceScope = namespaceScope.parent;
    if (namespaceScope?.declaration) {
        const entry = scopeDocument.entries.find((candidate) => candidate.declaration === namespaceScope.declaration);
        if (!entry) return 0;
        const site = `${selectedPath}:${entry.declaration.line}:${entry.declaration.startColumn}:${entry.declaration.endColumn}`;
        const symbols = declarationBindingIndex.symbolsBySite.get(site);
        return symbols?.size === 1 ? symbols.values().next().value : 0;
    }

    const owners = new Set((model.compilerSourceHeaderPolicies || [])
        .filter((policy) => typeof policy.filePath === "string" &&
            compilerSidecarNavigationPathKey(policy.filePath) === selectedPath &&
            Number.isSafeInteger(policy.owner) && policy.owner > 0)
        .map((policy) => policy.owner));
    return owners.size === 1 ? owners.values().next().value : 0;
}

function compilerSidecarCompletionNamespaceSymbolsByName(
    reachableSources, scopeDocumentForPath, declarationBindingIndex, checkCancelled
) {
    const symbolsByName = new Map();
    let inspected = 0;
    for (const [sourcePath, source] of reachableSources) {
        const document = scopeDocumentForPath(sourcePath, source);
        if (!document) continue;
        for (const entry of document.entries) {
            if ((inspected++ & 255) === 0) checkCancelled();
            if (entry.declaration.type !== "namespace" || entry.conditional || entry.provisional ||
                entry.declaration.provisional) continue;
            const declaration = entry.declaration;
            const site = `${sourcePath}:${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`;
            const symbols = declarationBindingIndex.symbolsBySite.get(site);
            if (symbols?.size !== 1) continue;
            const symbol = symbols.values().next().value;
            const names = new Set([
                normalizeIdentifier(entry.name || declaration.name || ""),
                normalizeIdentifier(entry.qualifiedName || declaration.qualifiedName || "")
            ].filter(Boolean));
            for (const name of names) {
                const matches = symbolsByName.get(name) || new Set();
                matches.add(symbol);
                symbolsByName.set(name, matches);
            }
        }
    }
    return symbolsByName;
}

function compilerSidecarNamespaceImportNamesAtOffset(scope, offset, names) {
    for (const imported of scope?.imports || []) {
        if (imported.offset === offset && typeof imported.name === "string") {
            names.add(normalizeIdentifier(imported.name));
        }
    }
    for (const child of scope?.children || []) compilerSidecarNamespaceImportNamesAtOffset(child, offset, names);
}

function compilerSidecarNamespaceImportMakesVisible(
    model, reachablePaths, namespaceId, recipientId, selectedPath, completionPosition,
    reachableSources, scopeDocumentForPath, namespaceSymbolsByName, checkCancelled
) {
    if (!Number.isSafeInteger(namespaceId) || namespaceId < 1 ||
        !Number.isSafeInteger(recipientId) || recipientId < 1) return false;
    for (const imported of model.compilerNamespaceImportRecipients || []) {
        checkCancelled();
        if (imported.physical !== true || imported.recipient !== recipientId ||
            typeof imported.filePath !== "string" || !path.isAbsolute(imported.filePath)) continue;
        const importPath = compilerSidecarNavigationPathKey(imported.filePath);
        if (!reachablePaths.has(importPath) || !Number.isSafeInteger(imported.startLine) || imported.startLine < 1 ||
            !Number.isSafeInteger(imported.startColumn) || imported.startColumn < 0 ||
            !Number.isSafeInteger(imported.endLine) || imported.endLine < imported.startLine ||
            !Number.isSafeInteger(imported.endColumn) || imported.endColumn < 0) continue;
        if (importPath === selectedPath && (imported.startLine - 1 > completionPosition.line ||
            imported.startLine - 1 === completionPosition.line && imported.startColumn >= completionPosition.character)) continue;
        const source = reachableSources.get(importPath);
        const document = source && scopeDocumentForPath(importPath, source);
        if (!document) continue;
        const start = positionOffset(document, imported.startLine - 1, imported.startColumn);
        const names = new Set();
        compilerSidecarNamespaceImportNamesAtOffset(document.root, start, names);
        for (const name of names) {
            const symbols = namespaceSymbolsByName.get(name);
            if (symbols?.size === 1 && symbols.has(namespaceId)) return true;
        }
    }
    return false;
}

function compilerSidecarCompletionScopeVisibleFromSource(
    declarationScope, completionScope, declarationPath, completionPath, completionOffset
) {
    if (declarationPath === completionPath) {
        return compilerSidecarCompletionScopeContains(declarationScope, completionScope);
    }
    const wanted = compilerSidecarCompletionScopeIdentity(declarationScope);
    if (!wanted) return false;
    for (let current = completionScope; current; current = current.parent) {
        if (compilerSidecarCompletionScopeIdentity(current) === wanted) return true;
        if (declarationScope.kind === "namespace" && (current.imports || []).some((imported) =>
            Number.isSafeInteger(imported.offset) && imported.offset < completionOffset &&
            normalizeIdentifier(imported.name) === normalizeIdentifier(declarationScope.qualifiedName || ""))) return true;
    }
    return false;
}

function compilerSidecarCompletionScopeIsVisible(declarationScope, completionScope, storageClass) {
    if (!compilerSidecarCompletionScopeContains(declarationScope, completionScope)) return false;
    const declarationCallable = nearestCompilerCallableScope(declarationScope);
    const completionCallable = nearestCompilerCallableScope(completionScope);
    if (declarationCallable === completionCallable) return true;
    return !declarationCallable && completionCallable !== null &&
        ["external", "shared", "global"].includes(storageClass);
}

/* FBC places unqualified, non-Explicit enum members in the parent namespace. */
function compilerSidecarEnumMemberCompletionInfo(
    model, scopeDocument, source, symbol, binding, matched, declarationBindingIndex
) {
    const declarationScope = scopeAt(scopeDocument, matched.start);
    if (declarationScope?.kind !== "enum" || !declarationScope.parent ||
        declarationScope.declaration?.type !== "enum") return null;
    const sourcePath = compilerSidecarNavigationPathKey(source.uri.fsPath || source.uri.path);
    const memberEntry = scopeDocument.entries.find((entry) =>
        entry.scope === declarationScope && entry.declaration.type === "enumMember" &&
        entry.declaration.line === matched.token.line &&
        entry.declaration.startColumn === matched.token.startColumn &&
        entry.declaration.endColumn === matched.token.endColumn
    );
    const enumEntry = scopeDocument.entries.find((entry) => entry.declaration === declarationScope.declaration);
    if (!memberEntry || memberEntry.conditional || !enumEntry || enumEntry.conditional) return null;

    const facts = model.compilerFactsBySemanticIdentity?.get(symbol);
    const inputs = facts?.enumElementInputs;
    if (!Array.isArray(inputs) || !inputs.length) return null;
    const memberInputs = inputs.filter((input) => input.physical === true && input.provisional === false &&
        typeof input.filePath === "string" && compilerSidecarNavigationPathKey(input.filePath) === sourcePath &&
        input.line === binding.startLine && input.startColumn === binding.startColumn);
    if (!memberInputs.length || memberInputs.some((input) => !Number.isSafeInteger(input.owner) || input.owner < 1 ||
        input.owner !== memberInputs[0].owner)) return null;

    const owner = memberInputs[0].owner;
    const enumSite = `${sourcePath}:${enumEntry.declaration.line}:${enumEntry.declaration.startColumn}:` +
        `${enumEntry.declaration.endColumn}`;
    const enumSymbols = declarationBindingIndex.symbolsBySite.get(enumSite);
    if (enumSymbols?.size !== 1 || !enumSymbols.has(owner)) return null;

    let namespaceId = 0;
    const namespaceScope = declarationScope.parent;
    const namespaceDeclaration = namespaceScope?.kind === "namespace" ? namespaceScope.declaration : null;
    const namespaceEntry = namespaceDeclaration && scopeDocument.entries.find((entry) =>
        entry.declaration === namespaceDeclaration
    );
    if (namespaceEntry) {
        const namespaceSite = `${sourcePath}:${namespaceEntry.declaration.line}:` +
            `${namespaceEntry.declaration.startColumn}:${namespaceEntry.declaration.endColumn}`;
        const namespaceSymbols = declarationBindingIndex.symbolsBySite.get(namespaceSite);
        if (namespaceSymbols?.size === 1) namespaceId = namespaceSymbols.values().next().value;
    }
    return {
        scope: namespaceScope,
        owner,
        namespaceId,
        explicit: /\bexplicit\b/i.test(maskFreeBasicText(String(enumEntry.declaration.signature || "")))
    };
}

function compilerSidecarEnumQualifierSite(document, position) {
    const lineStart = document.lineOffsets[position.line];
    if (!Number.isSafeInteger(lineStart)) return null;
    const prefix = document.text.slice(lineStart, lineStart + position.character);
    const match = /((?:[A-Za-z_][A-Za-z0-9_]*[$%!#&]?\.)*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\.([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)?$/.exec(prefix);
    if (!match) return null;
    const qualifier = match[1];
    const qualifierLeaf = qualifier.split(".").at(-1);
    const startColumn = match.index + qualifier.lastIndexOf(qualifierLeaf);
    const endColumn = startColumn + qualifierLeaf.length;
    if (document.text.slice(lineStart + startColumn, lineStart + endColumn) !== qualifierLeaf) return null;
    const memberStartColumn = match.index + qualifier.length + 1;
    const memberToken = (document.byLine?.get(position.line) || []).find((token) =>
        token.kind === "identifier" && token.startColumn === memberStartColumn &&
        position.character >= token.startColumn && position.character <= token.endColumn
    );
    if (!memberToken) return null;
    return {
        line: position.line,
        startColumn,
        endColumn,
        qualifier,
        memberStartColumn: memberToken.startColumn,
        memberEndColumn: memberToken.endColumn
    };
}

function compilerSidecarEnumMemberReferenceSiteIndex(model, selectedPath, line, checkCancelled) {
    let lineIndexes = sidecarEnumMemberReferenceIndexes.get(model);
    if (!lineIndexes) {
        lineIndexes = new Map();
        sidecarEnumMemberReferenceIndexes.set(model, lineIndexes);
    }
    const key = `${selectedPath}:${line}`;
    if (lineIndexes.has(key)) {
        const cached = lineIndexes.get(key);
        lineIndexes.delete(key);
        lineIndexes.set(key, cached);
        return cached;
    }

    const bindings = compilerSidecarPhysicalBindingFileIndex(model, selectedPath, checkCancelled);
    if (!bindings) return null;
    const symbolsByRange = new Map();
    for (let index = 0; index < bindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = bindings[index].binding;
        if (binding.role !== "reference" || binding.startLine !== line + 1 || binding.endLine !== binding.startLine) continue;
        const inputs = model.compilerFactsBySemanticIdentity?.get(binding.symbol)?.enumElementInputs;
        if (!Array.isArray(inputs) || !inputs.length || inputs.some((input) => input.physical !== true ||
            input.provisional !== false || !Number.isSafeInteger(input.owner) || input.owner < 1 ||
            input.owner !== inputs[0].owner)) continue;
        const range = `${binding.startColumn}:${binding.endColumn}`;
        const symbols = symbolsByRange.get(range) || new Set();
        symbols.add(binding.symbol);
        symbolsByRange.set(range, symbols);
    }
    lineIndexes.set(key, symbolsByRange);
    while (lineIndexes.size > 16) lineIndexes.delete(lineIndexes.keys().next().value);
    return symbolsByRange;
}

function compilerSidecarEnumMemberOwnerAtReferenceSite(model, selectedPath, line, startColumn, endColumn, checkCancelled) {
    const symbols = compilerSidecarEnumMemberReferenceSiteIndex(model, selectedPath, line, checkCancelled)
        ?.get(`${startColumn}:${endColumn}`);
    if (symbols?.size !== 1) return 0;
    const symbol = symbols.values().next().value;
    const inputs = model.compilerFactsBySemanticIdentity?.get(symbol)?.enumElementInputs;
    if (!Array.isArray(inputs) || !inputs.length) return 0;
    const owner = inputs[0].owner;
    if (!Number.isSafeInteger(owner) || owner < 1 || inputs.some((input) =>
        input.physical !== true || input.provisional !== false || !Number.isSafeInteger(input.owner) ||
        input.owner !== owner
    )) return 0;
    return owner;
}

function compilerSidecarEnumQualifierOwner(model, selectedPath, site, checkCancelled) {
    if (!site) return 0;
    return compilerSidecarEnumMemberOwnerAtReferenceSite(
        model, selectedPath, site.line, site.memberStartColumn, site.memberEndColumn, checkCancelled
    );
}

function compilerSidecarEnumMemberOwnerAtCursor(model, selectedPath, document, position, checkCancelled) {
    const token = (document.byLine?.get(position.line) || []).find((candidate) =>
        candidate.kind === "identifier" && position.character >= candidate.startColumn &&
        position.character <= candidate.endColumn
    );
    return token
        ? compilerSidecarEnumMemberOwnerAtReferenceSite(
            model, selectedPath, position.line, token.startColumn, token.endColumn, checkCancelled
        )
        : 0;
}

/* The trace-free sidecar has no source-to-expanded token map. Recover named
   type candidates from the physical scope, then require FBC's declaration
   binding at the exact physical site. Type slots also admit enums/namespaces;
   constructor recovery keeps its original aggregate-only policy. */
function compilerSidecarSourceTypeCompletionEntries(model, uri, document, position, visibleEntries, prefix, limit, checkCancelled,
    typeContext = null) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(model.semanticBindings) ||
        model.semanticBindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS ||
        (!prefix && !typeContext) || !Number.isSafeInteger(limit) || limit <= 0 ||
        !Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return [];
    const filePath = uri.fsPath || uri.path || "";
    if (!path.isAbsolute(filePath)) return [];
    const selectedPath = compilerSidecarNavigationPathKey(filePath);
    const prefixName = String(prefix).match(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/)?.[0] || "";
    if (!prefixName && !typeContext) return [];
    const typePrefix = typeContext ? String(prefix).split(/\b(?:as|extends)\b/i).at(-1)
        .trim().replace(/^(?:(?:const|unsigned)\s+)+/i, "") : "";
    const qualifier = typeContext
        ? (typePrefix.match(/^([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*(?:[A-Za-z_]\w*)?$/)?.[1] || "").replace(/\s/g, "")
        : constructorTypeCompletionQualifier(document, position);
    const kinds = typeContext === "base" ? ["type", "class", "namespace"]
        : typeContext ? ["type", "class", "union", "enum", "namespace"] : ["type", "class", "union"];

    let sourceModelCache = sidecarCompletionSourceModelCaches.get(model);
    if (!sourceModelCache) {
        sourceModelCache = new Map();
        sidecarCompletionSourceModelCaches.set(model, sourceModelCache);
    }
    const cacheKey = uri.toString();
    let cached = sourceModelCache.get(cacheKey);
    const includeBeforeCursor = (site) => site.line < position.line ||
        site.line === position.line && site.character < position.character;
    const includeEpoch = cached?.includeSites?.filter(includeBeforeCursor).length;
    if (cached?.text !== document.text || cached?.includeEpoch !== includeEpoch) {
        cached = { text: document.text, sourceModel: null, symbolsBySite: null };
        const sourceDocuments = new Map();
        let sourceConflict = false;
        for (const source of model.sources?.values?.() || []) {
            const sourcePath = source.uri?.fsPath || source.uri?.path || "";
            if (!path.isAbsolute(sourcePath)) continue;
            const key = compilerSidecarNavigationPathKey(sourcePath);
            const previous = sourceDocuments.get(key);
            if (previous && previous.text !== source.text) {
                sourceConflict = true;
                break;
            }
            if (!previous) sourceDocuments.set(key, source);
        }
        const contexts = [...(model.semanticSourceContexts?.values?.() || [])];
        const roots = contexts.filter((context) => context.kind === "module" && context.parent === 0 &&
            typeof context.filePath === "string" && compilerSidecarNavigationPathKey(context.filePath) === selectedPath);
        const root = roots.length === 1 ? roots[0] : null;
        const contextsByParent = new Map();
        for (const context of contexts) {
            const children = contextsByParent.get(context.parent) || [];
            children.push(context);
            contextsByParent.set(context.parent, children);
        }
        const includeSites = (contextsByParent.get(root?.id) || []).filter((child) => child.kind === "include" &&
            child.directive && compilerSidecarNavigationPathKey(child.directive.filePath) === selectedPath &&
            Number.isSafeInteger(child.directive.startLine) && child.directive.startLine > 0 &&
            Number.isSafeInteger(child.directive.startColumn) && child.directive.startColumn >= 0)
            .map((child) => ({ line: child.directive.startLine - 1, character: child.directive.startColumn }));
        // Reuse parsed source while typing within an include interval. Moving
        // across a native include site changes which source files are visible.
        cached.includeSites = includeSites;
        cached.includeEpoch = includeSites.filter(includeBeforeCursor).length;
        const reachableContextIds = new Set(root ? [root.id] : []);
        const reachablePaths = new Set(root ? [selectedPath] : []);
        const includeUrisByPath = new Map();
        const pendingContexts = root ? [root] : [];
        const completionLineStart = document.lineOffsets[position.line];
        const completionLocationIsValid = Number.isSafeInteger(completionLineStart);
        for (let cursor = 0; cursor < pendingContexts.length && !sourceConflict; cursor++) {
            if ((cursor & 255) === 0) checkCancelled();
            if (cursor >= MAX_COMPILER_SIDECAR_COMPLETION_SOURCE_FILES) {
                sourceConflict = true;
                break;
            }
            const parent = pendingContexts[cursor];
            const parentPath = typeof parent.filePath === "string"
                ? compilerSidecarNavigationPathKey(parent.filePath)
                : "";
            for (const child of contextsByParent.get(parent.id) || []) {
                if (reachableContextIds.has(child.id) || typeof child.filePath !== "string") continue;
                const childPath = compilerSidecarNavigationPathKey(child.filePath);
                const childSource = sourceDocuments.get(childPath);
                if (!childSource) continue;
                if (parent.id === root.id && child.kind === "include") {
                    const directive = child.directive;
                    if (!directive || compilerSidecarNavigationPathKey(directive.filePath) !== parentPath ||
                        !completionLocationIsValid || !Number.isSafeInteger(directive.startLine) || directive.startLine < 1 ||
                        directive.startLine - 1 > position.line ||
                        directive.startLine - 1 === position.line && directive.startColumn >= position.character) continue;
                }
                reachableContextIds.add(child.id);
                reachablePaths.add(childPath);
                const includeUris = includeUrisByPath.get(parentPath) || new Set();
                includeUris.add(childSource.uri.toString());
                includeUrisByPath.set(parentPath, includeUris);
                pendingContexts.push(child);
                if (reachablePaths.size > MAX_COMPILER_SIDECAR_COMPLETION_SOURCE_FILES) {
                    sourceConflict = true;
                    break;
                }
            }
        }

        const documentEntries = [];
        let totalSourceBytes = 0;
        if (root && !sourceConflict && sourceDocuments.get(selectedPath)?.text === document.text) {
            for (const [sourcePath, source] of sourceDocuments) {
                if (!reachablePaths.has(sourcePath)) continue;
                const sourceBytes = Buffer.byteLength(source.text, "utf8");
                if (sourceBytes > MAX_COMPILER_SIDECAR_PARAMETER_SOURCE_BYTES ||
                    totalSourceBytes + sourceBytes > MAX_COMPILER_SIDECAR_PARAMETER_TOTAL_SOURCE_BYTES) {
                    sourceConflict = true;
                    break;
                }
                totalSourceBytes += sourceBytes;
                documentEntries.push({
                    uri: source.uri,
                    parsed: parseFreeBasicText(source.text, model.compilerRemIdentifierOffsets?.(source.uri),
                        model.compilerDefaultEscapedStringRanges?.(source.uri)),
                    includeUris: includeUrisByPath.get(sourcePath) || new Set()
                });
            }
        } else {
            sourceConflict = true;
        }

        if (!sourceConflict && documentEntries.length) {
            const sourceModel = new FreeBasicSemanticModel(documentEntries);
            const symbolsBySite = new Map();
            let siteLimitExceeded = false;
            for (let index = 0; index < model.semanticBindings.length; index++) {
                if ((index & 255) === 0) checkCancelled();
                const binding = model.semanticBindings[index];
                if (binding?.role !== "declaration" || binding.physical !== true ||
                    typeof binding.filePath !== "string" ||
                    !reachablePaths.has(compilerSidecarNavigationPathKey(binding.filePath)) ||
                    !Number.isSafeInteger(binding.startLine) || binding.startLine < 1 ||
                    binding.endLine !== binding.startLine || !Number.isSafeInteger(binding.startColumn) ||
                    binding.startColumn < 0 || !Number.isSafeInteger(binding.endColumn) ||
                    binding.endColumn <= binding.startColumn ||
                    !Number.isSafeInteger(binding.symbol) || binding.symbol < 1) continue;
                const bindingPathKey = compilerSidecarNavigationPathKey(binding.filePath);
                const key = `${bindingPathKey}:${binding.startLine - 1}:${binding.startColumn}:${binding.endColumn}`;
                const symbols = symbolsBySite.get(key) || new Set();
                symbols.add(binding.symbol);
                symbolsBySite.set(key, symbols);
                if (symbolsBySite.size > MAX_COMPILER_SIDECAR_COMPLETION_TYPE_CANDIDATES * 100) {
                    siteLimitExceeded = true;
                    break;
                }
            }
            if (!siteLimitExceeded) {
                cached = { ...cached, sourceModel, symbolsBySite, reachablePaths };
            }
        }
        sourceModelCache.set(cacheKey, cached);
        while (sourceModelCache.size > MAX_COMPILER_SIDECAR_COMPLETION_SOURCE_MODEL_CACHE_DOCUMENTS) {
            sourceModelCache.delete(sourceModelCache.keys().next().value);
        }
    } else {
        sourceModelCache.delete(cacheKey);
        sourceModelCache.set(cacheKey, cached);
    }
    if (!cached?.sourceModel || !cached.symbolsBySite) return [];

    const visibleNames = new Set(visibleEntries.filter((entry) => !typeContext || entry.declaration?.type === "macro" ||
        kinds.includes(entry.declaration?.type)).map((entry) =>
        normalizeIdentifier(entry.name || entry.declaration?.name || "")
    ));
    const source = cached.sourceModel.getDocument(uri);
    const completionOffset = positionOffset(source, position.line, position.character);
    const scope = scopeAt(source, completionOffset);
    let candidates = qualifier
        ? typeContext
            ? cached.sourceModel.members(cached.sourceModel.resolveName(source, qualifier, scope, completionOffset), source, scope)
            : cached.sourceModel.completeMembers(uri, position.line, position.character) || []
        : cached.sourceModel.visibleEntries(uri, position.line, position.character, limit);
    if (typeContext && !qualifier) {
        // visibleEntries folds equal names before declaration-site validation.
        // Type lookup must retain branch siblings until native bindings select
        // the active declaration, and ignore value names in the type namespace.
        const names = new Set();
        for (let index = 0; index < cached.sourceModel.entries.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const entry = cached.sourceModel.entries[index];
            if (!kinds.includes(entry.declaration.type) || !entry.key.startsWith(normalizeIdentifier(prefixName))) continue;
            const declaration = entry.declaration;
            const entryPath = entry.uri?.fsPath || entry.uri?.path || "";
            const site = `${compilerSidecarNavigationPathKey(entryPath)}:${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`;
            if (cached.symbolsBySite.get(site)?.size === 1) names.add(entry.key);
        }
        candidates = [...names].flatMap((name) => cached.sourceModel.resolveTypeName(
            { document: source, scope, offset: completionOffset }, name, 0
        ));
    }
    const records = [];
    const emitted = new Set();
    for (let index = 0; index < candidates.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const entry = candidates[index];
        const declaration = entry.declaration;
        const name = entry.name || declaration?.name || "";
        const qualifiedName = entry.qualifiedName || declaration?.qualifiedName || "";
        const entryPath = entry.uri?.fsPath || entry.uri?.path || "";
        const entryPathKey = path.isAbsolute(entryPath) ? compilerSidecarNavigationPathKey(entryPath) : "";
        if (!declaration || !kinds.includes(declaration.type) ||
            (!typeContext && entry.conditional) || entry.provisional || declaration.provisional ||
            typeof name !== "string" || !normalizeIdentifier(name).startsWith(normalizeIdentifier(prefixName)) ||
            qualifier && !normalizeIdentifier(qualifiedName).startsWith(`${normalizeIdentifier(qualifier)}.`) ||
            visibleNames.has(normalizeIdentifier(name)) || !entryPathKey || !cached.reachablePaths.has(entryPathKey) ||
            !Number.isSafeInteger(entry.offset) || entryPathKey === selectedPath && entry.offset >= completionOffset) continue;
        const site = `${entryPathKey}:${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`;
        const symbols = cached.symbolsBySite.get(site);
        if (symbols?.size !== 1 || emitted.has(site)) continue;
        emitted.add(site);
        records.push({ ...entry, compilerSymbolId: symbols.values().next().value, completionSemanticModel: cached.sourceModel });
        if (records.length >= Math.min(limit, MAX_COMPILER_SIDECAR_COMPLETION_TYPE_CANDIDATES)) break;
    }
    return records;
}

function compilerSidecarCompletionRecords(model, uri, document, position, visibleEntries, prefix, limit,
    checkCancelled, enumCompletionContext) {
    if (!model.semanticSidecarOnly || model.partial || !prefix ||
        !Array.isArray(model.semanticBindings) || model.semanticBindings.length === 0) return [];
    const compilerPrefix = String(prefix).match(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/)?.[0] || "";
    if (!compilerPrefix) return [];
    const filePath = uri.fsPath || uri.path;
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return [];
    const selectedPath = compilerSidecarNavigationPathKey(filePath);
    const sources = compilerSidecarNavigationSources(model);
    const source = sources.get(selectedPath);
    if (!source || source.text !== document.text) return [];
    const scopeDocument = compilerSidecarCompletionScopeDocument(model, source);
    if (!scopeDocument) return [];
    const completionOffset = positionOffset(scopeDocument, position.line, position.character);
    const completionScope = scopeAt(scopeDocument, completionOffset);
    const reachableSources = compilerSidecarCompletionReachableSources(
        model, selectedPath, document, position, sources, checkCancelled
    );
    if (!reachableSources.size) return [];
    const reachablePaths = new Set(reachableSources.keys());
    const enumQualifierSite = enumCompletionContext?.site || null;
    const scopeDocuments = new Map([[selectedPath, scopeDocument]]);
    const scopeDocumentForPath = (candidatePath, candidateSource) => {
        let candidate = scopeDocuments.get(candidatePath);
        if (!candidate) {
            candidate = compilerSidecarCompletionScopeDocument(model, candidateSource);
            if (candidate) scopeDocuments.set(candidatePath, candidate);
        }
        return candidate;
    };
    const visibleNames = new Set(visibleEntries.map((entry) =>
        normalizeIdentifier(entry.name || entry.declaration?.name || "")
    ));
    const declarationBindingIndex = compilerSidecarCompletionDeclarationBindings(model, reachablePaths, checkCancelled);
    if (!declarationBindingIndex) return [];
    const bindingsBySymbol = declarationBindingIndex.bindingsBySymbol;
    const namespaceSymbolsByName = compilerSidecarCompletionNamespaceSymbolsByName(
        reachableSources, scopeDocumentForPath, declarationBindingIndex, checkCancelled
    );
    const currentNamespaceId = compilerSidecarCompletionNamespaceId(
        model, selectedPath, scopeDocument, completionScope, declarationBindingIndex
    );
    const symbolsByName = new Map();
    const rangesBySymbol = new Map();
    const scopesBySymbolRange = new Map();
    const compilerProvenEnumCompletionRanges = new Set();
    const namespaceImportVisibility = new Map();
    const namespaceImportedForCompletion = (namespaceId) => {
        if (!namespaceId || !currentNamespaceId) return false;
        if (namespaceImportVisibility.has(namespaceId)) return namespaceImportVisibility.get(namespaceId);
        const visible = compilerSidecarNamespaceImportMakesVisible(
            model, reachablePaths, namespaceId, currentNamespaceId, selectedPath, position,
            reachableSources, scopeDocumentForPath, namespaceSymbolsByName, checkCancelled
        );
        namespaceImportVisibility.set(namespaceId, visible);
        return visible;
    };
    const enumCompletionOwner = enumCompletionContext?.owner || 0;
    const hasQualifiedEnumSite = Boolean(enumCompletionContext?.site);
    let inspectedDeclarations = 0;
    let candidateDeclarations = 0;
    for (const [symbol, bindings] of bindingsBySymbol) {
        checkCancelled();
        for (const binding of bindings) {
            if ((inspectedDeclarations++ & 255) === 0) checkCancelled();
            const bindingPath = compilerSidecarNavigationPathKey(binding.filePath);
            const candidateSource = reachableSources.get(bindingPath);
            if (!candidateSource) continue;
            const candidateScopeDocument = scopeDocumentForPath(bindingPath, candidateSource);
            if (!candidateScopeDocument) continue;
            const matched = semanticBindingToken(candidateSource, binding);
            if (!matched || bindingPath === selectedPath && matched.start >= completionOffset ||
                !normalizeIdentifier(matched.token.name).startsWith(normalizeIdentifier(compilerPrefix)) ||
                visibleNames.has(matched.token.key)) continue;
            const declarationPosition = { line: matched.token.line, character: matched.token.startColumn };
            const sourceResolutions = matched.token.index >= 0
                ? model.resolveAt(candidateSource.uri, declarationPosition.line, declarationPosition.character)
                : [];
            const parsedEnumMember = candidateScopeDocument.entries.some((entry) =>
                entry.declaration.type === "enumMember" && entry.declaration.line === declarationPosition.line &&
                entry.declaration.startColumn === declarationPosition.character &&
                entry.declaration.endColumn === matched.token.endColumn &&
                normalizeIdentifier(entry.name) === matched.token.key
            );
            const enumMemberDeclaration = parsedEnumMember && (!sourceResolutions.length ||
                sourceResolutions.every((entry) => entry.declaration?.type === "enumMember" &&
                    entry.declaration.line === declarationPosition.line &&
                    entry.declaration.startColumn === declarationPosition.character));
            if (bindingPath !== selectedPath && !enumMemberDeclaration) continue;
            if (matched.token.index >= 0) {
                if (!enumMemberDeclaration && (!compilerOptionNoKeywordIdentifierAtPosition(
                    candidateSource, declarationPosition
                ) ||
                    sourceResolutions.length)) continue;
            }
            if (++candidateDeclarations > MAX_COMPILER_SIDECAR_COMPLETION_DECLARATIONS) return [];
            let declarationScope = scopeAt(candidateScopeDocument, matched.start);
            let enumCompletionInfo = null;
            if (declarationScope?.kind === "enum") {
                enumCompletionInfo = compilerSidecarEnumMemberCompletionInfo(
                    model, candidateScopeDocument, candidateSource, symbol, binding, matched, declarationBindingIndex
                );
                if (!enumCompletionInfo || hasQualifiedEnumSite && enumCompletionInfo.owner !== enumCompletionOwner ||
                    !hasQualifiedEnumSite && enumCompletionOwner && enumCompletionInfo.owner !== enumCompletionOwner ||
                    enumCompletionInfo.explicit && !hasQualifiedEnumSite) continue;
                declarationScope = enumCompletionInfo.scope;
            } else if (enumQualifierSite) {
                continue;
            }
            const declarationScopeVisible = compilerSidecarCompletionScopeVisibleFromSource(
                declarationScope, completionScope, bindingPath, selectedPath, completionOffset
            );
            const namespaceImportVisible = namespaceImportedForCompletion(enumCompletionInfo?.namespaceId);
            if (!enumCompletionOwner && !declarationScopeVisible && !namespaceImportVisible) continue;
            const symbols = symbolsByName.get(matched.token.key) || new Set();
            symbols.add(symbol);
            symbolsByName.set(matched.token.key, symbols);
            const ranges = rangesBySymbol.get(symbol) || new Set();
            const range = `${bindingPath}:${matched.token.line}:${matched.token.startColumn}:${matched.token.endColumn}`;
            ranges.add(range);
            const sourceRange = `${matched.token.line}:${matched.token.startColumn}:${matched.token.endColumn}`;
            if (bindingPath === selectedPath) ranges.add(sourceRange);
            rangesBySymbol.set(symbol, ranges);
            scopesBySymbolRange.set(`${symbol}:${range}`, declarationScope);
            if (bindingPath === selectedPath) scopesBySymbolRange.set(`${symbol}:${sourceRange}`, declarationScope);
            if (enumCompletionOwner && enumCompletionInfo || namespaceImportVisible && enumCompletionInfo) {
                compilerProvenEnumCompletionRanges.add(`${symbol}:${range}`);
                if (bindingPath === selectedPath) compilerProvenEnumCompletionRanges.add(`${symbol}:${sourceRange}`);
            }
        }
    }
    const records = [];
    const emitted = new Set();
    for (const [name, symbols] of symbolsByName) {
        if (symbols.size !== 1 || visibleNames.has(name)) continue;
        const symbol = symbols.values().next().value;
        const selected = compilerSidecarNavigationEntryRecords(model, { symbol, sources }, checkCancelled);
        if (!selected.complete) continue;
        for (const entry of selected.entries) {
            const entryPath = entry.uri?.fsPath || entry.uri?.path || "";
            const entryPathKey = path.isAbsolute(entryPath) ? compilerSidecarNavigationPathKey(entryPath) : "";
            if (entry.declaration.type !== "enumMember" || entryPathKey === selectedPath ||
                !reachablePaths.has(entryPathKey)) continue;
            const range = `${entryPathKey}:${entry.declaration.line}:${entry.declaration.startColumn}:${entry.declaration.endColumn}`;
            if (!rangesBySymbol.get(symbol)?.has(range)) continue;
            const declarationScope = scopesBySymbolRange.get(`${symbol}:${range}`);
            const key = `${symbol}:${range}`;
            if (!compilerProvenEnumCompletionRanges.has(key) && !compilerSidecarCompletionScopeVisibleFromSource(
                declarationScope, completionScope, entryPathKey, selectedPath, completionOffset
            )) continue;
            if (emitted.has(key)) continue;
            emitted.add(key);
            records.push(entry);
            if (records.length >= Math.min(limit, MAX_COMPILER_SIDECAR_COMPLETION_DECLARATIONS)) return records;
        }
        for (const entry of selected.entries) {
            if (!(["variable", "enumMember"].includes(entry.declaration.type)) || !entry.uri?.fsPath ||
                compilerSidecarNavigationPathKey(entry.uri.fsPath) !== selectedPath ||
                !rangesBySymbol.get(symbol)?.has(`${entry.declaration.line}:${entry.declaration.startColumn}:${entry.declaration.endColumn}`)) continue;
            const range = `${entry.declaration.line}:${entry.declaration.startColumn}:${entry.declaration.endColumn}`;
            const declarationScope = scopesBySymbolRange.get(`${symbol}:${range}`);
            if (!compilerProvenEnumCompletionRanges.has(`${symbol}:${range}`) &&
                !compilerSidecarCompletionScopeContains(declarationScope, completionScope) ||
                entry.declaration.type === "variable" && !compilerSidecarCompletionScopeIsVisible(
                    declarationScope, completionScope, entry.compilerFacts?.compilerStorageClass
                )) continue;
            const key = `${symbol}:${range}`;
            if (emitted.has(key)) continue;
            emitted.add(key);
            records.push(entry);
            if (records.length >= Math.min(limit, MAX_COMPILER_SIDECAR_COMPLETION_DECLARATIONS)) return records;
        }
    }
    return records;
}

function compilerSidecarTokenScopeEntry(model, sources, entry) {
    if (!CALL_HIERARCHY_TYPES.has(entry.declaration.type)) return entry;
    const source = sources.get(compilerSidecarNavigationPathKey(entry.uri.fsPath || entry.uri.path));
    const document = source && compilerSidecarCompletionScopeDocument(model, source);
    const candidates = (document?.entries || []).filter((candidate) =>
        candidate.declaration.line === entry.declaration.line && candidate.declaration.endColumn === entry.declaration.endColumn &&
        normalizeIdentifier(candidate.declaration.name.split(".").at(-1)) === normalizeIdentifier(entry.name));
    if (candidates.length !== 1) return null;
    const selected = candidates[0];
    return { ...entry, scope: { kind: selected.scope.kind }, callableKind: model.compilerCallableKinds?.get(entry.compilerSymbolId),
        declaration: { ...entry.declaration, name: selected.declaration.name } };
}

function compilerSidecarPhysicalIdentifierEntries(model, uri, document, checkCancelled,
    { declarationsOnly = false, includePhysicalIdentifiers = false } = {}) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(model.semanticBindings) ||
        !model.semanticBindings.length) return [];
    const filePath = uri.fsPath || uri.path;
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return [];
    const selectedPath = compilerSidecarNavigationPathKey(filePath);
    const sources = compilerSidecarNavigationSources(model);
    const source = sources.get(selectedPath);
    if (!source || source.text !== document.text) return [];
    const hasNoKeywordDirectives = declarationsOnly &&
        compilerSidecarNoKeywordDirectiveCache(document).firstOffsets.size > 0;
    const bindings = compilerSidecarPhysicalBindingFileIndex(model, selectedPath, checkCancelled);
    if (!bindings) return [];
    const ranges = new Map();
    for (let index = 0; index < bindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const { binding } = bindings[index];
        if (declarationsOnly && binding.role !== "declaration") continue;
        const matched = semanticBindingToken(source, binding);
        if (!matched) continue;
        if (matched.token.index >= 0 && !includePhysicalIdentifiers) {
            /* The physical lexer may now see the token from B offsets even
               when the expanded source model still cannot resolve it. */
            if (!hasNoKeywordDirectives ||
                !compilerOptionNoKeywordIdentifierAtPosition(document, {
                    line: matched.token.line,
                    character: matched.token.startColumn
                }) || model.resolveAt(uri, matched.token.line, matched.token.startColumn).length) continue;
        }
        const key = `${matched.token.line}:${matched.token.startColumn}:${matched.token.endColumn}`;
        let range = ranges.get(key);
        if (!range) {
            const maximum = includePhysicalIdentifiers ? MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS : MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS;
            if (ranges.size >= maximum) return [];
            range = { matched, symbols: new Set(), declaration: false };
            ranges.set(key, range);
        }
        range.symbols.add(compilerSidecarCanonicalSymbol(model, binding.symbol));
        if (binding.role === "declaration") range.declaration = true;
    }

    const entriesBySymbol = new Map();
    const records = [];
    for (const range of ranges.values()) {
        checkCancelled();
        if (range.symbols.size !== 1) continue;
        const symbol = range.symbols.values().next().value;
        let selected = entriesBySymbol.get(symbol);
        if (selected === undefined) {
            selected = compilerSidecarNavigationEntryRecords(model, { symbol, sources }, checkCancelled);
            if (includePhysicalIdentifiers) {
                const entries = selected.entries.map((entry) => compilerSidecarTokenScopeEntry(model, sources, entry));
                selected = entries.some((entry) => !entry) ? { complete: false, entries: [] } : { ...selected, entries };
            }
            entriesBySymbol.set(symbol, selected);
        }
        if (!selected.complete || !selected.entries.length ||
            !includePhysicalIdentifiers &&
                selected.entries.some((entry) => entry.declaration.type !== "variable")) continue;
        if (includePhysicalIdentifiers && [
            new Set(selected.entries.map(semanticTokenType)),
            new Set(selected.entries.map((entry) => entry.declaration.modifiers?.includes("STATIC") === true))
        ].some((values) => values.size > 1)) continue;
        const entry = selected.entries.find((candidate) => candidate.uri?.fsPath &&
            compilerSidecarNavigationPathKey(candidate.uri.fsPath) === selectedPath &&
            candidate.declaration.line === range.matched.token.line &&
            candidate.declaration.startColumn === range.matched.token.startColumn &&
            candidate.declaration.endColumn === range.matched.token.endColumn) || selected.entries[0];
        records.push({ matched: range.matched, declaration: range.declaration, entry,
            deprecated: selected.entries.some(semanticEntryIsDeprecated) });
    }
    if (includePhysicalIdentifiers && typeof model.attachSourceDocumentation === "function") {
        // Reuse compiler-confirmed comment association once for the batch, not
        // once per token. A prototype's tag applies to the same symbol's uses.
        model.attachSourceDocumentation(model.compilerCommentMarkers,
            [...entriesBySymbol.values()].flatMap((selected) => selected.entries));
        for (const record of records) {
            record.deprecated = entriesBySymbol.get(record.entry.compilerSymbolId)?.entries.some(semanticEntryIsDeprecated) || false;
        }
    }
    return records;
}

function compilerSidecarPhysicalIdentifierSemanticTokens(model, uri, document, accessRoles, checkCancelled, readonlyTokens) {
    const entries = compilerSidecarPhysicalIdentifierEntries(
        model, uri, document, checkCancelled, { includePhysicalIdentifiers: true }
    );
    const records = [];
    for (const { matched, declaration, entry, deprecated } of entries) {
        let modifiers = 0;
        if (declaration) modifiers |= 1 << TOKEN_MODIFIERS.indexOf(
            entry.declaration.modifiers?.includes("DECLARE") ? "declaration" : "definition");
        if (semanticEntryIsReadonly(entry, readonlyTokens.has(matched.token.offset))) modifiers |= 1 << TOKEN_MODIFIERS.indexOf("readonly");
        if (entry.declaration.modifiers?.includes("STATIC")) modifiers |= 1 << TOKEN_MODIFIERS.indexOf("static");
        if (entry.declaration.modifiers?.includes("ABSTRACT")) modifiers |= 1 << TOKEN_MODIFIERS.indexOf("abstract");
        if (deprecated) modifiers |= 1 << TOKEN_MODIFIERS.indexOf("deprecated");
        const accessRole = accessRoles.get(matched.token.offset);
        if (accessRole === "write" || accessRole === "read-write") {
            modifiers |= 1 << TOKEN_MODIFIERS.indexOf("modification");
        }
        records.push({
            line: matched.token.line,
            character: matched.token.startColumn,
            length: matched.token.endColumn - matched.token.startColumn,
            type: TOKEN_TYPES.indexOf(semanticTokenType(entry)),
            modifiers
        });
    }
    return records;
}

function compilerSidecarNavigationOccurrences(model, selection, includeDeclaration, onlyUri, checkCancelled,
    declarationsOnly = false) {
    if (!selection || !selection.symbol) return [];
    const onlyPath = onlyUri
        ? compilerSidecarNavigationPathKey(onlyUri.fsPath || onlyUri.path || "")
        : "";
    const occurrences = [];
    const keys = new Set();
    const bindingIndexes = new Set();
    const bindingPaths = new Map();
    const bindingPathKey = (bindingPath) => {
        let key = bindingPaths.get(bindingPath);
        if (!key) {
            key = compilerSidecarNavigationPathKey(bindingPath);
            bindingPaths.set(bindingPath, key);
        }
        return key;
    };
    for (let index = 0; index < model.semanticBindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = model.semanticBindings[index];
        if (compilerSidecarCanonicalSymbol(model, binding.symbol) !== selection.symbol || binding.physical !== true ||
            declarationsOnly && binding.role !== "declaration" ||
            !declarationsOnly && binding.role !== "reference" && !(includeDeclaration && binding.role === "declaration") ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath)) continue;
        const fileKey = bindingPathKey(binding.filePath);
        if (onlyPath && fileKey !== onlyPath) continue;
        const source = selection.sources.get(fileKey);
        if (!source) continue;
        const range = semanticBindingToken(source, binding);
        if (!range) continue;
        const key = `${source.uri.toString()}:${range.token.line}:${range.token.startColumn}:${range.token.endColumn}`;
        if (keys.has(key)) continue;
        keys.add(key);
        bindingIndexes.add(index + 1);
        occurrences.push({
            uri: source.uri,
            occurrence: {
                line: range.token.line,
                startColumn: range.token.startColumn,
                endColumn: range.token.endColumn,
                name: source.text.slice(range.start, range.end)
            },
            ...(binding.role === "declaration" ? { declaration: true } : {}),
            bindingIndex: index + 1
        });
        if (occurrences.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
    }

    if (onlyUri && bindingIndexes.size && Array.isArray(model.semanticAccessRoles) &&
        model.semanticAccessRoles.length <= MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) {
        const roles = new Map();
        for (let index = 0; index < model.semanticAccessRoles.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const access = model.semanticAccessRoles[index];
            if (!bindingIndexes.has(access.binding) ||
                !["read", "write", "read-write", "address", "byref", "callee"].includes(access.role)) continue;
            const previous = roles.get(access.binding);
            roles.set(access.binding, previous && previous !== access.role ? "" : access.role);
        }
        for (const occurrence of occurrences) {
            const role = roles.get(occurrence.bindingIndex);
            if (role) occurrence.accessRole = role;
        }
    }

    const sourceOrder = new Map();
    for (const occurrence of occurrences) {
        const sourcePath = compilerSidecarNavigationPathKey(occurrence.uri.fsPath || occurrence.uri.path || "");
        if (!sourceOrder.has(sourcePath)) sourceOrder.set(sourcePath, sourceOrder.size);
    }
    occurrences.sort((first, second) => {
        const firstPath = compilerSidecarNavigationPathKey(first.uri.fsPath || first.uri.path || "");
        const secondPath = compilerSidecarNavigationPathKey(second.uri.fsPath || second.uri.path || "");
        const pathOrder = sourceOrder.get(firstPath) - sourceOrder.get(secondPath);
        if (pathOrder) return pathOrder;
        return first.occurrence.line - second.occurrence.line ||
            first.occurrence.startColumn - second.occurrence.startColumn ||
            first.occurrence.endColumn - second.occurrence.endColumn;
    });
    return occurrences.map(({ bindingIndex: _bindingIndex, ...occurrence }) => occurrence);
}

function compilerSidecarDefinitionRecords(model, selection, checkCancelled) {
    const declarations = compilerSidecarNavigationOccurrences(model, selection, true, null, checkCancelled, true);
    if (!declarations?.length) return null;
    return declarations.map((entry) => {
        const name = entry.occurrence.name;
        return {
            name,
            compilerSymbolId: selection.symbol,
            uri: uriRecord(entry.uri),
            declaration: {
                name,
                type: "variable",
                line: entry.occurrence.line,
                startColumn: entry.occurrence.startColumn,
                endColumn: entry.occurrence.endColumn
            }
        };
    });
}

function compilerSemanticAccessRoleState(model, checkCancelled) {
    if (!Array.isArray(model.semanticBindings) || !Array.isArray(model.semanticAccessRoles) ||
        !model.semanticAccessRoles.length) return null;

    let state = semanticAccessRoleCaches.get(model);
    if (!state) {
        const rolesByBinding = new Map();
        for (let index = 0; index < model.semanticAccessRoles.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const access = model.semanticAccessRoles[index];
            if (Number.isSafeInteger(access.binding) && access.binding > 0 &&
                ["read", "write", "read-write", "address", "byref", "callee"].includes(access.role)) {
                rolesByBinding.set(access.binding, access.role);
            }
        }
        const bindingsByFile = new Map();
        const pathKey = (filePath) => {
            const resolved = path.resolve(filePath);
            return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        };
        for (let index = 0; index < model.semanticBindings.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const binding = model.semanticBindings[index];
            /* ACC references the one-based position of its B record. */
            const role = rolesByBinding.get(index + 1);
            if (!role || binding.physical !== true || !binding.filePath) continue;
            const file = pathKey(binding.filePath);
            const records = bindingsByFile.get(file) || [];
            records.push({ binding, role });
            bindingsByFile.set(file, records);
        }
        state = { bindingsByFile, byDocument: new Map() };
        semanticAccessRoleCaches.set(model, state);
    }
    return state;
}

function compilerSemanticAccessRolesForDocument(model, uri, document, checkCancelled) {
    const state = compilerSemanticAccessRoleState(model, checkCancelled);
    if (!state) return new Map();
    const uriKey = uri.toString();
    const cached = state.byDocument.get(uriKey);
    if (cached) return cached;
    const filePath = uri.fsPath || uri.path;
    const resolvedPath = filePath && path.resolve(filePath);
    const fileKey = resolvedPath && (process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath);
    const bindings = fileKey ? state.bindingsByFile.get(fileKey) || [] : [];
    const rolesByToken = new Map();
    for (let index = 0; index < bindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const { binding, role } = bindings[index];
        const matched = semanticBindingToken(document, binding);
        if (!matched) continue;
        const roles = rolesByToken.get(matched.token.offset) || new Set();
        roles.add(role);
        rolesByToken.set(matched.token.offset, roles);
    }
    const accessRoles = new Map([...rolesByToken]
        .filter(([, roles]) => roles.size === 1)
        .map(([offset, roles]) => [offset, roles.values().next().value]));
    state.byDocument.set(uriKey, accessRoles);
    return accessRoles;
}

function compilerSemanticReadonlyTokens(model, uri, document, checkCancelled) {
    let documents = semanticReadonlyCaches.get(model);
    if (!documents) { documents = new Map(); semanticReadonlyCaches.set(model, documents); }
    const key = uri.toString();
    if (documents.has(key)) {
        const tokens = documents.get(key);
        documents.delete(key);
        documents.set(key, tokens);
        return tokens;
    }
    const filePath = uri.fsPath || uri.path;
    const bindings = filePath && path.isAbsolute(filePath)
        ? compilerSidecarPhysicalBindingFileIndex(model, compilerSidecarNavigationPathKey(filePath), checkCancelled) : [];
    const values = new Map();
    for (let index = 0; index < (bindings?.length || 0); index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = bindings[index].binding;
        const matched = semanticBindingToken(document, binding);
        if (!matched) continue;
        const readonly = model.compilerFactsBySemanticIdentity?.get(binding.symbol)?.valueConst;
        // All compiler contexts at one physical token must agree. Unknown
        // qualifiers cannot inherit a readonly result from a different include.
        const previous = values.get(matched.token.offset);
        values.set(matched.token.offset, (previous === undefined || previous === true) && readonly === true);
    }
    const tokens = new Set([...values].filter(([, readonly]) => readonly).map(([offset]) => offset));
    documents.set(key, tokens);
    while (documents.size > MAX_SEMANTIC_TOKEN_CACHE_DOCUMENTS) documents.delete(documents.keys().next().value);
    return tokens;
}

function compilerSidecarAccessRolesAtSites(model, sites, checkCancelled) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(sites) ||
        sites.length > MAX_COMPILER_SIDECAR_ACCESS_ROLE_SITES) return [];
    if (!Array.isArray(model.semanticBindings) || !Array.isArray(model.semanticAccessRoles) ||
        !model.semanticBindings.length || !sites.length) return [];
    const pathKey = (filePath) => {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const sitesByFile = new Map();
    for (let index = 0; index < sites.length; index++) {
        const site = sites[index];
        if (!site || typeof site.filePath !== "string" || !path.isAbsolute(site.filePath) ||
            !Number.isSafeInteger(site.line) || site.line < 0 ||
            !Number.isSafeInteger(site.startColumn) || site.startColumn < 0 ||
            !Number.isSafeInteger(site.endColumn) || site.endColumn <= site.startColumn) continue;
        const file = pathKey(site.filePath);
        const group = sitesByFile.get(file) || { filePath: site.filePath, sites: [] };
        group.sites.push({ index, site });
        sitesByFile.set(file, group);
    }

    const results = [];
    for (const group of sitesByFile.values()) {
        checkCancelled();
        const document = model.getDocument(CompilerUri.file(group.filePath));
        if (!document) continue;
        const rolesByToken = compilerSemanticAccessRolesForDocument(model, document.uri, document, checkCancelled);
        const readonlyTokens = compilerSemanticReadonlyTokens(model, document.uri, document, checkCancelled);
        for (const { index, site } of group.sites) {
            const token = document.byLine?.get(site.line)?.find((candidate) => candidate.kind === "identifier" &&
                candidate.startColumn === site.startColumn && candidate.endColumn === site.endColumn);
            const role = token && rolesByToken.get(token.offset);
            const readonly = token && readonlyTokens.has(token.offset);
            if (role || readonly) results.push({ index, ...(role ? { role } : {}), ...(readonly ? { readonly: true } : {}) });
        }
    }
    return results;
}

function compilerSidecarCallBindingRecords(model, checkCancelled, onlyUri = null, position = null, name = "") {
    const semanticBindings = model.semanticBindings;
    const callLinks = model.compilerSourceCallBindings;
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(semanticBindings) ||
        !Array.isArray(callLinks) || !semanticBindings.length || !callLinks.length) {
        return { complete: false, calls: [] };
    }

    const declarationsBySymbol = new Map();
    for (let index = 0; index < semanticBindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = semanticBindings[index];
        if (binding.role !== "declaration" || !binding.physical || !binding.filePath) continue;
        const declarations = declarationsBySymbol.get(binding.symbol) || [];
        declarations.push(binding);
        declarationsBySymbol.set(binding.symbol, declarations);
    }

    const sourcePathKey = (filePath) => {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const onlyPath = onlyUri?.fsPath || onlyUri?.path ? sourcePathKey(onlyUri.fsPath || onlyUri.path) : "";
    const selectedPosition = position && onlyUri ? model.getDocument(onlyUri) : null;
    const selectedOffset = selectedPosition
        ? positionOffset(selectedPosition, position.line, position.character)
        : null;
    const requestedName = normalizeIdentifier(String(name || "").split(".").at(-1));
    const sitesBySymbol = new Map();
    const declarationSitesFor = (symbol) => {
        if (sitesBySymbol.has(symbol)) return sitesBySymbol.get(symbol);
        const sites = new Map();
        for (const binding of declarationsBySymbol.get(symbol) || []) {
            checkCancelled();
            const source = model.getDocument(CompilerUri.file(binding.filePath));
            const range = semanticBindingToken(source, binding);
            if (!range) continue;
            const key = `${source.uri.toString()}:${range.token.line}:${range.token.startColumn}:${range.token.endColumn}`;
            sites.set(key, {
                filePath: source.uri.fsPath || source.uri.path || binding.filePath,
                line: range.token.line,
                startColumn: range.token.startColumn,
                endColumn: range.token.endColumn,
                name: range.token.name
            });
        }
        const result = [...sites.values()];
        sitesBySymbol.set(symbol, result);
        return result;
    };

    const callsBySite = new Map();
    for (let index = 0; index < callLinks.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const relationship = callLinks[index];
        /* H targets use the one-based ordinal of their corresponding B record. */
        const binding = semanticBindings[relationship.target - 1];
        if (!binding || binding.role !== "reference" || !binding.physical || !binding.filePath) continue;
        const callName = normalizeIdentifier(String(binding.name || "").split(".").at(-1));
        if (requestedName && requestedName !== callName) continue;
        const filePath = sourcePathKey(binding.filePath);
        if (onlyPath && filePath !== onlyPath) continue;
        const source = model.getDocument(CompilerUri.file(binding.filePath));
        const range = semanticBindingToken(source, binding);
        if (!range) continue;
        if (selectedPosition && source.uri.toString() === selectedPosition.uri.toString() &&
            (selectedOffset < range.start || selectedOffset >= range.end)) continue;
        const declarations = declarationSitesFor(binding.symbol);
        if (!declarations.length) continue;
        const key = `${source.uri.toString()}:${range.token.line}:${range.token.startColumn}:${range.token.endColumn}`;
        let call = callsBySite.get(key);
        if (!call) {
            if (callsBySite.size >= MAX_COMPILER_SIDECAR_CALL_BINDINGS) return { complete: false, calls: [] };
            call = {
                filePath: source.uri.fsPath || source.uri.path || binding.filePath,
                line: range.token.line,
                startColumn: range.token.startColumn,
                endColumn: range.token.endColumn,
                targetSymbols: new Set(),
                declarations: new Map()
            };
            callsBySite.set(key, call);
        }
        call.targetSymbols.add(binding.symbol);
        for (const declaration of declarations) {
            const declarationKey = `${declaration.filePath}:${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`;
            call.declarations.set(declarationKey, declaration);
        }
    }

    const calls = [...callsBySite.values()].map((call) => ({
        filePath: call.filePath,
        line: call.line,
        startColumn: call.startColumn,
        endColumn: call.endColumn,
        targetSymbols: [...call.targetSymbols],
        declarations: [...call.declarations.values()]
    }));
    return { complete: true, calls };
}

function compilerSidecarSelectedCallDeclarations(model, checkCancelled, uri, document, context) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(model.semanticProcedures)) return [];
    const callee = callNameSpan(document, context);
    if (!callee) return [];
    const terminalName = context.name.split(".").at(-1);
    const terminalStart = callee.end - terminalName.length;
    if (terminalStart < callee.start) return [];
    const position = positionAtOffset(document, terminalStart);
    const result = compilerSidecarCallBindingRecords(model, checkCancelled, uri, position, context.name);
    if (!result.complete) return [];
    if (result.calls.length !== 1 || result.calls[0].targetSymbols.length !== 1) return [];

    const selectedSymbol = result.calls[0].targetSymbols[0];
    return [...new Map(result.calls[0].declarations.map((declaration) => [
        `${path.resolve(declaration.filePath)}:${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`,
        { ...declaration, symbol: selectedSymbol }
    ])).values()];
}

function compilerSidecarSignatureEntries(model, symbol, uri, document, call, checkCancelled) {
    const sources = compilerSidecarNavigationSources(model);
    const declarationsFor = (candidate, retainNoncallable = false) => {
        const result = compilerSidecarNavigationEntryRecords(model, { symbol: candidate, sources }, checkCancelled);
        const callable = result.complete ? result.entries.filter((entry) =>
            SIGNATURE_CALLABLE_TYPES.has(entry.declaration.type)) : [];
        const prototypes = callable.filter((entry) => entry.declaration.modifiers.includes("DECLARE"));
        if (prototypes.length) return prototypes;
        if (callable.length) return callable;
        return retainNoncallable && result.complete ? result.entries : [];
    };
    /* Parenthesized source bindings also describe array indexing. Preserve
       a selected non-procedure instead of letting presentation replace its
       identity with an unrelated builtin signature of the same spelling. */
    const selected = declarationsFor(symbol, true);
    const kind = model.compilerFactsBySemanticIdentity?.get(symbol)?.procedureKind;
    if (!selected.some((entry) => SIGNATURE_CALLABLE_TYPES.has(entry.declaration.type)) || !kind || !call) return selected;
    /* Schema 27 does not promise chronological B-record ordering. The
       inspected 1.20.5 producer appends them at committed parser events;
       other producers keep their selected signature until audited. */
    if (!/^1\.20\.5(?:$|[-+])/.test(model.compilerSemanticModelCompilerVersion)) return selected;

    let chain = sidecarOverloadChainCaches.get(model);
    if (!chain) {
        chain = { next: new Map(), previous: new Map(), invalid: new Set() };
        for (const relation of model.compilerSemanticRelationships || []) {
            if (relation.kind !== "overload-next" || relation.sourceDomain !== "symbol" ||
                relation.targetDomain !== "symbol") continue;
            checkCancelled();
            const { source, target } = relation;
            if (relation.ordinal !== 0 || chain.next.has(source) && chain.next.get(source) !== target ||
                chain.previous.has(target) && chain.previous.get(target) !== source) {
                chain.invalid.add(source);
                chain.invalid.add(target);
                continue;
            }
            chain.next.set(source, target);
            chain.previous.set(target, source);
        }
        sidecarOverloadChainCaches.set(model, chain);
    }
    if (!chain.next.has(symbol) && !chain.previous.has(symbol)) return selected;
    const visited = new Set();
    let first = symbol;
    while (chain.previous.has(first)) {
        if (visited.has(first) || chain.invalid.has(first) || visited.size >= MAX_SIGNATURE_RECOVERY_CANDIDATES) return selected;
        visited.add(first);
        first = chain.previous.get(first);
    }
    const family = [];
    visited.clear();
    for (let candidate = first; candidate; candidate = chain.next.get(candidate)) {
        if (visited.has(candidate) || chain.invalid.has(candidate) || family.length >= MAX_SIGNATURE_RECOVERY_CANDIDATES) return selected;
        visited.add(candidate);
        family.push(candidate);
    }

    /* B records retain compiler append order across includes and #line.
       An EOF overload chain may include declarations made after this call.
       Compare native binding order, not physical filenames or line numbers. */
    const firstDeclarations = new Map();
    let callOrder = Infinity;
    const sourcePath = compilerSidecarNavigationPathKey(uri.fsPath || uri.path);
    for (let index = 0; index < model.semanticBindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = model.semanticBindings[index];
        if (!binding.physical) continue;
        if (binding.role === "declaration" && !firstDeclarations.has(binding.symbol)) firstDeclarations.set(binding.symbol, index);
        if (binding.role !== "reference" || binding.symbol !== symbol || binding.startLine !== call.line + 1 ||
            compilerSidecarNavigationPathKey(binding.filePath) !== sourcePath) continue;
        const matched = semanticBindingToken(document, binding);
        if (matched?.token.startColumn === call.startColumn) callOrder = Math.min(callOrder, index);
    }
    if (!Number.isFinite(callOrder)) return selected;
    const entries = [];
    for (const candidate of family) {
        if (candidate === symbol) { entries.push(...selected); continue; }
        const facts = model.compilerFactsBySemanticIdentity?.get(candidate);
        /* Public siblings are accessible wherever the selected family is.
           A selected restricted overload remains visible, but does not prove
           caller access to its other private/protected siblings. */
        if (facts?.procedureKind !== kind || facts.compilerVisibility !== "public" ||
            !(firstDeclarations.get(candidate) < callOrder)) continue;
        entries.push(...declarationsFor(candidate));
    }
    return entries.some((entry) => entry.compilerSymbolId === symbol) ? entries : selected;
}

/* I records can cover surrounding syntax as well as the written constructor.
   Require the owner's exact type reference at a direct source call before
   adding an inlay. */
function compilerSidecarExplicitConstructorCallRecords(model, uri, source, checkCancelled) {
    if (model.partial || !Array.isArray(model.semanticImplicitCalls) ||
        !Array.isArray(model.semanticDeclarations)) return [];
    let documentCache = sidecarExplicitConstructorCallCaches.get(model);
    if (!documentCache) {
        documentCache = new Map();
        sidecarExplicitConstructorCallCaches.set(model, documentCache);
    }
    const cacheKey = uri.toString();
    const cached = documentCache.get(cacheKey);
    if (cached) {
        documentCache.delete(cacheKey);
        documentCache.set(cacheKey, cached);
        return cached;
    }
    const cacheRecords = (records) => {
        documentCache.set(cacheKey, records);
        while (documentCache.size > MAX_COMPILER_SIDECAR_CONSTRUCTOR_CALL_CACHE_DOCUMENTS) {
            documentCache.delete(documentCache.keys().next().value);
        }
        return records;
    };
    const filePath = uri.fsPath || uri.path || "";
    if (!filePath || !path.isAbsolute(filePath)) return [];
    const pathKey = (value) => {
        const resolved = path.resolve(value);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const selectedPath = pathKey(filePath);
    const declarationsByProcedure = new Map();
    for (const declaration of model.semanticDeclarations) {
        if (declaration.physical !== true ||
            !["procedure-prototype", "procedure-definition"].includes(declaration.kind) ||
            !Number.isSafeInteger(declaration.symbol) || declaration.symbol < 1 ||
            typeof declaration.filePath !== "string" || !path.isAbsolute(declaration.filePath) ||
            !Number.isSafeInteger(declaration.startLine) || declaration.startLine < 1 ||
            !Number.isSafeInteger(declaration.startColumn) || declaration.startColumn < 0 ||
            !Number.isSafeInteger(declaration.endColumn) || declaration.endColumn <= declaration.startColumn) continue;
        const declarations = declarationsByProcedure.get(declaration.symbol) || [];
        declarations.push({
            filePath: declaration.filePath,
            line: declaration.startLine - 1,
            startColumn: declaration.startColumn,
            endColumn: declaration.endColumn,
            name: declaration.name || "",
            implicitConstructor: true
        });
        declarationsByProcedure.set(declaration.symbol, declarations);
    }

    const typeReferencesByLine = new Map();
    const declarationBindingsBySymbolLine = new Map();
    /* Type aliases use the named class code shared with native inventory records. */
    const typeAliasTargets = new Map();
    for (const symbol of model.semanticSymbolTypes || []) {
        if (symbol.symbolClass !== FBC_SEMANTIC_SYMBOL_CLASS_TYPEDEF ||
            !Number.isSafeInteger(symbol.symbol) || symbol.symbol < 1 ||
            !Number.isSafeInteger(symbol.subtype) || symbol.subtype < 1) continue;
        const previous = typeAliasTargets.get(symbol.symbol);
        if (previous === undefined) typeAliasTargets.set(symbol.symbol, symbol.subtype);
        else if (previous !== symbol.subtype) typeAliasTargets.set(symbol.symbol, null);
    }
    const referencesType = (binding, target) => binding.symbol === target ||
        typeAliasTargets.get(binding.symbol) === target;
    const qualifiedConstructorCallee = (reference, call, lineTokens, precedingKeyword) => {
        const last = lineTokens.find((token) => token.startColumn === reference.startColumn &&
            token.endColumn === reference.endColumn && token.kind === "identifier");
        if (!last || source.tokens[last.index + 1]?.name !== "(") return null;
        let first = last;
        while (true) {
            const dot = lineTokens.find((token) => token.index === first.index - 1);
            const qualifier = lineTokens.find((token) => token.index === first.index - 2);
            if (dot?.name !== "." || qualifier?.kind !== "identifier") break;
            first = qualifier;
        }
        if (first.startColumn !== call.startColumn || call.endColumn > last.endColumn ||
            normalizeIdentifier(source.tokens[first.index - 1]?.name) !== precedingKeyword) return null;
        const lineStart = source.lineOffsets[call.startLine - 1];
        const name = source.text.slice(lineStart + first.startColumn, lineStart + last.endColumn);
        if (!/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\.[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*$/.test(name)) return null;
        return { startColumn: first.startColumn, endColumn: last.endColumn };
    };
    for (const binding of model.semanticBindings || []) {
        if (binding.physical !== true || !Number.isSafeInteger(binding.symbol) || binding.symbol < 1 ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath) ||
            pathKey(binding.filePath) !== selectedPath ||
            !Number.isSafeInteger(binding.startLine) || binding.startLine < 1 ||
            binding.endLine !== binding.startLine || !Number.isSafeInteger(binding.startColumn) ||
            binding.startColumn < 0 || !Number.isSafeInteger(binding.endColumn) ||
            binding.endColumn <= binding.startColumn) continue;
        if (binding.role === "declaration") {
            const declarationKey = `${binding.symbol}:${binding.startLine}`;
            const declarations = declarationBindingsBySymbolLine.get(declarationKey) || [];
            declarations.push(binding);
            declarationBindingsBySymbolLine.set(declarationKey, declarations);
            continue;
        }
        if (binding.role !== "reference") continue;
        const references = typeReferencesByLine.get(binding.startLine) || [];
        references.push(binding);
        typeReferencesByLine.set(binding.startLine, references);
    }

    const calls = [];
    const constructorCallKinds = new Set([
        "initializer-constructor", "new-constructor", "return-constructor", "argument-constructor"
    ]);
    const directArgumentConstructorCallee = (reference, call, lineTokens) => {
        if (!Number.isSafeInteger(call.type) || call.type < 1 ||
            reference.startColumn < call.startColumn || reference.endColumn > call.endColumn) return false;
        const callee = lineTokens.find((token) => token.startColumn === reference.startColumn &&
            token.endColumn === reference.endColumn && token.kind === "identifier");
        const lastCalleeToken = lineTokens.find((token) => token.endColumn === reference.endColumn);
        if (!callee || !lastCalleeToken || source.tokens[lastCalleeToken.index + 1]?.name !== "(") return false;
        let depth = 0;
        let closing = null;
        for (let tokenIndex = lastCalleeToken.index + 1; tokenIndex <= lineTokens.at(-1)?.index; tokenIndex++) {
            const name = source.tokens[tokenIndex]?.name;
            if (name === "(") depth++;
            else if (name === ")") {
                depth--;
                if (depth === 0) {
                    closing = lineTokens.find((token) => token.index === tokenIndex);
                    break;
                }
                if (depth < 0) return false;
            }
        }
        if (!closing || closing.endColumn > call.endColumn) return false;
        const lineStart = source.lineOffsets[call.startLine - 1];
        const before = source.masked.slice(lineStart + call.startColumn,
            lineStart + reference.startColumn).trim();
        const after = source.masked.slice(lineStart + closing.endColumn,
            lineStart + call.endColumn).trim();
        const nextToken = source.tokens[closing.index + 1];
        const followsArgument = [",", ")"].includes(nextToken?.name) || closing.index === lineTokens.at(-1)?.index;
        if (!before && !after) return followsArgument;
        /* For the first actual argument FBC may include its enclosing call
           parentheses; accept only that single, direct wrapper. */
        if (before !== "(" || (after && after !== ")")) return false;
        const callOpening = lineTokens.find((token) => token.startColumn === call.startColumn && token.name === "(");
        const callName = callOpening && source.tokens[callOpening.index - 1]?.name;
        if (!callOpening || !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(callName || "")) return false;
        return followsArgument;
    };
    let sourceDeclarations = null;
    let attemptedSourceParse = false;
    for (let index = 0; index < model.semanticImplicitCalls.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const call = model.semanticImplicitCalls[index];
        if (!constructorCallKinds.has(call.kind) || call.physical !== true ||
            typeof call.filePath !== "string" || pathKey(call.filePath) !== selectedPath ||
            !Number.isSafeInteger(call.owner) || call.owner < 1 ||
            !Number.isSafeInteger(call.target) || call.target < 1 ||
            !Number.isSafeInteger(call.startLine) || call.startLine < 1 ||
            call.endLine !== call.startLine || !Number.isSafeInteger(call.startColumn) || call.startColumn < 0 ||
            !Number.isSafeInteger(call.endColumn) || call.endColumn <= call.startColumn) continue;
        const declarationSites = declarationsByProcedure.get(call.target);
        const line = call.startLine - 1;
        const lineTokens = source.byLine.get(line) || [];
        if (call.kind === "initializer-constructor") {
            const destinationBindings = declarationBindingsBySymbolLine.get(`${call.owner}:${call.startLine}`) || [];
            if (destinationBindings.filter((binding) =>
                binding.startColumn === call.startColumn && binding.endColumn === call.endColumn
            ).length !== 1 || !Number.isSafeInteger(call.type) || call.type < 1 || !declarationSites?.length) continue;
            if (!attemptedSourceParse) {
                attemptedSourceParse = true;
                if (Buffer.byteLength(source.text, "utf8") <= MAX_COMPILER_SIDECAR_PARAMETER_SOURCE_BYTES) {
                    sourceDeclarations = parseFreeBasicText(source.text).declarations || [];
                }
            }
            if (!sourceDeclarations) continue;
            const declaration = sourceDeclarations.filter((candidate) =>
                candidate.type === "variable" && candidate.line === line &&
                candidate.startColumn === call.startColumn && candidate.endColumn === call.endColumn &&
                typeof candidate.initializer === "string" && candidate.initializer.trim()
            );
            if (declaration.length !== 1) continue;
            const sourceDeclaration = declaration[0];
            const lineStart = source.lineOffsets[line];
            const lineEnd = source.lineOffsets[line + 1] ?? source.text.length;
            const maskedInitializer = maskFreeBasicText(sourceDeclaration.initializer).trim();
            const initializerReferences = (typeReferencesByLine.get(call.startLine) || []).flatMap((reference) => {
                if (!referencesType(reference, call.type) || reference.startColumn <= call.endColumn) return [];
                const callee = lineTokens.find((candidate) => candidate.startColumn === reference.startColumn &&
                    candidate.endColumn === reference.endColumn && candidate.kind === "identifier");
                if (!callee || source.tokens[callee.index + 1]?.name !== "(") return [];
                let first = callee;
                while (source.tokens[first.index - 1]?.name === "." &&
                    source.tokens[first.index - 2]?.kind === "identifier" &&
                    source.tokens[first.index - 2].line === line) first = source.tokens[first.index - 2];
                const sourceInitializer = source.masked.slice(lineStart + first.startColumn, lineEnd).trim();
                return sourceInitializer === maskedInitializer ? [{ ...reference, startColumn: first.startColumn }] : [];
            });
            if (initializerReferences.length !== 1) continue;
            calls.push({
                filePath: call.filePath,
                line,
                startColumn: initializerReferences[0].startColumn,
                endColumn: initializerReferences[0].endColumn,
                targetSignature: call.targetSignature,
                targetSymbols: [call.target],
                declarations: declarationSites
            });
            if (calls.length > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return cacheRecords([]);
            continue;
        }
        if (call.kind === "argument-constructor") {
            if (!declarationSites?.length || !Number.isSafeInteger(call.type) || call.type < 1) continue;
            const explicitReferences = (typeReferencesByLine.get(call.startLine) || []).filter((reference) =>
                referencesType(reference, call.type) && directArgumentConstructorCallee(reference, call, lineTokens)
            );
            if (explicitReferences.length !== 1) continue;
            calls.push({
                filePath: call.filePath,
                line,
                startColumn: explicitReferences[0].startColumn,
                endColumn: explicitReferences[0].endColumn,
                targetSignature: call.targetSignature,
                targetSymbols: [call.target],
                declarations: declarationSites
            });
            if (calls.length > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return cacheRecords([]);
            continue;
        }
        const matchingReferences = (typeReferencesByLine.get(call.startLine) || [])
            .filter((reference) => referencesType(reference, call.owner) &&
                reference.startColumn === call.startColumn && reference.endColumn <= call.endColumn);
        if (!declarationSites?.length) continue;
        const calleeRanges = [];
        for (const reference of matchingReferences) {
            const calleeName = source.text.slice(
                source.lineOffsets[line] + reference.startColumn,
                source.lineOffsets[line] + reference.endColumn
            );
            if (!/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\.[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*$/.test(calleeName)) continue;
            const firstToken = lineTokens.find((candidate) => candidate.startColumn === reference.startColumn);
            const lastToken = lineTokens.find((candidate) => candidate.endColumn === reference.endColumn);
            if (!firstToken || !lastToken || source.tokens[lastToken.index + 1]?.name !== "(") continue;
            if (call.kind === "new-constructor" &&
                (reference.endColumn !== call.endColumn || normalizeIdentifier(source.tokens[firstToken.index - 1]?.name) !== "new")) continue;
            calleeRanges.push({ startColumn: reference.startColumn, endColumn: reference.endColumn });
        }
        if (!calleeRanges.length && ["new-constructor", "return-constructor"].includes(call.kind)) {
            const precedingKeyword = call.kind === "new-constructor" ? "new" : "return";
            for (const reference of typeReferencesByLine.get(call.startLine) || []) {
                if (!referencesType(reference, call.owner)) continue;
                const range = qualifiedConstructorCallee(reference, call, lineTokens, precedingKeyword);
                if (range) calleeRanges.push(range);
            }
        }
        if (calleeRanges.length !== 1) continue;
        const calleeRange = calleeRanges[0];
        calls.push({
            filePath: call.filePath,
            line,
            startColumn: calleeRange.startColumn,
            endColumn: calleeRange.endColumn,
            targetSignature: call.targetSignature,
            targetSymbols: [call.target],
            declarations: declarationSites
        });
        if (calls.length > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return cacheRecords([]);
    }
    if (model.semanticSidecarOnly) for (const selection of model.semanticTemporaryConstructions || []) {
        checkCancelled();
        if (pathKey(selection.filePath) !== selectedPath || selection.endLine !== selection.startLine) continue;
        const declarations = declarationsByProcedure.get(selection.target);
        if (!declarations?.length) continue;
        const line = selection.startLine - 1;
        // The LOC identifies a construction context, not an editable type name.
        // Keep it as an operation site, like DELETE, and never as a rename edit.
        if (calls.some((call) => call.line === line && call.targetSymbols.length === 1 &&
            call.targetSymbols[0] === selection.target && call.startColumn <= selection.startColumn &&
            call.endColumn >= selection.endColumn)) continue;
        calls.push({ filePath: selection.filePath, line, startColumn: selection.startColumn,
            endColumn: selection.endColumn, targetSymbols: [selection.target], declarations,
            kind: "explicit-constructor", temporarySelection: selection });
        if (calls.length > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return cacheRecords([]);
    }
    return cacheRecords(calls);
}

function compilerLifetimeCalls(model, checkCancelled) {
    if (!model.semanticSidecarOnly || !model.semanticTemporaryConstructions?.length) return model.semanticImplicitCalls || [];
    if (sidecarLifetimeCallCaches.has(model)) return sidecarLifetimeCallCaches.get(model);
    if (model.semanticTemporaryConstructions.length > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return null;
    const calls = [...(model.semanticImplicitCalls || [])];
    const files = new Set(model.semanticTemporaryConstructions.map((selection) => selection.filePath));
    for (const file of files) {
        checkCancelled();
        const uri = CompilerUri.file(file), source = model.getDocument(uri);
        if (!source) continue;
        for (const call of compilerSidecarExplicitConstructorCallRecords(model, uri, source, checkCancelled)) {
            if (call.temporarySelection) calls.push(call.temporarySelection);
        }
    }
    sidecarLifetimeCallCaches.set(model, calls);
    return calls;
}

function compilerTypedConstructorHintCalls(model, uri, source, checkCancelled) {
    const selections = model.semanticTemporaryConstructions || [];
    if (!uri.fsPath || selections.length > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return [];
    const sourceKey = compilerSidecarNavigationPathKey(uri.fsPath), calls = [];
    for (const selection of selections) {
        checkCancelled();
        if (selection.physical !== true || !selection.filePath ||
            compilerSidecarNavigationPathKey(selection.filePath) !== sourceKey || selection.startLine !== selection.endLine) continue;
        const line = selection.startLine - 1;
        const callee = (source.byLine.get(line) || []).find((token) => token.startColumn === selection.startColumn);
        if (callee?.key !== "type" || source.tokens[callee.index + 1]?.name !== "<") continue;
        const declarations = compilerConstructorDeclarationEntries(model, selection.target, checkCancelled);
        if (!declarations?.length) continue;
        calls.push({ filePath: selection.filePath, line, startColumn: selection.startColumn, endColumn: selection.endColumn,
            kind: "explicit-constructor", targetSymbols: [selection.target], declarations: declarations.map((entry) => ({
                filePath: entry.uri.fsPath, line: entry.declaration.line,
                startColumn: entry.declaration.startColumn, endColumn: entry.declaration.endColumn,
                name: entry.declaration.name, implicitConstructor: true
            })) });
    }
    return calls;
}

function compilerParameterInlayHintRecords(model, uri, start, end, checkCancelled) {
    const semantic = compilerSidecarParameterInlayHints(model, uri, start, end, checkCancelled);
    if (model.semanticSidecarOnly) return semantic;
    const native = model.compilerParameterInlayHints(uri, start, end, checkCancelled);
    if (!semantic.length) return native;
    const hints = new Map();
    for (const hint of [...native, ...semantic]) {
        const key = `${hint.position.line}:${hint.position.character}`;
        const previous = hints.get(key);
        if (previous === null) continue;
        if (previous && (previous.label !== hint.label || previous.passingMode !== hint.passingMode)) hints.set(key, null);
        else if (previous && JSON.stringify(previous.declarationLocation) !== JSON.stringify(hint.declarationLocation)) delete previous.declarationLocation;
        else if (!previous) hints.set(key, { ...hint });
        if (hints.size > MAX_COMPILER_PARAMETER_INLAY_HINTS) return [];
    }
    return [...hints.values()].filter(Boolean).sort((left, right) =>
        left.position.line - right.position.line || left.position.character - right.position.character);
}

function compilerSidecarParameterInlayHints(model, uri, start, end, checkCancelled) {
    if (model.partial || !model.semanticSidecarOnly && !model.semanticTemporaryConstructions?.length) return [];
    const source = model.getDocument(uri);
    if (!source) return [];

    let documentCache = sidecarParameterHintCaches.get(model);
    if (!documentCache) {
        documentCache = new Map();
        sidecarParameterHintCaches.set(model, documentCache);
    }
    const cacheKey = uri.toString();
    let records = documentCache.get(cacheKey);
    if (records === undefined) {
        const bindings = compilerSidecarCallBindingRecords(model, checkCancelled, uri);
        // The bridge keeps its ordinary trace-owned hints. Only typed
        // temporaries supplement that route with independent semantic IDs.
        const constructorCalls = model.semanticSidecarOnly
            ? compilerSidecarExplicitConstructorCallRecords(model, uri, source, checkCancelled)
            : compilerTypedConstructorHintCalls(model, uri, source, checkCancelled);
        const sourcePath = source.uri.fsPath || source.uri.path || "";
        const sourcePathKey = sourcePath
            ? (process.platform === "win32" ? path.resolve(sourcePath).toLowerCase() : path.resolve(sourcePath))
            : "";
        const macroInvocationsByLine = model.semanticSidecarOnly
            ? model.compilerMacroInvocationsBySourceLine?.get(sourcePathKey) : null;
        const hasMacroInvocations = [...(macroInvocationsByLine?.values?.() || [])]
            .some((invocations) => Array.isArray(invocations) && invocations.length > 0);
        if (!bindings.complete && !constructorCalls.length && !hasMacroInvocations) return [];
        const calls = [...(bindings.complete ? bindings.calls : []), ...constructorCalls];
        const parsedByFile = new Map();
        const parameterNamesByCall = new Map();
        const parameterModesByProcedureOrdinal = new Map();
        const selectedInputsByProcedureOrdinal = new Map();
        const selectedArgumentInputs = model.semanticCallArgumentInputs || [];
        if (selectedArgumentInputs.length > MAX_COMPILER_SIDECAR_SELECTED_ARGUMENT_INPUTS) return [];
        for (let index = 0; index < selectedArgumentInputs.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const input = selectedArgumentInputs[index];
            if (!input || typeof input.filePath !== "string" ||
                (process.platform === "win32" ? path.resolve(input.filePath).toLowerCase() : path.resolve(input.filePath)) !== sourcePathKey ||
                !Number.isSafeInteger(input.procedureSymbol) || input.procedureSymbol < 1 ||
                !Number.isSafeInteger(input.parameterOrdinal) || input.parameterOrdinal < 0 ||
                !Number.isSafeInteger(input.startOffset) || !Number.isSafeInteger(input.endOffset) ||
                input.startOffset < 0 || input.endOffset <= input.startOffset ||
                typeof input.parameterName !== "string" ||
                !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(input.parameterName) ||
                !["byval", "byref", "bydesc"].includes(input.passingMode)) continue;
            const key = `${input.procedureSymbol}:${input.parameterOrdinal}`;
            const inputs = selectedInputsByProcedureOrdinal.get(key) || [];
            inputs.push(input);
            selectedInputsByProcedureOrdinal.set(key, inputs);
        }
        const supportedParameterModes = new Set(["byval", "byref", "bydesc", "vararg"]);
        for (const parameter of model.semanticProcedureParameterModes || []) {
            if (!Number.isSafeInteger(parameter.procedure) || parameter.procedure < 1 ||
                !Number.isSafeInteger(parameter.ordinal) || parameter.ordinal < 0 ||
                !supportedParameterModes.has(parameter.mode) || parameter.receiver === true) continue;
            const key = `${parameter.procedure}:${parameter.ordinal}`;
            if (!parameterModesByProcedureOrdinal.has(key)) {
                parameterModesByProcedureOrdinal.set(key, parameter.mode);
            } else if (parameterModesByProcedureOrdinal.get(key) !== parameter.mode) {
                parameterModesByProcedureOrdinal.set(key, null);
            }
        }
        let parsedSourceBytes = 0;
        let sourceLimitReached = false;
        const declarationParameterNames = (call) => {
            if (parameterNamesByCall.has(call)) return parameterNamesByCall.get(call);
            if (call.targetSymbols.length !== 1) {
                parameterNamesByCall.set(call, null);
                return null;
            }

            const signatures = new Map();
            for (const declarationSite of call.declarations) {
                checkCancelled();
                const declarationUri = CompilerUri.file(declarationSite.filePath);
                const declarationSource = model.getDocument(declarationUri);
                if (!declarationSource) continue;
                const declarationKey = declarationUri.toString();
                let parsed = parsedByFile.get(declarationKey);
                if (!parsed) {
                    const sourceBytes = Buffer.byteLength(declarationSource.text, "utf8");
                    if (sourceBytes > MAX_COMPILER_SIDECAR_PARAMETER_SOURCE_BYTES) continue;
                    if (parsedSourceBytes + sourceBytes > MAX_COMPILER_SIDECAR_PARAMETER_TOTAL_SOURCE_BYTES) {
                        sourceLimitReached = true;
                        return null;
                    }
                    parsedSourceBytes += sourceBytes;
                    parsed = parseFreeBasicText(declarationSource.text);
                    parsedByFile.set(declarationKey, parsed);
                }
                const candidates = parsed.declarations.filter((candidate) =>
                    candidate.line === declarationSite.line &&
                    ["function", "sub", "property", "constructor"].includes(candidate.type)
                );
                const declaration = declarationSite.implicitConstructor
                    ? candidates.length === 1 && candidates[0].type === "constructor" ? candidates[0] : null
                    : candidates.find((candidate) => candidate.startColumn === declarationSite.startColumn &&
                        candidate.endColumn === declarationSite.endColumn &&
                        normalizeIdentifier(candidate.name) === normalizeIdentifier(declarationSite.name));
                if (!declaration || !Array.isArray(declaration.parameters) || !declaration.parameters.length) continue;
                const parameterEntries = parsed.declarations.filter((candidate) =>
                    candidate.type === "parameter" && candidate.parentDeclaration === declaration
                ).map((candidate) => ({ uri: declarationUri, declaration: candidate }));
                const parameters = declaration.parameters.map((parameter, ordinal) => {
                    const declarationLocation = compilerParameterDeclarationLocation(model, parameterEntries, parameter.name);
                    return {
                        name: parameter.name || "",
                        variadic: parameter.variadic === true,
                        passingMode: parameterModesByProcedureOrdinal.get(`${call.targetSymbols[0]}:${ordinal}`) || "",
                        ...(declarationLocation ? { declarationLocation } : {})
                    };
                });
                if (parameters.some((parameter) => !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(parameter.name))) continue;
                const signature = JSON.stringify(parameters.map((parameter) => [
                    normalizeIdentifier(parameter.name), parameter.variadic, parameter.passingMode
                ]));
                const prototype = declaration.modifiers.includes("DECLARE");
                const previous = signatures.get(signature);
                // Prefer the public prototype over its implementation. Two
                // distinct preferred sites keep the hint but not an arbitrary link.
                if (!previous || prototype && !previous.prototype) signatures.set(signature, { parameters, prototype });
                else if (prototype === previous.prototype) {
                    for (let ordinal = 0; ordinal < parameters.length; ordinal++) {
                        if (JSON.stringify(previous.parameters[ordinal].declarationLocation) !==
                            JSON.stringify(parameters[ordinal].declarationLocation)) delete previous.parameters[ordinal].declarationLocation;
                    }
                }
            }
            const parameters = signatures.size === 1 ? signatures.values().next().value.parameters : null;
            parameterNamesByCall.set(call, parameters || null);
            return parameters || null;
        };

        const hintsBySite = new Map();
        let scannedArgumentCharacters = 0;
        for (const call of calls) {
            checkCancelled();
            if (call.targetSymbols.length !== 1) continue;
            const lineTokens = source.byLine.get(call.line) || [];
            const calleeStartIndex = lineTokens.findIndex((candidate) => candidate.startColumn === call.startColumn);
            const calleeEndIndex = lineTokens.findIndex((candidate) => candidate.endColumn === call.endColumn);
            if (calleeStartIndex < 0 || calleeEndIndex < calleeStartIndex) continue;
            const calleeTokens = lineTokens.slice(calleeStartIndex, calleeEndIndex + 1);
            if (!calleeTokens.length || calleeTokens.some((candidate, index) =>
                index % 2 === 0 ? candidate.kind !== "identifier" : ![".", "->"].includes(candidate.name)
            )) continue;
            const lineStart = source.lineOffsets[call.line];
            const calleeName = source.text.slice(lineStart + call.startColumn, lineStart + call.endColumn);
            if (!/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:[ \t]*(?:\.|->)[ \t]*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*$/.test(calleeName)) continue;
            const terminalToken = calleeTokens.at(-1);
            const nextToken = source.tokens[terminalToken.index + 1];
            const typedOpening = call.kind === "explicit-constructor"
                ? typedConstructorOpeningToken(source, terminalToken, checkCancelled) : null;
            const openingToken = typedOpening || (nextToken?.name === "(" ? nextToken
                : /[ \t]/.test(source.text[terminalToken.end] || "") ? { ...terminalToken, bare: true } : null);
            if (!openingToken) continue;
            const parameters = declarationParameterNames(call);
            if (sourceLimitReached) return [];

            const parsedArguments = freeBasicCallArgumentRanges(source, openingToken, checkCancelled,
                MAX_COMPILER_PARAMETER_INLAY_SCAN_CHARACTERS - scannedArgumentCharacters);
            scannedArgumentCharacters += parsedArguments.scanned;
            if (parsedArguments.exceeded) return [];
            if (!parsedArguments.arguments || parsedArguments.arguments.some((argument) => argument?.named)) continue;

            for (let ordinal = 0; ordinal < parsedArguments.arguments.length; ordinal++) {
                const argument = parsedArguments.arguments[ordinal];
                if (!argument) continue;
                const formalInputs = selectedInputsByProcedureOrdinal.get(`${call.targetSymbols[0]}:${ordinal}`) || [];
                let selectedInput = null;
                let selectedOverlap = 0;
                let selectedSignature = "";
                let inputConflict = false;
                for (const input of formalInputs) {
                    const overlap = Math.min(input.endOffset, argument.end) - Math.max(input.startOffset, argument.start);
                    if (overlap <= 0) continue;
                    const signature = JSON.stringify([input.parameterName.toLowerCase(), input.passingMode]);
                    if (overlap > selectedOverlap) {
                        selectedInput = input;
                        selectedOverlap = overlap;
                        selectedSignature = signature;
                        inputConflict = false;
                    } else if (overlap === selectedOverlap && signature !== selectedSignature) {
                        inputConflict = true;
                    }
                }
                if (inputConflict) selectedInput = null;
                const sourceParameter = parameters?.[ordinal];
                if (selectedInput && sourceParameter &&
                    normalizeIdentifier(sourceParameter.name) !== normalizeIdentifier(selectedInput.parameterName)) continue;
                const parameterName = selectedInput?.parameterName || sourceParameter?.name || "";
                const passingMode = selectedInput?.passingMode || sourceParameter?.passingMode || "";
                if (!parameterName || sourceParameter?.variadic) continue;
                if (normalizeIdentifier(source.text.slice(argument.start, argument.end).trim()) === normalizeIdentifier(parameterName)) continue;
                const position = positionAtOffset(source, argument.start);
                const key = `${position.line}:${position.character}`;
                const hint = {
                    position,
                    label: `${parameterName}:`,
                    parameterName,
                    passingMode,
                    ...(sourceParameter?.declarationLocation ? { declarationLocation: sourceParameter.declarationLocation } : {})
                };
                const previous = hintsBySite.get(key);
                if (previous && (previous.label !== hint.label || previous.passingMode !== hint.passingMode)) {
                    hintsBySite.set(key, null);
                }
                else if (previous && JSON.stringify(previous.declarationLocation) !== JSON.stringify(hint.declarationLocation)) {
                    delete previous.declarationLocation;
                }
                else if (previous === undefined) hintsBySite.set(key, hint);
                if (hintsBySite.size > MAX_COMPILER_PARAMETER_INLAY_HINTS) return [];
            }
        }

        for (const [line, invocations] of macroInvocationsByLine || []) {
            if (!Array.isArray(invocations)) continue;
            const lineTokens = source.byLine.get(line) || [];
            for (let invocationIndex = 0; invocationIndex < invocations.length; invocationIndex++) {
                if ((invocationIndex & 255) === 0) checkCancelled();
                const invocation = invocations[invocationIndex];
                /* Nested calls can still have exact physical callee and argument ranges. */
                if (!["normal", "evaluation"].includes(invocation.phase) || invocation.physical !== true ||
                    invocation.endLine !== invocation.startLine) continue;
                const callee = lineTokens.find((candidate) => candidate.kind === "identifier" &&
                    candidate.startColumn === invocation.startColumn && candidate.endColumn === invocation.endColumn);
                const openingToken = callee && source.tokens[callee.index + 1];
                if (!callee || openingToken?.name !== "(") continue;
                const signature = model.compilerMacroSignatureAt?.(
                    uri, callee.name, invocation.startLine, invocation.startColumn, invocation.endColumn
                );
                if (!Array.isArray(signature?.parameters) || !signature.parameters.length) continue;
                const parsedArguments = freeBasicCallArgumentRanges(source, openingToken, checkCancelled,
                    MAX_COMPILER_PARAMETER_INLAY_SCAN_CHARACTERS - scannedArgumentCharacters);
                scannedArgumentCharacters += parsedArguments.scanned;
                if (parsedArguments.exceeded) return [];
                if (!parsedArguments.arguments || parsedArguments.arguments.some((argument) => argument?.named)) continue;

                for (let ordinal = 0; ordinal < parsedArguments.arguments.length; ordinal++) {
                    const argument = parsedArguments.arguments[ordinal];
                    const parameter = signature.parameters[ordinal];
                    if (!argument || !parameter || parameter.variadic !== false ||
                        typeof parameter.name !== "string" ||
                        !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(parameter.name) ||
                        normalizeIdentifier(source.text.slice(argument.start, argument.end).trim()) ===
                            normalizeIdentifier(parameter.name)) continue;
                    const position = positionAtOffset(source, argument.start);
                    const key = `${position.line}:${position.character}`;
                    const hint = {
                        position,
                        label: `${parameter.name}:`,
                        parameterName: parameter.name,
                        passingMode: ""
                    };
                    const previous = hintsBySite.get(key);
                    if (previous && (previous.label !== hint.label || previous.passingMode !== hint.passingMode)) {
                        hintsBySite.set(key, null);
                    } else if (previous) {
                        delete previous.declarationLocation;
                    } else if (previous === undefined) {
                        hintsBySite.set(key, hint);
                    }
                    if (hintsBySite.size > MAX_COMPILER_PARAMETER_INLAY_HINTS) return [];
                }
            }
        }

        records = [...hintsBySite.values()].filter(Boolean);
        documentCache.set(cacheKey, records);
        while (documentCache.size > 8) documentCache.delete(documentCache.keys().next().value);
    }

    return records.filter((record) => record.position.line >= start.line && record.position.line <= end.line &&
        (record.position.line !== start.line || record.position.character >= start.character) &&
        (record.position.line !== end.line || record.position.character <= end.character));
}

function compilerSidecarConstantValuesBySymbol(model, checkCancelled) {
    const valuesBySymbol = new Map();
    const invalidSymbols = new Set();
    for (let index = 0; index < model.semanticConstants.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const constant = model.semanticConstants[index];
        if (constant.domain !== "symbol" || !Number.isSafeInteger(constant.identity) || constant.identity < 1) continue;
        if (!isCompilerConstantValue(constant)) {
            invalidSymbols.add(constant.identity);
            continue;
        }
        const values = valuesBySymbol.get(constant.identity) || new Map();
        values.set(`${constant.kind}:${constant.value}`, { kind: constant.kind, value: constant.value });
        valuesBySymbol.set(constant.identity, values);
    }
    return new Map([...valuesBySymbol].flatMap(([symbol, values]) =>
        !invalidSymbols.has(symbol) && values.size === 1
            ? [[symbol, values.values().next().value]] : []
    ));
}

function compilerSidecarConstantsAtSites(model, sites, checkCancelled) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(model.semanticBindings) ||
        !Array.isArray(model.semanticConstants) || !Array.isArray(sites) ||
        sites.length > MAX_COMPILER_SIDECAR_CONSTANT_SITES) return [];
    const pathKey = (candidate) => {
        const resolved = path.resolve(candidate);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const requestedSites = new Map();
    const sourceLines = new Map();
    for (let index = 0; index < sites.length; index++) {
        const site = sites[index];
        if (!site || typeof site.filePath !== "string" || !site.filePath ||
            !Number.isSafeInteger(site.line) || site.line < 0 ||
            !Number.isSafeInteger(site.startColumn) || site.startColumn < 0 ||
            !Number.isSafeInteger(site.endColumn) || site.endColumn <= site.startColumn) continue;
        const file = pathKey(site.filePath);
        const key = `${file}:${site.line}:${site.startColumn}:${site.endColumn}`;
        const indexes = requestedSites.get(key) || [];
        indexes.push(index);
        requestedSites.set(key, indexes);
        const lines = sourceLines.get(file) || new Set();
        lines.add(site.line);
        sourceLines.set(file, lines);
    }
    if (!requestedSites.size) return [];

    const valuesBySymbol = compilerSidecarConstantValuesBySymbol(model, checkCancelled);
    if (!valuesBySymbol.size) return [];
    const documents = new Map();
    const symbolsBySite = new Map();
    for (let index = 0; index < model.semanticBindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = model.semanticBindings[index];
        if (binding.role !== "declaration" || !binding.physical || !binding.filePath ||
            !valuesBySymbol.has(binding.symbol) || !Number.isSafeInteger(binding.startLine) || binding.startLine < 1) continue;
        const file = pathKey(binding.filePath);
        const line = binding.startLine - 1;
        if (!sourceLines.get(file)?.has(line)) continue;
        let document = documents.get(file);
        if (!document) {
            document = model.getDocument(CompilerUri.file(binding.filePath));
            if (!document) continue;
            documents.set(file, document);
        }
        const range = semanticBindingToken(document, binding);
        if (!range) continue;
        const key = `${file}:${range.token.line}:${range.token.startColumn}:${range.token.endColumn}`;
        for (const siteIndex of requestedSites.get(key) || []) {
            const symbols = symbolsBySite.get(siteIndex) || new Set();
            symbols.add(binding.symbol);
            symbolsBySite.set(siteIndex, symbols);
        }
    }

    const values = [];
    for (let index = 0; index < sites.length; index++) {
        checkCancelled();
        const symbols = symbolsBySite.get(index);
        if (symbols?.size !== 1) continue;
        const value = valuesBySymbol.get(symbols.values().next().value);
        if (value) values.push({ index, ...value });
    }
    return values;
}

function compilerSidecarEnumMembersAtSites(model, sites, checkCancelled) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(model.semanticBindings) ||
        model.semanticBindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS ||
        !Array.isArray(sites) || sites.length > MAX_COMPILER_SIDECAR_CONSTANT_SITES) return [];
    const requestedSites = new Map();
    const sourceLines = new Map();
    for (let index = 0; index < sites.length; index++) {
        const site = sites[index];
        if (!site || typeof site.filePath !== "string" || !path.isAbsolute(site.filePath) ||
            !Number.isSafeInteger(site.line) || site.line < 0 ||
            !Number.isSafeInteger(site.startColumn) || site.startColumn < 0 ||
            !Number.isSafeInteger(site.endColumn) || site.endColumn <= site.startColumn) continue;
        const file = compilerSidecarNavigationPathKey(site.filePath);
        const key = `${file}:${site.line}:${site.startColumn}:${site.endColumn}`;
        const indexes = requestedSites.get(key) || [];
        indexes.push(index);
        requestedSites.set(key, indexes);
        const lines = sourceLines.get(file) || new Set();
        lines.add(site.line);
        sourceLines.set(file, lines);
    }
    if (!requestedSites.size) return [];

    const documents = new Map();
    const symbolsBySite = new Map();
    for (let index = 0; index < model.semanticBindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = model.semanticBindings[index];
        if (binding.role !== "reference" || binding.physical !== true ||
            !Number.isSafeInteger(binding.symbol) || binding.symbol < 1 ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath) ||
            !Number.isSafeInteger(binding.startLine) || binding.startLine < 1 ||
            binding.endLine !== binding.startLine) continue;
        const file = compilerSidecarNavigationPathKey(binding.filePath);
        const line = binding.startLine - 1;
        if (!sourceLines.get(file)?.has(line)) continue;
        let document = documents.get(file);
        if (!document) {
            document = model.getDocument(CompilerUri.file(binding.filePath));
            if (!document) continue;
            documents.set(file, document);
        }
        const range = semanticBindingToken(document, binding);
        if (!range) continue;
        const key = `${file}:${range.token.line}:${range.token.startColumn}:${range.token.endColumn}`;
        for (const siteIndex of requestedSites.get(key) || []) {
            const symbols = symbolsBySite.get(siteIndex) || new Set();
            symbols.add(binding.symbol);
            symbolsBySite.set(siteIndex, symbols);
        }
    }

    const owners = [];
    for (let index = 0; index < sites.length; index++) {
        checkCancelled();
        const symbols = symbolsBySite.get(index);
        if (symbols?.size !== 1) continue;
        const facts = model.compilerFactsBySemanticIdentity?.get(symbols.values().next().value);
        const inputs = facts?.enumElementInputs;
        if (!Array.isArray(inputs) || !inputs.length) continue;
        let owner = null;
        let valid = true;
        for (const input of inputs) {
            if (input.provisional !== false || input.physical !== true ||
                !Number.isSafeInteger(input.owner) || input.owner < 1 ||
                owner !== null && owner !== input.owner) {
                valid = false;
                break;
            }
            owner = input.owner;
        }
        if (valid && owner !== null) owners.push({ index, owner });
    }
    return owners;
}

function compilerSidecarConstantAt(model, uri, position, checkCancelled) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(model.semanticBindings) ||
        !Array.isArray(model.semanticConstants)) return null;
    const document = model.getDocument(uri);
    const filePath = uri.fsPath || uri.path;
    if (!document || !filePath) return null;
    const pathKey = (candidate) => {
        const resolved = path.resolve(candidate);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const selectedPath = pathKey(filePath);
    const selectedSymbols = new Set();
    for (let index = 0; index < model.semanticBindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = model.semanticBindings[index];
        if (!binding.physical || !binding.filePath ||
            !["declaration", "reference"].includes(binding.role) ||
            pathKey(binding.filePath) !== selectedPath || binding.startLine !== position.line + 1) continue;
        const range = semanticBindingToken(document, binding);
        if (!range || position.character < range.token.startColumn || position.character > range.token.endColumn) continue;
        selectedSymbols.add(binding.symbol);
        if (selectedSymbols.size > 1) return null;
    }
    if (selectedSymbols.size !== 1) return null;

    const selectedSymbol = selectedSymbols.values().next().value;
    return compilerSidecarConstantValuesBySymbol(model, checkCancelled).get(selectedSymbol) || null;
}

function compilerSidecarExpressionConstantValuesAt(model, uri, position, end = position) {
    const fact = model.compilerSidecarFactAt?.(uri, position, end);
    if (!fact || fact.provisional || !Array.isArray(fact.compilerConstantValues)) return [];
    return fact.compilerConstantValues;
}

function compilerForEntryResultAt(model, uri, document, position, checkCancelled) {
    if (model.partial || !Array.isArray(model.semanticForEntryResults) || !model.semanticForEntryResults.length) return null;
    const filePath = uri.fsPath || uri.path;
    if (!filePath) return null;
    const pathKey = (candidate) => {
        const resolved = path.resolve(candidate);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const requestedPath = pathKey(filePath);
    const offset = positionOffset(document, position.line, position.character);
    let selected = "";
    for (let index = 0; index < model.semanticForEntryResults.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const result = model.semanticForEntryResults[index];
        if (result.provisional || typeof result.filePath !== "string" || pathKey(result.filePath) !== requestedPath ||
            !["skip", "enter"].includes(result.result)) continue;
        const start = semanticSourceColumnOffset(document, result.startLine - 1, result.startColumn);
        const end = semanticSourceColumnOffset(document, result.endLine - 1, result.endColumn);
        if (start === null || end === null || end <= start || offset < start || offset >= end) continue;
        if (selected && selected !== result.result) return null;
        selected = result.result;
    }
    return selected || null;
}

function compilerSidecarOperatorExpressionRecords(model, checkCancelled, onlyUri = null, position = null, operatorCode = "", targetSymbol = 0) {
    if (model.partial || !Array.isArray(model.semanticProcedures) ||
        !model.semanticProcedures.length) return { complete: false, expressions: [] };

    const sourcePathKey = (filePath) => {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const onlyPath = onlyUri?.fsPath || onlyUri?.path ? sourcePathKey(onlyUri.fsPath || onlyUri.path) : "";
    const selectedPosition = position && onlyUri ? model.getDocument(onlyUri) : null;
    const selectedOffset = selectedPosition
        ? positionOffset(selectedPosition, position.line, position.character)
        : null;
    const requestedOperator = String(operatorCode || "").toLowerCase();
    const proceduresBySymbol = new Map();
    for (let index = 0; index < model.semanticProcedures.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const procedure = model.semanticProcedures[index];
        if (procedure.symbolClass !== 3 || !procedure.filePath ||
            !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
        const procedures = proceduresBySymbol.get(procedure.symbol) || [];
        procedures.push(procedure);
        proceduresBySymbol.set(procedure.symbol, procedures);
    }

    // Select physical ranges first, then retain every native target at those
    // ranges. Dropping other symbols up front would hide ambiguous receipts.
    const wantedRanges = targetSymbol ? new Set() : null;
    if (wantedRanges) {
        for (const [sourceUri, facts] of model.compilerSidecarExpressions || []) {
            checkCancelled();
            const source = model.sources.get(sourceUri);
            if (!source) continue;
            const sourcePath = source.uri.fsPath || source.uri.path || "";
            if (onlyPath && (!sourcePath || sourcePathKey(sourcePath) !== onlyPath)) continue;
            if (selectedPosition && source.uri.toString() !== selectedPosition.uri.toString()) continue;
            for (const fact of facts) {
                checkCancelled();
                if (fact.provisional || fact.operatorKind !== "overloaded" || fact.compilerSidecarSymbolId !== targetSymbol ||
                    requestedOperator && fact.operatorCode !== requestedOperator ||
                    !Number.isSafeInteger(fact.startOffset) || !Number.isSafeInteger(fact.endOffset) ||
                    fact.endOffset <= fact.startOffset || selectedOffset !== null &&
                        (selectedOffset < fact.startOffset || selectedOffset >= fact.endOffset)) continue;
                wantedRanges.add(`${source.uri}:${fact.startOffset}:${fact.endOffset}`);
                if (wantedRanges.size > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return { complete: false, expressions: [] };
            }
        }
        if (!wantedRanges.size) return { complete: true, expressions: [] };
    }
    const selectedByRange = new Map();
    for (const [sourceUri, facts] of model.compilerSidecarExpressions || []) {
        checkCancelled();
        const source = model.sources.get(sourceUri);
        if (!source) continue;
        const sourcePath = source.uri.fsPath || source.uri.path || "";
        if (onlyPath && (!sourcePath || sourcePathKey(sourcePath) !== onlyPath)) continue;
        if (selectedPosition && source.uri.toString() !== selectedPosition.uri.toString()) continue;
        for (const fact of facts) {
            checkCancelled();
            if (fact.provisional || fact.operatorKind !== "overloaded" ||
                !fact.compilerSidecarSymbolId || requestedOperator && fact.operatorCode !== requestedOperator ||
                !Number.isSafeInteger(fact.startOffset) || !Number.isSafeInteger(fact.endOffset) ||
                fact.endOffset <= fact.startOffset || selectedOffset !== null &&
                    (selectedOffset < fact.startOffset || selectedOffset >= fact.endOffset)) continue;
            const key = `${source.uri}:${fact.startOffset}:${fact.endOffset}`;
            if (wantedRanges && !wantedRanges.has(key)) continue;
            const procedures = proceduresBySymbol.get(fact.compilerSidecarSymbolId) || [];
            // A declared external operator has a native identity but no local P body.
            let selected = selectedByRange.get(key);
            if (!selected) {
                if (selectedByRange.size >= MAX_COMPILER_SIDECAR_CALL_BINDINGS) return { complete: false, expressions: [] };
                selected = {
                    filePath: sourcePath,
                    line: fact.start.line,
                    startColumn: fact.start.character,
                    endLine: fact.end.line,
                    endColumn: fact.end.character,
                    startOffset: fact.startOffset,
                    endOffset: fact.endOffset,
                    targetSymbols: new Set(),
                    procedures: new Map()
                };
                selectedByRange.set(key, selected);
            }
            selected.targetSymbols.add(fact.compilerSidecarSymbolId);
            for (const procedure of procedures) {
                const procedureKey = `${procedure.filePath}:${procedure.startLine}:${procedure.endLine}`;
                selected.procedures.set(procedureKey, {
                    filePath: procedure.filePath,
                    startLine: procedure.startLine,
                    endLine: procedure.endLine
                });
            }
        }
    }

    const expressions = [...selectedByRange.values()].map((selected) => ({
        filePath: selected.filePath,
        line: selected.line,
        startColumn: selected.startColumn,
        endLine: selected.endLine,
        endColumn: selected.endColumn,
        // Keep UTF-16 offsets for the at-position query's innermost-span selection.
        startOffset: selected.startOffset,
        endOffset: selected.endOffset,
        targetSymbols: [...selected.targetSymbols],
        procedures: [...selected.procedures.values()]
    }));
    return { complete: true, expressions };
}

function compilerSidecarProcedureDeclarationSites(model, expression, checkCancelled) {
    if (expression.targetSymbols.length !== 1) return [];
    const sites = new Map();
    for (const declaration of model.semanticDeclarations || []) {
        checkCancelled();
        if (declaration.symbol !== expression.targetSymbols[0] || declaration.physical !== true ||
            !["procedure-prototype", "procedure-definition"].includes(declaration.kind)) continue;
        if (declaration.provisional || typeof declaration.filePath !== "string" ||
            !path.isAbsolute(declaration.filePath)) return null;
        const source = model.getDocument(CompilerUri.file(declaration.filePath));
        if (!source) return null;
        const start = semanticSourceColumnOffset(source, declaration.startLine - 1, declaration.startColumn);
        const end = semanticSourceColumnOffset(source, declaration.endLine - 1, declaration.endColumn);
        if (start === null || end === null || end <= start) return null;
        const key = `${source.uri}:${start}:${end}:${declaration.kind}`;
        // D records describe whole headers; their optional name is not a token identity.
        sites.set(key, { filePath: declaration.filePath, kind: declaration.kind,
            startLine: declaration.startLine, startColumn: declaration.startColumn,
            endLine: declaration.endLine, endColumn: declaration.endColumn });
        if (sites.size > MAX_COMPILER_PROCEDURE_DECLARATION_SITES) return null;
    }
    return [...sites.values()];
}

function compilerSidecarOperatorDeclarationAt(model, uri, document, position, kind, checkCancelled) {
    const bindingsAvailable = model.semanticBindingsAvailable === true ||
        Array.isArray(model.semanticBindings) && model.semanticBindings.length > 0;
    if (model.partial || !bindingsAvailable ||
        !Number.isSafeInteger(model.compilerSemanticModelSchemaVersion) || model.compilerSemanticModelSchemaVersion < 27 ||
        !["procedure-prototype", "procedure-definition"].includes(kind)) return null;
    // Null permits legacy fallback. An empty target is an authoritative
    // negative, including inactive declarations and ambiguous native identities.
    const unresolved = { targetSymbols: [], declarations: [], origin: null };
    const filePath = uri.fsPath || uri.path;
    if (!filePath) return null;
    const selectedPath = compilerSidecarNavigationPathKey(filePath);
    const offset = positionOffset(document, position.line, position.character);
    const symbols = new Set();
    for (const declaration of model.semanticDeclarations || []) {
        checkCancelled();
        if (declaration.kind !== kind || declaration.physical !== true || declaration.provisional ||
            !declaration.filePath || compilerSidecarNavigationPathKey(declaration.filePath) !== selectedPath ||
            model.compilerProcedureKindsBySemanticIdentity?.get(declaration.symbol) !== "operator") continue;
        const start = semanticSourceColumnOffset(document, declaration.startLine - 1, declaration.startColumn);
        const end = semanticSourceColumnOffset(document, declaration.endLine - 1, declaration.endColumn);
        if (start === null || end === null || end <= start || offset < start || offset >= end) continue;
        symbols.add(declaration.symbol);
        if (symbols.size > 1) return unresolved;
    }
    if (symbols.size !== 1) return unresolved;
    const targetSymbols = [...symbols];
    const declarations = compilerSidecarProcedureDeclarationSites(model, { targetSymbols }, checkCancelled);
    if (!declarations?.length) return unresolved;
    const origins = declarations.filter((site) => site.kind === kind &&
        compilerSidecarNavigationPathKey(site.filePath) === selectedPath &&
        offset >= semanticSourceColumnOffset(document, site.startLine - 1, site.startColumn) &&
        offset < semanticSourceColumnOffset(document, site.endLine - 1, site.endColumn));
    return origins.length === 1 ? { targetSymbols, declarations, origin: origins[0] } : unresolved;
}

function compilerSidecarOperatorOperationRecords(model, checkCancelled, onlyUri = null, position = null, operatorCode = "", targetSymbol = 0) {
    if (model.partial || !Array.isArray(model.semanticOperations) ||
        !model.semanticOperations.length || !Array.isArray(model.semanticProcedures)) {
        return { complete: false, operations: [] };
    }

    const sourcePathKey = (filePath) => {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const onlyPath = onlyUri?.fsPath || onlyUri?.path ? sourcePathKey(onlyUri.fsPath || onlyUri.path) : "";
    const selectedPosition = position && onlyUri ? model.getDocument(onlyUri) : null;
    const selectedOffset = selectedPosition
        ? positionOffset(selectedPosition, position.line, position.character)
        : null;
    const requestedOperator = String(operatorCode || "").toLowerCase();
    const proceduresBySymbol = new Map();
    for (let index = 0; index < model.semanticProcedures.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const procedure = model.semanticProcedures[index];
        if (procedure.symbolClass !== 3 || !procedure.filePath ||
            !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
        const procedures = proceduresBySymbol.get(procedure.symbol) || [];
        procedures.push(procedure);
        proceduresBySymbol.set(procedure.symbol, procedures);
    }

    const wantedRanges = targetSymbol ? new Set() : null;
    if (wantedRanges) {
        for (const operation of model.semanticOperations) {
            checkCancelled();
            if (operation.operatorKind !== "overloaded" || operation.physical !== true || operation.target !== targetSymbol ||
                requestedOperator && operation.operatorCode !== requestedOperator || !operation.filePath) continue;
            if (onlyPath && sourcePathKey(operation.filePath) !== onlyPath) continue;
            const source = model.getDocument(CompilerUri.file(operation.filePath));
            if (!source || selectedPosition && source.uri.toString() !== selectedPosition.uri.toString()) continue;
            const startOffset = semanticSourceColumnOffset(source, operation.startLine - 1, operation.startColumn);
            const endOffset = semanticSourceColumnOffset(source, operation.endLine - 1, operation.endColumn);
            if (startOffset === null || endOffset === null || endOffset <= startOffset || selectedOffset !== null &&
                (selectedOffset < startOffset || selectedOffset >= endOffset)) continue;
            const start = positionAtOffset(source, startOffset), end = positionAtOffset(source, endOffset);
            wantedRanges.add(`${source.uri}:${start.line}:${start.character}:${end.line}:${end.character}:${operation.operatorCode}`);
            if (wantedRanges.size > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return { complete: false, operations: [] };
        }
        if (!wantedRanges.size) return { complete: true, operations: [] };
    }
    const bySite = new Map();
    for (let index = 0; index < model.semanticOperations.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const operation = model.semanticOperations[index];
        if (operation.operatorKind !== "overloaded" || operation.physical !== true || operation.target < 1 ||
            requestedOperator && operation.operatorCode !== requestedOperator || !operation.filePath) continue;
        const filePath = sourcePathKey(operation.filePath);
        if (onlyPath && filePath !== onlyPath) continue;
        const source = model.getDocument(CompilerUri.file(operation.filePath));
        if (!source) continue;
        if (selectedPosition && source.uri.toString() !== selectedPosition.uri.toString()) continue;
        const startOffset = semanticSourceColumnOffset(source, operation.startLine - 1, operation.startColumn);
        const endOffset = semanticSourceColumnOffset(source, operation.endLine - 1, operation.endColumn);
        if (startOffset === null || endOffset === null || endOffset <= startOffset ||
            selectedOffset !== null && (selectedOffset < startOffset || selectedOffset >= endOffset)) continue;
        const start = positionAtOffset(source, startOffset);
        const end = positionAtOffset(source, endOffset);
        const key = `${source.uri}:${start.line}:${start.character}:${end.line}:${end.character}:${operation.operatorCode}`;
        if (wantedRanges && !wantedRanges.has(key)) continue;
        const procedures = proceduresBySymbol.get(operation.target) || [];
        let record = bySite.get(key);
        if (!record) {
            if (bySite.size >= MAX_COMPILER_SIDECAR_CALL_BINDINGS) return { complete: false, operations: [] };
            record = {
                filePath: source.uri.fsPath || source.uri.path || operation.filePath,
                line: start.line,
                startColumn: start.character,
                endLine: end.line,
                endColumn: end.character,
                operatorCode: operation.operatorCode,
                targetSymbols: new Set(),
                procedures: new Map()
            };
            bySite.set(key, record);
        }
        record.targetSymbols.add(operation.target);
        for (const procedure of procedures) {
            record.procedures.set(`${procedure.filePath}:${procedure.startLine}:${procedure.endLine}`, {
                filePath: procedure.filePath,
                startLine: procedure.startLine,
                endLine: procedure.endLine
            });
        }
    }

    const operations = [...bySite.values()].map((record) => ({
        filePath: record.filePath,
        line: record.line,
        startColumn: record.startColumn,
        endLine: record.endLine,
        endColumn: record.endColumn,
        operatorCode: record.operatorCode,
        targetSymbols: [...record.targetSymbols],
        procedures: [...record.procedures.values()]
    }));
    return { complete: true, operations };
}

function compilerProcedureReferenceCodeLensRecords(model, checkCancelled, uri) {
    const result = model.semanticSidecarOnly
        ? compilerSidecarProcedureReferenceCodeLenses(model, checkCancelled, uri)
        : model.compilerProcedureReferenceCodeLenses(uri, checkCancelled);
    if (!result.complete || !Array.isArray(result.entries)) return result;

    const sourcePathKey = (filePath) => {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const selectedPath = sourcePathKey(uri.fsPath || uri.path);
    const entries = new Map(result.entries.map((entry) => [
        `${entry.line}:${entry.startColumn}:${entry.endColumn}`,
        { ...entry, references: new Map(entry.references.map((reference) => [
            `${sourcePathKey(reference.filePath)}:${reference.line}:${reference.startColumn}:${reference.endColumn}`,
            reference
        ])) }
    ]));

    const operations = compilerSidecarOperatorOperationRecords(model, checkCancelled);
    if (operations.complete && operations.operations.length) {
        const selectedBySite = new Map();
        const siteKey = (operation) => `${sourcePathKey(operation.filePath)}:${operation.line}:` +
            `${operation.startColumn}:${operation.endLine}:${operation.endColumn}`;
        for (const operation of operations.operations) {
            checkCancelled();
            const key = siteKey(operation);
            const selected = selectedBySite.get(key) || { symbols: new Set(), ambiguous: false };
            if (operation.targetSymbols.length !== 1) selected.ambiguous = true;
            else selected.symbols.add(operation.targetSymbols[0]);
            selectedBySite.set(key, selected);
        }

        const operatorEntriesByLine = new Map();
        for (const entry of model.inner.entries) {
            checkCancelled();
            if (entry.declaration.type !== "operator" || !entry.uri?.fsPath) continue;
            const key = `${sourcePathKey(entry.uri.fsPath)}:${entry.declaration.line}`;
            const candidates = operatorEntriesByLine.get(key) || [];
            candidates.push(entry);
            operatorEntriesByLine.set(key, candidates);
        }

        for (const operation of operations.operations) {
            checkCancelled();
            const selected = selectedBySite.get(siteKey(operation));
            if (!selected || selected.ambiguous || selected.symbols.size !== 1) continue;
            const reference = {
                filePath: operation.filePath,
                line: operation.line,
                startColumn: operation.startColumn,
                endColumn: operation.endColumn
            };
            for (const procedure of operation.procedures) {
                if (!procedure.filePath || sourcePathKey(procedure.filePath) !== selectedPath ||
                    !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
                const candidates = operatorEntriesByLine.get(`${selectedPath}:${procedure.startLine - 1}`) || [];
                if (candidates.length !== 1) continue;
                const declaration = candidates[0].declaration;
                const key = `${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`;
                let entry = entries.get(key);
                if (!entry) {
                    entry = {
                        compilerSymbolId: candidates[0].compilerSymbolId || 0,
                        name: candidates[0].name,
                        line: declaration.line,
                        startColumn: declaration.startColumn,
                        endColumn: declaration.endColumn,
                        references: new Map()
                    };
                    entries.set(key, entry);
                }
                entry.references.set(`${sourcePathKey(reference.filePath)}:${reference.line}:` +
                    `${reference.startColumn}:${reference.endColumn}`, reference);
            }
        }
    }

    const implicitCalls = compilerSidecarImplicitCallRecords(model, checkCancelled);
    if (implicitCalls.complete && implicitCalls.calls.length) {
        const proceduresByLine = new Map();
        // Stock sidecars have no native inventory projected onto inner entries.
        // Use the captured source only to present the compiler-selected body.
        const source = model.getDocument(uri);
        const lifetimeEntries = model.semanticSidecarOnly && source
            ? compilerSidecarCompletionScopeDocument(model, source)?.entries || [] : model.inner.entries;
        for (const entry of lifetimeEntries) {
            checkCancelled();
            if (!["constructor", "destructor"].includes(entry.declaration.type) || !entry.uri?.fsPath) continue;
            const key = `${sourcePathKey(entry.uri.fsPath)}:${entry.declaration.line}`;
            const candidates = proceduresByLine.get(key) || [];
            candidates.push(entry);
            proceduresByLine.set(key, candidates);
        }

        const selectedBySiteKind = new Map();
        for (const call of implicitCalls.calls) {
            checkCancelled();
            if (!call.filePath || !call.kind || !Number.isSafeInteger(call.line) || call.line < 0 ||
                !Number.isSafeInteger(call.startColumn) || call.startColumn < 0 ||
                !Number.isSafeInteger(call.endColumn) || call.endColumn <= call.startColumn) continue;
            const key = `${sourcePathKey(call.filePath)}:${call.line}:${call.startColumn}:` +
                `${call.endLine}:${call.endColumn}:${call.kind}`;
            const selected = selectedBySiteKind.get(key) || { call, symbols: new Set(), signatures: new Set() };
            for (const symbol of call.targetSymbols || []) selected.symbols.add(symbol);
            for (const signature of call.targetSignatures || []) selected.signatures.add(signature);
            selectedBySiteKind.set(key, selected);
        }

        for (const selected of selectedBySiteKind.values()) {
            checkCancelled();
            const call = selected.call;
            if (selected.symbols.size !== 1 ||
                (call.kind === "explicit-constructor" ? selected.signatures.size !== 0 : selected.signatures.size !== 1)) continue;
            const destructorCall = call.kind.includes("destructor");
            const reference = {
                filePath: call.filePath,
                line: call.line,
                startColumn: call.startColumn,
                endColumn: call.endColumn
            };
            for (const procedure of call.procedures || []) {
                if (!procedure.filePath || sourcePathKey(procedure.filePath) !== selectedPath ||
                    !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
                const candidates = proceduresByLine.get(`${selectedPath}:${procedure.startLine - 1}`) || [];
                const matching = candidates.filter((entry) => entry.declaration.type ===
                    (destructorCall ? "destructor" : "constructor"));
                if (matching.length !== 1) continue;
                const declaration = matching[0].declaration;
                const key = `${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`;
                let entry = entries.get(key);
                if (!entry) {
                    entry = {
                        compilerSymbolId: matching[0].compilerSymbolId || 0,
                        name: matching[0].name,
                        line: declaration.line,
                        startColumn: declaration.startColumn,
                        endColumn: declaration.endColumn,
                        references: new Map()
                    };
                    entries.set(key, entry);
                }
                entry.references.set(`${sourcePathKey(reference.filePath)}:${reference.line}:` +
                    `${reference.startColumn}:${reference.endColumn}`, reference);
            }
        }
    }

    if (!model.semanticSidecarOnly && !model.partial) {
        const declarations = model.inner.entries.filter((entry) => entry.declaration.type === "constructor" &&
            entry.uri?.fsPath && sourcePathKey(entry.uri.fsPath) === selectedPath && !entry.provisional);
        const constructors = callHierarchyEntries(model, declarations, checkCancelled);
        for (const constructor of constructors) {
            checkCancelled();
            const identity = nativeSymbolId(model, constructor);
            const references = compilerLifetimeReferences(model, constructor, null, checkCancelled);
            if (!references.length) continue;
            // The hierarchy family selection prefers its body in this file;
            // do not add a second lens to a same-file constructor prototype.
            const declaration = constructor.declaration;
            const key = `${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`;
            let entry = entries.get(key);
            if (!entry) {
                entry = { compilerSymbolId: identity, name: constructor.name, line: declaration.line,
                    startColumn: declaration.startColumn, endColumn: declaration.endColumn, references: new Map() };
                entries.set(key, entry);
            }
            // Use the same committed selections as Find References. Normal
            // constructor bindings and I receipts may already own a site.
            for (const reference of references) {
                const occurrence = reference.occurrence;
                const filePath = reference.uri.fsPath;
                if (!filePath) continue;
                entry.references.set(`${sourcePathKey(filePath)}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`,
                    { filePath, line: occurrence.line, startColumn: occurrence.startColumn, endColumn: occurrence.endColumn });
            }
        }
    }

    return {
        complete: true,
        entries: [...entries.values()].map((entry) => ({
            ...entry,
            references: entry.references instanceof Map ? [...entry.references.values()] : entry.references
        }))
    };
}

function compilerSidecarProcedureReferenceCodeLenses(model, checkCancelled, uri) {
    const bindings = model.semanticBindings;
    const procedures = model.semanticProcedures;
    const filePath = uri?.fsPath || uri?.path;
    if (model.partial || !Array.isArray(bindings) || bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS ||
        !Array.isArray(procedures) || procedures.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS ||
        typeof filePath !== "string" || !path.isAbsolute(filePath)) {
        return { complete: false, entries: [] };
    }

    const pathKey = compilerSidecarNavigationPathKey;
    const selectedPath = pathKey(filePath);
    const sources = compilerSidecarNavigationSources(model);
    const selectedSource = sources.get(selectedPath);
    if (!selectedSource) return { complete: true, entries: [] };

    const procedureSymbols = new Set();
    for (let index = 0; index < procedures.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const procedure = procedures[index];
        if (procedure.symbolClass === 3 && Number.isSafeInteger(procedure.symbol) && procedure.symbol > 0) {
            procedureSymbols.add(procedure.symbol);
        }
    }
    const declarations = new Map();
    const references = new Map();
    const parsedDeclarationsByPath = new Map();
    let parsedDeclarationBytes = 0;
    const declarationsForSource = (source) => {
        const sourcePath = source?.uri?.fsPath || source?.uri?.path;
        if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) return null;
        const sourcePathKey = pathKey(sourcePath);
        if (parsedDeclarationsByPath.has(sourcePathKey)) return parsedDeclarationsByPath.get(sourcePathKey);
        const sourceBytes = Buffer.byteLength(source.text, "utf8");
        if (sourceBytes > MAX_COMPILER_SIDECAR_NAVIGATION_SOURCE_BYTES ||
            parsedDeclarationBytes + sourceBytes > MAX_COMPILER_SIDECAR_CODE_LENS_PARSE_BYTES) {
            parsedDeclarationsByPath.set(sourcePathKey, null);
            return null;
        }
        parsedDeclarationBytes += sourceBytes;
        const declarations = parseFreeBasicText(source.text).declarations || [];
        const bounded = declarations.length <= MAX_COMPILER_SIDECAR_NAVIGATION_DECLARATIONS ? declarations : null;
        parsedDeclarationsByPath.set(sourcePathKey, bounded);
        return bounded;
    };
    const parsedDeclarationAt = (source, site) => {
        const declarations = declarationsForSource(source);
        if (!declarations) return null;
        const siteName = normalizeIdentifier(String(site.name || "").split(".").at(-1));
        const candidates = declarations.filter((declaration) => declaration.line === site.line &&
            declaration.startColumn === site.startColumn && declaration.endColumn >= site.endColumn &&
            normalizeIdentifier(String(declaration.name || "").split(".").at(-1)) === siteName);
        return candidates.length === 1 ? candidates[0] : null;
    };
    const addDeclaration = (symbol, occurrence, name) => {
        if (pathKey(occurrence.filePath) !== selectedPath) return true;
        const key = `${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`;
        let declaration = declarations.get(key);
        if (!declaration) {
            if (declarations.size >= MAX_COMPILER_SIDECAR_CODE_LENSES) return false;
            declaration = { ...occurrence, name, symbols: new Set() };
            declarations.set(key, declaration);
        }
        declaration.symbols.add(symbol);
        return true;
    };
    const addReference = (symbol, occurrence) => {
        const bindingPath = pathKey(occurrence.filePath);
        const key = `${bindingPath}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`;
        let reference = references.get(key);
        if (!reference) {
            if (references.size >= MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return false;
            reference = { ...occurrence, symbols: new Set() };
            references.set(key, reference);
        }
        reference.symbols.add(symbol);
        return true;
    };

    for (let index = 0; index < bindings.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const binding = bindings[index];
        if (!procedureSymbols.has(binding.symbol) || binding.physical !== true ||
            !["declaration", "reference"].includes(binding.role) ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath)) continue;

        const bindingPath = pathKey(binding.filePath);
        const source = sources.get(bindingPath);
        if (!source) return { complete: false, entries: [] };
        const matched = semanticBindingToken(source, binding);
        if (!matched) return { complete: false, entries: [] };
        const occurrence = {
            filePath: source.uri.fsPath || source.uri.path,
            line: matched.token.line,
            startColumn: matched.token.startColumn,
            endColumn: matched.token.endColumn
        };

        if (binding.role === "declaration") {
            if (!addDeclaration(binding.symbol, occurrence, matched.token.name)) {
                return { complete: false, entries: [] };
            }
            continue;
        }
        if (!addReference(binding.symbol, occurrence)) return { complete: false, entries: [] };
    }

    const callBindings = compilerSidecarCallBindingRecords(model, checkCancelled);
    if (callBindings.complete) {
        for (const call of callBindings.calls) {
            checkCancelled();
            const callableDeclarations = [];
            for (const declaration of call.declarations || []) {
                if (typeof declaration.filePath !== "string" || !path.isAbsolute(declaration.filePath) ||
                    !Number.isSafeInteger(declaration.line) || declaration.line < 0 ||
                    !Number.isSafeInteger(declaration.startColumn) || declaration.startColumn < 0 ||
                    !Number.isSafeInteger(declaration.endColumn) || declaration.endColumn <= declaration.startColumn) {
                    return { complete: false, entries: [] };
                }
                const declarationSource = sources.get(pathKey(declaration.filePath));
                const parsedDeclaration = parsedDeclarationAt(declarationSource, declaration);
                if (!parsedDeclaration) return { complete: false, entries: [] };
                if (CALL_HIERARCHY_TYPES.has(parsedDeclaration.type)) {
                    callableDeclarations.push({ declaration, source: declarationSource, parsed: parsedDeclaration });
                }
            }
            if (!callableDeclarations.length) continue;
            if (!Array.isArray(call.targetSymbols) || call.targetSymbols.length !== 1) {
                return { complete: false, entries: [] };
            }
            const symbol = call.targetSymbols[0];
            if (!Number.isSafeInteger(symbol) || symbol < 1) return { complete: false, entries: [] };
            procedureSymbols.add(symbol);
            if (typeof call.filePath !== "string" || !path.isAbsolute(call.filePath) ||
                !Number.isSafeInteger(call.line) || call.line < 0 ||
                !Number.isSafeInteger(call.startColumn) || call.startColumn < 0 ||
                !Number.isSafeInteger(call.endColumn) || call.endColumn <= call.startColumn) {
                return { complete: false, entries: [] };
            }
            const callSource = sources.get(pathKey(call.filePath));
            const callBinding = {
                physical: true,
                filePath: call.filePath,
                startLine: call.line + 1,
                startColumn: call.startColumn,
                endLine: call.line + 1,
                endColumn: call.endColumn
            };
            const callRange = semanticBindingToken(callSource, callBinding);
            if (!callRange) return { complete: false, entries: [] };
            const occurrence = {
                filePath: callSource.uri.fsPath || callSource.uri.path || call.filePath,
                line: callRange.token.line,
                startColumn: callRange.token.startColumn,
                endColumn: callRange.token.endColumn
            };
            if (!addReference(symbol, occurrence)) return { complete: false, entries: [] };

            for (const { declaration, source, parsed } of callableDeclarations) {
                if (!addDeclaration(symbol, {
                    filePath: source.uri.fsPath || source.uri.path || declaration.filePath,
                    line: parsed.line,
                    startColumn: parsed.startColumn,
                    endColumn: parsed.endColumn
                }, parsed.name)) return { complete: false, entries: [] };
            }
        }
    } else if (model.compilerSourceCallBindings?.length) {
        return { complete: false, entries: [] };
    }

    const operatorExpressions = compilerSidecarOperatorExpressionRecords(model, checkCancelled);
    if (!operatorExpressions.complete && procedures.some((procedure) => procedure.symbolClass === 3)) {
        return { complete: false, entries: [] };
    }
    if (operatorExpressions.complete) {
        for (const expression of operatorExpressions.expressions) {
            checkCancelled();
            if (!Array.isArray(expression.targetSymbols) || expression.targetSymbols.length !== 1) {
                if (expression.targetSymbols?.some((symbol) => procedureSymbols.has(symbol))) {
                    return { complete: false, entries: [] };
                }
                continue;
            }
            const symbol = expression.targetSymbols[0];
            if (!procedureSymbols.has(symbol)) continue;
            if (typeof expression.filePath !== "string" || !path.isAbsolute(expression.filePath) ||
                !Number.isSafeInteger(expression.line) || expression.line < 0 ||
                expression.endLine !== expression.line ||
                !Number.isSafeInteger(expression.startColumn) || expression.startColumn < 0 ||
                !Number.isSafeInteger(expression.endColumn) || expression.endColumn <= expression.startColumn) {
                return { complete: false, entries: [] };
            }
            const source = sources.get(pathKey(expression.filePath));
            const start = semanticSourceColumnOffset(source, expression.line, expression.startColumn);
            const end = semanticSourceColumnOffset(source, expression.endLine, expression.endColumn);
            if (start === null || end === null || end <= start) return { complete: false, entries: [] };
            if (!addReference(symbol, {
                filePath: source.uri.fsPath || source.uri.path || expression.filePath,
                line: expression.line,
                startColumn: expression.startColumn,
                endColumn: expression.endColumn
            })) return { complete: false, entries: [] };

            for (const procedure of expression.procedures || []) {
                if (typeof procedure.filePath !== "string" || !path.isAbsolute(procedure.filePath) ||
                    pathKey(procedure.filePath) !== selectedPath ||
                    !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
                const selectedDeclarations = declarationsForSource(selectedSource);
                if (!selectedDeclarations) return { complete: false, entries: [] };
                const candidates = selectedDeclarations.filter((declaration) =>
                    declaration.type === "operator" && declaration.line === procedure.startLine - 1
                );
                if (candidates.length !== 1) return { complete: false, entries: [] };
                const declaration = candidates[0];
                if (!addDeclaration(symbol, {
                    filePath: selectedSource.uri.fsPath || selectedSource.uri.path || filePath,
                    line: declaration.line,
                    startColumn: declaration.startColumn,
                    endColumn: declaration.endColumn
                }, declaration.name)) return { complete: false, entries: [] };
            }
        }
    }

    const referencesBySymbol = new Map();
    for (const reference of references.values()) {
        checkCancelled();
        if (reference.symbols.size !== 1) return { complete: false, entries: [] };
        const [symbol] = reference.symbols;
        const { symbols: _symbols, ...location } = reference;
        const locations = referencesBySymbol.get(symbol) || [];
        locations.push(location);
        referencesBySymbol.set(symbol, locations);
    }

    const entries = [];
    let projectedReferences = 0;
    for (const declaration of declarations.values()) {
        checkCancelled();
        if (declaration.symbols.size !== 1) return { complete: false, entries: [] };
        const [symbol] = declaration.symbols;
        const selectedReferences = referencesBySymbol.get(symbol) || [];
        if (!selectedReferences.length) continue;
        projectedReferences += selectedReferences.length;
        if (projectedReferences > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return { complete: false, entries: [] };
        const { symbols: _symbols, ...entry } = declaration;
        entries.push({ ...entry, references: selectedReferences });
    }

    return { complete: true, entries };
}

function compilerSidecarImplicitCallRecords(model, checkCancelled, onlyUri = null) {
    if (model.partial || model.compilerSemanticModelSchemaVersion < 10 ||
        !Array.isArray(model.semanticImplicitCalls) || !Array.isArray(model.semanticProcedures)) {
        return { complete: false, calls: [] };
    }
    const lifetimeCalls = compilerLifetimeCalls(model, checkCancelled);
    if (!lifetimeCalls) return { complete: false, calls: [] };

    const sourcePathKey = (filePath) => {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const onlyPath = onlyUri?.fsPath || onlyUri?.path ? sourcePathKey(onlyUri.fsPath || onlyUri.path) : "";
    const proceduresBySymbol = new Map();
    for (let index = 0; index < model.semanticProcedures.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const procedure = model.semanticProcedures[index];
        if (procedure.symbolClass !== 3 || !procedure.filePath ||
            !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
        const procedures = proceduresBySymbol.get(procedure.symbol) || [];
        procedures.push(procedure);
        proceduresBySymbol.set(procedure.symbol, procedures);
    }

    const bySite = new Map();
    const implicitCallKinds = new Set([
        "default-constructor", "initializer-constructor", "new-constructor",
        "argument-constructor", "return-constructor", "explicit-constructor", "destructor-call",
        "temporary-destructor", "delete-destructor", "scope-exit-destructor"
    ]);
    for (let index = 0; index < lifetimeCalls.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const call = lifetimeCalls[index];
        if (!implicitCallKinds.has(call.kind) || call.physical !== true || !call.filePath ||
            call.target < 1 || onlyPath && sourcePathKey(call.filePath) !== onlyPath) continue;
        const source = model.getDocument(CompilerUri.file(call.filePath));
        if (!source) continue;
        const startOffset = semanticSourceColumnOffset(source, call.startLine - 1, call.startColumn);
        const endOffset = semanticSourceColumnOffset(source, call.endLine - 1, call.endColumn);
        if (startOffset === null || endOffset === null || endOffset <= startOffset) continue;
        const procedures = proceduresBySymbol.get(call.target) || [];
        if (!procedures.length) continue;
        const start = positionAtOffset(source, startOffset);
        const end = positionAtOffset(source, endOffset);
        const key = `${source.uri}:${start.line}:${start.character}:${end.line}:${end.character}:${call.kind}:${call.target}`;
        let record = bySite.get(key);
        if (!record) {
            if (bySite.size >= MAX_COMPILER_SIDECAR_CALL_BINDINGS) return { complete: false, calls: [] };
            record = {
                filePath: source.uri.fsPath || source.uri.path || call.filePath,
                line: start.line,
                startColumn: start.character,
                endLine: end.line,
                endColumn: end.character,
                kind: call.kind,
                targetSymbols: new Set(),
                targetSignatures: new Set(),
                procedures: new Map()
            };
            bySite.set(key, record);
        }
        record.targetSymbols.add(call.target);
        if (call.kind !== "explicit-constructor") record.targetSignatures.add(call.targetSignature);
        for (const procedure of procedures) {
            record.procedures.set(`${procedure.filePath}:${procedure.startLine}:${procedure.endLine}`, {
                filePath: procedure.filePath,
                startLine: procedure.startLine,
                endLine: procedure.endLine
            });
        }
    }

    const calls = [...bySite.values()].map((record) => ({
        filePath: record.filePath,
        line: record.line,
        startColumn: record.startColumn,
        endLine: record.endLine,
        endColumn: record.endColumn,
        kind: record.kind,
        targetSymbols: [...record.targetSymbols],
        targetSignatures: [...record.targetSignatures],
        procedures: [...record.procedures.values()]
    }));
    return { complete: true, calls };
}

function stableCallParameters(signature) {
    if (typeof signature !== "string") return null;
    const fields = signature.split("|");
    if (fields[0] !== "sig2" || (fields.length - 1) % 5 !== 0) return null;
    const parameters = [];
    for (let index = 1; index < fields.length; index += 5) {
        const [mode, optional, dimensions, dtype, subtype] = fields.slice(index, index + 5);
        if (!["byval", "byref", "bydesc", "vararg"].includes(mode) || !/^[01]$/.test(optional) ||
            !/^(?:-1|0|[1-9]\d*)$/.test(dimensions) || !/^(?:0|[1-9]\d*)$/.test(dtype) ||
            !/^(?:0|[1-9]\d*)$/.test(subtype)) return null;
        const dimensionsValue = Number(dimensions);
        const dtypeValue = Number(dtype);
        const subtypeValue = Number(subtype);
        if (!Number.isSafeInteger(dimensionsValue) || !Number.isSafeInteger(dtypeValue) || !Number.isSafeInteger(subtypeValue) ||
            (mode === "bydesc" ? dimensionsValue !== -1 && dimensionsValue < 1 : dimensionsValue !== 0)) return null;
        parameters.push({ mode, optional: optional === "1", dimensions: dimensionsValue,
            dtype: dtypeValue, subtype: subtypeValue });
    }
    return parameters;
}

function nativeCallableParameters(model, entry) {
    const owner = nativeSymbolId(model, entry);
    const records = model.inventory?.entriesByOwner?.get(owner) || [];
    const seen = new Set();
    const parameters = [];
    for (const parameter of records) {
        const symbol = parameter.nativeSymbol;
        if (parameter.declaration.type !== "parameter" || symbol?.symbolClass !== 4) continue;
        const id = model.canonicalSymbolIds.get(symbol.id) || symbol.id;
        if (seen.has(id)) continue;
        seen.add(id);
        const shape = model.inventory.shapes.get(symbol.id) || model.inventory.shapes.get(id);
        const mode = ({ 1: "byval", 2: "byref", 3: "bydesc", 4: "vararg" })[shape?.parameterMode];
        if (!shape || !mode || !Number.isSafeInteger(symbol.dtype) || !Number.isSafeInteger(symbol.subtype)) return null;
        parameters.push({ mode, optional: shape.optional, dimensions: shape.dimensions,
            dtype: symbol.dtype, subtype: model.canonicalSymbolIds.get(symbol.subtype) || symbol.subtype });
    }
    return parameters;
}

function sameCallParameters(expected, actual, model) {
    if (!expected || !actual || expected.length !== actual.length) return false;
    for (let index = 0; index < expected.length; index++) {
        const left = expected[index];
        const right = actual[index];
        const expectedSubtype = left.subtype ? model.semanticSymbolNativeIds.get(left.subtype) || 0 : 0;
        if (left.subtype && !expectedSubtype || left.mode !== right.mode || left.optional !== right.optional ||
            left.dimensions !== right.dimensions || left.dtype !== right.dtype || expectedSubtype !== right.subtype) return false;
    }
    return true;
}

function compilerSelectedNewConstructorTarget(model, uri, document, context, candidates, checkCancelled) {
    if (!model.inventory || !Array.isArray(model.semanticImplicitCalls) || !model.semanticImplicitCalls.length) return 0;
    const callee = callNameSpan(document, context);
    const filePath = uri.fsPath || uri.path;
    if (!callee || !filePath) return 0;
    const sourceKey = process.platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
    const facts = model.semanticImplicitCalls.filter((call) => {
        checkCancelled();
        if (call.kind !== "new-constructor" || !call.physical || !call.filePath) return false;
        const callKey = process.platform === "win32" ? path.resolve(call.filePath).toLowerCase() : path.resolve(call.filePath);
        if (callKey !== sourceKey) return false;
        const factStart = semanticSourceColumnOffset(document, call.startLine - 1, call.startColumn);
        const factEnd = semanticSourceColumnOffset(document, call.endLine - 1, call.endColumn);
        return factStart === callee.start && factEnd === callee.end;
    });
    if (!facts.length) return 0;
    const signatures = new Set(facts.map((fact) => fact.targetSignature));
    if (signatures.size !== 1) return 0;
    const expected = stableCallParameters(signatures.values().next().value);
    if (!expected) return 0;
    const selectedIds = new Set();
    for (const candidate of candidates) {
        checkCancelled();
        const actual = nativeCallableParameters(model, candidate);
        if (sameCallParameters(expected, actual, model)) selectedIds.add(nativeSymbolId(model, candidate));
    }
    return selectedIds.size === 1 ? selectedIds.values().next().value : 0;
}

function compilerSelectedSidecarNewConstructorProcedure(model, uri, document, context, checkCancelled) {
    if (!model.semanticSidecarOnly || !Array.isArray(model.semanticImplicitCalls) ||
        !Array.isArray(model.semanticProcedures) || !model.semanticProcedures.length) return null;
    const callee = callNameSpan(document, context);
    const filePath = uri.fsPath || uri.path;
    if (!callee || !filePath) return null;
    const sourceKey = process.platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
    const facts = model.semanticImplicitCalls.filter((call) => {
        checkCancelled();
        if (call.kind !== "new-constructor" || !call.physical || !call.filePath) return false;
        const callKey = process.platform === "win32" ? path.resolve(call.filePath).toLowerCase() : path.resolve(call.filePath);
        if (callKey !== sourceKey) return false;
        return semanticSourceColumnOffset(document, call.startLine - 1, call.startColumn) === callee.start &&
            semanticSourceColumnOffset(document, call.endLine - 1, call.endColumn) === callee.end;
    });
    const targetIds = new Set(facts.map((call) => call.target));
    const signatures = new Set(facts.map((call) => call.targetSignature));
    if (targetIds.size !== 1 || signatures.size !== 1) return null;
    const [targetId] = targetIds;
    const procedures = model.semanticProcedures.filter((procedure) => procedure.symbol === targetId &&
        procedure.symbolClass === 3 && procedure.filePath && Number.isSafeInteger(procedure.startLine) && procedure.startLine > 0);
    if (procedures.length !== 1) return null;
    return {
        symbol: targetId,
        filePath: procedures[0].filePath,
        startLine: procedures[0].startLine,
        endLine: procedures[0].endLine
    };
}

function compilerSelectedConstructorProcedure(model, uri, document, context, checkCancelled) {
    if (!Array.isArray(model.semanticProcedures)) return null;
    const callee = callNameSpan(document, context);
    const filePath = uri.fsPath || uri.path;
    if (!callee || !filePath) return null;
    const terminal = document.tokens.find((token) => token.kind === "identifier" &&
        token.offset >= callee.start && token.end === callee.end);
    const sourceKey = process.platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
    const matchingCalls = compilerSidecarExplicitConstructorCallRecords(model, uri, document, checkCancelled)
        .filter((call) => {
            const callPath = process.platform === "win32"
                ? path.resolve(call.filePath).toLowerCase()
                : path.resolve(call.filePath);
            if (callPath !== sourceKey || call.targetSymbols.length !== 1) return false;
            const start = positionOffset(document, call.line, call.startColumn);
            const end = positionOffset(document, call.line, call.endColumn);
            // A temporary LOC can name only the terminal type/alias token,
            // while Signature Help includes its namespace qualification.
            return (start === callee.start || start === terminal?.offset) && end === callee.end;
        });
    const targetIds = new Set(matchingCalls.map((call) => call.targetSymbols[0]));
    const signatures = new Set(matchingCalls.map((call) => call.targetSignature || ""));
    if (targetIds.size !== 1 || signatures.size !== 1) return null;
    const [targetId] = targetIds;
    const procedures = model.semanticProcedures.filter((procedure) => procedure.symbol === targetId &&
        procedure.symbolClass === 3 && procedure.filePath && Number.isSafeInteger(procedure.startLine) && procedure.startLine > 0);
    if (!procedures.length) {
        // External constructors have physical headers but no local P body.
        // The same committed declaration reader used by navigation supplies
        // their signature without looking up a source-only overload family.
        const entries = compilerConstructorDeclarationEntries(model, targetId, checkCancelled);
        const declaration = entries?.find((entry) => !entry.declaration.modifiers.includes("DECLARE")) || entries?.[0];
        return declaration ? { symbol: targetId, filePath: declaration.uri.fsPath,
            startLine: declaration.declaration.line + 1, endLine: declaration.declaration.line + 1 } : null;
    }
    if (procedures.length !== 1) return null;
    return {
        symbol: targetId,
        filePath: procedures[0].filePath,
        startLine: procedures[0].startLine,
        endLine: procedures[0].endLine
    };
}

function isNewConstructorTypeAtPosition(document, position) {
    const offset = positionOffset(document, position.line, position.character);
    if (getCodeContext(document.text, offset, document.defaultEscapedStringRanges) !== "code") return false;
    let start = offset;
    let end = offset;
    const identifierCharacter = /[A-Za-z0-9_.$%!#&]/;
    while (start > 0 && identifierCharacter.test(document.text[start - 1])) start--;
    while (end < document.text.length && identifierCharacter.test(document.text[end])) end++;
    const name = document.text.slice(start, end);
    return /^[A-Za-z_][A-Za-z0-9_.$%!#&]*$/.test(name) && /\bNEW\s*$/i.test(document.text.slice(0, start).trimEnd());
}

function compilerSelectedImplicitConstructorTargetAtPosition(model, uri, document, position, kinds, checkCancelled) {
    if (!Array.isArray(model.semanticImplicitCalls)) return 0;
    const filePath = uri.fsPath || uri.path;
    if (!filePath) return 0;
    const sourcePath = process.platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
    const offset = positionOffset(document, position.line, position.character);
    const calls = compilerLifetimeCalls(model, checkCancelled) || [];
    // Native preparation uses the same counted selections for written
    // temporaries, but joins their semantic target through its physical body.
    const selections = model.semanticSidecarOnly ? calls : [...calls, ...(model.semanticTemporaryConstructions || [])];
    const facts = selections.filter((call) => {
        checkCancelled();
        if (!kinds.has(call.kind) || call.physical !== true || !call.filePath) return false;
        const callPath = process.platform === "win32" ? path.resolve(call.filePath).toLowerCase() : path.resolve(call.filePath);
        if (callPath !== sourcePath) return false;
        const start = semanticSourceColumnOffset(document, call.startLine - 1, call.startColumn);
        const end = semanticSourceColumnOffset(document, call.endLine - 1, call.endColumn);
        return start !== null && end !== null && end > start && offset >= start && offset < end;
    });
    const targets = new Set(facts.map((call) => call.target));
    const signatures = new Set(facts.filter((call) => call.kind !== "explicit-constructor").map((call) => call.targetSignature));
    if (targets.size !== 1 || signatures.size > 1) return 0;
    const [targetId] = targets;
    return Number.isSafeInteger(targetId) && targetId > 0 ? targetId : 0;
}

/* Constructors have physical D headers without named B declarations. The
   committed target and D roles select sites; source parsing supplies only
   their names and signature text, never the active branch or overload. */
function compilerConstructorDeclarationEntries(model, target, checkCancelled) {
    const bindingsAvailable = model.semanticBindingsAvailable === true ||
        Array.isArray(model.semanticBindings) && model.semanticBindings.length > 0;
    if (model.partial || !bindingsAvailable || !Number.isSafeInteger(model.compilerSemanticModelSchemaVersion) ||
        model.compilerSemanticModelSchemaVersion < 27) return null;
    if (!target || model.compilerProcedureKindsBySemanticIdentity?.get(target) !== "constructor") return null;
    const sites = compilerSidecarProcedureDeclarationSites(model, { targetSymbols: [target] }, checkCancelled);
    if (!sites?.length) return null;
    const records = new Map();
    for (const site of sites) {
        checkCancelled();
        const source = model.getDocument(CompilerUri.file(site.filePath));
        if (!source) return null;
        const declarations = compilerSidecarNavigationSourceDeclarations(model, source);
        if (!Array.isArray(declarations)) return null;
        const start = semanticSourceColumnOffset(source, site.startLine - 1, site.startColumn);
        const end = semanticSourceColumnOffset(source, site.endLine - 1, site.endColumn);
        if (start === null || end === null || end <= start) return null;
        let selected = null;
        for (let index = 0; index < declarations.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const declaration = declarations[index];
            const declarationStart = positionOffset(source, declaration.line, declaration.startColumn);
            const declarationEnd = positionOffset(source, declaration.line, declaration.endColumn);
            if (declaration.type !== "constructor" || declaration.provisional ||
                declarationStart < start || declarationEnd > end ||
                declaration.modifiers.includes("DECLARE") !== (site.kind === "procedure-prototype")) continue;
            // The native physical header proves this one declaration even
            // through a guard. Do not join same-signature source alternatives.
            if (selected) return null;
            selected = { id: `constructor:${target}:${source.uri}:${declarationStart}`,
                name: source.text.slice(declarationStart, declarationEnd),
                uri: source.uri, declaration, compilerSymbolId: target };
        }
        if (!selected) return null;
        records.set(selected.id, selected);
    }
    return [...records.values()];
}

function compilerTypedConstructorTokenAtPosition(document, position) {
    // Typed-construction recognition is optional lexical assistance. Missing
    // token indexes must not prevent ordinary native binding lookup.
    return (document.byLine?.get(position.line) || []).find((token) => token.key === "type" &&
        position.character >= token.startColumn && position.character < token.endColumn &&
        document.tokens[token.index + 1]?.name === "<");
}

function compilerConstructorNavigation(model, uri, document, position, operation, targets, checkCancelled) {
    const context = hoverCallContext(document, positionOffset(document, position.line, position.character));
    const callee = context && callNameSpan(document, context);
    const onCallee = callee && (document.byLine.get(position.line) || []).some((token) =>
        token.end === callee.end && position.character >= token.startColumn && position.character < token.endColumn);
    let target = 0;
    if (onCallee && (!targets.length || targets.some((entry) => TYPE_HIERARCHY_TYPES.has(entry.declaration.type)))) {
        target = compilerSelectedConstructorProcedure(model, uri, document, context, checkCancelled)?.symbol || 0;
    }
    const typed = compilerTypedConstructorTokenAtPosition(document, position);
    const typedOperation = typed && targets.every((entry) => TYPE_HIERARCHY_TYPES.has(entry.declaration.type));
    if (!target && typedOperation) {
        target = compilerSelectedImplicitConstructorTargetAtPosition(model, uri, document, position,
            new Set(["explicit-constructor"]), checkCancelled);
        // An enclosing call may convert this aggregate to a different UDT.
        // That implicit argument constructor is not the TYPE operation's target.
        if (!target || model.partial) return [];
    }
    if (!target) {
        // A value's own binding takes precedence over its implicit conversion.
        if (targets.length) return null;
        target = compilerSelectedImplicitConstructorTargetAtPosition(
            model, uri, document, position, new Set(["argument-constructor"]), checkCancelled
        );
        if (!target || compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled)) return null;
    }
    const records = compilerConstructorDeclarationEntries(model, target, checkCancelled);
    if (!records) return typedOperation ? [] : null;
    const entries = records.map(navigationEntryRecord);
    const declarations = entries.filter((entry) => entry.declaration.modifiers.includes("DECLARE"));
    const implementations = entries.filter((entry) => !entry.declaration.modifiers.includes("DECLARE"));
    if (operation === "declaration") return declarations.length ? declarations : implementations;
    if (operation === "implementation") return implementations;
    return implementations.length ? implementations : declarations;
}

function compilerSelectedImplicitConstructorEntryAtPosition(model, uri, document, position, kinds, checkCancelled) {
    if (!Array.isArray(model.semanticProcedures)) return null;
    const targetId = compilerSelectedImplicitConstructorTargetAtPosition(
        model, uri, document, position, kinds, checkCancelled
    );
    if (!targetId) return null;
    const procedures = model.semanticProcedures.filter((procedure) => procedure.symbol === targetId &&
        procedure.symbolClass === 3 && procedure.filePath && Number.isSafeInteger(procedure.startLine) && procedure.startLine > 0);
    if (procedures.length !== 1) return null;
    const procedurePath = process.platform === "win32"
        ? path.resolve(procedures[0].filePath).toLowerCase()
        : path.resolve(procedures[0].filePath);
    const entries = model.inner.entries.filter((entry) => {
        const entryPath = entry.uri.fsPath || entry.uri.path;
        const normalizedPath = process.platform === "win32" ? path.resolve(entryPath).toLowerCase() : path.resolve(entryPath);
        return normalizedPath === procedurePath && entry.declaration.type === "constructor" &&
        entry.declaration.line === procedures[0].startLine - 1 && !entry.declaration.modifiers.includes("DECLARE") &&
        !entry.conditional && !entry.provisional && !entry.declaration.provisional;
    });
    return entries.length === 1 ? entries[0] : null;
}

function sidecarLifetimeTargetAtProcedure(model, procedureLocation, declarations = [], kind = "constructor") {
    if (!procedureLocation?.filePath || !Number.isSafeInteger(procedureLocation.startLine)) return 0;
    const sites = new Set();
    for (const location of [{ filePath: procedureLocation.filePath, line: procedureLocation.startLine - 1 }, ...declarations]) {
        if (!location?.filePath || !Number.isSafeInteger(location.line) || location.line < 0) continue;
        const file = process.platform === "win32" ? path.resolve(location.filePath).toLowerCase() : path.resolve(location.filePath);
        sites.add(`${file}:${location.line + 1}`);
    }
    const matches = model.semanticProcedures.filter((procedure) => {
        if (procedure.symbolClass !== 3 || !procedure.filePath) return false;
        const filePath = process.platform === "win32" ? path.resolve(procedure.filePath).toLowerCase() : path.resolve(procedure.filePath);
        return sites.has(`${filePath}:${procedure.startLine}`);
    });
    const identities = new Set(matches.map((procedure) => procedure.symbol));
    if (kind === "constructor" || kind === "destructor") {
        // External lifetime procedures have no body/P record in this pass.
        // Their physical D prototype still names the selected semantic symbol.
        for (const declaration of model.semanticDeclarations || []) {
            if (declaration.kind !== "procedure-prototype" || declaration.physical !== true || !declaration.filePath) continue;
            const file = process.platform === "win32" ? path.resolve(declaration.filePath).toLowerCase() : path.resolve(declaration.filePath);
            if (!sites.has(`${file}:${declaration.startLine}`)) continue;
            const source = model.getDocument(CompilerUri.file(declaration.filePath));
            if (!source) continue;
            const start = semanticSourceColumnOffset(source, declaration.startLine - 1, declaration.startColumn);
            const end = semanticSourceColumnOffset(source, declaration.endLine - 1, declaration.endColumn);
            if (start === null || end === null || end <= start) continue;
            const keywords = (source.byLine.get(declaration.startLine - 1) || []).filter((token) =>
                token.key === kind && token.offset >= start && token.end <= end);
            if (keywords.length === 1) identities.add(declaration.symbol);
        }
    }
    return identities.size === 1 ? identities.values().next().value : 0;
}

function sidecarLifetimeLocationAtPosition(document, position) {
    const token = (document.byLine?.get(position.line) || []).find((candidate) => candidate.kind === "identifier" &&
        position.character >= candidate.startColumn && position.character < candidate.endColumn);
    if (!token || !["constructor", "destructor"].includes(token.key)) return null;
    const prefix = document.masked.slice(document.lineOffsets[token.line], token.offset);
    if (!/^\s*(?:(?:declare|private|public|protected|virtual|abstract|override)\s+)*$/i.test(prefix)) return null;
    const filePath = document.uri.fsPath || document.uri.path;
    return filePath ? { kind: token.key, filePath, startLine: token.line + 1,
        declarations: [{ filePath, line: token.line }] } : null;
}

function compilerLifetimeHeaderTargetAtPosition(model, uri, document, position, checkCancelled) {
    const occurrence = model.tokenAt(uri, position.line, position.character)?.token || null;
    const empty = { occurrence, entries: [] };
    if (model.partial || !model.semanticBindings?.length) return empty;
    const point = positionOffset(document, position.line, position.character);
    const fileKey = compilerSidecarNavigationPathKey(uri.fsPath);
    let selected = null;
    for (const header of model.semanticDeclarations || []) {
        checkCancelled();
        if (!header.physical || header.provisional ||
            !["procedure-definition", "procedure-prototype"].includes(header.kind) ||
            compilerSidecarNavigationPathKey(header.filePath) !== fileKey) continue;
        const kind = model.compilerProcedureKindsBySemanticIdentity?.get(header.symbol);
        if (!["constructor", "destructor"].includes(kind)) continue;
        const start = semanticSourceColumnOffset(document, header.startLine - 1, header.startColumn);
        const end = semanticSourceColumnOffset(document, header.endLine - 1, header.endColumn);
        if (start === null || end === null || point < start || point >= end) continue;
        if (selected) return empty;
        selected = { header, kind, start, end };
    }
    if (!selected) return empty;
    // A hierarchy item can select the written owner type. Native D ownership
    // still chooses the procedure; its keyword supplies the project anchor.
    const sites = sidecarLifetimeDeclarationOccurrences(model, selected.header.symbol, uri, [], checkCancelled, selected.kind)
        .filter((site) => site.occurrence.offset >= selected.start && site.occurrence.end <= selected.end);
    if (sites.length !== 1) return empty;
    return { occurrence, entries: [{ name: sites[0].occurrence.name, compilerSymbolId: selected.header.symbol,
        uri: uriRecord(sites[0].uri), declaration: { type: selected.kind, line: sites[0].occurrence.line,
            endColumn: sites[0].occurrence.endColumn,
            modifiers: selected.header.kind === "procedure-prototype" ? ["DECLARE"] : [] } }] };
}

function sidecarLifetimeDeclarationOccurrences(model, targetId, onlyUri, supplied = [], checkCancelled = () => {}, kind = "constructor") {
    const requestedPath = onlyUri?.fsPath || onlyUri?.path || "";
    const onlyPath = requestedPath
        ? process.platform === "win32" ? path.resolve(requestedPath).toLowerCase() : path.resolve(requestedPath)
        : "";
    const locations = new Map();
    for (const procedure of model.semanticProcedures || []) {
        if (procedure.symbol !== targetId || !procedure.filePath || !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
        const keyPath = process.platform === "win32" ? path.resolve(procedure.filePath).toLowerCase() : path.resolve(procedure.filePath);
        if (!onlyPath || keyPath === onlyPath) locations.set(`${keyPath}:${procedure.startLine - 1}`, {
            filePath: procedure.filePath,
            line: procedure.startLine - 1
        });
    }
    for (const location of supplied) {
        if (!location?.filePath || !Number.isSafeInteger(location.line) || location.line < 0) continue;
        const keyPath = process.platform === "win32" ? path.resolve(location.filePath).toLowerCase() : path.resolve(location.filePath);
        if (!onlyPath || keyPath === onlyPath) locations.set(`${keyPath}:${location.line}`, location);
    }
    if (kind === "constructor") {
        for (const entry of compilerConstructorDeclarationEntries(model, targetId, checkCancelled) || []) {
            const filePath = entry.uri.fsPath;
            const keyPath = process.platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
            if (!onlyPath || keyPath === onlyPath) locations.set(`${keyPath}:${entry.declaration.line}`,
                { filePath, line: entry.declaration.line });
        }
    } else if (kind === "destructor" && model.compilerProcedureKindsBySemanticIdentity?.get(targetId) === kind) {
        // A consuming module has a physical destructor prototype but no P
        // body record. Retain that native D anchor for cross-module joins.
        for (const site of compilerSidecarProcedureDeclarationSites(model, { targetSymbols: [targetId] }, checkCancelled) || []) {
            const keyPath = process.platform === "win32" ? path.resolve(site.filePath).toLowerCase() : path.resolve(site.filePath);
            if (!onlyPath || keyPath === onlyPath) locations.set(`${keyPath}:${site.startLine - 1}`,
                { filePath: site.filePath, line: site.startLine - 1 });
        }
    }

    const found = new Map();
    for (const location of locations.values()) {
        checkCancelled();
        const source = model.getDocument(CompilerUri.file(location.filePath));
        if (!source) continue;
        const keywords = (source.byLine.get(location.line) || []).filter((token) =>
            token.kind === "identifier" && token.key === kind);
        if (keywords.length !== 1) continue;
        const occurrence = keywords[0];
        found.set(`${source.uri}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`, {
            uri: source.uri,
            occurrence
        });
    }
    return [...found.values()];
}

/* Explicit destructors have anonymous F identities and a physical B use linked
   from their CALL node. They need no implicit cleanup receipt or named B
   declaration. Keep the terminal token selected by that native call binding. */
function compilerExplicitDestructorCalls(model, checkCancelled) {
    const calls = [];
    if (model.partial || !Array.isArray(model.semanticBindings)) return calls;
    for (const link of model.compilerSourceCallBindings || []) {
        checkCancelled();
        const binding = model.semanticBindings[link.target - 1];
        if (!binding || binding.role !== "reference" || binding.physical !== true || !binding.filePath ||
            model.compilerProcedureKindsBySemanticIdentity?.get(binding.symbol) !== "destructor") continue;
        const source = model.getDocument(CompilerUri.file(binding.filePath));
        const range = semanticBindingToken(source, binding);
        if (!range) continue;
        calls.push({ filePath: binding.filePath, physical: true, kind: "destructor-call", target: binding.symbol,
            startLine: range.token.line + 1, startColumn: range.token.startColumn,
            endLine: range.token.line + 1, endColumn: range.token.endColumn });
        if (calls.length > MAX_COMPILER_SIDECAR_CALL_BINDINGS) return [];
    }
    return calls;
}

function sidecarLifetimeReferences(model, targetId, onlyUri, checkCancelled, includeDeclaration = false, declarations = [], kind = "constructor") {
    if (!Number.isSafeInteger(targetId) || targetId < 1) return [];
    const callKinds = kind === "destructor" ? DESTRUCTOR_IMPLICIT_CALL_KINDS : CONSTRUCTOR_IMPLICIT_CALL_KINDS;
    const onlyPathValue = onlyUri?.fsPath || onlyUri?.path || "";
    const onlyPath = onlyPathValue
        ? process.platform === "win32" ? path.resolve(onlyPathValue).toLowerCase() : path.resolve(onlyPathValue)
        : "";
    const grouped = new Map();
    const constructorFiles = new Set();
    const callGroups = [compilerLifetimeCalls(model, checkCancelled) || []];
    if (kind === "destructor") callGroups.push(compilerExplicitDestructorCalls(model, checkCancelled));
    // The bridge's lifetime graph already owns explicit calls through its
    // trace. Occurrence queries also need their physical C receipts, without
    // adding a second copy of those calls to Call Hierarchy.
    if (kind === "constructor" && !model.semanticSidecarOnly && !model.partial) {
        callGroups.push(model.semanticTemporaryConstructions || []);
    }
    const addCall = (call) => {
        checkCancelled();
        if (!callKinds.has(call.kind) || !call.physical || !call.filePath) return;
        const filePath = process.platform === "win32" ? path.resolve(call.filePath).toLowerCase() : path.resolve(call.filePath);
        if (onlyPath && filePath !== onlyPath) return;
        const source = model.getDocument(CompilerUri.file(call.filePath));
        if (!source) return;
        let startOffset = semanticSourceColumnOffset(source, call.startLine - 1, call.startColumn);
        const endOffset = semanticSourceColumnOffset(source, call.endLine - 1, call.endColumn);
        if (startOffset === null || endOffset === null) return;
        if (kind === "constructor") {
            // A native callee span can include namespace qualification. Only
            // its final written token is the constructor occurrence.
            const terminal = (source.byLine.get(call.endLine - 1) || []).find((token) =>
                token.kind === "identifier" && token.end === endOffset && token.offset >= startOffset &&
                source.tokens[token.index + 1]?.name === "(");
            if (terminal) startOffset = terminal.offset;
            // Some NEW lifetime receipts cover only the leading qualifier.
            // That token belongs to its namespace, not the constructor. The
            // committed explicit-call receipt supplies the written callee.
            const qualifier = call.kind === "new-constructor" &&
                (source.byLine.get(call.endLine - 1) || []).find((token) =>
                    token.end === endOffset && token.offset >= startOffset && source.tokens[token.index + 1]?.name === ".");
            if (qualifier) return;
        }
        if (kind === "constructor" && call.target === targetId) constructorFiles.add(call.filePath);
        const start = positionAtOffset(source, startOffset);
        const end = positionAtOffset(source, endOffset);
        const key = `${filePath}:${start.line}:${start.character}:${end.line}:${end.character}:${call.kind}`;
        const group = grouped.get(key) || {
            uri: source.uri,
            occurrence: { line: start.line, startColumn: start.character, endLine: end.line, endColumn: end.character },
            targets: new Set()
        };
        group.targets.add(call.target);
        grouped.set(key, group);
    };
    for (const calls of callGroups) for (const call of calls) addCall(call);
    // Initializer receipts can point to the destination variable. Retain that
    // implicit relationship and also expose the compiler-bound written callee.
    // Both are navigation sites, not permission to rename a type token.
    for (const filePath of constructorFiles) {
        const source = model.getDocument(CompilerUri.file(filePath));
        for (const call of compilerSidecarExplicitConstructorCallRecords(model, source.uri, source, checkCancelled)) {
            for (const target of call.targetSymbols) addCall({
                filePath: call.filePath, physical: true, kind: "explicit-constructor", target,
                startLine: call.line + 1, startColumn: call.startColumn,
                endLine: call.line + 1, endColumn: call.endColumn
            });
        }
    }
    const references = [...grouped.values()]
        .filter((group) => group.targets.size === 1 && group.targets.has(targetId))
        .map(({ uri, occurrence }) => ({ uri: uriRecord(uri), occurrence }));
    if (includeDeclaration) {
        references.push(...sidecarLifetimeDeclarationOccurrences(model, targetId, onlyUri, declarations, checkCancelled, kind)
            .map(({ uri, occurrence }) => ({ uri: uriRecord(uri), occurrence })));
    }
    return [...new Map(references.map((entry) => {
        const site = entry.occurrence;
        return [`${entry.uri.fsPath}:${site.line}:${site.startColumn}:${site.endLine ?? site.line}:${site.endColumn}`, entry];
    })).values()];
}

function compilerNewConstructorReferences(model, target, onlyUri, checkCancelled) {
    if (!model.inventory || !Array.isArray(model.semanticImplicitCalls) || !model.semanticImplicitCalls.length ||
        target.declaration.type !== "constructor") return [];
    const targetId = nativeSymbolId(model, target);
    const owner = model.nativeSymbols.get(targetId)?.owner || target.nativeSymbol?.owner || 0;
    const ownerType = model.canonicalSymbolIds.get(owner) || owner;
    const expected = nativeCallableParameters(model, target);
    if (!ownerType || !expected) return [];
    const requestedPath = onlyUri?.fsPath || onlyUri?.path || "";
    const onlyPath = requestedPath
        ? process.platform === "win32" ? path.resolve(requestedPath).toLowerCase() : path.resolve(requestedPath)
        : "";
    const grouped = new Map();

    for (const call of model.semanticImplicitCalls) {
        checkCancelled();
        if (call.kind !== "new-constructor" || !call.physical || !call.filePath) continue;
        const callPath = process.platform === "win32" ? path.resolve(call.filePath).toLowerCase() : path.resolve(call.filePath);
        if (onlyPath && callPath !== onlyPath) continue;
        const nativeType = model.semanticSymbolNativeIds.get(call.type) || 0;
        if ((model.canonicalSymbolIds.get(nativeType) || nativeType) !== ownerType) continue;
        const source = model.getDocument(CompilerUri.file(call.filePath));
        if (!source) continue;
        const startOffset = semanticSourceColumnOffset(source, call.startLine - 1, call.startColumn);
        const endOffset = semanticSourceColumnOffset(source, call.endLine - 1, call.endColumn);
        if (startOffset === null || endOffset === null) continue;
        const start = positionAtOffset(source, startOffset);
        const end = positionAtOffset(source, endOffset);
        const key = `${callPath}:${start.line}:${start.character}:${end.line}:${end.character}`;
        const group = grouped.get(key) || {
            uri: source.uri,
            occurrence: { line: start.line, startColumn: start.character, endLine: end.line, endColumn: end.character },
            signatures: new Set(),
            matches: false
        };
        group.signatures.add(call.targetSignature);
        group.matches ||= sameCallParameters(stableCallParameters(call.targetSignature), expected, model);
        grouped.set(key, group);
    }

    return [...grouped.values()].filter((group) => group.signatures.size === 1 && group.matches)
        .map(({ uri, occurrence }) => ({ uri, occurrence }));
}

/* Project references join anonymous lifetime-procedure identities through proven
   physical headers, not their translation-unit-local numbers. This unit is
   read-only: a type token or an implicit conversion is not a rename token. */
function compilerLifetimeReferenceUnit(model, kind, checkCancelled, declarationsOnly = false) {
    if (model.partial || !Array.isArray(model.semanticBindings) || !model.semanticBindings.length) return null;
    if (!["constructor", "destructor"].includes(kind)) return null;
    const declarations = [], bindings = [];
    for (const [target, procedureKind] of model.compilerProcedureKindsBySemanticIdentity || []) {
        checkCancelled();
        // A temporary can construct and destroy at the same physical span.
        // Those distinct kinds are not conflicting overloads of this request.
        if (procedureKind !== kind) continue;
        const sites = sidecarLifetimeDeclarationOccurrences(model, target, null, [], checkCancelled, kind);
        if (!sites.length) continue;
        for (const { uri, occurrence } of sites) {
            declarations.push({ name: occurrence.name, compilerSymbolId: target, compilerPreprocessorId: 0,
                uri: uriRecord(uri), declaration: { type: kind, line: occurrence.line, endColumn: occurrence.endColumn } });
            bindings.push({ id: target, kind: "declaration", name: occurrence.name,
                physical: { uri: uriRecord(uri), occurrence }, generatedParts: null });
        }
        if (bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
        if (declarationsOnly) continue;
        for (const { uri, occurrence } of sidecarLifetimeReferences(model, target, null, checkCancelled, false, [], kind)) {
            const source = model.getDocument(CompilerUri.from(uri));
            const offset = source && semanticSourceColumnOffset(source, occurrence.line, occurrence.startColumn);
            const end = source && semanticSourceColumnOffset(source, occurrence.endLine ?? occurrence.line, occurrence.endColumn);
            if (offset === null || offset === undefined || end === null || end === undefined || end <= offset) return null;
            bindings.push({ id: target, kind: "reference", name: "", physical: { uri,
                occurrence: { ...occurrence, offset, end } }, generatedParts: null });
            if (bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
        }
        if (bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
    }
    return { declarations, bindings };
}

/* Operator IDs are local to a compiler pass. D headers are the project-family
   anchors; OP/typed-expression receipts supply read-only uses of those IDs.
   Source parsing only presents a name inside the already-proven header. */
function compilerOperatorReferenceUnit(model, checkCancelled, declarationsOnly = false, includeSourceMemory = false) {
    if (model.partial || !Array.isArray(model.semanticBindings) || !model.semanticBindings.length ||
        !Number.isSafeInteger(model.compilerSemanticModelSchemaVersion) || model.compilerSemanticModelSchemaVersion < 27) return null;
    const declarations = [], bindings = [];
    const operators = new Set();
    for (const [target, kind] of model.compilerProcedureKindsBySemanticIdentity || []) {
        checkCancelled();
        if (kind !== "operator") continue;
        const sites = compilerSidecarProcedureDeclarationSites(model, { targetSymbols: [target] }, checkCancelled);
        if (!sites) return null;
        for (const site of sites) {
            const source = model.getDocument(CompilerUri.file(site.filePath));
            const parsed = source && compilerSidecarNavigationSourceDeclarations(model, source);
            if (!parsed) return null;
            const start = semanticSourceColumnOffset(source, site.startLine - 1, site.startColumn);
            const end = semanticSourceColumnOffset(source, site.endLine - 1, site.endColumn);
            if (start === null || end === null || end <= start) return null;
            const candidates = parsed.filter((entry) => entry.type === "operator" && !entry.provisional &&
                entry.modifiers.includes("DECLARE") === (site.kind === "procedure-prototype") &&
                positionOffset(source, entry.line, entry.startColumn) >= start &&
                positionOffset(source, entry.line, entry.endColumn) <= end);
            if (candidates.length !== 1) return null;
            const entry = candidates[0];
            const uri = uriRecord(source.uri);
            declarations.push({ name: "operator", compilerSymbolId: target, uri,
                declaration: { type: "operator", line: site.startLine - 1,
                    endColumn: site.startColumn + "operator".length } });
            bindings.push({ id: target, kind: "declaration", name: entry.name, physical: { uri, occurrence: {
                name: entry.name, line: entry.line, startColumn: entry.startColumn, endColumn: entry.endColumn,
                offset: positionOffset(source, entry.line, entry.startColumn), end: positionOffset(source, entry.line, entry.endColumn)
            } }, generatedParts: null });
            if (bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
            operators.add(target);
        }
    }
    if (declarationsOnly) return { declarations, bindings };
    const operations = compilerSidecarOperatorOperationRecords(model, checkCancelled);
    const expressions = compilerSidecarOperatorExpressionRecords(model, checkCancelled);
    // An exhausted receipt reader is not evidence that a module has no uses.
    if (!operations.complete && model.semanticOperations?.some((entry) => entry.operatorKind === "overloaded")) return null;
    if (!expressions.complete && [...(model.compilerSidecarExpressions?.values() || [])]
        .some((facts) => facts.some((entry) => entry.operatorKind === "overloaded"))) return null;
    const operationTargets = new Set((operations.operations || []).flatMap((entry) => entry.targetSymbols));
    const records = [...(operations.operations || []), ...(expressions.expressions || [])
        .filter((entry) => !entry.targetSymbols.some((target) => operationTargets.has(target)))];
    // Only Find References requests source applications. Defaults, fields and
    // SIZEOF operands must not acquire runtime callers from reporting anchors.
    if (includeSourceMemory) for (const application of model.semanticMemoryApplications || []) {
        checkCancelled();
        records.push({ filePath: application.filePath, line: application.startLine - 1, startColumn: application.startColumn,
            endLine: application.endLine - 1, endColumn: application.endColumn, targetSymbols: [application.target],
            nativeMemoryMacroReference: application.macroInvocation === true });
        if (records.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
    }
    for (const record of records) {
        checkCancelled();
        const source = model.getDocument(CompilerUri.file(record.filePath));
        if (!source) return null;
        const offset = semanticSourceColumnOffset(source, record.line, record.startColumn);
        const end = semanticSourceColumnOffset(source, record.endLine ?? record.line, record.endColumn);
        if (offset === null || end === null || end <= offset) return null;
        for (const target of record.targetSymbols) {
            if (!operators.has(target)) continue;
            bindings.push({ id: target, kind: "reference", name: "", generatedParts: null,
                ...(record.nativeMemoryMacroReference === true ? { nativeMemoryMacroReference: true } : {}),
                ambiguousCall: record.targetSymbols.length !== 1, physical: {
                uri: uriRecord(source.uri), occurrence: { line: record.line, startColumn: record.startColumn,
                    endLine: record.endLine ?? record.line, endColumn: record.endColumn, offset, end }
            } });
            if (bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_RESULTS) return null;
        }
    }
    return { declarations, bindings };
}

function compilerSemanticProcedureSymbolForEntry(model, target) {
    if (!["constructor", "destructor"].includes(target?.declaration?.type) || !Array.isArray(model.semanticProcedures)) return 0;
    const targetId = nativeSymbolId(model, target);
    const family = model.inventory ? model.inner.entries : model.nativeFamilies?.get(targetId) || [];
    const sites = new Set();
    // A native prototype and body share identity, while the semantic export
    // can describe its procedure only at the body's physical source location.
    for (const entry of [target, ...family]) {
        if (entry.declaration?.type !== target.declaration.type || nativeSymbolId(model, entry) !== targetId) continue;
        const filePath = entry.uri?.fsPath || entry.uri?.path || "";
        if (!filePath) continue;
        const file = process.platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
        sites.add(`${file}:${entry.declaration.line + 1}`);
    }
    const symbols = new Set(model.semanticProcedures.filter((procedure) => {
        if (procedure.symbolClass !== 3 || !procedure.filePath) return false;
        const procedurePath = process.platform === "win32"
            ? path.resolve(procedure.filePath).toLowerCase()
            : path.resolve(procedure.filePath);
        return sites.has(`${procedurePath}:${procedure.startLine}`);
    }).map((procedure) => procedure.symbol));
    return symbols.size === 1 ? symbols.values().next().value : 0;
}

function compilerLifetimeDeclarationEntryAtPosition(model, uri, document, position) {
    if (!model.inventory || model.semanticSidecarOnly) return null;
    const tokens = document.byLine.get(position.line) || [];
    const keywordIndex = tokens.findIndex((token) => ["constructor", "destructor"].includes(token.key));
    if (keywordIndex < 0 || tokens.slice(0, keywordIndex).some((token) =>
        !["private", "public", "protected"].includes(token.key))) return null;
    const keyword = tokens[keywordIndex];
    let ownerIndex = keywordIndex + 1;
    if (tokens[ownerIndex]?.name === ".") ownerIndex++;
    if (tokens[ownerIndex]?.kind !== "identifier") return null;
    while (tokens[ownerIndex + 1]?.name === "." && tokens[ownerIndex + 2]?.kind === "identifier") ownerIndex += 2;
    if (position.character < keyword.startColumn || position.character >= tokens[ownerIndex].endColumn) return null;

    // FBC binds the written owner type to the UDT. References and hierarchy
    // invoked on that part of a lifetime declaration select the procedure
    // instead, using its native physical declaration, not its type spelling.
    const requestedPath = path.resolve(uri.fsPath || uri.path);
    const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const entries = model.inner.entries.filter((entry) => entry.compilerSymbolId && !entry.provisional &&
        !entry.declaration.provisional && entry.declaration.type === keyword.key &&
        !entry.declaration.modifiers.includes("DECLARE") && entry.declaration.line === position.line &&
        entry.uri?.scheme === "file" && pathKey(entry.uri.fsPath || entry.uri.path) === pathKey(requestedPath));
    const identities = new Set(entries.map((entry) => nativeSymbolId(model, entry)));
    return identities.size === 1 ? entries[0] : null;
}

function compilerLifetimeReferences(model, target, onlyUri, checkCancelled) {
    const kind = target?.declaration?.type;
    const callKinds = kind === "constructor" ? CONSTRUCTOR_IMPLICIT_CALL_KINDS
        : kind === "destructor" ? DESTRUCTOR_IMPLICIT_CALL_KINDS : null;
    if (!callKinds || !Array.isArray(model.semanticImplicitCalls)) return [];
    const targetId = nativeSymbolId(model, target);
    if (!targetId) return [];
    const semanticTargetId = compilerSemanticProcedureSymbolForEntry(model, target);
    // The exporter and native trace have separate identity domains. A physical
    // destructor declaration must prove their join before accepting cleanup.
    if (kind === "destructor" && !semanticTargetId) return [];
    const expectedTarget = semanticTargetId || targetId;
    const onlyPathValue = onlyUri?.fsPath || onlyUri?.path || "";
    const onlyPath = onlyPathValue
        ? process.platform === "win32" ? path.resolve(onlyPathValue).toLowerCase() : path.resolve(onlyPathValue)
        : "";
    const grouped = new Map();
    for (const call of model.semanticImplicitCalls) {
        checkCancelled();
        if (!callKinds.has(call.kind) || !call.physical || !call.filePath) continue;
        const filePath = process.platform === "win32" ? path.resolve(call.filePath).toLowerCase() : path.resolve(call.filePath);
        if (onlyPath && filePath !== onlyPath) continue;
        const source = model.getDocument(CompilerUri.file(call.filePath));
        if (!source) continue;
        const startOffset = semanticSourceColumnOffset(source, call.startLine - 1, call.startColumn);
        const endOffset = semanticSourceColumnOffset(source, call.endLine - 1, call.endColumn);
        if (startOffset === null || endOffset === null || endOffset <= startOffset) continue;
        const start = positionAtOffset(source, startOffset);
        const end = positionAtOffset(source, endOffset);
        const key = `${filePath}:${start.line}:${start.character}:${end.line}:${end.character}:${call.kind}`;
        const group = grouped.get(key) || {
            uri: source.uri,
            occurrence: { line: start.line, startColumn: start.character, endLine: end.line, endColumn: end.character },
            targets: new Set()
        };
        group.targets.add(semanticTargetId ? call.target :
            model.semanticSymbolNativeIds?.get(call.target) || model.canonicalSymbolIds?.get(call.target) || call.target);
        grouped.set(key, group);
    }
    const matchingGroups = [...grouped.values()]
        .filter((group) => group.targets.size === 1 && group.targets.has(expectedTarget))
        .map(({ uri, occurrence }) => ({ uri, occurrence }));
    if (kind === "constructor") {
        const expanded = model.inner.getDocument(model.expandedUri);
        const coveredCallsByUri = new Map();
        const seen = new Set(matchingGroups.map(({ uri, occurrence }) =>
            `${uri.toString()}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine ?? occurrence.line}:${occurrence.endColumn}`));
        // A written UDT temporary can have a direct native CALL without an I
        // receipt. Its target is already in the native identity domain. NEW has
        // a separate receipt at its type name, so do not add its keyword again.
        for (const call of model.expressionGraph?.nodes || []) {
            checkCancelled();
            if (call.kind !== "call" || call.options !== 1 || call.provisional || call.invalid ||
                (model.canonicalSymbolIds?.get(call.target) || call.target) !== targetId || !expanded) continue;
            const offset = positionOffset(expanded, call.start.line, call.start.character);
            const physical = model.expandedToSource.get(offset);
            if (!physical || physical.sourceMap !== 0 || physical.occurrence.key === "new" ||
                onlyUri && physical.uri.toString() !== onlyUri.toString()) continue;
            const source = model.getDocument(physical.uri);
            let occurrence = physical.occurrence;
            // Native CALL ranges begin at a qualified expression's namespace.
            // Highlight the terminal callee, not that independently named owner.
            while ([".", "->"].includes(source?.tokens[occurrence.index + 1]?.name) &&
                source.tokens[occurrence.index + 2]?.kind === "identifier" &&
                source.tokens[occurrence.index + 2].line === occurrence.line) {
                occurrence = source.tokens[occurrence.index + 2];
            }
            if (!["(", "<"].includes(source?.tokens[occurrence.index + 1]?.name)) continue;
            let coveredByLine = coveredCallsByUri.get(physical.uri.toString());
            if (!coveredByLine) {
                coveredByLine = new Map();
                const source = model.getDocument(physical.uri);
                const coveredCalls = source && semanticTargetId
                    ? compilerSidecarExplicitConstructorCallRecords(model, physical.uri, source, checkCancelled) : [];
                for (const covered of coveredCalls) {
                    if (covered.targetSymbols.length !== 1 || covered.targetSymbols[0] !== semanticTargetId) continue;
                    const ranges = coveredByLine.get(covered.line) || [];
                    ranges.push(covered);
                    coveredByLine.set(covered.line, ranges);
                }
                coveredCallsByUri.set(physical.uri.toString(), coveredByLine);
            }
            // The compiler can retain an initializer both at its declaration
            // and at its written type call. Keep the existing I receipt when
            // the compiler-bound type reference proves that they are one call.
            if ((coveredByLine.get(occurrence.line) || []).some((covered) =>
                covered.startColumn <= occurrence.startColumn && covered.endColumn >= occurrence.endColumn)) continue;
            const key = `${physical.uri.toString()}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine ?? occurrence.line}:${occurrence.endColumn}`;
            if (seen.has(key)) continue;
            seen.add(key);
            matchingGroups.push({ uri: physical.uri, occurrence });
        }
    }
    return matchingGroups;
}

function hoverCallContext(document, offset) {
    const current = findCallContextInMaskedText(document.masked, offset);
    const tokenIndex = document.tokens.findIndex((token) => token.kind === "identifier" && token.offset <= offset && offset <= token.end);
    const opening = document.tokens[tokenIndex + 1];
    if (tokenIndex >= 0 && opening?.name === "(") {
        const direct = findCallContextInMaskedText(document.masked, opening.end);
        if (direct?.openParenthesisOffset === opening.offset) return direct;
    }
    return current;
}

function compilerScalarStringDeclarationForHover(facts) {
    const initialization = facts?.scalarStringDeclaration;
    if (!initialization || initialization.provisional === true ||
        !["dim", "static", "field"].includes(initialization.kind) ||
        !Number.isSafeInteger(initialization.statement) || initialization.statement < 1 ||
        !Number.isSafeInteger(initialization.expression) || initialization.expression < 0) return null;
    return {
        statement: initialization.statement,
        expression: initialization.expression,
        kind: initialization.kind,
        initializerValue: isCompilerConstantValue(initialization.initializerValue)
            ? initialization.initializerValue : null,
        provisional: false
    };
}

function compilerStorageTypeForEditor(storage) {
    if (!storage || typeof storage.primitive !== "string" ||
        !Number.isSafeInteger(storage.storageBytes) || storage.storageBytes < 1 ||
        !Number.isSafeInteger(storage.pointerDepth) || storage.pointerDepth < 0 ||
        typeof storage.isReference !== "boolean") return null;
    const constBits = storage.constBits;
    if (constBits !== undefined && (typeof constBits !== "string" ||
        constBits.length !== storage.pointerDepth + 1 || !/^[01]+$/.test(constBits))) return null;
    return {
        primitive: storage.primitive,
        storageBytes: storage.storageBytes,
        pointerDepth: storage.pointerDepth,
        isReference: storage.isReference,
        ...(constBits !== undefined ? { constBits } : {})
    };
}

function compilerStorageTypeFactsForSymbols(model, symbols) {
    if (!Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
        symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const signatures = new Map();
    for (const symbol of new Set(symbols)) {
        const facts = model.compilerFactsBySemanticIdentity?.get(symbol);
        if (!facts) return null;
        const properties = (facts.properties || [])
            .filter((property) => ["array-elements", "natural-alignment", "packing-alignment"].includes(property.name) &&
                property.provisional !== true && typeof property.value === "string" && property.value.length <= 32)
            .map((property) => ({ name: property.name, value: property.value }))
            .sort((first, second) => first.name.localeCompare(second.name) || first.value.localeCompare(second.value));
        const storageType = compilerStorageTypeForEditor(facts.storageType);
        const stringDeclaration = compilerScalarStringDeclarationForHover(facts);
        const declarationInputs = Array.isArray(facts.declarationInputs) &&
            facts.declarationInputs.length <= MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS
            ? facts.declarationInputs
                .filter((input) => input.provisional !== true && Number.isSafeInteger(input.ordinal) && input.ordinal > 0 &&
                    Number.isSafeInteger(input.symbol) && input.symbol > 0 &&
                    ["as", "suffix", "implicit", "inferred"].includes(input.writtenType) &&
                    input.group && input.group.provisional !== true &&
                    Number.isSafeInteger(input.group.identity) && input.group.identity > 0 &&
                    Number.isSafeInteger(input.group.statement) && input.group.statement > 0 &&
                    Number.isSafeInteger(input.group.count) && input.group.count > 0 &&
                    ["dim", "static", "common", "extern", "const", "var"].includes(input.group.kind))
                .map((input) => ({
                    ordinal: input.ordinal,
                    symbol: input.symbol,
                    writtenType: input.writtenType,
                    group: {
                        identity: input.group.identity,
                        statement: input.group.statement,
                        kind: input.group.kind,
                        count: input.group.count,
                        provisional: false
                    },
                    provisional: false
                }))
            : [];
        const compilerFacts = {
            ...(storageType ? { storageType } : {}),
            ...(facts.arrayBounds ? { arrayBounds: facts.arrayBounds } : {}),
            ...(Number.isSafeInteger(facts.aggregateSizeBytes) && facts.aggregateSizeBytes > 0
                ? { aggregateSizeBytes: facts.aggregateSizeBytes } : {}),
            ...(stringDeclaration ? { scalarStringDeclaration: stringDeclaration } : {}),
            ...(declarationInputs.length ? { declarationInputs } : {}),
            properties
        };
        if (!storageType && !compilerFacts.arrayBounds && !compilerFacts.aggregateSizeBytes &&
            !compilerFacts.scalarStringDeclaration && !compilerFacts.declarationInputs && !properties.length) {
            return null;
        }
        signatures.set(JSON.stringify(compilerFacts), compilerFacts);
    }
    return signatures.size === 1 ? signatures.values().next().value : null;
}

function compilerSidecarOutlineFactsAtSites(model, uri, sites, checkCancelled) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(sites) ||
        sites.length > MAX_COMPILER_SIDECAR_OUTLINE_FACT_SITES) return [];
    const seenIndexes = new Set();
    const results = [];
    for (let index = 0; index < sites.length; index++) {
        if ((index & 63) === 0) checkCancelled();
        const site = sites[index];
        if (!site || !Number.isSafeInteger(site.index) || site.index < 0 || seenIndexes.has(site.index) ||
            !Number.isSafeInteger(site.line) || site.line < 0 ||
            !Number.isSafeInteger(site.startColumn) || site.startColumn < 0 ||
            !Number.isSafeInteger(site.endColumn) || site.endColumn <= site.startColumn) continue;
        seenIndexes.add(site.index);
        const siteUri = typeof site.filePath === "string"
            ? path.isAbsolute(site.filePath) && site.filePath.length <= 32768
                ? CompilerUri.file(site.filePath) : null
            : uri;
        if (!siteUri || !model.getDocument(siteUri)) continue;
        const position = { line: site.line, character: site.startColumn };
        const procedureRange = model.compilerProcedureDeclarationRangeAt?.(siteUri, position);
        const isProcedureSite = procedureRange?.line === site.line && procedureRange.startColumn === site.startColumn &&
            procedureRange.endColumn === site.endColumn;
        if (isProcedureSite) {
            const procedureSymbols = model.compilerProcedureDeclarationSymbolIdsAt?.(siteUri, position) || [];
            if (!procedureSymbols.length || procedureSymbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS) continue;
            const procedureFacts = compilerProcedureFactsForHover(model, procedureSymbols);
            const visibilityFacts = compilerProcedureVisibilityFactsForHover(model, procedureSymbols);
            const storageFacts = compilerStorageTypeFactsForSymbols(model, procedureSymbols);
            const compilerFacts = {
                ...(procedureFacts || {}),
                ...(visibilityFacts || {}),
                ...(storageFacts || {}),
                properties: [...(procedureFacts?.properties || []), ...(visibilityFacts?.properties || []),
                    ...(storageFacts?.properties || [])]
            };
            if (procedureFacts || visibilityFacts || storageFacts) results.push({ index: site.index, compilerFacts });
            continue;
        }
        const storageRange = model.compilerStorageTypeDeclarationRangeAt?.(siteUri, position);
        const fieldRange = model.compilerFieldDeclarationRangeAt?.(siteUri, position);
        const aggregateRange = model.compilerAggregateDeclarationRangeAt?.(siteUri, position);
        const enumRange = model.compilerEnumElementDeclarationRangeAt?.(siteUri, position);
        const isStorageSite = storageRange?.line === site.line && storageRange.startColumn === site.startColumn &&
            storageRange.endColumn === site.endColumn;
        const isFieldSite = fieldRange?.line === site.line && fieldRange.startColumn === site.startColumn &&
            fieldRange.endColumn === site.endColumn;
        const isAggregateSite = aggregateRange?.line === site.line && aggregateRange.startColumn === site.startColumn &&
            aggregateRange.endColumn === site.endColumn;
        const isEnumSite = enumRange?.line === site.line && enumRange.startColumn === site.startColumn &&
            enumRange.endColumn === site.endColumn;
        if (!isStorageSite && !isFieldSite && !isAggregateSite && !isEnumSite) continue;
        const storageSymbols = isStorageSite
            ? model.compilerStorageTypeDeclarationSymbolIdsAt?.(siteUri, position) || []
            : [];
        const storageClassSymbols = isStorageSite
            ? model.compilerStorageClassDeclarationSymbolIdsAt?.(siteUri, position) || []
            : [];
        const fieldSymbols = isFieldSite
            ? model.compilerFieldDeclarationSymbolIdsAt?.(siteUri, position) || []
            : [];
        const aggregateSymbols = isAggregateSite
            ? model.compilerAggregateDeclarationSymbolIdsAt?.(siteUri, position) || []
            : [];
        const enumSymbols = isEnumSite
            ? model.compilerEnumElementDeclarationSymbolIdsAt?.(siteUri, position) || []
            : [];
        if ((isFieldSite && !fieldSymbols.length) || (isAggregateSite && !aggregateSymbols.length) ||
            (isEnumSite && !enumSymbols.length) ||
            (!storageSymbols.length && !fieldSymbols.length && !aggregateSymbols.length && !enumSymbols.length) ||
            storageSymbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
            fieldSymbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
            aggregateSymbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
            enumSymbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS) continue;
        const symbolGroups = [storageSymbols, fieldSymbols, aggregateSymbols, enumSymbols]
            .filter((symbols) => symbols.length);
        const symbols = symbolGroups.at(-1) || [];
        const symbolGroupsAgree = symbolGroups.every((group) => {
            const symbolSet = new Set(symbols);
            return group.length === symbolSet.size && group.every((symbol) => symbolSet.has(symbol));
        });
        if (!symbolGroupsAgree) continue;
        let compilerFacts = compilerStorageTypeFactsForSymbols(model, symbols);
        const storageSymbolSet = new Set(storageSymbols);
        const storageClassAgrees = storageClassSymbols.length === storageSymbolSet.size &&
            storageClassSymbols.every((symbol) => storageSymbolSet.has(symbol));
        const compilerStorageClass = isStorageSite && storageClassAgrees
            ? compilerStorageClassForHover(model, storageClassSymbols)
            : null;
        if (compilerStorageClass) {
            compilerFacts = { ...(compilerFacts || {}), compilerStorageClass };
        }
        const fieldFacts = isFieldSite ? compilerFieldFactsForHover(model, fieldSymbols) : null;
        if (fieldFacts) {
            compilerFacts = {
                ...(compilerFacts || {}),
                ...fieldFacts,
                properties: [...(compilerFacts?.properties || []), ...(fieldFacts.properties || [])]
            };
        }
        const aggregateFacts = isAggregateSite
            ? compilerAggregateFactsForHover(model, aggregateSymbols, siteUri, position, checkCancelled)
            : null;
        if (aggregateFacts) {
            compilerFacts = {
                ...(compilerFacts || {}),
                ...aggregateFacts,
                properties: [...(compilerFacts?.properties || []), ...(aggregateFacts.properties || [])]
            };
        }
        const enumElementInput = isEnumSite ? compilerEnumElementFactsForHover(model, enumSymbols) : null;
        if (enumElementInput) compilerFacts = { ...(compilerFacts || {}), enumElementInput };
        const formalWrittenTypes = new Set(symbols.flatMap((symbol) =>
            model.compilerFactsBySemanticIdentity?.get(symbol)?.formalWrittenTypes || []
        ).filter((writtenType) => ["as", "suffix", "implicit", "vararg"].includes(writtenType)));
        if (compilerFacts && formalWrittenTypes.size === 1) {
            compilerFacts = { ...compilerFacts, formalWrittenTypes: [...formalWrittenTypes] };
        }
        const parameterFacts = compilerParameterFactsForHover(model, symbols);
        if (parameterFacts?.parameterPassing) {
            compilerFacts = {
                ...(compilerFacts || {}),
                ...parameterFacts,
                properties: [...(compilerFacts?.properties || []), ...(parameterFacts.properties || [])]
            };
        }
        if (compilerFacts?.storageType || compilerFacts?.arrayBounds || compilerFacts?.fieldLayout ||
            compilerFacts?.compilerStorageClass || compilerFacts?.compilerVisibility || compilerFacts?.aggregateSizeBytes !== undefined ||
            compilerFacts?.abstractMemberCount !== undefined || compilerFacts?.aggregateAccess ||
            compilerFacts?.baseType || compilerFacts?.enumElementInput || compilerFacts?.formalWrittenTypes?.length ||
            parameterFacts?.parameterPassing) {
            results.push({ index: site.index, compilerFacts });
        }
    }
    return results;
}

function compilerSidecarImplicitVariableInlayHints(model, uri, start, end, checkCancelled = () => {}) {
    const document = model.getDocument(uri);
    const filePath = uri.fsPath || uri.path;
    if (!model.semanticSidecarOnly || model.partial || !document || !filePath ||
        !start || !end || !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) ||
        !Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character) || start.line < 0 ||
        end.line < start.line || end.line >= document.lineOffsets.length) return [];

    if (Array.isArray(model.semanticDeclarations)) {
        return compilerSidecarImplicitDeclarationInlayHints(model, document, filePath, start, end, checkCancelled);
    }

    const hints = [];
    for (let line = start.line; line <= end.line; line++) {
        if (((line - start.line) & 127) === 0) checkCancelled();
        const lineStart = document.lineOffsets[line];
        const lineEnd = document.lineOffsets[line + 1] ?? document.text.length;
        const maskedLine = document.masked.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
        const assignment = /^(\s*)(let\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=|>)/i.exec(maskedLine);
        const compoundAssignment = assignment ? null : COMPILER_COMPOUND_ASSIGNMENT_TARGET.exec(maskedLine);
        const lsetRsetAssignment = assignment || compoundAssignment ? null : COMPILER_LSET_RSET_TARGET.exec(maskedLine);
        let targets;
        if (assignment) {
            const startColumn = assignment[1].length + (assignment[2]?.length || 0);
            targets = [{ startColumn, endColumn: startColumn + assignment[3].length, unresolvedOnly: false }];
        } else if (compoundAssignment && !/[$%!#&]$/.test(compoundAssignment[2])) {
            const startColumn = compoundAssignment[1].length;
            targets = [{ startColumn, endColumn: startColumn + compoundAssignment[2].length, unresolvedOnly: false }];
        } else if (lsetRsetAssignment) {
            const startColumn = lsetRsetAssignment[0].indexOf(lsetRsetAssignment[2]);
            targets = [{ startColumn, endColumn: startColumn + lsetRsetAssignment[2].length, unresolvedOnly: true }];
        } else {
            const loop = /^(\s*)for(\s+)([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)(.*)$/i.exec(maskedLine);
            if (loop && !/[$%!#&]$/.test(loop[3]) && /^\s*(?:=|\bin\b)/i.test(loop[4])) {
                const startColumn = loop[1].length + "for".length + loop[2].length;
                targets = [{ startColumn, endColumn: startColumn + loop[3].length, unresolvedOnly: false }];
            } else {
                targets = compilerSidecarInputReadTargets(maskedLine);
                if (!targets.length) targets = compilerSidecarSwapTargets(maskedLine);
                if (!targets.length) targets = compilerSidecarGetTargets(maskedLine);
            }
        }
        for (const target of targets) {
            const { startColumn, endColumn } = target;
            if ((line === start.line && endColumn < start.character) ||
                (line === end.line && startColumn > end.character)) continue;
            if (target.unresolvedOnly && /[$%!#&]$/.test(maskedLine.slice(startColumn, endColumn))) continue;
            if (target.unresolvedOnly && (!model.inner?.resolveAt ||
                model.inner.resolveAt(uri, line, startColumn).length > 0)) continue;

            const position = { line, character: startColumn };
            const typeSymbols = model.compilerStorageTypeDeclarationSymbolIdsAt?.(uri, position) || [];
            const storageSymbols = model.compilerStorageClassDeclarationSymbolIdsAt?.(uri, position) || [];
            if (typeSymbols.length !== 1 || storageSymbols.length !== 1 || typeSymbols[0] !== storageSymbols[0]) continue;
            const storageClass = compilerStorageClassForHover(model, storageSymbols);
            if (!["external", "static", "local", "shared", "global"].includes(storageClass)) continue;
            const facts = compilerStorageTypeFactsForSymbols(model, typeSymbols);
            const storageType = facts?.storageType;
            if (!storageType || storageType.isReference === true) continue;
            hints.push({
                name: maskedLine.slice(startColumn, endColumn),
                line,
                startColumn,
                endColumn,
                storageClass,
                position: { line, character: endColumn },
                storageType
            });
            if (hints.length > MAX_COMPILER_SIDECAR_IMPLICIT_VARIABLE_INLAY_HINTS) return [];
        }
    }
    return hints;
}

function compilerSidecarImplicitDeclarationInlayHints(model, document, filePath, start, end, checkCancelled) {
    let declarationsByFile = sidecarImplicitVariableDeclarationIndexes.get(model);
    if (!declarationsByFile) {
        const declarations = model.semanticDeclarations;
        if (declarations.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return [];
        declarationsByFile = new Map();
        for (let index = 0; index < declarations.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const declaration = declarations[index];
            if (declaration?.kind !== "implicit-variable" || declaration.physical !== true ||
                typeof declaration.filePath !== "string" || !path.isAbsolute(declaration.filePath) ||
                !Number.isSafeInteger(declaration.symbol) || declaration.symbol < 1 ||
                typeof declaration.name !== "string" || !declaration.name ||
                !Number.isSafeInteger(declaration.startLine) || declaration.startLine < 1 ||
                !Number.isSafeInteger(declaration.startColumn) || declaration.startColumn < 0 ||
                declaration.endLine !== declaration.startLine || !Number.isSafeInteger(declaration.endColumn) ||
                declaration.endColumn <= declaration.startColumn) continue;
            const key = compilerSidecarNavigationPathKey(declaration.filePath);
            const sites = declarationsByFile.get(key) || new Map();
            const siteKey = `${declaration.startLine}:${declaration.startColumn}:${declaration.endColumn}`;
            const site = sites.get(siteKey) || {
                line: declaration.startLine,
                startColumn: declaration.startColumn,
                endColumn: declaration.endColumn,
                names: new Set(),
                symbols: new Set()
            };
            site.names.add(declaration.name);
            site.symbols.add(declaration.symbol);
            sites.set(siteKey, site);
            declarationsByFile.set(key, sites);
        }
        sidecarImplicitVariableDeclarationIndexes.set(model, declarationsByFile);
    }

    const sites = declarationsByFile.get(compilerSidecarNavigationPathKey(filePath));
    if (!sites) return [];
    const hints = [];
    let visited = 0;
    for (const site of sites.values()) {
        if ((visited++ & 127) === 0) checkCancelled();
        const line = site.line - 1;
        const startColumn = site.startColumn;
        const endColumn = site.endColumn;
        if (line < start.line || line > end.line || line >= document.lineOffsets.length ||
            line === start.line && endColumn < start.character || line === end.line && startColumn > end.character ||
            site.names.size !== 1 || site.symbols.size > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS) continue;

        const lineStart = document.lineOffsets[line];
        const lineEnd = document.lineOffsets[line + 1] ?? document.text.length;
        const sourceLine = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
        if (endColumn > sourceLine.length) continue;
        const name = sourceLine.slice(startColumn, endColumn);
        const declarationName = site.names.values().next().value;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[$%!#&]$/.test(declarationName) ||
            normalizeIdentifier(name) !== normalizeIdentifier(declarationName)) continue;

        const symbols = [...site.symbols];
        const storageClass = compilerStorageClassForHover(model, symbols);
        if (!["external", "static", "local", "shared", "global"].includes(storageClass)) continue;
        const facts = compilerStorageTypeFactsForSymbols(model, symbols);
        const storageType = facts?.storageType;
        if (!storageType || storageType.isReference === true) continue;
        hints.push({
            name,
            line,
            startColumn,
            endColumn,
            storageClass,
            position: { line, character: endColumn },
            storageType
        });
        if (hints.length > MAX_COMPILER_SIDECAR_IMPLICIT_VARIABLE_INLAY_HINTS) return [];
    }
    return hints;
}

function compilerSidecarInputReadTargets(maskedLine) {
    const statement = /^(\s*)(line\s+input|input|read)\b(.*)$/i.exec(maskedLine);
    if (!statement) return [];
    const operation = statement[2];
    let targetStart = statement[1].length + operation.length;
    while (/\s/.test(maskedLine[targetStart] || "")) targetStart++;
    let targetList = maskedLine.slice(targetStart);

    if (/(?:^|\s)input$/i.test(operation)) {
        const fileHandle = /^#\s*(?:[A-Za-z_][A-Za-z0-9_]*[$%!#&]?|\d+)\s*,\s*/i.exec(targetList);
        if (fileHandle) {
            targetStart += fileHandle[0].length;
            targetList = maskedLine.slice(targetStart);
        }
    }
    const promptSeparator = targetList.indexOf(";");
    if (promptSeparator >= 0) {
        targetStart += promptSeparator + 1;
        targetList = maskedLine.slice(targetStart);
    }
    while (/^[\s;,]/.test(targetList)) {
        const removed = targetList.match(/^[\s;,]+/)[0];
        targetStart += removed.length;
        targetList = maskedLine.slice(targetStart);
    }
    targetList = targetList.replace(/\s+$/, "");
    targetList = targetList.replace(/\s+$/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*$/.test(targetList)) return [];

    const targets = [];
    let searchOffset = targetStart;
    for (const name of targetList.split(",").map((item) => item.trim())) {
        const startColumn = maskedLine.indexOf(name, searchOffset);
        if (startColumn < 0) return [];
        targets.push({ startColumn, endColumn: startColumn + name.length, unresolvedOnly: true });
        searchOffset = startColumn + name.length;
    }
    return targets;
}

function compilerSidecarSwapTargets(maskedLine) {
    const statement = /^(\s*)swap\b(.*)$/i.exec(maskedLine);
    if (!statement) return [];
    let targetStart = statement[1].length + "swap".length;
    while (/\s/.test(maskedLine[targetStart] || "")) targetStart++;
    const targetList = maskedLine.slice(targetStart).trimEnd();
    if (!/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?\s*,\s*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(targetList)) return [];

    const targets = [];
    let searchOffset = targetStart;
    for (const name of targetList.split(",").map((item) => item.trim())) {
        const startColumn = maskedLine.indexOf(name, searchOffset);
        if (startColumn < 0) return [];
        targets.push({ startColumn, endColumn: startColumn + name.length, unresolvedOnly: true });
        searchOffset = startColumn + name.length;
    }
    return targets;
}

function compilerSidecarGetTargets(maskedLine) {
    const statement = /^(\s*)get\b(.*)$/i.exec(maskedLine);
    if (!statement) return [];
    const statementStart = statement[1].length;
    const bodyStart = statement[0].length - statement[2].length;
    const separator = maskedLine.lastIndexOf(",");
    if (separator < bodyStart) return [];
    const targetText = maskedLine.slice(separator + 1);
    const target = /^\s*([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*$/.exec(targetText);
    if (!target) return [];
    const startColumn = separator + 1 + targetText.indexOf(target[1]);
    if (startColumn < bodyStart || startColumn <= statementStart) return [];
    return [{ startColumn, endColumn: startColumn + target[1].length, unresolvedOnly: true }];
}

function compilerSidecarOutlineMaskedVariableDeclarations(model, uri, checkCancelled = () => {}) {
    const document = model.getDocument(uri);
    if (!model.semanticSidecarOnly || model.partial || !document ||
        Buffer.byteLength(document.text, "utf8") > MAX_COMPILER_SIDECAR_OUTLINE_IMPLICIT_VARIABLE_BYTES) return [];
    const declarations = compilerSidecarPhysicalIdentifierEntries(model, uri, document, checkCancelled, { declarationsOnly: true });
    if (declarations.length > MAX_COMPILER_SIDECAR_OUTLINE_MASKED_DECLARATIONS) return [];
    return declarations.filter((record) => record.declaration).map((record) => record.entry);
}

function compilerSidecarOutlineImplicitVariables(model, uri, checkCancelled = () => {}) {
    const document = model.getDocument(uri);
    if (!model.semanticSidecarOnly || model.partial || !document ||
        Buffer.byteLength(document.text, "utf8") > MAX_COMPILER_SIDECAR_OUTLINE_IMPLICIT_VARIABLE_BYTES) return [];
    const end = positionAtOffset(document, document.text.length);
    return compilerSidecarImplicitVariableInlayHints(model, uri,
        { line: 0, character: 0 }, end, checkCancelled);
}

function compilerSidecarImplicitDeclarationTypeInlayHints(model, uri, start, end, checkCancelled = () => {}) {
    if (!model.semanticSidecarOnly || model.partial || !start || !end ||
        !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) ||
        !Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character) || start.line < 0 ||
        end.line < start.line) return [];
    const document = model.getDocument(uri);
    if (!document || end.line >= document.lineOffsets.length) return [];

    const hints = [];
    const declarations = parseFreeBasicText(document.text).declarations;
    for (let index = 0; index < declarations.length; index++) {
        if ((index & 255) === 0) checkCancelled();
        const declaration = declarations[index];
        const implicitVariableDeclaration = ["variable", "extern"].includes(declaration.type) &&
            !declaration.typeName && !declaration.initializer && !/[$%!#&]$/.test(declaration.name);
        const implicitRedimDeclaration = implicitVariableDeclaration &&
            /^\s*(?:(?:public|private|protected|shared|static|common|extern)\s+)*redim(?:\s+shared)?\b/i.test(
                maskFreeBasicText(declaration.signature || declaration.sourceLine || "")
            );
        const implicitParameterDeclaration = declaration.type === "parameter" &&
            !declaration.typeName && !/[$%!#&]$/.test(declaration.name);
        const implicitProcedureResultDeclaration = declaration.type === "function" &&
            !declaration.typeName && !/[$%!#&]$/.test(declaration.name);
        if ((!implicitVariableDeclaration && !implicitParameterDeclaration && !implicitProcedureResultDeclaration) ||
            declaration.line < start.line || declaration.line > end.line ||
            declaration.line === start.line && declaration.endColumn < start.character ||
            declaration.line === end.line && declaration.startColumn > end.character) continue;

        const position = { line: declaration.line, character: declaration.startColumn };
        let symbols;
        if (implicitVariableDeclaration) {
            symbols = model.compilerStorageTypeDeclarationSymbolIdsAt?.(uri, position) || [];
        } else if (implicitParameterDeclaration) {
            const parameterRange = model.compilerParameterDeclarationRangeAt?.(uri, position);
            if (parameterRange?.line !== declaration.line || parameterRange.startColumn !== declaration.startColumn ||
                parameterRange.endColumn !== declaration.endColumn) continue;
            symbols = model.compilerParameterDeclarationSymbolIdsAt?.(uri, position) || [];
        } else {
            const procedureRange = model.compilerProcedureDeclarationRangeAt?.(uri, position);
            if (procedureRange?.line !== declaration.line || procedureRange.startColumn !== declaration.startColumn ||
                procedureRange.endColumn !== declaration.endColumn) continue;
            symbols = model.compilerProcedureDeclarationSymbolIdsAt?.(uri, position) || [];
        }
        if (!symbols.length || symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
            implicitVariableDeclaration && symbols.length !== 1) continue;
        const facts = compilerStorageTypeFactsForSymbols(model, symbols);
        if (!facts?.storageType) continue;
        if (implicitVariableDeclaration) {
            if (!implicitRedimDeclaration) {
                const inputs = facts.declarationInputs;
                const input = Array.isArray(inputs) && inputs.length === 1 ? inputs[0] : null;
                const group = input?.group;
                if (!input || input.provisional !== false || input.writtenType !== "implicit" ||
                    !group || group.provisional !== false || !["dim", "static", "common", "extern"].includes(group.kind) ||
                    !Number.isSafeInteger(group.count) || group.count < 1 || !Number.isSafeInteger(input.ordinal) ||
                    input.ordinal < 1 || input.ordinal > group.count) continue;
            }
        } else if (implicitParameterDeclaration) {
            const writtenTypes = symbols.flatMap((symbol) =>
                model.compilerFactsBySemanticIdentity?.get(symbol)?.formalWrittenTypes || []
            );
            if (!writtenTypes.length || writtenTypes.some((writtenType) => writtenType !== "implicit")) continue;
        } else {
            const typingInputs = symbols.flatMap((symbol) =>
                model.compilerFactsBySemanticIdentity?.get(symbol)?.procedureTypingInputs || []
            );
            if (!typingInputs.length || typingInputs.some((input) => input.provisional === true ||
                input.kind !== declaration.type || input.resultForm !== "implicit")) continue;
        }
        hints.push({
            position: { line: declaration.line, character: declaration.endColumn },
            storageType: facts.storageType
        });
        if (hints.length > MAX_COMPILER_SIDECAR_IMPLICIT_DECLARATION_INLAY_HINTS) return [];
    }
    return hints;
}

function compilerEnumElementFactsForHover(model, symbols) {
    if (!Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
        symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const signatures = new Map();
    for (const symbol of new Set(symbols)) {
        const inputs = model.compilerFactsBySemanticIdentity?.get(symbol)?.enumElementInputs;
        if (!Array.isArray(inputs) || !inputs.length) return null;
        for (const input of inputs) {
            if (input.provisional === true || !Number.isSafeInteger(input.ordinal) || input.ordinal < 1 ||
                typeof input.explicit !== "boolean") return null;
            const fact = { explicit: input.explicit, ordinal: input.ordinal };
            signatures.set(JSON.stringify(fact), fact);
        }
    }
    return signatures.size === 1 ? signatures.values().next().value : null;
}

function compilerArrayStorageSelectionForHover(model, selection) {
    if (!selection || !["field", "variable"].includes(selection.kind) ||
        typeof selection.name !== "string" || !selection.name) return null;
    const compilerFacts = compilerStorageTypeFactsForSymbols(model, selection.symbolIds);
    return {
        kind: selection.kind,
        name: selection.name,
        ...(compilerFacts ? { compilerFacts } : {})
    };
}

function compilerFieldFactsForHover(model, symbols) {
    if (!Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
        symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const signatures = new Map();
    for (const symbol of new Set(symbols)) {
        const facts = model.compilerFactsBySemanticIdentity?.get(symbol);
        if (!facts) return null;
        const properties = (facts.properties || [])
            .filter((property) => ["bit-position", "bit-width"].includes(property.name) &&
                property.provisional !== true && typeof property.value === "string" && property.value.length <= 32)
            .map((property) => ({ name: property.name, value: property.value }))
            .sort((first, second) => first.name.localeCompare(second.name) || first.value.localeCompare(second.value));
        const fieldLayout = Number.isSafeInteger(facts.fieldLayout?.byteOffset) && facts.fieldLayout.byteOffset >= 0
            ? { byteOffset: facts.fieldLayout.byteOffset } : null;
        const storageType = compilerStorageTypeForEditor(facts.storageType);
        const scalarStringDeclaration = compilerScalarStringDeclarationForHover(facts);
        const compilerFacts = {
            ...(fieldLayout ? { fieldLayout } : {}),
            ...(storageType ? { storageType } : {}),
            ...(typeof facts.compilerVisibility === "string" ? { compilerVisibility: facts.compilerVisibility } : {}),
            ...(scalarStringDeclaration ? { scalarStringDeclaration } : {}),
            properties
        };
        if (!fieldLayout && !storageType && !compilerFacts.compilerVisibility &&
            !compilerFacts.scalarStringDeclaration && !properties.length) return null;
        signatures.set(JSON.stringify(compilerFacts), compilerFacts);
    }
    return signatures.size === 1 ? signatures.values().next().value : null;
}

function compilerSidecarBaseTypeIndex(model, checkCancelled) {
    let index = sidecarBaseTypeIndexes.get(model);
    if (index) return index;
    const baseTypes = model.semanticTypeBases;
    const bindings = model.semanticBindings;
    if (!Array.isArray(baseTypes) || baseTypes.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS ||
        !Array.isArray(bindings) || bindings.length > MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) return null;
    const basesBySymbol = new Map();
    const subtypesByBase = new Map();
    const referencesByFileLine = new Map();
    const typeSymbols = new Set((model.semanticTypeSymbols || [])
        .filter((symbol) => Number.isSafeInteger(symbol) && symbol > 0));
    const subtypesBySymbol = new Map();
    for (let offset = 0; offset < baseTypes.length; offset++) {
        if ((offset & 255) === 0) checkCancelled();
        const record = baseTypes[offset];
        if (!Number.isSafeInteger(record?.symbol) || record.symbol < 1 ||
            !Number.isSafeInteger(record?.base) || record.base < 1) continue;
        const bases = basesBySymbol.get(record.symbol) || new Set();
        bases.add(record.base);
        basesBySymbol.set(record.symbol, bases);
        const subtypes = subtypesByBase.get(record.base) || new Set();
        subtypes.add(record.symbol);
        subtypesByBase.set(record.base, subtypes);
    }
    if (Array.isArray(model.semanticSymbolTypes) &&
        model.semanticSymbolTypes.length <= MAX_COMPILER_SIDECAR_NAVIGATION_BINDINGS) {
        for (let offset = 0; offset < model.semanticSymbolTypes.length; offset++) {
            if ((offset & 255) === 0) checkCancelled();
            const record = model.semanticSymbolTypes[offset];
            if (!Number.isSafeInteger(record?.symbol) || record.symbol < 1 ||
                !Number.isSafeInteger(record?.subtype) || record.subtype < 1) continue;
            const subtypes = subtypesBySymbol.get(record.symbol) || new Set();
            subtypes.add(record.subtype);
            subtypesBySymbol.set(record.symbol, subtypes);
        }
    }
    for (let offset = 0; offset < bindings.length; offset++) {
        if ((offset & 255) === 0) checkCancelled();
        const binding = bindings[offset];
        if (binding.role !== "reference" || binding.physical !== true ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath) ||
            !Number.isSafeInteger(binding.startLine) || binding.startLine < 1) continue;
        const key = `${compilerSidecarNavigationPathKey(binding.filePath)}:${binding.startLine}`;
        const references = referencesByFileLine.get(key) || [];
        references.push(binding);
        referencesByFileLine.set(key, references);
    }
    index = { basesBySymbol, subtypesByBase, referencesByFileLine, typeSymbols, subtypesBySymbol };
    sidecarBaseTypeIndexes.set(model, index);
    return index;
}

function compilerSidecarBaseTypeForHover(model, symbols, uri, position, checkCancelled) {
    if (!model.semanticSidecarOnly || model.partial || !Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS || !position || !uri) return "";
    const source = model.getDocument(uri);
    if (!source || Buffer.byteLength(source.text, "utf8") > MAX_COMPILER_SIDECAR_NAVIGATION_SOURCE_BYTES) return "";
    const declarations = parseFreeBasicText(source.text).declarations || [];
    if (declarations.length > MAX_COMPILER_SIDECAR_NAVIGATION_DECLARATIONS) return "";
    const candidates = declarations.filter((declaration) =>
        ["type", "class", "union"].includes(declaration.type) && declaration.line === position.line &&
        Number.isSafeInteger(declaration.startColumn) && Number.isSafeInteger(declaration.endColumn) &&
        position.character >= declaration.startColumn && position.character < declaration.endColumn
    );
    if (candidates.length !== 1) return "";
    const baseType = String(candidates[0].baseType || "");
    if (!baseType || baseType.length > 512 || /[\r\n\x00]/.test(baseType)) return "";

    const baseTypeIndex = compilerSidecarBaseTypeIndex(model, checkCancelled);
    if (!baseTypeIndex) return "";
    let selectedBase = 0;
    for (const symbol of new Set(symbols)) {
        checkCancelled();
        const bases = baseTypeIndex.basesBySymbol.get(symbol);
        if (!bases || bases.size !== 1) return "";
        const base = bases.values().next().value;
        if (selectedBase && selectedBase !== base) return "";
        selectedBase = base;
    }
    if (!selectedBase) return "";

    const lineStart = source.lineOffsets[position.line];
    const lineEnd = source.lineOffsets[position.line + 1] ?? source.text.length;
    const lineText = source.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
    const maskedLine = maskFreeBasicText(lineText).toLowerCase();
    const extendsStart = maskedLine.indexOf("extends", candidates[0].startColumn);
    const baseStart = extendsStart < 0
        ? -1
        : maskedLine.indexOf(baseType.toLowerCase(), extendsStart + "extends".length);
    const baseEnd = baseStart < 0 ? -1 : baseStart + baseType.length;
    if (baseStart < 0 || baseEnd > lineText.length) return "";

    const references = baseTypeIndex.referencesByFileLine.get(
        `${compilerSidecarNavigationPathKey(source.uri.fsPath || source.uri.path)}:${position.line + 1}`
    ) || [];
    const matchingRanges = new Set();
    const terminalName = normalizeIdentifier(baseType.split(".").at(-1));
    for (const binding of references) {
        if (binding.symbol !== selectedBase) continue;
        const matched = semanticBindingToken(source, binding);
        if (!matched || matched.token.line !== position.line || matched.start < lineStart + baseStart ||
            matched.end > lineStart + baseEnd || normalizeIdentifier(matched.token.name) !== terminalName) continue;
        matchingRanges.add(`${matched.token.startColumn}:${matched.token.endColumn}`);
    }
    return matchingRanges.size === 1 ? baseType : "";
}

function compilerAggregateFactsForHover(model, symbols, uri = null, position = null, checkCancelled = () => {}) {
    if (!Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
        symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const signatures = new Map();
    const sidecarBaseType = compilerSidecarBaseTypeForHover(model, symbols, uri, position, checkCancelled);
    for (const symbol of new Set(symbols)) {
        const facts = model.compilerFactsBySemanticIdentity?.get(symbol);
        if (!facts) return null;
        const properties = (facts.properties || [])
            .filter((property) => ["natural-alignment", "packing-alignment"].includes(property.name) &&
                property.provisional !== true && typeof property.value === "string" && property.value.length <= 32)
            .map((property) => ({ name: property.name, value: property.value }))
            .sort((first, second) => first.name.localeCompare(second.name) || first.value.localeCompare(second.value));
        const access = facts.aggregateAccess;
        const aggregateAccess = access && Number.isSafeInteger(access.bodyStatement) && access.bodyStatement > 0 &&
            Number.isSafeInteger(access.count) && access.count > 0 &&
            access.count <= MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS &&
            Array.isArray(access.sections) && access.sections.length === access.count &&
            access.sections.every((section, index) => section.ordinal === index + 1 &&
                Number.isSafeInteger(section.statement) && section.statement > 0 &&
                ["public", "private", "protected"].includes(section.visibility))
            ? {
                bodyStatement: access.bodyStatement,
                count: access.count,
                sections: access.sections.map((section) => ({
                    ordinal: section.ordinal,
                    statement: section.statement,
                    visibility: section.visibility
                }))
            }
            : null;
        const compilerFacts = {
            ...(sidecarBaseType ? { baseType: sidecarBaseType } : {}),
            ...(Number.isSafeInteger(facts.aggregateSizeBytes) && facts.aggregateSizeBytes > 0
                ? { aggregateSizeBytes: facts.aggregateSizeBytes } : {}),
            ...(Number.isSafeInteger(facts.abstractMemberCount) && facts.abstractMemberCount >= 0
                ? { abstractMemberCount: facts.abstractMemberCount } : {}),
            ...(aggregateAccess ? { aggregateAccess } : {}),
            properties
        };
        if (!Number.isSafeInteger(compilerFacts.aggregateSizeBytes) &&
            !Number.isSafeInteger(compilerFacts.abstractMemberCount) && !compilerFacts.aggregateAccess &&
            !compilerFacts.baseType && !properties.length) return null;
        signatures.set(JSON.stringify(compilerFacts), compilerFacts);
    }
    return signatures.size === 1 ? signatures.values().next().value : null;
}

function compilerParameterFactsForHover(model, symbols) {
    if (!Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
        symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const signatures = new Map();
    let allDirectSourceWrites = true;
    for (const symbol of new Set(symbols)) {
        const facts = model.compilerFactsBySemanticIdentity?.get(symbol);
        const parameter = facts?.parameterPassing;
        if (!parameter || typeof parameter.mode !== "string" ||
            !Number.isSafeInteger(parameter.dimensions) || typeof parameter.optional !== "boolean" ||
            typeof parameter.receiver !== "boolean") return null;
        allDirectSourceWrites &&= facts.parameterDirectSourceWrite === true;
        const properties = (facts.properties || [])
            .filter((property) => property.name === "formal-written-mode" && property.provisional !== true &&
                /^(?:0|1)$/.test(property.value))
            .map((property) => ({ name: property.name, value: property.value }))
            .sort((first, second) => first.value.localeCompare(second.value));
        const storageType = compilerStorageTypeForEditor(facts.storageType);
        const formalWrittenTypes = [...new Set((facts.formalWrittenTypes || [])
            .filter((writtenType) => ["as", "suffix", "implicit", "vararg"].includes(writtenType)))].sort();
        const compilerFacts = {
            parameterPassing: {
                mode: parameter.mode,
                dimensions: parameter.dimensions,
                optional: parameter.optional,
                receiver: parameter.receiver
            },
            properties,
            ...(storageType ? { storageType } : {}),
            ...(formalWrittenTypes.length ? { formalWrittenTypes } : {})
        };
        signatures.set(JSON.stringify(compilerFacts), compilerFacts);
    }
    if (signatures.size !== 1) return null;
    return { ...signatures.values().next().value,
        ...(allDirectSourceWrites ? { parameterDirectSourceWrite: true } : {}) };
}

function compilerProcedureFactsForHover(model, symbols) {
    if (!Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
        symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const signatures = new Map();
    const uniqueSymbols = new Set(symbols);
    for (const symbol of uniqueSymbols) {
        const facts = model.compilerFactsBySemanticIdentity?.get(symbol);
        if (!facts || typeof facts.procedureCallingConvention !== "string" ||
            typeof facts.procedureReturnsByReference !== "boolean") return null;
        const properties = (facts.properties || [])
            .filter((property) => ["procedure-linkage", "written-override"].includes(property.name) &&
                property.provisional !== true && typeof property.value === "string" &&
                property.value.length <= 32 &&
                (property.name !== "written-override" || /^(?:0|1)$/.test(property.value)))
            .map((property) => ({ name: property.name, value: property.value }))
            .sort((first, second) => first.name.localeCompare(second.name) || first.value.localeCompare(second.value));
        const override = facts.overriddenProcedure;
        let overriddenProcedure = override && typeof override.qualifiedName === "string" &&
            override.qualifiedName.length > 0 && override.qualifiedName.length <= 512 &&
            !/[\r\n]/.test(override.qualifiedName)
            ? {
                ...(Number.isSafeInteger(override.compilerSymbolId) && override.compilerSymbolId > 0
                    ? { compilerSymbolId: override.compilerSymbolId } : {}),
                qualifiedName: override.qualifiedName
            }
            : null;
        const targets = model.compilerProcedureOverrideTargetsBySemanticIdentity?.get(symbol);
        if (!overriddenProcedure && targets?.size === 1) {
            const compilerSymbolId = targets.values().next().value;
            if (Number.isSafeInteger(compilerSymbolId) && compilerSymbolId > 0) {
                overriddenProcedure = { compilerSymbolId };
            }
        }
        const procedureAbiPolicyInputs = (facts.procedureAbiPolicyInputs || [])
            .filter((policy) => policy.provisional !== true && typeof policy.writtenConvention === "boolean" &&
                typeof policy.managedString === "boolean")
            .map((policy) => ({
                // Refactors need the selected header's statement identity.
                // Ambiguous overload hovers still compare common ABI facts
                // without treating distinct source statements as disagreement.
                ...(uniqueSymbols.size === 1 && Number.isSafeInteger(policy.statement) && policy.statement > 0
                    ? { statement: policy.statement } : {}),
                writtenConvention: policy.writtenConvention,
                managedString: policy.managedString,
                provisional: false
            }))
            .sort((first, second) => Number(first.writtenConvention) - Number(second.writtenConvention) ||
                Number(first.managedString) - Number(second.managedString));
        const compilerFacts = {
            procedureCallingConvention: facts.procedureCallingConvention,
            procedureReturnsByReference: facts.procedureReturnsByReference,
            properties,
            procedureAbiPolicyInputs,
            ...(overriddenProcedure ? { overriddenProcedure } : {})
        };
        signatures.set(JSON.stringify(compilerFacts), compilerFacts);
    }
    return signatures.size === 1 ? signatures.values().next().value : null;
}

function compilerProcedureVisibilityFactsForHover(model, symbols) {
    if (!Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
        symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const signatures = new Map();
    for (const symbol of new Set(symbols)) {
        const facts = model.compilerFactsBySemanticIdentity?.get(symbol);
        if (!facts || !["public", "private", "protected"].includes(facts.compilerVisibility)) return null;
        const procedureWrittenVisibility = (facts.procedureWrittenVisibility || [])
            .filter((input) => Number.isSafeInteger(input.statement) && input.statement > 0 &&
                ["default", "public", "private"].includes(input.visibility) && typeof input.provisional === "boolean")
            .map((input) => ({
                statement: input.statement,
                visibility: input.visibility,
                provisional: input.provisional
            }))
            .sort((first, second) => first.statement - second.statement || first.visibility.localeCompare(second.visibility));
        const procedureTypingInputs = (facts.procedureTypingInputs || [])
            .filter((input) => Number.isSafeInteger(input.statement) && input.statement > 0 &&
                ["prototype", "definition"].includes(input.role) &&
                ["sub", "function", "property", "operator", "constructor", "destructor"].includes(input.kind) &&
                ["none", "as", "suffix", "implicit", "special"].includes(input.resultForm) &&
                typeof input.provisional === "boolean")
            .map((input) => ({
                statement: input.statement,
                role: input.role,
                kind: input.kind,
                resultForm: input.resultForm,
                provisional: input.provisional
            }))
            .sort((first, second) => first.statement - second.statement || first.role.localeCompare(second.role));
        const compilerFacts = { compilerVisibility: facts.compilerVisibility, procedureWrittenVisibility, procedureTypingInputs };
        signatures.set(JSON.stringify(compilerFacts), compilerFacts);
    }
    return signatures.size === 1 ? signatures.values().next().value : null;
}

function compilerStorageClassForHover(model, symbols) {
    if (!Array.isArray(symbols) || !symbols.length ||
        symbols.length > MAX_COMPILER_SEMANTIC_SYMBOL_CONTEXTS ||
        symbols.some((symbol) => !Number.isSafeInteger(symbol) || symbol < 1)) return null;
    const classes = new Set();
    for (const symbol of new Set(symbols)) {
        const storage = model.compilerFactsBySemanticIdentity?.get(symbol)?.compilerStorageClass;
        if (!["external", "static", "local", "shared", "global", "thread-local"].includes(storage)) return null;
        classes.add(storage);
    }
    return classes.size === 1 ? classes.values().next().value : null;
}

/* FBC's display spelling preserves nested callback/array types but deliberately
   omits parameter names and defaults. This is presentation, not type inference
   or a claim about which procedure the pointer will call at runtime. */
function procedurePointerSignature(name, typeName, expressionName = false) {
    /* Bound a generated type before scanning nesting or copying UI labels. */
    if (typeof name !== "string" || name.length > (expressionName ? MAX_SIGNATURE_CALLEE_LABEL_CHARACTERS : MAX_SIGNATURE_CALLEE_CHARACTERS) ||
        /[\x00-\x1f\x7f]/.test(name) || !expressionName && !/^[A-Za-z_][A-Za-z0-9_.$%!#&]*$/.test(name) ||
        typeof typeName !== "string" || typeName.length > MAX_PROCEDURE_POINTER_TYPE_CHARACTERS || /[\r\n\0]/.test(typeName)) return null;
    const head = /^(?:const\s+)?(function|sub)(?:\s+(cdecl|stdcall|pascal|thiscall|fastcall))?\s*\(/i.exec(typeName);
    if (!head) return null;
    const opening = head[0].length - 1;
    let depth = 1, closing = opening + 1;
    for (; closing < typeName.length && depth; closing++) {
        if (typeName[closing] === "(") depth++;
        else if (typeName[closing] === ")") depth--;
        if (depth > MAX_PROCEDURE_POINTER_TYPE_NESTING) return null;
    }
    if (depth !== 0) return null;
    closing--;
    const kind = head[1].toLowerCase();
    const tail = typeName.slice(closing + 1);
    if (kind === "sub" ? tail.trim() !== "" : !/^\s+(?:byref\s+)?as\s+\S/i.test(tail)) return null;
    const parameters = parseParameters(typeName.slice(opening + 1, closing));
    if (parameters.length > MAX_PROCEDURE_POINTER_PARAMETERS || parameters.some((parameter) =>
        !parameter.label || !parameter.variadic && !parameter.typeName)) return null;
    const prefix = `${kind === "function" ? "Function" : "Sub"} ${name}${head[2] ? ` ${head[2]}` : ""}(`;
    /* Anonymous types repeat, including inside nested callback prototypes.
       VS Code label offsets identify the actual parameter occurrence. */
    let labelOffset = prefix.length;
    for (const parameter of parameters) {
        parameter.labelOffsets = [labelOffset, labelOffset + parameter.label.length];
        labelOffset += parameter.label.length + ", ".length;
    }
    return {
        name,
        kind,
        signature: `${prefix}${parameters.map((parameter) => parameter.label).join(", ")})${tail}`,
        parameters
    };
}

function compilerVisibleSignatureEntries(model, uri, call, checkCancelled, selectedTarget = 0) {
    if (model.semanticSidecarOnly || !model.inventory || call?.kind !== "identifier") return [];
    const key = normalizeIdentifier(call.name);
    const usable = (entry) => entry.nativeSymbol && !entry.provisional && !entry.declaration.provisional &&
        (CALLABLE_TYPES.has(entry.declaration.type) ||
            ["variable", "field", "parameter", "const", "extern", "type", "class", "union"].includes(entry.declaration.type));
    const members = selectedTarget ? null : model.completeMembers(uri, call.line, call.endColumn, true);
    if (members !== null) {
        const entries = members.filter((entry) => entry.key === key);
        return entries.length <= MAX_SIGNATURE_RECOVERY_CANDIDATES && entries.every(usable) ? entries : [];
    }
    /* The exact-name lookup applies native shadowing before its result limit,
       so a large module cannot hide this callee behind unrelated names. */
    const visible = selectedTarget
        ? (model.inventory.entriesBySymbol.get(selectedTarget) || []).filter((entry) => entry.key === key && usable(entry))
        : model.visibleEntries(uri, call.line, call.endColumn, MAX_SIGNATURE_RECOVERY_CANDIDATES, call.name);
    if (!visible.length || visible.length > MAX_SIGNATURE_RECOVERY_CANDIDATES || !visible.every(usable)) return [];
    if (visible.some((entry) => !CALLABLE_TYPES.has(entry.declaration.type))) return visible;
    const positions = model.projectPositions(uri, call.line, call.endColumn, false, true);
    if (!positions.length || positions.length > MAX_SIGNATURE_RECOVERY_CANDIDATES) return [];
    const expanded = model.inner.getDocument(model.expandedUri);
    const contexts = positions.map((position) => {
        const character = Math.min(position.character, position.token?.endColumn ?? position.character);
        const offset = positionOffset(expanded, position.line, character);
        return { offset, scope: scopeAt(expanded, offset) };
    });
    /* Completion intentionally folds overloads into one item. Expand only its
       proven native owner, checking each overload's access and declaration
       order in every projected caller context. Without a committed call target,
       imported name ambiguity does not identify an overload family. */
    if (!selectedTarget) {
        for (const context of contexts) {
            checkCancelled();
            const owners = new Set(model.inner.resolveName(expanded, call.name, context.scope, context.offset)
                .filter((entry) => usable(entry) && CALLABLE_TYPES.has(entry.declaration.type) &&
                    entry.offset <= context.offset && model.nativeAccess(entry, context.scope))
                .map((entry) => entry.nativeSymbol.owner));
            if (owners.size > 1) return [];
        }
    }
    const entries = new Map();
    for (const representative of visible) for (const entry of model.inventory.entriesByOwner.get(representative.nativeSymbol.owner) || []) {
        checkCancelled();
        if (entry.key !== key || !usable(entry) || !CALLABLE_TYPES.has(entry.declaration.type) ||
            !contexts.every((context) => entry.offset <= context.offset && model.nativeAccess(entry, context.scope))) continue;
        const previous = entries.get(entry.compilerSymbolId);
        if (!previous || entry.declaration.modifiers.includes("DECLARE")) entries.set(entry.compilerSymbolId, entry);
        if (entries.size > MAX_SIGNATURE_RECOVERY_CANDIDATES) return [];
    }
    return [...entries.values()];
}

function compilerProcedurePointerSignature(model, uri, document, context, call, resolved, checkCancelled) {
    if (!call || call.kind !== "identifier") return null;
    let types;
    if (model.semanticSidecarOnly) {
        const selection = compilerSidecarNavigationSelection(model, uri, document,
            { line: call.line, character: call.startColumn }, checkCancelled);
        const typeName = selection?.symbol && model.compilerProcedurePointerTypesBySymbol?.get(selection.symbol);
        types = typeName ? [typeName] : [];
    } else {
        const candidates = resolved;
        if (!candidates.length || candidates.length > 64 || candidates.some((entry) =>
            entry.provisional || entry.declaration?.provisional ||
            !["variable", "field", "parameter", "const", "extern"].includes(entry.declaration?.type) ||
            model.inventory?.shapes?.get(entry.nativeSymbol?.id)?.dimensions !== 0)) return null;
        types = candidates.map((entry) => entry.nativeSymbol?.typeName || "");
    }
    const unique = new Set(types);
    return unique.size === 1 ? procedurePointerSignature(context.name, unique.values().next().value) : null;
}

function compilerArrayIndexSignature(model, uri, document, context, call, resolved, checkCancelled) {
    if (context.bare || !call || call.kind !== "identifier") return null;
    let bounds;
    if (model.semanticSidecarOnly) {
        const selection = compilerSidecarNavigationSelection(model, uri, document,
            { line: call.line, character: call.startColumn }, checkCancelled);
        const facts = selection?.symbol && model.compilerFactsBySemanticIdentity?.get(selection.symbol);
        bounds = facts?.arrayBounds;
        /* Descriptor parameters have no declaration bounds. Their native
           passing mode still distinguishes an array from a scalar callback. */
        if (!bounds && facts?.parameterPassing?.mode === "bydesc") {
            const dimensions = facts.parameterPassing.dimensions;
            if (Number.isSafeInteger(dimensions) && (dimensions === -1 || dimensions > 0)) {
                bounds = { mode: "runtime", rank: dimensions > 0 ? dimensions : null, dimensions: [] };
            }
        }
    } else {
        if (!resolved.length || resolved.length > MAX_SIGNATURE_RECOVERY_CANDIDATES || resolved.some((entry) =>
            entry.provisional || entry.declaration.provisional ||
            !["variable", "field", "parameter", "extern"].includes(entry.declaration.type))) return null;
        const candidates = new Map();
        for (const entry of resolved) {
            const id = entry.compilerSymbolId || entry.nativeSymbol?.id;
            const facts = model.compilerFactsByNativeSymbolId?.get(id)?.arrayBounds;
            const dimensions = model.inventory?.shapes.get(entry.nativeSymbol?.id)?.dimensions;
            // A lightweight bridge snapshot can prove rank without bounds.
            // Do not read source declarations to fill that metadata gap.
            const observed = facts || (Number.isSafeInteger(dimensions) && (dimensions === -1 || dimensions > 0)
                ? { mode: "runtime", rank: dimensions > 0 ? dimensions : null, dimensions: [] } : null);
            if (!observed) return null;
            candidates.set(JSON.stringify(observed), observed);
        }
        if (candidates.size !== 1) return null;
        bounds = candidates.values().next().value;
    }
    if (!bounds || !["bounds", "runtime"].includes(bounds.mode) ||
        bounds.rank !== null && (!Number.isSafeInteger(bounds.rank) || bounds.rank < 1 || bounds.rank > MAX_ARRAY_SIGNATURE_DIMENSIONS)) return null;
    if (bounds.mode === "bounds" && (!Array.isArray(bounds.dimensions) || bounds.dimensions.length !== bounds.rank)) return null;
    const parameters = [];
    const prefix = `Array ${context.name}(`;
    let labelOffset = prefix.length;
    for (let index = 0; index < (bounds.rank || 1); index++) {
        const dimension = bounds.mode === "bounds" ? bounds.dimensions[index] : null;
        if (dimension && (!Number.isSafeInteger(dimension.lower) ||
            dimension.upper !== null && !Number.isSafeInteger(dimension.upper))) return null;
        const label = bounds.rank === null ? "indices..." : dimension
            ? `index${index + 1}: ${dimension.lower} To ${dimension.upper === null ? "?" : dimension.upper}`
            : `index${index + 1}`;
        parameters.push({ label, labelOffsets: [labelOffset, labelOffset + label.length],
            documentation: dimension ? "Compiler-selected bounds for this dimension."
                : "Array bounds are not available in this compiler snapshot.", ...(bounds.rank === null ? { variadic: true } : {}) });
        labelOffset += label.length + 2;
    }
    return { name: context.name, kind: "array", signature: `${prefix}${parameters.map((parameter) => parameter.label).join(", ")})`, parameters };
}

function signatureMemberToken(document, context) {
    let end = context.calleeEndOffset ?? context.openParenthesisOffset;
    if (!Number.isSafeInteger(end) || end < 1 || end > context.openParenthesisOffset || end > document.text.length) return null;
    while (end > 0 && /\s/.test(document.masked[end - 1])) end--;
    const call = document.tokens.find((token) => token.end === end && token.kind === "identifier");
    if (!call || ![".", "->"].includes(document.tokens[call.index - 1]?.name)) return null;
    return call;
}

function compilerMemberMethodName(model, uri, document, context, checkCancelled) {
    // Only a native selection or accessible native member family can route
    // a compound receiver to ordinary method help, not its source spelling.
    const call = signatureMemberToken(document, context);
    if (!call) return null;
    if (model.semanticSidecarOnly) {
        const selection = compilerSidecarNavigationSelection(model, uri, document,
            { line: call.line, character: call.startColumn }, checkCancelled);
        return ["function", "sub", "property-get", "property-set"].includes(
            model.compilerProcedureKindsBySemanticIdentity?.get(selection?.symbol)) ? call.name : null;
    }
    if (!model.inventory) return null;
    const entries = (model.completeMembers?.(uri, call.line, call.endColumn, true) || []).filter((entry) => entry.key === call.key);
    return entries.length && entries.every((entry) => entry.nativeSymbol && !entry.provisional && !entry.declaration.provisional &&
        ["function", "sub", "property"].includes(entry.declaration.type)) ? call.name : null;
}

function compilerExpressionArrayIndexSignature(model, uri, document, context, checkCancelled) {
    const call = signatureMemberToken(document, context);
    if (!call) return null;
    let entries = [];
    if (!model.semanticSidecarOnly) {
        entries = model.resolveAt(uri, call.line, call.startColumn);
        if (!entries.length && model.inventory) {
            // A broken index list can lose its binding while native member
            // completion still proves the accessible field and array shape.
            entries = (model.completeMembers(uri, call.line, call.endColumn) || [])
                .filter((entry) => entry.key === call.key && entry.declaration.type === "field");
        }
    }
    return compilerArrayIndexSignature(model, uri, document, { ...context, name: call.name }, call, entries, checkCancelled);
}

function expressionPointerSignature(label, typeName) {
    const name = label.length <= MAX_SIGNATURE_CALLEE_LABEL_CHARACTERS && !/[\x00-\x1f\x7f]/.test(label)
        ? label : "<expression>";
    return procedurePointerSignature(name, typeName, true);
}

function signatureOpeningParenthesis(document, end) {
    let depth = 0;
    const first = Math.max(0, end - MAX_SIGNATURE_CALLEE_CHARACTERS);
    for (let offset = end - 1; offset >= first; offset--) {
        if (document.masked[offset] === ")") depth++;
        else if (document.masked[offset] === "(" && --depth === 0) return offset;
    }
    return -1;
}

function recoveredExpressionPointerSignature(model, uri, document, context, checkCancelled) {
    // This is a signature-only projection of native declarations, not a valid
    // expression receipt, editable binding, or a guessed indirect-call target.
    // Semantic-only producers do not use the bridge's private dtype layout.
    if (model.semanticSidecarOnly || !model.inventory ||
        model.compilerSemanticModelCompilerVersion && !/^1\.20\.5(?:$|[-+])/.test(model.compilerSemanticModelCompilerVersion)) return null;
    const end = context.calleeEndOffset;
    if (document.masked[end - 1] !== ")") {
        const call = document.tokens.find((token) => token.end === end && token.kind === "identifier");
        if (!call || ![".", "->"].includes(document.tokens[call.index - 1]?.name)) return null;
        // Native member-completion receipts can survive an invalid outer
        // call even when no complete receiver expression was retained.
        // They prove an accessible field type, never an indirect target.
        const members = model.completeMembers(uri, call.line, call.endColumn);
        const entries = (members || []).filter((entry) => entry.key === call.key && entry.declaration.type === "field");
        return compilerProcedurePointerSignature(model, uri, document,
            { ...context, name: call.name }, call, entries, checkCancelled);
    }
    const opening = signatureOpeningParenthesis(document, end);
    if (opening < 0) return null;
    let before = opening;
    while (before > 0 && /[ \t]/.test(document.masked[before - 1])) before--;
    let call = document.tokens.find((token) => token.offset <= before - 1 && token.end > before - 1 && token.kind === "identifier");
    let kind = "postfix", dereferences = 0, labelStart = call?.offset;
    let entries = call ? model.resolveAt(uri, call.line, call.startColumn) : [];
    if (call && !entries.length) entries = compilerVisibleSignatureEntries(model, uri, call, checkCancelled);
    // PRINT followed by a grouped pointer is not a factory named PRINT.
    // Native lookup, not the source spelling, decides whether a prefix binds.
    if (!entries.length) call = null;
    if (!call) {
        const body = document.masked.slice(opening + 1, end - 1);
        const leaf = /^[ \t]*(\**)[ \t]*([A-Za-z_][A-Za-z0-9_.$%!#&]*)[ \t]*$/.exec(body);
        if (!leaf) return null;
        const last = opening + 1 + body.lastIndexOf(leaf[2]) + leaf[2].length - 1;
        call = document.tokens.find((token) => token.offset <= last && token.end > last && token.kind === "identifier");
        if (!call) return null;
        kind = "group";
        dereferences = leaf[1].length;
        labelStart = opening;
    }
    if (kind === "group") {
        entries = model.resolveAt(uri, call.line, call.startColumn);
        if (!entries.length) entries = compilerVisibleSignatureEntries(model, uri, call, checkCancelled);
    }
    if (!entries.length || entries.length > MAX_SIGNATURE_RECOVERY_CANDIDATES) return null;
    const indices = kind === "postfix"
        ? freeBasicCallArgumentRanges(document, { end: opening + 1 }, checkCancelled, MAX_SIGNATURE_CALLEE_CHARACTERS)
        : null;
    const signatures = new Map();
    for (const entry of entries) {
        checkCancelled();
        const symbol = entry.nativeSymbol, shape = model.inventory.shapes.get(symbol?.id);
        if (!symbol || !shape || entry.provisional || entry.declaration.provisional ||
            !Number.isSafeInteger(symbol.dtype)) return null;
        const depth = (symbol.dtype & BRIDGE_DTYPE_POINTER_MASK) >>> BRIDGE_DTYPE_POINTER_SHIFT;
        const value = ["variable", "field", "parameter", "const", "extern"].includes(entry.declaration.type);
        if (kind === "postfix") {
            const array = value && Number.isSafeInteger(shape.dimensions) && shape.dimensions !== 0;
            const factory = entry.declaration.type === "function" && shape.dimensions === 0;
            if ((!array && !factory) || depth !== 1 || array && (indices?.exceeded || !indices?.arguments?.length ||
                indices.arguments.some((argument) => !argument || argument.named) ||
                shape.dimensions > 0 && shape.dimensions !== indices.arguments.length)) return null;
        } else if (!value || shape.dimensions !== 0 || depth !== dereferences + 1) return null;
        let typeName = symbol.typeName;
        if (typeof typeName !== "string" || typeName.length > MAX_PROCEDURE_POINTER_TYPE_CHARACTERS) return null;
        for (let index = 0; index < dereferences; index++) {
            const next = typeof typeName === "string" ? typeName.replace(/\s+(?:const\s+)?(?:ptr|pointer)\s*$/i, "") : typeName;
            if (next === typeName) return null;
            typeName = next;
        }
        // FBC writes extra pointer indirection as TYPEOF(callable-type) PTR.
        // After a proven dereference, unwrap that native display wrapper.
        if (dereferences && /^typeof\(.*\)$/i.test(typeName)) typeName = typeName.slice(7, -1);
        // FBC's new scalar types moved the private FUNCTION datatype ID.
        // The compiler's canonical callable spelling, not that numeric ID,
        // proves the remaining type after the checked pointer operations.
        const signature = expressionPointerSignature(document.text.slice(labelStart, end), typeName);
        if (!signature) return null;
        signatures.set(signature.signature, signature);
    }
    return signatures.size === 1 ? signatures.values().next().value : null;
}

function compilerExpressionIndexSignatureEntries(model, uri, document, context, checkCancelled) {
    if (model.semanticSidecarOnly || !model.inventory) return [];
    const end = context.calleeEndOffset;
    if (!Number.isSafeInteger(end) || end < 1 || end > context.openParenthesisOffset || end > document.text.length) return [];
    const endPosition = positionAtOffset(document, end);
    const ranges = [...(model.compilerSelectionRanges?.(uri, endPosition, checkCancelled) || [])];
    // Recovery sidecars can omit selection spans even when the native trace
    // still types the receiver exactly. Source token starts only schedule
    // bounded exact-range queries; they supply no type or declaration choice.
    let low = 0, high = document.tokens.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (document.tokens[middle].offset < end) low = middle + 1;
        else high = middle;
    }
    for (let index = low - 1, count = 0; index >= 0 && count < MAX_SIGNATURE_RECOVERY_CANDIDATES; index--, count++) {
        const token = document.tokens[index];
        if (end - token.offset > MAX_SIGNATURE_CALLEE_CHARACTERS) break;
        ranges.push({ start: { line: token.line, character: token.startColumn }, end: endPosition });
    }
    let first = end, types = null;
    for (const range of ranges) {
        checkCancelled();
        const start = positionOffset(document, range.start.line, range.start.character);
        if (positionOffset(document, range.end.line, range.end.character) !== end || start >= first ||
            end - start > MAX_SIGNATURE_CALLEE_CHARACTERS) continue;
        const expression = model.expressionAt(uri, range.start, range.end);
        if (!expression || expression.provisional || !expression.subtype || /\b(?:ptr|pointer)\s*$/i.test(expression.typeName || "")) continue;
        const candidates = model.nativeTypeEntries(expression.typeName, expression.subtype).filter((entry) =>
            TYPE_HIERARCHY_TYPES.has(entry.declaration.type) && !entry.provisional && !entry.declaration.provisional);
        if (candidates.length && new Set(candidates.map((entry) => nativeSymbolId(model, entry))).size === 1) {
            types = candidates;
            first = start;
        }
    }
    if (!types) return [];
    const positions = model.projectPositions(uri, endPosition.line, endPosition.character, true, true);
    if (!positions.length || positions.length > MAX_SIGNATURE_RECOVERY_CANDIDATES) return [];
    const expanded = model.inner.getDocument(model.expandedUri);
    // Syntax schedules this query; only an independently valid exact native
    // receiver type supplies the operator family. Caller scopes, not the
    // source expression's spelling, decide private/protected access.
    return selectedIndexOperatorEntries(model, model.commonProjectedEntries(positions, (position) => {
        checkCancelled();
        const scope = scopeAt(expanded, positionOffset(expanded, position.line, position.character));
        for (let current = scope; current; current = current.parent) if (current.recovered) return [];
        return model.nativeMembers(types, scope).filter((entry) => isIndexOperatorEntry(entry) &&
            !entry.provisional && !entry.declaration.provisional);
    }));
}

function compilerExpressionPointerSignature(model, uri, document, context, checkCancelled) {
    const end = context.calleeEndOffset;
    if (!Number.isSafeInteger(end) || end < 1 || end > context.openParenthesisOffset || end > document.text.length) return null;
    const ranges = model.compilerSelectionRanges?.(uri, positionAtOffset(document, end), checkCancelled) || [];
    let selected = null, first = end;
    for (const range of ranges) {
        checkCancelled();
        const start = positionOffset(document, range.start.line, range.start.character);
        if (positionOffset(document, range.end.line, range.end.character) !== end || start >= first ||
            end - start > MAX_SIGNATURE_CALLEE_CHARACTERS) continue;
        const expression = model.expressionAt(uri, range.start, range.end);
        if (!expression || expression.provisional) continue;
        const signature = expressionPointerSignature(document.text.slice(start, end), expression.typeName);
        if (signature) { selected = signature; first = start; }
    }
    return selected || recoveredExpressionPointerSignature(model, uri, document, context, checkCancelled);
}

function queryCompilerModel(model, operation, input, checkCancelled) {
    if (input.targetSymbol !== undefined && (!Number.isSafeInteger(input.targetSymbol) || input.targetSymbol < 1)) {
        throw new Error("Invalid compiler operator target symbol.");
    }
    const uri = CompilerUri.from(input.uri);
    const document = model.getDocument(uri);
    if (!document) throw new Error("This source is not part of the compiler model.");
    const position = input.position || { line: 0, character: 0 };
    for (const point of [position, input.end].filter(Boolean)) {
        if (!Number.isSafeInteger(point.line) || !Number.isSafeInteger(point.character) || point.line < 0 || point.character < 0 || point.line >= document.lineOffsets.length) throw new Error("Invalid compiler query position.");
        const lineStart = document.lineOffsets[point.line];
        const nextLine = document.lineOffsets[point.line + 1] ?? document.text.length;
        const lineLength = document.text.slice(lineStart, nextLine).replace(/[\r\n]+$/, "").length;
        if (point.character > lineLength) throw new Error("Compiler query position extends beyond its source line.");
    }
    if (input.end && (input.end.line < position.line || input.end.line === position.line && input.end.character < position.character)) throw new Error("Compiler query range is reversed.");
    checkCancelled();
    if (operation === "validate") return true;
    if (operation === "compilerFoldingRanges") {
        if (model.partial || !Array.isArray(model.semanticFoldingRanges) || !uri.fsPath) return null;
        if (document.compilerFoldingRanges) return document.compilerFoldingRanges;
        // Build the lexical and native ranges in the worker on the same
        // immutable snapshot. The editor must not merge source-only comment
        // guesses back into a compiler-confirmed folding result.
        const lexical = model.compilerBracketMaskOverrides(uri);
        const sourceRanges = findFoldingRanges(document.text, lexical.defaultEscapedStringRanges,
            lexical.remIdentifierOffsets, lexical.remKeywordDisabledLineOffsets);
        const fileKey = compilerSidecarNavigationPathKey(uri.fsPath);
        const blocks = new Map();
        for (const fold of model.semanticFoldingRanges) {
            checkCancelled();
            if (compilerSidecarNavigationPathKey(fold.filePath) !== fileKey ||
                fold.startLine < 0 || fold.endLine <= fold.startLine || fold.endLine >= document.lineOffsets.length) continue;
            const previous = blocks.get(fold.startLine);
            if (!previous || previous.endLine < fold.endLine) blocks.set(fold.startLine, { startLine: fold.startLine, endLine: fold.endLine });
        }
        document.compilerFoldingRanges = [...sourceRanges.filter((fold) => fold.kind || !blocks.has(fold.startLine)), ...blocks.values()]
            .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
        return document.compilerFoldingRanges;
    }
    if (operation === "compilerSelectionRanges") {
        if (!Array.isArray(input.positions) || input.positions.length > MAX_COMPILER_SELECTION_POSITIONS) {
            throw new Error("Invalid compiler selection-range positions.");
        }
        return input.positions.map((point) => {
            checkCancelled();
            if (!Number.isSafeInteger(point?.line) || !Number.isSafeInteger(point?.character) ||
                point.line < 0 || point.character < 0 || point.line >= document.lineOffsets.length) {
                throw new Error("Invalid compiler selection-range position.");
            }
            const lineStart = document.lineOffsets[point.line];
            const nextLine = document.lineOffsets[point.line + 1] ?? document.text.length;
            const lineLength = document.text.slice(lineStart, nextLine).replace(/[\r\n]+$/, "").length;
            if (point.character > lineLength) throw new Error("Compiler selection-range position extends beyond its source line.");
            return model.compilerSelectionRanges(uri, point, checkCancelled, true);
        });
    }
    if (operation === "compilerProcedureReferenceCodeLenses") {
        return compilerProcedureReferenceCodeLensRecords(model, checkCancelled, uri);
    }
    if (operation === "compilerInactiveSourceRanges") return model.compilerInactiveSourceRanges(uri);
    if (operation === "compilerUnreachableSourceRanges") return model.compilerUnreachableSourceRanges(uri, checkCancelled);
    if (operation === "compilerSourceDiagnosticRanges") return {
        inactive: model.compilerInactiveSourceRanges(uri),
        lexical: model.compilerBracketMaskOverrides(uri),
        unreachable: model.compilerUnreachableSourceRanges(uri, checkCancelled)
    };
    if (operation === "compilerBracketMaskOverrides") return model.compilerBracketMaskOverrides(uri);
    if (operation === "compilerDefaultEscapedStringRangeAt") {
        return model.compilerDefaultEscapedStringRangeAt(uri, input.offset);
    }
    if (operation === "compilerCodeContext") {
        return model.compilerCodeContext(uri, input.offset, input.offsetAdjustment);
    }
    if (operation === "compilerTypeInlayHints") return model.compilerTypeInlayHints(uri, position, input.end || position);
    if (operation === "compilerInlayHints") {
        const end = input.end || position;
        return {
            types: model.compilerTypeInlayHints(uri, position, end),
            implicitVariables: compilerSidecarImplicitVariableInlayHints(model, uri, position, end, checkCancelled),
            implicitDeclarations: compilerSidecarImplicitDeclarationTypeInlayHints(model, uri, position, end, checkCancelled),
            parameters: input.parameterHints === true
                ? compilerParameterInlayHintRecords(model, uri, position, end, checkCancelled)
                : [],
            forEntries: model.compilerForEntryResultInlayHints?.(uri, position, end, checkCancelled) || [],
            ifConditions: model.compilerIfConditionInlayHints?.(uri, position, end, checkCancelled) || [],
            unreachableStatements: model.compilerUnreachableStatementInlayHints?.(uri, position, end, checkCancelled) || []
        };
    }
    if (operation === "compilerParameterInlayHints") {
        return compilerParameterInlayHintRecords(model, uri, position, input.end || position, checkCancelled);
    }
    if (operation === "compilerSidecarCallBindingAt") {
        return compilerSidecarCallBindingRecords(model, checkCancelled, uri, position, input.name);
    }
    if (operation === "compilerSidecarConstantAt") {
        return compilerSidecarConstantAt(model, uri, position, checkCancelled);
    }
    if (operation === "compilerSidecarConstantsAtSites") {
        return compilerSidecarConstantsAtSites(model, input.sites, checkCancelled);
    }
    if (operation === "compilerSidecarEnumMembersAtSites") {
        return compilerSidecarEnumMembersAtSites(model, input.sites, checkCancelled);
    }
    if (operation === "compilerSidecarOutlineFactsAtSites") {
        return compilerSidecarOutlineFactsAtSites(model, uri, input.sites, checkCancelled);
    }
    if (operation === "compilerSidecarOutlineImplicitVariables") {
        return compilerSidecarOutlineImplicitVariables(model, uri, checkCancelled);
    }
    if (operation === "compilerSidecarOutlineMaskedVariables") {
        return compilerSidecarOutlineMaskedVariableDeclarations(model, uri, checkCancelled);
    }
    if (operation === "compilerSidecarAccessRolesAtSites") {
        return compilerSidecarAccessRolesAtSites(model, input.sites, checkCancelled);
    }
    if (operation === "compilerSidecarCallBindings") {
        return compilerSidecarCallBindingRecords(model, checkCancelled, uri, null, input.name);
    }
    if (operation === "compilerSidecarCallBindingsInSnapshot") {
        return compilerSidecarCallBindingRecords(model, checkCancelled, null, null, input.name);
    }
    if (operation === "compilerSidecarOperatorExpressionAt") {
        const result = compilerSidecarOperatorExpressionRecords(model, checkCancelled, uri, position, input.operatorCode);
        if (!result.complete) return result;
        if (result.expressions.length > 1) {
            const span = (expression) => expression.endOffset - expression.startOffset;
            const narrowest = Math.min(...result.expressions.map(span));
            result.expressions = result.expressions.filter((expression) => span(expression) === narrowest);
        }
        if (result.expressions.length === 1) {
            result.expressions[0].declarations = compilerSidecarProcedureDeclarationSites(
                model, result.expressions[0], checkCancelled
            );
        }
        return result;
    }
    if (operation === "compilerSidecarOperatorDeclarationAt") {
        if (input.declarationOrigin !== undefined) {
            // An included header belongs to this root snapshot even when the
            // user has not selected a standalone editor context for that header.
            const origin = input.declarationOrigin;
            if (!origin || typeof origin.filePath !== "string" || !path.isAbsolute(origin.filePath) ||
                !Number.isSafeInteger(origin.startLine) || origin.startLine < 1 ||
                !Number.isSafeInteger(origin.startColumn) || origin.startColumn < 0) {
                throw new Error("Invalid compiler operator declaration origin.");
            }
            const originUri = CompilerUri.file(origin.filePath);
            const source = model.getDocument(originUri);
            if (!source || semanticSourceColumnOffset(source, origin.startLine - 1, origin.startColumn) === null) return null;
            return compilerSidecarOperatorDeclarationAt(model, originUri, source,
                { line: origin.startLine - 1, character: origin.startColumn }, input.kind, checkCancelled);
        }
        return compilerSidecarOperatorDeclarationAt(model, uri, document, position, input.kind, checkCancelled);
    }
    if (operation === "compilerSidecarOperatorExpressions") {
        return compilerSidecarOperatorExpressionRecords(model, checkCancelled, uri, null, input.operatorCode, input.targetSymbol);
    }
    if (operation === "compilerSidecarOperatorExpressionsInSnapshot") {
        return compilerSidecarOperatorExpressionRecords(model, checkCancelled, null, null, input.operatorCode, input.targetSymbol);
    }
    if (operation === "compilerSidecarOperatorOperationAt") {
        const result = compilerSidecarOperatorOperationRecords(model, checkCancelled, uri, position, input.operatorCode);
        if (result.complete && result.operations.length === 1) {
            result.operations[0].declarations = compilerSidecarProcedureDeclarationSites(
                model, result.operations[0], checkCancelled
            );
        }
        return result;
    }
    if (operation === "compilerSidecarOperatorOperationsInSnapshot") {
        return compilerSidecarOperatorOperationRecords(model, checkCancelled, null, null, input.operatorCode, input.targetSymbol);
    }
    if (operation === "compilerSidecarImplicitCallsInSnapshot") {
        return compilerSidecarImplicitCallRecords(model, checkCancelled);
    }
    if (operation === "compilerSidecarCallResults") return model.compilerSidecarCallResults(uri, input.name, checkCancelled);
    if (operation === "compilerSidecarCallResultsInSnapshot") return model.compilerSidecarCallResultsInSnapshot(input.name, checkCancelled);
    if (operation === "documentLinks") return model.compilerDocumentLinks(uri);
    if (operation === "documentSymbols") return compilerSymbolRecords(model, uri, checkCancelled);
    let resolvedEntries;
    const resolve = () => {
        if (resolvedEntries === undefined) resolvedEntries = model.resolveAt(uri, position.line, position.character);
        return resolvedEntries;
    };
    const typedConstructorOperation = () => Boolean(compilerTypedConstructorTokenAtPosition(document, position)) &&
        resolve().every((entry) => TYPE_HIERARCHY_TYPES.has(entry.declaration.type));
    const callHierarchyTargets = () => {
        if (!model.semanticSidecarOnly) {
            const declaration = compilerLifetimeDeclarationEntryAtPosition(model, uri, document, position);
            if (declaration) return model.declarationTargets([declaration]);
            const typed = typedConstructorOperation();
            if (typed && model.partial) return [];
            const constructor = compilerSelectedImplicitConstructorEntryAtPosition(
                model, uri, document, position, typed ? new Set(["explicit-constructor"]) : CONSTRUCTOR_IMPLICIT_CALL_KINDS, checkCancelled
            );
            if (constructor) return [constructor];
            if (typed) return [];
        }
        const context = findCallContextInMaskedText(document.masked, positionOffset(document, position.line, position.character));
        if (context?.indexing && !compilerIdentifierTokenAtPosition(document, position)) {
            const candidates = indexOperatorCandidates(model, uri, document, context);
            const selected = compilerSelectedIndexOperatorCandidates(model, uri, document, position, candidates, checkCancelled);
            const identities = new Set(candidates.map((entry) => nativeSymbolId(model, entry)).filter(Boolean));
            const entries = selected.length ? selected : identities.size === 1 ? candidates : [];
            return model.declarationTargets(entries);
        }
        const resolved = resolve();
        // Preparing from a prototype should select the same native definition
        // as Go to Definition, without replacing native identities with source
        // declaration-family guesses.
        if (resolved.length) return model.declarationTargets?.(resolved) || resolved;
        return model.declarationTargets(indexOperatorDeclarationAt(model, uri, position));
    };
    if (operation === "typeHierarchyPrepare") {
        if (model.semanticSidecarOnly) {
            const selection = compilerSidecarTypeHierarchySelection(model, uri, document, position, checkCancelled);
            return selection?.entries.map(navigationEntryRecord) || [];
        }
        return typeHierarchyEntries(model, resolve(), checkCancelled).map(navigationEntryRecord);
    }
    if (operation === "compilerSidecarTypeDefinition") {
        return compilerSidecarTypeDefinitionRecords(model, uri, document, position, checkCancelled);
    }
    if (operation === "compilerSidecarReceiverTypeHierarchy") {
        return compilerSidecarTypeDefinitionRecords(model, uri, document, position, checkCancelled, true);
    }
    if (operation === "typeHierarchySupertypes" || operation === "typeHierarchySubtypes") {
        if (model.semanticSidecarOnly) {
            const selection = compilerSidecarTypeHierarchySelection(model, uri, document, position, checkCancelled);
            if (!selection) return [];
            const entries = operation === "typeHierarchySupertypes"
                ? compilerSidecarTypeHierarchySupertypes(model, selection, checkCancelled)
                : compilerSidecarTypeHierarchySubtypes(model, selection, checkCancelled);
            return entries.map(navigationEntryRecord);
        }
        return (operation === "typeHierarchySupertypes"
            ? typeHierarchySupertypes(model, resolve(), checkCancelled)
            : typeHierarchySubtypes(model, resolve(), checkCancelled)).map(navigationEntryRecord);
    }
    if (operation === "callHierarchyPrepare") {
        if (typedConstructorOperation()) {
            if (!model.semanticSidecarOnly) {
                const entries = callHierarchyEntries(model, callHierarchyTargets(), checkCancelled);
                if (entries.length) return entries.map((entry) => callHierarchyEntryRecord(model, entry, true));
            }
            const target = compilerSelectedImplicitConstructorTargetAtPosition(model, uri, document, position,
                new Set(["explicit-constructor"]), checkCancelled);
            const declarations = compilerConstructorDeclarationEntries(model, target, checkCancelled);
            const selected = declarations?.find((entry) => !entry.declaration.modifiers.includes("DECLARE")) || declarations?.[0];
            return selected ? [callHierarchyEntryRecord(model, selected, true)] : [];
        }
        if (model.semanticSidecarOnly && sidecarLifetimeLocationAtPosition(document, position)) {
            // A physical prototype can identify an external lifetime method
            // even when this translation unit has no body or source family.
            // Native D ownership selects it; parsing only supplies its label.
            const selected = compilerLifetimeHeaderTargetAtPosition(model, uri, document, position, checkCancelled);
            if (selected.entries.length !== 1) return [];
            const target = selected.entries[0];
            const headers = (compilerSidecarNavigationSourceDeclarations(model, document) || []).filter((entry) =>
                entry.type === target.declaration.type && entry.line === target.declaration.line &&
                entry.startColumn === target.declaration.endColumn - target.name.length);
            if (headers.length !== 1) return [];
            return [navigationEntryRecord({ ...target, uri, id: `sidecar:${target.compilerSymbolId}:${uri.toString()}:${target.declaration.line}`,
                declaration: { ...headers[0], startColumn: headers[0].startColumn, endColumn: target.declaration.endColumn } })];
        }
        return callHierarchyEntries(model, callHierarchyTargets(), checkCancelled).map((entry) => callHierarchyEntryRecord(model, entry, true));
    }
    if (operation === "callHierarchyIncoming") return callHierarchyIncoming(model, callHierarchyTargets(), checkCancelled);
    if (operation === "callHierarchyOutgoing") {
        const records = input.module === true
            ? callHierarchyModuleOutgoing(model, uri, checkCancelled)
            : callHierarchyOutgoing(model, callHierarchyTargets(), checkCancelled);
        // Legacy procedure traces and the index/lifetime readers do not cover
        // every non-index operator. A populated trace is not a completeness
        // proof for a module that declares those operators. Let the existing
        // sidecar project path supply their committed calls and native owners.
        // Replacement-body names likewise identify references, not physical
        // runtime call sites; the full macro receipts own those invocations.
        if (model.compilerRequiresCallProjection ||
            model.inner.entries.some((entry) => entry.declaration.type === "operator" && !isIndexOperatorEntry(entry))) {
            for (const record of records) record.compilerRequiresImplicitProjection = true;
        }
        return records;
    }
    const expression = () => model.expressionAt(uri, position, input.end || position);
    const inCode = () => getCodeContext(document.text, positionOffset(document, position.line, position.character),
        document.defaultEscapedStringRanges, model.compilerRemIdentifierOffsets?.(uri),
        model.compilerRemKeywordDisabledLineOffsets?.(uri)) === "code";
    if (["definition", "declaration", "implementation"].includes(operation)) {
        const constructors = compilerConstructorNavigation(model, uri, document, position, operation, resolve(), checkCancelled);
        if (constructors !== null) return constructors;
    }
    if (operation === "expression") {
        const selected = input.preferIndexResult === true
            ? compilerIndexExpressionAt(model, uri, document, position) || expression()
            : expression();
        if (!selected || selected.provisional) return selected;
        const constantValues = compilerSidecarExpressionConstantValuesAt(model, uri, position, input.end || position);
        const targetWideLiteral = String(selected.typeName || "").trim().toLowerCase() === "wstring"
            ? model.compilerTargetWideLiteralAt?.(uri, position)
            : null;
        return constantValues.length || targetWideLiteral
            ? {
                ...selected,
                ...(constantValues.length ? { compilerConstantValues: constantValues } : {}),
                ...(targetWideLiteral ? { targetWideLiteral } : {})
            }
            : selected;
    }
    if (operation === "declaration") {
        const context = findCallContextInMaskedText(document.masked, positionOffset(document, position.line, position.character));
        if (context?.indexing && !compilerIdentifierTokenAtPosition(document, position)) {
            const candidates = indexOperatorCandidates(model, uri, document, context);
            const selected = compilerSelectedIndexOperatorCandidates(model, uri, document, position, candidates, checkCancelled);
            return model.declarationSources(selected.length ? selected : candidates).map(navigationEntryRecord);
        }
        const targets = resolve();
        if (context && !targets.length) {
            const argumentConstructor = compilerSelectedImplicitConstructorEntryAtPosition(
                model, uri, document, position, new Set(["argument-constructor"]), checkCancelled
            );
            if (argumentConstructor) return compilerConstructorDeclarationSources(model, argumentConstructor).map(navigationEntryRecord);
        }
        if (model.semanticSidecarOnly) {
            const selection = compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled);
            if (selection) {
                if (!selection.symbol) return [];
                const navigation = compilerSidecarNavigationEntryRecords(model, selection, checkCancelled);
                if (!navigation.complete) return [];
                const declarations = navigation.entries.filter((entry) =>
                    entry.declaration.modifiers.includes("DECLARE"));
                return (declarations.length ? declarations : navigation.entries);
            }
        }
        return model.declarationSources(targets).map(navigationEntryRecord);
    }
    if (operation === "target" || operation === "hover") {
        const context = model.tokenAt(uri, position.line, position.character);
        const callContext = operation === "hover"
            ? hoverCallContext(document, positionOffset(document, position.line, position.character))
            : null;
        let hoverMacroSignature = null;
        const macroSignatureAtToken = (token) => token?.kind === "identifier"
            ? model.compilerMacroSignatureAt?.(uri, token.name, token.line + 1, token.startColumn, token.endColumn) || null
            : null;
        if (model.semanticSidecarOnly && callContext && !callContext.indexing) {
            const span = callNameSpan(document, callContext);
            const call = span && document.tokens.find((candidate) =>
                candidate.kind === "identifier" && candidate.offset === span.start && candidate.end === span.end
            );
            hoverMacroSignature = macroSignatureAtToken(call);
        }
        if (!hoverMacroSignature && model.semanticSidecarOnly) {
            hoverMacroSignature = macroSignatureAtToken(context?.token);
        }
        let entries;
        let hoverExpression = operation === "hover" ? expression() : null;
        const hoverSidecarExpression = operation === "hover"
            ? model.compilerSidecarFactAt?.(uri, position, position)
            : null;
        const hoverExpressionOperation = hoverSidecarExpression?.sourceOperation
            ? hoverSidecarExpression
            : operation === "hover" ? model.compilerRuntimeMacroOperationAt?.(uri, position) : null;
        const hoverTargetWideLiteral = operation === "hover"
            ? model.compilerTargetWideLiteralAt?.(uri, position)
            : null;
        const hoverSelectCaseLowering = operation === "hover"
            ? model.compilerSelectCaseLoweringAt?.(uri, position)
            : null;
        const hoverArrayStorageSelection = operation === "hover"
            ? compilerArrayStorageSelectionForHover(model, hoverSidecarExpression?.arrayStorageSelection)
            : null;
        const hoverArrayDeclarationFacts = operation === "hover"
            ? compilerStorageTypeFactsForSymbols(model, model.compilerArrayDeclarationSymbolIdsAt?.(uri, position))
            : null;
        const hoverFieldDeclarationFacts = operation === "hover"
            ? compilerFieldFactsForHover(model, model.compilerFieldDeclarationSymbolIdsAt?.(uri, position))
            : null;
        const hoverAggregateDeclarationFacts = operation === "hover"
            ? compilerAggregateFactsForHover(
                model, model.compilerAggregateDeclarationSymbolIdsAt?.(uri, position), uri, position, checkCancelled
            )
            : null;
        const hoverParameterDeclarationFacts = operation === "hover"
            ? compilerParameterFactsForHover(model, model.compilerParameterDeclarationSymbolIdsAt?.(uri, position))
            : null;
        const hoverParameterDeclarationRange = operation === "hover"
            ? model.compilerParameterDeclarationRangeAt?.(uri, position) || null
            : null;
        const hoverProcedureDeclarationFacts = operation === "hover"
            ? compilerProcedureFactsForHover(model, model.compilerProcedureDeclarationSymbolIdsAt?.(uri, position))
            : null;
        const hoverProcedureVisibilityFacts = operation === "hover"
            ? compilerProcedureVisibilityFactsForHover(model, model.compilerProcedureDeclarationSymbolIdsAt?.(uri, position))
            : null;
        const hoverProcedureDeclarationRange = operation === "hover"
            ? model.compilerProcedureDeclarationRangeAt?.(uri, position) || null
            : null;
        const hoverStorageClass = operation === "hover"
            ? compilerStorageClassForHover(model, model.compilerStorageClassDeclarationSymbolIdsAt?.(uri, position))
            : null;
        const hoverStorageTypeFacts = operation === "hover"
            ? compilerStorageTypeFactsForSymbols(model, model.compilerStorageTypeDeclarationSymbolIdsAt?.(uri, position))
            : null;
        const hoverStorageTypeDeclarationRange = operation === "hover"
            ? model.compilerStorageTypeDeclarationRangeAt?.(uri, position) || null
            : null;
        const hoverEnumElementFacts = operation === "hover"
            ? compilerEnumElementFactsForHover(model, model.compilerEnumElementDeclarationSymbolIdsAt?.(uri, position))
            : null;
        const hoverEnumElementRange = operation === "hover"
            ? model.compilerEnumElementDeclarationRangeAt?.(uri, position) || null
            : null;
        if (callContext?.indexing && !compilerIdentifierTokenAtPosition(document, position)) {
            const candidates = indexOperatorCandidates(model, uri, document, callContext);
            const selected = compilerSelectedIndexOperatorCandidates(model, uri, document, position, candidates, checkCancelled);
            entries = (selected.length ? model.declarationTargets(selected) : selectedIndexOperatorEntries(model, candidates)).slice(0, 5);
            hoverExpression = compilerIndexExpressionAt(model, uri, document, position) || hoverExpression;
        } else {
            entries = resolve().slice(0, operation === "hover" ? 5 : 2);
            if (operation === "hover" && context?.token.key === "type" &&
                document.tokens[context.token.index + 1]?.name === "<" &&
                entries.every((entry) => TYPE_HIERARCHY_TYPES.has(entry.declaration.type))) {
                // The TYPE keyword owns the written construction. Names in
                // its type argument keep their own type/namespace bindings.
                const target = compilerSelectedImplicitConstructorTargetAtPosition(model, uri, document, position,
                    new Set(["explicit-constructor"]), checkCancelled);
                const declarations = compilerConstructorDeclarationEntries(model, target, checkCancelled);
                const selected = declarations?.find((entry) => entry.declaration.modifiers.includes("DECLARE")) || declarations?.[0];
                if (selected) entries = [selected, ...entries].slice(0, 5);
            }
            const callee = callContext && callNameSpan(document, callContext);
            // Only the terminal type/alias name owns constructor hover. Its
            // qualifier and argument values retain their own declarations.
            const onCallee = callee && (document.byLine.get(position.line) || []).some((token) =>
                token.end === callee.end && position.character >= token.startColumn && position.character < token.endColumn);
            if (onCallee && !entries.some((entry) => SIGNATURE_CALLABLE_TYPES.has(entry.declaration.type))) {
                const procedure = compilerSelectedConstructorProcedure(model, uri, document, callContext, checkCancelled);
                const declarations = procedure && compilerConstructorDeclarationEntries(model, procedure.symbol, checkCancelled);
                const nativeConstructor = declarations?.find((entry) => !entry.declaration.modifiers.includes("DECLARE")) || declarations?.[0];
                const constructors = nativeConstructor ? [nativeConstructor] : constructorEntries(model, uri, document, callContext);
                if (constructors.length) {
                    const selectedTarget = nativeConstructor ? 0 : compilerSelectedCallTarget(model, uri, document, callContext, checkCancelled);
                    const selected = selectedTarget
                        ? constructors.filter((entry) => nativeSymbolId(model, entry) === selectedTarget)
                        : [];
                    entries = [...new Map([...(selected.length ? selected : constructors), ...entries]
                        .map((entry) => [entry.id, entry])).values()].slice(0, 5);
                }
            }
        }
        if (operation === "hover" && model.semanticSidecarOnly && !entries.length &&
            (compilerIdentifierTokenAtPosition(document, position) ||
                compilerIdentifierTokenAtRawPosition(document, position) ||
                compilerOptionNoKeywordIdentifierAtPosition(document, position))) {
            const selection = compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled, true);
            if (selection?.symbol) {
                const navigation = compilerSidecarNavigationEntryRecords(model, selection, checkCancelled);
                if (navigation.complete) entries = navigation.entries.slice(0, 5);
            }
        }
        const uniqueMacroUse = operation === "hover" && entries.length === 1 &&
            entries[0].compilerPreprocessorId && entries[0].compilerMacroUniqueDefinition;
        const compilerHeaderLibraries = new Map();
        if (operation === "hover") {
            const addHeaderLibrary = (library) => {
                if (!library || !["inclib", "libpath"].includes(library.kind) ||
                    typeof library.value !== "string") return;
                const key = `${library.filePath || ""}\t${library.kind}\t${library.value}`;
                if (!compilerHeaderLibraries.has(key) && compilerHeaderLibraries.size < 8) {
                    compilerHeaderLibraries.set(key, library);
                }
            };
            for (const library of model.compilerHeaderLibrariesAt?.(uri, position) || []) addHeaderLibrary(library);
            for (const entry of entries) {
                for (const library of model.compilerHeaderLibrariesForFile?.(entry.uri?.fsPath || entry.uri?.path) || []) {
                    addHeaderLibrary(library);
                }
            }
        }
        const primitiveType = operation === "hover" && !entries.length ? model.compilerPrimitiveTypeAt?.(uri, position, checkCancelled) || null : null;
        return {
            primitiveType,
            expression: operation === "hover" && hoverExpression && !primitiveType
                ? {
                    ...hoverExpression,
                    ...(hoverSidecarExpression?.compilerIifInputs
                        ? { compilerIifInputs: hoverSidecarExpression.compilerIifInputs }
                        : {}),
                    ...(hoverSidecarExpression?.compilerAssignmentTarget
                        ? { compilerAssignmentTarget: hoverSidecarExpression.compilerAssignmentTarget }
                        : {}),
                    ...(hoverSidecarExpression?.compilerArrayIndex
                        ? { compilerArrayIndex: hoverSidecarExpression.compilerArrayIndex }
                        : {}),
                    ...(hoverSidecarExpression?.compilerNumericOperands
                        ? { compilerNumericOperands: hoverSidecarExpression.compilerNumericOperands }
                        : {}),
                    ...(hoverSidecarExpression?.compilerSizeQuery
                        ? { compilerSizeQuery: hoverSidecarExpression.compilerSizeQuery }
                        : {}),
                    ...(hoverSidecarExpression?.compilerArrayBoundQuery
                        ? { compilerArrayBoundQuery: hoverSidecarExpression.compilerArrayBoundQuery }
                        : {}),
                    ...(hoverArrayStorageSelection ? { arrayStorageSelection: hoverArrayStorageSelection } : {})
                }
                : null,
            expressionOperation: hoverExpressionOperation?.sourceOperation ? hoverExpressionOperation : null,
            targetWideLiteral: hoverTargetWideLiteral,
            selectCaseLowering: hoverSelectCaseLowering,
            arrayStorageSelection: hoverArrayStorageSelection,
            compilerArrayFacts: hoverArrayDeclarationFacts,
            compilerFieldFacts: hoverFieldDeclarationFacts,
            compilerAggregateFacts: hoverAggregateDeclarationFacts,
            compilerParameterFacts: hoverParameterDeclarationFacts,
            compilerParameterDeclarationRange: hoverParameterDeclarationRange,
            compilerProcedureFacts: hoverProcedureDeclarationFacts,
            compilerProcedureVisibilityFacts: hoverProcedureVisibilityFacts,
            compilerProcedureDeclarationRange: hoverProcedureDeclarationRange,
            compilerStorageClass: hoverStorageClass,
            compilerStorageTypeFacts: hoverStorageTypeFacts,
            compilerStorageTypeDeclarationRange: hoverStorageTypeDeclarationRange,
            compilerEnumElementFacts: hoverEnumElementFacts,
            compilerEnumElementRange: hoverEnumElementRange,
            assignmentInput: operation === "hover" ? model.compilerAssignmentInputAt?.(uri, position) || null : null,
            // Cached data hovers only need the extra binding/value walk for
            // a uniquely resolved constant. Keep ordinary variable reads cheap.
            ...(operation === "hover" && (input.includeSymbolConstant === true ||
                input.includeBoundSymbolConstant === true && entries.length === 1 &&
                    ["const", "enumMember"].includes(entries[0].declaration?.type))
                ? { symbolConstant: compilerSidecarConstantAt(model, uri, position, checkCancelled) } : {}),
            expressionConstantValues: operation === "hover"
                ? compilerSidecarExpressionConstantValuesAt(model, uri, position, input.end || position)
                : [],
            forEntryResult: operation === "hover"
                ? compilerForEntryResultAt(model, uri, document, position, checkCancelled)
                : null,
            expressionAlternatives: operation === "hover"
                ? model.compilerSidecarExpressionAlternativesAt(uri, position, input.end || position)
                : [],
            preprocessorDecision: operation === "hover" ? model.compilerConditionalDecisionAt(uri, position) : null,
            definedNameProbe: operation === "hover" ? model.compilerDefinedNameProbeAt(uri, position) : null,
            deferredMacroReference: operation === "hover" ? model.compilerDeferredMacroReferenceAt(uri, position) : null,
            macroSignature: hoverMacroSignature,
            compilerHeaderLibraries: [...compilerHeaderLibraries.values()],
            occurrence: context?.token || null,
            entries: entries.map((entry) => entryRecord(entry, Boolean(uniqueMacroUse || context?.token &&
                entry.compilerPreprocessorId && entry.uri.toString() === uri.toString() && entry.offset === context.token.offset),
            operation === "hover"))
        };
    }
    if (operation === "completion") {
        if (!inCode()) return { member: true, entries: [] };
        const members = model.completeMembers(uri, position.line, position.character, true);
        const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(20000, input.limit)) : 2000;
        const prefix = document.text.slice(positionOffset(document, position.line, 0), positionOffset(document, position.line, position.character));
        let entries = members === null ? model.visibleEntries(uri, position.line, position.character, limit) : members.slice(0, limit);
        const enumQualifierSite = model.semanticSidecarOnly
            ? compilerSidecarEnumQualifierSite(document, position)
            : null;
        const completionFilePath = uri.fsPath || uri.path || "";
        const enumQualifierOwner = enumQualifierSite && path.isAbsolute(completionFilePath)
            ? compilerSidecarEnumQualifierOwner(model, compilerSidecarNavigationPathKey(completionFilePath),
                enumQualifierSite, checkCancelled)
            : 0;
        const cursorEnumOwner = !enumQualifierSite && model.semanticSidecarOnly && path.isAbsolute(completionFilePath)
            ? compilerSidecarEnumMemberOwnerAtCursor(model, compilerSidecarNavigationPathKey(completionFilePath),
                document, position, checkCancelled)
            : 0;
        const enumCompletionContext = enumQualifierSite || cursorEnumOwner
            ? { site: enumQualifierSite, owner: enumQualifierOwner || cursorEnumOwner }
            : null;
        const qualifiedEnumCompletion = Boolean(enumQualifierSite && enumQualifierOwner);
        const compilerBoundEnumCompletion = Boolean(enumQualifierOwner || cursorEnumOwner);
        const constructorPrefix = qualifiedEnumCompletion ? ""
            : newTypeCompletionPrefix(document, position) || explicitTypeConstructorCompletionPrefix(document, position);
        // The editor's slot hint only schedules candidate collection. Every
        // returned type still needs an exact native declaration binding.
        const typeContext = ["type", "base"].includes(input.typeCompletionContext) ? input.typeCompletionContext : null;
        if (model.semanticSidecarOnly && (typeContext || constructorPrefix &&
            !entries.some((entry) => entry.declaration?.type !== "macro"))) {
            const sourceTypeEntries = compilerSidecarSourceTypeCompletionEntries(
                model, uri, document, position, entries, prefix, limit - entries.length, checkCancelled, typeContext
            );
            if (sourceTypeEntries.length) entries = [...entries, ...sourceTypeEntries];
        }
        const constructor = constructorPrefix && entries.length < limit
            ? constructorCompletionParameters(model, uri, document, position, entries, constructorPrefix, checkCancelled)
            : null;
        /* PRINT/RETURN followed by a qualified name can also be an ordinary
           value member. Only type candidates make this a constructor context. */
        const constructorCompletionContext = constructorPrefix && entries.some((entry) =>
            ["type", "class", "union"].includes(entry.declaration.type) &&
            (entry.name || entry.declaration.name).toLowerCase().startsWith(constructorPrefix.toLowerCase()));
        const completionEntries = entries.map((entry) => {
            const qualifiedName = entry.qualifiedName || entry.declaration.qualifiedName;
            const includeQualifiedName = Boolean(entry.declaration.containerName) ||
                typeof qualifiedName === "string" && qualifiedName.includes(".");
            const record = entryRecord(entry,
                Boolean(entry.compilerPreprocessorId && entry.compilerMacroUniqueDefinition),
                includeQualifiedName);
            const headerLibraries = model.compilerHeaderLibrariesForFile?.(entry.uri?.fsPath || entry.uri?.path);
            if (headerLibraries?.length) record.declaration.compilerHeaderLibraries = headerLibraries;
            if (constructor?.typeId === entry.id) record.constructorCallParameters = constructor.parameters;
            return record;
        });
        if ((members === null || compilerBoundEnumCompletion) && completionEntries.length < limit) {
            completionEntries.push(...compilerSidecarCompletionRecords(
                model, uri, document, position, entries, prefix, limit - completionEntries.length, checkCancelled,
                enumCompletionContext
            ));
        }
        return {
            member: qualifiedEnumCompletion || members !== null && !constructorCompletionContext,
            hasDirectivePrefix: /#\s*[A-Za-z_]*$/.test(prefix),
            entries: completionEntries
        };
    }
    if (operation === "definition") {
        const offset = positionOffset(document, position.line, position.character);
        const context = findCallContextInMaskedText(document.masked, offset) || hoverCallContext(document, offset);
        /* Index receipts describe the whole expression, but an identifier
           inside its arguments still has its own declaration binding. */
        if (context?.indexing && !compilerIdentifierTokenAtPosition(document, position)) {
            const candidates = indexOperatorCandidates(model, uri, document, context);
            const selected = compilerSelectedIndexOperatorCandidates(model, uri, document, position, candidates, checkCancelled);
            return model.declarationTargets(selected.length ? selected : candidates).map(navigationEntryRecord);
        }
        const targets = resolve();
        if (context && !targets.length) {
            const argumentConstructor = compilerSelectedImplicitConstructorEntryAtPosition(
                model, uri, document, position, new Set(["argument-constructor"]), checkCancelled
            );
            if (argumentConstructor) return model.declarationTargets([argumentConstructor]).map(navigationEntryRecord);
        }
        if (context && targets.some((entry) => TYPE_HIERARCHY_TYPES.has(entry.declaration.type))) {
            const implicitConstructor = compilerSelectedImplicitConstructorEntryAtPosition(
                model, uri, document, position, CONSTRUCTOR_IMPLICIT_CALL_KINDS, checkCancelled
            );
            if (implicitConstructor) return model.declarationTargets([implicitConstructor]).map(navigationEntryRecord);
            const constructors = constructorEntries(model, uri, document, context);
            const selectedTarget = compilerSelectedNewConstructorTarget(model, uri, document, context, constructors, checkCancelled) ||
                compilerSelectedCallTarget(model, uri, document, context, checkCancelled);
            const selected = selectedTarget
                ? constructors.filter((entry) => nativeSymbolId(model, entry) === selectedTarget)
                : [];
            if (selected.length) return model.declarationTargets(selected).map(navigationEntryRecord);
        } else if (!context && isNewConstructorTypeAtPosition(document, position)) {
            const selectedConstructor = compilerSelectedImplicitConstructorEntryAtPosition(
                model, uri, document, position, new Set(["new-constructor"]), checkCancelled
            );
            if (selectedConstructor) return model.declarationTargets([selectedConstructor]).map(navigationEntryRecord);
        }
        if (model.semanticSidecarOnly) {
            const selection = compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled, true);
            if (selection) {
                if (!selection.symbol) return [];
                const navigation = compilerSidecarNavigationEntryRecords(model, selection, checkCancelled);
                if (!navigation.complete) {
                    const fallbackDefinitions = compilerSidecarDefinitionRecords(model, selection, checkCancelled);
                    return fallbackDefinitions || [];
                }
                const implementations = navigation.entries.filter((entry) =>
                    !entry.declaration.modifiers.includes("DECLARE"));
                if (implementations.length) return implementations.map(navigationEntryRecord);
                if (navigation.entries.length) return navigation.entries;
                const fallbackDefinitions = compilerSidecarDefinitionRecords(model, selection, checkCancelled);
                if (fallbackDefinitions) return fallbackDefinitions;
            }
        }
        return model.declarationTargets(targets).map((entry) => ({ ...navigationEntryRecord(entry),
            ...(!model.partial && model.compilerNativeVirtualProcedures?.has(nativeSymbolId(model, entry))
                ? { compilerVirtualMethod: true } : {}) }));
    }
    if (operation === "baseDefinition") {
        return compilerBaseMethodDefinition(model, uri, document, position, resolve, checkCancelled);
    }
    if (operation === "typeImplementations") {
        return compilerTypeImplementations(model, uri, document, position, resolve, checkCancelled);
    }
    if (operation === "implementation") {
        const overrides = compilerOverrideImplementations(model, uri, document, position, resolve, checkCancelled);
        if (overrides !== null) return overrides;
        if (model.semanticSidecarOnly) {
            const selection = compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled);
            if (selection) {
                if (!selection.symbol) return [];
                const navigation = compilerSidecarNavigationEntryRecords(model, selection, checkCancelled);
                if (!navigation.complete) return [];
                const virtual = model.compilerProcedureOverrideTargetsBySemanticIdentity?.has(selection.symbol) ||
                    navigation.entries.some((entry) => entry.declaration.modifiers.some((modifier) =>
                        ["VIRTUAL", "ABSTRACT", "OVERRIDE"].includes(modifier)));
                return navigation.entries.filter((entry) =>
                    ["sub", "function", "property", "constructor", "destructor", "operator"].includes(entry.declaration.type) &&
                    !entry.declaration.modifiers.includes("DECLARE")
                ).map((entry) => virtual ? { ...entry, compilerVirtualMethod: true } : entry);
            }
        }
        return model.declarationTargets(resolve()).filter((entry) =>
            ["sub", "function", "property", "constructor", "destructor", "operator"].includes(entry.declaration.type) &&
            !entry.declaration.modifiers.includes("DECLARE")
        ).map(navigationEntryRecord);
    }
    if (operation === "typeDefinition") {
        const context = findCallContextInMaskedText(document.masked, positionOffset(document, position.line, position.character));
        const typed = context?.indexing && !compilerIdentifierTokenAtPosition(document, position)
            ? compilerIndexExpressionAt(model, uri, document, position) || expression()
            : expression();
        const entries = typed ? model.nativeTypeEntries(typed.typeName, typed.subtype) : resolve().flatMap((entry) => model.typeEntries(entry));
        return [...new Map(entries.map((entry) => [entry.id, entry])).values()].map(navigationEntryRecord);
    }
    if (operation === "references" || operation === "highlights" || operation === "lifetimeReferenceTarget") {
        if (operation === "lifetimeReferenceTarget" && input.declarationAtPosition === true) {
            return compilerLifetimeHeaderTargetAtPosition(model, uri, document, position, checkCancelled);
        }
        const typedOperation = typedConstructorOperation();
        // Compiler-owned prototype records also cover include guards and
        // external definitions that the source-only family mapper cannot join.
        const writtenLifetime = model.semanticSidecarOnly || operation === "lifetimeReferenceTarget"
            ? sidecarLifetimeLocationAtPosition(document, position) : null;
        const destructorProcedure = input.destructorProcedure || (writtenLifetime?.kind === "destructor" ? writtenLifetime : null);
        const constructorProcedure = input.constructorProcedure || (writtenLifetime?.kind === "constructor" ? writtenLifetime : null);
        let destructorTarget = sidecarLifetimeTargetAtProcedure(model, destructorProcedure,
            destructorProcedure?.declarations || [], "destructor");
        if (!destructorTarget && model.tokenAt(uri, position.line, position.character)?.token?.key === "destructor") {
            const selectedPath = compilerSidecarNavigationPathKey(uri.fsPath || uri.path || "");
            const targets = new Set(compilerExplicitDestructorCalls(model, checkCancelled).filter((call) =>
                compilerSidecarNavigationPathKey(call.filePath) === selectedPath && call.startLine === position.line + 1 &&
                position.character >= call.startColumn && position.character < call.endColumn).map((call) => call.target));
            if (targets.size === 1) destructorTarget = targets.values().next().value;
        }
        if (destructorTarget && operation !== "lifetimeReferenceTarget") return sidecarLifetimeReferences(model, destructorTarget,
            operation === "highlights" ? uri : null, checkCancelled,
            operation === "highlights" || Boolean(input.includeDeclaration), destructorProcedure?.declarations || [], "destructor");
        const procedureTarget = sidecarLifetimeTargetAtProcedure(model, constructorProcedure, constructorProcedure?.declarations || []);
        const callContext = hoverCallContext(document, positionOffset(document, position.line, position.character));
        const callee = callContext && callNameSpan(document, callContext);
        const onCallee = callee && (document.byLine.get(position.line) || []).some((token) =>
            token.end === callee.end && position.character >= token.startColumn && position.character < token.endColumn);
        const selectedConstructor = onCallee
            ? compilerSelectedConstructorProcedure(model, uri, document, callContext, checkCancelled) : null;
        const callProcedure = selectedConstructor &&
            model.compilerProcedureKindsBySemanticIdentity?.get(selectedConstructor.symbol) === "constructor"
            ? selectedConstructor : model.semanticSidecarOnly && callContext && (operation !== "lifetimeReferenceTarget" || onCallee)
                ? compilerSelectedSidecarNewConstructorProcedure(model, uri, document, callContext, checkCancelled) : null;
        const explicitTarget = typedOperation || model.semanticSidecarOnly && (operation !== "lifetimeReferenceTarget" || onCallee)
            ? compilerSelectedImplicitConstructorTargetAtPosition(model, uri, document, position,
                new Set(["explicit-constructor"]), checkCancelled) : 0;
        const argumentTarget = !typedOperation && operation === "lifetimeReferenceTarget" && !destructorTarget && !procedureTarget && !explicitTarget &&
            !callProcedure && !resolve().length ? compilerSelectedImplicitConstructorTargetAtPosition(
                model, uri, document, position, new Set(["argument-constructor"]), checkCancelled) : 0;
        let constructorTarget = procedureTarget || explicitTarget || callProcedure?.symbol || argumentTarget || 0;
        // TYPE owns its explicit construction, even when an enclosing call
        // performs another constructor conversion at that same physical span.
        if (typedOperation) constructorTarget = model.partial ? 0 : explicitTarget;
        if (operation === "lifetimeReferenceTarget" && !procedureTarget && resolve().length &&
            !resolve().some((entry) => TYPE_HIERARCHY_TYPES.has(entry.declaration.type) || entry.declaration.type === "constructor")) {
            constructorTarget = 0;
        }
        if (operation === "lifetimeReferenceTarget") {
            const target = destructorTarget || constructorTarget;
            const kind = destructorTarget ? "destructor" : "constructor";
            const site = target && !model.partial && model.semanticBindings?.length
                ? sidecarLifetimeDeclarationOccurrences(model, target, null, [], checkCancelled, kind)[0] : null;
            return { occurrence: model.tokenAt(uri, position.line, position.character)?.token || null,
                entries: site ? [{ name: site.occurrence.name, compilerSymbolId: target,
                    uri: uriRecord(site.uri), declaration: { type: kind, line: site.occurrence.line,
                        endColumn: site.occurrence.endColumn } }] : [],
                ...(input.includeDeclarations === true ? { declarations: site
                    ? (compilerSidecarProcedureDeclarationSites(model, { targetSymbols: [target] }, checkCancelled) || []).map((entry) => ({
                        uri: uriRecord(CompilerUri.file(entry.filePath)), kind: entry.kind, occurrence: {
                            line: entry.startLine - 1, startColumn: entry.startColumn,
                            endLine: entry.endLine - 1, endColumn: entry.endColumn
                        }
                    })) : [] } : {}) };
        }
        if (constructorTarget) return sidecarLifetimeReferences(model, constructorTarget,
            operation === "highlights" ? uri : null, checkCancelled,
            operation === "highlights" || Boolean(input.includeDeclaration), typedOperation ? [] : constructorProcedure?.declarations || []);
        if (typedOperation) return [];
        if (model.semanticSidecarOnly) {
            const selection = compilerSidecarNavigationSelection(model, uri, document, position, checkCancelled);
            if (selection) {
                if (!selection.symbol) return [];
                const records = compilerSidecarNavigationOccurrences(model, selection,
                    operation === "highlights" || Boolean(input.includeDeclaration),
                    operation === "highlights" ? uri : null, checkCancelled);
                return (records || []).map((entry) => ({
                    uri: uriRecord(entry.uri),
                    occurrence: {
                        line: entry.occurrence.line,
                        startColumn: entry.occurrence.startColumn,
                        endColumn: entry.occurrence.endColumn
                    },
                    ...(entry.accessRole ? { accessRole: entry.accessRole } : {})
                }));
            }
        }
        const lifetimeDeclaration = compilerLifetimeDeclarationEntryAtPosition(model, uri, document, position);
        let targets = lifetimeDeclaration ? [lifetimeDeclaration] : resolve();
        if (callContext?.indexing && !compilerIdentifierTokenAtPosition(document, position)) {
            const candidates = indexOperatorCandidates(model, uri, document, callContext);
            const selected = compilerSelectedIndexOperatorCandidates(model, uri, document, position, candidates, checkCancelled);
            const candidateIds = new Set(candidates.map((entry) =>
                model.canonicalSymbolIds?.get(entry.compilerSymbolId) || entry.compilerSymbolId || 0
            ).filter(Boolean));
            if (selected.length) targets = [selected[0]];
            else if (candidateIds.size === 1 && candidates.length) targets = [candidates[0]];
            else targets = [];
        } else if (callContext && !targets.length) {
            const argumentConstructor = compilerSelectedImplicitConstructorTargetAtPosition(
                model, uri, document, position, new Set(["argument-constructor"]), checkCancelled
            );
            if (argumentConstructor) return sidecarLifetimeReferences(model, argumentConstructor,
                operation === "highlights" ? uri : null, checkCancelled,
                operation === "highlights" || Boolean(input.includeDeclaration));
        } else if (callContext && targets.some((entry) => ["type", "class", "union"].includes(entry.declaration.type))) {
            const constructors = constructorEntries(model, uri, document, callContext);
            const selectedTarget = compilerSelectedNewConstructorTarget(model, uri, document, callContext, constructors, checkCancelled) ||
                compilerSelectedCallTarget(model, uri, document, callContext, checkCancelled);
            const selected = selectedTarget
                ? constructors.filter((entry) => nativeSymbolId(model, entry) === selectedTarget)
                : [];
            const identities = new Set(constructors.map((entry) => nativeSymbolId(model, entry)));
            if (selected.length) targets = selected;
            else if (identities.size === 1 && constructors.length) targets = constructors;
            else targets = [];
        } else if (!targets.length) {
            targets = indexOperatorDeclarationAt(model, uri, position);
        }
        if (targets.length !== 1) return [];
        const token = { get isCancellationRequested() { checkCancelled(); return false; } };
        if (operation === "highlights" && uri.toString() === model.expandedUri.toString()) {
            // Physical projections are navigation targets, not coordinates in
            // this read-only view. Its compiler-bound inner occurrences use
            // the expanded document's own token positions.
            return model.inner.references(targets[0], true, token)
                .filter((entry) => entry.uri.toString() === uri.toString())
                .map((entry) => ({ uri: uriRecord(entry.uri), occurrence: entry.occurrence }));
        }
        const references = model.references(targets[0], operation === "highlights" || Boolean(input.includeDeclaration), token);
        references.push(...compilerIndexOperatorReferences(model, targets[0], operation === "highlights" ? uri : null, checkCancelled));
        references.push(...compilerNewConstructorReferences(model, targets[0], operation === "highlights" ? uri : null, checkCancelled));
        references.push(...compilerLifetimeReferences(model, targets[0], operation === "highlights" ? uri : null, checkCancelled));
        const accessRoles = operation === "highlights"
            ? compilerSemanticAccessRolesForDocument(model, uri, document, checkCancelled)
            : null;
        return [...new Map(references
            .filter((entry) => operation !== "highlights" || entry.uri.toString() === uri.toString())
            .map((entry) => [`${entry.uri.toString()}:${entry.occurrence.line}:${entry.occurrence.startColumn}:${entry.occurrence.endColumn}`, entry]))
            .values()]
            .map((entry) => {
                const record = { uri: uriRecord(entry.uri), occurrence: entry.occurrence };
                if (accessRoles && entry.uri.toString() === uri.toString()) {
                    const offset = positionOffset(document, entry.occurrence.line, entry.occurrence.startColumn);
                    const role = accessRoles.get(offset);
                    if (role) record.accessRole = role;
                }
                return record;
            });
    }
    if (operation === "signature") {
        if (!inCode()) return null;
        let context = findSignatureCallContextInMaskedText(document.masked, positionOffset(document, position.line, position.character));
        if (!context) return null;
        const methodName = (!context.bare || context.expressionCallee) && !context.indexing
            ? compilerMemberMethodName(model, uri, document, context, checkCancelled) : null;
        if (methodName) context = { ...context, name: methodName, memberCall: true };
        if (context.expressionCallee && !context.indexing && !methodName) {
            const arraySignature = compilerExpressionArrayIndexSignature(model, uri, document, context, checkCancelled);
            if (arraySignature) return { context: { ...context, name: arraySignature.name }, entries: [], arraySignature };
            const signature = compilerExpressionPointerSignature(model, uri, document, context, checkCancelled);
            return { context: signature ? { ...context, name: signature.name } : context, entries: [],
                ...(signature ? { procedurePointerSignature: signature } : {}) };
        }
        if (context.indexing) {
            const candidates = context.expressionCallee ? compilerExpressionIndexSignatureEntries(model, uri, document, context, checkCancelled)
                : indexOperatorCandidates(model, uri, document, context);
            const entries = candidates.length ? selectedIndexOperatorEntries(model, candidates)
                : recoveredIndexSignatureEntries(model, uri, document, context, checkCancelled);
            const selected = compilerSelectedIndexOperatorCandidates(model, uri, document, position, candidates, checkCancelled);
            return {
                context,
                entries: entries.map((entry) => entryRecordWithHeaderLibraries(model, entry)),
                selectedCompilerSymbolId: selected[0]?.compilerSymbolId || 0
            };
        }
        if (context.typedConstructor) {
            const target = compilerSelectedImplicitConstructorTargetAtPosition(model, uri, document,
                positionAtOffset(document, context.calleeStartOffset), new Set(["explicit-constructor"]), checkCancelled);
            const entries = compilerConstructorDeclarationEntries(model, target, checkCancelled);
            if (!entries?.length) {
                const recovered = recoveredTypedConstructorEntries(model, uri, document, context, checkCancelled);
                return recovered.length ? { context, entries: recovered.map((entry) => entryRecordWithHeaderLibraries(model, entry)),
                    selectedCompilerSymbolId: 0 } : null;
            }
            // TYPE<...> can contain TYPEOF or qualified aliases. Its spelling
            // supplies no overload or type inference; the counted native
            // temporary selection already owns the constructor decision.
            // A prototype and body share the target. Prefer the prototype's
            // written optional defaults instead of displaying duplicate rows.
            const selected = entries.find((entry) => entry.declaration.modifiers.includes("DECLARE")) || entries[0];
            return { context, entries: [entryRecordWithHeaderLibraries(model, selected)],
                selectedCompilerSymbolId: target };
        }
        const before = document.text.slice(0, context.openParenthesisOffset).trimEnd();
        const calleeOffset = context.sizedCast ? context.calleeStartOffset : before.length - 1;
        const call = document.tokens.find((token) => token.offset <= calleeOffset && token.end > calleeOffset);
        let resolved = call ? model.resolveAt(uri, call.line, call.startColumn) : [];
        let recovering = false;
        if (!resolved.length) {
            const recovered = compilerVisibleSignatureEntries(model, uri, call, checkCancelled);
            if (recovered.length) {
                resolved = recovered;
                recovering = true;
            }
        }
        const macroSignature = model.semanticSidecarOnly && call?.kind === "identifier"
            ? model.compilerMacroSignatureAt?.(uri, call.name, call.line + 1, call.startColumn, call.endColumn)
            : null;
        if (macroSignature && !context.bare) return { context, entries: [], macroSignature };
        const pointerSignature = compilerProcedurePointerSignature(model, uri, document, context, call, resolved, checkCancelled);
        if (pointerSignature) return { context, entries: [], procedurePointerSignature: pointerSignature };
        const arraySignature = compilerArrayIndexSignature(model, uri, document, context, call, resolved, checkCancelled);
        if (arraySignature) return { context, entries: [], arraySignature };
        if (call && !context.bare && !context.memberCall && !resolved.some((entry) => SIGNATURE_CALLABLE_TYPES.has(entry.declaration.type))) {
            const constructors = constructorEntries(model, uri, document, context, recovering ? resolved : null);
            const selectedProcedure = compilerSelectedConstructorProcedure(model, uri, document, context, checkCancelled);
            if (selectedProcedure) {
                const declarations = compilerConstructorDeclarationEntries(model, selectedProcedure.symbol, checkCancelled);
                const selected = declarations?.find((entry) => !entry.declaration.modifiers.includes("DECLARE")) || declarations?.[0];
                if (selected) return { context, entries: [entryRecordWithHeaderLibraries(model, selected)],
                    selectedCompilerSymbolId: selected.compilerSymbolId, selectedConstructorProcedure: selectedProcedure };
                if (model.semanticSidecarOnly) return { context, entries: [], selectedConstructorProcedure: selectedProcedure };
            }
            if (constructors.length) {
                const selectedTarget = recovering ? 0 : compilerSelectedNewConstructorTarget(model, uri, document, context, constructors, checkCancelled) ||
                    compilerSelectedCallTarget(model, uri, document, context, checkCancelled);
                const selected = selectedTarget
                    ? constructors.filter((entry) => nativeSymbolId(model, entry) === selectedTarget)
                    : [];
                const entries = selected.length ? selected : constructors;
                return {
                    context,
                    entries: entries.map((entry) => entryRecordWithHeaderLibraries(model, entry)),
                    selectedCompilerSymbolId: selected[0]?.compilerSymbolId || 0
                };
            }
        }
        if (model.semanticSidecarOnly) {
            const selectedSidecarDeclarations = compilerSidecarSelectedCallDeclarations(
                model, checkCancelled, uri, document, context
            );
            if (selectedSidecarDeclarations.length) {
                /* A cached binding model can be used directly by the editor,
                   without a source-model overload list to join these sites.
                   Reuse navigation's exact native declaration lookup for the
                   selected signature. Keep the sites for source-mode callers. */
                const symbol = compilerSidecarCanonicalSymbol(model, selectedSidecarDeclarations[0].symbol);
                const entries = compilerSidecarSignatureEntries(model, symbol, uri, document, call, checkCancelled);
                return { context, selectedSidecarDeclarations,
                    ...(entries.some((entry) => SIGNATURE_CALLABLE_TYPES.has(entry.declaration.type))
                        ? { selectedCompilerSymbolId: symbol } : {}),
                    entries: entries.map((entry) => entryRecordWithHeaderLibraries(model, entry)) };
            }
        }
        const callableCandidates = resolved.filter((entry) => SIGNATURE_CALLABLE_TYPES.has(entry.declaration.type));
        let selectedCompilerSymbolId = !recovering && callableCandidates.length > 1
            ? compilerSelectedCallTarget(model, uri, document, context, checkCancelled)
            : 0;
        if (!recovering && !model.semanticSidecarOnly && model.inventory && call?.kind === "identifier") {
            /* A committed binding can name only the selected overload. Avoid
               the AST lookup for single-signature families, then preserve the
               compiler's actual call target while displaying its siblings. */
            const hasAlternatives = callableCandidates.some((entry) => entry.nativeSymbol &&
                (model.inner.byQualifiedName.get(entry.qualifiedName) || []).some((other) =>
                    other.nativeSymbol?.owner === entry.nativeSymbol.owner &&
                    SIGNATURE_CALLABLE_TYPES.has(other.declaration.type) &&
                    (!entry.declaration.propertyRole || other.declaration.propertyRole === entry.declaration.propertyRole) &&
                    nativeSymbolId(model, other) !== nativeSymbolId(model, entry)));
            if (hasAlternatives) {
                const selected = selectedCompilerSymbolId || compilerSelectedCallTarget(model, uri, document, context, checkCancelled);
                if (selected) {
                    const family = compilerVisibleSignatureEntries(model, uri, call, checkCancelled, selected);
                    const selectedEntry = family.find((entry) => nativeSymbolId(model, entry) === selected);
                    if (selectedEntry) {
                        resolved = family.filter((entry) => !selectedEntry.declaration.propertyRole ||
                            entry.declaration.propertyRole === selectedEntry.declaration.propertyRole);
                        selectedCompilerSymbolId = selected;
                    }
                }
            }
        }
        return {
            context,
            entries: resolved.map((entry) => entryRecordWithHeaderLibraries(model, entry)),
            selectedCompilerSymbolId
        };
    }
    if (operation === "semanticTokens") {
        let tokenCache = semanticTokenCaches.get(model);
        if (!tokenCache) {
            tokenCache = { entries: new Map(), bytes: 0 };
            semanticTokenCaches.set(model, tokenCache);
        }
        const cacheKey = uri.toString();
        const cached = tokenCache.entries.get(cacheKey);
        if (cached) {
            tokenCache.entries.delete(cacheKey);
            tokenCache.entries.set(cacheKey, cached);
            return cached.data.slice();
        }

        const records = [];
        const sourcePath = document.uri.fsPath || document.uri.path;
        const primitiveTypes = sourcePath ? model.compilerPrimitiveTypesByFile?.get(compilerSidecarNavigationPathKey(sourcePath)) || [] : [];
        const primitiveTokens = new Map();
        const accessRoles = compilerSemanticAccessRolesForDocument(model, uri, document, checkCancelled);
        const readonlyTokens = compilerSemanticReadonlyTokens(model, uri, document, checkCancelled);
        for (const occurrence of document.tokens) {
            checkCancelled();
            if (occurrence.kind !== "identifier" && !model.isNativeSymbolToken(document, occurrence)) continue;
            if (primitiveTypes.length && occurrence.kind === "identifier") primitiveTokens.set(
                `${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`, occurrence);
            const targets = model.resolveToken(document, occurrence);
            if (targets.length !== 1) continue;
            const entry = targets[0], declaration = document.entriesByOffset.get(occurrence.offset);
            const modifiers = [];
            if (declaration) modifiers.push(declaration.declaration.modifiers.includes("DECLARE") ? "declaration" : "definition");
            if (semanticEntryIsReadonly(entry, readonlyTokens.has(occurrence.offset) ||
                model.compilerFactsByNativeSymbolId?.get(entry.compilerSymbolId)?.valueConst === true)) modifiers.push("readonly");
            if (entry.declaration.modifiers.includes("STATIC")) modifiers.push("static");
            if (entry.declaration.modifiers.includes("ABSTRACT")) modifiers.push("abstract");
            if (semanticEntryIsDeprecated(entry)) modifiers.push("deprecated");
            const accessRole = accessRoles.get(occurrence.offset);
            if (accessRole === "write" || accessRole === "read-write") modifiers.push("modification");
            records.push({
                line: occurrence.line,
                character: occurrence.startColumn,
                length: occurrence.endColumn - occurrence.startColumn,
                type: TOKEN_TYPES.indexOf(semanticTokenType(entry)),
                modifiers: modifiers.reduce((bits, modifier) => bits | (1 << TOKEN_MODIFIERS.indexOf(modifier)), 0)
            });
        }
        records.push(...compilerSidecarPhysicalIdentifierSemanticTokens(model, uri, document, accessRoles, checkCancelled, readonlyTokens));
        const classified = new Set(records.map((record) => `${record.line}:${record.character}:${record.length}`));
        for (const input of primitiveTypes) {
            checkCancelled();
            if (input.startLine !== input.endLine) continue;
            const occurrence = primitiveTokens.get(`${input.startLine - 1}:${input.startColumn}:${input.endColumn}`);
            if (!occurrence) continue;
            const key = `${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn - occurrence.startColumn}`;
            if (classified.has(key)) continue; // Never overwrite a native symbol/alias at a shared physical site.
            classified.add(key);
            records.push({ line: occurrence.line, character: occurrence.startColumn, length: occurrence.endColumn - occurrence.startColumn,
                type: TOKEN_TYPES.indexOf("type"), modifiers: 1 << TOKEN_MODIFIERS.indexOf("defaultLibrary") });
        }
        records.sort((first, second) => first.line - second.line || first.character - second.character || first.length - second.length);
        const data = [];
        let previousLine = 0, previousColumn = 0, previousRange = "";
        for (const record of records) {
            const rangeKey = `${record.line}:${record.character}:${record.length}`;
            if (rangeKey === previousRange) continue;
            previousRange = rangeKey;
            // VS Code's semantic-token wire layout is five unsigned integers:
            // delta line, delta column, length, legend type, modifier bit set.
            const lineDelta = record.line - previousLine;
            data.push(lineDelta, lineDelta ? record.character : record.character - previousColumn,
                record.length, record.type, record.modifiers);
            previousLine = record.line;
            previousColumn = record.character;
        }
        const result = new Uint32Array(data);
        if (result.byteLength <= MAX_SEMANTIC_TOKEN_CACHE_BYTES) {
            while (tokenCache.entries.size >= MAX_SEMANTIC_TOKEN_CACHE_DOCUMENTS ||
                tokenCache.bytes + result.byteLength > MAX_SEMANTIC_TOKEN_CACHE_BYTES) {
                const oldestKey = tokenCache.entries.keys().next().value;
                if (oldestKey === undefined) break;
                const oldest = tokenCache.entries.get(oldestKey);
                tokenCache.entries.delete(oldestKey);
                tokenCache.bytes -= oldest.data.byteLength;
            }
            tokenCache.entries.set(cacheKey, { data: result });
            tokenCache.bytes += result.byteLength;
        }
        return result.slice();
    }
    throw new Error(`Unsupported compiler model query: ${operation}`);
}

module.exports = { procedurePointerSignature, queryCompilerModel, compilerLifetimeReferenceUnit, compilerOperatorReferenceUnit };

/* end of lib/compiler-model-queries.js */
