/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/compiler-service.js

    Purpose:

        Coordinate optional compiler-backed diagnostics with VS Code documents.

    Responsibilities:

        - enforce trust, file, and configuration boundaries before execution
        - map fbc output onto the correct source documents
        - replace stale diagnostic runs safely
        - report manual syntax-check results through one output channel

    This file intentionally does NOT contain:

        - compiler process implementation
        - parsing or workspace symbol indexing
        - build, link, or run commands
*/

const fs = require("fs");
const path = require("path");

/* ------------------------------------------------------------------------- */
/* Compiler diagnostic lifecycle                                             */
/* ------------------------------------------------------------------------- */

class FreeBasicCompilerService {
    constructor(vscode, runCompiler, diagnosticCollection, outputChannel) {
        this.vscode = vscode;
        this.runCompiler = runCompiler;
        this.diagnosticCollection = diagnosticCollection;
        this.outputChannel = outputChannel;
        this.diagnosticsByRoot = new Map();
        this.runGeneration = new Map();
        this.reportedMissingCompiler = false;
    }

    async checkDocument(document, options = {}) {
        const validationMessage = this.getValidationMessage(document);
        if (validationMessage) {
            if (options.showResult) {
                this.vscode.window.showWarningMessage(validationMessage);
            }
            return { diagnostics: [], skipped: true };
        }

        const uriKey = document.uri.toString();
        const generation = (this.runGeneration.get(uriKey) || 0) + 1;
        this.runGeneration.set(uriKey, generation);

        const configuration = this.vscode.workspace.getConfiguration("freebasic", document.uri);
        const compilerPath = configuration.get("compiler.path", "fbc");
        const compilerArguments = configuration.get("compiler.arguments", []);
        const maxErrors = clampInteger(configuration.get("diagnostics.maxErrors", 50), 1, 1000);
        const timeoutMs = clampInteger(configuration.get("diagnostics.timeoutMs", 30000), 1000, 300000);

        this.outputChannel.appendLine(`Checking ${document.uri.fsPath}`);

        try {
            const result = await this.runCompiler({
                compilerArguments,
                compilerPath,
                cwd: path.dirname(document.uri.fsPath),
                filePath: document.uri.fsPath,
                maxErrors,
                timeoutMs
            });

            if (this.runGeneration.get(uriKey) !== generation) {
                return { ...result, stale: true };
            }

            if (result.output) {
                this.outputChannel.appendLine(result.output.trimEnd());
            }
            if (result.outputTruncated) {
                this.outputChannel.appendLine("Compiler output was truncated at the configured safety limit.");
            }
            if (result.timedOut) {
                this.outputChannel.appendLine(`Compiler check timed out after ${timeoutMs} ms.`);
            }

            const diagnosticCount = await this.publishDiagnostics(document, result, generation);
            if (diagnosticCount === null) {
                return { ...result, stale: true };
            }
            if (options.showResult) {
                this.showResultMessage(result, diagnosticCount);
            }
            return { ...result, diagnosticCount };
        } catch (error) {
            if (this.runGeneration.get(uriKey) !== generation) {
                return { diagnostics: [], error, skipped: false, stale: true };
            }

            this.clearRootDiagnostics(uriKey);
            this.outputChannel.appendLine(`Compiler check failed: ${error.message}`);

            if (options.showResult || !this.reportedMissingCompiler) {
                this.reportedMissingCompiler = true;
                this.vscode.window.showErrorMessage(
                    `FreeBASIC compiler check failed: ${error.message}. Configure freebasic.compiler.path if fbc is not on PATH.`
                );
            }
            return { diagnostics: [], error, skipped: false };
        }
    }

    shouldCheckOnSave(document) {
        if (document.languageId !== "freebasic") {
            return false;
        }

        const configuration = this.vscode.workspace.getConfiguration("freebasic", document.uri);
        return configuration.get("diagnostics.run", "onSave") === "onSave";
    }

    clearDocument(uri) {
        const uriKey = uri.toString();
        this.runGeneration.set(uriKey, (this.runGeneration.get(uriKey) || 0) + 1);
        this.clearRootDiagnostics(uriKey);
        this.clearDiagnosticUri(uriKey);
    }

    clearAll() {
        this.diagnosticsByRoot.clear();
        this.runGeneration.clear();
        this.diagnosticCollection.clear();
    }

    getValidationMessage(document) {
        if (!this.vscode.workspace.isTrusted) {
            return "Compiler diagnostics are disabled in untrusted workspaces.";
        }
        if (document.languageId !== "freebasic") {
            return "The active document is not a FreeBASIC source file.";
        }
        if (document.uri.scheme !== "file") {
            return "Compiler diagnostics require a local file.";
        }
        if (path.extname(document.uri.fsPath).toLowerCase() !== ".bas") {
            return "Compile-only diagnostics run on .bas modules. Included .bi diagnostics are reported through their module.";
        }
        if (document.isDirty) {
            return "Save the FreeBASIC file before running compiler diagnostics.";
        }
        return "";
    }

