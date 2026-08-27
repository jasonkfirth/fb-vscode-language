/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/freebasic-parser.js

    Purpose:

        Provide conservative, editor-oriented analysis for FreeBASIC source.

    Responsibilities:

        - mask strings and comments without changing source positions
        - trace common declarations, parameters, containers, and includes
        - identify symbol occurrences and callable context
        - derive block ranges for folding and document structure

    This file intentionally does NOT contain:

        - compiler-grade syntax or type checking
        - filesystem or workspace access
        - VS Code API objects
*/

const IDENTIFIER_SOURCE = "[A-Za-z_][A-Za-z0-9_]*(?:[$%!#&])?";
const QUALIFIED_IDENTIFIER_SOURCE = `${IDENTIFIER_SOURCE}(?:\\.${IDENTIFIER_SOURCE})*`;

const DECLARATION_MODIFIERS = new Set([
    "ABSTRACT",
    "COMMON",
    "CONST",
    "DECLARE",
    "EXPORT",
    "EXTERN",
    "OVERRIDE",
    "PRESERVE",
    "PRIVATE",
    "PROTECTED",
    "PUBLIC",
    "SHARED",
    "STATIC",
    "VIRTUAL"
]);

const CONTAINER_TYPES = new Set([
    "class",
    "constructor",
    "destructor",
    "enum",
    "function",
    "macro",
    "namespace",
    "operator",
    "property",
    "sub",
    "type",
    "union"
]);

/* ------------------------------------------------------------------------- */
/* Public analysis entry points                                               */
/* ------------------------------------------------------------------------- */

