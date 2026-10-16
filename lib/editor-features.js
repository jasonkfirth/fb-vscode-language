/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/editor-features.js

    Purpose:

        Adapt source-backed FreeBASIC analysis into VS Code language providers.

    Responsibilities:

        - provide completions, hovers, symbols, definitions, and signatures
        - provide references, rename edits, highlights, folding, and links
        - provide conservative document and selection indentation formatting
        - provide compiler- and bracket-diagnostic Quick Fixes
        - map parser-neutral declarations and ranges to VS Code API objects

    This file intentionally does NOT contain:

        - source parsing
        - workspace index storage
        - compiler execution or diagnostics
*/

const fs = require("fs");
const path = require("path");
const { getIncludeDirectories, resolveIncludePath } = require("./include-paths");
const { findBracketProblems } = require("./bracket-diagnostics");
const { COMPILER_MESSAGE_CODE } = require("./compiler-diagnostics");
const {
    compilerByRefFunctionResultAssignmentRange,
    compilerConstantConversionOverflowRange,
    compilerDeclarationSuffixConflictRange,
    compilerDiagnosticContextLabel,
    compilerErrorResumeNextRange,
    compilerIgnoredDeclarationSuffixRange,
    compilerMissingClosingQuoteRange,
    compilerPossibleEscapeStringRange,
    compilerRedundantNewAnyInitializerRange,
    forNextCounterIdentifiers,
    forNextCounterIdentifierRange
} = require("./compiler-diagnostic-sidecar");
const { formatFreeBasicIndentation } = require("./freebasic-formatter");
const { compilerAwareCodeContext } = require("./compiler-string-context");
const { compilerEditorModel, editorModel } = require("./editor-model");
const { getReferenceEntries, getReferenceMarkdown, getReferenceNames, getReferenceSignatures } = require("./language-reference");
const { compilerConstantValue, compilerConstantValueText, compilerTargetWideLiteralText } = require("./compiler-constant-values");
const {
    compilerAbstractMemberSummary,
    compilerAggregateLayoutSummary,
    compilerArrayBoundsSummary,
    compilerDefaultProcedureVisibilitySummary,
    compilerDocumentationSummary,
    compilerFieldLayoutSummary,
    compilerImplicitStorageSummary,
    compilerMemberAccessSummary,
    compilerOverrideSummary,
    compilerParameterOutlineSummary,
    compilerProcedureOutlineAbiSummary
} = require("./compiler-document-symbols");
const { semanticEntryIsDeprecated } = require("./semantic-token-data");
const { createSemanticFeatures, hasPotentialOperatorLetAt, isCastCalleeAt, isMathOperatorCalleeAt, isOperatorTokenAt, compilerOperatorKeywordAtPosition, hasPotentialIteratorOperatorAt, sidecarSelectedOperatorTarget, sidecarSelectedOverload } = require("./semantic-features");
const { createDocumentModel, isLocal, normalizeTypeName, positionOffset, scopeAt, tokenize } = require("./semantic-model");

const {
    findCallContext,
    findSignatureCallContext,
    getCodeContext,
    findDeclarationsByName,
    maskFreeBasicText,
    normalizeIdentifier,
    parseFreeBasicText
} = require("./freebasic-parser");

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?/;
const FREEBASIC_KEYWORDS = new Set(require("../syntaxes/source/freebasic.grammar-source.json").keywords
    .map(normalizeIdentifier));
const QUALIFIED_IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?)*/g;
const MAX_TYPO_SUGGESTION_ENTRIES = 2000;
const REFERENCE_NAMES = getReferenceNames();
const MAX_INCLUDE_COMPLETION_DIRECTORIES = 256;
const MAX_INCLUDE_COMPLETION_ENTRIES = 20000;
const MAX_INCLUDE_COMPLETION_ITEMS = 2000;
const MAX_INCLUDE_COMPLETION_PATH_LENGTH = 4096;
const MAX_REFERENCE_IMPORT_SOURCE_LENGTH = 2_000_000;
const SIMPLE_INTEGER_PARAMETER_DEFAULT = /^-?(?:\d+|&h[0-9a-f]+|&o[0-7]+|&b[01]+)(?:ull|ul|ll|u|l|%|&)?$/i;
const SIMPLE_FLOAT_PARAMETER_DEFAULT = /^[+-]?(?:(?:\d+\.\d*|\.\d+)(?:[ed][+-]?\d+)?|\d+[ed][+-]?\d+|\d+)(?:[fd!#])?$/i;
const SIMPLE_IDENTIFIER_PARAMETER_DEFAULT = /^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/;
const SIMPLE_QUALIFIED_IDENTIFIER_PARAMETER_DEFAULT = /^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\.[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)+$/;
/* Bound source-only macro-call detection on unusually large visible ranges. */
const MAX_STOCK_SIDECAR_MACRO_INLAY_CANDIDATES = 2048;
const MAX_PARAMETER_DEFAULT_PROTOTYPE_CHARACTERS = 8_000_000;
const MAX_STOCK_SIDECAR_OUTLINE_CONSTANTS = 256;
const MAX_STOCK_SIDECAR_OUTLINE_TYPE_SITES = 256;
const MAX_STOCK_SIDECAR_OUTLINE_IMPLICIT_VARIABLE_BYTES = 4 * 1024 * 1024;
const MAX_STOCK_SIDECAR_MASKED_OUTLINE_DOCUMENTS = 8;
/* Keep implicit-target scans bounded on continued or malformed statements. */
const MAX_IMPLICIT_TARGET_STATEMENT_LINES = 128;
const MAX_IMPLICIT_ALLOCATION_WARNING_CANDIDATES = 16;
/* Bound dependency snapshots scanned for cross-file parameter declarations. */
const MAX_PARAMETER_DEFAULT_PROTOTYPE_SOURCES = 256;
const MAX_BYREF_WARNING_CALL_CANDIDATES = 256;
const MAX_OUTLINE_DOCUMENTATION_LINES = 24;
const MAX_OUTLINE_DOCUMENTATION_CHARACTERS = 4096;
const stockSidecarImplicitVariableRecordsByModel = new WeakMap();
const stockSidecarMaskedVariableOutlineRecordsByModel = new WeakMap();
const optionNoKeywordDirectiveCaches = new WeakMap();
/* Bound compiler-selected symbol names before placing them in hover markup. */
const MAX_COMPILER_ARRAY_STORAGE_NAME_LENGTH = 1024;
/* Keep compiler-derived pointer spellings bounded in declaration hovers. */
const MAX_COMPILER_IMPLICIT_TYPE_POINTER_DEPTH = 8;
const COMPILER_PRIMITIVE_TYPE_NAMES = Object.freeze({
    boolean: "Boolean", byte: "Byte", ubyte: "UByte", short: "Short", ushort: "UShort",
    integer: "Integer", uinteger: "UInteger", long: "Long", ulong: "ULong",
    longint: "LongInt", ulongint: "ULongInt", single: "Single", double: "Double",
    string: "String", wstring: "WString", zstring: "ZString", object: "Object"
});
const FILE_TRANSFER_POINTER_BASE_TYPES = new Set([
    "boolean", "byte", "ubyte", "short", "ushort", "integer", "uinteger",
    "long", "ulong", "longint", "ulongint", "single", "double"
]);
const COMPOUND_ASSIGNMENT_TOKENS = Object.freeze([
    "ANDALSO=", "ORELSE=", "SHL=", "SHR=", "MOD=", "EQV=", "IMP=", "XOR=", "AND=", "OR=",
    "+=", "-=", "*=", "/=", "\\=", "^=", "&="
]);
const IMPLICIT_COMPOUND_ASSIGNMENT_TARGET = /^(\s*)([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*(?:ANDALSO=|ORELSE=|SHL=|SHR=|MOD=|EQV=|IMP=|XOR=|AND=|OR=|\+=|-=|\*=|\/=|\\=|\^=|&=)/i;
const IMPLICIT_LSET_RSET_TARGET = /^(\s*)(?:LSET|RSET)\s+([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*=(?!=|>)/i;
const MAX_PROCEDURE_HEADER_SCAN_CHARACTERS = 65536;
const COMPILER_SOURCE_OPERATION_LABELS = Object.freeze({
    add: "addition", subtract: "subtraction", multiply: "multiplication", divide: "division",
    "integer-divide": "integer division", modulo: "modulo", and: "AND", or: "OR",
    "logical-and": "logical AND", "logical-or": "logical OR", xor: "XOR",
    equivalence: "EQV", implication: "IMP", "shift-left": "left shift",
    "shift-right": "right shift", power: "power", concatenate: "concatenation",
    equal: "equality comparison", "greater-than": "greater-than comparison",
    "less-than": "less-than comparison", "not-equal": "inequality comparison",
    "greater-or-equal": "greater-or-equal comparison", "less-or-equal": "less-or-equal comparison",
    "identity-test": "identity comparison", negate: "negation", "unary-plus": "unary plus",
    not: "NOT", dereference: "pointer dereference", cast: "conversion", "absolute-value": "absolute value",
    sign: "sign", sine: "sine", arcsine: "arcsine", cosine: "cosine", arccosine: "arccosine",
    tangent: "tangent", arctangent: "arctangent", "square-root": "square root",
    logarithm: "logarithm", exponential: "exponential", floor: "floor",
    truncate: "truncation", "fractional-part": "fractional part", arctangent2: "two-argument arctangent",
    "va-start": "C vararg initialization", "va-arg": "C vararg extraction",
    "va-copy": "C vararg-list copy", "va-end": "C vararg-list cleanup"
});
const COMPILER_SOURCE_OPERATION_ARITIES = Object.freeze({
    binary: 2, "intrinsic-binary": 2, unary: 1, "intrinsic-unary": 1, cast: 1
});
const COMPILER_SOURCE_RUNTIME_MACRO_ARITIES = Object.freeze({
    "va-start": 2, "va-arg": 1, "va-copy": 2, "va-end": 1
});
/* Keep a short completion prefix from expanding into a large sidecar request. */
const MAX_STOCK_SIDECAR_COMPLETION_CONSTANTS = 64;
const MAX_STOCK_SIDECAR_COMPLETION_FACT_SITES = 64;
/* Match the editor's maximum completion limit while bounding source joins. */
const MAX_STOCK_SIDECAR_MEMBER_DECLARATIONS = 20000;
/* Keep overload help useful without allowing one completion item to grow without bound. */
const MAX_COMPLETION_SIGNATURE_DETAILS = 8;
/* Bound logical-line reconstruction while completing a continued branch list. */
const MAX_LABEL_COMPLETION_LINES = 128;
const MAX_LABEL_COMPLETION_CHARACTERS = 65536;
const LABEL_COMPLETION_TARGET = /^(?:&h[0-9a-f]+|&o[0-7]+|&b[01]+|\d+|[a-z_][a-z\d_$%!#&]*)$/i;
const LABEL_COMPLETION_PREFIX = /^(?:&[hbo][\da-f]*|\d*|[a-z_][a-z\d_$%!#&]*)$/i;
/* The sidecar stores comparison receipts per selected CASE bound. */
const MAX_COMPILER_SELECT_CASE_COMPARISON_TESTS = 100000;
const COMPILER_PARAMETER_PASSING_LABELS = Object.freeze({
    byval: "ByVal", byref: "ByRef", bydesc: "ByDesc", vararg: "VarArg"
});

function labelCompletionStatementContext(code) {
    let statement = code.slice(code.lastIndexOf(":") + 1);
    if (/\b(?:goto|gosub|restore)\s+(?:(?:&[hbo][\da-f]*|\d*|[a-z_][a-z\d_$%!#&]*))?$/i.test(statement)) return true;
    /* Each inline IF arm has its own branch statement. A member named Then
       or Else is not a separator, including whitespace around its dot. */
    let armStart = 0;
    for (const boundary of statement.matchAll(/\b(?:then|else)\s+/gi)) {
        let previous = boundary.index - 1;
        while (previous >= 0 && /\s/.test(statement[previous])) previous--;
        if (statement[previous] !== ".") armStart = boundary.index + boundary[0].length;
    }
    statement = statement.slice(armStart);
    const branch = /\b(?:goto|gosub)\s+([\s\S]*)$/i.exec(statement);
    if (!branch) return false;
    /* Only computed ON branches accept target lists. Error-handler forms
       still name one label, even when their source contains a stray comma. */
    const selector = /\bon\s+([\s\S]*)$/i.exec(statement.slice(0, branch.index));
    if (!selector?.[1].trim() || /^(?:local\s+)?error\b/i.test(selector[1].trim())) return false;
    const targets = branch[1].split(",");
    const current = targets.pop().trim();
    return targets.length > 0 && LABEL_COMPLETION_PREFIX.test(current) &&
        targets.every((target) => LABEL_COMPLETION_TARGET.test(target.trim()));
}

function isLabelCompletionContext(linePrefix, document, position) {
    const parts = [maskFreeBasicText(linePrefix)];
    if (labelCompletionStatementContext(parts[0])) return true;
    let line = position.line, characters = parts[0].length;
    while (line > 0) {
        const previous = document.lineAt(line - 1).text;
        if (previous.length > MAX_LABEL_COMPLETION_CHARACTERS) return false;
        const masked = maskFreeBasicText(previous);
        if (!/(?:^|\s)_\s*$/.test(masked)) break;
        if (parts.length >= MAX_LABEL_COMPLETION_LINES ||
            characters + masked.length + 1 > MAX_LABEL_COMPLETION_CHARACTERS) return false;
        parts.push(masked.replace(/_\s*$/, ""));
        characters += masked.length + 1;
        line--;
    }
    return parts.length > 1 && labelCompletionStatementContext(parts.reverse().join("\n"));
}

function isPreprocessorMacroNameCompletionContext(linePrefix) {
    const code = maskFreeBasicText(linePrefix);
    if (/^\s*#\s*(?:ifdef|ifndef|elseifdef|elseifndef|undef)\s+(?:[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)?$/i.test(code)) {
        return true;
    }
    return preprocessorDefinedNameCompletionPrefix(code) !== null;
}

function isPreprocessorConditionalExpressionContext(linePrefix) {
    return /^\s*#\s*(?:if|elseif)\b/i.test(maskFreeBasicText(linePrefix));
}

function preprocessorDefinedNameCompletionPrefix(linePrefix) {
    const identifier = "[A-Za-z_][A-Za-z0-9_]*[$%!#&]?";
    const qualifiedPrefix = `${identifier}(?:\\.${identifier})*\\.?`;
    const pattern = new RegExp(`^\\s*#\\s*(?:if|elseif)\\b[\\s\\S]*\\bdefined\\s*\\(\\s*(${qualifiedPrefix})?$`, "i");
    const match = pattern.exec(maskFreeBasicText(linePrefix));
    return match ? match[1] || "" : null;
}

function isUsingNamespaceCompletionContext(linePrefix) {
    const code = maskFreeBasicText(linePrefix);
    const identifier = "[A-Za-z_][A-Za-z0-9_]*";
    const qualified = `${identifier}(?:\\.${identifier})*`;
    return new RegExp(`^\\s*using\\s+(?:${qualified}\\s*,\\s*)*(?:${qualified})?$`, "i").test(code);
}

function isNestedUsingNamespaceCompletionContext(linePrefix) {
    const code = maskFreeBasicText(linePrefix);
    const identifier = "[A-Za-z_][A-Za-z0-9_]*";
    const qualified = `${identifier}(?:\\.${identifier})*`;
    return new RegExp(`^\\s*using\\s+(?:${qualified}\\s*,\\s*)*${qualified}\\.\\s*$`, "i").test(code);
}

function stockSidecarNoKeywordCompletionPotential(document, position, linePrefix) {
    const prefix = String(linePrefix || "").match(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/)?.[0] || "";
    const normalizedPrefix = normalizeIdentifier(prefix);
    if (normalizedPrefix.length < 2) return false;
    const cursorOffset = document.offsetAt(position);
    for (const [name, directiveOffset] of optionNoKeywordDirectiveRecord(document).firstOffsets) {
        if (directiveOffset <= cursorOffset && name.startsWith(normalizedPrefix)) return true;
    }
    return false;
}

function constructorCompletionTypePrefix(linePrefix) {
    const code = maskFreeBasicText(String(linePrefix || ""));
    const name = /((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)$/.exec(code);
    if (!name) return "";
    const before = code.slice(0, name.index).trimEnd();
    if (!/\bNEW$/i.test(before) && !/\b(?:RETURN|PRINT)$/i.test(before) && !/[=(,]$/.test(before)) return "";
    return name[1].split(".").at(-1);
}

function stockSidecarConstructorCompletionPotential(linePrefix) {
    return normalizeIdentifier(constructorCompletionTypePrefix(linePrefix)).length >= 2;
}

function sourceMacroCallAt(index, document, callContext) {
    if (!document || !callContext || callContext.indexing) return null;
    const beforeCall = document.getText().slice(0, callContext.openParenthesisOffset).trimEnd();
    const nameStart = beforeCall.length - callContext.name.length;
    if (nameStart < 0 || beforeCall.slice(nameStart) !== callContext.name) return null;
    index.getParsedDocument?.(document);
    const sourceModel = index.getSourceSemanticModel?.() ||
        index.getSemanticModel?.(document.uri, { sourceOnly: true });
    if (!sourceModel) return null;
    const lines = document.getText().slice(0, nameStart).split(/\r\n|\n|\r/);
    const position = { line: lines.length - 1, character: lines.at(-1).length };
    return sourceModel.resolveAt(document.uri, position.line, position.character)
        .some((entry) => entry.declaration?.type === "macro")
        ? { name: callContext.name, ...position }
        : null;
}

function hasPotentialCompilerMacroParameterInlayHint(index, document, parsed, range) {
    if (!document || !range?.start || !range?.end || !index ||
        !Number.isSafeInteger(range.start.line) || !Number.isSafeInteger(range.end.line) ||
        range.start.line < 0 || range.end.line < range.start.line) return false;
    const sourceModel = index.getSourceSemanticModel?.() ||
        index.getSemanticModel?.(document.uri, { sourceOnly: true });
    if (typeof sourceModel?.resolveAt !== "function") return false;

    const identifierCall = /([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*\(/g;
    let scannedCandidates = 0;
    for (const statement of parsed?.statements || []) {
        if (statement.endLine < range.start.line || statement.startLine > range.end.line) continue;
        const code = String(statement.maskedText || "");
        const preprocessorExpression = /^\s*#\s*(?:if|elseif|assert)\b/i.test(code);
        if (!code.trim() || /^\s*#/.test(code) && !preprocessorExpression) continue;
        let line = statement.startLine;
        let lineStart = 0;
        for (const match of code.matchAll(identifierCall)) {
            scannedCandidates++;
            if (scannedCandidates > MAX_STOCK_SIDECAR_MACRO_INLAY_CANDIDATES) return true;
            let lineBreak = code.indexOf("\n", lineStart);
            while (lineBreak >= 0 && lineBreak < match.index) {
                line++;
                lineStart = lineBreak + 1;
                lineBreak = code.indexOf("\n", lineStart);
            }
            const character = match.index - lineStart;
            if (sourceModel.resolveAt(document.uri, line, character)
                .some((entry) => entry.declaration?.type === "macro")) return true;
        }
    }
    return false;
}

async function stockSidecarCompletionConstantValues(workspaceIndex, document, linePrefix, entries, token) {
    const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
    if (compilerSelection?.semanticModelOnly !== true || token?.isCancellationRequested) return new Map();
    const prefix = String(linePrefix || "").match(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/)?.[0] || "";
    if (prefix.length < 2) return new Map();
    const candidates = entries.filter((entry) => {
        const declaration = entry.declaration || {};
        const name = entry.name || declaration.name || "";
        return ["const", "enumMember", "enum-member"].includes(declaration.type) &&
            name.toLowerCase().startsWith(prefix.toLowerCase()) &&
            !compilerConstantValue(entry.compilerFacts || declaration.compilerFacts);
    }).slice(0, MAX_STOCK_SIDECAR_COMPLETION_CONSTANTS);
    if (!candidates.length) return new Map();
    const sites = candidates.map((entry, index) => ({
        index,
        filePath: entry.uri?.fsPath || entry.uri?.path || "",
        line: entry.declaration.line,
        startColumn: entry.declaration.startColumn,
        endColumn: entry.declaration.endColumn
    }));
    if (sites.some((site) => !site.filePath || !Number.isSafeInteger(site.line) || site.line < 0 ||
        !Number.isSafeInteger(site.startColumn) || !Number.isSafeInteger(site.endColumn) || site.endColumn <= site.startColumn)) {
        return new Map();
    }
    const compilerModel = await editorModel(workspaceIndex, document, token, false, true);
    if (token?.isCancellationRequested || !compilerModel?.remote || !compilerModel.semanticSidecarOnly) return new Map();
    const values = await compilerModel.query("compilerSidecarConstantsAtSites", document.uri, { sites }, token);
    if (!Array.isArray(values) || token?.isCancellationRequested) return new Map();
    const result = new Map();
    for (const value of values) {
        if (!Number.isSafeInteger(value?.index) || value.index < 0 || value.index >= candidates.length) continue;
        result.set(candidates[value.index], { kind: value.kind, value: value.value });
    }
    return result;
}

async function stockSidecarCompletionTypeFacts(workspaceIndex, document, linePrefix, entries, token) {
    const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
    if (compilerSelection?.semanticModelOnly !== true || token?.isCancellationRequested) return new Map();
    const prefix = String(linePrefix || "").match(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/)?.[0] || "";
    if (prefix.length < 2) return new Map();
    const candidates = entries.filter((entry) => {
        const declaration = entry.declaration || {};
        const name = entry.name || declaration.name || "";
        const typeDeclaration = ["type", "class", "union"].includes(declaration.type) &&
            declaration.detail !== "Type alias";
        const untypedDeclaration = ["variable", "extern", "const", "function", "property", "parameter"]
            .includes(declaration.type) && !declaration.typeName && !/[$%!#&]$/.test(declaration.name);
        return (typeDeclaration || untypedDeclaration) && name.toLowerCase().startsWith(prefix.toLowerCase());
    }).slice(0, MAX_STOCK_SIDECAR_COMPLETION_FACT_SITES);
    if (!candidates.length) return new Map();
    const sites = candidates.map((entry, index) => ({
        index,
        filePath: entry.uri?.fsPath || entry.uri?.path || "",
        line: entry.declaration.line,
        startColumn: entry.declaration.startColumn,
        endColumn: entry.declaration.endColumn
    }));
    if (sites.some((site) => !site.filePath || !Number.isSafeInteger(site.line) || site.line < 0 ||
        !Number.isSafeInteger(site.startColumn) || !Number.isSafeInteger(site.endColumn) || site.endColumn <= site.startColumn)) {
        return new Map();
    }
    const compilerModel = await editorModel(workspaceIndex, document, token, false, true);
    if (token?.isCancellationRequested || !compilerModel?.remote || !compilerModel.semanticSidecarOnly) return new Map();
    let factsAtSites;
    try {
        factsAtSites = await compilerModel.query("compilerSidecarOutlineFactsAtSites", document.uri, { sites }, token);
    } catch {
        return new Map();
    }
    if (!Array.isArray(factsAtSites) || token?.isCancellationRequested) return new Map();
    const result = new Map();
    for (const factAtSite of factsAtSites) {
        if (!Number.isSafeInteger(factAtSite?.index) || factAtSite.index < 0 || factAtSite.index >= candidates.length ||
            !factAtSite.compilerFacts || typeof factAtSite.compilerFacts !== "object") continue;
        result.set(candidates[factAtSite.index], factAtSite.compilerFacts);
    }
    return result;
}

function compilerSelectedCompletionTypeName(declaration, facts) {
    if (!declaration || !facts || declaration.typeName || /[$%!#&]$/.test(declaration.name || "")) return "";
    let hasImplicitType = false;
    if (["variable", "extern", "const"].includes(declaration.type)) {
        const inputs = facts.declarationInputs;
        const writtenTypes = new Set(Array.isArray(inputs) ? inputs.map((input) => input.writtenType) : []);
        const completeInputs = Array.isArray(inputs) && inputs.length > 0 && inputs.every((input) => {
            const group = input.group;
            return input.provisional === false && Number.isSafeInteger(input.symbol) && input.symbol > 0 &&
                Number.isSafeInteger(input.ordinal) && input.ordinal > 0 && group?.provisional === false &&
                Number.isSafeInteger(group.count) && group.count > 0 && input.ordinal <= group.count &&
                ["dim", "static", "common", "extern", "const", "var"].includes(group.kind) &&
                ["implicit", "inferred"].includes(input.writtenType);
        });
        const implicitRedim = declaration.type === "variable" &&
            /^\s*(?:(?:public|private|protected|shared|static|common|extern)\s+)*redim(?:\s+(?:preserve|shared))*\b/i.test(
                maskFreeBasicText(declaration.sourceLine || "")
            ) && !/\bas\b/i.test(maskFreeBasicText(declaration.sourceLine || ""));
        hasImplicitType = completeInputs && writtenTypes.size === 1 || implicitRedim;
    } else if (declaration.type === "parameter") {
        const writtenTypes = facts.formalWrittenTypes;
        hasImplicitType = Array.isArray(writtenTypes) && writtenTypes.length > 0 &&
            writtenTypes.every((writtenType) => writtenType === "implicit");
    } else if (["function", "property"].includes(declaration.type)) {
        const inputs = facts.procedureTypingInputs;
        hasImplicitType = Array.isArray(inputs) && inputs.length > 0 && inputs.every((input) =>
            input.provisional === false && input.kind === declaration.type && input.resultForm === "implicit"
        );
    }
    return hasImplicitType ? compilerPrimitiveTypeName(facts.storageType) : "";
}

function declarationForCompletion(entry, name, stockSidecarConstants = null, stockSidecarTypeFacts = null) {
    const declaration = { ...entry.declaration, name };
    if (entry.callableKind === "function" || entry.callableKind === "method") declaration.callableKind = entry.callableKind;
    if (typeof entry.qualifiedName === "string") declaration.qualifiedName = entry.qualifiedName;
    const compilerValue = stockSidecarConstants?.get(entry);
    const compilerFacts = entry.compilerFacts || declaration.compilerFacts;
    const typeFacts = stockSidecarTypeFacts?.get(entry);
    const compilerTypeName = compilerSelectedCompletionTypeName(declaration, typeFacts);
    if (compilerTypeName) {
        declaration.typeName = compilerTypeName;
        declaration.detail = `${declaration.detail || declaration.type} (compiler-selected type)`;
    }
    const combinedFacts = typeFacts
        ? {
            ...(compilerFacts || {}),
            ...typeFacts,
            properties: [...(compilerFacts?.properties || []), ...(typeFacts.properties || [])]
        }
        : compilerFacts;
    if (compilerValue) {
        declaration.compilerFacts = {
            ...(combinedFacts || {}),
            constantValues: [...(combinedFacts?.constantValues || []), compilerValue]
        };
    } else if (combinedFacts) {
        declaration.compilerFacts = combinedFacts;
    }
    return declaration;
}

function createEditorFeatures(vscode, workspaceIndex, grammarData) {
    return {
        completion: createCompletionProvider(vscode, workspaceIndex, grammarData),
        codeAction: createMissingHeaderCodeActionProvider(vscode, workspaceIndex, grammarData.libraryTypes),
        documentLink: createDocumentLinkProvider(vscode, workspaceIndex),
        documentFormatting: createDocumentFormattingProvider(vscode, workspaceIndex),
        documentRangeFormatting: createDocumentRangeFormattingProvider(vscode, workspaceIndex),
        documentSymbol: createDocumentSymbolProvider(vscode, workspaceIndex),
        folding: createFoldingRangeProvider(vscode, workspaceIndex),
        hover: createHoverProvider(vscode, workspaceIndex, grammarData),
        inlayHints: createInlayHintsProvider(vscode, workspaceIndex),
        signature: createSignatureHelpProvider(vscode, workspaceIndex),
        workspaceSymbol: createWorkspaceSymbolProvider(vscode, workspaceIndex),
        ...createSemanticFeatures(vscode, workspaceIndex, grammarData)
    };
}

/* ------------------------------------------------------------------------- */
/* Completion and hover                                                       */
/* ------------------------------------------------------------------------- */

function createCompletionProvider(vscode, workspaceIndex, grammarData) {
    return {
        async provideCompletionItems(document, position, token) {
            const includeItems = await includePathCompletionItems(vscode, document, position, token);
            if (includeItems !== null) return includeItems;
            let linePrefix = document.lineAt(position.line).text.slice(0, position.character);
            if ((linePrefix.endsWith("/") || linePrefix.endsWith("\\")) &&
                !/^\s*#\s*include\b/i.test(linePrefix)) return [];
            const sourceContext = await compilerAwareCodeContext(
                workspaceIndex, document, document.offsetAt(position), linePrefix, token
            );
            if (sourceContext.context !== "code") return [];
            linePrefix = sourceContext.maskedLinePrefix ?? linePrefix;
            const preprocessorMacroNameContext = isPreprocessorMacroNameCompletionContext(linePrefix);
            const preprocessorExpressionContext = isPreprocessorConditionalExpressionContext(linePrefix);
            const preprocessorDefinedNamePrefix = preprocessorDefinedNameCompletionPrefix(linePrefix);
            const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
            const needNoKeywordBindings = Boolean(compilerSelection) &&
                stockSidecarNoKeywordCompletionPotential(document, position, linePrefix);
            const labelCompletionContext = isLabelCompletionContext(linePrefix, document, position);
            const nestedNamespaceContext = isNestedUsingNamespaceCompletionContext(linePrefix);
            const namespaceImportContext = nestedNamespaceContext || isUsingNamespaceCompletionContext(linePrefix);
            const needSidecarTypeBindings = compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                !preprocessorMacroNameContext && !preprocessorExpressionContext && !namespaceImportContext &&
                !labelCompletionContext && stockSidecarConstructorCompletionPotential(linePrefix);
            const needSemanticBindings = needNoKeywordBindings || needSidecarTypeBindings;

            const items = [];
            const seenLabels = new Set();
            const model = await editorModel(workspaceIndex, document, token, false, needSemanticBindings);
            if (!model || token?.isCancellationRequested) return [];
            const maxCompletions = Math.max(1, Math.min(20000,
                vscode.workspace.getConfiguration("freebasic", null).get("index.maxCompletionResults", 2000)));
            let memberEntries, visible, hasDirectivePrefix;
            if (model.remote) {
                const result = await model.query("completion", document.uri, { position, limit: maxCompletions }, token);
                if (!result) return [];
                if (nestedNamespaceContext) {
                    memberEntries = result.entries.filter((entry) => entry.declaration?.type === "namespace");
                    visible = [];
                } else {
                    memberEntries = result.member && !namespaceImportContext ? result.entries : null;
                    visible = result.member && namespaceImportContext ? [] : result.entries;
                }
                if (memberEntries !== null && !nestedNamespaceContext && compilerSelection?.semanticModelOnly === true) {
                    const compilerMembers = await compilerTypedMemberEntries(workspaceIndex, document, position, token, maxCompletions);
                    if (token?.isCancellationRequested) return [];
                    if (compilerMembers !== null) memberEntries = compilerMembers;
                }
                hasDirectivePrefix = result.hasDirectivePrefix;
            } else {
                memberEntries = nestedNamespaceContext
                    ? model.completeMembers(document.uri, position.line, position.character)
                    : namespaceImportContext ? null : model.completeMembers(document.uri, position.line, position.character);
                if (memberEntries !== null && !nestedNamespaceContext) {
                    const compilerMembers = await compilerTypedMemberEntries(workspaceIndex, document, position, token, maxCompletions);
                    if (compilerMembers !== null) memberEntries = compilerMembers;
                }
                if (nestedNamespaceContext && memberEntries !== null) {
                    memberEntries = memberEntries.filter((entry) => entry.declaration?.type === "namespace");
                }
                const currentLinePrefix = document.lineAt(position.line).text.slice(0, position.character);
                hasDirectivePrefix = /#\s*[A-Za-z_]*$/.test(currentLinePrefix);
                visible = memberEntries === null ? model.visibleEntries(document.uri, position.line, position.character, maxCompletions) : [];
            }
            if (memberEntries !== null && stockSidecarConstructorCompletionPotential(linePrefix) &&
                memberEntries.some((entry) => ["type", "class", "union"].includes(entry.declaration.type))) {
                visible = memberEntries;
                memberEntries = null;
            }
            if (memberEntries !== null && !preprocessorMacroNameContext) {
                const stockSidecarConstants = await stockSidecarCompletionConstantValues(
                    workspaceIndex, document, linePrefix, memberEntries, token
                );
                if (token?.isCancellationRequested) return [];
                const stockSidecarTypeFacts = await stockSidecarCompletionTypeFacts(
                    workspaceIndex, document, linePrefix, memberEntries, token
                );
                if (token?.isCancellationRequested) return [];
                const callSnippetEligibility = completionNameCallSnippetEligibility(memberEntries);
                for (const entry of memberEntries) {
                    const name = entry.name || entry.declaration.name;
                    addDeclarationCompletion(vscode, items, seenLabels,
                        declarationForCompletion(entry, name, stockSidecarConstants, stockSidecarTypeFacts), "0",
                        callSnippetEligibility.get(normalizeIdentifier(name)));
                }
                return items;
            }

            visible = visible.filter((entry) => namespaceImportContext
                ? entry.declaration.type === "namespace"
                : labelCompletionContext
                    ? entry.declaration.type === "label"
                    : entry.declaration.type !== "label");

            if (preprocessorMacroNameContext) {
                const qualifiedDefinedName = preprocessorDefinedNamePrefix?.includes(".") === true;
                const macros = qualifiedDefinedName
                    ? []
                    : visible.filter((entry) => entry.declaration?.type === "macro");
                for (const entry of macros) {
                    const name = entry.name || entry.declaration.name;
                    addDeclarationCompletion(vscode, items, seenLabels,
                        declarationForCompletion(entry, name), "0");
                }
                if (preprocessorDefinedNamePrefix !== null) {
                    const sourceModel = workspaceIndex.getSourceSemanticModel?.() ||
                        workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
                    const definedSymbolTypes = new Set([
                        "class", "const", "constructor", "destructor", "enum", "enumMember", "extern",
                        "field", "function", "namespace", "operator", "parameter", "property", "sub",
                        "type", "union", "variable"
                    ]);
                    const sourceEntries = (qualifiedDefinedName
                        ? sourceModel?.completeMembers?.(document.uri, position.line, position.character) || []
                        : sourceModel?.visibleEntries?.(document.uri, position.line, position.character, maxCompletions) || [])
                        .slice(0, maxCompletions);
                    for (const entry of sourceEntries) {
                        const declaration = entry.declaration || entry;
                        if (entry.conditional || declaration.provisional === true ||
                            !definedSymbolTypes.has(declaration.type) ||
                            !Number.isSafeInteger(declaration.line) || declaration.line >= position.line) continue;
                        const name = entry.name || declaration.name;
                        if (typeof name !== "string" || !name) continue;
                        addDeclarationCompletion(vscode, items, seenLabels, declarationForCompletion(entry, name), "0");
                    }
                }
                return items;
            }

            if (preprocessorExpressionContext) {
                addPreprocessorDefinedCompletion(vscode, items, seenLabels);
            }

            if (!model.remote && !labelCompletionContext && !namespaceImportContext &&
                workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true &&
                typeof workspaceIndex.getParsedDocument === "function") {
                const parsedDocument = workspaceIndex.getParsedDocument(document);
                const implicitVariables = await cachedStockSidecarOutlineImplicitVariables(
                    workspaceIndex.compilerAnalysis, document, parsedDocument.declarations, token
                );
                if (token?.isCancellationRequested) return [];
                const implicitVariableEntries = stockSidecarImplicitVariableCompletionEntries(
                    document,
                    parsedDocument.declarations,
                    implicitVariables,
                    position,
                    linePrefix.match(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/)?.[0] || ""
                );
                visible = [...implicitVariableEntries, ...visible].slice(0, maxCompletions);
            }

            const stockSidecarConstants = await stockSidecarCompletionConstantValues(
                workspaceIndex, document, linePrefix, visible, token
            );
            if (token?.isCancellationRequested) return [];
            const stockSidecarTypeFacts = await stockSidecarCompletionTypeFacts(
                workspaceIndex, document, linePrefix, visible, token
            );
            if (token?.isCancellationRequested) return [];

            const callSnippetEligibility = completionNameCallSnippetEligibility(visible);
            const sourceConstructorEntries = visible.length || memberEntries === null ||
                !stockSidecarConstructorCompletionPotential(linePrefix) ? visible : memberEntries;
            const constructorParameters = model.remote
                ? new Map(visible.filter((entry) => Array.isArray(entry.constructorCallParameters))
                    .map((entry) => [normalizeIdentifier(entry.name || entry.declaration.name), entry.constructorCallParameters]))
                : sourceConstructorEntries.length < maxCompletions
                    ? sourceConstructorCompletionParameters(model, document, position, sourceConstructorEntries, linePrefix)
                    : new Map();
            for (const [name, parameters] of constructorParameters) {
                callSnippetEligibility.set(name, { allowed: true, constructorType: true, parameters });
            }
            for (const entry of visible) {
                const name = entry.name || entry.declaration.name;
                addDeclarationCompletion(vscode, items, seenLabels,
                    declarationForCompletion(entry, name, stockSidecarConstants, stockSidecarTypeFacts), "0",
                    callSnippetEligibility.get(normalizeIdentifier(name)));
            }

            if (!labelCompletionContext && !namespaceImportContext) {
                const referenceImportContext = { document, position, workspaceIndex };
                addPreprocessorCompletions(
                    vscode,
                    items,
                    seenLabels,
                    grammarData.preprocessorDirectives,
                    hasDirectivePrefix
                );
                addWordCompletions(vscode, items, seenLabels, grammarData.operatorKeywords, vscode.CompletionItemKind.Operator, "FreeBASIC word operator");
                addWordCompletions(vscode, items, seenLabels, grammarData.keywords, vscode.CompletionItemKind.Keyword, "FreeBASIC keyword");
                addWordCompletions(vscode, items, seenLabels, grammarData.types, vscode.CompletionItemKind.TypeParameter, "FreeBASIC type");
                addWordCompletions(vscode, items, seenLabels, grammarData.libraryTypes, vscode.CompletionItemKind.Struct,
                    "FreeBASIC bundled API type", referenceImportContext);
                addWordCompletions(vscode, items, seenLabels, grammarData.typeModifiers, vscode.CompletionItemKind.Keyword, "FreeBASIC declaration modifier");
                addWordCompletions(vscode, items, seenLabels, grammarData.intrinsicFunctions, vscode.CompletionItemKind.Function, "FreeBASIC intrinsic");
                addWordCompletions(vscode, items, seenLabels, grammarData.runtimeFunctions, vscode.CompletionItemKind.Function, "FreeBASIC runtime");
                addWordCompletions(vscode, items, seenLabels, grammarData.graphicsFunctions, vscode.CompletionItemKind.Function, "FreeBASIC graphics runtime");
                addWordCompletions(vscode, items, seenLabels, grammarData.bundledFunctions, vscode.CompletionItemKind.Function,
                    "FreeBASIC bundled API", referenceImportContext);
                addWordCompletions(vscode, items, seenLabels, grammarData.constants, vscode.CompletionItemKind.Constant, "FreeBASIC language constant");
                addWordCompletions(vscode, items, seenLabels, grammarData.compilerDefines, vscode.CompletionItemKind.Constant, "FreeBASIC compiler define");
                addWordCompletions(vscode, items, seenLabels, grammarData.symbolicConstants, vscode.CompletionItemKind.Constant, "FreeBASIC constant");
            }

            return items;
        },
        resolveCompletionItem(item) {
            if (!item.documentation) {
                const markdown = getReferenceMarkdown(typeof item.label === "string" ? item.label : item.label.label);
                if (markdown) item.documentation = new vscode.MarkdownString(markdown);
            }
            return item;
        }
    };
}

async function includePathCompletionItems(vscode, document, position, token) {
    if (document.uri.scheme !== "file" || !/\.(?:bas|bi)$/i.test(document.uri.fsPath)) return null;
    const version = document.version;
    const line = document.lineAt(position.line).text;
    const prefix = line.slice(0, position.character);
    const directive = /^(\s*#\s*include\s+(?:once\s+)?)(["<])([^">]*)$/i.exec(prefix);
    if (!directive) return null;
    if (getCodeContext(document.getText(), document.offsetAt(position)) === "comment") return [];

    const content = directive[3];
    if (content.length > MAX_INCLUDE_COMPLETION_PATH_LENGTH || content.includes("\0") ||
        path.isAbsolute(content) || /^[\\/]{1,2}/.test(content) || /^[A-Za-z]:[\\/]/.test(content)) return [];

    const separator = Math.max(content.lastIndexOf("/"), content.lastIndexOf("\\"));
    const directoryPrefix = content.slice(0, separator + 1);
    const filePrefix = content.slice(separator + 1);
    const fileSuffix = line.slice(position.character).match(/^[^"<>/\\]*/)?.[0] || "";
    if (/^[\\/]/.test(line.slice(position.character)) || filePrefix.length + fileSuffix.length > MAX_INCLUDE_COMPLETION_PATH_LENGTH) return [];
    const directories = getIncludeDirectories(vscode, document.uri);
    if (directories.length > MAX_INCLUDE_COMPLETION_DIRECTORIES) return [];

    const contentStart = directive[1].length + 1;
    const replaceStart = contentStart + separator + 1;
    const contentEnd = position.character + fileSuffix.length;
    const closingDelimiter = line[contentEnd];
    const hasClosingDelimiter = closingDelimiter === '"' || closingDelimiter === ">";
    const delimiterEdits = [];
    /* FBC's ppInclude accepts a string literal, not a C-style <...> operand.
       Keep the filename edit separate so filtering and nested paths still use
       the text under the caret. VS Code applies these disjoint edits together. */
    if (directive[2] === "<") {
        delimiterEdits.push(vscode.TextEdit.replace(new vscode.Range(position.line, contentStart - 1,
            position.line, contentStart), '"'));
    }
    if (closingDelimiter === ">") {
        delimiterEdits.push(vscode.TextEdit.replace(new vscode.Range(position.line, contentEnd,
            position.line, contentEnd + 1), '"'));
    }
    const isCaseSensitive = process.platform !== "win32";
    const prefixKey = isCaseSensitive ? filePrefix : filePrefix.toLowerCase();
    const suffixKey = isCaseSensitive ? fileSuffix : fileSuffix.toLowerCase();
    const items = new Map();
    let scannedEntries = 0;

    for (const baseDirectory of directories) {
        if (token?.isCancellationRequested) return [];
        const relativeDirectory = directoryPrefix.replace(/[\\/]+/g, path.sep) || ".";
        const targetDirectory = path.resolve(baseDirectory, relativeDirectory);
        let directory;
        try {
            directory = await fs.promises.opendir(targetDirectory);
        } catch {
            continue;
        }

        try {
            for await (const entry of directory) {
                if (token?.isCancellationRequested) return [];
                scannedEntries++;
                if (scannedEntries > MAX_INCLUDE_COMPLETION_ENTRIES) break;
                if (/["\r\n\\]/.test(entry.name)) continue;
                const entryKey = isCaseSensitive ? entry.name : entry.name.toLowerCase();
                if (!entryKey.startsWith(prefixKey)) continue;

                let isFile = entry.isFile();
                let isDirectory = entry.isDirectory();
                if (!isFile && entry.isSymbolicLink()) {
                    try {
                        const metadata = await fs.promises.stat(path.join(targetDirectory, entry.name));
                        isFile = metadata.isFile();
                        isDirectory = metadata.isDirectory();
                    } catch { /* A dangling include link is not completable. */ }
                }
                if (isDirectory && !fileSuffix) {
                    const includePath = `${directoryPrefix}${entry.name}/`;
                    const key = isCaseSensitive ? includePath : includePath.toLowerCase();
                    if (!items.has(key)) {
                        const item = new vscode.CompletionItem(includePath, vscode.CompletionItemKind.Folder);
                        item.detail = "FreeBASIC include folder";
                        item.filterText = includePath;
                        item.insertText = `${entry.name}/`;
                        item.range = new vscode.Range(position.line, replaceStart, position.line, position.character);
                        if (delimiterEdits.length) item.additionalTextEdits = delimiterEdits;
                        item.sortText = includePath.toLowerCase();
                        item.command = { title: "Continue include path completion", command: "editor.action.triggerSuggest" };
                        items.set(key, item);
                    }
                    if (items.size >= MAX_INCLUDE_COMPLETION_ITEMS) break;
                }
                if (!isFile || !/\.bi$/i.test(entry.name) || !entryKey.endsWith(suffixKey)) continue;

                const includePath = `${directoryPrefix}${entry.name}`;
                const key = isCaseSensitive ? includePath : includePath.toLowerCase();
                if (items.has(key)) continue;
                const item = new vscode.CompletionItem(includePath, vscode.CompletionItemKind.File);
                item.detail = "FreeBASIC include file";
                item.filterText = includePath;
                item.insertText = entry.name + (hasClosingDelimiter ? "" : '"');
                item.range = new vscode.Range(position.line, replaceStart, position.line, position.character + fileSuffix.length);
                if (delimiterEdits.length) item.additionalTextEdits = delimiterEdits;
                item.sortText = includePath.toLowerCase();
                items.set(key, item);
                if (items.size >= MAX_INCLUDE_COMPLETION_ITEMS) break;
            }
        } catch { /* A directory may become unreadable while completions are gathered. */ }
        if (scannedEntries > MAX_INCLUDE_COMPLETION_ENTRIES || items.size >= MAX_INCLUDE_COMPLETION_ITEMS) break;
    }

    return document.version === version
        ? [...items.values()].sort((first, second) => String(first.label).localeCompare(String(second.label)))
        : [];
}

async function compilerTypedMemberEntries(workspaceIndex, document, position, token, maximum = 2000) {
    const receiverPosition = memberReceiverPosition(document, position);
    if (!receiverPosition || token?.isCancellationRequested) return null;

    const compilerModel = await workspaceIndex.compilerAnalysis?.getModelForEditor?.(document, token, true);
    if (!compilerModel?.semanticSidecarOnly || token?.isCancellationRequested) return null;
    const sourceModel = workspaceIndex.getSemanticModel(document.uri, { allowSidecarOnly: false });
    if (!sourceModel) return null;
    const sourceMembers = () => {
        const sourceDocument = sourceModel.getDocument(document.uri);
        const receiverToken = sourceDocument?.tokens.find((candidate) => candidate.line === receiverPosition.line &&
            candidate.startColumn <= receiverPosition.character && candidate.endColumn > receiverPosition.character);
        let receivers = sourceDocument && receiverToken
            ? sourceModel.resolveReceiver(sourceDocument, receiverToken, 0)
            : [];
        if (sourceDocument && !receivers.length) {
            /* A WITH member prefix has no explicit receiver token on its line. */
            const lineStart = sourceDocument.lineOffsets[position.line];
            if (Number.isSafeInteger(lineStart)) {
                receivers = sourceModel.resolveWithReceiver(
                    sourceDocument,
                    scopeAt(sourceDocument, lineStart + position.character),
                    0
                );
            }
        }
        if (receivers.length !== 1 || receivers[0].conditional || receivers[0].provisional ||
            receivers[0].declaration?.provisional) return null;
        const receiverTypes = sourceModel.typeEntries(receivers[0]);
        if (receiverTypes.length !== 1 || receiverTypes[0].conditional || receiverTypes[0].provisional ||
            receiverTypes[0].declaration?.provisional) return null;
        const members = sourceModel.completeMembers(document.uri, position.line, position.character);
        if (!Array.isArray(members) || !members.length ||
            members.some((entry) => entry.conditional || entry.provisional || entry.declaration?.provisional)) return null;
        return members.slice(0, maximum);
    };
    const expression = compilerModel.remote
        ? await compilerModel.expressionAt(document.uri, receiverPosition, receiverPosition, token)
        : compilerModel.expressionAtCompilerSidecarOnly?.(document.uri, receiverPosition);
    if (token?.isCancellationRequested) return null;
    if (expression?.provisional) return sourceMembers();

    const candidates = typeof expression?.typeName === "string"
        ? sourceModel.findVisibleTypeEntries(document.uri, expression.typeName)
        : [];
    const typeEntry = candidates.length ? sourceModel.findUniqueVisibleType(document.uri, expression.typeName) : null;
    const source = sourceModel.getDocument(document.uri);
    if (!source) return [];
    if (typeEntry) {
        const members = sourceModel.members([typeEntry], source, scopeAt(source, document.offsetAt(position)));
        if (!members.some((entry) => entry.conditional || entry.provisional || entry.declaration?.provisional)) return members.slice(0, maximum);
    } else {
        /* An enclosing scalar expression can mask the receiver's own type. */
        const fallback = sourceMembers();
        if (fallback) return fallback;
    }
    return compilerBoundMemberEntries(workspaceIndex, document, position, receiverPosition, sourceModel, compilerModel, token, maximum);
}

async function compilerBoundMemberEntries(workspaceIndex, document, position, receiverPosition, sourceModel, model, token, maximum) {
    if (!model.remote || typeof model.query !== "function" || model.partial || token?.isCancellationRequested) return [];
    const version = document.version;
    const source = sourceModel.getDocument(document.uri);
    if (!source || source.text !== document.getText()) return [];
    if (!model.semanticBindingsAvailable) {
        model = await compilerEditorModel(workspaceIndex, document, token, true, true);
    }
    if (!model?.remote || !model.semanticSidecarOnly || !model.semanticBindingsAvailable || model.partial ||
        token?.isCancellationRequested || document.version !== version) return [];
    const types = await model.query("compilerSidecarReceiverTypeHierarchy", document.uri, { position: receiverPosition }, token);
    const snapshot = workspaceIndex.compilerAnalysis.snapshotFor?.(document.uri);
    if (!Array.isArray(types) || !types.length || snapshot?.model !== model ||
        token?.isCancellationRequested || document.version !== version) return [];
    const capturedSources = new Map(snapshot.sources.map((entry) => [entry.uri.toString(), entry.text]));
    const scope = scopeAt(source, document.offsetAt(position));
    const typeKey = (entry) => JSON.stringify([entry.uri.toString(), entry.declaration.type, entry.declaration.line,
        entry.declaration.startColumn, entry.declaration.endColumn]);
    const requestedTypes = new Set(types.map(typeKey)), sourceTypes = new Map();
    for (const entry of sourceModel.entries) {
        if (!["type", "class", "union"].includes(entry.declaration.type)) continue;
        const key = typeKey(entry);
        if (requestedTypes.has(key)) sourceTypes.set(key, [...(sourceTypes.get(key) || []), entry]);
    }
    const selected = [], hidden = new Set();
    let candidateCount = 0;
    for (const type of types) {
        const matches = sourceTypes.get(typeKey(type)) || [];
        if (matches.length !== 1 || matches[0].provisional || matches[0].declaration.provisional) return [];
        const owner = matches[0];
        if (capturedSources.get(owner.uri.toString()) !== owner.document.text) return [];
        /* FBC supplied the base chain. Gather only each type's own members,
           including private names that can hide public names in a base. */
        const members = sourceModel.members([owner], source, owner.bodyScope, 0, false);
        candidateCount += members.length;
        if (candidateCount > MAX_STOCK_SIDECAR_MEMBER_DECLARATIONS) return [];
        const ownNames = new Set();
        for (let offset = 0; offset < members.length; offset += MAX_STOCK_SIDECAR_COMPLETION_FACT_SITES) {
            const batch = members.slice(offset, offset + MAX_STOCK_SIDECAR_COMPLETION_FACT_SITES);
            if (batch.some((entry) => capturedSources.get(entry.uri.toString()) !== entry.document.text)) return [];
            const sites = batch.map((entry, index) => ({ index, filePath: entry.uri.fsPath,
                line: entry.declaration.line, startColumn: entry.declaration.startColumn, endColumn: entry.declaration.endColumn }));
            const facts = await model.query("compilerSidecarOutlineFactsAtSites", document.uri, { sites }, token);
            if (!Array.isArray(facts) || token?.isCancellationRequested || document.version !== version) return [];
            for (const fact of facts) {
                if (!Number.isSafeInteger(fact.index) || fact.index < 0 || fact.index >= batch.length || !fact.compilerFacts) continue;
                const entry = batch[fact.index];
                ownNames.add(entry.key);
                const access = fact.compilerFacts.compilerVisibility || entry.access;
                if (hidden.has(entry.key) || !sourceModel.canAccess({ ...entry, access }, scope)) continue;
                selected.push({ ...entry, conditional: false, compilerFacts: fact.compilerFacts,
                    declaration: { ...entry.declaration, compilerFacts: fact.compilerFacts } });
            }
        }
        for (const name of ownNames) hidden.add(name);
    }
    return document.version === version && workspaceIndex.compilerAnalysis.getModel(document.uri) === model &&
        !token?.isCancellationRequested ? selected.slice(0, maximum) : [];
}

function memberReceiverPosition(document, position) {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const member = /(?:\.|->)\s*[A-Za-z_0-9]*[$%!#&]?$/.exec(linePrefix);
    if (!member) return null;

    const text = document.getText();
    let offset = document.offsetAt(position) - member[0].length;
    while (offset > 0 && /\s/.test(text[offset - 1])) offset--;
    return offset > 0 ? document.positionAt(offset - 1) : null;
}

async function missingIncludePathCodeAction(vscode, workspaceIndex, document, diagnostic, token) {
    const missingPath = diagnostic.message.match(/File not found[^\r\n]*?["'`]([^"'`]+?\.bi)["'`]/i)?.[1];
    if (!missingPath || token?.isCancellationRequested) return null;

    const include = workspaceIndex.getParsedDocument(document).includes.find((candidate) =>
        candidate.line === diagnostic.range.start.line &&
        path.basename(candidate.path).toLowerCase() === path.basename(missingPath).toLowerCase()
    );
    if (!include || !await workspaceIndex.ensureInitialized(token) || token?.isCancellationRequested || workspaceIndex.isIncomplete()) return null;

    const baseName = path.basename(include.path).toLowerCase();
    const candidates = new Map();
    for (const entry of workspaceIndex.documents.values()) {
        const candidatePath = entry.uri.fsPath;
        if (!candidatePath || !/\.bi$/i.test(candidatePath) ||
            path.basename(candidatePath).toLowerCase() !== baseName ||
            path.resolve(candidatePath) === path.resolve(document.uri.fsPath)) continue;
        candidates.set(path.resolve(candidatePath), candidatePath);
    }
    const includeDirectories = getIncludeDirectories(vscode, document.uri, include.system);
    if (includeDirectories.length > 256) return null;
    for (const includeDirectory of includeDirectories) {
        if (token?.isCancellationRequested) return null;
        const candidatePath = path.resolve(includeDirectory, path.basename(include.path));
        if (/\.bi$/i.test(candidatePath) && path.resolve(candidatePath) !== path.resolve(document.uri.fsPath)) {
            try {
                if (fs.statSync(candidatePath).isFile()) candidates.set(path.resolve(candidatePath), candidatePath);
            } catch { /* The configured search path does not contain this header. */ }
        }
    }
    if (candidates.size !== 1) return null;

    const candidatePath = candidates.values().next().value;
    const relativePath = path.relative(path.dirname(document.uri.fsPath), candidatePath).replace(/\\/g, "/");
    if (!relativePath || /[\r\n"]/g.test(relativePath)) return null;

    const action = new vscode.CodeAction(`Correct include path to "${relativePath}"`, vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, new vscode.Range(
        include.line, include.startColumn, include.line, include.endColumn
    ), relativePath);
    return action;
}

function createMissingHeaderCodeActionProvider(vscode, workspaceIndex, libraryTypes = []) {
    const libraryTypeNames = new Set(libraryTypes.map(normalizeIdentifier));
    return {
        async provideCodeActions(document, range, context, token) {
            if (token?.isCancellationRequested) return [];
            context = { ...context, diagnostics: (context.diagnostics || [])
                .filter((diagnostic) => diagnostic.code !== COMPILER_MESSAGE_CODE) };
            const documentVersion = document.version;
            const text = document.getText();
            const actions = new Map();
            const bracketDiagnostics = (context.diagnostics || []).filter((diagnostic) => diagnostic.source === "FreeBASIC brackets");
            if (bracketDiagnostics.length) {
                let ignoredRanges = [];
                const model = workspaceIndex.compilerAnalysis?.getModel(document.uri);
                if (model?.remote) {
                    ignoredRanges = await model.query("compilerInactiveSourceRanges", document.uri, {}, token);
                    if (!Array.isArray(ignoredRanges)) return [];
                } else if (model) {
                    ignoredRanges = model.compilerInactiveSourceRanges(document.uri);
                }
                if (token?.isCancellationRequested || document.version !== documentVersion) return [];
                const problems = findBracketProblems(text, ignoredRanges);
                for (const diagnostic of bracketDiagnostics) {
                    const offset = document.offsetAt(diagnostic.range.start);
                    const problem = problems.find((candidate) => candidate.start === offset && candidate.code === diagnostic.code);
                    if (!problem) continue;
                    if (problem.code === "unclosed-bracket" && problem.expectedClosings) {
                        const action = new vscode.CodeAction("", vscode.CodeActionKind.QuickFix);
                        action.diagnostics = [diagnostic];
                        action.isPreferred = true;
                        action.edit = new vscode.WorkspaceEdit();
                        action.title = `Insert '${problem.expectedClosings}' to balance this bracket`;
                        const insertionOffset = Math.max(0, Math.min(text.length, problem.fixOffset));
                        const prefix = insertionOffset === text.length && text.length > 0 && !/[\r\n]$/.test(text) ? "\n" : "";
                        action.edit.insert(document.uri, document.positionAt(insertionOffset), `${prefix}${problem.expectedClosings}`);
                        actions.set(`bracket:${problem.start}:${problem.code}`, action);
                        continue;
                    } else if (problem.code === "unexpected-closing-bracket") {
                        const problemRange = new vscode.Range(
                            document.positionAt(problem.start),
                            document.positionAt(problem.end)
                        );
                        const found = text.slice(problem.start, problem.end);
                        if (problem.replacementClosing) {
                            const replaceAction = new vscode.CodeAction(
                                `Replace '${found}' with '${problem.replacementClosing}' to balance this bracket`,
                                vscode.CodeActionKind.QuickFix
                            );
                            replaceAction.diagnostics = [diagnostic];
                            replaceAction.isPreferred = true;
                            replaceAction.edit = new vscode.WorkspaceEdit();
                            replaceAction.edit.replace(document.uri, problemRange, problem.replacementClosing);
                            actions.set(`bracket:${problem.start}:${problem.code}:replace`, replaceAction);
                        }
                        const removeAction = new vscode.CodeAction(
                            `Remove unmatched '${found}'`, vscode.CodeActionKind.QuickFix
                        );
                        removeAction.diagnostics = [diagnostic];
                        removeAction.edit = new vscode.WorkspaceEdit();
                        removeAction.edit.delete(document.uri, problemRange);
                        actions.set(`bracket:${problem.start}:${problem.code}:remove`, removeAction);
                        continue;
                    } else {
                        continue;
                    }
                }
            }

            if (document.uri.scheme !== "file" || !/\.(?:bas|bi)$/i.test(document.uri.fsPath)) {
                return document.version === documentVersion ? [...actions.values()] : [];
            }

            const procedureActions = await compilerProcedureRefactorActions(
                vscode, workspaceIndex, document, range, token, context?.diagnostics || []
            );
            for (const action of procedureActions) actions.set(`procedure-refactor:${range.start.line}:${action.title}`, action);
            if (token?.isCancellationRequested || document.version !== documentVersion) return [];
            const enumValueActions = await compilerEnumValueRefactorActions(
                vscode, workspaceIndex, document, range, token
            );
            for (const action of enumValueActions) {
                actions.set("enum-value-refactor:" + range.start.line + ":" + action.title, action);
            }
            if (token?.isCancellationRequested || document.version !== documentVersion) return [];
            const declarationActions = await compilerImplicitDeclarationTypeRefactorActions(
                vscode, workspaceIndex, document, range, token
            );
            let implicitAllocationActions = compilerImplicitAllocationQuickFixActions(
                vscode, document, declarationActions, context?.diagnostics || [], range
            );
            if (!implicitAllocationActions.some((action) => action.kind === vscode.CodeActionKind.QuickFix &&
                action.title.startsWith("Declare implicit"))) {
                const recoveredQuickFixes = await compilerImplicitAllocationWarningQuickFixActions(
                    vscode, workspaceIndex, document, context?.diagnostics || [], token
                );
                implicitAllocationActions = [...implicitAllocationActions, ...recoveredQuickFixes];
            }
            for (const action of implicitAllocationActions) actions.set(`declaration-refactor:${range.start.line}:${action.title}`, action);
            if (token?.isCancellationRequested || document.version !== documentVersion) return [];

            const undeclaredName = /(?:(?:variable|symbol)\s+not\s+declared|type\s+not\s+defined)\s*[, :]\s*`?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*[$%!#&]?)`?/i;
            const rejectedImplicitName = /^Implicit variables are only valid in -lang deprecated or fblite or qb, found '([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*[$%!#&]?)'(?:$|\r?\n)/i;
            const expectedTypeName = /expected identifier,\s*found\s+['"`]?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*[$%!#&]?)['"`]?/i;

            for (const diagnostic of context.diagnostics || []) {
                if (diagnostic.source === "FreeBASIC brackets") continue;
                if (!/^fbc(?:\s|$)/i.test(diagnostic.source || "")) continue;
                const possibleEscapeAction = possibleEscapeStringCodeAction(vscode, document, text, diagnostic);
                if (possibleEscapeAction) {
                    actions.set(`possible-escape:${possibleEscapeAction.title}`, possibleEscapeAction);
                    continue;
                }
                const missingQuoteAction = missingClosingQuoteCodeAction(vscode, document, text, diagnostic);
                if (missingQuoteAction) {
                    actions.set(`missing-quote:${missingQuoteAction.title}`, missingQuoteAction);
                    continue;
                }
                const redundantNextAction = meaninglessNextVariableCodeAction(
                    vscode, document, text, diagnostic, context.diagnostics || []
                );
                if (redundantNextAction) {
                    actions.set(`next-redundant:${redundantNextAction.title}`, redundantNextAction);
                    continue;
                }
                const redundantAnyInitializerAction = redundantNewAnyInitializerCodeAction(
                    vscode, document, text, diagnostic
                );
                if (redundantAnyInitializerAction) {
                    actions.set(`new-any-initializer:${redundantAnyInitializerAction.title}`, redundantAnyInitializerAction);
                    continue;
                }
                const ignoredSuffixAction = ignoredDeclarationSuffixCodeAction(vscode, document, text, diagnostic);
                if (ignoredSuffixAction) {
                    actions.set(`ignored-suffix:${ignoredSuffixAction.title}`, ignoredSuffixAction);
                    continue;
                }
                const byRefAssignmentAction = byRefFunctionResultAssignmentCodeAction(
                    vscode, document, text, diagnostic
                );
                if (byRefAssignmentAction) {
                    actions.set(`byref-result:${byRefAssignmentAction.title}`, byRefAssignmentAction);
                    continue;
                }
                const elseIfAction = elseIfBranchCodeAction(vscode, document, diagnostic);
                if (elseIfAction) {
                    actions.set(`else-if:${elseIfAction.title}`, elseIfAction);
                    continue;
                }
                const forCounterAction = forCounterWrapWarningCodeAction(vscode, workspaceIndex, document, diagnostic);
                if (forCounterAction) {
                    actions.set(`for-counter-wrap:${forCounterAction.title}`, forCounterAction);
                    continue;
                }
                const constantOverflowAction = constantConversionOverflowCodeAction(
                    vscode, document, text, diagnostic
                );
                if (constantOverflowAction) {
                    actions.set(`constant-overflow:${constantOverflowAction.title}`, constantOverflowAction);
                    continue;
                }
                const byRefAddressAction = byRefAddressWarningCodeAction(
                    vscode, workspaceIndex, document, diagnostic, context.diagnostics || []
                );
                if (byRefAddressAction) {
                    actions.set(`byref-address:${byRefAddressAction.title}`, byRefAddressAction);
                    continue;
                }
                const fileTransferPointerAction = fileTransferPointerCodeAction(
                    vscode, workspaceIndex, document, diagnostic
                );
                if (fileTransferPointerAction) {
                    actions.set(`file-pointer:${diagnostic.range.start.line}:${fileTransferPointerAction.title}`,
                        fileTransferPointerAction);
                    continue;
                }
                const parameterDefaultAction = await procedureParameterDefaultMismatchCodeAction(
                    vscode, workspaceIndex, document, diagnostic, token
                );
                if (parameterDefaultAction) {
                    actions.set(`parameter-default:${parameterDefaultAction.title}`, parameterDefaultAction);
                    continue;
                }
                if (diagnostic.severity !== vscode.DiagnosticSeverity.Error) continue;
                const nextCounterAction = mismatchedNextCounterCodeAction(vscode, document, text, diagnostic);
                if (nextCounterAction) {
                    actions.set(`next-counter:${nextCounterAction.title}`, nextCounterAction);
                    const line = diagnostic.range?.start?.line;
                    const identifier = forNextCounterIdentifierRange(text, line);
                    const expectedCounter = identifier && activeForCounterBeforeLine(text, line);
                    if (identifier && expectedCounter &&
                        identifierEditDistanceAtMostOne(identifier.name, expectedCounter) === 1) {
                        const correction = await undeclaredNameTypoCodeAction(
                            vscode, workspaceIndex, document, diagnostic, identifier.name, false, libraryTypeNames, token,
                            expectedCounter
                        );
                        if (correction) actions.set(`next-counter-correction:${correction.title}`, correction);
                    }
                    continue;
                }
                const nextMismatchContext = compilerDiagnosticContextLabel("for-next-variable-mismatch");
                const nextBindingContext = compilerDiagnosticContextLabel("for-next-counter-binding");
                const nextMessage = String(diagnostic.message || "");
                if ((nextMismatchContext && nextMessage.includes(`Compiler context: ${nextMismatchContext}`)) ||
                    (nextBindingContext && nextMessage.includes(`Compiler context: ${nextBindingContext}`))) {
                    const correction = await mismatchedNextCounterTypoCodeAction(
                        vscode, workspaceIndex, document, text, diagnostic, libraryTypeNames, token
                    );
                    if (correction) actions.set(`next-counter-correction:${correction.title}`, correction);
                    continue;
                }
                const duplicateVariableAction = duplicateCaseVariableCodeAction(vscode, document, text, diagnostic);
                if (duplicateVariableAction) {
                    actions.set(`case-duplicate:${duplicateVariableAction.title}`, duplicateVariableAction);
                    continue;
                }
                const suffixConflictAction = declarationSuffixConflictCodeAction(vscode, document, text, diagnostic);
                if (suffixConflictAction) {
                    actions.set(`suffix-conflict:${suffixConflictAction.title}`, suffixConflictAction);
                    continue;
                }
                const terminatorAction = unclosedBlockTerminatorCodeAction(vscode, document, text, diagnostic);
                if (terminatorAction) {
                    actions.set(`terminator:${terminatorAction.title}`, terminatorAction);
                    continue;
                }
                const unsupportedErrorResumeNextAction = unsupportedErrorResumeNextCodeAction(
                    vscode, document, text, diagnostic
                );
                if (unsupportedErrorResumeNextAction) {
                    actions.set(`unsupported-syntax:${unsupportedErrorResumeNextAction.title}`, unsupportedErrorResumeNextAction);
                    continue;
                }
                const includePathAction = await missingIncludePathCodeAction(vscode, workspaceIndex, document, diagnostic, token);
                if (includePathAction) {
                    actions.set(`include-path:${diagnostic.range.start.line}:${includePathAction.title}`, includePathAction);
                    continue;
                }
                /* Current FBC rejects an unresolved value as an illegal
                   implicit declaration before reporting an undeclared name. */
                const implicitName = Number(diagnostic.code) === 149
                    ? diagnostic.message.match(rejectedImplicitName)?.[1] : null;
                let name = diagnostic.message.match(undeclaredName)?.[1] || implicitName;
                if (!name) {
                    const typeName = diagnostic.message.match(expectedTypeName)?.[1];
                    if (!typeName) continue;
                    const lineText = document.lineAt(diagnostic.range.start.line).text;
                    if (!new RegExp(`\\bAS\\s+${escapeRegularExpression(typeName)}\\b`, "i").test(lineText)) continue;
                    name = typeName;
                }
                if (!name) continue;
                const typeName = /type\s+not\s+defined/i.test(diagnostic.message) || expectedTypeName.test(diagnostic.message);

                const candidates = new Map();
                for (const entry of getReferenceEntries(name)) {
                    const header = entry.header;
                    const namespace = entry.namespace || "";
                    if (typeof header !== "string" || !/^[A-Za-z0-9_.-]+\.bi$/i.test(header) || header.includes("..") ||
                        namespace && !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(namespace)) continue;
                    candidates.set(`${header.toLowerCase()}\t${namespace.toLowerCase()}`, { header, namespace });
                }
                if (candidates.size !== 1) {
                    if (!candidates.size && (/(?:variable|symbol)\s+not\s+declared/i.test(diagnostic.message) || typeName || implicitName)) {
                        const action = await undeclaredNameTypoCodeAction(vscode, workspaceIndex, document, diagnostic, name, typeName, libraryTypeNames, token);
                        if (action) actions.set(`typo:${diagnostic.range.start.line}:${name.toLowerCase()}`, action);
                    }
                    continue;
                }

                const candidate = candidates.values().next().value;
                const headerLine = includedHeaderLine(document, candidate.header, diagnostic.range.start.line);
                const usingLine = candidate.namespace
                    ? usingNamespaceLine(document, candidate.namespace, diagnostic.range.start.line)
                    : -1;
                if (headerLine >= 0 && (!candidate.namespace || usingLine >= 0)) continue;
                const statements = [];
                if (headerLine < 0) statements.push(`#include once "${candidate.header}"`);
                if (candidate.namespace && usingLine < 0) statements.push(`Using ${candidate.namespace}`);
                if (!statements.length) continue;

                const insertAt = headerLine >= 0
                    ? includeInsertionAfterLine(vscode, document, headerLine)
                    : includeInsertionPosition(vscode, document, text);
                const action = new vscode.CodeAction(
                    `Add ${statements.join(" and ")} for ${name}`,
                    vscode.CodeActionKind.QuickFix
                );
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                action.edit = new vscode.WorkspaceEdit();
                action.edit.insert(document.uri, insertAt.position, `${insertAt.prefix}${statements.join("\n")}\n`);
                actions.set(`${candidate.header.toLowerCase()}:${candidate.namespace.toLowerCase()}`, action);
            }

            return document.version === documentVersion ? [...actions.values()] : [];
        }
    };
}

async function compilerProcedureRefactorActions(vscode, workspaceIndex, document, range, token, diagnostics = []) {
    const actions = [];
    const line = range?.start?.line;
    if (!Number.isSafeInteger(line) || line < 0 || token?.isCancellationRequested) return actions;
    const lineText = document.lineAt(line).text;
    if (!/\b(?:sub|function|property|operator|constructor|destructor)\b/i.test(lineText)) {
        const parsed = workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(document.getText());
        const parameter = (parsed.declarations || []).find((declaration) =>
            declaration.type === "parameter" && declaration.line === line &&
            range.start.character >= declaration.startColumn && range.start.character < declaration.endColumn
        );
        const procedure = parameter?.parentDeclaration;
        if (parameter && procedure && Number.isSafeInteger(procedure.signatureEndLine) &&
            procedure.signatureEndLine > procedure.line && line <= procedure.signatureEndLine) {
            return continuedProcedureParameterRefactorActions(
                vscode, workspaceIndex, document, range, token, parsed, parameter, diagnostics
            );
        }
        return actions;
    }
    if (lineText.includes(":") || /["']|\bREM\b/i.test(lineText)) return actions;
    const declarationName = lineText.match(/\b(?:sub|function|property|operator)\s+([A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\.[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*)/i);
    if (!declarationName) return actions;
    const nameStart = lineText.indexOf(declarationName[1], declarationName.index);
    const position = { line, character: nameStart };
    const name = getQualifiedSymbolAtPosition(vscode, document, position);
    if (!name) return actions;
    const parsedDocument = workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(document.getText());
    const parsedHeader = (parsedDocument.declarations || []).find((candidate) =>
        ["function", "sub", "property", "operator", "constructor", "destructor"].includes(candidate.type) &&
        candidate.line === line && candidate.startColumn === name.range.start.character &&
        candidate.endColumn === name.range.end.character &&
        normalizeIdentifier(candidate.name) === normalizeIdentifier(name.name)
    );
    const headerContinues = Boolean(parsedHeader && Number.isSafeInteger(parsedHeader.signatureEndLine) &&
        parsedHeader.signatureEndLine > line);
    if (/(?:^|\s)_\s*$/.test(lineText) && !headerContinues) return actions;

    const model = await editorModel(workspaceIndex, document, token, false, true);
    if (token?.isCancellationRequested || !model?.remote) return actions;
    const cursorSymbol = getQualifiedSymbolAtPosition(vscode, document, range.start);
    const parameterOpen = lineText.indexOf("(", name.range.end.character);
    const parameterClose = lineText.lastIndexOf(")");
    if (cursorSymbol && cursorSymbol.range.start.character !== name.range.start.character &&
        parameterOpen >= 0 && range.start.character > parameterOpen && range.start.character < parameterClose) {
        const parameterResult = await model.query("hover", document.uri, { position: range.start }, token);
        if (token?.isCancellationRequested) return actions;
        const parameterCandidates = (parameterResult?.entries || []).filter((entry) =>
            entry.declaration?.type === "parameter" && entry.declaration.line === line &&
            compilerParameterTokenMatches(entry, cursorSymbol, lineText)
        );
        let parameterEntry = parameterCandidates.length === 1 ? parameterCandidates[0] : null;
        if (!parameterEntry && parameterCandidates.length === 0 && model.semanticSidecarOnly === true) {
            const binding = parameterResult?.compilerParameterDeclarationRange;
            const parameterFacts = parameterResult?.compilerParameterFacts;
            const parsedDeclarations = workspaceIndex.getParsedDocument?.(document)?.declarations || [];
            const declaration = binding && parsedDeclarations.find((item) =>
                item.type === "parameter" && item.line === line &&
                item.startColumn === binding.startColumn && item.endColumn === binding.endColumn &&
                compilerParameterTokenMatches({ name: item.name, declaration: item }, cursorSymbol, lineText)
            );
            if (!declaration || !parameterFacts || binding.line !== line ||
                binding.startColumn !== cursorSymbol.range.start.character ||
                binding.endColumn !== cursorSymbol.range.end.character) return actions;
            parameterEntry = { name: declaration.name, declaration, compilerFacts: parameterFacts };
        }
        if (!parameterEntry) return actions;
        const parameterActions = parameterRefactorActions(
            vscode, document, parameterEntry, line, lineText
        );
        const visibleParameterActions = model.semanticSidecarOnly === true
            ? parameterActions.filter((action) =>
                action.title.startsWith("Make parameter passing mode explicit as '") ||
                action.title.startsWith("Add explicit parameter type '") ||
                action.title.startsWith("Replace parameter type suffix with 'As "))
            : parameterActions;
        return compilerParameterModeQuickFixActions(vscode, visibleParameterActions, diagnostics, line, parameterEntry);
    }
    const result = await model.query("hover", document.uri, { position }, token);
    if (token?.isCancellationRequested || !Array.isArray(result?.entries) ||
        !name.range || document.version === undefined) return actions;
    const candidates = result.entries.filter((entry) => {
        const declaration = entry.declaration;
        return declaration && declaration.provisional !== true && declaration.line === position.line &&
            compilerParameterTokenMatches(entry, name, lineText);
    });
    let entry = null;
    if (candidates.length === 1) {
        entry = candidates[0];
    } else if (candidates.length === 0 && model.semanticSidecarOnly === true) {
        const binding = result.compilerProcedureDeclarationRange;
        const abiFacts = result.compilerProcedureFacts;
        const visibilityFacts = result.compilerProcedureVisibilityFacts;
        const storageFacts = result.compilerStorageTypeFacts;
        const procedureFacts = abiFacts || visibilityFacts || storageFacts
            ? {
                ...(abiFacts || {}),
                ...(visibilityFacts || {}),
                ...(storageFacts || {}),
                properties: [...(abiFacts?.properties || []), ...(visibilityFacts?.properties || []),
                    ...(storageFacts?.properties || [])]
            }
            : null;
        const parsedDeclarations = workspaceIndex.getParsedDocument?.(document)?.declarations || [];
        const declaration = binding && parsedDeclarations.find((item) =>
            ["function", "sub"].includes(item.type) && item.line === position.line &&
            item.startColumn === binding.startColumn && item.endColumn === binding.endColumn &&
            normalizeIdentifier(item.name) === normalizeIdentifier(name.name)
        );
        const sourceName = binding && Number.isSafeInteger(binding.startColumn) && Number.isSafeInteger(binding.endColumn)
            ? lineText.slice(binding.startColumn, binding.endColumn) : "";
        if (!declaration || (!abiFacts && !visibilityFacts) || binding.line !== position.line ||
            binding.startColumn !== name.range.start.character || binding.endColumn !== name.range.end.character ||
            normalizeIdentifier(sourceName) !== normalizeIdentifier(name.name)) return actions;
        entry = { name: declaration.name, declaration, compilerFacts: procedureFacts };
    } else {
        return actions;
    }
    const compilerFacts = entry.compilerFacts || entry.declaration.compilerFacts;
    const declaration = entry.declaration;
    const continuedHeaderConfirmed = headerContinues && !model.partial && declaration.provisional !== true &&
        declaration.line === line && declaration.startColumn === name.range.start.character &&
        declaration.endColumn === name.range.end.character;
    const typingInputs = compilerFacts?.procedureTypingInputs;
    const writtenVisibilityInputs = compilerFacts?.procedureWrittenVisibility;
    const visibility = compilerFacts?.compilerVisibility;
    const visibilityInput = Array.isArray(writtenVisibilityInputs) && writtenVisibilityInputs.length === 1
        ? writtenVisibilityInputs[0]
        : null;
    const typingInput = Array.isArray(typingInputs) && typingInputs.length === 1 ? typingInputs[0] : null;
    const leadingColumn = lineText.search(/\S/);
    const directProcedureHeader = leadingColumn >= 0 &&
        /^(?:function|sub)\b/i.test(maskFreeBasicText(lineText).slice(leadingColumn));
    if (["function", "sub"].includes(declaration.type) && !declaration.containerName &&
        !String(declaration.qualifiedName || declaration.name || entry.name || "").includes(".") &&
        !declaration.modifiers?.includes("DECLARE") && typingInput?.provisional !== true &&
        typingInput?.role === "definition" && visibilityInput?.provisional !== true &&
        visibilityInput?.visibility === "default" && visibilityInput.statement === typingInput.statement &&
        ["public", "private"].includes(visibility) && directProcedureHeader &&
        (exactProcedureHeaderEnd(document, declaration, lineText) || continuedHeaderConfirmed)) {
        const visibilityKeyword = visibility[0].toUpperCase() + visibility.slice(1);
        const action = new vscode.CodeAction(
            "Make procedure visibility explicit as '" + visibilityKeyword + "'",
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, new vscode.Position(line, leadingColumn), visibilityKeyword + " ");
        actions.push(action);
    }
    const suffixRange = parameterTypeSuffixRange(lineText, declaration, entry.name);
    const signatureHasOnlySuffixDifference = suffixRange &&
        exactProcedureHeaderWithoutParameterSuffix(document, declaration, lineText, suffixRange);
    const insertion = exactProcedureHeaderEnd(document, declaration, lineText) ||
        signatureHasOnlySuffixDifference && procedureHeaderInsertionPoint(document, line, lineText) ||
        continuedHeaderConfirmed && procedureHeaderInsertionPoint(document, line, lineText);
    if (!insertion) return actions;

    const abiPolicyInputs = compilerFacts?.procedureAbiPolicyInputs;
    const abiPolicyInput = Array.isArray(abiPolicyInputs) && abiPolicyInputs.length === 1 ? abiPolicyInputs[0] : null;
    const externalLinkages = new Set((compilerFacts?.properties || [])
        .filter((property) => property.name === "procedure-linkage" && property.provisional !== true)
        .map((property) => property.value));
    const conventionKeywords = {
        cdecl: "Cdecl",
        stdcall: "Stdcall",
        "stdcall-ms": "Stdcall",
        pascal: "Pascal",
        thiscall: "Thiscall",
        fastcall: "Fastcall"
    };
    const conventionKeyword = conventionKeywords[compilerFacts?.procedureCallingConvention] || "";
    const externalLinkage = externalLinkages.size === 1 ? externalLinkages.values().next().value : "";
    const conventionSuffix = suffixRange ? suffixRange.end : declaration.endColumn;
    const hasWrittenConvention = /^\s*(?:cdecl|stdcall|pascal|thiscall|fastcall)\b/i
        .test(maskFreeBasicText(lineText.slice(conventionSuffix)));
    const hasSimpleParameterList = /^\s*(?:overload\s*)?\(/i.test(maskFreeBasicText(lineText.slice(conventionSuffix)));
    if (conventionKeyword && ["c", "c++", "windows", "windows-ms", "pascal"].includes(externalLinkage) &&
        abiPolicyInput?.provisional !== true && abiPolicyInput?.writtenConvention === false &&
        abiPolicyInput?.managedString === false && typingInput?.provisional !== true &&
        typingInput?.statement === abiPolicyInput.statement && hasSimpleParameterList && !hasWrittenConvention) {
        const action = new vscode.CodeAction(
            "Make calling convention explicit as '" + conventionKeyword + "'",
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, new vscode.Position(line, conventionSuffix), " " + conventionKeyword);
        actions.push(action);
    }

    const overrideTarget = compilerFacts?.overriddenProcedure;
    const hasCompilerOverrideTarget = (typeof overrideTarget?.qualifiedName === "string" &&
        overrideTarget.qualifiedName.length > 0 && overrideTarget.qualifiedName.length <= 512 &&
        !/[\r\n]/.test(overrideTarget.qualifiedName)) ||
        (Number.isSafeInteger(overrideTarget?.compilerSymbolId) && overrideTarget.compilerSymbolId > 0);
    const overrideInsertion = continuedHeaderConfirmed
        ? continuedProcedureHeaderEndInsertionPoint(document, parsedHeader, line)
        : insertion;
    if (overrideInsertion && hasCompilerOverrideTarget &&
        compilerSemanticPropertyInteger(compilerFacts, "written-override") === 0) {
        const action = new vscode.CodeAction("Add explicit 'Override' marker", vscode.CodeActionKind.RefactorRewrite);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, overrideInsertion.position, " Override");
        actions.push(action);
    }

    const typeName = declaration.typeName || entry.nativeSymbol?.typeName ||
        compilerPrimitiveTypeName(compilerFacts?.storageType);
    const returnTypeInsertion = continuedHeaderConfirmed
        ? continuedProcedureHeaderTypeInsertionPoint(document, parsedHeader, line, name.range.end.character)
        : insertion;
    if (returnTypeInsertion && !suffixRange && ["function", "property"].includes(declaration.type) && Array.isArray(typingInputs) &&
        typingInputs.length === 1 && typingInputs[0].provisional !== true &&
        typingInputs[0].kind === declaration.type && typingInputs[0].resultForm === "implicit" &&
        typeof typeName === "string" && typeName && typeName.length <= 512 && !/[\r\n]/.test(typeName)) {
        const overrideMarker = continuedHeaderConfirmed ? null : /\bOverride\s*$/i.exec(lineText.trimEnd());
        const insertionPosition = overrideMarker
            ? document.positionAt(sourceOffsetAt(document, line, overrideMarker.index))
            : returnTypeInsertion.position;
        const insertionText = overrideMarker ? `As ${typeName} ` : ` As ${typeName}`;
        const action = new vscode.CodeAction(`Add explicit return type '${typeName}'`, vscode.CodeActionKind.RefactorRewrite);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, insertionPosition, insertionText);
        actions.push(action);
    }

    const suffixTypeWritten = Array.isArray(typingInputs) && typingInputs.length === 1 &&
        typingInputs[0].provisional !== true && typingInputs[0].kind === declaration.type &&
        typingInputs[0].resultForm === "suffix";
    const suffixTypeFormUnavailable = !Array.isArray(typingInputs) || typingInputs.length === 0;
    if (returnTypeInsertion && suffixRange && ["function", "property"].includes(declaration.type) &&
        (continuedHeaderConfirmed ? suffixTypeWritten : suffixTypeWritten || suffixTypeFormUnavailable) &&
        typeof typeName === "string" && typeName && typeName.length <= 512 && !/[\r\n]/.test(typeName)) {
        const overrideMarker = continuedHeaderConfirmed ? null : /\bOverride\s*$/i.exec(lineText.trimEnd());
        const insertionPosition = overrideMarker
            ? document.positionAt(sourceOffsetAt(document, line, overrideMarker.index))
            : returnTypeInsertion.position;
        const insertionText = overrideMarker ? `As ${typeName} ` : ` As ${typeName}`;
        const action = new vscode.CodeAction(
            `Replace return type suffix with 'As ${typeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        action.edit.delete(document.uri, new vscode.Range(line, suffixRange.start, line, suffixRange.end));
        action.edit.insert(document.uri, insertionPosition, insertionText);
        actions.push(action);
    }

    return actions;
}

function compilerParameterTokenMatches(entry, token, lineText) {
    const declaration = entry?.declaration;
    if (!declaration || !Number.isSafeInteger(declaration.startColumn) ||
        !Number.isSafeInteger(declaration.endColumn) || declaration.startColumn !== token.range.start.character) return false;
    const tokenName = String(token.name || "").toLowerCase().split(".").at(-1);
    const tokenBaseName = tokenName.replace(/[$%!#&]$/, "");
    const compilerName = String(declaration.name || entry.name || "").toLowerCase().split(".").at(-1);
    const exactEnd = declaration.endColumn === token.range.end.character;
    const suffixEnd = declaration.endColumn + 1 === token.range.end.character &&
        /[$%!#&]/.test(lineText[declaration.endColumn] || "");
    return (exactEnd || suffixEnd) && (compilerName === tokenName || compilerName === tokenBaseName);
}

async function continuedProcedureParameterRefactorActions(vscode, workspaceIndex, document, range, token, parsed, parameter,
    diagnostics = []) {
    const actions = [];
    const line = parameter.line;
    const lineText = document.lineAt(line).text;
    const name = getQualifiedSymbolAtPosition(vscode, document, range.start);
    if (!name || name.range.start.character !== parameter.startColumn ||
        name.range.end.character !== parameter.endColumn ||
        normalizeIdentifier(name.name) !== normalizeIdentifier(parameter.name) ||
        lineText.slice(parameter.startColumn, parameter.endColumn) !== parameter.name) return actions;

    const model = await editorModel(workspaceIndex, document, token, false, true);
    if (token?.isCancellationRequested || !model?.remote) return actions;
    const result = await model.query("hover", document.uri, { position: range.start }, token);
    if (token?.isCancellationRequested || !Array.isArray(result?.entries)) return actions;

    let entry = null;
    const candidates = result.entries.filter((candidate) => candidate.declaration?.type === "parameter" &&
        candidate.declaration.provisional !== true && candidate.declaration.line === line &&
        candidate.declaration.startColumn === parameter.startColumn &&
        candidate.declaration.endColumn === parameter.endColumn &&
        compilerParameterTokenMatches(candidate, name, lineText));
    if (candidates.length === 1) {
        entry = candidates[0];
    } else if (candidates.length === 0 && model.semanticSidecarOnly === true) {
        const binding = result.compilerParameterDeclarationRange;
        const facts = result.compilerParameterFacts;
        const parsedParameter = (parsed.declarations || []).find((declaration) =>
            declaration.type === "parameter" && declaration.line === line &&
            declaration.startColumn === binding?.startColumn && declaration.endColumn === binding?.endColumn &&
            normalizeIdentifier(declaration.name) === normalizeIdentifier(parameter.name));
        if (!facts || binding?.line !== line || binding.startColumn !== parameter.startColumn ||
            binding.endColumn !== parameter.endColumn || !parsedParameter) return actions;
        entry = { name: parsedParameter.name, declaration: parsedParameter, compilerFacts: facts };
    }
    if (!entry || model.partial) return actions;

    const parameterActions = parameterRefactorActions(
        vscode, document, entry, line, lineText, true, parameter.parentDeclaration
    );
    const visibleParameterActions = model.semanticSidecarOnly === true
        ? parameterActions.filter((action) =>
            action.title.startsWith("Make parameter passing mode explicit as '") ||
            action.title.startsWith("Add explicit parameter type '") ||
            action.title.startsWith("Replace parameter type suffix with 'As "))
        : parameterActions;
    return compilerParameterModeQuickFixActions(vscode, visibleParameterActions, diagnostics, line, entry);
}

function compilerParameterModeQuickFixActions(vscode, actions, diagnostics, line, entry) {
    const declaration = entry?.declaration;
    if (!Array.isArray(diagnostics) || !declaration || declaration.line !== line ||
        !Number.isSafeInteger(declaration.startColumn) || !Number.isSafeInteger(declaration.endColumn)) return actions;
    const warningSeverity = vscode.DiagnosticSeverity?.Warning;
    const quickFixKind = vscode.CodeActionKind?.QuickFix;
    if (warningSeverity === undefined || quickFixKind === undefined) return actions;
    const parameterName = String(declaration.name || entry.name || "");
    const warning = diagnostics.find((diagnostic) => {
        const reportedName = String(diagnostic.message || "")
            .match(/^No explicit BYREF or BYVAL,\s*at parameter\s+\d+\s+\(([^)\r\n]+)\)\s+of\s+/i)?.[1];
        return diagnostic.severity === warningSeverity &&
            /^fbc(?:\s|$)/i.test(diagnostic.source || "") &&
            diagnostic.range?.start?.line === line && diagnostic.range?.end?.line === line &&
            diagnostic.range.start.character <= declaration.startColumn &&
            diagnostic.range.end.character >= declaration.endColumn &&
            reportedName && normalizeIdentifier(reportedName) === normalizeIdentifier(parameterName);
    });
    if (!warning) return actions;

    return actions.map((action) => {
        if (!action.title.startsWith("Make parameter passing mode explicit as '") || !action.edit) return action;
        const quickFix = new vscode.CodeAction(action.title, quickFixKind);
        quickFix.diagnostics = [warning];
        quickFix.isPreferred = true;
        quickFix.edit = action.edit;
        return quickFix;
    });
}

function compilerImplicitAllocationQuickFixActions(vscode, document, actions, diagnostics, range) {
    if (!Array.isArray(diagnostics) || !Number.isSafeInteger(range?.start?.line) ||
        !Number.isSafeInteger(range?.start?.character)) return actions;
    const warningSeverity = vscode.DiagnosticSeverity?.Warning;
    const quickFixKind = vscode.CodeActionKind?.QuickFix;
    if (warningSeverity === undefined || quickFixKind === undefined) return actions;
    const warning = diagnostics.find((diagnostic) =>
        diagnostic.severity === warningSeverity && /^fbc(?:\s|$)/i.test(diagnostic.source || "") &&
        /^Implicit variable allocation\b/i.test(String(diagnostic.message || "")) &&
        diagnostic.range?.start?.line === range.start.line && diagnostic.range?.end?.line === range.start.line &&
        diagnostic.range.start.character <= range.start.character &&
        diagnostic.range.end.character >= range.start.character &&
        compilerImplicitAllocationWarningNameMatches(document, diagnostic)
    );
    if (!warning) return actions;

    return actions.map((action) => {
        if (!/^(?:Declare implicit|Make implicit array type explicit as )/.test(action.title) || !action.edit) return action;
        const quickFix = new vscode.CodeAction(action.title, quickFixKind);
        quickFix.diagnostics = [warning];
        quickFix.isPreferred = true;
        quickFix.edit = action.edit;
        return quickFix;
    });
}

async function compilerImplicitAllocationWarningQuickFixActions(vscode, workspaceIndex, document, diagnostics, token) {
    const warningSeverity = vscode.DiagnosticSeverity?.Warning;
    const quickFixKind = vscode.CodeActionKind?.QuickFix;
    if (warningSeverity === undefined || quickFixKind === undefined || !Array.isArray(diagnostics)) return [];
    const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === warningSeverity &&
        /^fbc(?:\s|$)/i.test(diagnostic.source || "") &&
        /^Implicit variable allocation\b/i.test(String(diagnostic.message || "")));
    if (!warnings.length || warnings.length > MAX_IMPLICIT_ALLOCATION_WARNING_CANDIDATES) return [];
    const output = [];
    const emitted = new Set();

    for (const warning of warnings) {
        if (token?.isCancellationRequested) return [];
        const line = warning.range?.start?.line;
        const reportedName = compilerImplicitAllocationReportedName(warning);
        if (!Number.isSafeInteger(line) || line < 0 || line >= document.lineCount || !reportedName ||
            warning.range?.end?.line !== line) continue;
        const lineText = document.lineAt(line).text;
        const maskedLine = maskFreeBasicText(lineText);
        const occurrences = [...maskedLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)]
            .filter((match) => match[0].toLowerCase() === reportedName.toLowerCase());
        if (!occurrences.length || occurrences.length > MAX_IMPLICIT_ALLOCATION_WARNING_CANDIDATES) continue;

        const candidates = [];
        for (const occurrence of occurrences) {
            const occurrenceRange = new vscode.Range(
                line, occurrence.index, line, occurrence.index + occurrence[0].length
            );
            const actions = await compilerImplicitDeclarationTypeRefactorActions(
                vscode, workspaceIndex, document, occurrenceRange, token
            );
            if (token?.isCancellationRequested) return [];
            for (const action of actions) {
                if (/^(?:Declare implicit|Make implicit array type explicit as )/.test(action.title) && action.edit) {
                    candidates.push(action);
                    if (candidates.length > 1) break;
                }
            }
            if (candidates.length > 1) break;
        }
        if (candidates.length !== 1) continue;
        const candidate = candidates[0];
        const key = `${line}:${reportedName.toLowerCase()}:${candidate.title}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        const quickFix = new vscode.CodeAction(candidate.title, quickFixKind);
        quickFix.diagnostics = [warning];
        quickFix.isPreferred = true;
        quickFix.edit = candidate.edit;
        output.push(quickFix);
    }
    return output;
}

function compilerImplicitAllocationReportedName(diagnostic) {
    return String(diagnostic.sourceText || diagnostic.compilerDetail || "")
        .match(/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/)?.[0] ||
        String(diagnostic.message || "").match(
            /Implicit variable allocation(?:\s*,\s*|\s+)(?:in\s+)?['"`]?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)/i
        )?.[1] || "";
}

function compilerImplicitAllocationWarningNameMatches(document, diagnostic) {
    if (typeof document?.getText !== "function" || typeof document?.offsetAt !== "function" ||
        !diagnostic.range?.start || !diagnostic.range?.end) return false;
    const reportedName = compilerImplicitAllocationReportedName(diagnostic);
    if (!reportedName) return false;
    const startOffset = document.offsetAt(diagnostic.range.start);
    const endOffset = document.offsetAt(diagnostic.range.end);
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) ||
        startOffset < 0 || endOffset <= startOffset) return false;
    const sourceName = document.getText().slice(startOffset, endOffset);
    return normalizeIdentifier(sourceName) === normalizeIdentifier(reportedName);
}

function parameterRefactorActions(vscode, document, entry, line, lineText, continuedHeader = false,
    continuedProcedure = null) {
    const actions = [];
    const declaration = entry.declaration;
    const compilerFacts = entry.compilerFacts || declaration.compilerFacts;
    const writtenTypes = compilerFacts?.formalWrittenTypes;
    const typeName = declaration.typeName || entry.nativeSymbol?.typeName ||
        compilerPrimitiveTypeName(compilerFacts?.storageType);
    const typeInsertionColumn = implicitParameterTypeInsertionColumn(lineText, declaration);
    const typeInsertionPosition = Number.isSafeInteger(typeInsertionColumn)
        ? document.positionAt(sourceOffsetAt(document, line, typeInsertionColumn))
        : continuedHeader
            ? continuedProcedureParameterTypeInsertionPoint(document, continuedProcedure, declaration)
            : null;
    const suffixRange = parameterTypeSuffixRange(lineText, declaration, entry.name);
    const exactHeader = continuedHeader || exactProcedureHeaderEnd(document, declaration, lineText) ||
        suffixRange && exactProcedureHeaderWithoutParameterSuffix(document, declaration, lineText, suffixRange);
    if (declaration.provisional === true ||
        !Number.isSafeInteger(declaration.startColumn) || !Number.isSafeInteger(declaration.endColumn) ||
        declaration.startColumn < 0 || declaration.endColumn <= declaration.startColumn ||
        lineText.slice(declaration.startColumn, declaration.endColumn).toLowerCase() !==
            String(declaration.name || entry.name || "").toLowerCase() ||
        !exactHeader) return actions;

    if (typeInsertionPosition && !suffixRange && Array.isArray(writtenTypes) &&
        writtenTypes.length === 1 && writtenTypes[0] === "implicit" &&
        (continuedHeader || Number.isSafeInteger(typeInsertionColumn) &&
            !/^\s*As\b/i.test(lineText.slice(typeInsertionColumn))) &&
        typeof typeName === "string" && typeName && typeName.length <= 512 && !/[\r\n]/.test(typeName)) {
        const action = new vscode.CodeAction(`Add explicit parameter type '${typeName}'`, vscode.CodeActionKind.RefactorRewrite);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, typeInsertionPosition, ` As ${typeName}`);
        actions.push(action);
    }

    const suffixTypeWritten = Array.isArray(writtenTypes) && writtenTypes.length === 1 && writtenTypes[0] === "suffix";
    const suffixTypeFormUnavailable = !Array.isArray(writtenTypes) || writtenTypes.length === 0;
    const suffixTypeConfirmed = continuedHeader
        ? suffixTypeWritten
        : suffixTypeWritten || suffixTypeFormUnavailable;
    if (suffixRange && suffixTypeConfirmed &&
        typeof typeName === "string" && typeName && typeName.length <= 512 && !/[\r\n]/.test(typeName)) {
        const hasArrayRank = /^\s*\(/.test(lineText.slice(suffixRange.end));
        if (hasArrayRank && typeInsertionPosition && suffixTypeWritten) {
            const action = new vscode.CodeAction(
                `Replace parameter type suffix with 'As ${typeName}'`,
                vscode.CodeActionKind.RefactorRewrite
            );
            action.edit = new vscode.WorkspaceEdit();
            action.edit.delete(document.uri, new vscode.Range(
                line, suffixRange.start, line, suffixRange.end
            ));
            action.edit.insert(document.uri, typeInsertionPosition, ` As ${typeName}`);
            actions.push(action);
        } else if (!/^\s*(?:\(|As\b)/i.test(lineText.slice(suffixRange.end))) {
            const action = new vscode.CodeAction(
                `Replace parameter type suffix with 'As ${typeName}'`,
                vscode.CodeActionKind.RefactorRewrite
            );
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, new vscode.Range(
                line, suffixRange.start, line, suffixRange.end
            ), ` As ${typeName}`);
            actions.push(action);
        }
    }

    const parameterMode = compilerFacts?.parameterPassing?.mode;
    const writtenMode = compilerSemanticPropertyInteger(compilerFacts, "formal-written-mode");
    if (compilerFacts?.parameterPassing?.receiver !== true && writtenMode === 0 &&
        (parameterMode === "byval" || parameterMode === "byref")) {
        const mode = parameterMode === "byval" ? "ByVal" : "ByRef";
        const insertionOffset = sourceOffsetAt(document, line, declaration.startColumn);
        const insertionPosition = document.positionAt(insertionOffset);
        const action = new vscode.CodeAction(`Make parameter passing mode explicit as '${mode}'`, vscode.CodeActionKind.RefactorRewrite);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, insertionPosition, `${mode} `);
        actions.push(action);
    }

    return actions;
}

function exactProcedureHeaderWithoutParameterSuffix(document, declaration, lineText, suffixRange) {
    if (declaration.line < 0 || typeof declaration.signature !== "string" ||
        typeof document.offsetAt !== "function" || typeof document.positionAt !== "function") return false;
    const signature = declaration.signature.replace(/\s+/g, " ").trim().toLowerCase();
    const sourceWithoutSuffix = `${lineText.slice(0, suffixRange.start)}${lineText.slice(suffixRange.end)}`
        .replace(/\s+/g, " ").trim().toLowerCase();
    return signature.length > 0 && signature === sourceWithoutSuffix;
}

function implicitParameterTypeInsertionColumn(lineText, declaration) {
    let column = declaration.endColumn;
    while (column < lineText.length && /\s/.test(lineText[column])) column++;
    if (lineText[column] !== "(") return declaration.endColumn;
    const maskedLine = maskFreeBasicText(lineText);
    if (maskedLine.length !== lineText.length || maskedLine[column] !== "(") return null;

    let depth = 0;
    for (let index = column; index < maskedLine.length; index++) {
        if (maskedLine[index] === "(") depth++;
        else if (maskedLine[index] === ")") {
            depth--;
            if (depth === 0) return index + 1;
            if (depth < 0) return null;
        }
    }
    return null;
}

function continuedProcedureParameterTypeInsertionPoint(document, procedure, parameter) {
    const line = parameter?.line;
    const endLine = procedure?.signatureEndLine;
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(endLine) || endLine <= line ||
        endLine - line > MAX_IMPLICIT_TARGET_STATEMENT_LINES ||
        !Number.isSafeInteger(parameter?.endColumn) ||
        typeof document.offsetAt !== "function" || typeof document.positionAt !== "function") return null;
    const lineText = document.lineAt(line).text;
    let openingColumn = parameter.endColumn;
    while (openingColumn < lineText.length && /\s/.test(lineText[openingColumn])) openingColumn++;
    if (lineText[openingColumn] !== "(") return null;

    const startOffset = sourceOffsetAt(document, line, openingColumn);
    const finalLine = document.lineAt(endLine).text;
    const endOffset = sourceOffsetAt(document, endLine, finalLine.length);
    const source = document.getText();
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 ||
        endOffset < startOffset || endOffset > source.length ||
        endOffset - startOffset > MAX_PROCEDURE_HEADER_SCAN_CHARACTERS) return null;

    const parameterArray = maskFreeBasicText(source.slice(startOffset, endOffset));
    let depth = 0;
    let closingParenthesis = -1;
    for (let index = 0; index < parameterArray.length; index++) {
        if (parameterArray[index] === "(") {
            depth++;
        } else if (parameterArray[index] === ")") {
            depth--;
            if (depth === 0) {
                closingParenthesis = index;
                break;
            }
            if (depth < 0) return null;
        }
    }
    if (closingParenthesis < 0) return null;
    return document.positionAt(startOffset + closingParenthesis + 1);
}

function parameterTypeSuffixRange(lineText, declaration, entryName = "") {
    let suffixStart = declaration.endColumn - 1;
    let suffixEnd = declaration.endColumn;
    if (!/[$%!#&]/.test(lineText[suffixStart] || "")) {
        suffixStart = declaration.endColumn;
        suffixEnd = suffixStart + 1;
    }
    const suffix = lineText[suffixStart] || "";
    if (!/[$%!#&]/.test(suffix)) return null;
    const baseName = lineText.slice(declaration.startColumn, suffixStart).toLowerCase();
    const declaredName = String(declaration.name || entryName || "").toLowerCase();
    if (!baseName || declaredName !== baseName && declaredName !== `${baseName}${suffix.toLowerCase()}`) return null;
    return { start: suffixStart, end: suffixEnd };
}

async function compilerEnumValueRefactorActions(vscode, workspaceIndex, document, range, token) {
    const actions = [];
    const line = range?.start?.line;
    if (!Number.isSafeInteger(line) || line < 0 || token?.isCancellationRequested ||
        document.uri.scheme !== "file") return actions;
    const parsed = workspaceIndex.getParsedDocument?.(document);
    if (!parsed?.declarations?.some((declaration) =>
        declaration.type === "enumMember" && declaration.line === line)) return actions;

    const name = getQualifiedSymbolAtPosition(vscode, document, range.start);
    if (!name) return actions;
    const lineText = document.lineAt(line).text;
    const maskedLine = maskFreeBasicText(lineText);
    const model = await editorModel(workspaceIndex, document, token, false, true);
    if (token?.isCancellationRequested || !model?.remote) return actions;
    const result = await model.query("hover", document.uri, { position: range.start }, token);
    if (token?.isCancellationRequested || !Array.isArray(result?.entries)) return actions;
    const candidates = result.entries.filter((entry) =>
        ["enumMember", "enum-member"].includes(entry.declaration?.type) &&
        entry.provisional !== true && entry.declaration.provisional !== true &&
        entry.declaration.line === line && compilerParameterTokenMatches(entry, name, lineText));
    let endColumn = -1;
    let value = "";
    if (candidates.length === 1) {
        const entry = candidates[0];
        const declaration = entry.declaration;
        const facts = entry.compilerFacts || declaration.compilerFacts;
        const inputs = facts?.enumElementInputs;
        if (!Array.isArray(inputs) || !inputs.length ||
            !Number.isSafeInteger(declaration.startColumn) || !Number.isSafeInteger(declaration.endColumn) ||
            declaration.startColumn < 0 || declaration.endColumn <= declaration.startColumn ||
            maskedLine.slice(0, declaration.startColumn).trim() ||
            maskedLine.slice(declaration.endColumn).trim() ||
            lineText.slice(declaration.startColumn, declaration.endColumn).toLowerCase() !==
                String(declaration.name || entry.name || "").toLowerCase()) return actions;

        const pathKey = (filePath) => {
            const resolved = path.resolve(filePath);
            return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        };
        const requestedPath = pathKey(document.uri.fsPath);
        const physicalInputs = inputs.filter((input) =>
            input.physical === true && input.filePath && pathKey(input.filePath) === requestedPath &&
            input.line === line + 1 && input.startColumn === declaration.startColumn
        );
        if (!physicalInputs.length || physicalInputs.some((input) =>
            input.provisional === true || input.explicit !== false)) return actions;
        endColumn = declaration.endColumn;
        value = compilerConstantValue(facts);
    } else if (candidates.length === 0 && model.semanticSidecarOnly === true) {
        const element = result.compilerEnumElementFacts;
        const binding = result.compilerEnumElementRange;
        if (element?.explicit !== false || !Number.isSafeInteger(element.ordinal) || element.ordinal < 1 ||
            !binding || binding.line !== line || !Number.isSafeInteger(binding.startColumn) ||
            !Number.isSafeInteger(binding.endColumn) || binding.startColumn < 0 ||
            binding.endColumn <= binding.startColumn || maskedLine.slice(0, binding.startColumn).trim() ||
            maskedLine.slice(binding.endColumn).trim()) return actions;
        const parsedMember = parsed.declarations.find((declaration) =>
            declaration.type === "enumMember" && declaration.line === line &&
            declaration.startColumn === binding.startColumn && declaration.endColumn === binding.endColumn
        );
        const sourceMemberName = lineText.slice(binding.startColumn, binding.endColumn);
        if (!parsedMember || sourceMemberName.toLowerCase() !== String(parsedMember.name).toLowerCase()) return actions;
        const constant = await model.query("compilerSidecarConstantAt", document.uri, { position: range.start }, token);
        if (token?.isCancellationRequested) return actions;
        endColumn = binding.endColumn;
        value = compilerConstantValueText(constant);
    } else {
        return actions;
    }

    if (!/^(?:0|-?[1-9]\d*)$/.test(value)) return actions;
    const action = new vscode.CodeAction(
        "Make enum value explicit as " + value,
        vscode.CodeActionKind.RefactorRewrite
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, new vscode.Position(line, endColumn), " = " + value);
    actions.push(action);
    return actions;
}

async function compilerImplicitDeclarationTypeRefactorActions(vscode, workspaceIndex, document, range, token) {
    const actions = [];
    const line = range?.start?.line;
    if (!Number.isSafeInteger(line) || line < 0 || token?.isCancellationRequested) return actions;
    const lineText = document.lineAt(line).text;
    const maskedLine = maskFreeBasicText(lineText);
    const explicitDeclaration = /^\s*(?:dim|static|common|extern|const|var)\b/i.test(maskedLine);
    let parsed = null;
    let implicitAssignment = maskedLine.match(/^(\s*)(let\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=|>)/i);
    let continuedAssignmentTarget = null;
    const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
    const unsavedNativeAnalysis = compilerSelection?.semanticModelOnly === false;
    if (implicitAssignment && (document.isDirty !== true || unsavedNativeAnalysis) && compilerSelection) {
        parsed = workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(document.getText());
        const continuedStatement = (parsed.statements || []).find((statement) => {
            const startLine = statement.startLine;
            const endLine = statement.endLine ?? startLine;
            return Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) &&
                startLine <= line && endLine >= line && endLine > startLine;
        });
        if (continuedStatement) {
            const logicalCode = String(continuedStatement.maskedText || "").replace(/\s+/g, " ").trim();
            const logicalAssignment = /^(?:let\s+)?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*=(?!=|>)/i.exec(logicalCode);
            const sameAssignmentTarget = logicalAssignment &&
                normalizeIdentifier(logicalAssignment[1]) === normalizeIdentifier(implicitAssignment[3]);
            if (!sameAssignmentTarget) {
                const statementTargets = [
                    compilerInputReadTargetAtPosition(document, range.start, parsed),
                    compilerGetTargetAtPosition(document, range.start, parsed),
                    compilerImplicitForCounterAtPosition(document, range.start, parsed),
                    compilerImplicitRedimTargetAtPosition(document, range.start, parsed),
                    compilerImplicitSwapTargetAtPosition(document, range.start, parsed),
                    compilerImplicitLsetRsetTargetAtPosition(document, range.start, parsed)
                ];
                if (statementTargets.some(Boolean)) implicitAssignment = null;
            }
            if (implicitAssignment) {
                const startColumn = implicitAssignment.index + implicitAssignment[1].length +
                    (implicitAssignment[2]?.length || 0);
                continuedAssignmentTarget = {
                    name: implicitAssignment[3],
                    startColumn,
                    endColumn: startColumn + implicitAssignment[3].length,
                    statementStartLine: continuedStatement.startLine,
                    continuedAssignment: true
                };
                implicitAssignment = null;
            }
        }
    } else if (!explicitDeclaration && (document.isDirty !== true || unsavedNativeAnalysis) && compilerSelection) {
        parsed = workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(document.getText());
        continuedAssignmentTarget = compilerImplicitContinuedAssignmentAtPosition(
            document, range.start, parsed
        );
    }
    const assignmentRhs = implicitAssignment
        ? lineText.slice(implicitAssignment.index + implicitAssignment[0].length).trim()
        : "";
    const implicitAssignmentName = implicitAssignment?.[3] || "";
    const implicitAssignmentNameStart = implicitAssignment
        ? implicitAssignment.index + implicitAssignment[1].length + (implicitAssignment[2]?.length || 0)
        : -1;
    const implicitAssignmentReplacementStart = implicitAssignment
        ? implicitAssignment.index + implicitAssignment[1].length
        : -1;
    const implicitLocalAssignment = !explicitDeclaration && Boolean(implicitAssignment) &&
        !maskedLine.includes(":") && !/_\s*$/.test(maskedLine.trimEnd()) &&
        Boolean(assignmentRhs) && !/^(?:'|rem\b)/i.test(assignmentRhs);
    let implicitCompoundAssignmentTarget = null;
    let implicitCompoundLocalAssignment = false;
    let implicitReadGetTarget = null;
    let implicitForCounter = null;
    let implicitRedimTarget = null;
    let implicitSwapTarget = null;
    let implicitLsetRsetTarget = null;
    let implicitLegacyTarget = null;
    const stockSidecarTargetsAvailable = compilerSelection?.semanticModelOnly === true && document.isDirty !== true;
    const nativeTargetsAvailable = compilerSelection?.semanticModelOnly === false;
    if (!explicitDeclaration && !implicitAssignment &&
        (stockSidecarTargetsAvailable || nativeTargetsAvailable)) {
        parsed ||= workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(document.getText());
        const inputReadTarget = compilerInputReadTargetAtPosition(document, range.start, parsed);
        const getTarget = compilerGetTargetAtPosition(document, range.start, parsed);
        const forCounter = compilerImplicitForCounterAtPosition(document, range.start, parsed);
        const redimTarget = (stockSidecarTargetsAvailable || nativeTargetsAvailable)
            ? compilerImplicitRedimTargetAtPosition(document, range.start, parsed)
            : null;
        const compoundAssignmentTarget = compilerImplicitCompoundAssignmentAtPosition(document, range.start, parsed);
        const swapTarget = compilerImplicitSwapTargetAtPosition(document, range.start, parsed);
        const lsetRsetTarget = compilerImplicitLsetRsetTargetAtPosition(document, range.start, parsed);
        const unresolvedIdentifier = identifierTokenAtPosition(document, range.start) ||
            optionNoKeywordIdentifierAtPosition(document, range.start);
        const legacyTarget = unresolvedIdentifier && compilerUsesImplicitVariableDialect(document, workspaceIndex)
            ? unresolvedIdentifier
            : null;
        const sourceModel = workspaceIndex.getSourceSemanticModel?.() ||
            workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
        const legacyTargetResolved = legacyTarget
            ? sourceModel?.resolveAt?.(document.uri, line, legacyTarget.startColumn)
            : null;
        const unresolvedLegacyTarget = legacyTarget && Array.isArray(legacyTargetResolved) &&
            legacyTargetResolved.length === 0 ? legacyTarget : null;
        const candidate = continuedAssignmentTarget || inputReadTarget || getTarget || forCounter || redimTarget ||
            compoundAssignmentTarget || swapTarget || lsetRsetTarget || unresolvedLegacyTarget;
        if (candidate && !/[$%!#&]$/.test(candidate.name)) {
            const procedureTypes = new Set(["function", "sub", "property", "operator", "constructor", "destructor"]);
            const insideMacro = (parsed?.declarations || []).some((declaration) =>
                declaration.type === "macro" && Number.isSafeInteger(declaration.endLine) &&
                declaration.line <= line && declaration.endLine >= line
            );
            const inProcedure = !insideMacro && (parsed?.declarations || []).some((declaration) =>
                procedureTypes.has(declaration.type) && !declaration.modifiers?.includes("DECLARE") &&
                Number.isSafeInteger(declaration.endLine) && declaration.line <= line && declaration.endLine >= line
            );
            const moduleRedimTarget = redimTarget && !insideMacro && !inProcedure;
            const moduleImplicitTarget = unresolvedLegacyTarget && !insideMacro && !inProcedure;
            const resolved = sourceModel?.resolveAt?.(document.uri, line, candidate.startColumn);
            if (moduleRedimTarget || moduleImplicitTarget || inProcedure && (continuedAssignmentTarget || redimTarget ||
                Array.isArray(resolved) && resolved.length === 0)) {
                if (continuedAssignmentTarget) implicitReadGetTarget = continuedAssignmentTarget;
                else if (inputReadTarget) implicitReadGetTarget = inputReadTarget;
                else if (getTarget) implicitReadGetTarget = getTarget;
                else if (forCounter) implicitForCounter = forCounter;
                else if (redimTarget) implicitRedimTarget = moduleRedimTarget
                    ? { ...redimTarget, moduleScope: true }
                    : redimTarget;
                else if (compoundAssignmentTarget) implicitCompoundAssignmentTarget = compoundAssignmentTarget;
                else if (swapTarget) implicitSwapTarget = swapTarget;
                else if (lsetRsetTarget) implicitLsetRsetTarget = lsetRsetTarget;
                else implicitLegacyTarget = unresolvedLegacyTarget;
            }
        }
    }
    if (continuedAssignmentTarget && !explicitDeclaration &&
        compilerSelection?.semanticModelOnly === false && compilerUsesImplicitVariableDialect(document, workspaceIndex)) {
        const parsedForScope = parsed || workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(document.getText());
        const insideMacro = (parsedForScope.declarations || []).some((declaration) =>
            declaration.type === "macro" && Number.isSafeInteger(declaration.endLine) &&
            declaration.line <= line && declaration.endLine >= line
        );
        const procedureTypes = new Set(["function", "sub", "property", "operator", "constructor", "destructor"]);
        const inProcedure = !insideMacro && (parsedForScope.declarations || []).some((declaration) =>
            procedureTypes.has(declaration.type) && !declaration.modifiers?.includes("DECLARE") &&
            Number.isSafeInteger(declaration.endLine) && declaration.line <= line && declaration.endLine >= line
        );
        if (inProcedure) implicitReadGetTarget = continuedAssignmentTarget;
    }
    if (!implicitLegacyTarget && !implicitReadGetTarget && !implicitForCounter && !implicitRedimTarget &&
        !implicitCompoundAssignmentTarget && !implicitSwapTarget && !implicitLsetRsetTarget &&
        !explicitDeclaration && !implicitAssignment &&
        workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === false &&
        compilerUsesImplicitVariableDialect(document, workspaceIndex)) {
        const target = identifierTokenAtPosition(document, range.start) ||
            optionNoKeywordIdentifierAtPosition(document, range.start);
        if (target && !/[$%!#&]$/.test(target.name)) {
            const sourceModel = workspaceIndex.getSourceSemanticModel?.() ||
                workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
            const resolved = sourceModel?.resolveAt?.(document.uri, line, target.startColumn);
            const parsed = workspaceIndex.getParsedDocument?.(document);
            const insideMacro = (parsed?.declarations || []).some((declaration) =>
                declaration.type === "macro" && Number.isSafeInteger(declaration.endLine) &&
                declaration.line <= line && declaration.endLine >= line
            );
            if (!insideMacro && Array.isArray(resolved) && resolved.length === 0) implicitLegacyTarget = target;
        }
    }
    implicitCompoundLocalAssignment = Boolean(implicitCompoundAssignmentTarget);
    if (!explicitDeclaration && !implicitLocalAssignment && !implicitReadGetTarget &&
        !implicitForCounter && !implicitRedimTarget && !implicitCompoundLocalAssignment &&
        !implicitSwapTarget && !implicitLsetRsetTarget && !implicitLegacyTarget) return actions;
    if (implicitLocalAssignment || implicitCompoundLocalAssignment || implicitSwapTarget || implicitLsetRsetTarget) {
        const parsed = workspaceIndex.getParsedDocument?.(document);
        if (parsed && !hasPotentialImplicitVariableHint(parsed, document, {
            start: { line }, end: { line }
        }, workspaceIndex)) return actions;
    }
    const name = getQualifiedSymbolAtPosition(vscode, document, range.start);
    if (!name) return actions;

    const model = await editorModel(workspaceIndex, document, token, false, true);
    if (token?.isCancellationRequested || !model?.remote) return actions;
    const result = await model.query("hover", document.uri, { position: range.start }, token);
    if (token?.isCancellationRequested || !Array.isArray(result?.entries)) return actions;
    if (implicitRedimTarget && model.semanticSidecarOnly === true) {
        const typeName = compilerPrimitiveTypeName(result.compilerStorageTypeFacts?.storageType);
        const storageClass = result.compilerStorageClass;
        const validStorageClass = implicitRedimTarget.moduleScope
            ? ["static", "shared", "global"].includes(storageClass)
            : storageClass === "local";
        const declarationRange = result.compilerStorageTypeDeclarationRange;
        if (model.partial || !validStorageClass || !typeName || typeName.length > 512 ||
            /[\r\n]/.test(typeName) || name.range.start.character !== implicitRedimTarget.startColumn ||
            name.range.end.character !== implicitRedimTarget.endColumn ||
            normalizeIdentifier(name.name) !== normalizeIdentifier(implicitRedimTarget.name) ||
            implicitRedimTarget.moduleScope &&
                (declarationRange?.line !== line || declarationRange.startColumn !== implicitRedimTarget.startColumn ||
                    declarationRange.endColumn !== implicitRedimTarget.endColumn)) return actions;
        if (implicitRedimTarget.moduleScope) {
            const typePosition = compilerRedimTargetTypeInsertionPosition(document, implicitRedimTarget);
            if (!typePosition) return actions;
            const action = new vscode.CodeAction(
                `Make implicit array type explicit as '${typeName}'`,
                vscode.CodeActionKind.RefactorRewrite
            );
            action.edit = new vscode.WorkspaceEdit();
            action.edit.insert(document.uri,
                new vscode.Position(typePosition.line, typePosition.character), ` As ${typeName}`);
            actions.push(action);
            return actions;
        }
        const action = new vscode.CodeAction(
            `Declare implicit array as '${typeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        const insertionLine = implicitRedimTarget.statementStartLine ?? line;
        const insertionLineText = document.lineAt(insertionLine).text;
        const indentation = /^\s*/.exec(insertionLineText)?.[0] || "";
        const lineEnding = document.getText().match(/\r\n|\n|\r/)?.[0] || "\n";
        action.edit.insert(document.uri, new vscode.Position(insertionLine, 0),
            `${indentation}Dim ${implicitRedimTarget.name}() As ${typeName}${lineEnding}`);
        actions.push(action);
        return actions;
    }
    if (implicitLegacyTarget && model.semanticSidecarOnly === true) {
        const storageFacts = result.compilerStorageTypeFacts;
        const storageType = storageFacts?.storageType;
        const scalarStorage = storageType?.pointerDepth === 0 && storageType.isReference === false &&
            !storageFacts.arrayBounds && !(storageFacts.properties || []).some((property) =>
                property.name === "array-elements"
            );
        const typeName = scalarStorage ? compilerPrimitiveTypeName(storageType) : "";
        const declarationRange = result.compilerStorageTypeDeclarationRange;
        if (model.partial || result.compilerStorageClass !== "local" || !typeName || typeName.length > 512 ||
            /[\r\n]/.test(typeName) || declarationRange?.line !== line ||
            declarationRange.startColumn !== implicitLegacyTarget.startColumn ||
            declarationRange.endColumn !== implicitLegacyTarget.endColumn ||
            name.range.start.character !== implicitLegacyTarget.startColumn ||
            name.range.end.character !== implicitLegacyTarget.endColumn ||
            normalizeIdentifier(name.name) !== normalizeIdentifier(implicitLegacyTarget.name)) return actions;
        const action = new vscode.CodeAction(
            `Declare implicit local as '${typeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        const indentation = /^\s*/.exec(lineText)?.[0] || "";
        const lineEnding = document.getText().match(/\r\n|\n|\r/)?.[0] || "\n";
        action.edit.insert(document.uri, new vscode.Position(line, 0),
            `${indentation}Dim ${implicitLegacyTarget.name} As ${typeName}${lineEnding}`);
        actions.push(action);
        return actions;
    }
    if (implicitLegacyTarget && model.semanticSidecarOnly !== true) {
        const matches = result.entries.filter((candidate) => {
            const declaration = candidate.declaration;
            return declaration?.type === "variable" && declaration.provisional !== true &&
                declaration.line === line && declaration.startColumn === implicitLegacyTarget.startColumn &&
                declaration.endColumn === implicitLegacyTarget.endColumn &&
                normalizeIdentifier(candidate.name || declaration.name) === normalizeIdentifier(implicitLegacyTarget.name);
        });
        const entry = matches.length === 1 ? matches[0] : null;
        const declaration = entry?.declaration;
        const compilerFacts = entry?.compilerFacts || declaration?.compilerFacts || {};
        const storageType = compilerFacts.storageType;
        const scalarStorage = storageType?.pointerDepth === 0 && storageType.isReference === false &&
            !compilerFacts.arrayBounds && !(compilerFacts.properties || []).some((property) =>
                property?.name === "array-elements"
            );
        const typeName = scalarStorage ? compilerPrimitiveTypeName(storageType) : "";
        const storageClass = compilerFacts.compilerStorageClass || result.compilerStorageClass;
        if (model.partial || storageClass !== "local" || !scalarStorage || !typeName || typeName.length > 512 ||
            /[\r\n]/.test(typeName) || declaration.line !== line ||
            lineText.slice(implicitLegacyTarget.startColumn, implicitLegacyTarget.endColumn) !== implicitLegacyTarget.name ||
            name.range.start.character !== implicitLegacyTarget.startColumn ||
            name.range.end.character !== implicitLegacyTarget.endColumn ||
            normalizeIdentifier(name.name) !== normalizeIdentifier(implicitLegacyTarget.name)) return actions;
        const action = new vscode.CodeAction(
            `Declare implicit local as '${typeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        const indentation = /^\s*/.exec(lineText)?.[0] || "";
        const lineEnding = document.getText().match(/\r\n|\n|\r/)?.[0] || "\n";
        action.edit.insert(document.uri, new vscode.Position(line, 0),
            `${indentation}Dim ${implicitLegacyTarget.name} As ${typeName}${lineEnding}`);
        actions.push(action);
        return actions;
    }
    const candidates = result.entries.filter((entry) => ["variable", "const"].includes(entry.declaration?.type) &&
        entry.declaration.provisional !== true &&
        entry.declaration.line === line && compilerParameterTokenMatches(entry, name, lineText));
    let entry = null;
    if (candidates.length === 1) {
        entry = candidates[0];
    } else if (candidates.length === 0 && model.semanticSidecarOnly === true && explicitDeclaration) {
        const facts = result.compilerStorageTypeFacts;
        const declarations = workspaceIndex.getParsedDocument?.(document)?.declarations || [];
        const declaration = declarations.find((candidate) => ["variable", "const", "extern"].includes(candidate.type) &&
            candidate.line === line && compilerParameterTokenMatches({
                name: candidate.name, declaration: candidate
            }, name, lineText) &&
            normalizeIdentifier(candidate.name) === normalizeIdentifier(name.name));
        const inputs = facts?.declarationInputs;
        const input = Array.isArray(inputs) && inputs.length === 1 ? inputs[0] : null;
        const group = input?.group;
        const typeName = compilerPrimitiveTypeName(facts?.storageType);
        const implicitVariable = ["variable", "extern"].includes(declaration?.type) &&
            ["dim", "static", "common", "extern"].includes(group?.kind) &&
            input?.writtenType === "implicit" && Number.isSafeInteger(group?.count) && group.count > 0;
        const inferredVar = declaration?.type === "variable" && group?.kind === "var" &&
            input?.writtenType === "inferred" && group.count === 1;
        const inferredConstant = declaration?.type === "const" && group?.kind === "const" &&
            input?.writtenType === "inferred" && Number.isSafeInteger(group?.count) && group.count > 0;
        const suffixDeclaration = (["variable", "extern"].includes(declaration?.type) &&
            ["dim", "static", "common", "extern"].includes(group?.kind) ||
            declaration?.type === "const" && group?.kind === "const") &&
            input?.writtenType === "suffix" && Number.isSafeInteger(group?.count) && group.count > 0;
        if (!declaration || !input || input.provisional === true || !group || group.provisional === true ||
            !Number.isSafeInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > group.count ||
            !Number.isSafeInteger(input.symbol) || input.symbol < 1 ||
            (!implicitVariable && !inferredVar && !inferredConstant && !suffixDeclaration) ||
            (implicitVariable || inferredVar || inferredConstant) && /[$%!#&]$/.test(name.name) ||
            !Number.isSafeInteger(implicitParameterTypeInsertionColumn(lineText, declaration)) || !typeName) return actions;
        entry = {
            name: declaration.name,
            declaration: { ...declaration, typeName },
            compilerFacts: facts
        };
    } else if (candidates.length === 0 && model.semanticSidecarOnly === true && implicitLocalAssignment) {
        const typeFacts = result.compilerStorageTypeFacts;
        const typeName = compilerPrimitiveTypeName(typeFacts?.storageType);
        const targetName = implicitAssignmentName;
        const startColumn = implicitAssignmentNameStart;
        const endColumn = startColumn + targetName.length;
        if (result.compilerStorageClass !== "local" || !typeName || typeName.length > 512 ||
            name.range.start.character !== startColumn || name.range.end.character !== endColumn ||
            normalizeIdentifier(name.name) !== normalizeIdentifier(targetName)) return actions;
        entry = {
            name: targetName,
            declaration: {
                type: "variable",
                name: targetName,
                typeName,
                line,
                startColumn,
                endColumn,
                signature: `variable ${targetName} As ${typeName}`,
                provisional: false
            },
            compilerFacts: { ...typeFacts, compilerStorageClass: result.compilerStorageClass }
        };
    } else if (candidates.length === 0 && model.semanticSidecarOnly === true &&
        (implicitCompoundLocalAssignment || implicitSwapTarget || implicitLsetRsetTarget)) {
        const typeFacts = result.compilerStorageTypeFacts;
        const typeName = compilerPrimitiveTypeName(typeFacts?.storageType);
        const target = implicitCompoundLocalAssignment
            ? implicitCompoundAssignmentTarget
            : implicitSwapTarget || implicitLsetRsetTarget;
        const targetName = target.name;
        const startColumn = target.startColumn;
        const endColumn = target.endColumn;
        if (model.partial || result.compilerStorageClass !== "local" || !typeName || typeName.length > 512 ||
            name.range.start.character !== startColumn || name.range.end.character !== endColumn ||
            normalizeIdentifier(name.name) !== normalizeIdentifier(targetName)) return actions;
        entry = {
            name: targetName,
            declaration: {
                type: "variable",
                name: targetName,
                typeName,
                line,
                startColumn,
                endColumn,
                signature: `variable ${targetName} As ${typeName}`,
                provisional: false
            },
            compilerFacts: { ...typeFacts, compilerStorageClass: result.compilerStorageClass }
        };
    } else if (candidates.length === 0 && model.semanticSidecarOnly === true && implicitReadGetTarget) {
        const typeFacts = result.compilerStorageTypeFacts;
        const typeName = compilerPrimitiveTypeName(typeFacts?.storageType);
        const declarationRange = result.compilerStorageTypeDeclarationRange;
        if (model.partial || result.compilerStorageClass !== "local" || !typeName || typeName.length > 512 ||
            implicitReadGetTarget.continuedAssignment &&
                (declarationRange?.line !== line || declarationRange.startColumn !== implicitReadGetTarget.startColumn ||
                    declarationRange.endColumn !== implicitReadGetTarget.endColumn) ||
            name.range.start.character !== implicitReadGetTarget.startColumn ||
            name.range.end.character !== implicitReadGetTarget.endColumn ||
            normalizeIdentifier(name.name) !== normalizeIdentifier(implicitReadGetTarget.name)) return actions;
        entry = {
            name: implicitReadGetTarget.name,
            declaration: {
                type: "variable",
                name: implicitReadGetTarget.name,
                typeName,
                line,
                startColumn: implicitReadGetTarget.startColumn,
                endColumn: implicitReadGetTarget.endColumn,
                signature: `variable ${implicitReadGetTarget.name} As ${typeName}`,
                provisional: false
            },
            compilerFacts: { ...typeFacts, compilerStorageClass: result.compilerStorageClass }
        };
    } else if (candidates.length === 0 && model.semanticSidecarOnly === true && implicitForCounter) {
        const typeFacts = result.compilerStorageTypeFacts;
        const typeName = compilerPrimitiveTypeName(typeFacts?.storageType);
        if (model.partial || result.compilerStorageClass !== "local" || !typeName || typeName.length > 512 ||
            name.range.start.character !== implicitForCounter.startColumn ||
            name.range.end.character !== implicitForCounter.endColumn ||
            normalizeIdentifier(name.name) !== normalizeIdentifier(implicitForCounter.name)) return actions;
        entry = {
            name: implicitForCounter.name,
            declaration: {
                type: "variable",
                name: implicitForCounter.name,
                typeName,
                line,
                startColumn: implicitForCounter.startColumn,
                endColumn: implicitForCounter.endColumn,
                signature: `variable ${implicitForCounter.name} As ${typeName}`,
                provisional: false
            },
            compilerFacts: { ...typeFacts, compilerStorageClass: result.compilerStorageClass }
        };
    } else {
        return actions;
    }

    const declaration = entry.declaration;
    const compilerFacts = entry.compilerFacts || declaration.compilerFacts;
    const inputs = compilerFacts?.declarationInputs;
    const input = Array.isArray(inputs) && inputs.length === 1 ? inputs[0] : null;
    const group = input?.group;
    const completeInput = Boolean(input && input.provisional !== true && group && group.provisional !== true &&
        Number.isSafeInteger(group.count) && group.count > 0 && Number.isSafeInteger(input.ordinal) && input.ordinal > 0 &&
        Number.isSafeInteger(input.symbol) && input.symbol > 0 &&
        ["dim", "static", "common", "extern", "const", "var"].includes(group.kind));
    const implicitType = completeInput && (input.writtenType === "implicit" ||
        group.kind === "const" && input.writtenType === "inferred");
    const inferredVarType = completeInput && group.kind === "var" && group.count === 1 &&
        input.writtenType === "inferred";
    const suffixType = completeInput && input.writtenType === "suffix";
    const suffixTypeFormUnavailable = !Array.isArray(inputs) || inputs.length === 0;
    const typeName = declaration.typeName || entry.nativeSymbol?.typeName ||
        compilerPrimitiveTypeName(compilerFacts?.storageType);
    const compilerStorageClass = compilerFacts?.compilerStorageClass;
    const compilerName = String(declaration.name || entry.name || "");
    const normalizedSignature = String(declaration.signature || "").replace(/\s+/g, " ").trim().toLowerCase();
    const expectedImplicitSignature = `variable ${compilerName} as ${typeName}`.replace(/\s+/g, " ").trim().toLowerCase();
    if (implicitRedimTarget && model.semanticSidecarOnly !== true) {
        const redimTypeName = compilerPrimitiveTypeName(compilerFacts?.storageType);
        const validStorageClass = implicitRedimTarget.moduleScope
            ? ["static", "shared", "global"].includes(compilerStorageClass)
            : compilerStorageClass === "local";
        if (model.partial || declaration.type !== "variable" || declaration.provisional === true ||
            !validStorageClass || !redimTypeName || redimTypeName.length > 512 ||
            /[\r\n]/.test(redimTypeName) || declaration.line !== line ||
            declaration.startColumn !== implicitRedimTarget.startColumn ||
            declaration.endColumn !== implicitRedimTarget.endColumn ||
            normalizeIdentifier(compilerName) !== normalizeIdentifier(implicitRedimTarget.name)) return actions;
        if (implicitRedimTarget.moduleScope) {
            const typePosition = compilerRedimTargetTypeInsertionPosition(document, implicitRedimTarget);
            if (!typePosition) return actions;
            const action = new vscode.CodeAction(
                `Make implicit array type explicit as '${redimTypeName}'`,
                vscode.CodeActionKind.RefactorRewrite
            );
            action.edit = new vscode.WorkspaceEdit();
            action.edit.insert(document.uri,
                new vscode.Position(typePosition.line, typePosition.character), ` As ${redimTypeName}`);
            actions.push(action);
            return actions;
        }

        const action = new vscode.CodeAction(
            `Declare implicit array as '${redimTypeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        const insertionLine = implicitRedimTarget.statementStartLine ?? line;
        const insertionLineText = document.lineAt(insertionLine).text;
        const indentation = /^\s*/.exec(insertionLineText)?.[0] || "";
        const lineEnding = document.getText().match(/\r\n|\n|\r/)?.[0] || "\n";
        action.edit.insert(document.uri, new vscode.Position(insertionLine, 0),
            `${indentation}Dim ${implicitRedimTarget.name}() As ${redimTypeName}${lineEnding}`);
        actions.push(action);
        return actions;
    }
    /*
        FBC locates an implicit local at its first write. Require its compiler
        signature and physical assignment to agree before turning that write
        into a declaration.
    */
    if (implicitLocalAssignment && declaration.type === "variable" && compilerStorageClass === "local" &&
        typeof typeName === "string" && typeName && typeName.length <= 512 && !/[\r\n]/.test(typeName) &&
        Number.isSafeInteger(declaration.startColumn) && Number.isSafeInteger(declaration.endColumn) &&
        declaration.startColumn === implicitAssignmentNameStart &&
        declaration.endColumn === declaration.startColumn + implicitAssignmentName.length &&
        compilerName.toLowerCase() === implicitAssignmentName.toLowerCase() &&
        normalizedSignature === expectedImplicitSignature) {
        const action = new vscode.CodeAction(
            `Declare implicit local as '${typeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, new vscode.Range(
            line, implicitAssignmentReplacementStart, line, declaration.endColumn
        ), `Dim ${implicitAssignmentName} As ${typeName}`);
        actions.push(action);
    }

    if ((implicitCompoundLocalAssignment || implicitSwapTarget || implicitLsetRsetTarget) &&
        declaration.type === "variable" && compilerStorageClass === "local" &&
        typeName && typeName.length <= 512 && !/[\r\n]/.test(typeName) &&
        declaration.startColumn === (implicitCompoundLocalAssignment
            ? implicitCompoundAssignmentTarget.startColumn : implicitSwapTarget?.startColumn ?? implicitLsetRsetTarget.startColumn) &&
        declaration.endColumn === (implicitCompoundLocalAssignment
            ? implicitCompoundAssignmentTarget.endColumn : implicitSwapTarget?.endColumn ?? implicitLsetRsetTarget.endColumn) &&
        normalizeIdentifier(compilerName) === normalizeIdentifier(
            (implicitCompoundLocalAssignment
                ? implicitCompoundAssignmentTarget.name : implicitSwapTarget?.name ?? implicitLsetRsetTarget.name)
        )) {
        const target = implicitCompoundLocalAssignment
            ? implicitCompoundAssignmentTarget
            : implicitSwapTarget || implicitLsetRsetTarget;
        const action = new vscode.CodeAction(
            `Declare implicit local as '${typeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        const insertionLine = target.statementStartLine ?? line;
        const insertionLineText = document.lineAt(insertionLine).text;
        const indentation = /^\s*/.exec(insertionLineText)?.[0] || "";
        const lineEnding = document.getText().match(/\r\n|\n|\r/)?.[0] || "\n";
        action.edit.insert(document.uri, new vscode.Position(insertionLine, 0),
            `${indentation}Dim ${target.name} As ${typeName}${lineEnding}`);
        actions.push(action);
        return actions;
    }

    if (implicitReadGetTarget && declaration.type === "variable" && compilerStorageClass === "local" &&
        typeName && typeName.length <= 512 && !/[\r\n]/.test(typeName) &&
        (!implicitReadGetTarget.continuedAssignment || declaration.line === line) &&
        declaration.startColumn === implicitReadGetTarget.startColumn &&
        declaration.endColumn === implicitReadGetTarget.endColumn &&
        normalizeIdentifier(compilerName) === normalizeIdentifier(implicitReadGetTarget.name)) {
        const action = new vscode.CodeAction(
            `Declare implicit local as '${typeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        const insertionLine = implicitReadGetTarget.statementStartLine ?? line;
        const insertionLineText = document.lineAt(insertionLine).text;
        const indentation = /^\s*/.exec(insertionLineText)?.[0] || "";
        const lineEnding = document.getText().match(/\r\n|\n|\r/)?.[0] || "\n";
        action.edit.insert(document.uri, new vscode.Position(insertionLine, 0),
            `${indentation}Dim ${implicitReadGetTarget.name} As ${typeName}${lineEnding}`);
        actions.push(action);
        return actions;
    }

    if (implicitForCounter && declaration.type === "variable" && compilerStorageClass === "local" &&
        typeName && typeName.length <= 512 && !/[\r\n]/.test(typeName) &&
        declaration.startColumn === implicitForCounter.startColumn &&
        declaration.endColumn === implicitForCounter.endColumn &&
        normalizeIdentifier(compilerName) === normalizeIdentifier(implicitForCounter.name)) {
        const action = new vscode.CodeAction(
            `Make loop counter type explicit as '${typeName}'`,
            vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        action.edit.insert(document.uri, new vscode.Position(line, implicitForCounter.endColumn), ` As ${typeName}`);
        actions.push(action);
        return actions;
    }

    const suffixRange = parameterTypeSuffixRange(lineText, declaration, entry.name);
    const typeInsertionColumn = implicitParameterTypeInsertionColumn(lineText, declaration);
    const byRefDeclaration = /\bbyref\b/i.test(maskFreeBasicText(lineText.slice(0, declaration.startColumn)));
    const exactHeader = exactProcedureHeaderEnd(document, declaration, lineText) ||
        suffixRange && exactProcedureHeaderWithoutParameterSuffix(document, declaration, lineText, suffixRange);
    if (typeof typeName !== "string" || !typeName || typeName.length > 512 || /[\r\n]/.test(typeName) ||
        !exactHeader) return actions;

    if (implicitType && !suffixRange && !byRefDeclaration) {
        if (Number.isSafeInteger(typeInsertionColumn) && !/^\s*As\b/i.test(lineText.slice(typeInsertionColumn))) {
            const insertionOffset = sourceOffsetAt(document, line, typeInsertionColumn);
            const insertionPosition = document.positionAt(insertionOffset);
            const declarationKind = declaration.type === "const" ? "constant" : "variable";
            const action = new vscode.CodeAction(`Add explicit ${declarationKind} type '${typeName}'`, vscode.CodeActionKind.RefactorRewrite);
            action.edit = new vscode.WorkspaceEdit();
            action.edit.insert(document.uri, insertionPosition, ` As ${typeName}`);
            actions.push(action);
        }
    }

    if (inferredVarType && !suffixRange) {
        const varKeyword = lineText.match(/^(\s*)var\b/i);
        const varKeywordStart = varKeyword ? varKeyword[1].length : -1;
        const afterKeyword = varKeywordStart < 0 ? "" : lineText.slice(varKeywordStart + 3).trimStart();
        const initializer = lineText.slice(typeInsertionColumn).trimStart();
        if (varKeywordStart >= 0 && !/^(?:shared|byref)\b/i.test(afterKeyword) &&
            /^(?:=>|=)/.test(initializer) && Number.isSafeInteger(typeInsertionColumn) &&
            !/^\s*As\b/i.test(lineText.slice(typeInsertionColumn))) {
            const action = new vscode.CodeAction(
                `Make inferred Var type explicit as '${typeName}'`,
                vscode.CodeActionKind.RefactorRewrite
            );
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, new vscode.Range(line, varKeywordStart, line, varKeywordStart + 3), "Dim");
            const insertionOffset = sourceOffsetAt(document, line, typeInsertionColumn);
            action.edit.insert(document.uri, document.positionAt(insertionOffset), ` As ${typeName}`);
            actions.push(action);
        }
    }

    if (["variable", "const", "extern"].includes(declaration.type) && suffixRange && !byRefDeclaration &&
        (suffixType || suffixTypeFormUnavailable)) {
        const insertionColumn = implicitParameterTypeInsertionColumn(lineText, { ...declaration, endColumn: suffixRange.end });
        const constantArray = declaration.type === "const" && /^\s*\(/.test(lineText.slice(suffixRange.end));
        if (!constantArray && Number.isSafeInteger(insertionColumn) &&
            !/^\s*As\b/i.test(lineText.slice(insertionColumn))) {
            const declarationKind = declaration.type === "const" ? "constant" : "variable";
            const action = new vscode.CodeAction(
                `Replace ${declarationKind} type suffix with 'As ${typeName}'`,
                vscode.CodeActionKind.RefactorRewrite
            );
            action.edit = new vscode.WorkspaceEdit();
            if (insertionColumn === suffixRange.end) {
                action.edit.replace(document.uri, new vscode.Range(line, suffixRange.start, line, suffixRange.end), ` As ${typeName}`);
            } else {
                action.edit.delete(document.uri, new vscode.Range(line, suffixRange.start, line, suffixRange.end));
                const insertionOffset = sourceOffsetAt(document, line, insertionColumn);
                action.edit.insert(document.uri, document.positionAt(insertionOffset), ` As ${typeName}`);
            }
            actions.push(action);
        }
    }

    return actions;
}

function exactProcedureHeaderEnd(document, declaration, lineText) {
    if (declaration.line < 0 || typeof declaration.signature !== "string") return null;
    const signature = declaration.signature.replace(/\s+/g, " ").trim().toLowerCase();
    const sourceLine = lineText.replace(/\s+/g, " ").trim().toLowerCase();
    if (!signature || signature !== sourceLine) return null;
    return procedureHeaderInsertionPoint(document, declaration.line, lineText);
}

function procedureHeaderInsertionPoint(document, line, lineText) {
    if (!Number.isSafeInteger(line) || line < 0 || typeof document.offsetAt !== "function" ||
        typeof document.positionAt !== "function") return null;
    let column = lineText.length;
    while (column > 0 && /\s/.test(lineText[column - 1])) column--;
    if (!column) return null;
    const offset = sourceOffsetAt(document, line, column);
    return { column, position: document.positionAt(offset) };
}

function continuedProcedureHeaderTypeInsertionPoint(document, declaration, line, nameEndColumn) {
    const endLine = declaration?.signatureEndLine;
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(endLine) || endLine <= line ||
        endLine - line > MAX_IMPLICIT_TARGET_STATEMENT_LINES || !Number.isSafeInteger(nameEndColumn) ||
        typeof document.offsetAt !== "function" || typeof document.positionAt !== "function") return null;
    const finalLine = document.lineAt(endLine).text;
    const startOffset = sourceOffsetAt(document, line, nameEndColumn);
    const endOffset = sourceOffsetAt(document, endLine, finalLine.length);
    const source = document.getText();
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 ||
        endOffset < startOffset || endOffset > source.length ||
        endOffset - startOffset > MAX_PROCEDURE_HEADER_SCAN_CHARACTERS) return null;

    const maskedHeader = maskFreeBasicText(source.slice(startOffset, endOffset));
    const openingParenthesis = maskedHeader.indexOf("(");
    if (openingParenthesis < 0) return null;
    let depth = 0;
    let closingParenthesis = -1;
    for (let index = openingParenthesis; index < maskedHeader.length; index++) {
        if (maskedHeader[index] === "(") {
            depth++;
        } else if (maskedHeader[index] === ")") {
            depth--;
            if (depth === 0) {
                closingParenthesis = index;
                break;
            }
            if (depth < 0) return null;
        }
    }
    if (closingParenthesis < 0) return null;

    const insertionPosition = document.positionAt(startOffset + closingParenthesis + 1);
    if (insertionPosition.line !== endLine ||
        !/^\s*(?:override\b\s*)?$/i.test(maskedHeader.slice(closingParenthesis + 1))) return null;
    return { column: insertionPosition.character, position: insertionPosition };
}

function continuedProcedureHeaderEndInsertionPoint(document, declaration, line) {
    const endLine = declaration?.signatureEndLine;
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(endLine) || endLine <= line ||
        endLine - line > MAX_IMPLICIT_TARGET_STATEMENT_LINES ||
        typeof document.offsetAt !== "function" || typeof document.positionAt !== "function") return null;
    const finalLine = document.lineAt(endLine).text;
    const startOffset = sourceOffsetAt(document, line, 0);
    const endOffset = sourceOffsetAt(document, endLine, finalLine.length);
    const finalLineOffset = sourceOffsetAt(document, endLine, 0) - startOffset;
    const source = document.getText();
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) ||
        !Number.isSafeInteger(finalLineOffset) || startOffset < 0 || finalLineOffset < 0 ||
        endOffset < startOffset || endOffset > source.length ||
        endOffset - startOffset > MAX_PROCEDURE_HEADER_SCAN_CHARACTERS) return null;

    const maskedHeader = maskFreeBasicText(source.slice(startOffset, endOffset));
    const finalLineCode = maskedHeader.slice(finalLineOffset);
    if (finalLineCode.includes(":") || /(?:^|\s)_\s*$/.test(finalLineCode)) return null;
    let insertionColumn = finalLineCode.length;
    while (insertionColumn > 0 && /\s/.test(finalLineCode[insertionColumn - 1])) insertionColumn--;
    if (!insertionColumn) return null;
    const insertionPosition = document.positionAt(startOffset + finalLineOffset + insertionColumn);
    if (insertionPosition.line !== endLine) return null;
    return { column: insertionPosition.character, position: insertionPosition };
}

function mismatchedNextCounterCodeAction(vscode, document, text, diagnostic) {
    const contextLabel = compilerDiagnosticContextLabel("for-next-variable-mismatch");
    const bindingContextLabel = compilerDiagnosticContextLabel("for-next-counter-binding");
    const message = String(diagnostic.message || "");
    const mismatchedCounter = Boolean(contextLabel && message.includes(`Compiler context: ${contextLabel}`));
    const undeclaredCounter = diagnostic.severity === vscode.DiagnosticSeverity.Error && bindingContextLabel &&
        message.includes(`Compiler context: ${bindingContextLabel}`)
        ? message.match(/(?:variable|symbol)\s+not\s+declared,\s*`?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)`?/i)?.[1]
        : null;
    if (!mismatchedCounter && !undeclaredCounter) return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const identifier = forNextCounterIdentifierRange(text, line);
    if (!identifier || !(
        diagnostic.range.start.character === identifier.startCharacter ||
        diagnostic.range.start.character <= identifier.startCharacter && diagnostic.range.end.character >= identifier.endCharacter
    )) return null;
    if (undeclaredCounter && identifier.name.toLowerCase() !== undeclaredCounter.toLowerCase()) return null;

    const action = new vscode.CodeAction(
        mismatchedCounter
            ? `Remove mismatched '${identifier.name}' after NEXT`
            : `Remove undeclared '${identifier.name}' after NEXT`,
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.delete(document.uri, new vscode.Range(
        identifier.line,
        identifier.startCharacter,
        identifier.line,
        identifier.endCharacter
    ));
    return action;
}

function activeForCountersBeforeLine(sourceText, targetLine) {
    if (typeof sourceText !== "string" || sourceText.length > 2_000_000 ||
        !Number.isSafeInteger(targetLine) || targetLine < 0) return null;
    const lines = maskFreeBasicText(sourceText).split(/\r\n|\n|\r/);
    if (targetLine >= lines.length) return null;
    const counters = [];
    let conditionalDepth = 0;

    for (let line = 0; line < targetLine; line++) {
        const code = String(lines[line] || "").trim();
        if (!code) continue;
        if (/^#(?:if|ifdef|ifndef)\b/i.test(code)) {
            if (counters.length) return null;
            conditionalDepth++;
            continue;
        }
        if (/^#(?:else|elseif|endif)\b/i.test(code)) {
            if (counters.length) return null;
            if (/^#endif\b/i.test(code)) {
                if (conditionalDepth === 0) return null;
                conditionalDepth--;
            }
            continue;
        }
        if (code.startsWith("#")) {
            if (counters.length) return null;
            continue;
        }
        if (code.includes(":")) {
            if (counters.length) return null;
            continue;
        }

        const forMatch = code.match(/^for\s+(?:each\s+)?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)(?:\s+as\b.*?)?\s*(?:=|\bin\b)/i);
        if (forMatch) {
            if (conditionalDepth > 0) return null;
            counters.push(forMatch[1]);
            continue;
        }

        if (/^next\b/i.test(code)) {
            if (!counters.length) return null;
            if (/^next\s*$/i.test(code)) {
                counters.pop();
                continue;
            }
            const statement = forNextCounterIdentifiers(sourceText, line);
            if (!statement || statement.counters.length > counters.length) return null;
            for (const identifier of statement.counters) {
                if (identifier.name.toLowerCase() !== counters.at(-1).toLowerCase()) return null;
                counters.pop();
            }
            continue;
        }

        if (/^end\s+(?:sub|function|property|constructor|destructor|operator)\b/i.test(code) && counters.length) return null;
    }

    return conditionalDepth === 0 ? counters : null;
}

function activeForCounterBeforeLine(sourceText, targetLine) {
    const counters = activeForCountersBeforeLine(sourceText, targetLine);
    return Array.isArray(counters) ? counters.at(-1) || "" : "";
}

async function mismatchedNextCounterTypoCodeAction(vscode, workspaceIndex, document, text, diagnostic,
    libraryTypeNames, token) {
    if (!workspaceIndex || typeof workspaceIndex.getParsedDocument !== "function") return null;
    const message = String(diagnostic.message || "");
    const mismatchContext = compilerDiagnosticContextLabel("for-next-variable-mismatch");
    const bindingContext = compilerDiagnosticContextLabel("for-next-counter-binding");
    const mismatchedCounter = mismatchContext && message.includes(`Compiler context: ${mismatchContext}`);
    const undeclaredCounter = bindingContext && message.includes(`Compiler context: ${bindingContext}`)
        ? message.match(/(?:variable|symbol)\s+not\s+declared,\s*`?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)`?/i)?.[1]
        : "";
    if (!mismatchedCounter && !undeclaredCounter) return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const statement = forNextCounterIdentifiers(text, line);
    if (!statement || statement.counters.length < 2) return null;
    const counters = activeForCountersBeforeLine(text, line);
    if (!Array.isArray(counters) || !counters.length || statement.counters.length > counters.length) return null;

    const mismatchedIndexes = [];
    for (let index = 0; index < statement.counters.length; index++) {
        const expected = counters[counters.length - index - 1];
        if (statement.counters[index].name.toLowerCase() !== expected.toLowerCase()) mismatchedIndexes.push(index);
    }
    if (mismatchedIndexes.length !== 1) return null;
    const index = mismatchedIndexes[0];
    const identifier = statement.counters[index];
    if (undeclaredCounter && normalizeIdentifier(identifier.name) !== normalizeIdentifier(undeclaredCounter)) return null;
    if (diagnostic.range.start.character > identifier.startCharacter ||
        diagnostic.range.end.character < identifier.endCharacter) return null;
    const expectedCounter = counters[counters.length - index - 1];
    if (identifierEditDistanceAtMostOne(identifier.name, expectedCounter) !== 1) return null;

    return undeclaredNameTypoCodeAction(
        vscode, workspaceIndex, document, diagnostic, identifier.name, false, libraryTypeNames, token,
        expectedCounter
    );
}

function meaninglessNextVariableCodeAction(vscode, document, text, diagnostic, relatedDiagnostics = []) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning) return null;
    const reported = String(diagnostic.message || "").match(/^Variable following NEXT is meaningless,\s*([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)$/i)?.[1];
    if (!reported) return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    if (relatedDiagnostics.some((entry) => entry !== diagnostic &&
        entry.severity === vscode.DiagnosticSeverity.Error &&
        /^fbc(?:\s|$)/i.test(entry.source || "") && entry.range?.start?.line === line)) return null;

    const statement = forNextCounterIdentifiers(text, line);
    const identifiers = statement?.counters.filter((identifier) =>
        identifier.name.toLowerCase() === reported.toLowerCase() &&
        diagnostic.range.start.character <= identifier.startCharacter &&
        diagnostic.range.end.character >= identifier.endCharacter
    ) || [];
    if (identifiers.length !== 1) return null;

    const identifier = identifiers[0];
    const multiCounter = statement.counters.length > 1;
    const action = new vscode.CodeAction(
        multiCounter
            ? `Split NEXT counters into separate statements and remove redundant names`
            : `Remove meaningless '${identifier.name}' after NEXT`,
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    if (!multiCounter) {
        action.edit.delete(document.uri, new vscode.Range(
            identifier.line,
            identifier.startCharacter,
            identifier.line,
            identifier.endCharacter
        ));
    } else {
        const lineText = document.lineAt(line).text;
        const lineEnding = vscode.EndOfLine && document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
        const nextStatements = Array(statement.counters.length)
            .fill(`${statement.indentation}${statement.keyword}`)
            .join(lineEnding);
        action.edit.replace(document.uri, new vscode.Range(line, 0, line, lineText.length),
            `${nextStatements}${statement.trailingText}`);
    }
    return action;
}

function ignoredDeclarationSuffixCodeAction(vscode, document, text, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning) return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const conflict = compilerIgnoredDeclarationSuffixRange(text, {
        ...diagnostic,
        severity: "warning",
        physicalPoint: { line }
    });
    if (!conflict || diagnostic.range.start.character > conflict.startCharacter ||
        diagnostic.range.end.character < conflict.endCharacter) return null;

    const action = new vscode.CodeAction(
        conflict.hasExplicitAsType
            ? `Remove ignored '${conflict.suffix}' suffix from '${conflict.name}' (use the AS type)`
            : `Remove ignored '${conflict.suffix}' suffix from '${conflict.name}'`,
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.delete(document.uri, new vscode.Range(
        conflict.line,
        conflict.suffixStartCharacter,
        conflict.line,
        conflict.endCharacter
    ));
    return action;
}

function missingClosingQuoteCodeAction(vscode, document, text, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning) return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const missingQuote = compilerMissingClosingQuoteRange(text, {
        ...diagnostic,
        severity: "warning",
        physicalPoint: { line, character: diagnostic.range.start.character }
    });
    if (!missingQuote || diagnostic.range.start.character > missingQuote.startCharacter ||
        diagnostic.range.end.character < missingQuote.endCharacter) return null;

    const action = new vscode.CodeAction("Insert missing closing quote at end of line", vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, new vscode.Position(line, missingQuote.insertionCharacter), '"');
    return action;
}

function possibleEscapeStringCodeAction(vscode, document, text, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning) return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const literal = compilerPossibleEscapeStringRange(text, {
        ...diagnostic,
        severity: "warning",
        physicalPoint: { line, character: diagnostic.range.start.character }
    });
    if (!literal || diagnostic.range.start.character > literal.startCharacter ||
        diagnostic.range.end.character < literal.endCharacter) return null;

    const action = new vscode.CodeAction(
        "Prefix with ! to interpret C-style escape sequences",
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, new vscode.Position(literal.line, literal.startCharacter), "!");
    return action;
}

function byRefFunctionResultAssignmentCodeAction(vscode, document, text, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning ||
        !/^fbc(?:\s|$)/i.test(diagnostic.source || "") || !diagnostic.range?.start || !diagnostic.range?.end) return null;
    const assignment = compilerByRefFunctionResultAssignmentRange(text, {
        ...diagnostic,
        severity: "warning",
        line: diagnostic.range.start.line
    });
    if (!assignment || diagnostic.range.start.line !== assignment.line || diagnostic.range.end.line !== assignment.line ||
        diagnostic.range.start.character > assignment.startCharacter ||
        diagnostic.range.end.character < assignment.endCharacter) return null;

    const action = new vscode.CodeAction(
        "Wrap function call in parentheses to assign to its BYREF result",
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, new vscode.Position(assignment.line, assignment.callStartCharacter), "(");
    action.edit.insert(document.uri, new vscode.Position(assignment.line, assignment.callEndCharacter), ")");
    return action;
}

function elseIfBranchCodeAction(vscode, document, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning ||
        !/^fbc(?:\s|$)/i.test(diagnostic.source || "") ||
        String(diagnostic.message || "").split("\n\n")[0] !==
            "'IF' statement found directly after multi-line 'ELSE'") return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const sourceLine = document.lineAt(line).text;
    const maskedLine = maskFreeBasicText(sourceLine);
    const match = /^(\s*)else(\s+)if\b/i.exec(maskedLine);
    if (!match) return null;
    const replacementStart = match[1].length;
    const replacementEnd = match[0].length;
    const ifStart = replacementEnd - 2;
    const coversIf = diagnostic.range.start.character <= ifStart &&
        diagnostic.range.end.character >= ifStart + 2;
    const coversPrefix = diagnostic.range.start.character <= replacementStart &&
        diagnostic.range.end.character >= replacementEnd;
    if (!coversIf && !coversPrefix) return null;

    const action = new vscode.CodeAction(
        "Change nested 'Else If' to an 'ElseIf' branch",
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, new vscode.Range(line, replacementStart, line, replacementEnd), "ElseIf");
    return action;
}

function forCounterWrapWarningCodeAction(vscode, workspaceIndex, document, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning ||
        !/^fbc(?:\s|$)/i.test(diagnostic.source || "") ||
        String(diagnostic.message || "").split("\n\n")[0].trim() !==
            "FOR counter variable is unable to exceed limit value") return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line ||
        document.lineAt(line).text.length > 65536) return null;
    const maskedLine = maskFreeBasicText(document.lineAt(line).text);
    const inlineCounter = /^(\s*for\s+[A-Za-z_][A-Za-z0-9_]*[$%!#&]?\s+as\s+)(ubyte|byte|ushort|short|uinteger|integer|ulong|long)\b(?=\s*=)/i
        .exec(maskedLine);
    if (inlineCounter) {
        const widerType = widerForCounterType(inlineCounter[2]);
        if (!widerType) return null;
        const typeStart = inlineCounter[1].length;
        const action = new vscode.CodeAction(
            "Widen FOR counter to '" + widerType + "' to avoid wraparound",
            vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diagnostic];
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, new vscode.Range(
            line, typeStart, line, typeStart + inlineCounter[2].length
        ), widerType);
        return action;
    }

    const forCounter = /^(\s*for\s+)([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*=/i.exec(maskedLine);
    if (!forCounter) return null;
    const limit = /\bto\b/i.exec(maskedLine.slice(forCounter[0].length));
    if (!limit) return null;
    let limitStart = forCounter[0].length + limit.index + limit[0].length;
    while (limitStart < maskedLine.length && /\s/.test(maskedLine[limitStart])) limitStart++;
    if (!Number.isSafeInteger(diagnostic.range.start.character) ||
        !Number.isSafeInteger(diagnostic.range.end.character) ||
        diagnostic.range.start.character < 0 || diagnostic.range.end.character < diagnostic.range.start.character) return null;
    if (limitStart >= maskedLine.length ||
        diagnostic.range.start.character > limitStart || diagnostic.range.end.character <= limitStart) return null;

    const counterCharacter = forCounter[1].length;
    workspaceIndex?.getParsedDocument?.(document);
    const sourceModel = workspaceIndex?.getSourceSemanticModel?.() ||
        workspaceIndex?.getSemanticModel?.(document.uri, { sourceOnly: true });
    if (typeof sourceModel?.resolveAt !== "function") return null;
    const resolved = sourceModel.resolveAt(document.uri, line, counterCharacter);
    if (resolved.length !== 1) return null;
    const declaration = resolved[0]?.declaration;
    if (!declaration || declaration.type !== "variable" || resolved[0].conditional === true ||
        resolved[0].provisional === true || declaration.provisional === true ||
        normalizeIdentifier(declaration.name || "") !== normalizeIdentifier(forCounter[2]) ||
        !["sub", "function", "property", "operator", "constructor", "destructor"]
            .includes(String(declaration.parentDeclaration?.type || "").toLowerCase()) ||
        !Number.isSafeInteger(declaration.line) || declaration.line < 0 || declaration.line >= document.lineCount) return null;

    const declarationText = document.lineAt(declaration.line).text;
    if (declarationText.length > 65536) return null;
    const maskedDeclaration = maskFreeBasicText(declarationText);
    const simpleDeclaration = /^(\s*dim\s+)([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)(\s+as\s+)(ubyte|byte|ushort|short|uinteger|integer|ulong|long)\s*$/i
        .exec(maskedDeclaration);
    if (!simpleDeclaration || normalizeIdentifier(simpleDeclaration[2]) !== normalizeIdentifier(forCounter[2]) ||
        normalizeIdentifier(simpleDeclaration[4]) !== normalizeIdentifier(declaration.typeName || "")) return null;
    const widerType = widerForCounterType(simpleDeclaration[4]);
    if (!widerType) return null;

    const action = new vscode.CodeAction(
        "Widen FOR counter to '" + widerType + "' to avoid wraparound",
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    const typeStart = simpleDeclaration[1].length + simpleDeclaration[2].length + simpleDeclaration[3].length;
    action.edit.replace(document.uri, new vscode.Range(
        declaration.line, typeStart,
        declaration.line, typeStart + simpleDeclaration[4].length
    ), widerType);
    return action;
}

function widerForCounterType(typeName) {
    const widerTypeByType = {
        byte: "Short",
        ubyte: "UShort",
        short: "Long",
        ushort: "ULong",
        integer: "LongInt",
        uinteger: "ULongInt",
        long: "LongInt",
        ulong: "ULongInt"
    };
    return widerTypeByType[String(typeName || "").toLowerCase()] || "";
}

function constantConversionOverflowCodeAction(vscode, document, text, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning ||
        !/^fbc(?:\s|$)/i.test(diagnostic.source || "") || !diagnostic.range?.start || !diagnostic.range?.end) return null;
    const conversion = compilerConstantConversionOverflowRange(text, {
        ...diagnostic,
        severity: "warning",
        line: diagnostic.range.start.line
    });
    if (!conversion || diagnostic.range.start.line !== conversion.line ||
        diagnostic.range.end.line !== conversion.line ||
        diagnostic.range.start.character > conversion.startCharacter ||
        diagnostic.range.end.character < conversion.endCharacter) return null;

    const action = new vscode.CodeAction(
        "Widen '" + conversion.name + "' from '" + conversion.sourceType +
            "' to '" + conversion.widerType + "' for this constant",
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, new vscode.Range(
        conversion.line, conversion.typeStartCharacter, conversion.line, conversion.typeEndCharacter
    ), conversion.widerType);
    return action;
}

function procedureParameterDefaultShape(parameter) {
    if (!parameter || typeof parameter.label !== "string") return "";
    return parameter.label.replace(/\s*=\s*[\s\S]*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function procedureHeadersMatchExceptDefault(first, second) {
    const modifiers = (procedure) => (procedure.modifiers || [])
        .filter((modifier) => normalizeIdentifier(modifier) !== "declare")
        .map(normalizeIdentifier)
        .sort();
    if (!first || !second || first.type !== second.type ||
        normalizeIdentifier(first.qualifiedName || first.name) !==
            normalizeIdentifier(second.qualifiedName || second.name) ||
        normalizeIdentifier(first.containerName || "") !== normalizeIdentifier(second.containerName || "") ||
        normalizeTypeName(first.typeName || "") !== normalizeTypeName(second.typeName || "") ||
        JSON.stringify(modifiers(first)) !== JSON.stringify(modifiers(second)) ||
        !Array.isArray(first.parameters) || !Array.isArray(second.parameters) ||
        first.parameters.length !== second.parameters.length) return false;
    return first.parameters.every((parameter, index) => {
        const other = second.parameters[index];
        return other && normalizeIdentifier(parameter.name || "") === normalizeIdentifier(other.name || "") &&
            normalizeTypeName(parameter.typeName || "") === normalizeTypeName(other.typeName || "") &&
            parameter.optional === other.optional && parameter.variadic === other.variadic &&
            procedureParameterDefaultShape(parameter) === procedureParameterDefaultShape(other);
    });
}

function simpleProcedureParameterDefaultText(text, allowContinuation = false) {
    let value = String(text ?? "").trim();
    if (allowContinuation) value = value.replace(/\s+_$/, "").trim();
    return SIMPLE_INTEGER_PARAMETER_DEFAULT.test(value) || SIMPLE_FLOAT_PARAMETER_DEFAULT.test(value) ||
        /^(?:true|false)$/i.test(value) || /^"[^"\r\n]*"$/.test(value) ||
        SIMPLE_IDENTIFIER_PARAMETER_DEFAULT.test(value) ||
        SIMPLE_QUALIFIED_IDENTIFIER_PARAMETER_DEFAULT.test(value) ? value : "";
}

function simpleProcedureParameterDefault(label) {
    const match = /=\s*([\s\S]+?)\s*$/.exec(String(label || ""));
    return match ? simpleProcedureParameterDefaultText(match[1]) : "";
}

function sameSimpleProcedureParameterDefault(first, second) {
    if (SIMPLE_INTEGER_PARAMETER_DEFAULT.test(first) && SIMPLE_INTEGER_PARAMETER_DEFAULT.test(second)) {
        return normalizeIdentifier(first) === normalizeIdentifier(second);
    }
    if (SIMPLE_FLOAT_PARAMETER_DEFAULT.test(first) && SIMPLE_FLOAT_PARAMETER_DEFAULT.test(second)) {
        return normalizeIdentifier(first) === normalizeIdentifier(second);
    }
    if (/^(?:true|false)$/i.test(first) && /^(?:true|false)$/i.test(second)) {
        return normalizeIdentifier(first) === normalizeIdentifier(second);
    }
    if (SIMPLE_IDENTIFIER_PARAMETER_DEFAULT.test(first) && SIMPLE_IDENTIFIER_PARAMETER_DEFAULT.test(second)) {
        return normalizeIdentifier(first) === normalizeIdentifier(second);
    }
    if (SIMPLE_QUALIFIED_IDENTIFIER_PARAMETER_DEFAULT.test(first) &&
        SIMPLE_QUALIFIED_IDENTIFIER_PARAMETER_DEFAULT.test(second)) {
        return normalizeIdentifier(first) === normalizeIdentifier(second);
    }
    return /^"[^"\r\n]*"$/.test(first) && /^"[^"\r\n]*"$/.test(second) && first === second;
}

function procedureParameterSimpleDefaultRange(document, procedure, ordinal, expectedValue, parsed = null) {
    const line = procedure?.line;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(procedure.signatureEndLine) ||
        procedure.signatureEndLine < line) return null;
    if (procedure.signatureEndLine !== line) {
        const parameters = (parsed?.declarations || []).filter((declaration) =>
            declaration.type === "parameter" && declaration.parentDeclaration === procedure
        );
        const parameter = parameters[ordinal];
        if (!parameter || normalizeIdentifier(parameter.name || "") !==
            normalizeIdentifier(procedure.parameters?.[ordinal]?.name || "") ||
            !Number.isSafeInteger(parameter.line) || parameter.line < line ||
            parameter.line > procedure.signatureEndLine || !Number.isSafeInteger(parameter.startColumn)) return null;
        const lineText = document.lineAt(parameter.line).text;
        if (lineText.length > 65536 || parameter.startColumn >= lineText.length) return null;
        const sourceParameterText = lineText.slice(parameter.startColumn);
        const parameterText = maskFreeBasicText(lineText).slice(parameter.startColumn);
        const name = /^[A-Za-z_][A-Za-z0-9_.$%!#&]*/.exec(parameterText);
        if (!name || normalizeIdentifier(name[0]) !== normalizeIdentifier(parameter.name || "")) return null;
        const equalities = [...parameterText.matchAll(/=/g)];
        if (equalities.length !== 1) return null;
        const equals = equalities[0].index;
        const defaultText = sourceParameterText.slice(equals + 1);
        const value = simpleProcedureParameterDefaultText(defaultText, true);
        if (!value || !sameSimpleProcedureParameterDefault(value, expectedValue)) return null;
        const leadingWhitespace = defaultText.length - defaultText.trimStart().length;
        const startCharacter = parameter.startColumn + equals + 1 + leadingWhitespace;
        return { line: parameter.line, startCharacter, endCharacter: startCharacter + value.length };
    }
    if (!Number.isSafeInteger(procedure.endColumn)) return null;
    const lineText = document.lineAt(line).text;
    if (lineText.length > 65536) return null;
    const maskedLine = maskFreeBasicText(lineText);
    const openingParenthesis = maskedLine.indexOf("(", procedure.endColumn);
    const argument = byRefArgumentRangeOnLine(maskedLine, openingParenthesis, ordinal);
    if (!argument) return null;
    const parameterText = maskedLine.slice(argument.start, argument.end);
    const equalities = [...parameterText.matchAll(/=/g)];
    if (equalities.length !== 1) return null;
    const equals = equalities[0].index;
    const defaultText = lineText.slice(argument.start + equals + 1, argument.end);
    const value = simpleProcedureParameterDefaultText(defaultText);
    if (!value || !sameSimpleProcedureParameterDefault(value, expectedValue)) return null;
    const leadingWhitespace = defaultText.length - defaultText.trimStart().length;
    const startCharacter = argument.start + equals + 1 + leadingWhitespace;
    return { line, startCharacter, endCharacter: startCharacter + value.length };
}

function simpleParameterDefaultReferenceRange(defaultRange, defaultName) {
    if (SIMPLE_IDENTIFIER_PARAMETER_DEFAULT.test(defaultName)) return defaultRange;
    if (!SIMPLE_QUALIFIED_IDENTIFIER_PARAMETER_DEFAULT.test(defaultName) || !defaultRange) return null;
    const memberStart = defaultName.lastIndexOf(".") + 1;
    const memberName = defaultName.slice(memberStart);
    if (!memberName) return null;
    return {
        line: defaultRange.line,
        startCharacter: defaultRange.startCharacter + memberStart,
        endCharacter: defaultRange.startCharacter + memberStart + memberName.length
    };
}

async function compilerSnapshotParameterDeclarations(workspaceIndex, document, implementation, model, token) {
    const analysis = workspaceIndex.compilerAnalysis;
    const snapshot = analysis?.snapshotFor?.(document.uri);
    if (!model || !snapshot || snapshot.model !== model || !Array.isArray(snapshot.sources)) return null;
    if (token?.isCancellationRequested) return [];

    const procedureLeaf = normalizeIdentifier(
        String(implementation.qualifiedName || implementation.name || "").split(".").at(-1)
    );
    if (!procedureLeaf) return [];
    const candidates = [];
    let candidateFiles = 0;
    let candidateCharacters = 0;
    for (const source of snapshot.sources) {
        if (!source?.uri || typeof source.text !== "string" ||
            !source.text.toLowerCase().includes(procedureLeaf)) continue;
        candidateFiles++;
        if (candidateFiles > MAX_PARAMETER_DEFAULT_PROTOTYPE_SOURCES || source.text.length > 2_000_000) return [];
        candidateCharacters += source.text.length;
        if (candidateCharacters > MAX_PARAMETER_DEFAULT_PROTOTYPE_CHARACTERS) return [];

        const parsed = parseFreeBasicText(source.text);
        const declarations = (parsed.declarations || []).filter((declaration) =>
            ["sub", "function", "property", "operator"].includes(declaration.type) &&
            declaration.modifiers?.includes("DECLARE") &&
            normalizeIdentifier(declaration.name || "") === procedureLeaf &&
            procedureHeadersMatchExceptDefault(implementation, declaration)
        );
        if (!declarations.length) continue;

        const sourceDocument = createDocumentModel(source.uri, parsed);
        const sourceLines = source.text.split(/\r\n|\n|\r/);
        const textDocument = {
            uri: source.uri,
            lineCount: sourceLines.length,
            lineAt: (line) => ({ text: sourceLines[line] || "" })
        };
        for (const declaration of declarations) {
            const entry = sourceDocument.entries.find((candidate) => candidate.declaration === declaration);
            if (!entry || entry.conditional) return [];
            candidates.push({ declaration, parsed, sourceDocument: textDocument, uri: source.uri, sourceText: source.text });
            if (candidates.length > 1) return [];
        }
    }
    return candidates;
}

function compilerConstantDefaultResolvesAtImplementation(
    workspaceIndex, document, implementation, ordinal, prototype, defaultName, implementationRange
) {
    const sourceModel = workspaceIndex.getSourceSemanticModel?.() ||
        workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
    if (!sourceModel || typeof sourceModel.resolveAt !== "function" ||
        typeof sourceModel.resolveName !== "function" || typeof sourceModel.getDocument !== "function") return false;
    const implementationDocument = sourceModel.getDocument(document.uri);
    if (!implementationDocument?.visibleDocuments) return false;
    const macroName = normalizeIdentifier(defaultName.split(".").at(-1)).replace(/[$%!#&]$/, "");
    if (sourceModel.entries.some((entry) => entry.declaration?.type === "macro" &&
        entry.document && implementationDocument.visibleDocuments.has(entry.document.key) &&
        normalizeIdentifier(entry.name || entry.declaration.name || "").replace(/[$%!#&]$/, "") === macroName)) return false;

    const prototypeRange = procedureParameterSimpleDefaultRange(
        prototype.sourceDocument, prototype.declaration, ordinal, defaultName, prototype.parsed
    );
    if (!prototypeRange) return false;
    const prototypeReferenceRange = simpleParameterDefaultReferenceRange(prototypeRange, defaultName);
    if (!prototypeReferenceRange) return false;
    const prototypeEntries = sourceModel.resolveAt(
        prototype.uri, prototypeReferenceRange.line, prototypeReferenceRange.startCharacter
    );
    if (prototypeEntries.length !== 1) return false;
    const constant = prototypeEntries[0];
    if (constant.declaration?.type !== "const" || constant.conditional === true || isLocal(constant)) return false;

    const offset = positionOffset(
        implementationDocument, implementationRange.line, implementationRange.startCharacter
    );
    const candidates = sourceModel.resolveName(
        implementationDocument, defaultName, scopeAt(implementationDocument, offset), offset
    );
    return candidates.length === 1 && candidates[0].id === constant.id &&
        candidates[0].declaration?.type === "const" && candidates[0].conditional !== true && !isLocal(candidates[0]);
}

async function compilerEnumDefaultOwnerMatches(
    workspaceIndex, document, ordinal, prototype, defaultName, implementation, implementationRange, token
) {
    const analysis = workspaceIndex.compilerAnalysis;
    if (analysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly !== true ||
        !(SIMPLE_IDENTIFIER_PARAMETER_DEFAULT.test(defaultName) ||
            SIMPLE_QUALIFIED_IDENTIFIER_PARAMETER_DEFAULT.test(defaultName))) return false;
    let model = analysis.getModel?.(document.uri) || null;
    if (!model?.remote || !model.semanticSidecarOnly || !model.semanticBindingsAvailable) {
        model = await analysis.getModelForEditor?.(document, token, false, true);
    }
    if (token?.isCancellationRequested || !model?.remote || !model.semanticSidecarOnly ||
        !model.semanticBindingsAvailable || typeof model.query !== "function") return false;

    const snapshot = analysis.snapshotFor?.(document.uri);
    if (!snapshot || snapshot.model !== model || !Array.isArray(snapshot.sources)) return false;
    const pathKey = (filePath) => {
        if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return "";
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const implementationPath = pathKey(document.uri.fsPath);
    const prototypePath = pathKey(prototype.uri?.fsPath);
    if (!implementationPath || !prototypePath) return false;
    const implementationSource = snapshot.sources.find((source) =>
        pathKey(source.uri?.fsPath) === implementationPath);
    const prototypeSource = snapshot.sources.find((source) => pathKey(source.uri?.fsPath) === prototypePath);
    if (!implementationSource || implementationSource.text !== document.getText() ||
        !prototypeSource || typeof prototypeSource.text !== "string" ||
        typeof prototype.sourceText === "string" && prototypeSource.text !== prototype.sourceText) return false;

    const prototypeRange = procedureParameterSimpleDefaultRange(
        prototype.sourceDocument, prototype.declaration, ordinal, defaultName, prototype.parsed
    );
    if (!prototypeRange) return false;
    const prototypeMemberRange = simpleParameterDefaultReferenceRange(prototypeRange, defaultName);
    const implementationDefault = simpleProcedureParameterDefault(implementation.parameters?.[ordinal]?.label);
    const implementationMemberRange = simpleParameterDefaultReferenceRange(implementationRange, implementationDefault);
    if (!prototypeMemberRange || !implementationMemberRange) return false;
    const prototypeLines = prototypeSource.text.split(/\r\n|\n|\r/);
    const prototypeLine = prototypeLines[prototypeRange.line];
    const previousPrototypeLine = prototype.sourceDocument.lineAt(prototypeRange.line).text;
    if (typeof prototypeLine !== "string" || prototypeLine !== previousPrototypeLine ||
        normalizeIdentifier(prototypeLine.slice(prototypeRange.startCharacter, prototypeRange.endCharacter)) !==
            normalizeIdentifier(defaultName)) return false;

    const implementationLine = document.lineAt(implementationRange.line).text;
    if (normalizeIdentifier(implementationLine.slice(
        implementationRange.startCharacter, implementationRange.endCharacter
    )) !== normalizeIdentifier(simpleProcedureParameterDefault(implementation.parameters?.[ordinal]?.label))) return false;

    const sites = [
        {
            filePath: prototypePath,
            line: prototypeMemberRange.line,
            startColumn: prototypeMemberRange.startCharacter,
            endColumn: prototypeMemberRange.endCharacter
        },
        {
            filePath: implementationPath,
            line: implementationMemberRange.line,
            startColumn: implementationMemberRange.startCharacter,
            endColumn: implementationMemberRange.endCharacter
        }
    ];
    const result = await model.query("compilerSidecarEnumMembersAtSites", document.uri, { sites }, token);
    if (token?.isCancellationRequested || !Array.isArray(result)) return false;
    const owners = new Map();
    for (const record of result) {
        if (!Number.isSafeInteger(record?.index) || ![0, 1].includes(record.index) ||
            !Number.isSafeInteger(record.owner) || record.owner < 1 || owners.has(record.index)) return false;
        owners.set(record.index, record.owner);
    }
    return owners.size === 2 && owners.get(0) === owners.get(1);
}

async function procedureParameterDefaultMismatchCodeAction(vscode, workspaceIndex, document, diagnostic, token) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning ||
        !/^fbc(?:\s|$)/i.test(diagnostic.source || "")) return null;
    const message = String(diagnostic.message || "").split("\n\n")[0].trim();
    const mismatch = /^Mismatching parameter initializer,\s*at parameter\s+(\d+)\s+\(([^)\r\n]+)\)\s+of\s+([A-Za-z_][A-Za-z0-9_.$%!#&]*)\(\)$/i.exec(message);
    const line = diagnostic.range?.start?.line;
    if (!mismatch || !Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const ordinal = Number(mismatch[1]) - 1;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) return null;

    const parsed = workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(document.getText());
    const procedures = (parsed.declarations || []).filter((declaration) =>
        ["sub", "function", "property", "operator"].includes(declaration.type) &&
        normalizeIdentifier(declaration.name) === normalizeIdentifier(mismatch[3]) &&
        Number.isSafeInteger(declaration.signatureEndLine) && declaration.signatureEndLine >= declaration.line
    );
    const implementations = procedures.filter((procedure) =>
        procedure.line === line && !procedure.modifiers?.includes("DECLARE")
    );
    if (implementations.length !== 1) return null;
    const implementation = implementations[0];
    const parameter = implementation.parameters?.[ordinal];
    if (!parameter || normalizeIdentifier(parameter.name || "") !== normalizeIdentifier(mismatch[2]) ||
        diagnostic.range.start.character > implementation.startColumn ||
        diagnostic.range.end.character < implementation.endColumn) return null;

    const compilerModel = workspaceIndex.compilerAnalysis?.getModel?.(document.uri) || null;
    let declarations;
    if (compilerModel && typeof workspaceIndex.compilerAnalysis?.snapshotFor === "function") {
        declarations = await compilerSnapshotParameterDeclarations(
            workspaceIndex, document, implementation, compilerModel, token
        );
        if (!Array.isArray(declarations) || token?.isCancellationRequested) return null;
    } else {
        declarations = procedures.filter((procedure) =>
            procedure.modifiers?.includes("DECLARE") && procedureHeadersMatchExceptDefault(implementation, procedure)
        ).map((declaration) => ({
            declaration, parsed, sourceDocument: document, uri: document.uri, sourceText: document.getText()
        }));
        if (declarations.length === 1) {
            const sourceDocument = createDocumentModel(document.uri, parsed);
            const entry = sourceDocument.entries.find((candidate) => candidate.declaration === declarations[0].declaration);
            if (!entry || entry.conditional) return null;
        }
    }
    if (declarations.length > 1) return null;
    if (declarations.length !== 1) return null;
    const prototype = declarations[0];
    const declarationParameter = prototype.declaration.parameters?.[ordinal];
    if (!declarationParameter || normalizeIdentifier(declarationParameter.name || "") !== normalizeIdentifier(mismatch[2])) return null;
    const declaredDefault = simpleProcedureParameterDefault(declarationParameter.label);
    const implementedDefault = simpleProcedureParameterDefault(parameter.label);
    if (!declaredDefault || !implementedDefault ||
        sameSimpleProcedureParameterDefault(declaredDefault, implementedDefault)) return null;
    const range = procedureParameterSimpleDefaultRange(document, implementation, ordinal, implementedDefault, parsed);
    if (!range) return null;
    const namedDefault = SIMPLE_IDENTIFIER_PARAMETER_DEFAULT.test(declaredDefault) ||
        SIMPLE_QUALIFIED_IDENTIFIER_PARAMETER_DEFAULT.test(declaredDefault);
    if (namedDefault && !/^(?:true|false)$/i.test(declaredDefault) &&
        !compilerConstantDefaultResolvesAtImplementation(
            workspaceIndex, document, implementation, ordinal, prototype, declaredDefault, range
        ) && !await compilerEnumDefaultOwnerMatches(
            workspaceIndex, document, ordinal, prototype, declaredDefault, implementation, range, token
        )) return null;

    const action = new vscode.CodeAction(
        "Use declared default '" + declaredDefault + "' for parameter '" + parameter.name + "'",
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, new vscode.Range(
        range.line, range.startCharacter, range.line, range.endCharacter
    ), declaredDefault);
    return action;
}

function fileTransferValueArgumentRange(maskedLine) {
    const command = /^\s*(?:put|get)\s*#\s*/i.exec(maskedLine);
    if (!command) return null;
    let argumentStart = command[0].length;
    let commasSeen = 0;
    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    for (let index = argumentStart; index < maskedLine.length; index++) {
        const character = maskedLine[index];
        if (character === "(") parentheses++;
        else if (character === "[") brackets++;
        else if (character === "{") braces++;
        else if (character === ")") {
            if (parentheses > 0) parentheses--;
            else return null;
        } else if (character === "]") {
            if (brackets > 0) brackets--;
            else return null;
        } else if (character === "}") {
            if (braces > 0) braces--;
            else return null;
        }
        if (character !== "," || parentheses || brackets || braces) continue;
        commasSeen++;
        if (commasSeen === 3) return { start: argumentStart, end: index };
        argumentStart = index + 1;
    }
    return commasSeen === 2 ? { start: argumentStart, end: maskedLine.length } : null;
}

function fileTransferPointerCodeAction(vscode, workspaceIndex, document, diagnostic) {
    const warningSeverity = vscode.DiagnosticSeverity?.Warning;
    const quickFixKind = vscode.CodeActionKind?.QuickFix;
    if (warningSeverity === undefined || quickFixKind === undefined || diagnostic.severity !== warningSeverity ||
        !/^fbc(?:\s|$)/i.test(diagnostic.source || "") ||
        !/^Passing Pointer,\s*at parameter\s+3$/i.test(String(diagnostic.message || "").split("\n\n")[0].trim()) ||
        !Number.isSafeInteger(diagnostic.range?.start?.line) ||
        diagnostic.range?.end?.line !== diagnostic.range.start.line) return null;
    const line = diagnostic.range.start.line;
    if (document.lineAt(line).text.length > 65536) return null;
    workspaceIndex.getParsedDocument?.(document);
    const sourceModel = workspaceIndex.getSourceSemanticModel?.() ||
        workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
    if (typeof sourceModel?.resolveAt !== "function") return null;

    const maskedLine = maskFreeBasicText(document.lineAt(line).text);
    const argument = fileTransferValueArgumentRange(maskedLine);
    if (!argument) return null;
    const argumentText = maskedLine.slice(argument.start, argument.end);
    const leadingWhitespace = argumentText.length - argumentText.trimStart().length;
    const variable = /^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.exec(argumentText.trim());
    if (!variable) return null;
    const variableStart = argument.start + leadingWhitespace;
    const resolved = sourceModel.resolveAt(document.uri, line, variableStart);
    if (resolved.length !== 1) return null;
    const entry = resolved[0];
    const declaration = entry.declaration;
    if (!declaration || !["variable", "field", "parameter", "extern"].includes(declaration.type) ||
        entry.conditional === true || entry.provisional === true || declaration.provisional === true ||
        normalizeIdentifier(entry.name || declaration.name) !== normalizeIdentifier(variable[0])) return null;
    const pointerType = /^(.+?)\s+Ptr$/i.exec(String(declaration.typeName || "").trim());
    if (!pointerType || !FILE_TRANSFER_POINTER_BASE_TYPES.has(normalizeTypeName(pointerType[1]))) return null;

    const action = new vscode.CodeAction(
        "Dereference '" + variable[0] + "' to transfer the pointed-to value",
        quickFixKind
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, new vscode.Position(line, variableStart), "*");
    return action;
}

function byRefArgumentRangeOnLine(maskedLine, openingParenthesis, targetOrdinal) {
    if (!Number.isSafeInteger(openingParenthesis) || openingParenthesis < 0 ||
        maskedLine[openingParenthesis] !== "(" || !Number.isSafeInteger(targetOrdinal) || targetOrdinal < 0) return null;
    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    let argumentStart = openingParenthesis + 1;
    let ordinal = 0;
    for (let index = argumentStart; index < maskedLine.length; index++) {
        const character = maskedLine[index];
        if (character === "(") parentheses++;
        else if (character === "[") brackets++;
        else if (character === "{") braces++;
        else if (character === ")") {
            if (parentheses > 0) parentheses--;
            else if (brackets === 0 && braces === 0) {
                return ordinal === targetOrdinal ? { start: argumentStart, end: index } : null;
            } else return null;
        } else if (character === "]") {
            if (brackets > 0) brackets--;
            else return null;
        } else if (character === "}") {
            if (braces > 0) braces--;
            else return null;
        }
        if (character === "," && !parentheses && !brackets && !braces) {
            if (ordinal === targetOrdinal) return { start: argumentStart, end: index };
            ordinal++;
            argumentStart = index + 1;
        }
    }
    return null;
}

function sourceProcedurePointerParameterMatches(model, uri, line, callNameStart, ordinal, variableTypeName) {
    const declarations = model.resolveAt(uri, line, callNameStart)
        .filter((entry) => ["sub", "function", "property", "operator"].includes(entry.declaration?.type));
    if (declarations.length !== 1 || typeof variableTypeName !== "string" || !variableTypeName) return false;
    const parameter = declarations[0].declaration.parameters?.[ordinal];
    if (!parameter || parameter.variadic || !/^ByVal\b/i.test(String(parameter.label || ""))) return false;
    const pointerType = /^(.+?)\s+Ptr$/i.exec(String(parameter.typeName || "").trim());
    return Boolean(pointerType && normalizeTypeName(pointerType[1]) === normalizeTypeName(variableTypeName));
}

function sourceProcedureScalarParameterMatches(model, uri, line, callNameStart, ordinal, variableTypeName,
    dereferencePointer) {
    const declarations = model.resolveAt(uri, line, callNameStart)
        .filter((entry) => ["sub", "function", "property", "operator"].includes(entry.declaration?.type));
    if (declarations.length !== 1 || typeof variableTypeName !== "string" || !variableTypeName) return false;
    const parameter = declarations[0].declaration.parameters?.[ordinal];
    if (!parameter || parameter.variadic) return false;
    const pointerBase = dereferencePointer ? /^(.+?)\s+Ptr$/i.exec(variableTypeName.trim()) : null;
    const formalType = String(parameter.typeName || "").trim();
    if ((dereferencePointer && !pointerBase) || /\s+Ptr(?:\s+Ptr)*$/i.test(formalType)) return false;
    const argumentType = dereferencePointer ? pointerBase[1] : variableTypeName;
    return normalizeTypeName(argumentType) === normalizeTypeName(formalType);
}

function byRefAddressWarningInfo(diagnostic) {
    const message = String(diagnostic.message || "").split("\n\n")[0].trim();
    const temporaryWarning =
        /^Suspicious address expression passed to BYREF parameter,\s*at parameter\s+(\d+)\s+of\s+([A-Za-z_][A-Za-z0-9_.$%!#&]*)\(\)$/i.exec(message);
    if (temporaryWarning) return {
        kind: "byref-any-temporary",
        ordinal: Number(temporaryWarning[1]),
        procedureName: temporaryWarning[2]
    };
    const pointerToScalarWarning =
        /^Passing pointer to scalar,\s*at parameter\s+(\d+)\s+\(([^)\r\n]+)\)\s+of\s+([A-Za-z_][A-Za-z0-9_.$%!#&]*)\(\)$/i.exec(message);
    if (pointerToScalarWarning) return {
        kind: "pointer-to-scalar",
        ordinal: Number(pointerToScalarWarning[1]),
        parameterName: pointerToScalarWarning[2],
        procedureName: pointerToScalarWarning[3]
    };
    const scalarToPointerWarning =
        /^Passing scalar as pointer,\s*at parameter\s+(\d+)\s+of\s+([A-Za-z_][A-Za-z0-9_.$%!#&]*)\(\)$/i.exec(message);
    if (scalarToPointerWarning) return {
        kind: "scalar-to-pointer",
        ordinal: Number(scalarToPointerWarning[1]),
        procedureName: scalarToPointerWarning[2]
    };
    return null;
}

function byRefAddressWarningCodeAction(vscode, workspaceIndex, document, diagnostic, diagnostics) {
    const warningSeverity = vscode.DiagnosticSeverity?.Warning;
    const quickFixKind = vscode.CodeActionKind?.QuickFix;
    const warning = byRefAddressWarningInfo(diagnostic);
    if (warningSeverity === undefined || quickFixKind === undefined || diagnostic.severity !== warningSeverity ||
        !/^fbc(?:\s|$)/i.test(diagnostic.source || "") || !warning || warning.ordinal < 1 ||
        !Number.isSafeInteger(diagnostic.range?.start?.line) ||
        diagnostic.range?.end?.line !== diagnostic.range.start.line) return null;
    const line = diagnostic.range.start.line;
    if (!Array.isArray(diagnostics) || diagnostics.filter((entry) => {
        const other = byRefAddressWarningInfo(entry);
        return entry.severity === warningSeverity && entry.range?.start?.line === line &&
            entry.range?.end?.line === line && /^fbc(?:\s|$)/i.test(entry.source || "") &&
            other?.kind === warning.kind &&
            normalizeIdentifier(other.procedureName) === normalizeIdentifier(warning.procedureName);
    }).length !== 1) return null;
    if (document.lineAt(line).text.length > 65536) return null;

    workspaceIndex.getParsedDocument?.(document);
    const sourceModel = workspaceIndex.getSourceSemanticModel?.() ||
        workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
    if (typeof sourceModel?.resolveAt !== "function") return null;
    const lineText = document.lineAt(line).text;
    const maskedLine = maskFreeBasicText(lineText);
    const identifier = "[A-Za-z_][A-Za-z0-9_]*[$%!#&]?";
    const callPattern = new RegExp("(" + identifier + "(?:\\." + identifier + ")*)\\s*\\(", "g");
    const candidates = [];
    let callsScanned = 0;
    for (const match of maskedLine.matchAll(callPattern)) {
        callsScanned++;
        if (callsScanned > MAX_BYREF_WARNING_CALL_CANDIDATES) return null;
        if (normalizeIdentifier(match[1]) !== normalizeIdentifier(warning.procedureName)) continue;
        const openingParenthesis = match.index + match[0].lastIndexOf("(");
        const argument = byRefArgumentRangeOnLine(maskedLine, openingParenthesis, warning.ordinal - 1);
        if (!argument) continue;
        const argumentText = maskedLine.slice(argument.start, argument.end);
        const leadingWhitespace = argumentText.length - argumentText.trimStart().length;
        const trimmedArgument = argumentText.trim();
        const variableNamePattern = "[A-Za-z_][A-Za-z0-9_]*[$%!#&]?";
        const addressedArgument = new RegExp("^@\\s*(" + variableNamePattern + ")$").exec(trimmedArgument);
        const plainArgument = new RegExp("^(" + variableNamePattern + ")$").exec(trimmedArgument);
        let variableName = "";
        let editKind = "";
        if (warning.kind === "scalar-to-pointer") {
            if (!plainArgument) continue;
            variableName = plainArgument[1];
            editKind = "add-address";
        } else if (warning.kind === "pointer-to-scalar") {
            if (addressedArgument) {
                variableName = addressedArgument[1];
                editKind = "remove-address";
            } else if (plainArgument) {
                variableName = plainArgument[1];
                editKind = "dereference";
            } else continue;
        } else {
            if (!addressedArgument) continue;
            variableName = addressedArgument[1];
            editKind = "remove-address";
        }
        const variableStart = argument.start + leadingWhitespace + trimmedArgument.indexOf(variableName);
        const resolved = sourceModel.resolveAt(document.uri, line, variableStart);
        if (resolved.length !== 1) continue;
        const entry = resolved[0];
        const declaration = entry.declaration;
        if (!declaration || !["variable", "field", "parameter", "extern"].includes(declaration.type) ||
            entry.conditional === true || entry.provisional === true || declaration.provisional === true ||
            normalizeIdentifier(entry.name || declaration.name) !== normalizeIdentifier(variableName)) continue;
        const callNameStart = match.index + match[1].lastIndexOf(".") + 1;
        if (warning.kind === "scalar-to-pointer" &&
            !sourceProcedurePointerParameterMatches(
                sourceModel, document.uri, line, callNameStart, warning.ordinal - 1, declaration.typeName
            )) continue;
        if (warning.kind === "pointer-to-scalar" &&
            !sourceProcedureScalarParameterMatches(
                sourceModel, document.uri, line, callNameStart, warning.ordinal - 1, declaration.typeName,
                editKind === "dereference"
            )) continue;
        candidates.push({
            addressStart: argument.start + leadingWhitespace,
            variableStart,
            name: variableName,
            editKind
        });
        if (candidates.length > 1) return null;
    }
    if (candidates.length !== 1) return null;

    const candidate = candidates[0];
    const title = warning.kind === "pointer-to-scalar"
        ? candidate.editKind === "dereference"
            ? "Dereference '" + candidate.name + "' to pass its value to '" + warning.procedureName + "'"
            : "Pass '" + candidate.name + "' instead of its address to '" + warning.procedureName + "'"
        : warning.kind === "scalar-to-pointer"
            ? "Pass the address of '" + candidate.name + "' to '" + warning.procedureName + "'"
            : "Pass '" + candidate.name + "' directly to '" + warning.procedureName + "' (BYREF)";
    const action = new vscode.CodeAction(title, quickFixKind);
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    if (candidate.editKind === "add-address") {
        action.edit.insert(document.uri, new vscode.Position(line, candidate.variableStart), "@");
    } else if (candidate.editKind === "dereference") {
        action.edit.insert(document.uri, new vscode.Position(line, candidate.variableStart), "*");
    } else {
        action.edit.delete(document.uri, new vscode.Range(
            line, candidate.addressStart, line, candidate.variableStart
        ));
    }
    return action;
}

function redundantNewAnyInitializerCodeAction(vscode, document, text, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Warning) return null;
    const line = diagnostic.range?.start?.line;
    const character = diagnostic.range?.start?.character;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line || !Number.isSafeInteger(character)) return null;
    const initializer = compilerRedundantNewAnyInitializerRange(text, {
        ...diagnostic,
        severity: "warning",
        physicalPoint: { line, character }
    });
    if (!initializer || diagnostic.range.start.character > initializer.startCharacter ||
        diagnostic.range.end.character < initializer.endCharacter) return null;

    const action = new vscode.CodeAction("Remove redundant '{ Any }' initializer", vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.delete(document.uri, new vscode.Range(
        initializer.line, initializer.startCharacter, initializer.line, initializer.endCharacter
    ));
    return action;
}

function duplicateCaseVariableCodeAction(vscode, document, text, diagnostic) {
    const contextLabel = compilerDiagnosticContextLabel("variable-case-collision");
    const message = String(diagnostic.message || "");
    const hasCompilerContext = contextLabel && message.includes(`Compiler context: ${contextLabel}`);
    const duplicateName = message.match(/duplicated definition,\s*`?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)`?/i)?.[1];
    const exactCompilerDuplicate = diagnostic.severity === vscode.DiagnosticSeverity.Error &&
        /^fbc(?:\s|$)/i.test(diagnostic.source || "") && Boolean(duplicateName);
    if (!hasCompilerContext && !exactCompilerDuplicate) return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const name = duplicateName;
    if (!name) return null;

    const rawLines = text.split(/\r\n|\n|\r/);
    const sourceLine = rawLines[line];
    if (sourceLine === undefined) return null;
    const maskedLine = maskFreeBasicText(text).split(/\r\n|\n|\r/)[line];
    if (sourceLine.trim() !== maskedLine.trim()) return null;
    const match = maskedLine.match(/^\s*dim\s+([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*))?\s*$/i);
    if (!match || match[1] !== name) return null;

    const documentModel = createDocumentModel(document.uri, parseFreeBasicText(text));
    const nameColumn = match[0].indexOf(match[1]);
    const current = documentModel.entries.find((entry) =>
        entry.offset === documentModel.lineOffsets[line] + nameColumn &&
        entry.declaration.type === "variable" && entry.name === match[1]
    );
    if (!current || current.conditional || current.declaration.initializer || current.declaration.modifiers?.length) return null;
    const typeIsExplicit = Boolean(match[2]);
    const typeKey = normalizeTypeName(match[2]);
    const prior = documentModel.entries.filter((entry) =>
        entry !== current && entry.offset < current.offset && entry.scope === current.scope &&
        entry.declaration.type === "variable" && !entry.conditional && !entry.declaration.initializer &&
        !entry.declaration.modifiers?.length && entry.name.toLowerCase() === current.name.toLowerCase() &&
        entry.name !== current.name && normalizeTypeName(entry.declaration.typeName) === typeKey
    );
    if (prior.length !== 1) return null;
    if (!typeIsExplicit && hasInterveningDefaultTypeBoundary(current.document, prior[0].offset, current.offset)) return null;

    const action = new vscode.CodeAction(`Remove duplicate declaration of '${current.name}'`, vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    const deletionRange = line + 1 < rawLines.length
        ? new vscode.Range(line, 0, line + 1, 0)
        : new vscode.Range(line, 0, line, sourceLine.length);
    action.edit.delete(document.uri, deletionRange);
    return action;
}

function hasInterveningDefaultTypeBoundary(document, startOffset, endOffset) {
    for (const statement of document.parsed.statements || []) {
        const offset = (document.lineOffsets[statement.startLine] ?? document.text.length) + statement.startColumn;
        if (offset <= startOffset || offset >= endOffset) continue;
        if (/^(?:def[a-z]*\b|#\s*(?:include|lang)\b)/i.test(String(statement.maskedText || "").trim())) return true;
    }
    return false;
}

function declarationSuffixConflictCodeAction(vscode, document, text, diagnostic) {
    const contextLabel = compilerDiagnosticContextLabel("declaration-suffix-as-conflict");
    if (!contextLabel || !String(diagnostic.message || "").includes(`Compiler context: ${contextLabel}`)) return null;
    const line = diagnostic.range?.start?.line;
    if (!Number.isSafeInteger(line) || diagnostic.range?.end?.line !== line) return null;
    const conflict = compilerDeclarationSuffixConflictRange(text, {
        compilerContext: "declaration-suffix-as-conflict",
        physicalPoint: { line, character: diagnostic.range.start.character },
        message: diagnostic.message
    });
    if (!conflict || diagnostic.range.start.character > conflict.startCharacter ||
        diagnostic.range.end.character < conflict.endCharacter) return null;

    const action = new vscode.CodeAction(
        `Remove '${conflict.suffix}' suffix from '${conflict.name}' to use the DIM AS type`,
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.delete(document.uri, new vscode.Range(
        conflict.line,
        conflict.suffixStartCharacter,
        conflict.line,
        conflict.endCharacter
    ));
    return action;
}

function unclosedBlockTerminatorCodeAction(vscode, document, text, diagnostic) {
    const contextLabel = compilerDiagnosticContextLabel("unclosed-procedure");
    if (!contextLabel || !String(diagnostic.message || "").includes(`Compiler context: ${contextLabel}`)) return null;
    const lines = text.split(/\r\n|\n|\r/);
    const lastLine = lines.length - 1;
    if (diagnostic.range?.start?.line !== lastLine || diagnostic.range?.end?.line !== lastLine) return null;
    const message = String(diagnostic.message).split("\n\nCompiler context:")[0].trim();
    const expected = message.match(/^Expected\s+['"]?(END\s+(?:SUB|FUNCTION|CONSTRUCTOR|DESTRUCTOR|OPERATOR|PROPERTY|IF|SELECT|WITH|NAMESPACE|SCOPE|TYPE|CLASS|UNION|ENUM|EXTERN|ASM)|NEXT|LOOP|WEND)['"]?$/i);
    if (!expected) return null;

    const ending = expected[1].toLowerCase().replace(/\s+/g, " ");
    const statementByEnding = {
        "end sub": "End Sub",
        "end function": "End Function",
        "end constructor": "End Constructor",
        "end destructor": "End Destructor",
        "end operator": "End Operator",
        "end property": "End Property",
        "end if": "End If",
        "end select": "End Select",
        "end with": "End With",
        "end namespace": "End Namespace",
        "end scope": "End Scope",
        "end type": "End Type",
        "end class": "End Class",
        "end union": "End Union",
        "end enum": "End Enum",
        "end extern": "End Extern",
        "end asm": "End Asm",
        next: "Next",
        loop: "Loop",
        wend: "Wend"
    };
    const statement = statementByEnding[ending];
    if (!statement || !text.length) return null;

    const maskedLines = maskFreeBasicText(text).split(/\r\n|\n|\r/);
    let lastCodeLine = "";
    for (let line = maskedLines.length - 1; line >= 0; line--) {
        lastCodeLine = maskedLines[line].trim();
        if (lastCodeLine) break;
    }
    const alreadyClosed = ending.startsWith("end ")
        ? new RegExp(`^end\\s+${escapeRegularExpression(ending.slice(4))}(?:\\b|\\s|$)`, "i").test(lastCodeLine)
        : new RegExp(`^${escapeRegularExpression(ending)}\\b`, "i").test(lastCodeLine);
    if (alreadyClosed) return null;

    const lineEnding = text.match(/\r\n|\n|\r/)?.[0] || "\n";
    const prefix = /(?:\r\n|\n|\r)$/.test(text) ? "" : lineEnding;
    const suffix = text.endsWith(lineEnding) ? lineEnding : "";
    const action = new vscode.CodeAction(`Insert '${statement}' at end of file`, vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, document.positionAt(text.length), `${prefix}${statement}${suffix}`);
    return action;
}

function unsupportedErrorResumeNextCodeAction(vscode, document, text, diagnostic) {
    if (diagnostic.severity !== vscode.DiagnosticSeverity.Error) return null;
    const unsupportedRange = compilerErrorResumeNextRange(text, diagnostic);
    if (!unsupportedRange || diagnostic.range?.start?.line !== unsupportedRange.line ||
        diagnostic.range?.end?.line !== unsupportedRange.line ||
        diagnostic.range.start.character > unsupportedRange.startCharacter ||
        diagnostic.range.end.character < unsupportedRange.endCharacter) return null;

    const maskedLine = maskFreeBasicText(text).split(/\r\n|\n|\r/)[unsupportedRange.line];
    if (!maskedLine || maskedLine.slice(0, unsupportedRange.startCharacter).trim() ||
        maskedLine.slice(unsupportedRange.endCharacter).trim()) return null;

    const action = new vscode.CodeAction(
        "Remove unsupported 'ON ERROR RESUME NEXT' statement",
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, new vscode.Range(
        unsupportedRange.line,
        unsupportedRange.startCharacter,
        unsupportedRange.line,
        unsupportedRange.endCharacter
    ), "");
    return action;
}

function includeInsertionPosition(vscode, document, text) {
    for (let line = 0; line < document.lineCount; line++) {
        if (!/^\s*#\s*lang\b/i.test(document.lineAt(line).text)) continue;
        if (line + 1 < document.lineCount) return { position: new vscode.Position(line + 1, 0), prefix: "" };
        return { position: new vscode.Position(line, document.lineAt(line).text.length), prefix: "\n" };
    }

    const masked = maskFreeBasicText(text);
    const firstCodeOffset = masked.search(/\S/);
    const bomAdjustment = text.startsWith("\uFEFF") ? 1 : 0;
    const offset = firstCodeOffset < 0 ? text.length : Math.max(firstCodeOffset, bomAdjustment);
    return { position: document.positionAt(offset), prefix: "" };
}

function includedHeaderLine(document, header, beforeLine) {
    const pattern = new RegExp(`^\\s*#\\s*include\\s+(?:once\\s+)?["<]${escapeRegularExpression(header)}[">]`, "i");
    for (let line = 0; line < Math.min(document.lineCount, beforeLine); line++) {
        if (pattern.test(document.lineAt(line).text)) return line;
    }
    return -1;
}

function usingNamespaceLine(document, namespace, beforeLine) {
    const pattern = new RegExp(`^\\s*using\\s+${escapeRegularExpression(namespace)}\\b`, "i");
    for (let line = 0; line < Math.min(document.lineCount, beforeLine); line++) {
        if (pattern.test(document.lineAt(line).text)) return line;
    }
    return -1;
}

function includeInsertionAfterLine(vscode, document, line) {
    if (line + 1 < document.lineCount) return { position: new vscode.Position(line + 1, 0), prefix: "" };
    return { position: new vscode.Position(line, document.lineAt(line).text.length), prefix: "\n" };
}

function escapeRegularExpression(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identifierEditDistanceAtMostOne(first, second) {
    const firstSuffix = "$%!#&".includes(first.at(-1) || "") ? first.at(-1) : "";
    const secondSuffix = "$%!#&".includes(second.at(-1) || "") ? second.at(-1) : "";
    if (firstSuffix !== secondSuffix) return 2;

    const left = normalizeIdentifier(first);
    const right = normalizeIdentifier(second);
    if (left === right) return 0;
    /* Short identifiers collide too easily, even with one changed character. */
    if (Math.min(left.length, right.length) < 4 || Math.abs(left.length - right.length) > 1) return 2;

    let leftIndex = 0;
    let rightIndex = 0;
    let edits = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
        if (left[leftIndex] === right[rightIndex]) {
            leftIndex++;
            rightIndex++;
            continue;
        }

        edits++;
        if (edits > 1) return 2;
        if (left.length === right.length &&
            left[leftIndex] === right[rightIndex + 1] && left[leftIndex + 1] === right[rightIndex]) {
            /* A single adjacent transposition is a common typing error. */
            leftIndex += 2;
            rightIndex += 2;
        } else if (left.length > right.length) {
            leftIndex++;
        } else if (right.length > left.length) {
            rightIndex++;
        } else {
            leftIndex++;
            rightIndex++;
        }
    }

    if (leftIndex < left.length || rightIndex < right.length) edits++;
    return edits <= 1 ? edits : 2;
}

async function undeclaredNameTypoCodeAction(vscode, workspaceIndex, document, diagnostic, name, isTypeName, libraryTypeNames, token, expectedCandidateName = "") {
    if (name.includes(".") || token?.isCancellationRequested) return null;

    const parsed = workspaceIndex.getParsedDocument(document);
    const occurrences = parsed.occurrences.filter((occurrence) =>
        occurrence.line === diagnostic.range.start.line && normalizeIdentifier(occurrence.name) === normalizeIdentifier(name)
    );
    const point = diagnostic.range.start.character;
    const occurrence = occurrences.find((candidate) =>
        candidate.startColumn === point && candidate.endColumn === diagnostic.range.end.character
    ) || occurrences.find((candidate) => candidate.startColumn <= point && candidate.endColumn >= point) ||
        (occurrences.length === 1 ? occurrences[0] : null);
    if (!occurrence || !await workspaceIndex.ensureInitialized(token) || token?.isCancellationRequested) return null;

    const sourceText = document.getText();
    const occurrenceEnd = document.offsetAt(new vscode.Position(occurrence.line, occurrence.endColumn));
    const openingParenthesis = sourceText.slice(occurrenceEnd).match(/^\s*\(/);
    const callContext = openingParenthesis
        ? findCallContext(sourceText, occurrenceEnd + openingParenthesis[0].length)
        : null;
    const isCall = Boolean(callContext && normalizeIdentifier(callContext.name) === normalizeIdentifier(name));

    const model = workspaceIndex.getSemanticModel(document.uri, { allowSidecarOnly: false });
    if (workspaceIndex.isIncomplete() && !(model?.remote && !model.partial)) return null;
    let entries;
    if (model?.remote) {
        const result = await model.query("completion", document.uri, {
            position: new vscode.Position(occurrence.line, occurrence.startColumn),
            limit: MAX_TYPO_SUGGESTION_ENTRIES
        }, token);
        if (!result || !Array.isArray(result.entries)) return null;
        entries = result.entries;
    } else {
        entries = model?.visibleEntries?.(
            document.uri, occurrence.line, occurrence.startColumn, MAX_TYPO_SUGGESTION_ENTRIES
        ) || [];
    }
    if (entries.length >= MAX_TYPO_SUGGESTION_ENTRIES) return null;

    const allowedTypes = isTypeName
        ? new Set(["type", "class", "union", "enum"])
        : isCall
            ? new Set(["function", "sub", "property", "constructor", "destructor", "operator", "macro"])
            : new Set(["variable", "parameter", "field", "const", "enumMember"]);
    const nearest = new Map();
    const addCandidate = (candidateName, visible, apiMappings = null) => {
        const distance = identifierEditDistanceAtMostOne(name, candidateName);
        if (distance !== 1) return;
        const key = normalizeIdentifier(candidateName);
        const candidate = nearest.get(key) || { name: candidateName, visible: false, apiMappings: null };
        if (visible) {
            candidate.name = candidateName;
            candidate.visible = true;
        }
        if (apiMappings) candidate.apiMappings = apiMappings;
        nearest.set(key, candidate);
    };
    for (const entry of entries) {
        if (token?.isCancellationRequested) return null;
        const declaration = entry.declaration || entry;
        if (entry.conditional || !allowedTypes.has(declaration.type)) continue;
        const candidateName = entry.name || declaration.name;
        if (typeof candidateName !== "string" || !candidateName) continue;
        if (expectedCandidateName && normalizeIdentifier(candidateName) !== normalizeIdentifier(expectedCandidateName)) continue;
        addCandidate(candidateName, true);
    }
    const referenceCandidates = expectedCandidateName ? [] : isTypeName ? libraryTypeNames : isCall ? REFERENCE_NAMES : [];
    for (const referenceName of referenceCandidates) {
        if (token?.isCancellationRequested) return null;
        if (identifierEditDistanceAtMostOne(name, referenceName) !== 1) continue;
        const referenceEntries = getReferenceEntries(referenceName).filter((entry) => {
            const validHeader = typeof entry.header === "string" && /^[A-Za-z0-9_.-]+\.bi$/i.test(entry.header) && !entry.header.includes("..");
            const validNamespace = !entry.namespace || /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(entry.namespace);
            const isBundledType = isTypeName && libraryTypeNames.has(normalizeIdentifier(entry.name)) &&
                (!Array.isArray(entry.signatures) || entry.signatures.length === 0);
            const isBundledCallable = !isTypeName && Array.isArray(entry.signatures) && entry.signatures.length > 0;
            return validHeader && validNamespace && (isBundledType || isBundledCallable);
        });
        if (!referenceEntries.length) continue;

        const apiMappings = new Map(referenceEntries.map((entry) => [
            `${entry.header.toLowerCase()}\t${String(entry.namespace || "").toLowerCase()}`,
            { header: entry.header, namespace: entry.namespace || "" }
        ]));
        const displayName = referenceEntries.map((entry) => {
            if (isTypeName) {
                const typeName = String(entry.usage || "").match(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
                if (typeName && normalizeIdentifier(typeName) === normalizeIdentifier(referenceName)) return typeName;
            }
            return String(entry.title || "").split(".").at(-1).match(IDENTIFIER_PATTERN)?.[0];
        }).find((candidate) => candidate && normalizeIdentifier(candidate) === normalizeIdentifier(referenceName)) || referenceName;
        addCandidate(displayName, false, [...apiMappings.values()]);
    }
    if (nearest.size !== 1) return null;

    const candidate = nearest.values().next().value;
    if (!candidate.visible && candidate.apiMappings?.length !== 1) return null;
    const suggestion = candidate.name;
    const statements = [];
    let insertion = null;
    if (!candidate.visible) {
        const mapping = candidate.apiMappings[0];
        const headerLine = includedHeaderLine(document, mapping.header, diagnostic.range.start.line);
        const usingLine = mapping.namespace
            ? usingNamespaceLine(document, mapping.namespace, diagnostic.range.start.line)
            : -1;
        if (headerLine < 0) statements.push(`#include once "${mapping.header}"`);
        if (mapping.namespace && usingLine < 0) statements.push(`Using ${mapping.namespace}`);
        if (statements.length) {
            insertion = headerLine >= 0
                ? includeInsertionAfterLine(vscode, document, headerLine)
                : includeInsertionPosition(vscode, document, sourceText);
        }
    }
    const action = new vscode.CodeAction(
        statements.length
            ? `Fix typo: replace "${name}" with "${suggestion}" and add ${statements.join(" and ")}`
            : `Fix typo: replace "${name}" with "${suggestion}"`,
        vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, new vscode.Range(
        occurrence.line, occurrence.startColumn, occurrence.line, occurrence.endColumn
    ), suggestion);
    if (insertion) action.edit.insert(document.uri, insertion.position, `${insertion.prefix}${statements.join("\n")}\n`);
    return action;
}

function compilerArrayDeclaratorSource(model, document, entry) {
    const declaration = entry?.declaration;
    if (!["variable", "field", "parameter", "extern"].includes(declaration?.type) ||
        !Number.isSafeInteger(declaration.line) || declaration.line < 0 ||
        !Number.isSafeInteger(declaration.endColumn) || declaration.endColumn < 0) return null;
    const declarationDocument = entry.uri ? model.getDocument?.(entry.uri) : null;
    const sameSource = !entry.uri || entry.uri.toString() === document.uri.toString();
    const source = declarationDocument || (sameSource ? document : null);
    if (!source) return null;
    let lineText;
    if (typeof source.lineAt === "function") {
        if (declaration.line >= source.lineCount) return null;
        lineText = source.lineAt(declaration.line).text;
    } else {
        /* Indexed and closed-header sources are immutable semantic documents,
           not VS Code TextDocuments. Read their captured line boundaries. */
        const start = source.lineOffsets?.[declaration.line];
        const end = source.lineOffsets?.[declaration.line + 1] ?? source.text?.length;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || typeof source.text !== "string" ||
            start < 0 || end < start || end > source.text.length) return null;
        lineText = source.text.slice(start, end).replace(/[\r\n]+$/, "");
    }
    return /^\s*\(/.test(lineText.slice(declaration.endColumn)) ? { declaration, lineText } : null;
}

function isCompilerArrayStorageHoverPotential(model, document, position, callContext, resolved) {
    const arrayDeclarators = (resolved || [])
        .map((entry) => compilerArrayDeclaratorSource(model, document, entry)).filter(Boolean);
    if (arrayDeclarators.some((source) => source.declaration.line === position.line &&
        Number.isSafeInteger(source.declaration.startColumn) && position.character >= source.declaration.startColumn &&
        position.character < source.declaration.endColumn)) return true;
    if (!callContext) return false;
    const callName = normalizeIdentifier(String(callContext.name || "").split(/\.|->/).at(-1) || "");
    if (["lbound", "ubound"].includes(callName)) return true;
    return arrayDeclarators.length > 0;
}

function isCompilerFieldDeclarationHoverPotential(position, resolved) {
    return (resolved || []).some((entry) => {
        const declaration = entry.declaration;
        return declaration?.type === "field" && declaration.provisional !== true &&
            declaration.line === position.line && Number.isSafeInteger(declaration.startColumn) &&
            Number.isSafeInteger(declaration.endColumn) &&
            position.character >= declaration.startColumn && position.character < declaration.endColumn;
    });
}

function isCompilerAggregateDeclarationHoverPotential(position, resolved) {
    return (resolved || []).some((entry) => {
        const declaration = entry.declaration;
        return ["type", "class", "union"].includes(declaration?.type) &&
            declaration.detail !== "Type alias" && declaration.provisional !== true &&
            declaration.line === position.line && Number.isSafeInteger(declaration.startColumn) &&
            Number.isSafeInteger(declaration.endColumn) &&
            position.character >= declaration.startColumn && position.character < declaration.endColumn;
    });
}

function isCompilerParameterDeclarationHoverPotential(position, resolved) {
    return (resolved || []).some((entry) => {
        const declaration = entry.declaration;
        return declaration?.type === "parameter" && declaration.provisional !== true &&
            declaration.line === position.line && Number.isSafeInteger(declaration.startColumn) &&
            Number.isSafeInteger(declaration.endColumn) &&
            position.character >= declaration.startColumn && position.character < declaration.endColumn;
    });
}

function isCompilerProcedureDeclarationHoverPotential(position, resolved) {
    return (resolved || []).some((entry) => {
        const declaration = entry.declaration;
        return ["function", "sub", "property", "operator", "constructor", "destructor"].includes(declaration?.type) &&
            declaration.provisional !== true && declaration.line === position.line &&
            Number.isSafeInteger(declaration.startColumn) && Number.isSafeInteger(declaration.endColumn) &&
            position.character >= declaration.startColumn && position.character < declaration.endColumn;
    });
}

/* Keep the full-sidecar request on a likely assignment target; FBC chooses its scope. */
function isCompilerStorageClassHoverPotential(document, position) {
    const line = maskFreeBasicText(document.lineAt(position.line).text);
    const assignment = /^\s*(?:let\s+)?([A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?)\s*(?:\+=|-=|\*=|\/=|\\=|\^=|&=|=(?![=>]))/i.exec(line);
    if (!assignment) return false;
    const targetStart = line.indexOf(assignment[1], assignment.index);
    return position.character >= targetStart && position.character < targetStart + assignment[1].length;
}

function isCompilerVariableDeclarationHoverPotential(position, resolved) {
    return (resolved || []).some((entry) => {
        const declaration = entry.declaration;
        return declaration?.type === "variable" && declaration.provisional !== true &&
            declaration.line === position.line && Number.isSafeInteger(declaration.startColumn) &&
            Number.isSafeInteger(declaration.endColumn) &&
            position.character >= declaration.startColumn && position.character < declaration.endColumn;
    });
}

function compilerInputReadTargetAtPosition(document, position, parsed) {
    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return null;
    const statements = (parsed || parseFreeBasicText(document.getText())).statements || [];
    for (const statement of statements) {
        const startLine = statement.startLine;
        const endLine = statement.endLine ?? startLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            position.line < startLine || position.line > endLine ||
            endLine - startLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const targetNames = implicitInputReadTargetNames(statement.maskedText);
        if (!targetNames.length) continue;
        const target = compilerStatementTargetOccurrences(
            document, statement, targetNames, position.line, position.line
        ).find((occurrence) => position.character >= occurrence.startColumn &&
            position.character < occurrence.endColumn);
        if (target) return target;
    }
    return null;
}

function compilerStatementTargetOccurrences(document, statement, targetNames, firstLine, lastLine) {
    const statementStartLine = statement.startLine;
    const statementEndLine = statement.endLine ?? statementStartLine;
    if (!Number.isSafeInteger(statementStartLine) || !Number.isSafeInteger(statementEndLine) ||
        statementStartLine < 0 || statementEndLine < statementStartLine ||
        statementEndLine - statementStartLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES ||
        !Array.isArray(targetNames) || !targetNames.length) return [];
    /* Continuation parsing identifies the statement; physical lines anchor edits and hints. */
    const targetNamesLower = new Set(targetNames.map((name) => name.toLowerCase()));
    const start = Math.max(statementStartLine, Number.isSafeInteger(firstLine) ? firstLine : statementStartLine);
    const end = Math.min(statementEndLine, Number.isSafeInteger(lastLine) ? lastLine : statementEndLine);
    const occurrences = [];
    for (let line = start; line <= end; line++) {
        const lineText = document.lineAt(line)?.text;
        if (typeof lineText !== "string") continue;
        const maskedLine = maskFreeBasicText(lineText);
        for (const match of maskedLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)) {
            if (!targetNamesLower.has(match[0].toLowerCase())) continue;
            occurrences.push({
                name: match[0],
                line,
                startColumn: match.index,
                endColumn: match.index + match[0].length,
                statementStartLine,
                statementEndLine
            });
        }
    }
    return occurrences;
}

function compilerGetTargetAtPosition(document, position, parsed) {
    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return null;
    const statements = (parsed || parseFreeBasicText(document.getText())).statements || [];
    for (const statement of statements) {
        const startLine = statement.startLine;
        const endLine = statement.endLine ?? startLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            position.line < startLine || position.line > endLine ||
            endLine - startLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const targetNames = implicitGetTargetNames(statement.maskedText);
        if (!targetNames.length) continue;
        const target = compilerStatementTargetOccurrences(
            document, statement, targetNames, position.line, position.line
        ).find((occurrence) => position.character >= occurrence.startColumn &&
            position.character < occurrence.endColumn);
        if (target && !/[$%!#&]$/.test(target.name)) return target;
    }
    return null;
}

/* FBC storage facts distinguish a first PRESERVE declaration from an array resize. */
function implicitRedimTargetNames(code) {
    const maskedLine = String(code || "").replace(/\s+/g, " ").trim();
    const header = /^\s*(?:(?:public|private|protected|shared|static|common|extern)\s+)*redim\b/i.exec(maskedLine);
    if (!header) return [];

    let cursor = header[0].length;
    while (/\s/.test(maskedLine[cursor] || "")) cursor++;
    for (let optionCount = 0; optionCount < 2; optionCount++) {
        const option = /^[A-Za-z_][A-Za-z0-9_]*/.exec(maskedLine.slice(cursor))?.[0]?.toLowerCase();
        if (option !== "preserve" && option !== "shared") break;
        cursor += option.length;
        while (/\s/.test(maskedLine[cursor] || "")) cursor++;
    }

    const targets = [];
    while (cursor < maskedLine.length) {
        const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/.exec(maskedLine.slice(cursor));
        if (!nameMatch) return [];
        const name = nameMatch[0];
        const suffixTyped = /[$%!#&]$/.test(name);
        cursor += name.length;
        while (/\s/.test(maskedLine[cursor] || "")) cursor++;
        if (maskedLine[cursor] !== "(") return [];

        const openingColumn = cursor;
        let depth = 0;
        let closingColumn = -1;
        for (let column = openingColumn; column < maskedLine.length; column++) {
            if (maskedLine[column] === "(") depth++;
            else if (maskedLine[column] === ")") {
                depth--;
                if (depth === 0) {
                    closingColumn = column + 1;
                    break;
                }
            }
        }
        if (closingColumn < 0) return [];
        cursor = closingColumn;
        while (/\s/.test(maskedLine[cursor] || "")) cursor++;

        const explicitType = /^as\b/i.test(maskedLine.slice(cursor));
        if (!suffixTyped && !explicitType) targets.push(name);
        if (explicitType) {
            let typeDepth = 0;
            while (cursor < maskedLine.length) {
                const character = maskedLine[cursor];
                if (character === "(") typeDepth++;
                else if (character === ")" && typeDepth > 0) typeDepth--;
                else if (character === "," && typeDepth === 0) break;
                cursor++;
            }
        }
        while (/\s/.test(maskedLine[cursor] || "")) cursor++;
        if (cursor >= maskedLine.length) break;
        if (maskedLine[cursor] !== ",") return [];
        cursor++;
        while (/\s/.test(maskedLine[cursor] || "")) cursor++;
    }
    return targets;
}

function compilerImplicitRedimTargetAtPosition(document, position, parsed) {
    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return null;
    const statements = (parsed || parseFreeBasicText(document.getText())).statements || [];
    for (const statement of statements) {
        const startLine = statement.startLine;
        const endLine = statement.endLine ?? startLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            position.line < startLine || position.line > endLine ||
            endLine - startLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const targetNames = implicitRedimTargetNames(statement.maskedText);
        if (!targetNames.length) continue;
        const target = compilerStatementTargetOccurrences(
            document, statement, targetNames, position.line, position.line
        ).find((occurrence) => position.character >= occurrence.startColumn &&
            position.character < occurrence.endColumn);
        if (target) return target;
    }
    return null;
}

function compilerRedimTargetTypeInsertionPosition(document, target) {
    const endLine = target.statementEndLine ?? target.line;
    if (!Number.isSafeInteger(target.line) || !Number.isSafeInteger(target.endColumn) ||
        !Number.isSafeInteger(endLine) || endLine < target.line ||
        endLine - target.line >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) return null;
    let openingSeen = false;
    let depth = 0;
    for (let line = target.line; line <= endLine; line++) {
        const lineText = document.lineAt(line)?.text;
        if (typeof lineText !== "string") return null;
        const maskedLine = maskFreeBasicText(lineText);
        const startColumn = line === target.line ? target.endColumn : 0;
        for (let column = startColumn; column < maskedLine.length; column++) {
            const character = maskedLine[column];
            if (!openingSeen) {
                if (/\s/.test(character)) continue;
                if (character === "_" && !maskedLine.slice(column + 1).trim()) break;
                if (character !== "(") return null;
                openingSeen = true;
                depth = 1;
                continue;
            }
            if (character === "(") depth++;
            else if (character === ")") {
                depth--;
                if (depth === 0) return { line, character: column + 1 };
            }
        }
    }
    return null;
}

function compilerImplicitCompoundAssignmentAtPosition(document, position, parsed) {
    const lineText = document.lineAt(position.line)?.text;
    if (typeof lineText === "string") {
        const maskedLine = maskFreeBasicText(lineText);
        if (!maskedLine.includes(":") && !/_\s*$/.test(maskedLine.trimEnd())) {
            const assignment = IMPLICIT_COMPOUND_ASSIGNMENT_TARGET.exec(maskedLine);
            if (assignment && !/[$%!#&]$/.test(assignment[2])) {
                const startColumn = assignment[1].length;
                const endColumn = startColumn + assignment[2].length;
                if (position.character >= startColumn && position.character < endColumn) {
                    return { name: assignment[2], startColumn, endColumn };
                }
            }
        }
    }

    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return null;
    for (const statement of (parsed || parseFreeBasicText(document.getText())).statements || []) {
        const startLine = statement.startLine;
        const endLine = statement.endLine ?? startLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            endLine <= startLine || position.line < startLine || position.line > endLine ||
            endLine - startLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const logicalCode = String(statement.maskedText || "").replace(/\s+/g, " ").trim();
        if (logicalCode.includes(":")) continue;
        const assignment = IMPLICIT_COMPOUND_ASSIGNMENT_TARGET.exec(logicalCode);
        if (!assignment || /[$%!#&]$/.test(assignment[2])) continue;
        const target = compilerStatementTargetOccurrences(
            document, statement, [assignment[2]], startLine, endLine
        )[0];
        if (target && target.line === position.line && position.character >= target.startColumn &&
            position.character < target.endColumn) return target;
    }
    return null;
}

function compilerImplicitAssignmentTargetAtPosition(document, position) {
    const lineText = document.lineAt(position.line)?.text;
    if (typeof lineText !== "string") return null;
    const maskedLine = maskFreeBasicText(lineText);
    const assignment = /^(\s*)(let\s+)?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*=(?!=|>)/i.exec(maskedLine);
    if (!assignment || /[$%!#&]$/.test(assignment[3])) return null;
    const startColumn = assignment[1].length + (assignment[2]?.length || 0);
    const endColumn = startColumn + assignment[3].length;
    return position.character >= startColumn && position.character < endColumn
        ? { name: assignment[3], startColumn, endColumn }
        : null;
}

function compilerImplicitContinuedAssignmentAtPosition(document, position, parsed) {
    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return null;
    const statements = (parsed || parseFreeBasicText(document.getText())).statements || [];
    for (const statement of statements) {
        const startLine = statement.startLine;
        const endLine = statement.endLine ?? startLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            endLine <= startLine || position.line < startLine || position.line > endLine ||
            endLine - startLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const logicalCode = String(statement.maskedText || "").replace(/\s+/g, " ").trim();
        const assignment = /^(?:let\s+)?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*=(?!=|>)/i.exec(logicalCode);
        if (!assignment || /[$%!#&]$/.test(assignment[1])) continue;
        const target = compilerStatementTargetOccurrences(
            document, statement, [assignment[1]], startLine, endLine
        )[0];
        if (!target || target.line !== position.line ||
            position.character < target.startColumn || position.character >= target.endColumn) continue;
        return { ...target, continuedAssignment: true };
    }
    return null;
}

function compilerImplicitSwapTargetAtPosition(document, position, parsed) {
    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return null;
    const statements = (parsed || parseFreeBasicText(document.getText())).statements || [];
    for (const statement of statements) {
        const startLine = statement.startLine;
        const endLine = statement.endLine ?? startLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            position.line < startLine || position.line > endLine ||
            endLine - startLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const names = implicitSwapTargetNames(String(statement.maskedText || "").trim());
        if (names.length !== 2) continue;
        const target = compilerStatementTargetOccurrences(
            document, statement, names, position.line, position.line
        ).find((occurrence) => position.character >= occurrence.startColumn &&
            position.character < occurrence.endColumn);
        if (target && !/[$%!#&]$/.test(target.name)) return target;
    }
    return null;
}

function compilerImplicitLsetRsetTargetAtPosition(document, position, parsed) {
    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return null;
    const statements = (parsed || parseFreeBasicText(document.getText())).statements || [];
    for (const statement of statements) {
        const startLine = statement.startLine;
        const endLine = statement.endLine ?? startLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            position.line < startLine || position.line > endLine) continue;
        const targetNames = implicitLsetRsetTargetNames(statement.maskedText);
        if (!targetNames.length) continue;
        const target = compilerStatementTargetOccurrences(
            document, statement, targetNames, position.line, position.line
        ).find((occurrence) => position.character >= occurrence.startColumn &&
            position.character < occurrence.endColumn);
        if (target && !/[$%!#&]$/.test(target.name)) return target;
    }
    return null;
}

function compilerImplicitForCounterAtPosition(document, position, parsed) {
    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character)) return null;
    const statements = (parsed || parseFreeBasicText(document.getText())).statements || [];
    for (const statement of statements) {
        const startLine = statement.startLine;
        const endLine = statement.endLine ?? startLine;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
            position.line < startLine || position.line > endLine ||
            endLine - startLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const name = implicitForCounterName(statement.maskedText);
        if (!name) continue;
        const target = compilerStatementTargetOccurrences(
            document, statement, [name], position.line, position.line
        ).find((occurrence) => position.character >= occurrence.startColumn &&
            position.character < occurrence.endColumn);
        if (target) return target;
    }
    return null;
}

function implicitForCounterName(code) {
    const normalizedCode = String(code || "").replace(/\s+/g, " ").trim();
    const loop = /^for\s+([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)(.*)$/i.exec(normalizedCode);
    if (!loop || /[$%!#&]$/.test(loop[1]) || !/^\s*(?:=|\bin\b)/i.test(loop[2])) return "";
    return loop[1];
}

function isCompilerHeaderLibraryDirectiveHoverPotential(document, position) {
    const line = document.lineAt(position.line).text;
    const directive = /^\s*#\s*(?:inclib|libpath)\b/i.exec(line);
    return Boolean(directive && position.character >= directive[0].length && line.slice(directive[0].length).trim());
}

function createHoverProvider(vscode, workspaceIndex, grammarData) {
    return {
        async provideHover(document, position, token) {
            const lineText = document.lineAt(position.line).text;
            const currentCharacter = lineText[position.character] || " ";
            if (/\s/.test(currentCharacter) &&
                (!lineText.slice(0, position.character).trim() ||
                    !lineText.slice(position.character + 1).trim())) return null;
            const linePrefix = lineText.slice(0, position.character + 1);
            const optionNoKeywordIdentifier = optionNoKeywordIdentifierAtPosition(document, position);
            const optionRemIdentifier = optionRemIdentifierAtPosition(document, position);
            const sourceContext = await compilerAwareCodeContext(
                workspaceIndex, document, document.offsetAt(position), linePrefix, token
            );
            if (sourceContext.context === "comment" && !optionRemIdentifier) return null;
            const needMaskedRemBindings = Boolean(optionRemIdentifier) &&
                !tokenize(lineText).tokens.some((candidate) => candidate.startColumn === optionRemIdentifier.startColumn &&
                    candidate.endColumn === optionRemIdentifier.endColumn);
            const model = await editorModel(workspaceIndex, document, token, false, needMaskedRemBindings);
            if (!model || token?.isCancellationRequested) return null;
            const callContext = model.remote
                ? sourceContext.callContext !== undefined ? sourceContext.callContext
                    : findCallContext(document.getText(), document.offsetAt(position), sourceContext.defaultEscapedStringRanges)
                : hoverCallContext(model, document, position);
            /* Brackets describe the containing call, not the identifier under
               the cursor. Keep argument variables and nested callees on their
               own declaration and type. */
            const indexHover = callContext?.indexing === true && !tokenize(lineText).tokens.some((candidate) =>
                candidate.kind === "identifier" && position.character >= candidate.startColumn &&
                position.character < candidate.endColumn);
            const localResolved = !model.remote && !indexHover
                ? model.resolveAt?.(document.uri, position.line, position.character) || []
                : [];
            const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
            const unresolvedIdentifierAtPosition = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true && localResolved.length === 0
                ? identifierTokenAtPosition(document, position)
                : null;
            const implicitLegacyVariableAtPosition = unresolvedIdentifierAtPosition &&
                compilerUsesImplicitVariableDialect(document, workspaceIndex)
                ? unresolvedIdentifierAtPosition
                : null;
            const stockSidecarNoKeywordIdentifierPotential = !model.remote &&
                compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                localResolved.length === 0 && Boolean(optionNoKeywordIdentifier);
            const stockSidecarConstantPotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                localResolved.some((entry) => ["const", "enumMember"].includes(entry.declaration?.type));
            const stockSidecarDeclarationSelectionPotential = !model.remote &&
                compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                localResolved.length > 1 && localResolved.every((entry) => !isCallableDeclaration(entry.declaration));
            const macroReferenceAtPosition = localResolved.some((entry) => {
                const declaration = entry.declaration;
                const sameDeclarationToken = entry.uri?.toString() === document.uri.toString() &&
                    declaration?.line === position.line &&
                    position.character >= declaration.startColumn && position.character < declaration.endColumn;
                return declaration?.type === "macro" && !sameDeclarationToken;
            });
            const stockSidecarMacroSignaturePotential = !model.remote &&
                compilerSelection?.semanticModelOnly === true &&
                (Boolean(sourceMacroCallAt(workspaceIndex, document, callContext)) || macroReferenceAtPosition);
            const stockSidecarArrayStoragePotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                isCompilerArrayStorageHoverPotential(model, document, position, callContext, localResolved);
            const stockSidecarFieldLayoutPotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                isCompilerFieldDeclarationHoverPotential(position, localResolved);
            const stockSidecarAggregateLayoutPotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                isCompilerAggregateDeclarationHoverPotential(position, localResolved);
            const stockSidecarParameterFactsPotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                isCompilerParameterDeclarationHoverPotential(position, localResolved);
            const stockSidecarProcedureFactsPotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                isCompilerProcedureDeclarationHoverPotential(position, localResolved);
            const stockSidecarStorageClassPotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                isCompilerStorageClassHoverPotential(document, position);
            const implicitTargetParsedDocument = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true && localResolved.length === 0
                ? workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(document.getText())
                : null;
            const implicitInputReadTarget = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true &&
                localResolved.length === 0
                ? compilerInputReadTargetAtPosition(document, position, implicitTargetParsedDocument)
                : null;
            const implicitGetTarget = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true && localResolved.length === 0
                ? compilerGetTargetAtPosition(document, position, implicitTargetParsedDocument)
                : null;
            const implicitForCounter = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true && localResolved.length === 0
                ? compilerImplicitForCounterAtPosition(document, position, implicitTargetParsedDocument)
                : null;
            const implicitAssignmentTarget = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true && localResolved.length === 0
                ? compilerImplicitAssignmentTargetAtPosition(document, position)
                : null;
            const implicitCompoundAssignmentTarget = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true && localResolved.length === 0
                ? compilerImplicitCompoundAssignmentAtPosition(document, position, implicitTargetParsedDocument)
                : null;
            const implicitSwapTarget = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true && localResolved.length === 0
                ? compilerImplicitSwapTargetAtPosition(document, position, implicitTargetParsedDocument)
                : null;
            const implicitLsetRsetTarget = !model.remote && compilerSelection?.semanticModelOnly === true &&
                document.isDirty !== true && localResolved.length === 0
                ? compilerImplicitLsetRsetTargetAtPosition(document, position, implicitTargetParsedDocument)
                : null;
            const stockSidecarVariableStoragePotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                (isCompilerVariableDeclarationHoverPotential(position, localResolved) ||
                    Boolean(implicitInputReadTarget) || Boolean(implicitGetTarget) || Boolean(implicitForCounter) ||
                    Boolean(implicitAssignmentTarget) || Boolean(implicitCompoundAssignmentTarget) ||
                    Boolean(implicitSwapTarget) || Boolean(implicitLsetRsetTarget) ||
                    Boolean(implicitLegacyVariableAtPosition) || stockSidecarNoKeywordIdentifierPotential);
            const stockSidecarHeaderLibraryPotential = !model.remote && compilerSelection?.semanticModelOnly === true &&
                isCompilerHeaderLibraryDirectiveHoverPotential(document, position);
            const native = model.remote ? await model.query("hover", document.uri, { position }, token) : null;
            if (model.remote && !native) return null;
            let compilerSidecarModel = null, sidecarHover = null;
            if (!model.remote) {
                compilerSidecarModel = await workspaceIndex.compilerAnalysis?.getModelForEditor?.(
                    document, token, true, stockSidecarConstantPotential || stockSidecarArrayStoragePotential ||
                        stockSidecarFieldLayoutPotential || stockSidecarAggregateLayoutPotential ||
                        stockSidecarParameterFactsPotential || stockSidecarProcedureFactsPotential ||
                        stockSidecarStorageClassPotential || stockSidecarVariableStoragePotential ||
                        stockSidecarHeaderLibraryPotential || stockSidecarMacroSignaturePotential ||
                        stockSidecarDeclarationSelectionPotential,
                    stockSidecarMacroSignaturePotential
                );
                if (token?.isCancellationRequested) return null;
                if (!compilerSidecarModel?.semanticSidecarOnly) {
                    const current = workspaceIndex.compilerAnalysis?.getModel(document.uri);
                    compilerSidecarModel = current?.semanticSidecarOnly ? current : null;
                }
                if (compilerSidecarModel?.remote) {
                    sidecarHover = await compilerSidecarModel.query("hover", document.uri, { position }, token);
                    if (token?.isCancellationRequested) return null;
                }
            }
            const stockSidecarConstant = stockSidecarConstantPotential && compilerSidecarModel?.remote
                ? await compilerSidecarModel.query("compilerSidecarConstantAt", document.uri, { position }, token)
                : null;
            if (token?.isCancellationRequested) return null;
            const directSidecarExpression = compilerSidecarModel?.semanticSidecarOnly && !compilerSidecarModel.remote
                ? compilerSidecarModel.expressionAt?.(document.uri, position)
                : null;
            const sidecarOperationExpression = model.remote
                ? native.expressionOperation || native.expression
                : sidecarHover?.expression?.sourceOperation
                    ? sidecarHover.expression
                    : directSidecarExpression?.sourceOperation
                        ? directSidecarExpression
                        : model.compilerSidecarFactAt?.(document.uri, position, position);
            const expression = model.remote
                ? native.expression
                : sidecarHover?.expression || directSidecarExpression || model.expressionAt?.(document.uri, position);
            let targetWideLiteral = model.remote
                ? native.targetWideLiteral
                : sidecarHover?.targetWideLiteral || directSidecarExpression?.targetWideLiteral ||
                    model.compilerTargetWideLiteralAt?.(document.uri, position);
            let selectCaseLowering = model.remote
                ? native.selectCaseLowering
                : sidecarHover?.selectCaseLowering || directSidecarExpression?.selectCaseLowering ||
                    model.compilerSelectCaseLoweringAt?.(document.uri, position);
            const arrayStorageSelection = model.remote
                ? native.arrayStorageSelection !== undefined
                    ? native.arrayStorageSelection : native.expression?.arrayStorageSelection
                : sidecarHover?.arrayStorageSelection !== undefined
                    ? sidecarHover.arrayStorageSelection
                    : sidecarHover?.expression?.arrayStorageSelection !== undefined
                        ? sidecarHover.expression.arrayStorageSelection
                        : directSidecarExpression?.arrayStorageSelection !== undefined
                        ? directSidecarExpression.arrayStorageSelection
                        : expression?.arrayStorageSelection;
            const compilerArrayFacts = model.remote
                ? native.compilerArrayFacts
                : sidecarHover?.compilerArrayFacts || sidecarHover?.expression?.arrayStorageSelection?.compilerFacts ||
                    directSidecarExpression?.arrayStorageSelection?.compilerFacts ||
                    expression?.arrayStorageSelection?.compilerFacts;
            const compilerFieldFacts = model.remote
                ? native.compilerFieldFacts : sidecarHover?.compilerFieldFacts;
            const compilerAggregateFacts = model.remote
                ? native.compilerAggregateFacts : sidecarHover?.compilerAggregateFacts;
            const compilerParameterFacts = model.remote
                ? native.compilerParameterFacts : sidecarHover?.compilerParameterFacts;
            const compilerProcedureFacts = model.remote
                ? native.compilerProcedureFacts : sidecarHover?.compilerProcedureFacts;
            const compilerProcedureVisibilityFacts = model.remote
                ? native.compilerProcedureVisibilityFacts : sidecarHover?.compilerProcedureVisibilityFacts;
            const compilerStorageClass = model.remote
                ? native.compilerStorageClass : sidecarHover?.compilerStorageClass;
            const compilerStorageTypeFacts = model.remote
                ? native.compilerStorageTypeFacts : sidecarHover?.compilerStorageTypeFacts;
            const compilerEnumElementFacts = model.remote
                ? native.compilerEnumElementFacts : sidecarHover?.compilerEnumElementFacts;
            const wideLiteralSourcePotential = !targetWideLiteral && isTargetWideLiteralSourceAtPosition(document, position);
            const selectCaseSourcePotential = !selectCaseLowering && isSelectCaseSelectorAtPosition(document, position);
            if ((wideLiteralSourcePotential || selectCaseSourcePotential) && expression && !expression.provisional &&
                compilerSelection?.semanticModelOnly === true) {
                const fullModel = await workspaceIndex.compilerAnalysis?.getModelForEditor?.(document, token, true, true);
                if (token?.isCancellationRequested) return null;
                if (fullModel?.remote && !fullModel.partial) {
                    const fullHover = await fullModel.query("hover", document.uri, { position }, token);
                    if (token?.isCancellationRequested) return null;
                    targetWideLiteral ||= fullHover?.targetWideLiteral || null;
                    selectCaseLowering ||= fullHover?.selectCaseLowering || null;
                } else if (fullModel && !fullModel.partial) {
                    targetWideLiteral ||= fullModel.compilerTargetWideLiteralAt?.(document.uri, position) || null;
                    selectCaseLowering ||= fullModel.compilerSelectCaseLoweringAt?.(document.uri, position) || null;
                }
            }
            const alternatives = model.remote
                ? native.expressionAlternatives || []
                : sidecarHover?.expressionAlternatives || compilerSidecarModel?.compilerSidecarExpressionAlternativesAt?.(document.uri, position) ||
                    model.compilerSidecarExpressionAlternativesAt?.(document.uri, position) || [];
            const typeText = expression ? `Compiler ${expression.provisional ? "recovery type (provisional)" : "type"}: \`${expression.typeName}\`` : "";
            const iifInputsText = compilerIifInputsMarkdown(expression);
            const assignmentTargetText = compilerAssignmentTargetMarkdown(expression);
            const arrayIndexText = compilerArrayIndexMarkdown(expression);
            const sizeQueryText = compilerSizeQueryMarkdown(expression);
            const arrayBoundQueryText = compilerArrayBoundQueryMarkdown(expression);
            const expressionConstantValues = model.remote
                ? native.expressionConstantValues
                : sidecarHover?.expressionConstantValues || directSidecarExpression?.compilerConstantValues ||
                    model.compilerSidecarFactAt?.(document.uri, position, position)?.compilerConstantValues;
            const expressionConstantValue = compilerConstantValue({ constantValues: expressionConstantValues });
            const constantValue = compilerConstantValueText(stockSidecarConstant) || expressionConstantValue;
            const constantText = constantValue ? `Compiler constant value in this context: \`${constantValue}\`.` : "";
            const forEntryResult = model.remote ? native.forEntryResult : sidecarHover?.forEntryResult;
            const forEntryText = forEntryResult === "skip"
                ? "Compiler FOR entry: the initial test fails, so the body is skipped."
                : forEntryResult === "enter"
                    ? "Compiler FOR entry: the initial test passes, so the body is entered."
                    : "";
            const ambiguityText = compilerSidecarAlternativesMarkdown(alternatives);
            const preprocessorDecision = model.remote
                ? native.preprocessorDecision
                : sidecarHover?.preprocessorDecision ||
                    compilerSidecarModel?.compilerConditionalDecisionAt?.(document.uri, position) ||
                    model.compilerConditionalDecisionAt?.(document.uri, position);
            const preprocessorText = compilerPreprocessorDecisionMarkdown(preprocessorDecision);
            const definedNameProbe = model.remote
                ? native.definedNameProbe
                : sidecarHover?.definedNameProbe ||
                    compilerSidecarModel?.compilerDefinedNameProbeAt?.(document.uri, position) ||
                    model.compilerDefinedNameProbeAt?.(document.uri, position);
            const definedNameText = compilerDefinedNameProbeMarkdown(definedNameProbe);
            const macroSignature = model.remote
                ? native.macroSignature
                : sidecarHover?.macroSignature || null;
            const macroSignatureText = compilerMacroSignatureMarkdown(macroSignature);
            const deferredMacroReference = model.remote
                ? native.deferredMacroReference
                : sidecarHover?.deferredMacroReference ||
                    compilerSidecarModel?.compilerDeferredMacroReferenceAt?.(document.uri, position) ||
                    model.compilerDeferredMacroReferenceAt?.(document.uri, position);
            const deferredMacroText = compilerDeferredMacroReferenceMarkdown(deferredMacroReference);
            const headerLibraries = model.remote
                ? native.compilerHeaderLibraries
                : sidecarHover?.compilerHeaderLibraries ||
                    compilerSidecarModel?.compilerHeaderLibrariesAt?.(document.uri, position) ||
                    model.compilerHeaderLibrariesAt?.(document.uri, position);
            const headerLibraryText = compilerHeaderLibraryMarkdown(headerLibraries);
            const assignmentInput = model.remote
                ? native.assignmentInput
                : model.compilerAssignmentInputAt?.(document.uri, position);
            let selectedAssignmentInput = assignmentInput;
            /* Expression-only stock sidecars omit assignment K records. Request a full model only on that operator hover. */
            if (!selectedAssignmentInput && compilerSelection?.semanticModelOnly === true &&
                isCompoundAssignmentTokenAt(document, position)) {
                const fullModel = await workspaceIndex.compilerAnalysis?.getModelForEditor?.(
                    document, token, true, true
                );
                if (token?.isCancellationRequested) return null;
                if (fullModel?.remote && !fullModel.partial) {
                    const fullHover = await fullModel.query("hover", document.uri, { position }, token);
                    selectedAssignmentInput = fullHover?.assignmentInput || null;
                } else if (fullModel && !fullModel.remote) {
                    selectedAssignmentInput = fullModel.compilerAssignmentInputAt?.(document.uri, position) || null;
                }
            }
            const assignmentInputText = compilerAssignmentInputMarkdown(selectedAssignmentInput);
            const expressionOperationText = assignmentInputText
                ? ""
                : compilerExpressionOperationMarkdown(sidecarOperationExpression, position);
            const selectedNumericOperandsText = compilerSelectedNumericOperandsMarkdown(sidecarOperationExpression, position);
            const targetWideLiteralText = compilerTargetWideLiteralText(targetWideLiteral);
            const selectCaseLoweringText = compilerSelectCaseLoweringMarkdown(selectCaseLowering);
            const arrayStorageText = compilerArrayStorageSelectionMarkdown(arrayStorageSelection);
            const compilerNoKeywordEntries = stockSidecarNoKeywordIdentifierPotential
                ? sidecarHover?.entries || [] : [];
            const hoverEntries = model.remote ? native.entries || [] : [...localResolved, ...compilerNoKeywordEntries];
            const hasArrayCompilerFacts = hoverEntries.some((entry) => {
                const facts = entry.compilerFacts || entry.declaration?.compilerFacts;
                return facts?.arrayBounds || facts?.storageType || Number.isSafeInteger(facts?.aggregateSizeBytes);
            });
            const arrayStorageFactsText = hasArrayCompilerFacts
                ? "" : compilerStorageTypeMarkdown(arrayStorageSelection?.compilerFacts || compilerArrayFacts);
            const hasFieldCompilerFacts = hoverEntries.some((entry) => {
                const facts = entry.compilerFacts || entry.declaration?.compilerFacts;
                return facts?.fieldLayout || facts?.compilerVisibility;
            });
            const compilerFieldFactsText = hasFieldCompilerFacts ? "" : [
                compilerFieldLayoutMarkdown(compilerFieldFacts),
                compilerSymbolVisibilityMarkdown(compilerFieldFacts, { type: "field" }),
                compilerStorageTypeMarkdown(compilerFieldFacts),
                compilerScalarStringInitializationMarkdown({
                    declaration: { type: "field" }, compilerFacts: compilerFieldFacts
                })
            ].filter(Boolean).join("\n\n");
            const hasAggregateBaseType = typeof compilerAggregateFacts?.baseType === "string" ||
                hoverEntries.some((entry) =>
                    typeof (entry.compilerFacts || entry.declaration?.compilerFacts)?.baseType === "string"
                );
            const hasAggregateDetails = hoverEntries.some((entry) => {
                const facts = entry.compilerFacts || entry.declaration?.compilerFacts;
                return Number.isSafeInteger(facts?.aggregateSizeBytes) ||
                    Number.isSafeInteger(facts?.abstractMemberCount) || Boolean(facts?.aggregateAccess) ||
                    facts?.properties?.some((property) =>
                        ["natural-alignment", "packing-alignment"].includes(property.name)
                    ) === true;
            });
            const hasAggregateCompilerFacts = hasAggregateBaseType || hasAggregateDetails || Boolean(compilerAggregateFacts);
            const compilerAggregateFactsText = [
                hasAggregateBaseType ? "" : compilerBaseTypeMarkdown({ type: "type" }, compilerAggregateFacts, false),
                ...(hasAggregateDetails ? [] : [
                    compilerStorageTypeMarkdown(compilerAggregateFacts),
                    compilerAbstractTypeMarkdown({ declaration: { type: "type" }, compilerFacts: compilerAggregateFacts }),
                    compilerAggregateAccessMarkdown({ declaration: { type: "type" }, compilerFacts: compilerAggregateFacts })
                ])
            ].filter(Boolean).join("\n\n");
            const hasParameterCompilerFacts = hoverEntries.some((entry) =>
                (entry.compilerFacts || entry.declaration?.compilerFacts)?.parameterPassing
            );
            const compilerParameterFactsText = hasParameterCompilerFacts
                ? "" : compilerParameterPassingMarkdown(compilerParameterFacts);
            const hasProcedureCompilerFacts = hoverEntries.some((entry) => {
                const facts = entry.compilerFacts || entry.declaration?.compilerFacts;
                return typeof facts?.procedureCallingConvention === "string" ||
                    typeof facts?.procedureReturnsByReference === "boolean";
            });
            const compilerProcedureFactsText = hasProcedureCompilerFacts
                ? "" : compilerProcedureAbiMarkdown(compilerProcedureFacts);
            const hasProcedureVisibilityFacts = hoverEntries.some((entry) =>
                (entry.compilerFacts || entry.declaration?.compilerFacts)?.compilerVisibility
            );
            const procedureHoverEntry = hoverEntries.find((entry) =>
                entry.declaration && isCallableDeclaration(entry.declaration)
            );
            const compilerProcedureVisibilityText = hasProcedureVisibilityFacts ? "" :
                compilerSymbolVisibilityMarkdown(compilerProcedureVisibilityFacts, procedureHoverEntry?.declaration);
            const hasCompilerStorageClass = hoverEntries.some((entry) =>
                (entry.compilerFacts || entry.declaration?.compilerFacts)?.compilerStorageClass
            );
            const compilerStorageClassText = hasCompilerStorageClass ||
                !["external", "static", "local", "shared", "global"].includes(compilerStorageClass)
                ? "" : `Compiler-selected storage class: \`${compilerStorageClass}\`.`;
            const compilerEnumElementText = compilerEnumElementMarkdown(compilerEnumElementFacts);
            const implicitVariableTarget = implicitInputReadTarget || implicitGetTarget || implicitForCounter ||
                implicitAssignmentTarget || implicitCompoundAssignmentTarget || implicitSwapTarget || implicitLsetRsetTarget ||
                implicitLegacyVariableAtPosition;
            const variableDeclaration = localResolved.find((entry) => entry.declaration?.type === "variable")?.declaration ||
                compilerNoKeywordEntries.find((entry) => entry.declaration?.type === "variable")?.declaration ||
                (implicitVariableTarget ? { type: "variable", name: implicitVariableTarget.name } : null);
            const compilerVariableStorageFactsText = stockSidecarVariableStoragePotential &&
                !hasArrayCompilerFacts && !compilerArrayFacts && !hasFieldCompilerFacts && !hasAggregateCompilerFacts
                ? [
                    compilerImplicitVariableTypeMarkdown(variableDeclaration, compilerStorageTypeFacts),
                    compilerStorageTypeMarkdown(compilerStorageTypeFacts),
                    compilerScalarStringInitializationMarkdown({
                        declaration: { type: "variable" }, compilerFacts: compilerStorageTypeFacts
                    })
                ].filter(Boolean).join("\n\n")
                : "";
            const expressionText = [typeText, iifInputsText, assignmentTargetText, arrayIndexText,
                sizeQueryText, arrayBoundQueryText,
                constantText, forEntryText, ambiguityText, preprocessorText,
                definedNameText, macroSignatureText, deferredMacroText, headerLibraryText, expressionOperationText,
                selectedNumericOperandsText,
                targetWideLiteralText, selectCaseLoweringText, arrayStorageText, arrayStorageFactsText,
                compilerFieldFactsText, compilerAggregateFactsText, compilerParameterFactsText,
                compilerProcedureFactsText, compilerProcedureVisibilityText, compilerStorageClassText,
                compilerVariableStorageFactsText, compilerEnumElementText,
                assignmentInputText]
                .filter(Boolean).join("\n\n");
            const tokenContext = model.remote ? (native.occurrence ? { token: native.occurrence } : null)
                : model.tokenAt(document.uri, position.line, position.character);
            const context = tokenContext || (indexHover ? { operatorIndex: true } : null);
            /* A single compiler-bound value/type declaration resolves source
               ambiguity across conditional branches. Callable families keep
               their existing overload-selection path below. */
            const compilerDeclaration = sidecarHover?.entries?.length === 1 &&
                !isCallableDeclaration(sidecarHover.entries[0].declaration)
                ? sidecarHover.entries : null;
            let resolved = model.remote ? native.entries
                : compilerDeclaration || (indexHover
                    ? sidecarHover?.entries?.length
                        ? sidecarHover.entries
                        : indexOperatorEntries(model, document, callContext)
                    : stockSidecarNoKeywordIdentifierPotential && compilerNoKeywordEntries.length
                        ? compilerNoKeywordEntries
                        : localResolved);
            if (model.remote && !resolved.length && (compilerOperatorKeywordAtPosition(document, position) ||
                isOperatorTokenAt(document, position) ||
                !callContext?.indexing && (isCastCalleeAt(document, position) || isMathOperatorCalleeAt(document, position)))) {
                const sourceModel = workspaceIndex.getSourceSemanticModel?.() ||
                    workspaceIndex.getSemanticModel(document.uri, { sourceOnly: true });
                const selectedOperator = await sidecarSelectedOperatorTarget(
                    workspaceIndex, document, position, sourceModel, token, model
                );
                if (selectedOperator) resolved = [selectedOperator.entry];
            }
            if (!model.remote && !indexHover && callContext &&
                !resolved.some((entry) => isCallableDeclaration(entry.declaration))) {
                const constructors = userConstructorEntries(model, document, callContext);
                if (constructors.length) resolved = [...constructors, ...resolved].slice(0, 5);
            }
            if (!model.remote && compilerSidecarModel?.semanticSidecarOnly) {
                const selected = await sidecarSelectedOverload(
                    workspaceIndex, document, position, model, resolved, token, compilerSidecarModel
                );
                if (selected) resolved = selected;
                if (!indexHover && !resolved.length &&
                    (expression?.operatorKind === "overloaded" && isOperatorTokenAt(document, position) ||
                        ["new", "delete"].includes(compilerOperatorKeywordAtPosition(document, position)) ||
                        hasPotentialIteratorOperatorAt(model, document, position) ||
                        isCastCalleeAt(document, position) || isMathOperatorCalleeAt(document, position) ||
                        hasPotentialOperatorLetAt(model, document, position))) {
                    const selectedOperator = await sidecarSelectedOperatorTarget(
                        workspaceIndex, document, position, model, token, compilerSidecarModel
                    );
                    if (selectedOperator) resolved = [selectedOperator.entry];
                }
            }
            if (typeof compilerAggregateFacts?.baseType === "string") {
                resolved = resolved.map((entry) => ["type", "class"].includes(entry.declaration?.type)
                    ? { ...entry, compilerFacts: { ...(entry.compilerFacts || {}), baseType: compilerAggregateFacts.baseType } }
                    : entry);
            }
            if (!context && !resolved.length) return expressionText ? new vscode.Hover(new vscode.MarkdownString(expressionText)) : null;
            if (resolved.length) {
                const markdown = createWorkspaceDeclarationMarkdown(vscode, resolved);
                const referenceMarkdown = compilerResolvedReferenceMarkdown(resolved);
                if (referenceMarkdown) markdown.appendMarkdown(`\n\n---\n\n${referenceMarkdown}`);
                if (expressionText) markdown.appendMarkdown(`\n\n${expressionText}`);
                return new vscode.Hover(markdown);
            }
            const builtIn = context?.token?.name ? getBuiltInHover(grammarData, context.token.name) : null;
            const markdown = [expressionText, builtIn].filter(Boolean).join("\n\n");
            return markdown ? new vscode.Hover(new vscode.MarkdownString(markdown)) : null;
        }
    };
}

function compilerPreprocessorDecisionMarkdown(decision) {
    if (!decision) return "";
    let result;
    if (decision.evaluation === "evaluated") {
        result = `Condition evaluated to \`${decision.result ? "true" : "false"}\`.`;
    } else if (decision.evaluation === "parent-inactive") {
        result = "Condition was not evaluated because an enclosing branch is inactive.";
    } else if (decision.evaluation === "invalid") {
        result = "The compiler could not evaluate this condition.";
    } else {
        result = "This is an unconditional branch.";
    }
    const selection = decision.selected ? "This branch is selected" : "This branch is not selected";
    return `Compiler preprocessor (\`#${decision.directive}\`): ${result} ${selection} in the current compiler context.`;
}

function compilerHeaderLibraryMarkdown(libraries) {
    if (!Array.isArray(libraries) || !libraries.length || libraries.length > 8) return "";
    const unique = new Map();
    for (const library of libraries) {
        if (!library || !["inclib", "libpath"].includes(library.kind) ||
            typeof library.value !== "string" || library.value.length > 2048 || library.value.includes("\0")) return "";
        unique.set(`${library.kind}\t${library.value}`, library);
    }
    const codeSpan = (value) => {
        const runs = value.match(/`+/g) || [];
        const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
        const delimiter = "`".repeat(longestRun + 1);
        return `${delimiter}${value}${delimiter}`;
    };
    const entries = [...unique.values()].map((library) => {
        const input = codeSpan(`#${library.kind} ${JSON.stringify(library.value)}`);
        const source = typeof library.filePath === "string" && library.filePath.length <= 4096 &&
            !/[\r\n\0]/.test(library.filePath)
            ? ` from ${codeSpan(JSON.stringify(path.basename(library.filePath)))}`
            : "";
        return input + source;
    });
    if (entries.length === 1) return `Compiler-accepted header linker input: ${entries[0]}.`;
    return `Compiler-accepted header linker inputs:\n\n${entries.map((entry) => `- ${entry}`).join("\n")}`;
}

function compilerAssignmentInputMarkdown(input) {
    if (!input || input.provisional || input.operatorKind !== "builtin" && input.operatorKind !== "overloaded") return "";
    const operations = {
        add: "addition", subtract: "subtraction", multiply: "multiplication", divide: "division",
        "integer-divide": "integer division", modulo: "modulo", and: "AND", or: "OR",
        "logical-and": "logical AND", "logical-or": "logical OR", xor: "XOR",
        equivalence: "EQV", implication: "IMP", "shift-left": "left shift",
        "shift-right": "right shift", power: "power", concatenate: "concatenation"
    };
    const operation = operations[input.operatorCode];
    const safeText = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 &&
        !/[\r\n\0`]/.test(value) ? value.trim() : "";
    const rightType = safeText(input.rightTypeName);
    if (!operation || !rightType) return "";
    const leftType = safeText(input.leftTypeName);
    const operands = leftType
        ? `source operands \`${leftType}\` and \`${rightType}\``
        : `right source operand type \`${rightType}\``;
    const resultType = safeText(input.resultTypeName);
    const targetType = safeText(input.targetTypeName);
    const resultDetail = resultType ? `; operation result \`${resultType}\`` : "";
    const targetDetail = targetType && targetType !== resultType ? `; assigned to \`${targetType}\`` : "";
    const selected = input.operatorKind === "builtin"
        ? "built-in"
        : `overloaded${safeText(input.targetName) ? ` \`${safeText(input.targetName)}\`` : ""}`;
    return `Compiler-selected compound ${operation} (${selected}) with ${operands}${resultDetail}${targetDetail}.`;
}

function compilerIifInputsMarkdown(expression) {
    const inputs = expression?.compilerIifInputs;
    if (!inputs || expression.provisional) return "";
    const safeTypeName = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 &&
        !/[\x00-\x1f\x7f`]/.test(value) ? value.trim() : "";
    const conditionType = safeTypeName(inputs.conditionTypeName);
    const trueType = safeTypeName(inputs.trueTypeName);
    const falseType = safeTypeName(inputs.falseTypeName);
    const resultType = safeTypeName(inputs.resultTypeName);
    if (!conditionType || !trueType || !falseType || !resultType ||
        normalizeTypeName(resultType) !== normalizeTypeName(expression.typeName) ||
        normalizeTypeName(trueType) === normalizeTypeName(falseType) &&
            normalizeTypeName(trueType) === normalizeTypeName(resultType)) return "";
    return `Compiler IIf input types: condition \`${conditionType}\`, true arm \`${trueType}\`, false arm \`${falseType}\`; result \`${resultType}\`.`;
}

function compilerAssignmentTargetMarkdown(expression) {
    const target = expression?.compilerAssignmentTarget;
    if (!target || expression.provisional ||
        !["destination", "initializer", "return", "function-result-assignment"].includes(target.kind)) return "";
    const safeTypeName = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 &&
        !/[\x00-\x1f\x7f`]/.test(value) ? value.trim() : "";
    const targetType = safeTypeName(target.targetTypeName);
    const sourceType = safeTypeName(target.sourceTypeName);
    const targetName = typeof target.targetName === "string" && target.targetName.length > 0 &&
        target.targetName.length <= 512 && !/[\x00-\x1f\x7f`]/.test(target.targetName)
        ? target.targetName : "";
    if (!targetType || !sourceType) {
        if (!targetName || !["destination", "initializer"].includes(target.kind)) return "";
        const context = target.kind === "initializer" ? "initializer" : "assignment";
        return `Compiler-selected ${context} destination: \`${targetName}\`.`;
    }
    if (normalizeTypeName(sourceType) !== normalizeTypeName(expression.typeName) ||
        normalizeTypeName(targetType) === normalizeTypeName(sourceType)) return "";
    if (target.kind === "return") {
        return `Compiler-selected return type: \`${targetType}\` (expression type \`${sourceType}\`).`;
    }
    if (target.kind === "function-result-assignment") {
        return `Compiler-selected function result type: \`${targetType}\` (expression type \`${sourceType}\`).`;
    }
    if (target.kind === "initializer") {
        const destination = targetName ? ` \`${targetName}\`` : "";
        return `Compiler-selected initializer target${destination}: \`${targetType}\` (expression type \`${sourceType}\`).`;
    }
    if (target.kind === "destination") {
        const destination = targetName ? ` \`${targetName}\`` : "";
        return `Compiler-selected destination${destination}: \`${targetType}\` (expression type \`${sourceType}\`).`;
    }
    const destination = targetName ? ` \`${targetName}\`` : "";
    return `Compiler-selected assignment target${destination}: \`${targetType}\` (expression type \`${sourceType}\`).`;
}

function compilerArrayIndexMarkdown(expression) {
    const input = expression?.compilerArrayIndex;
    if (!input || expression.provisional) return "";
    const safeTypeName = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 &&
        !/[\x00-\x1f\x7f`]/.test(value) ? value.trim() : "";
    const sourceType = safeTypeName(input.sourceTypeName);
    const targetType = safeTypeName(input.targetTypeName);
    if (!sourceType || !targetType || normalizeTypeName(sourceType) === normalizeTypeName(targetType)) return "";
    return `Compiler converts this \`${sourceType}\` expression to \`${targetType}\` for array indexing.`;
}

function compilerSelectedNumericOperandsMarkdown(expression, position) {
    const selected = expression?.compilerNumericOperands;
    const operation = expression?.sourceOperation;
    if (!selected || !operation || expression.provisional || operation.physical !== true ||
        !["binary", "intrinsic-binary"].includes(operation.family) ||
        !Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character) ||
        operation.startLine !== position.line + 1 || position.character < operation.startColumn ||
        position.character >= operation.endColumn) return "";
    const safeTypeName = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 &&
        !/[\x00-\x1f\x7f`]/.test(value) ? value.trim() : "";
    const sourceLeft = safeTypeName(operation.leftTypeName);
    const sourceRight = safeTypeName(operation.rightTypeName);
    const selectedLeft = safeTypeName(selected.selectedLeftTypeName);
    const selectedRight = safeTypeName(selected.selectedRightTypeName);
    if (!sourceLeft || !sourceRight || !selectedLeft || !selectedRight ||
        normalizeTypeName(sourceLeft) === normalizeTypeName(selectedLeft) &&
            normalizeTypeName(sourceRight) === normalizeTypeName(selectedRight)) return "";
    return `Compiler-selected operand types: \`${selectedLeft}\` and \`${selectedRight}\` (source operand types: \`${sourceLeft}\` and \`${sourceRight}\`).`;
}

function compilerSizeQueryMarkdown(expression) {
    const query = expression?.compilerSizeQuery;
    if (!query || expression.provisional) return "";
    const typeName = typeof query.inputTypeName === "string" && query.inputTypeName.length > 0 &&
        query.inputTypeName.length <= 512 && !/[\x00-\x1f\x7f`]/.test(query.inputTypeName)
        ? query.inputTypeName.trim() : "";
    if (!typeName) return "";
    return query.inputKind === "array"
        ? `Compiler SIZEOF input is an array of \`${typeName}\`; the result is total array storage.`
        : `Compiler SIZEOF input type: \`${typeName}\`; the expression is not evaluated.`;
}

function compilerArrayBoundQueryMarkdown(expression) {
    const query = expression?.compilerArrayBoundQuery;
    if (!query || expression.provisional || !["lower", "upper"].includes(query.kind)) return "";
    const sourceType = typeof query.sourceTypeName === "string" && query.sourceTypeName.length > 0 &&
        query.sourceTypeName.length <= 512 && !/[\x00-\x1f\x7f`]/.test(query.sourceTypeName)
        ? query.sourceTypeName.trim() : "";
    if (!sourceType || normalizeTypeName(sourceType) === "integer") return "";
    const selectedValue = query.selectedValue ? compilerConstantValueText(query.selectedValue) : "";
    if (selectedValue && (selectedValue.length > 512 || /[\r\n\0`]/.test(selectedValue))) return "";
    const queryName = query.kind === "lower" ? "LBOUND" : "UBOUND";
    const selected = selectedValue ? `; compiler-selected dimension: \`${selectedValue}\`` : "";
    return `Compiler converts this ${queryName} dimension from \`${sourceType}\` to \`Integer\`${selected}.`;
}

function compilerExpressionOperationMarkdown(expression, position) {
    const operation = expression?.sourceOperation;
    if (!operation || expression.provisional || operation.physical !== true ||
        !Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character) ||
        !Number.isSafeInteger(operation.startLine) || !Number.isSafeInteger(operation.startColumn) ||
        !Number.isSafeInteger(operation.endLine) || !Number.isSafeInteger(operation.endColumn) ||
        operation.startLine < 1 || operation.startColumn < 0 || operation.endLine !== operation.startLine ||
        operation.endColumn <= operation.startColumn || position?.line !== operation.startLine - 1 ||
        position.character < operation.startColumn || position.character >= operation.endColumn) return "";

    const label = Object.prototype.hasOwnProperty.call(COMPILER_SOURCE_OPERATION_LABELS, operation.operator)
        ? COMPILER_SOURCE_OPERATION_LABELS[operation.operator] : "";
    const arity = operation.family === "runtime-macro"
        ? Object.prototype.hasOwnProperty.call(COMPILER_SOURCE_RUNTIME_MACRO_ARITIES, operation.operator)
            ? COMPILER_SOURCE_RUNTIME_MACRO_ARITIES[operation.operator] : 0
        : Object.prototype.hasOwnProperty.call(COMPILER_SOURCE_OPERATION_ARITIES, operation.family)
            ? COMPILER_SOURCE_OPERATION_ARITIES[operation.family] : 0;
    const safeTypeName = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 &&
        !/[\x00-\x1f\x7f`]/.test(value) ? value.trim() : "";
    const resultType = safeTypeName(expression.typeName || operation.resultTypeName);
    const leftType = safeTypeName(operation.leftTypeName);
    const rightType = safeTypeName(operation.rightTypeName);
    const requiresResultType = operation.family !== "runtime-macro" || operation.operator === "va-arg";
    if (!label || !arity || requiresResultType && !resultType || !leftType || arity === 2 && !rightType) return "";

    const kind = expression.operatorKind === "builtin" ? " (built-in)"
        : expression.operatorKind === "overloaded" ? " (overloaded)" : "";
    const operands = arity === 2
        ? `operand types \`${leftType}\` and \`${rightType}\``
        : `operand type \`${leftType}\``;
    const resultDetail = resultType ? `; result type \`${resultType}\`` : "";
    return `Compiler ${label}${kind} with ${operands}${resultDetail}.`;
}

function compilerSelectCaseLoweringMarkdown(lowering) {
    if (lowering?.kind === "comparisons" && Number.isSafeInteger(lowering.count) &&
        lowering.count > 0 && lowering.count <= MAX_COMPILER_SELECT_CASE_COMPARISON_TESTS) {
        return `Compiler SELECT CASE lowering: ${lowering.count} comparison ${lowering.count === 1 ? "test" : "tests"}.`;
    }
    if (lowering?.kind !== "jump-table" || !Number.isSafeInteger(lowering.slots) ||
        lowering.slots < 1 || lowering.slots > 256 || !Number.isSafeInteger(lowering.entries) ||
        lowering.entries < 1 || lowering.entries > 255) return "";
    const entryWord = lowering.entries === 1 ? "entry" : "entries";
    return `Compiler SELECT CASE lowering: jump table with ${lowering.slots} slots (${lowering.entries} populated ${entryWord}).`;
}

function compilerArrayStorageSelectionMarkdown(selection) {
    if (!selection || !["field", "variable"].includes(selection.kind) ||
        typeof selection.name !== "string" || !selection.name ||
        selection.name.length > MAX_COMPILER_ARRAY_STORAGE_NAME_LENGTH ||
        /[\x00-\x1f\x7f`]/.test(selection.name)) return "";
    const storageKind = selection.kind === "field" ? "field" : "variable";
    const escapedName = selection.name.replace(/\\/g, "\\\\");
    return `Compiler-selected array storage: ${storageKind} \`${escapedName}\`.`;
}

function compilerEnumElementMarkdown(facts) {
    if (!facts || typeof facts.explicit !== "boolean" || !Number.isSafeInteger(facts.ordinal) ||
        facts.ordinal < 1) return "";
    const source = facts.explicit ? "written explicitly" : "assigned implicitly";
    return `Compiler confirms this enum value was ${source} (member ${facts.ordinal}).`;
}

function isTargetWideLiteralSourceAtPosition(document, position) {
    if (!document || !position) return false;
    const line = document.lineAt(position.line).text;
    const limit = Math.min(line.length, position.character + 1);
    const linePrefix = line.slice(0, limit);
    if (getCodeContext(linePrefix, linePrefix.length) !== "string") return false;
    let stringStart = -1;
    let inString = false;
    for (let index = 0; index < limit; index++) {
        if (!inString) {
            if (line[index] === '"') {
                stringStart = index;
                inString = true;
            }
        } else if (line[index] === '"') {
            if (line[index + 1] === '"') {
                index++;
                continue;
            }
            stringStart = -1;
            inString = false;
        }
    }
    if (!inString || stringStart < 0) return false;
    if (line[stringStart - 1] === "!") return true;
    return /\bWStr\s*\([^)]*$/i.test(line.slice(0, stringStart));
}

function isSelectCaseSelectorAtPosition(document, position) {
    if (!document || !position || !Number.isSafeInteger(position.character)) return false;
    const line = document.lineAt(position.line).text;
    const selectCase = /^\s*select\s+case\b/i.exec(line);
    if (!selectCase) return false;
    const afterSelectCase = line.slice(selectCase[0].length);
    const asConst = /^\s*as\s+const\b/i.exec(afterSelectCase);
    const selectorStart = selectCase[0].length + (asConst ? asConst[0].length : 0);
    return position.character >= selectorStart && Boolean(line.slice(selectorStart).trim());
}

function isCompoundAssignmentTokenAt(document, position) {
    if (!document || !position || getCodeContext(document.getText(), document.offsetAt(position)) !== "code") return false;
    const line = document.lineAt(position.line).text;
    for (const operator of COMPOUND_ASSIGNMENT_TOKENS) {
        const first = Math.max(0, position.character - operator.length + 1);
        const last = Math.min(position.character, line.length - operator.length);
        for (let start = first; start <= last; start++) {
            if (start > position.character || position.character >= start + operator.length ||
                line.slice(start, start + operator.length).toLowerCase() !== operator.toLowerCase()) continue;
            if (/^[A-Z]+=$/i.test(operator) &&
                (/[A-Za-z0-9_]/.test(line[start - 1] || "") || /[A-Za-z0-9_]/.test(line[start + operator.length] || ""))) continue;
            return true;
        }
    }
    return false;
}

function compilerDefinedNameProbeMarkdown(probe) {
    if (!probe) return "";
    const state = probe.defined ? "is defined" : "is not defined";
    return `Compiler preprocessor: \`${probe.spelling}\` ${state} in the current compiler context.`;
}

function compilerMacroSignatureMarkdown(signature) {
    if (!signature || typeof signature.signature !== "string" || !signature.signature) return "";
    const summary = `Compiler-selected macro signature: \`${signature.signature}\`.`;
    return typeof signature.sourceDefinition === "string" && signature.sourceDefinition
        ? `${summary}\n\nActive compiler macro definition:\n\n\`\`\`freebasic\n${signature.sourceDefinition}\n\`\`\``
        : summary;
}

function compilerDeferredMacroReferenceMarkdown(reference) {
    if (!reference?.name || !["unexpanded", "ambiguous"].includes(reference.outcome)) return "";
    const explanation = reference.outcome === "ambiguous"
        ? "Observed expansions select different macro definitions, so no unique target is available."
        : "This replacement-list name has not been expanded in the current compiler snapshot; FreeBASIC resolves it when the macro is invoked.";
    return `Deferred macro reference: \`${reference.name}\`. ${explanation}`;
}

function compilerResolvedReferenceMarkdown(entries) {
    const references = new Set();
    for (const entry of entries) {
        const sourcePath = entry.uri?.fsPath || entry.uri?.path;
        const qualifiedName = entry.qualifiedName || entry.declaration?.qualifiedName;
        if (!sourcePath || !qualifiedName) continue;

        const markdown = getReferenceMarkdown(qualifiedName, { header: path.basename(sourcePath) });
        if (markdown) references.add(markdown);
    }
    return [...references].join("\n\n---\n\n");
}

function compilerSidecarAlternativesMarkdown(alternatives) {
    if (!alternatives?.length) return "";
    const typeLines = alternatives.map((alternative) => {
        const contexts = (alternative.contexts || []).map((context) => {
            const labels = (context.includePath || []).map((sourceContext) => {
                const fileName = sourceContext.filePath ? path.basename(sourceContext.filePath) : "source";
                if (sourceContext.kind === "module") return fileName;
                const requested = sourceContext.requested || fileName;
                const directive = sourceContext.directive;
                const location = directive?.filePath && directive.startLine
                    ? ` from ${path.basename(directive.filePath)}:${directive.startLine}`
                    : "";
                return `${requested}${location}`;
            });
            return labels.join(" > ");
        }).filter(Boolean);
        const route = contexts.length ? ` via ${contexts.join(" or ")}` : "";
        const moreContexts = alternative.additionalContexts
            ? ` (${alternative.additionalContexts} more include contexts)`
            : "";
        return `- \`${alternative.typeName}\`${route}${moreContexts}`;
    });
    return `Compiler type depends on the include instance. No single type is safe to report.\n\nPossible compiler results:\n\n${typeLines.join("\n")}`;
}

function addPreprocessorCompletions(vscode, items, seenLabels, directives, hasDirectivePrefix) {
    for (const directive of directives) {
        const label = `#${directive}`;
        const normalizedLabel = label.toLowerCase();

        if (seenLabels.has(normalizedLabel)) {
            continue;
        }

        seenLabels.add(normalizedLabel);
        const completionItem = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
        completionItem.detail = "FreeBASIC preprocessor directive";
        completionItem.insertText = hasDirectivePrefix ? directive : label;
        completionItem.sortText = `2_${normalizedLabel}`;
        items.push(completionItem);
    }
}

function addPreprocessorDefinedCompletion(vscode, items, seenLabels) {
    const name = "defined";
    const normalizedName = normalizeIdentifier(name);
    if (seenLabels.has(normalizedName)) return;

    seenLabels.add(normalizedName);
    const completionItem = new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword);
    completionItem.detail = "FreeBASIC preprocessor defined-name operator";
    completionItem.insertText = new vscode.SnippetString("defined(${1:MACRO})");
    completionItem.sortText = `2_${normalizedName}`;
    items.push(completionItem);
}

function addWordCompletions(vscode, items, seenLabels, words, kind, detail, referenceImportContext = null) {
    for (const word of words) {
        const normalizedLabel = word.toLowerCase();
        if (seenLabels.has(normalizedLabel)) {
            continue;
        }

        seenLabels.add(normalizedLabel);
        const completionItem = new vscode.CompletionItem(word, kind);
        completionItem.detail = detail;
        completionItem.insertText = kind === vscode.CompletionItemKind.Function
            ? referenceCallSnippet(vscode, word) || word
            : word;
        const importEdits = referenceImportContext
            ? referenceCompletionImportEdits(vscode, referenceImportContext, word)
            : [];
        if (importEdits.length) {
            completionItem.additionalTextEdits = importEdits;
            completionItem.detail = `${detail} (adds missing header/namespace)`;
        }
        completionItem.sortText = `2_${normalizedLabel}`;
        items.push(completionItem);
    }
}

function referenceCompletionImportState(context) {
    if (Object.hasOwn(context, "importState")) return context.importState;
    const { document, position, workspaceIndex } = context;
    const text = document.getText();
    if (text.length > MAX_REFERENCE_IMPORT_SOURCE_LENGTH) {
        context.importState = null;
        return null;
    }

    const parsed = workspaceIndex.getParsedDocument?.(document) || parseFreeBasicText(text);
    const sourceDocument = createDocumentModel(document.uri, parsed);
    const completionOffset = document.offsetAt(position);
    const completionScope = scopeAt(sourceDocument, completionOffset);
    const maskedLines = maskFreeBasicText(text).split(/\r\n|\n|\r/);
    const conditionalDepths = new Uint32Array(maskedLines.length);
    let conditionalDepth = 0;
    for (let line = 0; line < maskedLines.length; line++) {
        const code = maskedLines[line].trim();
        if (/^#endif\b/i.test(code)) conditionalDepth = Math.max(0, conditionalDepth - 1);
        conditionalDepths[line] = conditionalDepth;
        if (/^#(?:if|ifdef|ifndef)\b/i.test(code)) conditionalDepth++;
    }

    const namespaces = new Set();
    for (let current = completionScope; current; current = current.parent) {
        for (const imported of current.imports || []) {
            if (imported.offset > completionOffset) continue;
            const line = document.positionAt(imported.offset).line;
            if (conditionalDepths[line] > 0) continue;
            namespaces.add(normalizeIdentifier(imported.name));
        }
    }

    const headers = new Map();
    for (const include of parsed.includes || []) {
        if (!Number.isSafeInteger(include.line) || include.line >= position.line || conditionalDepths[include.line] > 0) continue;
        const includeOffset = sourceOffsetAt(document, include.line, include.startColumn || 0);
        const includeScope = scopeAt(sourceDocument, includeOffset);
        let visibleScope = false;
        for (let current = completionScope; current; current = current.parent) {
            if (current === includeScope) {
                visibleScope = true;
                break;
            }
        }
        if (!visibleScope) continue;
        const headerName = path.basename(String(include.path || "").replace(/\\/g, "/")).toLowerCase();
        if (!headers.has(headerName)) headers.set(headerName, include.line);
    }

    context.importState = { text, headers, namespaces };
    return context.importState;
}

function referenceCompletionImportEdits(vscode, context, name) {
    const { document, position } = context;
    if (document.uri?.scheme !== "file" || !/\.(?:bas|bi)$/i.test(document.uri.fsPath || "") ||
        typeof vscode.TextEdit?.insert !== "function") return [];

    const mappings = new Map();
    for (const entry of getReferenceEntries(name)) {
        const header = entry.header;
        const namespace = entry.namespace || "";
        if (typeof header !== "string" || !/^[A-Za-z0-9_.-]+\.bi$/i.test(header) || header.includes("..") ||
            namespace && !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(namespace)) continue;
        mappings.set(`${header.toLowerCase()}\t${namespace.toLowerCase()}`, { header, namespace });
    }
    if (mappings.size !== 1) return [];

    const { header, namespace } = mappings.values().next().value;
    const importState = referenceCompletionImportState(context);
    if (!importState) return [];
    const headerLine = importState.headers.get(header.toLowerCase()) ?? -1;
    const namespaceVisible = namespace && importState.namespaces.has(normalizeIdentifier(namespace));
    const statements = [];
    if (headerLine < 0) statements.push(`#include once "${header}"`);
    if (namespace && !namespaceVisible) statements.push(`Using ${namespace}`);
    if (!statements.length) return [];

    const insertion = headerLine >= 0
        ? includeInsertionAfterLine(vscode, document, headerLine)
        : includeInsertionPosition(vscode, document, importState.text);
    if (insertion.position.line === position.line) {
        const replacementRange = document.getWordRangeAtPosition?.(position, IDENTIFIER_PATTERN);
        if (!replacementRange || insertion.position.character >= replacementRange.start.character &&
            insertion.position.character <= replacementRange.end.character) return [];
    }

    const lineEnding = importState.text.match(/\r\n|\n|\r/)?.[0] || "\n";
    const prefix = insertion.prefix ? lineEnding : "";
    return [vscode.TextEdit.insert(insertion.position, `${prefix}${statements.join(lineEnding)}${lineEnding}`)];
}

function completionNameCallSnippetEligibility(entries) {
    const declarationsByName = new Map();
    for (const entry of entries) {
        const name = entry.name || entry.declaration?.name;
        if (typeof name !== "string" || !name) continue;
        const key = normalizeIdentifier(name);
        const declarations = declarationsByName.get(key) || [];
        declarations.push(entry.declaration || entry);
        declarationsByName.set(key, declarations);
    }

    const eligibility = new Map();
    for (const [name, declarations] of declarationsByName) {
        const callableOnly = declarations.every((declaration) =>
            ["function", "sub"].includes(declaration.type) || declaration.type === "property" && Boolean(declaration.typeName)
        );
        const uniqueMacro = declarations.length === 1 && declarations[0].type === "macro" &&
            Array.isArray(declarations[0].parameters) && declarations[0].parameters.length > 0;
        const signatures = new Set(declarations.map(completionParameterShape));
        const overloadKeyword = declarations.some((declaration) =>
            /\bOVERLOAD\b/i.test([declaration.signature, declaration.detail, declaration.sourceLine].filter(Boolean).join(" "))
        );
        const parameterCount = Math.max(0, ...declarations.map((declaration) => declaration.parameters?.length || 0));
        const parameters = Array.from({ length: parameterCount }, (_unused, index) => {
            const candidates = declarations.map((declaration) => declaration.parameters?.[index]).filter(Boolean);
            return candidates.find((parameter) => parameter.optional === true) || candidates[0];
        });
        const signatureDetails = [...new Map(declarations.map((declaration) => String(declaration.signature || "").trim())
            .filter(Boolean)
            .map((signature) => [signature.toLowerCase().replace(/\s+/g, " "), signature])).values()];
        const deprecationStates = new Set(declarations.map(completionDeclarationIsDeprecated));
        eligibility.set(name, {
            allowed: uniqueMacro || callableOnly && signatures.size === 1 && !overloadKeyword,
            parameters,
            signatureDetails,
            deprecated: deprecationStates.size === 1 && deprecationStates.has(true)
        });
    }
    return eligibility;
}

function completionDeclarationIsDeprecated(declaration) {
    return semanticEntryIsDeprecated(declaration);
}

function completionParameterShape(declaration) {
    const parameters = Array.isArray(declaration.parameters) ? declaration.parameters : [];
    return JSON.stringify([
        declaration.type,
        String(declaration.typeName || "").replace(/\s+/g, " ").toLowerCase(),
        parameters.map((parameter) => {
            const label = String(parameter.label || "");
            const mode = label.match(/^\s*(byval|byref|bydesc|bycopy)\b/i)?.[1]?.toLowerCase() || "";
            return [mode, String(parameter.typeName || "").replace(/\s+/g, " ").toLowerCase(), /\bconst\b/i.test(label),
                parameter.variadic === true];
        })
    ]);
}

function requiredCallParameters(parameters) {
    const firstOptional = parameters.findIndex((parameter) => parameter.optional === true);
    const optionalParametersAreTrailing = firstOptional >= 0 &&
        parameters.slice(firstOptional).every((parameter) => parameter.optional === true);
    return optionalParametersAreTrailing ? parameters.slice(0, firstOptional) : parameters;
}

function parameterCallSnippet(vscode, name, parameters) {
    const snippet = new vscode.SnippetString();
    snippet.appendText(`${name}(`);
    parameters.forEach((parameter, index) => {
        if (index > 0) snippet.appendText(", ");
        snippet.appendPlaceholder(parameter.name || `arg${index + 1}`, index + 1);
    });
    snippet.appendText(")");
    snippet.appendTabstop(0);
    return snippet;
}

function completionCallSnippet(vscode, declaration, parameterMetadata = declaration.parameters) {
    const callable = ["function", "sub", "macro"].includes(declaration.type) ||
        declaration.type === "property" && Boolean(declaration.typeName);
    if (!callable) return null;
    const declaredParameters = Array.isArray(parameterMetadata) ? parameterMetadata : [];
    if (!declaredParameters.length) return null;
    if (declaration.type !== "macro" &&
        /\bOVERLOAD\b/i.test([declaration.signature, declaration.detail, declaration.sourceLine].filter(Boolean).join(" "))) return null;
    return parameterCallSnippet(vscode, declaration.name, requiredCallParameters(declaredParameters));
}

function referenceCallSnippet(vscode, name) {
    const signatures = getReferenceSignatures(name).filter((signature) => Array.isArray(signature.parameters) && signature.parameters.length);
    if (!signatures.length) return null;
    const required = signatures.map((signature) => requiredCallParameters(signature.parameters));
    const parameterNames = (parameters) => parameters.map((parameter, index) =>
        String(parameter.name || `arg${index + 1}`).toLowerCase()
    );
    const firstNames = parameterNames(required[0]);
    if (required.slice(1).some((parameters) => {
        const names = parameterNames(parameters);
        return names.length !== firstNames.length || names.some((parameterName, index) => parameterName !== firstNames[index]);
    })) return null;
    const canonicalName = signatures[0].label.match(/\b(?:function|sub)\s+([A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?)/i)?.[1] || name;
    return parameterCallSnippet(vscode, canonicalName, required[0]);
}

function addDeclarationCompletion(vscode, items, seenLabels, declaration, priority, callSnippetEligibility = null) {
    const normalizedLabel = declaration.name.toLowerCase();
    if (seenLabels.has(normalizedLabel)) {
        return false;
    }

    seenLabels.add(normalizedLabel);
    const completionItem = new vscode.CompletionItem(
        declaration.name,
        declarationTypeToCompletionKind(vscode, declaration.type, declaration.callableKind)
    );
    const selectedType = declaration.typeName ? ` As ${declaration.typeName}` : "";
    const detail = `${declaration.detail || declaration.type}${selectedType}`;
    const compilerValue = declaration.provisional ? "" : compilerConstantValue(declaration.compilerFacts);
    const valueDetail = compilerValue ? ` (compiler value: ${compilerValue})` : "";
    const compilerStorageClass = declaration.compilerFacts?.compilerStorageClass;
    const storageDetail = ["variable", "extern"].includes(declaration.type) &&
        ["external", "static", "local", "shared", "global"].includes(compilerStorageClass)
        ? ` (storage: ${compilerStorageClass})` : "";
    completionItem.detail = declaration.provisional
        ? `${detail} (provisional recovery)`
        : `${detail}${valueDetail}${storageDetail}`;
    const signatureDetails = callSnippetEligibility?.signatureDetails || [];
    if (!declaration.provisional && callSnippetEligibility?.deprecated === true &&
        vscode.CompletionItemTag?.Deprecated !== undefined) {
        completionItem.tags = [vscode.CompletionItemTag.Deprecated];
    }
    if (signatureDetails.length > 1) {
        const documentation = new vscode.MarkdownString();
        const shownSignatures = signatureDetails.slice(0, MAX_COMPLETION_SIGNATURE_DETAILS);
        for (const signature of shownSignatures) {
            documentation.appendCodeblock(signature, "freebasic");
        }
        const remainingSignatures = signatureDetails.length - shownSignatures.length;
        if (remainingSignatures > 0) {
            documentation.appendMarkdown(`\n\n${remainingSignatures} additional signatures omitted.`);
        }
        completionItem.documentation = documentation;
        completionItem.detail = `${completionItem.detail} (${signatureDetails.length} signatures)`;
    } else {
        completionItem.documentation = new vscode.MarkdownString(
            `\`\`\`freebasic\n${declaration.signature}\n\`\`\``
        );
    }
    const sourceDocumentation = compilerDeclarationDocumentation(declaration);
    if (signatureDetails.length <= 1 && sourceDocumentation) {
        completionItem.documentation.appendMarkdown(`\n\n${sourceDocumentation}`);
    }
    if (signatureDetails.length <= 1 && callSnippetEligibility?.deprecated === true) {
        const deprecation = compilerDeprecatedMarkdown({ declaration });
        if (deprecation) completionItem.documentation.appendMarkdown(`\n\n${deprecation}`);
    }
    if (signatureDetails.length <= 1) {
        const headerLibraries = compilerHeaderLibraryMarkdown(declaration.compilerHeaderLibraries);
        if (headerLibraries) completionItem.documentation.appendMarkdown(`\n\n${headerLibraries}`);
    }
    if (isCallableDeclaration(declaration) && !declaration.provisional && signatureDetails.length <= 1) {
        const procedureAbi = compilerProcedureAbiMarkdown(declaration.compilerFacts);
        if (procedureAbi) completionItem.documentation.appendMarkdown("\n\n" + procedureAbi);
        const overrideTarget = compilerProcedureOverrideMarkdown(declaration.compilerFacts);
        if (overrideTarget) completionItem.documentation.appendMarkdown("\n\n" + overrideTarget);
    }
    if (!declaration.provisional) {
        const parameterPassing = compilerParameterPassingMarkdown(declaration.compilerFacts);
        if (parameterPassing) completionItem.documentation.appendMarkdown("\n\n" + parameterPassing);
    }
    const oneDeclaration = !isCallableDeclaration(declaration) || signatureDetails.length <= 1;
    if (!declaration.provisional && oneDeclaration) {
        const implicitReturnType = compilerImplicitProcedureReturnTypeMarkdown({ declaration });
        if (implicitReturnType) completionItem.documentation.appendMarkdown("\n\n" + implicitReturnType);
        const implicitParameterType = compilerImplicitParameterTypeMarkdown({ declaration });
        if (implicitParameterType) completionItem.documentation.appendMarkdown("\n\n" + implicitParameterType);
        const stringInitialization = compilerScalarStringInitializationMarkdown({ declaration });
        if (stringInitialization) completionItem.documentation.appendMarkdown("\n\n" + stringInitialization);
        const storageType = compilerStorageTypeMarkdown(declaration.compilerFacts);
        if (storageType) completionItem.documentation.appendMarkdown("\n\n" + storageType);
        const visibility = compilerSymbolVisibilityMarkdown(declaration.compilerFacts, declaration);
        if (visibility) completionItem.documentation.appendMarkdown("\n\n" + visibility);
        const abstractType = compilerAbstractTypeMarkdown({ declaration });
        if (abstractType) completionItem.documentation.appendMarkdown("\n\n" + abstractType);
        const baseType = compilerBaseTypeMarkdown(declaration, declaration.compilerFacts);
        if (baseType) completionItem.documentation.appendMarkdown("\n\n" + baseType);
        const aggregateAccess = compilerAggregateAccessMarkdown({ declaration });
        if (aggregateAccess) completionItem.documentation.appendMarkdown("\n\n" + aggregateAccess);
        if (declaration.type === "field") {
            const fieldLayout = compilerFieldLayoutMarkdown(declaration.compilerFacts);
            if (fieldLayout) completionItem.documentation.appendMarkdown("\n\n" + fieldLayout);
        }
    }
    if (declaration.compilerMacroDefinition) {
        completionItem.documentation.appendMarkdown("\n\nSource definition:");
        completionItem.documentation.appendCodeblock(declaration.compilerMacroDefinition, "freebasic");
    }
    const callSnippet = callSnippetEligibility?.allowed
        ? callSnippetEligibility.constructorType
            ? callSnippetEligibility.parameters.length
                ? parameterCallSnippet(vscode, declaration.name, requiredCallParameters(callSnippetEligibility.parameters))
                : null
            : completionCallSnippet(vscode, declaration, callSnippetEligibility.parameters)
        : null;
    if (callSnippet) {
        completionItem.insertText = callSnippet;
    } else {
        completionItem.insertText = declaration.name;
    }
    completionItem.sortText = `${priority}_${normalizedLabel}`;
    items.push(completionItem);
    return true;
}

function getBuiltInHover(grammarData, name) {
    const referenceMarkdown = getReferenceMarkdown(name);
    if (referenceMarkdown) return referenceMarkdown;
    const upperName = name.toUpperCase();
    const simpleName = upperName.includes(".") ? upperName.split(".").at(-1) : upperName;

    const groups = [
        [grammarData.preprocessorDirectives, `\`#${simpleName}\`\n\nFreeBASIC preprocessor directive.`],
        [grammarData.operatorKeywords, `\`${simpleName}\`\n\nFreeBASIC word operator.`],
        [grammarData.keywords, `\`${simpleName}\`\n\nFreeBASIC keyword.`],
        [grammarData.types, `\`${simpleName}\`\n\nFreeBASIC built-in type.`],
        [grammarData.libraryTypes, `\`${simpleName}\`\n\nType declared by a bundled FreeBASIC header.`],
        [grammarData.typeModifiers, `\`${simpleName}\`\n\nFreeBASIC declaration modifier.`],
        [grammarData.intrinsicFunctions, `\`${simpleName}\`\n\nFreeBASIC intrinsic function or built-in helper.`],
        [grammarData.runtimeFunctions, `\`${simpleName}\`\n\nFreeBASIC runtime function.`],
        [grammarData.graphicsFunctions, `\`${simpleName}\`\n\nFreeBASIC graphics, input, or audio runtime function.`],
        [grammarData.bundledFunctions, `\`${simpleName}\`\n\nFunction or sub declared by a bundled FreeBASIC header.`],
        [grammarData.constants, `\`${simpleName}\`\n\nFreeBASIC language constant.`],
        [grammarData.compilerDefines, `\`${simpleName}\`\n\nFreeBASIC compiler define.`],
        [grammarData.symbolicConstants, `\`${simpleName}\`\n\nFreeBASIC symbolic constant.`]
    ];

    for (const [values, hoverText] of groups) {
        if (values.includes(simpleName) || values.includes(upperName)) {
            return `${hoverText}\n\nLanguage data target: FreeBASIC ${grammarData.sourceVersion}.`;
        }
    }

    return null;
}

/* ------------------------------------------------------------------------- */
/* Symbols and navigation                                                     */
/* ------------------------------------------------------------------------- */

function createDocumentSymbolRegistration(vscode, selector, provider, analysis) {
    return createSnapshotProviderRegistration(vscode, provider, analysis, "provideDocumentSymbols",
        (registered) => vscode.languages.registerDocumentSymbolProvider(selector, registered));
}

function createDocumentLinkRegistration(vscode, selector, provider, analysis) {
    return createSnapshotProviderRegistration(vscode, provider, analysis, "provideDocumentLinks",
        (registered) => vscode.languages.registerDocumentLinkProvider(selector, registered));
}

function createSnapshotProviderRegistration(vscode, provider, analysis, method, register) {
    let registration;
    let timer = null, disposed = false;
    let activeRequests = 0, refreshPending = false;
    const refresh = () => {
        if (disposed) return;
        refreshPending = true;
        if (timer !== null || activeRequests > 0) return;
        /* VS Code caches Outline and links by model/provider registration.
           Neither API has a provider refresh event. Coalesce settings and
           snapshot notifications over 25 ms, then change the registration to
           expire it without walking the workspace or querying the compiler. */
        timer = setTimeout(() => {
            timer = null;
            if (disposed || activeRequests > 0) return;
            refreshPending = false;
            registration.dispose();
            registration = register(registeredProvider);
        }, 25);
    };
    const registeredProvider = { ...provider, async [method](document, token) {
        if (disposed || token?.isCancellationRequested) return [];
        // Disposing a registration cancels its active provider tokens. Let the
        // request finish before refreshing, or its own compiler pass can abort.
        activeRequests++;
        try {
            return await provider[method](document, token);
        } finally {
            activeRequests--;
            if (activeRequests === 0 && refreshPending) refresh();
        }
    } };
    registration = register(registeredProvider);
    const subscriptions = [
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (["freebasic.analysis", "freebasic.compiler", "freebasic.includePaths"].some((name) => event.affectsConfiguration(name))) refresh();
        }),
        analysis.onDidChangeSnapshot?.((uris) => {
            const editors = [vscode.window.activeTextEditor, ...(vscode.window.visibleTextEditors || [])];
            if (Array.isArray(uris) && editors.some((editor) => editor?.document?.languageId === "freebasic" &&
                uris.includes(editor.document.uri.toString()))) refresh();
        }),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            const document = editor?.document;
            if (document?.languageId === "freebasic" &&
                (analysis.isConfigured(document.uri) || analysis.getModel(document.uri))) refresh();
        })
    ].filter(Boolean);
    return { dispose() {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        for (const subscription of subscriptions) subscription.dispose();
        registration.dispose();
    } };
}

function createDocumentSymbolProvider(vscode, workspaceIndex) {
    return {
        async provideDocumentSymbols(document, token) {
            const analysis = workspaceIndex.compilerAnalysis;
            const semanticSidecarOnly = document.uri.scheme === "file" &&
                analysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true;
            if (!semanticSidecarOnly && (analysis?.isConfigured(document.uri) || document.uri.scheme === "freebasic-preprocessed")) {
                let model = analysis?.getModel(document.uri);
                if (analysis?.isConfigured(document.uri) && hasPotentialMaskedRemIdentifierInDocument(document)) {
                    const bindingModel = await analysis.getModelForEditor?.(document, token, false, true);
                    if (token?.isCancellationRequested) return [];
                    if (bindingModel?.remote) model = bindingModel;
                }
                if (!model && document.uri.scheme === "file" && await analysis.check(document, false, token)) model = analysis.getModel(document.uri);
                if (!model?.remote || token?.isCancellationRequested) return [];
                const records = await model.query("documentSymbols", document.uri, {}, token);
                if (!records) return [];
                const pointRange = (range) => new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
                const symbols = records.map((record) => {
                    const symbol = new vscode.DocumentSymbol(record.name, record.detail,
                        declarationTypeToSymbolKind(vscode, record.type, record.callableKind), pointRange(record.range), pointRange(record.selection));
                    if (record.deprecated === true && vscode.SymbolTag?.Deprecated !== undefined) {
                        symbol.tags = [...new Set([...(symbol.tags || []), vscode.SymbolTag.Deprecated])];
                    }
                    return symbol;
                });
                const roots = [];
                for (const record of records) {
                    if (record.parent === null) roots.push(symbols[record.index]);
                    else symbols[record.parent].children.push(symbols[record.index]);
                }
                const pending = [roots];
                while (pending.length) {
                    const children = pending.pop();
                    children.sort((a, b) => a.selectionRange.start.line - b.selectionRange.start.line || a.selectionRange.start.character - b.selectionRange.start.character);
                    for (const child of children) if (child.children.length) pending.push(child.children);
                }
                return roots;
            }
            const documentVersion = document.version;
            const parsedDocument = workspaceIndex.getParsedDocument(document);
            let cachedModelRead = false;
            let cachedModel = null;
            const getCachedModel = () => {
                if (!cachedModelRead) {
                    cachedModel = analysis?.getModel?.(document.uri) || null;
                    cachedModelRead = true;
                }
                return cachedModel;
            };
            const [outlineConstantValues, outlineTypeDetails, sidecarImplicitVariables, sidecarMaskedVariables] = semanticSidecarOnly
                ? await Promise.all([
                    cachedStockSidecarOutlineConstantValues(
                        analysis, document, parsedDocument.declarations, token, getCachedModel
                    ),
                    cachedStockSidecarOutlineDetails(
                        analysis, document, parsedDocument.declarations, token, getCachedModel
                    ),
                    cachedStockSidecarOutlineImplicitVariables(
                        analysis, document, parsedDocument.declarations, token, getCachedModel
                    ),
                    cachedStockSidecarMaskedVariableOutlineDeclarations(
                        analysis, document, parsedDocument.declarations, token, getCachedModel
                    )
                ])
                : [null, null, [], []];
            if (token?.isCancellationRequested || document.version !== documentVersion) return [];
            const declarations = [...parsedDocument.declarations];
            const details = new Map(outlineTypeDetails || []);
            for (const implicitVariable of sidecarImplicitVariables) {
                declarations.push(implicitVariable.declaration);
                details.set(implicitVariable.declaration, implicitVariable.typeDetails);
            }
            for (const maskedVariable of sidecarMaskedVariables) {
                declarations.push(maskedVariable.declaration);
                details.set(maskedVariable.declaration, maskedVariable.typeDetails);
            }
            declarations.sort((first, second) => first.line - second.line || first.startColumn - second.startColumn);
            return createDocumentSymbolTree(
                vscode, document, declarations, outlineConstantValues, details
            );
        }
    };
}

async function cachedStockSidecarOutlineConstantValues(analysis, document, declarations, token, getCachedModel = null) {
    const constants = (declarations || []).filter((declaration) =>
        ["const", "enumMember", "enum-member"].includes(declaration.type) &&
        declaration.provisional !== true && Number.isSafeInteger(declaration.startColumn) &&
        Number.isSafeInteger(declaration.endColumn) && declaration.endColumn > declaration.startColumn);
    if (!constants.length || constants.length > MAX_STOCK_SIDECAR_OUTLINE_CONSTANTS ||
        token?.isCancellationRequested) return new Map();

    const model = getCachedModel ? getCachedModel() : analysis?.getModel?.(document.uri);
    if (!model?.remote || model.semanticSidecarOnly !== true || model.semanticBindingsAvailable !== true) return new Map();
    const filePath = document.uri.fsPath || document.uri.path;
    if (!filePath) return new Map();

    const valuesByDeclaration = new Map();
    for (let offset = 0; offset < constants.length; offset += MAX_STOCK_SIDECAR_COMPLETION_CONSTANTS) {
        const batch = constants.slice(offset, offset + MAX_STOCK_SIDECAR_COMPLETION_CONSTANTS);
        const sites = batch.map((declaration, index) => ({
            index,
            filePath,
            line: declaration.line,
            startColumn: declaration.startColumn,
            endColumn: declaration.endColumn
        }));
        let values;
        try {
            values = await model.query("compilerSidecarConstantsAtSites", document.uri, { sites }, token);
        } catch {
            return new Map();
        }
        if (!Array.isArray(values) || token?.isCancellationRequested) return new Map();
        for (const value of values) {
            if (!Number.isSafeInteger(value?.index) || value.index < 0 || value.index >= batch.length) continue;
            const constantValue = compilerConstantValueText(value);
            if (constantValue) valuesByDeclaration.set(batch[value.index], constantValue);
        }
    }
    return valuesByDeclaration;
}

async function cachedStockSidecarOutlineDetails(analysis, document, declarations, token, getCachedModel = null) {
    const typedCandidates = (declarations || []).filter((declaration) => {
        const isParameter = declaration.type === "parameter";
        const isField = declaration.type === "field";
        const isEnumMember = ["enumMember", "enum-member"].includes(declaration.type);
        const isAggregate = ["type", "class", "union"].includes(declaration.type) &&
            declaration.detail !== "Type alias";
        const isProcedure = ["function", "sub", "property", "operator", "constructor", "destructor"].includes(declaration.type);
        const isScalarString = ["variable", "field"].includes(declaration.type) &&
            normalizeTypeName(declaration.typeName) === "string";
        const needsImplicitType = ["variable", "const", "extern"].includes(declaration.type) &&
            !declaration.typeName && !/[$%!#&]$/.test(declaration.name);
        const isArrayVariable = ["variable", "extern"].includes(declaration.type) &&
            typeof declaration.sourceLine === "string" && /^\s*\(/.test(declaration.sourceLine.slice(declaration.endColumn));
        return (isParameter || isField || isEnumMember || isAggregate || isProcedure || isScalarString ||
            needsImplicitType || isArrayVariable) && declaration.provisional !== true &&
            Number.isSafeInteger(declaration.startColumn) && Number.isSafeInteger(declaration.endColumn) &&
            declaration.endColumn > declaration.startColumn;
    }).slice(0, MAX_STOCK_SIDECAR_OUTLINE_TYPE_SITES);
    if (!typedCandidates.length || token?.isCancellationRequested) return new Map();

    const model = getCachedModel ? getCachedModel() : analysis?.getModel?.(document.uri);
    if (!model?.remote || model.semanticSidecarOnly !== true || model.semanticBindingsAvailable !== true) return new Map();
    const typeDetailsByDeclaration = new Map();
    for (let offset = 0; offset < typedCandidates.length; offset += MAX_STOCK_SIDECAR_COMPLETION_CONSTANTS) {
        const batch = typedCandidates.slice(offset, offset + MAX_STOCK_SIDECAR_COMPLETION_CONSTANTS);
        const sites = batch.map((declaration, index) => ({
            index,
            line: declaration.line,
            startColumn: declaration.startColumn,
            endColumn: declaration.endColumn
        }));
        let factsAtSites;
        try {
            factsAtSites = await model.query("compilerSidecarOutlineFactsAtSites", document.uri, { sites }, token);
        } catch {
            return new Map();
        }
        if (!Array.isArray(factsAtSites) || token?.isCancellationRequested) return new Map();
        for (const factAtSite of factsAtSites) {
            if (!Number.isSafeInteger(factAtSite?.index) || factAtSite.index < 0 ||
                factAtSite.index >= batch.length) continue;
            const facts = factAtSite.compilerFacts;
            const declaration = batch[factAtSite.index];
            const writtenTypes = new Set([
                ...(facts?.declarationInputs || []).map((input) => input.writtenType),
                ...(facts?.formalWrittenTypes || [])
            ]);
            const writtenType = writtenTypes.size === 1 ? writtenTypes.values().next().value : "";
            const implicitRedimDeclaration = ["variable", "extern"].includes(declaration.type) &&
                !declaration.typeName && !declaration.initializer && !/[$%!#&]$/.test(declaration.name) &&
                /^\s*(?:(?:public|private|protected|shared|static|common|extern)\s+)*redim(?:\s+(?:preserve|shared))*\b/i.test(
                    maskFreeBasicText(declaration.sourceLine || "")
                );
            const implicitTypeName = ["implicit", "inferred"].includes(writtenType) || implicitRedimDeclaration
                ? compilerPrimitiveTypeName(facts?.storageType) : "";
            const outlineWrittenType = implicitRedimDeclaration && implicitTypeName ? "implicit" : writtenType;
            const parameterPassing = facts?.parameterPassing;
            if (!implicitTypeName && !parameterPassing && !facts?.arrayBounds &&
                !facts?.fieldLayout && !facts?.compilerVisibility &&
                !Number.isSafeInteger(facts?.aggregateSizeBytes) &&
                !Number.isSafeInteger(facts?.abstractMemberCount) && !facts?.aggregateAccess &&
                typeof facts?.baseType !== "string" &&
                !facts?.scalarStringDeclaration &&
                !facts?.enumElementInput &&
                typeof facts?.procedureCallingConvention !== "string" &&
                !Array.isArray(facts?.procedureWrittenVisibility) &&
                !facts?.properties?.some((property) =>
                    ["natural-alignment", "packing-alignment"].includes(property.name))) continue;
            const typeDetails = {
                ...(implicitTypeName ? { typeName: implicitTypeName, writtenType: outlineWrittenType } : {}),
                ...(parameterPassing ? { parameterPassing } : {}),
                ...(facts?.arrayBounds ? { arrayBounds: facts.arrayBounds } : {}),
                ...(facts?.fieldLayout ? { fieldLayout: facts.fieldLayout } : {}),
                ...(typeof facts?.compilerVisibility === "string" ? { compilerVisibility: facts.compilerVisibility } : {}),
                ...(Number.isSafeInteger(facts?.aggregateSizeBytes) ? { aggregateSizeBytes: facts.aggregateSizeBytes } : {}),
                ...(Number.isSafeInteger(facts?.abstractMemberCount) ? { abstractMemberCount: facts.abstractMemberCount } : {}),
                ...(facts?.aggregateAccess ? { aggregateAccess: facts.aggregateAccess } : {}),
                ...(typeof facts?.baseType === "string" ? { baseType: facts.baseType } : {}),
                ...(facts?.scalarStringDeclaration ? { scalarStringDeclaration: facts.scalarStringDeclaration } : {}),
                ...(facts?.enumElementInput ? { enumElementInput: facts.enumElementInput } : {}),
                ...(typeof facts?.procedureCallingConvention === "string"
                    ? { procedureCallingConvention: facts.procedureCallingConvention } : {}),
                ...(typeof facts?.procedureReturnsByReference === "boolean"
                    ? { procedureReturnsByReference: facts.procedureReturnsByReference } : {}),
                ...(Array.isArray(facts?.procedureAbiPolicyInputs)
                    ? { procedureAbiPolicyInputs: facts.procedureAbiPolicyInputs } : {}),
                ...(Array.isArray(facts?.procedureWrittenVisibility)
                    ? { procedureWrittenVisibility: facts.procedureWrittenVisibility } : {}),
                ...(Array.isArray(facts?.procedureTypingInputs)
                    ? { procedureTypingInputs: facts.procedureTypingInputs } : {}),
                ...(facts?.overriddenProcedure ? { overriddenProcedure: facts.overriddenProcedure } : {}),
                ...(facts?.storageType ? { storageType: facts.storageType } : {}),
                ...(typeof facts?.compilerStorageClass === "string" ? { compilerStorageClass: facts.compilerStorageClass } : {}),
                ...(Array.isArray(facts?.properties) ? { properties: facts.properties } : {})
            };
            if (Object.keys(typeDetails).length) typeDetailsByDeclaration.set(batch[factAtSite.index], typeDetails);
        }
    }
    return typeDetailsByDeclaration;
}

function hasPotentialMaskedRemDeclaration(document, declarations) {
    const text = document.getText();
    if (Buffer.byteLength(text, "utf8") > MAX_STOCK_SIDECAR_OUTLINE_IMPLICIT_VARIABLE_BYTES ||
        !/(?:^|\r?\n)\s*option\s+nokeyword\b[^\r\n]*\brem\b/i.test(text)) return false;
    const existingSites = new Set((declarations || []).map((declaration) =>
        `${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`
    ));
    for (let line = 0; line < document.lineCount; line++) {
        const lineText = document.lineAt(line).text;
        for (const match of lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)) {
            if (match[0].toUpperCase() !== "REM") continue;
            const siteKey = `${line}:${match.index}:${match.index + match[0].length}`;
            if (existingSites.has(siteKey)) continue;
            if (optionRemIdentifierAtPosition(document, { line, character: match.index })) return true;
        }
    }
    return false;
}

async function cachedStockSidecarMaskedVariableOutlineDeclarations(analysis, document, declarations, token,
    getCachedModel = null) {
    if (token?.isCancellationRequested || !hasPotentialMaskedRemDeclaration(document, declarations)) return [];
    const model = getCachedModel ? getCachedModel() : analysis?.getModel?.(document.uri);
    if (!model?.remote || model.semanticSidecarOnly !== true || model.semanticBindingsAvailable !== true) return [];
    let requests = stockSidecarMaskedVariableOutlineRecordsByModel.get(model);
    if (!requests) {
        requests = new Map();
        stockSidecarMaskedVariableOutlineRecordsByModel.set(model, requests);
    }
    const cacheKey = document.uri.toString();
    let request = requests.get(cacheKey);
    if (request) {
        requests.delete(cacheKey);
        requests.set(cacheKey, request);
    } else {
        request = Promise.resolve().then(() =>
            model.query("compilerSidecarOutlineMaskedVariables", document.uri, {}, token)
        ).then((records) => {
            if (!Array.isArray(records) || records.length > MAX_STOCK_SIDECAR_OUTLINE_TYPE_SITES) {
                throw new Error("Compiler masked-variable Outline results exceeded their bound.");
            }
            return records;
        });
        requests.set(cacheKey, request);
        while (requests.size > MAX_STOCK_SIDECAR_MASKED_OUTLINE_DOCUMENTS) {
            requests.delete(requests.keys().next().value);
        }
        request.catch(() => {
            if (requests.get(cacheKey) === request) requests.delete(cacheKey);
        });
    }
    let records;
    try { records = await request; }
    catch { return []; }
    if (!Array.isArray(records) || token?.isCancellationRequested) return [];

    const filePath = document.uri.fsPath || document.uri.path;
    const normalizeFilePath = (value) => {
        const resolved = path.resolve(value);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const fileKey = typeof filePath === "string" && path.isAbsolute(filePath)
        ? normalizeFilePath(filePath) : "";
    if (!fileKey) return [];
    const existingSites = new Set((declarations || []).map((declaration) =>
        `${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`
    ));
    const procedures = (declarations || []).filter((declaration) =>
        ["function", "sub", "property", "operator", "constructor", "destructor"].includes(declaration.type) &&
        !declaration.modifiers?.includes("DECLARE") && Number.isSafeInteger(declaration.line) &&
        Number.isSafeInteger(declaration.endLine) && declaration.endLine >= declaration.line
    );
    const result = [];
    for (const record of records) {
        if (token?.isCancellationRequested) return [];
        const sourceDeclaration = record?.declaration;
        const name = record?.name || sourceDeclaration?.name;
        const recordPath = record?.uri?.fsPath || record?.uri?.path;
        const normalizedRecordPath = typeof recordPath === "string" && path.isAbsolute(recordPath)
            ? normalizeFilePath(recordPath) : "";
        const line = sourceDeclaration?.line;
        const startColumn = sourceDeclaration?.startColumn;
        const endColumn = sourceDeclaration?.endColumn;
        if (sourceDeclaration?.type !== "variable" || normalizedRecordPath !== fileKey ||
            typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(name) ||
            !Number.isSafeInteger(line) || line < 0 || line >= document.lineCount ||
            !Number.isSafeInteger(startColumn) || startColumn < 0 ||
            !Number.isSafeInteger(endColumn) || endColumn - startColumn !== name.length) continue;
        const siteKey = `${line}:${startColumn}:${endColumn}`;
        if (existingSites.has(siteKey)) continue;
        const sourceLine = document.lineAt(line).text;
        if (sourceLine.slice(startColumn, endColumn) !== name) continue;
        const parentDeclaration = procedures.filter((declaration) =>
            declaration.line <= line && declaration.endLine >= line
        ).sort((first, second) =>
            (first.endLine - first.line) - (second.endLine - second.line) || second.line - first.line
        )[0] || null;
        const compilerFacts = record.compilerFacts || sourceDeclaration.compilerFacts || {};
        const storageClass = compilerFacts.compilerStorageClass;
        if (storageClass === "local" && !parentDeclaration) continue;
        const typeName = compilerPrimitiveTypeName(compilerFacts.storageType) || sourceDeclaration.typeName || "";
        const declaration = {
            ...sourceDeclaration,
            name,
            type: "variable",
            detail: "Variable",
            ...(typeName ? { typeName } : {}),
            line,
            endLine: line,
            signatureEndLine: line,
            startColumn,
            endColumn,
            containerName: parentDeclaration?.qualifiedName || "",
            qualifiedName: parentDeclaration?.qualifiedName ? `${parentDeclaration.qualifiedName}.${name}` : name,
            parentDeclaration,
            sourceLine,
            parameters: [],
            modifiers: Array.isArray(sourceDeclaration.modifiers) ? sourceDeclaration.modifiers : [],
            localOnly: Boolean(parentDeclaration),
            provisional: false
        };
        const typeDetails = {
            ...(typeName ? { typeName } : {}),
            ...(compilerFacts.storageType ? { storageType: compilerFacts.storageType } : {}),
            ...(typeof storageClass === "string" ? { compilerStorageClass: storageClass } : {})
        };
        existingSites.add(siteKey);
        result.push({ declaration, typeDetails });
    }
    return result;
}

async function cachedStockSidecarOutlineImplicitVariables(analysis, document, declarations, token, getCachedModel = null) {
    if (token?.isCancellationRequested) return [];
    const model = getCachedModel ? getCachedModel() : analysis?.getModel?.(document.uri);
    if (!model?.remote || model.semanticSidecarOnly !== true || model.semanticBindingsAvailable !== true) return [];
    let implicitVariableRequest = stockSidecarImplicitVariableRecordsByModel.get(model);
    if (!implicitVariableRequest) {
    const text = document.getText();
        if (Buffer.byteLength(text, "utf8") > MAX_STOCK_SIDECAR_OUTLINE_IMPLICIT_VARIABLE_BYTES) {
            stockSidecarImplicitVariableRecordsByModel.set(model, Promise.resolve([]));
            return [];
        }
    const enumMemberLines = new Set((declarations || [])
        .filter((declaration) => ["enumMember", "enum-member"].includes(declaration.type))
        .map((declaration) => declaration.line));
    const hasPotentialTarget = maskFreeBasicText(text).split(/\r\n|\n|\r/).some((line, index) =>
        !enumMemberLines.has(index) &&
        (/^\s*(?:let\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=(?!=|>)/i.test(line) ||
            IMPLICIT_COMPOUND_ASSIGNMENT_TARGET.test(line) ||
            IMPLICIT_LSET_RSET_TARGET.test(line) ||
            /^\s*for\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:=|\bin\b)/i.test(line) ||
            /^\s*swap\b/i.test(line) ||
            /^\s*get\b/i.test(line) ||
            /^\s*(?:(?:line\s+)?input|read)\b/i.test(line))
    ) || compilerUsesImplicitVariableDialect(document, analysis) &&
        hasPotentialLegacyImplicitVariableHint(document, {
            start: { line: 0, character: 0 },
            end: { line: Math.max(0, document.lineCount - 1), character: 0 }
        }, analysis.index, true);
        if (!hasPotentialTarget || token?.isCancellationRequested) {
            if (!token?.isCancellationRequested) stockSidecarImplicitVariableRecordsByModel.set(model, Promise.resolve([]));
            return [];
        }
        implicitVariableRequest = cachedStockSidecarImplicitVariableRecords(model, document, token);
    }
    let implicitVariables;
    try { implicitVariables = await implicitVariableRequest; }
    catch { return []; }
    if (!Array.isArray(implicitVariables) ||
        implicitVariables.length > MAX_STOCK_SIDECAR_OUTLINE_TYPE_SITES || token?.isCancellationRequested) return [];

    const existingSites = new Set((declarations || []).map((declaration) =>
        `${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`
    ));
    const procedureDeclarations = (declarations || []).filter((declaration) =>
        ["function", "sub", "property", "operator", "constructor", "destructor"].includes(declaration.type) &&
        !declaration.modifiers?.includes("DECLARE") && Number.isSafeInteger(declaration.line) &&
        Number.isSafeInteger(declaration.endLine) && declaration.endLine >= declaration.line
    );
    const result = [];
    const seenSites = new Set();
    for (const implicitVariable of implicitVariables) {
        if (token?.isCancellationRequested) return [];
        const { name, line, startColumn, endColumn, storageClass } = implicitVariable || {};
        if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            !Number.isSafeInteger(line) || line < 0 || line >= document.lineCount ||
            !Number.isSafeInteger(startColumn) || startColumn < 0 ||
            !Number.isSafeInteger(endColumn) || endColumn <= startColumn || endColumn - startColumn !== name.length ||
            !["external", "static", "local", "shared", "global"].includes(storageClass)) continue;
        const siteKey = `${line}:${startColumn}:${endColumn}`;
        if (seenSites.has(siteKey) || existingSites.has(siteKey)) continue;
        const sourceLine = document.lineAt(line).text;
        if (sourceLine.slice(startColumn, endColumn) !== name) continue;

        const parentDeclaration = procedureDeclarations.filter((declaration) =>
            declaration.line <= line && declaration.endLine >= line
        ).sort((first, second) =>
            (first.endLine - first.line) - (second.endLine - second.line) || second.line - first.line
        )[0] || null;
        const insideMacro = (declarations || []).some((declaration) =>
            declaration.type === "macro" && Number.isSafeInteger(declaration.endLine) &&
            declaration.line <= line && declaration.endLine >= line
        );
        if (storageClass === "local" && !parentDeclaration && insideMacro) continue;

        const typeName = compilerPrimitiveTypeName(implicitVariable.storageType);
        const declaration = {
            name,
            type: "variable",
            detail: "Variable",
            ...(typeName ? { typeName } : {}),
            line,
            endLine: line,
            signatureEndLine: line,
            startColumn,
            endColumn,
            containerName: parentDeclaration?.qualifiedName || "",
            qualifiedName: parentDeclaration?.qualifiedName ? `${parentDeclaration.qualifiedName}.${name}` : name,
            parentDeclaration,
            sourceLine,
            signature: `variable ${name}${typeName ? ` As ${typeName.toLowerCase()}` : ""}`,
            parameters: [],
            modifiers: [],
            localOnly: Boolean(parentDeclaration)
        };
        const typeDetails = {
            ...(typeName ? { typeName, writtenType: "implicit" } : {}),
            ...(implicitVariable.storageType ? { storageType: implicitVariable.storageType } : {}),
            compilerStorageClass: storageClass
        };
        seenSites.add(siteKey);
        result.push({ declaration, typeDetails });
    }
    return result;
}

async function cachedStockSidecarImplicitVariableRecords(model, document, token) {
    let request = stockSidecarImplicitVariableRecordsByModel.get(model);
    if (!request) {
        request = Promise.resolve().then(() =>
            model.query("compilerSidecarOutlineImplicitVariables", document.uri, {}, token)
        ).then((records) => {
            if (!Array.isArray(records) || records.length > MAX_STOCK_SIDECAR_OUTLINE_TYPE_SITES) {
                throw new Error("Compiler implicit-variable Outline results exceeded their bound.");
            }
            return records;
        });
        stockSidecarImplicitVariableRecordsByModel.set(model, request);
        request.catch(() => {
            if (stockSidecarImplicitVariableRecordsByModel.get(model) === request) {
                stockSidecarImplicitVariableRecordsByModel.delete(model);
            }
        });
    }
    try {
        const records = await request;
        if (token?.isCancellationRequested) {
            if (stockSidecarImplicitVariableRecordsByModel.get(model) === request) {
                stockSidecarImplicitVariableRecordsByModel.delete(model);
            }
            return [];
        }
        return records;
    } catch {
        return [];
    }
}

function stockSidecarImplicitVariableCompletionEntries(document, declarations, implicitVariables, position, prefix) {
    if (!Array.isArray(implicitVariables) || !implicitVariables.length || !position ||
        !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)) return [];
    const procedureTypes = new Set(["function", "sub", "property", "operator", "constructor", "destructor"]);
    const currentProcedure = (declarations || []).filter((declaration) =>
        procedureTypes.has(declaration.type) && !declaration.modifiers?.includes("DECLARE") &&
        Number.isSafeInteger(declaration.endLine) && declaration.line <= position.line && declaration.endLine >= position.line
    ).sort((first, second) =>
        (first.endLine - first.line) - (second.endLine - second.line) || second.line - first.line
    )[0] || null;
    const insideMacro = (declarations || []).some((declaration) =>
        declaration.type === "macro" && Number.isSafeInteger(declaration.endLine) &&
        declaration.line <= position.line && declaration.endLine >= position.line
    );
    const moduleScope = !currentProcedure && !insideMacro;
    if (!currentProcedure && !moduleScope) return [];

    const cursorOffset = document.offsetAt(position);
    const normalizedPrefix = normalizeIdentifier(prefix);
    const entries = [];
    for (const implicitVariable of implicitVariables) {
        const declaration = implicitVariable.declaration;
        const visibleInCurrentScope = currentProcedure
            ? declaration?.parentDeclaration === currentProcedure
            : moduleScope && declaration?.parentDeclaration == null;
        if (!declaration || !visibleInCurrentScope ||
            implicitVariable.typeDetails?.compilerStorageClass !== "local" ||
            normalizedPrefix && !normalizeIdentifier(declaration.name).startsWith(normalizedPrefix)) continue;
        const declarationEnd = sourceOffsetAt(document, declaration.line, declaration.endColumn);
        if (declarationEnd >= cursorOffset) continue;
        const compilerFacts = {
            ...(implicitVariable.typeDetails?.storageType
                ? { storageType: implicitVariable.typeDetails.storageType } : {}),
            compilerStorageClass: "local"
        };
        entries.push({
            id: `stock-sidecar-implicit:${document.uri}:${declaration.line}:${declaration.startColumn}`,
            name: declaration.name,
            key: normalizeIdentifier(declaration.name),
            uri: document.uri,
            compilerFacts,
            declaration: { ...declaration, compilerFacts }
        });
    }
    return entries;
}

function createWorkspaceSymbolProvider(vscode, workspaceIndex) {
    return {
        async provideWorkspaceSymbols(query, token) {
            const compilerAnalysis = workspaceIndex.compilerAnalysis;
            const folders = vscode.workspace.workspaceFolders || [];
            const sidecarOnlyWorkspace = folders.length > 0 && folders.every((folder) =>
                compilerAnalysis?.analysisCompilerFor?.(folder.uri)?.semanticModelOnly === true
            );
            const native = sidecarOnlyWorkspace
                ? { roots: new Set(), symbols: [] }
                : await compilerAnalysis?.workspaceSymbols(query, token);
            if (token?.isCancellationRequested) return [];
            const symbols = (native?.symbols || []).map((entry) => {
                const symbol = new vscode.SymbolInformation(
                    entry.name,
                    declarationTypeToSymbolKind(vscode, entry.type, entry.callableKind),
                    entry.containerName,
                    new vscode.Location(entry.uri, new vscode.Range(
                        entry.selection.start.line, entry.selection.start.character,
                        entry.selection.end.line, entry.selection.end.character
                    ))
                );
                if (entry.deprecated === true && vscode.SymbolTag?.Deprecated !== undefined) {
                    symbol.tags = [...new Set([...(symbol.tags || []), vscode.SymbolTag.Deprecated])];
                }
                return symbol;
            });
            const symbolLocations = new Set(symbols.map((symbol) => {
                const range = symbol.location?.range;
                return range ? `${symbol.location.uri.toString()}:${range.start.line}:${range.start.character}:` +
                    `${range.end.line}:${range.end.character}:${normalizeIdentifier(symbol.name)}` : "";
            }).filter(Boolean));
            const nativeRoots = new Set();
            for (const root of native?.roots || []) {
                const selection = compilerAnalysis?.analysisCompilerFor?.(vscode.Uri.file(root));
                if (selection?.semanticModelOnly !== true) nativeRoots.add(root);
            }
            if (folders.length && folders.every((folder) => nativeRoots.has(folder.uri.fsPath))) return symbols;
            await workspaceIndex.ensureInitialized(token);
            const queryText = normalizeIdentifier(query);
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const maxResults = Math.max(1, configuration.get("index.maxSymbolResults", 1000));

            for (const entry of workspaceIndex.getAllDeclarations()) {
                if ((token && token.isCancellationRequested) || symbols.length >= maxResults) {
                    break;
                }
                if (nativeRoots.has(vscode.workspace.getWorkspaceFolder(entry.uri)?.uri.fsPath)) continue;
                if (!isWorkspaceVisibleDeclaration(entry.declaration)) {
                    continue;
                }
                if (queryText && !normalizeIdentifier(entry.declaration.qualifiedName).includes(queryText)) {
                    continue;
                }

                const location = new vscode.Location(entry.uri, declarationSelectionRange(vscode, entry.declaration));
                const symbol = new vscode.SymbolInformation(
                    entry.declaration.name,
                    declarationTypeToSymbolKind(vscode, entry.declaration.type, sourceDeclarationCallableKind(entry.declaration)),
                    entry.declaration.containerName,
                    location
                );
                const range = location.range;
                const key = `${location.uri.toString()}:${range.start.line}:${range.start.character}:` +
                    `${range.end.line}:${range.end.character}:${normalizeIdentifier(symbol.name)}`;
                if (symbolLocations.has(key)) continue;
                symbolLocations.add(key);
                symbols.push(symbol);
            }

            return symbols;
        }
    };
}

/* ------------------------------------------------------------------------- */
/* Signatures, folding, and include links                                     */
/* ------------------------------------------------------------------------- */

function createSignatureHelpProvider(vscode, workspaceIndex) {
    return {
        async provideSignatureHelp(document, position, token) {
            const text = document.getText();
            const offset = document.offsetAt(position);
            const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
            const sourceContext = await compilerAwareCodeContext(
                workspaceIndex, document, offset, linePrefix, token
            );
            if (sourceContext.context !== "code") return null;
            const possibleCall = sourceContext.signatureCallContext !== undefined ? sourceContext.signatureCallContext
                : findSignatureCallContext(text, offset, sourceContext.defaultEscapedStringRanges);
            if (!possibleCall) return null;
            if (possibleCall.bare && FREEBASIC_KEYWORDS.has(normalizeIdentifier(possibleCall.name)) &&
                getReferenceSignatures(possibleCall.name).length === 0) {
                workspaceIndex.getParsedDocument?.(document);
                const declarations = await workspaceIndex.findDeclarations?.(possibleCall.name, token);
                if (!declarations?.some((entry) => isCallableDeclaration(entry.declaration))) return null;
            }
            const needConstructorBindings = !possibleCall.bare && (isNewConstructorCall(text, possibleCall) ||
                isExplicitTypeConstructorCall(workspaceIndex, document, possibleCall));
            const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
            const needSemanticMacroBindings = compilerSelection?.semanticModelOnly === true &&
                !possibleCall.bare && Boolean(sourceMacroCallAt(workspaceIndex, document, possibleCall));
            const model = await editorModel(workspaceIndex, document, token, false,
                Boolean(needConstructorBindings || needSemanticMacroBindings), needSemanticMacroBindings);
            if (!model || token?.isCancellationRequested) return null;
            let callContext, resolved, selectedDeclaration = null;
            if (model.remote) {
                const result = await model.query("signature", document.uri, { position }, token);
                if (!result) return null;
                callContext = result.context;
                resolved = result.macroSignature
                    ? [{ declaration: {
                        ...result.macroSignature,
                        type: "macro",
                        detail: "Compiler-selected macro",
                        modifiers: []
                    } }]
                    : result.entries;
                if (result.selectedCompilerSymbolId) {
                    selectedDeclaration = resolved.find((entry) =>
                        entry.compilerSymbolId === result.selectedCompilerSymbolId
                    )?.declaration || null;
                }
                if (result.selectedConstructorProcedure) {
                    const declaration = await sourceConstructorDeclarationForProcedure(
                        workspaceIndex, document, result.selectedConstructorProcedure, token
                    );
                    if (declaration) {
                        resolved = [{ declaration }];
                        selectedDeclaration = declaration;
                    }
                }
                if (model.semanticSidecarOnly && !resolved.length && callContext) {
                    const sourceModel = await editorModel(workspaceIndex, document, token);
                    if (sourceModel && !sourceModel.remote) resolved = userConstructorEntries(sourceModel, document, callContext);
                }
            } else {
                if (sourceContext.context !== "code") return null;
                callContext = possibleCall;
                if (!callContext) return null;
                if (callContext.indexing) {
                    resolved = indexOperatorEntries(model, document, callContext);
                    const selected = await sidecarSelectedOverload(
                        workspaceIndex, document, position, model, resolved, token
                    );
                    if (selected?.length === 1) selectedDeclaration = selected[0].declaration;
                } else {
                    const beforeCall = document.getText().slice(0, callContext.openParenthesisOffset).trimEnd();
                    const callPosition = document.positionAt(beforeCall.length - 1);
                    resolved = model.resolveAt(document.uri, callPosition.line, callPosition.character);
                    if (!callContext.bare && !resolved.some((entry) => isCallableDeclaration(entry.declaration))) {
                        const constructors = userConstructorEntries(model, document, callContext);
                        if (constructors.length) resolved = constructors;
                    }
                    let selectedSidecarModel = null;
                    const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
                    const callableCandidates = resolved.filter((entry) =>
                        ["function", "sub", "property", "operator", "constructor"].includes(entry.declaration.type));
                    if (compilerSelection?.semanticModelOnly && callableCandidates.length > 1) {
                        selectedSidecarModel = await editorModel(workspaceIndex, document, token, false, true);
                        if (selectedSidecarModel?.remote && selectedSidecarModel.semanticSidecarOnly) {
                            const sidecarResult = await selectedSidecarModel.query("signature", document.uri, { position }, token);
                            if (token?.isCancellationRequested) return null;
                            const sites = sidecarResult?.selectedSidecarDeclarations || [];
                            const sourcePathKey = (filePath) => {
                                const normalized = path.resolve(filePath);
                                return process.platform === "win32" ? normalized.toLowerCase() : normalized;
                            };
                            const selected = resolved.find((entry) => sites.some((site) =>
                                sourcePathKey(site.filePath) === sourcePathKey(entry.uri?.fsPath || entry.uri?.path || "") &&
                                site.line === entry.declaration.line &&
                                site.startColumn === entry.declaration.startColumn &&
                                site.endColumn === entry.declaration.endColumn
                            ));
                            if (selected) selectedDeclaration = selected.declaration;
                        }
                    }
                    if (!selectedDeclaration) {
                        const selected = await sidecarSelectedOverload(
                            workspaceIndex, document, callPosition, model, resolved, token, selectedSidecarModel
                        );
                        if (selected?.length === 1) selectedDeclaration = selected[0].declaration;
                    }
                }
            }
            const callableEntries = resolved.filter((entry) => isCallableDeclaration(entry.declaration));
            const declarations = callableEntries.map((entry) => entry.declaration);
            const selectedSignature = selectedDeclaration ? declarations.indexOf(selectedDeclaration) : -1;

            const signatureHelp = new vscode.SignatureHelp();
            signatureHelp.activeSignature = 0;
            signatureHelp.signatures = callableEntries.map((entry) => {
                const declaration = entry.declaration;
                const documentation = [
                    declaration.documentation,
                    compilerDeprecatedMarkdown(entry),
                    compilerImplicitProcedureReturnTypeMarkdown(entry),
                    compilerProcedureAbiMarkdown(entry.compilerFacts || declaration.compilerFacts),
                    compilerHeaderLibraryMarkdown(declaration.compilerHeaderLibraries)
                ].filter(Boolean).join("\n\n");
                const signature = new vscode.SignatureInformation(declaration.signature, documentation || undefined);
                signature.parameters = declaration.parameters.map((parameter) => {
                    const passing = parameter.compilerParameterPassing;
                    const parameterDocumentation = [
                        typeof parameter.documentation === "string" ? parameter.documentation : "",
                        compilerFormalDefaultValueMarkdown(parameter.compilerDefaultValue),
                        passing && (passing.mode === "bydesc" || passing.mode === "vararg" || passing.optional === true ||
                            passing.modeWritten === false && (passing.mode === "byval" || passing.mode === "byref"))
                            ? compilerParameterPassingMarkdown({ parameterPassing: passing })
                            : ""
                    ].filter(Boolean).join("\n\n");
                    return new vscode.ParameterInformation(parameter.label, parameterDocumentation || undefined);
                });
                return signature;
            });
            if (signatureHelp.signatures.length === 0) {
                signatureHelp.signatures = getReferenceSignatures(callContext.name).map((entry) => {
                    const signature = new vscode.SignatureInformation(entry.label, entry.documentation);
                    signature.parameters = entry.parameters.map((parameter) =>
                        new vscode.ParameterInformation(parameter.label, parameter.documentation)
                    );
                    return signature;
                });
            }
            if (signatureHelp.signatures.length === 0) return null;
            const fittingSignature = signatureHelp.signatures.findIndex((signature) =>
                signature.parameters.length > callContext.activeParameter
            );
            signatureHelp.activeSignature = selectedSignature >= 0
                ? selectedSignature
                : Math.max(0, fittingSignature);
            const parameterCount = signatureHelp.signatures[signatureHelp.activeSignature].parameters.length;
            signatureHelp.activeParameter = parameterCount === 0
                ? 0
                : Math.min(callContext.activeParameter, parameterCount - 1);
            return signatureHelp;
        }
    };
}

function indexOperatorEntries(model, document, context) {
    const before = document.getText().slice(0, context.openParenthesisOffset).trimEnd();
    if (!before) return [];
    const receiverPosition = document.positionAt(before.length - 1);
    const receivers = model.resolveAt(document.uri, receiverPosition.line, receiverPosition.character);
    const isIndexOperator = (entry) => {
        if (entry.declaration.type !== "operator") return false;
        const name = String(entry.name || entry.declaration.name).replace(/\s+/g, "").toLowerCase();
        return name === "operator[]" || name === "[" || name === "[]";
    };
    const selectDeclarations = (entries) => [...new Map(entries.flatMap((entry) => model.declarationTargets([entry]))
        .map((entry) => [entry.id, entry])).values()];
    const direct = receivers.filter(isIndexOperator);
    if (direct.length) return selectDeclarations(direct);

    const types = receivers.flatMap((entry) => model.typeEntries(entry));
    if (!types.length) return [];
    const source = model.inner ? model.inner.getDocument(model.expandedUri) : model.getDocument(document.uri);
    let selection = receiverPosition;
    if (model.inner) {
        selection = model.projectPosition(document.uri, receiverPosition.line, receiverPosition.character);
        if (!selection) return [];
    }
    const offset = (source.lineOffsets[selection.line] ?? source.text.length) + selection.character;
    const scope = scopeAt(source, offset);
    const members = model.inner
        ? model.inner.members(types, source, scope)
        : model.members(types, source, scope);
    return selectDeclarations(members.filter(isIndexOperator));
}

function userConstructorEntries(model, document, context) {
    const before = document.getText().slice(0, context.openParenthesisOffset).trimEnd();
    if (!before) return [];
    const receiverPosition = document.positionAt(before.length - 1);
    const resolved = model.resolveAt(document.uri, receiverPosition.line, receiverPosition.character);
    const types = resolved.filter((entry) => ["type", "class", "union"].includes(entry.declaration.type))
        .flatMap((entry) => model.typeEntries(entry));
    if (!types.length) return [];
    const source = model.inner ? model.inner.getDocument(model.expandedUri) : model.getDocument(document.uri);
    let selection = receiverPosition;
    if (model.inner) {
        selection = model.projectPosition(document.uri, receiverPosition.line, receiverPosition.character);
        if (!selection) return [];
    }
    const offset = (source.lineOffsets[selection.line] ?? source.text.length) + selection.character;
    const scope = scopeAt(source, offset);
    const constructors = model.inner
        ? model.inner.members(types, source, scope)
        : model.members(types, source, scope);
    return [...new Map(constructors.filter((entry) => entry.declaration.type === "constructor")
        .flatMap((entry) => model.declarationTargets([entry]))
        .map((entry) => [entry.id, entry])).values()];
}

function isNewConstructorCall(text, context) {
    const before = text.slice(0, context.openParenthesisOffset).trimEnd();
    const nameStart = before.length - context.name.length;
    return nameStart >= 0 && before.slice(nameStart) === context.name && /\bNEW\s+$/i.test(before.slice(0, nameStart));
}

function isExplicitTypeConstructorCall(workspaceIndex, document, context) {
    if (context.indexing) return false;
    const before = document.getText().slice(0, context.openParenthesisOffset).trimEnd();
    const nameStart = before.length - context.name.length;
    if (nameStart < 0 || before.slice(nameStart) !== context.name) return false;
    const sourceModel = workspaceIndex.getSourceSemanticModel?.() ||
        workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
    if (!sourceModel) return false;
    const finalNameStart = nameStart + context.name.lastIndexOf(".") + 1;
    const position = document.positionAt(finalNameStart);
    return sourceModel.resolveAt(document.uri, position.line, position.character).some((entry) =>
        ["type", "class", "union"].includes(entry.declaration.type) &&
        !entry.conditional && !entry.provisional
    );
}

function hoverCallContext(model, document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const current = findCallContext(text, offset);
    const occurrence = model.tokenAt(document.uri, position.line, position.character);
    if (occurrence?.token && Array.isArray(occurrence.document?.tokens)) {
        const tokens = occurrence.document.tokens;
        const tokenIndex = tokens.findIndex((token) => token.offset === occurrence.token.offset);
        const opening = tokens[tokenIndex + 1];
        if (tokenIndex >= 0 && opening?.name === "(") {
            const direct = findCallContext(text, opening.offset + 1);
            if (direct?.openParenthesisOffset === opening.offset) return direct;
        }
    }
    return current;
}

function sourceConstructorCompletionParameters(model, document, position, visible, linePrefix) {
    const prefix = constructorCompletionTypePrefix(linePrefix);
    if (!prefix) return new Map();
    const matches = visible.filter((entry) => {
        const declaration = entry.declaration;
        const name = entry.name || declaration.name;
        return ["type", "class", "union"].includes(declaration.type) &&
            !entry.conditional && !entry.provisional && !declaration.provisional &&
            typeof name === "string" && normalizeIdentifier(name).startsWith(normalizeIdentifier(prefix));
    });
    if (matches.length !== 1) return new Map();

    const type = matches[0];
    const types = model.typeEntries(type);
    const source = model.inner ? model.inner.getDocument(model.expandedUri) : model.getDocument(document.uri);
    if (!types.length || !source) return new Map();
    let selection = position;
    if (model.inner) {
        selection = model.projectPosition(document.uri, position.line, position.character);
        if (!selection) return new Map();
    }
    const offset = (source.lineOffsets[selection.line] ?? source.text.length) + selection.character;
    const scope = scopeAt(source, offset);
    const candidates = model.inner
        ? model.inner.members(types, source, scope)
        : model.members(types, source, scope);
    const constructors = [...new Map(candidates.filter((entry) => entry.declaration.type === "constructor")
        .flatMap((entry) => model.declarationTargets([entry]))
        .map((entry) => [entry.id, entry])).values()];
    if (constructors.length !== 1 || constructors[0].conditional || constructors[0].provisional ||
        constructors[0].declaration.provisional || !constructors[0].declaration.parameters?.length) return new Map();
    return new Map([[normalizeIdentifier(type.name || type.declaration.name), constructors[0].declaration.parameters]]);
}

async function sourceConstructorDeclarationForProcedure(workspaceIndex, document, procedure, token) {
    if (!procedure?.filePath || !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1 ||
        !await workspaceIndex.ensureInitialized(token) || token?.isCancellationRequested) return null;
    const model = workspaceIndex.getSemanticModel(document.uri, { allowSidecarOnly: false });
    if (!model) return null;
    const targetPath = process.platform === "win32"
        ? path.resolve(procedure.filePath).toLowerCase()
        : path.resolve(procedure.filePath);
    const matches = model.entries.filter((entry) => {
        const entryPath = entry.uri.fsPath || entry.uri.path;
        const normalizedPath = process.platform === "win32" ? path.resolve(entryPath).toLowerCase() : path.resolve(entryPath);
        return normalizedPath === targetPath && entry.declaration.type === "constructor" &&
            entry.declaration.line === procedure.startLine - 1 && !entry.declaration.modifiers.includes("DECLARE") &&
            !entry.conditional && !entry.provisional && !entry.declaration.provisional;
    });
    return matches.length === 1 ? matches[0].declaration : null;
}

function createInlayHintsProvider(vscode, workspaceIndex) {
    return {
        onDidChangeInlayHints: workspaceIndex.onDidChangeModel,
        async provideInlayHints(document, range, token) {
            let model = workspaceIndex.compilerAnalysis?.getModel(document.uri);
            let compilerTypeHintPotential = false;
            let nativeImplicitHint = false;
            let parameterHintPotential = false;
            let stockSidecarParameterHintPotential = false;
            let stockSidecarMacroParameterHintPotential = false;
            let stockSidecarImplicitVariableHintPotential = false;
            let stockSidecarImplicitInputReadHintPotential = false;
            let stockSidecarLegacyImplicitVariableHintPotential = false;
            let stockSidecarImplicitDeclarationTypeHintPotential = false;
            let stockSidecarImplicitSignatureTypeHintPotential = false;
            let stockSidecarForEntryHintPotential = false;
            let stockSidecarUnreachableHintPotential = false;
            let forEntryHintPotential = false;
            let unreachableHintPotential = false;
            let ifConditionHintPotential = false;
            if (!model) {
                const parsed = workspaceIndex.getParsedDocument(document);
                const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
                compilerTypeHintPotential = hasPotentialCompilerTypeInlayHint(parsed, range);
                nativeImplicitHint = compilerSelection?.semanticModelOnly === false &&
                    (hasPotentialImplicitVariableHint(parsed, document, range, workspaceIndex) ||
                        hasPotentialLegacyImplicitVariableHint(document, range, workspaceIndex));
                parameterHintPotential = compilerSelection?.semanticModelOnly === false &&
                    hasPotentialCompilerParameterInlayHint(parsed, range);
                stockSidecarParameterHintPotential = compilerSelection?.semanticModelOnly === true &&
                    hasPotentialCompilerParameterInlayHint(parsed, range);
                stockSidecarMacroParameterHintPotential = compilerSelection?.semanticModelOnly === true &&
                    hasPotentialCompilerMacroParameterInlayHint(workspaceIndex, document, parsed, range);
                stockSidecarImplicitVariableHintPotential = compilerSelection?.semanticModelOnly === true &&
                    document.isDirty !== true &&
                    hasPotentialImplicitVariableHint(parsed, document, range, workspaceIndex, true);
                stockSidecarImplicitInputReadHintPotential = compilerSelection?.semanticModelOnly === true &&
                    document.isDirty !== true &&
                    hasPotentialStockSidecarImplicitInputReadHint(parsed, document, range, workspaceIndex);
                stockSidecarLegacyImplicitVariableHintPotential = compilerSelection?.semanticModelOnly === true &&
                    document.isDirty !== true &&
                    hasPotentialLegacyImplicitVariableHint(document, range, workspaceIndex);
                stockSidecarImplicitDeclarationTypeHintPotential = compilerSelection?.semanticModelOnly === true &&
                    document.isDirty !== true && hasPotentialStockSidecarImplicitDeclarationTypeHint(parsed, range);
                stockSidecarImplicitSignatureTypeHintPotential = compilerSelection?.semanticModelOnly === true &&
                    document.isDirty !== true && hasPotentialStockSidecarImplicitSignatureTypeHint(parsed, range);
                stockSidecarForEntryHintPotential = compilerSelection?.semanticModelOnly === true &&
                    document.isDirty !== true && hasPotentialCompilerForEntryInlayHint(parsed, range);
                stockSidecarUnreachableHintPotential = compilerSelection?.semanticModelOnly === true &&
                    document.isDirty !== true && hasPotentialCompilerUnreachableInlayHint(parsed);
                forEntryHintPotential = compilerSelection?.semanticModelOnly === false &&
                    hasPotentialCompilerForEntryInlayHint(parsed, range);
                unreachableHintPotential = compilerSelection?.semanticModelOnly === false &&
                    hasPotentialCompilerUnreachableInlayHint(parsed);
                ifConditionHintPotential = (compilerSelection?.semanticModelOnly === false ||
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true) &&
                    hasPotentialCompilerIfConditionInlayHint(parsed, range);
                if (!nativeImplicitHint && !compilerTypeHintPotential &&
                    !parameterHintPotential && !stockSidecarParameterHintPotential &&
                    !stockSidecarImplicitVariableHintPotential && !stockSidecarImplicitDeclarationTypeHintPotential &&
                    !stockSidecarImplicitInputReadHintPotential &&
                    !stockSidecarLegacyImplicitVariableHintPotential &&
                    !stockSidecarImplicitSignatureTypeHintPotential &&
                    !stockSidecarForEntryHintPotential && !stockSidecarMacroParameterHintPotential &&
                    !forEntryHintPotential &&
                    !unreachableHintPotential && !stockSidecarUnreachableHintPotential && !ifConditionHintPotential) return [];
                model = await editorModel(workspaceIndex, document, token,
                    compilerTypeHintPotential || parameterHintPotential,
                    nativeImplicitHint || parameterHintPotential && hasPotentialCompilerParameterInlayHint(parsed, range, true) ||
                    stockSidecarParameterHintPotential || stockSidecarImplicitVariableHintPotential ||
                    stockSidecarImplicitInputReadHintPotential ||
                    stockSidecarLegacyImplicitVariableHintPotential ||
                    stockSidecarImplicitDeclarationTypeHintPotential ||
                    stockSidecarImplicitSignatureTypeHintPotential ||
                    stockSidecarForEntryHintPotential ||
                    stockSidecarUnreachableHintPotential || stockSidecarMacroParameterHintPotential || ifConditionHintPotential,
                    stockSidecarMacroParameterHintPotential);
            } else {
                const parsed = workspaceIndex.getParsedDocument(document);
                const compilerSelection = workspaceIndex.compilerAnalysis?.analysisCompilerFor?.(document.uri);
                compilerTypeHintPotential = hasPotentialCompilerTypeInlayHint(parsed, range);
                nativeImplicitHint = compilerSelection?.semanticModelOnly === false &&
                    (hasPotentialImplicitVariableHint(parsed, document, range, workspaceIndex) ||
                        hasPotentialLegacyImplicitVariableHint(document, range, workspaceIndex));
                parameterHintPotential = !model.semanticSidecarOnly && compilerSelection?.semanticModelOnly === false &&
                    hasPotentialCompilerParameterInlayHint(parsed, range);
                stockSidecarParameterHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true && hasPotentialCompilerParameterInlayHint(parsed, range);
                stockSidecarMacroParameterHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true &&
                    hasPotentialCompilerMacroParameterInlayHint(workspaceIndex, document, parsed, range);
                stockSidecarImplicitVariableHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                    hasPotentialImplicitVariableHint(parsed, document, range, workspaceIndex, true);
                stockSidecarImplicitInputReadHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                    hasPotentialStockSidecarImplicitInputReadHint(parsed, document, range, workspaceIndex);
                stockSidecarLegacyImplicitVariableHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                    hasPotentialLegacyImplicitVariableHint(document, range, workspaceIndex);
                stockSidecarImplicitDeclarationTypeHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                    hasPotentialStockSidecarImplicitDeclarationTypeHint(parsed, range);
                stockSidecarImplicitSignatureTypeHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                    hasPotentialStockSidecarImplicitSignatureTypeHint(parsed, range);
                stockSidecarForEntryHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                    hasPotentialCompilerForEntryInlayHint(parsed, range);
                stockSidecarUnreachableHintPotential = model.semanticSidecarOnly &&
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true &&
                    hasPotentialCompilerUnreachableInlayHint(parsed);
                forEntryHintPotential = !model.semanticSidecarOnly && compilerSelection?.semanticModelOnly === false &&
                    hasPotentialCompilerForEntryInlayHint(parsed, range);
                unreachableHintPotential = !model.semanticSidecarOnly && compilerSelection?.semanticModelOnly === false &&
                    hasPotentialCompilerUnreachableInlayHint(parsed) || stockSidecarUnreachableHintPotential;
                ifConditionHintPotential = (compilerSelection?.semanticModelOnly === false ||
                    compilerSelection?.semanticModelOnly === true && document.isDirty !== true) &&
                    hasPotentialCompilerIfConditionInlayHint(parsed, range);
                if (!model.semanticSidecarOnly || compilerTypeHintPotential || parameterHintPotential ||
                    stockSidecarParameterHintPotential || stockSidecarImplicitVariableHintPotential ||
                    stockSidecarImplicitInputReadHintPotential ||
                    stockSidecarLegacyImplicitVariableHintPotential ||
                    stockSidecarImplicitDeclarationTypeHintPotential ||
                    stockSidecarImplicitSignatureTypeHintPotential ||
                    stockSidecarForEntryHintPotential ||
                    stockSidecarUnreachableHintPotential || stockSidecarMacroParameterHintPotential || ifConditionHintPotential) {
                    model = await editorModel(workspaceIndex, document, token,
                        compilerTypeHintPotential || parameterHintPotential,
                        nativeImplicitHint || parameterHintPotential && hasPotentialCompilerParameterInlayHint(parsed, range, true) ||
                        stockSidecarParameterHintPotential || stockSidecarImplicitVariableHintPotential ||
                        stockSidecarImplicitInputReadHintPotential ||
                        stockSidecarLegacyImplicitVariableHintPotential ||
                        stockSidecarImplicitDeclarationTypeHintPotential ||
                        stockSidecarImplicitSignatureTypeHintPotential ||
                        stockSidecarForEntryHintPotential ||
                        stockSidecarUnreachableHintPotential || stockSidecarMacroParameterHintPotential || ifConditionHintPotential,
                        stockSidecarMacroParameterHintPotential);
                }
            }
            if (!model || token?.isCancellationRequested) return [];

            let records, parameterRecords = [], forEntryRecords = [], ifConditionRecords = [], unreachableStatementRecords = [];
            let implicitVariableTypeRecords = [];
            if (parameterHintPotential || stockSidecarParameterHintPotential || forEntryHintPotential ||
                stockSidecarMacroParameterHintPotential ||
                unreachableHintPotential || stockSidecarImplicitVariableHintPotential ||
                stockSidecarImplicitInputReadHintPotential ||
                stockSidecarLegacyImplicitVariableHintPotential ||
                stockSidecarImplicitDeclarationTypeHintPotential ||
                stockSidecarImplicitSignatureTypeHintPotential ||
                stockSidecarForEntryHintPotential ||
                stockSidecarUnreachableHintPotential || ifConditionHintPotential) {
                const parameterHints = parameterHintPotential || stockSidecarParameterHintPotential ||
                    stockSidecarMacroParameterHintPotential;
                const result = model.remote
                    ? await model.query("compilerInlayHints", document.uri, {
                        position: range.start, end: range.end, parameterHints
                    }, token)
                    : {
                        types: model.compilerTypeInlayHints?.(document.uri, range.start, range.end),
                        parameters: parameterHints
                            ? model.compilerParameterInlayHints?.(document.uri, range.start, range.end)
                            : [],
                        forEntries: model.compilerForEntryResultInlayHints?.(document.uri, range.start, range.end),
                        ifConditions: model.compilerIfConditionInlayHints?.(document.uri, range.start, range.end),
                        unreachableStatements: model.compilerUnreachableStatementInlayHints?.(document.uri, range.start, range.end)
                    };
                if (!Array.isArray(result?.types) || !Array.isArray(result?.parameters) || token?.isCancellationRequested) return [];
                records = result.types;
                parameterRecords = result.parameters;
                implicitVariableTypeRecords = [
                    ...(Array.isArray(result.implicitVariables) ? result.implicitVariables : []),
                    ...(Array.isArray(result.implicitDeclarations) ? result.implicitDeclarations : [])
                ];
                forEntryRecords = Array.isArray(result.forEntries) ? result.forEntries : [];
                ifConditionRecords = Array.isArray(result.ifConditions) ? result.ifConditions : [];
                unreachableStatementRecords = Array.isArray(result.unreachableStatements) ? result.unreachableStatements : [];
            } else {
                records = model.remote
                    ? await model.query("compilerTypeInlayHints", document.uri, { position: range.start, end: range.end }, token)
                    : model.compilerTypeInlayHints?.(document.uri, range.start, range.end);
                if (!Array.isArray(records) || token?.isCancellationRequested) return [];
            }

            const typeHints = records.map((record) => {
                const hint = new vscode.InlayHint(
                    new vscode.Position(record.position.line, record.position.character),
                    record.label,
                    vscode.InlayHintKind.Type
                );
                hint.paddingLeft = true;
                hint.tooltip = `FreeBASIC compiler-selected type: ${record.typeName}`;
                return hint;
            });
            const implicitVariableTypeHints = implicitVariableTypeRecords.flatMap((record) => {
                const typeName = compilerPrimitiveTypeName(record.storageType);
                if (!typeName || !Number.isSafeInteger(record.position?.line) ||
                    !Number.isSafeInteger(record.position?.character)) return [];
                const hint = new vscode.InlayHint(
                    new vscode.Position(record.position.line, record.position.character),
                    `: ${typeName}`,
                    vscode.InlayHintKind.Type
                );
                hint.paddingLeft = true;
                hint.tooltip = `FreeBASIC compiler-selected type: ${typeName}`;
                return [hint];
            });
            const parameterHints = parameterRecords.map((record) => {
                let label = record.label;
                const location = record.declarationLocation;
                if (vscode.InlayHintLabelPart && typeof location?.filePath === "string" &&
                    path.isAbsolute(location.filePath) && !location.filePath.includes("\0") &&
                    Number.isSafeInteger(location.line) && location.line >= 0 &&
                    Number.isSafeInteger(location.startColumn) && location.startColumn >= 0 &&
                    Number.isSafeInteger(location.endColumn) && location.endColumn > location.startColumn) {
                    // Use editor-native hover and navigation on the label.
                    // The target arrives with the existing compiler hint query.
                    const part = new vscode.InlayHintLabelPart(record.label);
                    part.location = new vscode.Location(vscode.Uri.file(location.filePath), new vscode.Range(
                        location.line, location.startColumn, location.line, location.endColumn
                    ));
                    label = [part];
                }
                const hint = new vscode.InlayHint(
                    new vscode.Position(record.position.line, record.position.character),
                    label,
                    vscode.InlayHintKind.Parameter
                );
                hint.paddingRight = true;
                const mode = COMPILER_PARAMETER_PASSING_LABELS[record.passingMode];
                hint.tooltip = mode
                    ? `Compiler-selected parameter: ${record.parameterName} (${mode}).`
                    : `Compiler-selected parameter: ${record.parameterName}`;
                return hint;
            });
            const forEntryHints = forEntryRecords.map((record) => {
                const hint = new vscode.InlayHint(
                    new vscode.Position(record.position.line, record.position.character),
                    record.label
                );
                hint.paddingLeft = true;
                hint.tooltip = record.tooltip || "The compiler confirms that the loop body will not be entered.";
                return hint;
            });
            const unreachableHints = unreachableStatementRecords.map((record) => {
                const hint = new vscode.InlayHint(
                    new vscode.Position(record.position.line, record.position.character),
                    record.label
                );
                hint.paddingLeft = true;
                hint.tooltip = record.tooltip || "The compiler control-flow graph finds no reachable path to this statement.";
                return hint;
            });
            const ifConditionHints = ifConditionRecords.map((record) => {
                const hint = new vscode.InlayHint(
                    new vscode.Position(record.position.line, record.position.character), record.label
                );
                hint.paddingLeft = true;
                hint.tooltip = record.tooltip;
                return hint;
            });
            return [...typeHints, ...implicitVariableTypeHints, ...parameterHints, ...forEntryHints, ...unreachableHints, ...ifConditionHints].sort((first, second) =>
                first.position.line - second.position.line || first.position.character - second.position.character
            );
        }
    };
}

function hasPotentialStockSidecarImplicitDeclarationTypeHint(parsed, range) {
    if (!range?.start || !range?.end) return false;
    return (parsed?.declarations || []).some((declaration) =>
        ["variable", "extern"].includes(declaration.type) && !declaration.typeName &&
        !declaration.initializer && !/[$%!#&]$/.test(declaration.name) &&
        declaration.line >= range.start.line && declaration.line <= range.end.line
    );
}

function hasPotentialStockSidecarImplicitSignatureTypeHint(parsed, range) {
    if (!range?.start || !range?.end) return false;
    return (parsed?.declarations || []).some((declaration) =>
        ["function", "parameter"].includes(declaration.type) && !declaration.typeName &&
        !/[$%!#&]$/.test(declaration.name) &&
        declaration.line >= range.start.line && declaration.line <= range.end.line
    );
}

function hasPotentialCompilerTypeInlayHint(parsed, range) {
    const declarations = parsed?.declarations || [];
    /* Includes and macro definitions can introduce physical declarations that
       the source-only parser cannot associate with their expansion sites. */
    if (parsed?.includes?.length || declarations.some((declaration) => declaration.type === "macro")) return true;
    if (!range?.start || !range?.end) return true;
    return declarations.some((declaration) =>
        ["variable", "const", "function", "parameter"].includes(declaration.type) &&
        !declaration.typeName && !/[$%!#&]$/.test(declaration.name) &&
        declaration.line >= range.start.line && declaration.line <= range.end.line
    );
}

function hasPotentialCompilerParameterInlayHint(parsed, range, membersOnly = false) {
    if (!range?.start || !range?.end) return false;
    return (parsed?.statements || []).some((statement) => {
        if (statement.endLine < range.start.line || statement.startLine > range.end.line) return false;
        const code = String(statement.maskedText || "").trim();
        if (!code || /^(?:(?:abstract|declare|export|extern|private|protected|public|shared|static|virtual|override)\s+)*(?:sub|function|property|constructor|destructor|operator)\b/i.test(code)) return false;
        // Member hints need G receiver facts as well as the native argument
        // graph. Plain calls can keep the smaller expressions-only request.
        if (membersOnly && !/(?:\.|->)[ \t]*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:[ \t]+|\s*\()/.test(String(statement.maskedText || ""))) return false;
        if (/\b[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(code)) return true;
        // Keep masked trailing space: a bare call may contain only a string
        // literal. Statement heads exclude assignments and language keywords.
        return String(statement.maskedText || "").split(/:|\bthen\b|\belse\b/i).some((fragment) => {
            const head = fragment.match(/^[ \t]*(?:call[ \t]+)?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:[ \t]*(?:\.|->)[ \t]*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*)[ \t]+([\s\S]*)$/i);
            if (!head || /^\s*=/.test(head[2])) return false;
            const name = normalizeIdentifier(head[1].trim().split(/\.|->/).at(-1).trim());
            return !FREEBASIC_KEYWORDS.has(name);
        });
    });
}

function hasPotentialCompilerForEntryInlayHint(parsed, range) {
    if (!range?.start || !range?.end) return false;
    return (parsed?.statements || []).some((statement) => {
        if (statement.endLine < range.start.line || statement.startLine > range.end.line) return false;
        return /^(?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)*for\b/i.test(String(statement.maskedText || "").trim());
    });
}

function hasPotentialCompilerIfConditionInlayHint(parsed, range) {
    if (!range?.start || !range?.end) return false;
    return (parsed?.statements || []).some((statement) =>
        statement.endLine >= range.start.line && statement.startLine <= range.end.line &&
        /^\s*(?:\d+\s+)?(?:if|elseif|else\s+if)\b/i.test(String(statement.maskedText || ""))
    );
}

function hasPotentialCompilerUnreachableInlayHint(parsed) {
    if (parsed?.includes?.length || parsed?.declarations?.some((declaration) => declaration.type === "macro")) return true;
    return (parsed?.statements || []).some((statement) => {
        const code = String(statement.maskedText || "").trim();
        return /\b(?:goto|gosub|return|continue)\b/i.test(code) ||
            /^exit\s+(?:sub|function|property|operator|constructor|destructor|for|do|while|select|scope|with|namespace|type|union|enum)\b/i.test(code) ||
            /^end\s*$/i.test(code) || /^asm\b/i.test(code);
    });
}

function implicitInputReadTargetNames(code) {
    const normalizedCode = String(code || "").replace(/\s+/g, " ").trim();
    const inputReadMatch = normalizedCode.match(/^(?:line\s+input|input|read)\s+(.+)$/i);
    if (!inputReadMatch) return [];
    let targetList = inputReadMatch[1].trim();
    if (/^(?:line\s+)?input\b/i.test(normalizedCode)) {
        targetList = targetList.replace(/^#\s*(?:[A-Za-z_][A-Za-z0-9_]*[$%!#&]?|\d+)\s*,\s*/i, "");
    }
    const promptSeparator = targetList.indexOf(";");
    if (promptSeparator >= 0) targetList = targetList.slice(promptSeparator + 1);
    targetList = targetList.trimStart();
    while (/^[;,]/.test(targetList)) targetList = targetList.slice(1).trimStart();
    if (!/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*$/.test(targetList)) return [];
    return targetList.split(",").map((name) => name.trim());
}

function implicitGetTargetNames(code) {
    const normalizedCode = String(code || "").replace(/\s+/g, " ").trim();
    const statement = /^get\b/i.exec(normalizedCode);
    if (!statement) return [];
    const separator = normalizedCode.lastIndexOf(",");
    if (separator < statement[0].length) return [];
    const target = /^\s*([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*$/.exec(normalizedCode.slice(separator + 1));
    return target ? [target[1]] : [];
}

function implicitSwapTargetNames(code) {
    const swap = /^swap\s+([A-Za-z_][A-Za-z0-9_]*[$%!#&]?\s*,\s*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*$/i.exec(code);
    return swap ? swap[1].split(",").map((name) => name.trim()) : [];
}

function implicitLsetRsetTargetNames(code) {
    const assignment = IMPLICIT_LSET_RSET_TARGET.exec(code);
    return assignment ? [assignment[2]] : [];
}

function hasPotentialStockSidecarImplicitInputReadHint(parsed, document, range, workspaceIndex) {
    if (!range?.start || !range?.end) return false;
    let sourceModel = null;
    for (const statement of parsed?.statements || []) {
        const statementStartLine = statement.startLine;
        const statementEndLine = statement.endLine ?? statementStartLine;
        if (!Number.isSafeInteger(statementStartLine) || !Number.isSafeInteger(statementEndLine) ||
            statementEndLine < range.start.line || statementStartLine > range.end.line ||
            statementEndLine - statementStartLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const code = String(statement.maskedText || "").trim();
        const candidateNames = [...implicitInputReadTargetNames(code), ...implicitGetTargetNames(code)];
        if (!candidateNames.length) continue;
        sourceModel ||= workspaceIndex.getSourceSemanticModel?.() ||
            workspaceIndex.getSemanticModel(document.uri, { sourceOnly: true });
        const targets = compilerStatementTargetOccurrences(
            document, statement, candidateNames, range.start.line, range.end.line
        );
        for (const target of targets) {
            if (/[$%!#&]$/.test(target.name)) continue;
            if (sourceModel?.resolveAt?.(document.uri, target.line, target.startColumn).length) continue;
            return true;
        }
    }
    return false;
}

function compilerUsesImplicitVariableDialect(document, workspaceIndex) {
    const sourcePrefix = document.getText().slice(0, 4096);
    if (/^\s*#lang\s+["']?(?:qb|fblite|deprecated)["']?(?:\s|$)/im.test(sourcePrefix)) return true;

    let arguments_ = [];
    try {
        const compilerAnalysis = workspaceIndex.compilerAnalysis || workspaceIndex;
        arguments_ = compilerAnalysis?.contextFor?.(document.uri)?.compilerArguments || [];
    } catch {
        return false;
    }
    if (!Array.isArray(arguments_)) return false;
    for (let index = 0; index < arguments_.length; index++) {
        const argument = String(arguments_[index] || "");
        let language = /^(?:--?)lang=(.+)$/i.exec(argument)?.[1] || "";
        if (/^--?lang$/i.test(argument)) language = String(arguments_[index + 1] || "");
        if (["qb", "fblite", "deprecated"].includes(language.toLowerCase())) return true;
    }
    return false;
}

function identifierTokenAtPosition(document, position) {
    const lineText = document.lineAt(position.line).text;
    const token = tokenize(lineText).tokens.find((candidate) =>
        candidate.kind === "identifier" && position.character >= candidate.startColumn &&
        position.character < candidate.endColumn && !FREEBASIC_KEYWORDS.has(candidate.key)
    );
    return token ? {
        name: token.name,
        startColumn: token.startColumn,
        endColumn: token.endColumn
    } : null;
}

/* VS Code validates Position instances in offsetAt(). Source adapters may
   expose only line text, so keep calculated coordinates outside that API. */
function sourceOffsetAt(document, line, character) {
    const sourceLine = document.lineAt(line);
    const column = Math.min(character, sourceLine.text.length);
    if (sourceLine.range?.start) return document.offsetAt(sourceLine.range.start) + column;
    const text = document.getText();
    let start = 0;
    let currentLine = 0;
    for (const match of text.matchAll(/\r\n|\n|\r/g)) {
        if (currentLine === line) break;
        start = match.index + match[0].length;
        currentLine++;
    }
    return Math.min(text.length, start + column);
}

function optionNoKeywordDirectiveRecord(document) {
    const text = document.getText();
    let cache = optionNoKeywordDirectiveCaches.get(document);
    if (!cache || cache.version !== document.version || cache.text !== text) {
        const firstOffsets = new Map();
        const lineOffsets = [0];
        if (/^\s*option\s+nokeyword\b/im.test(text)) {
            const maskedLines = maskFreeBasicText(text).split(/\r\n|\n|\r/);
            const sourceLines = text.split(/\r\n|\n|\r/);
            for (const match of text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
            for (let line = 0; line < maskedLines.length; line++) {
                if (!/^\s*option\s+nokeyword\b/i.test(maskedLines[line])) continue;
                const option = /^\s*option\s+nokeyword\b([^:]*)/i.exec(sourceLines[line]);
                if (!option) continue;
                const endOffset = lineOffsets[line] + option[0].length;
                for (const keyword of option[1].split(",")) {
                    const disabledName = normalizeIdentifier(
                        keyword.trim().match(/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/)?.[0] || ""
                    );
                    if (!disabledName || firstOffsets.has(disabledName)) continue;
                    firstOffsets.set(disabledName, endOffset);
                }
            }
        }
        cache = { version: document.version, text, firstOffsets, lineOffsets };
        optionNoKeywordDirectiveCaches.set(document, cache);
    }
    return cache;
}

function optionNoKeywordIdentifierAtPosition(document, position) {
    const lineText = document.lineAt(position.line).text;
    const token = [...lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)].find((match) =>
        position.character >= match.index && position.character < match.index + match[0].length
    );
    if (!token) return null;
    const name = normalizeIdentifier(token[0]);
    const cache = optionNoKeywordDirectiveRecord(document);
    const optionOffset = cache.firstOffsets.get(name);
    if (!Number.isSafeInteger(optionOffset)) return null;
    /* These positions can come from our source scan. VS Code's offsetAt()
       requires an API Position, so reuse the snapshot's cached line starts. */
    const tokenOffset = (cache.lineOffsets[position.line] ?? cache.text.length) + token.index;
    const optionFound = Number.isSafeInteger(optionOffset) && optionOffset <= tokenOffset;
    if (!optionFound) return null;
    return { name: token[0], startColumn: token.index, endColumn: token.index + token[0].length };
}

function optionRemIdentifierAtPosition(document, position) {
    const token = optionNoKeywordIdentifierAtPosition(document, position);
    return token && normalizeIdentifier(token.name) === "rem" ? token : null;
}

function hasPotentialMaskedRemIdentifierInDocument(document) {
    const text = document.getText();
    if (!/(?:^|\r?\n)\s*option\s+nokeyword\b[^\r\n]*\brem\b/i.test(text)) return false;
    for (let line = 0; line < document.lineCount; line++) {
        const lineText = document.lineAt(line).text;
        for (const match of lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)) {
            const rem = optionRemIdentifierAtPosition(document, { line, character: match.index });
            if (!rem) continue;
            const sourceToken = tokenize(lineText).tokens.find((candidate) =>
                candidate.startColumn === rem.startColumn && candidate.endColumn === rem.endColumn
            );
            if (!sourceToken) return true;
        }
    }
    return false;
}

function hasPotentialLegacyImplicitVariableHint(document, range, workspaceIndex,
    implicitDialectConfirmed = false) {
    if (!range?.start || !range?.end || range.start.line < 0 || range.end.line < range.start.line) return false;
    let sourceModel = null;
    for (let line = range.start.line; line <= range.end.line; line++) {
        const lineText = document.lineAt(line).text;
        if (/^\s*#/.test(lineText)) continue;
        const noKeywordIdentifier = [...lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)].find((match) =>
            optionNoKeywordIdentifierAtPosition(document, { line, character: match.index })
        );
        if (noKeywordIdentifier) {
            sourceModel ||= workspaceIndex.getSourceSemanticModel?.() ||
                workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
            if (!sourceModel?.resolveAt?.(document.uri, line, noKeywordIdentifier.index).length) {
                return implicitDialectConfirmed || compilerUsesImplicitVariableDialect(document, workspaceIndex);
            }
        }
        for (const token of tokenize(lineText).tokens) {
            if (token.kind !== "identifier" || FREEBASIC_KEYWORDS.has(token.key)) continue;
            sourceModel ||= workspaceIndex.getSourceSemanticModel?.() ||
                workspaceIndex.getSemanticModel?.(document.uri, { sourceOnly: true });
            if (sourceModel?.resolveAt?.(document.uri, line, token.startColumn).length) continue;
            return implicitDialectConfirmed || compilerUsesImplicitVariableDialect(document, workspaceIndex);
        }
    }
    return false;
}

function hasPotentialImplicitVariableHint(parsed, document, range, workspaceIndex, assignmentOnly = false) {
    if (!range?.start || !range?.end) return false;
    let sourceModel = null;
    for (const statement of parsed?.statements || []) {
        if (!Number.isSafeInteger(statement.startLine)) continue;
        const statementEndLine = statement.endLine ?? statement.startLine;
        if (!Number.isSafeInteger(statementEndLine) || statementEndLine < range.start.line ||
            statement.startLine > range.end.line ||
            statementEndLine - statement.startLine >= MAX_IMPLICIT_TARGET_STATEMENT_LINES) continue;
        const code = String(statement.maskedText || "").trim();
        const candidateNames = [];
        const loopMatch = code.match(/^for\s+(?:each\s+)?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)(.*)$/i);
        const assignmentMatch = code.match(/^(?:let\s+)?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)\s*(?:=>|=)/i);
        const compoundAssignmentMatch = IMPLICIT_COMPOUND_ASSIGNMENT_TARGET.exec(code);
        if (!assignmentOnly && loopMatch && !/^\s+as\b/i.test(loopMatch[2]) && /^\s*(?:=|\bin\b)/i.test(loopMatch[2])) {
            candidateNames.push(loopMatch[1]);
        }
        if (assignmentMatch && !/[$%!#&]$/.test(assignmentMatch[1])) candidateNames.push(assignmentMatch[1]);
        if (compoundAssignmentMatch && !/[$%!#&]$/.test(compoundAssignmentMatch[2])) {
            candidateNames.push(compoundAssignmentMatch[2]);
        }
        candidateNames.push(...implicitSwapTargetNames(code));
        candidateNames.push(...implicitLsetRsetTargetNames(code));

        if (!assignmentOnly) candidateNames.push(...implicitInputReadTargetNames(code));
        if (!candidateNames.length) continue;

        sourceModel ||= workspaceIndex.getSourceSemanticModel?.() ||
            workspaceIndex.getSemanticModel(document.uri, { sourceOnly: true });
        const targets = compilerStatementTargetOccurrences(
            document, statement, candidateNames, range.start.line, range.end.line
        );
        for (const target of targets) {
            if (/[$%!#&]$/.test(target.name)) continue;
            if (sourceModel?.resolveAt?.(document.uri, target.line, target.startColumn).length) continue;
            return true;
        }
    }
    return false;
}

function createFoldingRangeProvider(vscode, workspaceIndex) {
    return {
        provideFoldingRanges(document) {
            const parsedDocument = workspaceIndex.getParsedDocument(document);
            return parsedDocument.foldingRanges.map((range) => new vscode.FoldingRange(
                range.startLine,
                range.endLine,
                range.kind === "region" ? vscode.FoldingRangeKind.Region
                    : range.kind === "comment" ? vscode.FoldingRangeKind.Comment
                        : range.kind === "imports" ? vscode.FoldingRangeKind.Imports : undefined
            ));
        }
    };
}

function createDocumentFormattingProvider(vscode, workspaceIndex) {
    return {
        provideDocumentFormattingEdits(document, options) {
            const parsed = workspaceIndex.getParsedDocument(document);
            return formatFreeBasicIndentation(document.getText(), parsed, options).map((edit) =>
                vscode.TextEdit.replace(
                    new vscode.Range(edit.line, edit.start, edit.line, edit.end),
                    edit.newText
                )
            );
        }
    };
}

function createDocumentRangeFormattingProvider(vscode, workspaceIndex) {
    const documentFormatting = createDocumentFormattingProvider(vscode, workspaceIndex);
    return {
        provideDocumentRangeFormattingEdits(document, range, options) {
            if (!range?.start || !range?.end) return [];
            const edits = documentFormatting.provideDocumentFormattingEdits(document, options);
            let lastLine = range.end.line;
            if (lastLine > range.start.line && range.end.character === 0) lastLine--;
            if (lastLine < range.start.line) return [];
            return edits.filter((edit) =>
                edit.range.start.line >= range.start.line && edit.range.start.line <= lastLine
            );
        }
    };
}

function createDocumentLinkProvider(vscode, workspaceIndex) {
    return {
        async provideDocumentLinks(document, token) {
            if (document.uri.scheme !== "file") {
                return [];
            }

            const analysis = workspaceIndex.compilerAnalysis;
            const version = document.version;
            /* Stock sidecars also carry physical include outcomes. Join an
               on-demand preparation if an upgrade has already hidden the old
               snapshot, rather than treating that gap as source-only mode. */
            let compilerModel = analysis?.getModel(document.uri) ||
                await analysis?.getModelForEditor?.(document, token, true);
            if (token?.isCancellationRequested || document.version !== version) return [];
            if (compilerModel) {
                /* A binding upgrade can replace the model during this query.
                   Retry once against its successor instead of falling back
                   to source includes from compiler-inactive branches. */
                for (let attempt = 0; attempt < 2 && compilerModel; attempt++) {
                    const records = compilerModel.remote
                        ? await compilerModel.query("documentLinks", document.uri, {}, token)
                        : compilerModel.compilerDocumentLinks(document.uri);
                    if (token?.isCancellationRequested || document.version !== version) return [];
                    if (Array.isArray(records)) {
                        return records.map((record) => {
                            const link = new vscode.DocumentLink(
                                new vscode.Range(record.start.line, record.start.character, record.end.line, record.end.character),
                                vscode.Uri.file(record.target)
                            );
                            const openStatus = record.outcome === "include-once" || record.outcome === "pragma-once"
                                ? " The compiler skipped reopening this already-included file."
                                : "";
                            link.tooltip = `Open ${record.requested}. Resolved by FreeBASIC to ${record.target}.${openStatus}`;
                            return link;
                        });
                    }
                    if (attempt || analysis.getModel(document.uri) === compilerModel) break;
                    compilerModel = await analysis.getModelForEditor?.(document, token, true) || analysis.getModel(document.uri);
                }
                return [];
            }

            const parsedDocument = workspaceIndex.getParsedDocument(document);
            const links = [];

            for (const include of parsedDocument.includes) {
                const targetPath = resolveIncludePath(vscode, document.uri.fsPath, include);
                if (!targetPath) {
                    continue;
                }

                const link = new vscode.DocumentLink(
                    new vscode.Range(
                        include.line,
                        include.startColumn,
                        include.line,
                        include.endColumn
                    ),
                    vscode.Uri.file(targetPath)
                );
                link.tooltip = `Open ${include.path}`;
                links.push(link);
            }

            return links;
        }
    };
}

/* ------------------------------------------------------------------------- */
/* Mapping and visibility helpers                                             */
/* ------------------------------------------------------------------------- */

function createDocumentSymbolTree(vscode, document, declarations, compilerConstantValues = null, compilerTypeDetails = null) {
    const symbolByDeclaration = new Map();
    const roots = [];

    for (const declaration of declarations) {
        const compilerValue = compilerConstantValues?.get(declaration);
        const typeDetails = compilerTypeDetails?.get(declaration);
        const documentation = typeof declaration.documentation === "string"
            ? declaration.documentation : sourceDocumentationForOutline(document, declaration);
        const documentationSummary = compilerDocumentationSummary({ ...declaration, documentation });
        const detailParts = [declaration.detail || declaration.type];
        if (typeDetails?.typeName) detailParts.push(`As ${typeDetails.typeName}`);
        const baseTypeDetail = compilerBaseTypeSummary(declaration, typeDetails);
        if (baseTypeDetail) detailParts.push(`(${baseTypeDetail})`);
        if (typeDetails?.writtenType === "implicit") detailParts.push("(implicit type)");
        if (typeDetails?.writtenType === "inferred") detailParts.push("(inferred type)");
        if (typeDetails?.enumElementInput?.explicit === false &&
            Number.isSafeInteger(typeDetails.enumElementInput.ordinal) && typeDetails.enumElementInput.ordinal > 0) {
            detailParts.push("(compiler-assigned enum value)");
        }
        const implicitStorageDetail = compilerImplicitStorageSummary({ declaration, compilerFacts: typeDetails });
        if (implicitStorageDetail) detailParts.push(`(${implicitStorageDetail})`);
        const parameterPassingDetail = compilerParameterOutlineSummary({
            declaration,
            compilerFacts: typeDetails
        });
        if (parameterPassingDetail) detailParts.push(`(${parameterPassingDetail})`);
        const fieldLayoutDetail = compilerFieldLayoutSummary({ declaration, compilerFacts: typeDetails });
        if (fieldLayoutDetail) detailParts.push(`(${fieldLayoutDetail})`);
        const memberAccessDetail = compilerMemberAccessSummary({ declaration, compilerFacts: typeDetails });
        if (memberAccessDetail) detailParts.push(`(${memberAccessDetail})`);
        const arrayBoundsDetail = compilerArrayBoundsSummary(typeDetails);
        if (arrayBoundsDetail) detailParts.push(`(${arrayBoundsDetail})`);
        const stringInitializationDetail = compilerScalarStringOutlineSummary(typeDetails);
        if (stringInitializationDetail) detailParts.push(`(${stringInitializationDetail})`);
        const aggregateEntry = { declaration, compilerFacts: typeDetails };
        const aggregateLayoutDetail = compilerAggregateLayoutSummary(aggregateEntry);
        if (aggregateLayoutDetail) detailParts.push(`(${aggregateLayoutDetail})`);
        const abstractMemberDetail = compilerAbstractMemberSummary(aggregateEntry);
        if (abstractMemberDetail) detailParts.push(`(${abstractMemberDetail})`);
        const procedureAbiDetail = compilerProcedureOutlineAbiSummary(aggregateEntry);
        if (procedureAbiDetail) detailParts.push(`(${procedureAbiDetail})`);
        const defaultVisibilityDetail = compilerDefaultProcedureVisibilitySummary(aggregateEntry);
        if (defaultVisibilityDetail) detailParts.push(`(${defaultVisibilityDetail})`);
        const overrideDetail = compilerOverrideSummary(aggregateEntry);
        if (overrideDetail) detailParts.push(`(${overrideDetail})`);
        if (compilerValue) detailParts.push(`(compiler value: ${compilerValue})`);
        if (documentationSummary) detailParts.push(`- ${documentationSummary}`);
        const detail = detailParts.join(" ");
        const symbol = new vscode.DocumentSymbol(
            declaration.name,
            detail,
            declarationTypeToSymbolKind(vscode, declaration.type, sourceDeclarationCallableKind(declaration)),
            declarationFullRange(vscode, document, declaration),
            declarationSelectionRange(vscode, declaration)
        );
        if (semanticEntryIsDeprecated({ declaration: { ...declaration, documentation } }) &&
            vscode.SymbolTag?.Deprecated !== undefined) {
            symbol.tags = [...new Set([...(symbol.tags || []), vscode.SymbolTag.Deprecated])];
        }
        symbolByDeclaration.set(declaration, symbol);

        const parentSymbol = symbolByDeclaration.get(declaration.parentDeclaration);
        if (parentSymbol) {
            parentSymbol.children.push(symbol);
        } else {
            roots.push(symbol);
        }
    }

    return roots;
}

function sourceDocumentationForOutline(document, declaration) {
    if (!Number.isSafeInteger(declaration?.line) || declaration.line < 1) return "";
    const documentation = [];
    let characters = 0;
    for (let line = declaration.line - 1;
        line >= 0 && documentation.length < MAX_OUTLINE_DOCUMENTATION_LINES;
        line--) {
        const match = /^\s*''(?:[\t ]?(.*))?$/.exec(document.lineAt(line).text);
        if (!match) break;
        const text = match[1] || "";
        characters += text.length;
        if (characters > MAX_OUTLINE_DOCUMENTATION_CHARACTERS) return "";
        documentation.unshift(text);
    }
    return documentation.join("\n");
}

function createWorkspaceDeclarationMarkdown(vscode, entries) {
    const markdown = new vscode.MarkdownString();

    for (let index = 0; index < Math.min(entries.length, 5); index++) {
        const entry = entries[index];
        if (index > 0) {
            markdown.appendMarkdown("\n\n---\n\n");
        }
        markdown.appendCodeblock(entry.declaration.signature, "freebasic");
        const sourceDocumentation = compilerDeclarationDocumentation(entry.declaration);
        if (sourceDocumentation) markdown.appendMarkdown(`\n\n${sourceDocumentation}`);
        const deprecation = compilerDeprecatedMarkdown(entry);
        if (deprecation) markdown.appendMarkdown(`\n\n${deprecation}`);
        const implicitReturnType = compilerImplicitProcedureReturnTypeMarkdown(entry);
        if (implicitReturnType) markdown.appendMarkdown(`\n\n${implicitReturnType}`);
        const implicitParameterType = compilerImplicitParameterTypeMarkdown(entry);
        if (implicitParameterType) markdown.appendMarkdown(`\n\n${implicitParameterType}`);
        const constantValue = compilerConstantValue(entry.compilerFacts || entry.declaration?.compilerFacts);
        if (constantValue) markdown.appendMarkdown(`\n\nCompiler constant value in this context: \`${constantValue}\`.`);
        const stringInitialization = compilerScalarStringInitializationMarkdown(entry);
        if (stringInitialization) markdown.appendMarkdown(`\n\n${stringInitialization}`);
        const storageType = compilerStorageTypeMarkdown(entry.compilerFacts || entry.declaration?.compilerFacts);
        if (storageType) markdown.appendMarkdown(`\n\n${storageType}`);
        const procedureAbi = compilerProcedureAbiMarkdown(entry.compilerFacts || entry.declaration?.compilerFacts);
        if (procedureAbi) markdown.appendMarkdown(`\n\n${procedureAbi}`);
        const overrideTarget = compilerProcedureOverrideMarkdown(entry.compilerFacts || entry.declaration?.compilerFacts);
        if (overrideTarget) markdown.appendMarkdown(`\n\n${overrideTarget}`);
        const visibility = compilerSymbolVisibilityMarkdown(
            entry.compilerFacts || entry.declaration?.compilerFacts, entry.declaration, entry.qualifiedName
        );
        if (visibility) markdown.appendMarkdown(`\n\n${visibility}`);
        const abstractType = compilerAbstractTypeMarkdown(entry);
        if (abstractType) markdown.appendMarkdown(`\n\n${abstractType}`);
        const baseType = compilerBaseTypeMarkdown(entry.declaration, entry.compilerFacts || entry.declaration.compilerFacts);
        if (baseType) markdown.appendMarkdown(`\n\n${baseType}`);
        const aggregateAccess = compilerAggregateAccessMarkdown(entry);
        if (aggregateAccess) markdown.appendMarkdown(`\n\n${aggregateAccess}`);
        const implicitStorage = compilerImplicitVariableStorageMarkdown(entry);
        if (implicitStorage) markdown.appendMarkdown(`\n\n${implicitStorage}`);
        const parameterPassing = compilerParameterPassingMarkdown(entry.compilerFacts || entry.declaration?.compilerFacts);
        if (parameterPassing) markdown.appendMarkdown(`\n\n${parameterPassing}`);
        if (entry.declaration.type === "field") {
            const fieldLayout = compilerFieldLayoutMarkdown(entry.compilerFacts || entry.declaration?.compilerFacts);
            if (fieldLayout) markdown.appendMarkdown(`\n\n${fieldLayout}`);
        }
        if (entry.declaration.compilerMacroDefinition) {
            markdown.appendMarkdown("\n\nSource definition:");
            markdown.appendCodeblock(entry.declaration.compilerMacroDefinition, "freebasic");
        }
        markdown.appendMarkdown(`\nDeclared in \`${path.basename(entry.uri.fsPath || entry.uri.path)}\` on line ${entry.declaration.line + 1}.`);
        if (entry.declaration.provisional) markdown.appendMarkdown("\n\nCompiler recovery declaration (provisional).");
    }
    return markdown;
}

function compilerStorageTypeMarkdown(compilerFacts) {
    const storageType = compilerFacts?.storageType;
    const details = [];
    if (storageType && Number.isSafeInteger(storageType.storageBytes) && storageType.storageBytes > 0 &&
        Number.isSafeInteger(storageType.pointerDepth) && storageType.pointerDepth >= 0 &&
        typeof storageType.primitive === "string" && typeof storageType.isReference === "boolean") {
        const unit = storageType.storageBytes === 1 ? "byte" : "bytes";
        let detail = `Compiler-selected storage width for one value in this target: \`${storageType.storageBytes} ${unit}\`.`;
        if (storageType.pointerDepth > 0) {
            detail += " This is the pointer value; the pointed-to storage is separate.";
        } else if (storageType.isReference) {
            detail += " This is the referenced value type, not an estimate of the caller's argument storage.";
        }
        if (storageType.pointerDepth === 0 && ["string", "wstring", "ustring"].includes(storageType.primitive)) {
            detail += " This is the string descriptor; allocated character data is separate.";
        }
        details.push(detail);
    }
    const aggregateSize = compilerFacts?.aggregateSizeBytes;
    if (Number.isSafeInteger(aggregateSize) && aggregateSize > 0) {
        const unit = aggregateSize === 1 ? "byte" : "bytes";
        details.push(`Compiler-selected aggregate layout in this target: \`${aggregateSize} ${unit}\`.`);
    }
    const naturalAlignment = compilerSemanticPropertyInteger(compilerFacts, "natural-alignment");
    if (naturalAlignment !== null && naturalAlignment > 0) {
        const unit = naturalAlignment === 1 ? "byte" : "bytes";
        details.push(`Compiler-selected natural alignment: \`${naturalAlignment} ${unit}\`.`);
    }
    const packingAlignment = compilerSemanticPropertyInteger(compilerFacts, "packing-alignment");
    if (packingAlignment !== null && packingAlignment > 0) {
        const unit = packingAlignment === 1 ? "byte" : "bytes";
        details.push(`Compiler-selected packing alignment: \`${packingAlignment} ${unit}\`.`);
    }
    const arrayBounds = compilerArrayBoundsMarkdown(compilerFacts?.arrayBounds);
    if (arrayBounds) details.push(arrayBounds);
    const arrayElements = compilerFixedArrayElementCount(compilerFacts);
    if (arrayElements) details.push(`Compiler array element count: \`${arrayElements.text}\`.`);
    const arrayElementStorage = compilerArrayElementStorageMarkdown(compilerFacts, arrayElements);
    if (arrayElementStorage) details.push(arrayElementStorage);
    return details.join(" ");
}

function compilerImplicitVariableTypeMarkdown(declaration, compilerFacts) {
    if (!declaration || declaration.type !== "variable" || declaration.provisional === true ||
        typeof declaration.typeName === "string" && declaration.typeName.trim() ||
        /[$%!#&]$/.test(String(declaration.name || ""))) return "";
    const typeName = compilerPrimitiveTypeName(compilerFacts?.storageType);
    return typeName ? `Compiler-selected variable type: \`${typeName}\`.` : "";
}

function compilerPrimitiveTypeName(storageType) {
    if (!storageType || storageType.isReference === true ||
        !Number.isSafeInteger(storageType.pointerDepth) || storageType.pointerDepth < 0 ||
        storageType.pointerDepth > MAX_COMPILER_IMPLICIT_TYPE_POINTER_DEPTH ||
        typeof storageType.primitive !== "string") return "";
    const primitive = COMPILER_PRIMITIVE_TYPE_NAMES[normalizeTypeName(storageType.primitive)];
    if (!primitive) return "";
    return `${primitive}${" Ptr".repeat(storageType.pointerDepth)}`;
}

function compilerScalarStringOutlineSummary(compilerFacts) {
    const initialization = compilerFacts?.scalarStringDeclaration;
    if (!initialization || initialization.provisional === true ||
        !["dim", "static", "field"].includes(initialization.kind) ||
        !Number.isSafeInteger(initialization.statement) || initialization.statement < 1 ||
        !Number.isSafeInteger(initialization.expression) || initialization.expression < 0) return "";
    if (initialization.expression === 0) return "default String initialization";
    const initializer = compilerConstantValueText(initialization.initializerValue);
    return initializer ? `String initializer: ${initializer}` : "";
}

function compilerArrayBoundsMarkdown(arrayBounds) {
    if (!arrayBounds || !["bounds", "runtime"].includes(arrayBounds.mode)) return "";
    if (arrayBounds.mode === "runtime") {
        if (arrayBounds.rank === null) {
            return "Compiler confirms this is a runtime array; its rank and bounds are not fixed.";
        }
        if (!Number.isSafeInteger(arrayBounds.rank) || arrayBounds.rank < 1) return "";
        return `Compiler confirms a runtime array of rank ${arrayBounds.rank}; its bounds are not fixed.`;
    }

    if (!Number.isSafeInteger(arrayBounds.rank) || arrayBounds.rank < 1 ||
        !Array.isArray(arrayBounds.dimensions) || arrayBounds.dimensions.length !== arrayBounds.rank) return "";
    const dimensions = [];
    for (let index = 0; index < arrayBounds.dimensions.length; index++) {
        const dimension = arrayBounds.dimensions[index];
        if (!dimension || dimension.dimension !== index || !Number.isSafeInteger(dimension.lower) ||
            !["fixed", "unknown"].includes(dimension.kind)) return "";
        if (dimension.kind === "fixed") {
            if (!Number.isSafeInteger(dimension.upper)) return "";
            dimensions.push(`${dimension.lower} to ${dimension.upper}`);
        } else {
            dimensions.push(`${dimension.lower} to unknown`);
        }
    }
    return `Compiler-selected array bounds in this build: ${dimensions.map((dimension) => `\`${dimension}\``).join(", ")}.`;
}

function compilerFixedArrayElementCount(compilerFacts) {
    const bounds = compilerFacts?.arrayBounds;
    if (bounds?.mode !== "bounds" || !Number.isSafeInteger(bounds.rank) || bounds.rank < 1 ||
        !Array.isArray(bounds.dimensions) || bounds.dimensions.length !== bounds.rank ||
        bounds.dimensions.some((dimension, index) => dimension?.dimension !== index || dimension.kind !== "fixed" ||
            !Number.isSafeInteger(dimension.lower) || !Number.isSafeInteger(dimension.upper) || dimension.upper < dimension.lower)) return "";

    let expectedCount = 1n;
    for (const dimension of bounds.dimensions) {
        expectedCount *= BigInt(dimension.upper) - BigInt(dimension.lower) + 1n;
    }
    const values = new Set((compilerFacts.properties || [])
        .filter((property) => property.name === "array-elements" && property.provisional !== true &&
            typeof property.value === "string" && property.value.length <= 20 &&
            /^(?:0|[1-9]\d*)$/.test(property.value))
        .map((property) => property.value));
    if (values.size !== 1) return "";
    const [value] = values;
    if (BigInt(value) !== expectedCount) return "";
    return { text: value, count: expectedCount };
}

function compilerArrayElementStorageMarkdown(compilerFacts, arrayElements) {
    const storage = compilerFacts?.storageType;
    const passing = compilerFacts?.parameterPassing;
    if (!arrayElements || arrayElements.count < 1n || !storage || storage.isReference === true ||
        typeof storage.isReference !== "boolean" || !Number.isSafeInteger(storage.pointerDepth) ||
        storage.pointerDepth < 0 || passing?.receiver === true || passing?.mode === "bydesc" ||
        passing?.mode === "vararg" ||
        !Number.isSafeInteger(storage.storageBytes) || storage.storageBytes < 1) return "";
    const totalBytes = arrayElements.count * BigInt(storage.storageBytes);
    const elementWord = arrayElements.count === 1n ? "element" : "elements";
    let detail = `Compiler-selected fixed-array element storage: ${arrayElements.text} ${elementWord} × ${storage.storageBytes} bytes = ${totalBytes} bytes.`;
    if (Number.isSafeInteger(storage.pointerDepth) && storage.pointerDepth > 0) {
        detail += " Pointed-to storage is separate.";
    }
    if (["string", "wstring", "ustring"].includes(storage.primitive)) {
        detail += " Allocated string data is separate.";
    }
    return detail;
}

function compilerFieldLayoutMarkdown(compilerFacts) {
    const fieldLayout = compilerFacts?.fieldLayout;
    if (!fieldLayout || !Number.isSafeInteger(fieldLayout.byteOffset) || fieldLayout.byteOffset < 0) return "";
    const unit = fieldLayout.byteOffset === 1 ? "byte" : "bytes";
    let detail = `Compiler-selected field offset: \`${fieldLayout.byteOffset} ${unit}\` from the start of its containing aggregate.`;
    const bitPosition = compilerSemanticPropertyInteger(compilerFacts, "bit-position");
    const bitWidth = compilerSemanticPropertyInteger(compilerFacts, "bit-width");
    if (bitPosition !== null && bitWidth !== null && bitWidth > 0) {
        detail += ` Compiler-selected bit position: ${bitPosition}; width: ${bitWidth} bits.`;
    }
    return detail;
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

function compilerProcedureAbiMarkdown(compilerFacts) {
    const callingConvention = compilerFacts?.procedureCallingConvention;
    const allowedConventions = new Set(["basic", "cdecl", "stdcall", "stdcall-ms", "pascal", "thiscall", "fastcall"]);
    const allowedLinkages = new Set(["basic", "c", "windows", "windows-ms", "c++", "pascal", "rtlib"]);
    if (typeof callingConvention !== "string" || !allowedConventions.has(callingConvention)) return "";

    const linkages = new Set((compilerFacts.properties || [])
        .filter((property) => property.name === "procedure-linkage" && property.provisional !== true &&
            typeof property.value === "string" && allowedLinkages.has(property.value))
        .map((property) => property.value));
    if (linkages.size > 1) return "";
    const linkage = linkages.size === 1 ? linkages.values().next().value : "";
    const linkageNames = {
        c: "C",
        "c++": "C++",
        windows: "Windows",
        "windows-ms": "Microsoft Windows",
        pascal: "Pascal"
    };
    const parts = [];
    if (linkageNames[linkage]) parts.push(`${linkageNames[linkage]} linkage`);
    if (callingConvention !== "basic") parts.push(`${callingConvention} calling convention`);
    if (compilerFacts.procedureReturnsByReference === true) parts.push("ByRef return");
    const writtenConvention = consistentProcedureAbiPolicy(compilerFacts, "writtenConvention");
    if (linkage && linkage !== "basic" && linkage !== "rtlib" && writtenConvention === false) {
        parts.push("calling convention not written explicitly");
    }
    if (consistentProcedureAbiPolicy(compilerFacts, "managedString") === true) {
        parts.push("FreeBASIC STRING-based type in signature");
    }
    return parts.length ? `Compiler-selected procedure ABI: ${parts.join(", ")}.` : "";
}

function compilerDeprecatedMarkdown(entry) {
    return semanticEntryIsDeprecated(entry) ? "Marked deprecated in source documentation." : "";
}

function consistentProcedureAbiPolicy(compilerFacts, property) {
    const policies = compilerFacts?.procedureAbiPolicyInputs;
    if (!Array.isArray(policies) || policies.length === 0) return null;
    const values = new Set();
    for (const policy of policies) {
        if (!policy || policy.provisional === true || typeof policy[property] !== "boolean") return null;
        values.add(policy[property]);
    }
    return values.size === 1 ? values.values().next().value : null;
}

function compilerProcedureOverrideMarkdown(compilerFacts) {
    const qualifiedName = compilerFacts?.overriddenProcedure?.qualifiedName;
    if (typeof qualifiedName !== "string" || !qualifiedName || qualifiedName.length > 512 ||
        /[\r\n]/.test(qualifiedName)) return "";
    const markerWritten = compilerSemanticPropertyInteger(compilerFacts, "written-override");
    const markerNote = markerWritten === 0 ? " The optional `Override` marker is not written." : "";
    return `Compiler-selected override target: \`${qualifiedName.replace(/[\\`]/g, "\\$&")}\`.${markerNote}`;
}

function compilerImplicitProcedureReturnTypeMarkdown(entry) {
    const declaration = entry?.declaration;
    if (!declaration || declaration.provisional === true || !["function", "property"].includes(declaration.type)) return "";
    const compilerFacts = entry.compilerFacts || declaration.compilerFacts;
    const typingInputs = compilerFacts?.procedureTypingInputs;
    if (!Array.isArray(typingInputs) || !typingInputs.length ||
        typingInputs.some((input) => input.provisional === true || input.resultForm !== "implicit" ||
            input.kind !== declaration.type)) return "";
    const typeName = declaration.typeName || entry.nativeSymbol?.typeName;
    if (typeof typeName !== "string" || !typeName || typeName.length > 512 || /[\r\n]/.test(typeName)) return "";
    return `Compiler-selected implicit return type: \`${typeName.replace(/[\\`]/g, "\\$&")}\`.`;
}

function compilerImplicitParameterTypeMarkdown(entry) {
    const declaration = entry?.declaration;
    if (!declaration || declaration.provisional === true || declaration.type !== "parameter") return "";
    const compilerFacts = entry.compilerFacts || declaration.compilerFacts;
    const writtenTypes = compilerFacts?.formalWrittenTypes;
    if (!Array.isArray(writtenTypes) || !writtenTypes.length || writtenTypes.some((writtenType) => writtenType !== "implicit")) return "";
    const typeName = declaration.typeName || entry.nativeSymbol?.typeName;
    if (typeof typeName !== "string" || !typeName || typeName.length > 512 || /[\r\n]/.test(typeName)) return "";
    return `Compiler-selected implicit parameter type: \`${typeName.replace(/[\\`]/g, "\\$&")}\`.`;
}

function compilerSymbolVisibilityMarkdown(compilerFacts, declaration = null, qualifiedName = "") {
    const visibility = compilerFacts?.compilerVisibility;
    const visibilityInputs = compilerFacts?.procedureWrittenVisibility;
    const typingInputs = compilerFacts?.procedureTypingInputs;
    const visibilityInput = Array.isArray(visibilityInputs) && visibilityInputs.length === 1
        ? visibilityInputs[0]
        : null;
    const typingInput = Array.isArray(typingInputs) && typingInputs.length === 1 ? typingInputs[0] : null;
    const resolvedName = declaration?.qualifiedName || qualifiedName;
    const defaultStandaloneProcedure = declaration?.provisional !== true &&
        ["function", "sub"].includes(declaration?.type) &&
        !declaration?.modifiers?.includes("DECLARE") && !declaration?.containerName &&
        !(typeof resolvedName === "string" && resolvedName.includes(".")) &&
        visibilityInput?.provisional !== true && visibilityInput?.visibility === "default" &&
        typingInput?.provisional !== true && typingInput?.role === "definition" &&
        visibilityInput.statement === typingInput.statement;
    if (defaultStandaloneProcedure && ["public", "private"].includes(visibility)) {
        return `Compiler-selected visibility: \`${visibility}\` (scope default; no modifier written).`;
    }
    if (visibility === "public" &&
        (declaration?.type === "field" || typeof declaration?.containerName === "string" && declaration.containerName ||
            typeof resolvedName === "string" && resolvedName.includes("."))) {
        return "Compiler-selected visibility: public.";
    }
    if (!["private", "protected"].includes(visibility)) return "";
    return `Compiler-selected visibility: \`${visibility}\`.`;
}

function compilerAbstractTypeMarkdown(entry) {
    if (!entry?.declaration || entry.declaration.provisional === true ||
        !["type", "class"].includes(entry.declaration.type)) return "";
    const count = (entry.compilerFacts || entry.declaration.compilerFacts)?.abstractMemberCount;
    if (!Number.isSafeInteger(count) || count <= 0) return "";
    const memberWord = count === 1 ? "member" : "members";
    return `Compiler reports ${count} unimplemented abstract ${memberWord}; this type cannot be instantiated until they are implemented.`;
}

function compilerBaseTypeMarkdown(declaration, compilerFacts = null, includeDeclared = true) {
    if (!declaration || !["type", "class"].includes(declaration.type) || declaration.detail === "Type alias") return "";
    const compilerBaseType = typeof compilerFacts?.baseType === "string" ? compilerFacts.baseType : "";
    const baseType = compilerBaseType || declaration.baseType;
    if (typeof baseType !== "string" || !baseType || baseType.length > 512 || /[\r\n]/.test(baseType)) return "";
    const sourceLabel = compilerBaseType || declaration.compilerBaseTypeConfirmed === true
        ? "Compiler-selected base type"
        : "Declared base type";
    if (sourceLabel === "Declared base type" && !includeDeclared) return "";
    return `${sourceLabel}: \`${baseType.replace(/[\\`]/g, "\\$&")}\`.`;
}

function compilerBaseTypeSummary(declaration, compilerFacts = null) {
    if (!declaration || !["type", "class"].includes(declaration.type) || declaration.detail === "Type alias") return "";
    const baseType = typeof compilerFacts?.baseType === "string" ? compilerFacts.baseType : declaration.baseType;
    if (typeof baseType !== "string" || !baseType || baseType.length > 512 || /[\r\n]/.test(baseType)) return "";
    return `extends ${baseType}`;
}

function compilerAggregateAccessMarkdown(entry) {
    const declaration = entry?.declaration;
    if (!declaration || declaration.provisional === true ||
        !["type", "class", "union"].includes(declaration.type)) return "";
    const facts = entry.compilerFacts || declaration.compilerFacts;
    const access = facts?.aggregateAccess;
    if (!access || !Number.isSafeInteger(access.bodyStatement) || access.bodyStatement < 1 ||
        !Number.isSafeInteger(access.count) || access.count < 1 ||
        !Array.isArray(access.sections) || access.sections.length !== access.count) return "";
    if ((facts.properties || []).some((property) =>
        property.provisional === true &&
        (property.name === "aggregate-body-statement" || property.name === "aggregate-access-count" ||
            property.name.startsWith("aggregate-access-section:")))) return "";

    const sections = access.sections.slice().sort((first, second) => first.ordinal - second.ordinal);
    const names = [];
    for (let index = 0; index < sections.length; index++) {
        const section = sections[index];
        if (section.ordinal !== index + 1 || !Number.isSafeInteger(section.statement) ||
            section.statement < 1 || !["public", "private", "protected"].includes(section.visibility)) return "";
        names.push(section.visibility[0].toUpperCase() + section.visibility.slice(1));
    }
    return `Compiler-confirmed member access sections: ${names.join(", ")}.`;
}

function compilerImplicitVariableStorageMarkdown(entry) {
    const declaration = entry?.declaration;
    if (!declaration || declaration.provisional === true || declaration.type !== "variable" ||
        typeof declaration.signature !== "string" || !/^variable\s+/i.test(declaration.signature)) return "";
    const storage = (entry.compilerFacts || declaration.compilerFacts)?.compilerStorageClass;
    if (storage !== "external" && storage !== "static" && storage !== "local" &&
        storage !== "shared" && storage !== "global") return "";
    return `Compiler-selected storage class: \`${storage}\`.`;
}

function compilerScalarStringInitializationMarkdown(entry) {
    const declaration = entry?.declaration;
    if (!declaration || declaration.provisional === true || !["variable", "field"].includes(declaration.type)) return "";
    const facts = entry.compilerFacts || declaration.compilerFacts;
    const initialization = facts?.scalarStringDeclaration;
    if (!initialization || initialization.provisional === true ||
        !["dim", "static", "field"].includes(initialization.kind) ||
        !Number.isSafeInteger(initialization.statement) || initialization.statement < 1) return "";
    if (initialization.expression === 0) {
        return "Compiler confirms this scalar dynamic String uses its default initialization.";
    }
    const initializer = compilerConstantValueText(initialization.initializerValue);
    return initializer
        ? `Compiler-confirmed scalar dynamic String initializer: \`${initializer}\`.`
        : "";
}

function compilerParameterPassingMarkdown(compilerFacts) {
    const parameter = compilerFacts?.parameterPassing;
    const modeNames = { byval: "ByVal", byref: "ByRef", bydesc: "ByDesc", vararg: "VarArg" };
    if (!parameter || parameter.receiver || !Object.hasOwn(modeNames, parameter.mode) ||
        typeof parameter.optional !== "boolean") return "";
    let detail = "";
    if (parameter.mode === "bydesc") {
        if (parameter.dimensions === -1) detail = " (any array rank)";
        else if (Number.isSafeInteger(parameter.dimensions) && parameter.dimensions > 0) {
            detail = ` (rank ${parameter.dimensions} array)`;
        }
    }
    const writtenMode = parameter.modeWritten === false ||
        parameter.modeWritten !== true && compilerSemanticPropertyInteger(compilerFacts, "formal-written-mode") === 0;
    if (writtenMode && (parameter.mode === "byval" || parameter.mode === "byref")) {
        detail += " (default; keyword not written)";
    }
    const optional = parameter.optional ? " Optional parameter." : "";
    return `Compiler-selected parameter passing: ${modeNames[parameter.mode]}${detail}.${optional}`;
}

function compilerFormalDefaultValueMarkdown(defaultValue) {
    if (!defaultValue || typeof defaultValue.kind !== "string" || typeof defaultValue.value !== "string") return "";
    const value = compilerConstantValueText(defaultValue);
    if (!value || value.length > 1024 || /[\r\n\0`]/.test(value)) return "";
    const typeName = typeof defaultValue.typeName === "string" && defaultValue.typeName.length <= 512 &&
        !/[\x00-\x1f\x7f`]/.test(defaultValue.typeName) ? defaultValue.typeName.trim() : "";
    return `Compiler-resolved source default expression: \`${value}\`${typeName ? ` (${typeName})` : ""}.`;
}

function compilerDeclarationDocumentation(declaration) {
    if (!declaration) return "";
    return typeof declaration.documentation === "string" ? declaration.documentation : "";
}

function getQualifiedSymbolAtPosition(vscode, document, position) {
    const lineText = document.lineAt(position.line).text;

    for (const match of lineText.matchAll(QUALIFIED_IDENTIFIER_PATTERN)) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character >= start && position.character <= end) {
            return {
                name: match[0],
                range: new vscode.Range(position.line, start, position.line, end)
            };
        }
    }

    return null;
}

function getSimpleNameAtPosition(vscode, document, position) {
    const range = document.getWordRangeAtPosition(position, IDENTIFIER_PATTERN);
    if (!range) {
        return null;
    }
    return { name: document.getText(range), range };
}

function declarationSelectionRange(vscode, declaration) {
    return new vscode.Range(
        declaration.line,
        declaration.startColumn,
        declaration.line,
        declaration.endColumn
    );
}

function declarationFullRange(vscode, document, declaration) {
    const safeEndLine = Math.min(declaration.endLine, Math.max(0, document.lineCount - 1));
    return new vscode.Range(
        declaration.line,
        0,
        safeEndLine,
        document.lineAt(safeEndLine).text.length
    );
}

function occurrenceRange(vscode, occurrence) {
    return new vscode.Range(
        occurrence.line,
        occurrence.startColumn,
        occurrence.line,
        occurrence.endColumn
    );
}

function findScopedDocumentDeclarations(declarations, name, line, character = -1) {
    const matches = findDeclarationsByName(declarations, name);
    const exactMatches = matches.filter((declaration) =>
        declaration.line === line &&
        character >= declaration.startColumn &&
        character <= declaration.endColumn
    );
    if (exactMatches.length > 0) {
        return exactMatches;
    }

    const localMatches = matches.filter((declaration) => {
        const callableParent = getCallableParent(declaration);
        return callableParent && line >= callableParent.line && line <= callableParent.endLine;
    });
    if (localMatches.length > 0) {
        return localMatches;
    }

    return matches.filter((declaration) => !getCallableParent(declaration));
}

function getCallableParent(declaration) {
    let parent = declaration.parentDeclaration;
    while (parent) {
        if (isCallableDeclaration(parent)) {
            return parent;
        }
        parent = parent.parentDeclaration;
    }
    return null;
}

function isDeclarationVisibleAtLine(declaration, line) {
    if (declaration.localOnly && line < declaration.line) {
        return false;
    }

    let parent = declaration.parentDeclaration;
    while (parent) {
        if (isCallableDeclaration(parent)) {
            return line >= parent.line && line <= parent.endLine;
        }
        parent = parent.parentDeclaration;
    }
    return true;
}

function isWorkspaceVisibleDeclaration(declaration) {
    if (declaration.localOnly) {
        return false;
    }

    let parent = declaration.parentDeclaration;
    while (parent) {
        if (isCallableDeclaration(parent)) {
            return false;
        }
        parent = parent.parentDeclaration;
    }
    return declaration.type !== "label";
}

function isCallableDeclaration(declaration) {
    return [
        "constructor",
        "destructor",
        "function",
        "macro",
        "operator",
        "property",
        "sub"
    ].includes(declaration.type);
}

function declarationTypeToCompletionKind(vscode, type, callableKind = null) {
    if (["function", "sub"].includes(type) && callableKind === "method") return vscode.CompletionItemKind.Method;
    switch (type) {
        case "class": return vscode.CompletionItemKind.Class;
        case "const": return vscode.CompletionItemKind.Constant;
        case "constructor": return vscode.CompletionItemKind.Constructor;
        case "enum": return vscode.CompletionItemKind.Enum;
        case "enumMember": return vscode.CompletionItemKind.EnumMember;
        case "field": return vscode.CompletionItemKind.Field;
        case "function":
        case "operator":
        case "sub": return vscode.CompletionItemKind.Function;
        case "label": return vscode.CompletionItemKind.Reference;
        case "macro": return vscode.CompletionItemKind.Snippet;
        case "namespace": return vscode.CompletionItemKind.Module;
        case "property": return vscode.CompletionItemKind.Property;
        case "type":
        case "union": return vscode.CompletionItemKind.Struct;
        default: return vscode.CompletionItemKind.Variable;
    }
}

function sourceDeclarationCallableKind(declaration) {
    if (!["function", "sub"].includes(declaration.type)) return null;
    const owner = declaration.parentDeclaration;
    if (["type", "class", "union"].includes(owner?.type)) return "method";
    if (owner?.type === "namespace" || !owner && !declaration.name.includes(".")) return "function";
    // An unresolved qualified implementation keeps the previous mapping.
    return null;
}

function declarationTypeToSymbolKind(vscode, type, callableKind = null) {
    if (["function", "sub"].includes(type)) {
        if (callableKind === "method") return vscode.SymbolKind.Method;
        if (callableKind === "function") return vscode.SymbolKind.Function;
    }
    switch (type) {
        case "class": return vscode.SymbolKind.Class;
        case "const": return vscode.SymbolKind.Constant;
        case "constructor": return vscode.SymbolKind.Constructor;
        case "enum": return vscode.SymbolKind.Enum;
        case "enumMember": return vscode.SymbolKind.EnumMember;
        case "field": return vscode.SymbolKind.Field;
        case "function": return vscode.SymbolKind.Function;
        case "label": return vscode.SymbolKind.Key;
        case "macro": return vscode.SymbolKind.String;
        case "namespace": return vscode.SymbolKind.Namespace;
        case "operator":
        case "sub": return vscode.SymbolKind.Method;
        case "property": return vscode.SymbolKind.Property;
        case "type":
        case "union": return vscode.SymbolKind.Struct;
        default: return vscode.SymbolKind.Variable;
    }
}

module.exports = {
    createCompletionProvider,
    createDocumentSymbolProvider,
    createDocumentSymbolRegistration,
    createDocumentLinkRegistration,
    createDocumentLinkProvider,
    createDocumentSymbolTree,
    createDocumentFormattingProvider,
    createDocumentRangeFormattingProvider,
    createMissingHeaderCodeActionProvider,
    createEditorFeatures,
    createHoverProvider,
    createSignatureHelpProvider,
    createInlayHintsProvider,
    createWorkspaceSymbolProvider,
    declarationTypeToCompletionKind,
    declarationTypeToSymbolKind,
    findScopedDocumentDeclarations,
    getCallableParent,
    getBuiltInHover,
    getQualifiedSymbolAtPosition,
    getSimpleNameAtPosition,
    isCallableDeclaration,
    isDeclarationVisibleAtLine,
    isWorkspaceVisibleDeclaration,
    resolveIncludePath
};

/* end of lib/editor-features.js */
