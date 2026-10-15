/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-scopes.js
    Purpose: Decode compiler-owned source scopes and declaration inventory.
    Responsibilities: validate bounded identities, source spans, and shape links.
    Does not contain: source parsing, inferred declarations, or editor APIs.
*/

const MAX_SCOPE_RECORDS = 200000;

function createScopeDecoder(decodeHex, integer) {
    const scopes = [];
    const declarations = new Map();
    const shapes = new Map();
    const imports = [];
    let count = 0;
    function read(line) {
        const begin = line.match(/^''@fb-editor-scope begin (\d+) (\d+) (\d+) (\d+) (\d+) (scope|procedure|namespace|type|union|enum)$/);
        const end = line.match(/^''@fb-editor-scope end (\d+) (\d+) (\d+) ([01])$/);
        const declaration = line.match(/^''@fb-editor-declaration (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) ([01]) ([a-f\d]+)$/i);
        const shape = line.match(/^''@fb-editor-shape (\d+) (\d+) (\d+) (\d+) (\d+) ([01]) (-?\d+)$/);
        const imported = line.match(/^''@fb-editor-import (\d+) (\d+) (\d+) (\d+)$/);
        if (!begin && !end && !declaration && !shape && !imported) return false;
        if (++count > MAX_SCOPE_RECORDS) throw new Error("Compiler scope/inventory records exceeded 200000 entries.");
        if (begin) {
            const id = integer(begin[1], 1), parent = integer(begin[2]);
            if (id !== scopes.length + 1 || parent >= id) throw new Error("Invalid compiler scope identity or parent.");
            scopes.push({ id, parent, symbol: integer(begin[3], 1), startSerial: integer(begin[4], 1), startByte: integer(begin[5]), kind: begin[6] });
        } else if (end) {
            const scope = scopes[integer(end[1], 1) - 1];
            if (!scope || scope.endSerial !== undefined) throw new Error("Compiler closed an unknown or already closed scope.");
            Object.assign(scope, { endSerial: integer(end[2], 1), endByte: integer(end[3]), recovered: end[4] === "1" });
        } else if (declaration) {
            const record = { symbol: integer(declaration[1], 1), scope: integer(declaration[2]), startSerial: integer(declaration[3], 1), startByte: integer(declaration[4]), endSerial: integer(declaration[5], 1), endByte: integer(declaration[6]), prototype: declaration[7] === "1", name: decodeHex(declaration[8], "declaration spelling") };
            declarations.set(`${record.startSerial}:${record.startByte}:${record.symbol}`, record);
        } else if (shape) {
            const record = { symbol: integer(shape[1], 1), base: integer(shape[2]), anonymousParent: integer(shape[3]), options: integer(shape[4]), parameterMode: integer(shape[5]), optional: shape[6] === "1", dimensions: integer(shape[7], -1) };
            shapes.set(record.symbol, record);
        } else imports.push({ source: integer(imported[1], 1), destination: integer(imported[2]), serial: integer(imported[3], 1), byte: integer(imported[4]) });
        return true;
    }
    function finish(position, lines, outputLines, symbolGraph, invalidLines, completion, protocolVersion) {
        const symbols = new Map(symbolGraph.symbols.map((symbol) => [symbol.id, symbol]));
        const canonical = new Map(symbolGraph.canonicalIds);
        const requireSymbol = (id) => { if (id && !symbols.has(id)) throw new Error("Compiler inventory refers to a missing symbol."); };
        function range(record) {
            record.start = position(record.startSerial, record.startByte);
            record.end = position(record.endSerial, record.endByte);
            if (record.end.line < record.start.line || record.end.line === record.start.line && record.end.character < record.start.character) throw new Error("Invalid compiler scope/inventory range.");
        }
        const lastSourceLine = [...outputLines.values()].at(-1);
        for (const scope of scopes) {
            requireSymbol(scope.symbol);
            if (scope.endSerial === undefined) {
                if (!completion?.errorCount && completion?.reachedEnd) throw new Error("The compiler left a source scope open without reporting an error.");
                scope.start = position(scope.startSerial, scope.startByte);
                scope.end = { line: lastSourceLine ?? scope.start.line, character: lines[lastSourceLine]?.length || 0 };
                scope.recovered = true;
            } else range(scope);
            scope.symbol = canonical.get(scope.symbol);
        }
        for (const scope of scopes) {
            const parent = scopes[scope.parent - 1];
            if (parent && (scope.start.line < parent.start.line || scope.end.line > parent.end.line)) throw new Error("Compiler child scope falls outside its parent.");
        }
        const records = [];
        for (const record of declarations.values()) {
            requireSymbol(record.symbol);
            if (record.scope && !scopes[record.scope - 1]) throw new Error("Compiler declaration refers to a missing scope.");
            try {
                range(record);
            } catch (error) {
                if (record.name.toLowerCase() !== "rem" || error.message !== "Invalid compiler expression boundary.") throw error;
                symbolGraph.nonRenameable.push(canonical.get(record.symbol));
                continue;
            }
            if (lines[record.start.line].slice(record.start.character, record.start.character + record.name.length).toLowerCase() !== record.name.toLowerCase()) {
                if (record.name.toLowerCase() !== "rem") throw new Error("Compiler inventory spelling does not match its source token.");
                symbolGraph.nonRenameable.push(canonical.get(record.symbol));
                continue;
            }
            record.invalid = invalidLines.has(record.start.line);
            record.originalSymbol = record.symbol;
            record.symbol = canonical.get(record.symbol);
            records.push(record);
        }
        for (const shape of shapes.values()) {
            for (const id of [shape.symbol, shape.base, shape.anonymousParent]) requireSymbol(id);
        }
        if (protocolVersion >= 8) for (const symbol of symbols.values()) {
            if (!shapes.has(symbol.id)) throw new Error("Compiler symbol has no shape metadata.");
        }
        for (const imported of imports) {
            requireSymbol(imported.source);
            requireSymbol(imported.destination);
            imported.position = position(imported.serial, imported.byte);
            imported.invalid = invalidLines.has(imported.position.line);
        }
        return { scopes, declarations: records, shapes: [...shapes.values()], imports };
    }
    return { read, finish };
}

