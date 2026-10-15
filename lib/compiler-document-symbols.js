/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-document-symbols.js
    Purpose: Present native declarations as document and workspace symbols.
    Responsibilities: preserve physical hierarchy, selection ranges, and ownership.
    Does not contain: declaration parsing, guessed scopes, or compiler execution.
*/

const { positionOffset } = require("./semantic-model");
const { compilerConstantValue } = require("./compiler-constant-values");
const { semanticEntryIsDeprecated } = require("./semantic-token-data");
/* Avoid expanding malformed rank metadata into an oversized Outline label. */
const MAX_OUTLINE_ARRAY_RANK = 32;
/* The compiler serializes array element counts as an unsigned 64-bit decimal. */
const MAX_ARRAY_ELEMENT_COUNT_DIGITS = 20;
const COMPILER_TYPED_SYMBOL_KINDS = new Set([
    "variable", "const", "enumMember", "enum-member", "field", "parameter", "property", "function"
]);
const COMPILER_OUTLINE_PROCEDURE_TYPES = new Set([
    "function", "sub", "property", "operator", "constructor", "destructor"
]);
const COMPILER_OUTLINE_CALLING_CONVENTIONS = new Set([
    "basic", "cdecl", "stdcall", "stdcall-ms", "pascal", "thiscall", "fastcall"
]);
const COMPILER_OUTLINE_LINKAGES = new Set(["basic", "c", "windows", "windows-ms", "c++", "pascal", "rtlib"]);
const COMPILER_OUTLINE_FOREIGN_LINKAGES = {
    c: "C",
    "c++": "C++",
    windows: "Windows",
    "windows-ms": "Microsoft Windows",
    pascal: "Pascal"
};

function uriRecord(uri) { return { scheme: uri.scheme, fsPath: uri.fsPath, path: uri.path, value: uri.toString() }; }
function before(first, second) { return first.line < second.line || first.line === second.line && first.character < second.character; }
function endOf(token) { return { line: token.line, character: token.endColumn }; }

