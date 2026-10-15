/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-semantic-sidecar.js
    Purpose: Decode the compiler-owned, versioned semantic sidecar.
    Responsibilities: validate record shape, bounds, identities, and graph links.
    Does not contain: compiler invocation, source-range inference, or editor policy.
*/

const MAX_SEMANTIC_MODEL_BYTES = 64 * 1024 * 1024;
const MAX_SEMANTIC_MODEL_RECORDS = 6_100_000;
const MAX_EDITOR_EXPRESSION_FACTS = 200_000;
const MAX_EDITOR_BINDING_FACTS = 250_000;
const MAX_EDITOR_IMPLICIT_CALL_FACTS = 250_000;
const MAX_EDITOR_ASSIGNMENT_RESULT_FACTS = 100_000;
const MAX_EDITOR_SEMANTIC_RELATIONSHIPS = 250_000;
const MAX_EDITOR_SEMANTIC_POLICY_FACTS = 250_000;
const MAX_IMPLICIT_CALL_SIGNATURE_BYTES = 1024 * 1024;
const IMPLICIT_CALL_KINDS = new Set(["default-constructor", "initializer-constructor", "new-constructor", "destructor-call", "argument-constructor", "temporary-destructor", "scope-exit-destructor", "delete-destructor", "return-constructor"]);
const STRING_ESCAPES = new Map([["25", "%"], ["09", "\t"], ["0D", "\r"], ["0A", "\n"]]);
const SCHEMA20_DETAIL_SHAPES = Object.freeze({
    T: 19, A: 7, F: 13, G: 9, U: 12, C: 5, H: 7, K: 5, J: 5,
    O: 10, Q: 10, Y: 7, Z: 5, ASM: 6, DCL: 13, CTX: 3, OPT: 5, USE: 4,
    FILE: 7, SRC: 14, SRE: 3, INC: 12, MAP: 10, ORIG: 4
});
const SCHEMA20_PROVENANCE_TAGS = new Set(["FILE", "SRC", "SRE", "INC", "MAP", "ORIG"]);
const SCHEMA21_DETAIL_SHAPES = Object.freeze({
    ...SCHEMA20_DETAIL_SHAPES,
    PPB: 14, PPD: 11, PPE: 9, PPT: 13, PPS: 10
});
const SCHEMA21_PROVENANCE_TAGS = new Set([
    ...SCHEMA20_PROVENANCE_TAGS,
    "PPB", "PPD", "PPE", "PPT", "PPS"
]);
const SCHEMA22_DETAIL_SHAPES = Object.freeze({
    ...SCHEMA21_DETAIL_SHAPES,
    MD: 10, MT: 6, MI: 15, MA: 12, MS: 8, MC: 5, ME: 13, ML: 13, MR: 5
});
const SCHEMA22_PROVENANCE_TAGS = new Set([...SCHEMA21_PROVENANCE_TAGS,
    "MD", "MT", "MI", "MA", "MS", "MC", "ME", "ML", "MR"]);
const SCHEMA23_DETAIL_SHAPES = Object.freeze({
    ...SCHEMA22_DETAIL_SHAPES,
    MAP: 11, LOC: 12
});
const SCHEMA23_PROVENANCE_TAGS = new Set([...SCHEMA22_PROVENANCE_TAGS, "LOC"]);
const SCHEMA25_DETAIL_SHAPES = Object.freeze({
    ...SCHEMA23_DETAIL_SHAPES,
    ST: 17, STE: 10, BLK: 14, BEND: 9, OWN: 4, CAP: 4, ACC: 3, SOP: 3
});
const SCHEMA25_PROVENANCE_TAGS = new Set([...SCHEMA23_PROVENANCE_TAGS, "ST", "STE", "BLK", "BEND", "OWN", "CAP", "ACC", "SOP"]);
const SCHEMA27_DETAIL_SHAPES = Object.freeze({
    ...SCHEMA25_DETAIL_SHAPES,
    NT: 11, PH: 5, NP: 3, EV: 5, CB: 4, CN: 4, CE: 6, CL: 4, DI: 12, COM: 4, EX: 13
});
const SCHEMA27_PROVENANCE_TAGS = new Set([...SCHEMA25_PROVENANCE_TAGS, "COM", "DI", "EX"]);
const SCHEMA27_NORMALIZED_TYPE_NAMES = new Set([
    "any", "boolean", "byte", "ubyte", "zstring", "short", "ushort", "wstring", "integer", "uinteger",
    "enum", "long", "ulong", "longint", "ulongint", "single", "double", "string", "fixed-string",
    "va_list", "type", "namepace", "function", "fwdref", "pointer", "xmmword", "ustring"
]);
// FBC's normalized-type pointer depth mirrors the four-bit dtype pointer field.
const SCHEMA27_MAX_POINTER_DEPTH = 15;
const SCHEMA27_ASSIGNMENT_OPERATORS = new Set([
    "add", "subtract", "multiply", "divide", "integer-divide", "modulo", "and", "or",
    "logical-and", "logical-or", "xor", "equivalence", "implication", "shift-left",
    "shift-right", "power", "concatenate"
]);
const SCHEMA27_SOURCE_OPERATORS = new Map([
    ["binary", new Set(["add", "subtract", "multiply", "divide", "integer-divide", "modulo", "and", "or",
        "logical-and", "logical-or", "xor", "equivalence", "implication", "shift-left", "shift-right", "power",
        "concatenate", "equal", "greater-than", "less-than", "not-equal", "greater-or-equal", "less-or-equal", "identity-test"])],
    ["unary", new Set(["negate", "unary-plus", "not", "dereference"])],
    ["intrinsic-unary", new Set(["absolute-value", "sign", "sine", "arcsine", "cosine", "arccosine", "tangent",
        "arctangent", "square-root", "logarithm", "exponential", "floor", "truncate", "fractional-part"])],
    ["intrinsic-binary", new Set(["arctangent2"])],
    ["runtime-macro", new Set(["va-start", "va-arg", "va-copy", "va-end"])],
    ["group", new Set(["parentheses"])],
    ["cast", new Set(["cast"])]
]);
const SEMANTIC_DETAIL_SHAPES_BY_SCHEMA = new Map([
    [20, SCHEMA20_DETAIL_SHAPES], [21, SCHEMA21_DETAIL_SHAPES], [22, SCHEMA22_DETAIL_SHAPES], [23, SCHEMA23_DETAIL_SHAPES],
    [25, SCHEMA25_DETAIL_SHAPES], [27, SCHEMA27_DETAIL_SHAPES]
]);
const SEMANTIC_PROVENANCE_TAGS_BY_SCHEMA = new Map([
    [20, SCHEMA20_PROVENANCE_TAGS], [21, SCHEMA21_PROVENANCE_TAGS], [22, SCHEMA22_PROVENANCE_TAGS], [23, SCHEMA23_PROVENANCE_TAGS],
    [25, SCHEMA25_PROVENANCE_TAGS], [27, SCHEMA27_PROVENANCE_TAGS]
]);
const SCHEMA20_SYMBOL_CLASSES = new Set([
    "variable", "constant", "procedure", "parameter", "define", "keyword", "label", "namespace", "enum",
    "type", "union", "class", "field", "typedef", "forward-type", "scope", "reserved", "namespace-import"
]);
const SCHEMA20_TYPE_KINDS = new Set(["pointer", "numeric", "dynamic-string", "fixed-string", "aggregate", "procedure", "other"]);
const SCHEMA20_STORAGE_KINDS = new Set(["parameter", "field", "constant", "external", "static", "local", "shared", "global", "none"]);
const SCHEMA20_PROCEDURE_KINDS = new Set(["sub", "function", "constructor", "destructor", "property-get", "property-set", "operator", "procedure-pointer"]);
const SCHEMA20_CALLING_CONVENTIONS = new Set(["cdecl", "stdcall", "stdcall-ms", "pascal", "thiscall", "fastcall"]);
const SCHEMA20_PARAMETER_MODES = new Set(["byval", "byref", "bydesc", "vararg"]);
const CONCEPT_OPERATOR_CODES = new Set([
    "assign", "add", "subtract", "multiply", "divide", "integer-divide", "modulo",
    "add-assign", "subtract-assign", "multiply-assign", "divide-assign", "integer-divide-assign",
    "modulo-assign", "and-assign", "or-assign", "logical-and-assign", "logical-or-assign",
    "xor-assign", "equivalence-assign", "implication-assign", "shift-left-assign",
    "shift-right-assign", "power-assign", "concatenate-assign", "and", "or", "logical-and", "logical-or", "xor", "equivalence", "implication",
    "shift-left", "shift-right", "power", "concatenate", "equal", "greater-than",
    "less-than", "not-equal", "greater-or-equal", "less-or-equal", "identity-test",
    "not", "logical-not", "unary-plus", "negate", "address-of", "dereference", "index",
    "member-access", "cast", "convert-to-boolean", "convert-to-integer", "convert-to-float",
    "convert-to-signed", "convert-to-unsigned", "absolute-value", "sign", "sine", "arcsine",
    "cosine", "arccosine", "tangent", "arctangent", "arctangent2", "square-root",
    "reciprocal-square-root", "reciprocal", "logarithm", "exponential", "floor",
    "truncate", "fractional-part", "allocate", "allocate-array",
    "deallocate", "deallocate-array", "length", "iterator-initialize", "iterator-step", "iterator-next",
    "va-start", "va-arg", "va-copy", "va-end"
]);
const CALL_PARAMETER_MODES = new Set(["byval", "byref", "bydesc", "vararg"]);

function stableCallSignatureSubtypeIds(signature) {
    const fields = signature.split("|");
    if (fields[0] !== "sig2" || (fields.length - 1) % 5 !== 0) return null;
    const subtypeIds = [];
    for (let index = 1; index < fields.length; index += 5) {
        const [mode, optional, dimensions, dtype, subtype] = fields.slice(index, index + 5);
        if (!CALL_PARAMETER_MODES.has(mode) || !/^[01]$/.test(optional) ||
            !/^(?:-1|\d+)$/.test(dimensions) || !/^\d+$/.test(dtype) || !/^\d+$/.test(subtype)) return null;
        const dimensionsValue = Number(dimensions);
        const dtypeValue = Number(dtype);
        const subtypeValue = Number(subtype);
        if (!Number.isSafeInteger(dimensionsValue) || !Number.isSafeInteger(dtypeValue) ||
            !Number.isSafeInteger(subtypeValue)) return null;
        const validDimensions = mode === "bydesc"
            ? dimensionsValue === -1 || dimensionsValue > 0
            : dimensionsValue === 0;
        if (!validDimensions) return null;
        if (subtypeValue > 0) subtypeIds.push(subtypeValue);
    }
    return subtypeIds;
}

function decodeSemanticUtf8SurrogateEscape(bytes) {
    if (bytes.every((value) => value < 128)) return bytes.toString("ascii");
    let decoded = "";
    for (let index = 0; index < bytes.length;) {
        const first = bytes[index];
        if (first < 128) {
            decoded += String.fromCharCode(first);
            index++;
            continue;
        }

        let length = 0, value = 0, minimum = 0;
        if (first >= 0xc2 && first <= 0xdf) {
            length = 2;
            value = first & 0x1f;
            minimum = 0x80;
        } else if (first >= 0xe0 && first <= 0xef) {
            length = 3;
            value = first & 0x0f;
            minimum = 0x800;
        } else if (first >= 0xf0 && first <= 0xf4) {
            length = 4;
            value = first & 0x07;
            minimum = 0x10000;
        }

        let valid = length > 0 && index + length <= bytes.length;
        if (valid) {
            for (let part = 1; part < length; part++) {
                const next = bytes[index + part];
                if (next < 0x80 || next > 0xbf || part === 1 && (
                    first === 0xe0 && next < 0xa0 || first === 0xed && next > 0x9f ||
                    first === 0xf0 && next < 0x90 || first === 0xf4 && next > 0x8f
                )) {
                    valid = false;
                    break;
                }
                value = value * 64 + (next & 0x3f);
            }
        }
        if (!valid || value < minimum || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) {
            /* Python's surrogateescape convention keeps legacy compiler bytes reversible. */
            decoded += String.fromCharCode(0xdc00 + first);
            index++;
            continue;
        }
        decoded += String.fromCodePoint(value);
        index += length;
    }
    return decoded;
}

function decodeOperatorConcept(code, kind) {
    if (kind === "none" && code === "") return { operatorCode: "", operatorKind: "none" };
    if (!CONCEPT_OPERATOR_CODES.has(code) || !["builtin", "overloaded"].includes(kind)) {
        throw new Error("Invalid stable compiler semantic operator concept.");
    }
    return { operatorCode: code, operatorKind: kind };
}

function decodeSemanticString(value, label, schemaVersion) {
    if (schemaVersion < 20) {
        let malformedEscape = false;
        const decoded = value.replace(/%([\da-f]{2})/gi, (match, hex) => {
            const replacement = STRING_ESCAPES.get(hex.toUpperCase());
            if (replacement === undefined) {
                malformedEscape = true;
                return match;
            }
            return replacement;
        });
        if (malformedEscape || value.replace(/%[\da-f]{2}/gi, "").includes("%")) {
            throw new Error(`Invalid escaped compiler semantic ${label}.`);
        }
        return decoded;
    }

    const bytes = [];
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (character === "%") {
            const escape = value.slice(index + 1, index + 3);
            if (!/^[0-9A-F]{2}$/.test(escape)) throw new Error(`Invalid escaped compiler semantic ${label}.`);
            bytes.push(Number.parseInt(escape, 16));
            index += 2;
        } else {
            const code = value.charCodeAt(index);
            if (code < 32 || code >= 127) throw new Error(`Unescaped byte in compiler semantic ${label}.`);
            bytes.push(code);
        }
    }
    return decodeSemanticUtf8SurrogateEscape(Buffer.from(bytes));
}

function decodeSemanticBytes(value, label) {
    const bytes = [];
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (character === "%") {
            const escape = value.slice(index + 1, index + 3);
            if (!/^[0-9A-F]{2}$/.test(escape)) throw new Error(`Invalid escaped compiler semantic ${label}.`);
            bytes.push(Number.parseInt(escape, 16));
            index += 2;
        } else {
            const code = value.charCodeAt(index);
            if (code < 32 || code >= 127) throw new Error(`Unescaped byte in compiler semantic ${label}.`);
            bytes.push(code);
        }
    }
    return Buffer.from(bytes);
}

function decodeSemanticDetailFields(row, tag, schemaVersion, string) {
    const fields = row.slice();
    for (let index = 1; index < fields.length; index++) {
        const bytePayload = schemaVersion >= 22 && (
            tag === "MT" && index === 4 && fields[3] === "text" ||
            tag === "MA" && index === 4 && fields[3] === "bytes" ||
            tag === "MC" && index === 4 && fields[2] === "bytes" ||
            tag === "ME" && index === 5 && fields[3] === "bytes"
        );
        fields[index] = bytePayload
            ? decodeSemanticBytes(fields[index], `${tag} payload`)
            : string(fields[index], `${tag} field ${index}`);
    }
    return fields;
}

function semanticMacroUnits(kind, value, label) {
    if (kind === "bytes") {
        if (!Buffer.isBuffer(value)) throw new Error(`Invalid ${label} byte representation.`);
        return value;
    }
    if (kind !== "wide-units" || typeof value !== "string" || value.length % 8 !== 0 || !/^[0-9A-F]*$/.test(value)) {
        throw new Error(`Invalid ${label} wide-unit representation.`);
    }
    const units = [];
    for (let index = 0; index < value.length; index += 8) units.push(Number.parseInt(value.slice(index, index + 8), 16));
    return units;
}

function sameMacroUnits(first, second) {
    if (Buffer.isBuffer(first) && Buffer.isBuffer(second)) return first.equals(second);
    return Array.isArray(first) && Array.isArray(second) && first.length === second.length && first.every((unit, index) => unit === second[index]);
}

function stringifyMacroUnits(units) {
    if (Buffer.isBuffer(units)) {
        if (!units.length) return Buffer.from('""');
        return Buffer.concat([Buffer.from('$"'), Buffer.from(Array.from(units, (unit) => unit === 34 ? [34, 34] : [unit]).flat()), Buffer.from('"')]);
    }
    const escaped = units.flatMap((unit) => unit === 34 ? [34, 34] : [unit]);
    return units.length ? [36, 34, ...escaped, 34] : [34, 34];
}

function createSchema20State(result, number) {
    return {
        result,
        number,
        references: [],
        symbolClasses: SCHEMA20_SYMBOL_CLASSES,
        typeKinds: SCHEMA20_TYPE_KINDS,
        storageKinds: SCHEMA20_STORAGE_KINDS,
        procedureKinds: SCHEMA20_PROCEDURE_KINDS,
        callingConventions: SCHEMA20_CALLING_CONVENTIONS,
        parameterModes: SCHEMA20_PARAMETER_MODES,
        skipUnavailableReferences: false,
        requireMacroConfiguration: false,
        requireMacroSymbol: false,
        sourceFileIds: new Set(),
        sourceFileMap: new Map(),
        sourceContextIds: new Set(),
        sourceContextMap: new Map(),
        sourceClosureIds: new Set(),
        sourceRootModules: new Set(),
        includeOutcomeIds: new Set(),
        declarationIds: new Set(),
        bindingIds: new Set(),
        configurationContextIds: new Set(),
        configurationModules: new Map(),
        configurationOptionKeys: new Set(),
        configurationUseKeys: new Set(),
        propertyKeys: new Set(),
        primitiveIdsByModule: new Map(),
        primitiveNamesByModule: new Map(),
        primitiveKindsByModule: new Map(),
        targetModulePaths: new Set(),
        sourceOriginKeys: new Set(),
        sourceRemapIds: new Set(),
        physicalLocationKeys: new Set(),
        statements: new Map(),
        statementStack: [],
        statementEndings: new Map(),
        constructs: new Map(),
        constructStack: [],
        constructEndings: new Map(),
        statementOwnerKeys: new Set(),
        capabilityKeys: new Set(),
        conditionalBranches: new Map(),
        conditionalGroups: new Map(),
        conditionalDecisions: new Map(),
        conditionalEndings: new Set(),
        conditionalProbeIds: new Set(),
        conditionalSkipIds: new Set(),
        conditionalStack: [],
        macroDefinitions: new Map(),
        macroTokens: new Map(),
        macroInvocations: new Map(),
        macroArguments: new Map(),
        macroSegments: new Map(),
        macroCallbacks: new Map(),
        macroResults: new Map(),
        macroLifecycleIds: new Set(),
        macroOrigins: new Set(),
        operations: [],
        accessRoleIds: new Set(),
        normalizedTypeKeys: new Map(),
        procedureSignatureIds: new Set(),
        unphasedNodeRoots: new Set(),
        flowPhases: new Map(),
        flowNodePhases: new Map(),
        evaluationEdgeKeys: new Set(),
        flowBlocks: new Map(),
        flowBlockOrdinals: new Map(),
        flowBlockNodes: new Map(),
        flowLabels: new Set(),
        expressionOperandIds: new Map(),
        sourceOperationExpressions: new Map(),
        commentIds: new Set(),
        diagnosticIds: new Set(),
        symbolModules: new Map(),
        namespaceSymbolParents: new Map(),
        sourceSymbolIds: new Set(),
        nodeModules: new Map(),
        expressionModules: new Map(),
        currentModulePath: "",
        moduleCount: 0,
        sourceRange(row, offset, label) {
            const filePath = row[offset];
            const startLine = number(row[offset + 1], `${label} start line`, 1);
            const startColumn = number(row[offset + 2], `${label} start column`, 0);
            const endLine = number(row[offset + 3], `${label} end line`, startLine);
            const endColumn = number(row[offset + 4], `${label} end column`, 0);
            if (!filePath || endLine < startLine || endLine === startLine && endColumn <= startColumn) {
                throw new Error(`Invalid compiler semantic ${label} source range.`);
            }
            return { filePath, startLine, startColumn, endLine, endColumn };
        },
        sourceRangeWithPhysicalFlag(row, offset, label, physical, allowEmptyPhysicalPoint = false) {
            const filePath = row[offset];
            const startLine = number(row[offset + 1], `${label} start line`, 1);
            const startColumn = number(row[offset + 2], `${label} start column`, 0);
            const endLine = number(row[offset + 3], `${label} end line`, startLine);
            const endColumn = number(row[offset + 4], `${label} end column`, 0);
            /* Recovery can leave an unmatched empty statement at its physical cursor. */
            const emptyPhysicalPoint = allowEmptyPhysicalPoint && endLine === startLine && endColumn === startColumn;
            if (!filePath || endLine < startLine || endLine === startLine &&
                (endColumn < startColumn || physical && endColumn === startColumn && !emptyPhysicalPoint)) {
                throw new Error(`Invalid compiler semantic ${label} source range.`);
            }
            return { filePath, startLine, startColumn, endLine, endColumn };
        }
    };
}

