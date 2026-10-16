/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/compiler-compatibility.test.js

    Purpose:

        Verify compiler-version parsing and the bounded compatibility cache.

    Responsibilities:

        - distinguish schema-27 and older FreeBASIC releases
        - ensure concurrent requests share one version probe
        - keep probe limits explicit and failures non-fatal

    This file intentionally does NOT contain:

        - FreeBASIC compiler execution
        - VS Code editor integration
        - semantic analysis fixtures
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    COMPILER_VERSION_OUTPUT_LIMIT,
    COMPILER_VERSION_TIMEOUT_MS,
    CompilerCompatibilityService,
    MINIMUM_SEMANTIC_COMPILER_VERSION_TEXT,
    compilerCompatibilityFromVersionOutput,
    parseFreeBasicVersion
} = require("../lib/compiler-compatibility");

test("FreeBASIC version parsing marks older releases for limited mode", () => {
    assert.deepEqual(parseFreeBasicVersion("FreeBASIC Compiler - Version 1.10.1 (2026-10-15), built for linux"), {
        major: 1, minor: 10, patch: 1, build: null
    });
    assert.equal(compilerCompatibilityFromVersionOutput("FreeBASIC Compiler - Version 1.10.1").state, "unsupported");
    assert.equal(compilerCompatibilityFromVersionOutput("FreeBASIC Compiler - Version 1.20.0").state, "unsupported");
    assert.equal(compilerCompatibilityFromVersionOutput("FreeBASIC Compiler - Version 1.20.4-3").state, "supported");
    assert.equal(compilerCompatibilityFromVersionOutput("FreeBASIC Compiler - Version 1.20.5-1").state, "supported");
    assert.equal(MINIMUM_SEMANTIC_COMPILER_VERSION_TEXT, "1.20.4");
});

test("compiler compatibility probes are bounded, cached, and shared by concurrent callers", async () => {
    let calls = 0, changes = 0;
    const service = new CompilerCompatibilityService(async (options) => {
        calls++;
        assert.deepEqual(options.arguments, ["-version"]);
        assert.equal(options.timeoutMs, COMPILER_VERSION_TIMEOUT_MS);
        assert.equal(options.maxOutputBytes, COMPILER_VERSION_OUTPUT_LIMIT);
        await new Promise((resolve) => setImmediate(resolve));
        return { exitCode: 0, stdout: "FreeBASIC Compiler - Version 1.20.0\n", stderr: "" };
    }, () => changes++);

    assert.equal(service.get("/tool/fbc", "/project").state, "checking");
    const [first, second] = await Promise.all([
        service.ensure("/tool/fbc", "/project"),
        service.ensure("/tool/fbc", "/project")
    ]);
    assert.equal(first.state, "unsupported");
    assert.equal(second.version, "1.20.0");
    assert.equal(service.get("/tool/fbc", "/project").state, "unsupported");
    assert.equal(calls, 1);
    assert.equal(changes, 1);
});

test("unavailable or unrecognized compilers remain a non-fatal unknown state", async () => {
    const service = new CompilerCompatibilityService(async () => {
        throw new Error("compiler is missing");
    });
    const missing = await service.ensure("/missing/fbc", "/project");
    assert.equal(missing.state, "unknown");

    const unrecognized = compilerCompatibilityFromVersionOutput("not a FreeBASIC version");
    assert.equal(unrecognized.state, "unknown");
});

/* end of compiler-compatibility.test.js */
