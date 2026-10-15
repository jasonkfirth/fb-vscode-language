/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-flow-analysis.js

    Purpose:

        Project FBC's conservative procedure control-flow graph onto source
        statements that can safely receive unreachable-code hints.

    Responsibilities:

        - compute procedure reachability from compiler-exported edges
        - suppress phases with opaque or incomplete transfers
        - map unreachable roots only to parsed physical source statements

    This file intentionally does NOT contain:

        - a second FreeBASIC control-flow parser
        - source edits or VS Code API objects
        - assumptions about indirect or assembly jump targets
*/

const path = require("path");

/* Keep compiler graph projection bounded independently of decoder limits. */
const MAX_FLOW_PHASES = 5000;
const MAX_FLOW_BLOCKS = 100000;
const MAX_FLOW_EDGES = 200000;
const MAX_UNREACHABLE_STATEMENTS = 5000;

const LABEL_TRANSFER_KINDS = new Set([
    "label", "conditional-label", "case-label", "default-label", "subroutine-call"
]);
const EXECUTABLE_STATEMENT_ROUTES = new Set([
    "call-or-assignment", "compound", "intrinsic", "assembly", "pointer-or-assignment"
]);

function compilerPathKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compilerSemanticUnreachableStatements(sidecar, cwd) {
    if (!sidecar || sidecar.recovery || !Array.isArray(sidecar.flowPhases) ||
        !Array.isArray(sidecar.controlFlowBlocks) || !Array.isArray(sidecar.controlFlowNodes) ||
        !Array.isArray(sidecar.controlFlowEdges) || !Array.isArray(sidecar.controlFlowLabels) ||
        sidecar.flowPhases.length > MAX_FLOW_PHASES || sidecar.controlFlowBlocks.length > MAX_FLOW_BLOCKS ||
        sidecar.controlFlowNodes.length > MAX_FLOW_BLOCKS || sidecar.controlFlowEdges.length > MAX_FLOW_EDGES ||
        sidecar.controlFlowLabels.length > MAX_FLOW_EDGES) return [];

    const phases = new Map(sidecar.flowPhases.map((phase) => [phase.id, phase]));
    const blocksByPhase = new Map();
    const blocksById = new Map();
    for (const block of sidecar.controlFlowBlocks) {
        const phase = phases.get(block.phase);
        if (!phase || phase.module !== block.module || blocksById.has(block.id)) return [];
        const blocks = blocksByPhase.get(block.phase) || [];
        blocks.push(block);
        blocksByPhase.set(block.phase, blocks);
        blocksById.set(block.id, block);
    }

    const nodeByBlock = new Map(sidecar.controlFlowNodes.map((entry) => [entry.block, entry.node]));
    if (nodeByBlock.size !== sidecar.controlFlowNodes.length) return [];
    const rootNodeIds = new Set(nodeByBlock.values());
    const nodes = new Map((sidecar.nodes || [])
        .filter((node) => rootNodeIds.has(node.id))
        .map((node) => [node.id, node]));
    if (nodes.size !== rootNodeIds.size) return [];
    const statementByNode = new Map((sidecar.statementOwners || [])
        .filter((owner) => owner.domain === "node" && rootNodeIds.has(owner.subject))
        .map((owner) => [owner.subject, owner.statement]));
    const rootStatementIds = new Set(statementByNode.values());
    const statements = new Map((sidecar.statements || [])
        .filter((statement) => rootStatementIds.has(statement.id))
        .map((statement) => [statement.id, statement]));
    const endings = new Map((sidecar.statementEndings || [])
        .filter((ending) => rootStatementIds.has(ending.id))
        .map((ending) => [ending.id, ending]));
    const openingLocations = new Map((sidecar.physicalLocations || [])
        .filter((location) => location.domain === "statement" && location.role === "opening-token" &&
            rootStatementIds.has(location.subject))
        .map((location) => [location.subject, location]));
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((file) => [file.id, file]));
    const labels = new Map();
    for (const label of sidecar.controlFlowLabels) {
        const key = `${label.phase}:${label.label}`;
        if (!blocksById.has(label.block) || labels.has(key)) return [];
        labels.set(key, label.block);
    }

    const edgesBySource = new Map();
    for (const edge of sidecar.controlFlowEdges) {
        if (!blocksById.has(edge.source) || blocksById.get(edge.source).phase !== edge.phase) return [];
        const key = `${edge.phase}:${edge.source}`;
        const edges = edgesBySource.get(key) || [];
        edges.push(edge);
        edgesBySource.set(key, edges);
    }

    const physicalStatementFor = (phase, block) => {
        const nodeId = nodeByBlock.get(block.id);
        const node = nodeId && nodes.get(nodeId);
        const statementId = nodeId && statementByNode.get(nodeId);
        const statement = statementId && statements.get(statementId);
        const ending = statementId && endings.get(statementId);
        const location = statementId && openingLocations.get(statementId);
        const context = location && sourceContexts.get(location.source);
        const file = context && sourceFiles.get(context.file);
        if (!node || node.edge !== "root" || node.parent !== phase.procedure || !statement || !ending ||
            !EXECUTABLE_STATEMENT_ROUTES.has(ending.route) || ending.outcome !== "parsed" ||
            statement.module !== phase.module || statement.owner !== phase.procedure || statement.physical !== true ||
            ending.physical !== true || !location || location.status !== "mapped" || !context ||
            context.module !== phase.module || location.source !== statement.source || !file || file.kind !== "regular" ||
            typeof file.filePath !== "string" || !file.filePath ||
            !Number.isSafeInteger(location.startLine) || location.startLine < 1 ||
            !Number.isSafeInteger(location.startColumn) || location.startColumn < 0 ||
            !Number.isSafeInteger(location.endLine) || location.endLine !== location.startLine ||
            !Number.isSafeInteger(location.endColumn) || location.endColumn <= location.startColumn) return null;

        return {
            filePath: compilerPathKey(path.isAbsolute(file.filePath) ? file.filePath : path.resolve(cwd, file.filePath)),
            startLine: location.startLine,
            startColumn: location.startColumn,
            endLine: location.endLine,
            endColumn: location.endColumn
        };
    };

    const observations = new Map();
    const observe = (physical, outcome) => {
        if (!physical) return;
        const key = `${physical.filePath}:${physical.startLine}:${physical.startColumn}:${physical.endLine}:${physical.endColumn}`;
        const group = observations.get(key) || { ...physical, outcomes: new Set() };
        group.outcomes.add(outcome);
        observations.set(key, group);
    };

    for (const phase of sidecar.flowPhases) {
        if (phase.name !== "pre-load" || phase.emitted !== true) continue;
        const blocks = (blocksByPhase.get(phase.id) || []).sort((first, second) => first.ordinal - second.ordinal);
        if (!blocks.length || blocks[0].ordinal !== 0 ||
            blocks.some((block, index) => block.ordinal !== index)) continue;

        const reachable = new Set();
        const pending = [blocks[0].id];
        let opaque = false;
        while (pending.length) {
            const sourceId = pending.pop();
            if (reachable.has(sourceId)) continue;
            reachable.add(sourceId);
            const edges = edgesBySource.get(`${phase.id}:${sourceId}`) || [];
            if (!edges.length) {
                opaque = true;
                break;
            }
            for (const edge of edges) {
                if (edge.kind === "fallthrough") {
                    pending.push(edge.target);
                } else if (LABEL_TRANSFER_KINDS.has(edge.kind)) {
                    if (!edge.label) {
                        opaque = true;
                        break;
                    }
                    const target = labels.get(`${phase.id}:${edge.label}`);
                    if (!target) {
                        opaque = true;
                        break;
                    }
                    pending.push(target);
                    if (edge.kind === "subroutine-call") {
                        const sourceBlock = blocksById.get(sourceId);
                        const continuation = blocks[sourceBlock.ordinal + 1];
                        if (continuation) pending.push(continuation.id);
                    }
                } else if (edge.kind === "unknown-indirect" || edge.kind === "unknown-assembly") {
                    opaque = true;
                    break;
                } else if (edge.kind !== "subroutine-return" && edge.kind !== "procedure-exit") {
                    opaque = true;
                    break;
                }
            }
            if (opaque) break;
        }

        for (const block of blocks) {
            observe(physicalStatementFor(phase, block), opaque
                ? "unknown"
                : reachable.has(block.id) ? "reachable" : "unreachable");
        }
    }

    const records = [];
    for (const observation of observations.values()) {
        if (observation.outcomes.size !== 1 || !observation.outcomes.has("unreachable")) continue;
        records.push({
            filePath: observation.filePath,
            startLine: observation.startLine,
            startColumn: observation.startColumn,
            endLine: observation.endLine,
            endColumn: observation.endColumn
        });
        if (records.length > MAX_UNREACHABLE_STATEMENTS) return [];
    }

    return records.sort((first, second) => first.filePath.localeCompare(second.filePath) ||
        first.startLine - second.startLine || first.startColumn - second.startColumn);
}

module.exports = { compilerSemanticUnreachableStatements };

/* end of lib/compiler-flow-analysis.js */
