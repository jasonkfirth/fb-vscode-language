/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/compiler-process-supervisor.test.js
    Purpose: Verify child-process supervision stays outside the editor host.
    Responsibilities: cover bounded output, cancellation, timeout, and reaping.
    Does not contain: compiler parsing, source snapshots, or VS Code APIs.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { CompilerProcessSupervisor } = require("../lib/compiler-process-supervisor");

/* Startup includes the runner process and its first IPC event. Offline tests
   allow competing CPU work without changing compiler or editor deadlines. */
const PROCESS_START_TIMEOUT_MS = 30 * 1000;

async function waitForPid(readPid) {
    const deadline = Date.now() + PROCESS_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const pid = readPid();
        if (pid) return pid;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The supervised process did not start.");
}

function assertReaped(pid) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the supervisor must reap its compiler child");
}

test("compiler commands run in one reusable supervisor process with bounded output", async (t) => {
    const supervisor = new CompilerProcessSupervisor();
    t.after(async () => supervisor.dispose());

    const first = await supervisor.execute({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write(JSON.stringify({ parent: process.ppid })); process.stderr.write('runner')"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        profileOutput: true
    });
    const runnerPid = supervisor.child.pid;
    assert.equal(first.exitCode, 0);
    assert.equal(JSON.parse(first.stdout).parent, runnerPid);
    assert.equal(first.stderr, "runner");
    assert.ok(Number.isFinite(first.outputProfile?.runnerSpawnCallMs));

    const second = await supervisor.execute({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write(String(process.ppid))"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        maxOutputBytes: 1024
    });
    assert.equal(second.stdout, String(runnerPid), "the helper should be reused without another host spawn");

    const truncated = await supervisor.execute({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        maxOutputBytes: 1024
    });
    assert.equal(truncated.outputTruncated, true);
    assert.equal(Buffer.byteLength(truncated.stdout) + Buffer.byteLength(truncated.stderr), 1024);
});

test("supervised cancellation and timeout reap compiler children before replying", async (t) => {
    const supervisor = new CompilerProcessSupervisor();
    t.after(async () => supervisor.dispose());
    const command = {
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        timeoutMs: 10000,
        maxOutputBytes: 1024
    };

    const controller = new AbortController();
    let cancelledPid = null;
    const cancellation = supervisor.execute({ ...command, signal: controller.signal, onProcess: (pid) => { if (pid) cancelledPid = pid; } });
    await waitForPid(() => cancelledPid);
    controller.abort();
    const cancelled = await cancellation;
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.timedOut, false);
    assertReaped(cancelledPid);

    let timedOutPid = null;
    const timedOut = await supervisor.execute({ ...command, timeoutMs: 25, onProcess: (pid) => { if (pid) timedOutPid = pid; } });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.cancelled, false);
    assertReaped(timedOutPid);
});

test("disposing the process supervisor cancels and reaps its active compiler", async (t) => {
    const supervisor = new CompilerProcessSupervisor();
    t.after(async () => supervisor.dispose());
    const controller = new AbortController();
    let pid = null;
    const pending = supervisor.execute({
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        timeoutMs: 10000,
        maxOutputBytes: 1024,
        signal: controller.signal,
        onProcess: (value) => { if (value) pid = value; }
    });
    await waitForPid(() => pid);

    await supervisor.dispose();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assertReaped(pid);
    assert.equal(supervisor.child, null);
});

test("a crashed supervisor kills its compiler before restarting for another request", async (t) => {
    const supervisor = new CompilerProcessSupervisor();
    t.after(async () => supervisor.dispose());
    let pid = null;
    const pending = supervisor.execute({
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        timeoutMs: 10000,
        maxOutputBytes: 1024,
        onProcess: (value) => { if (value) pid = value; }
    });
    await waitForPid(() => pid);
    supervisor.child.kill("SIGKILL");

    await assert.rejects(pending, /Compiler process runner/);
    assertReaped(pid);
    const recovered = await supervisor.execute({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('recovered')"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        maxOutputBytes: 1024
    });
    assert.equal(recovered.stdout, "recovered");
    assert.equal(recovered.exitCode, 0);
});

/* end of tests/compiler-process-supervisor.test.js */
