/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/grammar-data.js

    Purpose:

        Load the source-backed language data shared by syntax highlighting
        and the lightweight editor features.

    Responsibilities:

        - read and validate the grammar source JSON
        - expose each language symbol group in a stable sorted order
        - keep the extension entry point independent of the JSON layout

    This file intentionally does NOT contain:

        - TextMate grammar generation
        - completion or hover presentation logic
        - FreeBASIC declaration parsing
*/

const fs = require("fs");
const path = require("path");

function loadGrammarSource(extensionPath) {
    const sourcePath = path.join(extensionPath, "syntaxes", "source", "freebasic.grammar-source.json");
    return loadGrammarSourceFile(sourcePath);
}

function loadGrammarSourceFile(sourcePath) {
    const sourceText = fs.readFileSync(sourcePath, "utf8");
    const data = JSON.parse(sourceText);

    return {
        sourceVersion: String(data.sourceVersion || ""),
        preprocessorDirectives: asSortedUniqueUppercaseArray(data.preprocessorDirectives),
        operatorKeywords: asSortedUniqueArray(data.operatorKeywords),
        types: asSortedUniqueArray(data.types),
        typeModifiers: asSortedUniqueArray(data.typeModifiers),
        constants: asSortedUniqueArray(data.constants),
        compilerDefines: asSortedUniqueArray(data.compilerDefines),
        libraryTypes: asSortedUniqueArray(data.libraryTypes),
        symbolicConstants: asSortedUniqueArray(data.symbolicConstants),
        intrinsicFunctions: asSortedUniqueArray(data.intrinsicFunctions),
        bundledFunctions: asSortedUniqueArray(data.bundledFunctions),
        runtimeFunctions: asSortedUniqueArray(data.runtimeFunctions),
        graphicsFunctions: asSortedUniqueArray(data.graphicsFunctions),
        keywords: asSortedUniqueArray(data.keywords)
    };
}

function asSortedUniqueArray(values) {
    return Array.from(new Set((values || []).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function asSortedUniqueUppercaseArray(values) {
    return asSortedUniqueArray((values || []).map((value) => String(value).toUpperCase()));
}

module.exports = {
    loadGrammarSource,
    loadGrammarSourceFile,
    asSortedUniqueArray,
    asSortedUniqueUppercaseArray
};

/* end of lib/grammar-data.js */
