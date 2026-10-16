/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/compiler-semantic-sidecar.test.js
    Purpose: Validate compiler-owned semantic sidecar schemas and source ranges.
    Responsibilities: protect schema migration, expression ranges, and safety flags.
    Does not contain: sidecar production or editor feature policy.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readCompilerSemanticRows } = require("../lib/compiler-semantic-transport");
const { MAX_IMPLICIT_CALL_SIGNATURE_BYTES, compilerScalarPrimitiveDtype, decodeCompilerSemanticModel, decodeCompilerSemanticExpressions } = require("../lib/compiler-semantic-sidecar");
const { analyzeSavedModule, compilerSemanticDependencies, decodeCompilerSourceBuffer, decodePreprocessed } = require("../lib/compiler-analysis");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");
const {
    compilerDiagnosticGuidance,
    compilerIgnoredDeclarationSuffixRange,
    compilerMissingClosingQuoteRange,
    compilerMeaninglessNextVariableRange,
    compilerPossibleEscapeStringRange,
    compilerRedundantNewAnyInitializerRange
} = require("../lib/compiler-diagnostic-sidecar");
const { findBracketProblems } = require("../lib/bracket-diagnostics");
const { maskFreeBasicText, parseFreeBasicText } = require("../lib/freebasic-parser");
const { queryCompilerModel } = require("../lib/compiler-model-queries");
const {
    semanticProjectBindings,
    semanticProjectImplicitCalls,
    semanticProjectUnanchoredImplicitCalls
} = require("../lib/compiler-project-transaction");
const { resolveFreeBasicRoot } = require("../tools/audit-freebasic-coverage");
const { measureSemanticSidecarCoverage, measureRecoverySemanticSidecarCoverage, measureSemanticBindingCoverage } = require("../tools/audit-native-corpus");

const header3 = "FBCSEM\t3\t1.20.4";
const expression = "E\t1\t1\t/main.bas\t2\t4\t2\t9\t2\t0\t8\t0\t0";
const header4 = "FBCSEM\t4\t1.20.4";
const header5 = "FBCSEM\t5\t1.20.4";
const header6 = "FBCSEM\t6\t1.20.4";
const header7 = "FBCSEM\t7\t1.20.4";
const header8 = "FBCSEM\t8\t1.20.4";
const header9 = "FBCSEM\t9\t1.20.4";
const header10 = "FBCSEM\t10\t1.20.4";
const header11 = "FBCSEM\t11\t1.20.4";
const header12 = "FBCSEM\t12\t1.20.4";
const header13 = "FBCSEM\t13\t1.20.4";
const header14 = "FBCSEM\t14\t1.20.4";
const header15 = "FBCSEM\t15\t1.20.4";
const header16 = "FBCSEM\t16\t1.20.4";
const header17 = "FBCSEM\t17\t1.20.4";
const header18 = "FBCSEM\t18\t1.20.4";
const expression4 = `${expression}\tinteger`;
const expression8 = "E\t1\t1\t/main.bas\t2\t4\t2\t9\t2\t37\tmultiply\tbuiltin\t8\t0\t0\tinteger";
const expression9 = "E\t1\t1\t/main.bas\t2\t4\t2\t32\t9\t0\tidentity-test\tbuiltin\t11\t0\t0\tlong";
const header20 = "FBCSEM\t20\t1.20.4-3";
const header21 = "FBCSEM\t21\t1.20.4-3";
const header23 = "FBCSEM\t23\t1.20.4";
const header25 = "FBCSEM\t25\t1.20.4";
const header27 = "FBCSEM\t27\t1.20.4";
const supportsIntelInlineAssembly = ["ia32", "x64"].includes(process.arch);

/* Mutation tests inspect logical rows after the production binary reader has
   validated framing. Runtime consumers retain only one decoded row at a time. */
function semanticModelTestText(filePath) {
    return [...readCompilerSemanticRows(fs.readFileSync(filePath), {
        maxBytes: 64 * 1024 * 1024, maxRecords: 6_100_002
    })].join("\n");
}

function schema20Sidecar({ expressionOnly = false, filePath = "/main.bas" } = {}) {
    const sourceDetails = [
        `FILE\t1\t${filePath}\t3\t${"a".repeat(64)}\tunmarked-bytes\tregular`,
        `SRC\t1\t0\t1\t1\tmodule\t0\t\t0\t\t0\t0\t0\t0`,
        `ORIG\texpression\t1\t1`,
        "SRE\t1\tverified"
    ];
    const targetDetails = expressionOnly ? [] : [
        `Q\t${filePath}\tlinux\tx86_64\tgnu\tlinux-x86_64\t8\tlittle\t4\t0`,
        "Y\t8\tinteger\tinteger\t4\t4\t1",
        "C\texpression\t1\tunsigned\t18446744073709551615"
    ];
    return [
        header20,
        `M\t${filePath}`,
        `D\t${filePath}`,
        ...targetDetails,
        ...sourceDetails.slice(0, 2),
        `E\t1\t1\t${filePath}\t1\t0\t1\t3\t2\t37\tmultiply\tbuiltin\t8\t0\t0\tinteger`,
        sourceDetails[2],
        sourceDetails[3],
        `END\t20\t1\t0\t0\t0\t0\t1\t0\t0\t1\t1\t${sourceDetails.length + targetDetails.length}`
    ].join("\n");
}

function schema21ConditionalSidecar() {
    const filePath = "/main.bas";
    const sourceDetails = [
        `FILE\t1\t${filePath}\t87\t${"b".repeat(64)}\tunmarked-bytes\tregular`,
        `SRC\t1\t0\t1\t1\tmodule\t0\t${filePath}\t0\t\t0\t0\t0\t0`,
        "PPB\t10\t0\t10\t1\t0\t0\tif\t1\t/main.bas\t1\t0\t1\t5",
        "PPD\t10\tevaluated\t1\t1\t1\t/main.bas\t1\t4\t1\t5",
        "PPB\t11\t0\t10\t1\t0\t1\telse\t1\t/main.bas\t2\t0\t2\t5",
        "PPD\t11\tunconditional\t\t0\t1\t/main.bas\t2\t0\t2\t5",
        "PPS\t12\t11\t1\t1\t/main.bas\t3\t0\t3\t5",
        "PPT\t13\t10\t1\t0\tFLAG\t1\t1\t/main.bas\t1\t7\t1\t11",
        "PPE\t10\t1\t1\t/main.bas\t4\t0\t4\t6",
        "SRE\t1\tverified"
    ];
    return [
        header21,
        `M\t${filePath}`,
        `D\t${filePath}`,
        ...sourceDetails.slice(0, 2),
        "E\t1\t1\t/main.bas\t5\t6\t5\t13\t2\t37\tmultiply\tbuiltin\t8\t0\t0\tinteger",
        ...sourceDetails.slice(2),
        "END\t21\t1\t0\t0\t0\t0\t1\t0\t0\t1\t1\t10"
    ].join("\n");
}

function schema23LocationSidecar() {
    const rows = schema20Sidecar({ expressionOnly: true }).split("\n");
    rows[0] = header23;
    const expressionIndex = rows.findIndex((row) => row.startsWith("E\t"));
    rows.splice(expressionIndex + 1, 0,
        "LOC\texpression\t1\trange\t1\t1\t0\t1\t3\t0\t3\tmapped",
        "MAP\t1\t10\tlogical.bas\t1\t/main.bas\t1\t0\t1\t3\t2",
        "LOC\tremap\t2\tdirective\t1\t1\t0\t1\t3\t0\t3\tmapped");
    const footer = rows.at(-1).split("\t");
    footer[1] = "23";
    footer[12] = "7";
    rows[rows.length - 1] = footer.join("\t");
    return rows.join("\n");
}

function schema25ConstructSidecar() {
    const rows = schema23LocationSidecar().split("\n");
    rows[0] = header25;
    const sourceIndex = rows.findIndex((row) => row.startsWith("SRC\t"));
    rows.splice(sourceIndex + 1, 0,
        "CAP\t1\tsource-constructs\tpartial",
        "ST\t1\t0\t0\t0\t1\t0\t1\t0\t0\t0\t1\t/main.bas\t1\t0\t1\t3",
        "BLK\t1\t0\t1\t0\tif\t1\t0\t1\t/main.bas\t1\t0\t1\t3");
    const expressionIndex = rows.findIndex((row) => row.startsWith("E\t"));
    rows.splice(expressionIndex + 1, 0, "OWN\texpression\t1\t1");
    const endingIndex = rows.findIndex((row) => row.startsWith("SRE\t"));
    rows.splice(endingIndex, 0,
        "BEND\t1\t1\t1\t/main.bas\t1\t0\t1\t3",
        "LOC\tconstruct\t1\trange\t1\t1\t0\t1\t3\t0\t3\tmapped",
        "STE\t1\tcompound\tparsed\t1\t/main.bas\t1\t0\t1\t3",
        "LOC\tstatement\t1\trange\t1\t1\t0\t1\t3\t0\t3\tmapped");
    const footer = rows.at(-1).split("\t");
    footer[1] = "25";
    footer[12] = "15";
    rows[rows.length - 1] = footer.join("\t");
    return rows.join("\n");
}

function encodeSemanticTestSource(text, format) {
    if (format === "utf8") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);

    if (format === "utf16le" || format === "utf16be") {
        const contents = Buffer.from(text, "utf16le");
        if (format === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), contents]);
        for (let index = 0; index < contents.length; index += 2) {
            [contents[index], contents[index + 1]] = [contents[index + 1], contents[index]];
        }
        return Buffer.concat([Buffer.from([0xfe, 0xff]), contents]);
    }

    const codepoints = Array.from(text, (character) => character.codePointAt(0));
    const contents = Buffer.alloc(codepoints.length * 4);
    for (let index = 0; index < codepoints.length; index++) {
        if (format === "utf32le") contents.writeUInt32LE(codepoints[index], index * 4);
        else contents.writeUInt32BE(codepoints[index], index * 4);
    }
    const bom = format === "utf32le" ? [0xff, 0xfe, 0x00, 0x00] : [0x00, 0x00, 0xfe, 0xff];
    return Buffer.concat([Buffer.from(bom), contents]);
}

test("numeric destination dtypes accept inspected scalar flags but not pointers or unknown producers", () => {
    assert.equal(compilerScalarPrimitiveDtype(8, "unknown"), 8);
    assert.equal(compilerScalarPrimitiveDtype(105, "unknown", new Map([[105, "integer"]])), 105,
        "a producer's explicit Y identifier must not be interpreted as FBC flags");
    assert.equal(compilerScalarPrimitiveDtype(8 | 0x200, "1.20.5-1"), 8);
    assert.equal(compilerScalarPrimitiveDtype(8 | 0x80000 | (8 << 20), "1.20.5"), 8);
    for (const dtype of [8 | 0x20, 8 | 0x400, 8 | 0x40000, 8 | 0x2000000, -1, 1.5]) {
        assert.equal(compilerScalarPrimitiveDtype(dtype, "1.20.5"), null, String(dtype));
    }
    assert.equal(compilerScalarPrimitiveDtype(8 | 0x200, "1.20.6"), null);
    assert.equal(compilerScalarPrimitiveDtype(8 | 0x200, "unknown"), null);
});

test("schema 3 decodes physical parser expression ranges", () => {
    const model = decodeCompilerSemanticModel([
        header3,
        "M\t/main.bas",
        expression,
        "END\t3\t1\t0\t0\t0\t0\t1"
    ].join("\n"));

    assert.equal(model.schemaVersion, 3);
    assert.equal(model.counts.expressionCount, 1);
    assert.deepEqual(model.expressions[0], {
        id: 1,
        physical: true,
        filePath: "/main.bas",
        startLine: 2,
        startColumn: 4,
        endLine: 2,
        endColumn: 9,
        astClass: 2,
        operator: 0,
        dtype: 8,
        symbol: 0,
        subtype: 0
    });
});

test("schema 4 carries compiler-formatted expression types", () => {
    const model = decodeCompilerSemanticModel([
        header4,
        "M\t/main.bas",
        expression4,
        "END\t4\t1\t0\t0\t0\t0\t1"
    ].join("\n"));

    assert.equal(model.schemaVersion, 4);
    assert.equal(model.expressions[0].typeName, "integer");
});

test("bounded editor reader validates totals and retains only selected physical expressions", () => {
    const model = decodeCompilerSemanticExpressions([
        header4,
        "M\t/main.bas",
        expression4,
        "E\t2\t0\t/main.bas\t2\t10\t2\t12\t2\t0\t8\t0\t0\tinteger",
        "END\t4\t1\t0\t0\t0\t0\t2"
    ].join("\n"), (fact) => fact.startColumn === 4);

    assert.equal(model.expressions.length, 1);
    assert.deepEqual(model.modules, ["/main.bas"]);
    assert.equal(model.expressions[0].typeName, "integer");
    assert.throws(() => decodeCompilerSemanticExpressions([
        header4,
        "M\t/main.bas",
        expression4,
        "END\t4\t1\t0\t0\t0\t0\t2"
    ].join("\n")), /footer totals/);
});

test("bounded editor reader accepts only explicitly marked expression recovery output", () => {
    const text = [
        header5,
        "M\t/main.bas",
        expression4,
        "R\t5\t1",
        "RECOVERY\t5\t1\t1\t1"
    ].join("\n");
    const model = decodeCompilerSemanticExpressions(text, () => true, { allowRecovery: true });

    assert.equal(model.complete, false);
    assert.equal(model.recovery, true);
    assert.equal(model.counts.recoveryModuleCount, 1);
    assert.equal(model.expressions[0].recovery, true);
    assert.throws(() => decodeCompilerSemanticExpressions(text), /recovery record/);
    assert.throws(() => decodeCompilerSemanticModel(text), /Unknown compiler semantic record type: R/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace("RECOVERY\t5\t1\t1\t1", "RECOVERY\t5\t1\t2\t1"), () => true, { allowRecovery: true }), /totals/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.split("\n").slice(0, -1).join("\n"), () => true, { allowRecovery: true }), /completeness marker/);
});

test("compile-time directive queries suppress conflicting same-span sidecar types", () => {
    const sourcePath = path.join(__dirname, "semantic-directive-ambiguity.bas");
    const sourceUri = { fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const source = "#assert 1 = 1\n";
    const fact = {
        id: 1, physical: true, filePath: sourcePath,
        startLine: 1, startColumn: 8, endLine: 1, endColumn: 13,
        astClass: 2, operator: 0, dtype: 8, symbol: 0, subtype: 0,
        typeName: "integer"
    };
    const analysis = {
        protocolVersion: 7,
        text: source,
        partial: false,
        dependencies: [sourcePath],
        origins: new Map(),
        expressions: [],
        expressionGraph: { nodes: [] },
        bindings: [],
        symbolGraph: { symbols: [], canonicalIds: [], uses: [] },
        semanticExpressions: [fact, { ...fact, id: 2, dtype: 17, typeName: "string" }]
    };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/semantic-directive-ambiguity.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );

    const start = { line: 0, character: fact.startColumn };
    const end = { line: 0, character: fact.endColumn };
    assert.equal(model.expressionAt(sourceUri, start, end), null,
        "directive queries must not let module parse order select a conflicting type");
    assert.equal(model.expressionAtCompilerSidecarOnly(sourceUri, start, end), null,
        "the isolated sidecar query must also withhold conflicting directive facts");
    assert.equal(model.isCompilerSidecarRangeAmbiguous(sourceUri, start, end), true);
});

test("schema 6 exposes bounded dependency records and validates their footer", () => {
    const text = [
        header6,
        "M\t/main.bas",
        expression4,
        "D\t/main.bas",
        "D\t/include.bi",
        "END\t6\t1\t0\t0\t0\t0\t1\t2\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text);

    assert.deepEqual(full.dependencies, ["/main.bas", "/include.bi"]);
    assert.equal(full.dependenciesComplete, true);
    assert.deepEqual(compact.dependencies, full.dependencies);
    assert.equal(compact.dependenciesComplete, true);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace("\t2\t1", "\t3\t1")), /dependency totals/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("D\t/include.bi", "D\t/main.bas")), /duplicate dependency/);
});

test("schema 7 validates compiler-resolved declaration and reference ranges", () => {
    const text = [
        header7,
        "M\t/main.bas",
        "S\t1\tvalue\t0\t8\t0\t-1\t0\t0\t4\t0\t0",
        "B\t1\tdeclaration\t1\t/main.bas\t2\t15\t2\t20",
        "B\t1\treference\t1\t/main.bas\t3\t4\t3\t9",
        "D\t/main.bas",
        "END\t7\t1\t0\t1\t0\t0\t0\t2\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => true, { includeBindings: true });

    assert.equal(full.schemaVersion, 7);
    assert.equal(full.counts.bindingCount, 2);
    assert.deepEqual(full.bindings.map(({ symbol, role, physical, startLine, startColumn, endColumn }) => ({
        symbol, role, physical, startLine, startColumn, endColumn
    })), [
        { symbol: 1, role: "declaration", physical: true, startLine: 2, startColumn: 15, endColumn: 20 },
        { symbol: 1, role: "reference", physical: true, startLine: 3, startColumn: 4, endColumn: 9 }
    ]);
    assert.equal(compact.counts.bindingCount, 2);
    assert.deepEqual(compact.bindings.map(({ name, role }) => [name, role]), [["value", "declaration"], ["value", "reference"]]);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("B\t1\treference", "B\t2\treference")), /missing symbol/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("\t2\t1\t1", "\t1\t1\t1")), /footer totals/);
});

test("schema 7 recovery footer accounts for binding records", () => {
    const text = [
        header7,
        "M\t/main.bas",
        expression4,
        "R\t7\t1",
        "D\t/main.bas",
        "RECOVERY\t7\t1\t1\t1\t0\t1\t1"
    ].join("\n");
    const model = decodeCompilerSemanticExpressions(text, () => true, { allowRecovery: true });

    assert.equal(model.recovery, true);
    assert.equal(model.counts.bindingCount, 0);
    assert.equal(model.dependenciesComplete, true);
});

test("schema 8 exposes stable operator concepts while retaining opaque raw IDs", () => {
    const text = [
        header8,
        "M\t/main.bas",
        "S\t1\tmain\t3\t8\t0\t-1\t0\t0\t0\t0\t0",
        "P\t1\tmain\t3\t8\t0\t1\t2\t/main.bas",
        "N\t1\t1\troot\t3\t37\tmultiply\tbuiltin\t8\t0\t0\t1\t/main.bas",
        expression8,
        "END\t8\t1\t1\t1\t0\t1\t1\t0\t0\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => true);

    assert.deepEqual({
        astClass: full.expressions[0].astClass,
        rawOperator: full.expressions[0].operator,
        operatorCode: full.expressions[0].operatorCode,
        operatorKind: full.expressions[0].operatorKind
    }, { astClass: 2, rawOperator: 37, operatorCode: "multiply", operatorKind: "builtin" });
    assert.equal(full.nodes[0].operatorCode, "multiply");
    assert.equal(full.nodes[0].operatorKind, "builtin");
    assert.equal(compact.expressions[0].operatorCode, "multiply");
    assert.equal(compact.expressions[0].operatorKind, "builtin");
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(expression8, expression8.replace("multiply\tbuiltin", "private-op\tbuiltin"))), /operator concept/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(expression8, expression8.replace("multiply\tbuiltin", "\tbuiltin"))), /operator concept/);
    for (const [operator, kind] of [["length", "builtin"], ["iterator-initialize", "overloaded"],
        ["iterator-step", "overloaded"], ["iterator-next", "overloaded"]]) {
        const selected = decodeCompilerSemanticModel(text.replaceAll("multiply\tbuiltin", `${operator}\t${kind}`));
        assert.equal(selected.nodes[0].operatorCode, operator);
        assert.equal(selected.expressions[0].operatorCode, operator);
        assert.equal(selected.expressions[0].operatorKind, kind);
    }
});

test("schema 9 retains a lowered parser operator without rewriting raw AST fields", () => {
    const text = [
        header9,
        "M\t/main.bas",
        expression9,
        "END\t9\t1\t0\t0\t0\t0\t1\t0\t0\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => true);

    assert.equal(full.schemaVersion, 9);
    assert.equal(full.expressions[0].astClass, 9);
    assert.equal(full.expressions[0].operator, 0);
    assert.equal(full.expressions[0].operatorCode, "identity-test");
    assert.equal(full.expressions[0].operatorKind, "builtin");
    assert.equal(compact.expressions[0].operatorCode, "identity-test");

    const futureProducerText = text
        .replace("FBCSEM\t9\t1.20.4", "FBCSEM\t9\t1.20.5")
        .replace("2\t32\t9\t0\tidentity-test\tbuiltin", "2\t32\t4096\t32767\tidentity-test\tbuiltin");
    const futureProducer = decodeCompilerSemanticExpressions(futureProducerText, () => true);
    assert.equal(futureProducer.expressions[0].astClass, 4096);
    assert.equal(futureProducer.expressions[0].operator, 32767);
    assert.equal(futureProducer.expressions[0].operatorCode, "identity-test");
    assert.equal(futureProducer.expressions[0].operatorKind, "builtin");

    assert.throws(
        () => decodeCompilerSemanticExpressions(text.replace("identity-test\tbuiltin", "private-op\tbuiltin")),
        /operator concept/
    );
});

test("schema 10 records selected implicit calls separately from editable bindings", () => {
    const text = [
        header10,
        "M\t/main.bas",
        "S\t1\tvalue\t1\t20\t2\t0\t0\t0\t4\t0\t0",
        "S\t2\tWidget\t3\t8\t0\t0\t0\t0\t0\t0\t0",
        "S\t3\tWidgetType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "I\t1\t2\t3\tdefault-constructor\t1\t/main.bas\t3\t8\t3\t13",
        "D\t/main.bas",
        "END\t10\t1\t0\t3\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.schemaVersion, 10);
    assert.equal(full.counts.implicitCallCount, 1);
    assert.deepEqual(full.implicitCalls[0], {
        owner: 1,
        target: 2,
        type: 3,
        kind: "default-constructor",
        physical: true,
        filePath: "/main.bas",
        startLine: 3,
        startColumn: 8,
        endLine: 3,
        endColumn: 13,
        targetSignature: ""
    });
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.deepEqual(full.bindings, [], "an implicit call must not become a token binding");

    assert.throws(() => decodeCompilerSemanticModel(text.replace("END\t10\t1\t0\t3\t0\t0\t0\t0\t1\t1\t1", "END\t10\t1\t0\t3\t0\t0\t0\t0\t0\t1\t1")), /footer totals/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("I\t1\t2\t3", "I\t1\t99\t3")), /missing symbol/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("I\t1\t2\t3", "I\t1\t2\t99")), /missing symbol/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("default-constructor\t1", "default-constructor\t2")), /source range/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("default-constructor", "conversion-constructor")), /implicit-call kind/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace(header10, header9)), /schema version 10/);
});

test("schema 10 accepts supported compiler-selected call kinds and rejects unknown kinds", () => {
    const text = [
        header10,
        "M\t/main.bas",
        "S\t1\tvalue\t1\t20\t2\t0\t0\t0\t4\t0\t0",
        "S\t2\tWidget\t3\t8\t0\t0\t0\t0\t0\t0\t0",
        "S\t3\tWidgetType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "I\t1\t2\t3\tinitializer-constructor\t1\t/main.bas\t3\t8\t3\t13",
        "D\t/main.bas",
        "END\t10\t1\t0\t3\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");

    assert.equal(decodeCompilerSemanticModel(text).implicitCalls[0].kind, "initializer-constructor");
    assert.equal(decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true }).implicitCalls[0].kind, "initializer-constructor");
    const allocationText = text.replace("initializer-constructor", "new-constructor");
    assert.equal(decodeCompilerSemanticModel(allocationText).implicitCalls[0].kind, "new-constructor");
    assert.equal(decodeCompilerSemanticExpressions(allocationText, () => false, { includeBindings: true }).implicitCalls[0].kind, "new-constructor");
    assert.throws(() => decodeCompilerSemanticModel(text.replace("initializer-constructor", "conversion-constructor")), /implicit-call kind/);
});

test("schema 11 preserves stable selected-call signatures and requires them", () => {
    const signature = "sig1|byval|0|0|7:integer";
    const text = [
        header11,
        "M\t/main.bas",
        "S\t1\tvalue\t1\t20\t2\t0\t0\t0\t4\t0\t0",
        "S\t2\tWidget\t3\t8\t0\t0\t0\t0\t0\t0\t0",
        "S\t3\tWidgetType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        `I\t1\t2\t3\tinitializer-constructor\t1\t/main.bas\t3\t8\t3\t13\t${signature}`,
        "D\t/main.bas",
        "END\t11\t1\t0\t3\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.schemaVersion, 11);
    assert.equal(full.implicitCalls[0].targetSignature, signature);
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.throws(() => decodeCompilerSemanticModel(text.replace(`\t${signature}`, "\t")), /target signature/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(`\t${signature}`, "\t"), () => true, { includeBindings: true }), /target signature/);
    const oversized = `${header11}\nM\t/main.bas\nS\t1\tvalue\t1\t20\t2\t0\t0\t0\t4\t0\t0\nS\t2\tWidget\t3\t8\t0\t0\t0\t0\t0\t0\t0\nS\t3\tWidgetType\t10\t20\t0\t0\t0\t0\t0\t0\t0\nI\t1\t2\t3\tinitializer-constructor\t1\t/main.bas\t3\t8\t3\t13\t${"x".repeat(MAX_IMPLICIT_CALL_SIGNATURE_BYTES + 1)}\nD\t/main.bas\nEND\t11\t1\t0\t3\t0\t0\t0\t0\t1\t1\t1`;
    assert.throws(() => decodeCompilerSemanticModel(oversized), /target signature/);
});

test("schema 12 adds declaration-anchored destructor relationships", () => {
    const text = [
        header12,
        "M\t/main.bas",
        "S\t1\tlocalValue\t1\t20\t2\t0\t0\t0\t4\t0\t0",
        "S\t2\tDestructor\t5\t8\t0\t0\t0\t0\t0\t0\t0",
        "S\t3\tWidget\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "I\t1\t2\t3\tdestructor-call\t1\t/main.bas\t3\t8\t3\t18\tsig1",
        "D\t/main.bas",
        "END\t12\t1\t0\t3\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });
    assert.equal(full.schemaVersion, 12);
    assert.equal(full.implicitCalls[0].kind, "destructor-call");
    assert.equal(full.implicitCalls[0].targetSignature, "sig1");
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.throws(() => decodeCompilerSemanticModel(text.replace(header12, header11)), /implicit-call kind/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(header12, header11), () => false, { includeBindings: true }), /implicit-call kind/);
});

test("schema 13 records argument-selected constructors only in the current schema", () => {
    const text = [
        header13,
        "M\t/main.bas",
        "S\t1\titem\t4\t20\t3\t0\t0\t0\t4\t2\t0",
        "S\t2\tWidget\t3\t8\t0\t0\t0\t0\t0\t0\t0",
        "S\t3\tWidgetType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "I\t1\t2\t3\targument-constructor\t1\t/main.bas\t8\t14\t8\t20\tsig1|byval|0|0|7:integer",
        "D\t/main.bas",
        "END\t13\t1\t0\t3\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.schemaVersion, 13);
    assert.equal(full.implicitCalls[0].kind, "argument-constructor");
    assert.equal(full.implicitCalls[0].startColumn, 14);
    assert.equal(compact.implicitCalls[0].kind, "argument-constructor");
    assert.throws(() => decodeCompilerSemanticModel(text.replace(header13, header12).replace("END\t13", "END\t12")), /implicit-call kind/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(header13, header12).replace("END\t13", "END\t12"), () => false, { includeBindings: true }), /implicit-call kind/);
});

test("schema 14 records non-editable temporary destructor relationships", () => {
    const text = [
        header14,
        "M\t/main.bas",
        "S\t1\tDestructor\t5\t8\t0\t0\t0\t0\t0\t0\t0",
        "S\t2\tTemporaryValue\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "I\t2\t1\t2\ttemporary-destructor\t1\t/main.bas\t9\t26\t9\t43\tsig1",
        "D\t/main.bas",
        "END\t14\t1\t0\t2\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.schemaVersion, 14);
    assert.deepEqual(full.implicitCalls[0], {
        owner: 2, target: 1, type: 2, kind: "temporary-destructor", physical: true,
        filePath: "/main.bas", startLine: 9, startColumn: 26, endLine: 9, endColumn: 43,
        targetSignature: "sig1"
    });
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.throws(() => decodeCompilerSemanticModel(text.replace(header14, header13).replace("END\t14", "END\t13")), /implicit-call kind/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(header14, header13).replace("END\t14", "END\t13"), () => false, { includeBindings: true }), /implicit-call kind/);
});

test("schema 15 records scope-exit destructor relationships", () => {
    const text = [
        header15,
        "M\t/main.bas",
        "S\t1\tlocalValue\t1\t20\t3\t0\t0\t0\t4\t2\t0",
        "S\t2\tDestructor\t3\t8\t0\t0\t0\t0\t0\t0\t0",
        "S\t3\tScopeExitType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "I\t1\t2\t3\tscope-exit-destructor\t1\t/main.bas\t12\t4\t12\t8\tsig1",
        "D\t/main.bas",
        "END\t15\t1\t0\t3\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.schemaVersion, 15);
    assert.equal(full.implicitCalls[0].kind, "scope-exit-destructor");
    assert.equal(full.implicitCalls[0].startColumn, 4);
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.throws(() => decodeCompilerSemanticModel(text.replace(header15, header14).replace("END\t15", "END\t14")), /implicit-call kind/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(header15, header14).replace("END\t15", "END\t14"), () => false, { includeBindings: true }), /implicit-call kind/);
});

test("schema 16 records non-editable delete destructor relationships", () => {
    const text = [
        header16,
        "M\t/main.bas",
        "S\t1\tDeleteType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "S\t2\tDestructor\t3\t8\t0\t0\t0\t0\t0\t0\t0",
        "I\t1\t2\t1\tdelete-destructor\t1\t/main.bas\t8\t4\t8\t10\tsig1",
        "D\t/main.bas",
        "END\t16\t1\t0\t2\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.schemaVersion, 16);
    assert.equal(full.implicitCalls[0].kind, "delete-destructor");
    assert.equal(full.implicitCalls[0].owner, full.implicitCalls[0].type);
    assert.equal(full.implicitCalls[0].startColumn, 4);
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.throws(() => decodeCompilerSemanticModel(text.replace(header16, header15).replace("END\t16", "END\t15")), /implicit-call kind/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(header16, header15).replace("END\t16", "END\t15"), () => false, { includeBindings: true }), /implicit-call kind/);
});

test("schema 17 records return-expression constructor selections", () => {
    const text = [
        header17,
        "M\t/main.bas",
        "S\t1\tReturnType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "S\t2\tConstructor\t3\t8\t0\t0\t0\t0\t0\t0\t0",
        "I\t1\t2\t1\treturn-constructor\t1\t/main.bas\t8\t11\t8\t13\tsig1|byval|0|0|7:integer",
        "D\t/main.bas",
        "END\t17\t1\t0\t2\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.schemaVersion, 17);
    assert.equal(full.implicitCalls[0].kind, "return-constructor");
    assert.equal(full.implicitCalls[0].owner, full.implicitCalls[0].type);
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.throws(() => decodeCompilerSemanticModel(text.replace(header17, header16).replace("END\t17", "END\t16")), /implicit-call kind/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(header17, header16).replace("END\t17", "END\t16"), () => false, { includeBindings: true }), /implicit-call kind/);
});

test("schema 18 uses exact type identities in rename-stable selected-call signatures", () => {
    const signature = "sig2|byref|0|0|20|1";
    const text = [
        header18,
        "M\t/main.bas",
        "S\t1\tSourceType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "S\t2\tTargetType\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "S\t3\titem\t4\t20\t2\t0\t0\t0\t4\t2\t0",
        "S\t4\tConstructor\t5\t8\t2\t0\t0\t0\t0\t0\t0",
        `I\t3\t4\t2\targument-constructor\t1\t/main.bas\t8\t14\t8\t20\t${signature}`,
        "D\t/main.bas",
        "END\t18\t1\t0\t4\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.schemaVersion, 18);
    assert.equal(full.implicitCalls[0].targetSignature, signature);
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("20|1", "20|99")), /stable target signature/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("20|1", "bad|1")), /stable target signature/);
});

test("schema 18 preserves the BYDESC any-rank dimension sentinel", () => {
    const signature = "sig2|bydesc|0|-1|20|0";
    const text = [
        header18,
        "M\t/main.bas",
        "S\t1\tArrayOwner\t10\t20\t0\t0\t0\t0\t0\t0\t0",
        "S\t2\tArrayConstructor\t5\t8\t2\t0\t0\t0\t0\t0\t0",
        `I\t1\t2\t1\tinitializer-constructor\t1\t/main.bas\t8\t14\t8\t20\t${signature}`,
        "D\t/main.bas",
        "END\t18\t1\t0\t2\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.equal(full.implicitCalls[0].targetSignature, signature);
    assert.deepEqual(compact.implicitCalls, full.implicitCalls);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("bydesc|0|-1", "bydesc|0|-2")), /stable target signature/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("bydesc|0|-1", "bydesc|0|0")), /stable target signature/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("bydesc|0|-1", "byval|0|-1")), /stable target signature/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("bydesc|0|-1", "byval|0|-0")), /stable target signature/);
});

test("schema 20 decodes current compiler facts and closed source provenance", () => {
    const full = decodeCompilerSemanticModel(schema20Sidecar());
    const compact = decodeCompilerSemanticExpressions(schema20Sidecar({ expressionOnly: true }), () => true);

    assert.equal(full.schemaVersion, 20);
    assert.equal(full.counts.detailCount, 7);
    assert.equal(full.details.length, 7);
    assert.equal(full.sourceFiles[0].digest, "a".repeat(64));
    assert.equal(full.targetContexts[0][0], "/main.bas");
    assert.equal(full.sourceOrigins[0].identity, 1);
    assert.ok(full.details.some((detail) => detail.tag === "C" && detail.fields[3] === "18446744073709551615"),
        "64-bit unsigned constants must retain their exact decimal value");
    assert.deepEqual(full.constantValues, [{
        module: 1, domain: "expression", identity: 1, kind: "unsigned", value: "18446744073709551615"
    }], "validated constant records should remain available to compiler-backed editor features");
    assert.equal(compact.schemaVersion, 20);
    assert.equal(compact.counts.detailCount, 4);
    assert.equal(compact.expressions[0].operatorCode, "multiply");
    assert.deepEqual(compact.sourceOrigins, [{ domain: "expression", identity: 1, source: 1 }]);
});

test("schema 20 semantic strings preserve legacy bytes with surrogate escapes", () => {
    const text = [
        header20,
        "M\t/main.bas",
        "D\t/main.bas",
        "S\t1\tlegacyName\t1\t17\t0\t0\t0\t0\t24\t0\t0",
        "T\t1\tlegacyName\tvariable\tdynamic-string\t%C8%C0%F8# ptr\t17\t0\t0\t0\t0\t0\t0\t24\t0\t\tpublic\tglobal\tsource",
        "END\t20\t1\t0\t1\t0\t0\t0\t0\t0\t1\t1\t1"
    ].join("\n");
    const model = decodeCompilerSemanticModel(text);
    const type = model.details.find((detail) => detail.tag === "T");

    assert.equal(type.fields[4], "\uDCC8\uDCC0\uDCF8# ptr");
});

test("schema 20 preserves explicit expression-only recovery with provenance", () => {
    const complete = schema20Sidecar({ expressionOnly: true }).split("\n");
    complete.pop();
    const recovery = decodeCompilerSemanticExpressions([
        ...complete,
        "R\t20\t1",
        "RECOVERY\t20\t1\t1\t1\t0\t1\t1"
    ].join("\n"), () => true, { allowRecovery: true });

    assert.equal(recovery.complete, false);
    assert.equal(recovery.recovery, true);
    assert.equal(recovery.expressions[0].recovery, true);
    assert.equal(recovery.counts.recoveryModuleCount, 1);
});

test("schema 21 validates compiler-selected conditional and preprocessor provenance", () => {
    const text = schema21ConditionalSidecar();
    const full = decodeCompilerSemanticModel(text);
    const compact = decodeCompilerSemanticExpressions(text, () => true);

    assert.equal(full.schemaVersion, 21);
    assert.equal(full.counts.detailCount, 10);
    assert.equal(full.conditionalBranches.length, 2);
    assert.equal(full.conditionalDecisions.length, 2);
    assert.equal(full.conditionalClosures.length, 1);
    assert.equal(full.definedNameProbes[0].spelling, "FLAG");
    assert.equal(full.skippedRegions[0].branch, 11);
    assert.equal(compact.schemaVersion, 21);
    assert.deepEqual(compact.conditionalBranches, full.conditionalBranches);
    assert.deepEqual(compact.conditionalDecisions, full.conditionalDecisions);

    const wrongOrdinal = text.replace("PPB\t11\t0\t10\t1\t0\t1\telse", "PPB\t11\t0\t10\t1\t0\t2\telse");
    assert.throws(() => decodeCompilerSemanticExpressions(wrongOrdinal, () => true), /conditional successor order/);
    const falseSelection = text.replace("PPD\t10\tevaluated\t1\t1", "PPD\t10\tevaluated\t1\t0");
    assert.throws(() => decodeCompilerSemanticModel(falseSelection), /conditional selection/);
});

test("schema 23 validates remap identities and captured physical byte locations", () => {
    const text = schema23LocationSidecar();
    const full = decodeCompilerSemanticModel(text);
    const bounded = decodeCompilerSemanticExpressions(text, () => false);

    assert.equal(full.schemaVersion, 23);
    assert.deepEqual(full.sourceRemaps, [{ id: 2, source: 1, logicalLine: 10, logicalFile: "logical.bas", physical: true,
        range: { filePath: "/main.bas", startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 } }]);
    assert.deepEqual(full.physicalLocations.map(({ domain, subject, role, source, startByte, endByte, status }) =>
        ({ domain, subject, role, source, startByte, endByte, status })), [
        { domain: "expression", subject: 1, role: "range", source: 1, startByte: 0, endByte: 3, status: "mapped" },
        { domain: "remap", subject: 2, role: "directive", source: 1, startByte: 0, endByte: 3, status: "mapped" }
    ]);
    assert.equal(bounded.schemaVersion, 23);
    assert.equal(bounded.physicalLocations.length, 2);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace(
        "LOC\texpression\t1\trange\t1\t1\t0\t1\t3\t0\t3\tmapped",
        "LOC\texpression\t1\trange\t1\t1\t0\t1\t3\t0\t4\tmapped"
    ), () => false), /exceeds its captured source revision/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace(
        "LOC\tremap\t2\tdirective",
        "LOC\tremap\t3\tdirective"
    )), /remap location is dangling/);
});

test("schema 25 validates statement ownership and nested source constructs", () => {
    const text = schema25ConstructSidecar();
    const full = decodeCompilerSemanticModel(text);
    const bounded = decodeCompilerSemanticExpressions(text, () => false);

    assert.equal(full.schemaVersion, 25);
    assert.deepEqual(full.capabilities, [{ module: 1, feature: "source-constructs", coverage: "partial" }]);
    assert.equal(full.statements.length, 1);
    assert.equal(full.statementEndings[0].route, "compound");
    assert.equal(full.constructs[0].kind, "if");
    assert.deepEqual(full.statementOwners, [{ domain: "expression", subject: 1, statement: 1 }]);
    assert.equal(bounded.schemaVersion, 25);
    assert.equal(bounded.physicalLocations.filter((location) => ["statement", "construct"].includes(location.domain)).length, 2);

    const wrongEnd = text.replace("BEND\t1\t1\t1", "BEND\t2\t1\t1");
    assert.throws(() => decodeCompilerSemanticModel(wrongEnd));
    const invalidCapability = text.replace("source-constructs\tpartial", "source-constructs\tcomplete");
    assert.throws(() => decodeCompilerSemanticExpressions(invalidCapability, () => false), /capability/);
});

