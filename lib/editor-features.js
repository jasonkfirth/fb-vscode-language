/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/editor-features.js

    Purpose:

        Adapt source-backed FreeBASIC analysis into VS Code language providers.

    Responsibilities:

        - provide completions, hovers, symbols, definitions, and signatures
        - provide references, rename edits, highlights, folding, and links
        - map parser-neutral declarations and ranges to VS Code API objects

    This file intentionally does NOT contain:

        - source parsing
        - workspace index storage
        - compiler execution or diagnostics
*/

const fs = require("fs");
const path = require("path");

const {
    findCallContext,
    findDeclarationsByName,
    normalizeIdentifier
} = require("./freebasic-parser");

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?/;
const QUALIFIED_IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?)*/g;

function createEditorFeatures(vscode, workspaceIndex, grammarData) {
    return {
        completion: createCompletionProvider(vscode, workspaceIndex, grammarData),
        definition: createDefinitionProvider(vscode, workspaceIndex),
        documentHighlight: createDocumentHighlightProvider(vscode, workspaceIndex),
        documentLink: createDocumentLinkProvider(vscode, workspaceIndex),
        documentSymbol: createDocumentSymbolProvider(vscode, workspaceIndex),
        folding: createFoldingRangeProvider(vscode, workspaceIndex),
        hover: createHoverProvider(vscode, workspaceIndex, grammarData),
        reference: createReferenceProvider(vscode, workspaceIndex),
        rename: createRenameProvider(vscode, workspaceIndex),
        signature: createSignatureHelpProvider(vscode, workspaceIndex),
        workspaceSymbol: createWorkspaceSymbolProvider(vscode, workspaceIndex)
    };
}

/* ------------------------------------------------------------------------- */
/* Completion and hover                                                       */
/* ------------------------------------------------------------------------- */

function createCompletionProvider(vscode, workspaceIndex, grammarData) {
    return {
        async provideCompletionItems(document, position, token) {
            const parsedDocument = workspaceIndex.getParsedDocument(document);
            const items = [];
            const seenLabels = new Set();
            const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
            const hasDirectivePrefix = /#\s*[A-Za-z_]*$/.test(linePrefix);

            /* Local and module declarations should win label collisions. */
            for (const declaration of parsedDocument.declarations) {
                if (isDeclarationVisibleAtLine(declaration, position.line)) {
                    addDeclarationCompletion(vscode, items, seenLabels, declaration, "0");
                }
            }

            addPreprocessorCompletions(
                vscode,
                items,
                seenLabels,
                grammarData.preprocessorDirectives,
                hasDirectivePrefix
            );
            addWordCompletions(vscode, items, seenLabels, grammarData.operatorKeywords, vscode.CompletionItemKind.Operator, "FreeBASIC word operator");
            addWordCompletions(vscode, items, seenLabels, grammarData.keywords, vscode.CompletionItemKind.Keyword, "FreeBASIC keyword");
            addWordCompletions(vscode, items, seenLabels, grammarData.types, vscode.CompletionItemKind.TypeParameter, "FreeBASIC type");
            addWordCompletions(vscode, items, seenLabels, grammarData.libraryTypes, vscode.CompletionItemKind.Struct, "FreeBASIC bundled API type");
            addWordCompletions(vscode, items, seenLabels, grammarData.typeModifiers, vscode.CompletionItemKind.Keyword, "FreeBASIC declaration modifier");
            addWordCompletions(vscode, items, seenLabels, grammarData.intrinsicFunctions, vscode.CompletionItemKind.Function, "FreeBASIC intrinsic");
            addWordCompletions(vscode, items, seenLabels, grammarData.runtimeFunctions, vscode.CompletionItemKind.Function, "FreeBASIC runtime");
            addWordCompletions(vscode, items, seenLabels, grammarData.graphicsFunctions, vscode.CompletionItemKind.Function, "FreeBASIC graphics runtime");
            addWordCompletions(vscode, items, seenLabels, grammarData.bundledFunctions, vscode.CompletionItemKind.Function, "FreeBASIC bundled API");
            addWordCompletions(vscode, items, seenLabels, grammarData.constants, vscode.CompletionItemKind.Constant, "FreeBASIC language constant");
            addWordCompletions(vscode, items, seenLabels, grammarData.compilerDefines, vscode.CompletionItemKind.Constant, "FreeBASIC compiler define");
            addWordCompletions(vscode, items, seenLabels, grammarData.symbolicConstants, vscode.CompletionItemKind.Constant, "FreeBASIC constant");

            await workspaceIndex.ensureInitialized(token);
            const configuration = vscode.workspace.getConfiguration("freebasic", document.uri);
            const maxWorkspaceCompletions = Math.max(
                1,
                configuration.get("index.maxCompletionResults", 2000)
            );
            let workspaceCompletionCount = 0;
            for (const entry of workspaceIndex.getAllDeclarations()) {
                if (
                    (token && token.isCancellationRequested) ||
                    workspaceCompletionCount >= maxWorkspaceCompletions
                ) {
                    break;
                }
                if (entry.uri.toString() === document.uri.toString()) {
                    continue;
                }
                if (!isWorkspaceVisibleDeclaration(entry.declaration)) {
                    continue;
                }
                if (addDeclarationCompletion(vscode, items, seenLabels, entry.declaration, "1")) {
                    workspaceCompletionCount++;
                }
            }

            return items;
        }
    };
}

