/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/fixtures/compiler-worker.js
    Purpose: Exercise the real worker transport with deterministic failure modes.
    Responsibilities: simulate slow decoding, child lifetime, and bounded replies.
    Does not contain: production compiler behavior or writes to source fixtures.
*/

const fs = require("fs");
const path = require("path");
const { parentPort } = require("worker_threads");
const { runAnalysisWorker } = require("../../lib/compiler-worker-runtime");

runAnalysisWorker(parentPort, async (options, decode, execute) => {
    const mode = options.compilerArguments[1] || "normal";
    fs.writeFileSync(path.join(options.temporaryDirectory, "running"), "owned test output");
    if (mode === "wait") {
        await new Promise((resolve, reject) => {
            const done = () => { options.signal.removeEventListener("abort", abort); resolve(); };
            const timer = setTimeout(done, 500);
            const abort = () => { clearTimeout(timer); reject(new Error("Fixture cancelled.")); };
            options.signal.addEventListener("abort", abort, { once: true });
        });
    }
    if (mode === "busy") {
        // Deliberately omit checkpoints to test forced worker shutdown.
        const until = Date.now() + 10000;
        while (Date.now() < until) {}
    }
    if (mode === "crash-child" || mode === "live-child") {
        const running = execute({ command: process.execPath, arguments: ["-e", "setInterval(() => {}, 1000)"], cwd: options.temporaryDirectory, signal: options.signal, timeoutMs: 10000, maxOutputBytes: 1024 });
        if (mode === "crash-child") setTimeout(() => { throw new Error("Deliberate compiler worker crash."); }, 500);
        await running;
    }
    if (mode === "bad-reply") parentPort.postMessage(null);
    const text = options.overlays.get(options.filePath) || "Dim workerValue As Long\n";
    const trace = `''@fb-editor-v1 1 0 ${Buffer.from(options.filePath).toString("hex")}\n${text}`;
    return {
        ...decode(trace, path.dirname(options.filePath)),
        mode,
        source: text,
        environmentValue: options.environment.FB_VSCODE_WORKER_TEST,
        semanticExport: Boolean(options.exportSemanticExpressions),
        semanticBindingsExport: Boolean(options.exportSemanticBindings),
        semanticModelRequired: Boolean(options.requireSemanticModel),
        semanticSidecarFallback: options.allowSemanticSidecarFallback,
        dependencies: [options.filePath]
    };
});

/* end of tests/fixtures/compiler-worker.js */
