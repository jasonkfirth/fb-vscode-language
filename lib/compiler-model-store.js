/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-model-store.js
    Purpose: Prepare immutable native editor models inside the analysis worker.
    Responsibilities: freeze source/compiler inputs, reuse path hints, verify freshness.
    Does not contain: VS Code APIs, guessed include resolution, or source writes.
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { serialize } = require("v8");
const { performance } = require("perf_hooks");
const { threadId } = require("worker_threads");
const { CompilerSemanticModel } = require("./compiler-semantic-model");
const { MAX_ANALYSIS_BYTES, compilerMissingIncludeState, decodeCompilerSourceBuffer } = require("./compiler-analysis");

const MODEL_CACHE_BYTES = 128 * 1024 * 1024;
/* Keep several small editor modules warm without raising the byte budget.
   Large graphs still evict other entries or use the existing exclusive slot. */
const MODEL_CACHE_ENTRIES = 8;
/*
    Keep path-only hints for common editor contexts without retaining source text.
    The LRU stays within 32 contexts and 4 MiB; sources are reread and stamped.
*/
const DEPENDENCY_HINT_CACHE_BYTES = 4 * 1024 * 1024;
const DEPENDENCY_HINT_CACHE_ENTRIES = 32;
// Macro-heavy upstream tests can expand a small module into a much larger
// provenance graph. Admit one such model exclusively, not two enlarged caches.
// The charge remains conservative; Node separately caps worker old-generation
// heap at 512 MiB, which does not include every external buffer or RSS page.
const SINGLE_MODEL_BYTES = 384 * 1024 * 1024;

class CompilerUri {
    constructor(scheme, filePath, value, uriPath = filePath) {
        this.scheme = scheme;
        this.fsPath = filePath;
        this.path = uriPath;
        this.value = value;
    }
    toString() { return this.value; }
    static file(file) { return new CompilerUri("file", file, `file://${file}`); }
    static from(record) {
        return record.scheme === "file" ? CompilerUri.file(record.fsPath) : new CompilerUri(record.scheme, "", record.value, record.path);
    }
}

function fileStamp(file) {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino, dev: stat.dev };
}

function sameStamp(first, second) {
    return first && second && Object.keys(first).every((key) => first[key] === second[key]);
}

