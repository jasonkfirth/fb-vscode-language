/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tools/test-extension.js

    Purpose:

        Run language-provider tests inside an isolated VS Code extension host.

    Responsibilities:

        - use the official extension test launcher
        - isolate editor settings and installed extensions
        - propagate test failures and clean owned temporary files

    This file intentionally does NOT contain:

        - provider assertions
        - normal editor profile changes
        - marketplace installation
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTests } = require("@vscode/test-electron");

async function main() {
    const root = path.resolve(__dirname, "..");
    const suppliedTemporaryDirectory = process.env.VSCODE_TEST_TEMP_DIRECTORY;
    const temporaryDirectory = suppliedTemporaryDirectory || fs.mkdtempSync(path.join(os.tmpdir(), "fb-extension-test-"));
    if (suppliedTemporaryDirectory) fs.mkdirSync(temporaryDirectory, { recursive: true });
    try {
        /* Agent and CLI launchers can inherit Electron's Node-only mode. */
        delete process.env.ELECTRON_RUN_AS_NODE;
        const workspacePath = process.env.FREEBASIC_TEST_WORKSPACE ||
            path.join(root, "tests/integration/workspace");
        const launchArgs = [
            workspacePath,
            "--user-data-dir", path.join(temporaryDirectory, "user-data"),
            "--extensions-dir", path.join(temporaryDirectory, "extensions"),
            "--skip-welcome", "--skip-release-notes",
            "--disable-workspace-trust", "--disable-gpu", "--no-sandbox"
        ];
        if (process.env.FREEBASIC_ENABLE_INSTALLED_EXTENSIONS !== "1") launchArgs.push("--disable-extensions");
        await runTests({
            extensionDevelopmentPath: process.env.FREEBASIC_TEST_HARNESS_PATH || process.env.FREEBASIC_EXTENSION_PATH || root,
            extensionTestsPath: path.join(root, "tests/integration/index.js"),
            vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
            version: process.env.VSCODE_VERSION || "stable",
            launchArgs
        });
    } finally {
        if (!suppliedTemporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

/* end of tools/test-extension.js */