function createHoverProvider(vscode, workspaceIndex, grammarData) {
    return {
        async provideHover(document, position, token) {
            const symbol = getQualifiedSymbolAtPosition(vscode, document, position);
            if (!symbol) {
                return null;
            }

            const parsedDocument = workspaceIndex.getParsedDocument(document);
            let declarations = findScopedDocumentDeclarations(
                parsedDocument.declarations,
                symbol.name,
                position.line,
                position.character
            );

            if (declarations.length === 0) {
                const simpleName = getSimpleNameAtPosition(vscode, document, position);
                if (simpleName) {
                    declarations = findScopedDocumentDeclarations(
                        parsedDocument.declarations,
                        simpleName.name,
                        position.line,
                        position.character
                    );
                }
            }

            if (declarations.length > 0) {
                return new vscode.Hover(
                    createDeclarationMarkdown(vscode, declarations, document.uri),
                    symbol.range
                );
            }

            let workspaceDeclarations = await workspaceIndex.findDeclarations(symbol.name, token);
            if (workspaceDeclarations.length === 0) {
                const simpleName = getSimpleNameAtPosition(vscode, document, position);
                if (simpleName) {
                    workspaceDeclarations = await workspaceIndex.findDeclarations(simpleName.name, token);
                }
            }
            if (workspaceDeclarations.length > 0) {
                return new vscode.Hover(
                    createWorkspaceDeclarationMarkdown(vscode, workspaceDeclarations),
                    symbol.range
                );
            }

            const builtInHover = getBuiltInHover(grammarData, symbol.name);
            if (builtInHover) {
                return new vscode.Hover(new vscode.MarkdownString(builtInHover), symbol.range);
            }

            return null;
        }
    };
}

function addPreprocessorCompletions(vscode, items, seenLabels, directives, hasDirectivePrefix) {
    for (const directive of directives) {
        const label = `#${directive}`;
        const normalizedLabel = label.toLowerCase();

        if (seenLabels.has(normalizedLabel)) {
            continue;
        }

        seenLabels.add(normalizedLabel);
        const completionItem = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
        completionItem.detail = "FreeBASIC preprocessor directive";
        completionItem.insertText = hasDirectivePrefix ? directive : label;
        completionItem.sortText = `2_${normalizedLabel}`;
        items.push(completionItem);
    }
}

