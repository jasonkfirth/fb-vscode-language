/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/compiler-semantic-upstream.test.js
    Purpose: Compare upstream compiler types with native and sidecar-only editor queries.
    Responsibilities: Retain full-model compilation and every upstream expression assertion.
    Does not contain: schema fixtures, source edits, or VS Code API objects.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { decodeCompilerSemanticModel } = require("../lib/compiler-semantic-sidecar");
const { analyzeSavedModule } = require("../lib/compiler-analysis");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");
const { resolveFreeBasicRoot } = require("../tools/audit-freebasic-coverage");

/* The unit runner isolates test files in separate processes. Keep this corpus
   run out of the schema suite so its earlier model allocations cannot carry
   into a resource-sensitive compiler check. The offline timeout allows competing
   CPU-heavy work; it does not change editor deadlines or semantic assertions. */
const UPSTREAM_COMPILER_TIMEOUT_MS = 2 * 60 * 1000;

test("sidecar and editor types agree across the upstream expression corpus", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const compiler = process.env.FBC_EDITOR_EXECUTABLE;
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const fixtureDirectory = path.join(root, "tests/expressions");
    const includeArguments = ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")];
    const names = fs.readdirSync(fixtureDirectory).filter((name) => name.endsWith(".bas"));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semantic-upstream-expressions-"));
    let complete = 0;
    let compared = 0;
    let compactCompared = 0;
    let directiveOnly = 0;

    try {
        for (const name of names) {
            const sourcePath = path.join(fixtureDirectory, name);
            const sidecarPath = path.join(directory, `${name}.tsv`);
            const objectPath = path.join(directory, `${name}.o`);
            try {
                execFileSync(compiler, [
                    ...includeArguments, "-semantic-model", sidecarPath,
                    "-c", sourcePath, "-o", objectPath
                ], { cwd: fixtureDirectory, stdio: "ignore", timeout: UPSTREAM_COMPILER_TIMEOUT_MS });
            } catch (error) {
                /* Failed upstream cases test recovery, not committed sidecar records. */
                if (error.status !== 1) {
                    error.message = `${name}: ${error.message}`;
                    throw error;
                }
                continue;
            }

            complete++;
            const semantic = decodeCompilerSemanticModel(fs.readFileSync(sidecarPath));
            const source = fs.readFileSync(sourcePath, "utf8");
            const lines = source.split("\n");
            const analysis = await analyzeSavedModule({
                compilerPath: compiler,
                filePath: sourcePath,
                compilerArguments: includeArguments,
                exportSemanticExpressions: true,
                requireSemanticModel: true,
                timeoutMs: UPSTREAM_COMPILER_TIMEOUT_MS
            });
            assert.equal(analysis.partial, false, `${name} must have a complete editor snapshot`);
            const sources = analysis.dependencies.map((filePath) => ({
                uri: { fsPath: filePath, toString: () => `file://${filePath}` },
                text: fs.readFileSync(filePath, "utf8")
            }));
            const sourceUri = sources.find((item) => item.uri.fsPath === sourcePath)?.uri;
            assert.ok(sourceUri, `${name} must remain a compiler dependency`);
            const editorModel = new CompilerSemanticModel(
                { toString: () => `freebasic-preprocessed:/${name}` },
                analysis,
                sources
            );
            const sidecarOnlyModel = new CompilerSemanticModel(
                { toString: () => `freebasic-preprocessed:/${name}` },
                { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
                sources
            );

            for (const expression of semantic.expressions) {
                if (!expression.physical || expression.filePath !== sourcePath) continue;
                const start = { line: expression.startLine - 1, character: expression.startColumn };
                const end = { line: expression.endLine - 1, character: expression.endColumn };
                const typed = editorModel.expressionAt(sourceUri, start, end);
                if (!typed) {
                    const line = lines[start.line] || "";
                    assert.match(line, /^\s*#\s*(?:if|elseif|assert)\b/i,
                        `${name}:${expression.startLine}:${expression.startColumn} must map outside compile-time directives`);
                    directiveOnly++;
                    continue;
                }
                assert.equal(typed.dtype, expression.dtype, `${name}:${expression.startLine}:${expression.startColumn} compiler type`);
                compared++;

                const compact = sidecarOnlyModel.expressionAt(sourceUri, start, end);
                if (!compact) {
                    assert.ok(sidecarOnlyModel.isCompilerSidecarRangeAmbiguous(sourceUri, start, end),
                        `${name}:${expression.startLine}:${expression.startColumn} must come from the compact semantic sidecar`);
                    continue;
                }
                assert.equal(compact.semanticSource, "compiler-sidecar",
                    `${name}:${expression.startLine}:${expression.startColumn} must not fall back to trace expressions`);
                assert.equal(compact.provisional, false,
                    `${name}:${expression.startLine}:${expression.startColumn} is from a complete compiler pass`);
                assert.equal(compact.dtype, expression.dtype,
                    `${name}:${expression.startLine}:${expression.startColumn} compact compiler type`);
                compactCompared++;
            }
        }

        assert.ok(complete >= 20, `Expected complete upstream cases, found ${complete} of ${names.length}.`);
        assert.ok(compared >= 1700, `Expected broad source-expression agreement, compared ${compared} ranges.`);
        assert.ok(compactCompared >= 1700,
            `Expected broad expressions-only sidecar coverage without trace expression nodes, queried ${compactCompared} ranges.`);
        assert.equal(directiveOnly, 0, "Compiler semantic directives should now be represented by editor expression queries.");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/* end of tests/compiler-semantic-upstream.test.js */

