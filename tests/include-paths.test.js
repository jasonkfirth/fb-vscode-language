/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/include-paths.test.js
    Purpose: Keep source include lookup aligned with selected compiler builds.
    Responsibilities: verify search order, root-relative paths, and cache refresh.
    Does not contain: compiler execution, editor startup, or non-fixture writes.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getIncludeDirectories, resolveIncludePath } = require("../lib/include-paths");
const { FreeBasicWorkspaceIndex } = require("../lib/workspace-index");

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-context-include-test-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const uri = (file) => ({ scheme: "file", fsPath: file, toString: () => `file://${file}` });
    const write = (name, text = "") => {
        const file = path.join(directory, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        return uri(file);
    };
    const main = write("app/main.bas", '#include "../shared/api.bi"\n');
    const header = write("shared/api.bi", '#include "selected-api.bi"\n');
    const first = write("app/context-a/selected-api.bi", "Dim firstBuild As Long\n");
    const second = write("app/context-b/selected-api.bi", "Dim secondBuild As Double\n");
    const settings = {
        "compiler.path": "fb-vscode-unavailable-test-compiler",
        "compiler.arguments": ["-i", "base"], includePaths: ["${workspaceFolder}/common"],
        "analysis.activeContext": { name: "first", module: "app/main.bas" },
        "analysis.projectContexts": [
            { name: "first", modules: ["app/main.bas"], arguments: ["-i", "context-a"] },
            { name: "second", modules: ["app/main.bas"], arguments: ["-i", "context-b"] }
        ]
    };
    const vscode = { Uri: { file: uri }, workspace: {
        textDocuments: [],
        getConfiguration: () => ({ get: (name, fallback) => settings[name] ?? fallback }),
        getWorkspaceFolder: () => ({ uri: uri(directory) }),
        fs: { readFile: async (file) => fs.promises.readFile(file.fsPath) },
        findFiles: async () => [main]
    } };
    return { directory, uri, write, main, header, first, second, settings, vscode };
}

test("selected include lookup preserves compiler option order for modules and headers", (t) => {
    const f = fixture(t);
    const expected = ["app", "app/base", "app/context-a", "common"].map((name) => path.join(f.directory, name));
    assert.deepEqual(getIncludeDirectories(f.vscode, f.main), expected);
    assert.deepEqual(getIncludeDirectories(f.vscode, f.header), [path.join(f.directory, "shared"), ...expected]);
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "selected-api.bi" }), f.first.fsPath);
});

test("selected headers follow FBC's source, working-directory, then -i precedence", (t) => {
    const f = fixture(t);
    const local = f.write("shared/local-first.bi");
    f.write("app/local-first.bi");
    const root = f.write("app/root-first.bi");
    f.write("app/base/root-first.bi");
    const argument = f.write("app/base/argument-first.bi");
    f.write("app/context-a/argument-first.bi");
    f.write("common/argument-first.bi");
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "local-first.bi" }), local.fsPath);
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "root-first.bi" }), root.fsPath);
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "argument-first.bi" }), argument.fsPath);
    f.write("workspace-only.bi");
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "workspace-only.bi" }), null,
        "the workspace root is not an implicit include path for a selected nested module");
});

test("context switches and invalid selections never borrow another named build's includes", (t) => {
    const f = fixture(t);
    f.settings["analysis.activeContext"] = { name: "second", module: "app/main.bas" };
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "selected-api.bi" }), f.second.fsPath);
    f.settings["analysis.activeContext"] = { name: "missing", module: "app/main.bas" };
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "selected-api.bi" }), null);
    f.settings["analysis.activeContext"] = { name: "first", module: "app/main.bas" };
    assert.equal(resolveIncludePath(f.vscode, path.join(f.directory, "other.bas"), { path: "selected-api.bi" }), null);
});

