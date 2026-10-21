/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-workspace-symbols.js
    Purpose: Cache native symbol summaries without retaining workspace AST graphs.
    Responsibilities: index one context at a time and verify multi-module results.
    Does not contain: workspace discovery, guessed declarations, or source writes.
*/

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { serialize } = require("v8");
const { threadId } = require("worker_threads");
const { compilerSymbolRecords } = require("./compiler-document-symbols");
const { fileStamp, sameStamp, compilerExecutableIdentity } = require("./compiler-model-store");
const { MAX_ANALYSIS_BYTES, decodeCompilerSourceBuffer } = require("./compiler-analysis");
const { normalizeIdentifier } = require("./freebasic-parser");

const WORKSPACE_PASS_IDLE_TTL_MS = 5 * 60 * 1000;
const WORKSPACE_SYMBOL_STRIDE = 13;
/* Field 12 holds presentation flags, retaining the legacy deprecation bit.
   Function/method are mutually exclusive; no extra per-symbol word is needed. */
const SYMBOL_DEPRECATED = 1;
const SYMBOL_METHOD = 2;
const SYMBOL_FUNCTION = 4;
const SYMBOL_FLAGS = SYMBOL_DEPRECATED | SYMBOL_METHOD | SYMBOL_FUNCTION;
// 8,192 records occupy just over 416 KiB and bound chunk/copy overhead.
const WORKSPACE_SYMBOL_CHUNK_RECORDS = 8192;
/*
    Workspace declaration summaries are much smaller than native models, but
    large configured projects can still exceed the old 64 MiB ceiling and make
    every repeated search recompile the same modules. Keep enough headroom for
    a several-hundred-module project while retaining an explicit memory bound.
*/
const CACHE_BYTES = 256 * 1024 * 1024;
const digest = (text) => createHash("sha256").update(text.replace(/^\uFEFF/, "")).digest("hex");
const sourceText = (file) => {
    if (fileStamp(file).size > MAX_ANALYSIS_BYTES) throw new Error("Workspace symbol source exceeds 32 MiB.");
    return decodeCompilerSourceBuffer(fs.readFileSync(file), file);
};
const workspaceMemorySample = () => {
    const memory = process.memoryUsage();
    return {
        processRssBytes: memory.rss,
        workerHeapUsedBytes: memory.heapUsed,
        workerExternalBytes: memory.external,
        workerArrayBufferBytes: memory.arrayBuffers || 0
    };
};

function captureWorkspaceSources(sources) {
    return sources.map((source) => ({
        file: source.uri.fsPath,
        hash: digest(source.text),
        overlay: source.overlay,
        stamp: source.stamp
    }));
}

/*
    Workspace searches need only a small projection of each symbol record.
    Shared string fields such as symbol kinds and namespace names are interned
    once per module. Flat integer records avoid retaining a separate JavaScript
    array for every declaration; normalized names avoid rescanning and
    lowercasing every declaration for each editor query.
*/
function packWorkspaceSymbols(entries) {
    const packer = createWorkspaceSymbolPacker();
    for (const entry of entries) packer.add(entry);
    return packer.finish();
}

