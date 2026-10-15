/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-constant-values.js

    Purpose:

        Format bounded compiler-proven values and target literals for editor UI.

    Responsibilities:

        - validate bounded numeric and string sidecar values before display
        - retain exact integers, floating-point bits, bytes, and wide units
        - summarize bounded target-wide string literal representations
        - withhold conflicting or malformed compiler facts

    This file intentionally does NOT contain:

        - FreeBASIC expression evaluation
        - source-language string encoding guesses
        - string literal escaping for source edits
        - compiler sidecar decoding
*/

const SIGNED_INTEGER_MIN = -(1n << 63n);
const SIGNED_INTEGER_MAX = (1n << 63n) - 1n;
const UNSIGNED_INTEGER_MAX = (1n << 64n) - 1n;
const FLOAT64_BYTES = 8; // IEEE-754 binary64 is 64 bits.
const WIDE_UNIT_HEX_CHARACTERS = 8; // FBC serializes each wide unit as eight hex digits.
const MAX_CONSTANT_STRING_HEX_CHARACTERS = 512;
const MAX_TARGET_WIDE_LITERAL_UNITS = 1_048_576;
const MAX_TARGET_WIDE_LITERAL_PREVIEW_UNITS = 8;
const NONPRINTABLE_UNICODE = /[\p{C}\p{Z}]/u;

function validIntegerConstant(constant) {
    if (!["signed", "unsigned"].includes(constant?.kind) || typeof constant.value !== "string" ||
        constant.value.length > 20 || !/^(?:0|-?[1-9]\d*)$/.test(constant.value) ||
        constant.kind === "unsigned" && constant.value.startsWith("-")) return false;
    const value = BigInt(constant.value);
    const minimum = constant.kind === "unsigned" ? 0n : SIGNED_INTEGER_MIN;
    const maximum = constant.kind === "unsigned" ? UNSIGNED_INTEGER_MAX : SIGNED_INTEGER_MAX;
    return value >= minimum && value <= maximum;
}

function floatingConstantText(constant) {
    if (constant?.kind !== "float64-bits" || typeof constant.value !== "string" ||
        !/^0x[0-9A-F]{16}$/i.test(constant.value)) return "";
    const bytes = Buffer.alloc(FLOAT64_BYTES);
    bytes.writeBigUInt64BE(BigInt(constant.value));
    const value = bytes.readDoubleBE(0);
    let decimal;
    if (Number.isNaN(value)) decimal = "NaN";
    else if (value === Infinity) decimal = "Infinity";
    else if (value === -Infinity) decimal = "-Infinity";
    else if (Object.is(value, -0)) decimal = "-0.0";
    else {
        decimal = String(value);
        if (Number.isFinite(value) && Number.isInteger(value) && !/[eE.]/.test(decimal)) decimal += ".0";
    }
    return `${decimal} (IEEE-754 bits 0x${constant.value.slice(2).toUpperCase()})`;
}

function validStringConstant(constant) {
    if (!constant || !["bytes", "wide-units"].includes(constant.kind) ||
        typeof constant.value !== "string" || constant.value.length > MAX_CONSTANT_STRING_HEX_CHARACTERS ||
        !/^[0-9A-F]*$/i.test(constant.value)) return false;
    return constant.kind === "bytes"
        ? constant.value.length % 2 === 0
        : constant.value.length % WIDE_UNIT_HEX_CHARACTERS === 0;
}

function asciiConstantPreview(units) {
    let preview = "";
    for (const unit of units) {
        if (unit === 0) preview += "\\0";
        else if (unit === 9) preview += "\\t";
        else if (unit === 10) preview += "\\n";
        else if (unit === 13) preview += "\\r";
        else if (unit < 32 || unit > 126) return null;
        else if (unit === 34) preview += "\"\"";
        else if (unit === 96) preview += "\\x60";
        else preview += String.fromCharCode(unit);
    }
    return preview;
}

function wideUnitUnicodePreview(units) {
    let preview = "";
    for (const unit of units) {
        if (unit > 0x10ffff || unit >= 0xd800 && unit <= 0xdfff) return null;
        if (unit === 0) preview += "\\0";
        else if (unit === 9) preview += "\\t";
        else if (unit === 10) preview += "\\n";
        else if (unit === 13) preview += "\\r";
        else if (unit === 34) preview += "\"\"";
        else if (unit === 96) preview += `\\u{${unit.toString(16).toUpperCase()}}`;
        else if (unit === 92) preview += "\\\\";
        else {
            const character = String.fromCodePoint(unit);
            if (unit !== 32 && NONPRINTABLE_UNICODE.test(character)) {
                preview += `\\u{${unit.toString(16).toUpperCase()}}`;
            } else preview += character;
        }
    }
    return preview;
}

