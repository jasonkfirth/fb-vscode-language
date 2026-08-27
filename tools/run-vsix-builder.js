/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: run-vsix-builder.js

    Purpose:

        Select the native VSIX packaging script for the current operating
        system when npm run package:vsix is used.

    Responsibilities:

        - select the PowerShell builder on Windows
        - select the Bash builder on Linux and macOS
        - forward output and process status to npm

    This file intentionally does NOT contain:

        - VSIX manifest generation
        - extension file lists
        - archive validation
*/

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* ------------------------------------------------------------------------- */
/* Builder selection                                                         */
/* ------------------------------------------------------------------------- */

function selectBuilder(platform, repositoryRoot) {
    if (platform === "win32") {
        return {
            command: "powershell",
            arguments: [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                path.join(repositoryRoot, "tools", "build-vsix.ps1")
            ]
        };
    }

    if (platform === "linux" || platform === "darwin") {
        return {
            command: "bash",
            arguments: [path.join(repositoryRoot, "tools", "build-vsix.sh")]
        };
    }

    throw new Error(`VSIX packaging is not configured for platform: ${platform}`);
}

/* ------------------------------------------------------------------------- */
/* Command entry point                                                       */
/* ------------------------------------------------------------------------- */

function main() {
    const repositoryRoot = path.resolve(__dirname, "..");
    const builder = selectBuilder(process.platform, repositoryRoot);
    const builderPath = builder.arguments[builder.arguments.length - 1];

    if (!fs.existsSync(builderPath)) {
        throw new Error(`VSIX builder is missing: ${builderPath}`);
    }

    const result = spawnSync(builder.command, builder.arguments, {
        cwd: repositoryRoot,
        stdio: "inherit",
        shell: false
    });

    if (result.error) {
        throw result.error;
    }

    if (result.signal) {
        throw new Error(`VSIX builder was terminated by signal: ${result.signal}`);
    }

    process.exitCode = result.status === null ? 1 : result.status;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    selectBuilder
};

/* end of run-vsix-builder.js */
