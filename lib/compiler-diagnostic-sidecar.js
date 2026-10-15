/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-diagnostic-sidecar.js

    Purpose:

        Validate FBC's structured diagnostic transport before using its
        physical source locations in the editor.

    Responsibilities:

        - validate framing, counts, identities, and compiler exit agreement
        - decode bounded compiler strings with the semantic-model encoding
        - retain only compiler-reported physical diagnostic points
        - expose bounded, compiler-confirmed source ranges for supported Quick Fixes

    This file intentionally does NOT contain:

        - compiler invocation or fallback policy
        - full language parsing or guessed diagnostic locations
        - VS Code API objects
*/

const path = require("path");
const { decodeSemanticString } = require("./compiler-semantic-sidecar");
const { findUnclosedStringStart, maskFreeBasicText, normalizeIdentifier, parseFreeBasicText } = require("./freebasic-parser");

const MAX_DIAGNOSTIC_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_RECORDS = 100000;
const MAX_DIAGNOSTIC_SOURCES = 5000;
const MAX_DIAGNOSTIC_LINE_BYTES = 1024 * 1024;
const MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH = 2_000_000;
const INTEGER_OVERFLOW_WIDENINGS = Object.freeze({
    byte: [["Short", -32768n, 32767n], ["Long", -2147483648n, 2147483647n], ["LongInt", -9223372036854775808n, 9223372036854775807n]],
    ubyte: [["UShort", 0n, 65535n], ["ULong", 0n, 4294967295n], ["ULongInt", 0n, 18446744073709551615n]],
    short: [["Long", -2147483648n, 2147483647n], ["LongInt", -9223372036854775808n, 9223372036854775807n]],
    ushort: [["ULong", 0n, 4294967295n], ["ULongInt", 0n, 18446744073709551615n]],
    integer: [["LongInt", -9223372036854775808n, 9223372036854775807n]],
    uinteger: [["ULongInt", 0n, 18446744073709551615n]],
    long: [["LongInt", -9223372036854775808n, 9223372036854775807n]],
    ulong: [["ULongInt", 0n, 18446744073709551615n]]
});
const RECORD_SHAPES = Object.freeze({ FBCDIA: 3, SRC: 3, M: 4, CAP: 4, DI: 14, END: 7 });
const SEMANTIC_DIAGNOSTIC_CONTEXT_LABELS = Object.freeze({
    "declaration-suffix-as-conflict": "A type suffix and AS clause cannot both specify this declaration's type",
    "variable-case-collision": "This variable name differs only by case from an existing declaration",
    "for-next-variable-mismatch": "FOR/NEXT counter mismatch",
    "for-next-counter-binding": "Optional NEXT counter name must refer to a declared variable",
    "line-input-unknown-buffer-capacity": "LINE INPUT target has unknown buffer capacity; add a comma and maximum character count after the target",
    "procedure-signature-mismatch": "Procedure does not match its declaration",
    "error-resume-next-syntax": "ON ERROR RESUME NEXT is unsupported by FreeBASIC",
    "unclosed-procedure": "Procedure declaration remains open at end of file"
});
const UNSUPPORTED_DIAGNOSTIC_OPTION = /(?:unknown|unrecognized|unsupported|invalid|illegal|not supported|not recognized)[^\n]{0,100}(?:option|argument|switch)[^\n]{0,100}semantic[- ]diagnostics|semantic[- ]diagnostics[^\n]{0,100}(?:option|argument|switch)[^\n]{0,100}(?:unknown|unrecognized|unsupported|invalid|illegal|not supported|not recognized)/i;

function compilerDoesNotSupportStructuredDiagnostics(output) {
    return UNSUPPORTED_DIAGNOSTIC_OPTION.test(String(output || ""));
}

function integer(value, label, minimum, maximum) {
    if (!/^-?(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid FBC diagnostic ${label}.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`FBC diagnostic ${label} exceeds its bound.`);
    }
    return parsed;
}

function compilerPathKey(filePath) {
    const normalized = path.normalize(filePath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeDiagnosticPath(filePath, cwd, label) {
    if (!filePath || /[\0\r\n]/.test(filePath)) throw new Error(`Invalid FBC diagnostic ${label}.`);
    return path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath));
}

