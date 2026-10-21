/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: lib/language-reference.js

    Purpose:

        Present the generated offline reference to editor services.

    Responsibilities:

        - find documentation for builtin and bundled symbols
        - deduplicate overload signatures
        - provide plain Markdown without executable links or HTML

    This file intentionally does NOT contain:

        - runtime access to the compiler source checkout
        - manual parsing or generation
        - VS Code API objects
*/

const reference = require("../data/language-reference.json");
const referenceNames = Object.keys(reference.entries);
const sourceModifiedPaths = new Set(reference.sourceModifiedPaths || []);
/* Keep overload-heavy hover and completion cards compact. */
const MAX_REFERENCE_PARAMETER_DOCUMENTS = 12;
/* Some bundled headers select a compiler mode or linker library. */
const HEADER_USAGE_NOTES = Object.freeze({
    "fbgfx.bi": "This header links the selected graphics runtime automatically.",
    "fbgfx3.bi": "Including `fbgfx3.bi` selects and links gfxlib3; use `-gfx3` to select it for unchanged source.",
    "sfxlib_effects.bi": "This header links the sfxlib runtime automatically.",
    "sfxlib_raw.bi": "This header links the sfxlib runtime automatically."
});

function getReferenceNames() {
    return referenceNames.slice();
}

function getReferenceEntries(name) {
    const parts = String(name).replace(/[$%!#&]$/, "").toUpperCase().split(".");
    const key = parts.pop();
    const entries = reference.entries[key] || [];
    if (!parts.length) return entries;
    const namespace = parts.join(".");
    return entries.filter((entry) => entry.namespace?.toUpperCase() === namespace);
}

function getReferenceSignatures(name) {
    const seen = new Set();
    const signatures = [];
    for (const entry of getReferenceEntries(name)) {
        for (const signature of entry.signatures) {
            const key = signature.label.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                const documentation = [
                    entry.summary,
                    entry.returns ? `Returns: ${entry.returns}` : "",
                    entry.description || "",
                    entry.header ? `Requires #include once "${entry.header}".` : ""
                ].filter(Boolean).join("\n\n");
                signatures.push({ ...signature, documentation, header: entry.header });
            }
        }
    }
    return signatures;
}

function getReferenceMarkdown(name, { header } = {}) {
    const normalizedHeader = typeof header === "string" ? header.toLowerCase() : "";
    const entries = getReferenceEntries(name).filter((entry) =>
        !normalizedHeader || entry.header?.toLowerCase() === normalizedHeader
    );
    if (!entries.length) return null;
    const paragraphs = [];
    for (const entry of entries.slice(0, 4)) {
        const signatureText = entry.signatures.map((signature) => signature.label).join("\n");
        const usage = signatureText || entry.usage;
        if (usage) paragraphs.push(`\`\`\`freebasic\n${usage}\n\`\`\``);
        if (entry.summary) paragraphs.push(entry.summary);
        if (entry.returns) paragraphs.push(`Returns: ${entry.returns}`);
        if (entry.description) paragraphs.push(entry.description);
        const parameterDocumentation = referenceParameterDocumentation(entry);
        if (parameterDocumentation) paragraphs.push(parameterDocumentation);
        if (entry.header) paragraphs.push(`Requires \`#include once "${entry.header}"\`${entry.namespace ? `; namespace \`${entry.namespace}\`` : ""}.`);
        if (sourceModifiedPaths.has(entry.sourcePath)) {
            paragraphs.push(`Source reference: \`${entry.sourcePath}\` (working-copy snapshot).`);
        } else {
            const sourceUrl = `${reference.sourceRepository}/blob/${reference.sourceRevision}/${entry.sourcePath}${entry.sourceLine ? `#L${entry.sourceLine}` : ""}`;
            paragraphs.push(`[Source reference](${sourceUrl})`);
        }
    }
    const usageNotes = new Set(entries.map((entry) => HEADER_USAGE_NOTES[entry.header?.toLowerCase()]).filter(Boolean));
    paragraphs.push(...usageNotes);
    paragraphs.push(`FreeBASIC ${reference.sourceVersion} reference. Manual excerpts: FreeBASIC documentation contributors (GNU FDL 1.2).`);
    return paragraphs.join("\n\n");
}

function referenceParameterDocumentation(entry) {
    const descriptions = new Map();
    for (const signature of entry.signatures || []) {
        for (const parameter of signature.parameters || []) {
            const name = String(parameter.name || parameter.label || "").trim();
            const documentation = String(parameter.documentation || "").trim();
            if (!name || !documentation) continue;
            const key = `${name.toLowerCase()}\t${documentation}`;
            if (!descriptions.has(key)) descriptions.set(key, { name, documentation });
        }
    }
    if (!descriptions.size) return "";

    const values = [...descriptions.values()];
    const shown = values.slice(0, MAX_REFERENCE_PARAMETER_DOCUMENTS);
    const lines = shown.map(({ name, documentation }) => `- \`${name}\`: ${documentation}`);
    const remaining = values.length - shown.length;
    if (remaining) lines.push(`- ${remaining} additional parameter descriptions omitted`);
    return `Parameters:\n\n${lines.join("\n")}`;
}

module.exports = { getReferenceEntries, getReferenceMarkdown, getReferenceNames, getReferenceSignatures };

/* end of lib/language-reference.js */
