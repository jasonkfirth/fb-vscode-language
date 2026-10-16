/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/compiler-semantic-transport.test.js
    Purpose: Verify FBCSEMB1 decoding against its wire contract and current FBC.
    Responsibilities: exercise exact values, input bounds, modes, and completion.
    Does not contain: production serialization or language parsing.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { BINARY_MAGIC, readCompilerSemanticRows } = require("../lib/compiler-semantic-transport");
const { decodeCompilerSemanticModel, decodeCompilerSemanticExpressions } = require("../lib/compiler-semantic-sidecar");
const { analyzeSavedModule } = require("../lib/compiler-analysis");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");
const { CompilerUri } = require("../lib/compiler-model-store");
const { queryCompilerModel } = require("../lib/compiler-model-queries");

const LIMITS = { maxBytes: 64 * 1024 * 1024, maxRecords: 6_100_002 };
const END = ["END", "27", "1", "0", "0", "0", "0", "0", "0", "0", "1", "1", "0"];

/* Independent fixture writer, deliberately small. Raw Buffer fields allow
   malformed tokens that a real compiler must never emit. */
function varint(number) {
    number = BigInt(number);
    const bytes = [];
    do {
        let part = Number(number & 127n);
        number >>= 7n;
        if (number) part |= 128;
        bytes.push(part);
    } while (number);
    return Buffer.from(bytes);
}

function frame(identity, fields) {
    const payload = Buffer.concat([Buffer.from([identity, fields.length]), ...fields]);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(payload.length);
    return Buffer.concat([length, payload]);
}

function binaryFixture(rows = [["M", "/main.bas"], ["D", "/main.bas"], END], options = {}) {
    const mode = options.mode || "full";
    const definitions = new Map();
    for (const row of rows) if (!definitions.has(row[0])) definitions.set(row[0], { id: definitions.size + 1, arity: row.length });
    const capabilities = ["core", "source-revisions", "structured-values"];
    if (mode === "full") capabilities.push("native-types", "control-flow");
    const header = [
        "FBCSEMB1", "schema\t27", "producer\t1.20.5-1", `mode\t${mode}`,
        "layout\tu32le frames", "values\tcanonical LEB128 tokens", "dictionary\tencounter order",
        ...capabilities.map((name) => `cap\t${name}\t1\t1`),
        ...[...definitions].map(([tag, record]) => `record\t${record.id}\t${tag}\t${record.arity}\tfixture fields`),
        ...(options.header || []), "DATA", ""
    ].join("\n");
    const dictionary = new Map();
    function field(value) {
        if (Buffer.isBuffer(value)) return value;
        if (!value) return Buffer.from([0]);
        if (/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(value) && BigInt(value) >= -((1n << 61n) - 1n) && BigInt(value) < (1n << 61n)) {
            const number = BigInt(value);
            return varint(((number < 0n ? -number : number) << 3n) | (number < 0n ? 2n : 1n));
        }
        if (dictionary.has(value)) return varint((BigInt(dictionary.get(value)) << 3n) | 3n);
        dictionary.set(value, dictionary.size + 1);
        const bytes = Buffer.from(value, "latin1");
        return Buffer.concat([varint((BigInt(bytes.length) << 3n) | 4n), bytes]);
    }
    return Buffer.concat([Buffer.from(header, "ascii"), ...rows.map((row) => frame(definitions.get(row[0]).id, row.slice(1).map(field)))]);
}

function logicalRows(buffer, options = {}) {
    return [...readCompilerSemanticRows(buffer, { ...LIMITS, ...options })];
}

function replaceHeader(buffer, before, after) {
    const ending = buffer.indexOf("DATA\n") + 5;
    return Buffer.concat([Buffer.from(buffer.toString("latin1", 0, ending).replace(before, after), "latin1"), buffer.subarray(ending)]);
}

/* ------------------------------------------------------------------------- */
/* Portable values and bounded framing                                       */
/* ------------------------------------------------------------------------- */

test("binary full and bounded readers retain the same schema-27 facts as diagnostic text", () => {
    const binary = binaryFixture();
    const text = logicalRows(binary).join("\n");
    assert.deepEqual(decodeCompilerSemanticModel(binary), decodeCompilerSemanticModel(text));
    assert.deepEqual(decodeCompilerSemanticExpressions(binary, () => true, { includeBindings: true }),
        decodeCompilerSemanticExpressions(text, () => true, { includeBindings: true }));
    assert.deepEqual(decodeCompilerSemanticModel(Buffer.from(text)), decodeCompilerSemanticModel(text));
    const legacy = "FBCSEM\t2\t1.20.4\nM\t/café.bas\nEND\t2\t1\t0\t0\t0\t0\n";
    assert.deepEqual(decodeCompilerSemanticModel(Buffer.from(legacy)), decodeCompilerSemanticModel(legacy));
});

