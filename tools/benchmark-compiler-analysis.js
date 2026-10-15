/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/benchmark-compiler-analysis.js
    Purpose: Measure native model isolation and editor-query responsiveness.
    Responsibilities: compare direct, raw worker, and prepared worker models.
    Does not contain: synthetic compiler answers, performance gates, or source edits.
*/

const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { performance } = require("perf_hooks");
const { analyzeSavedModule } = require("../lib/compiler-analysis");
const { CompilerAnalysisWorker } = require("../lib/compiler-worker");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");
const { resolveCompilerSourcePath, resolveFreeBasicRoot } = require("./audit-freebasic-coverage");

async function measure(operation) {
    const started = performance.now();
    let previous = started, largestPauseMs = 0, ticks = 0;
    // A short host-thread timer exposes decoder/clone/model stalls separately
    // from elapsed compiler time. This is an observation, not a portable SLA.
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

async function benchmarkRecoveryOverlay(root, compilerPath, worker) {
    const filePath = path.join(__dirname, "../tests/integration/workspace/compiler-types.bas");
    const diskSource = fs.readFileSync(filePath, "utf8");
    const insertion = diskSource.indexOf("Print (packets(0) + packets(0)).amount");
    assert.ok(insertion >= 0, "The compiler-types benchmark fixture changed");

    const recoveryExpressions = Array.from({ length: 2000 }, (_, index) => `Print recoveryValue * ${index + 2}`);
    const recoveryText = ["Dim recoveryValue As Double", "Print recoveryValue +", ...recoveryExpressions, ""].join("\n");
    const overlay = `${diskSource.slice(0, insertion)}${recoveryText}${diskSource.slice(insertion)}`;
    const overlays = new Map([[filePath, overlay]]);
    const options = {
        compilerPath,
        filePath,
        compilerArguments: ["-i", path.join(root, "src/compiler"), "-i", path.join(root, "inc")],
        overlays,
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 30000
    };
    const lastExpression = `recoveryValue * ${recoveryExpressions.length + 1}`;
    const queryLine = overlay.split(/\r\n|\n|\r/).findIndex((line) => line === `Print ${lastExpression}`);
    assert.ok(queryLine >= 0, "The recovery stress expression was not found in its unsaved overlay");
    const position = { line: queryLine, character: "Print ".length };
    const end = { line: queryLine, character: position.character + lastExpression.length };
    const expandedUri = { scheme: "freebasic-preprocessed", value: "freebasic-preprocessed:/benchmark-recovery.bas", path: "/benchmark-recovery.bas" };
    const expandedModelUri = { ...expandedUri, toString() { return this.value; } };
    const uri = (file) => ({ scheme: "file", fsPath: file, toString: () => `file://${file}` });

    const directAnalysis = await measure(() => analyzeSavedModule(options));
    assert.equal(directAnalysis.value.partial, true, "The unsaved recovery input must retain its parser error");
    assert.equal(directAnalysis.value.completion.reachedEnd, true, "Recovery must continue through the generated valid statements");
    const sources = directAnalysis.value.dependencies.map((file) => ({
        uri: uri(file),
        text: overlays.has(file) ? overlays.get(file) : fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
    }));
    const directModel = await measure(() => new CompilerSemanticModel(expandedModelUri, directAnalysis.value, sources));
    const directQuery = await measure(() => directModel.value.expressionAt(uri(filePath), position, end));
    assert.equal(directQuery.value?.typeName.toLowerCase(), "double", "A later unsaved expression must remain typed after recovery");
    assert.equal(fs.readFileSync(filePath, "utf8"), diskSource, "The recovery benchmark must not save its overlay");

    worker.cancelAll();
    const preparedRuns = [];
    for (const mode of ["prepared-cold", "prepared-warm"]) {
        const preparation = await measure(() => worker.analyze(options, { requestedFile: filePath, expandedUri }));
        const snapshot = preparation.value;
        assert.equal(snapshot.partial, true);
        assert.equal(snapshot.completion.reachedEnd, true);
        const query = await measure(() => worker.query(snapshot.snapshotId, "expression", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: [filePath],
            position,
            end
        }));
        assert.equal(query.value.result?.typeName.toLowerCase(), "double");
        assert.equal(query.value.result.provisional, false, "The recovered expression must have an authoritative compiler type");
        preparedRuns.push({
            mode,
            analysisMs: preparation.elapsedMs,
            analysisMainPauseMs: preparation.largestPauseMs,
            analysisTicks: preparation.ticks,
            partial: snapshot.partial,
            completion: snapshot.completion,
            declarations: snapshot.declarationCount,
            semanticExpressions: snapshot.semanticExpressionCount,
            modelWeight: snapshot.modelWeight,
            queryMs: query.elapsedMs,
            queryMainPauseMs: query.largestPauseMs,
            typeName: query.value.result.typeName,
            provisional: query.value.result.provisional,
            worker: snapshot.workerStats
        });
        worker.releaseModel(snapshot.snapshotId);
    }

    return {
        file: path.relative(root, filePath),
        overlayBytes: Buffer.byteLength(overlay),
        generatedValidExpressions: recoveryExpressions.length,
        errorCount: directAnalysis.value.completion.errorCount,
        reachedEnd: directAnalysis.value.completion.reachedEnd,
        direct: {
            analysisMs: directAnalysis.elapsedMs,
            analysisMainPauseMs: directAnalysis.largestPauseMs,
            analysisTicks: directAnalysis.ticks,
            modelMs: directModel.elapsedMs,
            modelMainPauseMs: directModel.largestPauseMs,
            queryMs: directQuery.elapsedMs,
            queryMainPauseMs: directQuery.largestPauseMs,
            typeName: directQuery.value.typeName,
            provisional: directQuery.value.provisional
        },
        prepared: preparedRuns
    };
}