test("schema 25 accepts an empty physical statement-end point", () => {
    const text = schema25ConstructSidecar().replace(
        "STE\t1\tcompound\tparsed\t1\t/main.bas\t1\t0\t1\t3",
        "STE\t1\tcompound\tparsed\t1\t/main.bas\t1\t3\t1\t3"
    );
    const ending = decodeCompilerSemanticModel(text).statementEndings[0];

    assert.equal(ending.physical, true);
    assert.equal(ending.startColumn, 3);
    assert.equal(ending.endColumn, 3);
});

test("schema 25 accepts statement and construct locations emitted before their closing records", () => {
    const rows = schema25ConstructSidecar().split("\n");
    const constructIndex = rows.findIndex((row) => row.startsWith("BLK\t"));
    const statementEndIndex = rows.findIndex((row) => row.startsWith("STE\t"));
    rows.splice(constructIndex + 1, 0,
        "LOC\tconstruct\t1\tif-arm:then\t1\t1\t0\t1\t0\t0\t0\tmapped",
        "LOC\tstatement\t1\tassignment-operator:1\t1\t1\t0\t1\t0\t0\t0\tmapped");
    const footer = rows.at(-1).split("\t");
    footer[12] = String(Number(footer[12]) + 2);
    rows[rows.length - 1] = footer.join("\t");

    const model = decodeCompilerSemanticModel(rows.join("\n"));
    assert.ok(model.physicalLocations.some((location) => location.domain === "construct" && location.role === "if-arm:then"));
    assert.ok(model.physicalLocations.some((location) => location.domain === "statement" && location.role === "assignment-operator:1"));

    const dangling = rows.map((row) => row.replace("LOC\tstatement\t1\tassignment-operator:1", "LOC\tstatement\t2\tassignment-operator:1")).join("\n");
    assert.throws(() => decodeCompilerSemanticModel(dangling), /statement location has no observed opener/);
});

test("schema 25 retains source statement operations and rejects unsupported effects", () => {
    const rows = schema25ConstructSidecar().split("\n");
    const index = rows.findIndex((row) => row.startsWith("STE\t"));
    rows.splice(index, 0, "SOP\t1\tfile-open");
    const footer = rows.at(-1).split("\t");
    footer[12] = String(Number(footer[12]) + 1);
    rows[rows.length - 1] = footer.join("\t");
    const text = rows.join("\n");
    const full = decodeCompilerSemanticModel(text);
    assert.deepEqual(full.statementOperations, [{ statement: 1, operation: "file-open" }]);
    const bounded = decodeCompilerSemanticExpressions(text, () => false);
    assert.deepEqual(bounded.statementOperations, full.statementOperations);
    for (const operation of ["on-goto", "procedure-return", "on-error-clear"]) {
        const controlOperation = decodeCompilerSemanticModel(text.replace("SOP\t1\tfile-open", `SOP\t1\t${operation}`));
        assert.deepEqual(controlOperation.statementOperations, [{ statement: 1, operation }]);
    }
    assert.throws(() => decodeCompilerSemanticModel(text.replace("SOP\t1\tfile-open", "SOP\t2\tfile-open")), /statement operation/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("SOP\t1\tfile-open", "SOP\t1\tpure-call")), /statement operation/);
});

test("schema 27 validates source operator operands and diagnostics in both readers", () => {
    const digest = "0".repeat(64);
    const expression = (id, startColumn, endColumn) => [
        "E", id, "1", "/main.bas", "1", startColumn, "1", endColumn,
        "0", "0", "", "none", "8", "0", "0", "integer"
    ].join("\t");
    const text = [
        header27,
        "M\t/main.bas",
        "D\t/main.bas",
        `FILE\t1\t/main.bas\t4\t${digest}\tunmarked-bytes\tregular`,
        "SRC\t1\t0\t1\t1\tmodule\t0\t/main.bas\t0\t\t0\t0\t0\t0",
        expression(1, 0, 1),
        expression(2, 2, 3),
        expression(3, 0, 3),
        "EX\t3\tbinary\tadd\t1\t2\t1\t1\t/main.bas\t1\t1\t1\t2",
        "DI\t1\twarning\t11\tExpected constant\t\t\t/main.bas\t1\t1\t0\t0",
        "SRE\t1\tverified",
        "END\t27\t1\t0\t0\t0\t0\t3\t0\t0\t1\t1\t5"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const bounded = decodeCompilerSemanticExpressions(text, () => true);

    assert.equal(full.schemaVersion, 27);
    assert.deepEqual(full.expressionOperands[0], {
        identity: 3, family: "binary", operator: "add", left: 1, right: 2, source: 1, physical: true, module: 1,
        filePath: "/main.bas", startLine: 1, startColumn: 1, endLine: 1, endColumn: 2
    });
    assert.equal(full.semanticDiagnostics[0].severity, "warning");
    assert.deepEqual(bounded.expressionOperands, full.expressionOperands);
    assert.deepEqual(bounded.semanticDiagnostics, full.semanticDiagnostics);
    const customDiagnosticText = text.replace(
        "DI\t1\twarning\t11\tExpected constant",
        "DI\t1\terror\t-1\tCustom preprocessor error"
    );
    assert.equal(decodeCompilerSemanticModel(customDiagnosticText).semanticDiagnostics[0].code, -1);
    assert.equal(decodeCompilerSemanticExpressions(customDiagnosticText, () => true).semanticDiagnostics[0].code, -1);
    assert.throws(() => decodeCompilerSemanticModel(customDiagnosticText.replace("-1\tCustom", "-2\tCustom")), /semantic diagnostic code/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("EX\t3\tbinary\tadd", "EX\t3\tbinary\tunknown")), /source operator/);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace("EX\t3\tbinary\tadd\t1\t2", "EX\t3\tbinary\tadd\t3\t2"), () => true), /source expression operands/);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("DI\t1\twarning", "DI\t1\tinformation")), /semantic diagnostic/);
});

test("schema 27 accepts the compiler's full pointer-depth field range", () => {
    const sidecar = (pointerDepth) => [
        header27,
        "M\t/main.bas",
        "D\t/main.bas",
        "E\t1\t1\t/main.bas\t1\t0\t1\t1\t2\t0\t\tnone\t8\t0\t0\tinteger",
        `NT\texpression\t1\tvalue\tinteger\t0\t${pointerDepth}\t0\t${"0".repeat(pointerDepth + 1)}\t8\t`,
        "END\t27\t1\t0\t0\t0\t0\t1\t0\t0\t1\t1\t1"
    ].join("\n");

    assert.equal(decodeCompilerSemanticModel(sidecar(9)).normalizedTypes[0].pointerDepth, 9);
    assert.equal(decodeCompilerSemanticModel(sidecar(15)).normalizedTypes[0].pointerDepth, 15);
    assert.throws(() => decodeCompilerSemanticModel(sidecar(16)), /normalized type subject/);
});

test("schema 27 exposes compiler-selected symbol properties and capability coverage", () => {
    const text = [
        header27,
        "M\t/main.bas",
        "D\t/main.bas",
        "S\t1\tprobe\t3\t8\t0\t0\t0\t0\t0\t0\t0",
        "CAP\t1\tprocedure-typing-inputs\tavailable",
        "K\tsymbol\t1\tprocedure-typing-input:1\t1%09definition%09function%09implicit%090",
        "END\t27\t1\t0\t1\t0\t0\t0\t0\t0\t1\t1\t2"
    ].join("\n");
    const full = decodeCompilerSemanticModel(text);
    const bindings = decodeCompilerSemanticExpressions(text, () => false, { includeBindings: true });

    assert.deepEqual(full.properties, [{
        module: 1,
        domain: "symbol",
        identity: 1,
        name: "procedure-typing-input:1",
        value: "1\tdefinition\tfunction\timplicit\t0"
    }]);
    assert.deepEqual(bindings.properties, full.properties);
    assert.deepEqual(bindings.capabilities, [{ module: 1, feature: "procedure-typing-inputs", coverage: "available" }]);
    assert.throws(() => decodeCompilerSemanticModel(text.replace("procedure-typing-input:1", "")), /property/);
    const duplicate = text.replace("END\t27", "K\tsymbol\t1\tprocedure-typing-input:1\tother\nEND\t27");
    assert.throws(() => decodeCompilerSemanticModel(duplicate), /duplicate schema-20 property/);
});

test("schema 27 preserves signed compiler symbol lengths", () => {
    const text = [
        header27,
        "M\t/main.bas",
        "D\t/main.bas",
        "S\t1\tForwardPointer\t13\t23\t0\t0\t0\t0\t-1\t0\t0",
        "END\t27\t1\t0\t1\t0\t0\t0\t0\t0\t1\t1\t0"
    ].join("\n");

    assert.equal(decodeCompilerSemanticModel(text).symbols[0].length, -1);
    const expressions = decodeCompilerSemanticExpressions(text, () => true, { includeBindings: true });
    assert.equal(expressions.counts.symbolCount, 1);
    assert.equal(expressions.symbols, undefined,
        "the bounded expression reader must not retain a full compiler symbol graph");
});

test("schema 27 accepts an un-emitted procedure phase without CFG blocks", () => {
    const text = [
        header27,
        "M\t/main.bas",
        "D\t/main.bas",
        "S\t1\tprobe\t3\t0\t0\t0\t0\t0\t0\t0\t0",
        "P\t1\tprobe\t3\t0\t0\t1\t1\t/main.bas",
        "T\t1\tprobe\tprocedure\tother\tany\t0\t0\t0\t0\t0\t0\t0\t0\t0\t\tpublic\tnone\tsource",
        "F\t1\tsub\tcdecl\t0\t0\t0\t0\t0\t0\t\t0\t0",
        "PH\t1\t1\tpre-load\t0",
        "END\t27\t1\t1\t1\t0\t0\t0\t0\t0\t1\t1\t3"
    ].join("\n");
    const model = decodeCompilerSemanticModel(text);

    assert.deepEqual(model.flowPhases, [{ id: 1, procedure: 1, name: "pre-load", emitted: false, module: 1 }]);
    assert.deepEqual(model.controlFlowBlocks, []);
    assert.deepEqual(model.controlFlowEdges, []);
});

test("semantic relations can target compiler expression identities", () => {
    const rows = schema20Sidecar().split("\n");
    const footer = rows.pop().split("\t");
    const expressionIndex = rows.findIndex((row) => row.startsWith("E\t"));
    rows.splice(expressionIndex + 1, 0, "H\texpression\t1\texpression\t1\tsource-prefix\t0");
    footer[12] = "8";
    rows.push(footer.join("\t"));
    const model = decodeCompilerSemanticModel(rows.join("\n"));

    assert.ok(model.details.some((detail) => detail.tag === "H" && detail.fields[0] === "expression" && detail.fields[2] === "expression"));
    assert.deepEqual(model.relationships, [{
        module: 1, sourceDomain: "expression", source: 1,
        targetDomain: "expression", target: 1, kind: "source-prefix", ordinal: 0
    }]);
});

test("schema 20 rejects malformed framing but preserves legacy bytes and provenance", () => {
    const full = schema20Sidecar();
    const compact = schema20Sidecar({ expressionOnly: true });

    assert.throws(() => decodeCompilerSemanticModel(full.replace("Q\t/main.bas\tlinux\tx86_64\tgnu\tlinux-x86_64\t8\tlittle\t4\t0", "Q\t/main.bas\tlinux")), /record shape/);
    assert.throws(() => decodeCompilerSemanticModel(full.replace("ORIG\texpression\t1\t1", "ORIG\texpression\t2\t1")), /missing expression/);
    assert.throws(() => decodeCompilerSemanticModel(full.replace("18446744073709551615", "18446744073709551616")), /64-bit range/);
    assert.throws(() => decodeCompilerSemanticExpressions(compact.replaceAll("/main.bas", "/main%GGbas")), /Invalid escaped compiler semantic/);
    const legacyPath = decodeCompilerSemanticExpressions(compact.replaceAll("/main.bas", "/main%FFbas"));
    assert.equal(legacyPath.modules[0], `/main${String.fromCharCode(0xdcff)}bas`);
    assert.throws(() => decodeCompilerSemanticExpressions(compact.replace("SRE\t1\tverified\n", "").replace("\t1\t1\t4", "\t1\t1\t3")), /not completely closed/);
    assert.throws(() => decodeCompilerSemanticModel(full.replace("\t1\t1\t7", "\t1\t1\t5")), /totals do not match/);
});

test("schema 10 recovery footer remains expression-only", () => {
    const text = [
        header10,
        "M\t/main.bas",
        expression9,
        "R\t10\t1",
        "D\t/main.bas",
        "RECOVERY\t10\t1\t1\t1\t0\t1\t1"
    ].join("\n");
    const model = decodeCompilerSemanticExpressions(text, () => true, { allowRecovery: true, includeBindings: true });
    assert.equal(model.recovery, true);
    assert.equal(model.counts.implicitCallCount, 0);
    assert.deepEqual(model.implicitCalls, []);
    assert.throws(() => decodeCompilerSemanticExpressions(text.replace("R\t10\t1", "I\t1\t2\t3\tdefault-constructor\t1\t/main.bas\t3\t8\t3\t13\nR\t10\t1"), () => true, { allowRecovery: true }), /footer totals/);
});

test("project implicit-call facts cross identities only at exact source declarations", () => {
    const filePath = "/project/main.bas";
    const sourceUri = { scheme: "file", fsPath: filePath };
    const ownerToken = { offset: 0 };
    const typeToken = { offset: 16 };
    const model = {
        nativeBindings: [
            { id: 41, kind: "declaration", token: ownerToken },
            { id: 72, kind: "declaration", token: typeToken }
        ],
        expandedToSource: new Map([
            [0, { uri: sourceUri, occurrence: { line: 2, startColumn: 8, endColumn: 13 } }],
            [16, { uri: sourceUri, occurrence: { line: 0, startColumn: 5, endColumn: 18 } }]
        ])
    };
    const analysis = {
        semanticBindings: [
            { symbol: 1, role: "declaration", filePath, startLine: 3, startColumn: 8, endLine: 3, endColumn: 13 },
            { symbol: 3, role: "declaration", filePath, startLine: 1, startColumn: 5, endLine: 1, endColumn: 18 }
        ],
        semanticImplicitCalls: [{
            owner: 1, target: 2, type: 3, kind: "default-constructor", physical: true,
            targetSignature: "sig1",
            filePath, startLine: 3, startColumn: 8, endLine: 3, endColumn: 13
        }]
    };

    assert.deepEqual(semanticProjectImplicitCalls(analysis, model), [{
        ownerId: 41, targetTypeId: 72, kind: "default-constructor", targetSignature: "sig1", filePath, line: 3, ordinal: 0
    }]);
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], targetSignature: "" }]
    }, model), [], "legacy relationships without an overload signature must not enter cross-pass validation");
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], startColumn: 7, endColumn: 12 }]
    }, model), [], "unanchored or guessed source locations must be withheld");

    const typeReferenceToken = { offset: 32 };
    const newModel = {
        ...model,
        nativeBindings: [...model.nativeBindings, { id: 72, kind: "reference", token: typeReferenceToken }],
        expandedToSource: new Map([...model.expandedToSource, [32, {
            uri: sourceUri, occurrence: { line: 3, startColumn: 12, endColumn: 17 }
        }]])
    };
    const newAnalysis = {
        ...analysis,
        semanticBindings: [...analysis.semanticBindings, {
            symbol: 3, role: "reference", filePath, startLine: 4, startColumn: 12, endLine: 4, endColumn: 17
        }],
        semanticImplicitCalls: [{
            owner: 3, target: 2, type: 3, kind: "new-constructor", physical: true,
            targetSignature: "sig1|byval|0|0|7:integer",
            filePath, startLine: 4, startColumn: 12, endLine: 4, endColumn: 17
        }]
    };
    assert.deepEqual(semanticProjectImplicitCalls(newAnalysis, newModel), [{
        ownerId: 72, targetTypeId: 72, kind: "new-constructor", targetSignature: "sig1|byval|0|0|7:integer", filePath, line: 4, ordinal: 0
    }]);
    assert.deepEqual(semanticProjectImplicitCalls({
        ...newAnalysis,
        semanticImplicitCalls: [{ ...newAnalysis.semanticImplicitCalls[0], startColumn: 11, endColumn: 16 }]
    }, newModel), [], "NEW relationships require the exact compiler-bound type token");
});

test("project rename fingerprints unanchored implicit calls without inventing edit sites", () => {
    const filePath = "/project/generated-calls.bas";
    const sourceUri = { scheme: "file", fsPath: filePath };
    const model = {
        nativeBindings: [
            { id: 41, kind: "declaration", token: { offset: 0 } },
            { id: 72, kind: "declaration", token: { offset: 16 } },
            { id: 88, kind: "declaration", token: { offset: 32 } }
        ],
        expandedToSource: new Map([
            [0, { uri: sourceUri, occurrence: { line: 2, startColumn: 8, endColumn: 13 } }],
            [16, { uri: sourceUri, occurrence: { line: 0, startColumn: 5, endColumn: 18 } }],
            [32, { uri: sourceUri, occurrence: { line: 1, startColumn: 12, endColumn: 22 } }]
        ])
    };
    const analysis = {
        semanticBindings: [
            { symbol: 1, role: "declaration", filePath, startLine: 3, startColumn: 8, endLine: 3, endColumn: 13 },
            { symbol: 3, role: "declaration", filePath, startLine: 1, startColumn: 5, endLine: 1, endColumn: 18 },
            { symbol: 2, role: "declaration", filePath, startLine: 2, startColumn: 12, endLine: 2, endColumn: 22 }
        ],
        semanticImplicitCalls: [
            {
                owner: 1, target: 2, type: 3, kind: "default-constructor", physical: false,
                targetSignature: "sig1", filePath, startLine: 20, startColumn: 100, endLine: 20, endColumn: 110
            },
            {
                owner: 1, target: 2, type: 3, kind: "default-constructor", physical: false,
                targetSignature: "sig1", filePath, startLine: 21, startColumn: 200, endLine: 21, endColumn: 210
            },
            {
                owner: 1, target: 2, type: 3, kind: "default-constructor", physical: true,
                targetSignature: "sig1", filePath, startLine: 3, startColumn: 8, endLine: 3, endColumn: 13
            }
        ]
    };
    const facts = semanticProjectUnanchoredImplicitCalls(analysis, model);
    assert.deepEqual(facts, [{
        ownerBridgeId: 41,
        ownerSidecarId: 0,
        typeBridgeId: 72,
        typeSidecarId: 0,
        targetBridgeId: 88,
        targetSidecarId: 0,
        kind: "default-constructor",
        targetSignature: "sig1",
        filePath,
        count: 2
    }]);
    const physicalFacts = semanticProjectImplicitCalls(analysis, model);
    assert.equal(physicalFacts.length, 1,
        "unanchored facts must remain separate from exact physical callsite projection");
    assert.equal(physicalFacts[0].line, 3,
        "only the independently physical call may retain an editable-range receipt");
    const changed = semanticProjectUnanchoredImplicitCalls({
        ...analysis,
        semanticImplicitCalls: analysis.semanticImplicitCalls.map((call, index) => index === 1
            ? { ...call, targetSignature: "sig2" }
            : call)
    }, model);
    assert.notDeepEqual(changed, facts,
        "a changed compiler-selected target signature must alter the refactoring receipt");

    const ambiguousModel = {
        ...model,
        nativeBindings: [...model.nativeBindings, { id: 99, kind: "declaration", token: { offset: 48 } }],
        expandedToSource: new Map([...model.expandedToSource, [48, {
            uri: sourceUri, occurrence: { line: 4, startColumn: 8, endColumn: 13 }
        }]])
    };
    const ambiguousAnalysis = {
        ...analysis,
        semanticBindings: [...analysis.semanticBindings, {
            symbol: 1, role: "declaration", filePath, startLine: 5, startColumn: 8, endLine: 5, endColumn: 13
        }],
        semanticImplicitCalls: [analysis.semanticImplicitCalls[0]]
    };
    const ambiguousFact = semanticProjectUnanchoredImplicitCalls(ambiguousAnalysis, ambiguousModel)[0];
    assert.equal(ambiguousFact.ownerBridgeId, 0,
        "an ambiguous sidecar identity must never use the first physical projection as its owner");
    assert.equal(ambiguousFact.ownerSidecarId, 1,
        "the source-independent fallback retains the producer identity for signature comparison");
});

test("project argument-constructor facts require a physical callsite and exact parameter identity", () => {
    const filePath = "/project/arguments.bas";
    const sourceUri = { scheme: "file", fsPath: filePath };
    const parameterToken = { offset: 0 };
    const typeToken = { offset: 16 };
    const model = {
        nativeBindings: [
            { id: 41, kind: "declaration", token: parameterToken },
            { id: 72, kind: "declaration", token: typeToken }
        ],
        expandedToSource: new Map([
            [0, { uri: sourceUri, occurrence: { line: 2, startColumn: 24, endColumn: 28 } }],
            [16, { uri: sourceUri, occurrence: { line: 0, startColumn: 5, endColumn: 15 } }]
        ])
    };
    const analysis = {
        semanticBindings: [
            { symbol: 1, role: "declaration", filePath, startLine: 3, startColumn: 24, endLine: 3, endColumn: 28 },
            { symbol: 3, role: "declaration", filePath, startLine: 1, startColumn: 5, endLine: 1, endColumn: 15 }
        ],
        semanticImplicitCalls: [{
            owner: 1, target: 2, type: 3, kind: "argument-constructor", physical: true,
            targetSignature: "sig1|byval|0|0|7:integer",
            filePath, startLine: 8, startColumn: 14, endLine: 8, endColumn: 20
        }],
        symbolGraph: { symbols: [{ id: 41, symbolClass: 4 }, { id: 72, symbolClass: 10 }] }
    };

    assert.deepEqual(semanticProjectImplicitCalls(analysis, model), [{
        ownerId: 41, targetTypeId: 72, kind: "argument-constructor", targetSignature: "sig1|byval|0|0|7:integer",
        filePath, line: 8, ordinal: 0
    }]);
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], endLine: 9, endColumn: 20 }]
    }, model), [{
        ownerId: 41, targetTypeId: 72, kind: "argument-constructor", targetSignature: "sig1|byval|0|0|7:integer",
        filePath, line: 8, ordinal: 0
    }], "a direct actual expression may span physical source lines");
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        symbolGraph: { symbols: [{ id: 41, symbolClass: 1 }, { id: 72, symbolClass: 10 }] }
    }, model), [], "argument conversions are retained only when the owner is a compiler parameter");
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], physical: false }]
    }, model), [], "expanded or macro-derived actual arguments are not projected as physical callsites");
});

test("project temporary-destructor facts require one exact declared UDT identity", () => {
    const filePath = "/project/temporaries.bas";
    const sourceUri = { scheme: "file", fsPath: filePath };
    const typeToken = { offset: 0 };
    const model = {
        nativeBindings: [{ id: 72, kind: "declaration", token: typeToken }],
        expandedToSource: new Map([[0, { uri: sourceUri, occurrence: { line: 0, startColumn: 5, endColumn: 18 } }]])
    };
    const analysis = {
        semanticBindings: [{ symbol: 3, role: "declaration", filePath, startLine: 1, startColumn: 5, endLine: 1, endColumn: 18 }],
        semanticImplicitCalls: [{
            owner: 3, target: 2, type: 3, kind: "temporary-destructor", physical: true,
            targetSignature: "sig1", filePath, startLine: 9, startColumn: 24, endLine: 9, endColumn: 39
        }],
        symbolGraph: { symbols: [{ id: 72, symbolClass: 10 }] }
    };

    assert.deepEqual(semanticProjectImplicitCalls(analysis, model), [{
        ownerId: 72, targetTypeId: 72, kind: "temporary-destructor", targetSignature: "sig1",
        filePath, line: 9, ordinal: 0
    }]);
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], type: 4 }]
    }, model), [], "the relationship owner and type must map to the same declared symbol");
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], physical: false }]
    }, model), [], "macro-derived or remapped temporary cleanup is not projected");
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        symbolGraph: { symbols: [{ id: 72, symbolClass: 1 }] }
    }, model), [], "only a declared UDT identity can own a temporary destructor");
});

test("project delete-destructor facts require the exact declared pointee UDT", () => {
    const filePath = "/project/delete.bas";
    const sourceUri = { scheme: "file", fsPath: filePath };
    const model = {
        nativeBindings: [{ id: 72, kind: "declaration", token: { offset: 0 } }],
        expandedToSource: new Map([[0, { uri: sourceUri, occurrence: { line: 0, startColumn: 5, endColumn: 15 } }]])
    };
    const analysis = {
        semanticBindings: [{ symbol: 3, role: "declaration", filePath, startLine: 1, startColumn: 5, endLine: 1, endColumn: 15 }],
        semanticImplicitCalls: [{
            owner: 3, target: 2, type: 3, kind: "delete-destructor", physical: true,
            targetSignature: "sig1", filePath, startLine: 8, startColumn: 4, endLine: 8, endColumn: 10
        }],
        symbolGraph: { symbols: [{ id: 72, symbolClass: 10 }] }
    };

    assert.deepEqual(semanticProjectImplicitCalls(analysis, model), [{
        ownerId: 72, targetTypeId: 72, kind: "delete-destructor", targetSignature: "sig1",
        filePath, line: 8, ordinal: 0
    }]);
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], type: 4 }]
    }, model), [], "owner and pointee type must map to the same exact UDT declaration");
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], physical: false }]
    }, model), [], "macro-derived DELETE keywords are not projected into source validation");
});

test("project return-constructor facts allow multiline expressions but require exact UDT identity", () => {
    const filePath = "/project/returns.bas";
    const sourceUri = { scheme: "file", fsPath: filePath };
    const model = {
        nativeBindings: [{ id: 72, kind: "declaration", token: { offset: 0 } }],
        expandedToSource: new Map([[0, { uri: sourceUri, occurrence: { line: 0, startColumn: 5, endColumn: 15 } }]])
    };
    const analysis = {
        semanticBindings: [{ symbol: 3, role: "declaration", filePath, startLine: 1, startColumn: 5, endLine: 1, endColumn: 15 }],
        semanticImplicitCalls: [{
            owner: 3, target: 2, type: 3, kind: "return-constructor", physical: true,
            targetSignature: "sig1", filePath, startLine: 8, startColumn: 11, endLine: 9, endColumn: 15
        }],
        symbolGraph: { symbols: [{ id: 72, symbolClass: 10 }] }
    };

    assert.deepEqual(semanticProjectImplicitCalls(analysis, model), [{
        ownerId: 72, targetTypeId: 72, kind: "return-constructor", targetSignature: "sig1",
        filePath, line: 8, ordinal: 0
    }]);
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], type: 4 }]
    }, model), [], "the return type must map to one exact UDT declaration");
    assert.deepEqual(semanticProjectImplicitCalls({
        ...analysis,
        semanticImplicitCalls: [{ ...analysis.semanticImplicitCalls[0], physical: false }]
    }, model), [], "macro-derived return expressions are not projected into source validation");
});

test("QB foreign string syntax reaches EOF with a terminal semantic model", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot();
    const compilerArguments = [
        "-lang", "qb", "-arch", "x86_64", "-exx",
        "-i", path.join(root, "inc"),
        "-i", path.join(root, "tests/fbcunit/inc")
    ];

    for (const name of ["macro-eval-str.bas", "macro-eval-str-utf16le.bas"]) {
        const filePath = path.join(root, "tests/pp", name);
        const source = decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath).replace(/^\uFEFF/, "");

        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments,
            overlays: new Map([[filePath, source]]),
            allowErrors: true,
            exportSemanticExpressions: true,
            requireSemanticModel: true,
            timeoutMs: 10000
        });
        assert.equal(analysis.completion.reachedEnd, true,
            `${name} must finish parsing instead of aborting during macro-string recovery`);
        assert.equal(analysis.partial, analysis.semanticModelRecovery,
            `${name} compiler and sidecar recovery states must agree`);
        assert.ok(analysis.semanticExpressions.length > 0,
            `${name} must publish typed facts only with a complete or explicit recovery footer`);
    }
});

test("native binding sidecar augments project occurrences only through exact declarations", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "bindings.bas");
    const source = "Dim As Integer boundValue = 1\nboundValue += 2\nPrint boundValue\n";
    fs.writeFileSync(sourcePath, source);
    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/bindings.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const declaration = model.nativeBindings.find((binding) => binding.kind === "declaration" && binding.token.name.toLowerCase() === "boundvalue");
    assert.ok(declaration, "the editor trace should expose the declaration used to anchor identities");
    assert.ok(analysis.semanticBindings.some((binding) => binding.role === "declaration" && binding.name.toLowerCase() === "boundvalue"));
    assert.ok(analysis.semanticBindings.some((binding) => binding.role === "reference" && binding.name.toLowerCase() === "boundvalue"));

    /* Simulate a bridge occurrence gap while retaining its authoritative
       declaration identity. The independent compiler binding should fill
       only exact physical source tokens for that same symbol. */
    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = model.nativeBindings.filter((binding) => binding.kind === "declaration" && binding.id === declaration.id);
    reducedModel.expandedToSource = new Map([...model.expandedToSource].filter(([offset]) => offset === declaration.token.offset));
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    assert.ok(supplemental.length >= 2);
    assert.ok(supplemental.every((binding) => binding.id === declaration.id && binding.kind === "reference"));
    assert.ok(supplemental.every((binding) => source.split("\n")[binding.physical.occurrence.line].slice(
        binding.physical.occurrence.startColumn, binding.physical.occurrence.endColumn
    ).toLowerCase() === "boundvalue"));
});

test("native semantic sidecar reports selected implicit constructors as non-editable relationships", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-implicit-ctors-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "implicit-constructors.bas");
    const source = [
        "Type SidecarWidget",
        "    As Integer marker",
        "    Declare Constructor()",
        "    Declare Constructor(ByRef source As SidecarWidget)",
        "    Declare Constructor(ByVal value As Integer)",
        "End Type",
        "Constructor SidecarWidget()",
        "End Constructor",
        "Constructor SidecarWidget(ByRef source As SidecarWidget)",
        "    This.marker = source.marker",
        "End Constructor",
        "Constructor SidecarWidget(ByVal value As Integer)",
        "    This.marker = value",
        "End Constructor",
        "Type SidecarHolder",
        "    defaultItem As SidecarWidget",
        "    convertedItem As SidecarWidget = 7",
        "End Type",
        "Function sidecarOptionalProbe(ByVal optionalItem As SidecarWidget = 9) As Integer",
        "    Return optionalItem.marker",
        "End Function",
        "Sub sidecarConstructorProbe()",
        "    Dim As SidecarWidget singleValue",
        "    Dim As SidecarWidget arrayValues(0 To 1)",
        "    Dim As SidecarWidget copiedValue = singleValue",
        "    Dim As SidecarWidget convertedValue = 7",
        "    Dim As SidecarWidget Ptr allocatedValue = New SidecarWidget(7)",
        "    Dim As SidecarWidget Ptr allocatedArray = New SidecarWidget[2]",
        "    Dim As SidecarWidget Ptr allocatedDefault = New SidecarWidget",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticImplicitCalls.length, 10);
    const calls = analysis.semanticImplicitCalls.sort((first, second) => first.startLine - second.startLine);
    assert.ok(calls.every((call) => call.physical));
    const sourceLines = source.split("\n");
    const callAnchors = calls.map((call) => ({
        name: sourceLines[call.startLine - 1].slice(call.startColumn, call.endColumn),
        kind: call.kind,
        target: call.target
    }));
    assert.deepEqual(callAnchors.map(({ name, kind }) => [name, kind]), [
        ["defaultItem", "default-constructor"], ["convertedItem", "initializer-constructor"],
        ["optionalItem", "initializer-constructor"], ["singleValue", "default-constructor"],
        ["arrayValues", "default-constructor"], ["copiedValue", "initializer-constructor"],
        ["convertedValue", "initializer-constructor"], ["SidecarWidget", "new-constructor"],
        ["SidecarWidget", "new-constructor"], ["SidecarWidget", "new-constructor"]
    ]);
    assert.equal(callAnchors[0].target, callAnchors[3].target, "field default initialization selects the same constructor as a local variable");
    assert.equal(callAnchors[1].target, callAnchors[2].target, "field and optional-parameter conversions preserve the selected overload");
    assert.equal(callAnchors[1].target, callAnchors[6].target);
    assert.deepEqual(calls.map((call) => call.kind), [
        "default-constructor", "initializer-constructor", "initializer-constructor", "default-constructor",
        "default-constructor", "initializer-constructor", "initializer-constructor", "new-constructor",
        "new-constructor", "new-constructor"
    ]);
    assert.equal(calls[3].target, calls[4].target);
    assert.notEqual(calls[5].target, calls[3].target);
    assert.notEqual(calls[6].target, calls[3].target);
    assert.notEqual(calls[5].target, calls[6].target);
    assert.equal(calls[8].target, calls[3].target, "NEW vector elements select the declared default constructor");
    assert.equal(calls[9].target, calls[3].target, "scalar NEW without parentheses selects the declared default constructor");
    assert.ok(calls.every((call) => call.targetSignature.startsWith("sig2")));
    assert.equal(calls[0].targetSignature, calls[3].targetSignature);
    assert.notEqual(calls[5].targetSignature, calls[6].targetSignature);
    assert.ok(!calls[5].targetSignature.toLowerCase().includes("sidecarwidget"), "copy-constructor signatures normalize their owner type across UDT renames");
    assert.equal(calls[8].targetSignature, calls[3].targetSignature);
    assert.equal(calls[9].targetSignature, calls[3].targetSignature);
    assert.notEqual(calls[7].targetSignature, calls[8].targetSignature);

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/implicit-constructors.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const relationships = semanticProjectImplicitCalls(analysis, model);
    assert.equal(relationships.length, 10,
        `project facts require compiler declaration identities for the owner and its selected constructor type (${JSON.stringify(relationships)})`);
    assert.deepEqual(relationships.map((relationship) => relationship.kind).sort(), [
        "default-constructor", "default-constructor", "default-constructor", "initializer-constructor",
        "initializer-constructor", "initializer-constructor", "initializer-constructor", "new-constructor",
        "new-constructor", "new-constructor"
    ]);
    assert.ok(relationships.filter((relationship) => relationship.kind !== "new-constructor")
        .every((relationship) => relationship.ownerId !== relationship.targetTypeId));
    assert.ok(relationships.filter((relationship) => relationship.kind === "new-constructor")
        .every((relationship) => relationship.ownerId === relationship.targetTypeId),
    "NEW constructor records are anchored to the exact compiler-bound type reference");
});

test("compiler preprocessor origins preserve REM identifiers in malformed conditional-option buffers", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-rem-option-context-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "conditional-option.bas");
    const source = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub Probe()",
        "    Dim REM As Integer",
        "    REM = REM + (1",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        allowErrors: true,
        exportSemanticBindings: true,
        timeoutMs: 20000
    });

    assert.equal(analysis.partial, true, "the unmatched expression should retain a compiler diagnostic");
    assert.ok(analysis.compilerRemKeywordDisableOptions.some((option) =>
        option.filePath === sourcePath && option.line === 3),
    "the compiler's active preprocessed stream must confirm the conditional option occurrence");

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/conditional-option.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const disabledLineOffsets = model.compilerRemKeywordDisabledLineOffsets(uri);
    assert.deepEqual(disabledLineOffsets, [source.indexOf("Option NoKeyword REM")]);
    const workerOverrides = queryCompilerModel(model, "compilerBracketMaskOverrides", {
        uri, position: { line: 0, character: 0 }
    }, () => {});
    assert.deepEqual(workerOverrides.remIdentifierOffsets, []);
    assert.deepEqual(workerOverrides.remKeywordDisabledLineOffsets, disabledLineOffsets,
        "the worker query path must return the bounded compiler-confirmed option line");
    assert.deepEqual(findBracketProblems(source, [], null, disabledLineOffsets).map((problem) => [
        source.slice(problem.start, problem.end), problem.code
    ]), [["(", "unclosed-bracket"]]);

    const inactiveSourcePath = path.join(directory, "inactive-option.bas");
    const inactiveSource = '#lang "deprecated"\n#if 0\nOption NoKeyword REM\n#endif\nREM = (1\n';
    fs.writeFileSync(inactiveSourcePath, inactiveSource);
    const inactiveAnalysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath: inactiveSourcePath,
        overlays: new Map([[inactiveSourcePath, inactiveSource]]),
        allowErrors: true,
        timeoutMs: 20000
    });
    assert.deepEqual(inactiveAnalysis.compilerRemKeywordDisableOptions, [],
        "an option hidden by the compiler's inactive branch must not change source comment boundaries");

    const macroSourcePath = path.join(directory, "macro-option.bas");
    const macroSource = '#lang "deprecated"\n#macro LocalOption()\nOption NoKeyword REM\n#endmacro\nREM = (1\n';
    fs.writeFileSync(macroSourcePath, macroSource);
    const macroAnalysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath: macroSourcePath,
        overlays: new Map([[macroSourcePath, macroSource]]),
        allowErrors: true,
        timeoutMs: 20000
    });
    assert.deepEqual(macroAnalysis.compilerRemKeywordDisableOptions, [],
        "text inside a macro definition is not an accepted source-level option");
});

test("complete stock sidecars keep compiler-bound REM tokens visible to source indexing", {
    skip: !(process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE)
}, async (t) => {
    const compiler = process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-rem-sidecar-index-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "conditional-rem.bas");
    const source = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub Probe()",
        "    Dim REM As Integer",
        "    REM = (1 + 2)",
        "    Print REM",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, source);
    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath,
        overlays: new Map([[filePath, source]]),
        semanticModelOnly: true,
        exportSemanticBindings: true,
        requireSemanticModel: true,
        timeoutMs: 20000
    });
    assert.equal(analysis.semanticSidecarOnly, true);
    assert.equal(analysis.partial, false);

    const uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/conditional-rem-sidecar.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const tokens = model.getDocument(uri).tokens.filter((token) => token.name.toLowerCase() === "rem");
    const offsets = model.compilerRemIdentifierOffsets(uri);
    assert.deepEqual(tokens.map((token) => token.line), [5, 6, 7]);
    assert.equal(offsets.length, 3);
    assert.ok(offsets.every((offset) => source.slice(offset, offset + 3) === "REM"));
    const masked = maskFreeBasicText(source, offsets);
    assert.ok(offsets.every((offset) => masked.slice(offset, offset + 3) === "REM"),
        "only physical REM tokens selected as identifiers by FBC may bypass comment masking");
});

test("EXIT SUB cleanup keeps sidecar analysis complete across language modes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");

    for (const mode of ["fb", "fblite", "qb"]) {
        const filePath = path.join(root, `tests/scopes/select-temp-var-vs-unscoping-${mode}.bas`);
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
            allowErrors: true,
            exportSemanticBindings: true,
            requireSemanticModel: true
        });

        assert.equal(analysis.partial, false, `${mode} trace must reach the compiler terminal record`);
        assert.equal(analysis.completion.reachedEnd, true, `${mode} source must finish parsing`);
        assert.ok(analysis.semanticModelCounts.bindingCount > 0, `${mode} sidecar must contain resolved bindings`);
    }
});