function decodeCompilerDiagnosticSidecar(input, options = {}) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
    if (buffer.length > MAX_DIAGNOSTIC_BYTES || !buffer.length || buffer.at(-1) !== 0x0a) {
        throw new Error("Incomplete or oversized FBC diagnostic sidecar.");
    }

    for (const byte of buffer) {
        if (byte > 0x7f) throw new Error("Unescaped byte in FBC diagnostic sidecar.");
    }

    const sources = [];
    const sourceKeys = new Set();
    const modules = [];
    const capabilities = new Set();
    const diagnostics = [];
    let errors = 0;
    let ended = false;
    let producer = "";
    const lines = buffer.toString("ascii").split("\n");

    for (let ordinal = 0; ordinal < lines.length - 1; ordinal++) {
        let raw = lines[ordinal];
        if (raw.endsWith("\r")) raw = raw.slice(0, -1);
        if (ended || Buffer.byteLength(raw, "ascii") > MAX_DIAGNOSTIC_LINE_BYTES) {
            throw new Error("Trailing or oversized FBC diagnostic record.");
        }

        const fields = raw.split("\t");
        const shape = RECORD_SHAPES[fields[0]];
        if (!shape || fields.length !== shape) throw new Error("Unknown FBC diagnostic record or invalid shape.");
        if (fields.some((field) => /[^\x20-\x7e]/.test(field))) throw new Error("Unescaped character in FBC diagnostic field.");
        const row = fields.map((field, index) => index === 0 ? field : decodeSemanticString(field, `${fields[0]} field ${index}`, 27));

        if (ordinal === 0) {
            if (row[0] !== "FBCDIA" || row[1] !== "1" || !row[2] || /[\0\r\n]/.test(row[2])) {
                throw new Error("Unsupported FBC diagnostic sidecar header.");
            }
            producer = row[2];
            continue;
        }

        if (row[0] === "SRC") {
            integer(row[1], "source identity", sources.length + 1, sources.length + 1);
            if (sources.length >= MAX_DIAGNOSTIC_SOURCES) throw new Error("FBC diagnostic source limit exceeded.");
            const filePath = normalizeDiagnosticPath(row[2], options.cwd || process.cwd(), "source path");
            const key = compilerPathKey(filePath);
            if (sourceKeys.has(key)) throw new Error("Repeated FBC diagnostic source path.");
            sources.push(filePath);
            sourceKeys.add(key);
            continue;
        }

        if (row[0] === "M") {
            integer(row[1], "module identity", modules.length + 1, modules.length + 1);
            const filePath = normalizeDiagnosticPath(row[2], options.cwd || process.cwd(), "module path");
            if (modules.length >= MAX_DIAGNOSTIC_RECORDS || !sourceKeys.has(compilerPathKey(filePath)) || !row[3]) {
                throw new Error("Invalid FBC diagnostic module.");
            }
            modules.push({ filePath, target: row[3] });
            continue;
        }

        if (row[0] === "CAP") {
            const module = integer(row[1], "capability module", 1, modules.length);
            if (!row[2] || row[3] !== "available") throw new Error("Invalid FBC diagnostic capability.");
            const key = `${module}:${row[2]}`;
            if (capabilities.has(key)) throw new Error("Repeated FBC diagnostic capability.");
            capabilities.add(key);
            continue;
        }

        if (row[0] === "DI") {
            integer(row[1], "diagnostic identity", diagnostics.length + 1, diagnostics.length + 1);
            const module = integer(row[2], "diagnostic module", 1, modules.length);
            if (diagnostics.length >= MAX_DIAGNOSTIC_RECORDS || !["error", "warning"].includes(row[3])) {
                throw new Error("Invalid or excessive FBC diagnostic record.");
            }
            const code = integer(row[4], "compiler code", 0, 2147483647);
            const filePath = normalizeDiagnosticPath(row[6], options.cwd || process.cwd(), "diagnostic path");
            if (!sourceKeys.has(compilerPathKey(filePath))) throw new Error("FBC diagnostic refers to an unobserved source.");
            const displayedLine = integer(row[7], "displayed line", -1, 2147483647);
            if ([row[8], row[9], row[10]].some((value) => value.includes("\0"))) {
                throw new Error("Invalid NUL in FBC diagnostic text.");
            }
            if (!/^[01]$/.test(row[11])) throw new Error("Invalid FBC diagnostic physical-point flag.");
            const physicalLine = integer(row[12], "physical line", 0, 2147483647);
            const physicalColumn = integer(row[13], "physical column", 0, 2147483647);
            const physical = row[11] === "1";
            if (physical ? physicalLine < 1 || displayedLine < 1 : physicalLine !== 0 || physicalColumn !== 0) {
                throw new Error("Contradictory FBC diagnostic physical point.");
            }

            const diagnostic = {
                module,
                severity: row[3],
                code,
                context: row[5],
                filePath,
                displayedLine,
                message: row[8],
                detail: row[9],
                customText: row[10],
                physicalPoint: physical ? { line: physicalLine - 1, character: physicalColumn } : null
            };
            if (diagnostic.severity === "error") errors++;
            diagnostics.push(diagnostic);
            continue;
        }

        const expectedEnd = ["END", "1", String(modules.length), String(sources.length),
            String(diagnostics.length), String(errors)];
        if (!modules.length || row.slice(0, 6).some((value, index) => value !== expectedEnd[index]) || !["0", "1"].includes(row[6])) {
            throw new Error("Invalid FBC diagnostic completion totals.");
        }
        const succeeded = row[6] === "1";
        if (succeeded && errors) throw new Error("Successful FBC diagnostic sidecar retains errors.");
        if (options.compilerExitCode !== undefined && succeeded !== (options.compilerExitCode === 0)) {
            throw new Error("FBC diagnostic outcome disagrees with compiler exit status.");
        }
        ended = true;
    }

    if (!ended) throw new Error("Missing FBC diagnostic completion record.");
    return { producer, sources, modules, diagnostics };
}

function attachStructuredDiagnosticData(textualDiagnostics, structuredDiagnostics, cwd = process.cwd()) {
    const keyForPath = (filePath) => compilerPathKey(path.resolve(cwd, filePath));
    const grouped = new Map();
    for (const diagnostic of structuredDiagnostics || []) {
        const key = [keyForPath(diagnostic.filePath), diagnostic.displayedLine, diagnostic.severity, diagnostic.code].join(":");
        const group = grouped.get(key) || [];
        group.push(diagnostic);
        grouped.set(key, group);
    }

    const used = new Set();
    return textualDiagnostics.map((diagnostic) => {
        const key = [keyForPath(diagnostic.filePath), diagnostic.line + 1, diagnostic.severity, diagnostic.code].join(":");
        const candidates = (grouped.get(key) || []).filter((candidate) => !used.has(candidate));
        const exact = candidates.filter((candidate) => candidate.message === diagnostic.message);
        const selected = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
        if (!selected) return diagnostic;

        used.add(selected);
        return {
            ...diagnostic,
            compilerContext: selected.context,
            compilerDetail: selected.detail,
            compilerCustomText: selected.customText,
            physicalPoint: selected.physicalPoint
        };
    });
}

function sourceLines(sourceText) {
    return Array.isArray(sourceText) ? sourceText : String(sourceText ?? "").split(/\r\n|\n|\r/);
}

function physicalDiagnosticRange(sourceText, point) {
    if (!point || !Number.isSafeInteger(point.line) || !Number.isSafeInteger(point.character) || point.line < 0 || point.character < 0) return null;
    const lines = sourceLines(sourceText);
    if (point.line >= lines.length || point.character > lines[point.line].length) return null;

    let endCharacter = point.character;
    if (endCharacter < lines[point.line].length) {
        endCharacter++;
        const first = lines[point.line].charCodeAt(point.character);
        const second = lines[point.line].charCodeAt(endCharacter);
        if (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) endCharacter++;
    }

    return { line: point.line, startCharacter: point.character, endCharacter };
}

