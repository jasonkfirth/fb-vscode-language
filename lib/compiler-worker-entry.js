/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-worker-entry.js
    Purpose: Start the extension-owned native analysis worker thread.
    Responsibilities: attach the private message port to the analysis runtime.
    Does not contain: editor APIs, configuration, or compiler implementation.
*/

const { parentPort } = require("worker_threads");
const { runAnalysisWorker } = require("./compiler-worker-runtime");

if (!parentPort) throw new Error("The compiler worker requires a parent message port.");
runAnalysisWorker(parentPort);

/* end of lib/compiler-worker-entry.js */
