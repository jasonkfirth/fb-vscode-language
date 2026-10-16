/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/semantic-features.js

    Purpose:

        Adapt resolved symbol identities into VS Code navigation and editing.

    Responsibilities:

        - share one resolver across definition, references, and rename
        - reject ambiguous or colliding rename requests
        - adapt resolved symbols, scopes, and call relationships to VS Code navigation and selection
        - emit standard semantic token kinds for resolved symbols

    This file intentionally does NOT contain:

        - source parsing or type inference
        - compiler execution
        - TextMate highlighting rules
*/

const { findCallContext, getCodeContext, maskFreeBasicText, normalizeIdentifier } = require("./freebasic-parser");
const { createDocumentModel, isPrimitiveTypeName, normalizeTypeName, sourceParameterTypeKey, sourceTypeKey,
    positionOffset, scopeAt, tokenize } = require("./semantic-model");
const { queryCompilerModel } = require("./compiler-model-queries");
const { CompilerUri } = require("./compiler-model-store");
const { compilerAwareCodeContext } = require("./compiler-string-context");
const { compilerEditorModel, editorModel } = require("./editor-model");
const { isNumericLabelName } = require("./compiler-project-bindings");
const { TOKEN_TYPES, TOKEN_MODIFIERS, semanticTokenType, semanticEntryIsDeprecated, semanticEntryIsReadonly } = require("./semantic-token-data");

const TYPE_HIERARCHY_TYPES = new Set(["type", "class", "union"]);
const CALL_HIERARCHY_TYPES = new Set(["function", "sub", "property", "constructor", "destructor", "operator"]);
const CALL_HIERARCHY_MODULE_DETAIL = "Module-level calls";
const noKeywordOptionDocumentCache = new WeakMap();
/* Bound the number of displayed lenses, even if a compiler model is corrupt. */
const MAX_COMPILER_REFERENCE_CODE_LENSES = 5000;
const MAX_STOCK_SIDECAR_ACCESS_ROLE_SITES = 4000;
const IMPLICIT_CONSTRUCTOR_CALL_KINDS = new Set([
    "argument-constructor", "default-constructor", "initializer-constructor", "new-constructor", "return-constructor", "explicit-constructor"
]);
const COMPILER_OPERATOR_KEYWORDS = new Set([
    "and", "or", "andalso", "orelse", "xor", "eqv", "imp", "not", "mod", "shl", "shr",
    "new", "delete", "for", "step", "next"
]);
const ITERATOR_OPERATOR_KEYWORDS = new Set(["for", "step", "next"]);
const OPERATOR_TOKEN_ALIASES = new Map([
    ["&=>", "&="], ["+=>", "+="], ["-=>", "-="],
    ["*=>", "*="], ["/=>", "/="], ["\\=>", "\\="], ["^=>", "^="],
    ["and=>", "and="], ["andalso=>", "andalso="], ["mod=>", "mod="],
    ["or=>", "or="], ["orelse=>", "orelse="], ["xor=>", "xor="],
    ["eqv=>", "eqv="], ["imp=>", "imp="], ["shl=>", "shl="], ["shr=>", "shr="]
]);
/* Cast intrinsics can dispatch to a user-defined Operator Cast. */
const CAST_CALLEE_NAMES = new Set([
    "cast", "cbool", "cbyte", "cubyte", "cshort", "cushort", "cint", "cuint",
    "clng", "culng", "clngint", "culngint", "csng", "cdbl", "cstr", "cptr", "ctype"
].map(normalizeIdentifier));
const MATH_OPERATOR_CALL_CODES = new Map([
    ["abs", "absolute-value"], ["sgn", "sign"], ["fix", "truncate"],
    ["frac", "fractional-part"], ["int", "floor"], ["sin", "sine"],
    ["asin", "arcsine"], ["cos", "cosine"], ["acos", "arccosine"],
    ["tan", "tangent"], ["atn", "arctangent"], ["atan2", "arctangent2"],
    ["sqr", "square-root"], ["len", "length"], ["log", "logarithm"], ["exp", "exponential"]
]);
// Namespace-owned shared storage can run constructors during module startup.
const NON_MODULE_CALL_SCOPES = new Set([
    "function", "sub", "property", "constructor", "destructor", "operator", "macro", "prototype",
    "type", "class", "union", "enum"
]);
const MAX_SOURCE_TYPE_HIERARCHY_ENTRIES = 20000;

function sidecarReturnTypeMatches(model, entry, typeName) {
    const selectedType = normalizeTypeName(typeName);
    if (!selectedType) return false;
    if (normalizeTypeName(entry.declaration.typeName) === selectedType) return true;
    return model.typeEntries(entry).some((type) =>
        normalizeTypeName(type.qualifiedName) === selectedType || normalizeTypeName(type.name) === selectedType
    );
}

function isIndexOperatorEntry(entry) {
    if (entry?.declaration?.type !== "operator") return false;
    const name = String(entry.name || entry.declaration.name).replace(/\s+/g, "").toLowerCase();
    return name === "operator[]" || name === "[" || name === "[]";
}

function newConstructorTypeSpan(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (getCodeContext(text, offset) !== "code") return null;
    let start = offset;
    let end = offset;
    const identifierCharacter = /[A-Za-z0-9_.$%!#&]/;
    while (start > 0 && identifierCharacter.test(text[start - 1])) start--;
    while (end < text.length && identifierCharacter.test(text[end])) end++;
    const name = text.slice(start, end);
    if (!/^[A-Za-z_][A-Za-z0-9_.$%!#&]*$/.test(name) ||
        !/\bNEW\s*$/i.test(text.slice(0, start).trimEnd())) return null;
    return { start, end };
}

function isNewConstructorCallee(document, position) {
    const span = newConstructorTypeSpan(document, position);
    return Boolean(span && /^\s*\(/.test(document.getText().slice(span.end)));
}

function isNumericLabelOccurrenceAt(document, position) {
    const lineText = document.lineAt(position.line)?.text;
    if (typeof lineText !== "string") return false;
    const tokens = tokenize(lineText).tokens;
    const index = tokens.findIndex((token) => token.kind === "number" &&
        position.character >= token.startColumn && position.character <= token.endColumn &&
        isNumericLabelName(token.name));
    if (index < 0) return false;
    let segmentStart = 0;
    for (let previous = index - 1; previous >= 0; previous--) {
        if (tokens[previous].name === ":") {
            segmentStart = previous + 1;
            break;
        }
    }
    const preceding = tokens.slice(segmentStart, index);
    if (!preceding.length) return true;
    const previous = normalizeIdentifier(preceding.at(-1).name);
    if (["goto", "gosub", "return", "restore", "then", "else"].includes(previous)) return true;
    if (preceding.at(-1).name !== ",") return false;
    for (let candidate = preceding.length - 2; candidate >= 0; candidate--) {
        const name = normalizeIdentifier(preceding[candidate].name);
        if (["goto", "gosub"].includes(name)) {
            return preceding.slice(candidate + 1).every((token) => token.kind === "number" || token.name === ",");
        }
    }
    return false;
}

function noKeywordOptionDocumentRecord(document) {
    const text = document.getText();
    let cached = noKeywordOptionDocumentCache.get(document);
    if (!cached || cached.version !== document.version || cached.text !== text) {
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
                    const name = normalizeIdentifier(
                        keyword.trim().match(/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/)?.[0] || ""
                    );
                    if (name && !firstOffsets.has(name)) firstOffsets.set(name, endOffset);
                }
            }
        }
        cached = { version: document.version, text, firstOffsets, lineOffsets };
        noKeywordOptionDocumentCache.set(document, cached);
    }
    return cached;
}

function isPotentialNoKeywordIdentifierAt(document, position) {
    const lineText = document.lineAt(position.line)?.text;
    if (typeof lineText !== "string") return false;
    const match = [...lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)].find((candidate) =>
        position.character >= candidate.index &&
        position.character < candidate.index + candidate[0].length
    );
    if (!match) return false;
    const cached = noKeywordOptionDocumentRecord(document);
    const optionOffset = cached.firstOffsets.get(normalizeIdentifier(match[0]));
    if (!Number.isSafeInteger(optionOffset)) return false;
    /* Source-token coordinates are not VS Code Position instances. */
    const offset = (cached.lineOffsets[position.line] ?? cached.text.length) + match.index;
    return Number.isSafeInteger(optionOffset) && optionOffset <= offset;
}

function hasPotentialNoKeywordOptionInDocument(document) {
    return noKeywordOptionDocumentRecord(document).firstOffsets.size > 0;
}

function isSourceMacroAtPosition(index, document, position) {
    const lineText = document.lineAt(position.line)?.text;
    if (typeof lineText !== "string" || !tokenize(lineText).tokens.some((token) =>
        token.kind === "identifier" && position.character >= token.startColumn &&
        position.character <= token.endColumn)) return false;
    const sourceModel = index.getSourceSemanticModel?.() ||
        index.getSemanticModel?.(document.uri, { sourceOnly: true });
    /* Source resolution only decides whether a full sidecar is worth requesting. */
    return sourceModel?.resolveAt?.(document.uri, position.line, position.character)
        ?.some((entry) => entry.declaration?.type === "macro") === true;
}

function isNewConstructorTypeAtPosition(document, position) {
    return newConstructorTypeSpan(document, position) !== null;
}

