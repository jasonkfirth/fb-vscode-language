/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-semantic-transport.js
    Purpose: Read the compiler's portable FBCSEMB1 semantic transport.
    Responsibilities: bound headers, frames, dictionaries, and value expansion.
    Does not contain: semantic graph validation, compiler invocation, or editor policy.
*/

const BINARY_MAGIC = Buffer.from("FBCSEMB1\n", "ascii");
const MAX_BINARY_HEADER_BYTES = 64 * 1024;
const MAX_BINARY_STRINGS = 262_144;
const MAX_BINARY_STRING_BYTES = 64 * 1024 * 1024;
const MAX_BINARY_INTEGER = (1n << 61n) - 1n;
const MAX_EXPANDED_MODEL_BYTES = 1024 * 1024 * 1024;
const SUPPORTED_CAPABILITIES = new Set([
    "core", "source-revisions", "native-types", "control-flow", "macro-provenance", "structured-values"
]);
const HEADER_METADATA = new Set(["schema", "producer", "mode", "layout", "values", "dictionary"]);
const DEFAULT_LIMITS = Object.freeze({
    maxBytes: 64 * 1024 * 1024,
    maxRecordBytes: 64 * 1024 * 1024,
    maxRecords: 6_100_002,
    maxExpandedBytes: MAX_EXPANDED_MODEL_BYTES
});

/* ------------------------------------------------------------------------- */
/* Record transport                                                          */
/* ------------------------------------------------------------------------- */