function addWordCompletions(vscode, items, seenLabels, words, kind, detail) {
    for (const word of words) {
        const normalizedLabel = word.toLowerCase();
        if (seenLabels.has(normalizedLabel)) {
            continue;
        }

        seenLabels.add(normalizedLabel);
        const completionItem = new vscode.CompletionItem(word, kind);
        completionItem.detail = detail;
        completionItem.insertText = word;
        completionItem.sortText = `2_${normalizedLabel}`;
        items.push(completionItem);
    }
}

function addDeclarationCompletion(vscode, items, seenLabels, declaration, priority) {
    const normalizedLabel = declaration.name.toLowerCase();
    if (seenLabels.has(normalizedLabel)) {
        return false;
    }

    seenLabels.add(normalizedLabel);
    const completionItem = new vscode.CompletionItem(
        declaration.name,
        declarationTypeToCompletionKind(vscode, declaration.type)
    );
    completionItem.detail = declaration.detail;
    completionItem.documentation = new vscode.MarkdownString(
        `\`\`\`freebasic\n${declaration.signature}\n\`\`\``
    );
    completionItem.insertText = declaration.name;
    completionItem.sortText = `${priority}_${normalizedLabel}`;
    items.push(completionItem);
    return true;
}

function getBuiltInHover(grammarData, name) {
    const upperName = name.toUpperCase();
    const simpleName = upperName.includes(".") ? upperName.split(".").at(-1) : upperName;

    const groups = [
        [grammarData.preprocessorDirectives, `\`#${simpleName}\`\n\nFreeBASIC preprocessor directive.`],
        [grammarData.operatorKeywords, `\`${simpleName}\`\n\nFreeBASIC word operator.`],
        [grammarData.keywords, `\`${simpleName}\`\n\nFreeBASIC keyword.`],
        [grammarData.types, `\`${simpleName}\`\n\nFreeBASIC built-in type.`],
        [grammarData.libraryTypes, `\`${simpleName}\`\n\nType declared by a bundled FreeBASIC header.`],
        [grammarData.typeModifiers, `\`${simpleName}\`\n\nFreeBASIC declaration modifier.`],
        [grammarData.intrinsicFunctions, `\`${simpleName}\`\n\nFreeBASIC intrinsic function or built-in helper.`],
        [grammarData.runtimeFunctions, `\`${simpleName}\`\n\nFreeBASIC runtime function.`],
        [grammarData.graphicsFunctions, `\`${simpleName}\`\n\nFreeBASIC graphics, input, or audio runtime function.`],
        [grammarData.bundledFunctions, `\`${simpleName}\`\n\nFunction or sub declared by a bundled FreeBASIC header.`],
        [grammarData.constants, `\`${simpleName}\`\n\nFreeBASIC language constant.`],
        [grammarData.compilerDefines, `\`${simpleName}\`\n\nFreeBASIC compiler define.`],
        [grammarData.symbolicConstants, `\`${simpleName}\`\n\nFreeBASIC symbolic constant.`]
    ];

    for (const [values, hoverText] of groups) {
        if (values.includes(simpleName) || values.includes(upperName)) {
            return `${hoverText}\n\nLanguage data target: FreeBASIC ${grammarData.sourceVersion}.`;
        }
    }

    return null;
}

/* ------------------------------------------------------------------------- */
/* Symbols and navigation                                                     */
/* ------------------------------------------------------------------------- */

function createDocumentSymbolProvider(vscode, workspaceIndex) {
    return {
        provideDocumentSymbols(document) {
            const parsedDocument = workspaceIndex.getParsedDocument(document);
            return createDocumentSymbolTree(vscode, document, parsedDocument.declarations);
        }
    };
}