async function benchmarkAnalysis(root, compilerPath) {
    const worker = new CompilerAnalysisWorker();
    const compilerRoot = path.join(root, "src", "compiler");
    const files = [
        path.join(__dirname, "../tests/integration/workspace/compiler-preprocessor.bas"),
        resolveCompilerSourcePath(compilerRoot, "ast-node-call.bas"),
        resolveCompilerSourcePath(compilerRoot, "parser-proc.bas")
    ];
    const report = [];
    const uri = (file) => ({ scheme: "file", fsPath: file, toString: () => `file://${file}` });
    try {
        for (const filePath of files) {
            const options = { compilerPath, filePath, compilerArguments: ["-i", path.join(root, "src/compiler"), "-i", path.join(root, "inc")], allowErrors: true, exportSemanticExpressions: true, timeoutMs: 30000 };
            const entry = { file: path.relative(root, filePath), runs: [] };
            for (const mode of ["direct", "worker-cold", "worker-warm"]) {
                const analysis = await measure(() => mode === "direct" ? analyzeSavedModule(options) : worker.analyze(options));
                const sources = analysis.value.dependencies.map((file) => ({ uri: uri(file), text: fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") }));
                const expanded = { scheme: "freebasic-preprocessed", toString: () => "freebasic-preprocessed:/benchmark.bas" };
                const model = await measure(() => new CompilerSemanticModel(expanded, analysis.value, sources));
                entry.runs.push({ mode, analysisMs: analysis.elapsedMs, analysisMainPauseMs: analysis.largestPauseMs, analysisTicks: analysis.ticks, modelMs: model.elapsedMs, modelMainPauseMs: model.largestPauseMs, partial: analysis.value.partial, declarations: model.value.inner.entries.length, semanticExpressions: analysis.value.semanticExpressions?.length || 0, worker: analysis.value.workerStats || null });
            }
            // Clear decoded traces before measuring preparation; the existing
            // thread remains warm, but the first prepared decode is uncached.
            worker.cancelAll();
            for (const mode of ["prepared-cold", "prepared-warm"]) {
                const prepared = await measure(() => worker.analyze(options, { requestedFile: filePath, expandedUri: { scheme: "freebasic-preprocessed", value: "freebasic-preprocessed:/benchmark.bas", path: "/benchmark.bas" } }));
                const snapshot = prepared.value;
                const tokens = await measure(() => worker.query(snapshot.snapshotId, "semanticTokens", { uri: { scheme: "file", fsPath: filePath }, openFiles: [] }));
                const repeatedTokens = await measure(() => worker.query(snapshot.snapshotId, "semanticTokens", { uri: { scheme: "file", fsPath: filePath }, openFiles: [] }));
                assert.deepEqual(repeatedTokens.value.result, tokens.value.result, "A cached semantic-token query must preserve the exact wire data.");
                entry.runs.push({ mode, analysisMs: prepared.elapsedMs, analysisMainPauseMs: prepared.largestPauseMs, analysisTicks: prepared.ticks, modelMs: snapshot.modelMs, modelWeight: snapshot.modelWeight, partial: snapshot.partial, completion: snapshot.completion, declarations: snapshot.declarationCount, semanticExpressions: snapshot.semanticExpressionCount, queryMs: tokens.elapsedMs, queryMainPauseMs: tokens.largestPauseMs, repeatedQueryMs: repeatedTokens.elapsedMs, repeatedQueryMainPauseMs: repeatedTokens.largestPauseMs, semanticTokens: tokens.value.result.length / 5, worker: snapshot.workerStats });
            }
            report.push(entry);
        }
        const recovery = await benchmarkRecoveryOverlay(root, compilerPath, worker);
        return { node: process.version, platform: process.platform, files: report, recoveryOverlay: recovery };
    } finally { await worker.dispose(); }
}

if (require.main === module) {
    const compilerPath = process.env.FBC_EDITOR_EXECUTABLE;
    if (!compilerPath) throw new Error("Set FBC_EDITOR_EXECUTABLE to the native compiler bridge.");
    benchmarkAnalysis(resolveFreeBasicRoot(), compilerPath).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { benchmarkAnalysis, benchmarkRecoveryOverlay };

/* end of tools/benchmark-compiler-analysis.js */
