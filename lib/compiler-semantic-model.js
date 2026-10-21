/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-semantic-model.js
    Purpose: Present compiler-selected symbols and types at safe editor locations.
    Responsibilities: bind native identities and project unchanged tokens.
    Does not contain: macro simulation, overload scoring, or automatic rename.
*/

const path = require("path");
const { findCallContextInMaskedText, findSignatureCallContextInMaskedText, getCodeContextDetails,
    maskFreeBasicComments, maskFreeBasicText, normalizeIdentifier, parseFreeBasicText } = require("./freebasic-parser");
const { CALLABLE_TYPES, FreeBasicSemanticModel, normalizeTypeName, scopeAt, positionOffset, tokenize } = require("./semantic-model");
const { installNativeInventory } = require("./compiler-inventory");
const { projectNativeTokens } = require("./compiler-origins");
const { installPreprocessorModel, macroDefinitionPreview } = require("./compiler-preprocessor-model");
const { isCompilerConstantValue } = require("./compiler-constant-values");

const MAX_COMPILER_SOURCE_DECLARATION_BYTES = 4 * 1024 * 1024;
const MAX_COMPILER_SOURCE_DECLARATIONS = 20000;
const MAX_COMPILER_SOURCE_DECLARATION_DOCUMENTS = 8;
const compilerSourceDeclarationCaches = new WeakMap();

/* Share bounded physical-header presentation across native queries and symbol
   lists. These declarations never choose identities, visibility or ownership. */
function compilerSourceDeclarations(model, source) {
    let documents = compilerSourceDeclarationCaches.get(model);
    if (!documents) {
        documents = new Map();
        compilerSourceDeclarationCaches.set(model, documents);
    }
    const key = source.uri.toString();
    let declarations = documents.get(key);
    if (documents.has(key)) {
        documents.delete(key);
        documents.set(key, declarations);
    } else {
        declarations = Buffer.byteLength(source.text, "utf8") > MAX_COMPILER_SOURCE_DECLARATION_BYTES
            ? null : parseFreeBasicText(source.text, model.compilerRemIdentifierOffsets?.(source.uri),
                model.compilerDefaultEscapedStringRanges?.(source.uri)).declarations || [];
        if (declarations?.length > MAX_COMPILER_SOURCE_DECLARATIONS) declarations = null;
        documents.set(key, declarations);
        while (documents.size > MAX_COMPILER_SOURCE_DECLARATION_DOCUMENTS) documents.delete(documents.keys().next().value);
    }
    return declarations;
}

const COMPILER_EXPRESSION_DIRECTIVE = /^\s*#\s*(?:if|elseif|assert)\b/i;
const MAX_COMPILER_INACTIVE_RANGES = 5000;
const MAX_COMPILER_TYPE_INLAY_HINTS = 5000;
const MAX_COMPILER_SIDECAR_CALL_RESULTS = 5000;
const MAX_COMPILER_REM_IDENTIFIER_OVERRIDES = 200000;
const MAX_COMPILER_ESCAPED_STRING_RANGES = 200000;
/* Bound validation and repeated-include work for token-free completion gaps. */
const MAX_COMPILER_COMPLETION_GAP_CHARACTERS = 65536;
const MAX_COMPILER_COMPLETION_GAP_CONTEXTS = 64;
/* Keep the compiler-confirmed loop hints bounded like other editor hints. */
const MAX_COMPILER_FOR_ENTRY_INLAY_HINTS = 5000;
/* Keep expression selection bounded; statement and scope ranges provide outer parents. */
const MAX_COMPILER_SELECTION_RANGES = 64;
const MAX_COMPILER_SELECTION_INDEX_ENTRIES = 1000000;
const MAX_COMPILER_SELECTION_CANDIDATES = 10000;
const MAX_COMPILER_PARAMETER_INLAY_HINTS = 5000;
const MAX_COMPILER_ASSIGNMENT_HOVER_FACTS = 100000;
const MAX_COMPILER_ASSIGNMENT_HOVER_FACTS_PER_LINE = 2048;
const MAX_COMPILER_SELECTED_CALL_ARGUMENT_INPUTS = 100000;
/* Keep compiler-selected array storage lookups bounded on large full models. */
const MAX_COMPILER_ARRAY_STORAGE_HOVER_FACTS = 100000;
/* Avoid dense generated lines turning declaration hover lookups into scans. */
const MAX_COMPILER_ARRAY_DECLARATION_HOVER_FACTS_PER_LINE = 2048;
const MAX_COMPILER_FIELD_DECLARATION_HOVER_FACTS_PER_LINE = 2048;
/* Array names are identifiers, so longer records are not useful hover text. */
const MAX_COMPILER_ARRAY_STORAGE_NAME_LENGTH = 1024;
/* Inlay requests revisit immutable snapshots as the editor scrolls. */
const MAX_COMPILER_PARAMETER_INLAY_HINT_CACHE_DOCUMENTS = 8;
/* Bound the occasional directive-hover scan over accepted header linker inputs. */
const MAX_COMPILER_HEADER_LIBRARY_HOVER_FACTS = 10000;
/* Bound source-documentation association by comment count, lines, and output size. */
const MAX_COMPILER_SOURCE_DOCUMENTATION_COMMENTS = 100000;
const MAX_COMPILER_SOURCE_DOCUMENTATION_LINES = 24;
const MAX_COMPILER_SOURCE_DOCUMENTATION_CHARACTERS = 4096;
const MAX_COMPILER_SOURCE_DOCUMENTATION_TOTAL_CHARACTERS = 4 * 1024 * 1024;
/* Do not spend unbounded work on a malformed or unusually large argument list. */
const MAX_COMPILER_PARAMETER_INLAY_ARGUMENTS = 256;
const MAX_COMPILER_PARAMETER_INLAY_SCAN_CHARACTERS = 4 * 1024 * 1024;
const MAX_COMPILER_PROCEDURE_CODE_LENSES = 5000;
const MAX_COMPILER_PROCEDURE_REFERENCE_SITES = 20000;
/* Expression hovers need only a small conflict set; oversized groups fail closed. */
const MAX_COMPILER_EXPRESSION_CONSTANT_FACTS = 64;
const MAX_COMPILER_WIDE_LITERAL_HOVER_FACTS = 100000;
/* FBC bounds exported target-wide prefixes to one Mi-unit payload. */
const MAX_COMPILER_WIDE_LITERAL_PREFIX_UNITS = 1_048_576;
const MAX_COMPILER_WIDE_LITERAL_PREVIEW_UNITS = 8;
/* Physical literal expressions should not need a large per-line lookup span. */
const MAX_COMPILER_WIDE_LITERAL_RANGE_LINES = 64;
/* Keep cursor lookup bounded on generated or unusually dense source lines. */
const MAX_COMPILER_WIDE_LITERAL_HOVER_CANDIDATES_PER_LINE = 2048;
const MAX_COMPILER_SELECT_CASE_HOVER_FACTS = 100000;
const MAX_COMPILER_SELECT_CASE_HOVER_CANDIDATES_PER_LINE = 2048;
const MAX_COMPILER_SELECT_CASE_RANGE_LINES = 64;
const MAX_COMPILER_RUNTIME_MACRO_HOVER_FACTS = 100000;
const MAX_COMPILER_RUNTIME_MACRO_HOVER_FACTS_PER_LINE = 2048;
const MAX_COMPILER_DEFINED_PROBE_RANGE_LINES = 64;
const MAX_COMPILER_DEFINED_PROBE_INDEX_ENTRIES = 1000000;
const MAX_COMPILER_DEFINED_PROBE_CANDIDATES_PER_LINE = 2048;
const MAX_COMPILER_CONDITIONAL_RANGE_LINES = 64;
const MAX_COMPILER_CONDITIONAL_INDEX_ENTRIES = 1000000;
const MAX_COMPILER_CONDITIONAL_CANDIDATES_PER_LINE = 2048;
const MAX_COMPILER_MACRO_SIGNATURES_PER_LINE = 2048;
const MAX_COMPILER_MACRO_SIGNATURE_SOURCE_LINE = 65536;
const COMPILER_WIDE_LITERAL_PROPERTY_NAMES = new Set([
    "literal-target-wide-unit-bytes", "literal-target-wide-kind", "literal-target-wide-prefix"
]);
/* FB_SYMBCLASS_VAR from the compiler bridge symbol graph. */
const COMPILER_VARIABLE_SYMBOL_CLASS = 1;

function compilerPathKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compilerParameterDeclarationLocation(model, entries, name) {
    // Candidates must already belong to the compiler-selected procedure.
    // Check the physical spelling before turning a projected token into a link.
    const locations = new Map();
    for (const entry of entries) {
        const declaration = entry.declaration;
        const filePath = entry.uri?.fsPath;
        if (declaration?.type !== "parameter" || normalizeIdentifier(declaration.name) !== normalizeIdentifier(name) ||
            entry.uri?.scheme !== "file" || typeof filePath !== "string" || !path.isAbsolute(filePath) ||
            filePath.includes("\0") || entry.provisional || declaration.provisional ||
            !Number.isSafeInteger(declaration.line) || declaration.line < 0 ||
            !Number.isSafeInteger(declaration.startColumn) || declaration.startColumn < 0 ||
            !Number.isSafeInteger(declaration.endColumn) || declaration.endColumn <= declaration.startColumn) continue;
        const source = model.getDocument(entry.uri);
        if (!source || declaration.line >= source.lineOffsets.length) continue;
        const start = source.lineOffsets[declaration.line];
        const end = source.lineOffsets[declaration.line + 1] ?? source.text.length;
        const line = source.text.slice(start, end).replace(/[\r\n]+$/, "");
        if (declaration.endColumn > line.length ||
            normalizeIdentifier(line.slice(declaration.startColumn, declaration.endColumn)) !== normalizeIdentifier(name)) continue;
        const location = { filePath, line: declaration.line,
            startColumn: declaration.startColumn, endColumn: declaration.endColumn };
        locations.set(JSON.stringify(location), location);
        if (locations.size > 1) return null;
    }
    return locations.size === 1 ? locations.values().next().value : null;
}

function compilerSidecarLogicalStatementOffset(document, statement, offset) {
    if (!document || !statement || typeof statement.visibleText !== "string" ||
        !Array.isArray(document.lineOffsets) || typeof document.text !== "string" ||
        !Number.isSafeInteger(statement.startLine) || statement.startLine < 0 ||
        !Number.isSafeInteger(offset) || offset < 0) return null;
    const logicalLines = statement.visibleText.split("\n");
    let remaining = offset;
    for (let index = 0; index < logicalLines.length; index++) {
        const logicalLine = logicalLines[index];
        if (remaining <= logicalLine.length) {
            const line = statement.startLine + index;
            if (line < 0 || line >= document.lineOffsets.length) return null;
            const lineStart = document.lineOffsets[line];
            const lineEnd = document.lineOffsets[line + 1] ?? document.text.length;
            const sourceLine = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
            const marker = logicalLine.trim();
            if (!marker) return null;
            const markerStart = sourceLine.indexOf(marker);
            if (markerStart < 0 || sourceLine.indexOf(marker, markerStart + 1) >= 0) return null;
            const leadingWhitespace = logicalLine.length - logicalLine.trimStart().length;
            const segmentStart = markerStart - leadingWhitespace;
            if (segmentStart < 0 || segmentStart + logicalLine.length > sourceLine.length) return null;
            return lineStart + segmentStart + remaining;
        }
        remaining -= logicalLine.length + 1;
    }
    return null;
}

function compilerSidecarDeclarationEquals(text, start) {
    let parentheses = 0;
    let brackets = 0;
    for (let index = Math.max(0, start); index < text.length; index++) {
        const character = text[index];
        if (character === "(") parentheses++;
        else if (character === ")") parentheses = Math.max(0, parentheses - 1);
        else if (character === "[") brackets++;
        else if (character === "]") brackets = Math.max(0, brackets - 1);
        else if (character === "=" && parentheses === 0 && brackets === 0 &&
            text[index + 1] !== ">" && !["=", "<", ">"].includes(text[index - 1] || "")) return index;
    }
    return -1;
}

function compilerSidecarMultilineInitializerRange(document, parsed, declaration) {
    if (!document || !Array.isArray(parsed?.statements) || !declaration ||
        !Number.isSafeInteger(declaration.line) || !Number.isSafeInteger(declaration.endLine) ||
        declaration.endLine <= declaration.line || !Number.isSafeInteger(declaration.startColumn) ||
        declaration.startColumn < 0 || typeof declaration.name !== "string" || !declaration.name) return null;
    const declarationOffset = positionOffset(document, declaration.line, declaration.startColumn);
    if (!Number.isSafeInteger(declarationOffset)) return null;
    const matches = [];
    for (const statement of parsed.statements) {
        if (declaration.line < statement.startLine || declaration.line > statement.endLine ||
            statement.endLine !== declaration.endLine || typeof statement.maskedText !== "string") continue;
        let searchOffset = 0;
        while (searchOffset < statement.maskedText.length) {
            const nameOffset = statement.maskedText.indexOf(declaration.name, searchOffset);
            if (nameOffset < 0) break;
            const previous = statement.maskedText[nameOffset - 1] || "";
            const next = statement.maskedText[nameOffset + declaration.name.length] || "";
            searchOffset = nameOffset + declaration.name.length;
            if (/[A-Za-z0-9_]/.test(previous) || /[A-Za-z0-9_]/.test(next)) continue;
            const physicalNameOffset = compilerSidecarLogicalStatementOffset(document, statement, nameOffset);
            if (physicalNameOffset === declarationOffset) matches.push({ statement, nameOffset });
        }
    }
    if (matches.length !== 1) return null;

    const { statement, nameOffset } = matches[0];
    const equalsOffset = compilerSidecarDeclarationEquals(
        statement.maskedText, nameOffset + declaration.name.length
    );
    if (equalsOffset < 0) return null;
    const initializerText = typeof declaration.initializer === "string" ? declaration.initializer : "";
    let logicalStart = -1;
    let logicalEnd = -1;
    if (initializerText) {
        logicalStart = statement.visibleText.indexOf(initializerText, equalsOffset + 1);
        if (logicalStart < 0) return null;
        logicalEnd = logicalStart + initializerText.length;
    } else if (declaration.type === "const") {
        let parentheses = 0;
        let brackets = 0;
        logicalEnd = statement.visibleText.length;
        for (let index = equalsOffset + 1; index < statement.maskedText.length; index++) {
            const character = statement.maskedText[index];
            if (character === "(") parentheses++;
            else if (character === ")") parentheses = Math.max(0, parentheses - 1);
            else if (character === "[") brackets++;
            else if (character === "]") brackets = Math.max(0, brackets - 1);
            else if (character === "," && parentheses === 0 && brackets === 0) {
                logicalEnd = index;
                break;
            }
        }
        logicalStart = equalsOffset + 1;
        while (/\s/.test(statement.visibleText[logicalStart] || "")) logicalStart++;
        while (logicalEnd > logicalStart && /\s/.test(statement.visibleText[logicalEnd - 1])) logicalEnd--;
    }
    if (logicalStart < 0 || logicalEnd <= logicalStart) return null;

    const start = compilerSidecarLogicalStatementOffset(document, statement, logicalStart);
    const end = compilerSidecarLogicalStatementOffset(document, statement, logicalEnd);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start ? { start, end } : null;
}

function bindingToken(binding, byLine, allowNumeric = false) {
    const lineTokens = byLine.get(binding.line) || [];
    const start = lineTokens.findIndex((candidate) => candidate.startColumn === binding.startColumn);
    const matched = [];
    if (start >= 0) {
        for (let index = start; index < lineTokens.length && lineTokens[index].startColumn < binding.endColumn; index++) matched.push(lineTokens[index]);
    }
    const spelling = matched.map((candidate) => candidate.name).join("");
    if (allowNumeric && matched.length === 1 && matched[0].kind === "number" &&
        matched[0].startColumn === binding.startColumn && matched[0].endColumn === binding.endColumn &&
        spelling.toLowerCase() === binding.name.toLowerCase()) return matched[0];
    const qualified = matched.length % 2 === 1 && matched.every((candidate, index) => index % 2 === 0
        ? candidate.kind === "identifier"
        : candidate.name === ".");
    const first = matched[0];
    const last = matched.at(-1);
    if (!qualified || !first || !last || first.startColumn !== binding.startColumn || last.endColumn !== binding.endColumn || spelling.toLowerCase() !== binding.name.toLowerCase()) return null;
    /* The compiler trace records a qualified spelling as one binding. Editor
       tokens remain separate, and declarations are owned by the terminal
       identifier, so resolution is anchored there after full-span validation. */
    return last;
}

function hasRecoveredSourceToken(document, startOffset, endOffset) {
    const tokens = document.tokens;
    let low = 0, high = tokens.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (tokens[middle].end <= startOffset) low = middle + 1;
        else high = middle;
    }
    for (let index = low; index < tokens.length && tokens[index].offset < endOffset; index++) {
        if (document.recoveryTokenOffsets.has(tokens[index].offset)) return true;
    }
    return false;
}

function overlapsRecoveryErrorLine(errorLines, startLine, endLine) {
    if (!errorLines) return false;
    for (const line of errorLines) if (line >= startLine && line <= endLine) return true;
    return false;
}

function semanticSiteKey(filePath, line, startColumn, endColumn) {
    return `${compilerPathKey(filePath)}:${line}:${startColumn}:${endColumn}`;
}

function addSemanticSiteIdentity(sites, key, identity) {
    const identities = sites.get(key) || new Set();
    identities.add(identity);
    sites.set(key, identities);
}