function compilerExecutableIdentity(compilerPath, cwd = process.cwd(), environment = process.env) {
    if (typeof compilerPath !== "string" || !compilerPath || compilerPath.includes("\0")) return null;
    const windows = process.platform === "win32";
    const environmentValue = (name) => windows
        ? environment[Object.keys(environment).sort().find((key) => key.toUpperCase() === name.toUpperCase())]
        : environment[name];
    const hasDirectory = path.isAbsolute(compilerPath) || (windows ? /[\\/:]/ : /\//).test(compilerPath);
    let directories = [cwd], names = [compilerPath];
    if (!hasDirectory) {
        const searchPath = environmentValue("PATH") ?? (windows ? "" : "/usr/bin:/bin");
        directories = windows
            ? searchPath.match(/(?:"[^"]*"|'[^']*'|[^;])+/g) || []
            : searchPath.split(path.delimiter);
        if (windows && environmentValue("NoDefaultCurrentDirectoryInExePath") === undefined) directories.unshift(cwd);
    }
    if (windows) {
        /* Node launches directly through libuv, not a shell. Its executable
           search tries .com then .exe, rather than the PATHEXT shell list.
           https://github.com/libuv/libuv/blob/v1.x/src/win/process.c */
        const name = path.basename(compilerPath);
        const dot = name.indexOf(".");
        const separator = compilerPath.endsWith(".") ? "" : ".";
        names = [...(hasDirectory || dot >= 0 && dot < name.length - 1 ? [compilerPath] : []),
            `${compilerPath}${separator}com`, `${compilerPath}${separator}exe`];
    }
    for (const directory of directories) {
        for (const name of names) {
            const searchDirectory = windows ? directory.replace(/^(["'])(.*)\1$/, "$2") : directory;
            const candidate = path.resolve(cwd, searchDirectory, name);
            try {
                if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
                const resolved = fs.realpathSync(candidate);
                if (!fs.statSync(resolved).isFile()) continue;
                /* Metadata is sufficient for cache freshness and avoids
                   reading or executing the compiler on editor requests. */
                return { filePath: resolved, stamp: fileStamp(resolved) };
            } catch { /* Continue PATH search after a missing or inaccessible candidate. */ }
        }
    }
    return null;
}

function dependencyContextKey(options) {
    /* Include environment state because FreeBASIC include resolution can depend on it. */
    const environment = crypto.createHash("sha256");
    const entries = Object.entries(options.environment || {}).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0);
    for (const [name, value] of entries) environment.update(`${name}\0${value}\0`);
    return JSON.stringify([options.compilerPath, path.resolve(options.filePath), options.compilerArguments, environment.digest("hex")]);
}

function verifySources(sources, openFiles, checkCancelled) {
    const open = new Set(openFiles);
    for (const source of sources) {
        checkCancelled();
        if (source.overlay && open.has(source.uri.fsPath)) continue;
        const stamp = fileStamp(source.uri.fsPath);
        if (source.overlay) {
            if (stamp.size > MAX_ANALYSIS_BYTES) throw new Error("Compiler snapshot source exceeds 32 MiB.");
            const current = decodeCompilerSourceBuffer(fs.readFileSync(source.uri.fsPath), source.uri.fsPath).replace(/^\uFEFF/, "");
            if (current !== source.text) throw new Error("Compiler snapshot source changed after its buffer closed.");
        } else if (!sameStamp(source.stamp, stamp)) throw new Error(`Compiler snapshot source changed: ${source.uri.fsPath}`);
    }
}

class CompilerModelStore {
    constructor(onEvict = () => {}) {
        this.models = new Map();
        this.sequence = 0;
        this.weight = 0;
        this.onEvict = onEvict;
        this.dependencyHints = new Map();
        this.dependencyHintBytes = 0;
    }

    async prepare(options, request, analyze, checkCancelled) {
        checkCancelled();
        const compiler = { compilerPath: options.compilerPath, cwd: path.dirname(options.filePath),
            environment: options.environment || { ...process.env } };
        const compilerIdentity = JSON.stringify(compilerExecutableIdentity(compiler.compilerPath, compiler.cwd, compiler.environment));
        if (this.weight > MODEL_CACHE_BYTES) this.clear();
        const frozen = new Map(options.overlays);
        const stamps = new Map();
        let bytes = [...frozen.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
        const read = (file) => {
            if (frozen.has(file)) return;
            checkCancelled();
            const before = fileStamp(file);
            if (before.size > MAX_ANALYSIS_BYTES) throw new Error("Compiler source exceeds 32 MiB.");
            const text = decodeCompilerSourceBuffer(fs.readFileSync(file), file);
            if (!sameStamp(before, fileStamp(file))) throw new Error(`Compiler source changed while being captured: ${file}`);
            bytes += Buffer.byteLength(text);
            if (bytes > MAX_ANALYSIS_BYTES || frozen.size >= 5000) throw new Error("Compiler source snapshots exceeded their byte or file limit.");
            frozen.set(file, text);
            stamps.set(file, before);
        };
        // The root is required by name, but a captured editor overlay is its
        // source of truth even before the file exists on disk. Every other
        // consumed disk dependency is frozen before accepting a baseline.
        if (!frozen.has(options.filePath)) read(options.filePath);
        const contextKey = dependencyContextKey(options);
        let dependencyCacheHit = false;
        let hint = this.dependencyHints.get(contextKey);
        if (hint) {
            this.dependencyHints.delete(contextKey);
            this.dependencyHints.set(contextKey, hint);
        }
        if (Array.isArray(options.dependencyHints) && options.dependencyHints.length) {
            const paths = new Set(hint?.paths || []);
            for (const file of options.dependencyHints) {
                if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n\t]/.test(file)) {
                    throw new Error("Compiler dependency hints must be absolute, single-line paths.");
                }
                paths.add(path.resolve(file));
            }
            hint = { paths: [...paths] };
        }
        if (hint?.paths.length) {
            const originalFrozen = new Map(frozen);
            const originalStamps = new Map(stamps);
            const originalBytes = bytes;
            try {
                for (const file of hint.paths) {
                    if (frozen.has(file)) continue;
                    try { read(file); }
                    catch (error) {
                        if (error.code === "ENOENT") continue;
                        throw error;
                    }
                }
                dependencyCacheHit = true;
            } catch {
                frozen.clear();
                for (const [file, text] of originalFrozen) frozen.set(file, text);
                stamps.clear();
                for (const [file, stamp] of originalStamps) stamps.set(file, stamp);
                bytes = originalBytes;
            }
        }
        let analysis;
        let analysisPasses = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
            checkCancelled();
            const directory = fs.mkdtempSync(path.join(options.temporaryDirectory, "pass-"));
            analysisPasses++;
            analysis = await analyze({ ...options, overlays: frozen, temporaryDirectory: directory });
            checkCancelled();
            const missing = analysis.dependencies.filter((file) => !frozen.has(file));
            if (!missing.length) break;
            if (attempt === 3) throw new Error("Compiler dependencies did not stabilize.");
            for (const file of missing) read(file);
        }
        if (!analysis.dependencies.includes(request.requestedFile)) throw new Error("The selected translation unit did not include this source file.");
        if (JSON.stringify(compilerExecutableIdentity(compiler.compilerPath, compiler.cwd, compiler.environment)) !== compilerIdentity) {
            throw new Error("Compiler executable changed during analysis.");
        }
        const sources = analysis.dependencies.map((file) => ({ uri: CompilerUri.file(file), text: frozen.get(file).replace(/^\uFEFF/, ""), overlay: options.overlays.has(file), stamp: stamps.get(file) || null }));
        verifySources(sources, [...options.overlays.keys()], checkCancelled);
        const sourceBytes = sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0);
        const missingIncludes = compilerMissingIncludeState(analysis, options.overlays);
        const missingIncludeBytes = missingIncludes?.bytes || 0;
        if (sourceBytes + Buffer.byteLength(analysis.text) + missingIncludeBytes > MAX_ANALYSIS_BYTES) throw new Error("Compiler source and expanded snapshots exceeded 32 MiB.");

        // Account native serialized records conservatively for the additional
        // token/scope indexes built from them. This is a retention budget, not
        // an exact V8 heap measurement; the worker also limits its old generation.
        const weight = serialize(analysis).byteLength * 4 + sourceBytes * 4 + missingIncludeBytes * 4;
        if (weight > SINGLE_MODEL_BYTES) throw new Error("The compiler model exceeds the worker retention budget.");
        const maximum = Math.max(MODEL_CACHE_BYTES, weight);
        while (this.models.size >= MODEL_CACHE_ENTRIES || this.weight + weight > maximum) this.remove(this.models.keys().next().value);
        checkCancelled();
        const started = performance.now();
        const uri = CompilerUri.from(request.expandedUri);
        const model = new CompilerSemanticModel(uri, analysis, sources);
        checkCancelled();
        this.rememberDependencies(contextKey, analysis.dependencies);
        const id = `${threadId}:${++this.sequence}`;
        this.models.set(id, { model, sources, weight, compiler, compilerIdentity, missingIncludes });
        this.weight += weight;
        return { snapshotId: id, partial: analysis.partial, completion: analysis.completion, diagnostics: analysis.diagnostics || [], dependencies: analysis.dependencies, text: analysis.text, missingIncludes, sources: sources.map((source) => ({ ...source, filePath: source.uri.fsPath, uri: undefined })), modelMs: performance.now() - started, modelWeight: weight, declarationCount: model.inner.entries.length, semanticExpressionCount: (analysis.semanticExpressions?.length || 0) + (analysis.semanticExpressionFallback?.semanticExpressions?.length || 0), semanticSidecarOnly: Boolean(analysis.semanticSidecarOnly), semanticModelFallbackReason: analysis.semanticModelFallbackReason || "", analysisPasses, dependencyCacheHit };
    }

    rememberDependencies(key, dependencies) {
        const paths = [...new Set(dependencies.map((file) => path.normalize(file)))];
        const bytes = Buffer.byteLength(key) + paths.reduce((sum, file) => sum + Buffer.byteLength(file), 0);
        if (bytes > DEPENDENCY_HINT_CACHE_BYTES) return;
        const previous = this.dependencyHints.get(key);
        if (previous) {
            this.dependencyHintBytes -= previous.bytes;
            this.dependencyHints.delete(key);
        }
        while (this.dependencyHints.size >= DEPENDENCY_HINT_CACHE_ENTRIES || this.dependencyHintBytes + bytes > DEPENDENCY_HINT_CACHE_BYTES) {
            const oldestKey = this.dependencyHints.keys().next().value;
            const oldest = this.dependencyHints.get(oldestKey);
            this.dependencyHints.delete(oldestKey);
            this.dependencyHintBytes -= oldest.bytes;
        }
        this.dependencyHints.set(key, { paths, bytes });
        this.dependencyHintBytes += bytes;
    }

    get(id, openFiles, checkCancelled) {
        const snapshot = this.models.get(id);
        if (!snapshot) throw new Error("The compiler model has expired. Analyze the module again.");
        try {
            const compiler = snapshot.compiler;
            if (compiler && JSON.stringify(compilerExecutableIdentity(compiler.compilerPath, compiler.cwd, compiler.environment)) !==
                snapshot.compilerIdentity) throw new Error("Compiler snapshot executable changed.");
            verifySources(snapshot.sources, openFiles, checkCancelled);
            const missing = snapshot.missingIncludes;
            if (missing && openFiles.some((file) => /\.(bas|bi)$/i.test(file) &&
                missing.names.has(path.basename(file).toLowerCase()) && !missing.inputs.has(file))) {
                throw new Error("Compiler snapshot missing-include inputs changed.");
            }
        }
        catch (error) { checkCancelled(); this.remove(id); throw error; }
        this.models.delete(id);
        this.models.set(id, snapshot);
        return snapshot.model;
    }

    remove(id) {
        const snapshot = this.models.get(id);
        if (!snapshot) return;
        this.models.delete(id);
        this.weight -= snapshot.weight;
        this.onEvict(id);
    }

    clear() { for (const id of [...this.models.keys()]) this.remove(id); }
}

module.exports = { CompilerUri, CompilerModelStore, fileStamp, sameStamp, compilerExecutableIdentity };

/* end of lib/compiler-model-store.js */
