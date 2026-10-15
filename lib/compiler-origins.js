/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-origins.js
    Purpose: Validate physical token origins and project them into editor text.
    Responsibilities: verify byte boundaries, source identities, and spellings.
    Does not contain: preprocessing, filesystem reads, or symbol resolution.
*/

const path = require("path");
const { createMacroProjector, macroGraphSignature } = require("./compiler-macros");
const { normalizeIdentifier } = require("./freebasic-parser");

const MAX_TOKENS = 200000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

function createOriginDecoder(decodeHex, integer, cwd) {
    const tokens = [];
    return {
        hasTokens() { return tokens.length > 0; },
        read(line) {
            const current = line.match(/^''@fb-editor-token-v11 (\d+) (\d+) (\d+) (source|generated) (\d+) (\d+) (\d+) (\d+) (\d+)$/i);
            const modern = current || line.match(/^''@fb-editor-token-v10 (\d+) (\d+) (\d+) (source|generated) (\d+) (\d+) (\d+) (\d+)$/i);
            const match = modern || line.match(/^''@fb-editor-token (\d+) (\d+) (\d+) (source|generated) (\d+) (\d+) ([a-f\d]+)$/i);
            if (!match) return false;
            tokens.push({ serial: integer(match[1], 1), startByte: integer(match[2]), endByte: integer(match[3]), kind: match[4].toLowerCase(), sourceStart: integer(match[5]), sourceEnd: integer(match[6]), filePath: modern ? null : path.resolve(cwd, decodeHex(match[7], "physical token path")), fileId: modern ? integer(match[7], 1) : 0, sourceMap: modern ? integer(match[8]) : 0 });
            if (current) tokens.at(-1).epoch = integer(current[9]);
            if (tokens.length > MAX_TOKENS) throw new Error("Compiler token origins exceeded their 200000-token limit.");
            return true;
        },
        finish(position, dependencies, invalidLines, fileIdentities, protocolVersion) {
            const previousEnds = new Map();
            for (const token of tokens) {
                if (token.fileId) token.filePath = fileIdentities.get(token.fileId);
                if (protocolVersion >= 10 && !token.fileId || token.kind === "source" && token.sourceMap) throw new Error("Compiler physical token format does not match its protocol.");
                token.start = position(token.serial, token.startByte);
                token.end = position(token.serial, token.endByte);
                if (token.endByte <= token.startByte || token.startByte < (previousEnds.get(token.serial) || 0)) throw new Error("Overlapping or empty compiler token origin.");
                previousEnds.set(token.serial, token.endByte);
                if (!dependencies.has(token.filePath)) throw new Error("Compiler token origin has no physical source dependency.");
                if (token.sourceEnd > MAX_SOURCE_BYTES || token.kind === "source" && token.sourceEnd <= token.sourceStart || token.kind === "generated" && (token.sourceStart || token.sourceEnd)) throw new Error("Invalid compiler physical token range.");
                token.invalid = invalidLines.has(token.start.line);
            }
            return tokens;
        }
    };
}

function compilerPathKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function mappedPhysicalByteOffset(offset, mapping, filePath) {
    if (!mapping) return offset;
    if (offset < 0 || offset > mapping.byteLength) throw new Error(`Compiler physical token boundary is outside its legacy source: ${filePath}`);
    const mapped = mapping.positions.get(offset);
    if (!Number.isSafeInteger(mapped)) throw new Error(`Compiler physical token boundary has no legacy-byte mapping: ${filePath}`);
    return mapped;
}

