/*
    Project: FreeBASIC VS Code Language Extension
    ------------------------------------------------

    File: tools/audit-freebasic-coverage.js

    Purpose:

        Compare the extension's language data with the FreeBASIC compiler and
        bundled runtime headers that define the public language surface.

    Responsibilities:

        - discover a local FreeBASIC source tree without platform-specific paths
        - verify compiler keywords, preprocessor directives, and public RTL names
        - verify parser-defined sound command families
        - verify bundled compiler builtins, graphics, sfxlib, and COM APIs

    This file intentionally does NOT contain:

        - grammar generation
        - source-tree modification
        - compiler execution
*/

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const { sortedUnique } = require("./build-freebasic-grammar");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const DEFAULT_GRAMMAR_SOURCE_PATH = path.join(
    REPOSITORY_ROOT,
    "syntaxes",
    "source",
    "freebasic.grammar-source.json"
);

const HEADER_API_PATHS = [
    "inc/builtin.bi",
    "inc/fbgfx.bi",
    "inc/fbgfx3.bi",
    "inc/fbcom.bi",
    "inc/sfxlib_effects.bi",
    "inc/sfxlib_raw.bi"
];

const VERSIONED_SURFACE_PATHS = [
    "src/compiler",
    ...HEADER_API_PATHS
];

function readText(filePath) {
    return fs.readFileSync(filePath, "utf8");
}

function asUpperSet(values) {
    return new Set((values || []).map((value) => String(value).toUpperCase()));
}

function setDifference(left, right) {
    return sortedUnique([...left].filter((value) => !right.has(value)));
}

function addDifferenceError(errors, label, actual, expected) {
    const missing = setDifference(expected, actual);
    const stale = setDifference(actual, expected);

    if (missing.length > 0) {
        errors.push(`${label} missing: ${missing.join(", ")}`);
    }

    if (stale.length > 0) {
        errors.push(`${label} stale: ${stale.join(", ")}`);
    }
}

function collectGrammarCoverage(grammarSource) {
    const coverage = new Set();
    const groups = [
        "preprocessorDirectives",
        "operatorKeywords",
        "types",
        "typeModifiers",
        "constants",
        "compilerDefines",
        "libraryTypes",
        "symbolicConstants",
        "intrinsicFunctions",
        "bundledFunctions",
        "runtimeFunctions",
        "graphicsFunctions",
        "keywords"
    ];

    for (const group of groups) {
        for (const value of grammarSource[group] || []) {
            coverage.add(String(value).toUpperCase());
        }
    }

    for (const pattern of grammarSource.compoundPatterns || []) {
        for (const match of pattern.match.matchAll(/[A-Z_][A-Z0-9_]*/g)) {
            coverage.add(match[0]);
        }
    }

    return coverage;
}

