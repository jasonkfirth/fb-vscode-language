/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/audit-compiler-expression-routes.js
    Purpose: Audit native parser routes that produce source expressions.
    Responsibilities: enumerate compiler AST parser functions and require a
        deliberate bridge ownership decision for each one.
    Does not contain: compiler instrumentation, source rewriting, or type
        inference policy.
*/

const fs = require("fs");
const path = require("path");
const { listCompilerSourceFiles, resolveCompilerSourcePath } = require("./audit-freebasic-coverage");

/*
    Some parser routines cannot use the generic wrapper because they have
    BYREF arguments, are instrumented after the generic expression pass, or
    only become a complete written expression at their enclosing quirk parser.
    Keep those decisions beside the audit rather than treating an unmatched
    compiler routine as an accidental omission.
*/
const ROUTE_OWNERS = Object.freeze({
    "parser-decl-symb-init.bas": Object.freeze({
        cInitializer: "initializer expression and construction hooks"
    }),
    "parser-decl-symbtype.bas": Object.freeze({
        cTypeOrExpression: "type-layout expression hook"
    }),
    "parser-expr-function.bas": Object.freeze({
        cFunctionCall: "procedure-call graph hook",
        cCtorCall: "constructor-call graph hook"
    }),
    "parser-expr-unary.bas": Object.freeze({
        cProcPtrBody: "procedure-pointer symbol hook"
    }),
    "parser-expr-variable.bas": Object.freeze({
        cFixedSizeArrayIndex: "cVariableEx source-emission hook",
        cUdtMember: "member source-emission hook",
        cMemberAccess: "member source-start hook",
        cMemberDeref: "member/index source-emission hook",
        cDynamicArrayIndex: "member/index source-emission hook",
        cVariableEx: "variable source-emission hook"
    }),
    "parser-proccall-args.bas": Object.freeze({
        cProcArgList: "argument expression and selected-call target handoff"
    }),
    "parser-proccall.bas": Object.freeze({
        cProcCall: "statement-call source hook"
    }),
    "parser-quirk-array.bas": Object.freeze({ cArrayFunct: "quirk parser-family hook" }),
    "parser-quirk-casting.bas": Object.freeze({ cTypeConvExpr: "quirk parser-family hook", cAnonType: "quirk parser-family hook" }),
    "parser-quirk-console.bas": Object.freeze({ cViewStmt: "quirk parser-family hook", cWidthStmt: "quirk parser-family hook", cColorStmt: "quirk parser-family hook", cScreenFunct: "quirk parser-family hook" }),
    "parser-quirk-error.bas": Object.freeze({ cErrorFunct: "quirk parser-family hook" }),
    "parser-quirk-file.bas": Object.freeze({ cFileFunct: "quirk parser-family hook" }),
    "parser-quirk-gfx.bas": Object.freeze({
        cGfxFunct: "quirk parser-family hook"
    }),
    "parser-quirk-iif.bas": Object.freeze({ cIIFFunct: "quirk parser-family hook" }),
    "parser-quirk-math.bas": Object.freeze({ cMathFunct: "quirk parser-family hook" }),
    "parser-quirk-mem.bas": Object.freeze({ cOperatorNew: "quirk parser-family hook" }),
    "parser-quirk-peekpoke.bas": Object.freeze({ cPeekFunct: "quirk parser-family hook" }),
    "parser-quirk-serialization.bas": Object.freeze({ cSerializationFunct: "quirk parser-family hook" }),
    "parser-quirk-sfx.bas": Object.freeze({ cSfxFunct: "quirk parser-family hook" }),
    "parser-quirk-string.bas": Object.freeze({
        cStrCHR: "cStringFunct parser-family hook",
        cStrASC: "cStringFunct parser-family hook",
        cCVXFunct: "cStringFunct parser-family hook",
        cMKXFunct: "cStringFunct parser-family hook",
        cStringFunct: "quirk parser-family hook"
    }),
    "parser-quirk-thread.bas": Object.freeze({ cThreadCallFunc: "quirk parser-family and call-graph hook" }),
    "parser-quirk-vafirst.bas": Object.freeze({ cVAFunct: "quirk parser-family hook", cVALISTFunct: "quirk parser-family and intrinsic-call hook" }),
    "parser-quirk.bas": Object.freeze({ cQuirkFunction: "quirk parser-family hook" })
});

