/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/compiler-expression-parser-hooks.js
    Purpose: Define generic compiler expression-parser bridge hooks.
    Responsibilities: provide one shared source inventory for instrumentation
        and route-coverage auditing.
    Does not contain: compiler source rewriting or AST graph instrumentation.
*/

/* These compiler entry points either commit a written expression themselves
   or return one from a helper. The source inventory remains separate from the
   AST hooks so a compiler update cannot quietly remove a grammar route from
   the provenance audit. cProcPtrBody is instrumented by symbol hooks after
   this phase and therefore remains represented by cAddrOfExpression. */
const EXPRESSION_PARSER_HOOKS = Object.freeze({
    "parser-expr-binary.bas": ["cExpression", "cExpressionWithNIDXARRAY", "cBoolExpression", "cLogExpression", "cLogOrExpression", "cLogAndExpression", "cRelExpression", "cIsExpression", "cCatExpression", "cAddExpression", "cShiftExpression", "cModExpression", "cIntDivExpression", "cMultExpression", "cExpExpression"],
    "parser-expr-unary.bas": ["cNegNotExpression", "cStrIdxOrMemberDeref", "cHighestPrecExpr", "cDerefExpression", "cAddrOfExpression"],
    "parser-expr-atom.bas": ["cEqInParensOnlyExpr", "cGtInParensOnlyExpr", "cAtom", "cParentExpression"],
    "parser-expr-constant.bas": ["cConstant", "cStrLiteral", "cNumLiteral"],
    "parser-expr-function.bas": ["cFunctionEx", "cMethodCall"],
    "parser-expr-variable.bas": ["cFuncPtrOrMemberDeref", "cWithVariable", "cVariable", "cImplicitDataMember", "cVarOrDeref"]
});

module.exports = { EXPRESSION_PARSER_HOOKS };

/* end of compiler-expression-parser-hooks.js */
