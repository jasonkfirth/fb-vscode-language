/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-language-status.js
    Purpose: Explain compiler assistance in VS Code's language-status menu.
    Responsibilities: display current context, progress, limits, and useful actions.
    Does not contain: compiler execution, source parsing, or analysis scheduling.
*/

const path = require("path");

/* Keep user-supplied names and configuration errors readable in a small menu. */
const MAX_STATUS_CONTEXT_LENGTH = 80;
const MAX_STATUS_ERROR_LENGTH = 512;

function compilerLanguageStatus(vscode, analysis, document) {
    const status = {
        text: "FBC: source model",
        detail: "FreeBASIC source editing is available.",
        severity: vscode.LanguageStatusSeverity.Information,
        busy: false,
        command: { command: "freebasic.analyzeModule", title: "Analyze module" }
    };
    if (!document || document.languageId !== "freebasic") return status;
    if (!vscode.workspace.isTrusted) return { ...status, text: "FBC: restricted",
        detail: "Compiler execution is disabled in untrusted workspaces. Source editing remains available.",
        command: { command: "workbench.trust.manage", title: "Manage workspace trust" } };
    if (document.uri.scheme === "freebasic-preprocessed") return { ...status, text: "FBC: expanded source",
        detail: "Read-only compiler output. Return to the source module to refresh its analysis.",
        command: { command: "freebasic.showOutput", title: "Show compiler output" } };
    if (document.uri.scheme !== "file" || !/\.(bas|bi)$/i.test(document.uri.fsPath)) return { ...status, text: "FBC: name source file",
        detail: "Compiler assistance requires a named .bas module or .bi header on disk.",
        command: { command: "workbench.action.files.saveAs", title: "Save source as .bas or .bi" } };

    const compiler = analysis.analysisCompilerFor(document.uri);
    if (!compiler.compilerPath) return { ...status, text: "FBC: not configured",
        detail: "Set a compiler path to enable compiler assistance. Source editing remains available.",
        command: { command: "workbench.action.openSettings", title: "Configure compiler", arguments: ["freebasic.compiler.path"] } };
    let context;
    try { context = analysis.contextFor(document.uri, compiler); }
    catch (error) {
        const header = /\.bi$/i.test(document.uri.fsPath);
        return { ...status, text: header ? "FBC: select header context" : "FBC: context error",
            severity: vscode.LanguageStatusSeverity.Warning, detail: String(error.message).slice(0, MAX_STATUS_ERROR_LENGTH),
            command: header ? { command: "freebasic.selectCompilerContext", title: "Select header context" }
                : { command: "workbench.action.openSettings", title: "Configure build contexts", arguments: ["freebasic.analysis"] } };
    }
    const compatibility = analysis.compilerCompatibilityFor?.(document.uri);
    if (compatibility?.state === "checking") return { ...status, text: "FBC: checking version",
        detail: "Checking whether this compiler supports semantic analysis. Syntax highlighting and source editing remain available." };
    if (compatibility?.state === "unsupported") return { ...status, text: "FBC: limited mode",
        severity: vscode.LanguageStatusSeverity.Information,
        detail: compatibility.message,
        command: { command: "workbench.action.openSettings", title: "Configure compiler",
            arguments: [compiler.semanticModelOnly ? "freebasic.compiler.path" : "freebasic.analysis.compilerPath"] } };
    if (compatibility?.state === "unknown") return { ...status, text: "FBC: version unknown",
        severity: vscode.LanguageStatusSeverity.Warning,
        detail: `${compatibility.message} Compiler analysis will check the available features when requested. Syntax highlighting remains available.` };
    const backend = compiler.semanticModelOnly ? "FBC sidecar (saved files)" : "editor bridge";
    const contextName = context.name ? String(context.name).replace(/[\r\n]/g, " ").slice(0, MAX_STATUS_CONTEXT_LENGTH) : "default options";
    const detail = `${backend}; ${contextName}; ${path.basename(context.filePath)}.`;
    const key = vscode.Uri.file(context.filePath).toString();
    if (analysis.running.has(key) && !analysis.running.get(key).signal.aborted &&
        analysis.runningContexts.get(key)?.signature === context.signature) return { ...status,
        text: "FBC: analyzing", busy: true, detail,
        command: { command: "freebasic.showOutput", title: "Show compiler output" } };
    if (compiler.semanticModelOnly && document.isDirty) return { ...status, text: "FBC: save for analysis",
        detail: `${detail} Save changed source buffers, or configure the editor bridge for unsaved-buffer analysis.`,
        command: { command: "workbench.action.files.save", title: "Save current source" } };
    const model = analysis.getModel(document.uri);
    if (model) return { ...status, text: model.partial ? "FBC: partial analysis" : "FBC: ready",
        severity: model.partial ? vscode.LanguageStatusSeverity.Warning : status.severity,
        detail: model.partial ? `${detail} Compiler errors limit available facts; inspect Problems for details.` : detail };
    const root = analysis.snapshots.get(key);
    if (/\.bi$/i.test(document.uri.fsPath) && root?.context.signature === context.signature &&
        analysis.modelForSnapshot(root) &&
        !root.sources.some((source) => source.uri.toString() === document.uri.toString())) return { ...status,
        text: "FBC: header not included", severity: vscode.LanguageStatusSeverity.Warning,
        detail: `${detail} The selected root did not consume this header. Choose a build that includes it.`,
        command: { command: "freebasic.selectCompilerContext", title: "Select header context" } };
    if (analysis.onDemandFailures.get(document)?.retryAfter > Date.now()) return { ...status, text: "FBC: retry analysis",
        severity: vscode.LanguageStatusSeverity.Warning,
        detail: `${detail} The previous analysis failed. Analyze the module to retry, or inspect compiler output.` };
    const mode = vscode.workspace.getConfiguration("freebasic", document.uri).get("analysis.run", "onDemand");
    if (mode === "off") return { ...status, text: "FBC: manual analysis",
        detail: `${detail} Automatic analysis is off. Analyze the module when compiler assistance is needed.` };
    if (mode === "onSave") return { ...status, text: "FBC: waiting for save", detail: `${detail} Analysis runs after a save.` };
    if (mode === "onChange") return { ...status, text: "FBC: analysis on change", detail: `${detail} Analysis follows source edits.` };
    return { ...status, text: "FBC: on demand", detail: `${detail} Editor requests prepare compiler facts when needed.` };
}

