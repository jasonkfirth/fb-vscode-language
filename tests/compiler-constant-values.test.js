/*
    Project: FreeBASIC VS Code Language Extension Tests
    ---------------------------------------------

    File: tests/compiler-constant-values.test.js

    Purpose:

        Verify the safe display of compiler-confirmed constant values.

    Responsibilities:

        - preserve exact numeric, byte, and wide-unit values
        - reject malformed or conflicting compiler facts

    This file intentionally does NOT contain:

        - FreeBASIC constant evaluation
        - editor provider behavior
        - compiler sidecar decoding
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { compilerConstantValue, compilerConstantValueText, compilerTargetWideLiteralText, compilerExpressionTypeMessage } = require("../lib/compiler-constant-values");

test("compiler integer constants retain their exact 64-bit decimal values", () => {
    assert.equal(compilerConstantValueText({ kind: "signed", value: "-9223372036854775808" }),
        "-9223372036854775808");
    assert.equal(compilerConstantValueText({ kind: "unsigned", value: "18446744073709551615" }),
        "18446744073709551615");
    assert.equal(compilerConstantValueText({ kind: "signed", value: "9223372036854775808" }), "");
    assert.equal(compilerConstantValueText({ kind: "unsigned", value: "-1" }), "");
    assert.equal(compilerConstantValueText({ kind: "unsigned", value: "01" }), "");
});

test("compiler floating constants show a readable value and the exact bit pattern", () => {
    assert.equal(compilerConstantValueText({ kind: "float64-bits", value: "0x3FF8000000000000" }),
        "1.5 (IEEE-754 bits 0x3FF8000000000000)");
    assert.equal(compilerConstantValueText({ kind: "float64-bits", value: "0x8000000000000000" }),
        "-0.0 (IEEE-754 bits 0x8000000000000000)");
    assert.equal(compilerConstantValueText({ kind: "float64-bits", value: "0x7FF0000000000000" }),
        "Infinity (IEEE-754 bits 0x7FF0000000000000)");
    assert.equal(compilerConstantValueText({ kind: "float64-bits", value: "0xFFF0000000000000" }),
        "-Infinity (IEEE-754 bits 0xFFF0000000000000)");
    assert.equal(compilerConstantValueText({ kind: "float64-bits", value: "0x7FF8000000000001" }),
        "NaN (IEEE-754 bits 0x7FF8000000000001)");
    assert.equal(compilerConstantValueText({ kind: "float64-bits", value: "0x3FF800000000000" }), "");
});

test("compiler string constants retain exact units and show safe previews", () => {
    assert.equal(compilerConstantValueText({ kind: "bytes", value: "48656C6C6F" }),
        'bytes 0x48656C6C6F (ASCII preview: "Hello")');
    assert.equal(compilerConstantValueText({ kind: "bytes", value: "7361792022686922" }),
        'bytes 0x7361792022686922 (ASCII preview: "say ""hi""")');
    assert.equal(compilerConstantValueText({ kind: "bytes", value: "636166C3A9" }),
        "bytes 0x636166C3A9",
        "non-ASCII bytes should remain exact without an assumed source or target encoding");
    assert.equal(compilerConstantValueText({ kind: "wide-units", value: "0000004800000069" }),
        'wide units 0x0000004800000069 (Unicode preview: "Hi")');
    assert.equal(compilerConstantValueText({ kind: "wide-units", value: "000000E9" }),
        'wide units 0x000000E9 (Unicode preview: "é")',
        "wide units are already compiler-reported Unicode values, so valid scalars can be previewed directly");
    assert.equal(compilerConstantValueText({ kind: "wide-units", value: "0001F44B" }),
        'wide units 0x0001F44B (Unicode preview: "👋")');
    assert.equal(compilerConstantValueText({ kind: "wide-units", value: "00000060" }),
        'wide units 0x00000060 (Unicode preview: "\\u{60}")',
        "inline-code delimiters must not enter hover and completion text");
    assert.equal(compilerConstantValueText({ kind: "wide-units", value: "0000D800" }),
        "wide units 0x0000D800",
        "invalid Unicode scalars should retain only their exact unit encoding");
    assert.equal(compilerConstantValueText({ kind: "bytes", value: "60" }),
        'bytes 0x60 (ASCII preview: "\\x60")',
        "inline-code delimiters must not enter hover and completion text");
    assert.equal(compilerConstantValueText({ kind: "bytes", value: "123" }), "");
    assert.equal(compilerConstantValueText({ kind: "wide-units", value: "0000001" }), "");
    assert.equal(compilerConstantValueText({ kind: "bytes", value: "G1" }), "");
    assert.equal(compilerConstantValueText({ kind: "bytes", value: "41".repeat(257) }), "");
});

test("constant display withholds conflicting and unsupported facts", () => {
    assert.equal(compilerConstantValue({ constantValues: [
        { kind: "unsigned", value: "42" },
        { kind: "unsigned", value: "42" }
    ] }), "42");
    assert.equal(compilerConstantValue({ constantValues: [
        { kind: "signed", value: "42" },
        { kind: "float64-bits", value: "0x4045000000000000" }
    ] }), "");
    assert.equal(compilerConstantValue({ constantValues: [
        { kind: "signed", value: "42" },
        { kind: "bytes", value: "2A00" }
    ] }), "");
    assert.equal(compilerConstantValue({ constantValues: [
        { kind: "bytes", value: "4869" },
        { kind: "bytes", value: "486F" }
    ] }), "");
});

test("target-wide literal text preserves the compiler's bounded unit summary", () => {
    assert.equal(compilerTargetWideLiteralText({
        unitBytes: 2,
        kind: "terminated",
        unitCount: 3,
        units: ["0041", "D83D", "DE00"]
    }), "Compiler target wide-string representation: 2-byte units, null-terminated. Unit prefix: `0041 D83D DE00`.");
    assert.equal(compilerTargetWideLiteralText({
        unitBytes: 1,
        kind: "unterminated",
        unitCount: 9,
        units: ["41", "42", "43", "44", "45", "46", "47", "48"]
    }), "Compiler target wide-string representation: 1-byte units, not null-terminated. Unit prefix: `41 42 43 44 45 46 47 48` (1 more unit).");
    assert.equal(compilerTargetWideLiteralText({ unitBytes: 4, kind: "terminated", unitCount: 1, units: ["0"] }), "");
    assert.equal(compilerTargetWideLiteralText({ unitBytes: 2, kind: "unknown", unitCount: 0, units: [] }), "");
});

test("expression type command includes compiler-folded values but withholds recovery values", () => {
    assert.equal(compilerExpressionTypeMessage({
        typeName: "integer",
        compilerConstantValues: [{ kind: "signed", value: "5" }]
    }), "FreeBASIC compiler type: integer; constant value: 5");
    assert.equal(compilerExpressionTypeMessage({ typeName: "double", compilerConstantValues: [] }),
        "FreeBASIC compiler type: double");
    assert.equal(compilerExpressionTypeMessage({
        typeName: "wstring",
        targetWideLiteral: { unitBytes: 4, kind: "terminated", unitCount: 1, units: ["0001F600"] }
    }), "FreeBASIC compiler type: wstring; Compiler target wide-string representation: 4-byte units, null-terminated. Unit prefix: `0001F600`.");
    assert.equal(compilerExpressionTypeMessage({
        typeName: "integer",
        provisional: true,
        compilerConstantValues: [{ kind: "signed", value: "5" }]
    }), "FreeBASIC compiler recovery type (provisional): integer");
});

/* end of tests/compiler-constant-values.test.js */