function shiftedIdentity(identity, thresholds = []) {
    if (!identity) return identity;
    let result = identity;
    for (const threshold of thresholds) if (identity >= threshold) result++;
    return result;
}

function scopeGraphSignature(analysis, renamedIds = new Set(), newName = "", structuralScopePlan = null) {
    const graph = analysis.scopeGraph;
    const ignored = structuralScopePlan?.symbols || new Set();
    const symbol = (identity) => structuralScopePlan?.remap ? shiftedIdentity(identity, structuralScopePlan.symbolThresholds) : identity;
    const scope = (identity) => structuralScopePlan?.remap ? shiftedIdentity(identity, structuralScopePlan.scopeThresholds) : identity;
    // Symbol uses and expression signatures separately validate byte shifts.
    // Here a name may change, but scope ownership, source-line placement,
    // prototype roles, imports, and native layout/type attributes may not.
    const result = {
        scopes: graph.scopes.filter(({ symbol: id }) => !ignored.has(id)).map(({ id, parent, symbol: idSymbol, kind, startSerial, endSerial, recovered }) => [scope(id), scope(parent), symbol(idSymbol), kind, startSerial, endSerial, recovered]),
        declarations: graph.declarations.filter(({ symbol: id }) => !ignored.has(id)).map(({ symbol: idSymbol, scope: idScope, startSerial, endSerial, name, prototype, invalid }) => [symbol(idSymbol), scope(idScope), startSerial, endSerial, renamedIds.has(idSymbol) ? newName.toLowerCase() : name.toLowerCase(), prototype, invalid]),
        shapes: graph.shapes.filter(({ symbol: id }) => !ignored.has(id)).map(({ symbol: idSymbol, base, anonymousParent, options, parameterMode, optional, dimensions }) => ({ symbol: symbol(idSymbol), base: symbol(base), anonymousParent: symbol(anonymousParent), options, parameterMode, optional, dimensions })),
        imports: graph.imports.map(({ source, destination, serial, invalid }) => [symbol(source), symbol(destination), serial, invalid])
    };
    if (structuralScopePlan) result.structuralScopeCount = structuralScopePlan.expected;
    return result;
}

module.exports = { createScopeDecoder, scopeGraphSignature };

/* end of compiler-scopes.js */