function isConstructorTypeCallAtPosition(model, document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (getCodeContext(text, offset) !== "code") return false;
    let start = offset;
    let end = offset;
    const identifierCharacter = /[A-Za-z0-9_.$%!#&]/;
    while (start > 0 && identifierCharacter.test(text[start - 1])) start--;
    while (end < text.length && identifierCharacter.test(text[end])) end++;
    if (!/^[A-Za-z_][A-Za-z0-9_.$%!#&]*$/.test(text.slice(start, end)) ||
        !/^\s*\(/.test(text.slice(end))) return false;
    return model.resolveAt(document.uri, position.line, position.character).some((entry) =>
        ["type", "class", "union"].includes(entry.declaration.type));
}

function isCallCalleeAtPosition(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (getCodeContext(text, offset) !== "code") return false;
    let start = offset;
    let end = offset;
    const identifierCharacter = /[A-Za-z0-9_.$%!#&]/;
    while (start > 0 && identifierCharacter.test(text[start - 1])) start--;
    while (end < text.length && identifierCharacter.test(text[end])) end++;
    return /^[A-Za-z_][A-Za-z0-9_.$%!#&]*$/.test(text.slice(start, end)) &&
        /^\s*\(/.test(text.slice(end));
}

function compilerOperatorKeywordAtPosition(document, position) {
    const text = document.getText();
    if (getCodeContext(text, document.offsetAt(position)) !== "code") return "";
    const line = document.lineAt(position.line).text;
    let start = position.character;
    let end = position.character;
    const identifierCharacter = /[A-Za-z0-9_]/;
    while (start > 0 && identifierCharacter.test(line[start - 1])) start--;
    while (end < line.length && identifierCharacter.test(line[end])) end++;
    const name = normalizeIdentifier(line.slice(start, end));
    return COMPILER_OPERATOR_KEYWORDS.has(name) ? name : "";
}

function hasPotentialIteratorOperatorAt(model, document, position) {
    const keyword = compilerOperatorKeywordAtPosition(document, position);
    if (!ITERATOR_OPERATOR_KEYWORDS.has(keyword)) return false;
    if (typeof model?.getDocument !== "function" || !Array.isArray(model.entries)) return false;
    const source = model.getDocument(document.uri);
    if (!source) return false;
    return model.entries.some((entry) => {
        if (entry.declaration.type !== "operator" || entry.conditional || entry.provisional ||
            entry.declaration.provisional || !source.visibleDocuments.has(entry.document.key)) return false;
        let operatorName = String(entry.declaration.name || "").replace(/^operator\s+/i, "").trim();
        const separator = operatorName.lastIndexOf(".");
        if (separator >= 0) operatorName = operatorName.slice(separator + 1);
        return normalizeIdentifier(operatorName) === keyword;
    });
}

function hasCompilerOperatorReceiptAt(model, document, position) {
    if (hasPotentialOperatorLetAt(model, document, position)) return true;
    const names = [];
    const keyword = compilerOperatorKeywordAtPosition(document, position);
    const operatorToken = operatorTokenAtPosition(document, position);
    /* `=>` is an assignment alias, not the overloaded equality operator. */
    if (operatorToken === "=>") return false;
    if (keyword) names.push(keyword);
    if (operatorToken) names.push(OPERATOR_TOKEN_ALIASES.get(operatorToken) || operatorToken);
    if (!keyword && !operatorToken &&
        findCallContext(document.getText(), document.offsetAt(position))?.indexing) return false;
    if (isCastCalleeAt(document, position)) names.push("cast");
    else if (isMathOperatorCalleeAt(document, position)) names.push(operatorCalleeNameAt(document, position));
    return names.length > 0 && hasVisibleOperatorNamedAt(model, document, names);
}

function hasPotentialOperatorReceiptSyntaxAt(document, position) {
    if (compilerOperatorKeywordAtPosition(document, position) || isOperatorTokenAt(document, position) ||
        isCastCalleeAt(document, position) || isMathOperatorCalleeAt(document, position)) return true;
    const offset = document.offsetAt(position);
    if (getCodeContext(document.getText(), offset) !== "code") return false;
    return /^\s*(?:(?:private|protected|public)\s+)*(?:declare\s+)?operator\b/i
        .test(document.lineAt(position.line).text);
}

function isDeleteKeywordAtPosition(document, position) {
    return compilerOperatorKeywordAtPosition(document, position) === "delete";
}

function isDestructorControlTransferAtPosition(document, position) {
    const text = document.getText();
    if (getCodeContext(text, document.offsetAt(position)) !== "code") return false;
    const line = document.lineAt(position.line).text;
    let start = position.character;
    let end = position.character;
    const identifierCharacter = /[A-Za-z0-9_]/;
    while (start > 0 && identifierCharacter.test(line[start - 1])) start--;
    while (end < line.length && identifierCharacter.test(line[end])) end++;
    return ["goto", "return", "exit", "continue"].includes(normalizeIdentifier(line.slice(start, end)));
}

function isConstructorDeclarationAtPosition(document, position) {
    return isLifetimeDeclarationAtPosition(document, position, "constructor");
}

function isDestructorDeclarationAtPosition(document, position) {
    return isLifetimeDeclarationAtPosition(document, position, "destructor");
}

function isLifetimeDeclarationAtPosition(document, position, kind) {
    if (position.line < 0 || position.line >= document.lineCount) return false;
    const line = document.lineAt(position.line).text;
    const implementation = line.match(new RegExp(`^\\s*(?:(?:private|public|protected)\\s+)?${kind}\\s+([A-Za-z_][A-Za-z0-9_.$%!#&]*)`, "i"));
    if (implementation) {
        const ownerStart = line.indexOf(implementation[1], implementation.index);
        if (position.character >= ownerStart && position.character < ownerStart + implementation[1].length) return true;
    }
    let start = position.character;
    let end = position.character;
    const identifierCharacter = /[A-Za-z0-9_]/;
    while (start > 0 && identifierCharacter.test(line[start - 1])) start--;
    while (end < line.length && identifierCharacter.test(line[end])) end++;
    if (normalizeIdentifier(line.slice(start, end)) !== kind) return false;
    return /^\s*(?:(?:declare|private|public|protected|virtual|abstract|override)\s+)*$/i.test(line.slice(0, start));
}

async function sidecarConstructorProcedureLocation(index, document, position, token) {
    return sidecarLifetimeProcedureLocation(index, document, position, token, "constructor");
}

async function sidecarDestructorProcedureLocation(index, document, position, token) {
    return sidecarLifetimeProcedureLocation(index, document, position, token, "destructor");
}

async function sidecarLifetimeProcedureLocation(index, document, position, token, kind) {
    index.getParsedDocument(document);
    if (!await index.ensureInitialized(token) || token?.isCancellationRequested) return null;
    const model = index.getSourceSemanticModel?.() || index.getSemanticModel(document.uri, { sourceOnly: true });
    const source = model?.getDocument(document.uri);
    if (!source) return null;
    const targets = model.resolveAt(document.uri, position.line, position.character)
        .filter((entry) => entry.declaration.type === kind && !entry.conditional && !entry.provisional);
    const declarations = targets.length ? targets : source.entries.filter((entry) =>
        entry.declaration.type === kind && entry.declaration.line === position.line &&
        position.character >= entry.declaration.startColumn && position.character < entry.declaration.endColumn &&
        !entry.conditional && !entry.provisional
    );
    if (declarations.length !== 1) return null;
    const familyKey = sourceLifetimeProcedureFamilyKey(declarations[0].declaration);
    if (!familyKey) return null;
    const family = sourceCallableFamily(model, declarations[0]).filter((entry) =>
        !entry.conditional && !entry.provisional && !entry.declaration.provisional);
    const definitions = family.filter((entry) => !entry.declaration.modifiers.includes("DECLARE"));
    if (definitions.length > 1 || !definitions.length && kind !== "destructor") return null;
    const definition = definitions[0] || declarations[0];
    const filePath = definition.uri.fsPath || definition.uri.path;
    if (!filePath) return null;
    const declarationLocations = new Map();
    for (const entry of family) {
        const sourcePath = entry.uri.fsPath || entry.uri.path;
        if (sourcePath) declarationLocations.set(`${sourcePath}:${entry.declaration.line}`, {
            filePath: sourcePath,
            line: entry.declaration.line
        });
    }
    return { filePath, startLine: definition.declaration.line + 1, declarations: [...declarationLocations.values()] };
}

function sourceLifetimeProcedureFamilyKey(declaration) {
    const bodyOwner = String(declaration.name || "").match(/^(?:constructor|destructor)\s+(.+)$/i)?.[1];
    /* A prototype's container is its type. An out-of-line body's container
       may instead be the namespace around its written type name. */
    let owner = declaration.containerName || "";
    if (bodyOwner) {
        owner = bodyOwner.startsWith(".") ? bodyOwner.slice(1) : [owner, bodyOwner].filter(Boolean).join(".");
    }
    const parameters = (declaration.parameters || []).map((parameter) => {
        const label = String(parameter.label || "");
        const mode = label.match(/^\s*(byval|byref|bydesc|bycopy)\b/i)?.[1]?.toLowerCase() || "byval";
        return [mode, sourceParameterTypeKey(parameter), parameter.variadic === true];
    });
    return owner ? JSON.stringify([normalizeTypeName(owner), parameters]) : "";
}

async function sourceConstructorProcedureLocation(index, document, position, token) {
    index.getParsedDocument(document);
    if (!await index.ensureInitialized(token) || token?.isCancellationRequested) return null;
    const model = index.getSemanticModel(document.uri, { allowSidecarOnly: false });
    const source = model?.getDocument(document.uri);
    if (!source) return null;
    const candidates = model.resolveAt(document.uri, position.line, position.character)
        .filter((entry) => entry.declaration.type === "constructor" && !entry.conditional && !entry.provisional);
    const declarations = candidates.length
        ? candidates
        : source.entries.filter((entry) => entry.declaration.type === "constructor" &&
            entry.declaration.line === position.line &&
            position.character >= entry.declaration.startColumn && position.character < entry.declaration.endColumn &&
            !entry.conditional && !entry.provisional);
    if (declarations.length !== 1) return null;
    const familyKey = sourceLifetimeProcedureFamilyKey(declarations[0].declaration);
    if (!familyKey) return null;
    const definitions = sourceCallableFamily(model, declarations[0]).filter((entry) =>
        !entry.declaration.modifiers.includes("DECLARE") && !entry.conditional && !entry.provisional &&
        !entry.declaration.provisional);
    if (definitions.length !== 1) return null;
    const filePath = definitions[0].uri.fsPath || definitions[0].uri.path;
    return filePath ? { filePath, startLine: definitions[0].declaration.line + 1 } : null;
}

function sourceOperatorIdentity(entry) {
    const declaration = entry?.declaration;
    if (declaration?.type !== "operator") return null;
    let name = String(declaration.name || "").replace(/^operator\s+/i, "").trim();
    let owner = declaration.containerName || "";
    const separator = name.lastIndexOf(".");
    if (separator > 0) {
        const writtenOwner = name.slice(0, separator);
        // The container around a qualified body may be its enclosing namespace,
        // while a prototype's container already names the owning aggregate.
        owner = writtenOwner.startsWith(".") ? writtenOwner.slice(1) : [owner, writtenOwner].filter(Boolean).join(".");
        name = name.slice(separator + 1);
    }
    return { owner: normalizeTypeName(owner), name: normalizeIdentifier(name) };
}

function indexOperatorOwner(entry) {
    return sourceOperatorIdentity(entry)?.owner || normalizeTypeName(entry.scope?.qualifiedName || "");
}

function indexOperatorParameters(entry) {
    return JSON.stringify((entry.declaration.parameters || []).map((parameter) => {
        const label = String(parameter.label || "");
        const mode = label.match(/^\s*(byval|byref|bydesc|bycopy)\b/i)?.[1]?.toLowerCase() || "";
        return [mode, sourceParameterTypeKey(parameter), /\bconst\b/i.test(label),
            parameter.optional === true, parameter.variadic === true];
    }));
}

function sourceIndexOperatorFamilyKey(entry) {
    const owner = indexOperatorOwner(entry);
    return owner ? JSON.stringify([owner, indexOperatorParameters(entry)]) : "";
}

function sourceOperatorFamilyKey(entry) {
    const identity = sourceOperatorIdentity(entry);
    if (!identity) return "";
    const family = [identity.owner, identity.name, indexOperatorParameters(entry)];
    /* CAST overloads are selected by destination type. Pointer and const
       qualifiers are part of that type, not spelling to discard here. */
    if (identity.name === "cast") family.push(sourceTypeKey(entry.declaration.typeName));
    return JSON.stringify(family);
}

function sourceOperatorExpressionCode(entry) {
    if (entry?.declaration?.type !== "operator") return "";
    let name = String(entry.declaration.name || "").replace(/^operator\s+/i, "").trim();
    const separator = name.lastIndexOf(".");
    if (separator >= 0) name = name.slice(separator + 1);
    name = normalizeIdentifier(name);
    return name === "cast" ? "cast" : MATH_OPERATOR_CALL_CODES.get(name) || "";
}

function sidecarOperatorEntriesAtProcedures(model, procedures) {
    const entries = new Map();
    for (const procedure of procedures || []) {
        if (!procedure?.filePath || !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
        const source = model.getDocument(CompilerUri.file(procedure.filePath));
        if (!source) continue;
        for (const entry of source.entries) {
            if (entry.declaration.type !== "operator" || entry.declaration.line !== procedure.startLine - 1 ||
                entry.conditional || entry.provisional || entry.declaration.provisional) continue;
            entries.set(entry.id, entry);
        }
    }
    return [...entries.values()];
}

function sidecarImplicitCallEntryAtProcedures(model, procedures, source, kind) {
    if (!source) return null;
    const declarationType = ["destructor-call", "temporary-destructor", "delete-destructor",
        "scope-exit-destructor"].includes(kind)
        ? "destructor" : "constructor";
    const entries = new Map();
    for (const procedure of procedures || []) {
        if (!procedure?.filePath || !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
        const procedureSource = model.getDocument(CompilerUri.file(procedure.filePath));
        if (!procedureSource) continue;
        for (const entry of procedureSource.entries) {
            if (entry.declaration.type === declarationType && entry.declaration.line === procedure.startLine - 1 &&
                !entry.conditional && !entry.provisional && !entry.declaration.provisional &&
                source.visibleDocuments.has(entry.document.key)) {
                entries.set(entry.id, entry);
            }
        }
    }
    return entries.size === 1 ? entries.values().next().value : null;
}

function sourceOperatorDeclarationTargets(model, target) {
    const key = sourceOperatorFamilyKey(target);
    if (!key) return [target];
    const family = sourceCallableFamily(model, target).filter((entry) =>
        !entry.conditional && !entry.provisional && !entry.declaration.provisional);
    const declarations = family.filter((entry) => entry.declaration.modifiers.includes("DECLARE"));
    return declarations.length ? declarations : [target];
}

function sourceOperatorImplementationTargets(model, target) {
    const key = sourceOperatorFamilyKey(target);
    if (!key) return [];
    return sourceCallableFamily(model, target).filter((entry) =>
        !entry.declaration.modifiers.includes("DECLARE") && !entry.conditional && !entry.provisional &&
        !entry.declaration.provisional);
}

function isOperatorTokenAt(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (getCodeContext(text, offset) !== "code") return false;
    const operators = ["<<=", ">>=", "&=>", "+=>", "-=>", "*=>", "/=>", "\\=>", "^=>", "=>",
        "+=", "-=", "*=", "/=", "\\=", "^=", "&=",
        "->", "<=", ">=", "<>", "<<", ">>",
        "+", "-", "*", "/", "\\", "^", "&", "=", "<", ">", "!", "@", "."];
    for (const operator of operators) {
        const first = Math.max(0, offset - operator.length + 1);
        const last = Math.min(offset, text.length - operator.length);
        for (let start = first; start <= last; start++) {
            if (start <= offset && offset < start + operator.length && text.slice(start, start + operator.length) === operator) return true;
        }
    }
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const lineEnd = text.indexOf("\n", offset);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    const column = offset - lineStart;
    for (const match of line.matchAll(/\b(?:andalso|orelse|and|or|xor|eqv|imp|mod|not|is|shl|shr|new|delete)\b/gi)) {
        if (column >= match.index && column < match.index + match[0].length) return true;
    }
    for (const match of line.matchAll(/\b(?:andalso|orelse|and|or|xor|eqv|imp|mod|shl|shr)(?:=>|=)/gi)) {
        if (column >= match.index && column < match.index + match[0].length) return true;
    }
    return false;
}

function operatorTokenAtPosition(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (getCodeContext(text, offset) !== "code") return "";
    const line = document.lineAt(position.line).text;
    for (const match of line.matchAll(/\b(?:andalso|orelse|and|or|xor|eqv|imp|mod|shl|shr)(?:=>|=)/gi)) {
        if (position.character >= match.index && position.character < match.index + match[0].length) {
            return match[0].toLowerCase();
        }
    }
    const operators = ["<<=", ">>=", "&=>", "+=>", "-=>", "*=>", "/=>", "\\=>", "^=>", "=>",
        "+=", "-=", "*=", "/=", "\\=", "^=", "&=",
        "->", "<=", ">=", "<>", "<<", ">>",
        "+", "-", "*", "/", "\\", "^", "&", "=", "<", ">", "!", "@", "."];
    for (const operator of operators) {
        const first = Math.max(0, offset - operator.length + 1);
        const last = Math.min(offset, text.length - operator.length);
        for (let start = first; start <= last; start++) {
            if (start <= offset && offset < start + operator.length &&
                text.slice(start, start + operator.length) === operator) return operator;
        }
    }
    return "";
}

function hasVisibleOperatorNamedAt(model, document, names) {
    if (typeof model?.getDocument !== "function" || !Array.isArray(model.entries)) return false;
    const source = model?.getDocument(document.uri);
    if (!source || !source.visibleDocuments || !Array.isArray(model.entries)) return false;
    const expected = new Set(names.map(normalizeIdentifier).filter(Boolean));
    return model.entries.some((entry) => {
        if (entry?.declaration?.type !== "operator" || !entry.document?.key ||
            !source.visibleDocuments.has(entry.document.key)) return false;
        let name = String(entry.declaration.name || "").replace(/^operator\s+/i, "").trim();
        const separator = name.lastIndexOf(".");
        if (separator >= 0) name = name.slice(separator + 1);
        name = normalizeIdentifier(name);
        return expected.has(name) || [...expected].some((candidate) => name === `${candidate}[]`);
    });
}

function isCastCalleeAt(document, position) {
    return semanticOperatorCalleeCodeAt(document, position) === "cast";
}

function isMathOperatorCalleeAt(document, position) {
    return MATH_OPERATOR_CALL_CODES.has(operatorCalleeNameAt(document, position));
}

function operatorCalleeNameAt(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (getCodeContext(text, offset) !== "code") return "";
    let start = offset;
    let end = offset;
    const identifierCharacter = /[A-Za-z0-9_.$%!#&]/;
    while (start > 0 && identifierCharacter.test(text[start - 1])) start--;
    while (end < text.length && identifierCharacter.test(text[end])) end++;
    if (!/^\s*\(/.test(text.slice(end))) return "";
    return normalizeIdentifier(text.slice(start, end));
}

function semanticOperatorCalleeCodeAt(document, position) {
    const name = operatorCalleeNameAt(document, position);
    if (CAST_CALLEE_NAMES.has(name)) return "cast";
    return MATH_OPERATOR_CALL_CODES.get(name) || "";
}

function hasPotentialOperatorLetAt(model, document, position) {
    const line = document.lineAt(position.line).text;
    const token = operatorTokenAtPosition(document, position);
    let assignmentColumn = position.character;
    if (token === "=>") {
        assignmentColumn = line.lastIndexOf("=>", position.character);
        if (assignmentColumn < 0) return false;
    } else if (token !== "=" || line[position.character] !== "=") {
        return false;
    }
    if (typeof model?.resolveAt !== "function") return false;
    const rawLeft = line.slice(0, assignmentColumn);
    let left = rawLeft.trim().replace(/^let\s+/i, "").trimStart();
    if (!left) return false;
    /* A member lvalue may have a different UDT from its owner. Resolve its
       final top-level name, while skipping index and call arguments; FBC still
       selects the exact Operator Let target from the physical receipt. */
    const receivers = sourceLValueReceivers(left);
    if (!receivers.length) return false;
    const source = model.inner ? model.inner.getDocument(model.expandedUri) : model.getDocument(document.uri);
    if (!source) return false;
    const leftOffset = rawLeft.lastIndexOf(left);
    if (leftOffset < 0) return false;
    for (const receiver of receivers) {
        const receiverStart = leftOffset + receiver.start;
        const targets = model.resolveAt(document.uri, position.line, receiverStart + receiver.name.length - 1);
        const types = targets.flatMap((entry) => model.typeEntries(entry));
        if (!types.length) continue;
        const offset = positionOffset(source, position.line, receiverStart);
        const scope = scopeAt(source, offset);
        const members = model.inner ? model.inner.members(types, source, scope) : model.members(types, source, scope);
        if (members.some((entry) => entry.declaration.type === "operator" &&
            normalizeIdentifier(String(entry.declaration.name || "").replace(/^operator\s+/i, "").split(".").at(-1)) === "let")) {
            return true;
        }
    }
    return false;
}

function sourceLValueReceivers(text) {
    const masked = maskFreeBasicText(text);
    const identifier = /[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/y;
    const delimiters = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
    const closers = new Set([...delimiters.values()]);
    const topLevel = [];
    const nested = [];
    let depth = 0;

    for (let offset = 0; offset < masked.length;) {
        const character = masked[offset];
        if (delimiters.has(character)) {
            depth++;
            offset++;
            continue;
        }
        if (closers.has(character)) {
            depth = Math.max(0, depth - 1);
            offset++;
            continue;
        }
        identifier.lastIndex = offset;
        const match = identifier.exec(masked);
        if (!match) {
            offset++;
            continue;
        }
        const entry = { name: match[0], start: offset };
        (depth === 0 ? topLevel : nested).push(entry);
        offset = identifier.lastIndex;
    }

    const lastTopLevel = topLevel.at(-1);
    const firstTopLevel = topLevel[0];
    if (lastTopLevel && firstTopLevel && lastTopLevel.start !== firstTopLevel.start) {
        return [lastTopLevel, firstTopLevel];
    }
    const receiver = lastTopLevel || nested.at(-1);
    return receiver ? [receiver] : [];
}

function sourceIndexOperatorDefinitions(model, entries, document) {
    const source = model.getDocument(document.uri);
    if (!source) return model.declarationTargets(entries);
    /* A header cannot see an implementation that includes it. The connected
       family supplies that reverse link without admitting unrelated owners. */
    const definitions = new Map();
    for (const entry of entries) {
        if (!indexOperatorOwner(entry)) continue;
        for (const candidate of sourceCallableFamily(model, entry)) {
            if (!isIndexOperatorEntry(candidate) || candidate.declaration.modifiers.includes("DECLARE") ||
                candidate.conditional || candidate.provisional || candidate.declaration.provisional) continue;
            definitions.set(`${candidate.uri.toString()}:${candidate.offset}`, candidate);
        }
    }
    return definitions.size ? [...definitions.values()] : model.declarationTargets(entries);
}

function sourceIndexOperatorEntries(model, document, position) {
    const text = document.getText();
    const context = findCallContext(text, document.offsetAt(position));
    if (!context?.indexing) return null;
    /* An argument identifier is not the surrounding index operator. Signature
       Help has its own call-context path and still describes the index call. */
    if (tokenize(document.lineAt(position.line).text).tokens.some((candidate) =>
        candidate.kind === "identifier" && position.character >= candidate.startColumn &&
        position.character < candidate.endColumn)) return null;

    const before = text.slice(0, context.openParenthesisOffset).trimEnd();
    if (!before) return [];
    const receiverPosition = document.positionAt(before.length - 1);
    const receivers = model.resolveAt(document.uri, receiverPosition.line, receiverPosition.character);
    const direct = receivers.filter(isIndexOperatorEntry);
    if (direct.length) return direct;

    const types = receivers.flatMap((entry) => model.typeEntries(entry));
    if (!types.length) return [];

    const source = model.inner ? model.inner.getDocument(model.expandedUri) : model.getDocument(document.uri);
    if (!source) return [];
    let selection = receiverPosition;
    if (model.inner) {
        selection = model.projectPosition(document.uri, receiverPosition.line, receiverPosition.character);
        if (!selection) return [];
    }

    const scope = scopeAt(source, positionOffset(source, selection.line, selection.character));
    const members = model.inner
        ? model.inner.members(types, source, scope)
        : model.members(types, source, scope);
    return members.filter(isIndexOperatorEntry);
}

function sourceIndexOperatorDeclarationEntries(model, document, position) {
    const source = model.getDocument(document.uri);
    if (!source) return [];
    return source.entries.filter((entry) => isIndexOperatorEntry(entry) && !entry.conditional &&
        !entry.provisional && !entry.declaration.provisional && entry.declaration.line === position.line &&
        position.character >= entry.declaration.startColumn && position.character <= entry.declaration.endColumn);
}

function sourceOperatorDeclarationEntries(model, document, position) {
    const source = model.getDocument(document.uri);
    if (!source) return [];
    return source.entries.filter((entry) => entry.declaration.type === "operator" && !entry.conditional &&
        !entry.provisional && !entry.declaration.provisional && entry.declaration.line === position.line &&
        position.character >= entry.declaration.startColumn && position.character <= entry.declaration.endColumn);
}

function sourceIndexOperatorTargets(model, document, position) {
    const entries = sourceIndexOperatorEntries(model, document, position);
    return entries === null ? null : sourceIndexOperatorDefinitions(model, entries, document);
}

function matchedBracketRanges(maskedText) {
    const closingFor = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
    const openingFor = new Map([...closingFor].map(([opening, closing]) => [closing, opening]));
    const stack = [];
    const ranges = [];
    for (let offset = 0; offset < maskedText.length; offset++) {
        const character = maskedText[offset];
        if (closingFor.has(character)) {
            stack.push({ character, offset });
            continue;
        }
        const opening = openingFor.get(character);
        if (!opening) continue;
        for (let index = stack.length - 1; index >= 0; index--) {
            if (stack[index].character !== opening) continue;
            ranges.push([stack[index].offset, offset + 1]);
            stack.length = index;
            break;
        }
    }
    return ranges;
}

function selectionRangeForPosition(vscode, textDocument, source, bracketRanges, position, compilerRanges = []) {
    const offset = textDocument.offsetAt(position);
    const candidates = new Map();
    const add = (start, end) => {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > offset || end < offset || start > end) return;
        candidates.set(`${start}:${end}`, { start, end });
    };

    let selectedToken = source.tokens.find((candidate) => candidate.offset <= offset && offset < candidate.end);
    if (!selectedToken && offset > 0) selectedToken = source.tokens.find((candidate) => candidate.end === offset);
    if (selectedToken) add(selectedToken.offset, selectedToken.end);
    for (const [start, end] of bracketRanges) add(start, end);
    for (const compilerRange of compilerRanges) {
        const start = compilerRange?.start;
        const end = compilerRange?.end;
        if (!start || !end || !Number.isSafeInteger(start.line) || !Number.isSafeInteger(start.character) ||
            !Number.isSafeInteger(end.line) || !Number.isSafeInteger(end.character) ||
            start.line < 0 || start.line >= textDocument.lineCount || end.line < start.line || end.line >= textDocument.lineCount ||
            start.character < 0 || end.character < 0) continue;
        if (start.character > textDocument.lineAt(start.line).text.length ||
            end.character > textDocument.lineAt(end.line).text.length) continue;
        add(textDocument.offsetAt(start), textDocument.offsetAt(end));
    }
    for (const folding of source.parsed.foldingRanges || []) {
        if ((folding.kind !== "comment" && folding.kind !== "region") ||
            position.line < folding.startLine || position.line > folding.endLine) continue;
        const start = textDocument.offsetAt(new vscode.Position(folding.startLine, 0));
        const endLine = textDocument.lineAt(folding.endLine).text.length;
        const end = textDocument.offsetAt(new vscode.Position(folding.endLine, endLine));
        add(start, end);
    }

    for (const statement of source.parsed.statements || []) {
        const start = textDocument.offsetAt(new vscode.Position(statement.startLine, statement.startColumn || 0));
        const end = textDocument.offsetAt(new vscode.Position(statement.endLine, statement.endColumn ?? 0));
        add(start, end);
    }
    for (let scope = scopeAt(source, offset); scope; scope = scope.parent) add(scope.start, scope.end);
    add(0, textDocument.getText().length);

    const ordered = [...candidates.values()].sort((left, right) =>
        (right.end - right.start) - (left.end - left.start) || left.start - right.start
    );
    let result = null;
    let parentSpan = null;
    for (const candidate of ordered) {
        if (parentSpan && (candidate.start < parentSpan.start || candidate.end > parentSpan.end)) continue;
        const range = new vscode.Range(textDocument.positionAt(candidate.start), textDocument.positionAt(candidate.end));
        result = new vscode.SelectionRange(range, result || undefined);
        parentSpan = candidate;
    }
    return result;
}

function sidecarOverloadKey(entry) {
    const declaration = entry.declaration;
    const parameters = (declaration.parameters || []).map((parameter) => {
        const label = String(parameter.label || "");
        const mode = label.match(/^\s*(byval|byref|bydesc|bycopy)\b/i)?.[1]?.toLowerCase() || "";
        const constant = /\bconst\b/i.test(label);
        return [mode, sourceParameterTypeKey(parameter), constant,
            parameter.optional === true, parameter.variadic === true];
    });
    return JSON.stringify([
        normalizeIdentifier(entry.qualifiedName || entry.name),
        declaration.type,
        normalizeTypeName(declaration.typeName),
        parameters
    ]);
}

function sidecarCallTargetOverloadKey(model, call) {
    if (call?.targetSymbols?.length !== 1 || !Array.isArray(call.declarations) || !call.declarations.length) return "";
    const keys = new Set();
    for (const site of call.declarations) {
        if (!site?.filePath || !Number.isSafeInteger(site.line) || !Number.isSafeInteger(site.startColumn) ||
            !Number.isSafeInteger(site.endColumn)) continue;
        const uri = CompilerUri.file(site.filePath);
        const source = model.getDocument(uri);
        if (!source || site.line < 0 || site.line >= source.lineOffsets.length ||
            site.startColumn < 0 || site.endColumn <= site.startColumn) continue;
        const start = positionOffset(source, site.line, site.startColumn);
        const end = positionOffset(source, site.line, site.endColumn);
        const name = normalizeIdentifier(String(site.name || "").split(".").at(-1));
        for (const entry of source.entries) {
            if (entry.declaration.line !== site.line ||
                !["sub", "function", "property", "operator"].includes(entry.declaration.type) ||
                entry.conditional || entry.provisional || entry.declaration.provisional) continue;
            const exact = entry.offset === start && entry.end === end;
            const terminal = entry.end === end && name && normalizeIdentifier(entry.name) === name;
            if (exact || terminal) keys.add(sidecarOverloadKey(entry));
        }
    }
    return keys.size === 1 ? keys.values().next().value : "";
}

function sidecarOperatorTargetOverloadKey(model, expression) {
    if (expression?.targetSymbols?.length !== 1 || !Array.isArray(expression.procedures) || !expression.procedures.length) return "";
    const keys = new Set();
    for (const procedure of expression.procedures) {
        if (!procedure?.filePath || !Number.isSafeInteger(procedure.startLine) || procedure.startLine < 1) continue;
        const source = model.getDocument(CompilerUri.file(procedure.filePath));
        if (!source) continue;
        for (const entry of source.entries) {
            if (entry.declaration.line !== procedure.startLine - 1 || entry.declaration.type !== "operator" ||
                entry.conditional || entry.provisional || entry.declaration.provisional) continue;
            const key = sourceIndexOperatorFamilyKey(entry);
            if (key) keys.add(key);
        }
    }
    return keys.size === 1 ? keys.values().next().value : "";
}

function hasSidecarBindingData(model) {
    if (model?.remote) return model.semanticBindingsAvailable === true;
    return Boolean(model?.semanticSidecarOnly) &&
        (model.semanticBindingsAvailable === true ||
            Array.isArray(model.semanticBindings) && model.semanticBindings.length > 0);
}

async function sidecarBindingModel(index, document, token, currentCompilerModel = null) {
    if (hasSidecarBindingData(currentCompilerModel)) return currentCompilerModel;
    const model = await compilerEditorModel(index, document, token, true, true);
    return hasSidecarBindingData(model) ? model : null;
}

async function compilerBindingModel(index, document, token, currentCompilerModel = null) {
    if (currentCompilerModel?.semanticBindingsAvailable === true) return currentCompilerModel;
    const model = await compilerEditorModel(index, document, token, true, true);
    return model?.semanticBindingsAvailable === true ? model : null;
}

async function sidecarSelectedOperatorTarget(index, document, position, model, token, currentCompilerModel = null) {
    const expressionModel = currentCompilerModel?.semanticSidecarOnly || currentCompilerModel?.semanticBindingsAvailable
        ? currentCompilerModel
        : await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
    if (!expressionModel || token?.isCancellationRequested) return null;
    const expression = expressionModel.remote
        ? await expressionModel.expressionAt(document.uri, position, position, token)
        : expressionModel.semanticSidecarOnly
            ? expressionModel.expressionAtCompilerSidecarOnly?.(document.uri, position)
            : expressionModel.expressionAt?.(document.uri, position);
    if (expression?.provisional || token?.isCancellationRequested) return null;
    const sourceOperationSite = hasCompilerOperatorReceiptAt(model, document, position);
    let operatorCode = expression?.operatorKind === "overloaded" ? expression.operatorCode || "" : "";
    if (!operatorCode && sourceOperationSite) {
        operatorCode = semanticOperatorCalleeCodeAt(document, position);
    }
    if (!operatorCode && !sourceOperationSite) return null;

    const compilerModel = await compilerBindingModel(index, document, token, expressionModel);
    if (!compilerModel || token?.isCancellationRequested) return null;
    const result = compilerModel.remote
        ? await compilerModel.query("compilerSidecarOperatorOperationAt", document.uri, {
            position,
            operatorCode
        }, token)
        : queryCompilerModel(compilerModel, "compilerSidecarOperatorOperationAt", {
            uri: document.uri, position, operatorCode
        }, () => {});
    if (!result?.complete || token?.isCancellationRequested) return null;
    if (result.operations.length === 1 && result.operations[0].targetSymbols.length === 1) {
        const entries = sidecarOperatorEntriesAtProcedures(model, result.operations[0].procedures);
        if (entries.length === 1) return { entry: entries[0], operation: result.operations[0], compilerModel };
        return null;
    }
    if (result.operations.length !== 0 || !operatorCode) return null;

    /* Some compiler-lowered intrinsics, such as LEN on a UDT, retain their
       physical selected target in the typed-expression sidecar rather than an
       O-operation record. Use that fact only when the exact source range is
       unique and maps to one source operator. */
    const expressions = compilerModel.remote
        ? await compilerModel.query("compilerSidecarOperatorExpressionAt", document.uri, {
            position,
            operatorCode
        }, token)
        : queryCompilerModel(compilerModel, "compilerSidecarOperatorExpressionAt", {
            uri: document.uri, position, operatorCode
        }, () => {});
    if (!expressions?.complete || token?.isCancellationRequested || expressions.expressions.length !== 1 ||
        expressions.expressions[0].targetSymbols.length !== 1) return null;
    const entries = sidecarOperatorEntriesAtProcedures(model, expressions.expressions[0].procedures);
    return entries.length === 1
        ? { entry: entries[0], operation: expressions.expressions[0], compilerModel }
        : null;
}

async function sidecarSelectedImplicitCallTargets(index, document, position, model, token) {
    const current = index.compilerAnalysis?.getModel(document.uri);
    const compilerModel = await compilerBindingModel(index, document, token, current);
    if (!compilerModel || token?.isCancellationRequested) return [];
    const result = compilerModel.remote
        ? await compilerModel.query("compilerSidecarImplicitCallsInSnapshot", document.uri, {}, token)
        : queryCompilerModel(compilerModel, "compilerSidecarImplicitCallsInSnapshot", { uri: document.uri }, () => {});
    if (!result?.complete || token?.isCancellationRequested) return [];
    const currentSource = model.getDocument(document.uri);
    if (!currentSource) return [];
    const matching = result.calls.filter((call) => {
        if (CompilerUri.file(call.filePath).toString() !== document.uri.toString()) return false;
        const afterStart = position.line > call.line ||
            position.line === call.line && position.character >= call.startColumn;
        const beforeEnd = position.line < call.endLine ||
            position.line === call.endLine && position.character < call.endColumn;
        return afterStart && beforeEnd;
    });
    if (!matching.length) return [];
    const callsByKind = new Map();
    for (const call of matching) {
        const calls = callsByKind.get(call.kind) || [];
        calls.push(call);
        callsByKind.set(call.kind, calls);
    }
    const targets = new Map();
    for (const [kind, calls] of callsByKind) {
        const targetSymbols = new Set(calls.flatMap((call) => call.targetSymbols));
        const targetSignatures = new Set(calls.flatMap((call) => call.targetSignatures));
        if (targetSymbols.size !== 1 || (kind === "explicit-constructor" ? targetSignatures.size !== 0 : targetSignatures.size !== 1)) continue;
        const procedures = new Map();
        for (const call of calls) for (const procedure of call.procedures || []) {
            procedures.set(`${procedure.filePath}:${procedure.startLine}:${procedure.endLine}`, procedure);
        }
        const entry = sidecarImplicitCallEntryAtProcedures(
            model, [...procedures.values()], currentSource, kind
        );
        if (entry) targets.set(`${kind}:${entry.id}`, { entry, compilerModel, kind });
    }
    return [...targets.values()];
}

async function sidecarSelectedImplicitCallTarget(index, document, position, model, token) {
    const targets = await sidecarSelectedImplicitCallTargets(index, document, position, model, token);
    return targets.length === 1 ? targets[0] : null;
}

async function sidecarSelectedConstructorCallTarget(index, document, position, model, token) {
    const targets = await sidecarSelectedImplicitCallTargets(index, document, position, model, token);
    const explicit = targets.filter((target) => target.kind === "explicit-constructor");
    const constructors = new Map((explicit.length ? explicit : targets)
        .filter((target) => IMPLICIT_CONSTRUCTOR_CALL_KINDS.has(target.kind))
        .map((target) => [target.entry.id, target]));
    return constructors.size === 1 ? constructors.values().next().value : null;
}

async function sidecarSelectedArgumentConstructorTarget(index, document, position, model, token) {
    const targets = await sidecarSelectedImplicitCallTargets(index, document, position, model, token);
    const constructors = targets.filter((target) => target.kind === "argument-constructor");
    return constructors.length === 1 ? constructors[0] : null;
}

async function sidecarBoundCallOverload(index, document, position, model, candidates, token, currentCompilerModel) {
    const compilerModel = await sidecarBindingModel(index, document, token, currentCompilerModel);
    if (!compilerModel || token?.isCancellationRequested) return null;
    const input = { position, name: candidates[0]?.name || candidates[0]?.declaration?.name || "" };
    const result = compilerModel.remote
        ? await compilerModel.query("compilerSidecarCallBindingAt", document.uri, input, token)
        : queryCompilerModel(compilerModel, "compilerSidecarCallBindingAt", { uri: document.uri, ...input }, () => {});
    if (!result?.complete || token?.isCancellationRequested || result.calls.length !== 1) return null;
    const key = sidecarCallTargetOverloadKey(model, result.calls[0]);
    if (!key) return null;
    const matches = candidates.filter((entry) => ["sub", "function", "property"].includes(entry.declaration.type) &&
        !entry.conditional && !entry.provisional && !entry.declaration.provisional && sidecarOverloadKey(entry) === key);
    if (!matches.length) return null;
    const implementation = matches.find((entry) => !entry.declaration.modifiers.includes("DECLARE"));
    return [implementation || matches[0]];
}

async function sidecarSelectedIndexOperator(index, document, position, model, candidates, token, currentCompilerModel = null) {
    const compilerModel = await sidecarBindingModel(index, document, token, currentCompilerModel);
    if (!compilerModel || token?.isCancellationRequested) return null;
    const result = compilerModel.remote
        ? await compilerModel.query("compilerSidecarOperatorExpressionAt", document.uri, {
            position,
            operatorCode: "index"
        }, token)
        : queryCompilerModel(compilerModel, "compilerSidecarOperatorExpressionAt", {
            uri: document.uri, position, operatorCode: "index"
        }, () => {});
    if (!result?.complete || token?.isCancellationRequested || result.expressions.length !== 1) return null;
    const key = sidecarOperatorTargetOverloadKey(model, result.expressions[0]);
    if (!key) return null;
    const matches = candidates.filter((entry) => isIndexOperatorEntry(entry) && !entry.conditional &&
        !entry.provisional && !entry.declaration.provisional && sourceIndexOperatorFamilyKey(entry) === key);
    if (!matches.length) return null;
    const declaration = matches.find((entry) => entry.declaration.modifiers.includes("DECLARE"));
    return [declaration || matches[0]];
}

async function sidecarIndexSelection(index, document, position, compilerModel, token) {
    if (!compilerModel.semanticSidecarOnly ||
        !findCallContext(document.getText(), document.offsetAt(position))?.indexing) return null;
    const model = index.getSourceSemanticModel?.() || index.getSemanticModel(document.uri, { sourceOnly: true });
    if (!model) return { model: null, entry: null };
    /* `Operator []` also looks like an unfinished index call at its closing
       bracket. Declarations have no expression receipt; let their physical
       declaration path handle the query instead. */
    if (sourceIndexOperatorDeclarationEntries(model, document, position).length) return null;
    const candidates = sourceIndexOperatorEntries(model, document, position);
    if (candidates === null) return null;
    /* The compact stock model has no bridge expression graph. Select the
       exact overload through its typed index receipt before mapping it back
       to physical source declarations. */
    const selected = await sidecarSelectedIndexOperator(index, document, position, model, candidates, token, compilerModel);
    return { model, entry: !token?.isCancellationRequested ? selected?.[0] || null : null };
}

async function sidecarIndexNavigationEntries(index, document, position, compilerModel, token, operation) {
    const selection = await sidecarIndexSelection(index, document, position, compilerModel, token);
    if (selection === null) return null;
    if (!selection.entry) return [];
    return operation === "declaration" ? sourceDeclarationTargets(selection.model, [selection.entry])
        : sourceIndexOperatorDefinitions(selection.model, [selection.entry], document);
}

function hasVisibleOverloadSiblings(model, document, target) {
    if (!target || !["sub", "function", "property", "operator"].includes(target.declaration.type) || target.conditional) return false;
    const source = model.getDocument(document.uri);
    if (!source) return false;
    if (isIndexOperatorEntry(target)) {
        const overloads = new Set(model.entries.filter((entry) => isIndexOperatorEntry(entry) &&
            !entry.conditional && source.visibleDocuments.has(entry.document.key))
            .map(sourceIndexOperatorFamilyKey).filter(Boolean));
        return overloads.size > 1;
    }
    const overloads = new Set(model.entries.filter((entry) =>
        entry.qualifiedName === target.qualifiedName &&
        ["sub", "function", "property", "operator"].includes(entry.declaration.type) &&
        !entry.conditional && source.visibleDocuments.has(entry.document.key)
    ).map(sidecarOverloadKey));
    return overloads.size > 1;
}

async function cachedSidecarSymbolUses(index, document, occurrences, token) {
    const compilerModel = index.compilerAnalysis?.getModel(document.uri);
    const filePath = document.uri.fsPath;
    if (!compilerModel?.remote || !compilerModel.semanticSidecarOnly ||
        !compilerModel.semanticBindingsAvailable || !filePath ||
        !occurrences.length || occurrences.length > MAX_STOCK_SIDECAR_ACCESS_ROLE_SITES) return new Map();
    const sites = occurrences.map((occurrence, index) => ({
        index,
        filePath,
        line: occurrence.line,
        startColumn: occurrence.startColumn,
        endColumn: occurrence.endColumn
    }));
    const roles = await compilerModel.query("compilerSidecarAccessRolesAtSites", document.uri, { sites }, token);
    if (token?.isCancellationRequested) return null;
    if (!Array.isArray(roles)) return new Map();
    const result = new Map();
    for (const role of roles) {
        if (Number.isSafeInteger(role?.index) && role.index >= 0 && role.index < occurrences.length &&
            (["read", "write", "read-write", "address", "byref", "callee"].includes(role.role) || role.readonly === true)) {
            result.set(role.index, role);
        }
    }
    return result;
}

function sourceCallableFamily(model, target) {
    /* Lifetime procedures and member-operator bodies have qualified spellings.
       Match their signatures first, then keep only declarations connected
       through include visibility. A workspace-wide signature is not identity. */
    const lifetimeFamily = ["constructor", "destructor"].includes(target.declaration.type)
        ? sourceLifetimeProcedureFamilyKey(target.declaration) : "";
    const operatorFamily = sourceOperatorFamilyKey(target);
    const candidates = model.entries.filter((entry) => {
        if (entry.declaration.type !== target.declaration.type) return false;
        if (lifetimeFamily) return sourceLifetimeProcedureFamilyKey(entry.declaration) === lifetimeFamily;
        if (operatorFamily) return sourceOperatorFamilyKey(entry) === operatorFamily;
        return entry.qualifiedName === target.qualifiedName && sidecarOverloadKey(entry) === sidecarOverloadKey(target);
    });
    const source = typeof model.declarationComponents === "function" ? model : model.inner;
    const components = typeof source?.declarationComponents === "function"
        ? source.declarationComponents(candidates) : [candidates];
    return components.find((component) => component.some((entry) => entry === target ||
        entry.id !== undefined && entry.id === target.id)) || [];
}

function sourceDeclarationTargets(model, targets) {
    const result = new Map();
    for (const target of targets) {
        if (!["sub", "function", "property", "constructor", "destructor", "operator"].includes(target.declaration.type)) {
            result.set(`${target.uri.toString()}:${target.offset}`, target);
            continue;
        }
        const family = sourceCallableFamily(model, target);
        const declarations = family.filter((entry) => entry.declaration.modifiers.includes("DECLARE"));
        for (const entry of declarations.length ? declarations : [target]) {
            result.set(`${entry.uri.toString()}:${entry.offset}`, entry);
        }
    }
    return [...result.values()];
}

async function sidecarSelectedOverload(index, document, position, model, candidates, token, currentCompilerModel = null) {
    const callable = candidates.filter((entry) => ["sub", "function", "property", "operator"].includes(entry.declaration.type));
    if (callable.length < 2 || token?.isCancellationRequested) return null;

    const compilerModel = currentCompilerModel?.semanticSidecarOnly
        ? currentCompilerModel
        : await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
    if (!compilerModel?.semanticSidecarOnly || token?.isCancellationRequested) return null;
    const expression = compilerModel.remote
        ? await compilerModel.expressionAt(document.uri, position, position, token)
        : compilerModel.expressionAtCompilerSidecarOnly?.(document.uri, position);
    if (expression && !expression.provisional && normalizeTypeName(expression.typeName) && !token?.isCancellationRequested) {
        const matches = callable.filter((entry) => ["function", "property"].includes(entry.declaration.type) &&
            sidecarReturnTypeMatches(model, entry, expression.typeName));
        if (matches.length === 1 && !matches[0].conditional) return matches;
    }
    const selectedCall = await sidecarBoundCallOverload(index, document, position, model, candidates, token, compilerModel);
    if (selectedCall) return selectedCall;
    return callable.some(isIndexOperatorEntry)
        ? sidecarSelectedIndexOperator(index, document, position, model, callable, token, compilerModel)
        : null;
}

/* ------------------------------------------------------------------------- */
/* Resolved editor providers                                                 */
/* ------------------------------------------------------------------------- */

function createSemanticFeatures(vscode, index, grammar) {
    const reserved = new Set([...grammar.keywords, ...grammar.types, ...grammar.operatorKeywords, ...grammar.constants].map(normalizeIdentifier));
    const legend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

    function modelFor(document, token, needCompilerExpressionTypes = false, needSemanticBindings = false,
        needSemanticMacroBindings = false) {
        return editorModel(index, document, token, needCompilerExpressionTypes,
            needSemanticBindings, needSemanticMacroBindings);
    }
    function range(occurrence) {
        return new vscode.Range(occurrence.line, occurrence.startColumn,
            occurrence.endLine ?? occurrence.line, occurrence.endColumn);
    }
    function accessHighlightKind(accessRole) {
        if (accessRole === "read") return vscode.DocumentHighlightKind?.Read ?? vscode.DocumentHighlightKind?.Text;
        if (accessRole === "write" || accessRole === "read-write") {
            return vscode.DocumentHighlightKind?.Write ?? vscode.DocumentHighlightKind?.Text;
        }
        return vscode.DocumentHighlightKind?.Text;
    }
    async function configuredProjectNavigation(document, position, operation, entries, token, fallbackEntries = entries) {
        const local = fallbackEntries.map(location);
        if (!entries.length || !index.compilerProject?.hasProjectContexts?.(document.uri)) return local;
        const callableTypes = new Set(["sub", "function", "property", "operator", "constructor", "destructor"]);
        const callables = entries.filter((entry) => callableTypes.has(entry.declaration?.type));
        const hasPrototype = callables.some((entry) => entry.declaration.modifiers?.includes("DECLARE"));
        const hasImplementation = callables.some((entry) => !entry.declaration.modifiers?.includes("DECLARE"));
        const needsProject = !entries.length || operation === "definition" && callables.length > 0 && !hasImplementation ||
            operation === "declaration" && callables.length > 0 && !hasPrototype ||
            operation === "implementation" && callables.length > 0 && !hasImplementation;
        if (!needsProject || token?.isCancellationRequested) return token?.isCancellationRequested ? null : local;
        try {
            const project = await index.compilerProject.navigation(document, position, operation, token);
            if (token?.isCancellationRequested) return null;
            if (Array.isArray(project) && project.length) return project;
        } catch (error) {
            if (token?.isCancellationRequested) return null;
            index.compilerAnalysis?.output?.appendLine?.(
                `Project ${operation} lookup fell back to this compiler snapshot: ${error.message}`
            );
        }
        return token?.isCancellationRequested ? null : local;
    }
    function location(entry) {
        const declaration = entry.declaration;
        return new vscode.Location(entry.uri, new vscode.Range(declaration.line, declaration.endColumn - entry.name.length, declaration.line, declaration.endColumn));
    }
    function sourceConstructorDeclarationEntriesAt(model, document, position) {
        const source = model.getDocument(document.uri);
        if (!source) return [];
        const constructorsOnLine = source.entries.filter((entry) => entry.declaration.type === "constructor" &&
            !entry.conditional && !entry.provisional && !entry.declaration.provisional &&
            entry.declaration.line === position.line);
        const declarations = constructorsOnLine.filter((entry) =>
            position.character >= entry.declaration.startColumn &&
            position.character <= entry.declaration.endColumn);
        if (declarations.length) return declarations;
        return constructorsOnLine.length === 1 ? constructorsOnLine : [];
    }
    function isTypeHierarchyEntry(entry) {
        return TYPE_HIERARCHY_TYPES.has(entry?.declaration?.type) && entry.declaration.detail !== "Type alias" &&
            !entry.conditional && !entry.provisional && !entry.declaration.provisional;
    }
    function typeHierarchyEntries(model, uri, position) {
        const result = new Map();
        for (const target of model.resolveAt(uri, position.line, position.character)) {
            const types = isTypeHierarchyEntry(target) ? [target] : model.typeEntries(target);
            for (const entry of types) if (isTypeHierarchyEntry(entry)) result.set(entry.id, entry);
        }
        return [...result.values()];
    }
    function typeHierarchyItem(entry) {
        const declaration = entry.declaration;
        const selected = new vscode.Range(declaration.line, declaration.startColumn, declaration.line, declaration.endColumn);
        const kind = declaration.type === "class" ? vscode.SymbolKind.Class : vscode.SymbolKind.Struct;
        return new vscode.TypeHierarchyItem(kind, entry.name || declaration.name,
            declaration.signature || declaration.detail || declaration.type, entry.uri, selected, selected);
    }
    function sourceTypeHierarchySupertypes(model, uri, position) {
        const result = new Map();
        for (const entry of typeHierarchyEntries(model, uri, position)) {
            if (!entry.declaration.baseType) continue;
            const parents = model.resolveName(entry.document, entry.declaration.baseType, entry.scope, entry.offset)
                .filter(isTypeHierarchyEntry);
            if (parents.length === 1) result.set(parents[0].id, parents[0]);
        }
        return [...result.values()];
    }
    function sourceTypeHierarchySubtypes(model, uri, position, token) {
        if (index.isIncomplete() || model.entries.length > MAX_SOURCE_TYPE_HIERARCHY_ENTRIES) return [];
        const targets = typeHierarchyEntries(model, uri, position);
        if (!targets.length) return [];
        const targetIds = new Set(targets.map((entry) => entry.id));
        const result = new Map();
        for (const candidate of model.entries) {
            if (token?.isCancellationRequested) return [];
            if (!isTypeHierarchyEntry(candidate) || !candidate.declaration.baseType) continue;
            const bases = model.resolveName(candidate.document, candidate.declaration.baseType, candidate.scope, candidate.offset)
                .filter(isTypeHierarchyEntry);
            if (bases.length === 1 && targetIds.has(bases[0].id)) result.set(candidate.id, candidate);
        }
        return [...result.values()];
    }
    function modelForTypeHierarchyItem(item) {
        const current = index.compilerAnalysis?.getModel(item.uri);
        if (current && (!current.semanticSidecarOnly || current.semanticBindingsAvailable === true)) return current;
        return index.getSemanticModel(item.uri, { allowSidecarOnly: false });
    }
    function modelForCallHierarchyItem(item) {
        const current = index.compilerAnalysis?.getModel(item.uri);
        if (current && !current.semanticSidecarOnly) return current;
        return index.getSemanticModel(item.uri, { allowSidecarOnly: false });
    }
    async function callHierarchySourceDocument(uri, token) {
        if (token?.isCancellationRequested) return null;
        let document = (vscode.workspace.textDocuments || []).find((current) => current.uri.toString() === uri.toString());
        if (!document && typeof vscode.workspace.openTextDocument === "function") {
            // Hierarchy items outlive visible editors. Loading a document does
            // not show or save it, but gives compiler queries current input.
            try {
                document = await vscode.workspace.openTextDocument(uri);
            } catch (error) {
                if (!token?.isCancellationRequested) index.compilerAnalysis?.output?.appendLine?.(
                    `Call Hierarchy source could not be loaded: ${error.message}`);
                return null;
            }
        }
        if (!document || token?.isCancellationRequested) return null;
        index.getParsedDocument?.(document);
        // A newly loaded lifetime replaces its old include links. Resolve
        // those links before taking the source-model snapshot for this item.
        await index.loadIncludes?.(token);
        return token?.isCancellationRequested ? null : document;
    }
    function isCallHierarchyEntry(entry) {
        return CALL_HIERARCHY_TYPES.has(entry?.declaration?.type) && !entry.conditional &&
            !entry.provisional && !entry.declaration.provisional;
    }
    function sourceCallHierarchyTargets(model, uri, position) {
        const document = model.getDocument(uri);
        const declaredOperators = document
            ? sourceOperatorDeclarationEntries(model, document, position).filter(isCallHierarchyEntry)
            : [];
        if (declaredOperators.length) return declaredOperators;
        const targets = model.resolveAt(uri, position.line, position.character).filter(isCallHierarchyEntry);
        if (targets.length === 1) return targets;
        const destructors = document
            ? document.entries.filter((entry) => ["constructor", "destructor"].includes(entry.declaration.type) &&
                !entry.conditional && !entry.provisional && !entry.declaration.provisional &&
                entry.declaration.line === position.line && position.character >= entry.declaration.startColumn &&
                position.character <= entry.declaration.endColumn).filter(isCallHierarchyEntry)
            : [];
        if (destructors.length === 1) return destructors;
        return targets;
    }
    function callHierarchyItem(entry) {
        const declaration = entry.declaration;
        if (declaration.type === "module") {
            let fullRange = new vscode.Range(0, 0, 0, 0);
            if (entry.document?.text) {
                const lines = entry.document.text.split(/\r\n|\n|\r/);
                const endLine = lines.length - 1;
                fullRange = new vscode.Range(0, 0, endLine, lines[endLine].length);
            } else if (Number.isSafeInteger(declaration.endLine)) {
                fullRange = new vscode.Range(0, 0, declaration.endLine, declaration.endColumn || 0);
            }
            const selection = new vscode.Range(0, 0, 0, 0);
            return new vscode.CallHierarchyItem(vscode.SymbolKind.File, entry.name,
                CALL_HIERARCHY_MODULE_DETAIL, entry.uri, fullRange, selection);
        }
        const name = entry.name || declaration.name.split(".").at(-1);
        let selectionStartColumn = Math.max(declaration.startColumn, declaration.endColumn - name.length);
        let selectionEndColumn = declaration.endColumn;
        if (["constructor", "destructor"].includes(declaration.type) && entry.document?.text) {
            // Source lifetime declarations can anchor their written type name.
            // Native lookup uses the callable keyword, not that type binding.
            const start = entry.document.lineOffsets?.[declaration.line];
            const end = entry.document.lineOffsets?.[declaration.line + 1] ?? entry.document.text.length;
            const keyword = Number.isSafeInteger(start)
                ? entry.document.text.slice(start, end).match(new RegExp(`\\b${declaration.type}\\b`, "i")) : null;
            if (keyword) {
                selectionStartColumn = keyword.index;
                selectionEndColumn = keyword.index + keyword[0].length;
            }
        }
        const selection = new vscode.Range(declaration.line, selectionStartColumn, declaration.line, selectionEndColumn);
        let fullRange = selection;
        if (entry.document?.text && Number.isSafeInteger(declaration.endLine)) {
            const lines = entry.document.text.split(/\r\n|\n|\r/);
            const endLine = Math.max(declaration.line, Math.min(declaration.endLine, lines.length - 1));
            fullRange = new vscode.Range(declaration.line, 0, endLine, lines[endLine]?.length || declaration.endColumn);
        }
        /* Qualified namespace procedures are functions, not UDT methods.
           Keep the old fallback only when resolved ownership is unavailable. */
        const method = entry.callableKind === "method" ||
            entry.callableKind !== "function" && entry.qualifiedName?.includes(".");
        const kind = declaration.type === "property" ? vscode.SymbolKind.Property
            : declaration.type === "constructor" ? vscode.SymbolKind.Constructor
                : declaration.type === "destructor" || declaration.type === "operator" || method
                    ? vscode.SymbolKind.Method
                    : vscode.SymbolKind.Function;
        const item = new vscode.CallHierarchyItem(kind, name,
            declaration.signature || declaration.detail || declaration.type, entry.uri, fullRange, selection);
        if (semanticEntryIsDeprecated(entry) && vscode.SymbolTag?.Deprecated !== undefined) {
            item.tags = [...new Set([...(item.tags || []), vscode.SymbolTag.Deprecated])];
        }
        return item;
    }
    function sourceCallToken(document, occurrence) {
        return Number.isSafeInteger(occurrence?.index)
            ? document.tokens[occurrence.index]
            : document.tokens.find((candidate) => candidate.offset === occurrence?.offset);
    }
    function sourceCallBodyEntries(model) {
        return new Map(model.entries.filter((entry) => isCallHierarchyEntry(entry) && entry.bodyScope &&
            entry.bodyScope.kind !== "prototype" && !entry.declaration.modifiers.includes("DECLARE")
        ).map((entry) => [entry.bodyScope, entry]));
    }
    function sidecarCallTargetEntry(model, call, source) {
        const key = sidecarCallTargetOverloadKey(model, call);
        if (!key) return null;
        const candidates = model.entries.filter((entry) => isCallHierarchyEntry(entry) && !entry.conditional &&
            !entry.provisional && !entry.declaration.provisional && source.visibleDocuments.has(entry.document.key) &&
            sidecarOverloadKey(entry) === key);
        const definitions = candidates.filter((entry) => entry.bodyScope && entry.bodyScope.kind !== "prototype" &&
            !entry.declaration.modifiers.includes("DECLARE"));
        if (definitions.length === 1) return definitions[0];
        if (definitions.length > 1) return null;
        return candidates.length === 1 ? candidates[0] : null;
    }
    function sidecarOperatorCallTargetEntry(model, operation, source) {
        if (operation?.targetSymbols?.length !== 1 || !source) return null;
        const entries = sidecarOperatorEntriesAtProcedures(model, operation.procedures);
        if (entries.length !== 1 || !source.visibleDocuments.has(entries[0].document.key)) return null;
        return entries[0];
    }
    function sidecarIndexCallTargetEntry(model, expression, source) {
        const key = sidecarOperatorTargetOverloadKey(model, expression);
        if (!key || !source) return null;
        const candidates = model.entries.filter((entry) => isIndexOperatorEntry(entry) &&
            !entry.conditional && !entry.provisional && !entry.declaration.provisional &&
            source.visibleDocuments.has(entry.document.key) && sourceIndexOperatorFamilyKey(entry) === key);
        const definitions = candidates.filter((entry) => entry.bodyScope && entry.bodyScope.kind !== "prototype" &&
            !entry.declaration.modifiers.includes("DECLARE"));
        if (definitions.length === 1) return definitions[0];
        if (definitions.length > 1) return null;
        return candidates.length === 1 ? candidates[0] : null;
    }
    function sidecarImplicitCallTargetEntry(model, call, source) {
        if (call?.targetSymbols?.length !== 1 ||
            (call.kind === "explicit-constructor" ? call.targetSignatures?.length !== 0 : call?.targetSignatures?.length !== 1) || !source) return null;
        return sidecarImplicitCallEntryAtProcedures(model, call.procedures, source, call.kind);
    }
    function sourceImplicitCallFamilyKey(entry) {
        return ["constructor", "destructor"].includes(entry.declaration.type)
            ? sourceLifetimeProcedureFamilyKey(entry.declaration) : "";
    }
    async function sourceSidecarCallBindings(document, model, token) {
        const current = index.compilerAnalysis?.getModel(document.uri);
        const compilerModel = await sidecarBindingModel(index, document, token, current);
        if (!compilerModel || token?.isCancellationRequested) return [];
        const result = compilerModel.remote
            ? await compilerModel.query("compilerSidecarCallBindingsInSnapshot", document.uri, {}, token)
            : queryCompilerModel(compilerModel, "compilerSidecarCallBindingsInSnapshot", { uri: document.uri }, () => {});
        return result?.complete && !token?.isCancellationRequested ? result.calls : [];
    }
    async function sourceSidecarOperatorOperations(document, token, target = null) {
        const current = index.compilerAnalysis?.getModel(document.uri);
        const compilerModel = await compilerBindingModel(index, document, token, current);
        if (!compilerModel || token?.isCancellationRequested) return [];
        const result = compilerModel.remote
            ? await compilerModel.query("compilerSidecarOperatorOperationsInSnapshot", document.uri, {}, token)
            : queryCompilerModel(compilerModel, "compilerSidecarOperatorOperationsInSnapshot", { uri: document.uri }, () => {});
        if (!result?.complete || token?.isCancellationRequested) return [];

        const operators = target ? [target] : (() => {
            const sourceModel = index.getSourceSemanticModel?.() ||
                index.getSemanticModel(document.uri, { sourceOnly: true });
            const source = sourceModel.getDocument(document.uri);
            if (!source) return [];
            return sourceModel.entries.filter((entry) => entry.declaration.type === "operator" &&
                !entry.conditional && !entry.provisional && !entry.declaration.provisional &&
                source.visibleDocuments.has(entry.document.key));
        })();
        const missingExpressionCodes = new Set(operators.map(sourceOperatorExpressionCode)
            .filter((code) => code && !result.operations.some((operation) => operation.operatorCode === code)));
        const expressions = [];
        for (const operatorCode of missingExpressionCodes) {
            if (token?.isCancellationRequested) return [];
            const facts = compilerModel.remote
                ? await compilerModel.query("compilerSidecarOperatorExpressionsInSnapshot", document.uri, {
                    operatorCode
                }, token)
                : queryCompilerModel(compilerModel, "compilerSidecarOperatorExpressionsInSnapshot", {
                    uri: document.uri, operatorCode
                }, () => {});
            if (!facts?.complete || token?.isCancellationRequested) continue;
            expressions.push(...facts.expressions.map((expression) => ({
                ...expression,
                operatorCode,
                operatorKind: "overloaded",
                physical: true
            })));
        }
        return [...result.operations, ...expressions];
    }
    async function sourceSidecarIndexExpressions(document, token) {
        const current = index.compilerAnalysis?.getModel(document.uri);
        const compilerModel = await sidecarBindingModel(index, document, token, current);
        if (!compilerModel || token?.isCancellationRequested) return [];
        const result = compilerModel.remote
            ? await compilerModel.query("compilerSidecarOperatorExpressionsInSnapshot", document.uri, { operatorCode: "index" }, token)
            : queryCompilerModel(compilerModel, "compilerSidecarOperatorExpressionsInSnapshot", {
                uri: document.uri, operatorCode: "index"
            }, () => {});
        return result?.complete && !token?.isCancellationRequested ? result.expressions : [];
    }
    async function sourceSidecarImplicitCalls(document, token) {
        const current = index.compilerAnalysis?.getModel(document.uri);
        const compilerModel = await compilerBindingModel(index, document, token, current);
        if (!compilerModel || token?.isCancellationRequested) return [];
        const result = compilerModel.remote
            ? await compilerModel.query("compilerSidecarImplicitCallsInSnapshot", document.uri, {}, token)
            : queryCompilerModel(compilerModel, "compilerSidecarImplicitCallsInSnapshot", { uri: document.uri }, () => {});
        return result?.complete && !token?.isCancellationRequested ? result.calls : [];
    }
    async function sourceSidecarImplicitConstructorReferences(document, model, target, token) {
        if (target?.declaration?.type !== "constructor") return [];
        const targetKey = sourceLifetimeProcedureFamilyKey(target.declaration);
        if (!targetKey) return [];
        const calls = await sourceSidecarImplicitCalls(document, token);
        if (token?.isCancellationRequested) return [];
        const references = new Map();
        for (const call of calls) {
            if (token?.isCancellationRequested) return [];
            if (!call.physical || !IMPLICIT_CONSTRUCTOR_CALL_KINDS.has(call.kind) || !call.filePath) continue;
            const source = model.getDocument(CompilerUri.file(call.filePath));
            if (!source) continue;
            const callee = sidecarImplicitCallTargetEntry(model, call, source);
            if (!callee || callee.declaration.type !== "constructor" ||
                sourceLifetimeProcedureFamilyKey(callee.declaration) !== targetKey) continue;
            const key = `${source.uri.toString()}:${call.line}:${call.startColumn}:${call.endLine}:${call.endColumn}`;
            if (!references.has(key)) references.set(key, new vscode.Location(source.uri,
                new vscode.Range(call.line, call.startColumn, call.endLine, call.endColumn)));
        }
        return [...references.values()];
    }
    function sourceBareSubCallOffsets(document) {
        const tokensByLine = new Map();
        for (const token of document.tokens) {
            const tokens = tokensByLine.get(token.line) || [];
            tokens.push(token);
            tokensByLine.set(token.line, tokens);
        }
        const offsets = new Set();
        for (const statement of document.parsed.statements || []) {
            if (statement.startLine !== statement.endLine) continue;
            const match = statement.maskedText.trim().match(/^(?:call\s+)?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)$/i);
            if (!match) continue;
            const targetKey = normalizeIdentifier(match[1]);
            const token = (tokensByLine.get(statement.startLine) || []).find((candidate) =>
                candidate.startColumn >= statement.startColumn && candidate.endColumn <= statement.endColumn &&
                candidate.key === targetKey
            );
            if (token) offsets.add(token.offset);
        }
        return offsets;
    }
    function isBareZeroArgumentSub(entry) {
        return entry?.declaration?.type === "sub" && !(entry.declaration.parameters || []).length;
    }
    function isBareZeroArgumentExpressionCallable(entry) {
        return ["function", "property"].includes(entry?.declaration?.type) &&
            !(entry.declaration.parameters || []).length;
    }
    function sourceBareFunctionCallOffsets(model, document) {
        const callableNames = new Set(model.entries.filter(isBareZeroArgumentExpressionCallable).map((entry) => entry.key));
        if (!callableNames.size) return new Set();
        const tokensByLine = new Map();
        for (const token of document.tokens) {
            const tokens = tokensByLine.get(token.line) || [];
            tokens.push(token);
            tokensByLine.set(token.line, tokens);
        }
        const identifier = "((?:[A-Za-z_][A-Za-z0-9_]*\\.)*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)";
        const patterns = [
            new RegExp(`^(?:return|print|write)\\s+${identifier}$`, "i"),
            new RegExp(`^(?:if|elseif|while|do\\s+while)\\s+${identifier}(?:\\s+then)?$`, "i"),
            new RegExp(`^(?:(?:dim|var|let)\\s+)?[A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\\s+as\\s+.+?)?\\s*=\\s*${identifier}$`, "i")
        ];
        const offsets = new Set();
        for (const statement of document.parsed.statements || []) {
            if (statement.startLine !== statement.endLine) continue;
            const code = statement.maskedText.trim();
            let expressionName = "";
            for (const pattern of patterns) {
                const match = code.match(pattern);
                if (match) {
                    expressionName = match[1];
                    break;
                }
            }
            if (!expressionName) continue;
            const key = normalizeIdentifier(expressionName.split(".").at(-1));
            if (!callableNames.has(key)) continue;
            const token = (tokensByLine.get(statement.startLine) || []).find((candidate) =>
                candidate.startColumn >= statement.startColumn && candidate.endColumn <= statement.endColumn &&
                candidate.key === key
            );
            if (token) offsets.add(token.offset);
        }
        return offsets;
    }
    function sourceModuleCallEntry(document) {
        const filePath = document.uri.fsPath || document.uri.path || document.uri.toString();
        const name = filePath.split(/[\\/]/).pop() || filePath;
        return {
            id: `module:${document.key}`,
            name,
            uri: document.uri,
            document,
            declaration: {
                name,
                type: "module",
                detail: CALL_HIERARCHY_MODULE_DETAIL,
                signature: "",
                line: 0,
                startColumn: 0,
                endColumn: 0,
                modifiers: []
            }
        };
    }
    function isModuleCallSite(document, offset, bodyEntries) {
        for (let scope = scopeAt(document, offset); scope; scope = scope.parent) {
            if (bodyEntries.has(scope) || NON_MODULE_CALL_SCOPES.has(scope.kind)) return false;
        }
        return true;
    }
    function sourceCallerAt(model, document, offset, bodyEntries) {
        for (let scope = scopeAt(document, offset); scope; scope = scope.parent) {
            const entry = bodyEntries.get(scope);
            if (entry) return entry;
        }
        return null;
    }
    function sourceIncomingCalls(model, target, token, sidecarCalls = [], sidecarOperations = [], sidecarIndexExpressions = [], sidecarImplicitCalls = []) {
        const bodyEntries = sourceCallBodyEntries(model);
        const bareCallsByDocument = new Map();
        const bareFunctionCallsByDocument = new Map();
        const incoming = new Map();
        for (const reference of model.references(target, false, token)) {
            if (token?.isCancellationRequested) return [];
            const document = model.getDocument(reference.uri);
            const callToken = document && sourceCallToken(document, reference.occurrence);
            if (!document || !callToken) continue;
            const explicitCall = document.tokens[callToken.index + 1]?.name === "(";
            if (!explicitCall) {
                let bareCall = false;
                if (isBareZeroArgumentSub(target)) {
                    let bareCalls = bareCallsByDocument.get(document);
                    if (!bareCalls) {
                        bareCalls = sourceBareSubCallOffsets(document);
                        bareCallsByDocument.set(document, bareCalls);
                    }
                    bareCall = bareCalls.has(callToken.offset);
                } else if (isBareZeroArgumentExpressionCallable(target) && document.tokens[callToken.index - 1]?.name !== "@") {
                    let bareCalls = bareFunctionCallsByDocument.get(document);
                    if (!bareCalls) {
                        bareCalls = sourceBareFunctionCallOffsets(model, document);
                        bareFunctionCallsByDocument.set(document, bareCalls);
                    }
                    bareCall = bareCalls.has(callToken.offset);
                }
                if (!bareCall) continue;
            }
            if (target.document && !document.visibleDocuments.has(target.document.key)) continue;
            const caller = sourceCallerAt(model, document, callToken.offset, bodyEntries) ||
                (isModuleCallSite(document, callToken.offset, bodyEntries) ? sourceModuleCallEntry(document) : null);
            if (!caller) continue;
            const group = incoming.get(caller.id) || { entry: caller, ranges: new Map() };
            const occurrence = reference.occurrence;
            group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`, occurrence);
            incoming.set(caller.id, group);
        }
        const targetKey = sidecarOverloadKey(target);
        for (const call of sidecarCalls) {
            if (token?.isCancellationRequested) return [];
            const document = model.getDocument(CompilerUri.file(call.filePath));
            if (!document) continue;
            const callToken = document.tokens.find((candidate) => candidate.line === call.line &&
                candidate.startColumn === call.startColumn && candidate.endColumn === call.endColumn &&
                candidate.kind === "identifier");
            if (!callToken) continue;
            const callee = sidecarCallTargetEntry(model, call, document);
            if (!callee || sidecarOverloadKey(callee) !== targetKey) continue;
            const caller = sourceCallerAt(model, document, callToken.offset, bodyEntries) ||
                (isModuleCallSite(document, callToken.offset, bodyEntries) ? sourceModuleCallEntry(document) : null);
            if (!caller) continue;
            const group = incoming.get(caller.id) || { entry: caller, ranges: new Map() };
            group.ranges.set(`${callToken.line}:${callToken.startColumn}:${callToken.endColumn}`, callToken);
            incoming.set(caller.id, group);
        }
        if (isIndexOperatorEntry(target)) {
            const targetKey = sourceIndexOperatorFamilyKey(target);
            if (targetKey) for (const expression of sidecarIndexExpressions) {
                if (token?.isCancellationRequested) return [];
                const document = model.getDocument(CompilerUri.file(expression.filePath));
                if (!document) continue;
                const callee = sidecarIndexCallTargetEntry(model, expression, document);
                if (!callee || sourceIndexOperatorFamilyKey(callee) !== targetKey) continue;
                const offset = positionOffset(document, expression.line, expression.startColumn);
                const caller = sourceCallerAt(model, document, offset, bodyEntries) ||
                    (isModuleCallSite(document, offset, bodyEntries) ? sourceModuleCallEntry(document) : null);
                if (!caller) continue;
                const occurrence = {
                    line: expression.line,
                    startColumn: expression.startColumn,
                    endLine: expression.endLine,
                    endColumn: expression.endColumn
                };
                const group = incoming.get(caller.id) || { entry: caller, ranges: new Map() };
                group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
                incoming.set(caller.id, group);
            }
        } else if (target.declaration.type === "operator") {
            const targetKey = sourceOperatorFamilyKey(target);
            if (targetKey) for (const operation of sidecarOperations) {
                if (token?.isCancellationRequested) return [];
                const document = model.getDocument(CompilerUri.file(operation.filePath));
                if (!document) continue;
                const callee = sidecarOperatorCallTargetEntry(model, operation, document);
                if (!callee || sourceOperatorFamilyKey(callee) !== targetKey) continue;
                const offset = positionOffset(document, operation.line, operation.startColumn);
                const caller = sourceCallerAt(model, document, offset, bodyEntries) ||
                    (isModuleCallSite(document, offset, bodyEntries) ? sourceModuleCallEntry(document) : null);
                if (!caller) continue;
                const occurrence = {
                    line: operation.line,
                    startColumn: operation.startColumn,
                    endLine: operation.endLine,
                    endColumn: operation.endColumn
                };
                const group = incoming.get(caller.id) || { entry: caller, ranges: new Map() };
                group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
                incoming.set(caller.id, group);
            }
        } else if (["constructor", "destructor"].includes(target.declaration.type)) {
            const targetKey = sourceImplicitCallFamilyKey(target);
            if (targetKey) for (const call of sidecarImplicitCalls) {
                if (token?.isCancellationRequested) return [];
                const document = model.getDocument(CompilerUri.file(call.filePath));
                if (!document) continue;
                const callee = sidecarImplicitCallTargetEntry(model, call, document);
                if (!callee || callee.declaration.type !== target.declaration.type ||
                    sourceImplicitCallFamilyKey(callee) !== targetKey) continue;
                const offset = positionOffset(document, call.line, call.startColumn);
                const caller = sourceCallerAt(model, document, offset, bodyEntries) ||
                    (isModuleCallSite(document, offset, bodyEntries) ? sourceModuleCallEntry(document) : null);
                if (!caller) continue;
                const occurrence = {
                    line: call.line,
                    startColumn: call.startColumn,
                    endLine: call.endLine,
                    endColumn: call.endColumn
                };
                const group = incoming.get(caller.id) || { entry: caller, ranges: new Map() };
                group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
                incoming.set(caller.id, group);
            }
        }
        return [...incoming.values()].map((group) => new vscode.CallHierarchyIncomingCall(
            callHierarchyItem(group.entry), [...group.ranges.values()].map(range)
        ));
    }
    function sourceOutgoingCalls(model, target, token, sidecarCalls = [], sidecarOperations = [], sidecarIndexExpressions = [], sidecarImplicitCalls = []) {
        if (["operator", "constructor", "destructor"].includes(target.declaration.type) && target.declaration.modifiers.includes("DECLARE")) {
            /* Member prototypes and qualified bodies have different source IDs.
               Inspect the one connected body before attributing outgoing calls. */
            const implementations = implementationEntries(model, target)
                .filter((entry) => isCallHierarchyEntry(entry) && entry.bodyScope && entry.bodyScope.kind !== "prototype");
            if (implementations.length !== 1) return [];
            target = implementations[0];
        }
        const family = model.entries.filter((entry) => entry.id === target.id && isCallHierarchyEntry(entry));
        const bodies = family.filter((entry) => entry.bodyScope && entry.bodyScope.kind !== "prototype" &&
            !entry.declaration.modifiers.includes("DECLARE"));
        if (!bodies.length) return [];
        const bodyEntries = sourceCallBodyEntries(model);
        const outgoing = new Map();
        for (const body of bodies) {
            const document = body.document;
            const bareSubCalls = sourceBareSubCallOffsets(document);
            const bareFunctionCalls = sourceBareFunctionCallOffsets(model, document);
            for (const callToken of document.tokens) {
                if (token?.isCancellationRequested) return [];
                const explicitCall = document.tokens[callToken.index + 1]?.name === "(";
                if (callToken.offset < body.bodyScope.start || callToken.offset >= body.bodyScope.end ||
                    document.entriesByOffset.has(callToken.offset) || callToken.kind !== "identifier" ||
                    !explicitCall && !bareSubCalls.has(callToken.offset) && !bareFunctionCalls.has(callToken.offset)) continue;
                const caller = sourceCallerAt(model, document, callToken.offset, bodyEntries);
                if (!caller || caller.id !== target.id) continue;
                const callees = model.resolveToken(document, callToken).filter(isCallHierarchyEntry);
                if (callees.length !== 1) continue;
                if (!explicitCall && !isBareZeroArgumentSub(callees[0]) &&
                    !isBareZeroArgumentExpressionCallable(callees[0])) continue;
                const callee = model.declarationTargets([callees[0]]).find((entry) =>
                    !entry.declaration.modifiers.includes("DECLARE")
                ) || callees[0];
                const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
                const occurrence = callToken;
                group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`, occurrence);
                outgoing.set(callee.id, group);
            }
        }
        for (const call of sidecarCalls) {
            if (token?.isCancellationRequested) return [];
            const document = model.getDocument(CompilerUri.file(call.filePath));
            if (!document) continue;
            const callToken = document.tokens.find((candidate) => candidate.line === call.line &&
                candidate.startColumn === call.startColumn && candidate.endColumn === call.endColumn &&
                candidate.kind === "identifier");
            if (!callToken) continue;
            const caller = sourceCallerAt(model, document, callToken.offset, bodyEntries);
            if (!caller || caller.id !== target.id) continue;
            const callee = sidecarCallTargetEntry(model, call, document);
            if (!callee) continue;
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${callToken.line}:${callToken.startColumn}:${callToken.endColumn}`, callToken);
            outgoing.set(callee.id, group);
        }
        for (const operation of sidecarOperations) {
            if (token?.isCancellationRequested) return [];
            const document = model.getDocument(CompilerUri.file(operation.filePath));
            if (!document) continue;
            const offset = positionOffset(document, operation.line, operation.startColumn);
            const caller = sourceCallerAt(model, document, offset, bodyEntries);
            if (!caller || caller.id !== target.id) continue;
            const callee = sidecarOperatorCallTargetEntry(model, operation, document);
            if (!callee) continue;
            const occurrence = {
                line: operation.line,
                startColumn: operation.startColumn,
                endLine: operation.endLine,
                endColumn: operation.endColumn
            };
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
            outgoing.set(callee.id, group);
        }
        for (const expression of sidecarIndexExpressions) {
            if (token?.isCancellationRequested) return [];
            const document = model.getDocument(CompilerUri.file(expression.filePath));
            if (!document) continue;
            const offset = positionOffset(document, expression.line, expression.startColumn);
            const caller = sourceCallerAt(model, document, offset, bodyEntries);
            if (!caller || caller.id !== target.id) continue;
            const callee = sidecarIndexCallTargetEntry(model, expression, document);
            if (!callee) continue;
            const occurrence = {
                line: expression.line,
                startColumn: expression.startColumn,
                endLine: expression.endLine,
                endColumn: expression.endColumn
            };
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
            outgoing.set(callee.id, group);
        }
        for (const call of sidecarImplicitCalls) {
            if (token?.isCancellationRequested) return [];
            const document = model.getDocument(CompilerUri.file(call.filePath));
            if (!document) continue;
            const offset = positionOffset(document, call.line, call.startColumn);
            const caller = sourceCallerAt(model, document, offset, bodyEntries);
            if (!caller || caller.id !== target.id) continue;
            const callee = sidecarImplicitCallTargetEntry(model, call, document);
            if (!callee) continue;
            const occurrence = {
                line: call.line,
                startColumn: call.startColumn,
                endLine: call.endLine,
                endColumn: call.endColumn
            };
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
            outgoing.set(callee.id, group);
        }
        return [...outgoing.values()].map((group) => new vscode.CallHierarchyOutgoingCall(
            callHierarchyItem(group.entry), [...group.ranges.values()].map(range)
        ));
    }
    function sourceModuleOutgoingCalls(model, uri, token, sidecarCalls = [], sidecarOperations = [], sidecarIndexExpressions = [], sidecarImplicitCalls = []) {
        const document = model.getDocument(uri);
        if (!document) return [];
        const bodyEntries = sourceCallBodyEntries(model);
        const bareSubCalls = sourceBareSubCallOffsets(document);
        const bareFunctionCalls = sourceBareFunctionCallOffsets(model, document);
        const outgoing = new Map();
        for (const callToken of document.tokens) {
            if (token?.isCancellationRequested) return [];
            const explicitCall = document.tokens[callToken.index + 1]?.name === "(";
            if (document.entriesByOffset.has(callToken.offset) || callToken.kind !== "identifier" ||
                !explicitCall && !bareSubCalls.has(callToken.offset) && !bareFunctionCalls.has(callToken.offset) ||
                !isModuleCallSite(document, callToken.offset, bodyEntries)) continue;
            const callees = model.resolveToken(document, callToken).filter(isCallHierarchyEntry);
            if (callees.length !== 1) continue;
            if (!explicitCall && !isBareZeroArgumentSub(callees[0]) &&
                !isBareZeroArgumentExpressionCallable(callees[0])) continue;
            const callee = model.declarationTargets([callees[0]]).find((entry) =>
                !entry.declaration.modifiers.includes("DECLARE")
            ) || callees[0];
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${callToken.line}:${callToken.startColumn}:${callToken.endColumn}`, callToken);
            outgoing.set(callee.id, group);
        }
        for (const call of sidecarCalls) {
            if (token?.isCancellationRequested) return [];
            const callSource = model.getDocument(CompilerUri.file(call.filePath));
            if (!callSource || callSource.uri.toString() !== uri.toString()) continue;
            const callToken = callSource.tokens.find((candidate) => candidate.line === call.line &&
                candidate.startColumn === call.startColumn && candidate.endColumn === call.endColumn &&
                candidate.kind === "identifier");
            if (!callToken || !isModuleCallSite(callSource, callToken.offset, bodyEntries)) continue;
            const callee = sidecarCallTargetEntry(model, call, callSource);
            if (!callee) continue;
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${callToken.line}:${callToken.startColumn}:${callToken.endColumn}`, callToken);
            outgoing.set(callee.id, group);
        }
        for (const operation of sidecarOperations) {
            if (token?.isCancellationRequested) return [];
            const callSource = model.getDocument(CompilerUri.file(operation.filePath));
            if (!callSource || callSource.uri.toString() !== uri.toString()) continue;
            const offset = positionOffset(callSource, operation.line, operation.startColumn);
            if (!isModuleCallSite(callSource, offset, bodyEntries)) continue;
            const callee = sidecarOperatorCallTargetEntry(model, operation, callSource);
            if (!callee) continue;
            const occurrence = {
                line: operation.line,
                startColumn: operation.startColumn,
                endLine: operation.endLine,
                endColumn: operation.endColumn
            };
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
            outgoing.set(callee.id, group);
        }
        for (const expression of sidecarIndexExpressions) {
            if (token?.isCancellationRequested) return [];
            const callSource = model.getDocument(CompilerUri.file(expression.filePath));
            if (!callSource || callSource.uri.toString() !== uri.toString()) continue;
            const offset = positionOffset(callSource, expression.line, expression.startColumn);
            if (!isModuleCallSite(callSource, offset, bodyEntries)) continue;
            const callee = sidecarIndexCallTargetEntry(model, expression, callSource);
            if (!callee) continue;
            const occurrence = {
                line: expression.line,
                startColumn: expression.startColumn,
                endLine: expression.endLine,
                endColumn: expression.endColumn
            };
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
            outgoing.set(callee.id, group);
        }
        for (const call of sidecarImplicitCalls) {
            if (token?.isCancellationRequested) return [];
            const callSource = model.getDocument(CompilerUri.file(call.filePath));
            if (!callSource || callSource.uri.toString() !== uri.toString()) continue;
            const offset = positionOffset(callSource, call.line, call.startColumn);
            if (!isModuleCallSite(callSource, offset, bodyEntries)) continue;
            const callee = sidecarImplicitCallTargetEntry(model, call, callSource);
            if (!callee) continue;
            const occurrence = {
                line: call.line,
                startColumn: call.startColumn,
                endLine: call.endLine,
                endColumn: call.endColumn
            };
            const group = outgoing.get(callee.id) || { entry: callee, ranges: new Map() };
            group.ranges.set(`${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`, occurrence);
            outgoing.set(callee.id, group);
        }
        return [...outgoing.values()].map((group) => new vscode.CallHierarchyOutgoingCall(
            callHierarchyItem(group.entry), [...group.ranges.values()].map(range)
        ));
    }
    function isModuleCallHierarchyItem(item) {
        return item.kind === vscode.SymbolKind.File && item.detail === CALL_HIERARCHY_MODULE_DETAIL;
    }
    async function sidecarTypeDefinition(document, typeName, token) {
        if (!normalizeIdentifier(typeName) || !document.uri.fsPath) return [];
        index.getParsedDocument(document);
        if (!await index.ensureInitialized(token) || token?.isCancellationRequested) return [];

        const model = index.getSemanticModel(document.uri, { allowSidecarOnly: false });
        const entry = model.findUniqueVisibleType(document.uri, typeName);
        if (!entry) return [];
        const declaration = entry.declaration;
        return [new vscode.Location(entry.uri, new vscode.Range(
            declaration.line, declaration.startColumn, declaration.line, declaration.endColumn
        ))];
    }
    async function sidecarResolvedSymbolTypeDefinition(document, position, token) {
        if (!document.uri.fsPath) return null;
        index.getParsedDocument(document);
        if (!await index.ensureInitialized(token) || token?.isCancellationRequested) return [];

        const model = index.getSemanticModel(document.uri, { allowSidecarOnly: false });
        const targets = model.resolveAt(document.uri, position.line, position.character);
        if (targets.length !== 1) return null;
        const target = targets[0];
        if (target.conditional || !["variable", "parameter", "field", "const", "enumMember", "type", "class", "union", "enum"].includes(target.declaration.type)) {
            return null;
        }

        const types = model.typeEntries(target);
        return types.length === 1 ? [location(types[0])] : null;
    }
    function targetAt(model, document, position) {
        if (index.compilerAnalysis?.isConfigured(document.uri)) throw new Error("Automatic rename is disabled while a compiler bridge is configured; complete macro provenance and cross-configuration references are not available yet.");
        if (index.isIncomplete()) throw new Error("Rename is unavailable because the workspace index is incomplete. Check freebasic.index limits and unreadable files, then rebuild the index.");
        const targets = model.resolveAt(document.uri, position.line, position.character);
        if (targets.length !== 1) throw new Error("Rename requires one resolved FreeBASIC declaration.");
        const problem = model.renameProblem(targets[0]);
        if (problem) throw new Error(problem);
        return targets[0];
    }
    function implementationEntries(model, target) {
        const callableTypes = ["sub", "function", "property", "constructor", "destructor", "operator"];
        return sourceCallableFamily(model, target).filter((entry) =>
            callableTypes.includes(entry.declaration.type) &&
            !entry.declaration.modifiers.includes("DECLARE") &&
            !entry.conditional
        );
    }
    async function sidecarOverloadReferences(document, model, target, compilerModel, token, includeDeclaration, allSources) {
        const source = model.getDocument(document.uri);
        if (!source || !(compilerModel?.semanticSidecarOnly || compilerModel?.semanticBindingsAvailable === true)) return [];

        const references = new Map();
        const add = (uri, occurrence) => {
            const key = `${uri.toString()}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endColumn}`;
            if (!references.has(key)) references.set(key, { uri, occurrence });
        };
        for (const entry of model.references(target, includeDeclaration, token)) {
            if (!allSources && entry.uri.toString() !== document.uri.toString()) continue;
            add(entry.uri, entry.occurrence);
        }

        if (isIndexOperatorEntry(target)) {
            const bindingModel = await sidecarBindingModel(index, document, token, compilerModel);
            const expressions = bindingModel
                ? bindingModel.remote
                    ? await bindingModel.query(
                        allSources ? "compilerSidecarOperatorExpressionsInSnapshot" : "compilerSidecarOperatorExpressions",
                        document.uri, { operatorCode: "index" }, token
                    )
                    : queryCompilerModel(bindingModel,
                        allSources ? "compilerSidecarOperatorExpressionsInSnapshot" : "compilerSidecarOperatorExpressions",
                        { uri: document.uri, operatorCode: "index" }, () => {})
                : null;
            if (!expressions?.complete || token?.isCancellationRequested) return [...references.values()];

            const targetKey = sourceIndexOperatorFamilyKey(target);
            for (const expression of expressions.expressions) {
                if (token?.isCancellationRequested) return null;
                const expressionKey = sidecarOperatorTargetOverloadKey(model, expression);
                if (!expressionKey) continue;
                const expressionUri = vscode.Uri.file(expression.filePath);
                const occurrence = {
                    line: expression.line,
                    startColumn: expression.startColumn,
                    endLine: expression.endLine,
                    endColumn: expression.endColumn
                };
                const key = `${expressionUri.toString()}:${occurrence.line}:${occurrence.startColumn}:${occurrence.endLine}:${occurrence.endColumn}`;
                references.delete(key);
                if (expressionKey === targetKey) add(expressionUri, occurrence);
            }
            if (includeDeclaration) {
                for (const declaration of sourceDeclarationTargets(model, [target])) {
                    add(declaration.uri, {
                        line: declaration.declaration.line,
                        startColumn: declaration.declaration.startColumn,
                        endColumn: declaration.declaration.endColumn
                    });
                }
            }
            return [...references.values()];
        }

        if (target.declaration.type === "operator") {
            const bindingModel = await compilerBindingModel(index, document, token, compilerModel);
            const operations = bindingModel
                ? bindingModel.remote
                    ? await bindingModel.query("compilerSidecarOperatorOperationsInSnapshot", document.uri, {}, token)
                    : queryCompilerModel(bindingModel, "compilerSidecarOperatorOperationsInSnapshot", { uri: document.uri }, () => {})
                : null;
            if (!operations?.complete || token?.isCancellationRequested) return [...references.values()];

            const targetFamily = sourceOperatorFamilyKey(target);
            if (!targetFamily) return [...references.values()];
            const symbols = new Set();
            for (const operation of operations.operations) {
                if (token?.isCancellationRequested) return null;
                for (const entry of sidecarOperatorEntriesAtProcedures(model, operation.procedures)) {
                    if (sourceOperatorFamilyKey(entry) === targetFamily) {
                        for (const symbol of operation.targetSymbols) symbols.add(symbol);
                    }
                }
            }
            if (symbols.size === 0) {
                const operatorCode = sourceOperatorExpressionCode(target);
                if (!operatorCode) return [...references.values()];
                const expressions = bindingModel.remote
                    ? await bindingModel.query(
                        allSources ? "compilerSidecarOperatorExpressionsInSnapshot" : "compilerSidecarOperatorExpressions",
                        document.uri, { operatorCode }, token
                    )
                    : queryCompilerModel(bindingModel,
                        allSources ? "compilerSidecarOperatorExpressionsInSnapshot" : "compilerSidecarOperatorExpressions",
                        { uri: document.uri, operatorCode }, () => {});
                if (!expressions?.complete || token?.isCancellationRequested) return [...references.values()];
                for (const expression of expressions.expressions) {
                    if (token?.isCancellationRequested) return null;
                    if (expression.targetSymbols.length !== 1) continue;
                    const entries = sidecarOperatorEntriesAtProcedures(model, expression.procedures);
                    if (entries.length !== 1 || sourceOperatorFamilyKey(entries[0]) !== targetFamily) continue;
                    add(vscode.Uri.file(expression.filePath), {
                        line: expression.line,
                        startColumn: expression.startColumn,
                        endLine: expression.endLine,
                        endColumn: expression.endColumn
                    });
                }
                if (includeDeclaration) {
                    for (const declaration of sourceOperatorDeclarationTargets(model, target)) {
                        add(declaration.uri, {
                            line: declaration.declaration.line,
                            startColumn: declaration.declaration.startColumn,
                            endColumn: declaration.declaration.endColumn
                        });
                    }
                }
                return [...references.values()];
            }
            if (symbols.size !== 1) return [...references.values()];
            const [selectedSymbol] = symbols;
            for (const operation of operations.operations) {
                if (token?.isCancellationRequested) return null;
                if (operation.targetSymbols.length !== 1 || operation.targetSymbols[0] !== selectedSymbol) continue;
                const operationUri = vscode.Uri.file(operation.filePath);
                add(operationUri, {
                    line: operation.line,
                    startColumn: operation.startColumn,
                    endLine: operation.endLine,
                    endColumn: operation.endColumn
                });
            }
            if (includeDeclaration) {
                for (const declaration of sourceOperatorDeclarationTargets(model, target)) {
                    add(declaration.uri, {
                        line: declaration.declaration.line,
                        startColumn: declaration.declaration.startColumn,
                        endColumn: declaration.declaration.endColumn
                    });
                }
            }
            return [...references.values()];
        }

        const calls = compilerModel.remote
            ? await compilerModel.query(
                allSources ? "compilerSidecarCallResultsInSnapshot" : "compilerSidecarCallResults",
                document.uri, { name: target.name }, token
            )
            : allSources
                ? compilerModel.compilerSidecarCallResultsInSnapshot(target.name)
                : compilerModel.compilerSidecarCallResults(document.uri, target.name);
        if (!calls?.complete || token?.isCancellationRequested) return [...references.values()];

        const bindingModel = await sidecarBindingModel(index, document, token, compilerModel);
        const boundCalls = bindingModel
            ? bindingModel.remote
                ? await bindingModel.query(
                    allSources ? "compilerSidecarCallBindingsInSnapshot" : "compilerSidecarCallBindings",
                    document.uri, { name: target.name }, token
                )
                : queryCompilerModel(bindingModel,
                    allSources ? "compilerSidecarCallBindingsInSnapshot" : "compilerSidecarCallBindings",
                    { uri: document.uri, name: target.name }, () => {})
            : null;
        const handledBoundSites = new Set();
        const overloadKeysBySidecarSymbol = new Map();
        const targetKey = sidecarOverloadKey(target);
        if (boundCalls?.complete && !token?.isCancellationRequested) {
            for (const call of boundCalls.calls) {
                if (token?.isCancellationRequested) return null;
                const callUri = call.filePath ? vscode.Uri.file(call.filePath) : document.uri;
                const callSource = model.getDocument(callUri);
                if (!callSource) continue;
                const candidates = model.resolveAt(callUri, call.line, call.startColumn);
                if (!candidates.some((entry) => entry.qualifiedName === target.qualifiedName)) continue;
                const callKey = `${callUri.toString()}:${call.line}:${call.startColumn}:${call.endColumn}`;
                const sidecarSymbolKey = call.targetSymbols.join(",");
                if (!overloadKeysBySidecarSymbol.has(sidecarSymbolKey)) {
                    overloadKeysBySidecarSymbol.set(sidecarSymbolKey, sidecarCallTargetOverloadKey(model, call));
                }
                const selectedKey = overloadKeysBySidecarSymbol.get(sidecarSymbolKey);
                if (!selectedKey) continue;
                handledBoundSites.add(callKey);
                references.delete(callKey);
                if (selectedKey === targetKey) add(callUri, {
                    line: call.line,
                    startColumn: call.startColumn,
                    endColumn: call.endColumn
                });
            }
        }

        for (const call of calls.calls) {
            if (token?.isCancellationRequested) return null;
            const callUri = call.filePath ? vscode.Uri.file(call.filePath) : document.uri;
            const callSource = model.getDocument(callUri);
            if (!callSource) continue;
            const callKey = `${callUri.toString()}:${call.line}:${call.startColumn}:${call.endColumn}`;
            if (handledBoundSites.has(callKey)) continue;
            const candidates = model.resolveAt(callUri, call.line, call.startColumn);
            if (!candidates.some((entry) => entry.qualifiedName === target.qualifiedName)) continue;

            const family = model.entries.filter((entry) =>
                entry.qualifiedName === target.qualifiedName &&
                ["function", "property"].includes(entry.declaration.type) &&
                callSource.visibleDocuments.has(entry.document.key)
            );
            const matches = family.filter((entry) => sidecarReturnTypeMatches(model, entry, call.typeName));
            const overloadKeys = new Set(matches.map(sidecarOverloadKey));
            if (overloadKeys.size !== 1 || matches.some((entry) => entry.conditional)) continue;
            references.delete(`${callUri.toString()}:${call.line}:${call.startColumn}:${call.endColumn}`);
            if (!overloadKeys.has(targetKey)) continue;
            add(callUri, {
                line: call.line,
                startColumn: call.startColumn,
                endColumn: call.endColumn
            });
        }
        return [...references.values()];
    }

    async function sidecarOverloadHighlights(document, model, target, compilerModel, token) {
        const references = await sidecarOverloadReferences(document, model, target, compilerModel, token, true, false);
        return references?.filter((entry) => entry.uri.toString() === document.uri.toString())
            .map((entry) => new vscode.DocumentHighlight(range(entry.occurrence), vscode.DocumentHighlightKind.Text)) || [];
    }

    async function compilerCallCodeLenses(document, token) {
        const model = index.compilerAnalysis?.getModel?.(document.uri);
        if (!model || token?.isCancellationRequested) return [];
        if (model.semanticSidecarOnly && model.semanticBindingsAvailable !== true) return [];

        const checkCancelled = () => {
            if (token?.isCancellationRequested) throw new Error("Compiler reference CodeLens query cancelled.");
        };
        let result;
        try {
            result = model.remote
                ? await model.query("compilerProcedureReferenceCodeLenses", document.uri, {}, token)
                : queryCompilerModel(model, "compilerProcedureReferenceCodeLenses", { uri: document.uri }, checkCancelled);
        } catch (error) {
            if (token?.isCancellationRequested) return null;
            throw error;
        }
        if (token?.isCancellationRequested) return null;
        if (!result?.complete || !Array.isArray(result.entries) || result.entries.length > MAX_COMPILER_REFERENCE_CODE_LENSES) return [];

        return result.entries
            .filter((entry) => Array.isArray(entry.references) && entry.references.length)
            .map((entry) => {
                const declaration = entry;
                const locations = entry.references.filter((reference) => reference?.filePath &&
                    Number.isSafeInteger(reference.line) && reference.line >= 0 &&
                    Number.isSafeInteger(reference.startColumn) && reference.startColumn >= 0 &&
                    Number.isSafeInteger(reference.endColumn) && reference.endColumn > reference.startColumn)
                    .map((reference) => new vscode.Location(vscode.Uri.file(reference.filePath),
                        new vscode.Range(reference.line, reference.startColumn, reference.line, reference.endColumn)));
                if (!locations.length) return null;
                const title = `${locations.length} reference${locations.length === 1 ? "" : "s"}`;
                const command = {
                    title,
                    command: "editor.action.showReferences",
                    arguments: [document.uri,
                        new vscode.Position(declaration.line, declaration.startColumn), locations]
                };
                return new vscode.CodeLens(new vscode.Range(declaration.line, declaration.startColumn,
                    declaration.line, declaration.endColumn), command);
            }).filter(Boolean);
    }

    return {
        semanticLegend: legend,
        callCodeLens: {
            onDidChangeCodeLenses: index.onDidChangeModel,
            provideCodeLenses: compilerCallCodeLenses
        },
        definition: {
            async provideDefinition(document, position, token) {
                const sidecarNavigation = index.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true;
                const noKeywordIdentifier = isPotentialNoKeywordIdentifierAt(document, position);
                const macroBindings = sidecarNavigation && isSourceMacroAtPosition(index, document, position);
                let model = await modelFor(document, token, false,
                    sidecarNavigation || noKeywordIdentifier, macroBindings);
                if (!model) return null;
                if (model.remote) {
                    const callContext = findCallContext(document.getText(), document.offsetAt(position));
                    const indexTargets = await sidecarIndexNavigationEntries(index, document, position, model, token, "definition");
                    if (indexTargets !== null) return indexTargets.map(location);
                    const argumentCall = Boolean(callContext && !callContext.indexing);
                    const constructorType = isNewConstructorTypeAtPosition(document, position);
                    const operatorSyntax = hasPotentialOperatorReceiptSyntaxAt(document, position);
                    const sourceModel = operatorSyntax || constructorType || argumentCall ||
                        model.semanticSidecarOnly && isCallCalleeAtPosition(document, position)
                        ? index.getSourceSemanticModel?.() || index.getSemanticModel(document.uri, { sourceOnly: true })
                        : null;
                    if (operatorSyntax && sourceModel) {
                        const declaredOperators = sourceOperatorDeclarationEntries(sourceModel, document, position);
                        if (declaredOperators.length) return declaredOperators.flatMap((entry) =>
                            sourceOperatorImplementationTargets(sourceModel, entry).map(location));
                        if (hasCompilerOperatorReceiptAt(sourceModel, document, position)) {
                            const selectedOperator = await sidecarSelectedOperatorTarget(
                                index, document, position, sourceModel, token, model
                            );
                            if (selectedOperator) return [location(selectedOperator.entry)];
                            /* A negative source mapping can still have replaced
                               the native snapshot while checking the operator. */
                            model = index.compilerAnalysis?.getModel?.(document.uri) || model;
                        }
                    }
                    const constructorCall = constructorType ||
                        sourceModel && isConstructorTypeCallAtPosition(sourceModel, document, position);
                    const sourceSymbol = argumentCall && sourceModel?.resolveAt(
                        document.uri, position.line, position.character
                    ).length > 0;
                    if (constructorCall || argumentCall && !sourceSymbol) {
                        const compilerModel = await compilerBindingModel(index, document, token, model);
                        if (!compilerModel || token?.isCancellationRequested) return null;
                        if (compilerModel?.semanticSidecarOnly && sourceModel) {
                            const selectedConstructor = constructorCall
                                ? await sidecarSelectedConstructorCallTarget(index, document, position, sourceModel, token)
                                : await sidecarSelectedArgumentConstructorTarget(index, document, position, sourceModel, token);
                            if (selectedConstructor) return [location(selectedConstructor.entry)];
                        } else if (compilerModel?.remote) {
                            /* Preparing a stronger snapshot releases the old
                               worker model. Continue on the replacement even
                               when this argument is not a constructor call. */
                            model = compilerModel;
                            const entries = await compilerModel.query("definition", document.uri, { position }, token) || [];
                            const constructors = entries.filter((entry) => entry.declaration.type === "constructor");
                            if (constructors.length) return constructors.map(location);
                        }
                    }
                    const entries = await model.query("definition", document.uri, { position }, token) || [];
                    if (token?.isCancellationRequested) return null;
                    if (operatorSyntax || constructorCall || argumentCall && !sourceSymbol) return entries.map(location);
                    return configuredProjectNavigation(document, position, "definition", entries, token);
                }
                if (isNewConstructorTypeAtPosition(document, position) ||
                    isConstructorTypeCallAtPosition(model, document, position)) {
                    const selectedConstructor = await sidecarSelectedConstructorCallTarget(
                        index, document, position, model, token
                    );
                    if (selectedConstructor?.entry.declaration.type === "constructor") {
                        return [location(selectedConstructor.entry)];
                    }
                }
                const declaredIndexOperators = sourceIndexOperatorDeclarationEntries(model, document, position);
                if (declaredIndexOperators.length) {
                    return sourceIndexOperatorDefinitions(model, declaredIndexOperators, document).map(location);
                }
                const indexOperators = sourceIndexOperatorEntries(model, document, position);
                if (indexOperators !== null) {
                    const selected = await sidecarSelectedOverload(index, document, position, model, indexOperators, token);
                    return sourceIndexOperatorDefinitions(model, selected || indexOperators, document).map(location);
                }
                const declaredOperators = sourceOperatorDeclarationEntries(model, document, position);
                if (declaredOperators.length) return declaredOperators.flatMap((entry) =>
                    sourceOperatorImplementationTargets(model, entry).map(location));
                if (isOperatorTokenAt(document, position) || isCastCalleeAt(document, position) ||
                    isMathOperatorCalleeAt(document, position) ||
                    hasPotentialIteratorOperatorAt(model, document, position)) {
                    const selectedOperator = await sidecarSelectedOperatorTarget(index, document, position, model, token);
                    if (selectedOperator) return [location(selectedOperator.entry)];
                }
                const candidates = model.resolveAt(document.uri, position.line, position.character);
                const selected = await sidecarSelectedOverload(index, document, position, model, candidates, token);
                const definitions = model.declarationTargets(selected || candidates);
                if (definitions.length) return definitions.map(location);
                const implicitConstructor = await sidecarSelectedArgumentConstructorTarget(
                    index, document, position, model, token
                );
                return implicitConstructor ? [location(implicitConstructor.entry)] : [];
            }
        },
        declaration: {
            async provideDeclaration(document, position, token) {
                const callContext = findCallContext(document.getText(), document.offsetAt(position));
                const argumentCall = Boolean(callContext && !callContext.indexing);
                const sidecarNavigation = index.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true;
                const noKeywordIdentifier = isPotentialNoKeywordIdentifierAt(document, position);
                const macroBindings = sidecarNavigation && isSourceMacroAtPosition(index, document, position);
                let model = await modelFor(document, token, false,
                    sidecarNavigation || noKeywordIdentifier, macroBindings);
                if (!model) return null;
                if (model.remote) {
                    const indexTargets = await sidecarIndexNavigationEntries(index, document, position, model, token, "declaration");
                    if (indexTargets !== null) return indexTargets.map(location);
                    const operatorSyntax = hasPotentialOperatorReceiptSyntaxAt(document, position);
                    const constructorType = isNewConstructorTypeAtPosition(document, position);
                    const sourceModel = operatorSyntax || constructorType || argumentCall ||
                        model.semanticSidecarOnly && isCallCalleeAtPosition(document, position)
                        ? index.getSourceSemanticModel?.() || index.getSemanticModel(document.uri, { sourceOnly: true })
                        : null;
                    const constructorCall = constructorType || Boolean(sourceModel &&
                        isConstructorTypeCallAtPosition(sourceModel, document, position));
                    if (operatorSyntax && sourceModel) {
                        const declaredOperators = sourceOperatorDeclarationEntries(sourceModel, document, position);
                        if (declaredOperators.length) return declaredOperators.flatMap((entry) =>
                            sourceOperatorDeclarationTargets(sourceModel, entry).map(location));
                        if (hasCompilerOperatorReceiptAt(sourceModel, document, position)) {
                            const selectedOperator = await sidecarSelectedOperatorTarget(
                                index, document, position, sourceModel, token, model
                            );
                            if (selectedOperator) return sourceOperatorDeclarationTargets(
                                sourceModel, selectedOperator.entry
                            ).map(location);
                            model = index.compilerAnalysis?.getModel?.(document.uri) || model;
                        }
                    }
                    const sourceSymbol = argumentCall && sourceModel?.resolveAt(
                        document.uri, position.line, position.character
                    ).length > 0;
                    if (argumentCall && !sourceSymbol) {
                        const compilerModel = await compilerBindingModel(index, document, token, model);
                        if (!compilerModel || token?.isCancellationRequested) return null;
                        if (compilerModel?.semanticSidecarOnly) {
                            const selected = await sidecarSelectedArgumentConstructorTarget(
                                index, document, position, sourceModel, token
                            );
                            if (selected) return sourceDeclarationTargets(sourceModel, [selected.entry]).map(location);
                        } else if (compilerModel?.remote) {
                            model = compilerModel;
                            const entries = await compilerModel.query("declaration", document.uri, { position }, token) || [];
                            const constructors = entries.filter((entry) => entry.declaration.type === "constructor");
                            if (constructors.length) return constructors.map(location);
                        }
                    }
                    const entries = await model.query("declaration", document.uri, { position }, token) || [];
                    if (token?.isCancellationRequested) return null;
                    if (operatorSyntax || constructorCall || argumentCall && !sourceSymbol) return entries.map(location);
                    return configuredProjectNavigation(document, position, "declaration", entries, token);
                }
                if (model.semanticSidecarOnly) model = index.getSourceSemanticModel?.() ||
                    index.getSemanticModel(document.uri, { sourceOnly: true });

                const declaredIndexOperators = sourceIndexOperatorDeclarationEntries(model, document, position);
                if (declaredIndexOperators.length) return sourceDeclarationTargets(model, declaredIndexOperators).map(location);
                const indexOperators = sourceIndexOperatorEntries(model, document, position);
                if (indexOperators !== null) {
                    const selected = await sidecarSelectedOverload(index, document, position, model, indexOperators, token);
                    return sourceDeclarationTargets(model, selected || indexOperators).map(location);
                }
                const declaredOperators = sourceOperatorDeclarationEntries(model, document, position);
                if (declaredOperators.length) return declaredOperators.flatMap((entry) =>
                    sourceOperatorDeclarationTargets(model, entry).map(location));
                if (isOperatorTokenAt(document, position) || isCastCalleeAt(document, position) ||
                    isMathOperatorCalleeAt(document, position) ||
                    hasPotentialIteratorOperatorAt(model, document, position)) {
                    const selectedOperator = await sidecarSelectedOperatorTarget(index, document, position, model, token);
                    if (selectedOperator) return sourceOperatorDeclarationTargets(model, selectedOperator.entry).map(location);
                }
                const candidates = model.resolveAt(document.uri, position.line, position.character);
                if (!candidates.length && argumentCall) {
                    const selected = await sidecarSelectedArgumentConstructorTarget(index, document, position, model, token);
                    if (selected) return sourceDeclarationTargets(model, [selected.entry]).map(location);
                }
                const selected = await sidecarSelectedOverload(index, document, position, model, candidates, token);
                return sourceDeclarationTargets(model, selected || candidates).map(location);
            }
        },
        implementation: {
            async provideImplementation(document, position, token) {
                const callContext = findCallContext(document.getText(), document.offsetAt(position));
                const argumentCall = Boolean(callContext && !callContext.indexing);
                const sidecarNavigation = index.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true;
                const noKeywordIdentifier = isPotentialNoKeywordIdentifierAt(document, position);
                const macroBindings = sidecarNavigation && isSourceMacroAtPosition(index, document, position);
                let model = await modelFor(document, token, false,
                    sidecarNavigation || noKeywordIdentifier, macroBindings);
                if (!model) return null;
                if (model.remote) {
                    const indexTargets = await sidecarIndexNavigationEntries(index, document, position, model, token, "implementation");
                    if (indexTargets !== null) return indexTargets.map(location);
                    const operatorSyntax = hasPotentialOperatorReceiptSyntaxAt(document, position);
                    const constructorType = isNewConstructorTypeAtPosition(document, position);
                    const sourceModel = operatorSyntax || constructorType || argumentCall ||
                        model.semanticSidecarOnly && isCallCalleeAtPosition(document, position)
                        ? index.getSourceSemanticModel?.() || index.getSemanticModel(document.uri, { sourceOnly: true })
                        : null;
                    const constructorCall = constructorType || Boolean(sourceModel &&
                        isConstructorTypeCallAtPosition(sourceModel, document, position));
                    if (operatorSyntax && sourceModel) {
                        const declaredOperators = sourceOperatorDeclarationEntries(sourceModel, document, position);
                        if (declaredOperators.length) return declaredOperators.flatMap((entry) =>
                            sourceOperatorImplementationTargets(sourceModel, entry).map(location));
                        if (hasCompilerOperatorReceiptAt(sourceModel, document, position)) {
                            const selectedOperator = await sidecarSelectedOperatorTarget(
                                index, document, position, sourceModel, token, model
                            );
                            if (selectedOperator) return [location(selectedOperator.entry)];
                            model = index.compilerAnalysis?.getModel?.(document.uri) || model;
                        }
                    }
                    const sourceSymbol = argumentCall && sourceModel?.resolveAt(
                        document.uri, position.line, position.character
                    ).length > 0;
                    if (argumentCall && !sourceSymbol) {
                        const compilerModel = await compilerBindingModel(index, document, token, model);
                        if (!compilerModel || token?.isCancellationRequested) return null;
                        if (compilerModel?.semanticSidecarOnly) {
                            const selected = await sidecarSelectedArgumentConstructorTarget(
                                index, document, position, sourceModel, token
                            );
                            if (selected) return implementationEntries(sourceModel, selected.entry).map(location);
                        } else if (compilerModel?.remote) {
                            model = compilerModel;
                            const entries = await compilerModel.query("definition", document.uri, { position }, token) || [];
                            const constructors = entries.filter((entry) => entry.declaration.type === "constructor" &&
                                !entry.declaration.modifiers.includes("DECLARE"));
                            if (constructors.length) return constructors.map(location);
                        }
                    }
                    if (sidecarNavigation) {
                        const entries = await model.query("implementation", document.uri, { position }, token) || [];
                        if (token?.isCancellationRequested) return null;
                        if (operatorSyntax || constructorCall || argumentCall && !sourceSymbol) {
                            return entries.map(location);
                        }
                        const definitions = entries.length
                            ? entries
                            : await model.query("definition", document.uri, { position }, token) || [];
                        if (token?.isCancellationRequested) return null;
                        return configuredProjectNavigation(
                            document, position, "implementation", definitions, token, entries
                        );
                    }
                    const entries = await model.query("definition", document.uri, { position }, token) || [];
                    const implementations = entries.filter((entry) =>
                        ["sub", "function", "property", "constructor", "destructor", "operator"].includes(entry.declaration.type) &&
                        !entry.declaration.modifiers.includes("DECLARE")
                    );
                    if (token?.isCancellationRequested) return null;
                    if (operatorSyntax || constructorCall || argumentCall && !sourceSymbol) {
                        return implementations.map(location);
                    }
                    return configuredProjectNavigation(
                        document, position, "implementation", entries, token, implementations
                    );
                }
                if (model.semanticSidecarOnly) model = index.getSourceSemanticModel?.() ||
                    index.getSemanticModel(document.uri, { sourceOnly: true });

                const declaredIndexOperators = sourceIndexOperatorDeclarationEntries(model, document, position);
                if (declaredIndexOperators.length) return sourceIndexOperatorDefinitions(model, declaredIndexOperators, document)
                    .filter((entry) => !entry.declaration.modifiers.includes("DECLARE"))
                    .map(location);
                const indexOperators = sourceIndexOperatorEntries(model, document, position);
                if (indexOperators !== null) {
                    const selected = await sidecarSelectedOverload(index, document, position, model, indexOperators, token);
                    return sourceIndexOperatorDefinitions(model, selected || indexOperators, document)
                    .filter((entry) => !entry.declaration.modifiers.includes("DECLARE"))
                    .map(location);
                }
                const declaredOperators = sourceOperatorDeclarationEntries(model, document, position);
                if (declaredOperators.length) return declaredOperators.flatMap((entry) =>
                    sourceOperatorImplementationTargets(model, entry).map(location));
                if (isOperatorTokenAt(document, position) || isCastCalleeAt(document, position) ||
                    isMathOperatorCalleeAt(document, position) ||
                    hasPotentialIteratorOperatorAt(model, document, position)) {
                    const selectedOperator = await sidecarSelectedOperatorTarget(index, document, position, model, token);
                    if (selectedOperator) return [location(selectedOperator.entry)];
                }
                const candidates = model.resolveAt(document.uri, position.line, position.character);
                const selected = await sidecarSelectedOverload(index, document, position, model, candidates, token);
                const target = selected?.[0] || (candidates.length === 1 ? candidates[0] : null);
                if (!target) {
                    if (argumentCall) {
                        const selectedConstructor = await sidecarSelectedArgumentConstructorTarget(
                            index, document, position, model, token
                        );
                        if (selectedConstructor) return implementationEntries(model, selectedConstructor.entry).map(location);
                    }
                    return [];
                }
                return implementationEntries(model, target).map(location);
            }
        },
        typeDefinition: {
            async provideTypeDefinition(document, position, token) {
                const sidecarNavigation = index.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true;
                if (sidecarNavigation) {
                    const text = document.getText();
                    const offset = document.offsetAt(position);
                    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
                    const sourceContext = await compilerAwareCodeContext(index, document, offset, linePrefix, token);
                    if (sourceContext.context !== "code") return [];
                    const tokenAtPosition = tokenize(document.lineAt(position.line).text).tokens.find((candidate) =>
                        position.character >= candidate.startColumn && position.character < candidate.endColumn
                    );
                    if (tokenAtPosition?.kind === "number" || tokenAtPosition?.kind === "string") return [];
                    if (!index.isIncomplete?.()) {
                        const sourceModel = index.getSourceSemanticModel?.();
                        const targets = sourceModel?.resolveAt?.(document.uri, position.line, position.character) || [];
                        if (targets.length && targets.every((entry) =>
                            !entry.conditional && !entry.provisional && !entry.declaration?.provisional &&
                            isPrimitiveTypeName(entry.declaration?.typeName)
                        )) return [];
                    }
                }
                const model = await modelFor(document, token, true, sidecarNavigation);
                if (!model) return null;
                if (model.semanticSidecarOnly) {
                    let compilerTypeDefinitions = null;
                    try {
                        compilerTypeDefinitions = model.remote
                            ? await model.query("compilerSidecarTypeDefinition", document.uri, { position }, token)
                            : queryCompilerModel(model, "compilerSidecarTypeDefinition", { uri: document.uri, position }, () => {
                                if (token?.isCancellationRequested) throw new Error("Type definition was cancelled.");
                            });
                    } catch {
                        if (token?.isCancellationRequested) return [];
                    }
                    if (token?.isCancellationRequested) return [];
                    if (Array.isArray(compilerTypeDefinitions) && compilerTypeDefinitions.length) {
                        return compilerTypeDefinitions.map(location);
                    }
                    const callContext = findCallContext(document.getText(), document.offsetAt(position));
                    if (model.remote && callContext?.indexing) {
                        const expression = await model.query("expression", document.uri, {
                            position,
                            preferIndexResult: true
                        }, token);
                        if (!expression || expression.provisional || token?.isCancellationRequested) return [];
                        return sidecarTypeDefinition(document, expression.typeName, token);
                    }
                    const symbolType = await sidecarResolvedSymbolTypeDefinition(document, position, token);
                    if (symbolType) return symbolType;
                    if (token?.isCancellationRequested) return [];
                    const expression = model.remote
                        ? await model.expressionAt(document.uri, position, position, token)
                        : model.expressionAt(document.uri, position);
                    if (!expression || expression.provisional || token?.isCancellationRequested) return [];
                    return sidecarTypeDefinition(document, expression.typeName, token);
                }
                if (model.remote) return (await model.query("typeDefinition", document.uri, { position }, token) || []).map(location);
                const expression = model.expressionAt?.(document.uri, position);
                if (expression) return model.nativeTypeEntries(expression.typeName, expression.subtype).map(location);
                const types = model.resolveAt(document.uri, position.line, position.character).flatMap((entry) => model.typeEntries(entry));
                return [...new Map(types.map((entry) => [entry.id, entry])).values()].map(location);
            }
        },
        typeHierarchy: {
            async prepareTypeHierarchy(document, position, token) {
                const line = document.lineAt(position.line).text;
                const sourceContext = await compilerAwareCodeContext(index, document, document.offsetAt(position),
                    line.slice(0, position.character), token);
                /* A default escaped quote can make a second source-only scan
                   hide the identifier FBC just confirmed as code. Preserve
                   the worker's mask through the caret; retain the suffix so
                   the first character and identifier-end positions work. */
                const tokenLine = sourceContext.maskedLinePrefix === undefined ? line
                    : sourceContext.maskedLinePrefix + line.slice(position.character);
                if (sourceContext.context !== "code" ||
                    !tokenize(tokenLine).tokens.some((candidate) =>
                        candidate.kind === "identifier" && position.character >= candidate.startColumn &&
                        position.character <= candidate.endColumn)) return [];
                const sidecarNavigation = index.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true;
                if (sidecarNavigation && !index.isIncomplete?.()) {
                    const sourceModel = index.getSourceSemanticModel?.();
                    const targets = sourceModel?.resolveAt?.(document.uri, position.line, position.character) || [];
                    /* An unresolved source type is not proof of a primitive.
                       VAR and TYPEOF may require FBC even in a complete index. */
                    if (targets.length && targets.every((entry) =>
                        !entry.conditional && !entry.provisional && !entry.declaration?.provisional &&
                        isPrimitiveTypeName(entry.declaration?.typeName)
                    )) {
                        return [];
                    }
                }
                const model = await modelFor(document, token, false, sidecarNavigation);
                if (!model || token?.isCancellationRequested) return null;
                const entries = model.remote
                    ? await model.query("typeHierarchyPrepare", document.uri, { position }, token) || []
                    : typeHierarchyEntries(model, document.uri, position);
                return token?.isCancellationRequested ? null : entries.map(typeHierarchyItem);
            },
            async provideTypeHierarchySupertypes(item, token) {
                const model = modelForTypeHierarchyItem(item);
                if (!model || token?.isCancellationRequested) return null;
                const position = item.selectionRange.start;
                const entries = model.remote
                    ? await model.query("typeHierarchySupertypes", item.uri, { position }, token) || []
                    : sourceTypeHierarchySupertypes(model, item.uri, position);
                return token?.isCancellationRequested ? null : entries.map(typeHierarchyItem);
            },
            async provideTypeHierarchySubtypes(item, token) {
                const model = modelForTypeHierarchyItem(item);
                if (!model || token?.isCancellationRequested) return null;
                const position = item.selectionRange.start;
                const entries = model.remote
                    ? await model.query("typeHierarchySubtypes", item.uri, { position }, token) || []
                    : sourceTypeHierarchySubtypes(model, item.uri, position, token);
                return token?.isCancellationRequested ? null : entries.map(typeHierarchyItem);
            }
        },
        callHierarchy: {
            async prepareCallHierarchy(document, position, token) {
                const text = document.getText();
                const offset = document.offsetAt(position);
                const sourceContext = await compilerAwareCodeContext(index, document, offset,
                    document.lineAt(position.line).text.slice(0, position.character), token);
                if (sourceContext.context !== "code") return null;
                const callContext = sourceContext.callContext !== undefined ? sourceContext.callContext
                    : findCallContext(text, offset, sourceContext.defaultEscapedStringRanges);
                const argumentCall = Boolean(callContext && !callContext.indexing);
                const constructorDeclaration = isConstructorDeclarationAtPosition(document, position);
                const constructorType = isNewConstructorTypeAtPosition(document, position);
                const operatorSyntax = hasPotentialOperatorReceiptSyntaxAt(document, position);
                const deleteKeyword = isDeleteKeywordAtPosition(document, position);
                const destructorControlTransfer = isDestructorControlTransferAtPosition(document, position);
                let sourceModel = operatorSyntax || constructorType || constructorDeclaration || argumentCall ||
                    destructorControlTransfer
                    ? index.getSourceSemanticModel?.() || index.getSemanticModel(document.uri, { sourceOnly: true })
                    : null;
                const constructorCall = constructorType || Boolean(sourceModel &&
                    isConstructorTypeCallAtPosition(sourceModel, document, position));
                const iteratorOperator = sourceModel && hasPotentialIteratorOperatorAt(sourceModel, document, position);
                const operatorReceiptSite = sourceModel && hasCompilerOperatorReceiptAt(sourceModel, document, position);
                let model = await modelFor(document, token, false,
                    argumentCall || constructorCall || constructorDeclaration || deleteKeyword ||
                        operatorReceiptSite || destructorControlTransfer);
                if (!model || token?.isCancellationRequested) return null;
                if (model.remote) {
                    if (sourceModel) {
                        const declaredOperators = sourceOperatorDeclarationEntries(sourceModel, document, position);
                        if (declaredOperators.length === 1) {
                            const item = callHierarchyItem(declaredOperators[0]);
                            item.data = { implicitCallEntryId: declaredOperators[0].id };
                            return [item];
                        }
                        if (constructorDeclaration && model.semanticSidecarOnly) {
                            const procedure = await sidecarConstructorProcedureLocation(index, document, position, token);
                            if (token?.isCancellationRequested) return null;
                            /* This body was resolved through the declaration
                               family. A header does not include its implementation. */
                            const source = procedure && sourceModel.getDocument(CompilerUri.file(procedure.filePath));
                            const target = procedure && sidecarImplicitCallEntryAtProcedures(
                                sourceModel, [procedure], source, "argument-constructor"
                            );
                            if (target) {
                                const item = callHierarchyItem(target);
                                item.data = { implicitCallEntryId: target.id };
                                return [item];
                            }
                        }
                        if (constructorCall && model.semanticSidecarOnly) {
                            const selectedConstructor = await sidecarSelectedConstructorCallTarget(
                                index, document, position, sourceModel, token
                            );
                            if (selectedConstructor) {
                                const item = callHierarchyItem(selectedConstructor.entry);
                                item.data = { implicitCallEntryId: selectedConstructor.entry.id };
                                return [item];
                            }
                        }
                        if (deleteKeyword) {
                            const selectedOperator = await sidecarSelectedOperatorTarget(
                                index, document, position, sourceModel, token, model
                            );
                            const implicitCalls = await sourceSidecarImplicitCalls(document, token);
                            if (token?.isCancellationRequested) return null;
                            const source = sourceModel.getDocument(document.uri);
                            const point = document.offsetAt(position);
                            const entries = new Map();
                            for (const call of implicitCalls) {
                                if (call.kind !== "delete-destructor" || !call.filePath ||
                                    CompilerUri.file(call.filePath).toString() !== document.uri.toString()) continue;
                                const callStart = document.offsetAt(new vscode.Position(call.line, call.startColumn));
                                const callEnd = document.offsetAt(new vscode.Position(call.endLine, call.endColumn));
                                if (point < callStart || point >= callEnd) continue;
                                const target = sidecarImplicitCallTargetEntry(sourceModel, call, source);
                                if (target) entries.set(target.id, target);
                            }
                            if (selectedOperator) entries.set(selectedOperator.entry.id, selectedOperator.entry);
                            if (entries.size) {
                                const items = [...entries.values()].map((entry) => {
                                    const item = callHierarchyItem(entry);
                                    item.data = { implicitCallEntryId: entry.id };
                                    return item;
                                });
                                return items;
                            }
                        }
                        if (iteratorOperator) {
                            const selectedOperator = await sidecarSelectedOperatorTarget(
                                index, document, position, sourceModel, token, model
                            );
                            if (selectedOperator) {
                                const item = callHierarchyItem(selectedOperator.entry);
                                item.data = { implicitCallEntryId: selectedOperator.entry.id };
                                return [item];
                            }
                        }
                        if (operatorReceiptSite && !deleteKeyword && !iteratorOperator) {
                            const selectedOperator = await sidecarSelectedOperatorTarget(
                                index, document, position, sourceModel, token, model
                            );
                            if (selectedOperator) {
                                const item = callHierarchyItem(selectedOperator.entry);
                                item.data = { implicitCallEntryId: selectedOperator.entry.id };
                                return [item];
                            }
                        }
                        if (destructorControlTransfer) {
                            const implicitCalls = await sourceSidecarImplicitCalls(document, token);
                            if (token?.isCancellationRequested) return null;
                            const source = sourceModel.getDocument(document.uri);
                            const point = document.offsetAt(position);
                            const entries = new Map();
                            for (const call of implicitCalls) {
                                if (call.kind !== "scope-exit-destructor" || !call.filePath ||
                                    CompilerUri.file(call.filePath).toString() !== document.uri.toString()) continue;
                                const callStart = document.offsetAt(new vscode.Position(call.line, call.startColumn));
                                const callEnd = document.offsetAt(new vscode.Position(call.endLine, call.endColumn));
                                if (point < callStart || point >= callEnd) continue;
                                const target = sidecarImplicitCallTargetEntry(sourceModel, call, source);
                                if (target) entries.set(target.id, target);
                            }
                            if (entries.size) return [...entries.values()].map((entry) => {
                                const item = callHierarchyItem(entry);
                                item.data = { implicitCallEntryId: entry.id };
                                return item;
                            });
                        }
                        if (argumentCall) {
                            const selectedImplicitCalls = await sidecarSelectedImplicitCallTargets(
                                index, document, position, sourceModel, token
                            );
                            if (token?.isCancellationRequested) return null;
                            const explicit = selectedImplicitCalls.filter((call) => call.kind === "explicit-constructor");
                            const argumentConstructors = explicit.length ? explicit : selectedImplicitCalls.filter((call) =>
                                call.kind === "argument-constructor");
                            if (argumentConstructors.length === 1) {
                                const item = callHierarchyItem(argumentConstructors[0].entry);
                                item.data = { implicitCallEntryId: argumentConstructors[0].entry.id };
                                return [item];
                            }
                        }
                    }
                    const entries = await model.query("callHierarchyPrepare", document.uri, { position }, token);
                    if (token?.isCancellationRequested) return null;
                    if (entries?.length) return entries.map(callHierarchyItem);
                    if (!sourceModel && isCallCalleeAtPosition(document, position)) {
                        sourceModel = index.getSourceSemanticModel?.() ||
                            index.getSemanticModel(document.uri, { sourceOnly: true });
                        if (sourceModel && isConstructorTypeCallAtPosition(sourceModel, document, position)) {
                            const selectedConstructor = await sidecarSelectedConstructorCallTarget(
                                index, document, position, sourceModel, token
                            );
                            if (selectedConstructor) {
                                const item = callHierarchyItem(selectedConstructor.entry);
                                item.data = { implicitCallEntryId: selectedConstructor.entry.id };
                                return [item];
                            }
                        }
                    }
                    return [];
                }
                if (model.semanticSidecarOnly) model = sourceModel;
                let candidates;
                let additionalCandidates = [];
                const constructorDeclarations = constructorDeclaration
                    ? sourceConstructorDeclarationEntriesAt(model, document, position)
                    : [];
                const declaredOperators = sourceOperatorDeclarationEntries(model, document, position);
                if (constructorDeclarations.length === 1) {
                    const implementations = implementationEntries(model, constructorDeclarations[0]);
                    candidates = implementations.length === 1 ? implementations : constructorDeclarations;
                } else if (declaredOperators.length) {
                    candidates = declaredOperators;
                } else if (isNewConstructorTypeAtPosition(document, position) ||
                    isConstructorTypeCallAtPosition(model, document, position) ||
                    isDeleteKeywordAtPosition(document, position) ||
                    isDestructorControlTransferAtPosition(document, position)) {
                    if (isDeleteKeywordAtPosition(document, position)) {
                        const selectedOperator = await sidecarSelectedOperatorTarget(
                            index, document, position, model, token
                        );
                        if (selectedOperator) additionalCandidates = [selectedOperator.entry];
                    }
                    const selectedConstructor = await sidecarSelectedImplicitCallTarget(
                        index, document, position, model, token
                    );
                    candidates = selectedConstructor ? [selectedConstructor.entry] : [];
                } else {
                    const indexOperators = sourceIndexOperatorEntries(model, document, position);
                    if (indexOperators === null) {
                        candidates = sourceCallHierarchyTargets(model, document.uri, position);
                    } else {
                        const selected = indexOperators.length > 1
                            ? await sidecarSelectedOverload(index, document, position, model, indexOperators, token)
                            : null;
                        candidates = selected || (indexOperators.length === 1 ? indexOperators : []);
                    }
                }
                if (candidates.length > 1) {
                    const selected = await sidecarSelectedOverload(index, document, position, model, candidates, token);
                    candidates = selected || [];
                }
                if (!candidates.length && (isOperatorTokenAt(document, position) || isCastCalleeAt(document, position) ||
                    isMathOperatorCalleeAt(document, position) ||
                    hasPotentialIteratorOperatorAt(model, document, position))) {
                    const selectedOperator = await sidecarSelectedOperatorTarget(index, document, position, model, token);
                    if (selectedOperator) candidates = [selectedOperator.entry];
                }
                if (!candidates.length) {
                    /* Implicit argument conversions have no source callee. Call
                       Hierarchy is already an explicit request, so consult the
                       compiler's physical implicit-call records only here. */
                    const selectedImplicitCalls = await sidecarSelectedImplicitCallTargets(
                        index, document, position, model, token
                    );
                    if (selectedImplicitCalls.length) {
                        /* Argument conversion is the written operation at this
                           site. Prefer it over the temporary cleanup also
                           attached to the same argument range. */
                        const argumentConstructors = selectedImplicitCalls.filter((call) =>
                            call.kind === "argument-constructor"
                        );
                        const selectedCalls = argumentConstructors.length
                            ? argumentConstructors
                            : selectedImplicitCalls;
                        candidates = selectedCalls.map((call) => call.entry);
                    }
                }
                const entries = [...candidates, ...additionalCandidates].filter(isCallHierarchyEntry);
                const items = entries.map(callHierarchyItem);
                return token?.isCancellationRequested ? null : items;
            },
            async provideCallHierarchyIncomingCalls(item, token) {
                if (isModuleCallHierarchyItem(item)) return [];
                const sourceDocument = await callHierarchySourceDocument(item.uri, token);
                const sourceVersion = sourceDocument?.version;
                if (token?.isCancellationRequested) return null;
                if (item.data?.implicitCallEntryId) {
                    if (!sourceDocument) return [];
                    const sourceModel = index.getSourceSemanticModel?.() ||
                        index.getSemanticModel(item.uri, { sourceOnly: true });
                    const target = sourceModel.entries.find((entry) =>
                        entry.id === item.data.implicitCallEntryId &&
                        ["constructor", "destructor", "operator"].includes(entry.declaration.type)
                    );
                    if (!target) return [];
                    const implicitCalls = await sourceSidecarImplicitCalls(sourceDocument, token);
                    const sidecarOperations = target.declaration.type === "operator"
                        ? await sourceSidecarOperatorOperations(sourceDocument, token, target)
                        : [];
                    if (token?.isCancellationRequested || sourceDocument.version !== sourceVersion) return null;
                    return sourceIncomingCalls(sourceModel, target, token, [], sidecarOperations, [], implicitCalls);
                }
                let model = modelForCallHierarchyItem(item);
                if (!model || token?.isCancellationRequested) return null;
                const position = item.selectionRange.start;
                const lifetime = item.kind === vscode.SymbolKind.Constructor || sourceDocument &&
                    isDestructorDeclarationAtPosition(sourceDocument, position);
                if (model.remote && lifetime && !model.semanticBindingsAvailable) {
                    if (!sourceDocument) return [];
                    model = await compilerBindingModel(index, sourceDocument, token, model);
                    if (!model || token?.isCancellationRequested) return null;
                }
                if (model.remote) {
                    const records = await model.query("callHierarchyIncoming", item.uri, { position }, token);
                    return token?.isCancellationRequested || sourceDocument && sourceDocument.version !== sourceVersion
                        ? null : (records || []).map((record) =>
                        new vscode.CallHierarchyIncomingCall(callHierarchyItem(record), (record.fromRanges || []).map(range))
                    );
                }
                const targets = sourceCallHierarchyTargets(model, item.uri, position);
                if (token?.isCancellationRequested || targets.length !== 1) return [];
                const sidecarCalls = sourceDocument
                    ? await sourceSidecarCallBindings(sourceDocument, model, token)
                    : [];
                const sidecarOperations = sourceDocument && targets[0].declaration.type === "operator" &&
                    !isIndexOperatorEntry(targets[0])
                    ? await sourceSidecarOperatorOperations(sourceDocument, token, targets[0])
                    : [];
                const sidecarIndexExpressions = sourceDocument && isIndexOperatorEntry(targets[0])
                    ? await sourceSidecarIndexExpressions(sourceDocument, token)
                    : [];
                const sidecarImplicitCalls = sourceDocument &&
                    ["constructor", "destructor"].includes(targets[0].declaration.type)
                    ? await sourceSidecarImplicitCalls(sourceDocument, token)
                    : [];
                return token?.isCancellationRequested || sourceDocument && sourceDocument.version !== sourceVersion ? []
                    : sourceIncomingCalls(model, targets[0], token, sidecarCalls, sidecarOperations,
                        sidecarIndexExpressions, sidecarImplicitCalls);
            },
            async provideCallHierarchyOutgoingCalls(item, token) {
                const moduleItem = isModuleCallHierarchyItem(item);
                const sourceDocument = await callHierarchySourceDocument(item.uri, token);
                const sourceVersion = sourceDocument?.version;
                if (token?.isCancellationRequested) return null;
                if (item.data?.implicitCallEntryId) {
                    if (!sourceDocument) return [];
                    const sourceModel = index.getSourceSemanticModel?.() ||
                        index.getSemanticModel(item.uri, { sourceOnly: true });
                    const target = sourceModel.entries.find((entry) =>
                        entry.id === item.data.implicitCallEntryId &&
                        ["constructor", "destructor", "operator"].includes(entry.declaration.type)
                    );
                    if (!target) return [];
                    const implicitCalls = await sourceSidecarImplicitCalls(sourceDocument, token);
                    const sidecarOperations = target.declaration.type === "operator"
                        ? await sourceSidecarOperatorOperations(sourceDocument, token, target)
                        : [];
                    if (token?.isCancellationRequested || sourceDocument.version !== sourceVersion) return null;
                    return sourceOutgoingCalls(sourceModel, target, token, [], sidecarOperations, [], implicitCalls);
                }
                const model = modelForCallHierarchyItem(item);
                if (!model || token?.isCancellationRequested) return null;
                const position = item.selectionRange.start;
                if (model.remote) {
                    const records = await model.query("callHierarchyOutgoing", item.uri, { position, module: moduleItem }, token);
                    const outgoing = (records || []).map((record) =>
                        new vscode.CallHierarchyOutgoingCall(callHierarchyItem(record), (record.fromRanges || []).map(range))
                    );
                    if (token?.isCancellationRequested || sourceDocument && sourceDocument.version !== sourceVersion) return null;
                    return outgoing;
                }
                const sidecarCalls = sourceDocument
                    ? await sourceSidecarCallBindings(sourceDocument, model, token)
                    : [];
                const sidecarOperations = sourceDocument
                    ? await sourceSidecarOperatorOperations(sourceDocument, token)
                    : [];
                const sidecarIndexExpressions = sourceDocument
                    ? await sourceSidecarIndexExpressions(sourceDocument, token)
                    : [];
                const sidecarImplicitCalls = sourceDocument
                    ? await sourceSidecarImplicitCalls(sourceDocument, token)
                    : [];
                if (token?.isCancellationRequested || sourceDocument && sourceDocument.version !== sourceVersion) return null;
                if (moduleItem) return sourceModuleOutgoingCalls(
                    model, item.uri, token, sidecarCalls, sidecarOperations, sidecarIndexExpressions, sidecarImplicitCalls
                );
                const targets = sourceCallHierarchyTargets(model, item.uri, position);
                return targets.length !== 1 ? []
                    : sourceOutgoingCalls(model, targets[0], token, sidecarCalls, sidecarOperations,
                        sidecarIndexExpressions, sidecarImplicitCalls);
            }
        },
        selectionRange: {
            async provideSelectionRanges(document, positions, token) {
                if (token?.isCancellationRequested) return null;
                if (!positions.length) return [];
                const parsed = index.getParsedDocument(document);
                const source = createDocumentModel(document.uri, parsed);
                const bracketRanges = matchedBracketRanges(source.masked);
                let compilerRanges = positions.map(() => []);
                const compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                if (token?.isCancellationRequested) return null;
                if (compilerModel?.remote) {
                    const compilerPositions = positions.map(({ line, character }) => ({ line, character }));
                    const queried = await compilerModel.query("compilerSelectionRanges", document.uri, { positions: compilerPositions }, token);
                    if (token?.isCancellationRequested) return null;
                    if (Array.isArray(queried) && queried.length === positions.length) compilerRanges = queried;
                } else if (typeof compilerModel?.compilerSelectionRanges === "function") {
                    try {
                        compilerRanges = positions.map((position) => compilerModel.compilerSelectionRanges(
                            document.uri,
                            position,
                            () => { if (token?.isCancellationRequested) throw new Error("Compiler selection-range query cancelled."); }
                        ));
                    } catch (error) {
                        if (token?.isCancellationRequested) return null;
                        throw error;
                    }
                }
                const result = [];
                for (const [index, position] of positions.entries()) {
                    if (token?.isCancellationRequested) return null;
                    const ranges = Array.isArray(compilerRanges[index]) ? compilerRanges[index] : [];
                    const selection = selectionRangeForPosition(vscode, document, source, bracketRanges, position, ranges);
                    if (selection) result.push(selection);
                }
                return result;
            }
        },
        reference: {
            async provideReferences(document, position, context, token) {
                const newConstructorCall = isNewConstructorCallee(document, position);
                const constructorDeclaration = isConstructorDeclarationAtPosition(document, position);
                const destructorDeclaration = isDestructorDeclarationAtPosition(document, position);
                const callContext = findCallContext(document.getText(), document.offsetAt(position));
                const argumentCall = Boolean(callContext && !callContext.indexing);
                let sourceModel = null;
                if (argumentCall) {
                    index.getParsedDocument?.(document);
                    sourceModel = index.getSourceSemanticModel?.() ||
                        index.getSemanticModel(document.uri, { sourceOnly: true });
                }
                const sourceSymbol = argumentCall && sourceModel?.resolveAt(
                    document.uri, position.line, position.character
                ).length > 0;
                const sidecarNavigation = index.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true;
                const noKeywordIdentifier = isPotentialNoKeywordIdentifierAt(document, position);
                const macroBindings = sidecarNavigation && isSourceMacroAtPosition(index, document, position);
                let model = await modelFor(document, token, false,
                    newConstructorCall || constructorDeclaration || destructorDeclaration || argumentCall && !sourceSymbol ||
                        sidecarNavigation || noKeywordIdentifier || macroBindings,
                    macroBindings);
                if (!model) return null;
                if (model.remote) {
                    const selectedIndex = await sidecarIndexSelection(index, document, position, model, token);
                    if (selectedIndex !== null) {
                        if (!selectedIndex.entry) return [];
                        const references = await sidecarOverloadReferences(document, selectedIndex.model,
                            selectedIndex.entry, model, token, context.includeDeclaration, true);
                        return references?.map((entry) => new vscode.Location(entry.uri, range(entry.occurrence))) || [];
                    }
                    const operatorSyntax = hasPotentialOperatorReceiptSyntaxAt(document, position);
                    if (operatorSyntax && !sourceModel) {
                        sourceModel = index.getSourceSemanticModel?.() ||
                            index.getSemanticModel(document.uri, { sourceOnly: true });
                    }
                    if (operatorSyntax && sourceModel) {
                        const declaredOperators = sourceOperatorDeclarationEntries(sourceModel, document, position);
                        if (declaredOperators.length === 1) {
                            const bindingModel = await compilerBindingModel(index, document, token, model);
                            if (token?.isCancellationRequested) return null;
                            const references = await sidecarOverloadReferences(
                                document, sourceModel, declaredOperators[0], bindingModel, token,
                                context.includeDeclaration, true
                            );
                            return references?.map((entry) => new vscode.Location(entry.uri, range(entry.occurrence))) || [];
                        }
                        if (hasCompilerOperatorReceiptAt(sourceModel, document, position)) {
                            const selectedOperator = await sidecarSelectedOperatorTarget(
                                index, document, position, sourceModel, token, model
                            );
                            if (selectedOperator) {
                                const references = await sidecarOverloadReferences(
                                    document, sourceModel, selectedOperator.entry, selectedOperator.compilerModel,
                                    token, context.includeDeclaration, true
                                );
                                return references?.map((entry) => new vscode.Location(entry.uri, range(entry.occurrence))) || [];
                            }
                            model = index.compilerAnalysis?.getModel?.(document.uri) || model;
                        }
                    }
                    const projectReferencesAvailable = !newConstructorCall && !constructorDeclaration && !destructorDeclaration && !operatorSyntax &&
                        (!argumentCall || sourceSymbol) &&
                        index.compilerProject?.hasProjectContexts?.(document.uri) === true;
                    if (projectReferencesAvailable) {
                        let projectReferences = null;
                        let projectLookupFailed = false;
                        try {
                            projectReferences = await index.compilerProject.references(
                                document, position, context.includeDeclaration, token, macroBindings
                            );
                        } catch (error) {
                            if (token?.isCancellationRequested) return null;
                            projectLookupFailed = true;
                            index.compilerAnalysis?.output?.appendLine?.(
                                `Project reference lookup fell back to this compiler snapshot: ${error.message}`
                            );
                        }
                        if (token?.isCancellationRequested) return null;
                        if (Array.isArray(projectReferences)) return projectReferences;
                        if (!projectLookupFailed) {
                            index.compilerAnalysis?.output?.appendLine?.(
                                "Project reference bindings were ambiguous or incomplete; showing references from the selected compiler snapshot only."
                            );
                        }
                    }
                    const input = { position, includeDeclaration: context.includeDeclaration };
                    if (constructorDeclaration && model.semanticSidecarOnly) {
                        const procedure = await sidecarConstructorProcedureLocation(index, document, position, token);
                        if (procedure) input.constructorProcedure = procedure;
                    }
                    if (destructorDeclaration && model.semanticSidecarOnly) {
                        const procedure = await sidecarDestructorProcedureLocation(index, document, position, token);
                        if (procedure) input.destructorProcedure = procedure;
                    }
                    return (await model.query("references", document.uri, input, token) || [])
                        .map((entry) => new vscode.Location(entry.uri, range(entry.occurrence)));
                }
                if (constructorDeclaration) {
                    const declarations = sourceConstructorDeclarationEntriesAt(model, document, position);
                    const target = declarations.length === 1 ? declarations[0] : null;
                    if (target) {
                        const compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true, true);
                        if (compilerModel?.semanticSidecarOnly) {
                            const sidecarReferences = await sidecarOverloadReferences(
                                document, model, target, compilerModel, token, context.includeDeclaration, true
                            );
                            if (token?.isCancellationRequested) return null;
                            const implicitReferences = await sourceSidecarImplicitConstructorReferences(
                                document, model, target, token
                            );
                            if (token?.isCancellationRequested) return null;
                            const locations = new Map();
                            for (const reference of sidecarReferences || []) {
                                const item = new vscode.Location(reference.uri, range(reference.occurrence));
                                locations.set(`${item.uri.toString()}:${item.range.start.line}:${item.range.start.character}:` +
                                    `${item.range.end.line}:${item.range.end.character}`, item);
                            }
                            for (const item of implicitReferences) {
                                locations.set(`${item.uri.toString()}:${item.range.start.line}:${item.range.start.character}:` +
                                    `${item.range.end.line}:${item.range.end.character}`, item);
                            }
                            return [...locations.values()];
                        }
                    }
                }
                const declaredIndexOperators = sourceIndexOperatorDeclarationEntries(model, document, position);
                const indexOperators = declaredIndexOperators.length
                    ? declaredIndexOperators
                    : sourceIndexOperatorEntries(model, document, position);
                if (indexOperators !== null && indexOperators.length) {
                    let compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    const selected = indexOperators.length > 1
                        ? await sidecarSelectedOverload(index, document, position, model, indexOperators, token, compilerModel)
                        : null;
                    const target = selected?.[0] || (indexOperators.length === 1 ? indexOperators[0] : null);
                    if (!target) return [];
                    compilerModel = compilerModel || await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    if (!compilerModel?.semanticSidecarOnly) return [];
                    const references = await sidecarOverloadReferences(
                        document, model, target, compilerModel, token, context.includeDeclaration, true
                    );
                    return references?.map((entry) => new vscode.Location(entry.uri, range(entry.occurrence))) || [];
                }
                const declaredOperators = sourceOperatorDeclarationEntries(model, document, position);
                if (declaredOperators.length) {
                    if (declaredOperators.length !== 1) return [];
                    const compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    if (!compilerModel?.semanticSidecarOnly) return [];
                    const references = await sidecarOverloadReferences(
                        document, model, declaredOperators[0], compilerModel, token, context.includeDeclaration, true
                    );
                    return references?.map((entry) => new vscode.Location(entry.uri, range(entry.occurrence))) || [];
                }
                if (isOperatorTokenAt(document, position) || isCastCalleeAt(document, position) ||
                    isMathOperatorCalleeAt(document, position) ||
                    hasPotentialIteratorOperatorAt(model, document, position)) {
                    const selectedOperator = await sidecarSelectedOperatorTarget(index, document, position, model, token);
                    if (selectedOperator) {
                        const references = await sidecarOverloadReferences(
                            document, model, selectedOperator.entry, selectedOperator.compilerModel,
                            token, context.includeDeclaration, true
                        );
                        return references?.map((entry) => new vscode.Location(entry.uri, range(entry.occurrence))) || [];
                    }
                }
                const targets = model.resolveAt(document.uri, position.line, position.character);
                if (!targets.length && argumentCall) {
                    const selectedArgumentConstructor = await sidecarSelectedArgumentConstructorTarget(
                        index, document, position, model, token
                    );
                    const compilerModel = selectedArgumentConstructor?.compilerModel;
                    const target = selectedArgumentConstructor?.entry;
                    if (compilerModel?.semanticSidecarOnly && target) {
                        const sidecarReferences = await sidecarOverloadReferences(
                            document, model, target, compilerModel, token, context.includeDeclaration, true
                        );
                        if (token?.isCancellationRequested) return null;
                        const implicitReferences = await sourceSidecarImplicitConstructorReferences(
                            document, model, target, token
                        );
                        if (token?.isCancellationRequested) return null;
                        const locations = new Map();
                        for (const reference of sidecarReferences || []) {
                            const item = new vscode.Location(reference.uri, range(reference.occurrence));
                            locations.set(`${item.uri.toString()}:${item.range.start.line}:${item.range.start.character}:` +
                                `${item.range.end.line}:${item.range.end.character}`, item);
                        }
                        for (const item of implicitReferences) {
                            locations.set(`${item.uri.toString()}:${item.range.start.line}:${item.range.start.character}:` +
                                `${item.range.end.line}:${item.range.end.character}`, item);
                        }
                        return [...locations.values()];
                    }
                }
                if (!newConstructorCall && !constructorDeclaration &&
                    targets.some((entry) => entry.declaration.type === "constructor")) {
                    const bindingModel = await modelFor(document, token, false, true);
                    if (token?.isCancellationRequested) return null;
                    if (bindingModel?.remote && bindingModel.semanticBindingsAvailable) {
                        return (await bindingModel.query("references", document.uri, { position, includeDeclaration: context.includeDeclaration }, token) || [])
                            .map((entry) => new vscode.Location(entry.uri, range(entry.occurrence)));
                    }
                }
                let selected = null, compilerModel = null;
                if (targets.length > 1) {
                    compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    selected = await sidecarSelectedOverload(index, document, position, model, targets, token, compilerModel);
                }
                const target = selected?.[0] || (targets.length === 1 ? targets[0] : null);
                if (!target) return [];
                const withImplicitConstructorReferences = async (references) => {
                    const combined = new Map();
                    for (const reference of references || []) {
                        const key = `${reference.uri.toString()}:${reference.range.start.line}:${reference.range.start.character}:` +
                            `${reference.range.end.line}:${reference.range.end.character}`;
                        combined.set(key, reference);
                    }
                    const implicit = await sourceSidecarImplicitConstructorReferences(document, model, target, token);
                    for (const reference of implicit) {
                        const key = `${reference.uri.toString()}:${reference.range.start.line}:${reference.range.start.character}:` +
                            `${reference.range.end.line}:${reference.range.end.character}`;
                        combined.set(key, reference);
                    }
                    return [...combined.values()];
                };
                if (!selected && hasVisibleOverloadSiblings(model, document, target)) {
                    compilerModel = compilerModel || await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    if (compilerModel?.semanticSidecarOnly) {
                        const references = await sidecarOverloadReferences(
                            document, model, target, compilerModel, token, context.includeDeclaration, true
                        );
                        const locations = references?.map((entry) => new vscode.Location(entry.uri, range(entry.occurrence))) || [];
                        return withImplicitConstructorReferences(locations);
                    }
                }
                if (selected && compilerModel?.semanticSidecarOnly) {
                    const references = await sidecarOverloadReferences(
                        document, model, target, compilerModel, token, context.includeDeclaration, true
                    );
                    const locations = references?.map((entry) => new vscode.Location(entry.uri, range(entry.occurrence))) || [];
                    return withImplicitConstructorReferences(locations);
                }
                const references = model.references(target, context.includeDeclaration, token)
                    .map((entry) => new vscode.Location(entry.uri, range(entry.occurrence)));
                return withImplicitConstructorReferences(references);
            }
        },
        rename: {
            async prepareRename(document, position, token) {
                if (index.compilerAnalysis?.isConfigured(document.uri)) return index.compilerProject.prepare(document, position, token);
                const model = await modelFor(document, token);
                if (!model) return null;
                targetAt(model, document, position);
                const context = model.tokenAt(document.uri, position.line, position.character);
                return { range: range(context.token), placeholder: context.token.name };
            },
            async provideRenameEdits(document, position, newName, token) {
                if (index.compilerAnalysis?.isConfigured(document.uri)) return index.compilerProject.rename(document, position, newName, token);
                const model = await modelFor(document, token);
                if (!model) return null;
                const target = targetAt(model, document, position);
                /* fb.bi defines a maximum symbol name length of 128 characters. */
                if (!/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(newName) || newName.length > 128 || reserved.has(normalizeIdentifier(newName))) {
                    throw new Error("The new name must be a non-keyword FreeBASIC identifier of at most 128 characters.");
                }
                const oldSuffix = target.name.match(/[$%!#&]$/)?.[0] || "";
                const newSuffix = newName.match(/[$%!#&]$/)?.[0] || "";
                if (oldSuffix !== newSuffix) throw new Error("Rename must preserve the identifier's type suffix.");
                const problem = model.renameProblem(target, newName);
                if (problem) throw new Error(problem);
                const edits = new vscode.WorkspaceEdit();
                for (const entry of model.references(target, true, token)) edits.replace(entry.uri, range(entry.occurrence), newName);
                return token?.isCancellationRequested ? null : edits;
            }
        },
        documentHighlight: {
            async provideDocumentHighlights(document, position, token) {
                const constructorDeclaration = isConstructorDeclarationAtPosition(document, position);
                const destructorDeclaration = isDestructorDeclarationAtPosition(document, position);
                const callContext = findCallContext(document.getText(), document.offsetAt(position));
                const argumentCall = Boolean(callContext && !callContext.indexing);
                let sourceModel = null;
                if (argumentCall) {
                    index.getParsedDocument?.(document);
                    sourceModel = index.getSourceSemanticModel?.() ||
                        index.getSemanticModel(document.uri, { sourceOnly: true });
                }
                const sourceSymbol = argumentCall && sourceModel?.resolveAt(
                    document.uri, position.line, position.character
                ).length > 0;
                const sidecarNavigation = index.compilerAnalysis?.analysisCompilerFor?.(document.uri)?.semanticModelOnly === true;
                const macroBindings = sidecarNavigation &&
                    isSourceMacroAtPosition(index, document, position);
                const needSemanticBindings = isNewConstructorCallee(document, position) || constructorDeclaration || destructorDeclaration ||
                    argumentCall && !sourceSymbol || isNumericLabelOccurrenceAt(document, position) ||
                    isPotentialNoKeywordIdentifierAt(document, position) || macroBindings ||
                    sidecarNavigation && callContext?.indexing;
                const cachedCompilerModel = index.compilerAnalysis?.getModel?.(document.uri);
                let model = cachedCompilerModel?.remote && cachedCompilerModel.semanticSidecarOnly &&
                    cachedCompilerModel.semanticBindingsAvailable &&
                    (!macroBindings || cachedCompilerModel.semanticMacroBindingsAvailable)
                    ? cachedCompilerModel
                    : await modelFor(document, token, false, needSemanticBindings, macroBindings);
                if (!model) return null;
                if (model.remote) {
                    const selectedIndex = await sidecarIndexSelection(index, document, position, model, token);
                    if (selectedIndex !== null) {
                        if (!selectedIndex.entry) return [];
                        return sidecarOverloadHighlights(document, selectedIndex.model, selectedIndex.entry, model, token);
                    }
                    const operatorSyntax = hasPotentialOperatorReceiptSyntaxAt(document, position);
                    if (operatorSyntax && !sourceModel) {
                        sourceModel = index.getSourceSemanticModel?.() ||
                            index.getSemanticModel(document.uri, { sourceOnly: true });
                    }
                    if (operatorSyntax && sourceModel) {
                        const declaredOperators = sourceOperatorDeclarationEntries(sourceModel, document, position);
                        if (declaredOperators.length === 1) {
                            const bindingModel = await compilerBindingModel(index, document, token, model);
                            if (token?.isCancellationRequested) return null;
                            return sidecarOverloadHighlights(
                                document, sourceModel, declaredOperators[0], bindingModel, token
                            );
                        }
                        if (hasCompilerOperatorReceiptAt(sourceModel, document, position)) {
                            const selectedOperator = await sidecarSelectedOperatorTarget(
                                index, document, position, sourceModel, token, model
                            );
                            if (selectedOperator) return sidecarOverloadHighlights(
                                document, sourceModel, selectedOperator.entry, selectedOperator.compilerModel, token
                            );
                            model = index.compilerAnalysis?.getModel?.(document.uri) || model;
                        }
                    }
                    const input = { position };
                    if (constructorDeclaration && model.semanticSidecarOnly) {
                        const procedure = await sidecarConstructorProcedureLocation(index, document, position, token);
                        if (procedure) input.constructorProcedure = procedure;
                    }
                    if (destructorDeclaration && model.semanticSidecarOnly) {
                        const procedure = await sidecarDestructorProcedureLocation(index, document, position, token);
                        if (procedure) input.destructorProcedure = procedure;
                    }
                    return (await model.query("highlights", document.uri, input, token) || [])
                        .map((entry) => new vscode.DocumentHighlight(
                            range(entry.occurrence), accessHighlightKind(entry.accessRole)
                        ));
                }
                if (constructorDeclaration) {
                    const declarations = sourceConstructorDeclarationEntriesAt(model, document, position);
                    if (declarations.length === 1) {
                        const compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true, true);
                        if (compilerModel?.semanticSidecarOnly) {
                            const references = await sidecarOverloadReferences(
                                document, model, declarations[0], compilerModel, token, true, false
                            );
                            const implicit = await sourceSidecarImplicitConstructorReferences(
                                document, model, declarations[0], token
                            );
                            if (token?.isCancellationRequested) return null;
                            const highlights = new Map();
                            for (const reference of references || []) {
                                if (reference.uri.toString() !== document.uri.toString()) continue;
                                const sourceRange = range(reference.occurrence);
                                highlights.set(`${sourceRange.start.line}:${sourceRange.start.character}:${sourceRange.end.line}:${sourceRange.end.character}`,
                                    new vscode.DocumentHighlight(sourceRange, vscode.DocumentHighlightKind.Text));
                            }
                            for (const reference of implicit) {
                                if (reference.uri.toString() !== document.uri.toString()) continue;
                                highlights.set(`${reference.range.start.line}:${reference.range.start.character}:${reference.range.end.line}:${reference.range.end.character}`,
                                    new vscode.DocumentHighlight(reference.range, vscode.DocumentHighlightKind.Text));
                            }
                            return [...highlights.values()];
                        }
                    }
                }
                const declaredIndexOperators = sourceIndexOperatorDeclarationEntries(model, document, position);
                const indexOperators = declaredIndexOperators.length
                    ? declaredIndexOperators
                    : sourceIndexOperatorEntries(model, document, position);
                if (indexOperators !== null && indexOperators.length) {
                    const compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    if (compilerModel?.semanticSidecarOnly) {
                        const selected = indexOperators.length > 1
                            ? await sidecarSelectedOverload(index, document, position, model, indexOperators, token, compilerModel)
                            : null;
                        const target = selected?.[0] || (indexOperators.length === 1 ? indexOperators[0] : null);
                        if (!target) return [];
                        return sidecarOverloadHighlights(document, model, target, compilerModel, token);
                    }
                }
                const declaredOperators = sourceOperatorDeclarationEntries(model, document, position);
                if (declaredOperators.length) {
                    if (declaredOperators.length !== 1) return [];
                    const compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    if (compilerModel?.semanticSidecarOnly) return sidecarOverloadHighlights(
                        document, model, declaredOperators[0], compilerModel, token
                    );
                }
                if (isOperatorTokenAt(document, position) || isCastCalleeAt(document, position) ||
                    isMathOperatorCalleeAt(document, position) ||
                    hasPotentialIteratorOperatorAt(model, document, position)) {
                    const selectedOperator = await sidecarSelectedOperatorTarget(index, document, position, model, token);
                    if (selectedOperator) return sidecarOverloadHighlights(
                        document, model, selectedOperator.entry, selectedOperator.compilerModel, token
                    );
                }
                if (argumentCall && !model.resolveAt(document.uri, position.line, position.character).length) {
                    const selectedArgumentConstructor = await sidecarSelectedArgumentConstructorTarget(
                        index, document, position, model, token
                    );
                    if (selectedArgumentConstructor?.compilerModel?.semanticSidecarOnly) {
                        const implicitReferences = await sourceSidecarImplicitConstructorReferences(
                            document, model, selectedArgumentConstructor.entry, token
                        );
                        if (token?.isCancellationRequested) return null;
                        return implicitReferences.filter((reference) => reference.uri.toString() === document.uri.toString())
                            .map((reference) => new vscode.DocumentHighlight(
                                reference.range, vscode.DocumentHighlightKind.Text
                            ));
                    }
                }
                const targets = model.resolveAt(document.uri, position.line, position.character);
                if (targets.length > 1) {
                    const compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    const selected = await sidecarSelectedOverload(index, document, position, model, targets, token, compilerModel);
                    if (selected?.length === 1) return sidecarOverloadHighlights(document, model, selected[0], compilerModel, token);
                }
                if (targets.length !== 1) return [];
                if (hasVisibleOverloadSiblings(model, document, targets[0])) {
                    const compilerModel = await index.compilerAnalysis?.getModelForEditor?.(document, token, true);
                    if (compilerModel?.semanticSidecarOnly) {
                        return sidecarOverloadHighlights(document, model, targets[0], compilerModel, token);
                    }
                }
                const references = model.references(targets[0], true, token)
                    .filter((entry) => entry.uri.toString() === document.uri.toString());
                const accessRoles = await cachedSidecarSymbolUses(
                    index, document, references.map((entry) => entry.occurrence), token
                );
                if (token?.isCancellationRequested || !accessRoles) return null;
                return references.map((entry, index) => new vscode.DocumentHighlight(
                    range(entry.occurrence), accessHighlightKind(accessRoles.get(index)?.role)
                ));
            }
        },
        semanticTokens: {
            onDidChangeSemanticTokens: index.onDidChangeModel,
            async provideDocumentSemanticTokens(document, token) {
                const model = await modelFor(document, token, false,
                    hasPotentialNoKeywordOptionInDocument(document));
                const builder = new vscode.SemanticTokensBuilder(legend);
                if (!model) return builder.build();
                if (model.remote) {
                    const data = await model.query("semanticTokens", document.uri, {}, token);
                    return data ? new vscode.SemanticTokens(data) : null;
                }
                const semanticDocument = model.getDocument(document.uri);
                if (!semanticDocument) return builder.build();
                const identifierOccurrences = semanticDocument.tokens.filter((occurrence) => occurrence.kind === "identifier");
                const accessRoles = await cachedSidecarSymbolUses(index, document, identifierOccurrences, token);
                if (token?.isCancellationRequested || !accessRoles) return null;
                for (let index = 0; index < identifierOccurrences.length; index++) {
                    const occurrence = identifierOccurrences[index];
                    if (token?.isCancellationRequested) return null;
                    const targets = model.resolveToken(semanticDocument, occurrence);
                    if (targets.length !== 1) continue;
                    const entry = targets[0];
                    const modifiers = [];
                    const declaration = semanticDocument.entriesByOffset.get(occurrence.offset);
                    if (declaration) modifiers.push(declaration.declaration.modifiers.includes("DECLARE") ? "declaration" : "definition");
                    if (semanticEntryIsReadonly(entry, accessRoles.get(index)?.readonly === true)) modifiers.push("readonly");
                    if (entry.declaration.modifiers.includes("STATIC")) modifiers.push("static");
                    if (entry.declaration.modifiers.includes("ABSTRACT")) modifiers.push("abstract");
                    if (semanticEntryIsDeprecated(entry)) modifiers.push("deprecated");
                    const accessRole = accessRoles.get(index)?.role;
                    if (accessRole === "write" || accessRole === "read-write") modifiers.push("modification");
                    builder.push(range(occurrence), semanticTokenType(entry), modifiers);
                }
                return builder.build();
            }
        }
    };
}

module.exports = {
    TOKEN_MODIFIERS, TOKEN_TYPES, createSemanticFeatures, semanticTokenType,
    hasCompilerOperatorReceiptAt, hasPotentialOperatorReceiptSyntaxAt, hasPotentialOperatorLetAt,
    isCastCalleeAt, isMathOperatorCalleeAt, isOperatorTokenAt,
    compilerOperatorKeywordAtPosition, hasPotentialIteratorOperatorAt,
    sidecarOverloadKey, sidecarReturnTypeMatches,
    sidecarSelectedOperatorTarget, sidecarSelectedOverload
};

/* end of lib/semantic-features.js */