function stringConstantText(constant) {
    if (!validStringConstant(constant)) return "";
    const hex = constant.value.toUpperCase();
    const unitWidth = constant.kind === "bytes" ? 2 : WIDE_UNIT_HEX_CHARACTERS;
    const units = [];
    for (let index = 0; index < hex.length; index += unitWidth) {
        units.push(Number.parseInt(hex.slice(index, index + unitWidth), 16));
    }
    const description = constant.kind === "bytes" ? "bytes" : "wide units";
    const preview = constant.kind === "bytes" ? asciiConstantPreview(units) : wideUnitUnicodePreview(units);
    const previewLabel = constant.kind === "bytes" ? "ASCII preview" : "Unicode preview";
    return `${description} 0x${hex}${preview === null ? "" : ` (${previewLabel}: \"${preview}\")`}`;
}

function isCompilerConstantValue(constant) {
    return validIntegerConstant(constant) || Boolean(floatingConstantText(constant)) || validStringConstant(constant);
}

function compilerConstantValueText(constant) {
    if (validIntegerConstant(constant)) return constant.value;
    return floatingConstantText(constant) || stringConstantText(constant);
}

function compilerConstantValue(facts) {
    const values = facts?.constantValues;
    if (!Array.isArray(values) || values.length === 0) return "";
    const text = values.map(compilerConstantValueText);
    if (text.some((value) => !value)) return "";
    const distinct = new Set(values.map((constant) => `${constant.kind}:${constant.value}`));
    return distinct.size === 1 ? text[0] : "";
}

function compilerTargetWideLiteralText(literal) {
    if (!literal || ![1, 2, 4].includes(literal.unitBytes) ||
        !["terminated", "unterminated"].includes(literal.kind) ||
        !Number.isSafeInteger(literal.unitCount) || literal.unitCount < 0 ||
        literal.unitCount > MAX_TARGET_WIDE_LITERAL_UNITS || !Array.isArray(literal.units) ||
        literal.units.length > MAX_TARGET_WIDE_LITERAL_PREVIEW_UNITS ||
        literal.units.length !== Math.min(literal.unitCount, MAX_TARGET_WIDE_LITERAL_PREVIEW_UNITS)) return "";
    const hexWidth = literal.unitBytes * 2;
    if (literal.units.some((unit) => typeof unit !== "string" || unit.length !== hexWidth || !/^[0-9A-F]+$/.test(unit))) return "";
    const termination = literal.kind === "terminated" ? "null-terminated" : "not null-terminated";
    const remainingUnits = literal.unitCount - literal.units.length;
    const remainingText = remainingUnits === 1 ? "1 more unit" : `${remainingUnits} more units`;
    const emittedUnits = literal.units.length
        ? `Unit prefix: \`${literal.units.join(" ")}\`${remainingUnits > 0 ? ` (${remainingText})` : ""}.`
        : "No nonzero payload units are emitted.";
    return `Compiler target wide-string representation: ${literal.unitBytes}-byte units, ${termination}. ${emittedUnits}`;
}

function compilerExpressionTypeMessage(expression) {
    if (!expression || typeof expression.typeName !== "string" || !expression.typeName) return "";
    const provisional = Boolean(expression.provisional);
    const constantValue = provisional ? "" : compilerConstantValue({
        constantValues: expression.compilerConstantValues
    });
    const targetWideLiteral = provisional ? "" : compilerTargetWideLiteralText(expression.targetWideLiteral);
    return `FreeBASIC compiler ${provisional ? "recovery type (provisional)" : "type"}: ${expression.typeName}` +
        (constantValue ? `; constant value: ${constantValue}` : "") +
        (targetWideLiteral ? `; ${targetWideLiteral}` : "");
}

module.exports = {
    compilerConstantValue,
    compilerConstantValueText,
    compilerTargetWideLiteralText,
    compilerExpressionTypeMessage,
    isCompilerConstantValue
};

/* end of lib/compiler-constant-values.js */
