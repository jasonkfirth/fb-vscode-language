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
const { analysisContext } = require("./compiler-contexts");
const { compilerExecutableIdentity, fileStamp, sameStamp } = require("./compiler-model-store");
const {
    compilerDiagnosticContextLabel,
    compilerDiagnosticGuidance,
    compilerConstantConversionOverflowRange,
    compilerConstantConversionOverflowPointRange,
    compilerDeclarationSuffixConflictRange,
    compilerErrorResumeNextRange,
    compilerForNextCounterMismatchRange,
    compilerLineInputBufferCapacityRange,
    compilerMissingClosingQuoteRange,
    compilerPossibleEscapeStringRange,
    compilerRedundantNewAnyInitializerRange,
    compilerImplicitVariableAllocationRange,
    compilerMeaninglessNextVariableRange,
    compilerIgnoredDeclarationSuffixRange,
    compilerImplicitParameterPassingModeRange,
    compilerProcedureSignatureMismatchRange,
    compilerSuspiciousPointerAssignmentRange,
    compilerFunctionPointerMismatchRange,
    compilerOperatorWarningTokenRange,
    compilerConstQualifierWarningRange,
    compilerLargeStackWarningRange,
    compilerImplicitConversionRange,
    compilerParameterDefaultMismatchRange,
    physicalDiagnosticRange,
    physicalPointMatchesDiagnosticText
} = require("./compiler-diagnostic-sidecar");

