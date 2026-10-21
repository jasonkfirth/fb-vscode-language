/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/audit-compiler-call-routes.js
    Purpose: Audit compiler-selected and implicit constructor call sites.
    Responsibilities: inventory active compiler call builders and require a
        deliberate provenance owner for every implicit call or constructor.
    Does not contain: compiler instrumentation, source rewriting, or editor
        type policy.
*/

const fs = require("fs");
const path = require("path");
const { listCompilerSourceFiles, resolveCompilerSourcePath } = require("./audit-freebasic-coverage");

/*
    Parser-route coverage proves that normal expression parsers have an
    owner. This companion inventory covers calls selected later by semantic
    checks and lowering, where a source parser may no longer be on the stack.
    Each entry names the enclosing compiler routine and the bridge mechanism
    that preserves its written input or selected target.
*/
const CALL_BUILDERS = Object.freeze(["astBuildCall", "astBuildCtorCall", "astBuildImplicitCtorCall", "astBuildDtorCall", "astBuildVarDtorCall"]);

const CALL_SITE_OWNERS = Object.freeze([
    Object.freeze({ file: "parser-quirk-gfx.bas", container: "hMaybeUdt2Ptr", kind: "function", calls: 1, owner: "graphics image-coercion statement path" }),
    Object.freeze({ file: "ast-node-uop.bas", container: "astNewUOP", kind: "function", calls: 1, owner: "unary transform wrapper" }),
    Object.freeze({ file: "ast-node-bop.bas", container: "hDoGlobOpOverload", kind: "macro", calls: 1, owner: "binary transform wrapper" }),
    Object.freeze({ file: "ast-node-bop.bas", container: "hNewSelfBOP", kind: "function", calls: 1, owner: "combined-assignment source emission" }),
    Object.freeze({ file: "ast-node-assign.bas", container: "hTryAssignOvl", kind: "function", calls: 1, owner: "UDT LET source emission" }),
    Object.freeze({ file: "ast-node-assign.bas", container: "hTryAssignCastOvl", kind: "function", calls: 1, owner: "assignment conversion transform" }),
    Object.freeze({ file: "parser-compound-for.bas", container: "hUdtCallOpOvl", kind: "function", calls: 1, owner: "UDT FOR/STEP/NEXT source emission" }),
    Object.freeze({ file: "parser-expr-unary.bas", container: "hVarPtrBody", kind: "function", calls: 1, owner: "address-of parser boundary" }),
    Object.freeze({ file: "ast-node-arg.bas", container: "hCheckParam", kind: "function", calls: 1, owner: "argument transform wrapper" }),
    Object.freeze({ file: "ast-helper.bas", container: "astBuildMultiDeref", kind: "function", calls: 1, owner: "multi-dereference source emission" }),
    Object.freeze({ file: "parser-expr-variable.bas", container: "cMemberDeref", kind: "function", calls: 2, owner: "member and index source emission" }),
    Object.freeze({ file: "ast-misc.bas", container: "hPrepareBranchExpr", kind: "function", calls: 1, owner: "conditional conversion transform" }),
    Object.freeze({ file: "ast-node-conv.bas", container: "astTryOvlOpCastCONV", kind: "function", calls: 1, owner: "conversion transform wrapper" }),
    Object.freeze({ file: "ast-node-conv.bas", container: "astTryOvlStringCONV", kind: "function", calls: 1, owner: "conversion transform wrapper" }),
    Object.freeze({ file: "ast-node-conv.bas", container: "astNewCONV", kind: "function", calls: 2, owner: "conversion transform wrapper" }),
    Object.freeze({ file: "ast-node-proc.bas", container: "hMaybeCallResultCtor", kind: "function", builder: "astBuildCtorCall", calls: 1, owner: "generated function-result construction" }),
    Object.freeze({ file: "ast-node-proc.bas", container: "hCallCtorList", kind: "function", builder: "astBuildCtorCall", calls: 1, owner: "generated member-array construction" }),
    Object.freeze({ file: "ast-node-proc.bas", container: "hCallFieldCtor", kind: "function", builder: "astBuildCtorCall", calls: 1, owner: "generated member construction" }),
    Object.freeze({ file: "ast-node-iif.bas", container: "astNewIIF", kind: "function", builder: "astBuildCtorCall", calls: 3, owner: "conditional construction transform" }),
    Object.freeze({ file: "ast-node-mem.bas", container: "hCallCtorList", kind: "function", builder: "astBuildCtorCall", calls: 1, owner: "generated allocation-array construction" }),
    Object.freeze({ file: "ast-node-mem.bas", container: "astBuildNewOp", kind: "function", builder: "astBuildCtorCall", calls: 1, owner: "NEW constructor source projection" }),
    Object.freeze({ file: "ast-node-assign.bas", container: "hTryAssignOvl", kind: "function", builder: "astBuildCtorCall", calls: 1, owner: "generated assignment preparation" }),
    Object.freeze({ file: "ast-helper.bas", container: "astBuildImplicitCtorCallEx", kind: "function", builder: "astBuildImplicitCtorCall", calls: 1, owner: "implicit construction transform" }),
    Object.freeze({ file: "ast-node-typeini.bas", container: "hCallCtorList", kind: "function", builder: "astBuildCtorCall", calls: 2, owner: "generated type-initializer construction" }),
    Object.freeze({ file: "ast-node-decl.bas", container: "hCtorList", kind: "function", builder: "astBuildCtorCall", calls: 1, owner: "generated declaration-array construction" }),
    Object.freeze({ file: "ast-node-decl.bas", container: "hDefaultInit", kind: "function", builder: "astBuildCtorCall", calls: 1, owner: "generated declaration construction" }),
    Object.freeze({ file: "ast-helper.bas", container: "astBuildVarDtorCall", kind: "function", builder: "astBuildDtorCall", calls: 2, owner: "native variable-destructor helper overloads" }),
    Object.freeze({ file: "ast-node-proc.bas", container: "hCallCtorList", kind: "function", builder: "astBuildDtorCall", calls: 1, owner: "generated array-field destruction" }),
    Object.freeze({ file: "ast-node-proc.bas", container: "hCallFieldDtor", kind: "sub", builder: "astBuildDtorCall", calls: 1, owner: "generated field destruction" }),
    Object.freeze({ file: "ast-node-proc.bas", container: "hCallBaseDtor", kind: "sub", builder: "astBuildDtorCall", calls: 1, owner: "generated base-class destruction" }),
    Object.freeze({ file: "ast-node-proc.bas", container: "hCallStaticDtor", kind: "sub", builder: "astBuildDtorCall", calls: 1, owner: "generated static-instance destruction" }),
    Object.freeze({ file: "parser-decl-var.bas", container: "hEmitVarDecl", kind: "function", builder: "astBuildVarDtorCall", calls: 1, owner: "unscoped declaration cleanup" }),
    Object.freeze({ file: "ast-node-scope.bas", container: "hDestroyBlockLocals", kind: "sub", builder: "astBuildVarDtorCall", calls: 1, owner: "control-flow exit cleanup" }),
    Object.freeze({ file: "ast-node-scope.bas", container: "astScopeDestroyVars", kind: "sub", builder: "astBuildVarDtorCall", calls: 1, owner: "lexical-scope cleanup" }),
    Object.freeze({ file: "ast-node-mem.bas", container: "hCallDtorList", kind: "function", builder: "astBuildVarDtorCall", calls: 1, owner: "vector DELETE element cleanup" }),
    Object.freeze({ file: "ast-node-mem.bas", container: "astBuildDeleteOp", kind: "function", builder: "astBuildVarDtorCall", calls: 1, owner: "scalar DELETE object cleanup" }),
    Object.freeze({ file: "ast-misc.bas", container: "astDtorListFlush", kind: "function", builder: "astBuildVarDtorCall", calls: 1, owner: "temporary-expression cleanup" })
]);

