function parseFreeBasicText(text) {
    const declarations = [];
    const namespaceStack = [];
    const lines = text.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const sourceLine = lines[lineIndex];
        const codeLine = stripComments(sourceLine).trim();
        if (!codeLine) {
            continue;
        }

        const namespaceStart = codeLine.match(/^namespace\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        if (namespaceStart) {
            declarations.push(createDeclaration(lineIndex, sourceLine, namespaceStart[1], "namespace", "Namespace", namespaceStack));
            namespaceStack.push(namespaceStart[1]);
            continue;
        }

        if (/^end\s+namespace\b/i.test(codeLine) && namespaceStack.length > 0) {
            namespaceStack.pop();
            continue;
        }

        const declarationPatterns = [
            { regex: /^(?:declare\s+)?sub\s+([A-Za-z_][A-Za-z0-9_\.]*)/i, type: "sub", detail: "Sub" },
            { regex: /^(?:declare\s+)?function\s+([A-Za-z_][A-Za-z0-9_\.]*)/i, type: "function", detail: "Function" },
            { regex: /^(?:declare\s+)?property\s+([A-Za-z_][A-Za-z0-9_\.]*)/i, type: "property", detail: "Property" },
            { regex: /^type\s+([A-Za-z_][A-Za-z0-9_]*)/i, type: "type", detail: "Type" },
            { regex: /^class\s+([A-Za-z_][A-Za-z0-9_]*)/i, type: "class", detail: "Class" },
            { regex: /^union\s+([A-Za-z_][A-Za-z0-9_]*)/i, type: "union", detail: "Union" },
            { regex: /^enum\s+([A-Za-z_][A-Za-z0-9_]*)/i, type: "enum", detail: "Enum" },
            { regex: /^const\s+([A-Za-z_][A-Za-z0-9_]*)/i, type: "const", detail: "Const" },
            { regex: /^extern\s+([A-Za-z_][A-Za-z0-9_]*)/i, type: "extern", detail: "Extern" }
        ];

        let matchedDeclaration = false;
        for (const pattern of declarationPatterns) {
            const match = codeLine.match(pattern.regex);
            if (!match) {
                continue;
            }

            declarations.push(createDeclaration(lineIndex, sourceLine, match[1], pattern.type, pattern.detail, namespaceStack));
            matchedDeclaration = true;
            break;
        }

        if (matchedDeclaration) {
            continue;
        }

        if (/^dim\b/i.test(codeLine)) {
            const dimDeclarations = parseDimLine(lineIndex, sourceLine, codeLine, namespaceStack);
            declarations.push(...dimDeclarations);
        }
    }

    return { declarations };
}

function parseDimLine(lineIndex, sourceLine, codeLine, namespaceStack) {
    let rest = codeLine.replace(/^dim\b/i, "").trim();
    rest = rest.replace(/^(?:shared|static|common|private|public|protected)\b/i, "").trim();

    if (/^as\b/i.test(rest)) {
        rest = rest.replace(/^as\b/i, "").trim();
        const typeMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_\.]*(?:\s+ptr)*)\s+/i);
        if (!typeMatch) {
            return [];
        }

        const typeName = typeMatch[1].trim();
        const variableList = rest.slice(typeMatch[0].length);
        return splitDimVariables(variableList).map((name) =>
            createDeclaration(lineIndex, sourceLine, name, "variable", `Variable As ${typeName}`, namespaceStack)
        );
    }

    return splitDimVariables(rest).map((name) =>
        createDeclaration(lineIndex, sourceLine, name, "variable", "Variable", namespaceStack)
    );
}

function splitDimVariables(variableList) {
    const parts = variableList.split(",");
    const names = [];

    for (const part of parts) {
        let candidate = part.trim();
        if (!candidate) {
            continue;
        }

        const asIndex = candidate.search(/\s+as\s+/i);
        if (asIndex >= 0) {
            candidate = candidate.slice(0, asIndex).trim();
        }

        const equalsIndex = candidate.indexOf("=");
        if (equalsIndex >= 0) {
            candidate = candidate.slice(0, equalsIndex).trim();
        }

        candidate = candidate.replace(/\(.*\)$/, "").trim();
        candidate = candidate.replace(/[%!#$&]$/, "").trim();

        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
            names.push(candidate);
        }
    }

    return names;
}

function createDeclaration(lineIndex, sourceLine, name, type, detail, namespaceStack = []) {
    const lowerLine = sourceLine.toLowerCase();
    const lowerName = name.toLowerCase();
    const startColumn = Math.max(0, lowerLine.indexOf(lowerName));

    return {
        name,
        type,
        detail,
        line: lineIndex,
        startColumn,
        endColumn: startColumn + name.length,
        containerName: namespaceStack.length > 0 ? namespaceStack.join(".") : "",
        sourceLine: sourceLine.trim(),
        signature: sourceLine.trim()
    };
}

function stripComments(line) {
    const apostropheIndex = line.indexOf("'");
    if (apostropheIndex >= 0) {
        return line.slice(0, apostropheIndex);
    }

    return line;
}

function findDeclarationByName(declarations, name) {
    const lowerName = name.toLowerCase();
    return declarations.find((declaration) => declaration.name.toLowerCase() === lowerName) || null;
}

module.exports = {
    findDeclarationByName,
    parseDimLine,
    parseFreeBasicText,
    splitDimVariables,
    stripComments
};