function diagnosticPathKey(filePath) {
    const normalized = path.normalize(path.resolve(filePath));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

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
        this.diagnosticContextsByRoot = new Map();
        this.diagnosticDependenciesByRoot = new Map();
        this.diagnosticRootsByDependency = new Map();
        this.diagnosticDependencyEdges = 0;
        this.diagnosticDependencyIndexIncomplete = false;
        this.runGeneration = new Map();
        this.reportedMissingCompiler = false;
        this.nextGeneration = 0;
        this.runningChecks = new Map();
        this.disposed = false;
    }

    async checkSelectedContext(document, options = {}) {
        if (this.disposed) return { diagnostics: [], skipped: true };
        const validationMessage = this.getValidationMessage(document, true);
        if (validationMessage) {
            if (options.showResult) this.vscode.window.showWarningMessage(validationMessage);
            return { diagnostics: [], skipped: true };
        }
        const workspace = this.vscode.workspace;
        try {
            const resolve = () => this.contextFor(document.uri);
            const selected = resolve();
            const diagnosticContext = { uri: document.uri, signature: selected.signature };
            if (/\.bas$/i.test(document.uri.fsPath) && selected.context.name === null) {
                return await this.checkDocument(document, { ...options, diagnosticContext });
            }
            const version = document.version;
            const rootDocument = selected.context.filePath === document.uri.fsPath ? document
                : await workspace.openTextDocument(this.vscode.Uri.file(selected.context.filePath));
            if (rootDocument.isDirty) throw new Error(`Save the selected root module '${selected.context.filePath}' before checking it without the editor bridge.`);
            const rootVersion = rootDocument.version;
            const inputs = [...new Set([document.uri.fsPath, selected.context.filePath])]
                .map((file) => ({ file, stamp: fileStamp(file) }));
            const isCurrent = () => {
                try {
                    const reopened = (workspace.textDocuments || []).some((open) =>
                        open !== document && open.uri.toString() === document.uri.toString() ||
                        open !== rootDocument && open.uri.toString() === rootDocument.uri.toString());
                    return workspace.isTrusted && !document.isDirty && document.version === version &&
                        !reopened && !rootDocument.isDirty && rootDocument.version === rootVersion &&
                        inputs.every((input) => sameStamp(input.stamp, fileStamp(input.file))) &&
                        selected.signature === resolve().signature;
                } catch { return false; }
            };
            if (!isCurrent()) return { diagnostics: [], skipped: true, stale: true };
            return await this.checkDocument(rootDocument, { ...options,
                diagnosticContext,
                configuration: selected.configuration,
                compilerArguments: selected.context.compilerArguments,
                isCurrent,
                validateResult: (result) => {
                    if (selected.context.filePath === document.uri.fsPath || result.exitCode !== 0) return;
                    /* Textual diagnostic paths can be redirected by #line.
                       Only FBC's physical input inventory proves inclusion. */
                    if (result.diagnosticSourcesComplete !== true || !Array.isArray(result.diagnosticSources)) {
                        throw new Error("FBC did not provide a complete physical source inventory. Check the root module directly or update the compiler.");
                    }
                    const requested = diagnosticPathKey(fs.realpathSync(document.uri.fsPath));
                    const consumed = result.diagnosticSources
                        .some((file) => {
                            try { return diagnosticPathKey(fs.realpathSync(path.resolve(path.dirname(selected.context.filePath), file))) === requested; }
                            catch { return false; }
                        });
                    if (!consumed) throw new Error("The selected translation unit did not confirm this header as an input. Select a module/build context that consumes it.");
                }
            });
        } catch (error) {
            this.outputChannel.appendLine(`Compiler context: ${error.message}`);
            if (options.showResult) this.vscode.window.showWarningMessage(error.message);
            return { diagnostics: [], error, skipped: true };
        }
    }

    contextFor(uri) {
        const workspace = this.vscode.workspace;
        const configuration = workspace.getConfiguration("freebasic", uri);
        const root = workspace.getWorkspaceFolder?.(uri)?.uri.fsPath || path.dirname(uri.fsPath);
        const context = analysisContext(configuration, root, uri.fsPath);
        const compilerPath = configuration.get("compiler.path", "fbc");
        return { configuration, context, signature: JSON.stringify([context, compilerPath,
            compilerExecutableIdentity(compilerPath, path.dirname(context.filePath)),
            configuration.get("diagnostics.run", "onSave"), configuration.get("diagnostics.maxErrors", 50),
            configuration.get("diagnostics.timeoutMs", 30000)]) };
    }

    isContextCurrent(context) {
        try { return this.vscode.workspace.isTrusted && this.contextFor(context.uri).signature === context.signature; }
        catch { return false; }
    }

    refreshContexts() {
        /* Keep the resource used to request a header check. Its compiler
           options can differ from those scoped to the root module itself. */
        for (const [rootKey, context] of this.diagnosticContextsByRoot) {
            if (this.isContextCurrent(context)) continue;
            this.clearRootDiagnostics(rootKey);
            this.removeDiagnosticDependencies(rootKey);
        }
    }

    async checkDocument(document, options = {}) {
        if (this.disposed) return { diagnostics: [], skipped: true };
        const validationMessage = this.getValidationMessage(document);
        if (validationMessage) {
            if (options.showResult) {
                this.vscode.window.showWarningMessage(validationMessage);
            }
            return { diagnostics: [], skipped: true };
        }

        const uriKey = document.uri.toString();
        const generation = ++this.nextGeneration;
        this.runGeneration.set(uriKey, generation);
        this.runningChecks.get(uriKey)?.abort();
        const controller = new AbortController();
        this.runningChecks.set(uriKey, controller);

        const configuration = options.configuration || this.vscode.workspace.getConfiguration("freebasic", document.uri);
        const compilerPath = configuration.get("compiler.path", "fbc");
        const compilerArguments = [...(options.compilerArguments || configuration.get("compiler.arguments", []))];
        const workspacePath = this.vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath || path.dirname(document.uri.fsPath);
        for (const includePath of options.compilerArguments ? [] : configuration.get("includePaths", [])) {
            if (typeof includePath === "string" && includePath.trim()) {
                compilerArguments.push("-i", path.resolve(workspacePath, includePath.replace(/\$\{workspaceFolder\}/g, workspacePath)));
            }
        }
        const maxErrors = clampInteger(configuration.get("diagnostics.maxErrors", 50), 1, 1000);
        const timeoutMs = clampInteger(configuration.get("diagnostics.timeoutMs", 30000), 1000, 300000);
        const isCurrent = () => (!options.isCurrent || options.isCurrent()) &&
            (!options.diagnosticContext || this.isContextCurrent(options.diagnosticContext));

        this.outputChannel.appendLine(`Checking ${document.uri.fsPath}`);

        try {
            if (!isCurrent()) return { diagnostics: [], skipped: true, stale: true };
            const result = await this.runCompiler({
                compilerArguments,
                compilerPath,
                cwd: path.dirname(document.uri.fsPath),
                filePath: document.uri.fsPath,
                maxErrors,
                timeoutMs,
                signal: controller.signal
            });

            if (this.runGeneration.get(uriKey) !== generation || result.cancelled || !isCurrent()) {
                return { ...result, stale: true };
            }
            options.validateResult?.(result);

            if (result.output) {
                this.outputChannel.appendLine(result.output.trimEnd());
            }
            if (result.outputTruncated) {
                this.outputChannel.appendLine("Compiler output was truncated at the configured safety limit.");
            }
            if (result.timedOut) {
                this.outputChannel.appendLine(`Compiler check timed out after ${timeoutMs} ms.`);
            }

            const diagnosticCount = await this.publishDiagnostics(document, result, generation, isCurrent);
            if (diagnosticCount === null) {
                return { ...result, stale: true };
            }
            if (options.diagnosticContext) this.diagnosticContextsByRoot.set(uriKey, options.diagnosticContext);
            if (options.showResult) {
                this.showResultMessage(result, diagnosticCount);
            }
            return { ...result, diagnosticCount };
        } catch (error) {
            if (this.runGeneration.get(uriKey) !== generation || !isCurrent()) {
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
        } finally {
            if (this.runningChecks.get(uriKey) === controller) this.runningChecks.delete(uriKey);
        }
    }

    shouldCheckOnSave(document) {
        if (document.languageId !== "freebasic") {
            return false;
        }

        const configuration = this.vscode.workspace.getConfiguration("freebasic", document.uri);
        return configuration.get("diagnostics.run", "onSave") === "onSave";
    }

    documentOpened(document) {
        if (document?.uri?.scheme !== "file" || !/\.(bas|bi)$/i.test(document.uri.fsPath)) return;
        try { if (!fs.statSync(document.uri.fsPath).isFile()) return; }
        catch { return; }
        const name = path.basename(document.uri.fsPath).toLowerCase();
        const availablePath = diagnosticPathKey(document.uri.fsPath);
        const affectedUris = new Set();
        for (const [rootKey, diagnostics] of this.diagnosticsByRoot) {
            const rootUri = this.diagnosticDependenciesByRoot.get(rootKey)?.uri || this.vscode.Uri.parse(rootKey);
            if (!rootUri?.fsPath) continue;
            for (const [key, entry] of diagnostics) {
                const remaining = entry.diagnostics.filter((diagnostic) => {
                    if (diagnostic.code !== 23) return true;
                    /* FBC error 23 carries the quoted missing filename. Use
                       only that rule's first line, never arbitrary #error text.
                       Retire published errors without cancelling a fresh check. */
                    const requested = diagnostic.message.split("\n", 1)[0].match(/^File not found, "([^\r\n]+)"$/i)?.[1];
                    if (!requested || path.posix.basename(requested.replace(/\\/g, "/")).toLowerCase() !== name) return true;
                    /* Cwd is an unconditional FBC lookup. The diagnostic's
                       displayed filename may be remapped by #line, so do not
                       infer a physical include directory from that label. */
                    return diagnosticPathKey(path.resolve(path.dirname(rootUri.fsPath),
                        requested.replace(/\\/g, path.sep))) !== availablePath;
                });
                if (remaining.length === entry.diagnostics.length) continue;
                if (remaining.length) diagnostics.set(key, { ...entry, diagnostics: remaining });
                else diagnostics.delete(key);
                affectedUris.add(key);
            }
        }
        for (const key of affectedUris) this.refreshDiagnosticUri(key);
    }

    clearDocument(uri) {
        const uriKey = uri.toString();
        this.runGeneration.set(uriKey, ++this.nextGeneration);
        this.runningChecks.get(uriKey)?.abort();
        this.runningChecks.delete(uriKey);
        const dependentRoots = this.getDependentModules(uri);
        this.clearRootDiagnostics(uriKey);
        for (const dependent of dependentRoots) {
            if (dependent.toString() !== uriKey) this.clearRootDiagnostics(dependent.toString());
        }
        this.clearDiagnosticUri(uriKey);
    }

    forgetDocument(uri) {
        this.clearDocument(uri);
        if (/\.bas$/i.test(uri.fsPath || "")) this.removeDiagnosticDependencies(uri.toString());
    }

    getDependentModules(uri) {
        if (!uri?.fsPath) return [];
        if (this.diagnosticDependencyIndexIncomplete) {
            const roots = new Map();
            for (const document of this.vscode.workspace.textDocuments || []) {
                if (document.uri.scheme === "file" && /\.bas$/i.test(document.uri.fsPath)) roots.set(document.uri.toString(), document.uri);
            }
            for (const [rootKey, diagnostics] of this.diagnosticsByRoot) {
                const uri = this.diagnosticDependenciesByRoot.get(rootKey)?.uri ||
                    [...diagnostics.values()][0]?.uri || this.vscode.Uri.parse(rootKey);
                roots.set(rootKey, uri);
            }
            return [...roots.values()];
        }
        const roots = new Set(this.diagnosticRootsByDependency.get(diagnosticPathKey(uri.fsPath)) || []);
        for (const [rootKey, dependency] of this.diagnosticDependenciesByRoot) {
            if (!dependency.complete && /\.(?:bas|bi)$/i.test(uri.fsPath)) roots.add(rootKey);
        }
        return [...roots].map((rootKey) => this.diagnosticDependenciesByRoot.get(rootKey)?.uri).filter(Boolean);
    }

    setDiagnosticDependencies(rootDocument, result) {
        const rootKey = rootDocument.uri.toString();
        this.removeDiagnosticDependencies(rootKey);
        if (this.diagnosticDependencyIndexIncomplete) return;

        /* Macro-expanded includes are not always recoverable from editor text. */
        const paths = new Set([rootDocument.uri.fsPath, ...(result.diagnosticSources || [])].map(diagnosticPathKey));
        if (paths.size > 5000 || this.diagnosticDependenciesByRoot.size >= 5000 ||
            this.diagnosticDependencyEdges + paths.size > 50000) {
            this.clearDiagnosticDependencyIndex(true);
            return;
        }

        this.diagnosticDependenciesByRoot.set(rootKey, {
            uri: rootDocument.uri,
            paths,
            complete: result.diagnosticSourcesComplete === true
        });
        this.diagnosticDependencyEdges += paths.size;
        for (const filePath of paths) {
            const roots = this.diagnosticRootsByDependency.get(filePath) || new Set();
            roots.add(rootKey);
            this.diagnosticRootsByDependency.set(filePath, roots);
        }
    }

    removeDiagnosticDependencies(rootKey) {
        const previous = this.diagnosticDependenciesByRoot.get(rootKey);
        if (!previous) return;
        this.diagnosticDependenciesByRoot.delete(rootKey);
        this.diagnosticDependencyEdges -= previous.paths.size;
        for (const filePath of previous.paths) {
            const roots = this.diagnosticRootsByDependency.get(filePath);
            roots?.delete(rootKey);
            if (roots?.size === 0) this.diagnosticRootsByDependency.delete(filePath);
        }
    }

    clearDiagnosticDependencyIndex(incomplete = false) {
        this.diagnosticDependenciesByRoot.clear();
        this.diagnosticRootsByDependency.clear();
        this.diagnosticDependencyEdges = 0;
        this.diagnosticDependencyIndexIncomplete = incomplete;
    }

    clearAll() {
        for (const controller of this.runningChecks.values()) controller.abort();
        this.runningChecks.clear();
        this.diagnosticsByRoot.clear();
        this.diagnosticContextsByRoot.clear();
        this.clearDiagnosticDependencyIndex();
        this.runGeneration.clear();
        this.diagnosticCollection.clear();
    }

    dispose() {
        /* VS Code disposes subscriptions after calling deactivate(), which
           also stops this service before the shared process supervisor. */
        if (this.disposed) return;
        this.disposed = true;
        this.clearAll();
    }

    getValidationMessage(document, allowHeader = false) {
        if (!this.vscode.workspace.isTrusted) {
            return "Compiler diagnostics are disabled in untrusted workspaces.";
        }
        if (document.languageId !== "freebasic") {
            return "The active document is not a FreeBASIC source file.";
        }
        if (document.uri.scheme !== "file") {
            return "Compiler diagnostics require a local file.";
        }
        if (!/\.bas$/i.test(document.uri.fsPath) && !(allowHeader && /\.bi$/i.test(document.uri.fsPath))) {
            return "Compile-only diagnostics run on .bas modules. Included .bi diagnostics are reported through their module.";
        }
        if (document.isDirty) {
            return "Save the FreeBASIC file before running compiler diagnostics.";
        }
        return "";
    }

    async publishDiagnostics(rootDocument, result, generation, isCurrent = null) {
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
            const details = [compilerDiagnostic.compilerDetail, compilerDiagnostic.compilerCustomText]
                .filter((detail) => detail && !compilerDiagnostic.message.includes(detail));
            const guidance = compilerDiagnosticGuidance(compilerDiagnostic);
            const diagnostic = new this.vscode.Diagnostic(
                range,
                [compilerDiagnostic.message, ...details, compilerDiagnosticContextLabel(compilerDiagnostic.compilerContext)
                    ? `Compiler context: ${compilerDiagnosticContextLabel(compilerDiagnostic.compilerContext)}` : "", guidance]
                    .filter(Boolean).join("\n\n"),
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

        if (this.runGeneration.get(rootUriKey) !== generation || isCurrent && !isCurrent()) {
            return null;
        }

        const previousDiagnostics = this.diagnosticsByRoot.get(rootUriKey) || new Map();
        const affectedUris = new Set([
            ...previousDiagnostics.keys(),
            ...diagnosticsByUri.keys()
        ]);
        this.diagnosticsByRoot.set(rootUriKey, diagnosticsByUri);
        if (!result.cancelled && !result.timedOut && !result.outputTruncated && result.exitCode >= 0) {
            this.setDiagnosticDependencies(rootDocument, result);
        }

        for (const uriKey of affectedUris) {
            this.refreshDiagnosticUri(uriKey);
        }
        return diagnosticCount;
    }

    clearRootDiagnostics(rootUriKey) {
        this.diagnosticContextsByRoot.delete(rootUriKey);
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

    if (!diagnostic.physicalPoint && typeof document.getText === "function") {
        const documentText = document.getText();
        const nextWarning = compilerMeaninglessNextVariableRange(documentText, diagnostic);
        if (nextWarning) {
            return new vscode.Range(nextWarning.line, nextWarning.startCharacter,
                nextWarning.line, nextWarning.endCharacter);
        }
        const missingQuote = compilerMissingClosingQuoteRange(documentText, diagnostic);
        if (missingQuote) {
            return new vscode.Range(missingQuote.line, missingQuote.startCharacter,
                missingQuote.line, missingQuote.endCharacter);
        }
    }

    if (diagnostic.physicalPoint && typeof document.getText === "function") {
        const documentText = document.getText();
        const physical = physicalDiagnosticRange(documentText, diagnostic.physicalPoint);
        const semanticRange = compilerDeclarationSuffixConflictRange(documentText, diagnostic) ||
            compilerIgnoredDeclarationSuffixRange(documentText, diagnostic) ||
            compilerImplicitVariableAllocationRange(documentText, diagnostic) ||
            compilerImplicitParameterPassingModeRange(documentText, diagnostic) ||
            compilerParameterDefaultMismatchRange(documentText, diagnostic) ||
            compilerProcedureSignatureMismatchRange(documentText, diagnostic) ||
            compilerForNextCounterMismatchRange(documentText, diagnostic) ||
            compilerMeaninglessNextVariableRange(documentText, diagnostic) ||
            compilerConstantConversionOverflowRange(documentText, diagnostic) ||
            compilerConstantConversionOverflowPointRange(documentText, diagnostic) ||
            compilerSuspiciousPointerAssignmentRange(documentText, diagnostic) ||
            compilerFunctionPointerMismatchRange(documentText, diagnostic) ||
            compilerOperatorWarningTokenRange(documentText, diagnostic) ||
            compilerConstQualifierWarningRange(documentText, diagnostic) ||
            compilerLargeStackWarningRange(documentText, diagnostic) ||
            compilerImplicitConversionRange(documentText, diagnostic) ||
            compilerLineInputBufferCapacityRange(documentText, diagnostic) ||
            compilerMissingClosingQuoteRange(documentText, diagnostic) ||
            compilerPossibleEscapeStringRange(documentText, diagnostic) ||
            compilerRedundantNewAnyInitializerRange(documentText, diagnostic) ||
            compilerErrorResumeNextRange(documentText, diagnostic);
        if (semanticRange) {
            return new vscode.Range(semanticRange.line, semanticRange.startCharacter, semanticRange.line, semanticRange.endCharacter);
        }
        if (physical && physicalPointMatchesDiagnosticText(documentText, diagnostic) &&
            document.lineAt(physical.line).text === diagnostic.sourceText) {
            return new vscode.Range(physical.line, physical.startCharacter, physical.line, physical.endCharacter);
        }
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
