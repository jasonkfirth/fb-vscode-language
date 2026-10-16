/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-analysis.js
    Purpose: Obtain source-mapped, parser-visible text from the real compiler.
    Responsibilities: bound execution and validate origins and procedure bindings.
    Does not contain: simulated preprocessing, editor APIs, or compiler building.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { executeBoundedProcess, parseCompilerOutput } = require("./compiler-diagnostics");
const { createSymbolDecoder } = require("./compiler-symbols");
const { createExpressionDecoder } = require("./compiler-expressions");
const { createScopeDecoder } = require("./compiler-scopes");
const { recoveryDependentSymbols } = require("./compiler-recovery");
const { createOriginDecoder } = require("./compiler-origins");
const { createMacroDecoder } = require("./compiler-macros");
const { createPreprocessorDecoder } = require("./compiler-preprocessor");
const { compilerSemanticIfConditionResults, compilerSemanticUnreachableStatements } = require("./compiler-flow-analysis");
const { optionDisablesRemKeyword } = require("./freebasic-parser");
const { MAX_SEMANTIC_MODEL_BYTES, compilerScalarPrimitiveDtype, decodeCompilerSemanticExpressions } = require("./compiler-semantic-sidecar");
const {
    attachStructuredDiagnosticData,
    compilerDoesNotSupportStructuredDiagnostics,
    decodeCompilerDiagnosticSidecar
} = require("./compiler-diagnostic-sidecar");

const MAX_ANALYSIS_BYTES = 32 * 1024 * 1024;
const DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS = 60000;
const MAX_BINDINGS = 200000;
const MAX_LEGACY_SOURCE_BYTE_OFFSETS = 1000000;
const MAX_PHYSICAL_SOURCE_BYTE_BOUNDARIES = 1000000;
const MAX_COMPILER_REM_KEYWORD_DISABLED_STATEMENTS = 200000;
const MAX_COMPILER_REM_KEYWORD_SOURCE_LINES = 1000000;
const MAX_COMPILER_ESCAPED_STRING_RANGES = 200000;
const MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS = 100000;
/* Match the bounded editor call-query surface, not the compiler's full graph. */
const MAX_EDITOR_SEMANTIC_CONSTRUCTION_INPUTS = 5000;
const COMPOUND_ASSIGNMENT_CODES = new Set([
    "add", "subtract", "multiply", "divide", "integer-divide", "modulo", "and", "or",
    "logical-and", "logical-or", "xor", "equivalence", "implication", "shift-left",
    "shift-right", "power", "concatenate"
]);
/* These trace records have independent bounds. An expression or binding
   sidecar can still serve requests when one of the expanded trace graphs is
   too large to decode safely. */
const TRACE_DECODER_LIMIT_ERRORS = new Set([
    "Compiler symbol records exceeded 200000 entries.",
    "Compiler scope/inventory records exceeded 200000 entries.",
    "Compiler token origins exceeded their 200000-token limit.",
    "Compiler macro map records exceeded 200000 entries.",
    "Compiler expression family records exceeded 200000.",
    "Compiler expression graph exceeded 200000 nodes.",
    "Compiler analysis exceeded its 200000-expression limit.",
    "Compiler analysis exceeded its 200000-binding limit.",
    "Compiler recovery records exceeded their limit."
]);
/* FreeBASIC's FB_ERRMSG_EXPECTEDEXPRESSION marks an incomplete syntax prefix. */
const EXPECTED_EXPRESSION_ERROR_CODE = 9;
const VALUE_OPTIONS = new Set(["-i", "-d", "-include", "-lang", "-forcelang", "-target", "-arch", "-gen", "-prefix", "-w", "-m"]);
const FLAG_OPTIONS = new Set(["-mt", "-gfx3", "-g", "-exx", "-e", "-ex", "-fbgfx", "-fbsfx", "-semantic-model-compact"]);
const COMPILER_EXPRESSION_DIRECTIVE = /^\s*#\s*(?:if|elseif|assert)\b/i;

function compilerPathKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sourceTextForAnalysis(filePath, overlays) {
    if (overlays?.has(filePath)) return overlays.get(filePath);
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ANALYSIS_BYTES) return null;
    return decodeCompilerSourceBuffer(fs.readFileSync(filePath), filePath);
}

function compilerDirectiveLineMap(filePath, overlays) {
    const candidates = [...new Set([filePath, ...(overlays?.keys() || [])])];
    const result = new Map();
    let inspectedBytes = 0;
    for (const candidate of candidates) {
        const text = sourceTextForAnalysis(candidate, overlays);
        if (text === null) continue;
        inspectedBytes += Buffer.byteLength(text, "utf8");
        if (inspectedBytes > MAX_ANALYSIS_BYTES) break;
        const lines = new Set();
        for (const [index, line] of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).entries()) {
            if (COMPILER_EXPRESSION_DIRECTIVE.test(line)) lines.add(index + 1);
        }
        if (lines.size) result.set(compilerPathKey(candidate), lines);
    }
    return result;
}

function hasCompilerExpressionDirective(filePath, overlays) {
    const candidates = [...new Set([filePath, ...(overlays?.keys() || [])])];
    let inspectedBytes = 0;
    for (const candidate of candidates) {
        try {
            const text = sourceTextForAnalysis(candidate, overlays);
            if (text === null) continue;
            inspectedBytes += Buffer.byteLength(text, "utf8");
            if (inspectedBytes > MAX_ANALYSIS_BYTES) return false;
            if (text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).some((line) => COMPILER_EXPRESSION_DIRECTIVE.test(line))) return true;
        } catch { /* Sidecar facts are optional; ordinary analysis remains authoritative. */ }
    }
    return false;
}

function decodeCompilerSourceBuffer(buffer, filePath = "<source>") {
    if (!Buffer.isBuffer(buffer)) throw new Error("Compiler source must be provided as bytes.");
    const startsWith = (...bytes) => buffer.length >= bytes.length && bytes.every((value, index) => buffer[index] === value);
    const decodeUtf16 = (contents, encoding, byteSwap = false) => {
        if (contents.length % 2 !== 0) throw new Error(`Malformed ${encoding} compiler source: ${filePath}`);
        const decodedContents = byteSwap ? Buffer.from(contents).swap16() : contents;
        const text = decodedContents.toString("utf16le");
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            if (code >= 0xd800 && code <= 0xdbff) {
                const next = text.charCodeAt(index + 1);
                if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`Malformed ${encoding} compiler source: ${filePath}`);
                index++;
            } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error(`Malformed ${encoding} compiler source: ${filePath}`);
        }
        if (!Buffer.from(text, "utf16le").equals(decodedContents)) throw new Error(`Malformed ${encoding} compiler source: ${filePath}`);
        if (text.includes("\0")) throw new Error(`Compiler source contains a NUL character: ${filePath}`);
        return `\uFEFF${text}`;
    };
    if (startsWith(0xff, 0xfe, 0x00, 0x00)) {
        return decodeUtf32(buffer.subarray(4), "UTF-32LE", false, filePath);
    }
    if (startsWith(0x00, 0x00, 0xfe, 0xff)) {
        return decodeUtf32(buffer.subarray(4), "UTF-32BE", true, filePath);
    }
    if (startsWith(0xfe, 0xff)) return decodeUtf16(buffer.subarray(2), "UTF-16BE", true);
    if (startsWith(0xff, 0xfe)) return decodeUtf16(buffer.subarray(2), "UTF-16LE");
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) {
        if (startsWith(0xef, 0xbb, 0xbf)) throw new Error(`Malformed UTF-8 compiler source: ${filePath}`);
        return decodeUnmarkedCompilerBytes(buffer, filePath);
    }
    if (text.includes("\0")) throw new Error(`Compiler source contains a NUL character: ${filePath}`);
    return text;
}

function decodeUnmarkedCompilerBytes(buffer, filePath) {
    /* Valid UTF-8 stays Unicode; an unmarked legacy byte falls back one byte per column. */
    const chunks = [];
    let codeUnits = [];
    const flush = () => {
        if (codeUnits.length) {
            chunks.push(String.fromCharCode(...codeUnits));
            codeUnits = [];
        }
    };
    for (let offset = 0; offset < buffer.length;) {
        const decoded = readSemanticUtf8CodePoint(buffer, offset, filePath, true);
        if (decoded.value <= 0xffff) codeUnits.push(decoded.value);
        else {
            const supplementary = decoded.value - 0x10000;
            codeUnits.push(0xd800 + (supplementary >> 10), 0xdc00 + (supplementary & 0x3ff));
        }
        offset += decoded.bytes;
        if (codeUnits.length >= 4096) flush();
    }
    flush();
    const text = chunks.join("");
    if (text.includes("\0")) throw new Error(`Compiler source contains a NUL character: ${filePath}`);
    return text;
}

function unmarkedLegacySourceByteOffsets(buffer, filePath) {
    const startsWith = (...bytes) => buffer.length >= bytes.length && bytes.every((value, index) => buffer[index] === value);
    if (startsWith(0xef, 0xbb, 0xbf) || startsWith(0xff, 0xfe) || startsWith(0xfe, 0xff) ||
        startsWith(0xff, 0xfe, 0x00, 0x00) || startsWith(0x00, 0x00, 0xfe, 0xff)) return null;

    const offsets = [];
    for (let offset = 0; offset < buffer.length;) {
        const decoded = readSemanticUtf8CodePoint(buffer, offset, filePath, true);
        if (decoded.singleByteFallback) {
            if (offsets.length >= MAX_LEGACY_SOURCE_BYTE_OFFSETS) {
                throw new Error(`Compiler source has more than ${MAX_LEGACY_SOURCE_BYTE_OFFSETS} legacy bytes to map: ${filePath}`);
            }
            offsets.push(offset);
        }
        offset += decoded.bytes;
    }
    return offsets.length ? offsets : null;
}

function compilerPhysicalSourceByteOffsets(analysis, compilerTexts) {
    const boundariesByFile = new Map();
    const addBoundaries = (filePath, start, end) => {
        if (!filePath || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return;
        const key = compilerPathKey(filePath);
        if (compilerTexts.has(key)) return;
        let entry = boundariesByFile.get(key);
        if (!entry) {
            entry = { filePath, boundaries: new Set() };
            boundariesByFile.set(key, entry);
        }
        entry.boundaries.add(start);
        entry.boundaries.add(end);
    };

    for (const token of analysis.tokenOrigins || []) {
        if (token.kind === "source") addBoundaries(token.filePath, token.sourceStart, token.sourceEnd);
    }
    for (const node of analysis.macroGraph?.nodes || []) {
        if (node.kind === "source") addBoundaries(node.filePath, node.sourceStart, node.sourceEnd);
    }

    let boundaryCount = 0;
    for (const entry of boundariesByFile.values()) {
        boundaryCount += entry.boundaries.size;
        if (boundaryCount > MAX_PHYSICAL_SOURCE_BYTE_BOUNDARIES) {
            throw new Error("Compiler physical source boundary mapping exceeded 1000000 coordinates.");
        }
    }

    let sourceBytesScanned = 0;
    let legacyByteCount = 0;
    const result = new Map();
    for (const [key, entry] of boundariesByFile) {
        if (!fs.existsSync(entry.filePath)) continue;
        const stat = fs.statSync(entry.filePath);
        sourceBytesScanned += stat.size;
        if (stat.size > MAX_ANALYSIS_BYTES || sourceBytesScanned > MAX_ANALYSIS_BYTES) {
            throw new Error("Compiler physical source mapping exceeded 32 MiB.");
        }
        const buffer = fs.readFileSync(entry.filePath);
        const legacyByteOffsets = unmarkedLegacySourceByteOffsets(buffer, entry.filePath);
        if (!legacyByteOffsets) continue;
        legacyByteCount += legacyByteOffsets.length;
        if (legacyByteCount > MAX_LEGACY_SOURCE_BYTE_OFFSETS) {
            throw new Error(`Compiler physical source mapping exceeded ${MAX_LEGACY_SOURCE_BYTE_OFFSETS} legacy bytes.`);
        }

        const sortedBoundaries = [...entry.boundaries].sort((first, second) => first - second);
        const mappedBoundaries = new Map();
        let low = 0;
        for (const boundary of sortedBoundaries) {
            if (boundary < 0 || boundary > buffer.length) throw new Error(`Compiler physical source boundary is outside its file: ${entry.filePath}`);
            while (low < legacyByteOffsets.length && legacyByteOffsets[low] < boundary) low++;
            mappedBoundaries.set(boundary, boundary + low);
        }
        result.set(key, { byteLength: buffer.length, positions: mappedBoundaries });
    }
    return result;
}

function decodeCompilerOutputBuffer(buffer) {
    const text = buffer.toString("utf8");
    if (Buffer.from(text, "utf8").equals(buffer)) return { text, legacyByteOffsetsByLine: null };

    const lines = [];
    const byteOffsetsByLine = [];
    let lineStart = 0;
    let offset = 0;
    while (offset < buffer.length) {
        if (buffer[offset] !== 0x0a && buffer[offset] !== 0x0d) {
            offset++;
            continue;
        }

        const line = decodeUnmarkedCompilerLine(buffer.subarray(lineStart, offset));
        lines.push(line.text);
        byteOffsetsByLine.push(line.legacyByteOffsets);
        if (buffer[offset] === 0x0d && buffer[offset + 1] === 0x0a) {
            lines.push("\r\n");
            offset += 2;
        } else {
            lines.push(String.fromCharCode(buffer[offset]));
            offset++;
        }
        lineStart = offset;
    }

    const lastLine = decodeUnmarkedCompilerLine(buffer.subarray(lineStart));
    lines.push(lastLine.text);
    byteOffsetsByLine.push(lastLine.legacyByteOffsets);
    return {
        text: lines.join(""),
        legacyByteOffsetsByLine: byteOffsetsByLine.some(Boolean) ? byteOffsetsByLine : null
    };
}

function decodeUnmarkedCompilerLine(buffer) {
    const chunks = [];
    const legacyByteOffsets = [];
    let codeUnits = [];
    const flush = () => {
        if (codeUnits.length) {
            chunks.push(String.fromCharCode(...codeUnits));
            codeUnits = [];
        }
    };

    for (let offset = 0; offset < buffer.length;) {
        const decoded = readSemanticUtf8CodePoint(buffer, offset, "<compiler output>", true);
        if (decoded.singleByteFallback) legacyByteOffsets.push(offset);
        if (decoded.value <= 0xffff) codeUnits.push(decoded.value);
        else {
            const supplementary = decoded.value - 0x10000;
            codeUnits.push(0xd800 + (supplementary >> 10), 0xdc00 + (supplementary & 0x3ff));
        }
        offset += decoded.bytes;
        if (codeUnits.length >= 4096) flush();
    }

    flush();
    return { text: chunks.join(""), legacyByteOffsets: legacyByteOffsets.length ? legacyByteOffsets : null };
}

function decodeUtf32(contents, encoding, byteSwap = false, filePath = "<source>") {
    if (contents.length % 4 !== 0) throw new Error(`Malformed ${encoding} compiler source: ${filePath}`);
    const characters = [];
    let chunk = "";
    for (let offset = 0; offset < contents.length; offset += 4) {
        const codePoint = byteSwap ? contents.readUInt32BE(offset) : contents.readUInt32LE(offset);
        if (codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff) {
            throw new Error(`Malformed ${encoding} compiler source: ${filePath}`);
        }
        chunk += String.fromCodePoint(codePoint);
        if (chunk.length >= 4096) {
            characters.push(chunk);
            chunk = "";
        }
    }
    characters.push(chunk);
    const text = characters.join("");
    if (text.includes("\0")) throw new Error(`Compiler source contains a NUL character: ${filePath}`);
    return `\uFEFF${text}`;
}

function analysisArguments(arguments_ = []) {
    if (!Array.isArray(arguments_)) throw new Error("Compiler analysis arguments must be an array.");
    const result = [];
    for (let index = 0; index < arguments_.length; index++) {
        const option = arguments_[index];
        if (FLAG_OPTIONS.has(option)) result.push(option);
        else if (VALUE_OPTIONS.has(option)) {
            const value = arguments_[++index];
            if (typeof value !== "string" || !value || value.includes("\0") || value.startsWith("-")) throw new Error(`Missing analysis argument for ${option}.`);
            result.push(option, value);
        } else throw new Error(`Compiler analysis does not accept ${String(option)}. Use only language, target, define, and include options.`);
    }
    return result;
}

function compilerMissingIncludeState(analysis, buffers) {
    const names = new Set();
    for (const outcome of analysis.semanticIncludeOutcomes || []) {
        if (outcome.outcome !== "not-found" || typeof outcome.requested !== "string") continue;
        const name = path.posix.basename(outcome.requested.replace(/\\/g, "/")).toLowerCase();
        if (name) names.add(name);
    }
    if (!names.size) return null;
    /* Names only trigger conservative cache expiry. FBC must decide whether a
       newly available buffer actually satisfies the failed include. Remember
       inputs already present so an unrelated same-named file cannot loop. */
    const inputs = new Set();
    for (const file of [...(analysis.dependencies || []), ...buffers.keys()]) {
        if (names.has(path.basename(file).toLowerCase())) inputs.add(file);
    }
    const bytes = [...names, ...inputs].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    return { names, inputs, bytes };
}

function decodePreprocessed(source, cwd, checkCancelled = () => {}, legacyByteOffsetsByLine = null) {
    const lines = source.split(/\r\n|\n|\r/);
    const origins = [];
    let origin = null;
    let records = 0;
    let protocolVersion = 1;
    let outputLine = null;
    const outputLines = new Map();
    const bindings = [];
    const expressions = [];
    const receivers = [];
    const nonRenameable = new Set();
    const dependencies = new Set();
    const fileIdentities = new Map();
    const invalidRegions = [];
    const errorOrigins = new Set();
    const errorPositions = [];
    let completion = null;
    function decodeHex(value, label) {
        const buffer = Buffer.from(value, "hex");
        const text = buffer.toString("utf8");
        if (!value || value.length % 2 || text.includes("\0") || !Buffer.from(text).equals(buffer)) throw new Error(`Invalid compiler ${label}.`);
        return text;
    }
    function integer(value, minimum = 0) {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < minimum) throw new Error("Invalid compiler binding coordinate or identity.");
        return number;
    }
    const symbolDecoder = createSymbolDecoder(decodeHex, integer);
    const expressionDecoder = createExpressionDecoder(decodeHex, integer);
    const scopeDecoder = createScopeDecoder(decodeHex, integer);
    const originDecoder = createOriginDecoder(decodeHex, integer, cwd);
    const macroDecoder = createMacroDecoder(integer);
    const preprocessorDecoder = createPreprocessorDecoder(decodeHex, integer);
    for (let line = 0; line < lines.length; line++) {
        // Worker cancellation uses a shared flag, since a message callback
        // cannot run while this synchronous decoder is processing a trace.
        if (line % 256 === 0) checkCancelled();
        if (completion && lines[line].trim()) throw new Error("Compiler records follow the terminal marker.");
        if (symbolDecoder.read(lines[line])) { lines[line] = ""; continue; }
        if (expressionDecoder.read(lines[line])) { lines[line] = ""; continue; }
        if (scopeDecoder.read(lines[line])) { lines[line] = ""; continue; }
        if (originDecoder.read(lines[line])) { lines[line] = ""; continue; }
        if (macroDecoder.read(lines[line])) { lines[line] = ""; continue; }
        if (preprocessorDecoder.read(lines[line])) { lines[line] = ""; continue; }
        const ending = lines[line].match(/^''@fb-editor-end (\d+) ([01])$/);
        if (ending) {
            completion = { errorCount: integer(ending[1]), reachedEnd: ending[2] === "1" };
            lines[line] = "";
            continue;
        }
        const invalid = lines[line].match(/^''@fb-editor-invalid (\d+) (\d+)$/);
        const errorOrigin = lines[line].match(/^''@fb-editor-error (\d+) ([a-f\d]+)(?: (-?\d+)(?: (\d+) (\d+))?)?$/i);
        if (invalid || errorOrigin) {
            if (invalid) {
                const first = integer(invalid[1], 1), last = integer(invalid[2], 1);
                if (last < first) throw new Error("Invalid compiler recovery region.");
                invalidRegions.push({ first, last });
            } else {
                const sourceFile = path.resolve(cwd, decodeHex(errorOrigin[2], "error origin"));
                const sourceLine = integer(errorOrigin[1], 1) - 1;
                errorOrigins.add(`${sourceFile}:${sourceLine}`);
                if (errorOrigin[4] !== undefined) {
                    errorPositions.push({
                        sourceFile,
                        sourceLine,
                        code: integer(errorOrigin[3], -2147483648),
                        serial: integer(errorOrigin[4], 1),
                        byteColumn: integer(errorOrigin[5])
                    });
                }
            }
            if (invalidRegions.length + errorOrigins.size > MAX_BINDINGS) throw new Error("Compiler recovery records exceeded their limit.");
            lines[line] = "";
            continue;
        }
        const restricted = lines[line].match(/^''@fb-editor-norename (\d+)$/);
        if (restricted) {
            nonRenameable.add(integer(restricted[1], 1));
            lines[line] = "";
            continue;
        }
        if (/^''@fb-editor-protocol (?:[2-9]|1[0-4])$/.test(lines[line])) {
            protocolVersion = Number(lines[line].split(" ").at(-1));
            lines[line] = "";
            continue;
        }
        const expression = lines[line].match(/^''@fb-editor-type (\d+) (\d+) (\d+) (\d+) ([a-f\d]+)(?: (-?\d+) (\d+))?$/i);
        const receiver = lines[line].match(/^''@fb-editor-receiver (\d+) (\d+) ([a-f\d]+)(?: (-?\d+) (\d+))?$/i);
        if (expression || receiver) {
            if (expression) expressions.push({ startSerial: integer(expression[1], 1), startByte: integer(expression[2]), endSerial: integer(expression[3], 1), endByte: integer(expression[4]), typeName: decodeHex(expression[5], "expression type") });
            else receivers.push({ startSerial: integer(receiver[1], 1), startByte: integer(receiver[2]), typeName: decodeHex(receiver[3], "receiver type") });
            const typeRecord = expression ? expressions.at(-1) : receivers.at(-1);
            const typeFields = expression ? expression.slice(6) : receiver.slice(4);
            if (typeFields[0] !== undefined) Object.assign(typeRecord, { dtype: integer(typeFields[0], -2147483648), subtype: integer(typeFields[1]) });
            if (expressions.length + receivers.length > MAX_BINDINGS) throw new Error("Compiler analysis exceeded its 200000-expression limit.");
            lines[line] = "";
            continue;
        }
        const indexedFile = lines[line].match(/^''@fb-editor-file-v10 (\d+) ([a-f\d]+)$/i);
        const dependency = indexedFile ? [indexedFile[0], indexedFile[2]] : lines[line].match(/^''@fb-editor-file ([a-f\d]+)$/i);
        if (dependency) {
            const file = decodeHex(dependency[1], "dependency path");
            const resolved = path.resolve(cwd, file);
            dependencies.add(resolved);
            if (indexedFile) {
                const id = integer(indexedFile[1], 1);
                if (id > 5000 || fileIdentities.has(id) && fileIdentities.get(id) !== resolved) throw new Error("Invalid compiler physical file identity.");
                fileIdentities.set(id, resolved);
            }
            if (dependencies.size > 5000) throw new Error("Compiler analysis exceeded its 5000-source limit.");
            lines[line] = "";
            continue;
        }
        const binding = lines[line].match(/^''@fb-editor-bind (declaration|call) (\d+) (\d+) (\d+) ([a-f\d]+)$/i);
        if (binding) {
            const kind = binding[1].toLowerCase();
            bindings.push({ kind, outputLine: integer(binding[2], 1), byteColumn: integer(binding[3]), id: integer(binding[4], kind === "declaration" ? 1 : 0), name: decodeHex(binding[5], "binding spelling") });
            if (bindings.length > MAX_BINDINGS) throw new Error("Compiler analysis exceeded its 200000-binding limit.");
            lines[line] = "";
            continue;
        }
        const serialMarker = lines[line].match(/^''@fb-editor-v2 (\d+) (\d+) ([01]) ([a-f\d]*)$/i);
        const marker = serialMarker ? [serialMarker[0], ...serialMarker.slice(2)] : lines[line].match(/^''@fb-editor-v1 (\d+) ([01]) ([a-f\d]*)$/i);
        if (marker) {
            const file = decodeHex(marker[3], "source origin");
            const sourceLine = Number(marker[1]) - 1;
            if (!Number.isSafeInteger(sourceLine) || sourceLine < 0 || origin) throw new Error("Invalid compiler source origin.");
            origin = { filePath: path.resolve(cwd, file), line: sourceLine, generated: marker[2] === "1" };
            outputLine = serialMarker ? integer(serialMarker[1], 1) : null;
            records++;
            lines[line] = "";
        } else {
            if (lines[line].startsWith("''@fb-editor-")) throw new Error("Invalid or unsupported compiler editor record. Rebuild the compiler bridge.");
            origins[line] = origin;
            if (outputLine !== null) {
                if (outputLines.has(outputLine)) throw new Error("Duplicate compiler output line.");
                outputLines.set(outputLine, line);
            }
            origin = null;
            outputLine = null;
        }
    }
    if (origin) throw new Error("Invalid compiler source origin without an output line.");
    if (!completion && (protocolVersion >= 4 || originDecoder.hasTokens() || protocolVersion === 1 && outputLines.size > 0)) throw new Error("The compiler did not finish writing its analysis snapshot.");
    if (!records && !dependencies.size) throw new Error("This compiler did not emit editor source origins. Build the optional compiler bridge and configure freebasic.analysis.compilerPath.");
    const positions = new Set();
    for (const binding of bindings) {
        const line = outputLines.get(binding.outputLine);
        if (line === undefined) throw new Error("Compiler binding refers to a missing output line.");
        const mappedPosition = compilerOutputBytePosition(lines[line], binding.byteColumn, legacyByteOffsetsByLine?.[line]);
        /* fbc counts emitted bytes; VS Code counts UTF-16 code units. Verify the
           boundary and spelling before trusting any navigation coordinate. */
        if (!mappedPosition || lines[line].slice(mappedPosition.column, mappedPosition.column + binding.name.length).toLowerCase() !== binding.name.toLowerCase()) throw new Error("Compiler binding does not match its output token.");
        const column = mappedPosition.column;
        const key = `${line}:${column}`;
        if (positions.has(key)) throw new Error("Duplicate compiler binding position.");
        positions.add(key);
        binding.line = line;
        binding.startColumn = column;
        binding.endColumn = column + binding.name.length;
    }
    function position(serial, byte) {
        const line = outputLines.get(serial);
        if (line === undefined) throw new Error("Compiler type refers to a missing output line.");
        const mappedPosition = compilerOutputBytePosition(lines[line], byte, legacyByteOffsetsByLine?.[line]);
        if (!mappedPosition) throw new Error("Invalid compiler expression boundary.");
        return { line, character: mappedPosition.column };
    }
    for (const expression of expressions) {
        expression.start = position(expression.startSerial, expression.startByte);
        expression.end = position(expression.endSerial, expression.endByte);
        if (expression.end.line < expression.start.line || expression.end.line === expression.start.line && expression.end.character <= expression.start.character) throw new Error("Invalid compiler expression range.");
    }
    for (const receiver of receivers) receiver.start = position(receiver.startSerial, receiver.startByte);
    const invalidLines = new Set();
    /* Serial intervals are emitted after parser recovery, so they also retract
       facts emitted earlier in the failed statement. Merge intervals once to
       avoid multiplying source size by the number of reported errors. */
    const regions = invalidRegions.sort((a, b) => a.first - b.first);
    const merged = [];
    for (const region of regions) {
        const previous = merged.at(-1);
        if (previous && region.first <= previous.last + 1) previous.last = Math.max(previous.last, region.last);
        else merged.push({ ...region });
    }
    let regionIndex = 0;
    for (const [serial, line] of [...outputLines].sort((a, b) => a[0] - b[0])) {
        while (merged[regionIndex]?.last < serial) regionIndex++;
        const origin = origins[line];
        if (merged[regionIndex]?.first <= serial || origin && errorOrigins.has(`${origin.filePath}:${origin.line}`)) invalidLines.add(line);
    }
    const invalidSorted = [...invalidLines].sort((a, b) => a - b);
    const positionedErrors = new Map();
    for (const error of errorPositions) {
        const line = outputLines.get(error.serial);
        if (line === undefined) continue;
        const mappedPosition = compilerOutputBytePosition(lines[line], error.byteColumn, legacyByteOffsetsByLine?.[line]);
        if (!mappedPosition) continue;
        const previous = positionedErrors.get(error.serial);
        if (!previous || error.byteColumn < previous.byteColumn) positionedErrors.set(error.serial, error);
    }
    const recoveryRegions = merged.map((region) => {
        let error = null;
        for (const candidate of positionedErrors.values()) {
            /* Only an incomplete-expression diagnostic proves that a completed
               AST prefix before the cursor was not itself rejected. Semantic
               and other parser errors retain whole-region invalidation. */
            if (candidate.code !== EXPECTED_EXPRESSION_ERROR_CODE) continue;
            if (candidate.serial < region.first || candidate.serial > region.last) continue;
            if (!error || candidate.serial < error.serial ||
                candidate.serial === error.serial && candidate.byteColumn < error.byteColumn) error = candidate;
        }
        return { ...region, error };
    });
    const orphanErrors = [];
    for (const [serial, line] of outputLines) {
        if (!invalidLines.has(line)) continue;
        const origin = origins[line];
        if (!origin || !errorOrigins.has(`${origin.filePath}:${origin.line}`)) continue;
        let belongsToRegion = false;
        for (const region of recoveryRegions) {
            if (region.first <= serial && serial <= region.last) {
                belongsToRegion = true;
                break;
            }
        }
        if (!belongsToRegion) {
            const error = positionedErrors.get(serial);
            orphanErrors.push({ serial, error: error?.code === EXPECTED_EXPRESSION_ERROR_CODE ? error : null });
        }
    }
    orphanErrors.sort((left, right) => left.serial - right.serial);
    const intersectsInvalid = (range) => {
        const { startSerial, endSerial, endByte } = range;
        let low = 0, high = recoveryRegions.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (recoveryRegions[middle].last < startSerial) low = middle + 1;
            else high = middle;
        }
        let checkedRegions = 0;
        for (let index = low; index < recoveryRegions.length && recoveryRegions[index].first <= endSerial; index++) {
            const region = recoveryRegions[index];
            if (!region.error || endSerial > region.error.serial ||
                endSerial === region.error.serial && endByte >= region.error.byteColumn) return true;
            /* Huge expressions crossing many independent failed statements
               fall back to withholding rather than making recovery quadratic. */
            if (++checkedRegions > 256) return true;
        }

        low = 0;
        high = orphanErrors.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (orphanErrors[middle].serial < startSerial) low = middle + 1;
            else high = middle;
        }
        for (let index = low; index < orphanErrors.length && orphanErrors[index].serial <= endSerial; index++) {
            const orphan = orphanErrors[index];
            if (!orphan.error || endSerial > orphan.serial || endByte >= orphan.error.byteColumn) return true;
        }
        return false;
    };
    checkCancelled();
    /* Keep ordinary UTF-8 trace decoding on its original fast path. */
    const mapOutputBytePosition = legacyByteOffsetsByLine?.some(Boolean)
        ? (line, byteColumn) => compilerOutputBytePosition(lines[line], byteColumn, legacyByteOffsetsByLine[line])
        : undefined;
    const symbolGraph = symbolDecoder.finish(outputLines, lines, invalidLines, protocolVersion, mapOutputBytePosition);
    checkCancelled();
    const scopeGraph = scopeDecoder.finish(position, lines, outputLines, symbolGraph, invalidLines, completion, protocolVersion);
    checkCancelled();
    const recoverySymbols = recoveryDependentSymbols(symbolGraph, scopeGraph);
    const expressionGraph = expressionDecoder.finish(position, intersectsInvalid, symbolGraph, new Set(recoverySymbols));
    checkCancelled();
    const tokenOrigins = originDecoder.finish(position, dependencies, invalidLines, fileIdentities, protocolVersion);
    checkCancelled();
    const macroGraph = macroDecoder.finish(dependencies, symbolGraph, tokenOrigins, fileIdentities);
    checkCancelled();
    const preprocessorGraph = preprocessorDecoder.finish(symbolGraph, macroGraph, tokenOrigins, protocolVersion);
    const symbolIds = new Set(symbolGraph.symbols.map((symbol) => symbol.id));
    for (const expression of [...expressions, ...receivers]) {
        if (expression.subtype && !symbolIds.has(expression.subtype)) throw new Error("Compiler expression refers to a missing type identity.");
        if (protocolVersion >= 5 && expression.dtype === undefined) throw new Error("Compiler expression has no native type identity.");
    }
    return {
        text: lines.join("\n"), origins, dependencies: [...dependencies],
        bindings: bindings.filter((binding) => !invalidLines.has(binding.line)),
        expressions: expressions.filter((expression) => !intersectsInvalid(expression)),
        receivers: receivers.filter((receiver) => !invalidLines.has(receiver.start.line)),
        /* Member lookup selects its receiver before checking the member name.
           Keep that decision for completion only, not expression authority or
           symbol resolution in the retracted statement. */
        completionReceivers: receivers.filter((receiver) => invalidLines.has(receiver.start.line)),
        symbolGraph, expressionGraph, scopeGraph, tokenOrigins, macroGraph, preprocessorGraph, recoverySymbols,
        errorPositions: [...positionedErrors.values()],
        nonRenameable: [...nonRenameable], protocolVersion, completion, invalidLines: invalidSorted
    };
}