function compilerPointedTokenRange(sourceText, point) {
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const lines = sourceLines(text);
    if (!point || !Number.isSafeInteger(point.line) || !Number.isSafeInteger(point.character) ||
        point.line < 0 || point.line >= lines.length || point.character < 0 ||
        point.character >= lines[point.line].length || lines[point.line].length > 65536) return null;

    const maskedLine = maskFreeBasicText(lines[point.line]);
    const identifierCharacter = /[A-Za-z0-9_$%!#&]/;
    if (!identifierCharacter.test(maskedLine[point.character] || "")) return null;
    let startCharacter = point.character;
    let endCharacter = point.character + 1;
    while (startCharacter > 0 && identifierCharacter.test(maskedLine[startCharacter - 1])) startCharacter--;
    while (endCharacter < maskedLine.length && identifierCharacter.test(maskedLine[endCharacter])) endCharacter++;
    return { line: point.line, startCharacter, endCharacter };
}

function compilerSuspiciousPointerAssignmentRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" || String(diagnostic.message || "") !== "Suspicious pointer assignment") {
        return null;
    }
    const token = compilerPointedTokenRange(sourceText, diagnostic.physicalPoint);
    if (token) return token;
    const range = physicalDiagnosticRange(sourceText, diagnostic.physicalPoint);
    if (!range) return null;
    const line = sourceLines(sourceText)[range.line];
    return /\S/.test(line.slice(range.startCharacter, range.endCharacter)) ? range : null;
}

function compilerFunctionPointerMismatchRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^(?:Return type mismatch|Return method mismatch|Calling convention mismatch|Argument count mismatch) in function pointer$/i
            .test(String(diagnostic.message || ""))) return null;
    return compilerPointedTokenRange(sourceText, diagnostic.physicalPoint);
}

function compilerOperatorWarningTokenRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^(?:Suspicious logic operation, mixed boolean and non-boolean operands|Shift value greater than or equal to number of bits in data type)$/i
            .test(String(diagnostic.message || ""))) return null;
    return compilerPointedTokenRange(sourceText, diagnostic.physicalPoint);
}

function compilerConstQualifierWarningRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^CONST qualifier discarded(?:,|$)/i.test(String(diagnostic.message || ""))) return null;
    return compilerPointedTokenRange(sourceText, diagnostic.physicalPoint);
}

function compilerLargeStackWarningRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^(?:Variable too large for stack, consider making it SHARED|Array too large for stack, consider making it var-len or SHARED)$/i
            .test(String(diagnostic.message || ""))) return null;
    return compilerPointedTokenRange(sourceText, diagnostic.physicalPoint);
}

function compilerImplicitConversionRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" || !/^Implicit conversion$/i.test(String(diagnostic.message || ""))) return null;
    return compilerPointedTokenRange(sourceText, diagnostic.physicalPoint);
}

function compilerParameterDefaultMismatchRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning") return null;
    const message = String(diagnostic.message || "").split("\n\n")[0].trim();
    const mismatch = /^Mismatching parameter initializer,\s*at parameter\s+\d+\s+\([^)\r\n]+\)\s+of\s+([A-Za-z_][A-Za-z0-9_.$%!#&]*)\(\)$/i.exec(message);
    if (!mismatch) return null;
    const range = compilerPointedTokenRange(sourceText, diagnostic.physicalPoint);
    if (!range) return null;
    const lines = sourceLines(sourceText);
    const maskedLine = maskFreeBasicText(lines[range.line]);
    const declaration = /^\s*(?:(?:declare|public|private|protected|shared|static|virtual|abstract|override|final)\s+)*(?:sub|function|property|operator)\s+([A-Za-z_][A-Za-z0-9_.$%!#&]*)\s*\(/i
        .exec(maskedLine);
    if (!declaration) return null;
    const sourceName = declaration[1].split(".").at(-1);
    const reportedName = mismatch[1].split(".").at(-1);
    const selectedName = lines[range.line].slice(range.startCharacter, range.endCharacter);
    if (normalizeIdentifier(sourceName) !== normalizeIdentifier(reportedName) ||
        normalizeIdentifier(sourceName) !== normalizeIdentifier(selectedName)) return null;
    return range;
}

function compilerForCounterWrapRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        String(diagnostic.message || "") !== "FOR counter variable is unable to exceed limit value") return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const lines = sourceLines(text);
    const point = diagnostic.physicalPoint;
    if (!point || !Number.isSafeInteger(point.line) || !Number.isSafeInteger(point.character) ||
        point.line < 0 || point.line >= lines.length || point.character < 0 ||
        point.character >= lines[point.line].length || lines[point.line].length > 65536) return null;
    const maskedLine = maskFreeBasicText(lines[point.line]);
    const loop = /^\s*for\b/i.exec(maskedLine);
    if (!loop) return null;
    const limit = /\bto\b/i.exec(maskedLine.slice(loop[0].length));
    if (!limit) return null;
    const limitStart = loop[0].length + limit.index + limit[0].length;
    if (point.character < limitStart || !maskedLine[point.character] ||
        /\s/.test(maskedLine[point.character])) return null;
    return physicalDiagnosticRange(lines, point);
}

function compilerConstantConversionOverflowRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" || String(diagnostic.message || "") !== "Overflow in constant conversion") return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const lines = sourceLines(text);
    const point = diagnostic.physicalPoint;
    const line = point?.line ?? diagnostic.line;
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length || lines[line].length > 65536 ||
        point && (!Number.isSafeInteger(point.character) || point.character < 0 || point.character >= lines[line].length)) return null;

    const maskedLine = maskFreeBasicText(lines[line]);
    const declaration = /^(\s*(?:dim|static|const)\s+)([A-Za-z_][A-Za-z0-9_]*)(\s+as\s+)(byte|ubyte|short|ushort|integer|uinteger|long|ulong)(\s*=\s*)(-?\d+)\s*$/i
        .exec(maskedLine);
    if (!declaration) return null;
    const sourceType = declaration[4];
    const candidates = INTEGER_OVERFLOW_WIDENINGS[sourceType.toLowerCase()];
    if (!candidates) return null;
    let value;
    try {
        value = BigInt(declaration[6]);
    } catch {
        return null;
    }
    const widerType = candidates.find((candidate) => value >= candidate[1] && value <= candidate[2]);
    if (!widerType) return null;

    const literalStart = declaration[1].length + declaration[2].length + declaration[3].length +
        declaration[4].length + declaration[5].length;
    const literalEnd = literalStart + declaration[6].length;
    if (point && (point.character < literalStart || point.character >= literalEnd)) return null;
    const typeStart = declaration[1].length + declaration[2].length + declaration[3].length;
    return {
        line,
        startCharacter: literalStart,
        endCharacter: literalEnd,
        typeStartCharacter: typeStart,
        typeEndCharacter: typeStart + sourceType.length,
        name: declaration[2],
        sourceType,
        widerType: widerType[0]
    };
}

function compilerConstantConversionOverflowPointRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^Overflow in constant conversion(?:,|$)/i.test(String(diagnostic.message || ""))) return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const lines = sourceLines(text);
    const point = diagnostic.physicalPoint;
    if (!point || !Number.isSafeInteger(point.line) || !Number.isSafeInteger(point.character) ||
        point.line < 0 || point.line >= lines.length || point.character < 0 ||
        point.character >= lines[point.line].length || lines[point.line].length > 65536) return null;
    return compilerPointedTokenRange(text, point);
}

function physicalPointMatchesDiagnosticText(sourceText, diagnostic) {
    const lines = sourceLines(sourceText);
    const range = physicalDiagnosticRange(lines, diagnostic?.physicalPoint);
    if (!range) return false;
    const line = lines[range.line];
    const character = diagnostic.physicalPoint.character;
    if (character >= line.length) return false;

    let start = character;
    let end = character;
    const identifierCharacter = /[A-Za-z0-9_$%!#&]/;
    if (identifierCharacter.test(line[character])) {
        while (start > 0 && identifierCharacter.test(line[start - 1])) start--;
        while (end < line.length && identifierCharacter.test(line[end])) end++;
        const token = line.slice(start, end).toLowerCase();
        const evidence = [diagnostic.message, diagnostic.compilerDetail, diagnostic.compilerCustomText]
            .filter(Boolean).join("\n").toLowerCase();
        let found = evidence.indexOf(token);
        while (found >= 0) {
            const before = evidence[found - 1] || "";
            const after = evidence[found + token.length] || "";
            if (!identifierCharacter.test(before) && !identifierCharacter.test(after)) return true;
            found = evidence.indexOf(token, found + 1);
        }
        return false;
    }

    const symbol = line[character];
    const evidence = [diagnostic.message, diagnostic.compilerDetail, diagnostic.compilerCustomText].filter(Boolean).join("\n");
    return evidence.includes(`'${symbol}'`) || evidence.includes(`"${symbol}"`);
}

function compilerDiagnosticContextLabel(context) {
    return typeof context === "string" && Object.hasOwn(SEMANTIC_DIAGNOSTIC_CONTEXT_LABELS, context)
        ? SEMANTIC_DIAGNOSTIC_CONTEXT_LABELS[context]
        : "";
}

function compilerDiagnosticGuidance(diagnostic) {
    if (diagnostic?.severity !== "warning") return "";
    const message = String(diagnostic.message || "");
    if (/^'IF' statement found directly after multi-line 'ELSE'$/i.test(message)) {
        return "This starts a nested IF. If you meant another branch of the same conditional, use ELSEIF.";
    }
    if (/^'=' parsed as equality operator in function argument, not assignment to BYREF function result$/i.test(message)) {
        return "If you intended to assign to the BYREF result, wrap the function call in parentheses: (function(arguments)) = value.";
    }
    if (/^Possible escape sequence found in\b/i.test(message)) {
        return "This string is not escape-processed. Prefix it with ! if you intended C-style escape sequences.";
    }
    if (/^Command line option overrides directive$/i.test(message)) {
        return "The command-line option takes precedence over this source directive. Change the build configuration or remove the directive if you want a different setting.";
    }
    if (/^Object files or libraries with mixed multithreading \(-mt\) options$/i.test(message)) {
        return "Linked objects or libraries use different -mt settings. Rebuild all dependencies with the same multithreading option before linking.";
    }
    if (/^Object files or libraries with mixed language \(-lang\) options$/i.test(message)) {
        return "Linked objects or libraries use different -lang dialects. Rebuild all components with a consistent dialect before linking.";
    }
    if (/^Function result was not explicitly set$/i.test(message)) {
        return "Set a result with Return expression or Function = expression before the function ends.";
    }
    if (/^Implicit conversion$/i.test(message)) {
        return "FBC converts this expression to fit its context. Check whether signedness and width are intentional; use an explicit cast or literal suffix when you need a specific representation.";
    }
    if (/^Variable too large for stack, consider making it SHARED$/i.test(message)) {
        return "This local needs more stack space than FBC considers safe. SHARED moves it to module-wide storage and changes its lifetime and visibility; use that only when shared state is intended.";
    }
    if (/^Array too large for stack, consider making it var-len or SHARED$/i.test(message)) {
        return "This fixed-size array is too large for the stack. Consider a variable-length array if its size need not be fixed; SHARED instead moves storage to module scope and changes its lifetime and visibility.";
    }
    if (/^Suspicious address expression passed to BYREF parameter(?:,|$)/i.test(message)) {
        return "FBC passes a temporary for this non-addressable expression. If the procedure should access the original variable, pass that variable directly; otherwise confirm the temporary is intentional.";
    }
    if (/^Passing scalar as pointer(?:,|$)/i.test(message)) {
        return "This parameter expects an address, not the scalar value. If you intended to pass the variable's address, supply an appropriately typed pointer; otherwise check the parameter type.";
    }
    if (/^Passing pointer to scalar(?:,|$)/i.test(message)) {
        return "This parameter expects a scalar value, not a pointer. If you intended to pass the pointed-to value, dereference the pointer; otherwise check the parameter type.";
    }
    if (/^Passing Pointer(?:,|$)/i.test(message)) {
        return "This file operation transfers the pointer value (the address), not the memory it points to. To transfer the data, pass the pointed-to value instead; raw addresses are not portable between runs.";
    }
    if (/^UDT with pointer, var-len string, or var-len array fields(?:,|$)/i.test(message)) {
        return "Raw file transfer writes the UDT's in-memory representation, including pointer or runtime-managed fields, not the data they reference. Serialize those fields explicitly for portable records.";
    }
    if (/^Passing different pointer types(?:,|$)/i.test(message)) {
        return "The argument and parameter point to different types. Verify their representations; cast explicitly only when the conversion is genuinely compatible.";
    }
    if (/^Suspicious pointer assignment$/i.test(message)) {
        return "This assignment preserves the address; it does not convert the pointed-to data. Confirm the destination pointer matches the object's actual type, or cast only for an intentional reinterpretation.";
    }
    if (/^Suspicious logic operation, mixed boolean and non-boolean operands$/i.test(message)) {
        return "FBC converts the Boolean operand to an integer for this mixed operation. Use Boolean operands for logical conditions or consistently numeric operands for bitwise work, according to your intent.";
    }
    if (/^Mixing signed\/unsigned operands$/i.test(message)) {
        return "FBC may convert the signed value to unsigned; a negative operand can then behave like a large positive value. Convert both operands explicitly to a common signedness if that is intended.";
    }
    if (/^Shift value greater than or equal to number of bits in data type$/i.test(message)) {
        return "FBC masks an out-of-range constant shift count to the low bits selected by the operand width. Check that this wraparound is intended; otherwise keep the count between zero and width minus one.";
    }
    if (/^FOR counter variable is unable to exceed limit value$/i.test(message)) {
        return "FBC sees the limit at the counter type's boundary in this loop direction. The counter may wrap instead of passing the limit, so the loop may not terminate naturally; use a wider counter or reduce the limit.";
    }
    if (/^Branch crossing local variable definition(?:,|$)/i.test(message)) {
        return "This branch skips a local variable's declaration or initialization. Restructure the jump or move initialization so every path initializes the variable before use.";
    }
    if (/^Overflow in constant conversion(?:,|$)/i.test(message)) {
        const parameter = /,\s*at parameter\s+(\d+)\s+\(([^)\r\n]+)\)\s+of\s+([^()\r\n]+)\(\)$/i.exec(message);
        if (parameter) {
            return `The constant conversion for parameter ${parameter[1]} (${parameter[2]}) of ${parameter[3]}() exceeds its representable range. Adjust the constant or widen the parameter type if the procedure contract allows.`;
        }
        return "This constant value or result is outside the target type's representable range. Use a wider type or adjust the value, and check literal suffixes if they affect the intended type.";
    }
    if (/^Literal number too big, truncated$/i.test(message)) {
        return "FBC truncated this literal because its value exceeds the supported literal range. Use a representable literal or split the calculation; a wider destination type cannot restore bits already lost while parsing.";
    }
    if (/^Expected digit$/i.test(message)) {
        return "This numeric literal is missing a required digit after a base prefix or exponent marker. Add a valid digit or remove the incomplete prefix or marker.";
    }
    if (/^Mismatching parameter initializer(?:,|$)/i.test(message)) {
        return "The optional parameter's default differs between its declaration and definition. Keep them consistent so callers do not compile with a default that disagrees with the implementation.";
    }
    if (/^Suffix ignored\b/i.test(message)) {
        return "FBC ignored this type suffix, so it does not control the value's type here. Remove it; use an AS clause when you need an explicit declaration type.";
    }
    if (/^CONST qualifier discarded(?:,|$)/i.test(message)) {
        return "Discarding CONST permits mutation through this alias. Preserve CONST when the underlying storage may be read-only; remove it only when you know the object is mutable.";
    }
    if (/^Use of reserved global or backend symbol(?:,|$)/i.test(message)) {
        return "This global name is reserved by the compiler or target backend. Choose a project-specific name to avoid collisions in generated code.";
    }
    const ambiguousIntrinsic = /^Ambiguous (len|sizeof|typeof)\(\), referring to (type(?: alias)?|variable|constant|forward reference) (.+), instead of (type(?: alias)?|variable|constant|forward reference) (.+)$/i
        .exec(message);
    if (ambiguousIntrinsic) {
        return `FBC resolved ${ambiguousIntrinsic[1].toUpperCase()} as ${ambiguousIntrinsic[2]} '${ambiguousIntrinsic[3]}' instead of ${ambiguousIntrinsic[4]} '${ambiguousIntrinsic[5]}'. Make the intended value expression unambiguous, such as indexing an array when appropriate, or rename one of the conflicting declarations.`;
    }
    if (/^Return method mismatch(?: in function pointer)?$/i.test(message)) {
        return "The procedure signature and its declaration or function-pointer type disagree about returning by value or BYREF. Make their return methods match; callers depend on that contract.";
    }
    if (/^Return type mismatch in function pointer$/i.test(message)) {
        return "The function pointer's result type does not match the target function's result. Make the declared pointer signature match before calling through it.";
    }
    if (/^Calling convention mismatch in function pointer$/i.test(message)) {
        return "The function pointer and target function use different calling conventions. Make them match; the convention determines how arguments and results cross the call boundary.";
    }
    if (/^Argument count mismatch in function pointer$/i.test(message)) {
        return "The function pointer and target function declare different parameter counts. Match their signatures before calling through the pointer.";
    }
    if (/^Cast to non-pointer$/i.test(message)) {
        return "CPTR is normally for a pointer target. If you need a numeric address, choose an integer type that can hold the target's pointer width and keep the conversion explicit; otherwise use a pointer target type.";
    }
    if (/^Deleting ANY pointers is undefined$/i.test(message)) {
        return "FBC cannot determine the allocated type or required destructor through an ANY PTR. Preserve the actual pointer type and use the cleanup operation that matches the allocation.";
    }
    return "";
}