/*
    Transport version and semantic schema are independent. The compiler's
    inc/fbc-semantic-binary.bi defines this framing; its generated element
    table describes schema 27. Return one logical row at a time so existing
    graph validators never need an expanded copy of the complete sidecar.

    Callers must exhaust this iterator before publishing any facts. END and
    RECOVERY are ordinary frames, and bytes after either marker are invalid.
*/
function* readBinarySemanticRows(buffer, options) {
    const records = new Map();
    const tags = new Set();
    const capabilities = new Set();
    const supported = new Set();
    const metadata = new Map();
    let position = BINARY_MAGIC.length;
    let headerEnded = false;
    const headerBytes = buffer.subarray(0, MAX_BINARY_HEADER_BYTES);

    while (position < Math.min(buffer.length, MAX_BINARY_HEADER_BYTES)) {
        const ending = headerBytes.indexOf(0x0a, position);
        if (ending < 0 || ending >= MAX_BINARY_HEADER_BYTES) throw new Error("Unterminated binary semantic header.");
        const line = buffer.toString("latin1", position, ending);
        if (/[^\x20-\x7e\t]/.test(line)) throw new Error("Invalid binary semantic header byte.");
        const fields = line.split("\t");
        position = ending + 1;
        if (line === "DATA") {
            headerEnded = true;
            break;
        }
        if (fields[0] === "record") {
            if (fields.length !== 5 || !/^[1-9]\d{0,2}$/.test(fields[1]) ||
                !/^[1-9]\d{0,2}$/.test(fields[3]) || !fields[4]) {
                throw new Error("Invalid binary semantic record definition.");
            }
            const identity = Number(fields[1]);
            const arity = Number(fields[3]);
            const tag = fields[2];
            if (identity > 255 || arity < 2 || arity > 255 || !/^[A-Z][A-Z0-9]*$/.test(tag)) {
                throw new Error("Invalid binary semantic record definition.");
            }
            if (records.has(identity) || tags.has(tag)) throw new Error("Duplicate binary semantic record definition.");
            if (options.recordShapes && (!Object.hasOwn(options.recordShapes, tag) || options.recordShapes[tag] !== arity)) {
                throw new Error(`Unsupported binary semantic record contract: ${tag}.`);
            }
            records.set(identity, { tag, arity });
            tags.add(tag);
        } else if (fields[0] === "cap") {
            if (fields.length !== 4 || !fields[1] || !/^[1-9]\d{0,18}$/.test(fields[2]) ||
                BigInt(fields[2]) > MAX_BINARY_INTEGER || !["0", "1"].includes(fields[3])) {
                throw new Error("Invalid binary semantic capability definition.");
            }
            const capability = fields[1];
            if (capabilities.has(capability)) throw new Error("Duplicate binary semantic capability.");
            capabilities.add(capability);
            if (SUPPORTED_CAPABILITIES.has(capability) && fields[2] === "1") supported.add(capability);
            else if (fields[3] === "1") throw new Error(`Unsupported required binary semantic capability: ${capability}.`);
        } else if (HEADER_METADATA.has(fields[0])) {
            if (fields.length !== 2 || !fields[1] || metadata.has(fields[0])) {
                throw new Error("Duplicate or invalid binary semantic header metadata.");
            }
            metadata.set(fields[0], fields[1]);
        } else {
            throw new Error("Unknown binary semantic header element.");
        }
    }
    if (!headerEnded || metadata.size !== HEADER_METADATA.size || metadata.get("schema") !== "27") {
        throw new Error("Unsupported or incomplete binary semantic header or schema.");
    }
    const mode = metadata.get("mode");
    if (!["full", "bindings", "expressions"].includes(mode)) throw new Error("Unsupported binary semantic export mode.");
    if (options.expectedModes && !options.expectedModes.includes(mode)) {
        throw new Error("Binary semantic export mode does not match the requested facts.");
    }
    const required = mode === "full" ? ["core", "source-revisions", "native-types", "control-flow"] : ["core", "source-revisions"];
    if (required.some((capability) => !supported.has(capability))) throw new Error("Missing required binary semantic capabilities.");

    const strings = [""];
    let stringBytes = 0;
    const maxRecordBytes = options.maxRecordBytes ?? MAX_BINARY_STRING_BYTES;
    const maxExpandedBytes = options.maxExpandedBytes ?? MAX_EXPANDED_MODEL_BYTES;
    let expandedBytes = 0;
    let recordCount = 0;

    function varint(ending) {
        let number = 0;
        /* Ordinary IDs and lengths fit in seven groups. Reserve BigInt for
           larger exact constants; JS bitwise operators truncate at 32 bits. */
        for (let shift = 0; shift <= 42; shift += 7) {
            if (position >= ending) throw new Error("Truncated binary semantic integer.");
            const part = buffer[position++];
            number += (part & 127) * 2 ** shift;
            if (!(part & 128)) {
                if (shift && !part) throw new Error("Noncanonical binary semantic integer.");
                return number;
            }
        }
        let wide = BigInt(number);
        for (let shift = 49; shift <= 63; shift += 7) {
            if (position >= ending) throw new Error("Truncated binary semantic integer.");
            const part = buffer[position++];
            if (shift === 63 && part > 1) throw new Error("Overflowing binary semantic integer.");
            wide |= BigInt(part & 127) << BigInt(shift);
            if (!(part & 128)) {
                if (!part) throw new Error("Noncanonical binary semantic integer.");
                return wide;
            }
        }
        throw new Error("Overflowing binary semantic integer.");
    }

    function value(ending, prefix = false, grouped = false) {
        const token = varint(ending);
        const wide = typeof token === "bigint";
        const kind = wide ? Number(token & 7n) : token % 8;
        const payload = wide ? token >> 3n : Math.floor(token / 8);
        const zero = wide ? 0n : 0;
        if (kind === 0) {
            if (payload !== zero) throw new Error("Invalid empty binary semantic value.");
            return "";
        }
        if (kind === 1 || kind === 2) {
            if (kind === 2 && payload === zero) throw new Error("Noncanonical binary semantic negative zero.");
            return (kind === 2 ? "-" : "") + String(payload);
        }
        if (kind === 3) {
            if (payload < 1 || payload >= strings.length) throw new Error("Invalid binary semantic string reference.");
            return strings[Number(payload)];
        }
        if (kind === 4 || kind === 5) {
            if (payload < 1 || payload > ending - position) throw new Error("Invalid binary semantic string length.");
            const length = Number(payload);
            const result = buffer.toString("latin1", position, position + length);
            position += length;
            if (/[^\x20-\x7e]/.test(result)) throw new Error("Unescaped binary semantic string bytes.");
            if (kind === 4) {
                if (strings.length > MAX_BINARY_STRINGS || length > MAX_BINARY_STRING_BYTES - stringBytes) {
                    throw new Error("Binary semantic dictionary exceeds its byte limit.");
                }
                strings.push(result);
                stringBytes += length;
            }
            return result;
        }
        if (kind === 6) {
            if (payload !== zero || prefix) throw new Error("Invalid binary semantic prefix token.");
            const result = value(ending, true, grouped);
            const suffix = varint(ending);
            if (!result.endsWith(":") || suffix > MAX_BINARY_INTEGER) throw new Error("Invalid binary semantic prefix value.");
            return result + String(suffix);
        }
        if (prefix || grouped || payload < 2 || payload > 256 || !supported.has("structured-values")) {
            throw new Error("Invalid binary semantic structured value.");
        }
        const parts = [];
        let length = 0;
        for (let index = 0; index < Number(payload); index++) {
            const part = value(ending, false, true);
            length += part.length + (index ? 3 : 0);
            if (length > maxRecordBytes) throw new Error("Expanded binary semantic tuple exceeds its byte limit.");
            parts.push(part);
        }
        return parts.join("%09");
    }

    function account(row) {
        expandedBytes += row.length + 1;
        if (++recordCount > options.maxRecords || expandedBytes > maxExpandedBytes) {
            throw new Error("Expanded binary semantic model exceeds its byte or record limit.");
        }
        return row;
    }

    yield account(`FBCSEM\t27\t${metadata.get("producer")}`);
    let ended = false;
    while (position < buffer.length) {
        if (ended) throw new Error("Compiler semantic records follow the terminal marker.");
        if (buffer.length - position < 4) throw new Error("Truncated binary semantic frame.");
        const length = buffer.readUInt32LE(position);
        position += 4;
        if (length < 2 || length > maxRecordBytes || length > buffer.length - position) {
            throw new Error("Binary semantic frame exceeds its byte limit or is truncated.");
        }
        const ending = position + length;
        const record = records.get(buffer[position++]);
        const fieldCount = buffer[position++];
        if (!record || record.tag === "FBCSEM" || record.arity !== fieldCount + 1) {
            throw new Error("Unknown binary semantic record or field count.");
        }
        const fields = [record.tag];
        let rowBytes = record.tag.length;
        for (let index = 0; index < fieldCount; index++) {
            const field = value(ending);
            rowBytes += field.length + 1;
            if (rowBytes > maxRecordBytes) throw new Error("Expanded binary semantic record exceeds its byte limit.");
            fields.push(field);
        }
        if (position !== ending) throw new Error("Trailing bytes inside binary semantic record.");
        ended = record.tag === "END" || record.tag === "RECOVERY";
        yield account(fields.join("\t"));
    }
}

