/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-macros.js
    Purpose: Decode native replacement-text maps and recover physical spans.
    Responsibilities: validate map edges and distinguish copied/constructed text.
    Does not contain: preprocessor evaluation or spelling-based symbol lookup.
*/

const KINDS = [null, "unknown", "source", "concat", "slice", "argument", "definition", "stringify", "callback"];
const MAX_MAPS = 200000;
const MAX_LENGTH = 32 * 1024 * 1024;

function createMacroDecoder(integer) {
    const nodes = new Map();
    return {
        read(line) {
            const match = line.match(/^''@fb-editor-map (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/i);
            if (!match) return false;
            const [id, kind, length, first, second, offset, sourceStart, sourceEnd, target, parameter] = match.slice(1, 11).map((value) => integer(value));
            // IDs come from a bounded million-node native arena; only reachable
            // maps are exported, capped separately from temporary AVL updates.
            if (nodes.size >= MAX_MAPS) throw new Error("Compiler macro map records exceeded 200000 entries.");
            if (!id || id > 1000000 || nodes.has(id) || !KINDS[kind] || !length || length > MAX_LENGTH || first >= id || second >= id) throw new Error("Invalid compiler macro map identity, kind, length, or edge.");
            nodes.set(id, { id, kind: KINDS[kind], length, first, second, offset, sourceStart, sourceEnd, target, parameter, fileId: integer(match[11]), filePath: null });
            return true;
        },
        finish(dependencies, symbols, tokens, fileIdentities) {
            const symbolClasses = new Map(symbols.symbols.map((symbol) => [symbol.id, symbol.symbolClass]));
            for (const node of nodes.values()) {
                if (node.fileId) node.filePath = fileIdentities.get(node.fileId);
                const first = nodes.get(node.first), second = nodes.get(node.second);
                if (node.first && !first || node.second && !second) throw new Error("Compiler macro map refers to a missing input.");
                // FB_SYMBCLASS_DEFINE is 5 in the source compiler's symb.bi.
                if (node.target && symbolClasses.get(node.target) !== 5) throw new Error("Compiler macro map target is not a native macro.");
                if (node.kind === "source") {
                    if (!dependencies.has(node.filePath) || node.sourceEnd <= node.sourceStart || node.sourceEnd > MAX_LENGTH) throw new Error("Invalid compiler macro physical source range.");
                } else if (node.sourceStart || node.sourceEnd || node.fileId) throw new Error("Non-source macro map has physical coordinates.");
                if (node.kind === "concat" && (!first || !second || node.length !== first.length + second.length)) throw new Error("Invalid compiler macro concatenation length.");
                if (node.kind === "slice" && (!first || second || node.offset + node.length > first.length)) throw new Error("Invalid compiler macro slice range.");
                if (["unknown", "source"].includes(node.kind) && (first || second)) throw new Error("A macro source leaf has child maps.");
                if (node.kind !== "slice" && node.offset) throw new Error("Only a macro slice may have an offset.");
                if (["unknown", "source", "concat", "slice"].includes(node.kind) && (node.target || node.parameter)) throw new Error("A macro map without an expansion has expansion metadata.");
                if (["argument", "definition", "stringify", "callback"].includes(node.kind) && !node.target) throw new Error("A compiler macro expansion has no native target.");
                if (!["argument", "stringify"].includes(node.kind) && node.parameter) throw new Error("Non-argument macro map has a parameter ordinal.");
                // FB_MAXDEFINEARGS in fb.bi is 32, with zero-based ordinals.
                if (node.parameter >= 32) throw new Error("Macro parameter ordinal exceeded its bound.");
            }
            for (const token of tokens) if (token.sourceMap && !nodes.has(token.sourceMap)) throw new Error("Compiler token refers to a missing macro map.");
            return { nodes: [...nodes.values()] };
        }
    };
}

function createMacroProjector(graph, includeRole = false) {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const cache = new Map();
    return (identity) => {
        if (!identity) return null;
        if (cache.has(identity)) return cache.get(identity);
        const root = nodes.get(identity);
        if (!root) throw new Error("Compiler macro projection refers to a missing map.");
        const pending = [{ id: identity, start: 0, end: root.length, role: "" }];
        let physical = null, visits = 0;
        while (pending.length) {
            // Native map IDs are acyclic; a visit bound also covers very large
            // DAG fan-out without expanding shared text exponentially here.
            if (++visits > MAX_MAPS) throw new Error("Macro source projection exceeded its traversal limit.");
            const part = pending.pop(), node = nodes.get(part.id);
            if (node.kind === "source") {
                const affine = node.length === node.sourceEnd - node.sourceStart;
                if (!affine && (part.start || part.end !== node.length)) { physical = null; break; }
                const sourceStart = node.sourceStart + (affine ? part.start : 0);
                const sourceEnd = affine ? node.sourceStart + part.end : node.sourceEnd;
                if (!physical) physical = { filePath: node.filePath, sourceStart, sourceEnd,
                    ...(includeRole ? { role: part.role } : {}) };
                else if (physical.filePath === node.filePath && physical.sourceEnd === sourceStart) {
                    physical.sourceEnd = sourceEnd;
                    if (includeRole && physical.role !== part.role) physical.role = "mixed";
                }
                else { physical = null; break; }
            } else if (node.kind === "slice") pending.push({ id: node.first, start: node.offset + part.start, end: node.offset + part.end, role: part.role });
            else if (node.kind === "concat") {
                const length = nodes.get(node.first).length;
                if (part.end > length) pending.push({ id: node.second, start: Math.max(0, part.start - length), end: part.end - length, role: part.role });
                if (part.start < length) pending.push({ id: node.first, start: part.start, end: Math.min(part.end, length), role: part.role });
            } else if (["argument", "definition"].includes(node.kind) && node.first && nodes.get(node.first).length === node.length) {
                // The innermost wrapper owns the physical source text. A
                // macro expanded inside an argument still has definition text.
                pending.push({ id: node.first, start: part.start, end: part.end, role: node.kind });
            }
            else { physical = null; break; }
        }
        cache.set(identity, physical);
        return physical;
    };
}

/* A generated identifier may still have one editable argument within fixed
   replacement text, as in `prefix##Label`. Keep the output coordinates beside
   each physical piece so refactoring can edit only that argument when the
   compiler proves the complete expansion graph. */
function createMacroPartProjector(graph) {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const cache = new Map();
    return (identity) => {
        if (!identity) return null;
        if (cache.has(identity)) return cache.get(identity);
        const root = nodes.get(identity);
        if (!root) throw new Error("Compiler macro projection refers to a missing map.");
        const pending = [{ id: identity, start: 0, end: root.length, outputBase: 0, role: "" }];
        const parts = [];
        let visits = 0, sawConcat = false, valid = true;
        while (pending.length) {
            if (++visits > MAX_MAPS) throw new Error("Macro source projection exceeded its traversal limit.");
            const part = pending.pop(), node = nodes.get(part.id);
            if (!node || part.start < 0 || part.end > node.length || part.end <= part.start) { valid = false; break; }
            if (node.kind === "source") {
                if (!node.filePath || node.length !== node.sourceEnd - node.sourceStart) { valid = false; break; }
                parts.push({
                    outputStart: part.outputBase + part.start,
                    outputEnd: part.outputBase + part.end,
                    filePath: node.filePath,
                    sourceStart: node.sourceStart + part.start,
                    sourceEnd: node.sourceStart + part.end,
                    role: part.role || "definition"
                });
            } else if (node.kind === "slice") {
                pending.push({ id: node.first, start: node.offset + part.start, end: node.offset + part.end, outputBase: part.outputBase - node.offset, role: part.role });
            } else if (node.kind === "concat") {
                sawConcat = true;
                const firstLength = nodes.get(node.first)?.length;
                if (firstLength === undefined) { valid = false; break; }
                if (part.end > firstLength) pending.push({ id: node.second, start: Math.max(0, part.start - firstLength), end: part.end - firstLength, outputBase: part.outputBase + firstLength, role: part.role });
                if (part.start < firstLength) pending.push({ id: node.first, start: part.start, end: Math.min(part.end, firstLength), outputBase: part.outputBase, role: part.role });
            } else if (["argument", "definition"].includes(node.kind) && node.first && nodes.get(node.first)?.length === node.length) {
                const role = node.kind === "argument" ? "argument" : part.role || "definition";
                pending.push({ id: node.first, start: part.start, end: part.end, outputBase: part.outputBase, role });
            } else {
                valid = false;
                break;
            }
        }
        parts.sort((left, right) => left.outputStart - right.outputStart || left.outputEnd - right.outputEnd);
        let end = 0;
        for (const part of parts) {
            if (part.outputStart !== end) { valid = false; break; }
            end = part.outputEnd;
        }
        const result = valid && sawConcat && end === root.length && parts.length > 1 ? parts : null;
        cache.set(identity, result);
        return result;
    };
}

/* ------------------------------------------------------------------------- */
/* Refactoring map geometry                                                  */
/* ------------------------------------------------------------------------- */

function macroGraphSignature(graph = { nodes: [] }, physical = new Map()) {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const lengths = new Map([[0, 0]]), offsets = new Map();
    const unchanged = (position) => position;
    function mappedOffset(identity, position) {
        const key = (id, point) => `${id}:${point}`;
        const pending = [{ id: identity, point: position }];
        while (pending.length) {
            if (offsets.size > 1000000) throw new Error("Macro rename exceeded its coordinate-validation limit.");
            const request = pending.at(-1), node = nodes.get(request.id), point = request.point;
            const requestKey = key(request.id, point);
            if (offsets.has(requestKey)) { pending.pop(); continue; }
            if (point < 0 || point > node.length) throw new Error("Macro rename has an invalid input coordinate.");
            let value;
            if (point === 0) value = 0;
            else if (point === node.length && lengths.has(node.id)) value = lengths.get(node.id);
            else if (node.kind === "source") {
                const adjust = physical.get(node.filePath) || unchanged;
                if (node.length !== node.sourceEnd - node.sourceStart) {
                    if (adjust(node.sourceEnd) - adjust(node.sourceStart) !== node.sourceEnd - node.sourceStart) throw new Error("Rename intersects a non-affine macro literal.");
                    value = point;
                } else value = (adjust.boundary || adjust)(node.sourceStart + point) - adjust(node.sourceStart);
            } else {
                let first, second, extra = 0;
                if (node.kind === "slice") {
                    first = { id: node.first, point: node.offset + point };
                    second = { id: node.first, point: node.offset };
                } else if (node.kind === "concat") {
                    const length = nodes.get(node.first).length;
                    if (point <= length) first = { id: node.first, point };
                    else { first = { id: node.second, point: point - length }; extra = lengths.get(node.first); }
                } else if (["argument", "definition"].includes(node.kind) && node.first && nodes.get(node.first).length === node.length) first = { id: node.first, point };
                else value = point;
                if (first) {
                    if (!offsets.has(key(first.id, first.point))) { pending.push(first); continue; }
                    if (second && !offsets.has(key(second.id, second.point))) { pending.push(second); continue; }
                    value = offsets.get(key(first.id, first.point)) + extra - (second ? offsets.get(key(second.id, second.point)) : 0);
                }
            }
            offsets.set(requestKey, value);
            pending.pop();
        }
        return offsets.get(key(identity, position));
    }
    return [...nodes.values()].sort((a, b) => a.id - b.id).map((node) => {
        const adjust = physical.get(node.filePath) || unchanged;
        let length = node.length, offset = node.offset;
        if (node.kind === "source") length += adjust(node.sourceEnd) - adjust(node.sourceStart) - (node.sourceEnd - node.sourceStart);
        else if (node.kind === "concat") length = lengths.get(node.first) + lengths.get(node.second);
        else if (node.kind === "slice") {
            offset = mappedOffset(node.first, node.offset);
            length = mappedOffset(node.first, node.offset + node.length) - offset;
        } else if (["argument", "definition"].includes(node.kind) && node.first && nodes.get(node.first).length === node.length) length = lengths.get(node.first);
        lengths.set(node.id, length);
        return [node.id, node.kind, length, node.first, node.second, offset, adjust(node.sourceStart), adjust(node.sourceEnd), node.target, node.parameter, node.filePath];
    });
}

module.exports = { createMacroDecoder, createMacroProjector, createMacroPartProjector, macroGraphSignature };

/* end of lib/compiler-macros.js */
