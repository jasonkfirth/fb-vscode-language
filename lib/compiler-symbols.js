/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-symbols.js
    Purpose: Decode native symbol metadata, uses, and canonical relationships.
    Responsibilities: validate graph identities and expanded token coordinates.
    Does not contain: source parsing, inferred bindings, or editor APIs.
*/

const MAX_SYMBOL_RECORDS = 200000;

function createSymbolDecoder(decodeHex, integer) {
    const symbols = new Map();
    const aliases = new Map();
    const dispatch = new Map();
    const uses = [];
    const nonRenameable = new Set();
    let count = 0;

    function read(line) {
        /* Metadata layout: identity, compiler class, full dtype, subtype,
           lexical owner, namespace, attributes, procedure attributes, numeric
           scope depth, legacy procedure ID, hex name, hex display type.
           A dash represents an intentionally unnamed symbol or absent type. */
        const metadata = line.match(/^''@fb-editor-symbol (\d+) (\d+) (-?\d+) (\d+) (\d+) (\d+) (-?\d+) (-?\d+) (\d+) (\d+) ([a-f\d]+|-) ([a-f\d]+|-)$/i);
        const use = line.match(/^''@fb-editor-use (declaration|reference) (\d+) (\d+) (\d+) ([a-f\d]+)$/i);
        const alias = line.match(/^''@fb-editor-alias (\d+) (\d+)$/);
        const restricted = line.match(/^''@fb-editor-symbol-norename (\d+)$/);
        const virtual = line.match(/^''@fb-editor-dispatch (\d+) (\d+) (\d+)$/);
        if (!metadata && !use && !alias && !restricted && !virtual) return false;
        if (++count > MAX_SYMBOL_RECORDS) throw new Error("Compiler symbol records exceeded 200000 entries.");
        if (virtual) {
            const id = integer(virtual[1], 1);
            dispatch.set(id, { id, overridden: integer(virtual[2]), slot: integer(virtual[3]) });
        } else if (restricted) nonRenameable.add(integer(restricted[1], 1));
        else if (metadata) {
            const id = integer(metadata[1], 1);
            const symbolClass = integer(metadata[2], 1);
            if (symbolClass > 17) throw new Error("Unsupported native compiler symbol class.");
            const symbol = { id, symbolClass, dtype: integer(metadata[3], -2147483648), subtype: integer(metadata[4]), owner: integer(metadata[5]), namespace: integer(metadata[6]), attributes: integer(metadata[7], -2147483648), procedureAttributes: integer(metadata[8], -2147483648), scopeDepth: integer(metadata[9]), procedureId: integer(metadata[10]), name: metadata[11] === "-" ? "" : decodeHex(metadata[11], "symbol name"), typeName: metadata[12] === "-" ? "" : decodeHex(metadata[12], "symbol type") };
            if (symbols.has(id) && symbols.get(id).symbolClass !== symbolClass) throw new Error("Compiler changed an existing symbol's class.");
            symbols.set(id, symbol);
        } else if (use) {
            uses.push({ kind: use[1], outputLine: integer(use[2], 1), byteColumn: integer(use[3]), id: integer(use[4], 1), name: decodeHex(use[5], "symbol spelling") });
        } else {
            const id = integer(alias[1], 1), target = integer(alias[2], 1);
            if (aliases.has(id) && aliases.get(id) !== target) throw new Error("Conflicting compiler symbol aliases.");
            aliases.set(id, target);
        }
        return true;
    }

    function finish(outputLines, lines, invalidLines, protocolVersion, mapOutputBytePosition) {
        function requireSymbol(id) { if (id && !symbols.has(id)) throw new Error("Compiler symbol graph refers to a missing identity."); }
        for (const symbol of symbols.values()) for (const id of [symbol.subtype, symbol.owner, symbol.namespace]) requireSymbol(id);
        const canonicalIds = new Map();
        function canonical(id) {
            requireSymbol(id);
            if (canonicalIds.has(id)) return canonicalIds.get(id);
            const visited = new Set();
            let current = id;
            while (aliases.has(current) && !canonicalIds.has(current)) {
                if (visited.has(current)) throw new Error("Cyclic compiler symbol aliases.");
                visited.add(current);
                current = aliases.get(current);
                requireSymbol(current);
            }
            current = canonicalIds.get(current) || current;
            for (const member of visited) canonicalIds.set(member, current);
            canonicalIds.set(id, current);
            return current;
        }
        for (const id of symbols.keys()) canonical(id);
        const methods = new Map();
        function requireProcedure(id) {
            requireSymbol(id);
            if (symbols.get(id)?.symbolClass !== 3) throw new Error("Compiler dispatch graph refers to a non-procedure.");
        }
        for (const record of dispatch.values()) {
            requireProcedure(record.id);
            if (record.overridden) requireProcedure(record.overridden);
            /* Preliminary procedure headers alias their final prototypes. Only
               the canonical procedure owns the committed vtable relationship. */
            if (canonical(record.id) === record.id) methods.set(record.id, { ...record, overridden: record.overridden ? canonical(record.overridden) : 0 });
        }
        if (protocolVersion >= 6) {
            for (const symbol of symbols.values()) {
                if (symbol.symbolClass === 3 && !dispatch.has(symbol.id)) throw new Error("Compiler procedure has no dispatch metadata.");
            }
        }
        const invalidDispatch = new Set();
        for (const method of methods.values()) {
            // FB_PROCATTRIB_VIRTUAL is bit 8 in symb.bi, including ABSTRACT.
            const virtual = (symbols.get(method.id).procedureAttributes & 0x100) !== 0;
            if (method.slot === 1 || (virtual && method.slot < 2)) {
                if (!invalidLines.size) throw new Error("Compiler dispatch graph has an invalid virtual slot.");
                invalidDispatch.add(method.id);
            }
        }
        /* Failed declarations can leave a procedure record whose attributes
           say VIRTUAL even though the compiler rejected it before assigning a
           real slot. Keep other partial results, but withhold that method and
           every override whose ancestry now lacks authoritative dispatch. */
        let dispatchChanged = true;
        while (dispatchChanged) {
            dispatchChanged = false;
            for (const method of methods.values()) {
                if (method.overridden && invalidDispatch.has(method.overridden) && !invalidDispatch.has(method.id)) {
                    invalidDispatch.add(method.id);
                    dispatchChanged = true;
                }
            }
        }
        for (const id of invalidDispatch) methods.delete(id);
        for (const method of methods.values()) {
            if (method.overridden && (method.slot < 2 || methods.get(method.overridden)?.slot !== method.slot)) throw new Error("Compiler override does not preserve its base slot.");
        }
        const checked = new Set();
        for (const method of methods.values()) {
            const visited = new Set();
            let current = method.id;
            while (current && !checked.has(current)) {
                if (visited.has(current)) throw new Error("Cyclic compiler override relationships.");
                visited.add(current);
                current = methods.get(current)?.overridden || 0;
            }
            for (const id of visited) checked.add(id);
        }
        const bindings = new Map();
        for (const use of uses) {
            requireSymbol(use.id);
            const line = outputLines.get(use.outputLine);
            if (line === undefined) throw new Error("Compiler symbol use refers to a missing output line.");
            const bytes = Buffer.from(lines[line]);
            const mappedPosition = mapOutputBytePosition ? mapOutputBytePosition(line, use.byteColumn) : null;
            if (mapOutputBytePosition && !mappedPosition) throw new Error("Compiler symbol use has an invalid output position.");
            const prefix = mappedPosition ? null : bytes.subarray(0, use.byteColumn);
            const startColumn = mappedPosition ? mappedPosition.column : prefix.toString("utf8").length;
            if (use.byteColumn > bytes.length || use.byteColumn + Buffer.byteLength(use.name) > bytes.length) {
                /* Some QB suffix identifiers are consumed by the parser but
                   omitted from -pp output as contextual REM syntax. The
                   compiler identity remains useful for diagnostics, but an
                   occurrence without an emitted token cannot back navigation
                   or rename. Withhold that symbol from refactoring instead of
                   guessing at a nearby source spelling. */
                nonRenameable.add(use.id);
                continue;
            }
            if ((!mappedPosition && !Buffer.from(prefix.toString("utf8")).equals(prefix)) ||
                lines[line].slice(startColumn, startColumn + use.name.length).toLowerCase() !== use.name.toLowerCase()) {
                if (use.name.toLowerCase() === "rem") {
                    /* QB mode can consume the REM stem of a suffixed variable
                       before writing -pp text, leaving the parser's byte site
                       on the following assignment or assertion punctuation. */
                    nonRenameable.add(use.id);
                    continue;
                }
                throw new Error("Compiler symbol use does not match its output token.");
            }
            if (invalidLines.has(line)) continue;
            const id = canonical(use.id);
            const key = `${line}:${startColumn}:${use.kind}:${id}`;
            bindings.set(key, { ...use, originalId: use.id, id, line, startColumn, endColumn: startColumn + use.name.length });
        }
        return { symbols: [...symbols.values()], canonicalIds: [...canonicalIds], uses: [...bindings.values()], nonRenameable: [...nonRenameable].map(canonical), dispatch: [...methods.values()], invalidDispatch: [...invalidDispatch].map(canonical) };
    }

    return { read, finish };
}

module.exports = { createSymbolDecoder };

/* end of lib/compiler-symbols.js */