function createWorkspaceSymbolProvider(vscode, workspaceIndex) {
    return {
        async provideWorkspaceSymbols(query, token) {
            await workspaceIndex.ensureInitialized(token);
            const queryText = normalizeIdentifier(query);
            const configuration = vscode.workspace.getConfiguration("freebasic");
            const maxResults = Math.max(1, configuration.get("index.maxSymbolResults", 1000));
            const symbols = [];

            for (const entry of workspaceIndex.getAllDeclarations()) {
                if ((token && token.isCancellationRequested) || symbols.length >= maxResults) {
                    break;
                }
                if (!isWorkspaceVisibleDeclaration(entry.declaration)) {
                    continue;
                }
                if (queryText && !normalizeIdentifier(entry.declaration.qualifiedName).includes(queryText)) {
                    continue;
                }

                symbols.push(new vscode.SymbolInformation(
                    entry.declaration.name,
                    declarationTypeToSymbolKind(vscode, entry.declaration.type),
                    entry.declaration.containerName,
                    new vscode.Location(entry.uri, declarationSelectionRange(vscode, entry.declaration))
                ));
            }

            return symbols;
        }
    };
}

function createDefinitionProvider(vscode, workspaceIndex) {
    return {
        async provideDefinition(document, position, token) {
            const qualifiedSymbol = getQualifiedSymbolAtPosition(vscode, document, position);
            if (!qualifiedSymbol) {
                return null;
            }

            const simpleSymbol = getSimpleNameAtPosition(vscode, document, position) || qualifiedSymbol;
            const parsedDocument = workspaceIndex.getParsedDocument(document);
            let declarations = findScopedDocumentDeclarations(
                parsedDocument.declarations,
                qualifiedSymbol.name,
                position.line,
                position.character
            );

            if (declarations.length === 0) {
                declarations = findScopedDocumentDeclarations(
                    parsedDocument.declarations,
                    simpleSymbol.name,
                    position.line,
                    position.character
                );
            }

            let locations = declarations.map((declaration) =>
                new vscode.Location(document.uri, declarationSelectionRange(vscode, declaration))
            );

            if (locations.length === 0) {
                let entries = await workspaceIndex.findDeclarations(qualifiedSymbol.name, token);
                if (entries.length === 0) {
                    entries = await workspaceIndex.findDeclarations(simpleSymbol.name, token);
                }
                locations = entries.map((entry) =>
                    new vscode.Location(entry.uri, declarationSelectionRange(vscode, entry.declaration))
                );
            }

            return locations.length > 0 ? locations : null;
        }
    };
}

function createReferenceProvider(vscode, workspaceIndex) {
    return {
        async provideReferences(document, position, context, token) {
            const symbol = getSimpleNameAtPosition(vscode, document, position);
            if (!symbol) {
                return null;
            }

            const parsedDocument = workspaceIndex.getParsedDocument(document);
            const localDeclarations = findScopedDocumentDeclarations(
                parsedDocument.declarations,
                symbol.name,
                position.line,
                position.character
            ).filter((declaration) => getCallableParent(declaration));
            if (localDeclarations.length === 1) {
                const scope = getCallableParent(localDeclarations[0]);
                return parsedDocument.occurrences
                    .filter((occurrence) =>
                        normalizeIdentifier(occurrence.name) === normalizeIdentifier(symbol.name) &&
                        occurrence.line >= scope.line &&
                        occurrence.line <= scope.endLine &&
                        (context.includeDeclaration || !isLocalDeclarationOccurrence(
                            occurrence,
                            localDeclarations[0]
                        ))
                    )
                    .map((occurrence) => new vscode.Location(
                        document.uri,
                        occurrenceRange(vscode, occurrence)
                    ));
            }
            if (localDeclarations.length > 1) {
                return null;
            }

            const declarationEntries = await workspaceIndex.findDeclarations(symbol.name, token);
            if (declarationEntries.length !== 1) {
                return null;
            }

            const occurrences = await workspaceIndex.findOccurrences(symbol.name, token);
            return occurrences
                .filter((entry) => context.includeDeclaration || !isDeclarationOccurrence(entry, declarationEntries))
                .map((entry) => new vscode.Location(
                    entry.uri,
                    occurrenceRange(vscode, entry.occurrence)
                ));
        }
    };
}

