/*
    Project: FreeBASIC VS Code Language Extension
    ------------------------------------------------

    File: tools/build-freebasic-grammar.js

    Purpose:

        Generate the shipped TextMate grammar from the smaller, reviewable
        FreeBASIC grammar source file.

    Responsibilities:

        - normalize source-backed word lists into TextMate regular expressions
        - preserve the hand-authored compound syntax patterns
        - write deterministic UTF-8 JSON without a byte-order mark

    This file intentionally does NOT contain:

        - compiler source discovery
        - coverage auditing
        - VSIX packaging
*/

const fs = require("fs");
const path = require("path");

const DEFAULT_SOURCE_PATH = path.join("syntaxes", "source", "freebasic.grammar-source.json");
const DEFAULT_OUTPUT_PATH = path.join("syntaxes", "freebasic.tmLanguage.json");
const IDENTIFIER_PATTERN = "[A-Z_][A-Z0-9_]*(?:[$%!#&])?";

function sortedUnique(values) {
    return Array.from(new Set((values || []).filter((value) => typeof value === "string" && value.trim())))
        .sort((left, right) => left.localeCompare(right));
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordsToRegex(words) {
    const escapedWords = sortedUnique(words).map(escapeRegex);
    if (escapedWords.length === 0) {
        return "(?!)";
    }

    return `(?i)\\b(?:${escapedWords.join("|")})\\b`;
}

function constantWordsToRegex(words) {
    const escapedQualifiedWords = [];
    const escapedUnqualifiedWords = [];

    for (const word of sortedUnique(words)) {
        if (word.includes(".")) {
            escapedQualifiedWords.push(escapeRegex(word));
        } else {
            escapedUnqualifiedWords.push(escapeRegex(word));
        }
    }

    const alternatives = [];
    if (escapedUnqualifiedWords.length > 0) {
        /* Public graphics and COM constants are declared in namespace FB. */
        alternatives.push(`(?:FB\\.)?(?:${escapedUnqualifiedWords.join("|")})`);
    }

    if (escapedQualifiedWords.length > 0) {
        alternatives.push(`(?:${escapedQualifiedWords.join("|")})`);
    }

    if (alternatives.length === 0) {
        return "(?!)";
    }

    return `(?i)(?<![A-Za-z0-9_\\.])(?:${alternatives.join("|")})(?![A-Za-z0-9_])`;
}

function convertCaptures(captureMap) {
    const captures = {};

    for (const [captureNumber, scopeName] of Object.entries(captureMap || {})) {
        captures[captureNumber] = { name: String(scopeName) };
    }

    return captures;
}

function preprocessorContentPatterns() {
    return [
        { include: "#strings" },
        { include: "#comments" },
        { include: "#numbers" },
        { include: "#constants" },
        { include: "#operators" },
        { include: "#types" },
        { include: "#functions" },
        { include: "#keywords" }
    ];
}

function generateGrammar(source) {
    const compoundPatterns = (source.compoundPatterns || []).map((pattern) => ({
        name: pattern.name,
        match: pattern.match,
        captures: convertCaptures(pattern.captures)
    }));

    const preprocessorPattern = sortedUnique(source.preprocessorDirectives)
        .map(escapeRegex)
        .join("|");

    return {
        $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
        name: "FreeBASIC",
        scopeName: "source.freebasic",
        patterns: [
            { include: "#comments" },
            { include: "#strings" },
            { include: "#preprocessor" },
            { include: "#labels" },
            { include: "#numbers" },
            { include: "#declarations" },
            { include: "#compoundKeywords" },
            { include: "#operators" },
            { include: "#types" },
            { include: "#constants" },
            { include: "#functions" },
            { include: "#keywords" }
        ],
        repository: {
            comments: {
                patterns: [
                    {
                        name: "comment.line.apostrophe.freebasic",
                        match: "'[^\\n]*"
                    },
                    {
                        name: "comment.line.rem.freebasic",
                        match: "(?i)\\bREM\\b[^\\n]*"
                    },
                    {
                        include: "#blockComment"
                    }
                ]
            },
            blockComment: {
                name: "comment.block.freebasic",
                begin: "/'",
                end: "'/",
                patterns: [
                    { include: "#blockComment" }
                ]
            },
            strings: {
                patterns: [
                    {
                        name: "string.quoted.escape.freebasic",
                        match: '(!)(")(?:(?:\\\\[^\\r\\n])|[^"\\\\\\r\\n])*(")',
                        captures: {
                            "1": { name: "storage.modifier.freebasic" },
                            "2": { name: "punctuation.definition.string.begin.freebasic" },
                            "3": { name: "punctuation.definition.string.end.freebasic" }
                        }
                    },
                    {
                        name: "string.quoted.double.freebasic",
                        match: '([$]?)(")(?:(?:"")|[^"\\r\\n])*(")',
                        captures: {
                            "1": { name: "storage.modifier.freebasic" },
                            "2": { name: "punctuation.definition.string.begin.freebasic" },
                            "3": { name: "punctuation.definition.string.end.freebasic" }
                        }
                    }
                ]
            },
            preprocessor: {
                patterns: [
                    {
                        name: "meta.preprocessor.freebasic",
                        begin: `(?i)^(\\s*)(#)(DEFINE|MACRO)\\b\\s+(${IDENTIFIER_PATTERN})`,
                        beginCaptures: {
                            "2": { name: "punctuation.definition.directive.freebasic" },
                            "3": { name: "keyword.control.directive.freebasic" },
                            "4": { name: "entity.name.function.preprocessor.freebasic" }
                        },
                        end: "$",
                        patterns: preprocessorContentPatterns()
                    },
                    {
                        name: "meta.preprocessor.freebasic",
                        begin: `(?i)^(\\s*)(#)(${preprocessorPattern})\\b`,
                        beginCaptures: {
                            "2": { name: "punctuation.definition.directive.freebasic" },
                            "3": { name: "keyword.control.directive.freebasic" }
                        },
                        end: "$",
                        patterns: preprocessorContentPatterns()
                    }
                ]
            },
            numbers: {
                patterns: [
                    {
                        name: "constant.numeric.freebasic",
                        match: "(?i)(?<![A-Z0-9_])(?:&H[0-9A-F]+|&B[01]+|&O?[0-7]+|(?:\\d+\\.\\d*|\\.\\d+|\\d+)(?:[ED][+-]?\\d+)?)(?:U(?:LL?)?|LL?|F|D|[%!#&])?(?![A-Z0-9_])"
                    }
                ]
            },
            labels: {
                patterns: [
                    {
                        name: "meta.label.freebasic",
                        match: "(?i)^\\s*([A-Z_][A-Z0-9_]*|\\d+)(\\s*:)",
                        captures: {
                            "1": { name: "entity.name.label.freebasic" },
                            "2": { name: "punctuation.separator.label.freebasic" }
                        }
                    }
                ]
            },
            declarations: {
                patterns: [
                    {
                        name: "meta.declaration.procedure.freebasic",
                        match: "(?i)\\b(SUB|FUNCTION|PROPERTY)\\s+([A-Z_][A-Z0-9_]*(?:[$%!#&])?(?:\\.[A-Z_][A-Z0-9_]*(?:[$%!#&])?)*)",
                        captures: {
                            "1": { name: "storage.type.function.freebasic" },
                            "2": { name: "entity.name.function.freebasic" }
                        }
                    },
                    {
                        name: "meta.declaration.type.freebasic",
                        match: "(?i)\\b(TYPE|CLASS|UNION|ENUM)\\s+([A-Z_][A-Z0-9_]*(?:[$%!#&])?)",
                        captures: {
                            "1": { name: "storage.type.freebasic" },
                            "2": { name: "entity.name.type.freebasic" }
                        }
                    },
                    {
                        name: "meta.declaration.namespace.freebasic",
                        match: "(?i)\\b(NAMESPACE)\\s+([A-Z_][A-Z0-9_]*(?:\\.[A-Z_][A-Z0-9_]*)*)",
                        captures: {
                            "1": { name: "storage.type.namespace.freebasic" },
                            "2": { name: "entity.name.namespace.freebasic" }
                        }
                    },
                    {
                        name: "meta.declaration.constant.freebasic",
                        match: "(?i)\\b(CONST)\\s+(AS)\\s+(?:UNSIGNED\\s+)?[A-Z_][A-Z0-9_.]*(?:\\s+(?:PTR|POINTER))*\\s+([A-Z_][A-Z0-9_]*(?:[$%!#&])?)",
                        captures: {
                            "1": { name: "storage.modifier.freebasic" },
                            "2": { name: "storage.type.freebasic" },
                            "3": { name: "entity.name.constant.freebasic" }
                        }
                    },
                    {
                        name: "meta.declaration.constant.freebasic",
                        match: "(?i)\\b(CONST)\\s+((?!AS\\b)[A-Z_][A-Z0-9_]*(?:[$%!#&])?)",
                        captures: {
                            "1": { name: "storage.modifier.freebasic" },
                            "2": { name: "entity.name.constant.freebasic" }
                        }
                    },
                    {
                        name: "meta.declaration.variable.freebasic",
                        match: "(?i)\\b(DIM|REDIM|STATIC|COMMON|EXTERN)\\s+(?:(?:SHARED|STATIC|COMMON|EXTERN|PRESERVE)\\s+)*(AS)\\s+(?:UNSIGNED\\s+)?[A-Z_][A-Z0-9_.]*(?:\\s+(?:PTR|POINTER))*\\s+([A-Z_][A-Z0-9_]*(?:[$%!#&])?)",
                        captures: {
                            "1": { name: "storage.modifier.freebasic" },
                            "2": { name: "storage.type.freebasic" },
                            "3": { name: "variable.other.readwrite.freebasic" }
                        }
                    },
                    {
                        name: "meta.declaration.variable.freebasic",
                        match: "(?i)\\b(DIM|REDIM|STATIC|COMMON|EXTERN|VAR)\\s+(?:(?:SHARED|STATIC|COMMON|EXTERN|PRESERVE)\\s+)*((?!(?:AS|SUB|FUNCTION|PROPERTY|CONSTRUCTOR|DESTRUCTOR|OPERATOR)\\b)[A-Z_][A-Z0-9_]*(?:[$%!#&])?)",
                        captures: {
                            "1": { name: "storage.modifier.freebasic" },
                            "2": { name: "variable.other.readwrite.freebasic" }
                        }
                    },
                    {
                        name: "meta.declaration.parameter.freebasic",
                        match: "(?i)\\b(BYVAL|BYREF|BYDESC|PARAMARRAY)\\s+([A-Z_][A-Z0-9_]*(?:[$%!#&])?)",
                        captures: {
                            "1": { name: "storage.modifier.freebasic" },
                            "2": { name: "variable.parameter.freebasic" }
                        }
                    },
                    {
                        name: "meta.declaration.loop-variable.freebasic",
                        match: "(?i)\\b(FOR)\\s+([A-Z_][A-Z0-9_]*(?:[$%!#&])?)\\s+(AS)\\b",
                        captures: {
                            "1": { name: "keyword.control.freebasic" },
                            "2": { name: "variable.other.readwrite.freebasic" },
                            "3": { name: "storage.type.freebasic" }
                        }
                    }
                ]
            },
            compoundKeywords: {
                patterns: compoundPatterns
            },
            operators: {
                patterns: [
                    {
                        name: "keyword.operator.word.freebasic",
                        match: wordsToRegex(source.operatorKeywords)
                    },
                    {
                        name: "keyword.operator.symbolic.freebasic",
                        match: "(?:->|<>|<=|>=|=>|=<|[-+*/\\\\^=<>@&])"
                    }
                ]
            },
            types: {
                patterns: [
                    {
                        name: "storage.type.freebasic",
                        match: wordsToRegex([...(source.types || []), ...(source.libraryTypes || [])])
                    },
                    {
                        name: "storage.modifier.freebasic",
                        match: wordsToRegex(source.typeModifiers)
                    }
                ]
            },
            constants: {
                patterns: [
                    {
                        name: "constant.language.freebasic",
                        match: `${wordsToRegex([...(source.constants || []), ...(source.compilerDefines || [])])}|__(?:[A-Z0-9_]+)__`
                    },
                    {
                        name: "constant.other.freebasic",
                        match: constantWordsToRegex(source.symbolicConstants)
                    }
                ]
            },
            functions: {
                patterns: [
                    {
                        name: "support.function.freebasic",
                        match: wordsToRegex(source.intrinsicFunctions)
                    },
                    {
                        name: "support.function.freebasic",
                        match: wordsToRegex(source.runtimeFunctions)
                    },
                    {
                        name: "support.function.freebasic",
                        match: wordsToRegex(source.graphicsFunctions)
                    },
                    {
                        name: "support.function.freebasic",
                        match: wordsToRegex(source.bundledFunctions)
                    }
                ]
            },
            keywords: {
                patterns: [
                    {
                        name: "keyword.control.freebasic",
                        match: wordsToRegex(source.keywords)
                    }
                ]
            }
        }
    };
}

function parseArguments(args) {
    const options = {
        sourcePath: DEFAULT_SOURCE_PATH,
        outputPath: DEFAULT_OUTPUT_PATH
    };

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        const value = args[index + 1];

        if (argument === "--source" && value) {
            options.sourcePath = value;
            index++;
        } else if (argument === "--output" && value) {
            options.outputPath = value;
            index++;
        } else {
            throw new Error(`Unknown or incomplete argument: ${argument}`);
        }
    }

    return options;
}

function buildGrammar(sourcePath, outputPath) {
    const resolvedSourcePath = path.resolve(sourcePath);
    const resolvedOutputPath = path.resolve(outputPath);
    const source = JSON.parse(fs.readFileSync(resolvedSourcePath, "utf8"));
    const grammar = generateGrammar(source);

    fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
    fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(grammar, null, 2)}\n`, "utf8");

    return resolvedOutputPath;
}

function main(args = process.argv.slice(2)) {
    const options = parseArguments(args);
    const outputPath = buildGrammar(options.sourcePath, options.outputPath);
    console.log(`Generated ${path.relative(process.cwd(), outputPath) || outputPath}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    buildGrammar,
    constantWordsToRegex,
    generateGrammar,
    parseArguments,
    sortedUnique,
    wordsToRegex
};

/* end of tools/build-freebasic-grammar.js */