test("source-only lookup keeps local paths and places -i arguments before includePaths", (t) => {
    const f = fixture(t);
    f.settings["analysis.activeContext"] = null;
    const first = f.write("app/base/common.bi");
    f.write("common/common.bi");
    assert.equal(resolveIncludePath(f.vscode, f.main.fsPath, { path: "common.bi" }), first.fsPath);
    assert.deepEqual(getIncludeDirectories(f.vscode, f.main), ["app", "app/base", "common", ""].map((name) => path.join(f.directory, name)));
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "api.bi" }), f.header.fsPath);
});

test("relative compiler paths and -i values use the selected root without shell expansion", (t) => {
    const f = fixture(t);
    f.settings["compiler.path"] = path.join("tools", "bin", "fbc");
    f.settings["analysis.projectContexts"][0].arguments.push("-i", "${workspaceFolder}/literal");
    const directories = getIncludeDirectories(f.vscode, f.header);
    assert.ok(directories.includes(path.join(f.directory, "app", "${workspaceFolder}", "literal")));
    assert.ok(directories.includes(path.join(f.directory, "common")), "includePaths expands its documented workspace placeholder");
    assert.ok(directories.includes(path.join(f.directory, "app/tools/inc")));
    assert.ok(!directories.includes(path.join(f.directory, "shared/tools/inc")));
});

test("workspace include hints rebuild from the newly selected context", async (t) => {
    const f = fixture(t);
    const index = new FreeBasicWorkspaceIndex(f.vscode, "freebasic");
    t.after(() => index.dispose());
    assert.equal(await index.ensureInitialized(), true);
    assert.deepEqual(index.includeDependencyHints(f.main.fsPath), [f.header.fsPath, f.first.fsPath]);
    f.settings["analysis.activeContext"] = { name: "second", module: "app/main.bas" };
    index.invalidateWorkspace();
    assert.equal(await index.ensureInitialized(), true);
    assert.deepEqual(index.includeDependencyHints(f.main.fsPath), [f.header.fsPath, f.second.fsPath]);
});

test("default PATH compilers expose installed and standalone header layouts without execution", (t) => {
    const f = fixture(t);
    delete f.settings["compiler.path"];
    const command = process.platform === "win32" ? "fbc.exe" : "fbc";
    for (const [binaryDirectory, includeDirectory] of [
        ["installed/bin", "installed/include/freebasic"],
        ["checkout/bin", "checkout/inc"],
        ["standalone", "standalone/inc"]
    ]) {
        const compiler = f.write(`${binaryDirectory}/${command}`, "metadata-only compiler fixture");
        fs.chmodSync(compiler.fsPath, 0o755);
        const header = f.write(`${includeDirectory}/bundled-probe.bi`);
        const environment = { PATH: path.dirname(compiler.fsPath), NoDefaultCurrentDirectoryInExePath: "1" };
        assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "bundled-probe.bi" }, environment), header.fsPath,
            `header discovery must not require an executable compiler process for ${binaryDirectory}`);
    }
});

test("PATH changes select the first available compiler's headers without stale directory caching", (t) => {
    const f = fixture(t);
    const command = process.platform === "win32" ? "include-probe.exe" : "include-probe";
    f.settings["compiler.path"] = "include-probe";
    const firstCompiler = f.write(`first/bin/${command}`), secondCompiler = f.write(`second/bin/${command}`);
    fs.chmodSync(firstCompiler.fsPath, 0o755);
    fs.chmodSync(secondCompiler.fsPath, 0o755);
    const first = f.write("first/inc/bundled-probe.bi"), second = f.write("second/inc/bundled-probe.bi");
    for (const [compilers, expected] of [[[firstCompiler, secondCompiler], first], [[secondCompiler, firstCompiler], second]]) {
        const environment = { PATH: compilers.map((file) => path.dirname(file.fsPath)).join(path.delimiter), NoDefaultCurrentDirectoryInExePath: "1" };
        assert.equal(resolveIncludePath(f.vscode, f.main.fsPath, { path: "bundled-probe.bi" }, environment), expected.fsPath);
    }
    assert.equal(resolveIncludePath(f.vscode, f.main.fsPath, { path: "bundled-probe.bi" },
        { PATH: "", NoDefaultCurrentDirectoryInExePath: "1" }), null);
});

