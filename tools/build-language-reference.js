/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tools/build-language-reference.js

    Purpose:

        Generate the offline editor reference from the matching FreeBASIC
        manual and public headers.

    Responsibilities:

        - extract short descriptions, usage forms, and callable signatures
        - retain source locations and documentation attribution
        - write deterministic JSON and the documentation license

    This file intentionally does NOT contain:

        - hand-maintained copies of built-in function signatures
        - editor API objects
        - compiler execution
*/

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const { parseFreeBasicText } = require("../lib/freebasic-parser");
const { collectGrammarCoverage, readFreeBasicVersion, resolveFreeBasicRoot } = require("./audit-freebasic-coverage");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const HEADER_PATHS = ["inc/builtin.bi", "inc/fbgfx.bi", "inc/fbgfx3.bi", "inc/fbcom.bi", "inc/fbserialize.bi", "inc/sfxlib_effects.bi", "inc/sfxlib_raw.bi"];
/* Compiler intrinsics exposed through opt-in header macros are not grammar names. */
const OPT_IN_REFERENCE_HEADERS = Object.freeze({
    SERIALIZE: "fbserialize.bi",
    DESERIALIZE: "fbserialize.bi"
});
/* Manual prose is useful in hovers, but example blocks and large pages are not. */
const MAX_REFERENCE_RETURN_LENGTH = 600;
const MAX_REFERENCE_DESCRIPTION_LENGTH = 1800;

/* ------------------------------------------------------------------------- */
/* Manual extraction                                                         */
/* ------------------------------------------------------------------------- */

function plainText(source) {
    return source
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\{\{[^}]*\}\}/g, "")
        .replace(/##|\*\*|\/\/|""/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
        .replace(/\r/g, "").trim();
}

function conciseManualSection(source, maximumLength) {
    const paragraphs = plainText(source)
        .replace(/%%[\s\S]*?%%/g, "\n")
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
        .filter(Boolean);
    const kept = [];
    let length = 0;
    for (const paragraph of paragraphs) {
        const separatorLength = kept.length ? 2 : 0;
        const available = maximumLength - length - separatorLength;
        if (available <= 0) break;
        if (paragraph.length <= available) {
            kept.push(paragraph);
            length += separatorLength + paragraph.length;
            continue;
        }
        if (available >= 80) kept.push(`${paragraph.slice(0, available - 3).trimEnd()}...`);
        break;
    }
    return kept.join("\n\n");
}

function readSections(source) {
    const sections = {};
    const matches = [...source.matchAll(/\{\{fbdoc item="([^"]+)"(?: value="([^"]*)")?\}\}/g)];
    for (let index = 0; index < matches.length; index++) {
        const match = matches[index];
        const end = matches[index + 1]?.index ?? source.length;
        if (!(match[1] in sections)) {
            sections[match[1]] = source.slice(match.index + match[0].length, end);
        }
    }
    return sections;
}

function parseManualCallSignatures(source, name, parameterDocumentation) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const calls = new RegExp(`\\b(${escapedName})\\s*\\(`, "gi");
    const signatures = [];
    for (const match of source.matchAll(calls)) {
        const open = match.index + match[0].lastIndexOf("(");
        let depth = 1;
        let argumentStart = open + 1;
        let argumentsText = "";
        const arguments_ = [];
        let complete = false;
        for (let index = open + 1; index < source.length; index++) {
            const character = source[index];
            if (character === "(") depth++;
            else if (character === ")") {
                depth--;
                if (depth === 0) {
                    argumentsText = source.slice(open + 1, index).trim();
                    arguments_.push(...splitManualCallArguments(source.slice(argumentStart, index)));
                    complete = true;
                    break;
                }
            } else if (character === "," && depth === 1) {
                arguments_.push(source.slice(argumentStart, index).trim());
                argumentStart = index + 1;
            }
        }
        if (!complete || !argumentsText || !arguments_.length) continue;
        const parameters = arguments_.map((argument) => {
            const parameter = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?$/);
            if (!parameter) return null;
            const label = argument.replace(/\s+/g, " ").trim();
            return {
                name: parameter[1],
                label,
                typeName: "",
                optional: false,
                variadic: false,
                documentation: parameterDocumentation[label.toLowerCase()] || ""
            };
        });
        if (parameters.some((parameter) => parameter === null)) continue;
        signatures.push({ label: `${match[1]}(${argumentsText.replace(/\s+/g, " ")})`, parameters });
    }
    return signatures;
}

