/*
    Project: FreeBASIC VS Code Language Extension Tests
    -----------------------------------------------

    File: tests/compiler-flow-analysis.test.js

    Purpose:

        Protect conservative projections from FBC's procedure control-flow graph.

    Responsibilities:

        - verify opaque transfers suppress unreachable-code hints

    This file intentionally does NOT contain:

        - compiler execution
        - source parsing or VS Code objects
        - control-flow inference independent of FBC
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { compilerSemanticUnreachableStatements } = require("../lib/compiler-flow-analysis");

test("an opaque compiler control-flow transfer suppresses unreachable hints for its phase", () => {
    const filePath = "/workspace/flow.bas";
    const sidecar = {
        recovery: false,
        flowPhases: [{ id: 1, procedure: 100, name: "pre-load", emitted: true, module: 1 }],
        controlFlowBlocks: [
            { id: 10, phase: 1, ordinal: 0, module: 1 },
            { id: 11, phase: 1, ordinal: 1, module: 1 }
        ],
        controlFlowNodes: [
            { block: 10, node: 1 },
            { block: 11, node: 2 }
        ],
        controlFlowEdges: [{
            phase: 1, source: 10, target: 0, kind: "unknown-indirect", label: 0, module: 1
        }],
        controlFlowLabels: [],
        nodes: [
            { id: 1, parent: 100, edge: "root" },
            { id: 2, parent: 100, edge: "root" }
        ],
        statementOwners: [
            { domain: "node", subject: 1, statement: 200 },
            { domain: "node", subject: 2, statement: 201 }
        ],
        statements: [
            { id: 200, module: 1, owner: 100, source: 300, physical: true },
            { id: 201, module: 1, owner: 100, source: 300, physical: true }
        ],
        statementEndings: [
            { id: 200, route: "intrinsic", outcome: "parsed", physical: true },
            { id: 201, route: "call-or-assignment", outcome: "parsed", physical: true }
        ],
        physicalLocations: [{
            domain: "statement", subject: 201, role: "opening-token", source: 300,
            startLine: 2, startColumn: 4, endLine: 2, endColumn: 9, status: "mapped"
        }],
        sourceContexts: [{ id: 300, module: 1, file: 400 }],
        sourceFiles: [{ id: 400, kind: "regular", filePath }]
    };

    assert.deepEqual(compilerSemanticUnreachableStatements(sidecar, "/workspace"), []);
});

/* end of tests/compiler-flow-analysis.test.js */
