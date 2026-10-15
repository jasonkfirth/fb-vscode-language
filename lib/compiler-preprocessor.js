/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-preprocessor.js
    Purpose: Decode committed preprocessor declarations and lookup decisions.
    Responsibilities: validate definition instances, parameter slots, and epochs.
    Does not contain: source lookup, preprocessing, or editor refactoring policy.
*/

const MAX_RECORDS = 200000;

function createPreprocessorDecoder(decodeHex, integer) {
    const declarations = [], declarationById = new Map(), references = [], parameters = [], contexts = [], events = [];
    let lastDeclarationId = 0;
    let count = 0;
    return {
        read(line) {
            const declaration = line.match(/^''@fb-editor-macro-declaration (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) ([01])$/);
            const reference = line.match(/^''@fb-editor-macro-reference (\d+) (\d+) (\d+) (invoke|query|undef|deferred) ([a-f\d]+)$/i);
            const parameter = line.match(/^''@fb-editor-macro-parameter (\d+) (\d+) (declaration|reference) (\d+) ([a-f\d]+)$/i);
            const context = line.match(/^''@fb-editor-macro-context (\d+) (\d+)$/);
            if (!declaration && !reference && !parameter && !context) return false;
            if (++count > MAX_RECORDS) throw new Error("Compiler preprocessor records exceeded 200000 entries.");
            if (declaration) {
                const [id, symbol, sourceMap, epoch, parameterCount, flags] = declaration.slice(1, 7).map((value) => integer(value));
                if (id <= lastDeclarationId || !symbol || !epoch || parameterCount > 32 || flags > 15 || parameterCount && declaration[7] === "1") throw new Error("Invalid compiler macro declaration identity or shape.");
                const record = { id, symbol, sourceMap, epoch, parameterCount, flags, argless: declaration[7] === "1" };
                declarations.push(record);
                declarationById.set(id, record);
                lastDeclarationId = id;
                events.push({ kind: "declaration", record });
            } else if (reference) {
                const record = { symbol: integer(reference[1]), sourceMap: integer(reference[2]), epoch: integer(reference[3]), role: reference[4].toLowerCase(), name: decodeHex(reference[5], "preprocessor reference spelling") };
                if (!record.symbol && record.role !== "query" && record.role !== "deferred") throw new Error("A compiler preprocessor reference has no native target.");
                references.push(record);
                events.push({ kind: "reference", record });
            } else if (parameter) parameters.push({ declaration: integer(parameter[1], 1), ordinal: integer(parameter[2]), kind: parameter[3].toLowerCase(), sourceMap: integer(parameter[4]), name: decodeHex(parameter[5], "macro parameter spelling") });
            else contexts.push({ sourceMap: integer(context[1], 1), epoch: integer(context[2]) });
            return true;
        },
        finish(symbolGraph, macroGraph, tokens, protocolVersion) {
            const symbols = new Map(symbolGraph.symbols.map((symbol) => [symbol.id, symbol]));
            const maps = new Set(macroGraph.nodes.map((node) => node.id));
            const parameterNames = new Map();
            let epoch = 0;
            if (events.length) {
                const first = events[0];
                const firstSymbol = symbols.get(first.record.symbol);
                const firstAdvancesEpoch = first.kind === "declaration" || first.record.role === "undef" && firstSymbol?.symbolClass === 5;
                epoch = first.record.epoch - Number(firstAdvancesEpoch);
                if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Compiler preprocessor begins with an invalid macro epoch.");
            } else if (tokens.length) {
                epoch = tokens[0].epoch || 0;
                for (const token of tokens) if (token.epoch !== undefined && token.epoch < epoch) epoch = token.epoch;
            }
            for (const { kind, record } of events) {
                const symbol = symbols.get(record.symbol);
                if (record.symbol && !symbol) throw new Error("Compiler preprocessor record refers to a missing symbol.");
                if (kind === "declaration" || record.role === "invoke") {
                    // FB_SYMBCLASS_DEFINE is 5; queries and #undef also accept
                    // ordinary native symbols and must retain that distinction.
                    if (symbol?.symbolClass !== 5) throw new Error("Compiler macro record does not name a DEFINE symbol.");
                }
                if (kind === "declaration" || record.role === "undef" && symbol?.symbolClass === 5) epoch++;
                if (record.epoch !== epoch) throw new Error("Compiler preprocessor epochs are incomplete or out of order.");
            }
            for (const parameter of parameters) {
                const declaration = declarationById.get(parameter.declaration);
                if (!declaration || parameter.ordinal >= declaration.parameterCount) throw new Error("Compiler macro parameter has no declaration slot.");
                if (parameter.kind !== "declaration") continue;
                const key = `${parameter.declaration}:${parameter.ordinal}`;
                if (parameterNames.has(key)) throw new Error("Duplicate compiler macro parameter declaration.");
                parameterNames.set(key, parameter.name.toLowerCase());
            }
            for (const declaration of declarations) for (let ordinal = 0; ordinal < declaration.parameterCount; ordinal++) {
                if (!parameterNames.has(`${declaration.id}:${ordinal}`)) throw new Error("Compiler macro declaration is missing a parameter slot.");
            }
            for (const parameter of parameters) if (parameterNames.get(`${parameter.declaration}:${parameter.ordinal}`) !== parameter.name.toLowerCase()) throw new Error("Compiler macro parameter spelling does not match its declaration.");
            for (const record of [...declarations, ...references, ...parameters, ...contexts]) if (record.sourceMap && !maps.has(record.sourceMap)) throw new Error("Compiler preprocessor source map is missing.");
            for (const context of contexts) if (context.epoch > epoch) throw new Error("Compiler conditional macro context has an invalid epoch.");
            if (contexts.length && protocolVersion < 13) throw new Error("Compiler conditional macro context requires protocol 13.");
            if (protocolVersion >= 11) for (const token of tokens) if (token.epoch === undefined || token.epoch > epoch) throw new Error("Compiler token has an invalid preprocessor epoch.");
            return { declarations, references, parameters, contexts, epochs: epoch };
        }
    };
}

function preprocessorGraphSignature(analysis, renamedIds = new Set(), newName = "") {
    const graph = analysis.preprocessorGraph || { declarations: [], references: [], parameters: [], contexts: [], epochs: 0 };
    const symbols = new Map(analysis.symbolGraph.symbols.map((symbol) => [symbol.id, symbol]));
    const canonical = new Map(analysis.symbolGraph.canonicalIds);
    const macroIdentity = (id, name) => symbols.get(id)?.symbolClass === 5 ? `macro:${id}` : id ? canonical.get(id) || id : `undefined:${name.toLowerCase()}`;
    const spelling = (identity, name) => (renamedIds.has(identity) ? newName : name).toLowerCase();
    return {
        declarations: graph.declarations.map((record) => [record.id, record.symbol, record.sourceMap, record.epoch, record.parameterCount, record.flags, record.argless, spelling(`macro:${record.symbol}`, symbols.get(record.symbol).name)]),
        references: graph.references.map((record) => [record.symbol, record.sourceMap, record.epoch, record.role, spelling(macroIdentity(record.symbol, record.name), record.name)]),
        parameters: graph.parameters.map((record) => [record.declaration, record.ordinal, record.kind, record.sourceMap, spelling(`parameter:${record.declaration}:${record.ordinal}`, record.name)]),
        contexts: (graph.contexts || []).map((record) => [record.sourceMap, record.epoch]),
        epochs: graph.epochs
    };
}

module.exports = { createPreprocessorDecoder, preprocessorGraphSignature };

/* end of compiler-preprocessor.js */
