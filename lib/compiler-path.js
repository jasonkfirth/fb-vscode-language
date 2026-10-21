/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-path.js
    Purpose: Select the default compiler for the extension host's platform.
    Responsibilities: discover Windows installations and preserve explicit choices.
    Does not contain: compiler execution, version probes, or include lookup.
*/

const fs = require("fs");

/* Standalone Windows installations need not add their directory to PATH.
   Prefer the 64-bit compiler, then the 32-bit and unqualified executables.
   An explicit path or another command name always keeps its own meaning. */
const WINDOWS_COMPILER_PATHS = Object.freeze([
    "C:\\freebasic\\fbc64.exe",
    "C:\\freebasic\\fbc32.exe",
    "C:\\freebasic\\fbc.exe"
]);

function resolveCompilerPath(compilerPath, platform = process.platform, fileSystem = fs) {
    if (platform !== "win32" || typeof compilerPath !== "string" || !/^fbc(?:\.exe)?$/i.test(compilerPath)) return compilerPath;
    for (const candidate of WINDOWS_COMPILER_PATHS) {
        try {
            if (fileSystem.statSync(candidate).isFile()) return candidate;
        } catch {
            /* Missing or inaccessible installations leave the next choice available. */
        }
    }
    return compilerPath;
}

module.exports = { resolveCompilerPath };

/* end of lib/compiler-path.js */