test("schema-27 retains accepted Cva_List source operations without guessed callees", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-cva-source-operations-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "cva-list-operations.bas");
    const source = "'' Accepted C vararg source operations.\n" +
        "#Lang \"fb\"\n" +
        "Private Sub ObserveArguments Cdecl(ByVal Count As Integer, ...)\n" +
        "    Dim Arguments As Cva_List = Any\n" +
        "    Dim CopyArguments As Cva_List = Any\n" +
        "    Cva_Start(Arguments, Count)\n" +
        "    Cva_Copy(CopyArguments, Arguments)\n" +
        "    Dim Value As Integer = Cva_Arg(CopyArguments, Integer)\n" +
        "    Cva_End(CopyArguments)\n" +
        "    Cva_End(Arguments)\n" +
        "End Sub\n";
    fs.writeFileSync(filePath, source);
    const compilerArguments = ["-lang", "fb", "-i", path.join(root, "inc")];
    const full = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(full.partial, false);
    assert.equal(full.semanticCapabilities.find((capability) => capability.feature === "source-va-list-operations")?.coverage, "available");
    const operations = full.semanticExpressionOperands.filter((operation) => operation.family === "runtime-macro");
    assert.deepEqual(operations.map((operation) => operation.operator).sort(), [
        "va-arg", "va-copy", "va-end", "va-end", "va-start"
    ]);
    assert.ok(operations.filter((operation) => ["va-start", "va-copy"].includes(operation.operator))
        .every((operation) => operation.left > 0 && operation.right > 0));
    assert.ok(operations.filter((operation) => ["va-arg", "va-end"].includes(operation.operator))
        .every((operation) => operation.left > 0 && operation.right === 0));
    const typedArgument = operations.find((operation) => operation.operator === "va-arg");
    assert.ok(full.semanticExpressions.some((expression) => expression.id === typedArgument.identity && expression.typeName),
        "Cva_Arg remains a typed value expression");
    const sourceUri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    const sourceModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/cva-list-operations.bas" },
        full,
        [{ uri: sourceUri, text: source }]
    );
    const cvaArgLine = source.split("\n").findIndex((line) => line.includes("Cva_Arg"));
    const cvaArgColumn = source.split("\n")[cvaArgLine].indexOf("Cva_Arg");
    const cvaArgHover = queryCompilerModel(sourceModel, "hover", {
        uri: sourceUri,
        position: { line: cvaArgLine, character: cvaArgColumn + 2 }
    }, () => {});
    assert.deepEqual({
        operator: cvaArgHover.expressionOperation?.sourceOperation?.operator,
        operandType: cvaArgHover.expressionOperation?.sourceOperation?.leftTypeName,
        resultType: cvaArgHover.expressionOperation?.typeName
    }, { operator: "va-arg", operandType: "__VA_LIST_TAG", resultType: "integer" });
    for (const operation of operations.filter((candidate) => ["va-start", "va-copy", "va-end"].includes(candidate.operator))) {
        assert.equal(operation.physical, true, `${operation.operator} must have a physical source operator range`);
        const operationHover = queryCompilerModel(sourceModel, "hover", {
            uri: sourceUri,
            position: { line: operation.startLine - 1, character: operation.startColumn + 1 }
        }, () => {});
        assert.equal(operationHover.expressionOperation?.sourceOperation?.operator, operation.operator,
            `${operation.operator} should map to its compiler-reported statement operation`);
        assert.equal(typeof operationHover.expressionOperation?.sourceOperation?.leftTypeName, "string");
        if (["va-start", "va-copy"].includes(operation.operator)) {
            assert.equal(typeof operationHover.expressionOperation.sourceOperation.rightTypeName, "string");
        }
    }

    const bindings = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments,
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(bindings.semanticCapabilities.find((capability) => capability.feature === "source-va-list-operations")?.coverage, "available");
    assert.deepEqual(bindings.semanticExpressionOperands
        .filter((operation) => operation.family === "runtime-macro")
        .map((operation) => operation.operator).sort(), [
        "va-arg", "va-copy", "va-end", "va-end", "va-start"
    ]);
});

test("nonphysical implicit calls remain available for project refactoring validation", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/implicit-call-coordinates.bas");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-lang", "fb", "-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.semanticImplicitCalls.length, analysis.semanticModelCounts.implicitCallCount,
        "the binding-capable reader must retain the complete implicit-call inventory");
    const unanchored = analysis.semanticImplicitCalls.filter((call) => call.physical === false);
    const macroCalls = unanchored.filter((call) => call.filePath === filePath);
    const remappedCalls = unanchored.filter((call) => call.filePath.endsWith("virtual-construction.bas"));
    assert.equal(macroCalls.length, 1,
        "a macro-generated construction must retain its nonphysical invocation anchor");
    assert.equal(remappedCalls.length, 1,
        "the upstream #LINE construction must retain its nonphysical selected-constructor relation");
    const macroInvocationLine = fs.readFileSync(filePath, "utf8").split(/\r?\n/)
        .findIndex((line) => line.startsWith("CONSTRUCT_ONE(")) + 1;
    assert.equal(macroCalls[0].startLine, macroInvocationLine);
    assert.equal(remappedCalls[0].startLine, 801);

    const sources = analysis.dependencies.map((dependency) => {
        const text = decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "");
        return {
            uri: { scheme: "file", fsPath: dependency, toString: () => `file://${dependency}` },
            text
        };
    });
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/implicit-call-coordinates.bas" },
        analysis,
        sources
    );
    const physical = semanticProjectImplicitCalls(analysis, model);
    assert.ok(unanchored.every((call) => physical.every((physicalCall) =>
        physicalCall.line !== call.startLine || physicalCall.filePath !== call.filePath)),
        "virtual source coordinates must not be projected as editable physical callsites");
    const retained = semanticProjectUnanchoredImplicitCalls(analysis, model);
    const expectedRetained = unanchored
        .map((call) => [call.filePath, call.kind, call.targetSignature, 1].join("\t"))
        .sort();
    const actualRetained = retained
        .map((call) => [call.filePath, call.kind, call.targetSignature, call.count].join("\t"))
        .sort();
    assert.deepEqual(actualRetained, expectedRetained,
        "project validation must preserve both macro-invocation and #LINE constructor relationships");
});

test("native semantic sidecar anchors argument conversions to their actual expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-argument-ctors-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "argument-constructors.bas");
    const source = [
        "Type SidecarArgumentSource",
        "    marker As Integer",
        "End Type",
        "Type SidecarArgumentTarget",
        "    marker As Integer",
        "    Declare Destructor()",
        "    Declare Constructor(ByVal value As Integer)",
        "    Declare Constructor(ByRef value As SidecarArgumentSource)",
        "End Type",
        "Destructor SidecarArgumentTarget()",
        "End Destructor",
        "Constructor SidecarArgumentTarget(ByVal value As Integer)",
        "    This.marker = value",
        "End Constructor",
        "Constructor SidecarArgumentTarget(ByRef value As SidecarArgumentSource)",
        "    This.marker = value.marker",
        "End Constructor",
        "#define CALL_CONVERTED_ARGUMENT consumeArgument(17)",
        "#define FORWARD_CONVERTED_ARGUMENT(value) consumeArgument(value)",
        "#define PASTE_CONVERTED_ARGUMENT(prefix, suffix) consumeArgument(prefix##suffix)",
        "Sub consumeArgument(ByVal item As SidecarArgumentTarget)",
        "End Sub",
        "Sub sidecarArgumentProbe()",
        "    Dim As SidecarArgumentSource sourceItem",
        "    consumeArgument(7)",
        "    consumeArgument(sourceItem)",
        "    consumeArgument( _",
        "        7 + 8)",
        "    CALL_CONVERTED_ARGUMENT",
        "    FORWARD_CONVERTED_ARGUMENT(sourceItem)",
        "    PASTE_CONVERTED_ARGUMENT(source, Item)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const calls = analysis.semanticImplicitCalls.filter((call) => call.kind === "argument-constructor")
        .sort((first, second) => first.startLine - second.startLine);
    assert.equal(calls.length, 3,
        "only direct source arguments and the continued call have editable physical spans; macro selections stay in construction observations");
    const sourceLines = source.split("\n");
    assert.ok(calls.every((call) => call.physical));
    assert.deepEqual(calls.slice(0, 2).map((call) => sourceLines[call.startLine - 1].slice(call.startColumn, call.endColumn)), ["(7)", "(sourceItem)"]);
    assert.ok(calls[2].endLine > calls[2].startLine, "a direct continued argument retains its complete physical range");
    assert.ok(sourceLines.slice(calls[2].startLine - 1, calls[2].endLine).join("\n").includes("7 + 8"));
    assert.notEqual(calls[0].target, calls[1].target, "the semantic model retains the constructor selected for each actual argument");
    assert.ok(calls.every((call) => call.targetSignature.startsWith("sig2")));

    const constructionObservations = analysis.semanticProperties.filter((property) =>
        property.name.startsWith("construction-observation:"));
    assert.equal(constructionObservations.length, 6,
        "the model retains each selected constructor across direct, continued, and macro-expanded argument sites");
    assert.ok(constructionObservations.every((property) => property.value.split("\t")[2] === "argument-constructor"));
    assert.equal(analysis.semanticProperties.find((property) =>
        property.name.startsWith("construction-observation-count:"))?.value, "6",
    "the compiler publishes a closure count for constructor observations without editable ranges");
    assert.ok(analysis.semanticCapabilities.some((capability) =>
        capability.feature === "implicit-construction-inputs" && capability.coverage === "available"));

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/argument-constructors.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const relationships = semanticProjectImplicitCalls(analysis, model)
        .filter((relationship) => relationship.kind === "argument-constructor");
    assert.equal(relationships.length, 3,
        "project references include only exact physical argument construction calls");
    assert.ok(relationships.every((relationship) => relationship.kind === "argument-constructor"));
    assert.equal(relationships[0].ownerId, relationships[1].ownerId, "both conversions belong to the exact declared formal parameter");
    assert.equal(relationships[0].targetTypeId, relationships[1].targetTypeId);
});

test("native implicit-call signatures normalize optional flags to stable booleans", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-optional-signature-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "optional-signature.bas");
    const source = [
        "Type OptionalSignatureTarget",
        "    marker As Integer",
        "    Declare Constructor(ByVal value As Integer = 17)",
        "End Type",
        "Constructor OptionalSignatureTarget(ByVal value As Integer)",
        "    This.marker = value",
        "End Constructor",
        "Sub optionalSignatureProbe()",
        "    Dim As OptionalSignatureTarget value",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    const call = analysis.semanticImplicitCalls.find((entry) => entry.kind === "default-constructor");
    assert.ok(call, "the optional-argument constructor should be selected for default construction");
    const parameters = call.targetSignature.split("|").slice(1);
    assert.equal(parameters.length % 5, 0);
    assert.ok(parameters.length >= 5);
    assert.equal(parameters[0], "byval");
    assert.equal(parameters[1], "1", "FreeBASIC TRUE must serialize as stable one, not -1");
});

test("native semantic sidecar anchors selected field and variable destructors to declarations", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-implicit-dtors-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "implicit-destructors.bas");
    const source = [
        "Type SidecarDtorItem",
        "    marker As Long",
        "    Declare Destructor()",
        "End Type",
        "Destructor SidecarDtorItem()",
        "    This.marker = 0",
        "End Destructor",
        "Type SidecarDtorHolder",
        "    item As SidecarDtorItem",
        "End Type",
        "Sub sidecarDtorProbe()",
        "    Dim As SidecarDtorItem localItem",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const calls = analysis.semanticImplicitCalls.filter((call) => call.kind === "destructor-call");
    assert.equal(calls.length, 2);
    const sourceLines = source.split("\n");
    assert.deepEqual(calls.map((call) => sourceLines[call.startLine - 1].slice(call.startColumn, call.endColumn)), ["item", "localItem"]);
    assert.ok(calls.every((call) => call.physical && call.targetSignature === "sig2"));

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/implicit-destructors.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const relationships = semanticProjectImplicitCalls(analysis, model).filter((relationship) => relationship.kind === "destructor-call");
    assert.equal(relationships.length, 2,
        "field and variable destructor facts require exact compiler declaration identities");
    assert.ok(relationships.every((relationship) => relationship.ownerId !== relationship.targetTypeId));
});

test("native semantic sidecar anchors emitted temporary UDT destructors to their creating expression", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-temporary-dtors-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "temporary-destructors.bas");
    const source = [
        "Type SidecarTemporary",
        " marker As Integer",
        " Declare Constructor()",
        " Declare Destructor()",
        "End Type",
        "Declare Function makeTemporary() As SidecarTemporary",
        "Type SidecarContainer",
        " inner As SidecarTemporary = makeTemporary()",
        " Declare Constructor()",
        "End Type",
        "Type SidecarTypeIni",
        " marker As Integer",
        " Declare Destructor()",
        "End Type",
        "Constructor SidecarTemporary()",
        "End Constructor",
        "Destructor SidecarTemporary()",
        "End Destructor",
        "Destructor SidecarTypeIni()",
        "End Destructor",
        "Function makeTemporary() As SidecarTemporary",
        " Return SidecarTemporary()",
        "End Function",
        "Constructor SidecarContainer()",
        "End Constructor",
        "Sub temporaryDestructorProbe()",
        " Dim As SidecarContainer holder",
        " Dim As SidecarTemporary result = makeTemporary()",
        " Dim As Integer choose = 1",
        " Dim As Integer nested = 1 + IIf(choose, makeTemporary(), makeTemporary()).marker",
        " If (Type<SidecarTypeIni>(123)).marker = 123 Then",
        " End If",
        " If (makeTemporary()).marker = 123 Then",
        " End If",
        " With Type<SidecarTypeIni>(456)",
        "  .marker = 789",
        " End With",
        " Dim As SidecarTypeIni assignmentTarget",
        " assignmentTarget = Type<SidecarTypeIni>(654)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const calls = analysis.semanticImplicitCalls.filter((call) => call.kind === "temporary-destructor");
    const lines = source.split("\n");
    const plainLine = lines.findIndex((line) => line.includes("result = makeTemporary()")) + 1;
    const iifLine = lines.findIndex((line) => line.includes("IIf(choose, makeTemporary(), makeTemporary())")) + 1;
    const typeIniBranchLine = lines.findIndex((line) => line.includes("If (Type<SidecarTypeIni>(123))")) + 1;
    const callBranchLine = lines.findIndex((line) => line.includes("If (makeTemporary()).marker = 123")) + 1;
    const withLine = lines.findIndex((line) => line.includes("With Type<SidecarTypeIni>(456)")) + 1;
    const assignmentLine = lines.findIndex((line) => line.includes("assignmentTarget = Type<SidecarTypeIni>(654)")) + 1;
    const fieldInitializerLine = lines.findIndex((line) => line.includes("inner As SidecarTemporary = makeTemporary()")) + 1;
    assert.ok(calls.length >= 6, "call, IIF-result, both branch forms, WITH-lifetime, and late-lowered temporaries are represented");
    const plainCall = calls.find((call) => call.startLine === plainLine);
    assert.ok(plainCall?.physical);
    assert.equal(plainCall.owner, plainCall.type, "temporary destruction is owned by the exact UDT identity");
    assert.equal(lines[plainCall.startLine - 1].slice(plainCall.startColumn, plainCall.endColumn), "makeTemporary()");
    assert.equal(plainCall.targetSignature, "sig2");
    const clonedInitializerCall = calls.find((call) => call.startLine === fieldInitializerLine);
    assert.ok(clonedInitializerCall?.physical,
        "temporary destructors from a cloned TYPEINI retain the field initializer's physical range");
    assert.equal(lines[clonedInitializerCall.startLine - 1].slice(clonedInitializerCall.startColumn, clonedInitializerCall.endColumn),
        "makeTemporary()");
    assert.ok(calls.some((call) => call.startLine === iifLine &&
        lines[call.startLine - 1].slice(call.startColumn, call.endColumn) ===
            "IIf(choose, makeTemporary(), makeTemporary())"),
    "the compiler-generated IIF result temporary is anchored to the IIF, not its enclosing arithmetic expression");
    const typeIniBranchCall = calls.find((call) => call.startLine === typeIniBranchLine);
    assert.ok(typeIniBranchCall?.physical, "the TYPEINI-generated branch temporary has physical source provenance");
    assert.equal(typeIniBranchCall.owner, typeIniBranchCall.type, "the branch temporary is owned by its exact UDT identity");
    assert.equal(lines[typeIniBranchCall.startLine - 1].slice(typeIniBranchCall.startColumn, typeIniBranchCall.endColumn),
        "Type<SidecarTypeIni>(123)");
    assert.equal(typeof typeIniBranchCall.targetSignature, "string");
    const callBranch = calls.find((call) => call.startLine === callBranchLine);
    assert.ok(callBranch?.physical, "parser-created condition temporaries retain their exact call expression");
    assert.equal(lines[callBranch.startLine - 1].slice(callBranch.startColumn, callBranch.endColumn),
        "makeTemporary()");
    const withCall = calls.find((call) => call.startLine === withLine);
    assert.ok(withCall?.physical, "the WITH-lifetime destructor has physical source provenance");
    assert.equal(withCall.owner, withCall.type, "the WITH temporary destructor is owned by its exact UDT identity");
    assert.equal(lines[withCall.startLine - 1].slice(withCall.startColumn, withCall.endColumn),
        "Type<SidecarTypeIni>(456)");
    const assignmentCall = calls.find((call) => call.startLine === assignmentLine);
    assert.ok(assignmentCall?.physical, "the astUpdate-lowered destructor has physical source provenance");
    assert.equal(assignmentCall.owner, assignmentCall.type, "the late-lowered temporary destructor is owned by its exact UDT identity");
    assert.equal(lines[assignmentCall.startLine - 1].slice(assignmentCall.startColumn, assignmentCall.endColumn),
        "Type<SidecarTypeIni>(654)");

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/temporary-destructors.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const relationships = semanticProjectImplicitCalls(analysis, model).filter((relationship) => relationship.kind === "temporary-destructor");
    assert.ok(relationships.length >= 2);
    assert.ok(relationships.some((relationship) => relationship.line === plainLine));
    assert.ok(relationships.some((relationship) => relationship.line === fieldInitializerLine));
    assert.ok(relationships.some((relationship) => relationship.line === iifLine));
    assert.ok(relationships.some((relationship) => relationship.line === typeIniBranchLine));
    assert.ok(relationships.some((relationship) => relationship.line === callBranchLine));
    assert.ok(relationships.some((relationship) => relationship.line === withLine));
    assert.ok(relationships.some((relationship) => relationship.line === assignmentLine));
    assert.ok(relationships.every((relationship) => relationship.ownerId === relationship.targetTypeId),
        "the relationship is retained for compiler comparison but never becomes a token edit");
});

test("native semantic sidecar records declared-local destructors at physical scope exits", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-scope-exit-dtors-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "scope-exit-destructors.bas");
    const source = [
        "#define scopeExitMacro Goto macroFinished",
        "Type ScopeExitItem",
        "    marker As Long",
        "    Declare Destructor()",
        "End Type",
        "Destructor ScopeExitItem()",
        "    This.marker = 0",
        "End Destructor",
        "Sub gotoCleanup()",
        "    Scope",
        "        Dim As ScopeExitItem scopedItem",
        "        Goto finished",
        "    End Scope",
        "finished:",
        "End Sub",
        "Sub exitCleanup()",
        "    Dim As ScopeExitItem localItem",
        "    Exit Sub",
        "End Sub",
        "Function returnCleanup() As Long",
        "    Dim As ScopeExitItem localItem",
        "    Return 1",
        "End Function",
        "Sub continueCleanup()",
        "    Dim index As Long",
        "    For index = 1 To 2",
        "        Scope",
        "            Dim As ScopeExitItem continuedItem",
        "            Continue For",
        "        End Scope",
        "    Next",
        "End Sub",
        "Sub exitForCleanup()",
        "    For index As Long = 1 To 2",
        "        Scope",
        "            Dim As ScopeExitItem exitForItem",
        "            Exit For",
        "        End Scope",
        "    Next",
        "End Sub",
        "Sub continueDoCleanup()",
        "    Do",
        "        Scope",
        "            Dim As ScopeExitItem continueDoItem",
        "            Continue Do",
        "        End Scope",
        "    Loop",
        "End Sub",
        "Sub exitDoCleanup()",
        "    Do",
        "        Scope",
        "            Dim As ScopeExitItem exitDoItem",
        "            Exit Do",
        "        End Scope",
        "    Loop",
        "End Sub",
        "Sub continueWhileCleanup()",
        "    Dim index As Long",
        "    While index < 2",
        "        Scope",
        "            Dim As ScopeExitItem continueWhileItem",
        "            index += 1",
        "            Continue While",
        "        End Scope",
        "    Wend",
        "End Sub",
        "Sub exitWhileCleanup()",
        "    While True",
        "        Scope",
        "            Dim As ScopeExitItem exitWhileItem",
        "            Exit While",
        "        End Scope",
        "    Wend",
        "End Sub",
        "Sub macroCleanup()",
        "    Scope",
        "        Dim As ScopeExitItem macroItem",
        "        scopeExitMacro",
        "    End Scope",
        "macroFinished:",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const calls = analysis.semanticImplicitCalls.filter((call) => call.kind === "scope-exit-destructor");
    const lines = source.split("\n");
    assert.equal(calls.length, 9,
        "GOTO, EXIT SUB, RETURN, and loop EXIT/CONTINUE forms each lower a declared-local destructor");
    assert.deepEqual(calls.map((call) => lines[call.startLine - 1].slice(call.startColumn, call.endColumn)), [
        "Goto", "Exit", "Return", "Continue", "Exit", "Continue", "Exit", "Continue", "Exit"
    ]);
    assert.ok(calls.every((call) => call.physical && call.targetSignature === "sig2"));
    assert.ok(calls.every((call) => call.owner !== call.type), "declared variables own their cleanup; the UDT remains the exact selected type");

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/scope-exit-destructors.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const relationships = semanticProjectImplicitCalls(analysis, model)
        .filter((relationship) => relationship.kind === "scope-exit-destructor");
    assert.equal(relationships.length, calls.length,
        "control-flow cleanup joins only through each exact local declaration and UDT identity");
    assert.ok(relationships.every((relationship) => relationship.ownerId !== relationship.targetTypeId),
        "the semantic edge is retained for compiler comparison and never treated as an edit token");
});

test("native semantic sidecar records scalar and vector DELETE destructor selections", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-delete-dtors-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "delete-destructors.bas");
    const source = [
        "Type DeleteSemanticItem",
        "    marker As Long",
        "    Declare Destructor()",
        "End Type",
        "Destructor DeleteSemanticItem()",
        "    This.marker = 0",
        "End Destructor",
        "Sub deleteSemanticItems()",
        "    Dim As DeleteSemanticItem Ptr item = New DeleteSemanticItem",
        "    Delete item",
        "    Dim As DeleteSemanticItem Ptr items = New DeleteSemanticItem[2]",
        "    Delete[] items",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const calls = analysis.semanticImplicitCalls.filter((call) => call.kind === "delete-destructor");
    const lines = source.split("\n");
    assert.equal(calls.length, 2, "scalar and vector DELETE each select the pointee UDT destructor");
    assert.deepEqual(calls.map((call) => lines[call.startLine - 1].slice(call.startColumn, call.endColumn)), ["Delete", "Delete"]);
    assert.ok(calls.every((call) => call.physical && call.targetSignature === "sig2" && call.owner === call.type));

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/delete-destructors.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const relationships = semanticProjectImplicitCalls(analysis, model)
        .filter((relationship) => relationship.kind === "delete-destructor");
    assert.equal(relationships.length, calls.length,
        "delete cleanup retains the exact declared UDT identity for compiler comparison only");
    assert.ok(relationships.every((relationship) => relationship.ownerId === relationship.targetTypeId));
});

test("native semantic sidecar records constructors selected for UDT return expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-return-ctors-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "return-constructors.bas");
    const source = [
        "Type ReturnSemanticItem",
        "    marker As Long",
        "    Declare Constructor(ByVal value As Long)",
        "End Type",
        "Constructor ReturnSemanticItem(ByVal value As Long)",
        "    This.marker = value",
        "End Constructor",
        "Function makeReturnSemanticItem() As ReturnSemanticItem",
        "    Return _",
        "        40 + _",
        "        2",
        "End Function",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const calls = analysis.semanticImplicitCalls.filter((call) => call.kind === "return-constructor");
    const lines = source.split("\n");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].startLine, 10);
    assert.equal(calls[0].endLine, 11, "continued RETURN expressions retain their full physical span");
    assert.equal(lines[calls[0].startLine - 1].slice(calls[0].startColumn, calls[0].startColumn + 2), "40");
    assert.equal(lines[calls[0].endLine - 1].slice(calls[0].endColumn - 1, calls[0].endColumn), "2");
    assert.ok(calls[0].physical, JSON.stringify(calls));
    assert.match(calls[0].targetSignature, /^sig2\|byval\|0\|0\|\d+\|0$/, JSON.stringify(calls));
    assert.equal(calls[0].owner, calls[0].type, "return construction is owned by its exact declared UDT");

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/return-constructors.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const relationships = semanticProjectImplicitCalls(analysis, model)
        .filter((relationship) => relationship.kind === "return-constructor");
    assert.equal(relationships.length, 1);
    assert.equal(relationships[0].ownerId, relationships[0].targetTypeId);
});

test("native binding sidecar preserves compiler-resolved inline assembly identifiers for project edits", { skip: !process.env.FBC_EDITOR_EXECUTABLE || !supportsIntelInlineAssembly }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-asm-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "inline-asm.bas");
    const source = [
        "Sub semantic_asm_target()",
        "End Sub",
        "Const As Integer semantic_asm_constant = 7",
        "Sub semantic_asm_probe()",
        "    Dim As Integer semantic_asm_value",
        "    asm mov eax, semantic_asm_value",
        "    asm call semantic_asm_target",
        "semantic_asm_label:",
        "    asm jmp semantic_asm_label",
        "    asm mov eax, semantic_asm_constant",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const semanticBySite = (role, line, name) => analysis.semanticBindings.find((binding) =>
        binding.role === role && binding.startLine === line + 1 &&
        source.split("\n")[line].slice(binding.startColumn, binding.endColumn).toLowerCase() === name.toLowerCase());
    const targetDeclaration = semanticBySite("declaration", 0, "semantic_asm_target");
    const constantDeclaration = semanticBySite("declaration", 2, "semantic_asm_constant");
    const valueDeclaration = semanticBySite("declaration", 4, "semantic_asm_value");
    const labelDeclaration = semanticBySite("declaration", 7, "semantic_asm_label");
    assert.ok(targetDeclaration, "compiler model should expose the procedure declaration");
    assert.ok(constantDeclaration, "compiler model should expose the constant declaration");
    assert.ok(valueDeclaration, "compiler model should expose the variable declaration");
    assert.ok(labelDeclaration, "compiler model should expose the label declaration");

    const references = [
        semanticBySite("reference", 5, "semantic_asm_value"),
        semanticBySite("reference", 6, "semantic_asm_target"),
        semanticBySite("reference", 8, "semantic_asm_label"),
        semanticBySite("reference", 9, "semantic_asm_constant")
    ];
    assert.ok(references.every(Boolean), "inline assembly should retain resolved variable, procedure, label, and constant references");
    assert.deepEqual(references.map((binding) => binding.symbol), [
        valueDeclaration.symbol,
        targetDeclaration.symbol,
        labelDeclaration.symbol,
        constantDeclaration.symbol
    ]);

    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/inline-asm.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const nativeTarget = model.nativeBindings.find((binding) => binding.kind === "declaration" &&
        binding.token.name.toLowerCase() === "semantic_asm_target");
    assert.ok(nativeTarget, "bridge declaration identity should anchor the sidecar symbol safely");

    /* The specialized ASM parser is not part of the bridge's ordinary
       identifier hook. Remove its reference from the bridge view and verify
       compiler-selected sidecar bindings restore only the matching symbol. */
    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = model.nativeBindings.filter((binding) => binding.kind === "declaration" && binding.id === nativeTarget.id);
    reducedModel.expandedToSource = new Map([...model.expandedToSource].filter(([offset]) => offset === nativeTarget.token.offset));
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    const asmTargetReference = supplemental.find((binding) => binding.id === nativeTarget.id && binding.kind === "reference" && binding.line === 7);
    assert.ok(asmTargetReference, "sidecar binding should supplement the compiler-resolved ASM call for project rename");
    assert.equal(asmTargetReference.physical.occurrence.name.toLowerCase(), "semantic_asm_target");
});

test("native binding sidecar retains implicit WITH member identities", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-with-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "with.bas");
    const source = [
        "Type RecordType",
        "    value As Integer",
        "End Type",
        "Dim item As RecordType",
        "With item",
        "    .value = 1",
        "    Print .value",
        "End With",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);
    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/with.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const sourceOccurrence = (binding) => model.expandedToSource.get(binding.token.offset)?.occurrence;
    const field = model.nativeBindings.find((binding) => {
        const occurrence = sourceOccurrence(binding);
        return binding.kind === "declaration" && binding.token.name.toLowerCase() === "value" &&
            occurrence?.line === 1 && occurrence.startColumn === 4;
    });
    assert.ok(field, "the bridge should expose the aggregate field declaration");
    const expectedSites = [[6, 5], [7, 11]];
    const sidecarReferences = expectedSites.map(([line, column]) => analysis.semanticBindings.find((binding) =>
        binding.role === "reference" && binding.startLine === line && binding.startColumn === column &&
        source.split("\n")[line - 1].slice(binding.startColumn, binding.endColumn).toLowerCase() === "value"));
    assert.ok(sidecarReferences.every(Boolean), "the sidecar should bind implicit WITH member uses");
    assert.ok(sidecarReferences.every((binding) => binding.symbol === sidecarReferences[0].symbol));
    const sidecarField = analysis.semanticBindings.find((binding) =>
        binding.role === "declaration" && binding.startLine === 2 && binding.startColumn === 4);
    assert.ok(sidecarField, "the sidecar should expose the field declaration needed to anchor its references");
    assert.equal(sidecarReferences[0].symbol, sidecarField.symbol);

    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = [field];
    reducedModel.expandedToSource = new Map([[field.token.offset, model.expandedToSource.get(field.token.offset)]]);
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    assert.deepEqual(supplemental.map((binding) => [binding.line, binding.physical.occurrence.startColumn, binding.id]).sort((a, b) =>
        a[0] - b[0] || a[1] - b[1]), [
        [6, 5, field.id], [7, 11, field.id]
    ]);
});

test("native binding sidecar retains implicit and explicit This member identities", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-this-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "method.bas");
    const source = [
        "Type MethodRecord",
        "    value As Integer",
        "    Declare Sub Clear()",
        "    Declare Sub UpdateValue()",
        "End Type",
        "Sub MethodRecord.UpdateValue()",
        "    Clear()",
        "    value = 1",
        "    Print value",
        "    This.value = value",
        "End Sub",
        "Sub MethodRecord.Clear()",
        "    value = 0",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/method.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const sourceOccurrence = (binding) => model.expandedToSource.get(binding.token.offset)?.occurrence;
    const field = model.nativeBindings.find((binding) => {
        const occurrence = sourceOccurrence(binding);
        return binding.kind === "declaration" && binding.token.name.toLowerCase() === "value" &&
            occurrence?.line === 1 && occurrence.startColumn === 4;
    });
    assert.ok(field, "the bridge should expose the aggregate field declaration");

    const expectedSites = [[8, 4], [9, 10], [10, 9], [10, 17], [13, 4]];
    const sidecarReferences = expectedSites.map(([line, column]) => analysis.semanticBindings.find((binding) =>
        binding.role === "reference" && binding.startLine === line && binding.startColumn === column &&
        source.split("\n")[line - 1].slice(binding.startColumn, binding.endColumn).toLowerCase() === "value"));
    assert.ok(sidecarReferences.every(Boolean), "the sidecar should bind bare and explicit This member uses");
    assert.ok(sidecarReferences.every((binding) => binding.symbol === sidecarReferences[0].symbol));
    const sidecarField = analysis.semanticBindings.find((binding) =>
        binding.role === "declaration" && binding.startLine === 2 && binding.startColumn === 4);
    assert.ok(sidecarField, "the sidecar should expose the field declaration needed to anchor its references");
    assert.equal(sidecarReferences[0].symbol, sidecarField.symbol);

    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = [field];
    reducedModel.expandedToSource = new Map([[field.token.offset, model.expandedToSource.get(field.token.offset)]]);
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    assert.deepEqual(supplemental.map((binding) => [binding.line, binding.physical.occurrence.startColumn, binding.id]).sort((a, b) =>
        a[0] - b[0] || a[1] - b[1]), expectedSites.map(([line, column]) => [line, column, field.id]));

    const clearDeclaration = model.nativeBindings.find((binding) => {
        const occurrence = sourceOccurrence(binding);
        return binding.kind === "declaration" && binding.token.name.toLowerCase() === "clear" &&
            occurrence?.line === 2 && occurrence.startColumn === 16;
    });
    assert.ok(clearDeclaration, "the bridge should expose the method declaration");
    const sidecarClearDeclaration = analysis.semanticBindings.find((binding) =>
        binding.role === "declaration" && binding.startLine === 3 && binding.startColumn === 16);
    const sidecarClearCall = analysis.semanticBindings.find((binding) =>
        binding.role === "reference" && binding.startLine === 7 && binding.startColumn === 4 &&
        source.split("\n")[binding.startLine - 1].slice(binding.startColumn, binding.endColumn).toLowerCase() === "clear");
    assert.ok(sidecarClearDeclaration && sidecarClearCall, "the sidecar should bind the declaration and implicit method call");
    assert.equal(sidecarClearCall.symbol, sidecarClearDeclaration.symbol);

    const reducedProcedureModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedProcedureModel, model);
    reducedProcedureModel.nativeBindings = model.nativeBindings.filter((binding) =>
        binding.kind === "declaration" && binding.id === clearDeclaration.id);
    reducedProcedureModel.expandedToSource = new Map(reducedProcedureModel.nativeBindings.map((binding) => [
        binding.token.offset, model.expandedToSource.get(binding.token.offset)
    ]));
    const supplementalCall = semanticProjectBindings(analysis, reducedProcedureModel);
    assert.deepEqual(supplementalCall.map((binding) => [binding.line, binding.physical.occurrence.startColumn, binding.id]),
        [[7, 4, clearDeclaration.id]]);
});

test("native procedure bindings preserve the overload selected by the compiler", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-procedure-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "overloads.bas");
    const source = [
        "declare function selectedOverload overload (byval value as integer) as integer",
        "declare function selectedOverload overload (byval value as double) as double",
        "dim as integer integerResult = selectedOverload(1)",
        "dim as double doubleResult = selectedOverload(1.0)",
        "dim as function(byval as integer) as integer integerPointer = @selectedOverload",
        "dim as function(byval as double) as double doublePointer = ProcPtr(selectedOverload, function(byval as double) as double)",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/overloads.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const declarations = model.nativeBindings.filter((binding) => binding.kind === "declaration" &&
        binding.token.name.toLowerCase() === "selectedoverload");
    assert.equal(declarations.length, 2, "the bridge trace should expose both overload declarations");
    assert.notEqual(declarations[0].id, declarations[1].id);

    const sidecarBinding = (line, role) => analysis.semanticBindings.find((binding) =>
        binding.startLine === line && binding.role === role &&
        source.split("\n")[line - 1].slice(binding.startColumn, binding.endColumn).toLowerCase() === "selectedoverload");
    const integerDeclaration = sidecarBinding(1, "declaration");
    const doubleDeclaration = sidecarBinding(2, "declaration");
    const integerReference = sidecarBinding(3, "reference");
    const doubleReference = sidecarBinding(4, "reference");
    const integerAddressReference = sidecarBinding(5, "reference");
    const doubleAddressReference = sidecarBinding(6, "reference");
    assert.ok(integerDeclaration && doubleDeclaration && integerReference && doubleReference &&
        integerAddressReference && doubleAddressReference,
        "the semantic sidecar should bind each declaration, call, and address token");
    assert.notEqual(integerDeclaration.symbol, doubleDeclaration.symbol);
    assert.equal(integerReference.symbol, integerDeclaration.symbol);
    assert.equal(doubleReference.symbol, doubleDeclaration.symbol);
    assert.equal(integerAddressReference.symbol, integerDeclaration.symbol);
    assert.equal(doubleAddressReference.symbol, doubleDeclaration.symbol);

    const ambiguousModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(ambiguousModel, model);
    ambiguousModel.resolveAt = () => model.inner.entries.filter((entry) =>
        entry.name.toLowerCase() === "selectedoverload" && entry.declaration.type === "function");
    for (const [line, expectedType] of [
        [3, "Integer"],
        [4, "Double"]
    ]) {
        const lineText = source.split("\n")[line - 1];
        const signature = queryCompilerModel(ambiguousModel, "signature", {
            uri,
            position: {
                line: line - 1,
                character: lineText.indexOf("selectedOverload(") + "selectedOverload(".length
            }
        }, () => {});
        assert.equal(signature.entries.length, 2, "Signature Help should retain both visible overloads");
        const selected = signature.entries.find((entry) =>
            entry.compilerSymbolId === signature.selectedCompilerSymbolId);
        assert.ok(selected, "Signature Help should carry FBC's selected procedure identity");
        assert.match(selected.declaration.signature, new RegExp(`ByVal value As ${expectedType}`, "i"));
    }

    /* Remove trace references to verify the compiler-owned facts fill the gap
       only after both procedure identities are anchored to exact declarations. */
    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = declarations;
    reducedModel.expandedToSource = new Map(declarations.map((binding) => [
        binding.token.offset,
        model.expandedToSource.get(binding.token.offset)
    ]));
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    assert.equal(supplemental.length, 4);
    assert.deepEqual(supplemental.map((binding) => [binding.line, binding.id]).sort((a, b) => a[0] - b[0]), [
        [3, declarations[0].id],
        [4, declarations[1].id],
        [5, declarations[0].id],
        [6, declarations[1].id]
    ]);
});