/* cVariableEx has two overloads: the identifier-chain parser resolves an
   implicit or named variable, then delegates to the symbol overload that
   emits the source-linked variable record. A count change needs review because
   the bridge's hook is attached to that resolved-symbol overload. */
const EXPECTED_DEFINITION_COUNTS = Object.freeze({
    "parser-expr-variable.bas:cVariableEx": 2
});

function routeKey(file, name) {
    return `${file}:${name}`;
}

function expressionSourceFiles(compilerDirectory) {
    return listCompilerSourceFiles(compilerDirectory)
        .map((name) => path.basename(name))
        .filter((name) => /^parser-.*\.bas$/.test(name))
        .sort();
}

function parserAstRoutines(source) {
    const routines = [];
    const starts = [...source.matchAll(/^(?:private\s+)?function\s+(c[A-Za-z0-9_]+)\b/gm)];
    for (const [index, match] of starts.entries()) {
        const next = starts[index + 1]?.index ?? source.length;
        const body = source.slice(match.index, next);
        const header = body.slice(0, body.indexOf("\nend function") >= 0 ? body.indexOf("\nend function") : body.length);
        if (/\)\s+as\s+ASTNODE\s+ptr\b/i.test(header)) routines.push(match[1]);
    }
    return routines;
}

function auditExpressionRoutes(options) {
    const compilerDirectory = path.join(options.root, "src", "compiler");
    const parserHooks = options.parserHooks || {};
    const genericRoutes = new Set();
    for (const [file, names] of Object.entries(parserHooks)) for (const name of names) genericRoutes.add(routeKey(file, name));
    const ownedRoutes = new Map();
    for (const [file, names] of Object.entries(ROUTE_OWNERS)) for (const [name, owner] of Object.entries(names)) ownedRoutes.set(routeKey(file, name), owner);

    const discovered = [];
    for (const file of expressionSourceFiles(compilerDirectory)) {
        const source = fs.readFileSync(resolveCompilerSourcePath(compilerDirectory, file), "utf8");
        for (const name of parserAstRoutines(source)) discovered.push(routeKey(file, name));
    }
    discovered.sort();
    const definitionCounts = new Map();
    for (const key of discovered) definitionCounts.set(key, (definitionCounts.get(key) || 0) + 1);
    const present = new Set(definitionCounts.keys());
    const duplicateOwnership = [...genericRoutes].filter((key) => ownedRoutes.has(key)).sort();
    const unowned = discovered.filter((key) => !genericRoutes.has(key) && !ownedRoutes.has(key));
    const staleGeneric = [...genericRoutes].filter((key) => !present.has(key)).sort();
    const staleOwners = [...ownedRoutes.keys()].filter((key) => !present.has(key)).sort();
    const definitionDrift = [];
    for (const [key, expected] of Object.entries(EXPECTED_DEFINITION_COUNTS)) {
        const found = definitionCounts.get(key) || 0;
        if (found !== expected) definitionDrift.push(`${key} expected ${expected} definition${expected === 1 ? "" : "s"}, found ${found}`);
    }
    for (const [key, found] of definitionCounts) {
        if (Object.prototype.hasOwnProperty.call(EXPECTED_DEFINITION_COUNTS, key)) continue;
        if (found !== 1) definitionDrift.push(`${key} expected 1 definition, found ${found}`);
    }
    definitionDrift.sort();
    const routes = [...definitionCounts].sort(([left], [right]) => left.localeCompare(right)).map(([key, definitions]) => ({
        key,
        definitions,
        owner: genericRoutes.has(key) ? "generic parser wrapper" : ownedRoutes.get(key)
    }));

    return { files: expressionSourceFiles(compilerDirectory), routes, unowned, duplicateOwnership, staleGeneric, staleOwners, definitionDrift };
}

function main() {
    const { resolveFreeBasicRoot } = require("./audit-freebasic-coverage");
    const { EXPRESSION_PARSER_HOOKS } = require("./compiler-expression-parser-hooks");
    const report = auditExpressionRoutes({ root: resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || ""), parserHooks: EXPRESSION_PARSER_HOOKS });
    console.log(JSON.stringify(report, null, 2));
    if (report.unowned.length || report.duplicateOwnership.length || report.staleGeneric.length || report.staleOwners.length || report.definitionDrift.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { EXPECTED_DEFINITION_COUNTS, ROUTE_OWNERS, auditExpressionRoutes, expressionSourceFiles, parserAstRoutines };

/* end of audit-compiler-expression-routes.js */
