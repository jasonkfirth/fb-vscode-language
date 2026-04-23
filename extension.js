const vscode = require("vscode");
const { loadGrammarSource } = require("./lib/grammar-data");
const { findDeclarationByName, parseFreeBasicText } = require("./lib/freebasic-parser");

const LANGUAGE_ID = "freebasic";

let grammarData = null;

function activate(context) {
    grammarData = loadGrammarSource(context.extensionPath);

    const completionProvider = vscode.languages.registerCompletionItemProvider(
        { language: LANGUAGE_ID },
        createCompletionProvider(),
        "."
    );

    const hoverProvider = vscode.languages.registerHoverProvider(
        { language: LANGUAGE_ID },
        createHoverProvider()
    );

    const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
        { language: LANGUAGE_ID },
        createDocumentSymbolProvider()
    );

    const workspaceSymbolProvider = vscode.languages.registerWorkspaceSymbolProvider(
        createWorkspaceSymbolProvider()
    );

    const definitionProvider = vscode.languages.registerDefinitionProvider(
        { language: LANGUAGE_ID },
        createDefinitionProvider()
    );

    context.subscriptions.push(
        completionProvider,
        hoverProvider,
        documentSymbolProvider,
        workspaceSymbolProvider,
        definitionProvider
    );
}

function deactivate() {
}

function createCompletionProvider() {
    return {
        provideCompletionItems(document) {
            const parsedDocument = parseDocument(document);
            const items = [];
            const seenLabels = new Set();

            addWordCompletions(items, seenLabels, grammarData.keywords, vscode.CompletionItemKind.Keyword, "FreeBASIC keyword");
            addWordCompletions(items, seenLabels, grammarData.types, vscode.CompletionItemKind.TypeParameter, "FreeBASIC type");
            addWordCompletions(items, seenLabels, grammarData.intrinsicFunctions, vscode.CompletionItemKind.Function, "FreeBASIC intrinsic");
            addWordCompletions(items, seenLabels, grammarData.runtimeFunctions, vscode.CompletionItemKind.Function, "FreeBASIC runtime");
            addWordCompletions(items, seenLabels, grammarData.graphicsFunctions, vscode.CompletionItemKind.Function, "FreeBASIC graphics runtime");
            addWordCompletions(items, seenLabels, grammarData.symbolicConstants, vscode.CompletionItemKind.Constant, "FreeBASIC constant");

            for (const declaration of parsedDocument.declarations) {
                const completionItem = new vscode.CompletionItem(declaration.name, declaration.kind);
                completionItem.detail = declaration.detail;
                completionItem.documentation = new vscode.MarkdownString(
                    `Declared in this document on line ${declaration.range.start.line + 1}.`
                );
                completionItem.sortText = `0_${declaration.name.toLowerCase()}`;
                items.push(completionItem);
            }

            return items;
        }
    };
}

function createHoverProvider() {
    return {
        provideHover(document, position) {
            const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_\.]*/);
            if (!range) {
                return null;
            }

            const name = document.getText(range);
            const parsedDocument = parseDocument(document);
            const declaration = findDeclarationByName(parsedDocument.declarations, name);

            if (declaration) {
                const markdown = new vscode.MarkdownString();
                markdown.appendCodeblock(declaration.signature || declaration.sourceLine, LANGUAGE_ID);
                markdown.appendMarkdown(`\n\nDeclared on line ${declaration.range.start.line + 1}.`);
                return new vscode.Hover(markdown, range);
            }

            const builtInHover = getBuiltInHover(name);
            if (builtInHover) {
                return new vscode.Hover(new vscode.MarkdownString(builtInHover), range);
            }

            return null;
        }
    };
}

function createDocumentSymbolProvider() {
    return {
        provideDocumentSymbols(document) {
            const parsedDocument = parseDocument(document);
            return parsedDocument.symbols;
        }
    };
}

function createWorkspaceSymbolProvider() {
    return {
        async provideWorkspaceSymbols(query, token) {
            const files = await vscode.workspace.findFiles("**/*.{bas,bi}", "**/node_modules/**");
            const queryText = (query || "").trim().toLowerCase();
            const symbols = [];

            for (const uri of files) {
                if (token.isCancellationRequested) {
                    break;
                }

                const document = await vscode.workspace.openTextDocument(uri);
                const parsedDocument = parseDocument(document);

                for (const declaration of parsedDocument.declarations) {
                    if (queryText && !declaration.name.toLowerCase().includes(queryText)) {
                        continue;
                    }

                    symbols.push(new vscode.SymbolInformation(
                        declaration.name,
                        symbolKindToDocumentSymbolKind(declaration.kind),
                        declaration.containerName || "",
                        new vscode.Location(uri, declaration.range)
                    ));
                }
            }

            return symbols;
        }
    };
}

