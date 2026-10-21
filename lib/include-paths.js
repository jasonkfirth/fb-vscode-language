/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/include-paths.js

    Purpose:

        Share local include lookup between navigation and workspace indexing.

    Responsibilities:

        - resolve paths relative to the source and workspace
        - honor explicit include paths, compiler -i arguments, and -prefix SDKs
        - retain selected build options and the root module's working directory
        - discover standard include layouts beside explicit or PATH compilers

    This file intentionally does NOT contain:

        - compiler process execution
        - workspace mutation
        - source parsing
*/

const fs = require("fs");
const path = require("path");
const { analysisContext } = require("./compiler-contexts");
const { compilerExecutableIdentity } = require("./compiler-model-store");

function getIncludeDirectories(vscode, uri, system = false, environment = process.env) {
    const configuration = vscode.workspace.getConfiguration("freebasic", uri);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder?.(uri);
    const workspacePath = workspaceFolder?.uri.fsPath || path.dirname(uri.fsPath);
    const sourceDirectory = path.dirname(uri.fsPath);
    const expandPath = (value, base = workspacePath) => path.resolve(base, value.replace(/\$\{workspaceFolder\}/g, workspacePath));
    let context = null;
    if (configuration.get("analysis.activeContext", null) !== null) {
        try { context = analysisContext(configuration, workspacePath, uri.fsPath); }
        catch {
            /* Compiler analysis reports invalid selections. Keep common source
               lookup available without guessing a different named build. */
        }
    }
    const workingDirectory = context ? path.dirname(context.filePath) : sourceDirectory;
    const directories = system ? [] : [sourceDirectory];
    /* fbIncludeFile checks the current source directory, then the compiler's
       working directory, before walking -i paths in command-line order. A
       selected header must use its root's cwd, not the header's directory. */
    if (context && !system) directories.push(workingDirectory);
    const compilerArguments = context?.compilerArguments || configuration.get("compiler.arguments", []);
    let compilerPrefix = null;
    if (Array.isArray(compilerArguments)) {
        for (let index = 0; index < compilerArguments.length - 1; index++) {
            const option = compilerArguments[index];
            if ((option === "-i" || option === "-prefix") && typeof compilerArguments[index + 1] === "string" &&
                !compilerArguments[index + 1].includes("\0")) {
                const value = compilerArguments[++index];
                if (option === "-i") directories.push(path.resolve(workingDirectory, value));
                else compilerPrefix = value ? path.resolve(workingDirectory, value) : null;
            }
        }
    }
    /* The shared context resolver already appends these after command-line
       include options. Only source-only lookup needs to append them here. */
    if (!context) {
        const includePaths = configuration.get("includePaths", []);
        for (const value of Array.isArray(includePaths) ? includePaths : []) {
            if (typeof value === "string" && value.trim() && !value.includes("\0")) directories.push(expandPath(value));
        }
    }
    if (compilerPrefix) {
        /* FBC's last -prefix replaces its executable-derived prefix. Keep
           explicit -i paths first and do not mix in another installed SDK. */
        directories.push(path.join(compilerPrefix, "inc"));
        directories.push(path.join(compilerPrefix, "include/freebasic"));
    } else {
        const compiler = configuration.get("compiler.path", "fbc");
        const resolvedCompiler = compilerExecutableIdentity(compiler, workingDirectory, environment)?.filePath;
        const explicitCompiler = typeof compiler === "string" && (path.isAbsolute(compiler) || compiler.includes(path.sep));
        const compilerFile = resolvedCompiler || (explicitCompiler ? path.resolve(workingDirectory, compiler) : null);
        if (compilerFile) {
            /* Resolve PATH and symlinks without executing FBC. These are standard
               layout candidates, not a substitute for compiler-confirmed include
               outcomes or explicit includePaths on custom installations. */
            const compilerDirectory = path.dirname(compilerFile);
            directories.push(path.resolve(compilerDirectory, "../inc"));
            directories.push(path.resolve(compilerDirectory, "../include/freebasic"));
            directories.push(path.resolve(compilerDirectory, "inc"));
            directories.push(path.resolve(compilerDirectory, "include/freebasic"));
        }
    }
    if (!context && !compilerPrefix) directories.push(workspacePath);
    return [...new Set(directories)];
}

function resolveIncludePath(vscode, documentPath, include, environment = process.env) {
    const uri = vscode.Uri.file(documentPath);
    for (const directory of getIncludeDirectories(vscode, uri, include.system, environment)) {
        const candidate = path.resolve(directory, include.path);
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            /* Include files may disappear between indexing and navigation. */
        }
    }
    return null;
}

module.exports = { getIncludeDirectories, resolveIncludePath };

/* end of lib/include-paths.js */