function createRenameProvider(vscode, workspaceIndex) {
    return {
        async prepareRename(document, position, token) {
            const symbol = getSimpleNameAtPosition(vscode, document, position);
            if (!symbol) {
                throw new Error("No FreeBASIC identifier is selected.");
            }

            const parsedDocument = workspaceIndex.getParsedDocument(document);
            const localDeclarations = findScopedDocumentDeclarations(
                parsedDocument.declarations,
                symbol.name,
                position.line,
                position.character
            ).filter((declaration) => getCallableParent(declaration));
            if (localDeclarations.length === 1) {
                return { range: symbol.range, placeholder: symbol.name };
            }
            if (localDeclarations.length > 1) {
                throw new Error("Rename requires one unambiguous declaration in the current procedure.");
            }

            const declarations = await workspaceIndex.findDeclarations(symbol.name, token);
            if (declarations.length !== 1) {
                throw new Error("Rename requires one unambiguous indexed declaration.");
            }

            return { range: symbol.range, placeholder: symbol.name };
        },

        async provideRenameEdits(document, position, newName, token) {
            if (!new RegExp(`^${IDENTIFIER_PATTERN.source}$`).test(newName)) {
                throw new Error("The new name is not a valid FreeBASIC identifier.");
            }

            const symbol = getSimpleNameAtPosition(vscode, document, position);
            if (!symbol) {
                return null;
            }

            const parsedDocument = workspaceIndex.getParsedDocument(document);
            const localDeclarations = findScopedDocumentDeclarations(
                parsedDocument.declarations,
                symbol.name,
                position.line,
                position.character
            ).filter((declaration) => getCallableParent(declaration));
            if (localDeclarations.length === 1) {
                const scope = getCallableParent(localDeclarations[0]);
                const localEdit = new vscode.WorkspaceEdit();
                for (const occurrence of parsedDocument.occurrences) {
                    if (
                        normalizeIdentifier(occurrence.name) === normalizeIdentifier(symbol.name) &&
                        occurrence.line >= scope.line &&
                        occurrence.line <= scope.endLine
                    ) {
                        localEdit.replace(
                            document.uri,
                            occurrenceRange(vscode, occurrence),
                            newName
                        );
                    }
                }
                return localEdit;
            }
            if (localDeclarations.length > 1) {
                return null;
            }

            const declarations = await workspaceIndex.findDeclarations(symbol.name, token);
            if (declarations.length !== 1) {
                return null;
            }

            const edit = new vscode.WorkspaceEdit();
            const occurrences = await workspaceIndex.findOccurrences(symbol.name, token);
            for (const entry of occurrences) {
                edit.replace(entry.uri, occurrenceRange(vscode, entry.occurrence), newName);
            }
            return edit;
        }
    };
}

function createDocumentHighlightProvider(vscode, workspaceIndex) {
    return {
        provideDocumentHighlights(document, position) {
            const symbol = getSimpleNameAtPosition(vscode, document, position);
            if (!symbol) {
                return null;
            }

            const parsedDocument = workspaceIndex.getParsedDocument(document);
            const localDeclarations = findScopedDocumentDeclarations(
                parsedDocument.declarations,
                symbol.name,
                position.line,
                position.character
            ).filter((declaration) => getCallableParent(declaration));
            const scope = localDeclarations.length === 1
                ? getCallableParent(localDeclarations[0])
                : null;

            return parsedDocument.occurrences
                .filter((occurrence) => normalizeIdentifier(occurrence.name) === normalizeIdentifier(symbol.name))
                .filter((occurrence) => !scope || (
                    occurrence.line >= scope.line && occurrence.line <= scope.endLine
                ))
                .map((occurrence) => new vscode.DocumentHighlight(
                    occurrenceRange(vscode, occurrence),
                    vscode.DocumentHighlightKind.Text
                ));
        }
    };
}

