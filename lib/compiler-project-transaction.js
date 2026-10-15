/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-project-transaction.js
    Purpose: Collect native project locations and validate project renames.
    Responsibilities: freeze sources, map sidecar bindings, and verify results.
    Does not contain: VS Code objects, source writes, or inferred project contexts.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { serialize, deserialize } = require("v8");
const { createHash } = require("crypto");
const { CompilerSemanticModel } = require("./compiler-semantic-model");
const { CompilerUri } = require("./compiler-model-store");
const { MAX_ANALYSIS_BYTES, decodeCompilerSourceBuffer } = require("./compiler-analysis");
const { collectProjectEdits, collectProjectReferences, declarationKey, physicalPath, isNumericLabelName } = require("./compiler-project-bindings");
const { expressionGraphSignature } = require("./compiler-expressions");
const { scopeGraphSignature } = require("./compiler-scopes");
const { tokenOriginSignature } = require("./compiler-origins");
const { preprocessorGraphSignature } = require("./compiler-preprocessor");
const { createMacroPartProjector } = require("./compiler-macros");
const { normalizeIdentifier } = require("./freebasic-parser");

// Native baselines are private scratch data, not a persistent project cache.
// Bound disk usage separately from source bytes and the worker heap allowance.
const MAX_PROJECT_SPOOL_BYTES = 512 * 1024 * 1024;

// FB_SYMBCLASS_LABEL is zero-based class 7 in the compiler's symb.bi.
const FB_SYMBCLASS_LABEL = 7;
const FB_SYMBCLASS_VAR = 1;
const FB_SYMBCLASS_PARAM = 4;
const FB_SYMBCLASS_STRUCT = 10;
const FB_SYMBCLASS_FIELD = 12;

/* FB_SYMBCLASS_SCOPE from the compiler's symb.bi. The structural numeric-label
   rewrite may introduce one anonymous scope for each rewritten ELSE branch. */
const FB_SYMBCLASS_SCOPE = 15;