/* Diagnostic TSV remains useful for old compilers and mutation fixtures.
   Binary bytes must reach this boundary intact, never through UTF-8 decoding. */
function* readCompilerSemanticRows(input, options = {}) {
    options = { ...DEFAULT_LIMITS, ...options };
    for (const key of Object.keys(DEFAULT_LIMITS)) {
        if (!Number.isSafeInteger(options[key]) || options[key] < 0 || options[key] > DEFAULT_LIMITS[key]) {
            throw new TypeError(`Invalid compiler semantic transport limit: ${key}.`);
        }
    }
    if (Buffer.isBuffer(input)) {
        if (input.length > options.maxBytes) throw new Error("Compiler semantic model exceeded 64 MiB.");
        if (input.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
            yield* readBinarySemanticRows(input, options);
            return;
        }
        /* Schemas before 20 allowed literal UTF-8 in text fields. The graph
           reader enforces byte-safe escapes for newer diagnostic exports. */
        input = input.toString("utf8");
    }
    if (typeof input !== "string") throw new TypeError("Compiler semantic model must be a Buffer or text.");
    if (Buffer.byteLength(input, "utf8") > options.maxBytes) throw new Error("Compiler semantic model exceeded 64 MiB.");
    if (input.includes("\0")) throw new Error("Compiler semantic model contains a NUL character.");
    let length = input.length;
    while (length && input[length - 1] === "\n") {
        length--;
        if (length && input[length - 1] === "\r") length--;
    }
    let position = 0;
    while (position < length) {
        const ending = input.indexOf("\n", position);
        const next = ending < 0 || ending > length ? length : ending;
        yield input.slice(position, next).replace(/\r$/, "");
        position = next + 1;
    }
}

module.exports = { BINARY_MAGIC, readCompilerSemanticRows };

/* end of lib/compiler-semantic-transport.js */