function forNextCounterIdentifiers(sourceText, lineNumber) {
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH || !Number.isSafeInteger(lineNumber) || lineNumber < 0) return null;
    const lines = sourceLines(text);
    if (lineNumber >= lines.length) return null;
    const masked = sourceLines(maskFreeBasicText(text))[lineNumber];
    const match = masked.match(/^(\s*next\b\s+)([A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*)\s*$/i);
    if (!match) return null;

    const counters = [];
    const identifierPattern = /[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g;
    for (const identifier of match[2].matchAll(identifierPattern)) {
        const startCharacter = match[1].length + identifier.index;
        const endCharacter = startCharacter + identifier[0].length;
        counters.push({
            line: lineNumber,
            startCharacter,
            endCharacter,
            name: lines[lineNumber].slice(startCharacter, endCharacter)
        });
    }
    if (!counters.length) return null;

    const indentation = match[1].match(/^\s*/)[0];
    return {
        line: lineNumber,
        counters,
        indentation,
        keyword: lines[lineNumber].slice(indentation.length, indentation.length + 4),
        trailingText: lines[lineNumber].slice(match[1].length + match[2].length)
    };
}

function forNextCounterIdentifierRange(sourceText, lineNumber) {
    const statement = forNextCounterIdentifiers(sourceText, lineNumber);
    return statement?.counters.length === 1 ? statement.counters[0] : null;
}

function compilerForNextCounterMismatchRange(sourceText, diagnostic) {
    if (diagnostic?.compilerContext !== "for-next-variable-mismatch") return null;
    const point = diagnostic.physicalPoint;
    const statement = forNextCounterIdentifiers(sourceText, point?.line);
    const matching = statement?.counters.filter((identifier) => point?.character === identifier.startCharacter) || [];
    return matching.length === 1 ? matching[0] : null;
}

function compilerMeaninglessNextVariableRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning") return null;
    const reported = String(diagnostic.message || "").match(/^Variable following NEXT is meaningless,\s*([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)$/i)?.[1];
    if (!reported) return null;
    const point = diagnostic.physicalPoint;
    const line = point?.line ?? diagnostic.line;
    const statement = forNextCounterIdentifiers(sourceText, line);
    const matching = statement?.counters.filter((identifier) =>
        identifier.name.toLowerCase() === reported.toLowerCase() &&
        (point ? point.character === identifier.startCharacter : true)
    ) || [];
    return matching.length === 1 ? matching[0] : null;
}

function compilerProcedureSignatureMismatchRange(sourceText, diagnostic) {
    if (diagnostic?.compilerContext !== "procedure-signature-mismatch") return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line;
    const character = diagnostic.physicalPoint?.character;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length ||
        !Number.isSafeInteger(character) || character < 0) return null;
    if (diagnostic.sourceText && lines[line].trim() !== diagnostic.sourceText.trim()) return null;

    const maskedLine = sourceLines(maskFreeBasicText(text))[line];
    const match = maskedLine.match(/^\s*(?:(?:abstract|const|declare|export|override|private|protected|public|static|virtual)\s+)*(?:sub|function|property)\s+([A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\.[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*)/i);
    if (!match) return null;
    const startCharacter = match[0].lastIndexOf(match[1]);
    const endCharacter = startCharacter + match[1].length;
    if (character !== startCharacter) return null;
    return { line, startCharacter, endCharacter, name: lines[line].slice(startCharacter, endCharacter) };
}

function compilerErrorResumeNextRange(sourceText, diagnostic) {
    if (diagnostic?.compilerContext !== "error-resume-next-syntax") return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line;
    const character = diagnostic.physicalPoint?.character;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length ||
        !Number.isSafeInteger(character) || character < 0) return null;
    const maskedLine = sourceLines(maskFreeBasicText(text))[line];
    if (diagnostic.sourceText && maskedLine.trim() !== diagnostic.sourceText.trim()) return null;
    const match = maskedLine.slice(character).match(/^on\s+(?:local\s+)?error\s+resume\s+next\b/i);
    if (!match) return null;
    return { line, startCharacter: character, endCharacter: character + match[0].length };
}

function compilerByRefFunctionResultAssignmentRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        String(diagnostic.message || "") !==
            "'=' parsed as equality operator in function argument, not assignment to BYREF function result") return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const lines = sourceLines(text);
    const point = diagnostic.physicalPoint;
    const line = point?.line ?? diagnostic.line;
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length || lines[line].length > 65536 ||
        point && (!Number.isSafeInteger(point.character) || point.character < 0 || point.character > lines[line].length)) return null;

    const maskedLine = maskFreeBasicText(lines[line]);
    /* The warning authorizes this rewrite only when one bare call owns the whole left side. */
    const nesting = { parentheses: 0, brackets: 0, braces: 0 };
    const equalities = [];
    for (let index = 0; index < maskedLine.length; index++) {
        const character = maskedLine[index];
        if (character === "(") nesting.parentheses++;
        else if (character === ")") nesting.parentheses--;
        else if (character === "[") nesting.brackets++;
        else if (character === "]") nesting.brackets--;
        else if (character === "{") nesting.braces++;
        else if (character === "}") nesting.braces--;
        if (nesting.parentheses < 0 || nesting.brackets < 0 || nesting.braces < 0) return null;
        if (character !== "=" || nesting.parentheses || nesting.brackets || nesting.braces ||
            ["=", "<", ">"].includes(maskedLine[index - 1] || "") ||
            ["=", ">"].includes(maskedLine[index + 1] || "")) continue;
        equalities.push(index);
        if (equalities.length > 1) return null;
    }
    if (nesting.parentheses || nesting.brackets || nesting.braces || equalities.length !== 1) return null;

    const equalsCharacter = equalities[0];
    if (!maskedLine.slice(equalsCharacter + 1).trim() ||
        point && (point.character <= equalsCharacter || point.character >= lines[line].length)) return null;
    let callEndCharacter = equalsCharacter;
    while (callEndCharacter > 0 && /\s/.test(maskedLine[callEndCharacter - 1])) callEndCharacter--;
    if (maskedLine[callEndCharacter - 1] !== ")") return null;

    let parentheses = 0;
    let callOpenCharacter = -1;
    for (let index = callEndCharacter - 1; index >= 0; index--) {
        if (maskedLine[index] === ")") parentheses++;
        else if (maskedLine[index] === "(") {
            parentheses--;
            if (parentheses === 0) {
                callOpenCharacter = index;
                break;
            }
            if (parentheses < 0) return null;
        }
    }
    if (callOpenCharacter < 0) return null;
    const callee = /([A-Za-z_][A-Za-z0-9_]*[$%!#&]?(?:\.[A-Za-z_][A-Za-z0-9_]*[$%!#&]?)*)\s*$/.exec(
        maskedLine.slice(0, callOpenCharacter)
    );
    if (!callee) return null;
    const callStartCharacter = callee.index;
    if (maskedLine.slice(0, callStartCharacter).trim()) return null;

    return {
        line,
        startCharacter: equalsCharacter,
        endCharacter: equalsCharacter + 1,
        callStartCharacter,
        callEndCharacter
    };
}