function parseFreeBasicText(text) {
    const declarations = [];
    const includes = [];
    const blockStack = [];
    const logicalLines = createLogicalLines(text);

    for (const logicalLine of logicalLines) {
        const codeLine = logicalLine.visibleText.trim();
        const maskedLine = logicalLine.maskedText.trim();

        if (!maskedLine) {
            continue;
        }

        if (closeDeclarationBlock(maskedLine, logicalLine.endLine, blockStack)) {
            continue;
        }

        const parentDeclaration = getParentDeclaration(blockStack);
        const containerPath = getContainerPath(blockStack);

        const include = parseIncludeLine(logicalLine);
        if (include) {
            includes.push(include);
            continue;
        }

        const macroMatch = maskedLine.match(
            new RegExp(`^#(define|macro)\\s+(${IDENTIFIER_SOURCE})`, "i")
        );
        if (macroMatch) {
            const macroKind = macroMatch[1].toLowerCase();
            const parameterText = macroKind === "macro"
                ? extractParenthesizedText(codeLine, macroMatch.index + macroMatch[0].length)
                : "";
            const declaration = addDeclaration(declarations, logicalLine, {
                name: macroMatch[2],
                type: "macro",
                detail: macroKind === "macro" ? "Preprocessor macro block" : "Preprocessor macro",
                containerPath,
                parentDeclaration,
                parameters: parseParameters(parameterText)
            });
            addParameterDeclarations(
                declarations,
                logicalLine,
                declaration,
                containerPath
            );

            if (macroKind === "macro") {
                pushDeclarationBlock(blockStack, declaration, "macro", logicalLine.startLine);
            }
            continue;
        }

        const namespaceMatch = maskedLine.match(
            new RegExp(`^namespace\\s+(${QUALIFIED_IDENTIFIER_SOURCE})`, "i")
        );
        if (namespaceMatch) {
            const declaration = addDeclaration(declarations, logicalLine, {
                name: namespaceMatch[1],
                type: "namespace",
                detail: "Namespace",
                containerPath,
                parentDeclaration
            });
            pushDeclarationBlock(blockStack, declaration, "namespace", logicalLine.startLine);
            continue;
        }

        if (/^(?:(?:public|private|protected)\s+)?enum\s*$/i.test(maskedLine)) {
            blockStack.push({ declaration: null, kind: "enum", startLine: logicalLine.startLine });
            continue;
        }

        const aggregateMatch = maskedLine.match(
            new RegExp(`^(?:(?:public|private|protected)\\s+)?(type|class|union|enum)\\s+(${IDENTIFIER_SOURCE})\\b`, "i")
        );
        if (aggregateMatch) {
            const aggregateType = aggregateMatch[1].toLowerCase();
            const isTypeAlias = aggregateType === "type" && /\bas\b/i.test(
                maskedLine.slice(aggregateMatch[0].length)
            );
            const declaration = addDeclaration(declarations, logicalLine, {
                name: aggregateMatch[2],
                type: aggregateType,
                detail: isTypeAlias ? "Type alias" : titleCase(aggregateType),
                containerPath,
                parentDeclaration
            });

            if (!isTypeAlias) {
                pushDeclarationBlock(blockStack, declaration, aggregateType, logicalLine.startLine);
            }
            continue;
        }

        const procedure = parseProcedureDeclaration(
            logicalLine,
            declarations,
            blockStack,
            containerPath,
            parentDeclaration
        );
        if (procedure) {
            continue;
        }

        if (isInsideBlock(blockStack, "enum")) {
            const enumMemberMatch = maskedLine.match(new RegExp(`^(${IDENTIFIER_SOURCE})\\b`, "i"));
            if (enumMemberMatch && !/^end\b/i.test(maskedLine)) {
                addDeclaration(declarations, logicalLine, {
                    name: enumMemberMatch[1],
                    type: "enumMember",
                    detail: "Enum member",
                    containerPath,
                    parentDeclaration
                });
                continue;
            }
        }

        if (/^(?:(?:public|private|protected)\s+)?const\b/i.test(maskedLine)) {
            declarations.push(...parseConstLine(
                logicalLine,
                codeLine,
                containerPath,
                parentDeclaration
            ));
            continue;
        }

        if (/^(?:(?:public|private|protected|shared|static|common|extern)\s+)*(?:dim|static|common|extern|redim)\b/i.test(maskedLine)) {
            declarations.push(...parseVariableLine(
                logicalLine,
                codeLine,
                containerPath,
                parentDeclaration
            ));
            continue;
        }

        if (/^var\b/i.test(maskedLine)) {
            const autoMatch = maskedLine.match(new RegExp(`^var\\s+(${IDENTIFIER_SOURCE})`, "i"));
            if (autoMatch) {
                addDeclaration(declarations, logicalLine, {
                    name: autoMatch[1],
                    type: "variable",
                    detail: "Inferred variable",
                    containerPath,
                    parentDeclaration
                });
            }
            continue;
        }

        const loopVariableMatch = maskedLine.match(
            new RegExp(`^for\\s+(${IDENTIFIER_SOURCE})\\s+as\\s+([^=]+?)\\s*=`, "i")
        );
        if (loopVariableMatch) {
            addDeclaration(declarations, logicalLine, {
                name: loopVariableMatch[1],
                type: "variable",
                detail: `Loop variable As ${loopVariableMatch[2].trim()}`,
                containerPath,
                parentDeclaration,
                localOnly: true
            });
            continue;
        }

        if (isInsideAggregate(blockStack) && /^(?:public|private|protected)\s*:\s*$/i.test(maskedLine)) {
            continue;
        }

        if (isInsideAggregate(blockStack)) {
            const fields = parseAggregateFieldLine(
                logicalLine,
                codeLine,
                containerPath,
                parentDeclaration
            );
            if (fields.length > 0) {
                declarations.push(...fields);
                continue;
            }
        }

        const labelMatch = maskedLine.match(new RegExp(`^(${IDENTIFIER_SOURCE}|\\d+)\\s*:`));
        if (labelMatch) {
            addDeclaration(declarations, logicalLine, {
                name: labelMatch[1],
                type: "label",
                detail: "Label",
                containerPath,
                parentDeclaration
            });
        }

    }

    const lastLine = Math.max(0, text.split(/\r?\n/).length - 1);
    while (blockStack.length > 0) {
        const block = blockStack.pop();
        if (block.declaration) {
            block.declaration.endLine = lastLine;
        }
    }

    return {
        declarations,
        foldingRanges: findFoldingRanges(text),
        includes,
        occurrences: findIdentifierOccurrences(text)
    };
}

function findDeclarationByName(declarations, name) {
    const normalizedName = normalizeIdentifier(name);
    const exactQualifiedMatch = declarations.find(
        (declaration) => normalizeIdentifier(declaration.qualifiedName) === normalizedName
    );

    if (exactQualifiedMatch) {
        return exactQualifiedMatch;
    }

    return declarations.find(
        (declaration) => normalizeIdentifier(declaration.name) === normalizedName
    ) || null;
}

function findDeclarationsByName(declarations, name) {
    const normalizedName = normalizeIdentifier(name);
    return declarations.filter((declaration) =>
        normalizeIdentifier(declaration.name) === normalizedName ||
        normalizeIdentifier(declaration.qualifiedName) === normalizedName
    );
}

function findIdentifierOccurrences(text) {
    const occurrences = [];
    const scanState = { inBlockComment: false };
    const lines = text.split(/\r?\n/);
    const identifierPattern = new RegExp(IDENTIFIER_SOURCE, "g");

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const scanned = scanLine(lines[lineIndex], scanState);

        for (const match of scanned.maskedText.matchAll(identifierPattern)) {
            occurrences.push({
                name: match[0],
                line: lineIndex,
                startColumn: match.index,
                endColumn: match.index + match[0].length
            });
        }
    }

    return occurrences;
}