function validateRenameName(oldName, newName) {
    const numericLabel = isNumericLabelName(oldName);
    if (typeof newName !== "string" || newName.length > 128) throw new Error("Use a FreeBASIC identifier of at most 128 characters.");
    if (numericLabel) {
        if (isNumericLabelName(newName)) return;
        /* A named label uses an identifier and a declaration-only colon. The
           transaction assigns that colon to the compiler-confirmed declaration
           occurrence while all GOTO references receive only the new name. */
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) throw new Error("Numeric label rename requires a numeric literal or a FreeBASIC label name.");
        return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*[$%!#&]?$/.test(newName)) throw new Error("Use a FreeBASIC identifier of at most 128 characters.");
    if (typeof oldName !== "string" || (oldName.match(/[$%!#&]$/)?.[0] || "") !== (newName.match(/[$%!#&]$/)?.[0] || "")) throw new Error("Rename must preserve the identifier's type suffix.");
}

function stamp(file) {
    const value = fs.statSync(file);
    return [value.size, value.mtimeMs, value.ctimeMs, value.dev, value.ino];
}

function readSource(file, checkCancelled) {
    checkCancelled();
    const before = stamp(file);
    if (before[0] > MAX_ANALYSIS_BYTES) throw new Error("Project source exceeds 32 MiB.");
    const text = decodeCompilerSourceBuffer(fs.readFileSync(file), file);
    if (JSON.stringify(before) !== JSON.stringify(stamp(file))) throw new Error(`Project source changed while being captured: ${file}`);
    return text;
}

function projectSourceKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/* Sidecar IDs are invocation-local. Cross them into the editor bridge only at
   compiler-confirmed declaration spans, never by matching names alone. */
function semanticProjectBindingMaps(analysis, model) {
    const rangeKey = (filePath, line, startColumn, endColumn) =>
        `${projectSourceKey(filePath)}:${line}:${startColumn}:${endColumn}`;
    const declarationIds = new Map();
    const bindingIds = new Map();
    const represented = new Set();
    for (const binding of model.nativeBindings) {
        const mapped = model.expandedToSource.get(binding.token.offset);
        if (!mapped || mapped.uri.scheme !== "file") continue;
        const occurrence = mapped.occurrence;
        const key = rangeKey(mapped.uri.fsPath, occurrence.line + 1, occurrence.startColumn, occurrence.endColumn);
        const boundIds = bindingIds.get(key) || new Set();
        boundIds.add(binding.id);
        bindingIds.set(key, boundIds);
        if (binding.kind === "declaration") {
            const ids = declarationIds.get(key) || new Set();
            ids.add(binding.id);
            declarationIds.set(key, ids);
        }
        represented.add(`${key}:${binding.id}:${binding.kind}`);
    }

    const sidecarToBridge = new Map();
    const ambiguousSidecarIds = new Set();
    for (const binding of analysis.semanticBindings || []) {
        if (binding.role !== "declaration") continue;
        const ids = declarationIds.get(rangeKey(binding.filePath, binding.startLine, binding.startColumn, binding.endColumn));
        if (ids?.size !== 1) continue;
        const bridgeId = [...ids][0];
        const previous = sidecarToBridge.get(binding.symbol);
        if (previous !== undefined && previous !== bridgeId) ambiguousSidecarIds.add(binding.symbol);
        else sidecarToBridge.set(binding.symbol, bridgeId);
    }
    return { rangeKey, declarationIds, bindingIds, represented, sidecarToBridge, ambiguousSidecarIds };
}

/* Direct sidecar bindings can supplement the project bridge's occurrences,
   but only when they resolve to a real source token with the same spelling. */
function semanticProjectBindings(analysis, model, includeRepresented = false, identityMap = null) {
    if (!Array.isArray(analysis.semanticBindings) || !analysis.semanticBindings.length) return [];
    const symbolClasses = new Map((analysis.symbolGraph?.symbols || []).map((symbol) => [symbol.id, symbol.symbolClass]));
    const { rangeKey, represented, sidecarToBridge, ambiguousSidecarIds } = identityMap || semanticProjectBindingMaps(analysis, model);

    const sourceByPath = new Map([...model.sources.values()].map((document) => [projectSourceKey(document.uri.fsPath), document]));
    const sourceByteOffsets = new Map();
    const sourceByteOffsetMap = (document) => {
        let offsets = sourceByteOffsets.get(document.uri.fsPath);
        if (offsets) return offsets;
        const markerLength = document.text.startsWith("\uFEFF") ? 1 : 0;
        const wanted = new Set();
        for (const token of document.tokens) {
            wanted.add(token.offset);
            wanted.add(token.end);
        }
        offsets = new Map();
        let textOffset = markerLength, byteOffset = 0;
        if (wanted.has(textOffset)) offsets.set(textOffset, byteOffset);
        while (textOffset < document.text.length) {
            const codepoint = document.text.codePointAt(textOffset);
            const character = String.fromCodePoint(codepoint);
            textOffset += character.length;
            byteOffset += Buffer.byteLength(character, "utf8");
            if (wanted.has(textOffset)) offsets.set(textOffset, byteOffset);
        }
        sourceByteOffsets.set(document.uri.fsPath, offsets);
        return offsets;
    };
    const bindingsByLine = new Map();
    for (const binding of analysis.semanticBindings) {
        const key = `${projectSourceKey(binding.filePath)}:${binding.startLine}`;
        const entries = bindingsByLine.get(key) || [];
        entries.push(binding);
        bindingsByLine.set(key, entries);
    }
    const ordinalByBinding = new Map();
    for (const entries of bindingsByLine.values()) {
        entries.sort((first, second) => first.startColumn - second.startColumn ||
            first.endColumn - second.endColumn || first.symbol - second.symbol || first.role.localeCompare(second.role));
        entries.forEach((binding, ordinal) => ordinalByBinding.set(binding, ordinal));
    }
    const result = [];
    for (const binding of analysis.semanticBindings) {
        if (!binding.physical) continue;
        if (ambiguousSidecarIds.has(binding.symbol)) continue;
        const id = sidecarToBridge.get(binding.symbol);
        if (!id) continue;
        const key = rangeKey(binding.filePath, binding.startLine, binding.startColumn, binding.endColumn);
        const isRepresented = represented.has(`${key}:${id}:${binding.role}`);
        if (isRepresented && !includeRepresented) continue;
        if (binding.startLine !== binding.endLine) continue;
        const document = sourceByPath.get(projectSourceKey(binding.filePath));
        const lineTokens = document?.byLine.get(binding.startLine - 1) || [];
        const occurrence = lineTokens.find((token) =>
            token.startColumn === binding.startColumn && token.endColumn === binding.endColumn);
        const bindingName = normalizeIdentifier(binding.name.split(".").at(-1));
        const matchingIdentifier = occurrence?.kind === "identifier" && bindingName === normalizeIdentifier(occurrence.name);
        const matchingNumericLabel = symbolClasses.get(id) === FB_SYMBCLASS_LABEL &&
            occurrence?.kind === "number" && bindingName === normalizeIdentifier(occurrence.name);
        if (!occurrence || (!matchingIdentifier && !matchingNumericLabel)) continue;
        const byteOffsets = sourceByteOffsetMap(document);
        const sourceStart = byteOffsets.get(occurrence.offset);
        const sourceEnd = byteOffsets.get(occurrence.end);
        if (sourceStart === undefined || sourceEnd === undefined || sourceEnd <= sourceStart) continue;
        result.push({
            id,
            kind: binding.role,
            name: occurrence.name,
            filePath: document.uri.fsPath,
            line: binding.startLine,
            ordinal: ordinalByBinding.get(binding),
            represented: isRepresented,
            sourceStart,
            sourceEnd,
            physical: { uri: document.uri, occurrence }
        });
        represented.add(`${key}:${id}:${binding.role}`);
    }
    return result;
}

/* Implicit calls have no source callee and must never enter the edit list.
   Declaration-owned calls and NEW map through the UDT declaration or token;
   argument conversions and scope-exit cleanup map through exact declarations. */
function semanticProjectImplicitCalls(analysis, model, identityMap = null) {
    if (!Array.isArray(analysis.semanticImplicitCalls) || !analysis.semanticImplicitCalls.length) return [];
    const { rangeKey, declarationIds, bindingIds, sidecarToBridge, ambiguousSidecarIds } = identityMap || semanticProjectBindingMaps(analysis, model);
    const symbolClasses = new Map((analysis.symbolGraph?.symbols || []).map((symbol) => [symbol.id, symbol.symbolClass]));
    const byLine = new Map();
    for (const call of analysis.semanticImplicitCalls) {
        const temporaryDestructor = call.kind === "temporary-destructor";
        const scopeExitDestructor = call.kind === "scope-exit-destructor";
        const deleteDestructor = call.kind === "delete-destructor";
        const returnConstructor = call.kind === "return-constructor";
        if (!call.physical || !call.targetSignature ||
            (!temporaryDestructor && call.kind !== "argument-constructor" && !returnConstructor && call.startLine !== call.endLine)) continue;
        const sourceRange = rangeKey(call.filePath, call.startLine, call.startColumn, call.endColumn);
        const ownerId = sidecarToBridge.get(call.owner);
        const targetTypeId = sidecarToBridge.get(call.type);
        if (!ownerId || !targetTypeId || ambiguousSidecarIds.has(call.owner) || ambiguousSidecarIds.has(call.type)) continue;
        if (temporaryDestructor || deleteDestructor || returnConstructor) {
            /* These relationships have no editable callee token. Each must
               name the exact declared UDT that owns the compiler selection. */
            if (call.owner !== call.type || ownerId !== targetTypeId ||
                symbolClasses.get(ownerId) !== FB_SYMBCLASS_STRUCT) continue;
        } else if (call.kind === "argument-constructor") {
            /* This relationship belongs to the selected formal parameter, but
               its physical range is the actual argument that triggered the
               conversion. Both identities must come from exact declarations. */
            if (symbolClasses.get(ownerId) !== FB_SYMBCLASS_PARAM) continue;
        } else if (scopeExitDestructor) {
            /* A control-flow cleanup edge is anchored to EXIT/GOTO/RETURN,
               not the variable token. Join it only through the exact
               compiler-owned object declaration and its declared UDT. */
            if (![FB_SYMBCLASS_VAR, FB_SYMBCLASS_FIELD].includes(symbolClasses.get(ownerId)) ||
                symbolClasses.get(targetTypeId) !== FB_SYMBCLASS_STRUCT || ownerId === targetTypeId) continue;
        } else {
            const ownerIds = call.kind === "new-constructor"
                ? bindingIds.get(sourceRange)
                : declarationIds.get(sourceRange);
            if (ownerIds?.size !== 1 || !ownerIds.has(ownerId)) continue;
        }
        const key = `${projectSourceKey(call.filePath)}:${call.startLine}`;
        const entries = byLine.get(key) || [];
        entries.push({ call, ownerId, targetTypeId });
        byLine.set(key, entries);
    }
    const result = [];
    for (const entries of byLine.values()) {
        entries.sort((first, second) => first.call.startColumn - second.call.startColumn ||
            first.call.endLine - second.call.endLine || first.call.endColumn - second.call.endColumn ||
            first.ownerId - second.ownerId || first.targetTypeId - second.targetTypeId ||
            first.call.kind.localeCompare(second.call.kind) || first.call.targetSignature.localeCompare(second.call.targetSignature));
        entries.forEach(({ call, ownerId, targetTypeId }, ordinal) => result.push({
            ownerId,
            targetTypeId,
            kind: call.kind,
            targetSignature: call.targetSignature,
            filePath: call.filePath,
            line: call.startLine,
            ordinal
        }));
    }
    return result;
}

/* A macro-generated or otherwise nonphysical implicit call has no editable
   source site. Keep its selected relationship as a counted semantic fact so a
   project rename can validate it without pretending that it has an edit
   location. Virtual coordinates are intentionally excluded because expansion
   offsets can move when a physical macro argument is renamed. */
function semanticProjectUnanchoredImplicitCalls(analysis, model, identityMap = null) {
    if (!Array.isArray(analysis.semanticImplicitCalls) || !analysis.semanticImplicitCalls.length) return [];
    const { sidecarToBridge, ambiguousSidecarIds } = identityMap || semanticProjectBindingMaps(analysis, model);
    const grouped = new Map();
    for (const call of analysis.semanticImplicitCalls) {
        if (call.physical !== false || !call.targetSignature) continue;
        const bridgeIdentity = (sidecarId) => ambiguousSidecarIds.has(sidecarId)
            ? 0
            : sidecarToBridge.get(sidecarId) || 0;
        const ownerBridgeId = bridgeIdentity(call.owner);
        const typeBridgeId = bridgeIdentity(call.type);
        const targetBridgeId = bridgeIdentity(call.target);
        const filePath = projectSourceKey(call.filePath);
        const key = JSON.stringify([
            filePath,
            ownerBridgeId || `sidecar:${call.owner}`,
            typeBridgeId || `sidecar:${call.type}`,
            targetBridgeId || `sidecar:${call.target}`,
            call.kind,
            call.targetSignature
        ]);
        const prior = grouped.get(key);
        if (prior) {
            prior.count++;
        } else {
            grouped.set(key, {
                ownerBridgeId,
                ownerSidecarId: ownerBridgeId ? 0 : call.owner,
                typeBridgeId,
                typeSidecarId: typeBridgeId ? 0 : call.type,
                targetBridgeId,
                targetSidecarId: targetBridgeId ? 0 : call.target,
                kind: call.kind,
                targetSignature: call.targetSignature,
                filePath,
                count: 1
            });
        }
    }
    return [...grouped.values()].sort((first, second) =>
        JSON.stringify(first).localeCompare(JSON.stringify(second)));
}

/* Newer FBC builds also retain constructor choices before lowering can erase
   their source relationship. These counted facts have no editable range, but
   they keep type rename from silently changing an implicit or temporary
   constructor selection. */
function semanticProjectConstructionObservations(analysis, model, identityMap = null) {
    const capabilityFeatures = [
        ["construction-observation:", "construction-observation-count:", "implicit-construction-inputs"],
        ["temporary-construction:", "temporary-construction-count:", "temporary-construction-inputs"]
    ];
    const properties = analysis.semanticProperties || [];
    const capabilities = analysis.semanticCapabilities || [];
    if (!properties.some((property) => capabilityFeatures.some(([prefix, closure]) =>
        property.name.startsWith(prefix) || property.name.startsWith(closure))) &&
        !capabilities.some((capability) => capabilityFeatures.some(([, , feature]) => capability.feature === feature))) {
        return [];
    }

    const { sidecarToBridge, ambiguousSidecarIds } = identityMap || semanticProjectBindingMaps(analysis, model);
    const contexts = new Map((analysis.semanticSourceContexts || []).map((context) => [context.id, context]));
    const rootFiles = new Map((analysis.semanticSourceContexts || [])
        .filter((context) => context.kind === "module")
        .map((context) => [context.module, context.filePath]));
    const capabilityByModule = new Map();
    for (const capability of capabilities) {
        if (!capabilityFeatures.some(([, , feature]) => capability.feature === feature)) continue;
        const key = `${capability.module}:${capability.feature}`;
        if (capabilityByModule.has(key) || capability.provisional ||
            !["available", "unavailable"].includes(capability.coverage)) {
            throw new Error("Compiler construction observation coverage is provisional or duplicated.");
        }
        capabilityByModule.set(key, capability.coverage);
    }

    const observations = new Map();
    const closureCounts = new Map();
    const identity = (value, label, minimum = 0) => {
        if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
            throw new Error(`Invalid compiler ${label} identity.`);
        }
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`Invalid compiler ${label} identity.`);
        return result;
    };
    const mappedIdentity = (sidecarId) => {
        const bridgeId = ambiguousSidecarIds.has(sidecarId) ? 0 : sidecarToBridge.get(sidecarId) || 0;
        return bridgeId ? { bridgeId, sidecarId: 0 } : { bridgeId: 0, sidecarId };
    };

    for (const property of properties) {
        for (const [prefix, closurePrefix, feature] of capabilityFeatures) {
            if (property.name.startsWith(closurePrefix)) {
                const module = identity(property.name.slice(closurePrefix.length), "construction closure module", 1);
                const count = identity(property.value, "construction closure count");
                const key = `${module}:${feature}`;
                if (property.domain !== "symbol" || property.module !== module ||
                    capabilityByModule.get(key) !== "available" || closureCounts.has(key)) {
                    throw new Error("Compiler construction closure has no unique available module capability.");
                }
                closureCounts.set(key, count);
                continue;
            }
            if (!property.name.startsWith(prefix)) continue;
            const match = /^(?:construction-observation|temporary-construction):(\d+)$/.exec(property.name);
            const module = property.module;
            const key = `${module}:${feature}`;
            if (!match || property.domain !== "symbol" || capabilityByModule.get(key) !== "available" ||
                property.provisional) {
                throw new Error("Compiler construction observation lacks an available non-recovery capability.");
            }
            const ordinal = identity(match[1], "construction observation ordinal", 1);
            const fields = property.value.split("\t");
            const temporary = prefix === "temporary-construction:";
            const expectedFields = temporary ? 4 : 6;
            if (fields.length !== expectedFields) throw new Error("Invalid compiler construction observation payload.");
            const owner = identity(String(property.identity), "construction owner", 1);
            let target, ownerType, kind, statement, source, macro;
            if (temporary) {
                target = identity(fields[0], "temporary constructor target", 1);
                ownerType = owner;
                kind = "temporary-construction";
                statement = identity(fields[1], "temporary construction statement");
                source = identity(fields[2], "temporary construction source");
                macro = identity(fields[3], "temporary construction macro");
            } else {
                target = identity(fields[0], "constructor target", 1);
                ownerType = identity(fields[1], "constructor owner type", 1);
                kind = fields[2];
                statement = identity(fields[3], "construction statement");
                source = identity(fields[4], "construction source");
                macro = identity(fields[5], "construction macro");
                if (!["default-constructor", "initializer-constructor", "new-constructor", "argument-constructor", "return-constructor"].includes(kind)) {
                    throw new Error("Unknown compiler construction observation kind.");
                }
            }
            const context = source ? contexts.get(source) : null;
            if (source && (!context || context.module !== module || !context.filePath)) {
                throw new Error("Compiler construction observation has a foreign source context.");
            }
            const sourceFilePath = context?.filePath || rootFiles.get(module);
            const moduleFilePath = rootFiles.get(module);
            if (!sourceFilePath || !moduleFilePath) throw new Error("Compiler construction observation has no translation-unit owner.");
            const ownerIdentity = mappedIdentity(owner);
            const typeIdentity = mappedIdentity(ownerType);
            const targetIdentity = mappedIdentity(target);
            const fact = {
                family: temporary ? "temporary-construction" : "implicit-construction",
                module,
                moduleFilePath: projectSourceKey(moduleFilePath),
                sourceFilePath: projectSourceKey(sourceFilePath),
                sourceContext: source,
                statement,
                macroGenerated: macro !== 0,
                ownerBridgeId: ownerIdentity.bridgeId,
                ownerSidecarId: ownerIdentity.sidecarId,
                typeBridgeId: typeIdentity.bridgeId,
                typeSidecarId: typeIdentity.sidecarId,
                targetBridgeId: targetIdentity.bridgeId,
                targetSidecarId: targetIdentity.sidecarId,
                kind,
                count: 1
            };
            const group = JSON.stringify([
                fact.family, fact.module, fact.moduleFilePath, fact.sourceFilePath, fact.sourceContext,
                fact.statement, fact.macroGenerated,
                fact.ownerBridgeId || `sidecar:${fact.ownerSidecarId}`,
                fact.typeBridgeId || `sidecar:${fact.typeSidecarId}`,
                fact.targetBridgeId || `sidecar:${fact.targetSidecarId}`, fact.kind
            ]);
            const prior = observations.get(group);
            if (prior) prior.count++;
            else observations.set(group, fact);
            const ordinalKey = `${key}:${ordinal}`;
            if (observations.has(ordinalKey)) throw new Error("Repeated compiler construction observation ordinal.");
            observations.set(ordinalKey, true);
        }
    }

    for (const capability of capabilities) {
        const feature = capabilityFeatures.find(([, , candidate]) => candidate === capability.feature);
        if (!feature) continue;
        const [prefix, closurePrefix] = feature;
        const key = `${capability.module}:${capability.feature}`;
        const ordinals = [...observations.keys()]
            .filter((entry) => entry.startsWith(`${key}:`))
            .map((entry) => Number(entry.slice(key.length + 1)))
            .sort((first, second) => first - second);
        const closure = closureCounts.get(key);
        if (capability.coverage === "available") {
            if (closure === undefined || closure !== ordinals.length ||
                ordinals.some((ordinal, index) => ordinal !== index + 1)) {
                throw new Error(`Compiler ${prefix === "construction-observation:" ? "implicit" : "temporary"} construction observations are incomplete.`);
            }
        } else if (closure !== undefined || ordinals.length) {
            throw new Error(`Unavailable compiler ${closurePrefix} capability contains observations.`);
        }
    }

    return [...observations.values()].filter((fact) => typeof fact === "object")
        .sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
}

function projectUnit(analysis, model) {
    const declaration = (entry) => ({
        name: entry.name,
        type: entry.declaration.type || "",
        propertyRole: entry.declaration.propertyRole || "",
        qualifiedName: entry.declaration.qualifiedName || entry.name,
        compilerSymbolId: entry.compilerSymbolId,
        compilerPreprocessorId: entry.compilerPreprocessorId,
        uri: { scheme: entry.uri.scheme, fsPath: entry.uri.fsPath },
        declaration: { line: entry.declaration.line, endColumn: entry.declaration.endColumn }
    });
    /* Generated declarations have no editable declaration token. Index only
       their compiler-bound occurrences for macro provenance; ordinary project
       renames retain the same bounded memory profile as before. */
    const nativeBindings = model.nativeBindings;
    const rangeKey = (entry) => `${entry.token.line}:${entry.token.startColumn}:${entry.token.endColumn}`;
    const generatedCandidates = nativeBindings.filter((entry) => !model.expandedToSource.has(entry.token.offset));
    const neededOrigins = new Set(generatedCandidates.map(rangeKey));
    const generatedOrigins = new Map();
    for (const token of analysis.tokenOrigins || []) {
        const key = `${token.start.line}:${token.start.character}:${token.end.character}`;
        if (neededOrigins.has(key)) generatedOrigins.set(key, token);
    }
    const generatedSymbolDeclarations = new Set(generatedCandidates
        .filter((entry) => entry.kind === "declaration" && generatedOrigins.get(rangeKey(entry))?.kind === "generated")
        .map((entry) => entry.id));
    const generatedIds = new Set(generatedSymbolDeclarations);
    /* A generated reference can bind to an ordinary physical declaration,
       such as a token-pasted spelling that names a variable declared outside
       the macro. Keep its source components so a project rename can update
       the macro arguments when the inverse edit is unique. */
    const generatedTokenBindings = generatedCandidates.filter((entry) =>
        generatedOrigins.get(rangeKey(entry))?.kind === "generated");
    const generatedTokenByRange = new Map(generatedTokenBindings.map((entry) => [rangeKey(entry), entry]));
    const generatedPartsByRange = new Map();
    if (generatedTokenBindings.length) {
        const projectParts = createMacroPartProjector(analysis.macroGraph || { nodes: [] });
        const sourceOffsets = new Map();
        for (const entry of generatedTokenBindings) {
            const origin = generatedOrigins.get(rangeKey(entry));
            if (!origin?.sourceMap) continue;
            const parts = projectParts(origin.sourceMap);
            if (!parts) continue;
            generatedPartsByRange.set(rangeKey(entry), parts);
            for (const part of parts) {
                const offsets = sourceOffsets.get(part.filePath) || new Set();
                offsets.add(part.sourceStart);
                sourceOffsets.set(part.filePath, offsets);
            }
        }
        const sourceTokens = new Map();
        for (const document of model.sources.values()) {
            const requested = sourceOffsets.get(document.uri.fsPath);
            if (!requested?.size) continue;
            const tokens = new Map();
            let offset = document.text.startsWith("\uFEFF") ? 1 : 0, byte = 0;
            for (const token of document.tokens) {
                byte += Buffer.byteLength(document.text.slice(offset, token.offset));
                if (requested.has(byte)) tokens.set(byte, token);
                offset = token.offset;
            }
            sourceTokens.set(document.uri.fsPath, { document, tokens });
        }
        for (const [key, parts] of generatedPartsByRange) {
            const entry = generatedTokenByRange.get(key);
            const generated = Buffer.from(entry.name, "utf8");
            const physical = [];
            for (const part of parts) {
                const source = sourceTokens.get(part.filePath);
                const occurrence = source?.tokens.get(part.sourceStart);
                if (!source || !occurrence || occurrence.kind !== "identifier" ||
                    part.sourceEnd - part.sourceStart !== Buffer.byteLength(occurrence.name)) break;
                const spelling = generated.subarray(part.outputStart, part.outputEnd).toString("utf8");
                if (Buffer.byteLength(spelling) !== part.outputEnd - part.outputStart ||
                    occurrence.name.toLowerCase() !== spelling.toLowerCase()) break;
                physical.push({ role: part.role, outputStart: part.outputStart, outputEnd: part.outputEnd, uri: source.document.uri, occurrence });
            }
            generatedPartsByRange.set(key, physical.length === parts.length ? physical : null);
        }
    }
    const generatedParts = (entry) => entry?.token ? generatedPartsByRange.get(rangeKey(entry)) || null : null;
    const binding = (entry, physical) => ({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        physical: physical ? { uri: { scheme: physical.uri.scheme, fsPath: physical.uri.fsPath }, occurrence: physical.occurrence } : null,
        generatedParts: physical ? null : generatedParts(entry)
    });
    const generatedSymbolAnchors = [];
    for (const entry of nativeBindings) {
        if (entry.kind !== "reference" || !generatedSymbolDeclarations.has(entry.id)) continue;
        const physical = model.expandedToSource.get(entry.token.offset);
        if (!physical || physical.occurrence.kind !== "identifier" || physical.occurrence.name.toLowerCase() !== entry.name.toLowerCase()) continue;
        const declarationEntry = model.inner.entries.find((candidate) => candidate.compilerSymbolId === entry.id);
        if (!declarationEntry) continue;
        generatedSymbolAnchors.push({
            name: entry.name,
            type: declarationEntry.declaration.type || "",
            propertyRole: declarationEntry.declaration.propertyRole || "",
            qualifiedName: declarationEntry.declaration.qualifiedName || entry.name,
            compilerSymbolId: entry.id,
            compilerPreprocessorId: 0,
            uri: { scheme: physical.uri.scheme, fsPath: physical.uri.fsPath },
            declaration: { line: physical.occurrence.line, endColumn: physical.occurrence.endColumn }
        });
    }
    const identityMap = semanticProjectBindingMaps(analysis, model);
    const semanticBindings = semanticProjectBindings(analysis, model, true, identityMap);
    const semanticImplicitCalls = semanticProjectImplicitCalls(analysis, model, identityMap);
    const unanchoredSemanticImplicitCalls = semanticProjectUnanchoredImplicitCalls(analysis, model, identityMap);
    const semanticConstructionObservations = semanticProjectConstructionObservations(analysis, model, identityMap);
    const bindings = [
        ...model.nativeBindings.map((entry) => binding(entry, model.expandedToSource.get(entry.token.offset))),
        ...model.preprocessor.bindings.map((entry) => binding(entry, entry.physical))
    ];
    for (const entry of semanticBindings.filter((entry) => !entry.represented)) {
        const physical = entry.physical;
        bindings.push(binding({ ...entry, token: physical.occurrence }, physical));
    }
    return {
        declarations: [...model.inner.entries, ...model.preprocessor.entries].map(declaration).concat(generatedSymbolAnchors),
        symbols: analysis.symbolGraph.symbols.map(({ id, symbolClass, name }) => ({ id, symbolClass, name })),
        procedureIds: new Map(analysis.symbolGraph.symbols.map((symbol) => [symbol.id, symbol.procedureId])),
        dispatch: analysis.symbolGraph.dispatch,
        preprocessorReferences: analysis.preprocessorGraph?.references || [],
        nonRenameableProcedures: analysis.nonRenameable || [],
        nonRenameableSymbols: analysis.symbolGraph.nonRenameable,
        bindings,
        semanticBindingFacts: semanticBindings.map(({ id, kind, name, filePath, line, ordinal, sourceStart, sourceEnd }) => ({
            id, kind, name, filePath, line, ordinal, sourceStart, sourceEnd
        })),
        semanticImplicitCallFacts: semanticImplicitCalls,
        unanchoredSemanticImplicitCallFacts: unanchoredSemanticImplicitCalls,
        semanticConstructionObservationFacts: semanticConstructionObservations
    };
}

function sourceSemanticColumnOffset(document, line, column) {
    if (!Number.isSafeInteger(line) || line < 0 || line >= document.lineOffsets.length ||
        !Number.isSafeInteger(column) || column < 0) return null;
    const start = document.lineOffsets[line];
    const end = document.lineOffsets[line + 1] ?? document.text.length;
    const lineLength = document.text.slice(start, end).replace(/[\r\n]+$/, "").length;
    return column <= lineLength ? start + column : null;
}

/* Stock FBC has stable semantic binding IDs but no editor-bridge symbol graph.
   Project Find References can still join those IDs through physical B records;
   this read-only unit intentionally contains no rename-validation facts. */
function sidecarProjectReferenceUnit(analysis, model) {
    if (!Array.isArray(analysis.semanticBindings)) return null;
    const sources = new Map([...model.sources.values()].map((document) => [
        projectSourceKey(document.uri.fsPath), document
    ]));
    const declarations = [];
    const bindings = [];
    for (const binding of analysis.semanticBindings) {
        if (!Number.isSafeInteger(binding.symbol) || binding.symbol < 1 ||
            !["declaration", "reference"].includes(binding.role)) return null;
        let physical = null;
        if (binding.physical === true) {
            const document = sources.get(projectSourceKey(binding.filePath));
            if (!document || binding.startLine !== binding.endLine) return null;
            const start = sourceSemanticColumnOffset(document, binding.startLine - 1, binding.startColumn);
            const end = sourceSemanticColumnOffset(document, binding.endLine - 1, binding.endColumn);
            if (start === null || end === null || end <= start) return null;
            const finalName = normalizeIdentifier(String(binding.name || "").split(".").at(-1));
            const lineTokens = document.byLine.get(binding.startLine - 1) || [];
            const token = lineTokens.find((candidate) =>
                (candidate.kind === "identifier" || candidate.kind === "number") &&
                candidate.offset >= start && candidate.end === end &&
                (!finalName || normalizeIdentifier(candidate.name) === finalName));
            if (!token) return null;
            physical = {
                uri: { scheme: document.uri.scheme, fsPath: document.uri.fsPath },
                occurrence: token
            };
            if (binding.role === "declaration") {
                declarations.push({
                    name: token.name,
                    compilerSymbolId: binding.symbol,
                    compilerPreprocessorId: 0,
                    uri: physical.uri,
                    declaration: { line: token.line, endColumn: token.endColumn }
                });
            }
        }
        bindings.push({
            id: binding.symbol,
            kind: binding.role,
            name: binding.name,
            physical,
            generatedParts: null
        });
    }
    const unprojectableSymbols = new Set(analysis.semanticPreprocessorFacts?.unprojectableMacroSymbols || []);
    const unprojectableAnchors = declarations
        .filter((entry) => unprojectableSymbols.has(entry.compilerSymbolId))
        .map(declarationKey)
        .filter(Boolean);
    return { declarations, bindings, unprojectableAnchors };
}

/* Numeric labels accept either `10 statement` or `10: statement`. A rename
   to an identifier must insert the delimiter only for the first spelling.
   Resolve that choice from the compiler's physical token, never from a text
   search that could confuse a same-spelled GOTO reference with a declaration. */
function numericLabelColonInsertions(analysis, renamedIds, sources) {
    const result = new Set();
    const origins = new Map(analysis.tokenOrigins.map((token) => [`${token.serial}:${token.startByte}:${token.endByte}`, token]));
    for (const use of analysis.symbolGraph.uses) {
        if (use.kind !== "declaration" || !renamedIds.has(use.id)) continue;
        const end = use.byteColumn + Buffer.byteLength(use.name);
        const token = origins.get(`${use.outputLine}:${use.byteColumn}:${end}`);
        if (!token || token.kind !== "source") throw new Error("Numeric label declaration has no physical compiler token.");
        const source = sources.get(token.filePath);
        if (typeof source !== "string") throw new Error("Numeric label declaration source is unavailable.");
        const bytes = Buffer.from(source);
        if (token.sourceEnd > bytes.length) throw new Error("Numeric label declaration exceeds its captured source.");
        if (bytes[token.sourceEnd] !== 0x3a) result.add(`${use.outputLine}:${use.byteColumn}`);
    }
    return result;
}

function shiftedIdentity(identity, thresholds = []) {
    if (!identity) return identity;
    let result = identity;
    for (const threshold of thresholds) if (identity >= threshold) result++;
    return result;
}

/* `ELSE GOTO label` introduces an anonymous compiler scope while the older
   numeric ELSE branch does not. Locate the compiler's existing THEN scope at
   the exact physical branch token so validation can account for only the
   anonymous sibling the rewrite requires. Later compiler IDs shift once per
   inserted scope, but no declared relationship is permitted to change. */
function structuralElseScopePlan(analysis, edits, sources) {
    const branches = new Set();
    for (const [file, occurrences] of edits) {
        const text = sources.get(file);
        if (typeof text !== "string") throw new Error("Single-line IF label source is unavailable.");
        for (const occurrence of occurrences.values()) if (occurrence.singleLineIfLabel === "else") {
            const start = Buffer.byteLength(text.slice(0, occurrence.offset));
            const end = Buffer.byteLength(text.slice(0, occurrence.end));
            branches.add(`${file}\0${start}\0${end}`);
        }
    }
    if (!branches.size) return null;
    const symbolThresholds = new Set(), scopeThresholds = new Set();
    for (const token of analysis.tokenOrigins) {
        if (token.kind !== "source" || !branches.has(`${token.filePath}\0${token.sourceStart}\0${token.sourceEnd}`)) continue;
        const scope = analysis.scopeGraph.scopes.find((entry) => entry.endSerial === token.serial && entry.endByte === token.startByte - 1);
        const symbol = scope && analysis.symbolGraph.symbols.find((entry) => entry.id === scope.symbol);
        if (!scope || !symbol || symbol.symbolClass !== FB_SYMBCLASS_SCOPE || symbol.name) throw new Error("Compiler did not expose the single-line IF ELSE scope.");
        symbolThresholds.add(symbol.id + 1);
        scopeThresholds.add(scope.id + 1);
    }
    if (!symbolThresholds.size) throw new Error("Compiler did not project the single-line IF ELSE label.");
    const anonymousScopes = analysis.symbolGraph.symbols.filter((symbol) => symbol.symbolClass === FB_SYMBCLASS_SCOPE && !symbol.name).length;
    return {
        enabled: true,
        additions: symbolThresholds.size,
        expected: anonymousScopes + symbolThresholds.size,
        remap: true,
        symbolThresholds: [...symbolThresholds].sort((left, right) => left - right),
        scopeThresholds: [...scopeThresholds].sort((left, right) => left - right)
    };
}

/* Sidecar bindings can supply a compiler-resolved occurrence when the editor
   trace has no symbol use for that parser route. Map those physical source
   spans back to every expanded token occurrence so expression range validation
   accounts for the byte shift caused by the accepted rename. */
function semanticBindingExpressionUses(analysis, renamedIds, semanticBindingFacts) {
    if (!(renamedIds instanceof Set) || !renamedIds.size || !semanticBindingFacts?.length) return [];
    const changedSpans = new Map();
    for (const binding of semanticBindingFacts) {
        if (!renamedIds.has(binding.id) || !Number.isSafeInteger(binding.sourceStart) ||
            !Number.isSafeInteger(binding.sourceEnd) || binding.sourceEnd <= binding.sourceStart) continue;
        const key = `${projectSourceKey(binding.filePath)}\0${binding.sourceStart}\0${binding.sourceEnd}`;
        changedSpans.set(key, { name: binding.name, kind: binding.kind });
    }
    if (!changedSpans.size) return [];

    const result = [];
    const seen = new Set();
    for (const token of analysis.tokenOrigins || []) {
        if (token.kind !== "source") continue;
        const key = `${projectSourceKey(token.filePath)}\0${token.sourceStart}\0${token.sourceEnd}`;
        const changed = changedSpans.get(key);
        if (!changed) continue;
        const occurrence = `${token.serial}:${token.startByte}:${token.endByte}`;
        if (seen.has(occurrence)) continue;
        seen.add(occurrence);
        result.push({
            outputLine: token.serial,
            byteColumn: token.startByte,
            endByte: token.endByte,
            name: changed.name,
            kind: changed.kind
        });
    }
    return result;
}

function semanticPolicySignature(analysis) {
    const policies = (analysis.semanticSourceHeaderPolicies || []).map((fact) => [
        fact.module, fact.source, projectSourceKey(fact.filePath), fact.kind, fact.pragmaOnce,
        fact.libraryCount, fact.namespaceImportCount
    ]);
    const libraries = (analysis.semanticHeaderLibraries || []).map((fact) => [
        fact.module, projectSourceKey(fact.filePath), fact.source, fact.kind, fact.value, fact.conditionalBranch
    ]);
    const imports = (analysis.semanticNamespaceImportRecipients || []).map((fact) => [
        fact.module, projectSourceKey(fact.filePath), fact.source, fact.statement, fact.recipient
    ]);
    const declarations = (analysis.semanticNamespaceDeclarations || []).map((fact) => [
        fact.module, projectSourceKey(fact.filePath), fact.source, fact.construct, fact.statement,
        fact.owner, fact.namespace, fact.anonymous
    ]);
    for (const values of [policies, libraries, imports, declarations]) {
        values.sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
    }
    return { policies, libraries, imports, declarations };
}

function semanticSelectCaseSignature(analysis) {
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => capability.feature === "select-case-inputs" || capability.feature === "select-case-lowering-inputs")
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const properties = (analysis.semanticProperties || [])
        .filter((property) => property.name.startsWith("select-case-"))
        .map((property) => [property.module, property.domain, property.identity, property.name, property.value, Boolean(property.provisional)]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    properties.sort(byRepresentation);
    return { capabilities, properties };
}

function semanticAbiPolicySignature(analysis) {
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => capability.feature === "procedure-abi-policy-inputs")
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const inputs = (analysis.semanticAbiPolicyInputs || []).map((input) => [
        input.module, input.source, projectSourceKey(input.filePath), input.line, input.ordinal,
        input.tokenClass, input.physical, input.writtenConvention, input.managedString, input.provisional
    ]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    inputs.sort(byRepresentation);
    return { capabilities, inputs };
}

function semanticProcedureDeclarationSignature(analysis) {
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => capability.feature === "procedure-typing-inputs")
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const inputs = (analysis.semanticProcedureDeclarationInputs || []).map((input) => [
        input.module, input.source || "", input.filePath ? projectSourceKey(input.filePath) : "",
        input.line ?? null, input.startColumn ?? null, input.ordinal ?? null, input.tokenClass ?? null,
        input.physical ?? null, input.kind, input.role || "",
        input.procedureKind || "", input.resultForm || "", input.exported ?? null,
        input.visibility || "", input.writtenType || "", JSON.stringify(input.declarations || []), input.provisional
    ]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    inputs.sort(byRepresentation);
    return { capabilities, inputs };
}

function semanticAggregateAccessSignature(analysis) {
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => capability.feature === "aggregate-access-sections")
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const anchor = (statement) => [
        statement.module, statement.source, projectSourceKey(statement.filePath), statement.line,
        statement.startColumn, statement.ordinal, statement.tokenClass, statement.physical
    ];
    const inputs = (analysis.semanticAggregateAccessInputs || []).map((group) => [
        anchor(group.body), group.count,
        group.sections.map((section) => [anchor(section), section.ordinal, section.visibility])
    ]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    inputs.sort(byRepresentation);
    return { capabilities, inputs };
}

function semanticProcedureLinkageSignature(analysis, remapSymbol) {
    const features = new Set(["procedure-linkage", "procedure-callback-inputs"]);
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => features.has(capability.feature))
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const anchor = (input) => [
        input.module, input.source, projectSourceKey(input.filePath), input.line,
        input.startColumn, input.ordinal, input.tokenClass, input.physical
    ];
    const procedureInputs = (analysis.semanticProcedureLinkageInputs || []).map((input) => [
        ...anchor(input), remapSymbol(input.symbol), input.role, input.hasLibrary,
        input.hasAlias, input.callbackCount, input.provisional
    ]);
    const callbackInputs = (analysis.semanticCallbackConventionInputs || []).map((input) => [
        ...anchor(input), remapSymbol(input.symbol), input.explicit, input.provisional
    ]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    procedureInputs.sort(byRepresentation);
    callbackInputs.sort(byRepresentation);
    return { capabilities, procedureInputs, callbackInputs };
}

function semanticEnumDeclarationSignature(analysis, remapSymbol) {
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => capability.feature === "enum-declaration-inputs")
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const anchor = (input) => [
        input.module, input.source, projectSourceKey(input.filePath), input.line,
        input.startColumn, input.ordinal, input.tokenClass, input.physical
    ];
    const declarations = (analysis.semanticEnumDeclarationInputs || []).map((input) => [
        ...anchor(input), remapSymbol(input.symbol), input.count, input.provisional
    ]);
    const elements = (analysis.semanticEnumElementInputs || []).map((input) => [
        ...anchor(input), remapSymbol(input.symbol), remapSymbol(input.owner), input.ordinal,
        input.explicit, input.initializerType?.dtype ?? null,
        remapSymbol(input.initializerType?.subtype ?? 0), input.provisional
    ]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    declarations.sort(byRepresentation);
    elements.sort(byRepresentation);
    return { capabilities, declarations, elements };
}

function semanticDeclarationTypingSignature(analysis, remapSymbol) {
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => capability.feature === "declaration-typing-inputs")
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const groups = (analysis.semanticDeclarationTypingGroups || []).map((group) => {
        const statement = group.statement;
        const inputs = group.inputs.map((input) => [
            input.ordinal, remapSymbol(input.symbol), input.writtenType,
            input.initializerKind, input.source
        ]).sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
        return [
            group.module, group.statement.source, projectSourceKey(group.statement.filePath), group.statement.line,
            group.statement.startColumn, group.statement.ordinal, group.statement.tokenClass,
            group.statement.physical, remapSymbol(group.owner), group.kind, group.count,
            group.complete, group.provisional, inputs
        ];
    });
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    groups.sort(byRepresentation);
    return { capabilities, groups };
}

function semanticDeclarationRepetitionSignature(analysis, remapSymbol) {
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => capability.feature === "declaration-repetition-inputs")
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const inputs = (analysis.semanticDeclarationRepetitionInputs || []).map((input) => [
        input.module, input.source, projectSourceKey(input.filePath), input.line,
        input.startColumn, input.ordinal, input.tokenClass, input.physical,
        remapSymbol(input.symbol), input.kind, input.repeated, input.provisional
    ]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    inputs.sort(byRepresentation);
    return { capabilities, inputs };
}

function semanticScalarStringDeclarationSignature(analysis, remapSymbol) {
    const features = new Set(["scalar-string-declarations", "declaration-typing-inputs"]);
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => features.has(capability.feature))
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const declarations = (analysis.semanticScalarStringDeclarationInputs || []).map((input) => [
        input.module, input.source, projectSourceKey(input.filePath), input.line,
        input.startColumn, input.ordinal, input.tokenClass, input.physical,
        remapSymbol(input.symbol), input.kind, input.hasInitializer, input.provisional
    ]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    declarations.sort(byRepresentation);
    return { capabilities, declarations };
}

function semanticArrayStorageSignature(analysis, remapSymbol) {
    const capabilities = (analysis.semanticCapabilities || [])
        .filter((capability) => capability.feature === "array-storage-inputs")
        .map((capability) => [capability.module, capability.feature, capability.coverage, Boolean(capability.provisional)]);
    const anchor = (statement) => statement ? [
        statement.module, statement.source, projectSourceKey(statement.filePath), statement.line,
        statement.startColumn, statement.ordinal, statement.tokenClass, statement.physical
    ] : null;
    const inputs = (analysis.semanticArrayStorageInputs || []).map((input) => [
        input.module, input.source, projectSourceKey(input.filePath), anchor(input.statement), input.occurrence,
        remapSymbol(input.symbol), input.kind,
        input.receiver ? [remapSymbol(input.receiver.symbol), anchor(input.receiver.statement)] : null,
        input.provisional
    ]);
    const byRepresentation = (first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second));
    capabilities.sort(byRepresentation);
    inputs.sort(byRepresentation);
    return { capabilities, inputs };
}

function validationSignatures(analysis, renamedIds, newName, edits, sources, structuralNumericLabel, structuralScopePlan, checkCancelled, semanticBindingFacts = [], semanticImplicitCallFacts = [], unanchoredSemanticImplicitCallFacts = [], semanticConstructionObservationFacts = []) {
    const result = new Map();
    // Hash each canonical relationship family independently, then release its
    // temporary representation. Keeping both modules' full comparison graphs
    // simultaneously would defeat baseline spooling on macro-heavy sources.
    const add = (name, value) => {
        checkCancelled();
        const text = JSON.stringify(value);
        result.set(name, `${Buffer.byteLength(text)}:${createHash("sha256").update(text).digest("hex")}`);
    };
    add("project dependencies", [...analysis.dependencies].sort());
    const structuralScopeSymbols = structuralScopePlan?.enabled ? new Set(analysis.symbolGraph.symbols.filter((symbol) => symbol.symbolClass === FB_SYMBCLASS_SCOPE && !symbol.name).map((symbol) => symbol.id)) : null;
    if (structuralScopePlan && (structuralScopePlan.remap ? structuralScopeSymbols.size + structuralScopePlan.additions : structuralScopeSymbols.size) !== structuralScopePlan.expected) throw new Error("Compiler single-line IF scope shape changed during refactoring.");
    const remapSymbol = (identity) => structuralScopePlan?.remap ? shiftedIdentity(identity, structuralScopePlan.symbolThresholds) : identity;
    const visibleSymbols = analysis.symbolGraph.symbols.filter((symbol) => !structuralScopeSymbols?.has(symbol.id));
    add("compiler symbol bindings", analysis.symbolGraph.uses.map((binding) => [binding.kind, remapSymbol(binding.id), renamedIds?.has(binding.id) ? newName.toLowerCase() : binding.name.toLowerCase()]));
    const semanticBindings = semanticBindingFacts.map((binding) => [
        remapSymbol(binding.id), binding.kind, projectSourceKey(binding.filePath), binding.line,
        binding.ordinal, renamedIds?.has(binding.id) ? normalizeIdentifier(newName) : normalizeIdentifier(binding.name)
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    add("compiler semantic binding occurrences", semanticBindings);
    const semanticImplicitCalls = semanticImplicitCallFacts.map((call) => [
        remapSymbol(call.ownerId), remapSymbol(call.targetTypeId), call.kind, call.targetSignature,
        projectSourceKey(call.filePath), call.line, call.ordinal
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    add("compiler-selected implicit calls", semanticImplicitCalls);
    const remapCallIdentity = (bridgeId, sidecarId) => bridgeId
        ? remapSymbol(bridgeId)
        : `sidecar:${sidecarId}`;
    const unanchoredImplicitCalls = unanchoredSemanticImplicitCallFacts.map((call) => [
        remapCallIdentity(call.ownerBridgeId, call.ownerSidecarId),
        remapCallIdentity(call.typeBridgeId, call.typeSidecarId),
        remapCallIdentity(call.targetBridgeId, call.targetSidecarId),
        call.kind, call.targetSignature, projectSourceKey(call.filePath), call.count
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    add("unanchored compiler-selected implicit calls", unanchoredImplicitCalls);
    const constructionObservations = semanticConstructionObservationFacts.map((fact) => [
        fact.family, projectSourceKey(fact.moduleFilePath), projectSourceKey(fact.sourceFilePath),
        fact.sourceContext, fact.statement, fact.macroGenerated,
        remapCallIdentity(fact.ownerBridgeId, fact.ownerSidecarId),
        remapCallIdentity(fact.typeBridgeId, fact.typeSidecarId),
        remapCallIdentity(fact.targetBridgeId, fact.targetSidecarId), fact.kind, fact.count
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    add("compiler implicit and temporary construction observations", constructionObservations);
    add("compiler types", analysis.expressions.map((expression) => [expression.dtype, expression.subtype]));
    const symbolRelationships = visibleSymbols.map(({ id, symbolClass, dtype, subtype, owner, namespace, attributes, procedureAttributes, scopeDepth }) => [remapSymbol(id), symbolClass, dtype, remapSymbol(subtype), remapSymbol(owner), remapSymbol(namespace), attributes, procedureAttributes, scopeDepth]);
    if (structuralScopeSymbols) symbolRelationships.push(["single-line IF ELSE scopes", structuralScopePlan.expected]);
    add("symbol relationships", symbolRelationships);
    add("canonical symbol identities", [...analysis.symbolGraph.canonicalIds].filter(([id]) => !structuralScopeSymbols?.has(id)).map(([id, canonical]) => [remapSymbol(id), remapSymbol(canonical)]));
    add("virtual dispatch relationships", analysis.symbolGraph.dispatch);
    add("native expression relationships", expressionGraphSignature(analysis, renamedIds, newName,
        structuralNumericLabel, structuralScopePlan,
        semanticBindingExpressionUses(analysis, renamedIds, semanticBindingFacts)));
    add("native scopes, declarations, or type shapes", scopeGraphSignature(analysis, renamedIds, newName, structuralScopePlan && { ...structuralScopePlan, symbols: structuralScopeSymbols }));
    add("native preprocessor bindings or definition shapes", preprocessorGraphSignature(analysis, renamedIds, newName));
    add("physical token origins", tokenOriginSignature(analysis, edits, sources, renamedIds, newName, structuralNumericLabel, semanticBindingFacts));
    add("compiler source and namespace policy inputs", semanticPolicySignature(analysis));
    add("compiler SELECT CASE lowering inputs", semanticSelectCaseSignature(analysis));
    add("compiler procedure ABI policy inputs", semanticAbiPolicySignature(analysis));
    add("compiler procedure declaration typing inputs", semanticProcedureDeclarationSignature(analysis));
    add("compiler aggregate access sections", semanticAggregateAccessSignature(analysis));
    add("compiler procedure linkage and callback inputs", semanticProcedureLinkageSignature(analysis, remapSymbol));
    add("compiler enum declaration and member inputs", semanticEnumDeclarationSignature(analysis, remapSymbol));
    add("compiler declaration typing inputs", semanticDeclarationTypingSignature(analysis, remapSymbol));
    add("compiler declaration repetition inputs", semanticDeclarationRepetitionSignature(analysis, remapSymbol));
    add("compiler scalar String declaration inputs", semanticScalarStringDeclarationSignature(analysis, remapSymbol));
    add("compiler array storage inputs", semanticArrayStorageSignature(analysis, remapSymbol));
    return result;
}

function verifyProjectSources(verification, currentBuffers, checkCancelled) {
    if (fs.realpathSync(verification.root) !== verification.physicalRoot) throw new Error("The project workspace path changed during refactoring.");
    for (const [file, physical] of verification.targets) {
        checkCancelled();
        if (physicalPath(file) !== physical) throw new Error(`Project edit target changed during refactoring: ${file}`);
        const relative = path.relative(verification.physicalRoot, physical);
        if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Rename would edit a dependency outside the workspace.");
    }
    for (const [file, text] of verification.disk) {
        if (readSource(file, checkCancelled) !== text) throw new Error(`Project source changed during refactoring: ${file}`);
    }
    for (const [file, text] of verification.buffers) {
        checkCancelled();
        const current = currentBuffers.has(file) ? currentBuffers.get(file) : readSource(file, checkCancelled);
        if (current !== text) throw new Error("Editor buffers changed during refactoring.");
    }
    for (const [file, text] of currentBuffers) {
        checkCancelled();
        if (!verification.buffers.has(file) && readSource(file, checkCancelled) !== text) throw new Error("An editor buffer opened with changed content during refactoring.");
    }
}

async function runProjectTransaction(options, analyze, checkCancelled, log = () => {}) {
    const referencesOnly = options.referencesOnly === true;
    if (!referencesOnly) validateRenameName(options.oldName, options.newName);
    const structuralNumericLabel = !referencesOnly && isNumericLabelName(options.oldName) && !isNumericLabelName(options.newName);
    checkCancelled();
    const buffers = new Map(options.overlays);
    const frozen = new Map([...buffers].map(([file, text]) => [file, text.replace(/^\uFEFF/, "")])), disk = new Map();
    const physicalRoot = fs.realpathSync(options.root);
    const directory = fs.mkdtempSync(path.join(options.temporaryDirectory || os.tmpdir(), "fb-project-"));
    let sourceBytes = [...frozen.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    let spoolBytes = 0, expandedBytes = 0, compilerPasses = 0;
    const read = (file) => {
        if (frozen.has(file)) return;
        const text = readSource(file, checkCancelled);
        sourceBytes += Buffer.byteLength(text);
        if (sourceBytes > MAX_ANALYSIS_BYTES || frozen.size >= 5000) throw new Error("Project source snapshots exceed their byte or file limit.");
        frozen.set(file, text.replace(/^\uFEFF/, ""));
        disk.set(file, text);
    };
    const save = (name, value) => {
        checkCancelled();
        const encoded = serialize(value);
        spoolBytes += encoded.byteLength;
        if (spoolBytes > MAX_PROJECT_SPOOL_BYTES) throw new Error("Project validation baselines exceeded the 512 MiB scratch limit.");
        const file = path.join(directory, name);
        fs.writeFileSync(file, encoded, { flag: "wx", mode: 0o600 });
        return file;
    };
    const load = (file) => { checkCancelled(); return deserialize(fs.readFileSync(file)); };
    const compile = async (job, overlays) => {
        checkCancelled();
        compilerPasses++;
        const temporaryDirectory = fs.mkdtempSync(path.join(directory, "pass-"));
        const analysis = await analyze({ ...job, compilerPath: options.compilerPath, overlays, environment: options.environment, signal: options.signal, timeoutMs: options.timeoutMs, temporaryDirectory, allowSemanticSidecarFallback: false, exportSemanticBindings: true, requireSemanticModel: true, semanticModelOnly: options.semanticModelOnly === true,
            compactSemanticMacros: !(options.semanticModelOnly === true && options.semanticMacroReferences === true) });
        checkCancelled();
        if (analysis.partial || analysis.completion?.errorCount) throw new Error("Compiler refactoring requires error-free project contexts.");
        return analysis;
    };
    const capture = async (job, index) => {
        let analysis;
        // Discovery is not a baseline. Every consumed dependency must come
        // from the immutable source set before native identities are retained.
        for (let attempt = 0; attempt < 4; attempt++) {
            analysis = await compile(job, frozen);
            const missing = analysis.dependencies.filter((file) => !frozen.has(file));
            if (!missing.length) break;
            if (attempt === 3) throw new Error("Project dependencies did not stabilize.");
            for (const file of missing) read(file);
        }
        expandedBytes += Buffer.byteLength(analysis.text);
        if (expandedBytes > MAX_ANALYSIS_BYTES) throw new Error("Project expanded snapshots exceed 32 MiB.");
        const sources = analysis.dependencies.map((file) => ({ uri: CompilerUri.file(file), text: frozen.get(file).replace(/^\uFEFF/, "") }));
        const value = `freebasic-preprocessed:/refactor-${index}.bas`;
        const model = new CompilerSemanticModel(CompilerUri.from({ scheme: "freebasic-preprocessed", value }), analysis, sources);
        checkCancelled();
        const project = referencesOnly && analysis.semanticSidecarOnly
            ? sidecarProjectReferenceUnit(analysis, model)
            : projectUnit(analysis, model);
        if (!project) throw new Error("Compiler semantic bindings could not be mapped to physical project source tokens.");
        analysis.semanticBindings = [];
        analysis.semanticImplicitCalls = [];
        return { job, dependencies: analysis.dependencies, analysisFile: save(`analysis-${index}.bin`, analysis), projectFile: save(`project-${index}.bin`, project) };
    };
    try {
        if (sourceBytes > MAX_ANALYSIS_BYTES || frozen.size > 5000) throw new Error("Project source snapshots exceed their byte or file limit.");
        for (const job of options.jobs) read(job.filePath);
        const units = [];
        for (const job of options.jobs) {
            log(`Refactoring baseline: ${job.name}: ${job.filePath}`);
            units.push(await capture(job, units.length));
        }
        const projectSources = new Map(units.flatMap((unit) => unit.dependencies.map((file) => [file, frozen.get(file)])));
        if (referencesOnly) {
            let references = collectProjectReferences(
                units,
                options.selectedKey,
                options.oldName,
                options.includeDeclaration === true,
                (unit) => load(unit.projectFile),
                checkCancelled,
                { declarationsOnly: options.declarationsOnly === true }
            );
            if (references && serialize(references).byteLength > 8 * 1024 * 1024) references = null;
            const verification = { buffers, disk, targets: new Map(), root: options.root, physicalRoot };
            verifyProjectSources(verification, buffers, checkCancelled);
            return { references, verification, compilerPasses, units: units.length, spoolBytes };
        }
        const edits = collectProjectEdits(units, options.selectedKey, options.oldName, options.newName, projectSources, options.root, (unit) => load(unit.projectFile), checkCancelled);
        const targets = new Map([...edits.keys()].map((file) => [file, physicalPath(file)]));
        const patched = new Map(frozen);
        for (const [file, occurrences] of edits) {
            checkCancelled();
            let text = frozen.get(file);
            for (const occurrence of [...occurrences.values()].sort((a, b) => b.offset - a.offset)) text = text.slice(0, occurrence.offset) + occurrence.newText + text.slice(occurrence.end);
            patched.set(file, text);
        }
        for (const unit of units) {
            const baseline = load(unit.analysisFile);
            const baselineProject = load(unit.projectFile);
            const colonInsertions = structuralNumericLabel ? numericLabelColonInsertions(baseline, unit.renamedIds, frozen) : new Set();
            const structuralScopePlan = structuralElseScopePlan(baseline, edits, frozen);
            const before = validationSignatures(
                baseline, unit.renamedIds, options.newName, edits, frozen, colonInsertions, structuralScopePlan,
                checkCancelled, baselineProject.semanticBindingFacts, baselineProject.semanticImplicitCallFacts,
                baselineProject.unanchoredSemanticImplicitCallFacts, baselineProject.semanticConstructionObservationFacts
            );
            log(`Refactoring validation: ${unit.job.name}: ${unit.job.filePath}`);
            const afterScopePlan = structuralScopePlan && { ...structuralScopePlan, remap: false };
            const afterAnalysis = await compile(unit.job, patched);
            const afterSources = afterAnalysis.dependencies.map((file) => {
                const text = patched.get(file);
                if (typeof text !== "string") throw new Error("Compiler refactoring introduced a dependency outside the captured project snapshot.");
                return { uri: CompilerUri.file(file), text: text.replace(/^\uFEFF/, "") };
            });
            const afterModel = new CompilerSemanticModel(
                CompilerUri.from({ scheme: "freebasic-preprocessed", value: `freebasic-preprocessed:/refactor-verified-${units.indexOf(unit)}.bas` }),
                afterAnalysis,
                afterSources
            );
            const afterIdentityMap = semanticProjectBindingMaps(afterAnalysis, afterModel);
            const afterSemanticBindings = semanticProjectBindings(afterAnalysis, afterModel, true, afterIdentityMap);
            const afterSemanticImplicitCalls = semanticProjectImplicitCalls(afterAnalysis, afterModel, afterIdentityMap);
            const afterUnanchoredSemanticImplicitCalls = semanticProjectUnanchoredImplicitCalls(afterAnalysis, afterModel, afterIdentityMap);
            const afterConstructionObservations = semanticProjectConstructionObservations(afterAnalysis, afterModel, afterIdentityMap);
            const after = validationSignatures(
                afterAnalysis, undefined, undefined, undefined, undefined, colonInsertions, afterScopePlan,
                checkCancelled, afterSemanticBindings, afterSemanticImplicitCalls, afterUnanchoredSemanticImplicitCalls,
                afterConstructionObservations
            );
            afterAnalysis.semanticBindings = [];
            afterAnalysis.semanticImplicitCalls = [];
            for (const [name, signature] of before) if (after.get(name) !== signature) throw new Error(`Rename changed ${name}; no edits were returned.`);
        }
        const verification = { buffers, disk, targets, root: options.root, physicalRoot };
        verifyProjectSources(verification, buffers, checkCancelled);
        const result = [...edits].map(([filePath, occurrences]) => ({ filePath, occurrences: [...occurrences.values()], newText: options.newName }));
        if (serialize(result).byteLength > 8 * 1024 * 1024) throw new Error("Project rename edits exceeded 8 MiB.");
        return { edits: result, verification, compilerPasses, units: units.length, spoolBytes };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

module.exports = {
    runProjectTransaction,
    verifyProjectSources,
    validateRenameName,
    semanticProjectBindings,
    semanticProjectImplicitCalls,
    semanticProjectUnanchoredImplicitCalls
};

/* end of lib/compiler-project-transaction.js */
