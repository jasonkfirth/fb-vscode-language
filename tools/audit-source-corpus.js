/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tools/audit-source-corpus.js

    Purpose:

        Check parser coordinates and semantic analysis on real compiler,
        manual-example, and public-header source files.

    Responsibilities:

        - validate declaration ranges against their original source text
        - detect parser or resolver exceptions on a broad source corpus
        - report measured work and the slowest file

    This file intentionally does NOT contain:

        - claims of compiler-equivalent semantic coverage
        - modifications to upstream files
        - brittle wall-clock pass thresholds
*/

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { parseFreeBasicText } = require("../lib/freebasic-parser");
const { FreeBasicSemanticModel } = require("../lib/semantic-model");
const { resolveFreeBasicRoot } = require("./audit-freebasic-coverage");

function collectFiles(directory, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) collectFiles(filePath, files);
        else if (entry.isFile() && /\.(?:bas|bi)$/i.test(entry.name)) files.push(filePath);
    }
    return files.sort();
}

function main() {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const files = [...collectFiles(path.join(root, "src/compiler")), ...collectFiles(path.join(root, "examples/manual"))];
    for (const file of ["inc/fbgfx.bi", "inc/fbgfx3.bi", "inc/fbcom.bi", "inc/builtin.bi", "examples/OptimizePureAbstractTypes/inc/EXCEL.bi"]) {
        const filePath = path.join(root, file);
        if (fs.existsSync(filePath)) files.push(filePath);
    }
    const failures = [];
    const started = performance.now();
    let declarationCount = 0;
    let tokenCount = 0;
    let slowest = { milliseconds: 0, file: "" };
    for (const file of files) {
        const start = performance.now();
        const source = fs.readFileSync(file, "utf8");
        const lines = source.split(/\r\n|\n|\r/);
        const parsed = parseFreeBasicText(source);
        declarationCount += parsed.declarations.length;
        for (const declaration of parsed.declarations) {
            const selected = lines[declaration.line]?.slice(declaration.startColumn, declaration.endColumn) || "";
            const expected = declaration.name.includes(" ") ? declaration.name.split(/\s+/).at(-1) : declaration.name;
            if (selected.toLowerCase() !== expected.toLowerCase()) {
                failures.push(`${path.relative(root, file)}:${declaration.line + 1}: ${JSON.stringify(selected)} != ${JSON.stringify(expected)}`);
            }
            if (declaration.endLine < declaration.line || declaration.endLine >= lines.length) failures.push(`${file}: invalid declaration range`);
        }
        const uri = { toString: () => `file://${file}` };
        const model = new FreeBasicSemanticModel([{ uri, parsed }]);
        const document = model.getDocument(uri);
        tokenCount += document.tokens.length;
        for (const token of document.tokens) if (token.kind === "identifier") model.resolveToken(document, token);
        const milliseconds = performance.now() - start;
        if (milliseconds > slowest.milliseconds) slowest = { milliseconds, file: path.relative(root, file) };
    }
    console.log(JSON.stringify({ files: files.length, declarations: declarationCount, tokens: tokenCount, milliseconds: Math.round(performance.now() - started), slowest }, null, 2));
    if (failures.length) {
        for (const failure of failures.slice(0, 50)) console.error(failure);
        throw new Error(`${failures.length} corpus range checks failed.`);
    }
}

try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }

/* end of tools/audit-source-corpus.js */
