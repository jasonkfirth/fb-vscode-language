/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-expressions.js
    Purpose: Decode source expressions and their native transformation edges.
    Responsibilities: bound graph work, validate source/type links, propagate taint.
    Does not contain: type inference, compiler execution, or editor presentation.
*/

const MAX_EXPRESSION_NODES = 200000;
const { createHash } = require("crypto");

function createExpressionDecoder(decodeHex, integer) {
    const nodes = [];
    let familyRecords = 0;
    function read(line) {
        const family = line.match(/^''@fb-editor-expression-family (\d+) ([a-f\d]+)$/i);
        if (family) {
            const id = integer(family[1], 1);
            const node = nodes[id - 1];
            const value = decodeHex(family[2], "expression parser family");
            if (!node) throw new Error("Compiler expression family refers to a missing expression.");
            if (++familyRecords > MAX_EXPRESSION_NODES) throw new Error("Compiler expression family records exceeded 200000.");
            const families = node.families || (node.families = []);
            if (families.includes(value)) throw new Error("Compiler expression family is duplicated for one expression.");
            families.push(value);
            if (!node.family) node.family = value;
            return true;
        }
        const match = line.match(/^''@fb-editor-expression (\d+) (syntax|conversion|call|binary|unary|conditional|argument|index) (\d+) (\d+) (\d+) (\d+) (-?\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (-?\d+) ([a-f\d]+)$/i);
        if (!match) return false;
        if (nodes.length >= MAX_EXPRESSION_NODES) throw new Error("Compiler expression graph exceeded 200000 nodes.");
        const id = integer(match[1], 1);
        if (id !== nodes.length + 1) throw new Error("Compiler expression identities are not contiguous.");
        const inputs = match.slice(9, 12).map((value) => integer(value));
        // IDs are committed after their operands, even when fbc reuses an AST
        // allocation. This proves acyclicity without recursive graph walking.
        if (inputs.some((input) => input >= id)) throw new Error("Compiler expression graph has a missing or cyclic input.");
        nodes.push({ id, kind: match[2].toLowerCase(), startSerial: integer(match[3], 1), startByte: integer(match[4]), endSerial: integer(match[5], 1), endByte: integer(match[6]), dtype: integer(match[7], -2147483648), subtype: integer(match[8]), inputs, target: integer(match[12]), options: integer(match[13], -2147483648), typeName: decodeHex(match[14], "expression graph type") });
        return true;
    }
    function finish(position, intersectsInvalid, symbolGraph, recoverySymbols = new Set()) {
        const symbols = new Map(symbolGraph.symbols.map((symbol) => [symbol.id, symbol]));
        const canonical = new Map(symbolGraph.canonicalIds);
        const recovered = (id) => id && recoverySymbols.has(canonical.get(id) || id);
        for (const node of nodes) {
            if (node.subtype && !symbols.has(node.subtype)) throw new Error("Compiler expression graph refers to a missing type.");
            if (node.target && symbols.get(node.target)?.symbolClass !== 3) throw new Error("Compiler expression graph target is not a procedure.");
            if (node.kind !== "call" && node.target) throw new Error("Only a compiler call expression can select a target.");
            if (node.kind === "conversion" && !node.inputs[0]) throw new Error("Compiler conversion has no source expression.");
            if (["binary", "unary", "conditional", "argument", "index"].includes(node.kind) && !node.inputs.some(Boolean)) throw new Error("Compiler operation has no source dependency.");
            if (node.kind === "argument" && (node.options < 1 || node.inputs[0] && nodes[node.inputs[0] - 1].kind !== "argument")) throw new Error("Invalid compiler argument chain.");
            node.start = position(node.startSerial, node.startByte);
            node.end = position(node.endSerial, node.endByte);
            if (node.end.line < node.start.line || node.end.line === node.start.line && node.end.character <= node.start.character) throw new Error("Invalid compiler expression graph range.");
            /* Argument chains have no written span of their own. Their bounds
               can stretch from a default's declaration to a distant call site;
               an unrelated error between those inputs must not poison the call.
               Successful astNewARG commits depend on the input nodes instead. */
            node.invalid = (node.kind !== "argument" && intersectsInvalid(node)) || node.inputs.some((input) => input && nodes[input - 1].invalid);
            /* An expression can be outside the failed source range yet depend
               on a declaration the parser retracted. Preserve its range so
               hover remains useful, but identify that type as provisional. */
            node.provisional = node.invalid || recovered(node.subtype) || recovered(node.target) || node.inputs.some((input) => input && nodes[input - 1].provisional);
        }
        return { nodes };
    }
    return { read, finish };
}

function expressionGraphSignature(analysis, renamedIds = new Set(), newName = "", structuralNumericLabel = false, structuralScopePlan = null, additionalUses = []) {
    const needsNumericLabelColon = (use) => structuralNumericLabel instanceof Set
        ? structuralNumericLabel.has(`${use.outputLine}:${use.byteColumn}`)
        : structuralNumericLabel && use.kind === "declaration";
    const changes = new Map();
    const uses = [...analysis.symbolGraph.uses, ...additionalUses];
    for (const use of uses) {
        if (use.id !== undefined && !renamedIds.has(use.id)) continue;
        const line = changes.get(use.outputLine) || new Map();
        const replacement = needsNumericLabelColon(use) ? `${newName}:` : newName;
        const end = use.endByte ?? use.byteColumn + Buffer.byteLength(use.name);
        const delta = Buffer.byteLength(replacement) - Buffer.byteLength(use.name);
        const prior = line.get(use.byteColumn);
        if (prior && (prior.end !== end || prior.delta !== delta)) throw new Error("Conflicting compiler-verified rename spans overlap.");
        line.set(use.byteColumn, { start: use.byteColumn, end, delta });
        changes.set(use.outputLine, line);
    }
    const shifts = new Map();
    for (const [line, changesByColumn] of changes) {
        let total = 0;
        shifts.set(line, [...changesByColumn.values()].sort((left, right) => left.end - right.end).map((change) => ({ ...change, total: total += change.delta })));
    }
    function shifted(serial, byte) {
        const line = shifts.get(serial) || [];
        let low = 0, high = line.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (line[middle].end <= byte) low = middle + 1;
            else high = middle;
        }
        if (line[low]?.start < byte) throw new Error("Compiler expression boundary cuts through a renamed identifier.");
        return byte + (low ? line[low - 1].total : 0);
    }
    /* Resolving an overload parses arguments before lowering its receiver;
       a fixed target may lower that receiver first. A rename can legitimately
       switch these paths without changing the semantic DAG. Hash source-anchored
       nodes and their ordered inputs, then compare multisets, not allocation
       order. Fixed-size digests avoid exponential strings for shared subgraphs. */
    const digests = ["0"];
    const symbol = (identity) => {
        if (!identity || !structuralScopePlan?.remap) return identity;
        let result = identity;
        for (const threshold of structuralScopePlan.symbolThresholds) if (identity >= threshold) result++;
        return result;
    };
    for (const node of analysis.expressionGraph.nodes) {
        const shape = [node.kind, node.startSerial, shifted(node.startSerial, node.startByte), node.endSerial, shifted(node.endSerial, node.endByte), node.dtype, symbol(node.subtype), symbol(node.target), node.options, node.inputs.map((id) => digests[id])];
        digests[node.id] = createHash("sha256").update(JSON.stringify(shape)).digest("hex");
    }
    return digests.slice(1).sort();
}

module.exports = { createExpressionDecoder, expressionGraphSignature };

/* end of compiler-expressions.js */
