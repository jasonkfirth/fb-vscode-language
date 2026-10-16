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
    const uri = vscode.Uri.file(path.join(__dirname, "workspace/main.bas"));
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
            for (const [text, relative] of [["Print fromVar.number", "Print f".length], ["fromTypeOf.number", 1], ["fromAlias.number", 1]]) {
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
                        assert.equal(hierarchy.length, 1);
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
        const source = '#if 1\nNamespace ColdOutline\nType ReadyValue\nnumber As Long\nEnd Type\n' +
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
            const names = async () => (await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", current.uri))
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
                    assert.equal(cleanup.length, 1, `${backend}: ${caller.from.name} must show its selected cleanup`);
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
                        `ConsumeTemporary(${typeName}())\nConsumeTemporary(Type<${typeName}>(CLng(3)))\n'' end of ${fixture}`);
                const filePath = path.join(directory, `${backend}${qualified ? "-qualified" : ""}.bas`);
                fs.writeFileSync(filePath, source);
                const current = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                await vscode.window.showTextDocument(current);
                const calls = [
                    [`${typeName}(CLng(1))`, "Long"], [qualified ? "ConstructionScope.TemporaryValue(CDbl(2))" : "TemporaryValue(CDbl(2))", "Double"],
                    [`${typeName}()`, "Long"], [`Type<${typeName}>(CLng(3))`, "Long"]
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
                    }
                    for (const call of calls.filter((call) => call.type === type)) {
                        const preparedCall = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", current.uri, call.site);
                        assert.equal(preparedCall.length, 1, `${backend}: hierarchy must start at ${call.spelling}`);
                        assert.ok(preparedCall[0].selectionRange.isEqual(prepared[0].selectionRange),
                            `${backend}: the written construction must select the same overload as its declaration`);
                    }
                }
                const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", current.uri,
                    position(current, "TemporaryValue(CDbl(2))", "TemporaryValue(".length));
                assert.ok(signature?.signatures.length);
                assert.match(signature.signatures[signature.activeSignature || 0].label, /initialValue As Double/i,
                    `${backend}: Signature Help must select the compiler-confirmed temporary constructor`);
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
        const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, position(document, "Sin(0.5)", 2));
        const sin = completions.items.find((item) => String(item.label).toLowerCase() === "sin");
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
    });
    await check("member signature uses the user declaration", async () => {
        const signature = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", uri, position(document, "origin.SetX (20)", 14));
        assert.ok(signature?.signatures.length);
        assert.match(signature.signatures[0].parameters[0].label, /newValue/);
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
            const wrappedValue = completions.items.find((item) => item.label === "WrappedValue");
            const snippet = typeof wrappedValue?.insertText === "string" ? wrappedValue.insertText : wrappedValue?.insertText?.value;
            assert.equal(snippet, "WrappedValue(${1:source})$0");

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
                /^Operator BridgeCompoundValue\.\+\=/i);
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
            assert.match(compoundAssignmentHierarchy[0].detail, /BridgeCompoundValue\.\+\=/i);
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
                /^Operator BridgeCompoundValue\.\+\=/i);
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
        } finally {
            await vscode.window.showTextDocument(document);
        }
    });

    if (process.env.FBC_EDITOR_EXECUTABLE) {
        await check("native call hierarchy follows compiler-selected procedure bindings", async () => {
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const previousCompiler = configuration.get("analysis.compilerPath", "");
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
                assert.equal(document.getText(macroCallerEdge.fromRanges[0]), "LeafValue",
                    "the macro-expanded edge should map to its physical callee argument");

                const root = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, position(document, "Function RootValue", "Function ".length + 2)
                );
                assert.equal(root.length, 1);
                assert.equal(root[0].name, "RootValue");
                const rootCalls = await vscode.commands.executeCommand("vscode.provideOutgoingCalls", root[0]);
                assert.deepEqual(rootCalls.map((call) => call.to.name).sort(), ["LeafValue", "MiddleValue"],
                    JSON.stringify(rootCalls.map((call) => ({ name: call.to.name, ranges: call.fromRanges.map((range) => [range.start.line, range.start.character]) }))));
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
                const applyScale = completions.items.find((item) => item.label === "ApplyScale");
                const applyScaleSnippet = typeof applyScale?.insertText === "string" ? applyScale.insertText : applyScale?.insertText?.value;
                assert.equal(applyScaleSnippet, "ApplyScale(${1:value})$0",
                    "completion should prompt for the required argument without inserting the optional defaulted argument");
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
                assert.equal(await vscode.workspace.applyEdit(edit), true);
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
                const constructorItem = constructorCallCompletions.items.find((item) => item.label === "WrappedValue");
                const constructorSnippet = typeof constructorItem?.insertText === "string"
                    ? constructorItem.insertText : constructorItem?.insertText?.value;
                assert.equal(constructorSnippet, "WrappedValue(${1:source})$0",
                    "native type completion after NEW should insert the unique constructor's parameter placeholder");
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
                assert.equal(await vscode.workspace.applyEdit(partialEdit), true);
                assert.equal(await vscode.commands.executeCommand("freebasic.analyzeModule"), true);
                const partialDiagnostics = vscode.languages.getDiagnostics(compilerUri).filter((diagnostic) => diagnostic.source === "fbc (buffer)");
                assert.ok(partialDiagnostics.length, "the intentionally incomplete root module must retain its parser diagnostic");
                const partialDirectiveHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", headerUri, position(header, "#if 1 + 2 = 3", 4));
                assert.match(partialDirectiveHover.flatMap((hover) => hover.contents.map((content) => content.value)).join("\n"),
                    /Compiler recovery type \(provisional\): `integer`/i,
                    "compiler-typed unsaved header directives should survive an unrelated root-buffer syntax error");
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
                assert.equal(signature.signatures.length, 1);
                assert.match(signature.signatures[0].parameters[0].label, /As Double/i);
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
                const generatedMacro = macroCompletions.items.find((item) => item.label === "SELECT_GENERATED");
                const generatedMacroSnippet = typeof generatedMacro?.insertText === "string"
                    ? generatedMacro.insertText
                    : generatedMacro?.insertText?.value;
                assert.equal(generatedMacroSnippet, "SELECT_GENERATED(${1:value})$0",
                    "a unique function-like macro should complete with its argument placeholder");
                const members = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, "MakeResult(CDbl(1)).floatingValue", "MakeResult(CDbl(1)).".length));
                assert.ok(members.items.some((item) => item.label === "floatingValue"));
                assert.equal(members.items.some((item) => item.label === "integerValue"), false);
                const setter = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", compilerUri, position(compilerDocument, "instance.CurrentValue =", 12));
                assert.equal(setter.length, 1);
                assert.equal(compilerDocument.lineAt(setter[0].range.start.line).text, "Property Selector.CurrentValue(ByVal value As Long)");
                const indexedPropertyCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, "instance.IndexedValue(2)", "instance.".length)
                );
                const indexedProperty = indexedPropertyCompletions.items.find((item) => item.label === "IndexedValue");
                const indexedPropertySnippet = typeof indexedProperty?.insertText === "string"
                    ? indexedProperty.insertText
                    : indexedProperty?.insertText?.value;
                assert.equal(indexedPropertySnippet, "IndexedValue(${1:index})$0",
                    "an indexed property getter should prompt for its required index");
                const accessorCompletions = await vscode.commands.executeCommand(
                    "vscode.executeCompletionItemProvider", compilerUri, position(compilerDocument, "instance.CurrentValue =", "instance.".length)
                );
                const currentValue = accessorCompletions.items.find((item) => item.label === "CurrentValue");
                assert.equal(currentValue.insertText, "CurrentValue",
                    "a property with getter and setter forms should not guess a completion snippet");
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
                    /^Operator BridgeCompoundValue\.\+\=/i);
                const hierarchy = await vscode.commands.executeCommand(
                    "vscode.prepareCallHierarchy", uri, operatorPosition
                );
                assert.equal(hierarchy.length, 1);
                assert.match(hierarchy[0].detail, /BridgeCompoundValue\.\+\=/i);
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
