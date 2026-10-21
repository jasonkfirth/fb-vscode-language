/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-project-bindings.js
    Purpose: Join native symbol families across explicit project configurations.
    Responsibilities: collect physical references, declarations, and edits; reject ambiguity.
    Does not contain: compiler execution, editor APIs, or source writes.
*/

const fs = require("fs");
const path = require("path");
const { tokenize } = require("./semantic-model");
const { normalizeIdentifier } = require("./freebasic-parser");

const MAX_PROJECT_REFERENCE_BINDINGS = 500000;
const MAX_PROJECT_REFERENCE_LOCATIONS = 50000;

function nativeIdentity(entry) { return entry.compilerPreprocessorId || entry.compilerSymbolId; }

/* Compiler bindings may spell a symbol with its full namespace path, while
   the editable source token is only the terminal identifier. Keep both forms
   for the unbound-occurrence safety check. */
function renameSpellings(name) {
    const normalized = normalizeIdentifier(name);
    if (!normalized) return [];
    const spellings = new Set([normalized]);
    const terminal = normalized.split(".").at(-1);
    if (terminal) spellings.add(terminal);
    return [...spellings];
}

/* FreeBASIC accepts the same decimal, hexadecimal, binary, and octal numeric
   literal spellings for numeric labels as it does for literal tokens. Keep
   the classification here, beside the physical-token validation that uses it,
   rather than treating only decimal labels as a special project case. */