function projectNativeTokens(model, records, expanded, macroGraph = { nodes: [] }, outputText = expanded.text, physicalSourceByteOffsets = null) {
    const projectMacro = createMacroProjector(macroGraph);
    const documents = new Map();
    for (const document of model.sources.values()) {
        // The compiler counts UTF-8 bytes after the encoding marker. Callers
        // normally supply VS Code text without it; standalone clients may not.
        const markerLength = document.text.startsWith("\uFEFF") ? 1 : 0;
        const text = document.text.slice(markerLength);
        const bytes = Buffer.from(text);
        if (bytes.toString("utf8") !== text) throw new Error("Physical source contains an unmatched Unicode surrogate.");
        const boundaries = new Map([[0, markerLength]]);
        let byte = 0, offset = markerLength;
        // One pass builds only token boundaries, not one object per source byte.
        const offsets = new Set(document.tokens.flatMap((token) => [token.offset, token.end]));
        for (const char of text) {
            byte += Buffer.byteLength(char);
            offset += char.length;
            if (offsets.has(offset)) boundaries.set(byte, offset);
        }
        documents.set(document.uri.fsPath, { document, text, bytes, boundaries, tokens: new Map(document.tokens.map((token) => [token.offset, token])) });
    }
    const expandedLines = outputText.split("\n");
    const byLine = new Map();
    for (const token of expanded.tokens) {
        const list = byLine.get(token.line) || [];
        list.push(token);
        byLine.set(token.line, list);
    }
    const nextByLine = new Map();
    for (let record of records) {
        /* Failed statements keep physical token origins so expression queries
           can map completed prefixes. Only direct written tokens use this
           recovery projection; names remain excluded from resolution/rename. */
        const recoveryOnly = record.invalid;
        if (recoveryOnly && (record.kind !== "source" || record.sourceMap)) continue;
        if (record.kind !== "source") {
            const physical = projectMacro(record.sourceMap);
            if (!physical) continue;
            record = { ...record, ...physical };
        }
        const source = documents.get(record.filePath);
        if (!source) throw new Error("A physical token's source snapshot is missing.");
        const sourceOffsets = physicalSourceByteOffsets?.get(compilerPathKey(record.filePath));
        const sourceStart = mappedPhysicalByteOffset(record.sourceStart, sourceOffsets, record.filePath);
        const sourceEnd = mappedPhysicalByteOffset(record.sourceEnd, sourceOffsets, record.filePath);
        const span = source.bytes.subarray(sourceStart, sourceEnd);
        const spelling = span.toString("utf8");
        // Even rewritten literals must retain valid source bounds. Never let
        // a stale/truncated buffer quietly become an editable projection.
        if (sourceEnd > source.bytes.length || !Buffer.from(spelling).equals(span)) {
            throw new Error(`Compiler physical token boundary does not match source text: ${record.filePath}:${record.sourceStart}-${record.sourceEnd}.`);
        }
        const sourceOffset = source.boundaries.get(sourceStart);
        if (sourceOffset === undefined) continue;
        const firstToken = source.tokens.get(sourceOffset);
        const written = expandedLines[record.start.line].slice(record.start.character, record.end.character);
        // hReadIdentifier consumes a legacy type suffix but lexGetText omits
        // it. Project only the identifier's base spelling; its suffix remains
        // untouched by a rename and continues to determine the native type.
        const droppedIdentifierSuffix = /^[a-z_][a-z\d_.]*[$%!#&]$/i.test(spelling) && spelling.slice(0, -1).toLowerCase() === written.toLowerCase();
        // Numeric suffixes determine the native type but are omitted from
        // lexGetText(). FBC also drops redundant leading decimal zeroes.
        const numericToken = firstToken?.kind === "number" && firstToken.name === spelling;
        const numericSuffix = numericToken && /(?:ull|ul|ll|u|l|f|d|[%!#&])$/i.exec(spelling);
        const numericBase = numericSuffix ? spelling.slice(0, numericSuffix.index) : spelling;
        const normalizedNumeric = /^0+$/.test(numericBase) ? "0" : numericBase.replace(/^0+(?=[1-9]|\.)/, "");
        const rewrittenNumeric = numericToken && normalizedNumeric.toLowerCase() === written.toLowerCase() &&
            (numericBase !== spelling || normalizedNumeric !== numericBase);
        const droppedIdentifierSuffixLength = droppedIdentifierSuffix ? 1 : 0;
        if (spelling.toLowerCase() !== written.toLowerCase() && !droppedIdentifierSuffix && !rewrittenNumeric) continue;
        if (record.epoch !== undefined && firstToken) {
            // Parser failure retracts bindings/types, not the lexer's observed
            // macro environment. Preserve that separate context for completion
            // on an incomplete identifier without making it a resolved symbol.
            for (let index = firstToken.index; index < source.document.tokens.length; index++) {
                const token = source.document.tokens[index];
                if (token.end > sourceOffset + spelling.length) break;
                const key = `${source.document.uri}:${token.offset}`;
                const epochs = model.sourceEpochs.get(key) || new Set();
                epochs.add(record.epoch);
                model.sourceEpochs.set(key, epochs);
            }
        }
        if (recoveryOnly) {
            if (!firstToken) continue;
            let original = firstToken;
            if (droppedIdentifierSuffix) {
                const name = original.name.slice(0, -droppedIdentifierSuffixLength);
                original = { ...original, name, key: normalizeIdentifier(name), end: original.end - droppedIdentifierSuffixLength, endColumn: original.endColumn - droppedIdentifierSuffixLength };
            }
            const expandedOffset = expanded.lineOffsets[record.start.line] + record.start.character;
            const projected = {
                ...original,
                offset: expandedOffset,
                line: record.start.line,
                startColumn: record.start.character,
                endColumn: record.end.character
            };
            const key = `${source.document.uri}:${original.offset}`;
            const matches = model.recoverySourceToExpanded.get(key) || [];
            matches.push(projected);
            model.recoverySourceToExpanded.set(key, matches);
            model.recoveryExpandedToSource.set(expandedOffset, {
                uri: source.document.uri,
                occurrence: original,
                sourceMap: record.sourceMap,
                epoch: record.epoch
            });
            continue;
        }
        const lineTokens = byLine.get(record.start.line) || [];
        let index = nextByLine.get(record.start.line) || 0;
        while (lineTokens[index]?.startColumn < record.start.character) index++;
        for (; index < lineTokens.length && lineTokens[index].endColumn <= record.end.character; index++) {
            const token = lineTokens[index];
            let original = source.tokens.get(sourceOffset + token.startColumn - record.start.character);
            if (original && droppedIdentifierSuffixLength && original.end - original.offset === token.end - token.offset + droppedIdentifierSuffixLength) {
                const name = original.name.slice(0, -droppedIdentifierSuffixLength);
                original = { ...original, name, key: normalizeIdentifier(name), end: original.end - droppedIdentifierSuffixLength, endColumn: original.endColumn - droppedIdentifierSuffixLength };
            }
            const rewrittenNumber = original && rewrittenNumeric && original.offset === sourceOffset && original.kind === "number" && original.name === spelling;
            if (rewrittenNumber) original = { ...original, key: token.key };
            if (!original || original.key !== token.key || (!rewrittenNumber && original.end - original.offset !== token.end - token.offset)) continue;
            const key = `${source.document.uri}:${original.offset}`;
            const matches = model.sourceToExpanded.get(key) || [];
            matches.push(token);
            model.sourceToExpanded.set(key, matches);
            model.expandedToSource.set(token.offset, { uri: source.document.uri, occurrence: original, sourceMap: record.sourceMap, epoch: record.epoch });
        }
        nextByLine.set(record.start.line, index);
    }
}

/* ------------------------------------------------------------------------- */
/* Refactoring origin invariants                                             */
/* ------------------------------------------------------------------------- */

function coordinateAdjuster(changes) {
    const entries = [...changes].sort((a, b) => a[0] - b[0]);
    let total = 0;
    for (const entry of entries) entry[1] = total += entry[1];
    return (byte) => {
        let low = 0, high = entries.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (entries[middle][0] <= byte) low = middle + 1;
            else high = middle;
        }
        return byte + (low ? entries[low - 1][1] : 0);
    };
}

function tokenOriginSignature(analysis, edits = new Map(), sources = new Map(), renamedIds = new Set(), newName = "", structuralNumericLabel = false, semanticBindingFacts = []) {
    const needsNumericLabelColon = (binding) => structuralNumericLabel instanceof Set
        ? structuralNumericLabel.has(`${binding.outputLine}:${binding.byteColumn}`)
        : structuralNumericLabel && binding.kind === "declaration";
    const physical = new Map(), expanded = new Map();
    const structuralSources = new Map(), structuralOutput = new Map();
    const sourceKey = (file, start, end) => `${file}\0${start}\0${end}`;
    const lines = analysis.text.split("\n");
    const originsBySource = new Map();
    for (const token of analysis.tokenOrigins) {
        if (token.kind !== "source") continue;
        const key = sourceKey(token.filePath, token.sourceStart, token.sourceEnd);
        const matches = originsBySource.get(key) || [];
        matches.push(token);
        originsBySource.set(key, matches);
    }
    const singleLineIfBranches = new Map();
    for (const [file, occurrences] of edits) {
        const text = sources.get(file).replace(/^\uFEFF/, "");
        let offset = 0, byte = 0;
        const changes = new Map();
        const spans = [];
        for (const occurrence of [...occurrences.values()].sort((a, b) => a.offset - b.offset)) {
            byte += Buffer.byteLength(text.slice(offset, occurrence.end));
            offset = occurrence.end;
            const length = Buffer.byteLength(text.slice(occurrence.offset, occurrence.end));
            const replacement = occurrence.newText || newName;
            const replacementBytes = Buffer.byteLength(replacement);
            const start = byte - length;
            changes.set(byte, replacementBytes - length);
            spans.push({ start: byte - length, end: byte });
            if (structuralNumericLabel && replacement.endsWith(":")) structuralSources.set(sourceKey(file, start, byte), { bytes: Buffer.byteLength(replacement.slice(0, -1)) });
            if (occurrence.singleLineIfLabel) {
                if (!replacement.startsWith("Goto ")) throw new Error("Single-line IF label rewrite has no GOTO prefix.");
                singleLineIfBranches.set(sourceKey(file, start, byte), { bytes: Buffer.byteLength("Goto ") });
            }
        }
        const adjust = coordinateAdjuster(changes);
        adjust.boundary = (point) => {
            let low = 0, high = spans.length;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (spans[middle].end <= point) low = middle + 1;
                else high = middle;
            }
            if (spans[low]?.start < point) throw new Error("Rename intersects an interior macro token slice.");
            return adjust(point);
        };
        physical.set(file, adjust);
    }
    const outputBranches = new Map();
    for (const token of analysis.tokenOrigins) {
        if (token.kind !== "source") continue;
        const branch = singleLineIfBranches.get(sourceKey(token.filePath, token.sourceStart, token.sourceEnd));
        if (branch) outputBranches.set(`${token.serial}:${token.startByte}`, branch);
    }
    for (const binding of analysis.symbolGraph.uses) {
        if (!renamedIds.has(binding.id)) continue;
        const changes = expanded.get(binding.outputLine) || new Map();
        const length = Buffer.byteLength(binding.name);
        const replacement = needsNumericLabelColon(binding) ? `${newName}:` : newName;
        changes.set(binding.byteColumn + length, Buffer.byteLength(replacement) - length);
        const branch = outputBranches.get(`${binding.outputLine}:${binding.byteColumn}`);
        if (branch) changes.set(binding.byteColumn, branch.bytes);
        expanded.set(binding.outputLine, changes);
        if (structuralNumericLabel && binding.kind === "declaration") {
            const records = structuralOutput.get(binding.outputLine) || new Map();
            records.set(binding.byteColumn, { end: binding.byteColumn + length, bytes: Buffer.byteLength(newName) });
            structuralOutput.set(binding.outputLine, records);
        }
    }
    /* Some committed parser routes have their own semantic binding export
       without an editor-trace symbol-use hook. Re-project only the exact
       physical token origin already checked against the source spelling; this
       lets post-edit validation account for those compiler-selected names. */
    for (const binding of semanticBindingFacts) {
        if (!renamedIds.has(binding.id) || !Number.isInteger(binding.sourceStart) ||
            !Number.isInteger(binding.sourceEnd) || binding.sourceEnd <= binding.sourceStart) continue;
        const sourceOrigins = originsBySource.get(sourceKey(binding.filePath, binding.sourceStart, binding.sourceEnd)) || [];
        for (const token of sourceOrigins) {
            const outputLine = lines[token.start.line];
            if (outputLine === undefined) continue;
            const outputBytes = Buffer.from(outputLine);
            const spelling = outputBytes.subarray(token.startByte, token.endByte).toString("utf8");
            if (spelling.toLowerCase() !== binding.name.toLowerCase()) continue;
            const changes = expanded.get(token.serial) || new Map();
            const replacement = needsNumericLabelColon({
                kind: binding.kind,
                outputLine: token.serial,
                byteColumn: token.startByte
            }) ? `${newName}:` : newName;
            const endByte = token.startByte + Buffer.byteLength(spelling);
            const delta = Buffer.byteLength(replacement) - Buffer.byteLength(spelling);
            if (changes.has(endByte) && changes.get(endByte) !== delta) throw new Error("Compiler bindings disagree on an edited token origin.");
            changes.set(endByte, delta);
            const branch = outputBranches.get(`${token.serial}:${token.startByte}`);
            if (branch) changes.set(token.startByte, branch.bytes);
            expanded.set(token.serial, changes);
            if (structuralNumericLabel && binding.kind === "declaration") {
                const records = structuralOutput.get(token.serial) || new Map();
                records.set(token.startByte, { end: token.endByte, bytes: Buffer.byteLength(newName) });
                structuralOutput.set(token.serial, records);
            }
        }
    }
    for (const [serial, changes] of expanded) expanded.set(serial, coordinateAdjuster(changes));
    const unchanged = (byte) => byte;
    // Origins must retain their exact physical anchors, not merely the same
    // number of bindings. Only byte shifts caused by the proposed identifier
    // edits are allowed; generated text cannot become editable accidentally.
    const lineReplacements = new Map();
    for (const binding of analysis.symbolGraph.uses) if (renamedIds.has(binding.id)) {
        const entries = lineReplacements.get(binding.line) || new Map();
        const replacement = needsNumericLabelColon(binding) ? `${newName}:` : newName;
        entries.set(binding.byteColumn, { start: binding.byteColumn, end: binding.byteColumn + Buffer.byteLength(binding.name), replacement });
        const branch = outputBranches.get(`${binding.outputLine}:${binding.byteColumn}`);
        if (branch) entries.set(`goto:${binding.byteColumn}`, { start: binding.byteColumn, end: binding.byteColumn, replacement: "Goto " });
        lineReplacements.set(binding.line, entries);
    }
    for (const binding of semanticBindingFacts) {
        if (!renamedIds.has(binding.id)) continue;
        const sourceOrigins = originsBySource.get(sourceKey(binding.filePath, binding.sourceStart, binding.sourceEnd)) || [];
        for (const token of sourceOrigins) {
            const line = lines[token.start.line];
            if (line === undefined) continue;
            const spelling = Buffer.from(line).subarray(token.startByte, token.endByte).toString("utf8");
            if (spelling.toLowerCase() !== binding.name.toLowerCase()) continue;
            const entries = lineReplacements.get(token.start.line) || new Map();
            const replacement = needsNumericLabelColon({
                kind: binding.kind,
                outputLine: token.serial,
                byteColumn: token.startByte
            }) ? `${newName}:` : newName;
            entries.set(token.startByte, {
                start: token.startByte,
                end: token.startByte + Buffer.byteLength(spelling),
                replacement
            });
            const branch = outputBranches.get(`${token.serial}:${token.startByte}`);
            if (branch) entries.set(`goto:${token.startByte}`, { start: token.startByte, end: token.startByte, replacement: "Goto " });
            lineReplacements.set(token.start.line, entries);
        }
    }
    const lineBytes = new Map();
    function expectedLine(index) {
        if (lineBytes.has(index)) return lineBytes.get(index);
        let bytes = Buffer.from(lines[index]);
        for (const change of [...(lineReplacements.get(index)?.values() || [])].sort((a, b) => b.start - a.start)) bytes = Buffer.concat([bytes.subarray(0, change.start), Buffer.from(change.replacement), bytes.subarray(change.end)]);
        lineBytes.set(index, bytes);
        return bytes;
    }
    const text = [];
    for (let index = 0; index < lines.length; index++) if (lines[index].trim()) text.push(expectedLine(index).toString("utf8"));
    const tokens = [];
    for (const token of analysis.tokenOrigins) {
        const output = expanded.get(token.serial) || unchanged;
        const source = token.kind === "source" ? physical.get(token.filePath) || unchanged : unchanged;
        const branch = outputBranches.get(`${token.serial}:${token.startByte}`);
        const outputStructural = structuralOutput.get(token.serial)?.get(token.startByte);
        const outputStart = output(token.startByte);
        const outputEnd = outputStructural?.end === token.endByte ? outputStart + outputStructural.bytes : output(token.endByte);
        const sourceStructural = outputStructural?.end === token.endByte && token.kind === "source" ? structuralSources.get(sourceKey(token.filePath, token.sourceStart, token.sourceEnd)) : null;
        const sourceStart = source(token.sourceStart) + (branch?.bytes || 0);
        const sourceEnd = sourceStructural ? sourceStart + sourceStructural.bytes : source(token.sourceEnd);
        const spelling = expectedLine(token.start.line).subarray(outputStart, outputEnd);
        if (branch) {
            const gotoStart = outputStart - branch.bytes;
            const gotoSourceStart = source(token.sourceStart);
            tokens.push([token.serial, gotoStart, outputStart - 1, token.kind, token.filePath, gotoSourceStart, gotoSourceStart + branch.bytes - 1, token.invalid, token.sourceMap, "476f746f", token.epoch]);
        }
        // In particular, a copied argument can also be stringified elsewhere.
        // Updating its symbol must not silently alter that string's value.
        tokens.push([token.serial, outputStart, outputEnd, token.kind, token.filePath, sourceStart, sourceEnd, token.invalid, token.sourceMap, spelling.toString("hex"), token.epoch]);
        /* The original numeric-label token has no colon. A named declaration
           adds one as a separate compiler token, so model its exact physical
           origin rather than pretending the label identifier consumed it. */
        if (sourceStructural) tokens.push([token.serial, outputEnd, outputEnd + 1, token.kind, token.filePath, sourceEnd, sourceEnd + 1, token.invalid, token.sourceMap, "3a", token.epoch]);
    }
    // Some directives, such as #inclib, use lexPPOnlyEmitText rather than the
    // token writer. Compare their retained text too, not just mapped tokens.
    return { tokens, maps: macroGraphSignature(analysis.macroGraph, physical), text };
}

module.exports = { createOriginDecoder, projectNativeTokens, tokenOriginSignature };

/* end of lib/compiler-origins.js */