function writeOverlays(directory, overlays = new Map()) {
    if (!(overlays instanceof Map) || overlays.size > 5000) throw new Error("Compiler overlays require at most 5000 named buffers.");
    const manifest = [];
    const identities = new Map();
    const compilerTexts = new Map();
    let bytes = 0;
    for (const [file, text] of overlays) {
        if (!path.isAbsolute(file) || /[\0\r\n\t]/.test(file) || typeof text !== "string") throw new Error("Invalid compiler overlay path or text.");
        if (Buffer.from(text, "utf8").toString("utf8") !== text) throw new Error("Compiler overlays cannot encode an unmatched UTF-16 surrogate.");
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler overlays exceeded 32 MiB.");
        let content = text;
        if (fs.existsSync(file)) {
            if (fs.statSync(file).size > MAX_ANALYSIS_BYTES) throw new Error("Compiler overlay source exceeds 32 MiB.");
            const original = fs.readFileSync(file);
            const identity = fs.realpathSync(file);
            if (identities.has(identity) && identities.get(identity) !== text) throw new Error("Conflicting editor buffers refer to the same physical file.");
            identities.set(identity, text);
            /* VS Code text is Unicode, so a valid BOM-marked UTF-16LE file can
               be normalized to UTF-8 without changing its source characters. */
            const originalText = decodeCompilerSourceBuffer(original, file);
            if (originalText.startsWith("\uFEFF") && !content.startsWith("\uFEFF")) content = "\uFEFF" + content;
        }
        compilerTexts.set(compilerPathKey(file), content);
        const backing = path.join(directory, `buffer-${manifest.length}.bas`);
        fs.writeFileSync(backing, content, "utf8");
        manifest.push(`${path.normalize(file)}\t${backing}`);
    }
    const manifestPath = path.join(directory, "overlays.tsv");
    fs.writeFileSync(manifestPath, manifest.join("\n"), "utf8");
    return { manifestPath, identities, compilerTexts };
}

function semanticSourcePathNames(options) {
    if (!Array.isArray(options.semanticSourceFiles)) return null;
    const files = new Map();
    for (const file of [options.filePath, ...options.semanticSourceFiles]) {
        if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n\t]/.test(file)) {
            throw new Error("Semantic source filters require absolute, single-line source paths.");
        }
        const resolved = path.resolve(file);
        files.set(compilerPathKey(resolved), resolved);
        try {
            const realPath = fs.realpathSync(resolved);
            files.set(compilerPathKey(realPath), realPath);
        } catch { /* Unsaved overlay paths use their absolute spelling. */ }
    }
    if (files.size > 5000) throw new Error("Semantic source filters exceeded 5000 files.");
    return [...files.values()];
}

function compilerSemanticSourcePathKeys(options) {
    const names = semanticSourcePathNames(options);
    return names ? new Set(names.map(compilerPathKey)) : null;
}

function writeSemanticSourceFilter(directory, options) {
    const files = semanticSourcePathNames(options);
    if (!files) return "";
    const filterPath = path.join(directory, "semantic-source-filter.hex");
    fs.writeFileSync(filterPath, files.map((file) => Buffer.from(file, "utf8").toString("hex")).join("\n"), "ascii");
    return filterPath;
}

const ANALYSIS_OUTPUT_LIMIT_ERROR = "Compiler analysis exceeded its 32 MiB output limit.";

async function executeAnalysisPass(options, execute, settings) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let tooLarge = false;
    let semanticModelTooLarge = false;
    const semanticDiagnosticsPath = settings.semanticModelPath && !options.disableStructuredDiagnostics
        ? `${settings.semanticModelPath}.fbcdia`
        : "";
    /* -pp writes a file, not stdout. Bound that channel as well as diagnostics. */
    const monitor = setInterval(() => {
        try {
            if (fs.statSync(settings.outputPath).size > MAX_ANALYSIS_BYTES) {
                tooLarge = true;
                controller.abort();
            }
        } catch { /* The compiler has not opened its output yet. */ }
        if (settings.limitSemanticModel && settings.semanticModelPath) {
            try {
                if (fs.statSync(settings.semanticModelPath).size > MAX_SEMANTIC_MODEL_BYTES) {
                    semanticModelTooLarge = true;
                    controller.abort();
                }
            } catch { /* The compiler has not opened its sidecar yet. */ }
        }
    }, 50);
    try {
        const result = await execute({
            command: options.compilerPath,
            arguments: [...analysisArguments(options.compilerArguments), ...(settings.compactSemanticMacros ? ["-semantic-model-compact"] : []), ...(settings.semanticModelPath ? [
                settings.semanticModelMode === "full" ? "-semantic-model" :
                    settings.semanticModelMode === "bindings" ? "-semantic-model-bindings" :
                        "-semantic-model-expressions",
                settings.semanticModelPath
            ] : []), ...(semanticDiagnosticsPath ? ["-semantic-diagnostics", semanticDiagnosticsPath] : []),
            "-z", "nocmdline", "-pp", "-maxerr", "50", "-o", settings.outputPath, options.filePath],
            cwd: path.dirname(options.filePath),
            env: {
                ...(options.environment || process.env),
                FB_VSCODE_TRACE: settings.trace ? "1" : "0",
                FB_VSCODE_OVERLAY: settings.manifestPath,
                FB_VSCODE_OVERLAY_ONLY: settings.trace ? "0" : "1",
                FB_VSCODE_SEMANTIC_SOURCE_FILTER: settings.semanticSourceFilterPath || ""
            },
            signal: controller.signal,
            timeoutMs: options.timeoutMs || DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS,
            maxOutputBytes: 2 * 1024 * 1024
        });
        const compilerOutput = [result.stdout, result.stderr].join("\n");
        if (semanticDiagnosticsPath && compilerDoesNotSupportStructuredDiagnostics(compilerOutput)) {
            const error = new Error("This compiler does not support the structured diagnostic sidecar.");
            error.semanticDiagnosticsUnsupported = true;
            throw error;
        }
        if (tooLarge || (fs.existsSync(settings.outputPath) && fs.statSync(settings.outputPath).size > MAX_ANALYSIS_BYTES)) {
            throw new Error(ANALYSIS_OUTPUT_LIMIT_ERROR);
        }
        if (semanticModelTooLarge || (settings.limitSemanticModel && settings.semanticModelPath && fs.existsSync(settings.semanticModelPath) && fs.statSync(settings.semanticModelPath).size > MAX_SEMANTIC_MODEL_BYTES)) {
            throw new Error("Compiler semantic sidecar exceeded 64 MiB.");
        }
        if (result.cancelled || result.timedOut) throw new Error(result.timedOut ? "Compiler analysis timed out." : "Compiler analysis was cancelled.");
        if (result.outputTruncated || result.signal) throw new Error("Compiler analysis did not finish with complete diagnostic output.");
        if (result.exitCode !== 0) {
            const hasSourceErrors = parseCompilerOutput(compilerOutput).some((diagnostic) => diagnostic.severity === "error");
            if (settings.semanticModelMode === "full" && /error: semantic model failure:/i.test(compilerOutput) && !hasSourceErrors) {
                const error = new Error("The compiler reached a bound while exporting its full semantic model.");
                error.compilerSemanticModelFailure = true;
                throw error;
            }
            if (!options.allowErrors) throw new Error(`Compiler analysis requires valid source:\n${result.stdout}\n${result.stderr}`.trim());
        }
        if (!fs.existsSync(settings.outputPath)) throw new Error(`Compiler analysis produced no snapshot:\n${compilerOutput}`.trim());
        let structuredDiagnostics = [];
        if (semanticDiagnosticsPath) {
            try {
                if (fs.statSync(semanticDiagnosticsPath).size <= 64 * 1024 * 1024) {
                    structuredDiagnostics = decodeCompilerDiagnosticSidecar(fs.readFileSync(semanticDiagnosticsPath), {
                        cwd: path.dirname(options.filePath),
                        compilerExitCode: result.exitCode
                    }).diagnostics;
                }
            } catch {
                /* Text diagnostics remain available if the optional transport is absent or invalid. */
            }
        }
        return { ...result, structuredDiagnostics };
    } finally {
        clearInterval(monitor);
        options.signal?.removeEventListener("abort", abort);
    }
}

function normalizeCompilerPath(filePath, cwd) {
    return path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath));
}

function compilerSemanticDependencies(sidecar, cwd, requestedFile) {
    if (sidecar.schemaVersion < 6) return null;
    if (!sidecar.dependenciesComplete) throw new Error("Compiler semantic sidecar has an incomplete dependency inventory.");
    const dependencies = [];
    const seen = new Set();
    for (const file of sidecar.dependencies) {
        const normalized = normalizeCompilerPath(file, cwd);
        const key = compilerPathKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        dependencies.push(normalized);
    }
    if (!dependencies.length || !seen.has(compilerPathKey(normalizeCompilerPath(requestedFile, cwd)))) {
        throw new Error("Compiler semantic sidecar did not report the requested module.");
    }
    if (dependencies.length > 5000) throw new Error("Compiler analysis exceeded its 5000-source limit.");
    return dependencies;
}

function compilerSemanticProcedureRecords(sidecar, cwd) {
    return (sidecar.procedures || []).map((procedure) => ({
        ...procedure,
        filePath: procedure.filePath ? normalizeCompilerPath(procedure.filePath, cwd) : ""
    }));
}

function compilerSemanticTemporaryConstructions(sidecar, cwd) {
    if (sidecar.recovery || sidecar.schemaVersion < 27) return [];
    const feature = "temporary-construction-inputs";
    const coverage = new Map();
    for (const capability of sidecar.capabilities || []) {
        if (capability.feature !== feature) continue;
        if (coverage.has(capability.module) || capability.provisional) return [];
        coverage.set(capability.module, capability.coverage);
    }
    const integer = (text) => typeof text === "string" && /^(?:0|[1-9]\d*)$/.test(text) &&
        Number.isSafeInteger(Number(text)) ? Number(text) : null;
    const contexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    const files = new Map((sidecar.sourceFiles || []).map((file) => [file.id, file]));
    const locations = new Map();
    for (const location of sidecar.physicalLocations || []) {
        if (location.domain !== "source-context" || !location.role.startsWith("temporary-construction:")) continue;
        const key = `${location.subject}:${location.role}`;
        if (locations.has(key)) return [];
        locations.set(key, location);
    }
    const closures = new Map(), observations = new Map();
    let count = 0;
    for (const property of sidecar.properties || []) {
        const closure = /^temporary-construction-count:([1-9]\d*)$/.exec(property.name);
        const observation = /^temporary-construction:([1-9]\d*)$/.exec(property.name);
        if (!closure && !observation) {
            if (property.name.startsWith("temporary-construction:") || property.name.startsWith("temporary-construction-count:")) return [];
            continue;
        }
        if (property.domain !== "symbol" || property.provisional || coverage.get(property.module) !== "available") return [];
        if (closure) {
            const value = integer(property.value);
            if (Number(closure[1]) !== property.module || value === null || value > MAX_EDITOR_SEMANTIC_CONSTRUCTION_INPUTS || closures.has(property.module)) return [];
            closures.set(property.module, value);
            continue;
        }
        const ordinal = integer(observation[1]);
        const values = property.value.split("\t").map(integer);
        if (ordinal === null || ordinal > MAX_EDITOR_SEMANTIC_CONSTRUCTION_INPUTS || values.length !== 4 || values.some((value) => value === null) ||
            values[0] < 1 || values[2] < 1 || !Number.isSafeInteger(property.identity) || property.identity < 1 ||
            ++count > MAX_EDITOR_SEMANTIC_CONSTRUCTION_INPUTS) return [];
        const [target, statement, source, macro] = values;
        const context = contexts.get(source);
        if (!context || context.module !== property.module) return [];
        const entries = observations.get(property.module) || new Map();
        if (entries.has(ordinal)) return [];
        entries.set(ordinal, { property, target, statement, source, macro });
        observations.set(property.module, entries);
    }
    // K observations are useful only as a closed, non-recovery family. Never
    // infer a source position from their statement IDs; require the matching
    // mapped LOC, whose byte/UTF-16 coordinates were checked against the source.
    const result = [];
    for (const [module, available] of coverage) {
        const entries = observations.get(module) || new Map();
        const closure = closures.get(module);
        if (available !== "available") {
            if (closure !== undefined || entries.size) return [];
            continue;
        }
        if (closure === undefined || closure !== entries.size) return [];
        for (let ordinal = 1; ordinal <= closure; ordinal++) {
            const entry = entries.get(ordinal);
            if (!entry) return [];
            const location = locations.get(`${entry.source}:${entry.property.name}`);
            const file = files.get(contexts.get(entry.source).file);
            if (!location || location.source !== entry.source) return [];
            if (entry.macro || location.status !== "mapped" || file?.kind !== "regular" || !file.filePath) continue;
            result.push({ kind: "explicit-constructor", owner: entry.property.identity, type: entry.property.identity,
                target: entry.target, physical: true, filePath: normalizeCompilerPath(file.filePath, cwd),
                startLine: location.startLine, startColumn: location.startColumn,
                endLine: location.endLine, endColumn: location.endColumn });
        }
    }
    return result;
}

function compilerSemanticOperatorOperations(sidecar, cwd) {
    return (sidecar.operations || []).map((operation) => ({
        ...operation,
        filePath: operation.filePath ? normalizeCompilerPath(operation.filePath, cwd) : ""
    }));
}