function isNumericLabelName(name) {
    return typeof name === "string" && /^(?:&h[\da-f]+|&b[01]+|&o?[0-7]+|\d+)(?:ull|ul|ll|u|l|f|d|[%!#&])?$/i.test(name);
}

function declarationKey(entry) {
    if (entry.uri.scheme !== "file") return null;
    return `${entry.uri.fsPath}:${entry.declaration.line}:${entry.declaration.endColumn - entry.name.length}`;
}

function physicalPath(file) {
    return fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
}

/* A macro-expanded declaration can be instantiated independently in several
   translation units even though one physical macro argument generates its
   name. Join native IDs only when the ordered source mapping and result match. */
function generatedSymbolOriginKey(binding) {
    if (!Array.isArray(binding.generatedParts) || !binding.generatedParts.length) return null;
    const parts = [];
    for (const part of binding.generatedParts) {
        const occurrence = part.occurrence;
        if (!part.uri || part.uri.scheme !== "file" || !occurrence ||
            !["argument", "definition"].includes(part.role) ||
            !Number.isInteger(occurrence.offset) || !Number.isInteger(occurrence.end) ||
            occurrence.end <= occurrence.offset) return null;
        let sourcePath;
        try { sourcePath = physicalPath(part.uri.fsPath); }
        catch (_) { return null; }
        parts.push([
            part.role,
            sourcePath,
            occurrence.offset,
            occurrence.end,
            normalizeIdentifier(occurrence.name),
            part.outputStart,
            part.outputEnd
        ]);
    }
    return JSON.stringify([normalizeIdentifier(binding.name), parts]);
}

/* A numeric label immediately following THEN or ELSE is a distinct
   single-line IF grammar form. Replacing just its token with a name would
   make that name parse as an assignment target. The project transaction
   rewrites this exact compiler-bound branch as `GOTO name` and recompiles
   every selected build before returning the edit. */
function isSingleLineIfLabel(text, occurrence) {
    const start = text.lastIndexOf("\n", occurrence.offset - 1) + 1;
    return text.slice(start, occurrence.offset).match(/\b(then|else)\s*$/i)?.[1].toLowerCase() || "";
}

/* A malformed or unexpectedly large provenance graph must not turn rename
   into unbounded combinatorial work. Exhausting either limit refuses the edit. */
/* FBC defines FB_MAXNAMELEN as 128 bytes, which also bounds this search input. */
const MAX_GENERATED_EDIT_NAME_LENGTH = 128;
const MAX_GENERATED_EDIT_PARTS = 128;
const MAX_GENERATED_EDIT_SEARCH_STEPS = 8192;

/* Project a generated identifier only when compiler provenance permits one
   unique minimum-edit decomposition. Fixed definition text stays unchanged,
   and repeated uses of one physical argument must receive one replacement. */
function generatedSymbolEdit(binding, oldName, newName) {
    if (!binding || typeof binding.name !== "string" || typeof oldName !== "string" ||
        typeof newName !== "string" || !Array.isArray(binding.generatedParts) ||
        binding.name.length > MAX_GENERATED_EDIT_NAME_LENGTH ||
        oldName.length > MAX_GENERATED_EDIT_NAME_LENGTH ||
        newName.length > MAX_GENERATED_EDIT_NAME_LENGTH ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name) ||
        binding.name.toLowerCase() !== oldName.toLowerCase() ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return null;
    const parts = binding.generatedParts;
    if (!parts.length || parts.length > MAX_GENERATED_EDIT_PARTS ||
        parts.some((part) => !["argument", "definition"].includes(part.role))) return null;

    let outputEnd = 0;
    const sourceGroups = new Map();
    const groupByPart = new Array(parts.length).fill(null);
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (!Number.isSafeInteger(part.outputStart) || !Number.isSafeInteger(part.outputEnd) ||
            part.outputStart !== outputEnd || part.outputEnd <= part.outputStart) return null;
        const originalPart = binding.name.slice(part.outputStart, part.outputEnd);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(originalPart)) return null;
        outputEnd = part.outputEnd;
        if (part.role !== "argument") continue;

        const occurrence = part.occurrence;
        if (!part.uri || part.uri.scheme !== "file" || typeof part.uri.fsPath !== "string" ||
            !occurrence || occurrence.kind !== "identifier" ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(occurrence.name) ||
            !Number.isSafeInteger(occurrence.offset) || !Number.isSafeInteger(occurrence.end) ||
            occurrence.end <= occurrence.offset || occurrence.name.toLowerCase() !== originalPart.toLowerCase()) return null;

        const key = `${part.uri.fsPath}:${occurrence.offset}:${occurrence.end}`;
        let group = sourceGroups.get(key);
        if (!group) {
            group = { physical: part, sourceName: occurrence.name };
            sourceGroups.set(key, group);
        } else if (group.sourceName !== occurrence.name) {
            return null;
        }
        groupByPart[index] = key;
    }
    if (outputEnd !== binding.name.length || !sourceGroups.size || binding.name === newName) return null;

    const minimumRemaining = new Array(parts.length + 1).fill(0);
    for (let index = parts.length - 1; index >= 0; index--) {
        const partLength = parts[index].outputEnd - parts[index].outputStart;
        minimumRemaining[index] = minimumRemaining[index + 1] +
            (parts[index].role === "definition" ? partLength : 1);
    }

    const replacements = new Map();
    const solutions = new Map();
    let bestEditCount = Infinity;
    let searchSteps = 0;
    let exhausted = false;

    function retainSolution() {
        const edits = [];
        for (const [key, group] of sourceGroups) {
            const replacement = replacements.get(key);
            if (typeof replacement !== "string") return;
            if (replacement !== group.sourceName) edits.push({ physical: group.physical, newText: replacement });
        }
        if (!edits.length) return;
        edits.sort((left, right) => {
            const leftPath = left.physical.uri.fsPath;
            const rightPath = right.physical.uri.fsPath;
            if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
            return left.physical.occurrence.offset - right.physical.occurrence.offset;
        });
        const key = JSON.stringify(edits.map((edit) => [
            edit.physical.uri.fsPath,
            edit.physical.occurrence.offset,
            edit.physical.occurrence.end,
            edit.newText
        ]));
        if (edits.length < bestEditCount) {
            bestEditCount = edits.length;
            solutions.clear();
        }
        if (edits.length === bestEditCount && !solutions.has(key)) solutions.set(key, edits);
    }

    function search(partIndex, renamedOffset, changedGroups) {
        if (exhausted || changedGroups > bestEditCount) return;
        searchSteps++;
        if (searchSteps > MAX_GENERATED_EDIT_SEARCH_STEPS) {
            exhausted = true;
            return;
        }
        if (partIndex === parts.length) {
            if (renamedOffset === newName.length) retainSolution();
            return;
        }

        const part = parts[partIndex];
        if (part.role === "definition") {
            const fixed = binding.name.slice(part.outputStart, part.outputEnd);
            if (newName.startsWith(fixed, renamedOffset)) {
                search(partIndex + 1, renamedOffset + fixed.length, changedGroups);
            }
            return;
        }

        const groupKey = groupByPart[partIndex];
        const assigned = replacements.get(groupKey);
        if (assigned !== undefined) {
            if (newName.startsWith(assigned, renamedOffset)) {
                search(partIndex + 1, renamedOffset + assigned.length, changedGroups);
            }
            return;
        }

        const lastEnd = newName.length - minimumRemaining[partIndex + 1];
        for (let end = renamedOffset + 1; end <= lastEnd; end++) {
            const candidate = newName.slice(renamedOffset, end);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) continue;
            const sourceName = sourceGroups.get(groupKey).sourceName;
            const nextChangedGroups = changedGroups + (candidate === sourceName ? 0 : 1);
            if (nextChangedGroups > bestEditCount) continue;
            replacements.set(groupKey, candidate);
            search(partIndex + 1, end, nextChangedGroups);
            replacements.delete(groupKey);
            if (exhausted) return;
        }
    }

    search(0, 0, 0);
    return !exhausted && solutions.size === 1 ? [...solutions.values()][0] : null;
}

