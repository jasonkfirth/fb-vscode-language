/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/semantic-token-data.js
    Purpose: Share the semantic-token legend between local and worker providers.
    Responsibilities: map declaration kinds to stable token types and modifiers.
    Does not contain: editor APIs, semantic lookup, or token production.
*/

const { AGGREGATE_TYPES, CALLABLE_TYPES } = require("./semantic-model");

const TOKEN_TYPES = ["namespace", "type", "class", "struct", "enum", "parameter", "variable", "property", "enumMember", "function", "method", "macro", "label"];
const TOKEN_MODIFIERS = ["declaration", "definition", "readonly", "static", "abstract", "modification", "deprecated", "defaultLibrary"];

function semanticEntryIsDeprecated(entryOrDeclaration) {
    const entry = entryOrDeclaration?.declaration ? entryOrDeclaration : null;
    const declaration = entry?.declaration || entryOrDeclaration;
    const documentation = declaration?.documentation;
    return entry?.provisional !== true && declaration?.provisional !== true &&
        typeof documentation === "string" && documentation.length <= 4096 &&
        /^\s*(?:@|\\)deprecated\b/im.test(documentation);
}

function semanticTokenType(entry) {
    const type = entry.declaration.type;
    if (type === "type" || type === "union") return entry.declaration.detail === "Type alias" ? "type" : "struct";
    if (type === "field" || type === "property") return "property";
    if (type === "const" || type === "extern") return "variable";
    if (type === "macro") return "macro";
    if (CALLABLE_TYPES.has(type)) {
        if (entry.callableKind === "function" || entry.callableKind === "method") return entry.callableKind;
        return AGGREGATE_TYPES.has(entry.scope.kind) || entry.declaration.name.includes(".") ? "method" : "function";
    }
    return TOKEN_TYPES.includes(type) ? type : "variable";
}

function semanticEntryIsReadonly(entry, compilerReadonly = false) {
    return ["const", "enumMember"].includes(entry.declaration.type) ||
        compilerReadonly === true && !entry.provisional && !entry.declaration.provisional &&
        ["variable", "extern", "field", "parameter"].includes(entry.declaration.type);
}

module.exports = { TOKEN_TYPES, TOKEN_MODIFIERS, semanticTokenType, semanticEntryIsDeprecated, semanticEntryIsReadonly };

/* end of lib/semantic-token-data.js */
