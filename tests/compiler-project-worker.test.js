/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/compiler-project-worker.test.js
    Purpose: Verify the native project transaction across the worker boundary.
    Responsibilities: protect immutable requests, two-phase publication, and cleanup.
    Does not contain: source instrumentation or edits to the compiler checkout.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CompilerAnalysisWorker } = require("../lib/compiler-worker");

const native = { skip: !process.env.FBC_EDITOR_EXECUTABLE };

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-project-worker-test-"));
    const header = path.join(root, "api.bi"), implementation = path.join(root, "implementation.bas"), caller = path.join(root, "caller.bas");
    const sources = new Map([
        [header, "#ifdef ALTERNATE\nType InputType As Double\n#else\nType InputType As Long\n#endif\nDeclare Function AdjustValue(ByVal value As InputType) As InputType\n"],
        [implementation, '#include "api.bi"\nFunction AdjustValue(ByVal value As InputType) As InputType\n Return value\nEnd Function\n'],
        [caller, '#include "api.bi"\nPrint AdjustValue(1)\n']
    ]);
    for (const [file, text] of sources) fs.writeFileSync(file, text);
    const worker = new CompilerAnalysisWorker();
    t.after(async () => { await worker.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const jobs = ["normal", "alternate"].flatMap((name) => [implementation, caller].map((filePath) => ({ name, filePath, compilerArguments: name === "alternate" ? ["-d", "ALTERNATE"] : [] })));
    const options = { root, jobs, compilerPath: process.env.FBC_EDITOR_EXECUTABLE, selectedKey: `${header}:5:17`, oldName: "AdjustValue", newName: "ScaleValue", overlays: new Map(), timeoutMs: 30000 };
    return { worker, options, root, header, caller, implementation, sources };
}

test("worker project validation returns only edit records and consumes its freshness ticket once", native, async (t) => {
    const { worker, options, sources } = fixture(t);
    const pending = worker.project(options);
    const directory = worker.active.directory;
    const reply = await pending;
    assert.equal(reply.units, 4);
    assert.ok(reply.compilerPasses >= 8);
    assert.ok(reply.spoolBytes > 0);
    assert.equal(reply.verification, undefined);
    assert.equal(reply.analysis, undefined);
    assert.equal(reply.edits.reduce((sum, file) => sum + file.occurrences.length, 0), 3);
    assert.equal(fs.existsSync(directory), false, "Native scratch files must be gone before returning edits");
    assert.equal((await worker.verifyProject(reply.projectId, new Map())).verified, true);
    assert.equal(worker.projects.size, 0);
    await assert.rejects(worker.verifyProject(reply.projectId, new Map()), /expired/);
    for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("worker rename validates unsaved BOM-prefixed roots and headers without saving them", native, async (t) => {
    const { worker, options, sources, caller, header } = fixture(t);
    options.overlays.set(caller, "\uFEFF" + sources.get(caller) + "' unsaved caller\n");
    options.overlays.set(header, "\uFEFF" + sources.get(header) + "' unsaved header\n");
    const reply = await worker.project(options);
    const headerEdit = reply.edits.find((file) => file.filePath === header);
    assert.equal(headerEdit.occurrences[0].startColumn, 17);
    assert.equal((await worker.verifyProject(reply.projectId, options.overlays)).verified, true);
    for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("disk changes after native validation cannot pass the publication check", native, async (t) => {
    const { worker, options, implementation } = fixture(t);
    const reply = await worker.project(options);
    fs.appendFileSync(implementation, "' concurrent change\n");
    await assert.rejects(worker.verifyProject(reply.projectId, new Map()), /source changed/);
    assert.equal(worker.projects.size, 0);
    const fresh = await worker.project(options);
    assert.equal((await worker.verifyProject(fresh.projectId, new Map())).verified, true);
});

test("identical source content cannot hide a redirected edit target", { skip: !process.env.FBC_EDITOR_EXECUTABLE || process.platform === "win32" }, async (t) => {
    const { worker, options, implementation, sources } = fixture(t);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "fb-project-external-test-"));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    const other = path.join(external, "implementation.bas");
    fs.writeFileSync(other, sources.get(implementation));
    const reply = await worker.project(options);
    // Both paths below belong to this fixture. The external copy deliberately
    // has identical text, so a content-only publication check would miss this.
    fs.unlinkSync(implementation);
    fs.symlinkSync(other, implementation);
    await assert.rejects(worker.verifyProject(reply.projectId, new Map()), /edit target changed/);
    assert.equal(fs.readFileSync(other, "utf8"), sources.get(implementation));
    assert.equal(worker.projects.size, 0);
});

test("discarded dirty buffers and newly opened dirty buffers invalidate rename publication", native, async (t) => {
    const { worker, options, caller, sources } = fixture(t);
    options.overlays.set(caller, sources.get(caller) + "' unsaved change\n");
    const closed = await worker.project(options);
    await assert.rejects(worker.verifyProject(closed.projectId, new Map()), /buffers changed/);
    options.overlays.clear();
    const opened = await worker.project(options);
    await assert.rejects(worker.verifyProject(opened.projectId, new Map([[caller, sources.get(caller) + "' new dirty buffer\n"]])), /opened with changed content/);
    assert.equal(worker.projects.size, 0);
});

test("queued project requests freeze jobs and overlays before the caller can mutate them", native, async (t) => {
    const { worker, options, caller, sources } = fixture(t);
    const first = worker.project(options);
    const jobs = structuredClone(options.jobs);
    const overlays = new Map([[caller, sources.get(caller)]]);
    const second = worker.project({ ...options, jobs, overlays, newName: "SecondValue" });
    jobs[0].filePath = path.join(options.root, "missing.bas");
    jobs[1].compilerArguments.push("-d", "ALTERNATE");
    overlays.set(caller, "This is not valid FreeBASIC\n");
    const prior = await first;
    const reply = await second;
    assert.ok(reply.edits.every((file) => file.newText === "SecondValue"));
    assert.equal(worker.projects.has(prior.projectId), false);
    assert.equal((await worker.verifyProject(reply.projectId, new Map())).verified, true);
});

test("cancelled project work reclaims its spool before subsequent analysis starts", native, async (t) => {
    const { worker, options, caller } = fixture(t);
    const controller = new AbortController();
    worker.warning = (message) => { if (message.startsWith("Refactoring validation:")) controller.abort(); };
    const pending = worker.project({ ...options, signal: controller.signal });
    const directory = worker.active.directory;
    await assert.rejects(pending, /cancelled/);
    await worker.analyze({ compilerPath: options.compilerPath, filePath: caller });
    assert.equal(fs.existsSync(directory), false);
    assert.equal(worker.projects.size, 0);
    assert.equal(worker.active, null);
});

test("workspace trust is checked again before project validation compiler passes", native, async (t) => {
    const { worker, options } = fixture(t);
    let trusted = true;
    worker.canExecute = () => trusted;
    worker.warning = (message) => { if (message.startsWith("Refactoring validation:")) trusted = false; };
    const pending = worker.project(options);
    const directory = worker.active.directory;
    await assert.rejects(pending, /untrusted/);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(worker.projects.size, 0);
});

test("discarding an abandoned rename releases its verification state", native, async (t) => {
    const { worker, options } = fixture(t);
    const reply = await worker.project(options);
    worker.discardProject(reply.projectId);
    assert.equal(worker.projects.size, 0);
    await assert.rejects(worker.verifyProject(reply.projectId, new Map()), /expired/);
    const next = await worker.project(options);
    assert.equal((await worker.verifyProject(next.projectId, new Map())).verified, true);
});

test("invalid project requests are rejected before a worker starts", async (t) => {
    const { worker, options } = fixture(t);
    options.compilerPath = process.execPath;
    await assert.rejects(worker.project({ ...options, jobs: [] }), /1 to 128/);
    await assert.rejects(worker.project({ ...options, jobs: Array(129).fill(options.jobs[0]) }), /1 to 128/);
    await assert.rejects(worker.project({ ...options, jobs: [{ ...options.jobs[0], compilerArguments: ["-x", "output"] }] }), /does not accept/);
    await assert.rejects(worker.project({ ...options, timeoutMs: 0 }), /timeout/);
    assert.equal(worker.worker, null);
});

/* end of tests/compiler-project-worker.test.js */