test("binary values preserve exact integers, escaped bytes, dictionary references, prefixes and tuples", () => {
    const literal = (value) => Buffer.concat([varint((BigInt(value.length) << 3n) | 5n), Buffer.from(value, "ascii")]);
    const prefix = Buffer.concat([Buffer.from([6]), literal("receipt:"), varint(123456789)]);
    const tuple = Buffer.concat([varint((3n << 3n) | 7n), prefix, Buffer.from([0]), literal("%2509%FF")]);
    const values = ["", "0", "127", "16384", String((1n << 46n) - 1n), String(1n << 46n),
        String((1n << 53n) + 1n), String((1n << 61n) - 1n), String(-((1n << 61n) - 1n)),
        "18446744073709551615", "-0", "0007", "%FF%09%25", "%FF%09%25", prefix, tuple];
    const rows = logicalRows(binaryFixture([["K", ...values]]));
    assert.equal(rows[1], ["K", ...values.slice(0, -2), "receipt:123456789", "receipt:123456789%09%09%2509%FF"].join("\t"));
});

test("binary readers enforce required capabilities and the requested export mode", () => {
    const full = binaryFixture();
    const reduced = binaryFixture(undefined, { mode: "expressions" });
    assert.throws(() => decodeCompilerSemanticModel(reduced), /export mode/);
    assert.throws(() => decodeCompilerSemanticExpressions(reduced, () => true, { includeBindings: true }), /export mode/);
    assert.doesNotThrow(() => decodeCompilerSemanticExpressions(reduced));
    assert.doesNotThrow(() => decodeCompilerSemanticExpressions(binaryFixture(undefined, { mode: "bindings" }), () => true, { includeBindings: true }));
    assert.throws(() => logicalRows(replaceHeader(full, "cap\tcore\t1\t1\n", "")), /Missing required/);
    assert.throws(() => logicalRows(replaceHeader(full, "cap\tcontrol-flow\t1\t1\n", "")), /Missing required/);
    assert.throws(() => logicalRows(binaryFixture(undefined, { header: ["cap\tfuture\t1\t1"] })), /Unsupported required/);
    assert.throws(() => logicalRows(replaceHeader(full, "cap\tcore\t1\t1", "cap\tcore\t2\t1")), /Unsupported required/);
    assert.doesNotThrow(() => logicalRows(binaryFixture(undefined, { header: ["cap\tfuture\t2\t0"] })));
    assert.throws(() => logicalRows(replaceHeader(full, "cap\tcore\t1\t1", "cap\tcore\t2\t0")), /Missing required/);
});

test("binary headers reject duplicates, unsupported schema and malformed element contracts", () => {
    const binary = binaryFixture();
    for (const header of ["schema\t27", "producer\tother", "cap\tcore\t1\t1", "record\t1\tM\t2\tduplicate"]) {
        assert.throws(() => logicalRows(binaryFixture(undefined, { header: [header] })), /Duplicate/);
    }
    for (const [before, after] of [
        ["schema\t27", "schema\t28"], ["mode\tfull", "mode\tunknown"], ["producer\t1.20.5-1", "producer\t"],
        ["layout\tu32le frames\n", ""], ["cap\tcore\t1\t1", "cap\tcore\t01\t1"],
        ["cap\tcore\t1\t1", "cap\tcore\t2305843009213693952\t1"],
        ["record\t1\tM\t2", "record\t256\tM\t2"], ["record\t1\tM\t2", "record\t1\tM\t1"],
        ["layout\tu32le frames", "unknown\tmetadata"], ["layout\tu32le frames", "layout\tbad\x80"]
    ]) assert.throws(() => logicalRows(replaceHeader(binary, before, after)), /binary semantic|binary header/i);
    assert.throws(() => decodeCompilerSemanticModel(replaceHeader(binary, "record\t1\tM\t2", "record\t1\tM\t3")), /record contract/);
    assert.throws(() => logicalRows(Buffer.concat([BINARY_MAGIC, Buffer.alloc(64 * 1024, 65)])), /header/);
});