function compilerDocumentationSummary(declaration) {
    const documentation = declaration?.documentation;
    if (typeof documentation !== "string" || !documentation || documentation.length > 4096) return "";
    const firstLine = documentation.split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .find((line) => line && !/^[@\\][A-Za-z]/.test(line) && !/^```/.test(line));
    if (!firstLine) return "";
    if (firstLine.length <= 120) return firstLine;
    return `${firstLine.slice(0, 117).trimEnd()}...`;
}

function compilerSymbolTypeDetail(entry) {
    const declaration = entry?.declaration;
    const typeName = typeof declaration?.typeName === "string" ? declaration.typeName.trim() : "";
    if (!COMPILER_TYPED_SYMBOL_KINDS.has(declaration?.type) || !typeName || typeName.length > 512) return "";
    const detail = String(declaration.detail || declaration.type).replace(/\s+/g, " ").trim();
    const typeSuffix = `As ${typeName}`.toLowerCase();
    return detail.toLowerCase().endsWith(typeSuffix) ? "" : ` As ${typeName}`;
}

function compilerImplicitTypeSummary(entry) {
    const declaration = entry?.declaration;
    const facts = entry?.compilerFacts;
    if (entry?.provisional || declaration?.provisional || !facts) return "";
    if (["function", "property"].includes(declaration.type)) {
        const inputs = facts.procedureTypingInputs;
        if (Array.isArray(inputs) && inputs.length && inputs.every((input) =>
            input?.provisional !== true && input.kind === declaration.type && input.resultForm === "implicit")) {
            return "implicit return type";
        }
    }
    if (declaration.type === "parameter") {
        const writtenTypes = facts.formalWrittenTypes;
        if (Array.isArray(writtenTypes) && writtenTypes.length && writtenTypes.every((writtenType) => writtenType === "implicit")) {
            return "implicit parameter type";
        }
    }
    if (["variable", "const"].includes(declaration.type)) {
        const inputs = facts.declarationInputs;
        if (!Array.isArray(inputs) || !inputs.length || inputs.some((input) => input?.provisional === true)) return "";
        const writtenTypes = new Set(inputs.map((input) => input.writtenType));
        if (writtenTypes.size === 1 && writtenTypes.has("implicit")) return "implicit type";
        if (writtenTypes.size === 1 && writtenTypes.has("inferred")) return "inferred type";
    }
    return "";
}

function compilerImplicitStorageSummary(entry) {
    const declaration = entry?.declaration;
    const redimDeclaration = declaration?.type === "variable" && typeof declaration.sourceLine === "string" &&
        /^\s*(?:(?:public|private|protected|shared|static|common|extern)\s+)*redim(?:\s+shared)?\b/i.test(
            declaration.sourceLine
        );
    if (entry?.provisional || declaration?.provisional || declaration?.type !== "variable" ||
        typeof declaration.signature !== "string" ||
        (!/^variable\s+/i.test(declaration.signature) && !redimDeclaration)) return "";
    const storage = entry.compilerFacts?.compilerStorageClass;
    return ["external", "static", "local", "shared", "global"].includes(storage)
        ? `storage: ${storage}`
        : "";
}

function compilerParameterOutlineSummary(entry) {
    if (entry?.provisional || entry?.declaration?.provisional || entry?.declaration?.type !== "parameter") return "";
    const parameter = entry.compilerFacts?.parameterPassing;
    const modes = { byval: "ByVal", byref: "ByRef", bydesc: "ByDesc", vararg: "VarArg" };
    if (!parameter || parameter.receiver === true || !Object.hasOwn(modes, parameter.mode) ||
        typeof parameter.optional !== "boolean") return "";
    let mode = modes[parameter.mode];
    if ((parameter.mode === "byval" || parameter.mode === "byref") &&
        compilerSemanticPropertyInteger(entry.compilerFacts, "formal-written-mode") === 0) {
        mode += " (keyword omitted)";
    }
    if (parameter.mode === "bydesc") {
        if (parameter.dimensions === -1) mode += " (any array rank)";
        else if (Number.isSafeInteger(parameter.dimensions) && parameter.dimensions > 0) {
            mode += ` (rank ${parameter.dimensions})`;
        }
    }
    const details = [mode];
    if (parameter.optional) details.push("Optional");
    return `passing: ${details.join(", ")}`;
}

function compilerArrayBoundsSummary(compilerFacts) {
    const bounds = compilerFacts?.arrayBounds;
    if (!bounds || !["bounds", "runtime"].includes(bounds.mode)) return "";
    if (bounds.mode === "runtime") {
        if (bounds.rank === null) return "runtime array";
        return Number.isSafeInteger(bounds.rank) && bounds.rank > 0
            ? `runtime array, rank ${bounds.rank}`
            : "";
    }
    if (!Number.isSafeInteger(bounds.rank) || bounds.rank < 1 || bounds.rank > MAX_OUTLINE_ARRAY_RANK ||
        !Array.isArray(bounds.dimensions) || bounds.dimensions.length !== bounds.rank) return "";
    const dimensions = [];
    let expectedElements = 1n;
    let fixedBounds = true;
    for (let index = 0; index < bounds.dimensions.length; index++) {
        const dimension = bounds.dimensions[index];
        if (!dimension || dimension.dimension !== index || !Number.isSafeInteger(dimension.lower) ||
            !["fixed", "unknown"].includes(dimension.kind)) return "";
        if (dimension.kind === "fixed") {
            if (!Number.isSafeInteger(dimension.upper) || dimension.upper < dimension.lower) return "";
            dimensions.push(`${dimension.lower} to ${dimension.upper}`);
            expectedElements *= BigInt(dimension.upper) - BigInt(dimension.lower) + 1n;
        } else {
            dimensions.push(`${dimension.lower} to unknown`);
            fixedBounds = false;
        }
    }
    let elementSummary = "";
    let verifiedElementCount = null;
    if (fixedBounds && expectedElements >= 0n) {
        const elementCounts = new Set((compilerFacts.properties || [])
            .filter((property) => property.name === "array-elements" && property.provisional !== true &&
                typeof property.value === "string" && property.value.length <= MAX_ARRAY_ELEMENT_COUNT_DIGITS &&
                /^(?:0|[1-9]\d*)$/.test(property.value))
            .map((property) => property.value));
        if (elementCounts.size === 1) {
            const [elementCount] = elementCounts;
            if (BigInt(elementCount) === expectedElements) {
                elementSummary = `; ${elementCount} elements`;
                verifiedElementCount = expectedElements;
            }
        }
    }
    const storage = compilerFacts?.storageType;
    const passing = compilerFacts?.parameterPassing;
    let elementStorageSummary = "";
    if (verifiedElementCount !== null && verifiedElementCount > 0n && storage && storage.isReference !== true &&
        typeof storage.isReference === "boolean" && Number.isSafeInteger(storage.storageBytes) &&
        storage.storageBytes > 0 && Number.isSafeInteger(storage.pointerDepth) && storage.pointerDepth >= 0 &&
        typeof storage.primitive === "string" && passing?.receiver !== true &&
        passing?.mode !== "bydesc" && passing?.mode !== "vararg") {
        const totalBytes = verifiedElementCount * BigInt(storage.storageBytes);
        elementStorageSummary = `; element storage: ${totalBytes} bytes`;
        if (storage.pointerDepth > 0) elementStorageSummary += " (pointed-to storage is separate)";
        if (["string", "wstring", "ustring"].includes(storage.primitive)) {
            elementStorageSummary += " (allocated string data is separate)";
        }
    }
    return `bounds: ${dimensions.join(", ")}${elementSummary}${elementStorageSummary}`;
}

function compilerFieldLayoutSummary(entry) {
    if (entry?.declaration?.type !== "field") return "";
    const layout = entry.compilerFacts?.fieldLayout;
    if (!layout || !Number.isSafeInteger(layout.byteOffset) || layout.byteOffset < 0) return "";
    const offsetUnit = layout.byteOffset === 1 ? "byte" : "bytes";
    let summary = `offset: ${layout.byteOffset} ${offsetUnit}`;
    const bitPosition = compilerSemanticPropertyInteger(entry.compilerFacts, "bit-position");
    const bitWidth = compilerSemanticPropertyInteger(entry.compilerFacts, "bit-width");
    if (bitPosition !== null && bitWidth !== null && bitWidth > 0) {
        summary += `, bit position: ${bitPosition}, width: ${bitWidth} bits`;
    }
    return summary;
}

function compilerAggregateLayoutSummary(entry) {
    if (!entry || !["type", "class", "union"].includes(entry.declaration?.type)) return "";
    const facts = entry.compilerFacts;
    const details = [];
    const size = facts?.aggregateSizeBytes;
    if (Number.isSafeInteger(size) && size > 0) details.push(`size: ${size} ${size === 1 ? "byte" : "bytes"}`);
    const alignment = compilerSemanticPropertyInteger(facts, "natural-alignment");
    if (alignment !== null && alignment > 0) {
        details.push(`alignment: ${alignment} ${alignment === 1 ? "byte" : "bytes"}`);
    }
    const packing = compilerSemanticPropertyInteger(facts, "packing-alignment");
    if (packing !== null && packing > 0) {
        details.push(`packing: ${packing} ${packing === 1 ? "byte" : "bytes"}`);
    }
    return details.length ? `layout: ${details.join(", ")}` : "";
}

function compilerMemberAccessSummary(entry) {
    const declaration = entry?.declaration;
    const qualifiedName = declaration?.qualifiedName || entry?.qualifiedName || "";
    if (!declaration?.containerName && !String(qualifiedName).includes(".")) return "";
    const visibility = entry.compilerFacts?.compilerVisibility;
    if (!["public", "protected", "private"].includes(visibility)) return "";
    return `${visibility[0].toUpperCase()}${visibility.slice(1)} access`;
}

function compilerDefaultProcedureVisibilitySummary(entry) {
    const declaration = entry?.declaration;
    if (entry?.provisional || declaration?.provisional || !["function", "sub"].includes(declaration?.type) ||
        declaration.modifiers?.includes("DECLARE") || declaration.containerName ||
        String(declaration.qualifiedName || entry?.qualifiedName || "").includes(".")) return "";
    const facts = entry.compilerFacts;
    const visibilityInputs = facts?.procedureWrittenVisibility;
    const typingInputs = facts?.procedureTypingInputs;
    if (!Array.isArray(visibilityInputs) || visibilityInputs.length !== 1 ||
        !Array.isArray(typingInputs) || typingInputs.length !== 1) return "";
    const [visibilityInput] = visibilityInputs;
    const [typingInput] = typingInputs;
    const visibility = facts.compilerVisibility;
    if (visibilityInput.provisional === true || typingInput.provisional === true ||
        visibilityInput.visibility !== "default" || typingInput.role !== "definition" ||
        visibilityInput.statement !== typingInput.statement || !["public", "private"].includes(visibility)) return "";
    return `${visibility[0].toUpperCase()}${visibility.slice(1)} by scope default`;
}

function compilerOverrideSummary(entry) {
    if (entry?.provisional || entry?.declaration?.provisional ||
        !["function", "sub", "property", "operator"].includes(entry?.declaration?.type)) return "";
    const target = entry.compilerFacts?.overriddenProcedure?.qualifiedName;
    if (typeof target === "string" && target && target.length <= 512 && !/[\r\n]/.test(target)) {
        return `overrides ${target}`;
    }
    return Number.isSafeInteger(entry.compilerFacts?.overriddenProcedure?.compilerSymbolId) &&
        entry.compilerFacts.overriddenProcedure.compilerSymbolId > 0
        ? "overrides compiler-selected base method"
        : "";
}

function compilerBaseTypeSummary(entry) {
    const declaration = entry?.declaration;
    if (!declaration || !["type", "class"].includes(declaration.type) || declaration.detail === "Type alias") return "";
    const baseType = declaration.baseType;
    if (typeof baseType !== "string" || !baseType || baseType.length > 512 || /[\r\n]/.test(baseType)) return "";
    return `extends ${baseType}`;
}

function compilerAbstractMemberSummary(entry) {
    if (entry?.provisional || entry?.declaration?.provisional ||
        !["type", "class"].includes(entry?.declaration?.type)) return "";
    const count = entry.compilerFacts?.abstractMemberCount;
    if (!Number.isSafeInteger(count) || count <= 0) return "";
    return `${count} unimplemented abstract ${count === 1 ? "member" : "members"}`;
}

function compilerProcedureOutlineAbiSummary(entry) {
    if (!entry || entry.provisional || entry.declaration?.provisional ||
        !COMPILER_OUTLINE_PROCEDURE_TYPES.has(entry.declaration?.type)) return "";
    const facts = entry.compilerFacts;
    const convention = facts?.procedureCallingConvention;
    if (!COMPILER_OUTLINE_CALLING_CONVENTIONS.has(convention)) return "";
    const linkages = new Set((facts.properties || [])
        .filter((property) => property.name === "procedure-linkage" && property.provisional !== true &&
            typeof property.value === "string" && COMPILER_OUTLINE_LINKAGES.has(property.value))
        .map((property) => property.value));
    if (linkages.size > 1) return "";

    const parts = [];
    let foreignLinkage = false;
    if (linkages.size === 1) {
        const linkage = linkages.values().next().value;
        if (COMPILER_OUTLINE_FOREIGN_LINKAGES[linkage]) {
            parts.push(`${COMPILER_OUTLINE_FOREIGN_LINKAGES[linkage]} linkage`);
            foreignLinkage = true;
        }
    }
    if (foreignLinkage && convention !== "basic") parts.push(convention);
    if (facts.procedureReturnsByReference === true) parts.push("ByRef return");
    return parts.length ? `ABI: ${parts.join(", ")}` : "";
}

function compilerSemanticPropertyInteger(compilerFacts, name) {
    const values = new Set();
    for (const property of compilerFacts?.properties || []) {
        if (property.name !== name || property.provisional === true ||
            typeof property.value !== "string" || !/^(?:0|[1-9]\d*)$/.test(property.value)) continue;
        const value = Number(property.value);
        if (Number.isSafeInteger(value)) values.add(value);
    }
    return values.size === 1 ? values.values().next().value : null;
}

function compilerSymbolRecords(model, uri, checkCancelled = () => {}, options = {}) {
    if (!model.inventory) return [];
    const expanded = model.inner.getDocument(model.expandedUri);
    const inventory = model.inventory;
    const workspaceOnly = options.workspaceOnly === true;
    const expandedView = uri?.toString() === model.expandedUri.toString();
    const records = [];
    const byEntry = workspaceOnly ? null : new Map();
    const byDeclaration = workspaceOnly ? null : new Map();
    const byScope = workspaceOnly ? null : new Map();
    const projected = workspaceOnly ? null : new Map();
    // Closing keywords from direct source locate native block ends. A macro's
    // replacement-list tokens can point back to an earlier definition, so they
    // must not enlarge a caller's Outline range to include that definition.
    if (!workspaceOnly) {
        for (const token of expanded.tokens) {
            const physical = model.expandedToSource.get(token.offset);
            if (!physical || physical.sourceMap) continue;
            const key = physical.uri.toString();
            if (!projected.has(key)) projected.set(key, []);
            projected.get(key).push({ offset: token.offset, end: token.end, occurrence: physical.occurrence });
        }
    }
    const nativeEnd = (entry, record) => entry.bodyScope?.nativeId ? inventory.nativeScopes.get(entry.bodyScope.nativeId).end : record.end;
    const selection = (entry, record) => {
        const point = expandedView || entry.uri.toString() === model.expandedUri.toString() ? record.start : { line: entry.declaration.line, character: entry.declaration.startColumn };
        return { start: point, end: { line: point.line, character: point.character + entry.name.length } };
    };
    const physicalEnd = (entry, record, selected) => {
        const end = nativeEnd(entry, record);
        if (expandedView || entry.uri.toString() === model.expandedUri.toString()) return end;
        const candidates = projected.get(entry.uri.toString()) || [];
        const limit = positionOffset(expanded, end.line, end.character);
        let low = 0, high = candidates.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (candidates[middle].offset < limit) low = middle + 1;
            else high = middle;
        }
        for (let index = low - 1; index >= 0 && candidates[index].offset >= entry.offset; index--) {
            checkCancelled();
            const candidate = endOf(candidates[index].occurrence);
            if (!before(candidate, selected.end)) return candidate;
        }
        return selected.end;
    };
    const workspaceVisible = (entry, nativeRecord) => {
        if (entry.declaration.type === "parameter" || entry.declaration.type === "label") return false;
        for (let scope = nativeRecord?.scope; scope;) {
            const current = inventory.nativeScopes.get(scope);
            if (["procedure", "scope"].includes(current.kind)) return false;
            scope = current.parent;
        }
        return true;
    };
    const add = (entry, selected, end, nativeRecord) => {
        if (!expandedView && uri && entry.uri.toString() !== uri.toString()) return;
        const visible = workspaceVisible(entry, nativeRecord);
        if (workspaceOnly) {
            if (!visible) return;
            const workspaceRecord = {
                name: entry.name,
                type: entry.declaration.type,
                containerName: entry.declaration.containerName || "",
                qualifiedName: entry.declaration.qualifiedName || entry.name,
                signature: entry.declaration.signature,
                deprecated: semanticEntryIsDeprecated(entry),
                uri: uriRecord(expandedView ? uri : entry.uri),
                selection: selected
            };
            if (typeof options.onWorkspaceRecord === "function") options.onWorkspaceRecord(workspaceRecord);
            else records.push(workspaceRecord);
            return;
        }
        const compilerValue = entry.provisional || entry.declaration.provisional
            ? "" : compilerConstantValue(entry.compilerFacts);
        const detail = entry.declaration.detail || entry.declaration.type;
        const compilerTypeDetail = compilerSymbolTypeDetail(entry);
        const implicitTypeDetail = compilerImplicitTypeSummary(entry);
        const implicitStorageDetail = compilerImplicitStorageSummary(entry);
        const parameterPassingDetail = compilerParameterOutlineSummary(entry);
        const arrayBoundsDetail = compilerArrayBoundsSummary(entry.compilerFacts);
        const fieldLayoutDetail = compilerFieldLayoutSummary(entry);
        const aggregateLayoutDetail = compilerAggregateLayoutSummary(entry);
        const memberAccessDetail = compilerMemberAccessSummary(entry);
        const defaultProcedureVisibilityDetail = compilerDefaultProcedureVisibilitySummary(entry);
        const overrideDetail = compilerOverrideSummary(entry);
        const baseTypeDetail = compilerBaseTypeSummary(entry);
        const abstractMemberDetail = compilerAbstractMemberSummary(entry);
        const procedureAbiDetail = compilerProcedureOutlineAbiSummary(entry);
        const compilerValueDetail = compilerValue ? ` (compiler value: ${compilerValue})` : "";
        const documentationSummary = compilerDocumentationSummary(entry.declaration);
        const record = {
            index: records.length, parent: null, name: entry.name, type: entry.declaration.type,
            detail: `${detail}${compilerTypeDetail}${implicitTypeDetail ? ` (${implicitTypeDetail})` : ""}` +
                `${implicitStorageDetail ? ` (${implicitStorageDetail})` : ""}` +
                `${parameterPassingDetail ? ` (${parameterPassingDetail})` : ""}` +
                `${arrayBoundsDetail ? ` (${arrayBoundsDetail})` : ""}` +
                `${fieldLayoutDetail ? ` (${fieldLayoutDetail})` : ""}` +
                `${aggregateLayoutDetail ? ` (${aggregateLayoutDetail})` : ""}` +
                `${memberAccessDetail ? ` (${memberAccessDetail})` : ""}` +
                `${defaultProcedureVisibilityDetail ? ` (${defaultProcedureVisibilityDetail})` : ""}` +
                `${baseTypeDetail ? ` (${baseTypeDetail})` : ""}` +
                `${overrideDetail ? ` (${overrideDetail})` : ""}` +
                `${abstractMemberDetail ? ` (${abstractMemberDetail})` : ""}` +
                `${procedureAbiDetail ? ` (${procedureAbiDetail})` : ""}${compilerValueDetail}` +
                `${documentationSummary ? ` - ${documentationSummary}` : ""}`,
            deprecated: semanticEntryIsDeprecated(entry),
            containerName: entry.declaration.containerName || "", qualifiedName: entry.declaration.qualifiedName || entry.name,
            signature: entry.declaration.signature, partial: Boolean(entry.provisional),
            uri: uriRecord(expandedView ? uri : entry.uri), selection: selected,
            range: { start: { line: selected.start.line, character: 0 }, end: before(end, selected.end) ? selected.end : end },
            workspaceVisible: visible
        };
        records.push(record);
        byEntry.set(entry, record);
        byDeclaration.set(entry.declaration, record);
        if (entry.bodyScope?.nativeId) byScope.set(entry.bodyScope.nativeId, record);
    };
    for (const entry of model.inner.entries) {
        checkCancelled();
        const record = inventory.recordsByEntry.get(entry);
        if (!record || record.invalid) continue;
        const selected = selection(entry, record);
        add(entry, selected, workspaceOnly ? selected.end : physicalEnd(entry, record, selected), record);
    }
    const macros = workspaceOnly ? null : new Map();
    for (const entry of model.preprocessor.entries) {
        if (expandedView) break;
        checkCancelled();
        const selected = { start: { line: entry.declaration.line, character: entry.declaration.startColumn }, end: { line: entry.declaration.line, character: entry.declaration.endColumn } };
        add(entry, selected, selected.end);
        if (!workspaceOnly && entry.declaration.type === "macro") macros.set(entry.preprocessorRecord.id, byEntry.get(entry));
    }
    if (workspaceOnly) return records;
    // Native records are not emitted in source order (a field can precede its
    // containing type's final declaration). Resolve parents only after every
    // node exists. Physical scope instances keep reopened namespaces separate;
    // semantic ownership alone would incorrectly move out-of-line methods.
    for (const [entry, result] of byEntry) {
        checkCancelled();
        let parent = byDeclaration.get(entry.declaration.parentDeclaration);
        if (entry.compilerPreprocessorId && entry.declaration.type === "parameter") parent = macros.get(entry.preprocessorRecord.declaration);
        const record = inventory.recordsByEntry.get(entry);
        for (let scope = record?.scope; !parent && scope;) {
            parent = byScope.get(scope);
            if (parent === result) parent = null;
            scope = inventory.nativeScopes.get(scope).parent;
        }
        if (parent && parent.uri.value === result.uri.value && parent !== result) result.parent = parent.index;
    }
    // A macro-generated parent may have only its name projected into source.
    // Its native children can still supply a wider, same-file physical span.
    for (const record of records) {
        let parent = record.parent;
        const visited = new Set([record.index]);
        while (parent !== null) {
            if (visited.has(parent)) throw new Error("Cyclic native Outline hierarchy.");
            visited.add(parent);
            const container = records[parent];
            if (before(record.range.start, container.range.start)) container.range.start = record.range.start;
            if (before(container.range.end, record.range.end)) container.range.end = record.range.end;
            parent = container.parent;
        }
    }
    return records;
}

module.exports = {
    compilerAbstractMemberSummary,
    compilerAggregateLayoutSummary,
    compilerArrayBoundsSummary,
    compilerDocumentationSummary,
    compilerDefaultProcedureVisibilitySummary,
    compilerFieldLayoutSummary,
    compilerImplicitStorageSummary,
    compilerMemberAccessSummary,
    compilerOverrideSummary,
    compilerParameterOutlineSummary,
    compilerProcedureOutlineAbiSummary,
    compilerSymbolRecords
};

/* end of lib/compiler-document-symbols.js */