function createDefinitionProvider() {
    return {
        async provideDefinition(document, position) {
            const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_\.]*/);
            if (!range) {
                return null;
            }

            const name = document.getText(range);
            const parsedDocument = parseDocument(document);
            const localDeclaration = findDeclarationByName(parsedDocument.declarations, name);
            if (localDeclaration) {
                return new vscode.Location(document.uri, localDeclaration.range);
            }

            const files = await vscode.workspace.findFiles("**/*.{bas,bi}", "**/node_modules/**");
            const locations = [];

            for (const uri of files) {
                const otherDocument = await vscode.workspace.openTextDocument(uri);
                const otherParsedDocument = parseDocument(otherDocument);
                const declaration = findDeclarationByName(otherParsedDocument.declarations, name);
                if (declaration) {
                    locations.push(new vscode.Location(uri, declaration.range));
                }
            }

            if (locations.length === 0) {
                return null;
            }

            return locations;
        }
    };
}

function addWordCompletions(items, seenLabels, words, kind, detail) {
    for (const word of words) {
        if (seenLabels.has(word)) {
            continue;
        }

        seenLabels.add(word);

        const completionItem = new vscode.CompletionItem(word, kind);
        completionItem.detail = detail;
        completionItem.insertText = word;
        completionItem.sortText = `1_${word.toLowerCase()}`;
        items.push(completionItem);
    }
}

function getBuiltInHover(name) {
    const upperName = name.toUpperCase();

    if (grammarData.keywords.includes(upperName)) {
        return `\`${upperName}\`\n\nFreeBASIC keyword.`;
    }

    if (grammarData.types.includes(upperName)) {
        return `\`${upperName}\`\n\nFreeBASIC built-in type.`;
    }

    if (grammarData.intrinsicFunctions.includes(upperName)) {
        return `\`${upperName}\`\n\nFreeBASIC intrinsic function or built-in helper.`;
    }

    if (grammarData.runtimeFunctions.includes(upperName)) {
        return `\`${upperName}\`\n\nFreeBASIC runtime function.`;
    }

    if (grammarData.graphicsFunctions.includes(upperName)) {
        return `\`${upperName}\`\n\nFreeBASIC graphics, input, or audio runtime function.`;
    }

    if (grammarData.symbolicConstants.includes(upperName)) {
        return `\`${upperName}\`\n\nFreeBASIC symbolic constant.`;
    }

    return null;
}

function parseDocument(document) {
    const parsed = parseFreeBasicText(document.getText());

    return {
        declarations: parsed.declarations.map((declaration) => toVsCodeDeclaration(document, declaration)),
        symbols: parsed.declarations.map((declaration) => toDocumentSymbol(document, declaration))
    };
}

function toVsCodeDeclaration(document, declaration) {
    const kind = declarationTypeToCompletionKind(declaration.type);
    const symbolKind = declarationTypeToSymbolKind(declaration.type);
    const range = new vscode.Range(
        declaration.line,
        declaration.startColumn,
        declaration.line,
        declaration.endColumn
    );

    return {
        ...declaration,
        kind,
        symbolKind,
        range
    };
}

function toDocumentSymbol(document, declaration) {
    const range = new vscode.Range(
        declaration.line,
        declaration.startColumn,
        declaration.line,
        declaration.endColumn
    );

    return new vscode.DocumentSymbol(
        declaration.name,
        declaration.detail,
        declarationTypeToSymbolKind(declaration.type),
        range,
        range
    );
}

function declarationTypeToCompletionKind(type) {
    switch (type) {
        case "class":
            return vscode.CompletionItemKind.Class;
        case "const":
            return vscode.CompletionItemKind.Constant;
        case "enum":
            return vscode.CompletionItemKind.Enum;
        case "function":
        case "sub":
            return vscode.CompletionItemKind.Function;
        case "namespace":
            return vscode.CompletionItemKind.Module;
        case "property":
            return vscode.CompletionItemKind.Property;
        case "type":
        case "union":
            return vscode.CompletionItemKind.Struct;
        default:
            return vscode.CompletionItemKind.Variable;
    }
}

function declarationTypeToSymbolKind(type) {
    switch (type) {
        case "class":
            return vscode.SymbolKind.Class;
        case "const":
            return vscode.SymbolKind.Constant;
        case "enum":
            return vscode.SymbolKind.Enum;
        case "function":
        case "sub":
            return vscode.SymbolKind.Function;
        case "namespace":
            return vscode.SymbolKind.Namespace;
        case "property":
            return vscode.SymbolKind.Property;
        case "type":
        case "union":
            return vscode.SymbolKind.Struct;
        default:
            return vscode.SymbolKind.Variable;
    }
}

function symbolKindToDocumentSymbolKind(completionKind) {
    switch (completionKind) {
        case vscode.CompletionItemKind.Class:
            return vscode.SymbolKind.Class;
        case vscode.CompletionItemKind.Constant:
            return vscode.SymbolKind.Constant;
        case vscode.CompletionItemKind.Enum:
            return vscode.SymbolKind.Enum;
        case vscode.CompletionItemKind.Function:
            return vscode.SymbolKind.Function;
        case vscode.CompletionItemKind.Module:
            return vscode.SymbolKind.Namespace;
        case vscode.CompletionItemKind.Property:
            return vscode.SymbolKind.Property;
        case vscode.CompletionItemKind.Struct:
            return vscode.SymbolKind.Struct;
        case vscode.CompletionItemKind.TypeParameter:
            return vscode.SymbolKind.TypeParameter;
        default:
            return vscode.SymbolKind.Variable;
    }
}

module.exports = {
    activate,
    deactivate
};