function validateSemanticDetail(tag, row, state) {
    const number = (index, label, minimum = Number.MIN_SAFE_INTEGER) => state.number(row[index], label, minimum);
    const reference = (domain, index, label, nullable = true) => {
        const identity = number(index, label, nullable ? 0 : 1);
        if (identity > 0 && !(state.skipUnavailableReferences && ["symbol", "node", "declaration", "binding"].includes(domain))) {
            state.references.push({ domain, identity, label });
        }
        return identity;
    };
    switch (tag) {
        case "T": {
            const symbol = reference("symbol", 1, "detail symbol", false);
            if (!state.typeKinds.has(row[4]) || !state.symbolClasses.has(row[3]) || !state.storageKinds.has(row[17]) ||
                !["private", "protected", "public"].includes(row[16]) || !["source", "compiler", "runtime"].includes(row[18])) {
                throw new Error("Invalid schema-20 symbol detail.");
            }
            for (let index = 6; index <= 14; index++) number(index, "symbol detail numeric field");
            for (const index of [7, 8, 9]) reference("symbol", index, "symbol detail relation");
            if (row[18] === "source") state.sourceSymbolIds.add(symbol);
            if (state.sourceSymbolIds.has(symbol) &&
                (state.result.symbolVisibilities?.length || 0) < MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                state.result.symbolVisibilities?.push({ symbol, visibility: row[16] });
            }
            if (state.sourceSymbolIds.has(symbol) &&
                (state.result.symbolStorageClasses?.length || 0) < MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                state.result.symbolStorageClasses?.push({ symbol, storage: row[17] });
            }
            if (row[3] === "field" && row[18] === "source" &&
                (state.result.fieldLayouts?.length || 0) < MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                const byteOffset = number(14, "field byte offset");
                if (byteOffset >= 0) state.result.fieldLayouts?.push({
                    symbol,
                    owner: number(8, "field aggregate owner", 0),
                    byteOffset
                });
            }
            break;
        }
        case "A": {
            const symbol = reference("symbol", 1, "array detail symbol", false);
            const rank = number(2, "array rank", -1);
            const dimension = number(3, "array dimension", -1);
            let lower = null;
            let upper = null;
            if (row[4] === "runtime") {
                if (dimension !== -1 || row[5] !== "" || row[6] !== "") throw new Error("Runtime array advertises fixed bounds.");
            } else if (row[4] === "fixed" || row[4] === "unknown") {
                if (dimension < 0 || dimension >= rank) throw new Error("Array dimension is outside its rank.");
                lower = number(5, "array lower bound");
                if (row[4] === "fixed") upper = number(6, "array upper bound");
                else if (row[6] !== "") throw new Error("Unknown array bound advertises an upper bound.");
            } else throw new Error("Unknown schema-20 array bound kind.");
            if (state.sourceSymbolIds.has(symbol) &&
                (state.result.arrayBounds?.length || 0) < MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                state.result.arrayBounds?.push({
                    symbol, module: state.moduleCount, rank, dimension, kind: row[4], lower, upper
                });
            }
            break;
        }
        case "F": {
            const procedure = reference("symbol", 1, "procedure detail symbol", false);
            if (!state.procedureKinds.has(row[2]) || !state.callingConventions.has(row[3])) throw new Error("Invalid schema-20 procedure signature.");
            number(4, "procedure parameter count", 0);
            number(5, "optional parameter count", 0);
            if (!/^[01]$/.test(row[6])) throw new Error("Invalid procedure return-by-reference flag.");
            number(7, "procedure return data type", 0);
            reference("symbol", 8, "procedure return subtype");
            number(9, "procedure return method", 0);
            reference("symbol", 11, "overridden procedure");
            number(12, "procedure vtable index", 0);
            state.procedureSignatureIds.add(procedure);
            if (state.sourceSymbolIds.has(procedure) &&
                (state.result.procedureCallConventions?.length || 0) < MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                state.result.procedureCallConventions?.push({
                    symbol: procedure,
                    kind: row[2],
                    callingConvention: row[3],
                    returnByReference: row[6] === "1"
                });
            }
            break;
        }
        case "G": {
            const procedure = reference("symbol", 1, "parameter owner procedure", false);
            const parameter = reference("symbol", 2, "parameter symbol", false);
            const variable = reference("symbol", 7, "parameter variable");
            const ordinal = number(3, "parameter ordinal", -1);
            if (!state.parameterModes.has(row[4])) throw new Error("Unknown schema-20 parameter mode.");
            if (!/^[01]$/.test(row[5]) || !/^[01]$/.test(row[8])) throw new Error("Invalid schema-20 parameter flag.");
            const dimensions = number(6, "parameter array dimensions", -1);
            if (state.sourceSymbolIds.has(procedure) &&
                (state.result.procedureParameterModes?.length || 0) < MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                state.result.procedureParameterModes?.push({
                    procedure,
                    parameter,
                    variable,
                    ordinal,
                    mode: row[4],
                    optional: row[5] === "1",
                    dimensions,
                    receiver: row[8] === "1"
                });
            }
            break;
        }
        case "U": {
            const symbol = reference("symbol", 1, "layout symbol", false);
            if (!["type", "union", "enum", "scope"].includes(row[2])) throw new Error("Unknown schema-20 layout kind.");
            const base = reference("symbol", 3, "base type");
            for (let index = 4; index < row.length; index++) number(index, "layout numeric field", 0);
            if (base && state.sourceSymbolIds.has(symbol)) {
                if (state.result.typeBases.length >= MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                    throw new Error("Compiler semantic base-type facts exceeded their bound.");
                }
                state.result.typeBases.push({ symbol, base, module: state.moduleCount });
            }
            if (["type", "union"].includes(row[2]) && state.sourceSymbolIds.has(symbol)) {
                if (state.result.typeSymbols.length >= MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                    throw new Error("Compiler semantic type symbols exceeded their bound.");
                }
                state.result.typeSymbols.push(symbol);
            }
            if (row[2] === "type" && state.sourceSymbolIds.has(symbol) &&
                (state.result.abstractTypeCounts?.length || 0) < MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                state.result.abstractTypeCounts?.push({ symbol, count: number(8, "abstract member count", 0) });
            }
            break;
        }
        case "C": {
            if (!["symbol", "node", "expression"].includes(row[1])) throw new Error("Invalid constant identity domain.");
            reference(row[1], 2, "constant identity", false);
            if (row[3] === "signed" || row[3] === "unsigned") {
                if (!/^(?:0|-?[1-9]\d*)$/.test(row[4])) throw new Error("Invalid compiler semantic constant value.");
                const value = BigInt(row[4]);
                const minimum = row[3] === "unsigned" ? 0n : -(1n << 63n);
                const maximum = row[3] === "unsigned" ? (1n << 64n) - 1n : (1n << 63n) - 1n;
                if (value < minimum || value > maximum) throw new Error("Compiler semantic constant value is outside its 64-bit range.");
            }
            else if (row[3] === "bytes" || row[3] === "wide-units") {
                const width = row[3] === "bytes" ? 2 : 8;
                if (row[4].length % width !== 0 || !/^[0-9A-F]*$/.test(row[4])) throw new Error("Invalid constant byte encoding.");
            } else if (row[3] === "float64-bits") {
                if (!/^0x[0-9A-F]{16}$/.test(row[4])) throw new Error("Invalid floating-point constant encoding.");
            } else throw new Error("Unknown schema-20 constant value kind.");
            if (Array.isArray(state.result.constantValues)) {
                state.result.constantValues.push({
                    module: state.moduleCount,
                    domain: row[1],
                    identity: number(2, "constant identity", 1),
                    kind: row[3],
                    value: row[4]
                });
            }
            break;
        }
        case "H": {
            if (!["symbol", "node", "expression"].includes(row[1])) throw new Error("Invalid relation source domain.");
            reference(row[1], 2, "relation source", false);
            if (!["symbol", "node", "expression", "binding"].includes(row[3]) || !row[5]) throw new Error("Invalid relation target or kind.");
            reference(row[3], 4, "relation target", false);
            const source = number(2, "relation source", 1);
            const target = number(4, "relation target", 1);
            const ordinal = number(6, "relation ordinal", 0);
            if (row[1] === "symbol" && row[3] === "node" &&
                ["initializer", "default-initializer", "array-storage-root"].includes(row[5])) {
                state.unphasedNodeRoots.add(target);
            }
            if (state.result.relationships.length >= MAX_EDITOR_SEMANTIC_RELATIONSHIPS) {
                throw new Error("Compiler semantic relationships exceeded their 250000-entry bound.");
            }
            state.result.relationships.push({
                module: state.moduleCount,
                sourceDomain: row[1], source, targetDomain: row[3], target,
                kind: row[5], ordinal
            });
            break;
        }
        case "K": {
            const domains = state.schemaVersion >= 27 ? ["symbol", "node", "expression"] : ["symbol", "node"];
            const identity = number(2, "property owner", 1);
            const key = `${row[1]}:${identity}:${row[3]}`;
            const uniquelyNamed = row[3].startsWith("declaration-type-") ||
                row[3].startsWith("procedure-typing-input:") || row[3].startsWith("procedure-written-visibility:") ||
                row[3] === "aggregate-body-statement" || row[3] === "aggregate-access-count" ||
                row[3].startsWith("aggregate-access-section:") || row[3].startsWith("literal-target-wide-") ||
                row[3].startsWith("select-case-") || row[3] === "scalar-string-declaration" ||
                row[3].startsWith("header-policy:") || row[3].startsWith("header-library:") ||
                row[3].startsWith("header-import:") || row[3].startsWith("namespace-declaration:");
            if (!domains.includes(row[1]) || !row[3] || uniquelyNamed && state.propertyKeys.has(key)) {
                throw new Error("Invalid, empty, or duplicate schema-20 property domain or key.");
            }
            reference(row[1], 2, "property owner", false);
            if (uniquelyNamed) state.propertyKeys.add(key);
            state.result.properties.push({
                module: state.moduleCount,
                domain: row[1],
                identity,
                name: row[3],
                value: row[4]
            });
            break;
        }
        case "J":
            reference("node", 1, "jump-table node", false);
            number(2, "jump-table ordinal", 0);
            number(3, "jump-table value", 0);
            reference("symbol", 4, "jump-table label", false);
            break;
        case "O": {
            if (!row[1]) throw new Error("Empty schema-20 operator code.");
            decodeOperatorConcept(row[1], row[2]);
            const target = number(3, "operator target symbol", 0);
            if (row[2] === "builtin" && target !== 0 || row[2] === "overloaded" && target === 0) {
                throw new Error("Schema-20 operator target does not match its kind.");
            }
            if (target) reference("symbol", 3, "operator target", false);
            const physical = number(4, "operator physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-20 operator physical flag.");
            const operation = { operatorCode: row[1], operatorKind: row[2], target, physical: physical === 1,
                ...state.sourceRange(row, 5, "operator source") };
            state.operations.push(operation);
            state.result.operations.push(operation);
            break;
        }
        case "Q": {
            if (!row[1] || !row[2] || !row[3] || !row[4] || !row[5] || !["4", "8"].includes(row[6]) ||
                !["little", "big"].includes(row[7])) throw new Error("Invalid schema-20 target context.");
            number(8, "target wchar size", 1);
            number(9, "target integer keyword type", 0);
            if (!state.currentModulePath || row[1] !== state.currentModulePath || state.targetModulePaths.has(row[1])) {
                throw new Error("Missing, duplicate, or mismatched schema-20 target context.");
            }
            state.targetModulePaths.add(row[1]);
            state.result.targetContexts.push(row.slice(1));
            break;
        }
        case "Y": {
            const id = number(1, "primitive datatype", 0);
            if (!row[2] || !["integer", "float", "string", "aggregate", "procedure", "unknown"].includes(row[3])) {
                throw new Error("Invalid schema-20 primitive datatype.");
            }
            for (const index of [4, 5]) if (row[index]) number(index, "primitive type layout", 0);
            if (!/^[01]$/.test(row[6]) || !state.targetModulePaths.has(state.currentModulePath)) {
                throw new Error("Primitive type has no matching target context.");
            }
            const ids = state.primitiveIdsByModule.get(state.moduleCount) || new Set();
            const names = state.primitiveNamesByModule.get(state.moduleCount) || new Set();
            const kinds = state.primitiveKindsByModule.get(state.moduleCount) || new Map();
            if (ids.has(id) || names.has(row[2])) throw new Error("Duplicate schema-20 primitive datatype identity or name.");
            ids.add(id);
            names.add(row[2]);
            kinds.set(id, row[3]);
            state.primitiveIdsByModule.set(state.moduleCount, ids);
            state.primitiveNamesByModule.set(state.moduleCount, names);
            state.primitiveKindsByModule.set(state.moduleCount, kinds);
            state.result.primitiveTypes.push({ id, name: row[2], kind: row[3], size: row[4], alignment: row[5], signed: row[6] === "1" });
            break;
        }
        case "Z": {
            reference("symbol", 1, "macro token owner", false);
            number(2, "macro token ordinal", 0);
            if (!["parameter", "parameter-reference", "stringify-reference", "text", "wide-text"].includes(row[3])) {
                throw new Error("Unknown schema-20 macro token kind.");
            }
            if (row[3] === "parameter-reference" || row[3] === "stringify-reference") number(4, "macro parameter ordinal", 0);
            if (row[3] === "wide-text" && (row[4].length % 8 !== 0 || !/^[0-9A-F]*$/.test(row[4]))) {
                throw new Error("Invalid wide macro token text.");
            }
            break;
        }
        case "ASM": {
            reference("node", 1, "assembly node", false);
            number(2, "assembly token ordinal", 0);
            if (row[3] !== "text" && row[3] !== "symbol") throw new Error("Unknown assembly token kind.");
            const symbol = number(4, "assembly token symbol", 0);
            if (row[3] === "text" && symbol !== 0 || row[3] === "symbol" && row[5] !== "") {
                throw new Error("Assembly token payload does not match its kind.");
            }
            if (symbol) reference("symbol", 4, "assembly symbol", false);
            break;
        }
        case "DCL": {
            const id = number(1, "declaration occurrence", 1);
            if (state.declarationIds.has(id)) throw new Error("Duplicate schema-20 declaration occurrence.");
            state.declarationIds.add(id);
            const symbol = reference("symbol", 2, "declaration symbol", false);
            if (!["parameter-prototype", "parameter-definition", "procedure-prototype", "procedure-definition", "implicit-variable"].includes(row[3])) {
                throw new Error("Unknown schema-20 declaration role.");
            }
            if (!/^[01]$/.test(row[5])) throw new Error("Invalid schema-20 declaration physical flag.");
            const source = state.sourceRange(row, 6, "declaration source");
            const module = number(11, "declaration module", 1);
            const statement = number(12, "declaration statement ordinal", 0);
            if (module !== state.moduleCount) throw new Error("Schema-20 declaration belongs to another module.");
            state.result.declarations.push({
                id,
                symbol,
                kind: row[3],
                name: row[4],
                physical: row[5] === "1",
                ...source,
                module,
                statement
            });
            break;
        }
        case "CTX": {
            const id = number(1, "configuration context", 1);
            const module = number(2, "configuration module", 1);
            if (state.configurationContextIds.has(id) || module !== state.moduleCount) {
                throw new Error("Duplicate or misplaced schema-20 configuration context.");
            }
            state.configurationContextIds.add(id);
            state.configurationModules.set(id, module);
            state.result.configurationContexts.push({ id, module });
            break;
        }
        case "OPT": {
            const context = number(1, "configuration option context", 1);
            const key = `${context}:${row[2]}:${row[3]}`;
            if (!state.configurationContextIds.has(context) || !["compiler", "language-default", "language-policy"].includes(row[2]) || !row[3] || state.configurationOptionKeys.has(key)) {
                throw new Error("Invalid or duplicate schema-20 configuration option.");
            }
            state.configurationOptionKeys.add(key);
            state.result.configurationOptions.push({ context, source: row[2], name: row[3], value: number(4, "configuration option value") });
            break;
        }
        case "USE": {
            if (!["symbol", "node", "expression", "declaration"].includes(row[1])) throw new Error("Unknown configuration-use domain.");
            reference(row[1], 2, "configuration-use identity", false);
            const context = number(3, "configuration-use context", 1);
            const key = `${row[1]}:${row[2]}`;
            if (!state.configurationContextIds.has(context) || state.configurationUseKeys.has(key)) {
                throw new Error("Invalid or duplicate schema-20 configuration use.");
            }
            state.configurationUseKeys.add(key);
            state.result.configurationUses.push({ domain: row[1], identity: Number(row[2]), context });
            break;
        }
        case "FILE": {
            const id = number(1, "source file identity", 1);
            const bytes = number(3, "source file byte count", 0);
            if (state.sourceFileIds.has(id) || !row[2] || !["unmarked-bytes", "utf-8-bom", "utf-16le", "utf-16be", "utf-32le", "utf-32be", "unknown"].includes(row[5]) ||
                !["regular", "stream"].includes(row[6])) throw new Error("Invalid schema-20 source file revision.");
            if (row[6] === "regular" && !/^[0-9a-f]{64}$/.test(row[4]) || row[6] === "stream" && (row[4] || bytes !== 0)) {
                throw new Error("Invalid schema-20 source file digest.");
            }
            state.sourceFileIds.add(id);
            const sourceFile = { id, filePath: row[2], bytes, digest: row[4], encoding: row[5], kind: row[6] };
            state.sourceFileMap.set(id, sourceFile);
            state.result.sourceFiles.push(sourceFile);
            break;
        }
        case "SRC": {
            const id = number(1, "source context identity", 1);
            const parent = number(2, "source context parent", 0);
            const file = number(3, "source context file", 1);
            const module = number(4, "source context module", 1);
            const depth = number(6, "source context depth", 0);
            if (state.sourceContextIds.has(id) || !state.sourceFileIds.has(file) || module !== state.moduleCount ||
                !["module", "include", "preinclude"].includes(row[5]) || depth > 16) throw new Error("Invalid schema-20 source context.");
            if (parent) {
                const parentContext = state.sourceContextMap.get(parent);
                if (!parentContext || depth !== parentContext.depth + 1 || row[5] === "module") throw new Error("Invalid schema-20 source context parent.");
            } else if (row[5] !== "module" || depth !== 0) throw new Error("Schema-20 module source has no root context.");
            if (!parent && state.sourceRootModules.has(module)) throw new Error("Duplicate schema-20 module source root.");
            const physical = number(8, "source directive physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-20 source directive flag.");
            let directive = null;
            if (physical) directive = state.sourceRange(row, 9, "source directive");
            else if (!row[9] && row.slice(8).join("\t") !== "0\t\t0\t0\t0\t0") {
                throw new Error("Unanchored source context has invented coordinates.");
            }
            const context = { id, parent, file, module, kind: row[5], depth, requested: row[7], directive };
            state.sourceContextIds.add(id);
            if (!parent) state.sourceRootModules.add(module);
            state.sourceContextMap.set(id, context);
            state.result.sourceContexts.push(context);
            break;
        }
        case "SRE": {
            const id = number(1, "source close context", 1);
            if (!state.sourceContextIds.has(id) || state.sourceClosureIds.has(id) ||
                !["verified", "unverified-stream", "changed-or-unreadable"].includes(row[2])) {
                throw new Error("Invalid schema-20 source revision close.");
            }
            state.sourceClosureIds.add(id);
            state.result.sourceClosures.push({ id, status: row[2] });
            break;
        }
        case "INC": {
            const id = number(1, "include outcome identity", 1);
            const parent = number(2, "include parent context", 1);
            if (state.includeOutcomeIds.has(id) || !state.sourceContextIds.has(parent) || !row[3] ||
                !["opened", "include-once", "pragma-once", "not-found", "open-failed", "depth-limit"].includes(row[5])) {
                throw new Error("Invalid schema-20 include outcome.");
            }
            state.includeOutcomeIds.add(id);
            if (["opened", "include-once", "pragma-once", "open-failed"].includes(row[5]) && !row[4]) {
                throw new Error("Resolved schema-20 include has no path.");
            }
            const physical = number(6, "include directive physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-20 include directive flag.");
            let directive = null;
            let origin = null;
            if (physical) directive = state.sourceRange(row, 7, "include directive");
            else if (row[7]) {
                const filePath = row[7];
                const startLine = number(8, "include outcome origin start line", 1);
                const startColumn = number(9, "include outcome origin start column", 0);
                const endLine = number(10, "include outcome origin end line", startLine);
                const endColumn = number(11, "include outcome origin end column", 0);
                if (!filePath || endLine < startLine ||
                    endLine === startLine && endColumn <= startColumn) {
                    throw new Error("Invalid noneditable include outcome origin.");
                }
                origin = { filePath, startLine, startColumn, endLine, endColumn, physical: false };
            } else if (row.slice(8).some((value) => value !== "0")) {
                throw new Error("Unanchored include outcome has invented coordinates.");
            }
            state.result.includeOutcomes.push({ id, parent, requested: row[3], resolved: row[4], outcome: row[5], directive, origin });
            break;
        }
        case "MAP": {
            const source = number(1, "source remap context", 1);
            if (!state.sourceContextIds.has(source) || !row[3]) throw new Error("Invalid schema-20 source remap.");
            const logicalLine = number(2, "logical source line", 0);
            const physical = number(4, "source remap physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-20 source remap flag.");
            let id = null;
            if (state.schemaVersion >= 23) {
                id = number(10, "source remap identity", 1);
                if (state.sourceRemapIds.has(id)) throw new Error("Repeated schema-23 source remap identity.");
                state.sourceRemapIds.add(id);
            }
            const remap = { source, logicalLine, logicalFile: row[3], physical: physical === 1,
                range: state.sourceRange(row, 5, "source remap") };
            if (id !== null) remap.id = id;
            state.result.sourceRemaps.push(remap);
            break;
        }
        case "LOC": {
            const domain = row[1];
            const subject = number(2, "physical location subject", 1);
            const role = row[3];
            const source = number(4, "physical location source context", 1);
            const startLine = number(5, "physical location start line", 1);
            const startColumn = number(6, "physical location start column", 0);
            const endLine = number(7, "physical location end line", startLine);
            const endColumn = number(8, "physical location end column", 0);
            const startByte = number(9, "physical location start byte", -1);
            const endByte = number(10, "physical location end byte", -1);
            const status = row[11];
            if (!state.sourceContextMap.has(source) || !role || endLine < startLine ||
                endLine === startLine && endColumn < startColumn) {
                throw new Error("Invalid schema-23 physical location range or source context.");
            }
            if (status === "mapped") {
                const context = state.sourceContextMap.get(source);
                const file = state.sourceFileMap.get(context.file);
                if (!file || file.kind !== "regular" || startByte < 0 || endByte < startByte || endByte > file.bytes) {
                    throw new Error("Schema-23 mapped location exceeds its captured source revision.");
                }
            } else if (status !== "unverified" || startByte !== -1 || endByte !== -1) {
                throw new Error("Invalid schema-23 unverified physical location.");
            }
            if (["binding", "declaration", "expression"].includes(domain)) {
                reference(domain, 2, "physical location subject", false);
            } else if (domain === "conditional") {
                if (!state.conditionalBranches.has(subject)) throw new Error("Schema-23 conditional location is dangling.");
            } else if (domain === "conditional-end") {
                if (!state.conditionalEndings.has(subject)) throw new Error("Schema-23 conditional closure location is dangling.");
            } else if (domain === "defined-probe") {
                if (!state.conditionalProbeIds.has(subject)) throw new Error("Schema-23 defined-name location is dangling.");
            } else if (domain === "macro-attempt") {
                if (!state.macroInvocations.has(subject)) throw new Error("Schema-23 macro-attempt location is dangling.");
            } else if (domain === "macro-argument") {
                const argument = /^formal-(\d+)$/.exec(role);
                if (!state.macroArguments.get(subject)?.has(Number(argument?.[1]))) {
                    throw new Error("Schema-23 macro-argument location is dangling.");
                }
            } else if (domain === "macro-lifetime") {
                if (!state.macroLifecycleIds.has(subject)) throw new Error("Schema-23 macro-lifecycle location is dangling.");
            } else if (domain === "source-context") {
                if (!state.sourceContextIds.has(subject)) throw new Error("Schema-23 source-context location is dangling.");
            } else if (domain === "comment") {
                if (!state.commentIds.has(subject)) throw new Error("Schema-27 comment location is dangling.");
            } else if (domain === "include") {
                if (!state.includeOutcomeIds.has(subject)) throw new Error("Schema-23 include location is dangling.");
            } else if (domain === "remap") {
                if (!state.sourceRemapIds.has(subject)) throw new Error("Schema-23 remap location is dangling.");
            } else if (domain === "statement") {
                /* Operator/destination locations can be emitted while their
                   statement is still active. Require its opener here and its
                   closing STE after the complete stream has been read. */
                if (!state.statements.has(subject)) throw new Error("Schema-25 statement location has no observed opener.");
            } else if (domain === "construct") {
                if (!state.constructs.has(subject)) throw new Error("Schema-25 construct location has no observed opener.");
            } else throw new Error("Unknown schema-23 physical location domain.");
            const key = `${domain}:${subject}:${role}`;
            if (state.physicalLocationKeys.has(key)) throw new Error("Repeated schema-23 physical location attachment.");
            state.physicalLocationKeys.add(key);
            state.result.physicalLocations.push({ domain, subject, role, source, startLine, startColumn,
                endLine, endColumn, startByte, endByte, status });
            break;
        }
        case "ST": {
            const id = number(1, "source statement", 1);
            const parent = number(2, "source statement parent", 0);
            const construct = number(3, "source statement construct", 0);
            const owner = number(4, "source statement owner", 0);
            const source = number(5, "source statement context", 1);
            const context = number(6, "source statement configuration", 0);
            const module = number(7, "source statement module", 1);
            const ordinal = number(8, "source statement ordinal", 0);
            const token = number(9, "source statement token", 0);
            const tokenClass = number(10, "source statement token class", 0);
            if (state.statements.has(id) || parent !== (state.statementStack.at(-1) || 0) ||
                construct !== (state.constructStack.at(-1) || 0) || !state.sourceContextIds.has(source) ||
                state.sourceClosureIds.has(source) || module !== state.moduleCount ||
                context && (!state.configurationContextIds.has(context) || state.configurationModules.get(context) !== module) ||
                state.requireMacroConfiguration && context === 0) {
                throw new Error("Invalid schema-25 source statement identity or context.");
            }
            if (owner) reference("symbol", 4, "source statement owner", false);
            const physical = number(11, "source statement physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-25 source statement physical flag.");
            const statement = { id, parent, construct, owner, source, context, module, ordinal, token, tokenClass,
                physical: physical === 1, ...state.sourceRangeWithPhysicalFlag(row, 12, "source statement", physical === 1) };
            state.statements.set(id, statement);
            state.statementStack.push(id);
            state.result.statements.push(statement);
            break;
        }
        case "STE": {
            const id = number(1, "source statement end", 1);
            if (state.statementStack.at(-1) !== id || state.statementEndings.has(id) ||
                !["declaration", "compound", "call-or-assignment", "intrinsic", "assembly", "pointer-or-assignment", "label", "aggregate-member", "enumerator", "assembly-line", "unmatched"].includes(row[2]) ||
                !["parsed", "recovered", "unmatched"].includes(row[3]) || (row[2] === "unmatched") !== (row[3] === "unmatched")) {
                throw new Error("Invalid or out-of-order schema-25 statement end.");
            }
            const physical = number(4, "source statement end physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-25 source statement end flag.");
            /* Statement-end records are physical cursor points, not token spans. */
            const ending = { id, route: row[2], outcome: row[3], physical: physical === 1,
                ...state.sourceRangeWithPhysicalFlag(row, 5, "source statement end", physical === 1, true) };
            state.statementStack.pop();
            state.statementEndings.set(id, ending);
            state.result.statementEndings.push(ending);
            break;
        }
        case "BLK": {
            const id = number(1, "source construct", 1);
            const parent = number(2, "source construct parent", 0);
            const statement = number(3, "source construct opening statement", 0);
            const owner = number(4, "source construct owner", 0);
            const source = number(6, "source construct context", 1);
            const context = number(7, "source construct configuration", 0);
            if (state.constructs.has(id) || parent !== (state.constructStack.at(-1) || 0) ||
                statement !== (state.statementStack.at(-1) || 0) ||
                !["if", "for", "do", "while", "select", "with", "scope", "namespace", "extern", "procedure", "type", "union", "enum", "assembly"].includes(row[5]) ||
                !state.sourceContextIds.has(source) || state.sourceClosureIds.has(source) ||
                context && (!state.configurationContextIds.has(context) || state.configurationModules.get(context) !== state.moduleCount) ||
                state.requireMacroConfiguration && context === 0) {
                throw new Error("Invalid schema-25 source construct identity or context.");
            }
            if (owner) reference("symbol", 4, "source construct owner", false);
            const physical = number(8, "source construct physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-25 source construct physical flag.");
            const construct = { id, parent, statement, owner, kind: row[5], source, context,
                physical: physical === 1, ...state.sourceRangeWithPhysicalFlag(row, 9, "source construct", physical === 1) };
            state.constructs.set(id, construct);
            state.constructStack.push(id);
            state.result.constructs.push(construct);
            break;
        }
        case "BEND": {
            const id = number(1, "source construct end", 1);
            const statement = number(2, "source construct closing statement", 0);
            if (state.constructStack.at(-1) !== id || state.constructEndings.has(id) ||
                statement !== (state.statementStack.at(-1) || 0)) {
                throw new Error("Invalid or out-of-order schema-25 source construct end.");
            }
            const physical = number(3, "source construct end physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-25 source construct end flag.");
            const ending = { id, statement, physical: physical === 1,
                ...state.sourceRangeWithPhysicalFlag(row, 4, "source construct end", physical === 1) };
            state.constructStack.pop();
            state.constructEndings.set(id, ending);
            state.result.constructEndings.push(ending);
            break;
        }
        case "OWN": {
            const domain = row[1];
            const subject = number(2, "statement-owned subject", 1);
            const statement = number(3, "subject owner statement", 1);
            const key = `${domain}:${subject}`;
            if (!state.statements.has(statement) || !["node", "binding", "declaration", "expression"].includes(domain) ||
                state.statementOwnerKeys.has(key)) {
                throw new Error("Invalid or duplicate schema-25 statement ownership.");
            }
            reference(domain, 2, "statement-owned subject", false);
            state.statementOwnerKeys.add(key);
            state.result.statementOwners.push({ domain, subject, statement });
            break;
        }
        case "CAP": {
            const module = number(1, "capability module", 1);
            const feature = row[2];
            const coverage = row[3];
            const key = `${module}:${feature}`;
            if (module !== state.moduleCount || !feature || state.capabilityKeys.has(key) ||
                !["available", "partial", "unavailable"].includes(coverage)) {
                throw new Error("Invalid or duplicate schema-25 semantic capability.");
            }
            state.capabilityKeys.add(key);
            state.result.capabilities.push({ module, feature, coverage });
            break;
        }
        case "COM": {
            const identity = number(1, "accepted comment identity", 1);
            const configuration = number(2, "accepted comment configuration", 0);
            if (state.commentIds.has(identity) || !["apostrophe", "rem"].includes(row[3]) ||
                configuration && (!state.configurationContextIds.has(configuration) ||
                    state.configurationModules.get(configuration) !== state.moduleCount)) {
                throw new Error("Invalid or repeated schema-27 accepted comment marker.");
            }
            state.commentIds.add(identity);
            state.result.comments.push({ id: identity, module: state.moduleCount, configuration, kind: row[3] });
            break;
        }
        case "ACC": {
            const binding = number(1, "access binding", 1);
            if (state.accessRoleIds.has(binding) || !["read", "write", "read-write", "address", "byref", "callee"].includes(row[2])) {
                throw new Error("Invalid or duplicate source access role.");
            }
            reference("binding", 1, "source access occurrence", false);
            state.accessRoleIds.add(binding);
            state.result.accessRoles.push({ binding, role: row[2] });
            break;
        }
        case "SOP": {
            const statement = number(1, "operation statement", 1);
            if (!state.statements.has(statement) || !["file-open", "file-close", "file-seek", "file-get", "file-put", "file-lock", "file-unlock", "file-rename", "line-input",
                "goto", "gosub", "gosub-return", "gosub-return-label", "procedure-return", "procedure-explicit-exit",
                "function-result-return", "function-result-assignment", "on-goto", "on-gosub", "on-error-set", "on-error-clear",
                "namespace-import"].includes(row[2])) {
                throw new Error("Invalid source statement operation.");
            }
            state.result.statementOperations.push({ statement, operation: row[2] });
            break;
        }
        case "NT": {
            const domain = row[1];
            const identity = number(2, "normalized type subject", 1);
            const role = row[3];
            const primitive = row[4];
            const nominal = number(5, "normalized nominal type symbol", 0);
            const pointerDepth = number(6, "normalized pointer depth", 0);
            const isReference = number(7, "normalized reference flag", 0);
            const constBits = row[8];
            const storageBytes = row[9] ? number(9, "normalized storage width", 1) : null;
            const mangling = row[10];
            if (!["symbol", "node", "expression"].includes(domain) || role !== "value" ||
                !SCHEMA27_NORMALIZED_TYPE_NAMES.has(primitive) || mangling && !SCHEMA27_NORMALIZED_TYPE_NAMES.has(mangling) ||
                pointerDepth > SCHEMA27_MAX_POINTER_DEPTH || isReference > 1 || constBits.length !== pointerDepth + 1 || !/^[01]+$/.test(constBits) ||
                pointerDepth > 0 && storageBytes === null) {
                throw new Error("Invalid schema-27 normalized type subject, encoding, or module.");
            }
            reference(domain, 2, "normalized type subject", false);
            reference("symbol", 5, "normalized nominal type symbol");
            const key = `${domain}:${identity}:${role}`;
            if (domain !== "symbol" && state.normalizedTypeKeys.has(key)) {
                throw new Error("Repeated schema-27 normalized type subject.");
            }
            const normalized = { domain, identity, role, primitive, nominal, pointerDepth, isReference: isReference === 1,
                constBits, storageBytes, mangling, module: state.moduleCount };
            state.normalizedTypeKeys.set(key, normalized);
            state.result.normalizedTypes.push(normalized);
            break;
        }
        case "PH": {
            const id = number(1, "procedure flow phase", 1);
            const procedure = number(2, "flow phase procedure", 1);
            const emitted = number(4, "flow phase emitted flag", 0);
            if (state.flowPhases.has(id) || row[3] !== "pre-load" || emitted > 1) {
                throw new Error("Invalid schema-27 procedure flow phase.");
            }
            reference("symbol", 2, "flow phase procedure", false);
            const phase = { id, procedure, name: row[3], emitted: emitted === 1, module: state.moduleCount };
            state.flowPhases.set(id, phase);
            state.result.flowPhases.push(phase);
            break;
        }
        case "NP": {
            const node = number(1, "flow node", 1);
            const phase = number(2, "flow node phase", 1);
            if (state.flowNodePhases.has(node)) {
                throw new Error("Invalid or repeated schema-27 flow node assignment.");
            }
            reference("node", 1, "flow node", false);
            state.flowNodePhases.set(node, phase);
            state.result.nodePhases.push({ node, phase, module: state.moduleCount });
            break;
        }
        case "EV": {
            const parent = number(1, "evaluation parent node", 1);
            const child = number(2, "evaluation child node", 1);
            const ordinal = number(3, "evaluation ordinal", 0);
            const condition = row[4];
            const key = `${parent}:${child}`;
            if (parent === child || state.evaluationEdgeKeys.has(key) ||
                !["always", "argument", "profile-begin", "call-target", "profile-end", "copyback", "condition", "true", "false", "result"].includes(condition)) {
                throw new Error("Invalid or repeated schema-27 evaluation edge.");
            }
            reference("node", 1, "evaluation parent node", false);
            reference("node", 2, "evaluation child node", false);
            state.evaluationEdgeKeys.add(key);
            state.result.evaluationOrder.push({ parent, child, ordinal, condition, module: state.moduleCount });
            break;
        }
        case "CB": {
            const id = number(1, "control-flow block", 1);
            const phase = number(2, "control-flow block phase", 1);
            const ordinal = number(3, "control-flow block ordinal", 0);
            const ordinals = state.flowBlockOrdinals.get(phase) || new Set();
            if (state.flowBlocks.has(id) || ordinals.has(ordinal)) {
                throw new Error("Invalid or repeated schema-27 control-flow block.");
            }
            ordinals.add(ordinal);
            state.flowBlockOrdinals.set(phase, ordinals);
            const block = { id, phase, ordinal, module: state.moduleCount };
            state.flowBlocks.set(id, block);
            state.result.controlFlowBlocks.push(block);
            break;
        }
        case "CN": {
            const block = number(1, "control-flow block member", 1);
            const node = number(2, "control-flow root node", 1);
            const ordinal = number(3, "control-flow root ordinal", 0);
            if (state.flowBlockNodes.has(block) || ordinal !== 0) {
                throw new Error("Invalid or repeated schema-27 control-flow root.");
            }
            reference("node", 2, "control-flow root node", false);
            state.flowBlockNodes.set(block, node);
            state.result.controlFlowNodes.push({ block, node, ordinal, module: state.moduleCount });
            break;
        }
        case "CE": {
            const phase = number(1, "control-flow edge phase", 1);
            const source = number(2, "control-flow edge source block", 1);
            const target = number(3, "control-flow edge target block", 0);
            const kind = row[4];
            const label = number(5, "control-flow edge label", 0);
            reference("symbol", 5, "control-flow edge label");
            state.result.controlFlowEdges.push({ phase, source, target, kind, label, module: state.moduleCount });
            break;
        }
        case "CL": {
            const phase = number(1, "control-flow label phase", 1);
            const label = number(2, "control-flow label symbol", 1);
            const block = number(3, "control-flow label block", 1);
            const key = `${phase}:${label}`;
            if (state.flowLabels.has(key)) throw new Error("Repeated schema-27 control-flow label.");
            reference("symbol", 2, "control-flow label symbol", false);
            state.flowLabels.add(key);
            state.result.controlFlowLabels.push({ phase, label, block, module: state.moduleCount });
            break;
        }
        case "DI": {
            const id = number(1, "semantic diagnostic", 1);
            /* The compiler uses -1 for custom preprocessor diagnostics. */
            const code = number(3, "semantic diagnostic code", -1);
            const line = number(8, "semantic diagnostic line");
            const source = number(9, "semantic diagnostic source context", 0);
            const statement = number(10, "semantic diagnostic statement", 0);
            const procedure = number(11, "semantic diagnostic procedure", 0);
            if (state.diagnosticIds.has(id) || !["error", "warning"].includes(row[2]) ||
                source && (!state.sourceContextMap.has(source) || state.sourceClosureIds.has(source) ||
                    state.sourceContextMap.get(source).module !== state.moduleCount) ||
                statement && state.statements.get(statement)?.module !== state.moduleCount ||
                procedure && state.symbolModules.get(procedure) !== state.moduleCount) {
                throw new Error("Invalid or repeated schema-27 semantic diagnostic.");
            }
            if (statement && !state.statements.has(statement)) throw new Error("Semantic diagnostic refers to a missing statement.");
            reference("symbol", 11, "semantic diagnostic procedure");
            state.diagnosticIds.add(id);
            state.result.semanticDiagnostics.push({ id, severity: row[2], code, message: row[4], detail: row[5], customText: row[6],
                filePath: row[7], line, source, statement, procedure, module: state.moduleCount });
            break;
        }
        case "EX": {
            const identity = number(1, "source operation expression", 1);
            const family = row[2];
            const operator = row[3];
            const left = number(4, "source operation left operand", 0);
            const right = number(5, "source operation right operand", 0);
            const source = number(6, "source operation context", 1);
            const physical = number(7, "source operation physical flag", 0);
            const sourceContext = state.sourceContextMap.get(source);
            if (state.expressionOperandIds.has(identity)) throw new Error("Repeated schema-27 source expression operation.");
            if (!SCHEMA27_SOURCE_OPERATORS.get(family)?.has(operator)) {
                throw new Error(`Unknown schema-27 source operator family or code: ${family}:${operator}`);
            }
            const runtimeMacroBinary = family === "runtime-macro" && ["va-start", "va-copy"].includes(operator);
            if (!(left || right) || left >= identity || right >= identity ||
                family === "runtime-macro" && !left || runtimeMacroBinary && !right ||
                !["binary", "intrinsic-binary"].includes(family) && !runtimeMacroBinary && right !== 0) {
                throw new Error("Invalid schema-27 source expression operands.");
            }
            if (physical > 1) throw new Error("Invalid schema-27 source expression physical flag.");
            if (!sourceContext || sourceContext.module !== state.moduleCount) throw new Error("Schema-27 source expression refers to a missing or foreign source context.");
            reference("expression", 1, "source operation result", false);
            reference("expression", 4, "source operation left operand");
            reference("expression", 5, "source operation right operand");
            const operation = { identity, family, operator, left, right, source, physical: physical === 1, module: state.moduleCount,
                ...state.sourceRangeWithPhysicalFlag(row, 8, "source expression operation", physical === 1) };
            state.expressionOperandIds.set(identity, operation);
            state.result.expressionOperands.push(operation);
            break;
        }
        case "PPB": {
            const id = number(1, "conditional branch", 1);
            const parent = number(2, "conditional parent", 0);
            const group = number(3, "conditional group", 1);
            const source = number(4, "conditional source context", 1);
            const configuration = number(5, "conditional configuration", 0);
            const ordinal = number(6, "conditional branch ordinal", 0);
            const sourceContext = state.sourceContextMap.get(source);
            if (state.conditionalBranches.has(id) || !sourceContext || state.sourceClosureIds.has(source) ||
                sourceContext.module !== state.moduleCount || configuration &&
                (!state.configurationContextIds.has(configuration) || state.configurationModules.get(configuration) !== state.moduleCount)) {
                throw new Error("Invalid schema-21 conditional branch source or configuration.");
            }
            if (!["if", "ifdef", "ifndef", "elseif", "elseifdef", "elseifndef", "else"].includes(row[7])) {
                throw new Error("Unknown schema-21 conditional directive.");
            }
            const physical = number(8, "conditional branch physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-21 conditional branch physical flag.");
            const range = state.sourceRangeWithPhysicalFlag(row, 9, "conditional branch", physical === 1);
            if (ordinal === 0) {
                const expectedParent = state.conditionalStack.length
                    ? state.conditionalGroups.get(state.conditionalStack.at(-1))?.at(-1) || 0
                    : 0;
                if (group !== id || state.conditionalGroups.has(group) || parent !== expectedParent ||
                    !["if", "ifdef", "ifndef"].includes(row[7])) {
                    throw new Error("Invalid schema-21 conditional nesting or first branch.");
                }
                state.conditionalStack.push(group);
                state.conditionalGroups.set(group, []);
            } else {
                const members = state.conditionalGroups.get(group) || [];
                if (state.conditionalStack.at(-1) !== group || ordinal !== members.length ||
                    parent !== state.conditionalBranches.get(members[0])?.parent ||
                    ["if", "ifdef", "ifndef"].includes(row[7]) ||
                    state.conditionalBranches.get(members.at(-1))?.kind === "else") {
                    throw new Error("Invalid schema-21 conditional successor order.");
                }
            }
            const branch = { id, parent, group, source, configuration, ordinal, kind: row[7], physical: physical === 1, ...range };
            state.conditionalBranches.set(id, branch);
            state.conditionalGroups.get(group).push(id);
            state.result.conditionalBranches.push(branch);
            break;
        }
        case "PPD": {
            const id = number(1, "conditional decision branch", 1);
            const branch = state.conditionalBranches.get(id);
            if (!branch || state.conditionalDecisions.has(id) ||
                !["evaluated", "invalid", "parent-inactive", "unconditional"].includes(row[2])) {
                throw new Error("Invalid schema-21 conditional decision.");
            }
            let value = null;
            if (row[2] === "evaluated") value = number(3, "conditional result", 0);
            else if (row[3] !== "") throw new Error("Unevaluated condition advertises a result.");
            if (value !== null && value > 1) throw new Error("Invalid schema-21 conditional result.");
            const selected = number(4, "conditional selected flag", 0);
            const physical = number(5, "conditional decision physical flag", 0);
            if (selected > 1 || physical > 1 || ["invalid", "parent-inactive"].includes(row[2]) && selected !== 0 ||
                row[2] !== "parent-inactive" && (row[2] === "unconditional") !== (branch.kind === "else")) {
                throw new Error("Invalid schema-21 conditional decision flags.");
            }
            const decision = { id, evaluation: row[2], result: value, selected: selected === 1, physical: physical === 1,
                ...state.sourceRangeWithPhysicalFlag(row, 6, "conditional decision", physical === 1) };
            state.conditionalDecisions.set(id, decision);
            state.result.conditionalDecisions.push(decision);
            break;
        }
        case "PPE": {
            const group = number(1, "conditional closing group", 1);
            const source = number(2, "conditional closing source context", 1);
            if (state.conditionalStack.at(-1) !== group || state.conditionalEndings.has(group) ||
                !state.sourceContextIds.has(source) || state.sourceClosureIds.has(source)) {
                throw new Error("Invalid or out-of-order schema-21 conditional closure.");
            }
            const physical = number(3, "conditional closure physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-21 conditional closure flag.");
            const closure = { group, source, physical: physical === 1,
                ...state.sourceRangeWithPhysicalFlag(row, 4, "conditional closure", physical === 1) };
            state.conditionalStack.pop();
            state.conditionalEndings.add(group);
            state.result.conditionalClosures.push(closure);
            break;
        }
        case "PPT": {
            const id = number(1, "defined-name probe", 1);
            const branch = number(2, "defined-name probe branch", 0);
            const source = number(3, "defined-name probe source context", 1);
            const symbol = number(4, "defined-name probe symbol", 0);
            if (state.conditionalProbeIds.has(id) || branch && !state.conditionalBranches.has(branch) ||
                !state.sourceContextIds.has(source) || state.sourceClosureIds.has(source)) {
                throw new Error("Invalid schema-21 defined-name probe.");
            }
            const defined = number(6, "defined-name probe result", 0);
            const physical = number(7, "defined-name probe physical flag", 0);
            if (defined > 1 || physical > 1 || defined === 0 && symbol !== 0) {
                throw new Error("Invalid schema-21 defined-name probe result.");
            }
            if (symbol) reference("symbol", 4, "defined-name probe symbol", false);
            state.conditionalProbeIds.add(id);
            state.result.definedNameProbes.push({ id, branch, source, symbol, spelling: row[5], defined: defined === 1,
                physical: physical === 1,
                ...state.sourceRangeWithPhysicalFlag(row, 8, "defined-name probe", physical === 1) });
            break;
        }
        case "PPS": {
            const id = number(1, "inactive region identity", 1);
            const branch = number(2, "inactive region branch", 1);
            const source = number(3, "inactive region source context", 1);
            if (state.conditionalSkipIds.has(id) || !state.conditionalBranches.has(branch) ||
                !state.sourceContextIds.has(source) || state.sourceClosureIds.has(source)) {
                throw new Error("Invalid schema-21 inactive region.");
            }
            const physical = number(4, "inactive region physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-21 inactive region flag.");
            state.conditionalSkipIds.add(id);
            state.result.skippedRegions.push({ id, branch, source, physical: physical === 1,
                ...state.sourceRange(row, 5, "inactive region") });
            break;
        }
        case "MD": {
            const id = number(1, "macro definition", 1);
            const symbol = number(2, "macro definition symbol", 0);
            const module = number(3, "macro definition module", 1);
            const context = number(4, "macro definition configuration", 0);
            const parameterCount = number(7, "macro parameter count", 0);
            const flags = number(8, "macro definition flags", 0);
            const argless = number(9, "macro argless flag", 0);
            if (id > MAX_SEMANTIC_MODEL_RECORDS || state.macroDefinitions.has(id) || module !== state.moduleCount || !row[5] ||
                !["text", "tokens", "define-callback", "macro-callback"].includes(row[6]) || parameterCount > 32 || flags > 15 || argless > 1 ||
                context && (!state.configurationContextIds.has(context) || state.configurationModules.get(context) !== module) ||
                state.requireMacroConfiguration && context === 0 || state.requireMacroSymbol && symbol === 0) {
                throw new Error("Invalid schema-22 macro definition.");
            }
            if (symbol) reference("symbol", 2, "macro definition symbol", false);
            const definition = { id, symbol, module, context, name: row[5], kind: row[6], parameterCount, flags, argless: argless === 1 };
            state.macroDefinitions.set(id, definition);
            state.macroTokens.set(id, []);
            state.result.macroDefinitions.push(definition);
            break;
        }
        case "MT": {
            const definition = number(1, "macro token definition", 1);
            const ordinal = number(2, "macro token ordinal", 0);
            if (!state.macroDefinitions.has(definition) || !["parameter", "text", "wide-text", "parameter-reference", "stringify-reference"].includes(row[3])) {
                throw new Error("Invalid schema-22 macro definition token.");
            }
            const pasteBefore = number(5, "macro token paste flag", 0);
            if (pasteBefore > 1) throw new Error("Invalid schema-22 macro token paste flag.");
            let parameter = null;
            let value = row[4];
            if (["parameter-reference", "stringify-reference"].includes(row[3])) parameter = number(4, "macro parameter reference", 0);
            if (row[3] === "wide-text") semanticMacroUnits("wide-units", value, "macro token");
            const token = { definition, ordinal, kind: row[3], value, parameter, pasteBefore: pasteBefore === 1 };
            state.macroTokens.get(definition).push(token);
            state.result.macroTokens.push(token);
            break;
        }
        case "MI": {
            const id = number(1, "macro invocation", 1);
            const parent = number(2, "macro invocation parent", 0);
            const definition = number(3, "macro invocation definition", 1);
            const source = number(4, "macro invocation source context", 1);
            const context = number(5, "macro invocation configuration", 0);
            const conditional = number(6, "macro invocation conditional", 0);
            if (id > MAX_SEMANTIC_MODEL_RECORDS || state.macroInvocations.has(id) || !state.macroDefinitions.has(definition) ||
                parent && !state.macroInvocations.has(parent) || !state.sourceContextIds.has(source) || state.sourceClosureIds.has(source) ||
                context && (!state.configurationContextIds.has(context) || state.configurationModules.get(context) !== state.moduleCount) ||
                state.requireMacroConfiguration && context === 0 || conditional && !state.conditionalBranches.has(conditional) ||
                !["normal", "inactive", "evaluation"].includes(row[7]) || !["root", "replacement", "argument", "callback"].includes(row[8]) ||
                (parent === 0) !== (row[8] === "root")) {
                throw new Error("Invalid schema-22 macro invocation.");
            }
            const physical = number(9, "macro invocation physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-22 macro invocation physical flag.");
            const invocation = { id, parent, definition, source, context, conditional, phase: row[7], relation: row[8], physical: physical === 1,
                ...state.sourceRangeWithPhysicalFlag(row, 10, "macro invocation", physical === 1) };
            state.macroInvocations.set(id, invocation);
            state.macroArguments.set(id, new Map());
            state.macroSegments.set(id, []);
            state.result.macroInvocations.push(invocation);
            break;
        }
        case "MA": {
            const invocation = number(1, "macro argument invocation", 1);
            const ordinal = number(2, "macro argument ordinal", 0);
            const hasSource = number(5, "macro argument source flag", 0);
            const physical = number(6, "macro argument physical flag", 0);
            if (!state.macroInvocations.has(invocation) || state.macroArguments.get(invocation).has(ordinal) ||
                !["bytes", "wide-units"].includes(row[3]) || hasSource > 1 || physical > 1) {
                throw new Error("Invalid schema-22 macro argument.");
            }
            const units = semanticMacroUnits(row[3], row[4], "macro argument");
            let range = null;
            if (hasSource === 1) {
                range = state.sourceRangeWithPhysicalFlag(row, 7, "macro argument", physical === 1);
            } else if (physical !== 0 || row[7] !== "" || [8, 9, 10, 11].some((index) => number(index, "macro argument absent range", 0) !== 0)) {
                throw new Error("Absent schema-22 macro argument fabricates a source range.");
            }
            const argument = { invocation, ordinal, kind: row[3], value: row[4], units, hasSource: hasSource === 1, physical: physical === 1, range };
            state.macroArguments.get(invocation).set(ordinal, argument);
            state.result.macroArguments.push(argument);
            break;
        }
        case "MS": {
            const invocation = number(1, "macro substitution invocation", 1);
            const ordinal = number(2, "macro substitution ordinal", 0);
            const token = number(3, "macro substitution token", -1);
            const parameter = number(4, "macro substitution parameter", -1);
            if (!state.macroInvocations.has(invocation) || !["text", "parameter", "stringify", "callback", "definition-text", "restored-delimiter"].includes(row[5])) {
                throw new Error("Invalid schema-22 macro substitution.");
            }
            const offset = number(6, "macro substitution offset", 0);
            const units = number(7, "macro substitution units", 0);
            const segment = { invocation, ordinal, token, parameter, kind: row[5], offset, units };
            state.macroSegments.get(invocation).push(segment);
            state.result.macroSegments.push(segment);
            break;
        }
        case "MC": {
            const invocation = number(1, "macro callback invocation", 1);
            if (!state.macroInvocations.has(invocation) || state.macroCallbacks.has(invocation) || !["bytes", "wide-units"].includes(row[2])) {
                throw new Error("Invalid schema-22 macro callback output.");
            }
            const errorCode = number(3, "macro callback error code", 0);
            const units = semanticMacroUnits(row[2], row[4], "macro callback");
            const callback = { invocation, kind: row[2], errorCode, value: row[4], units };
            state.macroCallbacks.set(invocation, callback);
            state.result.macroCallbacks.push(callback);
            break;
        }
        case "ME": {
            const invocation = number(1, "macro result invocation", 1);
            if (!state.macroInvocations.has(invocation) || state.macroResults.has(invocation) ||
                !["expanded", "not-invoked", "unsupported", "recursive", "failed", "recovered"].includes(row[2]) ||
                !["bytes", "wide-units"].includes(row[3])) {
                throw new Error("Invalid schema-22 macro expansion result.");
            }
            const units = semanticMacroUnits(row[3], row[5], "macro expansion result");
            const declaredUnits = number(4, "macro expansion result units", 0);
            if (units.length !== declaredUnits) throw new Error("Macro output length disagrees with its replacement.");
            const argumentCount = number(6, "macro expansion argument count", 0);
            const physical = number(7, "macro expansion result physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-22 macro expansion result physical flag.");
            const result = { invocation, outcome: row[2], kind: row[3], declaredUnits, value: row[5], units, argumentCount, physical: physical === 1,
                ...state.sourceRangeWithPhysicalFlag(row, 8, "macro expansion result", physical === 1) };
            state.macroResults.set(invocation, result);
            state.result.macroResults.push(result);
            break;
        }
        case "ML": {
            const id = number(1, "macro lifecycle", 1);
            const definition = number(2, "macro lifecycle definition", 0);
            if (state.macroLifecycleIds.has(id) || definition && !state.macroDefinitions.has(definition) ||
                !["define", "identical", "definition-rejected", "undef", "undef-missing"].includes(row[3]) ||
                ["define", "identical", "undef"].includes(row[3]) && definition === 0 ||
                row[3] === "undef-missing" && definition !== 0) {
                throw new Error("Invalid schema-22 macro lifecycle event.");
            }
            const source = number(4, "macro lifecycle source context", 1);
            const context = number(5, "macro lifecycle configuration", 0);
            if (!state.sourceContextIds.has(source) || state.sourceClosureIds.has(source) ||
                context && (!state.configurationContextIds.has(context) || state.configurationModules.get(context) !== state.moduleCount) ||
                !row[6]) throw new Error("Invalid schema-22 macro lifecycle source or configuration.");
            if (state.requireMacroConfiguration && context === 0) throw new Error("Schema-22 macro lifecycle has no configuration.");
            const physical = number(7, "macro lifecycle physical flag", 0);
            if (physical > 1) throw new Error("Invalid schema-22 macro lifecycle physical flag.");
            const lifecycle = { id, definition, action: row[3], source, context, spelling: row[6], physical: physical === 1,
                ...state.sourceRangeWithPhysicalFlag(row, 8, "macro lifecycle", physical === 1) };
            state.macroLifecycleIds.add(id);
            state.result.macroLifecycles.push(lifecycle);
            break;
        }
        case "MR": {
            const domain = row[1];
            const subject = number(2, "macro origin subject", 1);
            const expansion = number(3, "macro origin expansion", 1);
            if (!state.macroInvocations.has(expansion) || !row[4]) throw new Error("Invalid schema-22 macro origin.");
            const key = `${domain}:${subject}:${row[4]}`;
            if (state.macroOrigins.has(key)) throw new Error("Repeated schema-22 macro origin attachment.");
            if (["expression", "binding", "declaration", "symbol"].includes(domain)) {
                reference(domain, 2, "macro origin subject", false);
            } else if (domain === "conditional") {
                if (!state.conditionalBranches.has(subject)) throw new Error("Schema-22 macro conditional origin is dangling.");
            } else if (domain === "defined-probe") {
                if (!state.conditionalProbeIds.has(subject)) throw new Error("Schema-22 macro defined-name origin is dangling.");
            } else if (domain === "macro-argument") {
                if (!state.macroInvocations.has(subject)) throw new Error("Schema-22 macro argument origin is dangling.");
            } else if (domain === "statement") {
                if (!state.statements.has(subject)) throw new Error("Schema-25 macro statement origin is dangling.");
            } else if (domain === "construct") {
                if (!state.constructs.has(subject)) throw new Error("Schema-25 macro construct origin is dangling.");
            } else throw new Error("Unknown schema-22 macro origin domain.");
            state.macroOrigins.add(key);
            state.result.macroOrigins.push({ domain, subject, expansion, role: row[4] });
            break;
        }
        case "ORIG": {
            if (!["node", "declaration", "expression", "binding"].includes(row[1])) throw new Error("Unknown schema-20 source-origin domain.");
            reference(row[1], 2, "source-origin identity", false);
            const source = number(3, "source-origin context", 1);
            const key = `${row[1]}:${row[2]}`;
            if (!state.sourceContextIds.has(source) || state.sourceOriginKeys.has(key)) throw new Error("Invalid or duplicate schema-20 source origin.");
            state.sourceOriginKeys.add(key);
            state.result.sourceOrigins.push({ domain: row[1], identity: Number(row[2]), source });
            break;
        }
        default:
            throw new Error(`Unknown schema-20 detail record type: ${tag}.`);
    }
}

