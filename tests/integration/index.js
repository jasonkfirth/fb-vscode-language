/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/integration/index.js

    Purpose:

        Verify observable language features through the actual VS Code API.

    Responsibilities:

        - activate the extension in an isolated workspace
        - exercise completions, navigation, references, and safe rename
        - verify documentation, signatures, symbols, and semantic tokens
        - allow focused provider checks against an external FreeBASIC corpus

    This file intentionally does NOT contain:

        - mocked VS Code APIs
        - changes to the user's editor profile
        - marketplace access
*/

const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const vscode = require("vscode");

// Document change/close events cross the extension-host boundary. Keep editor
// state checks bounded if their delivery contract changes.
const DOCUMENT_CHANGE_TIMEOUT_MS = 5000;

function position(document, text, relative = 0) {
    const offset = document.getText().indexOf(text);
    assert.notEqual(offset, -1, `Missing fixture text: ${text}`);
    return document.positionAt(offset + relative);
}

function unresolvedValueDiagnostic(diagnostic, name = "") {
    return diagnostic.source === "fbc" &&
        /^(?:(?:variable|symbol) not declared|Implicit variables are only valid in -lang deprecated or fblite or qb,)/i.test(diagnostic.message) &&
        (!name || diagnostic.message.toLowerCase().includes(name.toLowerCase()));
}

async function applyEditAndWaitForDocuments(edit, documents) {
    const expectedVersions = new Map(documents.map((document) => [document.uri.toString(), document.version]));
    const changedUris = new Set();
    let listener = null;
    let timeout = null;
    const changed = new Promise((resolve, reject) => {
        listener = vscode.workspace.onDidChangeTextDocument((event) => {
            const key = event.document.uri.toString();
            if (expectedVersions.has(key) && event.document.version > expectedVersions.get(key)) changedUris.add(key);
            if (changedUris.size === expectedVersions.size) resolve();
        });
        timeout = setTimeout(() => reject(new Error("VS Code did not publish all edited-document change events.")), DOCUMENT_CHANGE_TIMEOUT_MS);
    });
    try {
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        await changed;
    } finally {
        clearTimeout(timeout);
        listener?.dispose();
    }
}

async function waitForDiagnostics(uri, predicate, message) {
    const deadline = Date.now() + 15000;
    let diagnostics = [];
    while (Date.now() < deadline) {
        diagnostics = vscode.languages.getDiagnostics(uri);
        if (predicate(diagnostics)) return diagnostics;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`${message} ${JSON.stringify(diagnostics.map((diagnostic) => ({
        message: diagnostic.message,
        line: diagnostic.range.start.line,
        character: diagnostic.range.start.character
    })))}`);
}

async function waitForDocumentLinks(uri, command = "vscode.executeLinkProvider") {
    // Provider replacement restarts the editor's combined link computation.
    // Retry empty replies only; wrong targets still fail the caller's checks.
    const deadline = Date.now() + DOCUMENT_CHANGE_TIMEOUT_MS;
    let links;
    do {
        links = await vscode.commands.executeCommand(command, uri);
        if (links?.length) return links;
        await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return links || [];
}

async function run() {
    const extension = vscode.extensions.getExtension("SJZero.fb-vscode-language");
    assert.ok(extension, "Extension was not discovered");
    if (process.env.FREEBASIC_EXPECTED_EXTENSION_PATH) {
        assert.equal(path.resolve(extension.extensionPath), path.resolve(process.env.FREEBASIC_EXPECTED_EXTENSION_PATH), "The active extension must come from the installed VSIX payload.");
    }
    await extension.activate();
    const corpusRoot = process.env.FREEBASIC_CORPUS_ROOT || "";
    const initialFile = corpusRoot
        ? path.join(corpusRoot, "fb_src/sqlite3_initialize.bas")
        : path.join(__dirname, "workspace/main.bas");
    const uri = vscode.Uri.file(initialFile);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("freebasic.rebuildWorkspaceIndex");
    const checks = [];
    const testFilter = (process.env.FREEBASIC_TEST_FILTER || "").trim().toLowerCase();
    const check = async (name, action) => {
        if (testFilter && !name.toLowerCase().includes(testFilter)) {
            console.log(`SKIP: ${name}`);
            return;
        }
        await action();
        checks.push(name);
        console.log(`PASS: ${name}`);
    };

    if (corpusRoot) await check("SQLite FreeBASIC corpus indexes and resolves both projects", async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        assert.equal(path.resolve(workspaceFolder || ""), path.resolve(corpusRoot));

        const sqliteSymbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
        assert.ok(sqliteSymbols.some((symbol) => symbol.name === "sqlite3_initialize"),
            "SQLite procedure symbols should be available in the implementation file");
        const sqlitePosition = position(document, "Function sqlite3_initialize", "Function ".length);
        const sqliteDefinitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, sqlitePosition);
        assert.ok((Array.isArray(sqliteDefinitions) ? sqliteDefinitions : [sqliteDefinitions]).some((entry) =>
            entry?.uri?.fsPath === uri.fsPath), "SQLite source definition should resolve to its physical procedure");

        const converterFile = path.join(corpusRoot, "fb_tools/c2fb/c2fb.bas");
        const converterUri = vscode.Uri.file(converterFile);
        const converterDocument = await vscode.workspace.openTextDocument(converterUri);
        await vscode.window.showTextDocument(converterDocument);
        const converterPosition = position(converterDocument, "C2fbTranslationContext");
        const converterDefinitions = await vscode.commands.executeCommand(
            "vscode.executeDefinitionProvider", converterUri, converterPosition
        );
        assert.ok((Array.isArray(converterDefinitions) ? converterDefinitions : [converterDefinitions]).some((entry) =>
            entry?.uri?.fsPath === path.join(corpusRoot, "fb_tools/c2fb/c2fb_model.bi")),
        "C2FB type navigation should follow the root module's includes");

        const workspaceSymbols = await vscode.commands.executeCommand(
            "vscode.executeWorkspaceSymbolProvider", "C2fbTranslationContext"
        );
        assert.ok(workspaceSymbols.some((symbol) => symbol.name === "C2fbTranslationContext"),
            "workspace symbols should include the converter's shared context type");
        const memory = process.memoryUsage();
        console.log(`Corpus provider memory: ${(memory.heapUsed / 1048576).toFixed(0)} MiB heap, ` +
            `${(memory.rss / 1048576).toFixed(0)} MiB RSS.`);
    });

    await check("member completion returns Point members", async () => {
        const result = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, position(document, "origin.x", 7), undefined, 20);
        const labels = result.items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
        for (const name of ["x", "y", "SetX"]) assert.ok(labels.includes(name), `Missing member ${name}`);
        assert.equal(labels.includes("PRINT"), false);
        const setX = result.items.find((item) => item.label === "SetX");
        const setXSnippet = typeof setX.insertText === "string" ? setX.insertText : setX.insertText?.value;
        assert.equal(setXSnippet, "SetX(${1:newValue})$0",
            `a unique procedure completion should offer its parameter as a snippet placeholder; item=${JSON.stringify({
                detail: setX.detail,
                insertText: setX.insertText,
                documentation: setX.documentation?.value
            })}`);
        const original = document.getText();
        for (const [source, relative, name] of [["origin.SetX (20)", "origin.Se".length, "SetX"],
            ["Sin(0.5)", "Si".length, "Sin"]]) {
            const selected = position(document, source, relative);
            const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, selected);
            const item = completions.items.find((candidate) => String(candidate.label).toLowerCase() === name.toLowerCase() &&
                candidate.kind !== vscode.CompletionItemKind.Text);
            assert.ok(item, source);
            const insertion = typeof item.insertText === "string" ? item.insertText : item.insertText?.value;
            assert.equal(insertion?.toLowerCase(), name.toLowerCase(),
                "a written argument list must receive only its identifier: " + JSON.stringify({ source, insertion }));
            const range = item.range;
            assert.ok(range instanceof vscode.Range, "the identifier replacement must not depend on suggest insert mode");
            const start = document.offsetAt(range.start), end = document.offsetAt(range.end);
            assert.equal(original.slice(start, end).toLowerCase(), name.toLowerCase(), "replace the complete identifier, including its suffix");
            assert.ok(!original.slice(start, end).includes("("), "arguments must remain outside the edit");
            assert.equal(original.slice(end).trimStart()[0], "(");
        }
        assert.equal(document.getText(), original);
        let written = "origin.SetX (20)";
        try {
            for (const source of ["origin.SetX 20", "origin.SetX _ ' keep the argument\n    20",
                "If origin.x Then origin.SetX 20 Else origin.SetX 30"]) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, new vscode.Range(position(document, written), position(document, written, written.length)), source);
                await applyEditAndWaitForDocuments(edit, [document]);
                written = source;
                const selected = position(document, source, source.indexOf("SetX") + 2);
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, selected);
                const item = completions.items.find((candidate) => candidate.label === "SetX" &&
                    candidate.kind !== vscode.CompletionItemKind.Text);
                assert.ok(item, source);
                const insertion = typeof item.insertText === "string" ? item.insertText : item.insertText?.value;
                assert.equal(insertion, "SetX", "a bare call must not receive another argument template");
                assert.ok(item.range instanceof vscode.Range);
                assert.equal(document.getText(item.range), "SetX");
                const before = document.getText(), start = document.offsetAt(item.range.start), end = document.offsetAt(item.range.end);
                assert.equal(before.slice(0, start) + insertion + before.slice(end), before,
                    "accepting the existing name must leave its bare arguments unchanged");
            }
        } finally {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(position(document, written), position(document, written, written.length)), "origin.SetX (20)");
            await applyEditAndWaitForDocuments(edit, [document]);
        }
        assert.equal(document.getText(), original);
    });
    await check("definition and type definition follow the included header", async () => {
        const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, position(document, "origin.x", 7));
        assert.ok(definitions.some((location) => location.uri.fsPath.endsWith("types.bi")));
        const declarations = await vscode.commands.executeCommand(
            "vscode.executeDeclarationProvider", uri, position(document, "origin.SetX", 7)
        );
        assert.equal(declarations.length, 1);
        assert.ok(declarations[0].uri.fsPath.endsWith("types.bi"));
        const declarationDocument = await vscode.workspace.openTextDocument(declarations[0].uri);
        assert.match(declarationDocument.lineAt(declarations[0].range.start.line).text, /Declare Sub SetX/);
        const types = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", uri, position(document, "origin.x", 2));
        assert.ok(types.some((location) => location.uri.fsPath.endsWith("types.bi")));
        const implementations = await vscode.commands.executeCommand(
            "vscode.executeImplementationProvider", uri, position(document, "origin.SetX", 7)
        );
        assert.equal(implementations.length, 1);
        assert.equal(implementations[0].uri.toString(), uri.toString());
        assert.match(document.lineAt(implementations[0].range.start.line).text, /Sub Geometry\.Point\.SetX/);
    });
    await check("type hierarchy follows included UDT inheritance", async () => {
        const prepared = await vscode.commands.executeCommand(
            "vscode.prepareTypeHierarchy", uri, position(document, "origin", 1)
        );
        assert.equal(prepared.length, 1);
        assert.equal(prepared[0].name, "Point");
        const derived = await vscode.commands.executeCommand("vscode.provideSubtypes", prepared[0]);
        const coloredPoint = derived.find((item) => item.name === "ColoredPoint");
        assert.ok(coloredPoint, "the included derived type should appear as a direct subtype");
        const bases = await vscode.commands.executeCommand("vscode.provideSupertypes", coloredPoint);
        assert.ok(bases.some((item) => item.name === "Point"), "the direct base type should be available as a supertype");
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("Type Hierarchy reacquires native facts through closed files", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-closed-types-"));
        const headerSource = ["#ifdef ALTERNATE", "Type SelectedBase", "alternateValue As Long", "End Type", "#else",
            "Type SelectedBase", "normalValue As Long", "End Type", "#endif", ""].join("\n");
        const source = '#include "api.bi"\nType Derived Extends SelectedBase\nEnd Type\n';
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["analysis.run", "onDemand"],
                ["diagnostics.run", "off"], ["compiler.arguments", []]]) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            for (const bridge of [false, true]) {
                const backendDirectory = path.join(directory, bridge ? "bridge" : "stock");
                fs.mkdirSync(backendDirectory);
                const filePath = path.join(backendDirectory, "main.bas"), headerPath = path.join(backendDirectory, "api.bi");
                fs.writeFileSync(filePath, source);
                fs.writeFileSync(headerPath, headerSource);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{ name: "closed-types", modules: [filePath] }], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", { name: "closed-types", module: filePath }, vscode.ConfigurationTarget.Global);
                const currentUri = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand("vscode.open", currentUri, { preview: false });
                const current = vscode.workspace.textDocuments.find((opened) => opened.uri.toString() === currentUri.toString());
                assert.ok(current);
                const prepared = await vscode.commands.executeCommand("vscode.prepareTypeHierarchy", currentUri, position(current, "Derived", 1));
                assert.deepEqual(prepared.map((item) => item.name), ["Derived"]);
                await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                const deadline = Date.now() + DOCUMENT_CHANGE_TIMEOUT_MS;
                while (!current.isClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
                assert.equal(current.isClosed, true, "the type's original document must really unload");
                // Invalidate native snapshots without changing the selected
                // source branch. Expansion must analyze the reloaded file.
                await configuration.update("compiler.arguments", ["-d", "TYPE_TREE_RELOAD=1"], vscode.ConfigurationTarget.Global);
                const activeEditor = vscode.window.activeTextEditor?.document.uri.toString();
                const parents = await vscode.commands.executeCommand("vscode.provideSupertypes", prepared[0]);
                assert.deepEqual(parents.map((item) => [item.uri.fsPath, item.selectionRange.start.line]), [[headerPath, 5]],
                    `bridge=${bridge}: only the compiler-active base declaration may be selected`);
                assert.equal(vscode.workspace.textDocuments.some((opened) => opened.uri.fsPath === headerPath), false,
                    "the returned base header must not need to be loaded yet");
                const children = await vscode.commands.executeCommand("vscode.provideSubtypes", parents[0]);
                assert.deepEqual(children.map((item) => [item.name, item.uri.fsPath]), [["Derived", filePath]]);
                assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), activeEditor, "tree expansion must not show an editor");
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
                assert.equal(fs.readFileSync(headerPath, "utf8"), headerSource);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project Type Hierarchy finds closed direct subtypes in the active build", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-project-types-"));
        const header = ["Type BaseRoot", "number As Long", "End Type", "Type OtherRoot", "number As Long", "End Type",
            "Type RootAlias As BaseRoot", ""].join("\n");
        const caller = '#include "api.bi"\nType LocalChild Extends BaseRoot\nEnd Type\nDim rootValue As BaseRoot\n';
        const other = ['#include "api.bi"', "#ifdef ALTERNATE", "Type RemoteChild Extends OtherRoot", "#else",
            "Type RemoteChild Extends RootAlias", "#endif", "End Type", "Type RemoteLeaf Extends RemoteChild", "End Type", ""].join("\n");
        const sortedNames = (items) => items.map((item) => item.name).sort();
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            for (const bridge of [false, true]) {
                const backendDirectory = path.join(directory, bridge ? "bridge" : "stock");
                fs.mkdirSync(backendDirectory);
                const callerPath = path.join(backendDirectory, "caller.bas"), otherPath = path.join(backendDirectory, "other.bas");
                const headerPath = path.join(backendDirectory, "api.bi");
                for (const [file, text] of [[callerPath, caller], [otherPath, other], [headerPath, header]]) fs.writeFileSync(file, text);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{ name: "normal", modules: [callerPath, otherPath] },
                    { name: "alternate", modules: [callerPath, otherPath], arguments: ["-d", "ALTERNATE"] }], vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
                await vscode.window.showTextDocument(current);
                for (const name of ["normal", "alternate"]) {
                    await configuration.update("analysis.activeContext", { name, module: callerPath }, vscode.ConfigurationTarget.Global);
                    const prepared = await vscode.commands.executeCommand("vscode.prepareTypeHierarchy", current.uri, position(current, "rootValue", 1));
                    assert.deepEqual(sortedNames(prepared), ["BaseRoot"]);
                    const children = await vscode.commands.executeCommand("vscode.provideSubtypes", prepared[0]);
                    assert.deepEqual(sortedNames(children), name === "normal" ? ["LocalChild", "RemoteChild"] : ["LocalChild"],
                        `bridge=${bridge}, ${name}: only direct active-build children belong in this level`);
                    const implemented = await vscode.commands.executeCommand("vscode.executeImplementationProvider", current.uri,
                        position(current, "rootValue", 1));
                    const implementationKeys = (locations) => locations.map((item) => `${item.uri.fsPath}:${item.range.start.line}`).sort();
                    const expected = name === "normal" ? [`${callerPath}:1`, `${otherPath}:4`, `${otherPath}:7`] : [`${callerPath}:1`];
                    assert.deepEqual(implementationKeys(implemented), expected.sort(),
                        "Go to Implementation includes transitive types but not the root or an unrelated branch");
                    if (name === "normal") {
                        assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === otherPath), false);
                        const remote = children.find((item) => item.name === "RemoteChild");
                        assert.deepEqual([remote.uri.fsPath, remote.selectionRange.start.line, remote.selectionRange.start.character], [otherPath, 4, 5]);
                        const leaves = await vscode.commands.executeCommand("vscode.provideSubtypes", remote);
                        assert.deepEqual(sortedNames(leaves), ["RemoteLeaf"], "a closed project result must remain expandable");
                    }
                    const included = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
                    if (name === "normal") {
                        const aliasImplementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", included.uri,
                            new vscode.Position(6, 6));
                        assert.deepEqual(implementationKeys(aliasImplementations), expected.sort(),
                            "an alias origin follows the actual native root across modules");
                    }
                    const unrelated = await vscode.commands.executeCommand("vscode.prepareTypeHierarchy", included.uri, new vscode.Position(3, 6));
                    const unrelatedChildren = await vscode.commands.executeCommand("vscode.provideSubtypes", unrelated[0]);
                    assert.deepEqual(sortedNames(unrelatedChildren), name === "alternate" ? ["RemoteChild"] : []);
                }
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                const localImplementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", current.uri,
                    position(current, "rootValue", 1));
                assert.deepEqual(localImplementations.map((item) => [item.uri.fsPath, item.range.start.line]), [[callerPath, 1]],
                    "without project contexts, type implementations remain in the current native snapshot");
                assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), current.uri.toString());
                assert.equal(current.isDirty, false);
                for (const [file, text] of [[callerPath, caller], [otherPath, other], [headerPath, header]]) assert.equal(fs.readFileSync(file, "utf8"), text);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    for (const bridge of [false, true]) if (process.env.FBC_INTEGER128_EXECUTABLE && (!bridge || process.env.FBC_EDITOR_EXECUTABLE)) {
        await check(`${bridge ? "current bridge" : "current FBC"} 128-bit types retain native layout and source-valid refactors`, async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.path", "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-native-integer128-"));
            const sourcePath = path.join(directory, "main.bas");
            const source = ["Type Integer128", "    memberValue As Long", "End Type", "Dim ordinaryValue As Integer128",
                "Dim signedWide As Integer<128> = 1", "Dim unsignedWide As UInteger<128> = 1",
                "Var inferredWide = signedWide + 1", "Var inferredUnsignedWide = unsignedWide + 1",
                "Var inferredOrdinary = ordinaryValue", "Var copiedOrdinary = inferredOrdinary",
                "Dim callback As Function(ByVal As Integer<128>) As UInteger<128>", "Var inferredCallback = callback",
                "Print SizeOf(inferredWide), SizeOf(inferredUnsignedWide), ordinaryValue.memberValue", ""].join("\n");
            try {
                fs.writeFileSync(sourcePath, bridge ? "' saved baseline\n" : source);
                for (const [name, value] of [["analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : ""],
                    ["compiler.path", process.env.FBC_INTEGER128_EXECUTABLE],
                    ["compiler.arguments", []], ["analysis.projectContexts", []], ["analysis.activeContext", null],
                    ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                    await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                }
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(current);
                if (bridge) {
                    const overlay = new vscode.WorkspaceEdit();
                    overlay.replace(current.uri, new vscode.Range(0, 0, current.lineCount - 1, 0), source);
                    await applyEditAndWaitForDocuments(overlay, [current]);
                    assert.equal(current.isDirty, true, "the new bridge must type unsaved 128-bit declarations");
                    assert.equal(fs.readFileSync(sourcePath, "utf8"), "' saved baseline\n");
                }
                for (const [name, typeName] of [["inferredWide", "Integer<128>"], ["inferredUnsignedWide", "UInteger<128>"]]) {
                    const selected = position(current, name, 1);
                    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri, selected);
                    const markdown = hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                    assert.ok(markdown.toLowerCase().includes(typeName.toLowerCase()),
                        "native inferred hover must retain a source-valid 128-bit spelling: " + markdown);
                    assert.match(markdown, /16 bytes/i, "the current compiler must supply the native 128-bit layout");
                    const hints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri,
                        new vscode.Range(selected.line, 0, selected.line, current.lineAt(selected.line).text.length));
                    assert.ok(hints.some((hint) => (typeof hint.label === "string" ? hint.label
                        : hint.label.map((part) => part.value).join("")).toLowerCase() === `: ${typeName}`.toLowerCase()),
                    "native inferred hints must use the source-valid primitive spelling: " + JSON.stringify(hints));
                    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", current.uri,
                        new vscode.Range(selected, selected), vscode.CodeActionKind.RefactorRewrite.value);
                    const action = actions.find((candidate) => candidate.title.toLowerCase() ===
                        `Make inferred Var type explicit as '${typeName}'`.toLowerCase());
                    assert.ok(action?.edit, `${name} must support an explicit declaration (version ${current.version}, dirty ${current.isDirty}): ` +
                        JSON.stringify(actions));
                    assert.ok(action.edit.get(current.uri).some((edit) => edit.newText.toLowerCase() === ` As ${typeName}`.toLowerCase()));
                    await applyEditAndWaitForDocuments(action.edit, [current]);
                    assert.ok(await current.save());
                    assert.match(current.lineAt(selected.line).text, new RegExp(`^Dim ${name} As U?Integer<128> =`, "i"));
                }
                const definitions = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", current.uri,
                    position(current, "ordinaryValue.memberValue", 1));
                assert.deepEqual(definitions.map((item) => [item.uri.fsPath, item.range.start.line]), [[sourcePath, 0]],
                    "a user type named Integer128 must remain distinct from the primitive spelling Integer<128>");
                if (bridge) {
                    for (const [name, expected, relative = 1] of [["inferredOrdinary", /Compiler-selected variable type: `INTEGER128`/i],
                        ["inferredCallback", /Compiler-selected variable type: `function\(as integer<128>\) as uinteger<128>`/i],
                        ["copiedOrdinary = inferredOrdinary", /Compiler-selected variable type: `INTEGER128`/i,
                            "copiedOrdinary = ".length + 1]]) {
                        const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                            position(current, name, relative));
                        const markdown = hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                        assert.match(markdown, expected, `native VAR hover for ${name} must retain its inferred type: ${markdown}`);
                    }
                }
                const checkResult = await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(checkResult.exitCode, 0, "the current compiler must accept both generated explicit declarations");
            } finally {
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
    }
    if (process.env.FBC_EXECUTABLE) await check("stock FBC inferred pointer refactors preserve native const qualifiers", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-native-pointer-const-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = ["Dim pointee As Long = 1", "Dim constPointee As Const Long Ptr = @pointee",
            "Dim fixedPointer As Long Const Ptr = @pointee", "Var inferredConstPointer = constPointee",
            "Var inferredNestedPointer = @fixedPointer", "Print *inferredConstPointer, **inferredNestedPointer", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            for (const [name, value] of [["analysis.compilerPath", ""], ["compiler.path", process.env.FBC_EXECUTABLE],
                ["compiler.arguments", []], ["analysis.projectContexts", []], ["analysis.activeContext", null],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            for (const [name, typeName] of [["inferredConstPointer", "Const Long Ptr"],
                ["inferredNestedPointer", "Long Const Ptr Ptr"]]) {
                const selected = position(current, name, 1);
                const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", current.uri,
                    new vscode.Range(selected, selected), vscode.CodeActionKind.RefactorRewrite.value);
                const action = actions.find((candidate) => candidate.title === `Make inferred Var type explicit as '${typeName}'`);
                assert.ok(action?.edit, "pointer refactors must retain pointee and nested pointer constness: " + JSON.stringify(actions));
                assert.ok(action.edit.get(current.uri).some((edit) => edit.newText === ` As ${typeName}`));
                await applyEditAndWaitForDocuments(action.edit, [current]);
                assert.ok(await current.save());
                assert.equal(current.lineAt(selected.line).text,
                    `Dim ${name} As ${typeName} = ${name === "inferredConstPointer" ? "constPointee" : "@fixedPointer"}`);
            }
            const checkResult = await vscode.commands.executeCommand("freebasic.checkSyntax");
            assert.equal(checkResult.exitCode, 0, "the real compiler must accept both qualifier-preserving edits");
            // Writing through either guarded level must still be rejected
            // after the editor rewrite, not merely remain syntactically valid.
            const invalidEdit = new vscode.WorkspaceEdit();
            invalidEdit.insert(current.uri, new vscode.Position(current.lineCount - 1, 0),
                "*inferredConstPointer = 2\n*inferredNestedPointer = @pointee\n");
            await applyEditAndWaitForDocuments(invalidEdit, [current]);
            assert.ok(await current.save());
            const invalidResult = await vscode.commands.executeCommand("freebasic.checkSyntax");
            assert.notEqual(invalidResult.exitCode, 0, "explicit types must preserve the compiler's const-write restrictions");
            const constErrors = vscode.languages.getDiagnostics(current.uri).filter((diagnostic) =>
                diagnostic.severity === vscode.DiagnosticSeverity.Error && /const|constant/i.test(diagnostic.message));
            assert.equal(new Set(constErrors.map((diagnostic) => diagnostic.range.start.line)).size, 2,
                "FBC must reject writes at both the pointee and intermediate pointer level");
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("stock FBC native declaration refactors preserve compiler-selected values and modes", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-native-declaration-refactors-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = ["Enum EditorCodes", "    PriorCode = 7", "    NextCode", "End Enum",
            "Declare Sub ModeProbe(value As Long)", "Declare Sub ContinuedProbe( _", "    continuedValue As Long)",
            "Function ImplicitResult()", "    Return 1", "End Function", "Print NextCode, ImplicitResult()", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            for (const [name, value] of [["analysis.compilerPath", ""], ["compiler.path", process.env.FBC_EXECUTABLE],
                ["compiler.arguments", ["-lang", "deprecated"]], ["analysis.projectContexts", []], ["analysis.activeContext", null],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            for (const [needle, relative, title, expected] of [
                ["NextCode", 1, "Make enum value explicit as 8", "    NextCode = 8"],
                ["ModeProbe(value", "ModeProbe(".length + 1, "Make parameter passing mode explicit as 'ByRef'",
                    "Declare Sub ModeProbe(ByRef value As Long)"],
                ["continuedValue", 1, "Make parameter passing mode explicit as 'ByRef'", "    ByRef continuedValue As Long)"],
                ["ImplicitResult", 1, "Add explicit return type 'Integer'", "Function ImplicitResult() As Integer"]
            ]) {
                const selected = position(current, needle, relative);
                const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", current.uri,
                    new vscode.Range(selected, selected));
                const action = actions.find((candidate) => candidate.title === title);
                assert.ok(action?.edit, `${title} must use the current native declaration: ` + JSON.stringify(actions));
                await applyEditAndWaitForDocuments(action.edit, [current]);
                assert.ok(await current.save());
                assert.equal(current.lineAt(selected.line).text, expected);
            }
            const checkResult = await vscode.commands.executeCommand("freebasic.checkSyntax");
            assert.equal(checkResult.exitCode, 0, "the actual compiler must accept all four explicit declarations");
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("current-source compiler preserves contextual THREAD and TLS storage", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-contextual-thread-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/contextual-thread.bas"), "utf8");
        try {
            fs.writeFileSync(sourcePath, source);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri, position(current, "perThread", 1));
                const markdown = hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(markdown, /Compiler-selected storage class: `thread-local`/, bridge ? "bridge TLS" : "stock TLS");
                for (const [spelling, relative, declarationLine] of [["holder.Thread", "holder.".length + 1, 8],
                    ["LocalNames.Thread", "LocalNames.".length + 1, 14]]) {
                    const targets = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", current.uri,
                        position(current, spelling, relative));
                    assert.equal(targets.length, 1, spelling);
                    assert.equal(targets[0].range.start.line, declarationLine, "THREAD names retain their distinct native owners");
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("native method Signature Help follows compound receivers", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-compound-method-signature-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/compound-method-signatures.bas"), "utf8");
        let current;
        try {
            fs.writeFileSync(sourcePath, source);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            // Request completion before Signature Help so signature-specific
            // enrichment cannot hide missing recovery metadata.
            for (const [statement, expected] of [["With services(0)\n    .Mea", "Measure"],
                ["With services(0)\n    .", "value"], ["With services(0)\n    .Hid", null], [".Mea", false]]) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), source + statement);
                await applyEditAndWaitForDocuments(edit, [current]);
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                    current.positionAt(current.getText().length));
                // VS Code also supplies plain word suggestions. Only declared
                // methods/fields can prove native member assistance here.
                const members = completions.items.filter((item) => [vscode.CompletionItemKind.Method, vscode.CompletionItemKind.Function,
                    vscode.CompletionItemKind.Field, vscode.CompletionItemKind.Variable, vscode.CompletionItemKind.Property].includes(item.kind));
                const labels = members.map((item) => typeof item.label === "string" ? item.label : item.label.label);
                if (expected) assert.ok(labels.includes(expected), `unclosed WITH completion: ${statement}`);
                if (expected === false) assert.ok(!labels.includes("Measure"), "a dot outside WITH cannot borrow the previous receiver");
                assert.ok(!labels.includes("HiddenMethod"), "unclosed scopes do not certify private caller access");
            }
            await vscode.commands.executeCommand("workbench.action.files.revert");
            assert.equal(current.isDirty, false);
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const [call, type, count] of [["MakeServicePointer()->Measure(CDbl(1), 2)", "Double", 2],
                    ["MakeService().Measure(CLng(1), 2)", "Long", 2], ["MakeService().Measure(CDbl(1), 2)", "Double", 2],
                    ["services(0).Measure(CLng(1), 2)", "Long", 2], ["(*servicePointer).Measure(CDbl(1), 2)", "Double", 2],
                    ["MakeService().Item(CDbl(1))", "Double", 2], ["MakeService().Apply(1, 2)", "Long", 1],
                    ["MakeService().Measure CLng(1), 2", "Long", 2], ["MakeServicePointer()->Apply 1, 2", "Long", 1],
                    ["    .Measure CLng(1), 2", "Long", 2], ["    .Measure CDbl(1), 2", "Double", 2]]) {
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, call, call.endsWith(")") ? call.length - 1 : call.length));
                    assert.equal(help?.signatures.length, count, `${bridge ? "bridge" : "stock"}: ${call}`);
                    assert.match(help.signatures[help.activeSignature].label, new RegExp(`(?:amount|index) As ${type}\\b`, "i"));
                    assert.ok(help.signatures.every((signature) => !/amount As String/i.test(signature.label)));
                    if (call.includes(".Item")) assert.ok(help.signatures.every((signature) => signature.parameters.length === 1));
                }
            }
            for (const [statement, count] of [["Print MakeService().Measure(1,", 2], ["Print MakeService().HiddenMethod(", 0],
                ["With services(0)\n    .Apply 1,", 1], [".Apply 1,", 0]]) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), source + statement);
                await applyEditAndWaitForDocuments(edit, [current]);
                const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                    current.positionAt(current.getText().length));
                assert.equal(help?.signatures.length || 0, count, statement);
            }
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            if (current?.isDirty) {
                await vscode.window.showTextDocument(current);
                await vscode.commands.executeCommand("workbench.action.files.revert");
            }
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("sized integer casts retain their own Signature Help", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-sized-cast-signature-"));
        const sourcePath = path.join(directory, "main.bas");
        // Older compatibility fixtures support the same syntax without 128-bit widths.
        const unsignedWidth = process.env.FBC_INTEGER128_EXECUTABLE ? 128 : 32;
        const source = ["Type ConvertedValue", "    value As Short", "    Declare Operator Cast() As Short", "End Type",
            "Operator ConvertedValue.Cast() As Short", "    Return this.value", "End Operator",
            "Declare Function Scale(ByVal amount As Short) As Long", "Dim item As ConvertedValue",
            "Dim small As Short = CInt<16>(item)", `Dim wide As UInteger<${unsignedWidth}> = CUInt<${unsignedWidth}>(1)`,
            "Print Scale(CInt<(8 Shl 1)>(1))", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            for (const [name, value] of [["compiler.arguments", []], ["analysis.projectContexts", []],
                ["analysis.activeContext", null], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            for (const backend of ["source", "stock", "bridge"]) {
                await configuration.update("compiler.path", backend === "source" ? "/__freebasic_test__/missing-fbc" : process.env.FBC_EXECUTABLE,
                    vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "",
                    vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", backend === "source" ? "off" : "onDemand", vscode.ConfigurationTarget.Global);
                for (const spelling of ["CInt<16>(item)", `CUInt<${unsignedWidth}>(1)`, "CInt<(8 Shl 1)>(1)"]) {
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, spelling, spelling.lastIndexOf(">(") + 2));
                    assert.equal(help?.signatures.length, 1, `${backend}: ${spelling}`);
                    assert.match(help.signatures[0].label, /\bcu?int<bits>/i);
                    assert.equal(help.signatures[0].parameters.length, 1);
                    assert.equal(help.activeParameter, 0);
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            const statement = "Print Scale(CInt<32>(";
            const edit = new vscode.WorkspaceEdit();
            edit.insert(current.uri, current.positionAt(current.getText().length), statement);
            await applyEditAndWaitForDocuments(edit, [current]);
            const incomplete = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                position(current, statement, statement.length));
            assert.equal(incomplete?.signatures.length, 1, "the unfinished cast must not borrow Scale's signature");
            assert.match(incomplete.signatures[0].label, /\bcint<bits>/i);
            assert.equal(current.isDirty, true);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("parameter hovers distinguish direct assignments from indirect effects", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-parameter-write-hover-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = ["Type ParameterRecord", "    fieldValue As Long", "End Type",
            "Sub AssignIndirect(ByRef destination As Long)", "    destination = 5", "End Sub",
            "Declare Sub ExternalWrites(ByRef externalValue As Long)",
            "Sub ReviewWrites(ByRef changed As Long, ByVal localCopy As Long, ByRef inputOnly As Long, " +
                "ByVal pointerValue As Long Ptr, ByRef recordValue As ParameterRecord, ByRef indirectOnly As Long)",
            "    changed += 1", "    localCopy = 2", "    Print inputOnly", "    *pointerValue = 3",
            "    recordValue.fieldValue = 4", "    AssignIndirect(indirectOnly)", "End Sub", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const name of ["changed", "localCopy", "inputOnly", "pointerValue", "recordValue", "indirectOnly", "externalValue"]) {
                    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri, position(current, name, 1));
                    const markdown = hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                    assert.match(markdown, /Compiler-selected parameter passing:/);
                    assert.equal(/routine body contains a direct source assignment to this parameter value/.test(markdown),
                        ["changed", "localCopy"].includes(name), `${bridge ? "bridge" : "stock"}: ${name}: ${markdown}`);
                    assert.doesNotMatch(markdown, /parameter is read.only|parameter is unused|pure routine/i);
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("parameter-name preference preserves native type hints on both backends", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run", "inlayHints.parameterNames.enabled"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-parameter-hint-preference-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = "Declare Function Scale(ByVal amount As Long) As Long\nVar inferred = 1\nPrint Scale(inferred)\n";
        try {
            fs.writeFileSync(sourcePath, source);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const enabled of [true, false, true]) {
                    await configuration.update("inlayHints.parameterNames.enabled", enabled, vscode.ConfigurationTarget.Global);
                    const hints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri,
                        new vscode.Range(0, 0, current.lineCount - 1, 0));
                    assert.ok(hints.some((hint) => hint.kind === vscode.InlayHintKind.Type),
                        "turning off parameter names must retain compiler-selected inferred types");
                    const parameters = hints.filter((hint) => hint.kind === vscode.InlayHintKind.Parameter);
                    assert.equal(parameters.length, enabled ? 1 : 0, `${bridge ? "bridge" : "stock"}: parameter names ${enabled}`);
                    if (enabled) assert.equal(typeof parameters[0].label === "string" ? parameters[0].label
                        : parameters[0].label.map((part) => part.value).join(""), "amount:");
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("stock FBC type navigation follows inferred and TYPEOF-derived variables", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-inferred-type-hierarchy-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = ["Type HierarchyBase", "    number As Long", "End Type", "Type HierarchyDerived Extends HierarchyBase",
            "End Type", "Function MakeHierarchyValue() As HierarchyDerived", "    Dim result As HierarchyDerived",
            "    Return result", "End Function", "Var fromVar = MakeHierarchyValue()",
            "Dim fromTypeOf As Typeof(MakeHierarchyValue())", "Type SelectedHierarchyAlias As Typeof(MakeHierarchyValue())",
            "Dim fromAlias As SelectedHierarchyAlias", "Print fromVar.number, fromTypeOf.number, fromAlias.number", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            // Populate the source index as normal Outline/editor activity does.
            await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", current.uri);
            const requests = [["Print fromVar.number", "Print f".length], ["fromTypeOf.number", 1], ["fromAlias.number", 1]];
            for (const [requestIndex, [text, relative]] of requests.entries()) {
                // Retire the prior native snapshot without changing the text.
                // Each request must still resolve the inferred physical type.
                await configuration.update("compiler.arguments", ["-d", `TYPE_NAV_CONTEXT=${requestIndex}`], vscode.ConfigurationTarget.Global);
                const definitions = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", current.uri,
                    position(current, text, relative));
                assert.deepEqual(definitions.map((item) => [item.uri.fsPath, item.range.start.line]), [[sourcePath, 3]],
                    `${text} must navigate to the compiler-selected physical type declaration`);
                const prepared = await vscode.commands.executeCommand("vscode.prepareTypeHierarchy", current.uri,
                    position(current, text, relative));
                assert.deepEqual(prepared.map((item) => item.name), ["HierarchyDerived"],
                    `${text} must use FBC's inferred subtype rather than treating unresolved source typing as primitive`);
                const parents = await vscode.commands.executeCommand("vscode.provideSupertypes", prepared[0]);
                assert.deepEqual(parents.map((item) => item.name), ["HierarchyBase"]);
                const children = await vscode.commands.executeCommand("vscode.provideSubtypes", parents[0]);
                assert.deepEqual(children.map((item) => item.name), ["HierarchyDerived"]);
                assert.equal(prepared[0].uri.fsPath, sourcePath);
                assert.equal(prepared[0].selectionRange.start.line, 3);
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("stock FBC member completion follows active conditional types", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-conditional-member-completion-"));
        const sourcePath = path.join(directory, "main.bas");
        const header = ["#ifdef PRIMARY_BUILD", "Type MemberParent", "    inheritedPrimary As Long", "End Type",
            "#else", "Type MemberParent", "    inheritedSecondary As Long", "End Type", "#endif", ""].join("\n");
        const source = ['#include "parents.bi"', "#ifdef PRIMARY_BUILD",
            "Type ConditionalReceiver Extends MemberParent", "    primaryField As Long", "#ifdef EXTRA_MEMBER",
            "    extraField As Long", "#else", "    inactiveField As Long", "#endif", "Private:", "    hiddenField As Long", "End Type", "#else",
            "Type ConditionalReceiver Extends MemberParent", "    secondaryField As Long", "End Type", "#endif",
            "Type StableReceiver", "#ifdef EXTRA_MEMBER", "    includedValue As Long", "#else", "    otherValue As Long", "#endif", "End Type",
            "Function MakeConditionalValue() As ConditionalReceiver", "    Dim result As ConditionalReceiver", "    Return result",
            "End Function", "Var factoryValue = MakeConditionalValue()", "Dim typeofValue As Typeof(MakeConditionalValue())",
            "Type ReceiverAlias As Typeof(MakeConditionalValue())", "Dim aliasValue As ReceiverAlias", "Dim stableValue As StableReceiver",
            "#ifdef PRIMARY_BUILD", "Print factoryValue.primaryField, typeofValue.primaryField, aliasValue.primaryField",
            "Print stableValue.includedValue", "#else", "Print factoryValue.secondaryField, typeofValue.secondaryField, aliasValue.secondaryField",
            "Print stableValue.otherValue", "#endif", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            fs.writeFileSync(path.join(directory, "parents.bi"), header);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", current.uri);
            for (const [arguments_, field, expected, stableField] of [
                [["-d", "PRIMARY_BUILD", "-d", "EXTRA_MEMBER"], "primaryField", ["extraField", "inheritedPrimary", "primaryField"], "includedValue"],
                [[], "secondaryField", ["inheritedSecondary", "secondaryField"], "otherValue"]
            ]) {
                await configuration.update("compiler.arguments", arguments_, vscode.ConfigurationTarget.Global);
                for (const receiver of ["factoryValue", "typeofValue", "aliasValue", "stableValue"]) {
                    const member = receiver === "stableValue" ? stableField : field;
                    const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                        position(current, `${receiver}.${member}`, receiver.length + 1));
                    // Older VS Code APIs include contributed snippets even at a
                    // member-access site. Compare the language provider's items.
                    const labels = completions.items.filter((item) => item.kind !== vscode.CompletionItemKind.Snippet)
                        .map((item) => typeof item.label === "string" ? item.label : item.label.label);
                    assert.deepEqual(labels.sort(), receiver === "stableValue" ? [stableField] : expected,
                        `${receiver}: completion must follow the selected type/base chain and exclude inactive or private members; received ${JSON.stringify(labels)}`);
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            assert.equal(fs.readFileSync(path.join(directory, "parents.bi"), "utf8"), header);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("stock guarded operators use native prototypes and bodies", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-guarded-indexers-"));
        const headerPath = path.join(directory, "indexed.bi"), sourcePath = path.join(directory, "main.bas");
        const header = ["#ifndef GUARDED_INDEXERS_BI", "#define GUARDED_INDEXERS_BI", "Type IndexNumber As Double", "Type GuardedIndexer",
            "    value As Long",
            "#ifdef INACTIVE_BUILD", "    Declare Operator [](ByVal inactiveIndex As Double) As Long", "#else",
            "    Declare Operator [](ByVal activeIndex As Double) As Long", "#endif",
            "    Declare Operator [](ByVal longIndex As Long) As Long",
            "    Declare Operator [](ByVal externalIndex As Single) As Long", "End Type",
            "Declare Operator +(ByRef value As GuardedIndexer, ByVal amount As Long) As Long",
            "#ifdef INACTIVE_BUILD", "Declare Operator +(ByRef value As GuardedIndexer, ByVal inactiveAmount As Double) As Long",
            "#else", "Declare Operator +(ByRef value As GuardedIndexer, ByVal amount As Double) As Long", "#endif",
            "Declare Operator +(ByRef value As GuardedIndexer, ByVal externalAmount As Single) As Long",
            "Operator GuardedIndexer.[](ByVal activeIndex As IndexNumber) As Long", "    Return CLng(activeIndex)", "End Operator",
            "Operator GuardedIndexer.[](ByVal longIndex As Long) As Long", "    Return longIndex", "End Operator",
            "Operator +(ByRef value As GuardedIndexer, ByVal amount As Long) As Long", "    Return amount", "End Operator",
            "Operator +(ByRef value As GuardedIndexer, ByVal amount As Double) As Long", "    Return CLng(amount)", "End Operator",
            "#endif", ""].join("\n");
        try {
            fs.writeFileSync(headerPath, header);
            fs.writeFileSync(sourcePath, '#include "indexed.bi"\nDim item As GuardedIndexer\nPrint item[CDbl(1)]\nPrint item[CLng(2)]\n' +
                "Print item + CLng(3)\nPrint item + CDbl(4)\nPrint item[CDbl(5)]\nPrint item + CDbl(6)\n" +
                "Print item[CSng(7)]\nPrint item + CSng(8)\nPrint item + CSng(9)\n");
            for (const [name, value] of [["analysis.compilerPath", ""], ["compiler.path", process.env.FBC_EXECUTABLE],
                ["compiler.arguments", []], ["analysis.projectContexts", [{ name: "guarded-operators", modules: [sourcePath] }]],
                ["analysis.activeContext", { name: "guarded-operators", module: sourcePath }],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            const included = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
            await vscode.window.showTextDocument(current);
            for (const [call, parameter, type] of [["item[CDbl(1)]", "activeIndex", "Double"], ["item[CLng(2)]", "longIndex", "Long"]]) {
                const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                    position(current, call, "item[".length + 1));
                assert.ok(help?.signatures.some((signature) => /As Double\)/i.test(signature.label)));
                assert.ok(help.signatures.some((signature) => /As Long\)/i.test(signature.label)));
                assert.match(help.signatures[help.activeSignature].label, new RegExp("ByVal " + parameter + " As " + type, "i"));
                const closing = position(current, call, call.length - 1);
                for (const [command, needle] of [["vscode.executeDeclarationProvider", "Declare Operator [](ByVal " + parameter],
                    ["vscode.executeDefinitionProvider", "Operator GuardedIndexer.[](ByVal " + parameter],
                    ["vscode.executeImplementationProvider", "Operator GuardedIndexer.[](ByVal " + parameter]]) {
                    const targets = await vscode.commands.executeCommand(command, current.uri, closing);
                    assert.equal(targets.length, 1, command);
                    assert.equal(targets[0].uri.fsPath, headerPath);
                    assert.equal(targets[0].range.start.line, position(included, needle).line, command);
                }
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri, closing);
                const contents = hovers.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n");
                assert.match(contents, new RegExp("ByVal " + parameter + " As " + type, "i"));
                assert.doesNotMatch(contents, /inactiveIndex/i);
                const expected = [position(current, call).line];
                if (type === "Double") expected.push(position(current, "item[CDbl(5)]").line);
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri, closing);
                const referenceLines = [...new Set(references.filter((entry) => entry.uri.fsPath === sourcePath)
                    .map((entry) => entry.range.start.line))].sort((a, b) => a - b);
                assert.deepEqual(referenceLines, expected, "indexer references must use the selected native symbol, not the shared return type");
                assert.ok(references.filter((entry) => entry.uri.fsPath === headerPath)
                    .every((entry) => !/inactiveIndex/i.test(included.lineAt(entry.range.start.line).text)));
                const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", current.uri, closing);
                assert.deepEqual([...new Set(highlights.map((entry) => entry.range.start.line))].sort((a, b) => a - b), expected);
                const prototype = position(included, "Declare Operator [](ByVal " + parameter, "Declare Operator [".length);
                const body = position(included, "Operator GuardedIndexer.[](ByVal " + parameter, "Operator GuardedIndexer.[".length);
                for (const origin of [prototype, body]) {
                    const fromDeclaration = await vscode.commands.executeCommand("vscode.executeReferenceProvider", included.uri, origin);
                    assert.deepEqual([...new Set(fromDeclaration.filter((entry) => entry.uri.fsPath === sourcePath)
                        .map((entry) => entry.range.start.line))].sort((a, b) => a - b), expected);
                    const selected = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", included.uri, origin);
                    assert.deepEqual([...new Set(selected.map((entry) => entry.range.start.line))].sort((a, b) => a - b),
                        [prototype.line, body.line].sort((a, b) => a - b));
                    for (const [command, expected] of [["vscode.executeDeclarationProvider", prototype.line],
                        ["vscode.executeDefinitionProvider", body.line], ["vscode.executeImplementationProvider", body.line]]) {
                        const targets = await vscode.commands.executeCommand(command, included.uri, origin);
                        assert.deepEqual(targets.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[headerPath, expected]]);
                    }
                }
                for (const [uri, origin] of [[current.uri, closing], [included.uri, prototype], [included.uri, body]]) {
                    const items = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", uri, origin);
                    assert.equal(items.length, 1, `index hierarchy ${type} at ${uri.fsPath}:${origin.line}:${origin.character}`);
                    const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", items[0]);
                    const module = incoming.find((call) => call.from.detail === "Module-level calls" && call.from.uri.fsPath === sourcePath);
                    assert.deepEqual(module?.fromRanges.map((range) => range.start.line).sort((a, b) => a - b), expected);
                }
            }
            for (const [call, type] of [["item + CLng(3)", "Long"], ["item + CDbl(4)", "Double"]]) {
                const operator = position(current, call, "item ".length);
                for (const command of ["vscode.executeDeclarationProvider", "vscode.executeDefinitionProvider",
                    "vscode.executeImplementationProvider"]) {
                    const targets = await vscode.commands.executeCommand(command, current.uri, operator);
                    assert.equal(targets.length, 1, command);
                    assert.equal(targets[0].uri.fsPath, headerPath);
                    const selected = included.lineAt(targets[0].range.start.line).text.trim();
                    assert.match(selected, command === "vscode.executeDeclarationProvider" ? /^Declare Operator/i : /^Operator/i,
                        "declaration navigation must select a prototype, not its guarded body");
                    assert.match(selected, new RegExp("ByVal amount As " + type, "i"));
                }
                const expected = [position(current, call).line];
                if (type === "Double") expected.push(position(current, "item + CDbl(6)").line);
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri, operator);
                assert.deepEqual([...new Set(references.filter((entry) => entry.uri.fsPath === sourcePath)
                    .map((entry) => entry.range.start.line))].sort((a, b) => a - b), expected);
                assert.ok(references.filter((entry) => entry.uri.fsPath === headerPath)
                    .every((entry) => !/inactiveAmount/i.test(included.lineAt(entry.range.start.line).text)));
                const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", current.uri, operator);
                assert.deepEqual([...new Set(highlights.map((entry) => entry.range.start.line))].sort((a, b) => a - b), expected);
                const prototype = position(included,
                    "Declare Operator +(ByRef value As GuardedIndexer, ByVal amount As " + type, "Declare Operator ".length);
                const body = position(included,
                    "\nOperator +(ByRef value As GuardedIndexer, ByVal amount As " + type, "\nOperator ".length);
                for (const origin of [prototype, body]) {
                    const fromDeclaration = await vscode.commands.executeCommand("vscode.executeReferenceProvider", included.uri, origin);
                    assert.deepEqual([...new Set(fromDeclaration.filter((entry) => entry.uri.fsPath === sourcePath)
                        .map((entry) => entry.range.start.line))].sort((a, b) => a - b), expected);
                    const selected = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", included.uri, origin);
                    assert.deepEqual([...new Set(selected.map((entry) => entry.range.start.line))].sort((a, b) => a - b),
                        [prototype.line, body.line].sort((a, b) => a - b));
                    for (const [command, expected] of [["vscode.executeDeclarationProvider", prototype.line],
                        ["vscode.executeDefinitionProvider", body.line], ["vscode.executeImplementationProvider", body.line]]) {
                        const targets = await vscode.commands.executeCommand(command, included.uri, origin);
                        assert.deepEqual(targets.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[headerPath, expected]]);
                    }
                }
                for (const [uri, origin] of [[current.uri, operator], [included.uri, prototype], [included.uri, body]]) {
                    const items = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", uri, origin);
                    assert.equal(items.length, 1);
                    const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", items[0]);
                    const module = incoming.find((call) => call.from.detail === "Module-level calls" && call.from.uri.fsPath === sourcePath);
                    assert.deepEqual(module?.fromRanges.map((range) => range.start.line).sort((a, b) => a - b), expected);
                }
            }
            for (const needle of ["Declare Operator [](ByVal inactiveIndex", "Declare Operator +(ByRef value As GuardedIndexer, ByVal inactiveAmount"]) {
                const inactive = position(included, needle, "Declare Operator ".length);
                assert.deepEqual(await vscode.commands.executeCommand("vscode.executeReferenceProvider", included.uri, inactive), []);
                // VS Code can represent an empty highlight result as undefined.
                assert.deepEqual((await vscode.commands.executeCommand("vscode.executeDocumentHighlights", included.uri, inactive)) ?? [], []);
                for (const command of ["vscode.executeDeclarationProvider", "vscode.executeDefinitionProvider", "vscode.executeImplementationProvider"]) {
                    assert.deepEqual((await vscode.commands.executeCommand(command, included.uri, inactive)) ?? [], []);
                }
            }
            for (const needle of ["Declare Operator [](ByVal externalIndex", "Declare Operator +(ByRef value As GuardedIndexer, ByVal externalAmount"]) {
                const external = position(included, needle, "Declare Operator ".length);
                for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider"]) {
                    const targets = await vscode.commands.executeCommand(command, included.uri, external);
                    assert.deepEqual(targets.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[headerPath, external.line]]);
                }
                assert.deepEqual((await vscode.commands.executeCommand("vscode.executeImplementationProvider", included.uri, external)) ?? [], []);
            }
            for (const [call, parameter, declaration, indexed] of [
                ["item[CSng(7)]", "externalIndex", "Declare Operator [](ByVal externalIndex", true],
                ["item + CSng(8)", "externalAmount", "Declare Operator +(ByRef value As GuardedIndexer, ByVal externalAmount", false]
            ]) {
                const selected = position(current, call, indexed ? call.length - 1 : "item ".length);
                const prototype = position(included, declaration, "Declare Operator ".length);
                for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider"]) {
                    const targets = await vscode.commands.executeCommand(command, current.uri, selected);
                    assert.deepEqual(targets.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[headerPath, prototype.line]]);
                }
                assert.deepEqual((await vscode.commands.executeCommand("vscode.executeImplementationProvider", current.uri, selected)) ?? [], []);
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri, selected);
                assert.match(hovers.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n"),
                    new RegExp("ByVal " + parameter + " As Single", "i"));
                const expected = [position(current, call).line];
                if (!indexed) expected.push(position(current, "item + CSng(9)").line);
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri, selected);
                assert.deepEqual([...new Set(references.filter((entry) => entry.uri.fsPath === sourcePath)
                    .map((entry) => entry.range.start.line))].sort((a, b) => a - b), expected);
                const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", current.uri, selected);
                assert.deepEqual([...new Set(highlights.map((entry) => entry.range.start.line))].sort((a, b) => a - b), expected);
                const items = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, selected);
                assert.equal(items.length, 1);
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", items[0]);
                const module = incoming.find((call) => call.from.detail === "Module-level calls" && call.from.uri.fsPath === sourcePath);
                assert.deepEqual(module?.fromRanges.map((range) => range.start.line).sort((a, b) => a - b), expected);
            }
            assert.equal(fs.readFileSync(headerPath, "utf8"), header);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("cached stock FBC qualifiers mark readonly values without freezing const pointees", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-readonly-tokens-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = ["Type QualifierMarker", "    number As Long", "End Type", "Dim writableValue As Long = 1",
            "Dim immutableValue As Const Long = 2", "Dim pointerToConst As Const Long Ptr = @immutableValue",
            "Dim fixedPointer As Long Const Ptr = @writableValue", "Print immutableValue, *pointerToConst, *fixedPointer",
            "pointerToConst = @immutableValue", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            // An explicit hierarchy request prepares bindings. Token coloring
            // then consumes that cached model without requesting new analysis.
            const prepared = await vscode.commands.executeCommand("vscode.prepareTypeHierarchy", current.uri,
                position(current, "Type QualifierMarker", "Type Q".length));
            assert.equal(prepared.length, 1);
            const tokens = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", current.uri);
            assert.ok(tokens?.data.length);
            const { TOKEN_MODIFIERS } = require(path.join(extension.extensionPath, "lib/semantic-token-data"));
            const readonlyBit = 1 << TOKEN_MODIFIERS.indexOf("readonly");
            const records = [];
            let line = 0, character = 0;
            for (let index = 0; index < tokens.data.length; index += 5) {
                line += tokens.data[index];
                character = tokens.data[index] ? tokens.data[index + 1] : character + tokens.data[index + 1];
                records.push({ line, character, readonly: Boolean(tokens.data[index + 4] & readonlyBit) });
            }
            for (const [sourceLine, text] of source.split("\n").entries()) {
                for (const match of text.matchAll(/\b(writableValue|immutableValue|pointerToConst|fixedPointer)\b/g)) {
                    const record = records.find((entry) => entry.line === sourceLine && entry.character === match.index);
                    assert.ok(record, `missing semantic token for ${match[0]}`);
                    assert.equal(record.readonly, ["immutableValue", "fixedPointer"].includes(match[0]), match[0]);
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("native semantic highlighting follows active declarations without NOKEYWORD", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-stock-native-tokens-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = ["#ifdef FUNCTION_BUILD", "Declare Function chosen() As Long", "#else",
            "Dim chosen As Long = 1", "#endif", "#define FixedInput 7", "Dim fixedValue As Const Long = FixedInput", "Dim resultValue As Long",
            "resultValue = chosen + fixedValue", "Print resultValue", "' chosen resultValue", "Dim wide As Integer<128>",
            "Dim pointerValue As Const UInteger Ptr", "Dim textValue As String", "Dim fixedText As String * 1",
            "Type NumberAlias As Long", "Dim aliased As NumberAlias",
            "#define NumericType Double", "Dim macroValue As NumericType", ""].join("\n");
        let current;
        try {
            fs.writeFileSync(sourcePath, source);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            const { TOKEN_TYPES, TOKEN_MODIFIERS } = require(path.join(extension.extensionPath, "lib/semantic-token-data"));
            const decode = (result) => {
                const records = new Map();
                let line = 0, character = 0;
                for (let index = 0; index < result.data.length; index += 5) {
                    line += result.data[index];
                    character = result.data[index] ? result.data[index + 1] : character + result.data[index + 1];
                    records.set(`${line}:${character}`, { type: TOKEN_TYPES[result.data[index + 3]],
                        length: result.data[index + 2], modifiers: result.data[index + 4] });
                }
                return records;
            };
            const builds = [["", false], ["", true]];
            if (process.env.FBC_EDITOR_EXECUTABLE) builds.push(["", false, process.env.FBC_EDITOR_EXECUTABLE],
                ["", true, process.env.FBC_EDITOR_EXECUTABLE], [process.env.FBC_EDITOR_EXECUTABLE, false], [process.env.FBC_EDITOR_EXECUTABLE, true]);
            for (const [compilerPath, functions, normalCompiler = process.env.FBC_EXECUTABLE] of builds) {
                await configuration.update("compiler.path", normalCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", functions ? ["-d", "FUNCTION_BUILD"] : [], vscode.ConfigurationTarget.Global);
                if (compilerPath || normalCompiler === process.env.FBC_EDITOR_EXECUTABLE) {
                    for (const [text, prefix, expected] of [["Dim wide As Integer<128>", "Dim wide As ", "16 bytes"],
                        ["Dim pointerValue As Const UInteger Ptr", "Dim pointerValue As Const ", "pointer value, not the pointed-to storage"],
                        ["Dim textValue As String", "Dim textValue As ", "string descriptor; character storage is separate"],
                        ["Dim fixedText As String * 1", "Dim fixedText As ", "1 byte"]]) {
                        const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                            position(current, text, prefix.length + 1));
                        const contents = hovers?.flatMap((hover) => hover.contents.map((content) => content.value || "")).join("\n") || "";
                        assert.match(contents, /Compiler-selected type:/, "a cold type hover must acquire native layout facts");
                        assert.ok(contents.includes(expected), `${text}: ${contents}`);
                    }
                }
                const result = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", current.uri);
                assert.ok(result?.data.length);
                const records = decode(result);
                const at = (text, relative = 0) => {
                    const point = position(current, text, relative);
                    return records.get(`${point.line}:${point.character}`);
                };
                assert.equal(at("resultValue = chosen", "resultValue = ".length)?.type, functions ? "function" : "variable",
                    `native coloring must follow the active compiler binding: bridge=${Boolean(compilerPath)}, functions=${functions}`);
                assert.equal(at(functions ? "Dim chosen" : "Declare Function chosen", functions ? "Dim ".length : "Declare Function ".length),
                    undefined, "the inactive declaration must not receive semantic coloring");
                assert.equal(at("#define FixedInput", "#define ".length)?.type, "macro");
                assert.equal(at("Long = FixedInput", "Long = ".length)?.type, "macro", "retain native macro invocation coloring alongside ordinary symbols");
                const fixed = at("chosen + fixedValue", "chosen + ".length);
                assert.equal(fixed?.type, "variable");
                assert.ok(fixed.modifiers & (1 << TOKEN_MODIFIERS.indexOf("readonly")), "retain native CONST value qualifiers");
                const written = at("resultValue = chosen");
                assert.ok(written?.modifiers & (1 << TOKEN_MODIFIERS.indexOf("modification")),
                    `retain the native assignment role: bridge=${Boolean(compilerPath)}, functions=${functions}`);
                assert.equal(at("' chosen", 2), undefined, "comments must not become semantic identifiers");
                for (const [text, prefix] of [["Dim wide As Integer<128>", "Dim wide As "],
                    ["Dim pointerValue As Const UInteger Ptr", "Dim pointerValue As Const "],
                    [functions ? "Declare Function chosen() As Long" : "Dim chosen As Long", functions ? "Declare Function chosen() As " : "Dim chosen As "]]) {
                    const primitive = at(text, prefix.length);
                    assert.equal(primitive?.type, "type", text);
                    assert.ok(primitive.modifiers & (1 << TOKEN_MODIFIERS.indexOf("defaultLibrary")), text);
                }
                const inactive = functions ? "Dim chosen As Long" : "Declare Function chosen() As Long";
                assert.equal(at(inactive, inactive.indexOf("Long")), undefined, "inactive type spellings have no primitive receipt");
                for (const [text, prefix, expected] of [["Dim aliased As NumberAlias", "Dim aliased As ", "type"],
                    ["Dim macroValue As NumericType", "Dim macroValue As ", "macro"]]) {
                    const entry = at(text, prefix.length);
                    assert.equal(entry?.type, expected);
                    assert.equal(Boolean(entry.modifiers & (1 << TOKEN_MODIFIERS.indexOf("defaultLibrary"))), false);
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            if (process.env.FBC_EDITOR_EXECUTABLE) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(source.length)),
                    source.replace("Dim wide As Integer<128>", "Dim wide As Double"));
                await applyEditAndWaitForDocuments(edit, [current]);
                const updated = decode(await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", current.uri));
                const point = position(current, "Dim wide As Double", "Dim wide As ".length);
                const primitive = updated.get(`${point.line}:${point.character}`);
                assert.equal(primitive?.type, "type");
                assert.equal(primitive.length, "Double".length, "the old Integer token must not survive the unsaved edit");
                assert.ok(primitive.modifiers & (1 << TOKEN_MODIFIERS.indexOf("defaultLibrary")));
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                    position(current, "Dim wide As Double", "Dim wide As ".length + 1));
                const contents = hovers?.flatMap((hover) => hover.contents.map((content) => content.value || "")).join("\n") || "";
                assert.ok(contents.includes("Compiler-selected type: `double`."), contents);
                assert.ok(contents.includes("`8 bytes`"), "the old 128-bit type layout must not survive the unsaved edit");
                assert.equal(current.isDirty, true);
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source, "semantic highlighting must not save the changed type");
            }
        } finally {
            if (current?.isDirty) {
                await vscode.window.showTextDocument(current);
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            }
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("guarded argument constructors follow active compiler declarations, signatures, and hovers", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-guarded-constructors-"));
        const filePath = path.join(directory, "main.bas"), headerPath = path.join(directory, "guarded.bi");
        const header = fs.readFileSync(path.join(__dirname, "../fixtures/guarded-argument-constructors.bi"), "utf8");
        const headerLines = header.split("\n");
        const source = ['#include "guarded.bi"', "Declare Sub consumeGuarded(ByVal item As GuardedArgumentValue)",
            "consumeGuarded(17)", "Dim argumentValue As Long", "consumeGuarded(argumentValue)", "consumeGuarded 17",
            'consumeGuarded("text")', "Dim wholePtr As GuardedArgumentValue Ptr = New GuardedArgumentValue(17)",
            'Dim textPtr As GuardedArgumentValue Ptr = New GuardedArgumentValue("text")',
            "Dim wholeValue As GuardedArgumentValue = GuardedArgumentValue(23)",
            'Dim textValue As GuardedArgumentValue = GuardedArgumentValue("other")',
            "Namespace GuardedNames", "Type ValueAlias As GuardedArgumentValue", "End Namespace",
            "Dim aliasedPtr As GuardedNames.ValueAlias Ptr = New GuardedNames.ValueAlias(29)",
            "Dim aliasedValue As GuardedNames.ValueAlias = GuardedNames.ValueAlias(31)",
            "Dim sourceValue As Long", "Dim fromValue As GuardedArgumentValue = GuardedArgumentValue(sourceValue)", ""].join("\n");
        try {
            fs.writeFileSync(filePath, source);
            fs.writeFileSync(headerPath, header);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const version = current.version;
            const expectConstructorFeatures = async (label, external, alternate) => {
                const referenceLines = {
                    Long: ["consumeGuarded(17)", "consumeGuarded(argumentValue)", "consumeGuarded 17",
                        "GuardedArgumentValue(17)", "GuardedArgumentValue(23)", "GuardedNames.ValueAlias(29)",
                        "GuardedNames.ValueAlias(31)", "GuardedArgumentValue(sourceValue)"].map((anchor) => position(current, anchor).line),
                    String: ['consumeGuarded("text")', 'GuardedArgumentValue("text")',
                        'GuardedArgumentValue("other")'].map((anchor) => position(current, anchor).line)
                };
                // References run before navigation and hints can warm metadata.
                for (const [anchor, type] of [["GuardedArgumentValue(23)", "Long"],
                    ["GuardedArgumentValue(17)", "Long"], ['GuardedArgumentValue("text")', "String"],
                    ['GuardedArgumentValue("other")', "String"], ["GuardedNames.ValueAlias(29)", "Long"],
                    ["GuardedNames.ValueAlias(31)", "Long"]]) {
                    const selected = position(current, anchor, anchor.lastIndexOf(".") + 2);
                    const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri, selected);
                    const rootReferences = references.filter((entry) => entry.uri.fsPath === filePath);
                    assert.deepEqual([...new Set(rootReferences.map((entry) => entry.range.start.line))].sort((a, b) => a - b),
                        referenceLines[type], `${label}: references: ${anchor}`);
                    const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", current.uri, selected);
                    assert.deepEqual([...new Set(highlights.map((entry) => entry.range.start.line))].sort((a, b) => a - b),
                        referenceLines[type], `${label}: highlights: ${anchor}`);
                    assert.ok(highlights.some((entry) => entry.range.start.line === selected.line &&
                        current.getText(entry.range) === anchor.slice(0, anchor.indexOf("(")).split(".").at(-1)),
                        `${label}: constructor highlights must keep the terminal callee token`);
                    for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider", "vscode.executeImplementationProvider"]) {
                        const entries = await vscode.commands.executeCommand(command, current.uri,
                            position(current, anchor, anchor.lastIndexOf(".") + 2));
                        if (external && command === "vscode.executeImplementationProvider") {
                            assert.deepEqual(entries, [], `${label}: ${command}: external constructor has no local body`);
                        } else {
                            const prototype = external || command === "vscode.executeDeclarationProvider";
                            const pattern = prototype ? `^\\s*Declare Constructor\\(ByVal initial As ${type}\\)`
                                : `^Constructor GuardedArgumentValue\\(ByVal initial As ${type}\\)`;
                            const candidates = headerLines.flatMap((line, index) => new RegExp(pattern).test(line) ? [index] : []);
                            assert.equal(entries.length, 1, `${label}: ${command}: ${anchor}`);
                            assert.equal(entries[0].uri.fsPath, headerPath, label);
                            assert.equal(entries[0].range.start.line, candidates[alternate ? 0 : 1], label);
                        }
                    }
                    const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                        position(current, anchor, anchor.lastIndexOf(".") + 2));
                    const hoverText = (hover || []).flatMap((entry) => entry.contents.map((content) => content.value)).join("\n");
                    assert.match(hoverText, new RegExp(`Constructor[^\\n]*ByVal initial As ${type}`, "i"), `${label}: ${anchor}`);
                    assert.doesNotMatch(hoverText, new RegExp(`Constructor[^\\n]*ByVal initial As ${type === "Long" ? "String" : "Long"}`, "i"), label);
                    const result = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, anchor, anchor.indexOf("(") + 1));
                    assert.equal(result?.signatures.length, 1, `${label}: ${anchor}`);
                    assert.match(result.signatures[0].label, new RegExp(`ByVal initial As ${type}`, "i"), label);
                    assert.equal(result.activeSignature, 0, label);
                    assert.equal(result.activeParameter, 0, label);
                }
                for (const [anchor, relative] of [["GuardedNames.ValueAlias(29)", 1],
                    ["GuardedArgumentValue(sourceValue)", "GuardedArgumentValue(".length]]) {
                    const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                        position(current, anchor, relative));
                    const hoverText = (hover || []).flatMap((entry) => entry.contents.map((content) => content.value)).join("\n");
                    assert.doesNotMatch(hoverText, /Constructor[^\n]*ByVal initial/i,
                        `${label}: qualifiers and argument values retain their own hovers`);
                }
            };
            for (const bridge of [true, false]) for (const alternate of [false, true, false]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", alternate ? ["-d", "ALTERNATE"] : [], vscode.ConfigurationTarget.Global);
                await expectConstructorFeatures(`guarded, bridge=${bridge}, alternate=${alternate}`, false, alternate);
                for (const [anchor, relative, type] of [["consumeGuarded(17)", "consumeGuarded(".length, "Long"],
                    ["consumeGuarded 17", "consumeGuarded ".length, "Long"],
                    ['consumeGuarded("text")', 'consumeGuarded("'.length, "String"]]) {
                    const point = position(current, anchor, relative);
                    for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider", "vscode.executeImplementationProvider"]) {
                        const entries = await vscode.commands.executeCommand(command, current.uri, point);
                        const label = `${command}, ${type}, bridge=${bridge}, alternate=${alternate}`;
                        assert.equal(entries.length, 1, label);
                        assert.equal(entries[0].uri.fsPath, headerPath, label);
                        const declaration = command === "vscode.executeDeclarationProvider";
                        const pattern = declaration ? `^\\s*Declare Constructor\\(ByVal initial As ${type}\\)`
                            : `^Constructor GuardedArgumentValue\\(ByVal initial As ${type}\\)`;
                        const candidates = headerLines.flatMap((line, index) => new RegExp(pattern).test(line) ? [index] : []);
                        assert.equal(entries[0].range.start.line, candidates[alternate ? 0 : 1], label);
                        assert.equal(headerLines[entries[0].range.start.line].slice(entries[0].range.start.character, entries[0].range.end.character),
                            declaration ? "Constructor" : "GuardedArgumentValue", label);
                    }
                }
                assert.equal(current.version, version, "build selection must not require a source edit");
            }
            const bodyStart = header.indexOf("\n#ifdef ALTERNATE\nConstructor");
            assert.ok(bodyStart > 0);
            fs.writeFileSync(headerPath, header.slice(0, bodyStart) + "\n#endif\n");
            for (const bridge of [false, true]) for (const alternate of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", alternate ? ["-d", "ALTERNATE"] : [], vscode.ConfigurationTarget.Global);
                await expectConstructorFeatures(`external, bridge=${bridge}, alternate=${alternate}`, true, alternate);
            }
            assert.equal(vscode.workspace.textDocuments.some((document) => document.uri.fsPath === headerPath), false,
                "native declaration mapping must not require an open header");
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(filePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project constructor references retain selected overloads across modules", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-project-constructors-"));
        const filePath = path.join(directory, "main.bas"), otherPath = path.join(directory, "other.bas");
        const headerPath = path.join(directory, "guarded.bi");
        const guarded = fs.readFileSync(path.join(__dirname, "../fixtures/guarded-argument-constructors.bi"), "utf8");
        const prototypeStart = guarded.indexOf("#ifdef ALTERNATE");
        const prototypeEnd = guarded.indexOf("#endif", prototypeStart);
        assert.ok(prototypeStart > 0 && prototypeEnd > prototypeStart);
        // Shared prototypes join the distinct guarded bodies. Without a shared
        // physical anchor, different build identities remain ambiguous.
        const header = guarded.slice(0, prototypeStart) + "    Declare Constructor(ByVal initial As Long)\n" +
            "    Declare Constructor(ByVal initial As String)\n" + guarded.slice(prototypeEnd + "#endif".length);
        const source = ['#include "guarded.bi"', "Dim selectedValue As GuardedArgumentValue = GuardedArgumentValue(1)", ""].join("\n");
        const other = ['#include "guarded.bi"', "Sub Other()",
            "    Dim wholeValue As GuardedArgumentValue = GuardedArgumentValue(2)",
            '    Dim textValue As GuardedArgumentValue = GuardedArgumentValue("x")', "End Sub", ""].join("\n");
        try {
            for (const [file, text] of [[filePath, source], [otherPath, other], [headerPath, header]]) fs.writeFileSync(file, text);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [
                { name: "constructors", modules: [filePath, otherPath] },
                { name: "alternate", modules: [filePath, otherPath], arguments: ["-d", "ALTERNATE"] }
            ], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", { name: "constructors", module: filePath }, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri,
                    position(current, "GuardedArgumentValue(1)", 1));
                const otherSites = references.filter((entry) => entry.uri.fsPath === otherPath);
                const callColumn = other.split("\n")[2].indexOf("GuardedArgumentValue(2)");
                assert.ok(otherSites.some((entry) => entry.range.start.line === 2 && entry.range.start.character === callColumn &&
                    entry.range.end.character === callColumn + "GuardedArgumentValue".length),
                    `bridge=${bridge}: Find References must include the selected constructor call in the closed module`);
                assert.ok(otherSites.every((entry) => entry.range.start.line === 2),
                    "project constructor references must exclude the String overload");
                const headerSites = references.filter((entry) => entry.uri.fsPath === headerPath);
                assert.equal(headerSites.length, 3, "both configured guards join through their shared Long prototype");
                assert.ok(headerSites.every((entry) => /Constructor[^\n]*ByVal initial As Long/i.test(
                    header.split("\n")[entry.range.start.line])));
            }
            assert.equal(current.isDirty, false);
            assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === otherPath), false,
                "cross-module references must not require opening the other root");
            for (const [file, text] of [[filePath, source], [otherPath, other], [headerPath, header]]) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project destructor references retain native cleanup across modules", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-project-cleanup-"));
        const headerPath = path.join(directory, "cleanup.bi"), implementationPath = path.join(directory, "implementation.bas");
        const callerPath = path.join(directory, "caller.bas"), otherPath = path.join(directory, "other.bas");
        const header = ["Type Managed", "    payload As Long", "    Declare Destructor()", "End Type",
            "Type Unrelated", "    payload As Long", "    Declare Destructor()", "End Type", ""].join("\n");
        const implementation = ['#include "cleanup.bi"', "Destructor Managed()", "End Destructor",
            "Destructor Unrelated()", "End Destructor", ""].join("\n");
        const caller = ['#include "cleanup.bi"', "Sub Caller()", "    Dim localValue As Managed", "End Sub",
            "Sub UnrelatedCaller()", "    Dim unrelatedValue As Unrelated", "End Sub", ""].join("\n");
        const other = ['#include "cleanup.bi"', "Sub Release()", "    Dim allocated As Managed Ptr = New Managed",
            "    Delete allocated", "End Sub", "Sub ExplicitRelease(ByVal pointerValue As Managed Ptr)",
            "    pointerValue->Destructor()", "End Sub", ""].join("\n");
        const sources = [[headerPath, header], [implementationPath, implementation], [callerPath, caller], [otherPath, other]];
        const keys = (entries) => entries.map((entry) => `${entry.uri.fsPath}:${entry.range.start.line}:` +
            `${entry.range.start.character}:${entry.range.end.line}:${entry.range.end.character}`).sort();
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "cleanup", modules: [implementationPath, callerPath, otherPath] }],
                vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", { name: "cleanup", module: callerPath }, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri,
                    position(current, "Declare Destructor", "Declare ".length + 1));
                assert.equal(references.filter((entry) => entry.uri.fsPath === headerPath).length, 1);
                assert.equal(references.filter((entry) => entry.uri.fsPath === implementationPath).length, 1);
                assert.deepEqual(references.filter((entry) => entry.uri.fsPath === callerPath).map((entry) => entry.range.start.line), [2],
                    `bridge=${bridge}: unrelated cleanup must stay separate`);
                assert.deepEqual(references.filter((entry) => entry.uri.fsPath === otherPath).map((entry) => entry.range.start.line), [3, 6],
                    `bridge=${bridge}: closed-module DELETE and explicit calls must be included`);
                await configuration.update("analysis.activeContext", { name: "cleanup", module: otherPath }, vscode.ConfigurationTarget.Global);
                const otherDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(otherPath));
                const fromCall = await vscode.commands.executeCommand("vscode.executeReferenceProvider", otherDocument.uri,
                    position(otherDocument, "Destructor()", 1));
                assert.deepEqual(keys(fromCall), keys(references), "explicit destructor calls must select the same project family");
            }
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project operator references and incoming hierarchy retain selected binary and index overloads", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-project-operators-"));
        const headerPath = path.join(directory, "operators.bi"), implementationPath = path.join(directory, "implementation.bas");
        const callerPath = path.join(directory, "caller.bas"), otherPath = path.join(directory, "other.bas");
        const header = ["Type ProjectValue", "    value As Long", "    Declare Operator [](ByVal index As Long) As Long",
            "    Declare Operator [](ByVal index As Double) As Long", "End Type",
            "Declare Operator +(ByRef item As ProjectValue, ByVal amount As Long) As Long",
            "Declare Operator +(ByRef item As ProjectValue, ByVal amount As Double) As Long", ""].join("\n");
        const implementation = ['#include "operators.bi"', "Operator ProjectValue.[](ByVal index As Long) As Long",
            "    Return index", "End Operator", "Operator ProjectValue.[](ByVal index As Double) As Long",
            "    Return CLng(index)", "End Operator", "Operator +(ByRef item As ProjectValue, ByVal amount As Long) As Long",
            "    Return amount", "End Operator", "Operator +(ByRef item As ProjectValue, ByVal amount As Double) As Long",
            "    Return CLng(amount)", "End Operator", ""].join("\n");
        const moduleText = (name) => ['#include "operators.bi"', `Sub ${name}()`, "    Dim item As ProjectValue",
            "    Print item + CDbl(1)", "    Print item + CLng(2)", "    Print item[CDbl(3)]", "    Print item[CLng(4)]",
            "End Sub", ""].join("\n");
        const caller = moduleText("Caller");
        const other = ['#include "operators.bi"', "#ifdef ALTERNATE", "Sub ActiveOther()", "#else", "Sub InactiveOther()", "#endif",
            "    Dim item As ProjectValue", "    Print item + CDbl(1)", "    Print item + CLng(2)", "    Print item[CDbl(3)]",
            "    Print item[CLng(4)]", "End Sub", "Dim sharedItem As ProjectValue", "Print sharedItem + CDbl(8)",
            "Print sharedItem[CDbl(9)]", ""].join("\n");
        const sources = [[headerPath, header], [implementationPath, implementation], [callerPath, caller], [otherPath, other]];
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "operators", modules: [implementationPath, callerPath, otherPath], arguments: ["-d", "ALTERNATE"] }]],
                ["analysis.activeContext", { name: "operators", module: callerPath }], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
            const headerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
            let expandedOther = false;
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const [anchor, relative, line, declarationLine, bodyLine, otherLine, moduleLine] of [
                    ["item[CDbl(3)]", "item[CDbl(3)".length, 5, 3, 4, 9, 14], ["item + CDbl(1)", "item ".length, 3, 6, 10, 7, 13]
                ]) {
                    const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri,
                        position(current, anchor, relative));
                    const actual = references.map((entry) => `${entry.uri.fsPath}:${entry.range.start.line}`).sort();
                    const expected = [[headerPath, declarationLine], [implementationPath, bodyLine], [callerPath, line],
                        [otherPath, otherLine], [otherPath, moduleLine]]
                        .map(([file, line]) => `${file}:${line}`).sort();
                    assert.deepEqual(actual, expected, `bridge=${bridge}: ${anchor}: project references must keep the selected Double overload: ${JSON.stringify(actual)}`);
                    const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", current.uri,
                        position(current, anchor, relative));
                    assert.deepEqual(highlights.map((entry) => entry.range.start.line), [line], "highlights remain local to this document");
                    const declarationText = headerDocument.lineAt(declarationLine).text;
                    const items = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", headerDocument.uri,
                        new vscode.Position(declarationLine, declarationText.indexOf(anchor.includes("[") ? "[]" : "+")));
                    assert.equal(items.length, 1, `bridge=${bridge}: the selected operator prototype must prepare`);
                    const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", items[0]);
                    assert.deepEqual(incoming.map((call) => [call.from.name, path.basename(call.from.uri.fsPath),
                        call.fromRanges.map((range) => range.start.line)]).sort(),
                    [["Caller", "caller.bas", [line]], ["ActiveOther", "other.bas", [otherLine]],
                        ["other.bas", "other.bas", [moduleLine]]].sort(),
                    `bridge=${bridge}: native operator ownership must retain closed callers and exclude inactive headers`);
                    assert.equal(incoming.find((call) => call.from.name === "ActiveOther").from.selectionRange.start.line, 2);
                    if (!expandedOther) assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === otherPath), false,
                        "operator references and incoming lookup must not require opening another module");
                    const activeCaller = incoming.find((call) => call.from.name === "ActiveOther");
                    const visible = vscode.window.activeTextEditor;
                    const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", activeCaller.from);
                    expandedOther = true;
                    assert.equal(vscode.window.activeTextEditor, visible, "expanding a closed caller must not show its document");
                    const selectedOperator = outgoing.filter((call) => call.to.uri.fsPath === headerPath &&
                        call.to.selectionRange.start.line === declarationLine);
                    assert.deepEqual(selectedOperator.map((call) => call.fromRanges.map((range) => range.start.line)), [[otherLine]],
                        `bridge=${bridge}: a native conditional operator caller must expand back to its selected callee; targets: ` +
                        outgoing.map((call) => `${call.to.detail}@${call.to.uri}:${call.to.selectionRange.start.line}`).join(" | "));
                    const returning = await vscode.commands.executeCommand("vscode.provideIncomingCalls", selectedOperator[0].to);
                    assert.ok(returning.some((call) => call.from.name === "ActiveOther"),
                        `bridge=${bridge}: an outgoing operator target must retain its incoming hierarchy; ` +
                        `outgoing=${selectedOperator[0].to.detail}, prepared=${items[0].detail}`);
                }
            }
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project procedure references retain macro overloads and unsaved header changes", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run", "analysis.timeoutMs",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-procedure-references-"));
        const headerPath = path.join(directory, "api.bi"), callerPath = path.join(directory, "caller.bas");
        const otherPath = path.join(directory, "other.bas");
        const header = "Declare Function Work Overload(ByVal value As Long) As Long\n" +
            "Declare Function Work Overload(ByVal value As Double) As Long\n#define UseWork(value) Work(value)\n";
        const caller = ['#include "api.bi"', "Sub Caller()", "    Print UseWork(CLng(1))", "    Print Work(CLng(9))",
            "End Sub", "Sub QueryOnly()", "    Dim query As TypeOf(UseWork(CLng(2)))", "End Sub", ""].join("\n");
        const other = '#include "api.bi"\nPrint UseWork(CDbl(3))\n';
        const sources = [[headerPath, header], [callerPath, caller], [otherPath, other]];
        let headerDocument;
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "procedure-references", modules: [callerPath, otherPath] }]],
                ["analysis.activeContext", { name: "procedure-references", module: callerPath }], ["analysis.run", "onDemand"],
                ["analysis.timeoutMs", 120000], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
            headerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
            const locations = (references) => references.map((entry) => `${entry.uri.fsPath}:${entry.range.start.line}`).sort();
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const [line, expected] of [[0, [`${headerPath}:0`, `${callerPath}:2`, `${callerPath}:3`, `${callerPath}:6`]],
                [1, [`${headerPath}:1`, `${otherPath}:1`]]]) {
                    const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", headerDocument.uri,
                        new vscode.Position(line, headerDocument.lineAt(line).text.indexOf("Work")));
                    assert.deepEqual(locations(references), expected.sort(),
                        `bridge=${bridge}, header ${line}: selected macro uses, including TYPEOF, must retain their overload`);
                }
                assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === otherPath), false);
                if (!bridge) continue; // Stock sidecars require saved inputs.
                const edit = new vscode.WorkspaceEdit(), start = position(headerDocument,
                    "#define UseWork(value) Work(value)", "#define UseWork(value) ".length);
                edit.replace(headerDocument.uri, new vscode.Range(start, start.translate(0, "Work(value)".length)), "Work(CDbl(value))");
                await applyEditAndWaitForDocuments(edit, [headerDocument]);
                assert.equal(headerDocument.isDirty, true);
                for (const [line, expected] of [[0, [`${headerPath}:0`, `${callerPath}:3`]],
                [1, [`${headerPath}:1`, `${callerPath}:2`, `${callerPath}:6`, `${otherPath}:1`]]]) {
                    const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", headerDocument.uri,
                        new vscode.Position(line, headerDocument.lineAt(line).text.indexOf("Work")));
                    assert.deepEqual(locations(references), expected.sort(), "unsaved macro edits must move references to the selected overload");
                }
            }
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            if (headerDocument?.isDirty) {
                await vscode.window.showTextDocument(headerDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
            }
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project memory operator references include macro uses and unsaved changes", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run", "analysis.timeoutMs",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-memory-references-"));
        const headerPath = path.join(directory, "memory.bi"), callerPath = path.join(directory, "caller.bas");
        const otherPath = path.join(directory, "other.bas");
        const header = ["Type MemoryValue", "    value As Long", "    Declare Operator New(ByVal bytes As UInteger) As Any Ptr",
            "    Declare Operator New[](ByVal bytes As UInteger) As Any Ptr", "End Type",
            "Operator MemoryValue.New(ByVal bytes As UInteger) As Any Ptr", "    Return Allocate(bytes)", "End Operator",
            "Operator MemoryValue.New[](ByVal bytes As UInteger) As Any Ptr", "    Return Allocate(bytes)", "End Operator",
            "#macro MakeMemory()", "    Dim scalar As MemoryValue Ptr = New MemoryValue",
            "    Dim vector As MemoryValue Ptr = New MemoryValue[2]", "#endmacro", ""].join("\n");
        const caller = '#include "memory.bi"\nSub Caller()\n    MakeMemory()\nEnd Sub\n';
        const other = '#include "memory.bi"\nSub Other()\n    MakeMemory()\nEnd Sub\n';
        const sources = [[headerPath, header], [callerPath, caller], [otherPath, other]];
        let current;
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "memory", modules: [callerPath, otherPath] }]],
                ["analysis.activeContext", { name: "memory", module: callerPath }], ["analysis.run", "onDemand"],
                // This isolated profile shares the host with long-running decryption jobs.
                ["analysis.timeoutMs", 120000], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
            const headerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
            const referenceLines = (references) => references.map((entry) => `${entry.uri.fsPath}:${entry.range.start.line}`).sort();
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const [line, body] of [[2, 5], [3, 8]]) {
                    const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", headerDocument.uri,
                        new vscode.Position(line, headerDocument.lineAt(line).text.indexOf("New")));
                    assert.deepEqual(referenceLines(references), [`${headerPath}:${line}`, `${headerPath}:${body}`, `${callerPath}:2`, `${otherPath}:2`].sort(),
                        `bridge=${bridge}, operator line=${line}: each selected allocator must retain its shared macro invocation; got ${JSON.stringify(referenceLines(references))}`);
                }
                assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === otherPath), false,
                    "Find References must include closed modules without opening them");
                // Stock sidecars accept saved inputs; dirty roots require the bridge.
                if (!bridge) continue;
                const edit = new vscode.WorkspaceEdit();
                const start = position(current, "MakeMemory()");
                edit.replace(current.uri, new vscode.Range(start, start.translate(0, "MakeMemory()".length)), "Var builtin = New Integer");
                await applyEditAndWaitForDocuments(edit, [current]);
                assert.equal(current.isDirty, true);
                for (const [line, body] of [[2, 5], [3, 8]]) {
                    const updated = await vscode.commands.executeCommand("vscode.executeReferenceProvider", headerDocument.uri,
                        new vscode.Position(line, headerDocument.lineAt(line).text.indexOf("New")));
                    assert.deepEqual(referenceLines(updated), [`${headerPath}:${line}`, `${headerPath}:${body}`, `${otherPath}:2`].sort(),
                        `bridge=${bridge}, operator line=${line}: unsaved builtin allocation must remove both custom allocator references`);
                }
                await vscode.window.showTextDocument(current);
                await vscode.commands.executeCommand("workbench.action.files.revert");
            }
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            if (current?.isDirty) {
                await vscode.window.showTextDocument(current);
                await vscode.commands.executeCommand("workbench.action.files.revert");
            }
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project operator navigation follows the active guarded implementation", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-operator-navigation-"));
        const headerPath = path.join(directory, "navigation.bi"), implementationPath = path.join(directory, "implementation.bas");
        const callerPath = path.join(directory, "caller.bas");
        const header = ["Type NavigationValue", "    value As Long", "    Declare Operator [](ByVal index As Double) As Long", "End Type",
            "Declare Operator +(ByRef item As NavigationValue, ByVal amount As Long) As Long",
            "Declare Operator +(ByRef item As NavigationValue, ByVal amount As Double) As Long", ""].join("\n");
        const binary = "Operator +(ByRef item As NavigationValue, ByVal amount As Double) As Long";
        const indexed = "Operator NavigationValue.[](ByVal index As Double) As Long";
        const implementation = ['#include "navigation.bi"', "Operator +(ByRef item As NavigationValue, ByVal amount As Long) As Long",
            "    Return amount", "End Operator", "#ifdef ALTERNATE", binary, "    Return CLng(amount) + 1", "End Operator",
            indexed, "    Return CLng(index) + 1", "End Operator", "#else", binary, "    Return CLng(amount)", "End Operator",
            indexed, "    Return CLng(index)", "End Operator", "#endif", ""].join("\n");
        const caller = '#include "navigation.bi"\nSub Caller()\nDim item As NavigationValue\nPrint item + CDbl(1)\nPrint item[CDbl(2)]\nEnd Sub\n';
        const sources = [[headerPath, header], [implementationPath, implementation], [callerPath, caller]];
        const bodyLine = (spelling, alternate) => implementation.split("\n").flatMap((line, index) => line === spelling ? [index] : [])[alternate ? 0 : 1];
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "normal", modules: [callerPath, implementationPath] },
                    { name: "alternate", modules: [callerPath, implementationPath], arguments: ["-d", "ALTERNATE"] }]],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
            const version = current.version;
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const alternate of [false, true]) {
                    await configuration.update("analysis.activeContext", { name: alternate ? "alternate" : "normal", module: callerPath },
                        vscode.ConfigurationTarget.Global);
                    for (const [anchor, relative, spelling, prototype] of [["item + CDbl(1)", "item ".length, binary, 5],
                        ["item[CDbl(2)]", "item[CDbl(2)".length, indexed, 2]]) {
                        for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider", "vscode.executeImplementationProvider"]) {
                            const entries = await vscode.commands.executeCommand(command, current.uri, position(current, anchor, relative));
                            const declaration = command === "vscode.executeDeclarationProvider";
                            const expected = [[declaration ? headerPath : implementationPath, declaration ? prototype : bodyLine(spelling, alternate)]];
                            assert.deepEqual(entries.map((entry) => [entry.uri.fsPath, entry.range.start.line]), expected,
                                `${command}, bridge=${bridge}, alternate=${alternate}, ${anchor}: only the active selected overload may be returned`);
                        }
                    }
                }
            }
            assert.equal(current.version, version, "changing builds must not require an editor-buffer edit");
            assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === implementationPath), false,
                "operator implementation navigation must work without opening its source file");
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project lifetime navigation follows selected guarded constructors and destructors", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-lifetime-navigation-"));
        const headerPath = path.join(directory, "lifetime.bi"), implementationPath = path.join(directory, "implementation.bas");
        const callerPath = path.join(directory, "caller.bas");
        const header = ["Type LifetimeValue", "    value As Long", "    Declare Constructor(ByVal amount As Long)",
            "    Declare Constructor(ByVal amount As String)", "    Declare Destructor()", "End Type", ""].join("\n");
        const numeric = "Constructor LifetimeValue(ByVal amount As Long)", destructor = "Destructor LifetimeValue()";
        const branch = (alternate) => [numeric, `    value = amount + ${alternate ? 1 : 0}`, "End Constructor",
            "Constructor LifetimeValue(ByVal amount As String)", "    value = Len(amount)", "End Constructor", destructor, "End Destructor"];
        const implementation = ['#include "lifetime.bi"', "#ifdef ALTERNATE", ...branch(true), "#else", ...branch(false), "#endif", ""].join("\n");
        const caller = ['#include "lifetime.bi"', "Sub Consume(ByVal item As LifetimeValue)", "End Sub", "Namespace LifetimeNames",
            "Type AliasValue As LifetimeValue", "End Namespace", "Dim value As LifetimeValue = LifetimeNames.AliasValue(17)",
            "Dim allocated As LifetimeValue Ptr = New LifetimeNames.AliasValue(18)", "Consume(19)",
            "Dim typed As LifetimeValue = Type<LifetimeNames.AliasValue>(20)", ""].join("\n");
        const sources = [[headerPath, header], [implementationPath, implementation], [callerPath, caller]];
        const bodyLine = (spelling, alternate) => implementation.split("\n").flatMap((line, index) => line === spelling ? [index] : [])[alternate ? 0 : 1];
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "normal", modules: [callerPath, implementationPath] },
                    { name: "alternate", modules: [callerPath, implementationPath], arguments: ["-d", "ALTERNATE"] }]],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
            const version = current.version;
            const included = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const alternate of [false, true]) {
                    await configuration.update("analysis.activeContext", { name: alternate ? "alternate" : "normal", module: callerPath }, vscode.ConfigurationTarget.Global);
                    const probes = [
                        ["vscode.executeDefinitionProvider", current, "LifetimeNames.AliasValue(17)", "LifetimeNames.".length + 1, implementationPath, bodyLine(numeric, alternate)],
                        ["vscode.executeDefinitionProvider", current, "Type<LifetimeNames.AliasValue>(20)", 1, implementationPath, bodyLine(numeric, alternate)],
                        ["vscode.executeImplementationProvider", current, "Type<LifetimeNames.AliasValue>(20)", 1, implementationPath, bodyLine(numeric, alternate)],
                        ["vscode.executeDeclarationProvider", current, "Type<LifetimeNames.AliasValue>(20)", 1, headerPath, 2],
                        ["vscode.executeImplementationProvider", included, "Declare Destructor", "Declare ".length + 1, implementationPath, bodyLine(destructor, alternate)],
                        ...(!alternate ? [
                            ["vscode.executeImplementationProvider", current, "LifetimeNames.AliasValue(18)", "LifetimeNames.".length + 1, implementationPath, bodyLine(numeric, false)],
                            ["vscode.executeDefinitionProvider", current, "Consume(19)", "Consume(".length, implementationPath, bodyLine(numeric, false)],
                            ["vscode.executeDeclarationProvider", current, "LifetimeNames.AliasValue(17)", "LifetimeNames.".length + 1, headerPath, 2],
                            ["vscode.executeDefinitionProvider", current, "LifetimeNames.AliasValue(17)", 1, callerPath, 3]
                        ] : [])
                    ];
                    for (const [command, target, anchor, relative, file, line] of probes) {
                        const entries = await vscode.commands.executeCommand(command, target.uri, position(target, anchor, relative));
                        const actual = entries.map((entry) => [entry.uri.fsPath, entry.range.start.line]);
                        assert.deepEqual(actual, [[file, line]],
                            `${command}, bridge=${bridge}, alternate=${alternate}, ${anchor}: ${JSON.stringify(actual)}`);
                    }
                }
            }
            assert.equal(current.version, version, "build changes must not require an editor-buffer edit");
            assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === implementationPath), false,
                "lifetime navigation must not require an open implementation");
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("ordinary project navigation follows only the active guarded function", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-active-function-"));
        const headerPath = path.join(directory, "api.bi"), implementationPath = path.join(directory, "implementation.bas");
        const callerPath = path.join(directory, "caller.bas");
        const header = "Declare Function AdjustValue(ByVal value As Long) As Long\n";
        const implementation = ['#include "api.bi"', "#ifdef ALTERNATE", "Function AdjustValue(ByVal value As Long) As Long",
            "    Return value + 1", "End Function", "#else", "Function AdjustValue(ByVal value As Long) As Long",
            "    Return value", "End Function", "#endif", ""].join("\n");
        const caller = '#include "api.bi"\nPrint AdjustValue(1)\n';
        const sources = [[headerPath, header], [implementationPath, implementation], [callerPath, caller]];
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "normal", modules: [callerPath, implementationPath] },
                    { name: "alternate", modules: [callerPath, implementationPath], arguments: ["-d", "ALTERNATE"] }]],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
            const version = current.version;
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const alternate of [false, true]) {
                    await configuration.update("analysis.activeContext", { name: alternate ? "alternate" : "normal", module: callerPath }, vscode.ConfigurationTarget.Global);
                    for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider", "vscode.executeImplementationProvider"]) {
                        const locations = await vscode.commands.executeCommand(command, current.uri, position(current, "AdjustValue", 1));
                        const declaration = command === "vscode.executeDeclarationProvider";
                        assert.deepEqual(locations.map((entry) => [entry.uri.fsPath, entry.range.start.line]),
                            [[declaration ? headerPath : implementationPath, declaration ? 0 : alternate ? 2 : 6]],
                            `${command}, bridge=${bridge}, alternate=${alternate}: an inactive body must not be returned`);
                    }
                }
            }
            assert.equal(current.version, version);
            assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === implementationPath), false);
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("native virtual implementations follow descendants while definitions stay static", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-virtual-implementations-"));
        const filePath = path.join(directory, "main.bas");
        const lines = ["Type BasePicker Extends Object", "    Declare Virtual Function Pick(ByVal value As Long) As Long", "End Type",
            "Type ChildPicker Extends BasePicker", "    Declare Virtual Function Pick(ByVal value As Long) As Long Override", "End Type",
            "Type LeafPicker Extends ChildPicker", "    Declare Function Pick(ByVal value As Long) As Long Override", "End Type",
            "Type UnrelatedPicker Extends Object", "    Declare Virtual Function Pick(ByVal value As Long) As Long", "End Type"];
        const bodyLines = [];
        for (const owner of ["BasePicker", "ChildPicker", "LeafPicker", "UnrelatedPicker"]) {
            bodyLines.push(lines.length);
            lines.push(`Function ${owner}.Pick(ByVal value As Long) As Long`, "    Return value", "End Function");
        }
        const source = lines.join("\n") + "\n";
        try {
            fs.writeFileSync(filePath, source);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const [line, expected] of [[1, bodyLines.slice(0, 3)], [4, bodyLines.slice(1, 3)], [10, [bodyLines[3]]]]) {
                    const point = new vscode.Position(line, lines[line].indexOf("Pick") + 1);
                    const locations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", current.uri, point);
                    assert.deepEqual(locations.map((entry) => entry.range.start.line).sort((a, b) => a - b), expected,
                        `bridge=${bridge}: virtual implementations must follow native descendants, not same-name methods`);
                }
                const point = new vscode.Position(1, lines[1].indexOf("Pick") + 1);
                for (const [command, expected] of [["vscode.executeDefinitionProvider", bodyLines[0]], ["vscode.executeDeclarationProvider", 1]]) {
                    const locations = await vscode.commands.executeCommand(command, current.uri, point);
                    assert.deepEqual(locations.map((entry) => entry.range.start.line), [expected],
                        "ordinary navigation retains the statically selected method");
                }
                const editor = await vscode.window.showTextDocument(current);
                const leaf = new vscode.Position(7, lines[7].indexOf("Pick") + 1);
                editor.selection = new vscode.Selection(leaf, leaf);
                for (const expected of [bodyLines[1], bodyLines[0]]) {
                    let listener, timeout;
                    const moved = new Promise((resolve, reject) => {
                        listener = vscode.window.onDidChangeTextEditorSelection((event) => {
                            if (event.textEditor.document.uri.toString() === current.uri.toString() &&
                                event.selections[0]?.start.line === expected) resolve();
                        });
                        timeout = setTimeout(() => reject(new Error(
                            `Go to Base Method did not reach line ${expected}; selection=${JSON.stringify(vscode.window.activeTextEditor?.selection)}`
                        )), DOCUMENT_CHANGE_TIMEOUT_MS);
                    });
                    try {
                        await vscode.commands.executeCommand("freebasic.goToBaseMethod");
                        await moved;
                    } finally {
                        listener.dispose();
                        clearTimeout(timeout);
                    }
                    const active = vscode.window.activeTextEditor;
                    assert.equal(active?.document.uri.toString(), current.uri.toString());
                    assert.deepEqual([active.selection.start.line, active.selection.start.character],
                        [expected, lines[expected].lastIndexOf("Pick")],
                        `bridge=${bridge}: Go to Base Method must select the immediate base's terminal method name, got ${JSON.stringify(active.selection)}`);
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(filePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("qualified project navigation retains native terminal-name targets", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-qualified-navigation-"));
        const headerPath = path.join(directory, "api.bi"), implementationPath = path.join(directory, "implementation.bas");
        const callerPath = path.join(directory, "caller.bas");
        const header = ["Namespace Api", "Declare Function Adjust Overload(ByVal value As Long) As Long",
            "Declare Function Adjust Overload(ByVal value As Double) As Long", "Type Worker", "    value As Long",
            "    Declare Function Adjust(ByVal value As Long) As Long", "End Type", "End Namespace",
            "Namespace Other", "Declare Function Adjust(ByVal value As Long) As Long", "End Namespace", ""].join("\n");
        const signatures = ["Api.Adjust(ByVal value As Long)", "Api.Adjust(ByVal value As Double)",
            "Api.Worker.Adjust(ByVal value As Long)", "Other.Adjust(ByVal value As Long)"];
        const implementation = ['#include "api.bi"', ...signatures.flatMap((signature) =>
            [`Function ${signature} As Long`, "    Return CLng(value)", "End Function"]), ""].join("\n");
        const caller = '#include "api.bi"\nPrint Api.Adjust(CLng(1))\nDim item As Api.Worker\nPrint item.Adjust(2)\n';
        const sources = [[headerPath, header], [implementationPath, implementation], [callerPath, caller]];
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "qualified", modules: [callerPath, implementationPath] }]],
                ["analysis.activeContext", { name: "qualified", module: callerPath }], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const [anchor, prototype, body] of [["Api.Adjust", 1, 1], ["item.Adjust", 5, 7]]) {
                    for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider", "vscode.executeImplementationProvider"]) {
                        const locations = await vscode.commands.executeCommand(command, current.uri, position(current, anchor, anchor.indexOf("Adjust") + 1));
                        const declaration = command === "vscode.executeDeclarationProvider";
                        const line = declaration ? prototype : body;
                        const column = (declaration ? header : implementation).split("\n")[line].indexOf("Adjust");
                        assert.deepEqual(locations.map((entry) => [entry.uri.fsPath, entry.range.start.line,
                            entry.range.start.character, entry.range.end.character]),
                        [[declaration ? headerPath : implementationPath, line, column, column + "Adjust".length]],
                        `${command}, bridge=${bridge}, ${anchor}: only the selected terminal name may be targeted`);
                    }
                }
            }
            assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === implementationPath), false);
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project virtual implementations follow closed active-build override bodies", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-project-overrides-"));
        const headerPath = path.join(directory, "api.bi"), implementationPath = path.join(directory, "implementation.bas");
        const callerPath = path.join(directory, "caller.bas");
        const header = ["Type BasePicker Extends Object", "Declare Virtual Function Pick(ByVal value As Long) As Long", "End Type",
            "Type ChildPicker Extends BasePicker", "Declare Virtual Function Pick(ByVal value As Long) As Long Override", "End Type",
            "Type LeafPicker Extends ChildPicker", "Declare Function Pick(ByVal value As Long) As Long Override", "End Type",
            "Type UnrelatedPicker Extends Object", "Declare Virtual Function Pick(ByVal value As Long) As Long", "End Type", ""].join("\n");
        const caller = ['#include "api.bi"', "Function BasePicker.Pick(ByVal value As Long) As Long", "Return value", "End Function",
            "Dim basePointer As BasePicker Ptr", "Print basePointer->Pick(1)", "Dim childPointer As ChildPicker Ptr", "Print childPointer->Pick(2)",
            "Dim leafPointer As LeafPicker Ptr", "Print leafPointer->Pick(3)", ""].join("\n");
        const implementation = ['#include "api.bi"', "#ifdef ALTERNATE", "Function ChildPicker.Pick(ByVal value As Long) As Long", "Return value + 1", "End Function",
            "#else", "Function ChildPicker.Pick(ByVal value As Long) As Long", "Return value", "End Function", "#endif",
            "Function LeafPicker.Pick(ByVal value As Long) As Long", "Return value", "End Function",
            "Function UnrelatedPicker.Pick(ByVal value As Long) As Long", "Return value", "End Function", ""].join("\n");
        const sources = [[headerPath, header], [implementationPath, implementation], [callerPath, caller]];
        const keys = (values) => values.map((entry) => JSON.stringify(entry)).sort();
        try {
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "normal", modules: [callerPath, implementationPath] },
                    { name: "alternate", modules: [callerPath, implementationPath], arguments: ["-d", "ALTERNATE"] }]],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const alternate of [false, true]) {
                    await configuration.update("analysis.activeContext", { name: alternate ? "alternate" : "normal", module: callerPath }, vscode.ConfigurationTarget.Global);
                    const childLine = alternate ? 2 : 6;
                    for (const [anchor, expected] of [["basePointer->Pick", [[callerPath, 1], [implementationPath, childLine], [implementationPath, 10]]],
                        ["childPointer->Pick", [[implementationPath, childLine], [implementationPath, 10]]]]) {
                        const locations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", current.uri,
                            position(current, anchor, anchor.indexOf("Pick") + 1));
                        const actual = locations.map((entry) => [entry.uri.fsPath, entry.range.start.line]);
                        assert.deepEqual(keys(actual), keys(expected), `bridge=${bridge}, alternate=${alternate}, ${anchor}: ${JSON.stringify(actual)}`);
                    }
                    if (!alternate) for (const [command, expected] of [["vscode.executeDefinitionProvider", [callerPath, 1]],
                        ["vscode.executeDeclarationProvider", [headerPath, 1]]]) {
                        const locations = await vscode.commands.executeCommand(command, current.uri, position(current, "basePointer->Pick", "basePointer->".length + 1));
                        assert.deepEqual(locations.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [expected]);
                    }
                }
            }
            assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === implementationPath), false);
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const alternate of [false, true]) {
                    await configuration.update("analysis.activeContext", { name: alternate ? "alternate" : "normal", module: callerPath }, vscode.ConfigurationTarget.Global);
                    const editor = await vscode.window.showTextDocument(current);
                    const point = position(current, "leafPointer->Pick", "leafPointer->".length + 1);
                    editor.selection = new vscode.Selection(point, point);
                    const expected = alternate ? 2 : 6;
                    let listener, timeout;
                    const moved = new Promise((resolve) => {
                        listener = vscode.window.onDidChangeTextEditorSelection((event) => {
                            if (event.textEditor.document.uri.fsPath === implementationPath && event.selections[0]?.start.line === expected) resolve();
                        });
                    });
                    try {
                        await vscode.commands.executeCommand("freebasic.goToBaseMethod");
                        await Promise.race([moved, new Promise((_, reject) => {
                            timeout = setTimeout(() => reject(new Error("Go to Base Method did not select its project body")), DOCUMENT_CHANGE_TIMEOUT_MS);
                        })]);
                        assert.equal(vscode.window.activeTextEditor.selection.start.character, implementation.split("\n")[expected].lastIndexOf("Pick"));
                    } finally { listener.dispose(); clearTimeout(timeout); }
                }
            }
            assert.equal(current.isDirty, false);
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("native constructor argument navigation retains selected overloads", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const constructorUri = vscode.Uri.file(path.join(__dirname, "workspace/implicit-argument-constructor.bas"));
        const current = await vscode.workspace.openTextDocument(constructorUri);
        const original = current.getText();
        try {
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const [argument, typeName] of [["17", "Long"], ["2.5", "Double"]]) {
                    const point = position(current, `takeArgument(${argument})`, "takeArgument(".length);
                    for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider", "vscode.executeImplementationProvider"]) {
                        const entries = await vscode.commands.executeCommand(command, constructorUri, point);
                        const label = `${command}, ${typeName}, bridge=${bridge}`;
                        assert.equal(entries.length, 1, label);
                        assert.equal(entries[0].uri.toString(), constructorUri.toString(), label);
                        const prefix = command === "vscode.executeDeclarationProvider" ? "Declare Constructor" : "Constructor ArgumentValue";
                        assert.match(current.lineAt(entries[0].range.start.line).text,
                            new RegExp(`^\\s*${prefix}\\(ByVal initial As ${typeName}\\)`, "i"), label);
                    }
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(current.getText(), original);
            assert.equal(fs.readFileSync(constructorUri.fsPath, "utf8"), original);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("native hover exposes declaration facts on first use", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-first-hover-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = ["Type HoverLayout", "    prefix As Byte", "    amount As Long", "End Type",
            "Dim values(2 To 5, 1 To 3) As Long", "Dim instance As HoverLayout", "Sub InspectValue(ByVal valueCount As Long)",
            "    Print valueCount", "End Sub", "InspectValue(values(2, 1))", "Print instance.amount", "Print 2 + 3",
            "Namespace HoverStorage", "Dim Shared macroValue As Long", "End Namespace",
            "#define HOVER_ALIAS HoverStorage.macroValue", "#define macroValue() HoverStorage.macroValue",
            "Print HOVER_ALIAS", "Print macroValue()", "Const HOVER_ANSWER As ULongInt = 42",
            "Enum HoverMode", "HOVER_FAST = 7", "End Enum", "Print HOVER_ANSWER, HOVER_FAST", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                // Keep this document inactive so background coloring cannot
                // acquire bindings. Exercise an expression-only stock hover
                // before declaration hovers request the layout metadata.
                const expression = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                    position(current, "Print 2 + 3", "Print 2 ".length));
                assert.match(expression.flatMap((hover) => hover.contents.map((content) => content.value || String(content))).join("\n"),
                    /Compiler type: `[^`]+`/i, `bridge=${bridge}: the initial expression hover must retain native types`);
                for (const [spelling, relative, expected] of [
                    ["Dim values", "Dim ".length + 2, [/array bounds[^\n]*2 to 5[^\n]*1 to 3/i, /storage width[^\n]*4 bytes/i]],
                    ["amount As Long", 2, [/field offset[^\n]*4 bytes/i]],
                    ["Sub InspectValue(ByVal valueCount", "Sub InspectValue(ByVal ".length + 2, [/parameter passing: ByVal/i]],
                    ["Type HoverLayout", "Type ".length + 2, [/aggregate layout[^\n]*8 bytes/i]]
                ]) {
                    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri, position(current, spelling, relative));
                    const text = hovers.flatMap((hover) => hover.contents.map((content) => content.value || String(content))).join("\n");
                    for (const pattern of expected) assert.match(text, pattern, `bridge=${bridge}, ${spelling}`);
                }
                if (!bridge) for (const spelling of ["Print HOVER_ALIAS", "Print macroValue()"]) {
                    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                        position(current, spelling, "Print ".length + 1));
                    const text = hovers.flatMap((hover) => hover.contents.map((content) => content.value || String(content))).join("\n");
                    assert.match(text, /Compiler-selected macro signature:/i, spelling);
                    assert.match(text, /HoverStorage\.macroValue/i, "cached data hover must not replace macro definitions");
                }
                if (!bridge) for (const [anchor, relative, value] of [["Const HOVER_ANSWER", "Const ".length + 2, "42"],
                    ["Print HOVER_ANSWER", "Print ".length + 2, "42"], ["HOVER_FAST = 7", 2, "7"],
                    ["Print HOVER_ANSWER, HOVER_FAST", "Print HOVER_ANSWER, ".length + 2, "7"]]) {
                    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                        position(current, anchor, relative));
                    const text = hovers.flatMap((hover) => hover.contents.map((content) => content.value || String(content))).join("\n");
                    assert.ok(text.includes(`Compiler constant value in this context: \`${value}\``),
                        `${anchor}: symbol declarations and references must retain their native values`);
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("native occurrence queries retain references and read-write highlights", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-native-occurrences-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = ["#define OCCURRENCE_VALUE 42", "Dim sharedValue As Long", "sharedValue = OCCURRENCE_VALUE",
            "sharedValue += 1", "Print sharedValue, OCCURRENCE_VALUE", ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            for (const bridge of [false, true]) {
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                for (const [name, point, lines] of [
                    ["sharedValue", new vscode.Position(4, "Print ".length + 2), [1, 2, 3, 4]],
                    ["OCCURRENCE_VALUE", new vscode.Position(2, "sharedValue = ".length + 2), [0, 2, 4]]
                ]) {
                    const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri, point);
                    assert.ok(references.every((entry) => entry.uri.toString() === current.uri.toString()));
                    assert.deepEqual(references.map((entry) => entry.range.start.line).sort((a, b) => a - b), lines, `${name}, bridge=${bridge}`);
                    assert.ok(references.every((entry) => current.getText(entry.range) === name));
                    const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", current.uri, point);
                    assert.deepEqual(highlights.map((entry) => entry.range.start.line).sort((a, b) => a - b), lines, `${name}, bridge=${bridge}`);
                    if (name === "sharedValue") {
                        assert.deepEqual(highlights.filter((entry) => entry.kind === vscode.DocumentHighlightKind.Write)
                            .map((entry) => entry.range.start.line).sort((a, b) => a - b), [2, 3],
                            `bridge=${bridge}: ${JSON.stringify(highlights.map((entry) => [entry.range.start.line, entry.kind]))}`);
                        assert.equal(highlights.find((entry) => entry.range.start.line === 4)?.kind, vscode.DocumentHighlightKind.Read, `bridge=${bridge}`);
                    }
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("stock NOKEYWORD highlighting preserves ordinary symbols", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-nokeyword-tokens-"));
        const sourcePath = path.join(directory, "main.bas");
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/option-no-keyword-rem.bas"), "utf8");
        try {
            fs.writeFileSync(sourcePath, source);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", ["-lang", "deprecated"], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            const result = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", current.uri);
            assert.ok(result?.data.length);
            const { TOKEN_TYPES } = require(path.join(extension.extensionPath, "lib/semantic-token-data"));
            const records = new Map();
            let line = 0, character = 0;
            for (let index = 0; index < result.data.length; index += 5) {
                line += result.data[index];
                character = result.data[index] ? result.data[index + 1] : character + result.data[index + 1];
                records.set(`${line}:${character}`, result.data[index + 3]);
            }
            for (const [sourceLine, text] of source.split("\n").entries()) {
                for (const match of text.matchAll(/\b(REM|otherValue|RemIdentifierProbe|OtherIdentifierProbe)\b/g)) {
                    const key = `${sourceLine}:${match.index}`;
                    if (/^\s*'/.test(text) || /^\s*Option NoKeyword/i.test(text)) {
                        assert.equal(records.has(key), false, "comments and option operands are not variable uses");
                    } else {
                        const expected = /Probe$/.test(match[0]) ? "function" : "variable";
                        assert.equal(records.get(key), TOKEN_TYPES.indexOf(expected), `missing ${match[0]} at ${key}`);
                    }
                }
            }
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("native NOKEYWORD type navigation preserves disabled identifiers", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-nokeyword-types-"));
        const sourcePath = path.join(directory, "main.bas");
        const uri = vscode.Uri.file(sourcePath);
        let current;
        const keywordDeclaration = "Declare Sub IF(ByVal amount As Long, ByVal scale As Double)";
        const source = "\uFEFF" + ["#lang \"fblite\"", "#if 1", "Option NoKeyword REM, IF, Abs", "#endif",
            "Type KeywordPayload", "    value As Long", "End Type",
            "Declare Sub Work(ByVal amount As Long, ByVal scale As Long)", keywordDeclaration, "Dim REM As KeywordPayload",
            "Dim Abs(2) As Long", "Print Abs(0)", "Print Sin(0.5)",
            "Print REM.value", "Work(REM.value, 2)", "Work REM.value, 2",
            "IF 1, 2", "IF(1, 2)", "IF 1, _", "    2",
            "Print REM.value /' block starts after the disabled keyword", "Work(1, 2)", "'/",
            "' REM", 'Print "REM"', ""].join("\n");
        try {
            fs.writeFileSync(sourcePath, source);
            current = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(current);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            const conditionalPath = path.join(directory, "conditional.bas");
            const conditionalSource = ['#lang "fblite"', "Option NoKeyword Abs", "#ifdef FUNCTION_BUILD",
                "Declare Function Abs Overload(ByVal amount As Long) As Long",
                "Declare Function Abs Overload(ByVal amount As Double) As Double", "#else",
                "Dim Abs(2) As Long", "#endif", "Print Abs(0)", "Print Sin(0.5)", ""].join("\n");
            fs.writeFileSync(conditionalPath, conditionalSource);
            const conditional = await vscode.workspace.openTextDocument(vscode.Uri.file(conditionalPath));
            await vscode.window.showTextDocument(conditional);
            const conditionalHelp = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", conditional.uri,
                position(conditional, "Print Abs(0)", "Print Abs(".length));
            assert.equal(conditionalHelp?.signatures.length, 1);
            assert.match(conditionalHelp.signatures[0].label, /^Array Abs\(index1: 0 To 2\)$/i,
                "a first stock binding probe must replace inactive source procedures with native array help");
            const callbackPath = path.join(directory, "conditional-callback.bas");
            fs.writeFileSync(callbackPath, ["#ifdef PROCEDURE_BUILD",
                "Declare Function Choose Overload(ByVal amount As Long) As Long",
                "Declare Function Choose Overload(ByVal amount As Double) As Double", "#else",
                "Dim Choose As Function(ByVal amount As Long) As Double", "#endif", "Print Choose(1)", ""].join("\n"));
            const callback = await vscode.workspace.openTextDocument(vscode.Uri.file(callbackPath));
            await vscode.window.showTextDocument(callback);
            const callbackHelp = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", callback.uri,
                position(callback, "Print Choose(1)", "Print Choose(".length));
            assert.equal(callbackHelp?.signatures.length, 1, "native callback types must replace conditional source procedures");
            assert.equal(callbackHelp.signatures[0].label, "Function Choose(as long) as double");
            assert.equal(callbackHelp.signatures[0].label.slice(...callbackHelp.signatures[0].parameters[0].label), "as long");
            const hoverPath = path.join(directory, "conditional-hover.bas");
            fs.writeFileSync(hoverPath, ["#ifdef PROCEDURE_BUILD",
                "Declare Function Chosen Overload(ByVal amount As Long) As Long",
                "Declare Function Chosen Overload(ByVal amount As Double) As Double", "#else",
                "Dim Chosen As Long", "#endif", "Print Chosen", ""].join("\n"));
            const hoverDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(hoverPath));
            await vscode.window.showTextDocument(hoverDocument);
            const selectedHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", hoverDocument.uri,
                position(hoverDocument, "Print Chosen", "Print C".length));
            const selectedHoverText = selectedHover.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n");
            assert.match(selectedHoverText, /Dim Chosen As Long/i);
            assert.doesNotMatch(selectedHoverText, /Declare Function Chosen/i,
                "native value identity must suppress inactive conditional procedures on first hover");
            const guardedHeaderPath = path.join(directory, "guarded-choice.bi");
            fs.writeFileSync(guardedHeaderPath, ["#ifndef GUARDED_CHOICE_BI", "#define GUARDED_CHOICE_BI",
                "Declare Function GuardedChoice Overload(ByVal amount As Long) As Long",
                "Declare Function GuardedChoice Overload(ByVal amount As Double) As Long", "#endif", ""].join("\n"));
            const guardedPath = path.join(directory, "guarded-choice.bas");
            fs.writeFileSync(guardedPath, '#include "guarded-choice.bi"\nPrint GuardedChoice(CDbl(1))\n');
            const guarded = await vscode.workspace.openTextDocument(vscode.Uri.file(guardedPath));
            await vscode.window.showTextDocument(guarded);
            const guardedHovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", guarded.uri,
                position(guarded, "GuardedChoice(CDbl(1))", 2));
            const guardedText = guardedHovers.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n");
            assert.match(guardedText, /ByVal amount As Double/i);
            assert.doesNotMatch(guardedText, /ByVal amount As Long/i,
                "a native declaration site must select the active guarded overload even when return types are identical");
            const operatorHeaderPath = path.join(directory, "guarded-operators.bi");
            fs.writeFileSync(operatorHeaderPath, ["#ifndef GUARDED_OPERATORS_BI", "#define GUARDED_OPERATORS_BI",
                "Type GuardedOperand", "    value As Long", "End Type",
                "Operator +(ByRef value As GuardedOperand, ByVal amount As Long) As Long",
                "    Return amount", "End Operator",
                "Operator +(ByRef value As GuardedOperand, ByVal amount As Double) As Long",
                "    Return CLng(amount)", "End Operator", "#endif", ""].join("\n"));
            const operatorPath = path.join(directory, "guarded-operators.bas");
            fs.writeFileSync(operatorPath, '#include "guarded-operators.bi"\nDim item As GuardedOperand\nPrint item + CDbl(1)\n');
            const operatorDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(operatorPath));
            await vscode.window.showTextDocument(operatorDocument);
            const operatorPosition = position(operatorDocument, "item + CDbl(1)", "item ".length);
            const operatorHovers = await vscode.commands.executeCommand("vscode.executeHoverProvider",
                operatorDocument.uri, operatorPosition);
            const operatorText = operatorHovers.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n");
            assert.match(operatorText, /ByVal amount As Double/i);
            assert.doesNotMatch(operatorText, /ByVal amount As Long/i,
                "a guarded operator hover must use the native-selected overload");
            const operatorDefinitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider",
                operatorDocument.uri, operatorPosition);
            assert.equal(operatorDefinitions.length, 1);
            assert.equal(operatorDefinitions[0].uri.fsPath, operatorHeaderPath);
            assert.equal(operatorDefinitions[0].range.start.line, 8);
            await vscode.window.showTextDocument(current);
            for (const compilerPath of ["", ...(process.env.FBC_EDITOR_EXECUTABLE ? [process.env.FBC_EDITOR_EXECUTABLE] : [])]) {
                await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                if (compilerPath) {
                    const changes = new vscode.WorkspaceEdit();
                    changes.replace(uri, new vscode.Range(position(current, keywordDeclaration),
                        position(current, keywordDeclaration, keywordDeclaration.length)),
                    ["#macro EmitProcedure(procName)",
                        "Declare Sub procName(ByVal amount As Long, ByVal scale As Double)",
                        "#endmacro", "EmitProcedure(IF)"].join("\n"));
                    changes.insert(uri, current.positionAt(current.getText().length), "' bridge overlay\n");
                    assert.equal(await vscode.workspace.applyEdit(changes), true);
                }
                assert.equal(current.isDirty, Boolean(compilerPath), "stock uses saved input; the bridge uses an overlay");
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
                    position(current, "Print REM.value", "Print REM.v".length));
                assert.ok(completions.items.some((item) => item.label === "value" &&
                    item.kind !== vscode.CompletionItemKind.Text), compilerPath || "stock compiler");
                for (const call of ["Work(REM.value,", "Work REM.value,"]) {
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                        position(current, call, call.length));
                    assert.ok(help?.signatures.some((signature) => /\bWork\b/.test(signature.label)), call);
                    assert.equal(help.activeParameter, 1, call);
                }
                for (const call of ["IF 1,", "IF(1,", "IF 1, _"]) {
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                        position(current, call, call.indexOf(",") + 1));
                    assert.equal(help?.signatures.length, 1, "native keyword options must precede source name guards: " + call);
                    assert.match(help.signatures[0].label, /\bIF\(/i);
                    assert.equal(help.activeParameter, 1);
                }
                const arrayHelp = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                    position(current, "Print Abs(0)", "Print Abs(".length));
                assert.equal(arrayHelp?.signatures.length, 1);
                assert.match(arrayHelp.signatures[0].label, /^Array Abs\(index1: 0 To 2\)$/i,
                    "a compiler-bound array must not borrow intrinsic ABS signatures");
                const sineHelp = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                    position(current, "Print Sin(0.5)", "Print Sin(".length));
                assert.ok(sineHelp?.signatures.length, "genuine builtin reference signatures must remain available");
                const commented = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                    position(current, "Work(1, 2)", "Work(1,".length));
                assert.equal(commented?.signatures.length || 0, 0, "REM must not hide the later block-comment opener");
                for (const relative of ["Print R".length, "Print RE".length]) {
                    const selected = position(current, "Print REM.value", relative);
                    const hierarchy = await vscode.commands.executeCommand("vscode.prepareTypeHierarchy", uri, selected);
                    assert.deepEqual(hierarchy.map((item) => item.name), ["KeywordPayload"], compilerPath || "stock compiler");
                    const definitions = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", uri, selected);
                    assert.deepEqual(definitions.map((location) => [location.uri.toString(), location.range.start.line]),
                        [[uri.toString(), position(current, "Type KeywordPayload").line]]);
                }
                for (const selected of [position(current, "' REM", 3), position(current, 'Print "REM"', 8)]) {
                    /* VS Code 1.85's public converter dereferences a null item
                       for an empty hierarchy. Inspect the raw command result
                       for negatives; positives above exercise the public API. */
                    const hierarchy = await vscode.commands.executeCommand("_executePrepareTypeHierarchy", uri, selected);
                    assert.deepEqual((hierarchy || []).filter(Boolean), [], "comment and string spellings have no native type identity");
                    const definitions = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", uri, selected);
                    assert.deepEqual(definitions || [], [], "type navigation must not bind a comment or string by spelling");
                }
                if (compilerPath) {
                    const unfinished = current.getText().replace("Print REM.value", "Print REM.v")
                        .replace("Work(REM.value, 2)", "Work(REM.value, )").replace("IF 1, 2", "IF 1,");
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), unfinished);
                    await applyEditAndWaitForDocuments(edit, [current]);
                    const suggestions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
                        position(current, "Print REM.v", "Print REM.v".length));
                    assert.ok(suggestions.items.some((item) => item.label === "value" &&
                        item.kind !== vscode.CompletionItemKind.Text), "a genuinely unfinished REM receiver must retain native members");
                    const call = "Work(REM.value,";
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                        position(current, call, call.length));
                    assert.ok(help?.signatures.some((signature) => /\bWork\b/.test(signature.label)));
                    assert.equal(help.activeParameter, 1, "missing arguments must retain the native lexical context");
                    const keyword = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                        position(current, "IF 1,", "IF 1,".length));
                    assert.equal(keyword?.signatures.length, 1, "generated disabled-keyword callees retain recovery signatures");
                    assert.equal(keyword.activeParameter, 1);
                    const coldSource = "\uFEFF" + ['#lang "fblite"', "#if 1", "Option NoKeyword IF", "#endif",
                        "#macro EmitProcedure(procName)",
                        "Declare Sub procName(ByVal amount As Long, ByVal scale As Double)",
                        "#endmacro", "EmitProcedure(IF)", "IF 1, 2", ""].join("\n");
                    const coldEdit = new vscode.WorkspaceEdit();
                    coldEdit.replace(uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), coldSource);
                    await applyEditAndWaitForDocuments(coldEdit, [current]);
                    const cold = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                        position(current, "IF 1,", "IF 1,".length));
                    assert.equal(cold?.signatures.length, 1, "a NOKEYWORD hint must acquire native signatures without preceding REM context");
                    assert.equal(cold.activeParameter, 1);
                    const scalarSource = "\uFEFF" + ['#lang "fblite"', "Option NoKeyword Abs", "Sub Work()",
                        "Dim Abs As Long", "Print Abs(1)", "Print Sin(0.5)", "End Sub", ""].join("\n");
                    const scalarEdit = new vscode.WorkspaceEdit();
                    scalarEdit.replace(uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), scalarSource);
                    await applyEditAndWaitForDocuments(scalarEdit, [current]);
                    const scalarHelp = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                        position(current, "Print Abs(1)", "Print Abs(".length));
                    assert.equal(scalarHelp?.signatures.length || 0, 0, "an invalid scalar call must not acquire builtin signatures");
                    const recoveredSine = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                        position(current, "Print Sin(0.5)", "Print Sin(".length));
                    assert.ok(recoveredSine?.signatures.length, "an unrelated failed call must not erase real builtin help");
                }
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            }
        } finally {
            if (current?.isDirty) {
                await vscode.window.showTextDocument(current);
                await vscode.commands.executeCommand("workbench.action.files.revert");
            }
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await check("callable owners drive highlighting, completion, and Call Hierarchy", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-callable-owner-tokens-"));
        let headerPath = path.join(directory, "owners.bi"), sourcePath = path.join(directory, "main.bas");
        const header = "Namespace Helpers\nDeclare Function Calculate() As Long\nDeclare Sub ResetValue()\nEnd Namespace\n" +
            "Type Widget\nnumber As Long\nDeclare Sub Touch()\nDeclare Function ReadValue() As Long\nEnd Type\n";
        const source = '#include "owners.bi"\nFunction Helpers.Calculate() As Long\nReturn 1\nEnd Function\n' +
            "Sub Helpers.ResetValue()\nEnd Sub\nSub Widget.Touch()\nEnd Sub\nFunction Widget.ReadValue() As Long\nReturn number\nEnd Function\n" +
            "Dim value As Widget\nvalue.Touch()\nPrint Helpers.Calculate()\nHelpers.ResetValue()\nPrint value.ReadValue()\n";
        try {
            fs.writeFileSync(headerPath, header);
            fs.writeFileSync(sourcePath, source);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            let headerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
            await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", headerDocument.uri);
            let current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            const { TOKEN_TYPES } = require(path.join(extension.extensionPath, "lib/semantic-token-data"));
            for (const bridge of ["", ...(process.env.FBC_EDITOR_EXECUTABLE ? [process.env.FBC_EDITOR_EXECUTABLE] : [])]) {
                if (bridge) {
                    // A fresh URI keeps backend checks independent of any
                    // source-only Outline result already cached by the editor.
                    const nativeDirectory = path.join(directory, "native");
                    fs.mkdirSync(nativeDirectory);
                    sourcePath = path.join(nativeDirectory, "main.bas");
                    headerPath = path.join(nativeDirectory, "owners.bi");
                    fs.writeFileSync(sourcePath, source);
                    fs.writeFileSync(headerPath, header);
                    await configuration.update("analysis.compilerPath", bridge, vscode.ConfigurationTarget.Global);
                    await configuration.update("analysis.projectContexts", [{ name: "callable-symbols", modules: [sourcePath] }], vscode.ConfigurationTarget.Global);
                    await configuration.update("analysis.activeContext", { name: "callable-symbols", module: sourcePath }, vscode.ConfigurationTarget.Global);
                    await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                    current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                    headerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
                    await vscode.window.showTextDocument(current);
                }
                const result = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", current.uri);
                assert.ok(result?.data.length);
                const records = new Map();
                let line = 0, character = 0;
                for (let index = 0; index < result.data.length; index += 5) {
                    line += result.data[index];
                    character = result.data[index] ? result.data[index + 1] : character + result.data[index + 1];
                    records.set(`${line}:${character}`, result.data[index + 3]);
                }
                for (const [sourceLine, text] of source.split("\n").entries()) {
                    for (const match of text.matchAll(/\b(Calculate|ResetValue|Touch|ReadValue)\b/g)) {
                        const namespace = ["Calculate", "ResetValue"].includes(match[0]);
                        assert.equal(records.get(`${sourceLine}:${match.index}`),
                            TOKEN_TYPES.indexOf(namespace ? "function" : "method"),
                            `${match[0]} at ${sourceLine}, bridge=${Boolean(bridge)}, actual=${TOKEN_TYPES[records.get(`${sourceLine}:${match.index}`)]}`);
                        const hierarchy = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                            new vscode.Position(sourceLine, match.index + 1));
                        assert.equal(hierarchy.length, 1, `${match[0]} at ${sourceLine}, bridge=${Boolean(bridge)}`);
                        assert.equal(hierarchy[0].kind, namespace ? vscode.SymbolKind.Function : vscode.SymbolKind.Method,
                            "Call Hierarchy must use the resolved namespace/type owner, not a dotted-name guess");
                    }
                }
                for (const [text, prefix, name, kind] of [
                    ["Print Helpers.Calculate()", "Print Helpers.", "Calculate", vscode.CompletionItemKind.Function],
                    ["Helpers.ResetValue()", "Helpers.", "ResetValue", vscode.CompletionItemKind.Function],
                    ["value.Touch()", "value.", "Touch", vscode.CompletionItemKind.Method],
                    ["Print value.ReadValue()", "Print value.", "ReadValue", vscode.CompletionItemKind.Method]
                ]) {
                    const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                        position(current, text, prefix.length));
                    assert.equal(completions.items.find((item) => item.label === name)?.kind, kind,
                        "completion kinds must agree with the resolved callable owner");
                }
                const headerSymbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", headerDocument.uri);
                const flattened = [];
                const collect = (symbols) => { for (const symbol of symbols) { flattened.push(symbol); collect(symbol.children || []); } };
                collect(headerSymbols);
                for (const [name, kind] of [["Calculate", vscode.SymbolKind.Function], ["ResetValue", vscode.SymbolKind.Function],
                    ["Touch", vscode.SymbolKind.Method], ["ReadValue", vscode.SymbolKind.Method]]) {
                    assert.equal(flattened.find((entry) => entry.name === name)?.kind, kind,
                        "Outline must distinguish namespace procedures from aggregate methods");
                }
                if (bridge) {
                    const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", current.uri);
                    flattened.length = 0;
                    collect(symbols);
                    const methodLine = position(current, "Function Widget.ReadValue()").line;
                    assert.equal(flattened.find((entry) => entry.selectionRange.start.line === methodLine)?.kind, vscode.SymbolKind.Method,
                        `native implementation kinds: ${JSON.stringify(flattened.map((entry) => [entry.name, entry.selectionRange.start.line, entry.kind]))}`);
                }
                for (const [name, kind] of [["ResetValue", vscode.SymbolKind.Function], ["ReadValue", vscode.SymbolKind.Method]]) {
                    const symbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", name);
                    const declared = symbols.filter((entry) => entry.location.uri.fsPath === headerPath);
                    assert.ok(declared.length);
                    assert.ok(declared.every((entry) => entry.kind === kind), "workspace symbols must preserve callable ownership");
                    if (bridge) {
                        const implementationLine = position(current, name === "ReadValue" ? "Function Widget.ReadValue()" : "Sub Helpers.ResetValue()").line;
                        assert.ok(symbols.some((entry) => entry.location.uri.fsPath === sourcePath &&
                            entry.location.range.start.line === implementationLine && entry.kind === kind),
                        "native workspace search must retain the implementation's compiler-owned callable kind");
                    }
                }
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
                assert.equal(fs.readFileSync(headerPath, "utf8"), header);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EDITOR_EXECUTABLE) await check("native Outline completes its first active-editor compiler request", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-cold-outline-"));
        const filePath = path.join(directory, "main.bas");
        const source = '#if 1\nNamespace ColdOutline\nType ReadyValue\nnumber As Long\n' +
            'Declare Operator [](ByVal index As Long) As Long\nDeclare Operator Cast() As Long\nEnd Type\n' +
            'Sub ReadyProcedure()\nDim localValue As Long\nEnd Sub\nEnd Namespace\n#else\n' +
            'Type InactiveOutlineValue\nnumber As Long\nEnd Type\n#endif\n';
        try {
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", "", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            fs.writeFileSync(filePath, source);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const version = current.version;
            // No manual analysis or retry warms the compiler snapshot first.
            const pending = vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", current.uri);
            await vscode.window.showTextDocument(current);
            const symbols = await pending;
            const namespace = symbols?.find((symbol) => symbol.name === "ColdOutline");
            assert.ok(namespace, "the first native Outline request must finish despite activation refreshes");
            assert.ok(namespace.children.some((symbol) => symbol.name === "ReadyValue"));
            assert.ok(namespace.children.some((symbol) => symbol.name === "ReadyProcedure"));
            const valueType = namespace.children.find((symbol) => symbol.name === "ReadyValue");
            const indexed = valueType.children.find((symbol) => symbol.name === "Operator []");
            const cast = valueType.children.find((symbol) => symbol.name === "Operator Cast");
            assert.ok(indexed && cast, "native Outline must show complete operator labels under their native type");
            const bracket = position(current, "Declare Operator []", "Declare Operator ".length);
            assert.ok(indexed.selectionRange.isEqual(new vscode.Range(bracket, bracket.translate(0, 2))),
                "native Outline must select both index-operator brackets");
            assert.equal(symbols.some((symbol) => symbol.name === "InactiveOutlineValue"), false);
            assert.equal(current.version, version);
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(filePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EDITOR_EXECUTABLE) await check("Outline refreshes unchanged documents after compiler context changes", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run", "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-outline-refresh-"));
        const sourcePath = path.join(directory, "main.bas");
        const headerPath = path.join(directory, "flags.bi");
        const source = '#include "flags.bi"\n#ifdef PRIMARY_BUILD\nType PrimaryOutlineType\nnumber As Long\nEnd Type\n#else\n' +
            "Type SecondaryOutlineType\nnumber As Long\nEnd Type\n#endif\n";
        try {
            fs.writeFileSync(sourcePath, source);
            fs.writeFileSync(headerPath, "");
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [
                { name: "outline-primary", modules: [sourcePath], arguments: ["-d", "PRIMARY_BUILD"] },
                { name: "outline-secondary", modules: [sourcePath] }
            ], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(current);
            const version = current.version;
            // A watcher can retire a snapshot between requests. Poll through
            // the provider's empty response, but still require the exact names.
            const names = async () => ((await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", current.uri)) || [])
                .map((entry) => entry.name).sort();
            const expectNames = async (expected) => {
                const deadline = Date.now() + 5000;
                let actual;
                do {
                    actual = await names();
                    if (actual.length === 1 && actual[0] === expected) break;
                    await new Promise((resolve) => setTimeout(resolve, 50));
                } while (Date.now() < deadline);
                assert.deepEqual(actual, [expected], "Outline must follow the current compiler snapshot without a text edit");
                assert.equal(current.version, version);
                assert.equal(current.isDirty, false);
            };
            assert.deepEqual(await names(), ["PrimaryOutlineType", "SecondaryOutlineType"]);
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            for (const [context, expected] of [["outline-primary", "PrimaryOutlineType"], ["outline-secondary", "SecondaryOutlineType"]]) {
                await configuration.update("analysis.activeContext", { name: context, module: sourcePath }, vscode.ConfigurationTarget.Global);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                await expectNames(expected);
            }
            // No settings or root-buffer change accompanies this new snapshot.
            fs.writeFileSync(headerPath, "#define PRIMARY_BUILD\n");
            assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
            await expectNames("PrimaryOutlineType");
            assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE) await check("inlay hints follow compiler contexts without editing the document", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-inlay-refresh-"));
        const headerSource = '#ifdef PRIMARY_HINTS\nSub RefreshHintTarget(ByVal primaryValue As Long)\nEnd Sub\n' +
            'Function RefreshHintValue() As Long\nReturn 1\nEnd Function\n#else\n' +
            'Sub RefreshHintTarget(ByVal secondaryValue As Double)\nEnd Sub\n' +
            'Function RefreshHintValue() As Double\nReturn 1.5\nEnd Function\n#endif\n';
        const source = '#include "api.bi"\nVar selectedResult = RefreshHintValue()\nRefreshHintTarget(7)\n';
        try {
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            for (const backend of [...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                const backendDirectory = path.join(directory, backend);
                fs.mkdirSync(backendDirectory);
                const filePath = path.join(backendDirectory, "main.bas");
                const headerPath = path.join(backendDirectory, "api.bi");
                fs.writeFileSync(filePath, source);
                fs.writeFileSync(headerPath, headerSource);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [
                    { name: "hint-primary", modules: [filePath], arguments: ["-d", "PRIMARY_HINTS"] },
                    { name: "hint-secondary", modules: [filePath] }
                ], vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                const version = current.version;
                const range = new vscode.Range(0, 0, current.lineCount - 1, 0);
                assert.deepEqual(await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri, range), [],
                    "the provider starts empty before compiler facts are available");
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                for (const [context, type, parameter] of [["hint-primary", "Long", "primaryValue:"], ["hint-secondary", "Double", "secondaryValue:"]]) {
                    await configuration.update("analysis.activeContext", { name: context, module: filePath }, vscode.ConfigurationTarget.Global);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true, `${backend}: ${context}`);
                    const hints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri, range);
                    const labels = hints.map((hint) => typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join(""));
                    assert.ok(labels.some((label) => new RegExp(`:\\s*${type}\\b`, "i").test(label)), `${backend}: ${context}: ${labels}`);
                    assert.ok(labels.includes(parameter), `${backend}: ${context}: ${labels}`);
                    assert.equal(labels.includes(parameter === "primaryValue:" ? "secondaryValue:" : "primaryValue:"), false);
                    const parameterHint = hints.find((hint) => Array.isArray(hint.label) && hint.label[0]?.value === parameter);
                    assert.ok(parameterHint, `${backend}: the parameter hint must expose a navigable label part`);
                    const target = parameterHint.label[0].location;
                    assert.equal(target?.uri.fsPath, headerPath);
                    const parameterName = parameter.slice(0, -1);
                    const headerLines = headerSource.split("\n");
                    const parameterLine = headerLines.findIndex((line) => line.includes(`ByVal ${parameterName} `));
                    assert.ok(target.range.isEqual(new vscode.Range(parameterLine, headerLines[parameterLine].indexOf(parameterName),
                        parameterLine, headerLines[parameterLine].indexOf(parameterName) + parameterName.length)),
                    `${backend}: hint navigation must follow the selected header branch`);
                    const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", target.uri, target.range.start);
                    assert.ok(definitions.some((entry) => entry.uri.fsPath === headerPath && entry.range.isEqual(target.range)),
                        `${backend}: the hint's target must support ordinary parameter navigation`);
                    assert.equal(current.version, version);
                    assert.equal(current.isDirty, false);
                }
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
                assert.equal(fs.readFileSync(headerPath, "utf8"), headerSource);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE) await check("constant IF hints follow compiler predicates and unsaved edits", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-constant-if-"));
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/constant-condition-hints.bas"), "utf8");
        try {
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            for (const backend of [...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                const filePath = path.join(directory, `${backend}.bas`);
                fs.writeFileSync(filePath, source);
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                const range = new vscode.Range(0, 0, current.lineCount - 1, 0);
                const hints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri, range);
                const conditions = hints.filter((hint) => typeof hint.label === "string" && /^always (?:true|false)$/.test(hint.label));
                const expected = [["If 0", false], ["ElseIf 2 + 2 = 4", true], ["If 1", true],
                    ["If 3 <> 3", false], ["4 = 4", true]].map(([spelling, value]) => {
                    const position = current.positionAt(source.indexOf(spelling) + spelling.length);
                    return [position.line, position.character, `always ${value}`];
                });
                assert.deepEqual(conditions.map((hint) => [hint.position.line, hint.position.character, hint.label]), expected,
                    `${backend}: cold inlay requests must use the compiler's original predicates`);
                assert.equal(current.isDirty, false);
                if (backend === "bridge") {
                    const edit = new vscode.WorkspaceEdit();
                    const first = current.positionAt(source.indexOf("If 0 Then") + "If ".length);
                    edit.replace(current.uri, new vscode.Range(first, first.translate(0, 1)), "1");
                    assert.equal(await vscode.workspace.applyEdit(edit), true);
                    assert.equal(current.isDirty, true);
                    const updated = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri, range);
                    assert.equal(updated.find((hint) => hint.position.line === first.line)?.label, "always true",
                        "an unsaved condition must replace the saved compiler result");
                    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
                }
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE) await check("include links follow compiler contexts without editing the document", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "includePaths", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-link-refresh-"));
        const source = '#ifdef FIRST_LINK\n#include once "selected.bi"\n#else\n#include once "selected.bi"\n#endif\nPrint selectedIncludeValue\n';
        try {
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("includePaths", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            for (const backend of [...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                const backendDirectory = path.join(directory, backend);
                fs.mkdirSync(backendDirectory);
                const filePath = path.join(backendDirectory, "main.bas");
                fs.writeFileSync(filePath, source);
                for (const [name, value] of [["first", 1], ["second", 2]]) {
                    fs.mkdirSync(path.join(backendDirectory, name));
                    fs.writeFileSync(path.join(backendDirectory, name, "selected.bi"), `Const selectedIncludeValue = ${value}\n`);
                }
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", ["first", "second"].map((name) => ({ name,
                    modules: [filePath], arguments: [...(name === "first" ? ["-d", "FIRST_LINK"] : []), "-i", path.join(backendDirectory, name)]
                })), vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                const version = current.version;
                for (const [name, line] of [["first", 1], ["second", 3]]) {
                    await configuration.update("analysis.activeContext", { name, module: filePath }, vscode.ConfigurationTarget.Global);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true, `${backend}: ${name}`);
                    const links = await waitForDocumentLinks(current.uri);
                    assert.equal(links?.length, 1, `${backend}: ${name}: only the active include has a link`);
                    assert.equal(links[0].target.fsPath, path.join(backendDirectory, name, "selected.bi"));
                    assert.equal(links[0].range.start.line, line);
                    // Older executeLinkProvider adapters omit the tooltip.
                    if (typeof links[0].tooltip === "string") assert.match(links[0].tooltip, /Resolved by FreeBASIC/);
                    assert.equal(current.version, version);
                    assert.equal(current.isDirty, false);
                }
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await check("source navigation and rename isolate unrelated declaration families", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-source-rename-families-"));
        const paths = {
            common: path.join(directory, "common.bi"), headerA: path.join(directory, "a/api.bi"), headerB: path.join(directory, "b/api.bi"),
            extraA: path.join(directory, "a/extra.bi"),
            moduleA: path.join(directory, "a/main.bas"), moduleB: path.join(directory, "b/main.bas"), consumer: path.join(directory, "a/consumer.bas")
        };
        const operators = "Type FamilyOperatorRecord\nnumber As Long\nDeclare Operator Cast() As Long\n" +
            "Declare Operator Cast() As Long Ptr\nDeclare Operator [](ByVal index As Long) ByRef As Long\n" +
            "Declare Operator [](ByVal index As Long Ptr) ByRef As Long\nDeclare Constructor()\nDeclare Constructor(ByVal initial As Long)\nEnd Type\n" +
            "Declare Operator +(ByRef value As FamilyOperatorRecord, ByVal other As Long) As FamilyOperatorRecord\n" +
            "Declare Operator +(ByRef value As FamilyOperatorRecord, ByVal other As Long Ptr) As FamilyOperatorRecord\n" +
            "Declare Sub ShapeDimensionProbe Overload(values(Any) As Long)\nDeclare Sub ShapeDimensionProbe Overload(values(Any, Any) As Long)\n";
        const operatorBodies = "Operator FamilyOperatorRecord.Cast() As Long\nReturn number\nEnd Operator\n" +
            "Operator FamilyOperatorRecord.Cast() As Long Ptr\nReturn @number\nEnd Operator\n" +
            "Operator FamilyOperatorRecord.[](ByVal index As Long) ByRef As Long\nReturn number\nEnd Operator\n" +
            "Operator FamilyOperatorRecord.[](ByVal index As Long Pointer) ByRef As Long\nReturn number\nEnd Operator\n" +
            "Operator +(ByRef value As FamilyOperatorRecord, ByVal other As Long) As FamilyOperatorRecord\nReturn value\nEnd Operator\n" +
            "Operator +(ByRef value As FamilyOperatorRecord, ByVal other As Long Pointer) As FamilyOperatorRecord\nReturn value\nEnd Operator\n" +
            "Sub ShapeDimensionProbe(values( any ) As Long)\nEnd Sub\nSub ShapeDimensionProbe(values(any,any) As Long)\nEnd Sub\n" +
            "Constructor FamilyOperatorRecord()\nnumber = 0\nEnd Constructor\n" +
            "Constructor FamilyOperatorRecord(ByVal initial As Long)\nnumber = initial\nEnd Constructor\n" +
            "Dim constructedFamilyValue As FamilyOperatorRecord = FamilyOperatorRecord(7)\n";
        const declaration = "Declare Sub FamilyBoundaryProbe()\nNamespace FamilyNs\nConst FirstNsValue = 1\nEnd Namespace\n" + operators;
        const sources = new Map([[paths.common, "Const UtilityFlag = 1\n"], [paths.headerA, declaration], [paths.headerB, declaration],
            [paths.extraA, "Namespace FamilyNs\nConst ExtraNsValue = 2\nEnd Namespace\n"],
            [paths.moduleA, '#include "../common.bi"\n#include "api.bi"\n#include "extra.bi"\nUsing FamilyNs\nSub FamilyBoundaryProbe()\nEnd Sub\nFamilyBoundaryProbe()\n' + operatorBodies],
            [paths.moduleB, '#include "../common.bi"\n#include "api.bi"\nUsing FamilyNs\nFamilyBoundaryProbe()\n' + operatorBodies],
            [paths.consumer, '#include "api.bi"\nUsing FamilyNs\nFamilyBoundaryProbe()\n']]);
        try {
            fs.mkdirSync(path.join(directory, "a"));
            fs.mkdirSync(path.join(directory, "b"));
            for (const [file, text] of sources) fs.writeFileSync(file, text);
            if (process.env.FBC_EXECUTABLE) {
                const { runFreeBasicCompiler } = require(path.join(extension.extensionPath, "lib/compiler-diagnostics"));
                for (const filePath of [paths.moduleA, paths.moduleB]) {
                    const result = await runFreeBasicCompiler({ compilerPath: process.env.FBC_EXECUTABLE, filePath });
                    assert.equal(result.exitCode, 0, `operator navigation fixture must compile: ${result.output}`);
                }
            }
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            const documents = new Map();
            for (const file of sources.keys()) {
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                documents.set(file, current);
                await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", current.uri);
            }
            const selected = documents.get(paths.moduleA);
            await vscode.window.showTextDocument(selected);
            const target = position(selected, "Sub FamilyBoundaryProbe", "Sub F".length);
            const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", selected.uri, target, "RenamedBoundaryProbe");
            assert.deepEqual(edit.entries().map(([uri]) => uri.fsPath).sort(), [paths.headerA, paths.moduleA, paths.consumer].sort(),
                "rename must preserve real header consumers without touching an independent same-named declaration");
            assert.equal(edit.entries().reduce((count, [_uri, edits]) => count + edits.length, 0), 4);
            const other = documents.get(paths.moduleB);
            const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", other.uri,
                position(other, "FamilyBoundaryProbe()", 2));
            assert.deepEqual(definitions.map((entry) => entry.uri.fsPath), [paths.headerB]);
            const declarations = await vscode.commands.executeCommand("vscode.executeDeclarationProvider", selected.uri, target);
            assert.deepEqual(declarations.map((entry) => entry.uri.fsPath), [paths.headerA],
                "Go to Declaration must not collect an independent matching signature");
            const independentImplementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", other.uri,
                position(other, "FamilyBoundaryProbe()", 2));
            assert.deepEqual(independentImplementations, [], "an unrelated module is not this declaration's implementation");
            const consumer = documents.get(paths.consumer);
            const implementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", consumer.uri,
                position(consumer, "FamilyBoundaryProbe()", 2));
            assert.deepEqual(implementations.map((entry) => entry.uri.fsPath), [paths.moduleA],
                "shared declaration consumers must still reach the connected implementation");
            const header = documents.get(paths.headerA);
            for (const [name, prototype, body] of [
                ["+", "Declare Operator +(ByRef value As FamilyOperatorRecord, ByVal other As Long)", "Operator +(ByRef value As FamilyOperatorRecord, ByVal other As Long)"],
                ["+", "Declare Operator +(ByRef value As FamilyOperatorRecord, ByVal other As Long Ptr)", "Operator +(ByRef value As FamilyOperatorRecord, ByVal other As Long Pointer)"],
                ["Cast", "Declare Operator Cast() As Long\n", "Operator FamilyOperatorRecord.Cast() As Long\n"],
                ["Cast", "Declare Operator Cast() As Long Ptr", "Operator FamilyOperatorRecord.Cast() As Long Ptr"],
                ["[]", "Declare Operator [](ByVal index As Long)", "Operator FamilyOperatorRecord.[](ByVal index As Long)"],
                ["[]", "Declare Operator [](ByVal index As Long Ptr)", "Operator FamilyOperatorRecord.[](ByVal index As Long Pointer)"]
            ]) {
                const bodyPoint = position(selected, body, body.indexOf(name) + name.length - 1);
                const prototypePoint = position(header, prototype, prototype.indexOf(name) + name.length - 1);
                const declarations = await vscode.commands.executeCommand("vscode.executeDeclarationProvider", selected.uri, bodyPoint);
                assert.deepEqual(declarations.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[paths.headerA, prototypePoint.line]],
                    "operator declarations must exclude independent roots and distinct CAST result types");
                for (const command of ["vscode.executeDefinitionProvider", "vscode.executeImplementationProvider"]) {
                    const targets = await vscode.commands.executeCommand(command, header.uri, prototypePoint);
                    assert.deepEqual(targets.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[paths.moduleA, bodyPoint.line]],
                        "a header operator prototype must reach its connected implementation only");
                }
            }
            for (const [prototype, body] of [
                ["Declare Sub ShapeDimensionProbe Overload(values(Any) As Long)", "Sub ShapeDimensionProbe(values( any ) As Long)"],
                ["Declare Sub ShapeDimensionProbe Overload(values(Any, Any) As Long)", "Sub ShapeDimensionProbe(values(any,any) As Long)"]
            ]) {
                const bodyPoint = position(selected, body, "Sub S".length);
                const prototypePoint = position(header, prototype, "Declare Sub S".length);
                const declarations = await vscode.commands.executeCommand("vscode.executeDeclarationProvider", selected.uri, bodyPoint);
                assert.deepEqual(declarations.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[paths.headerA, prototypePoint.line]],
                    "array dimensions are part of the selected declaration signature");
                const implementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", header.uri, prototypePoint);
                assert.deepEqual(implementations.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[paths.moduleA, bodyPoint.line]]);
            }
            const namespaceDefinitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", selected.uri,
                position(selected, "Using FamilyNs", "Using F".length));
            assert.deepEqual(namespaceDefinitions.map((entry) => entry.uri.fsPath).sort(), [paths.headerA, paths.extraA].sort(),
                "co-visible namespace reopenings must remain connected without an unrelated same-name header");
            const namespaceReferences = await vscode.commands.executeCommand("vscode.executeReferenceProvider", other.uri,
                position(other, "Using FamilyNs", "Using F".length), { includeDeclaration: true });
            assert.deepEqual([...new Set(namespaceReferences.map((entry) => entry.uri.fsPath))].sort(), [paths.headerB, paths.moduleB].sort());
            if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) {
                await configuration.update("analysis.projectContexts", [{ name: "family-header", modules: [paths.moduleA] }], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", { name: "family-header", module: paths.moduleA }, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                const constructorPoint = position(header, "Declare Constructor(ByVal initial As Long)", "Declare C".length);
                const bodyLine = position(selected, "Constructor FamilyOperatorRecord(ByVal initial As Long)").line;
                const callLine = position(selected, "FamilyOperatorRecord(7)").line;
                for (const bridge of ["", process.env.FBC_EDITOR_EXECUTABLE]) {
                    await configuration.update("analysis.compilerPath", bridge, vscode.ConfigurationTarget.Global);
                    const hierarchy = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", header.uri, constructorPoint);
                    assert.deepEqual(hierarchy.map((entry) => [entry.uri.fsPath, entry.selectionRange.start.line]), [[paths.moduleA, bodyLine]],
                        `${bridge ? "bridge" : "stock"}: header constructor hierarchy must use the connected implementation, not the independent root`);
                    const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", hierarchy[0]);
                    assert.ok(incoming.some((call) => call.from.uri.fsPath === paths.moduleA && call.fromRanges.some((range) => range.start.line === callLine)),
                        "constructor hierarchy from a header must retain its caller in the selected root");
                }
            }
            for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text, "preview must not save edits");
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await check("label completion is scoped to goto targets and supports forward labels", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const previousCompiler = configuration.get("analysis.compilerPath", "");
        const source = [
            "Sub Work()",
            "    Goto fin",
            "    On 1 Goto finish, fin",
            "    On 1 Goto finish, _",
            "        fin",
            "    Print fin",
            "finish:",
            "    Print 2",
            "End Sub"
        ].join("\n");
        const labelDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        try {
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            const gotoCompletions = await vscode.commands.executeCommand(
                "vscode.executeCompletionItemProvider", labelDocument.uri,
                position(labelDocument, "Goto fin", "Goto fin".length)
            );
            const finish = gotoCompletions.items.find((item) => item.label === "finish");
            assert.ok(finish, "a forward label should be offered after GOTO");
            assert.equal(finish.kind, vscode.CompletionItemKind.Reference);

            for (const prefix of ["On 1 Goto finish, fin", "        fin"]) {
                const branchCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", labelDocument.uri,
                    position(labelDocument, prefix, prefix.length)
                );
                assert.deepEqual(branchCompletions.items.filter((item) => item.kind !== vscode.CompletionItemKind.Snippet)
                    .map((item) => item.label), ["finish"],
                "computed branch targets should offer only procedure-owned labels");
            }

            const expressionCompletions = await vscode.commands.executeCommand(
                "vscode.executeCompletionItemProvider", labelDocument.uri,
                position(labelDocument, "Print fin", "Print fin".length)
            );
            assert.equal(expressionCompletions.items.some((item) => item.label === "finish"), false,
                "labels should not pollute ordinary expression completion");
        } finally {
            await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    await check("source cache refreshes a reopened document with a reused version", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-reopened-source-"));
        const filePath = path.join(directory, "main.bas");
        const currentUri = vscode.Uri.file(filePath);
        const original = "Dim BeforeReopen As Long\nPrint BeforeReopen\n";
        const replacement = "Dim AfterReopen As String\nPrint AfterReopen\n";
        try {
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", "", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            fs.writeFileSync(filePath, original);
            // The API can retain documents after closing their tabs. A normal
            // editor open lets us verify a new TextDocument lifetime on reopen.
            await vscode.commands.executeCommand("vscode.open", currentUri, { preview: false });
            const first = vscode.workspace.textDocuments.find((opened) => opened.uri.toString() === currentUri.toString());
            assert.ok(first);
            const before = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", currentUri);
            assert.deepEqual(before.map((symbol) => symbol.name), ["BeforeReopen"]);
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            const deadline = Date.now() + DOCUMENT_CHANGE_TIMEOUT_MS;
            while (!first.isClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
            assert.equal(first.isClosed, true, "the original document must really unload");
            // This file is outside the watched workspace. Reopening, not a
            // workspace file event, must refresh the cached declarations.
            fs.writeFileSync(filePath, replacement);
            await vscode.commands.executeCommand("vscode.open", currentUri, { preview: false });
            const second = vscode.workspace.textDocuments.find((opened) => opened.uri.toString() === currentUri.toString());
            assert.ok(second && second !== first);
            assert.equal(second.version, first.version, "exercise the reused version number");
            const after = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", currentUri);
            assert.deepEqual(after.map((symbol) => symbol.name), ["AfterReopen"]);
            assert.equal(second.isDirty, false);
            assert.equal(fs.readFileSync(filePath, "utf8"), replacement);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await check("thread-local source declarations retain Outline, completion and navigation", async () => {
        // Untitled documents exercise the source index without invoking a
        // compiler that may predate THREAD LOCAL support.
        const lines = [
            "Thread Local Dim Shared tlsRequestCount As Integer = 0",
            'Thread Local Extern tlsExternalCount Alias "external_count" As Long',
            "Sub TLSWork()",
            "    Dim tlsRequestCount As Long",
            "    Print tlsRequestCount",
            "End Sub",
            "Print tlsRequestCount, tlsExternalCount",
            "Print tls"
        ];
        const current = await vscode.workspace.openTextDocument({ language: "freebasic", content: lines.join("\r\n") });
        const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", current.uri);
        assert.deepEqual(symbols.map((symbol) => symbol.name), ["tlsRequestCount", "tlsExternalCount", "TLSWork"]);
        assert.deepEqual(symbols[2].children.map((symbol) => symbol.name), ["tlsRequestCount"]);
        for (const [line, name, declarationLine] of [[6, "tlsRequestCount", 0], [6, "tlsExternalCount", 1], [4, "tlsRequestCount", 3]]) {
            const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", current.uri,
                new vscode.Position(line, lines[line].indexOf(name)));
            assert.equal(definitions.length, 1, `${name} on line ${line}`);
            assert.equal(definitions[0].uri.toString(), current.uri.toString());
            assert.equal(definitions[0].range.start.line, declarationLine);
        }
        const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
            new vscode.Position(7, lines[7].length));
        for (const name of ["tlsRequestCount", "tlsExternalCount"]) {
            assert.ok(completions.items.some((item) => item.label === name), `Missing thread-local completion: ${name}`);
        }
    });
    await check("source call hierarchy follows direct and bare zero-argument calls", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const previousCompiler = configuration.get("analysis.compilerPath", "");
        const callUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-call-hierarchy.bas"));
        const callDocument = await vscode.workspace.openTextDocument(callUri);
        try {
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(callDocument);
            const leaf = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", callUri, position(callDocument, "Function LeafValue", "Function ".length + 2)
            );
            assert.equal(leaf.length, 1);
            assert.equal(leaf[0].name, "LeafValue");
            const leafCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", leaf[0]);
            assert.deepEqual(leafCallers.map((call) => call.from.name).sort(), ["MiddleValue", "RootValue"],
                JSON.stringify(leafCallers.map((call) => ({ name: call.from.name, uri: call.from.uri.toString(), ranges: call.fromRanges.map((range) => [range.start.line, range.start.character]) }))));

            const root = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", callUri, position(callDocument, "Function RootValue", "Function ".length + 2)
            );
            assert.equal(root.length, 1);
            const rootCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", root[0]);
            assert.deepEqual(rootCalls.map((call) => call.to.name).sort(), ["LeafValue", "MiddleValue"]);
            const rootCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", root[0]);
            const moduleCaller = rootCallers.find((call) => call.from.detail === "Module-level calls");
            assert.ok(moduleCaller, "the module-level RootValue call should appear as an incoming caller");
            const moduleCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", moduleCaller.from);
            assert.deepEqual(moduleCalls.map((call) => call.to.name), ["RootValue"]);

            const bareTarget = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", callUri, position(callDocument, "Sub BareTarget", "Sub ".length + 2)
            );
            const bareTargetCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", bareTarget[0]);
            assert.deepEqual(bareTargetCallers.map((call) => call.from.name), ["BareCaller"]);
            const bareCaller = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", callUri, position(callDocument, "Sub BareCaller", "Sub ".length + 2)
            );
            const bareCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", bareCaller[0]);
            assert.deepEqual(bareCalls.map((call) => call.to.name), ["BareTarget"]);

            const bareFunctionTarget = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", callUri, position(callDocument, "Function BareFunctionTarget", "Function ".length + 2)
            );
            const bareFunctionCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", bareFunctionTarget[0]);
            assert.deepEqual(bareFunctionCallers.map((call) => call.from.name), ["BareFunctionCaller"]);
            const bareFunctionCaller = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", callUri, position(callDocument, "Function BareFunctionCaller", "Function ".length + 2)
            );
            const bareFunctionCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", bareFunctionCaller[0]);
            assert.deepEqual(bareFunctionCalls.map((call) => call.to.name), ["BareFunctionTarget"]);

            const bareProperty = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", callUri, position(callDocument, "Property BarePropertyOwner.BareValue", "Property BarePropertyOwner.".length + 2)
            );
            const barePropertyCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", bareProperty[0]);
            assert.deepEqual(barePropertyCallers.map((call) => call.from.name), ["BarePropertyCaller"]);
            const barePropertyCaller = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", callUri, position(callDocument, "Function BarePropertyCaller", "Function ".length + 2)
            );
            const barePropertyCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", barePropertyCaller[0]);
            assert.deepEqual(barePropertyCalls.map((call) => call.to.name), ["BareValue"]);
        } finally {
            await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    await check("namespace operator prototypes and bodies retain exact navigation", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-namespace-operators-"));
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/namespace-operator-navigation.bas"), "utf8");
        try {
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            for (const backend of ["source", ...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", backend === "source" ? "off" : "onDemand", vscode.ConfigurationTarget.Global);
                const filePath = path.join(directory, `${backend}.bas`);
                fs.writeFileSync(filePath, source);
                if (process.env.FBC_EXECUTABLE) {
                    const { runFreeBasicCompiler } = require(path.join(extension.extensionPath, "lib/compiler-diagnostics"));
                    const compiled = await runFreeBasicCompiler({ compilerPath: process.env.FBC_EXECUTABLE, filePath });
                    assert.equal(compiled.exitCode, 0, compiled.output);
                }
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                for (const [name, prototype, body] of [
                    ["Cast", "Declare Operator Cast()", "Operator NamespacedRecord.Cast()"],
                    ["[]", "Declare Operator [](ByVal index As Long)", "Operator NamespacedRecord.[](ByVal index As Long)"]
                ]) {
                    const prototypePoint = position(current, prototype, prototype.indexOf(name) + name.length - 1);
                    const bodyPoint = position(current, body, body.indexOf(name) + name.length - 1);
                    const ownerPoint = position(current, body, body.indexOf("NamespacedRecord") + 2);
                    for (const command of ["vscode.executeDefinitionProvider", "vscode.executeDeclarationProvider"]) {
                        const owner = await vscode.commands.executeCommand(command, current.uri, ownerPoint);
                        assert.deepEqual(owner.map((entry) => entry.range.start.line), [position(current, "Type NamespacedRecord").line],
                            `${backend}: ${name} owner must remain a type reference`);
                    }
                    assert.deepEqual(await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, ownerPoint), [],
                        `${backend}: an owner type must not prepare an operator caller item`);
                    const declarations = await vscode.commands.executeCommand("vscode.executeDeclarationProvider", current.uri, bodyPoint);
                    assert.deepEqual(declarations.map((entry) => entry.range.start.line), [prototypePoint.line], `${backend}: ${name} prototype`);
                    const implementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", current.uri, prototypePoint);
                    assert.deepEqual(implementations.map((entry) => entry.range.start.line), [bodyPoint.line], `${backend}: ${name} body`);
                    const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, prototypePoint);
                    assert.equal(prepared.length, 1);
                    const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", prepared[0]);
                    assert.ok(outgoing.some((call) => call.to.name.split(".").at(-1) === "ObserveNamespacedOperator"));
                }
                const indexDefinitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", current.uri,
                    position(current, "instance[1]", "instance[".length));
                assert.deepEqual(indexDefinitions.map((entry) => entry.range.start.line), [position(current, "Operator NamespacedRecord.[]").line],
                    `${backend}: indexing must use the namespace-qualified operator owner`);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE) await check("external constructor prototypes retain selected references through include guards", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-external-constructors-"));
        const filePath = path.join(directory, "main.bas");
        const headerPath = path.join(directory, "external.bi");
        const headerSource = '#ifndef EXTERNAL_BUILD_BI\n#define EXTERNAL_BUILD_BI\nType ExternalBuild\nvalue As Long\n' +
            'Declare Constructor(ByVal initialValue As Long = 0)\nDeclare Constructor(ByVal fractionalValue As Double)\n' +
            '#if 0\nDeclare Constructor(ByVal inactiveValue As String)\n#endif\nEnd Type\n#endif\n';
        const source = '#include "external.bi"\nDim defaultValue As ExternalBuild\n' +
            'Dim allocated As ExternalBuild Ptr = New ExternalBuild(7)\n' +
            'Dim selectedValue As ExternalBuild = ExternalBuild(3)\n' +
            'Dim otherValue As ExternalBuild = ExternalBuild(CDbl(1.5))\n';
        try {
            fs.writeFileSync(filePath, source);
            fs.writeFileSync(headerPath, headerSource);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "external-constructors", modules: [filePath] }], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", { name: "external-constructors", module: filePath }, vscode.ConfigurationTarget.Global);
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const header = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
            const point = new vscode.Position(4, 9);
            const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", header.uri, point, { includeDeclaration: true });
            assert.deepEqual([...new Set(references.filter((entry) => entry.uri.toString() === current.uri.toString())
                .map((entry) => entry.range.start.line))].sort(), [1, 2, 3]);
            assert.equal(references.some((entry) => entry.uri.toString() === header.uri.toString() && entry.range.start.line === 5), false);
            const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", header.uri, point);
            assert.equal(highlights.length, 1);
            assert.equal(highlights[0].range.start.line, 4);
            const inactive = await vscode.commands.executeCommand("vscode.executeReferenceProvider", header.uri, new vscode.Position(7, 9), { includeDeclaration: true });
            assert.deepEqual(inactive, []);
            assert.equal(header.isDirty, false);
            assert.equal(current.isDirty, false);
            assert.equal(fs.readFileSync(headerPath, "utf8"), headerSource);
            assert.equal(fs.readFileSync(filePath, "utf8"), source);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE) await check("destructor references and highlights load cleanup facts on first use", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-destructor-references-"));
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/destructor-hierarchy.bas"), "utf8");
        try {
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            for (const backend of [...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                for (const operation of ["references", "highlights"]) {
                    const filePath = path.join(directory, `${backend}-${operation}.bas`);
                    fs.writeFileSync(filePath, source);
                    // Do not activate the file or prepare hierarchy before this
                    // lookup: each operation must obtain its own binding facts.
                    const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                    const point = position(current, "Declare Destructor", "Declare ".length + 1);
                    const results = operation === "references"
                        ? await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri, point, { includeDeclaration: true })
                        : await vscode.commands.executeCommand("vscode.executeDocumentHighlights", current.uri, point);
                    const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, point);
                    assert.equal(prepared.length, 1);
                    const callers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", prepared[0]);
                    assert.equal(callers.length, 4);
                    for (const expected of callers.flatMap((call) => call.fromRanges)) {
                        assert.ok(results.some((result) => result.range.start.isEqual(expected.start)),
                            `${backend}: ${operation}: first-use results must include cleanup at ${expected.start.line}:${expected.start.character}`);
                    }
                    const other = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                        position(current, "Destructor OtherCleanupValue", 1));
                    assert.equal(other.length, 1);
                    const unrelated = await vscode.commands.executeCommand("vscode.provideIncomingCalls", other[0]);
                    for (const unexpected of unrelated.flatMap((call) => call.fromRanges)) {
                        assert.equal(results.some((result) => result.range.start.isEqual(unexpected.start)), false,
                            `${backend}: ${operation}: unrelated cleanup must remain separate`);
                    }
                    assert.equal(current.isDirty, false);
                    assert.equal(fs.readFileSync(filePath, "utf8"), source);
                }
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE) await check("destructor callers retain recursive cleanup Call Hierarchy", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-destructor-hierarchy-"));
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/destructor-hierarchy.bas"), "utf8");
        try {
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            for (const backend of [...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const filePath = path.join(directory, `${backend}.bas`);
                fs.writeFileSync(filePath, source);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                // Start from the helper, not an already-prepared destructor.
                const helper = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                    position(current, "Sub RecordCleanup", "Sub ".length + 1));
                assert.equal(helper.length, 1);
                const helperCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", helper[0]);
                const destructor = helperCallers.find((call) => /Destructor.*CleanupValue/i.test(call.from.detail));
                assert.ok(destructor, `${backend}: the helper's destructor caller`);
                const callers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", destructor.from);
                assert.deepEqual(callers.map((call) => call.from.name).sort(),
                    ["LeaveEarly", "LeaveScope", "ReleaseOne", `${backend}.bas`].sort(),
                    `${backend}: recursive cleanup callers must exclude OtherCleanupValue`);
                const rangeKey = (range) => `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
                for (const caller of callers) {
                    const callees = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", caller.from);
                    const cleanup = callees.filter((call) => call.to.selectionRange.isEqual(destructor.from.selectionRange));
                    assert.equal(cleanup.length, 1, `${backend}: ${caller.from.name} must show its selected cleanup at ` +
                        `${rangeKey(destructor.from.selectionRange)}; targets: ${callees.map((call) =>
                            `${call.to.detail}@${rangeKey(call.to.selectionRange)}`).join(" | ")}`);
                    assert.deepEqual(cleanup[0].fromRanges.map(rangeKey).sort(), caller.fromRanges.map(rangeKey).sort(),
                        `${backend}: incoming and outgoing cleanup must retain the same physical ranges`);
                    assert.equal(callees.filter((call) => call.to.kind === vscode.SymbolKind.Constructor).length, 1,
                        `${backend}: ${caller.from.name} must retain its selected initialization`);
                    if (caller.from.kind !== vscode.SymbolKind.File) {
                        assert.equal(callees.filter((call) => /Destructor/i.test(call.to.detail)).length, 1,
                            `${backend}: a procedure must not acquire the other type's cleanup`);
                    }
                }
                const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", destructor.from);
                assert.deepEqual(outgoing.map((call) => call.to.name), ["RecordCleanup"]);
                const prototype = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                    position(current, "Declare Destructor", "Declare ".length + 1));
                assert.equal(prototype.length, 1);
                const prototypeCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", prototype[0]);
                assert.deepEqual(prototypeCallers.map((call) => call.from.name).sort(), callers.map((call) => call.from.name).sort());
                assert.equal(current.isDirty, false);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project lifetime incoming hierarchy uses native active-build callers", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-project-lifetime-calls-"));
        const header = ["Type ProjectLifetime", "    value As Long", "    Declare Constructor(ByVal initial As Long)",
            "    Declare Constructor(ByVal initial As String)", "    Declare Destructor()", "End Type", ""].join("\n");
        const implementation = ['#include "lifetime.bi"', "Constructor ProjectLifetime(ByVal initial As Long)",
            "    value = initial", "End Constructor", "Constructor ProjectLifetime(ByVal initial As String)",
            "    value = Len(initial)", "End Constructor", "Destructor ProjectLifetime()", "End Destructor", ""].join("\n");
        const caller = ['#include "lifetime.bi"', "Sub LocalLifetime()",
            "    Dim localValue As ProjectLifetime = ProjectLifetime(1)", "End Sub", ""].join("\n");
        const remote = ['#include "lifetime.bi"', "#ifdef ALTERNATE", "Sub ActiveRemoteLifetime()", "#else",
            "Sub InactiveRemoteLifetime()", "#endif", "    Dim remoteValue As ProjectLifetime = ProjectLifetime(2)",
            "End Sub", ""].join("\n");
        const files = [["lifetime.bi", header], ["implementation.bas", implementation], ["caller.bas", caller], ["remote.bas", remote]];
        try {
            for (const [name, text] of files) fs.writeFileSync(path.join(directory, name), text);
            for (const [name, value] of [["analysis.run", "onDemand"], ["diagnostics.run", "off"], ["compiler.arguments", []],
                ["analysis.projectContexts", [{ name: "alternate", modules: files.slice(1).map(([name]) => path.join(directory, name)),
                    arguments: ["-d", "ALTERNATE"] }]],
                ["analysis.activeContext", { name: "alternate", module: path.join(directory, "caller.bas") }]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, "lifetime.bi")));
            await vscode.window.showTextDocument(current);
            for (const backend of ["stock", "bridge"]) {
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                // Destruction must work before a constructor request has had
                // a chance to warm the native binding snapshot.
                for (const kind of ["Destructor", "Constructor"]) {
                    const items = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                        position(current, `Declare ${kind}`, "Declare ".length + 1));
                    assert.equal(items.length, 1, `${backend}/${kind}: one native prototype target`);
                    const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", items[0]);
                    assert.deepEqual(incoming.map((call) => [call.from.name, path.basename(call.from.uri.fsPath),
                        [...new Set(call.fromRanges.map((range) => range.start.line))]]).sort(),
                    [["ActiveRemoteLifetime", "remote.bas", [6]], ["LocalLifetime", "caller.bas", [2]]].sort(),
                    `${backend}/${kind}: native caller ownership must cover closed modules and exclude inactive headers`);
                    const remoteCaller = incoming.find((call) => call.from.name === "ActiveRemoteLifetime");
                    assert.equal(remoteCaller.from.selectionRange.start.line, 2);
                }
            }
            assert.equal(current.isDirty, false);
            for (const [name, text] of files) assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), text);
            assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === path.join(directory, "remote.bas")), false,
                "project incoming analysis must not open closed caller documents");
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("native refactor code actions retain current compiler-selected edits", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-current-actions-"));
        const source = '#lang "fblite"\nDefInt A-Z\nFunction ActionProbe()\n    Return 1\nEnd Function\n';
        const valueSource = ["Sub ParameterProbe(value As Integer)", "    Print value", "End Sub",
            "Var inferredValue = CLng(42)", "Enum ActionCode", "    FirstCode = 7", "    NextCode", "End Enum",
            'Extern "C"', "Declare Function ForeignAction(ByVal value As Integer) As Integer",
            "Declare Function ExplicitForeign Cdecl(ByVal value As Integer) As Integer", "End Extern",
            "Type ActionBase Extends Object", "    Declare Virtual Sub ExecuteAction()", "End Type",
            "Type ActionChild Extends ActionBase", "    Declare Sub ExecuteAction()", "End Type",
            "Sub ActionBase.ExecuteAction()", "End Sub", "Sub ActionChild.ExecuteAction()", "End Sub", ""].join("\n");
        const missing = [];
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["analysis.activeContext", null],
                ["analysis.projectContexts", []], ["compiler.arguments", []], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            for (const bridge of [false, true]) {
                const filePath = path.join(directory, bridge ? "bridge.bas" : "stock.bas");
                fs.writeFileSync(filePath, source);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                const point = position(current, "ActionProbe", 1);
                const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", current.uri,
                    new vscode.Range(point, point), vscode.CodeActionKind.RefactorRewrite.value);
                const action = actions.find((candidate) => candidate.title.toLowerCase() === "add explicit return type 'integer'");
                assert.ok(action?.edit, `bridge=${bridge}: native return-type refactoring must survive normal model acquisition; actions=${actions.map((item) => item.title).join(" | ")}`);
                assert.deepEqual(action.edit.get(current.uri).map((edit) => [edit.range.start.line, edit.range.start.character, edit.newText.toLowerCase()]),
                    [[2, current.lineAt(2).text.length, " as integer"]]);
                assert.equal(current.isDirty, false);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
                const valuesPath = path.join(directory, bridge ? "bridge-values.bas" : "stock-values.bas");
                fs.writeFileSync(valuesPath, valueSource);
                const values = await vscode.workspace.openTextDocument(vscode.Uri.file(valuesPath));
                for (const [name, title, expectedText] of [["value", "make parameter passing mode explicit as ", null],
                    ["inferredValue", "make inferred var type explicit as 'long'", " as long"],
                    ["NextCode", "make enum value explicit as 8", " = 8"],
                    ["ForeignAction", "make calling convention explicit as 'cdecl'", " cdecl"],
                    ["Declare Sub ExecuteAction()", "add explicit 'override' marker", " override"]]) {
                    const point = position(values, name, name.startsWith("Declare Sub") ? "Declare Sub ".length + 1 : 1);
                    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", values.uri,
                        new vscode.Range(point, point), vscode.CodeActionKind.RefactorRewrite.value);
                    const action = actions.find((candidate) => candidate.title.toLowerCase().startsWith(title));
                    if (!action?.edit) {
                        missing.push(`bridge=${bridge}, ${name}: ${actions.map((item) => item.title).join(" | ")}`);
                        continue;
                    }
                    const texts = action.edit.get(values.uri).map((edit) => edit.newText.toLowerCase());
                    assert.equal(expectedText ? texts.includes(expectedText) : texts.some((text) => ["byval ", "byref "].includes(text)), true,
                        `${name}: the edit must contain the compiler-selected value/type/mode`);
                }
                for (const [name, relative, forbidden] of [["ExplicitForeign", 1, "make calling convention explicit"],
                    ["Declare Virtual Sub ExecuteAction()", "Declare Virtual Sub ".length + 1, "add explicit 'override' marker"]]) {
                    const point = position(values, name, relative);
                    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", values.uri,
                        new vscode.Range(point, point), vscode.CodeActionKind.RefactorRewrite.value);
                    assert.equal(actions.some((action) => action.title.toLowerCase().startsWith(forbidden)), false,
                        "written conventions and non-overriding root methods must not receive redundant markers");
                }
                assert.equal(values.isDirty, false);
                assert.equal(fs.readFileSync(valuesPath, "utf8"), valueSource);
            }
            assert.deepEqual(missing, [], `native parameter, Var, and enum refactors must work with actual sidecar entries: ${JSON.stringify(missing)}`);
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE) await check("temporary constructor calls retain selected references and Call Hierarchy", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-temporary-constructors-"));
        try {
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            const backends = [...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])];
            for (const [backend, qualified] of backends.flatMap((backend) => [[backend, false], [backend, true]])) {
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const fixture = `${qualified ? "qualified-" : ""}temporary-constructor-calls.bas`;
                const typeName = qualified ? "TemporaryAlias" : "TemporaryValue";
                const source = fs.readFileSync(path.join(__dirname, "../fixtures", fixture), "utf8")
                    .replace(`'' end of ${fixture}`,
                        `ConsumeTemporary(${typeName}())\nConsumeTemporary(Type<${typeName}>(CLng(3)))\n` +
                        `ConsumeTemporary(Type<TypeOf(${typeName})>(CLng(4)))\n` +
                        ["Type SharedSpanWrapper", "number As Long", `Declare Constructor(ByRef incoming As ${typeName})`, "End Type",
                            `Constructor SharedSpanWrapper(ByRef incoming As ${typeName})`, "number = incoming.number", "End Constructor",
                            "Sub ConsumeConverted(ByVal item As SharedSpanWrapper)", "End Sub",
                            `ConsumeConverted(Type<${typeName}>(CLng(5)))`, `'' end of ${fixture}`].join("\n"));
                const filePath = path.join(directory, `${backend}${qualified ? "-qualified" : ""}.bas`);
                fs.writeFileSync(filePath, source);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                const calls = [
                    [`${typeName}(CLng(1))`, "Long"], [qualified ? "ConstructionScope.TemporaryValue(CDbl(2))" : "TemporaryValue(CDbl(2))", "Double"],
                    [`${typeName}()`, "Long"], [`Type<${typeName}>(CLng(3))`, "Long"],
                    [`Type<TypeOf(${typeName})>(CLng(4))`, "Long"], [`Type<${typeName}>(CLng(5))`, "Long"]
                ].map(([spelling, type]) => ({ spelling, type, site: position(current, spelling,
                    spelling.startsWith("ConstructionScope.") ? "ConstructionScope.".length : 0) }));
                for (const type of ["Long", "Double"]) {
                    const target = position(current, `Constructor TemporaryValue(ByVal initialValue As ${type})`, 1);
                    // Find References is the first explicit language request;
                    // no prior hierarchy, analysis command, or source edit.
                    const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri, target);
                    for (const call of calls) assert.equal(references.some((entry) => entry.range.start.isEqual(call.site)), call.type === type,
                        `${backend}: ${type} references must select ${call.spelling}: ${JSON.stringify(references.map((entry) =>
                            [entry.uri.fsPath, entry.range.start.line, entry.range.start.character]))}`);
                    const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", current.uri);
                    const lens = lenses.find((entry) => entry.range.start.line === target.line);
                    const count = calls.filter((call) => call.type === type).length;
                    assert.equal(lens?.command?.title, `${count} reference${count === 1 ? "" : "s"}`,
                        `${backend}: constructor CodeLens must agree with Find References`);
                    assert.equal(lens.command.command, "editor.action.showReferences");
                    assert.equal(lens.command.arguments[2].length, count);
                    const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, target);
                    assert.equal(prepared.length, 1);
                    const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", prepared[0]);
                    const sites = incoming.flatMap((caller) => caller.fromRanges.map((range) => range.start));
                    assert.equal(sites.length, calls.filter((call) => call.type === type).length,
                        `${backend}: ${type} incoming sites: ${JSON.stringify(prepared.map((entry) => ({
                            name: entry.name, detail: entry.detail, start: entry.selectionRange.start, data: entry.data
                        })))}`);
                    for (const call of calls) assert.equal(sites.some((site) => site.isEqual(call.site)), call.type === type,
                        `${backend}: incoming hierarchy must retain selected temporary calls`);
                    for (const caller of incoming) {
                        const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", caller.from);
                        const selected = outgoing.filter((call) => call.to.selectionRange.isEqual(prepared[0].selectionRange));
                        assert.equal(selected.length, 1);
                        assert.deepEqual(selected[0].fromRanges.map((range) => range.start.line), caller.fromRanges.map((range) => range.start.line),
                            `${backend}: outgoing hierarchy must agree with incoming constructor sites`);
                        if (caller.fromRanges.some((range) => range.start.isEqual(calls[5].site))) {
                            const conversion = position(current, `Constructor SharedSpanWrapper(ByRef incoming As ${typeName})`, 1);
                            // An argument-conversion receipt can include the
                            // call's opening parenthesis, unlike the TYPE token.
                            assert.ok(outgoing.some((entry) => entry.to.selectionRange.start.line === conversion.line &&
                                entry.fromRanges.some((range) => range.contains(calls[5].site))),
                                "both the explicit construction and the enclosing conversion remain in the native call graph: " +
                                JSON.stringify({ conversion, site: calls[5].site, outgoing: outgoing.map((entry) => ({
                                    name: entry.to.name, selection: entry.to.selectionRange,
                                    ranges: entry.fromRanges
                                })) }));
                        }
                    }
                    for (const call of calls.filter((call) => call.type === type)) {
                        const preparedCall = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, call.site);
                        assert.equal(preparedCall.length, 1, `${backend}: hierarchy must start at ${call.spelling}`);
                        assert.ok(preparedCall[0].selectionRange.isEqual(prepared[0].selectionRange),
                            `${backend}: the written construction must select the same overload as its declaration`);
                    }
                }
                for (const call of [calls[1], calls[3], calls[4], calls[5]]) {
                    const opening = call.spelling.startsWith("Type<") ? call.spelling.lastIndexOf(">(") + 1 : call.spelling.indexOf("(");
                    const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, call.spelling, opening + 1));
                    assert.ok(signature?.signatures.length, `${backend}: ${call.spelling}`);
                    if (call.spelling.startsWith("Type<")) {
                        assert.equal(signature.signatures.length, 1, "a selected constructor's prototype and body must not duplicate the menu");
                        assert.match(signature.signatures[0].label, /=\s*0/, "typed construction retains the optional default from its prototype");
                        const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri,
                            position(current, call.spelling, 1));
                        const hoverText = hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                        assert.match(hoverText, /Declare Constructor\(ByVal initialValue As Long\s*=\s*0\)/i,
                            `${backend}: TYPE hover retains its selected constructor prototype`);
                        const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri,
                            position(current, call.spelling, 1));
                        const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", current.uri,
                            position(current, call.spelling, 1));
                        for (const other of calls) {
                            assert.equal(references.some((entry) => entry.range.start.isEqual(other.site)), other.type === call.type,
                                "typed references retain the explicit overload even when a conversion shares its site");
                            assert.equal(highlights.some((entry) => entry.range.start.isEqual(other.site)), other.type === call.type,
                                "typed highlights keep constructor families separate");
                        }
                        for (const [command, prototype] of [["vscode.executeDefinitionProvider", false],
                            ["vscode.executeDeclarationProvider", true], ["vscode.executeImplementationProvider", false]]) {
                            const targets = await vscode.commands.executeCommand(command, current.uri, position(current, call.spelling, 1));
                            const expected = position(current, prototype ? "Declare Constructor(ByVal initialValue As Long"
                                : "Constructor TemporaryValue(ByVal initialValue As Long", 1);
                            assert.equal(targets.length, 1, `${backend}: ${command} on ${call.spelling}`);
                            assert.equal(targets[0].uri.fsPath, filePath);
                            assert.equal(targets[0].range.start.line, expected.line, "typed construction navigation retains the requested native role");
                        }
                        const argument = position(current, call.spelling, opening + 1);
                        const hints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri,
                            new vscode.Range(argument, new vscode.Position(argument.line, current.lineAt(argument.line).text.length)));
                        const parameters = hints.filter((hint) => hint.position.isEqual(argument) && hint.kind === vscode.InlayHintKind.Parameter);
                        assert.equal(parameters.length, 1, `${backend}: one constructor hint for ${call.spelling}`);
                        assert.equal(parameters[0].label.map((part) => part.value).join(""), "initialValue:");
                        const target = parameters[0].label[0].location;
                        assert.equal(target?.uri.fsPath, filePath);
                        const formal = position(current, "Declare Constructor(ByVal initialValue As Long", "Declare Constructor(ByVal ".length);
                        assert.ok(target.range.start.isEqual(formal), "typed construction hints link to the selected physical prototype formal");
                    }
                    assert.match(signature.signatures[signature.activeSignature || 0].label,
                        new RegExp(`initialValue As ${call.type}\\b`, "i"),
                        `${backend}: Signature Help must select ${call.spelling}'s constructor rather than its enclosing call`);
                }
                if (qualified) {
                    const namespace = position(current, "ConstructionScope.TemporaryValue(CDbl(2))");
                    const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri, namespace);
                    assert.ok(references.some((entry) => entry.range.start.isEqual(namespace)),
                        `${backend}: a namespace reference must remain independently navigable`);
                    assert.equal(references.some((entry) => entry.range.start.isEqual(calls[1].site)), false,
                        `${backend}: namespace references must not turn into constructor references`);
                }
                assert.equal(current.isDirty, false);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE) await check("namespace shared initializers retain constructor Call Hierarchy", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-namespace-initializers-"));
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/namespace-initializer-calls.bas"), "utf8");
        try {
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            for (const backend of [...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const filePath = path.join(directory, `${backend}.bas`);
                fs.writeFileSync(filePath, source);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                const expectedLines = [position(current, "Dim Shared firstValue").line, position(current, "Dim Shared secondValue").line,
                    position(current, "Dim Shared rootValue").line];
                // Start from an ordinary helper so native mode must obtain
                // constructor receipts when the incoming tree is expanded.
                const helper = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                    position(current, "Function RecordInitialization", "Function ".length + 1));
                const helperCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", helper[0]);
                assert.equal(helperCallers.some((call) => call.from.detail === "Module-level calls"), false,
                    `${backend}: calls in the constructor body must not become module edges`);
                assert.ok(helperCallers.some((call) => call.from.kind === vscode.SymbolKind.Constructor),
                    `${backend}: the constructor body remains the helper's caller`);
                const recursiveConstructor = helperCallers.find((call) => call.from.kind === vscode.SymbolKind.Constructor).from;
                const recursiveCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", recursiveConstructor);
                assert.ok(recursiveCallers.some((call) => call.from.detail === "Module-level calls" &&
                    call.fromRanges.length === expectedLines.length), `${backend}: recursive constructor incoming calls`);
                const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                    position(current, "Declare Constructor", "Declare C".length));
                assert.equal(prepared.length, 1, `${backend}: constructor declaration`);
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", prepared[0]);
                const moduleCaller = incoming.find((call) => call.from.detail === "Module-level calls");
                assert.ok(moduleCaller, `${backend}: namespace construction must have a module caller`);
                assert.deepEqual(moduleCaller.fromRanges.map((range) => range.start.line).sort((a, b) => a - b), expectedLines,
                    `${backend}: both namespace initializer sites`);
                const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", moduleCaller.from);
                const constructors = outgoing.filter((call) => call.to.kind === vscode.SymbolKind.Constructor);
                assert.equal(constructors.length, 1, `${backend}: module constructor target`);
                assert.deepEqual(constructors[0].fromRanges.map((range) => range.start.line).sort((a, b) => a - b), expectedLines);
                assert.equal(outgoing.filter((call) => call.to.name === "ModuleAction").length, 1,
                    `${backend}: native and source projections must not duplicate an ordinary module call`);
                assert.equal(outgoing.length, 2, `${backend}: only the constructor and ordinary module call belong here`);
                const constructorCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", constructors[0].to);
                assert.deepEqual(constructorCalls.map((call) => call.to.name), ["RecordInitialization"],
                    `${backend}: module constructor targets must expand to their implementation calls`);
                assert.equal(current.isDirty, false);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project Call Hierarchy separates namespace and property accessor targets", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-accessor-callers-"));
        const header = ["Namespace CallApi", "Declare Function ReadValue() As Long", "End Namespace", "Type Meter", "number As Long",
            "Declare Property Value() As Long", "Declare Property Value(ByVal amount As Long)", "End Type", ""].join("\n");
        const caller = '#include "api.bi"\nDim item As Meter\nPrint CallApi.ReadValue(), item.Value\nitem.Value = 1\n';
        const other = '#include "api.bi"\nNamespace Client\nSub Collect(ByRef item As Meter)\nPrint CallApi.ReadValue()\nPrint item.Value\nitem.Value = 2\nEnd Sub\nEnd Namespace\n';
        const implementation = '#include "api.bi"\nFunction CallApi.ReadValue() As Long\nReturn 1\nEnd Function\n' +
            'Property Meter.Value() As Long\nReturn number\nEnd Property\nProperty Meter.Value(ByVal amount As Long)\nnumber = amount\nEnd Property\n';
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            for (const bridge of [false, true]) {
                const backendDirectory = path.join(directory, bridge ? "bridge" : "stock");
                fs.mkdirSync(backendDirectory);
                const callerPath = path.join(backendDirectory, "caller.bas"), otherPath = path.join(backendDirectory, "other.bas");
                const implementationPath = path.join(backendDirectory, "implementation.bas"), headerPath = path.join(backendDirectory, "api.bi");
                const sources = [[callerPath, caller], [otherPath, other], [implementationPath, implementation], [headerPath, header]];
                for (const [file, text] of sources) fs.writeFileSync(file, text);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{ name: "accessors", modules: [callerPath, otherPath, implementationPath] }], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", { name: "accessors", module: callerPath }, vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
                await vscode.window.showTextDocument(current);
                for (const [anchor, relative, localLine, remoteLine, expectedKind] of [["ReadValue", 1, 2, 3, vscode.SymbolKind.Function],
                    ["item.Value", "item.".length + 1, 2, 4, vscode.SymbolKind.Property],
                    ["item.Value = 1", "item.".length + 1, 3, 5, vscode.SymbolKind.Property]]) {
                    const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, position(current, anchor, relative));
                    assert.equal(prepared.length, 1, `bridge=${bridge}, ${anchor}: select exactly one native accessor`);
                    assert.equal(prepared[0].kind, expectedKind);
                    const calls = await vscode.commands.executeCommand("vscode.provideIncomingCalls", prepared[0]);
                    assert.deepEqual(calls.map((call) => [call.from.uri.fsPath, call.from.kind, call.fromRanges.map((range) => range.start.line)]),
                        [[callerPath, vscode.SymbolKind.File, [localLine]], [otherPath, vscode.SymbolKind.Function, [remoteLine]]],
                        `bridge=${bridge}, ${anchor}: namespace callers stay functions and getter/setter sites stay separate`);
                }
                assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === otherPath), false,
                    "incoming accessor lookup must not require an open caller module");
                const included = await vscode.workspace.openTextDocument(vscode.Uri.file(otherPath));
                const callers = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", included.uri, position(included, "Collect", 1));
                assert.equal(callers.length, 1);
                const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", callers[0]);
                assert.deepEqual(outgoing.map((call) => [call.to.uri.fsPath, call.to.selectionRange.start.line,
                    call.fromRanges.map((range) => range.start.line)]).sort((first, second) => first[1] - second[1]),
                    [[headerPath, 1, [3]], [headerPath, 5, [4]], [headerPath, 6, [5]]],
                    "native outgoing calls retain separate namespace/getter/setter targets");
                for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("standalone module Call Hierarchy uses native calls without project setup", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-default-call-context-"));
        const lines = ["Sub DefaultHierarchyTarget(ByVal value As Long)", "End Sub", "Sub DefaultHierarchyCaller()",
            "#ifdef ALTERNATE", "DefaultHierarchyTarget(CLng(1))", "#else", "DefaultHierarchyTarget(CLng(2))",
            "#endif", "End Sub", "DefaultHierarchyCaller()", ""];
        const source = lines.join("\n");
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["analysis.projectContexts", []],
                ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            for (const bridge of [false, true]) {
                const filePath = path.join(directory, bridge ? "bridge.bas" : "stock.bas");
                fs.writeFileSync(filePath, source);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                assert.equal(vscode.workspace.getWorkspaceFolder(current.uri), undefined);
                for (const alternate of [false, true]) {
                    await configuration.update("compiler.arguments", alternate ? ["-d", "ALTERNATE"] : [], vscode.ConfigurationTarget.Global);
                    const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                        position(current, "Sub DefaultHierarchyTarget", "Sub ".length + 1));
                    assert.equal(prepared.length, 1);
                    const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", prepared[0]);
                    const activeLine = alternate ? 4 : 6;
                    assert.deepEqual(incoming.map((call) => [call.from.uri.fsPath, call.from.name,
                        call.fromRanges.map((range) => range.start.line)]), [[filePath, "DefaultHierarchyCaller", [activeLine]]],
                    `bridge=${bridge}/alternate=${alternate}: only compiler-active calls belong in the default context`);
                    const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", incoming[0].from);
                    assert.deepEqual(outgoing.map((call) => [call.to.name, call.to.uri.fsPath,
                        call.fromRanges.map((range) => range.start.line)]), [["DefaultHierarchyTarget", filePath, [activeLine]]]);
                    const parents = await vscode.commands.executeCommand("vscode.provideIncomingCalls", incoming[0].from);
                    assert.deepEqual(parents.map((call) => [call.from.kind, call.from.uri.fsPath,
                        call.fromRanges.map((range) => range.start.line)]), [[vscode.SymbolKind.File, filePath, [9]]]);
                    assert.deepEqual(configuration.get("analysis.projectContexts"), [], "hierarchy must not create project settings");
                    assert.equal(configuration.get("analysis.activeContext"), null);
                }
                assert.equal(current.isDirty, false);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("header Call Hierarchy preserves its originating module without project setup", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-header-call-context-"));
        const header = ["Sub HeaderTarget(ByVal value As Long)", "End Sub", "Sub HeaderCaller()", "#ifdef ALTERNATE",
            "HeaderTarget(CLng(1))", "#else", "HeaderTarget(CLng(2))", "#endif", "End Sub", "HeaderCaller()", ""].join("\n");
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            for (const bridge of [false, true]) {
                const backendDirectory = path.join(directory, bridge ? "bridge" : "stock");
                fs.mkdirSync(backendDirectory);
                const headerPath = path.join(backendDirectory, "calls.bi");
                const sources = [[headerPath, header], [path.join(backendDirectory, "first.bas"), '#define ALTERNATE\n#include "calls.bi"\nHeaderCaller()\n'],
                    [path.join(backendDirectory, "second.bas"), '#include "calls.bi"\nHeaderCaller()\n']];
                for (const [file, text] of sources) fs.writeFileSync(file, text);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const preparedItems = [];
                for (const [filePath] of sources.slice(1)) {
                    const uri = vscode.Uri.file(filePath);
                    await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
                    const current = vscode.workspace.textDocuments.find((opened) => opened.uri.toString() === uri.toString());
                    const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", uri, position(current, "HeaderCaller()", 1));
                    assert.equal(prepared.length, 1);
                    assert.equal(prepared[0].uri.fsPath, headerPath);
                    preparedItems.push(prepared[0]);
                }
                for (const [step, rootIndex] of [0, 1, 0].entries()) {
                    const rootPath = sources[rootIndex + 1][0];
                    if (step === 2) {
                        const uri = vscode.Uri.file(rootPath);
                        await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
                        const beforeClose = vscode.workspace.textDocuments.find((opened) => opened.uri.toString() === uri.toString());
                        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                        const deadline = Date.now() + DOCUMENT_CHANGE_TIMEOUT_MS;
                        while (!beforeClose.isClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
                        assert.equal(beforeClose.isClosed, true, "the originating module must really unload before expansion");
                    }
                    // Closing a tab can resolve before its active-editor
                    // notification reaches the extension host. Establish a
                    // stable background editor before checking context loads.
                    const backgroundUri = vscode.Uri.file(sources[2][0]);
                    const background = vscode.workspace.textDocuments.find((opened) => opened.uri.toString() === backgroundUri.toString());
                    await vscode.window.showTextDocument(background);
                    const focusDeadline = Date.now() + DOCUMENT_CHANGE_TIMEOUT_MS;
                    while (vscode.window.activeTextEditor?.document.uri.toString() !== backgroundUri.toString() && Date.now() < focusDeadline) {
                        await new Promise((resolve) => setTimeout(resolve, 25));
                    }
                    const activeUri = backgroundUri.toString();
                    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), activeUri);
                    const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", preparedItems[rootIndex]);
                    const activeLine = rootIndex === 0 ? 4 : 6;
                    const actual = outgoing.map((call) => [call.to.uri.fsPath, call.to.name, call.fromRanges.map((range) => range.start.line)]);
                    assert.deepEqual(actual, [[headerPath, "HeaderTarget", [activeLine]]],
                        `bridge=${bridge}/step=${step}: retain the originating module's defines: ${JSON.stringify(actual)}`);
                    const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", outgoing[0].to);
                    assert.deepEqual(incoming.map((call) => [call.from.uri.fsPath, call.from.name, call.fromRanges.map((range) => range.start.line)]),
                        [[headerPath, "HeaderCaller", [activeLine]]]);
                    const parents = await vscode.commands.executeCommand("vscode.provideIncomingCalls", incoming[0].from);
                    assert.deepEqual(parents.map((call) => [call.from.uri.fsPath, call.fromRanges.map((range) => range.start.line)]).sort(),
                        [[headerPath, [9]], [rootPath, [rootIndex === 0 ? 2 : 1]]].sort());
                    for (const parent of parents) {
                        const moduleCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", parent.from);
                        assert.deepEqual(moduleCalls.map((call) => [call.to.uri.fsPath, call.to.name,
                            call.fromRanges.map((range) => range.start.line)]),
                            [[headerPath, "HeaderCaller", parent.fromRanges.map((range) => range.start.line)]],
                            "root and included-file module nodes must keep their own global sites, excluding routine bodies");
                    }
                    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), activeUri,
                        `bridge=${bridge}/step=${step}: loading a module context must not show its editor`);
                }
                for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
                assert.deepEqual(configuration.get("analysis.projectContexts"), []);
                assert.equal(configuration.get("analysis.activeContext"), null);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("project incoming Call Hierarchy uses native closed caller ownership", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-project-callers-"));
        const header = ["Declare Sub ProjectCallTarget Overload(ByVal value As Long)",
            "Declare Sub ProjectCallTarget Overload(ByVal value As Double)", "#ifdef ALTERNATE", "Declare Sub AlternateCaller()",
            "#else", "Declare Sub RemoteCaller()", "#endif", ""].join("\n");
        const caller = ['#include "api.bi"', "Sub LocalCaller()", "#ifdef ALTERNATE", "ProjectCallTarget(CLng(10))",
            "#else", "ProjectCallTarget(CLng(1))", "#endif", "End Sub",
            "ProjectCallTarget(CLng(2))", "Dim callback As Sub(ByVal As Long) = @ProjectCallTarget",
            "#ifdef ALTERNATE", "AlternateCaller()", "#else", "RemoteCaller()", "#endif", ""].join("\n");
        const other = ['#include "api.bi"', "#ifdef ALTERNATE", "Sub AlternateCaller()", "#else", "Sub RemoteCaller()", "#endif",
            "ProjectCallTarget(CLng(3))", "End Sub", "Type CallOwner", "number As Long", "Declare Constructor()", "End Type",
            "Constructor CallOwner()", "ProjectCallTarget(CLng(4))", "End Constructor", "ProjectCallTarget(CDbl(5))", ""].join("\n");
        const implementation = '#include "api.bi"\nSub ProjectCallTarget(ByVal value As Long)\nEnd Sub\nSub ProjectCallTarget(ByVal value As Double)\nEnd Sub\n';
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            for (const bridge of [false, true]) {
                const backendDirectory = path.join(directory, bridge ? "bridge" : "stock");
                fs.mkdirSync(backendDirectory);
                const callerPath = path.join(backendDirectory, "caller.bas"), otherPath = path.join(backendDirectory, "other.bas");
                const implementationPath = path.join(backendDirectory, "implementation.bas"), headerPath = path.join(backendDirectory, "api.bi");
                const sources = [[callerPath, caller], [otherPath, other], [implementationPath, implementation], [headerPath, header]];
                for (const [file, text] of sources) fs.writeFileSync(file, text);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{ name: "normal", modules: [callerPath, otherPath, implementationPath] },
                    { name: "alternate", modules: [callerPath, otherPath, implementationPath], arguments: ["-d", "ALTERNATE"] }], vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(callerPath));
                await vscode.window.showTextDocument(current);
                for (const name of ["normal", "alternate"]) {
                    await configuration.update("analysis.activeContext", { name, module: callerPath }, vscode.ConfigurationTarget.Global);
                    const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, position(current, "ProjectCallTarget(CLng(2))", 1));
                    assert.equal(prepared.length, 1);
                    const calls = await vscode.commands.executeCommand("vscode.provideIncomingCalls", prepared[0]);
                    const keys = (entries) => entries.map(JSON.stringify).sort();
                    const actual = calls.map((call) => [call.from.uri.fsPath, call.from.kind, call.from.selectionRange.start.line,
                        call.fromRanges.map((range) => range.start.line)]);
                    const remoteLine = name === "normal" ? 4 : 2;
                    assert.deepEqual(keys(actual), keys([[callerPath, vscode.SymbolKind.Function, 1, [name === "normal" ? 5 : 3]],
                        [callerPath, vscode.SymbolKind.File, 0, [8]], [otherPath, vscode.SymbolKind.Function, remoteLine, [6]],
                        [otherPath, vscode.SymbolKind.Constructor, 12, [13]]]),
                    `bridge=${bridge}, ${name}: native callers, not inactive calls, address references or the other overload: ${JSON.stringify(actual)}`);
                    if (name === "normal") assert.equal(vscode.workspace.textDocuments.some((item) => item.uri.fsPath === otherPath), false);
                    const remote = calls.find((call) => call.from.uri.fsPath === otherPath && call.from.kind === vscode.SymbolKind.Function);
                    const parents = await vscode.commands.executeCommand("vscode.provideIncomingCalls", remote.from);
                    assert.deepEqual(parents.map((call) => [call.from.uri.fsPath, call.fromRanges.map((range) => range.start.line)]),
                        [[callerPath, [name === "normal" ? 13 : 11]]], "a closed caller must remain expandable in the incoming tree");
                    const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", remote.from);
                    assert.deepEqual(outgoing.map((call) => [call.to.uri.fsPath, call.to.selectionRange.start.line,
                        call.fromRanges.map((range) => range.start.line)]), [[headerPath, 0, [6]]],
                        "a conditional project caller must expand outgoing by native ownership too");
                }
                assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), current.uri.toString());
                for (const [file, text] of sources) assert.equal(fs.readFileSync(file, "utf8"), text);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("native outgoing Call Hierarchy expands special routine bodies in the active build", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-special-outgoing-"));
        const header = ["Declare Sub TraceLong(ByVal value As Long)", "Declare Sub TraceDouble(ByVal value As Double)",
            "Type CallOwner", "number As Long", "Declare Constructor(ByVal initial As Long)",
            "Declare Destructor()", "Declare Operator Cast() As Long", "End Type", ""].join("\n");
        const lines = ['#include "api.bi"', "#ifdef ALTERNATE", "Constructor CallOwner(ByVal alternateValue As Long)",
            "#else", "Constructor CallOwner(ByVal initial As Long)", "#endif", "TraceLong(CLng(1))",
            "Dim callback As Sub(ByVal As Double) = @TraceDouble", "End Constructor", "Destructor CallOwner()",
            "#ifdef ALTERNATE", "TraceDouble(CDbl(2))", "#else", "TraceLong(CLng(2))", "#endif", "End Destructor",
            "Operator CallOwner.Cast() As Long", "TraceLong(CLng(3))", "Return number", "End Operator", ""];
        const source = lines.join("\n");
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            for (const bridge of [false, true]) {
                const backendDirectory = path.join(directory, bridge ? "bridge" : "stock");
                fs.mkdirSync(backendDirectory);
                const filePath = path.join(backendDirectory, "main.bas"), headerPath = path.join(backendDirectory, "api.bi");
                fs.writeFileSync(filePath, source);
                fs.writeFileSync(headerPath, header);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{ name: "normal", modules: [filePath] },
                    { name: "alternate", modules: [filePath], arguments: ["-d", "ALTERNATE"] }], vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                for (const name of ["normal", "alternate"]) {
                    await configuration.update("analysis.activeContext", { name, module: filePath }, vscode.ConfigurationTarget.Global);
                    const callers = new Map();
                    for (const target of name === "normal" ? ["TraceLong"] : ["TraceLong", "TraceDouble"]) {
                        const anchor = target === "TraceLong" ? "TraceLong(CLng(1))" : "TraceDouble(CDbl(2))";
                        const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, position(current, anchor, 1));
                        assert.equal(prepared.length, 1, `${bridge}/${name}/${target}: prepare the native target`);
                        callers.set(target, await vscode.commands.executeCommand("vscode.provideIncomingCalls", prepared[0]));
                    }
                    for (const [line, kind, target, site] of [[name === "normal" ? 4 : 2, vscode.SymbolKind.Constructor, "TraceLong", 6],
                        [9, vscode.SymbolKind.Method, name === "normal" ? "TraceLong" : "TraceDouble", name === "normal" ? 13 : 11],
                        [16, vscode.SymbolKind.Method, "TraceLong", 17]]) {
                        const caller = callers.get(target).find((call) => call.from.uri.fsPath === filePath &&
                            call.from.selectionRange.start.line === line);
                        assert.ok(caller, `${bridge}/${name}: missing native owner on line ${line}`);
                        assert.equal(caller.from.kind, kind);
                        const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", caller.from);
                        const actual = outgoing.map((call) => [call.to.name, call.to.uri.fsPath,
                            call.fromRanges.map((range) => range.start.line)]);
                        assert.deepEqual(actual, [[target, headerPath, [site]]],
                            `${bridge}/${name}/${line}: preserve native ownership, excluding inactive calls and address-taking: ${JSON.stringify(actual)}`);
                    }
                }
                assert.equal(current.isDirty, false);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
                assert.equal(fs.readFileSync(headerPath, "utf8"), header);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE) await check("Call Hierarchy follows selected calls through unloaded modules", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-closed-hierarchy-"));
        const headerSource = 'Sub ClosedHeaderTarget Overload(ByVal wholeValue As Long = 7)\nEnd Sub\n' +
            'Sub ClosedHeaderTarget Overload(ByVal message As String)\nEnd Sub\n';
        const source = '#include "api.bi"\nSub ClosedDocumentCaller(ByVal ignoredValue As Long = 1)\n' +
            '    ClosedHeaderTarget\nEnd Sub\nClosedHeaderTarget\nClosedDocumentCaller\n';
        try {
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
            for (const backend of [...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                const backendDirectory = path.join(directory, backend);
                fs.mkdirSync(backendDirectory);
                const filePath = path.join(backendDirectory, "main.bas");
                const headerPath = path.join(backendDirectory, "api.bi");
                fs.writeFileSync(filePath, source);
                fs.writeFileSync(headerPath, headerSource);
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{ name: `closed-${backend}`, modules: [filePath] }], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", { name: `closed-${backend}`, module: filePath }, vscode.ConfigurationTarget.Global);
                const currentUri = vscode.Uri.file(filePath);
                // API-opened documents can outlive their tabs. Use a normal
                // editor open so this test can observe a genuinely closed model.
                await vscode.commands.executeCommand("vscode.open", currentUri, { preview: false });
                const current = vscode.workspace.textDocuments.find((opened) => opened.uri.toString() === currentUri.toString());
                assert.ok(current, `${backend}: open the caller through the editor`);
                const header = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
                // Folding reads the source cache in both backends; native
                // Outline instead requests compiler-owned declarations.
                const folds = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", current.uri);
                assert.ok(folds?.some((fold) => fold.start === 1), `${backend}: index the caller module`);
                // Preparing in the header pins that document, not the caller.
                const prepared = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", header.uri,
                    position(header, "ClosedHeaderTarget", 2));
                assert.equal(prepared.length, 1, `${backend}: header overload declaration`);
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", prepared[0]);
                const moduleCaller = incoming.find((call) => call.from.detail === "Module-level calls");
                const procedureCaller = incoming.find((call) => call.from.name === "ClosedDocumentCaller");
                assert.ok(moduleCaller && procedureCaller, `${backend}: selected bare calls in the root module: ${JSON.stringify(incoming.map((call) => ({ name: call.from.name, detail: call.from.detail, ranges: call.fromRanges })))}`);
                assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), currentUri.toString());
                await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                const deadline = Date.now() + DOCUMENT_CHANGE_TIMEOUT_MS;
                while (!current.isClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
                assert.equal(current.isClosed, true, `${backend}: the caller document must actually unload`);
                await vscode.window.showTextDocument(document);
                const activeEditor = vscode.window.activeTextEditor?.document.uri.toString();
                const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", moduleCaller.from);
                assert.deepEqual(outgoing.map((call) => call.to.name).sort(), ["ClosedDocumentCaller", "ClosedHeaderTarget"]);
                assert.match(outgoing.find((call) => call.to.name === "ClosedHeaderTarget").to.detail, /wholeValue As Long/i);
                assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), activeEditor);
                const callers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", procedureCaller.from);
                assert.equal(callers.length, 1, `${backend}: incoming optional call from an unloaded module`);
                assert.equal(callers[0].from.detail, "Module-level calls");
                assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), activeEditor);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
                assert.equal(fs.readFileSync(headerPath, "utf8"), headerSource);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await check("Signature Help and parameter hints follow bare procedure calls", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "compiler.arguments", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-bare-signatures-"));
        const source = fs.readFileSync(path.join(__dirname, "../fixtures/bare-signature-help.bas"), "utf8");
        try {
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
            for (const backend of ["source", ...(process.env.FBC_EXECUTABLE ? ["stock"] : []), ...(process.env.FBC_EDITOR_EXECUTABLE ? ["bridge"] : [])]) {
                await configuration.update("analysis.compilerPath", backend === "bridge" ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", backend === "stock" ? process.env.FBC_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", backend === "source" ? "off" : "onDemand", vscode.ConfigurationTarget.Global);
                const filePath = path.join(directory, `${backend}.bas`);
                fs.writeFileSync(filePath, source);
                if (process.env.FBC_EXECUTABLE) {
                    const { runFreeBasicCompiler } = require(path.join(extension.extensionPath, "lib/compiler-diagnostics"));
                    const compiled = await runFreeBasicCompiler({ compilerPath: process.env.FBC_EXECUTABLE, filePath });
                    assert.equal(compiled.exitCode, 0, compiled.output);
                }
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                const pointerCall = position(current, 'receiverPointer->SetValues 2, "pointer"');
                const pointerHints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri,
                    new vscode.Range(pointerCall.line, 0, pointerCall.line, current.lineAt(pointerCall.line).text.length));
                const parameterHintLabel = (hint) => typeof hint.label === "string" ? hint.label
                    : hint.label.map((part) => part.value).join("");
                if (backend === "source") assert.equal(pointerHints.length, 0, "source mode must not guess parameter hints");
                else {
                    for (const [spelling, prefix, label] of [
                        ['receiverPointer->SetValues 2', 'receiverPointer->SetValues ', 'first:'],
                        ['"pointer"', '', 'second:']
                    ]) {
                        const expected = position(current, spelling, prefix.length);
                        assert.ok(pointerHints.some((hint) => parameterHintLabel(hint) === label && hint.position.isEqual(expected)),
                            `${backend}: on-demand bare pointer argument ${label}`);
                    }
                }
                for (const [text, prefix, name, parameter] of [
                    ['BareCalls.AcceptValues CLng(1), "a,b", 3', "BareCalls.AcceptValues ", "AcceptValues", 0],
                    ['BareCalls.AcceptValues CLng(1), "a,b", 3', "BareCalls.AcceptValues CLng(1), ", "AcceptValues", 1],
                    ['"continued,argument", _\n    3', '"continued,argument", _\n    3', "AcceptValues", 2],
                    ['receiver.SetValues 1, "member"', "receiver.SetValues 1, ", "SetValues", 1],
                    ['receiverPointer->SetValues 2, "pointer"', "receiverPointer->SetValues 2, ", "SetValues", 1],
                    ['If 1 Then BareCalls.AcceptValues 1, "inline", 2', "If 1 Then BareCalls.AcceptValues 1, ", "AcceptValues", 1],
                    ['Else BareCalls.AcceptValues 2, "else", 3', "Else BareCalls.AcceptValues 2, ", "AcceptValues", 1]
                ]) {
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, text, prefix.length));
                    assert.ok(help?.signatures.length, `${backend}: ${text}`);
                    assert.match(help.signatures[help.activeSignature || 0].label, new RegExp(name));
                    assert.equal(help.activeParameter, parameter, `${backend}: ${text}`);
                }
                const selected = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                    position(current, 'BareCalls.SelectValues CDbl(2), "selected"', "BareCalls.SelectValues CDbl(2), ".length));
                assert.ok(selected?.signatures.length);
                if (backend !== "source") assert.match(selected.signatures[selected.activeSignature || 0].label, /first As Double/i,
                    `${backend}: compiler-selected bare-call overload`);
                if (backend !== "source") {
                    const hints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", current.uri,
                        new vscode.Range(0, 0, current.lineCount - 1, current.lineAt(current.lineCount - 1).text.length));
                    for (const [spelling, prefix, label] of [
                        ['BareCalls.AcceptValues CLng(1)', 'BareCalls.AcceptValues ', 'first:'],
                        ['"a,b", 3', '', 'second:'],
                        ['"continued,argument", _', '', 'second:'],
                        ['    3\nBareCalls.SelectValues', '    ', 'third:'],
                        ['receiver.SetValues 1, "member"', 'receiver.SetValues ', 'first:'],
                        ['"member"', '', 'second:'],
                        ['"inline", 2 Else', '', 'second:'],
                        ['"else", 3', '', 'second:']
                    ]) {
                        const expected = position(current, spelling, prefix.length);
                        assert.ok(hints.some((hint) => parameterHintLabel(hint) === label && hint.position.isEqual(expected)),
                            `${backend}: ${spelling} argument ${label}`);
                    }
                }
                assert.equal(current.isDirty, false);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await check("signature help resolves square-bracket operator overloads", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const previousCompiler = configuration.get("analysis.compilerPath", "");
        const indexUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-expression-operations.bas"));
        const indexDocument = await vscode.workspace.openTextDocument(indexUri);
        try {
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(indexDocument);
            const signature = await vscode.commands.executeCommand(
                "vscode.executeSignatureHelpProvider", indexUri,
                position(indexDocument, "indexedInstance[0]", "indexedInstance[".length)
            );
            assert.equal(signature.signatures.length, 3);
            assert.ok(signature.signatures.some((entry) => /Operator\s+\[\]\(ByVal index As Long\) As Double/i.test(entry.label)));
            assert.ok(signature.signatures.some((entry) => /Operator\s+\[\]\(ByVal index As Double\) As Double/i.test(entry.label)));
            assert.ok(signature.signatures.some((entry) => /Operator\s+\[\]\(ByVal index As String\) As IndexedResult/i.test(entry.label)));
            assert.equal(signature.activeParameter, 0);

            const multilineSource = [
                "Function SelectValue(ByVal first As Long, ByVal second As Long, ByVal third As Long) As Long",
                "End Function",
                "Dim selectedValue As Long",
                "selectedValue = SelectValue(",
                "    1,",
                "    2,",
                "    3",
                ")"
            ].join("\n");
            const multilineDocument = await vscode.workspace.openTextDocument({
                language: "freebasic",
                content: multilineSource
            });
            const multilineSignature = await vscode.commands.executeCommand(
                "vscode.executeSignatureHelpProvider",
                multilineDocument.uri,
                new vscode.Position(5, 5)
            );
            assert.equal(multilineSignature.activeParameter, 1,
                "Signature Help should retain the active argument across call line breaks");
            assert.match(multilineSignature.signatures[0].label, /SelectValue\(ByVal first As Long/i);
        } finally {
            await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    await check("definition resolves square-bracket operator overloads", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const previousCompiler = configuration.get("analysis.compilerPath", "");
        const indexUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-expression-operations.bas"));
        const indexDocument = await vscode.workspace.openTextDocument(indexUri);
        try {
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(indexDocument);
            const indexPosition = position(indexDocument, "indexedInstance[0]", "indexedInstance[".length);
            const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", indexUri, indexPosition);
            assert.ok(definitions.some((entry) =>
                /Operator\s+IndexedValue\.\[\]\(/i.test(indexDocument.lineAt(entry.range.start.line).text)
            ), "the index expression should navigate to its source Operator [] implementation");
        } finally {
            await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    await check("declaration and implementation resolve square-bracket operators", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const previousCompiler = configuration.get("analysis.compilerPath", "");
        const indexUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-expression-operations.bas"));
        const indexDocument = await vscode.workspace.openTextDocument(indexUri);
        try {
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(indexDocument);
            const indexPosition = position(indexDocument, "indexedInstance[0]", "indexedInstance[".length);
            const declarations = await vscode.commands.executeCommand("vscode.executeDeclarationProvider", indexUri, indexPosition);
            assert.ok(declarations.some((entry) =>
                /Declare\s+Operator\s+\[\]/i.test(indexDocument.lineAt(entry.range.start.line).text)
            ), "the index expression should navigate to its source Operator [] declaration");
            const implementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", indexUri, indexPosition);
            assert.ok(implementations.some((entry) =>
                /Operator\s+IndexedValue\.\[\]\(/i.test(indexDocument.lineAt(entry.range.start.line).text)
            ), "the index expression should navigate to its source Operator [] implementation");
            const resultPosition = position(indexDocument, 'indexedInstance["slot"]', "indexedInstance[".length);
            const resultTypes = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", indexUri, resultPosition);
            assert.ok(resultTypes.some((entry) => indexDocument.lineAt(entry.range.start.line).text === "Type IndexedResult"),
                "sidecar Type Definition should follow the index expression's compiler-selected result type");
            const indexHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", indexUri, resultPosition);
            const indexHoverText = indexHover.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n");
            assert.match(indexHoverText, /Declare\s+Operator\s+\[\]\(ByVal index As String\) As IndexedResult/i);
            assert.match(indexHoverText, /Compiler type: `IndexedResult`/i);
        } finally {
            await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    await check("references distinguish fields from locals", async () => {
        const locations = await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, position(document, "item.x = x", 9));
        assert.equal(locations.length, 2);
        assert.ok(locations.every((location) => location.uri.toString() === uri.toString()));
    });
    await check("rename edits only the selected local", async () => {
        const edits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", uri, position(document, "item.x = x", 9), "localValue");
        assert.ok(edits);
        assert.equal(edits.get(uri).length, 2);
        assert.ok(edits.get(uri).every((edit) => document.getText(edit.range) === "x"));
    });
    await check("builtin hover and signatures include manual information", async () => {
        const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position(document, "Sin(0.5)", 1));
        assert.match(hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /sine of an angle/);
        const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri, position(document, "Sin(0.5)", 6));
        assert.ok(signature.signatures.length > 0);
        assert.match(signature.signatures[0].parameters[0].label, /angle/);
        const written = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, position(document, "Sin(0.5)", 2));
        const existingSin = written.items.find((item) => String(item.label).toLowerCase() === "sin" &&
            item.kind !== vscode.CompletionItemKind.Text);
        const existingInsertion = typeof existingSin?.insertText === "string" ? existingSin.insertText : existingSin?.insertText?.value;
        assert.equal(existingInsertion?.toLowerCase(), "sin", "existing builtin arguments must not receive another call template");
        const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
            document.positionAt(document.getText().length));
        const sin = completions.items.find((item) => String(item.label).toLowerCase() === "sin" &&
            item.kind !== vscode.CompletionItemKind.Text);
        const sinSnippet = typeof sin?.insertText === "string" ? sin.insertText : sin?.insertText?.value;
        assert.equal(sinSnippet, "Sin(${1:angle})$0", "manual-backed builtin completion should insert its shared parameter name");
        const screenRes = completions.items.find((item) => String(item.label).toLowerCase() === "screenres");
        const screenResSnippet = typeof screenRes?.insertText === "string" ? screenRes.insertText : screenRes?.insertText?.value;
        assert.equal(screenResSnippet, "Screenres(${1:width}, ${2:height})$0",
            "manual-backed builtin completion should omit trailing defaulted arguments");
        const getMouse = completions.items.find((item) => String(item.label).toLowerCase() === "getmouse");
        const getMouseSnippet = typeof getMouse?.insertText === "string" ? getMouse.insertText : getMouse?.insertText?.value;
        assert.equal(getMouseSnippet, "Getmouse(${1:x}, ${2:y})$0",
            "compatible reference overloads should share required parameter placeholders");
        const len = completions.items.find((item) => String(item.label).toLowerCase() === "len");
        assert.equal(len.insertText, "LEN", "reference overloads with different parameter names should remain name-only");
        // VS Code resolves documentation when the suggestion detail pane opens.
        const resolved = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
            document.positionAt(document.getText().length), undefined, completions.items.length);
        for (const [name, parameters] of [["Gfx3ScreenCapture", 5], ["Gfx3SurfaceCopyFromScreen", 7]]) {
            const item = resolved.items.find((candidate) => String(candidate.label).toLowerCase() === name.toLowerCase());
            const snippet = typeof item?.insertText === "string" ? item.insertText : item?.insertText?.value;
            assert.equal((snippet?.match(/\$\{\d+:/g) || []).length, parameters, name);
            const imports = (item.additionalTextEdits || []).map((edit) => edit.newText).join("\n");
            assert.match(imports, /#include once "fbgfx3\.bi"/);
            assert.match(imports, /using fb/i);
            const documentation = typeof item.documentation === "string" ? item.documentation : item.documentation?.value;
            assert.match(documentation || "", /selects and links gfxlib3/i);
        }
    });
    await check("member signature uses the user declaration", async () => {
        const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri, position(document, "origin.SetX (20)", 14));
        assert.ok(signature?.signatures.length);
        assert.match(signature.signatures[0].parameters[0].label, /newValue/);
    });
    if (process.env.FBC_EDITOR_EXECUTABLE) await check("native index Signature Help survives incomplete unsaved brackets", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run", "compiler.path", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-index-signature-recovery-"));
        const filePath = path.join(directory, "main.bas");
        const prefix = ["Type RecoveryIndex", "value As Long", "Declare Operator [](ByVal index As Long) As Long",
            "Declare Operator [](ByVal index As Double) As Long", "Private:", "Declare Operator [](ByVal index As String) As Long",
            "Public:", "Declare Sub Inspect()", "Declare Static Sub InspectStatic()", "End Type", "Type Holder",
            "item As RecoveryIndex", "Private:", "hidden As RecoveryIndex", "End Type", "Dim item As RecoveryIndex",
            "Dim holderValue As Holder", "Dim indexedValues(0 To 1) As RecoveryIndex", "Dim pointerValue As RecoveryIndex Ptr = @item",
            "Declare Function MakeIndex() As RecoveryIndex", ""].join("\n");
        const saved = prefix + "Print 1\n";
        try {
            fs.writeFileSync(filePath, saved);
            for (const [name, value] of [["analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE], ["compiler.path", ""],
                ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(current);
            for (const [statement, expected, before = "", after = ""] of [
                ["Print item[", 2], ["Print holderValue.item[", 2], ["Print This[", 3, "Sub RecoveryIndex.Inspect()\n", "End Sub\n"],
                ["Print This[", 0, "Sub RecoveryIndex.InspectStatic()\n", "End Sub\n"], ["Print pointerValue[", 0],
                ["Print indexedValues[", 0], ["Print holderValue.hidden[", 0], ["Print item[", 0, "Sub Shadow(ByVal item As Long)\n", "End Sub\n"],
                ["Print MakeIndex()[", 2], ["Print indexedValues(0)[", 2], ["Print (*pointerValue)[", 2], ["Print (item)[", 2],
                ["Print (pointerValue)[", 0], ["Print indexedValues()[", 0], ["Print indexedValues(0, 1)[", 0]
            ]) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(current.uri, new vscode.Range(new vscode.Position(0, 0), current.positionAt(current.getText().length)),
                    prefix + before + statement + "\n" + after);
                await applyEditAndWaitForDocuments(edit, [current]);
                const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                    position(current, statement, statement.length));
                const signatures = help?.signatures.filter((entry) => /\boperator\s*\[\]/i.test(entry.label)) || [];
                assert.equal(signatures.length, expected, `native incomplete index signatures: ${before}${statement}`);
                if (expected) {
                    assert.equal(help.activeParameter, 0);
                    assert.ok(signatures.every((entry) => entry.parameters.length === 1 && /ByVal index As /i.test(entry.label)),
                        "native recovery must retain the complete index parameter label");
                    if (expected !== 3) assert.ok(signatures.every((entry) => !/index As String/i.test(entry.label)));
                }
                assert.equal(current.isDirty, true);
                assert.equal(fs.readFileSync(filePath, "utf8"), saved);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EDITOR_EXECUTABLE) await check("native constructor Signature Help survives incomplete unsaved calls", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
            "compiler.path", "diagnostics.run"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-constructor-signature-recovery-"));
        const filePath = path.join(directory, "main.bas");
        const prefix = ["Type RecoveryWidget", "value As Long",
            "Declare Constructor(ByVal amount As Long, ByVal scale As Double)",
            "Declare Constructor(ByVal amount As Double, ByVal scale As Double)",
            "Private:", "Declare Constructor(ByVal amount As String, ByVal scale As Double)", "End Type", ""].join("\n");
        const saved = prefix + "Print 1\n";
        try {
            fs.writeFileSync(filePath, saved);
            for (const [name, value] of [["analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE], ["compiler.path", ""],
                ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"], ["diagnostics.run", "off"]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(current);
            for (const [before, statement, after, expected] of [
                [prefix, "Dim result As RecoveryWidget = RecoveryWidget(1,", "", 2],
                [prefix, "Dim allocated As RecoveryWidget Ptr = New RecoveryWidget(1,", "", 2],
                [prefix + "Sub Work(ByVal RecoveryWidget As Long)\n", "Print RecoveryWidget(1,", "End Sub\n", 2],
                ["Namespace Types\n" + prefix + "End Namespace\nUsing Types\nSub Work(ByVal RecoveryWidget As Long)\n",
                    "Print RecoveryWidget(1,", "End Sub\n", 0],
                [prefix, "Dim result As RecoveryWidget = Type<RecoveryWidget>(1,", "", 2],
                [prefix, "Dim result As RecoveryWidget = Type<RecoveryWidget>(1, )", "", 2],
                [prefix + "Type RecoveryAlias As RecoveryWidget\n", "Dim result As RecoveryWidget = Type<RecoveryAlias>(1,", "", 2],
                ["Namespace Types\n" + prefix + "End Namespace\n", "Dim result As Types.RecoveryWidget = Type<Types.RecoveryWidget>(1,", "", 2],
                [prefix, "Dim result As RecoveryWidget = Type<TypeOf(RecoveryWidget)>(1,", "", 2],
                [prefix + "Dim original As RecoveryWidget = Any\n", "Dim result As RecoveryWidget = Type<TypeOf(original)>(1,", "", 2],
                [prefix + "Dim original As RecoveryWidget = Any\n", "Dim result As RecoveryWidget = Type<TypeOf((original))>(1,", "", 2],
                [prefix + "Declare Function Factory() As RecoveryWidget\n", "Dim result As RecoveryWidget = Type<TypeOf(Factory())>(1,", "", 2],
                [prefix + "Declare Function OptionalFactory(ByVal amount As Long = 0) As RecoveryWidget\n",
                    "Dim result As RecoveryWidget = Type<TypeOf(OptionalFactory())>(1,", "", 2],
                [prefix + "Declare Function OptionalFactory(ByVal amount As Long = 0) As RecoveryWidget\n",
                    'Dim result As RecoveryWidget = Type<TypeOf(OptionalFactory("1"))>(1,', "", 0],
                [prefix + "Declare Function NeedsArgument(ByVal amount As Long) As RecoveryWidget\n",
                    "Dim result As RecoveryWidget = Type<TypeOf(NeedsArgument())>(1,", "", 0],
                [prefix + "Declare Function PointerFactory() As RecoveryWidget Ptr\n",
                    "Dim result As RecoveryWidget = Type<TypeOf(PointerFactory())>(1,", "", 0],
                ['#lang "deprecated"\n' + prefix + "Option NoKeyword TYPEOF\n" +
                    "Declare Function TYPEOF(ByVal value As RecoveryWidget) As Long\nDeclare Function Factory() As RecoveryWidget\n",
                    "Dim result As RecoveryWidget = Type<TypeOf(Factory())>(1,", "", 0],
                [prefix + "Type PointerAlias As RecoveryWidget Ptr\n", "Dim result As RecoveryWidget = Type<PointerAlias>(1,", "", 0],
                [prefix + "Type ScalarAlias As Long\n", "Dim result As RecoveryWidget = Type<ScalarAlias>(1,", "", 0]
            ]) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(current.uri, new vscode.Range(new vscode.Position(0, 0), current.positionAt(current.getText().length)),
                    before + statement + "\n" + after);
                await applyEditAndWaitForDocuments(edit, [current]);
                const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                    position(current, statement, statement.endsWith(")") ? statement.lastIndexOf(",") + 1 : statement.length));
                const signatures = help?.signatures.filter((entry) => /\bconstructor\b/i.test(entry.label)) || [];
                assert.equal(signatures.length, expected, `native incomplete constructor signatures: ${statement}\n${before}`);
                if (expected) {
                    assert.equal(help.activeParameter, 1);
                    assert.ok(signatures.every((entry) => entry.parameters.length === 2 && !/amount As String/i.test(entry.label)),
                        "private constructor overloads must stay hidden during recovery");
                }
                assert.equal(current.isDirty, true);
                assert.equal(fs.readFileSync(filePath, "utf8"), saved, "Signature Help must not save the broken buffer");
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await check("UDT constructor calls show their declared signature", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const previousCompiler = configuration.get("analysis.compilerPath", "");
        const previousSourceCompiler = configuration.get("compiler.path", "fbc");
        const constructorUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-types.bas"));
        const constructorDocument = await vscode.workspace.openTextDocument(constructorUri);
        try {
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", "", vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(constructorDocument);
            const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", constructorUri,
                position(constructorDocument, "WrappedValue(5)", "WrappedValue(".length));
            assert.ok(signature?.signatures.some((entry) => /Declare\s+Constructor\(ByVal source As Long\)/i.test(entry.label)));
            assert.equal(signature.activeParameter, 0);
            const constructorHovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", constructorUri,
                position(constructorDocument, "WrappedValue(5)", 1));
            assert.match(constructorHovers.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n"),
                /Declare Constructor\(ByVal source As Long\)/i);
            const newSignature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", constructorUri,
                position(constructorDocument, "New WrappedValue(5)", "New WrappedValue(".length));
            assert.ok(newSignature?.signatures.some((entry) => /Declare\s+Constructor\(ByVal source As Long\)/i.test(entry.label)));
            const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", constructorUri,
                position(constructorDocument, "New WrappedValue(5)", "New WrappedValue".length));
            const wrappedValue = completions.items.find((item) => item.label === "WrappedValue" && item.kind !== vscode.CompletionItemKind.Text);
            const snippet = typeof wrappedValue?.insertText === "string" ? wrappedValue.insertText : wrappedValue?.insertText?.value;
            assert.equal(snippet, "WrappedValue", "written constructor arguments must remain outside the completion edit");

            const overloadedSource = [
                "Type OverloadedValue",
                "    Declare Constructor(ByVal source As Long)",
                "    Declare Constructor(ByVal source As Double)",
                "End Type",
                "Dim value As OverloadedValue Ptr = New OverloadedValue(5)"
            ].join("\n");
            const overloadedDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: overloadedSource });
            const overloadedCompletions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider",
                overloadedDocument.uri, position(overloadedDocument, "New OverloadedValue(5)", "New OverloadedValue".length));
            const overloadedItem = overloadedCompletions.items.find((item) => item.label === "OverloadedValue");
            const overloadedSnippet = typeof overloadedItem?.insertText === "string"
                ? overloadedItem.insertText : overloadedItem?.insertText?.value;
            assert.equal(overloadedSnippet, "OverloadedValue",
                "ambiguous constructor overloads should keep type completion name-only");
        } finally {
            await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", previousSourceCompiler, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    await check("stock FBC sidecar selects the constructor overload for NEW Signature Help", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const previousCompiler = configuration.get("analysis.compilerPath", "");
        const previousSourceCompiler = configuration.get("compiler.path", "fbc");
        const constructorUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-constructor-overloads.bas"));
        const constructorDocument = await vscode.workspace.openTextDocument(constructorUri);
        try {
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", "fbc", vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(constructorDocument);
            const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", constructorUri,
                position(constructorDocument, "New ConstructorChoice(CDbl(5))", "New ConstructorChoice(".length));
            assert.equal(signature?.signatures.length, 1);
            assert.match(signature.signatures[0].label, /Constructor ConstructorChoice\(ByVal source As Double\)/i);
            const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", constructorUri,
                position(constructorDocument, "Declare Constructor(ByVal source As Double)", "Declare ".length),
                { includeDeclaration: true });
            const referencedLines = new Set(references.map((entry) => entry.range.start.line));
            const doubleNewLine = position(constructorDocument, "New ConstructorChoice(CDbl(5))").line;
            const longNewLine = position(constructorDocument, "New ConstructorChoice(5)").line;
            for (const [lineText, typeName] of [
                ["New ConstructorChoice(5)", "Long"],
                ["New ConstructorChoice(CDbl(5))", "Double"]
            ]) {
                const constructorPosition = position(constructorDocument, lineText,
                    "New ".length + "ConstructorChoice".length - 1);
                const definitions = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", constructorUri, constructorPosition
                );
                assert.equal(definitions.length, 1, `NEW should navigate to the selected ${typeName} constructor`);
                assert.match(constructorDocument.lineAt(definitions[0].range.start.line).text,
                    new RegExp(`^Constructor ConstructorChoice\\(ByVal source As ${typeName}\\)`, "i"));
            }
            for (const [lineText, cursorOffset, expectedDeclaration] of [
                ["Dim defaultChoice As ConstructorChoice Ptr = New ConstructorChoice", 
                    "Dim defaultChoice As ConstructorChoice Ptr = New ".length + "ConstructorChoice".length - 1,
                    /^Constructor ConstructorChoice\(\)/i],
                ["Return ConstructorChoice()", "Return ".length + "ConstructorChoice".length - 1,
                    /^Constructor ConstructorChoice\(\)/i]
            ]) {
                const constructorPosition = position(constructorDocument, lineText, cursorOffset);
                const definitions = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", constructorUri, constructorPosition
                );
                assert.equal(definitions.length, 1, `${lineText} should navigate to its selected constructor`);
                assert.match(constructorDocument.lineAt(definitions[0].range.start.line).text, expectedDeclaration,
                    `${lineText} should navigate to its compiler-selected constructor`);
            }
            const doublePrototypeLine = position(constructorDocument, "Declare Constructor(ByVal source As Double)").line;
            const doubleDefinitionLine = position(constructorDocument, "Constructor ConstructorChoice(ByVal source As Double)").line;
            assert.ok(referencedLines.has(doubleNewLine), "stock sidecar constructor references should include the selected NEW use");
            assert.ok(referencedLines.has(doublePrototypeLine), "stock sidecar constructor references should include the matching prototype");
            assert.ok(referencedLines.has(doubleDefinitionLine), "stock sidecar constructor references should include the matching definition");
            assert.equal(referencedLines.has(longNewLine), false, "stock sidecar constructor references should exclude the sibling overload");
            const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", constructorUri,
                position(constructorDocument, "New ConstructorChoice(CDbl(5))", "New ".length));
            const highlightedLines = new Set(highlights.map((entry) => entry.range.start.line));
            assert.ok(highlightedLines.has(doubleNewLine));
            assert.equal(highlightedLines.has(longNewLine), false,
                "stock sidecar constructor highlights should exclude the sibling overload");
            const doubleNewPosition = position(constructorDocument,
                "New ConstructorChoice(CDbl(5))", "New ".length);
            const constructorHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri, doubleNewPosition
            );
            assert.equal(constructorHierarchy.length, 1);
            assert.match(constructorHierarchy[0].detail, /ConstructorChoice\(ByVal source As Double\)/i);
            const constructorCallers = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", constructorHierarchy[0]
            );
            const constructorModuleCaller = constructorCallers.find((call) => call.from.detail === "Module-level calls");
            assert.ok(constructorModuleCaller, "stock-sidecar Call Hierarchy should include NEW constructor calls");
            assert.ok(constructorModuleCaller.fromRanges.some((range) =>
                constructorDocument.getText(range) === "ConstructorChoice"
            ));
            assert.equal(constructorModuleCaller.fromRanges.some((range) =>
                range.start.line === longNewLine
            ), false, "constructor Call Hierarchy should exclude the sibling overload");
            const doublePrototypePosition = position(constructorDocument,
                "Declare Constructor(ByVal source As Double)", "Declare ".length + "Constructor".length - 1);
            const prototypeHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri, doublePrototypePosition
            );
            assert.equal(prototypeHierarchy.length, 1,
                "Call Hierarchy should prepare at an overloaded constructor prototype");
            assert.match(prototypeHierarchy[0].detail, /ConstructorChoice\(ByVal source As Double\)/i);
            const prototypeIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", prototypeHierarchy[0]
            );
            const prototypeModuleCaller = prototypeIncoming.find((call) => call.from.detail === "Module-level calls");
            assert.ok(prototypeModuleCaller?.fromRanges.some((range) => range.start.line === doubleNewLine));
            assert.equal(prototypeModuleCaller?.fromRanges.some((range) => range.start.line === longNewLine), false,
                "Call Hierarchy from the prototype should keep the compiler-selected overload");
            const moduleConstructorCalls = await vscode.commands.executeCommand(
                "vscode.provideOutgoingCalls", constructorModuleCaller.from
            );
            assert.ok(moduleConstructorCalls.some((call) => /ByVal source As Double/i.test(call.to.detail)));
            assert.ok(moduleConstructorCalls.some((call) => /ByVal source As Long/i.test(call.to.detail)));
            const deletePosition = position(constructorDocument,
                "Delete disposedChoice", "Delete".length - 2);
            const arrayDeleteLine = position(constructorDocument, "Delete[] disposedChoices").line;
            const destructorHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri, deletePosition
            );
            assert.equal(destructorHierarchy.length, 1);
            assert.match(destructorHierarchy[0].detail, /Destructor ConstructorChoice/i);
            const destructorCallers = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", destructorHierarchy[0]
            );
            const deleteModuleCaller = destructorCallers.find((call) => call.from.detail === "Module-level calls");
            assert.ok(deleteModuleCaller, "stock-sidecar Call Hierarchy should include DELETE destructor calls");
            assert.ok(deleteModuleCaller.fromRanges.some((range) =>
                constructorDocument.getText(range) === "Delete"
            ));
            assert.ok(deleteModuleCaller.fromRanges.some((range) => range.start.line === arrayDeleteLine),
                "DELETE[] should share the selected destructor edge with scalar DELETE");
            assert.ok(moduleConstructorCalls.some((call) => /Destructor ConstructorChoice/i.test(call.to.detail)));
            const localDestructorCaller = destructorCallers.find((call) => call.from.name === "makeReturnedChoice");
            assert.ok(localDestructorCaller, "local destructor calls should appear in the destructor's incoming hierarchy");
            assert.ok(localDestructorCaller.fromRanges.some((range) =>
                constructorDocument.getText(range) === "localChoice"
            ));
            const temporaryDestructorCaller = destructorCallers.find((call) =>
                call.from.name === "inspectTemporaryChoice");
            assert.ok(temporaryDestructorCaller,
                "temporary destruction should appear as an incoming destructor call");
            assert.ok(temporaryDestructorCaller.fromRanges.some((range) =>
                constructorDocument.getText(range).includes("makeTemporaryChoice()")
            ));
            const scopeExitPosition = position(constructorDocument, "Exit Sub", 1);
            const scopeExitHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri, scopeExitPosition
            );
            assert.equal(scopeExitHierarchy.length, 1);
            assert.match(scopeExitHierarchy[0].detail, /Destructor ConstructorChoice/i);
            const scopeExitCallers = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", scopeExitHierarchy[0]
            );
            const scopeExitCaller = scopeExitCallers.find((call) => call.from.name === "scopeDisposeChoice");
            assert.ok(scopeExitCaller, "scope-exit cleanup should appear as an incoming destructor call");
            assert.ok(scopeExitCaller.fromRanges.some((range) => range.start.line === scopeExitPosition.line));
            const scopeDisposeHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri,
                position(constructorDocument, "Sub scopeDisposeChoice", "Sub ".length + 2)
            );
            assert.equal(scopeDisposeHierarchy.length, 1);
            const scopeDisposeCalls = await vscode.commands.executeCommand(
                "vscode.provideOutgoingCalls", scopeDisposeHierarchy[0]
            );
            assert.ok(scopeDisposeCalls.some((call) => /Destructor ConstructorChoice/i.test(call.to.detail)));
            const temporaryCallerHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri,
                position(constructorDocument, "Sub inspectTemporaryChoice", "Sub ".length + 2)
            );
            assert.equal(temporaryCallerHierarchy.length, 1);
            const temporaryCallerCalls = await vscode.commands.executeCommand(
                "vscode.provideOutgoingCalls", temporaryCallerHierarchy[0]
            );
            const temporaryDestructorCall = temporaryCallerCalls.find((call) =>
                /Destructor ConstructorChoice/i.test(call.to.detail));
            assert.ok(temporaryDestructorCall,
                "procedure Call Hierarchy should include compiler-selected temporary destruction");
            assert.ok(temporaryDestructorCall.fromRanges.some((range) =>
                constructorDocument.getText(range).includes("makeTemporaryChoice()")
            ));
            const defaultNewPosition = position(constructorDocument,
                "Dim defaultChoice As ConstructorChoice Ptr = New ConstructorChoice",
                "Dim defaultChoice As ConstructorChoice Ptr = New ".length);
            const defaultConstructorHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri, defaultNewPosition
            );
            assert.equal(defaultConstructorHierarchy.length, 1);
            assert.match(defaultConstructorHierarchy[0].detail, /ConstructorChoice\(\)/i,
                "Call Hierarchy should also recognize NEW without explicit parentheses");
            const defaultConstructorCallers = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", defaultConstructorHierarchy[0]
            );
            const defaultConstructorModuleCaller = defaultConstructorCallers.find((call) =>
                call.from.detail === "Module-level calls");
            assert.ok(defaultConstructorModuleCaller);
            assert.ok(defaultConstructorModuleCaller.fromRanges.some((range) =>
                range.start.line === defaultNewPosition.line
            ));
            assert.ok(defaultConstructorCallers.some((call) => call.from.name === "makeReturnedChoice"),
                "constructor Call Hierarchy should include compiler-selected return construction");
            const procedureConstructorCaller = defaultConstructorCallers.find((call) =>
                call.from.name === "makeReturnedChoice");
            assert.ok(procedureConstructorCaller.fromRanges.some((range) =>
                constructorDocument.getText(range) === "localChoice"
            ), "constructor Call Hierarchy should include local default construction");
            assert.ok(moduleConstructorCalls.some((call) => /ConstructorChoice\(\)/i.test(call.to.detail)));
            const returnConstructorCaller = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri,
                position(constructorDocument, "Function makeReturnedChoice", "Function ".length + 2)
            );
            assert.equal(returnConstructorCaller.length, 1);
            const returnedConstructorCalls = await vscode.commands.executeCommand(
                "vscode.provideOutgoingCalls", returnConstructorCaller[0]
            );
            const localDestructorCall = returnedConstructorCalls.find((call) =>
                /Destructor ConstructorChoice/i.test(call.to.detail));
            assert.ok(localDestructorCall,
                "procedure Call Hierarchy should include compiler-selected local destruction");
            assert.ok(localDestructorCall.fromRanges.some((range) =>
                constructorDocument.getText(range) === "localChoice"
            ));
            const returnedConstructorCall = returnedConstructorCalls.find((call) =>
                /ConstructorChoice\(\)/i.test(call.to.detail));
            assert.ok(returnedConstructorCall,
                "procedure Call Hierarchy should include compiler-selected return construction");
            assert.ok(returnedConstructorCall.fromRanges.some((range) =>
                constructorDocument.getText(range) === "localChoice"
            ));
            const initializedLongConstructor = returnedConstructorCalls.find((call) =>
                /ByVal source As Long/i.test(call.to.detail));
            assert.ok(initializedLongConstructor,
                "procedure Call Hierarchy should include compiler-selected initializer construction");
            assert.ok(initializedLongConstructor.fromRanges.some((range) =>
                constructorDocument.getText(range) === "initializedChoice"
            ));
            const initializerConstructorCallers = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", initializedLongConstructor.to
            );
            const initializerProcedureCaller = initializerConstructorCallers.find((call) =>
                call.from.name === "makeReturnedChoice");
            assert.ok(initializerProcedureCaller);
            assert.ok(initializerProcedureCaller.fromRanges.some((range) =>
                constructorDocument.getText(range) === "initializedChoice"
            ));
            const returnedTypeCallHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri,
                position(constructorDocument, "Return ConstructorChoice()", "Return ".length + 2)
            );
            assert.equal(returnedTypeCallHierarchy.length, 1);
            assert.match(returnedTypeCallHierarchy[0].detail, /ConstructorChoice\(\)/i,
                "Call Hierarchy should prepare at an ordinary UDT constructor expression");
        } finally {
            await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.path", previousSourceCompiler, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    if (process.env.FBC_EDITOR_EXECUTABLE) await check("native compiler bridge semantic features follow selected operations", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const previousAnalysisCompiler = configuration.get("analysis.compilerPath", "");
        const previousProjectContexts = configuration.get("analysis.projectContexts", []);
        const previousActiveContext = configuration.get("analysis.activeContext", null);
        const previousArguments = configuration.get("compiler.arguments", []);
        const constructorUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-constructor-overloads.bas"));
        const constructorDocument = await vscode.workspace.openTextDocument(constructorUri);
        try {
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            const analyzeModule = async () => {
                /* A concurrently invalidated first snapshot is intentionally discarded. */
                const analyzed = await vscode.commands.executeCommand("freebasic.analyzeModule") ||
                    await vscode.commands.executeCommand("freebasic.analyzeModule");
                assert.equal(analyzed, true, "the bridge should publish a current compiler snapshot");
            };
            await vscode.window.showTextDocument(constructorDocument);
            await analyzeModule();
            const assertConstructorHierarchy = async (targetUri, targetDocument, targetPosition, signature) => {
                const hierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", targetUri, targetPosition
                );
                assert.equal(hierarchy.length, 1, "a compiler-selected constructor should prepare Call Hierarchy");
                assert.match(hierarchy[0].detail, signature);
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", hierarchy[0]);
                assert.ok(incoming.flatMap((call) => call.fromRanges).some((range) =>
                    range.start.line === targetPosition.line
                ), "the selected constructor should retain its physical incoming call site");
            };
            for (const [call, typeName] of [
                ["New ConstructorChoice(5)", "Long"],
                ["New ConstructorChoice(CDbl(5))", "Double"]
            ]) {
                const callPosition = position(constructorDocument, call,
                    "New ".length + "ConstructorChoice".length - 1);
                const definitions = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", constructorUri, callPosition
                );
                assert.equal(definitions.length, 1, `The ${typeName} NEW call should have one definition`);
                assert.match(constructorDocument.lineAt(definitions[0].range.start.line).text,
                    new RegExp(`^Constructor ConstructorChoice\\(ByVal source As ${typeName}\\)`, "i"));
                await assertConstructorHierarchy(constructorUri, constructorDocument, callPosition,
                    new RegExp(`ConstructorChoice\\(ByVal source As ${typeName}\\)`, "i"));
            }
            for (const [sourceText, cursorOffset] of [
                ["Dim defaultChoice As ConstructorChoice Ptr = New ConstructorChoice",
                    "Dim defaultChoice As ConstructorChoice Ptr = New ".length + "ConstructorChoice".length - 1],
                ["Return ConstructorChoice()", "Return ".length + "ConstructorChoice".length - 1]
            ]) {
                const constructorPosition = position(constructorDocument, sourceText, cursorOffset);
                const definitions = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", constructorUri, constructorPosition
                );
                assert.equal(definitions.length, 1, `${sourceText} should have one selected constructor definition`);
                assert.match(constructorDocument.lineAt(definitions[0].range.start.line).text,
                    /^Constructor ConstructorChoice\(\)/i);
                await assertConstructorHierarchy(constructorUri, constructorDocument, constructorPosition,
                    /ConstructorChoice\(\)/i);
            }
            const longNewLine = position(constructorDocument, "New ConstructorChoice(5)").line;
            const doubleNewLine = position(constructorDocument, "New ConstructorChoice(CDbl(5))").line;
            const longDeclarationPosition = position(constructorDocument,
                "Declare Constructor(ByVal source As Long)", "Declare ".length + "Constructor".length - 1);
            const declarationHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri, longDeclarationPosition
            );
            assert.equal(declarationHierarchy.length, 1,
                "A constructor prototype should prepare Call Hierarchy in the bridge");
            assert.match(declarationHierarchy[0].detail, /ConstructorChoice\(ByVal source As Long\)/i);
            const declarationIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", declarationHierarchy[0]
            );
            const declarationRanges = declarationIncoming.flatMap((call) => call.fromRanges);
            assert.ok(declarationRanges.some((range) => range.start.line === longNewLine));
            assert.equal(declarationRanges.some((range) => range.start.line === doubleNewLine), false,
                "Call Hierarchy from a constructor prototype should exclude the sibling overload");
            const scopeExitPosition = position(constructorDocument, "Exit Sub", 1);
            const destructorHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri, scopeExitPosition
            );
            assert.equal(destructorHierarchy.length, 1,
                "A compiler-generated scope-exit destructor should prepare Call Hierarchy in the bridge");
            assert.match(destructorHierarchy[0].detail, /Destructor ConstructorChoice/i);
            const destructorIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", destructorHierarchy[0]
            );
            const scopeExitCaller = destructorIncoming.find((call) => call.from.name === "scopeDisposeChoice");
            assert.ok(scopeExitCaller?.fromRanges.some((range) => range.start.line === scopeExitPosition.line),
                "The destructor's incoming hierarchy should retain the physical scope-exit statement");
            const deleteArrayPosition = position(constructorDocument, "Delete[] disposedChoices", "Delete".length - 1);
            const deleteHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", constructorUri, deleteArrayPosition
            );
            assert.equal(deleteHierarchy.length, 1, "DELETE[] should prepare the selected UDT destructor in the bridge");
            assert.match(deleteHierarchy[0].detail, /Destructor ConstructorChoice/i);
            const deleteIncoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", deleteHierarchy[0]);
            assert.ok(deleteIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === deleteArrayPosition.line
            ), "DELETE[] should appear as an incoming physical destructor edge in the bridge");
            const argumentUri = vscode.Uri.file(path.join(__dirname, "workspace/implicit-argument-constructor.bas"));
            const argumentDocument = await vscode.workspace.openTextDocument(argumentUri);
            await vscode.window.showTextDocument(argumentDocument);
            await analyzeModule();
            for (const [call, typeName, argument, otherArgument] of [
                ["takeArgument(17)", "Long", "17", "2.5"],
                ["takeArgument(2.5)", "Double", "2.5", "17"]
            ]) {
                const argumentPosition = position(argumentDocument, call, "takeArgument(".length);
                const definitions = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", argumentUri, argumentPosition
                );
                assert.equal(definitions.length, 1, `The ${typeName} argument should navigate to its constructor`);
                assert.match(argumentDocument.lineAt(definitions[0].range.start.line).text,
                    new RegExp(`^Constructor ArgumentValue\\(ByVal initial As ${typeName}\\)`, "i"));
                const hierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", argumentUri, argumentPosition
                );
                assert.equal(hierarchy.length, 1, `The ${typeName} conversion should prepare Call Hierarchy`);
                assert.match(hierarchy[0].detail,
                    new RegExp(`Constructor ArgumentValue\\(ByVal initial As ${typeName}\\)`, "i"));
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", hierarchy[0]);
                const incomingRanges = incoming.flatMap((call) => call.fromRanges);
                assert.ok(incomingRanges.some((range) => argumentDocument.getText(range).includes(argument)),
                    `The ${typeName} constructor hierarchy should include its physical argument site`);
                assert.equal(incomingRanges.some((range) => argumentDocument.getText(range).includes(otherArgument)), false,
                    `The ${typeName} constructor hierarchy should exclude the sibling conversion`);
                if (typeName === "Long") {
                    const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", hierarchy[0]);
                    assert.ok(outgoing.some((call) => call.to.name === "recordArgumentValue"),
                        "The selected constructor hierarchy should include calls from its implementation body");
                }
                const declarations = await vscode.commands.executeCommand(
                    "vscode.executeDeclarationProvider", argumentUri, argumentPosition
                );
                assert.equal(declarations.length, 1, `The ${typeName} argument should navigate to its prototype`);
                assert.match(argumentDocument.lineAt(declarations[0].range.start.line).text,
                    new RegExp(`^\\s*Declare Constructor\\(ByVal initial As ${typeName}\\)`, "i"));
                const implementations = await vscode.commands.executeCommand(
                    "vscode.executeImplementationProvider", argumentUri, argumentPosition
                );
                assert.equal(implementations.length, 1, `The ${typeName} argument should navigate to its implementation`);
                assert.match(argumentDocument.lineAt(implementations[0].range.start.line).text,
                    new RegExp(`^Constructor ArgumentValue\\(ByVal initial As ${typeName}\\)`, "i"));
            }
            for (const [call, argument, otherArgument] of [
                ["takeArgument(17)", "17", "2.5"],
                ["takeArgument(2.5)", "2.5", "17"]
            ]) {
                const argumentPosition = position(argumentDocument, call, "takeArgument(".length);
                const references = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", argumentUri, argumentPosition
                );
                const referenceTexts = references.map((entry) => argumentDocument.getText(entry.range));
                assert.ok(referenceTexts.some((text) => text.includes(argument)),
                    `${argument} should find references to its implicit constructor`);
                assert.equal(referenceTexts.some((text) => text.includes(otherArgument)), false,
                    `${argument} should exclude references to the sibling constructor`);
                const highlights = await vscode.commands.executeCommand(
                    "vscode.executeDocumentHighlights", argumentUri, argumentPosition
                );
                const highlightTexts = highlights.map((entry) => argumentDocument.getText(entry.range));
                assert.ok(highlightTexts.some((text) => text.includes(argument)),
                    `${argument} should highlight its implicit constructor use`);
                assert.equal(highlightTexts.some((text) => text.includes(otherArgument)), false,
                    `${argument} should not highlight the sibling constructor use`);
            }
            for (const [typeName, argument, otherArgument] of [
                ["Long", "17", "2.5"],
                ["Double", "2.5", "17"]
            ]) {
                const declaration = `Constructor ArgumentValue(ByVal initial As ${typeName})`;
                const constructorPosition = position(argumentDocument, declaration,
                    "Constructor ArgumentValue".length - 1);
                const references = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", argumentUri, constructorPosition, { includeDeclaration: true }
                );
                const referenceTexts = references.map((entry) => argumentDocument.getText(entry.range));
                assert.ok(referenceTexts.some((text) => text.includes(argument)),
                    `${typeName} constructor references should include its converted argument`);
                assert.equal(referenceTexts.some((text) => text.includes(otherArgument)), false,
                    `${typeName} constructor references should exclude the sibling conversion`);
                const highlights = await vscode.commands.executeCommand(
                    "vscode.executeDocumentHighlights", argumentUri, constructorPosition
                );
                const highlightTexts = highlights.map((entry) => argumentDocument.getText(entry.range));
                assert.ok(highlightTexts.some((text) => text.includes(argument)),
                    `${typeName} constructor highlights should include its converted argument`);
                assert.equal(highlightTexts.some((text) => text.includes(otherArgument)), false,
                    `${typeName} constructor highlights should exclude the sibling conversion`);
            }
            const operationsUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-delete-operator-hierarchy.bas"));
            const operationsDocument = await vscode.workspace.openTextDocument(operationsUri);
            await vscode.window.showTextDocument(operationsDocument);
            await analyzeModule();
            const operationDeleteArrayPosition = position(operationsDocument, "Delete[] deletedValues", "Delete".length - 1);
            const allocationDeleteHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operationsUri, operationDeleteArrayPosition
            );
            assert.equal(allocationDeleteHierarchy.length, 1,
                "a custom deallocator without a destructor should prepare one Call Hierarchy target");
            assert.ok(allocationDeleteHierarchy.some((item) => /Operator DeleteOperatorHierarchyValue\.Delete\[\]/i.test(item.detail)),
                `DELETE[] Call Hierarchy should retain the selected custom deallocator; got ${allocationDeleteHierarchy.map((item) => item.detail).join("; ")}`);
            const deallocatorDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operationsUri, operationDeleteArrayPosition
            );
            assert.equal(deallocatorDefinition.length, 1,
                "the compiler-selected DELETE[] operator should support Go to Definition in the bridge");
            assert.match(operationsDocument.lineAt(deallocatorDefinition[0].range.start.line).text,
                /^Operator DeleteOperatorHierarchyValue\.Delete\[\]/i);
            const deallocatorDeclaration = await vscode.commands.executeCommand(
                "vscode.executeDeclarationProvider", operationsUri, operationDeleteArrayPosition
            );
            assert.equal(deallocatorDeclaration.length, 1,
                "the compiler-selected DELETE[] operator should support Go to Declaration in the bridge");
            assert.match(operationsDocument.lineAt(deallocatorDeclaration[0].range.start.line).text,
                /^\s*Declare Operator Delete\[\]/i);
            const deallocatorImplementation = await vscode.commands.executeCommand(
                "vscode.executeImplementationProvider", operationsUri, operationDeleteArrayPosition
            );
            assert.equal(deallocatorImplementation.length, 1,
                "the compiler-selected DELETE[] operator should support Go to Implementation in the bridge");
            assert.match(operationsDocument.lineAt(deallocatorImplementation[0].range.start.line).text,
                /^Operator DeleteOperatorHierarchyValue\.Delete\[\]/i);
            const deallocatorReferences = await vscode.commands.executeCommand(
                "vscode.executeReferenceProvider", operationsUri, operationDeleteArrayPosition, { includeDeclaration: true }
            );
            assert.ok(deallocatorReferences.some((entry) => entry.uri.toString() === operationsUri.toString() &&
                entry.range.start.line === operationDeleteArrayPosition.line),
            "the compiler-selected DELETE[] operator should include its physical source operation in References");
            const deallocatorHighlights = await vscode.commands.executeCommand(
                "vscode.executeDocumentHighlights", operationsUri, operationDeleteArrayPosition
            );
            assert.ok(deallocatorHighlights.some((entry) => entry.range.start.line === operationDeleteArrayPosition.line),
                "the compiler-selected DELETE[] operator should highlight its physical source operation");
            const deallocatorHover = await vscode.commands.executeCommand(
                "vscode.executeHoverProvider", operationsUri, operationDeleteArrayPosition
            );
            assert.match(deallocatorHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                /Operator DeleteOperatorHierarchyValue\.Delete\[\]/i,
                "the compiler-selected DELETE[] operator should show the selected overload on hover");
            for (const item of allocationDeleteHierarchy) {
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", item);
                assert.ok(incoming.flatMap((call) => call.fromRanges).some((range) =>
                    range.start.line === operationDeleteArrayPosition.line
                ), `${item.detail} should receive the physical DELETE[] edge`);
            }
            const operationDeletePosition = position(operationsDocument, "Delete deletedValue", "Delete".length - 1);
            const scalarDeleteDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operationsUri, operationDeletePosition
            );
            assert.equal(scalarDeleteDefinition.length, 1,
                "scalar DELETE should follow its compiler-selected deallocator in the bridge");
            assert.match(operationsDocument.lineAt(scalarDeleteDefinition[0].range.start.line).text,
                /^Operator DeleteOperatorHierarchyValue\.Delete\(/i);
            const scalarDeleteHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operationsUri, operationDeletePosition
            );
            assert.equal(scalarDeleteHierarchy.length, 1,
                "scalar DELETE should prepare its custom deallocator in Call Hierarchy");
            const scalarDeleteIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", scalarDeleteHierarchy[0]
            );
            assert.ok(scalarDeleteIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === operationDeletePosition.line
            ), "scalar DELETE should retain its physical keyword edge");
            const allocationUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-new-operator-hierarchy.bas"));
            const allocationDocument = await vscode.workspace.openTextDocument(allocationUri);
            await vscode.window.showTextDocument(allocationDocument);
            await analyzeModule();
            for (const [site, operatorName] of [
                ["New NewOperatorHierarchyValue", "New"],
                ["New NewOperatorHierarchyValue[2]", "New[]"]
            ]) {
                const allocationPosition = position(allocationDocument, site, "New".length - 1);
                const definition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", allocationUri, allocationPosition
                );
                assert.equal(definition.length, 1,
                    `${operatorName} should follow its compiler-selected allocator in the bridge`);
                assert.match(allocationDocument.lineAt(definition[0].range.start.line).text,
                    new RegExp(`^Operator NewOperatorHierarchyValue\\.${operatorName.replace("[", "\\[").replace("]", "\\]")}\\(`, "i"));
                const hierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", allocationUri, allocationPosition
                );
                assert.equal(hierarchy.length, 1,
                    `${operatorName} should prepare its selected allocator in Call Hierarchy`);
                assert.match(hierarchy[0].detail, new RegExp(`Operator NewOperatorHierarchyValue\\.${operatorName.replace("[", "\\[").replace("]", "\\]")}`, "i"));
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", hierarchy[0]);
                assert.ok(incoming.flatMap((call) => call.fromRanges).some((range) =>
                    range.start.line === allocationPosition.line
                ), `${operatorName} should retain its physical NEW keyword edge`);
            }
            const operatorUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-overloaded-operator-bridge.bas"));
            const operatorDocument = await vscode.workspace.openTextDocument(operatorUri);
            await vscode.window.showTextDocument(operatorDocument);
            await analyzeModule();
            const doubleOperatorCall = "bridgeValue + CDbl(1)";
            const doubleOperatorPosition = position(operatorDocument, doubleOperatorCall, "bridgeValue ".length);
            const operatorDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, doubleOperatorPosition
            );
            assert.equal(operatorDefinition.length, 1,
                "binary operator navigation should follow the selected compiler receipt in the bridge");
            assert.match(operatorDocument.lineAt(operatorDefinition[0].range.start.line).text,
                /^Operator \+\(ByRef first As BridgeOperatorValue, ByVal second As Double\)/i);
            const operatorReferences = await vscode.commands.executeCommand(
                "vscode.executeReferenceProvider", operatorUri, doubleOperatorPosition, { includeDeclaration: true }
            );
            const operatorReferenceLines = operatorReferences
                .filter((entry) => entry.uri.toString() === operatorUri.toString())
                .map((entry) => entry.range.start.line);
            assert.ok(operatorReferenceLines.includes(doubleOperatorPosition.line),
                "binary operator references should include the selected physical expression");
            assert.equal(operatorReferenceLines.includes(position(operatorDocument, "bridgeValue + CLng(1)").line), false,
                "binary operator references should exclude the compiler-selected sibling overload");
            const operatorHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operatorUri, doubleOperatorPosition
            );
            assert.equal(operatorHierarchy.length, 1,
                "binary operator Call Hierarchy should prepare the selected overload in the bridge");
            assert.match(operatorHierarchy[0].detail, /ByVal second As Double/i);
            const operatorIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", operatorHierarchy[0]
            );
            const operatorModuleCaller = operatorIncoming.find((call) => call.from.detail === "Module-level calls");
            assert.ok(operatorModuleCaller?.fromRanges.some((range) => range.start.line === doubleOperatorPosition.line),
                "binary operator Call Hierarchy should preserve the selected physical expression edge");
            assert.equal(operatorModuleCaller.fromRanges.some((range) =>
                range.start.line === position(operatorDocument, "bridgeValue + CLng(1)").line
            ), false, "binary operator Call Hierarchy should exclude the sibling overload edge");
            const equalityLine = "If leftEquality = rightEquality Then Print 1";
            const equalityPosition = position(operatorDocument, equalityLine, "If leftEquality ".length);
            const equalityDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, equalityPosition
            );
            assert.equal(equalityDefinition.length, 1,
                "overloaded equality should follow its compiler receipt despite sharing '=' with assignment");
            assert.match(operatorDocument.lineAt(equalityDefinition[0].range.start.line).text,
                /^Operator =\(ByRef first As BridgeEqualityValue/i);
            const equalityHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operatorUri, equalityPosition
            );
            assert.equal(equalityHierarchy.length, 1,
                "overloaded equality should prepare the selected operator in Call Hierarchy");
            const equalityIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", equalityHierarchy[0]
            );
            assert.ok(equalityIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === equalityPosition.line
            ), "overloaded equality Call Hierarchy should retain its physical expression edge");
            const wordOperatorCall = "bridgeValue And bridgeValue";
            const wordOperatorPosition = position(operatorDocument, wordOperatorCall, "bridgeValue ".length + 1);
            const wordOperatorDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, wordOperatorPosition
            );
            assert.equal(wordOperatorDefinition.length, 1,
                "word operator navigation should follow the selected compiler receipt in the bridge");
            assert.match(operatorDocument.lineAt(wordOperatorDefinition[0].range.start.line).text,
                /^Operator And\(ByRef first As BridgeOperatorValue/i);
            const wordOperatorHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operatorUri, wordOperatorPosition
            );
            assert.equal(wordOperatorHierarchy.length, 1,
                "word operators should prepare the selected overload in Call Hierarchy");
            const wordOperatorIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", wordOperatorHierarchy[0]
            );
            assert.ok(wordOperatorIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === wordOperatorPosition.line
            ), "word operator Call Hierarchy should retain its physical expression edge");
            const compoundAssignmentLine = "compoundValue += 1";
            const compoundAssignmentPosition = position(operatorDocument, compoundAssignmentLine,
                "compoundValue ".length);
            const compoundAssignmentDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, compoundAssignmentPosition
            );
            assert.equal(compoundAssignmentDefinition.length, 1,
                "compound assignment should follow its compiler-selected operator receipt");
            assert.match(operatorDocument.lineAt(compoundAssignmentDefinition[0].range.start.line).text,
                /^Operator BridgeCompoundValue\.\+=/i);
            const compoundAssignmentReferences = await vscode.commands.executeCommand(
                "vscode.executeReferenceProvider", operatorUri, compoundAssignmentPosition,
                { includeDeclaration: true }
            );
            const compoundReferenceLines = compoundAssignmentReferences
                .filter((entry) => entry.uri.toString() === operatorUri.toString())
                .map((entry) => entry.range.start.line);
            assert.ok(compoundReferenceLines.includes(compoundAssignmentPosition.line),
                "compound assignment references should include the selected physical operation");
            assert.equal(compoundReferenceLines.includes(position(operatorDocument, "This.value += amount").line), false,
                "compound assignment references should exclude the built-in operator in the implementation body");
            const compoundAssignmentHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operatorUri, compoundAssignmentPosition
            );
            assert.equal(compoundAssignmentHierarchy.length, 1,
                "compound assignment should prepare its selected operator in Call Hierarchy");
            assert.match(compoundAssignmentHierarchy[0].detail, /BridgeCompoundValue\.\+=/i);
            const compoundAssignmentIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", compoundAssignmentHierarchy[0]
            );
            assert.ok(compoundAssignmentIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === compoundAssignmentPosition.line
            ), "compound assignment Call Hierarchy should retain its physical operation edge");
            const compoundAliasLine = "compoundValue +=> 2";
            const compoundAliasPosition = position(operatorDocument, compoundAliasLine,
                "compoundValue ".length + 1);
            const compoundAliasDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, compoundAliasPosition
            );
            assert.equal(compoundAliasDefinition.length, 1,
                "the documented +=> alias should follow the same compiler-selected operator");
            assert.match(operatorDocument.lineAt(compoundAliasDefinition[0].range.start.line).text,
                /^Operator BridgeCompoundValue\.\+=/i);
            const wordCompoundLine = "compoundModulo Mod= 2";
            const wordCompoundPosition = position(operatorDocument, wordCompoundLine,
                "compoundModulo ".length + 1);
            const wordCompoundDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, wordCompoundPosition
            );
            assert.equal(wordCompoundDefinition.length, 1,
                "word compound assignment should follow its compiler-selected operator receipt");
            assert.match(operatorDocument.lineAt(wordCompoundDefinition[0].range.start.line).text,
                /^Operator BridgeModuloValue\.Mod=/i);
            const wordCompoundHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operatorUri, wordCompoundPosition
            );
            assert.equal(wordCompoundHierarchy.length, 1,
                "word compound assignment should prepare its selected operator in Call Hierarchy");
            assert.match(wordCompoundHierarchy[0].detail, /BridgeModuloValue\.Mod=/i);
            const wordCompoundIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", wordCompoundHierarchy[0]
            );
            assert.ok(wordCompoundIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === wordCompoundPosition.line
            ), "word compound assignment should retain its physical operation edge");
            const wordCompoundAliasLine = "compoundModulo Mod=> 3";
            const wordCompoundAliasPosition = position(operatorDocument, wordCompoundAliasLine,
                "compoundModulo ".length + 1);
            const wordCompoundAliasDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, wordCompoundAliasPosition
            );
            assert.equal(wordCompoundAliasDefinition.length, 1,
                "the documented Mod=> alias should follow the same compiler-selected operator");
            assert.match(operatorDocument.lineAt(wordCompoundAliasDefinition[0].range.start.line).text,
                /^Operator BridgeModuloValue\.Mod=/i);
            const assignmentLine = "leftAssignable = rightAssignable";
            const assignmentPosition = position(operatorDocument, assignmentLine, "leftAssignable ".length);
            const assignmentDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, assignmentPosition
            );
            assert.equal(assignmentDefinition.length, 1,
                "overloaded assignment should follow its compiler-selected Operator Let receipt in the bridge");
            assert.match(operatorDocument.lineAt(assignmentDefinition[0].range.start.line).text,
                /^Operator BridgeAssignableValue\.Let\(/i);
            const fieldAssignmentLine = "assignmentHolder.value = rightAssignable";
            const fieldAssignmentPosition = position(operatorDocument, fieldAssignmentLine,
                "assignmentHolder.value ".length);
            const fieldAssignmentDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, fieldAssignmentPosition
            );
            assert.equal(fieldAssignmentDefinition.length, 1,
                "assignment to a UDT field should follow the field type's compiler-selected Operator Let");
            assert.match(operatorDocument.lineAt(fieldAssignmentDefinition[0].range.start.line).text,
                /^Operator BridgeAssignableValue\.Let\(/i);
            const assignmentReferences = await vscode.commands.executeCommand(
                "vscode.executeReferenceProvider", operatorUri, assignmentPosition, { includeDeclaration: true }
            );
            assert.ok(assignmentReferences.some((entry) => entry.uri.toString() === operatorUri.toString() &&
                entry.range.start.line === assignmentPosition.line),
            "Operator Let references should include the physical assignment site");
            const assignmentHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operatorUri, assignmentPosition
            );
            assert.equal(assignmentHierarchy.length, 1,
                "overloaded assignment should prepare Operator Let in Call Hierarchy");
            assert.match(assignmentHierarchy[0].detail, /BridgeAssignableValue\.Let/i);
            const assignmentIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", assignmentHierarchy[0]
            );
            assert.ok(assignmentIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === assignmentPosition.line
            ), "Operator Let Call Hierarchy should retain the physical assignment edge");
            const assignmentAliasLine = "leftAssignable => rightAssignable";
            const assignmentAliasPosition = position(operatorDocument, assignmentAliasLine,
                "leftAssignable ".length + 1);
            const assignmentAliasDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, assignmentAliasPosition
            );
            assert.equal(assignmentAliasDefinition.length, 1,
                "the documented => assignment alias should follow Operator Let");
            assert.match(operatorDocument.lineAt(assignmentAliasDefinition[0].range.start.line).text,
                /^Operator BridgeAssignableValue\.Let\(/i);
            const indexedAssignmentLine = "assignableValues(0) = rightAssignable";
            const indexedAssignmentPosition = position(operatorDocument, indexedAssignmentLine,
                "assignableValues(0) ".length);
            const indexedAssignmentDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, indexedAssignmentPosition
            );
            assert.equal(indexedAssignmentDefinition.length, 1,
                "indexed UDT assignment should follow its compiler-selected Operator Let receipt");
            assert.match(operatorDocument.lineAt(indexedAssignmentDefinition[0].range.start.line).text,
                /^Operator BridgeAssignableValue\.Let\(/i);
            const indexedAssignmentHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operatorUri, indexedAssignmentPosition
            );
            assert.equal(indexedAssignmentHierarchy.length, 1,
                "indexed UDT assignment should prepare Operator Let in Call Hierarchy");
            const indexedAssignmentIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", indexedAssignmentHierarchy[0]
            );
            assert.ok(indexedAssignmentIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === indexedAssignmentPosition.line
            ), "indexed Operator Let Call Hierarchy should retain its physical assignment edge");
            const letDeclarationPosition = position(operatorDocument,
                "Declare Operator Let(ByRef source As BridgeAssignableValue)", "Declare Operator ".length + 1);
            const letDeclarationHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", operatorUri, letDeclarationPosition
            );
            assert.equal(letDeclarationHierarchy.length, 1,
                "Call Hierarchy should prepare from an Operator Let declaration in the bridge");
            assert.match(letDeclarationHierarchy[0].detail, /Operator Let/i);
            const letDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", operatorUri, letDeclarationPosition
            );
            assert.equal(letDefinition.length, 1,
                "Go to Definition from an Operator Let prototype should find its implementation");
            assert.match(operatorDocument.lineAt(letDefinition[0].range.start.line).text,
                /^Operator BridgeAssignableValue\.Let\(/i);
            const letImplementation = await vscode.commands.executeCommand(
                "vscode.executeImplementationProvider", operatorUri, letDeclarationPosition
            );
            assert.equal(letImplementation.length, 1,
                "Go to Implementation from an Operator Let prototype should find its body");
            const letBodyPosition = position(operatorDocument,
                "Operator BridgeAssignableValue.Let(ByRef source As BridgeAssignableValue)",
                "Operator BridgeAssignableValue.".length + 1);
            const letPrototype = await vscode.commands.executeCommand(
                "vscode.executeDeclarationProvider", operatorUri, letBodyPosition
            );
            assert.equal(letPrototype.length, 1,
                "Go to Declaration from an Operator Let body should find its prototype");
            assert.match(operatorDocument.lineAt(letPrototype[0].range.start.line).text,
                /^\s*Declare Operator Let\(/i);
            const letDeclarationIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", letDeclarationHierarchy[0]
            );
            const letDeclarationModuleCaller = letDeclarationIncoming.find((call) => call.from.detail === "Module-level calls");
            assert.ok(letDeclarationModuleCaller, "the Operator Let declaration should retain module-level callers");
            const letDeclarationCallLines = letDeclarationModuleCaller.fromRanges.map((range) => range.start.line);
            assert.ok(letDeclarationCallLines.includes(assignmentPosition.line));
            assert.ok(letDeclarationCallLines.includes(indexedAssignmentPosition.line),
                "the declaration hierarchy should include indexed assignment sites");
            const letDeclarationReferences = await vscode.commands.executeCommand(
                "vscode.executeReferenceProvider", operatorUri, letDeclarationPosition, { includeDeclaration: true }
            );
            const letDeclarationReferenceLines = letDeclarationReferences
                .filter((entry) => entry.uri.toString() === operatorUri.toString())
                .map((entry) => entry.range.start.line);
            assert.ok(letDeclarationReferenceLines.includes(assignmentPosition.line));
            assert.ok(letDeclarationReferenceLines.includes(indexedAssignmentPosition.line),
                "Find References from an Operator Let declaration should include indexed assignments");
            const letDeclarationHighlights = await vscode.commands.executeCommand(
                "vscode.executeDocumentHighlights", operatorUri, letDeclarationPosition
            );
            const letDeclarationHighlightLines = letDeclarationHighlights.map((entry) => entry.range.start.line);
            assert.ok(letDeclarationHighlightLines.includes(assignmentPosition.line));
            assert.ok(letDeclarationHighlightLines.includes(indexedAssignmentPosition.line),
                "document highlights from an Operator Let declaration should include indexed assignments");
            for (const [call, callee, signature] of [
                ["CLng(bridgeCast)", "CLng", /^Operator BridgeCastValue\.Cast\(\) As Long/i],
                ["Abs(bridgeAbs)", "Abs", /^Operator Abs\(ByRef value As BridgeAbsValue\) As Long/i],
                ["Len(bridgeLength)", "Len", /^Operator Len\(ByRef value As BridgeLengthValue\) As Long/i]
            ]) {
                const operationPosition = position(operatorDocument, call, callee.length - 1);
                const definition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", operatorUri, operationPosition
                );
                assert.equal(definition.length, 1,
                    `${callee} should navigate through its compiler-selected operator receipt in the bridge`);
                assert.match(operatorDocument.lineAt(definition[0].range.start.line).text, signature);
                const references = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", operatorUri, operationPosition, { includeDeclaration: true }
                );
                assert.ok(references.some((entry) => entry.uri.toString() === operatorUri.toString() &&
                    entry.range.start.line === operationPosition.line),
                `${callee} references should include its physical source operation`);
                const hierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", operatorUri, operationPosition
                );
                assert.equal(hierarchy.length, 1,
                    `${callee} should prepare the selected operator in Call Hierarchy`);
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", hierarchy[0]);
                assert.ok(incoming.flatMap((entry) => entry.fromRanges).some((range) =>
                    range.start.line === operationPosition.line
                ), `${callee} Call Hierarchy should retain its physical source operation`);
            }
            const iteratorUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-iterator-hierarchy.bas"));
            const iteratorDocument = await vscode.workspace.openTextDocument(iteratorUri);
            await vscode.window.showTextDocument(iteratorDocument);
            await analyzeModule();
            const iteratorSites = [
                ["For iteratorValue = IteratorHierarchyValue(0) To IteratorHierarchyValue(2) Step IteratorHierarchyValue(1)", "For"],
                ["Step IteratorHierarchyValue(1)", "Step"],
                ["Next\n", "Next"]
            ];
            for (const [site, operatorName] of iteratorSites) {
                const operatorPosition = position(iteratorDocument, site, operatorName.length - 1);
                const definition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", iteratorUri, operatorPosition
                );
                assert.equal(definition.length, 1,
                    `${operatorName} should use its compiler-selected iterator operator in the bridge`);
                assert.match(iteratorDocument.lineAt(definition[0].range.start.line).text,
                    new RegExp(`^Operator IteratorHierarchyValue\\.${operatorName}\\(`, "i"));
                const hierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", iteratorUri, operatorPosition
                );
                assert.equal(hierarchy.length, 1,
                    `${operatorName} should prepare its selected iterator operator in Call Hierarchy`);
                assert.match(hierarchy[0].detail, new RegExp(`Operator IteratorHierarchyValue\\.${operatorName}`, "i"));
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", hierarchy[0]);
                assert.ok(incoming.flatMap((call) => call.fromRanges).some((range) =>
                    range.start.line === operatorPosition.line
                ), `${operatorName} should retain the physical iterator keyword edge`);
            }
        } finally {
            await configuration.update("analysis.compilerPath", previousAnalysisCompiler, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", previousProjectContexts, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", previousActiveContext, vscode.ConfigurationTarget.Global);
            await configuration.update("compiler.arguments", previousArguments, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        }
    });
    await check("semantic tokens and document symbols are provided", async () => {
        const tokens = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", uri);
        assert.ok(tokens?.data.length > 0);
        const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
        assert.ok(symbols.some((symbol) => symbol.name === "Work"));
    });
    await check("include links resolve the declared file", async () => {
        const links = await waitForDocumentLinks(uri);
        assert.ok(links.some((link) => link.target?.fsPath.endsWith("types.bi")));
    });
    await check("unsaved edits invalidate member information", async () => {
        const headerUri = vscode.Uri.file(path.join(__dirname, "workspace/types.bi"));
        const header = await vscode.workspace.openTextDocument(headerUri);
        const edit = new vscode.WorkspaceEdit();
        const declaration = position(header, "y As Long");
        edit.replace(headerUri, new vscode.Range(declaration, declaration.translate(0, 1)), "vertical");
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        const result = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, position(document, "origin.x", 7));
        const labels = result.items.map((item) => item.label);
        assert.ok(labels.includes("vertical"));
        assert.equal(labels.includes("y"), false);
        await vscode.window.showTextDocument(header);
        await vscode.commands.executeCommand("workbench.action.files.revert");
        await vscode.window.showTextDocument(document);
    });
    await check("comments do not receive symbol hover or rename", async () => {
        const commentPosition = position(document, "' end of main.bas", 5);
        const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, commentPosition);
        assert.equal(hovers.length, 0);
    });
    await check("unclosed brackets publish and clear live editor diagnostics", async () => {
        const source = "Dim roundValue = (1\nDim squareValue = [2\nDim curlyValue = {3";
        const bracketDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const sourceDiagnostics = () => vscode.languages.getDiagnostics(bracketDocument.uri)
            .filter((diagnostic) => diagnostic.source === "FreeBASIC brackets");

        assert.deepEqual(sourceDiagnostics().map((diagnostic) => diagnostic.code).sort(), [
            "unclosed-bracket",
            "unclosed-bracket",
            "unclosed-bracket"
        ]);
        assert.ok(sourceDiagnostics().every((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Warning));

        const replacement = "Dim roundValue = (1)\nDim squareValue = [2]\nDim curlyValue = {3}";
        const edit = new vscode.WorkspaceEdit();
        edit.replace(bracketDocument.uri, new vscode.Range(bracketDocument.positionAt(0), bracketDocument.positionAt(source.length)), replacement);
        await applyEditAndWaitForDocuments(edit, [bracketDocument]);
        assert.equal(sourceDiagnostics().length, 0);
    });
    await check("bracket diagnostics offer focused balancing fixes", async () => {
        const source = "Print ([1)";
        const bracketDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const sourceDiagnostics = () => vscode.languages.getDiagnostics(bracketDocument.uri)
            .filter((diagnostic) => diagnostic.source === "FreeBASIC brackets");
        const unclosed = sourceDiagnostics().find((diagnostic) => diagnostic.code === "unclosed-bracket");
        assert.ok(unclosed, "the opener should have an unclosed-bracket warning");
        const actions = await vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider", bracketDocument.uri, unclosed.range, vscode.CodeActionKind.QuickFix.value
        );
        const action = actions.find((candidate) => candidate.title.includes("Insert ']'"));
        assert.ok(action, "the warning should offer the matching closer before the mismatched ')' ");
        assert.equal(await vscode.workspace.applyEdit(action.edit), true);
        assert.equal(bracketDocument.getText(), "Print ([1])");
        assert.equal(sourceDiagnostics().length, 0, "applying the fix should clear the bracket warning");

        const unclosedSource = "Print (1";
        const unclosedDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: unclosedSource });
        const endOfFileDiagnostic = vscode.languages.getDiagnostics(unclosedDocument.uri)
            .find((diagnostic) => diagnostic.source === "FreeBASIC brackets" && diagnostic.code === "unclosed-bracket");
        assert.ok(endOfFileDiagnostic, "the final opener should have an unclosed-bracket warning");
        const endOfFileActions = await vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider", unclosedDocument.uri, endOfFileDiagnostic.range, vscode.CodeActionKind.QuickFix.value
        );
        const endOfFileAction = endOfFileActions.find((candidate) => candidate.title.includes("Insert ')'"));
        assert.ok(endOfFileAction, "the warning should offer an EOF balancing fix");
        assert.equal(await vscode.workspace.applyEdit(endOfFileAction.edit), true);
        assert.equal(unclosedDocument.getText(), "Print (1\n)");
        assert.equal(vscode.languages.getDiagnostics(unclosedDocument.uri)
            .some((diagnostic) => diagnostic.source === "FreeBASIC brackets"), false);

        const unexpectedSource = "Print 1)";
        const unexpectedDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: unexpectedSource });
        const unexpected = vscode.languages.getDiagnostics(unexpectedDocument.uri)
            .find((diagnostic) => diagnostic.source === "FreeBASIC brackets" && diagnostic.code === "unexpected-closing-bracket");
        assert.ok(unexpected, "the stray closer should have an unexpected-closing-bracket warning");
        const removeActions = await vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider", unexpectedDocument.uri, unexpected.range, vscode.CodeActionKind.QuickFix.value
        );
        const removeAction = removeActions.find((candidate) => candidate.title.includes("Remove unmatched ')'"));
        assert.ok(removeAction, "the warning should offer removal of its unmatched closer");
        assert.equal(await vscode.workspace.applyEdit(removeAction.edit), true);
        assert.equal(unexpectedDocument.getText(), "Print 1");
        assert.equal(vscode.languages.getDiagnostics(unexpectedDocument.uri)
            .some((diagnostic) => diagnostic.source === "FreeBASIC brackets"), false);
    });
    await check("bracket auto-closing is suppressed in comments and strings", async () => {
        const source = "' comment\nPrint \"text\"\nPrint ";
        const bracketDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const editor = await vscode.window.showTextDocument(bracketDocument);
        const configuration = vscode.workspace.getConfiguration("editor");
        const previous = configuration.get("autoClosingBrackets", "languageDefined");
        try {
            await configuration.update("autoClosingBrackets", "languageDefined", vscode.ConfigurationTarget.Global);
            const commentEnd = bracketDocument.positionAt(bracketDocument.getText().indexOf("\n"));
            editor.selection = new vscode.Selection(commentEnd, commentEnd);
            await vscode.commands.executeCommand("type", { text: "(" });
            assert.equal(bracketDocument.lineAt(0).text, "' comment(");

            const stringContent = bracketDocument.getText().indexOf("text") + 2;
            const stringPosition = bracketDocument.positionAt(stringContent);
            editor.selection = new vscode.Selection(stringPosition, stringPosition);
            await vscode.commands.executeCommand("type", { text: "[" });
            assert.equal(bracketDocument.lineAt(1).text, 'Print "te[xt"');

            const codeEnd = new vscode.Position(2, bracketDocument.lineAt(2).text.length);
            editor.selection = new vscode.Selection(codeEnd, codeEnd);
            await vscode.commands.executeCommand("type", { text: "{" });
            assert.equal(bracketDocument.lineAt(2).text, "Print {}");
        } finally {
            await configuration.update("autoClosingBrackets", previous, vscode.ConfigurationTarget.Global);
        }
    });
    await check("expand selection follows delimiters, statements, and procedure scopes", async () => {
        const source = "' selection test\n\nFunction Outer() As Long\n    Return Inner(1 + 2)\nEnd Function\n";
        const selectionDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const selections = await vscode.commands.executeCommand(
            "vscode.executeSelectionRangeProvider", selectionDocument.uri, [position(selectionDocument, "1 + 2")]
        );
        assert.equal(selections.length, 1);
        const selectedTexts = [];
        for (let current = selections[0]; current; current = current.parent) {
            selectedTexts.push(selectionDocument.getText(current.range));
        }
        assert.deepEqual(selectedTexts, [
            "1",
            "(1 + 2)",
            "Return Inner(1 + 2)",
            "    Return Inner(1 + 2)",
            "Function Outer() As Long\n    Return Inner(1 + 2)\nEnd Function",
            source
        ]);
        if (process.env.FBC_EDITOR_EXECUTABLE) {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-native-selection-"));
            const filePath = path.join(directory, "main.bas");
            const nativeSource = "Dim a As Long = 1\nDim b As Long = 2\nDim c As Long = 3\nPrint a + b * c\n";
            try {
                fs.writeFileSync(filePath, nativeSource);
                for (const [name, value] of [["analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE],
                    ["analysis.projectContexts", []], ["analysis.activeContext", null], ["analysis.run", "onDemand"],
                    ["compiler.arguments", []], ["diagnostics.run", "off"]]) {
                    await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                }
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                const nativeSelections = await vscode.commands.executeCommand("vscode.executeSelectionRangeProvider", current.uri,
                    [position(current, "a + b * c", 4), position(current, "a + b * c")]);
                assert.equal(nativeSelections.length, 2);
                const spans = nativeSelections.map((selection) => {
                    const texts = [];
                    for (let range = selection; range; range = range.parent) texts.push(current.getText(range.range));
                    return texts;
                });
                assert.ok(spans[0].includes("b * c"), "the compiler-owned multiplication must be selectable");
                assert.ok(spans.every((texts) => texts.includes("a + b * c")), "both carets must retain the native containing sum");
                assert.equal(current.isDirty, false);
                assert.equal(fs.readFileSync(filePath, "utf8"), nativeSource);
            } finally {
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }
    });
    await check("expand selection includes apostrophe and block comment groups", async () => {
        const source = "' first comment\n' second comment\n\n/' outer block\n    nested text\n'/\nPrint 1\n";
        const commentDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const selections = await vscode.commands.executeCommand(
            "vscode.executeSelectionRangeProvider", commentDocument.uri, [
                position(commentDocument, "first comment"),
                position(commentDocument, "nested text")
            ]
        );
        assert.equal(selections.length, 2);
        const textsFor = (selection) => {
            const texts = [];
            for (let current = selection; current; current = current.parent) {
                texts.push(commentDocument.getText(current.range));
            }
            return texts;
        };
        assert.ok(textsFor(selections[0]).includes("' first comment\n' second comment"));
        assert.ok(textsFor(selections[1]).includes("/' outer block\n    nested text\n'/"));
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("compiler-proven unreachable code is hinted without inlays and clears after edits", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic"), editorConfiguration = vscode.workspace.getConfiguration("editor");
        const settings = ["analysis.compilerPath", "compiler.path", "compiler.arguments", "analysis.run", "diagnostics.run", "analysis.projectContexts"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const previousInlays = editorConfiguration.get("inlayHints.enabled");
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-unreachable-code-"));
        const source = ["#if 0", "Print (", "#endif", "Sub FlowProbe()", "    Goto doneLabel", "    /' \u{1f600} '/ Print \"unreachable\"", "doneLabel:",
            "    Print \"reachable\"", "End Sub", "FlowProbe()", ""].join("\n");
        try {
            await editorConfiguration.update("inlayHints.enabled", "off", vscode.ConfigurationTarget.Global);
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"], ["analysis.projectContexts", []]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            for (const bridge of [false, true]) {
                const filePath = path.join(directory, bridge ? "bridge.bas" : "stock.bas");
                fs.writeFileSync(filePath, source);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                // Semantic highlighting requests the existing binding-capable
                // snapshot. The hint itself never starts another analysis.
                await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", current.uri);
                const diagnostics = () => vscode.languages.getDiagnostics(current.uri).filter((entry) => entry.code === "unreachable-code");
                const inactive = () => vscode.languages.getDiagnostics(current.uri).filter((entry) => entry.code === "inactive-code");
                const brackets = () => vscode.languages.getDiagnostics(current.uri).filter((entry) => entry.source === "FreeBASIC brackets");
                const deadline = Date.now() + DOCUMENT_CHANGE_TIMEOUT_MS;
                while ((!diagnostics().length || !inactive().length || brackets().length) && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                assert.equal(diagnostics().length, 1, `bridge=${bridge}: hint only the unreachable native token`);
                assert.equal(inactive().length, 1, "retain inactive-branch fading");
                assert.ok(inactive()[0].tags.includes(vscode.DiagnosticTag.Unnecessary));
                assert.equal(brackets().length, 0, "the inactive opener must remain excluded from bracket checks");
                const diagnostic = diagnostics()[0];
                assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Hint);
                assert.ok(diagnostic.tags.includes(vscode.DiagnosticTag.Unnecessary));
                assert.equal(diagnostic.range.start.line, 5);
                assert.equal(diagnostic.range.start.character, source.split("\n")[5].indexOf("Print"));
                assert.equal(current.getText(diagnostic.range), "Print");
                assert.match(diagnostic.message, /no reachable path/);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(current.uri, new vscode.Range(position(current, "Goto doneLabel"), position(current, "Goto doneLabel", "Goto doneLabel".length)), "Print 0");
                await applyEditAndWaitForDocuments(edit, [current]);
                assert.equal(diagnostics().length, 0, "an edit immediately clears cached reachability");
                assert.equal(fs.readFileSync(filePath, "utf8"), source, "the native hint must not save the edited buffer");
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await editorConfiguration.update("inlayHints.enabled", previousInlays, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("native folding uses external escape and REM options without source-only guesses", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "compiler.path", "compiler.arguments", "analysis.run", "diagnostics.run", "analysis.projectContexts", "analysis.activeContext"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-lexical-folds-"));
        const policyPath = path.join(directory, "options.bi");
        const source = ["Sub FoldProbe()", String.raw`Print "inside \" /' still quoted"`, "' first comment", "' second comment",
            "REM = 1 /' actual block", "' #region fake", "' fake content", "' #endregion", "'/", "Print 1", "End Sub", "FoldProbe()", ""].join("\r\n");
        try {
            fs.writeFileSync(policyPath, "Option Escape\nOption NoKeyword REM\nDim Shared REM As Long\n");
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", ["-lang", "deprecated", "-include", policyPath]],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"], ["analysis.projectContexts", []], ["analysis.activeContext", null]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            for (const bridge of [false, true]) {
                const filePath = path.join(directory, bridge ? "bridge.bas" : "stock.bas");
                fs.writeFileSync(filePath, source);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", current.uri);
                for (let repeat = 0; repeat < 2; repeat++) {
                    const ranges = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", current.uri);
                    assert.ok(ranges.some((fold) => fold.start === 0 && fold.end === 10), "keep the native procedure boundary");
                    assert.deepEqual(ranges.filter((fold) => fold.kind === vscode.FoldingRangeKind.Comment).map((fold) => [fold.start, fold.end]),
                        [[2, 3], [4, 8]], `bridge=${bridge}: strings and REM identifiers cannot invent comment folds`);
                    assert.equal(ranges.some((fold) => fold.kind === vscode.FoldingRangeKind.Region), false, "region text inside a real block comment is not a region");
                }
                assert.equal(current.getText(), source);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) await check("cached native block ranges ignore inactive terminators in folding and selection", async () => {
        const configuration = vscode.workspace.getConfiguration("freebasic");
        const settings = ["analysis.compilerPath", "compiler.path", "compiler.arguments", "analysis.run", "diagnostics.run", "analysis.projectContexts"];
        const previous = settings.map((name) => [name, configuration.get(name)]);
        const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-native-folds-"));
        const header = "Type IncludedBlock\nnumber As Long\nEnd Type\n";
        const source = ['#include once "blocks.bi"', '#include once "blocks.bi"', "Sub Kept()", "#if 0", "End Sub", "#endif",
            "' #region notes", "' first note", "' second note", "' #endregion", "If 1 Then", "Print 1", "End If", "End Sub ' \u{1f600}", "Kept()", ""].join("\n");
        try {
            for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                ["analysis.run", "onDemand"], ["diagnostics.run", "off"], ["analysis.projectContexts", []]]) {
                await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            }
            for (const bridge of [false, true]) {
                const backendDirectory = path.join(directory, bridge ? "bridge" : "stock");
                fs.mkdirSync(backendDirectory);
                const filePath = path.join(backendDirectory, "main.bas"), headerPath = path.join(backendDirectory, "blocks.bi");
                fs.writeFileSync(filePath, source);
                fs.writeFileSync(headerPath, header);
                await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri, position(current, "Sub Kept", 5));
                assert.ok(hovers.length, "hover supplies the cached analysis before folding");
                const ranges = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", current.uri);
                assert.ok(ranges.some((fold) => fold.start === 2 && fold.end === 13), `bridge=${bridge}: keep the real procedure body`);
                assert.equal(ranges.some((fold) => fold.start === 2 && fold.end === 4), false, "ignore the inactive END SUB");
                assert.ok(ranges.some((fold) => fold.start === 10 && fold.end === 12), "retain the native IF body");
                for (const [start, end, kind] of [[0, 1, vscode.FoldingRangeKind.Imports], [3, 5, vscode.FoldingRangeKind.Region],
                    [6, 9, vscode.FoldingRangeKind.Region], [7, 8, vscode.FoldingRangeKind.Comment]]) {
                    assert.ok(ranges.some((fold) => fold.start === start && fold.end === end && fold.kind === kind),
                        `retain source fold ${start}:${end}:${kind}`);
                }
                assert.equal(ranges.some((fold) => fold.start === 0 && fold.end === 2), false, "header block coordinates cannot leak into this file");
                const selections = await vscode.commands.executeCommand("vscode.executeSelectionRangeProvider", current.uri,
                    [position(current, "Sub Kept", 5), position(current, "Print 1", 6)]);
                assert.equal(selections.length, 2);
                for (const selection of selections) {
                    const selected = [];
                    for (let range = selection; range; range = range.parent) selected.push(current.getText(range.range));
                    assert.ok(selected.includes(source.split("\n").slice(2, 14).join("\n")), "select the full active procedure and its Unicode closing comment");
                    assert.equal(selected.includes(source.split("\n").slice(2, 5).join("\n")), false, "do not offer a procedure closed by inactive code");
                }
                assert.equal(current.getText(), source);
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
                assert.equal(fs.readFileSync(headerPath, "utf8"), header);
            }
        } finally {
            for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    await check("multiline block comments receive comment folding ranges", async () => {
        const source = "Print 1\n/' outer comment\n    /' nested comment '/\nouter comment ends '/ Print 2\n";
        const commentDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const ranges = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", commentDocument.uri);
        const commentRange = ranges.find((range) => range.start === 1 && range.end === 3);
        assert.ok(commentRange, "the outer multiline block comment should be foldable");
        assert.equal(commentRange.kind, vscode.FoldingRangeKind.Comment);
    });
    await check("region markers inside block comments do not create folds", async () => {
        const source = [
            "/' outer comment",
            "' #region fake",
            "' comment text",
            "' #endregion",
            "'/",
            "' #region real",
            "Print 1",
            "' #endregion"
        ].join("\n");
        const regionDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const ranges = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", regionDocument.uri);
        const regions = ranges.filter((range) => range.kind === vscode.FoldingRangeKind.Region);
        assert.deepEqual(regions.map((range) => [range.start, range.end]), [[5, 7]]);
    });
    await check("consecutive includes and USING directives receive import folding ranges", async () => {
        const source = '#include "first.bi"\n#include once "second.bi"\nUsing Graphics\nUsing Geometry, Physics\nPrint 1\n';
        const includeDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const ranges = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", includeDocument.uri);
        const imports = ranges.find((range) => range.start === 0 && range.end === 3);
        assert.ok(imports, "the consecutive include and USING block should be foldable");
        assert.equal(imports.kind, vscode.FoldingRangeKind.Imports);
    });
    await check("continued declarations receive folding ranges", async () => {
        const source = "Declare Function BuildThing( _\n    ByVal first As Long, _\n    ByVal second As Long _\n) As Long\nPrint 1\n";
        const continuationDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
        const ranges = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", continuationDocument.uri);
        assert.ok(ranges.some((range) => range.start === 0 && range.end === 3),
            "the continued declaration should be independently foldable");
    });
    await check("document and selection formatting preserve source text and line endings", async () => {
        const lines = ["Sub FormatCheck()", "If ready Then", 'Print  "keep  spacing"  \' keep comment',
            "Else", "Print 2", "End If", "End Sub", ""];
        const source = lines.join("\r\n");
        try {
            const formatted = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
            await vscode.window.showTextDocument(formatted);
            const edits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider",
                formatted.uri, { tabSize: 2, insertSpaces: true });
            assert.ok(edits.length > 0, "the installed document formatter must return indentation edits");
            const edit = new vscode.WorkspaceEdit();
            edit.set(formatted.uri, edits);
            await applyEditAndWaitForDocuments(edit, [formatted]);
            const expected = [...lines];
            for (const line of [1, 3, 5]) expected[line] = `  ${expected[line]}`;
            for (const line of [2, 4]) expected[line] = `    ${expected[line]}`;
            assert.equal(formatted.getText(), expected.join("\r\n"));
            assert.equal(formatted.eol, vscode.EndOfLine.CRLF);
            // VS Code may omit the command result when a provider has no edits.
            const repeatedEdits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider",
                formatted.uri, { tabSize: 2, insertSpaces: true });
            assert.ok(repeatedEdits == null || Array.isArray(repeatedEdits) && repeatedEdits.length === 0,
                `formatting must be idempotent: ${JSON.stringify(repeatedEdits)}`);

            const selected = await vscode.workspace.openTextDocument({ language: "freebasic", content: source });
            await vscode.window.showTextDocument(selected);
            const selectedEdits = await vscode.commands.executeCommand("vscode.executeFormatRangeProvider",
                selected.uri, new vscode.Range(2, 0, 4, 0), { tabSize: 4, insertSpaces: false });
            assert.deepEqual(selectedEdits.map((item) => item.range.start.line), [2, 3],
                "range formatting must use surrounding block context but exclude the final zero-column line");
            const selectedEdit = new vscode.WorkspaceEdit();
            selectedEdit.set(selected.uri, selectedEdits);
            await applyEditAndWaitForDocuments(selectedEdit, [selected]);
            const selectedExpected = [...lines];
            selectedExpected[2] = `\t\t${selectedExpected[2]}`;
            selectedExpected[3] = `\t${selectedExpected[3]}`;
            assert.equal(selected.getText(), selectedExpected.join("\r\n"));
            assert.equal(selected.eol, vscode.EndOfLine.CRLF);
            if (process.env.FBC_EXECUTABLE && process.env.FBC_EDITOR_EXECUTABLE) {
                const configuration = vscode.workspace.getConfiguration("freebasic");
                const settings = ["analysis.compilerPath", "compiler.path", "compiler.arguments", "analysis.run", "diagnostics.run", "analysis.projectContexts", "analysis.activeContext"];
                const previous = settings.map((name) => [name, configuration.get(name)]);
                const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-native-format-"));
                const nativeLines = ["Sub Kept()", "#if 0", "  End Sub", " If ignored Then ' \u{1f600}", "#endif", "If 1 Then", "Print 1", "End If", "End Sub", "Kept()", ""];
                const nativeSource = nativeLines.join("\r\n");
                const nativeExpected = [...nativeLines];
                for (const line of [1, 4, 5, 7]) nativeExpected[line] = `  ${nativeExpected[line]}`;
                nativeExpected[6] = `    ${nativeExpected[6]}`;
                try {
                    for (const [name, value] of [["compiler.path", process.env.FBC_EXECUTABLE], ["compiler.arguments", []],
                        ["analysis.run", "onDemand"], ["diagnostics.run", "off"], ["analysis.projectContexts", []], ["analysis.activeContext", null]]) {
                        await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                    }
                    for (const bridge of [false, true]) {
                        const filePath = path.join(directory, bridge ? "bridge.bas" : "stock.bas");
                        fs.writeFileSync(filePath, nativeSource);
                        await configuration.update("analysis.compilerPath", bridge ? process.env.FBC_EDITOR_EXECUTABLE : "", vscode.ConfigurationTarget.Global);
                        const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                        await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", current.uri);
                        const rangeEdits = await vscode.commands.executeCommand("vscode.executeFormatRangeProvider", current.uri,
                            new vscode.Range(6, 0, 7, 0), { tabSize: 2, insertSpaces: true });
                        assert.deepEqual(rangeEdits.map((edit) => [edit.range.start.line, edit.newText]), [[6, "    "]],
                            "selection formatting must use the active enclosing blocks");
                        const nativeEdits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", current.uri,
                            { tabSize: 2, insertSpaces: true });
                        assert.equal(nativeEdits.some((edit) => [2, 3].includes(edit.range.start.line)), false, "inactive source bytes remain untouched");
                        const apply = new vscode.WorkspaceEdit();
                        apply.set(current.uri, nativeEdits);
                        await applyEditAndWaitForDocuments(apply, [current]);
                        assert.equal(current.getText(), nativeExpected.join("\r\n"), `bridge=${bridge}: inactive block keywords must not affect indentation`);
                        const repeat = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", current.uri, { tabSize: 2, insertSpaces: true });
                        assert.ok(repeat == null || repeat.length === 0, "a repeat without native facts must not undo the formatted result");
                        assert.equal(fs.readFileSync(filePath, "utf8"), nativeSource);
                        for (const rem of [false, true]) {
                            const optionPath = path.join(directory, rem ? "rem-options.bi" : "escape-options.bi");
                            fs.writeFileSync(optionPath, rem ? "Option NoKeyword REM\nDim Shared REM As Long\n" : "Option Escape\n");
                            await configuration.update("compiler.arguments", ["-lang", rem ? "deprecated" : "fblite", "-include", optionPath], vscode.ConfigurationTarget.Global);
                            const lexicalLines = rem
                                ? ["Sub RemProbe()", "If 1 Then", "REM = 1 : End If", "Print 2", "End Sub", "RemProbe()", ""]
                                : ["Sub EscapeProbe()", String.raw`Print "inside \" /' still quoted"`, "' keep comment", "If 1 Then", "Print 1", "End If", "End Sub", "EscapeProbe()", ""];
                            const lexicalSource = lexicalLines.join("\r\n"), expected = [...lexicalLines];
                            for (const line of rem ? [1, 3] : [1, 2, 3, 5]) expected[line] = "  " + expected[line];
                            if (!rem) expected[4] = "    " + expected[4];
                            const lexicalPath = path.join(directory, `${bridge ? "bridge" : "stock"}-${rem ? "rem" : "escape"}.bas`);
                            fs.writeFileSync(lexicalPath, lexicalSource);
                            const lexicalDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(lexicalPath));
                            await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", lexicalDocument.uri);
                            const lexicalEdits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", lexicalDocument.uri, { tabSize: 2, insertSpaces: true });
                            const applyLexical = new vscode.WorkspaceEdit();
                            applyLexical.set(lexicalDocument.uri, lexicalEdits);
                            await applyEditAndWaitForDocuments(applyLexical, [lexicalDocument]);
                            assert.equal(lexicalDocument.getText(), expected.join("\r\n"), `bridge=${bridge}, rem=${rem}: external lexical options must reach formatting`);
                            const repeated = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", lexicalDocument.uri, { tabSize: 2, insertSpaces: true });
                            assert.ok(repeated == null || repeated.length === 0);
                            assert.equal(fs.readFileSync(lexicalPath, "utf8"), lexicalSource);
                        }
                        await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                    }
                } finally {
                    for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                    fs.rmSync(directory, { recursive: true, force: true });
                }
            }
        } finally {
            await vscode.window.showTextDocument(document);
        }
    });

    if (process.env.FBC_EDITOR_EXECUTABLE) {
        await check("native call hierarchy distinguishes unevaluated queries from runtime calls", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.path", "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-unevaluated-hierarchy-"));
            const implicitPath = path.join(directory, "implicit.bas"), namedPath = path.join(directory, "named.bas");
            let current;
            try {
                const implicit = ["Type QueryBox", "    value As Long", "    Declare Constructor()",
                    "    Declare Operator Cast() As Long", "    Declare Operator [](ByVal index As Long) As Long", "End Type",
                    "Sub QueryOnly()", "    Dim converted As TypeOf(CLng(Type<QueryBox>()))", "    Dim instance As QueryBox = Any",
                    "    Dim indexed As TypeOf(instance[0])", "End Sub", "Sub RuntimeCalls()", "    Dim instance As QueryBox",
                    "    Print CLng(instance)", "    Print instance[0]", "End Sub", ""].join("\n");
                fs.writeFileSync(implicitPath, implicit);
                current = await vscode.workspace.openTextDocument(vscode.Uri.file(implicitPath));
                await vscode.window.showTextDocument(current);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                const hierarchy = async (spelling, prefix) => {
                    const items = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                        position(current, spelling, prefix.length));
                    assert.equal(items?.length, 1, spelling);
                    return items[0];
                };
                const lines = (calls) => calls?.flatMap((call) => call.fromRanges.map((range) => range.start.line)).sort((a, b) => a - b);
                for (const compilerPath of ["", process.env.FBC_EDITOR_EXECUTABLE]) {
                    await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                    const queryOnly = await hierarchy("Sub QueryOnly", "Sub ");
                    assert.deepEqual(await vscode.commands.executeCommand("vscode.provideOutgoingCalls", queryOnly), []);
                    const runtime = await hierarchy("Sub RuntimeCalls", "Sub ");
                    assert.deepEqual(lines(await vscode.commands.executeCommand("vscode.provideOutgoingCalls", runtime)), [12, 13, 14]);
                    const constructor = await hierarchy("Declare Constructor", "Declare ");
                    assert.deepEqual(lines(await vscode.commands.executeCommand("vscode.provideIncomingCalls", constructor)), [12]);
                }
                const named = ["Declare Function Factory() As Long", "Declare Function TextFactory() As String",
                    "#define FactoryType(name) TypeOf(name())", "Sub Caller()", "    Dim first As TypeOf(Factory())",
                    "    Print SizeOf(Factory())", "    Dim nested As TypeOf(CLng(SizeOf(Factory())))",
                    "    Dim expanded As FactoryType(Factory)", "    Print Factory()", "    Print Len(TextFactory())",
                    "#define DualUse(name) Dim mixed As TypeOf(name()) : Print name()", "    DualUse(Factory)", "End Sub",
                    "#if SizeOf(Integer) > 0", "#assert TypeOf(CLng(1)) = TypeOf(Long)", "#endif", ""].join("\n");
                fs.writeFileSync(namedPath, named);
                current = await vscode.workspace.openTextDocument(vscode.Uri.file(namedPath));
                await vscode.window.showTextDocument(current);
                const changes = new vscode.WorkspaceEdit();
                changes.insert(current.uri, current.positionAt(named.length), "' unsaved native snapshot\n");
                await applyEditAndWaitForDocuments(changes, [current]);
                assert.equal(current.isDirty, true);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const caller = await hierarchy("Sub Caller", "Sub ");
                assert.deepEqual(lines(await vscode.commands.executeCommand("vscode.provideOutgoingCalls", caller)), [8, 9, 11]);
                const factory = await hierarchy("Function Factory", "Function ");
                assert.deepEqual(lines(await vscode.commands.executeCommand("vscode.provideIncomingCalls", factory)), [8, 11]);
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", current.uri,
                    position(current, "Function Factory", "Function ".length));
                assert.deepEqual([...new Set(references.map((entry) => entry.range.start.line))].sort((a, b) => a - b), [0, 4, 5, 6, 7, 8, 11]);
                assert.equal(fs.readFileSync(namedPath, "utf8"), named, "analysis must not save the overlay");
            } finally {
                if (current?.isDirty) {
                    await vscode.window.showTextDocument(current);
                    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
                }
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("native call hierarchy retains macro calls across configured modules", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.path", "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-macro-call-hierarchy-"));
            const sourcePath = path.join(directory, "caller.bas"), otherPath = path.join(directory, "other.bas");
            let current;
            try {
                const header = "Declare Function Work Overload(ByVal value As Long) As Long\n" +
                    "Declare Function Work Overload(ByVal value As Double) As Long\nDeclare Function Other(ByVal value As Long) As Long\n";
                const source = ['#include "api.bi"', "#define Invoke(name, value) name(value)",
                    "#define Relay(name, value) Invoke(name, value)", "#define FixedCall() Work(CLng(1))",
                    "#define Pair(first, second) first(CLng(1)) + second(CLng(2))", "Sub Caller()",
                    '    Print "é😀" : Print Invoke(Work, CLng(1))', "    Print Relay(Work, CDbl(1))", "    Print FixedCall()",
                    "    Print Pair(Work, Other)", "    Dim query As TypeOf(Invoke(Work, CLng(2)))", "#if 0",
                    "    Print Invoke(Work, CLng(3))", "#endif", "    Print Work(CLng(9))", "End Sub", ""].join("\n");
                fs.writeFileSync(path.join(directory, "api.bi"), header);
                fs.writeFileSync(sourcePath, source);
                fs.writeFileSync(otherPath, '#include "api.bi"\n#define Remote(name) name(CLng(1))\nPrint Remote(Work)\n' +
                    "#define Glue(prefix, suffix) prefix##suffix(CLng(1))\nPrint Glue(Wo, rk)\n");
                current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(current);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{ name: "macro-calls", modules: [sourcePath, otherPath] }],
                    vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", { name: "macro-calls", module: sourcePath }, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                const prepare = async (spelling, prefix) => {
                    const items = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri,
                        position(current, spelling, prefix.length));
                    assert.equal(items?.length, 1, spelling);
                    return items[0];
                };
                const outgoing = async () => {
                    const calls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", await prepare("Sub Caller", "Sub "));
                    return calls?.map((call) => [call.to.selectionRange.start.line, call.fromRanges.map((range) => range.start.line)])
                        .sort((first, second) => first[0] - second[0]);
                };
                const incoming = async () => {
                    const calls = await vscode.commands.executeCommand("vscode.provideIncomingCalls", await prepare("Print Work(CLng(9))", "Print "));
                    return calls?.map((call) => [path.basename(call.from.uri.fsPath), call.fromRanges.map((range) => range.start.line)]);
                };
                for (const compilerPath of ["", process.env.FBC_EDITOR_EXECUTABLE]) {
                    await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                    assert.deepEqual(await incoming(), [["caller.bas", [6, 8, 9, 14]], ["other.bas", [2, 4]]]);
                    assert.deepEqual(await outgoing(), [[0, [6, 8, 9, 14]], [1, [7]], [2, [9]]]);
                    assert.equal(vscode.workspace.textDocuments.some((entry) => entry.uri.fsPath === otherPath), false,
                        "closed macro callers must not need their editors opened");
                    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, sourcePath);
                }
                const changed = source.replace("#define FixedCall() Work(CLng(1))", "#define FixedCall() Work(CDbl(1))");
                const edit = new vscode.WorkspaceEdit();
                edit.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(source.length)), changed);
                await applyEditAndWaitForDocuments(edit, [current]);
                assert.equal(current.isDirty, true);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                assert.deepEqual(await incoming(), [["caller.bas", [6, 9, 14]], ["other.bas", [2, 4]]]);
                assert.deepEqual(await outgoing(), [[0, [6, 9, 14]], [1, [7, 8]], [2, [9]]]);
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            } finally {
                if (current?.isDirty) {
                    await vscode.window.showTextDocument(current);
                    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
                }
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("native call hierarchy follows compiler-selected procedure bindings", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const previousArguments = configuration.get("compiler.arguments", []);
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-call-hierarchy.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true,
                    "the call hierarchy assertions require the current compiler binding snapshot");
                const leaf = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Function LeafValue", "Function ".length + 2)
                );
                assert.equal(leaf.length, 1);
                assert.equal(leaf[0].name, "LeafValue");
                const leafCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", leaf[0]);
                assert.deepEqual(leafCallers.map((call) => call.from.name).sort(), ["MacroCallerValue", "MiddleValue", "RootValue"]);
                const macroCallerEdge = leafCallers.find((call) => call.from.name === "MacroCallerValue");
                assert.equal(document.getText(macroCallerEdge.fromRanges[0]), "InvokeValue(LeafValue, value)",
                    "the complete project graph reports the physical macro invocation, not an editable callee spelling");

                const root = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Function RootValue", "Function ".length + 2)
                );
                assert.equal(root.length, 1);
                assert.equal(root[0].name, "RootValue");
                const rootCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", root[0]);
                assert.deepEqual(rootCalls.map((call) => call.to.name).sort(), ["LeafValue", "MiddleValue"],
                    JSON.stringify(rootCalls.map((call) => ({ name: call.to.name, ranges: call.fromRanges.map((range) => [range.start.line, range.start.character]) }))));

                // Retained tree items must reacquire native facts after the
                // selected compiler context retires their original snapshot.
                await configuration.update("compiler.arguments", [...previousArguments, "-d", "__FB_VSCODE_HIERARCHY_REFRESH__=1"],
                    vscode.ConfigurationTarget.Global);
                const refreshedRootCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", root[0]);
                assert.deepEqual(refreshedRootCalls.map((call) => call.to.name).sort(), ["LeafValue", "MiddleValue"]);
                const refreshedLeafCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", leaf[0]);
                assert.deepEqual(refreshedLeafCallers.map((call) => call.from.name).sort(), ["MacroCallerValue", "MiddleValue", "RootValue"]);
                assert.equal(document.getText(refreshedLeafCallers.find((call) => call.from.name === "MacroCallerValue").fromRanges[0]),
                    "InvokeValue(LeafValue, value)");

                const rootCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", root[0]);
                const moduleCaller = rootCallers.find((call) => call.from.detail === "Module-level calls");
                assert.ok(moduleCaller, "the module-level RootValue call should appear as an incoming caller");
                const moduleCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", moduleCaller.from);
                assert.deepEqual(moduleCalls.map((call) => call.to.name), ["RootValue"]);

                const macroCaller = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Function MacroCallerValue", "Function ".length + 2)
                );
                assert.equal(macroCaller.length, 1);
                const macroCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", macroCaller[0]);
                assert.deepEqual(macroCalls.map((call) => call.to.name), ["LeafValue"],
                    "a compiler-mapped macro argument should retain its selected callee");

                const bareTarget = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Sub BareTarget", "Sub ".length + 2)
                );
                const bareTargetCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", bareTarget[0]);
                assert.deepEqual(bareTargetCallers.map((call) => call.from.name), ["BareCaller"]);
                const bareCaller = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Sub BareCaller", "Sub ".length + 2)
                );
                const bareCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", bareCaller[0]);
                assert.deepEqual(bareCalls.map((call) => call.to.name), ["BareTarget"]);

                const bareFunctionTarget = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Function BareFunctionTarget", "Function ".length + 2)
                );
                const bareFunctionCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", bareFunctionTarget[0]);
                assert.deepEqual(bareFunctionCallers.map((call) => call.from.name), ["BareFunctionCaller"]);
                const bareFunctionCaller = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Function BareFunctionCaller", "Function ".length + 2)
                );
                const bareFunctionCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", bareFunctionCaller[0]);
                assert.deepEqual(bareFunctionCalls.map((call) => call.to.name), ["BareFunctionTarget"]);

                const bareProperty = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Property BarePropertyOwner.BareValue", "Property BarePropertyOwner.".length + 2)
                );
                const barePropertyCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", bareProperty[0]);
                assert.deepEqual(barePropertyCallers.map((call) => call.from.name), ["BarePropertyCaller"]);
                const barePropertyCaller = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Function BarePropertyCaller", "Function ".length + 2)
                );
                const barePropertyCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", barePropertyCaller[0]);
                assert.deepEqual(barePropertyCalls.map((call) => call.to.name), ["BareValue"]);
            } finally {
                await configuration.update("compiler.arguments", previousArguments, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("native signature help follows compiler-owned square-bracket operators", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-expression-operations.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const signaturePosition = document.positionAt(document.getText().indexOf("indexedInstance[0]") + "indexedInstance[".length);
                const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri, signaturePosition);
                assert.equal(signature?.signatures.length, 3);
                assert.match(signature.signatures[signature.activeSignature].label,
                    /Operator\s+IndexedValue\.\[\]\(ByVal index As Long\) As Double/i);
                assert.equal(signature.activeParameter, 0);
                const indexPosition = document.positionAt(document.getText().indexOf("indexedInstance[0]") + "indexedInstance[".length);
                const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, indexPosition);
                assert.equal(definitions.length, 1);
                assert.match(document.lineAt(definitions[0].range.start.line).text,
                    /Operator\s+IndexedValue\.\[\]\(ByVal index As Long\)/i,
                    "compiler-owned index expressions should navigate to the selected Operator [] implementation");
                const declarations = await vscode.commands.executeCommand("vscode.executeDeclarationProvider", uri, indexPosition);
                assert.equal(declarations.length, 1);
                assert.match(document.lineAt(declarations[0].range.start.line).text,
                    /Declare\s+Operator\s+\[\]\(ByVal index As Long\)/i,
                    "compiler-owned index expressions should navigate to the selected Operator [] declaration");
                const implementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", uri, indexPosition);
                assert.equal(implementations.length, 1);
                assert.match(document.lineAt(implementations[0].range.start.line).text,
                    /Operator\s+IndexedValue\.\[\]\(ByVal index As Long\)/i,
                    "compiler-owned index expressions should navigate to the selected Operator [] implementation");
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, indexPosition);
                assert.ok(references.some((entry) => document.getText(entry.range) === "indexedInstance[0]"));
                assert.equal(references.some((entry) => document.getText(entry.range) === "indexedInstance[0.5]"), false,
                    "references should retain the compiler-selected Long index overload");
                const indexHierarchy = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", uri, indexPosition);
                assert.equal(indexHierarchy.length, 1);
                assert.match(indexHierarchy[0].detail, /Operator\s+IndexedValue\.\[\]\(ByVal index As Long\)/i);
                const indexCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", indexHierarchy[0]);
                const moduleIndexerCalls = indexCallers.find((caller) => caller.from.detail === "Module-level calls");
                assert.ok(moduleIndexerCalls, "operator Call Hierarchy should include module-level index expressions");
                assert.ok(moduleIndexerCalls.fromRanges.some((range) => document.getText(range) === "indexedInstance[0]"));
                assert.equal(moduleIndexerCalls.fromRanges.some((range) => document.getText(range) === "indexedInstance[0.5]"), false,
                    "operator Call Hierarchy should retain the selected overload");
                const longOperatorPosition = position(document,
                    "Operator IndexedValue.[](ByVal index As Long) As Double", "Operator IndexedValue.".length);
                const operatorReferences = await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, longOperatorPosition);
                assert.ok(operatorReferences.some((entry) => document.getText(entry.range) === "indexedInstance[0]"));
                assert.equal(operatorReferences.some((entry) => document.getText(entry.range) === "indexedInstance[0.5]"), false,
                    "references from the operator declaration should use its compiler-selected overload");

                const doublePosition = document.positionAt(document.getText().indexOf("indexedInstance[0.5]") + "indexedInstance[".length);
                const doubleSignature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri, doublePosition);
                assert.match(doubleSignature.signatures[doubleSignature.activeSignature].label,
                    /Operator\s+IndexedValue\.\[\]\(ByVal index As Double\) As Double/i);
                const doubleDefinition = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, doublePosition);
                assert.equal(doubleDefinition.length, 1);
                assert.match(document.lineAt(doubleDefinition[0].range.start.line).text,
                    /Operator\s+IndexedValue\.\[\]\(ByVal index As Double\)/i);
                const doubleReferences = await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, doublePosition);
                assert.ok(doubleReferences.some((entry) => document.getText(entry.range) === "indexedInstance[0.5]"));
                assert.equal(doubleReferences.some((entry) => document.getText(entry.range) === "indexedInstance[0]"), false,
                    "references should retain the compiler-selected Double index overload");

                const resultPosition = document.positionAt(document.getText().indexOf('indexedInstance["slot"]') + "indexedInstance[".length);
                const resultType = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", uri, resultPosition);
                assert.ok(resultType.some((entry) => document.lineAt(entry.range.start.line).text === "Type IndexedResult"),
                    "type definition on an index expression should follow the compiler-selected result type");
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("native label completion includes compiler-selected QB numeric labels", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const previousContexts = configuration.get("analysis.projectContexts", []);
            const previousActiveContext = configuration.get("analysis.activeContext", null);
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-labels.bas"));
            const labelDocument = await vscode.workspace.openTextDocument(uri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{
                    name: "numeric-label-completion",
                    modules: ["compiler-labels.bas"],
                    arguments: ["-lang", "qb"]
                }], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", {
                    name: "numeric-label-completion",
                    module: "compiler-labels.bas"
                }, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(labelDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                for (const [statement, prefix, expected] of [
                    ["Goto &H10", "Goto &H", "&H10"],
                    ["On 1 Goto &H10, &H20", "On 1 Goto &H10, &H", "&H20"],
                    ["On 2 Gosub &H10, &H20", "On 2 Gosub &H10, &H", "&H20"]
                ]) {
                    const completionPosition = position(labelDocument, statement, prefix.length);
                    const completions = await vscode.commands.executeCommand(
                        "vscode.executeCompletionItemProvider", uri, completionPosition
                    );
                    assert.ok(completions.items.some((item) => item.label === expected),
                        "the active QB context should offer its numeric compiler label: " + statement);
                    assert.ok(completions.items.every((item) => item.kind === vscode.CompletionItemKind.Reference),
                        "label context should not mix in unrelated keyword or symbol completions");
                }
            } finally {
                await configuration.update("analysis.activeContext", previousActiveContext, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", previousContexts, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("guarded type completion follows compiler configuration without text edits", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.path", "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-guarded-type-completion-"));
            const sourcePath = path.join(directory, "main.bas");
            const source = fs.readFileSync(path.join(__dirname, "../fixtures/guarded-type-completions.bas"), "utf8");
            let current;
            try {
                fs.writeFileSync(sourcePath, source);
                current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(current);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                for (const compilerPath of ["", process.env.FBC_EDITOR_EXECUTABLE]) {
                    await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                    if (compilerPath) {
                        const edit = new vscode.WorkspaceEdit();
                        edit.insert(current.uri, current.positionAt(current.getText().length), "' bridge overlay\n");
                        await applyEditAndWaitForDocuments(edit, [current]);
                    }
                    const version = current.version;
                    for (const first of [false, true, false]) {
                        await configuration.update("compiler.arguments", first ? ["-d", "FIRST_TYPE"] : [], vscode.ConfigurationTarget.Global);
                        const selected = position(current, "Dim selected As REM", "Dim selected As RE".length);
                        const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri, selected);
                        assert.ok(completions.items.some((item) => item.label === "REM" && item.kind === vscode.CompletionItemKind.Struct),
                            `${compilerPath ? "bridge" : "stock"}, FIRST_TYPE=${first}`);
                        const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", current.uri, selected);
                        const offset = first ? source.indexOf("Type REM") : source.lastIndexOf("Type REM");
                        const line = source.slice(0, offset).split("\n").length - 1;
                        assert.ok(definitions.some((item) => item.uri.fsPath === sourcePath && item.range.start.line === line),
                            "completion and navigation must follow the active native declaration");
                        assert.equal(current.version, version, "a compiler context change must not edit source");
                    }
                }
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            } finally {
                if (current?.isDirty) {
                    await vscode.window.showTextDocument(current);
                    await vscode.commands.executeCommand("workbench.action.files.revert");
                }
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("native keyword type completion retains binding-backed candidates", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.path", "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-keyword-type-completion-"));
            const sourcePath = path.join(directory, "main.bas");
            const source = fs.readFileSync(path.join(__dirname, "../fixtures/stock-type-completions.bas"), "utf8");
            let current;
            try {
                fs.writeFileSync(sourcePath, source);
                current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(current);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                for (const compilerPath of ["", process.env.FBC_EDITOR_EXECUTABLE]) {
                    await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                    if (compilerPath) {
                        const edit = new vscode.WorkspaceEdit();
                        edit.insert(current.uri, current.positionAt(current.getText().length), "' bridge overlay\n");
                        await applyEditAndWaitForDocuments(edit, [current]);
                    }
                    for (const [spelling, prefix, name, kind] of [
                        ["Dim directValue As REM", "Dim directValue As RE", "REM", vscode.CompletionItemKind.Struct],
                        ["Dim aliasValue As IF", "Dim aliasValue As IF", "IF", vscode.CompletionItemKind.Struct],
                        ["Dim enumValue As WHILE", "Dim enumValue As WH", "WHILE", vscode.CompletionItemKind.Enum],
                        ["Dim qualifiedValue As PRINT.Payload", "Dim qualifiedValue As PR", "PRINT", vscode.CompletionItemKind.Module],
                        ["Dim qualifiedValue As PRINT.Payload", "Dim qualifiedValue As PRINT.", "Payload", vscode.CompletionItemKind.Struct],
                        ["Dim qualifiedValue As PRINT.Payload", "Dim qualifiedValue As PRINT.Pay", "Payload", vscode.CompletionItemKind.Struct]
                    ]) {
                        const result = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                            position(current, spelling, prefix.length));
                        const item = result.items.find((candidate) => candidate.label === name && candidate.kind === kind);
                        assert.ok(item, `${prefix} (${compilerPath ? "bridge" : "stock"})`);
                        const insertion = typeof item.insertText === "string" ? item.insertText : item.insertText?.value;
                        assert.equal(insertion, name, "type slots must remain name-only");
                        assert.ok(!result.items.some((candidate) => candidate.label === "directValue" &&
                            candidate.kind === vscode.CompletionItemKind.Variable), "type slots must not mix in values");
                    }
                }
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            } finally {
                if (current?.isDirty) {
                    await vscode.window.showTextDocument(current);
                    await vscode.commands.executeCommand("workbench.action.files.revert");
                }
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("type-position completion filters native and source candidates", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.path", "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-type-completion-"));
            const sourcePath = path.join(directory, "main.bas");
            const source = fs.readFileSync(path.join(__dirname, "../fixtures/type-completions.bas"), "utf8");
            let current;
            try {
                fs.writeFileSync(sourcePath, source);
                current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(current);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                for (const compilerPath of ["", process.env.FBC_EDITOR_EXECUTABLE]) {
                    await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                    if (compilerPath) {
                        const edit = new vscode.WorkspaceEdit();
                        edit.insert(current.uri, current.positionAt(current.getText().length), "' bridge overlay\n");
                        await applyEditAndWaitForDocuments(edit, [current]);
                    }
                    for (const [spelling, prefix, expected] of [
                        ["Dim selected As SampleType", "Dim selected As Samp", "SampleType"],
                        ["Dim qualified As TypeSpace.SampleAlias", "Dim qualified As TypeSpace.Sam", "SampleAlias"],
                        ["Dim continued As _\n    SampleAlias", "Dim continued As _\n    Samp", "SampleAlias"],
                        ["Declare Sub AcceptType(ByVal value As SampleType)", "Declare Sub AcceptType(ByVal value As Samp", "SampleType"],
                        ["Declare Function SupplyType() As SampleAlias", "Declare Function SupplyType() As Samp", "SampleAlias"],
                        ["Type GlobalAlias As SampleType", "Type GlobalAlias As Samp", "SampleType"],
                        ["Type DerivedType Extends Object", "Type DerivedType Extends Ob", "OBJECT"],
                        ["Dim macroValue As TypeMacro(SampleType)", "Dim macroValue As TypeMa", "TypeMacro"]
                    ]) {
                        const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                            position(current, spelling, prefix.length));
                        const items = completions.items.filter((item) => item.kind !== vscode.CompletionItemKind.Text);
                        const item = items.find((candidate) => String(candidate.label).toLowerCase() === expected.toLowerCase());
                        assert.ok(item, `${spelling} (${compilerPath ? "bridge" : "stock/source"})`);
                        const insertion = typeof item.insertText === "string" ? item.insertText : item.insertText?.value;
                        assert.equal(insertion.toLowerCase(), expected.toLowerCase(), "type names must not insert constructor arguments");
                        assert.ok(items.every((candidate) => !["ordinaryValue", "BuildValue", "unrelatedVariable", "unrelatedFactory", "SIN", "TRUE", "PRINT"]
                            .some((name) => name.toLowerCase() === String(candidate.label).toLowerCase())), spelling);
                    }
                    for (const [spelling, prefix, expected] of [["Typeof(ordinaryValue)", "Typeof(ordinaryVa", "ordinaryValue"],
                        ["String * lengthValue", "String * lengthVa", "lengthValue"],
                        ["Long = BuildValue(1)", "Long = BuildVa", "BuildValue"],
                        ["As Function Cdecl", "As Function Cd", "CDECL"]]) {
                        const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                            position(current, spelling, prefix.length));
                        assert.ok(completions.items.some((item) => item.label === expected && item.kind !== vscode.CompletionItemKind.Text),
                            `type filtering must leave expression completion intact (${compilerPath ? "bridge" : "stock/source"}): ` + spelling);
                    }
                }
                const edit = new vscode.WorkspaceEdit();
                edit.insert(current.uri, current.positionAt(current.getText().length), "\nDim unfinished As TypeSpace.Samp");
                await applyEditAndWaitForDocuments(edit, [current]);
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                    current.positionAt(current.getText().length));
                assert.ok(completions.items.some((item) => item.label === "SampleType" && item.kind === vscode.CompletionItemKind.Struct),
                    "native namespace completion must survive an unfinished type name");
                assert.ok(!completions.items.some((item) => item.label === "unrelatedFactory" && item.kind === vscode.CompletionItemKind.Function));
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            } finally {
                if (current?.isDirty) {
                    await vscode.window.showTextDocument(current);
                    await vscode.commands.executeCommand("workbench.action.files.revert");
                }
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("native procedure pointer Signature Help uses callable types", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.path", "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-callback-signatures-"));
            const sourcePath = path.join(directory, "main.bas");
            const source = [
                "Declare Function CachedChoice Overload(ByVal amount As Long, ByVal scale As Double) As Double",
                "Declare Function CachedChoice Overload(ByVal amount As Double, ByVal scale As Double) As Double",
                fs.readFileSync(path.join(__dirname, "../fixtures/procedure-pointer-signatures.bas"), "utf8"),
                fs.readFileSync(path.join(__dirname, "../fixtures/array-index-signatures.bas"), "utf8"),
                "Print CachedChoice(CLng(1), 2)", "Print CachedChoice(CDbl(1), 2)", ""
            ].join("\n");
            let current;
            try {
                fs.writeFileSync(sourcePath, source);
                current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(current);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                for (const compilerPath of ["", process.env.FBC_EDITOR_EXECUTABLE]) {
                    await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                    if (compilerPath) {
                        const changes = new vscode.WorkspaceEdit();
                        changes.insert(current.uri, current.positionAt(current.getText().length), "' bridge overlay\n");
                        assert.equal(await vscode.workspace.applyEdit(changes), true);
                    }
                    assert.equal(current.isDirty, Boolean(compilerPath));
                    for (const [reference, prefix, name] of [["Return @Compute", "Return @Com", "Compute"],
                        ["@CallbackScope.ComputeScoped", "@CallbackScope.Comp", "ComputeScoped"],
                        ["@.CallbackScope.ComputeScoped", "@.CallbackScope.Comp", "ComputeScoped"],
                        ["@.Compute", "@.Com", "Compute"],
                        ["@..CallbackScope.ComputeScoped", "@..CallbackScope.Comp", "ComputeScoped"]]) {
                        const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                            position(current, reference, prefix.length));
                        const item = completions.items.find((candidate) => candidate.label === name &&
                            candidate.kind === vscode.CompletionItemKind.Function);
                        assert.ok(item, `${reference} (${compilerPath ? "bridge" : "stock"})`);
                        const insertion = typeof item.insertText === "string" ? item.insertText : item.insertText?.value;
                        assert.equal(insertion, name, "a procedure address must not acquire call arguments");
                        assert.equal(current.getText(item.range), name, "replace only the complete terminal identifier");
                        assert.ok(item.documentation, "address completion must retain declaration details");
                    }
                    for (const call of ["injected(1,", "callback(1,", "inferred(1,", "produced(1,", "handlersValue.invoke(1,",
                        "callbackArray(0)(1,", "callbackValues(0)(1,", "GetCallback(1)(1,", "(*callbackPointer)(1,", "(callback)(1,"]) {
                        const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                            position(current, call, call.length));
                        assert.equal(help?.signatures.length, 1, `${call} (${compilerPath ? "bridge" : "stock"})`);
                        assert.match(help.signatures[0].label, /^Function .*\(as long, as double\) as double$/i);
                        assert.deepEqual(help.signatures[0].parameters.map((parameter) =>
                            help.signatures[0].label.slice(...parameter.label)), ["as long", "as double"]);
                        assert.ok(help.signatures[0].parameters[1].label[0] > help.signatures[0].parameters[0].label[1]);
                        assert.equal(help.activeParameter, 1);
                    }
                    for (const name of ["callbackArray", "callbackValues"]) {
                        const array = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                            position(current, `Print ${name}(0)`, `Print ${name}(`.length));
                        assert.equal(array?.signatures.length, 1);
                        assert.match(array.signatures[0].label, new RegExp(`^Array ${name}\\(`),
                            "indexing an array of callbacks is not a callback invocation: " + name);
                    }
                    for (const [call, prefix, labels, active] of [
                        ["matrix(0, 2)", "matrix(0,", ["index1: -1 To 4", "index2: 1 To 3"], 1],
                        ["holder.values(0)", "holder.values(", ["index1: -2 To 2"], 0],
                        ["GetHolder().values(0)", "GetHolder().values(", ["index1: -2 To 2"], 0],
                        ["holders(0).values(0)", "holders(0).values(", ["index1: -2 To 2"], 0],
                        ["(*holderPointer).values(0)", "(*holderPointer).values(", ["index1: -2 To 2"], 0],
                        ["GetHolder().callbacks(0)(1)", "GetHolder().callbacks(", ["index1: -1 To 1"], 0],
                        ["dynamicValues(0, 2)", "dynamicValues(0,", ["index1", "index2"], 1],
                        ["Print values(0, 2)", "Print values(0,", ["indices..."], 0]
                    ]) {
                        const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                            position(current, call, prefix.length));
                        assert.equal(help?.signatures.length, 1, call);
                        assert.match(help.signatures[0].label, /^Array /);
                        const actual = help.signatures[0].parameters.map((parameter) => help.signatures[0].label.slice(...parameter.label));
                        const expected = compilerPath && actual.every((label) => /^index\d+$/.test(label))
                            ? labels.map((_, index) => `index${index + 1}`) : labels;
                        assert.deepEqual(actual, expected, `${call} (${compilerPath ? "bridge" : "stock"}): ${help.signatures[0].label}`);
                        assert.equal(help.activeParameter, active, call);
                        assert.ok(help.signatures[0].parameters.every((parameter) => parameter.documentation), call);
                    }
                    const elementCall = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, "GetHolder().callbacks(0)(1)", "GetHolder().callbacks(0)(".length));
                    assert.equal(elementCall?.signatures.length, 1);
                    assert.match(elementCall.signatures[0].label, /^Function .*\(as long\) as double$/i,
                        "the second argument list invokes the selected callback element rather than indexing the array");
                    const action = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, "action(resultValue)", "action(".length));
                    assert.match(action?.signatures[0]?.label || "", /^Sub action\(byref as long\)$/i);
                    assert.equal(action.activeParameter, 0);
                    for (const [call, type] of [["CachedChoice(CLng(1),", "Long"], ["CachedChoice(CDbl(1),", "Double"]]) {
                        const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                            position(current, call, call.length));
                        assert.equal(help?.signatures.length, 2, "cached native bindings must retain the overload dropdown");
                        assert.match(help.signatures[help.activeSignature].label, new RegExp(`amount As ${type}\\b`, "i"));
                        assert.equal(help.activeParameter, 1);
                    }
                }
                for (const statement of ["Print callback(1, )", "Print callback(1,"]) {
                    const text = source.replace("Print callback(1, 2)", statement);
                    const changes = new vscode.WorkspaceEdit();
                    changes.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), text);
                    assert.equal(await vscode.workspace.applyEdit(changes), true);
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, statement, statement.indexOf(",") + 1));
                    assert.equal(help?.signatures.length, 1, statement);
                    assert.equal(help.activeParameter, 1);
                }
                for (const [complete, statement] of [
                    ["Print callbackArray(0)(1, 2)", "Print callbackArray(0)(1, )"],
                    ["Print callbackArray(0)(1, 2)", "Print callbackArray(0)(1,"],
                    ["Print GetCallback(1)(1, 2)", "Print GetCallback(1)(1, )"],
                    ["Print (*callbackPointer)(1, 2)", "Print (*callbackPointer)(1, )"]
                ]) {
                    const text = source.replace(complete, statement);
                    const changes = new vscode.WorkspaceEdit();
                    changes.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), text);
                    await applyEditAndWaitForDocuments(changes, [current]);
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, statement, statement.lastIndexOf(",") + 1));
                    assert.equal(help?.signatures.length, 1, statement);
                    assert.equal(help.signatures[0].parameters.length, 2);
                    assert.equal(help.activeParameter, 1);
                }
                const fieldSource = source + ["Type RecoveryHandlers", "invoke As CallbackType", "Private:",
                    "hidden As CallbackType", "End Type", "Declare Function MakeHandlers() As RecoveryHandlers",
                    "Declare Function MakeHandlersPointer() As RecoveryHandlers Ptr",
                    "Dim handlerArray(0 To 1) As RecoveryHandlers", ""].join("\n");
                for (const receiver of ["MakeHandlers().invoke", "MakeHandlersPointer()->invoke", "handlerArray(0).invoke",
                    "(handlersValue.invoke)", "MakeHandlers().hidden"]) {
                    const statement = `Print ${receiver}(1,`;
                    const changes = new vscode.WorkspaceEdit();
                    changes.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)),
                        fieldSource + statement + "\n");
                    await applyEditAndWaitForDocuments(changes, [current]);
                    assert.equal(current.isDirty, true);
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, statement, statement.length));
                    if (receiver.endsWith(".hidden")) {
                        assert.equal(help?.signatures.length || 0, 0, "a surviving receiver does not grant private field access");
                        continue;
                    }
                    assert.equal(help?.signatures.length, 1, statement);
                    assert.deepEqual(help.signatures[0].parameters.map((parameter) =>
                        help.signatures[0].label.slice(...parameter.label)), ["as long", "as double"]);
                    assert.equal(help.activeParameter, 1);
                }
                for (const field of ["values", "callbacks"]) {
                    const changes = new vscode.WorkspaceEdit();
                    changes.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)),
                        source + `Print GetHolder().${field}(`);
                    await applyEditAndWaitForDocuments(changes, [current]);
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        current.positionAt(current.getText().length));
                    assert.equal(help?.signatures.length, 1, `unfinished ${field} indexing`);
                    assert.match(help.signatures[0].label, new RegExp(`^Array ${field}\\(`));
                    assert.equal(help.signatures[0].parameters.length, 1);
                }
                const declarations = [
                    "Declare Function Recoverable Overload(ByVal amount As Long, ByVal scale As Double) As Double",
                    "Declare Function Recoverable Overload(ByVal amount As Double, ByVal scale As Double) As Double",
                    "Declare Sub Apply Overload(ByVal amount As Long, ByVal scale As Double)",
                    "Declare Sub Apply Overload(ByVal amount As Double, ByVal scale As Double)",
                    "Type VisibleService", "    value As Long",
                    "Declare Function Measure Overload(ByVal amount As Long, ByVal scale As Double) As Double",
                    "Declare Function Measure Overload(ByVal amount As Double, ByVal scale As Double) As Double",
                    "Declare Sub Apply Overload(ByVal amount As Long, ByVal scale As Double)",
                    "Declare Sub Apply Overload(ByVal amount As Double, ByVal scale As Double)",
                    "Private:", "Declare Function Measure Overload(ByVal amount As String, ByVal scale As Double) As Double",
                    "End Type", "Dim service As VisibleService", ""
                ].join("\n");
                for (const [statement, count, selectedType] of [["Print Recoverable(1, )", 2], ["Print Recoverable(1,", 2],
                    ["Apply 1,", 2], ["Print service.Measure(1, )", 2],
                    ["Print Recoverable(CLng(1), 2)", 2, "Long"], ["Print Recoverable(CDbl(1), 2)", 2, "Double"],
                    ["Print service.Measure(CLng(1), 2)", 2, "Long"], ["Print service.Measure(CDbl(1), 2)", 2, "Double"],
                    ["Apply CLng(1), 2", 2, "Long"], ["Apply CDbl(1), 2", 2, "Double"],
                    ["service.Apply CDbl(1), 2", 2, "Double"], ["service . Apply CDbl(1), 2", 2, "Double"],
                    ["Apply CDbl(1), _\n    2", 2, "Double"],
                    ["If 1 Then Apply CLng(1), 2 Else Apply CDbl(1), 2", 2, "Long"]]) {
                    const text = declarations + source.replace("Print callback(1, 2)", statement);
                    const changes = new vscode.WorkspaceEdit();
                    changes.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), text);
                    assert.equal(await vscode.workspace.applyEdit(changes), true);
                    const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                        position(current, statement, statement.indexOf(",") + 1));
                    assert.equal(help?.signatures.length, count, statement);
                    assert.equal(help.activeParameter, 1);
                    if (selectedType) assert.match(help.signatures[help.activeSignature].label,
                        new RegExp(`amount As ${selectedType}\\b`, "i"), "FBC must choose the active overload: " + statement);
                    assert.ok(help.signatures.every((signature) => !/amount As String/i.test(signature.label)),
                        "recovery must not reveal a private method overload");
                }
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            } finally {
                if (current?.isDirty) {
                    await vscode.window.showTextDocument(current);
                    await vscode.commands.executeCommand("workbench.action.files.revert");
                }
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("compiler signature help shows written optional defaults", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-default-argument.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const call = "ApplyScale(2, 3.0)";
                const position = document.positionAt(document.getText().indexOf(call) + "ApplyScale(2, ".length);
                const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri, position);
                assert.equal(signature?.signatures.length, 1);
                assert.match(signature.signatures[0].parameters[1].label, /As Double\s*=\s*1\.5/i);
                const completionPosition = document.positionAt(document.getText().indexOf(call) + "Apply".length);
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, completionPosition);
                const applyScale = completions.items.find((item) => item.label === "ApplyScale" && item.kind !== vscode.CompletionItemKind.Text);
                const applyScaleSnippet = typeof applyScale?.insertText === "string" ? applyScale.insertText : applyScale?.insertText?.value;
                assert.equal(applyScaleSnippet, "ApplyScale", "written optional arguments must not be duplicated by completion");
                const freshCompletions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
                    document.positionAt(document.getText().length));
                const freshApplyScale = freshCompletions.items.find((item) => item.label === "ApplyScale");
                const freshSnippet = typeof freshApplyScale?.insertText === "string" ? freshApplyScale.insertText : freshApplyScale?.insertText?.value;
                assert.equal(freshSnippet, "ApplyScale(${1:value})$0",
                    "fresh completion should prompt only for the required argument");
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("compiler-selected declaration types appear as inlay hints", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const previousRun = configuration.get("analysis.run", "onDemand");
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-type-inlay-hints.bas"));
            let document;
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "onDemand", vscode.ConfigurationTarget.Global);
                document = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);

                const lastLine = document.lineCount - 1;
                const range = new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);
                const hints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", uri, range);
                const describes = (name) => hints.some((hint) =>
                    document.lineAt(hint.position.line).text.slice(0, hint.position.character).trimEnd().endsWith(name) &&
                    /:\s*integer\b/i.test(typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join(""))
                );
                const visibleHints = hints.map((hint) => ({
                    position: hint.position,
                    label: typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join("")
                }));
                assert.ok(describes("implicitValue"), `an implicit declaration should show the compiler-selected type: ${JSON.stringify(visibleHints)}`);
                assert.ok(describes("inferredValue"), `an inferred constant should show the compiler-selected type: ${JSON.stringify(visibleHints)}`);
                assert.ok(describes("inferredFunction"), `an implicit function result should show the compiler-selected type: ${JSON.stringify(visibleHints)}`);
                assert.ok(describes("implicitParameter"), `an implicit parameter should show the compiler-selected type: ${JSON.stringify(visibleHints)}`);
                assert.equal(describes("explicitValue"), false, "an explicit As type needs no hint");
                assert.equal(describes("suffixValue"), false, "a written type suffix needs no hint");
                assert.equal(describes("explicitFunction"), false, "an explicit function result type needs no hint");
                assert.equal(describes("explicitParameter"), false, "an explicit parameter type needs no hint");
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", previousRun, vscode.ConfigurationTarget.Global);
            }
        });
        await check("compiler macro hover previews multiline #macro bodies", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-macro-block.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const position = document.positionAt(document.getText().indexOf("BLOCK_VALUE"));
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position);
                const content = hovers.flatMap((hover) => hover.contents.map((value) => value.value)).join("\n");
                assert.match(content, /#macro BLOCK_VALUE[\s\S]*42[\s\S]*#endmacro/i);
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("compiler-selected inactive branches suppress bracket warnings and fade code", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-inactive-brackets.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            const bracketDiagnostics = () => vscode.languages.getDiagnostics(uri)
                .filter((diagnostic) => diagnostic.source === "FreeBASIC brackets");
            const inactiveDiagnostics = () => vscode.languages.getDiagnostics(uri)
                .filter((diagnostic) => diagnostic.code === "inactive-code");
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                assert.equal(bracketDiagnostics().length, 1,
                    "the immediate lexical pass should report the opener before compiler selection is available");
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const deadline = Date.now() + 5000;
                while ((bracketDiagnostics().length || !inactiveDiagnostics().length) && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                assert.equal(bracketDiagnostics().length, 0,
                    "a current compiler model should exclude the unmatched opener in the inactive branch");
                assert.equal(inactiveDiagnostics().length, 1,
                    "the compiler-confirmed inactive source range should receive one unnecessary-code diagnostic");
                assert.ok(inactiveDiagnostics()[0].tags.includes(vscode.DiagnosticTag.Unnecessary));
                assert.match(document.getText(inactiveDiagnostics()[0].range), /Print \(/,
                    "the unnecessary-code range should cover the unselected source text");
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, position(document, "#if 0", 4));
                const hoverText = hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(hoverText, /Condition evaluated to `false`/i,
                    "hover should show the compiler's conditional result");
                assert.match(hoverText, /branch is not selected/i,
                    "hover should show the selected-branch outcome for this build context");
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("compiler-selected include outcomes link only active physical directives", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-include-links.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);

                const links = await waitForDocumentLinks(uri);
                assert.equal(links.length, 1, "inactive and macro-expanded include operands must not receive guessed links");
                assert.equal(links[0].target.fsPath, path.join(__dirname, "workspace/compiler-defines.bi"));
                /* VS Code 1.85 drops tooltips when converting executeLinkProvider
                   results back to DocumentLink objects. The raw editor DTO
                   still carries the provider's tooltip on that version. */
                const rawLinks = links[0].tooltip === undefined
                    ? await waitForDocumentLinks(uri, "_executeLinkProvider") : links;
                assert.match(rawLinks[0].tooltip, /Resolved by FreeBASIC to .*compiler-defines\.bi/i);
                assert.match(document.getText(links[0].range), /compiler-defines\.bi/);
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("native diagnostics keep safe included-header ranges for an imprecise compiler point", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const sourceUri = vscode.Uri.file(path.join(__dirname, "workspace/invalid.bas"));
            const headerUri = vscode.Uri.file(path.join(__dirname, "workspace/invalid.bi"));
            const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
            const headerDocument = await vscode.workspace.openTextDocument(headerUri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(sourceDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);

                /* FBC 1.20.5 reports the opening PRINT token for this error,
                   but its message names only the rejected variable. The
                   publisher cannot corroborate that token, so it keeps the
                   captured source line instead of inventing a precise point. */
                const expected = position(headerDocument, "Print missingIntegrationValue");
                const diagnostics = vscode.languages.getDiagnostics(headerUri).filter((diagnostic) => diagnostic.source === "fbc (buffer)");
                assert.ok(diagnostics.some((diagnostic) =>
                    diagnostic.range.start.line === expected.line && diagnostic.range.start.character === expected.character &&
                    diagnostic.range.end.character === headerDocument.lineAt(expected.line).text.length),
                `the safe included-header range should be retained: ${JSON.stringify(diagnostics.map((diagnostic) => ({
                    code: diagnostic.code, message: diagnostic.message, range: diagnostic.range
                })))}`);
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("native Outline compiles on demand and preserves physical declaration hierarchy", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const symbolUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-symbols.bas"));
            const symbolDocument = await vscode.workspace.openTextDocument(symbolUri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", symbolUri);
                const catalog = symbols.find((symbol) => symbol.name === "Catalog");
                const record = catalog.children.find((symbol) => symbol.name === "Record");
                const prototype = catalog.children.find((symbol) => symbol.name === "ReadValue");
                const definition = symbols.find((symbol) => symbol.name === "ReadValue" && symbol.selectionRange.start.line === position(symbolDocument, "Function Catalog.ReadValue").line);
                assert.ok(catalog && record && prototype && definition);
                assert.equal(record.children[0].name, "value");
                assert.equal(prototype.children[0].name, "declared");
                assert.equal(definition.children[0].name, "actual");
                assert.equal(definition.range.end.line, position(symbolDocument, "End Function").line);
            } finally {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native workspace symbols follow the selected build across closed modules", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "compiler.arguments", "index.workspaceConcurrency"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-workspace-builds-"));
            const first = path.join(directory, "first.bas"), second = path.join(directory, "second.bas");
            const source = (suffix) => ["Namespace BuildSearch", "#ifdef ALTERNATE", `Sub Alternate${suffix}()`, "#else",
                `Sub Normal${suffix}()`, "#endif", "End Sub", "End Namespace", ""].join("\n");
            try {
                fs.writeFileSync(first, source("First"));
                fs.writeFileSync(second, source("Second"));
                for (const [name, value] of [["analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE], ["compiler.arguments", []],
                    ["index.workspaceConcurrency", 1], ["analysis.projectContexts", [{ name: "normal", modules: [first, second] },
                        { name: "alternate", modules: [first, second], arguments: ["-d", "ALTERNATE"] }]]]) {
                    await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                }
                for (const [active, expected] of [[{ name: "normal", module: first }, ["NormalFirst", "NormalSecond"]],
                    [{ name: "alternate", module: first }, ["AlternateFirst", "AlternateSecond"]],
                    [null, ["NormalFirst", "NormalSecond", "AlternateFirst", "AlternateSecond"]],
                    [{ name: "normal", module: second }, ["NormalFirst", "NormalSecond"]]]) {
                    await configuration.update("analysis.activeContext", active, vscode.ConfigurationTarget.Global);
                    const symbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "BuildSearch.");
                    assert.deepEqual(symbols.map((symbol) => symbol.name).sort(), expected.sort(), JSON.stringify(active));
                    assert.ok(symbols.every((symbol) => [first, second].includes(symbol.location.uri.fsPath)));
                    assert.equal(vscode.workspace.textDocuments.some((document) => [first, second].includes(document.uri.fsPath)), false,
                        "workspace search must not open the configured modules");
                }
                assert.equal(fs.readFileSync(first, "utf8"), source("First"));
                assert.equal(fs.readFileSync(second, "utf8"), source("Second"));
            } finally {
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("native workspace symbols find declarations in closed configured modules", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const scopeUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-scopes.bas"));
            const originalConcurrency = configuration.get("index.workspaceConcurrency", 2);
            try {
                assert.equal(vscode.workspace.textDocuments.some((document) => document.uri.toString() === scopeUri.toString()), false);
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{ name: "workspace", modules: ["compiler-symbols.bas", "compiler-scopes.bas"] }], vscode.ConfigurationTarget.Global);
                const symbolsUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-symbols.bas"));
                const symbolsDocument = await vscode.workspace.openTextDocument(symbolsUri);
                const [symbols, hovers] = await Promise.all([
                    vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "catalog.reopenedvalue"),
                    vscode.commands.executeCommand("vscode.executeHoverProvider", symbolsUri, position(symbolsDocument, "actual.value", 7))
                ]);
                const reopened = symbols.find((symbol) => symbol.name === "reopenedValue" && symbol.location.uri.toString() === scopeUri.toString());
                assert.ok(reopened);
                assert.match(reopened.containerName, /Catalog/i);
                assert.match(reopened.containerName, /workspace/);
                assert.match(hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /compiler type.*double/i,
                    "Foreground hover must remain responsive while workspace modules are indexed.");
                const missing = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "catalog.notDeclared");
                assert.equal(missing.length, 0, "Qualified workspace queries must not return unrelated declarations.");
                await configuration.update("index.workspaceConcurrency", 1, vscode.ConfigurationTarget.Global);
                const serialSymbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "catalog.reopenedvalue");
                assert.ok(serialSymbols.some((symbol) => symbol.name === "reopenedValue" && symbol.location.uri.toString() === scopeUri.toString()),
                    "Reducing workspace indexing to one worker must preserve native results.");
            } finally {
                await configuration.update("index.workspaceConcurrency", originalConcurrency, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native identities drive parameter navigation, type definitions, and non-procedure rename", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "symbols", modules: ["compiler-symbols.bas"] }], vscode.ConfigurationTarget.Global);
            const symbolUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-symbols.bas"));
            const symbolDocument = await vscode.workspace.openTextDocument(symbolUri);
            const original = symbolDocument.getText();
            try {
                await vscode.window.showTextDocument(symbolDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", symbolUri, position(symbolDocument, "actual.value", 1));
                assert.equal(references.length, 3);
                const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", symbolUri, position(symbolDocument, "actual.value", 1));
                assert.equal(definitions.length, 1);
                assert.equal(symbolDocument.getText(definitions[0].range), "actual");
                const types = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", symbolUri, position(symbolDocument, "recordValue.value", 2));
                assert.ok(types.some((location) => symbolDocument.getText(location.range) === "Record"));
                const fieldEdits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", symbolUri, position(symbolDocument, "recordValue.value", 14), "fieldValue");
                assert.equal(fieldEdits.get(symbolUri).length, 3);
                const typeEdits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", symbolUri, position(symbolDocument, "Type Record\n", 6), "RenamedRecord");
                assert.equal(typeEdits.get(symbolUri).length, 2);
                assert.equal(symbolDocument.getText(), original);
                assert.equal(fs.readFileSync(symbolUri.fsPath, "utf8"), original);
            } finally {
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native address references and virtual-family rename reach the standard providers", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const dispatchUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-dispatch.bas"));
            const dispatch = await vscode.workspace.openTextDocument(dispatchUri);
            const referencesUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-reference-forms.bas"));
            const references = await vscode.workspace.openTextDocument(referencesUri);
            try {
                await vscode.window.showTextDocument(references);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", referencesUri, position(references, "@Functions.Pick", 12));
                assert.equal(definitions.length, 1);
                assert.match(references.lineAt(definitions[0].range.start.line).text, /ByVal value As Long/);
                await configuration.update("analysis.projectContexts", [{ name: "virtual", modules: ["compiler-dispatch.bas"] }], vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(dispatch);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const derivedTypes = await vscode.commands.executeCommand(
                    "vscode.prepareTypeHierarchy", dispatchUri, position(dispatch, "Type DerivedSelector", 5)
                );
                assert.equal(derivedTypes.length, 1);
                assert.equal(derivedTypes[0].name, "DerivedSelector");
                const directBases = await vscode.commands.executeCommand("vscode.provideSupertypes", derivedTypes[0]);
                assert.ok(directBases.some((item) => item.name === "BaseSelector"),
                    "native hierarchy should follow the compiler-selected base type identity");
                const baseTypes = await vscode.commands.executeCommand(
                    "vscode.prepareTypeHierarchy", dispatchUri, position(dispatch, "Type BaseSelector", 5)
                );
                const directDerivedTypes = await vscode.commands.executeCommand("vscode.provideSubtypes", baseTypes[0]);
                assert.ok(directDerivedTypes.some((item) => item.name === "DerivedSelector"),
                    "native hierarchy should find the compiler-selected direct subtype");
                const rename = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", dispatchUri, position(dispatch, "instance.Choose(1)", 10), "SelectValue");
                assert.equal(rename.get(dispatchUri).length, 6);
                assert.ok(rename.get(dispatchUri).every((edit) => dispatch.getText(edit.range) === "Choose"));
                assert.equal(dispatch.getText(), fs.readFileSync(dispatchUri.fsPath, "utf8"));
            } finally {
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native compound expression prefixes drive selection types and member completion", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const chainUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-expression-chains.bas"));
            const chainDocument = await vscode.workspace.openTextDocument(chainUri);
            const original = chainDocument.getText();
            try {
                const editor = await vscode.window.showTextDocument(chainDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                for (const [prefix, expected] of [["roots(0).child", "treetypes.branch"], ["rootPointer[0]", "treetypes.root"], ["MakeRoot().child.leaves(0)", "treetypes.leaf"], ["callback()->child", "treetypes.branch"]]) {
                    const start = position(chainDocument, "Print " + prefix, 6);
                    editor.selection = new vscode.Selection(start, start.translate(0, prefix.length));
                    assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), expected);
                }
                const intermediate = position(chainDocument, "Print (**doublePointer)", 8);
                editor.selection = new vscode.Selection(intermediate, intermediate.translate(0, "*doublePointer".length));
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "treetypes.root ptr");
                const completion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", chainUri, position(chainDocument, "MakeRoot().child.leaves(0).amount", "MakeRoot().child.leaves(0).".length));
                assert.ok(completion.items.some((item) => item.label === "amount"));
                assert.equal(chainDocument.getText(), original);
                assert.equal(fs.readFileSync(chainUri.fsPath, "utf8"), original);
            } finally {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        if (process.env.FREEBASIC_ROOT) {
            await check("compiler semantic sidecar supplies physical array-initializer expression types", async () => {
                const configuration = vscode.workspace.getConfiguration("freebasic");
                const compilerRoot = path.resolve(process.env.FREEBASIC_ROOT);
                const includePaths = configuration.get("includePaths", []);
                const compilerPath = configuration.get("analysis.compilerPath", "");
                const sourcePath = path.join(compilerRoot, "tests/gfx/palette.bas");
                const sourceUri = vscode.Uri.file(sourcePath);
                const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
                const source = sourceDocument.getText();
                const lines = source.split(/\r\n|\n|\r/);
                const line = lines.findIndex((value) => value.trimStart().startsWith("&h"));
                const startColumn = line < 0 ? -1 : lines[line].indexOf("&h");
                const endColumn = line < 0 ? -1 : lines[line].indexOf(",", startColumn);
                assert.ok(line >= 0 && startColumn >= 0 && endColumn > startColumn);
                try {
                    await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                    await configuration.update("includePaths", [path.join(compilerRoot, "inc"), path.join(compilerRoot, "tests/fbcunit/inc")], vscode.ConfigurationTarget.Global);
                    const editor = await vscode.window.showTextDocument(sourceDocument);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                    /* Normal rendering can upgrade the same input to bindings.
                       That stronger snapshot must retain initializer types. */
                    await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", sourceUri);
                    const lastLine = sourceDocument.lineCount - 1;
                    await vscode.commands.executeCommand("vscode.executeInlayHintProvider", sourceUri,
                        new vscode.Range(0, 0, lastLine, sourceDocument.lineAt(lastLine).text.length));
                    editor.selection = new vscode.Selection(new vscode.Position(line, startColumn), new vscode.Position(line, endColumn));
                    const selectedType = await vscode.commands.executeCommand("freebasic.showExpressionType");
                    assert.equal(selectedType?.toLowerCase(), "integer",
                        "initializer types must remain available after background binding requests");
                    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", sourceUri, new vscode.Position(line, startColumn));
                    assert.match(hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `integer`/i);
                    assert.equal(sourceDocument.getText(), source);
                    assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
                } finally {
                    await configuration.update("includePaths", includePaths, vscode.ConfigurationTarget.Global);
                    await configuration.update("analysis.compilerPath", compilerPath, vscode.ConfigurationTarget.Global);
                }
            });
        }
        await check("native inventory drives inherited and anonymous member completion", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const scopeUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-scopes.bas"));
            const scopeDocument = await vscode.workspace.openTextDocument(scopeUri);
            const original = scopeDocument.getText();
            try {
                await vscode.window.showTextDocument(scopeDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const external = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", scopeUri, position(scopeDocument, "instance.publicValue", "instance.".length));
                const names = external.items.map((item) => item.label);
                for (const name of ["publicValue", "ownValue", "anonymousLong", "anonymousDouble"]) assert.ok(names.includes(name), name);
                assert.ok(!names.includes("protectedValue") && !names.includes("privateValue"));
                const internal = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", scopeUri, position(scopeDocument, "This.protectedValue", "This.".length));
                assert.ok(internal.items.some((item) => item.label === "protectedValue"));
                assert.ok(!internal.items.some((item) => item.label === "privateValue"));
                assert.equal(scopeDocument.getText(), original);
                for (const member of ["instance.", "instance.pub"]) {
                    const text = original.replace("instance.publicValue", member);
                    const changes = new vscode.WorkspaceEdit();
                    changes.replace(scopeUri, new vscode.Range(scopeDocument.positionAt(0),
                        scopeDocument.positionAt(scopeDocument.getText().length)), text);
                    assert.equal(await vscode.workspace.applyEdit(changes), true);
                    assert.equal(scopeDocument.isDirty, true);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                    const completion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider",
                        scopeUri, position(scopeDocument, "Print " + member, ("Print " + member).length));
                    const labels = completion.items.map((item) => item.label);
                    for (const name of ["publicValue", "ownValue", "anonymousLong", "anonymousDouble"]) {
                        assert.ok(labels.includes(name), member + ": " + name);
                    }
                    assert.ok(!labels.includes("protectedValue") && !labels.includes("privateValue"), member);
                    assert.ok(!labels.includes("Print"), "a value member prefix is not a constructor context");
                }
                for (const [before, statement, expected, excluded, queryLine = statement] of [
                    ["    Print localValue", "    Print loc", ["localValue", "amount", "ownValue"], ["branchValue", "loopValue"]],
                    ["    Print localValue", "    ", ["localValue", "amount", "ownValue"], ["branchValue", "loopValue", "index"]],
                    ["    Print localValue", '    Print "Unicode café 😀"\n    \n    Print localValue',
                        ["localValue", "amount", "ownValue"], ["branchValue", "loopValue", "index"], "    "],
                    ["    Print localValue", '    Print !"escaped\\ntext"\n    \n    Print localValue',
                        ["localValue", "amount", "ownValue"], ["branchValue", "loopValue", "index"], "    "],
                    ["Print instance.ownValue", "Print inst", ["instance", "sharedValue"], ["localValue", "amount", "branchValue"]],
                    ["Print sharedValue", "Print sharedValue\n    ", ["instance", "sharedValue"],
                        ["localValue", "amount", "branchValue", "loopValue", "index"], "    "],
                    ["Print sharedValue", "Print compilerEofMissing\n    ", ["instance", "sharedValue"],
                        ["localValue", "amount", "branchValue", "compilerEofMissing"], "    "]
                ]) {
                    const text = original.replace(before, statement);
                    const changes = new vscode.WorkspaceEdit();
                    changes.replace(scopeUri, new vscode.Range(scopeDocument.positionAt(0),
                        scopeDocument.positionAt(scopeDocument.getText().length)), text);
                    assert.equal(await vscode.workspace.applyEdit(changes), true);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                    const line = text.split("\n").findIndex((value) => value === queryLine);
                    const completion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider",
                        scopeUri, new vscode.Position(line, queryLine.length));
                    const labels = completion.items.map((item) => item.label);
                    for (const name of expected) assert.ok(labels.includes(name), statement + ": " + name);
                    for (const name of excluded) assert.ok(!labels.includes(name), statement + ": " + name);
                }
                const labelSource = ["moduleFinish:", "Sub Work()", "    Goto fin", "    If 0 Then", "finish:",
                    "    Print 2", "    End If", "End Sub", "Sub Other()", "otherFinish:", "End Sub", "Work()", ""].join("\n");
                const labelChanges = new vscode.WorkspaceEdit();
                labelChanges.replace(scopeUri, new vscode.Range(scopeDocument.positionAt(0),
                    scopeDocument.positionAt(scopeDocument.getText().length)), labelSource);
                assert.equal(await vscode.workspace.applyEdit(labelChanges), true);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const labels = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", scopeUri,
                    position(scopeDocument, "    Goto fin", "    Goto fin".length));
                /* VS Code separately merges contributed prefix snippets. */
                assert.deepEqual(labels.items.filter((item) => item.kind !== vscode.CompletionItemKind.Snippet)
                    .map((item) => item.label), ["finish"],
                    "forward-label suggestions must remain in their compiler procedure scope");
                assert.equal(fs.readFileSync(scopeUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(scopeDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native escape contexts distinguish strings from following code", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-scopes.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            const original = document.getText();
            const source = "\uFEFF" + String.raw`#lang "fblite"
#if 1
Option Escape
#endif
Option NoKeyword REM
Dim REM As Long
Print REM
#define EscapeOnlyMacro 1
Declare Sub EscapeOnlyCall(ByVal amount As Long)
Type EscapePayload
    value As Long
End Type
Dim escapedInstance As EscapePayload
Print "inside \" EscapeOnlyMacro EscapeOnlyCall(1)"
Print "inside \" GhostCall(99, 2)" : EscapeOnlyCall(1)
Print "inside \" ignored" : Print EscapeOnlyMacro
Print "inside \" ignored" : escapedInstance.value = 1
`;
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                const changes = new vscode.WorkspaceEdit();
                changes.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
                assert.equal(await vscode.workspace.applyEdit(changes), true);
                /* This request must acquire option facts itself, before a
                   manual analysis or another feature warms the snapshot. */
                const actualCallPrefix = String.raw`Print "inside \" GhostCall(99, 2)" : EscapeOnlyCall(`;
                const actualSignature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                    position(document, actualCallPrefix, actualCallPrefix.length));
                assert.ok(actualSignature?.signatures?.some((signature) => /EscapeOnlyCall/i.test(signature.label)),
                    "a call following an escaped literal must retain Signature Help");
                assert.equal(actualSignature.activeParameter, 0, "fake string arguments must not affect the real call");
                const actualMacroPrefix = String.raw`Print "inside \" ignored" : Print EscapeOnlyMa`;
                const actualCompletions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
                    position(document, actualMacroPrefix, actualMacroPrefix.length));
                assert.ok(actualCompletions.items.some((item) => item.label === "EscapeOnlyMacro" &&
                    item.kind === vscode.CompletionItemKind.Snippet),
                    "code following an escaped literal must retain native completion");
                const instance = position(document, " : escapedInstance.value", " : esc".length);
                const hierarchy = await vscode.commands.executeCommand("vscode.prepareTypeHierarchy", uri, instance);
                assert.deepEqual(hierarchy.map((item) => item.name), ["EscapePayload"],
                    "Type Hierarchy must not reclassify a compiler-confirmed identifier as string contents");
                const definitions = await vscode.commands.executeCommand("vscode.executeTypeDefinitionProvider", uri, instance);
                assert.ok(definitions.some((location) => location.uri.toString() === uri.toString() &&
                    location.range.start.line === position(document, "Type EscapePayload").line));
                /* The acquired option facts must remain usable by other
                   binding-backed requests on the same unsaved snapshot. */
                const bound = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
                    position(document, "Print REM", "Print RE".length));
                assert.ok(bound.items.some((item) => item.label === "REM" && item.kind === vscode.CompletionItemKind.Variable));
                const prefix = String.raw`Print "inside \" EscapeOnlyMacro`;
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
                    position(document, prefix, prefix.length));
                /* VS Code merges word-based text and contributed snippets
                   independently of this language provider. */
                const codeItems = completions.items.filter((item) =>
                    item.kind !== vscode.CompletionItemKind.Snippet && item.kind !== vscode.CompletionItemKind.Text);
                assert.deepEqual(codeItems, [],
                    "a compiler-confirmed escaped string must not offer code completions: " +
                    JSON.stringify(codeItems.map(({ label, kind }) => ({ label, kind }))));
                assert.ok(!completions.items.some((item) => item.label === "EscapeOnlyMacro" &&
                    item.kind === vscode.CompletionItemKind.Snippet), "native macro snippets must also stay out of strings");
                const callPrefix = prefix + " EscapeOnlyCall(";
                const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri,
                    position(document, callPrefix, callPrefix.length));
                assert.ok(!signature?.signatures?.length, "call-like string contents must not trigger Signature Help");
                assert.equal(fs.readFileSync(uri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(document);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("physical origins drive unsaved continued and remapped expression navigation and rename", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "physical", modules: ["compiler-origins.bas"] }], vscode.ConfigurationTarget.Global);
            const originUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-origins.bas"));
            const originDocument = await vscode.workspace.openTextDocument(originUri);
            const original = originDocument.getText();
            try {
                const changes = new vscode.WorkspaceEdit();
                changes.insert(originUri, originDocument.positionAt(original.length), "\nPrint originValue * 5\n");
                assert.equal(await vscode.workspace.applyEdit(changes), true);
                const editor = await vscode.window.showTextDocument(originDocument);
                assert.equal(originDocument.isDirty, true);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const start = position(originDocument, "originValue +");
                editor.selection = new vscode.Selection(start, start.translate(1, 5 - start.character));
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "double");
                const selected = position(originDocument, "Print originValue * 5", 8);
                const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", originUri, selected);
                assert.ok(definitions.some((entry) => entry.uri.toString() === originUri.toString() && entry.range.start.line === position(originDocument, "Dim originValue").line));
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", originUri, selected);
                assert.equal(references.length, [...originDocument.getText().matchAll(/\boriginValue\b/g)].length);
                assert.ok(references.every((entry) => entry.uri.toString() === originUri.toString()));
                const edits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", originUri, selected, "physicalValue");
                assert.equal(edits.get(originUri).length, references.length);
                assert.ok(edits.get(originUri).every((edit) => originDocument.getText(edit.range) === "originValue"));
                assert.equal(fs.readFileSync(originUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(originDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("macro origins drive repeated-argument types, navigation, and validated rename previews", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "macros", modules: ["compiler-macro-origins.bas"] }], vscode.ConfigurationTarget.Global);
            const macroUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-macro-origins.bas"));
            const macroDocument = await vscode.workspace.openTextDocument(macroUri);
            const original = macroDocument.getText();
            try {
                const changes = new vscode.WorkspaceEdit();
                changes.insert(macroUri, macroDocument.positionAt(original.length), "\nPrint TwiceValue(createdValue + 1)\n");
                assert.equal(await vscode.workspace.applyEdit(changes), true);
                const editor = await vscode.window.showTextDocument(macroDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const start = position(macroDocument, "createdValue + 1");
                editor.selection = new vscode.Selection(start, start.translate(0, "createdValue + 1".length));
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "double");
                const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", macroUri, start);
                assert.ok(definitions.some((entry) => entry.uri.toString() === macroUri.toString() &&
                    entry.range.start.line === position(macroDocument, "DeclareValue(createdValue)").line),
                "macro-origin definition navigation should reach the physical declaration argument");
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", macroUri, start);
                assert.equal(references.length, 3, "Duplicated expansion is one physical reference");
                const edits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", macroUri, start, "declaredValue");
                assert.equal(edits.get(macroUri).length, 3);
                assert.ok(edits.get(macroUri).every((edit) => macroDocument.getText(edit.range) === "createdValue"));
                const fieldEdits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", macroUri, position(macroDocument, "ReadMember(item, amount)", "ReadMember(item, ".length), "fieldValue");
                assert.equal(fieldEdits.get(macroUri).length, 2);
                // This module also stringifies sourceValue. Its argument has no
                // compiler-bound reference, so complete project coverage cannot
                // be established even though the nested copied references bind.
                await assert.rejects(vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", macroUri, position(macroDocument, "NestedValue(sourceValue)", "NestedValue(".length), "inputValue"), /not compiler-bound|generated|unmapped|directly represented/i);
                assert.equal(fs.readFileSync(macroUri.fsPath, "utf8"), original);
                assert.equal(macroDocument.isDirty, true, "Rename preview must not save the buffer");
            } finally {
                await vscode.window.showTextDocument(macroDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("project rename edits one source component in generated names and pasted references", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const module = "compiler-token-paste-rename.bas";
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "token-paste", modules: [module] }], vscode.ConfigurationTarget.Global);
            const sourceUri = vscode.Uri.file(path.join(__dirname, "workspace", module));
            const document = await vscode.workspace.openTextDocument(sourceUri);
            const original = document.getText();
            try {
                await vscode.window.showTextDocument(document);
                const edits = await vscode.commands.executeCommand(
                    "vscode.executeDocumentRenameProvider", sourceUri, position(document, "Print myValue", "Print ".length), "otherValue");
                assert.equal(edits.get(sourceUri).length, 2);
                const argument = edits.get(sourceUri).find((edit) => document.getText(edit.range) === "my");
                const reference = edits.get(sourceUri).find((edit) => document.getText(edit.range) === "myValue");
                assert.ok(argument);
                assert.equal(argument.newText, "other");
                assert.ok(reference);
                assert.equal(reference.newText, "otherValue");

                await assert.rejects(
                    vscode.commands.executeCommand(
                        "vscode.executeDocumentRenameProvider", sourceUri, position(document, "Print myValue", "Print ".length), "otherItem"),
                    /generated or unmapped text/i);

                const referenceEdits = await vscode.commands.executeCommand(
                    "vscode.executeDocumentRenameProvider", sourceUri, position(document, "Print sourceValue", "Print ".length), "inputValue");
                assert.equal(referenceEdits.get(sourceUri).length, 3);
                const pastedArgument = referenceEdits.get(sourceUri).find((edit) => document.getText(edit.range) === "source");
                const physicalReferences = referenceEdits.get(sourceUri).filter((edit) => document.getText(edit.range) === "sourceValue");
                assert.ok(pastedArgument);
                assert.equal(pastedArgument.newText, "input");
                assert.equal(physicalReferences.length, 2);
                assert.ok(physicalReferences.every((edit) => edit.newText === "inputValue"));
                await assert.rejects(
                    vscode.commands.executeCommand(
                        "vscode.executeDocumentRenameProvider", sourceUri, position(document, "Print sourceValue", "Print ".length), "otherItem"),
                    /generated or unmapped text/i);
                assert.equal(document.getText(), original, "Rename previews must not apply or save source edits.");
                assert.equal(fs.readFileSync(sourceUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(document);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("compiler-bound procedure rename includes continued macro replacement text", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const module = "compiler-macro-procedure.bas";
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "macro-procedure", modules: [module] }], vscode.ConfigurationTarget.Global);
            const sourceUri = vscode.Uri.file(path.join(__dirname, "workspace", module));
            const source = await vscode.workspace.openTextDocument(sourceUri);
            const original = source.getText();
            try {
                await vscode.window.showTextDocument(source);
                const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", sourceUri, position(source, "Function SelectedProcedure", 11), "RenamedProcedure");
                const edits = edit.get(sourceUri);
                assert.equal(edits.length, 3, "the declaration, macro replacement token, and direct call should be renamed");
                assert.deepEqual(edits.map((entry) => entry.range.start.line), [7, 12, 15]);
                assert.ok(edits.every((entry) => entry.newText === "RenamedProcedure"));
                assert.equal(source.isDirty, false, "project rename should return a preview without applying it");
                assert.equal(fs.readFileSync(sourceUri.fsPath, "utf8"), original);
            } finally {
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native preprocessor symbols provide signatures, qualified queries, semantic tokens, completion, and project rename", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "preprocessor", modules: ["compiler-preprocessor.bas"] }], vscode.ConfigurationTarget.Global);
            const macroUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-preprocessor.bas"));
            const macroDocument = await vscode.workspace.openTextDocument(macroUri);
            const original = macroDocument.getText();
            try {
                await vscode.window.showTextDocument(macroDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const selected = position(macroDocument, "Print SCALE_VALUE(inputValue)", 8);
                const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", macroUri, selected);
                assert.equal(definitions.length, 2);
                assert.ok(definitions.every((entry) => macroDocument.getText(entry.range) === "SCALE_VALUE"));
                const macroCallHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", macroUri, selected);
                const macroCallHoverText = macroCallHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.doesNotMatch(macroCallHoverText, /#define SCALE_VALUE/i,
                    "a macro use should not claim one redefinition's replacement text");
                const macroDefinition = position(macroDocument, "#define SCALE_VALUE(item)", "#define ".length);
                const macroHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", macroUri, macroDefinition);
                const macroHoverText = macroHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(macroHoverText,
                    /#define SCALE_VALUE\(item\) \(\(item\) \* 2\)/i,
                    "hover on an exact macro declaration should include its own source text");
                const uniqueMacroHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", macroUri,
                    position(macroDocument, "EMPTY_VALUE()", 1));
                assert.match(uniqueMacroHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                    /#define EMPTY_VALUE\(\)/i,
                    "a macro use with one compiler definition may show its replacement source");
                const multilineMacroHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", macroUri,
                    position(macroDocument, "Print MULTILINE_VALUE(inputValue)", "Print ".length + 2));
                assert.match(multilineMacroHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                    /#define MULTILINE_VALUE\(value\) _[\s\S]*\(\(value\) \+ 2\)/i,
                    "a unique macro hover should retain its bounded continued definition");
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", macroUri, selected);
                assert.equal(references.length, 5);
                const nestedLine = "#define NESTED_SCALE(argument) SCALE_VALUE(argument)";
                const nested = position(macroDocument, nestedLine, nestedLine.indexOf("SCALE_VALUE"));
                const nestedDefinitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", macroUri, nested);
                assert.equal(nestedDefinitions.length, 2, "An unambiguous replacement-list token must navigate to the selected macro lifetime.");
                const nestedEdits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", macroUri, nested, "BODY_MULTIPLY_VALUE");
                assert.equal(nestedEdits.get(macroUri).length, 5);
                assert.ok(nestedEdits.get(macroUri).every((edit) => macroDocument.getText(edit.range) === "SCALE_VALUE"));
                const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", macroUri, position(macroDocument, "Print SCALE_VALUE(inputValue)", "Print SCALE_VALUE(".length));
                assert.equal(signature.signatures[0].parameters[0].label, "item",
                    "signature help should use the parameter name from the active macro redefinition");
                const definedNameHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", macroUri,
                    position(macroDocument, "#if defined(SCALE_VALUE)", "#if defined(".length));
                assert.match(definedNameHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                    /`SCALE_VALUE` is defined in the current compiler context/i);
                const undefinedNameHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", macroUri,
                    position(macroDocument, "#ifndef PREPROCESSOR_INCLUDED", "#ifndef ".length));
                assert.match(undefinedNameHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                    /`PREPROCESSOR_INCLUDED` is not defined in the current compiler context/i);
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", macroUri, selected);
                assert.ok(completions.items.some((item) => item.label === "SCALE_VALUE"));
                const emptyMacroCompletion = completions.items.find((item) => item.label === "EMPTY_VALUE");
                assert.ok(emptyMacroCompletion);
                assert.match(emptyMacroCompletion.documentation?.value || "", /#define EMPTY_VALUE\(\)/i,
                    "completion documentation should include a unique macro's source definition");
                const edits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", macroUri, selected, "MULTIPLY_VALUE");
                assert.equal(edits.get(macroUri).length, 5);
                const parameter = position(macroDocument, "#define SCALE_VALUE(item)", "#define SCALE_VALUE(".length);
                const parameterEdits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", macroUri, parameter, "otherValue");
                assert.equal(parameterEdits.get(macroUri).length, 2);
                assert.ok(parameterEdits.get(macroUri).every((edit) => macroDocument.getText(edit.range) === "item"));
                const qualifiedDeclaration = position(macroDocument, "Const qualifiedValue", "Const ".length);
                const qualifiedQuery = position(macroDocument, "#if defined(MacroQuery.qualifiedValue)", "#if defined(MacroQuery.".length);
                const qualifiedDefinitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", macroUri, qualifiedQuery);
                assert.equal(qualifiedDefinitions.length, 1);
                assert.equal(macroDocument.getText(qualifiedDefinitions[0].range), "qualifiedValue");
                const qualifiedReferences = await vscode.commands.executeCommand("vscode.executeReferenceProvider", macroUri, qualifiedQuery);
                assert.equal(qualifiedReferences.length, 3);
                const qualifiedEdits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", macroUri, qualifiedDeclaration, "renamedQualifiedValue");
                assert.equal(qualifiedEdits.get(macroUri).length, 3);
                assert.ok(qualifiedEdits.get(macroUri).every((edit) => macroDocument.getText(edit.range) === "qualifiedValue"));
                const guardEdits = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", macroUri, position(macroDocument, "#define PREPROCESSOR_INCLUDED", 11), "RENAMED_INCLUDE_GUARD");
                assert.equal(guardEdits.get(macroUri).length, 2);
                const tokens = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", macroUri);
                assert.ok(tokens?.data.length);
                const kinds = [];
                for (let index = 3; index < tokens.data.length; index += 5) kinds.push(tokens.data[index]);
                const { TOKEN_TYPES } = require(path.join(extension.extensionPath, "lib/semantic-features"));
                assert.ok(kinds.includes(TOKEN_TYPES.indexOf("macro")));
                assert.ok(kinds.includes(TOKEN_TYPES.indexOf("parameter")));
                assert.equal(macroDocument.getText(), original);
                assert.equal(fs.readFileSync(macroUri.fsPath, "utf8"), original);
                const broken = new vscode.WorkspaceEdit();
                broken.insert(macroUri, macroDocument.positionAt(original.length), "\nPrint missingMacroValue +\n");
                assert.equal(await vscode.workspace.applyEdit(broken), true);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const recoveryCompletion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", macroUri, position(macroDocument, "missingMacroValue", 3));
                assert.ok(recoveryCompletion.items.some((item) => item.label === "SCALE_VALUE"), "Native macro context must survive a failed expression in the unsaved buffer");
                assert.equal(fs.readFileSync(macroUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(macroDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native directive operand completion retains compiler-active macros", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const macroUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-preprocessor.bas"));
            const macroDocument = await vscode.workspace.openTextDocument(macroUri);
            const original = macroDocument.getText();
            const partial = "#define ACTIVE_VALUE 1\n#define RETIRED_VALUE 1\n#undef RETIRED_VALUE\n#if defined(\nPrint ACTIVE_VALUE\n#endif\n";
            try {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(macroUri, new vscode.Range(macroDocument.positionAt(0), macroDocument.positionAt(original.length)), partial);
                assert.equal(await vscode.workspace.applyEdit(edit), true);
                await vscode.window.showTextDocument(macroDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const completion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", macroUri, new vscode.Position(3, "#if defined(".length));
                const names = completion.items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
                assert.ok(names.includes("ACTIVE_VALUE"));
                assert.ok(!names.includes("RETIRED_VALUE"));
                assert.equal(fs.readFileSync(macroUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(macroDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native directive operand completion retains included compiler macros", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const contextUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-context.bas"));
            const contextDocument = await vscode.workspace.openTextDocument(contextUri);
            const original = contextDocument.getText();
            const partial = "#include once \"compiler-defines.bi\"\n#if defined(\nPrint 1\n#endif\n";
            try {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(contextUri, new vscode.Range(contextDocument.positionAt(0), contextDocument.positionAt(original.length)), partial);
                assert.equal(await vscode.workspace.applyEdit(edit), true);
                await vscode.window.showTextDocument(contextDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const completion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", contextUri, new vscode.Position(1, "#if defined(".length));
                const names = completion.items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
                assert.ok(names.includes("DECLARE_VALUE"));
                assert.equal(fs.readFileSync(contextUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(contextDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native directive operand completion retains skipped included macros", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const contextUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-context.bas"));
            const contextDocument = await vscode.workspace.openTextDocument(contextUri);
            const original = contextDocument.getText();
            const partial = "#include once \"compiler-defines.bi\"\n#if 0\n#if defined(\n#endif\n#endif\n";
            try {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(contextUri, new vscode.Range(contextDocument.positionAt(0), contextDocument.positionAt(original.length)), partial);
                assert.equal(await vscode.workspace.applyEdit(edit), true);
                await vscode.window.showTextDocument(contextDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const completion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", contextUri, new vscode.Position(2, "#if defined(".length));
                const names = completion.items.map((item) => typeof item.label === "string" ? item.label : item.label.label);
                assert.ok(names.includes("DECLARE_VALUE"));
                assert.equal(fs.readFileSync(contextUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(contextDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native recovery retains authoritative independent types and clears unsaved syntax diagnostics", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const recoveryUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-types.bas"));
            const recoveryDocument = await vscode.workspace.openTextDocument(recoveryUri);
            const original = recoveryDocument.getText();
            const partial = "Dim value As Double\nPrint value * 2\nPrint value +\nPrint value * 3\n";
            const replaceBuffer = async (text) => {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(recoveryUri, new vscode.Range(recoveryDocument.positionAt(0), recoveryDocument.positionAt(recoveryDocument.getText().length)), text);
                await applyEditAndWaitForDocuments(edit, [recoveryDocument]);
            };
            try {
                await replaceBuffer(partial);
                const editor = await vscode.window.showTextDocument(recoveryDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const diagnostics = vscode.languages.getDiagnostics(recoveryUri).filter((diagnostic) => diagnostic.source === "fbc (buffer)");
                assert.ok(diagnostics.some((diagnostic) => diagnostic.range.start.line === 2 && diagnostic.code === 9));
                for (const line of [1, 3]) {
                    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", recoveryUri, new vscode.Position(line, 7));
                    assert.match(hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `double`/i);
                }
                editor.selection = new vscode.Selection(2, 6, 2, 13);
                assert.equal(await vscode.commands.executeCommand("freebasic.showExpressionType"), null);
                assert.equal(fs.readFileSync(recoveryUri.fsPath, "utf8"), original);
                const unclosedScope = "Function ActiveValue() As Long\n    Dim insideValue As Long\n    ActiveValue = insideValue\n";
                await replaceBuffer(unclosedScope);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const completion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", recoveryUri, new vscode.Position(2, 22));
                const inside = completion.items.find((item) => item.label === "insideValue");
                assert.match(inside?.detail || "", /provisional recovery/i);
                const scopeHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", recoveryUri, new vscode.Position(2, 22));
                assert.match(scopeHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler recovery declaration \(provisional\)/i);
                const recoveredType = [
                    "Type BrokenType",
                    "    value As Long",
                    "    Declare Function Value() As Long",
                    "End Type",
                    "Function BrokenType.Value() As Long",
                    "    Value = value +",
                    "End Function",
                    "Dim item As BrokenType",
                    "Print item.value",
                    ""
                ].join("\n");
                await replaceBuffer(recoveredType);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const itemHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", recoveryUri, new vscode.Position(7, 5));
                assert.match(itemHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler recovery declaration \(provisional\)/i);
                const memberHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", recoveryUri, new vscode.Position(8, 12));
                assert.match(memberHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler recovery type \(provisional\): `long`/i);
                await replaceBuffer(partial.replace("Print value +\n", "Print value + 1\n"));
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                assert.equal(vscode.languages.getDiagnostics(recoveryUri).filter((diagnostic) => diagnostic.source === "fbc (buffer)").length, 0);
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", recoveryUri, new vscode.Position(3, 7));
                assert.match(hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `double`/i);
            } finally {
                await vscode.window.showTextDocument(recoveryDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native TYPEOF recovery preserves the following unsaved statement", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const recoveryUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-types.bas"));
            const recoveryDocument = await vscode.workspace.openTextDocument(recoveryUri);
            const original = recoveryDocument.getText();
            const incompleteTypeOf = "Dim value As Double\nPrint value * 2\nDim typed As TypeOf(\nPrint value * 3\n";
            try {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(recoveryUri, new vscode.Range(recoveryDocument.positionAt(0), recoveryDocument.positionAt(recoveryDocument.getText().length)), incompleteTypeOf);
                assert.equal(await vscode.workspace.applyEdit(edit), true);
                const editor = await vscode.window.showTextDocument(recoveryDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const diagnostics = vscode.languages.getDiagnostics(recoveryUri).filter((diagnostic) => diagnostic.source === "fbc (buffer)");
                assert.ok(diagnostics.some((diagnostic) => diagnostic.range.start.line === 2 && diagnostic.code === 9));
                const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", recoveryUri, new vscode.Position(3, 7));
                assert.match(hover.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n"), /Compiler type: `double`/i);
                editor.selection = new vscode.Selection(3, 6, 3, 15);
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "double");
                assert.equal(fs.readFileSync(recoveryUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(recoveryDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("native LEN, SIZEOF, PEEK, and PROCPTR recovery preserve the following unsaved statement", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const recoveryUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-types.bas"));
            const recoveryDocument = await vscode.workspace.openTextDocument(recoveryUri);
            const original = recoveryDocument.getText();
            try {
                for (const { incomplete, diagnosticCode } of [
                    { incomplete: "Print Len(", diagnosticCode: 9 },
                    { incomplete: "Print SizeOf(", diagnosticCode: 9 },
                    { incomplete: "Print Peek(", diagnosticCode: 9 },
                    { incomplete: "Print ProcPtr(", diagnosticCode: 14 }
                ]) {
                    const text = `Dim value As Double\nPrint value * 2\n${incomplete}\nPrint value * 3\n`;
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(recoveryUri, new vscode.Range(recoveryDocument.positionAt(0), recoveryDocument.positionAt(recoveryDocument.getText().length)), text);
                    assert.equal(await vscode.workspace.applyEdit(edit), true);
                    const editor = await vscode.window.showTextDocument(recoveryDocument);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                    const diagnostics = vscode.languages.getDiagnostics(recoveryUri).filter((diagnostic) => diagnostic.source === "fbc (buffer)");
                    assert.ok(diagnostics.some((diagnostic) => diagnostic.range.start.line === 2 && diagnostic.code === diagnosticCode), incomplete);
                    const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", recoveryUri, new vscode.Position(3, 7));
                    assert.match(hover.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n"), /Compiler type: `double`/i, incomplete);
                    editor.selection = new vscode.Selection(3, 6, 3, 15);
                    assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "double", incomplete);
                }
                assert.equal(fs.readFileSync(recoveryUri.fsPath, "utf8"), original);
            } finally {
                await vscode.window.showTextDocument(recoveryDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("explicit UDT constructors retain native result types and members", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const constructorUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-types.bas"));
            const constructorDocument = await vscode.workspace.openTextDocument(constructorUri);
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            try {
                const editor = await vscode.window.showTextDocument(constructorDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const constructor = position(constructorDocument, "WrappedValue(5)");
                editor.selection = new vscode.Selection(constructor, constructor.translate(0, "WrappedValue(5)".length));
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "wrappedvalue");
                const constructorHovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", constructorUri,
                    constructor.translate(0, 1));
                assert.match(constructorHovers.flatMap((entry) => entry.contents.map((content) => content.value)).join("\n"),
                    /Constructor WrappedValue\(ByVal source As Long\)/i,
                    "native hover on the type-call callee should show its constructor signature");
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", constructorUri, position(constructorDocument, "WrappedValue(5).value", "WrappedValue(5).".length));
                assert.ok(completions.items.some((item) => item.label === "value"));
                const constructorCallCompletions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", constructorUri,
                    position(constructorDocument, "New WrappedValue(5)", "New WrappedValue".length));
                const constructorItem = constructorCallCompletions.items.find((item) => item.label === "WrappedValue" &&
                    item.kind !== vscode.CompletionItemKind.Text);
                const constructorSnippet = typeof constructorItem?.insertText === "string"
                    ? constructorItem.insertText : constructorItem?.insertText?.value;
                assert.equal(constructorSnippet, "WrappedValue",
                    "native constructor completion must preserve its written argument list");
            } finally {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
            }
        });
        await check("native NEW Signature Help upgrades to the compiler-selected constructor binding", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const constructorUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-constructor-overloads.bas"));
            const constructorDocument = await vscode.workspace.openTextDocument(constructorUri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(constructorDocument);
                const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", constructorUri,
                    position(constructorDocument, "New ConstructorChoice(CDbl(5))", "New ConstructorChoice(".length));
                assert.equal(signature?.signatures.length, 1, JSON.stringify({
                    analysisRun: configuration.get("analysis.run", "onDemand"),
                    activeSignature: signature?.activeSignature,
                    signatures: signature?.signatures.map((entry) => entry.label)
                }));
                assert.match(signature.signatures[0].label, /Constructor ConstructorChoice\(ByVal source As Double\)/i);
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
            }
        });
        await check("native constructor references include selected NEW calls", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
            const constructorUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-constructor-overloads.bas"));
            const constructorDocument = await vscode.workspace.openTextDocument(constructorUri);
            try {
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(constructorDocument);
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", constructorUri,
                    position(constructorDocument, "Declare Constructor(ByVal source As Double)", "Declare ".length));
                const lines = new Set(references.map((entry) => entry.range.start.line));
                const doubleNewLine = position(constructorDocument, "New ConstructorChoice(CDbl(5))").line;
                const longNewLine = position(constructorDocument, "New ConstructorChoice(5)").line;
                assert.ok(lines.has(doubleNewLine),
                    `constructor references should include the matching NEW call: ${JSON.stringify(references.map((entry) => [entry.range.start.line, entry.range.start.character, entry.range.end.character]))}`);
                assert.equal(lines.has(longNewLine), false, "constructor references should exclude the sibling overload's NEW call");
                const highlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", constructorUri,
                    position(constructorDocument, "New ConstructorChoice(CDbl(5))", "New ".length));
                const highlightedLines = new Set(highlights.map((entry) => entry.range.start.line));
                assert.ok(highlightedLines.has(doubleNewLine));
                assert.equal(highlightedLines.has(longNewLine), false,
                    "constructor highlights should exclude a sibling overload's NEW call");
            } finally {
                await configuration.update("analysis.compilerPath", previousCompiler, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
            }
        });
        await check("custom FreeBASIC header language modes feed unsaved native types and explicit contexts", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run", "compiler.arguments", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "fb-custom-header-"));
            const filePath = path.join(directory, "main.bas"), headerPath = path.join(directory, "types.inc");
            const source = '#include "types.inc"\nDim nativeValue As ModeHeaderValue\nPrint nativeValue\n';
            const diskHeader = "Type ModeHeaderValue As Long\n";
            let header;
            try {
                fs.writeFileSync(filePath, source);
                fs.writeFileSync(headerPath, diskHeader);
                for (const [name, value] of [["analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE], ["compiler.arguments", []],
                    ["analysis.run", "onDemand"], ["diagnostics.run", "off"], ["analysis.projectContexts", [{ name: "custom", modules: [filePath] }]],
                    ["analysis.activeContext", { name: "custom", module: filePath }]]) {
                    await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                }
                header = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath)), "freebasic");
                await vscode.window.showTextDocument(header);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                const typeText = async () => {
                    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", current.uri, position(current, "Print nativeValue", 7));
                    return hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                };
                const edit = new vscode.WorkspaceEdit();
                edit.replace(header.uri, new vscode.Range(position(header, "Long"), position(header, "Long", 4)), "Double");
                await applyEditAndWaitForDocuments(edit, [header]);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true, "an explicit custom-header request uses its selected module");
                assert.match(await typeText(), /compiler type.*double/i, "the root must use the unsaved custom-header type");
                assert.equal(header.isDirty, true);
                const restore = new vscode.WorkspaceEdit();
                restore.replace(header.uri, new vscode.Range(position(header, "Double"), position(header, "Double", 6)), "Long");
                await applyEditAndWaitForDocuments(restore, [header]);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                assert.match(await typeText(), /compiler type.*long/i, "a second header edit must replace the captured type");
                assert.equal(fs.readFileSync(filePath, "utf8"), source);
                assert.equal(fs.readFileSync(headerPath, "utf8"), diskHeader);
            } finally {
                if (header && !header.isClosed && header.getText() !== diskHeader) {
                    const restore = new vscode.WorkspaceEdit();
                    restore.replace(header.uri, new vscode.Range(header.positionAt(0), header.positionAt(header.getText().length)), diskHeader);
                    await applyEditAndWaitForDocuments(restore, [header]);
                }
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("unsaved modules and headers feed native expression types without disk writes", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "compiler-context", modules: ["compiler-context.bas"] }], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", { name: "compiler-context", module: "compiler-context.bas" }, vscode.ConfigurationTarget.Global);
            const compilerUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-context.bas"));
            const headerUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-defines.bi"));
            const compilerDocument = await vscode.workspace.openTextDocument(compilerUri);
            const header = await vscode.workspace.openTextDocument(headerUri);
            const sourceBefore = compilerDocument.getText();
            const headerBefore = header.getText();
            try {
                const changes = new vscode.WorkspaceEdit();
                changes.replace(compilerUri, new vscode.Range(compilerDocument.positionAt(0), compilerDocument.positionAt(sourceBefore.length)), sourceBefore.replace(/selected\.(primaryValue|alternateValue)/g, "selected + 1"));
                const headerAfter = `${headerBefore.replace("name As SelectedType", "name As Double")}\n#if 1 + 2 = 3\n#assert 1 + 2 = 3\n#endif\nType SemanticSidecarProbe\n    precise As Double\nEnd Type\nSub SemanticSidecarCheck()\n    Dim checkedValue As SemanticSidecarProbe\n    #assert typeof(checkedValue.precise) = typeof(Double)\nEnd Sub\n`;
                changes.replace(headerUri, new vscode.Range(header.positionAt(0), header.positionAt(headerBefore.length)), headerAfter);
                await applyEditAndWaitForDocuments(changes, [compilerDocument, header]);
                assert.equal(compilerDocument.isDirty, true);
                assert.equal(header.isDirty, true);
                const editor = await vscode.window.showTextDocument(compilerDocument);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const start = position(compilerDocument, "selected + 1");
                editor.selection = new vscode.Selection(start, start.translate(0, "selected + 1".length));
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "double");
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", compilerUri, start.translate(0, 1));
                assert.match(hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `double`/i);
                for (const [directive, offset] of [["#if 1 + 2 = 3", 4], ["#assert 1 + 2 = 3", 8]]) {
                    const directiveHovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", headerUri, position(header, directive, offset));
                    assert.match(directiveHovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `integer`/i);
                }
                const nestedDirective = "    #assert typeof(checkedValue.precise) = typeof(Double)";
                const nestedMember = position(header, nestedDirective, nestedDirective.indexOf("checkedValue.precise"));
                const nestedHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", headerUri, nestedMember);
                assert.match(nestedHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `double`/i);
                const typeofHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", headerUri, position(header, nestedDirective, nestedDirective.indexOf("typeof")));
                assert.match(typeofHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `zstring`/i);
                const comparisonHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", headerUri, position(header, nestedDirective, nestedDirective.indexOf(" = ") + 1));
                assert.match(comparisonHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `integer`/i);
                const partialSource = `${compilerDocument.getText()}Print (\n`;
                const partialEdit = new vscode.WorkspaceEdit();
                partialEdit.replace(compilerUri, new vscode.Range(compilerDocument.positionAt(0), compilerDocument.positionAt(compilerDocument.getText().length)), partialSource);
                await applyEditAndWaitForDocuments(partialEdit, [compilerDocument]);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const partialDiagnostics = vscode.languages.getDiagnostics(compilerUri).filter((diagnostic) => diagnostic.source === "fbc (buffer)");
                assert.ok(partialDiagnostics.length, "the intentionally incomplete root module must retain its parser diagnostic");
                const partialDirectiveHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", headerUri, position(header, "#if 1 + 2 = 3", 4));
                const partialDirectiveText = partialDirectiveHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(partialDirectiveText,
                    /Compiler recovery type \(provisional\): `integer`/i,
                    "compiler-typed unsaved header directives should survive an unrelated root-buffer syntax error: " + JSON.stringify(partialDirectiveText));
                assert.equal(fs.readFileSync(compilerUri.fsPath, "utf8"), sourceBefore);
                assert.equal(fs.readFileSync(headerUri.fsPath, "utf8"), headerBefore);
            } finally {
                for (const dirty of [header, compilerDocument]) {
                    await vscode.window.showTextDocument(dirty);
                    await vscode.commands.executeCommand("workbench.action.files.revert");
                }
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
            }
        });
        await check("repeated include type conflicts explain compiler context alternatives", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "ambiguous-context", modules: ["ambiguous-context.bas"] }], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", { name: "ambiguous-context", module: "ambiguous-context.bas" }, vscode.ConfigurationTarget.Global);
            const moduleUri = vscode.Uri.file(path.join(__dirname, "workspace/ambiguous-context.bas"));
            const headerUri = vscode.Uri.file(path.join(__dirname, "workspace/ambiguous-context.bi"));
            const module = await vscode.workspace.openTextDocument(moduleUri);
            const header = await vscode.workspace.openTextDocument(headerUri);
            const moduleBefore = module.getText();
            const headerBefore = header.getText();
            try {
                await vscode.window.showTextDocument(module);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", headerUri,
                    position(header, "Print context_value", "Print ".length));
                const markdown = hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(markdown, /depends on the include instance/i);
                assert.match(markdown, /`integer`/i);
                assert.match(markdown, /`string`/i);
                assert.match(markdown, /ambiguous-context\.bas:7/i);
                assert.match(markdown, /ambiguous-context\.bas:9/i);
                assert.equal(fs.readFileSync(moduleUri.fsPath, "utf8"), moduleBefore);
                assert.equal(fs.readFileSync(headerUri.fsPath, "utf8"), headerBefore);
            } finally {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
            }
        });
        await check("manual checks honor selected contexts for saved modules and headers", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "compiler.path", "compiler.arguments", "analysis.run", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-manual-context-check-"));
            const sourcePath = path.join(directory, "main.bas"), headerPath = path.join(directory, "context.bi");
            const source = '#include once "context.bi"\nPrint contextCheckValue\n';
            const header = "#ifndef FB_VSCODE_SELECTED_CHECK_CONTEXT\n#error FB_VSCODE_SELECTED_CHECK_CONTEXT must be defined\n#endif\nDim Shared contextCheckValue As Long\n";
            try {
                fs.writeFileSync(sourcePath, source);
                fs.writeFileSync(headerPath, header);
                const compiler = process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE;
                const { runFreeBasicCompiler } = require(path.join(extension.extensionPath, "lib/compiler-diagnostics"));
                const ordinary = await runFreeBasicCompiler({ compilerPath: compiler, filePath: sourcePath });
                assert.equal(ordinary.exitCode, 1, "the fixture must fail without its selected build define");
                assert.match(ordinary.output, /FB_VSCODE_SELECTED_CHECK_CONTEXT must be defined/);
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", compiler, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{
                    name: "selected-manual-check", modules: [sourcePath],
                    arguments: ["-d", "FB_VSCODE_SELECTED_CHECK_CONTEXT"]
                }], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", {
                    name: "selected-manual-check", module: sourcePath
                }, vscode.ConfigurationTarget.Global);
                const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                const headerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
                for (const bridge of [process.env.FBC_EDITOR_EXECUTABLE, ""]) {
                    await configuration.update("analysis.compilerPath", bridge, vscode.ConfigurationTarget.Global);
                    for (const current of [sourceDocument, headerDocument]) {
                        await vscode.window.showTextDocument(current);
                        assert.equal(current.isDirty, false);
                        const result = await vscode.commands.executeCommand("freebasic.checkSyntax");
                        if (bridge) assert.equal(result, true);
                        else assert.equal(result.exitCode, 0,
                            "ordinary FBC must use selected flags and the header's root without requiring the editor bridge");
                        for (const checked of [sourceDocument, headerDocument]) {
                            assert.equal(vscode.languages.getDiagnostics(checked.uri).some((diagnostic) =>
                                /^fbc/.test(diagnostic.source || "") && diagnostic.severity === vscode.DiagnosticSeverity.Error
                            ), false, "the unselected build's missing-define error must not leak into selected-context diagnostics");
                        }
                    }
                }
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
                assert.equal(fs.readFileSync(headerPath, "utf8"), header);
                await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "onSave", vscode.ConfigurationTarget.Global);
                const savedModule = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(savedModule);
                const appended = "\n#ifdef FB_VSCODE_SELECTED_CHECK_CONTEXT\n#error FB_VSCODE_SAVE_CONTEXT_USED\n#endif\n";
                const saveEdit = new vscode.WorkspaceEdit();
                saveEdit.insert(savedModule.uri, savedModule.positionAt(source.length), appended);
                await applyEditAndWaitForDocuments(saveEdit, [savedModule]);
                assert.equal(await savedModule.save(), true);
                await waitForDiagnostics(savedModule.uri, (diagnostics) => diagnostics.some((diagnostic) =>
                    diagnostic.source === "fbc" && diagnostic.message.includes("FB_VSCODE_SAVE_CONTEXT_USED")
                ), "the save handler must use the same selected define as manual checks");
                assert.equal(vscode.languages.getDiagnostics(headerDocument.uri).some((diagnostic) =>
                    diagnostic.source === "fbc" && diagnostic.message.includes("must be defined")
                ), false, "saving must not fall back to global compiler arguments");
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source + appended);
            } finally {
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("context changes retract saved and buffer diagnostics with analysis disabled", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "compiler.path", "compiler.arguments", "analysis.run", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-context-diagnostics-"));
            const sourcePath = path.join(directory, "main.bas");
            try {
                fs.writeFileSync(sourcePath, "#ifdef FB_VSCODE_CONTEXT_ERROR\n#error FB_VSCODE_OBSOLETE_CONTEXT\n#endif\nDim contextValue As Long\n");
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(current);
                await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [
                    { name: "errors", modules: [sourcePath], arguments: ["-d", "FB_VSCODE_CONTEXT_ERROR"] },
                    { name: "clean", modules: [sourcePath] }
                ], vscode.ConfigurationTarget.Global);
                for (const bridge of [process.env.FBC_EDITOR_EXECUTABLE, ""]) {
                    await configuration.update("analysis.compilerPath", bridge, vscode.ConfigurationTarget.Global);
                    await configuration.update("analysis.activeContext", { name: "errors", module: sourcePath }, vscode.ConfigurationTarget.Global);
                    const result = await vscode.commands.executeCommand("freebasic.checkSyntax");
                    if (bridge) assert.equal(result, true);
                    else assert.equal(result.exitCode, 1);
                    await waitForDiagnostics(current.uri, (diagnostics) => diagnostics.some((diagnostic) =>
                        diagnostic.source === (bridge ? "fbc (buffer)" : "fbc") && diagnostic.message.includes("FB_VSCODE_OBSOLETE_CONTEXT")
                    ), "the failing build must publish its compiler diagnostic");
                    await configuration.update("analysis.activeContext", { name: "clean", module: sourcePath }, vscode.ConfigurationTarget.Global);
                    await waitForDiagnostics(current.uri, (diagnostics) => !diagnostics.some((diagnostic) => /^fbc/.test(diagnostic.source || "")),
                        "context switching must retract old errors without requiring another compiler run");
                }
            } finally {
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("selected contexts drive include completion, source navigation, and compiler search order", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.projectContexts", "analysis.activeContext", "analysis.run",
                "compiler.path", "compiler.arguments", "includePaths", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-context-include-editor-"));
            const write = (name, text) => {
                const file = path.join(directory, name);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, text);
                return file;
            };
            const sourcePath = write("app/main.bas", '#include "../shared/api.bi"\nPrint fbVscodeSelectedIncludeValue\n');
            const headerPath = write("shared/api.bi", '#include once "root-neighbor.bi"\n#include once "selected-api.bi"\n');
            const rootNeighbor = write("app/root-neighbor.bi", "Const fbVscodeRootNeighbor = 9\n");
            const completionPath = write("shared/completion.bi", '#include "fb-vscode-context-"\n');
            write("app/base/common.bi", "");
            write("shared/context-first/fb-vscode-context-wrong.bi", "");
            for (const [name, value] of [["first", 1], ["second", 2]]) {
                write(`app/context-${name}/selected-api.bi`, `Const fbVscodeSelectedIncludeValue = ${value}\n`);
                write(`app/context-${name}/fb-vscode-context-${name}.bi`, "");
            }
            try {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", ["-i", "base"], vscode.ConfigurationTarget.Global);
                await configuration.update("includePaths", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", ["first", "second"].map((name) => ({
                    name, modules: [sourcePath], arguments: ["-i", `context-${name}`]
                })), vscode.ConfigurationTarget.Global);
                const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                const headerDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
                const completionDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(completionPath));
                for (const name of ["first", "second"]) {
                    await configuration.update("analysis.activeContext", { name, module: sourcePath }, vscode.ConfigurationTarget.Global);
                    const selectedPath = path.join(directory, `app/context-${name}/selected-api.bi`);
                    await vscode.window.showTextDocument(headerDocument);
                    const links = await waitForDocumentLinks(headerDocument.uri);
                    assert.equal(links.length, 2);
                    assert.ok(links.some((link) => link.target.fsPath === rootNeighbor), "header lookup must check the root module's working directory");
                    assert.ok(links.some((link) => link.target.fsPath === selectedPath), "relative -i options belong to the selected root, not the header");
                    await vscode.window.showTextDocument(completionDocument);
                    const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", completionDocument.uri,
                        position(completionDocument, "fb-vscode-context-", "fb-vscode-context-".length));
                    assert.ok(completions.items.some((item) => item.label === `fb-vscode-context-${name}.bi`));
                    assert.equal(completions.items.some((item) => item.label === "fb-vscode-context-wrong.bi" ||
                        item.label === `fb-vscode-context-${name === "first" ? "second" : "first"}.bi`), false);
                    await vscode.window.showTextDocument(sourceDocument);
                    const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", sourceDocument.uri,
                        position(sourceDocument, "Print fbVscodeSelectedIncludeValue", "Print fb".length));
                    assert.equal(definitions.length, 1, "source include caches must refresh after a build-context switch");
                    assert.equal(definitions[0].uri.fsPath, selectedPath);
                    const result = await vscode.commands.executeCommand("freebasic.checkSyntax");
                    assert.equal(result.exitCode, 0);
                    assert.equal(result.diagnosticSourcesComplete, true);
                    assert.ok(result.diagnosticSources.some((file) => path.resolve(path.dirname(sourcePath), file) === selectedPath),
                        "the source fallback and the real compiler must select the same header");
                    await vscode.window.showTextDocument(headerDocument);
                    assert.equal((await vscode.commands.executeCommand("freebasic.checkSyntax")).exitCode, 0);
                }
            } finally {
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("PATH compilers provide bundled include completion and source links without configured include paths", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.activeContext", "analysis.run", "compiler.path", "compiler.arguments", "includePaths", "diagnostics.run"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const previousPath = process.env.PATH;
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-path-includes-editor-"));
            const toolchainDirectory = path.join(directory, "toolchain");
            const executableDirectory = path.join(toolchainDirectory, "bin");
            const sourcePath = path.join(directory, "main.bas");
            try {
                const compilerDirectory = path.dirname(fs.realpathSync(process.env.FBC_EXECUTABLE));
                const headerDirectory = [
                    ...(process.env.FREEBASIC_ROOT ? [path.join(process.env.FREEBASIC_ROOT, "inc")] : []),
                    path.resolve(compilerDirectory, "../include/freebasic"), path.resolve(compilerDirectory, "../inc"),
                    path.resolve(compilerDirectory, "inc")
                ].find((candidate) => fs.existsSync(path.join(candidate, "fbgfx.bi")));
                assert.ok(headerDirectory, "this fixture needs the current compiler's bundled headers");
                fs.mkdirSync(executableDirectory, { recursive: true });
                fs.copyFileSync(process.env.FBC_EXECUTABLE, path.join(executableDirectory, "fbc"));
                fs.chmodSync(path.join(executableDirectory, "fbc"), 0o755);
                fs.mkdirSync(path.join(toolchainDirectory, "include"));
                fs.symlinkSync(headerDirectory, path.join(toolchainDirectory, "include/freebasic"), "dir");
                process.env.PATH = executableDirectory + path.delimiter + (previousPath || "");
                fs.writeFileSync(sourcePath, '#include once "fbgf"\n');
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", "fbc", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("includePaths", [], vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                await vscode.window.showTextDocument(current);
                const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                    position(current, "fbgf", "fbgf".length));
                const completion = completions.items.find((item) => item.label === "fbgfx.bi");
                assert.ok(completion, "bundled headers must be available with only the default compiler command on PATH");
                const edit = new vscode.WorkspaceEdit();
                edit.replace(current.uri, completion.range, completion.insertText);
                await applyEditAndWaitForDocuments(edit, [current]);
                assert.equal(await current.save(), true);
                const links = await waitForDocumentLinks(current.uri);
                assert.equal(links.length, 1);
                assert.equal(links[0].target.fsPath, path.join(toolchainDirectory, "include/freebasic/fbgfx.bi"));
                const result = await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(result.exitCode, 0);
                assert.equal(result.diagnosticSourcesComplete, true);
                assert.ok(result.diagnosticSources.some((file) => fs.realpathSync(path.resolve(path.dirname(sourcePath), file)) ===
                    fs.realpathSync(links[0].target.fsPath)),
                    "source-only navigation must agree with the PATH compiler's physical header inventory");

                const sdkDirectory = path.join(directory, "custom sdk");
                const sdkHeader = path.join(sdkDirectory, "include/freebasic/fb-vscode-prefix-only.bi");
                fs.mkdirSync(path.dirname(sdkHeader), { recursive: true });
                fs.writeFileSync(sdkHeader, "Const fbVscodePrefixValue = 17\n");
                await configuration.update("compiler.arguments", ["-prefix", "custom sdk"], vscode.ConfigurationTarget.Global);
                const prefixSource = '#include once "fb-vscode-prefix-"\nPrint fbVscodePrefixValue\n';
                const prefixEdit = new vscode.WorkspaceEdit();
                prefixEdit.replace(current.uri, new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)), prefixSource);
                await applyEditAndWaitForDocuments(prefixEdit, [current]);
                const prefixCompletions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", current.uri,
                    position(current, "fb-vscode-prefix-", "fb-vscode-prefix-".length));
                const prefixCompletion = prefixCompletions.items.find((item) => item.label === "fb-vscode-prefix-only.bi");
                assert.ok(prefixCompletion, "a relative -prefix with spaces must select its own SDK headers");
                const completedPrefixEdit = new vscode.WorkspaceEdit();
                completedPrefixEdit.replace(current.uri, prefixCompletion.range, prefixCompletion.insertText);
                await applyEditAndWaitForDocuments(completedPrefixEdit, [current]);
                assert.equal(await current.save(), true);
                const prefixLinks = await waitForDocumentLinks(current.uri);
                assert.equal(prefixLinks.length, 1);
                assert.equal(prefixLinks[0].target.fsPath, sdkHeader);
                const prefixResult = await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(prefixResult.exitCode, 0);
                assert.equal(prefixResult.diagnosticSourcesComplete, true);
                assert.ok(prefixResult.diagnosticSources.some((file) => path.resolve(path.dirname(sourcePath), file) === sdkHeader));
            } finally {
                if (previousPath === undefined) delete process.env.PATH;
                else process.env.PATH = previousPath;
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("newly opened headers replace compiler-reported missing include snapshots", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const settings = ["analysis.compilerPath", "analysis.activeContext", "analysis.run", "diagnostics.run", "compiler.path", "compiler.arguments", "includePaths"];
            const previous = settings.map((name) => [name, configuration.get(name)]);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-new-include-editor-"));
            const sourcePath = path.join(directory, "main.bas"), headerPath = path.join(directory, "appeared.bi");
            const source = '#include "appeared.bi"\nPrint includedValue\n';
            try {
                fs.writeFileSync(sourcePath, source);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("includePaths", [], vscode.ConfigurationTarget.Global);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
                const editor = await vscode.window.showTextDocument(current);
                const version = current.version;
                assert.equal((await vscode.commands.executeCommand("freebasic.checkSyntax")).exitCode, 1);
                await waitForDiagnostics(current.uri, (diagnostics) => diagnostics.some((diagnostic) =>
                    diagnostic.source === "fbc" && diagnostic.code === 23), "the saved-file check must report the missing header too");
                await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                await waitForDiagnostics(current.uri, (diagnostics) => diagnostics.some((diagnostic) =>
                    diagnostic.source === "fbc (buffer)" && diagnostic.code === 23), "the initial compiler snapshot must report the missing include");
                fs.writeFileSync(headerPath, "Dim includedValue As Double\n");
                await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
                await waitForDiagnostics(current.uri, (diagnostics) => !diagnostics.some((diagnostic) =>
                    /^fbc/.test(diagnostic.source || "") && diagnostic.code === 23), "opening the new header must retract obsolete saved and buffer missing-file errors");
                await vscode.window.showTextDocument(current);
                const start = position(current, "Print includedValue", "Print ".length);
                editor.selection = new vscode.Selection(start, start.translate(0, "includedValue".length));
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "double");
                assert.equal(current.version, version);
                assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
            } finally {
                for (const [name, value] of previous) await configuration.update(name, value, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("selected header contexts change native types and retain all-build rename validation", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const modules = ["project-implementation.bas", "project-caller.bas"];
            const headerUri = vscode.Uri.file(path.join(__dirname, "workspace/project-api.bi"));
            const header = await vscode.workspace.openTextDocument(headerUri);
            const original = header.getText();
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "normal", modules }, { name: "double", modules, arguments: ["-d", "PROJECT_DOUBLE"] }], vscode.ConfigurationTarget.Global);
            try {
                const changes = new vscode.WorkspaceEdit();
                changes.insert(headerUri, header.positionAt(original.length), "\nFunction HeaderValue(ByVal headerInput As ProjectNumber) As ProjectNumber\n Return headerInput\nEnd Function\n");
                assert.equal(await vscode.workspace.applyEdit(changes), true);
                const editor = await vscode.window.showTextDocument(header);
                for (const [name, module, expected] of [["double", "project-caller.bas", "double"], ["normal", "project-implementation.bas", "long"]]) {
                    await configuration.update("analysis.activeContext", { name, module }, vscode.ConfigurationTarget.Global);
                    assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                    const input = position(header, "Return headerInput", 7);
                    editor.selection = new vscode.Selection(input, input.translate(0, 11));
                    assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), expected);
                    const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", headerUri, input);
                    assert.equal(definitions.length, 1);
                    assert.equal(definitions[0].uri.toString(), headerUri.toString());
                    assert.match(header.lineAt(definitions[0].range.start.line).text, /Function HeaderValue/);
                    const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", headerUri, position(header, "AdjustProjectValue", 3), "ScaleProjectValue");
                    assert.equal(edit.entries().length, 3);
                    assert.ok(edit.entries().every(([, edits]) => edits.length === 1 && edits[0].newText === "ScaleProjectValue"));
                }
                assert.equal(fs.readFileSync(headerUri.fsPath, "utf8"), original);
                assert.equal(header.isDirty, true);
            } finally {
                await vscode.window.showTextDocument(header);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("project rename validates two modules and two configurations before preview", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const modules = ["project-implementation.bas", "project-caller.bas"];
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "normal", modules }, { name: "double", modules, arguments: ["-d", "PROJECT_DOUBLE"] }], vscode.ConfigurationTarget.Global);
            const callerUri = vscode.Uri.file(path.join(__dirname, "workspace/project-caller.bas"));
            const caller = await vscode.workspace.openTextDocument(callerUri);
            await vscode.window.showTextDocument(caller);
            try {
                const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", callerUri, position(caller, "Print AdjustProjectValue", 8), "ScaleProjectValue");
                const files = edit.entries();
                assert.equal(files.length, 3);
                assert.ok(files.every(([, edits]) => edits.length === 1 && edits[0].newText === "ScaleProjectValue"));
                assert.equal(caller.isDirty, false, "Provider must return a preview, not apply edits itself");
            } finally {
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("project type rename preserves selected argument constructors", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const modules = ["argument-constructor-implementation.bas", "argument-constructor.bas"];
            const apiUri = vscode.Uri.file(path.join(__dirname, "workspace", "argument-constructor-api.bi"));
            const sourceFiles = [apiUri, ...modules.map((module) => vscode.Uri.file(path.join(__dirname, "workspace", module)))];
            const originals = new Map(sourceFiles.map((file) => [file.fsPath, fs.readFileSync(file.fsPath, "utf8")]));
            const api = await vscode.workspace.openTextDocument(apiUri);
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "argument-constructor", modules }], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", { name: "argument-constructor", module: modules[1] }, vscode.ConfigurationTarget.Global);
            try {
                await vscode.window.showTextDocument(api);
                const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", apiUri, position(api, "Type ArgumentTarget", 7), "RenamedArgumentTarget");
                assert.equal(edit.entries().length, 2);
                const edits = edit.entries().flatMap(([, entries]) => entries);
                assert.equal(edits.length, 5, "the header type and formal parameter plus constructor and implementation declarations should be renamed");
                assert.ok(edits.every((entry) => entry.newText === "RenamedArgumentTarget"));
                assert.equal(api.isDirty, false, "project rename should return a preview without applying it");
                for (const [file, text] of originals) assert.equal(fs.readFileSync(file, "utf8"), text);
            } finally {
                await vscode.window.showTextDocument(api);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("project rename joins conditional property accessors across build contexts", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const modules = ["conditional-property-implementation.bas", "conditional-property-caller.bas"];
            const sourceFiles = [
                "conditional-property-api.bi",
                "conditional-property-implementation.bas",
                "conditional-property-caller.bas"
            ].map((name) => vscode.Uri.file(path.join(__dirname, "workspace", name)));
            const originals = new Map(sourceFiles.map((file) => [file.fsPath, fs.readFileSync(file.fsPath, "utf8")]));
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [
                { name: "normal", modules },
                { name: "alternate", modules, arguments: ["-d", "ALTERNATE"] }
            ], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", { name: "normal", module: modules[1] }, vscode.ConfigurationTarget.Global);
            const callerUri = sourceFiles[2];
            const caller = await vscode.workspace.openTextDocument(callerUri);
            const locations = (edit) => edit.entries().flatMap(([file, edits]) => edits.map((entry) => [
                path.basename(file.fsPath), entry.range.start.line, entry.newText
            ])).sort(([leftFile, leftLine], [rightFile, rightLine]) => leftFile.localeCompare(rightFile) || leftLine - rightLine);
            try {
                await vscode.window.showTextDocument(caller);
                const getter = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", callerUri, position(caller, "currentMeter.CurrentValue", 13), "ReadingValue");
                assert.deepEqual(locations(getter), [
                    ["conditional-property-api.bi", 10, "ReadingValue"],
                    ["conditional-property-api.bi", 13, "ReadingValue"],
                    ["conditional-property-caller.bas", 9, "ReadingValue"],
                    ["conditional-property-implementation.bas", 9, "ReadingValue"],
                    ["conditional-property-implementation.bas", 16, "ReadingValue"]
                ]);

                const setter = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", callerUri, position(caller, "currentMeter.CurrentValue = 2", 13), "WriteValue");
                assert.deepEqual(locations(setter), [
                    ["conditional-property-api.bi", 11, "WriteValue"],
                    ["conditional-property-api.bi", 14, "WriteValue"],
                    ["conditional-property-caller.bas", 10, "WriteValue"],
                    ["conditional-property-implementation.bas", 12, "WriteValue"],
                    ["conditional-property-implementation.bas", 19, "WriteValue"]
                ]);

                await configuration.update("analysis.activeContext", { name: "alternate", module: modules[1] }, vscode.ConfigurationTarget.Global);
                const alternate = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", callerUri, position(caller, "currentMeter.CurrentValue", 13), "ReadAlternate");
                assert.deepEqual(locations(alternate), [
                    ["conditional-property-api.bi", 10, "ReadAlternate"],
                    ["conditional-property-api.bi", 13, "ReadAlternate"],
                    ["conditional-property-caller.bas", 9, "ReadAlternate"],
                    ["conditional-property-implementation.bas", 9, "ReadAlternate"],
                    ["conditional-property-implementation.bas", 16, "ReadAlternate"]
                ]);
                assert.ok(sourceFiles.every((file) => fs.readFileSync(file.fsPath, "utf8") === originals.get(file.fsPath)));
                assert.equal(caller.isDirty, false);
            } finally {
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("project rename handles QB label grammar and converts supported numeric labels", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const modules = ["compiler-labels.bas"];
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.projectContexts", [{ name: "numeric-label", modules, arguments: ["-lang", "qb"] }], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.activeContext", { name: "numeric-label", module: "compiler-labels.bas" }, vscode.ConfigurationTarget.Global);
            const labelUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-labels.bas"));
            const label = await vscode.workspace.openTextDocument(labelUri);
            const original = label.getText();
            const labelPosition = position(label, "&H10", 1);
            await vscode.window.showTextDocument(label);
            try {
                const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", labelUri, labelPosition, "&H11");
                const edits = edit.get(labelUri);
                assert.equal(edits.length, 5);
                assert.ok(edits.every((entry) => label.getText(entry.range) === "&H10"));
                assert.ok(edits.every((entry) => entry.newText === "&H11"));
                const namedLabelEdit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", labelUri, labelPosition, "finished");
                const namedLabelEdits = namedLabelEdit.get(labelUri);
                assert.equal(namedLabelEdits.length, 5);
                assert.ok(namedLabelEdits.every((entry) => label.getText(entry.range) === "&H10"));
                const namedBranch = namedLabelEdits.find((entry) => entry.newText === "Goto finished");
                assert.ok(namedBranch, "A named single-line IF branch must receive an explicit GOTO.");
                assert.ok(namedLabelEdits.filter((entry) => entry !== namedBranch).every((entry) => entry.newText === "finished" || entry.newText === "finished:"));
                const directLabel = position(label, "&H30", 1);
                const directLabelEdit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", labelUri, directLabel, "finished");
                const directLabelEdits = directLabelEdit.get(labelUri);
                assert.equal(directLabelEdits.length, 2);
                assert.ok(directLabelEdits.every((entry) => label.getText(entry.range) === "&H30"));
                assert.equal(directLabelEdits.find((entry) => entry.range.start.line === directLabel.line)?.newText, "finished:");
                assert.ok(directLabelEdits.filter((entry) => entry.range.start.line !== directLabel.line).every((entry) => entry.newText === "finished"));
                const existingColon = position(label, "&H40", 1);
                const existingColonEdit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", labelUri, existingColon, "complete");
                const existingColonEdits = existingColonEdit.get(labelUri);
                assert.equal(existingColonEdits.length, 2);
                assert.ok(existingColonEdits.every((entry) => label.getText(entry.range) === "&H40"));
                assert.equal(existingColonEdits.find((entry) => entry.range.start.line === existingColon.line)?.newText, "complete");
                assert.ok(existingColonEdits.filter((entry) => entry.range.start.line !== existingColon.line).every((entry) => entry.newText === "complete"));
                const errorHandler = position(label, "errorHandler:", 1);
                const errorHandlerEdit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", labelUri, errorHandler, "handledError");
                const errorHandlerEdits = errorHandlerEdit.get(labelUri);
                assert.equal(errorHandlerEdits.length, 2);
                assert.ok(errorHandlerEdits.every((entry) => label.getText(entry.range) === "errorHandler" && entry.newText === "handledError"));
                const dataMarker = position(label, "dataMarker:", 1);
                const dataMarkerEdit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", labelUri, dataMarker, "restoredData");
                const dataMarkerEdits = dataMarkerEdit.get(labelUri);
                assert.equal(dataMarkerEdits.length, 2);
                assert.ok(dataMarkerEdits.every((entry) => label.getText(entry.range) === "dataMarker" && entry.newText === "restoredData"));
                assert.equal(label.isDirty, false, "Provider must return a preview, not apply edits itself");
                assert.equal(fs.readFileSync(labelUri.fsPath, "utf8"), original);
            } finally {
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            }
        });
        await check("compiler-selected overloads drive definitions, declarations, implementations, references, signatures, and members", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const compilerUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-overloads.bas"));
            const compilerDocument = await vscode.workspace.openTextDocument(compilerUri);
            const editor = await vscode.window.showTextDocument(compilerDocument);
            try {
                const call = "Print SelectValue(CLng(1)), SelectValue(CDbl(1))";
                const integerPosition = position(compilerDocument, call, call.indexOf("SelectValue") + 2);
                const floatingPosition = position(compilerDocument, call, call.lastIndexOf("SelectValue") + 2);
                const floatingCallStart = position(compilerDocument, call, call.lastIndexOf("SelectValue"));
                const floatingCallEnd = floatingCallStart.translate(0, "SelectValue(CDbl(1))".length);
                editor.selection = new vscode.Selection(floatingCallStart, floatingCallEnd);
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "long");
                const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", compilerUri, floatingPosition);
                assert.equal(definitions.length, 1);
                assert.equal(definitions[0].uri.toString(), compilerUri.toString());
                assert.equal(compilerDocument.lineAt(definitions[0].range.start.line).text, "Function Choices.SelectValue(ByVal value As Double) As Long");
                const declarations = await vscode.commands.executeCommand("vscode.executeDeclarationProvider", compilerUri, floatingPosition);
                assert.equal(declarations.length, 1);
                assert.ok(declarations[0].uri.fsPath.endsWith("compiler-overloads.bi"));
                assert.match(fs.readFileSync(declarations[0].uri.fsPath, "utf8").split("\n")[declarations[0].range.start.line], /Declare Function SelectValue Overload\s*\(ByVal value As Double\)/i);
                const implementations = await vscode.commands.executeCommand("vscode.executeImplementationProvider", compilerUri, floatingPosition);
                assert.equal(implementations.length, 1);
                assert.match(compilerDocument.lineAt(implementations[0].range.start.line).text, /Function Choices\.SelectValue\(ByVal value As Double\) As Long/i);
                const signaturePosition = position(compilerDocument, call, call.lastIndexOf("SelectValue") + "SelectValue(".length);
                const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", compilerUri, signaturePosition);
                assert.equal(signature.signatures.length, 2, "accessible overload alternatives should remain visible");
                assert.match(signature.signatures[signature.activeSignature].parameters[0].label, /As Double/i,
                    "the active signature must still follow FBC's selected overload");
                assert.ok(signature.signatures.some((entry) => /As Long/i.test(entry.parameters[0].label)));
                const references = await vscode.commands.executeCommand("vscode.executeReferenceProvider", compilerUri, floatingPosition);
                assert.equal(references.length, 8, "Six calls plus matching prototype and body");
                assert.equal(references.some((entry) => entry.uri.toString() === compilerUri.toString() && entry.range.contains(integerPosition)), false);
                const macroReference = references.find((entry) => entry.uri.toString() === compilerUri.toString() && entry.range.start.line === position(compilerDocument, "#define SELECT_GENERATED").line);
                assert.ok(macroReference, "Replacement-list identifiers now retain physical references");
                await vscode.commands.executeCommand("freebasic.showPreprocessed");
                const expanded = vscode.window.activeTextEditor.document;
                assert.equal(expanded.uri.scheme, "freebasic-preprocessed");
                const expandedCall = expanded.getText().match(/SelectValue\s*\(\s*CDbl\s*\(\s*1\s*\)\s*\)/i);
                assert.ok(expandedCall);
                const expandedTargets = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", expanded.uri, position(expanded, expandedCall[0], 1));
                assert.equal(expandedTargets.length, 1);
                assert.equal(expandedTargets[0].range.start.line, definitions[0].range.start.line);
                const expandedPoint = position(expanded, expandedCall[0], 1);
                const expandedHighlights = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", expanded.uri, expandedPoint);
                assert.ok(expandedHighlights.some((entry) => entry.range.contains(expandedPoint)),
                    "the preprocessed view should highlight its own compiler-selected call token");
                const otherExpandedCall = expanded.getText().match(/SelectValue\s*\(\s*CLng\s*\(\s*1\s*\)\s*\)/i);
                assert.ok(otherExpandedCall);
                const otherExpandedPoint = position(expanded, otherExpandedCall[0], 1);
                assert.equal(expandedHighlights.some((entry) => entry.range.contains(otherExpandedPoint)), false,
                    "expanded highlights must exclude the sibling overload");
                const overloadCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, call, call.indexOf("SelectValue") + 2)
                );
                const selectValueCompletion = overloadCompletions.items.find((item) => item.label === "SelectValue");
                assert.equal(selectValueCompletion.insertText, "SelectValue", "overloaded procedures must not receive a guessed parameter snippet");
                assert.equal(selectValueCompletion.insertTextRules, undefined);
                const macroCall = "Print SELECT_GENERATED(CDbl(1))";
                const macroCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, macroCall, "Print SELECT_".length)
                );
                const generatedMacro = macroCompletions.items.find((item) => item.label === "SELECT_GENERATED" &&
                    item.kind !== vscode.CompletionItemKind.Text);
                const generatedMacroSnippet = typeof generatedMacro?.insertText === "string"
                    ? generatedMacro.insertText
                    : generatedMacro?.insertText?.value;
                assert.equal(generatedMacroSnippet, "SELECT_GENERATED",
                    "a function-like macro completion must preserve written arguments");
                const freshMacroCompletions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", compilerUri,
                    compilerDocument.positionAt(compilerDocument.getText().length));
                const freshMacro = freshMacroCompletions.items.find((item) => item.label === "SELECT_GENERATED");
                const freshMacroSnippet = typeof freshMacro?.insertText === "string" ? freshMacro.insertText : freshMacro?.insertText?.value;
                assert.equal(freshMacroSnippet, "SELECT_GENERATED(${1:value})$0",
                    "a fresh unique function-like macro still offers its parameter placeholder");
                const members = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, "MakeResult(CDbl(1)).floatingValue", "MakeResult(CDbl(1)).".length));
                assert.ok(members.items.some((item) => item.label === "floatingValue"));
                assert.equal(members.items.some((item) => item.label === "integerValue"), false);
                const setter = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", compilerUri, position(compilerDocument, "instance.CurrentValue =", 12));
                assert.equal(setter.length, 1);
                assert.equal(compilerDocument.lineAt(setter[0].range.start.line).text, "Property Selector.CurrentValue(ByVal value As Long)");
                const indexedPropertyCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, "instance.IndexedValue(2)", "instance.".length)
                );
                const indexedProperty = indexedPropertyCompletions.items.find((item) => item.label === "IndexedValue" &&
                    item.kind !== vscode.CompletionItemKind.Text);
                const indexedPropertySnippet = typeof indexedProperty?.insertText === "string"
                    ? indexedProperty.insertText
                    : indexedProperty?.insertText?.value;
                assert.equal(indexedPropertySnippet, "IndexedValue",
                    "an indexed property completion must preserve its written index");
                const accessorCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, "instance.CurrentValue =", "instance.".length)
                );
                const currentValue = accessorCompletions.items.find((item) => item.label === "CurrentValue");
                assert.equal(currentValue.insertText, "CurrentValue",
                    "a property with getter and setter forms should not guess a completion snippet");
                const freshIndex = accessorCompletions.items.find((item) => item.label === "IndexedValue");
                const freshIndexSnippet = typeof freshIndex?.insertText === "string" ? freshIndex.insertText : freshIndex?.insertText?.value;
                assert.equal(freshIndexSnippet, "IndexedValue(${1:index})$0",
                    "a fresh indexed getter still prompts for its required index");
            } finally {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
            }
        });
        await check("compiler analysis resolves generated values and excludes inactive branches", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            await configuration.update("analysis.compilerPath", process.env.FBC_EDITOR_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const compilerUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-context.bas"));
            const compilerDocument = await vscode.workspace.openTextDocument(compilerUri);
            await vscode.window.showTextDocument(compilerDocument);
            assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
            const memberPosition = position(compilerDocument, "selected.primaryValue", 9);
            const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", compilerUri, memberPosition);
            assert.ok(completions.items.some((item) => item.label === "primaryValue"));
            assert.equal(completions.items.some((item) => item.label === "alternateValue"), false);
            const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", compilerUri, position(compilerDocument, "selected.primaryValue", 2));
            assert.equal(definitions[0]?.uri.toString(), compilerUri.toString());
            assert.equal(definitions[0].range.start.line, position(compilerDocument, "DECLARE_VALUE(selected)").line);
            await vscode.commands.executeCommand("freebasic.showPreprocessed");
            const expanded = vscode.window.activeTextEditor.document;
            assert.equal(expanded.uri.scheme, "freebasic-preprocessed");
            assert.match(expanded.getText(), /Dim Shared selected As SelectedType/i);
            assert.equal(expanded.getText().includes("alternateValue"), false);
            await vscode.window.showTextDocument(compilerDocument);
            await assert.rejects(vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", compilerUri, position(compilerDocument, "selected.primaryValue", 2), "renamedValue"), /disabled/i);
            const tokens = await vscode.commands.executeCommand("vscode.provideDocumentSemanticTokens", compilerUri);
            assert.ok(tokens?.data.length);
            await configuration.update("compiler.arguments", ["-d", "ALTERNATE"], vscode.ConfigurationTarget.Global);
            assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
            const alternate = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, "selected.alternateValue", 9));
            assert.ok(alternate.items.some((item) => item.label === "alternateValue"));
            assert.equal(alternate.items.some((item) => item.label === "primaryValue"), false);
            await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
            await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
        });
    }
    if (process.env.FBC_EXECUTABLE) {
        await check("compiler diagnostics offer bounded Quick Fixes and include-path completion", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("compiler.path", "fbc");
            const previousIncludePaths = configuration.get("includePaths", []);
            const previousRun = configuration.get("diagnostics.run", "onSave");
            const previousAnalysisCompiler = configuration.get("analysis.compilerPath", "");
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-missing-header-action-"));
            const cases = [
                {
                    fileName: "missing-function.bas",
                    name: "Gfx3SurfaceLoad",
                    header: "fbgfx3.bi",
                    actionText: "fbgfx3.bi",
                    source: fs.readFileSync(path.join(__dirname, "workspace/missing-gfx3-header.bas"), "utf8")
                },
                {
                    fileName: "missing-type.bas",
                    name: "Event",
                    header: "fbgfx.bi",
                    actionText: "fbgfx.bi",
                    source: '#lang "fb"\nDim eventValue As Event\n'
                },
                {
                    fileName: "missing-namespace-import.bas",
                    name: "Gfx3SurfaceLoad",
                    header: "fbgfx3.bi",
                    actionText: "Using fb",
                    source: '#lang "fb"\n#include once "fbgfx3.bi"\nDim surface As Any Ptr = Gfx3SurfaceLoad("missing.png")\n'
                }
            ];
            const includeDirectory = process.env.FREEBASIC_ROOT
                ? path.join(process.env.FREEBASIC_ROOT, "inc")
                : path.resolve(path.dirname(process.env.FBC_EXECUTABLE), "../inc");
            try {
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("includePaths", fs.existsSync(includeDirectory) ? [includeDirectory] : previousIncludePaths, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "off", vscode.ConfigurationTarget.Global);
                for (const testCase of cases) {
                    const sourcePath = path.join(directory, testCase.fileName);
                    fs.writeFileSync(sourcePath, testCase.source, "utf8");
                    const uri = vscode.Uri.file(sourcePath);
                    const document = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(document);
                    await vscode.commands.executeCommand("freebasic.checkSyntax");

                    const missing = vscode.languages.getDiagnostics(uri).find((diagnostic) =>
                        diagnostic.source === "fbc" && diagnostic.message.includes(testCase.name)
                    );
                    assert.ok(missing, `${testCase.name} should start with the expected compiler diagnostic`);
                    const actions = await vscode.commands.executeCommand(
                        "vscode.executeCodeActionProvider", uri, missing.range, vscode.CodeActionKind.QuickFix.value
                    );
                    const actionText = testCase.actionText || testCase.header;
                    const action = actions.find((candidate) => candidate.title.toLowerCase().includes(actionText.toLowerCase()));
                    assert.ok(action, `${testCase.header} should be suggested from the unique bundled reference mapping; diagnostic=${missing.message}; at=${missing.range.start.line}:${missing.range.start.character}; line=${document.lineAt(missing.range.start.line).text}; actions=${actions.map((candidate) => candidate.title).join(" | ")}`);
                    assert.equal(await vscode.workspace.applyEdit(action.edit), true);
                    const escapedHeader = testCase.header.replaceAll(".", "\\.");
                    assert.match(document.getText(), new RegExp(`#include once "${escapedHeader}"`, "i"));
                    assert.equal([...document.getText().matchAll(new RegExp(`#include once "${escapedHeader}"`, "ig"))].length, 1,
                        "the quick fix should not duplicate an already-present header");
                    assert.match(document.getText(), /^Using fb\s*$/im);

                    await document.save();
                    await vscode.commands.executeCommand("freebasic.checkSyntax");
                    assert.equal(vscode.languages.getDiagnostics(uri).some((diagnostic) =>
                        diagnostic.source === "fbc" && diagnostic.message.includes(testCase.name)
                    ), false, `the suggested header and namespace import should resolve ${testCase.name}`);
                }

                const typoPath = path.join(directory, "misspelled-variable.bas");
                fs.writeFileSync(typoPath, '#lang "fb"\nDim customerCount As Integer\nPrint custmerCount\n', "utf8");
                const typoUri = vscode.Uri.file(typoPath);
                const typoDocument = await vscode.workspace.openTextDocument(typoUri);
                await vscode.window.showTextDocument(typoDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                const typoDiagnostic = vscode.languages.getDiagnostics(typoUri).find((diagnostic) =>
                    unresolvedValueDiagnostic(diagnostic, "custmerCount")
                );
                assert.ok(typoDiagnostic, "FBC should report the misspelled visible variable");
                const typoActions = await vscode.commands.executeCommand(
                    "vscode.executeCodeActionProvider", typoUri, typoDiagnostic.range, vscode.CodeActionKind.QuickFix.value
                );
                const typoAction = typoActions.find((action) => action.title.includes('"customerCount"'));
                assert.ok(typoAction, "a unique one-edit visible variable should be offered as a typo correction");
                assert.equal(await vscode.workspace.applyEdit(typoAction.edit), true);
                assert.match(typoDocument.getText(), /Print customerCount/i);
                await typoDocument.save();
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(typoUri).some((diagnostic) =>
                    unresolvedValueDiagnostic(diagnostic)
                ), false, "the typo correction should clear the compiler diagnostic");

                const typoCallPath = path.join(directory, "misspelled-call.bas");
                fs.writeFileSync(typoCallPath,
                    '#lang "fb"\nFunction CalculateTotal(ByVal amount As Integer) As Integer\n    Return amount\nEnd Function\nDim CalculteTota As Integer\nPrint CalculteTotal(3)\n', "utf8");
                const typoCallUri = vscode.Uri.file(typoCallPath);
                const typoCallDocument = await vscode.workspace.openTextDocument(typoCallUri);
                await vscode.window.showTextDocument(typoCallDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                const typoCallDiagnostic = vscode.languages.getDiagnostics(typoCallUri).find((diagnostic) =>
                    unresolvedValueDiagnostic(diagnostic, "CalculteTotal")
                );
                assert.ok(typoCallDiagnostic, `FBC should report the misspelled procedure call: ${JSON.stringify(vscode.languages.getDiagnostics(typoCallUri).map((diagnostic) => diagnostic.message))}`);
                const typoCallActions = await vscode.commands.executeCommand(
                    "vscode.executeCodeActionProvider", typoCallUri, typoCallDiagnostic.range, vscode.CodeActionKind.QuickFix.value
                );
                const typoCallAction = typoCallActions.find((action) => action.title.includes('"CalculateTotal"'));
                assert.ok(typoCallAction, "an explicit call should suggest a unique visible procedure, not a variable");
                assert.equal(await vscode.workspace.applyEdit(typoCallAction.edit), true);
                assert.match(typoCallDocument.getText(), /Print CalculateTotal\(3\)/i);
                await typoCallDocument.save();
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(typoCallUri).some((diagnostic) =>
                    unresolvedValueDiagnostic(diagnostic)
                ), false, "the procedure typo correction should clear the compiler diagnostic");

                const typoApiPath = path.join(directory, "misspelled-bundled-api.bas");
                fs.writeFileSync(typoApiPath,
                    '#lang "fb"\nDim surface As Any Ptr = Gfx3SurfaceLoda("missing.png")\n', "utf8");
                const typoApiUri = vscode.Uri.file(typoApiPath);
                const typoApiDocument = await vscode.workspace.openTextDocument(typoApiUri);
                await vscode.window.showTextDocument(typoApiDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                const typoApiDiagnostic = vscode.languages.getDiagnostics(typoApiUri).find((diagnostic) =>
                    unresolvedValueDiagnostic(diagnostic, "Gfx3SurfaceLoda")
                );
                assert.ok(typoApiDiagnostic, `FBC should report the misspelled bundled API: ${JSON.stringify(vscode.languages.getDiagnostics(typoApiUri).map((diagnostic) => diagnostic.message))}`);
                const typoApiActions = await vscode.commands.executeCommand(
                    "vscode.executeCodeActionProvider", typoApiUri, typoApiDiagnostic.range, vscode.CodeActionKind.QuickFix.value
                );
                const typoApiAction = typoApiActions.find((action) => action.title.includes('"Gfx3SurfaceLoad"'));
                assert.ok(typoApiAction, "a unique bundled function typo should offer its matching name and header");
                assert.equal(await vscode.workspace.applyEdit(typoApiAction.edit), true);
                assert.match(typoApiDocument.getText(), /#include once "fbgfx3\.bi"/i);
                assert.match(typoApiDocument.getText(), /^Using fb\s*$/im);
                assert.match(typoApiDocument.getText(), /Gfx3SurfaceLoad\("missing\.png"\)/i);
                await typoApiDocument.save();
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(typoApiUri).some((diagnostic) =>
                    diagnostic.source === "fbc" && /(?:variable|symbol) not declared/i.test(diagnostic.message)
                ), false, "the bundled API typo correction should clear the compiler diagnostic");

                const typoTypePath = path.join(directory, "misspelled-type.bas");
                fs.writeFileSync(typoTypePath,
                    '#lang "fb"\nType CustomerRecord\n    id As Integer\nEnd Type\nDim recordValue As CustomerRecrod\n', "utf8");
                const typoTypeUri = vscode.Uri.file(typoTypePath);
                const typoTypeDocument = await vscode.workspace.openTextDocument(typoTypeUri);
                await vscode.window.showTextDocument(typoTypeDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                const typoTypeDiagnostic = vscode.languages.getDiagnostics(typoTypeUri).find((diagnostic) =>
                    diagnostic.source === "fbc" && /(?:type not defined.*CustomerRecrod|expected identifier,\s*found\s+['"`]?CustomerRecrod)/i.test(diagnostic.message)
                );
                assert.ok(typoTypeDiagnostic, `FBC should report the adjacent-transposition type typo: ${JSON.stringify(vscode.languages.getDiagnostics(typoTypeUri).map((diagnostic) => diagnostic.message))}`);
                const typoTypeActions = await vscode.commands.executeCommand(
                    "vscode.executeCodeActionProvider", typoTypeUri, typoTypeDiagnostic.range, vscode.CodeActionKind.QuickFix.value
                );
                const typoTypeAction = typoTypeActions.find((action) => action.title.includes('"CustomerRecord"'));
                assert.ok(typoTypeAction, "a unique visible type with an adjacent transposition should be suggested");
                assert.equal(await vscode.workspace.applyEdit(typoTypeAction.edit), true);
                assert.match(typoTypeDocument.getText(), /As CustomerRecord/i);
                await typoTypeDocument.save();
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(typoTypeUri).some((diagnostic) =>
                    diagnostic.source === "fbc" && /type not defined/i.test(diagnostic.message)
                ), false, "the type typo correction should clear the compiler diagnostic");

                const typoBundledTypePath = path.join(directory, "misspelled-bundled-type.bas");
                fs.writeFileSync(typoBundledTypePath, '#lang "fb"\nDim eventValue As Evnt\n', "utf8");
                const typoBundledTypeUri = vscode.Uri.file(typoBundledTypePath);
                const typoBundledTypeDocument = await vscode.workspace.openTextDocument(typoBundledTypeUri);
                await vscode.window.showTextDocument(typoBundledTypeDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                const typoBundledTypeDiagnostic = vscode.languages.getDiagnostics(typoBundledTypeUri).find((diagnostic) =>
                    diagnostic.source === "fbc" && /(?:type not defined.*Evnt|expected identifier,\s*found\s+['"`]?Evnt)/i.test(diagnostic.message)
                );
                assert.ok(typoBundledTypeDiagnostic, `FBC should report the misspelled bundled type: ${JSON.stringify(vscode.languages.getDiagnostics(typoBundledTypeUri).map((diagnostic) => diagnostic.message))}`);
                const typoBundledTypeActions = await vscode.commands.executeCommand(
                    "vscode.executeCodeActionProvider", typoBundledTypeUri, typoBundledTypeDiagnostic.range, vscode.CodeActionKind.QuickFix.value
                );
                const typoBundledTypeAction = typoBundledTypeActions.find((action) => /"Event"/i.test(action.title));
                assert.ok(typoBundledTypeAction, "a unique bundled type typo should suggest the matching type and header");
                assert.equal(await vscode.workspace.applyEdit(typoBundledTypeAction.edit), true);
                assert.match(typoBundledTypeDocument.getText(), /#include once "fbgfx\.bi"/i);
                assert.match(typoBundledTypeDocument.getText(), /^Using FB\s*$/im);
                assert.match(typoBundledTypeDocument.getText(), /As Event/i);
                await typoBundledTypeDocument.save();
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(typoBundledTypeUri).some((diagnostic) =>
                    diagnostic.source === "fbc" && /(?:type not defined|expected identifier)/i.test(diagnostic.message)
                ), false, "the bundled type typo correction should clear the compiler diagnostic");

                const ambiguousTypoPath = path.join(directory, "ambiguous-variable-typo.bas");
                fs.writeFileSync(ambiguousTypoPath,
                    '#lang "fb"\nDim customerCount As Integer\nDim custmerCounts As Integer\nPrint custmerCount\n', "utf8");
                const ambiguousTypoUri = vscode.Uri.file(ambiguousTypoPath);
                const ambiguousTypoDocument = await vscode.workspace.openTextDocument(ambiguousTypoUri);
                await vscode.window.showTextDocument(ambiguousTypoDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                const ambiguousTypoDiagnostic = vscode.languages.getDiagnostics(ambiguousTypoUri).find((diagnostic) =>
                    unresolvedValueDiagnostic(diagnostic, "custmerCount")
                );
                assert.ok(ambiguousTypoDiagnostic, "FBC should report a name with two equally close visible declarations");
                const ambiguousTypoActions = await vscode.commands.executeCommand(
                    "vscode.executeCodeActionProvider", ambiguousTypoUri, ambiguousTypoDiagnostic.range, vscode.CodeActionKind.QuickFix.value
                );
                assert.equal(ambiguousTypoActions.some((action) => action.title.startsWith("Fix typo:")), false,
                    "ambiguous typo candidates should not produce a guessed edit");

                const unresolvedHeaderPath = path.join(directory, "header-api.bi");
                const rootPath = path.join(directory, "header-user.bas");
                fs.writeFileSync(unresolvedHeaderPath, "Dim eventValue As Event\n", "utf8");
                fs.writeFileSync(rootPath, '#lang "fb"\n#include once "header-api.bi"\n', "utf8");
                const unresolvedHeaderUri = vscode.Uri.file(unresolvedHeaderPath);
                const rootUri = vscode.Uri.file(rootPath);
                const rootDocument = await vscode.workspace.openTextDocument(rootUri);
                await vscode.window.showTextDocument(rootDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                const headerDiagnostic = vscode.languages.getDiagnostics(unresolvedHeaderUri).find((diagnostic) =>
                    diagnostic.source === "fbc" && diagnostic.message.includes("Event")
                );
                assert.ok(headerDiagnostic, "FBC should report the unresolved bundled type on the included header");
                const headerDocument = await vscode.workspace.openTextDocument(unresolvedHeaderUri);
                await vscode.window.showTextDocument(headerDocument);
                const headerActions = await vscode.commands.executeCommand(
                    "vscode.executeCodeActionProvider", unresolvedHeaderUri, headerDiagnostic.range, vscode.CodeActionKind.QuickFix.value
                );
                const headerAction = headerActions.find((candidate) => candidate.title.includes("fbgfx.bi"));
                assert.ok(headerAction, "an included header should offer its own bundled-header Quick Fix");
                assert.equal(await vscode.workspace.applyEdit(headerAction.edit), true);
                assert.match(headerDocument.getText(), /#include once "fbgfx\.bi"/i);
                assert.match(headerDocument.getText(), /^Using fb\s*$/im);
                await headerDocument.save();
                await vscode.window.showTextDocument(rootDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(unresolvedHeaderUri).some((diagnostic) =>
                    diagnostic.source === "fbc" && diagnostic.message.includes("Event")
                ), false, "the header Quick Fix should clear the compiler diagnostic on the included file");

                const externalHeaderDirectory = path.join(directory, "external-headers");
                fs.mkdirSync(externalHeaderDirectory);
                fs.writeFileSync(path.join(externalHeaderDirectory, "external-only.bi"), "Declare Sub externalCall()\n", "utf8");
                await configuration.update("includePaths", [includeDirectory, externalHeaderDirectory], vscode.ConfigurationTarget.Global);

                const includeCompletionPath = path.join(directory, "include-completion.bas");
                const includeCompletionSource = '#include once "ext"\n';
                fs.writeFileSync(includeCompletionPath, includeCompletionSource, "utf8");
                const includeCompletionUri = vscode.Uri.file(includeCompletionPath);
                const includeCompletionDocument = await vscode.workspace.openTextDocument(includeCompletionUri);
                await vscode.window.showTextDocument(includeCompletionDocument);
                const folderPosition = position(includeCompletionDocument, '"ext', '"ext'.length);
                const folderCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", includeCompletionUri, folderPosition
                );
                const folderCompletion = folderCompletions.items.find((item) => item.label === "external-headers/");
                assert.ok(folderCompletion, "include operand completion should offer a matching directory");
                assert.equal(folderCompletion.kind, vscode.CompletionItemKind.Folder);
                const folderEdit = new vscode.WorkspaceEdit();
                folderEdit.replace(includeCompletionUri, folderCompletion.range, folderCompletion.insertText);
                assert.equal(await vscode.workspace.applyEdit(folderEdit), true);
                const includeCompletionPosition = position(
                    includeCompletionDocument, "external-headers/", "external-headers/".length
                );
                const includeCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", includeCompletionUri, includeCompletionPosition
                );
                const includeCompletion = includeCompletions.items.find((item) => item.label === "external-headers/external-only.bi");
                assert.ok(includeCompletion, "include operand completion should find a configured header inside the selected directory");
                assert.equal(includeCompletion.insertText, "external-only.bi", "completion should retain the typed directory path");
                const includeCompletionEdit = new vscode.WorkspaceEdit();
                includeCompletionEdit.replace(includeCompletionUri, includeCompletion.range, includeCompletion.insertText);
                assert.equal(await vscode.workspace.applyEdit(includeCompletionEdit), true);
                assert.match(includeCompletionDocument.getText(), /#include once "external-headers\/external-only\.bi"/i);
                await includeCompletionDocument.save();
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(includeCompletionUri).some((diagnostic) =>
                    diagnostic.source === "fbc" && diagnostic.severity === vscode.DiagnosticSeverity.Error
                ), false, "the completed include directive must compile, not just resolve its path");

                const unclosedSource = '#include once "external-headers/external-on\n';
                const unclosedEdit = new vscode.WorkspaceEdit();
                unclosedEdit.replace(includeCompletionUri, new vscode.Range(includeCompletionDocument.positionAt(0),
                    includeCompletionDocument.positionAt(includeCompletionDocument.getText().length)), unclosedSource);
                await applyEditAndWaitForDocuments(unclosedEdit, [includeCompletionDocument]);
                const unclosedCompletions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider",
                    includeCompletionUri, new vscode.Position(0, includeCompletionDocument.lineAt(0).text.length));
                const unclosedCompletion = unclosedCompletions.items.find((item) => item.label === "external-headers/external-only.bi");
                assert.ok(unclosedCompletion);
                assert.equal(unclosedCompletion.insertText, 'external-only.bi"', "file completion must close an unfinished include literal");
                const completedLiteralEdit = new vscode.WorkspaceEdit();
                completedLiteralEdit.replace(includeCompletionUri, unclosedCompletion.range, unclosedCompletion.insertText);
                await applyEditAndWaitForDocuments(completedLiteralEdit, [includeCompletionDocument]);
                assert.equal(await includeCompletionDocument.save(), true);
                assert.equal((await vscode.commands.executeCommand("freebasic.checkSyntax")).exitCode, 0,
                    "the completed unfinished literal must compile with FBC");

                const systemIncludePath = path.join(directory, "system-include-completion.bas");
                fs.writeFileSync(systemIncludePath, '#lang "fb"\n#include <fbgf>\n', "utf8");
                const systemIncludeUri = vscode.Uri.file(systemIncludePath);
                const systemIncludeDocument = await vscode.workspace.openTextDocument(systemIncludeUri);
                await vscode.window.showTextDocument(systemIncludeDocument);
                const systemIncludePosition = position(systemIncludeDocument, "fbgf", "fbgf".length);
                const systemIncludeCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", systemIncludeUri, systemIncludePosition
                );
                const systemIncludeCompletion = systemIncludeCompletions.items.find((item) => item.label === "fbgfx.bi");
                assert.ok(systemIncludeCompletion, "angle-bracket include completion should search configured system include paths");
                const systemIncludeEdit = new vscode.WorkspaceEdit();
                systemIncludeEdit.replace(systemIncludeUri, systemIncludeCompletion.range, systemIncludeCompletion.insertText);
                for (const edit of systemIncludeCompletion.additionalTextEdits || []) systemIncludeEdit.replace(systemIncludeUri, edit.range, edit.newText);
                assert.equal(await vscode.workspace.applyEdit(systemIncludeEdit), true);
                assert.match(systemIncludeDocument.getText(), /#include "fbgfx\.bi"/i);
                await systemIncludeDocument.save();
                const systemIncludeResult = await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(systemIncludeResult.exitCode, 0, "accepting a C-style include completion must produce valid FreeBASIC syntax");
                assert.equal(vscode.languages.getDiagnostics(systemIncludeUri).some((diagnostic) =>
                    diagnostic.source === "fbc" && diagnostic.severity === vscode.DiagnosticSeverity.Error
                ), false, "the completed system include should resolve with FBC");

                const missingIncludePath = path.join(directory, "missing-include-path.bas");
                const missingIncludeSource = '#include once "wrong/external-only.bi"\n';
                fs.writeFileSync(missingIncludePath, missingIncludeSource, "utf8");
                const missingIncludeUri = vscode.Uri.file(missingIncludePath);
                const missingIncludeDocument = await vscode.workspace.openTextDocument(missingIncludeUri);
                await vscode.window.showTextDocument(missingIncludeDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                const missingIncludeDiagnostic = vscode.languages.getDiagnostics(missingIncludeUri).find((diagnostic) =>
                    diagnostic.source === "fbc" && /file not found/i.test(diagnostic.message)
                );
                assert.ok(missingIncludeDiagnostic, "FBC should report the unresolved include path");
                const includeActions = await vscode.commands.executeCommand(
                    "vscode.executeCodeActionProvider", missingIncludeUri, missingIncludeDiagnostic.range, vscode.CodeActionKind.QuickFix.value
                );
                const externalIncludeAction = includeActions.find((candidate) => candidate.title.includes("external-only.bi"));
                assert.ok(externalIncludeAction, "a unique header in configured includePaths should be suggested");
                assert.equal(await vscode.workspace.applyEdit(externalIncludeAction.edit), true);
                assert.equal(missingIncludeDocument.getText().includes("wrong/external-only.bi"), false);
                assert.ok(missingIncludeDocument.getText().includes("external-only.bi"));
                await missingIncludeDocument.save();
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(missingIncludeUri).some((diagnostic) =>
                    diagnostic.source === "fbc" && /file not found/i.test(diagnostic.message)
                ), false, "the suggested relative path should resolve the include with the real compiler");
            } finally {
                await configuration.update("compiler.path", previousCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("includePaths", previousIncludePaths, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", previousAnalysisCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", previousRun, vscode.ConfigurationTarget.Global);
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("FBCDIA dependencies recheck open roots for macro-included headers", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("compiler.path", "fbc");
            const previousRun = configuration.get("diagnostics.run", "onSave");
            const sourceUri = vscode.Uri.file(path.join(__dirname, "workspace/macro-diagnostic-root.bas"));
            const headerUri = vscode.Uri.file(path.join(__dirname, "workspace/macro-diagnostic-header.bi"));
            const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
            const headerDocument = await vscode.workspace.openTextDocument(headerUri);
            const originalHeader = fs.readFileSync(headerUri.fsPath, "utf8");
            const originalName = "missingMacroDiagnosticValue";
            const changedName = "changedMacroDiagnosticValue";
            try {
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", "onSave", vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(sourceDocument);
                await vscode.commands.executeCommand("freebasic.checkSyntax");
                assert.equal(vscode.languages.getDiagnostics(headerUri).filter((diagnostic) => diagnostic.source === "fbc").length, 0,
                    "the clean macro-included header should start without diagnostics");

                const appendError = new vscode.WorkspaceEdit();
                appendError.insert(headerUri, headerDocument.positionAt(headerDocument.getText().length), `Print ${originalName}\n`);
                await applyEditAndWaitForDocuments(appendError, [headerDocument]);
                await headerDocument.save();
                const initial = await waitForDiagnostics(headerUri,
                    (diagnostics) => diagnostics.some((diagnostic) => diagnostic.message.includes(originalName)),
                    "Saving a macro-included header should recheck its open root and publish the new error:");
                assert.ok(initial.some((diagnostic) => diagnostic.message.includes(originalName)));

                const edit = new vscode.WorkspaceEdit();
                const start = position(headerDocument, originalName);
                edit.replace(headerUri, new vscode.Range(start, start.translate(0, originalName.length)), changedName);
                await applyEditAndWaitForDocuments(edit, [headerDocument]);
                assert.equal(vscode.languages.getDiagnostics(headerUri).filter((diagnostic) => diagnostic.source === "fbc").length, 0,
                    "editing the compiler-discovered header should clear stale root diagnostics");

                await headerDocument.save();
                const updated = await waitForDiagnostics(headerUri,
                    (diagnostics) => diagnostics.some((diagnostic) => diagnostic.message.includes(changedName)),
                    "Saving a compiler-discovered header did not recheck its open root:");
                assert.ok(updated.some((diagnostic) => diagnostic.message.includes(changedName)));
            } finally {
                fs.writeFileSync(headerUri.fsPath, originalHeader, "utf8");
                await configuration.update("compiler.path", previousCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("diagnostics.run", previousRun, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(headerDocument);
                await vscode.commands.executeCommand("workbench.action.files.revert");
                await vscode.window.showTextDocument(sourceDocument);
            }
        });
        await check("normal semantic sidecar include links follow compiler-selected outcomes", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousAnalysisCompiler = configuration.get("analysis.compilerPath", "");
            const previousCompiler = configuration.get("compiler.path", "fbc");
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-include-links.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            try {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);

                const links = await waitForDocumentLinks(uri);
                assert.equal(links.length, 1, `compiler-selected include links: ${JSON.stringify(links.map((link) => ({ target: link.target?.fsPath, line: link.range.start.line })))}`);
                assert.equal(links[0].target.fsPath, path.join(__dirname, "workspace/compiler-defines.bi"));
            } finally {
                await configuration.update("analysis.compilerPath", previousAnalysisCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", previousCompiler, vscode.ConfigurationTarget.Global);
            }
        });
        await check("stock sidecar implicit argument constructors follow selected overloads", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousAnalysisCompiler = configuration.get("analysis.compilerPath", "");
            const previousCompiler = configuration.get("compiler.path", "fbc");
            const previousCompilerArguments = configuration.get("compiler.arguments", []);
            const previousProjectContexts = configuration.get("analysis.projectContexts", []);
            const previousActiveContext = configuration.get("analysis.activeContext", null);
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/implicit-argument-constructor.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-independent-constructors-"));
            let unrelatedDocument;
            try {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                // A different root may define the same type and constructors.
                // Keep it indexed while navigating this module's own family.
                const unrelatedPath = path.join(directory, "main.bas");
                fs.writeFileSync(unrelatedPath, document.getText());
                unrelatedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(unrelatedPath));
                await vscode.window.showTextDocument(unrelatedDocument, { preview: false });
                await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", unrelatedDocument.uri);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);

                for (const [argument, typeName, otherArgument] of [
                    ["17", "Long", "2.5"],
                    ["2.5", "Double", "17"]
                ]) {
                    const callHierarchy = await vscode.commands.executeCommand(
                        "vscode.prepareCallHierarchy", uri, position(document, argument)
                    );
                    assert.equal(callHierarchy.length, 1, `the ${argument} conversion should prepare Call Hierarchy`);
                    assert.match(callHierarchy[0].detail,
                        new RegExp(`Constructor ArgumentValue\\(ByVal initial As ${typeName}\\)`, "i"));
                    const incoming = await vscode.commands.executeCommand(
                        "vscode.provideIncomingCalls", callHierarchy[0]
                    );
                    const sourceRanges = incoming.flatMap((call) => call.fromRanges);
                    assert.ok(sourceRanges.some((range) => document.getText(range).includes(argument)),
                        `the ${typeName} constructor should include its physical argument site; got ` +
                        incoming.map((call) => `${call.from.name}: ${call.fromRanges.map((range) => document.getText(range)).join(", ")}`).join("; "));
                    assert.equal(sourceRanges.some((range) => document.getText(range).includes(otherArgument)), false,
                        `the ${typeName} constructor should not include the sibling conversion`);
                    if (typeName === "Long") {
                        const outgoing = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", callHierarchy[0]);
                        assert.ok(outgoing.some((call) => call.to.name === "recordArgumentValue"),
                            "the selected constructor hierarchy should include its implementation calls");
                    }
                    const definitions = await vscode.commands.executeCommand(
                        "vscode.executeDefinitionProvider", uri, position(document, argument)
                    );
                    assert.equal(definitions.length, 1,
                        `the ${argument} conversion should navigate to its selected constructor`);
                    assert.match(document.lineAt(definitions[0].range.start.line).text,
                        new RegExp(`^Constructor ArgumentValue\\(ByVal initial As ${typeName}\\)`, "i"));
                    const argumentPosition = position(document, argument);
                    const declarations = await vscode.commands.executeCommand(
                        "vscode.executeDeclarationProvider", uri, argumentPosition
                    );
                    assert.equal(declarations.length, 1,
                        `the ${typeName} conversion should navigate to its constructor prototype`);
                    assert.match(document.lineAt(declarations[0].range.start.line).text,
                        new RegExp(`^\\s*Declare Constructor\\(ByVal initial As ${typeName}\\)`, "i"));
                    const implementations = await vscode.commands.executeCommand(
                        "vscode.executeImplementationProvider", uri, argumentPosition
                    );
                    assert.equal(implementations.length, 1,
                        `the ${typeName} conversion should navigate to its constructor implementation`);
                    assert.match(document.lineAt(implementations[0].range.start.line).text,
                        new RegExp(`^Constructor ArgumentValue\\(ByVal initial As ${typeName}\\)`, "i"));
                    const useReferences = await vscode.commands.executeCommand(
                        "vscode.executeReferenceProvider", uri, argumentPosition
                    );
                    const useReferenceTexts = useReferences.map((reference) => document.getText(reference.range));
                    assert.ok(useReferenceTexts.some((text) => text.includes(argument)),
                        `${typeName} conversion references should include the selected call site`);
                    assert.equal(useReferenceTexts.some((text) => text.includes(otherArgument)), false,
                        `${typeName} conversion references should exclude the sibling call site`);
                    const useHighlights = await vscode.commands.executeCommand(
                        "vscode.executeDocumentHighlights", uri, argumentPosition
                    );
                    const useHighlightTexts = useHighlights.map((highlight) => document.getText(highlight.range));
                    assert.ok(useHighlightTexts.some((text) => text.includes(argument)),
                        `${typeName} conversion highlights should include the selected call site`);
                    assert.equal(useHighlightTexts.some((text) => text.includes(otherArgument)), false,
                        `${typeName} conversion highlights should exclude the sibling call site`);
                    const constructorDeclaration = `Constructor ArgumentValue(ByVal initial As ${typeName})`;
                    const constructorPosition = position(document, constructorDeclaration,
                        "Constructor ArgumentValue".length - 1);
                    const constructorHierarchy = await vscode.commands.executeCommand(
                        "vscode.prepareCallHierarchy", uri, constructorPosition
                    );
                    assert.equal(constructorHierarchy.length, 1,
                        "an independent same-named constructor must not make this declaration ambiguous");
                    assert.equal(constructorHierarchy[0].uri.toString(), uri.toString());
                    const declarationIncoming = await vscode.commands.executeCommand(
                        "vscode.provideIncomingCalls", constructorHierarchy[0]
                    );
                    assert.ok(declarationIncoming.flatMap((call) => call.fromRanges).some((range) => document.getText(range).includes(argument)),
                        "constructor declaration hierarchy should retain its selected implicit argument conversion");
                    const references = await vscode.commands.executeCommand(
                        "vscode.executeReferenceProvider", uri, constructorPosition, { includeDeclaration: true }
                    );
                    const referenceTexts = references.filter((reference) => reference.uri.toString() === uri.toString())
                        .map((reference) => document.getText(reference.range));
                    assert.ok(referenceTexts.some((text) => text.includes(argument)),
                        `${typeName} constructor references should include its implicit argument conversion`);
                    assert.equal(referenceTexts.some((text) => text.includes(otherArgument)), false,
                        `${typeName} constructor references should exclude the sibling conversion`);
                    const highlights = await vscode.commands.executeCommand(
                        "vscode.executeDocumentHighlights", uri, constructorPosition
                    );
                    const highlightedTexts = highlights.map((highlight) => document.getText(highlight.range));
                    assert.ok(highlightedTexts.some((text) => text.includes(argument)),
                        `${typeName} constructor highlights should include its implicit argument conversion`);
                    assert.equal(highlightedTexts.some((text) => text.includes(otherArgument)), false,
                    `${typeName} constructor highlights should exclude the sibling conversion`);
            }
            const deleteUri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-delete-hierarchy.bas"));
            const deleteDocument = await vscode.workspace.openTextDocument(deleteUri);
            await vscode.window.showTextDocument(deleteDocument);
            assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
            const deletePosition = position(deleteDocument, "Delete[] deletedValues", "Delete".length - 1);
            const deleteHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", deleteUri, deletePosition
            );
            assert.ok(deleteHierarchy.some((item) => /Destructor DeleteHierarchyValue/i.test(item.detail)),
                "DELETE[] hierarchy should also include its destructor");
            const destructorPrototype = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", deleteUri,
                position(deleteDocument, "Declare Destructor()", "Declare D".length));
            assert.equal(destructorPrototype.length, 1);
            const destructorIncoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", destructorPrototype[0]);
            assert.ok(destructorIncoming.some((call) => call.from.uri.toString() === deleteUri.toString() &&
                call.fromRanges.some((range) => range.start.line === deletePosition.line)),
                "a destructor prototype must retain its compiler-selected DELETE[] caller");
            const deallocatorDefinition = await vscode.commands.executeCommand(
                "vscode.executeDefinitionProvider", deleteUri, deletePosition
            );
            assert.ok(deallocatorDefinition.some((location) =>
                /^Operator DeleteHierarchyValue\.Delete\[\]/i.test(
                    deleteDocument.lineAt(location.range.start.line).text
                )), "DELETE[] navigation should retain the compiler-selected custom deallocator");
            /* The VS Code command round-trip collapses multiple prepared items.
               It also drops opaque item data, so keep incoming-edge coverage on
               a site without a destructor. */
            const deallocatorUri = vscode.Uri.file(path.join(__dirname,
                "workspace/compiler-delete-operator-hierarchy.bas"));
            const deallocatorDocument = await vscode.workspace.openTextDocument(deallocatorUri);
            await vscode.window.showTextDocument(deallocatorDocument);
            assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
            const deallocatorPosition = position(deallocatorDocument,
                "Delete[] deletedValues", "Delete".length - 1);
            const deallocatorHierarchy = await vscode.commands.executeCommand(
                "vscode.prepareCallHierarchy", deallocatorUri, deallocatorPosition
            );
            assert.equal(deallocatorHierarchy.length, 1,
                "a custom deallocator without a destructor should prepare one Call Hierarchy item");
            assert.match(deallocatorHierarchy[0].detail,
                /Operator DeleteOperatorHierarchyValue\.Delete\[\]/i);
            const deallocatorIncoming = await vscode.commands.executeCommand(
                "vscode.provideIncomingCalls", deallocatorHierarchy[0]
            );
            assert.ok(deallocatorIncoming.flatMap((call) => call.fromRanges).some((range) =>
                range.start.line === deallocatorPosition.line
            ), "the custom deallocator should retain its physical DELETE[] call site");
        } finally {
                if (unrelatedDocument) {
                    await vscode.window.showTextDocument(unrelatedDocument);
                    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                }
                fs.rmSync(directory, { recursive: true, force: true });
                await configuration.update("analysis.activeContext", previousActiveContext, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", previousProjectContexts, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", previousAnalysisCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", previousCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", previousCompilerArguments, vscode.ConfigurationTarget.Global);
            }
        });
        await check("stock sidecar compound assignment follows its operator receipt", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousAnalysisCompiler = configuration.get("analysis.compilerPath", "");
            const previousCompiler = configuration.get("compiler.path", "fbc");
            const previousArguments = configuration.get("compiler.arguments", []);
            const previousProjectContexts = configuration.get("analysis.projectContexts", []);
            const previousActiveContext = configuration.get("analysis.activeContext", null);
            const uri = vscode.Uri.file(path.join(__dirname, "workspace/compiler-overloaded-operator-bridge.bas"));
            const document = await vscode.workspace.openTextDocument(uri);
            try {
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", null, vscode.ConfigurationTarget.Global);
                await vscode.window.showTextDocument(document);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);

                const call = "compoundValue += 1";
                const operatorPosition = position(document, call, "compoundValue ".length);
                const definitions = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", uri, operatorPosition
                );
                assert.equal(definitions.length, 1);
                assert.match(document.lineAt(definitions[0].range.start.line).text,
                    /^Operator BridgeCompoundValue\.\+=/i);
                const hierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, operatorPosition
                );
                assert.equal(hierarchy.length, 1);
                assert.match(hierarchy[0].detail, /BridgeCompoundValue\.\+=/i);
                const incoming = await vscode.commands.executeCommand("vscode.provideIncomingCalls", hierarchy[0]);
                assert.ok(incoming.flatMap((caller) => caller.fromRanges).some((range) =>
                    range.start.line === operatorPosition.line
                ));
                const wordCall = "compoundModulo Mod=> 3";
                const wordPosition = position(document, wordCall, "compoundModulo ".length + 1);
                const wordDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", uri, wordPosition
                );
                assert.equal(wordDefinition.length, 1);
                assert.match(document.lineAt(wordDefinition[0].range.start.line).text,
                    /^Operator BridgeModuloValue\.Mod=/i);
                const lengthCall = "Len(bridgeLength)";
                const lengthPosition = position(document, lengthCall, "Len".length - 1);
                const lengthDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", uri, lengthPosition
                );
                assert.equal(lengthDefinition.length, 1,
                    "stock-sidecar Len should navigate through its compiler-selected operator receipt");
                assert.match(document.lineAt(lengthDefinition[0].range.start.line).text,
                    /^Operator Len\(ByRef value As BridgeLengthValue\) As Long/i);
                const lengthReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", uri, lengthPosition, { includeDeclaration: true }
                );
                assert.ok(lengthReferences.some((entry) => entry.uri.toString() === uri.toString() &&
                    entry.range.start.line === lengthPosition.line),
                "stock-sidecar Len references should include the physical selected operation");
                const lengthHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, lengthPosition
                );
                assert.equal(lengthHierarchy.length, 1);
                assert.match(lengthHierarchy[0].detail,
                    /Operator Len\(ByRef value As BridgeLengthValue\) As Long/i);
                const lengthIncoming = await vscode.commands.executeCommand(
                    "vscode.provideIncomingCalls", lengthHierarchy[0]
                );
                assert.ok(lengthIncoming.flatMap((caller) => caller.fromRanges).some((range) =>
                    range.start.line === lengthPosition.line
                ), "stock-sidecar Len Call Hierarchy should include its physical operation");
            } finally {
                await configuration.update("analysis.activeContext", previousActiveContext, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", previousProjectContexts, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", previousAnalysisCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", previousCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", previousArguments, vscode.ConfigurationTarget.Global);
            }
        });
        await check("configured normal fbc supplies sidecar expression types without bridge tracing", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const oldAnalysisCompiler = configuration.get("analysis.compilerPath", "");
            const oldCompiler = configuration.get("compiler.path", "fbc");
            const oldCompilerArguments = configuration.get("compiler.arguments", []);
            const oldProjectContexts = configuration.get("analysis.projectContexts", []);
            const oldActiveContext = configuration.get("analysis.activeContext", null);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-normal-fbc-sidecar-"));
            const sourcePath = path.join(directory, "main.bas");
            const headerPath = path.join(directory, "values.bi");
            const indexUsePath = path.join(directory, "index-uses.bi");
            const indexUseHeader = [
                "Function HeaderDoubleIndex(ByRef item As OverloadedIndexer) As Long",
                "    Return item[CDbl(3)]",
                "End Function",
                ""
            ].join("\n");
            const header = [
                "Declare Function getValue() As Integer",
                "Type IntegerResult",
                "    integerValue As Long",
                "End Type",
                "Type DoubleResult",
                "    doubleValue As Double",
                "End Type",
                "Declare Function chooseResult Overload (ByVal value As Integer) As IntegerResult",
                "Declare Function chooseResult Overload (ByVal value As Double) As DoubleResult",
                "Function chooseResult(ByVal value As Integer) As IntegerResult",
                "    Dim result As IntegerResult",
                "    Return result",
                "End Function",
                "Function chooseResult(ByVal value As Double) As DoubleResult",
                "    Dim result As DoubleResult",
                "    Return result",
                "End Function",
                "Declare Function chooseSameResult Overload (ByVal value As Integer) As Long",
                "Declare Function chooseSameResult Overload (ByVal value As Double) As Long",
                "Function chooseSameResult(ByVal value As Integer) As Long",
                "    Return CLng(value)",
                "End Function",
                "Function chooseSameResult(ByVal value As Double) As Long",
                "    Return CLng(value)",
                "End Function",
                "Type OverloadedIndexer",
                "    value As Long",
                "    Declare Operator [](ByVal index As Long) As Long",
                "    Declare Operator [](ByVal index As Double) As Long",
                "End Type",
                "Operator OverloadedIndexer.[](ByVal index As Long) As Long",
                "    Operator = index",
                "End Operator",
                "Operator OverloadedIndexer.[](ByVal index As Double) As Long",
                "    Operator = CLng(index)",
                "End Operator",
                "Type PacketValue",
                "    value As Long",
                "End Type",
                "Operator +(ByRef first As PacketValue, ByVal second As Long) As PacketValue",
                "    Dim result As PacketValue",
                "    Return result",
                "End Operator",
                "Operator +(ByRef first As PacketValue, ByVal second As Double) As PacketValue",
                "    Dim result As PacketValue",
                "    Return result",
                "End Operator",
                "Type CastableValue",
                "    value As Long",
                "    Declare Operator Cast() As Long",
                "End Type",
                "Sub RecordCastOperation()",
                "End Sub",
                "Operator CastableValue.Cast() As Long",
                "    RecordCastOperation()",
                "    Return value",
                "End Operator",
                "Declare Operator Abs(ByRef value As CastableValue) As Long",
                "Operator Abs(ByRef value As CastableValue) As Long",
                "    Return value.value",
                "End Operator",
                "Type AssignableValue",
                "    value As Long",
                "    Declare Operator Let(ByRef source As AssignableValue)",
                "End Type",
                "Operator AssignableValue.Let(ByRef source As AssignableValue)",
                "    This.value = source.value",
                "End Operator",
                "Type AllocatedValue",
                "    value As Long",
                "    Declare Destructor()",
                "    Declare Operator New(ByVal size As UInteger) As Any Ptr",
                "    Declare Operator New[](ByVal size As UInteger) As Any Ptr",
                "    Declare Operator Delete(ByVal buffer As Any Ptr)",
                "    Declare Operator Delete[](ByVal buffer As Any Ptr)",
                "End Type",
                "Operator AllocatedValue.New(ByVal size As UInteger) As Any Ptr",
                "    Return Allocate(size)",
                "End Operator",
                "Operator AllocatedValue.New[](ByVal size As UInteger) As Any Ptr",
                "    Return Allocate(size)",
                "End Operator",
                "Operator AllocatedValue.Delete(ByVal buffer As Any Ptr)",
                "    Deallocate(buffer)",
                "End Operator",
                "Operator AllocatedValue.Delete[](ByVal buffer As Any Ptr)",
                "    Deallocate(buffer)",
                "End Operator",
                "Destructor AllocatedValue()",
                "End Destructor",
                "Type IteratorValue",
                "    value As Long",
                "    Declare Constructor(ByVal initial As Long = 0)",
                "    Declare Operator For(ByRef stepValue As IteratorValue)",
                "    Declare Operator Step(ByRef stepValue As IteratorValue)",
                "    Declare Operator Next(ByRef finish As IteratorValue, ByRef stepValue As IteratorValue) As Integer",
                "End Type",
                "Constructor IteratorValue(ByVal initial As Long)",
                "    This.value = initial",
                "End Constructor",
                "Operator IteratorValue.For(ByRef stepValue As IteratorValue)",
                "End Operator",
                "Operator IteratorValue.Step(ByRef stepValue As IteratorValue)",
                "    This.value += stepValue.value",
                "End Operator",
                "Operator IteratorValue.Next(ByRef finish As IteratorValue, ByRef stepValue As IteratorValue) As Integer",
                "    Operator = This.value <= finish.value",
                "End Operator",
                '#include once "index-uses.bi"',
                "Function HeaderDoubleValue() As DoubleResult",
                "    Return chooseResult(CDbl(2))",
                "End Function",
                ""
            ].join("\n");
            const source = '#include "values.bi"\nType ReturnedValue\n    fieldValue As Long\nEnd Type\nDeclare Function getRecord() As ReturnedValue\nDeclare Function chooseLocal Overload (ByVal value As Integer) As IntegerResult\nDeclare Function chooseLocal Overload (ByVal value As Double) As DoubleResult\n#if 1\nType ConditionalValue\n    fieldValue As Long\nEnd Type\n#else\nType ConditionalValue\n    inactiveField As Double\nEnd Type\n#endif\nDeclare Function getConditionalValue() As ConditionalValue\n#if 0\nDim inactiveValue = 1\n#endif\nConst inferredSidecarValue = 1 + 2\nDim indexerInstance As OverloadedIndexer\n#if 1\nDim indexChoice As Long\n#else\nDim indexChoice As Double\n#endif\nDim leftPacket As PacketValue\nDim castableInstance As CastableValue\nDim firstAssignable As AssignableValue\nDim secondAssignable As AssignableValue\nfirstAssignable = secondAssignable\nPrint getRecord().fieldValue\nPrint chooseResult(CDbl(1)).doubleValue\nPrint chooseResult(CLng(1)).integerValue\nPrint chooseLocal(CDbl(3)).doubleValue\nPrint chooseLocal(CLng(4)).integerValue\nPrint chooseSameResult(CDbl(6))\nPrint chooseSameResult(CLng(7))\nPrint indexerInstance[CLng(2)]\nPrint indexerInstance[CDbl(2)]\nPrint indexerInstance[indexChoice]\nPrint (leftPacket + CLng(1)).value\nPrint (leftPacket + CDbl(1)).value\nPrint CLng(castableInstance)\nPrint getConditionalValue().fieldValue\nPrint getValue() + 1\n' +
                "Print Abs(castableInstance)\n" +
                "Print indexerInstance[indexerInstance[CDbl(9)]]\n" +
                "Function packetOperatorCaller() As PacketValue\n    Dim localPacket As PacketValue\n    Return localPacket + CDbl(8)\nEnd Function\n";
            const allocationUses = "Dim allocatedChoice As AllocatedValue Ptr = New AllocatedValue\n" +
                "Delete allocatedChoice\n" +
                "Dim allocatedChoices As AllocatedValue Ptr = New AllocatedValue[2]\n" +
                "Delete[] allocatedChoices\n" +
                "Dim iteratorCurrent As IteratorValue\n" +
                "For iteratorCurrent = IteratorValue(0) To IteratorValue(2) Step IteratorValue(1)\n" +
                "Next\n";
            try {
                fs.writeFileSync(sourcePath, source + allocationUses, "utf8");
                fs.writeFileSync(headerPath, header, "utf8");
                fs.writeFileSync(indexUsePath, indexUseHeader, "utf8");
                const sourceUri = vscode.Uri.file(sourcePath);
                const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
                const headerUri = vscode.Uri.file(headerPath);
                const headerDocument = await vscode.workspace.openTextDocument(headerUri);
                await configuration.update("analysis.compilerPath", "", vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", [], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{
                    name: "normal-sidecar-overloads",
                    modules: ["main.bas"]
                }], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", {
                    name: "normal-sidecar-overloads",
                    module: "main.bas"
                }, vscode.ConfigurationTarget.Global);
                const editor = await vscode.window.showTextDocument(sourceDocument);
                const { runFreeBasicCompiler } = require(path.join(extension.extensionPath, "lib/compiler-diagnostics"));
                const compileResult = await runFreeBasicCompiler({ compilerPath: process.env.FBC_EXECUTABLE, filePath: sourcePath });
                assert.equal(compileResult.exitCode, 0, compileResult.output);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const expression = "getValue() + 1";
                const expressionLine = source.split("\n").findIndex((line) => line.startsWith(`Print ${expression}`));
                const startColumn = source.split("\n")[expressionLine].indexOf(expression);
                editor.selection = new vscode.Selection(new vscode.Position(expressionLine, startColumn), new vscode.Position(expressionLine, startColumn + expression.length));
                assert.equal((await vscode.commands.executeCommand("freebasic.showExpressionType")).toLowerCase(), "integer");
                const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", sourceUri, new vscode.Position(expressionLine, startColumn));
                assert.match(hovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Compiler type: `integer`/i);
                const typeDefinitions = await vscode.commands.executeCommand(
                    "vscode.executeTypeDefinitionProvider", sourceUri, position(sourceDocument, "getRecord().fieldValue", 2)
                );
                assert.equal(typeDefinitions.length, 1, "the compiler-selected return type should map to its unique source declaration without the bridge");
                assert.equal(typeDefinitions[0].uri.toString(), sourceUri.toString());
                assert.equal(sourceDocument.lineAt(typeDefinitions[0].range.start.line).text, "Type ReturnedValue");
                const overloadedMembers = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", sourceUri,
                    position(sourceDocument, "chooseResult(CDbl(1)).doubleValue", "chooseResult(CDbl(1)).".length)
                );
                assert.ok(overloadedMembers.items.some((item) => item.label === "doubleValue"));
                assert.equal(overloadedMembers.items.some((item) => item.label === "integerValue"), false,
                    "ordinary FBC sidecar types should select members from the compiler-chosen overload");
                const selectedDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", sourceUri,
                    position(sourceDocument, "chooseResult(CDbl(1)).doubleValue", 2)
                );
                assert.equal(selectedDefinition.length, 1,
                    "ordinary FBC sidecar types should select one overload for go to definition");
                assert.equal(selectedDefinition[0].uri.toString(), headerUri.toString());
                assert.match(headerDocument.lineAt(selectedDefinition[0].range.start.line).text, /^Function chooseResult\(ByVal value As Double\)/i);
                const selectedImplementation = await vscode.commands.executeCommand(
                    "vscode.executeImplementationProvider", sourceUri,
                    position(sourceDocument, "chooseResult(CDbl(1)).doubleValue", 2)
                );
                assert.equal(selectedImplementation.length, 1,
                    "compiler-selected overload navigation should find one matching body");
                assert.equal(selectedImplementation[0].uri.toString(), headerUri.toString());
                assert.match(headerDocument.lineAt(selectedImplementation[0].range.start.line).text, /^Function chooseResult\(ByVal value As Double\)/i);
                const declarationFromBody = await vscode.commands.executeCommand(
                    "vscode.executeDeclarationProvider", headerUri,
                    position(headerDocument, "Function chooseResult(ByVal value As Double)", 18)
                );
                assert.equal(declarationFromBody.length, 1);
                assert.match(headerDocument.lineAt(declarationFromBody[0].range.start.line).text, /Declare Function chooseResult Overload \(ByVal value As Double\)/i);
                const selectedSignature = await vscode.commands.executeCommand(
                    "vscode.executeSignatureHelpProvider", sourceUri,
                    position(sourceDocument, "chooseResult(CDbl(1)).doubleValue", "chooseResult(CDbl(1)".length)
                );
                assert.equal(selectedSignature.signatures.length, 2,
                    "signature help should keep all visible overload candidates");
                assert.match(selectedSignature.signatures[selectedSignature.activeSignature].label, /ByVal value As Double/i,
                    "ordinary FBC sidecar types should highlight the compiler-selected overload");
                const selectedHover = await vscode.commands.executeCommand(
                    "vscode.executeHoverProvider", sourceUri,
                    position(sourceDocument, "chooseResult(CDbl(1)).doubleValue", 2)
                );
                const selectedHoverText = selectedHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(selectedHoverText, /Function chooseResult\(ByVal value As Double\) As DoubleResult/i);
                assert.doesNotMatch(selectedHoverText, /Function chooseResult\(ByVal value As Integer\) As IntegerResult/i,
                    "hover should present the compiler-selected overload rather than the resolver's first candidate");
                const overloadHighlights = await vscode.commands.executeCommand(
                    "vscode.executeDocumentHighlights", sourceUri,
                    position(sourceDocument, "chooseResult(CDbl(1)).doubleValue", 2)
                );
                const highlightedLines = overloadHighlights.map((highlight) => highlight.range.start.line);
                assert.ok(highlightedLines.includes(position(sourceDocument, "chooseResult(CDbl(1)).doubleValue").line),
                    "document highlights should include the selected overload call");
                assert.equal(highlightedLines.includes(position(sourceDocument, "chooseResult(CLng(1)).integerValue").line), false,
                    "document highlights should omit a call resolved to a different overload");
                const overloadReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri,
                    position(sourceDocument, "chooseResult(CDbl(1)).doubleValue", 2)
                );
                const referencedLines = overloadReferences
                    .filter((reference) => reference.uri.toString() === sourceUri.toString())
                    .map((reference) => reference.range.start.line);
                assert.ok(referencedLines.includes(position(sourceDocument, "chooseResult(CDbl(1)).doubleValue").line),
                    "find references should include the compiler-selected overload call in the current source");
                assert.equal(referencedLines.includes(position(sourceDocument, "chooseResult(CLng(1)).integerValue").line), false,
                    "find references should omit a call resolved to a different overload");
                const headerCallLine = position(headerDocument, "chooseResult(CDbl(2))").line;
                assert.ok(overloadReferences.some((reference) =>
                    reference.uri.toString() === headerUri.toString() && reference.range.start.line === headerCallLine
                ), "ordinary FBC sidecar references should include selected calls in included headers");
                const declarationReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri,
                    position(sourceDocument, "Declare Function chooseLocal Overload (ByVal value As Double)", "Declare Function ".length + "chooseLocal".length - 1)
                );
                assert.ok(declarationReferences.some((reference) =>
                    reference.uri.toString() === sourceUri.toString() &&
                    reference.range.start.line === position(sourceDocument, "chooseLocal(CDbl(3)).doubleValue").line
                ), "finding references from the declaration should include the compiler-selected call");
                assert.equal(declarationReferences.some((reference) =>
                    reference.uri.toString() === sourceUri.toString() &&
                    reference.range.start.line === position(sourceDocument, "chooseLocal(CLng(4)).integerValue").line
                ), false, "declaration-origin references should omit the other overload");
                const declarationHighlights = await vscode.commands.executeCommand(
                    "vscode.executeDocumentHighlights", sourceUri,
                    position(sourceDocument, "Declare Function chooseLocal Overload (ByVal value As Double)",
                        "Declare Function ".length + "chooseLocal".length - 1)
                );
                const declarationHighlightLines = declarationHighlights.map((highlight) => highlight.range.start.line);
                assert.ok(declarationHighlightLines.includes(position(sourceDocument, "chooseLocal(CDbl(3)).doubleValue").line));
                assert.equal(declarationHighlightLines.includes(position(sourceDocument, "chooseLocal(CLng(4)).integerValue").line), false,
                    "declaration-origin document highlights should retain the selected overload boundary");
                const sameResultCall = "chooseSameResult(CDbl(6))";
                const sameResultPosition = position(sourceDocument, sameResultCall, 2);
                const sameResultSignature = await vscode.commands.executeCommand(
                    "vscode.executeSignatureHelpProvider", sourceUri,
                    position(sourceDocument, sameResultCall, "chooseSameResult(".length)
                );
                assert.equal(sameResultSignature.signatures.length, 2,
                    "same-result overloads should remain visible in signature help");
                assert.match(sameResultSignature.signatures[sameResultSignature.activeSignature].label, /ByVal value As Double/i,
                    "compiler source-call bindings should select an overload when return types are identical");
                const sameResultDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", sourceUri, sameResultPosition
                );
                assert.equal(sameResultDefinition.length, 1);
                assert.match(headerDocument.lineAt(sameResultDefinition[0].range.start.line).text,
                    /^Function chooseSameResult\(ByVal value As Double\)/i);
                const sameResultDeclaration = await vscode.commands.executeCommand(
                    "vscode.executeDeclarationProvider", sourceUri, sameResultPosition
                );
                assert.equal(sameResultDeclaration.length, 1);
                assert.match(headerDocument.lineAt(sameResultDeclaration[0].range.start.line).text,
                    /^Declare Function chooseSameResult Overload \(ByVal value As Double\)/i);
                const sameResultImplementation = await vscode.commands.executeCommand(
                    "vscode.executeImplementationProvider", sourceUri, sameResultPosition
                );
                assert.equal(sameResultImplementation.length, 1);
                assert.match(headerDocument.lineAt(sameResultImplementation[0].range.start.line).text,
                    /^Function chooseSameResult\(ByVal value As Double\)/i);
                const sameResultHover = await vscode.commands.executeCommand(
                    "vscode.executeHoverProvider", sourceUri, sameResultPosition
                );
                const sameResultHoverText = sameResultHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(sameResultHoverText, /Function chooseSameResult\(ByVal value As Double\) As Long/i);
                assert.doesNotMatch(sameResultHoverText, /Function chooseSameResult\(ByVal value As Integer\) As Long/i);
                const sameResultHighlights = await vscode.commands.executeCommand(
                    "vscode.executeDocumentHighlights", sourceUri, sameResultPosition
                );
                const sameResultHighlightLines = sameResultHighlights.map((highlight) => highlight.range.start.line);
                assert.ok(sameResultHighlightLines.includes(sameResultPosition.line));
                assert.equal(sameResultHighlightLines.includes(position(sourceDocument, "chooseSameResult(CLng(7))").line), false,
                    "same-result overload highlights should omit the compiler-selected sibling call");
                const sameResultReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri, sameResultPosition, { includeDeclaration: true }
                );
                const sameResultReferenceLines = sameResultReferences
                    .filter((reference) => reference.uri.toString() === sourceUri.toString())
                    .map((reference) => reference.range.start.line);
                assert.ok(sameResultReferenceLines.includes(sameResultPosition.line));
                assert.equal(sameResultReferenceLines.includes(position(sourceDocument, "chooseSameResult(CLng(7))").line), false,
                    "same-result overload references should omit the compiler-selected sibling call");
                const sameResultDeclarationReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", headerUri,
                    position(headerDocument, "Declare Function chooseSameResult Overload (ByVal value As Double)",
                        "Declare Function ".length + "chooseSameResult".length - 1),
                    { includeDeclaration: true }
                );
                const sameResultDeclarationLines = sameResultDeclarationReferences
                    .filter((reference) => reference.uri.toString() === sourceUri.toString())
                    .map((reference) => reference.range.start.line);
                assert.ok(sameResultDeclarationLines.includes(sameResultPosition.line),
                    "same-result overload references should work from the selected declaration");
                assert.equal(sameResultDeclarationLines.includes(position(sourceDocument, "chooseSameResult(CLng(7))").line), false,
                    "declaration-origin same-result references should omit the sibling overload");
                const doubleCallHierarchyAtUse = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", sourceUri, sameResultPosition
                );
                assert.equal(doubleCallHierarchyAtUse.length, 1);
                assert.match(doubleCallHierarchyAtUse[0].detail, /ByVal value As Double/i,
                    "Call Hierarchy should prepare the compiler-selected same-result overload at its call site");
                const doubleCallHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", headerUri,
                    position(headerDocument, "Function chooseSameResult(ByVal value As Double)", "Function ".length + 2)
                );
                assert.equal(doubleCallHierarchy.length, 1);
                const doubleCallers = await vscode.commands.executeCommand("vscode.provideIncomingCalls", doubleCallHierarchy[0]);
                const sameResultModuleCaller = doubleCallers.find((call) => call.from.detail === "Module-level calls");
                assert.ok(sameResultModuleCaller, "the compiler-selected Double call should be an incoming module edge");
                assert.ok(sameResultModuleCaller.fromRanges.some((range) =>
                    range.start.line === sameResultPosition.line
                ));
                assert.equal(sameResultModuleCaller.fromRanges.some((range) =>
                    range.start.line === position(sourceDocument, "chooseSameResult(CLng(7))").line
                ), false, "same-result call hierarchy should exclude the sibling overload");
                const sameResultModuleCalls = await vscode.commands.executeCommand(
                    "vscode.provideOutgoingCalls", sameResultModuleCaller.from
                );
                const sameResultEdges = sameResultModuleCalls.filter((call) => call.to.name === "chooseSameResult");
                assert.equal(sameResultEdges.length, 2,
                    "module call hierarchy should retain both same-result overload targets");
                assert.ok(sameResultEdges.some((call) => /ByVal value As Integer/i.test(call.to.detail)));
                assert.ok(sameResultEdges.some((call) => /ByVal value As Double/i.test(call.to.detail)));
                const doubleIndexCall = "indexerInstance[CDbl(2)]";
                /* The closing bracket belongs to the selected index operator;
                   the nested CDbl callee has its own hover and navigation. */
                const doubleIndexPosition = position(sourceDocument, doubleIndexCall, doubleIndexCall.length - 1);
                const indexSignature = await vscode.commands.executeCommand(
                    "vscode.executeSignatureHelpProvider", sourceUri,
                    position(sourceDocument, doubleIndexCall, "indexerInstance[".length + 1)
                );
                assert.equal(indexSignature.signatures.length, 2);
                assert.match(indexSignature.signatures[indexSignature.activeSignature].label, /ByVal index As Double/i,
                    "stock FBC expression symbols should select same-result index overloads");
                const nestedIndexCall = "indexerInstance[indexerInstance[CDbl(9)]]";
                const nestedInner = nestedIndexCall.indexOf("[", nestedIndexCall.indexOf("[") + 1);
                const nestedSignature = await vscode.commands.executeCommand(
                    "vscode.executeSignatureHelpProvider", sourceUri,
                    position(sourceDocument, nestedIndexCall, nestedInner + 1)
                );
                assert.equal(nestedSignature.signatures.length, 2);
                assert.match(nestedSignature.signatures[nestedSignature.activeSignature].label, /ByVal index As Double/i,
                    "the innermost receipt must select Double while the surrounding indexer selects Long");
                for (const [closing, type] of [[nestedIndexCall.length - 2, "Double"], [nestedIndexCall.length - 1, "Long"]]) {
                    const nestedDefinitions = await vscode.commands.executeCommand(
                        "vscode.executeDefinitionProvider", sourceUri, position(sourceDocument, nestedIndexCall, closing)
                    );
                    assert.equal(nestedDefinitions.length, 1);
                    assert.match(headerDocument.lineAt(nestedDefinitions[0].range.start.line).text,
                        new RegExp("^Operator OverloadedIndexer\\.\\[\\]\\(ByVal index As " + type + "\\)", "i"));
                }
                const indexDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", sourceUri, doubleIndexPosition
                );
                assert.equal(indexDefinition.length, 1);
                assert.match(headerDocument.lineAt(indexDefinition[0].range.start.line).text,
                    /^Operator OverloadedIndexer\.\[\]\(ByVal index As Double\)/i);
                const indexDeclaration = await vscode.commands.executeCommand(
                    "vscode.executeDeclarationProvider", sourceUri, doubleIndexPosition
                );
                assert.equal(indexDeclaration.length, 1);
                assert.match(headerDocument.lineAt(indexDeclaration[0].range.start.line).text,
                    /^\s*Declare Operator \[\]\(ByVal index As Double\)/i);
                const indexImplementation = await vscode.commands.executeCommand(
                    "vscode.executeImplementationProvider", sourceUri, doubleIndexPosition
                );
                assert.equal(indexImplementation.length, 1);
                assert.match(headerDocument.lineAt(indexImplementation[0].range.start.line).text,
                    /^Operator OverloadedIndexer\.\[\]\(ByVal index As Double\)/i);
                const indexHover = await vscode.commands.executeCommand(
                    "vscode.executeHoverProvider", sourceUri, doubleIndexPosition
                );
                const indexHoverText = indexHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(indexHoverText, /ByVal index As Double/i);
                assert.doesNotMatch(indexHoverText, /ByVal index As Long/i);
                const indexHighlights = await vscode.commands.executeCommand(
                    "vscode.executeDocumentHighlights", sourceUri, doubleIndexPosition
                );
                assert.ok(Array.isArray(indexHighlights), "stock-sidecar index highlights should be available at the selected operator");
                const indexHighlightLines = indexHighlights.map((highlight) => highlight.range.start.line);
                assert.ok(indexHighlightLines.includes(doubleIndexPosition.line));
                assert.equal(indexHighlightLines.includes(position(sourceDocument, "indexerInstance[CLng(2)]").line), false,
                    "stock-sidecar index highlights should exclude the sibling overload");
                const indexReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri, doubleIndexPosition, { includeDeclaration: true }
                );
                const indexReferenceLines = indexReferences
                    .filter((reference) => reference.uri.toString() === sourceUri.toString())
                    .map((reference) => reference.range.start.line);
                assert.ok(indexReferenceLines.includes(doubleIndexPosition.line));
                assert.equal(indexReferenceLines.includes(position(sourceDocument, "indexerInstance[CLng(2)]").line), false,
                    "stock-sidecar index references should exclude the sibling overload");
                assert.ok(indexReferences.some((reference) =>
                    reference.uri.toString() === vscode.Uri.file(indexUsePath).toString() && reference.range.start.line === 1
                ), "the full sidecar should preserve selected index expressions in unopened included headers");
                const indexDeclarationReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", headerUri,
                    position(headerDocument, "Declare Operator [](ByVal index As Double)", "Declare Operator ".length + 1),
                    { includeDeclaration: true }
                );
                const indexDeclarationReferenceLines = indexDeclarationReferences
                    .filter((reference) => reference.uri.toString() === sourceUri.toString())
                    .map((reference) => reference.range.start.line);
                assert.ok(indexDeclarationReferenceLines.includes(doubleIndexPosition.line),
                    `stock-sidecar index references should work from the selected operator declaration (got ${
                        indexDeclarationReferences.map((reference) => `${reference.uri.fsPath}:${reference.range.start.line + 1}`).join(", ")
                    })`);
                assert.equal(indexDeclarationReferenceLines.includes(position(sourceDocument, "indexerInstance[CLng(2)]").line), false,
                    "declaration-origin index references should exclude the sibling overload");
                assert.ok(indexDeclarationReferences.some((reference) =>
                    reference.uri.toString() === vscode.Uri.file(indexUsePath).toString() && reference.range.start.line === 1
                ), "declaration-origin index references should include unopened included-header uses");
                const indexDeclarationHighlights = await vscode.commands.executeCommand(
                    "vscode.executeDocumentHighlights", headerUri,
                    position(headerDocument, "Declare Operator [](ByVal index As Double)", "Declare Operator ".length + 1)
                );
                assert.ok(indexDeclarationHighlights.some((highlight) =>
                    highlight.range.start.line === position(headerDocument, "Declare Operator [](ByVal index As Double)").line
                ), "index declaration highlights should retain the selected prototype");
                assert.equal(indexDeclarationHighlights.some((highlight) =>
                    highlight.range.start.line === position(headerDocument, "Declare Operator [](ByVal index As Long)").line
                ), false, "index declaration highlights must exclude the sibling overload");
                const indexArgumentPosition = position(sourceDocument,
                    "indexerInstance[indexChoice]", "indexerInstance[".length + 2);
                const indexArgumentDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", sourceUri, indexArgumentPosition
                );
                assert.equal(indexArgumentDefinition.length, 1);
                assert.equal(indexArgumentDefinition[0].uri.toString(), sourceUri.toString());
                assert.equal(indexArgumentDefinition[0].range.start.line,
                    position(sourceDocument, "Dim indexChoice As Long").line,
                    "an index argument identifier should navigate to its own binding, not the surrounding operator");
                const indexArgumentReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri, indexArgumentPosition, { includeDeclaration: true }
                );
                assert.ok(indexArgumentReferences.some((reference) => reference.range.start.line === indexArgumentPosition.line));
                assert.ok(indexArgumentReferences.every((reference) => reference.uri.toString() === sourceUri.toString() &&
                    sourceDocument.getText(reference.range) === "indexChoice"),
                "index argument references must remain separate from operator receipts");
                const indexArgumentHover = await vscode.commands.executeCommand(
                    "vscode.executeHoverProvider", sourceUri, indexArgumentPosition
                );
                const indexArgumentHoverText = indexArgumentHover
                    .flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(indexArgumentHoverText, /Dim indexChoice As Long/i);
                assert.doesNotMatch(indexArgumentHoverText, /Dim indexChoice As Double/i,
                    "hover must use FBC's active declaration instead of the inactive source alternative");
                assert.doesNotMatch(indexArgumentHoverText, /Operator OverloadedIndexer\.\[\]/i,
                    "argument hover must not describe the surrounding index operator");
                assert.deepEqual(await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", sourceUri, indexArgumentPosition
                ), [], "a variable index argument must not prepare the surrounding operator's Call Hierarchy");
                const doubleIndexHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", sourceUri, doubleIndexPosition
                );
                assert.equal(doubleIndexHierarchy.length, 1);
                assert.match(doubleIndexHierarchy[0].detail, /ByVal index As Double/i);
                const doubleIndexCallers = await vscode.commands.executeCommand(
                    "vscode.provideIncomingCalls", doubleIndexHierarchy[0]
                );
                const doubleIndexModuleCaller = doubleIndexCallers.find((call) => call.from.detail === "Module-level calls");
                assert.ok(doubleIndexModuleCaller, "stock-sidecar Call Hierarchy should include index expressions");
                assert.ok(doubleIndexModuleCaller.fromRanges.some((range) =>
                    sourceDocument.getText(range) === doubleIndexCall
                ));
                assert.equal(doubleIndexModuleCaller.fromRanges.some((range) =>
                    sourceDocument.getText(range) === "indexerInstance[CLng(2)]"
                ), false, "indexer Call Hierarchy should exclude the sibling overload");
                const indexModuleCalls = await vscode.commands.executeCommand(
                    "vscode.provideOutgoingCalls", doubleIndexModuleCaller.from
                );
                assert.ok(indexModuleCalls.some((call) => /ByVal index As Double/i.test(call.to.detail)));
                assert.ok(indexModuleCalls.some((call) => /ByVal index As Long/i.test(call.to.detail)));
                const doubleAddition = "leftPacket + CDbl(1)";
                const additionOperatorPosition = position(sourceDocument, doubleAddition, "leftPacket ".length);
                const additionDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", sourceUri, additionOperatorPosition
                );
                assert.equal(additionDefinition.length, 1);
                const additionDefinitionLine = headerDocument.lineAt(additionDefinition[0].range.start.line).text;
                assert.ok(/^Operator \+\(ByRef first As PacketValue, ByVal second As Double\)/i.test(additionDefinitionLine),
                    `ordinary overloaded operators should navigate through FBC's physical operator receipt (got: ${additionDefinitionLine})`);
                const additionImplementation = await vscode.commands.executeCommand(
                    "vscode.executeImplementationProvider", sourceUri, additionOperatorPosition
                );
                assert.equal(additionImplementation.length, 1);
                assert.equal(additionImplementation[0].range.start.line, additionDefinition[0].range.start.line);
                const additionHover = await vscode.commands.executeCommand(
                    "vscode.executeHoverProvider", sourceUri, additionOperatorPosition
                );
                const additionHoverText = additionHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(additionHoverText, /Operator \+\(ByRef first As PacketValue, ByVal second As Double\)/i);
                assert.doesNotMatch(additionHoverText, /Operator \+\(ByRef first As PacketValue, ByVal second As Long\)/i);
                const additionHighlights = await vscode.commands.executeCommand(
                    "vscode.executeDocumentHighlights", sourceUri, additionOperatorPosition
                );
                const additionHighlightLines = additionHighlights.map((highlight) => highlight.range.start.line);
                assert.ok(additionHighlightLines.includes(additionOperatorPosition.line));
                assert.equal(additionHighlightLines.includes(position(sourceDocument, "leftPacket + CLng(1)").line), false,
                    "overloaded operator highlights should exclude the sibling target");
                const additionReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri, additionOperatorPosition, { includeDeclaration: true }
                );
                const additionReferenceLines = additionReferences
                    .filter((reference) => reference.uri.toString() === sourceUri.toString())
                    .map((reference) => reference.range.start.line);
                assert.ok(additionReferenceLines.includes(additionOperatorPosition.line));
                assert.equal(additionReferenceLines.includes(position(sourceDocument, "leftPacket + CLng(1)").line), false,
                    "overloaded operator references should exclude the sibling target");
                const additionDeclarationReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", headerUri,
                    position(headerDocument, "Operator +(ByRef first As PacketValue, ByVal second As Double)", "Operator ".length),
                    { includeDeclaration: true }
                );
                const additionDeclarationLines = additionDeclarationReferences
                    .filter((reference) => reference.uri.toString() === sourceUri.toString())
                    .map((reference) => reference.range.start.line);
                assert.ok(additionDeclarationLines.includes(additionOperatorPosition.line),
                    "overloaded operator references should work from the declaration");
                assert.equal(additionDeclarationLines.includes(position(sourceDocument, "leftPacket + CLng(1)").line), false,
                    "declaration-origin operator references should exclude the sibling target");
                const doubleOperatorCallHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", sourceUri, additionOperatorPosition
                );
                assert.equal(doubleOperatorCallHierarchy.length, 1);
                assert.match(doubleOperatorCallHierarchy[0].detail, /ByVal second As Double/i,
                    "Call Hierarchy should prepare the selected overloaded operator");
                const doubleOperatorIncoming = await vscode.commands.executeCommand(
                    "vscode.provideIncomingCalls", doubleOperatorCallHierarchy[0]
                );
                const operatorModuleCaller = doubleOperatorIncoming.find((call) => call.from.detail === "Module-level calls");
                assert.ok(operatorModuleCaller, "the overloaded operator should have its module-level expression caller");
                assert.ok(operatorModuleCaller.fromRanges.some((range) => range.start.line === additionOperatorPosition.line));
                assert.equal(operatorModuleCaller.fromRanges.some((range) =>
                    range.start.line === position(sourceDocument, "leftPacket + CLng(1)").line
                ), false, "operator Call Hierarchy should exclude the compiler-selected sibling overload");
                const procedureOperatorCaller = doubleOperatorIncoming.find((call) => call.from.name === "packetOperatorCaller");
                assert.ok(procedureOperatorCaller, "the overloaded operator should include procedure-body expression callers");
                const operatorCallerHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", sourceUri,
                    position(sourceDocument, "Function packetOperatorCaller()", "Function ".length + 2)
                );
                assert.equal(operatorCallerHierarchy.length, 1);
                const operatorCallerOutgoing = await vscode.commands.executeCommand(
                    "vscode.provideOutgoingCalls", operatorCallerHierarchy[0]
                );
                assert.ok(operatorCallerOutgoing.some((call) => /ByVal second As Double/i.test(call.to.detail)),
                    "procedure outgoing calls should include the compiler-selected operator");
                const operatorModuleCalls = await vscode.commands.executeCommand(
                    "vscode.provideOutgoingCalls", operatorModuleCaller.from
                );
                assert.ok(operatorModuleCalls.some((call) => /ByVal second As Double/i.test(call.to.detail)));
                assert.ok(operatorModuleCalls.some((call) => /ByVal second As Long/i.test(call.to.detail)));
                const castCall = "CLng(castableInstance)";
                const castPosition = position(sourceDocument, castCall, "CLng".length - 1);
                const castDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", sourceUri, castPosition
                );
                assert.equal(castDefinition.length, 1);
                assert.match(headerDocument.lineAt(castDefinition[0].range.start.line).text,
                    /^Operator CastableValue\.Cast\(\) As Long/i);
                const castHover = await vscode.commands.executeCommand(
                    "vscode.executeHoverProvider", sourceUri, castPosition
                );
                const castHoverText = castHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n");
                assert.match(castHoverText, /Operator CastableValue\.Cast\(\) As Long/i);
                const castReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri, castPosition, { includeDeclaration: true }
                );
                assert.ok(castReferences.some((reference) =>
                    reference.uri.toString() === sourceUri.toString() && reference.range.start.line === castPosition.line
                ), "Find References should include the cast intrinsic's compiler-selected overload");
                assert.ok(castReferences.some((reference) =>
                    reference.uri.toString() === headerUri.toString() &&
                    headerDocument.lineAt(reference.range.start.line).text.startsWith("Operator CastableValue.Cast")
                ));
                const castCallHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", sourceUri, castPosition
                );
                assert.equal(castCallHierarchy.length, 1);
                assert.match(castCallHierarchy[0].detail, /Operator CastableValue\.Cast\(\) As Long/i);
                const castCallers = await vscode.commands.executeCommand(
                    "vscode.provideIncomingCalls", castCallHierarchy[0]
                );
                const castModuleCaller = castCallers.find((call) => call.from.detail === "Module-level calls");
                assert.ok(castModuleCaller);
                assert.ok(castModuleCaller.fromRanges.some((range) =>
                    sourceDocument.getText(range) === "CLng"
                ));
                const castModuleCalls = await vscode.commands.executeCommand(
                    "vscode.provideOutgoingCalls", castModuleCaller.from
                );
                assert.ok(castModuleCalls.some((call) => /Operator CastableValue\.Cast\(\) As Long/i.test(call.to.detail)));
                const castPrototype = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", headerUri,
                    position(headerDocument, "Declare Operator Cast() As Long", "Declare Operator C".length));
                assert.equal(castPrototype.length, 1);
                const castBodyCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", castPrototype[0]);
                assert.ok(castBodyCalls.some((call) => call.to.name === "RecordCastOperation"),
                    "outgoing hierarchy from a CAST prototype must inspect the implementation body");
                for (const [expression, keyword, operatorName, hierarchyTarget] of [
                    ["New AllocatedValue", "New", "New", "operator"],
                    ["New AllocatedValue[2]", "New", "New[]", "operator"],
                    ["Delete allocatedChoice", "Delete", "Delete", "destructor"],
                    ["Delete[] allocatedChoices", "Delete", "Delete[]", "destructor"]
                ]) {
                    const operationPosition = position(sourceDocument, expression, keyword.length - 1);
                    const operationDefinition = await vscode.commands.executeCommand(
                        "vscode.executeDefinitionProvider", sourceUri, operationPosition
                    );
                    assert.equal(operationDefinition.length, 1, `${operatorName} should resolve through its physical sidecar operation`);
                    assert.match(headerDocument.lineAt(operationDefinition[0].range.start.line).text,
                        new RegExp(`^Operator AllocatedValue\\.${operatorName.replace("[", "\\[").replace("]", "\\]")}\\(`, "i"));
                    const operationHover = await vscode.commands.executeCommand(
                        "vscode.executeHoverProvider", sourceUri, operationPosition
                    );
                    assert.match(operationHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                        new RegExp(`Operator AllocatedValue\\.${operatorName.replace("[", "\\[").replace("]", "\\]")}\\(`, "i"));
                    const operationReferences = await vscode.commands.executeCommand(
                        "vscode.executeReferenceProvider", sourceUri, operationPosition, { includeDeclaration: true }
                    );
                    assert.ok(operationReferences.some((reference) => reference.uri.toString() === sourceUri.toString() &&
                        reference.range.start.line === operationPosition.line),
                    `${operatorName} references should include the physical allocation/deallocation site`);
                    const operationHighlights = await vscode.commands.executeCommand(
                        "vscode.executeDocumentHighlights", sourceUri, operationPosition
                    );
                    assert.ok(operationHighlights.some((highlight) => highlight.range.start.line === operationPosition.line),
                        `${operatorName} highlights should include its physical keyword site`);
                    const operationHierarchy = await vscode.commands.executeCommand(
                        "vscode.prepareCallHierarchy", sourceUri, operationPosition
                    );
                    assert.equal(operationHierarchy.length, 1, `${operatorName} should prepare Call Hierarchy`);
                    if (hierarchyTarget === "operator") {
                        assert.match(operationHierarchy[0].detail,
                            new RegExp(`Operator AllocatedValue\\.${operatorName.replace("[", "\\[").replace("]", "\\]")}`, "i"));
                    } else {
                        assert.match(operationHierarchy[0].detail, /Destructor AllocatedValue/i,
                            "DELETE keeps the existing destructor target in Call Hierarchy");
                    }
                }
                const deleteArrayDeclarationPosition = position(headerDocument,
                    "Declare Operator Delete[](ByVal buffer As Any Ptr)", "Declare Operator ".length);
                const deleteArrayHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", headerUri, deleteArrayDeclarationPosition
                );
                const deleteArrayIncoming = await vscode.commands.executeCommand(
                    "vscode.provideIncomingCalls", deleteArrayHierarchy[0]
                );
                const deleteArrayUsePosition = position(sourceDocument, "Delete[] allocatedChoices", "Delete".length - 1);
                assert.ok(deleteArrayIncoming.some((call) => call.fromRanges.some((range) =>
                    range.start.line === deleteArrayUsePosition.line
                )), "Operator Delete[] declarations should receive their compiler-selected array deallocation edge");
                const iteratorSites = [
                    ["For iteratorCurrent = IteratorValue(0) To IteratorValue(2) Step IteratorValue(1)", "For", "For"],
                    ["Step IteratorValue(1)", "Step", "Step"],
                    ["Next\n", "Next", "Next"]
                ];
                for (const [expression, keyword, operatorName] of iteratorSites) {
                    const operatorPosition = position(sourceDocument, expression, keyword.length - 1);
                    const operatorDefinition = await vscode.commands.executeCommand(
                        "vscode.executeDefinitionProvider", sourceUri, operatorPosition
                    );
                    assert.equal(operatorDefinition.length, 1, `${operatorName} should use FBC's physical iterator-operator receipt`);
                    assert.match(headerDocument.lineAt(operatorDefinition[0].range.start.line).text,
                        new RegExp(`^Operator IteratorValue\\.${operatorName}\\(`, "i"));
                    const operatorHover = await vscode.commands.executeCommand(
                        "vscode.executeHoverProvider", sourceUri, operatorPosition
                    );
                    assert.match(operatorHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                        new RegExp(`Operator IteratorValue\\.${operatorName}\\(`, "i"));
                    const operatorReferences = await vscode.commands.executeCommand(
                        "vscode.executeReferenceProvider", sourceUri, operatorPosition, { includeDeclaration: true }
                    );
                    assert.ok(operatorReferences.some((reference) => reference.uri.toString() === sourceUri.toString() &&
                        reference.range.start.line === operatorPosition.line),
                    `${operatorName} references should include its physical iterator token`);
                    const operatorHighlights = await vscode.commands.executeCommand(
                        "vscode.executeDocumentHighlights", sourceUri, operatorPosition
                    );
                    assert.ok(operatorHighlights.some((highlight) => highlight.range.start.line === operatorPosition.line),
                        `${operatorName} highlights should include its physical iterator token`);
                    const operatorHierarchy = await vscode.commands.executeCommand(
                        "vscode.prepareCallHierarchy", sourceUri, operatorPosition
                    );
                    assert.equal(operatorHierarchy.length, 1, `${operatorName} should prepare Call Hierarchy`);
                    assert.match(operatorHierarchy[0].detail, new RegExp(`Operator IteratorValue\\.${operatorName}`, "i"));
                }
                const absoluteCall = "Abs(castableInstance)";
                const absolutePosition = position(sourceDocument, absoluteCall, "Abs".length - 1);
                const absoluteDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", sourceUri, absolutePosition
                );
                assert.equal(absoluteDefinition.length, 1);
                assert.match(headerDocument.lineAt(absoluteDefinition[0].range.start.line).text,
                    /^Operator Abs\(ByRef value As CastableValue\) As Long/i);
                const absoluteHover = await vscode.commands.executeCommand(
                    "vscode.executeHoverProvider", sourceUri, absolutePosition
                );
                assert.match(absoluteHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                    /Operator Abs\(ByRef value As CastableValue\) As Long/i);
                const absoluteReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri, absolutePosition, { includeDeclaration: true }
                );
                assert.ok(absoluteReferences.some((reference) =>
                    reference.uri.toString() === sourceUri.toString() && reference.range.start.line === absolutePosition.line
                ));
                assert.ok(absoluteReferences.some((reference) =>
                    reference.uri.toString() === headerUri.toString() &&
                    /^\s*Declare Operator Abs\(ByRef value As CastableValue\)/i.test(
                        headerDocument.lineAt(reference.range.start.line).text
                    )
                ), "cast references should include the operator prototype");
                const absoluteCallHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", sourceUri, absolutePosition
                );
                assert.equal(absoluteCallHierarchy.length, 1);
                assert.match(absoluteCallHierarchy[0].detail, /Operator Abs\(ByRef value As CastableValue\) As Long/i);
                const absoluteCallers = await vscode.commands.executeCommand(
                    "vscode.provideIncomingCalls", absoluteCallHierarchy[0]
                );
                const absoluteModuleCaller = absoluteCallers.find((call) => call.from.detail === "Module-level calls");
                assert.ok(absoluteModuleCaller);
                assert.ok(absoluteModuleCaller.fromRanges.some((range) => sourceDocument.getText(range) === "Abs"));
                const assignmentCall = "firstAssignable = secondAssignable";
                const assignmentPosition = position(sourceDocument, assignmentCall, "firstAssignable ".length);
                const assignmentDefinition = await vscode.commands.executeCommand(
                    "vscode.executeDefinitionProvider", sourceUri, assignmentPosition
                );
                assert.equal(assignmentDefinition.length, 1);
                assert.match(headerDocument.lineAt(assignmentDefinition[0].range.start.line).text,
                    /^Operator AssignableValue\.Let\(ByRef source As AssignableValue\)/i);
                const assignmentHover = await vscode.commands.executeCommand(
                    "vscode.executeHoverProvider", sourceUri, assignmentPosition
                );
                assert.match(assignmentHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                    /Operator AssignableValue\.Let\(ByRef source As AssignableValue\)/i);
                const assignmentReferences = await vscode.commands.executeCommand(
                    "vscode.executeReferenceProvider", sourceUri, assignmentPosition, { includeDeclaration: true }
                );
                assert.ok(assignmentReferences.some((reference) =>
                    reference.uri.toString() === sourceUri.toString() && reference.range.start.line === assignmentPosition.line
                ));
                const assignmentCallHierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", sourceUri, assignmentPosition
                );
                assert.equal(assignmentCallHierarchy.length, 1);
                assert.match(assignmentCallHierarchy[0].detail, /Operator AssignableValue\.Let/i);
                const assignmentCallers = await vscode.commands.executeCommand(
                    "vscode.provideIncomingCalls", assignmentCallHierarchy[0]
                );
                const assignmentModuleCaller = assignmentCallers.find((call) => call.from.detail === "Module-level calls");
                assert.ok(assignmentModuleCaller);
                assert.ok(assignmentModuleCaller.fromRanges.some((range) => sourceDocument.getText(range) === "="));
                const assignmentModuleCalls = await vscode.commands.executeCommand(
                    "vscode.provideOutgoingCalls", assignmentModuleCaller.from
                );
                assert.ok(assignmentModuleCalls.some((call) => /Operator AssignableValue\.Let/i.test(call.to.detail)));
                const conditionalTypeDefinitions = await vscode.commands.executeCommand(
                    "vscode.executeTypeDefinitionProvider", sourceUri, position(sourceDocument, "getConditionalValue().fieldValue", 2)
                );
                assert.equal(conditionalTypeDefinitions.length, 1,
                    "FBC's subtype identity should select the active conditional declaration");
                assert.equal(conditionalTypeDefinitions[0].uri.toString(), sourceUri.toString());
                assert.equal(conditionalTypeDefinitions[0].range.start.line,
                    position(sourceDocument, "Type ConditionalValue").line,
                    "type navigation must exclude the same-named declaration in the inactive branch");
                const lastLine = sourceDocument.lineCount - 1;
                const inlayRange = new vscode.Range(0, 0, lastLine, sourceDocument.lineAt(lastLine).text.length);
                const inlayHints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", sourceUri, inlayRange);
                assert.ok(inlayHints.some((hint) =>
                    hint.position.line === position(sourceDocument, "inferredSidecarValue").line &&
                    /:\s*integer\b/i.test(typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join(""))
                ), "ordinary FBC sidecar expression types should appear beside untyped initialized variables");
                const conditionalLine = source.split("\n").findIndex((line) => line.startsWith("#if 0"));
                const conditionalHovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", sourceUri, new vscode.Position(conditionalLine, 4));
                assert.match(conditionalHovers.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"), /Condition evaluated to `false`/i,
                    "the ordinary compiler semantic sidecar should supply conditional hover details too");

                const deprecatedPath = path.join(directory, "deprecated.bas");
                const deprecatedSource = "Declare Function legacyValue() As Integer\nDim inferredLegacyValue = legacyValue() + 1\nPrint inferredLegacyValue\n";
                fs.writeFileSync(deprecatedPath, deprecatedSource, "utf8");
                await configuration.update("compiler.arguments", ["-lang", "deprecated"], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", [{
                    name: "normal-sidecar-deprecated",
                    modules: ["deprecated.bas"],
                    arguments: ["-lang", "deprecated"]
                }], vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.activeContext", {
                    name: "normal-sidecar-deprecated",
                    module: "deprecated.bas"
                }, vscode.ConfigurationTarget.Global);
                const deprecatedUri = vscode.Uri.file(deprecatedPath);
                const deprecatedDocument = await vscode.workspace.openTextDocument(deprecatedUri);
                await vscode.window.showTextDocument(deprecatedDocument);
                const deprecatedCompile = await runFreeBasicCompiler({
                    compilerPath: process.env.FBC_EXECUTABLE,
                    compilerArguments: ["-lang", "deprecated"],
                    filePath: deprecatedPath
                });
                assert.equal(deprecatedCompile.exitCode, 0, deprecatedCompile.output);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const deprecatedLastLine = deprecatedDocument.lineCount - 1;
                const deprecatedRange = new vscode.Range(0, 0, deprecatedLastLine, deprecatedDocument.lineAt(deprecatedLastLine).text.length);
                const deprecatedHints = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", deprecatedUri, deprecatedRange);
                assert.ok(deprecatedHints.some((hint) =>
                    hint.position.line === position(deprecatedDocument, "inferredLegacyValue").line &&
                    /:\s*integer\b/i.test(typeof hint.label === "string" ? hint.label : hint.label.map((part) => part.value).join(""))
                ), "the compiler-selected initializer type should appear for a valid legacy implicit Dim declaration");
                assert.equal(sourceDocument.getText(), source + allocationUses);
                assert.equal(fs.readFileSync(headerPath, "utf8"), header);
            } finally {
                await configuration.update("analysis.activeContext", oldActiveContext, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.projectContexts", oldProjectContexts, vscode.ConfigurationTarget.Global);
                await configuration.update("analysis.compilerPath", oldAnalysisCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.path", oldCompiler, vscode.ConfigurationTarget.Global);
                await configuration.update("compiler.arguments", oldCompilerArguments, vscode.ConfigurationTarget.Global);
                fs.rmSync(directory, { recursive: true, force: true });
                await vscode.window.showTextDocument(document);
            }
        });
        await check("valid navigation fixture and current snippets compile with real fbc", async () => {
            const { runFreeBasicCompiler } = require(path.join(extension.extensionPath, "lib/compiler-diagnostics"));
            const options = { compilerPath: process.env.FBC_EXECUTABLE };
            const includeDirectory = process.env.FREEBASIC_ROOT
                ? path.join(process.env.FREEBASIC_ROOT, "inc")
                : path.resolve(path.dirname(process.env.FBC_EXECUTABLE), "../inc");
            const includeArguments = fs.existsSync(includeDirectory) ? ["-i", includeDirectory] : [];
            const compile = async (filePath, extraArguments = []) => {
                const result = await runFreeBasicCompiler({ ...options, filePath, compilerArguments: [...includeArguments, ...extraArguments] });
                assert.equal(result.exitCode, 0, result.output);
            };
            await compile(uri.fsPath);
            const snippets = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, "snippets/freebasic.code-snippets"), "utf8"));
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-snippet-test-"));
            try {
                for (const name of ["Save Screen As PNG", "Gfx3 Load Image Surface"]) {
                    const snippetDocument = await vscode.workspace.openTextDocument({ language: "freebasic", content: "" });
                    const editor = await vscode.window.showTextDocument(snippetDocument);
                    await editor.insertSnippet(new vscode.SnippetString(snippets[name].body.join("\n")));
                    const sourcePath = path.join(directory, "snippet.bas");
                    /* Test-generated source uses VS Code's own placeholder expansion. */
                    fs.writeFileSync(sourcePath, snippetDocument.getText(), "utf8");
                    await compile(sourcePath, name.startsWith("Gfx3") ? ["-gfx3"] : []);
                }
            } finally {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
        await check("real fbc errors are published on included files", async () => {
            await vscode.workspace.getConfiguration("freebasic").update("compiler.path", process.env.FBC_EXECUTABLE, vscode.ConfigurationTarget.Global);
            const invalidUri = vscode.Uri.file(path.join(__dirname, "workspace/invalid.bas"));
            const invalidDocument = await vscode.workspace.openTextDocument(invalidUri);
            await vscode.window.showTextDocument(invalidDocument);
            await vscode.commands.executeCommand("freebasic.checkSyntax");
            const headerUri = vscode.Uri.file(path.join(__dirname, "workspace/invalid.bi"));
            const header = await vscode.workspace.openTextDocument(headerUri);
            const expected = position(header, "missingIntegrationValue");
            const diagnostics = vscode.languages.getDiagnostics(headerUri);
            assert.ok(diagnostics.some((diagnostic) => diagnostic.source === "fbc" && diagnostic.severity === vscode.DiagnosticSeverity.Error &&
                diagnostic.range.start.line === expected.line && diagnostic.range.start.character === expected.character &&
                diagnostic.range.end.character === expected.character + "missingIntegrationValue".length),
                "compile-only diagnostics should underline the exact rejected name quoted by FBC");
        });
    }
    if (testFilter && checks.length === 0) throw new Error(`No VS Code integration check matched ${JSON.stringify(testFilter)}.`);
    console.log(`Passed ${checks.length} VS Code integration checks.`);
}

module.exports = { run };

/* end of tests/integration/index.js */