test("binary frames reject truncation, field-count drift and trailing bytes", () => {
    const binary = binaryFixture();
    const start = binary.indexOf("DATA\n") + 5;
    for (const size of [1, 4, 8]) assert.throws(() => decodeCompilerSemanticModel(binary.subarray(0, -size)), /truncated|frame|integer/i);
    const badCount = Buffer.from(binary);
    badCount[start + 5] = 2;
    assert.throws(() => logicalRows(badCount), /field count/);
    const badId = Buffer.from(binary);
    badId[start + 4] = 255;
    assert.throws(() => logicalRows(badId), /Unknown binary/);
    for (const size of [0, 1, 64 * 1024 * 1024 + 1, 0xffffffff]) {
        const badLength = Buffer.from(binary);
        badLength.writeUInt32LE(size, start);
        assert.throws(() => logicalRows(badLength), /frame/);
    }
    assert.throws(() => logicalRows(Buffer.concat([binary, Buffer.from([0])])), /terminal marker/);
    assert.throws(() => logicalRows(Buffer.concat([binary, binary.subarray(start)])), /terminal marker/);
    assert.throws(() => logicalRows(binaryFixture([["M", Buffer.from([0, 0])]])), /Trailing bytes/);
});

test("binary value decoder rejects invalid varints, strings, prefix tokens and nested tuples", () => {
    const malformed = [
        Buffer.from([128]), Buffer.from([129, 0]), Buffer.from([8]), Buffer.from([2]),
        Buffer.from([11]), Buffer.from([4]), Buffer.from([21, 65]), Buffer.from([12, 128]),
        Buffer.from([14, 0, 0]), Buffer.from([6, 6, 0, 0]), Buffer.from([6, 0, 0]),
        Buffer.from([7]), Buffer.from([15]), Buffer.concat([varint((257n << 3n) | 7n), Buffer.from([0, 0])]),
        Buffer.from([23, 23, 0, 0, 0]), Buffer.concat([Buffer.alloc(9, 255), Buffer.from([2])])
    ];
    for (const bytes of malformed) {
        assert.throws(() => logicalRows(binaryFixture([["M", bytes]])), /binary semantic|binary negative/i, bytes.toString("hex"));
    }
    const tuple = Buffer.from([23, 0, 0]);
    const binary = binaryFixture([["M", tuple]]);
    assert.throws(() => logicalRows(replaceHeader(binary, "cap\tstructured-values\t1\t1\n", "")), /structured value/);
});

test("binary reader bounds expanded values, model bytes, records and input bytes", () => {
    const binary = binaryFixture([["M", "a".repeat(30)], ["D", "a".repeat(30)]]);
    assert.throws(() => logicalRows(binary, { maxBytes: binary.length - 1 }), /exceeded/);
    assert.throws(() => logicalRows(binary, { maxExpandedBytes: 32 }), /byte or record limit/);
    assert.throws(() => logicalRows(binary, { maxRecords: 2 }), /byte or record limit/);
    const repeated = binaryFixture([["M", "a".repeat(30)], ["D", Buffer.from([23, 11, 11])]]);
    assert.throws(() => logicalRows(repeated, { maxRecordBytes: 40 }), /tuple/);
    const row = binaryFixture([["M", "a".repeat(30), "a".repeat(30)]]);
    assert.throws(() => logicalRows(row, { maxRecordBytes: 40 }), /record exceeds/);
    assert.throws(() => logicalRows(binary, { maxExpandedBytes: Infinity }), /transport limit/);
    assert.throws(() => logicalRows(binary, { maxRecords: -1 }), /transport limit/);
});

test("binary dictionary definitions cannot exceed the compiler's string-count bound", () => {
    const fixture = binaryFixture([["M", Buffer.from([12, 65])]]);
    const start = fixture.indexOf("DATA\n") + 5;
    const record = fixture.subarray(start);
    const binary = Buffer.concat([fixture.subarray(0, start), ...Array(262_145).fill(record)]);
    assert.throws(() => {
        for (const row of readCompilerSemanticRows(binary)) void row;
    }, /dictionary exceeds/);
});

test("binary completeness and recovery gates remain semantic validation requirements", () => {
    assert.throws(() => decodeCompilerSemanticModel(binaryFixture([["M", "/main.bas"]])), /completeness marker/);
    const incorrect = END.slice();
    incorrect[2] = "2";
    assert.throws(() => decodeCompilerSemanticModel(binaryFixture([["M", "/main.bas"], ["D", "/main.bas"], incorrect])), /footer totals/);
    const recovery = binaryFixture([
        ["M", "/main.bas"], ["D", "/main.bas"], ["R", "27", "0"], ["RECOVERY", "27", "1", "0", "1", "0", "1", "1"]
    ], { mode: "expressions" });
    assert.throws(() => decodeCompilerSemanticExpressions(recovery), /recovery record/);
    assert.equal(decodeCompilerSemanticExpressions(recovery, () => true, { allowRecovery: true }).recovery, true);
    assert.throws(() => decodeCompilerSemanticExpressions(Buffer.concat([recovery, Buffer.from([0])]), () => true, { allowRecovery: true }), /terminal marker/);
});

/* ------------------------------------------------------------------------- */
/* Current compiler contract                                                 */
/* ------------------------------------------------------------------------- */

