/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-path.test.js
    Purpose: Verify compiler selection without requiring each host OS or SDK.
    Responsibilities: check Windows discovery, fallbacks, and explicit choices.
    Does not contain: compiler execution or writes to installed toolchains.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCompilerPath } = require("../lib/compiler-path");

function installation(files = [], directories = []) {
    return { statSync(file) {
        if (files.includes(file)) return { isFile: () => true };
        if (directories.includes(file)) return { isFile: () => false };
        throw new Error("Unavailable compiler fixture");
    } };
}

test("Windows discovers each standalone compiler without a PATH entry", () => {
    for (const compiler of ["C:\\freebasic\\fbc64.exe", "C:\\freebasic\\fbc32.exe", "C:\\freebasic\\fbc.exe"]) {
        assert.equal(resolveCompilerPath("fbc", "win32", installation([compiler])), compiler);
        assert.equal(resolveCompilerPath("FBC.EXE", "win32", installation([compiler])), compiler);
    }
});

test("Windows prefers fbc64 and ignores missing or non-file compiler candidates", () => {
    const compilers = ["C:\\freebasic\\fbc64.exe", "C:\\freebasic\\fbc32.exe", "C:\\freebasic\\fbc.exe"];
    assert.equal(resolveCompilerPath("fbc", "win32", installation(compilers)), compilers[0]);
    assert.equal(resolveCompilerPath("fbc", "win32", installation(compilers.slice(1), [compilers[0]])), compilers[1]);
    assert.equal(resolveCompilerPath("fbc", "win32", installation(compilers.slice(2))), compilers[2]);
    assert.equal(resolveCompilerPath("fbc", "win32", installation()), "fbc");
});

test("explicit compiler choices and Unix PATH lookup do not probe Windows installations", () => {
    let probes = 0;
    const fileSystem = { statSync() { probes++; throw new Error("Unexpected Windows installation lookup"); } };
    for (const platform of ["linux", "darwin", "win32"]) {
        for (const compiler of ["C:\\Custom SDK\\fbc64.exe", "C:/Custom SDK/fbc.exe", "./tools/fbc", "fbc32", "fbc-editor", "", null, "fbc\0.exe"]) {
            assert.equal(resolveCompilerPath(compiler, platform, fileSystem), compiler);
        }
    }
    for (const platform of ["linux", "darwin"]) {
        assert.equal(resolveCompilerPath("fbc", platform, fileSystem), "fbc");
    }
    assert.equal(probes, 0);
});

/* end of tests/compiler-path.test.js */