/* Selected calls can have very different relationships to editable source.
   A named property getter has a compiler-bound identifier token; operator
   calls are anchored to syntax such as `+` or `[]`; implicit construction and
   conversion are selected from a source expression but have no callee name;
   destructor/cleanup calls are compiler-generated. Keep this inventory
   separate from call-builder counts so each new lowering route must also state
   whether it can participate in identifier-based project refactoring. */
const CALL_SOURCE_OCCURRENCES = Object.freeze({
    "parser-quirk-gfx.bas:hMaybeUdt2Ptr:astBuildCall": "implicit-source",
    "ast-node-uop.bas:astNewUOP:astBuildCall": "operator-syntax",
    "ast-node-bop.bas:hDoGlobOpOverload:astBuildCall": "operator-syntax",
    "ast-node-bop.bas:hNewSelfBOP:astBuildCall": "operator-syntax",
    "ast-node-assign.bas:hTryAssignOvl:astBuildCall": "operator-syntax",
    "ast-node-assign.bas:hTryAssignOvl:astBuildCtorCall": "implicit-source",
    "ast-node-assign.bas:hTryAssignCastOvl:astBuildCall": "implicit-source",
    "parser-compound-for.bas:hUdtCallOpOvl:astBuildCall": "operator-syntax",
    "parser-expr-unary.bas:hVarPtrBody:astBuildCall": "operator-syntax",
    "ast-node-arg.bas:hCheckParam:astBuildCall": "implicit-source",
    "ast-helper.bas:astBuildMultiDeref:astBuildCall": "operator-syntax",
    "parser-expr-variable.bas:cMemberDeref:astBuildCall": "mixed-source",
    "ast-misc.bas:hPrepareBranchExpr:astBuildCall": "implicit-source",
    "ast-node-conv.bas:astTryOvlOpCastCONV:astBuildCall": "implicit-source",
    "ast-node-conv.bas:astTryOvlStringCONV:astBuildCall": "implicit-source",
    "ast-node-conv.bas:astNewCONV:astBuildCall": "implicit-source",
    "ast-node-proc.bas:hMaybeCallResultCtor:astBuildCtorCall": "implicit-source",
    "ast-node-proc.bas:hCallCtorList:astBuildCtorCall": "implicit-source",
    "ast-node-proc.bas:hCallFieldCtor:astBuildCtorCall": "implicit-source",
    "ast-node-iif.bas:astNewIIF:astBuildCtorCall": "implicit-source",
    "ast-node-mem.bas:hCallCtorList:astBuildCtorCall": "implicit-source",
    "ast-node-mem.bas:astBuildNewOp:astBuildCtorCall": "implicit-source",
    "ast-helper.bas:astBuildImplicitCtorCallEx:astBuildImplicitCtorCall": "implicit-source",
    "ast-node-typeini.bas:hCallCtorList:astBuildCtorCall": "implicit-source",
    "ast-node-decl.bas:hCtorList:astBuildCtorCall": "implicit-source",
    "ast-node-decl.bas:hDefaultInit:astBuildCtorCall": "implicit-source",
    "ast-helper.bas:astBuildVarDtorCall:astBuildDtorCall": "compiler-generated",
    "ast-node-proc.bas:hCallCtorList:astBuildDtorCall": "compiler-generated",
    "ast-node-proc.bas:hCallFieldDtor:astBuildDtorCall": "compiler-generated",
    "ast-node-proc.bas:hCallBaseDtor:astBuildDtorCall": "compiler-generated",
    "ast-node-proc.bas:hCallStaticDtor:astBuildDtorCall": "compiler-generated",
    "parser-decl-var.bas:hEmitVarDecl:astBuildVarDtorCall": "compiler-generated",
    "ast-node-scope.bas:hDestroyBlockLocals:astBuildVarDtorCall": "compiler-generated",
    "ast-node-scope.bas:astScopeDestroyVars:astBuildVarDtorCall": "compiler-generated",
    "ast-node-mem.bas:hCallDtorList:astBuildVarDtorCall": "compiler-generated",
    "ast-node-mem.bas:astBuildDeleteOp:astBuildVarDtorCall": "implicit-source",
    "ast-misc.bas:astDtorListFlush:astBuildVarDtorCall": "compiler-generated"
});
const CALL_SOURCE_OCCURRENCE_KINDS = Object.freeze([
    "compiler-generated", "implicit-source", "mixed-source", "operator-syntax"
]);