test("native type and constant bindings supplement only their exact project identities", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-type-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "types.bas");
    const source = [
        "type BindingType",
        "    value as integer",
        "end type",
        "enum BindingEnum",
        "    BindingEnumValue",
        "end enum",
        "type BindingAlias as BindingType",
        "const BindingConstant = 1",
        "dim as BindingAlias typedAlias",
        "dim as BindingType typedDirect",
        "dim as integer result = BindingConstant",
        "result += BindingEnumValue",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/types.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const wanted = new Set(["bindingtype", "bindingalias", "bindingenumvalue", "bindingconstant"]);
    const declarations = model.nativeBindings.filter((binding) => binding.kind === "declaration" &&
        wanted.has(binding.token.name.toLowerCase()));
    const bridgeDeclaration = (name) => declarations.find((binding) =>
        binding.token.name.toLowerCase() === name.toLowerCase());
    const expectedDeclarations = [
        "BindingType", "BindingEnumValue", "BindingAlias", "BindingConstant"
    ].map(bridgeDeclaration);
    assert.ok(expectedDeclarations.every(Boolean), `the bridge trace should expose each declaration identity (found: ${declarations.map((binding) => `${binding.token.name}@${binding.token.line + 1}`).join(", ")})`);

    const sourceLines = source.split("\n");
    const sidecarBinding = (line, role, name) => analysis.semanticBindings.find((binding) =>
        binding.startLine === line && binding.role === role &&
        sourceLines[line - 1].slice(binding.startColumn, binding.endColumn).toLowerCase() === name.toLowerCase());
    const referenceSites = [
        [7, "BindingType"], [9, "BindingAlias"], [10, "BindingType"],
        [11, "BindingConstant"], [12, "BindingEnumValue"]
    ];
    const references = referenceSites.map(([line, name]) => sidecarBinding(line, "reference", name));
    assert.ok(references.every(Boolean), "the semantic sidecar should bind type, typedef, and constant uses");

    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = expectedDeclarations;
    reducedModel.expandedToSource = new Map(expectedDeclarations.map((binding) => [
        binding.token.offset,
        model.expandedToSource.get(binding.token.offset)
    ]));
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    assert.deepEqual(supplemental.map((binding) => [binding.line, binding.name.toLowerCase()]).sort((a, b) => a[0] - b[0]), [
        [7, "bindingtype"], [9, "bindingalias"], [10, "bindingtype"],
        [11, "bindingconstant"], [12, "bindingenumvalue"]
    ]);
    for (const [line, name] of referenceSites) {
        assert.equal(supplemental.find((binding) => binding.line === line)?.id,
            expectedDeclarations.find((binding) => binding.token.name.toLowerCase() === name.toLowerCase())?.id);
    }
});

test("constructor type spellings bind to the exact written type or typedef in project edits", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-constructor-type-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "constructor-types.bas");
    const source = [
        "type ConstructorBindingTarget",
        "    marker as integer",
        "    declare constructor()",
        "end type",
        "constructor ConstructorBindingTarget()",
        "end constructor",
        "type ConstructorBindingAlias as ConstructorBindingTarget",
        "function makeTarget() as ConstructorBindingTarget",
        "    return ConstructorBindingTarget()",
        "end function",
        "function makeAlias() as ConstructorBindingTarget",
        "    return ConstructorBindingAlias()",
        "end function",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/constructor-types.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const declarations = model.nativeBindings.filter((binding) => binding.kind === "declaration" &&
        ["constructorbindingtarget", "constructorbindingalias"].includes(binding.token.name.toLowerCase()));
    const targetDeclaration = declarations.find((binding) => binding.token.name.toLowerCase() === "constructorbindingtarget");
    const aliasDeclaration = declarations.find((binding) => binding.token.name.toLowerCase() === "constructorbindingalias");
    assert.ok(targetDeclaration && aliasDeclaration, "the bridge trace should expose the type and typedef declarations");

    const sourceLines = source.split("\n");
    const sidecarBinding = (line, name) => analysis.semanticBindings.find((binding) =>
        binding.startLine === line && binding.role === "reference" &&
        sourceLines[line - 1].slice(binding.startColumn, binding.endColumn).toLowerCase() === name.toLowerCase());
    const targetReference = sidecarBinding(9, "ConstructorBindingTarget");
    const aliasReference = sidecarBinding(12, "ConstructorBindingAlias");
    assert.ok(targetReference && aliasReference, "constructor expressions should bind their written type tokens");
    assert.notEqual(targetReference.symbol, aliasReference.symbol,
        "the target type and its typedef must remain distinct compiler symbols");
    assert.ok(analysis.semanticImplicitCalls.some((call) => call.kind === "return-constructor"),
        "the selected constructor remains a compiler relationship, separate from the renameable type token");

    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = [targetDeclaration, aliasDeclaration];
    reducedModel.expandedToSource = new Map(reducedModel.nativeBindings.map((binding) => [
        binding.token.offset,
        model.expandedToSource.get(binding.token.offset)
    ]));
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    assert.deepEqual(supplemental.filter((binding) => [9, 12].includes(binding.line))
        .map((binding) => [binding.line, binding.id]).sort((a, b) => a[0] - b[0]), [
        [9, targetDeclaration.id], [12, aliasDeclaration.id]
    ]);
});

test("native numeric and named label bindings supplement each compiler-selected branch reference", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-label-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "labels.bas");
    const source = [
        "option gosub",
        "10 print 1",
        "20 print 2",
        "goto 10",
        "gosub 10",
        "return 20",
        "on 1 goto 10, 20",
        "on 2 gosub 10, 20",
        "if 1 then 10 else 20",
        "fault:",
        "on error goto fault",
        "dataMarker:",
        "data 1",
        "restore dataMarker",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-lang", "qb"],
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/labels.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const wanted = new Set(["10", "20", "fault", "datamarker"]);
    const declarations = model.nativeBindings.filter((binding) => binding.kind === "declaration" &&
        wanted.has(binding.token.name.toLowerCase()));
    const bridgeDeclaration = (name) => declarations.find((binding) =>
        binding.token.name.toLowerCase() === name.toLowerCase());
    const expectedDeclarations = ["10", "20", "fault", "dataMarker"].map(bridgeDeclaration);
    assert.ok(expectedDeclarations.every(Boolean), "the bridge trace should expose all four label declarations");

    const sourceLines = source.split("\n");
    const sidecarBinding = (line, role, name, startColumn = 0) => analysis.semanticBindings.find((binding) =>
        binding.startLine === line && binding.role === role && binding.startColumn === startColumn &&
        sourceLines[line - 1].slice(binding.startColumn, binding.endColumn).toLowerCase() === name.toLowerCase());
    const expectedSites = [
        [4, "10", 5], [5, "10", 6], [6, "20", 7], [7, "10", 10], [7, "20", 14],
        [8, "10", 11], [8, "20", 15], [9, "10", 10], [9, "20", 18],
        [11, "fault", 14], [14, "dataMarker", 8]
    ];
    const references = expectedSites.map(([line, name, column = 0]) =>
        sidecarBinding(line, "reference", name, column));
    const missingSites = expectedSites.filter((_, index) => !references[index]);
    const actualReferences = analysis.semanticBindings.filter((binding) => binding.role === "reference")
        .map((binding) => `${binding.startLine}:${binding.startColumn}-${binding.endColumn}=${sourceLines[binding.startLine - 1].slice(binding.startColumn, binding.endColumn)}`);
    assert.ok(!missingSites.length, `the sidecar should bind direct, GOSUB, ON, IF, error-handler, and RESTORE label uses (missing ${JSON.stringify(missingSites)}; got ${actualReferences.join("; ")})`);

    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = expectedDeclarations;
    reducedModel.expandedToSource = new Map(expectedDeclarations.map((binding) => [
        binding.token.offset,
        model.expandedToSource.get(binding.token.offset)
    ]));
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    assert.deepEqual(supplemental.map((binding) => [binding.line, binding.physical.occurrence.name.toLowerCase()]).sort((a, b) =>
        a[0] - b[0] || a[1].localeCompare(b[1])), [
        [4, "10"], [5, "10"], [6, "20"], [7, "10"], [7, "20"],
        [8, "10"], [8, "20"], [9, "10"], [9, "20"], [11, "fault"], [14, "datamarker"]
    ]);
    for (const binding of supplemental) {
        const declaration = expectedDeclarations.find((entry) =>
            entry.token.name.toLowerCase() === binding.physical.occurrence.name.toLowerCase());
        assert.equal(binding.id, declaration?.id, "numeric sidecar occurrences must retain the exact native label identity");
    }
});

test("native namespace declarations and qualified prefixes supplement compiler-selected references", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-namespace-bindings-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "namespaces.bas");
    const source = [
        "function Consume(ByVal value As Long) As Long",
        "return value",
        "end function",
        "namespace Alpha",
        "type Item",
        "value as integer",
        "end type",
        "dim number as integer",
        "end namespace",
        "namespace Beta.Inner",
        "type Node",
        "value as integer",
        "end type",
        "end namespace",
        "namespace Alpha",
        "end namespace",
        "dim first as Alpha.Item",
        "dim second as Beta.Inner.Node",
        "print Alpha.number",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        overlays: new Map([[sourcePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const uri = { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/namespaces.bas" },
        analysis,
        [{ uri, text: source }]
    );
    const sourceOccurrence = (binding) => model.expandedToSource.get(binding.token.offset)?.occurrence;
    const declarations = model.nativeBindings.filter((binding) => binding.kind === "declaration" &&
        ["alpha", "beta", "inner"].includes(binding.token.name.toLowerCase()));
    const declarationAt = (line, column, name) => declarations.find((binding) => {
        const occurrence = sourceOccurrence(binding);
        return occurrence?.line + 1 === line && occurrence.startColumn === column &&
            binding.token.name.toLowerCase() === name.toLowerCase();
    });
    const expectedDeclarations = [
        declarationAt(4, 10, "Alpha"), declarationAt(10, 10, "Beta"),
        declarationAt(10, 15, "Inner"), declarationAt(15, 10, "Alpha")
    ];
    assert.ok(expectedDeclarations.every(Boolean), `the bridge trace should expose all namespace declarations (got ${declarations.map((binding) => { const occurrence = sourceOccurrence(binding); return `${occurrence?.line + 1}:${occurrence?.startColumn}=${binding.token.name}`; }).join("; ")})`);

    const sourceLines = source.split("\n");
    const sidecarBinding = (line, column, name, role) => analysis.semanticBindings.find((binding) =>
        binding.startLine === line && binding.startColumn === column && binding.role === role &&
        sourceLines[line - 1].slice(binding.startColumn, binding.endColumn).toLowerCase() === name.toLowerCase());
    const expectedSites = [
        [2, 7, "value", "reference"],
        [4, 10, "Alpha", "declaration"], [10, 10, "Beta", "declaration"],
        [10, 15, "Inner", "declaration"], [15, 10, "Alpha", "declaration"],
        [17, 13, "Alpha", "reference"], [18, 14, "Beta", "reference"],
        [18, 19, "Inner", "reference"], [19, 6, "Alpha", "reference"]
    ];
    const sidecarBindings = expectedSites.map(([line, column, name, role]) =>
        sidecarBinding(line, column, name, role));
    assert.ok(sidecarBindings.every(Boolean), `the sidecar should bind reopened/nested declarations and qualified prefixes (got ${analysis.semanticBindings.map((binding) => `${binding.startLine}:${binding.startColumn}-${binding.endColumn}:${binding.role}=${sourceLines[binding.startLine - 1].slice(binding.startColumn, binding.endColumn)}`).join("; ")})`);
    assert.equal(sidecarBindings[1].symbol, sidecarBindings[4].symbol, "reopened namespace declarations retain one compiler identity");
    for (const namespaceBinding of [sidecarBindings[1], sidecarBindings[2], sidecarBindings[3]]) {
        assert.notEqual(namespaceBinding.symbol, sidecarBindings[0].symbol, "a later namespace allocation must not reuse a parameter's compiler identity");
    }

    const reducedModel = Object.create(Object.getPrototypeOf(model));
    Object.assign(reducedModel, model);
    reducedModel.nativeBindings = expectedDeclarations;
    reducedModel.expandedToSource = new Map(expectedDeclarations.map((binding) => [
        binding.token.offset,
        model.expandedToSource.get(binding.token.offset)
    ]));
    const supplemental = semanticProjectBindings(analysis, reducedModel);
    assert.deepEqual(supplemental.map((binding) => [binding.line, binding.physical.occurrence.startColumn, binding.physical.occurrence.name.toLowerCase()]).sort((a, b) =>
        a[0] - b[0] || a[1] - b[1]), [
        [17, 13, "alpha"], [18, 14, "beta"], [18, 19, "inner"], [19, 6, "alpha"]
    ]);
});

test("complete compiler dependencies normalize paths and require the requested module", () => {
    const sidecar = {
        schemaVersion: 6,
        dependenciesComplete: true,
        dependencies: ["src/main.bas", "src/include.bi", "src/../src/include.bi"]
    };
    const dependencies = compilerSemanticDependencies(sidecar, "/project", "/project/src/main.bas");

    assert.deepEqual(dependencies, ["/project/src/main.bas", "/project/src/include.bi"]);
    assert.throws(() => compilerSemanticDependencies({ ...sidecar, dependenciesComplete: false }, "/project", "/project/src/main.bas"), /incomplete dependency/);
    assert.throws(() => compilerSemanticDependencies({ ...sidecar, dependencies: ["src/include.bi"] }, "/project", "/project/src/main.bas"), /requested module/);
    assert.equal(compilerSemanticDependencies({ ...sidecar, schemaVersion: 5 }, "/project", "/project/src/main.bas"), null,
        "older sidecars remain compatible and do not claim a complete source inventory");
});

test("schema 6 recovery footer retains dependency inventory completeness", () => {
    const text = [
        header6,
        "M\t/main.bas",
        expression4,
        "R\t6\t1",
        "D\t/main.bas",
        "RECOVERY\t6\t1\t1\t1\t1\t1"
    ].join("\n");
    const model = decodeCompilerSemanticExpressions(text, () => true, { allowRecovery: true });

    assert.equal(model.recovery, true);
    assert.deepEqual(model.dependencies, ["/main.bas"]);
    assert.equal(model.dependenciesComplete, true);
});

test("schema 2 remains readable during compiler upgrades", () => {
    const model = decodeCompilerSemanticModel([
        "FBCSEM\t2\t1.20.4",
        "M\t/main.bas",
        "END\t2\t1\t0\t0\t0\t0"
    ].join("\n"));

    assert.equal(model.schemaVersion, 2);
    assert.deepEqual(model.expressions, []);
    assert.equal(model.counts.expressionCount, 0);
});

test("schema 3 rejects invalid expression ranges and unnormalized flags", () => {
    for (const row of [
        expression.replace("\t1\t/main", "\t-1\t/main"),
        expression.replace("\t2\t4\t2\t9", "\t2\t9\t2\t4")
    ]) {
        const text = [header3, "M\t/main.bas", row, "END\t3\t1\t0\t0\t0\t0\t1"].join("\n");
        assert.throws(() => decodeCompilerSemanticModel(text), /physical-range|source range/);
    }
});

test("expression records cannot appear in schema 2", () => {
    const text = [
        "FBCSEM\t2\t1.20.4",
        "M\t/main.bas",
        expression,
        "END\t2\t1\t0\t0\t0\t0"
    ].join("\n");
    assert.throws(() => decodeCompilerSemanticModel(text), /schema version 3/);
});

test("native compiler sidecar preserves exact physical and macro expression ranges", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-sidecar-"));
    const sourcePath = path.join(directory, "expressions.bas");
    const sidecarPath = path.join(directory, "expressions.tsv");
    const expressionOnlyPath = path.join(directory, "expressions-only.tsv");
    const objectPath = path.join(directory, "expressions.o");
    const source = [
        "#define SEMANTIC_VALUE 2",
        "declare function semantic_helper() as integer",
        "sub semantic_probe()",
        "    dim as integer value = 1",
        "    dim as integer fallback = iif(value > 0, value, 0)",
        '    value += len("😀") + semantic_helper() + 2',
        "    value += semantic_helper() + SEMANTIC_VALUE",
        "end sub",
        ""
    ].join("\n");

    try {
        fs.writeFileSync(sourcePath, source);
        execFileSync(compiler, ["-semantic-model", sidecarPath, "-c", sourcePath, "-o", objectPath], {
            cwd: directory,
            stdio: "ignore",
            timeout: 30000
        });

        const sidecarText = semanticModelTestText(sidecarPath);
        const model = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
        assert.equal(model.schemaVersion, 27);
        assert.ok(model.capabilities.length > 0, "current sidecars should advertise compiler feature coverage");
        assert.ok(model.statements.length > 0, "current sidecars should retain source statements");
        assert.ok(model.physicalLocations.length > 0, "current sidecars should retain mapped source locations");
        assert.ok(model.normalizedTypes.length > 0, "full current sidecars should retain normalized target types");
        assert.ok(model.flowPhases.length > 0 && model.nodePhases.length > 0, "full current sidecars should retain procedure phases");
        assert.ok(model.controlFlowBlocks.length > 0 && model.controlFlowEdges.length > 0, "full current sidecars should retain conservative control flow");
        assert.ok(model.expressionOperands.length > 0, "current sidecars should link source operators to their observed operands");
        assert.equal(model.capabilities.find((capability) =>
            capability.feature === "parsed-expression-input-coverage")?.coverage, "available");
        assert.equal(model.capabilities.find((capability) =>
            capability.feature === "numeric-assignment-targets")?.coverage, "available");
        assert.equal(model.capabilities.find((capability) =>
            capability.feature === "parsed-iif-input-counts")?.coverage, "available");
        assert.equal(model.capabilities.find((capability) =>
            capability.feature === "original-iif-inputs")?.coverage, "available");
        const statementByExpression = new Map(model.statementOwners
            .filter((owner) => owner.domain === "expression")
            .map((owner) => [owner.subject, owner.statement]));
        const parsedIif = model.relationships.filter((relation) => relation.kind === "parsed-iif");
        assert.ok(parsedIif.length > 0, "the source should produce compiler-owned parsed IIf groups");
        for (const relation of parsedIif) {
            const statement = statementByExpression.get(relation.target);
            assert.ok(statement > 0, "parsed IIf result expressions should retain their owning statement");
            assert.ok(model.properties.some((property) => property.domain === "symbol" &&
                property.name === `parsed-iif-count:${statement}` && Number(property.value) > 0),
            "the statement receipt should count its parsed IIf inputs");
        }
        const receiptLines = sidecarText.split(/\r?\n/);
        const operandReceiptIndex = receiptLines.findIndex((line) =>
            /^K\tsymbol\t\d+\tparsed-operand-count:\d+\t\d+$/.test(line));
        assert.notEqual(operandReceiptIndex, -1, "full models should close expression operand coverage per statement");
        const mismatchedOperandReceipt = receiptLines.slice();
        const operandReceipt = mismatchedOperandReceipt[operandReceiptIndex].split("\t");
        operandReceipt[4] = String(Number(operandReceipt[4]) + 1);
        mismatchedOperandReceipt[operandReceiptIndex] = operandReceipt.join("\t");
        assert.throws(() => decodeCompilerSemanticModel(mismatchedOperandReceipt.join("\n")),
            /Parsed expression operand coverage/);
        const iifReceiptIndex = receiptLines.findIndex((line) =>
            /^K\texpression\t\d+\toriginal-iif-inputs\t\d+%09\d+%09\d+$/.test(line));
        assert.notEqual(iifReceiptIndex, -1, "full sidecars should retain original IIf operand identities");
        const mismatchedIifReceipt = receiptLines.slice();
        const iifReceipt = mismatchedIifReceipt[iifReceiptIndex].split("\t");
        const iifInputs = iifReceipt[4].split("%09");
        [iifInputs[1], iifInputs[2]] = [iifInputs[2], iifInputs[1]];
        iifReceipt[4] = iifInputs.join("%09");
        mismatchedIifReceipt[iifReceiptIndex] = iifReceipt.join("\t");
        assert.throws(() => decodeCompilerSemanticModel(mismatchedIifReceipt.join("\n")),
            /Original IIf input identities/);
        const numericTargetIndex = receiptLines.findIndex((line) =>
            /^K\texpression\t\d+\tassignment-target-dtype\t\d+$/.test(line));
        assert.notEqual(numericTargetIndex, -1, "full models should retain numeric destination types");
        const incompleteNumericTarget = receiptLines.slice();
        const numericTarget = incompleteNumericTarget[numericTargetIndex].split("\t");
        numericTarget[3] = "assignment-target-unknown";
        incompleteNumericTarget[numericTargetIndex] = numericTarget.join("\t");
        assert.throws(() => decodeCompilerSemanticModel(incompleteNumericTarget.join("\n")),
            /Numeric assignment target has an incomplete or invalid property pair/);
        assert.deepEqual(model.implicitCalls, []);
        assert.deepEqual(model.dependencies, [sourcePath]);
        assert.equal(model.dependenciesComplete, true);
        assert.ok(model.bindings.length > 0);
        const valueDeclaration = model.bindings.find((binding) => binding.role === "declaration" &&
            source.split("\n")[binding.startLine - 1].slice(binding.startColumn, binding.endColumn) === "value");
        const valueReference = model.bindings.find((binding) => binding.role === "reference" &&
            source.split("\n")[binding.startLine - 1].slice(binding.startColumn, binding.endColumn) === "value");
        assert.ok(valueDeclaration, "native sidecar should bind the variable declaration to a compiler symbol");
        assert.ok(valueReference, "native sidecar should bind variable uses to the same compiler symbol");
        assert.equal(valueReference.symbol, valueDeclaration.symbol);
        const lines = source.split("\n");
        const directLine = lines.findIndex((line) => line.includes("semantic_helper() + 2"));
        const macroLine = lines.findIndex((line) => line.includes("semantic_helper() + SEMANTIC_VALUE"));
        const directStart = lines[directLine].indexOf("len(");
        const macroStart = lines[macroLine].indexOf("SEMANTIC_VALUE");
        const macroEnd = macroStart + "SEMANTIC_VALUE".length;
        const physicalExpression = model.expressions.find((item) => item.startLine === directLine + 1 &&
            item.startColumn === directStart && item.endLine === directLine + 1 &&
            item.endColumn === lines[directLine].length);
        const expandedExpression = model.expressions.find((item) => item.startLine === macroLine + 1 &&
            item.startColumn >= macroStart && item.endColumn <= macroEnd && item.physical === false);

        assert.ok(physicalExpression, "native sidecar should export the complete direct expression");
        assert.equal(physicalExpression.physical, true);
        assert.equal(physicalExpression.endLine, directLine + 1);
        assert.equal(physicalExpression.endColumn, lines[directLine].length);
        assert.ok(expandedExpression, "native sidecar should retain typed facts through macro expansion");
        assert.equal(expandedExpression.physical, false);

        execFileSync(compiler, ["-semantic-model-expressions", expressionOnlyPath, "-c", sourcePath, "-o", objectPath], {
            cwd: directory,
            stdio: "ignore",
            timeout: 30000
        });
        const expressionOnly = decodeCompilerSemanticExpressions(fs.readFileSync(expressionOnlyPath));
        assert.equal(expressionOnly.schemaVersion, 27);
        assert.ok(expressionOnly.expressions.length > 0);
        assert.ok(expressionOnly.expressionOperands.length > 0, "expression-only sidecars should retain source operator operands");
        assert.deepEqual(expressionOnly.dependencies, [sourcePath]);
        assert.equal(expressionOnly.dependenciesComplete, true);
        assert.equal(expressionOnly.counts.procedureCount, 0);
        assert.equal(expressionOnly.counts.symbolCount, 0);
        assert.equal(expressionOnly.counts.typeFactCount, 0);
        assert.equal(expressionOnly.counts.nodeCount, 0);
        assert.equal(expressionOnly.counts.bindingCount, 0);
        assert.deepEqual(expressionOnly.bindings, []);
        assert.ok(expressionOnly.expressions.every((item) => item.symbol === 0 && item.subtype === 0));
        const expressionFactKey = (item) => JSON.stringify([
            item.physical, item.filePath, item.startLine, item.startColumn, item.endLine,
            item.endColumn, item.astClass, item.operator, item.dtype, item.symbol,
            item.subtype, item.typeName
        ]);
        for (let index = 1; index < expressionOnly.expressions.length; index++) {
            assert.notEqual(expressionFactKey(expressionOnly.expressions[index - 1]),
                expressionFactKey(expressionOnly.expressions[index]),
                "Adjacent parser tiers must not duplicate an identical compiler fact.");
        }
        assert.ok(fs.statSync(expressionOnlyPath).size < fs.statSync(sidecarPath).size, "expression-only output should avoid unrelated semantic records");

        /* The extension's richer parser trace is the production source. The
           compiler sidecar is an independent agreement check for the exact
           ranges and types it also represents. */
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            overlays: new Map([[sourcePath, source]]),
            exportSemanticExpressions: true
        });
        const sourceUri = { fsPath: sourcePath, toString: () => `file://${sourcePath}` };
        const editorModel = new CompilerSemanticModel(
            { toString: () => "freebasic-preprocessed:/semantic-sidecar-check.bas" },
            analysis,
            [{ uri: sourceUri, text: source }]
        );
        const sourceOperation = model.expressionOperands.find((operation) => {
            const expression = model.expressions.find((item) => item.id === operation.identity);
            return operation.physical && expression?.physical && expression.filePath === sourcePath;
        });
        assert.ok(sourceOperation, "schema-27 operator links should retain an exact physical expression");
        const operationExpression = model.expressions.find((item) => item.id === sourceOperation.identity);
        const sidecarOperationType = editorModel.compilerSidecarFactAt(sourceUri,
            { line: operationExpression.startLine - 1, character: operationExpression.startColumn },
            { line: operationExpression.endLine - 1, character: operationExpression.endColumn });
        assert.equal(sidecarOperationType?.semanticSource, "compiler-sidecar");
        assert.equal(sidecarOperationType?.sourceOperation?.operator, sourceOperation.operator);

        const comparableExpressions = model.expressions.filter((item) => item.physical && item.filePath === sourcePath);
        assert.ok(comparableExpressions.length > 0);
        for (const item of comparableExpressions) {
            const typed = editorModel.expressionAt(
                sourceUri,
                { line: item.startLine - 1, character: item.startColumn },
                { line: item.endLine - 1, character: item.endColumn }
            );
            assert.ok(typed, `extension trace should represent sidecar range ${item.startLine}:${item.startColumn}-${item.endLine}:${item.endColumn}`);
            assert.equal(typed.dtype, item.dtype, `native type mismatch at ${item.startLine}:${item.startColumn}`);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("macro-expanded include directives stay unanchored in compiler semantic models", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-macro-include-origin-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "macro-include.bas");
    const headerPath = path.join(directory, "macro-header.bi");
    const objectPath = path.join(directory, "macro-include.o");
    fs.writeFileSync(headerPath, "dim included_value as long\n");
    fs.writeFileSync(sourcePath, '#define HEADER_FILE "macro-header.bi"\n#include HEADER_FILE\nprint included_value\n');

    for (const [option, suffix] of [["-semantic-model", "full"], ["-semantic-model-expressions", "expressions"]]) {
        const sidecarPath = path.join(directory, `${suffix}.tsv`);
        execFileSync(compiler, [option, sidecarPath, "-c", sourcePath, "-o", objectPath], {
            cwd: directory,
            stdio: "ignore",
            timeout: 30000
        });

        const model = suffix === "full" ? decodeCompilerSemanticModel(fs.readFileSync(sidecarPath))
            : decodeCompilerSemanticExpressions(fs.readFileSync(sidecarPath));
        assert.equal(model.schemaVersion, 27);
        assert.equal(model.dependenciesComplete, true);
        assert.ok(model.dependencies.includes(sourcePath));
        assert.ok(model.dependencies.includes(headerPath));
        const includeContext = model.sourceContexts.find((context) => context.kind === "include");
        const includeOutcome = model.includeOutcomes.find((outcome) => outcome.outcome === "opened");
        assert.ok(includeContext, `${suffix} output should retain the included source occurrence`);
        assert.equal(includeContext.directive, null,
            `${suffix} output must not invent a physical range for a macro-expanded directive`);
        assert.ok(includeOutcome, `${suffix} output should retain the include outcome`);
        assert.equal(includeOutcome.directive, null,
            `${suffix} output must not invent a physical range for a macro-expanded include`);
        if (suffix === "full") {
            assert.deepEqual(includeOutcome.origin, {
                filePath: sourcePath, startLine: 2, startColumn: 9,
                endLine: 2, endColumn: 20, physical: false
            }, "the full model should retain the macro invocation as noneditable provenance");
        } else {
            assert.equal(includeOutcome.origin, null,
                "compact expression models omit macro invocation provenance with the macro graph");
        }

        const legacyRows = semanticModelTestText(sidecarPath).split("\n").map((line) => line.split("\t"));
        const legacyContext = legacyRows.find((row) => row[0] === "SRC" && row[5] === "include");
        const legacyOutcome = legacyRows.find((row) => row[0] === "INC" && row[5] === "opened");
        assert.ok(legacyContext && legacyOutcome, `${suffix} output should contain include provenance rows`);

        /* Earlier schema-27 writers can carry logical coordinates with this flag clear.
           Those coordinates are useful as provenance, but are not physical edit ranges. */
        legacyContext.splice(9, 5, sourcePath, "1", "0", "1", "8");
        legacyOutcome.splice(7, 5, sourcePath, "1", "0", "1", "8");
        const legacyModel = decodeCompilerSemanticModel(legacyRows.map((row) => row.join("\t")).join("\n"));
        assert.equal(legacyModel.sourceContexts.find((context) => context.kind === "include").directive, null,
            `${suffix} output must ignore coordinates whose physical flag is clear`);
        assert.equal(legacyModel.includeOutcomes.find((outcome) => outcome.outcome === "opened").directive, null,
            `${suffix} output must ignore include coordinates whose physical flag is clear`);
        if (suffix === "full") {
            assert.deepEqual(legacyModel.includeOutcomes.find((outcome) => outcome.outcome === "opened").origin, {
                filePath: sourcePath, startLine: 1, startColumn: 0,
                endLine: 1, endColumn: 8, physical: false
            }, "older unverified coordinates remain provenance rather than editable directive ranges");
        }
    }
});

test("QB rejected intrinsic defines retain compiler-selected macro lifecycle facts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/quirk/no-sfx-intrinsic-defines.bas");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-lang", "qb", "-arch", "x86_64", "-i", path.join(root, "inc"),
            "-i", path.join(root, "tests/fbcunit/inc")],
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        timeoutMs: 120000
    });

    assert.equal(analysis.partial, false);
    const lifecycles = analysis.semanticPreprocessorFacts.macroLifecycles;
    const rejectedNames = new Set(["music", "sfx", "midi", "device", "capture"]);
    const acceptedNames = new Set([
        "sound", "noise", "play", "tempo", "channel", "octave", "voice", "vol", "volume",
        "balance", "pan", "note", "wave", "envelope", "instrument", "tone"
    ]);
    const byName = new Map(lifecycles.map((lifecycle) => [lifecycle.spelling.toLowerCase(), lifecycle]));
    assert.deepEqual([...byName.keys()].filter((name) => rejectedNames.has(name)).sort(), [...rejectedNames].sort());
    assert.deepEqual([...byName.keys()].filter((name) => acceptedNames.has(name)).sort(), [...acceptedNames].sort());
    for (const name of rejectedNames) {
        assert.equal(byName.get(name).definition, 0, `${name} must not invent a selected macro definition`);
        assert.equal(byName.get(name).action, "definition-rejected");
    }
    for (const name of acceptedNames) {
        assert.ok(byName.get(name).definition > 0, `${name} must retain its accepted macro identity`);
        assert.equal(byName.get(name).action, "define");
    }
});

test("latest full compiler semantics reach declaration, procedure, aggregate, case, array, string, and literal analysis", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const fixtures = [
        { file: "declaration-typing.bas", feature: "declaration-typing-inputs", property: "declaration-type-input:", entry: "explicitValue", fact: "declarationInputs",
            constant: { name: "explicitConstant", value: "4", kind: "signed" } },
        { file: "procedure-typing.bas", feature: "procedure-typing-inputs", property: "procedure-typing-input:", entry: "PublicImplicit", fact: "procedureTypingInputs", visibilityProperty: "procedure-written-visibility:" },
        { file: "aggregate-access.bas", feature: "aggregate-access-sections", property: "aggregate-access-section:", entry: "AccessOwner", fact: "aggregateAccess" },
        { file: "select-case-lowering.bas", feature: "select-case-lowering-inputs", property: "select-case-comparison:", entry: null },
        { file: "array-subscript-inputs.bas", feature: "array-storage-inputs", property: "array-storage-kind", entry: null,
            relationships: ["array-storage-root", "array-storage-selection", "array-storage-input"] },
        { file: "string-declarations.bas", feature: "scalar-string-declarations", property: "scalar-string-declaration", entry: "LocalText", fact: "scalarStringDeclaration" },
        { file: "target-wide-prefixes.bas", feature: "target-wide-literal-prefixes", property: "literal-target-wide-prefix", entry: null }
    ];

    for (const fixture of fixtures) {
        const filePath = path.join(root, "tests/semantic-sidecar", fixture.file);
        const source = decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath).replace(/^\uFEFF/, "");
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath,
            compilerArguments: ["-i", path.join(root, "inc")],
            exportSemanticBindings: true,
            requireSemanticModel: true,
            timeoutMs: 120000
        });

        assert.equal(analysis.partial, false, `${fixture.file} must complete native analysis`);
        assert.equal(analysis.semanticModelSchemaVersion, 27);
        assert.match(analysis.semanticModelCompilerVersion, /^1\.20\.5/);
        assert.ok(analysis.semanticCapabilities.some((capability) => capability.feature === fixture.feature &&
            capability.coverage === "available"), `${fixture.file} must advertise ${fixture.feature}`);
        assert.ok(analysis.semanticProperties.some((property) => property.name.startsWith(fixture.property)),
            `${fixture.file} must deliver ${fixture.property} records through the binding analysis pass`);
        for (const kind of fixture.relationships || []) {
            assert.ok(analysis.semanticRelationships.some((relationship) => relationship.kind === kind),
                `${fixture.file} must deliver ${kind} relationships through the binding analysis pass`);
        }
        let writtenVisibility;
        if (fixture.visibilityProperty) {
            const declaration = analysis.semanticBindings.find((binding) => binding.role === "declaration" &&
                binding.name.toLowerCase() === fixture.entry.toLowerCase());
            assert.ok(declaration, `${fixture.entry} must have a compiler-owned declaration binding`);
            writtenVisibility = analysis.semanticProperties.find((property) => property.domain === "symbol" &&
                property.identity === declaration.symbol && property.name.startsWith(fixture.visibilityProperty));
            assert.ok(writtenVisibility, `${fixture.file} must deliver symbol-owned written visibility`);
            assert.match(writtenVisibility.name, /^procedure-written-visibility:\d+$/);
            assert.equal(writtenVisibility.value, "public");
        }

        if (!fixture.entry) continue;
        const sources = analysis.dependencies.filter((dependency) => fs.existsSync(dependency)).map((dependency) => ({
            uri: { scheme: "file", fsPath: dependency, toString: () => `file://${dependency}` },
            text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
        }));
        const model = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/${fixture.file}` },
            analysis,
            sources
        );
        const entry = model.inner.entries.find((candidate) => candidate.name.toLowerCase() === fixture.entry.toLowerCase());
        assert.ok(entry, `${fixture.file} should have a compiler-owned ${fixture.entry} declaration`);
        assert.ok(entry.compilerFacts?.[fixture.fact], `${fixture.entry} should expose compiler-selected ${fixture.fact}`);
        if (fixture.visibilityProperty) {
            const visibility = entry.compilerFacts.procedureWrittenVisibility;
            const statement = Number(writtenVisibility.name.split(":")[1]);
            assert.ok(visibility.some((fact) => fact.statement === statement && fact.visibility === "public"),
                `${fixture.entry} should expose the compiler-selected written visibility statement`);
        }
        if (fixture.fact === "scalarStringDeclaration") {
            assert.equal(entry.compilerFacts.scalarStringDeclaration.kind, "dim");
            assert.ok(entry.compilerFacts.scalarStringDeclaration.statement > 0);
            assert.ok(entry.compilerFacts.scalarStringDeclaration.expression > 0);
        }
        if (fixture.constant) {
            const constant = model.inner.entries.find((candidate) =>
                candidate.name.toLowerCase() === fixture.constant.name.toLowerCase());
            assert.ok(constant, `${fixture.constant.name} should have a compiler-owned declaration`);
            assert.ok(constant.compilerFacts?.constantValues.some((value) =>
                value.kind === fixture.constant.kind && value.value === fixture.constant.value),
            `${fixture.constant.name} should retain its exact compiler-selected value`);
            const sourceUri = sources.find((candidate) => candidate.uri.fsPath === filePath).uri;
            const completionLine = source.split(/\r\n|\n|\r/).findIndex((line) => line.startsWith("Print implicitValue"));
            const completion = queryCompilerModel(model, "completion", {
                uri: sourceUri,
                position: { line: completionLine, character: "Print ".length },
                limit: 1000
            }, () => {});
            const completionEntry = completion.entries.find((candidate) =>
                candidate.name.toLowerCase() === fixture.constant.name.toLowerCase());
            assert.ok(completionEntry?.declaration.compilerFacts.constantValues.some((value) =>
                value.kind === fixture.constant.kind && value.value === fixture.constant.value),
            "worker-facing completion records should carry the same compiler-confirmed value");
            const symbols = queryCompilerModel(model, "documentSymbols", { uri: sourceUri }, () => {});
            const outlineConstant = symbols.find((candidate) =>
                candidate.name.toLowerCase() === fixture.constant.name.toLowerCase());
            assert.match(outlineConstant?.detail || "", /compiler value: 4/,
                "the native Outline should show a unique constant value alongside its declaration kind");
            const retainedValues = constant.compilerFacts.constantValues;
            constant.compilerFacts.constantValues = [
                ...retainedValues,
                { kind: fixture.constant.kind, value: "5" }
            ];
            const ambiguousSymbols = queryCompilerModel(model, "documentSymbols", { uri: sourceUri }, () => {});
            const ambiguousOutline = ambiguousSymbols.find((candidate) =>
                candidate.name.toLowerCase() === fixture.constant.name.toLowerCase());
            assert.doesNotMatch(ambiguousOutline?.detail || "", /compiler value:/,
                "the native Outline should withhold conflicting constant values");
            constant.compilerFacts.constantValues = retainedValues;
        }
    }
});

test("FBC numeric and string constant values reach native compiler facts and Outline", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-float-constant-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "float-constant.bas");
    const source = "Const preciseRatio As Double = 1.5\n" +
        "Const readableText As String = \"Hello\"\nPrint preciseRatio\nPrint readableText\n";
    fs.writeFileSync(filePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        overlays: new Map([[filePath, source]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    assert.equal(analysis.semanticModelSchemaVersion, 27);
    const declaration = analysis.semanticBindings.find((binding) => binding.role === "declaration" &&
        binding.name.toLowerCase() === "preciseratio");
    assert.ok(declaration, "FBC should export an exact declaration binding for the named constant");
    assert.ok(analysis.semanticConstants.some((constant) => constant.domain === "symbol" &&
        constant.identity === declaration.symbol && constant.kind === "float64-bits" &&
        constant.value === "0x3FF8000000000000"),
    "the semantic sidecar should preserve the exact compiler-produced IEEE-754 bits");
    const stringDeclaration = analysis.semanticBindings.find((binding) => binding.role === "declaration" &&
        binding.name.toLowerCase() === "readabletext");
    assert.ok(stringDeclaration, "FBC should export an exact declaration binding for the string constant");
    assert.ok(analysis.semanticConstants.some((constant) => constant.domain === "symbol" &&
        constant.identity === stringDeclaration.symbol && constant.kind === "bytes" &&
        constant.value === "48656C6C6F"),
    "the semantic sidecar should preserve exact string bytes without assuming their encoding");

    const sources = analysis.dependencies.filter((dependency) => fs.existsSync(dependency)).map((dependency) => ({
        uri: { scheme: "file", fsPath: dependency, toString: () => `file://${dependency}` },
        text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
    }));
    const uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/float-constant.bas" },
        analysis,
        sources
    );
    const entry = model.inner.entries.find((candidate) => candidate.name.toLowerCase() === "preciseratio");
    assert.ok(entry?.compilerFacts.constantValues.some((constant) =>
        constant.kind === "float64-bits" && constant.value === "0x3FF8000000000000"),
    "the bridge-backed symbol model should retain the compiler's exact value");
    const symbols = queryCompilerModel(model, "documentSymbols", { uri }, () => {});
    const outlineEntry = symbols.find((candidate) => candidate.name.toLowerCase() === "preciseratio");
    assert.match(outlineEntry?.detail || "", /compiler value: 1\.5 \(IEEE-754 bits 0x3FF8000000000000\)/,
        "native Outline details should keep the readable value and exact bits");
    const textEntry = model.inner.entries.find((candidate) => candidate.name.toLowerCase() === "readabletext");
    assert.ok(textEntry?.compilerFacts.constantValues.some((constant) =>
        constant.kind === "bytes" && constant.value === "48656C6C6F"),
    "the bridge-backed symbol model should retain the exact string bytes");
    const outlineTextEntry = symbols.find((candidate) => candidate.name.toLowerCase() === "readabletext");
    assert.match(outlineTextEntry?.detail || "", /compiler value: bytes 0x48656C6C6F \(ASCII preview: "Hello"\)/,
        "native Outline details should show safe ASCII without decoding other byte encodings");
});