/* ------------------------------------------------------------------------- */
/* Signatures, folding, and include links                                     */
/* ------------------------------------------------------------------------- */

function createSignatureHelpProvider(vscode, workspaceIndex) {
    return {
        async provideSignatureHelp(document, position, token) {
            const callContext = findCallContext(document.getText(), document.offsetAt(position));
            if (!callContext) {
                return null;
            }

            const parsedDocument = workspaceIndex.getParsedDocument(document);
            let declarations = findDeclarationsByName(parsedDocument.declarations, callContext.name)
                .filter(isCallableDeclaration);

            if (declarations.length === 0) {
                const entries = await workspaceIndex.findDeclarations(callContext.name, token);
                declarations = entries.map((entry) => entry.declaration).filter(isCallableDeclaration);
            }

            if (declarations.length === 0) {
                return null;
            }

            const signatureHelp = new vscode.SignatureHelp();
            signatureHelp.activeSignature = 0;
            signatureHelp.signatures = declarations.map((declaration) => {
                const signature = new vscode.SignatureInformation(declaration.signature);
                signature.parameters = declaration.parameters.map((parameter) =>
                    new vscode.ParameterInformation(parameter.label)
                );
                return signature;
            });
            const parameterCount = signatureHelp.signatures[0].parameters.length;
            signatureHelp.activeParameter = parameterCount === 0
                ? 0
                : Math.min(callContext.activeParameter, parameterCount - 1);
            return signatureHelp;
        }
    };
}

function createFoldingRangeProvider(vscode, workspaceIndex) {
    return {
        provideFoldingRanges(document) {
            const parsedDocument = workspaceIndex.getParsedDocument(document);
            return parsedDocument.foldingRanges.map((range) => new vscode.FoldingRange(
                range.startLine,
                range.endLine,
                range.kind === "region" ? vscode.FoldingRangeKind.Region : undefined
            ));
        }
    };
}

function createDocumentLinkProvider(vscode, workspaceIndex) {
    return {
        provideDocumentLinks(document) {
            if (document.uri.scheme !== "file") {
                return [];
            }

            const parsedDocument = workspaceIndex.getParsedDocument(document);
            const links = [];

            for (const include of parsedDocument.includes) {
                const targetPath = resolveIncludePath(vscode, document.uri.fsPath, include);
                if (!targetPath) {
                    continue;
                }

                const link = new vscode.DocumentLink(
                    new vscode.Range(
                        include.line,
                        include.startColumn,
                        include.line,
                        include.endColumn
                    ),
                    vscode.Uri.file(targetPath)
                );
                link.tooltip = `Open ${include.path}`;
                links.push(link);
            }

            return links;
        }
    };
}