/* The sidecar has a second call inventory beyond AST call builders: parser
   routes export constructor/destructor selections directly, while cleanup
   routes pass through semantic-model helpers. Keep both layers explicit so a
   new compiler-selected call cannot silently bypass project validation. */
const IMPLICIT_CALL_SITE_OWNERS = Object.freeze([
    Object.freeze({ file: "parser-decl-var.bas", container: "hVarInitDefault", kind: "function", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "default-constructor": 1 }, owner: "declared-variable default construction" }),
    Object.freeze({ file: "parser-decl-var.bas", container: "hBuildAutoVarInitializer", kind: "function", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "initializer-constructor": 1 }, owner: "inferred VAR initializer construction" }),
    Object.freeze({ file: "parser-decl-var.bas", container: "hEmitVarDecl", kind: "function", api: "fbSemanticModelExportImplicitCall", calls: 2, emittedKinds: { "destructor-call": 1, "redim-constructor": 1 }, owner: "declared-variable destructor and dynamic-array constructor selection" }),
    Object.freeze({ file: "parser-proccall.bas", container: "cAssignFunctResult", kind: "function", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "return-constructor": 1 }, owner: "return-value construction" }),
    Object.freeze({ file: "parser-decl-symb-init.bas", container: "hUDTInitObject", kind: "function", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "initializer-constructor": 1 }, owner: "initializer-selected construction" }),
    Object.freeze({ file: "parser-quirk-mem.bas", container: "cOperatorNew", kind: "function", api: "fbSemanticModelExportImplicitCall", calls: 3, emittedKinds: { "new-constructor": 3 }, owner: "NEW expression construction" }),
    Object.freeze({ file: "parser-quirk-mem.bas", container: "cOperatorDelete", kind: "sub", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "delete-destructor": 1 }, owner: "DELETE expression destruction" }),
    Object.freeze({ file: "parser-decl-struct.bas", container: "hFieldInit", kind: "sub", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "default-constructor": 1 }, owner: "field default construction" }),
    Object.freeze({ file: "parser-decl-struct.bas", container: "hAddAndInitField", kind: "function", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "destructor-call": 1 }, owner: "field destructor selection" }),
    Object.freeze({ file: "ast-node-scope.bas", container: "hDestroyBlockLocals", kind: "sub", api: "fbSemanticModelExportScopeExitDestructor", calls: 1, owner: "control-flow cleanup edge" }),
    Object.freeze({ file: "ast-misc.bas", container: "astDtorListFlush", kind: "function", api: "fbSemanticModelExportTemporaryDestructor", calls: 1, owner: "temporary-expression cleanup" }),
    Object.freeze({ file: "semantic-model.bas", container: "fbSemanticModelExportImplicitCall", kind: "sub", api: "hSemanticModelEmitImplicitCall", calls: 1, owner: "validated implicit-call serialization" }),
    Object.freeze({ file: "semantic-model.bas", container: "fbSemanticModelExportArgumentConstructor", kind: "sub", api: "hSemanticModelEmitImplicitCall", calls: 1, emittedKinds: { "argument-constructor": 1 }, owner: "argument-constructor serialization" }),
    Object.freeze({ file: "semantic-model.bas", container: "fbSemanticModelExportScopeExitDestructor", kind: "sub", api: "hSemanticModelEmitImplicitCall", calls: 1, emittedKinds: { "scope-exit-destructor": 1 }, owner: "scope-exit cleanup serialization" }),
    Object.freeze({ file: "semantic-model.bas", container: "fbSemanticModelExportTemporaryDestructor", kind: "sub", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "temporary-destructor": 1 }, owner: "temporary cleanup serialization" }),
    Object.freeze({ file: "semantic-model.bas", container: "fbSemanticModelExportTemporaryDestructorForRange", kind: "sub", api: "fbSemanticModelExportImplicitCall", calls: 1, emittedKinds: { "temporary-destructor": 1 }, owner: "WITH temporary lifetime serialization" })
]);