test("latest FBC header and namespace inputs reach validated editor models", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-header-policy-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const headerPath = path.join(directory, "policy.bi");
    const sourcePath = path.join(directory, "header-policy.bas");
    const fullPath = path.join(directory, "full.tsv");
    const compactPath = path.join(directory, "compact.tsv");
    const objectPath = path.join(directory, "header-policy.o");
    const header = "#Pragma Once\n#Inclib \"fixture\"\n#Libpath \"percent% and\t tab\"\n" +
        "'' The selected version of this policy header.\n#define POLICY_VERSION 7\n" +
        "Namespace PolicyScope\n'' The selected value exposed by this header.\nConst Value = 1\n" +
        "' Ordinary comments do not become declaration documentation.\nConst PlainValue = 2\n" +
        "'' A blank line separates this from the next declaration.\n\nConst GapValue = 3\n" +
        "'' Describes the operation.\n'' @param payload Additional data for the operation.\n" +
        "Declare Sub Describe( _\n    ByVal selectedMode As Integer, _ '' Selects the behavior.\n" +
        "    ByVal payload As Integer)\nEnd Namespace\nUsing PolicyScope\n";
    const source = '#Include "policy.bi"\nSub RunPolicy()\nUsing PolicyScope\nEnd Sub\n' +
        "Namespace Client\nUsing PolicyScope\nEnd Namespace\nNamespace\nEnd Namespace\n" +
        "Print PolicyScope.Value\nPolicyScope.Describe(1, 2)\nPrint POLICY_VERSION\n";
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", directory],
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    for (const feature of ["source-header-policy-inputs", "namespace-import-recipient-inputs", "namespace-declaration-inputs"]) {
        assert.ok(analysis.semanticCapabilities.some((capability) => capability.feature === feature &&
            capability.coverage === "available"), feature);
    }
    const headerPolicy = analysis.semanticSourceHeaderPolicies.find((policy) => policy.filePath === headerPath);
    const rootPolicy = analysis.semanticSourceHeaderPolicies.find((policy) => policy.filePath === sourcePath);
    assert.deepEqual([headerPolicy?.pragmaOnce, headerPolicy?.libraryCount, headerPolicy?.namespaceImportCount], [true, 2, 1]);
    assert.deepEqual([rootPolicy?.pragmaOnce, rootPolicy?.libraryCount, rootPolicy?.namespaceImportCount], [false, 0, 2]);
    assert.deepEqual(analysis.semanticHeaderLibraries.filter((library) => library.filePath === headerPath)
        .map((library) => [library.kind, library.value]), [
        ["inclib", "fixture"], ["libpath", "percent% and\t tab"]
    ]);
    const headerImports = analysis.semanticNamespaceImportRecipients.filter((item) => item.filePath === headerPath);
    const rootImports = analysis.semanticNamespaceImportRecipients.filter((item) => item.filePath === sourcePath);
    assert.equal(headerImports.length, 1);
    assert.equal(rootImports.length, 2);
    assert.ok(rootImports.some((item) => item.recipient === rootPolicy.owner),
        "a USING inside a procedure still records the compiler-selected global recipient");
    assert.ok(analysis.semanticNamespaceDeclarations.some((declaration) => declaration.filePath === sourcePath && declaration.anonymous));

    const sources = [
        { uri: { scheme: "file", fsPath: headerPath, toString: () => `file://${headerPath}` }, text: header },
        { uri: { scheme: "file", fsPath: sourcePath, toString: () => `file://${sourcePath}` }, text: source }
    ];
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/header-policy.bas" }, analysis, sources);
    assert.deepEqual(model.compilerSourceHeaderPolicies, analysis.semanticSourceHeaderPolicies);
    assert.deepEqual(model.compilerHeaderLibraries, analysis.semanticHeaderLibraries);
    assert.deepEqual(model.compilerNamespaceImportRecipients, analysis.semanticNamespaceImportRecipients);
    assert.deepEqual(model.compilerNamespaceDeclarations, analysis.semanticNamespaceDeclarations);
    const includeLibrary = analysis.semanticHeaderLibraries.find((library) =>
        library.filePath === headerPath && library.kind === "inclib");
    assert.ok(includeLibrary?.location, "FBC should retain the accepted linker directive's physical range");
    const headerHover = queryCompilerModel(model, "hover", {
        uri: sources[0].uri,
        position: {
            line: includeLibrary.location.startLine - 1,
            character: includeLibrary.location.startColumn
        }
    }, () => {});
    assert.deepEqual(headerHover.compilerHeaderLibraries, [{ kind: "inclib", value: "fixture" }],
        "only a physical hover on the accepted directive should expose its compiler-selected linker input");
    const unrelatedHeaderHover = queryCompilerModel(model, "hover", {
        uri: sources[0].uri,
        position: { line: 0, character: 1 }
    }, () => {});
    assert.deepEqual(unrelatedHeaderHover.compilerHeaderLibraries, [],
        "the accepted directive fact should not appear on an unrelated line in the same header");
    const sourceLines = source.split("\n");
    const valueLine = sourceLines.findIndex((line) => line.includes("PolicyScope.Value"));
    const valuePosition = {
        line: valueLine,
        character: sourceLines[valueLine].lastIndexOf("Value")
    };
    const valueHover = queryCompilerModel(model, "hover", {
        uri: sources[1].uri,
        position: valuePosition
    }, () => {});
    assert.ok(valueHover.entries.some((entry) => entry.name === "Value"),
        "the query should resolve the compiler-bound declaration from its included header");
    assert.equal(valueHover.entries.find((entry) => entry.name === "Value")?.declaration.documentation,
        "The selected value exposed by this header.",
        "an accepted adjacent documentation comment should follow the exact compiler declaration");
    const headerSymbols = queryCompilerModel(model, "documentSymbols", { uri: sources[0].uri }, () => {});
    assert.match(headerSymbols.find((entry) => entry.name === "Value")?.detail || "",
        /The selected value exposed by this header\./,
        "compiler Outline details should surface a concise source documentation summary");
    assert.match(headerSymbols.find((entry) => entry.name === "Value")?.detail || "",
        /As integer/i,
        "compiler Outline details should show the compiler-selected type of a constant");
    const headerLines = header.split("\n");
    const parameterLine = headerLines.findIndex((line) => line.includes("selectedMode"));
    const parameterHover = queryCompilerModel(model, "hover", {
        uri: sources[0].uri,
        position: { line: parameterLine, character: headerLines[parameterLine].indexOf("selectedMode") }
    }, () => {});
    assert.equal(parameterHover.entries[0]?.declaration.documentation, "Selects the behavior.",
        "an inline doc marker on a continued line should attach to its unique compiler-resolved parameter");
    const describeEntry = model.inner.entries.find((entry) => entry.name === "Describe");
    assert.equal(describeEntry?.declaration.parameters[0]?.documentation, "Selects the behavior.",
        "the parameter doc should also reach the matching Signature Help slot");
    const describeCallLine = sourceLines.findIndex((line) => line.includes("PolicyScope.Describe("));
    const describeCall = queryCompilerModel(model, "signature", {
        uri: sources[1].uri,
        position: { line: describeCallLine, character: sourceLines[describeCallLine].indexOf("(1") + 1 }
    }, () => {});
    assert.equal(describeCall.entries[0]?.declaration.parameters[0]?.documentation, "Selects the behavior.",
        "the native Signature Help reply should preserve parameter-specific comment documentation");
    assert.ok(describeCall.entries[0]?.declaration.compilerHeaderLibraries?.some((library) =>
        library.kind === "inclib" && library.value === "fixture" && library.filePath === headerPath),
    "the native Signature Help candidate should include accepted linker inputs from its declaring header");
    assert.match(describeCall.entries[0]?.declaration.documentation || "", /@param payload Additional data for the operation\./,
        "the native Signature Help reply should preserve the declaration's parameter tags");
    const payloadLine = headerLines.findIndex((line) => line.includes("ByVal payload"));
    const payloadHover = queryCompilerModel(model, "hover", {
        uri: sources[0].uri,
        position: { line: payloadLine, character: headerLines[payloadLine].indexOf("payload") }
    }, () => {});
    assert.equal(payloadHover.entries[0]?.declaration.documentation,
        "Additional data for the operation.",
        "parameter hovers should receive only their uniquely matched parent @param text");
    const macroLine = sourceLines.findIndex((line) => line.includes("POLICY_VERSION"));
    const macroHover = queryCompilerModel(model, "hover", {
        uri: sources[1].uri,
        position: { line: macroLine, character: sourceLines[macroLine].indexOf("POLICY_VERSION") + 2 }
    }, () => {});
    assert.equal(macroHover.entries[0]?.declaration.documentation,
        "The selected version of this policy header.",
        "compiler-mapped documentation should also follow native macro definitions into hovers");
    for (const name of ["PlainValue", "GapValue"]) {
        const line = headerLines.findIndex((value) => value.includes(`Const ${name}`));
        const declarationHover = queryCompilerModel(model, "hover", {
            uri: sources[0].uri,
            position: { line, character: headerLines[line].indexOf(name) }
        }, () => {});
        assert.equal(declarationHover.entries.find((entry) => entry.name === name)?.declaration.documentation, undefined,
            `${name} should not inherit ordinary or non-adjacent comments`);
    }
    assert.ok(valueHover.compilerHeaderLibraries.some((library) =>
        library.kind === "inclib" && library.value === "fixture" && library.filePath === headerPath),
    "hovering a declaration from an included header should show the link input accepted from that header");
    const valueUsageLine = sourceLines.findIndex((line) => line.includes("PolicyScope.Value"));
    const valueCompletion = queryCompilerModel(model, "completion", {
        uri: sources[1].uri,
        position: {
            line: valueUsageLine,
            character: sourceLines[valueUsageLine].indexOf("PolicyScope.Value") + "PolicyScope.V".length
        }
    }, () => {});
    const valueCompletionEntry = valueCompletion.entries.find((entry) => entry.name === "Value");
    assert.deepEqual(valueCompletionEntry?.declaration.compilerHeaderLibraries?.map((library) =>
        [library.kind, library.value, library.filePath]), [
        ["inclib", "fixture", headerPath], ["libpath", "percent% and\t tab", headerPath]
    ], "completion docs should receive the compiler-accepted linker inputs from the declaration's header");
    const client = model.inner.entries.find((entry) => entry.name === "Client");
    assert.ok(client?.compilerFacts?.namespaceDeclarationInputs.some((declaration) => !declaration.anonymous));

    execFileSync(compiler, ["-semantic-model", fullPath, "-i", directory, "-c", sourcePath, "-o", objectPath], {
        cwd: directory, stdio: "ignore", timeout: 30000
    });
    const fullText = semanticModelTestText(fullPath);
    const full = decodeCompilerSemanticModel(fs.readFileSync(fullPath));
    assert.equal(full.sourceHeaderPolicies.length, 2);
    assert.equal(full.sourceHeaderLibraries.length, 2);
    assert.equal(full.namespaceImportRecipients.length, 3);
    assert.equal(full.namespaceDeclarations.length, 3);

    const rewriteRows = (rewrite, detailDelta = 0) => {
        const rows = fullText.trimEnd().split(/\r?\n/);
        rewrite(rows);
        if (detailDelta) {
            const footer = rows.at(-1).split("\t");
            footer[12] = String(Number(footer[12]) + detailDelta);
            rows[rows.length - 1] = footer.join("\t");
        }
        return rows.join("\n");
    };
    const policyLine = fullText.split(/\r?\n/).find((line) => line.includes("\theader-policy:"));
    assert.ok(policyLine, "the full model should carry per-source policy receipts");
    const policyFields = policyLine.split("\t");
    const policyValue = policyFields[4].split("%09");
    policyValue[1] = String(Number(policyValue[1]) + 1);
    policyFields[4] = policyValue.join("%09");
    assert.throws(() => decodeCompilerSemanticModel(rewriteRows((rows) => {
        const index = rows.indexOf(policyLine);
        rows[index] = policyFields.join("\t");
    })), /policy counts disagree/);
    assert.throws(() => decodeCompilerSemanticModel(rewriteRows((rows) => {
        const index = rows.findIndex((line) => line.includes("\tnamespace-declaration:"));
        const fields = rows[index].split("\t");
        const value = fields[4].split("%09");
        value[2] = "2";
        fields[4] = value.join("%09");
        rows[index] = fields.join("\t");
    })), /namespace declaration input/);
    assert.throws(() => decodeCompilerSemanticModel(rewriteRows((rows) => {
        const index = rows.findIndex((line) => line.includes("\theader-import:"));
        const fields = rows[index].split("\t");
        const value = fields[4].split("%09");
        value[1] = "99999999";
        fields[4] = value.join("%09");
        rows[index] = fields.join("\t");
    })), /namespace import recipient/);
    assert.throws(() => decodeCompilerSemanticModel(rewriteRows((rows) => {
        const index = rows.findIndex((line) => line.includes("\theader-policy:"));
        rows.splice(index, 1);
    }, -1)), /policy occurrence coverage/);

    execFileSync(compiler, ["-semantic-model-expressions", compactPath, "-i", directory, "-c", sourcePath, "-o", objectPath], {
        cwd: directory, stdio: "ignore", timeout: 30000
    });
    const compact = decodeCompilerSemanticExpressions(fs.readFileSync(compactPath), () => true);
    assert.ok(compact.capabilities.some((capability) => capability.feature === "namespace-declaration-inputs" &&
        capability.coverage === "unavailable"));
    assert.deepEqual(compact.sourceHeaderPolicies, []);
    assert.deepEqual(compact.sourceHeaderLibraries, []);
    assert.deepEqual(compact.namespaceImportRecipients, []);
    assert.deepEqual(compact.namespaceDeclarations, []);
});

test("latest FBC ABI policy receipts reach full compiler-bound procedure facts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-abi-policy-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "abi-policy.bas");
    const source = [
        "Type ManagedAlias As String",
        "Declare Sub ImplicitScalar(ByVal value As Long)",
        "Declare Sub ExplicitScalar Cdecl(ByVal value As Long)",
        "Declare Sub ManagedParameter(ByRef value As ManagedAlias)",
        "Declare Function ManagedResult() As String",
        "Declare Sub ManagedPointer(ByVal value As ManagedAlias Ptr)",
        "Declare Sub CallbackHeader(ByVal callback As Sub Cdecl())",
        "Sub CallManaged()",
        "    ImplicitScalar(1)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    assert.ok(analysis.semanticCapabilities.some((capability) =>
        capability.feature === "procedure-abi-policy-inputs" && capability.coverage === "available"));
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/abi-policy.bas" },
        analysis,
        [{ uri: { fsPath: filePath, toString: () => `file://${filePath}` }, text: source }]
    );
    const expected = new Map([
        ["ImplicitScalar", [false, false]],
        ["ExplicitScalar", [true, false]],
        ["ManagedParameter", [false, true]],
        ["ManagedResult", [false, true]],
        ["ManagedPointer", [false, true]],
        ["CallbackHeader", [false, false]],
        ["CallManaged", [false, false]]
    ]);
    for (const [name, [writtenConvention, managedString]] of expected) {
        const entry = model.inner.entries.find((item) => item.name.toLowerCase() === name.toLowerCase());
        assert.ok(entry, `${name} should have a compiler-backed editor symbol`);
        const input = entry.compilerFacts?.procedureAbiPolicyInputs[0];
        assert.ok(input, `${name} should expose its native ABI header receipt`);
        assert.equal(input.writtenConvention, writtenConvention, `${name} written convention`);
        assert.equal(input.managedString, managedString, `${name} managed STRING policy`);
        assert.ok(input.statement > 0, `${name} should retain its accepted header statement`);
    }
    assert.ok(model.compilerSourceCallBindings.length > 0,
        "full FBC relationships should preserve written callees selected before argument parsing");
});

test("compiler declaration typing facts do not depend on K property record order", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const fixtures = [
        { file: "declaration-typing.bas", symbol: "explicitValue", property: "declarationInputs", minimum: 1 },
        { file: "procedure-typing.bas", symbol: "OriginalPrototype", property: "procedureTypingInputs", minimum: 2 }
    ];
    const structuredFacts = (model) => [...model.compilerFactsBySemanticIdentity.entries()]
        .map(([owner, facts]) => ({
            owner,
            declarationTypeGroups: facts.declarationTypeGroups,
            declarationInputs: facts.declarationInputs,
            procedureTypingInputs: facts.procedureTypingInputs,
            procedureWrittenVisibility: facts.procedureWrittenVisibility,
            aggregateAccess: facts.aggregateAccess
        }))
        .filter((facts) => facts.declarationTypeGroups.length || facts.declarationInputs.length ||
            facts.procedureTypingInputs.length || facts.procedureWrittenVisibility.length || facts.aggregateAccess)
        .sort((first, second) => first.owner - second.owner);

    for (const fixture of fixtures) {
        const filePath = path.join(root, "tests/semantic-sidecar", fixture.file);
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments: ["-i", path.join(root, "inc")],
            exportSemanticBindings: true,
            requireSemanticModel: true,
            timeoutMs: 120000
        });
        const sources = analysis.dependencies.filter((dependency) => fs.existsSync(dependency)).map((dependency) => ({
            uri: { scheme: "file", fsPath: dependency, toString: () => `file://${dependency}` },
            text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
        }));
        const modelFor = (modelAnalysis, name) => new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/${fixture.file}/${name}` },
            modelAnalysis,
            sources
        );
        const baseline = modelFor(analysis, "normal-order");
        const reordered = modelFor({
            ...analysis,
            semanticProperties: [...analysis.semanticProperties].reverse()
        }, "reversed-order");
        const entryFor = (model) => {
            const entry = model.inner.entries.find((candidate) => candidate.name.toLowerCase() === fixture.symbol.toLowerCase());
            assert.ok(entry?.compilerSymbolId, `${fixture.symbol} must have a compiler-bound identity`);
            return entry;
        };
        const expected = entryFor(baseline).compilerFacts?.[fixture.property] || [];
        assert.ok(expected.length >= fixture.minimum, `FBC must emit ${fixture.property} for ${fixture.symbol}`);
        assert.deepEqual(entryFor(reordered).compilerFacts?.[fixture.property] || [], expected,
            `${fixture.property} for ${fixture.symbol} must join by semantic identities`);
        assert.deepEqual(structuredFacts(reordered), structuredFacts(baseline),
            `${fixture.file} structured compiler facts must not depend on K wire order`);
    }
});

test("compiler aggregate access sections retain ordinal order after K reordering", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/semantic-sidecar/aggregate-access.bas");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        exportSemanticBindings: true,
        requireSemanticModel: true,
        timeoutMs: 120000
    });
    const sources = analysis.dependencies.filter((dependency) => fs.existsSync(dependency)).map((dependency) => ({
        uri: { scheme: "file", fsPath: dependency, toString: () => `file://${dependency}` },
        text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
    }));
    const modelFor = (modelAnalysis, name) => new CompilerSemanticModel(
        { toString: () => `freebasic-preprocessed:/${name}` },
        modelAnalysis,
        sources
    );
    const accessFor = (model) => {
        const entry = model.inner.entries.find((candidate) => candidate.name.toLowerCase() === "accessowner");
        assert.ok(entry?.compilerSymbolId, "the aggregate must have a compiler-bound identity");
        return entry.compilerFacts?.aggregateAccess;
    };
    const expected = accessFor(modelFor(analysis, "aggregate-access-order.bas"));
    assert.ok(expected?.sections.length > 1, "the current FBC fixture must contain ordered access sections");
    assert.deepEqual(expected.sections.map((section) => section.ordinal),
        expected.sections.map((section) => section.ordinal).sort((first, second) => first - second));

    const reordered = modelFor({
        ...analysis,
        semanticProperties: [...analysis.semanticProperties].reverse()
    }, "aggregate-access-order-reversed.bas");
    assert.deepEqual(accessFor(reordered), expected,
        "aggregate access sections must follow their explicit sidecar ordinal, not wire arrival order");
});

test("accepted SELECT CASE source expressions keep compiler types with and without editor tracing", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const fixtures = [
        { file: "select-case-lowering.bas", minimumCaseFacts: 30 },
        { file: "select-case-coercions.bas", minimumCaseFacts: 10 }
    ];
    const targets = [
        { name: "x86-32", arguments: ["-arch", "386"] },
        { name: "x86-64", arguments: ["-arch", "x86_64"] },
        { name: "aarch64", arguments: ["-arch", "aarch64"] }
    ];

    for (const target of targets) {
        for (const semanticModelOnly of [false, true]) {
            for (const fixture of fixtures) {
                const label = `${target.name}/${semanticModelOnly ? "sidecar-only" : "traced"}/${fixture.file}`;
                const filePath = path.join(root, "tests/semantic-sidecar", fixture.file);
                const analysis = await analyzeSavedModule({
                    compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
                    filePath,
                    compilerArguments: target.arguments,
                    exportSemanticExpressions: true,
                    requireSemanticModel: true,
                    semanticModelOnly,
                    timeoutMs: 120000
                });
                assert.equal(analysis.partial, false, `${label} must complete compiler analysis`);
                assert.equal(analysis.semanticModelSchemaVersion, 27, label);
                assert.equal(Boolean(analysis.semanticSidecarOnly), semanticModelOnly, label);

                const sources = analysis.dependencies.filter((dependency) => fs.existsSync(dependency)).map((dependency) => ({
                    uri: { fsPath: dependency, toString: () => `file://${dependency}` },
                    text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
                }));
                const source = sources.find((item) => item.uri.fsPath === filePath);
                assert.ok(source, `${label} must be present in the compiler source snapshot`);
                const model = new CompilerSemanticModel(
                    { toString: () => `freebasic-preprocessed:/${target.name}/${fixture.file}` },
                    analysis,
                    sources
                );
                const caseLines = new Set(source.text.split(/\r\n|\n|\r/).flatMap((line, index) => {
                    const statement = line.trimStart().toLowerCase();
                    return statement.startsWith("select case") || statement.startsWith("case ") ? [index] : [];
                }));
                const caseFacts = (model.compilerSidecarExpressions.get(source.uri.toString()) || [])
                    .filter((expression) => caseLines.has(expression.start.line));
                assert.ok(caseFacts.length >= fixture.minimumCaseFacts,
                    `${label} should retain the accepted selector and CASE operand expressions`);

                for (const fact of caseFacts) {
                    const result = model.expressionAt(source.uri, fact.start, fact.end);
                    const range = `${fact.start.line + 1}:${fact.start.character}-${fact.end.line + 1}:${fact.end.character}`;
                    assert.ok(result, `${label} ${range} should have a compiler type`);
                    assert.equal(result.dtype, fact.dtype, `${label} ${range} compiler dtype`);
                    assert.equal(result.typeName.toLowerCase(), fact.typeName.toLowerCase(), `${label} ${range} type spelling`);
                    assert.equal(result.provisional, false, `${label} ${range} must be authoritative`);
                    if (semanticModelOnly) assert.equal(result.semanticSource, "compiler-sidecar", `${label} ${range} must work without editor trace`);
                }
            }
        }
    }
});

test("SELECT CASE expression types follow dialect and target without editor heuristics", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-select-case-dialects-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "select-case-dialects.bas");
    const source = [
        "' Project: FreeBASIC compiler expression tests",
        "' File: select-case-dialects.bas",
        "' Purpose: Verify compiler-typed CASE expressions across language modes.",
        "' Responsibilities: cover selectors, alternatives, ranges, and expressions.",
        "' This source intentionally does NOT contain backend-specific code.",
        "Dim selector As Integer",
        "Dim dynamicValue As Integer",
        "Dim resultValue As Integer",
        "selector = 2",
        "dynamicValue = 6",
        "Select Case selector",
        "Case 1, 2 To 4, Is >= 7",
        "    resultValue = dynamicValue",
        "Case selector + 3",
        "    resultValue = dynamicValue * 2",
        "Case 10 To selector * 2",
        "    resultValue = dynamicValue",
        "Case Else",
        "    resultValue = 0",
        "End Select",
        "Print resultValue",
        "' end of select-case-dialects.bas"
    ].join("\n");
    fs.writeFileSync(filePath, source);

    const modes = [
        { name: "fb", integerType: "integer" },
        { name: "fblite", integerType: "integer" },
        { name: "qb", integerType: "short" },
        { name: "deprecated", integerType: "integer" }
    ];
    const targets = [
        { name: "x86-32", arch: "386" },
        { name: "x86-64", arch: "x86_64" },
        { name: "aarch64", arch: "aarch64" }
    ];

    for (const target of targets) {
        for (const mode of modes) {
            for (const semanticModelOnly of [false, true]) {
                const label = `${target.name}/${mode.name}/${semanticModelOnly ? "sidecar-only" : "traced"}`;
                const analysis = await analyzeSavedModule({
                    compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
                    filePath,
                    compilerArguments: ["-lang", mode.name, "-arch", target.arch],
                    overlays: new Map([[filePath, source]]),
                    exportSemanticExpressions: true,
                    requireSemanticModel: true,
                    semanticModelOnly,
                    timeoutMs: 120000
                });
                assert.equal(analysis.partial, false, `${label} must complete compiler analysis`);
                assert.equal(analysis.semanticModelSchemaVersion, 27, label);
                assert.equal(Boolean(analysis.semanticSidecarOnly), semanticModelOnly, label);

                const sources = analysis.dependencies.filter((dependency) => fs.existsSync(dependency)).map((dependency) => ({
                    uri: { fsPath: dependency, toString: () => `file://${dependency}` },
                    text: dependency === filePath
                        ? source
                        : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
                }));
                const sourceDocument = sources.find((item) => item.uri.fsPath === filePath);
                assert.ok(sourceDocument, `${label} must retain the unsaved source overlay`);
                const model = new CompilerSemanticModel(
                    { toString: () => `freebasic-preprocessed:/${label}/select-case-dialects.bas` },
                    analysis,
                    sources
                );
                const lines = source.split("\n");
                const caseLines = new Set(lines.flatMap((line, index) => {
                    const statement = line.trimStart().toLowerCase();
                    return statement.startsWith("select case") || statement.startsWith("case ") ? [index] : [];
                }));
                const caseFacts = (model.compilerSidecarExpressions.get(sourceDocument.uri.toString()) || [])
                    .filter((expression) => caseLines.has(expression.start.line));
                assert.equal(caseFacts.length, 12, `${label} must retain each selector and CASE input expression`);

                for (const fact of caseFacts) {
                    const result = model.expressionAt(sourceDocument.uri, fact.start, fact.end);
                    const range = `${fact.start.line + 1}:${fact.start.character}-${fact.end.line + 1}:${fact.end.character}`;
                    assert.ok(result, `${label} ${range} should have a compiler type`);
                    assert.equal(result.dtype, fact.dtype, `${label} ${range} compiler dtype`);
                    assert.equal(result.typeName.toLowerCase(), fact.typeName.toLowerCase(), `${label} ${range} type spelling`);
                    assert.equal(result.provisional, false, `${label} ${range} must be authoritative`);
                    if (semanticModelOnly) assert.equal(result.semanticSource, "compiler-sidecar", `${label} ${range} must work without editor trace`);
                }

                const selectorLine = lines.findIndex((line) => line.trimStart().toLowerCase().startsWith("select case"));
                const selectorFact = caseFacts.find((fact) => fact.start.line === selectorLine &&
                    lines[selectorLine].slice(fact.start.character, fact.end.character).toLowerCase() === "selector");
                assert.equal(selectorFact?.typeName.toLowerCase(), mode.integerType, `${label} selected Integer representation`);
            }
        }
    }
});

test("compiler dependency inventory supplements missing bridge include paths", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-dependencies-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "main.bas");
    const headerPath = path.join(directory, "dependency.bi");
    fs.writeFileSync(headerPath, "Dim As Integer semantic_dependency\n");
    fs.writeFileSync(sourcePath, '#include once "dependency.bi"\nPrint semantic_dependency + 1\n');

    const omitHeaderFromBridge = (text, cwd) => {
        const analysis = decodePreprocessed(text, cwd);
        analysis.dependencies = [sourcePath];
        return analysis;
    };
    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    }, omitHeaderFromBridge);

    assert.deepEqual(analysis.semanticDependencies, [sourcePath, headerPath]);
    assert.ok(analysis.dependencies.includes(headerPath), "compiler-opened include must be captured even when the bridge omitted it");
});

test("schema-27 expression sidecars retain structured recovery diagnostics", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-diagnostics-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "invalid-conditional.bas");
    const sidecarPath = path.join(directory, "semantic-model.tsv");
    const source = "dim runtime_value as long\n#if runtime_value\nprint 1\n#endif\n";
    fs.writeFileSync(sourcePath, source);

    assert.throws(() => execFileSync(compiler, [
        "-prefix", root,
        "-i", path.join(root, "inc"),
        "-gen", "gcc",
        "-maxerr", "20",
        "-semantic-model-expressions", sidecarPath,
        "-c", sourcePath,
        "-o", path.join(directory, "invalid-conditional.o")
    ], { cwd: directory, stdio: "ignore", timeout: 30000 }), (error) => error.status === 1);

    const sidecar = decodeCompilerSemanticExpressions(fs.readFileSync(sidecarPath), () => true, { allowRecovery: true });
    assert.equal(sidecar.schemaVersion, 27);
    assert.equal(sidecar.recovery, true);
    assert.ok(sidecar.semanticDiagnostics.some((diagnostic) => diagnostic.severity === "error" &&
        diagnostic.filePath === sourcePath && diagnostic.line === 2 && diagnostic.source > 0));
    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(analysis.partial, true);
    assert.ok(analysis.semanticDiagnostics.some((diagnostic) => diagnostic.code === 11 && diagnostic.line === 2),
        "native analysis should retain the compiler's structured diagnostic beside its console output");
});

test("compiler analysis refines textual diagnostics with FBCDIA physical columns", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-physical-diagnostics-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "missing-name.bas");
    fs.writeFileSync(sourcePath, "Print missingValue\n");

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const diagnostic = analysis.diagnostics.find((entry) => entry.code === 149 && entry.severity === "error");

    assert.ok(diagnostic, "text compiler diagnostics should remain available");
    /* FBC 1.20.5 rejects this implicit declaration at its statement opener. */
    assert.deepEqual(diagnostic.physicalPoint, { line: 0, character: 0 });
    assert.ok(Object.hasOwn(diagnostic, "compilerContext"), "the matching structured compiler record should be retained");
});

test("FBCDIA reports the exact physical FOR/NEXT counter mismatch context", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-for-next-diagnostic-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "next-counter.bas");
    fs.writeFileSync(sourcePath, [
        "Dim outer As Integer",
        "Dim inner As Integer",
        "For outer = 1 To 2",
        "    Next inner",
        ""
    ].join("\n"));

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const diagnostic = analysis.diagnostics.find((entry) => /FOR\/NEXT variable name mismatch/i.test(entry.message));

    assert.ok(diagnostic, "FBC should retain its normal FOR/NEXT compiler error");
    assert.equal(diagnostic.compilerContext, "for-next-variable-mismatch");
    assert.deepEqual(diagnostic.physicalPoint, { line: 3, character: 9 });
    assert.equal(diagnostic.sourceText, "Next inner");
});

test("FBCDIA pinpoints a mismatched identifier in a comma-separated NEXT list", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-for-next-list-diagnostic-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "next-list.bas");
    const source = [
        "Dim outer As Integer",
        "Dim inner As Integer",
        "Dim inenr As Integer",
        "For outer = 1 To 2",
        "    For inner = 1 To 2",
        "        Next inenr, outer",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const diagnostic = analysis.diagnostics.find((entry) =>
        /FOR\/NEXT variable name mismatch/i.test(entry.message));

    assert.ok(diagnostic, "FBC should report a mismatched first counter in a NEXT list");
    assert.equal(diagnostic.compilerContext, "for-next-variable-mismatch");
    assert.deepEqual(diagnostic.physicalPoint, { line: 5, character: 13 });
    assert.equal(diagnostic.sourceText, "Next inenr, outer");
});

test("FBCDIA locates the redundant NEXT variable warning when enabled", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-next-variable-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "next-warning.bas");
    fs.writeFileSync(sourcePath, "Dim index As Integer\nFor index = 1 To 2\nNext index\n");

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "next", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const diagnostic = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Variable following NEXT is meaningless,/i.test(entry.message));

    assert.ok(diagnostic, "-w next should emit the redundant counter warning");
    assert.deepEqual(diagnostic.physicalPoint, { line: 2, character: 5 });
});

test("FBC accepts splitting a multi-counter NEXT into unnamed statements", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-next-counter-expansion-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "next-counters.bas");
    const source = [
        "Dim outer As Integer",
        "Dim inner As Integer",
        "For outer = 1 To 2",
        "    For inner = 1 To 2",
        "    Next inner, outer",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "next", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warnings = analysis.diagnostics.filter((entry) => entry.severity === "warning" &&
        /^Variable following NEXT is meaningless,/i.test(entry.message));
    assert.equal(warnings.length, 2, "FBC should diagnose both optional counter names");
    assert.deepEqual(warnings.map((entry) => compilerMeaninglessNextVariableRange(source, entry))
        .sort((left, right) => left.startCharacter - right.startCharacter), [
        { line: 4, startCharacter: 9, endCharacter: 14, name: "inner" },
        { line: 4, startCharacter: 16, endCharacter: 21, name: "outer" }
    ], JSON.stringify(warnings));

    const expandedSource = source.replace("    Next inner, outer", "    Next\nNext");
    const expanded = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "next", "-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, expandedSource]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(expanded.diagnostics.some((entry) => entry.severity === "error"), false,
        "one bare NEXT per loop should preserve FBC's nested-loop closure behavior");
    assert.equal(expanded.diagnostics.some((entry) => entry.severity === "warning" &&
        /^Variable following NEXT is meaningless,/i.test(entry.message)), false,
    "bare NEXT statements should clear the redundant-name warnings");
});

test("FBC locates an undeclared optional NEXT counter and accepts its removal", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-next-unresolved-diagnostic-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "next-unresolved.bas");
    const source = "Dim outer As Integer\nFor outer = 1 To 2\nNext missing\n";
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const diagnostic = analysis.diagnostics.find((entry) => /Variable not declared, missing/i.test(entry.message));
    assert.ok(diagnostic, "FBC should report the unknown name after NEXT");
    assert.equal(diagnostic.compilerContext, "for-next-counter-binding");
    assert.deepEqual(diagnostic.physicalPoint, { line: 2, character: 5 });

    const fixed = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, source.replace("Next missing", "Next")]]),
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(fixed.completion.errorCount, 0, "NEXT without its optional identifier should compile");
});

test("FBC pinpoints an undeclared counter in a comma-separated NEXT list", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-next-list-unresolved-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "next-list-unresolved.bas");
    const source = [
        "Dim outer As Integer",
        "Dim inner As Integer",
        "For outer = 1 To 2",
        "    For inner = 1 To 2",
        "        Next inenr, outer",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const diagnostic = analysis.diagnostics.find((entry) => /Variable not declared, inenr/i.test(entry.message));
    assert.ok(diagnostic, "FBC should report the undeclared list entry");
    assert.equal(diagnostic.compilerContext, "for-next-counter-binding");
    assert.deepEqual(diagnostic.physicalPoint, { line: 4, character: 13 });

    const corrected = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, source.replace("inenr", "inner")]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(corrected.completion.errorCount, 0,
        "correcting the compiler-identified counter should preserve the nested NEXT sequence");
});

test("FBCDIA identifies the expected terminator when EOF leaves a procedure open", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-open-procedure-diagnostic-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const cases = [
        { fileName: "open-sub.bas", source: "Sub Incomplete()\nPrint 1\n", message: "Expected 'END SUB'" },
        { fileName: "open-if.bas", source: "Function Incomplete() As Integer\nIf 1 Then\nPrint 1\n", message: "Expected 'END IF'" }
    ];
    for (const current of cases) {
        const sourcePath = path.join(directory, current.fileName);
        fs.writeFileSync(sourcePath, current.source);
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            compilerArguments: ["-i", path.join(root, "inc")],
            allowErrors: true,
            exportSemanticExpressions: true,
            timeoutMs: 60000
        });
        const diagnostic = analysis.diagnostics.find((entry) => entry.compilerContext === "unclosed-procedure");

        assert.ok(diagnostic, "FBC should mark parser EOF while a procedure remains open");
        assert.equal(diagnostic.message, current.message,
            "the nearest unclosed block, not necessarily the containing procedure, determines the immediate terminator");
    }
});

test("FBCDIA physical procedure-signature points identify the conflicting declaration name", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-procedure-signature-diagnostic-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "prototype-mismatch.bas");
    fs.writeFileSync(sourcePath, [
        "Declare Function chooseResult() As Integer",
        "Function chooseResult() As Double",
        "Return 1",
        "End Function",
        ""
    ].join("\n"));

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const diagnostic = analysis.diagnostics.find((entry) => entry.compilerContext === "procedure-signature-mismatch");

    assert.ok(diagnostic, "FBC should retain its procedure signature context");
    assert.deepEqual(diagnostic.physicalPoint, { line: 1, character: 9 });
    assert.equal(diagnostic.sourceText, "Function chooseResult() As Double");
});

test("FBCDIA identifies unsupported ON ERROR RESUME NEXT syntax at its opening keyword", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-resume-next-diagnostic-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const cases = ["On Error Resume Next\n", "On Local Error Resume Next\n"];
    for (let index = 0; index < cases.length; index++) {
        const sourcePath = path.join(directory, `resume-next-${index}.bas`);
        fs.writeFileSync(sourcePath, cases[index]);
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            compilerArguments: ["-i", path.join(root, "inc")],
            allowErrors: true,
            exportSemanticExpressions: true,
            timeoutMs: 60000
        });
        const diagnostic = analysis.diagnostics.find((entry) => entry.compilerContext === "error-resume-next-syntax");

        assert.ok(diagnostic, "FBC should retain the parser-selected unsupported-syntax context");
        assert.deepEqual(diagnostic.physicalPoint, { line: 0, character: 0 });
        assert.equal(diagnostic.sourceText, cases[index].trim());
    }
});

test("FBCDIA locates a LINE INPUT destination whose capacity is unknown", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-line-input-capacity-diagnostic-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "line-input-capacity.bas");
    const source = "Dim buffer As ZString Ptr\nLine Input *buffer\n";
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const diagnostic = analysis.diagnostics.find((entry) => entry.compilerContext === "line-input-unknown-buffer-capacity");

    assert.ok(diagnostic, "FBC should distinguish the unknown-capacity LINE INPUT error");
    assert.deepEqual(diagnostic.physicalPoint, { line: 1, character: 12 });
    assert.equal(diagnostic.sourceText, "Line Input *buffer");
});

