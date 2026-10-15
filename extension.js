/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: extension.js

    Purpose:

        Activate and connect the extension's focused language services.

    Responsibilities:

        - register FreeBASIC editor providers and commands
        - keep the workspace analysis index current
        - publish delimiter, inactive-code, and trusted compiler diagnostics
        - own and dispose VS Code resources

    This file intentionally does NOT contain:

        - parsing rules
        - provider implementation details
        - compiler process handling
*/

const vscode = require("vscode");

const { findBracketProblems } = require("./lib/bracket-diagnostics");
const { FreeBasicCompilerService } = require("./lib/compiler-service");
const { CompilerAnalysisService } = require("./lib/compiler-analysis-service");
const { CompilerProject } = require("./lib/compiler-project");
const { runFreeBasicCompiler } = require("./lib/compiler-diagnostics");
const { compilerExpressionTypeMessage } = require("./lib/compiler-constant-values");
const { createEditorFeatures } = require("./lib/editor-features");
const { loadGrammarSource } = require("./lib/grammar-data");
const { FreeBasicWorkspaceIndex } = require("./lib/workspace-index");

const LANGUAGE_ID = "freebasic";

let compilerService = null;
let workspaceIndex = null;
let compilerAnalysis = null;

function activate(context) {
    const grammarData = loadGrammarSource(context.extensionPath);
    const selector = { language: LANGUAGE_ID };
    const outputChannel = vscode.window.createOutputChannel("FreeBASIC");
    const diagnosticCollection = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);
    const bracketDiagnostics = vscode.languages.createDiagnosticCollection("freebasic-brackets");
    const inactiveCodeDiagnostics = vscode.languages.createDiagnosticCollection("freebasic-inactive-code");

    const updateSourceDiagnostics = (document) => {
        if (document.languageId !== LANGUAGE_ID) return;

        const text = document.getText();
        const version = document.version;
        const isCurrentDocument = () => document.version === version &&
            vscode.workspace.textDocuments.some((open) => open.uri.toString() === document.uri.toString());
        const publish = (ignoredRanges = [], remIdentifierOffsets = [], remKeywordDisabledLineOffsets = [],
            defaultEscapedStringRanges = []) => {
            if (!isCurrentDocument()) return;
            const offsetAdjustment = text.startsWith("\uFEFF") ? 1 : 0;
            const ranges = offsetAdjustment
                ? ignoredRanges.map((range) => ({ start: range.start + offsetAdjustment, end: range.end + offsetAdjustment }))
                : ignoredRanges;
            const escapedStringRanges = offsetAdjustment
                ? defaultEscapedStringRanges.map((range) => ({ start: range.start + offsetAdjustment, end: range.end + offsetAdjustment }))
                : defaultEscapedStringRanges;
            const bracketProblems = findBracketProblems(
                text, ranges, remIdentifierOffsets, remKeywordDisabledLineOffsets, escapedStringRanges
            ).map((problem) => {
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(document.positionAt(problem.start), document.positionAt(problem.end)),
                    problem.message,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.source = "FreeBASIC brackets";
                diagnostic.code = problem.code;
                return diagnostic;
            });
            bracketDiagnostics.set(document.uri, bracketProblems);
            const inactiveDiagnostics = [];
            for (const range of ranges.slice(0, 500)) {
                const start = range.start;
                const end = range.end;
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) continue;
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(document.positionAt(start), document.positionAt(end)),
                    "Inactive in the current compiler configuration.",
                    vscode.DiagnosticSeverity.Hint
                );
                diagnostic.source = "FreeBASIC compiler";
                diagnostic.code = "inactive-code";
                diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
                inactiveDiagnostics.push(diagnostic);
            }
            if (inactiveDiagnostics.length) inactiveCodeDiagnostics.set(document.uri, inactiveDiagnostics);
            else inactiveCodeDiagnostics.delete(document.uri);
        };

        publish();
        const model = compilerAnalysis?.getModel(document.uri);
        if (!model) return;
        if (model.remote) {
            Promise.all([
                model.query("compilerInactiveSourceRanges", document.uri),
                model.query("compilerBracketMaskOverrides", document.uri)
            ]).then(([ranges, overrides]) => {
                if (Array.isArray(ranges)) {
                    publish(ranges,
                        Array.isArray(overrides?.remIdentifierOffsets) ? overrides.remIdentifierOffsets : [],
                        Array.isArray(overrides?.remKeywordDisabledLineOffsets)
                            ? overrides.remKeywordDisabledLineOffsets : [],
                        Array.isArray(overrides?.defaultEscapedStringRanges)
                            ? overrides.defaultEscapedStringRanges : []);
                } else if (isCurrentDocument()) publish();
            }).catch(() => {});
        } else {
            const overrides = model.compilerBracketMaskOverrides(document.uri);
            publish(
                model.compilerInactiveSourceRanges(document.uri),
                overrides.remIdentifierOffsets,
                overrides.remKeywordDisabledLineOffsets,
                overrides.defaultEscapedStringRanges
            );
        }
    };

    workspaceIndex = new FreeBasicWorkspaceIndex(vscode, LANGUAGE_ID);
    compilerAnalysis = new CompilerAnalysisService(vscode, workspaceIndex, outputChannel);
    workspaceIndex.compilerAnalysis = compilerAnalysis;
    workspaceIndex.compilerProject = new CompilerProject(vscode, compilerAnalysis);
    compilerService = new FreeBasicCompilerService(
        vscode,
        (options) => runFreeBasicCompiler({ ...options, processSupervisor: compilerAnalysis.processSupervisor }),
        diagnosticCollection,
        outputChannel
    );
    const bracketSnapshotSubscription = compilerAnalysis.onDidChangeSnapshot?.((sourceUris) => {
        const changedUris = new Set(sourceUris);
        for (const document of vscode.workspace.textDocuments) {
            if (document.languageId === LANGUAGE_ID && changedUris.has(document.uri.toString())) {
                updateSourceDiagnostics(document);
            }
        }
    });

    const features = createEditorFeatures(vscode, workspaceIndex, grammarData);
    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{bas,bi,BAS,BI}");

    context.subscriptions.push(
        outputChannel,
        diagnosticCollection,
        bracketDiagnostics,
        inactiveCodeDiagnostics,
        fileWatcher,
        compilerService,
        workspaceIndex,
        compilerAnalysis,
        ...(bracketSnapshotSubscription ? [bracketSnapshotSubscription] : []),
        vscode.workspace.registerTextDocumentContentProvider("freebasic-preprocessed", compilerAnalysis),
        vscode.commands.registerCommand("freebasic.analyzeModule", () => {
            const document = vscode.window.activeTextEditor?.document;
            return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Analyzing FreeBASIC source", cancellable: true }, (_progress, token) => compilerAnalysis.check(document, true, token));
        }),
        vscode.commands.registerCommand("freebasic.selectCompilerContext", () => compilerAnalysis.selectContext(vscode.window.activeTextEditor?.document)),
        vscode.commands.registerCommand("freebasic.showPreprocessed", () => compilerAnalysis.showExpanded(vscode.window.activeTextEditor?.document)),
        vscode.commands.registerCommand("freebasic.showExpressionType", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return null;
            if (!compilerAnalysis.getModel(editor.document.uri) && !await compilerAnalysis.check(editor.document, false)) return null;
            const model = compilerAnalysis.getModel(editor.document.uri);
            const expression = await model?.expressionAt(editor.document.uri, editor.selection.start, editor.selection.end);
            const compilerFact = model?.remote ? null : model?.compilerSidecarFactAt?.(
                editor.document.uri, editor.selection.start, editor.selection.end
            );
            const compilerConstantValues = compilerFact?.compilerConstantValues;
            let targetWideLiteral = compilerFact?.targetWideLiteral || expression?.targetWideLiteral;
            const selectedText = editor.document.getText(editor.selection);
            if (!targetWideLiteral && model?.semanticSidecarOnly && expression && !expression.provisional &&
                String(expression.typeName || "").trim().toLowerCase() === "wstring" &&
                (/\bWStr\s*\(/i.test(selectedText) || /!\s*"/.test(selectedText))) {
                const fullModel = await compilerAnalysis.getModelForEditor(editor.document, null, true, true);
                if (fullModel?.remote && !fullModel.partial) {
                    const fullExpression = await fullModel.expressionAt(
                        editor.document.uri, editor.selection.start, editor.selection.end
                    );
                    targetWideLiteral = fullExpression?.targetWideLiteral || null;
                } else if (fullModel && !fullModel.partial) {
                    targetWideLiteral = fullModel.compilerTargetWideLiteralAt?.(
                        editor.document.uri, editor.selection.start
                    ) || null;
                }
            }
            const expressionForMessage = expression && (compilerConstantValues?.length || targetWideLiteral)
                ? {
                    ...expression,
                    ...(compilerConstantValues?.length ? { compilerConstantValues } : {}),
                    ...(targetWideLiteral ? { targetWideLiteral } : {})
                }
                : expression;
            const message = compilerExpressionTypeMessage(expressionForMessage);
            if (message) vscode.window.showInformationMessage(message);
            else vscode.window.showWarningMessage("No valid compiler expression span covers this selection. Inspect diagnostics or the expanded module.");
            return expression?.typeName || null;
        }),
        vscode.languages.registerCompletionItemProvider(selector, features.completion, ".", "#", ">", "<", '"', "/", "\\"),
        vscode.languages.registerCodeActionsProvider(selector, features.codeAction, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite]
        }),
        vscode.languages.registerDefinitionProvider(selector, features.definition),
        vscode.languages.registerDeclarationProvider(selector, features.declaration),
        vscode.languages.registerImplementationProvider(selector, features.implementation),
        vscode.languages.registerTypeDefinitionProvider(selector, features.typeDefinition),
        vscode.languages.registerCallHierarchyProvider(selector, features.callHierarchy),
        vscode.languages.registerCodeLensProvider(selector, features.callCodeLens),
        vscode.languages.registerTypeHierarchyProvider(selector, features.typeHierarchy),
        vscode.languages.registerSelectionRangeProvider(selector, features.selectionRange),
        vscode.languages.registerDocumentSemanticTokensProvider(selector, features.semanticTokens, features.semanticLegend),
        vscode.languages.registerDocumentHighlightProvider(selector, features.documentHighlight),
        vscode.languages.registerDocumentLinkProvider(selector, features.documentLink),
        vscode.languages.registerDocumentFormattingEditProvider(selector, features.documentFormatting),
        vscode.languages.registerDocumentRangeFormattingEditProvider(selector, features.documentRangeFormatting),
        vscode.languages.registerDocumentSymbolProvider(selector, features.documentSymbol),
        vscode.languages.registerInlayHintsProvider(selector, features.inlayHints),
        vscode.languages.registerFoldingRangeProvider(selector, features.folding),
        vscode.languages.registerHoverProvider(selector, features.hover),
        vscode.languages.registerReferenceProvider(selector, features.reference),
        vscode.languages.registerRenameProvider(selector, features.rename),
        vscode.languages.registerSignatureHelpProvider(selector, features.signature, "(", "[", ","),
        vscode.languages.registerWorkspaceSymbolProvider(features.workspaceSymbol),
        vscode.commands.registerCommand("freebasic.checkSyntax", async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!document) {
                vscode.window.showWarningMessage("Open a FreeBASIC module before running a compiler check.");
                return;
            }
            if (compilerAnalysis.shouldAnalyzeUnsavedBuffers(document)) {
                return vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Checking FreeBASIC source with editor buffers",
                    cancellable: true
                }, (_progress, token) => compilerAnalysis.check(document, true, token));
            }
            await compilerService.checkDocument(document, { showResult: true });
        }),
        vscode.commands.registerCommand("freebasic.rebuildWorkspaceIndex", async () => {
            workspaceIndex.invalidateWorkspace();
            const completed = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: "Indexing FreeBASIC workspace"
                },
                async (_progress, token) => workspaceIndex.ensureInitialized(token)
            );
            if (!completed) return;
            if (workspaceIndex.isIncomplete()) vscode.window.showWarningMessage("FreeBASIC index is incomplete. Check freebasic.index limits or unreadable files. Rename is disabled until the index is complete.");
            else vscode.window.showInformationMessage("FreeBASIC workspace index rebuilt.");
        }),
        vscode.commands.registerCommand("freebasic.showOutput", () => outputChannel.show(true)),
        vscode.workspace.onDidChangeTextDocument((event) => {
            workspaceIndex.refreshDocument(event.document);
            if (event.contentChanges.length && event.document.languageId === LANGUAGE_ID) {
                updateSourceDiagnostics(event.document);
                compilerAnalysis.schedule(event.document);
                compilerAnalysis.documentChanged(event.document);
                compilerService.clearDocument(event.document.uri);
                for (const uri of workspaceIndex.getDependentModules(event.document.uri)) compilerService.clearDocument(uri);
            }
        }),
        vscode.workspace.onDidOpenTextDocument(updateSourceDiagnostics),
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (document.languageId !== LANGUAGE_ID) {
                return;
            }

            workspaceIndex.refreshDocument(document);
            if (/\.(bas|bi)$/i.test(document.uri.fsPath) && vscode.workspace.getConfiguration("freebasic", document.uri).get("analysis.run", "off") === "onSave") {
                await compilerAnalysis.check(document, false);
            }
            if (compilerService.shouldCheckOnSave(document)) {
                if (/\.bas$/i.test(document.uri.fsPath)) await compilerService.checkDocument(document);
                else if (/\.bi$/i.test(document.uri.fsPath)) {
                    await workspaceIndex.ensureInitialized();
                    const affected = new Set(workspaceIndex.getDependentModules(document.uri).map((uri) => uri.toString()));
                    for (const uri of compilerService.getDependentModules(document.uri)) affected.add(uri.toString());
                    /* Only recheck open modules automatically after a header save. */
                    for (const module of vscode.workspace.textDocuments) {
                        if (affected.has(module.uri.toString()) && compilerService.shouldCheckOnSave(module)) await compilerService.checkDocument(module);
                    }
                }
            }
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            bracketDiagnostics.delete(document.uri);
            inactiveCodeDiagnostics.delete(document.uri);
            if (document.languageId === LANGUAGE_ID) compilerAnalysis.invalidate();
            if (document.uri.scheme === "untitled") {
                workspaceIndex.removeUri(document.uri);
                compilerService.clearDocument(document.uri);
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            compilerAnalysis.invalidate();
            workspaceIndex.invalidateWorkspace();
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            /*
                Compiler snapshots compare their complete context signature at
                publication and query time. VS Code can deliver this event
                after a command has already read the new settings; cancelling
                that otherwise current analysis would turn a valid command
                into a false failure. Context changes therefore remain guarded
                by the snapshot and project checks instead of a blanket abort.
            */
            if (event.affectsConfiguration("freebasic.index")) {
                workspaceIndex.invalidateWorkspace();
            }
            if (event.affectsConfiguration("freebasic.includePaths") || event.affectsConfiguration("freebasic.compiler")) {
                workspaceIndex.invalidateWorkspace();
            }
            if (
                event.affectsConfiguration("freebasic.compiler") ||
                event.affectsConfiguration("freebasic.diagnostics") ||
                event.affectsConfiguration("freebasic.includePaths")
            ) {
                compilerService.clearAll();
            }
        }),
        fileWatcher.onDidCreate((uri) => { compilerAnalysis.invalidate(); workspaceIndex.refreshUri(uri); }),
        fileWatcher.onDidChange((uri) => { compilerAnalysis.invalidate(); workspaceIndex.refreshUri(uri); }),
        fileWatcher.onDidDelete((uri) => {
            compilerAnalysis.invalidate();
            workspaceIndex.removeUri(uri);
            compilerService.forgetDocument(uri);
        })
    );

    for (const document of vscode.workspace.textDocuments) {
        updateSourceDiagnostics(document);
    }

    workspaceIndex.ensureInitialized().catch((error) => {
        outputChannel.appendLine(`Workspace indexing failed: ${error.message}`);
    });
}

function deactivate() {
    compilerService?.dispose();
    const analysisStopped = compilerAnalysis?.dispose();
    workspaceIndex?.dispose();
    compilerService = null;
    workspaceIndex = null;
    compilerAnalysis = null;
    // VS Code awaits a deactivation promise. Keep native process reaping and
    // worker temporary cleanup alive until the analysis service has stopped.
    return analysisStopped;
}

module.exports = {
    activate,
    deactivate
};

/* end of extension.js */