const IMPLICIT_CALL_EXPORT_APIS = Object.freeze([
    "fbSemanticModelExportImplicitCall",
    "fbSemanticModelExportScopeExitDestructor",
    "fbSemanticModelExportTemporaryDestructor",
    "hSemanticModelEmitImplicitCall"
]);
const IMPLICIT_CALL_BRIDGE_KINDS = Object.freeze(["argument-constructor"]);

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function activeFreeBasicSource(source) {
    /* The compiler retains disabled alternate overload paths in /' ... '/
       comments. They must not turn into phantom bridge obligations. */
    const withoutBlocks = source.replace(/\/'[\s\S]*?'\//g, "");
    return withoutBlocks.split(/\r?\n/).map((line) => line.slice(0, line.indexOf("'") < 0 ? line.length : line.indexOf("'"))).join("\n");
}

function containerSource(source, site) {
    const escaped = escapeRegExp(site.container);
    const startPattern = site.kind === "macro"
        ? new RegExp(`^\\s*#macro\\s+${escaped}\\b`, "gim")
        : new RegExp(`^\\s*(?:private\\s+)?${site.kind}\\s+${escaped}\\b`, "gim");
    const terminator = site.kind === "macro" ? /\n#endmacro\b/i : new RegExp(`\\nend ${site.kind}\\b`, "i");
    const containers = [];
    for (const match of source.matchAll(startPattern)) {
        const tail = source.slice(match.index);
        const endMatch = tail.match(terminator);
        if (!endMatch || endMatch.index === undefined) return null;
        containers.push(tail.slice(0, endMatch.index + endMatch[0].length));
    }
    return containers.length ? containers.join("\n") : null;
}

function countBuildCalls(source, builders = CALL_BUILDERS) {
    const names = builders.map(escapeRegExp).join("|");
    return [...activeFreeBasicSource(source).matchAll(new RegExp(`\\b(?:${names})\\s*\\(`, "gi"))].length;
}

function countCodeReferences(source, name) {
    const activeLines = activeFreeBasicSource(source).split(/\r?\n/);
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi");
    return activeLines.reduce((count, line) => {
        /* Declarations and definitions name the routine too, but do not
           represent a call edge that needs a semantic-model owner. */
        if (/^\s*(?:declare\s+(?:sub|function)|(?:private\s+)?(?:sub|function))\b/i.test(line)) return count;
        return count + [...line.matchAll(pattern)].length;
    }, 0);
}

function countLiteralKinds(source, kinds) {
    const active = activeFreeBasicSource(source);
    return Object.fromEntries(Object.keys(kinds || {}).map((kind) => [
        kind,
        [...active.matchAll(new RegExp(`"${escapeRegExp(kind)}"`, "g"))].length
    ]));
}

function auditImplicitCallRoutes(compilerDirectory) {
    const expectedByFile = new Map();
    const routes = [];
    const staleOwners = [];
    const drift = [];
    const kindDrift = [];
    const emittedKindCounts = new Map();

    for (const site of IMPLICIT_CALL_SITE_OWNERS) {
        const filePath = resolveCompilerSourcePath(compilerDirectory, site.file);
        if (!fs.existsSync(filePath)) {
            staleOwners.push(`${site.file}:${site.container}`);
            continue;
        }
        const source = containerSource(fs.readFileSync(filePath, "utf8"), site);
        if (source === null) {
            staleOwners.push(`${site.file}:${site.container}`);
            continue;
        }

        const calls = countCodeReferences(source, site.api);
        const routeKey = `${site.file}:${site.container}:${site.api}`;
        const actualKinds = countLiteralKinds(source, site.emittedKinds);
        routes.push({ routeKey, api: site.api, calls, emittedKinds: actualKinds, owner: site.owner });
        if (calls !== site.calls) drift.push(`${routeKey} expected ${site.calls}, found ${calls}`);
        for (const [kind, expected] of Object.entries(site.emittedKinds || {})) {
            if (actualKinds[kind] !== expected) kindDrift.push(`${routeKey} expected ${expected} ${kind} emission${expected === 1 ? "" : "s"}, found ${actualKinds[kind] || 0}`);
            emittedKindCounts.set(kind, (emittedKindCounts.get(kind) || 0) + expected);
        }
        expectedByFile.set(`${site.file}:${site.api}`, (expectedByFile.get(`${site.file}:${site.api}`) || 0) + site.calls);
    }

    const observedByFile = new Map();
    for (const file of compilerSourceFiles(compilerDirectory)) {
        const source = fs.readFileSync(resolveCompilerSourcePath(compilerDirectory, file), "utf8");
        for (const api of IMPLICIT_CALL_EXPORT_APIS) {
            const calls = countCodeReferences(source, api);
            if (calls > 0) observedByFile.set(`${file}:${api}`, calls);
        }
    }
    const unowned = [...observedByFile.entries()]
        .filter(([key, calls]) => calls > (expectedByFile.get(key) || 0))
        .map(([key, calls]) => `${key}: ${calls - (expectedByFile.get(key) || 0)} unowned semantic export call${calls - (expectedByFile.get(key) || 0) === 1 ? "" : "s"}`)
        .sort();
    const staleRoutes = [...expectedByFile.keys()].filter((key) => !observedByFile.has(key)).sort();

    /* Argument conversions are injected into the bridge copy of ast-node-arg
       because upstream AST nodes do not retain the argument's physical range.
       Keep that special route explicit and verify its transformation in the
       compiler-hook test, rather than pretending it exists in upstream files. */
    const bridgeSource = fs.readFileSync(path.join(__dirname, "compiler-expression-hooks.js"), "utf8");
    const missingBridgeKinds = IMPLICIT_CALL_BRIDGE_KINDS.filter((kind) => !bridgeSource.includes(kind));
    for (const kind of IMPLICIT_CALL_BRIDGE_KINDS) {
        if (!missingBridgeKinds.includes(kind)) emittedKindCounts.set(kind, (emittedKindCounts.get(kind) || 0) + 1);
    }

    const semanticModelPath = resolveCompilerSourcePath(compilerDirectory, "semantic-model.bas");
    const semanticModelSource = fs.existsSync(semanticModelPath) ? fs.readFileSync(semanticModelPath, "utf8") : "";
    const supportedSource = containerSource(semanticModelSource, {
        container: "hSemanticModelImplicitCallKindSupported",
        kind: "function"
    });
    const supportedKinds = supportedSource
        ? [...supportedSource.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]).sort()
        : [];
    const emittedKinds = [...emittedKindCounts.keys()].sort();
    const unsupportedKinds = emittedKinds.filter((kind) => !supportedKinds.includes(kind));
    const unemittedKinds = supportedKinds.filter((kind) => !emittedKindCounts.has(kind));

    return {
        routes,
        unowned,
        staleOwners: [...new Set(staleOwners)].sort(),
        staleRoutes,
        drift: drift.sort(),
        kindDrift: kindDrift.sort(),
        supportedKinds,
        emittedKinds,
        unsupportedKinds,
        unemittedKinds,
        missingBridgeKinds
    };
}