function extractCompilerKeywords(compilerRoot) {
    const source = readText(path.join(compilerRoot, "symb-keyword.bas"));
    return asUpperSet([...source.matchAll(/@"([^"]+)"/g)].map((match) => match[1]));
}

function extractPreprocessorDirectives(compilerRoot) {
    const source = readText(path.join(compilerRoot, "pp.bas"));
    const directives = [...source.matchAll(/\(@"([A-Z]+)"\s*,\s*FB_TK_PP_[A-Z]+\s*\)/g)]
        .map((match) => match[1]);
    return asUpperSet(directives);
}

function extractPublicRtlNames(compilerRoot) {
    const names = new Set();
    const rtlFiles = fs.readdirSync(compilerRoot)
        .filter((fileName) => /^rtl-.*\.bas$/i.test(fileName))
        .sort((left, right) => left.localeCompare(right));

    for (const fileName of rtlFiles) {
        const source = readText(path.join(compilerRoot, fileName));
        const entryPattern = /\(\s*_?\s*@"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*(?:@"[^"]+"|NULL)\s*,/g;

        for (const match of source.matchAll(entryPattern)) {
            const name = match[1].toUpperCase();

            /*
                Registration tables also contain a few FB_* implementation
                helpers. They are callable compiler internals, not public BASIC
                spellings, and the public macro or parser form is audited
                separately.
            */
            if (!name.startsWith("FB_")) {
                names.add(name);
            }
        }
    }

    return names;
}

function extractParserMatchedWords(compilerRoot) {
    const words = new Set();
    const parserFiles = fs.readdirSync(compilerRoot)
        .filter((fileName) => /^parser-.*\.bas$/i.test(fileName));

    for (const fileName of parserFiles) {
        const source = readText(path.join(compilerRoot, fileName));

        for (const match of source.matchAll(/hMatchIdOrKw\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
            words.add(match[1].toUpperCase());
        }
    }

    /* INCLUDE ONCE is highlighted as one preprocessor line, not as a keyword. */
    words.delete("ONCE");
    return words;
}

function extractParserFamilyWords(compilerRoot, family) {
    const source = readText(path.join(compilerRoot, "parser-quirk-sfx.bas"));
    const functionPattern = new RegExp(
        `private\\s+function\\s+hParse${family}\\b([\\s\\S]*?)\\nend\\s+function`,
        "i"
    );
    const functionMatch = source.match(functionPattern);

    if (!functionMatch) {
        throw new Error(`Unable to find hParse${family}() in parser-quirk-sfx.bas`);
    }

    return asUpperSet(
        [...functionMatch[1].matchAll(/hMatchIdOrKw\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)]
            .map((match) => match[1])
    );
}

function extractGrammarFamilyWords(grammarSource, family) {
    const familyName = family.toLowerCase();
    const words = new Set();

    for (const pattern of grammarSource.compoundPatterns || []) {
        if (!String(pattern.name).startsWith(`meta.${familyName}.`)) {
            continue;
        }

        for (const match of pattern.match.matchAll(/[A-Z_][A-Z0-9_]*/g)) {
            if (match[0] !== family.toUpperCase()) {
                words.add(match[0]);
            }
        }
    }

    return words;
}

function extractCompilerDefines(freeBasicRoot) {
    const compilerRoot = path.join(freeBasicRoot, "src", "compiler");
    const defineSource = readText(path.join(compilerRoot, "symb-define.bas"));
    const symbolSource = readText(path.join(compilerRoot, "symb.bas"));
    const fbSource = readText(path.join(compilerRoot, "fb.bi"));
    const rtlMacroSource = readText(path.join(compilerRoot, "rtl-macro.bas"));
    const compilerDriverSource = readText(path.join(compilerRoot, "fbc.bas"));
    const defines = new Set();

    for (const match of defineSource.matchAll(/\(@"(__[A-Z0-9_]+__)"\s*,/g)) {
        defines.add(match[1]);
    }

    for (const match of defineSource.matchAll(/symbAddDefine\(\s*(?:@)?"(__[A-Z0-9_]+__)"/g)) {
        defines.add(match[1]);
    }

    for (const match of fbSource.matchAll(/^\s*FB_COMPTARGET_([A-Z0-9_]+)\s*$/gm)) {
        defines.add(`__FB_${match[1]}__`);
    }

    for (const match of rtlMacroSource.matchAll(/@"(__[A-Z0-9_]+__)"/g)) {
        defines.add(match[1]);
    }

    for (const match of symbolSource.matchAll(/symbIsDefineSet\(\s*@"([A-Z0-9_]+)"/g)) {
        defines.add(match[1]);
    }

    if (compilerDriverSource.includes("__FB_GFXLIB3__")) {
        defines.add("__FB_GFXLIB3__");
    }

    return defines;
}

function extractHeaderApi(freeBasicRoot) {
    const functions = new Set();
    const types = new Set();

    for (const relativePath of HEADER_API_PATHS) {
        const source = readText(path.join(freeBasicRoot, relativePath));

        for (const match of source.matchAll(/\bdeclare\s+(?:function|sub)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
            functions.add(match[1].toUpperCase());
        }

        for (const match of source.matchAll(/^[ \t]*type[ \t]+(?!as\b)([A-Za-z_][A-Za-z0-9_]*)/gmi)) {
            types.add(match[1].toUpperCase());
        }
    }

    return { functions, types };
}

function extractSelectedHeaderConstants(freeBasicRoot) {
    const constants = new Set();

    for (const relativePath of HEADER_API_PATHS) {
        const source = readText(path.join(freeBasicRoot, relativePath));
        let inConstantDeclaration = false;
        let inEnumDeclaration = false;

        for (const line of source.split(/\r?\n/)) {
            if (/^\s*const\b/i.test(line)) {
                inConstantDeclaration = true;
            }

            if (/^\s*enum(?:\s|$)/i.test(line)) {
                inEnumDeclaration = true;
            } else if (/^\s*end\s+enum\b/i.test(line)) {
                inEnumDeclaration = false;
                continue;
            }

            if (inConstantDeclaration) {
                for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
                    constants.add(match[1].toUpperCase());
                }

                if (!/_\s*$/.test(line)) {
                    inConstantDeclaration = false;
                }
            }

            if (inEnumDeclaration) {
                const memberMatch = line.match(/^\s*([A-Z][A-Z0-9_]*)\b/);
                if (memberMatch) {
                    constants.add(memberMatch[1]);
                }
            }
        }
    }

    return constants;
}

function readFreeBasicVersion(freeBasicRoot) {
    const versionSource = readText(path.join(freeBasicRoot, "mk", "version.mk"));
    const match = versionSource.match(/^FBVERSION\s*:=\s*([^\s#]+)/m);

    if (!match) {
        throw new Error("Unable to read FBVERSION from mk/version.mk");
    }

    return match[1];
}

function isVersionSurfaceCompatible(freeBasicRoot, targetVersion, checkoutVersion) {
    if (targetVersion === checkoutVersion) {
        return true;
    }

    /*
        Development checkouts can carry the next version number before any
        public language surface changes. In that case, a clean diff from the
        requested release tag gives the audit a reproducible compatibility
        boundary without accepting arbitrary version mismatches.
    */
    if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
        return false;
    }

    const result = childProcess.spawnSync(
        "git",
        ["-C", freeBasicRoot, "diff", "--quiet", `v${targetVersion}`, "--", ...VERSIONED_SURFACE_PATHS],
        { stdio: "ignore" }
    );
    return !result.error && result.status === 0;
}

function auditCoverage(grammarSourcePath, freeBasicRoot) {
    const grammarSource = JSON.parse(readText(grammarSourcePath));
    const compilerRoot = path.join(freeBasicRoot, "src", "compiler");
    const errors = [];
    const coverage = collectGrammarCoverage(grammarSource);

    const sourceVersion = String(grammarSource.sourceVersion || "");
    const checkoutVersion = readFreeBasicVersion(freeBasicRoot);
    const versionSurfaceCompatible = isVersionSurfaceCompatible(
        freeBasicRoot,
        sourceVersion,
        checkoutVersion
    );
    if (!versionSurfaceCompatible) {
        errors.push(`sourceVersion is ${sourceVersion || "missing"}; compiler source is ${checkoutVersion}`);
    }

    const compilerKeywords = extractCompilerKeywords(compilerRoot);
    compilerKeywords.delete("REM");
    const missingCompilerKeywords = setDifference(compilerKeywords, coverage);
    if (missingCompilerKeywords.length > 0) {
        errors.push(`compiler keyword coverage missing: ${missingCompilerKeywords.join(", ")}`);
    }

    const sourceDirectives = extractPreprocessorDirectives(compilerRoot);
    const grammarDirectives = asUpperSet(grammarSource.preprocessorDirectives);
    addDifferenceError(errors, "preprocessor directives", grammarDirectives, sourceDirectives);

    const publicRtlNames = extractPublicRtlNames(compilerRoot);
    const missingRtlNames = setDifference(publicRtlNames, coverage);
    if (missingRtlNames.length > 0) {
        errors.push(`public RTL coverage missing: ${missingRtlNames.join(", ")}`);
    }

    const parserWords = extractParserMatchedWords(compilerRoot);
    const missingParserWords = setDifference(parserWords, coverage);
    if (missingParserWords.length > 0) {
        errors.push(`parser word coverage missing: ${missingParserWords.join(", ")}`);
    }

    for (const family of ["Music", "Sfx", "Midi", "Device", "Capture"]) {
        const parserFamilyWords = extractParserFamilyWords(compilerRoot, family);
        const grammarFamilyWords = extractGrammarFamilyWords(grammarSource, family);
        addDifferenceError(errors, `${family.toUpperCase()} command family`, grammarFamilyWords, parserFamilyWords);
    }

    const compilerDefines = extractCompilerDefines(freeBasicRoot);
    const grammarDefines = asUpperSet(grammarSource.compilerDefines);
    addDifferenceError(errors, "compiler defines", grammarDefines, compilerDefines);

    const headerApi = extractHeaderApi(freeBasicRoot);
    const grammarBundledFunctions = asUpperSet(grammarSource.bundledFunctions);
    const grammarLibraryTypes = asUpperSet(grammarSource.libraryTypes);
    addDifferenceError(errors, "bundled functions", grammarBundledFunctions, headerApi.functions);
    addDifferenceError(errors, "bundled types", grammarLibraryTypes, headerApi.types);

    const selectedHeaderConstants = extractSelectedHeaderConstants(freeBasicRoot);
    const grammarSymbolicConstants = asUpperSet(grammarSource.symbolicConstants);
    const missingHeaderConstants = setDifference(selectedHeaderConstants, grammarSymbolicConstants);
    if (missingHeaderConstants.length > 0) {
        errors.push(`bundled constant coverage missing: ${missingHeaderConstants.join(", ")}`);
    }

    return {
        errors,
        sourceVersion,
        checkoutVersion,
        versionSurfaceCompatible,
        counts: {
            compilerKeywords: compilerKeywords.size,
            preprocessorDirectives: sourceDirectives.size,
            publicRtlNames: publicRtlNames.size,
            parserWords: parserWords.size,
            compilerDefines: compilerDefines.size,
            bundledFunctions: headerApi.functions.size,
            bundledTypes: headerApi.types.size,
            selectedHeaderConstants: selectedHeaderConstants.size
        }
    };
}

function parseArguments(args) {
    const options = {
        freeBasicRoot: process.env.FREEBASIC_ROOT || "",
        grammarSourcePath: DEFAULT_GRAMMAR_SOURCE_PATH
    };

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        const value = args[index + 1];

        if (argument === "--freebasic-root" && value) {
            options.freeBasicRoot = value;
            index++;
        } else if (argument === "--grammar-source" && value) {
            options.grammarSourcePath = value;
            index++;
        } else {
            throw new Error(`Unknown or incomplete argument: ${argument}`);
        }
    }

    return options;
}

function resolveFreeBasicRoot(configuredRoot) {
    const candidates = [];

    if (configuredRoot) {
        candidates.push(configuredRoot);
    } else {
        candidates.push(path.resolve(REPOSITORY_ROOT, "..", "..", "fbc"));
        candidates.push(path.resolve(REPOSITORY_ROOT, "..", "fbc"));
    }

    for (const candidate of candidates) {
        const resolvedCandidate = path.resolve(candidate);
        const keywordPath = path.join(resolvedCandidate, "src", "compiler", "symb-keyword.bas");

        if (fs.existsSync(keywordPath)) {
            return resolvedCandidate;
        }
    }

    throw new Error(
        "Unable to locate the FreeBASIC source tree. Set FREEBASIC_ROOT or pass --freebasic-root."
    );
}

function main(args = process.argv.slice(2)) {
    const options = parseArguments(args);
    const freeBasicRoot = resolveFreeBasicRoot(options.freeBasicRoot);
    const grammarSourcePath = path.resolve(options.grammarSourcePath);
    const result = auditCoverage(grammarSourcePath, freeBasicRoot);

    console.log(`FreeBASIC source: ${freeBasicRoot}`);
    console.log(`Compatibility target: FreeBASIC ${result.sourceVersion}`);
    console.log(`Audited checkout version: ${result.checkoutVersion}`);
    if (result.sourceVersion !== result.checkoutVersion && result.versionSurfaceCompatible) {
        console.log(`Public language surface matches tag v${result.sourceVersion}.`);
    }

    for (const [name, count] of Object.entries(result.counts)) {
        console.log(`${name}: ${count}`);
    }

    if (result.errors.length > 0) {
        console.error("Coverage audit failed:");
        for (const error of result.errors) {
            console.error(`  ${error}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log("Coverage audit passed.");
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
    auditCoverage,
    collectGrammarCoverage,
    extractCompilerDefines,
    extractCompilerKeywords,
    extractGrammarFamilyWords,
    extractHeaderApi,
    extractParserFamilyWords,
    extractParserMatchedWords,
    extractPreprocessorDirectives,
    extractPublicRtlNames,
    extractSelectedHeaderConstants,
    isVersionSurfaceCompatible,
    parseArguments,
    readFreeBasicVersion,
    resolveFreeBasicRoot
};

/* end of tools/audit-freebasic-coverage.js */