function splitManualCallArguments(source) {
    let depth = 0;
    let start = 0;
    const arguments_ = [];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === "(") depth++;
        else if (source[index] === ")") depth--;
        else if (source[index] === "," && depth === 0) {
            arguments_.push(source.slice(start, index).trim());
            start = index + 1;
        }
    }
    const last = source.slice(start).trim();
    if (last) arguments_.push(last);
    return arguments_;
}

function parseManualEntry(source, sourcePath) {
    const title = source.match(/\{\{fbdoc item="title" value="([^"]+)"\}\}/)?.[1];
    if (!title) return null;
    const name = title.replace(/\s+\(.*/, "").trim().toUpperCase();
    if (!/^#?[A-Z_][A-Z0-9_ ]*[$%!#&]?$/.test(name)) return null;

    const sections = readSections(source);
    const summary = plainText((sections.title || "").replace(/^[-\s]+/, "")).split(/\n\s*\n/)[0];
    const syntax = plainText(sections.syntax || "");
    const declarations = parseFreeBasicText(syntax).declarations.filter((declaration) =>
        ["function", "sub"].includes(declaration.type) && declaration.name.toUpperCase() === name
    );
    const parameters = {};
    const parameterSource = sections.param || "";
    const parameterPattern = /^\s*##([^\n]+?)##[ \t]*\r?\n([\s\S]*?)(?=^\s*##|$)/gm;
    for (const match of parameterSource.matchAll(parameterPattern)) {
        for (const parameter of plainText(match[1]).split(/,\s*/)) {
            parameters[parameter.toLowerCase()] = plainText(match[2]).replace(/\s+/g, " ").slice(0, 600);
        }
    }
    const signatures = declarations.map((declaration) => ({
        label: declaration.signature,
        parameters: declaration.parameters.map((parameter) => ({
            ...parameter,
            documentation: parameters[parameter.name.toLowerCase()] || ""
        })),
        typeName: declaration.typeName
    }));
    if (!signatures.length && Object.hasOwn(OPT_IN_REFERENCE_HEADERS, name)) {
        signatures.push(...parseManualCallSignatures(syntax, name, parameters));
    }
    const returns = conciseManualSection(sections.ret || "", MAX_REFERENCE_RETURN_LENGTH);
    const description = conciseManualSection(sections.desc || "", MAX_REFERENCE_DESCRIPTION_LENGTH);

    return {
        name,
        title,
        summary: summary.replace(/\s+/g, " ").slice(0, 600),
        usage: plainText(sections.usage || sections.syntax || "").split("\n")
            .map((line) => line.trim()).filter(Boolean).slice(0, 20).join("\n"),
        signatures,
        ...(returns ? { returns } : {}),
        ...(description ? { description } : {}),
        ...(OPT_IN_REFERENCE_HEADERS[name] ? { header: OPT_IN_REFERENCE_HEADERS[name] } : {}),
        sourcePath
    };
}

/* ------------------------------------------------------------------------- */
/* Reference assembly and command entry point                                 */
/* ------------------------------------------------------------------------- */

function generateReference(freeBasicRoot, grammar) {
    const sourceVersion = readFreeBasicVersion(freeBasicRoot);
    if (sourceVersion !== grammar.sourceVersion) {
        throw new Error(`Reference target ${grammar.sourceVersion} does not match compiler ${sourceVersion}.`);
    }

    const coverage = collectGrammarCoverage(grammar);
    for (const directive of grammar.preprocessorDirectives) coverage.add(`#${directive.toUpperCase()}`);
    const entries = {};
    const sourceHash = createHash("sha256");
    const manualDirectory = path.join(freeBasicRoot, "doc/manual/cache");
    const pages = fs.readdirSync(manualDirectory).filter((name) => /^KeyPg.*\.wakka$/.test(name)).sort();
    function readSource(relativePath) {
        /* Git checkouts can use CRLF on Windows; provenance hashes logical text. */
        const source = fs.readFileSync(path.join(freeBasicRoot, relativePath), "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
        sourceHash.update(relativePath).update("\0").update(source).update("\0");
        return source;
    }
    function addEntry(entry) {
        (entries[entry.name] ||= []).push(entry);
    }

    for (const page of pages) {
        const sourcePath = `doc/manual/cache/${page}`;
        const entry = parseManualEntry(readSource(sourcePath), sourcePath);
        if (entry && (coverage.has(entry.name) || Object.hasOwn(OPT_IN_REFERENCE_HEADERS, entry.name))) addEntry(entry);
    }

    const bundledTypes = new Map();
    for (const header of HEADER_PATHS) {
        const parsed = parseFreeBasicText(readSource(header));
        for (const declaration of parsed.declarations) {
            const name = declaration.name.toUpperCase();
            if (!coverage.has(name)) continue;
            if (["function", "sub"].includes(declaration.type)) {
                addEntry({
                    name,
                    title: declaration.qualifiedName,
                    summary: `Declared in ${header.slice(4)}.`,
                    header: header.slice(4),
                    namespace: declaration.containerName,
                    usage: "",
                    signatures: [{
                        label: declaration.signature,
                        parameters: declaration.parameters,
                        typeName: declaration.typeName
                    }],
                    sourcePath: header,
                    sourceLine: declaration.line + 1
                });
                continue;
            }
            if (!["type", "union", "enum", "class"].includes(declaration.type)) continue;
            const types = bundledTypes.get(name) || [];
            types.push({
                name,
                title: declaration.qualifiedName,
                summary: `Declared in ${header.slice(4)}.`,
                header: header.slice(4),
                namespace: declaration.containerName || "",
                usage: "",
                signatures: [],
                sourcePath: header,
                sourceLine: declaration.line + 1
            });
            bundledTypes.set(name, types);
        }
    }

    for (const [name, declarations] of bundledTypes) {
        const candidates = new Map(declarations.map((entry) => [
            `${entry.header.toLowerCase()}\t${entry.namespace.toLowerCase()}`, entry
        ]));
        const existing = entries[name] || [];
        const existingHeaders = new Set(existing.filter((entry) => entry.header).map((entry) =>
            `${entry.header.toLowerCase()}\t${(entry.namespace || "").toLowerCase()}`
        ));
        if (candidates.size === 1 && (!existingHeaders.size || existingHeaders.size === 1 &&
            existingHeaders.has(candidates.keys().next().value))) {
            const candidate = candidates.values().next().value;
            if (existing.length) {
                for (const entry of existing) {
                    if (entry.header) continue;
                    entry.header = candidate.header;
                    entry.namespace = candidate.namespace;
                }
            } else {
                addEntry(candidate);
            }
            continue;
        }
        for (const [key, candidate] of candidates) {
            if (existingHeaders.has(key) || existing.some((entry) =>
                entry.header?.toLowerCase() === candidate.header.toLowerCase() &&
                (entry.namespace || "").toLowerCase() === candidate.namespace.toLowerCase()
            )) continue;
            addEntry(candidate);
        }
    }

    return {
        title: `FreeBASIC ${sourceVersion} editor reference`,
        sourceVersion,
        sourceRevision: execFileSync("git", ["-C", freeBasicRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sourceHash: sourceHash.digest("hex"),
        attribution: "Manual excerpts: The FreeBASIC documentation contributors, GNU Free Documentation License 1.2. See docs/reference-attribution.md and docs/fdl-1.2.txt.",
        sourceRepository: "https://github.com/jasonkfirth/fbc",
        entries: Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]]))
    };
}

function main() {
    const args = process.argv.slice(2);
    if (args.length && (args[0] !== "--freebasic-root" || args.length !== 2)) {
        throw new Error("Usage: node tools/build-language-reference.js [--freebasic-root <path>]");
    }
    const root = resolveFreeBasicRoot(args[1] || process.env.FREEBASIC_ROOT || "");
    const grammar = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "syntaxes/source/freebasic.grammar-source.json"), "utf8"));
    const reference = generateReference(root, grammar);
    fs.mkdirSync(path.join(REPOSITORY_ROOT, "data"), { recursive: true });
    fs.writeFileSync(path.join(REPOSITORY_ROOT, "data/language-reference.json"), JSON.stringify(reference, null, 2) + "\n", "utf8");
    fs.copyFileSync(path.join(root, "doc/fdl-1.2.txt"), path.join(REPOSITORY_ROOT, "docs/fdl-1.2.txt"));
    console.log(`Generated reference for ${Object.keys(reference.entries).length} FreeBASIC ${reference.sourceVersion} names.`);
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { generateReference, parseManualEntry, plainText, readSections };

/* end of tools/build-language-reference.js */