function createCompilerLanguageStatus(vscode, analysis) {
    const item = vscode.languages.createLanguageStatusItem("freebasic.compiler", { language: "freebasic" });
    item.name = "FreeBASIC Compiler";
    let timer = null, disposed = false;
    const refresh = () => {
        if (disposed || timer !== null) return;
        /* Coalesce document events with the service's invalidation/publication.
           Rendering status must neither race those handlers nor run analysis. */
        timer = setTimeout(() => {
            timer = null;
            if (!disposed) Object.assign(item, compilerLanguageStatus(vscode, analysis, vscode.window.activeTextEditor?.document));
        }, 0);
    };
    const documentChanged = (document) => { if (document.languageId === "freebasic") refresh(); };
    const subscriptions = [
        vscode.window.onDidChangeActiveTextEditor(refresh),
        vscode.workspace.onDidChangeTextDocument((event) => documentChanged(event.document)),
        vscode.workspace.onDidSaveTextDocument(documentChanged),
        vscode.workspace.onDidCloseTextDocument(documentChanged),
        vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration("freebasic")) refresh(); }),
        vscode.workspace.onDidGrantWorkspaceTrust(refresh),
        analysis.onDidChangeAnalysis(refresh),
        analysis.onDidChangeSnapshot(refresh)
    ];
    refresh();
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            clearTimeout(timer);
            for (const subscription of subscriptions) subscription.dispose();
            item.dispose();
        }
    };
}

module.exports = { compilerLanguageStatus, createCompilerLanguageStatus };

/* end of compiler-language-status.js */