function validateConditionalGraph(state, complete) {
    if (complete && (state.conditionalStack.length ||
        state.conditionalBranches.size !== state.conditionalDecisions.size)) {
        throw new Error("Compiler semantic conditional graph is incomplete.");
    }
    for (const members of state.conditionalGroups.values()) {
        let selected = false;
        for (const identity of members) {
            const branch = state.conditionalBranches.get(identity);
            const decision = state.conditionalDecisions.get(identity);
            if (!decision) continue;
            if (decision.evaluation === "parent-inactive") {
                const parent = state.conditionalBranches.get(branch.parent);
                const parentDecision = state.conditionalDecisions.get(branch.parent);
                if (!parent || !parentDecision || parentDecision.selected) {
                    throw new Error("Compiler semantic inactive conditional has no unselected parent.");
                }
            } else if (["evaluated", "unconditional"].includes(decision.evaluation)) {
                const expected = !selected && (decision.evaluation === "unconditional" || decision.result === 1);
                if (decision.selected !== expected) {
                    throw new Error("Compiler semantic conditional selection contradicts its result or prior branch.");
                }
            }
            selected ||= decision.selected;
        }
    }
    for (const skipped of state.result.skippedRegions) {
        const decision = state.conditionalDecisions.get(skipped.branch);
        if (!decision || decision.selected) {
            throw new Error("Compiler semantic selected branch advertises an inactive region.");
        }
    }
}

