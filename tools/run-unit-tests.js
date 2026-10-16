/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tools/run-unit-tests.js

    Purpose:

        Run the unit suite with native compiler support when a local FreeBASIC
        source tree and bootstrap compiler are available.

    Responsibilities:

        - discover installed and checkout-local compiler defaults
        - build the Linux editor bridge when its source tree is available
        - run the unit test files with one compiler process at a time

    This file intentionally does NOT contain:

        - test cases
        - compiler bridge instrumentation
        - extension-host integration tests
*/

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveFreeBasicRoot } = require("./audit-freebasic-coverage");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const BRIDGE_PATH = path.join(REPOSITORY_ROOT, "dist", "fbc-editor-current");
const UNIT_TEST_FILES = [
    "tests/bracket-diagnostics.test.js",
    "tests/compiler-diagnostic-sidecar.test.js",
    "tests/compiler-flow-analysis.test.js",
    "tests/parser.test.js",
    "tests/compiler-diagnostics.test.js",
    "tests/compiler-process-supervisor.test.js",
    "tests/editor-features.test.js",
    "tests/formatter.test.js",
    "tests/workspace-index.test.js",
    "tests/include-paths.test.js",
    "tests/semantic-model.test.js",
    "tests/compiler-semantic-sidecar.test.js",
    "tests/compiler-semantic-large-module.test.js",
    "tests/compiler-semantic-upstream.test.js",
    "tests/compiler-semantic-transport.test.js",
    "tests/compiler-audit-options.test.js",
    "tests/language-reference.test.js",
    "tests/compiler-analysis.test.js",
    "tests/compiler-recovery.test.js",
    "tests/compiler-analysis-service.test.js",
    "tests/compiler-compatibility.test.js",
    "tests/compiler-language-status.test.js",
    "tests/compiler-member-completion.test.js",
    "tests/compiler-project.test.js",
    "tests/compiler-macros.test.js",
    "tests/compiler-preprocessor.test.js",
    "tests/compiler-worker.test.js",
    "tests/compiler-model-worker.test.js",
    "tests/compiler-project-worker.test.js"
];

function isExecutable(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function commandWorks(command) {
    const result = spawnSync(command, ["-version"], {
        stdio: "ignore",
        timeout: 5000
    });
    return !result.error && result.status === 0;
}

function defaultCompiler(environment, root) {
    if (environment.FBC_EXECUTABLE) return environment.FBC_EXECUTABLE;
    const localCompiler = root ? path.join(root, "bin", "fbc") : "";
    if (localCompiler && isExecutable(localCompiler)) return localCompiler;
    return commandWorks("fbc") ? "fbc" : "";
}

function prepareTestEnvironment(environment = process.env) {
    const result = { ...environment };
    let root = "";

    try {
        root = resolveFreeBasicRoot(result.FREEBASIC_ROOT || "");
    } catch {
        /* Compiler-independent tests remain available without a source checkout. */
    }

    const compiler = defaultCompiler(result, root);
    if (compiler && !result.FBC_EXECUTABLE) result.FBC_EXECUTABLE = compiler;
    if (root && !result.FREEBASIC_ROOT) result.FREEBASIC_ROOT = root;

    if (result.FBC_EDITOR_EXECUTABLE) return result;
    if (process.platform === "linux" && root && compiler) {
        const build = spawnSync(process.execPath, [path.join(__dirname, "build-compiler-bridge.js")], {
            cwd: REPOSITORY_ROOT,
            env: { ...result, FBC_EXECUTABLE: compiler, FREEBASIC_ROOT: root },
            stdio: "inherit",
            timeout: 300000
        });
        if (build.error) throw build.error;
        if (build.status !== 0 || !isExecutable(BRIDGE_PATH)) {
            throw new Error(`The native FreeBASIC test bridge could not be built (${build.status}).`);
        }
        result.FBC_EDITOR_EXECUTABLE = BRIDGE_PATH;
        return result;
    }

    if (isExecutable(BRIDGE_PATH)) result.FBC_EDITOR_EXECUTABLE = BRIDGE_PATH;
    else if (commandWorks("fbc-editor")) result.FBC_EDITOR_EXECUTABLE = "fbc-editor";
    return result;
}

function main() {
    const environment = prepareTestEnvironment();
    const result = spawnSync(process.execPath, [
        "--test",
        "--test-concurrency=1",
        ...process.argv.slice(2),
        ...UNIT_TEST_FILES
    ], {
        cwd: REPOSITORY_ROOT,
        env: environment,
        stdio: "inherit"
    });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    }
}

module.exports = { UNIT_TEST_FILES, prepareTestEnvironment };

/* end of tools/run-unit-tests.js */
