/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tools/test-packaged-extension.js

    Purpose:

        Run the VS Code extension-host checks against an installed VSIX.

    Responsibilities:

        - validate archive paths and required native provider modules
        - install one owned VSIX into an isolated editor profile
        - run the existing editor-host suite against that installed extension

    This file intentionally does NOT contain:

        - VSIX construction
        - editor-host assertions
        - compiler bridge construction
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } = require("@vscode/test-electron");

const ROOT = path.resolve(__dirname, "..");
const REQUIRED_PROVIDER_FILES = [
    "extension.js",
    "lib/compiler-process-supervisor.js",
    "lib/compiler-process-runner.js",
    "lib/compiler-document-symbols.js",
    "lib/compiler-workspace-symbols.js",
    "lib/compiler-workspace-service.js",
    "lib/bounded-text-map.js",
    "lib/compiler-worker-runtime.js"
];

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: "utf8", ...options });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`${command} was terminated by ${result.signal}`);
    if (result.status !== 0) {
        const details = `${result.stdout || ""}${result.stderr || ""}`.trim();
        throw new Error(`${command} exited with status ${result.status}${details ? `: ${details}` : ""}`);
    }
    return result.stdout || "";
}

function validateArchiveEntries(entries) {
    for (const entry of entries) {
        if (!entry || entry.startsWith("/") || entry.includes("\\") || path.posix.isAbsolute(entry)) {
            throw new Error(`VSIX contains an unsafe archive path: ${JSON.stringify(entry)}`);
        }
        const segments = entry.split("/");
        if (segments.some((segment) => segment === ".." || segment === ".")) {
            throw new Error(`VSIX contains a traversing archive path: ${JSON.stringify(entry)}`);
        }
    }
}

async function main() {
    if (process.platform !== "linux") throw new Error("The packaged extension-host verifier currently requires Linux and unzip.");
    const packageData = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const archivePath = path.join(ROOT, "dist", `${packageData.name}-${packageData.version}.vsix`);
    const compilerPath = process.env.FBC_EDITOR_EXECUTABLE;
    if (!fs.existsSync(archivePath)) throw new Error(`Build the VSIX before testing it: ${archivePath}`);
    if (!compilerPath || !fs.existsSync(compilerPath) || !fs.statSync(compilerPath).isFile()) {
        throw new Error("Set FBC_EDITOR_EXECUTABLE to the native compiler bridge so Outline and workspace-symbol tests cannot be skipped.");
    }
    try {
        fs.accessSync(compilerPath, fs.constants.X_OK);
    } catch {
        throw new Error("FBC_EDITOR_EXECUTABLE must be an executable native compiler bridge.");
    }

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-vsix-integration-"));
    let completed = false;
    try {
        const entries = run("unzip", ["-Z1", archivePath], { cwd: ROOT }).split(/\r?\n/).filter(Boolean);
        validateArchiveEntries(entries);
        const executablePath = process.env.VSCODE_EXECUTABLE || await downloadAndUnzipVSCode({ version: process.env.VSCODE_VERSION || "stable" });
        const extensionsDirectory = path.join(temporaryDirectory, "extensions");
        const userDataDirectory = path.join(temporaryDirectory, "user-data");
        fs.mkdirSync(extensionsDirectory, { recursive: true });
        fs.mkdirSync(userDataDirectory, { recursive: true });
        const cliPath = resolveCliPathFromVSCodeExecutablePath(executablePath);
        run(cliPath, ["--install-extension", archivePath, "--extensions-dir", extensionsDirectory, "--user-data-dir", userDataDirectory, "--force"], { cwd: ROOT, stdio: "inherit" });

        const installed = fs.readdirSync(extensionsDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(extensionsDirectory, entry.name))
            .filter((extensionPath) => {
                const metadataPath = path.join(extensionPath, "package.json");
                if (!fs.existsSync(metadataPath)) return false;
                const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
                return metadata.name === packageData.name && metadata.version === packageData.version &&
                    metadata.publisher === packageData.publisher;
            });
        if (installed.length !== 1) throw new Error(`Expected one installed ${packageData.publisher}.${packageData.name}@${packageData.version}, found ${installed.length}.`);

        const extensionPath = installed[0];
        const packagedMetadata = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
        const mainPath = path.resolve(extensionPath, packagedMetadata.main || "./extension.js");
        if (!mainPath.startsWith(`${extensionPath}${path.sep}`) || !fs.existsSync(mainPath)) {
            throw new Error("The installed extension entry point is missing or outside its extension directory.");
        }
        for (const relativePath of REQUIRED_PROVIDER_FILES) {
            if (!fs.existsSync(path.join(extensionPath, relativePath))) {
                throw new Error(`The installed VSIX is missing native provider file: ${relativePath}`);
            }
        }

        console.log(`Testing installed ${packageData.name}@${packageData.version} from ${extensionPath}.`);
        run(process.execPath, [path.join(ROOT, "tools", "test-extension.js")], {
            cwd: ROOT,
            env: {
                ...process.env,
                VSCODE_EXECUTABLE: executablePath,
                VSCODE_TEST_TEMP_DIRECTORY: temporaryDirectory,
                FREEBASIC_TEST_HARNESS_PATH: path.join(ROOT, "tests/integration/harness"),
                FREEBASIC_ENABLE_INSTALLED_EXTENSIONS: "1",
                FREEBASIC_EXPECTED_EXTENSION_PATH: extensionPath
            },
            stdio: "inherit"
        });
        completed = true;
    } finally {
        if (!completed && process.env.FREEBASIC_PRESERVE_TEST_PROFILE === "1") {
            console.error(`Preserved failed VS Code test profile: ${temporaryDirectory}`);
        } else {
            fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        }
    }
}

try {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}

/* end of test-packaged-extension.js */