test("FBCDIA distinguishes case-only variable collisions and suffix-AS conflicts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-declaration-context-diagnostic-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const cases = [
        {
            fileName: "case-collision.bas",
            source: "Dim Value As Integer\nDim value As Integer\n",
            arguments: [],
            context: "variable-case-collision"
        },
        {
            fileName: "case-collision-implicit.bas",
            source: "Dim Value\nDim value\n",
            arguments: ["-lang", "deprecated"],
            context: "variable-case-collision"
        },
        {
            fileName: "suffix-as-conflict.bas",
            source: "Dim AS Integer firstValue, secondValue$\n",
            arguments: ["-lang", "deprecated"],
            context: "declaration-suffix-as-conflict",
            message: "Syntax error, secondValue",
            physicalPoint: { line: 0, character: "Dim AS Integer firstValue, secondValue$".indexOf("secondValue") }
        }
    ];

    for (const current of cases) {
        const sourcePath = path.join(directory, current.fileName);
        fs.writeFileSync(sourcePath, current.source);
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            compilerArguments: [...current.arguments, "-i", path.join(root, "inc")],
            allowErrors: true,
            exportSemanticExpressions: true,
            timeoutMs: 60000
        });
        const diagnostic = analysis.diagnostics.find((entry) => entry.compilerContext === current.context);
        assert.ok(diagnostic, `FBC should retain the ${current.context} semantic context`);
        if (current.message) assert.equal(diagnostic.message, current.message);
        if (current.physicalPoint) assert.deepEqual(diagnostic.physicalPoint, current.physicalPoint);
    }

    const caseSource = cases[0].source;
    const casePath = path.join(directory, cases[0].fileName);
    const correctedCaseSource = caseSource.replace("Dim value As Integer\n", "");
    const correctedCase = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: casePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        overlays: new Map([[casePath, correctedCaseSource]]),
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(correctedCase.completion.errorCount, 0,
        "removing the redundant declaration should preserve the existing variable and compile");

    const suffixCase = cases.find((current) => current.context === "declaration-suffix-as-conflict");
    const suffixPath = path.join(directory, suffixCase.fileName);
    const correctedSource = suffixCase.source.replace("secondValue$", "secondValue");
    const corrected = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: suffixPath,
        compilerArguments: [...suffixCase.arguments, "-i", path.join(root, "inc")],
        overlays: new Map([[suffixPath, correctedSource]]),
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(corrected.completion.errorCount, 0,
        "removing the conflict suffix should compile using the declared common AS type");
});

test("FBC warns when declaration suffixes are ignored by written AS types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-ignored-suffix-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "ignored-suffix.bas");
    const source = [
        "Dim value% As Integer",
        "Dim multiValue% As Integer, otherValue As Integer",
        "Dim arrayValue%(2) As Integer",
        "Sub Consume(parameterValue% As Integer)",
        "End Sub",
        "Sub ContinuedConsume( _",
        "    ByVal continuedValue% As Integer, _",
        "    otherValue As String _",
        ")",
        "End Sub",
        "Const constantValue% As Integer = 1",
        "Function functionValue%() As Integer",
        "    Return 1",
        "End Function",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" && entry.message === "Suffix ignored");
    assert.ok(warning, "FBC should warn that the explicit AS type takes precedence");
    assert.equal(warning.sourceText, "value%");
    assert.equal(warning.compilerDetail, "in 'value%'");
    const multiValueWarning = analysis.diagnostics.find((entry) =>
        entry.severity === "warning" && entry.message === "Suffix ignored" && entry.sourceText === "multiValue%");
    assert.ok(multiValueWarning, "FBC should identify a single ignored suffix inside a multi-declarator line");
    const arrayWarning = analysis.diagnostics.find((entry) =>
        entry.severity === "warning" && entry.message === "Suffix ignored" && entry.sourceText === "arrayValue%");
    assert.ok(arrayWarning, "FBC should report the ignored suffix on a typed array declaration");
    const parameterWarning = analysis.diagnostics.find((entry) =>
        entry.severity === "warning" && entry.message === "Suffix ignored" && entry.sourceText === "parameterValue%");
    assert.ok(parameterWarning, "FBC should also report the ignored suffix on an AS-typed formal parameter");
    assert.equal(parameterWarning.physicalPoint.line, 3);
    const continuedParameterWarning = analysis.diagnostics.find((entry) =>
        entry.severity === "warning" && entry.message === "Suffix ignored" && entry.sourceText === "continuedValue%");
    assert.ok(continuedParameterWarning, "FBC should report the ignored suffix on a continued AS-typed parameter");
    assert.deepEqual(continuedParameterWarning.physicalPoint, {
        line: 6, character: 4
    });
    const continuedSuffixRange = compilerIgnoredDeclarationSuffixRange(source, continuedParameterWarning);
    assert.deepEqual(continuedSuffixRange, {
        line: 6,
        startCharacter: source.split("\n")[6].indexOf("continuedValue%"),
        endCharacter: source.split("\n")[6].indexOf("continuedValue%") + "continuedValue%".length,
        suffixStartCharacter: source.split("\n")[6].indexOf("continuedValue%") + "continuedValue".length,
        name: "continuedValue%",
        suffix: "%",
        hasExplicitAsType: true
    });
    for (const name of ["constantValue%", "functionValue%"]) {
        assert.ok(analysis.diagnostics.some((entry) => entry.severity === "warning" &&
            entry.message === "Suffix ignored" && entry.sourceText === name),
        `FBC should report the ignored suffix on ${name}`);
    }

    const corrected = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, source
            .replace("value%", "value")
            .replace("multiValue%", "multiValue")
            .replace("arrayValue%", "arrayValue")
            .replace("parameterValue%", "parameterValue")
            .replace("continuedValue%", "continuedValue")
            .replace("constantValue%", "constantValue")
            .replace("functionValue%", "functionValue")]]),
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(corrected.diagnostics.filter((entry) => entry.severity === "warning" && entry.message === "Suffix ignored").length, 0);
});

test("FBC confirms ANY is redundant for vector NEW with a default constructor", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-any-new-init-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "any-new-init.bas");
    const source = [
        "Type AnyInitTarget",
        "    value As Integer",
        "    Declare Constructor()",
        "End Type",
        "Constructor AnyInitTarget()",
        "    value = 1",
        "End Constructor",
        "Sub AnyInitProbe()",
        "    Dim values As AnyInitTarget Ptr = New AnyInitTarget[2] { Any }",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /ANY initializer has no effect/i.test(entry.message));
    assert.ok(warning, "FBC should report the no-op ANY initializer for a type with a default constructor");
    assert.deepEqual(warning.physicalPoint, {
        line: 8, character: source.split("\n")[8].indexOf("{ Any }")
    });
    assert.deepEqual(compilerRedundantNewAnyInitializerRange(source, warning), {
        line: 8,
        startCharacter: source.split("\n")[8].indexOf("{ Any }"),
        endCharacter: source.split("\n")[8].indexOf("{ Any }") + "{ Any }".length,
        text: "{ Any }"
    });

    const correctedSource = source.replace(" { Any }", "");
    const corrected = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, correctedSource]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(corrected.diagnostics.some((entry) => entry.severity === "error"), false);
    assert.equal(corrected.diagnostics.some((entry) => entry.severity === "warning" &&
        /ANY initializer has no effect/i.test(entry.message)), false,
    "removing the compiler-confirmed no-op initializer should preserve a valid NEW vector");
});

test("FBC warns for an unterminated string and accepts closing it at line end", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-missing-quote-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "missing-quote.bas");
    const source = [
        "Sub MissingQuoteProbe()",
        "    Print \"unterminated string",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Missing closing quote in literal string$/i.test(entry.message));
    assert.ok(warning, "FBC should report the unterminated string literal");
    assert.equal(warning.line, 1);
    const line = source.split("\n")[1];
    assert.deepEqual(compilerMissingClosingQuoteRange(source, warning), {
        line: 1,
        startCharacter: line.indexOf("\""),
        endCharacter: line.length,
        insertionCharacter: line.length
    });

    const correctedSource = source.replace("unterminated string", "unterminated string\"");
    const corrected = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, correctedSource]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(corrected.diagnostics.some((entry) => entry.severity === "error"), false);
    assert.equal(corrected.diagnostics.some((entry) => entry.severity === "warning" &&
        /^Missing closing quote in literal string$/i.test(entry.message)), false);
});

test("FBC identifies a nested IF immediately after ELSE as a warning", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-if-after-else-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "if-after-else.bas");
    const source = [
        "Sub IfAfterElseProbe(ByVal firstValue As Integer, ByVal secondValue As Integer)",
        "    If firstValue Then",
        "    Else If secondValue Then",
        "            Print \"nested\"",
        "        End If",
        "    End If",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /IF.*found directly after multi-line.*ELSE/i.test(entry.message));
    assert.ok(warning, `FBC should identify ELSE followed by a nested IF: ${JSON.stringify(analysis.diagnostics)}`);
    assert.equal(warning.message, "'IF' statement found directly after multi-line 'ELSE'");
});

test("FBC pinpoints ambiguous equality after a BYREF-returning function call", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-byref-result-equality-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "byref-result-equality.bas");
    const source = [
        "Function GetReference(ByVal inputValue As Integer) ByRef As Integer",
        "    Static resultValue As Integer",
        "    Function = resultValue",
        "End Function",
        "Sub ByRefResultProbe()",
        "    GetReference(1) = 2",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "pedantic", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /parsed as equality operator in function argument/i.test(entry.message));
    assert.ok(warning, `FBC should report the ambiguous BYREF-result syntax: ${JSON.stringify(analysis.diagnostics)}`);
    assert.equal(warning.message, "'=' parsed as equality operator in function argument, not assignment to BYREF function result");
    assert.deepEqual(warning.physicalPoint, {
        line: 5, character: source.split("\n")[5].indexOf("= 2") + 2
    });

    const correctedSource = source.replace("GetReference(1) = 2", "(GetReference(1)) = 2");
    const corrected = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "pedantic", "-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, correctedSource]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(corrected.diagnostics.some((entry) => entry.severity === "error"), false);
    assert.equal(corrected.diagnostics.some((entry) => entry.severity === "warning" &&
        /parsed as equality operator in function argument/i.test(entry.message)), false);
});

test("FBC explains possible escape sequences in ordinary string literals", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-possible-escape-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "possible-escape.bas");
    const source = [
        "Sub EscapeProbe()",
        "    Print \"C:\\newfolder\"",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "pedantic", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Possible escape sequence found in/i.test(entry.message));
    assert.ok(warning, `FBC should identify a possible escape: ${JSON.stringify(analysis.diagnostics)}`);
    process.stdout.write(`${JSON.stringify(warning)}\n`);
    assert.match(compilerDiagnosticGuidance(warning),
        /This string is not escape-processed\. Prefix it with ! if you intended C-style escape sequences\./);
});

test("FBC explains when a BYREF AS ANY argument is copied to a temporary", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-byref-temporary-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "byref-temporary.bas");
    const source = [
        "Declare Sub Consume(ByRef item As Any)",
        "Sub Caller()",
        "    Dim value As Integer",
        "    Consume(@value)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /Suspicious address expression passed to BYREF parameter/i.test(entry.message));
    assert.ok(warning, `FBC should identify the temporary-backed argument: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning),
        /FBC passes a temporary for this non-addressable expression/, JSON.stringify(warning));
});

test("FBC explains why deleting an ANY PTR is undefined", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-delete-any-pointer-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "delete-any-pointer.bas");
    const source = [
        "Sub DisposePointer()",
        "    Dim pointerValue As Any Ptr",
        "    Delete pointerValue",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Deleting ANY pointers is undefined$/i.test(entry.message));
    assert.ok(warning, `FBC should identify Delete Any Ptr: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning),
        /FBC cannot determine the allocated type or required destructor through an ANY PTR/);
});

test("FBC guidance distinguishes passing a scalar as an address from passing a pointer as a value", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pointer-argument-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "pointer-arguments.bas");
    const source = [
        "Declare Sub TakePointer(ByVal value As Integer Ptr)",
        "Declare Sub TakeScalar(ByRef value As Integer)",
        "Declare Sub TakeDoublePointer(ByVal value As Double Ptr)",
        "Sub Caller()",
        "    Dim scalarValue As Integer",
        "    Dim pointerValue As Integer Ptr",
        "    Dim doublePointer As Double Ptr",
        "    TakePointer(scalarValue)",
        "    TakeScalar(pointerValue)",
        "    TakeDoublePointer(pointerValue)",
        "    pointerValue = doublePointer",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const scalarAsPointer = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Passing scalar as pointer\b/i.test(entry.message));
    const pointerAsScalar = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Passing pointer to scalar\b/i.test(entry.message));
    const differentPointerTypes = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Passing different pointer types\b/i.test(entry.message));
    const suspiciousPointerAssignment = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "Suspicious pointer assignment");
    assert.ok(scalarAsPointer, `FBC should report the scalar/pointer mismatch: ${JSON.stringify(analysis.diagnostics)}`);
    assert.ok(pointerAsScalar, `FBC should report the pointer/scalar mismatch: ${JSON.stringify(analysis.diagnostics)}`);
    assert.ok(differentPointerTypes, `FBC should report the pointer type mismatch: ${JSON.stringify(analysis.diagnostics)}`);
    assert.ok(suspiciousPointerAssignment,
        `FBC should report an incompatible pointer assignment: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(scalarAsPointer), /expects an address, not the scalar value/);
    assert.match(compilerDiagnosticGuidance(pointerAsScalar), /expects a scalar value, not a pointer/);
    assert.match(compilerDiagnosticGuidance(differentPointerTypes), /Verify their representations/);
    assert.match(compilerDiagnosticGuidance(suspiciousPointerAssignment), /assignment preserves the address/i);
});

test("FBC Passing Pointer warning explains file-transfer behavior", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-file-pointer-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "file-pointer.bas");
    const source = [
        "Sub WritePointer(ByVal handle As Integer)",
        "    Dim target As Integer",
        "    Dim pointerValue As Integer Ptr = @target",
        "    Put #handle, 0, pointerValue",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Passing Pointer\b/i.test(entry.message));
    assert.ok(warning, `FBC should warn when PUT receives a pointer: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /transfers the pointer value \(the address\), not the memory/);
});

test("FBC explains raw file transfer of a UDT containing a pointer", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-file-udt-pointer-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "file-udt-pointer.bas");
    const source = [
        "Type PointerRecord",
        "    value As Integer Ptr",
        "End Type",
        "Sub WriteRecord(ByVal handle As Integer)",
        "    Dim record As PointerRecord",
        "    Put #handle, 0, record",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^UDT with pointer, var-len string, or var-len array fields\b/i.test(entry.message));
    assert.ok(warning, `FBC should warn about raw file I/O for pointer-bearing UDTs: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /writes the UDT's in-memory representation/);
});

test("FBC mixed Boolean/numeric operation warning explains the conversion", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-mixed-boolean-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "mixed-boolean.bas");
    const source = [
        "Sub MixedOperands(ByVal condition As Boolean, ByVal bits As Integer)",
        "    Dim result As Boolean = condition And bits",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "Suspicious logic operation, mixed boolean and non-boolean operands");
    assert.ok(warning, `FBC should report the mixed Boolean operation: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /converts the Boolean operand to an integer/);
});

test("FBC signedness warning explains a negative constant compared as unsigned", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-signedness-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "signedness.bas");
    const source = [
        "Sub CompareUnsigned(ByVal unsignedValue As UInteger)",
        "    If -1 < unsignedValue Then Print \"negative\"",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "Mixing signed/unsigned operands");
    assert.ok(warning, `FBC should warn about negative signedness conversion: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /negative operand can then behave like a large positive value/);
});

test("FBC shift warning explains normalization of an out-of-range constant", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-shift-count-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "shift-count.bas");
    const source = [
        "Sub ShiftProbe()",
        "    Dim shiftSource As Integer",
        "    Print shiftSource Shl 123",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "Shift value greater than or equal to number of bits in data type");
    assert.ok(warning, `FBC should warn about an out-of-range shift: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /masks an out-of-range constant shift count/);
});

test("FBC FOR-limit warning explains counter wraparound", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-for-limit-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "for-limit.bas");
    const source = [
        "Sub UnsignedByteLimit()",
        "    For index As UByte = 0 To 255",
        "    Next index",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "FOR counter variable is unable to exceed limit value");
    assert.ok(warning, `FBC should warn when a UByte counter reaches its limit: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /counter may wrap instead of passing the limit/);
});

test("FBC branch-crossing warning explains skipped local initialization", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-branch-crossing-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "branch-crossing.bas");
    const source = [
        "Goto inner1",
        "For i As Integer = 0 To 0",
        "inner1:",
        "Next",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Branch crossing local variable definition\b/i.test(entry.message));
    assert.ok(warning, `FBC should report a jump over the FOR local: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /skips a local variable's declaration or initialization/);
});

test("FBC constant conversion warning explains a value outside the target range", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-constant-conversion-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "constant-conversion.bas");
    const source = [
        "Sub NarrowConstant()",
        "    Dim narrowValue As Byte = 300",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "Overflow in constant conversion");
    assert.ok(warning, `FBC should report the out-of-range constant: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /outside the target type's representable range/);
});

test("FBC optional parameter warning explains a prototype default mismatch", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-optional-initializer-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "optional-initializer.bas");
    const source = [
        "Type InitializerProbe",
        "    value As Integer",
        "    Declare Sub SetValue(ByVal count As Integer = 0)",
        "End Type",
        "Sub InitializerProbe.SetValue(ByVal count As Integer = 1)",
        "    value = count",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Mismatching parameter initializer\b/i.test(entry.message));
    assert.ok(warning, `FBC should report the optional-parameter mismatch: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /default differs between its declaration and definition/);
});

test("FBC CONST warning explains a mutable conversion from a const pointer", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-const-discard-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "const-discard.bas");
    const source = [
        "#pragma constness=true",
        "Sub ConstProbe()",
        "    Dim readOnlyValue As Const Integer = 1",
        "    Dim pointerValue As Const Integer Ptr = Cast(Integer Ptr, @readOnlyValue)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "constness", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^CONST qualifier discarded\b/i.test(entry.message));
    assert.ok(warning, `FBC should warn when the pointer conversion drops CONST: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /permits mutation through this alias/);
});

test("FBC reserved-global warning explains backend name collisions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-reserved-global-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "reserved-global.bas");
    const source = "#pragma reserve (extern,asm) reservedSymbol\nDim Shared reservedSymbol As Integer\n";
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Use of reserved global or backend symbol\b/i.test(entry.message));
    assert.ok(warning, `FBC should report the reserved global: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /reserved by the compiler or target backend/);
});

test("FBC command-line override warning explains that #forcelang takes precedence", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-command-line-override-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "forced-language.bas");
    fs.writeFileSync(sourcePath, '#lang "fblite"\nPrint 1\n');

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-forcelang", "fb", "-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "Command line option overrides directive");
    assert.ok(warning, `FBC should report the forced command-line dialect: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /command-line option takes precedence/);
});

test("FBC return method warning explains a function-pointer mismatch", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-return-method-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "return-method.bas");
    const source = [
        "Function ReturnMethodProbe() ByRef As Integer",
        "    Static result As Integer",
        "    Return result",
        "End Function",
        "Sub Caller()",
        "    Dim procPointer As Function() As Integer",
        "    procPointer = @ReturnMethodProbe",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Return method mismatch\b/i.test(entry.message));
    assert.ok(warning, `FBC should report the function-pointer return-method mismatch: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /function-pointer type disagree/);
});

test("FBC function-pointer return type warning explains the mismatched signature", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-function-pointer-return-type-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "function-pointer-return-type.bas");
    const source = [
        "Function ReturnText() As String",
        "    Return \"text\"",
        "End Function",
        "Sub Caller()",
        "    Dim integerProcedure As Function() As Integer",
        "    integerProcedure = @ReturnText",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Return type mismatch in function pointer$/i.test(entry.message));
    assert.ok(warning, `FBC should identify the function-pointer result mismatch: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /result type does not match the target function's result/);
});

test("FBC function-pointer warnings explain ABI and argument-count mismatches", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-function-pointer-abi-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "function-pointer-abi.bas");
    const source = [
        "Function TwoArguments(ByVal first As Integer, ByVal second As Integer) As Integer",
        "    Return first + second",
        "End Function",
        "Function FastResult __fastcall() As Integer",
        "    Return 1",
        "End Function",
        "Sub Caller()",
        "    Dim oneArgument As Function(ByVal value As Integer) As Integer",
        "    Dim defaultConvention As Function() As Integer",
        "    oneArgument = @TwoArguments",
        "    defaultConvention = @FastResult",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-lang", "deprecated", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const callingConventionWarning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Calling convention mismatch in function pointer$/i.test(entry.message));
    const argumentCountWarning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        /^Argument count mismatch in function pointer$/i.test(entry.message));
    assert.ok(callingConventionWarning,
        `FBC should report the function-pointer convention mismatch: ${JSON.stringify(analysis.diagnostics)}`);
    assert.ok(argumentCountWarning,
        `FBC should report the function-pointer arity mismatch: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(callingConventionWarning), /different calling conventions/);
    assert.match(compilerDiagnosticGuidance(argumentCountWarning), /different parameter counts/);
});

test("FBC explains a CPTR cast whose target is not a pointer", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-cptr-nonpointer-guidance-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "cptr-nonpointer.bas");
    const source = [
        "Sub PointerConversion()",
        "    Dim value As Integer",
        "    Dim numericAddress As ULongInt = CPtr(ULongInt, @value)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "pedantic", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "Cast to non-pointer");
    assert.ok(warning, `FBC should identify CPtr's non-pointer target: ${JSON.stringify(analysis.diagnostics)}`);
    assert.match(compilerDiagnosticGuidance(warning), /integer type that can hold the target's pointer width/);
});

test("FBC option snapshots keep bracket diagnostics correct in escaped string literals", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-option-escape-brackets-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "option-escape.bas");
    const source = String.raw`#if 1
Option Escape
#endif
Print "inside \" : Dim escapedOnlyName As Integer ([)]"
Print (1)`;
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-lang", "fblite", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticBindings: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        timeoutMs: 60000
    });
    assert.equal(analysis.partial, false, `FBC should accept the escaped quote: ${JSON.stringify(analysis.diagnostics)}`);
    assert.ok(analysis.semanticEscapedStringRanges.some((range) => range.filePath === sourcePath &&
        range.startLine <= 3 && range.endLine >= 3),
    `FBC should export OPTION ESCAPE for the literal's statement: ${JSON.stringify(analysis.semanticEscapedStringRanges)}`);

    const uri = {
        scheme: "file",
        fsPath: sourcePath,
        path: sourcePath,
        toString: () => `file://${sourcePath}`
    };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/option-escape.bas" }, analysis, [{ uri, text: source }]
    );
    const overrides = model.compilerBracketMaskOverrides(uri);
    const sourceDocument = model.getDocument(uri);
    const escapeRange = model.compilerDefaultEscapedStringRangeAt(uri, source.indexOf("escapedOnlyName"));
    assert.ok(escapeRange, "the compiler query should find the active escape range at a cursor offset");
    assert.ok(overrides.defaultEscapedStringRanges.some((range) =>
        range.start <= source.indexOf("inside") && range.end > source.indexOf("inside")));
    assert.ok(!sourceDocument.tokens.some((token) => token.name === "escapedOnlyName"),
        "compiler-backed source tokenization must not expose identifiers inside escaped strings");
    assert.ok(!parseFreeBasicText(source, null, overrides.defaultEscapedStringRanges).occurrences.some((occurrence) =>
        occurrence.name === "escapedOnlyName"), "compiler-aware parsing should not expose the same string content");
    assert.ok(!parseFreeBasicText(source, null, overrides.defaultEscapedStringRanges).declarations.some((declaration) =>
        declaration.name === "escapedOnlyName"), "compiler-aware parsing should not infer declarations from the string");
    const queriedOverrides = queryCompilerModel(model, "compilerBracketMaskOverrides", { uri }, () => {});
    assert.deepEqual(queriedOverrides.defaultEscapedStringRanges, overrides.defaultEscapedStringRanges,
        "the worker query path should preserve compiler-confirmed escape ranges");
    assert.deepEqual(queryCompilerModel(model, "compilerDefaultEscapedStringRangeAt", {
        uri, offset: source.indexOf("escapedOnlyName")
    }, () => {}), escapeRange, "the worker should return only the range covering the cursor");
    assert.deepEqual(findBracketProblems(source, [], overrides.remIdentifierOffsets,
        overrides.remKeywordDisabledLineOffsets, overrides.defaultEscapedStringRanges), []);
});

test("FBC warns when a function result is never assigned", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-missing-function-result-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "missing-function-result.bas");
    const source = "Function MissingResult() As Integer\nEnd Function\n";
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) => entry.severity === "warning" &&
        entry.message === "Function result was not explicitly set");
    assert.ok(warning, `FBC should report the unassigned function result: ${JSON.stringify(analysis.diagnostics)}`);
    assert.equal(compilerDiagnosticGuidance(warning),
        "Set a result with Return expression or Function = expression before the function ends.");

    const corrected = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "all", "-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, "Function MissingResult() As Integer\n    Return 1\nEnd Function\n"]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(corrected.diagnostics.some((entry) => entry.message === "Function result was not explicitly set"), false);
});

test("FBC ignored-suffix warning retains the exact suffixed keyword token", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-ignored-keyword-suffix-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "ignored-keyword-suffix.bas");
    const source = "Sub SuffixKeywordProbe()\n    Dim value As Integer\n    Let% value = 1\nEnd Sub\n";
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-lang", "fblite", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) =>
        entry.severity === "warning" && entry.message === "Suffix ignored");
    assert.ok(warning, "FBC should report that LET's suffix is ignored in this keyword position");
    assert.equal(warning.sourceText, "Let%");
    assert.equal(warning.compilerDetail, "in 'Let%'");
    assert.equal(warning.line, 2);
    assert.equal(source.split("\n")[warning.line].includes("Let%"), true);
});

test("FBC parameter-mode warning identifies the implicit scalar parameter", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-implicit-parameter-mode-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "implicit-parameter-mode.bas");
    const source = [
        "Sub ImplicitModeProbe(value As Integer)",
        "End Sub",
        "Sub ContinuedModeProbe( _",
        "    firstValue As Integer, _",
        "    secondValue As Integer _",
        ")",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-w", "pedantic", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) =>
        entry.severity === "warning" && /^No explicit BYREF or BYVAL\b/i.test(entry.message));
    assert.ok(warning, "FBC should report the implicit passing mode under -w all");
    assert.equal(warning.sourceText, "");
    assert.match(warning.message, /at parameter 1 \(value\) of ImplicitModeProbe/i);
    assert.deepEqual(warning.physicalPoint, {
        line: 0, character: source.indexOf("value")
    });
    const continuedWarning = analysis.diagnostics.find((entry) =>
        entry.severity === "warning" && /^No explicit BYREF or BYVAL\b/i.test(entry.message) &&
        /\(secondValue\)/i.test(entry.message));
    assert.ok(continuedWarning, "FBC should identify the omitted mode on a continued formal parameter");
    assert.deepEqual(continuedWarning.physicalPoint, {
        line: 4, character: source.split("\n")[4].indexOf("secondValue")
    });
});

test("FBC implicit-variable warning identifies the compiler-created read target", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-implicit-allocation-warning-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "implicit-allocation.bas");
    const source = [
        '#lang "deprecated"',
        "Sub ImplicitAllocationProbe()",
        "    Print implicitValue + implicitValue",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-lang", "deprecated", "-w", "all", "-i", path.join(root, "inc")],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    const warning = analysis.diagnostics.find((entry) =>
        entry.severity === "warning" && /^Implicit variable allocation\b/i.test(entry.message));
    assert.ok(warning, `FBC should report a first-read implicit variable: ${JSON.stringify(analysis.diagnostics)}`);
    assert.equal(warning.compilerDetail, "implicitValue");
    assert.equal(warning.sourceText, "");
    assert.match(warning.message, /implicitValue/i);
    assert.deepEqual(warning.physicalPoint, {
        line: 2, character: 4
    });

    const correctedSource = source.replace(
        "    Print implicitValue + implicitValue",
        "    Dim implicitValue As Integer\n    Print implicitValue + implicitValue"
    );
    const corrected = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        compilerArguments: ["-lang", "deprecated", "-w", "all", "-i", path.join(root, "inc")],
        overlays: new Map([[sourcePath, correctedSource]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 60000
    });
    assert.equal(corrected.diagnostics.some((entry) =>
        entry.severity === "warning" && /^Implicit variable allocation\b/i.test(entry.message)), false,
    "an explicit declaration using the selected Integer type should clear the warning");
});

test("expressions-only semantics retain completed member, index, and call prefixes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-prefixes-"));
    const sourcePath = path.join(directory, "prefixes.bas");
    const sidecarPath = path.join(directory, "prefixes.tsv");
    const objectPath = path.join(directory, "prefixes.o");
    const source = [
        "Type SemanticRangeLeaf",
        "    amount As Double",
        "End Type",
        "Type SemanticRangeBranch",
        "    leaf As SemanticRangeLeaf",
        "    leaves(0 To 2) As SemanticRangeLeaf",
        "End Type",
        "Declare Function semantic_range_factory() As SemanticRangeBranch",
        "Dim As SemanticRangeBranch semantic_branch",
        "Print semantic_branch.leaf.amount",
        "Print semantic_branch.leaves(1).amount",
        "Print semantic_range_factory().leaf.amount",
        ""
    ].join("\n");

    try {
        fs.writeFileSync(sourcePath, source);
        execFileSync(compiler, ["-semantic-model-expressions", sidecarPath, "-c", sourcePath, "-o", objectPath], {
            cwd: directory,
            stdio: "ignore",
            timeout: 30000
        });

        const model = decodeCompilerSemanticExpressions(fs.readFileSync(sidecarPath));
        const lines = source.split("\n");
        const range = (lineText, fragment) => {
            const line = lines.indexOf(lineText);
            const startColumn = lineText.indexOf(fragment);
            assert.ok(line >= 0, `missing fixture line: ${lineText}`);
            assert.ok(startColumn >= 0, `missing fixture fragment: ${fragment}`);
            return model.expressions.find((fact) => fact.physical && fact.filePath === sourcePath &&
                fact.startLine === line + 1 && fact.startColumn === startColumn &&
                fact.endLine === line + 1 && fact.endColumn === startColumn + fragment.length);
        };
        const assertType = (line, fragment, typeName) => {
            const fact = range(line, fragment);
            assert.ok(fact, `missing compiler-typed range for ${fragment}`);
            assert.equal(fact.typeName.toLowerCase(), typeName.toLowerCase());
        };

        assertType("Print semantic_branch.leaf.amount", "semantic_branch.leaf", "SemanticRangeLeaf");
        assertType("Print semantic_branch.leaf.amount", "semantic_branch.leaf.amount", "Double");
        assertType("Print semantic_branch.leaves(1).amount", "semantic_branch.leaves(1)", "SemanticRangeLeaf");
        assertType("Print semantic_branch.leaves(1).amount", "semantic_branch.leaves(1).amount", "Double");
        assertType("Print semantic_range_factory().leaf.amount", "semantic_range_factory()", "SemanticRangeBranch");
        assertType("Print semantic_range_factory().leaf.amount", "semantic_range_factory().leaf", "SemanticRangeLeaf");
        assertType("Print semantic_range_factory().leaf.amount", "semantic_range_factory().leaf.amount", "Double");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("expressions-only semantic ranges use editor columns after UTF-8 text", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-utf8-columns-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "utf8-columns.bas");
    const source = "Print \"café 😀\"; 1 + 2.0\r\n";
    fs.writeFileSync(filePath, "Print 0\r\n");

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), "Print 0\r\n", "semantic analysis must use the captured overlay without saving it");

    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const sidecarOnly = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/utf8-columns.bas" },
        { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
        [{ uri: sourceUri, text: source }]
    );
    const line = source.split("\n")[0];
    const expression = "1 + 2.0";
    const startColumn = line.indexOf(expression);
    const fact = analysis.semanticExpressions.find((item) => item.physical && item.filePath === filePath &&
        item.startLine === 1 && item.startColumn === startColumn && item.endLine === 1 &&
        item.endColumn === startColumn + expression.length);
    assert.ok(fact, "the compiler sidecar must report VS Code UTF-16 columns after a multibyte BMP and supplementary character");
    assert.equal(fact.typeName.toLowerCase(), "double");

    const typed = sidecarOnly.expressionAt(
        sourceUri,
        { line: 0, character: startColumn },
        { line: 0, character: startColumn + expression.length }
    );
    assert.equal(typed?.semanticSource, "compiler-sidecar");
    assert.equal(typed?.typeName.toLowerCase(), "double");
    assert.equal(typed?.provisional, false);
});

test("Latin-1 include bytes retain native expression locations and types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-latin1-include-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const headerPath = path.join(directory, "legacy.bi");
    const headerBytes = Buffer.concat([
        Buffer.from('Dim caption As String = "caf'),
        Buffer.from([0xe9]),
        Buffer.from('": Dim amount As Double = 1.5\n')
    ]);
    const headerText = decodeCompilerSourceBuffer(headerBytes, headerPath);
    const source = '#include once "legacy.bi"\nPrint caption, amount\n';
    fs.writeFileSync(filePath, source);
    fs.writeFileSync(headerPath, headerBytes);

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", directory],
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    assert.ok(analysis.dependencies.includes(headerPath));
    const expression = "1.5";
    const startColumn = headerText.indexOf(expression);
    const fact = analysis.semanticExpressions.find((item) => item.physical && item.filePath === headerPath &&
        item.startLine === 1 && item.startColumn === startColumn && item.endLine === 1 &&
        item.endColumn === startColumn + expression.length);
    assert.ok(fact, "the sidecar must map expressions after a Latin-1 byte to the original UTF-16 column");
    assert.equal(fact.typeName.toLowerCase(), "double");

    const headerUri = { fsPath: headerPath, toString: () => `file://${headerPath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/latin1-include.bas" },
        analysis,
        analysis.dependencies.map((dependency) => ({
            uri: { fsPath: dependency, toString: () => `file://${dependency}` },
            text: dependency === filePath ? source : decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency)
        }))
    );
    const typed = model.expressionAt(headerUri,
        { line: 0, character: startColumn }, { line: 0, character: startColumn + expression.length });
    assert.equal(typed?.typeName.toLowerCase(), "double");
    assert.equal(fs.readFileSync(headerPath).equals(headerBytes), true, "analysis must leave the original Latin-1 header unchanged");
});

test("semantic sidecar types implicit operators and lowered calls across native targets", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const fixtures = [
        {
            file: "compiler-types.bas",
            cases: [
                { expression: "ThreadCall ThreadWorker(0)", typeName: "any ptr" },
                { expression: "packets(0) + packets(0)", typeName: "packet", operatorCode: "add", operatorKind: "overloaded" },
                { expression: "WrappedValue(5).value", typeName: "long" },
                { expression: "Type<WrappedValue>(5).value", typeName: "long" }
            ]
        },
        {
            file: "compiler-expression-operations.bas",
            cases: [
                { expression: "value + 2", typeName: "integer", operatorCode: "add", operatorKind: "builtin" },
                { expression: "1 + 2 * 3", typeName: "integer", operatorCode: "", operatorKind: "none" },
                { expression: "runtimeValue Is RuntimeChild", typeName: "long", operatorCode: "identity-test", operatorKind: "builtin" },
                { expression: "Not (value > 0)", typeName: "integer", operatorCode: "less-or-equal", operatorKind: "builtin" },
                { expression: "CLng(castableValue)", typeName: "long", operatorCode: "cast", operatorKind: "overloaded" },
                { expression: "indexedInstance[0]", typeName: "double", operatorCode: "index", operatorKind: "overloaded" },
                { expression: "smartInstance->amount", typeName: "double", operatorCode: "member-access", operatorKind: "builtin" },
                { expression: "(@addressableInstance)->amount", typeName: "double" },
                { expression: "callback(1, 2, value, 4, 5)", typeName: "double" },
                { expression: "CopyIntoResult(sourceCopy).value", typeName: "long" },
                { expression: "(IIf(value > 0, sourceCopy, sourceCopy)).value", typeName: "long" },
                { expression: "(-negativeInstance).value", typeName: "long" }
            ]
        }
    ];

    const targets = [
        { name: "host", arguments: [] },
        { name: "x86-32", arguments: ["-arch", "386"] },
        { name: "aarch64", arguments: ["-arch", "aarch64"] }
    ];
    for (const target of targets) {
        for (const { file, cases } of fixtures) {
            const filePath = path.resolve(__dirname, "integration/workspace", file);
            const source = fs.readFileSync(filePath, "utf8");
            const analysis = await analyzeSavedModule({
                compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
                filePath,
                compilerArguments: target.arguments,
                exportSemanticExpressions: true,
                requireSemanticModel: true
            });
            assert.equal(analysis.partial, false, `${target.name}: ${file}`);

            const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
            const sidecarOnly = new CompilerSemanticModel(
                { toString: () => `freebasic-preprocessed:/${target.name}/${file}` },
                { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
                [{ uri: sourceUri, text: source }]
            );
            const lines = source.split("\n");
            for (const { expression, typeName, operatorCode, operatorKind } of cases) {
                const line = lines.findIndex((candidate) => candidate.includes(expression));
                assert.notEqual(line, -1, `${file} must contain ${expression}`);
                const character = lines[line].indexOf(expression);
                const result = sidecarOnly.expressionAt(
                    sourceUri,
                    { line, character },
                    { line, character: character + expression.length }
                );
                assert.equal(result?.semanticSource, "compiler-sidecar", `${target.name}: ${file}: ${expression} must be typed without the editor trace`);
                assert.equal(result?.typeName.toLowerCase(), typeName, `${target.name}: ${file}: ${expression}`);
                assert.equal(result?.provisional, false, `${target.name}: ${file}: ${expression} comes from a complete compiler pass`);

                if (operatorKind) {
                    const operatorFact = analysis.semanticExpressions.find((item) => item.physical &&
                        item.filePath === filePath && item.startLine === line + 1 &&
                        item.startColumn === character && item.endLine === line + 1 &&
                        item.endColumn === character + expression.length);
                    assert.equal(operatorFact?.operatorCode, operatorCode, `${target.name}: ${file}: ${expression} operator code`);
                    assert.equal(operatorFact?.operatorKind, operatorKind, `${target.name}: ${file}: ${expression} operator kind`);
                    if (expression === "runtimeValue Is RuntimeChild") {
                        assert.equal(operatorFact.astClass, 9, "The raw AST class still describes the lowered helper call.");
                        assert.equal(operatorFact.operator, -1, "The lowered call has no AST operator payload.");
                    }
                }
            }
        }
    }
});