function validateSemanticConstructGraph(state, complete) {
    if (complete && (state.statementStack.length || state.constructStack.length ||
        state.statements.size !== state.statementEndings.size || state.constructs.size !== state.constructEndings.size)) {
        throw new Error("Compiler semantic source-construct graph is incomplete.");
    }
    if (state.requireMacroConfiguration &&
        ([...state.statements.values()].some((statement) => statement.context === 0) ||
         [...state.constructs.values()].some((construct) => construct.context === 0))) {
        throw new Error("Full semantic model source constructs lack configuration snapshots.");
    }
    for (const location of state.result.physicalLocations) {
        if (complete && location.domain === "statement" && !state.statementEndings.has(location.subject)) {
            throw new Error("Schema-25 statement location has no observed end.");
        }
        if (complete && location.domain === "construct" && !state.constructEndings.has(location.subject)) {
            throw new Error("Schema-25 construct location has no observed end.");
        }
    }
}

function validateSemanticExpressionOperands(state) {
    for (const operation of state.result.expressionOperands) {
        const source = state.sourceContextMap.get(operation.source);
        if (state.expressionModules.get(operation.identity) !== operation.module ||
            !source || source.module !== operation.module ||
            operation.left && state.expressionModules.get(operation.left) !== operation.module ||
            operation.right && state.expressionModules.get(operation.right) !== operation.module) {
            throw new Error("Schema-27 source expression operation crosses a module or source context.");
        }
    }
}

