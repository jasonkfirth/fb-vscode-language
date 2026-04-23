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
        keywords: asSortedUniqueArray(data.keywords),
        types: asSortedUniqueArray(data.types),
        intrinsicFunctions: asSortedUniqueArray(data.intrinsicFunctions),
        runtimeFunctions: asSortedUniqueArray(data.runtimeFunctions),
        graphicsFunctions: asSortedUniqueArray(data.graphicsFunctions),
        symbolicConstants: asSortedUniqueArray(data.symbolicConstants || [])
    };
}

function asSortedUniqueArray(values) {
    return Array.from(new Set((values || []).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

module.exports = {
    loadGrammarSource,
    loadGrammarSourceFile,
    asSortedUniqueArray
};