test("relative PATH entries use a selected header's root working directory", (t) => {
    const f = fixture(t);
    const command = process.platform === "win32" ? "include-probe.exe" : "include-probe";
    f.settings["compiler.path"] = "include-probe";
    const compiler = f.write(`app/toolchain/bin/${command}`);
    fs.chmodSync(compiler.fsPath, 0o755);
    const header = f.write("app/toolchain/inc/bundled-probe.bi");
    const environment = { PATH: path.join("toolchain", "bin"), NoDefaultCurrentDirectoryInExePath: "1" };
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "bundled-probe.bi" }, environment), header.fsPath);
});

test("compiler command symlinks discover headers beside the executable target", { skip: process.platform === "win32" }, (t) => {
    const f = fixture(t);
    f.settings["compiler.path"] = "include-probe";
    const compiler = f.write("actual/bin/include-probe");
    fs.chmodSync(compiler.fsPath, 0o755);
    const header = f.write("actual/inc/bundled-probe.bi");
    const aliasDirectory = path.join(f.directory, "aliases");
    fs.mkdirSync(aliasDirectory);
    fs.symlinkSync(compiler.fsPath, path.join(aliasDirectory, "include-probe"));
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "bundled-probe.bi" }, { PATH: aliasDirectory }), header.fsPath);
});

test("explicit prefixes replace executable-derived headers but retain -i precedence", (t) => {
    const f = fixture(t);
    const compiler = f.write("toolchain/bin/compiler");
    fs.chmodSync(compiler.fsPath, 0o755);
    f.settings["compiler.path"] = compiler.fsPath;
    f.settings["compiler.arguments"].push("-prefix", "SDK with spaces");
    const prefix = f.write("app/SDK with spaces/include/freebasic/prefix-probe.bi");
    f.write("toolchain/inc/fallback-only.bi");
    const first = f.write("app/base/precedence.bi");
    f.write("app/SDK with spaces/include/freebasic/precedence.bi");
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "prefix-probe.bi" }), prefix.fsPath);
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "precedence.bi" }), first.fsPath);
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "fallback-only.bi" }), null,
        "a custom prefix must not silently borrow headers from the executable's normal SDK");
});

test("selected build prefixes override global prefixes and change with the active context", (t) => {
    const f = fixture(t);
    f.settings["compiler.arguments"].push("-prefix", "../global-sdk");
    f.settings["analysis.projectContexts"][0].arguments.push("-prefix", "../first-sdk");
    f.settings["analysis.projectContexts"][1].arguments.push("-prefix", "../second-sdk");
    const first = f.write("first-sdk/inc/prefix-probe.bi"), second = f.write("second-sdk/include/freebasic/prefix-probe.bi");
    f.write("global-sdk/inc/prefix-probe.bi");
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "prefix-probe.bi" }), first.fsPath);
    f.settings["analysis.activeContext"] = { name: "second", module: "app/main.bas" };
    assert.equal(resolveIncludePath(f.vscode, f.header.fsPath, { path: "prefix-probe.bi" }), second.fsPath);
});

test("global prefixes do not gain an unrelated workspace-root header fallback", (t) => {
    const f = fixture(t);
    f.settings["analysis.activeContext"] = null;
    f.settings["compiler.arguments"].push("-prefix", "sdk");
    const header = f.write("app/sdk/inc/prefix-probe.bi");
    f.write("workspace-only.bi");
    assert.equal(resolveIncludePath(f.vscode, f.main.fsPath, { path: "prefix-probe.bi" }), header.fsPath);
    assert.equal(resolveIncludePath(f.vscode, f.main.fsPath, { path: "workspace-only.bi" }), null);
});

/* end of include-paths.test.js */
