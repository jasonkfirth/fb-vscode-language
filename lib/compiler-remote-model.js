/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-remote-model.js
    Purpose: Present a worker-owned native snapshot to editor providers.
    Responsibilities: marshal small queries and reject stale asynchronous replies.
    Does not contain: semantic graphs, source parsing, or native type inference.
*/

function uriRecord(uri) { return { scheme: uri.scheme, fsPath: uri.fsPath, path: uri.path, value: uri.toString() }; }

class CompilerRemoteModel {
    constructor(service, snapshotId, partial, semanticSidecarOnly = false, semanticBindingsAvailable = false,
        semanticMacroBindingsAvailable = false) {
        this.service = service;
        this.snapshotId = snapshotId;
        this.partial = partial;
        this.semanticSidecarOnly = Boolean(semanticSidecarOnly);
        this.semanticBindingsAvailable = Boolean(semanticBindingsAvailable);
        this.semanticMacroBindingsAvailable = Boolean(semanticMacroBindingsAvailable);
        this.remote = true;
    }

    available() { return this.service.analysisWorker.models.has(this.snapshotId); }

    async query(operation, uri, input = {}, token = null, contextUri = uri) {
        // An explicit module context permits queries on its captured headers.
        // It selects only the snapshot: the worker still validates that the
        // requested source belongs to that model before resolving anything.
        if (token?.isCancellationRequested || this.service.getModel(contextUri) !== this) return null;
        const generation = this.service.generation;
        const controller = new AbortController();
        const subscription = token?.onCancellationRequested?.(() => controller.abort());
        try {
            const openFiles = this.service.vscode.workspace.textDocuments.filter((document) => document.uri.scheme === "file").map((document) => document.uri.fsPath);
            // Position exposes its coordinates through prototype getters in
            // VS Code. Structured clone does not preserve those accessors.
            const point = (value) => value ? { line: value.line, character: value.character } : undefined;
            const reply = await this.service.analysisWorker.query(this.snapshotId, operation, { ...input, position: point(input.position), end: point(input.end), uri: uriRecord(uri), openFiles }, controller.signal);
            if (controller.signal.aborted || token?.isCancellationRequested || generation !== this.service.generation || this.service.getModel(contextUri) !== this) return null;
            const result = reply.result;
            const revive = (entry) => {
                const record = entry?.uri;
                if (!record) return entry;
                entry.uri = record.scheme === "file" ? this.service.vscode.Uri.file(record.fsPath) : this.service.vscode.Uri.parse(record.value);
                return entry;
            };
            if (Array.isArray(result)) result.forEach((entry) => { if (entry?.uri) revive(entry); });
            else if (Array.isArray(result?.entries)) result.entries.forEach(revive);
            return result;
        } catch (error) {
            if (!controller.signal.aborted && generation === this.service.generation) {
                this.service.output.appendLine(`Compiler model query: ${error.message}`);
                // A full queue or a rejected query does not change source or
                // invalidate other contexts. Stale/failed worker models lose
                // their identity and are removed through the expiry callback.
                if (!this.available()) this.service.expireModel(this.snapshotId);
            }
            return null;
        } finally { subscription?.dispose(); }
    }

    expressionAt(uri, start, end = start, token = null) { return this.query("expression", uri, { position: start, end }, token); }
}

module.exports = { CompilerRemoteModel };

/* end of lib/compiler-remote-model.js */