test("current FBC binary exports agree exactly with diagnostic text in all three modes", {
    skip: !process.env.FBC_EXECUTABLE
}, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-binary-contract-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourcePath = path.join(directory, "main.bas");
    const headerPath = path.join(directory, "header.bi");
    fs.writeFileSync(headerPath, "enum ResultKind\n    Success = 1\nend enum\n");
    fs.writeFileSync(sourcePath, [
        '#include "header.bi"', "#define SCALE(x) ((x) * 2)",
        "type Element", "    value as long", "    declare constructor()", "end type",
        "constructor Element()", "    value = 1", "end constructor",
        "dim items() as Element", "redim items(0 to 1)",
        "function compute(byval value as long) as long", "    return SCALE(value) + Success", "end function",
        "print compute(3)", ""
    ].join("\n"));
    for (const [mode, option] of [["full", "-semantic-model"], ["bindings", "-semantic-model-bindings"], ["expressions", "-semantic-model-expressions"]]) {
        for (const compact of [false, true]) {
            const binaryPath = path.join(directory, `${mode}-${compact}.fbcsem`);
            const textPath = path.join(directory, `${mode}-${compact}.tsv`);
            /* FBC's native assembly backend salts generated module-constructor
               aliases per process. GCC emission uses stable aliases, as in
               the compiler's own binary/text equivalence regression. */
            const common = [...(compact ? ["-semantic-model-compact"] : []), "-r", "-gen", "gcc", sourcePath, "-o", path.join(directory, "main.c")];
            execFileSync(process.env.FBC_EXECUTABLE, [option, binaryPath, ...common], { cwd: directory, stdio: "pipe", timeout: 30000 });
            execFileSync(process.env.FBC_EXECUTABLE, ["-semantic-model-text", option, textPath, ...common], { cwd: directory, stdio: "pipe", timeout: 30000 });
            const binary = fs.readFileSync(binaryPath);
            assert.ok(binary.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC));
            const actual = logicalRows(binary);
            const expected = fs.readFileSync(textPath, "ascii").trimEnd().split("\n");
            assert.equal(actual.length, expected.length, `${mode}, compact=${compact}: row count`);
            for (let index = 0; index < actual.length; index++) {
                assert.equal(actual[index], expected[index], `${mode}, compact=${compact}: row ${index + 1}`);
            }
            const options = { includeBindings: mode !== "expressions" };
            const decoded = decodeCompilerSemanticExpressions(binary, () => true, options);
            assert.ok(decoded.dependencies.includes(headerPath));
            if (mode !== "expressions") assert.ok(decoded.bindings.length > 0);
            if (mode !== "bindings") assert.ok(decoded.expressions.length > 0);
            if (mode === "full") {
                const full = decodeCompilerSemanticModel(binary);
                assert.ok(full.symbols.length > 0);
                assert.ok(full.implicitCalls.some((call) => call.kind === "redim-constructor"));
                assert.ok(decoded.implicitCalls.some((call) => call.kind === "redim-constructor"));
            }
        }
    }
});

test("binary stock-sidecar navigation joins qualified method definitions to their header declarations", {
    skip: !process.env.FBC_EXECUTABLE
}, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-binary-qualified-method-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const headerPath = path.join(directory, "types.bi");
    const header = "Namespace Geometry\nType Point\n    x As Long\n    Declare Sub SetX(ByVal value As Long)\nEnd Type\nEnd Namespace\n";
    const text = '#include "types.bi"\nSub Geometry.Point.SetX(ByVal value As Long)\n    x = value\nEnd Sub\nDim origin As Geometry.Point\norigin.SetX(1)\n';
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(filePath, text);
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EXECUTABLE, filePath,
        semanticModelOnly: true, exportSemanticExpressions: true, exportSemanticBindings: true
    });
    const uri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(CompilerUri.from({
        scheme: "freebasic-preprocessed", value: "freebasic-preprocessed:/main.bas"
    }), analysis, [{ uri, text }, { uri: CompilerUri.file(headerPath), text: header }]);
    const input = { uri: { scheme: "file", fsPath: filePath }, position: { line: 5, character: 8 } };
    const declarations = queryCompilerModel(model, "declaration", input, () => {});
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].uri.fsPath, headerPath);
    assert.equal(declarations[0].declaration.type, "sub");
    assert.ok(declarations[0].declaration.modifiers.includes("DECLARE"));
    const implementations = queryCompilerModel(model, "implementation", input, () => {});
    assert.equal(implementations.length, 1);
    assert.equal(implementations[0].uri.fsPath, filePath);
    assert.equal(implementations[0].declaration.type, "sub");
});

/* end of tests/compiler-semantic-transport.test.js */