function createWorkspaceSymbolPacker() {
    const strings = [], stringIds = new Map();
    const intern = (value) => {
        if (typeof value !== "string") return -1;
        let id = stringIds.get(value);
        if (id === undefined) {
            id = strings.length;
            strings.push(value);
            stringIds.set(value, id);
        }
        return id;
    };
    const chunks = [];
    let packed = new Int32Array(WORKSPACE_SYMBOL_CHUNK_RECORDS * WORKSPACE_SYMBOL_STRIDE);
    let chunkRecords = 0, recordCount = 0, hasExpandedSymbol = false, finished = false;
    const add = (entry) => {
        if (finished) throw new Error("Workspace symbol packer is already finished.");
        if (chunkRecords === WORKSPACE_SYMBOL_CHUNK_RECORDS) {
            chunks.push(packed);
            packed = new Int32Array(WORKSPACE_SYMBOL_CHUNK_RECORDS * WORKSPACE_SYMBOL_STRIDE);
            chunkRecords = 0;
        }
        const qualifiedName = entry.qualifiedName || entry.name;
        const uriValue = entry.uri.scheme === "file" ? entry.uri.fsPath : entry.uri.value;
        const offset = chunkRecords * WORKSPACE_SYMBOL_STRIDE;
        packed[offset] = intern(entry.name);
        packed[offset + 1] = intern(entry.type);
        packed[offset + 2] = intern(entry.containerName || "");
        packed[offset + 3] = intern(qualifiedName);
        packed[offset + 4] = intern(normalizeIdentifier(qualifiedName));
        packed[offset + 5] = intern(entry.signature);
        packed[offset + 6] = intern(entry.uri.scheme);
        packed[offset + 7] = intern(uriValue);
        packed[offset + 8] = entry.selection.start.line;
        packed[offset + 9] = entry.selection.start.character;
        packed[offset + 10] = entry.selection.end.line;
        packed[offset + 11] = entry.selection.end.character;
        let flags = entry.deprecated === true ? SYMBOL_DEPRECATED : 0;
        if (entry.callableKind === "method") flags |= SYMBOL_METHOD;
        else if (entry.callableKind === "function") flags |= SYMBOL_FUNCTION;
        packed[offset + 12] = flags;
        if (entry.uri.scheme === "freebasic-preprocessed") hasExpandedSymbol = true;
        chunkRecords++;
        recordCount++;
    };
    const finish = () => {
        if (finished) throw new Error("Workspace symbol packer is already finished.");
        if (chunkRecords) chunks.push(packed.subarray(0, chunkRecords * WORKSPACE_SYMBOL_STRIDE));
        const entries = new Int32Array(recordCount * WORKSPACE_SYMBOL_STRIDE);
        let offset = 0;
        for (const chunk of chunks) {
            entries.set(chunk, offset);
            offset += chunk.length;
        }
        finished = true;
        chunks.length = 0;
        stringIds.clear();
        packed = new Int32Array(0);
        return { strings, entries, hasExpandedSymbol };
    };
    return { add, finish };
}

function compactWorkspaceEntries(entries, sourceStrings, selectedOffsets = null) {
    if (!ArrayBuffer.isView(entries) || entries.length % WORKSPACE_SYMBOL_STRIDE !== 0) {
        throw new Error("Workspace symbol records must be a flat typed array with complete entries.");
    }
    if (selectedOffsets !== null && (!Array.isArray(selectedOffsets) || selectedOffsets.some((offset) =>
        !Number.isSafeInteger(offset) || offset < 0 || offset % WORKSPACE_SYMBOL_STRIDE !== 0 || offset + WORKSPACE_SYMBOL_STRIDE > entries.length))) {
        throw new Error("Workspace symbol selection contains an invalid record offset.");
    }
    const strings = [], stringIds = new Map();
    const intern = (sourceId) => {
        if (sourceId < 0) return -1;
        const value = sourceStrings[sourceId];
        let id = stringIds.get(value);
        if (id === undefined) {
            id = strings.length;
            strings.push(value);
            stringIds.set(value, id);
        }
        return id;
    };
    const entryCount = selectedOffsets === null ? entries.length / WORKSPACE_SYMBOL_STRIDE : selectedOffsets.length;
    const packedEntries = new Int32Array(entryCount * WORKSPACE_SYMBOL_STRIDE);
    for (let index = 0; index < entryCount; index++) {
        const sourceOffset = selectedOffsets === null ? index * WORKSPACE_SYMBOL_STRIDE : selectedOffsets[index];
        const targetOffset = index * WORKSPACE_SYMBOL_STRIDE;
        for (let field = 0; field < 8; field++) packedEntries[targetOffset + field] = intern(entries[sourceOffset + field]);
        for (let field = 8; field < WORKSPACE_SYMBOL_STRIDE; field++) {
            packedEntries[targetOffset + field] = entries[sourceOffset + field];
        }
    }
    return { strings, entries: packedEntries };
}

function workspaceSymbolKey(entry) {
    return JSON.stringify([
        entry.uri.scheme === "file" ? entry.uri.fsPath : entry.uri.value,
        entry.selection.start.line,
        entry.selection.start.character,
        entry.selection.end.line,
        entry.selection.end.character,
        entry.name,
        entry.type,
        entry.signature
    ]);
}