function findCallContext(text, offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
        return null;
    }

    const maskedText = maskFreeBasicText(text);
    let nestedParentheses = 0;
    let activeParameter = 0;

    for (let index = offset - 1; index >= 0; index--) {
        const character = maskedText[index];

        if (character === ")") {
            nestedParentheses++;
            continue;
        }

        if (character === "(") {
            if (nestedParentheses > 0) {
                nestedParentheses--;
                continue;
            }

            const beforeCall = maskedText.slice(0, index);
            const nameMatch = beforeCall.match(
                new RegExp(`(${QUALIFIED_IDENTIFIER_SOURCE})\\s*$`, "i")
            );
            if (!nameMatch) {
                return null;
            }

            return {
                activeParameter,
                name: nameMatch[1],
                openParenthesisOffset: index
            };
        }

        if (character === "," && nestedParentheses === 0) {
            activeParameter++;
        }

        if ((character === "\n" || character === "\r") && nestedParentheses === 0) {
            const precedingLine = maskedText.slice(0, index).trimEnd();
            if (!precedingLine.endsWith("_")) {
                return null;
            }
        }
    }

    return null;
}

function findFoldingRanges(text) {
    const ranges = [];
    const stack = [];
    const scanState = { inBlockComment: false };
    const lines = text.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const startedInsideBlockComment = scanState.inBlockComment;
        const scanned = scanLine(lines[lineIndex], scanState);
        const codeLine = scanned.maskedText.trim();

        if (!startedInsideBlockComment && /^\s*(?:'|REM\b)\s*#endregion\b/i.test(lines[lineIndex])) {
            closeFoldingBlock(stack, ranges, "commentRegion", lineIndex);
            continue;
        }

        if (!startedInsideBlockComment && /^\s*(?:'|REM\b)\s*#region\b/i.test(lines[lineIndex])) {
            stack.push({ kind: "commentRegion", startLine: lineIndex });
            continue;
        }

        if (!codeLine) {
            continue;
        }

        const closeKind = getFoldingCloseKind(codeLine);
        if (closeKind) {
            closeFoldingBlock(stack, ranges, closeKind, lineIndex);
        }

        const openKind = getFoldingOpenKind(codeLine);
        if (openKind) {
            stack.push({ kind: openKind, startLine: lineIndex });
        }
    }

    return ranges.sort((left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine
    );
}

/* ------------------------------------------------------------------------- */
/* Declaration parsing                                                        */
/* ------------------------------------------------------------------------- */

function parseProcedureDeclaration(
    logicalLine,
    declarations,
    blockStack,
    containerPath,
    parentDeclaration
) {
    const codeLine = logicalLine.visibleText.trim();
    const regularPattern = new RegExp(
        `^((?:(?:abstract|const|declare|export|override|private|protected|public|static|virtual)\\s+)*)` +
        `(sub|function|property)\\s+(${QUALIFIED_IDENTIFIER_SOURCE})`,
        "i"
    );
    const regularMatch = codeLine.match(regularPattern);

    if (regularMatch) {
        const modifiers = parseModifiers(regularMatch[1]);
        const procedureType = regularMatch[2].toLowerCase();
        const parameterText = extractParenthesizedText(codeLine, regularMatch.index + regularMatch[0].length);
        const resultType = extractProcedureResultType(codeLine);
        const detail = resultType
            ? `${titleCase(procedureType)} As ${resultType}`
            : titleCase(procedureType);
        const declaration = addDeclaration(declarations, logicalLine, {
            name: regularMatch[3],
            type: procedureType,
            detail,
            containerPath,
            parentDeclaration,
            parameters: parseParameters(parameterText),
            modifiers: [...modifiers]
        });
        addParameterDeclarations(
            declarations,
            logicalLine,
            declaration,
            containerPath
        );

        if (!modifiers.has("DECLARE") && !isSingleLineProcedure(codeLine, procedureType)) {
            pushDeclarationBlock(blockStack, declaration, procedureType, logicalLine.startLine);
        }
        return declaration;
    }

    const specialPattern = /^((?:(?:abstract|const|declare|export|override|private|protected|public|static|virtual)\s+)*)(constructor|destructor|operator)\b\s*([^\s(]*)/i;
    const specialMatch = codeLine.match(specialPattern);
    if (!specialMatch) {
        return null;
    }

    const modifiers = parseModifiers(specialMatch[1]);
    const procedureType = specialMatch[2].toLowerCase();
    const suffix = specialMatch[3].trim();
    const name = suffix
        ? `${titleCase(procedureType)} ${suffix}`
        : titleCase(procedureType);
    const parameterText = extractParenthesizedText(codeLine, specialMatch.index + specialMatch[0].length);
    const declaration = addDeclaration(declarations, logicalLine, {
        name,
        type: procedureType,
        detail: titleCase(procedureType),
        containerPath,
        parentDeclaration,
        parameters: parseParameters(parameterText),
        modifiers: [...modifiers]
    });
    addParameterDeclarations(
        declarations,
        logicalLine,
        declaration,
        containerPath
    );

    if (!modifiers.has("DECLARE") && !isSingleLineProcedure(codeLine, procedureType)) {
        pushDeclarationBlock(blockStack, declaration, procedureType, logicalLine.startLine);
    }
    return declaration;
}

function parseParameters(parameterText) {
    if (!parameterText || !parameterText.trim()) {
        return [];
    }

    return splitTopLevel(parameterText, ",").map((parameterTextPart, index) => {
        const source = parameterTextPart.trim();
        const withoutModifiers = source.replace(
            /^(?:(?:byval|byref|bydesc|const|optional|paramarray)\s+)*/i,
            ""
        );
        const nameMatch = withoutModifiers.match(new RegExp(`^(${IDENTIFIER_SOURCE})`));
        const typeMatch = source.match(/\bas\s+(.+?)(?:\s*=|$)/i);

        return {
            label: source,
            name: nameMatch ? nameMatch[1] : `parameter${index + 1}`,
            typeName: typeMatch ? typeMatch[1].trim() : ""
        };
    });
}

function addParameterDeclarations(
    declarations,
    logicalLine,
    procedureDeclaration,
    containerPath
) {
    let searchLine = procedureDeclaration.line;
    let searchColumn = procedureDeclaration.endColumn;

    for (const parameter of procedureDeclaration.parameters) {
        if (/^parameter\d+$/i.test(parameter.name)) {
            continue;
        }

        const location = findNameLocation(
            logicalLine,
            parameter.name.toLowerCase(),
            searchLine,
            searchColumn
        );
        if (!location) {
            continue;
        }

        addDeclaration(declarations, logicalLine, {
            name: parameter.name,
            type: "parameter",
            detail: parameter.typeName ? `Parameter As ${parameter.typeName}` : "Parameter",
            containerPath: [...containerPath, procedureDeclaration.name],
            parentDeclaration: procedureDeclaration,
            location,
            rangeEndLine: location.line
        });
        searchLine = location.line;
        searchColumn = location.endColumn;
    }
}

function parseConstLine(logicalLine, codeLine, containerPath, parentDeclaration) {
    let declarationText = codeLine.replace(
        /^(?:(?:public|private|protected)\s+)?const\b/i,
        ""
    ).trim();
    let commonType = "";
    const leadingType = extractLeadingCommonType(declarationText);
    if (leadingType) {
        commonType = leadingType.typeName;
        declarationText = leadingType.declarationText;
    }

    const declarations = [];
    for (const part of splitTopLevel(declarationText, ",")) {
        const nameMatch = part.trim().match(new RegExp(`^(${IDENTIFIER_SOURCE})`));
        if (!nameMatch) {
            continue;
        }

        const typeMatch = part.match(/\bas\s+(.+?)(?:\s*=|$)/i);
        declarations.push(createDeclaration(logicalLine, {
            name: nameMatch[1],
            type: "const",
            detail: typeMatch || commonType
                ? `Const As ${typeMatch ? typeMatch[1].trim() : commonType}`
                : "Const",
            containerPath,
            parentDeclaration
        }));
    }

    return declarations;
}

function parseVariableLine(logicalLine, codeLine, containerPath, parentDeclaration) {
    let rest = codeLine.trim();
    let declarationKind = "variable";

    while (true) {
        const firstWordMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\b\s*/);
        if (!firstWordMatch) {
            break;
        }

        const firstWord = firstWordMatch[1].toUpperCase();
        if (firstWord === "DIM" || firstWord === "REDIM") {
            rest = rest.slice(firstWordMatch[0].length);
            continue;
        }

        if (firstWord === "EXTERN") {
            declarationKind = "extern";
        }

        if (!DECLARATION_MODIFIERS.has(firstWord) && firstWord !== "STATIC") {
            break;
        }
        rest = rest.slice(firstWordMatch[0].length);
    }

    return parseVariableDeclarationText(
        logicalLine,
        rest.trim(),
        declarationKind,
        containerPath,
        parentDeclaration
    );
}

function parseDimLine(lineIndex, sourceLine, codeLine, namespaceStack) {
    const logicalLine = {
        startLine: lineIndex,
        endLine: lineIndex,
        sourceLine,
        visibleText: codeLine,
        signature: sourceLine.trim()
    };
    return parseVariableLine(logicalLine, codeLine, namespaceStack, null);
}

function parseVariableDeclarationText(
    logicalLine,
    declarationText,
    declarationKind,
    containerPath,
    parentDeclaration
) {
    let commonType = "";
    let variableList = declarationText;
    const leadingTypeMatch = extractLeadingCommonType(variableList);

    if (leadingTypeMatch) {
        commonType = leadingTypeMatch.typeName;
        variableList = leadingTypeMatch.declarationText;
    }

    const declarations = [];
    for (const part of splitTopLevel(variableList, ",")) {
        const name = extractVariableName(part);
        if (!name) {
            continue;
        }

        const typeMatch = part.match(/\bas\s+(.+?)(?:\s*=|$)/i);
        const typeName = typeMatch ? typeMatch[1].trim() : commonType;
        declarations.push(createDeclaration(logicalLine, {
            name,
            type: declarationKind,
            detail: typeName
                ? `${titleCase(declarationKind)} As ${typeName}`
                : titleCase(declarationKind),
            containerPath,
            parentDeclaration
        }));
    }

    return declarations;
}

function parseAggregateFieldLine(logicalLine, codeLine, containerPath, parentDeclaration) {
    if (/^(?:end|declare|constructor|destructor|operator|sub|function|property|static|const)\b/i.test(codeLine)) {
        return [];
    }

    return parseVariableDeclarationText(
        logicalLine,
        codeLine,
        "field",
        containerPath,
        parentDeclaration
    ).filter((declaration) => /\bas\b/i.test(codeLine));
}

function splitDimVariables(variableList) {
    const names = [];

    for (const part of splitTopLevel(variableList, ",")) {
        const name = extractVariableName(part);
        if (name) {
            names.push(name.replace(/[$%!#&]$/, ""));
        }
    }

    return names;
}

function extractVariableName(source) {
    let candidate = source.trim();

    if (/^as\b/i.test(candidate)) {
        return null;
    }

    const nameMatch = candidate.match(new RegExp(`^(${IDENTIFIER_SOURCE})`, "i"));
    if (!nameMatch) {
        return null;
    }

    return nameMatch[1];
}

function addDeclaration(declarations, logicalLine, options) {
    const declaration = createDeclaration(logicalLine, options);
    declarations.push(declaration);
    return declaration;
}

function createDeclaration(logicalLine, options) {
    const sourceLine = logicalLine.sourceLine || "";
    const lowerName = options.name.toLowerCase();
    const nameTail = lowerName.includes(" ") ? lowerName.split(/\s+/).at(-1) : lowerName;
    const selectionName = lowerName.includes(" ") ? nameTail : lowerName;
    const location = options.location || findNameLocation(logicalLine, selectionName);
    const declarationLine = location ? location.line : logicalLine.startLine;
    const declarationSourceLine = location ? location.sourceLine : sourceLine;
    let startColumn = location ? location.startColumn : 0;
    if (startColumn < 0) {
        startColumn = 0;
    }

    const containerPath = Array.isArray(options.containerPath)
        ? [...options.containerPath]
        : [];
    const qualifiedName = options.name.includes(".") || containerPath.length === 0
        ? options.name
        : `${containerPath.join(".")}.${options.name}`;

    return {
        name: options.name,
        qualifiedName,
        type: options.type,
        detail: options.detail,
        line: declarationLine,
        endLine: options.rangeEndLine ?? logicalLine.endLine,
        signatureEndLine: logicalLine.endLine,
        startColumn,
        endColumn: startColumn + selectionName.length,
        containerName: containerPath.join("."),
        containerPath,
        parentDeclaration: options.parentDeclaration || null,
        sourceLine: declarationSourceLine.trim(),
        signature: logicalLine.signature || sourceLine.trim(),
        parameters: options.parameters || [],
        modifiers: options.modifiers || [],
        localOnly: options.localOnly === true
    };
}

function findNameLocation(
    logicalLine,
    lowerName,
    startLine = logicalLine.startLine,
    startColumn = 0
) {
    const sourceLines = logicalLine.sourceLines || [logicalLine.sourceLine || ""];

    for (let lineOffset = Math.max(0, startLine - logicalLine.startLine); lineOffset < sourceLines.length; lineOffset++) {
        const sourceLine = sourceLines[lineOffset];
        const column = findNameColumn(
            sourceLine,
            lowerName,
            lineOffset === startLine - logicalLine.startLine ? startColumn : 0
        );
        if (column >= 0) {
            return {
                line: logicalLine.startLine + lineOffset,
                sourceLine,
                startColumn: column,
                endColumn: column + lowerName.length
            };
        }
    }

    return null;
}

function findNameColumn(sourceLine, lowerName, startColumn = 0) {
    const lowerLine = sourceLine.toLowerCase();
    let searchStart = Math.max(0, startColumn);

    while (searchStart <= lowerLine.length) {
        const index = lowerLine.indexOf(lowerName, searchStart);
        if (index < 0) {
            return -1;
        }

        const previousCharacter = index > 0 ? lowerLine[index - 1] : "";
        const nextCharacter = lowerLine[index + lowerName.length] || "";
        if (!/[a-z0-9_]/.test(previousCharacter) && !/[a-z0-9_]/.test(nextCharacter)) {
            return index;
        }
        searchStart = index + 1;
    }

    return -1;
}

/* ------------------------------------------------------------------------- */
/* Source scanning                                                            */
/* ------------------------------------------------------------------------- */

function createLogicalLines(text) {
    const logicalLines = [];
    const lines = text.split(/\r?\n/);
    const scanState = { inBlockComment: false };
    let pending = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const sourceLine = lines[lineIndex];
        const scanned = scanLine(sourceLine, scanState);
        const continues = /_\s*$/.test(scanned.maskedText);
        const visiblePart = continues
            ? scanned.visibleText.replace(/_\s*$/, "")
            : scanned.visibleText;
        const maskedPart = continues
            ? scanned.maskedText.replace(/_\s*$/, "")
            : scanned.maskedText;

        if (!pending) {
            pending = {
                startLine: lineIndex,
                endLine: lineIndex,
                sourceLine,
                sourceLines: [],
                visibleParts: [],
                maskedParts: []
            };
        }

        pending.endLine = lineIndex;
        pending.sourceLines.push(sourceLine);
        pending.visibleParts.push(visiblePart.trim());
        pending.maskedParts.push(maskedPart.trim());

        if (!continues) {
            const visibleText = pending.visibleParts.filter(Boolean).join(" ");
            const maskedText = pending.maskedParts.filter(Boolean).join(" ");
            logicalLines.push({
                startLine: pending.startLine,
                endLine: pending.endLine,
                sourceLine: pending.sourceLine,
                sourceLines: pending.sourceLines,
                visibleText,
                maskedText,
                signature: visibleText.replace(/\s+/g, " ").trim()
            });
            pending = null;
        }
    }

    if (pending) {
        const visibleText = pending.visibleParts.filter(Boolean).join(" ");
        logicalLines.push({
            startLine: pending.startLine,
            endLine: pending.endLine,
            sourceLine: pending.sourceLine,
            sourceLines: pending.sourceLines,
            visibleText,
            maskedText: pending.maskedParts.filter(Boolean).join(" "),
            signature: visibleText.replace(/\s+/g, " ").trim()
        });
    }

    return logicalLines;
}

function scanLine(line, state) {
    const visibleCharacters = [...line];
    const maskedCharacters = [...line];
    let inString = false;
    let escapedString = false;
    let index = 0;

    if (!Number.isInteger(state.blockCommentDepth)) {
        state.blockCommentDepth = state.inBlockComment ? 1 : 0;
    }

    while (index < line.length) {
        const character = line[index];
        const nextCharacter = line[index + 1] || "";

        if (state.blockCommentDepth > 0) {
            visibleCharacters[index] = " ";
            maskedCharacters[index] = " ";

            if (character === "/" && nextCharacter === "'") {
                visibleCharacters[index + 1] = " ";
                maskedCharacters[index + 1] = " ";
                state.blockCommentDepth++;
                index += 2;
            } else if (character === "'" && nextCharacter === "/") {
                visibleCharacters[index + 1] = " ";
                maskedCharacters[index + 1] = " ";
                state.blockCommentDepth--;
                index += 2;
            } else {
                index++;
            }
            continue;
        }

        if (inString) {
            maskedCharacters[index] = " ";

            if (escapedString && character === "\\" && nextCharacter) {
                maskedCharacters[index + 1] = " ";
                index += 2;
                continue;
            }

            if (character === "\"" && nextCharacter === "\"") {
                maskedCharacters[index + 1] = " ";
                index += 2;
                continue;
            }

            if (character === "\"") {
                inString = false;
                escapedString = false;
            }
            index++;
            continue;
        }

        if (character === "\"") {
            maskedCharacters[index] = " ";
            inString = true;
            escapedString = index > 0 && line[index - 1] === "!";
            index++;
            continue;
        }

        if (character === "/" && nextCharacter === "'") {
            visibleCharacters[index] = " ";
            visibleCharacters[index + 1] = " ";
            maskedCharacters[index] = " ";
            maskedCharacters[index + 1] = " ";
            state.blockCommentDepth = 1;
            index += 2;
            continue;
        }

        const remMatch = line.slice(index).match(/^rem\b/i);
        const previousCharacter = index > 0 ? line[index - 1] : "";
        if (remMatch && !/[A-Za-z0-9_]/.test(previousCharacter)) {
            for (let commentIndex = index; commentIndex < line.length; commentIndex++) {
                visibleCharacters[commentIndex] = " ";
                maskedCharacters[commentIndex] = " ";
            }
            break;
        }

        if (character === "'") {
            for (let commentIndex = index; commentIndex < line.length; commentIndex++) {
                visibleCharacters[commentIndex] = " ";
                maskedCharacters[commentIndex] = " ";
            }
            break;
        }

        index++;
    }

    state.inBlockComment = state.blockCommentDepth > 0;

    return {
        visibleText: visibleCharacters.join(""),
        maskedText: maskedCharacters.join("")
    };
}

function stripComments(line) {
    return scanLine(line, { inBlockComment: false }).visibleText.replace(/\s+$/, " ");
}

function maskFreeBasicText(text) {
    const state = { inBlockComment: false };
    return text.split(/\r?\n/)
        .map((line) => scanLine(line, state).maskedText)
        .join("\n");
}

/* ------------------------------------------------------------------------- */
/* Blocks, includes, and helper parsing                                       */
/* ------------------------------------------------------------------------- */

function parseIncludeLine(logicalLine) {
    const includeMatch = logicalLine.visibleText.match(
        /^\s*#include\s+(?:once\s+)?(["<])([^">]+)[">]/i
    );
    if (!includeMatch) {
        return null;
    }

    const startColumn = logicalLine.sourceLine.indexOf(includeMatch[2]);
    return {
        path: includeMatch[2],
        system: includeMatch[1] === "<",
        line: logicalLine.startLine,
        startColumn: Math.max(0, startColumn),
        endColumn: Math.max(0, startColumn) + includeMatch[2].length
    };
}

function pushDeclarationBlock(blockStack, declaration, kind, startLine) {
    blockStack.push({ declaration, kind, startLine });
}

function closeDeclarationBlock(codeLine, endLine, blockStack) {
    if (/^#endmacro\b/i.test(codeLine)) {
        return closeNamedDeclarationBlock("macro", endLine, blockStack);
    }

    const closeMatch = codeLine.match(/^end\s+(namespace|type|class|union|enum|sub|function|property|constructor|destructor|operator)\b/i);
    if (!closeMatch) {
        return false;
    }

    return closeNamedDeclarationBlock(closeMatch[1].toLowerCase(), endLine, blockStack);
}

function closeNamedDeclarationBlock(closeKind, endLine, blockStack) {
    for (let index = blockStack.length - 1; index >= 0; index--) {
        if (blockStack[index].kind !== closeKind) {
            continue;
        }

        const [block] = blockStack.splice(index, 1);
        if (block.declaration) {
            block.declaration.endLine = endLine;
        }
        return true;
    }

    return true;
}

function getParentDeclaration(blockStack) {
    for (let index = blockStack.length - 1; index >= 0; index--) {
        if (CONTAINER_TYPES.has(blockStack[index].kind) && blockStack[index].declaration) {
            return blockStack[index].declaration;
        }
    }
    return null;
}

function getContainerPath(blockStack) {
    return blockStack
        .filter((block) => CONTAINER_TYPES.has(block.kind) && block.declaration)
        .map((block) => block.declaration.name);
}

function isInsideBlock(blockStack, kind) {
    return blockStack.some((block) => block.kind === kind);
}

function isInsideAggregate(blockStack) {
    return blockStack.some((block) =>
        block.kind === "class" || block.kind === "type" || block.kind === "union"
    );
}

function parseModifiers(source) {
    return new Set(source.trim().split(/\s+/).filter(Boolean).map((word) => word.toUpperCase()));
}

function extractParenthesizedText(source, searchStart) {
    const openIndex = source.indexOf("(", Math.max(0, searchStart - 1));
    if (openIndex < 0) {
        return "";
    }

    let depth = 0;
    let inString = false;
    let escapedString = false;
    for (let index = openIndex; index < source.length; index++) {
        const character = source[index];
        const nextCharacter = source[index + 1] || "";

        if (inString) {
            if (escapedString && character === "\\" && nextCharacter) {
                index++;
                continue;
            }
            if (character === "\"" && nextCharacter === "\"") {
                index++;
            } else if (character === "\"") {
                inString = false;
                escapedString = false;
            }
            continue;
        }

        if (character === "\"") {
            inString = true;
            escapedString = index > 0 && source[index - 1] === "!";
        } else if (character === "(") {
            depth++;
        } else if (character === ")") {
            depth--;
            if (depth === 0) {
                return source.slice(openIndex + 1, index);
            }
        }
    }

    return source.slice(openIndex + 1);
}

function extractProcedureResultType(source) {
    const closeParenthesis = source.lastIndexOf(")");
    const suffix = closeParenthesis >= 0 ? source.slice(closeParenthesis + 1) : source;
    const match = suffix.match(/\b(?:byref\s+)?as\s+(.+?)(?=\s+(?:alias|cdecl|overload|pascal|stdcall)\b|$)/i);
    return match ? match[1].trim() : "";
}

function extractLeadingCommonType(source) {
    const typePattern = new RegExp(
        `^as\\s+((?:unsigned\\s+)?${QUALIFIED_IDENTIFIER_SOURCE}` +
        `(?:\\s+(?:ptr|pointer))*(?:\\s*\\*\\s*\\d+)?)\\s+(.+)$`,
        "i"
    );
    const match = source.match(typePattern);

    if (!match) {
        return null;
    }

    return {
        typeName: match[1].trim(),
        declarationText: match[2].trim()
    };
}

function isSingleLineProcedure(source, procedureType) {
    const endPattern = new RegExp(`:\\s*end\\s+${procedureType}\\b`, "i");
    return endPattern.test(source);
}

function splitTopLevel(source, separator) {
    const parts = [];
    let current = "";
    let depth = 0;
    let inString = false;
    let escapedString = false;

    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        const nextCharacter = source[index + 1] || "";

        if (inString) {
            current += character;
            if (escapedString && character === "\\" && nextCharacter) {
                current += nextCharacter;
                index++;
            } else if (character === "\"" && nextCharacter === "\"") {
                current += nextCharacter;
                index++;
            } else if (character === "\"") {
                inString = false;
                escapedString = false;
            }
            continue;
        }

        if (character === "\"") {
            inString = true;
            escapedString = index > 0 && source[index - 1] === "!";
            current += character;
        } else if (character === "(" || character === "[") {
            depth++;
            current += character;
        } else if (character === ")" || character === "]") {
            depth = Math.max(0, depth - 1);
            current += character;
        } else if (character === separator && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += character;
        }
    }

    parts.push(current);
    return parts;
}

function getFoldingOpenKind(codeLine) {
    if (/^#(?:if|ifdef|ifndef)\b/i.test(codeLine)) return "preprocessorIf";
    if (/^#macro\b/i.test(codeLine)) return "macro";
    if (/^(?:(?:public|private|protected)\s+)?namespace\b/i.test(codeLine)) return "namespace";
    if (/^(?:(?:public|private|protected)\s+)?(?:type|class|union|enum)\b/i.test(codeLine) && !/^(?:(?:public|private|protected)\s+)?type\b.*\bas\b/i.test(codeLine)) return codeLine.match(/(?:type|class|union|enum)/i)[0].toLowerCase();
    if (/^(?:(?:abstract|const|export|override|private|protected|public|static|virtual)\s+)*(?:sub|function|property|constructor|destructor|operator)\b/i.test(codeLine) && !/(?:^|\s)declare\s+/i.test(codeLine) && !/:\s*end\b/i.test(codeLine)) return codeLine.match(/(?:sub|function|property|constructor|destructor|operator)/i)[0].toLowerCase();
    if (/^if\b.*\bthen\s*$/i.test(codeLine)) return "if";
    if (/^select\s+case\b/i.test(codeLine)) return "select";
    if (/^for\b/i.test(codeLine)) return "for";
    if (/^do\b/i.test(codeLine)) return "do";
    if (/^while\b/i.test(codeLine)) return "while";
    if (/^with\b/i.test(codeLine)) return "with";
    if (/^scope\b/i.test(codeLine)) return "scope";
    if (/^asm\b/i.test(codeLine)) return "asm";
    if (/^extern\b/i.test(codeLine) && !/\bas\b/i.test(codeLine)) return "extern";
    return null;
}

function getFoldingCloseKind(codeLine) {
    if (/^#endif\b/i.test(codeLine)) return "preprocessorIf";
    if (/^#endmacro\b/i.test(codeLine)) return "macro";

    const endMatch = codeLine.match(/^end\s+(namespace|type|class|union|enum|sub|function|property|constructor|destructor|operator|if|select|with|scope|asm|extern)\b/i);
    if (endMatch) return endMatch[1].toLowerCase();
    if (/^next\b/i.test(codeLine)) return "for";
    if (/^loop\b/i.test(codeLine)) return "do";
    if (/^wend\b/i.test(codeLine)) return "while";
    return null;
}

function closeFoldingBlock(stack, ranges, closeKind, endLine) {
    for (let index = stack.length - 1; index >= 0; index--) {
        if (stack[index].kind !== closeKind) {
            continue;
        }

        const [block] = stack.splice(index, 1);
        if (endLine > block.startLine) {
            ranges.push({
                startLine: block.startLine,
                endLine,
                kind: closeKind.startsWith("preprocessor") || closeKind === "commentRegion"
                    ? "region"
                    : undefined
            });
        }
        return;
    }
}

function normalizeIdentifier(name) {
    return String(name || "")
        .replace(/[$%!#&]$/, "")
        .toLowerCase();
}

function titleCase(value) {
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

module.exports = {
    findCallContext,
    findDeclarationByName,
    findDeclarationsByName,
    findFoldingRanges,
    findIdentifierOccurrences,
    maskFreeBasicText,
    normalizeIdentifier,
    parseDimLine,
    parseFreeBasicText,
    parseParameters,
    splitDimVariables,
    splitTopLevel,
    stripComments
};

/* end of lib/freebasic-parser.js */