    async publishDiagnostics(rootDocument, result, generation) {
        const rootUriKey = rootDocument.uri.toString();
        const diagnosticsByUri = new Map();
        const sourceDirectory = path.dirname(rootDocument.uri.fsPath);

        for (const compilerDiagnostic of result.diagnostics) {
            const resolvedPath = resolveDiagnosticPath(sourceDirectory, compilerDiagnostic.filePath);
            if (!resolvedPath || !fs.existsSync(resolvedPath)) {
                continue;
            }

            const uri = this.vscode.Uri.file(resolvedPath);
            const uriKey = uri.toString();
            const document = uriKey === rootUriKey
                ? rootDocument
                : await openDocumentIfAvailable(this.vscode, uri);
            const range = compilerDiagnosticRange(this.vscode, document, compilerDiagnostic);
            const severity = compilerDiagnostic.severity === "warning"
                ? this.vscode.DiagnosticSeverity.Warning
                : this.vscode.DiagnosticSeverity.Error;
            const diagnostic = new this.vscode.Diagnostic(
                range,
                compilerDiagnostic.message,
                severity
            );
            diagnostic.code = compilerDiagnostic.code;
            diagnostic.source = "fbc";

            const entry = diagnosticsByUri.get(uriKey) || { diagnostics: [], uri };
            entry.diagnostics.push(diagnostic);
            diagnosticsByUri.set(uriKey, entry);
        }

        if (result.exitCode !== 0 && diagnosticsByUri.size === 0) {
            const message = result.timedOut
                ? "The FreeBASIC compiler check timed out."
                : `The FreeBASIC compiler exited with code ${result.exitCode} without a source diagnostic.`;
            const diagnostic = new this.vscode.Diagnostic(
                new this.vscode.Range(0, 0, 0, Math.min(1, rootDocument.lineAt(0).text.length)),
                message,
                this.vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = "fbc";
            diagnosticsByUri.set(rootUriKey, {
                diagnostics: [diagnostic],
                uri: rootDocument.uri
            });
        }

        let diagnosticCount = 0;
        for (const entry of diagnosticsByUri.values()) {
            diagnosticCount += entry.diagnostics.length;
        }

        if (this.runGeneration.get(rootUriKey) !== generation) {
            return null;
        }

        const previousDiagnostics = this.diagnosticsByRoot.get(rootUriKey) || new Map();
        const affectedUris = new Set([
            ...previousDiagnostics.keys(),
            ...diagnosticsByUri.keys()
        ]);
        this.diagnosticsByRoot.set(rootUriKey, diagnosticsByUri);

        for (const uriKey of affectedUris) {
            this.refreshDiagnosticUri(uriKey);
        }
        return diagnosticCount;
    }

    clearRootDiagnostics(rootUriKey) {
        const rootDiagnostics = this.diagnosticsByRoot.get(rootUriKey);
        if (!rootDiagnostics) {
            return;
        }

        this.diagnosticsByRoot.delete(rootUriKey);
        for (const uriKey of rootDiagnostics.keys()) {
            this.refreshDiagnosticUri(uriKey);
        }
    }

    clearDiagnosticUri(uriKey) {
        let changed = false;
        for (const rootDiagnostics of this.diagnosticsByRoot.values()) {
            changed = rootDiagnostics.delete(uriKey) || changed;
        }

        if (changed) {
            this.refreshDiagnosticUri(uriKey);
        }
    }

    refreshDiagnosticUri(uriKey) {
        const diagnostics = [];
        let uri = this.vscode.Uri.parse(uriKey);

        for (const rootDiagnostics of this.diagnosticsByRoot.values()) {
            const entry = rootDiagnostics.get(uriKey);
            if (entry) {
                uri = entry.uri;
                diagnostics.push(...entry.diagnostics);
            }
        }

        if (diagnostics.length > 0) {
            this.diagnosticCollection.set(uri, diagnostics);
        } else {
            this.diagnosticCollection.delete(uri);
        }
    }

    showResultMessage(result, diagnosticCount) {
        if (result.timedOut) {
            this.vscode.window.showErrorMessage("FreeBASIC compiler check timed out. See the FreeBASIC output channel.");
        } else if (result.exitCode === 0 && diagnosticCount === 0) {
            this.vscode.window.showInformationMessage("FreeBASIC compiler check passed.");
        } else {
            this.vscode.window.showWarningMessage(
                `FreeBASIC compiler check reported ${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}.`
            );
        }
    }
}

/* ------------------------------------------------------------------------- */
/* Diagnostic mapping helpers                                                */
/* ------------------------------------------------------------------------- */

function resolveDiagnosticPath(sourceDirectory, diagnosticPath) {
    if (!diagnosticPath || path.extname(diagnosticPath).toLowerCase() === ".o") {
        return "";
    }

    return path.normalize(
        path.isAbsolute(diagnosticPath)
            ? diagnosticPath
            : path.resolve(sourceDirectory, diagnosticPath)
    );
}

function compilerDiagnosticRange(vscode, document, diagnostic) {
    if (!document || document.lineCount === 0) {
        return new vscode.Range(diagnostic.line, 0, diagnostic.line, 1);
    }

    const line = Math.min(Math.max(0, diagnostic.line), document.lineCount - 1);
    const lineText = document.lineAt(line).text;
    const tokenMatch = diagnostic.message.match(/(?:before|found)\s+'([^']+)'/i);
    let startColumn = 0;
    let endColumn = Math.max(1, lineText.length);

    if (tokenMatch) {
        const tokenIndex = lineText.toLowerCase().indexOf(tokenMatch[1].toLowerCase());
        if (tokenIndex >= 0) {
            startColumn = tokenIndex;
            endColumn = tokenIndex + tokenMatch[1].length;
        }
    } else {
        const firstCodeColumn = lineText.search(/\S/);
        if (firstCodeColumn >= 0) {
            startColumn = firstCodeColumn;
        }
    }

    return new vscode.Range(line, startColumn, line, endColumn);
}

async function openDocumentIfAvailable(vscode, uri) {
    try {
        return await vscode.workspace.openTextDocument(uri);
    } catch (error) {
        return null;
    }
}

function clampInteger(value, minimum, maximum) {
    const integerValue = Number.isInteger(value) ? value : minimum;
    return Math.min(maximum, Math.max(minimum, integerValue));
}

module.exports = {
    FreeBasicCompilerService,
    clampInteger,
    compilerDiagnosticRange,
    resolveDiagnosticPath
};

/* end of lib/compiler-service.js */