function compilerSemanticAssignmentInputs(sidecar, cwd) {
    if (sidecar.recovery || sidecar.schemaVersion < 27 ||
        !Array.isArray(sidecar.properties) || sidecar.properties.length > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS * 8) return [];

    /* K properties omit source coordinates; the closed statement's LOC and O receipts supply them without source-text matching. */
    const integer = (text, minimum = 0) => {
        if (typeof text !== "string" || !/^(?:0|[1-9]\d*)$/.test(text)) return null;
        const value = Number(text);
        return Number.isSafeInteger(value) && value >= minimum ? value : null;
    };
    const capabilityCoverage = new Map((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "source-assignment-inputs")
        .map((capability) => [capability.module, capability.coverage]));
    const statements = new Map((sidecar.statements || []).map((statement) => [
        `${statement.module}:${statement.id}`, statement
    ]));
    const endings = new Map((sidecar.statementEndings || []).map((ending) => [ending.id, ending]));
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((file) => [file.id, file]));
    const procedures = new Map((sidecar.procedures || []).map((procedure) => [procedure.symbol, procedure]));
    const expressions = new Map((sidecar.expressions || []).map((expression) => [expression.id, expression]));
    const nonphysicalExpressions = new Map((sidecar.assignmentExpressionSummaries || [])
        .map((expression) => [expression.id, expression]));
    const assignmentTargetDtypes = new Map();
    const primitiveTypeNames = new Map((sidecar.primitiveTypes || []).map((type) => [type.id, type.name]));
    for (const property of sidecar.properties || []) {
        if (property.domain !== "expression" || property.name !== "assignment-target-dtype") continue;
        const key = `${property.module}:${property.identity}`;
        const dtype = compilerScalarPrimitiveDtype(integer(property.value, 1), sidecar.compilerVersion, primitiveTypeNames);
        if (!assignmentTargetDtypes.has(key)) assignmentTargetDtypes.set(key, dtype);
        else if (assignmentTargetDtypes.get(key) !== dtype) assignmentTargetDtypes.set(key, null);
    }
    const expressionSources = new Map((sidecar.sourceOrigins || [])
        .filter((origin) => origin.domain === "expression")
        .map((origin) => [origin.identity, origin.source]));
    const statementOwners = new Map((sidecar.statementOwners || [])
        .filter((owner) => owner.domain === "expression")
        .map((owner) => [owner.subject, owner.statement]));
    const locations = new Map();
    for (const location of sidecar.physicalLocations || []) {
        const match = location.domain === "statement" && /^assignment-operator:([1-9]\d*)$/.exec(location.role);
        if (!match) continue;
        const key = `${location.subject}:${match[1]}`;
        if (locations.has(key)) locations.set(key, null);
        else locations.set(key, location);
    }
    const relationships = new Set((sidecar.relationships || [])
        .filter((relationship) => relationship.sourceDomain === "symbol" && relationship.targetDomain === "symbol" &&
            relationship.source === relationship.target)
        .map((relationship) => `${relationship.module}:${relationship.source}:${relationship.kind}:${relationship.ordinal}`));
    const operationsBySite = new Map();
    const pathKey = (filePath) => filePath ? compilerPathKey(normalizeCompilerPath(filePath, cwd)) : "";
    for (const operation of sidecar.operations || []) {
        if (operation.physical !== true || !operation.filePath) continue;
        const key = [pathKey(operation.filePath), operation.startLine, operation.startColumn,
            operation.endLine, operation.operatorCode, operation.operatorKind, operation.target].join("\t");
        const records = operationsBySite.get(key) || [];
        records.push(operation);
        operationsBySite.set(key, records);
    }

    const counts = new Map();
    const groups = new Map();
    for (const property of sidecar.properties) {
        if (property.domain !== "symbol" || capabilityCoverage.get(property.module) !== "available") continue;
        const countKey = /^assignment-count:([1-9]\d*)$/.exec(property.name);
        if (countKey) {
            const statement = integer(countKey[1], 1);
            const count = integer(property.value, 0);
            const key = `${property.module}:${property.identity}:${statement}`;
            if (statement === null || count === null || counts.has(key)) counts.set(key, null);
            else counts.set(key, count);
            continue;
        }
        const inputKey = /^assignment-input:([1-9]\d*):([1-9]\d*)$/.exec(property.name);
        if (!inputKey) continue;
        const statementId = integer(inputKey[1], 1);
        const ordinal = integer(inputKey[2], 1);
        const key = `${property.module}:${property.identity}:${statementId}`;
        const group = groups.get(key) || { module: property.module, owner: property.identity,
            statement: statementId, inputs: new Map(), invalid: false };
        if (statementId === null || ordinal === null || group.inputs.has(ordinal) ||
            group.inputs.size >= MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) {
            group.invalid = true;
        } else {
            group.inputs.set(ordinal, property.value);
        }
        groups.set(key, group);
    }
    if (groups.size > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];

    const results = [];
    for (const [key, group] of groups) {
        if (group.invalid) continue;
        const count = counts.get(key);
        if (!Number.isSafeInteger(count) || count !== group.inputs.size ||
            count > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) continue;
        const statement = statements.get(`${group.module}:${group.statement}`);
        const ending = endings.get(group.statement);
        const owner = procedures.get(group.owner);
        if (!statement || statement.owner !== group.owner || statement.module !== group.module ||
            statement.physical !== true || !ending || ending.outcome !== "parsed" ||
            !owner || owner.symbolClass !== 3 ||
            !relationships.has(`${group.module}:${group.owner}:assignment-count:${group.statement}`)) continue;

        let complete = true;
        for (let ordinal = 1; ordinal <= count; ordinal++) {
            const payload = group.inputs.get(ordinal);
            if (typeof payload !== "string" ||
                !relationships.has(`${group.module}:${group.owner}:assignment-input:${ordinal}:${group.statement}`)) {
                complete = false;
                break;
            }
        }
        if (!complete) continue;

        for (let ordinal = 1; ordinal <= count; ordinal++) {
            const fields = group.inputs.get(ordinal).split("\t");
            if (fields.length !== 6 || !["copy", "compound", "initializer", "let"].includes(fields[2]) ||
                !["builtin", "overloaded"].includes(fields[4]) ||
                fields[2] !== "compound" && fields[3] !== "assign" ||
                fields[2] === "compound" && !COMPOUND_ASSIGNMENT_CODES.has(fields[3])) continue;
            const leftId = integer(fields[0], 1);
            const rightId = integer(fields[1], 1);
            const target = integer(fields[5], 0);
            if (leftId === null || rightId === null || target === null ||
                fields[4] === "builtin" && target !== 0 || fields[4] === "overloaded" &&
                (!target || procedures.get(target)?.symbolClass !== 3)) continue;
            if (fields[2] !== "compound") continue;

            const left = expressions.get(leftId) || nonphysicalExpressions.get(leftId);
            const right = expressions.get(rightId);
            const location = locations.get(`${group.statement}:${ordinal}`);
            const sourceContextId = location?.source;
            const context = sourceContextId && sourceContexts.get(sourceContextId);
            const file = context && sourceFiles.get(context.file);
            const leftContext = sourceContexts.get(expressionSources.get(leftId));
            const rightContext = sourceContexts.get(expressionSources.get(rightId));
            const expectedOperatorCode = `${fields[3]}-assign`;
            const operatorSiteKey = location && file ? [
                pathKey(file.filePath), location.startLine, location.startColumn,
                location.endLine, expectedOperatorCode, fields[4], target
            ].join("\t") : "";
            const operationMatches = (operationsBySite.get(operatorSiteKey) || []).filter((operation) =>
                operation.endColumn >= location?.endColumn
            );
            const operationEnds = new Set(operationMatches.map((operation) => operation.endColumn));
            if (!right?.typeName ||
                leftContext?.module !== group.module || rightContext?.module !== group.module ||
                statementOwners.get(leftId) !== group.statement || statementOwners.get(rightId) !== group.statement ||
                !location || !context || context.module !== group.module || context.id !== statement.source ||
                !file || file.kind !== "regular" || !file.filePath || location.status !== "mapped" ||
                location.source !== statement.source || !operationMatches.length || operationEnds.size !== 1) continue;

            const operation = operationMatches[0];
            const targetProcedure = target ? procedures.get(target) : null;
            let resultTypeName = "";
            let targetTypeName = "";
            if (sidecar.assignmentExpressionSummariesComplete !== false) {
                const resultExpressions = (sidecar.assignmentExpressionSummaries || []).filter((expression) =>
                    expression.module === group.module && expression.operatorCode === fields[3] &&
                    expression.operatorKind === fields[4] &&
                    compilerPathKey(normalizeCompilerPath(expression.filePath, cwd)) === compilerPathKey(file.filePath) &&
                    expression.startLine === location.startLine && expression.startColumn === location.startColumn &&
                    statementOwners.get(expression.id) === group.statement &&
                    sourceContexts.get(expressionSources.get(expression.id))?.module === group.module
                );
                const resultTypes = new Map();
                for (const resultExpression of resultExpressions) {
                    const targetDtype = assignmentTargetDtypes.get(`${group.module}:${resultExpression.id}`);
                    const assignedType = Number.isSafeInteger(targetDtype)
                        ? primitiveTypeNames.get(targetDtype) || ""
                        : "";
                    resultTypes.set(`${resultExpression.typeName}\t${assignedType}`, {
                        resultTypeName: resultExpression.typeName,
                        targetTypeName: assignedType
                    });
                }
                if (resultTypes.size === 1) {
                    const selected = resultTypes.values().next().value;
                    resultTypeName = selected.resultTypeName;
                    targetTypeName = selected.targetTypeName;
                }
            }
            results.push({
                filePath: normalizeCompilerPath(file.filePath, cwd),
                line: operation.startLine - 1,
                startColumn: location.startColumn,
                endLine: operation.endLine - 1,
                endColumn: operation.endColumn,
                operatorCode: fields[3],
                operatorKind: fields[4],
                targetName: targetProcedure?.name || "",
                leftTypeName: left?.typeName || "",
                rightTypeName: right.typeName,
                resultTypeName,
                targetTypeName,
                provisional: false
            });
        }
    }
    return results;
}

function compilerSemanticPreprocessorFacts(sidecar, cwd) {
    const collections = [
        "conditionalBranches", "conditionalDecisions", "conditionalClosures",
        "definedNameProbes", "skippedRegions", "macroLifecycles"
    ];
    const facts = Object.fromEntries(collections.map((name) => [
        name,
        (sidecar[name] || []).map((fact) => ({
            ...fact,
            ...(typeof fact.filePath === "string" && fact.filePath
                ? { filePath: normalizeCompilerPath(fact.filePath, cwd) }
                : {})
        }))
    ]));
    /* Nested physical calls retain useful signatures when they were written in macro arguments. */
    const invocations = (sidecar.macroInvocations || []).filter((invocation) =>
        invocation.physical === true && ["normal", "evaluation"].includes(invocation.phase) &&
        ["root", "replacement", "argument", "callback"].includes(invocation.relation)
    ).map((invocation) => ({
        ...invocation,
        filePath: normalizeCompilerPath(invocation.filePath, cwd)
    }));
    const definitionIds = new Set(invocations.map((invocation) => invocation.definition));
    const definitions = (sidecar.macroDefinitions || [])
        .filter((definition) => definitionIds.has(definition.id));
    const parameters = (sidecar.macroTokens || [])
        .filter((macroToken) => definitionIds.has(macroToken.definition) && macroToken.kind === "parameter")
        .map((macroToken) => ({
            definition: macroToken.definition,
            ordinal: macroToken.ordinal,
            name: macroToken.value
        }));
    const definitionSites = (sidecar.macroLifecycles || [])
        .filter((lifecycle) => definitionIds.has(lifecycle.definition) &&
            lifecycle.action === "define" && lifecycle.physical)
        .map((lifecycle) => ({
            definition: lifecycle.definition,
            filePath: normalizeCompilerPath(lifecycle.filePath, cwd),
            startLine: lifecycle.startLine,
            startColumn: lifecycle.startColumn
        }));
    facts.macroSignatureFacts = { definitions, parameters, invocations, definitionSites };
    const macroSymbols = new Map((sidecar.macroDefinitions || []).map((definition) => [definition.id, definition.symbol]));
    const unprojectableMacroSymbols = new Set();
    for (const invocation of sidecar.macroInvocations || []) {
        if (!["normal", "evaluation"].includes(invocation.phase) ||
            invocation.relation === "root" && invocation.physical === true) continue;
        const symbol = macroSymbols.get(invocation.definition);
        if (Number.isSafeInteger(symbol) && symbol > 0) unprojectableMacroSymbols.add(symbol);
    }
    for (const lifecycle of sidecar.macroLifecycles || []) {
        if (lifecycle.action !== "undef" || lifecycle.physical === true) continue;
        const symbol = macroSymbols.get(lifecycle.definition);
        if (Number.isSafeInteger(symbol) && symbol > 0) unprojectableMacroSymbols.add(symbol);
    }
    facts.unprojectableMacroSymbols = [...unprojectableMacroSymbols];
    return facts;
}

function compilerSemanticPreprocessorReferenceBindings(sidecar, cwd, dependencies, bindings) {
    const definitions = new Map((sidecar.macroDefinitions || []).map((definition) => [definition.id, definition]));
    const physicalDeclarations = new Set();
    const physicalDeclarationNames = new Map();
    for (const binding of bindings) {
        if (binding.role !== "declaration" || binding.physical !== true) continue;
        physicalDeclarations.add(binding.symbol);
        if (typeof binding.name !== "string" || !binding.name) continue;
        const names = physicalDeclarationNames.get(binding.symbol) || new Set();
        names.add(binding.name);
        physicalDeclarationNames.set(binding.symbol, names);
    }
    const dependencyPaths = new Set(dependencies.map(compilerPathKey));
    const existing = new Set(bindings.map((binding) => [
        binding.symbol, binding.role, compilerPathKey(binding.filePath), binding.startLine,
        binding.startColumn, binding.endLine, binding.endColumn
    ].join("\t")));
    const result = [];

    for (const probe of sidecar.definedNameProbes || []) {
        if (!probe.physical || !probe.defined || !Number.isSafeInteger(probe.symbol) ||
            probe.symbol < 1 || !physicalDeclarations.has(probe.symbol) ||
            typeof probe.spelling !== "string" || !probe.spelling ||
            !Number.isSafeInteger(probe.startLine) || probe.startLine < 1 ||
            !Number.isSafeInteger(probe.endLine) || probe.endLine < probe.startLine) continue;
        const declarationNames = physicalDeclarationNames.get(probe.symbol);
        if (!declarationNames || declarationNames.size !== 1) continue;
        const name = declarationNames.values().next().value;
        const startColumn = probe.endColumn - name.length;
        if (startColumn < 0 || !name) continue;
        const filePath = normalizeCompilerPath(probe.filePath, cwd);
        if (!dependencyPaths.has(compilerPathKey(filePath))) {
            throw new Error("Compiler defined-name probe refers to a source outside its dependency inventory.");
        }
        const binding = {
            symbol: probe.symbol,
            role: "reference",
            physical: true,
            filePath,
            startLine: probe.endLine,
            startColumn,
            endLine: probe.endLine,
            endColumn: probe.endColumn,
            name
        };
        const key = [binding.symbol, binding.role, compilerPathKey(binding.filePath), binding.startLine,
            binding.startColumn, binding.endLine, binding.endColumn].join("\t");
        if (existing.has(key)) continue;
        if (bindings.length + result.length >= MAX_BINDINGS) {
            throw new Error("Compiler analysis exceeded its 200000-binding limit.");
        }
        existing.add(key);
        result.push(binding);
    }

    for (const invocation of sidecar.macroInvocations || []) {
        if (!invocation.physical || !["normal", "evaluation"].includes(invocation.phase) ||
            invocation.relation !== "root") continue;
        const definition = definitions.get(invocation.definition);
        if (!Number.isSafeInteger(definition?.symbol) || definition.symbol < 1 ||
            !physicalDeclarations.has(definition.symbol)) continue;
        const filePath = normalizeCompilerPath(invocation.filePath, cwd);
        if (!dependencyPaths.has(compilerPathKey(filePath))) {
            throw new Error("Compiler macro invocation refers to a source outside its dependency inventory.");
        }
        const binding = {
            symbol: definition.symbol,
            role: "reference",
            physical: true,
            filePath,
            startLine: invocation.startLine,
            startColumn: invocation.startColumn,
            endLine: invocation.endLine,
            endColumn: invocation.endColumn,
            name: definition.name
        };
        const key = [binding.symbol, binding.role, compilerPathKey(binding.filePath), binding.startLine,
            binding.startColumn, binding.endLine, binding.endColumn].join("\t");
        if (existing.has(key)) continue;
        if (bindings.length + result.length >= MAX_BINDINGS) {
            throw new Error("Compiler analysis exceeded its 200000-binding limit.");
        }
        existing.add(key);
        result.push(binding);
    }

    for (const lifecycle of sidecar.macroLifecycles || []) {
        if (lifecycle.action !== "undef" || !lifecycle.physical || typeof lifecycle.spelling !== "string" ||
            lifecycle.startLine !== lifecycle.endLine ||
            lifecycle.endColumn - lifecycle.startColumn !== lifecycle.spelling.length) continue;
        const definition = definitions.get(lifecycle.definition);
        if (!Number.isSafeInteger(definition?.symbol) || definition.symbol < 1 ||
            !physicalDeclarations.has(definition.symbol)) continue;
        const filePath = normalizeCompilerPath(lifecycle.filePath, cwd);
        if (!dependencyPaths.has(compilerPathKey(filePath))) {
            throw new Error("Compiler macro undef refers to a source outside its dependency inventory.");
        }
        const binding = {
            symbol: definition.symbol,
            role: "reference",
            physical: true,
            filePath,
            startLine: lifecycle.startLine,
            startColumn: lifecycle.startColumn,
            endLine: lifecycle.endLine,
            endColumn: lifecycle.endColumn,
            name: definition.name
        };
        const key = [binding.symbol, binding.role, compilerPathKey(binding.filePath), binding.startLine,
            binding.startColumn, binding.endLine, binding.endColumn].join("\t");
        if (existing.has(key)) continue;
        if (bindings.length + result.length >= MAX_BINDINGS) {
            throw new Error("Compiler analysis exceeded its 200000-binding limit.");
        }
        existing.add(key);
        result.push(binding);
    }
    return result;
}

function compilerSemanticIncludeOutcomes(sidecar, cwd) {
    return (sidecar.includeOutcomes || []).map((outcome) => ({
        ...outcome,
        resolved: outcome.resolved ? normalizeCompilerPath(outcome.resolved, cwd) : "",
        directive: outcome.directive ? {
            ...outcome.directive,
            filePath: normalizeCompilerPath(outcome.directive.filePath, cwd)
        } : null,
        origin: outcome.origin ? {
            ...outcome.origin,
            filePath: normalizeCompilerPath(outcome.origin.filePath, cwd)
        } : null
    }));
}

function compilerSemanticNamespaceImportRecipients(sidecar, cwd) {
    const statements = new Map((sidecar.statements || []).map((statement) => [statement.id, statement]));
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((source) => [source.id, source]));
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    return (sidecar.namespaceImportRecipients || []).map((imported) => {
        const statement = statements.get(imported.statement);
        const sourceContext = sourceContexts.get(imported.source);
        const sourceFile = sourceContext && sourceFiles.get(sourceContext.file);
        const filePath = normalizeCompilerPath(imported.filePath, cwd);
        const sourcePath = sourceFile?.filePath
            ? normalizeCompilerPath(sourceFile.filePath, cwd)
            : "";
        const physical = statement?.physical === true && statement.source === imported.source &&
            statement.module === imported.module && sourceContext?.module === imported.module &&
            sourcePath === filePath && Number.isSafeInteger(statement.startLine) && statement.startLine >= 1 &&
            Number.isSafeInteger(statement.startColumn) && statement.startColumn >= 0 &&
            Number.isSafeInteger(statement.endLine) && statement.endLine >= statement.startLine &&
            Number.isSafeInteger(statement.endColumn) && statement.endColumn >= 0;
        return {
            ...imported,
            filePath,
            physical,
            ...(physical ? {
                startLine: statement.startLine,
                startColumn: statement.startColumn,
                endLine: statement.endLine,
                endColumn: statement.endColumn
            } : {})
        };
    });
}

function compilerSemanticExpressionContexts(sidecar, cwd) {
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((source) => [source.id, source]));
    const contexts = (sidecar.sourceContexts || []).map((context) => {
        const source = sourceFiles.get(context.file);
        return {
            ...context,
            filePath: source?.filePath ? normalizeCompilerPath(source.filePath, cwd) : ""
        };
    });
    const expressionSources = new Map((sidecar.sourceOrigins || [])
        .filter((origin) => origin.domain === "expression")
        .map((origin) => [origin.identity, origin.source]));
    return { contexts, expressionSources };
}

function compilerSemanticSourceRevisions(sidecar, cwd) {
    return (sidecar.sourceFiles || []).filter((source) => source.kind === "regular").map((source) => ({
        filePath: normalizeCompilerPath(source.filePath, cwd),
        bytes: source.bytes,
        digest: source.digest,
        encoding: source.encoding
    }));
}

function compilerSemanticExpressionOperands(sidecar, cwd) {
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((source) => [source.id, source]));
    const coverageByModule = new Map((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "parsed-expression-input-coverage")
        .map((capability) => [capability.module, capability.coverage]));
    const statementByExpression = new Map((sidecar.statementOwners || [])
        .filter((owner) => owner.domain === "expression")
        .map((owner) => [owner.subject, owner.statement]));
    const coverageByStatement = new Map((sidecar.properties || [])
        .map((property) => {
            const match = /^parsed-expression-inputs:(\d+)$/.exec(property.name);
            return match && property.domain === "symbol"
                ? [`${property.module}:${match[1]}`, property.value]
                : null;
        })
        .filter(Boolean));
    return (sidecar.expressionOperands || []).map((operation) => {
        const context = sourceContexts.get(operation.source);
        const sourceFile = context && sourceFiles.get(context.file);
        if (!sourceFile?.filePath) throw new Error("Compiler semantic expression operation has no captured source file.");
        const coverageAvailable = coverageByModule.get(operation.module) === "available";
        const statement = statementByExpression.get(operation.identity);
        return {
            ...operation,
            ...(coverageAvailable && Number.isSafeInteger(statement) ? {
                inputCoverageAvailable: coverageByStatement.get(`${operation.module}:${statement}`) === "available"
            } : {}),
            filePath: normalizeCompilerPath(operation.filePath, cwd),
            sourceFilePath: normalizeCompilerPath(sourceFile.filePath, cwd)
        };
    });
}

