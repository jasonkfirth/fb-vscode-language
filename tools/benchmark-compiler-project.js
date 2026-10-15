/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/benchmark-compiler-project.js
    Purpose: Measure project validation isolation against real compiler source.
    Responsibilities: compare identical direct and worker rename transactions.
    Does not contain: applied edits, synthetic compiler answers, or latency gates.
*/

const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { performance } = require("perf_hooks");
const { CompilerAnalysisWorker } = require("../lib/compiler-worker");
const { analyzeSavedModule } = require("../lib/compiler-analysis");
const { runProjectTransaction, verifyProjectSources } = require("../lib/compiler-project-transaction");
const { resolveCompilerSourcePath, resolveFreeBasicRoot } = require("./audit-freebasic-coverage");

async function measure(operation) {
    const started = performance.now();
    let previous = started, largestPauseMs = 0, ticks = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        largestPauseMs = Math.max(largestPauseMs, now - previous);
        previous = now;
        ticks++;
    }, 5);
    try {
        const value = await operation();
        const elapsedMs = performance.now() - started;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { value, elapsedMs, largestPauseMs, ticks };
    } finally { clearInterval(timer); }
}

async function benchmarkProject(root, compilerPath) {
    const filePath = resolveCompilerSourcePath(path.join(root, "src", "compiler"), "ast-node-call.bas");
    const source = fs.readFileSync(filePath, "utf8");
    const name = "hCopyStringsBack";
    const offset = source.indexOf(`private sub ${name}`) + "private sub ".length;
    assert.ok(offset >= "private sub ".length, "The compiler benchmark declaration changed");
    const line = source.slice(0, offset).split("\n").length - 1;
    const column = offset - source.lastIndexOf("\n", offset - 1) - 1;
    const jobs = ["normal", "alternate"].map((name) => ({ name, filePath, compilerArguments: [
        "-i", path.join(root, "src/compiler"), "-i", path.join(root, "inc"),
        ...(name === "alternate" ? ["-d", "EDITOR_BENCHMARK_BUILD"] : [])
    ] }));
    const options = { compilerPath, root, jobs, selectedKey: `${filePath}:${line}:${column}`, oldName: name, newName: "hEditorBenchmarkCopyStringsBack", overlays: new Map(), timeoutMs: 30000 };
    const worker = new CompilerAnalysisWorker();
    const runs = [];
    let expected;
    try {
        for (const mode of ["direct", "worker"]) {
            const result = await measure(async () => {
                if (mode === "worker") {
                    const reply = await worker.project(options);
                    await worker.verifyProject(reply.projectId, new Map());
                    return reply;
                }
                const reply = await runProjectTransaction(options, analyzeSavedModule, () => {});
                verifyProjectSources(reply.verification, new Map(), () => {});
                return reply;
            });
            if (expected) assert.deepEqual(result.value.edits, expected, "Worker isolation changed the rename preview");
            else expected = result.value.edits;
            const edits = result.value.edits.reduce((sum, file) => sum + file.occurrences.length, 0);
            assert.equal(edits, 2, "The benchmark must validate both declaration and call-site edits");
            runs.push({ mode, elapsedMs: result.elapsedMs, largestHostPauseMs: result.largestPauseMs, hostTimerTicks: result.ticks, units: result.value.units, compilerPasses: result.value.compilerPasses, spoolBytes: result.value.spoolBytes, edits, worker: result.value.workerStats || null });
        }
        assert.equal(fs.readFileSync(filePath, "utf8"), source);
        return { node: process.version, platform: process.platform, file: path.relative(root, filePath), runs };
    } finally { await worker.dispose(); }
}

if (require.main === module) {
    const compilerPath = process.env.FBC_EDITOR_EXECUTABLE;
    if (!compilerPath) throw new Error("Set FBC_EDITOR_EXECUTABLE to the native compiler bridge.");
    benchmarkProject(resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || ""), compilerPath).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { benchmarkProject };

/* end of tools/benchmark-compiler-project.js */