function semanticPropertyInteger(value, minimum = 0) {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function compilerWideLiteralPropertyIndex(properties, capabilities) {
    const availableModules = new Set((capabilities || [])
        .filter((capability) => capability.coverage === "available" &&
            ["target-wide-literal-prefixes", "c-target-wide-literal-prefixes"].includes(capability.feature))
        .map((capability) => capability.module));
    const grouped = new Map();
    let propertyCount = 0;

    for (const property of properties || []) {
        if (property.domain !== "symbol" || !COMPILER_WIDE_LITERAL_PROPERTY_NAMES.has(property.name)) continue;
        propertyCount++;
        if (propertyCount > MAX_COMPILER_WIDE_LITERAL_HOVER_FACTS) return null;
        if (!Number.isSafeInteger(property.module) || property.module < 1 ||
            !Number.isSafeInteger(property.identity) || property.identity < 1) continue;
        const key = `${property.module}:${property.identity}`;
        let group = grouped.get(key);
        if (!group) {
            group = { module: property.module, values: new Map(), invalid: false };
            grouped.set(key, group);
        }
        if (property.provisional === true || typeof property.value !== "string") {
            group.invalid = true;
            continue;
        }
        const values = group.values.get(property.name) || new Set();
        values.add(property.value);
        group.values.set(property.name, values);
    }

    const indexed = new Map();
    for (const [key, group] of grouped) {
        if (group.invalid || !availableModules.has(group.module)) continue;
        const singleValue = (name) => {
            const values = group.values.get(name);
            return values?.size === 1 ? values.values().next().value : null;
        };
        const unitBytes = semanticPropertyInteger(singleValue("literal-target-wide-unit-bytes"), 1);
        const kind = singleValue("literal-target-wide-kind");
        const prefix = singleValue("literal-target-wide-prefix");
        if (![1, 2, 4].includes(unitBytes) || !["terminated", "unterminated"].includes(kind) ||
            typeof prefix !== "string" || prefix.length > MAX_COMPILER_WIDE_LITERAL_PREFIX_UNITS * 8 ||
            prefix.length % 8 !== 0 || !/^(?:[0-9A-F]{8})*$/.test(prefix)) continue;

        const unitCount = prefix.length / 8;
        if (unitCount > MAX_COMPILER_WIDE_LITERAL_PREFIX_UNITS) continue;
        const unitMaximum = unitBytes === 4 ? 0xFFFFFFFF : 2 ** (unitBytes * 8) - 1;
        const units = [];
        let validPreview = true;
        for (let index = 0; index < Math.min(unitCount, MAX_COMPILER_WIDE_LITERAL_PREVIEW_UNITS); index++) {
            const unit = prefix.slice(index * 8, index * 8 + 8);
            const value = Number.parseInt(unit, 16);
            if (value === 0 || value > unitMaximum) {
                validPreview = false;
                break;
            }
            units.push(unit.slice(-unitBytes * 2));
        }
        if (!validPreview) continue;
        indexed.set(key, { unitBytes, kind, unitCount, units });
    }
    return indexed;
}

function compilerSelectCaseLoweringIndex(properties, capabilities) {
    const availableModules = new Set((capabilities || [])
        .filter((capability) => capability.feature === "select-case-lowering-inputs" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    const groups = new Map();
    let propertyCount = 0;

    for (const property of properties || []) {
        if (property.domain !== "symbol" || typeof property.name !== "string") continue;
        const constructProperty = /^select-case-(input|table|end):([1-9]\d*)$/.exec(property.name);
        const comparisonProperty = /^select-case-comparison:[1-9]\d*:[1-9]\d*:[1-9]\d*$/.test(property.name);
        if (!constructProperty && !comparisonProperty) continue;
        propertyCount++;
        if (propertyCount > MAX_COMPILER_SELECT_CASE_HOVER_FACTS) return null;
        if (!Number.isSafeInteger(property.module) || property.module < 1 ||
            !Number.isSafeInteger(property.identity) || property.identity < 1) continue;
        const valueFields = typeof property.value === "string" ? property.value.split("\t") : [];
        const construct = constructProperty
            ? Number(constructProperty[2])
            : semanticPropertyInteger(valueFields[0], 1);
        if (!Number.isSafeInteger(construct) || construct < 1) continue;
        const key = `${property.module}:${property.identity}:${construct}`;
        let group = groups.get(key);
        if (!group) {
            group = { module: property.module, construct, values: new Map(), comparisons: new Map(), invalid: false };
            groups.set(key, group);
        }
        if (property.provisional === true || typeof property.value !== "string") {
            group.invalid = true;
            continue;
        }
        if (comparisonProperty) {
            if (valueFields.length < 4 || semanticPropertyInteger(valueFields[0], 1) !== construct ||
                semanticPropertyInteger(valueFields[1], 1) === null || !["jump", "fallthrough"].includes(valueFields[2])) {
                group.invalid = true;
                continue;
            }
            const values = group.comparisons.get(property.name) || new Set();
            values.add(property.value);
            group.comparisons.set(property.name, values);
            continue;
        }
        const values = group.values.get(constructProperty[1]) || new Set();
        values.add(property.value);
        group.values.set(constructProperty[1], values);
    }

    const summariesByExpression = new Map();
    for (const group of groups.values()) {
        if (group.invalid || !availableModules.has(group.module)) continue;
        const singleValue = (name) => {
            const values = group.values.get(name);
            return values?.size === 1 ? values.values().next().value : null;
        };
        const input = singleValue("input")?.split("\t");
        const end = singleValue("end")?.split("\t");
        const table = singleValue("table")?.split("\t");
        if (!input || input.length !== 4 || !end || end.length !== 2) continue;
        const statement = semanticPropertyInteger(input[0], 1);
        const expression = semanticPropertyInteger(input[1], 1);
        const selector = semanticPropertyInteger(input[2], 1);
        const clauses = semanticPropertyInteger(end[0], 1);
        const hasElse = end[1];
        if (!statement || !expression || !selector || !["normal", "constant"].includes(input[3]) || !clauses ||
            !["0", "1"].includes(hasElse)) continue;
        let summary;
        if (input[3] === "constant") {
            if (!table || table.length !== 5) continue;
            const dtype = semanticPropertyInteger(table[0], 1);
            const storage = semanticPropertyInteger(table[1], 1);
            const span = semanticPropertyInteger(table[3]);
            const entries = semanticPropertyInteger(table[4]);
            if (!dtype || !storage || span === null || span >= 256 || entries === null || entries < 1 || entries > 255) continue;
            summary = { kind: "jump-table", entries, slots: span + 1 };
        } else {
            if (table) continue;
            let comparisonCount = 0;
            let comparisonsValid = true;
            for (const values of group.comparisons.values()) {
                if (values.size !== 1) {
                    comparisonsValid = false;
                    break;
                }
                comparisonCount++;
            }
            if (!comparisonsValid || comparisonCount < 1) continue;
            summary = { kind: "comparisons", count: comparisonCount };
        }
        const expressionKey = `${group.module}:${expression}`;
        const summaries = summariesByExpression.get(expressionKey) || new Map();
        summaries.set(JSON.stringify(summary), summary);
        summariesByExpression.set(expressionKey, summaries);
    }
    const indexed = new Map([...summariesByExpression]
        .filter(([, summaries]) => summaries.size === 1)
        .map(([key, summaries]) => [key, summaries.values().next().value]));
    return indexed;
}

function compilerRuntimeMacroHoverIndex(operations, operationsById, sources) {
    const sourceUrisByPath = new Map([...sources.values()]
        .filter((source) => typeof source.uri.fsPath === "string" && source.uri.fsPath)
        .map((source) => [compilerPathKey(source.uri.fsPath), source.uri]));
    const indexed = new Map();
    let operationCount = 0;

    for (const operation of operations || []) {
        if (operation.family !== "runtime-macro" || operation.physical !== true ||
            typeof operation.filePath !== "string" || !Number.isSafeInteger(operation.startLine) ||
            !Number.isSafeInteger(operation.startColumn) || !Number.isSafeInteger(operation.endLine) ||
            !Number.isSafeInteger(operation.endColumn) || operation.startLine < 1 || operation.startColumn < 0 ||
            operation.endLine !== operation.startLine || operation.endColumn <= operation.startColumn) continue;
        const uri = sourceUrisByPath.get(compilerPathKey(operation.filePath));
        const document = uri && sources.get(uri.toString());
        const operationFact = operationsById.get(operation.identity);
        if (!document || !operationFact) continue;
        const line = operation.startLine - 1;
        if (line < 0 || line >= document.lineOffsets.length) continue;
        const lineStart = document.lineOffsets[line];
        const lineEnd = document.lineOffsets[line + 1] ?? document.text.length;
        const lineLength = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "").length;
        if (operation.endColumn > lineLength) continue;

        operationCount++;
        if (operationCount > MAX_COMPILER_RUNTIME_MACRO_HOVER_FACTS) return null;
        const sourceKey = uri.toString();
        let lines = indexed.get(sourceKey);
        if (!lines) {
            lines = new Map();
            indexed.set(sourceKey, lines);
        }
        let records = lines.get(line);
        if (records === null) continue;
        if (!records) records = [];
        const signature = JSON.stringify([
            operation.family, operation.operator, operation.startColumn, operation.endColumn,
            operationFact.leftTypeName, operationFact.rightTypeName, operationFact.resultTypeName,
            operationFact.operatorKind
        ]);
        let record = records.find((candidate) => candidate.startColumn === operation.startColumn &&
            candidate.endColumn === operation.endColumn);
        if (!record) {
            record = { startColumn: operation.startColumn, endColumn: operation.endColumn, summaries: new Map() };
            records.push(record);
        }
        record.summaries.set(signature, {
            typeName: operationFact.resultTypeName || "",
            operatorKind: operationFact.operatorKind || "none",
            provisional: false,
            sourceOperation: operationFact
        });
        if (records.length > MAX_COMPILER_RUNTIME_MACRO_HOVER_FACTS_PER_LINE) lines.set(line, null);
        else lines.set(line, records);
    }

    for (const lines of indexed.values()) {
        for (const [line, records] of lines) {
            if (!Array.isArray(records)) continue;
            lines.set(line, records.map((record) => ({
                startColumn: record.startColumn,
                endColumn: record.endColumn,
                fact: record.summaries.size === 1 ? record.summaries.values().next().value : null
            })).sort((first, second) => first.startColumn - second.startColumn || first.endColumn - second.endColumn));
        }
    }
    return indexed;
}

function sourcePositionAtOffset(document, offset) {
    let low = 0, high = document.lineOffsets.length;
    while (low + 1 < high) {
        const middle = (low + high) >> 1;
        if (document.lineOffsets[middle] <= offset) low = middle;
        else high = middle;
    }
    return { line: low, character: offset - document.lineOffsets[low] };
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

function sourceParameterDocumentation(documentation, parameterName) {
    if (typeof documentation !== "string" || documentation.length > MAX_COMPILER_SOURCE_DOCUMENTATION_CHARACTERS ||
        typeof parameterName !== "string" || !parameterName) return "";
    const wantedName = normalizeIdentifier(parameterName);
    const lines = documentation.split(/\r?\n/);
    const tags = [];
    const parameterTag = /^\s*[@\\]param(?:\s*\[[^\]]+\])?\s+([A-Za-z_][A-Za-z0-9_.$%!#&]*)\s*(?:[-:]\s*)?(.*)$/i;
    for (let index = 0; index < lines.length; index++) {
        const match = parameterTag.exec(lines[index]);
        if (match && normalizeIdentifier(match[1]) === wantedName) tags.push({ index, firstLine: match[2] });
    }
    if (tags.length !== 1) return "";

    const selected = tags[0];
    const description = [selected.firstLine];
    for (let index = selected.index + 1; index < lines.length; index++) {
        if (/^\s*[@\\][A-Za-z]/.test(lines[index])) break;
        description.push(lines[index].trim());
    }
    const result = description.join("\n").trim();
    return result.length <= MAX_COMPILER_SOURCE_DOCUMENTATION_CHARACTERS ? result : "";
}

function freeBasicCallArgumentRanges(document, openingToken, checkCancelled, remainingCharacters) {
    /* Bare callers pass a compiler-bound callee instead of an opening bracket.
       This scanner finds written argument boundaries, not callable identities. */
    const bare = openingToken.bare === true;
    const closingFor = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
    const openingFor = new Map([...closingFor].map(([opening, closing]) => [closing, opening]));
    const stack = bare ? [] : [")"];
    const arguments_ = [];
    let segmentStart = openingToken.end;
    const addArgument = (end) => {
        // A continued segment starts at its value, not the continuation marker.
        const continuation = document.text.slice(segmentStart, end).match(/^\s*_[ \t]*(?:'[^\r\n]*)?\r?\n/);
        if (continuation) segmentStart += continuation[0].length;
        const masked = document.masked.slice(segmentStart, end);
        const raw = document.text.slice(segmentStart, end);
        const leadingWhitespace = raw.search(/\S/);
        const startsWithString = leadingWhitespace >= 0 && (raw[leadingWhitespace] === '"' ||
            raw.startsWith('!"', leadingWhitespace));
        if (!masked.trim()) {
            if (startsWithString) {
                arguments_.push({ start: segmentStart + leadingWhitespace, end, named: false });
            } else {
                arguments_.push(null);
            }
            return;
        }
        const firstCode = startsWithString ? leadingWhitespace : masked.search(/\S/);
        const named = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*=/i.test(masked);
        arguments_.push({ start: segmentStart + firstCode, end, named });
    };

    let scanned = 0;
    const finish = (offset) => {
        if (arguments_.length || document.masked.slice(segmentStart, offset).trim() ||
            document.text.slice(segmentStart, offset).trim()) addArgument(offset);
        return { arguments: arguments_, scanned, exceeded: false };
    };
    for (let offset = openingToken.end; offset < document.masked.length; offset++) {
        if ((scanned & 255) === 0) checkCancelled();
        if (++scanned > remainingCharacters) return { arguments: null, scanned, exceeded: true };
        const character = document.masked[offset];
        if (bare && !stack.length) {
            if (character === ":") {
                if (document.masked[offset + 1] === "=") return { arguments: null, scanned, exceeded: false };
                return finish(offset);
            }
            if ((character === "e" || character === "E") && /^else\b/i.test(document.masked.slice(offset, offset + 5)) &&
                /\s/.test(document.masked[offset - 1] || "")) return finish(offset);
            if (character === "\n" || character === "\r") {
                const lineStart = Math.max(document.masked.lastIndexOf("\n", offset - 1),
                    document.masked.lastIndexOf("\r", offset - 1)) + 1;
                if (!/(?:^|[ \t])_[ \t]*$/.test(document.masked.slice(lineStart, offset))) return finish(offset);
                if (character === "\r" && document.masked[offset + 1] === "\n") offset++;
            }
        }
        if (closingFor.has(character)) {
            stack.push(closingFor.get(character));
            continue;
        }
        if (openingFor.has(character)) {
            if (stack.at(-1) !== character) return { arguments: null, scanned, exceeded: false };
            stack.pop();
            if (!bare && !stack.length) return finish(offset);
            continue;
        }
        if (character === "," && stack.length === (bare ? 0 : 1)) {
            addArgument(offset);
            if (arguments_.length >= MAX_COMPILER_PARAMETER_INLAY_ARGUMENTS) return { arguments: null, scanned, exceeded: true };
            segmentStart = offset + 1;
        }
    }
    if (bare && !stack.length) return finish(document.masked.length);
    return { arguments: null, scanned, exceeded: false };
}

/* FBC's native symbol use proves a REM spelling is code even when -pp has
   normalized OPTION NOKEYWORD and omitted its operand from the output text. */
function compilerNativeRemIdentifierOffsets(text, analysis) {
    if (!Array.isArray(analysis.symbolGraph?.uses)) return [];
    const invalidLines = new Set(analysis.invalidLines || []);
    const lines = text.split(/\r\n|\n|\r/);
    const lineOffsets = [0];
    for (const match of text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
    const offsets = new Set();
    for (const binding of analysis.symbolGraph.uses) {
        if (offsets.size >= MAX_COMPILER_REM_IDENTIFIER_OVERRIDES) return [];
        if (normalizeTypeName(binding.name) !== "rem" || !Number.isSafeInteger(binding.line) ||
            binding.line < 0 || binding.line >= lines.length || invalidLines.has(binding.line) ||
            !Number.isSafeInteger(binding.startColumn) ||
            binding.startColumn < 0 || !Number.isSafeInteger(binding.endColumn) ||
            binding.endColumn - binding.startColumn !== 3) continue;
        const line = lines[binding.line];
        if (line.slice(binding.startColumn, binding.endColumn).toLowerCase() !== "rem") continue;
        offsets.add(lineOffsets[binding.line] + binding.startColumn);
    }
    return [...offsets];
}

/* Direct B ranges keep physical token projection aligned when the local
   scanner would otherwise consume an FBC-bound REM as the rest of a comment. */
function compilerPhysicalRemIdentifierOffsetsByFile(sources, semanticBindings) {
    const offsetsByFile = new Map();
    if (!Array.isArray(semanticBindings) || semanticBindings.length > MAX_COMPILER_REM_IDENTIFIER_OVERRIDES) return offsetsByFile;
    const sourcesByPath = new Map();
    for (const source of sources) {
        const filePath = source.uri?.fsPath || source.uri?.path;
        if (typeof filePath === "string" && path.isAbsolute(filePath)) {
            sourcesByPath.set(compilerPathKey(filePath), source);
        }
    }
    const lineOffsetsByFile = new Map();
    for (let index = 0; index < semanticBindings.length; index++) {
        const binding = semanticBindings[index];
        if (binding?.physical !== true || normalizeTypeName(binding.name) !== "rem" ||
            typeof binding.filePath !== "string" || !path.isAbsolute(binding.filePath) ||
            !Number.isSafeInteger(binding.startLine) || binding.startLine !== binding.endLine ||
            binding.startLine < 1 || !Number.isSafeInteger(binding.startColumn) || binding.startColumn < 0 ||
            !Number.isSafeInteger(binding.endColumn) || binding.endColumn - binding.startColumn !== 3) continue;
        const fileKey = compilerPathKey(binding.filePath);
        const source = sourcesByPath.get(fileKey);
        if (!source) continue;
        let lineOffsets = lineOffsetsByFile.get(fileKey);
        if (!lineOffsets) {
            lineOffsets = [0];
            for (const match of source.text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
            lineOffsetsByFile.set(fileKey, lineOffsets);
        }
        const line = binding.startLine - 1;
        if (line >= lineOffsets.length) continue;
        const markerLength = line === 0 && source.text.startsWith("\uFEFF") ? 1 : 0;
        const start = lineOffsets[line] + binding.startColumn + markerLength;
        if (source.text.slice(start, start + 3).toLowerCase() !== "rem") continue;
        const offsets = offsetsByFile.get(fileKey) || new Set();
        offsets.add(start);
        offsetsByFile.set(fileKey, offsets);
    }
    return new Map([...offsetsByFile].map(([filePath, offsets]) => [filePath, [...offsets]]));
}

function compilerPhysicalEscapedStringRangesByFile(sources, semanticRanges) {
    const rangesByFile = new Map();
    if (!Array.isArray(semanticRanges) || semanticRanges.length > MAX_COMPILER_ESCAPED_STRING_RANGES) return rangesByFile;
    const sourcesByPath = new Map();
    for (const source of sources) {
        const filePath = source.uri?.fsPath || source.uri?.path;
        if (typeof filePath === "string" && path.isAbsolute(filePath)) {
            sourcesByPath.set(compilerPathKey(filePath), source);
        }
    }
    const lineOffsetsByFile = new Map();
    for (const range of semanticRanges) {
        if (typeof range?.filePath !== "string" || !path.isAbsolute(range.filePath) ||
            !Number.isSafeInteger(range.startLine) || range.startLine < 0 ||
            !Number.isSafeInteger(range.startColumn) || range.startColumn < 0 ||
            !Number.isSafeInteger(range.endLine) || range.endLine < range.startLine ||
            !Number.isSafeInteger(range.endColumn) || range.endColumn < 0) continue;
        const fileKey = compilerPathKey(range.filePath);
        const source = sourcesByPath.get(fileKey);
        if (!source || typeof source.text !== "string") continue;
        let lineOffsets = lineOffsetsByFile.get(fileKey);
        if (!lineOffsets) {
            lineOffsets = [0];
            for (const match of source.text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
            lineOffsetsByFile.set(fileKey, lineOffsets);
        }
        if (range.startLine >= lineOffsets.length || range.endLine >= lineOffsets.length) continue;
        const markerLength = (line) => line === 0 && source.text.startsWith("\uFEFF") ? 1 : 0;
        const lineLength = (line) => {
            const start = lineOffsets[line];
            const next = lineOffsets[line + 1] ?? source.text.length;
            return source.text.slice(start, next).replace(/[\r\n]+$/, "").length - markerLength(line);
        };
        if (range.startColumn > lineLength(range.startLine) || range.endColumn > lineLength(range.endLine)) continue;
        const start = lineOffsets[range.startLine] + markerLength(range.startLine) + range.startColumn;
        const end = lineOffsets[range.endLine] + markerLength(range.endLine) + range.endColumn;
        if (start < 0 || end <= start || end > source.text.length) continue;
        const ranges = rangesByFile.get(fileKey) || [];
        if (ranges.length >= MAX_COMPILER_ESCAPED_STRING_RANGES) return new Map();
        ranges.push({ start, end });
        rangesByFile.set(fileKey, ranges);
    }
    for (const [filePath, ranges] of rangesByFile) {
        ranges.sort((first, second) => first.start - second.start || first.end - second.end);
        const merged = [];
        for (const range of ranges) {
            const previous = merged.at(-1);
            if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
            else merged.push(range);
        }
        rangesByFile.set(filePath, merged);
    }
    return rangesByFile;
}

function compilerModuleScopeIsClosed(analysis) {
    if (analysis.completion?.reachedEnd !== true) return false;
    if (!analysis.partial) return true;
    if (!Array.isArray(analysis.scopeGraph?.scopes) || analysis.scopeGraph.scopes.some((scope) =>
        scope.recovered !== false || scope.endSerial === undefined)) return false;
    const errors = analysis.errorPositions || [];
    if (!errors.length || errors.length !== analysis.completion.errorCount) return false;
    const pending = new Map(errors.map((error) => [error.serial, error]));
    if (pending.size !== errors.length) return false;
    /* EOF inside an unfinished macro can leave every lexical scope closed.
       Require each error to belong to an observed physical parser line, not
       an unpositioned preprocessor failure attached to the previous output. */
    for (const token of analysis.tokenOrigins || []) {
        const error = pending.get(token.serial);
        if (!error || token.kind !== "source" || token.sourceMap !== 0) continue;
        const origin = analysis.origins?.[token.start.line];
        if (!origin || origin.generated || origin.line !== error.sourceLine ||
            compilerPathKey(origin.filePath) !== compilerPathKey(error.sourceFile)) continue;
        pending.delete(token.serial);
        if (!pending.size) return true;
    }
    return false;
}

class CompilerSemanticModel {
    constructor(expandedUri, analysis, sources) {
        const invalidLines = new Set(analysis.invalidLines || []);
        const validText = analysis.text.split("\n").map((line, index) => invalidLines.has(index) ? " ".repeat(line.length) : line).join("\n");
        this.partial = Boolean(analysis.partial);
        this.compilerModuleScopeClosed = compilerModuleScopeIsClosed(analysis);
        this.compilerModuleFilePath = analysis.dependencies?.[0] || "";
        this.compilerModuleFinalEpoch = analysis.preprocessorGraph?.epochs;
        this.semanticSidecarOnly = Boolean(analysis.semanticSidecarOnly);
        this.semanticFoldingRanges = analysis.semanticFoldingRanges || null;
        this.semanticImplicitCalls = analysis.semanticImplicitCalls || [];
        this.semanticTemporaryConstructions = analysis.semanticTemporaryConstructions || [];
        this.semanticProcedures = analysis.semanticProcedures || [];
        this.compilerPrimitiveTypesByFile = new Map();
        this.compilerPrimitiveTypesByFileLine = new Map();
        if (!this.partial) for (const input of analysis.semanticPrimitiveTypeInputs || []) {
            const key = compilerPathKey(input.filePath), inputs = this.compilerPrimitiveTypesByFile.get(key) || [];
            inputs.push(input);
            this.compilerPrimitiveTypesByFile.set(key, inputs);
            const lines = this.compilerPrimitiveTypesByFileLine.get(key) || new Map();
            const lineInputs = lines.get(input.startLine - 1) || [];
            lineInputs.push(input);
            lines.set(input.startLine - 1, lineInputs);
            this.compilerPrimitiveTypesByFileLine.set(key, lines);
        }
        this.compilerProcedurePointerTypesBySymbol = new Map();
        for (const type of analysis.semanticProcedurePointerTypes || []) {
            const previous = this.compilerProcedurePointerTypesBySymbol.get(type.symbol);
            this.compilerProcedurePointerTypesBySymbol.set(type.symbol,
                previous === undefined || previous === type.typeName ? type.typeName : null);
        }
        this.semanticOperations = analysis.semanticOperations || [];
        this.semanticMemoryApplications = analysis.semanticMemoryApplications || [];
        const remIdentifierOffsets = compilerNativeRemIdentifierOffsets(validText, analysis);
        this.inner = new FreeBasicSemanticModel([{ uri: expandedUri,
            parsed: parseFreeBasicText(validText, remIdentifierOffsets) }]);
        this.expandedUri = expandedUri;
        this.sources = new Map();
        this.compilerSourceDocumentsByPath = new Map();
        this.compilerMacroDeclarationsByFile = new Map();
        this.compilerSelectionExpressionsByLine = new Map();
        this.compilerParameterInlayHintCache = new Map();
        this.sourceToExpanded = new Map();
        this.expandedToSource = new Map();
        this.recoverySourceToExpanded = new Map();
        this.recoveryExpandedToSource = new Map();
        this.sourceEpochs = new Map();
        /* Exact physical B ranges are safe in trace-free complete sidecars too. */
        const physicalRemOffsetsByFile = this.partial
            ? new Map()
            : compilerPhysicalRemIdentifierOffsetsByFile(sources, analysis.semanticBindings);
        this.compilerPhysicalRemIdentifierOffsetsByFile = physicalRemOffsetsByFile;
        this.compilerPhysicalEscapedStringRangesByFile =
            compilerPhysicalEscapedStringRangesByFile(sources, analysis.semanticEscapedStringRanges);
        const expanded = this.inner.getDocument(expandedUri);
        this.compilerUnevaluatedRanges = [];
        const unevaluated = (analysis.unevaluatedRanges || []).map((region) => ({
            start: positionOffset(expanded, region.start.line, region.start.character),
            end: positionOffset(expanded, region.end.line, region.end.character)
        })).sort((left, right) => left.start - right.start || left.end - right.end);
        // Nested query scopes share one interval index. Hierarchy sites use
        // expanded coordinates so repeated macro arguments retain each role.
        for (const region of unevaluated) {
            const previous = this.compilerUnevaluatedRanges.at(-1);
            if (previous && region.start <= previous.end) previous.end = Math.max(previous.end, region.end);
            else this.compilerUnevaluatedRanges.push(region);
        }
        if (analysis.protocolVersion >= 8) this.inventory = installNativeInventory(this.inner, analysis);
        const byLine = new Map();
        for (const token of expanded.tokens) {
            const list = byLine.get(token.line) || [];
            list.push(token);
            byLine.set(token.line, list);
        }
        this.bindProcedures(analysis, expanded, byLine);
        this.bindNativeSymbols(analysis, expanded, byLine);
        if (this.inventory) this.inner.members = (receivers, document, scope) => this.nativeMembers(receivers, scope);
        this.expressionGraph = analysis.expressionGraph || { nodes: [] };
        const syntaxNodes = new Map(this.expressionGraph.nodes.filter((node) => node.kind === "syntax").map((node) => [`${node.start.line}:${node.start.character}:${node.end.line}:${node.end.character}`, node]));
        const expressions = new Map();
        for (const expression of analysis.expressions || []) {
            const native = syntaxNodes.get(`${expression.start.line}:${expression.start.character}:${expression.end.line}:${expression.end.character}`);
            if (native?.invalid) continue;
            const start = positionOffset(expanded, expression.start.line, expression.start.character);
            const end = positionOffset(expanded, expression.end.line, expression.end.character);
            /* The recovery decoder propagates invalidity through the native
               expression graph. A separate bad statement must not make an
               independent expression look uncertain. Missing graph evidence
               remains conservative, so older or incomplete traces cannot be
               presented as authoritative after an error. */
            const provisional = this.partial && (!native || native.provisional);
            expressions.set(`${start}:${end}`, { ...expression, compilerExpressionId: native?.id || 0, provisional, startOffset: start, endOffset: end });
        }
        this.expressionsByRange = expressions;
        this.expressions = [...expressions.values()].sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
        this.expressionsById = new Map(this.expressions
            .filter((expression) => expression.compilerExpressionId)
            .map((expression) => [expression.compilerExpressionId, expression]));
        this.receivers = new Map((analysis.receivers || []).map((receiver) => [positionOffset(expanded, receiver.start.line, receiver.start.character), receiver]));
        this.recoveryCompletionReceivers = new Map();
        for (const receiver of analysis.completionReceivers || []) {
            const lineStart = expanded.lineOffsets[receiver.start.line];
            let offset = positionOffset(expanded, receiver.start.line, receiver.start.character);
            /* Index the receipt immediately after its member operator, before
               optional whitespace, without retaining a second expanded text. */
            while (offset > lineStart && /[\t ]/.test(analysis.text[offset - 1])) offset--;
            const group = this.recoveryCompletionReceivers.get(offset) || [];
            group.push(receiver);
            this.recoveryCompletionReceivers.set(offset, group);
        }
        this.semanticExpressionOperands = analysis.semanticExpressionOperands || [];
        this.semanticDiagnostics = analysis.semanticDiagnostics || [];
        this.semanticTypeBases = analysis.semanticTypeBases || [];
        this.semanticTypeSymbols = analysis.semanticTypeSymbols || [];
        this.semanticSymbolTypes = analysis.semanticSymbolTypes || [];
        this.compilerIncludeOutcomes = analysis.semanticIncludeOutcomes || [];
        const semanticPreprocessorFacts = analysis.semanticPreprocessorFacts || {};
        this.compilerSkippedRegions = semanticPreprocessorFacts.skippedRegions || [];
        this.compilerMacroDefinitionsById = new Map((semanticPreprocessorFacts.macroSignatureFacts?.definitions || [])
            .map((definition) => [definition.id, definition]));
        this.compilerMacroDefinitionSitesById = new Map();
        for (const site of semanticPreprocessorFacts.macroSignatureFacts?.definitionSites || []) {
            const sites = this.compilerMacroDefinitionSitesById.get(site.definition) || [];
            sites.push(site);
            this.compilerMacroDefinitionSitesById.set(site.definition, sites);
        }
        this.compilerMacroParametersByDefinition = new Map();
        for (const parameter of semanticPreprocessorFacts.macroSignatureFacts?.parameters || []) {
            const parameters = this.compilerMacroParametersByDefinition.get(parameter.definition) || [];
            parameters.push(parameter);
            this.compilerMacroParametersByDefinition.set(parameter.definition, parameters);
        }
        for (const parameters of this.compilerMacroParametersByDefinition.values()) {
            parameters.sort((first, second) => first.ordinal - second.ordinal);
        }
        this.compilerMacroInvocationsBySourceLine = new Map();
        for (const invocation of semanticPreprocessorFacts.macroSignatureFacts?.invocations || []) {
            if (!invocation.filePath || !Number.isSafeInteger(invocation.startLine) || invocation.startLine < 1 ||
                invocation.startLine !== invocation.endLine || !Number.isSafeInteger(invocation.startColumn) ||
                invocation.startColumn < 0 || !Number.isSafeInteger(invocation.endColumn) ||
                invocation.endColumn <= invocation.startColumn) continue;
            const sourceKey = compilerPathKey(invocation.filePath);
            const invocationsByLine = this.compilerMacroInvocationsBySourceLine.get(sourceKey) || new Map();
            const line = invocation.startLine - 1;
            const candidates = invocationsByLine.get(line) || [];
            if (!Array.isArray(candidates) || candidates.length >= MAX_COMPILER_MACRO_SIGNATURES_PER_LINE) {
                invocationsByLine.set(line, null);
            } else {
                candidates.push(invocation);
                invocationsByLine.set(line, candidates);
            }
            this.compilerMacroInvocationsBySourceLine.set(sourceKey, invocationsByLine);
        }
        const conditionalBranches = new Map((semanticPreprocessorFacts.conditionalBranches || [])
            .map((branch) => [branch.id, branch]));
        this.compilerConditionalDecisionsBySourceLine = new Map();
        const conditionalIndexEntries = new Map();
        const disabledConditionalFiles = new Set();
        for (const decision of semanticPreprocessorFacts.conditionalDecisions || []) {
            const branch = conditionalBranches.get(decision.id);
            if (decision.physical !== true || !decision.filePath || branch?.physical !== true ||
                branch.filePath !== decision.filePath || !Number.isSafeInteger(branch.startLine) || branch.startLine < 1 ||
                !Number.isSafeInteger(branch.endLine) || branch.endLine !== branch.startLine ||
                !Number.isSafeInteger(branch.endColumn) || branch.endColumn < 0 ||
                !Number.isSafeInteger(decision.endLine) || decision.endLine < branch.startLine ||
                !Number.isSafeInteger(decision.endColumn) || decision.endColumn < 0) continue;
            const startLine = branch.startLine;
            const startColumn = branch.endColumn;
            const endLine = decision.endLine;
            const endColumn = decision.endColumn;
            if (endLine === startLine && endColumn <= startColumn) continue;
            const lineCount = endLine - startLine + 1;
            if (lineCount > MAX_COMPILER_CONDITIONAL_RANGE_LINES) continue;
            const sourceKey = compilerPathKey(decision.filePath);
            if (disabledConditionalFiles.has(sourceKey)) continue;
            const decisionsByLine = this.compilerConditionalDecisionsBySourceLine.get(sourceKey) || new Map();
            const totalEntries = conditionalIndexEntries.get(sourceKey) || 0;
            if (totalEntries + lineCount > MAX_COMPILER_CONDITIONAL_INDEX_ENTRIES) {
                this.compilerConditionalDecisionsBySourceLine.set(sourceKey, null);
                disabledConditionalFiles.add(sourceKey);
                continue;
            }
            let indexed = true;
            for (let line = startLine - 1; line < endLine; line++) {
                const candidates = decisionsByLine.get(line) || [];
                if (!Array.isArray(candidates) || candidates.length >= MAX_COMPILER_CONDITIONAL_CANDIDATES_PER_LINE) {
                    decisionsByLine.set(line, null);
                    indexed = false;
                    continue;
                }
                candidates.push({ decision, directive: branch.kind, startLine, startColumn, endLine, endColumn });
                decisionsByLine.set(line, candidates);
            }
            conditionalIndexEntries.set(sourceKey, totalEntries + lineCount);
            if (indexed || !this.compilerConditionalDecisionsBySourceLine.has(sourceKey)) {
                this.compilerConditionalDecisionsBySourceLine.set(sourceKey, decisionsByLine);
            }
        }
        this.compilerDefinedNameProbesBySourceLine = new Map();
        const definedProbeIndexEntries = new Map();
        const disabledDefinedProbeFiles = new Set();
        for (const probe of semanticPreprocessorFacts.definedNameProbes || []) {
            if (probe.physical !== true || !probe.filePath || typeof probe.spelling !== "string" || !probe.spelling ||
                typeof probe.defined !== "boolean" || !Number.isSafeInteger(probe.startLine) || probe.startLine < 1 ||
                !Number.isSafeInteger(probe.endLine) || probe.endLine < probe.startLine ||
                !Number.isSafeInteger(probe.startColumn) || probe.startColumn < 0 ||
                !Number.isSafeInteger(probe.endColumn) || probe.endColumn < 0 ||
                probe.endLine === probe.startLine && probe.endColumn <= probe.startColumn) continue;
            const lineCount = probe.endLine - probe.startLine + 1;
            if (lineCount > MAX_COMPILER_DEFINED_PROBE_RANGE_LINES) continue;
            const sourceKey = compilerPathKey(probe.filePath);
            if (disabledDefinedProbeFiles.has(sourceKey)) continue;
            const probesByLine = this.compilerDefinedNameProbesBySourceLine.get(sourceKey) || new Map();
            const totalEntries = definedProbeIndexEntries.get(sourceKey) || 0;
            if (totalEntries + lineCount > MAX_COMPILER_DEFINED_PROBE_INDEX_ENTRIES) {
                this.compilerDefinedNameProbesBySourceLine.set(sourceKey, null);
                disabledDefinedProbeFiles.add(sourceKey);
                continue;
            }
            let indexed = true;
            for (let line = probe.startLine - 1; line < probe.endLine; line++) {
                const candidates = probesByLine.get(line) || [];
                if (!Array.isArray(candidates) || candidates.length >= MAX_COMPILER_DEFINED_PROBE_CANDIDATES_PER_LINE) {
                    probesByLine.set(line, null);
                    indexed = false;
                    continue;
                }
                candidates.push(probe);
                probesByLine.set(line, candidates);
            }
            definedProbeIndexEntries.set(sourceKey, totalEntries + lineCount);
            if (indexed || !this.compilerDefinedNameProbesBySourceLine.has(sourceKey)) {
                this.compilerDefinedNameProbesBySourceLine.set(sourceKey, probesByLine);
            }
        }
        const expressionTypeIds = new Set();
        const usableSemanticExpressionOperands = this.semanticExpressionOperands.filter((operation) =>
            operation.inputCoverageAvailable !== false
        );
        for (const operation of usableSemanticExpressionOperands) {
            if (operation.physical !== true) continue;
            if (Number.isSafeInteger(operation.identity) && operation.identity > 0) expressionTypeIds.add(operation.identity);
            if (Number.isSafeInteger(operation.left) && operation.left > 0) expressionTypeIds.add(operation.left);
            if (Number.isSafeInteger(operation.right) && operation.right > 0) expressionTypeIds.add(operation.right);
        }
        const expressionTypeNamesById = new Map();
        const expressionOperatorKindsById = new Map();
        for (const expression of analysis.semanticExpressions || []) {
            if (!expressionTypeIds.has(expression.id)) continue;
            if (typeof expression.typeName === "string") expressionTypeNamesById.set(expression.id, expression.typeName);
            if (["builtin", "overloaded", "none"].includes(expression.operatorKind)) {
                expressionOperatorKindsById.set(expression.id, expression.operatorKind);
            }
            expressionTypeIds.delete(expression.id);
        }
        const expressionTypeName = (identity) => expressionTypeNamesById.get(identity) || "";
        const semanticExpressionOperandsById = new Map(usableSemanticExpressionOperands.map((operation) => [
            operation.identity,
            operation.physical === true ? {
                ...operation,
                leftTypeName: expressionTypeName(operation.left),
                rightTypeName: expressionTypeName(operation.right),
                resultTypeName: expressionTypeName(operation.identity),
                operatorKind: expressionOperatorKindsById.get(operation.identity) || "none"
            } : operation
        ]));
        const remDisabledLinesByFile = new Map();
        const remOptions = analysis.compilerRemKeywordDisableOptions;
        if (Array.isArray(remOptions) && remOptions.length <= MAX_COMPILER_REM_IDENTIFIER_OVERRIDES) {
            for (const option of remOptions) {
                if (!option || typeof option.filePath !== "string" || !path.isAbsolute(option.filePath) ||
                    !Number.isSafeInteger(option.line) || option.line < 1) continue;
                const key = compilerPathKey(option.filePath);
                const lines = remDisabledLinesByFile.get(key) || [];
                lines.push(option.line);
                remDisabledLinesByFile.set(key, lines);
            }
        }
        for (const source of sources) {
            const filePath = source.uri?.fsPath || source.uri?.path;
            const sourceKey = typeof filePath === "string" && path.isAbsolute(filePath) ? compilerPathKey(filePath) : "";
            const remIdentifierOffsets = sourceKey ? physicalRemOffsetsByFile.get(sourceKey) || [] : [];
            const defaultEscapedStringRanges = sourceKey
                ? this.compilerPhysicalEscapedStringRangesByFile.get(sourceKey) || []
                : [];
            const lexical = tokenize(source.text, remIdentifierOffsets, defaultEscapedStringRanges,
                remDisabledLinesByFile.get(sourceKey));
            const document = {
                ...lexical,
                uri: source.uri,
                text: source.text,
                defaultEscapedStringRanges,
                entriesByOffset: new Map()
            };
            document.byLine = new Map();
            for (const token of lexical.tokens) {
                const list = document.byLine.get(token.line) || [];
                list.push(token);
                document.byLine.set(token.line, list);
            }
            document.hasLineDirectives = /^\s*#line\b/im.test(source.text);
            this.sources.set(source.uri.toString(), document);
            const sourcePath = source.uri.fsPath || source.uri.path;
            if (typeof sourcePath === "string" && path.isAbsolute(sourcePath)) {
                const sourceKey = compilerPathKey(sourcePath);
                const previous = this.compilerSourceDocumentsByPath.get(sourceKey);
                if (previous && previous.text !== document.text) {
                    this.compilerSourceDocumentsByPath.set(sourceKey, null);
                } else if (!this.compilerSourceDocumentsByPath.has(sourceKey)) {
                    this.compilerSourceDocumentsByPath.set(sourceKey, document);
                }
            }
            if (analysis.protocolVersion >= 9) continue;
            for (const [line, origin] of analysis.origins.entries()) {
                if (!origin || origin.filePath !== source.uri.fsPath || origin.generated || document.hasLineDirectives) continue;
                const originalTokens = document.byLine.get(origin.line) || [];
                const expandedTokens = byLine.get(line) || [];
                /* A full lexical match avoids guessing columns through expansions,
                   continued lines, or the compiler's rewritten literal spelling. */
                if (!originalTokens.length || originalTokens.length !== expandedTokens.length) continue;
                if (originalTokens.some((token, index) => token.key !== expandedTokens[index].key)) continue;
                for (let index = 0; index < originalTokens.length; index++) {
                    const original = originalTokens[index];
                    const token = expandedTokens[index];
                    const key = `${source.uri}:${original.offset}`;
                    const matches = this.sourceToExpanded.get(key) || [];
                    matches.push(token);
                    this.sourceToExpanded.set(key, matches);
                    this.expandedToSource.set(token.offset, { uri: source.uri, occurrence: original });
                }
            }
        }
        if (analysis.protocolVersion >= 9) projectNativeTokens(this, analysis.tokenOrigins, expanded, analysis.macroGraph, analysis.text, analysis.physicalSourceByteOffsets);
        this.compilerRequiresCallProjection = this.procedureBindings.some((binding) => {
            if (binding.kind !== "call" || this.isUnevaluatedExpandedOffset(binding.token.offset)) return false;
            const physical = this.expandedToSource.get(binding.token.offset);
            return !physical || physical.fromMacroDefinition === true;
        });
        for (const document of this.sources.values()) {
            document.recoveryTokenOffsets = new Set(document.tokens
                .filter((token) => this.recoverySourceToExpanded.has(`${document.uri}:${token.offset}`))
                .map((token) => token.offset));
        }
        this.recoveredNativeReferenceOffsets = new Map();
        const recoveredSymbols = new Set(analysis.recoverySymbols || []);
        if (recoveredSymbols.size) {
            /* Expression nodes can retain an authoritative dtype while losing
               the variable child that established it. Keep a source-projected
               reference index so recovery taint can follow that missing edge
               without making unrelated expressions provisional. */
            for (const binding of this.nativeBindings) {
                const symbol = this.canonicalSymbolIds.get(binding.id) || binding.id;
                if (binding.kind !== "reference" || !recoveredSymbols.has(symbol)) continue;
                const physical = this.expandedToSource.get(binding.token.offset);
                if (!physical) continue;
                const key = physical.uri.toString();
                const offsets = this.recoveredNativeReferenceOffsets.get(key) || [];
                offsets.push({ start: binding.token.offset, end: binding.token.end });
                this.recoveredNativeReferenceOffsets.set(key, offsets);
            }
            for (const offsets of this.recoveredNativeReferenceOffsets.values()) offsets.sort((first, second) => first.start - second.start);
        }
        this.compilerDirectiveExpressions = new Map();
        this.compilerSidecarExpressions = new Map();
        this.compilerSidecarAmbiguousRanges = new Map();
        this.compilerSidecarAmbiguousFacts = new Map();
        this.semanticSourceContexts = new Map((analysis.semanticSourceContexts || [])
            .map((sourceContext) => [sourceContext.id, sourceContext]));
        this.semanticCallArgumentInputs = [];
        if (!this.partial && Array.isArray(analysis.semanticCallArgumentInputs) &&
            analysis.semanticCallArgumentInputs.length <= MAX_COMPILER_SELECTED_CALL_ARGUMENT_INPUTS) {
            const sourceByPath = new Map();
            for (const source of this.sources.values()) {
                const filePath = source.uri.fsPath || source.uri.path;
                if (typeof filePath === "string" && path.isAbsolute(filePath)) {
                    sourceByPath.set(compilerPathKey(filePath), source);
                }
            }
            const inputsByRange = new Map();
            for (const input of analysis.semanticCallArgumentInputs) {
                if (typeof input?.filePath !== "string" || !path.isAbsolute(input.filePath) ||
                    !Number.isSafeInteger(input.procedureSymbol) || input.procedureSymbol < 1 ||
                    !Number.isSafeInteger(input.parameterOrdinal) || input.parameterOrdinal < 0 ||
                    !Number.isSafeInteger(input.line) || input.line < 0 ||
                    !Number.isSafeInteger(input.startColumn) || input.startColumn < 0 ||
                    !Number.isSafeInteger(input.endLine) || input.endLine < input.line ||
                    !Number.isSafeInteger(input.endColumn) || input.endColumn < 0 ||
                    typeof input.parameterName !== "string" ||
                    !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(input.parameterName) ||
                    !["byval", "byref", "bydesc"].includes(input.passingMode)) continue;
                const source = sourceByPath.get(compilerPathKey(input.filePath));
                if (!source) continue;
                const startOffset = semanticSourceColumnOffset(source, input.line, input.startColumn);
                const endOffset = semanticSourceColumnOffset(source, input.endLine, input.endColumn);
                if (startOffset === null || endOffset === null || endOffset <= startOffset) continue;
                const record = {
                    ...input,
                    startOffset,
                    endOffset
                };
                const key = `${source.uri}:${startOffset}:${endOffset}`;
                const signature = JSON.stringify([
                    input.procedureSymbol, input.parameterOrdinal,
                    input.parameterName.toLowerCase(), input.passingMode
                ]);
                const previous = inputsByRange.get(key);
                if (previous === undefined) inputsByRange.set(key, { signature, record });
                else if (previous && previous.signature !== signature) inputsByRange.set(key, null);
            }
            this.semanticCallArgumentInputs = [...inputsByRange.values()]
                .filter(Boolean)
                .map((entry) => entry.record);
        }
        const semanticArrayStorageInputs = analysis.semanticArrayStorageInputs || [];
        const arrayStorageSymbolIds = new Set();
        const assignmentTargetSymbolIds = new Set();
        if (!this.partial && Array.isArray(semanticArrayStorageInputs) &&
            semanticArrayStorageInputs.length <= MAX_COMPILER_ARRAY_STORAGE_HOVER_FACTS) {
            for (const input of semanticArrayStorageInputs) {
                if (Number.isSafeInteger(input?.symbol) && input.symbol > 0) arrayStorageSymbolIds.add(input.symbol);
            }
        }
        if (!this.partial && Array.isArray(analysis.semanticAssignmentTargets) &&
            analysis.semanticAssignmentTargets.length <= MAX_COMPILER_ASSIGNMENT_HOVER_FACTS) {
            for (const target of analysis.semanticAssignmentTargets) {
                if (Number.isSafeInteger(target?.targetSymbolId) && target.targetSymbolId > 0) {
                    assignmentTargetSymbolIds.add(target.targetSymbolId);
                }
            }
        }
        const semanticSymbolNames = new Map();
        if (arrayStorageSymbolIds.size || assignmentTargetSymbolIds.size) {
            const sourceByPath = new Map([...this.sources.values()]
                .map((source) => [compilerPathKey(source.uri.fsPath), source]));
            for (const binding of analysis.semanticBindings || []) {
                if (binding.role !== "declaration" || binding.physical !== true ||
                    !Number.isSafeInteger(binding.symbol) ||
                    !arrayStorageSymbolIds.has(binding.symbol) && !assignmentTargetSymbolIds.has(binding.symbol) ||
                    typeof binding.filePath !== "string" || !binding.filePath ||
                    !Number.isSafeInteger(binding.startLine) || binding.startLine < 1 ||
                    !Number.isSafeInteger(binding.startColumn) || binding.startColumn < 0 ||
                    binding.endLine !== binding.startLine || !Number.isSafeInteger(binding.endColumn) ||
                    binding.endColumn <= binding.startColumn) continue;
                const source = sourceByPath.get(compilerPathKey(binding.filePath));
                const line = binding.startLine - 1;
                if (!source || line >= source.lineOffsets.length) continue;
                const start = positionOffset(source, line, binding.startColumn);
                const end = positionOffset(source, line, binding.endColumn);
                if (end <= start) continue;
                const name = source.text.slice(start, end);
                if (!name || name.length > MAX_COMPILER_ARRAY_STORAGE_NAME_LENGTH ||
                    /[\r\n\x00-\x1f\x7f`]/.test(name)) continue;
                const key = `${binding.symbol}`;
                const names = semanticSymbolNames.get(key) || new Map();
                names.set(normalizeIdentifier(name), name);
                semanticSymbolNames.set(key, names);
            }
        }
        const arrayStorageSelectionsByModuleExpression = new Map();
        if (arrayStorageSymbolIds.size) {
            for (const input of semanticArrayStorageInputs) {
                if (!input || input.provisional || !Number.isSafeInteger(input.module) || input.module < 1 ||
                    !Number.isSafeInteger(input.expression) || input.expression < 1 ||
                    !Number.isSafeInteger(input.symbol) || input.symbol < 1 ||
                    !["field", "variable"].includes(input.kind)) continue;
                const names = semanticSymbolNames.get(`${input.symbol}`);
                if (!names || names.size !== 1) continue;
                const name = names.values().next().value;
                if (!name || name.length > MAX_COMPILER_ARRAY_STORAGE_NAME_LENGTH) continue;
                const key = `${input.module}:${input.expression}`;
                const selection = { kind: input.kind, name, symbolIds: [input.symbol] };
                if (!arrayStorageSelectionsByModuleExpression.has(key)) {
                    arrayStorageSelectionsByModuleExpression.set(key, selection);
                } else {
                    const previous = arrayStorageSelectionsByModuleExpression.get(key);
                    if (!previous || previous.kind !== selection.kind || previous.name !== selection.name) {
                        arrayStorageSelectionsByModuleExpression.set(key, null);
                    } else {
                        previous.symbolIds = [...new Set([...previous.symbolIds, ...selection.symbolIds])];
                    }
                }
            }
        }
        const arrayStorageSelectionsByModuleRange = new Map();
        if (arrayStorageSelectionsByModuleExpression.size) {
            for (const expression of analysis.semanticExpressions || []) {
                const sourceContext = this.semanticSourceContexts.get(expression.sourceContextId);
                const selection = sourceContext && arrayStorageSelectionsByModuleExpression.get(
                    `${sourceContext.module}:${expression.id}`
                );
                if (!selection || expression.physical !== true || !expression.filePath ||
                    !Number.isSafeInteger(expression.startLine) || !Number.isSafeInteger(expression.startColumn) ||
                    !Number.isSafeInteger(expression.endLine) || !Number.isSafeInteger(expression.endColumn)) continue;
                const key = [sourceContext.module, compilerPathKey(expression.filePath), expression.startLine,
                    expression.startColumn, expression.endLine, expression.endColumn].join(":");
                if (!arrayStorageSelectionsByModuleRange.has(key)) {
                    arrayStorageSelectionsByModuleRange.set(key, selection);
                } else {
                    const previous = arrayStorageSelectionsByModuleRange.get(key);
                    if (!previous || previous.kind !== selection.kind || previous.name !== selection.name) {
                        arrayStorageSelectionsByModuleRange.set(key, null);
                    } else {
                        previous.symbolIds = [...new Set([...previous.symbolIds, ...selection.symbolIds])];
                    }
                }
            }
        }
        this.compilerTargetWideLiteralFactsByModuleSymbol = this.partial
            ? null
            : compilerWideLiteralPropertyIndex(analysis.semanticProperties, analysis.semanticCapabilities);
        this.compilerSelectCaseLoweringFactsByModuleExpression = this.partial
            ? null
            : compilerSelectCaseLoweringIndex(analysis.semanticProperties, analysis.semanticCapabilities);
        const semanticIifInputsByResult = new Map();
        if (!this.partial) {
            for (const input of analysis.semanticIifInputs || []) {
                if (!Number.isSafeInteger(input.result) || input.result < 1 ||
                    [input.conditionTypeName, input.trueTypeName, input.falseTypeName, input.resultTypeName]
                        .some((name) => typeof name !== "string" || !name || name.length > 512 || /[\x00-\x1f\x7f`]/.test(name))) continue;
                const signature = JSON.stringify([
                    normalizeTypeName(input.conditionTypeName), normalizeTypeName(input.trueTypeName),
                    normalizeTypeName(input.falseTypeName), normalizeTypeName(input.resultTypeName)
                ]);
                const previous = semanticIifInputsByResult.get(input.result);
                if (!previous) semanticIifInputsByResult.set(input.result, { signature, input });
                else if (previous.signature !== signature) semanticIifInputsByResult.set(input.result, null);
            }
            for (const [identity, record] of semanticIifInputsByResult) {
                semanticIifInputsByResult.set(identity, record?.input || null);
            }
        }
        const semanticAssignmentTargetsByResult = new Map();
        if (!this.partial) {
            for (const target of analysis.semanticAssignmentTargets || []) {
                if (!Number.isSafeInteger(target.identity) || target.identity < 1 ||
                    !["destination", "initializer", "return", "function-result-assignment"].includes(target.kind) ||
                    (typeof target.targetTypeName === "string" &&
                        (typeof target.sourceTypeName !== "string" || !target.targetTypeName ||
                            !target.sourceTypeName || target.targetTypeName.length > 512 ||
                            target.sourceTypeName.length > 512)) ||
                    typeof target.targetTypeName !== "string" &&
                        (!Number.isSafeInteger(target.targetSymbolId) || target.targetSymbolId < 1)) continue;
                const names = Number.isSafeInteger(target.targetSymbolId)
                    ? semanticSymbolNames.get(`${target.targetSymbolId}`)
                    : null;
                const targetName = names?.size === 1 ? names.values().next().value : "";
                if (typeof target.targetTypeName !== "string" && !targetName) continue;
                const signature = JSON.stringify([
                    target.kind,
                    typeof target.targetTypeName === "string" ? normalizeTypeName(target.targetTypeName) : "",
                    typeof target.sourceTypeName === "string" ? normalizeTypeName(target.sourceTypeName) : "",
                    targetName
                ]);
                const fact = targetName ? { ...target, targetName } : target;
                const previous = semanticAssignmentTargetsByResult.get(target.identity);
                if (!previous) semanticAssignmentTargetsByResult.set(target.identity, { signature, target: fact });
                else if (previous.signature !== signature) semanticAssignmentTargetsByResult.set(target.identity, null);
                else if ((previous.target.targetName || "") !== (fact.targetName || "")) {
                    const targetWithoutAmbiguousName = { ...previous.target };
                    delete targetWithoutAmbiguousName.targetName;
                    semanticAssignmentTargetsByResult.set(target.identity, {
                        signature,
                        target: targetWithoutAmbiguousName
                    });
                }
            }
            for (const [identity, record] of semanticAssignmentTargetsByResult) {
                semanticAssignmentTargetsByResult.set(identity, record?.target || null);
            }
        }
        const semanticArrayIndexInputsByExpression = new Map();
        if (!this.partial) {
            for (const input of analysis.semanticArrayIndexInputs || []) {
                if (!Number.isSafeInteger(input.expression) || input.expression < 1 ||
                    [input.sourceTypeName, input.targetTypeName].some((name) =>
                        typeof name !== "string" || !name || name.length > 512)) continue;
                const signature = JSON.stringify([
                    normalizeTypeName(input.sourceTypeName), normalizeTypeName(input.targetTypeName)
                ]);
                const previous = semanticArrayIndexInputsByExpression.get(input.expression);
                if (!previous) semanticArrayIndexInputsByExpression.set(input.expression, { signature, input });
                else if (previous.signature !== signature) semanticArrayIndexInputsByExpression.set(input.expression, null);
            }
            for (const [identity, record] of semanticArrayIndexInputsByExpression) {
                semanticArrayIndexInputsByExpression.set(identity, record?.input || null);
            }
        }
        const selectedNumericOperandsByResult = new Map();
        if (!this.partial) {
            for (const selection of analysis.semanticSelectedNumericOperands || []) {
                if (!Number.isSafeInteger(selection.result) || selection.result < 1 ||
                    [selection.selectedLeftTypeName, selection.selectedRightTypeName].some((name) =>
                        typeof name !== "string" || !name || name.length > 512)) continue;
                const signature = JSON.stringify([
                    normalizeTypeName(selection.selectedLeftTypeName),
                    normalizeTypeName(selection.selectedRightTypeName)
                ]);
                const previous = selectedNumericOperandsByResult.get(selection.result);
                if (!previous) selectedNumericOperandsByResult.set(selection.result, { signature, selection });
                else if (previous.signature !== signature) selectedNumericOperandsByResult.set(selection.result, null);
            }
            for (const [identity, record] of selectedNumericOperandsByResult) {
                selectedNumericOperandsByResult.set(identity, record?.selection || null);
            }
        }
        const semanticSizeQueryInputsByResult = new Map();
        if (!this.partial) {
            for (const input of analysis.semanticSizeQueryInputs || []) {
                if (!Number.isSafeInteger(input.result) || input.result < 1 ||
                    !["expression", "array"].includes(input.inputKind) ||
                    typeof input.inputTypeName !== "string" || !input.inputTypeName ||
                    input.inputTypeName.length > 512) continue;
                const signature = JSON.stringify([input.inputKind, normalizeTypeName(input.inputTypeName)]);
                const previous = semanticSizeQueryInputsByResult.get(input.result);
                if (!previous) semanticSizeQueryInputsByResult.set(input.result, { signature, input });
                else if (previous.signature !== signature) semanticSizeQueryInputsByResult.set(input.result, null);
            }
            for (const [identity, record] of semanticSizeQueryInputsByResult) {
                semanticSizeQueryInputsByResult.set(identity, record?.input || null);
            }
        }
        const semanticArrayBoundQueriesByResult = new Map();
        if (!this.partial) {
            for (const input of analysis.semanticArrayBoundQueries || []) {
                if (!Number.isSafeInteger(input.result) || input.result < 1 ||
                    !["lower", "upper"].includes(input.kind) ||
                    typeof input.sourceTypeName !== "string" || !input.sourceTypeName ||
                    input.sourceTypeName.length > 512) continue;
                const signature = JSON.stringify([
                    input.kind, normalizeTypeName(input.sourceTypeName), input.selectedValue
                ]);
                const previous = semanticArrayBoundQueriesByResult.get(input.result);
                if (!previous) semanticArrayBoundQueriesByResult.set(input.result, { signature, input });
                else if (previous.signature !== signature) semanticArrayBoundQueriesByResult.set(input.result, null);
            }
            for (const [identity, record] of semanticArrayBoundQueriesByResult) {
                semanticArrayBoundQueriesByResult.set(identity, record?.input || null);
            }
        }
        this.compilerDirectiveExpressionsByRange = new Map();
        this.compilerSidecarExpressionsByRange = new Map();
        const recoverySidecar = this.partial && analysis.semanticModelRecovery === true;
        if (!this.partial || recoverySidecar) {
            /* C expression values refer to E identities; keep only identities
               that also have a physical source range in this snapshot. */
            const physicalExpressionIds = new Set((analysis.semanticExpressions || [])
                .filter((expression) => expression.physical === true && Number.isSafeInteger(expression.id) && expression.id > 0)
                .map((expression) => expression.id));
            const compilerExpressionConstantsById = new Map();
            const incompleteExpressionConstantIds = new Set();
            for (const constant of analysis.semanticConstants || []) {
                if (constant.domain !== "expression" || !Number.isSafeInteger(constant.identity) ||
                    !physicalExpressionIds.has(constant.identity) || incompleteExpressionConstantIds.has(constant.identity) ||
                    typeof constant.value !== "string") continue;
                const values = compilerExpressionConstantsById.get(constant.identity) || new Map();
                const key = `${constant.kind}:${constant.value}`;
                if (values.has(key)) continue;
                if (values.size >= MAX_COMPILER_EXPRESSION_CONSTANT_FACTS) {
                    compilerExpressionConstantsById.delete(constant.identity);
                    incompleteExpressionConstantIds.add(constant.identity);
                    continue;
                }
                values.set(key, { kind: constant.kind, value: constant.value });
                compilerExpressionConstantsById.set(constant.identity, values);
            }
            const sourceByPath = new Map(sources.map((source) => [compilerPathKey(source.uri.fsPath), source]));
            const errorLinesByPath = new Map();
            for (const error of analysis.errorPositions || []) {
                const key = compilerPathKey(error.sourceFile);
                const errorLines = errorLinesByPath.get(key) || new Set();
                errorLines.add(error.sourceLine);
                errorLinesByPath.set(key, errorLines);
            }
            for (const expression of analysis.semanticExpressions || []) {
                if (!expression.physical || !expression.typeName) continue;
                const source = sourceByPath.get(compilerPathKey(expression.filePath));
                const document = source && this.sources.get(source.uri.toString());
                const lineStart = expression.startLine - 1;
                const lineEnd = expression.endLine - 1;
                if (!document || lineStart < 0 || lineStart >= document.lineOffsets.length ||
                    lineEnd < lineStart || lineEnd >= document.lineOffsets.length) continue;
                const lineLength = (line) => {
                    const offset = document.lineOffsets[line];
                    const next = document.lineOffsets[line + 1] ?? document.text.length;
                    return document.text.slice(offset, next).replace(/[\r\n]+$/, "").length;
                };
                if (expression.startColumn > lineLength(lineStart) || expression.endColumn > lineLength(lineEnd)) continue;
                const start = positionOffset(document, lineStart, expression.startColumn);
                const end = positionOffset(document, lineEnd, expression.endColumn);
                if (end <= start) continue;
                if (recoverySidecar && overlapsRecoveryErrorLine(
                    errorLinesByPath.get(compilerPathKey(expression.filePath)), lineStart, lineEnd)) continue;
                if (recoverySidecar && hasRecoveredSourceToken(document, start, end)) continue;
                const lineOffset = document.lineOffsets[lineStart];
                const nextOffset = document.lineOffsets[lineStart + 1] ?? document.text.length;
                const lineText = document.text.slice(lineOffset, nextOffset).replace(/[\r\n]+$/, "");
                const sourceContext = this.semanticSourceContexts.get(expression.sourceContextId);
                const storageRangeKey = sourceContext ? [sourceContext.module, compilerPathKey(expression.filePath),
                    expression.startLine, expression.startColumn, expression.endLine, expression.endColumn].join(":") : "";
                const arrayStorageSelection = expression.physical === true && sourceContext
                    ? arrayStorageSelectionsByModuleRange.get(storageRangeKey)
                    : null;
                const targetWideLiteral = expression.physical === true && sourceContext &&
                    normalizeTypeName(expression.typeName) === "wstring"
                    ? this.compilerTargetWideLiteralFactsByModuleSymbol?.get(
                        `${sourceContext.module}:${expression.symbol}`
                    )
                    : null;
                const selectCaseLowering = expression.physical === true && sourceContext
                    ? this.compilerSelectCaseLoweringFactsByModuleExpression?.get(
                        `${sourceContext.module}:${expression.id}`
                    )
                    : null;
                const compilerIifInputs = semanticIifInputsByResult.get(expression.id) || null;
                const compilerAssignmentTarget = semanticAssignmentTargetsByResult.get(expression.id) || null;
                const compilerArrayIndex = semanticArrayIndexInputsByExpression.get(expression.id) || null;
                const compilerNumericOperands = selectedNumericOperandsByResult.get(expression.id) || null;
                const compilerSizeQuery = semanticSizeQueryInputsByResult.get(expression.id) || null;
                const compilerArrayBoundQuery = semanticArrayBoundQueriesByResult.get(expression.id) || null;
                const fact = {
                    ...expression,
                    /* Sidecar identities belong to the compiler's export graph,
                       not to the native trace graph used by this model. Keep
                       type spelling for lookup, but never mix those IDs. */
                    symbol: 0,
                    subtype: 0,
                    start: { line: lineStart, character: expression.startColumn },
                    end: { line: expression.endLine - 1, character: expression.endColumn },
                    startOffset: start,
                    endOffset: end,
                    compilerExpressionId: 0,
                    compilerSidecarExpressionId: expression.id,
                    compilerSidecarSymbolId: expression.symbol || 0,
                    compilerSidecarSubtypeId: expression.subtype,
                    ...(incompleteExpressionConstantIds.has(expression.id)
                        ? { compilerConstantFactsIncomplete: true }
                        : compilerExpressionConstantsById.has(expression.id)
                            ? { compilerConstantValues: [...compilerExpressionConstantsById.get(expression.id).values()] }
                            : {}),
                    semanticSource: recoverySidecar ? "compiler-sidecar-recovery" : "compiler-sidecar",
                    ...(targetWideLiteral ? { targetWideLiteral } : {}),
                    ...(selectCaseLowering ? { selectCaseLowering } : {}),
                    ...(compilerIifInputs ? { compilerIifInputs } : {}),
                    ...(compilerAssignmentTarget ? { compilerAssignmentTarget } : {}),
                    ...(compilerArrayIndex ? { compilerArrayIndex } : {}),
                    ...(compilerNumericOperands ? { compilerNumericOperands } : {}),
                    ...(compilerSizeQuery ? { compilerSizeQuery } : {}),
                    ...(compilerArrayBoundQuery ? { compilerArrayBoundQuery } : {}),
                    ...(arrayStorageSelection ? { arrayStorageSelection } : {}),
                    ...(semanticExpressionOperandsById.has(expression.id)
                        ? { sourceOperation: semanticExpressionOperandsById.get(expression.id) }
                        : {}),
                    provisional: recoverySidecar
                };
                const sourceKey = source.uri.toString();
                const sidecarFacts = this.compilerSidecarExpressions.get(sourceKey) || [];
                sidecarFacts.push(fact);
                this.compilerSidecarExpressions.set(sourceKey, sidecarFacts);
                if (COMPILER_EXPRESSION_DIRECTIVE.test(lineText)) {
                    const directiveFacts = this.compilerDirectiveExpressions.get(sourceKey) || [];
                    directiveFacts.push(fact);
                    this.compilerDirectiveExpressions.set(sourceKey, directiveFacts);
                }
            }
            this.compilerUnevaluatedSourceRanges = new Map();
            for (const [key, facts] of this.compilerSidecarExpressions) {
                if (!facts.some((fact) => fact.unevaluated === true)) continue;
                const ranges = facts.map((fact) => ({ start: fact.startOffset, end: fact.endOffset,
                    unevaluated: fact.unevaluated === true })).sort((left, right) => left.start - right.start || left.end - right.end);
                let maximum = 0;
                for (const range of ranges) range.maximum = maximum = Math.max(maximum, range.end);
                this.compilerUnevaluatedSourceRanges.set(key, ranges);
            }
            const finalizeFacts = (factMap, rememberAmbiguity = false) => {
                const rangesBySource = new Map();
                for (const [key, facts] of factMap) {
                    const byRange = new Map();
                    const constantValuesByRange = new Map();
                    const incompleteConstantRanges = new Set();
                    const ambiguousRanges = new Set();
                    const ambiguousFactsByRange = new Map();
                    const operationSignaturesByRange = new Map();
                    const ambiguousOperationRanges = new Set();
                    const wideLiteralSignaturesByRange = new Map();
                    const ambiguousWideLiteralRanges = new Set();
                    const selectCaseSignaturesByRange = new Map();
                    const ambiguousSelectCaseRanges = new Set();
                    const iifInputSignaturesByRange = new Map();
                    const ambiguousIifInputRanges = new Set();
                    const assignmentTargetSignaturesByRange = new Map();
                    const ambiguousAssignmentTargetRanges = new Set();
                    const arrayIndexSignaturesByRange = new Map();
                    const ambiguousArrayIndexRanges = new Set();
                    const numericOperandSignaturesByRange = new Map();
                    const ambiguousNumericOperandRanges = new Set();
                    const sizeQuerySignaturesByRange = new Map();
                    const ambiguousSizeQueryRanges = new Set();
                    const arrayBoundQuerySignaturesByRange = new Map();
                    const ambiguousArrayBoundQueryRanges = new Set();
                    const arrayStorageSignaturesByRange = new Map();
                    const ambiguousArrayStorageRanges = new Set();
                    const arrayStorageSymbolIdsByRange = new Map();
                    for (const fact of facts) {
                        const range = `${fact.startOffset}:${fact.endOffset}`;
                        const arrayStorageSignature = fact.arrayStorageSelection
                            ? JSON.stringify([fact.arrayStorageSelection.kind, fact.arrayStorageSelection.name]) : "";
                        if (arrayStorageSignaturesByRange.has(range)) {
                            if (arrayStorageSignaturesByRange.get(range) !== arrayStorageSignature) {
                                ambiguousArrayStorageRanges.add(range);
                            }
                        } else arrayStorageSignaturesByRange.set(range, arrayStorageSignature);
                        if (fact.arrayStorageSelection?.symbolIds?.length) {
                            const symbolIds = arrayStorageSymbolIdsByRange.get(range) || new Set();
                            for (const symbol of fact.arrayStorageSelection.symbolIds) symbolIds.add(symbol);
                            arrayStorageSymbolIdsByRange.set(range, symbolIds);
                        }
                        const selectCaseSignature = fact.selectCaseLowering
                            ? JSON.stringify(fact.selectCaseLowering) : "";
                        if (selectCaseSignaturesByRange.has(range)) {
                            if (selectCaseSignaturesByRange.get(range) !== selectCaseSignature) {
                                ambiguousSelectCaseRanges.add(range);
                            }
                        } else selectCaseSignaturesByRange.set(range, selectCaseSignature);
                        const iifInputs = fact.compilerIifInputs;
                        if (iifInputs) {
                            const iifInputSignature = JSON.stringify([
                                normalizeTypeName(iifInputs.conditionTypeName), normalizeTypeName(iifInputs.trueTypeName),
                                normalizeTypeName(iifInputs.falseTypeName), normalizeTypeName(iifInputs.resultTypeName)
                            ]);
                            const previousIifSignature = iifInputSignaturesByRange.get(range);
                            if (previousIifSignature && previousIifSignature !== iifInputSignature) {
                                ambiguousIifInputRanges.add(range);
                            } else iifInputSignaturesByRange.set(range, iifInputSignature);
                        }
                        const assignmentTarget = fact.compilerAssignmentTarget;
                        if (assignmentTarget) {
                            const assignmentTargetSignature = JSON.stringify([
                                assignmentTarget.kind, normalizeTypeName(assignmentTarget.targetTypeName),
                                normalizeTypeName(assignmentTarget.sourceTypeName)
                            ]);
                            const previousAssignmentTargetSignature = assignmentTargetSignaturesByRange.get(range);
                            if (previousAssignmentTargetSignature &&
                                previousAssignmentTargetSignature !== assignmentTargetSignature) {
                                ambiguousAssignmentTargetRanges.add(range);
                            } else assignmentTargetSignaturesByRange.set(range, assignmentTargetSignature);
                        }
                        const arrayIndex = fact.compilerArrayIndex;
                        if (arrayIndex) {
                            const arrayIndexSignature = JSON.stringify([
                                normalizeTypeName(arrayIndex.sourceTypeName), normalizeTypeName(arrayIndex.targetTypeName)
                            ]);
                            const previousArrayIndexSignature = arrayIndexSignaturesByRange.get(range);
                            if (previousArrayIndexSignature && previousArrayIndexSignature !== arrayIndexSignature) {
                                ambiguousArrayIndexRanges.add(range);
                            } else arrayIndexSignaturesByRange.set(range, arrayIndexSignature);
                        }
                        const numericOperands = fact.compilerNumericOperands;
                        if (numericOperands) {
                            const numericOperandSignature = JSON.stringify([
                                normalizeTypeName(numericOperands.selectedLeftTypeName),
                                normalizeTypeName(numericOperands.selectedRightTypeName)
                            ]);
                            const previousNumericOperandSignature = numericOperandSignaturesByRange.get(range);
                            if (previousNumericOperandSignature && previousNumericOperandSignature !== numericOperandSignature) {
                                ambiguousNumericOperandRanges.add(range);
                            } else numericOperandSignaturesByRange.set(range, numericOperandSignature);
                        }
                        const sizeQuery = fact.compilerSizeQuery;
                        if (sizeQuery) {
                            const sizeQuerySignature = JSON.stringify([
                                sizeQuery.inputKind, normalizeTypeName(sizeQuery.inputTypeName)
                            ]);
                            const previousSizeQuerySignature = sizeQuerySignaturesByRange.get(range);
                            if (previousSizeQuerySignature && previousSizeQuerySignature !== sizeQuerySignature) {
                                ambiguousSizeQueryRanges.add(range);
                            } else sizeQuerySignaturesByRange.set(range, sizeQuerySignature);
                        }
                        const arrayBoundQuery = fact.compilerArrayBoundQuery;
                        if (arrayBoundQuery) {
                            const arrayBoundQuerySignature = JSON.stringify([
                                arrayBoundQuery.kind, normalizeTypeName(arrayBoundQuery.sourceTypeName),
                                arrayBoundQuery.selectedValue || null
                            ]);
                            const previousArrayBoundQuerySignature = arrayBoundQuerySignaturesByRange.get(range);
                            if (previousArrayBoundQuerySignature &&
                                previousArrayBoundQuerySignature !== arrayBoundQuerySignature) {
                                ambiguousArrayBoundQueryRanges.add(range);
                            } else arrayBoundQuerySignaturesByRange.set(range, arrayBoundQuerySignature);
                        }
                        const wideLiteralSignature = fact.targetWideLiteral
                            ? JSON.stringify(fact.targetWideLiteral) : "";
                        if (wideLiteralSignaturesByRange.has(range)) {
                            if (wideLiteralSignaturesByRange.get(range) !== wideLiteralSignature) {
                                ambiguousWideLiteralRanges.add(range);
                            }
                        } else wideLiteralSignaturesByRange.set(range, wideLiteralSignature);
                        const operation = fact.sourceOperation;
                        const operationSignature = operation ? JSON.stringify([
                            operation.family, operation.operator, operation.startLine, operation.startColumn,
                            operation.endLine, operation.endColumn, operation.physical,
                            fact.operatorCode, fact.operatorKind, normalizeTypeName(fact.typeName),
                            normalizeTypeName(operation.leftTypeName), normalizeTypeName(operation.rightTypeName)
                        ]) : "";
                        if (operationSignaturesByRange.has(range)) {
                            if (operationSignaturesByRange.get(range) !== operationSignature) ambiguousOperationRanges.add(range);
                        } else operationSignaturesByRange.set(range, operationSignature);
                        if (fact.compilerConstantFactsIncomplete) incompleteConstantRanges.add(range);
                        /* Repeated include contexts share a range; the formatter
                           will withhold any values that disagree across them. */
                        if (!incompleteConstantRanges.has(range) && fact.compilerConstantValues?.length) {
                            const constantValues = constantValuesByRange.get(range) || new Map();
                            for (const constant of fact.compilerConstantValues) {
                                constantValues.set(`${constant.kind}:${constant.value}`, constant);
                            }
                            if (constantValues.size > MAX_COMPILER_EXPRESSION_CONSTANT_FACTS) {
                                incompleteConstantRanges.add(range);
                                constantValuesByRange.delete(range);
                            } else constantValuesByRange.set(range, constantValues);
                        }
                        const previous = byRange.get(range);
                        if (!previous) {
                            byRange.set(range, fact);
                            continue;
                        }
                        if (fact.compilerIifInputs && !previous.compilerIifInputs) {
                            byRange.set(range, { ...previous, compilerIifInputs: fact.compilerIifInputs });
                        }
                        if (fact.compilerAssignmentTarget && !previous.compilerAssignmentTarget) {
                            byRange.set(range, { ...byRange.get(range), compilerAssignmentTarget: fact.compilerAssignmentTarget });
                        }
                        if (fact.compilerArrayIndex && !previous.compilerArrayIndex) {
                            byRange.set(range, { ...byRange.get(range), compilerArrayIndex: fact.compilerArrayIndex });
                        }
                        if (fact.compilerNumericOperands && !previous.compilerNumericOperands) {
                            byRange.set(range, { ...byRange.get(range), compilerNumericOperands: fact.compilerNumericOperands });
                        }
                        if (fact.compilerSizeQuery && !previous.compilerSizeQuery) {
                            byRange.set(range, { ...byRange.get(range), compilerSizeQuery: fact.compilerSizeQuery });
                        }
                        if (fact.compilerArrayBoundQuery && !previous.compilerArrayBoundQuery) {
                            byRange.set(range, { ...byRange.get(range), compilerArrayBoundQuery: fact.compilerArrayBoundQuery });
                        }
                        if (previous.dtype !== fact.dtype ||
                            previous.compilerSidecarSubtypeId !== fact.compilerSidecarSubtypeId ||
                            normalizeTypeName(previous.typeName) !== normalizeTypeName(fact.typeName)) {
                            ambiguousRanges.add(range);
                            const alternatives = ambiguousFactsByRange.get(range) || [previous];
                            alternatives.push(fact);
                            ambiguousFactsByRange.set(range, alternatives);
                        }
                    }
                    if (rememberAmbiguity && ambiguousRanges.size) {
                        this.compilerSidecarAmbiguousRanges.set(key, ambiguousRanges);
                        this.compilerSidecarAmbiguousFacts.set(key, new Map([...ambiguousRanges]
                            .map((range) => [range, ambiguousFactsByRange.get(range) || []])));
                    }
                    const finalized = [...byRange]
                        .filter(([range]) => !ambiguousRanges.has(range))
                        .map(([range, fact]) => {
                            if (ambiguousOperationRanges.has(range)) fact = { ...fact, sourceOperation: null };
                            if (ambiguousWideLiteralRanges.has(range)) fact = { ...fact, targetWideLiteral: null };
                            if (ambiguousSelectCaseRanges.has(range)) fact = { ...fact, selectCaseLowering: null };
                            if (ambiguousIifInputRanges.has(range)) fact = { ...fact, compilerIifInputs: null };
                            if (ambiguousAssignmentTargetRanges.has(range)) fact = { ...fact, compilerAssignmentTarget: null };
                            if (ambiguousArrayIndexRanges.has(range)) fact = { ...fact, compilerArrayIndex: null };
                            if (ambiguousNumericOperandRanges.has(range)) fact = { ...fact, compilerNumericOperands: null };
                            if (ambiguousSizeQueryRanges.has(range)) fact = { ...fact, compilerSizeQuery: null };
                            if (ambiguousArrayBoundQueryRanges.has(range)) fact = { ...fact, compilerArrayBoundQuery: null };
                            if (ambiguousArrayStorageRanges.has(range)) fact = { ...fact, arrayStorageSelection: null };
                            if (fact.arrayStorageSelection) {
                                fact = {
                                    ...fact,
                                    arrayStorageSelection: {
                                        ...fact.arrayStorageSelection,
                                        symbolIds: [...(arrayStorageSymbolIdsByRange.get(range) || [])]
                                    }
                                };
                            }
                            if (incompleteConstantRanges.has(range)) return { ...fact, compilerConstantValues: [] };
                            const constantValues = constantValuesByRange.get(range);
                            return constantValues?.size
                                ? { ...fact, compilerConstantValues: [...constantValues.values()] }
                                : fact;
                        })
                        .sort((first, second) => first.endOffset - first.startOffset - (second.endOffset - second.startOffset));
                    factMap.set(key, finalized);
                    rangesBySource.set(key, new Map(finalized.map((fact) => [`${fact.startOffset}:${fact.endOffset}`, fact])));
                }
                if (rememberAmbiguity) this.compilerSidecarExpressionsByRange = rangesBySource;
                else this.compilerDirectiveExpressionsByRange = rangesBySource;
            };
            finalizeFacts(this.compilerSidecarExpressions, true);
            finalizeFacts(this.compilerDirectiveExpressions);
            for (const facts of this.compilerSidecarExpressions.values()) {
                /* Several parser routes can describe nested physical spans.
                   Cursor queries prefer the narrowest fact, while selections
                   below still require an exact span. */
                facts.sort((first, second) => first.endOffset - first.startOffset - (second.endOffset - second.startOffset));
            }
        }
        this.compilerRuntimeMacroOperationsByFile = this.partial
            ? null
            : compilerRuntimeMacroHoverIndex(usableSemanticExpressionOperands, semanticExpressionOperandsById, this.sources);
        for (const entry of this.inner.entries) {
            const mapped = this.expandedToSource.get(entry.offset);
            if (!mapped) continue;
            entry.uri = mapped.uri;
            entry.declaration.line = mapped.occurrence.line;
            entry.declaration.startColumn = mapped.occurrence.startColumn;
            entry.declaration.endColumn = mapped.occurrence.endColumn;
            this.sources.get(mapped.uri.toString()).entriesByOffset.set(mapped.occurrence.offset, entry);
        }
        this.installCompilerSemanticProperties(analysis);
        this.preprocessor = installPreprocessorModel(this, analysis);
        this.compilerCommentMarkers = Array.isArray(analysis.semanticCommentMarkers) &&
            analysis.semanticCommentMarkers.length <= MAX_COMPILER_SOURCE_DOCUMENTATION_COMMENTS ? analysis.semanticCommentMarkers : [];
        this.attachSourceDocumentation(this.compilerCommentMarkers);
        this.expressionFallback = analysis.semanticExpressionFallback && !this.partial
            ? new CompilerSemanticModel(expandedUri, analysis.semanticExpressionFallback, sources)
            : null;
    }

    installCompilerSemanticProperties(analysis) {
        const properties = analysis.semanticProperties || [];
        this.compilerSemanticProperties = properties;
        this.semanticBindings = analysis.semanticBindings || [];
        this.compilerRemKeywordDisableOptions = analysis.compilerRemKeywordDisableOptions || [];
        this.semanticDeclarations = analysis.semanticDeclarations || [];
        this.semanticAccessRoles = analysis.semanticAccessRoles || [];
        this.semanticForEntryResults = analysis.semanticForEntryResults || [];
        this.semanticIfConditionResults = analysis.semanticIfConditionResults || [];
        this.semanticUnreachableStatements = analysis.semanticUnreachableStatements || [];
        this.semanticProcedureParameterModes = analysis.semanticProcedureParameterModes || [];
        this.semanticConstants = analysis.semanticConstants || [];
        const expressionConstants = new Map();
        if (!this.partial) {
            for (const constant of this.semanticConstants) {
                if (constant.domain !== "expression" || !Number.isSafeInteger(constant.module) ||
                    !Number.isSafeInteger(constant.identity) || constant.identity < 1 ||
                    constant.provisional === true || !isCompilerConstantValue(constant)) continue;
                const key = `${constant.module}:${constant.identity}`;
                let values = expressionConstants.get(key);
                if (!values) {
                    values = new Map();
                    expressionConstants.set(key, values);
                }
                values.set(`${constant.kind}:${constant.value}`, {
                    kind: constant.kind,
                    value: constant.value
                });
            }
        }
        this.compilerSemanticRelationships = analysis.semanticRelationships || [];
        const formalDefaultValuesByNativeParameter = new Map();
        this.compilerProcedureOverrideTargetsBySemanticIdentity = new Map();
        for (const relationship of this.compilerSemanticRelationships) {
            if (relationship.sourceDomain !== "symbol" || relationship.targetDomain !== "symbol" ||
                relationship.kind !== "overrides" || !Number.isSafeInteger(relationship.source) ||
                relationship.source < 1 || !Number.isSafeInteger(relationship.target) || relationship.target < 1) continue;
            const targets = this.compilerProcedureOverrideTargetsBySemanticIdentity.get(relationship.source) || new Set();
            targets.add(relationship.target);
            this.compilerProcedureOverrideTargetsBySemanticIdentity.set(relationship.source, targets);
        }
        this.semanticAssignmentInputs = analysis.semanticAssignmentInputs || [];
        /* Hover runs often; index the bounded assignment receipts once by physical file and line. */
        this.compilerAssignmentInputsByFile = new Map();
        if (!this.partial && Array.isArray(this.semanticAssignmentInputs) &&
            this.semanticAssignmentInputs.length <= MAX_COMPILER_ASSIGNMENT_HOVER_FACTS) {
            for (const input of this.semanticAssignmentInputs) {
                if (!input || input.provisional || typeof input.filePath !== "string" ||
                    !Number.isSafeInteger(input.line) || input.line < 0 ||
                    !Number.isSafeInteger(input.startColumn) || input.startColumn < 0 ||
                    !Number.isSafeInteger(input.endColumn) || input.endColumn <= input.startColumn) continue;
                const fileKey = compilerPathKey(input.filePath);
                const lines = this.compilerAssignmentInputsByFile.get(fileKey) || new Map();
                let records = lines.get(input.line);
                if (records === null) continue;
                if (!records) records = [];
                if (records.length >= MAX_COMPILER_ASSIGNMENT_HOVER_FACTS_PER_LINE) {
                    lines.set(input.line, null);
                } else {
                    records.push(input);
                    lines.set(input.line, records);
                }
                this.compilerAssignmentInputsByFile.set(fileKey, lines);
            }
            for (const lines of this.compilerAssignmentInputsByFile.values()) {
                for (const records of lines.values()) {
                    if (records) records.sort((first, second) => first.startColumn - second.startColumn);
                }
            }
        }
        this.compilerSourceCallBindings = this.compilerSemanticRelationships.filter((relationship) =>
            relationship.sourceDomain === "node" && relationship.targetDomain === "binding" &&
            relationship.kind === "source-binding");
        this.compilerSemanticCapabilities = analysis.semanticCapabilities || [];
        this.compilerSemanticModelSchemaVersion = analysis.semanticModelSchemaVersion || 0;
        this.compilerSemanticModelCompilerVersion = analysis.semanticModelCompilerVersion || "";
        this.compilerTargetWideLiteralExpressionsByLine = new Map();
        if (!this.partial) {
            let indexedFactCount = 0;
            for (const [sourceKey, facts] of this.compilerSidecarExpressions) {
                const expressionsByLine = new Map();
                let overLimit = false;
                for (const fact of facts) {
                    if (fact.provisional || fact.physical !== true || !fact.targetWideLiteral) continue;
                    const lineCount = fact.end.line - fact.start.line + 1;
                    if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > MAX_COMPILER_WIDE_LITERAL_RANGE_LINES ||
                        indexedFactCount + lineCount > MAX_COMPILER_WIDE_LITERAL_HOVER_FACTS) {
                        overLimit = true;
                        break;
                    }
                    for (let line = fact.start.line; line <= fact.end.line; line++) {
                        const lineFacts = expressionsByLine.get(line) || [];
                        lineFacts.push(fact);
                        expressionsByLine.set(line, lineFacts);
                    }
                    indexedFactCount += lineCount;
                }
                if (overLimit) {
                    this.compilerTargetWideLiteralExpressionsByLine.set(sourceKey, null);
                    continue;
                }
                for (const [line, lineFacts] of expressionsByLine) {
                    if (lineFacts.length > MAX_COMPILER_WIDE_LITERAL_HOVER_CANDIDATES_PER_LINE) {
                        expressionsByLine.set(line, null);
                        continue;
                    }
                    lineFacts.sort((first, second) =>
                        first.endOffset - first.startOffset - (second.endOffset - second.startOffset));
                }
                if (expressionsByLine.size) this.compilerTargetWideLiteralExpressionsByLine.set(sourceKey, expressionsByLine);
            }
        }
        this.compilerTargetWideLiteralFactsByModuleSymbol = null;
        this.compilerSelectCaseLoweringExpressionsByLine = new Map();
        if (!this.partial && this.compilerSelectCaseLoweringFactsByModuleExpression) {
            let indexedFactCount = 0;
            for (const [sourceKey, facts] of this.compilerSidecarExpressions) {
                const expressionsByLine = new Map();
                let overLimit = false;
                for (const fact of facts) {
                    if (fact.provisional || fact.physical !== true || !fact.selectCaseLowering) continue;
                    const lineCount = fact.end.line - fact.start.line + 1;
                    if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > MAX_COMPILER_SELECT_CASE_RANGE_LINES ||
                        indexedFactCount + lineCount > MAX_COMPILER_SELECT_CASE_HOVER_FACTS) {
                        overLimit = true;
                        break;
                    }
                    for (let line = fact.start.line; line <= fact.end.line; line++) {
                        const lineFacts = expressionsByLine.get(line) || [];
                        lineFacts.push(fact);
                        expressionsByLine.set(line, lineFacts);
                    }
                    indexedFactCount += lineCount;
                }
                if (overLimit) {
                    this.compilerSelectCaseLoweringExpressionsByLine.set(sourceKey, null);
                    continue;
                }
                for (const [line, lineFacts] of expressionsByLine) {
                    if (lineFacts.length > MAX_COMPILER_SELECT_CASE_HOVER_CANDIDATES_PER_LINE) {
                        expressionsByLine.set(line, null);
                        continue;
                    }
                    lineFacts.sort((first, second) =>
                        first.endOffset - first.startOffset - (second.endOffset - second.startOffset));
                }
                if (expressionsByLine.size) this.compilerSelectCaseLoweringExpressionsByLine.set(sourceKey, expressionsByLine);
            }
        }
        this.compilerSelectCaseLoweringFactsByModuleExpression = null;
        this.compilerSourceHeaderPolicies = analysis.semanticSourceHeaderPolicies || [];
        this.compilerHeaderLibraries = analysis.semanticHeaderLibraries || [];
        this.compilerHeaderLibrariesByFile = new Map();
        if (Array.isArray(this.compilerHeaderLibraries) &&
            this.compilerHeaderLibraries.length <= MAX_COMPILER_HEADER_LIBRARY_HOVER_FACTS) {
            for (const library of this.compilerHeaderLibraries) {
                if (typeof library?.filePath !== "string" || !library.filePath ||
                    !["inclib", "libpath"].includes(library.kind) || typeof library.value !== "string") continue;
                const key = compilerPathKey(library.filePath);
                const records = this.compilerHeaderLibrariesByFile.get(key) || [];
                records.push(library);
                this.compilerHeaderLibrariesByFile.set(key, records);
            }
        }
        this.compilerNamespaceImportRecipients = analysis.semanticNamespaceImportRecipients || [];
        this.compilerNamespaceDeclarations = analysis.semanticNamespaceDeclarations || [];
        this.compilerFactsBySemanticIdentity = new Map();
        this.compilerFactsByNativeSymbolId = new Map();
        this.compilerParameterAliases = new Map();
        this.compilerCallableKinds = new Map((analysis.semanticProcedureOwnerKinds || [])
            .filter((entry) => Number.isSafeInteger(entry.symbol) && entry.symbol > 0 && ["function", "method"].includes(entry.kind))
            .map((entry) => [entry.symbol, entry.kind]));
        /* Anonymous operators have no identifier B declaration. Retain their
           F kind independently of the facts indexed through named bindings. */
        this.compilerProcedureKindsBySemanticIdentity = new Map();
        for (const procedure of analysis.semanticProcedureCallConventions || []) {
            if (!Number.isSafeInteger(procedure.symbol) || procedure.symbol < 1 || typeof procedure.kind !== "string") continue;
            const previous = this.compilerProcedureKindsBySemanticIdentity.get(procedure.symbol);
            this.compilerProcedureKindsBySemanticIdentity.set(procedure.symbol,
                previous === undefined || previous === procedure.kind ? procedure.kind : null);
        }

        const semanticDeclarationsBySite = new Map();
        for (const binding of analysis.semanticBindings || []) {
            if (binding.role !== "declaration" || binding.physical !== true) continue;
            addSemanticSiteIdentity(semanticDeclarationsBySite,
                semanticSiteKey(binding.filePath, binding.startLine, binding.startColumn, binding.endColumn), binding.symbol);
        }
        const sourceSemanticSymbols = new Set([...semanticDeclarationsBySite.values()].flatMap((symbols) => [...symbols]));
        // Parameter uses can bind a runtime-variable alias rather than the
        // formal's declaration identity. Both retain their own NT qualifiers.
        const sourceQualifierSymbols = new Set((analysis.semanticBindings || [])
            .filter((binding) => binding.physical === true).map((binding) => binding.symbol));

        const nativeDeclarationsBySite = new Map();
        for (const binding of this.nativeBindings || []) {
            if (binding.kind !== "declaration") continue;
            const physical = this.expandedToSource.get(binding.token.offset);
            if (!physical) continue;
            const occurrence = physical.occurrence;
            addSemanticSiteIdentity(nativeDeclarationsBySite,
                semanticSiteKey(physical.uri.fsPath, occurrence.line + 1, occurrence.startColumn, occurrence.endColumn),
                this.canonicalSymbolIds.get(binding.id) || binding.id);
        }

        const semanticToNative = new Map();
        const ambiguousSemanticIdentities = new Set();
        for (const [site, semanticIds] of semanticDeclarationsBySite) {
            const nativeIds = nativeDeclarationsBySite.get(site);
            if (semanticIds.size !== 1 || nativeIds?.size !== 1) continue;
            const semanticId = semanticIds.values().next().value;
            const nativeId = nativeIds.values().next().value;
            const previous = semanticToNative.get(semanticId);
            if (previous !== undefined && previous !== nativeId) {
                semanticToNative.delete(semanticId);
                ambiguousSemanticIdentities.add(semanticId);
            } else if (!ambiguousSemanticIdentities.has(semanticId)) {
                semanticToNative.set(semanticId, nativeId);
            }
        }
        this.semanticSymbolNativeIds = semanticToNative;
        if (!this.partial) {
            const defaultCapabilityModules = new Set((analysis.semanticCapabilities || [])
                .filter((capability) => capability.feature === "formal-default-inputs" &&
                    capability.coverage === "available" && capability.provisional !== true)
                .map((capability) => capability.module));
            const optionalParameterIds = new Set((analysis.semanticProcedureParameterModes || [])
                .filter((parameter) => parameter.optional === true && parameter.mode !== "vararg" &&
                    Number.isSafeInteger(parameter.parameter) && parameter.parameter > 0)
                .map((parameter) => parameter.parameter));
            const defaultEdges = new Map();
            for (const relationship of this.compilerSemanticRelationships) {
                if (relationship.sourceDomain !== "symbol" || relationship.targetDomain !== "node" ||
                    relationship.kind !== "default-initializer" || relationship.ordinal !== 0) continue;
                const key = `${relationship.module}:${relationship.source}`;
                const edges = defaultEdges.get(key) || [];
                edges.push(relationship.target);
                defaultEdges.set(key, edges);
            }
            const expressionTypeNames = new Map((analysis.semanticExpressions || [])
                .filter((expression) => typeof expression.typeName === "string" && expression.typeName)
                .map((expression) => [expression.id, expression.typeName]));
            for (const property of properties) {
                if (property.domain !== "symbol" || property.name !== "formal-default-expression" ||
                    property.provisional === true || !defaultCapabilityModules.has(property.module) ||
                    !optionalParameterIds.has(property.identity)) continue;
                const expression = semanticPropertyInteger(property.value, 1);
                const expressionValues = expression !== null
                    ? expressionConstants.get(`${property.module}:${expression}`)
                    : null;
                const selectedEdges = defaultEdges.get(`${property.module}:${property.identity}`) || [];
                const nativeId = semanticToNative.get(property.identity);
                if (expression === null || expressionValues?.size !== 1 || selectedEdges.length !== 1 ||
                    !Number.isSafeInteger(nativeId) || nativeId < 1) continue;
                const value = expressionValues.values().next().value;
                const defaultValue = {
                    ...value,
                    ...(expressionTypeNames.has(expression) ? { typeName: expressionTypeNames.get(expression) } : {})
                };
                const signature = JSON.stringify(defaultValue);
                const previous = formalDefaultValuesByNativeParameter.get(nativeId);
                if (previous === undefined) formalDefaultValuesByNativeParameter.set(nativeId, { signature, value: defaultValue });
                else if (previous.signature !== signature) formalDefaultValuesByNativeParameter.set(nativeId, null);
            }
            for (const [identity, record] of formalDefaultValuesByNativeParameter) {
                formalDefaultValuesByNativeParameter.set(identity, record?.value || null);
            }
        }
        const nativeOverrideTargetIds = new Set();
        for (const relationship of this.compilerSemanticRelationships) {
            if (relationship.sourceDomain !== "symbol" || relationship.targetDomain !== "symbol" ||
                relationship.kind !== "overrides") continue;
            const nativeId = semanticToNative.get(relationship.target);
            if (nativeId) nativeOverrideTargetIds.add(nativeId);
        }
        const nativeEntriesBySymbol = new Map();
        for (const entry of this.inner.entries) {
            if (!Number.isSafeInteger(entry.compilerSymbolId) || entry.compilerSymbolId < 1) continue;
            const nativeId = this.canonicalSymbolIds.get(entry.compilerSymbolId) || entry.compilerSymbolId;
            if (!nativeOverrideTargetIds.has(nativeId)) continue;
            const entries = nativeEntriesBySymbol.get(nativeId) || [];
            entries.push(entry);
            nativeEntriesBySymbol.set(nativeId, entries);
        }

        const factsFor = (identity) => {
            let facts = this.compilerFactsBySemanticIdentity.get(identity);
            if (!facts) {
                facts = { properties: [], declarationTypeGroups: [], declarationInputs: [], formalWrittenTypes: [],
                    procedureTypingInputs: [], procedureWrittenVisibility: [], procedureAbiPolicyInputs: [], aggregateAccess: null,
                    constantValues: [], scalarStringDeclaration: null, sourceHeaderPolicies: [], sourceHeaderLibraries: [],
                    namespaceImportReceipts: [], namespaceImports: [], namespaceDeclarations: [], namespaceDeclarationInputs: [],
                    storageTypeObservations: [], valueConstObservations: [], aggregateSizeObservations: [], arrayBoundsObservations: [],
                    fieldLayoutObservations: [], procedureCallingConventionObservations: [],
                    procedureReturnByReferenceObservations: [], procedureOverrideObservations: [],
                    symbolVisibilityObservations: [], abstractMemberCountObservations: [],
                    symbolStorageClassObservations: [], parameterPassingModeObservations: [],
                    enumElementInputs: [] };
                this.compilerFactsBySemanticIdentity.set(identity, facts);
            }
            return facts;
        };
        if (!this.partial) {
            for (const input of analysis.semanticEnumElementInputs || []) {
                if (!sourceSemanticSymbols.has(input.symbol) || input.provisional === true ||
                    input.physical !== true || !Number.isSafeInteger(input.owner) || input.owner < 1 ||
                    !Number.isSafeInteger(input.ordinal) || input.ordinal < 1 ||
                    typeof input.explicit !== "boolean" || typeof input.filePath !== "string" ||
                    !input.filePath || !Number.isSafeInteger(input.line) || input.line < 1 ||
                    !Number.isSafeInteger(input.startColumn) || input.startColumn < 0) continue;
                factsFor(input.symbol).enumElementInputs.push({
                    owner: input.owner,
                    ordinal: input.ordinal,
                    filePath: input.filePath,
                    line: input.line,
                    startColumn: input.startColumn,
                    physical: true,
                    explicit: input.explicit,
                    source: input.source,
                    provisional: false
                });
            }
            for (const symbol of analysis.semanticSymbolVisibilities || []) {
                if (sourceSemanticSymbols.has(symbol.symbol) &&
                    ["public", "private", "protected"].includes(symbol.visibility)) {
                    factsFor(symbol.symbol).symbolVisibilityObservations.push(symbol.visibility);
                }
            }
            for (const type of analysis.semanticAbstractTypeCounts || []) {
                if (sourceSemanticSymbols.has(type.symbol) && Number.isSafeInteger(type.count) && type.count >= 0) {
                    factsFor(type.symbol).abstractMemberCountObservations.push(type.count);
                }
            }
            for (const symbol of analysis.semanticSymbolStorageClasses || []) {
                if (sourceSemanticSymbols.has(symbol.symbol) && typeof symbol.storage === "string") {
                    factsFor(symbol.symbol).symbolStorageClassObservations.push(symbol.storage);
                }
            }
            for (const relationship of this.compilerSemanticRelationships) {
                if (relationship.sourceDomain !== "symbol" || relationship.targetDomain !== "symbol" ||
                    relationship.kind !== "overrides") continue;
                const sourceNativeId = semanticToNative.get(relationship.source);
                const targetNativeId = semanticToNative.get(relationship.target);
                if (!sourceNativeId || !targetNativeId) continue;
                const targetEntries = nativeEntriesBySymbol.get(targetNativeId) || [];
                const targetNames = new Map(targetEntries
                    .map((entry) => entry.declaration?.qualifiedName)
                    .filter((name) => typeof name === "string" && name.length > 0)
                    .map((name) => [name.toLowerCase(), name]));
                if (targetNames.size !== 1) continue;
                factsFor(relationship.source).procedureOverrideObservations.push({
                    compilerSymbolId: targetNativeId,
                    qualifiedName: targetNames.values().next().value
                });
            }
            for (const constant of this.semanticConstants) {
                if (constant.domain !== "symbol" || !Number.isSafeInteger(constant.identity) || constant.identity < 1 ||
                    !isCompilerConstantValue(constant)) continue;
                factsFor(constant.identity).constantValues.push({ kind: constant.kind, value: constant.value });
            }
            for (const type of analysis.semanticNormalizedTypes || []) {
                if (sourceQualifierSymbols.has(type.identity) && Number.isSafeInteger(type.pointerDepth) && type.pointerDepth >= 0) {
                    const known = typeof type.constBits === "string" && type.constBits.length === type.pointerDepth + 1 &&
                        /^[01]+$/.test(type.constBits);
                    // Position zero qualifies the value, not the pointed-to data.
                    factsFor(type.identity).valueConstObservations.push(known ? type.constBits[0] === "1" : null);
                }
                if (!sourceSemanticSymbols.has(type.identity) || !Number.isSafeInteger(type.storageBytes) ||
                    type.storageBytes < 1 || !Number.isSafeInteger(type.pointerDepth) || type.pointerDepth < 0 ||
                    typeof type.primitive !== "string" || typeof type.isReference !== "boolean" ||
                    !Number.isSafeInteger(type.nominal) || type.nominal < 0) continue;
                factsFor(type.identity).storageTypeObservations.push({
                    primitive: type.primitive,
                    pointerDepth: type.pointerDepth,
                    isReference: type.isReference,
                    storageBytes: type.storageBytes,
                    ...(type.pointerDepth > 0 ? { constBits: type.constBits } : {})
                });
                if (type.primitive === "type" && type.pointerDepth === 0 && type.nominal > 0 &&
                    sourceSemanticSymbols.has(type.nominal)) {
                    factsFor(type.nominal).aggregateSizeObservations.push(type.storageBytes);
                }
            }
            for (const arrayBounds of analysis.semanticArrayBounds || []) {
                if (!sourceSemanticSymbols.has(arrayBounds.identity) ||
                    !["runtime", "bounds"].includes(arrayBounds.mode) ||
                    arrayBounds.mode === "runtime" &&
                        !(arrayBounds.rank === null || Number.isSafeInteger(arrayBounds.rank) && arrayBounds.rank > 0) ||
                    arrayBounds.mode === "bounds" &&
                        (!Number.isSafeInteger(arrayBounds.rank) || arrayBounds.rank < 1 ||
                            !Array.isArray(arrayBounds.dimensions) || arrayBounds.dimensions.length !== arrayBounds.rank)) continue;
                factsFor(arrayBounds.identity).arrayBoundsObservations.push(arrayBounds);
            }
            for (const layout of analysis.semanticFieldLayouts || []) {
                if (!sourceSemanticSymbols.has(layout.symbol) || !Number.isSafeInteger(layout.owner) ||
                    layout.owner < 1 || !Number.isSafeInteger(layout.byteOffset) || layout.byteOffset < 0) continue;
                factsFor(layout.symbol).fieldLayoutObservations.push({
                    owner: layout.owner,
                    byteOffset: layout.byteOffset
                });
            }
            for (const procedure of analysis.semanticProcedureCallConventions || []) {
                if (!sourceSemanticSymbols.has(procedure.symbol) || typeof procedure.callingConvention !== "string" ||
                    typeof procedure.returnByReference !== "boolean") continue;
                const procedureFacts = factsFor(procedure.symbol);
                procedureFacts.procedureKind = procedureFacts.procedureKind === undefined ||
                    procedureFacts.procedureKind === procedure.kind ? procedure.kind : null;
                procedureFacts.procedureCallingConventionObservations.push(procedure.callingConvention);
                procedureFacts.procedureReturnByReferenceObservations.push(procedure.returnByReference);
            }
            for (const parameter of analysis.semanticProcedureParameterModes || []) {
                if (!Number.isSafeInteger(parameter.dimensions) || typeof parameter.optional !== "boolean" ||
                    typeof parameter.receiver !== "boolean" || typeof parameter.mode !== "string") continue;
                if (sourceSemanticSymbols.has(parameter.parameter) && Number.isSafeInteger(parameter.variable) &&
                    parameter.variable > 0 && parameter.variable !== parameter.parameter) {
                    const previous = this.compilerParameterAliases.get(parameter.variable);
                    // Zero records conflicting aliases instead of joining
                    // unrelated source parameters through a runtime symbol.
                    this.compilerParameterAliases.set(parameter.variable,
                        previous === undefined || previous === parameter.parameter ? parameter.parameter : 0);
                }
                const observation = {
                    mode: parameter.mode,
                    dimensions: parameter.dimensions,
                    optional: parameter.optional,
                    receiver: parameter.receiver
                };
                for (const identity of [parameter.parameter, parameter.variable]) {
                    if (Number.isSafeInteger(identity) && identity > 0 && sourceSemanticSymbols.has(identity)) {
                        factsFor(identity).parameterPassingModeObservations.push(observation);
                    }
                }
            }
        }
        for (const policy of this.compilerSourceHeaderPolicies) {
            factsFor(policy.owner).sourceHeaderPolicies.push(policy);
        }
        for (const library of this.compilerHeaderLibraries) {
            factsFor(library.owner).sourceHeaderLibraries.push(library);
        }
        for (const imported of this.compilerNamespaceImportRecipients) {
            factsFor(imported.owner).namespaceImportReceipts.push(imported);
            factsFor(imported.recipient).namespaceImports.push(imported);
        }
        for (const declaration of this.compilerNamespaceDeclarations) {
            factsFor(declaration.owner).namespaceDeclarations.push(declaration);
            factsFor(declaration.namespace).namespaceDeclarationInputs.push(declaration);
        }
        const declarationGroups = new Map();
        const declarationInputs = [];
        const declarationGroupEnds = [];
        const procedureAbiPolicyInputs = [];
        for (const property of properties) {
            if (property.domain !== "symbol") continue;
            const facts = factsFor(property.identity);
            facts.properties.push({ name: property.name, value: property.value, provisional: Boolean(property.provisional) });

            let match = /^declaration-type-group:(\d+)$/.exec(property.name);
            if (match) {
                const values = property.value.split("\t");
                const group = semanticPropertyInteger(match[1], 1);
                const statement = semanticPropertyInteger(values[0], 1);
                if (group !== null && statement !== null && values.length === 2 && values[1]) {
                    declarationGroups.set(`${property.identity}:${group}`, {
                        owner: property.identity, identity: group, statement, kind: values[1], inputs: [], count: null
                    });
                }
                continue;
            }

            match = /^declaration-type-input:(\d+):(\d+)$/.exec(property.name);
            if (match) {
                const values = property.value.split("\t");
                const group = semanticPropertyInteger(match[1], 1);
                const ordinal = semanticPropertyInteger(match[2], 1);
                const symbol = semanticPropertyInteger(values[0], 1);
                const initializerKind = semanticPropertyInteger(values[2]);
                const sourceContext = semanticPropertyInteger(values[3], 1);
                if (group !== null && values.length === 4 && ordinal !== null && symbol !== null &&
                    ["as", "suffix", "implicit", "inferred"].includes(values[1]) &&
                    initializerKind !== null && initializerKind <= 3 && sourceContext !== null) {
                    declarationInputs.push({ owner: property.identity, group, input: {
                        ordinal, symbol, writtenType: values[1], initializerKind, sourceContext
                    } });
                }
                continue;
            }

            match = /^declaration-type-end:(\d+)$/.exec(property.name);
            if (match) {
                const group = semanticPropertyInteger(match[1], 1);
                const count = semanticPropertyInteger(property.value, 1);
                if (group !== null && count !== null) declarationGroupEnds.push({ owner: property.identity, group, count });
                continue;
            }

            if (property.name === "formal-written-type" && property.provisional !== true &&
                ["as", "suffix", "implicit", "vararg"].includes(property.value)) {
                facts.formalWrittenTypes.push(property.value);
                continue;
            }

            match = /^abi-policy-input:(\d+)$/.exec(property.name);
            if (match) {
                const identity = semanticPropertyInteger(match[1], 1);
                const values = property.value.split("\t");
                if (identity === null || values.length !== 2 ||
                    !["0", "1"].includes(values[0]) || !["0", "1"].includes(values[1])) {
                    throw new Error("Invalid compiler procedure ABI policy input.");
                }
                procedureAbiPolicyInputs.push({
                    module: property.module,
                    owner: property.identity,
                    identity,
                    writtenConvention: values[0] === "1",
                    managedString: values[1] === "1",
                    provisional: Boolean(property.provisional)
                });
                continue;
            }

            match = /^procedure-typing-input:(\d+)$/.exec(property.name);
            if (match) {
                const values = property.value.split("\t");
                const identity = semanticPropertyInteger(match[1], 1);
                const statement = semanticPropertyInteger(values[0], 1);
                if (identity !== null && statement !== null && values.length === 5 &&
                    ["prototype", "definition"].includes(values[1]) &&
                    ["sub", "function", "property", "operator", "constructor", "destructor"].includes(values[2]) &&
                    ["none", "as", "suffix", "implicit", "special"].includes(values[3]) &&
                    ["0", "1"].includes(values[4])) {
                    facts.procedureTypingInputs.push({ identity, statement, role: values[1], kind: values[2],
                        resultForm: values[3], exported: values[4] === "1", provisional: Boolean(property.provisional) });
                }
                continue;
            }

            match = /^procedure-written-visibility:(\d+)$/.exec(property.name);
            if (match && ["default", "public", "private"].includes(property.value)) {
                const statement = semanticPropertyInteger(match[1], 1);
                if (statement !== null) facts.procedureWrittenVisibility.push({
                    statement, visibility: property.value, provisional: Boolean(property.provisional)
                });
                continue;
            }

            if (["aggregate-body-statement", "aggregate-access-count"].includes(property.name)) {
                const value = semanticPropertyInteger(property.value);
                if (value !== null) {
                    facts.aggregateAccess ||= { bodyStatement: null, count: null, sections: [] };
                    if (property.name === "aggregate-body-statement") facts.aggregateAccess.bodyStatement = value;
                    else facts.aggregateAccess.count = value;
                }
                continue;
            }

            match = /^aggregate-access-section:(\d+)$/.exec(property.name);
            if (match) {
                const ordinal = semanticPropertyInteger(match[1], 1);
                const values = property.value.split("\t");
                const statement = semanticPropertyInteger(values[0], 1);
                if (ordinal !== null && values.length === 2 && statement !== null &&
                    ["public", "private", "protected"].includes(values[1])) {
                    facts.aggregateAccess ||= { bodyStatement: null, count: null, sections: [] };
                    facts.aggregateAccess.sections.push({ ordinal, statement, visibility: values[1] });
                }
                continue;
            }

            if (property.name === "scalar-string-declaration") {
                const values = property.value.split("\t");
                const statement = semanticPropertyInteger(values[0], 1);
                const expression = semanticPropertyInteger(values[1]);
                const sourceContext = semanticPropertyInteger(values[3], 1);
                if (values.length === 4 && statement !== null && expression !== null && sourceContext !== null &&
                    ["dim", "static", "field"].includes(values[2])) {
                    const initializerValues = expression > 0
                        ? expressionConstants.get(`${property.module}:${expression}`)
                        : null;
                    facts.scalarStringDeclaration = {
                        statement,
                        expression,
                        kind: values[2],
                        sourceContext,
                        initializerValue: initializerValues?.size === 1 ? initializerValues.values().next().value : null,
                        provisional: Boolean(property.provisional)
                    };
                }
            }
        }

        for (const { owner, group, input } of declarationInputs) {
            const declarationGroup = declarationGroups.get(`${owner}:${group}`);
            if (declarationGroup) declarationGroup.inputs.push(input);
        }
        for (const { owner, group, count } of declarationGroupEnds) {
            const declarationGroup = declarationGroups.get(`${owner}:${group}`);
            if (declarationGroup) declarationGroup.count = count;
        }

        const abiPolicyPropertiesByKey = new Map();
        for (const input of procedureAbiPolicyInputs) {
            const key = `${input.module}:${input.owner}:abi-policy-input:${input.identity}`;
            if (abiPolicyPropertiesByKey.has(key)) throw new Error("Repeated compiler procedure ABI policy input.");
            abiPolicyPropertiesByKey.set(key, input);
        }
        const abiPolicyMarkersByKey = new Map();
        for (const relationship of this.compilerSemanticRelationships) {
            if (!relationship.kind.startsWith("abi-policy-input:")) continue;
            const key = `${relationship.module}:${relationship.source}:${relationship.kind}`;
            if (relationship.sourceDomain !== "symbol" || relationship.targetDomain !== "symbol" ||
                relationship.source !== relationship.target || relationship.ordinal < 1 || abiPolicyMarkersByKey.has(key)) {
                throw new Error("Invalid or repeated compiler procedure ABI policy marker.");
            }
            abiPolicyMarkersByKey.set(key, relationship);
        }
        for (const [key, input] of abiPolicyPropertiesByKey) {
            const capability = this.compilerSemanticCapabilities.find((item) =>
                item.module === input.module && item.feature === "procedure-abi-policy-inputs");
            const marker = abiPolicyMarkersByKey.get(key);
            if (capability?.coverage !== "available" || !marker ||
                marker.target !== input.owner || marker.ordinal < 1) {
                throw new Error("Compiler procedure ABI policy input is missing its capability or statement marker.");
            }
            factsFor(input.owner).procedureAbiPolicyInputs.push({
                identity: input.identity,
                statement: marker.ordinal,
                writtenConvention: input.writtenConvention,
                managedString: input.managedString,
                provisional: input.provisional
            });
            abiPolicyMarkersByKey.delete(key);
        }
        if (abiPolicyMarkersByKey.size) throw new Error("Compiler procedure ABI policy marker has no matching property.");

        for (const group of declarationGroups.values()) {
            group.inputs.sort((first, second) => first.ordinal - second.ordinal);
            if (group.count === null || group.count !== group.inputs.length ||
                group.inputs.some((input, index) => input.ordinal !== index + 1)) continue;
            const completeGroup = { identity: group.identity, statement: group.statement, kind: group.kind,
                count: group.count, inputs: group.inputs, provisional: properties.some((property) =>
                    property.domain === "symbol" && property.identity === group.owner && property.provisional) };
            factsFor(group.owner).declarationTypeGroups.push(completeGroup);
            for (const input of group.inputs) {
                factsFor(input.symbol).declarationInputs.push({ ...input, group: {
                    identity: group.identity, statement: group.statement, kind: group.kind, count: group.count
                }, provisional: completeGroup.provisional });
            }
        }

        for (const facts of this.compilerFactsBySemanticIdentity.values()) {
            facts.declarationTypeGroups.sort((first, second) => first.statement - second.statement || first.identity - second.identity);
            facts.declarationInputs.sort((first, second) =>
                first.group.statement - second.group.statement || first.group.identity - second.group.identity ||
                first.ordinal - second.ordinal || first.symbol - second.symbol
            );
            facts.procedureTypingInputs.sort((first, second) =>
                first.statement - second.statement || first.identity - second.identity
            );
            facts.procedureWrittenVisibility.sort((first, second) => first.statement - second.statement);
            facts.procedureAbiPolicyInputs.sort((first, second) =>
                first.statement - second.statement || first.identity - second.identity
            );
            facts.aggregateAccess?.sections.sort((first, second) => first.ordinal - second.ordinal);
            facts.constantValues = [...new Map(facts.constantValues.map((constant) =>
                [`${constant.kind}:${constant.value}`, constant])).values()];
            facts.sourceHeaderPolicies.sort((first, second) => first.source - second.source);
            facts.sourceHeaderLibraries.sort((first, second) => first.source - second.source || first.identity - second.identity);
            facts.namespaceImportReceipts.sort((first, second) => first.statement - second.statement);
            facts.namespaceImports.sort((first, second) => first.statement - second.statement);
            facts.namespaceDeclarations.sort((first, second) => first.construct - second.construct);
            facts.namespaceDeclarationInputs.sort((first, second) => first.construct - second.construct);
            facts.enumElementInputs.sort((first, second) =>
                first.filePath.localeCompare(second.filePath) || first.line - second.line ||
                first.startColumn - second.startColumn || first.ordinal - second.ordinal
            );
        }

        if (!this.partial && this.compilerParameterAliases.size) {
            // A source write is a positive observation. Earlier zero records
            // may precede body parsing, so they cannot establish read-only use.
            const written = new Set(properties.filter((property) => property.domain === "symbol" &&
                property.name === "direct-source-write" && property.value === "1" && property.provisional !== true)
                .map((property) => property.identity));
            for (const [variable, parameter] of this.compilerParameterAliases) {
                if (!parameter || !written.has(variable)) continue;
                factsFor(parameter).parameterDirectSourceWrite = true;
                factsFor(variable).parameterDirectSourceWrite = true;
            }
        }

        for (const [semanticId, nativeId] of semanticToNative) {
            const facts = this.compilerFactsBySemanticIdentity.get(semanticId);
            if (!facts) continue;
            const nativeFacts = this.compilerFactsByNativeSymbolId.get(nativeId) || facts;
            if (nativeFacts !== facts) {
                for (const key of ["properties", "declarationTypeGroups", "declarationInputs", "formalWrittenTypes", "constantValues",
                    "procedureTypingInputs", "procedureWrittenVisibility", "procedureAbiPolicyInputs", "sourceHeaderPolicies",
                    "sourceHeaderLibraries", "namespaceImportReceipts", "namespaceImports", "namespaceDeclarations",
                    "namespaceDeclarationInputs", "storageTypeObservations", "valueConstObservations", "aggregateSizeObservations",
                    "arrayBoundsObservations", "fieldLayoutObservations", "procedureCallingConventionObservations",
                    "procedureOverrideObservations", "symbolVisibilityObservations", "abstractMemberCountObservations",
                    "symbolStorageClassObservations", "parameterPassingModeObservations", "enumElementInputs"])
                    nativeFacts[key].push(...facts[key]);
                if (facts.aggregateAccess) nativeFacts.aggregateAccess = facts.aggregateAccess;
                if (facts.scalarStringDeclaration) nativeFacts.scalarStringDeclaration = facts.scalarStringDeclaration;
                if (facts.parameterDirectSourceWrite === true) nativeFacts.parameterDirectSourceWrite = true;
            }
            this.compilerFactsByNativeSymbolId.set(nativeId, nativeFacts);
        }
        const allCompilerFacts = new Set([
            ...this.compilerFactsBySemanticIdentity.values(),
            ...this.compilerFactsByNativeSymbolId.values()
        ]);
        for (const facts of allCompilerFacts) {
            const valueConst = new Set(facts.valueConstObservations || []);
            facts.valueConst = valueConst.size === 1 && !valueConst.has(null) ? valueConst.values().next().value : null;
            delete facts.valueConstObservations;
            const layouts = new Map((facts.storageTypeObservations || []).map((layout) => [
                `${layout.primitive}:${layout.pointerDepth}:${layout.isReference}:${layout.storageBytes}:${layout.constBits || ""}`,
                layout
            ]));
            if (layouts.size === 1) facts.storageType = layouts.values().next().value;
            else if (layouts.size > 1) facts.storageType = null;
            delete facts.storageTypeObservations;
            const aggregateSizes = new Set(facts.aggregateSizeObservations || []);
            if (aggregateSizes.size === 1) facts.aggregateSizeBytes = aggregateSizes.values().next().value;
            else if (aggregateSizes.size > 1) facts.aggregateSizeBytes = null;
            delete facts.aggregateSizeObservations;
            const arrayBounds = new Map((facts.arrayBoundsObservations || []).map((bounds) => [
                JSON.stringify(bounds), bounds
            ]));
            if (arrayBounds.size === 1) facts.arrayBounds = arrayBounds.values().next().value;
            else if (arrayBounds.size > 1) facts.arrayBounds = null;
            delete facts.arrayBoundsObservations;
            const fieldLayouts = new Map((facts.fieldLayoutObservations || []).map((layout) => [
                `${layout.owner}:${layout.byteOffset}`,
                layout
            ]));
            if (fieldLayouts.size === 1) facts.fieldLayout = fieldLayouts.values().next().value;
            else if (fieldLayouts.size > 1) facts.fieldLayout = null;
            delete facts.fieldLayoutObservations;
            const callingConventions = new Set(facts.procedureCallingConventionObservations || []);
            if (callingConventions.size === 1) facts.procedureCallingConvention = callingConventions.values().next().value;
            else if (callingConventions.size > 1) facts.procedureCallingConvention = null;
            delete facts.procedureCallingConventionObservations;
            const returnByReferenceModes = new Set(facts.procedureReturnByReferenceObservations || []);
            if (returnByReferenceModes.size === 1) facts.procedureReturnsByReference = returnByReferenceModes.values().next().value;
            else if (returnByReferenceModes.size > 1) facts.procedureReturnsByReference = null;
            delete facts.procedureReturnByReferenceObservations;
            const overrides = new Map((facts.procedureOverrideObservations || []).map((override) => [
                `${override.compilerSymbolId}:${override.qualifiedName.toLowerCase()}`,
                override
            ]));
            if (overrides.size === 1) facts.overriddenProcedure = overrides.values().next().value;
            else if (overrides.size > 1) facts.overriddenProcedure = null;
            delete facts.procedureOverrideObservations;
            const visibilities = new Set(facts.symbolVisibilityObservations || []);
            if (visibilities.size === 1) facts.compilerVisibility = visibilities.values().next().value;
            else if (visibilities.size > 1) facts.compilerVisibility = null;
            delete facts.symbolVisibilityObservations;
            const abstractMemberCounts = new Set(facts.abstractMemberCountObservations || []);
            if (abstractMemberCounts.size === 1) facts.abstractMemberCount = abstractMemberCounts.values().next().value;
            else if (abstractMemberCounts.size > 1) facts.abstractMemberCount = null;
            delete facts.abstractMemberCountObservations;
            const storageClasses = new Set(facts.symbolStorageClassObservations || []);
            if (storageClasses.size === 1) facts.compilerStorageClass = storageClasses.values().next().value;
            else if (storageClasses.size > 1) facts.compilerStorageClass = null;
            delete facts.symbolStorageClassObservations;
            const parameterModes = new Map((facts.parameterPassingModeObservations || []).map((parameter) => [
                `${parameter.mode}:${parameter.dimensions}:${parameter.optional}:${parameter.receiver}`,
                parameter
            ]));
            if (parameterModes.size === 1) facts.parameterPassing = parameterModes.values().next().value;
            else if (parameterModes.size > 1) facts.parameterPassing = null;
            delete facts.parameterPassingModeObservations;
        }
        const arraySymbols = new Set((analysis.semanticArrayBounds || [])
            .filter((bounds) => Number.isSafeInteger(bounds.identity) && bounds.identity > 0)
            .map((bounds) => bounds.identity));
        const fieldSymbols = new Set((analysis.semanticFieldLayouts || [])
            .filter((layout) => Number.isSafeInteger(layout.symbol) && layout.symbol > 0)
            .map((layout) => layout.symbol));
        const declarationHoverBindingIndex = (symbolIds, perLineLimit) => {
            if (this.partial || symbolIds.size > MAX_COMPILER_ARRAY_STORAGE_HOVER_FACTS) return null;
            const index = new Map();
            const sourceByPath = new Map([...this.sources.values()]
                .map((source) => [compilerPathKey(source.uri.fsPath), source]));
            let declarationFacts = 0;
            for (const binding of analysis.semanticBindings || []) {
                if (binding.role !== "declaration" || binding.physical !== true ||
                    !Number.isSafeInteger(binding.symbol) || !symbolIds.has(binding.symbol) ||
                    typeof binding.filePath !== "string" || !binding.filePath ||
                    !Number.isSafeInteger(binding.startLine) || binding.startLine < 1 ||
                    !Number.isSafeInteger(binding.startColumn) || binding.startColumn < 0 ||
                    binding.endLine !== binding.startLine || !Number.isSafeInteger(binding.endColumn) ||
                    binding.endColumn <= binding.startColumn) continue;
                if (++declarationFacts > MAX_COMPILER_ARRAY_STORAGE_HOVER_FACTS) return null;
                const source = sourceByPath.get(compilerPathKey(binding.filePath));
                const line = binding.startLine - 1;
                if (!source || line >= source.lineOffsets.length) continue;
                const start = positionOffset(source, line, binding.startColumn);
                const end = positionOffset(source, line, binding.endColumn);
                if (end <= start) continue;
                const fileKey = compilerPathKey(binding.filePath);
                const lines = index.get(fileKey) || new Map();
                let records = lines.get(line);
                if (records === null) continue;
                if (!records) records = [];
                if (records.length >= perLineLimit) {
                    lines.set(line, null);
                } else {
                    records.push({ symbol: binding.symbol, startColumn: binding.startColumn, endColumn: binding.endColumn });
                    lines.set(line, records);
                }
                index.set(fileKey, lines);
            }
            for (const lines of index.values()) {
                for (const records of lines.values()) {
                    if (Array.isArray(records)) records.sort((first, second) => first.startColumn - second.startColumn);
                }
            }
            return index;
        };
        this.compilerArrayDeclarationBindingsByFileLine = declarationHoverBindingIndex(
            arraySymbols, MAX_COMPILER_ARRAY_DECLARATION_HOVER_FACTS_PER_LINE
        );
        this.compilerFieldDeclarationBindingsByFileLine = declarationHoverBindingIndex(
            fieldSymbols, MAX_COMPILER_FIELD_DECLARATION_HOVER_FACTS_PER_LINE
        );
        const aggregateSymbols = new Set();
        for (const [symbol, facts] of this.compilerFactsBySemanticIdentity) {
            if (!sourceSemanticSymbols.has(symbol)) continue;
            const hasLayout = Number.isSafeInteger(facts.aggregateSizeBytes) && facts.aggregateSizeBytes > 0 ||
                Number.isSafeInteger(facts.abstractMemberCount) && facts.abstractMemberCount >= 0 ||
                (facts.properties || []).some((property) =>
                    ["natural-alignment", "packing-alignment"].includes(property.name));
            if (hasLayout) aggregateSymbols.add(symbol);
        }
        this.compilerAggregateDeclarationBindingsByFileLine = declarationHoverBindingIndex(
            aggregateSymbols, MAX_COMPILER_FIELD_DECLARATION_HOVER_FACTS_PER_LINE
        );
        const parameterSymbols = new Set();
        for (const parameter of analysis.semanticProcedureParameterModes || []) {
            for (const symbol of [parameter.parameter, parameter.variable]) {
                if (Number.isSafeInteger(symbol) && symbol > 0 && sourceSemanticSymbols.has(symbol) &&
                    this.compilerFactsBySemanticIdentity.get(symbol)?.parameterPassing) {
                    parameterSymbols.add(symbol);
                }
            }
        }
        this.compilerParameterDeclarationBindingsByFileLine = declarationHoverBindingIndex(
            parameterSymbols, MAX_COMPILER_FIELD_DECLARATION_HOVER_FACTS_PER_LINE
        );
        const procedureSymbols = new Set((analysis.semanticProcedureCallConventions || [])
            .filter((procedure) => Number.isSafeInteger(procedure.symbol) && procedure.symbol > 0 &&
                this.compilerFactsBySemanticIdentity.get(procedure.symbol)?.procedureCallingConvention)
            .map((procedure) => procedure.symbol));
        this.compilerProcedureDeclarationBindingsByFileLine = declarationHoverBindingIndex(
            procedureSymbols, MAX_COMPILER_FIELD_DECLARATION_HOVER_FACTS_PER_LINE
        );
        const storageSymbols = new Set((analysis.semanticSymbolStorageClasses || [])
            .filter((symbol) => Number.isSafeInteger(symbol.symbol) && symbol.symbol > 0 &&
                ["external", "static", "local", "shared", "global", "thread-local"].includes(symbol.storage) &&
                this.compilerFactsBySemanticIdentity.get(symbol.symbol)?.compilerStorageClass)
            .map((symbol) => symbol.symbol));
        this.compilerStorageClassDeclarationBindingsByFileLine = declarationHoverBindingIndex(
            storageSymbols, MAX_COMPILER_FIELD_DECLARATION_HOVER_FACTS_PER_LINE
        );
        const storageTypeSymbols = new Set((analysis.semanticNormalizedTypes || [])
            .filter((type) => Number.isSafeInteger(type.identity) && type.identity > 0 &&
                this.compilerFactsBySemanticIdentity.get(type.identity)?.storageType)
            .map((type) => type.identity));
        this.compilerStorageTypeDeclarationBindingsByFileLine = declarationHoverBindingIndex(
            storageTypeSymbols, MAX_COMPILER_FIELD_DECLARATION_HOVER_FACTS_PER_LINE
        );
        const enumElementSymbols = new Set((analysis.semanticEnumElementInputs || [])
            .filter((input) => Number.isSafeInteger(input.symbol) && input.symbol > 0 &&
                this.compilerFactsBySemanticIdentity.get(input.symbol)?.enumElementInputs?.length)
            .map((input) => input.symbol));
        this.compilerEnumElementDeclarationBindingsByFileLine = declarationHoverBindingIndex(
            enumElementSymbols, MAX_COMPILER_FIELD_DECLARATION_HOVER_FACTS_PER_LINE
        );
        for (const entry of this.inner.entries) {
            const nativeId = this.canonicalSymbolIds.get(entry.compilerSymbolId) || entry.compilerSymbolId;
            if (nativeId) entry.compilerFacts = this.compilerFactsByNativeSymbolId.get(nativeId) || null;
        }
        for (const entry of this.inner.entries) {
            if (entry.declaration.type !== "parameter" || entry.provisional || entry.declaration.provisional) continue;
            const passing = entry.compilerFacts?.parameterPassing;
            const parentDeclaration = entry.declaration.parentDeclaration;
            if (!parentDeclaration || !Array.isArray(parentDeclaration.parameters)) continue;
            const matchingParameters = parentDeclaration.parameters.filter((parameter) =>
                normalizeIdentifier(parameter.name) === normalizeIdentifier(entry.name)
            );
            if (matchingParameters.length !== 1) continue;
            const nativeId = this.canonicalSymbolIds.get(entry.compilerSymbolId) || entry.compilerSymbolId;
            const formalDefaultValue = formalDefaultValuesByNativeParameter.get(nativeId);
            if (formalDefaultValue) matchingParameters[0].compilerDefaultValue = formalDefaultValue;
            if (passing) {
                const writtenModeFacts = (entry.compilerFacts?.properties || []).filter((property) =>
                    property.name === "formal-written-mode"
                );
                const writtenModeValues = new Set(writtenModeFacts.map((property) =>
                    property.provisional !== true ? semanticPropertyInteger(property.value) : null
                ));
                const modeWritten = writtenModeFacts.length > 0 && writtenModeValues.size === 1 &&
                    (writtenModeValues.has(0) || writtenModeValues.has(1))
                    ? writtenModeValues.values().next().value === 1
                    : null;
                matchingParameters[0].compilerParameterPassing = {
                    ...passing,
                    ...(modeWritten === null || passing.mode !== "byval" && passing.mode !== "byref"
                        ? {}
                        : { modeWritten })
                };
            }
        }
    }

    compilerHeaderLibrariesAt(uri, position) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (this.partial || !document || !filePath || !position ||
            !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) ||
            position.line < 0 || position.line >= document.lineOffsets.length) return [];
        const lineStart = document.lineOffsets[position.line];
        const lineEnd = document.lineOffsets[position.line + 1] ?? document.text.length;
        const lineText = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
        if (!/^\s*#\s*(?:inclib|libpath)\b/i.test(lineText)) return [];

        const requestedOffset = positionOffset(document, position.line, position.character);
        if (requestedOffset < 0) return [];
        const sourceKey = compilerPathKey(filePath);
        const matches = new Map();
        for (const library of this.compilerHeaderLibrariesByFile.get(sourceKey) || []) {
            const location = library?.location;
            if (!location || location.status !== "mapped" || !location.filePath ||
                compilerPathKey(location.filePath) !== sourceKey ||
                !["inclib", "libpath"].includes(library.kind) || typeof library.value !== "string" ||
                !Number.isSafeInteger(location.startLine) || !Number.isSafeInteger(location.startColumn) ||
                !Number.isSafeInteger(location.endLine) || !Number.isSafeInteger(location.endColumn)) continue;
            const start = semanticSourceColumnOffset(document, location.startLine - 1, location.startColumn);
            const end = semanticSourceColumnOffset(document, location.endLine - 1, location.endColumn);
            if (start === null || end === null || end <= start || requestedOffset < start || requestedOffset >= end) continue;
            matches.set(`${library.kind}\t${library.value}`, { kind: library.kind, value: library.value });
            if (matches.size >= 8) break;
        }
        return [...matches.values()];
    }

    compilerHeaderLibrariesForFile(filePath) {
        if (this.partial || typeof filePath !== "string" || !filePath) return [];
        return (this.compilerHeaderLibrariesByFile.get(compilerPathKey(filePath)) || [])
            .slice(0, 8)
            .map((library) => ({ kind: library.kind, value: library.value, filePath: library.filePath }));
    }

    attachSourceDocumentation(markers, selectedEntries = null) {
        if (this.partial || !Array.isArray(markers) ||
            markers.length > MAX_COMPILER_SOURCE_DOCUMENTATION_COMMENTS) return;

        const sourcesByPath = new Map();
        for (const source of this.sources.values()) {
            const filePath = source.uri?.fsPath || source.uri?.path;
            if (typeof filePath !== "string" || !filePath) continue;
            sourcesByPath.set(compilerPathKey(filePath), source);
        }
        const sourceForUri = (uri) => {
            const filePath = uri?.fsPath || uri?.path;
            if (typeof filePath !== "string" || !filePath) return null;
            return sourcesByPath.get(compilerPathKey(filePath)) || null;
        };
        const entries = selectedEntries || [...this.inner.entries, ...(this.preprocessor?.entries || [])];
        const documentationLinesBySource = new Map();
        const parameterEntriesBySourceLine = new Map();
        for (const entry of entries) {
            if (entry.declaration.type !== "parameter" || entry.provisional || entry.declaration.provisional || !entry.uri ||
                !Number.isSafeInteger(entry.declaration.line)) continue;
            const source = sourceForUri(entry.uri);
            if (!source) continue;
            const parametersByLine = parameterEntriesBySourceLine.get(source) || new Map();
            const parameters = parametersByLine.get(entry.declaration.line) || [];
            parameters.push(entry);
            parametersByLine.set(entry.declaration.line, parameters);
            parameterEntriesBySourceLine.set(source, parametersByLine);
        }
        const inlineParameterDocumentation = new Map();
        let documentationCharacters = 0;
        for (const [source, parametersByLine] of parameterEntriesBySourceLine) {
            for (const [line, parameters] of parametersByLine) {
                const lineStart = source.lineOffsets[line];
                const lineEnd = source.lineOffsets[line + 1] ?? source.text.length;
                const lineText = source.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
                const markerColumn = lineText.indexOf("''");
                if (markerColumn < 0 || !maskFreeBasicText(lineText.slice(0, markerColumn)).trimEnd().endsWith("_")) continue;
                const candidates = parameters.filter((entry) => entry.declaration.endColumn <= markerColumn);
                if (candidates.length !== 1) continue;
                const documentation = lineText.slice(markerColumn + 2).replace(/^[ \t]/, "").trimEnd();
                if (!documentation) continue;
                if (documentation.length > MAX_COMPILER_SOURCE_DOCUMENTATION_CHARACTERS) return;
                documentationCharacters += documentation.length;
                if (documentationCharacters > MAX_COMPILER_SOURCE_DOCUMENTATION_TOTAL_CHARACTERS) return;
                inlineParameterDocumentation.set(candidates[0], documentation);
            }
        }
        for (const marker of markers) {
            if (marker?.kind !== "apostrophe" || marker.status !== "mapped" ||
                typeof marker.filePath !== "string" || !marker.filePath ||
                !Number.isSafeInteger(marker.startLine) || !Number.isSafeInteger(marker.startColumn) ||
                marker.startLine !== marker.endLine) continue;
            const source = sourcesByPath.get(compilerPathKey(marker.filePath));
            const line = marker.startLine - 1;
            if (!source || line < 0 || line >= source.lineOffsets.length) continue;
            const lineStart = source.lineOffsets[line];
            const lineEnd = source.lineOffsets[line + 1] ?? source.text.length;
            const lineText = source.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
            const markerOffset = semanticSourceColumnOffset(source, line, marker.startColumn);
            if (markerOffset === null || markerOffset < lineStart || !source.text.startsWith("''", markerOffset)) continue;
            const markerColumn = markerOffset - lineStart;
            const documentation = lineText.slice(markerOffset - lineStart + 2)
                .replace(/^[ \t]/, "")
                .trimEnd();
            if (documentation.length > MAX_COMPILER_SOURCE_DOCUMENTATION_CHARACTERS) return;
            documentationCharacters += documentation.length;
            if (documentationCharacters > MAX_COMPILER_SOURCE_DOCUMENTATION_TOTAL_CHARACTERS) return;
            if (lineText.slice(0, markerColumn).trim()) continue;
            const comments = documentationLinesBySource.get(source) || new Map();
            comments.set(line, documentation);
            documentationLinesBySource.set(source, comments);
        }

        for (const entry of entries) {
            if (entry.provisional || entry.declaration.provisional || !entry.uri ||
                !Number.isSafeInteger(entry.declaration.line)) continue;
            const source = sourceForUri(entry.uri);
            const documentationLines = source && documentationLinesBySource.get(source);
            if (!source || !documentationLines) continue;
            let line = entry.declaration.line - 1;
            const selectedLines = [];
            while (line >= 0 && selectedLines.length < MAX_COMPILER_SOURCE_DOCUMENTATION_LINES) {
                const documentation = documentationLines.get(line);
                if (documentation !== undefined) {
                    selectedLines.unshift(documentation);
                    line--;
                    continue;
                }
                const lineStart = source.lineOffsets[line];
                const lineEnd = source.lineOffsets[line + 1] ?? source.text.length;
                const sourceLine = source.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
                if (/^\s*#\s*(?:if|ifdef|ifndef|pragma)\b/i.test(sourceLine)) {
                    line--;
                    continue;
                }
                break;
            }
            if (!selectedLines.length) continue;
            const documentation = selectedLines.join("\n").trim();
            if (documentation && documentation.length <= MAX_COMPILER_SOURCE_DOCUMENTATION_CHARACTERS) {
                entry.declaration.documentation = documentation;
            }
        }
        for (const [entry, documentation] of inlineParameterDocumentation) {
            entry.declaration.documentation = documentation;
            const parameters = entry.declaration.parentDeclaration?.parameters;
            if (!Array.isArray(parameters)) continue;
            const matching = parameters.filter((parameter) =>
                normalizeIdentifier(parameter.name) === normalizeIdentifier(entry.name)
            );
            if (matching.length === 1) matching[0].documentation = documentation;
        }
        for (const entry of entries) {
            if (entry.declaration.type !== "parameter" || !entry.declaration.parentDeclaration) continue;
            const parent = entry.declaration.parentDeclaration;
            if (!Array.isArray(parent.parameters)) continue;
            const matching = parent.parameters.filter((parameter) =>
                normalizeIdentifier(parameter.name) === normalizeIdentifier(entry.name)
            );
            if (matching.length !== 1) continue;
            const tagged = sourceParameterDocumentation(parent.documentation, entry.name);
            const documentation = [...new Set([
                entry.declaration.documentation,
                matching[0].documentation,
                tagged
            ].filter((value) => typeof value === "string" && value))].join("\n\n");
            if (!documentation || documentation.length > MAX_COMPILER_SOURCE_DOCUMENTATION_CHARACTERS) continue;
            entry.declaration.documentation = documentation;
            matching[0].documentation = documentation;
        }
    }

    bindProcedures(analysis, expanded, byLine) {
        const families = new Map();
        const nativeDeclarationIds = new Map((analysis.symbolGraph?.uses || [])
            .filter((binding) => binding.kind === "declaration")
            .map((binding) => [`${binding.line}:${binding.startColumn}:${binding.endColumn}:${binding.name.toLowerCase()}`, binding.id]));
        const records = (analysis.bindings || []).map((binding) => {
            const token = bindingToken(binding, byLine);
            if (!token) throw new Error("Compiler procedure binding does not match a complete identifier or qualified name.");
            return { ...binding, token };
        });
        this.procedureBindings = records;
        for (const binding of records) {
            if (binding.kind !== "declaration") continue;
            const qualifiedName = binding.name.toLowerCase();
            /* The native inventory may anchor a qualified declaration at the
               start of the whole spelling, while the parser-only inventory
               anchors it at the terminal token. Match that exact declaration
               by compiler range and qualified name in either representation. */
            const nativeSymbolId = nativeDeclarationIds.get(`${binding.line}:${binding.startColumn}:${binding.endColumn}:${qualifiedName}`);
            const entry = expanded.entriesByOffset.get(binding.token.offset) || (nativeSymbolId && this.inner.entries.find((candidate) => candidate.compilerSymbolId === nativeSymbolId)) || this.inner.entries.find((candidate) =>
                candidate.declaration.line === binding.line &&
                candidate.declaration.startColumn === binding.startColumn &&
                candidate.qualifiedName.toLowerCase() === qualifiedName
            );
            if (!entry || !CALLABLE_TYPES.has(entry.declaration.type)) continue;
            /* Native IDs belong to one translation unit, never a workspace-wide
               spelling family. They use deterministic declaration order, not
               addresses, and are rebuilt when the saved snapshot changes. */
            entry.id = `compiler:${analysis.dependencies[0] || this.expandedUri}:${binding.id}`;
            entry.compilerProcedureId = binding.id;
            const family = families.get(binding.id) || [];
            family.push(entry);
            families.set(binding.id, family);
        }
        for (const binding of records) {
            if (binding.kind !== "call") continue;
            const family = families.get(binding.id) || [];
            /* Seed the shared resolver, including negative results. References
               and chained member lookup must observe the same compiler choice
               as definition and signature help, not rescore that call later. */
            this.inner.resolutionCache.set(`${expanded.key}:${binding.token.offset}`, family.length ? [family[0]] : []);
        }
    }

    getDocument(uri) {
        const document = uri.toString() === this.expandedUri.toString()
            ? this.inner.getDocument(uri) : this.sources.get(uri.toString());
        // Physical documents already have this derived index. Build it lazily
        // for the expanded view so every query sees the same token layout,
        // without indexing that view for ordinary source-only editor requests.
        if (document && !document.byLine) {
            document.byLine = new Map();
            for (const token of document.tokens) {
                const tokens = document.byLine.get(token.line) || [];
                tokens.push(token);
                document.byLine.set(token.line, tokens);
            }
        }
        return document;
    }

    compilerDocumentLinks(uri) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (!document || !filePath) return [];

        const sourceLines = document.text.split(/\r\n|\n|\r/);
        const sourceKey = compilerPathKey(filePath);
        const links = [];
        for (const outcome of this.compilerIncludeOutcomes) {
            if (!["opened", "include-once", "pragma-once"].includes(outcome.outcome) ||
                !outcome.resolved || !path.isAbsolute(outcome.resolved) || !outcome.directive ||
                compilerPathKey(outcome.directive.filePath) !== sourceKey) continue;

            const startLine = outcome.directive.startLine - 1;
            const endLine = outcome.directive.endLine - 1;
            const startCharacter = outcome.directive.startColumn;
            const endCharacter = outcome.directive.endColumn;
            if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
                startLine < 0 || endLine < startLine || endLine >= sourceLines.length ||
                !Number.isSafeInteger(startCharacter) || !Number.isSafeInteger(endCharacter) ||
                startCharacter < 0 || endCharacter < startCharacter ||
                startCharacter > sourceLines[startLine].length || endCharacter > sourceLines[endLine].length) continue;

            links.push({
                target: outcome.resolved,
                requested: outcome.requested,
                outcome: outcome.outcome,
                start: { line: startLine, character: startCharacter },
                end: { line: endLine, character: endCharacter }
            });
        }
        return links.sort((first, second) =>
            first.start.line - second.start.line || first.start.character - second.start.character
        ).slice(0, 5000);
    }

    compilerInactiveSourceRanges(uri) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (!document || !filePath) return [];

        const sourceKey = compilerPathKey(filePath);
        const regions = this.compilerSkippedRegions.filter((region) =>
            region.physical === true && compilerPathKey(region.filePath) === sourceKey
        );
        /* Use only whole-line ranges; byte-column conversions are not guessed. */
        if (!regions.length || regions.length > MAX_COMPILER_INACTIVE_RANGES) return [];

        const lineStarts = [0];
        const newline = /\r\n|\n|\r/g;
        let match;
        while ((match = newline.exec(document.text))) lineStarts.push(match.index + match[0].length);

        const ranges = [];
        for (const region of regions) {
            if (region.startColumn !== 0 || region.endColumn !== 0 ||
                !Number.isSafeInteger(region.startLine) || !Number.isSafeInteger(region.endLine) ||
                region.startLine < 1 || region.endLine < region.startLine || region.startLine > lineStarts.length ||
                region.endLine > lineStarts.length + 1) continue;
            const start = lineStarts[region.startLine - 1];
            const end = lineStarts[region.endLine - 1] ?? document.text.length;
            if (end > start) ranges.push({ start, end });
        }
        return ranges.sort((first, second) => first.start - second.start || first.end - second.end);
    }

    compilerRemKeywordDisabledLineOffsets(uri) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (!document || typeof filePath !== "string" || !path.isAbsolute(filePath) ||
            !Array.isArray(this.compilerRemKeywordDisableOptions) ||
            this.compilerRemKeywordDisableOptions.length > MAX_COMPILER_REM_IDENTIFIER_OVERRIDES ||
            !Array.isArray(document.lineOffsets)) return [];

        const sourceKey = compilerPathKey(filePath);
        const offsets = new Set();
        for (const option of this.compilerRemKeywordDisableOptions) {
            if (!option || typeof option.filePath !== "string" ||
                compilerPathKey(option.filePath) !== sourceKey ||
                !Number.isSafeInteger(option.line) || option.line < 1 || option.line > document.lineOffsets.length) continue;
            offsets.add(document.lineOffsets[option.line - 1]);
            if (offsets.size > MAX_COMPILER_REM_IDENTIFIER_OVERRIDES) return [];
        }
        return [...offsets].sort((first, second) => first - second);
    }

    compilerDefaultEscapedStringRanges(uri) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (!document || typeof filePath !== "string" || !path.isAbsolute(filePath) ||
            !Array.isArray(document.defaultEscapedStringRanges) ||
            document.defaultEscapedStringRanges.length > MAX_COMPILER_ESCAPED_STRING_RANGES) return [];
        return document.defaultEscapedStringRanges;
    }

    compilerDefaultEscapedStringRangeAt(uri, offset) {
        if (!Number.isSafeInteger(offset) || offset < 0) return null;
        const ranges = this.compilerDefaultEscapedStringRanges(uri);
        let low = 0;
        let high = ranges.length;
        while (low < high) {
            const middle = low + ((high - low) >> 1);
            if (ranges[middle].start <= offset) low = middle + 1;
            else high = middle;
        }
        const range = ranges[low - 1];
        return range && range.start <= offset && offset < range.end ? range : null;
    }

    compilerCodeContext(uri, offset, offsetAdjustment = 0) {
        const document = this.getDocument(uri);
        if (!document || !Number.isSafeInteger(offset) || offset < 0 || offset > document.text.length ||
            ![0, 1].includes(offsetAdjustment)) return null;
        /* Option spans cover statements, not just literals. A point lookup
           after a string misses the span that settled its escaped quote.
           Use the complete snapshot here, retaining only small cursor facts
           across the worker boundary. The editor's BOM is absent on disk. */
        const prefix = offsetAdjustment ? "\uFEFF" : "";
        const text = prefix + document.text;
        const cursor = offset + offsetAdjustment;
        const nativeRanges = this.compilerDefaultEscapedStringRanges(uri);
        const ranges = offsetAdjustment ? nativeRanges.map((range) => ({
            start: range.start + offsetAdjustment, end: range.end + offsetAdjustment
        })) : nativeRanges;
        const remOffsets = this.compilerRemIdentifierOffsets(uri);
        const disabledLineOffsets = this.compilerRemKeywordDisabledLineOffsets(uri);
        const details = getCodeContextDetails(text, cursor, ranges,
            offsetAdjustment ? remOffsets.map((value) => value + offsetAdjustment) : remOffsets,
            offsetAdjustment ? disabledLineOffsets.map((value) => value + offsetAdjustment) : disabledLineOffsets);
        const context = details.context;
        if (context !== "code") return { context };
        const masked = prefix + document.masked;
        const lineStart = Math.max(masked.lastIndexOf("\n", cursor - 1), masked.lastIndexOf("\r", cursor - 1)) + 1;
        /* Do not copy an unbounded generated source line into an editor reply. */
        if (cursor - lineStart > MAX_COMPILER_COMPLETION_GAP_CHARACTERS) return { context: "unknown" };
        return {
            context,
            typeCompletionContext: details.typeCompletionContext,
            maskedLinePrefix: masked.slice(lineStart, cursor),
            callContext: findCallContextInMaskedText(masked, cursor),
            signatureCallContext: findSignatureCallContextInMaskedText(masked, cursor)
        };
    }

    compilerRemIdentifierOffsets(uri) {
        const filePath = uri.fsPath || uri.path;
        if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return [];
        return this.compilerPhysicalRemIdentifierOffsetsByFile?.get(compilerPathKey(filePath)) || [];
    }

    compilerBracketMaskOverrides(uri) {
        return {
            remIdentifierOffsets: this.compilerRemIdentifierOffsets(uri),
            remKeywordDisabledLineOffsets: this.compilerRemKeywordDisabledLineOffsets(uri),
            defaultEscapedStringRanges: this.compilerDefaultEscapedStringRanges(uri)
        };
    }

    compilerConditionalDecisionAt(uri, position) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (!document || !filePath || !Number.isSafeInteger(position?.line) ||
            !Number.isSafeInteger(position?.character) || position.line < 0 ||
            position.line >= document.lineOffsets.length || position.character < 0) return null;

        const lineStart = document.lineOffsets[position.line];
        const lineEnd = document.lineOffsets[position.line + 1] ?? document.text.length;
        const lineLength = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "").length;
        if (position.character > lineLength) return null;
        const candidates = this.compilerConditionalDecisionsBySourceLine
            .get(compilerPathKey(filePath))?.get(position.line) || [];
        const line = position.line + 1;
        const matches = candidates.filter(({ startLine, startColumn, endLine, endColumn }) =>
            line >= startLine && line <= endLine &&
            (line !== startLine || position.character >= startColumn) &&
            (line !== endLine || position.character < endColumn)
        );
        if (!matches.length) return null;

        const identity = (match) => JSON.stringify([
            match.directive, match.decision.evaluation, match.decision.result, match.decision.selected
        ]);
        const selectedIdentity = identity(matches[0]);
        if (matches.some((match) => identity(match) !== selectedIdentity)) return null;
        const { decision, directive } = matches[0];
        return {
            directive,
            evaluation: decision.evaluation,
            result: decision.result,
            selected: decision.selected
        };
    }

    compilerMacroSignatureAt(uri, name, line, startColumn, endColumn) {
        if (!this.semanticSidecarOnly || this.partial || typeof name !== "string" || !name ||
            !Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(startColumn) || startColumn < 0 ||
            !Number.isSafeInteger(endColumn) || endColumn <= startColumn) return null;
        const filePath = uri.fsPath || uri.path;
        if (!filePath) return null;
        const invocations = this.compilerMacroInvocationsBySourceLine
            .get(compilerPathKey(filePath))?.get(line - 1) || [];
        const matches = invocations.filter((invocation) =>
            invocation.startColumn === startColumn && invocation.endColumn === endColumn
        );
        if (!matches.length) return null;

        const signatures = new Map();
        const selectedDefinitions = new Set();
        for (const invocation of matches) {
            const definition = this.compilerMacroDefinitionsById.get(invocation.definition);
            if (!definition || normalizeIdentifier(definition.name) !== normalizeIdentifier(name) ||
                !Number.isSafeInteger(definition.parameterCount) || definition.parameterCount < 0 ||
                !Number.isSafeInteger(definition.flags)) continue;
            selectedDefinitions.add(definition.id);
            const sourceParameters = this.compilerMacroParametersByDefinition.get(definition.id) || [];
            if (sourceParameters.length !== definition.parameterCount || sourceParameters.some((parameter, index) =>
                parameter.ordinal !== index || typeof parameter.name !== "string" ||
                !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(parameter.name))) continue;
            let parameterNames = sourceParameters.map((parameter) => parameter.name);
            let sourceDefinition = "";
            for (const site of this.compilerMacroDefinitionSitesById.get(definition.id) || []) {
                if (typeof site.filePath !== "string" || !path.isAbsolute(site.filePath)) continue;
                const sourceKey = compilerPathKey(site.filePath);
                const source = this.compilerSourceDocumentsByPath.get(sourceKey);
                const line = site.startLine - 1;
                if (!source || !Number.isSafeInteger(line) || line < 0 || line >= source.lineOffsets.length ||
                    !Number.isSafeInteger(site.startColumn) || site.startColumn < 0) continue;
                const declarationsByLine = this.compilerMacroDeclarationsByFile.get(sourceKey) || new Map();
                sourceDefinition = macroDefinitionPreview(source, {
                    line,
                    startColumn: site.startColumn,
                    endColumn: site.startColumn + definition.name.length,
                    name: definition.name
                });
                let declarations = declarationsByLine.get(line);
                if (declarations === undefined) {
                    const lineStart = source.lineOffsets[line];
                    const lineEnd = source.lineOffsets[line + 1] ?? source.text.length;
                    const lineText = source.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
                    if (lineText.length > MAX_COMPILER_MACRO_SIGNATURE_SOURCE_LINE) continue;
                    declarations = parseFreeBasicText(lineText).declarations
                        .filter((candidate) => candidate.type === "macro");
                    declarationsByLine.set(line, declarations);
                    this.compilerMacroDeclarationsByFile.set(sourceKey, declarationsByLine);
                }
                const matched = declarations.filter((candidate) => candidate.startColumn === site.startColumn &&
                    normalizeIdentifier(candidate.name) === normalizeIdentifier(definition.name) &&
                    Array.isArray(candidate.parameters) && candidate.parameters.length === sourceParameters.length &&
                    candidate.parameters.every((parameter, index) =>
                        normalizeIdentifier(parameter.name) === normalizeIdentifier(sourceParameters[index].name)));
                if (matched.length === 1) {
                    parameterNames = matched[0].parameters.map((parameter) => parameter.name);
                    break;
                }
            }
            const parameters = sourceParameters.map((parameter, index) => {
                const variadic = (definition.flags & 4) !== 0 && index === sourceParameters.length - 1;
                const parameterName = parameterNames[index];
                return {
                    name: parameterName,
                    label: parameterName + (variadic ? "..." : ""),
                    typeName: "",
                    optional: false,
                    variadic
                };
            });
            const hasParentheses = parameters.length > 0 || definition.argless === true;
            const signature = `${name}${hasParentheses ? `(${parameters.map((parameter) => parameter.label).join(", ")})` : ""}`;
            const key = JSON.stringify([signature.toLowerCase(), parameters.map((parameter) => parameter.label.toLowerCase())]);
            if (!signatures.has(key)) signatures.set(key, { name, signature, parameters, sourceDefinition });
        }
        if (signatures.size !== 1) return null;
        const signature = signatures.values().next().value;
        if (selectedDefinitions.size !== 1) signature.sourceDefinition = "";
        return signature;
    }

    compilerDefinedNameProbeAt(uri, position) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (!document || !filePath || !Number.isSafeInteger(position?.line) ||
            !Number.isSafeInteger(position?.character) || position.line < 0 ||
            position.line >= document.lineOffsets.length || position.character < 0) return null;

        const lineStart = document.lineOffsets[position.line];
        const lineEnd = document.lineOffsets[position.line + 1] ?? document.text.length;
        const lineLength = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "").length;
        if (position.character > lineLength) return null;
        const candidates = this.compilerDefinedNameProbesBySourceLine
            .get(compilerPathKey(filePath))?.get(position.line) || [];
        const sourceSpelling = (probe) => {
            const start = positionOffset(document, probe.startLine - 1, probe.startColumn);
            const end = positionOffset(document, probe.endLine - 1, probe.endColumn);
            if (start === null || end === null || end <= start) return probe.spelling;
            const text = document.text.slice(start, end)
                .replace(/[ \t]*_[ \t]*(?:\r\n|\r|\n)[ \t]*/g, " ")
                .replace(/\s+/g, " ")
                .replace(/\s*\.\s*/g, ".")
                .replace(/\s*::\s*/g, "::")
                .trim();
            return text || probe.spelling;
        };
        const line = position.line + 1;
        const matches = candidates.filter((probe) =>
            line >= probe.startLine && line <= probe.endLine &&
            (line !== probe.startLine || position.character >= probe.startColumn) &&
            (line !== probe.endLine || position.character < probe.endColumn)
        );
        if (!matches.length) return null;
        const identity = (probe) => JSON.stringify([sourceSpelling(probe).toLowerCase(), probe.defined, probe.symbol]);
        const selectedIdentity = identity(matches[0]);
        if (matches.some((probe) => identity(probe) !== selectedIdentity)) return null;
        const probe = matches[0];
        return { spelling: sourceSpelling(probe), defined: probe.defined };
    }

    compilerDeferredMacroReferenceAt(uri, position) {
        if (!position || !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)) return null;
        const context = this.tokenAt(uri, position.line, position.character);
        if (!context || context.document !== this.sources.get(uri.toString())) return null;
        return this.preprocessor?.deferredReferenceAt?.(context.document, context.token) || null;
    }

    compilerTypeInlayHints(uri, start, end) {
        const document = this.getDocument(uri);
        if (!document || !start || !end || !Number.isSafeInteger(start.line) ||
            !Number.isSafeInteger(start.character) || !Number.isSafeInteger(end.line) ||
            !Number.isSafeInteger(end.character) || start.line < 0 || end.line < start.line ||
            start.line >= document.lineOffsets.length || end.line >= document.lineOffsets.length) return [];

        if (this.semanticSidecarOnly) {
            const sourceFacts = this.compilerSidecarExpressionsByRange.get(uri.toString());
            if (!sourceFacts) return [];
            const hints = new Map();
            const parsed = parseFreeBasicText(document.text, this.compilerRemIdentifierOffsets(uri),
                this.compilerDefaultEscapedStringRanges(uri));
            const declarations = parsed.declarations;
            for (const declaration of declarations) {
                if (!["variable", "const"].includes(declaration.type) || declaration.typeName ||
                    /[$%!#&]$/.test(declaration.name) || declaration.line < start.line || declaration.line > end.line ||
                    declaration.line === start.line && declaration.endColumn < start.character ||
                    declaration.line === end.line && declaration.endColumn > end.character) continue;

                let expression = null;
                if (declaration.endLine > declaration.line) {
                    const initializerRange = compilerSidecarMultilineInitializerRange(document, parsed, declaration);
                    if (initializerRange) {
                        expression = sourceFacts.get(`${initializerRange.start}:${initializerRange.end}`);
                    }
                } else {
                    const lineStart = document.lineOffsets[declaration.line];
                    const lineEnd = document.lineOffsets[declaration.line + 1] ?? document.text.length;
                    const lineText = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
                    let initializer = declaration.initializer;
                    let initializerStart = initializer
                        ? lineText.indexOf(initializer, declaration.endColumn)
                        : -1;
                    if (declaration.type === "const" && initializerStart < 0) {
                        const maskedLine = document.masked.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
                        const equals = maskedLine.indexOf("=", declaration.endColumn);
                        if (equals >= 0) {
                            initializerStart = equals + 1;
                            while (/\s/.test(maskedLine[initializerStart] || "")) initializerStart++;
                            let initializerEnd = maskedLine.length;
                            while (initializerEnd > initializerStart && /\s/.test(maskedLine[initializerEnd - 1])) initializerEnd--;
                            initializer = lineText.slice(initializerStart, initializerEnd);
                        }
                    }
                    if (initializerStart >= 0 && initializer) {
                        const startOffset = lineStart + initializerStart;
                        const endOffset = startOffset + initializer.length;
                        expression = sourceFacts.get(`${startOffset}:${endOffset}`);
                    }
                }
                if (!expression || expression.provisional || !expression.typeName) continue;

                const key = `${declaration.line}:${declaration.endColumn}`;
                if (!hints.has(key)) hints.set(key, {
                    position: { line: declaration.line, character: declaration.endColumn },
                    label: `: ${expression.typeName}`,
                    typeName: expression.typeName
                });
                if (hints.size >= MAX_COMPILER_TYPE_INLAY_HINTS) break;
            }
            return [...hints.values()].sort((first, second) =>
                first.position.line - second.position.line || first.position.character - second.position.character
            );
        }

        const hints = new Map();
        for (const entry of this.inner.entries) {
            const declaration = entry.declaration;
            if (entry.uri.toString() !== uri.toString() || !["variable", "const", "function", "parameter"].includes(declaration.type) ||
                declaration.provisional || declaration.line < start.line || declaration.line > end.line ||
                declaration.line === start.line && declaration.endColumn < start.character ||
                declaration.line === end.line && declaration.endColumn > end.character) continue;

            const lineStart = document.lineOffsets[declaration.line];
            const followingCharacter = document.text[lineStart + declaration.endColumn] || "";
            const sourceLine = declaration.sourceLine || "";
            const implicitForCounter = declaration.type === "variable" &&
                /^\s*for\s+(?:each\s+)?[A-Za-z_][A-Za-z0-9_]*[$%!#&]?\s*(?:=|\bin\b)/i.test(sourceLine);
            const writtenSyntax = implicitForCounter
                ? [sourceLine]
                : [declaration.detail, declaration.signature, sourceLine].filter(Boolean);
            const hasWrittenType = declaration.type === "parameter"
                ? /\bAS\b/i.test(declaration.detail || "")
                : writtenSyntax.some((syntax) => {
                if (declaration.type !== "function") return /\bAS\b/i.test(syntax);
                const resultClause = syntax.slice(syntax.lastIndexOf(")") + 1);
                return /\bAS\b/i.test(resultClause);
            });
            /* Native symbol types are authoritative; source spelling only suppresses redundant hints. */
            if (hasWrittenType || "$%!#&".includes(followingCharacter)) continue;
            const typeName = declaration.typeName || entry.nativeSymbol?.typeName || "";
            if (!typeName || declaration.endColumn <= declaration.startColumn) continue;

            const key = `${declaration.line}:${declaration.endColumn}`;
            if (!hints.has(key)) hints.set(key, {
                position: { line: declaration.line, character: declaration.endColumn },
                label: `: ${typeName}`,
                typeName
            });
            if (hints.size >= MAX_COMPILER_TYPE_INLAY_HINTS) break;
        }

        /* The source parser has no declaration node for these implicit variables. */
        const nativeHintsBySite = new Map();
        if (hints.size < MAX_COMPILER_TYPE_INLAY_HINTS) {
            for (const binding of this.nativeBindings || []) {
                if (binding.kind !== "declaration") continue;
                const physical = this.expandedToSource.get(binding.token.offset);
                if (!physical || physical.uri.toString() !== uri.toString()) continue;
                const symbol = this.nativeSymbols.get(binding.id);
                if (symbol?.symbolClass !== COMPILER_VARIABLE_SYMBOL_CLASS) continue;
                const occurrence = physical.occurrence;
                const line = occurrence.line;
                const startColumn = occurrence.startColumn;
                const endColumn = occurrence.endColumn;
                if (line < start.line || line > end.line ||
                    line === start.line && endColumn < start.character ||
                    line === end.line && startColumn > end.character) continue;

                const lineStart = document.lineOffsets[line];
                const lineEnd = document.lineOffsets[line + 1] ?? document.text.length;
                const maskedLine = document.masked.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
                let writtenSyntax = maskedLine;
                if (/\bAS\b/i.test(maskedLine)) {
                    /* A physical line can contain several colon-separated statements. */
                    const statements = document.sourceStatements ||
                        (document.sourceStatements = parseFreeBasicText(document.text,
                            this.compilerRemIdentifierOffsets(uri), this.compilerDefaultEscapedStringRanges(uri)).statements);
                    const sourceStatement = statements.find((statement) =>
                        line >= statement.startLine && line <= statement.endLine &&
                        (line !== statement.startLine || startColumn >= statement.startColumn) &&
                        (line !== statement.endLine || startColumn <= statement.endColumn)
                    );
                    writtenSyntax = sourceStatement?.maskedText || maskedLine;
                }
                const sourceName = document.text.slice(lineStart + startColumn, lineStart + endColumn);
                const followingCharacter = document.text[lineStart + endColumn] || "";
                if (/\bAS\b/i.test(writtenSyntax) ||
                    /[$%!#&]$/.test(sourceName) || "$%!#&".includes(followingCharacter)) continue;

                const typeName = symbol?.typeName || "";
                if (!typeName || endColumn <= startColumn) continue;
                const key = `${line}:${endColumn}`;
                const selected = nativeHintsBySite.get(key);
                if (selected === undefined) {
                    nativeHintsBySite.set(key, {
                        position: { line, character: endColumn },
                        typeName
                    });
                } else if (selected && selected.typeName !== typeName) {
                    /* One physical macro argument can bind differently in several expansions. */
                    nativeHintsBySite.set(key, null);
                }
                if (nativeHintsBySite.size + hints.size >= MAX_COMPILER_TYPE_INLAY_HINTS) break;
            }
        }
        for (const [key, record] of nativeHintsBySite) {
            if (record && !hints.has(key)) hints.set(key, {
                ...record,
                label: `: ${record.typeName}`
            });
        }

        return [...hints.values()].sort((first, second) =>
            first.position.line - second.position.line || first.position.character - second.position.character
        );
    }

    compilerForEntryResultInlayHints(uri, start, end, checkCancelled = () => {}) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (this.partial || !document || !filePath || !Array.isArray(this.semanticForEntryResults) ||
            !start || !end || !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) ||
            !Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character) || start.line < 0 ||
            end.line < start.line || end.line >= document.lineOffsets.length) return [];

        const requestedStart = positionOffset(document, start.line, start.character);
        const requestedEnd = positionOffset(document, end.line, end.character);
        if (requestedStart < 0 || requestedEnd < requestedStart) return [];

        const sourceKey = compilerPathKey(filePath);
        const resultsByRange = new Map();
        for (let index = 0; index < this.semanticForEntryResults.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const result = this.semanticForEntryResults[index];
            if (!result || (result.result !== "skip" && result.result !== "enter") ||
                result.provisional || !result.filePath ||
                compilerPathKey(result.filePath) !== sourceKey || !Number.isSafeInteger(result.startLine) ||
                !Number.isSafeInteger(result.endLine) || result.startLine !== result.endLine ||
                result.startLine < 1 || !Number.isSafeInteger(result.startColumn) ||
                !Number.isSafeInteger(result.endColumn)) continue;

            const startOffset = semanticSourceColumnOffset(document, result.startLine - 1, result.startColumn);
            const endOffset = semanticSourceColumnOffset(document, result.endLine - 1, result.endColumn);
            if (startOffset === null || endOffset === null || endOffset <= startOffset ||
                endOffset < requestedStart || endOffset > requestedEnd) continue;

            const key = `${startOffset}:${endOffset}`;
            let group = resultsByRange.get(key);
            if (!group) {
                group = { startOffset, endOffset, outcomes: new Set() };
                resultsByRange.set(key, group);
            }
            group.outcomes.add(result.result);
        }

        const hints = [];
        for (const group of resultsByRange.values()) {
            if (group.outcomes.size !== 1 || !group.outcomes.has("skip") ||
                !/^for\b/i.test(document.text.slice(group.startOffset, group.endOffset))) continue;
            hints.push({
                position: sourcePositionAtOffset(document, group.endOffset),
                label: "body skipped",
                tooltip: "The compiler's initial FOR test fails; the loop body is not entered."
            });
            if (hints.length >= MAX_COMPILER_FOR_ENTRY_INLAY_HINTS) break;
        }
        return hints;
    }

    compilerIfConditionInlayHints(uri, start, end, checkCancelled = () => {}) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (this.partial || !document || !filePath || !Array.isArray(this.semanticIfConditionResults) || !start || !end ||
            !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) ||
            !Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character) ||
            start.line < 0 || start.character < 0 || end.character < 0 ||
            end.line < start.line || end.line >= document.lineOffsets.length) return [];
        const requestedStart = positionOffset(document, start.line, start.character);
        const requestedEnd = positionOffset(document, end.line, end.character);
        if (requestedStart < 0 || requestedEnd < requestedStart) return [];
        const sourceKey = compilerPathKey(filePath);
        const groups = new Map();
        for (let index = 0; index < this.semanticIfConditionResults.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const result = this.semanticIfConditionResults[index];
            if (!result || result.provisional || typeof result.result !== "boolean" || !result.filePath ||
                compilerPathKey(result.filePath) !== sourceKey) continue;
            const first = semanticSourceColumnOffset(document, result.startLine - 1, result.startColumn);
            const last = semanticSourceColumnOffset(document, result.endLine - 1, result.endColumn);
            if (first === null || last === null || last <= first || last < requestedStart || last > requestedEnd) continue;
            const group = groups.get(last) || { results: new Set() };
            group.results.add(result.result);
            groups.set(last, group);
        }
        return [...groups].filter(([, group]) => group.results.size === 1).map(([offset, group]) => {
            const result = group.results.has(true) ? "true" : "false";
            return { position: sourcePositionAtOffset(document, offset), label: `always ${result}`,
                tooltip: `The compiler proves this IF/ELSEIF predicate is always ${result} in the selected build. ` +
                    "An ELSEIF is evaluated only when earlier branches are not taken." };
        });
    }

    compilerAssignmentInputAt(uri, position) {
        if (this.partial || !uri || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const filePath = uri.fsPath || uri.path;
        if (!filePath) return null;
        const records = this.compilerAssignmentInputsByFile.get(compilerPathKey(filePath))?.get(position.line);
        if (!Array.isArray(records)) return null;
        const matches = records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn);
        if (!matches.length) return null;
        const facts = new Set(matches.map((record) => JSON.stringify([
            record.startColumn, record.endColumn,
            record.operatorCode, record.operatorKind, record.targetName,
            record.leftTypeName, record.rightTypeName
        ])));
        return facts.size === 1 ? matches[0] : null;
    }

    compilerTargetWideLiteralAt(uri, position) {
        const document = this.getDocument(uri);
        if (this.partial || !document || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 ||
            position.line >= document.lineOffsets.length || position.character < 0) return null;
        const source = this.compilerTargetWideLiteralExpressionsByLine.get(uri.toString());
        if (!source) return null;
        const candidates = source.get(position.line);
        if (!Array.isArray(candidates)) return null;
        const offset = positionOffset(document, position.line, position.character);
        let selectedWidth = Number.MAX_SAFE_INTEGER;
        const summaries = new Map();
        for (const expression of candidates) {
            if (expression.startOffset > offset || expression.endOffset <= offset) continue;
            const width = expression.endOffset - expression.startOffset;
            if (width > selectedWidth) break;
            const summary = expression.targetWideLiteral;
            if (!summary) continue;
            if (width < selectedWidth) {
                selectedWidth = width;
                summaries.clear();
            }
            summaries.set(JSON.stringify(summary), summary);
        }
        return summaries.size === 1 ? summaries.values().next().value : null;
    }

    compilerArrayDeclarationSymbolIdsAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return [];
        const lines = this.compilerArrayDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return [];
        const symbols = new Set(records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn).map((record) => record.symbol));
        return [...symbols];
    }

    compilerFieldDeclarationSymbolIdsAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return [];
        const lines = this.compilerFieldDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return [];
        const symbols = new Set(records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn).map((record) => record.symbol));
        return [...symbols];
    }

    compilerFieldDeclarationRangeAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const lines = this.compilerFieldDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return null;
        const matches = records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn);
        if (!matches.length) return null;
        const ranges = new Map(matches.map((record) => [
            `${record.startColumn}:${record.endColumn}`,
            { startColumn: record.startColumn, endColumn: record.endColumn }
        ]));
        return ranges.size === 1 ? { line: position.line, ...ranges.values().next().value } : null;
    }

    compilerAggregateDeclarationSymbolIdsAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return [];
        const lines = this.compilerAggregateDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return [];
        const symbols = new Set(records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn).map((record) => record.symbol));
        return [...symbols];
    }

    compilerAggregateDeclarationRangeAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const lines = this.compilerAggregateDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return null;
        const matches = records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn);
        if (!matches.length) return null;
        const ranges = new Map(matches.map((record) => [
            `${record.startColumn}:${record.endColumn}`,
            { startColumn: record.startColumn, endColumn: record.endColumn }
        ]));
        return ranges.size === 1 ? { line: position.line, ...ranges.values().next().value } : null;
    }

    compilerParameterDeclarationSymbolIdsAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return [];
        const lines = this.compilerParameterDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return [];
        const symbols = new Set(records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn).map((record) => record.symbol));
        return [...symbols];
    }

    compilerParameterDeclarationRangeAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const lines = this.compilerParameterDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return null;
        const matches = records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn);
        if (!matches.length) return null;
        const ranges = new Map(matches.map((record) => [
            `${record.startColumn}:${record.endColumn}`,
            { startColumn: record.startColumn, endColumn: record.endColumn }
        ]));
        return ranges.size === 1 ? { line: position.line, ...ranges.values().next().value } : null;
    }

    compilerProcedureDeclarationSymbolIdsAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return [];
        const lines = this.compilerProcedureDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return [];
        const symbols = new Set(records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn).map((record) => record.symbol));
        return [...symbols];
    }

    compilerProcedureDeclarationRangeAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const lines = this.compilerProcedureDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return null;
        const matches = records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn);
        if (!matches.length) return null;
        const ranges = new Map(matches.map((record) => [
            `${record.startColumn}:${record.endColumn}`,
            { startColumn: record.startColumn, endColumn: record.endColumn }
        ]));
        return ranges.size === 1 ? { line: position.line, ...ranges.values().next().value } : null;
    }

    compilerStorageClassDeclarationSymbolIdsAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return [];
        const lines = this.compilerStorageClassDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return [];
        const symbols = new Set(records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn).map((record) => record.symbol));
        return [...symbols];
    }

    compilerPrimitiveTypeAt(uri, position, checkCancelled = () => {}) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const inputs = this.compilerPrimitiveTypesByFileLine?.get(compilerPathKey(filePath))?.get(position.line) || [];
        const token = this.getDocument(uri)?.byLine.get(position.line)?.find((entry) => entry.kind === "identifier" &&
            position.character >= entry.startColumn && position.character < entry.endColumn);
        if (!token) return null;
        let selected = null, signature = "";
        for (const input of inputs) {
            checkCancelled();
            if (input.startLine !== input.endLine || input.startColumn !== token.startColumn || input.endColumn !== token.endColumn) continue;
            if (!input.layout) return null;
            const current = JSON.stringify(input.layout);
            if (signature && signature !== current) return null;
            signature = current;
            selected = input.layout;
        }
        return selected;
    }

    compilerStorageTypeDeclarationSymbolIdsAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return [];
        const lines = this.compilerStorageTypeDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return [];
        const symbols = new Set(records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn).map((record) => record.symbol));
        return [...symbols];
    }

    compilerStorageTypeDeclarationRangeAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const lines = this.compilerStorageTypeDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return null;
        const matches = records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn);
        if (!matches.length) return null;
        const ranges = new Map(matches.map((record) => [
            `${record.startColumn}:${record.endColumn}`,
            { startColumn: record.startColumn, endColumn: record.endColumn }
        ]));
        return ranges.size === 1 ? { line: position.line, ...ranges.values().next().value } : null;
    }

    compilerEnumElementDeclarationSymbolIdsAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return [];
        const lines = this.compilerEnumElementDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return [];
        const symbols = new Set(records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn).map((record) => record.symbol));
        return [...symbols];
    }

    compilerEnumElementDeclarationRangeAt(uri, position) {
        const filePath = uri?.fsPath || uri?.path;
        if (this.partial || !filePath || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const lines = this.compilerEnumElementDeclarationBindingsByFileLine?.get(compilerPathKey(filePath));
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return null;
        const matches = records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn);
        if (!matches.length) return null;
        const ranges = new Map(matches.map((record) => [
            `${record.startColumn}:${record.endColumn}`,
            { startColumn: record.startColumn, endColumn: record.endColumn }
        ]));
        return ranges.size === 1 ? { line: position.line, ...ranges.values().next().value } : null;
    }

    compilerSelectCaseLoweringAt(uri, position) {
        const document = this.getDocument(uri);
        if (this.partial || !document || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 ||
            position.line >= document.lineOffsets.length || position.character < 0) return null;
        const source = this.compilerSelectCaseLoweringExpressionsByLine.get(uri.toString());
        if (!source) return null;
        const candidates = source.get(position.line);
        if (!Array.isArray(candidates)) return null;
        const offset = positionOffset(document, position.line, position.character);
        let selectedWidth = Number.MAX_SAFE_INTEGER;
        const summaries = new Map();
        for (const expression of candidates) {
            if (expression.startOffset > offset || expression.endOffset <= offset) continue;
            const width = expression.endOffset - expression.startOffset;
            if (width > selectedWidth) break;
            if (width < selectedWidth) {
                selectedWidth = width;
                summaries.clear();
            }
            summaries.set(JSON.stringify(expression.selectCaseLowering), expression.selectCaseLowering);
        }
        return summaries.size === 1 ? summaries.values().next().value : null;
    }

    compilerRuntimeMacroOperationAt(uri, position) {
        if (this.partial || !uri || !position || !Number.isSafeInteger(position.line) ||
            !Number.isSafeInteger(position.character) || position.line < 0 || position.character < 0) return null;
        const lines = this.compilerRuntimeMacroOperationsByFile?.get(uri.toString());
        const records = lines?.get(position.line);
        if (!Array.isArray(records)) return null;
        const matching = records.filter((record) => position.character >= record.startColumn &&
            position.character < record.endColumn);
        if (!matching.length || matching.some((record) => !record.fact)) return null;
        const facts = new Map(matching.map((record) => [JSON.stringify(record.fact), record.fact]));
        return facts.size === 1 ? facts.values().next().value : null;
    }

    compilerUnreachableSourceRanges(uri, checkCancelled = () => {}) {
        const document = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (this.partial || !document || !filePath || !Array.isArray(this.semanticUnreachableStatements)) return [];
        const sourceKey = compilerPathKey(filePath);
        const ranges = new Map();
        for (let index = 0; index < this.semanticUnreachableStatements.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const statement = this.semanticUnreachableStatements[index];
            if (!statement || !statement.filePath || compilerPathKey(statement.filePath) !== sourceKey ||
                !Number.isSafeInteger(statement.startLine) || !Number.isSafeInteger(statement.startColumn) ||
                !Number.isSafeInteger(statement.endLine) || !Number.isSafeInteger(statement.endColumn)) continue;

            const startOffset = semanticSourceColumnOffset(document, statement.startLine - 1, statement.startColumn);
            const endOffset = semanticSourceColumnOffset(document, statement.endLine - 1, statement.endColumn);
            if (startOffset === null || endOffset === null || endOffset <= startOffset) continue;
            // The native fact covers the physical opening token, not arbitrary
            // trailing source. Do not guess a whole-line dead-code range.
            ranges.set(`${startOffset}:${endOffset}`, { start: startOffset, end: endOffset });
        }
        return [...ranges.values()];
    }

    compilerUnreachableStatementInlayHints(uri, start, end, checkCancelled = () => {}) {
        const document = this.getDocument(uri);
        if (!document || !start || !end || !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) ||
            !Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character) || start.line < 0 ||
            end.line < start.line || end.line >= document.lineOffsets.length) return [];
        const requestedStart = positionOffset(document, start.line, start.character);
        const requestedEnd = positionOffset(document, end.line, end.character);
        if (requestedStart < 0 || requestedEnd < requestedStart) return [];
        const hintsByOffset = new Map();
        for (const { end: endOffset } of this.compilerUnreachableSourceRanges(uri, checkCancelled)) {
            if (endOffset < requestedStart || endOffset > requestedEnd) continue;
            hintsByOffset.set(endOffset, {
                position: sourcePositionAtOffset(document, endOffset),
                label: "unreachable",
                tooltip: "The compiler's control-flow graph finds no reachable path to this statement in the selected build."
            });
        }
        return [...hintsByOffset.values()];
    }

    compilerParameterInlayHints(uri, start, end, checkCancelled = () => {}) {
        const source = this.getDocument(uri);
        if (!source || !start || !end || !Number.isSafeInteger(start.line) ||
            !Number.isSafeInteger(start.character) || !Number.isSafeInteger(end.line) ||
            !Number.isSafeInteger(end.character) || start.line < 0 || end.line < start.line ||
            start.line >= source.lineOffsets.length || end.line >= source.lineOffsets.length) return [];

        const cacheKey = uri.toString();
        let records = this.compilerParameterInlayHintCache.get(cacheKey);
        if (records === undefined) {
            const expanded = this.inner.getDocument(this.expandedUri);
            const callsBySymbol = new Map();
            for (let index = 0; index < this.expressionGraph.nodes.length; index++) {
                if ((index & 255) === 0) checkCancelled();
                const call = this.expressionGraph.nodes[index];
                if (call.kind !== "call" || call.options !== 1 || !call.target || call.provisional || call.invalid ||
                    this.nativeSymbols.get(call.target)?.symbolClass !== 3 || !call.inputs[1]) continue;
                const identity = this.canonicalSymbolIds.get(call.target) || call.target;
                const calls = callsBySymbol.get(identity) || [];
                calls.push({
                    call,
                    startOffset: positionOffset(expanded, call.start.line, call.start.character),
                    endOffset: positionOffset(expanded, call.end.line, call.end.character)
                });
                callsBySymbol.set(identity, calls);
            }
            for (const calls of callsBySymbol.values()) {
                calls.sort((first, second) => first.startOffset - second.startOffset || first.endOffset - second.endOffset);
                let maximumEnd = -1;
                for (const call of calls) {
                    maximumEnd = Math.max(maximumEnd, call.endOffset);
                    call.prefixMaximumEnd = maximumEnd;
                }
            }
            const procedureEntriesBySymbol = new Map();
            const parameterEntriesByDeclaration = new Map();
            const bareCallNames = new Set();
            const receiverProcedures = new Set();
            for (const parameter of this.semanticProcedureParameterModes) {
                if (parameter.receiver !== true || parameter.ordinal !== -1) continue;
                const nativeId = this.semanticSymbolNativeIds.get(parameter.procedure);
                if (nativeId) receiverProcedures.add(this.canonicalSymbolIds.get(nativeId) || nativeId);
            }
            for (const entry of this.inner.entries) {
                if (entry.declaration.type === "parameter" && entry.declaration.parentDeclaration) {
                    const parent = entry.declaration.parentDeclaration;
                    const parameters = parameterEntriesByDeclaration.get(parent) || [];
                    parameters.push(entry);
                    parameterEntriesByDeclaration.set(parent, parameters);
                }
                if (!entry.compilerSymbolId || !["function", "sub", "property", "constructor"].includes(entry.declaration.type)) continue;
                const family = procedureEntriesBySymbol.get(entry.compilerSymbolId) || [];
                family.push(entry);
                procedureEntriesBySymbol.set(entry.compilerSymbolId, family);
                const identity = this.canonicalSymbolIds.get(entry.compilerSymbolId) || entry.compilerSymbolId;
                if (callsBySymbol.has(identity) && entry.declaration.type !== "constructor") {
                    bareCallNames.add(normalizeIdentifier(entry.name.split(".").at(-1)));
                }
            }
            const constructorsByOwner = new Map();
            for (const [symbolId, family] of procedureEntriesBySymbol) {
                const symbol = this.nativeSymbols.get(symbolId);
                if (symbol?.symbolClass !== 3 || !family.some((entry) => entry.declaration.type === "constructor")) continue;
                const owner = this.canonicalSymbolIds.get(symbol.owner || symbol.namespace) || symbol.owner || symbol.namespace;
                if (!owner) continue;
                const constructors = constructorsByOwner.get(owner) || [];
                constructors.push(symbolId);
                constructorsByOwner.set(owner, constructors);
            }

            const parameterNamesBySymbol = new Map();
            const parameterNames = (symbolId) => {
                if (parameterNamesBySymbol.has(symbolId)) return parameterNamesBySymbol.get(symbolId);
                const canonicalSymbol = this.canonicalSymbolIds.get(symbolId) || symbolId;
                const family = procedureEntriesBySymbol.get(symbolId) || procedureEntriesBySymbol.get(canonicalSymbol) ||
                    this.nativeFamilies.get(symbolId) || this.nativeFamilies.get(canonicalSymbol) || [];
                const callable = family.filter((entry) =>
                    ["function", "sub", "property", "constructor"].includes(entry.declaration.type) &&
                    !entry.conditional && !entry.provisional && !entry.declaration.provisional &&
                    Array.isArray(entry.declaration.parameters) && entry.declaration.parameters.length
                );
                const prototypes = callable.filter((entry) => entry.declaration.modifiers?.includes("DECLARE"));
                const selected = prototypes.length ? prototypes : callable;
                if (!selected.length) {
                    parameterNamesBySymbol.set(symbolId, null);
                    return null;
                }
                const names = (entry) => entry.declaration.parameters.map((parameter) =>
                    typeof parameter.name === "string" ? parameter.name : ""
                );
                const first = names(selected[0]);
                if (first.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(name)) ||
                    selected.some((entry) => JSON.stringify(names(entry).map(normalizeIdentifier)) !==
                        JSON.stringify(first.map(normalizeIdentifier)))) {
                    parameterNamesBySymbol.set(symbolId, null);
                    return null;
                }
                const parameterEntries = selected.flatMap((entry) => parameterEntriesByDeclaration.get(entry.declaration) || []);
                const parameters = first.map((name, ordinal) => {
                    const modes = new Set(selected.map((entry) =>
                        entry.declaration.parameters[ordinal]?.compilerParameterPassing?.mode || ""
                    ));
                    const mode = modes.size === 1 ? modes.values().next().value : "";
                    const declarationLocation = compilerParameterDeclarationLocation(this, parameterEntries, name);
                    return {
                        name,
                        passingMode: ["byval", "byref", "bydesc", "vararg"].includes(mode) ? mode : "",
                        ...(declarationLocation ? { declarationLocation } : {})
                    };
                });
                parameterNamesBySymbol.set(symbolId, parameters);
                return parameters;
            };
            const hintsBySite = new Map();
            const addHint = (key, record) => {
                if (!hintsBySite.has(key)) hintsBySite.set(key, record);
                else if (hintsBySite.get(key)?.label !== record.label ||
                    hintsBySite.get(key)?.passingMode !== record.passingMode) hintsBySite.set(key, null);
                else if (hintsBySite.get(key) && JSON.stringify(hintsBySite.get(key).declarationLocation) !==
                    JSON.stringify(record.declarationLocation)) delete hintsBySite.get(key).declarationLocation;
            };
            let visitedTokens = 0;
            let scannedArgumentCharacters = 0;
            let scanLimitReached = false;
            for (const calleeToken of source.tokens) {
                if ((visitedTokens++ & 255) === 0) checkCancelled();
                if (hintsBySite.size >= MAX_COMPILER_PARAMETER_INLAY_HINTS) {
                    scanLimitReached = true;
                    break;
                }
                const nextToken = source.tokens[calleeToken.index + 1];
                // Only names with compiler CALL receipts enter bare-call lookup.
                const openingToken = nextToken?.name === "(" ? nextToken
                    : bareCallNames.has(calleeToken.key) && /[ \t]/.test(source.text[calleeToken.end] || "")
                        ? { ...calleeToken, bare: true } : null;
                if (calleeToken.kind !== "identifier" || !openingToken ||
                    source.entriesByOffset.has(calleeToken.offset)) continue;
                const targets = this.resolveAt(uri, calleeToken.line, calleeToken.startColumn);
                if (targets.length !== 1) continue;
                const target = targets[0];
                const targetId = target.compilerSymbolId || target.nativeSymbol?.id || 0;
                if (!targetId || target.provisional || target.conditional || target.declaration.provisional) continue;
                const targetIds = new Set();
                if (target.nativeSymbol?.symbolClass === 3) {
                    targetIds.add(targetId);
                } else if (["type", "class", "union"].includes(target.declaration.type)) {
                    for (const typeEntry of this.typeEntries(target)) {
                        const typeId = typeEntry.compilerSymbolId || typeEntry.nativeSymbol?.id || 0;
                        const owner = this.canonicalSymbolIds.get(typeId) || typeId;
                        for (const constructorId of constructorsByOwner.get(owner) || []) targetIds.add(constructorId);
                    }
                }
                if (!targetIds.size) continue;
                const parsedArguments = freeBasicCallArgumentRanges(source, openingToken, checkCancelled,
                    MAX_COMPILER_PARAMETER_INLAY_SCAN_CHARACTERS - scannedArgumentCharacters);
                scannedArgumentCharacters += parsedArguments.scanned;
                if (parsedArguments.exceeded) {
                    scanLimitReached = true;
                    break;
                }
                const sourceArguments = parsedArguments.arguments;
                if (!sourceArguments || !sourceArguments.length || sourceArguments.some((argument) => argument?.named)) continue;

                const projectedCalls = new Map();
                const selectedTargets = new Set();
                for (const projected of this.projectPositions(uri, calleeToken.line, calleeToken.startColumn)) {
                    const physicalCallee = this.expandedToSource.get(projected.token?.offset);
                    if (!physicalCallee || physicalCallee.sourceMap !== 0 ||
                        physicalCallee.uri.toString() !== uri.toString() ||
                        physicalCallee.occurrence.offset !== calleeToken.offset) continue;
                    const expandedOffset = positionOffset(expanded, projected.line, projected.character);
                    const projectionCalls = new Map();
                    for (const targetId of targetIds) {
                        const identity = this.canonicalSymbolIds.get(targetId) || targetId;
                        const calls = callsBySymbol.get(identity) || [];
                        let low = 0, high = calls.length;
                        while (low < high) {
                            const middle = (low + high) >> 1;
                            if (calls[middle].startOffset <= expandedOffset) low = middle + 1;
                            else high = middle;
                        }
                        let callIndex = low - 1;
                        let selectedCall = null;
                        let selectedWidth = Number.POSITIVE_INFINITY;
                        while (callIndex >= 0 && calls[callIndex].prefixMaximumEnd > expandedOffset) {
                            let groupStart = callIndex;
                            while (groupStart > 0 && calls[groupStart - 1].startOffset === calls[callIndex].startOffset) groupStart--;
                            for (let index = groupStart; index <= callIndex; index++) {
                                const candidate = calls[index];
                                if (candidate.endOffset <= expandedOffset) continue;
                                const width = candidate.endOffset - candidate.startOffset;
                                if (width < selectedWidth) {
                                    selectedCall = candidate.call;
                                    selectedWidth = width;
                                }
                            }
                            if (selectedCall) break;
                            callIndex = groupStart - 1;
                        }
                        if (selectedCall) projectionCalls.set(selectedCall.id, selectedCall);
                    }
                    if (projectionCalls.size > 1) {
                        selectedTargets.clear();
                        projectedCalls.clear();
                        break;
                    }
                    for (const [callId, call] of projectionCalls) {
                        selectedTargets.add(call.target);
                        projectedCalls.set(callId, call);
                    }
                }
                if (!projectedCalls.size || selectedTargets.size !== 1) continue;

                const selectedArguments = new Map();
                let argumentShapeValid = true;
                for (const call of projectedCalls.values()) {
                    let argumentId = call.inputs[1];
                    let chainLength = 0;
                    while (argumentId && chainLength++ < MAX_COMPILER_PARAMETER_INLAY_ARGUMENTS) {
                        const argument = this.expressionGraph.nodes[argumentId - 1];
                        if (!argument || argument.kind !== "argument" || !Number.isSafeInteger(argument.options) ||
                            argument.options < 1 || argument.options > MAX_COMPILER_PARAMETER_INLAY_ARGUMENTS) {
                            argumentShapeValid = false;
                            break;
                        }
                        const valueId = argument.inputs[1];
                        const previous = selectedArguments.get(argument.options);
                        const hasWrittenValue = Boolean(valueId);
                        if (previous !== undefined && previous !== hasWrittenValue) {
                            argumentShapeValid = false;
                            break;
                        }
                        selectedArguments.set(argument.options, hasWrittenValue);
                        argumentId = argument.inputs[0];
                    }
                    if (!argumentShapeValid || chainLength > MAX_COMPILER_PARAMETER_INLAY_ARGUMENTS) {
                        argumentShapeValid = false;
                        break;
                    }
                }
                const sourceWrittenOrdinals = sourceArguments.flatMap((argument, index) => argument ? [index] : []);
                const hasImplicitReceiver = [...selectedTargets].some((id) =>
                    receiverProcedures.has(this.canonicalSymbolIds.get(id) || id));
                const graphWrittenOrdinals = [...selectedArguments]
                    // The bridge's one-based ARG order includes THIS. G facts
                    // distinguish that hidden slot from written parameters.
                    .filter(([ordinal, hasWrittenValue]) => hasWrittenValue && !(hasImplicitReceiver && ordinal === 1))
                    .map(([ordinal]) => ordinal)
                    .sort((first, second) => first - second);
                if (!argumentShapeValid || !sourceWrittenOrdinals.length ||
                    sourceWrittenOrdinals.length !== graphWrittenOrdinals.length) continue;
                const ordinalBase = graphWrittenOrdinals[0] - sourceWrittenOrdinals[0];
                if (ordinalBase < 1 || graphWrittenOrdinals.some((ordinal, index) =>
                    ordinal !== sourceWrittenOrdinals[index] + ordinalBase)) continue;
                const callsWithNames = [...projectedCalls.values()].map((call) => ({
                    call,
                    names: parameterNames(call.target)
                }));
                if (callsWithNames.some(({ names }) => !names || sourceArguments.length > names.length)) continue;

                for (let ordinal = 0; ordinal < sourceArguments.length; ordinal++) {
                    const argument = sourceArguments[ordinal];
                    if (!argument || selectedArguments.get(ordinal + ordinalBase) !== true) continue;
                    const argumentText = source.text.slice(argument.start, argument.end).trim();
                    const position = sourcePositionAtOffset(source, argument.start);
                    const key = `${uri.toString()}:${argument.start}`;
                    for (const { names } of callsWithNames) {
                        const parameter = names[ordinal];
                        const parameterName = parameter.name;
                        if (normalizeIdentifier(argumentText) === normalizeIdentifier(parameterName)) continue;
                        addHint(key, {
                            position,
                            label: `${parameterName}:`,
                            parameterName,
                            passingMode: parameter.passingMode,
                            ...(parameter.declarationLocation ? { declarationLocation: parameter.declarationLocation } : {})
                        });
                    }
                    if (hintsBySite.size >= MAX_COMPILER_PARAMETER_INLAY_HINTS) break;
                }
            }
            if (scanLimitReached || hintsBySite.size >= MAX_COMPILER_PARAMETER_INLAY_HINTS) records = [];
            else records = [...hintsBySite.values()].filter(Boolean);
            this.compilerParameterInlayHintCache.set(cacheKey, records);
            while (this.compilerParameterInlayHintCache.size > MAX_COMPILER_PARAMETER_INLAY_HINT_CACHE_DOCUMENTS) {
                this.compilerParameterInlayHintCache.delete(this.compilerParameterInlayHintCache.keys().next().value);
            }
        } else {
            this.compilerParameterInlayHintCache.delete(cacheKey);
            this.compilerParameterInlayHintCache.set(cacheKey, records);
        }

        return records.filter((record) => record.position.line >= start.line && record.position.line <= end.line &&
            (record.position.line !== start.line || record.position.character >= start.character) &&
            (record.position.line !== end.line || record.position.character <= end.character));
    }

    compilerSidecarCallResults(uri, name, checkCancelled = () => {}) {
        const document = this.getDocument(uri);
        const sourceFacts = this.compilerSidecarExpressionsByRange.get(uri.toString());
        const nameKey = normalizeIdentifier(name);
        if (!document || !sourceFacts || !nameKey) return { complete: true, calls: [] };

        const matchingClose = new Map();
        const openingParentheses = [];
        for (const [index, token] of document.tokens.entries()) {
            if ((index & 255) === 0) checkCancelled();
            if (token.name === "(") openingParentheses.push(index);
            else if (token.name === ")") {
                const opening = openingParentheses.pop();
                if (opening !== undefined) matchingClose.set(opening, index);
            }
        }

        const calls = [];
        const seen = new Set();
        for (let index = 0; index < document.tokens.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const token = document.tokens[index];
            if (token.kind !== "identifier" || token.key !== nameKey || document.tokens[index + 1]?.name !== "(") continue;
            const closingIndex = matchingClose.get(index + 1);
            if (closingIndex === undefined) continue;

            let calleeStartIndex = index;
            while (calleeStartIndex >= 2 && document.tokens[calleeStartIndex - 1].name === "." &&
                document.tokens[calleeStartIndex - 2].kind === "identifier") calleeStartIndex -= 2;
            const endToken = document.tokens[closingIndex];
            const startOffset = document.tokens[calleeStartIndex].offset;
            const callEndOffset = endToken.end;
            const expression = sourceFacts.get(`${startOffset}:${callEndOffset}`) ||
                sourceFacts.get(`${token.offset}:${callEndOffset}`);
            if (!expression || expression.provisional || !expression.typeName) continue;

            const key = `${token.line}:${token.startColumn}:${token.endColumn}`;
            if (seen.has(key)) continue;
            seen.add(key);
            calls.push({
                filePath: document.uri.fsPath || "",
                line: token.line,
                startColumn: token.startColumn,
                endColumn: token.endColumn,
                typeName: expression.typeName
            });
            if (calls.length > MAX_COMPILER_SIDECAR_CALL_RESULTS) return { complete: false, calls: [] };
        }
        return { complete: true, calls };
    }

    compilerSidecarCallResultsInSnapshot(name, checkCancelled = () => {}) {
        const calls = [];
        for (const source of this.sources.values()) {
            checkCancelled();
            const result = this.compilerSidecarCallResults(source.uri, name, checkCancelled);
            if (!result.complete) return { complete: false, calls: [] };
            calls.push(...result.calls);
            if (calls.length > MAX_COMPILER_SIDECAR_CALL_RESULTS) return { complete: false, calls: [] };
        }
        return { complete: true, calls };
    }

    bindNativeSymbols(analysis, expanded, byLine) {
        const graph = analysis.symbolGraph || { symbols: [], canonicalIds: [], uses: [] };
        this.nativeSymbols = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
        this.canonicalSymbolIds = new Map(graph.canonicalIds);
        this.nativeFamilies = new Map();
        this.compilerNativeProcedureOverrides = new Map();
        this.compilerNativeVirtualProcedures = new Set();
        const invalidDispatch = new Set(graph.invalidDispatch || []);
        for (const method of graph.dispatch || []) {
            if (invalidDispatch.has(method.id) || invalidDispatch.has(method.overridden)) continue;
            // The validated trace reserves slots zero/one; real virtual slots
            // start at two. Resolution itself must not alias an override to base.
            if (method.slot >= 2) this.compilerNativeVirtualProcedures.add(method.id);
            if (method.overridden) this.compilerNativeProcedureOverrides.set(method.id, new Set([method.overridden]));
        }
        const expandedLines = expanded.text.split("\n");
        const unmappedGeneratedSpans = new Set((analysis.tokenOrigins || [])
            .filter((origin) => origin.kind === "generated" && origin.sourceMap === 0)
            .map((origin) => `${origin.start.line}:${origin.start.character}:${origin.end.character}`));
        this.nativeBindings = graph.uses.flatMap((binding) => {
            const token = bindingToken(binding, byLine, true);
            if (!token) {
                const key = `${binding.line}:${binding.startColumn}:${binding.endColumn}`;
                const line = expandedLines[binding.line] || "";
                const spelling = line.slice(binding.startColumn, binding.endColumn);
                if (unmappedGeneratedSpans.has(key) && spelling.toLowerCase() === binding.name.toLowerCase()) {
                    /* Some compiler intrinsics emit a generated name directly
                       after a keyword, so the expanded text has no standalone
                       identifier token at the recorded range. With no macro
                       map or physical origin, this cannot be an editable
                       source occurrence. Keep it out of editor bindings while
                       retaining the compiler's raw symbol graph for audits. */
                    return [];
                }
                throw new Error("Native symbol binding does not match a complete identifier or qualified name.");
            }
            return { ...binding, token };
        });
        this.nativeBindingOffsets = new Set(this.nativeBindings.map((binding) => binding.token.offset));
        for (const binding of this.nativeBindings) {
            if (binding.kind !== "declaration") continue;
            const entry = expanded.entriesByOffset.get(binding.token.offset) || this.inner.entries.find((candidate) => candidate.compilerSymbolId === binding.id);
            if (!entry) continue;
            entry.id = `compiler-symbol:${analysis.dependencies[0] || this.expandedUri}:${binding.id}`;
            entry.compilerSymbolId = binding.id;
            entry.nativeSymbol = this.nativeSymbols.get(binding.id);
            if (["variable", "parameter", "field", "const", "enumMember"].includes(entry.declaration.type) && entry.nativeSymbol.typeName) entry.declaration.typeName = entry.nativeSymbol.typeName;
            const family = this.nativeFamilies.get(binding.id) || [];
            family.push(entry);
            this.nativeFamilies.set(binding.id, family);
        }
        const uses = new Map();
        const spellings = new Map();
        for (const binding of this.nativeBindings) {
            const ids = uses.get(binding.token.offset) || new Set();
            ids.add(binding.id);
            uses.set(binding.token.offset, ids);
            spellings.set(binding.token.offset, binding.name.toLowerCase());
        }
        for (const [offset, ids] of uses) {
            const family = ids.size === 1 ? this.nativeFamilies.get([...ids][0]) || [] : [];
            /* A compiler decision with no exported declaration remains unknown.
               Never substitute a same-name symbol selected by the fallback. */
            const declaration = family.find((entry) => entry.offset === offset);
            const spelling = spellings.get(offset);
            const selected = declaration || family.find((entry) => entry.name.toLowerCase() === spelling) || family[0];
            this.inner.resolutionCache.set(`${expanded.key}:${offset}`, selected ? [selected] : []);
        }
    }

    isUnevaluatedExpandedOffset(offset) {
        const ranges = this.compilerUnevaluatedRanges;
        let low = 0, high = ranges.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (ranges[middle].start <= offset) low = middle + 1;
            else high = middle;
        }
        return low > 0 && offset < ranges[low - 1].end;
    }

    isUnevaluatedSourceOccurrence(uri, occurrence, checkCancelled = () => {}) {
        const ranges = this.compilerUnevaluatedSourceRanges?.get(uri.toString());
        const document = ranges && this.getDocument(uri);
        if (!document) return false;
        const start = positionOffset(document, occurrence.line, occurrence.startColumn);
        const end = positionOffset(document, occurrence.endLine ?? occurrence.line, occurrence.endColumn);
        if (end <= start) return false;
        let low = 0, high = ranges.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (ranges[middle].start <= start) low = middle + 1;
            else high = middle;
        }
        let width = Infinity, unevaluated = false;
        // The innermost native expression owns the operation. A surviving
        // outer SIZEOF result can itself be evaluated. Conflicting roles at
        // one physical range, such as repeated includes, retain the edge.
        for (let index = low - 1; index >= 0 && ranges[index].maximum >= end; index--) {
            checkCancelled();
            const range = ranges[index], size = range.end - range.start;
            if (range.end < end || size > width) continue;
            if (size < width) { width = size; unevaluated = range.unevaluated; }
            else unevaluated = unevaluated && range.unevaluated;
        }
        return unevaluated;
    }

    tokenAt(uri, line, character) {
        if (uri.toString() === this.expandedUri.toString()) {
            const ordinary = this.inner.tokenAt(uri, line, character);
            if (ordinary) return ordinary;
            const document = this.getDocument(uri);
            const token = document?.byLine.get(line)?.find((candidate) => candidate.kind === "number" && this.nativeBindingOffsets.has(candidate.offset) && candidate.startColumn <= character && candidate.endColumn >= character);
            return token ? { document, token } : null;
        }
        const document = this.sources.get(uri.toString());
        const token = document?.byLine.get(line)?.find((candidate) => candidate.startColumn <= character && candidate.endColumn >= character && (candidate.kind === "identifier" || candidate.kind === "number" && this.isNativeSymbolToken(document, candidate)));
        return token ? { document, token } : null;
    }

    isNativeSymbolToken(document, token) {
        if (token.kind !== "number") return false;
        if (document === this.inner.getDocument(this.expandedUri)) return this.nativeBindingOffsets.has(token.offset);
        return (this.sourceToExpanded.get(`${document.uri}:${token.offset}`) || []).some((candidate) => this.nativeBindingOffsets.has(candidate.offset));
    }

    resolveToken(document, token) {
        if (document === this.inner.getDocument(this.expandedUri)) return this.inner.resolveToken(document, token);
        const preprocessor = this.preprocessor.resolve(document, token);
        if (preprocessor && !preprocessor.length) return [];
        const projected = this.sourceToExpanded.get(`${document.uri}:${token.offset}`) || [];
        const targets = new Map((preprocessor || []).map((entry) => [entry.id, entry]));
        for (const occurrence of projected) {
            const entries = this.inner.resolveToken(this.inner.getDocument(this.expandedUri), occurrence);
            if (!entries.length) return [];
            for (const entry of entries) targets.set(entry.id, entry);
        }
        return [...targets.values()];
    }

    resolveAt(uri, line, character) {
        const context = this.tokenAt(uri, line, character);
        return context ? this.resolveToken(context.document, context.token) : [];
    }

    projectPosition(uri, line, character) {
        const positions = this.projectPositions(uri, line, character);
        return positions.length === 1 ? positions[0] : null;
    }

    projectPositions(uri, line, character, endPosition = false, includeRecoveredExpressions = false) {
        if (uri.toString() === this.expandedUri.toString()) return [{ line, character }];
        const document = this.sources.get(uri.toString());
        // Selection ends are exclusive. At `value)` the closing parenthesis
        // can belong to the invocation rather than the replacement text.
        const candidates = (document?.byLine.get(line) || []).filter((token) => endPosition ? token.startColumn < character : token.startColumn <= character);
        const last = candidates.at(-1);
        if (!last) return [];
        const key = `${uri}:${last.offset}`;
        const projected = this.sourceToExpanded.get(key) ||
            (includeRecoveredExpressions ? this.recoverySourceToExpanded.get(key) : null) || [];
        return projected.map((token) => {
            let relativeCharacter = character - last.startColumn;
            const sourceWidth = last.endColumn - last.startColumn;
            const projectedWidth = token.endColumn - token.startColumn;
            if (!endPosition && relativeCharacter < sourceWidth && sourceWidth > projectedWidth && projectedWidth > 0) {
                relativeCharacter = Math.min(relativeCharacter, projectedWidth - 1);
            }
            const offset = character <= last.endColumn ? Math.min(relativeCharacter, projectedWidth) : relativeCharacter;
            return { line: token.line, character: token.startColumn + offset, token };
        });
    }

    expressionAt(uri, start, end = start) {
        const selectedDirective = this.compilerSidecarFactAt(uri, start, end, true);
        if (selectedDirective) return selectedDirective;
        let traced = this.expressionAtTraceOnly(uri, start, end);
        if (traced && this.partial && this.expressionUsesRecoveredNativeSymbol(uri, traced)) {
            traced = { ...traced, provisional: true };
        }
        const selected = this.compilerSidecarFactAt(uri, start, end);
        if (!selected || !traced) return selected || traced;
        if (this.partial) return traced;

        /* The native trace and semantic export use separate identity graphs,
           but an exact physical span still describes the same written
           expression. Prefer the compiler's semantic type when that exact
           annotation disagrees, as constructor-like expressions can have a
           result type that is not the type of an intermediate trace node. */
        const exactTrace = this.expressionAtTraceOnly(uri, selected.start, selected.end);
        if (exactTrace && (exactTrace.dtype !== selected.dtype || normalizeTypeName(exactTrace.typeName) !== normalizeTypeName(selected.typeName))) return selected;

        /* An exact editor-trace answer remains authoritative on ties. A
           narrower compiler-owned physical span can type parser routes that
           the editor bridge does not yet represent. */
        const source = this.getDocument(uri);
        if (!source) return traced;
        const from = positionOffset(source, start.line, start.character);
        const to = positionOffset(source, end.line, end.character);
        if (from === to && selected.endOffset - selected.startOffset < traced.endOffset - traced.startOffset) return selected;
        return traced;
    }

    expressionAtCompilerSidecarOnly(uri, start, end = start) {
        return this.compilerSidecarFactAt(uri, start, end, true) || this.compilerSidecarFactAt(uri, start, end);
    }

    /* Audits use this path to measure sidecar coverage without accepting a
       matching editor-trace expression as proof that the sidecar is usable. */
    compilerSidecarFactAt(uri, start, end, directivesOnly = false) {
        const source = this.getDocument(uri);
        const sourceFacts = (directivesOnly ? this.compilerDirectiveExpressions : this.compilerSidecarExpressions)?.get(uri.toString()) || [];
        if (!source) return null;
        const from = positionOffset(source, start.line, start.character);
        const to = positionOffset(source, end.line, end.character);
        const ranges = directivesOnly ? this.compilerDirectiveExpressionsByRange : this.compilerSidecarExpressionsByRange;
        const selected = from !== to
            ? ranges?.get(uri.toString())?.get(`${from}:${to}`)
            : sourceFacts.find((expression) => expression.startOffset <= from && expression.endOffset > from);
        if (selected || !this.expressionFallback) return selected || null;
        const supplemental = this.expressionFallback.compilerSidecarFactAt(uri, start, end, directivesOnly);
        if (!supplemental) return null;
        /* A supplementary pass owns an independent identity graph. Expose
           only its validated type and physical span, never its symbol IDs,
           operator selections, or graph-linked metadata. */
        return {
            dtype: supplemental.dtype,
            typeName: supplemental.typeName,
            symbol: 0,
            subtype: 0,
            start: supplemental.start,
            end: supplemental.end,
            startOffset: supplemental.startOffset,
            endOffset: supplemental.endOffset,
            compilerExpressionId: 0,
            semanticSource: supplemental.semanticSource,
            provisional: supplemental.provisional
        };
    }

    expressionUsesRecoveredNativeSymbol(uri, expression) {
        const offsets = this.recoveredNativeReferenceOffsets.get(uri.toString());
        if (!offsets?.length) return false;
        const expressionIds = expression.compilerExpressionIds || [expression.compilerExpressionId];
        for (const id of expressionIds) {
            const candidate = this.expressionsById.get(id);
            if (!candidate) continue;
            let low = 0, high = offsets.length;
            while (low < high) {
                const middle = (low + high) >> 1;
                if (offsets[middle].start < candidate.startOffset) low = middle + 1;
                else high = middle;
            }
            for (let index = low; index < offsets.length && offsets[index].start < candidate.endOffset; index++) {
                if (offsets[index].end <= candidate.endOffset) return true;
            }
        }
        return false;
    }

    isCompilerSidecarRangeAmbiguous(uri, start, end) {
        const source = this.getDocument(uri);
        if (!source) return false;
        const from = positionOffset(source, start.line, start.character);
        const to = positionOffset(source, end.line, end.character);
        return this.compilerSidecarAmbiguousRanges?.get(uri.toString())?.has(`${from}:${to}`) || false;
    }

    compilerSidecarExpressionAlternativesAt(uri, start, end = start) {
        const source = this.getDocument(uri);
        if (!source) return [];
        const from = positionOffset(source, start.line, start.character);
        const to = positionOffset(source, end.line, end.character);
        const ranges = this.compilerSidecarAmbiguousFacts?.get(uri.toString());
        let facts = ranges?.get(`${from}:${to}`);
        if (!facts && from === to && ranges) {
            /* Hover is a point query. Match its containing ambiguous span and
               prefer the narrowest source expression, like expressionAt(). */
            let narrowest = Number.POSITIVE_INFINITY;
            for (const [range, candidates] of ranges) {
                const [rangeStart, rangeEnd] = range.split(":").map(Number);
                if (rangeStart > from || rangeEnd <= from) continue;
                const width = rangeEnd - rangeStart;
                if (width < narrowest) {
                    narrowest = width;
                    facts = candidates;
                }
            }
        }
        if (!facts?.length) return [];

        const includePathFor = (sourceContextId) => {
            const includePath = [];
            const visited = new Set();
            let current = sourceContextId;
            while (current && includePath.length < 16 && !visited.has(current)) {
                visited.add(current);
                const context = this.semanticSourceContexts.get(current);
                if (!context) break;
                includePath.push({
                    id: context.id,
                    kind: context.kind,
                    filePath: context.filePath,
                    requested: context.requested,
                    directive: context.directive ? {
                        filePath: context.directive.filePath,
                        startLine: context.directive.startLine,
                        startColumn: context.directive.startColumn
                    } : null
                });
                current = context.parent;
            }
            return includePath.reverse();
        };
        const variants = new Map();
        for (const fact of facts) {
            const typeKey = `${fact.dtype}:${fact.compilerSidecarSubtypeId}:${normalizeTypeName(fact.typeName)}`;
            let variant = variants.get(typeKey);
            if (!variant) {
                if (variants.size >= 8) continue;
                variant = { dtype: fact.dtype, typeName: fact.typeName, contexts: [], _contextKeys: new Set() };
                variants.set(typeKey, variant);
            }
            const includePath = includePathFor(fact.sourceContextId);
            const contextKey = includePath.map((context) => context.id).join("/");
            if (variant._contextKeys.has(contextKey)) continue;
            variant._contextKeys.add(contextKey);
            if (variant.contexts.length < 3) variant.contexts.push({ includePath });
            else variant.additionalContexts = (variant.additionalContexts || 0) + 1;
        }
        return [...variants.values()].map(({ _contextKeys, ...variant }) => variant);
    }

    compilerSelectionRanges(uri, position, checkCancelled = () => {}, includeBlocks = false) {
        const source = this.getDocument(uri);
        if (!source || !position || !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) ||
            position.line < 0 || position.line >= source.lineOffsets.length || position.character < 0) return [];
        const lineStart = source.lineOffsets[position.line];
        const nextLine = source.lineOffsets[position.line + 1] ?? source.text.length;
        const lineLength = source.text.slice(lineStart, nextLine).replace(/[\r\n]+$/, "").length;
        if (position.character > lineLength) return [];
        const offset = positionOffset(source, position.line, position.character);
        const key = uri.toString();
        let byLine = this.compilerSelectionExpressionsByLine.get(key);
        if (byLine === undefined) {
            byLine = new Map();
            let indexEntries = 0;
            const facts = this.compilerSidecarExpressions.get(key) || [];
            for (let index = 0; index < facts.length; index++) {
                if ((index & 255) === 0) checkCancelled();
                const fact = facts[index];
                if (fact.provisional || fact.invalid) continue;
                const firstLine = fact.start.line;
                const lastLine = fact.end.line;
                const lineCount = lastLine - firstLine + 1;
                if (!Number.isSafeInteger(lineCount) || lineCount < 1 || indexEntries + lineCount > MAX_COMPILER_SELECTION_INDEX_ENTRIES) {
                    /* Keep selection queries bounded for unusually large or multiline-heavy modules. */
                    byLine = null;
                    break;
                }
                for (let line = firstLine; line <= lastLine; line++) {
                    const lineFacts = byLine.get(line) || [];
                    lineFacts.push(fact);
                    byLine.set(line, lineFacts);
                }
                indexEntries += lineCount;
            }
            this.compilerSelectionExpressionsByLine.set(key, byLine);
        }
        const facts = byLine?.get(position.line) || [];
        const ranges = [];
        const candidateCount = Math.min(facts.length, MAX_COMPILER_SELECTION_CANDIDATES);
        for (let index = 0; index < candidateCount; index++) {
            if ((index & 255) === 0) checkCancelled();
            const fact = facts[index];
            if (fact.provisional || fact.invalid || fact.startOffset > offset || fact.endOffset < offset) continue;
            ranges.push({ start: fact.start, end: fact.end });
            if (ranges.length >= MAX_COMPILER_SELECTION_RANGES) break;
        }
        if (includeBlocks && !this.partial && uri.fsPath && this.semanticFoldingRanges) {
            const fileKey = compilerPathKey(uri.fsPath);
            const blocks = [];
            for (const fold of this.semanticFoldingRanges) {
                checkCancelled();
                if (position.line < fold.startLine || position.line > fold.endLine || fold.startLine < 0 ||
                    fold.endLine >= source.lineOffsets.length || compilerPathKey(fold.filePath) !== fileKey) continue;
                const endOffset = source.lineOffsets[fold.endLine + 1] ?? source.text.length;
                const endCharacter = source.text.slice(source.lineOffsets[fold.endLine], endOffset).replace(/[\r\n]+$/, "").length;
                blocks.push({ start: { line: fold.startLine, character: 0 }, end: { line: fold.endLine, character: endCharacter }, kind: "block" });
            }
            // Keep the innermost native parents when nesting exceeds the UI
            // budget. Blocks and expressions have separate allowances so one
            // cannot crowd out the other. Whole-line spans avoid byte-column
            // guesses and include the physical closing statement/comment.
            blocks.sort((left, right) => left.end.line - left.start.line - (right.end.line - right.start.line));
            ranges.push(...blocks.slice(0, MAX_COMPILER_SELECTION_RANGES));
        }
        return ranges;
    }

    compilerProcedureReferenceCodeLenses(uri, checkCancelled = () => {}) {
        const source = this.getDocument(uri);
        const filePath = uri.fsPath || uri.path;
        if (!source || !filePath || this.partial) return { complete: true, entries: [] };
        const pathKey = (value) => {
            const resolved = path.resolve(value);
            return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        };
        const selectedPath = pathKey(filePath);
        const families = new Map();
        for (const [symbolId, entries] of this.nativeFamilies) {
            checkCancelled();
            const symbol = this.nativeSymbols.get(symbolId);
            if (symbol?.symbolClass !== 3) continue;
            const identity = this.canonicalSymbolIds.get(symbolId) || symbolId;
            const family = families.get(identity) || [];
            family.push(...entries);
            families.set(identity, family);
        }
        if (!families.size) return { complete: true, entries: [] };

        const sites = new Map();
        for (let index = 0; index < this.nativeBindings.length; index++) {
            if ((index & 255) === 0) checkCancelled();
            const binding = this.nativeBindings[index];
            if (binding.kind !== "reference" || this.nativeSymbols.get(binding.id)?.symbolClass !== 3) continue;
            const physical = this.expandedToSource.get(binding.token.offset);
            if (!physical?.uri?.fsPath || !physical.occurrence) continue;
            const identity = this.canonicalSymbolIds.get(binding.id) || binding.id;
            if (!families.has(identity)) continue;
            const occurrence = physical.occurrence;
            const key = `${physical.uri.toString()}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`;
            let site = sites.get(key);
            if (!site) {
                if (sites.size >= MAX_COMPILER_PROCEDURE_REFERENCE_SITES) return { complete: false, entries: [] };
                site = { identities: new Set(), reference: {
                    filePath: physical.uri.fsPath,
                    line: occurrence.line,
                    startColumn: occurrence.startColumn,
                    endColumn: occurrence.endColumn
                } };
                sites.set(key, site);
            }
            site.identities.add(identity);
        }

        const entries = new Map();
        for (const site of sites.values()) {
            checkCancelled();
            if (site.identities.size !== 1) continue;
            const [identity] = site.identities;
            for (const entry of families.get(identity) || []) {
                if (!entry.uri?.fsPath || pathKey(entry.uri.fsPath) !== selectedPath) continue;
                const declaration = entry.declaration;
                if (!Number.isSafeInteger(declaration.line) || declaration.line < 0 ||
                    !Number.isSafeInteger(declaration.startColumn) || declaration.startColumn < 0 ||
                    !Number.isSafeInteger(declaration.endColumn) || declaration.endColumn <= declaration.startColumn) continue;
                const key = `${declaration.line}:${declaration.startColumn}:${declaration.endColumn}`;
                let lens = entries.get(key);
                if (!lens) {
                    if (entries.size >= MAX_COMPILER_PROCEDURE_CODE_LENSES) return { complete: false, entries: [] };
                    lens = {
                        compilerSymbolId: entry.compilerSymbolId,
                        name: entry.name,
                        line: declaration.line,
                        startColumn: declaration.startColumn,
                        endColumn: declaration.endColumn,
                        references: new Map()
                    };
                    entries.set(key, lens);
                }
                const reference = site.reference;
                lens.references.set(`${pathKey(reference.filePath)}:${reference.line}:${reference.startColumn}:${reference.endColumn}`, reference);
            }
        }

        return {
            complete: true,
            entries: [...entries.values()].filter((entry) => entry.references.size)
                .map((entry) => ({ ...entry, references: [...entry.references.values()] }))
        };
    }

    expressionAtTraceOnly(uri, start, end = start) {
        const first = this.projectPositions(uri, start.line, start.character, false, true);
        const last = this.projectPositions(uri, end.line, end.character, start.line !== end.line || start.character !== end.character, true);
        if (!first.length || first.length !== last.length) return null;
        const document = this.inner.getDocument(this.expandedUri);
        const matches = [];
        for (const [index, position] of first.entries()) {
            const from = positionOffset(document, position.line, position.character);
            const to = positionOffset(document, last[index].line, last[index].character);
            const expression = from !== to ? this.expressionsByRange.get(`${from}:${to}`) : this.expressions.find((expression) => expression.startOffset <= from && expression.endOffset > from);
            if (!expression) return null;
            const sourceFor = (token) => this.expandedToSource.get(token?.offset) || this.recoveryExpandedToSource.get(token?.offset);
            if (from !== to && (sourceFor(position.token)?.sourceMap || sourceFor(last[index].token)?.sourceMap)) {
                // Selecting two separate macro arguments must not invent a
                // written expression from operators supplied by the macro.
                const source = this.getDocument(uri);
                const sourceStart = positionOffset(source, start.line, start.character), sourceEnd = positionOffset(source, end.line, end.character);
                const written = source.tokens.filter((token) => token.offset >= sourceStart && token.end <= sourceEnd && !(token.name === "_" && /^_[ \t]*(?:\r?\n|\r|$)/.test(source.text.slice(token.offset)))).map((token) => token.key);
                const expanded = document.tokens.filter((token) => token.offset >= from && token.end <= to).map((token) => token.key);
                if (JSON.stringify(written) !== JSON.stringify(expanded)) return null;
            }
            matches.push(expression);
        }
        const selected = matches[0];
        if (matches.some((expression) => expression.dtype !== selected.dtype || expression.subtype !== selected.subtype || expression.typeName !== selected.typeName)) return null;
        return matches.length === 1 ? selected : { ...selected, compilerExpressionIds: matches.map((expression) => expression.compilerExpressionId) };
    }

    nativeTypeEntries(typeName, subtype) {
        if (subtype) return this.nativeFamilies.get(this.canonicalSymbolIds.get(subtype)) || [];
        return (this.inner.byQualifiedName.get(normalizeTypeName(typeName)) || []).filter((entry) => ["type", "union", "enum"].includes(entry.declaration.type));
    }

    nativeAccess(entry, scope) {
        const restricted = entry.nativeSymbol.attributes & 0x600000;
        if (!restricted) return true;
        const canonical = (id) => this.canonicalSymbolIds.get(id) || id;
        const chain = (id) => {
            const result = [];
            const seen = new Set();
            while (id && !seen.has(id)) {
                id = canonical(id);
                seen.add(id);
                const symbol = this.nativeSymbols.get(id);
                if (!symbol) break;
                result.push(symbol);
                id = symbol.namespace || symbol.owner;
            }
            return result;
        };
        const parent = chain(entry.nativeSymbol.namespace || entry.nativeSymbol.owner).find((symbol) => symbol.symbolClass === 10);
        if (!parent) return false;
        // symbCheckAccess() checks native namespace ancestry, not the physical
        // nesting of an out-of-line method body. PROTECTED also permits derived
        // type contexts; PRIVATE does not. Module PRIVATE is a different flag.
        const contexts = chain(scope?.symbol || 0).filter((symbol) => symbol.symbolClass === 10);
        for (const context of contexts) {
            if (context.id === parent.id) return true;
            if (restricted & 0x400000) {
                const seen = new Set();
                let base = this.inventory.shapes.get(context.id)?.base;
                while (base && !seen.has(base)) {
                    base = canonical(base);
                    if (base === parent.id) return true;
                    seen.add(base);
                    base = this.inventory.shapes.get(base)?.base;
                }
            }
        }
        return false;
    }

    nativeMembers(receivers, scope) {
        const selected = new Map();
        const visited = new Set();
        const collect = (type, hidden = new Set()) => {
            const id = type.compilerSymbolId;
            if (visited.has(id)) return;
            visited.add(id);
            const direct = (this.inventory.entriesByOwner.get(id) || []).filter((entry) => entry.declaration.type !== "parameter");
            for (const entry of direct) if (!hidden.has(entry.key) && this.nativeAccess(entry, scope) && !selected.has(entry.compilerSymbolId)) selected.set(entry.compilerSymbolId, entry);
            const nextHidden = new Set([...hidden, ...direct.map((entry) => entry.key)]);
            const shape = this.inventory.shapes.get(id);
            for (const base of this.nativeFamilies.get(this.canonicalSymbolIds.get(shape?.base)) || []) collect(base, nextHidden);
            for (const anonymous of this.inventory.shapes.values()) {
                if (this.canonicalSymbolIds.get(anonymous.anonymousParent) === id) {
                    for (const child of this.nativeFamilies.get(this.canonicalSymbolIds.get(anonymous.symbol)) || []) collect(child, hidden);
                }
            }
        };
        for (const receiver of receivers) for (const type of this.typeEntries(receiver)) collect(type);
        return [...selected.values()];
    }

    completeMembers(uri, line, character, allowPublicRecovery = false) {
        const positions = this.projectPositions(uri, line, character);
        if (!positions.length) {
            const recovered = this.recoveredMemberCompletion(uri, line, character, allowPublicRecovery);
            if (recovered !== null) return recovered;
            // Null means ordinary completion, while [] means a member context
            // with no proven members. Macro names have no expanded token, so
            // preserve that distinction without guessing a receiver type.
            const tokens = (this.getDocument(uri)?.byLine.get(line) || []).filter((token) => token.startColumn < character);
            let last = tokens.at(-1);
            if (last?.kind === "identifier" && last.endColumn >= character) last = tokens.at(-2);
            return [".", "->"].includes(last?.name) ? [] : null;
        }
        return this.commonProjectedEntries(positions, (position) => this.completeExpandedMembers(position));
    }

    recoveredMemberCompletion(uri, line, character, allowPublicRecovery = false) {
        if (!this.inventory) return null;
        const source = this.getDocument(uri);
        const tokens = (source?.byLine.get(line) || []).filter((token) => token.startColumn < character);
        let last = tokens.at(-1), prefix = null;
        if (last?.kind === "identifier" && last.endColumn >= character) {
            prefix = last;
            last = tokens.at(-2);
        }
        if (![".", "->"].includes(last?.name)) return null;
        const projected = this.recoverySourceToExpanded.get(`${uri}:${last.offset}`) || [];
        const expanded = this.inner.getDocument(this.expandedUri);
        /* Recovery projections contain direct physical tokens only. Intersect
           repeated include contexts, and never turn this receipt into a value
           type, navigation binding, or editable reference. */
        return this.commonProjectedEntries(projected, (operator) => {
            const offset = positionOffset(expanded, operator.line, operator.endColumn);
            const scope = scopeAt(expanded, offset);
            let recoveredScope = false;
            for (let current = scope; current; current = current.parent) if (current.recovered) recoveredScope = true;
            /* An unclosed block cannot certify the caller's private/protected
               access. Presentation callers may still use a direct native
               receiver and public members, under the inspected producer ABI. */
            if (recoveredScope && (!allowPublicRecovery ||
                !/^1\.20\.5(?:$|[-+])/.test(this.compilerSemanticModelCompilerVersion || ""))) return [];
            const receivers = this.recoveryCompletionReceivers.get(offset) || [];
            const receiver = receivers[0];
            if (!receiver?.subtype || receivers.some((candidate) => candidate.dtype !== receiver.dtype ||
                candidate.subtype !== receiver.subtype)) {
                return recoveredScope ? [] : this.recoveredStaticMembers(uri, source, last, prefix, operator, scope);
            }
            if (prefix && !(this.recoverySourceToExpanded.get(`${uri}:${prefix.offset}`) || [])
                .some((token) => token.line === receiver.start.line && token.startColumn === receiver.start.character)) return [];
            const types = this.nativeTypeEntries(receiver.typeName, receiver.subtype);
            if (!types.length || types.some((entry) => entry.provisional || entry.declaration.provisional)) return [];
            return this.nativeMembers(types, scope).filter((entry) => !entry.provisional && !entry.declaration.provisional &&
                (!recoveredScope || this.nativeAccess(entry, null)));
        });
    }

    recoveredStaticMembers(uri, source, dot, prefix, operator, scope) {
        if (dot.name !== ".") return [];
        const parts = [];
        let token = source.tokens[dot.index - 1];
        // Match the resolver's depth bound; only direct named owners qualify.
        while (token?.line === dot.line && this.inner.isReceiverToken(token) && token.kind === "identifier") {
            parts.unshift(token);
            if (parts.length > 32) return [];
            const separator = source.tokens[token.index - 1];
            if (separator?.line !== dot.line || separator.name !== ".") break;
            token = source.tokens[token.index - 2];
        }
        const head = parts[0];
        if (!head || [".", "->"].includes(source.tokens[head.index - 1]?.name)) return [];
        const direct = (part, after = false) => (this.recoverySourceToExpanded.get(`${uri}:${part.offset}`) || [])
            .some((mapped) => mapped.line === operator.line && mapped.key === part.key &&
                (after ? mapped.startColumn >= operator.endColumn : mapped.endColumn <= operator.startColumn));
        if (!parts.every((part) => direct(part)) || prefix && !direct(prefix, true)) return [];
        const usable = (entry) => entry.nativeSymbol && !entry.provisional && !entry.declaration.provisional;
        const owner = (entry) => usable(entry) && ["namespace", "type", "class", "union", "enum"].includes(entry.declaration.type);
        let owners = this.visibleEntries(uri, head.line, head.startColumn, 64, head.name);
        if (!owners.length || !owners.every(owner)) return [];
        for (const part of parts.slice(1)) {
            owners = this.nativeMembers(owners, scope).filter((entry) => entry.key === part.key);
            if (!owners.length || !owners.every(owner)) return [];
        }
        // These are native declaration candidates for completion only. No
        // binding or expression type is invented for the unfinished suffix.
        return this.nativeMembers(owners, scope).filter(usable);
    }

    commonProjectedEntries(positions, query) {
        // An argument can be substituted into several scopes. Suggest only
        // native identities available at every use, not the union of names.
        let selected = null, ordinary = false;
        for (const position of positions) {
            const values = query(position);
            if (values === null) {
                if (selected !== null) return [];
                ordinary = true;
                continue;
            }
            if (ordinary) return [];
            const entries = new Map(values.map((entry) => [entry.id, entry]));
            if (selected === null) selected = entries;
            else for (const id of selected.keys()) if (!entries.has(id)) selected.delete(id);
            if (!selected.size) break;
        }
        return ordinary ? null : [...(selected?.values() || [])];
    }

    completeExpandedMembers(position) {
        if (position) {
            const document = this.inner.getDocument(this.expandedUri);
            const offset = positionOffset(document, position.line, position.character);
            const next = document.tokens.find((token) => token.kind === "identifier" && token.offset <= offset && token.end >= offset) || document.tokens.find((token) => token.offset >= offset);
            const receiver = this.receivers.get(next?.offset);
            if (receiver) return this.inner.members(this.nativeTypeEntries(receiver.typeName, receiver.subtype), document, scopeAt(document, offset));
            const separator = document.tokens[next?.index - 1];
            const ownerToken = document.tokens[next?.index - 2];
            if (separator?.name === "." && ownerToken?.kind === "identifier" && !this.inner.isReceiverToken(ownerToken)) {
                const scope = scopeAt(document, offset);
                const owners = this.inner.resolveName(document, ownerToken.name, scope, ownerToken.offset);
                // Accepted keyword names can own a native namespace even
                // though the source-only lexer cannot classify them as receivers.
                if (owners.length && owners.every((entry) => entry.nativeSymbol && entry.declaration.type === "namespace" &&
                    !entry.provisional && !entry.declaration.provisional)) return this.nativeMembers(owners, scope);
            }
        }
        return position ? this.inner.completeMembers(this.expandedUri, position.line, position.character) : [];
    }

    blankLineCompletionPositions(uri, line, character) {
        if (!this.inventory) return [];
        const source = this.getDocument(uri);
        const lineStart = source?.lineOffsets[line];
        if (lineStart === undefined) return [];
        const lineEnd = source.lineOffsets[line + 1] ?? source.text.length;
        if (!/^[\t \r\n]*$/.test(source.text.slice(lineStart, lineEnd))) return [];
        const offset = lineStart + character;
        if (this.compilerModuleScopeClosed && source.uri.fsPath && this.compilerModuleFilePath &&
            compilerPathKey(source.uri.fsPath) === compilerPathKey(this.compilerModuleFilePath) &&
            source.text.length - offset <= MAX_COMPILER_COMPLETION_GAP_CHARACTERS &&
            /^[\t \r\n]*$/.test(source.masked.slice(offset)) &&
            /^[\t \r\n]*$/.test(maskFreeBasicComments(source.text.slice(offset)))) {
            /* Module-end and closed native scopes prove global scope, even
               with independently positioned errors. Do not inherit the
               preceding token's inner scope or apply this to headers. */
            const expanded = this.inner.getDocument(this.expandedUri);
            const endLine = expanded.lineOffsets.length - 1;
            const endColumn = expanded.text.length - expanded.lineOffsets[endLine];
            return [{ line: endLine, character: endColumn, token: {
                offset: expanded.text.length, startColumn: endColumn, endColumn,
                completionEpoch: this.compilerModuleFinalEpoch
            } }];
        }
        let low = 0, high = source.tokens.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (source.tokens[middle].offset < offset) low = middle + 1;
            else high = middle;
        }
        let before = source.tokens[low - 1], after = source.tokens[low];
        const literals = source.compilerLiteralCompletionAnchors || [];
        low = 0;
        high = literals.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (literals[middle].offset < offset) low = middle + 1;
            else high = middle;
        }
        const previousLiteral = literals[low - 1], nextLiteral = literals[low];
        if (previousLiteral && (!before || previousLiteral.end > before.end)) before = previousLiteral;
        if (nextLiteral && (!after || nextLiteral.offset < after.offset)) after = nextLiteral;
        if (!before || !after || after.offset - before.end > MAX_COMPILER_COMPLETION_GAP_CHARACTERS ||
            !/^[\t \r\n]*$/.test(source.masked.slice(before.end, after.offset)) ||
            !/^[\t \r\n]*$/.test(maskFreeBasicComments(source.text.slice(before.end, after.offset)))) return [];
        const projections = (token) => {
            if (token.completionProjections) return token.completionProjections.length <= MAX_COMPILER_COMPLETION_GAP_CONTEXTS
                ? [...token.completionProjections].sort((first, second) => first.offset - second.offset) : [];
            const key = `${uri}:${token.offset}`;
            const ordinary = this.sourceToExpanded.get(key) || [];
            const recovered = this.recoverySourceToExpanded.get(key) || [];
            if (ordinary.length + recovered.length > MAX_COMPILER_COMPLETION_GAP_CONTEXTS) return [];
            const values = [...ordinary, ...recovered];
            if (values.some((candidate) => {
                const origin = this.expandedToSource.get(candidate.offset) || this.recoveryExpandedToSource.get(candidate.offset);
                return origin?.sourceMap !== 0 || origin.uri.toString() !== uri.toString() ||
                    origin.occurrence.offset !== token.offset;
            })) return [];
            return values.sort((first, second) => first.offset - second.offset);
        };
        const starts = projections(before), ends = projections(after);
        if (!starts.length || starts.length !== ends.length) return [];
        const expanded = this.inner.getDocument(this.expandedUri);
        const positions = [];
        /* A blank line has no token of its own. Bound it by direct physical
           tokens with only whitespace/comments between them in both texts.
           Intersect both compiler scopes in every include occurrence, rather
           than deciding a scope from source indentation or block keywords. */
        for (let index = 0; index < starts.length; index++) {
            const first = starts[index], last = ends[index];
            const start = positionOffset(expanded, first.line, first.endColumn);
            const end = positionOffset(expanded, last.line, last.startColumn);
            if (end < start || end - start > MAX_COMPILER_COMPLETION_GAP_CHARACTERS ||
                !/^[\t \r\n]*$/.test(maskFreeBasicComments(expanded.text.slice(start, end)))) return [];
            positions.push({ line: first.line, character: first.endColumn, token: first },
                { line: last.line, character: last.startColumn, token: last });
        }
        return positions;
    }

    visibleEntries(uri, line, character, maximum, name = null) {
        const key = name === null ? null : normalizeIdentifier(name);
        let positions = this.projectPositions(uri, line, character);
        const recovering = Boolean(this.inventory && !positions.length);
        if (recovering) positions = this.projectPositions(uri, line, character, false, true);
        if (recovering && !positions.length) positions = this.blankLineCompletionPositions(uri, line, character);
        if (!positions.length) {
            const context = this.tokenAt(uri, line, character);
            const document = context?.document || this.getDocument(uri);
            if (!document) return [];
            const epochs = new Set([
                ...this.preprocessor.epochsAtPosition(document, line, character),
                ...(context ? this.preprocessor.epochsAt(context.document, context.token) : []),
                ...(context ? this.sourceEpochs.get(`${uri}:${context.token.offset}`) || [] : [])
            ]);
            return this.commonProjectedEntries([...epochs], (epoch) => {
                const entries = this.preprocessor.activeEntries(epoch);
                return key === null ? entries : entries.filter((entry) => entry.key === key);
            }).slice(0, maximum ?? 2000);
        }
        return this.commonProjectedEntries(positions, (position) => {
            /* A failed statement still has physical token and lexical-scope
               coordinates. Use them to list surviving native declarations,
               without restoring a binding for the incomplete identifier. */
            const origin = this.expandedToSource.get(position.token?.offset) ||
                (recovering ? this.recoveryExpandedToSource.get(position.token?.offset) : null);
            const activeMacros = this.preprocessor.activeEntries(origin?.epoch ?? position.token?.completionEpoch);
            const macros = key === null ? activeMacros : activeMacros.filter((entry) => entry.key === key);
            const keys = new Set(macros.map((entry) => entry.key));
            /* Preprocessed whitespace can be shorter than the written gap.
               Completion uses the last proven token, not an offset that could
               run past that line and enter another native scope. */
            const visiblePosition = recovering
                ? { ...position, character: Math.min(position.character, position.token.endColumn) }
                : position;
            return [...macros, ...this.visibleExpandedEntries(visiblePosition, maximum, key).filter((entry) =>
                !keys.has(entry.key) && (!recovering || !entry.provisional && !entry.declaration.provisional))]
                .slice(0, maximum ?? 2000);
        });
    }

    visibleExpandedEntries(position, maximum, name = null) {
        if (position && this.inventory) {
            const document = this.inner.getDocument(this.expandedUri);
            const offset = positionOffset(document, position.line, position.character);
            const scope = scopeAt(document, offset);
            const selected = new Map();
            const enclosingProcedure = (scope) => {
                for (let current = scope; current; current = current.parent) {
                    if (CALLABLE_TYPES.has(current.kind)) return current;
                }
                return null;
            };
            const procedure = enclosingProcedure(scope);
            const add = (entry) => {
                if (name !== null && entry.key !== name) return;
                if (selected.size >= (maximum ?? 2000) || selected.has(entry.key)) return;
                /* Labels are visible throughout their native procedure scope,
                   unlike variables whose declarations must precede the use. */
                if (entry.offset > offset && !["parameter", "label"].includes(entry.declaration.type)) return;
                if (entry.declaration.type === "label" && enclosingProcedure(entry.scope) !== procedure) return;
                if (procedure && entry.scope.kind === "module" && entry.declaration.type === "variable" && !(entry.nativeSymbol.attributes & 1)) return;
                if (this.nativeAccess(entry, scope)) selected.set(entry.key, entry);
            };
            const owners = new Set();
            const physical = [];
            for (let current = scope; current; current = current.parent) physical.push(current);
            // All enclosing locals win over implicit members, even when the
            // cursor is inside an additional IF/FOR block within the method.
            for (const current of physical) if (!["module", "namespace", "type", "union", "enum"].includes(current.kind)) {
                for (const entry of name === null ? current.entries : current.byName.get(name) || []) add(entry);
            }
            for (const current of physical) {
                if (["module", "namespace", "type", "union", "enum"].includes(current.kind)) {
                    for (const entry of name === null ? current.entries : current.byName.get(name) || []) add(entry);
                }
                for (const imported of current.imports) {
                    if (imported.offset > offset) continue;
                    for (const entry of this.inner.byContainer.get(imported.name.toLowerCase()) || []) add(entry);
                }
                // Methods and qualified procedure implementations enter their
                // owning namespace even when written outside its source block.
                let owner = ["namespace", "type", "union", "enum"].includes(current.kind) ? current.symbol : this.nativeSymbols.get(current.symbol)?.namespace || 0;
                while (owner && !owners.has(owner)) {
                    owner = this.canonicalSymbolIds.get(owner) || owner;
                    owners.add(owner);
                    for (const type of this.nativeFamilies.get(owner) || []) for (const entry of this.nativeMembers([type], scope)) add(entry);
                    owner = this.nativeSymbols.get(owner)?.namespace || 0;
                }
            }
            return [...selected.values()];
        }
        return position ? this.inner.visibleEntries(this.expandedUri, position.line, position.character, maximum) : [];
    }

    references(target, includeDeclaration, token) {
        if (target.compilerPreprocessorId) {
            const found = new Map();
            for (const binding of this.preprocessor.bindings) {
                if (token?.isCancellationRequested) return [];
                if (binding.id !== target.compilerPreprocessorId || !includeDeclaration && binding.kind === "declaration" || !binding.physical) continue;
                found.set(`${binding.physical.uri}:${binding.physical.occurrence.offset}`, binding.physical);
            }
            return [...found.values()];
        }
        if (target.compilerSymbolId) {
            const found = new Map();
            for (const binding of this.nativeBindings) {
                if (token?.isCancellationRequested) return [];
                if (binding.id !== target.compilerSymbolId || !includeDeclaration && binding.kind === "declaration") continue;
                const reference = this.expandedToSource.get(binding.token.offset) || { uri: this.expandedUri, occurrence: binding.token };
                found.set(`${reference.uri}:${reference.occurrence.offset}`, reference);
            }
            for (const binding of this.preprocessor.bindings) if (binding.id === target.compilerSymbolId && binding.physical) found.set(`${binding.physical.uri}:${binding.physical.occurrence.offset}`, binding.physical);
            return [...found.values()];
        }
        return this.inner.references(target, includeDeclaration, token).map((reference) =>
            this.expandedToSource.get(reference.occurrence.offset) || reference
        );
    }

    typeEntries(entry, ...args) {
        if (entry.compilerPreprocessorId) return [];
        if (this.inventory && entry.nativeSymbol) {
            if ([8, 9, 10, 11].includes(entry.nativeSymbol.symbolClass)) return [entry];
            return this.nativeFamilies.get(this.canonicalSymbolIds.get(entry.nativeSymbol.subtype)) || [];
        }
        if (entry.nativeSymbol?.subtype) return this.nativeFamilies.get(this.canonicalSymbolIds.get(entry.nativeSymbol.subtype)) || [];
        return this.inner.typeEntries(entry, ...args);
    }
    declarationTargets(targets) {
        return targets.flatMap((target) => {
            if (target.compilerPreprocessorId) return this.preprocessor.families.get(target.compilerPreprocessorId) || [];
            if (target.nativeSymbol?.symbolClass === 4) {
                const family = this.nativeFamilies.get(target.compilerSymbolId) || [];
                const definitions = family.filter((entry) => !entry.declaration.parentDeclaration?.modifiers.includes("DECLARE"));
                return definitions.length ? definitions : family;
            }
            return this.inner.declarationTargets([target]);
        });
    }
    declarationSources(targets) {
        const result = new Map();
        const add = (entry) => result.set(`${entry.uri.toString()}:${entry.offset}`, entry);
        for (const target of targets) {
            if (target.compilerPreprocessorId) {
                for (const entry of this.preprocessor.families.get(target.compilerPreprocessorId) || [target]) add(entry);
                continue;
            }
            if (!["sub", "function", "property", "constructor", "destructor", "operator"].includes(target.declaration.type)) {
                add(target);
                continue;
            }

            const symbolId = target.compilerSymbolId || target.nativeSymbol?.id || 0;
            const canonicalId = this.canonicalSymbolIds.get(symbolId) || symbolId;
            const family = this.nativeFamilies.get(symbolId) || this.nativeFamilies.get(canonicalId) || [];
            const declarations = family.filter((entry) =>
                entry.declaration.modifiers.includes("DECLARE") ||
                entry.declaration.parentDeclaration?.modifiers.includes("DECLARE")
            );
            for (const entry of declarations.length ? declarations : [target]) add(entry);
        }
        return [...result.values()];
    }
    renameProblem() {
        return "Compiler-backed rename requires complete macro provenance and all build configurations. Use navigation/references to inspect this translation unit; automatic rename is disabled in compiler analysis mode.";
    }
}

module.exports = {
    CompilerSemanticModel,
    compilerSourceDeclarations,
    MAX_COMPILER_SOURCE_DECLARATION_BYTES,
    MAX_COMPILER_SOURCE_DECLARATIONS,
    MAX_COMPILER_SOURCE_DECLARATION_DOCUMENTS,
    MAX_COMPILER_PARAMETER_INLAY_HINTS,
    MAX_COMPILER_PARAMETER_INLAY_SCAN_CHARACTERS,
    compilerParameterDeclarationLocation,
    freeBasicCallArgumentRanges
};

/* end of lib/compiler-semantic-model.js */