function validateSemanticParsedExpressionCoverage(state, complete) {
    const coverageByModule = (feature) => new Map(state.result.capabilities
        .filter((capability) => capability.feature === feature)
        .map((capability) => [capability.module, capability.coverage]));
    const operandCoverage = coverageByModule("parsed-expression-input-coverage");
    const iifCoverage = coverageByModule("parsed-iif-input-counts");
    const operandReceipts = new Map();
    const iifReceipts = new Map();
    const receiptProperty = /^parsed-(operand-count|expression-inputs|iif-count):(\d+)$/;
    const canonicalCount = (value, label) => {
        if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}.`);
        const count = Number(value);
        if (!Number.isSafeInteger(count)) throw new Error(`Invalid ${label}.`);
        return count;
    };
    const statementKey = (module, statement) => `${module}:${statement}`;

    for (const property of state.result.properties) {
        const match = receiptProperty.exec(property.name);
        if (!match) continue;
        const [, kind, statementText] = match;
        const statementId = canonicalCount(statementText, "parsed expression statement identity");
        const statement = state.statements.get(statementId);
        if (property.domain !== "symbol" || !statement || statement.module !== property.module ||
            statement.owner !== property.identity || state.symbolModules.get(property.identity) !== property.module) {
            throw new Error("Parsed expression receipt has a missing or foreign statement owner.");
        }
        const coverage = kind === "iif-count" ? iifCoverage.get(property.module) : operandCoverage.get(property.module);
        if (coverage !== "available") {
            throw new Error("Parsed expression receipt lacks an available capability.");
        }
        const receipts = kind === "iif-count" ? iifReceipts : operandReceipts;
        const key = statementKey(property.module, statementId);
        const values = receipts.get(key) || { statement, values: new Map() };
        if (values.values.has(kind)) throw new Error("Repeated parsed expression receipt.");
        if (kind === "expression-inputs") {
            if (!["available", "unavailable"].includes(property.value)) {
                throw new Error("Invalid parsed expression input coverage status.");
            }
            values.values.set(kind, property.value);
        } else {
            values.values.set(kind, canonicalCount(property.value, `parsed ${kind}`));
        }
        receipts.set(key, values);
    }

    const expressionOwners = new Map(state.result.statementOwners
        .filter((owner) => owner.domain === "expression")
        .map((owner) => [owner.subject, owner.statement]));
    const operandCounts = new Map();
    for (const operation of state.result.expressionOperands) {
        if (operandCoverage.get(operation.module) !== "available") continue;
        const statementId = expressionOwners.get(operation.identity);
        const statement = statementId && state.statements.get(statementId);
        if (!statement) continue;
        if (statement.module !== operation.module) throw new Error("Parsed expression operation has a foreign statement owner.");
        const key = statementKey(operation.module, statementId);
        operandCounts.set(key, (operandCounts.get(key) || 0) + 1);
    }

    const iifCounts = new Map();
    for (const relation of state.result.relationships) {
        if (relation.kind !== "parsed-iif") continue;
        if (relation.sourceDomain !== "symbol" || relation.targetDomain !== "expression" || relation.ordinal !== 0) {
            throw new Error("Invalid parsed IIf input relationship.");
        }
        if (iifCoverage.get(relation.module) !== "available") continue;
        const statementId = expressionOwners.get(relation.target);
        const statement = statementId && state.statements.get(statementId);
        if (!statement) continue;
        if (statement.module !== relation.module) throw new Error("Parsed IIf input has a foreign statement owner.");
        const key = statementKey(relation.module, statementId);
        iifCounts.set(key, (iifCounts.get(key) || 0) + 1);
    }

    for (const statement of state.result.statements) {
        const key = statementKey(statement.module, statement.id);
        const ending = state.statementEndings.get(statement.id);
        if (operandCoverage.get(statement.module) === "available") {
            const receipt = operandReceipts.get(key);
            if ((complete || ending) && (!receipt || receipt.values.size !== 2) ||
                receipt && (receipt.values.size !== 2 || receipt.values.get("operand-count") !== (operandCounts.get(key) || 0) ||
                    receipt.values.get("expression-inputs") === "available" && ending?.outcome !== "parsed")) {
                throw new Error("Parsed expression operand coverage does not match its statements.");
            }
        }
        if (iifCoverage.get(statement.module) === "available") {
            const receipt = iifReceipts.get(key);
            if ((complete || ending) && (!receipt || receipt.values.size !== 1) ||
                receipt && (receipt.values.size !== 1 || receipt.values.get("iif-count") !== (iifCounts.get(key) || 0))) {
                throw new Error("Parsed IIf input count does not match its statements.");
            }
        }
    }

    for (const [module, coverage] of operandCoverage) {
        if (coverage === "available") continue;
        if ([...operandReceipts.keys()].some((key) => key.startsWith(`${module}:`))) {
            throw new Error("Parsed expression operand receipts are present without available coverage.");
        }
    }
    for (const [module, coverage] of iifCoverage) {
        if (coverage === "available") continue;
        if ([...iifReceipts.keys()].some((key) => key.startsWith(`${module}:`))) {
            throw new Error("Parsed IIf receipts are present without available coverage.");
        }
    }
}

function validateSemanticIifInputs(state, complete) {
    const coverageByModule = new Map(state.result.capabilities
        .filter((capability) => capability.feature === "original-iif-inputs")
        .map((capability) => [capability.module, capability.coverage]));
    const inputsByResult = new Map();
    const markersByResult = new Map();
    const expressionOwners = new Map(state.result.statementOwners
        .filter((owner) => owner.domain === "expression")
        .map((owner) => [owner.subject, owner.statement]));
    const statementKey = (module, expression) => `${module}:${expression}`;
    for (const property of state.result.properties) {
        if (property.name !== "original-iif-inputs") continue;
        const moduleCoverage = coverageByModule.get(property.module);
        if (moduleCoverage !== "available") {
            if (moduleCoverage === "unavailable") throw new Error("Original IIf inputs are present without available coverage.");
            continue;
        }
        if (property.domain !== "expression") throw new Error("Original IIf inputs have an invalid property domain.");
        const resultId = property.identity;
        const statementId = expressionOwners.get(resultId);
        const statement = statementId && state.statements.get(statementId);
        const ending = statementId && state.statementEndings.get(statementId);
        const inputs = property.value.split("\t");
        if (inputsByResult.has(statementKey(property.module, resultId)) || inputs.length !== 3 ||
            state.expressionModules.get(resultId) !== property.module || !statement ||
            statement.module !== property.module || ending?.outcome !== "parsed") {
            throw new Error("Original IIf inputs have no complete parsed statement.");
        }
        const identities = inputs.map((value) => {
            if (!/^[1-9]\d*$/.test(value)) return 0;
            const identity = Number(value);
            return Number.isSafeInteger(identity) ? identity : 0;
        });
        if (!identities[0] || identities[0] >= identities[1] || identities[1] >= identities[2] ||
            identities[2] >= resultId) {
            throw new Error("Original IIf input identities are invalid or out of parse order.");
        }
        for (const identity of identities) {
            if (state.expressionModules.get(identity) !== property.module ||
                expressionOwners.get(identity) !== statementId) {
                throw new Error("Original IIf input belongs to another statement or module.");
            }
        }
        inputsByResult.set(statementKey(property.module, resultId), {
            module: property.module,
            result: resultId,
            statement: statementId,
            condition: identities[0],
            trueArm: identities[1],
            falseArm: identities[2]
        });
    }

    for (const relation of state.result.relationships) {
        if (relation.kind !== "parsed-iif") continue;
        const moduleCoverage = coverageByModule.get(relation.module);
        if (moduleCoverage !== "available") {
            if (moduleCoverage === "unavailable") throw new Error("Original IIf marker is present without available coverage.");
            continue;
        }
        const key = statementKey(relation.module, relation.target);
        const input = inputsByResult.get(key);
        if (relation.sourceDomain !== "symbol" || relation.targetDomain !== "expression" || relation.ordinal !== 0 ||
            !input || markersByResult.has(key) || state.namespaceSymbolParents.get(relation.source) !== 0 ||
            state.symbolModules.get(relation.source) !== relation.module) {
            throw new Error("Original IIf marker is invalid or has no matching inputs.");
        }
        markersByResult.set(key, relation);
    }

    if (complete && inputsByResult.size !== markersByResult.size ||
        [...inputsByResult.keys()].some((key) => !markersByResult.has(key)) ||
        [...markersByResult.keys()].some((key) => !inputsByResult.has(key))) {
        throw new Error("Original IIf input receipts and occurrence markers do not match.");
    }
}

function validateSemanticNumericAssignmentTargets(state) {
    const coverageByModule = new Map(state.result.capabilities
        .filter((capability) => capability.feature === "numeric-assignment-targets")
        .map((capability) => [capability.module, capability.coverage]));
    const groups = new Map();
    for (const property of state.result.properties) {
        if (!["assignment-target-dtype", "assignment-kind"].includes(property.name)) continue;
        const coverage = coverageByModule.get(property.module);
        if (coverage !== "available") {
            if (coverage === "unavailable") throw new Error("Numeric assignment target is present without available coverage.");
            continue;
        }
        if (property.domain !== "expression" || state.expressionModules.get(property.identity) !== property.module) {
            throw new Error("Numeric assignment target has an invalid expression owner.");
        }
        const key = `${property.module}:${property.identity}`;
        const group = groups.get(key) || { module: property.module, identity: property.identity, values: new Map() };
        if (group.values.has(property.name)) throw new Error("Repeated numeric assignment target property.");
        group.values.set(property.name, property.value);
        groups.set(key, group);
    }

    for (const group of groups.values()) {
        const dtypeText = group.values.get("assignment-target-dtype");
        const kind = group.values.get("assignment-kind");
        if (group.values.size !== 2 || !/^(?:0|[1-9]\d*)$/.test(dtypeText || "") ||
            !["assignment", "initializer"].includes(kind)) {
            throw new Error("Numeric assignment target has an incomplete or invalid property pair.");
        }
        const dtype = Number(dtypeText);
        const primitiveKinds = state.primitiveKindsByModule.get(group.module);
        if (!Number.isSafeInteger(dtype) || !["integer", "float"].includes(primitiveKinds?.get(dtype))) {
            throw new Error("Numeric assignment target is not a primitive numeric type.");
        }
    }
}

function validateSemanticSourceVaListOperations(state) {
    const capabilityCoverage = new Map(state.result.capabilities
        .filter((capability) => capability.feature === "source-va-list-operations")
        .map((capability) => [capability.module, capability.coverage]));
    const operations = new Map();
    for (const operation of state.result.expressionOperands) {
        if (operation.family !== "runtime-macro") continue;
        if (capabilityCoverage.get(operation.module) !== "available") {
            throw new Error("Cva_List source operation lacks an available capability.");
        }
        const expression = state.sourceOperationExpressions.get(operation.identity);
        if (!expression || expression.operatorCode !== operation.operator || expression.operatorKind !== "builtin" ||
            expression.physical !== operation.physical || expression.filePath !== operation.filePath ||
            expression.startLine !== operation.startLine || expression.startColumn !== operation.startColumn ||
            operation.endLine > expression.endLine || operation.endLine === expression.endLine &&
                operation.endColumn > expression.endColumn) {
            throw new Error("Cva_List source operation disagrees with its result expression.");
        }
        if (operations.has(operation.identity)) throw new Error("Repeated Cva_List source operation result.");
        operations.set(operation.identity, operation);

        const leftType = state.normalizedTypeKeys.get(`expression:${operation.left}:value`);
        const rightType = state.normalizedTypeKeys.get(`expression:${operation.right}:value`);
        const compatible = (type) => type && (type.mangling === "va_list" || type.primitive === "va_list" ||
            type.primitive === "any" && type.pointerDepth > 0);
        if (leftType && !compatible(leftType) ||
            operation.operator === "va-copy" && rightType && !compatible(rightType)) {
            throw new Error("Cva_List source operation has an incompatible operand.");
        }

        if (!expression.typeName && (!["va-start", "va-copy", "va-end"].includes(operation.operator) ||
            expression.astClass !== 44 || expression.operator !== -1 || expression.dtype !== 2147483648)) {
            throw new Error("Cva_List statement operation has an invalid untyped result expression.");
        }
    }

    for (const expression of state.sourceOperationExpressions.values()) {
        const operation = operations.get(expression.id);
        const supported = ["va-start", "va-arg", "va-copy", "va-end"].includes(expression.operatorCode);
        if (expression.typeName && !supported) continue;
        if (!operation || capabilityCoverage.get(expression.module) !== "available" || !supported ||
            !expression.typeName && (![
                "va-start", "va-copy", "va-end"
            ].includes(expression.operatorCode) ||
                expression.astClass !== 44 || expression.operator !== -1 || expression.dtype !== 2147483648)) {
            throw new Error("Compiler semantic expression has no matching Cva_List source operation.");
        }
    }
}

function validateSemanticComments(state, complete) {
    const capabilityCoverage = new Map(state.result.capabilities
        .filter((capability) => capability.feature === "accepted-line-comment-markers")
        .map((capability) => [capability.module, capability.coverage]));
    const locations = new Map(state.result.physicalLocations
        .filter((location) => location.domain === "comment")
        .map((location) => [location.subject, location]));
    const counts = new Map();
    for (const comment of state.result.comments) {
        if (capabilityCoverage.get(comment.module) !== "available") {
            throw new Error("Accepted comment lacks an available semantic capability.");
        }
        const location = locations.get(comment.id);
        const context = location && state.sourceContextMap.get(location.source);
        if (!location || location.role !== "marker" || !context || context.module !== comment.module ||
            location.startLine !== location.endLine ||
            location.endColumn - location.startColumn !== (comment.kind === "apostrophe" ? 1 : 3)) {
            throw new Error("Accepted comment has no matching physical marker location.");
        }
        if (comment.configuration && (!state.configurationContextIds.has(comment.configuration) ||
            state.configurationModules.get(comment.configuration) !== comment.module)) {
            throw new Error("Accepted comment belongs to a foreign configuration.");
        }
        counts.set(comment.module, (counts.get(comment.module) || 0) + 1);
    }

    const closures = new Map();
    for (const property of state.result.properties) {
        if (!property.name.startsWith("accepted-line-comment-count:")) continue;
        const suffix = property.name.slice("accepted-line-comment-count:".length);
        const module = state.number(suffix, "accepted comment count module", 1);
        const count = state.number(property.value, "accepted comment count", 0);
        if (String(module) !== suffix || String(count) !== property.value || module !== property.module ||
            property.domain !== "symbol" || state.namespaceSymbolParents.get(property.identity) !== 0 ||
            state.symbolModules.get(property.identity) !== module || closures.has(module)) {
            throw new Error("Invalid or duplicate accepted comment coverage count.");
        }
        closures.set(module, count);
    }

    for (const [module, coverage] of capabilityCoverage) {
        if (coverage === "available") {
            const count = closures.get(module);
            if (complete && (count === undefined || count !== (counts.get(module) || 0))) {
                throw new Error("Accepted comment coverage is incomplete.");
            }
            if (count !== undefined && count !== (counts.get(module) || 0)) {
                throw new Error("Accepted comment count disagrees with its observations.");
            }
        } else if ((counts.get(module) || 0) !== 0 || closures.has(module)) {
            throw new Error("Unavailable accepted comment coverage contains observations.");
        }
    }
}

function validateSemanticArrayStorage(state) {
    const capabilityCoverage = new Map(state.result.capabilities
        .filter((capability) => capability.feature === "array-storage-inputs")
        .map((capability) => [capability.module, capability.coverage]));
    const groups = new Map();
    const numericProperty = (value, label, minimum = 0) => {
        if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label}.`);
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`Invalid ${label}.`);
        return result;
    };
    for (const property of state.result.properties) {
        if (property.domain !== "expression" || !property.name.startsWith("array-storage-")) continue;
        if (capabilityCoverage.get(property.module) !== "available") {
            throw new Error("Array storage properties lack an available capability.");
        }
        const key = `${property.module}:${property.identity}`;
        const group = groups.get(key) || { module: property.module, expression: property.identity, values: new Map() };
        if (group.values.has(property.name)) throw new Error("Repeated array storage property.");
        group.values.set(property.name, property.value);
        groups.set(key, group);
    }

    const relationships = state.result.relationships || [];
    const rootRelations = relationships.filter((relation) => relation.kind === "array-storage-root");
    if (!rootRelations.length && !groups.size) return;
    const matching = (module, sourceDomain, source, targetDomain, target, kind) => relationships.filter((relation) =>
        relation.module === module && relation.sourceDomain === sourceDomain && relation.source === source &&
        relation.targetDomain === targetDomain && relation.target === target && relation.kind === kind && relation.ordinal === 0
    );
    const symbols = new Map((state.result.symbols || []).map((symbol) => [symbol.id, symbol]));
    const nodes = new Map((state.result.nodes || []).map((node) => [node.id, node]));
    const owners = new Map((state.result.statementOwners || [])
        .filter((owner) => owner.domain === "node")
        .map((owner) => [owner.subject, owner.statement]));
    const inputRelations = relationships.filter((relation) => relation.kind === "array-storage-input");
    const selectionRelations = relationships.filter((relation) => relation.kind === "array-storage-selection");
    const rootsByNode = new Map();
    for (const relation of rootRelations) {
        if (relation.sourceDomain !== "symbol" || relation.targetDomain !== "node" || relation.ordinal !== 0 ||
            rootsByNode.has(relation.target) || capabilityCoverage.get(relation.module) !== "available") {
            throw new Error("Invalid array storage root relationship.");
        }
        const symbol = symbols.get(relation.source);
        const node = nodes.get(relation.target);
        if ((symbol && (symbol.symbolClass !== 12 || state.symbolModules.get(symbol.id) !== relation.module)) ||
            !node || node.edge !== "root" || state.nodeModules.get(node.id) !== relation.module) {
            throw new Error("Array storage root does not name a same-module field and AST root.");
        }
        const statement = owners.get(node.id);
        if (!statement || !state.statements.has(statement)) throw new Error("Array storage root has no accepted statement owner.");
        rootsByNode.set(node.id, { module: relation.module, symbol: relation.source, statement });
    }

    const selectedRoots = new Set();
    for (const group of groups.values()) {
        const value = (name) => group.values.get(name);
        if (!value("array-storage-symbol") || !value("array-storage-kind") || !value("array-storage-receiver")) {
            throw new Error("Array storage expression has an incomplete property group.");
        }
        const symbol = numericProperty(value("array-storage-symbol"), "array storage symbol", 1);
        const receiver = numericProperty(value("array-storage-receiver"), "array storage receiver");
        const kind = value("array-storage-kind");
        if (kind !== "field" && kind !== "variable") throw new Error("Unknown array storage kind.");
        if (state.symbolModules.get(symbol) !== group.module ||
            matching(group.module, "symbol", symbol, "expression", group.expression, "array-storage-selection").length !== 1) {
            throw new Error("Array storage selection lacks its exact symbol relation.");
        }
        if (kind === "field") {
            const root = rootsByNode.get(receiver);
            if (!root || root.module !== group.module || root.symbol !== symbol ||
                matching(group.module, "expression", group.expression, "node", receiver, "array-storage-input").length !== 1) {
                throw new Error("Array field storage lacks its exact receiver relations.");
            }
            selectedRoots.add(receiver);
        } else if (receiver !== 0 || matching(group.module, "expression", group.expression, "node", receiver, "array-storage-input").length) {
            throw new Error("Plain array storage fabricates a receiver node.");
        }
    }

    for (const relation of selectionRelations) {
        if (relation.sourceDomain !== "symbol" || relation.targetDomain !== "expression" ||
            !groups.has(`${relation.module}:${relation.target}`) ||
            numericProperty(groups.get(`${relation.module}:${relation.target}`).values.get("array-storage-symbol") || "", "array storage selection symbol", 1) !== relation.source) {
            throw new Error("Orphan or inconsistent array storage selection.");
        }
    }
    for (const relation of inputRelations) {
        const group = relation.sourceDomain === "expression" && groups.get(`${relation.module}:${relation.source}`);
        if (relation.targetDomain !== "node" || !group || group.values.get("array-storage-kind") !== "field" ||
            numericProperty(group.values.get("array-storage-receiver") || "", "array storage input receiver", 1) !== relation.target) {
            throw new Error("Orphan or inconsistent array storage input.");
        }
    }
    if (selectedRoots.size !== rootsByNode.size || [...rootsByNode.keys()].some((root) => !selectedRoots.has(root))) {
        throw new Error("Array storage receiver roots are not covered by selected inputs.");
    }

    const completeStorageModules = new Set([...capabilityCoverage.entries()]
        .filter(([, coverage]) => coverage === "available")
        .map(([module]) => module));
    for (const property of state.result.properties) {
        if (property.domain !== "expression" ||
            !["array-subscript-symbol", "array-bound-symbol"].includes(property.name) ||
            !completeStorageModules.has(property.module)) continue;
        if (!groups.has(`${property.module}:${property.identity}`)) {
            throw new Error("Array subscript or bound query lacks its original storage group.");
        }
    }

    if (!rootsByNode.size) return;
    const treeRoots = new Map();
    for (const node of [...state.result.nodes].sort((left, right) => left.id - right.id)) {
        const root = node.edge === "root" ? node.id : treeRoots.get(node.parent);
        if (!root) throw new Error("Array storage tree has a missing parent node.");
        treeRoots.set(node.id, root);
        const owner = rootsByNode.get(root);
        if (!owner) continue;
        if (state.nodeModules.get(node.id) !== owner.module ||
            owners.get(node.id) !== owner.statement || state.flowNodePhases.has(node.id)) {
            throw new Error("Array storage tree has a foreign owner, module, or execution phase.");
        }
    }
}

function validateSemanticNormalizedTypes(state) {
    const modules = { symbol: state.symbolModules, node: state.nodeModules, expression: state.expressionModules };
    for (const type of state.result.normalizedTypes) {
        if (modules[type.domain]?.get(type.identity) !== type.module) {
            throw new Error("Schema-27 normalized type refers to a missing or foreign subject.");
        }
    }
}