function resolveIncludePath(vscode, documentPath, include) {
    const configuration = vscode.workspace.getConfiguration("freebasic", vscode.Uri.file(documentPath));
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(documentPath));
    const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : "";
    const configuredPaths = configuration.get("includePaths", []);
    const searchDirectories = [];

    if (!include.system) {
        searchDirectories.push(path.dirname(documentPath));
    }

    for (const configuredPath of configuredPaths) {
        if (typeof configuredPath !== "string" || !configuredPath.trim()) {
            continue;
        }
        searchDirectories.push(configuredPath.replace(/\$\{workspaceFolder\}/g, workspacePath));
    }

    if (workspacePath) {
        searchDirectories.push(workspacePath);
    }

    for (const searchDirectory of searchDirectories) {
        const candidate = path.resolve(searchDirectory, include.path);
        try {
            if (fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch (error) {
            /* A missing or concurrently removed include is not linkable. */
        }
    }

    return null;
}

/* ------------------------------------------------------------------------- */
/* Mapping and visibility helpers                                             */
/* ------------------------------------------------------------------------- */

function createDocumentSymbolTree(vscode, document, declarations) {
    const symbolByDeclaration = new Map();
    const roots = [];

    for (const declaration of declarations) {
        const symbol = new vscode.DocumentSymbol(
            declaration.name,
            declaration.detail,
            declarationTypeToSymbolKind(vscode, declaration.type),
            declarationFullRange(vscode, document, declaration),
            declarationSelectionRange(vscode, declaration)
        );
        symbolByDeclaration.set(declaration, symbol);

        const parentSymbol = symbolByDeclaration.get(declaration.parentDeclaration);
        if (parentSymbol) {
            parentSymbol.children.push(symbol);
        } else {
            roots.push(symbol);
        }
    }

    return roots;
}

function createDeclarationMarkdown(vscode, declarations, uri) {
    const markdown = new vscode.MarkdownString();

    for (let index = 0; index < declarations.length; index++) {
        if (index > 0) {
            markdown.appendMarkdown("\n\n---\n\n");
        }
        markdown.appendCodeblock(declarations[index].signature, "freebasic");
        markdown.appendMarkdown(`\nDeclared on line ${declarations[index].line + 1} in \`${path.basename(uri.fsPath || uri.path)}\`.`);
    }
    return markdown;
}

function createWorkspaceDeclarationMarkdown(vscode, entries) {
    const markdown = new vscode.MarkdownString();

    for (let index = 0; index < Math.min(entries.length, 5); index++) {
        const entry = entries[index];
        if (index > 0) {
            markdown.appendMarkdown("\n\n---\n\n");
        }
        markdown.appendCodeblock(entry.declaration.signature, "freebasic");
        markdown.appendMarkdown(`\nDeclared in \`${path.basename(entry.uri.fsPath || entry.uri.path)}\` on line ${entry.declaration.line + 1}.`);
    }
    return markdown;
}

function getQualifiedSymbolAtPosition(vscode, document, position) {
    const lineText = document.lineAt(position.line).text;

    for (const match of lineText.matchAll(QUALIFIED_IDENTIFIER_PATTERN)) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character >= start && position.character <= end) {
            return {
                name: match[0],
                range: new vscode.Range(position.line, start, position.line, end)
            };
        }
    }

    return null;
}

function getSimpleNameAtPosition(vscode, document, position) {
    const range = document.getWordRangeAtPosition(position, IDENTIFIER_PATTERN);
    if (!range) {
        return null;
    }
    return { name: document.getText(range), range };
}

function declarationSelectionRange(vscode, declaration) {
    return new vscode.Range(
        declaration.line,
        declaration.startColumn,
        declaration.line,
        declaration.endColumn
    );
}

function declarationFullRange(vscode, document, declaration) {
    const safeEndLine = Math.min(declaration.endLine, Math.max(0, document.lineCount - 1));
    return new vscode.Range(
        declaration.line,
        0,
        safeEndLine,
        document.lineAt(safeEndLine).text.length
    );
}

function occurrenceRange(vscode, occurrence) {
    return new vscode.Range(
        occurrence.line,
        occurrence.startColumn,
        occurrence.line,
        occurrence.endColumn
    );
}

function isDeclarationOccurrence(occurrenceEntry, declarationEntries) {
    return declarationEntries.some((declarationEntry) =>
        declarationEntry.uri.toString() === occurrenceEntry.uri.toString() &&
        declarationEntry.declaration.line === occurrenceEntry.occurrence.line &&
        declarationEntry.declaration.startColumn === occurrenceEntry.occurrence.startColumn
    );
}

function isLocalDeclarationOccurrence(occurrence, declaration) {
    return declaration.line === occurrence.line &&
        declaration.startColumn === occurrence.startColumn;
}