function collectProjectEdits(units, selectedKey, oldName, newName, sources, root, loadUnit, checkCancelled) {
    /* Union shared physical declarations, not module-local numeric IDs.
       A header prototype joins its callers to an implementation in another
       translation unit. Conditional versions join only at shared anchors. */
    const parents = new Map();
    const find = (key) => {
        if (!parents.has(key)) parents.set(key, key);
        let current = key;
        while (parents.get(current) !== current) current = parents.get(current);
        return current;
    };
    const conditionalPropertyReferences = new Map();
    const generatedSymbolFamilies = new Map();
    for (const unit of units) {
        checkCancelled();
        const data = loadUnit(unit);
        unit.families = new Map();
        for (const entry of data.declarations) {
            const identity = nativeIdentity(entry);
            if (!identity) continue;
            const key = declarationKey(entry);
            if (!key) continue;
            const prior = unit.families.get(identity);
            if (prior) parents.set(find(key), find(prior));
            else unit.families.set(identity, key);
            find(key);
        }
        const propertyDeclarations = new Map(data.declarations
            .filter((entry) => entry.type === "property" && ["getter", "setter"].includes(entry.propertyRole) && entry.compilerSymbolId)
            .map((entry) => [entry.compilerSymbolId, entry]));
        for (const binding of data.bindings) {
            const declaration = propertyDeclarations.get(binding.id);
            const familyKey = unit.families.get(binding.id);
            const occurrence = binding.physical?.occurrence;
            if (!declaration || !familyKey || !occurrence || binding.physical.uri.scheme !== "file") continue;
            const qualifiedName = normalizeIdentifier(declaration.qualifiedName || declaration.name);
            const contextName = unit.job?.name;
            if (!qualifiedName || !contextName) continue;
            const key = `${binding.physical.uri.fsPath}:${occurrence.offset}:${qualifiedName}:${declaration.propertyRole}`;
            const references = conditionalPropertyReferences.get(key) || new Map();
            const families = references.get(contextName) || new Set();
            families.add(familyKey);
            references.set(contextName, families);
            conditionalPropertyReferences.set(key, references);
        }
        for (const binding of data.bindings) {
            if (binding.kind !== "declaration" || binding.physical) continue;
            const familyKey = unit.families.get(binding.id);
            const originKey = generatedSymbolOriginKey(binding);
            if (!familyKey || !originKey) continue;
            const prior = generatedSymbolFamilies.get(originKey);
            if (prior) parents.set(find(prior), find(familyKey));
            else generatedSymbolFamilies.set(originKey, familyKey);
        }
    }
    /* A physical property use can select a different getter or setter symbol
       when project contexts compile mutually exclusive declarations. Join
       those compiler identities only when the source token and qualified
       property are identical across named contexts; within one build, the
       ordinary declaration anchors continue to keep accessors independent. */
    for (const references of conditionalPropertyReferences.values()) {
        const contextFamilies = [...references.values()].map((keys) => [...keys]);
        if (contextFamilies.length < 2 || contextFamilies.some((keys) => keys.length !== 1)) continue;
        const canonical = contextFamilies[0][0];
        for (const keys of contextFamilies.slice(1)) {
            for (const key of keys) parents.set(find(canonical), find(key));
        }
    }
    /* Dispatch is a rename family, not a resolution alias: navigation must
       retain the statically selected method. Join overrides only for the
       edit operation, and retain missing declaration anchors so a partial
       family cannot quietly become a base-only or derived-only rename. */
    for (const [index, unit] of units.entries()) {
        checkCancelled();
        const data = loadUnit(unit);
        // Macro names are global within a translation unit. #undef creates
        // another lifetime, not another namespace. Include guards also test
        // an absent name before declaring it. Join these name lifetimes for
        // rename, but keep negative queries unresolved in normal navigation.
        const macroNames = new Map();
        unit.unmappedMacros = new Set();
        for (const symbol of data.symbols) {
            if (symbol.symbolClass !== 5) continue;
            const identity = `macro:${symbol.id}`;
            if (!unit.families.has(identity)) {
                unit.families.set(identity, `\0unmapped-macro:${index}:${symbol.id}`);
                unit.unmappedMacros.add(identity);
            }
            const key = unit.families.get(identity), name = symbol.name.toLowerCase();
            const prior = macroNames.get(name);
            if (prior) parents.set(find(key), find(prior));
            else { find(key); macroNames.set(name, key); }
        }
        for (const reference of data.preprocessorReferences) {
            if (reference.symbol || !macroNames.has(reference.name.toLowerCase())) continue;
            unit.families.set(`undefined:${reference.name.toLowerCase()}`, macroNames.get(reference.name.toLowerCase()));
        }
        unit.unmappedMethods = new Set();
        const anchor = (id) => {
            if (!unit.families.has(id)) {
                unit.families.set(id, `\0unmapped-method:${index}:${id}`);
                unit.unmappedMethods.add(id);
            }
            return unit.families.get(id);
        };
        for (const method of data.dispatch) {
            if (!method.slot) continue;
            const key = anchor(method.id);
            find(key);
            if (method.overridden) parents.set(find(key), find(anchor(method.overridden)));
        }
    }
    /* A replacement-list identifier has two compiler lookup roles. The
       preprocessor can retain an unresolved macro candidate while an actual
       expansion resolves the same physical token as a FreeBASIC symbol. Join
       that unresolved candidate only when every mapped token with that name
       resolves to the same anchored native family in this translation unit.
       The recompile after editing still rejects a new-name macro capture. */
    for (const [index, unit] of units.entries()) {
        checkCancelled();
        const data = loadUnit(unit);
        const physicalKey = (binding) => {
            const physical = binding.physical;
            const occurrence = physical?.occurrence;
            if (physical?.uri?.scheme !== "file" || !occurrence ||
                !Number.isInteger(occurrence.offset) || !Number.isInteger(occurrence.end)) return null;
            return `${physical.uri.fsPath}:${occurrence.offset}:${occurrence.end}`;
        };
        const nativeFamiliesByPhysical = new Map();
        for (const binding of data.bindings) {
            checkCancelled();
            if (!Number.isSafeInteger(binding.id) || binding.id < 1) continue;
            const familyKey = unit.families.get(binding.id);
            const key = physicalKey(binding);
            if (!familyKey || !key) continue;
            const families = nativeFamiliesByPhysical.get(key) || new Set();
            families.add(familyKey);
            nativeFamiliesByPhysical.set(key, families);
        }
        const unresolved = new Map();
        for (const binding of data.bindings) {
            checkCancelled();
            if (typeof binding.id !== "string" || !binding.id.startsWith("undefined:") || unit.families.has(binding.id)) continue;
            const key = physicalKey(binding);
            const group = unresolved.get(binding.id) || { families: new Set(), complete: true, tokens: new Set() };
            if (!key) group.complete = false;
            else if (!group.tokens.has(key)) {
                group.tokens.add(key);
                const families = nativeFamiliesByPhysical.get(key);
                if (!families || families.size !== 1) group.complete = false;
                else group.families.add([...families][0]);
            }
            unresolved.set(binding.id, group);
        }
        for (const [identity, group] of unresolved) {
            if (!group.complete || !group.tokens.size || group.families.size !== 1) continue;
            const anchor = `\0unresolved-preprocessor:${index}:${identity}`;
            unit.families.set(identity, anchor);
            parents.set(find(anchor), find([...group.families][0]));
        }
    }
    if (!parents.has(selectedKey)) throw new Error("The selected declaration is outside the configured project contexts.");
    const family = find(selectedKey);
    const edits = new Map();
    const covered = new Set();
    const interpretations = new Map();
    const renamedSpellings = new Set(renameSpellings(oldName));
    for (const unit of units) {
        checkCancelled();
        const data = loadUnit(unit);
        unit.renamedIds = new Set([...unit.families].filter(([, key]) => find(key) === family).map(([id]) => id));
        if ([...unit.unmappedMacros].some((id) => unit.renamedIds.has(id))) throw new Error("Compiler macro rename requires physical declarations for every configured name lifetime, including command-line definitions.");
        if ([...unit.unmappedMethods].some((id) => unit.renamedIds.has(id))) throw new Error("Compiler rename requires a physical declaration for every method in the virtual family.");
        const procedureIds = new Set([...unit.renamedIds].map((id) => data.procedureIds.get(id)));
        if (data.nonRenameableProcedures.some((id) => procedureIds.has(id)) || data.nonRenameableSymbols.some((id) => unit.renamedIds.has(id))) throw new Error("Compiler rename is unsafe because this symbol has an external ABI restriction or an unprojectable occurrence.");
        const bindings = data.bindings;
        for (const binding of bindings) {
            checkCancelled();
            const selected = unit.renamedIds.has(binding.id);
            if (!selected && typeof binding.id === "string" && binding.id.startsWith("undefined:") &&
                binding.kind === "reference" && binding.physical && renamedSpellings.has(normalizeIdentifier(binding.name))) {
                throw new Error(`Compiler rename cannot safely update unresolved macro replacement reference ${binding.name}; every configured build must provide one unambiguous native binding.`);
            }
            const generatedEdits = selected && !binding.physical
                ? generatedSymbolEdit(binding, oldName, newName)
                : null;
            const candidates = binding.physical
                ? [{ physical: binding.physical, newText: null, generated: false }]
                : generatedEdits
                    ? generatedEdits.map((candidate) => ({ ...candidate, generated: true }))
                    : [];
            if (selected && !candidates.length) throw new Error("Rename crosses generated or unmapped text. Complete physical macro provenance is required.");
            for (const candidate of candidates) {
                const mapped = candidate.physical;
                const key = `${mapped.uri.fsPath}:${mapped.occurrence.offset}`;
                covered.add(key);
                if (interpretations.has(key) && interpretations.get(key) !== selected) throw new Error(`This token (${binding.name} at ${mapped.occurrence.line + 1}:${mapped.occurrence.startColumn}) binds to different declarations across configured builds.`);
                interpretations.set(key, selected);
                if (!selected) continue;
                if (!candidate.generated) {
                    for (const spelling of renameSpellings(binding.name)) renamedSpellings.add(spelling);
                    for (const spelling of renameSpellings(mapped.occurrence.name)) renamedSpellings.add(spelling);
                }
                const physical = physicalPath(mapped.uri.fsPath);
                const relative = path.relative(fs.realpathSync(root), physical);
                if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Rename would edit a dependency outside the workspace.");
                const occurrences = edits.get(mapped.uri.fsPath) || new Map();
                const numericToNamed = isNumericLabelName(oldName) && !isNumericLabelName(newName);
                let replacement = candidate.newText || newName;
                if (numericToNamed && binding.kind === "declaration") {
                    /* A named label requires a delimiter. Numeric labels may
                       already carry their optional colon, so add one only when
                       the compiler-confirmed declaration token is colon-free. */
                    if (sources.get(mapped.uri.fsPath)?.[mapped.occurrence.end] !== ":") replacement += ":";
                }
                const singleLineIfLabel = numericToNamed && binding.kind !== "declaration" && isSingleLineIfLabel(sources.get(mapped.uri.fsPath) || "", mapped.occurrence);
                if (singleLineIfLabel) replacement = `Goto ${newName}`;
                const prior = occurrences.get(mapped.occurrence.offset);
                if (prior && prior.newText !== replacement) throw new Error("This token has incompatible declaration roles across configured builds.");
                occurrences.set(mapped.occurrence.offset, { ...mapped.occurrence, newText: replacement, singleLineIfLabel });
                edits.set(mapped.uri.fsPath, occurrences);
            }
        }
    }
    if (!edits.size) throw new Error("No compiler-backed project edits were found.");
    // Parameter slots cover every replacement-list occurrence, including
    // unused definitions. Their native graph catches new substitutions or
    // merged parameters; an unrelated spelling is not itself a capture.
    const preprocessorRename = units.some((unit) => [...unit.renamedIds].some((id) => typeof id === "string" && /^(?:macro|parameter):/.test(id)));
    const numericLabel = isNumericLabelName(oldName);
    for (const [file, text] of sources) {
        for (const occurrence of tokenize(text).tokens) {
            checkCancelled();
            if (occurrence.kind !== "identifier" && !(numericLabel && occurrence.kind === "number")) continue;
            if (!preprocessorRename && normalizeIdentifier(newName) !== normalizeIdentifier(oldName) && occurrence.key === normalizeIdentifier(newName)) throw new Error(`The new name already occurs in ${file}; capture cannot be ruled out.`);
            if (renamedSpellings.has(occurrence.key) && !covered.has(`${file}:${occurrence.offset}`)) throw new Error(`An occurrence in ${file}:${occurrence.line + 1} is not compiler-bound in any configured build. Add missing configurations or resolve macro/address-taking coverage first.`);
        }
    }
    return edits;
}