test("stable built-in operator concepts survive language-mode and target changes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-operator-concepts.bas");
    const source = fs.readFileSync(filePath, "utf8");
    const lines = source.split(/\r\n|\n|\r/);
    const operations = [
        { expression: "modeValue + 2", operatorCode: "add", qbTypeName: "short" },
        { expression: "modeValue - 2", operatorCode: "subtract", qbTypeName: "short" },
        { expression: "modeValue * 2", operatorCode: "multiply", qbTypeName: "short" },
        { expression: "modeValue / 2", operatorCode: "divide", typeName: "double" },
        { expression: "modeValue \\ 2", operatorCode: "integer-divide", qbTypeName: "short" },
        { expression: "modeValue Mod 2", operatorCode: "modulo", qbTypeName: "short" },
        { expression: "modeValue ^ 2", operatorCode: "power", typeName: "double" },
        { expression: "modeValue And 2", operatorCode: "and", qbTypeName: "short" },
        { expression: "modeValue Or 2", operatorCode: "or", qbTypeName: "short" },
        { expression: "modeValue AndAlso modeValue", operatorCode: "logical-and" },
        { expression: "modeValue OrElse modeValue", operatorCode: "logical-or" },
        { expression: "modeValue Xor 2", operatorCode: "xor", qbTypeName: "short" },
        { expression: "modeValue Eqv 2", operatorCode: "equivalence", qbTypeName: "short" },
        { expression: "modeValue Imp 2", operatorCode: "implication", qbTypeName: "short" },
        { expression: 'modeText & "x"', operatorCode: "concatenate", typeName: "string" },
        { expression: "modeValue = 2", operatorCode: "equal", typeName: "integer" },
        { expression: "modeValue > 0", operatorCode: "greater-than", typeName: "integer" },
        { expression: "modeValue < 2", operatorCode: "less-than", typeName: "integer" },
        { expression: "modeValue <> 2", operatorCode: "not-equal", typeName: "integer" },
        { expression: "modeValue >= 2", operatorCode: "greater-or-equal", typeName: "integer" },
        { expression: "modeValue <= 2", operatorCode: "less-or-equal", typeName: "integer" },
        { expression: "Not modeValue", operatorCode: "not", qbTypeName: "short" },
        { expression: "+modeValue", operatorCode: "unary-plus", qbTypeName: "short" },
        { expression: "-modeValue", operatorCode: "negate", qbTypeName: "short" },
        { expression: "Not (modeValue > 0)", operatorCode: "less-or-equal", typeName: "integer" },
        { expression: "CInt(modeValue + 0.5)", operatorCode: "convert-to-integer", typeName: "integer", qbTypeName: "short" },
        { expression: "CSng(modeValue)", operatorCode: "convert-to-float", typeName: "single" },
        { expression: "modeArray(0)", operatorCode: "index", typeName: "integer", qbTypeName: "short" }
    ];
    const modes = [
        { name: "fb", arguments: [] },
        { name: "fblite", arguments: ["-lang", "fblite"] },
        { name: "qb", arguments: ["-lang", "qb"] },
        { name: "deprecated", arguments: ["-lang", "deprecated"] }
    ];
    const targets = [
        { name: "host", arguments: [] },
        { name: "x86-32", arguments: ["-arch", "386"] },
        { name: "aarch64", arguments: ["-arch", "aarch64"] }
    ];
    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };

    for (const mode of modes) {
        for (const target of targets) {
            const label = `${mode.name}/${target.name}`;
            const analysis = await analyzeSavedModule({
                compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
                filePath,
                compilerArguments: [...mode.arguments, ...target.arguments],
                exportSemanticExpressions: true,
                requireSemanticModel: true
            });
            assert.equal(analysis.partial, false, `${label} must complete the native compiler pass`);

            const model = new CompilerSemanticModel(
                { toString: () => `freebasic-preprocessed:/${label}/compiler-operator-concepts.bas` },
                { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
                [{ uri: sourceUri, text: source }]
            );
            for (const operation of operations) {
                const line = lines.findIndex((candidate) => candidate.includes(operation.expression));
                assert.notEqual(line, -1, `${operation.expression} must remain in the shared fixture`);
                const character = lines[line].indexOf(operation.expression);
                const result = model.expressionAt(
                    sourceUri,
                    { line, character },
                    { line, character: character + operation.expression.length }
                );
                assert.equal(result?.semanticSource, "compiler-sidecar", `${label}: ${operation.expression}`);
                const expectedType = mode.name === "qb"
                    ? (operation.qbTypeName || operation.typeName || "integer")
                    : (operation.typeName || "integer");
                assert.equal(result?.typeName.toLowerCase(), expectedType, `${label}: ${operation.expression} type`);
                assert.equal(result?.provisional, false, `${label}: ${operation.expression} should come from a complete pass`);
                const sidecarOnlyResult = model.expressionAtCompilerSidecarOnly(
                    sourceUri,
                    { line, character },
                    { line, character: character + operation.expression.length }
                );
                assert.equal(sidecarOnlyResult?.semanticSource, "compiler-sidecar", `${label}: ${operation.expression} sidecar-only source`);
                assert.equal(sidecarOnlyResult?.typeName.toLowerCase(), expectedType, `${label}: ${operation.expression} sidecar-only type`);
                assert.equal(sidecarOnlyResult?.provisional, false, `${label}: ${operation.expression} sidecar-only authority`);

                const fact = analysis.semanticExpressions.filter((item) => item.physical &&
                    item.filePath === filePath && item.startLine === line + 1 &&
                    item.startColumn === character && item.endLine === line + 1 &&
                    item.endColumn === character + operation.expression.length).at(-1);
                if (operation.operatorCode !== undefined) {
                    assert.equal(fact?.operatorCode, operation.operatorCode, `${label}: ${operation.expression} concept`);
                    assert.equal(fact?.operatorKind, operation.operatorKind || "builtin", `${label}: ${operation.expression} kind`);
                }

                const exactRangeFacts = analysis.semanticExpressions.filter((item) => item.physical &&
                    item.filePath === filePath && item.startLine === line + 1 &&
                    item.startColumn === character && item.endLine === line + 1 &&
                    item.endColumn === character + operation.expression.length);
                const conceptsByAstShape = new Map();
                for (const item of exactRangeFacts) {
                    const shape = JSON.stringify([
                        item.astClass, item.operator, item.dtype, item.symbol, item.subtype, item.typeName
                    ]);
                    const concepts = conceptsByAstShape.get(shape) || new Set();
                    concepts.add(`${item.operatorKind}:${item.operatorCode}`);
                    conceptsByAstShape.set(shape, concepts);
                }
                assert.ok([...conceptsByAstShape.values()].every((concepts) => concepts.size === 1),
                    `${label}: ${operation.expression} must not emit conflicting concepts for an unchanged AST fact`);
            }

            const composite = "modeValue AndAlso modeValue OrElse modeValue";
            const compositeLine = lines.findIndex((candidate) => candidate.includes(composite));
            assert.notEqual(compositeLine, -1, `${composite} must remain in the shared fixture`);
            const inner = "modeValue AndAlso modeValue";
            const innerStart = lines[compositeLine].indexOf(inner);
            const outerStart = lines[compositeLine].indexOf(composite);
            const expressionFact = (start, text) => analysis.semanticExpressions.find((item) => item.physical &&
                item.filePath === filePath && item.startLine === compositeLine + 1 &&
                item.startColumn === start && item.endLine === compositeLine + 1 &&
                item.endColumn === start + text.length);
            assert.equal(expressionFact(innerStart, inner)?.operatorCode, "logical-and",
                `${label}: the completed short-circuit prefix must retain its source concept`);
            assert.equal(expressionFact(outerStart, composite)?.operatorCode, "logical-or",
                `${label}: the outer short-circuit operation must retain its source concept`);
        }
    }
});

test("stable source-level operation concepts survive supported dialect and target changes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-operator-concepts-extended.bas");
    const source = fs.readFileSync(filePath, "utf8");
    const lines = source.split(/\r\n|\n|\r/);
    const operations = [
        { expression: "pointerValue Shl 1", operatorCode: "shift-left", typeName: "integer" },
        { expression: "pointerValue Shr 1", operatorCode: "shift-right", typeName: "integer" },
        { expression: "@pointerValue", operatorCode: "address-of", typeName: "integer ptr" },
        { expression: "*modePointer", operatorCode: "dereference", typeName: "integer" },
        { expression: "modePointer[0]", operatorCode: "dereference", typeName: "integer" },
        { expression: "Abs(realValue)", operatorCode: "absolute-value", typeName: "double" },
        {
            expression: "Sgn(realValue)", operatorCode: "sign",
            typeName: (target) => target === "x86-32" ? "double" : "long"
        },
        { expression: "Int(realValue)", operatorCode: "floor", typeName: "double" },
        { expression: "Fix(realValue)", operatorCode: "truncate", typeName: "double" },
        { expression: "Frac(realValue)", operatorCode: "fractional-part", typeName: "double" },
        { expression: "Sin(realValue)", operatorCode: "sine", typeName: "double" },
        { expression: "Atan2(realValue, integerValue)", operatorCode: "arctangent2", typeName: "double" },
        { expression: "Int(integerValue)", operatorCode: "floor", typeName: "integer" },
        { expression: "Fix(integerValue)", operatorCode: "truncate", typeName: "integer" },
        { expression: "Frac(integerValue)", operatorCode: "fractional-part", typeName: "integer" },
        { expression: "CInt(realValue)", operatorCode: "convert-to-integer", typeName: "integer", rawOperator: -1 },
        { expression: "CSng(integerValue)", operatorCode: "convert-to-float", typeName: "single", rawOperator: -1 },
        { expression: "CBool(integerValue)", operatorCode: "convert-to-boolean", typeName: "boolean", rawOperator: -1 },
        { expression: "Cast(Double, realValue)", operatorCode: "", operatorKind: "none", typeName: "double" }
    ];
    const modes = [
        { name: "fb", arguments: [] },
        { name: "fblite", arguments: ["-lang", "fblite"] },
        { name: "deprecated", arguments: ["-lang", "deprecated"] }
    ];
    const targets = [
        { name: "host", arguments: [] },
        { name: "x86-32", arguments: ["-arch", "386"] },
        { name: "aarch64", arguments: ["-arch", "aarch64"] }
    ];
    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };

    for (const mode of modes) {
        for (const target of targets) {
            const label = `${mode.name}/${target.name}`;
            const analysis = await analyzeSavedModule({
                compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
                filePath,
                compilerArguments: [...mode.arguments, ...target.arguments],
                exportSemanticExpressions: true,
                requireSemanticModel: true
            });
            assert.equal(analysis.partial, false, `${label} must complete the native compiler pass`);
            const model = new CompilerSemanticModel(
                { toString: () => `freebasic-preprocessed:/${label}/compiler-operator-concepts-extended.bas` },
                { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
                [{ uri: sourceUri, text: source }]
            );

            for (const operation of operations) {
                const line = lines.findIndex((candidate) => candidate.includes(operation.expression));
                assert.notEqual(line, -1, `${operation.expression} must remain in the shared fixture`);
                const character = lines[line].indexOf(operation.expression);
                const result = model.expressionAt(
                    sourceUri,
                    { line, character },
                    { line, character: character + operation.expression.length }
                );
                assert.equal(result?.semanticSource, "compiler-sidecar", `${label}: ${operation.expression}`);
                const expectedType = typeof operation.typeName === "function"
                    ? operation.typeName(target.name)
                    : operation.typeName;
                assert.equal(result?.typeName.toLowerCase(), expectedType, `${label}: ${operation.expression} type`);
                const fact = analysis.semanticExpressions.filter((item) => item.physical &&
                    item.filePath === filePath && item.startLine === line + 1 &&
                    item.startColumn === character && item.endLine === line + 1 &&
                    item.endColumn === character + operation.expression.length).at(-1);
                assert.equal(fact?.operatorCode, operation.operatorCode, `${label}: ${operation.expression} concept`);
                assert.equal(fact?.operatorKind, operation.operatorKind || "builtin", `${label}: ${operation.expression} kind`);
                if (operation.rawOperator !== undefined) {
                    assert.equal(fact?.rawOperator ?? fact?.operator, operation.rawOperator,
                        `${label}: ${operation.expression} raw operator is not read from conversion flags`);
                    assert.equal(fact?.astClass, 5, `${label}: ${operation.expression} is a conversion AST node`);
                }
            }
        }
    }
});

test("unsaved compiler overlays retain source-level operation concepts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-operator-concepts-extended.bas");
    const source = [
        "Dim unsavedInteger As Integer = 5",
        "Dim unsavedReal As Double = 3.5",
        "Print Int(unsavedInteger)",
        "Print Frac(unsavedReal)",
        "Print CBool(unsavedInteger)",
        ""
    ].join("\n");
    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false, "the unsaved root overlay must complete native analysis");

    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/unsaved-operation-concepts.bas" },
        { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
        [{ uri: sourceUri, text: source }]
    );
    const operations = [
        { expression: "Int(unsavedInteger)", operatorCode: "floor", typeName: "integer" },
        { expression: "Frac(unsavedReal)", operatorCode: "fractional-part", typeName: "double" },
        { expression: "CBool(unsavedInteger)", operatorCode: "convert-to-boolean", typeName: "boolean" }
    ];
    const lines = source.split("\n");
    for (const operation of operations) {
        const line = lines.findIndex((candidate) => candidate.includes(operation.expression));
        assert.notEqual(line, -1, `${operation.expression} must exist in the unsaved overlay`);
        const character = lines[line].indexOf(operation.expression);
        const fact = analysis.semanticExpressions.find((item) => item.physical &&
            item.filePath === filePath && item.startLine === line + 1 &&
            item.startColumn === character && item.endLine === line + 1 &&
            item.endColumn === character + operation.expression.length);
        assert.equal(fact?.operatorCode, operation.operatorCode, `${operation.expression} overlay concept`);
        assert.equal(fact?.operatorKind, "builtin", `${operation.expression} overlay kind`);

        const result = model.expressionAtCompilerSidecarOnly(
            sourceUri,
            { line, character },
            { line, character: character + operation.expression.length }
        );
        assert.equal(result?.semanticSource, "compiler-sidecar", `${operation.expression} must use the overlay sidecar`);
        assert.equal(result?.typeName.toLowerCase(), operation.typeName, `${operation.expression} overlay type`);
        assert.equal(result?.provisional, false, `${operation.expression} comes from a complete native pass`);
    }
});

test("implicit quirk expression types and selected helpers survive dialect and target changes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-implicit-quirk-matrix.bas");
    const source = fs.readFileSync(filePath, "utf8");
    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const operations = [
        { expression: "CVL(encoded)", typeName: "long", helper: "FB_CVL" },
        {
            expression: "CVI(encoded)",
            typeName: (mode) => mode === "qb" ? "short" : "integer",
            helper: (mode, target) => mode === "qb" ? "__FB_CVSHORT" : target === "x86-32" ? "FB_CVL" : "FB_CVLONGINT"
        },
        { expression: "CVSHORT(encoded)", typeName: "short", helper: "FB_CVSHORT", unsupported: ["qb"] },
        { expression: "Str$(number)", typeName: "string" },
        { expression: "Sqr(number)", typeName: "double" },
        { expression: "LBound(values)", typeName: "integer" },
        { expression: "Seek(1)", typeName: "longint", helper: "FB_FILETELL" },
        { expression: "Err", typeName: "long", helper: "FB_ERRORGETNUM" },
        { expression: "Color()", typeName: "ulong", helper: "FB_COLOR" },
        { expression: "View Print()", typeName: "long", helper: "FB_CONSOLEVIEW" },
        { expression: "Width()", typeName: "long", helper: "FB_WIDTH" },
        {
            expression: "ImageCreate(1, 1)",
            typeName: "any ptr",
            helper: (mode) => ["fblite", "deprecated"].includes(mode) ? "FB_GFXIMAGECREATEQB" : "FB_GFXIMAGECREATE",
            unsupported: ["qb"]
        },
        { expression: "IIf(number > 0, number, 0)", typeName: (mode) => mode === "qb" ? "single" : "integer", unsupported: ["qb"] },
        { expression: "Mid$(encoded, 1)", typeName: "string" },
        { expression: 'InStr(encoded, "x")', typeName: "integer", helper: "FB_STRINSTR" },
        { expression: "Timer", typeName: "double", helper: "TIMER" },
        { expression: "Inkey$", typeName: "string" }
    ];
    const modes = [
        { name: "fb", arguments: [] },
        { name: "fblite", arguments: ["-lang", "fblite"] },
        { name: "qb", arguments: ["-lang", "qb"] },
        { name: "deprecated", arguments: ["-lang", "deprecated"] }
    ];
    const targets = [
        { name: "host", arguments: [] },
        { name: "x86-32", arguments: ["-arch", "386"] },
        { name: "aarch64", arguments: ["-arch", "aarch64"] }
    ];
    const unchangedDiskSource = fs.readFileSync(filePath, "utf8");
    const qbOnlyUnsupportedLines = new Set([
        "Print CVSHORT(encoded)",
        "Print ImageCreate(1, 1)",
        "Print IIf(number > 0, number, 0)"
    ]);

    for (const mode of modes) {
        const modeSource = mode.name === "qb"
            ? source.split(/\r\n|\n|\r/).filter((line) => !qbOnlyUnsupportedLines.has(line.trim())).join("\n")
            : source;
        const lines = modeSource.split(/\r\n|\n|\r/);
        for (const target of targets) {
            const label = `${mode.name}/${target.name}`;
            const analysis = await analyzeSavedModule({
                compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
                filePath,
                compilerArguments: ["-i", path.join(root, "inc"), ...mode.arguments, ...target.arguments],
                overlays: new Map([[filePath, modeSource]]),
                exportSemanticExpressions: true,
                requireSemanticModel: true
            });
            assert.equal(analysis.partial, false, `${label} must complete the native compiler pass`);
            assert.equal(analysis.completion.errorCount, 0, `${label} fixture must be valid for its dialect`);
            assert.equal(analysis.completion.reachedEnd, true, `${label} must parse the complete fixture`);

            const model = new CompilerSemanticModel(
                { toString: () => `freebasic-preprocessed:/${label}/compiler-implicit-quirk-matrix.bas` },
                { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
                [...new Set([filePath, ...analysis.dependencies.filter((dependency) => fs.existsSync(dependency)).map((dependency) => path.resolve(dependency))])]
                    .map((sourcePath) => ({
                        uri: sourcePath === filePath
                            ? sourceUri
                            : { fsPath: sourcePath, toString: () => `file://${sourcePath}` },
                        text: sourcePath === filePath
                            ? modeSource
                            : decodeCompilerSourceBuffer(fs.readFileSync(sourcePath), sourcePath).replace(/^\uFEFF/, "")
                    }))
            );
            const expandedLines = analysis.text.split(/\r\n|\n|\r/);
            for (const operation of operations.filter((candidate) => !candidate.unsupported?.includes(mode.name))) {
                const line = lines.findIndex((candidate) => candidate.trim() === `Print ${operation.expression}`);
                assert.notEqual(line, -1, `${label}: fixture must contain ${operation.expression}`);
                const character = lines[line].indexOf(operation.expression);
                const end = { line, character: character + operation.expression.length };
                const expectedType = typeof operation.typeName === "function" ? operation.typeName(mode.name) : operation.typeName;
                const fact = analysis.semanticExpressions.find((item) => item.physical &&
                    item.filePath === filePath && item.startLine === line + 1 &&
                    item.startColumn === character && item.endLine === line + 1 &&
                    item.endColumn === end.character);
                assert.ok(fact, `${label}: sidecar must retain ${operation.expression}`);
                assert.equal(fact.typeName.toLowerCase(), expectedType, `${label}: sidecar type for ${operation.expression}`);

                const result = model.expressionAt(sourceUri, { line, character }, end);
                assert.equal(result?.semanticSource, "compiler-sidecar", `${label}: ${operation.expression} must work without the trace`);
                assert.equal(result?.typeName.toLowerCase(), expectedType, `${label}: editor type for ${operation.expression}`);
                assert.equal(result?.provisional, false, `${label}: complete compiler facts are authoritative`);

                if (operation.helper) {
                    const node = analysis.expressionGraph.nodes.find((candidate) => {
                        const expandedLine = expandedLines[candidate.start.line] || "";
                        return candidate.kind === "call" &&
                            expandedLine.slice(candidate.start.character, candidate.end.character) === operation.expression;
                    });
                    assert.ok(node, `${label}: compiler graph must retain the selected helper for ${operation.expression}`);
                    const expectedHelper = typeof operation.helper === "function"
                        ? operation.helper(mode.name, target.name)
                        : operation.helper;
                    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === node.target)?.name,
                        expectedHelper, `${label}: selected helper for ${operation.expression}`);
                }
            }
        }
    }

    assert.equal(fs.readFileSync(filePath, "utf8"), unchangedDiskSource, "Dialect overlays must not rewrite the shared fixture");
});

test("compiler sidecar withholds an out-of-line macro-adjacent range while trace typing stays available", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/pp/expansion-consecutive-3.bas");
    const sidecarDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-range-bound-"));
    t.after(() => fs.rmSync(sidecarDirectory, { recursive: true, force: true }));
    const sidecarPath = path.join(sidecarDirectory, "semantic-model.tsv");
    const objectPath = path.join(sidecarDirectory, "expansion-consecutive-3.o");
    const source = decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath).replace(/^\uFEFF/, "");
    const lines = source.split(/\r\n|\n|\r/);
    const lineIndex = lines.findIndex((line) => line.includes("{ 1 }"));
    assert.ok(lineIndex >= 0);

    execFileSync(process.env.FBC_EDITOR_EXECUTABLE, ["-semantic-model", sidecarPath, "-c", filePath, "-o", objectPath], {
        cwd: path.dirname(filePath),
        stdio: "ignore",
        timeout: 30000
    });
    const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
    const invalidRange = semantic.expressions.find((expression) => expression.filePath === filePath &&
        expression.startLine === lineIndex + 1 && expression.endColumn > lines[lineIndex].length);
    assert.ok(invalidRange, "the compiler should retain the type fact for inspection");
    assert.equal(invalidRange.physical, false, "an out-of-line parser cursor is not an editable source range");

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        allowErrors: true
    });
    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/expansion-consecutive-3.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const column = lines[lineIndex].indexOf("1");
    const writtenType = model.expressionAt(sourceUri,
        { line: lineIndex, character: column },
        { line: lineIndex, character: column + 1 });
    assert.equal(writtenType?.typeName.toLowerCase(), "integer");
});

test("physical semantic ranges validate Unicode columns and parser bounds in every BOM encoding", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-encoded-ranges-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const source = [
        "' TEST_MODE : COMPILE_ONLY_OK",
        'dim as integer unicode_value = len("café 😀") + 1',
        "#line 39",
        'dim as integer padding = len("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")',
        "#line 38",
        "#define D .",
        "dim array(0 to D D D) as integer => { 1 }",
        ""
    ].join("\r\n");
    const lines = source.split(/\r\n|\n|\r/);
    const unicodeExpression = 'len("café 😀") + 1';
    const unicodeStart = lines[1].indexOf(unicodeExpression);
    const invalidLine = lines.findIndex((line) => line.includes("{ 1 }"));
    assert.ok(unicodeStart >= 0);
    assert.ok(invalidLine >= 0);

    for (const format of ["utf8", "utf16le", "utf16be", "utf32le", "utf32be"]) {
        const filePath = path.join(directory, `encoded-${format}.bas`);
        const sidecarPath = path.join(directory, `encoded-${format}.semantic-model.tsv`);
        const objectPath = path.join(directory, `encoded-${format}.o`);
        fs.writeFileSync(filePath, encodeSemanticTestSource(source, format));

        execFileSync(process.env.FBC_EDITOR_EXECUTABLE, ["-semantic-model", sidecarPath, "-c", filePath, "-o", objectPath], {
            cwd: directory,
            stdio: "ignore",
            timeout: 30000
        });

        const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
        const unicodeFact = semantic.expressions.find((expression) => expression.filePath === filePath &&
            expression.startLine === 2 && expression.startColumn === unicodeStart &&
            expression.endLine === 2 && expression.endColumn === unicodeStart + unicodeExpression.length);
        assert.ok(unicodeFact, `${format}: Unicode expression should use editor UTF-16 columns`);
        assert.equal(unicodeFact.physical, true,
            `${format}: valid Unicode expression range should stay physical: ${JSON.stringify(unicodeFact)}`);

        const outOfLineFact = semantic.expressions.find((expression) => expression.filePath === filePath &&
            expression.startLine === 40 && expression.startColumn >= lines[invalidLine].indexOf("=>") &&
            expression.endColumn > lines[invalidLine].length);
        assert.ok(outOfLineFact, `${format}: compiler should retain the out-of-line fact for inspection`);
        assert.equal(outOfLineFact.physical, false, `${format}: out-of-line parser range must not be editable`);
    }
});

test("malformed BOM-marked UTF-8/16/32 source cannot produce editable sidecar ranges", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-invalid-encoding-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourceText = "dim as integer malformed_value = 1 '";
    const malformedSuffixes = {
        utf8: [0xff],
        utf16le: [0x00, 0xd8],
        utf16be: [0xd8, 0x00],
        utf32le: [0x00, 0x00, 0x11, 0x00],
        utf32be: [0x00, 0x11, 0x00, 0x00]
    };

    for (const [format, suffix] of Object.entries(malformedSuffixes)) {
        const filePath = path.join(directory, `invalid-${format}.bas`);
        const sidecarPath = path.join(directory, `invalid-${format}.semantic-model.tsv`);
        const objectPath = path.join(directory, `invalid-${format}.o`);
        const sourceBytes = Buffer.concat([
            encodeSemanticTestSource(sourceText, format),
            Buffer.from(suffix)
        ]);
        fs.writeFileSync(filePath, sourceBytes);

        execFileSync(process.env.FBC_EDITOR_EXECUTABLE, ["-semantic-model", sidecarPath, "-c", filePath, "-o", objectPath], {
            cwd: directory,
            stdio: "ignore",
            timeout: 30000
        });

        const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
        const fact = semantic.expressions.find((expression) => expression.filePath === filePath &&
            expression.startLine === 1 && expression.startColumn === sourceText.indexOf("= 1") + 2);
        assert.ok(fact, `${format}: compiler should retain the valid expression before the malformed trailing code unit`);
        assert.equal(fact.physical, false, `${format}: malformed encoded line must fail closed for editing`);
    }
});

test("compiler sidecar does not reuse line bounds across repeated #line locations", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-remapped-range-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "semantic-remapped-range.bas");
    const sidecarPath = path.join(directory, "semantic-model.tsv");
    const objectPath = path.join(directory, "semantic-remapped-range.o");
    const badLine = "dim array(0 to D D D) as integer => { 1 }";
    const source = [
        '#line 23 "semantic-remapped.bas"',
        'dim as integer padding = len("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")',
        '#line 22 "semantic-remapped.bas"',
        "#define D .",
        badLine
    ].join("\n") + "\n";
    fs.writeFileSync(filePath, source);

    execFileSync(process.env.FBC_EDITOR_EXECUTABLE, ["-semantic-model", sidecarPath, "-c", filePath, "-o", objectPath], {
        cwd: directory,
        stdio: "ignore",
        timeout: 30000
    });
    const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
    const nonphysicalRemap = semantic.sourceRemaps.find((remap) => !remap.physical);
    assert.ok(nonphysicalRemap, "the second #line directive should remain nonphysical");
    assert.ok(nonphysicalRemap.range.filePath && nonphysicalRemap.range.startLine > 0,
        "the sidecar should retain its directive span as provenance without marking it physical");
    const outOfLineRange = semantic.expressions.find((item) =>
        item.filePath === "semantic-remapped.bas" && item.startLine === 24 &&
        item.startColumn === 41 && item.endColumn === 42);
    assert.ok(outOfLineRange, "the compiler should retain the parser fact for diagnostics and audits");
    assert.equal(outOfLineRange.physical, false,
        "a prior longer line with the same #line identity must not make this range physical");
});

test("compiler sidecar retains physical expression ranges beyond the diagnostic line window", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-long-line-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "semantic-long-line.bas");
    const sidecarPath = path.join(directory, "semantic-model.tsv");
    const objectPath = path.join(directory, "semantic-long-line.o");
    const expression = 'Len("😀") + 1 + 2';
    const prefix = `Print ${" ".repeat(1500)}`;
    fs.writeFileSync(filePath, `${prefix}${expression}\n`);

    execFileSync(process.env.FBC_EDITOR_EXECUTABLE, ["-semantic-model", sidecarPath, "-c", filePath, "-o", objectPath], {
        cwd: directory,
        stdio: "ignore",
        timeout: 30000
    });
    const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
    const fact = semantic.expressions.find((item) =>
        item.filePath === filePath && item.startLine === 1 &&
        item.startColumn === prefix.length && item.endColumn === prefix.length + expression.length);
    assert.ok(fact, "the compiler should export the expression at its actual source columns");
    assert.equal(fact.physical, true,
        "diagnostic line truncation must not downgrade an otherwise direct source range");
});

test("compiler semantic analysis reads long physical lines from unsaved overlays", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const original = fs.readFileSync(filePath, "utf8");
    const expression = 'Len("😀") + 1 + 2';
    const prefix = `Print ${" ".repeat(1500)}`;
    const source = `${prefix}${expression}\n`;
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });

    assert.equal(analysis.partial, false);
    const fact = analysis.semanticExpressions.find((item) => item.physical && item.filePath === filePath &&
        item.startLine === 1 && item.startColumn === prefix.length &&
        item.endColumn === prefix.length + expression.length);
    assert.equal(fact?.typeName.toLowerCase(), "integer");
    assert.equal(fs.readFileSync(filePath, "utf8"), original,
        "semantic line checks must read the compiler overlay without saving it");
});

test("oversized compiler traces fall back to expression typing with unsaved source overlays", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/compound/select_const2.bas");
    const originalBytes = fs.readFileSync(filePath);
    const original = decodeCompilerSourceBuffer(originalBytes, filePath).replace(/^\uFEFF/, "");
    const appended = "Print 1 + 2.0";
    const source = `${original}${original.endsWith("\n") ? "" : "\n"}${appended}\n`;
    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        allowErrors: true,
        timeoutMs: 120000
    });

    assert.equal(analysis.semanticSidecarOnly, true,
        "the intentionally high-expansion module must use the trace-free sidecar pass");
    assert.equal(analysis.partial, false);
    assert.equal(analysis.protocolVersion, 0, "a sidecar-only model must not claim native trace inventories");
    assert.ok(analysis.dependencies.includes(filePath));
    assert.equal(fs.readFileSync(filePath).equals(originalBytes), true,
        "the fallback must type the unsaved overlay without changing disk contents");

    const line = source.split(/\r\n|\n|\r/).findIndex((candidate) => candidate === appended);
    const startColumn = appended.indexOf("1 + 2.0");
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/oversized-sidecar-fallback.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const typed = model.expressionAt(sourceUri,
        { line, character: startColumn },
        { line, character: startColumn + "1 + 2.0".length });
    assert.equal(typed?.semanticSource, "compiler-sidecar");
    assert.equal(typed?.typeName.toLowerCase(), "double");
    assert.equal(typed?.provisional, false);
});

test("oversized compiler traces retain full semantic bindings and implicit calls", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/compound/select_const2.bas");
    const compilerArguments = ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")];
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments,
        allowErrors: true,
        exportSemanticBindings: true,
        requireSemanticModel: true,
        timeoutMs: 120000
    });

    assert.equal(analysis.semanticSidecarOnly, true,
        "the high-expansion module should retry without allocating the oversized compiler trace");
    assert.equal(analysis.partial, false);
    assert.ok(analysis.semanticBindings.length > 0);
    assert.ok(Array.isArray(analysis.semanticImplicitCalls));
    assert.ok(analysis.semanticModelCounts.bindingCount >= analysis.semanticBindings.length);
    assert.ok(analysis.semanticModelCounts.implicitCallCount >= analysis.semanticImplicitCalls.length);
    const sources = analysis.dependencies.map((dependency) => ({
        uri: { fsPath: dependency, toString: () => `file://${dependency}` },
        text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
    }));
    const coverage = measureSemanticBindingCoverage(analysis, sources);
    assert.equal(coverage.missingSources, 0);
    assert.equal(coverage.outOfBoundsRanges, 0);
    assert.equal(coverage.invalidPhysicalRanges, 0);
    assert.equal(coverage.invalidSignatures, 0);
});

test("trace fallback preserves include discovery when only an unopened header has directive facts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/compound/select_const2.bas");
    const headerPath = path.join(root, "tests/fbcunit/inc/fbcunit.bi");
    const source = decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath).replace(/^\uFEFF/, "");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: false,
        requireSemanticModel: true,
        timeoutMs: 120000
    });

    assert.equal(analysis.semanticSidecarOnly, true);
    assert.deepEqual(analysis.semanticExpressions, [],
        "facts in an unopened include must not be projected onto an unrelated source buffer");
    assert.ok(analysis.dependencies.includes(headerPath),
        "the complete compiler dependency inventory must let a prepared model request the included header on its second pass");
});

test("oversized symbol traces fall back to the compiler expression sidecar", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const headerPath = path.join(root, "inc/win/shellapi.bi");
    if (!fs.existsSync(headerPath)) return t.skip("the compiler source checkout has no Win32 shellapi.bi header");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-symbol-limit-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "shellapi-context.bas");
    const source = '#include once "shellapi.bi"\n';
    fs.writeFileSync(filePath, source);

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-target", "win32", "-i", path.dirname(headerPath), "-i", path.join(root, "inc")],
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        timeoutMs: 120000
    });

    assert.equal(analysis.semanticSidecarOnly, true);
    assert.equal(analysis.semanticModelFallbackReason, "compiler-trace-record-limit");
    assert.equal(analysis.partial, false);
    assert.ok(analysis.dependencies.includes(headerPath));
    assert.ok(analysis.semanticExpressions.length > 0);
});

test("oversized macro maps fall back to the compiler expression sidecar", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const root = "/home/jkfirth/fb_corpus";
    const filePath = path.join(root, "fb-ext-lib/examples/file/file.bas");
    if (!fs.existsSync(filePath)) return t.skip("the compatibility corpus does not include the external-library examples");

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: [
            "-i", path.dirname(filePath),
            "-i", path.join(root, "fb-ext-lib/include/freebasic"),
            "-i", path.join(root, "compat")
        ],
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        timeoutMs: 120000
    });

    assert.equal(analysis.semanticSidecarOnly, true);
    assert.equal(analysis.semanticModelFallbackReason, "compiler-trace-record-limit");
    assert.equal(analysis.partial, false);
    assert.ok(analysis.dependencies.includes(filePath));
    assert.ok(analysis.semanticExpressions.length > 0);

    const sources = analysis.dependencies.map((dependency) => ({
        uri: { fsPath: dependency, toString: () => `file://${dependency}` },
        text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
    }));
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/fb-corpus/hashtable-file.bas" },
        analysis,
        sources
    );
    const coverage = measureSemanticSidecarCoverage(analysis, model, sources);
    assert.equal(coverage.missing, 0);
    assert.equal(coverage.typeMismatches, 0);
    assert.equal(coverage.sidecarOnlyMissing, 0);
    assert.equal(coverage.sidecarOnlyTypeMismatches, 0);
});

test("a normal schema-27 fbc supplies saved expression types and refuses unsaved headers", { skip: !process.env.FBC_EXECUTABLE && !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-plain-fbc-sidecar-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const headerPath = path.join(directory, "values.bi");
    const rootText = '#include "values.bi"\nPrint getValue() + 1\n';
    const diskHeader = "Declare Function getValue() As Integer\n";
    fs.writeFileSync(filePath, rootText);
    fs.writeFileSync(headerPath, diskHeader);
    const compilerPath = process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE;
    const analysis = await analyzeSavedModule({
        compilerPath,
        filePath,
        compilerArguments: ["-i", directory],
        overlays: new Map([[filePath, rootText], [headerPath, diskHeader]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        semanticModelOnly: true,
        timeoutMs: 60000
    });

    assert.equal(analysis.semanticSidecarOnly, true);
    assert.equal(analysis.semanticModelFallbackReason, "compiler-sidecar-only");
    assert.equal(analysis.semanticModelSchemaVersion, 27);
    assert.equal(analysis.protocolVersion, 0, "plain fbc must not claim bridge trace inventories");
    assert.ok(analysis.dependencies.includes(headerPath));
    assert.equal(fs.readFileSync(headerPath, "utf8"), diskHeader,
        "semantic sidecar analysis must leave saved source untouched");

    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const sources = analysis.dependencies.map((dependency) => ({
        uri: { fsPath: dependency, toString: () => `file://${dependency}` },
        text: decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "")
    }));
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/plain-fbc-sidecar.bas" },
        analysis,
        sources
    );
    const expression = "getValue() + 1";
    const startColumn = rootText.split("\n")[1].indexOf(expression);
    const typed = model.expressionAt(sourceUri,
        { line: 1, character: startColumn },
        { line: 1, character: startColumn + expression.length });
    assert.equal(typed?.semanticSource, "compiler-sidecar");
    assert.equal(typed?.typeName.toLowerCase(), "integer");
    assert.equal(typed?.provisional, false);

    await assert.rejects(analyzeSavedModule({
        compilerPath,
        filePath,
        compilerArguments: ["-i", directory],
        overlays: new Map([[filePath, rootText], [headerPath, "Declare Function getValue() As Double\n"]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        semanticModelOnly: true,
        timeoutMs: 60000
    }), /(?:requires the editor bridge for unsaved analysis|source changed after semantic analysis)/);
});

test("expressions-only compiler semantics retain intermediate expression types from unsaved overlays", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-intermediate-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "intermediate-expressions.bas");
    const original = "Print 1\n";
    fs.writeFileSync(filePath, original);
    const source = [
        "dim as double semantic_factor",
        "dim as integer semantic_result",
        "semantic_result = 2 + 3 * semantic_factor",
        "type SemanticInnerRecord",
        "    precise as double",
        "    declare function readValue() as double",
        "end type",
        "function SemanticInnerRecord.readValue() as double",
        "    return precise",
        "end function",
        "type SemanticRangeRecord",
        "    precise as double",
        "    nested as SemanticInnerRecord",
        "end type",
        "dim as SemanticRangeRecord semantic_record",
        "dim semantic_records(0 to 1) as SemanticRangeRecord",
        "semantic_result = -semantic_factor",
        "semantic_result = semantic_record.precise",
        "semantic_result = semantic_record.nested.readValue()",
        "semantic_result = semantic_records(0).precise",
        "semantic_result = len(\"abc\")",
        "semantic_result = sizeof(semantic_factor + 1)",
        "semantic_result = iif(semantic_factor > 0, semantic_factor + 1, semantic_factor + 2)",
        "Print 1 AndAlso 2 AndAlso 3",
        "Print 1 Xor 2 Xor 3",
        "Print 1 Or 2 Or 3",
        "Print 1 And 2 And 3",
        "Print 1 < 2 < 3",
        "Print \"a\" & \"b\" & \"c\"",
        "Print 1 + 2 + semantic_factor + 4",
        "Print 1 Shl 2 Shl 3",
        "Print 17 Mod 5 Mod 2",
        "Print 17 \\ 5 \\ 2",
        "Print 2 * 3 * 4",
        "Print 2 ^ 3 ^ 2",
        ""
    ].join("\n");

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), original,
        "intermediate semantic ranges must come from the captured unsaved overlay");

    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const sidecarOnly = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/intermediate-expressions.bas" },
        { ...analysis, expressions: [] },
        [{ uri: sourceUri, text: source }]
    );
    const expectedExpressions = [
        { line: 2, expression: "3 * semantic_factor", typeName: "double" },
        { line: 2, expression: "2 + 3 * semantic_factor", typeName: "double" },
        { line: 16, expression: "-semantic_factor", typeName: "double" },
        { line: 17, expression: "semantic_record.precise", typeName: "double" },
        { line: 18, expression: "semantic_record.nested.readValue()", typeName: "double" },
        { line: 19, expression: "semantic_records(0).precise", typeName: "double" },
        { line: 20, expression: 'len("abc")', typeName: "integer" },
        { line: 21, expression: "sizeof(semantic_factor + 1)", typeName: "integer" },
        { line: 21, expression: "semantic_factor + 1", typeName: "double" },
        { line: 22, expression: "iif(semantic_factor > 0, semantic_factor + 1, semantic_factor + 2)", typeName: "double" },
        { line: 22, expression: "semantic_factor > 0", typeName: "integer" },
        { line: 22, expression: "semantic_factor + 1", typeName: "double" },
        { line: 22, expression: "semantic_factor + 2", typeName: "double" },
        { line: 23, expression: "1 AndAlso 2", typeName: "integer" },
        { line: 24, expression: "1 Xor 2", typeName: "integer" },
        { line: 25, expression: "1 Or 2", typeName: "integer" },
        { line: 26, expression: "1 And 2", typeName: "integer" },
        { line: 27, expression: "1 < 2", typeName: "integer" },
        { line: 28, expression: "\"a\" & \"b\"", typeName: "zstring" },
        { line: 29, expression: "1 + 2", typeName: "integer" },
        { line: 29, expression: "1 + 2 + semantic_factor", typeName: "double" },
        { line: 30, expression: "1 Shl 2", typeName: "integer" },
        { line: 31, expression: "17 Mod 5", typeName: "integer" },
        { line: 32, expression: "17 \\ 5", typeName: "integer" },
        { line: 33, expression: "2 * 3", typeName: "integer" },
        { line: 34, expression: "2 ^ 3", typeName: "double" }
    ];
    const lines = source.split("\n");
    for (const { line, expression, typeName } of expectedExpressions) {
        const startColumn = lines[line].indexOf(expression);
        const result = sidecarOnly.expressionAt(
            sourceUri,
            { line, character: startColumn },
            { line, character: startColumn + expression.length }
        );
        assert.equal(result?.semanticSource, "compiler-sidecar", `${expression} should be available without bridge trace types`);
        assert.equal(result?.typeName.toLowerCase(), typeName);
        assert.equal(result?.provisional, false);
    }
});