function compilerLineInputBufferCapacityRange(sourceText, diagnostic) {
    if (diagnostic?.compilerContext !== "line-input-unknown-buffer-capacity") return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line;
    const character = diagnostic.physicalPoint?.character;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length ||
        !Number.isSafeInteger(character) || character < 0) return null;
    const maskedLine = sourceLines(maskFreeBasicText(text))[line];
    if (diagnostic.sourceText && maskedLine.trim() !== diagnostic.sourceText.trim()) return null;
    if (!/\bline\s+input\b/i.test(maskedLine.slice(0, character))) return null;
    const target = maskedLine.slice(character).match(/^([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)/);
    if (!target) return null;
    return { line, startCharacter: character, endCharacter: character + target[1].length, name: target[1] };
}

function compilerMissingClosingQuoteRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^Missing closing quote in literal string$/i.test(String(diagnostic.message || ""))) return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const point = diagnostic.physicalPoint;
    const line = point?.line ?? diagnostic.line;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length || lines[line].length > 65536 ||
        point && (!Number.isSafeInteger(point.character) || point.character < 0 || point.character > lines[line].length)) return null;
    const startCharacter = findUnclosedStringStart(lines[line]);
    const escapedStringStart = findUnclosedStringStart(lines[line], false, true);
    if (startCharacter !== escapedStringStart) return null;
    if (!Number.isSafeInteger(startCharacter) || startCharacter < 0 || startCharacter >= lines[line].length) return null;
    let trailingBackslashes = 0;
    for (let index = lines[line].length - 1; index >= startCharacter && lines[line][index] === "\\"; index--) {
        trailingBackslashes++;
    }
    /* OPTION ESCAPE can make a trailing backslash consume the inserted quote. */
    if (trailingBackslashes % 2 === 1) return null;
    return {
        line,
        startCharacter,
        endCharacter: lines[line].length,
        insertionCharacter: lines[line].length
    };
}

function compilerPossibleEscapeStringRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^Possible escape sequence found in\b/i.test(String(diagnostic.message || ""))) return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line;
    const character = diagnostic.physicalPoint?.character;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length || lines[line].length > 65536 ||
        !Number.isSafeInteger(character) || character < 0 || character >= lines[line].length ||
        lines[line][character] !== "\"" || ["!", "$"].includes(lines[line][character - 1] || "")) return null;

    for (let index = character + 1; index < lines[line].length; index++) {
        if (lines[line][index] !== "\"") continue;
        if (lines[line][index + 1] === "\"") {
            index++;
            continue;
        }
        return { line, startCharacter: character, endCharacter: index + 1 };
    }
    return null;
}

function compilerRedundantNewAnyInitializerRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^The ANY initializer has no effect on UDT's with default constructors$/i.test(String(diagnostic.message || ""))) return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line;
    const character = diagnostic.physicalPoint?.character;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length || lines[line].length > 65536 ||
        !Number.isSafeInteger(character) || character < 0 || character >= lines[line].length) return null;

    const maskedLine = sourceLines(maskFreeBasicText(text))[line];
    if (maskedLine[character] !== "{") return null;
    const initializer = maskedLine.slice(character).match(/^\{\s*any\s*\}/i);
    if (!initializer) return null;

    const statementStart = maskedLine.lastIndexOf(":", character) + 1;
    const prefix = maskedLine.slice(statementStart, character).trimEnd();
    if (!prefix.endsWith("]")) return null;
    let bracketDepth = 0;
    let openingBracket = -1;
    for (let index = prefix.length - 1; index >= 0; index--) {
        if (prefix[index] === "]") {
            bracketDepth++;
        } else if (prefix[index] === "[") {
            bracketDepth--;
            if (bracketDepth === 0) {
                openingBracket = index;
                break;
            }
            if (bracketDepth < 0) return null;
        }
    }
    if (openingBracket < 0 || !/\bnew\b/i.test(prefix.slice(0, openingBracket))) return null;
    return {
        line,
        startCharacter: character,
        endCharacter: character + initializer[0].length,
        text: lines[line].slice(character, character + initializer[0].length)
    };
}

function compilerIgnoredDeclarationSuffixRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" || !/^Suffix ignored\b/i.test(String(diagnostic.message || ""))) return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line;
    if (!Number.isSafeInteger(line) || line < 0) return null;
    const lines = sourceLines(text);
    if (line >= lines.length) return null;
    const maskedLine = sourceLines(maskFreeBasicText(text))[line];
    if (lines[line].trim() !== maskedLine.trim()) return null;

    const reported = String(diagnostic.sourceText || diagnostic.compilerDetail || diagnostic.message || "")
        .match(/(?:in\s+['"])?([A-Za-z_][A-Za-z0-9_]*[$%!#&])['"]?/i)?.[1];
    if (!reported) return null;
    const match = maskedLine.match(/^\s*dim\s+([A-Za-z_][A-Za-z0-9_]*[$%!#&])\s+as\s+([^,=]+?)\s*$/i);
    if (match && match[1].toLowerCase() === reported.toLowerCase()) {
        const startCharacter = match[0].indexOf(match[1]);
        return {
            line,
            startCharacter,
            endCharacter: startCharacter + match[1].length,
            suffixStartCharacter: startCharacter + match[1].length - 1,
            name: lines[line].slice(startCharacter, startCharacter + match[1].length),
            suffix: match[1].at(-1),
            hasExplicitAsType: true
        };
    }

    const declarationLine = /^\s*(?:(?:public|private|protected|shared|static|common|declare|export|virtual)\s+)*(?:dim|const|sub|function|property)\b/i
        .test(maskedLine);
    if (lines[line].length > 65536 || !maskedLine.toLowerCase().includes(reported.toLowerCase())) return null;
    if (declarationLine && /\bas\b/i.test(maskedLine)) {
        const reportedTokens = [...maskedLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)]
            .filter((match) => match[0].toLowerCase() === reported.toLowerCase());
        if (reportedTokens.length !== 1) return null;
        const lineDeclarations = parseFreeBasicText(lines[line]).declarations;
        const eligibleTypes = new Set(["const", "parameter", "variable", "function", "property"]);
        const declarations = lineDeclarations.filter((declaration) =>
            eligibleTypes.has(declaration.type) && declaration.line === 0 &&
            String(declaration.name || "").toLowerCase() === reported.toLowerCase() &&
            typeof declaration.typeName === "string" && declaration.typeName.length > 0 &&
            (declaration.type !== "parameter" || declaration.parentDeclaration &&
                ["sub", "function", "property"].includes(declaration.parentDeclaration.type))
        );
        if (declarations.length === 1) {
            const declaration = declarations[0];
            const name = lines[line].slice(declaration.startColumn, declaration.endColumn);
            if (name.toLowerCase() !== reported.toLowerCase() || !/[$%!#&]$/.test(name)) return null;
            return {
                line,
                startCharacter: declaration.startColumn,
                endCharacter: declaration.endColumn,
                suffixStartCharacter: declaration.endColumn - 1,
                name,
                suffix: name.at(-1),
                hasExplicitAsType: true
            };
        }
        if (declarations.length > 1) return null;
    }
    if (declarationLine) return null;

    const suffixTokens = [...maskedLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]/g)]
        .filter((token) => token[0].toLowerCase() === reported.toLowerCase());
    if (suffixTokens.length !== 1) return null;
    const token = suffixTokens[0];
    const startCharacter = token.index;
    const endCharacter = startCharacter + token[0].length;
    return {
        line,
        startCharacter,
        endCharacter,
        suffixStartCharacter: endCharacter - 1,
        name: lines[line].slice(startCharacter, endCharacter),
        suffix: token[0].at(-1),
        hasExplicitAsType: /^\s+as\b/i.test(maskedLine.slice(endCharacter))
    };
}

function compilerImplicitParameterPassingModeRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning") return null;
    const message = String(diagnostic.message || "");
    const reported = message.match(/^No explicit BYREF or BYVAL,\s*at parameter\s+\d+\s+\(([^)\r\n]+)\)\s+of\s+/i)?.[1];
    if (!reported || reported.length > 512) return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line;
    const character = diagnostic.physicalPoint?.character;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length ||
        !Number.isSafeInteger(character) || character < 0) return null;
    const maskedLine = sourceLines(maskFreeBasicText(text))[line];
    const token = maskedLine.slice(character).match(/^([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)/)?.[1];
    if (!token || token.toLowerCase() !== reported.toLowerCase() ||
        diagnostic.sourceText && diagnostic.sourceText.toLowerCase() !== token.toLowerCase()) return null;
    return {
        line,
        startCharacter: character,
        endCharacter: character + token.length,
        name: lines[line].slice(character, character + token.length)
    };
}

function compilerImplicitVariableAllocationRange(sourceText, diagnostic) {
    if (diagnostic?.severity !== "warning" ||
        !/^Implicit variable allocation\b/i.test(String(diagnostic.message || ""))) return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line ?? diagnostic.line;
    const pointCharacter = diagnostic.physicalPoint?.character;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length ||
        lines[line].length > MAX_DIAGNOSTIC_LINE_BYTES ||
        diagnostic.physicalPoint && (!Number.isSafeInteger(pointCharacter) || pointCharacter < 0 ||
            pointCharacter > lines[line].length)) return null;
    const reported = String(diagnostic.sourceText || diagnostic.compilerDetail || "")
        .match(/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/)?.[0] ||
        String(diagnostic.message || "").match(/Implicit variable allocation(?:\s*,\s*|\s+)(?:in\s+)?['"`]?([A-Za-z_][A-Za-z0-9_]*[$%!#&]?)/i)?.[1];
    if (!reported) return null;
    const maskedLine = sourceLines(maskFreeBasicText(text))[line];
    const matches = [...maskedLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*[$%!#&]?/g)]
        .filter((match) => match[0].toLowerCase() === reported.toLowerCase());
    if (matches.length !== 1) return null;
    const match = matches[0];
    return {
        line,
        startCharacter: match.index,
        endCharacter: match.index + match[0].length,
        name: lines[line].slice(match.index, match.index + match[0].length)
    };
}

function compilerDeclarationSuffixConflictRange(sourceText, diagnostic) {
    if (diagnostic?.compilerContext !== "declaration-suffix-as-conflict") return null;
    const text = String(sourceText ?? "");
    if (text.length > MAX_CONTEXT_DIAGNOSTIC_SOURCE_LENGTH) return null;
    const line = diagnostic.physicalPoint?.line;
    const character = diagnostic.physicalPoint?.character;
    const lines = sourceLines(text);
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length ||
        !Number.isSafeInteger(character) || character < 0) return null;
    const maskedLine = sourceLines(maskFreeBasicText(text))[line];
    if (diagnostic.sourceText && maskedLine.trim() !== diagnostic.sourceText.trim()) return null;
    if (!/^\s*(?:(?:public|private|protected|shared|static|common|extern)\s+)*dim\s+as\b/i.test(maskedLine)) return null;

    const match = maskedLine.slice(character).match(/^([A-Za-z_][A-Za-z0-9_]*)([$%!#&])/);
    if (!match) return null;
    const message = String(diagnostic.message || "").split("\n\nCompiler context:")[0];
    const reportedName = message.match(/syntax error,\s*([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
    if (reportedName && reportedName.toLowerCase() !== match[1].toLowerCase()) return null;
    return {
        line,
        startCharacter: character,
        endCharacter: character + match[0].length,
        suffixStartCharacter: character + match[0].length - 1,
        name: `${match[1]}${match[2]}`,
        suffix: match[2]
    };
}

module.exports = {
    attachStructuredDiagnosticData,
    compilerDiagnosticContextLabel,
    compilerDiagnosticGuidance,
    compilerErrorResumeNextRange,
    compilerByRefFunctionResultAssignmentRange,
    compilerConstantConversionOverflowRange,
    compilerConstantConversionOverflowPointRange,
    compilerDeclarationSuffixConflictRange,
    compilerForNextCounterMismatchRange,
    compilerIgnoredDeclarationSuffixRange,
    compilerImplicitParameterPassingModeRange,
    compilerImplicitVariableAllocationRange,
    compilerLineInputBufferCapacityRange,
    compilerMissingClosingQuoteRange,
    compilerPossibleEscapeStringRange,
    compilerMeaninglessNextVariableRange,
    compilerProcedureSignatureMismatchRange,
    compilerRedundantNewAnyInitializerRange,
    compilerDoesNotSupportStructuredDiagnostics,
    decodeCompilerDiagnosticSidecar,
    forNextCounterIdentifiers,
    forNextCounterIdentifierRange,
    physicalDiagnosticRange,
    compilerForCounterWrapRange,
    compilerFunctionPointerMismatchRange,
    compilerConstQualifierWarningRange,
    compilerLargeStackWarningRange,
    compilerImplicitConversionRange,
    compilerParameterDefaultMismatchRange,
    compilerOperatorWarningTokenRange,
    compilerSuspiciousPointerAssignmentRange,
    physicalPointMatchesDiagnosticText
};

/* end of lib/compiler-diagnostic-sidecar.js */