/* Return exact physical occurrences across explicit project contexts without
   constructing a text edit. Ambiguous cross-context sites and generated
   references without verified source provenance fail closed. */
function collectProjectReferences(units, selectedKey, selectedName, includeDeclaration, loadUnit, checkCancelled, options = {}) {
    const declarationsOnly = options.declarationsOnly === true;
    const pathKey = (filePath) => {
        const resolved = path.resolve(filePath);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const moduleFile = options.moduleOutgoingFile ? pathKey(options.moduleOutgoingFile) : "";
    // Module ownership is the compiler's caller=0 concept, not a fabricated
    // procedure identity. Keep its selector outside native symbol families.
    const moduleKey = moduleFile ? JSON.stringify(["module", moduleFile]) : "";
    const parents = new Map();
    const find = (key) => {
        if (!parents.has(key)) parents.set(key, key);
        let current = key;
        while (parents.get(current) !== current) current = parents.get(current);
        return current;
    };
    const familiesByUnit = new Map();
    const generatedSymbolFamilies = new Map();
    const unprojectableAnchors = [];
    let scannedBindings = 0;

    for (const unit of units) {
        checkCancelled();
        const data = loadUnit(unit);
        const families = new Map();
        if (Array.isArray(data.unprojectableAnchors)) {
            for (const anchor of data.unprojectableAnchors) {
                if (typeof anchor === "string") unprojectableAnchors.push(anchor);
            }
        }
        for (const entry of data.declarations) {
            checkCancelled();
            if (++scannedBindings > MAX_PROJECT_REFERENCE_BINDINGS) return null;
            const identity = nativeIdentity(entry);
            const key = identity && declarationKey(entry);
            if (!key) continue;
            const prior = families.get(identity);
            if (prior) parents.set(find(key), find(prior));
            else families.set(identity, key);
            find(key);
        }
        familiesByUnit.set(unit, families);
        for (const binding of data.bindings) {
            if (++scannedBindings > MAX_PROJECT_REFERENCE_BINDINGS) return null;
            if (binding.kind !== "declaration" || binding.physical) continue;
            const family = families.get(binding.id);
            const origin = generatedSymbolOriginKey(binding);
            if (!family || !origin) continue;
            const prior = generatedSymbolFamilies.get(origin);
            if (prior) parents.set(find(prior), find(family));
            else generatedSymbolFamilies.set(origin, family);
        }
    }

    if (moduleKey) find(moduleKey);
    const selectionKey = moduleKey || selectedKey;
    if (!parents.has(selectionKey)) return null;
    const selectedFamily = find(selectionKey);
    const selectedFamilies = new Set([selectedFamily]);
    const typeHierarchy = declarationsOnly && ["direct", "transitive"].includes(options.typeHierarchy);
    const directSubtypes = typeHierarchy && options.typeHierarchy === "direct";
    if (declarationsOnly && (options.includeOverrides === true || typeHierarchy)) {
        // Inheritance and dispatch select descendants without unioning their
        // resolution families. Type Hierarchy visits one level; Implementation
        // includes the selected method and its transitive overrides.
        const children = new Map(), incomplete = new Set();
        for (const unit of units) {
            const families = familiesByUnit.get(unit);
            const data = loadUnit(unit);
            for (const relation of (typeHierarchy ? data.inheritance : data.dispatch) || []) {
                checkCancelled();
                if (++scannedBindings > MAX_PROJECT_REFERENCE_BINDINGS) return null;
                const base = typeHierarchy ? relation.base : relation.overridden;
                if (!base) continue;
                const parent = families.get(base), child = families.get(relation.id);
                if (!parent) continue;
                const parentFamily = find(parent);
                if (!child) { incomplete.add(parentFamily); continue; }
                const childFamily = find(child);
                if (parentFamily === childFamily) continue;
                const descendants = children.get(parentFamily) || new Set();
                descendants.add(childFamily);
                children.set(parentFamily, descendants);
            }
        }
        if (typeHierarchy) selectedFamilies.clear();
        const pending = [selectedFamily];
        for (let index = 0; index < pending.length; index++) {
            checkCancelled();
            const family = pending[index];
            if (incomplete.has(family)) return null;
            for (const child of children.get(family) || []) {
                if (typeHierarchy && child === selectedFamily) return null;
                if (selectedFamilies.has(child)) continue;
                selectedFamilies.add(child);
                if (!directSubtypes) pending.push(child);
                if (selectedFamilies.size > MAX_PROJECT_REFERENCE_LOCATIONS) return null;
            }
        }
    }
    if (unprojectableAnchors.some((anchor) => parents.has(anchor) && selectedFamilies.has(find(anchor)))) return null;
    const selectedSpellings = new Set(moduleKey ? [] : renameSpellings(selectedName));
    const physicalFamilies = new Map();
    const nativeMacroAnchorFamilies = new Map();
    const locations = new Map();
    const selectedSites = new Set(), ordinaryTargets = new Map();
    const addOccurrence = (filePath, occurrence, family, selected, include, kind, physicalBinding, caller = null, callee = null,
        implicitCall = false, nativeMacroAnchor = false) => {
        if (!filePath || !Number.isSafeInteger(occurrence?.offset) ||
            !Number.isSafeInteger(occurrence?.end) || occurrence.end <= occurrence.offset ||
            occurrence.offset < 0 || !Number.isSafeInteger(occurrence.line) || occurrence.line < 0 ||
            !Number.isSafeInteger(occurrence.startColumn) || occurrence.startColumn < 0 ||
            !Number.isSafeInteger(occurrence.endColumn) || occurrence.endColumn < 0) return false;
        const endLine = occurrence.endLine ?? occurrence.line;
        if (!Number.isSafeInteger(endLine) || endLine < occurrence.line ||
            endLine === occurrence.line && occurrence.endColumn <= occurrence.startColumn) return false;
        const keyPath = pathKey(filePath);
        const key = `${keyPath}:${occurrence.offset}:${occurrence.end}`;
        const families = physicalFamilies.get(key) || new Set();
        // Distinct compiler-proven calls can share one reporting anchor.
        // Ordinary references and every editable spelling keep the stricter
        // one-family rule; this exception is confined to read-only hierarchy.
        if (!implicitCall || options.incomingCalls !== true && options.outgoingCalls !== true) families.add(family);
        physicalFamilies.set(key, families);
        if (nativeMacroAnchor) {
            const proven = nativeMacroAnchorFamilies.get(key) || new Set();
            proven.add(family);
            nativeMacroAnchorFamilies.set(key, proven);
        }
        if (selected && include) {
            if (options.incomingCalls === true && !caller?.uri?.fsPath) return false;
            if (options.outgoingCalls === true && !callee?.uri?.fsPath) return false;
            let locationKey = key;
            if (options.outgoingCalls === true) {
                // One physical span can construct/destroy or expand to several
                // calls. Proven implicit/expanded calls have distinct edges; ordinary
                // CALL records must still agree on their one selected target.
                const target = JSON.stringify(callee);
                if (!implicitCall) {
                    const previous = ordinaryTargets.get(key);
                    if (previous && previous !== target) return false;
                    ordinaryTargets.set(key, target);
                }
                locationKey = `${key}:${target}`;
            }
            const previous = locations.get(locationKey);
            if (previous && (previous.kind !== kind || previous.physicalBinding !== physicalBinding)) return false;
            if (previous && options.incomingCalls === true && JSON.stringify(previous.caller) !== JSON.stringify(caller)) return false;
            if (previous && options.outgoingCalls === true && JSON.stringify(previous.callee) !== JSON.stringify(callee)) return false;
            if (!previous) {
                if (locations.size >= MAX_PROJECT_REFERENCE_LOCATIONS) return false;
                locations.set(locationKey, {
                    filePath,
                    occurrence: {
                        line: occurrence.line,
                        startColumn: occurrence.startColumn,
                        ...(occurrence.endLine !== undefined ? { endLine } : {}),
                        endColumn: occurrence.endColumn,
                        ...(occurrence.macroInvocation === true ? { macroInvocation: true } : {})
                    },
                    name: occurrence.name || "",
                    kind,
                    physicalBinding,
                    ...(options.incomingCalls === true ? { caller } : {}),
                    ...(options.outgoingCalls === true ? { callee } : {})
                });
                selectedSites.add(key);
            }
        }
        return true;
    };

    for (const unit of units) {
        checkCancelled();
        const data = loadUnit(unit);
        const families = familiesByUnit.get(unit);
        for (const binding of data.bindings) {
            checkCancelled();
            if (++scannedBindings > MAX_PROJECT_REFERENCE_BINDINGS) return null;
            // Declarations anchor caller families above, but are not call
            // edges or competing meanings of an implicit cleanup span.
            if (options.outgoingCalls === true && binding.kind !== "reference") continue;
            if (moduleKey && (binding.kind !== "reference" || binding.id !== 0)) continue;
            if (moduleKey && binding.physical?.uri?.fsPath && pathKey(binding.physical.uri.fsPath) !== moduleFile) continue;
            const familyAnchor = moduleKey || families.get(binding.id);
            if (!familyAnchor) continue;
            const family = find(familyAnchor);
            const selected = selectedFamilies.has(family);
            if (declarationsOnly && (binding.kind !== "declaration" || !binding.physical)) continue;
            const include = declarationsOnly || binding.kind === "reference" ||
                includeDeclaration && binding.kind === "declaration";
            if (binding.physical) {
                const nativeMacroAnchor = binding.kind === "reference" && options.incomingCalls !== true && options.outgoingCalls !== true &&
                    (options.operatorReferences === true && binding.nativeMemoryMacroReference === true ||
                        options.procedureReferences === true && binding.nativeMacroProcedureReference === true);
                if (binding.physical.uri?.scheme !== "file" ||
                    !addOccurrence(binding.physical.uri.fsPath, binding.physical.occurrence,
                        family, selected, include, binding.kind, true, binding.caller, binding.callee,
                        binding.implicitCall === true || binding.macroCall === true, nativeMacroAnchor)) return null;
                continue;
            }
            if (declarationsOnly) continue;
            if (!Array.isArray(binding.generatedParts) || !binding.generatedParts.length) {
                if (selected && include) return null;
                if (binding.kind === "reference" &&
                    renameSpellings(binding.name).some((spelling) => selectedSpellings.has(spelling))) return null;
                continue;
            }
            for (const part of binding.generatedParts) {
                if (part.uri?.scheme !== "file" ||
                    !addOccurrence(part.uri.fsPath, part.occurrence, family, selected, include,
                        binding.kind, false)) return null;
            }
        }
    }

    for (const key of selectedSites) {
        const families = physicalFamilies.get(key);
        if ((families?.size || 0) > 1) {
            // A macro may select several procedures/operators at one reporting
            // anchor. Every competing family needs its own native receipt;
            // one marked reference cannot bless an ordinary ambiguous token.
            const proven = nativeMacroAnchorFamilies.get(key);
            if (!proven || [...families].some((family) => !proven.has(family))) return null;
        }
    }
    return [...locations.values()].sort((first, second) =>
        first.filePath.localeCompare(second.filePath) || first.occurrence.line - second.occurrence.line ||
        first.occurrence.startColumn - second.occurrence.startColumn);
}

module.exports = {
    nativeIdentity,
    declarationKey,
    physicalPath,
    isNumericLabelName,
    generatedSymbolEdit,
    collectProjectEdits,
    collectProjectReferences
};

/* end of lib/compiler-project-bindings.js */
