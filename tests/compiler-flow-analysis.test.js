/*
    Project: FreeBASIC VS Code Language Extension Tests
    -----------------------------------------------

    File: tests/compiler-flow-analysis.test.js

    Purpose:

        Protect conservative projections from FBC's procedure control-flow graph.

    Responsibilities:

        - verify opaque transfers suppress unreachable-code hints
        - require original compiler predicates and integer constants for IF hints

    This file intentionally does NOT contain:

        - compiler execution
        - source parsing or VS Code objects
        - control-flow inference independent of FBC
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { compilerSemanticIfConditionResults, compilerSemanticUnreachableStatements } = require("../lib/compiler-flow-analysis");

test("constant IF conditions require matching compiler predicate, value, and source ownership", () => {
    const fixture = () => ({ recovery: false,
        capabilities: [{ module: 1, feature: "if-condition-inputs", coverage: "available" }],
        properties: [{ module: 1, domain: "symbol", identity: 10, name: "if-condition-expression:20", value: "30" }],
        relationships: [{ module: 1, sourceDomain: "symbol", source: 10, targetDomain: "expression", target: 30,
            kind: "if-condition", ordinal: 20 }],
        statements: [{ id: 20, module: 1, owner: 10, source: 40, physical: true }],
        statementEndings: [{ id: 20, outcome: "parsed", route: "compound" }],
        statementOwners: [{ domain: "expression", subject: 30, statement: 20 }],
        expressions: [{ id: 30, physical: true, filePath: "/workspace/conditions.bas", startLine: 2,
            startColumn: 3, endLine: 2, endColumn: 4 }],
        constantValues: [{ module: 1, domain: "expression", identity: 30, kind: "signed", value: "0" }],
        sourceContexts: [{ id: 40, module: 1, file: 50 }],
        sourceFiles: [{ id: 50, kind: "regular", filePath: "/workspace/conditions.bas" }]
    });
    const expected = { filePath: "/workspace/conditions.bas", startLine: 2, startColumn: 3,
        endLine: 2, endColumn: 4, result: false };
    assert.deepEqual(compilerSemanticIfConditionResults(fixture(), "/workspace"), [expected]);
    const nonzero = fixture();
    nonzero.constantValues[0] = { ...nonzero.constantValues[0], kind: "unsigned", value: "18446744073709551615" };
    assert.deepEqual(compilerSemanticIfConditionResults(nonzero, "/workspace"), [{ ...expected, result: true }]);
    for (const mutate of [
        (sidecar) => { sidecar.recovery = true; },
        (sidecar) => { sidecar.capabilities[0].coverage = "unavailable"; },
        (sidecar) => { sidecar.properties[0].provisional = true; },
        (sidecar) => { sidecar.properties.push({ ...sidecar.properties[0] }); },
        (sidecar) => { sidecar.properties[0].value = "9007199254740992"; },
        (sidecar) => { sidecar.relationships = []; },
        (sidecar) => { sidecar.statementOwners[0].statement = 99; },
        (sidecar) => { sidecar.statementEndings[0].outcome = "recovered"; },
        (sidecar) => { sidecar.expressions[0].physical = false; },
        (sidecar) => { sidecar.expressions[0].sourceContextId = 99; },
        (sidecar) => { sidecar.expressions[0].filePath = "/workspace/other.bas"; },
        (sidecar) => { sidecar.constantValues[0].domain = "node"; },
        (sidecar) => { sidecar.constantValues[0].value = "18446744073709551616"; },
        (sidecar) => { sidecar.constantValues[0].provisional = true; },
        (sidecar) => { sidecar.constantValues[0].kind = "float64-bits"; sidecar.constantValues[0].value = "0x0000000000000000"; },
        (sidecar) => { sidecar.constantValues.push({ ...sidecar.constantValues[0], value: "1" }); }
    ]) {
        const sidecar = fixture();
        mutate(sidecar);
        assert.deepEqual(compilerSemanticIfConditionResults(sidecar, "/workspace"), []);
    }

    const repeated = fixture();
    repeated.capabilities.push({ module: 2, feature: "if-condition-inputs", coverage: "available" });
    repeated.properties.push({ module: 2, domain: "symbol", identity: 11, name: "if-condition-expression:21", value: "31" });
    repeated.relationships.push({ module: 2, sourceDomain: "symbol", source: 11, targetDomain: "expression",
        target: 31, kind: "if-condition", ordinal: 21 });
    repeated.statements.push({ id: 21, module: 2, owner: 11, source: 41, physical: true });
    repeated.statementEndings.push({ id: 21, outcome: "parsed", route: "compound" });
    repeated.statementOwners.push({ domain: "expression", subject: 31, statement: 21 });
    repeated.expressions.push({ ...repeated.expressions[0], id: 31 });
    repeated.sourceContexts.push({ id: 41, module: 2, file: 50 });
    assert.deepEqual(compilerSemanticIfConditionResults(repeated, "/workspace"), [],
        "a runtime predicate in another context withholds the constant hint");
    repeated.constantValues.push({ module: 2, domain: "expression", identity: 31, kind: "signed", value: "1" });
    assert.deepEqual(compilerSemanticIfConditionResults(repeated, "/workspace"), [],
        "different constant outcomes at the same physical site withhold the hint");
    repeated.constantValues[1].value = "0";
    assert.deepEqual(compilerSemanticIfConditionResults(repeated, "/workspace"), [expected]);
});

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