function validateSemanticPolicyInputs(state, complete) {
    const featureKeys = new Map(state.result.capabilities.map((capability) => [
        `${capability.module}:${capability.feature}`, capability.coverage
    ]));
    const capability = (module, feature) => featureKeys.get(`${module}:${feature}`) || "missing";
    const globalNamespace = (identity, module) => {
        return state.namespaceSymbolParents.get(identity) === 0 && state.symbolModules.get(identity) === module;
    };
    const namespace = (identity, module) => {
        return state.namespaceSymbolParents.has(identity) && state.symbolModules.get(identity) === module;
    };
    const canonicalInteger = (value, label, minimum = 0) => {
        if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid compiler semantic ${label}.`);
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`Invalid compiler semantic ${label}.`);
        return result;
    };
    const sourceFilePath = (source) => state.sourceFileMap.get(source.file)?.filePath || "";
    const sourcePolicies = new Map();
    const libraryCounts = new Map();
    const importCounts = new Map();
    const importRecipients = new Map();
    const namespaceDeclarations = new Map();
    const libraryIdentities = new Set();
    const namespaceImportOperations = new Map();
    const sourceLibraries = [];
    const sourceImports = [];
    const sourceNamespaceDeclarations = [];
    const physicalLocations = new Map(state.result.physicalLocations.map((location) =>
        [`${location.domain}:${location.subject}:${location.role}`, location]));
    const macroOrigins = new Map(state.result.macroOrigins.map((origin) =>
        [`${origin.domain}:${origin.subject}:${origin.role}`, origin]));

    if (state.result.properties.length > MAX_EDITOR_SEMANTIC_POLICY_FACTS * 8) {
        throw new Error("Compiler semantic property inventory exceeded its policy validation bound.");
    }

    for (const property of state.result.properties) {
        const isPolicy = property.name.startsWith("header-policy:");
        const isLibrary = property.name.startsWith("header-library:");
        const isImport = property.name.startsWith("header-import:");
        const isNamespaceDeclaration = property.name.startsWith("namespace-declaration:");
        if (!isPolicy && !isLibrary && !isImport && !isNamespaceDeclaration) continue;

        const owner = property.identity;
        const sourceModule = property.module;
        const relevantCount = sourcePolicies.size + libraryIdentities.size + importRecipients.size + namespaceDeclarations.size;
        if (relevantCount >= MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
            throw new Error("Compiler semantic policy facts exceeded their 250000-entry bound.");
        }

        if (isPolicy || isLibrary || isImport) {
            if (property.domain !== "symbol" || !globalNamespace(owner, sourceModule)) {
                throw new Error("Compiler source header policy is not owned by its module global namespace.");
            }
        } else if (property.domain !== "symbol" || !state.symbolModules.has(owner) || state.symbolModules.get(owner) !== sourceModule) {
            throw new Error("Compiler namespace declaration is not owned by a same-module symbol.");
        }

        if (isPolicy) {
            const sourceId = canonicalInteger(property.name.slice("header-policy:".length), "source header policy source", 1);
            const source = state.sourceContextMap.get(sourceId);
            const values = property.value.split("\t");
            if (property.name !== `header-policy:${sourceId}` || !source || source.module !== sourceModule ||
                capability(sourceModule, "source-header-policy-inputs") !== "available" ||
                sourcePolicies.has(sourceId) || values.length !== 3 || !["0", "1"].includes(values[0])) {
                throw new Error("Invalid or repeated compiler source header policy.");
            }
            const libraryCount = canonicalInteger(values[1], "source header library count");
            const namespaceImportCount = canonicalInteger(values[2], "source header import count");
            sourcePolicies.set(sourceId, { module: sourceModule, owner, source: sourceId,
                filePath: sourceFilePath(source), kind: source.kind, pragmaOnce: values[0] === "1",
                libraryCount, namespaceImportCount });
            continue;
        }

        if (isLibrary) {
            const identity = canonicalInteger(property.name.slice("header-library:".length), "source header library identity", 1);
            const values = property.value.split("\t");
            if (property.name !== `header-library:${identity}` || libraryIdentities.has(identity) || values.length !== 4) {
                throw new Error("Invalid or repeated compiler source header library input.");
            }
            const sourceId = canonicalInteger(values[0], "source header library source", 1);
            const source = state.sourceContextMap.get(sourceId);
            const value = decodeSemanticString(values[2], "source header library value", state.schemaVersion);
            const branch = canonicalInteger(values[3], "source header library conditional branch");
            if (!source || source.module !== sourceModule ||
                capability(sourceModule, "source-header-policy-inputs") !== "available" ||
                !["inclib", "libpath"].includes(values[1]) || value.includes("\0")) {
                throw new Error("Invalid compiler source header library input.");
            }
            if (branch) {
                const conditional = state.conditionalBranches.get(branch);
                if (!conditional || state.sourceContextMap.get(conditional.source)?.module !== sourceModule) {
                    throw new Error("Compiler source header library input names a foreign conditional branch.");
                }
            }
            libraryIdentities.add(identity);
            libraryCounts.set(sourceId, (libraryCounts.get(sourceId) || 0) + 1);
            const role = property.name;
            const location = physicalLocations.get(`source-context:${sourceId}:${role}`) || null;
            const macroOrigin = macroOrigins.get(`symbol:${owner}:${role}`) || null;
            sourceLibraries.push({ module: sourceModule, owner, identity, source: sourceId,
                filePath: sourceFilePath(source), kind: values[1], value, conditionalBranch: branch,
                location: location ? { ...location, filePath: sourceFilePath(source) } : null, macroOrigin });
            continue;
        }

        if (isImport) {
            const statementId = canonicalInteger(property.name.slice("header-import:".length), "namespace import statement", 1);
            const values = property.value.split("\t");
            const sourceId = canonicalInteger(values[0] || "", "namespace import source", 1);
            const recipientId = canonicalInteger(values[1] || "", "namespace import recipient", 1);
            const source = state.sourceContextMap.get(sourceId);
            const statement = state.statements.get(statementId);
            if (property.name !== `header-import:${statementId}` || values.length !== 2 ||
                capability(sourceModule, "source-header-policy-inputs") !== "available" ||
                capability(sourceModule, "namespace-import-recipient-inputs") !== "available" ||
                !source || source.module !== sourceModule || !statement || statement.source !== sourceId ||
                statement.module !== sourceModule || !namespace(recipientId, sourceModule) || importRecipients.has(statementId)) {
                throw new Error("Invalid or repeated compiler namespace import recipient.");
            }
            importRecipients.set(statementId, sourceId);
            sourceImports.push({ module: sourceModule, owner, statement: statementId,
                source: sourceId, filePath: sourceFilePath(source), recipient: recipientId });
            continue;
        }

        const constructId = canonicalInteger(property.name.slice("namespace-declaration:".length), "namespace declaration construct", 1);
        const values = property.value.split("\t");
        const statementId = canonicalInteger(values[0] || "", "namespace declaration statement", 1);
        const namespaceId = canonicalInteger(values[1] || "", "namespace declaration symbol", 1);
        const construct = state.constructs.get(constructId);
        const statement = state.statements.get(statementId);
        const source = construct && state.sourceContextMap.get(construct.source);
        if (property.name !== `namespace-declaration:${constructId}` || values.length !== 3 ||
            capability(sourceModule, "namespace-declaration-inputs") !== "available" ||
            !["0", "1"].includes(values[2]) || namespaceDeclarations.has(constructId) ||
            !construct || construct.kind !== "namespace" || construct.statement !== statementId ||
            construct.owner !== owner || !source || source.module !== sourceModule ||
            !statement || statement.owner !== owner || statement.module !== sourceModule ||
            !namespace(namespaceId, sourceModule)) {
            throw new Error("Invalid compiler namespace declaration input.");
        }
        namespaceDeclarations.set(constructId, true);
        sourceNamespaceDeclarations.push({ module: sourceModule, owner, construct: constructId,
            statement: statementId, source: construct.source, filePath: sourceFilePath(source),
            namespace: namespaceId, anonymous: values[2] === "1" });
    }

    for (const operation of state.result.statementOperations) {
        if (operation.operation !== "namespace-import") continue;
        if (namespaceImportOperations.has(operation.statement)) throw new Error("Repeated compiler namespace import operation.");
        const statement = state.statements.get(operation.statement);
        const source = statement && state.sourceContextMap.get(statement.source);
        if (!statement || !source || statement.module !== source.module) {
            throw new Error("Compiler namespace import operation has no same-module source statement.");
        }
        namespaceImportOperations.set(operation.statement, source.id);
        importCounts.set(source.id, (importCounts.get(source.id) || 0) + 1);
        if (capability(source.module, "namespace-import-recipient-inputs") === "available" &&
            importRecipients.get(operation.statement) !== source.id && complete) {
            throw new Error("Compiler namespace import is missing its accepted recipient input.");
        }
    }

    for (const [sourceId, policy] of sourcePolicies) {
        if (policy.libraryCount !== (libraryCounts.get(sourceId) || 0) ||
            policy.namespaceImportCount !== (importCounts.get(sourceId) || 0)) {
            throw new Error("Compiler source header policy counts disagree with accepted inputs.");
        }
    }

    for (const source of state.sourceContextMap.values()) {
        if (complete && capability(source.module, "source-header-policy-inputs") === "available" && !sourcePolicies.has(source.id)) {
            throw new Error("Compiler source header policy occurrence coverage is incomplete.");
        }
    }
    for (const construct of state.constructs.values()) {
        if (complete && construct.kind === "namespace" &&
            capability(construct.module, "namespace-declaration-inputs") === "available" && !namespaceDeclarations.has(construct.id)) {
            throw new Error("Compiler namespace declaration coverage is incomplete.");
        }
    }
    for (const [statementId, sourceId] of namespaceImportOperations) {
        const source = state.sourceContextMap.get(sourceId);
        if (complete && capability(source.module, "namespace-import-recipient-inputs") === "available" &&
            importRecipients.get(statementId) !== sourceId) {
            throw new Error("Compiler namespace import recipient coverage is incomplete.");
        }
    }
    for (const [statementId, sourceId] of importRecipients) {
        if (namespaceImportOperations.get(statementId) !== sourceId) {
            throw new Error("Compiler namespace import recipient has no matching accepted operation.");
        }
    }

    state.result.sourceHeaderPolicies.push(...sourcePolicies.values());
    state.result.sourceHeaderLibraries.push(...sourceLibraries);
    state.result.namespaceImportRecipients.push(...sourceImports);
    state.result.namespaceDeclarations.push(...sourceNamespaceDeclarations);
}

function validateSemanticFlowGraph(state, complete) {
    validateSemanticArrayStorage(state);
    const hasFlowFacts = state.flowPhases.size || state.flowNodePhases.size || state.result.evaluationOrder.length ||
        state.flowBlocks.size || state.flowBlockNodes.size || state.result.controlFlowEdges.length || state.flowLabels.size;
    if (!hasFlowFacts) return;

    const nodes = new Map(state.result.nodes.map((node) => [node.id, node]));
    for (const phase of state.flowPhases.values()) {
        if (!state.procedureSignatureIds.has(phase.procedure) ||
            state.symbolModules.get(phase.procedure) !== phase.module) {
            throw new Error("Schema-27 procedure flow phase refers to a missing or foreign procedure signature.");
        }
    }
    for (const [node, phase] of state.flowNodePhases) {
        const nodeModule = state.nodeModules.get(node);
        if (!nodes.has(node) || !state.flowPhases.has(phase) || nodeModule !== state.flowPhases.get(phase).module) {
            throw new Error("Schema-27 flow node has a missing or foreign phase.");
        }
    }

    const roots = new Map();
    for (const node of [...state.result.nodes].sort((left, right) => left.id - right.id)) {
        let root;
        if (node.edge === "root") root = node.id;
        else root = roots.get(node.parent);
        if (!root) throw new Error("Schema-27 AST phase graph has a missing parent node.");
        roots.set(node.id, root);
        const phaseId = state.flowNodePhases.get(node.id);
        if (phaseId === undefined) {
            if (!state.unphasedNodeRoots.has(root)) {
                throw new Error("Schema-27 AST phase membership is incomplete; an unphased tree lacks an initializer owner.");
            }
        } else if (node.edge === "root") {
            if (state.flowPhases.get(phaseId).procedure !== node.parent) {
                throw new Error("Schema-27 procedure phase root belongs to another procedure.");
            }
        } else if (state.flowNodePhases.get(node.parent) !== phaseId) {
            throw new Error("Schema-27 AST child belongs to another or missing procedure phase.");
        }
    }

    const evaluationConditions = new Set(["always", "argument", "profile-begin", "call-target", "profile-end", "copyback",
        "condition", "true", "false", "result"]);
    const evaluationEdges = new Set();
    for (const edge of state.result.evaluationOrder) {
        const key = `${edge.parent}:${edge.child}`;
        if (edge.parent === edge.child || !state.flowNodePhases.has(edge.parent) ||
            !state.flowNodePhases.has(edge.child) || state.flowNodePhases.get(edge.parent) !== state.flowNodePhases.get(edge.child) ||
            !evaluationConditions.has(edge.condition) || evaluationEdges.has(key)) {
            throw new Error("Schema-27 evaluation edge has an invalid node, phase, condition, or duplicate.");
        }
        evaluationEdges.add(key);
    }

    for (const [phase, ordinals] of state.flowBlockOrdinals) {
        if (!state.flowPhases.has(phase)) throw new Error("Schema-27 control-flow blocks refer to a missing phase.");
        const ordered = [...ordinals].sort((left, right) => left - right);
        if (ordered.some((ordinal, index) => ordinal !== index)) {
            throw new Error("Schema-27 control-flow block ordinals have gaps.");
        }
    }
    const phasedRoots = new Set();
    for (const [id, node] of nodes) {
        if (node.edge === "root" && state.flowNodePhases.has(id)) phasedRoots.add(id);
    }
    for (const [blockId, block] of state.flowBlocks) {
        const nodeId = state.flowBlockNodes.get(blockId);
        const node = nodes.get(nodeId);
        if (block.module !== state.flowPhases.get(block.phase)?.module || !node || node.edge !== "root" ||
            state.nodeModules.get(nodeId) !== block.module || state.flowNodePhases.get(nodeId) !== block.phase) {
            throw new Error("Schema-27 control-flow block lacks one matching procedure root.");
        }
        phasedRoots.delete(nodeId);
    }
    if (phasedRoots.size || state.flowBlockNodes.size !== state.flowBlocks.size) {
        throw new Error("Schema-27 control-flow block membership is incomplete.");
    }
    for (const [phase, label, block] of state.result.controlFlowLabels.map((item) => [item.phase, item.label, item.block])) {
        const blockData = state.flowBlocks.get(block);
        const node = nodes.get(state.flowBlockNodes.get(block));
        if (!blockData || blockData.phase !== phase || !node || node.astClass !== 21 || node.symbol !== label ||
            state.symbolModules.get(label) !== blockData.module) {
            throw new Error("Schema-27 control-flow label does not match its phase block or AST label.");
        }
    }

    const labelTransferKinds = new Set(["label", "conditional-label", "case-label", "default-label", "subroutine-call"]);
    const unknownTransferKinds = new Set(["unknown-indirect", "unknown-assembly", "subroutine-return", "procedure-exit"]);
    for (const edge of state.result.controlFlowEdges) {
        const source = state.flowBlocks.get(edge.source);
        const target = edge.target ? state.flowBlocks.get(edge.target) : null;
        if (!source || source.phase !== edge.phase || source.module !== edge.module ||
            edge.label && state.symbolModules.get(edge.label) !== edge.module) {
            throw new Error("Schema-27 control-flow edge has a missing or foreign source or label.");
        }
        if (edge.kind === "fallthrough") {
            if (!target || target.phase !== edge.phase || target.module !== edge.module || edge.label || target.ordinal !== source.ordinal + 1) {
                throw new Error("Schema-27 fallthrough does not target the next block in its phase.");
            }
        } else if (labelTransferKinds.has(edge.kind)) {
            if (edge.target || !edge.label && edge.kind !== "subroutine-call") {
                throw new Error("Schema-27 label transfer has an incompatible target.");
            }
        } else if (unknownTransferKinds.has(edge.kind)) {
            if (edge.target || edge.label) throw new Error("Schema-27 unresolved transfer invents a target.");
        } else throw new Error("Unknown schema-27 control-flow transfer kind.");
    }
}

function validateSemanticMacroGraph(state, complete) {
    if (complete && state.macroInvocations.size !== state.macroResults.size) {
        throw new Error("Compiler semantic macro expansion graph is incomplete.");
    }
    for (const [id, definition] of state.macroDefinitions) {
        if (state.requireMacroConfiguration && (definition.context === 0 || definition.symbol === 0)) {
            throw new Error("Full semantic model macro definition lacks its selected identity or configuration.");
        }
        const tokens = state.macroTokens.get(id) || [];
        const parameters = tokens.filter((token) => token.kind === "parameter");
        const body = tokens.filter((token) => token.kind !== "parameter");
        if (parameters.map((token) => token.ordinal).some((ordinal, index) => ordinal !== index) || parameters.length !== definition.parameterCount ||
            body.map((token) => token.ordinal).some((ordinal, index) => ordinal !== index)) {
            throw new Error("Macro formal parameters or replacement tokens are incomplete or out of order.");
        }
        if (definition.kind.endsWith("callback") && body.length ||
            definition.kind === "text" && (body.length !== 1 || !["text", "wide-text"].includes(body[0].kind))) {
            throw new Error("Macro definition replacement does not match its definition kind.");
        }
        if (body.some((token) => ["parameter-reference", "stringify-reference"].includes(token.kind) && token.parameter >= definition.parameterCount)) {
            throw new Error("Macro replacement token refers to an absent formal parameter.");
        }
    }
    for (const [id, result] of state.macroResults) {
        const invocation = state.macroInvocations.get(id);
        if (state.requireMacroConfiguration && invocation.context === 0) {
            throw new Error("Full semantic model macro invocation lacks its configuration.");
        }
        const definition = state.macroDefinitions.get(invocation.definition);
        const args = state.macroArguments.get(id) || new Map();
        const segments = state.macroSegments.get(id) || [];
        const output = result.units;
        if (["not-invoked", "unsupported", "recursive"].includes(result.outcome) &&
            (output.length || args.size || segments.length || state.macroCallbacks.has(id))) {
            throw new Error("Unexpanded macro advertises substitutions or output.");
        }
        if (["expanded", "failed", "recovered"].includes(result.outcome) &&
            (args.size !== definition.parameterCount || Array.from({ length: definition.parameterCount }, (_, ordinal) => ordinal).some((ordinal) => !args.has(ordinal)))) {
            throw new Error("Macro argument mapping does not match its formal parameters.");
        }
        if (segments.some((segment, ordinal) => segment.ordinal !== ordinal)) {
            throw new Error("Macro substitution sequence has gaps or duplicates.");
        }
        let outputOffset = 0;
        const body = (state.macroTokens.get(invocation.definition) || []).filter((token) => token.kind !== "parameter");
        for (const segment of segments) {
            const { token, parameter, kind, offset, units } = segment;
            if (offset !== outputOffset || offset + units > output.length) {
                throw new Error("Macro substitution offsets do not partition its output.");
            }
            outputOffset += units;
            let expected = null;
            if (kind === "parameter" || kind === "stringify") {
                const argument = args.get(parameter);
                if (!argument || token < 0 || token >= body.length) throw new Error("Macro substitution lacks its formal or definition token.");
                const expectedTokenKind = kind === "parameter" ? "parameter-reference" : "stringify-reference";
                if (body[token].kind !== expectedTokenKind || body[token].parameter !== parameter) {
                    throw new Error("Macro substitution contradicts its definition token.");
                }
                expected = kind === "parameter" ? argument.units : stringifyMacroUnits(argument.units);
            } else if (parameter !== -1) {
                throw new Error("Non-parameter substitution advertises a formal.");
            }
            if (kind === "restored-delimiter" && (token !== -1 || units !== 1)) throw new Error("Invalid restored caller delimiter.");
            if (kind === "definition-text" && (token !== -1 || definition.kind !== "text")) throw new Error("Text replacement advertises an invalid definition token.");
            if (kind === "callback" && (token !== -1 || !state.macroCallbacks.has(id))) throw new Error("Macro substitution fabricates callback output.");
            if (kind === "text" && (token < 0 || token >= body.length || !["text", "wide-text"].includes(body[token].kind))) {
                throw new Error("Macro text substitution lacks its definition token.");
            }
            if (expected !== null) {
                const actual = Buffer.isBuffer(output) ? output.subarray(offset, offset + units) : output.slice(offset, offset + units);
                if (!sameMacroUnits(actual, expected)) throw new Error("Macro substitution output contradicts its actual argument.");
            }
        }
        if (["expanded", "failed", "recovered"].includes(result.outcome) && outputOffset !== output.length) {
            throw new Error("Macro output is not completely covered by substitutions.");
        }
        if (state.macroCallbacks.has(id) && !definition.kind.endsWith("callback")) {
            throw new Error("Ordinary macro advertises a callback invocation.");
        }
        if (complete && ["failed", "recursive", "unsupported", "recovered"].includes(result.outcome)) {
            throw new Error("Macro failure was claimed complete.");
        }
    }
}

function decodeCompilerSemanticModel(text) {
    if (typeof text !== "string") throw new TypeError("Compiler semantic model must be text.");
    if (Buffer.byteLength(text, "utf8") > MAX_SEMANTIC_MODEL_BYTES) throw new Error("Compiler semantic model exceeded 64 MiB.");
    if (text.includes("\0")) throw new Error("Compiler semantic model contains a NUL character.");

    const lines = text.split(/\r?\n/);
    while (lines.length && lines.at(-1) === "") lines.pop();
    if (lines.length < 2) throw new Error("Compiler semantic model is incomplete.");

    function fields(line, expected, label) {
        const value = line.split("\t");
        if (value.length !== expected) throw new Error(`Invalid compiler semantic ${label} record shape.`);
        return value;
    }

    function number(value, label, minimum = Number.MIN_SAFE_INTEGER) {
        if (!/^-?\d+$/.test(value)) throw new Error(`Invalid compiler semantic ${label}.`);
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`Invalid compiler semantic ${label}.`);
        return result;
    }

    let schemaVersion = 0;
    function string(value, label) {
        return decodeSemanticString(value, label, schemaVersion);
    }

    const header = fields(lines[0], 3, "header");
    if (header[0] !== "FBCSEM" || !["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "20", "21", "22", "23", "25", "27"].includes(header[1]) || !header[2]) throw new Error("Unsupported compiler semantic model header or schema version.");
    schemaVersion = Number(header[1]);
    const detailShapes = SEMANTIC_DETAIL_SHAPES_BY_SCHEMA.get(schemaVersion);

    const result = {
        schemaVersion,
        compilerVersion: header[2],
        modules: [],
        dependencies: [],
        symbols: [],
        bindings: [],
        implicitCalls: [],
        procedures: [],
        variableTypes: [],
        nodes: [],
        expressions: [],
        details: [],
        relationships: [],
        properties: [],
        constantValues: [],
        operations: [],
        targetContexts: [],
        primitiveTypes: [],
        configurationContexts: [],
        configurationOptions: [],
        configurationUses: [],
        sourceFiles: [],
        sourceContexts: [],
        sourceClosures: [],
        includeOutcomes: [],
        sourceHeaderPolicies: [],
        sourceHeaderLibraries: [],
        namespaceImportRecipients: [],
        namespaceDeclarations: [],
        sourceRemaps: [],
        physicalLocations: [],
        declarations: [],
        comments: [],
        arrayBounds: [],
        fieldLayouts: [],
        symbolVisibilities: [],
        symbolStorageClasses: [],
        abstractTypeCounts: [],
        typeBases: [],
        typeSymbols: [],
        procedureCallConventions: [],
        procedureParameterModes: [],
        statements: [],
        statementEndings: [],
        constructs: [],
        constructEndings: [],
        statementOwners: [],
        capabilities: [],
        accessRoles: [],
        statementOperations: [],
        normalizedTypes: [],
        expressionOperands: [],
        assignmentExpressionSummaries: [],
        assignmentExpressionSummariesComplete: true,
        flowPhases: [],
        nodePhases: [],
        evaluationOrder: [],
        controlFlowBlocks: [],
        controlFlowNodes: [],
        controlFlowEdges: [],
        controlFlowLabels: [],
        semanticDiagnostics: [],
        sourceOrigins: [],
        conditionalBranches: [],
        conditionalDecisions: [],
        conditionalClosures: [],
        definedNameProbes: [],
        skippedRegions: [],
        macroDefinitions: [],
        macroTokens: [],
        macroInvocations: [],
        macroArguments: [],
        macroSegments: [],
        macroCallbacks: [],
        macroResults: [],
        macroLifecycles: [],
        macroOrigins: [],
        counts: null
    };
    const symbolIds = new Set();
    const nodeIds = new Set();
    const expressionIds = new Set();
    const modulePaths = new Set();
    const dependencyPaths = new Set();
    const schema20State = createSchema20State(result, number);
    schema20State.schemaVersion = schemaVersion;
    schema20State.symbolIds = symbolIds;
    schema20State.nodeIds = nodeIds;
    schema20State.expressionIds = expressionIds;
    let footer = null;
    let recordCount = 0;
    let detailRecordCount = 0;
    let currentModulePath = "";

    for (let index = 1; index < lines.length; index++) {
        const line = lines[index];
        if (!line) throw new Error("Compiler semantic model contains an empty record.");
        if (footer) throw new Error("Compiler semantic records follow the terminal marker.");
        const tag = line.slice(0, line.indexOf("\t"));
        if (tag === "END") {
            if (index !== lines.length - 1) throw new Error("Compiler semantic records follow the terminal marker.");
            const row = fields(line, schemaVersion >= 20 ? 13 : schemaVersion === 2 ? 7 : schemaVersion >= 10 ? 12 : schemaVersion >= 7 ? 11 : schemaVersion >= 6 ? 10 : 8, "footer");
            if (row[1] !== header[1]) throw new Error("Compiler semantic footer schema does not match its header.");
            footer = {
                moduleCount: number(row[2], "module count", 0),
                procedureCount: number(row[3], "procedure count", 0),
                symbolCount: number(row[4], "symbol count", 0),
                typeFactCount: number(row[5], "type-fact count", 0),
                nodeCount: number(row[6], "AST node count", 0),
                expressionCount: schemaVersion >= 3 ? number(row[7], "expression count", 0) : 0,
                bindingCount: schemaVersion >= 7 ? number(row[8], "binding count", 0) : 0,
                implicitCallCount: schemaVersion >= 10 ? number(row[9], "implicit-call count", 0) : 0
            };
            if (schemaVersion >= 6) {
                const dependencyOffset = schemaVersion >= 10 ? 10 : schemaVersion >= 7 ? 9 : 8;
                footer.dependencyCount = number(row[dependencyOffset], "dependency count", 0);
                const complete = number(row[dependencyOffset + 1], "dependency completeness flag", 0);
                if (complete > 1) throw new Error("Invalid compiler semantic dependency completeness flag.");
                footer.dependenciesComplete = complete === 1;
            }
            if (schemaVersion >= 20) footer.detailCount = number(row[12], "detail record count", 0);
            continue;
        }

        if (++recordCount > MAX_SEMANTIC_MODEL_RECORDS) throw new Error("Compiler semantic model exceeded 6,100,000 records.");
        if (tag === "M") {
            if (schemaVersion >= 25 && (schema20State.statementStack.length || schema20State.constructStack.length)) {
                throw new Error("Schema-25 source constructs remain open at a module boundary.");
            }
            const row = fields(line, 2, "module");
            const filePath = string(row[1], "module path");
            if (!filePath || modulePaths.has(filePath)) throw new Error("Compiler semantic model has an empty or duplicate module path.");
            modulePaths.add(filePath);
            currentModulePath = filePath;
            schema20State.currentModulePath = filePath;
            schema20State.moduleCount = result.modules.length + 1;
            result.modules.push(filePath);
        } else if (tag === "D") {
            if (schemaVersion < 6) throw new Error("Dependency records require compiler semantic schema version 6 or newer.");
            const row = fields(line, 2, "dependency");
            const filePath = string(row[1], "dependency path");
            if (!filePath || dependencyPaths.has(filePath)) throw new Error("Compiler semantic model has an empty or duplicate dependency path.");
            dependencyPaths.add(filePath);
            result.dependencies.push(filePath);
        } else if (tag === "S") {
            const row = fields(line, 12, "symbol");
            const id = number(row[1], "symbol identity", 1);
            if (symbolIds.has(id)) throw new Error("Compiler semantic model has duplicate symbol identities.");
            symbolIds.add(id);
            schema20State.symbolModules.set(id, schema20State.moduleCount);
            const symbolClass = number(row[3], "symbol class", 0);
            const parent = number(row[11], "symbol parent", 0);
            if (symbolClass === 8) schema20State.namespaceSymbolParents.set(id, parent);
            result.symbols.push({
                id, name: string(row[2], "symbol name"),
                symbolClass,
                dtype: number(row[4], "symbol data type"),
                subtype: number(row[5], "symbol subtype", 0),
                scope: number(row[6], "symbol scope"),
                attributes: number(row[7], "symbol attributes"),
                parameterAttributes: number(row[8], "symbol parameter attributes"),
                length: number(row[9], "symbol length"),
                offset: number(row[10], "symbol offset"),
                parent
            });
        } else if (tag === "P") {
            const row = fields(line, 9, "procedure");
            result.procedures.push({
                symbol: number(row[1], "procedure symbol", 1),
                name: string(row[2], "procedure name"),
                symbolClass: number(row[3], "procedure class", 0),
                dtype: number(row[4], "procedure data type"),
                subtype: number(row[5], "procedure subtype", 0),
                startLine: number(row[6], "procedure start line"),
                endLine: number(row[7], "procedure end line"),
                filePath: string(row[8], "procedure path")
            });
        } else if (tag === "V") {
            const row = fields(line, 5, "variable type");
            const typeKind = string(row[4], "variable type kind");
            if (!["pointer", "numeric", "dynamic-string", "fixed-string", "aggregate", "procedure", "other"].includes(typeKind)) {
                throw new Error("Unknown compiler semantic variable type kind.");
            }
            result.variableTypes.push({
                symbol: number(row[1], "variable symbol", 1),
                procedure: string(row[2], "variable procedure name"),
                name: string(row[3], "variable name"),
                typeKind
            });
        } else if (tag === "N") {
            const row = fields(line, schemaVersion >= 8 ? 13 : 11, "AST node");
            const id = number(row[1], "AST node identity", 1);
            if (nodeIds.has(id)) throw new Error("Compiler semantic model has duplicate AST node identities.");
            nodeIds.add(id);
            schema20State.nodeModules.set(id, schema20State.moduleCount);
            const edge = row[3];
            const allowedEdges = schemaVersion >= 20
                ? ["root", "left", "right", "copyback", "profile-begin", "profile-end"]
                : ["root", "left", "right"];
            if (!allowedEdges.includes(edge)) throw new Error("Unknown compiler semantic AST edge.");
            const node = {
                id,
                parent: number(row[2], "AST parent", 0),
                edge,
                astClass: number(row[4], "AST class", 0),
                operator: number(row[5], "AST operator"),
                dtype: number(row[schemaVersion >= 8 ? 8 : 6], "AST data type"),
                symbol: number(row[schemaVersion >= 8 ? 9 : 7], "AST symbol", 0),
                subtype: number(row[schemaVersion >= 8 ? 10 : 8], "AST subtype", 0),
                sourceLine: number(row[schemaVersion >= 8 ? 11 : 9], "AST source line"),
                filePath: string(row[schemaVersion >= 8 ? 12 : 10], "AST source path")
            };
            if (schemaVersion >= 8) Object.assign(node, decodeOperatorConcept(string(row[6], "AST operator code"), string(row[7], "AST operator kind")));
            result.nodes.push(node);
        } else if (tag === "E") {
            if (schemaVersion < 3) throw new Error("Expression records require compiler semantic schema version 3 or newer.");
            const row = fields(line, schemaVersion >= 8 ? 16 : schemaVersion >= 4 ? 14 : 13, "expression");
            const id = number(row[1], "expression identity", 1);
            if (expressionIds.has(id)) throw new Error("Compiler semantic model has duplicate expression identities.");
            expressionIds.add(id);
            schema20State.expressionModules.set(id, schema20State.moduleCount);
            const physical = number(row[2], "expression physical-range flag", 0);
            if (physical > 1) throw new Error("Unknown compiler semantic expression physical-range flag.");
            const expression = {
                id,
                physical: physical === 1,
                filePath: string(row[3], "expression source path"),
                startLine: number(row[4], "expression start line", 1),
                startColumn: number(row[5], "expression start column", 0),
                endLine: number(row[6], "expression end line", 1),
                endColumn: number(row[7], "expression end column", 0),
                astClass: number(row[8], "expression AST class", 0),
                operator: number(row[9], "expression operator"),
                dtype: number(row[schemaVersion >= 8 ? 12 : 10], "expression data type"),
                symbol: number(row[schemaVersion >= 8 ? 13 : 11], "expression symbol", 0),
                subtype: number(row[schemaVersion >= 8 ? 14 : 12], "expression subtype", 0)
            };
            if (schemaVersion >= 8) Object.assign(expression, decodeOperatorConcept(string(row[10], "expression operator code"), string(row[11], "expression operator kind")));
            if (schemaVersion >= 4) expression.typeName = string(row[schemaVersion >= 8 ? 15 : 13], "expression type spelling");
            if (schemaVersion >= 27 && (expression.operatorCode.startsWith("va-") || !expression.typeName)) {
                schema20State.sourceOperationExpressions.set(id, { ...expression, module: schema20State.moduleCount });
            }
            if (expression.endLine < expression.startLine ||
                expression.endLine === expression.startLine && expression.endColumn <= expression.startColumn) {
                throw new Error("Compiler semantic expression has a reversed or empty source range.");
            }
            result.expressions.push(expression);
        } else if (tag === "B") {
            if (schemaVersion < 7) throw new Error("Binding records require compiler semantic schema version 7 or newer.");
            const row = fields(line, 9, "binding");
            const role = row[2];
            if (role !== "declaration" && role !== "reference") throw new Error("Unknown compiler semantic binding role.");
            const physical = number(row[3], "binding physical-range flag", 0);
            if (physical > 1) throw new Error("Unknown compiler semantic binding physical-range flag.");
            const binding = {
                symbol: number(row[1], "binding symbol", 1),
                role,
                physical: physical === 1,
                filePath: string(row[4], "binding source path"),
                startLine: number(row[5], "binding start line", 1),
                startColumn: number(row[6], "binding start column", 0),
                endLine: number(row[7], "binding end line", 1),
                endColumn: number(row[8], "binding end column", 0)
            };
            if (!binding.filePath || binding.endLine < binding.startLine ||
                binding.endLine === binding.startLine && binding.endColumn <= binding.startColumn) {
                throw new Error("Compiler semantic binding has an invalid source range.");
            }
            result.bindings.push(binding);
            if (schemaVersion >= 20) schema20State.bindingIds.add(result.bindings.length);
        } else if (tag === "I") {
            if (schemaVersion < 10) throw new Error("Implicit-call records require compiler semantic schema version 10 or newer.");
            const row = fields(line, schemaVersion >= 11 ? 12 : 11, "implicit call");
            const kind = row[4];
            if (!IMPLICIT_CALL_KINDS.has(kind) ||
                (kind === "destructor-call" && schemaVersion < 12) ||
                (kind === "argument-constructor" && schemaVersion < 13) ||
                (kind === "temporary-destructor" && schemaVersion < 14) ||
                (kind === "scope-exit-destructor" && schemaVersion < 15) ||
                (kind === "delete-destructor" && schemaVersion < 16) ||
                (kind === "return-constructor" && schemaVersion < 17)) throw new Error("Unknown compiler semantic implicit-call kind.");
            const physical = number(row[5], "implicit-call physical-range flag", 0);
            const implicitCall = {
                owner: number(row[1], "implicit-call owner symbol", 1),
                target: number(row[2], "implicit-call target symbol", 1),
                type: number(row[3], "implicit-call owner type", 1),
                kind,
                physical: physical === 1,
                filePath: string(row[6], "implicit-call source path"),
                startLine: number(row[7], "implicit-call start line", 1),
                startColumn: number(row[8], "implicit-call start column", 0),
                endLine: number(row[9], "implicit-call end line", 1),
                endColumn: number(row[10], "implicit-call end column", 0),
                targetSignature: schemaVersion >= 11 ? string(row[11], "implicit-call target signature") : ""
            };
            if (physical > 1 || !implicitCall.filePath || implicitCall.endLine < implicitCall.startLine ||
                implicitCall.endLine === implicitCall.startLine && implicitCall.endColumn <= implicitCall.startColumn) {
                throw new Error("Compiler semantic implicit call has an invalid source range.");
            }
            if (schemaVersion >= 11 && (!implicitCall.targetSignature || Buffer.byteLength(implicitCall.targetSignature, "utf8") > MAX_IMPLICIT_CALL_SIGNATURE_BYTES)) {
                throw new Error("Compiler semantic implicit call has an invalid target signature.");
            }
            if (schemaVersion >= 18) {
                const subtypeIds = stableCallSignatureSubtypeIds(implicitCall.targetSignature);
                if (!subtypeIds || subtypeIds.some((id) => !symbolIds.has(id))) {
                    throw new Error("Compiler semantic implicit call has an invalid stable target signature.");
                }
            }
            result.implicitCalls.push(implicitCall);
        } else if (schemaVersion >= 20 && Object.hasOwn(detailShapes, tag)) {
            const row = decodeSemanticDetailFields(fields(line, detailShapes[tag], `schema-${schemaVersion} ${tag} detail`), tag, schemaVersion, string);
            if (!currentModulePath) throw new Error(`Schema-${schemaVersion} ${tag} detail is outside a module.`);
            validateSemanticDetail(tag, row, schema20State);
            result.details.push({ tag, fields: row.slice(1) });
            detailRecordCount++;
        } else {
            throw new Error(`Unknown compiler semantic record type: ${tag || "<empty>"}.`);
        }
    }

    if (!footer) throw new Error("Compiler semantic model is missing its completeness marker.");
    const actual = {
        moduleCount: result.modules.length,
        procedureCount: result.procedures.length,
        symbolCount: result.symbols.length,
        typeFactCount: result.variableTypes.length,
        nodeCount: result.nodes.length,
        expressionCount: result.expressions.length
    };
    if (schemaVersion >= 7) actual.bindingCount = result.bindings.length;
    if (schemaVersion >= 10) actual.implicitCallCount = result.implicitCalls.length;
    if (schemaVersion >= 6) actual.dependencyCount = result.dependencies.length;
    if (schemaVersion >= 20) actual.detailCount = detailRecordCount;
    if (Object.keys(actual).some((key) => actual[key] !== footer[key])) throw new Error("Compiler semantic footer totals do not match the records.");
    result.dependenciesComplete = schemaVersion >= 6 && footer.dependenciesComplete === true;

    if (schemaVersion >= 20) {
        if (schema20State.sourceContextIds.size !== schema20State.sourceClosureIds.size ||
            [...schema20State.sourceContextIds].some((id) => !schema20State.sourceClosureIds.has(id))) {
            throw new Error("Schema-20 source contexts are not completely closed.");
        }
        if (result.sourceClosures.some((closure) => closure.status === "changed-or-unreadable")) {
            throw new Error("Schema-20 semantic model contains a changed or unreadable source.");
        }
        if (schema20State.targetModulePaths.size && schema20State.targetModulePaths.size !== result.modules.length) {
            throw new Error("Schema-20 target contexts do not cover every module.");
        }
        const available = {
            symbol: symbolIds,
            node: nodeIds,
            expression: expressionIds,
            declaration: schema20State.declarationIds,
            binding: schema20State.bindingIds
        };
        for (const reference of schema20State.references) {
            if (!available[reference.domain]?.has(reference.identity)) {
                throw new Error(`Schema-20 ${reference.label} refers to a missing ${reference.domain}.`);
            }
        }
    }
    if (schemaVersion >= 21) validateConditionalGraph(schema20State, true);
    if (schemaVersion >= 22) {
        schema20State.requireMacroConfiguration = footer.symbolCount > 0 && footer.nodeCount > 0;
        schema20State.requireMacroSymbol = schema20State.requireMacroConfiguration;
        validateSemanticMacroGraph(schema20State, true);
    }
    if (schemaVersion >= 25) validateSemanticConstructGraph(schema20State, true);
    if (schemaVersion >= 27) {
        validateSemanticPolicyInputs(schema20State, true);
        validateSemanticNormalizedTypes(schema20State);
        validateSemanticExpressionOperands(schema20State);
        validateSemanticParsedExpressionCoverage(schema20State, true);
        validateSemanticIifInputs(schema20State, true);
        validateSemanticNumericAssignmentTargets(schema20State);
        validateSemanticSourceVaListOperations(schema20State);
        validateSemanticComments(schema20State, true);
        validateSemanticFlowGraph(schema20State, true);
    }

    const symbols = new Map(result.symbols.map((symbol) => [symbol.id, symbol]));
    const procedures = new Set(result.procedures.map((procedure) => procedure.symbol));
    const nodes = new Map(result.nodes.map((node) => [node.id, node]));
    for (const implicitCall of result.implicitCalls) {
        if (!symbols.has(implicitCall.owner) || !symbols.has(implicitCall.target) || !symbols.has(implicitCall.type)) throw new Error("Compiler semantic implicit call refers to a missing symbol.");
    }
    for (const symbol of result.symbols) {
        if (symbol.subtype && !symbols.has(symbol.subtype) || symbol.parent && !symbols.has(symbol.parent)) throw new Error("Compiler semantic symbol refers to a missing identity.");
    }
    for (const procedure of result.procedures) {
        if (!symbols.has(procedure.symbol) || procedure.subtype && !symbols.has(procedure.subtype)) throw new Error("Compiler semantic procedure refers to a missing symbol.");
        if (procedure.endLine >= 0 && procedure.startLine > procedure.endLine) throw new Error("Compiler semantic procedure has a reversed source range.");
    }
    for (const fact of result.variableTypes) if (!symbols.has(fact.symbol)) throw new Error("Compiler semantic variable type refers to a missing symbol.");
    for (const node of result.nodes) {
        if (node.symbol && !symbols.has(node.symbol) || node.subtype && !symbols.has(node.subtype)) throw new Error("Compiler semantic AST node refers to a missing symbol.");
        const rootParentMissing = node.edge === "root" && (schemaVersion >= 20 ? !symbols.has(node.parent) : !procedures.has(node.parent));
        const childParentMissing = node.edge !== "root" && !nodes.has(node.parent);
        if (rootParentMissing || childParentMissing) throw new Error("Compiler semantic AST node has a missing parent.");
    }
    for (const expression of result.expressions) {
        if (expression.symbol && !symbols.has(expression.symbol) || expression.subtype && !symbols.has(expression.subtype)) {
            throw new Error("Compiler semantic expression refers to a missing symbol.");
        }
    }
    for (const binding of result.bindings) {
        if (!symbols.has(binding.symbol)) throw new Error("Compiler semantic binding refers to a missing symbol.");
    }
    result.counts = footer;
    result.symbolById = symbols;
    result.nodeById = nodes;
    return result;
}

/*
    The editor only needs selected source expression ranges, not the semantic
    sidecar's full symbol and AST graph. This bounded reader validates record
    framing and footer totals while retaining only caller-selected physical E
    records, keeping large compiler snapshots out of the worker heap.
*/
function decodeCompilerSemanticExpressions(text, includeExpression = () => true, options = {}) {
    if (typeof text !== "string") throw new TypeError("Compiler semantic model must be text.");
    if (Buffer.byteLength(text, "utf8") > MAX_SEMANTIC_MODEL_BYTES) throw new Error("Compiler semantic model exceeded 64 MiB.");
    if (text.includes("\0")) throw new Error("Compiler semantic model contains a NUL character.");

    function fields(line, expected, label) {
        const value = line.split("\t");
        if (value.length !== expected) throw new Error(`Invalid compiler semantic ${label} record shape.`);
        return value;
    }
    function number(value, label, minimum = Number.MIN_SAFE_INTEGER) {
        if (!/^-?\d+$/.test(value)) throw new Error(`Invalid compiler semantic ${label}.`);
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`Invalid compiler semantic ${label}.`);
        return result;
    }
    let schemaVersion = 0;
    function string(value, label) {
        return decodeSemanticString(value, label, schemaVersion);
    }
    function nextLine(offset) {
        if (offset >= text.length) return null;
        const end = text.indexOf("\n", offset);
        const next = end < 0 ? text.length : end;
        return { value: text.slice(offset, next).replace(/\r$/, ""), next: end < 0 ? text.length : end + 1 };
    }

    const first = nextLine(0);
    const header = fields(first?.value || "", 3, "header");
    if (header[0] !== "FBCSEM" || !["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "20", "21", "22", "23", "25", "27"].includes(header[1]) || !header[2]) throw new Error("Unsupported compiler semantic model header or schema version.");
    schemaVersion = Number(header[1]);
    const detailShapes = SEMANTIC_DETAIL_SHAPES_BY_SCHEMA.get(schemaVersion);
    const provenanceTags = SEMANTIC_PROVENANCE_TAGS_BY_SCHEMA.get(schemaVersion);
    const counts = { moduleCount: 0, procedureCount: 0, symbolCount: 0, typeFactCount: 0, nodeCount: 0, expressionCount: 0 };
    if (schemaVersion >= 7) counts.bindingCount = 0;
    if (schemaVersion >= 10) counts.implicitCallCount = 0;
    const expressions = [];
    const modules = [];
    const modulePaths = new Set();
    const dependencies = [];
    const dependencyPaths = new Set();
    const semanticSymbols = options.includeBindings === true ? new Map() : null;
    const bindingSymbolIds = options.includeBindings === true ? new Set() : null;
    const bindings = [];
    const implicitCallSymbolIds = options.includeBindings === true ? new Set() : null;
    const implicitCalls = [];
    const sidecarDetails = {
        constantValues: [],
        targetContexts: [],
        primitiveTypes: [],
        procedures: [],
        configurationContexts: [],
        configurationOptions: [],
        configurationUses: [],
        sourceFiles: [],
        sourceContexts: [],
        sourceClosures: [],
        includeOutcomes: [],
        sourceHeaderPolicies: [],
        sourceHeaderLibraries: [],
        namespaceImportRecipients: [],
        namespaceDeclarations: [],
        sourceRemaps: [],
        physicalLocations: [],
        declarations: [],
        comments: [],
        arrayBounds: [],
        fieldLayouts: [],
        symbolVisibilities: [],
        symbolStorageClasses: [],
        abstractTypeCounts: [],
        typeBases: [],
        typeSymbols: [],
        symbolTypes: [],
        procedureCallConventions: [],
        procedureParameterModes: [],
        statements: [],
        statementEndings: [],
        constructs: [],
        constructEndings: [],
        statementOwners: [],
        capabilities: [],
        accessRoles: [],
        statementOperations: [],
        normalizedTypes: [],
        expressionOperands: [],
        assignmentExpressionSummaries: [],
        assignmentExpressionSummariesComplete: true,
        flowPhases: [],
        nodePhases: [],
        evaluationOrder: [],
        controlFlowBlocks: [],
        controlFlowNodes: [],
        controlFlowEdges: [],
        controlFlowLabels: [],
        semanticDiagnostics: [],
        sourceOrigins: [],
        nodes: [],
        conditionalBranches: [],
        conditionalDecisions: [],
        conditionalClosures: [],
        definedNameProbes: [],
        skippedRegions: [],
        macroDefinitions: [],
        macroTokens: [],
        macroInvocations: [],
        macroArguments: [],
        macroSegments: [],
        macroCallbacks: [],
        macroResults: [],
        macroLifecycles: [],
        macroOrigins: [],
        relationships: [],
        properties: [],
        operations: []
    };
    const schema20State = createSchema20State(sidecarDetails, number);
    schema20State.schemaVersion = schemaVersion;
    schema20State.symbolIds = bindingSymbolIds || new Set();
    schema20State.nodeIds = new Set();
    schema20State.expressionIds = new Set();
    schema20State.includeBindings = options.includeBindings === true;
    schema20State.skipUnavailableReferences = !schema20State.includeBindings;
    schema20State.requireMacroConfiguration = false;
    schema20State.requireMacroSymbol = false;
    let offset = first.next;
    let recordCount = 0;
    let detailRecordCount = 0;
    let lastExpressionId = 0;
    let footer = null;
    let currentModulePath = "";
    let currentModuleExpressionCount = 0;
    let currentModuleExpressions = [];
    let currentModuleRecovered = false;
    let recoveryModuleCount = 0;
    while (offset < text.length) {
        const line = nextLine(offset);
        offset = line.next;
        if (!line.value) {
            if (offset === text.length) break;
            throw new Error("Compiler semantic model contains an empty record.");
        }
        if (footer) throw new Error("Compiler semantic records follow the terminal marker.");
        const tag = line.value.slice(0, line.value.indexOf("\t"));
        if (tag === "END") {
            if (recoveryModuleCount) throw new Error("A recovered compiler semantic module cannot have a complete footer.");
            if (offset < text.length && text.slice(offset).trim()) throw new Error("Compiler semantic records follow the terminal marker.");
            const row = fields(line.value, schemaVersion >= 20 ? 13 : schemaVersion === 2 ? 7 : schemaVersion >= 10 ? 12 : schemaVersion >= 7 ? 11 : schemaVersion >= 6 ? 10 : 8, "footer");
            if (row[1] !== header[1]) throw new Error("Compiler semantic footer schema does not match its header.");
            footer = {
                moduleCount: number(row[2], "module count", 0),
                procedureCount: number(row[3], "procedure count", 0),
                symbolCount: number(row[4], "symbol count", 0),
                typeFactCount: number(row[5], "type-fact count", 0),
                nodeCount: number(row[6], "AST node count", 0),
                expressionCount: schemaVersion >= 3 ? number(row[7], "expression count", 0) : 0,
                bindingCount: schemaVersion >= 7 ? number(row[8], "binding count", 0) : 0,
                implicitCallCount: schemaVersion >= 10 ? number(row[9], "implicit-call count", 0) : 0
            };
            if (schemaVersion >= 6) {
                const dependencyOffset = schemaVersion >= 10 ? 10 : schemaVersion >= 7 ? 9 : 8;
                footer.dependencyCount = number(row[dependencyOffset], "dependency count", 0);
                const complete = number(row[dependencyOffset + 1], "dependency completeness flag", 0);
                if (complete > 1) throw new Error("Invalid compiler semantic dependency completeness flag.");
                footer.dependenciesComplete = complete === 1;
            }
            if (schemaVersion >= 20) footer.detailCount = number(row[12], "detail record count", 0);
            break;
        }
        if (tag === "RECOVERY") {
            if (options.allowRecovery !== true || schemaVersion < 5) throw new Error("Unsupported compiler semantic recovery footer.");
            if (offset < text.length && text.slice(offset).trim()) throw new Error("Compiler semantic records follow the recovery marker.");
            const row = fields(line.value, schemaVersion >= 7 ? 8 : schemaVersion >= 6 ? 7 : 5, "recovery footer");
            if (row[1] !== header[1] || !currentModuleRecovered || !recoveryModuleCount) {
                throw new Error("Compiler semantic recovery footer has no recovered module.");
            }
            footer = {
                moduleCount: number(row[2], "module count", 0),
                expressionCount: number(row[3], "expression count", 0),
                recoveryModuleCount: number(row[4], "recovery module count", 1),
                recovery: true
            };
            if (schemaVersion >= 7) footer.bindingCount = number(row[5], "binding count", 0);
            if (schemaVersion >= 10) footer.implicitCallCount = 0;
            if (schemaVersion >= 6) {
                const dependencyOffset = schemaVersion >= 7 ? 6 : 5;
                footer.dependencyCount = number(row[dependencyOffset], "dependency count", 0);
                const complete = number(row[dependencyOffset + 1], "dependency completeness flag", 0);
                if (complete > 1) throw new Error("Invalid compiler semantic dependency completeness flag.");
                footer.dependenciesComplete = complete === 1;
            }
            if (footer.moduleCount !== counts.moduleCount ||
                footer.expressionCount !== counts.expressionCount ||
                schemaVersion >= 7 && footer.bindingCount !== counts.bindingCount ||
                schemaVersion >= 10 && footer.implicitCallCount !== counts.implicitCallCount ||
                footer.recoveryModuleCount !== recoveryModuleCount) {
                throw new Error("Compiler semantic recovery footer totals do not match the records.");
            }
            break;
        }
        if (++recordCount > MAX_SEMANTIC_MODEL_RECORDS) throw new Error("Compiler semantic model exceeded 6,100,000 records.");
        if (schemaVersion >= 20 && Object.hasOwn(detailShapes, tag)) {
            if (!schema20State.includeBindings && !provenanceTags.has(tag)) {
                throw new Error(`Full-model ${tag} detail appeared in an expression-only sidecar.`);
            }
            const row = decodeSemanticDetailFields(fields(line.value, detailShapes[tag], `schema-${schemaVersion} ${tag} detail`), tag, schemaVersion, string);
            if (!currentModulePath) throw new Error(`Schema-${schemaVersion} ${tag} detail is outside a module.`);
            validateSemanticDetail(tag, row, schema20State);
            detailRecordCount++;
            continue;
        }
        if (schemaVersion >= 20 && !schema20State.includeBindings && !["M", "D", "E", "R"].includes(tag)) {
            throw new Error(`Full-model ${tag} record appeared in an expression-only sidecar.`);
        }
        if (tag === "M") {
            if (schemaVersion >= 25 && (schema20State.statementStack.length || schema20State.constructStack.length)) {
                throw new Error("Schema-25 source constructs remain open at a module boundary.");
            }
            const row = fields(line.value, 2, "module");
            currentModulePath = string(row[1], "module path");
            if (!currentModulePath || modulePaths.has(currentModulePath)) throw new Error("Compiler semantic model has an empty or duplicate module path.");
            modulePaths.add(currentModulePath);
            modules.push(currentModulePath);
            schema20State.currentModulePath = currentModulePath;
            schema20State.moduleCount = modules.length;
            currentModuleExpressionCount = 0;
            currentModuleExpressions = [];
            currentModuleRecovered = false;
            counts.moduleCount++;
        } else if (tag === "D") {
            if (schemaVersion < 6) throw new Error("Dependency records require compiler semantic schema version 6 or newer.");
            const row = fields(line.value, 2, "dependency");
            const filePath = string(row[1], "dependency path");
            if (!filePath || dependencyPaths.has(filePath)) throw new Error("Compiler semantic model has an empty or duplicate dependency path.");
            dependencyPaths.add(filePath);
            dependencies.push(filePath);
        } else if (tag === "S") {
            const row = fields(line.value, 12, "symbol");
            if (semanticSymbols) {
                const id = number(row[1], "symbol identity", 1);
                const symbolClass = number(row[3], "symbol class", 0);
                if (semanticSymbols.has(id)) throw new Error("Compiler semantic model has duplicate symbol identities.");
                semanticSymbols.set(id, string(row[2], "symbol name"));
                schema20State.symbolIds.add(id);
                schema20State.symbolModules.set(id, schema20State.moduleCount);
                if (sidecarDetails.symbolTypes.length >= MAX_EDITOR_SEMANTIC_POLICY_FACTS) {
                    throw new Error("Compiler semantic symbol type facts exceeded their bound.");
                }
                sidecarDetails.symbolTypes.push({
                    symbol: id,
                    symbolClass,
                    dtype: number(row[4], "symbol data type"),
                    subtype: number(row[5], "symbol subtype", 0)
                });
                if (symbolClass === 8) {
                    schema20State.namespaceSymbolParents.set(id, number(row[11], "symbol parent", 0));
                }
            }
            counts.symbolCount++;
        }
        else if (tag === "P") {
            const row = fields(line.value, 9, "procedure");
            counts.procedureCount++;
            if (semanticSymbols) sidecarDetails.procedures.push({
                symbol: number(row[1], "procedure symbol", 1),
                name: string(row[2], "procedure name"),
                symbolClass: number(row[3], "procedure class", 0),
                dtype: number(row[4], "procedure data type"),
                subtype: number(row[5], "procedure subtype", 0),
                startLine: number(row[6], "procedure start line"),
                endLine: number(row[7], "procedure end line"),
                filePath: string(row[8], "procedure path")
            });
        }
        else if (tag === "V") { fields(line.value, 5, "variable type"); counts.typeFactCount++; }
        else if (tag === "N") {
            const row = fields(line.value, schemaVersion >= 8 ? 13 : 11, "AST node");
            if (schemaVersion >= 20) {
                const id = number(row[1], "AST node identity", 1);
                if (schema20State.nodeIds.has(id)) throw new Error("Compiler semantic model has duplicate AST node identities.");
                schema20State.nodeIds.add(id);
                schema20State.nodeModules.set(id, schema20State.moduleCount);
                sidecarDetails.nodes.push({
                    id,
                    parent: number(row[2], "AST node parent", 0),
                    edge: string(row[3], "AST node edge"),
                    astClass: number(row[4], "AST node class", 0),
                    symbol: number(row[9], "AST node symbol", 0)
                });
            }
            if (schemaVersion >= 8) decodeOperatorConcept(string(row[6], "AST operator code"), string(row[7], "AST operator kind"));
            counts.nodeCount++;
        }
        else if (tag === "B") {
            if (schemaVersion < 7) throw new Error("Binding records require compiler semantic schema version 7 or newer.");
            const row = fields(line.value, 9, "binding");
            const symbol = number(row[1], "binding symbol", 1);
            if (row[2] !== "declaration" && row[2] !== "reference") throw new Error("Unknown compiler semantic binding role.");
            const physical = number(row[3], "binding physical-range flag", 0);
            const filePath = string(row[4], "binding source path");
            const startLine = number(row[5], "binding start line", 1);
            const startColumn = number(row[6], "binding start column", 0);
            const endLine = number(row[7], "binding end line", 1);
            const endColumn = number(row[8], "binding end column", 0);
            if (physical > 1 || !filePath || endLine < startLine ||
                endLine === startLine && endColumn <= startColumn) {
                throw new Error("Compiler semantic binding has an invalid source range.");
            }
            counts.bindingCount++;
            if (schemaVersion >= 20 && schema20State.includeBindings) {
                schema20State.bindingIds.add(counts.bindingCount);
            }
            if (bindingSymbolIds) {
                if (counts.bindingCount > MAX_EDITOR_BINDING_FACTS) throw new Error("Compiler semantic editor binding facts exceeded their limit.");
                bindingSymbolIds.add(symbol);
            }
            if (semanticSymbols && physical === 1) {
                bindings.push({
                    symbol, role: row[2], physical: true,
                    filePath, startLine, startColumn, endLine, endColumn
                });
            }
        }
        else if (tag === "I") {
            if (schemaVersion < 10) throw new Error("Implicit-call records require compiler semantic schema version 10 or newer.");
            if (!currentModulePath || currentModuleRecovered) throw new Error("Compiler semantic implicit call is outside a complete module.");
            const row = fields(line.value, schemaVersion >= 11 ? 12 : 11, "implicit call");
            const owner = number(row[1], "implicit-call owner symbol", 1);
            const target = number(row[2], "implicit-call target symbol", 1);
            const type = number(row[3], "implicit-call owner type", 1);
            if (!IMPLICIT_CALL_KINDS.has(row[4]) ||
                (row[4] === "destructor-call" && schemaVersion < 12) ||
                (row[4] === "argument-constructor" && schemaVersion < 13) ||
                (row[4] === "temporary-destructor" && schemaVersion < 14) ||
                (row[4] === "scope-exit-destructor" && schemaVersion < 15) ||
                (row[4] === "delete-destructor" && schemaVersion < 16) ||
                (row[4] === "return-constructor" && schemaVersion < 17)) throw new Error("Unknown compiler semantic implicit-call kind.");
            const physical = number(row[5], "implicit-call physical-range flag", 0);
            const filePath = string(row[6], "implicit-call source path");
            const startLine = number(row[7], "implicit-call start line", 1);
            const startColumn = number(row[8], "implicit-call start column", 0);
            const endLine = number(row[9], "implicit-call end line", 1);
            const endColumn = number(row[10], "implicit-call end column", 0);
            const targetSignature = schemaVersion >= 11 ? string(row[11], "implicit-call target signature") : "";
            if (physical > 1 || !filePath || endLine < startLine ||
                endLine === startLine && endColumn <= startColumn) {
                throw new Error("Compiler semantic implicit call has an invalid source range.");
            }
            if (schemaVersion >= 11 && (!targetSignature || Buffer.byteLength(targetSignature, "utf8") > MAX_IMPLICIT_CALL_SIGNATURE_BYTES)) {
                throw new Error("Compiler semantic implicit call has an invalid target signature.");
            }
            const signatureSubtypeIds = schemaVersion >= 18 ? stableCallSignatureSubtypeIds(targetSignature) : [];
            if (schemaVersion >= 18 && !signatureSubtypeIds) {
                throw new Error("Compiler semantic implicit call has an invalid stable target signature.");
            }
            counts.implicitCallCount++;
            if (implicitCallSymbolIds) {
                if (counts.implicitCallCount > MAX_EDITOR_IMPLICIT_CALL_FACTS) throw new Error("Compiler semantic editor implicit-call facts exceeded their limit.");
                implicitCallSymbolIds.add(owner);
                implicitCallSymbolIds.add(target);
                implicitCallSymbolIds.add(type);
                for (const subtypeId of signatureSubtypeIds) implicitCallSymbolIds.add(subtypeId);
            }
            if (semanticSymbols) {
                implicitCalls.push({
                    owner, target, type, kind: row[4], physical: physical === 1,
                    filePath, startLine, startColumn, endLine, endColumn, targetSignature
                });
            }
        }
        else if (tag === "E") {
            if (!currentModulePath || currentModuleRecovered) throw new Error("Compiler semantic expression is outside an open module.");
            if (schemaVersion < 3) throw new Error("Expression records require compiler semantic schema version 3 or newer.");
            const row = fields(line.value, schemaVersion >= 8 ? 16 : schemaVersion >= 4 ? 14 : 13, "expression");
            const id = number(row[1], "expression identity", 1);
            if (id <= lastExpressionId) throw new Error("Compiler semantic expression identities are not strictly increasing.");
            lastExpressionId = id;
            if (schemaVersion >= 20) {
                schema20State.expressionIds.add(id);
                schema20State.expressionModules.set(id, schema20State.moduleCount);
            }
            const physical = number(row[2], "expression physical-range flag", 0);
            if (physical > 1) throw new Error("Unknown compiler semantic expression physical-range flag.");
            const expression = {
                id,
                physical: physical === 1,
                filePath: string(row[3], "expression source path"),
                startLine: number(row[4], "expression start line", 1),
                startColumn: number(row[5], "expression start column", 0),
                endLine: number(row[6], "expression end line", 1),
                endColumn: number(row[7], "expression end column", 0),
                astClass: number(row[8], "expression AST class", 0),
                operator: number(row[9], "expression operator"),
                dtype: number(row[schemaVersion >= 8 ? 12 : 10], "expression data type"),
                symbol: number(row[schemaVersion >= 8 ? 13 : 11], "expression symbol", 0),
                subtype: number(row[schemaVersion >= 8 ? 14 : 12], "expression subtype", 0),
                typeName: schemaVersion >= 4 ? string(row[schemaVersion >= 8 ? 15 : 13], "expression type spelling") : ""
            };
            if (schemaVersion >= 20 && !schema20State.includeBindings && (expression.symbol !== 0 || expression.subtype !== 0)) {
                throw new Error("Schema-20 expression-only output retains symbol identities.");
            }
            if (schemaVersion >= 8) Object.assign(expression, decodeOperatorConcept(string(row[10], "expression operator code"), string(row[11], "expression operator kind")));
            /* Full assignment models retain bounded nonphysical destination and operation types for operator hovers. */
            if (schemaVersion >= 27 && schema20State.includeBindings && !expression.physical &&
                expression.typeName && (expression.symbol > 0 || SCHEMA27_ASSIGNMENT_OPERATORS.has(expression.operatorCode))) {
                if (sidecarDetails.assignmentExpressionSummaries.length < MAX_EDITOR_ASSIGNMENT_RESULT_FACTS) {
                    sidecarDetails.assignmentExpressionSummaries.push({ ...expression, module: schema20State.moduleCount });
                } else {
                    sidecarDetails.assignmentExpressionSummariesComplete = false;
                }
            }
            if (schemaVersion >= 27 && (expression.operatorCode.startsWith("va-") || !expression.typeName)) {
                schema20State.sourceOperationExpressions.set(id, { ...expression, module: schema20State.moduleCount });
            }
            if (!expression.filePath || expression.endLine < expression.startLine ||
                expression.endLine === expression.startLine && expression.endColumn <= expression.startColumn) {
                throw new Error("Compiler semantic expression has an invalid source range.");
            }
            counts.expressionCount++;
            currentModuleExpressionCount++;
            if (schemaVersion >= 4 && expression.physical && expression.typeName && includeExpression(expression)) {
                if (expressions.length >= MAX_EDITOR_EXPRESSION_FACTS) throw new Error("Compiler semantic editor expression facts exceeded their limit.");
                expressions.push(expression);
                currentModuleExpressions.push(expression);
            }
        } else if (tag === "R") {
            if (options.allowRecovery !== true || schemaVersion < 5 || !currentModulePath || currentModuleRecovered) {
                throw new Error("Unsupported or misplaced compiler semantic recovery record.");
            }
            const row = fields(line.value, 3, "recovery module");
            if (row[1] !== header[1] || number(row[2], "recovery module expression count", 0) !== currentModuleExpressionCount) {
                throw new Error("Compiler semantic recovery module total does not match its records.");
            }
            for (const expression of currentModuleExpressions) expression.recovery = true;
            currentModuleRecovered = true;
            recoveryModuleCount++;
        } else throw new Error(`Unknown compiler semantic record type: ${tag || "<empty>"}.`);
    }
    if (!footer) throw new Error("Compiler semantic model is missing its completeness marker.");
    if (footer.recovery === true) {
        if (counts.moduleCount !== footer.moduleCount || counts.expressionCount !== footer.expressionCount ||
            counts.procedureCount !== 0 || counts.symbolCount !== 0 || counts.typeFactCount !== 0 || counts.nodeCount !== 0) {
            throw new Error("Compiler semantic recovery footer totals do not match the records.");
        }
    } else if (Object.keys(counts).some((key) => counts[key] !== footer[key])) {
        throw new Error("Compiler semantic footer totals do not match the records.");
    }
    if (schemaVersion >= 20 && footer.recovery !== true && footer.detailCount !== detailRecordCount) {
        throw new Error("Compiler semantic detail totals do not match the records.");
    }
    if (schemaVersion >= 6 && dependencies.length !== footer.dependencyCount) throw new Error("Compiler semantic dependency totals do not match the records.");
    if (schemaVersion >= 20) {
        if (schema20State.sourceContextIds.size !== schema20State.sourceClosureIds.size ||
            [...schema20State.sourceContextIds].some((id) => !schema20State.sourceClosureIds.has(id))) {
            throw new Error("Schema-20 source contexts are not completely closed.");
        }
        if (sidecarDetails.sourceClosures.some((closure) => closure.status === "changed-or-unreadable")) {
            throw new Error("Schema-20 semantic model contains a changed or unreadable source.");
        }
        if (schema20State.includeBindings && schema20State.targetModulePaths.size &&
            schema20State.targetModulePaths.size !== modules.length) {
            throw new Error("Schema-20 target contexts do not cover every module.");
        }
        const available = {
            symbol: schema20State.symbolIds,
            node: schema20State.nodeIds,
            expression: schema20State.expressionIds,
            declaration: schema20State.declarationIds,
            binding: schema20State.bindingIds
        };
        for (const reference of schema20State.references) {
            if (!available[reference.domain]?.has(reference.identity)) {
                throw new Error(`Schema-20 ${reference.label} refers to a missing ${reference.domain}.`);
            }
        }
    }
    if (schemaVersion >= 21) validateConditionalGraph(schema20State, footer.recovery !== true);
    if (schemaVersion >= 22) validateSemanticMacroGraph(schema20State, footer.recovery !== true);
    if (schemaVersion >= 25) validateSemanticConstructGraph(schema20State, footer.recovery !== true);
    if (schemaVersion >= 27) {
        if (options.includeBindings === true) validateSemanticPolicyInputs(schema20State, footer.recovery !== true);
        else if (schema20State.result.properties.some((property) =>
            property.name.startsWith("header-policy:") || property.name.startsWith("header-library:") ||
            property.name.startsWith("header-import:") || property.name.startsWith("namespace-declaration:"))) {
            throw new Error("Full compiler semantic policy inputs require the binding-capable reader.");
        }
        validateSemanticNormalizedTypes(schema20State);
        validateSemanticExpressionOperands(schema20State);
        validateSemanticParsedExpressionCoverage(schema20State, footer.recovery !== true);
        validateSemanticIifInputs(schema20State, footer.recovery !== true);
        validateSemanticNumericAssignmentTargets(schema20State);
        validateSemanticSourceVaListOperations(schema20State);
        validateSemanticComments(schema20State, footer.recovery !== true);
        validateSemanticFlowGraph(schema20State, footer.recovery !== true);
    }
    if (bindingSymbolIds && [...bindingSymbolIds].some((id) => !semanticSymbols.has(id))) throw new Error("Compiler semantic binding refers to a missing symbol.");
    if (implicitCallSymbolIds && [...implicitCallSymbolIds].some((id) => !semanticSymbols.has(id))) throw new Error("Compiler semantic implicit call refers to a missing symbol.");
    if (semanticSymbols) {
        for (const binding of bindings) binding.name = semanticSymbols.get(binding.symbol);
    }
    return {
        schemaVersion, compilerVersion: header[2], modules, dependencies,
        dependenciesComplete: schemaVersion >= 6 && footer.dependenciesComplete === true,
        expressions, bindings, implicitCalls,
        ...sidecarDetails,
        counts: footer, complete: footer.recovery !== true, recovery: footer.recovery === true
    };
}

module.exports = {
    MAX_SEMANTIC_MODEL_BYTES,
    MAX_SEMANTIC_MODEL_RECORDS,
    MAX_EDITOR_EXPRESSION_FACTS,
    MAX_EDITOR_BINDING_FACTS,
    MAX_EDITOR_IMPLICIT_CALL_FACTS,
    MAX_IMPLICIT_CALL_SIGNATURE_BYTES,
    decodeSemanticString,
    decodeCompilerSemanticModel,
    decodeCompilerSemanticExpressions
};

/* end of lib/compiler-semantic-sidecar.js */