function findScopedDocumentDeclarations(declarations, name, line, character = -1) {
    const matches = findDeclarationsByName(declarations, name);
    const exactMatches = matches.filter((declaration) =>
        declaration.line === line &&
        character >= declaration.startColumn &&
        character <= declaration.endColumn
    );
    if (exactMatches.length > 0) {
        return exactMatches;
    }

    const localMatches = matches.filter((declaration) => {
        const callableParent = getCallableParent(declaration);
        return callableParent && line >= callableParent.line && line <= callableParent.endLine;
    });
    if (localMatches.length > 0) {
        return localMatches;
    }

    return matches.filter((declaration) => !getCallableParent(declaration));
}

function getCallableParent(declaration) {
    let parent = declaration.parentDeclaration;
    while (parent) {
        if (isCallableDeclaration(parent)) {
            return parent;
        }
        parent = parent.parentDeclaration;
    }
    return null;
}

function isDeclarationVisibleAtLine(declaration, line) {
    if (declaration.localOnly && line < declaration.line) {
        return false;
    }

    let parent = declaration.parentDeclaration;
    while (parent) {
        if (isCallableDeclaration(parent)) {
            return line >= parent.line && line <= parent.endLine;
        }
        parent = parent.parentDeclaration;
    }
    return true;
}

function isWorkspaceVisibleDeclaration(declaration) {
    if (declaration.localOnly) {
        return false;
    }

    let parent = declaration.parentDeclaration;
    while (parent) {
        if (isCallableDeclaration(parent)) {
            return false;
        }
        parent = parent.parentDeclaration;
    }
    return declaration.type !== "label";
}

function isCallableDeclaration(declaration) {
    return [
        "constructor",
        "destructor",
        "function",
        "macro",
        "operator",
        "property",
        "sub"
    ].includes(declaration.type);
}

function declarationTypeToCompletionKind(vscode, type) {
    switch (type) {
        case "class": return vscode.CompletionItemKind.Class;
        case "const": return vscode.CompletionItemKind.Constant;
        case "constructor": return vscode.CompletionItemKind.Constructor;
        case "enum": return vscode.CompletionItemKind.Enum;
        case "enumMember": return vscode.CompletionItemKind.EnumMember;
        case "field": return vscode.CompletionItemKind.Field;
        case "function":
        case "operator":
        case "sub": return vscode.CompletionItemKind.Function;
        case "macro": return vscode.CompletionItemKind.Snippet;
        case "namespace": return vscode.CompletionItemKind.Module;
        case "property": return vscode.CompletionItemKind.Property;
        case "type":
        case "union": return vscode.CompletionItemKind.Struct;
        default: return vscode.CompletionItemKind.Variable;
    }
}

function declarationTypeToSymbolKind(vscode, type) {
    switch (type) {
        case "class": return vscode.SymbolKind.Class;
        case "const": return vscode.SymbolKind.Constant;
        case "constructor": return vscode.SymbolKind.Constructor;
        case "enum": return vscode.SymbolKind.Enum;
        case "enumMember": return vscode.SymbolKind.EnumMember;
        case "field": return vscode.SymbolKind.Field;
        case "function": return vscode.SymbolKind.Function;
        case "label": return vscode.SymbolKind.Key;
        case "macro": return vscode.SymbolKind.String;
        case "namespace": return vscode.SymbolKind.Namespace;
        case "operator":
        case "sub": return vscode.SymbolKind.Method;
        case "property": return vscode.SymbolKind.Property;
        case "type":
        case "union": return vscode.SymbolKind.Struct;
        default: return vscode.SymbolKind.Variable;
    }
}

module.exports = {
    createDocumentSymbolTree,
    createEditorFeatures,
    declarationTypeToCompletionKind,
    declarationTypeToSymbolKind,
    findScopedDocumentDeclarations,
    getCallableParent,
    getBuiltInHover,
    getQualifiedSymbolAtPosition,
    getSimpleNameAtPosition,
    isCallableDeclaration,
    isDeclarationVisibleAtLine,
    isWorkspaceVisibleDeclaration,
    resolveIncludePath
};

/* end of lib/editor-features.js */