function workspaceSymbolKeyFromPacked(entry, strings, offset = 0) {
    return JSON.stringify([
        strings[entry[offset + 7]],
        entry[offset + 8],
        entry[offset + 9],
        entry[offset + 10],
        entry[offset + 11],
        strings[entry[offset]],
        strings[entry[offset + 1]],
        entry[offset + 5] < 0 ? undefined : strings[entry[offset + 5]]
    ]);
}

function unpackWorkspaceSymbol(packed, strings, offset = 0) {
    if (!ArrayBuffer.isView(packed) || !Number.isSafeInteger(offset) || offset < 0 ||
        offset % WORKSPACE_SYMBOL_STRIDE !== 0 || offset + WORKSPACE_SYMBOL_STRIDE > packed.length) {
        throw new Error("Workspace symbol record offset is invalid.");
    }
    const value = (id) => id < 0 ? undefined : strings[id];
    const name = packed[offset], type = packed[offset + 1], containerName = packed[offset + 2];
    const qualifiedName = packed[offset + 3], signature = packed[offset + 5];
    const scheme = packed[offset + 6], uriValue = packed[offset + 7];
    const startLine = packed[offset + 8], startCharacter = packed[offset + 9];
    const endLine = packed[offset + 10], endCharacter = packed[offset + 11];
    const flags = packed[offset + 12];
    if ((flags & ~SYMBOL_FLAGS) !== 0 || (flags & SYMBOL_METHOD) && (flags & SYMBOL_FUNCTION)) {
        throw new Error("Workspace symbol presentation flags are invalid.");
    }
    const uriScheme = value(scheme);
    const target = value(uriValue);
    const uri = uriScheme === "file"
        ? { scheme: uriScheme, fsPath: target }
        : { scheme: uriScheme, value: target };
    return {
        name: value(name),
        type: value(type),
        containerName: value(containerName),
        qualifiedName: value(qualifiedName),
        signature: value(signature),
        deprecated: Boolean(flags & SYMBOL_DEPRECATED),
        ...(flags & SYMBOL_METHOD ? { callableKind: "method" } : flags & SYMBOL_FUNCTION ? { callableKind: "function" } : {}),
        uri,
        selection: {
            start: { line: startLine, character: startCharacter },
            end: { line: endLine, character: endCharacter }
        }
    };
}

function mapPackedWorkspaceEntries(entries, strings, project = unpackWorkspaceSymbol) {
    if (!ArrayBuffer.isView(entries) || entries.length % WORKSPACE_SYMBOL_STRIDE !== 0) {
        throw new Error("Workspace symbol records must be a flat typed array with complete entries.");
    }
    const result = new Array(entries.length / WORKSPACE_SYMBOL_STRIDE);
    for (let index = 0; index < result.length; index++) {
        result[index] = project(entries, strings, index * WORKSPACE_SYMBOL_STRIDE);
    }
    return result;
}

function verifyWorkspaceCompilers(pass, checkCancelled) {
    for (const compiler of pass.compilers.values()) {
        checkCancelled();
        if (JSON.stringify(compilerExecutableIdentity(compiler.compilerPath, compiler.cwd, compiler.environment)) !== compiler.identity) {
            throw new Error("Compiler executable changed during workspace indexing.");
        }
    }
}

class CompilerWorkspaceSymbols {
    constructor() { this.cache = new Map(); this.bytes = 0; this.sequence = 0; this.pass = null; }

