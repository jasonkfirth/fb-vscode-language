/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-preprocessor-model.js
    Purpose: Present native preprocessor identities at physical source tokens.
    Responsibilities: project declarations/uses and preserve parameter ownership.
    Does not contain: macro evaluation, spelling-based binding, or source edits.
*/

const { createMacroProjector } = require("./compiler-macros");

const MAX_MACRO_DEFINITION_PREVIEW_LENGTH = 1200;
const MAX_MACRO_DEFINITION_PREVIEW_LINES = 32;
/* Keep shared-header completion inside the eight retained epoch views. */
const MAX_PREPROCESSOR_COMPLETION_CONTEXTS = 8;

function macroDefinitionPreview(document, occurrence) {
    const lineStart = document.lineOffsets[occurrence.line];
    const lineEnd = document.lineOffsets[occurrence.line + 1] ?? document.text.length;
    const line = document.text.slice(lineStart, lineEnd).replace(/[\r\n]+$/, "");
    const directive = line.match(/^\s*#\s*(define|macro)\b/i);
    if (!directive ||
        line.slice(occurrence.startColumn, occurrence.endColumn).toLowerCase() !== occurrence.name.toLowerCase()) return "";

    const lines = [line];
    let currentLine = occurrence.line;
    let length = line.length;
    const hasContinuation = (sourceLine) => /(?:^|\s)_(?:\s*(?:'.*)?)$/.test(sourceLine);
    const appendNextLine = () => {
        if (lines.length >= MAX_MACRO_DEFINITION_PREVIEW_LINES || currentLine + 1 >= document.lineOffsets.length) return false;
        currentLine++;
        const nextLineStart = document.lineOffsets[currentLine];
        const nextLineEnd = document.lineOffsets[currentLine + 1] ?? document.text.length;
        const nextLine = document.text.slice(nextLineStart, nextLineEnd).replace(/[\r\n]+$/, "");
        if (length + nextLine.length + 1 > MAX_MACRO_DEFINITION_PREVIEW_LENGTH) return false;
        lines.push(nextLine);
        length += nextLine.length + 1;
        return true;
    };

    if (directive[1].toLowerCase() === "define") {
        while (hasContinuation(lines.at(-1))) {
            if (!appendNextLine()) {
                lines.push("...");
                break;
            }
        }
    } else {
        let nesting = 1;
        while (nesting > 0) {
            if (!appendNextLine()) {
                lines.push("...");
                break;
            }
            if (/^\s*#\s*macro\b/i.test(lines.at(-1))) nesting++;
            else if (/^\s*#\s*endmacro\b/i.test(lines.at(-1))) nesting--;
        }
    }

    const preview = lines.join("\n");
    return preview.length > MAX_MACRO_DEFINITION_PREVIEW_LENGTH
        ? `${preview.slice(0, MAX_MACRO_DEFINITION_PREVIEW_LENGTH - 1)}…`
        : preview;
}

function installPreprocessorModel(model, analysis) {
    const graph = analysis.preprocessorGraph || { declarations: [], references: [], parameters: [], contexts: [] };
    const semanticFacts = analysis.semanticPreprocessorFacts || null;
    const projectMap = createMacroProjector(analysis.macroGraph || { nodes: [] });
    const documents = new Map();
    for (const document of model.sources.values()) {
        const marker = document.text.startsWith("\uFEFF") ? 1 : 0;
        let offset = marker, byte = 0;
        const tokens = new Map();
        const tokensByRange = new Map();
        for (const token of document.tokens) {
            byte += Buffer.byteLength(document.text.slice(offset, token.offset));
            tokens.set(byte, token);
            const rangeKey = `${token.line}:${token.startColumn}:${token.endColumn}:${token.name.toLowerCase()}`;
            const matches = tokensByRange.get(rangeKey) || [];
            matches.push(token);
            tokensByRange.set(rangeKey, matches);
            offset = token.offset;
        }
        documents.set(document.uri.fsPath, { document, tokens, tokensByRange });
    }
    function project(sourceMap, name) {
        const physical = projectMap(sourceMap);
        if (!physical) return null;
        const source = documents.get(physical.filePath);
        if (!source) throw new Error("Compiler preprocessor source snapshot is missing.");
        const token = source.tokens.get(physical.sourceStart);
        if (!token || token.kind !== "identifier" || token.name.toLowerCase() !== name.toLowerCase() || Buffer.byteLength(token.name) !== physical.sourceEnd - physical.sourceStart) return null;
        return { uri: source.document.uri, occurrence: token, document: source.document, sourceMap };
    }
    function projectContext(sourceMap) {
        const physical = projectMap(sourceMap);
        if (!physical) return null;
        const source = documents.get(physical.filePath);
        const occurrence = source?.tokens.get(physical.sourceStart);
        if (!occurrence) return null;
        return { document: source.document, occurrence };
    }
    function directRange(filePath, name, startLine, startColumn, endLine, endColumn) {
        const source = documents.get(filePath);
        if (!source || startLine !== endLine) return null;
        const matches = source.tokensByRange.get(`${startLine - 1}:${startColumn}:${endColumn}:${name.toLowerCase()}`) || [];
        if (matches.length !== 1 || matches[0].kind !== "identifier") return null;
        return { uri: source.document.uri, occurrence: matches[0], document: source.document, sourceMap: 0 };
    }
    const entries = [], bindings = [], families = new Map(), byPhysical = new Map(), sourceEpochs = new Map();
    const macroEntriesByDeclarationId = new Map();
    const macroInvocationEpochsByPhysical = new Map();
    const parameterDeclarations = new Map();
    for (const parameter of graph.parameters) {
        if (parameter.kind !== "declaration") continue;
        const parameters = parameterDeclarations.get(parameter.declaration) || [];
        parameters.push(parameter);
        parameterDeclarations.set(parameter.declaration, parameters);
    }
    const canonical = (id) => model.canonicalSymbolIds.get(id) || id;

    /* Replacement-list identifiers are parsed at definition time, but their
       macro lookup happens only when that definition is expanded. A deferred
       record therefore cannot name a target by itself. Match it against every
       invocation record that projects to the same physical token, and retain
       a target only when all observed expansions selected one DEFINE symbol.

       This deliberately does not use spelling or the active final macro
       environment as a fallback. A conditional expansion or redefinition can
       legitimately give the same replacement token different meanings. */
    const deferredCandidates = new Map();
    for (const record of graph.references) {
        if (record.role !== "invoke") continue;
        const symbol = model.nativeSymbols.get(record.symbol);
        if (!symbol || symbol.symbolClass !== 5 || symbol.name.toLowerCase() !== record.name.toLowerCase()) continue;
        const physical = project(record.sourceMap, record.name);
        if (!physical) continue;
        const key = `${physical.uri}:${physical.occurrence.offset}`;
        const candidates = deferredCandidates.get(key) || new Set();
        candidates.add(record.symbol);
        deferredCandidates.set(key, candidates);
    }
    const deferredTarget = (record) => {
        if (record.role !== "deferred") return 0;
        const physical = project(record.sourceMap, record.name);
        const candidates = physical && deferredCandidates.get(`${physical.uri}:${physical.occurrence.offset}`);
        return candidates?.size === 1 ? [...candidates][0] : 0;
    };
    function bindPhysical(identity, name, sourceMap, kind, record, physical) {
        const binding = { id: identity, name, kind, sourceMap, physical, record };
        bindings.push(binding);
        if (physical) {
            const key = `${physical.uri}:${physical.occurrence.offset}`;
            const ids = byPhysical.get(key) || new Set();
            ids.add(identity);
            byPhysical.set(key, ids);
            if (record.role === "invoke" && identity.startsWith("macro:") && Number.isSafeInteger(record.epoch)) {
                const epochs = macroInvocationEpochsByPhysical.get(key) || new Set();
                epochs.add(record.epoch);
                macroInvocationEpochsByPhysical.set(key, epochs);
            }
            const epoch = record.epoch ?? graph.declarations[record.declaration - 1]?.epoch;
            if (epoch !== undefined) {
                const epochs = sourceEpochs.get(key) || new Set();
                epochs.add(epoch);
                sourceEpochs.set(key, epochs);
            }
        }
        return physical;
    }
    function bind(identity, name, sourceMap, kind, record) {
        return bindPhysical(identity, name, sourceMap, kind, record, project(sourceMap, name));
    }
    function declare(identity, name, sourceMap, type, symbol, record, parameters = []) {
        const physical = bind(identity, name, sourceMap, "declaration", record);
        if (!physical) return;
        name = physical.occurrence.name;
        const key = name.toLowerCase();
        const declaration = { name, type, line: physical.occurrence.line, startColumn: physical.occurrence.startColumn, endColumn: physical.occurrence.endColumn, modifiers: [], parameters, detail: type === "macro" ? "Compiler macro" : "Compiler macro parameter", signature: type === "macro" ? `${name}${parameters.length || record.argless ? `(${parameters.map((parameter) => parameter.label).join(", ")})` : ""}` : name };
        if (type === "macro") declaration.compilerMacroDefinition = macroDefinitionPreview(physical.document, physical.occurrence);
        const entry = { id: `compiler-preprocessor:${analysis.dependencies[0]}:${identity}`, compilerPreprocessorId: identity, nativeSymbol: symbol, name, key, qualifiedName: name, declaration, uri: physical.uri, document: physical.document, offset: physical.occurrence.offset, scope: { kind: type === "macro" ? "module" : "macro" }, preprocessorRecord: record };
        if (type === "macro") macroEntriesByDeclarationId.set(record.id, entry);
        entries.push(entry);
        const family = families.get(identity) || [];
        family.push(entry);
        families.set(identity, family);
        physical.document.entriesByOffset.set(entry.offset, entry);
    }
    for (const record of graph.declarations) {
        const symbol = model.nativeSymbols.get(record.symbol);
        const parameters = (parameterDeclarations.get(record.id) || []).sort((a, b) => a.ordinal - b.ordinal).map((parameter) => {
            const name = project(parameter.sourceMap, parameter.name)?.occurrence.name || parameter.name;
            return { name, label: name + (record.flags & 4 && parameter.ordinal === record.parameterCount - 1 ? "..." : "") };
        });
        declare(`macro:${record.symbol}`, symbol.name, record.sourceMap, "macro", symbol, record, parameters);
    }
    for (const record of graph.parameters) {
        const identity = `parameter:${record.declaration}:${record.ordinal}`;
        if (record.kind === "declaration") declare(identity, record.name, record.sourceMap, "parameter", null, record);
        else bind(identity, record.name, record.sourceMap, "reference", record);
    }
    for (const record of graph.references) {
        const target = deferredTarget(record) || record.symbol;
        const symbol = model.nativeSymbols.get(target);
        const identity = symbol?.symbolClass === 5 ? `macro:${target}` : target ? canonical(target) : `undefined:${record.name.toLowerCase()}`;
        bind(identity, record.name, record.sourceMap, "reference", record);
    }

    const deferredReferencesByPhysical = new Map();
    for (const binding of bindings) {
        if (binding.record.role !== "deferred" || !binding.physical) continue;
        const key = `${binding.physical.uri}:${binding.physical.occurrence.offset}`;
        const records = deferredReferencesByPhysical.get(key) || [];
        records.push(binding);
        deferredReferencesByPhysical.set(key, records);
    }
    function deferredReferenceAt(document, token) {
        if (!document || !token) return null;
        const key = `${document.uri}:${token.offset}`;
        const records = deferredReferencesByPhysical.get(key) || [];
        const identities = new Set(records.map((binding) => binding.id));
        const physicalIdentities = byPhysical.get(key);
        if (!identities.size) return null;
        const observedTargets = deferredCandidates.get(key)?.size || 0;
        if (observedTargets === 1) return null;
        if (observedTargets === 0 && ([...identities].some((identity) => !String(identity).startsWith("undefined:")) ||
            !physicalIdentities || [...physicalIdentities].some((identity) => !String(identity).startsWith("undefined:")))) return null;
        return {
            name: token.name,
            outcome: observedTargets > 1 ? "ambiguous" : "unexpanded"
        };
    }

    /* Schema 21 preserves the compiler's result for DEFINED() and conditional
       defined-name probes. Use it only when the entire physical token is one
       exact macro declaration already present in the bridge inventory. A
       qualified or generated spelling stays with the bridge's richer map. */
    if (semanticFacts?.definedNameProbes?.length && analysis.semanticBindings?.length) {
        const macroDeclarationsByPhysical = new Map();
        for (const entry of entries) {
            if (entry.declaration.type !== "macro" || !entry.compilerPreprocessorId) continue;
            const key = `${entry.uri}:${entry.offset}`;
            const candidates = macroDeclarationsByPhysical.get(key) || [];
            candidates.push(entry);
            macroDeclarationsByPhysical.set(key, candidates);
        }
        const sidecarToNativeMacro = new Map();
        for (const sidecarBinding of analysis.semanticBindings) {
            if (sidecarBinding.role !== "declaration" || !sidecarBinding.name) continue;
            const physical = directRange(sidecarBinding.filePath, sidecarBinding.name,
                sidecarBinding.startLine, sidecarBinding.startColumn,
                sidecarBinding.endLine, sidecarBinding.endColumn);
            if (!physical) continue;
            const candidates = macroDeclarationsByPhysical.get(`${physical.uri}:${physical.occurrence.offset}`) || [];
            const matching = candidates.filter((entry) => entry.name.toLowerCase() === sidecarBinding.name.toLowerCase());
            if (matching.length === 1) sidecarToNativeMacro.set(sidecarBinding.symbol, matching[0].compilerPreprocessorId);
        }
        for (const probe of semanticFacts.definedNameProbes) {
            if (!probe.physical || !probe.defined || !probe.symbol) continue;
            const identity = sidecarToNativeMacro.get(probe.symbol);
            if (!identity) continue;
            const physical = directRange(probe.filePath, probe.spelling, probe.startLine,
                probe.startColumn, probe.endLine, probe.endColumn);
            if (!physical || byPhysical.get(`${physical.uri}:${physical.occurrence.offset}`)?.has(identity)) continue;
            bindPhysical(identity, probe.spelling, 0, "reference", {
                role: "query", symbol: identity.slice("macro:".length), sourceMap: 0,
                sidecarProbeId: probe.id
            }, physical);
        }
    }
    function resolve(document, token) {
        const key = `${document.uri}:${token.offset}`;
        const identities = byPhysical.get(key);
        if (!identities) return null;
        const result = new Map();
        for (const identity of identities) {
            const family = families.get(identity) || model.nativeFamilies.get(identity) || [];
            if (!family.length) return [];
            let entry = family.find((candidate) => candidate.uri.toString() === document.uri.toString() && candidate.offset === token.offset) || family[0];
            const invocationEpochs = macroInvocationEpochsByPhysical.get(key);
            if (typeof identity === "string" && identity.startsWith("macro:") && invocationEpochs?.size) {
                const selectedDefinitions = [...invocationEpochs].map((epoch) => activeEntries(epoch)
                    .find((candidate) => candidate.compilerPreprocessorId === identity));
                if (selectedDefinitions.some((candidate) => !candidate) ||
                    new Set(selectedDefinitions.map((candidate) => candidate.preprocessorRecord.id)).size !== 1) return [];
                entry = selectedDefinitions[0];
            }
            result.set(entry.id, entry);
        }
        return [...result.values()];
    }
    const events = [...graph.declarations.map((record) => ({ record, declaration: true })), ...graph.references.filter((record) => record.role === "undef" && model.nativeSymbols.get(record.symbol)?.symbolClass === 5).map((record) => ({ record, declaration: false }))].sort((a, b) => a.record.epoch - b.record.epoch);
    const environmentEvents = new Map();
    for (const event of events) {
        const symbol = model.nativeSymbols.get(event.record.symbol);
        const physical = symbol && project(event.record.sourceMap, symbol.name);
        if (!physical) continue;
        const list = environmentEvents.get(physical.document.uri.toString()) || [];
        list.push({ offset: physical.occurrence.offset, epoch: event.record.epoch });
        environmentEvents.set(physical.document.uri.toString(), list);
    }
    for (const list of environmentEvents.values()) list.sort((left, right) => left.offset - right.offset || left.epoch - right.epoch);
    const directiveContexts = new Map();
    const conditionalKeywords = new Set(["if", "ifdef", "ifndef", "elseif", "elseifdef", "elseifndef"]);
    for (const record of graph.contexts || []) {
        const physical = projectContext(record.sourceMap);
        /* The lexer maps a preprocessor token to its keyword, not the leading
           number sign. Restrict the record to conditional keywords so a future
           bridge hook cannot turn an unrelated directive into macro scope. */
        if (!physical || !conditionalKeywords.has(physical.occurrence.name.toLowerCase())) continue;
        const list = directiveContexts.get(physical.document.uri.toString()) || [];
        list.push({ line: physical.occurrence.line, offset: physical.occurrence.offset, epoch: record.epoch });
        directiveContexts.set(physical.document.uri.toString(), list);
    }
    for (const list of directiveContexts.values()) list.sort((left, right) => left.offset - right.offset);
    const activeCache = new Map();
    function activeEntries(epoch) {
        if (epoch === undefined) return [];
        if (activeCache.has(epoch)) return activeCache.get(epoch);
        const active = new Map();
        for (const event of events) {
            if (event.record.epoch > epoch) break;
            const symbol = model.nativeSymbols.get(event.record.symbol);
            const key = symbol.name.toLowerCase();
            if (event.declaration) active.set(key, event.record.id);
            else active.delete(key);
        }
        const entries = [...active.values()].map((id) => macroEntriesByDeclarationId.get(id)).filter(Boolean);
        // Duplicated arguments usually share an epoch. Retain eight recent
        // environment views, not a full active-name table for every directive.
        if (activeCache.size >= 8) activeCache.delete(activeCache.keys().next().value);
        activeCache.set(epoch, entries);
        return entries;
    }
    const epochsAt = (document, token) => [...(sourceEpochs.get(`${document.uri}:${token.offset}`) || [])];
    function epochsAtPosition(document, line, character) {
        const lineStart = document.lineOffsets?.[line];
        if (lineStart === undefined || character < 0) return [];
        const offset = lineStart + character;
        const contexts = directiveContexts.get(document.uri.toString()) || [];
        let selectedOffset = -1;
        const selectedEpochs = new Set();
        for (let index = contexts.length - 1; index >= 0; index--) {
            const candidate = contexts[index];
            if (candidate.line < line) break;
            if (candidate.line > line || candidate.offset > offset) continue;
            if (selectedOffset < 0) selectedOffset = candidate.offset;
            if (candidate.offset < selectedOffset) break;
            if (!Number.isSafeInteger(candidate.epoch) || candidate.epoch < 0) return [];
            selectedEpochs.add(candidate.epoch);
            if (selectedEpochs.size > MAX_PREPROCESSOR_COMPLETION_CONTEXTS) return [];
        }
        if (selectedOffset >= 0) return [...selectedEpochs];
        const events = environmentEvents.get(document.uri.toString()) || [];
        let next = 0;
        while (next < events.length && events[next].offset <= offset) next++;
        const nextEvent = events[next]?.offset ?? Number.POSITIVE_INFINITY;
        /*
            Directives do not survive preprocessing, so an unfinished
            `#if defined(` has no projected token at the cursor. The next
            compiler-observed source token is an authoritative environment
            witness only until another local DEFINE or UNDEF changes it.
            Prefer that witness to an earlier one because an include can add
            macros between two root-file tokens. If no witness exists, a local
            DEFINE/UNDEF event is still sufficient for local macro names.
        */
        for (const token of document.tokens) {
            if (token.offset < offset || token.offset >= nextEvent) continue;
            const epochs = sourceEpochs.get(`${document.uri}:${token.offset}`);
            if (epochs?.size) return [...epochs];
        }
        const previousEvent = events[next - 1];
        for (let index = document.tokens.length - 1; index >= 0; index--) {
            const token = document.tokens[index];
            if (token.offset > offset) continue;
            if (previousEvent && token.offset < previousEvent.offset) break;
            const epochs = sourceEpochs.get(`${document.uri}:${token.offset}`);
            if (epochs?.size) return [...epochs];
        }
        return previousEvent ? [previousEvent.epoch] : [];
    }
    for (const family of families.values()) {
        const macroEntries = family.filter((entry) => entry.declaration.type === "macro");
        if (!macroEntries.length) continue;
        const uniqueDefinition = macroEntries.length === 1;
        for (const entry of macroEntries) entry.compilerMacroUniqueDefinition = uniqueDefinition;
    }
    return {
        entries, bindings, families, resolve, deferredReferenceAt, activeEntries, epochsAt, epochsAtPosition,
        conditionalFacts: semanticFacts
    };
}

module.exports = { installPreprocessorModel, macroDefinitionPreview };

/* end of compiler-preprocessor-model.js */
