/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/include-paths.js

    Purpose:

        Share local include lookup between navigation and workspace indexing.

    Responsibilities:

        - resolve paths relative to the source and workspace
        - honor explicit include paths and compiler -i arguments
        - discover the include directory next to a configured compiler

    This file intentionally does NOT contain:

        - compiler process execution
        - workspace mutation
        - source parsing
*/

const fs = require("fs");
const path = require("path");

function getIncludeDirectories(vscode, uri, system = false) {
    const configuration = vscode.workspace.getConfiguration("freebasic", uri);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder?.(uri);
    const workspacePath = workspaceFolder?.uri.fsPath || path.dirname(uri.fsPath);
    const sourceDirectory = path.dirname(uri.fsPath);
    const expandPath = (value, base = workspacePath) => path.resolve(base, value.replace(/\$\{workspaceFolder\}/g, workspacePath));
    const directories = system ? [] : [sourceDirectory];
    for (const value of configuration.get("includePaths", [])) {
        if (typeof value === "string" && value.trim()) directories.push(expandPath(value));
    }
    const compilerArguments = configuration.get("compiler.arguments", []);
    for (let index = 0; index < compilerArguments.length - 1; index++) {
        if (compilerArguments[index] === "-i" && typeof compilerArguments[index + 1] === "string") {
            directories.push(expandPath(compilerArguments[++index], sourceDirectory));
        }
    }
    const compiler = configuration.get("compiler.path", "fbc");
    if (typeof compiler === "string" && (path.isAbsolute(compiler) || compiler.includes(path.sep))) {
        const compilerDirectory = path.dirname(expandPath(compiler));
        directories.push(path.resolve(compilerDirectory, "../inc"));
        directories.push(path.resolve(compilerDirectory, "../include/freebasic"));
    }
    directories.push(workspacePath);
    return [...new Set(directories)];
}

function resolveIncludePath(vscode, documentPath, include) {
    const uri = vscode.Uri.file(documentPath);
    for (const directory of getIncludeDirectories(vscode, uri, include.system)) {
        const candidate = path.resolve(directory, include.path);
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (error) {
            /* Include files may disappear between indexing and navigation. */
        }
    }
    return null;
}

module.exports = { getIncludeDirectories, resolveIncludePath };

/* end of lib/include-paths.js */
