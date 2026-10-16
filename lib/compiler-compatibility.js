/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-compatibility.js

    Purpose:

        Identify compilers that can provide the semantic model used by the
        extension and retain that result for the selected executable.

    Responsibilities:

        - parse FreeBASIC compiler version output
        - compare versions with the schema-27 minimum
        - run one bounded version probe for each compiler executable identity

    This file intentionally does NOT contain:

        - compiler analysis or syntax diagnostics
        - editor status presentation
        - FreeBASIC compiler process implementation
*/

const { compilerExecutableIdentity } = require("./compiler-model-store");

const MINIMUM_SEMANTIC_COMPILER_VERSION = Object.freeze({ major: 1, minor: 20, patch: 4 });
const MINIMUM_SEMANTIC_COMPILER_VERSION_TEXT = "1.20.4";
const COMPILER_VERSION_TIMEOUT_MS = 5000;
const COMPILER_VERSION_OUTPUT_LIMIT = 64 * 1024;
const MAX_COMPILER_COMPATIBILITY_ENTRIES = 32;

function parseFreeBasicVersion(output) {
    const match = String(output || "").match(/\bversion\s+(\d+)\.(\d+)\.(\d+)(?:-(\d+))?\b/i);
    if (!match) return null;

    const version = {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        build: match[4] === undefined ? null : Number(match[4])
    };
    if (!Object.values(version).every((value) => value === null || Number.isSafeInteger(value) && value >= 0)) return null;
    return version;
}

function compareFreeBasicVersions(first, second) {
    for (const field of ["major", "minor", "patch"]) {
        if (first[field] !== second[field]) return first[field] < second[field] ? -1 : 1;
    }
    return 0;
}

function compilerCompatibilityFromVersionOutput(output) {
    const version = parseFreeBasicVersion(output);
    if (!version) return {
        state: "unknown",
        version: "",
        message: "The configured compiler did not report a recognizable FreeBASIC version."
    };

    const versionText = `${version.major}.${version.minor}.${version.patch}${version.build === null ? "" : `-${version.build}`}`;
    if (compareFreeBasicVersions(version, MINIMUM_SEMANTIC_COMPILER_VERSION) < 0) {
        return {
            state: "unsupported",
            version: versionText,
            message: `FreeBASIC ${versionText} does not provide the schema-27 semantic model required for compiler-backed analysis. Syntax highlighting, source-based editor features, and ordinary compiler checks remain available. Use FBC ${MINIMUM_SEMANTIC_COMPILER_VERSION_TEXT} or newer for compiler-backed analysis.`
        };
    }

    return { state: "supported", version: versionText, message: "" };
}

class CompilerCompatibilityService {
    constructor(execute, onDidChange = () => {}) {
        if (typeof execute !== "function") throw new TypeError("A bounded compiler execution function is required.");
        this.execute = execute;
        this.onDidChange = onDidChange;
        this.entries = new Map();
    }

    get(compilerPath, cwd) {
        return this.entryFor(compilerPath, cwd).result;
    }

    ensure(compilerPath, cwd) {
        return this.entryFor(compilerPath, cwd).pending;
    }

    entryFor(compilerPath, cwd) {
        if (typeof compilerPath !== "string" || !compilerPath || typeof cwd !== "string" || !cwd) {
            return { result: compilerCompatibilityFromVersionOutput(""), pending: Promise.resolve(compilerCompatibilityFromVersionOutput("")) };
        }

        const identity = compilerExecutableIdentity(compilerPath, cwd);
        const key = JSON.stringify([compilerPath, identity || { cwd }]);
        const existing = this.entries.get(key);
        if (existing) return existing;

        const entry = { result: { state: "checking", version: "", message: "Checking the configured FreeBASIC compiler version." }, pending: null };
        this.entries.set(key, entry);
        while (this.entries.size > MAX_COMPILER_COMPATIBILITY_ENTRIES) {
            this.entries.delete(this.entries.keys().next().value);
        }
        entry.pending = this.probe(compilerPath, cwd).then((result) => {
            entry.result = result;
            try { this.onDidChange(); } catch { /* A disposed editor status must not turn a probe into a rejection. */ }
            return result;
        });
        return entry;
    }

    async probe(compilerPath, cwd) {
        try {
            const result = await this.execute({
                command: compilerPath,
                arguments: ["-version"],
                cwd,
                timeoutMs: COMPILER_VERSION_TIMEOUT_MS,
                maxOutputBytes: COMPILER_VERSION_OUTPUT_LIMIT
            });
            if (result.cancelled || result.timedOut || result.outputTruncated || result.signal || result.exitCode !== 0) {
                return {
                    state: "unknown",
                    version: "",
                    message: "The configured compiler version could not be checked within the safety limits."
                };
            }
            return compilerCompatibilityFromVersionOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
        } catch {
            return {
                state: "unknown",
                version: "",
                message: "The configured compiler version could not be checked."
            };
        }
    }
}

module.exports = {
    COMPILER_VERSION_OUTPUT_LIMIT,
    COMPILER_VERSION_TIMEOUT_MS,
    CompilerCompatibilityService,
    MAX_COMPILER_COMPATIBILITY_ENTRIES,
    MINIMUM_SEMANTIC_COMPILER_VERSION,
    MINIMUM_SEMANTIC_COMPILER_VERSION_TEXT,
    compareFreeBasicVersions,
    compilerCompatibilityFromVersionOutput,
    parseFreeBasicVersion
};

/* end of compiler-compatibility.js */
