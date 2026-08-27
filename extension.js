/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: extension.js

    Purpose:

        Activate and connect the extension's focused language services.

    Responsibilities:

        - register FreeBASIC editor providers and commands
        - keep the workspace analysis index current
        - coordinate trusted compiler diagnostics on save or on demand
        - own and dispose VS Code resources

    This file intentionally does NOT contain:

        - parsing rules
        - provider implementation details
        - compiler process handling
*/

const vscode = require("vscode");

const { FreeBasicCompilerService } = require("./lib/compiler-service");
const { runFreeBasicCompiler } = require("./lib/compiler-diagnostics");
const { createEditorFeatures } = require("./lib/editor-features");
const { loadGrammarSource } = require("./lib/grammar-data");
const { FreeBasicWorkspaceIndex } = require("./lib/workspace-index");

const LANGUAGE_ID = "freebasic";

let compilerService = null;
let workspaceIndex = null;

function activate(context) {
    const grammarData = loadGrammarSource(context.extensionPath);
    const selector = { language: LANGUAGE_ID };
    const outputChannel = vscode.window.createOutputChannel("FreeBASIC");
    const diagnosticCollection = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);

    workspaceIndex = new FreeBasicWorkspaceIndex(vscode, LANGUAGE_ID);
    compilerService = new FreeBasicCompilerService(
        vscode,
        runFreeBasicCompiler,
        diagnosticCollection,
        outputChannel
    );

    const features = createEditorFeatures(vscode, workspaceIndex, grammarData);
    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.{bas,bi,BAS,BI}");

    context.subscriptions.push(
        outputChannel,
        diagnosticCollection,
        fileWatcher,
        vscode.languages.registerCompletionItemProvider(selector, features.completion, ".", "#"),
        vscode.languages.registerDefinitionProvider(selector, features.definition),
        vscode.languages.registerDocumentHighlightProvider(selector, features.documentHighlight),
        vscode.languages.registerDocumentLinkProvider(selector, features.documentLink),
        vscode.languages.registerDocumentSymbolProvider(selector, features.documentSymbol),
        vscode.languages.registerFoldingRangeProvider(selector, features.folding),
        vscode.languages.registerHoverProvider(selector, features.hover),
        vscode.languages.registerReferenceProvider(selector, features.reference),
        vscode.languages.registerRenameProvider(selector, features.rename),
        vscode.languages.registerSignatureHelpProvider(selector, features.signature, "(", ","),
        vscode.languages.registerWorkspaceSymbolProvider(features.workspaceSymbol),
        vscode.commands.registerCommand("freebasic.checkSyntax", async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!document) {
                vscode.window.showWarningMessage("Open a FreeBASIC module before running a compiler check.");
                return;
            }
            await compilerService.checkDocument(document, { showResult: true });
        }),
        vscode.commands.registerCommand("freebasic.rebuildWorkspaceIndex", async () => {
            workspaceIndex.invalidateWorkspace();
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: "Indexing FreeBASIC workspace"
                },
                async (_progress, token) => workspaceIndex.ensureInitialized(token)
            );
            vscode.window.showInformationMessage("FreeBASIC workspace index rebuilt.");
        }),
        vscode.commands.registerCommand("freebasic.showOutput", () => outputChannel.show(true)),
        vscode.workspace.onDidChangeTextDocument((event) => {
            workspaceIndex.refreshDocument(event.document);
        }),
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (document.languageId !== LANGUAGE_ID) {
                return;
            }

            workspaceIndex.refreshDocument(document);
            if (compilerService.shouldCheckOnSave(document)) {
                await compilerService.checkDocument(document);
            }
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.uri.scheme === "untitled") {
                workspaceIndex.removeUri(document.uri);
                compilerService.clearDocument(document.uri);
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            workspaceIndex.invalidateWorkspace();
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("freebasic.index")) {
                workspaceIndex.invalidateWorkspace();
            }
            if (
                event.affectsConfiguration("freebasic.compiler") ||
                event.affectsConfiguration("freebasic.diagnostics")
            ) {
                compilerService.clearAll();
            }
        }),
        fileWatcher.onDidCreate((uri) => workspaceIndex.refreshUri(uri)),
        fileWatcher.onDidChange((uri) => workspaceIndex.refreshUri(uri)),
        fileWatcher.onDidDelete((uri) => {
            workspaceIndex.removeUri(uri);
            compilerService.clearDocument(uri);
        })
    );

    workspaceIndex.ensureInitialized(vscode.CancellationToken.None).catch((error) => {
        outputChannel.appendLine(`Workspace indexing failed: ${error.message}`);
    });
}

function deactivate() {
    compilerService = null;
    workspaceIndex = null;
}

module.exports = {
    activate,
    deactivate
};

/* end of extension.js */