    begin(buffers, query, limit) {
        this.discard();
        if (typeof query !== "string" || query.length > 4096 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw new Error("Invalid native workspace symbol query or result limit.");
        const id = `${threadId}:workspace:${++this.sequence}`;
        this.pass = { id, buffers, query: normalizeIdentifier(query), limit, guards: new Map(), compilers: new Map(), expiresAt: 0, timer: null };
        this.refresh(this.pass);
        return { workspaceId: id };
    }

    active(id) {
        if (!this.pass || this.pass.id !== id || this.pass.expiresAt <= Date.now()) throw new Error("The native workspace symbol pass has expired.");
        this.refresh(this.pass);
        return this.pass;
    }

    discard(id = this.pass?.id) {
        if (!this.pass || this.pass.id !== id) return;
        clearTimeout(this.pass.timer);
        this.pass = null;
    }

    refresh(pass) {
        clearTimeout(pass.timer);
        pass.expiresAt = Date.now() + WORKSPACE_PASS_IDLE_TTL_MS;
        const expire = () => {
            if (this.pass !== pass) return;
            const remaining = pass.expiresAt - Date.now();
            if (remaining <= 0) this.discard(pass.id);
            else pass.timer = setTimeout(expire, remaining);
        };
        pass.timer = setTimeout(expire, WORKSPACE_PASS_IDLE_TTL_MS);
    }

    current(record, buffers, checkCancelled) {
        try {
            for (const source of record.sources) {
                checkCancelled();
                const file = source.file;
                if (buffers.has(file)) {
                    if (digest(buffers.get(file)) !== source.hash) return false;
                } else if (source.overlay) {
                    if (digest(sourceText(file)) !== source.hash) return false;
                } else if (!sameStamp(source.stamp, fileStamp(file))) return false;
            }
            return true;
        } catch { checkCancelled(); return false; }
    }

    remove(key) {
        const entry = this.cache.get(key);
        if (entry) { this.bytes -= entry.bytes; this.cache.delete(key); }
    }

    async index(options, context, models, analyze, checkCancelled) {
        const pass = this.active(context.id);
        verifyWorkspaceCompilers(pass, checkCancelled);
        const compilerIdentity = compilerExecutableIdentity(options.compilerPath, path.dirname(options.filePath), options.environment);
        /* Keep only executable-search inputs, not a whole environment copy per
           module. Source and executable guards share the pass's bounded life. */
        const compilerEnvironment = Object.fromEntries(Object.entries(options.environment || process.env)
            .filter(([name]) => ["PATH", "NODEFAULTCURRENTDIRECTORYINEXEPATH"].includes(name.toUpperCase())));
        const compiler = { compilerPath: options.compilerPath, cwd: path.dirname(options.filePath), environment: compilerEnvironment };
        const compilerKey = compilerIdentity?.filePath || JSON.stringify(compiler);
        pass.compilers.set(compilerKey, { ...compiler, identity: JSON.stringify(compilerIdentity) });
        if (pass.compilers.size > 5000) throw new Error("Workspace symbols exceeded the 5000-compiler verification limit.");
        const contextKey = JSON.stringify([options.compilerPath, compilerIdentity,
            options.filePath, options.compilerArguments, options.environment]);
        const key = createHash("sha256").update(contextKey).digest("hex");
        let record = this.cache.get(key);
        let projectionMemory = null;
        const cached = Boolean(record?.contextKey === contextKey && this.current(record, pass.buffers, checkCancelled));
        if (!cached) {
            this.remove(key);
            const value = `freebasic-preprocessed:/workspace-${threadId}-${++this.sequence}.bas`;
            const reply = await models.prepare({ ...options, overlays: pass.buffers, allowErrors: true }, { requestedFile: options.filePath, expandedUri: { scheme: "freebasic-preprocessed", value, path: `/workspace-${threadId}-${this.sequence}.bas` } }, analyze, checkCancelled);
            const snapshot = models.models.get(reply.snapshotId);
            try {
                const packer = createWorkspaceSymbolPacker();
                compilerSymbolRecords(snapshot.model, null, checkCancelled, {
                    workspaceOnly: true,
                    onWorkspaceRecord: (entry) => packer.add(entry)
                });
                const packed = packer.finish();
                record = {
                    sources: captureWorkspaceSources(snapshot.sources),
                    strings: packed.strings,
                    entries: packed.entries,
                    text: packed.hasExpandedSymbol ? reply.text : "",
                    uri: value,
                    contextKey
                };
                record.bytes = serialize(record).byteLength * 2;
                if (options.profileWorkspaceMemory === true) projectionMemory = workspaceMemorySample();
                // Retention is bounded independently of native model memory.
                // A large result may serve this request without being cached.
                if (record.bytes <= CACHE_BYTES) {
                    while (this.bytes + record.bytes > CACHE_BYTES || this.cache.size >= 5000) this.remove(this.cache.keys().next().value);
                    this.cache.set(key, record);
                    this.bytes += record.bytes;
                }
            } finally { models.remove(reply.snapshotId); }
        } else {
            this.cache.delete(key);
            this.cache.set(key, record);
        }
        checkCancelled();
        this.active(context.id);
        try { verifyWorkspaceCompilers(pass, checkCancelled); }
        catch (error) {
            this.remove(key);
            throw error;
        }
        if (!this.current(record, pass.buffers, checkCancelled)) { this.remove(key); throw new Error("Workspace symbol source changed during indexing."); }
        for (const source of record.sources) {
            checkCancelled();
            const file = source.file;
            const guard = { hash: source.hash, overlay: pass.buffers.has(file), stamp: source.stamp };
            if (!guard.overlay && !guard.stamp) {
                guard.stamp = fileStamp(file);
                if (digest(sourceText(file)) !== guard.hash || !sameStamp(guard.stamp, fileStamp(file))) throw new Error("Workspace symbol source changed after its buffer closed.");
            }
            const prior = pass.guards.get(file);
            if (prior && (prior.hash !== guard.hash || prior.overlay !== guard.overlay || !prior.overlay && JSON.stringify(prior.stamp) !== JSON.stringify(guard.stamp))) throw new Error("Workspace symbol inputs changed between translation units.");
            pass.guards.set(file, guard);
            if (pass.guards.size > 5000) throw new Error("Workspace symbols exceeded the 5000-source verification limit.");
        }
        const matchingOffsets = [];
        let hasExpandedSymbol = false;
        for (let offset = 0; offset < record.entries.length; offset += WORKSPACE_SYMBOL_STRIDE) {
            checkCancelled();
            if (pass.query && !record.strings[record.entries[offset + 4]].includes(pass.query)) continue;
            matchingOffsets.push(offset);
            if (record.strings[record.entries[offset + 6]] === "freebasic-preprocessed") hasExpandedSymbol = true;
            if (matchingOffsets.length >= pass.limit) break;
        }
        const packedResults = compactWorkspaceEntries(record.entries, record.strings, matchingOffsets);
        const resultBytes = serialize(packedResults).byteLength;
        if (resultBytes > 8 * 1024 * 1024) throw new Error("Workspace symbol results exceeded 8 MiB.");
        const expanded = hasExpandedSymbol ? { uri: record.uri, text: record.text } : null;
        const afterSearchMemory = options.profileWorkspaceMemory === true ? workspaceMemorySample() : null;
        return {
            packedEntries: packedResults.entries,
            strings: packedResults.strings,
            resultBytes,
            expanded,
            ...(options.profileWorkspaceMemory === true ? { workspaceMemory: {
                projection: projectionMemory,
                afterSearch: afterSearchMemory
            } } : {}),
            cached,
            declarations: record.entries.length / WORKSPACE_SYMBOL_STRIDE,
            cache: {
                entries: this.cache.size,
                bytes: this.bytes,
                recordBytes: record.bytes,
                retained: this.cache.has(key)
            }
        };
    }

    finish(id, buffers, checkCancelled) {
        const pass = this.active(id);
        try {
            verifyWorkspaceCompilers(pass, checkCancelled);
            for (const [file, guard] of pass.guards) {
                checkCancelled();
                if (buffers.has(file)) {
                    if (digest(buffers.get(file)) !== guard.hash) throw new Error("Workspace symbol editor buffers changed.");
                } else if (guard.overlay) {
                    if (digest(sourceText(file)) !== guard.hash) throw new Error("Workspace symbol source changed after its buffer closed.");
                } else if (!sameStamp(guard.stamp, fileStamp(file))) throw new Error("Workspace symbol disk sources changed.");
            }
            for (const [file, text] of buffers) {
                checkCancelled();
                if (!pass.guards.has(file) && !pass.buffers.has(file) && sourceText(file) !== text) throw new Error("A new dirty buffer changed workspace symbol inputs.");
            }
            verifyWorkspaceCompilers(pass, checkCancelled);
            return { verified: true, sources: pass.guards.size };
        } finally { this.discard(id); }
    }

    clear() { this.discard(); this.cache.clear(); this.bytes = 0; }
}

module.exports = {
    CompilerWorkspaceSymbols,
    WORKSPACE_SYMBOL_STRIDE,
    captureWorkspaceSources,
    compactWorkspaceEntries,
    mapPackedWorkspaceEntries,
    packWorkspaceSymbols,
    unpackWorkspaceSymbol,
    workspaceSymbolKey,
    workspaceSymbolKeyFromPacked
};

/* end of lib/compiler-workspace-symbols.js */
