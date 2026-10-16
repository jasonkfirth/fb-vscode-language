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
const CALL_CONTEXT_IDENTIFIER_PATTERN = new RegExp(`^${QUALIFIED_IDENTIFIER_SOURCE}$`, "i");
const CALL_CONTEXT_OPENING_FOR_CLOSING = new Map([
    [")", "("],
    ["]", "["],
    ["}", "{"]
]);
/* Compiler-confirmed masked REM sites stay bounded when passed to the scanner. */
const MAX_COMPILER_REM_IDENTIFIER_OFFSETS = 200000;
const MAX_DEFAULT_ESCAPED_STRING_RANGES = 200000;

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

function parseFreeBasicText(text, remIdentifierOffsets = null, defaultEscapedStringRanges = null) {
    const declarations = [];
    const includes = [];
    const blockStack = [];
    const trustedRemIdentifierOffsets = normalizeRemIdentifierOffsets(remIdentifierOffsets);
    const trustedEscapedStringRanges = normalizeOffsetRanges(defaultEscapedStringRanges, text.length);
    const logicalLines = createLogicalLines(text, trustedRemIdentifierOffsets, trustedEscapedStringRanges);

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
            const macroSuffix = codeLine.slice(macroMatch[0].length);
            const parameterText = /^\(/.test(macroSuffix)
                ? extractParenthesizedText(codeLine, macroMatch[0].length)
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

        if (/^(?:type|union)\s*$/i.test(maskedLine)) {
            blockStack.push({ declaration: null, kind: maskedLine.toLowerCase(), startLine: logicalLine.startLine });
            continue;
        }

        /* TYPE supports both "name AS type" and "AS type name, name".
           Handle aliases before block declarations so AS cannot open a fake
           aggregate and change the owner of every subsequent declaration. */
        const aliasMatch = maskedLine.match(new RegExp(`^(?:(?:public|private|protected)\\s+)?type\\s+(?:as\\s+|${IDENTIFIER_SOURCE}\\s+as\\b)`, "i"));
        if (aliasMatch) {
            const aliases = parseVariableDeclarationText(
                logicalLine,
                codeLine.replace(/^(?:(?:public|private|protected)\s+)?type\s+/i, ""),
                "type", containerPath, parentDeclaration
            );
            for (const declaration of aliases) declaration.detail = "Type alias";
            declarations.push(...aliases);
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
                typeName: isTypeAlias ? maskedLine.slice(aggregateMatch[0].length).replace(/^\s*as\s+/i, "").trim() : "",
                baseType: maskedLine.match(/\bextends\s+([A-Za-z_][\w.]*)/i)?.[1] || "",
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

        if (blockStack.at(-1)?.kind === "enum") {
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
                    initializer: codeLine.slice(codeLine.indexOf("=") + 1).trim(),
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
                typeName: loopVariableMatch[2].trim(),
                containerPath,
                parentDeclaration,
                localOnly: true
            });
            continue;
        }

        if (isInsideAggregate(blockStack) && /^(?:public|private|protected)\s*:\s*$/i.test(maskedLine)) {
            continue;
        }

        if (parentDeclaration && ["type", "class", "union"].includes(parentDeclaration.type)) {
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
        text,
        declarations,
        statements: logicalLines,
        foldingRanges: findFoldingRanges(text, trustedEscapedStringRanges),
        includes,
        occurrences: findIdentifierOccurrences(text, trustedEscapedStringRanges),
        ...(trustedRemIdentifierOffsets.size ? { remIdentifierOffsets: [...trustedRemIdentifierOffsets] } : {}),
        ...(trustedEscapedStringRanges.length ? { defaultEscapedStringRanges: trustedEscapedStringRanges } : {})
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

function findIdentifierOccurrences(text, defaultEscapedStringRanges = null) {
    const occurrences = [];
    const scanState = { inBlockComment: false };
    const lines = text.split(/\r\n|\n|\r/);
    const lineOffsets = [0];
    for (const match of text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
    const identifierPattern = new RegExp(IDENTIFIER_SOURCE, "g");

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const scanned = scanLine(lines[lineIndex], scanState, null, null, lineOffsets[lineIndex],
            false, null, false, defaultEscapedStringRanges);

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

function findCallContext(text, offset, defaultEscapedStringRanges = null) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
        return null;
    }

    const maskedText = maskFreeBasicText(text, null, null, defaultEscapedStringRanges);
    return findCallContextInMaskedText(maskedText, offset);
}

function findCallContextInMaskedText(maskedText, offset) {
    /* Open call frames must survive line breaks and nested array initializers. */
    const stack = [];

    for (let index = 0; index < offset; index++) {
        const character = maskedText[index];
        if (character === "(" || character === "[" || character === "{") {
            let callContext = null;
            if (character !== "{") {
                const name = callNameBefore(maskedText, index);
                if (name) {
                    callContext = {
                        name,
                        openParenthesisOffset: index,
                        ...(character === "[" ? { indexing: true } : {})
                    };
                }
            }
            stack.push({ character, callContext, activeParameter: 0 });
            continue;
        }

        const expectedOpening = CALL_CONTEXT_OPENING_FOR_CLOSING.get(character);
        if (expectedOpening) {
            let matchingIndex = stack.length - 1;
            while (matchingIndex >= 0 && stack[matchingIndex].character !== expectedOpening) matchingIndex--;
            if (matchingIndex >= 0) stack.length = matchingIndex;
            continue;
        }

        if (character === "," && stack.at(-1)?.callContext) {
            stack.at(-1).activeParameter++;
        }
    }

    for (let index = stack.length - 1; index >= 0; index--) {
        const frame = stack[index];
        if (frame.callContext) return { ...frame.callContext, activeParameter: frame.activeParameter };
    }

    return null;
}

function findSignatureCallContext(text, offset, defaultEscapedStringRanges = null) {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null;
    // Share one mask between explicit-call scanning and the bare-call fallback.
    const masked = maskFreeBasicText(text, null, null, defaultEscapedStringRanges);
    return findSignatureCallContextInMaskedText(masked, offset);
}

function findSignatureCallContextInMaskedText(masked, offset) {
    const parenthesized = findCallContextInMaskedText(masked, offset);
    if (parenthesized) return parenthesized;
    let start = masked.lastIndexOf("\n", offset - 1) + 1;
    // A bare call ends at a physical newline unless that line was continued.
    while (start > 0) {
        const previousStart = masked.lastIndexOf("\n", start - 2) + 1;
        if (!/(?:^|[ \t])_[ \t\r]*$/.test(masked.slice(previousStart, start - 1))) break;
        start = previousStart;
    }
    const colon = masked.lastIndexOf(":", offset - 1);
    if (colon >= start) start = colon + 1;
    let fragment = masked.slice(start, offset);
    if (/^\s*if\b/i.test(fragment)) {
        // Single-line IF branches are statement heads too. Strings/comments
        // have already been masked, so their THEN/ELSE text cannot move it.
        const branches = [...fragment.matchAll(/\b(?:then|else)\b(?!\s*\.)/ig)];
        if (branches.length) {
            const branch = branches.at(-1);
            start += branch.index + branch[0].length;
            fragment = masked.slice(start, offset);
        }
    }
    const qualifiedName = `${IDENTIFIER_SOURCE}(?:[ \\t]*(?:\\.|->)[ \\t]*${IDENTIFIER_SOURCE})*`;
    const head = fragment.match(new RegExp(`^[ \\t]*(?:call[ \\t]+)?(${qualifiedName})[ \\t]+`, "i"));
    if (!head || /^\s*=/.test(fragment.slice(head[0].length))) return null;
    const writtenName = head[1];
    const calleeEnd = start + head[0].lastIndexOf(writtenName) + writtenName.length;
    // The existing compiler join can use the terminal token when a receiver
    // uses arrows or whitespace around dots, just as parenthesized calls do.
    const name = /[ \t]|->/.test(writtenName) ? writtenName.split(/\.|->/).at(-1).trim() : writtenName;
    const stack = [];
    let activeParameter = 0;
    for (const character of masked.slice(calleeEnd, offset)) {
        if ("([{".includes(character)) stack.push(character);
        else if (CALL_CONTEXT_OPENING_FOR_CLOSING.has(character)) {
            const opening = stack.lastIndexOf(CALL_CONTEXT_OPENING_FOR_CLOSING.get(character));
            if (opening >= 0) stack.length = opening;
        } else if (character === "," && stack.length === 0) activeParameter++;
    }
    return { name, openParenthesisOffset: calleeEnd, activeParameter, bare: true };
}

function callNameBefore(text, offset) {
    let end = offset;
    while (end > 0 && /\s/.test(text[end - 1])) end--;
    let start = end;
    while (start > 0 && /[A-Za-z0-9_.$%!#&]/.test(text[start - 1])) start--;
    const name = text.slice(start, end);
    return CALL_CONTEXT_IDENTIFIER_PATTERN.test(name) ? name : "";
}

function findFoldingRanges(text, defaultEscapedStringRanges = null) {
    const ranges = [];
    const stack = [];
    const scanState = { inBlockComment: false };
    const lines = text.split(/\r\n|\n|\r/);
    const lineOffsets = [0];
    for (const match of text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
    let blockCommentStartLine = null;
    let lineCommentStartLine = null;
    let lineCommentEndLine = null;
    let continuationStartLine = null;
    let importBlockStartLine = null;
    let importBlockEndLine = null;

    const closeImportBlock = () => {
        if (importBlockStartLine !== null && importBlockEndLine > importBlockStartLine) {
            ranges.push({ startLine: importBlockStartLine, endLine: importBlockEndLine, kind: "imports" });
        }
        importBlockStartLine = null;
        importBlockEndLine = null;
    };
    const closeLineCommentBlock = () => {
        if (lineCommentStartLine !== null && lineCommentEndLine > lineCommentStartLine) {
            ranges.push({ startLine: lineCommentStartLine, endLine: lineCommentEndLine, kind: "comment" });
        }
        lineCommentStartLine = null;
        lineCommentEndLine = null;
    };
    const closeContinuationBlock = (endLine) => {
        if (continuationStartLine !== null && endLine > continuationStartLine) {
            ranges.push({ startLine: continuationStartLine, endLine });
        }
        continuationStartLine = null;
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const startedInsideBlockComment = scanState.inBlockComment;
        const scanned = scanLine(lines[lineIndex], scanState, (event, depth) => {
            if (event === "open" && depth === 1) blockCommentStartLine = lineIndex;
            else if (event === "close" && depth === 1 && blockCommentStartLine !== null) {
                if (lineIndex > blockCommentStartLine) {
                    ranges.push({ startLine: blockCommentStartLine, endLine: lineIndex, kind: "comment" });
                }
                blockCommentStartLine = null;
            }
        }, null, lineOffsets[lineIndex], false, null, false, defaultEscapedStringRanges);
        const continuesStatement = /(?:^|\s)_\s*$/.test(scanned.maskedText);
        if (continuesStatement) {
            if (continuationStartLine === null) continuationStartLine = lineIndex;
        } else {
            closeContinuationBlock(lineIndex);
        }
        const codeLine = scanned.maskedText.trim();
        const isImport = /^(?:#\s*include|using)\b/i.test(codeLine);
        if (!isImport) closeImportBlock();

        const isRegionEnd = !startedInsideBlockComment && scanned.inLineComment &&
            /^\s*(?:'|REM\b)\s*#endregion\b/i.test(lines[lineIndex]);
        const isRegionStart = !startedInsideBlockComment && scanned.inLineComment &&
            /^\s*(?:'|REM\b)\s*#region\b/i.test(lines[lineIndex]);
        if (isRegionEnd || isRegionStart) closeLineCommentBlock();
        if (isRegionEnd) {
            closeFoldingBlock(stack, ranges, "commentRegion", lineIndex);
            continue;
        }

        if (isRegionStart) {
            stack.push({ kind: "commentRegion", startLine: lineIndex });
            continue;
        }

        const commentOnlyLine = !startedInsideBlockComment && scanned.inLineComment && !scanned.visibleText.trim();
        if (commentOnlyLine) {
            if (lineCommentStartLine === null) lineCommentStartLine = lineIndex;
            lineCommentEndLine = lineIndex;
            continue;
        }
        closeLineCommentBlock();

        if (isImport) {
            if (importBlockStartLine === null) importBlockStartLine = lineIndex;
            importBlockEndLine = lineIndex;
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
    closeImportBlock();
    closeLineCommentBlock();
    closeContinuationBlock(lines.length - 1);

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
            typeName: resultType,
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
    const insideProcedure = blockStack.some((block) =>
        ["sub", "function", "property", "constructor", "destructor", "operator"].includes(block.kind)
    );
    if (insideProcedure && !modifiers.has("DECLARE")) {
        return null;
    }

    let suffix = specialMatch[3].trim();
    let specialEnd = specialMatch.index + specialMatch[0].length;
    if (procedureType === "operator" && (!suffix || suffix.endsWith("."))) {
        const emptyOperatorSuffix = codeLine.slice(specialEnd).match(/^\s*\(\)/);
        if (emptyOperatorSuffix) {
            suffix += "()";
            specialEnd += emptyOperatorSuffix[0].length;
        }
    }
    const name = suffix
        ? `${titleCase(procedureType)} ${suffix}`
        : titleCase(procedureType);
    const selectionName = name.toLowerCase().includes(" ")
        ? name.toLowerCase().split(/\s+/).at(-1)
        : name.toLowerCase();
    const codeLineOffset = logicalLine.visibleText.indexOf(codeLine);
    const location = suffix && codeLineOffset >= 0
        ? logicalOffsetLocation(
            logicalLine,
            codeLineOffset + specialEnd - selectionName.length,
            selectionName.length
        )
        : undefined;
    const parameterText = extractParenthesizedText(codeLine, specialEnd);
    const declaration = addDeclaration(declarations, logicalLine, {
        name,
        type: procedureType,
        detail: titleCase(procedureType),
        containerPath,
        parentDeclaration,
        location,
        parameters: parseParameters(parameterText),
        typeName: procedureType === "operator" ? extractProcedureResultType(codeLine) : "",
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
            name: nameMatch && !/^as$/i.test(nameMatch[1]) ? nameMatch[1] : `parameter${index + 1}`,
            typeName: typeMatch ? typeMatch[1].trim() : "",
            optional: splitTopLevel(source, "=").length > 1,
            variadic: source === "..."
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
            typeName: parameter.typeName,
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
            typeName: typeMatch ? typeMatch[1].trim() : commonType,
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
    const modifiers = [];

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
        modifiers.push(firstWord);
        rest = rest.slice(firstWordMatch[0].length);
    }

    const declarations = parseVariableDeclarationText(
        logicalLine,
        rest.trim(),
        declarationKind,
        containerPath,
        parentDeclaration
    );
    for (const declaration of declarations) {
        declaration.modifiers = modifiers;
    }
    return declarations;
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
    let partStart = logicalLine.visibleText.indexOf(declarationText) + declarationText.length - variableList.length;
    for (const part of splitTopLevel(variableList, ",")) {
        const name = extractVariableName(part);
        if (!name) {
            partStart += part.length + 1;
            continue;
        }

        const typeMatch = part.match(/\bas\s+(.+?)(?:\s*=|$)/i);
        const typeName = typeMatch ? typeMatch[1].trim() : commonType;
        declarations.push(createDeclaration(logicalLine, {
            name,
            type: declarationKind,
            typeName,
            initializer: splitTopLevel(part, "=").slice(1).join("=").trim(),
            location: logicalOffsetLocation(logicalLine, partStart + part.search(/\S/), name.length),
            detail: typeName
                ? `${titleCase(declarationKind)} As ${typeName}`
                : titleCase(declarationKind),
            containerPath,
            parentDeclaration
        }));
        partStart += part.length + 1;
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
        typeName: options.typeName || "",
        baseType: options.baseType || "",
        initializer: options.initializer || "",
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

function logicalOffsetLocation(logicalLine, offset, length) {
    if (offset < 0 || !logicalLine.sourceLines) return null;
    const before = logicalLine.visibleText.slice(0, offset).split("\n");
    const lineOffset = before.length - 1;
    const initialPadding = logicalLine.startColumn - logicalLine.visibleText.search(/\S/);
    const startColumn = before.at(-1).length + (lineOffset === 0 ? Math.max(0, initialPadding) : 0);
    return {
        line: logicalLine.startLine + lineOffset,
        sourceLine: logicalLine.sourceLines[lineOffset] || logicalLine.sourceLine,
        startColumn,
        endColumn: startColumn + length
    };
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

function createLogicalLines(text, remIdentifierOffsets, defaultEscapedStringRanges = null) {
    const logicalLines = [];
    const lines = text.split(/\r\n|\n|\r/);
    const lineOffsets = [0];
    for (const match of text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
    const scanState = { inBlockComment: false };
    let pending = null;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const sourceLine = lines[lineIndex];
        const scanned = scanLine(sourceLine, scanState, null, remIdentifierOffsets, lineOffsets[lineIndex],
            false, null, false, defaultEscapedStringRanges);
        const continues = /(?:^|\s)_\s*$/.test(scanned.maskedText);
        const visiblePart = continues
            ? scanned.visibleText.replace(/_\s*$/, (value) => " ".repeat(value.length))
            : scanned.visibleText;
        const maskedPart = continues
            ? scanned.maskedText.replace(/_\s*$/, (value) => " ".repeat(value.length))
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
        pending.visibleParts.push(visiblePart);
        pending.maskedParts.push(maskedPart);

        if (!continues) {
            logicalLines.push(...splitLogicalStatements(pending));
            pending = null;
        }
    }

    if (pending) {
        logicalLines.push(...splitLogicalStatements(pending));
    }

    return logicalLines;
}

function splitLogicalStatements(pending) {
    const visible = pending.visibleParts.join("\n");
    const masked = pending.maskedParts.join("\n");
    const cuts = [];
    let depth = 0;
    if (!/^\s*#/.test(masked)) {
        for (let index = 0; index < masked.length; index++) {
            const character = masked[index];
            if (character === "(" || character === "[") depth++;
            if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
            if (character === ":" && depth === 0 && !/^\s*\d+\s+as\b/i.test(masked.slice(index + 1))) {
                cuts.push(index);
            }
        }
    }
    const statements = [];
    let start = 0;
    for (const cut of [...cuts, masked.length]) {
        const label = /^[ \t]*(?:[A-Za-z_]\w*|\d+)[ \t]*$/.test(masked.slice(start, cut));
        const end = cut < masked.length && label ? cut + 1 : cut;
        let offset = 0;
        const sourceLines = pending.sourceLines.map((line) => {
            const first = Math.max(0, start - offset);
            const last = Math.min(line.length, end - offset);
            offset += line.length + 1;
            if (last <= first) return " ".repeat(line.length);
            return " ".repeat(first) + line.slice(first, last) + " ".repeat(line.length - last);
        });
        const firstLine = sourceLines.findIndex((line) => line.trim());
        if (firstLine >= 0) {
            let lastLine = sourceLines.length - 1;
            while (!sourceLines[lastLine].trim()) lastLine--;
            statements.push({
                startLine: pending.startLine + firstLine,
                endLine: pending.startLine + lastLine,
                startColumn: sourceLines[firstLine].search(/\S/),
                endColumn: sourceLines[lastLine].trimEnd().length,
                sourceLine: sourceLines[firstLine],
                sourceLines: sourceLines.slice(firstLine, lastLine + 1),
                visibleText: visible.slice(start, end),
                maskedText: masked.slice(start, end),
                signature: visible.slice(start, end).replace(/\s+/g, " ").trim()
            });
        }
        start = cut + 1;
    }
    return statements;
}

function offsetInRanges(ranges, offset) {
    if (!Array.isArray(ranges) || !Number.isSafeInteger(offset)) return false;
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
        const middle = low + ((high - low) >> 1);
        const range = ranges[middle];
        if (!Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.end) || range.end <= range.start) return false;
        if (offset < range.start) high = middle - 1;
        else if (offset >= range.end) low = middle + 1;
        else return true;
    }
    return false;
}

function normalizeOffsetRanges(ranges, textLength) {
    if (!Array.isArray(ranges) || ranges.length > MAX_DEFAULT_ESCAPED_STRING_RANGES) return [];
    const normalized = ranges.filter((range) => Number.isSafeInteger(range?.start) &&
        Number.isSafeInteger(range?.end) && range.start >= 0 && range.start < range.end &&
        range.end <= textLength).map((range) => ({ start: range.start, end: range.end }))
        .sort((first, second) => first.start - second.start || first.end - second.end);
    const merged = [];
    for (const range of normalized) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push(range);
    }
    return merged;
}

function scanLine(line, state, onBlockCommentDelimiter = null, remIdentifierOffsets = null, lineOffset = 0,
    compilerRemKeywordDisabled = false, onStringStart = null, defaultEscapedStrings = false,
    defaultEscapedStringRanges = null) {
    /* VS Code positions count UTF-16 units, including both halves of a pair. */
    const visibleCharacters = line.split("");
    /* Without a quoted string, visible and code-masked text are identical. */
    const maskedCharacters = line.includes('"') ? line.split("") : visibleCharacters;
    let inString = false;
    let escapedString = false;
    let defaultString = false;
    let inLineComment = false;
    let index = 0;

    if (!Number.isInteger(state.blockCommentDepth)) {
        state.blockCommentDepth = state.inBlockComment ? 1 : 0;
    }
    if (typeof state.remKeywordActive !== "boolean") state.remKeywordActive = true;
    if (!Number.isSafeInteger(state.preprocessorDepth)) state.preprocessorDepth = 0;
    if (!Number.isSafeInteger(state.macroDepth)) state.macroDepth = 0;

    const startedInsideBlockComment = state.blockCommentDepth > 0;
    const directive = !startedInsideBlockComment
        ? /^\s*#\s*(if|ifdef|ifndef|endif|macro|endmacro)\b/i.exec(line)?.[1]?.toLowerCase() || ""
        : "";
    /* Compiler-originated active option lines can settle a conditional the
       source-only scanner deliberately leaves unknown. */
    const disablesRemOnLine = !startedInsideBlockComment && state.macroDepth === 0 &&
        (compilerRemKeywordDisabled || state.preprocessorDepth === 0 && optionDisablesRemKeyword(line));

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
                onBlockCommentDelimiter?.("open", state.blockCommentDepth);
                index += 2;
            } else if (character === "'" && nextCharacter === "/") {
                visibleCharacters[index + 1] = " ";
                maskedCharacters[index + 1] = " ";
                const depth = state.blockCommentDepth;
                state.blockCommentDepth--;
                onBlockCommentDelimiter?.("close", depth);
                index += 2;
            } else {
                index++;
            }
            continue;
        }

        if (inString) {
            maskedCharacters[index] = " ";

            if (defaultString && !escapedString && character === "\\" && nextCharacter === '"') {
                state.ambiguousDefaultEscapes = true;
            }

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
            onStringStart?.(lineOffset + index);
            inString = true;
            defaultString = index === 0 || !["!", "$"].includes(line[index - 1]);
            escapedString = index > 0 && line[index - 1] === "!" ||
                (defaultEscapedStrings || offsetInRanges(defaultEscapedStringRanges, lineOffset + index)) &&
                !(index > 0 && line[index - 1] === "$");
            index++;
            continue;
        }

        if (character === "/" && nextCharacter === "'") {
            visibleCharacters[index] = " ";
            visibleCharacters[index + 1] = " ";
            maskedCharacters[index] = " ";
            maskedCharacters[index + 1] = " ";
            state.blockCommentDepth = 1;
            onBlockCommentDelimiter?.("open", state.blockCommentDepth);
            index += 2;
            continue;
        }

        const previousCharacter = index > 0 ? line[index - 1] : "";
        const remMatch = (character === "r" || character === "R") &&
            (nextCharacter === "e" || nextCharacter === "E") &&
            (line[index + 2] === "m" || line[index + 2] === "M") &&
            !/[A-Za-z0-9_]/.test(previousCharacter) &&
            !/[A-Za-z0-9_]/.test(line[index + 3] || "");
        if (remMatch && state.remKeywordActive && !disablesRemOnLine &&
            !remIdentifierOffsets?.has(lineOffset + index)) {
            inLineComment = true;
            for (let commentIndex = index; commentIndex < line.length; commentIndex++) {
                visibleCharacters[commentIndex] = " ";
                maskedCharacters[commentIndex] = " ";
            }
            break;
        }

        if (character === "'") {
            inLineComment = true;
            for (let commentIndex = index; commentIndex < line.length; commentIndex++) {
                visibleCharacters[commentIndex] = " ";
                maskedCharacters[commentIndex] = " ";
            }
            break;
        }

        index++;
    }

    state.inBlockComment = state.blockCommentDepth > 0;
    if (disablesRemOnLine) state.remKeywordActive = false;
    if (directive === "if" || directive === "ifdef" || directive === "ifndef") state.preprocessorDepth++;
    else if (directive === "endif") state.preprocessorDepth = Math.max(0, state.preprocessorDepth - 1);
    else if (directive === "macro") state.macroDepth++;
    else if (directive === "endmacro") state.macroDepth = Math.max(0, state.macroDepth - 1);

    return {
        visibleText: visibleCharacters.join(""),
        maskedText: maskedCharacters.join(""),
        inString,
        inLineComment
    };
}

function optionDisablesRemKeyword(line) {
    const option = /^\s*option\s+nokeyword\b/i.exec(line);
    if (!option) return false;
    const rest = line.slice(option[0].length);
    const name = /(?:^|,)\s*rem\b/i.exec(rest);
    if (!name) return false;
    return /^\s*(?:,|'|\/'|$)/.test(rest.slice(name.index + name[0].length));
}

function stripComments(line) {
    return scanLine(line, { inBlockComment: false }).visibleText.replace(/\s+$/, " ");
}

function normalizeRemIdentifierOffsets(offsets) {
    const values = offsets instanceof Set ? [...offsets] : Array.isArray(offsets) ? offsets : [];
    if (values.length > MAX_COMPILER_REM_IDENTIFIER_OFFSETS) return new Set();
    return new Set(values.filter((offset) => Number.isSafeInteger(offset) && offset >= 0));
}

/* Keep literals visible when a caller needs to prove that a gap contains only
   comments/whitespace. The shared scanner retains nested comments across lines. */
function maskFreeBasicComments(text) {
    const state = { inBlockComment: false };
    return text.split(/(\r\n|\n|\r)/)
        .map((part, index) => index % 2 === 0 ? scanLine(part, state).visibleText : part)
        .join("");
}

function maskFreeBasicText(text, remIdentifierOffsets = null, compilerRemKeywordDisabledLineOffsets = null,
    defaultEscapedStringRanges = null) {
    const state = { inBlockComment: false };
    const trustedOffsets = normalizeRemIdentifierOffsets(remIdentifierOffsets);
    const disabledLineOffsets = normalizeRemIdentifierOffsets(compilerRemKeywordDisabledLineOffsets);
    const escapedStringRanges = normalizeOffsetRanges(defaultEscapedStringRanges, text.length);
    const lineOffsets = [0];
    for (const match of text.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
    /* Keep CRLF offsets aligned with VS Code's UTF-16 document offsets. */
    return text.split(/(\r\n|\n|\r)/)
        .map((part, index) => index % 2 === 0
            ? scanLine(part, state, null, trustedOffsets, lineOffsets[index >> 1],
                disabledLineOffsets.has(lineOffsets[index >> 1]), null, false, escapedStringRanges).maskedText
            : part)
        .join("");
}

function findUnclosedStringStart(line, compilerRemKeywordDisabled = false, defaultEscapedStrings = false) {
    const starts = [];
    const scanned = scanLine(String(line ?? ""), { inBlockComment: false }, null, null, 0,
        compilerRemKeywordDisabled, (offset) => starts.push(offset), defaultEscapedStrings);
    return scanned.inString ? starts.at(-1) ?? -1 : -1;
}

function getCodeContext(text, offset, defaultEscapedStringRanges = null) {
    return getCodeContextDetails(text, offset, defaultEscapedStringRanges).context;
}

function getCodeContextDetails(text, offset, defaultEscapedStringRanges = null) {
    const state = { inBlockComment: false };
    let scanned = { inString: false, inLineComment: false };
    const prefix = text.slice(0, offset);
    const lines = prefix.split(/\r\n|\n|\r/);
    const lineOffsets = [0];
    for (const match of prefix.matchAll(/\r\n|\n|\r/g)) lineOffsets.push(match.index + match[0].length);
    for (let line = 0; line < lines.length; line++) {
        scanned = scanLine(lines[line], state, null, null, lineOffsets[line], false, null, false,
            defaultEscapedStringRanges);
    }
    const context = state.inBlockComment || scanned.inLineComment ? "comment" : scanned.inString ? "string" : "code";
    return { context, ambiguousDefaultEscapes: state.ambiguousDefaultEscapes === true };
}

function findStandaloneLineCommentLines(text) {
    const lines = String(text || "").split(/\r\n|\n|\r/);
    const state = { blockCommentDepth: 0 };
    const commentLines = new Set();
    for (let line = 0; line < lines.length; line++) {
        const sourceLine = lines[line];
        const scanned = scanLine(sourceLine, state);
        if (/^\s*(?:'|rem\b)/i.test(sourceLine) && scanned.inLineComment && !scanned.visibleText.trim()) {
            commentLines.add(line);
        }
    }
    return commentLines;
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
        `^as\\s+((?:const\\s+)?(?:unsigned\\s+)?${QUALIFIED_IDENTIFIER_SOURCE}` +
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
    findCallContextInMaskedText,
    findSignatureCallContext,
    findSignatureCallContextInMaskedText,
    findDeclarationByName,
    findDeclarationsByName,
    findFoldingRanges,
    findIdentifierOccurrences,
    findStandaloneLineCommentLines,
    findUnclosedStringStart,
    getCodeContext,
    getCodeContextDetails,
    getFoldingCloseKind,
    getFoldingOpenKind,
    maskFreeBasicComments,
    maskFreeBasicText,
    normalizeIdentifier,
    optionDisablesRemKeyword,
    parseDimLine,
    parseFreeBasicText,
    parseParameters,
    splitDimVariables,
    splitTopLevel,
    stripComments
};

/* end of lib/freebasic-parser.js */