function compilerSemanticIifInputs(sidecar) {
    if (sidecar.recovery === true || !Array.isArray(sidecar.properties) ||
        sidecar.properties.length > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS * 8) return [];
    const availableModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "original-iif-inputs" && capability.coverage === "available")
        .map((capability) => capability.module));
    if (!availableModules.size) return [];
    const expressions = new Map((sidecar.expressions || []).map((expression) => [expression.id, expression]));
    const result = [];
    for (const property of sidecar.properties) {
        if (property.domain !== "expression" || property.name !== "original-iif-inputs" ||
            !availableModules.has(property.module) || typeof property.value !== "string") continue;
        const identities = property.value.split("\t");
        if (identities.length !== 3 || identities.some((identity) => !/^[1-9]\d*$/.test(identity))) continue;
        const [conditionId, trueArmId, falseArmId] = identities.map(Number);
        const condition = expressions.get(conditionId);
        const trueArm = expressions.get(trueArmId);
        const falseArm = expressions.get(falseArmId);
        const selected = expressions.get(property.identity);
        if (!condition || !trueArm || !falseArm || !selected ||
            [conditionId, trueArmId, falseArmId].some((identity, index, values) =>
                !Number.isSafeInteger(identity) || identity >= (values[index + 1] || property.identity)) ||
            [condition, trueArm, falseArm, selected].some((expression) =>
                expression.recovery === true || typeof expression.typeName !== "string" ||
                !expression.typeName || expression.typeName.length > 512 || /[\x00-\x1f\x7f`]/.test(expression.typeName))) continue;
        if (result.length >= MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];
        result.push({
            module: property.module,
            result: property.identity,
            conditionTypeName: condition.typeName,
            trueTypeName: trueArm.typeName,
            falseTypeName: falseArm.typeName,
            resultTypeName: selected.typeName
        });
    }
    return result;
}

function compilerSemanticAssignmentTargets(sidecar) {
    if (sidecar.recovery === true || !Array.isArray(sidecar.properties) ||
        sidecar.properties.length > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS * 8) return [];
    const availableModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "numeric-assignment-targets" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    const namedTargetModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "source-assignment-targets" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    if (!availableModules.size && !namedTargetModules.size) return [];
    const namedTargets = new Map();
    for (const property of sidecar.properties) {
        if (property.domain !== "expression" ||
            !["source-assignment-symbol", "source-assignment-kind"].includes(property.name) ||
            !namedTargetModules.has(property.module)) continue;
        const key = `${property.module}:${property.identity}`;
        const group = namedTargets.get(key) || { values: new Map(), invalid: false };
        if (group.values.has(property.name)) group.invalid = true;
        else group.values.set(property.name, property.value);
        namedTargets.set(key, group);
    }
    const namedTargetSymbols = new Map();
    for (const [key, group] of namedTargets) {
        const symbolText = group.values.get("source-assignment-symbol");
        const kind = group.values.get("source-assignment-kind");
        if (group.invalid || group.values.size !== 2 || !["assignment", "initializer"].includes(kind) ||
            !/^[1-9]\d*$/.test(symbolText || "")) continue;
        const symbolId = Number(symbolText);
        if (!Number.isSafeInteger(symbolId)) continue;
        namedTargetSymbols.set(key, { symbolId, kind });
    }
    const primitiveNames = new Map();
    for (const type of sidecar.primitiveTypes || []) {
        const names = primitiveNames.get(type.id) || new Set();
        names.add(type.name);
        primitiveNames.set(type.id, names);
    }
    const numericResultModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "numeric-function-result-inputs" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    const functionResultModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "function-result-inputs" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    const resultStyles = new Map();
    for (const property of sidecar.properties) {
        const resultInput = property.domain === "symbol" &&
            /^function-result-input:[1-9]\d*$/.test(property.name);
        if (!resultInput || !numericResultModules.has(property.module) ||
            !functionResultModules.has(property.module) || typeof property.value !== "string") continue;
        const fields = property.value.split("\t");
        if (fields.length !== 4 || !["return", "assignment"].includes(fields[0]) ||
            !["value", "reference", "pointer"].includes(fields[1]) ||
            !/^[1-9]\d*$/.test(fields[2])) continue;
        const expressionId = Number(fields[2]);
        if (!Number.isSafeInteger(expressionId)) continue;
        const key = `${property.module}:${expressionId}`;
        const previous = resultStyles.get(key);
        const style = fields[0] === "return" ? "return" : "function-result-assignment";
        if (previous === undefined) resultStyles.set(key, style);
        else if (previous !== style) resultStyles.set(key, null);
    }
    const expressions = new Map((sidecar.expressions || []).map((expression) => [expression.id, expression]));
    const groups = new Map();
    for (const property of sidecar.properties) {
        if (property.domain !== "expression" ||
            !["assignment-target-dtype", "assignment-kind"].includes(property.name) ||
            !availableModules.has(property.module)) continue;
        const key = `${property.module}:${property.identity}`;
        const group = groups.get(key) || { module: property.module, identity: property.identity, values: new Map() };
        group.values.set(property.name, property.value);
        groups.set(key, group);
    }
    const results = [];
    for (const group of groups.values()) {
        const dtypeText = group.values.get("assignment-target-dtype");
        const kind = group.values.get("assignment-kind");
        if (group.values.size !== 2 || !/^[1-9]\d*$/.test(dtypeText || "") ||
            !["assignment", "initializer"].includes(kind)) continue;
        const targetDtype = compilerScalarPrimitiveDtype(Number(dtypeText), sidecar.compilerVersion, primitiveNames);
        const targetTypeName = targetDtype === null ? [] : [...(primitiveNames.get(targetDtype) || [])];
        const expression = expressions.get(group.identity);
        if (targetTypeName.length !== 1 || !expression || expression.recovery === true ||
            typeof expression.typeName !== "string" || !expression.typeName) continue;
        if (results.length >= MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];
        results.push({
            module: group.module,
            identity: group.identity,
            kind: resultStyles.get(`${group.module}:${group.identity}`) ||
                (kind === "initializer" ? "initializer" : "destination"),
            ...(namedTargetSymbols.has(`${group.module}:${group.identity}`)
                ? { targetSymbolId: namedTargetSymbols.get(`${group.module}:${group.identity}`).symbolId }
                : {}),
            targetTypeName: targetTypeName[0],
            sourceTypeName: expression.typeName
        });
    }
    const numericTargets = new Set(results.map((target) => `${target.module}:${target.identity}`));
    if (namedTargetModules.size) {
        for (const [key, target] of namedTargetSymbols) {
            if (numericTargets.has(key)) continue;
            const [moduleText, identityText] = key.split(":");
            const module = Number(moduleText);
            const identity = Number(identityText);
            const expression = expressions.get(identity);
            if (!Number.isSafeInteger(module) || !Number.isSafeInteger(identity) || !expression ||
                expression.recovery === true || typeof expression.typeName !== "string" || !expression.typeName) continue;
            if (results.length >= MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];
            results.push({
                module,
                identity,
                kind: target.kind === "initializer" ? "initializer" : "destination",
                targetSymbolId: target.symbolId,
                sourceTypeName: expression.typeName
            });
        }
    }
    return results;
}

function compilerSemanticArrayIndexInputs(sidecar) {
    if (sidecar.recovery === true || !Array.isArray(sidecar.properties) ||
        sidecar.properties.length > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS * 8) return [];
    const availableModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "array-subscript-inputs" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    if (!availableModules.size) return [];
    const integer = (value, minimum = 0) => {
        if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
        const result = Number(value);
        return Number.isSafeInteger(result) && result >= minimum ? result : null;
    };
    const expressions = new Map((sidecar.expressions || []).map((expression) => [expression.id, expression]));
    const statementOwners = new Map((sidecar.statementOwners || [])
        .filter((owner) => owner.domain === "expression")
        .map((owner) => [owner.subject, owner.statement]));
    const groups = new Map();
    for (const property of sidecar.properties) {
        if (property.domain !== "expression" || !property.name.startsWith("array-subscript-") ||
            !availableModules.has(property.module)) continue;
        const key = `${property.module}:${property.identity}`;
        const group = groups.get(key) || {
            module: property.module, result: property.identity, values: new Map(), invalid: false
        };
        if (group.values.has(property.name)) group.invalid = true;
        else group.values.set(property.name, property.value);
        groups.set(key, group);
    }
    const markers = new Map();
    for (const relation of sidecar.relationships || []) {
        if (relation.kind !== "array-subscript") continue;
        if (relation.sourceDomain !== "symbol" || relation.targetDomain !== "expression" || relation.ordinal !== 0) continue;
        const key = `${relation.module}:${relation.target}`;
        const marker = markers.get(key) || { count: 0, source: relation.source };
        marker.count++;
        markers.set(key, marker);
    }

    const inputs = new Map();
    for (const group of groups.values()) {
        if (group.invalid || !expressions.has(group.result)) continue;
        const arraySymbol = integer(group.values.get("array-subscript-symbol"), 1);
        const rank = integer(group.values.get("array-subscript-rank"), 1);
        if (arraySymbol === null || rank === null || rank > 8 || group.values.size !== 2 + rank * 2) continue;
        const expectedNames = new Set(["array-subscript-symbol", "array-subscript-rank"]);
        for (let dimension = 0; dimension < rank; dimension++) {
            expectedNames.add(`array-subscript-index:${dimension}`);
            expectedNames.add(`array-subscript-selected-index:${dimension}`);
        }
        if ([...group.values.keys()].some((name) => !expectedNames.has(name))) continue;
        const marker = markers.get(`${group.module}:${group.result}`);
        if (marker?.count !== 1 || marker.source !== arraySymbol) continue;
        const statement = statementOwners.get(group.result);
        if (!statement) continue;
        for (let dimension = 0; dimension < rank; dimension++) {
            const original = integer(group.values.get(`array-subscript-index:${dimension}`), 1);
            const selected = integer(group.values.get(`array-subscript-selected-index:${dimension}`), 1);
            const expression = original && expressions.get(original);
            if (original === null || selected === null || original > selected || selected >= group.result ||
                statementOwners.get(original) !== statement || statementOwners.get(selected) !== statement ||
                !expression || expression.physical !== true || typeof expression.typeName !== "string" ||
                !expression.typeName || !expression.filePath) continue;
            if (original === selected) continue;
            const key = `${group.module}:${original}`;
            const fact = {
                module: group.module,
                expression: original,
                result: group.result,
                dimension: dimension + 1,
                sourceTypeName: expression.typeName,
                targetTypeName: "integer"
            };
            const previous = inputs.get(key);
            if (!previous) inputs.set(key, fact);
            else if (previous.sourceTypeName !== fact.sourceTypeName) inputs.set(key, null);
            if (inputs.size > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];
        }
    }
    return [...inputs.values()].filter(Boolean);
}

function compilerSemanticSelectedNumericOperands(sidecar) {
    if (sidecar.recovery === true || !Array.isArray(sidecar.properties) ||
        sidecar.properties.length > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS * 8) return [];
    const availableModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "selected-numeric-operands" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    if (!availableModules.size) return [];
    const integer = (value) => {
        if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
        const result = Number(value);
        return Number.isSafeInteger(result) ? result : null;
    };
    const primitiveNames = new Map();
    for (const type of sidecar.primitiveTypes || []) {
        const names = primitiveNames.get(type.id) || new Set();
        names.add(type.name);
        primitiveNames.set(type.id, names);
    }
    const statementOwners = new Map((sidecar.statementOwners || [])
        .filter((owner) => owner.domain === "expression")
        .map((owner) => [owner.subject, owner.statement]));
    const operations = new Map((sidecar.expressionOperands || [])
        .filter((operation) => ["binary", "intrinsic-binary"].includes(operation.family))
        .map((operation) => [`${operation.module}:${operation.identity}`, operation]));
    const groups = new Map();
    for (const property of sidecar.properties) {
        if (property.domain !== "expression" || !property.name.startsWith("numeric-selected-") ||
            !availableModules.has(property.module)) continue;
        const key = `${property.module}:${property.identity}`;
        const group = groups.get(key) || {
            module: property.module, result: property.identity, values: new Map(), invalid: false
        };
        if (group.values.has(property.name)) group.invalid = true;
        else group.values.set(property.name, property.value);
        groups.set(key, group);
    }
    const required = [
        "numeric-selected-left-dtype", "numeric-selected-right-dtype",
        "numeric-selected-left-expression", "numeric-selected-right-expression"
    ];
    const selections = [];
    for (const group of groups.values()) {
        if (group.invalid || group.values.size !== required.length ||
            required.some((name) => !group.values.has(name))) continue;
        const operation = operations.get(`${group.module}:${group.result}`);
        const leftDtype = integer(group.values.get("numeric-selected-left-dtype"));
        const rightDtype = integer(group.values.get("numeric-selected-right-dtype"));
        const leftExpression = integer(group.values.get("numeric-selected-left-expression"));
        const rightExpression = integer(group.values.get("numeric-selected-right-expression"));
        const statement = statementOwners.get(group.result);
        const leftTypeName = leftDtype === null ? [] : [...(primitiveNames.get(leftDtype) || [])];
        const rightTypeName = rightDtype === null ? [] : [...(primitiveNames.get(rightDtype) || [])];
        if (!operation || !statement || leftExpression === null || rightExpression === null ||
            leftExpression >= group.result || rightExpression >= group.result ||
            statementOwners.get(leftExpression) !== statement || statementOwners.get(rightExpression) !== statement ||
            leftTypeName.length !== 1 || rightTypeName.length !== 1) continue;
        if (selections.length >= MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];
        selections.push({
            module: group.module,
            result: group.result,
            selectedLeftTypeName: leftTypeName[0],
            selectedRightTypeName: rightTypeName[0]
        });
    }
    return selections;
}

function compilerSemanticSizeQueryInputs(sidecar) {
    if (sidecar.recovery === true || !Array.isArray(sidecar.properties) ||
        sidecar.properties.length > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS * 8) return [];
    const availableModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "size-query-inputs" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    if (!availableModules.size) return [];
    const integer = (value, minimum = 0) => {
        if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
        const result = Number(value);
        return Number.isSafeInteger(result) && result >= minimum ? result : null;
    };
    const expressions = new Map((sidecar.expressions || []).map((expression) => [expression.id, expression]));
    const statementOwners = new Map((sidecar.statementOwners || [])
        .filter((owner) => owner.domain === "expression")
        .map((owner) => [owner.subject, owner.statement]));
    const groups = new Map();
    for (const property of sidecar.properties) {
        if (property.domain !== "expression" || !property.name.startsWith("size-query-") ||
            !availableModules.has(property.module)) continue;
        const key = `${property.module}:${property.identity}`;
        const group = groups.get(key) || { module: property.module, result: property.identity, values: new Map(), invalid: false };
        if (group.values.has(property.name)) group.invalid = true;
        else group.values.set(property.name, property.value);
        groups.set(key, group);
    }
    const required = [
        "size-query-kind", "size-query-dtype", "size-query-subtype", "size-query-operand", "size-query-input"
    ];
    const inputs = [];
    for (const group of groups.values()) {
        if (group.invalid || group.values.size !== required.length ||
            required.some((name) => !group.values.has(name)) ||
            [...group.values.keys()].some((name) => !required.includes(name)) ||
            group.values.get("size-query-kind") !== "sizeof" ||
            !["expression", "array"].includes(group.values.get("size-query-input"))) continue;
        const operand = integer(group.values.get("size-query-operand"), 1);
        const expression = operand === null ? null : expressions.get(operand);
        const resultExpression = expressions.get(group.result);
        const sourceStatement = statementOwners.get(group.result);
        if (!operand || operand >= group.result || !expression || !resultExpression ||
            expression.physical !== true || typeof expression.typeName !== "string" || !expression.typeName ||
            typeof expression.filePath !== "string" || !expression.filePath ||
            !sourceStatement || statementOwners.get(operand) !== sourceStatement) continue;
        if (inputs.length >= MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];
        inputs.push({
            module: group.module,
            result: group.result,
            operand,
            inputKind: group.values.get("size-query-input"),
            inputTypeName: expression.typeName
        });
    }
    return inputs;
}

function compilerSemanticArrayBoundQueries(sidecar) {
    if (sidecar.recovery === true || !Array.isArray(sidecar.properties) ||
        sidecar.properties.length > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS * 8) return [];
    const availableModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "array-bound-query-inputs" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    if (!availableModules.size) return [];
    const integer = (value, minimum = 0) => {
        if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
        const result = Number(value);
        return Number.isSafeInteger(result) && result >= minimum ? result : null;
    };
    const expressions = new Map((sidecar.expressions || []).map((expression) => [expression.id, expression]));
    const statementOwners = new Map((sidecar.statementOwners || [])
        .filter((owner) => owner.domain === "expression")
        .map((owner) => [owner.subject, owner.statement]));
    const markers = new Map();
    for (const relation of sidecar.relationships || []) {
        if (relation.kind !== "array-bound-query" || relation.sourceDomain !== "symbol" ||
            relation.targetDomain !== "expression" || relation.ordinal !== 0) continue;
        const key = `${relation.module}:${relation.target}`;
        const marker = markers.get(key) || { count: 0, source: relation.source };
        marker.count++;
        markers.set(key, marker);
    }
    const groups = new Map();
    for (const property of sidecar.properties) {
        if (property.domain !== "expression" || !property.name.startsWith("array-bound-") ||
            !availableModules.has(property.module)) continue;
        const key = `${property.module}:${property.identity}`;
        const group = groups.get(key) || { module: property.module, result: property.identity, values: new Map(), invalid: false };
        if (group.values.has(property.name)) group.invalid = true;
        else group.values.set(property.name, property.value);
        groups.set(key, group);
    }
    const constants = new Map();
    for (const constant of sidecar.constantValues || []) {
        if (constant.domain !== "expression" || constant.provisional === true ||
            !Number.isSafeInteger(constant.identity) || constant.identity < 1) continue;
        const key = `${constant.module}:${constant.identity}`;
        const values = constants.get(key) || new Map();
        values.set(`${constant.kind}:${constant.value}`, { kind: constant.kind, value: constant.value });
        constants.set(key, values);
    }

    const inputs = [];
    const required = new Set([
        "array-bound-kind", "array-bound-symbol", "array-bound-dimension", "array-bound-selected-dimension"
    ]);
    const allowed = new Set([...required, "array-bound-dimension-explicit"]);
    for (const group of groups.values()) {
        if (group.invalid || [...group.values.keys()].some((name) => !allowed.has(name)) ||
            [...required].some((name) => !group.values.has(name)) ||
            !["lower", "upper"].includes(group.values.get("array-bound-kind"))) continue;
        const array = integer(group.values.get("array-bound-symbol"), 1);
        const original = integer(group.values.get("array-bound-dimension"), 0);
        const selected = integer(group.values.get("array-bound-selected-dimension"), 1);
        const explicitText = group.values.get("array-bound-dimension-explicit") || "1";
        if (array === null || original === null || selected === null ||
            !["0", "1"].includes(explicitText) || (explicitText === "0") !== (original === 0) ||
            selected < original || selected >= group.result || original === 0 || selected === original) continue;
        const marker = markers.get(`${group.module}:${group.result}`);
        if (marker?.count !== 1 || marker.source !== array) continue;
        const resultExpression = expressions.get(group.result);
        const originalExpression = expressions.get(original);
        const statement = statementOwners.get(group.result);
        if (!resultExpression || resultExpression.physical !== true || !statement ||
            !originalExpression || originalExpression.physical !== true ||
            statementOwners.get(original) !== statement || statementOwners.get(selected) !== statement ||
            typeof originalExpression.typeName !== "string" || !originalExpression.typeName) continue;
        if (inputs.length >= MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];
        const selectedValues = constants.get(`${group.module}:${selected}`);
        inputs.push({
            module: group.module,
            result: group.result,
            kind: group.values.get("array-bound-kind"),
            sourceTypeName: originalExpression.typeName,
            selectedValue: selectedValues?.size === 1 ? selectedValues.values().next().value : null
        });
    }
    return inputs;
}

function compilerSemanticCallArgumentInputs(sidecar, cwd) {
    if (sidecar.recovery === true || !Array.isArray(sidecar.properties) ||
        sidecar.properties.length > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS * 8) return [];
    const availableModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "selected-call-argument-inputs" &&
            capability.coverage === "available")
        .map((capability) => capability.module));
    if (!availableModules.size) return [];
    const integer = (value, minimum = 1) => {
        if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
        const result = Number(value);
        return Number.isSafeInteger(result) && result >= minimum ? result : null;
    };
    const nodes = new Map((sidecar.nodes || []).map((node) => [node.id, node]));
    const nodeKinds = new Map((sidecar.properties || [])
        .filter((property) => property.domain === "node" && property.name === "kind")
        .map((property) => [property.identity, property.value]));
    const nodeInputs = new Map();
    for (const property of sidecar.properties) {
        if (property.domain !== "node" ||
            !["call-argument-expression", "default-argument"].includes(property.name)) continue;
        const key = `${property.module}:${property.identity}`;
        const group = nodeInputs.get(key) || { module: property.module, node: property.identity, values: new Map(), invalid: false };
        if (group.values.has(property.name)) group.invalid = true;
        else group.values.set(property.name, property.value);
        nodeInputs.set(key, group);
    }
    const procedureByParameter = new Map();
    const modeByParameter = new Map();
    const ordinalByParameter = new Map();
    for (const parameter of sidecar.procedureParameterModes || []) {
        if (!Number.isSafeInteger(parameter.parameter) || parameter.parameter < 1 ||
            !Number.isSafeInteger(parameter.procedure) || parameter.procedure < 1 ||
            !Number.isSafeInteger(parameter.ordinal) || parameter.ordinal < 0 ||
            typeof parameter.mode !== "string" || parameter.receiver === true) continue;
        const key = parameter.parameter;
        const procedures = procedureByParameter.get(key) || new Set();
        const modes = modeByParameter.get(key) || new Set();
        const ordinals = ordinalByParameter.get(key) || new Set();
        procedures.add(parameter.procedure);
        modes.add(parameter.mode);
        ordinals.add(parameter.ordinal);
        procedureByParameter.set(key, procedures);
        modeByParameter.set(key, modes);
        ordinalByParameter.set(key, ordinals);
    }
    const parameterNames = new Map();
    for (const binding of sidecar.bindings || []) {
        if (binding.role !== "declaration" || binding.physical !== true ||
            !Number.isSafeInteger(binding.symbol) || binding.symbol < 1 ||
            typeof binding.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(binding.name)) continue;
        const names = parameterNames.get(binding.symbol) || new Map();
        names.set(binding.name.toLowerCase(), binding.name);
        parameterNames.set(binding.symbol, names);
    }
    const expressionRanges = new Map();
    const addExpressionRange = (identity, range) => {
        const signature = JSON.stringify(range);
        if (!expressionRanges.has(identity)) expressionRanges.set(identity, { signature, range });
        else if (expressionRanges.get(identity)?.signature !== signature) expressionRanges.set(identity, null);
    };
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((file) => [file.id, file]));
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    for (const location of sidecar.physicalLocations || []) {
        if (location.domain !== "expression" || location.role !== "range" || location.status !== "mapped") continue;
        const context = sourceContexts.get(location.source);
        const file = context && sourceFiles.get(context.file);
        if (!file?.filePath) continue;
        addExpressionRange(location.subject, {
            filePath: normalizeCompilerPath(file.filePath, cwd),
            line: location.startLine - 1,
            startColumn: location.startColumn,
            endLine: location.endLine - 1,
            endColumn: location.endColumn
        });
    }
    for (const expression of sidecar.expressions || []) {
        if (expression.physical !== true || typeof expression.filePath !== "string" || !expression.filePath ||
            !Number.isSafeInteger(expression.startLine) || expression.startLine < 1 ||
            !Number.isSafeInteger(expression.startColumn) || expression.startColumn < 0 ||
            !Number.isSafeInteger(expression.endLine) || expression.endLine < expression.startLine ||
            !Number.isSafeInteger(expression.endColumn) || expression.endColumn < 0) continue;
        if (expressionRanges.has(expression.id)) continue;
        addExpressionRange(expression.id, {
            filePath: normalizeCompilerPath(expression.filePath, cwd),
            line: expression.startLine - 1,
            startColumn: expression.startColumn,
            endLine: expression.endLine - 1,
            endColumn: expression.endColumn
        });
    }
    const statementOwners = new Map((sidecar.statementOwners || [])
        .map((owner) => [`${owner.domain}:${owner.subject}`, owner.statement]));
    const sourceExpressions = new Map();
    for (const relation of sidecar.relationships || []) {
        if (relation.sourceDomain !== "node" || relation.targetDomain !== "expression" ||
            relation.kind !== "source-expression" || relation.ordinal !== 0) continue;
        const key = `${relation.module}:${relation.source}`;
        const values = sourceExpressions.get(key) || new Set();
        values.add(relation.target);
        sourceExpressions.set(key, values);
    }
    const resultsBySite = new Map();
    for (const group of nodeInputs.values()) {
        if (group.invalid || !availableModules.has(group.module) ||
            group.values.get("default-argument") !== "0") continue;
        const argument = nodes.get(group.node);
        if (!argument || nodeKinds.get(group.node) !== "argument" ||
            argument.edge !== "right" || !Number.isSafeInteger(argument.symbol) || argument.symbol < 1) continue;
        const expression = integer(group.values.get("call-argument-expression"), 1);
        const sourceLinks = sourceExpressions.get(`${group.module}:${group.node}`);
        const argumentStatement = statementOwners.get(`node:${group.node}`);
        if (expression === null || sourceLinks?.size !== 1 || !sourceLinks.has(expression) ||
            !Number.isSafeInteger(argumentStatement) || argumentStatement < 1 ||
            statementOwners.get(`expression:${expression}`) !== argumentStatement) continue;
        const expressionRange = expressionRanges.get(expression)?.range;
        const procedures = procedureByParameter.get(argument.symbol) || new Set();
        const modes = modeByParameter.get(argument.symbol) || new Set();
        const ordinals = ordinalByParameter.get(argument.symbol) || new Set();
        const names = parameterNames.get(argument.symbol);
        if (!expressionRange || procedures.size !== 1 || modes.size !== 1 || ordinals.size !== 1 || names?.size !== 1) continue;
        const procedure = procedures.values().next().value;
        const mode = modes.values().next().value;
        const parameterOrdinal = ordinals.values().next().value;
        if (!["byval", "byref", "bydesc"].includes(mode)) continue;

        let current = argument;
        let parent = current.parent ? nodes.get(current.parent) : null;
        let depth = 0;
        while (parent && nodeKinds.get(parent.id) === "argument" && depth < 512) {
            if (current.edge !== "right") { parent = null; break; }
            current = parent;
            parent = current.parent ? nodes.get(current.parent) : null;
            depth++;
        }
        if (!parent || nodeKinds.get(parent.id) !== "call" || current.edge !== "right" ||
            parent.symbol !== procedure || depth >= 512) continue;

        const record = {
            filePath: expressionRange.filePath,
            line: expressionRange.line,
            startColumn: expressionRange.startColumn,
            endLine: expressionRange.endLine,
            endColumn: expressionRange.endColumn,
            procedureSymbol: procedure,
            parameterOrdinal,
            parameterName: names.values().next().value,
            passingMode: mode
        };
        const key = [record.filePath, record.line, record.startColumn, record.endLine, record.endColumn].join(":");
        const previous = resultsBySite.get(key);
        const signature = JSON.stringify([
            record.procedureSymbol, record.parameterOrdinal,
            record.parameterName.toLowerCase(), record.passingMode
        ]);
        if (previous === undefined) resultsBySite.set(key, { signature, record });
        else if (previous && previous.signature !== signature) resultsBySite.set(key, null);
        if (resultsBySite.size > MAX_EDITOR_SEMANTIC_ASSIGNMENT_INPUTS) return [];
    }
    return [...resultsBySite.values()].filter(Boolean).map((entry) => entry.record);
}

function compilerSemanticPolicyFacts(sidecar, cwd) {
    const normalizePath = (fact) => ({ ...fact, filePath: normalizeCompilerPath(fact.filePath, cwd) });
    const fullModelInputs = compilerSemanticFullModelInputs(sidecar, cwd);
    return {
        semanticCommentMarkers: compilerSemanticCommentMarkers(sidecar, cwd),
        semanticTemporaryConstructions: compilerSemanticTemporaryConstructions(sidecar, cwd),
        semanticSourceHeaderPolicies: (sidecar.sourceHeaderPolicies || []).map(normalizePath),
        semanticHeaderLibraries: (sidecar.sourceHeaderLibraries || []).map((fact) => ({
            ...normalizePath(fact),
            location: fact.location ? { ...fact.location, filePath: normalizeCompilerPath(fact.location.filePath, cwd) } : null
        })),
        semanticNamespaceImportRecipients: compilerSemanticNamespaceImportRecipients(sidecar, cwd),
        semanticNamespaceDeclarations: (sidecar.namespaceDeclarations || []).map(normalizePath),
        semanticAbiPolicyInputs: fullModelInputs.abiPolicyInputs,
        semanticProcedureDeclarationInputs: fullModelInputs.declarationInputs,
        semanticAggregateAccessInputs: fullModelInputs.aggregateAccessInputs,
        semanticProcedureLinkageInputs: fullModelInputs.procedureLinkageInputs,
        semanticCallbackConventionInputs: fullModelInputs.callbackConventionInputs,
        semanticEnumDeclarationInputs: fullModelInputs.enumDeclarationInputs,
        semanticEnumElementInputs: fullModelInputs.enumElementInputs,
        semanticDeclarationTypingGroups: fullModelInputs.declarationTypingGroups,
        semanticDeclarationRepetitionInputs: fullModelInputs.declarationRepetitionInputs,
        semanticScalarStringDeclarationInputs: fullModelInputs.scalarStringDeclarationInputs,
        semanticArrayStorageInputs: fullModelInputs.arrayStorageInputs,
        semanticNormalizedTypes: compilerSemanticNormalizedTypes(sidecar),
        semanticArrayBounds: compilerSemanticArrayBounds(sidecar),
        semanticFieldLayouts: compilerSemanticFieldLayouts(sidecar),
        semanticSymbolVisibilities: compilerSemanticSymbolVisibilities(sidecar),
        semanticSymbolStorageClasses: compilerSemanticSymbolStorageClasses(sidecar),
        semanticAbstractTypeCounts: compilerSemanticAbstractTypeCounts(sidecar),
        semanticProcedureCallConventions: compilerSemanticProcedureCallConventions(sidecar),
        semanticProcedureOwnerKinds: compilerSemanticProcedureOwnerKinds(sidecar),
        semanticProcedureParameterModes: compilerSemanticProcedureParameterModes(sidecar),
        semanticIifInputs: compilerSemanticIifInputs(sidecar),
        semanticAssignmentTargets: compilerSemanticAssignmentTargets(sidecar),
        semanticArrayIndexInputs: compilerSemanticArrayIndexInputs(sidecar),
        semanticSelectedNumericOperands: compilerSemanticSelectedNumericOperands(sidecar),
        semanticSizeQueryInputs: compilerSemanticSizeQueryInputs(sidecar),
        semanticArrayBoundQueries: compilerSemanticArrayBoundQueries(sidecar),
        semanticCallArgumentInputs: compilerSemanticCallArgumentInputs(sidecar, cwd),
        semanticForEntryResults: compilerSemanticForEntryResults(sidecar, cwd),
        semanticIfConditionResults: compilerSemanticIfConditionResults(sidecar, cwd),
        semanticAssignmentInputs: compilerSemanticAssignmentInputs(sidecar, cwd),
        semanticEscapedStringRanges: compilerSemanticEscapedStringRanges(sidecar, cwd),
        semanticUnreachableStatements: compilerSemanticUnreachableStatements(sidecar, cwd)
    };
}

function compilerSemanticEscapedStringRanges(sidecar, cwd) {
    const escapesByContext = new Map();
    /* FBC serializes its true boolean value as -1 in compiler option snapshots. */
    for (const option of sidecar.configurationOptions || []) {
        if (option.source !== "language-default" || option.name !== "escapestr") continue;
        if (!Number.isSafeInteger(option.context) || option.context < 1 || ![0, -1].includes(option.value)) continue;
        if (escapesByContext.has(option.context) && escapesByContext.get(option.context) !== option.value) {
            escapesByContext.set(option.context, null);
        } else if (!escapesByContext.has(option.context)) escapesByContext.set(option.context, option.value);
    }
    if (!escapesByContext.size) return [];

    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((source) => [source.id, source]));
    const endings = new Map((sidecar.statementEndings || []).map((ending) => [ending.id, ending]));
    /* A header can be reached under more than one option context; publish only agreeing sites. */
    const statementModes = new Map();
    for (const statement of sidecar.statements || []) {
        if (statement.physical !== true) continue;
        const ending = endings.get(statement.id);
        if (!ending || ending.physical !== true || ending.outcome !== "parsed" ||
            !Number.isSafeInteger(statement.startLine) || !Number.isSafeInteger(statement.startColumn) ||
            !Number.isSafeInteger(ending.endLine) || !Number.isSafeInteger(ending.endColumn)) continue;
        const sourceContext = sourceContexts.get(statement.source);
        const sourceFile = sourceContext && sourceFiles.get(sourceContext.file);
        if (!sourceFile?.filePath || !statement.filePath || !ending.filePath ||
            compilerPathKey(sourceFile.filePath) !== compilerPathKey(statement.filePath) ||
            compilerPathKey(statement.filePath) !== compilerPathKey(ending.filePath) ||
            ending.endLine < statement.startLine ||
            ending.endLine === statement.startLine && ending.endColumn <= statement.startColumn) continue;
        const filePath = normalizeCompilerPath(statement.filePath, cwd);
        const site = JSON.stringify([compilerPathKey(filePath), statement.startLine, statement.startColumn,
            ending.endLine, ending.endColumn]);
        const mode = escapesByContext.get(statement.context);
        const selectedMode = mode === 0 || mode === -1 ? mode : null;
        const previous = statementModes.get(site);
        if (!previous) statementModes.set(site, {
            mode: selectedMode,
            filePath,
            startLine: statement.startLine,
            startColumn: statement.startColumn,
            endLine: ending.endLine,
            endColumn: ending.endColumn
        });
        else if (previous.mode !== selectedMode) previous.mode = null;
        if (statementModes.size > MAX_COMPILER_ESCAPED_STRING_RANGES) return [];
    }

    const ranges = [];
    for (const statement of statementModes.values()) {
        if (statement.mode !== -1) continue;
        if (ranges.length >= MAX_COMPILER_ESCAPED_STRING_RANGES) return [];
        ranges.push({
            filePath: statement.filePath,
            startLine: statement.startLine - 1,
            startColumn: statement.startColumn,
            endLine: statement.endLine - 1,
            endColumn: statement.endColumn
        });
    }
    return ranges.sort((first, second) => compilerPathKey(first.filePath).localeCompare(compilerPathKey(second.filePath)) ||
        first.startLine - second.startLine || first.startColumn - second.startColumn ||
        first.endLine - second.endLine || first.endColumn - second.endColumn);
}

/* The compiler's active preprocessed stream resolves conditional branches;
   the origin map ties accepted option lines back to the physical spelling. */
function compilerRemKeywordDisableOptions(analysis, compilerTexts, overlays) {
    const sourceLinesByFile = new Map();
    let sourceBytesScanned = 0;
    let sourceLineCount = 0;
    const diagnosedSourceSites = new Set((analysis.diagnostics || [])
        .filter((diagnostic) => ["error", "warning"].includes(diagnostic.severity) &&
            typeof diagnostic.filePath === "string")
        .flatMap((diagnostic) => {
            const line = diagnostic.physicalPoint?.line ?? diagnostic.line;
            return Number.isSafeInteger(line) && line > 0
                ? [`${compilerPathKey(diagnostic.filePath)}:${line}`]
                : [];
        }));
    const statements = [];
    let outputLine = 0;
    let lineStart = 0;
    while (lineStart <= analysis.text.length) {
        const lineEnd = analysis.text.indexOf("\n", lineStart);
        const nextLineStart = lineEnd < 0 ? analysis.text.length + 1 : lineEnd + 1;
        const line = analysis.text.slice(lineStart, lineEnd < 0 ? analysis.text.length : lineEnd).replace(/\r$/, "");
        if (!/^\s*option\s+nokeyword\b/i.test(line)) {
            outputLine++;
            lineStart = nextLineStart;
            continue;
        }
        const origin = analysis.origins?.[outputLine];
        if (!origin || origin.generated || typeof origin.filePath !== "string" ||
            !path.isAbsolute(origin.filePath) || !Number.isSafeInteger(origin.line) || origin.line < 0) {
            outputLine++;
            lineStart = nextLineStart;
            continue;
        }

        const key = compilerPathKey(origin.filePath);
        let sourceSnapshot = sourceLinesByFile.get(key);
        if (!sourceSnapshot) {
            const source = compilerTexts.get(key) ?? sourceTextForAnalysis(origin.filePath, overlays);
            if (typeof source !== "string") {
                outputLine++;
                lineStart = nextLineStart;
                continue;
            }
            sourceBytesScanned += Buffer.byteLength(source, "utf8");
            if (sourceBytesScanned > MAX_ANALYSIS_BYTES) return [];
            const lineOffsets = [0];
            for (const match of source.matchAll(/\r\n|\n|\r/g)) {
                lineOffsets.push(match.index + match[0].length);
                if (++sourceLineCount > MAX_COMPILER_REM_KEYWORD_SOURCE_LINES) return [];
            }
            sourceLineCount++;
            if (sourceLineCount > MAX_COMPILER_REM_KEYWORD_SOURCE_LINES) return [];
            sourceSnapshot = { text: source, lineOffsets };
            sourceLinesByFile.set(key, sourceSnapshot);
        }
        const sourceStart = sourceSnapshot.lineOffsets[origin.line];
        const sourceEnd = sourceSnapshot.lineOffsets[origin.line + 1] ?? sourceSnapshot.text.length;
        const sourceLine = Number.isSafeInteger(sourceStart)
            ? sourceSnapshot.text.slice(sourceStart, sourceEnd).replace(/[\r\n]+$/, "").replace(/^\uFEFF/, "")
            : "";
        if (typeof sourceLine === "string" && optionDisablesRemKeyword(sourceLine) &&
            !diagnosedSourceSites.has(`${key}:${origin.line + 1}`)) {
            if (statements.length >= MAX_COMPILER_REM_KEYWORD_DISABLED_STATEMENTS) return [];
            statements.push({ filePath: path.resolve(origin.filePath), line: origin.line + 1 });
        }
        outputLine++;
        lineStart = nextLineStart;
    }
    return statements;
}

function compilerSemanticCommentMarkers(sidecar, cwd) {
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((source) => [source.id, source]));
    const locations = new Map((sidecar.physicalLocations || [])
        .filter((location) => location.domain === "comment" && location.role === "marker")
        .map((location) => [location.subject, location]));
    const markers = [];
    for (const comment of sidecar.comments || []) {
        const location = locations.get(comment.id);
        const context = location && sourceContexts.get(location.source);
        const file = context && sourceFiles.get(context.file);
        if (!location || location.status !== "mapped" || !file?.filePath ||
            !["apostrophe", "rem"].includes(comment.kind)) continue;
        markers.push({
            kind: comment.kind,
            filePath: normalizeCompilerPath(file.filePath, cwd),
            startLine: location.startLine,
            startColumn: location.startColumn,
            endLine: location.endLine,
            endColumn: location.endColumn,
            status: location.status
        });
    }
    return markers;
}

function compilerSemanticProcedureOwnerKinds(sidecar) {
    if (sidecar.recovery) return [];
    const symbols = new Map((sidecar.symbolOwners || []).map((symbol) => [symbol.symbol, symbol]));
    const kinds = new Map();
    for (const procedure of symbols.values()) {
        if (procedure.kind !== "procedure") continue;
        const owner = symbols.get(procedure.owner)?.kind;
        if (["type", "union", "class"].includes(owner)) kinds.set(procedure.symbol, "method");
        else if (owner === "namespace") kinds.set(procedure.symbol, "function");
    }
    return [...kinds].map(([symbol, kind]) => ({ symbol, kind }));
}

function compilerSemanticNormalizedTypes(sidecar) {
    if (sidecar.recovery) return [];
    const sourceSymbols = new Set((sidecar.bindings || [])
        .filter((binding) => binding.physical === true)
        .map((binding) => binding.symbol));
    return (sidecar.normalizedTypes || [])
        .filter((type) => type.domain === "symbol" && sourceSymbols.has(type.identity))
        .map((type) => ({
            identity: type.identity,
            primitive: type.primitive,
            nominal: type.nominal,
            pointerDepth: type.pointerDepth,
            isReference: type.isReference,
            constBits: type.constBits,
            storageBytes: type.storageBytes
        }));
}

function compilerSemanticArrayBounds(sidecar) {
    if (sidecar.recovery) return [];
    const sourceSymbols = new Set((sidecar.bindings || [])
        .filter((binding) => binding.role === "declaration" && binding.physical === true)
        .map((binding) => binding.symbol));
    const groups = new Map();
    for (const detail of sidecar.arrayBounds || []) {
        const { symbol: identity, rank, dimension, kind, lower, upper } = detail;
        if (!Number.isSafeInteger(identity) || identity < 1 || !sourceSymbols.has(identity) ||
            !Number.isSafeInteger(rank) || !Number.isSafeInteger(dimension)) continue;

        let group = groups.get(identity);
        if (!group) {
            group = { rank, runtime: false, dimensions: new Map(), invalid: false };
            groups.set(identity, group);
        }
        if (group.rank !== rank) {
            group.invalid = true;
            continue;
        }

        if (kind === "runtime") {
            if (dimension !== -1 || lower !== null || upper !== null || group.dimensions.size) {
                group.invalid = true;
                continue;
            }
            group.runtime = true;
            continue;
        }

        if (rank < 1 || dimension < 0 || dimension >= rank || !Number.isSafeInteger(lower) ||
            !["fixed", "unknown"].includes(kind) || kind === "fixed" && !Number.isSafeInteger(upper) ||
            kind === "unknown" && upper !== null || group.runtime) {
            group.invalid = true;
            continue;
        }
        const bound = { dimension, kind, lower, upper };
        const previous = group.dimensions.get(dimension);
        if (previous && JSON.stringify(previous) !== JSON.stringify(bound)) group.invalid = true;
        else group.dimensions.set(dimension, bound);
    }

    const bounds = [];
    for (const [identity, group] of groups) {
        if (group.invalid) continue;
        if (group.runtime) {
            bounds.push({ identity, rank: group.rank < 0 ? null : group.rank, mode: "runtime", dimensions: [] });
            continue;
        }
        if (group.rank < 1 || group.dimensions.size !== group.rank ||
            [...group.dimensions.keys()].some((dimension, index) => dimension !== index)) continue;
        bounds.push({
            identity,
            rank: group.rank,
            mode: "bounds",
            dimensions: [...group.dimensions.values()].sort((first, second) => first.dimension - second.dimension)
        });
    }
    return bounds;
}

function compilerSemanticFieldLayouts(sidecar) {
    if (sidecar.recovery) return [];
    const sourceSymbols = new Set((sidecar.bindings || [])
        .filter((binding) => binding.role === "declaration" && binding.physical === true)
        .map((binding) => binding.symbol));
    return (sidecar.fieldLayouts || []).filter((layout) =>
        sourceSymbols.has(layout.symbol) && Number.isSafeInteger(layout.owner) && layout.owner > 0 &&
        Number.isSafeInteger(layout.byteOffset) && layout.byteOffset >= 0
    );
}

function compilerSemanticSymbolVisibilities(sidecar) {
    if (sidecar.recovery) return [];
    const sourceSymbols = new Set((sidecar.bindings || [])
        .filter((binding) => binding.role === "declaration" && binding.physical === true)
        .map((binding) => binding.symbol));
    return (sidecar.symbolVisibilities || []).filter((symbol) =>
        sourceSymbols.has(symbol.symbol) && ["public", "private", "protected"].includes(symbol.visibility)
    );
}

function compilerSemanticAbstractTypeCounts(sidecar) {
    if (sidecar.recovery) return [];
    const sourceSymbols = new Set((sidecar.bindings || [])
        .filter((binding) => binding.role === "declaration" && binding.physical === true)
        .map((binding) => binding.symbol));
    return (sidecar.abstractTypeCounts || []).filter((type) =>
        sourceSymbols.has(type.symbol) && Number.isSafeInteger(type.count) && type.count >= 0
    );
}

function compilerSemanticSymbolStorageClasses(sidecar) {
    if (sidecar.recovery) return [];
    const sourceSymbols = new Set((sidecar.bindings || [])
        .filter((binding) => binding.role === "declaration" && binding.physical === true)
        .map((binding) => binding.symbol));
    return (sidecar.symbolStorageClasses || []).filter((symbol) =>
        sourceSymbols.has(symbol.symbol) &&
        ["external", "static", "local", "shared", "global", "none", "parameter", "field", "constant"]
            .includes(symbol.storage)
    );
}

function compilerSemanticProcedureCallConventions(sidecar) {
    if (sidecar.recovery) return [];
    const sourceSymbols = new Set((sidecar.bindings || [])
        .filter((binding) => binding.role === "declaration" && binding.physical === true)
        .map((binding) => binding.symbol));
    return (sidecar.procedureCallConventions || []).filter((procedure) =>
        sourceSymbols.has(procedure.symbol) && typeof procedure.callingConvention === "string" &&
        typeof procedure.returnByReference === "boolean"
    );
}

function compilerSemanticProcedureParameterModes(sidecar) {
    if (sidecar.recovery) return [];
    const sourceSymbols = new Set((sidecar.bindings || [])
        .filter((binding) => binding.role === "declaration" && binding.physical === true)
        .map((binding) => binding.symbol));
    // THIS has no written declaration token. Its source procedure still
    // proves the receiver slot needed to align native argument hints.
    return (sidecar.procedureParameterModes || []).filter((parameter) =>
        sourceSymbols.has(parameter.parameter) || sourceSymbols.has(parameter.variable) ||
        parameter.receiver === true && sourceSymbols.has(parameter.procedure)
    );
}

function compilerSemanticForEntryResults(sidecar, cwd) {
    const coverageByModule = new Map((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "scalar-for-entry-results")
        .map((capability) => [capability.module, capability.coverage]));
    const statements = new Map((sidecar.statements || []).map((statement) => [
        `${statement.module}:${statement.id}`, statement
    ]));
    const endings = new Map((sidecar.statementEndings || []).map((ending) => [ending.id, ending]));
    const openingLocations = new Map((sidecar.physicalLocations || [])
        .filter((location) => location.domain === "statement" && location.role === "opening-token")
        .map((location) => [location.subject, location]));
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((file) => [file.id, file]));
    const counterOwners = new Set((sidecar.properties || []).flatMap((property) => {
        const match = /^for-counter:([1-9]\d*)$/.exec(property.name);
        return property.domain === "symbol" && match
            ? [`${property.module}:${property.identity}:${match[1]}`]
            : [];
    }));
    const results = [];
    for (const property of sidecar.properties || []) {
        const match = /^for-entry-result:([1-9]\d*)$/.exec(property.name);
        if (property.domain !== "symbol" || !match || !["skip", "enter"].includes(property.value) ||
            coverageByModule.get(property.module) !== "available") continue;
        const statementId = Number(match[1]);
        const statement = statements.get(`${property.module}:${statementId}`);
        const ending = endings.get(statementId);
        const location = openingLocations.get(statementId);
        const context = location && sourceContexts.get(location.source);
        const file = context && sourceFiles.get(context.file);
        if (!statement || !ending || !location || !context || !file ||
            !counterOwners.has(`${property.module}:${property.identity}:${statementId}`) ||
            statement.module !== property.module || statement.physical !== true ||
            ending.outcome !== "parsed" ||
            context.module !== property.module || location.source !== statement.source ||
            file.kind !== "regular" || location.status !== "mapped" ||
            !Number.isSafeInteger(location.startLine) || !Number.isSafeInteger(location.startColumn) ||
            !Number.isSafeInteger(location.endLine) || !Number.isSafeInteger(location.endColumn)) continue;
        results.push({
            symbol: property.identity,
            statement: statementId,
            result: property.value,
            filePath: normalizeCompilerPath(file.filePath, cwd),
            startLine: location.startLine,
            startColumn: location.startColumn,
            endLine: location.endLine,
            endColumn: location.endColumn,
            provisional: Boolean(sidecar.recovery)
        });
    }
    return results;
}

function compilerSemanticFullModelInputs(sidecar, cwd) {
    const properties = (sidecar.properties || []).filter((property) =>
        property.name === "enum-declaration-input" ||
        property.name === "enum-element-input" ||
        property.name === "scalar-string-declaration" ||
        property.name.startsWith("array-storage-") ||
        property.name.startsWith("declaration-type-") ||
        property.name.startsWith("redeclaration-input:") ||
        property.name.startsWith("procedure-abi-input:") ||
        property.name.startsWith("callback-convention-input:") ||
        property.name.startsWith("abi-policy-input:") ||
        property.name.startsWith("procedure-typing-input:") ||
        property.name.startsWith("procedure-written-visibility:") ||
        property.name === "formal-written-type" ||
        property.name === "aggregate-body-statement" ||
        property.name === "aggregate-access-count" ||
        property.name.startsWith("aggregate-access-section:")
    );
    if (!properties.length) return {
        abiPolicyInputs: [], declarationInputs: [], aggregateAccessInputs: [],
        procedureLinkageInputs: [], callbackConventionInputs: [],
        enumDeclarationInputs: [], enumElementInputs: [], declarationTypingGroups: [],
        declarationRepetitionInputs: [], scalarStringDeclarationInputs: [], arrayStorageInputs: []
    };

    const statements = new Map((sidecar.statements || []).map((statement) => [`${statement.module}:${statement.id}`, statement]));
    const statementsById = new Map((sidecar.statements || []).map((statement) => [statement.id, statement]));
    const statementsByEnd = new Map((sidecar.statementEndings || []).map((ending) => [ending.id, ending]));
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((source) => [source.id, source]));
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((context) => [context.id, context]));
    const constructsByStatement = new Map();
    for (const construct of sidecar.constructs || []) {
        if (construct.kind !== "enum") continue;
        const sourceContext = sourceContexts.get(construct.source);
        const key = `${sourceContext?.module}:${construct.statement}`;
        if (!sourceContext || constructsByStatement.has(key)) {
            throw new Error("Compiler enum construct has an invalid or repeated opening statement.");
        }
        constructsByStatement.set(key, construct);
    }
    const bindingStatementOwners = new Map((sidecar.statementOwners || [])
        .filter((owner) => owner.domain === "binding")
        .map((owner) => [owner.subject, owner.statement]));
    const relationships = new Map();
    for (const relationship of sidecar.relationships || []) {
        if (relationship.sourceDomain !== "symbol" || relationship.targetDomain !== "symbol" ||
            relationship.source !== relationship.target || !relationship.kind.startsWith("abi-policy-input:")) continue;
        const key = `${relationship.module}:${relationship.source}:${relationship.kind}`;
        if (relationships.has(key)) throw new Error("Compiler ABI policy input has repeated statement ownership.");
        relationships.set(key, relationship);
    }

    const contextKey = (sourceContextId) => {
        const chain = [];
        const visited = new Set();
        let current = sourceContextId;
        while (current) {
            if (visited.has(current) || chain.length >= 17) throw new Error("Compiler ABI policy source context is cyclic or too deep.");
            visited.add(current);
            const context = sourceContexts.get(current);
            const source = context && sourceFiles.get(context.file);
            if (!context || !source?.filePath) throw new Error("Compiler ABI policy input has no captured source context.");
            const directive = context.directive ? [
                normalizeCompilerPath(context.directive.filePath, cwd),
                context.directive.startLine,
                context.directive.startColumn
            ] : null;
            chain.push([
                context.kind,
                normalizeCompilerPath(source.filePath, cwd),
                context.requested,
                directive
            ]);
            current = context.parent;
        }
        return JSON.stringify(chain.reverse());
    };

    const statementAnchor = (module, statementId) => {
        const statement = statements.get(`${module}:${statementId}`);
        if (!statement) throw new Error("Compiler procedure policy has no accepted source statement.");
        return {
            module: statement.module,
            source: contextKey(statement.source),
            filePath: normalizeCompilerPath(statement.filePath, cwd),
            line: statement.startLine,
            startColumn: statement.physical ? statement.startColumn : null,
            ordinal: statement.ordinal,
            tokenClass: statement.tokenClass,
            physical: statement.physical
        };
    };
    const semanticInputInteger = (value, label, minimum = 0) => {
        if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
            throw new Error(`Compiler semantic ${label} is not a canonical integer.`);
        }
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < minimum) {
            throw new Error(`Compiler semantic ${label} is outside the supported range.`);
        }
        return result;
    };

    const abiPolicyInputs = [];
    const declarationInputs = [];
    const procedureLinkageInputs = [];
    const callbackConventionInputs = [];
    const enumDeclarationInputs = [];
    const enumElementInputs = [];
    const declarationTypingGroups = [];
    const declarationRepetitionInputs = [];
    const scalarStringDeclarationInputs = [];
    const arrayStorageInputs = [];
    const enumDeclarations = new Map();
    const enumHeadersByStatement = new Map();
    const enumOrdinals = new Map();
    const callbackCountsByStatement = new Map();
    const linkageCallbackCounts = [];
    const aggregateGroups = new Map();
    const declarationRepetitionIdentities = new Set();
    const scalarStringDeclarationIdentities = new Set();
    const arrayStorageGroups = new Map();
    const expressionsById = new Map((sidecar.expressions || []).map((expression) => [expression.id, expression]));
    const capabilityCoverage = new Map((sidecar.capabilities || []).map((capability) => [
        `${capability.module}:${capability.feature}`, capability.coverage
    ]));
    const semanticStatementOwners = new Map((sidecar.statementOwners || []).map((owner) => [
        `${owner.domain}:${owner.subject}`, owner.statement
    ]));
    const physicalLocations = new Map((sidecar.physicalLocations || []).map((location) => [
        `${location.domain}:${location.subject}:${location.role}`, location
    ]));
    const arrayStorageRootsByNode = new Map();
    for (const relationship of sidecar.relationships || []) {
        if (relationship.kind !== "array-storage-root") continue;
        const key = `${relationship.module}:${relationship.target}`;
        if (arrayStorageRootsByNode.has(key)) throw new Error("Compiler array storage root is repeated.");
        arrayStorageRootsByNode.set(key, relationship);
    }
    for (const property of properties) {
        if (!property.name.startsWith("array-storage-")) continue;
        if (property.domain !== "expression" || capabilityCoverage.get(`${property.module}:array-storage-inputs`) !== "available" ||
            !["array-storage-symbol", "array-storage-kind", "array-storage-receiver"].includes(property.name)) {
            throw new Error("Compiler array storage input has an invalid property, domain, or capability.");
        }
        const key = `${property.module}:${property.identity}`;
        let group = arrayStorageGroups.get(key);
        if (!group) {
            group = { module: property.module, expression: property.identity, values: new Map() };
            arrayStorageGroups.set(key, group);
        }
        if (group.values.has(property.name)) throw new Error("Compiler array storage property is repeated.");
        group.values.set(property.name, property.value);
    }
    const declarationTypingGroupsByKey = new Map();
    const declarationTypingGroupKey = (module, owner, identity) => `${module}:${owner}:${identity}`;
    for (const property of properties) {
        if (!property.name.startsWith("declaration-type-group:")) continue;
        const match = /^declaration-type-group:([1-9]\d*)$/.exec(property.name);
        if (!match) throw new Error("Compiler declaration typing group has a noncanonical identity.");
        const values = property.value.split("\t");
        if (property.domain !== "symbol" || values.length !== 2 ||
            !["dim", "static", "common", "extern", "const", "var"].includes(values[1]) ||
            capabilityCoverage.get(`${property.module}:declaration-typing-inputs`) !== "available") {
            throw new Error("Compiler declaration typing group has an invalid owner, grammar, or capability.");
        }
        const identity = semanticInputInteger(match[1], "declaration group identity", 1);
        const statementId = semanticInputInteger(values[0], "declaration statement", 1);
        const key = declarationTypingGroupKey(property.module, property.identity, identity);
        const statement = statements.get(`${property.module}:${statementId}`);
        if (declarationTypingGroupsByKey.has(key)) {
            throw new Error("Compiler declaration typing group is repeated.");
        }
        if (!statement) {
            if (sidecar.recovery) continue;
            throw new Error("Compiler declaration typing group has no accepted source statement.");
        }
        if (statement.owner && statement.owner !== property.identity) {
            throw new Error("Compiler declaration typing group belongs to another statement owner.");
        }
        declarationTypingGroupsByKey.set(key, {
            module: property.module,
            owner: property.identity,
            identity,
            kind: values[1],
            statementId,
            statement: statementAnchor(property.module, statementId),
            inputs: new Map(),
            count: null,
            provisional: Boolean(sidecar.recovery)
        });
    }
    for (const property of properties) {
        if (!property.name.startsWith("declaration-type-end:")) continue;
        const match = /^declaration-type-end:([1-9]\d*)$/.exec(property.name);
        if (!match) throw new Error("Compiler declaration typing completion has a noncanonical identity.");
        const identity = semanticInputInteger(match[1], "declaration group identity", 1);
        const count = semanticInputInteger(property.value, "declaration input count", 1);
        const key = declarationTypingGroupKey(property.module, property.identity, identity);
        const group = declarationTypingGroupsByKey.get(key);
        if (property.domain !== "symbol" || !group || group.count !== null) {
            if (sidecar.recovery && !group) continue;
            throw new Error("Compiler declaration typing completion has no matching group.");
        }
        group.count = count;
    }
    for (const property of properties) {
        if (property.name !== "enum-declaration-input") continue;
        const values = property.value.split("\t");
        const statementId = semanticInputInteger(values[0], "declaration statement", 1);
        const count = semanticInputInteger(values[1], "declaration member count", 1);
        const statement = statements.get(`${property.module}:${statementId}`);
        const ending = statementsByEnd.get(statementId);
        const construct = constructsByStatement.get(`${property.module}:${statementId}`);
        if (property.domain !== "symbol" || values.length !== 2 || enumDeclarations.has(property.identity)) {
            throw new Error("Compiler enum declaration input has no accepted enum header.");
        }
        if (!statement || !construct || !ending ||
            !["declaration", "aggregate-member"].includes(ending.route) || ending.outcome !== "parsed") {
            if (sidecar.recovery) continue;
            throw new Error("Compiler enum declaration input has no accepted enum header.");
        }
        const declaration = {
            ...statementAnchor(property.module, statementId),
            symbol: property.identity,
            construct: construct.id,
            count,
            provisional: Boolean(sidecar.recovery)
        };
        enumDeclarations.set(property.identity, declaration);
        enumHeadersByStatement.set(`${property.module}:${statementId}`, property.identity);
        enumOrdinals.set(property.identity, new Set());
        enumDeclarationInputs.push(declaration);
    }
    for (const property of properties) {
        if (property.name.startsWith("array-storage-")) continue;
        if (property.name === "enum-declaration-input") continue;
        if (property.name === "enum-element-input") {
            const values = property.value.split("\t");
            if (property.domain !== "symbol" || values.length !== 5 || !["0", "1"].includes(values[3])) {
                throw new Error("Compiler enum member input has an invalid payload.");
            }
            const owner = semanticInputInteger(values[0], "member owner", 1);
            const ordinal = semanticInputInteger(values[1], "member ordinal", 1);
            const statementId = semanticInputInteger(values[2], "member statement", 1);
            const initializer = semanticInputInteger(values[4], "member initializer");
            const enumDeclaration = enumDeclarations.get(owner);
            const statement = statements.get(`${property.module}:${statementId}`);
            const ending = statementsByEnd.get(statementId);
            if (!enumDeclaration || enumDeclaration.module !== property.module || !statement ||
                statement.construct !== enumDeclaration.construct || ordinal > enumDeclaration.count ||
                (values[3] === "1") !== (initializer > 0) || enumOrdinals.get(owner).has(ordinal)) {
                if (sidecar.recovery) continue;
                throw new Error("Compiler enum member input disagrees with its declared enum group.");
            }
            if (!ending || ending.route !== "enumerator" || ending.outcome !== "parsed") {
                if (sidecar.recovery) continue;
                throw new Error("Compiler enum member input has no accepted enumerator statement.");
            }
            const memberCount = enumOrdinals.get(owner);
            memberCount.add(ordinal);
            enumElementInputs.push({
                ...statementAnchor(property.module, statementId),
                symbol: property.identity,
                owner,
                ordinal,
                explicit: values[3] === "1",
                initializerType: initializer && expressionsById.has(initializer) ? {
                    dtype: expressionsById.get(initializer).dtype,
                    subtype: expressionsById.get(initializer).subtype
                } : null,
                provisional: Boolean(sidecar.recovery)
            });
            continue;
        }

        if (property.name === "scalar-string-declaration") {
            const values = property.value.split("\t");
            if (property.domain !== "symbol" || values.length !== 4 ||
                !["dim", "static", "field"].includes(values[2]) ||
                capabilityCoverage.get(`${property.module}:scalar-string-declarations`) !== "available") {
                throw new Error("Compiler scalar String declaration has an invalid owner, kind, or capability.");
            }
            const statementId = semanticInputInteger(values[0], "scalar String declaration statement", 1);
            const initializer = semanticInputInteger(values[1], "scalar String initializer");
            const sourceId = semanticInputInteger(values[3], "scalar String source context", 1);
            const key = `${property.module}:${property.identity}`;
            if (scalarStringDeclarationIdentities.has(key)) {
                throw new Error("Compiler scalar String declaration observation is repeated.");
            }
            scalarStringDeclarationIdentities.add(key);
            const statement = statements.get(`${property.module}:${statementId}`);
            const ending = statementsByEnd.get(statementId);
            const sourceContext = sourceContexts.get(sourceId);
            const expectedRoute = values[2] === "field" ? "aggregate-member" : "declaration";
            if (!statement || !ending || ending.route !== expectedRoute || ending.outcome !== "parsed" ||
                statement.source !== sourceId || sourceContext?.module !== property.module) {
                if (sidecar.recovery) continue;
                throw new Error("Compiler scalar String declaration has no accepted same-source statement.");
            }
            scalarStringDeclarationInputs.push({
                ...statementAnchor(property.module, statementId),
                symbol: property.identity,
                kind: values[2],
                hasInitializer: initializer > 0,
                provisional: Boolean(sidecar.recovery)
            });
            continue;
        }

        if (property.name.startsWith("redeclaration-input:")) {
            const match = /^redeclaration-input:([1-9]\d*)$/.exec(property.name);
            const fields = property.value.split("\t");
            if (!match || property.domain !== "symbol" || fields.length !== 4 ||
                !["extern", "typedef", "prototype"].includes(fields[1]) || !["0", "1"].includes(fields[2]) ||
                capabilityCoverage.get(`${property.module}:declaration-repetition-inputs`) !== "available") {
                throw new Error("Compiler declaration repetition input has an invalid key, payload, or capability.");
            }
            const identity = semanticInputInteger(match[1], "declaration repetition identity", 1);
            const statementId = semanticInputInteger(fields[0], "repeated declaration statement", 1);
            const sourceId = semanticInputInteger(fields[3], "repeated declaration source context", 1);
            const key = `${property.module}:${identity}`;
            if (declarationRepetitionIdentities.has(key)) {
                throw new Error("Compiler declaration repetition identity is repeated.");
            }
            declarationRepetitionIdentities.add(key);
            const statement = statements.get(`${property.module}:${statementId}`);
            const ending = statementsByEnd.get(statementId);
            const sourceContext = sourceContexts.get(sourceId);
            if (!statement || !ending || ending.outcome !== "parsed" || statement.source !== sourceId ||
                sourceContext?.module !== property.module) {
                if (sidecar.recovery) continue;
                throw new Error("Compiler declaration repetition input has no accepted source statement.");
            }
            declarationRepetitionInputs.push({
                ...statementAnchor(property.module, statementId),
                statementId,
                symbol: property.identity,
                kind: fields[1],
                repeated: fields[2] === "1",
                provisional: Boolean(sidecar.recovery)
            });
            continue;
        }

        if (property.name.startsWith("declaration-type-")) {
            if (property.name.startsWith("declaration-type-group:") ||
                property.name.startsWith("declaration-type-end:")) continue;
            const match = /^declaration-type-input:([1-9]\d*):([1-9]\d*)$/.exec(property.name);
            if (!match || property.domain !== "symbol") {
                throw new Error("Compiler declaration typing input has an invalid property name or owner.");
            }
            const values = property.value.split("\t");
            if (values.length !== 4 || !["as", "suffix", "implicit", "inferred"].includes(values[1])) {
                throw new Error("Compiler declaration typing input has an invalid payload.");
            }
            const identity = semanticInputInteger(match[1], "declaration group identity", 1);
            const ordinal = semanticInputInteger(match[2], "declaration input ordinal", 1);
            const declaredSymbol = semanticInputInteger(values[0], "declared symbol", 1);
            const initializerKind = semanticInputInteger(values[2], "initializer kind");
            const sourceId = semanticInputInteger(values[3], "declaration source context", 1);
            const key = declarationTypingGroupKey(property.module, property.identity, identity);
            const group = declarationTypingGroupsByKey.get(key);
            const sourceContext = sourceContexts.get(sourceId);
            if (!group) {
                if (sidecar.recovery) continue;
                throw new Error("Compiler declaration typing input has no matching group.");
            }
            if (initializerKind > 3 || !sourceContext || sourceContext.module !== property.module ||
                group.inputs.has(ordinal)) {
                throw new Error("Compiler declaration typing input has an invalid initializer, context, or ordinal.");
            }
            group.inputs.set(ordinal, {
                ordinal,
                symbol: declaredSymbol,
                writtenType: values[1],
                initializerKind,
                source: contextKey(sourceId)
            });
            continue;
        }

        const procedureAbi = /^procedure-abi-input:([1-9]\d*)$/.exec(property.name);
        if (property.name.startsWith("procedure-abi-input:")) {
            if (!procedureAbi || property.domain !== "symbol") {
                throw new Error("Compiler procedure ABI input has an invalid identity.");
            }
            const fields = property.value.split("\t");
            const statementId = Number(fields[0]);
            const sourceId = Number(fields[4]);
            const callbackCount = Number(fields[5]);
            const detailIdentity = Number(procedureAbi[1]);
            const statement = statements.get(`${property.module}:${statementId}`);
            const sourceContext = sourceContexts.get(sourceId);
            const relationship = relationships.get(
                `${property.module}:${property.identity}:abi-policy-input:${procedureAbi[1]}`
            );
            if (fields.length !== 6 || !Number.isSafeInteger(detailIdentity) || detailIdentity < 1 ||
                !/^[1-9]\d*$/.test(fields[0]) || !/^[1-9]\d*$/.test(fields[4]) ||
                !Number.isSafeInteger(statementId) || statementId < 1 ||
                !["prototype", "definition"].includes(fields[1]) ||
                !["0", "1"].includes(fields[2]) || !["0", "1"].includes(fields[3]) ||
                !Number.isSafeInteger(sourceId) || sourceId < 1 ||
                !/^(?:0|[1-9]\d*)$/.test(fields[5]) || !Number.isSafeInteger(callbackCount) || callbackCount < 0 ||
                !statement || statement.source !== sourceId || sourceContext?.module !== property.module ||
                !relationship || relationship.ordinal !== statementId) {
                throw new Error("Compiler procedure ABI input has no matching accepted source statement.");
            }
            procedureLinkageInputs.push({
                ...statementAnchor(property.module, statementId),
                symbol: property.identity,
                role: fields[1],
                hasLibrary: fields[2] === "1",
                hasAlias: fields[3] === "1",
                callbackCount,
                provisional: Boolean(sidecar.recovery)
            });
            linkageCallbackCounts.push({ key: `${property.module}:${statementId}`, expected: callbackCount });
            continue;
        }

        if (property.name.startsWith("callback-convention-input:")) {
            const callbackConvention = /^callback-convention-input:([1-9]\d*)$/.exec(property.name);
            if (!callbackConvention || property.domain !== "symbol") {
                throw new Error("Compiler callback convention input has an invalid identity.");
            }
            const fields = property.value.split("\t");
            const statementId = Number(fields[0]);
            const sourceId = Number(fields[2]);
            const statement = statements.get(`${property.module}:${statementId}`);
            const sourceContext = sourceContexts.get(sourceId);
            if (!Number.isSafeInteger(Number(callbackConvention[1])) || fields.length !== 3 ||
                !/^[1-9]\d*$/.test(fields[0]) || !/^[1-9]\d*$/.test(fields[2]) ||
                !Number.isSafeInteger(statementId) || statementId < 1 ||
                !["0", "1"].includes(fields[1]) || !Number.isSafeInteger(sourceId) || sourceId < 1 ||
                !statement || statement.source !== sourceId || sourceContext?.module !== property.module) {
                throw new Error("Compiler callback convention input has no matching accepted source statement.");
            }
            callbackConventionInputs.push({
                ...statementAnchor(property.module, statementId),
                symbol: property.identity,
                explicit: fields[1] === "1",
                provisional: Boolean(sidecar.recovery)
            });
            const key = `${property.module}:${statementId}`;
            callbackCountsByStatement.set(key, (callbackCountsByStatement.get(key) || 0) + 1);
            continue;
        }

        if (["aggregate-body-statement", "aggregate-access-count"].includes(property.name) ||
            property.name.startsWith("aggregate-access-section:")) {
            if (property.domain !== "symbol") throw new Error("Compiler aggregate access input is not type-owned.");
            const key = `${property.module}:${property.identity}`;
            let group = aggregateGroups.get(key);
            if (!group) {
                group = { module: property.module, owner: property.identity, bodyStatement: null, count: null, sections: [] };
                aggregateGroups.set(key, group);
            }
            if (property.name === "aggregate-body-statement") {
                const statementId = Number(property.value);
                if (!Number.isSafeInteger(statementId) || statementId < 1 || group.bodyStatement !== null) {
                    throw new Error("Compiler aggregate body statement receipt is invalid or repeated.");
                }
                group.bodyStatement = statementId;
            } else if (property.name === "aggregate-access-count") {
                const count = Number(property.value);
                if (!/^(?:0|[1-9]\d*)$/.test(property.value) || !Number.isSafeInteger(count) || group.count !== null) {
                    throw new Error("Compiler aggregate access count receipt is invalid or repeated.");
                }
                group.count = count;
            } else {
                const match = /^aggregate-access-section:(\d+)$/.exec(property.name);
                const fields = property.value.split("\t");
                const ordinal = Number(match?.[1]);
                const statementId = Number(fields[0]);
                if (!match || !Number.isSafeInteger(ordinal) || ordinal < 1 || fields.length !== 2 ||
                    !Number.isSafeInteger(statementId) || statementId < 1 ||
                    !["public", "private", "protected"].includes(fields[1]) ||
                    group.sections.some((section) => section.ordinal === ordinal)) {
                    throw new Error("Compiler aggregate access section receipt is invalid or repeated.");
                }
                group.sections.push({ ordinal, statement: statementId, visibility: fields[1] });
            }
            continue;
        }

        if (property.name.startsWith("abi-policy-input:")) {
            if (property.domain !== "symbol") throw new Error("Compiler ABI policy input is not procedure-owned.");
            const relationship = relationships.get(`${property.module}:${property.identity}:${property.name}`);
            if (!relationship) throw new Error("Compiler ABI policy input has no accepted statement relationship.");
            const fields = property.value.split("\t");
            if (fields.length !== 2 || !["0", "1"].includes(fields[0]) || !["0", "1"].includes(fields[1])) {
                throw new Error("Compiler ABI policy input has invalid Boolean fields.");
            }
            abiPolicyInputs.push({
                ...statementAnchor(property.module, relationship.ordinal),
                writtenConvention: fields[0] === "1",
                managedString: fields[1] === "1",
                provisional: Boolean(sidecar.recovery)
            });
            continue;
        }

        if (property.domain !== "symbol") throw new Error("Compiler procedure declaration input is not symbol-owned.");
        if (property.name === "formal-written-type") {
            if (!["as", "suffix", "implicit", "vararg"].includes(property.value)) {
                throw new Error("Compiler formal written-type input has an invalid value.");
            }
            const declarations = [];
            (sidecar.bindings || []).forEach((binding, index) => {
                if (binding.symbol !== property.identity || binding.role !== "declaration") return;
                const statementId = bindingStatementOwners.get(index + 1);
                const statement = statementId ? statementsById.get(statementId) : null;
                if (statement && statement.module === property.module) {
                    declarations.push(statementAnchor(statement.module, statement.id));
                } else {
                    declarations.push([
                        normalizeCompilerPath(binding.filePath, cwd), binding.startLine,
                        binding.physical ? binding.startColumn : null, binding.physical
                    ]);
                }
            });
            declarations.sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
            declarationInputs.push({
                module: property.module,
                kind: "formal-written-type",
                declarations,
                writtenType: property.value,
                provisional: Boolean(sidecar.recovery)
            });
            continue;
        }
        let statementId, input;
        const typing = /^procedure-typing-input:(\d+)$/.exec(property.name);
        const visibility = /^procedure-written-visibility:(\d+)$/.exec(property.name);
        if (typing) {
            const fields = property.value.split("\t");
            statementId = Number(fields[0]);
            if (fields.length !== 5 || !Number.isSafeInteger(statementId) || statementId < 1 ||
                !["prototype", "definition"].includes(fields[1]) ||
                !["sub", "function", "property", "operator", "constructor", "destructor"].includes(fields[2]) ||
                !["none", "as", "suffix", "implicit", "special"].includes(fields[3]) || !["0", "1"].includes(fields[4])) {
                throw new Error("Compiler procedure typing input has an invalid payload.");
            }
            input = { kind: "typing", role: fields[1], procedureKind: fields[2], resultForm: fields[3], exported: fields[4] === "1" };
        } else if (visibility) {
            statementId = Number(visibility[1]);
            if (!Number.isSafeInteger(statementId) || statementId < 1 || !["default", "public", "private"].includes(property.value)) {
                throw new Error("Compiler procedure visibility input has an invalid payload.");
            }
            input = { kind: "visibility", visibility: property.value };
        } else {
            continue;
        }
        declarationInputs.push({
            ...statementAnchor(property.module, statementId),
            ...input,
            provisional: Boolean(sidecar.recovery)
        });
    }
    const arrayStorageCandidates = [];
    for (const group of arrayStorageGroups.values()) {
        const value = (name) => group.values.get(name);
        if (!value("array-storage-symbol") || !value("array-storage-kind") || !value("array-storage-receiver")) {
            throw new Error("Compiler array storage input group is incomplete.");
        }
        const symbol = semanticInputInteger(value("array-storage-symbol"), "array storage symbol", 1);
        const receiver = semanticInputInteger(value("array-storage-receiver"), "array storage receiver");
        const kind = value("array-storage-kind");
        if (kind !== "field" && kind !== "variable") throw new Error("Compiler array storage input has an unknown storage kind.");

        const expressionStatementId = semanticStatementOwners.get(`expression:${group.expression}`);
        const expressionStatement = expressionStatementId ? statementsById.get(expressionStatementId) : null;
        if (expressionStatement && expressionStatement.module !== group.module) {
            throw new Error("Compiler array storage expression belongs to a foreign module statement.");
        }
        const useStatement = expressionStatement ? statementAnchor(group.module, expressionStatement.id) : null;
        const location = physicalLocations.get(`expression:${group.expression}:range`);
        const locationContext = location ? sourceContexts.get(location.source) : null;
        const locationFile = locationContext ? sourceFiles.get(locationContext.file) : null;
        if (location && (!locationContext || locationContext.module !== group.module || !locationFile)) {
            throw new Error("Compiler array storage expression has a foreign or missing source location.");
        }
        if (!useStatement && !location) {
            if (sidecar.recovery) continue;
            throw new Error("Compiler array storage expression has no stable source anchor.");
        }

        let receiverDeclaration = null;
        if (kind === "field") {
            const root = arrayStorageRootsByNode.get(`${group.module}:${receiver}`);
            const rootStatementId = semanticStatementOwners.get(`node:${receiver}`);
            const rootStatement = rootStatementId && statementsById.get(rootStatementId);
            if (!root || root.source !== symbol || !rootStatement || rootStatement.module !== group.module) {
                if (sidecar.recovery) continue;
                throw new Error("Compiler array storage receiver is not tied to its field declaration.");
            }
            receiverDeclaration = {
                symbol: root.source,
                statement: statementAnchor(group.module, rootStatement.id)
            };
        } else if (receiver !== 0) {
            throw new Error("Compiler array variable storage has a fabricated receiver.");
        }

        const source = location ? contextKey(location.source) : useStatement.source;
        const filePath = normalizeCompilerPath(locationFile?.filePath || useStatement?.filePath || "", cwd);
        const statementKey = useStatement ? [
            useStatement.module, useStatement.source, compilerPathKey(useStatement.filePath),
            useStatement.line, useStatement.startColumn, useStatement.ordinal,
            useStatement.tokenClass, useStatement.physical
        ] : [group.module, compilerPathKey(filePath), location.startLine];
        const anchorKey = JSON.stringify([statementKey, source, compilerPathKey(filePath)]);
        const position = location?.status === "mapped"
            ? [0, location.startByte, location.endByte]
            : location
                ? [1, location.startLine, location.startColumn, location.endLine, location.endColumn]
                : [2, 0];
        arrayStorageCandidates.push({
            module: group.module,
            expression: group.expression,
            source,
            filePath,
            statement: useStatement,
            position,
            anchorKey,
            symbol,
            kind,
            receiver: receiverDeclaration,
            provisional: Boolean(sidecar.recovery)
        });
    }
    const comparePositions = (first, second) => {
        const length = Math.min(first.length, second.length);
        for (let index = 0; index < length; index++) {
            if (first[index] !== second[index]) return first[index] - second[index];
        }
        return first.length - second.length;
    };
    arrayStorageCandidates.sort((first, second) =>
        first.anchorKey.localeCompare(second.anchorKey) ||
        comparePositions(first.position, second.position) ||
        first.kind.localeCompare(second.kind) || first.symbol - second.symbol ||
        (first.receiver?.symbol || 0) - (second.receiver?.symbol || 0)
    );
    const arrayStorageOrdinals = new Map();
    for (const candidate of arrayStorageCandidates) {
        const occurrence = (arrayStorageOrdinals.get(candidate.anchorKey) || 0) + 1;
        arrayStorageOrdinals.set(candidate.anchorKey, occurrence);
        arrayStorageInputs.push({
            module: candidate.module,
            expression: candidate.expression,
            source: candidate.source,
            filePath: candidate.filePath,
            statement: candidate.statement,
            occurrence,
            symbol: candidate.symbol,
            kind: candidate.kind,
            receiver: candidate.receiver,
            provisional: candidate.provisional
        });
    }
    for (const group of declarationTypingGroupsByKey.values()) {
        const inputs = [...group.inputs.values()].sort((first, second) => first.ordinal - second.ordinal);
        const complete = group.count !== null && inputs.length === group.count &&
            inputs.every((input, index) => input.ordinal === index + 1);
        if (!complete) {
            if (sidecar.recovery) continue;
            throw new Error("Compiler declaration typing group has incomplete ordinal coverage.");
        }
        declarationTypingGroups.push({
            module: group.module,
            owner: group.owner,
            identity: group.identity,
            kind: group.kind,
            statementId: group.statementId,
            statement: group.statement,
            count: group.count,
            inputs,
            complete,
            provisional: group.provisional
        });
    }
    const completeEnumModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "enum-declaration-inputs" && capability.coverage === "available")
        .map((capability) => capability.module));
    if (!sidecar.recovery) {
        for (const [owner, declaration] of enumDeclarations) {
            const ordinals = [...enumOrdinals.get(owner)].sort((first, second) => first - second);
            if (ordinals.length !== declaration.count || ordinals.some((ordinal, index) => ordinal !== index + 1)) {
                throw new Error("Compiler enum member receipts do not cover the accepted declaration count.");
            }
        }
        for (const construct of sidecar.constructs || []) {
            if (construct.kind !== "enum") continue;
            const sourceContext = sourceContexts.get(construct.source);
            const ending = statementsByEnd.get(construct.statement);
            if (sourceContext && completeEnumModules.has(sourceContext.module) && ending?.outcome === "parsed" &&
                ["declaration", "aggregate-member"].includes(ending.route) &&
                !enumHeadersByStatement.has(`${sourceContext.module}:${construct.statement}`)) {
                throw new Error("Compiler enum declaration capability has incomplete accepted-header coverage.");
            }
        }
    }
    for (const { key, expected } of linkageCallbackCounts) {
        if ((callbackCountsByStatement.get(key) || 0) !== expected) {
            throw new Error("Compiler procedure ABI callback count disagrees with callback convention inputs.");
        }
    }
    const completeLinkageModules = new Set((sidecar.capabilities || [])
        .filter((capability) => capability.feature === "procedure-linkage" && capability.coverage === "available")
        .map((capability) => capability.module));
    const procedureInputKey = (input) => JSON.stringify([
        input.source, input.filePath, input.line, input.startColumn, input.ordinal,
        input.tokenClass, input.physical, input.role
    ]);
    for (const module of completeLinkageModules) {
        const typing = declarationInputs.filter((input) => input.module === module && input.kind === "typing")
            .map(procedureInputKey).sort();
        const linkage = procedureLinkageInputs.filter((input) => input.module === module)
            .map(procedureInputKey).sort();
        if (JSON.stringify(typing) !== JSON.stringify(linkage)) {
            throw new Error("Compiler procedure linkage capability has incomplete source-statement coverage.");
        }
    }
    const aggregateAccessInputs = [];
    for (const group of aggregateGroups.values()) {
        if (group.bodyStatement === null || group.count === null || group.sections.length !== group.count) {
            throw new Error("Compiler aggregate access receipt group is incomplete.");
        }
        group.sections.sort((first, second) => first.ordinal - second.ordinal);
        if (group.sections.some((section, index) => section.ordinal !== index + 1)) {
            throw new Error("Compiler aggregate access section ordinals are incomplete.");
        }
        aggregateAccessInputs.push({
            body: statementAnchor(group.module, group.bodyStatement),
            count: group.count,
            sections: group.sections.map((section) => ({
                ...statementAnchor(group.module, section.statement),
                ordinal: section.ordinal,
                visibility: section.visibility
            }))
        });
    }
    return {
        abiPolicyInputs,
        declarationInputs,
        aggregateAccessInputs,
        procedureLinkageInputs,
        callbackConventionInputs,
        enumDeclarationInputs,
        enumElementInputs,
        declarationTypingGroups,
        declarationRepetitionInputs,
        scalarStringDeclarationInputs,
        arrayStorageInputs
    };
}

function readSemanticUtf8CodePoint(buffer, offset, filePath, singleByteFallback = false) {
    const first = buffer[offset];
    if (first <= 0x7f) return { value: first, bytes: 1 };
    const invalid = () => {
        if (singleByteFallback) return { value: first, bytes: 1, singleByteFallback: true };
        throw new Error(`Mapped compiler location points into invalid UTF-8: ${filePath}`);
    };
    let length, value, minimum;
    if (first >= 0xc2 && first <= 0xdf) {
        length = 2;
        value = first & 0x1f;
        minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
        length = 3;
        value = first & 0x0f;
        minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
        length = 4;
        value = first & 0x07;
        minimum = 0x10000;
    } else return invalid();
    if (offset + length > buffer.length) {
        if (singleByteFallback) return invalid();
        throw new Error(`Mapped compiler location reaches truncated UTF-8: ${filePath}`);
    }
    for (let index = 1; index < length; index++) {
        const next = buffer[offset + index];
        if (next < 0x80 || next > 0xbf) return invalid();
        if (index === 1 && (first === 0xe0 && next < 0xa0 || first === 0xed && next > 0x9f ||
            first === 0xf0 && next < 0x90 || first === 0xf4 && next > 0x8f)) {
            return invalid();
        }
        value = value * 64 + (next & 0x3f);
    }
    if (value < minimum || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) {
        return invalid();
    }
    return { value, bytes: length };
}

function readSemanticCodePoint(buffer, offset, encoding, filePath) {
    /* Unmarked files may contain Latin-1 bytes; preserve their one-byte columns. */
    if (encoding === "unmarked-bytes") return readSemanticUtf8CodePoint(buffer, offset, filePath, true);
    if (encoding === "utf-8-bom") return readSemanticUtf8CodePoint(buffer, offset, filePath);
    if (encoding === "utf-16le" || encoding === "utf-16be") {
        if (offset + 2 > buffer.length) throw new Error(`Mapped compiler location reaches truncated UTF-16: ${filePath}`);
        const littleEndian = encoding === "utf-16le";
        const readUnit = (position) => littleEndian ? buffer.readUInt16LE(position) : buffer.readUInt16BE(position);
        const first = readUnit(offset);
        if (first >= 0xd800 && first <= 0xdbff) {
            if (offset + 4 > buffer.length) throw new Error(`Mapped compiler location reaches truncated UTF-16: ${filePath}`);
            const second = readUnit(offset + 2);
            if (second < 0xdc00 || second > 0xdfff) throw new Error(`Mapped compiler location reaches invalid UTF-16: ${filePath}`);
            return { value: 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00, bytes: 4 };
        }
        if (first >= 0xdc00 && first <= 0xdfff) throw new Error(`Mapped compiler location reaches invalid UTF-16: ${filePath}`);
        return { value: first, bytes: 2 };
    }
    if (encoding === "utf-32le" || encoding === "utf-32be") {
        if (offset + 4 > buffer.length) throw new Error(`Mapped compiler location reaches truncated UTF-32: ${filePath}`);
        const value = encoding === "utf-32le" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
        if (value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) throw new Error(`Mapped compiler location reaches invalid UTF-32: ${filePath}`);
        return { value, bytes: 4 };
    }
    throw new Error(`Compiler source encoding cannot validate a mapped location: ${filePath}`);
}

function compilerOutputBytePosition(line, byteColumn, legacyByteOffsets) {
    /* Decoding one legacy source byte as U+00xx adds a byte to the UTF-8 text.
       Restore that difference before validating the compiler's raw byte column. */
    const bytes = Buffer.from(line);
    let outputByteColumn = byteColumn;
    if (legacyByteOffsets) {
        const sourceByteLength = bytes.length - legacyByteOffsets.length;
        if (!Number.isSafeInteger(byteColumn) || byteColumn < 0 || byteColumn > sourceByteLength) return null;

        let low = 0;
        let high = legacyByteOffsets.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (legacyByteOffsets[middle] < byteColumn) low = middle + 1;
            else high = middle;
        }
        outputByteColumn += low;
    }

    if (!Number.isSafeInteger(outputByteColumn) || outputByteColumn < 0 || outputByteColumn > bytes.length) return null;
    const prefix = bytes.subarray(0, outputByteColumn);
    const decoded = prefix.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(prefix)) return null;
    return { bytes, column: decoded.length };
}

function compilerSemanticSourceBytes(sourceFile, sourceTexts, cwd) {
    const filePath = normalizeCompilerPath(sourceFile.filePath, cwd);
    const key = compilerPathKey(filePath);
    let compilerText = sourceTexts.get(key);
    if (compilerText !== undefined) return { filePath, buffer: Buffer.from(compilerText, "utf8") };
    if (!fs.existsSync(filePath)) throw new Error(`Compiler location source is unavailable: ${filePath}`);
    const buffer = fs.readFileSync(filePath);
    return { filePath, buffer };
}

function verifySemanticLocationCoordinates(buffer, encoding, locations, filePath) {
    const offsets = [];
    for (const location of locations) {
        offsets.push({ offset: location.startByte, line: location.startLine, column: location.startColumn });
        offsets.push({ offset: location.endByte, line: location.endLine, column: location.endColumn });
    }
    offsets.sort((first, second) => first.offset - second.offset);
    let bomBytes = 0;
    const hasBytes = (...values) => buffer.length >= values.length && values.every((value, index) => buffer[index] === value);
    if (encoding === "utf-8-bom") {
        if (!hasBytes(0xef, 0xbb, 0xbf)) throw new Error(`Compiler source revision has no UTF-8 BOM: ${filePath}`);
        bomBytes = 3;
    } else if (encoding === "utf-16le") {
        if (!hasBytes(0xff, 0xfe)) throw new Error(`Compiler source revision has no UTF-16LE BOM: ${filePath}`);
        bomBytes = 2;
    } else if (encoding === "utf-16be") {
        if (!hasBytes(0xfe, 0xff)) throw new Error(`Compiler source revision has no UTF-16BE BOM: ${filePath}`);
        bomBytes = 2;
    } else if (encoding === "utf-32le") {
        if (!hasBytes(0xff, 0xfe, 0x00, 0x00)) throw new Error(`Compiler source revision has no UTF-32LE BOM: ${filePath}`);
        bomBytes = 4;
    } else if (encoding === "utf-32be") {
        if (!hasBytes(0x00, 0x00, 0xfe, 0xff)) throw new Error(`Compiler source revision has no UTF-32BE BOM: ${filePath}`);
        bomBytes = 4;
    } else if (encoding !== "unmarked-bytes") {
        throw new Error(`Compiler source encoding cannot validate a mapped location: ${filePath}`);
    }

    let byteOffset = bomBytes;
    let line = 1;
    let column = 0;
    let locationIndex = 0;
    while (locationIndex < offsets.length && offsets[locationIndex].offset < bomBytes) {
        const target = offsets[locationIndex++];
        if (target.offset < 0 || target.line !== 1 || target.column !== 0) {
            throw new Error(`Compiler location precedes the source encoding marker: ${filePath}`);
        }
    }
    while (byteOffset <= buffer.length) {
        while (locationIndex < offsets.length && offsets[locationIndex].offset === byteOffset) {
            const target = offsets[locationIndex++];
            if (target.line !== line || target.column !== column) {
                throw new Error(`Compiler location bytes disagree with UTF-16 coordinates: ${filePath}`);
            }
        }
        if (locationIndex >= offsets.length) return;
        if (offsets[locationIndex].offset < byteOffset) throw new Error(`Compiler location byte offset splits an encoded character: ${filePath}`);
        if (byteOffset === buffer.length) break;
        const codePoint = readSemanticCodePoint(buffer, byteOffset, encoding, filePath);
        byteOffset += codePoint.bytes;
        if (codePoint.value === 0x0d) {
            if (byteOffset < buffer.length) {
                const next = readSemanticCodePoint(buffer, byteOffset, encoding, filePath);
                if (next.value === 0x0a) byteOffset += next.bytes;
            }
            line++;
            column = 0;
        } else if (codePoint.value === 0x0a) {
            line++;
            column = 0;
        } else column += codePoint.value > 0xffff ? 2 : 1;
    }
    if (locationIndex !== offsets.length) throw new Error(`Compiler location byte offset is outside the source revision: ${filePath}`);
}

function validateCompilerSemanticLocations(sidecar, sourceTexts, cwd) {
    const sourceFiles = new Map((sidecar.sourceFiles || []).map((source) => [source.id, source]));
    const sourceContexts = new Map((sidecar.sourceContexts || []).map((source) => [source.id, source]));
    const byFile = new Map();
    for (const location of sidecar.physicalLocations || []) {
        if (location.status !== "mapped") continue;
        const context = sourceContexts.get(location.source);
        const file = context && sourceFiles.get(context.file);
        if (!file || file.kind !== "regular") throw new Error("Mapped compiler location does not reference a regular source revision.");
        const locations = byFile.get(file.id) || { sourceFile: file, locations: [] };
        locations.locations.push(location);
        byFile.set(file.id, locations);
    }
    let totalBytes = 0;
    for (const { sourceFile, locations } of byFile.values()) {
        if (sourceFile.bytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler location source exceeds the 32 MiB validation bound.");
        totalBytes += sourceFile.bytes;
        if (totalBytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler location sources exceed the 32 MiB validation bound.");
        const { filePath, buffer } = compilerSemanticSourceBytes(sourceFile, sourceTexts, cwd);
        if (buffer.length !== sourceFile.bytes || crypto.createHash("sha256").update(buffer).digest("hex") !== sourceFile.digest) {
            throw new Error(`Compiler location source changed after semantic analysis: ${filePath}`);
        }
        verifySemanticLocationCoordinates(buffer, sourceFile.encoding, locations, filePath);
    }
}

function mergeCompilerDependencies(bridgeDependencies, semanticDependencies, cwd) {
    const dependencies = [];
    const seen = new Set();
    for (const file of [...bridgeDependencies, ...(semanticDependencies || [])]) {
        const normalized = normalizeCompilerPath(file, cwd);
        const key = compilerPathKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        dependencies.push(normalized);
    }
    if (dependencies.length > 5000) throw new Error("Compiler analysis exceeded its 5000-source limit.");
    return dependencies;
}

function verifyOverlayIdentities(dependencies, overlays, identities) {
    const overlayPaths = new Set([...(overlays?.keys() || [])].map(compilerPathKey));
    for (const file of dependencies) {
        if (overlayPaths.has(compilerPathKey(file)) || !fs.existsSync(file)) continue;
        const text = identities.get(fs.realpathSync(file));
        if (text !== undefined && text.replace(/^\uFEFF/, "") !== decodeCompilerSourceBuffer(fs.readFileSync(file), file).replace(/^\uFEFF/, "")) {
            throw new Error(`An unsaved buffer uses a different path for ${file}. Open the compiler-resolved path before analyzing.`);
        }
    }
}

function verifySidecarOnlyOverlays(dependencies, overlays) {
    const dependencyPaths = new Set(dependencies.map(compilerPathKey));
    for (const [file, text] of overlays || []) {
        const pathKey = compilerPathKey(file);
        let isDependency = dependencyPaths.has(pathKey);
        if (!isDependency && fs.existsSync(file)) {
            try { isDependency = dependencyPaths.has(compilerPathKey(fs.realpathSync(file))); } catch { /* The exact compiler spelling remains authoritative. */ }
        }
        if (!isDependency) continue;
        if (!fs.existsSync(file)) throw new Error(`Compiler sidecar-only analysis cannot verify an unsaved source path: ${file}. Configure the editor bridge to analyze unsaved buffers.`);
        const diskText = decodeCompilerSourceBuffer(fs.readFileSync(file), file).replace(/^\uFEFF/, "");
        if (text.replace(/^\uFEFF/, "") !== diskText) {
            throw new Error(`The configured fbc semantic sidecar can only analyze saved inputs; changed buffer ${file} requires the editor bridge for unsaved analysis.`);
        }
    }
}

function createSemanticSidecarAnalysis(options, outputPath, semanticModelPath, result, identities, includeBindings = false,
    compilerTexts = new Map(), fallbackReason = "") {
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size > MAX_ANALYSIS_BYTES) throw new Error(ANALYSIS_OUTPUT_LIMIT_ERROR);
    if (!fs.existsSync(semanticModelPath)) throw new Error("Compiler expression sidecar fallback produced no semantic model.");
    if (fs.statSync(semanticModelPath).size > MAX_SEMANTIC_MODEL_BYTES) throw new Error("Compiler semantic sidecar exceeded 64 MiB.");

    const cwd = path.dirname(options.filePath);
    const directiveLines = options.exportSemanticExpressions === true
        ? null
        : compilerDirectiveLineMap(options.filePath, options.overlays);
    const semanticSourcePaths = compilerSemanticSourcePathKeys(options);
    const sidecar = decodeCompilerSemanticExpressions(fs.readFileSync(semanticModelPath), (expression) => {
        /* A stronger binding snapshot must still answer ordinary expression
           hovers and inlay hints after it replaces the expression-only model. */
        if (!expression.physical) return false;
        const filePath = normalizeCompilerPath(expression.filePath, cwd);
        if (semanticSourcePaths && !semanticSourcePaths.has(compilerPathKey(filePath)) &&
            !(includeBindings && expression.operatorKind === "overloaded" && expression.operatorCode === "index")) return false;
        if (options.exportSemanticExpressions === true) return true;
        return directiveLines.get(compilerPathKey(filePath))?.has(expression.startLine) === true;
    }, { allowRecovery: true, includeBindings });
    const expressionContexts = compilerSemanticExpressionContexts(sidecar, cwd);
    validateCompilerSemanticLocations(sidecar, compilerTexts, cwd);
    if (!sidecar.complete && !sidecar.recovery) throw new Error("Compiler expression sidecar is incomplete.");
    if (sidecar.schemaVersion < 6 || !sidecar.dependenciesComplete) throw new Error("Compiler expression sidecar has no complete dependency inventory.");
    const dependencies = compilerSemanticDependencies(sidecar, cwd, options.filePath);
    if (!dependencies) throw new Error("Compiler expression sidecar has no complete dependency inventory.");

    const expressions = sidecar.expressions.map((expression) => ({
        ...expression,
        sourceContextId: expressionContexts.expressionSources.get(expression.id) || 0,
        filePath: normalizeCompilerPath(expression.filePath, cwd)
    }));
    const semanticBindings = sidecar.bindings.map((binding) => ({
        ...binding,
        filePath: normalizeCompilerPath(binding.filePath, cwd)
    }));
    /* Compact sidecars retain compiler-selected conditional-name probes. Full
       macro bindings add root invocations and #undef sites when requested. */
    if (includeBindings && (sidecar.definedNameProbes?.length || sidecar.macroInvocations?.length ||
        sidecar.macroLifecycles?.length)) {
        semanticBindings.push(...compilerSemanticPreprocessorReferenceBindings(sidecar, cwd, dependencies, semanticBindings));
    }
    const semanticImplicitCalls = sidecar.implicitCalls.map((call) => ({
        ...call,
        filePath: normalizeCompilerPath(call.filePath, cwd)
    }));
    const semanticExpressionOperands = compilerSemanticExpressionOperands(sidecar, cwd);
    const semanticDiagnostics = sidecar.semanticDiagnostics.map((diagnostic) => ({
        ...diagnostic,
        filePath: diagnostic.filePath ? normalizeCompilerPath(diagnostic.filePath, cwd) : ""
    }));
    const dependencyKeys = new Set(dependencies.map(compilerPathKey));
    if (expressions.some((expression) => !dependencyKeys.has(compilerPathKey(expression.filePath)))) throw new Error("Compiler expression sidecar refers to a source outside its dependency inventory.");
    if (semanticBindings.some((binding) => !dependencyKeys.has(compilerPathKey(binding.filePath)))) throw new Error("Compiler semantic binding refers to a source outside its dependency inventory.");
    if (semanticImplicitCalls.some((call) => call.physical && !dependencyKeys.has(compilerPathKey(call.filePath)))) throw new Error("Compiler semantic implicit call refers to a source outside its dependency inventory.");
    if (semanticExpressionOperands.some((operation) => !dependencyKeys.has(compilerPathKey(operation.sourceFilePath)))) throw new Error("Compiler semantic expression operation refers to a source outside its dependency inventory.");
    const textualDiagnostics = parseCompilerOutput([result.stdout, result.stderr].join("\n")).map((diagnostic) => ({
        ...diagnostic,
        filePath: path.resolve(cwd, diagnostic.filePath)
    }));
    const diagnostics = attachStructuredDiagnosticData(textualDiagnostics, result.structuredDiagnostics);
    const errorPositions = diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => ({
        sourceFile: diagnostic.filePath,
        sourceLine: diagnostic.line
    }));
    verifyOverlayIdentities(dependencies, options.overlays, identities);

    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const partial = sidecar.recovery || result.exitCode !== 0 || errorCount > 0;
    const decodedOutput = decodeCompilerOutputBuffer(fs.readFileSync(outputPath));
    return {
        text: decodedOutput.text,
        origins: new Map(),
        dependencies,
        semanticDependencies: dependencies,
        bindings: [],
        expressions: [],
        receivers: [],
        symbolGraph: { symbols: [], canonicalIds: [], uses: [], dispatch: [], nonRenameable: [] },
        expressionGraph: { nodes: [] },
        scopeGraph: { scopes: [], declarations: [], shapes: [], imports: [] },
        tokenOrigins: [],
        macroGraph: { nodes: [] },
        preprocessorGraph: { declarations: [], references: [], parameters: [], contexts: [], epochs: 0 },
        recoverySymbols: [],
        errorPositions,
        nonRenameable: [],
        protocolVersion: 0,
        completion: { errorCount, reachedEnd: true },
        invalidLines: [],
        partial,
        diagnostics,
        semanticExpressions: expressions,
        semanticSourceRevisions: compilerSemanticSourceRevisions(sidecar, cwd),
        semanticSourceContexts: expressionContexts.contexts,
        semanticIncludeOutcomes: compilerSemanticIncludeOutcomes(sidecar, cwd),
        semanticDeclarations: (sidecar.declarations || []).map((declaration) => ({
            ...declaration,
            filePath: normalizeCompilerPath(declaration.filePath, cwd)
        })),
        semanticBindings,
        semanticAccessRoles: sidecar.accessRoles || [],
        semanticImplicitCalls,
        semanticConstants: sidecar.constantValues || [],
        semanticProcedures: compilerSemanticProcedureRecords(sidecar, cwd),
        semanticOperations: compilerSemanticOperatorOperations(sidecar, cwd),
        semanticRelationships: sidecar.relationships || [],
        semanticExpressionOperands,
        semanticDiagnostics,
        ...compilerSemanticPolicyFacts(sidecar, cwd),
        semanticProperties: (sidecar.properties || []).map((property) => ({ ...property, provisional: sidecar.recovery })),
        semanticCapabilities: (sidecar.capabilities || []).map((capability) => ({ ...capability, provisional: sidecar.recovery })),
        semanticModelSchemaVersion: sidecar.schemaVersion,
        semanticModelCompilerVersion: sidecar.compilerVersion,
        semanticPreprocessorFacts: compilerSemanticPreprocessorFacts(sidecar, cwd),
        semanticTypeBases: sidecar.typeBases || [],
        semanticTypeSymbols: sidecar.typeSymbols || [],
        semanticSymbolTypes: sidecar.symbolTypes || [],
        semanticModelCounts: sidecar.counts,
        semanticModelRecovery: sidecar.recovery,
        semanticModelFallbackReason: fallbackReason || (sidecar.recovery ? "recovery" : ""),
        semanticSidecarOnly: true
    };
}

async function analyzeSavedModule(options, decode = decodePreprocessed, execute = executeBoundedProcess) {
    if (!path.isAbsolute(options.filePath) || !/\.bas$/i.test(options.filePath)) throw new Error("Compiler analysis requires a saved .bas module.");
    // The worker client owns a supplied temporary directory so it can also
    // clean it after an unexpected worker exit. Ordinary callers own it here.
    const directory = options.temporaryDirectory || fs.mkdtempSync(path.join(os.tmpdir(), "fb-editor-analysis-"));
    let outputPath = path.join(directory, "module.pp.bas");
    let semanticModelPath = path.join(directory, "module.fbcsem");
    let semanticModelFallbackReason = "";
    const sidecarDisabled = options.disableCompilerSemanticSidecar === true;
    const exportCompilerExpressions = !sidecarDisabled && (options.exportSemanticExpressions === true || hasCompilerExpressionDirective(options.filePath, options.overlays));
    const exportCompilerBindings = !sidecarDisabled && options.exportSemanticBindings === true;
    const exportCompilerSidecar = exportCompilerExpressions || exportCompilerBindings;
    let semanticSourceFilterPath = "";
    const allowTraceOnlySemanticFallback = !options.requireSemanticModel && !exportCompilerBindings && options.allowSemanticSidecarFallback !== false;
    async function fallbackToTraceOnly(error) {
        if (error.message !== "Compiler semantic sidecar exceeded 64 MiB." || !allowTraceOnlySemanticFallback) throw error;
        const analysis = await analyzeSavedModule({
            ...options,
            exportSemanticExpressions: false,
            exportSemanticBindings: false,
            requireSemanticModel: false,
            semanticModelOnly: false,
            disableCompilerSemanticSidecar: true
        }, decode, execute);
        analysis.semanticModelFallbackReason = "semantic-sidecar-size-limit";
        return analysis;
    }
    try {
        const { manifestPath, identities, compilerTexts } = writeOverlays(directory, options.overlays);
        if (exportCompilerExpressions && !exportCompilerBindings) semanticSourceFilterPath = writeSemanticSourceFilter(directory, options);
        let result;
        if (options.semanticModelOnly === true) {
            if (!exportCompilerSidecar) throw new Error("Compiler sidecar-only analysis requires a semantic model request.");
            result = await executeAnalysisPass(options, execute, {
                manifestPath, trace: false, outputPath,
                semanticModelPath,
                semanticModelMode: exportCompilerBindings ? "full" : "expressions",
                semanticSourceFilterPath,
                limitSemanticModel: true,
                compactSemanticMacros: options.compactSemanticMacros !== false
            });
            const analysis = createSemanticSidecarAnalysis(options, outputPath, semanticModelPath, result,
                identities, exportCompilerBindings, new Map(), "compiler-sidecar-only");
            verifySidecarOnlyOverlays(analysis.dependencies, options.overlays);
            return analysis;
        }
        try {
            result = await executeAnalysisPass(options, execute, {
                manifestPath, trace: true, outputPath,
                semanticModelPath: exportCompilerSidecar ? semanticModelPath : null,
                semanticModelMode: exportCompilerBindings ? "full" : "expressions",
                semanticSourceFilterPath,
                limitSemanticModel: exportCompilerSidecar,
                compactSemanticMacros: exportCompilerBindings
            });
        } catch (error) {
            const recoverableTraceLimit = error.message === ANALYSIS_OUTPUT_LIMIT_ERROR;
            const recoverableSidecarLimit = error.message === "Compiler semantic sidecar exceeded 64 MiB.";
            const recoverableFullModelLimit = exportCompilerBindings && error.compilerSemanticModelFailure === true;
            if ((!recoverableTraceLimit && !recoverableSidecarLimit && !recoverableFullModelLimit) ||
                (!exportCompilerExpressions && !exportCompilerBindings) ||
                options.allowSemanticSidecarFallback === false) throw error;

            if (exportCompilerBindings && (recoverableFullModelLimit || recoverableSidecarLimit)) {
                outputPath = path.join(directory, "module.bindings-fallback.pp.bas");
                semanticModelPath = path.join(directory, "module.bindings-fallback.fbcsem");
                try {
                    result = await executeAnalysisPass(options, execute, {
                        manifestPath, trace: true, outputPath,
                        semanticModelPath,
                        semanticModelMode: "bindings",
                        limitSemanticModel: true,
                        compactSemanticMacros: true
                    });
                    semanticModelFallbackReason = recoverableFullModelLimit
                        ? "compiler-full-model-bound"
                        : "compiler-full-model-size-limit";
                } catch (bindingError) {
                    if (bindingError.message !== ANALYSIS_OUTPUT_LIMIT_ERROR &&
                        bindingError.message !== "Compiler semantic sidecar exceeded 64 MiB.") throw bindingError;
                    const fallbackOutputPath = path.join(directory, "module.sidecar-fallback.pp.bas");
                    const fallbackSemanticPath = path.join(directory, "module.sidecar-fallback.fbcsem");
                    const fallbackResult = await executeAnalysisPass(options, execute, {
                        manifestPath, trace: false, outputPath: fallbackOutputPath,
                        semanticModelPath: fallbackSemanticPath,
                        semanticModelMode: "bindings",
                        limitSemanticModel: true,
                        compactSemanticMacros: true
                    });
                    return createSemanticSidecarAnalysis(options, fallbackOutputPath, fallbackSemanticPath, fallbackResult,
                        identities, true, compilerTexts, "compiler-binding-trace-limit");
                }
            } else {
                const fallbackOutputPath = path.join(directory, "module.sidecar-fallback.pp.bas");
                const fallbackSemanticPath = path.join(directory, "module.sidecar-fallback.fbcsem");
                try {
                    const fallbackResult = await executeAnalysisPass(options, execute, {
                        manifestPath, trace: false, outputPath: fallbackOutputPath,
                        semanticModelPath: fallbackSemanticPath,
                        semanticModelMode: exportCompilerBindings ? "bindings" : "expressions",
                        semanticSourceFilterPath,
                        limitSemanticModel: true,
                        compactSemanticMacros: true
                    });
                    const fallbackReason = recoverableTraceLimit ? "trace-output-limit" : "semantic-sidecar-size-limit";
                    return createSemanticSidecarAnalysis(options, fallbackOutputPath, fallbackSemanticPath, fallbackResult,
                        identities, exportCompilerBindings, compilerTexts, fallbackReason);
                } catch (fallbackError) {
                    return await fallbackToTraceOnly(fallbackError);
                }
            }
        }
        const decodedOutput = decodeCompilerOutputBuffer(fs.readFileSync(outputPath));
        let analysis;
        try {
            analysis = { ...decode(decodedOutput.text, path.dirname(options.filePath), undefined, decodedOutput.legacyByteOffsetsByLine) };
        } catch (error) {
            if (!TRACE_DECODER_LIMIT_ERRORS.has(error.message) || !exportCompilerSidecar ||
                options.allowSemanticSidecarFallback === false) throw error;

            const fallbackOutputPath = path.join(directory, "module.trace-limit.pp.bas");
            const fallbackSemanticPath = path.join(directory, "module.trace-limit.fbcsem");
            const fallbackResult = await executeAnalysisPass(options, execute, {
                manifestPath,
                trace: false,
                outputPath: fallbackOutputPath,
                semanticModelPath: fallbackSemanticPath,
                semanticModelMode: exportCompilerBindings ? "bindings" : "expressions",
                semanticSourceFilterPath,
                limitSemanticModel: true,
                compactSemanticMacros: true
            });
            const fallbackAnalysis = createSemanticSidecarAnalysis(options, fallbackOutputPath, fallbackSemanticPath,
                fallbackResult, identities, exportCompilerBindings, compilerTexts, "compiler-trace-record-limit");
            verifySidecarOnlyOverlays(fallbackAnalysis.dependencies, options.overlays);
            return fallbackAnalysis;
        }
        if (analysis.protocolVersion !== 14) throw new Error("Rebuild the compiler bridge for editor protocol 14 (positioned recovery errors).");
        if (!analysis.completion) throw new Error("The compiler did not finish writing its analysis snapshot.");
        if (result.exitCode !== (analysis.completion.errorCount ? 1 : 0)) throw new Error("Compiler exit status does not match its terminal analysis record.");
        analysis.partial = analysis.completion.errorCount > 0 || !analysis.completion.reachedEnd;
        if (analysis.partial && !options.allowErrors) throw new Error("Compiler refactoring requires a complete, error-free translation unit.");
        const textualDiagnostics = parseCompilerOutput([result.stdout, result.stderr].join("\n"))
            .map((diagnostic) => ({ ...diagnostic, filePath: path.resolve(path.dirname(options.filePath), diagnostic.filePath) }));
        analysis.diagnostics = attachStructuredDiagnosticData(textualDiagnostics, result.structuredDiagnostics);
        analysis.compilerRemKeywordDisableOptions = compilerRemKeywordDisableOptions(analysis, compilerTexts, options.overlays);
        if (!analysis.dependencies.length) throw new Error("The compiler bridge is missing dependency records. Rebuild it before using compiler analysis.");
        if (!analysis.dependencies.includes(path.normalize(options.filePath))) throw new Error("The compiler did not report the requested module. Check filename length and source remapping.");
        analysis.semanticExpressions = [];
        analysis.semanticModelRecovery = false;
        analysis.semanticModelFallbackReason = semanticModelFallbackReason;
        let semanticModelComplete = false;
        analysis.semanticIncludeOutcomes = [];
        analysis.semanticBindings = [];
        analysis.semanticAccessRoles = [];
        analysis.semanticImplicitCalls = [];
        analysis.semanticTemporaryConstructions = [];
        analysis.semanticConstants = [];
        analysis.semanticOperations = [];
        analysis.semanticRelationships = [];
        analysis.semanticExpressionOperands = [];
        analysis.semanticDiagnostics = [];
        analysis.semanticSourceHeaderPolicies = [];
        analysis.semanticHeaderLibraries = [];
        analysis.semanticNamespaceImportRecipients = [];
        analysis.semanticNamespaceDeclarations = [];
        analysis.semanticProperties = [];
        analysis.semanticCapabilities = [];
        analysis.semanticAssignmentInputs = [];
        if (exportCompilerSidecar && fs.existsSync(semanticModelPath)) {
            try {
                if (fs.statSync(semanticModelPath).size <= MAX_SEMANTIC_MODEL_BYTES) {
                    const directiveLines = options.exportSemanticExpressions === true
                        ? null
                        : compilerDirectiveLineMap(options.filePath, options.overlays);
                    const semanticSourcePaths = compilerSemanticSourcePathKeys(options);
                    const sidecar = decodeCompilerSemanticExpressions(
                        fs.readFileSync(semanticModelPath),
                        (expression) => {
                            /* Keep type facts available after a binding upgrade. */
                            if (!expression.physical) return false;
                            const filePath = normalizeCompilerPath(expression.filePath, path.dirname(options.filePath));
                            if (semanticSourcePaths && !semanticSourcePaths.has(compilerPathKey(filePath)) &&
                                !(exportCompilerBindings && expression.operatorKind === "overloaded" && expression.operatorCode === "index")) return false;
                            return options.exportSemanticExpressions === true ||
                                directiveLines?.get(compilerPathKey(filePath))?.has(expression.startLine) === true;
                        },
                        { allowRecovery: true, includeBindings: exportCompilerBindings }
                    );
                    const expressionContexts = compilerSemanticExpressionContexts(sidecar, path.dirname(options.filePath));
                    validateCompilerSemanticLocations(sidecar, compilerTexts, path.dirname(options.filePath));
                    if (exportCompilerBindings && sidecar.schemaVersion < 7) throw new Error("Compiler semantic sidecar has no resolved binding inventory.");
                    if (analysis.partial !== sidecar.recovery) throw new Error("Compiler semantic recovery status does not match the native analysis snapshot.");
                    const semanticDependencies = compilerSemanticDependencies(sidecar, path.dirname(options.filePath), options.filePath);
                    if (semanticDependencies) {
                        analysis.semanticDependencies = semanticDependencies;
                        analysis.dependencies = mergeCompilerDependencies(analysis.dependencies, semanticDependencies, path.dirname(options.filePath));
                    }
                    analysis.semanticExpressions = sidecar.expressions.map((expression) => ({
                        ...expression,
                        sourceContextId: expressionContexts.expressionSources.get(expression.id) || 0,
                        filePath: normalizeCompilerPath(expression.filePath, path.dirname(options.filePath))
                    }));
                    analysis.semanticSourceRevisions = compilerSemanticSourceRevisions(sidecar, path.dirname(options.filePath));
                    analysis.semanticSourceContexts = expressionContexts.contexts;
                    analysis.semanticIncludeOutcomes = compilerSemanticIncludeOutcomes(sidecar, path.dirname(options.filePath));
                    analysis.semanticDeclarations = (sidecar.declarations || []).map((declaration) => ({
                        ...declaration,
                        filePath: normalizeCompilerPath(declaration.filePath, path.dirname(options.filePath))
                    }));
                    const dependencyKeys = new Set((semanticDependencies || analysis.dependencies).map(compilerPathKey));
                    analysis.semanticBindings = sidecar.bindings.map((binding) => ({
                        ...binding,
                        filePath: normalizeCompilerPath(binding.filePath, path.dirname(options.filePath))
                    }));
                    analysis.semanticAccessRoles = sidecar.accessRoles || [];
                    analysis.semanticImplicitCalls = sidecar.implicitCalls.map((call) => ({
                        ...call,
                        filePath: normalizeCompilerPath(call.filePath, path.dirname(options.filePath))
                    }));
                    analysis.semanticConstants = sidecar.constantValues || [];
                    analysis.semanticProcedures = compilerSemanticProcedureRecords(sidecar, path.dirname(options.filePath));
                    analysis.semanticOperations = compilerSemanticOperatorOperations(sidecar, path.dirname(options.filePath));
                    analysis.semanticRelationships = sidecar.relationships || [];
                    analysis.semanticExpressionOperands = compilerSemanticExpressionOperands(sidecar, path.dirname(options.filePath));
                    analysis.semanticDiagnostics = sidecar.semanticDiagnostics.map((diagnostic) => ({
                        ...diagnostic,
                        filePath: diagnostic.filePath ? normalizeCompilerPath(diagnostic.filePath, path.dirname(options.filePath)) : ""
                    }));
                    analysis.semanticTypeBases = sidecar.typeBases || [];
                    analysis.semanticTypeSymbols = sidecar.typeSymbols || [];
                    analysis.semanticSymbolTypes = sidecar.symbolTypes || [];
                    Object.assign(analysis, compilerSemanticPolicyFacts(sidecar, path.dirname(options.filePath)));
                    analysis.semanticProperties = (sidecar.properties || []).map((property) => ({
                        ...property,
                        provisional: sidecar.recovery
                    }));
                    analysis.semanticCapabilities = (sidecar.capabilities || []).map((capability) => ({
                        ...capability,
                        provisional: sidecar.recovery
                    }));
                    analysis.semanticModelSchemaVersion = sidecar.schemaVersion;
                    analysis.semanticModelCompilerVersion = sidecar.compilerVersion;
                    analysis.semanticModelCounts = sidecar.counts;
                    analysis.semanticPreprocessorFacts = compilerSemanticPreprocessorFacts(sidecar, path.dirname(options.filePath));
                    if (analysis.semanticBindings.some((binding) => !dependencyKeys.has(compilerPathKey(binding.filePath)))) {
                        throw new Error("Compiler semantic binding refers to a source outside its dependency inventory.");
                    }
                    if (analysis.semanticImplicitCalls.some((call) => call.physical && !dependencyKeys.has(compilerPathKey(call.filePath)))) {
                        throw new Error("Compiler semantic implicit call refers to a source outside its dependency inventory.");
                    }
                    if (analysis.semanticExpressionOperands.some((operation) => !dependencyKeys.has(compilerPathKey(operation.sourceFilePath)))) {
                        throw new Error("Compiler semantic expression operation refers to a source outside its dependency inventory.");
                    }
                    analysis.semanticModelRecovery = sidecar.recovery;
                    semanticModelComplete = sidecar.complete;
                }
            } catch (error) {
                if ((options.requireSemanticModel || exportCompilerBindings) && !analysis.partial) throw new Error(`Required compiler semantic model is invalid: ${error.message}`);
                /* An absent or incomplete sidecar must not impair editor recovery. */
            }
        }
        if ((options.requireSemanticModel || exportCompilerBindings) && !analysis.partial && !semanticModelComplete) throw new Error("Required compiler semantic model is missing or exceeded its 64 MiB limit.");
        if (options.exportSemanticExpressions === true && exportCompilerBindings && !analysis.partial &&
            semanticModelFallbackReason && analysis.semanticExpressions.length === 0) {
            /* Bindings-only retry preserves symbol identities but contains no
               physical expression facts. Keep a separate, bounded type pass;
               IDs from its export graph must never join the binding graph. */
            const typeOutputPath = path.join(directory, "module.types-fallback.pp.bas");
            const typeSemanticPath = path.join(directory, "module.types-fallback.fbcsem");
            const typeResult = await executeAnalysisPass(options, execute, {
                manifestPath, trace: false, outputPath: typeOutputPath,
                semanticModelPath: typeSemanticPath,
                semanticModelMode: "expressions",
                semanticSourceFilterPath: writeSemanticSourceFilter(directory, options),
                limitSemanticModel: true,
                compactSemanticMacros: true
            });
            const typeAnalysis = createSemanticSidecarAnalysis(options, typeOutputPath, typeSemanticPath, typeResult,
                identities, false, compilerTexts, "compiler-binding-type-supplement");
            const revisions = new Map((analysis.semanticSourceRevisions || []).map((source) =>
                [compilerPathKey(source.filePath), JSON.stringify([source.bytes, source.digest, source.encoding])]));
            const matchingRevisions = typeAnalysis.semanticSourceRevisions.every((source) =>
                revisions.get(compilerPathKey(source.filePath)) === JSON.stringify([source.bytes, source.digest, source.encoding]));
            const dependencies = new Set(analysis.dependencies.map(compilerPathKey));
            if (typeAnalysis.partial || typeAnalysis.semanticModelSchemaVersion !== analysis.semanticModelSchemaVersion ||
                typeAnalysis.semanticModelCompilerVersion !== analysis.semanticModelCompilerVersion || !matchingRevisions ||
                (typeAnalysis.semanticExpressions.length > 0 && typeAnalysis.semanticSourceRevisions.length === 0) ||
                typeAnalysis.dependencies.length !== dependencies.size ||
                typeAnalysis.dependencies.some((file) => !dependencies.has(compilerPathKey(file)))) {
                throw new Error("Compiler expression supplement does not match the binding snapshot.");
            }
            analysis.semanticExpressionFallback = typeAnalysis;
        }
        const physicalSourceByteOffsets = compilerPhysicalSourceByteOffsets(analysis, compilerTexts);
        if (physicalSourceByteOffsets.size) {
            Object.defineProperty(analysis, "physicalSourceByteOffsets", { value: physicalSourceByteOffsets });
        }
        verifyOverlayIdentities(analysis.dependencies, options.overlays, identities);
        return analysis;
    } catch (error) {
        if (error.semanticDiagnosticsUnsupported && !options.disableStructuredDiagnostics) {
            return await analyzeSavedModule({ ...options, disableStructuredDiagnostics: true }, decode, execute);
        }
        throw error;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

module.exports = { DEFAULT_COMPILER_ANALYSIS_TIMEOUT_MS, MAX_ANALYSIS_BYTES, analysisArguments, analyzeSavedModule, compilerMissingIncludeState, compilerSemanticDependencies, compilerSemanticTemporaryConstructions, decodeCompilerSourceBuffer, decodePreprocessed };

/* end of lib/compiler-analysis.js */
