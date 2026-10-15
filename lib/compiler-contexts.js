/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-contexts.js
    Purpose: Resolve explicit translation units and build options for the editor.
    Responsibilities: share bounded context validation with project refactoring.
    Does not contain: compiler execution, include guessing, or editor state.
*/

const path = require("path");
const { analysisArguments } = require("./compiler-analysis");

function compilerArguments(configuration, root, additional = []) {
    const base = configuration.get("compiler.arguments", []);
    if (!Array.isArray(base) || !Array.isArray(additional)) throw new Error("Compiler analysis arguments must be arrays.");
    const arguments_ = analysisArguments([...base, ...additional]);
    const directories = configuration.get("includePaths", []);
    if (!Array.isArray(directories) || directories.some((directory) => typeof directory !== "string" || directory.includes("\0"))) throw new Error("Compiler include paths must be strings without NUL characters.");
    for (const directory of directories) arguments_.push("-i", path.resolve(root, directory.replace(/\$\{workspaceFolder\}/g, root)));
    return arguments_;
}

function modulePath(module, root) {
    if (typeof module !== "string" || !/\.bas$/i.test(module) || /[\0\r\n\t*?\[\]]/.test(module)) throw new Error("Project modules must be explicit .bas paths, not globs.");
    return path.resolve(root, module.replace(/\$\{workspaceFolder\}/g, root));
}

function projectContexts(configuration, root) {
    const contexts = configuration.get("analysis.projectContexts", []);
    if (!Array.isArray(contexts) || !contexts.length) throw new Error("Compiler rename is disabled until analysis.projectContexts explicitly lists all affected modules and build configurations.");
    const jobs = [];
    const names = new Set();
    for (const context of contexts) {
        if (!context || typeof context.name !== "string" || !context.name.trim() || /[\0\r\n]/.test(context.name) || !Array.isArray(context.modules) || !context.modules.length) throw new Error("Each compiler project context needs a name and a nonempty modules array.");
        if (names.has(context.name)) throw new Error("Compiler project context names must be unique.");
        names.add(context.name);
        const arguments_ = compilerArguments(configuration, root, context.arguments);
        for (const module of context.modules) {
            jobs.push({ name: context.name, filePath: modulePath(module, root), compilerArguments: arguments_ });
            if (jobs.length > 128) throw new Error("Compiler refactoring is limited to 128 module/configuration pairs.");
        }
    }
    return jobs;
}

function analysisContext(configuration, root, filePath) {
    const selected = configuration.get("analysis.activeContext", null);
    if (selected === null) {
        if (!/\.bas$/i.test(filePath)) throw new Error("Select a translation unit for this header with FreeBASIC: Select Compiler Context, or configure analysis.activeContext.");
        return { name: null, filePath, compilerArguments: compilerArguments(configuration, root) };
    }
    if (!selected || typeof selected !== "object" || Array.isArray(selected) || typeof selected.name !== "string") throw new Error("analysis.activeContext must contain a context name and a .bas module path.");
    const jobs = projectContexts(configuration, root);
    const selectedPath = modulePath(selected.module, root);
    if (!jobs.some((job) => job.name === selected.name && job.filePath === selectedPath)) throw new Error("The selected compiler context is not listed in analysis.projectContexts.");
    /* Headers use the explicitly selected translation unit. Modules retain
       their own source root, but use the same named build configuration. A
       context never borrows defines from whichever module ran most recently. */
    const target = /\.bas$/i.test(filePath) ? filePath : selectedPath;
    const job = jobs.find((job) => job.name === selected.name && job.filePath === target);
    if (!job) throw new Error("This module is not part of the selected compiler build context.");
    return job;
}

module.exports = { projectContexts, analysisContext };

/* end of lib/compiler-contexts.js */