function compilerSourceFiles(compilerDirectory) {
    return listCompilerSourceFiles(compilerDirectory)
        .map((name) => path.basename(name))
        .sort();
}

function auditCallRoutes(options) {
    const compilerDirectory = path.join(options.root, "src", "compiler");
    const files = compilerSourceFiles(compilerDirectory);
    const observed = new Map();
    for (const file of files) {
        const source = fs.readFileSync(resolveCompilerSourcePath(compilerDirectory, file), "utf8");
        const calls = countBuildCalls(source);
        if (calls > 0) observed.set(file, calls);
    }

    const ownedByFile = new Map();
    const routes = [];
    const staleOwners = [];
    const drift = [];
    const observedRouteKeys = new Set();
    const unclassified = [];
    for (const site of CALL_SITE_OWNERS) {
        const filePath = resolveCompilerSourcePath(compilerDirectory, site.file);
        if (!fs.existsSync(filePath)) {
            staleOwners.push(`${site.file}:${site.container}`);
            continue;
        }
        const source = containerSource(fs.readFileSync(filePath, "utf8"), site);
        if (source === null) {
            staleOwners.push(`${site.file}:${site.container}`);
            continue;
        }
        const builder = site.builder || "astBuildCall";
        const calls = countBuildCalls(source, [builder]);
        const key = `${site.file}:${site.container}`;
        const routeKey = `${key}:${builder}`;
        observedRouteKeys.add(routeKey);
        const sourceOccurrence = CALL_SOURCE_OCCURRENCES[routeKey];
        routes.push({ key, routeKey, builder, calls, owner: site.owner, sourceOccurrence: sourceOccurrence || "" });
        if (!CALL_SOURCE_OCCURRENCE_KINDS.includes(sourceOccurrence)) unclassified.push(routeKey);
        ownedByFile.set(site.file, (ownedByFile.get(site.file) || 0) + site.calls);
        if (calls !== site.calls) drift.push(`${key} expected ${site.calls}, found ${calls}`);
    }

    const unowned = [...observed.entries()]
        .filter(([file, calls]) => calls > (ownedByFile.get(file) || 0))
        .map(([file, calls]) => `${file}: ${calls - (ownedByFile.get(file) || 0)} unowned call site${calls - (ownedByFile.get(file) || 0) === 1 ? "" : "s"}`)
        .sort();
    const staleFiles = [...ownedByFile.keys()].filter((file) => !observed.has(file)).sort();
    const staleClassifications = Object.keys(CALL_SOURCE_OCCURRENCES).filter((key) => !observedRouteKeys.has(key)).sort();
    const implicitCallRoutes = auditImplicitCallRoutes(compilerDirectory);
    return {
        files,
        routes,
        unowned,
        staleOwners: [...new Set(staleOwners)].sort(),
        staleFiles,
        drift: drift.sort(),
        unclassified: [...new Set(unclassified)].sort(),
        staleClassifications,
        implicitCallRoutes
    };
}