test("sidecar expression ranges and native editor types agree across compiler fixtures", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const fixtures = path.resolve(__dirname, "integration/workspace");
    const names = [
        "compiler-types.bas",
        "compiler-expression-surface.bas",
        "compiler-expression-chains.bas",
        "compiler-expression-operations.bas"
    ];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-agreement-"));
    let compared = 0;

    try {
        for (const name of names) {
            const sourcePath = path.join(fixtures, name);
            const sidecarPath = path.join(directory, `${name}.tsv`);
            const objectPath = path.join(directory, `${name}.o`);
            execFileSync(compiler, ["-semantic-model", sidecarPath, "-c", sourcePath, "-o", objectPath], {
                cwd: fixtures,
                stdio: "ignore",
                timeout: 30000
            });

            const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
            const source = fs.readFileSync(sourcePath, "utf8");
            const analysis = await analyzeSavedModule({
                compilerPath: compiler,
                filePath: sourcePath,
                exportSemanticExpressions: true,
                requireSemanticModel: true
            });
            assert.ok(semantic.dependencies.every((file) => analysis.dependencies.includes(path.normalize(file))),
                `${name} compiler-opened files must be included in snapshot capture`);
            const sourceUri = { fsPath: sourcePath, toString: () => `file://${sourcePath}` };
            const editorModel = new CompilerSemanticModel(
                { toString: () => `freebasic-preprocessed:/${name}` },
                analysis,
                [{ uri: sourceUri, text: source }]
            );

            for (const expression of semantic.expressions) {
                if (!expression.physical || expression.filePath !== sourcePath) continue;
                const typed = editorModel.expressionAt(
                    sourceUri,
                    { line: expression.startLine - 1, character: expression.startColumn },
                    { line: expression.endLine - 1, character: expression.endColumn }
                );
                assert.ok(typed, `${name}:${expression.startLine}:${expression.startColumn} is missing from editor analysis`);
                assert.equal(typed.dtype, expression.dtype, `${name}:${expression.startLine}:${expression.startColumn} has a different compiler type`);
                compared++;
            }
        }
        assert.ok(compared >= 200, `Expected broad semantic sidecar overlap, compared ${compared} source expressions.`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("sidecar types source expressions omitted by aggregate-initializer traces", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const includeArguments = ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")];
    const cases = [
        {
            relativePath: "tests/structs/anon-nested.bas",
            sourceText: (text) => text.split(/\r?\n/).find((line) => line.includes("@type<test_pair>(")),
            selectFact: (fact, line) => fact.startColumn === line.indexOf("@type<test_pair>(") &&
                fact.typeName.toLowerCase().endsWith("test_pair ptr"),
            expectedText: "@type<test_pair>(",
            expectedType: "test_pair ptr"
        },
        {
            relativePath: "tests/structs/padding.bas",
            sourceText: (text) => text.split(/\r?\n/).find((line) => /\"1122\",\s*_/.test(line)),
            selectFact: (fact, line) => fact.startColumn === line.indexOf("\"1122\"") && fact.typeName.toLowerCase() === "zstring",
            expectedText: "\"1122\"",
            expectedType: "zstring"
        },
        {
            relativePath: "tests/structs/temp-var-dtors.bas",
            sourceText: (text) => text.split(/\r?\n/).find((line) => /\"1\",\s*\"2\",\s*\"3\"/.test(line)),
            selectFact: (fact, line) => fact.startColumn === line.indexOf("\"1\"") && fact.typeName.toLowerCase() === "zstring",
            expectedText: "\"1\"",
            expectedType: "zstring"
        }
    ];

    for (const item of cases) {
        const filePath = path.join(root, item.relativePath);
        const source = fs.readFileSync(filePath, "utf8");
        const line = item.sourceText(source);
        assert.ok(line, `${item.relativePath} should retain the classified source expression`);
        const lineIndex = source.split(/\r?\n/).indexOf(line);
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments: includeArguments,
            exportSemanticExpressions: true,
            requireSemanticModel: true
        });
        const fact = analysis.semanticExpressions.find((candidate) => candidate.physical &&
            candidate.filePath === filePath && candidate.startLine === lineIndex + 1 &&
            item.selectFact(candidate, line));
        assert.ok(fact, `${item.relativePath}:${lineIndex + 1} should have an exact physical sidecar expression`);

        const expressionText = line.slice(fact.startColumn, fact.endColumn);
        assert.ok(expressionText.startsWith(item.expectedText));
        assert.equal(fact.typeName.toLowerCase().endsWith(item.expectedType), true);

        const sourceDocuments = analysis.dependencies.map((dependency) => {
            const text = decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "");
            return {
                uri: { fsPath: dependency, toString: () => `file://${dependency}` },
                text
            };
        });
        const uri = sourceDocuments.find((document) => path.resolve(document.uri.fsPath) === path.resolve(filePath))?.uri;
        assert.ok(uri, `${item.relativePath} should be present in the complete dependency snapshot`);
        const model = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/${path.basename(filePath)}` },
            analysis,
            sourceDocuments
        );
        const start = { line: lineIndex, character: fact.startColumn };
        const end = { line: fact.endLine - 1, character: fact.endColumn };
        const typed = model.expressionAt(uri, start, end);
        assert.ok(typed, `${item.relativePath}:${lineIndex + 1}:${fact.startColumn} should remain queryable`);
        assert.equal(typed.dtype, fact.dtype);
        assert.equal(typed.typeName.toLowerCase().endsWith(item.expectedType), true);
        if (!model.expressionAtTraceOnly(uri, start, end)) {
            assert.equal(typed.semanticSource, "compiler-sidecar");
        }
    }
});

test("native semantic sidecar retains upstream temporary-destructor relationships", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/structs/temp-var-dtors.bas");
    const includeArguments = ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")];
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: includeArguments,
        exportSemanticBindings: true,
        requireSemanticModel: true
    });

    assert.equal(analysis.protocolVersion, 14,
        "the compiler's bounded full-model macro search should retain its native trace on compact binding retry");
    assert.equal(analysis.semanticModelFallbackReason, "compiler-full-model-bound");
    assert.equal(analysis.partial, false);
    assert.equal(analysis.completion.errorCount, 0);
    assert.equal(analysis.completion.reachedEnd, true);

    const temporaryDestructors = analysis.semanticImplicitCalls.filter((call) => call.kind === "temporary-destructor");
    assert.ok(temporaryDestructors.length >= 204,
        "the pinned upstream temporary-dtor suite exercises more than the focused extension fixture");

    const sourceDocuments = analysis.dependencies.map((dependency) => {
        const text = decodeCompilerSourceBuffer(fs.readFileSync(dependency), dependency).replace(/^\uFEFF/, "");
        return {
            uri: { scheme: "file", fsPath: dependency, toString: () => `file://${dependency}` },
            text
        };
    });
    const sourceDocument = sourceDocuments.find((document) => path.resolve(document.uri.fsPath) === path.resolve(filePath));
    assert.ok(sourceDocument, "the upstream test source must be present in the compiler dependency snapshot");
    const sourceLines = sourceDocument.text.split(/\r?\n/);

    for (const call of temporaryDestructors) {
        assert.equal(call.filePath, filePath);
        assert.equal(call.physical, true);
        assert.equal(call.owner, call.type, "a temporary destructor belongs to its exact UDT identity");
        assert.equal(call.targetSignature, "sig2");
        assert.ok(call.startLine >= 1 && call.endLine >= call.startLine && call.endLine <= sourceLines.length);

        const spanLines = sourceLines.slice(call.startLine - 1, call.endLine);
        const selectedText = spanLines.map((line, index) => {
            const characters = Array.from(line);
            const start = index === 0 ? call.startColumn : 0;
            const end = index === spanLines.length - 1 ? call.endColumn : characters.length;
            assert.ok(start >= 0 && start <= end && end <= characters.length,
                "each compiler range must remain within its physical source line");
            return characters.slice(start, end).join("");
        }).join("\n");
        assert.ok(selectedText.trim().length > 0, "each destructor must retain a nonempty physical creating expression");
    }

    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/tests/structs/temp-var-dtors.bas" },
        analysis,
        sourceDocuments
    );
    const relationships = semanticProjectImplicitCalls(analysis, model)
        .filter((relationship) => relationship.kind === "temporary-destructor");
    assert.equal(relationships.length, temporaryDestructors.length,
        "project semantic validation must retain every physically anchored upstream temporary destructor");
    assert.ok(relationships.every((relationship) => relationship.ownerId === relationship.targetTypeId),
        "compiler-only cleanup relationships must keep the exact declared UDT identity and never become token edits");
});

test("compiler semantic expressions can be explicitly exported outside directives", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const sourcePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const source = fs.readFileSync(sourcePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: compiler,
        filePath: sourcePath,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });

    assert.equal(analysis.partial, false);
    const written = "CLng(1) + CLng(2) + CDbl(3)";
    const lines = source.split("\n");
    const expressionLine = lines.findIndex((line) => line.includes(written));
    const expressionColumn = lines[expressionLine].indexOf(written);
    const fact = analysis.semanticExpressions.find((item) => item.physical && item.filePath === sourcePath &&
        item.startLine === expressionLine + 1 && item.startColumn === expressionColumn &&
        item.endColumn === expressionColumn + written.length);
    assert.ok(fact, "an explicit audit request must return a physical runtime expression fact");
    assert.equal(fact.endColumn, expressionColumn + written.length);
    assert.equal(fact.typeName.toLowerCase(), "double");
    assert.ok(fact.sourceContextId > 0, "semantic expression origins should retain their compiler source context");
    assert.ok(analysis.semanticSourceContexts.some((context) => context.id === fact.sourceContextId),
        "expression source contexts should be retained for contextual type explanations");

    const foldedPrefix = "CLng(1) + CLng(2)";
    const prefixFact = analysis.semanticExpressions.find((item) => item.physical && item.filePath === sourcePath &&
        item.startLine === expressionLine + 1 && item.startColumn === expressionColumn &&
        item.endColumn === expressionColumn + foldedPrefix.length);
    assert.ok(prefixFact, "the compiler must retain a completed same-precedence prefix before later AST folding");
    assert.equal(prefixFact.typeName.toLowerCase(), "integer");

    const sourceUri = { fsPath: sourcePath, toString: () => `file://${sourcePath}` };
    const sidecarOnly = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/semantic-sidecar-fallback.bas" },
        { ...analysis, expressions: [] },
        [{ uri: sourceUri, text: source }]
    );
    const start = { line: expressionLine, character: expressionColumn };
    const end = { line: expressionLine, character: expressionColumn + written.length };
    assert.equal(sidecarOnly.expressionAtTraceOnly(sourceUri, start, end), null, "the test must exercise a bridge-trace gap");
    const recovered = sidecarOnly.expressionAt(sourceUri, start, end);
    assert.equal(recovered?.semanticSource, "compiler-sidecar");
    assert.equal(sidecarOnly.expressionAtCompilerSidecarOnly(sourceUri, start, end)?.semanticSource, "compiler-sidecar",
        "the dedicated audit query must not depend on the editor trace graph");
    assert.equal(recovered?.typeName.toLowerCase(), "double");
    assert.equal(recovered?.provisional, false);
    assert.equal(recovered?.compilerExpressionId, 0, "sidecar IDs must not enter the native trace identity namespace");
    assert.equal(recovered?.subtype, 0, "sidecar symbol identities must not enter the native inventory namespace");

    const prefixRange = {
        start: { line: expressionLine, character: expressionColumn },
        end: { line: expressionLine, character: expressionColumn + foldedPrefix.length }
    };
    const recoveredPrefix = sidecarOnly.expressionAt(sourceUri, prefixRange.start, prefixRange.end);
    assert.equal(recoveredPrefix?.semanticSource, "compiler-sidecar");
    assert.equal(recoveredPrefix?.typeName.toLowerCase(), "integer");

    const moduleContext = analysis.semanticSourceContexts.find((context) => context.kind === "module");
    assert.ok(moduleContext, "sidecar expression facts retain their module source context");
    const repeatedContextId = Math.max(...analysis.semanticSourceContexts.map((context) => context.id)) + 1;
    const repeatedContext = {
        ...moduleContext,
        id: repeatedContextId,
        parent: moduleContext.id,
        kind: "include",
        depth: moduleContext.depth + 1,
        requested: "shared-expression.bi",
        filePath: sourcePath
    };
    const ambiguous = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/semantic-sidecar-ambiguous.bas" },
        {
            ...analysis,
            expressions: [],
            semanticSourceContexts: [...analysis.semanticSourceContexts, repeatedContext],
            semanticExpressions: [...analysis.semanticExpressions, {
                ...fact,
                id: fact.id + 1,
                dtype: fact.dtype + 1,
                typeName: "string",
                sourceContextId: repeatedContextId
            }]
        },
        [{ uri: sourceUri, text: source }]
    );
    assert.equal(ambiguous.expressionAt(sourceUri, start, end), null, "conflicting compiler facts must not produce an arbitrary hover type");
    assert.equal(ambiguous.expressionAtCompilerSidecarOnly(sourceUri, start, end), null,
        "sidecar-only coverage must preserve the same fail-closed ambiguity policy");
    assert.equal(ambiguous.isCompilerSidecarRangeAmbiguous(sourceUri, start, end), true);
    const alternatives = ambiguous.compilerSidecarExpressionAlternativesAt(sourceUri, start, end);
    assert.deepEqual(new Set(alternatives.map((alternative) => alternative.typeName.toLowerCase())),
        new Set([fact.typeName.toLowerCase(), "string"]));
    assert.ok(alternatives.some((alternative) => alternative.contexts.some((context) =>
        context.includePath.some((sourceContext) => sourceContext.requested === "shared-expression.bi"))));
    const hover = queryCompilerModel(ambiguous, "hover", {
        uri: { scheme: "file", fsPath: sourcePath }, position: start, end
    }, () => {});
    assert.equal(hover.expression, null);
    assert.equal(hover.expressionAlternatives.length, 2,
        "the worker-facing selection query should expose the same context-specific alternatives");
    const pointHover = queryCompilerModel(ambiguous, "hover", {
        uri: { scheme: "file", fsPath: sourcePath }, position: start
    }, () => {});
    assert.equal(pointHover.expressionAlternatives.length, 2,
        "hover point queries should find the containing context-ambiguous expression");

    const withoutSidecar = await analyzeSavedModule({ compilerPath: compiler, filePath: sourcePath });
    assert.deepEqual(withoutSidecar.semanticExpressions, [], "ordinary expression analysis must keep sidecar work opt-in");
});

test("partial semantic sidecar supplements only expressions outside retracted source ranges", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-recovery-"));
    const sourcePath = path.join(directory, "recovery.bas");
    const source = [
        "dim as integer value = 1",
        "dim as double factor = 2",
        "Print (value * 2) +",
        "Print factor * 2",
        ""
    ].join("\n");

    try {
        fs.writeFileSync(sourcePath, source);
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            overlays: new Map([[sourcePath, source]]),
            allowErrors: true,
            exportSemanticExpressions: true
        });
        assert.equal(analysis.partial, true);
        assert.equal(analysis.semanticModelRecovery, true,
            "the failed expression-only compile must end with its explicit recovery footer");
        assert.ok(analysis.semanticExpressions.some((fact) => fact.recovery && fact.physical && fact.startLine === 4),
            "the recovery sidecar should retain compiler expressions from later parsed source");
        assert.ok(analysis.semanticExpressions.some((fact) => fact.recovery && fact.physical && fact.startLine === 3),
            "the failed parser can emit facts for its invalid line, so physical recovery-token filtering must be effective");

        const sourceUri = { fsPath: sourcePath, toString: () => `file://${sourcePath}` };
        const sidecarOnly = new CompilerSemanticModel(
            { toString: () => "freebasic-preprocessed:/semantic-sidecar-recovery.bas" },
            { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
            [{ uri: sourceUri, text: source }]
        );
        const recoveryCoverage = measureRecoverySemanticSidecarCoverage(analysis, sidecarOnly, [{ uri: sourceUri, text: source }]);
        assert.ok(recoveryCoverage.recoverySidecarOnlyCompared > 0,
            "safe recovery facts must be queried independently of editor trace expressions");
        assert.equal(recoveryCoverage.recoverySidecarOnlyMissing, 0);
        assert.equal(recoveryCoverage.recoverySidecarOnlyTypeMismatches, 0);
        assert.equal(recoveryCoverage.recoverySidecarOnlyUnprovisional, 0);
        const goodLine = 3;
        const goodExpression = "factor * 2";
        const goodStart = { line: goodLine, character: source.split("\n")[goodLine].indexOf(goodExpression) };
        const goodEnd = { line: goodLine, character: goodStart.character + goodExpression.length };
        const recovered = sidecarOnly.expressionAt(sourceUri, goodStart, goodEnd);
        assert.equal(recovered?.semanticSource, "compiler-sidecar-recovery");
        assert.equal(recovered?.typeName.toLowerCase(), "double");
        assert.equal(recovered?.provisional, true);

        const cursor = { line: goodLine, character: goodStart.character + 2 };
        const conflictingFacts = analysis.semanticExpressions.filter((fact) => fact.physical &&
            fact.startLine <= goodLine + 1 && fact.endLine >= goodLine + 1 &&
            (fact.startLine !== goodLine + 1 || fact.startColumn <= cursor.character) &&
            (fact.endLine !== goodLine + 1 || fact.endColumn > cursor.character));
        assert.ok(conflictingFacts.length, "the cursor range should have compiler semantic facts");
        const traceWins = new CompilerSemanticModel(
            { toString: () => "freebasic-preprocessed:/semantic-sidecar-recovery-priority.bas" },
            {
                ...analysis,
                semanticExpressions: analysis.semanticExpressions.map((fact) => conflictingFacts.includes(fact)
                    ? { ...fact, dtype: 8, typeName: "integer" }
                    : fact)
            },
            [{ uri: sourceUri, text: source }]
        );
        const nativeResult = traceWins.expressionAtTraceOnly(sourceUri, cursor);
        const selectedResult = traceWins.expressionAt(sourceUri, cursor);
        assert.ok(nativeResult, "the cursor should have a native trace result");
        assert.equal(selectedResult?.dtype, nativeResult.dtype,
            "recovery sidecar facts must never override a native trace answer, even when their types disagree");
        assert.equal(selectedResult?.semanticSource, undefined);

        const badLine = 2;
        const badExpression = "(value * 2)";
        const badStart = { line: badLine, character: source.split("\n")[badLine].indexOf(badExpression) };
        const badEnd = { line: badLine, character: badStart.character + badExpression.length };
        assert.equal(sidecarOnly.expressionAt(sourceUri, badStart, badEnd), null,
            "sidecar output for tokens retracted by recovery must not become an editor type");
        const withoutOriginMap = new CompilerSemanticModel(
            { toString: () => "freebasic-preprocessed:/semantic-sidecar-recovery-without-origins.bas" },
            { ...analysis, expressions: [], expressionGraph: { nodes: [] }, tokenOrigins: [] },
            [{ uri: sourceUri, text: source }]
        );
        assert.equal(withoutOriginMap.expressionAt(sourceUri, badStart, badEnd), null,
            "error-line facts must stay withheld even when token-origin recovery data is unavailable");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("semantic sidecar recovery quarantines malformed expression parser results", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-parser-recovery-"));
    const sourcePath = path.join(directory, "recovery.bas");
    fs.writeFileSync(sourcePath, "Print 1\n", "utf8");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const cases = [
        { label: "binary precedence", invalid: "Print (value * 2) +", probe: "(value * 2) +" },
        { label: "type layout", invalid: "Print SizeOf(", probe: "SizeOf(" },
        { label: "PEEK", invalid: "Print Peek(", probe: "Peek(" },
        { label: "allocation", invalid: "Print New (", probe: "New (" },
        { label: "conditional quirk", invalid: "Print IIf(", probe: "IIf(" },
        { label: "THREADCALL", invalid: "Print ThreadCall ThreadWorker(", probe: "ThreadCall ThreadWorker(", declaration: "Sub ThreadWorker()\nEnd Sub\n" },
        { label: "type conversion", invalid: "Print Cast(", probe: "Cast(" },
        { label: "intrinsic macro", invalid: "Print RGB(", probe: "RGB(" },
        { label: "procedure pointer", invalid: "Print ProcPtr(", probe: "ProcPtr(" },
        { label: "procedure arguments", invalid: "Print ReadValue(", probe: "ReadValue(", declaration: "Function ReadValue(ByVal amount As Double) As Double\n Return amount\nEnd Function\n" }
    ];

    for (const { label, invalid, probe, declaration = "" } of cases) {
        const source = `${declaration}Dim value As Double\nPrint value * 2\n${invalid}\nPrint value * 3\n`;
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            overlays: new Map([[sourcePath, source]]),
            allowErrors: true,
            exportSemanticExpressions: true,
            requireSemanticModel: true
        });
        assert.equal(analysis.partial, true, label);
        assert.equal(analysis.completion.reachedEnd, true, label);
        assert.equal(analysis.semanticModelRecovery, true, label);
        assert.ok(analysis.semanticExpressions.every((fact) => fact.recovery), label);

        const sourceUri = { fsPath: sourcePath, toString: () => `file://${sourcePath}` };
        const sidecarOnly = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/semantic-parser-recovery-${label.replaceAll(" ", "-")}.bas` },
            { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
            [{ uri: sourceUri, text: source }]
        );
        const lines = source.split("\n");
        const expressionAtLine = (lineText, spelling) => {
            const line = lines.indexOf(lineText);
            const character = lineText.indexOf(spelling);
            assert.ok(line >= 0 && character >= 0, `${label}: fixture text is present`);
            return sidecarOnly.expressionAt(sourceUri,
                { line, character },
                { line, character: character + spelling.length });
        };

        for (const spelling of ["value * 2", "value * 3"]) {
            const result = expressionAtLine(`Print ${spelling}`, spelling);
            assert.equal(result?.typeName.toLowerCase(), "double", `${label}: ${spelling}`);
            assert.equal(result?.semanticSource, "compiler-sidecar-recovery", label);
            assert.equal(result?.provisional, true, label);
        }
        const errorLine = lines.indexOf(invalid);
        const errorColumn = invalid.indexOf(probe);
        assert.equal(sidecarOnly.expressionAt(sourceUri, { line: errorLine, character: errorColumn }), null,
            `${label}: an expression from the damaged line must not become an editor type`);
    }
});

test("multiple parser failures quarantine only damaged lines and preserve later expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const source = [
        "Dim value As Double",
        "Print value * 2",
        "Print Cast(",
        "Print value * 3",
        "Print New (",
        "Print value * 4",
        ""
    ].join("\n");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });

    assert.deepEqual(analysis.completion, { errorCount: 2, reachedEnd: true });
    assert.equal(analysis.semanticModelRecovery, true);
    assert.ok(analysis.semanticExpressions.every((fact) => fact.recovery));

    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const traceModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/multi-parser-recovery-trace.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const sidecarModel = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/multi-parser-recovery-sidecar.bas" },
        { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
        [{ uri: sourceUri, text: source }]
    );
    const lines = source.split("\n");

    for (const [line, spelling] of [[1, "value * 2"], [3, "value * 3"], [5, "value * 4"]]) {
        const character = lines[line].indexOf(spelling);
        const start = { line, character };
        const end = { line, character: character + spelling.length };
        const native = traceModel.expressionAt(sourceUri, start, end);
        const recovered = sidecarModel.expressionAt(sourceUri, start, end);

        assert.equal(native?.typeName.toLowerCase(), "double", spelling);
        assert.equal(native?.provisional, false, spelling);
        assert.equal(recovered?.semanticSource, "compiler-sidecar-recovery", spelling);
        assert.equal(recovered?.typeName.toLowerCase(), "double", spelling);
        assert.equal(recovered?.provisional, true, spelling);
    }

    for (const line of [2, 4]) {
        assert.equal(traceModel.expressionAt(sourceUri, { line, character: 6 }), null, `trace error line ${line + 1}`);
        assert.equal(sidecarModel.expressionAt(sourceUri, { line, character: 6 }), null, `sidecar error line ${line + 1}`);
    }
});

test("compiler bridge types an inherited UDT New result as a pointer", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-types.bas");
    const source = [
        "Type BaseItem Extends Object",
        "    Declare Virtual Sub Visit()",
        "End Type",
        "Sub BaseItem.Visit()",
        "End Sub",
        "Type DerivedItem Extends BaseItem",
        "End Type",
        "Dim basePointer As BaseItem Ptr = New DerivedItem"
    ].join("\n") + "\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, source]]),
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, false);

    const spelling = "New DerivedItem";
    const line = source.split("\n").findIndex((value) => value.includes(spelling));
    const column = source.split("\n")[line].indexOf(spelling);
    const fact = analysis.semanticExpressions.find((expression) => expression.physical &&
        expression.filePath === filePath && expression.startLine === line + 1 && expression.startColumn === column);
    assert.ok(fact, "the compiler semantic model must retain the physical New expression");
    assert.match(fact.typeName.toLowerCase(), /\bptr\b/, "New must have the inherited UDT pointer result type");

    const sourceUri = { fsPath: filePath, toString: () => `file://${filePath}` };
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/semantic-sidecar-new-derived.bas" },
        analysis,
        [{ uri: sourceUri, text: source }]
    );
    const start = { line, character: column };
    const end = { line, character: column + spelling.length };
    const traced = model.expressionAtTraceOnly(sourceUri, start, end);
    assert.ok(traced, "the compiler bridge must retain its expression annotation");
    assert.equal(traced.dtype, fact.dtype);
    assert.equal(traced.typeName.toLowerCase(), fact.typeName.toLowerCase());

    const typed = model.expressionAt(sourceUri, start, end);
    assert.equal(typed?.dtype, fact.dtype);
    assert.equal(typed?.typeName.toLowerCase(), fact.typeName.toLowerCase());
});

test("compiler sidecar supplements typed initializer expressions omitted by the bridge trace", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const root = resolveFreeBasicRoot();
    const filePath = path.join(root, "tests/gfx/palette.bas");
    const source = fs.readFileSync(filePath, "utf8");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
        exportSemanticExpressions: true,
        requireSemanticModel: true,
        allowErrors: true,
        timeoutMs: 30000
    });
    assert.equal(analysis.partial, false, "the fixture needs a complete semantic snapshot");
    const sources = analysis.dependencies.map((dependency) => ({
        uri: { fsPath: dependency, toString: () => `file://${dependency}` },
        text: fs.readFileSync(dependency, "utf8").replace(/^\uFEFF/, "")
    }));
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/semantic-sidecar-initializer.bas" },
        analysis,
        sources
    );
    const sourceUri = sources.find((item) => item.uri.fsPath === filePath).uri;
    const candidate = analysis.semanticExpressions.find((fact) => {
        if (!fact.physical || fact.filePath !== filePath) return false;
        const line = source.split(/\r\n|\n|\r/)[fact.startLine - 1] || "";
        if (!line.trimStart().startsWith("&h")) return false;
        return model.expressionAtTraceOnly(sourceUri,
            { line: fact.startLine - 1, character: fact.startColumn },
            { line: fact.endLine - 1, character: fact.endColumn }) === null;
    });
    assert.ok(candidate, "the upstream array initializer must expose a compiler fact missing from the bridge trace");
    const start = { line: candidate.startLine - 1, character: candidate.startColumn };
    const end = { line: candidate.endLine - 1, character: candidate.endColumn };
    const typed = model.expressionAt(sourceUri, start, end);
    assert.equal(typed?.semanticSource, "compiler-sidecar");
    assert.equal(typed?.dtype, candidate.dtype);
    assert.equal(typed?.typeName.toLowerCase(), candidate.typeName.toLowerCase());
});

test("binding type supplements reject source revisions changed between compiler passes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const { executeBoundedProcess } = require("../lib/compiler-diagnostics");
    const root = resolveFreeBasicRoot();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-type-supplement-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "palette.bas");
    fs.copyFileSync(path.join(root, "tests/gfx/palette.bas"), filePath);
    let changed = false;
    await assert.rejects(analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        semanticSourceFiles: [filePath],
        requireSemanticModel: true,
        allowErrors: true
    }, undefined, async (request) => {
        if (request.arguments.some((argument) => argument.endsWith("module.types-fallback.fbcsem"))) {
            fs.appendFileSync(filePath, "\nPrint 1\n");
            changed = true;
        }
        return executeBoundedProcess(request);
    }), /expression supplement does not match the binding snapshot/);
    assert.equal(changed, true, "the fixture must reach the supplementary expression pass");
});

test("compiler-typed preprocessor expressions support unsaved header hovers", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-directives-"));
    const sourcePath = path.join(directory, "directives.bas");
    const headerPath = path.join(directory, "directives.bi");
    const source = '#include once "directives.bi"\nPrint 1\n';
    const header = [
        "#if 1 + 2 = 3",
        "#assert 1 + 2 = 3",
        "#endif",
        "type SemanticSidecarProbe",
        "    precise As Double",
        "end type",
        "sub semanticSidecarCheck()",
        "    dim checkedValue As SemanticSidecarProbe",
        "    #assert typeof(checkedValue.precise) = typeof(Double)",
        "end sub",
        ""
    ].join("\n");
    fs.writeFileSync(sourcePath, source, "utf8");
    fs.writeFileSync(headerPath, "#if 0\n#endif\n", "utf8");

    try {
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            overlays: new Map([[sourcePath, source], [headerPath, header]])
        });
        assert.equal(analysis.partial, false);
        assert.ok(analysis.semanticExpressions.some((fact) => fact.filePath === headerPath && fact.typeName));
        const sourceUri = { fsPath: sourcePath, toString: () => `file://${sourcePath}` };
        const headerUri = { fsPath: headerPath, toString: () => `file://${headerPath}` };
        const model = new CompilerSemanticModel(
            { toString: () => "freebasic-preprocessed:/directives.bas" },
            analysis,
            analysis.dependencies.map((filePath) => ({
                uri: filePath === sourcePath ? sourceUri : headerUri,
                text: filePath === sourcePath ? source : header
            }))
        );

        for (const line of ["#if 1 + 2 = 3", "#assert 1 + 2 = 3"]) {
            const lineIndex = header.split("\n").indexOf(line);
            const typed = model.expressionAt(headerUri, { line: lineIndex, character: line.indexOf("1") });
            assert.ok(typed, `${line} should have a compiler-selected type`);
            assert.equal(typed.typeName.toLowerCase(), "integer");
            assert.equal(typed.provisional, false);
            assert.equal(typed.physical, true);
        }

        const lines = header.split("\n");
        const nestedDirective = lines.findIndex((line) => line.includes("typeof(checkedValue.precise)"));
        const nestedText = "checkedValue.precise";
        const nestedColumn = lines[nestedDirective].indexOf(nestedText);
        const nestedType = model.expressionAt(
            headerUri,
            { line: nestedDirective, character: nestedColumn },
            { line: nestedDirective, character: nestedColumn + nestedText.length }
        );
        assert.equal(nestedType?.typeName.toLowerCase(), "double");
        const nestedTypeAtCursor = model.expressionAt(headerUri, {
            line: nestedDirective,
            character: lines[nestedDirective].indexOf("typeof")
        });
        assert.equal(nestedTypeAtCursor?.typeName.toLowerCase(), "zstring",
            "the narrow compiler range for TYPEOF should report its own result type");
        const comparisonType = model.expressionAt(headerUri, {
            line: nestedDirective,
            character: lines[nestedDirective].indexOf("=")
        });
        assert.equal(comparisonType?.typeName.toLowerCase(), "integer");

        const invalidRangeModel = new CompilerSemanticModel(
            { toString: () => "freebasic-preprocessed:/directives-invalid-range.bas" },
            { ...analysis, semanticExpressions: [{ ...analysis.semanticExpressions[0], startLine: 10000, endLine: 10000 }] },
            analysis.dependencies.map((filePath) => ({
                uri: filePath === sourcePath ? sourceUri : headerUri,
                text: filePath === sourcePath ? source : header
            }))
        );
        assert.equal(invalidRangeModel.expressionAt(headerUri, { line: 0, character: 4 }), null);

        const partialSource = `${source}Print (\n`;
        const partial = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            overlays: new Map([[sourcePath, partialSource], [headerPath, header]]),
            allowErrors: true
        });
        assert.equal(partial.partial, true);
        assert.equal(partial.semanticModelRecovery, true);
        assert.ok(partial.semanticExpressions.some((fact) => fact.recovery && fact.filePath === headerPath),
            "unaffected header directives should retain compiler-typed recovery facts");
        const partialSidecarOnly = new CompilerSemanticModel(
            { toString: () => "freebasic-preprocessed:/directives-partial.bas" },
            { ...partial, expressions: [], expressionGraph: { nodes: [] } },
            analysis.dependencies.map((filePath) => ({
                uri: filePath === sourcePath ? sourceUri : headerUri,
                text: filePath === sourcePath ? partialSource : header
            }))
        );
        const partialDirective = partialSidecarOnly.expressionAt(headerUri, { line: 0, character: 4 });
        assert.equal(partialDirective?.semanticSource, "compiler-sidecar-recovery");
        assert.equal(partialDirective?.typeName.toLowerCase(), "integer");
        assert.equal(partialDirective?.provisional, true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("numeric literal type suffixes keep native expression types at their written positions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-numeric-suffix-"));
    const sourcePath = path.join(directory, "numeric-suffix.bas");
    const sidecarPath = path.join(directory, "semantic-model.tsv");
    const objectPath = path.join(directory, "numeric-suffix.o");
    const source = [
        "Print -1.1f", "Print -0.9f", "Print 1.1#", "Print 1.1!",
        "Print 42%", "Print 42&", "Print 42u", "Print 42l", "Print 42ul", "Print 42ll", "Print 42ull", "Print 00042ull", ""
    ].join("\n");

    try {
        fs.writeFileSync(sourcePath, source);
        execFileSync(compiler, ["-semantic-model", sidecarPath, "-c", sourcePath, "-o", objectPath], {
            cwd: directory,
            stdio: "ignore",
            timeout: 30000
        });

        const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
        const analysis = await analyzeSavedModule({
            compilerPath: compiler,
            filePath: sourcePath,
            overlays: new Map([[sourcePath, source]]),
            exportSemanticExpressions: true,
            requireSemanticModel: true
        });
        const sourceUri = { fsPath: sourcePath, toString: () => `file://${sourcePath}` };
        const editorModel = new CompilerSemanticModel(
            { toString: () => "freebasic-preprocessed:/numeric-suffix.bas" },
            analysis,
            [{ uri: sourceUri, text: source }]
        );

        for (const [lineIndex, line] of source.split("\n").entries()) {
            if (!line) continue;
            const startColumn = line.indexOf("Print ") + "Print ".length;
            const endColumn = line.length;
            const fact = semantic.expressions.find((expression) => expression.physical &&
                expression.filePath === sourcePath && expression.startLine === lineIndex + 1 &&
                expression.startColumn === startColumn && expression.endColumn === endColumn);
            assert.ok(fact, `native sidecar should type the written operand ${line}`);

            const range = {
                line: lineIndex,
                start: { line: lineIndex, character: startColumn },
                end: { line: lineIndex, character: endColumn }
            };
            const selected = editorModel.expressionAt(sourceUri, range.start, range.end);
            assert.ok(selected, `editor analysis should map the complete source range ${line}`);
            assert.equal(selected.dtype, fact.dtype, `native type mismatch for ${line}`);
            const sidecarSelected = editorModel.expressionAtCompilerSidecarOnly(sourceUri, range.start, range.end);
            assert.equal(sidecarSelected?.semanticSource, "compiler-sidecar", `${line} should use the latest compiler expression fact`);
            assert.equal(sidecarSelected?.dtype, fact.dtype, `sidecar type mismatch for ${line}`);

            const suffix = endColumn - 1;
            const hovered = editorModel.expressionAt(sourceUri, { line: lineIndex, character: suffix });
            assert.ok(hovered, `editor analysis should map the suffix character in ${line}`);
            assert.equal(hovered.dtype, fact.dtype, `suffix hover type mismatch for ${line}`);
            const sidecarHovered = editorModel.expressionAtCompilerSidecarOnly(sourceUri,
                { line: lineIndex, character: suffix });
            assert.equal(sidecarHovered?.semanticSource, "compiler-sidecar", `${line} suffix hover should use the compiler expression fact`);
            assert.equal(sidecarHovered?.dtype, fact.dtype, `sidecar suffix type mismatch for ${line}`);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("native sidecar omits empty parser ranges from macro defaults", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const sourcePath = path.join(root, "tests/expressions/address-comparison.bas");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-empty-range-"));
    const sidecarPath = path.join(directory, "semantic-model.tsv");
    const objectPath = path.join(directory, "address-comparison.o");

    try {
        execFileSync(compiler, [
            "-i", path.join(root, "inc"),
            "-i", path.join(root, "tests/fbcunit/inc"),
            "-semantic-model", sidecarPath,
            "-c", sourcePath,
            "-o", objectPath
        ], { cwd: path.dirname(sourcePath), stdio: "ignore", timeout: 30000 });

        const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
        assert.ok(semantic.expressions.length > 0);
        assert.ok(semantic.expressions.some((expression) => !expression.physical), "Macro-derived type facts should remain available without an editable range.");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/* end of tests/compiler-semantic-sidecar.test.js */