function main() {
    const { resolveFreeBasicRoot } = require("./audit-freebasic-coverage");
    const report = auditCallRoutes({ root: resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "") });
    console.log(JSON.stringify(report, null, 2));
    if (report.unowned.length || report.staleOwners.length || report.staleFiles.length || report.drift.length ||
        report.unclassified.length || report.staleClassifications.length ||
        report.implicitCallRoutes.unowned.length || report.implicitCallRoutes.staleOwners.length ||
        report.implicitCallRoutes.staleRoutes.length || report.implicitCallRoutes.drift.length ||
        report.implicitCallRoutes.kindDrift.length || report.implicitCallRoutes.unsupportedKinds.length ||
        report.implicitCallRoutes.unemittedKinds.length || report.implicitCallRoutes.missingBridgeKinds.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { CALL_BUILDERS, CALL_SITE_OWNERS, CALL_SOURCE_OCCURRENCES, CALL_SOURCE_OCCURRENCE_KINDS, IMPLICIT_CALL_SITE_OWNERS, IMPLICIT_CALL_EXPORT_APIS, IMPLICIT_CALL_BRIDGE_KINDS, activeFreeBasicSource, auditCallRoutes, auditImplicitCallRoutes, compilerSourceFiles, containerSource, countBuildCalls, countCodeReferences, countLiteralKinds };

/* end of audit-compiler-call-routes.js */
