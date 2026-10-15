/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/compiler-expression-hooks.js
    Purpose: Preserve source expressions through compiler suffixes and lowering.
    Responsibilities: initialize AST annotations and hook committed transformations.
    Does not contain: compiler execution, type inference, or editor presentation.
*/

const EXPRESSION_FILES = ["ast.bi", "ast-node-call.bas", "ast-node-conv.bas", "ast-node-bop.bas", "ast-node-uop.bas", "ast-node-iif.bas", "ast-node-arg.bas", "ast-node-idx.bas", "ast-node-mem.bas", "ast-node-assign.bas", "ast-helper.bas", "ast-node-addr.bas", "ast-node-ptr.bas", "parser.bi", "parser-compound-for.bas", "parser-assignment.bas", "parser-decl-var.bas", "parser-decl-symbtype.bas", "parser-expr-variable.bas", "parser-expr-unary.bas", "parser-expr-function.bas", "parser-proccall.bas", "parser-quirk.bas", "parser-quirk-array.bas", "parser-quirk-casting.bas", "parser-quirk-console.bas", "parser-quirk-error.bas", "parser-quirk-file.bas", "parser-quirk-gfx.bas", "parser-quirk-iif.bas", "parser-quirk-math.bas", "parser-quirk-mem.bas", "parser-quirk-peekpoke.bas", "parser-quirk-serialization.bas", "parser-quirk-sfx.bas", "parser-quirk-string.bas", "parser-quirk-thread.bas", "parser-quirk-vafirst.bas"];

/* This is the compiler-source inventory of special expression parsers. Keep it
   explicit so the regression fixture and corpus report can identify a parser
   family that has not yet supplied a native expression record. */
const QUIRK_EXPRESSION_HOOKS = [
    ["parser-quirk.bas", "cQuirkFunction"],
    ["parser-quirk-array.bas", "cArrayFunct"],
    ["parser-quirk-casting.bas", "cTypeConvExpr"],
    ["parser-quirk-casting.bas", "cAnonType"],
    ["parser-quirk-console.bas", "cViewStmt"],
    ["parser-quirk-console.bas", "cWidthStmt"],
    ["parser-quirk-console.bas", "cColorStmt"],
    ["parser-quirk-console.bas", "cScreenFunct"],
    ["parser-quirk-error.bas", "cErrorFunct"],
    ["parser-quirk-file.bas", "cFileFunct"],
    ["parser-quirk-gfx.bas", "cGfxFunct"],
    ["parser-quirk-iif.bas", "cIIFFunct"],
    ["parser-quirk-math.bas", "cMathFunct"],
    ["parser-quirk-mem.bas", "cOperatorNew"],
    ["parser-quirk-peekpoke.bas", "cPeekFunct"],
    ["parser-quirk-serialization.bas", "cSerializationFunct"],
    ["parser-quirk-sfx.bas", "cSfxFunct"],
    ["parser-quirk-string.bas", "cStringFunct"],
    ["parser-quirk-string.bas", "cCVXFunct"],
    ["parser-quirk-string.bas", "cMKXFunct"],
    ["parser-quirk-thread.bas", "cThreadCallFunc"],
    ["parser-quirk-vafirst.bas", "cVAFunct"],
    ["parser-quirk-vafirst.bas", "cVALISTFunct"]
];
const QUIRK_EXPRESSION_FAMILIES = QUIRK_EXPRESSION_HOOKS.map(([, name]) => name);
/* The upstream test tree has no expression samples that execute these exact
   routes. Focused extension fixtures exercise them in compiler-analysis.test.js. */
const QUIRK_EXPRESSION_FOCUSED_FAMILIES = Object.freeze(["cViewStmt", "cScreenFunct", "cSerializationFunct", "cVAFunct"]);

/* These parser owners bypass the generic wrapper but commit complete call
   expressions through editorEmitCall(). Keep their execution visible in the
   same bounded family channel so corpus audits can distinguish ownership
   from actual reachability. */
const EXCEPTIONAL_EXPRESSION_FAMILY_HOOKS = Object.freeze([
    ["parser-expr-function.bas", "cFunctionCall"],
    ["parser-expr-function.bas", "cCtorCall"],
    ["parser-proccall.bas", "cProcCall"]
]);

/* LEN(), SIZEOF(), and TYPEOF first decide whether their written content is a
   type layout or an ordinary expression. Only the latter has an editable AST,
   and the helper returns it after cExpressionWithNIDXARRAY() has committed the
   source range. Keep that branch in the parser-route inventory. */
const TYPE_LAYOUT_EXPRESSION_HOOKS = Object.freeze({
    "parser-decl-symbtype.bas": ["cTypeOrExpression"]
});

function instrumentExpressionGraph(files, replaceOnce) {
    const result = { ...files };
    function routine(file, name, transform) {
        const source = result[file];
        const match = source.match(new RegExp(`^(?:private )?function ${name}\\b`, "m"));
        if (!match) throw new Error(`Compiler expression hook changed: ${file}: ${name}`);
        const end = source.indexOf("\nend function", match.index);
        if (end < 0) throw new Error(`Unterminated compiler expression routine: ${name}`);
        const limit = end + "\nend function".length;
        result[file] = source.slice(0, match.index) + transform(source.slice(match.index, limit)) + source.slice(limit);
    }
    function wrap(file, name, before, after) {
        routine(file, name, (source) => {
            const header = source.match(/^function[\s\S]*?\) as (?:ASTNODE ptr|integer)/)[0];
            const parameters = [...header.matchAll(/byval (\w+) as /g)].map((match) => match[1]);
            if (/byref|overload/.test(header)) throw new Error(`Unsupported expression wrapper signature: ${name}`);
            const original = `editorOriginal_${name}`;
            // Defaults remain on the public definition. Internal calls always
            // pass every argument, so their declaration needs no defaults.
            const originalHeader = header.replace(name, original).replace(/ = [A-Za-z_][A-Za-z_0-9]*/g, "");
            if (originalHeader.includes("=")) throw new Error(`Unsupported expression wrapper default: ${name}`);
            const type = header.endsWith("as integer") ? "integer" : "ASTNODE ptr";
            return `declare ${originalHeader}\n\n${header}\n${before}\n\tdim editor_result as ${type} = ${original}(${parameters.join(", ")})\n${after}\n\treturn editor_result\nend function\n\n` + source.replace(header, originalHeader);
        });
    }
    /* Several grammar productions return a completed expression without
       returning through cHighestPrecExpr. Record their exact parser family at
       the boundary that has consumed the full written construct. This makes
       corpus coverage traceable without using the family as editor policy. */
    function wrapParserFamily(file, name) {
        wrap(file, name,
            `\tdim editor_start as FBEDITORLOCATION = editorExpressionPrefix()\n\tdim editor_previous_family as string = editorExchangeExpressionFamily("${name}")`,
            "\teditorEmitExpression(editor_start, editor_result)\n\teditorExchangeExpressionFamily(editor_previous_family)");
    }
    /* cTypeOrExpression() has BYREF output parameters, so the normal parser
       wrapper cannot safely redeclare it. Its one successful expression exit
       already owns a completed AST. Exchange the route around that body and
       tag the returned node before restoring the enclosing parser family. */
    routine("parser-decl-symbtype.bas", "cTypeOrExpression", (source) => {
        source = replaceOnce(source, "\tdim as integer maybe_type = any\n", "\tdim as integer maybe_type = any\n\tdim editor_previous_family as string = editorExchangeExpressionFamily(\"cTypeOrExpression\")\n");
        source = replaceOnce(source, "\t\t\treturn NULL", "\t\t\teditorExchangeExpressionFamily(editor_previous_family)\n\t\t\treturn NULL");
        source = replaceOnce(source, "\tfunction = expr\nend function", "\teditorTagExpressionFamily(expr)\n\teditorExchangeExpressionFamily(editor_previous_family)\n\tfunction = expr\nend function");
        return source;
    });
    /* astInitNode is also used for stack-allocated sentinels. Reset annotations
       there, not only at pool allocation. astCopy deliberately copies values
       so clones retain source provenance without sharing mutable state. */
    const fields = ["identity", "kind", "start_serial", "start_byte", "end_serial", "end_byte", "dtype", "subtype", "target"];
    const annotation = "type FBEDITORAST\n" + fields.map((field) => `\t${field} as ${field === "target" ? "FBSYMBOL ptr" : "integer"}\n`).join("") + "end type\n\n";
    const physicalRange = "type FBEDITORPHYSICALRANGE\n\tsource_file as zstring * FB_MAXPATHLEN+1\n\tstart_line as integer\n\tstart_column as integer\n\tend_line as integer\n\tend_column as integer\n\tvalid as integer\nend type\n\n";
    result["ast.bi"] = replaceOnce(result["ast.bi"], "type ASTNODE\n", physicalRange + annotation + "type ASTNODE\n\teditor_source as FBEDITORAST\n\teditor_physical_source as FBEDITORPHYSICALRANGE\n");
    result["ast.bi"] = replaceOnce(result["ast.bi"], "#macro astInitNode( n, class_, dtype_, subtype_ )\n", "#macro astInitNode( n, class_, dtype_, subtype_ )\n" + fields.map((field) => `\t(n)->editor_source.${field} = 0\n`).join("") + "\t(n)->editor_physical_source.valid = FALSE\n");
    for (const file of ["ast-node-call.bas", "ast-node-addr.bas", "ast-node-ptr.bas", "ast-node-conv.bas", "ast-node-bop.bas", "ast-node-uop.bas", "ast-node-iif.bas", "ast-node-arg.bas", "ast-node-idx.bas", "ast-node-mem.bas", "ast-node-assign.bas", "ast-helper.bas", "parser-compound-for.bas", "parser-assignment.bas", "parser-quirk.bas", "parser-quirk-array.bas", "parser-quirk-casting.bas", "parser-quirk-console.bas", "parser-quirk-error.bas", "parser-quirk-file.bas", "parser-quirk-gfx.bas", "parser-quirk-iif.bas", "parser-quirk-math.bas", "parser-quirk-mem.bas", "parser-quirk-peekpoke.bas", "parser-quirk-sfx.bas", "parser-quirk-string.bas", "parser-quirk-thread.bas", "parser-quirk-vafirst.bas"]) {
        const astInclude = ['#include once "ast.bi"', '#include once "ast/ast.bi"']
            .find((includeLine) => result[file].includes(includeLine));
        if (!astInclude) throw new Error(`Compiler AST include hook changed: ${file}`);
        result[file] = replaceOnce(result[file], astInclude, `${astInclude}\n#include once "editor-api.bi"`);
    }
    const lexInclude = result["ast-node-arg.bas"].includes('#include once "core/fbint.bi"')
        ? '#include once "lexer/lex.bi"'
        : '#include once "lex.bi"';
    result["ast-node-arg.bas"] = replaceOnce(result["ast-node-arg.bas"], '#include once "editor-api.bi"', `${lexInclude}\n#include once "editor-api.bi"`);
    const nativeArgumentConstructorFacts = result["ast-node-arg.bas"].includes("fbSemanticModelExportArgumentConstructor");
    if (!nativeArgumentConstructorFacts) {
        result["ast-node-arg.bas"] = replaceOnce(result["ast-node-arg.bas"], '#include once "editor-api.bi"\n', '#include once "editor-api.bi"\ndeclare sub fbSemanticModelExportImplicitCall _\n\t( _\n\t\tbyval owner as FBSYMBOL ptr, _\n\t\tbyval target as FBSYMBOL ptr, _\n\t\tbyval call_kind as string, _\n\t\tbyref source as LEX_LOCATION _\n\t)\n');
        /* Older FBC revisions have no source-range-aware constructor receipt. */
        routine("ast-node-arg.bas", "hImplicitCtor", (source) => {
            source = replaceOnce(source, "\t'' try calling any ctor with the expression\n\trec_cnt += 1", "\tdim editor_argument_source as FBEDITORPHYSICALRANGE\n\tif( n->l <> NULL ) then editor_argument_source = n->l->editor_physical_source\n\n\t'' try calling any ctor with the expression\n\trec_cnt += 1");
            return replaceOnce(source, "\tif( is_ctorcall = FALSE ) then\n\t\t'' No implicit construction possible, n->l is not changed\n\t\texit function\n\tend if\n\n\ttmp =", "\tif( is_ctorcall = FALSE ) then\n\t\t'' No implicit construction possible, n->l is not changed\n\t\texit function\n\tend if\n\n\tif( editor_argument_source.valid andalso (arg <> NULL) ) then\n\t\tdim editor_semantic_site as LEX_LOCATION\n\t\teditor_semantic_site.source_file = editor_argument_source.source_file\n\t\teditor_semantic_site.start_line = editor_argument_source.start_line\n\t\teditor_semantic_site.start_column = editor_argument_source.start_column\n\t\teditor_semantic_site.end_line = editor_argument_source.end_line\n\t\teditor_semantic_site.end_column = editor_argument_source.end_column\n\t\teditor_semantic_site.is_physical = TRUE\n\t\tfbSemanticModelExportImplicitCall(param, astGetSymbol(arg), \"argument-constructor\", editor_semantic_site)\n\tend if\n\n\ttmp =");
        });
    }
    routine("ast-node-call.bas", "astNewCALL", (source) => replaceOnce(source, "\tn->sym = sym", "\tn->sym = sym\n\t'' Keep the resolved target until a parser wrapper can assign a complete\n\t'' written range. Runtime helpers construct their CALL before arguments.\n\tn->editor_source.target = sym"));
    // Constructor calls return a wrapper around the resolved CALL and a
    // temporary result. Preserve the resolved call's argument chain so the
    // parser can emit the written TYPE(...) range with its real constructor.
    wrap("ast-node-call.bas", "astNewCALLCTOR", "\tdim editor_source as FBEDITORAST = editorAstSource(procexpr)", "\tif( editor_result <> NULL ) then\n\t\teditor_result->editor_source = editor_source\n\t\t'' The CALLCTOR wrapper owns a resolved CALL in its left child. Keep its\n\t\t'' exact procedure identity even when a quirk parser replaced the CALL's\n\t\t'' temporary source annotation before the enclosing expression is emitted.\n\t\tif( procexpr <> NULL ) then editor_result->editor_source.target = procexpr->sym\n\tend if");
    const nativeSemanticMemoryOperations = result["parser-quirk-mem.bas"]
        .includes("fbSemanticModelExportOperation(semantic_operator,");
    /* The parser owns the written NEW/DELETE range, while ast-node-mem owns
       overload selection and immediately lowers the selected CALL into a
       larger allocation/deallocation tree. Add an optional output only for
       the editor build, so parser-quirk-mem can retain a real user-defined
       allocation operator without treating Allocate/Deallocate as source
       calls. Compilers with native physical operation receipts already provide
       the same fact through their semantic model, so the bridge must not add a
       duplicate lowering hook for those versions. */
    if (!nativeSemanticMemoryOperations) {
        result["ast.bi"] = replaceOnce(result["ast.bi"], "\t\tbyval newexpr as ASTNODE ptr _\n\t) as ASTNODE ptr\n\ndeclare function astBuildDeleteOp", "\t\tbyval newexpr as ASTNODE ptr, _\n\t\tbyval editor_target as FBSYMBOL ptr ptr = NULL _\n\t) as ASTNODE ptr\n\ndeclare function astBuildDeleteOp");
        result["ast.bi"] = replaceOnce(result["ast.bi"], "\t\tbyval ptrexpr as ASTNODE ptr _\n\t) as ASTNODE ptr", "\t\tbyval ptrexpr as ASTNODE ptr, _\n\t\tbyval editor_target as FBSYMBOL ptr ptr = NULL, _\n\t\tbyval editor_dtor_target as FBSYMBOL ptr ptr = NULL _\n\t) as ASTNODE ptr");
        routine("ast-node-mem.bas", "astBuildNewOp", (source) => {
            source = replaceOnce(source, "\t\tbyval newexpr as ASTNODE ptr _\n\t) as ASTNODE ptr", "\t\tbyval newexpr as ASTNODE ptr, _\n\t\tbyval editor_target as FBSYMBOL ptr ptr _\n\t) as ASTNODE ptr");
            source = replaceOnce(source, "\tdim as FBSYMBOL ptr exitlabel = any", "\tdim as FBSYMBOL ptr exitlabel = any, editor_selected = NULL\n\tif( editor_target <> NULL ) then *editor_target = NULL");
            source = replaceOnce(source, "\t\tnewexpr = rtlMemNewOp( op, lenexpr, dtype, subtype, do_clear )\n\t\tif( newexpr = NULL ) then", "\t\tnewexpr = rtlMemNewOp( op, lenexpr, dtype, subtype, do_clear )\n\t\t'' Preserve only the source language's custom allocator. The ordinary\n\t\t'' Allocate/Callocate fallback is an implementation detail, not a call\n\t\t'' the user wrote. This matches rtlMemNewOp()'s selection condition.\n\t\tif( typeGet( dtype ) = FB_DATATYPE_STRUCT ) then\n\t\t\teditor_selected = symbGetCompOpOvlHead( subtype, astGetOpSelfVer( op ) )\n\t\tend if\n\t\tif( newexpr = NULL ) then");
            return replaceOnce(source, "\tfunction = tree\nend function", "\tif( editor_target <> NULL ) then *editor_target = editor_selected\n\tfunction = tree\nend function");
        });
        routine("ast-node-mem.bas", "astBuildDeleteOp", (source) => {
            source = replaceOnce(source, "\t\tbyval ptrexpr as ASTNODE ptr _\n\t) as ASTNODE ptr", "\t\tbyval ptrexpr as ASTNODE ptr, _\n\t\tbyval editor_target as FBSYMBOL ptr ptr, _\n\t\tbyval editor_dtor_target as FBSYMBOL ptr ptr _\n\t) as ASTNODE ptr");
            source = replaceOnce(source, "\tdim as FBSYMBOL ptr label = any, subtype = any", "\tdim as FBSYMBOL ptr label = any, subtype = any, editor_selected = NULL\n\tif( editor_target <> NULL ) then *editor_target = NULL\n\tif( editor_dtor_target <> NULL ) then *editor_dtor_target = NULL");
            source = replaceOnce(source, "\t'' call dtors?\n\tif( typeNeedsDtorCall( dtype, subtype ) ) then", "\t'' call dtors?\n\tif( typeNeedsDtorCall( dtype, subtype ) ) then\n\t\t'' Keep the statically selected destructor. A virtual call still uses\n\t\t'' this compiler target as its vtable entry.\n\t\tif( editor_dtor_target <> NULL andalso typeGet( dtype ) = FB_DATATYPE_STRUCT ) then\n\t\t\t*editor_dtor_target = symbGetCompDtor1( subtype )\n\t\tend if");
            source = replaceOnce(source, "\t'' delete( ptr )\n\ttree = astNewLINK( tree, rtlMemDeleteOp( op, ptrexpr, dtype, subtype ), AST_LINK_RETURN_NONE )", "\t'' delete( ptr )\n\t'' Keep the custom member operator distinct from the Deallocate fallback.\n\t'' It is selected by the same condition in rtlMemDeleteOp().\n\tif( typeGet( dtype ) = FB_DATATYPE_STRUCT ) then\n\t\teditor_selected = symbGetCompOpOvlHead( subtype, astGetOpSelfVer( op ) )\n\tend if\n\ttree = astNewLINK( tree, rtlMemDeleteOp( op, ptrexpr, dtype, subtype ), AST_LINK_RETURN_NONE )");
            return replaceOnce(source, "\tfunction = tree\nend function", "\tif( editor_target <> NULL ) then *editor_target = editor_selected\n\tfunction = tree\nend function");
        });
    }
    /* A source assignment reaches hTryAssignOvl() before the selected LET
       operator is hidden inside a generated LINK tree. Retain that tree's
       call annotation, then let cAssignment() give the construct its full
       written span. Compiler-created assignments have no parser boundary and
       deliberately remain absent from the source graph. */
    routine("ast-node-assign.bas", "hTryAssignOvl", (source) => {
        source = replaceOnce(source, "\tdim as FBSYMBOL ptr proc = any", "\tdim as ASTNODE ptr editor_call\n\tdim as FBSYMBOL ptr proc = any");
        return replaceOnce(source, "\t\t\tresult = astNewLINK( result, astBuildCall( proc, l, r ), AST_LINK_RETURN_NONE )", "\t\t\teditor_call = astBuildCall( proc, l, r )\n\t\t\tresult = astNewLINK( result, editor_call, AST_LINK_RETURN_NONE )\n\t\t\t'' astBuildCall() records both written operands and the selected LET\n\t\t\t'' target. Its trace record does not retain the raw pointer, so carry\n\t\t\t'' that pointer through the generated link until cAssignment() commits\n\t\t\t'' the complete source assignment range.\n\t\t\tif( result <> NULL ) then\n\t\t\t\tresult->editor_source = editorAstSource(editor_call)\n\t\t\t\tresult->editor_source.target = proc\n\t\t\tend if");
    });
    let assignmentSource = result["parser-assignment.bas"];
    const assignmentStart = [
        "sub cAssignment( byval l as ASTNODE ptr )\n",
        "sub cAssignment( byval l as ASTNODE ptr, byval source_start as LEX_LOCATION ptr )\n"
    ].find((signature) => assignmentSource.includes(signature));
    if (!assignmentStart) throw new Error("Compiler assignment expression hook changed.");
    assignmentSource = replaceOnce(assignmentSource, assignmentStart,
        assignmentStart + "\tdim editor_start as FBEDITORLOCATION = editorAstStart(l)\n");
    const selfBopAnchors = [
        "\t\tl = astNewSelfBOPWithOperands( op, l, r, NULL, AST_OPOPT_LPTRARITH, semantic_operands )\n\t\tif (l) then\n\t\t\tfbSemanticModelAcceptAssignmentInputs(semantic_inputs, l, astGetOpSelfVer(op), \"compound\", semantic_site, semantic_operands, @semantic_destination)\n\t\t\tfbSemanticModelExportOperation(l, op, semantic_site)\n\t\t\tastAdd(l)",
        "\t\tl = astNewSelfBOPWithOperands( op, l, r, NULL, AST_OPOPT_LPTRARITH, semantic_operands )\n\t\tif (l) then\n\t\t\tfbSemanticModelExportOperation(l, op, semantic_site)\n\t\t\tastAdd(l)",
        "\t\tl = astNewSelfBOP( op, l, r, NULL, AST_OPOPT_LPTRARITH )\n\t\tif (l) then\n\t\t\tastAdd(l)",
        "\t\tl = astNewSelfBOP( op, l, r, NULL, AST_OPOPT_LPTRARITH )\n\t\tif (l) then\n\t\t\tfbSemanticModelExportOperation(l, op, semantic_site)\n\t\t\tastAdd(l)"
    ];
    const selfBopAnchor = selfBopAnchors.find((anchor) => assignmentSource.includes(anchor));
    if (!selfBopAnchor) throw new Error("Compiler self-assignment expression hook changed.");
    assignmentSource = replaceOnce(assignmentSource, selfBopAnchor,
        selfBopAnchor.replace("\t\t\tastAdd(l)", "\t\t\tdim editor_source as FBEDITORAST = editorAstSource(l)\n\t\t\tif( editor_source.target <> NULL ) then editorEmitCall(editor_start, l, editor_source.target, 0, TRUE)\n\t\t\tastAdd(l)"));
    const assignAnchors = [
        "\t\tl = astNewASSIGN( l, r )\n\t\tif (l) then\n\t\t\tfbSemanticModelAcceptAssignmentInputs(semantic_inputs, l, AST_OP_ASSIGN, \"copy\", semantic_site, 0, @semantic_destination)\n\t\t\tfbSemanticModelAssignmentTarget(semantic_rhs, semantic_target, semantic_dtype, semantic_subtype, \"assignment\")\n\t\t\tfbSemanticModelExportOperation(l, AST_OP_ASSIGN, semantic_site)\n\t\t\tastAdd(l)",
        "\t\tl = astNewASSIGN( l, r )\n\t\tif (l) then\n\t\t\tfbSemanticModelAssignmentTarget(semantic_rhs, semantic_dtype, semantic_subtype, \"assignment\")\n\t\t\tfbSemanticModelExportOperation(l, AST_OP_ASSIGN, semantic_site)\n\t\t\tastAdd(l)",
        "\t\tl = astNewASSIGN( l, r )\n\t\tif (l) then\n\t\t\tastAdd(l)",
        "\t\tl = astNewASSIGN( l, r )\n\t\tif (l) then\n\t\t\tfbSemanticModelExportOperation(l, AST_OP_ASSIGN, semantic_site)\n\t\t\tastAdd(l)"
    ];
    const assignAnchor = assignAnchors.find((anchor) => assignmentSource.includes(anchor));
    if (!assignAnchor) throw new Error("Compiler assignment expression hook changed.");
    assignmentSource = replaceOnce(assignmentSource, assignAnchor,
        assignAnchor.replace("\t\t\tastAdd(l)", "\t\t\tdim editor_source as FBEDITORAST = editorAstSource(l)\n\t\t\tif( editor_source.target <> NULL ) then editorEmitCall(editor_start, l, editor_source.target, 0, TRUE)\n\t\t\tastAdd(l)"));
    result["parser-assignment.bas"] = assignmentSource;
    /* FOR/NEXT keeps its values in a compound-statement stack while the
       compiler creates calls to the iterator operators later. Store only
       value annotations and byte locations in that stack: no AST pointers
       survive past the parse phase, and no editor data changes loop lowering. */
    result["parser.bi"] = replaceOnce(result["parser.bi"], "type FB_CMPSTMT_FOR\n\touterscopenode  as ASTNODE ptr", "type FB_CMPSTMT_FOR\n\touterscopenode  as ASTNODE ptr\n\teditor_for_serial as integer\n\teditor_for_byte as integer\n\teditor_next_serial as integer\n\teditor_next_byte as integer\n\teditor_counter as FBEDITORAST\n\teditor_end as FBEDITORAST\n\teditor_step as FBEDITORAST");
    let forSource = result["parser-compound-for.bas"];
    const nativeIteratorOperations = forSource.includes("fbSemanticModelExportOperation(proc, AST_OP_FOR,");
    forSource = replaceOnce(forSource, "\t\tbyval second_arg as ASTNODE ptr, _\n\t\tbyval third_arg as ASTNODE ptr = NULL _", "\t\tbyval second_arg as ASTNODE ptr, _\n\t\tbyval third_arg as ASTNODE ptr = NULL, _\n\t\tbyval editor_target as FBSYMBOL ptr ptr = NULL _");
    forSource = replaceOnce(forSource, "'':::::\nprivate sub hUdtFor", "'' The loop parser stores source values in a persistent stack before it\n'' resolves the three iterator operators. Recreate only source-level graph\n'' edges here, after overload selection, without retaining any AST pointer.\nprivate sub editorEmitIteratorCall _\n\t( _\n\t\tbyval proc as ASTNODE ptr, _\n\t\tbyval target as FBSYMBOL ptr, _\n\t\tbyval serial as integer, _\n\t\tbyval byte_column as integer, _\n\t\tbyref first as FBEDITORAST, _\n\t\tbyref second as FBEDITORAST, _\n\t\tbyref third as FBEDITORAST _\n\t)\n\n\tif( proc = NULL orelse target = NULL orelse serial <= 0 ) then exit sub\n\tdim site as FBEDITORLOCATION\n\tsite.output_line = serial\n\tsite.byte_column = byte_column\n\teditorEmitTransform(\"call\", proc, first, second, third, target, 2)\n\teditorEmitCall(site, proc, target, 0, TRUE)\nend sub\n\n'':::::\nprivate sub hUdtFor");
    const udtForStart = forSource.indexOf("private sub hUdtFor");
    const udtForEnd = forSource.indexOf("\nend sub", udtForStart) + "\nend sub".length;
    if (udtForStart < 0 || udtForEnd < "\nend sub".length) throw new Error("Compiler iterator FOR hook changed.");
    let udtForSource = forSource.slice(udtForStart, udtForEnd);
    udtForSource = replaceOnce(udtForSource, "\tdim as ASTNODE ptr proc = any, step_expr = NULL\n\n\t'' only pass the step arg if it's an explicit step", "\tdim as ASTNODE ptr proc = any, step_expr = NULL\n\tdim as FBSYMBOL ptr editor_target = NULL\n\tdim editor_empty as FBEDITORAST\n\n\t'' only pass the step arg if it's an explicit step");
    if (nativeIteratorOperations) {
        udtForSource = replaceOnce(udtForSource, "\t                      hElmToExpr( @stk->for.cnt ), _\n\t                      step_expr )", "\t                      hElmToExpr( @stk->for.cnt ), _\n\t                      step_expr, NULL, @editor_target )");
        udtForSource = replaceOnce(udtForSource, "\tif( proc <> NULL ) then\n\t\tfbSemanticModelExportOperation(proc, AST_OP_FOR, stk->for.semantic_for_site)", "\tif( proc <> NULL ) then\n\t\teditorEmitIteratorCall(proc, editor_target, stk->for.editor_for_serial, stk->for.editor_for_byte, _\n\t\t                       stk->for.editor_counter, stk->for.editor_step, editor_empty)\n\t\tfbSemanticModelExportOperation(proc, AST_OP_FOR, stk->for.semantic_for_site)");
    } else {
        udtForSource = replaceOnce(udtForSource, "\t                      hElmToExpr( @stk->for.cnt ), _\n\t                      step_expr )\n\n\tif( proc <> NULL ) then\n\t\tastAdd( proc )", "\t                      hElmToExpr( @stk->for.cnt ), _\n\t                      step_expr, NULL, @editor_target )\n\n\tif( proc <> NULL ) then\n\t\teditorEmitIteratorCall(proc, editor_target, stk->for.editor_for_serial, stk->for.editor_for_byte, _\n\t\t                       stk->for.editor_counter, stk->for.editor_step, editor_empty)\n\t\tastAdd( proc )");
    }
    forSource = forSource.slice(0, udtForStart) + udtForSource + forSource.slice(udtForEnd);
    const stepStart = forSource.indexOf("private sub hUdtStep");
    const stepEnd = forSource.indexOf("\nend sub", stepStart) + "\nend sub".length;
    if (stepStart < 0 || stepEnd < "\nend sub".length) throw new Error("Compiler iterator STEP hook changed.");
    let stepSource = forSource.slice(stepStart, stepEnd);
    stepSource = replaceOnce(stepSource, "\tdim as ASTNODE ptr proc = any, step_expr = NULL\n\n\t'' only pass the step arg if it's an explicit step", "\tdim as ASTNODE ptr proc = any, step_expr = NULL\n\tdim as FBSYMBOL ptr editor_target = NULL\n\tdim editor_empty as FBEDITORAST\n\n\t'' only pass the step arg if it's an explicit step");
    if (nativeIteratorOperations) {
        stepSource = replaceOnce(stepSource, "\t                      hElmToExpr( @stk->for.cnt ), _\n\t                      step_expr )", "\t                      hElmToExpr( @stk->for.cnt ), _\n\t                      step_expr, NULL, @editor_target )");
        stepSource = replaceOnce(stepSource, "\tif( proc <> NULL ) then\n\t\tif( stk->for.explicit_step ) then", "\tif( proc <> NULL ) then\n\t\teditorEmitIteratorCall(proc, editor_target, stk->for.editor_next_serial, stk->for.editor_next_byte, _\n\t\t                       stk->for.editor_counter, stk->for.editor_step, editor_empty)\n\t\tif( stk->for.explicit_step ) then");
    } else {
        stepSource = replaceOnce(stepSource, "\t                      hElmToExpr( @stk->for.cnt ), _\n\t                      step_expr )\n\n\tif( proc <> NULL ) then\n\t\tastAdd( proc )", "\t                      hElmToExpr( @stk->for.cnt ), _\n\t                      step_expr, NULL, @editor_target )\n\n\tif( proc <> NULL ) then\n\t\teditorEmitIteratorCall(proc, editor_target, stk->for.editor_next_serial, stk->for.editor_next_byte, _\n\t\t                       stk->for.editor_counter, stk->for.editor_step, editor_empty)\n\t\tastAdd( proc )");
    }
    forSource = forSource.slice(0, stepStart) + stepSource + forSource.slice(stepEnd);
    const nextStart = forSource.indexOf("private sub hUdtNext");
    const nextEnd = forSource.indexOf("\nend sub", nextStart) + "\nend sub".length;
    if (nextStart < 0 || nextEnd < "\nend sub".length) throw new Error("Compiler iterator NEXT hook changed.");
    let nextSource = forSource.slice(nextStart, nextEnd);
    nextSource = replaceOnce(nextSource, "\tdim as ASTNODE ptr proc = any, step_expr = NULL\n\n\t'' only pass the step arg if it's an explicit step", "\tdim as ASTNODE ptr proc = any, step_expr = NULL\n\tdim as FBSYMBOL ptr editor_target = NULL\n\n\t'' only pass the step arg if it's an explicit step");
    if (nativeIteratorOperations) {
        nextSource = replaceOnce(nextSource, "\t                      hElmToExpr( @stk->for.end ), _\n\t                      step_expr )", "\t                      hElmToExpr( @stk->for.end ), _\n\t                      step_expr, @editor_target )");
        nextSource = replaceOnce(nextSource, "\tif( proc <> NULL ) then\n\t\tfbSemanticModelExportOperation(proc, AST_OP_NEXT, stk->for.semantic_next_site)", "\tif( proc <> NULL ) then\n\t\teditorEmitIteratorCall(proc, editor_target, stk->for.editor_next_serial, stk->for.editor_next_byte, _\n\t\t                       stk->for.editor_counter, stk->for.editor_end, stk->for.editor_step)\n\t\tfbSemanticModelExportOperation(proc, AST_OP_NEXT, stk->for.semantic_next_site)");
    } else {
        nextSource = replaceOnce(nextSource, "\t                      hElmToExpr( @stk->for.end ), _\n\t                      step_expr )\n\n\tif( proc <> NULL ) then", "\t                      hElmToExpr( @stk->for.end ), _\n\t                      step_expr, @editor_target )\n\n\tif( proc <> NULL ) then\n\t\teditorEmitIteratorCall(proc, editor_target, stk->for.editor_next_serial, stk->for.editor_next_byte, _\n\t\t                       stk->for.editor_counter, stk->for.editor_end, stk->for.editor_step)");
    }
    forSource = forSource.slice(0, nextStart) + nextSource + forSource.slice(nextEnd);
    forSource = replaceOnce(forSource, "\t\tbyval third_arg as ASTNODE ptr _\n\t) as ASTNODE ptr\n\n\tdim as FBSYMBOL ptr sym = any", "\t\tbyval third_arg as ASTNODE ptr, _\n\t\tbyval editor_target as FBSYMBOL ptr ptr _\n\t) as ASTNODE ptr\n\n\tdim as FBSYMBOL ptr sym = any\n\tif( editor_target <> NULL ) then *editor_target = NULL");
    forSource = replaceOnce(forSource, "\tfunction = astBuildCall( sym, inst_expr, second_arg, third_arg )", "\tif( editor_target <> NULL ) then *editor_target = sym\n\tfunction = astBuildCall( sym, inst_expr, second_arg, third_arg )");
    forSource = replaceOnce(forSource, "sub cForStmtBegin( )\n\tdim as FOR_FLAGS flags = 0", "sub cForStmtBegin( )\n\tdim as FBEDITORLOCATION editor_for_start = editorNextToken()\n\tdim as FOR_FLAGS flags = 0");
    if (nativeIteratorOperations) {
        forSource = replaceOnce(forSource, "\tif( stk <> NULL ) then stk->for.semantic_for_site = semantic_for_site", "\tif( stk <> NULL ) then stk->for.semantic_for_site = semantic_for_site\n\tstk->for.editor_for_serial = editor_for_start.output_line\n\tstk->for.editor_for_byte = editor_for_start.byte_column\n\tstk->for.editor_next_serial = 0\n\tstk->for.editor_next_byte = 0\n\tstk->for.editor_counter = editorAstSource(idexpr)\n\tstk->for.editor_end.identity = 0\n\tstk->for.editor_step.identity = 0");
    } else {
        forSource = replaceOnce(forSource, "\tdim as FB_CMPSTMTSTK ptr stk = cCompStmtPush( FB_TK_FOR )\n\n\t'' extract counter variable", "\tdim as FB_CMPSTMTSTK ptr stk = cCompStmtPush( FB_TK_FOR )\n\tstk->for.editor_for_serial = editor_for_start.output_line\n\tstk->for.editor_for_byte = editor_for_start.byte_column\n\tstk->for.editor_next_serial = 0\n\tstk->for.editor_next_byte = 0\n\tstk->for.editor_counter = editorAstSource(idexpr)\n\tstk->for.editor_end.identity = 0\n\tstk->for.editor_step.identity = 0\n\n\t'' extract counter variable");
    }
    const forToStart = forSource.indexOf("private sub hForTo");
    const forToEnd = forSource.indexOf("\nend sub", forToStart) + "\nend sub".length;
    if (forToStart < 0 || forToEnd < "\nend sub".length) throw new Error("Compiler FOR TO source hook changed.");
    let forToSource = forSource.slice(forToStart, forToEnd);
    forToSource = replaceOnce(forToSource, "\t\tdim as ASTNODE ptr expr = cExpression( )\n\t\tif( expr = NULL ) then", "\t\tdim as ASTNODE ptr expr = cExpression( )\n\t\tstk->for.editor_end = editorAstSource(expr)\n\t\tif( expr = NULL ) then");
    forToSource = replaceOnce(forToSource, "\t\tif( hCallCtor( stk->for.end.sym ) = FALSE ) then", "\t\tif( hCallCtor( stk->for.end.sym, @stk->for.editor_end ) = FALSE ) then");
    forSource = forSource.slice(0, forToStart) + forToSource + forSource.slice(forToEnd);
    const forStepStart = forSource.indexOf("private sub hForStep");
    const forStepEnd = forSource.indexOf("\nend sub", forStepStart) + "\nend sub".length;
    if (forStepStart < 0 || forStepEnd < "\nend sub".length) throw new Error("Compiler FOR STEP source hook changed.");
    let forStepSource = forSource.slice(forStepStart, forStepEnd);
    forStepSource = replaceOnce(forStepSource, "\t\t\texpr = cExpression( )\n\t\t\tif( expr = NULL ) then", "\t\t\texpr = cExpression( )\n\t\t\tstk->for.editor_step = editorAstSource(expr)\n\t\t\tif( expr = NULL ) then");
    forStepSource = replaceOnce(forStepSource, "\t\t\tif( hCallCtor( stk->for.stp.sym ) = FALSE ) then", "\t\t\tif( hCallCtor( stk->for.stp.sym, @stk->for.editor_step ) = FALSE ) then");
    forSource = forSource.slice(0, forStepStart) + forStepSource + forSource.slice(forStepEnd);
    const forAssignStart = forSource.indexOf("private sub hForAssign");
    const forAssignEnd = forSource.indexOf("\nend sub", forAssignStart) + "\nend sub".length;
    if (forAssignStart < 0 || forAssignEnd < "\nend sub".length) throw new Error("Compiler FOR assignment source hook changed.");
    let forAssignSource = forSource.slice(forAssignStart, forAssignEnd);
    forAssignSource = replaceOnce(forAssignSource, "\t\tif( hCallCtor( stk->for.cnt.sym ) = FALSE ) then", "\t\tif( hCallCtor( stk->for.cnt.sym, NULL ) = FALSE ) then");
    forSource = forSource.slice(0, forAssignStart) + forAssignSource + forSource.slice(forAssignEnd);
    forSource = replaceOnce(forSource, "private function hCallCtor( byval sym as FBSYMBOL ptr ) as integer\n\tdim as ASTNODE ptr expr = cInitializer( sym, FB_INIOPT_ISINI )", "private function hCallCtor( byval sym as FBSYMBOL ptr, byval editor_source as FBEDITORAST ptr ) as integer\n\tdim editor_start as FBEDITORLOCATION\n\tif( editor_source <> NULL ) then\n\t\teditor_source->identity = 0\n\t\teditor_start = editorNextToken()\n\tend if\n\tdim as ASTNODE ptr expr = cInitializer( sym, FB_INIOPT_ISINI )");
    forSource = replaceOnce(forSource, "\tif( expr = NULL ) then\n\t\texit function\n\tend if\n\n\texpr = astTypeIniFlush", "\tif( expr = NULL ) then\n\t\texit function\n\tend if\n\tif( editor_source <> NULL ) then\n\t\teditorEmitExpression(editor_start, expr)\n\t\t*editor_source = editorAstSource(expr)\n\tend if\n\n\texpr = astTypeIniFlush");
    if (nativeIteratorOperations) {
        forSource = replaceOnce(forSource, "sub cForStmtEnd( )\n\tdim as FB_CMPSTMTSTK ptr stk = any\n\tdim as LEX_LOCATION semantic_next_site = lexGetCurrentLocation( )", "sub cForStmtEnd( )\n\tdim as FB_CMPSTMTSTK ptr stk = any\n\tdim as LEX_LOCATION semantic_next_site = lexGetCurrentLocation( )\n\tdim as FBEDITORLOCATION editor_next = editorNextToken()");
    } else {
        forSource = replaceOnce(forSource, "sub cForStmtEnd( )\n\tdim as FB_CMPSTMTSTK ptr stk = any\n\n\t'' NEXT", "sub cForStmtEnd( )\n\tdim as FB_CMPSTMTSTK ptr stk = any\n\tdim as FBEDITORLOCATION editor_next = editorNextToken()\n\n\t'' NEXT");
    }
    forSource = replaceOnce(forSource, "\t\thForStmtClose( stk )", "\t\tstk->for.editor_next_serial = editor_next.output_line\n\t\tstk->for.editor_next_byte = editor_next.byte_column\n\t\thForStmtClose( stk )");
    result["parser-compound-for.bas"] = forSource;
    routine("parser-decl-var.bas", "hEmitVarDecl", (source) => {
        source = replaceOnce(source,
            "\t\tbyref varexpr as ASTNODE ptr, _\n\t\texprTB() as ASTNODE ptr, _",
            "\t\tbyref varexpr as ASTNODE ptr, _\n\t\tbyref editor_declaration_site as FBEDITORLOCATION, _\n\t\texprTB() as ASTNODE ptr, _");
        const defaultInitializers = [...source.matchAll(/^(\s*)initree = hVarInitDefault\( sym, is_declared, has_defctor, semantic_site \)$/gm)];
        if (defaultInitializers.length !== 2) throw new Error("Compiler declaration default-initializer routes changed.");
        return source.replace(/^(\s*)initree = hVarInitDefault\( sym, is_declared, has_defctor, semantic_site \)$/gm,
            "$&\n$1if( initree <> NULL and has_defctor ) then editorEmitImplicitDeclarationCall(editor_declaration_site, symbGetFullType(sym), symbGetSubtype(sym), symbGetCompDefCtor(symbGetSubtype(sym)))");
    });
    routine("parser-decl-var.bas", "cVarDecl", (source) => {
        const declaration = [
            "\tdim as LEX_LOCATION semantic_site\n",
            "\tdim as LEX_LOCATION semantic_site, diagnostic_site\n"
        ].find((anchor) => source.includes(anchor));
        if (!declaration) throw new Error("Compiler declaration expression hook changed.");
        source = replaceOnce(source, declaration,
            declaration + "\tdim as FBEDITORLOCATION editor_site\n");
        source = replaceOnce(source,
            "\t\t\tsemantic_site = lexGetCurrentLocation( )\n",
            "\t\t\tsemantic_site = lexGetCurrentLocation( )\n\t\t\teditor_site = editorNextToken()\n");
        const selectedArguments = "have_bounds, varexpr, exprTB(), dopreserve, semantic_site, semantic_initializer )";
        const legacyArguments = "have_bounds, varexpr, exprTB(), dopreserve, semantic_site )";
        if (source.includes(selectedArguments)) {
            return replaceOnce(source, selectedArguments,
                "have_bounds, varexpr, editor_site, exprTB(), dopreserve, semantic_site, semantic_initializer )");
        }
        return replaceOnce(source, legacyArguments,
            "have_bounds, varexpr, editor_site, exprTB(), dopreserve, semantic_site )");
    });
    for (const [file, name] of [["ast-node-addr.bas", "astNewADDROF"], ["ast-node-ptr.bas", "astNewDEREF"]]) {
        wrap(file, name, "\tdim editor_source as FBEDITORAST = editorAstSource(l)", "\tif( editor_result <> NULL ) then editor_result->editor_source = editor_source");
    }
    // astNewIDX commits fixed-array address calculations. Preserve both
    // written operands before lowering turns them into a scaled pointer.
    wrap("ast-node-idx.bas", "astNewIDX", "\tdim editor_receiver as FBEDITORAST = editorAstSource(var_)\n\tdim editor_index as FBEDITORAST = editorAstSource(idx)", "\tif( editor_result <> NULL ) then editorEmitIndex(editor_result, editor_receiver, editor_index)");
    wrap("ast-node-conv.bas", "astNewCONV", "\tdim editor_first as FBEDITORAST = editorAstSource(l)\n\tdim editor_empty as FBEDITORAST", "\tdim editor_lowered as FBEDITORAST = editorAstSource(editor_result)\n\tif( editor_result <> NULL and editor_first.identity <> 0 ) then\n\t\tif( editor_first.dtype <> astGetFullType(editor_result) or editor_first.subtype <> editorSymbolId(astGetSubtype(editor_result)) ) then\n\t\t\t'' An overloaded cast returns an already-recorded CALL. Keep that\n\t\t\t'' lowering as a conversion dependency instead of disconnecting the\n\t\t\t'' compiler-selected conversion operator from its written operand.\n\t\t\teditorEmitTransform(\"conversion\", editor_result, editor_first, editor_empty, editor_lowered, NULL, options)\n\t\tend if\n\tend if\n\t'' A quirk function can lower a selected runtime call through a conversion.\n\t'' Retain that target until cAtom has its complete written call range.\n\tif( editor_result <> NULL and editor_first.target <> NULL ) then editor_result->editor_source.target = editor_first.target");
    /* astNewBOP/UOP may consume either operand during constant folding. Copy
       annotations before entry and retain any call/conversion produced inside
       the operation as a separate lowering dependency. Never follow the old
       operand pointers after the original compiler function returns. */
    const binaryBefore = "\tdim editor_first as FBEDITORAST = editorAstSource(l)\n\tdim editor_second as FBEDITORAST = editorAstSource(r)";
    const binaryAfter = "\tdim editor_lowered as FBEDITORAST = editorAstSource(editor_result)\n\teditorEmitTransform(\"binary\", editor_result, editor_first, editor_second, editor_lowered, NULL, op)\n\t'' The backend can lower one written operator into a runtime helper call.\n\tif( editor_result <> NULL and editor_lowered.target <> NULL ) then editor_result->editor_source.target = editor_lowered.target";
    wrap("ast-node-bop.bas", "astNewBOP", binaryBefore, binaryAfter);
    /* Current fbc routes parser-selected operations through this overload so
       their semantic operand IDs survive constant folding. Instrument the
       committed AST result too, otherwise the editor graph loses precisely
       those prefixes and lowered assignment values. */
    if (result["ast-node-bop.bas"].includes("function astNewBOPWithOperands")) {
        wrap("ast-node-bop.bas", "astNewBOPWithOperands", binaryBefore, binaryAfter);
    }
    /* Combined assignments bypass the ordinary expression boundary. Their
       operand-aware and legacy entry points share hNewSelfBOP(), which keeps
       the selected target until cAssignment() commits the written range. */
    routine("ast-node-bop.bas", "hNewSelfBOP", (source) => {
        return replaceOnce(source,
            "\t\tdim as ASTNODE ptr result = astBuildCall( proc, l, r )\n\t\tfbSemanticModelCompoundResult(result, semantic_operands)\n\t\treturn result",
            "\t\tdim as ASTNODE ptr result = astBuildCall( proc, l, r )\n\t\tfbSemanticModelCompoundResult(result, semantic_operands)\n\t\tif( result <> NULL ) then result->editor_source.target = proc\n\t\treturn result");
    });
    wrap("ast-node-uop.bas", "astNewUOP", "\tdim editor_first as FBEDITORAST = editorAstSource(o)\n\tdim editor_empty as FBEDITORAST", "\tdim editor_lowered as FBEDITORAST = editorAstSource(editor_result)\n\teditorEmitTransform(\"unary\", editor_result, editor_first, editor_empty, editor_lowered, NULL, op)\n\tif( editor_result <> NULL and editor_lowered.target <> NULL ) then editor_result->editor_source.target = editor_lowered.target");
    wrap("ast-node-iif.bas", "astNewIIF", "\tdim editor_condition as FBEDITORAST = editorAstSource(condexpr)\n\tdim editor_true as FBEDITORAST = editorAstSource(truexpr)\n\tdim editor_false as FBEDITORAST = editorAstSource(falsexpr)", "\teditorEmitTransform(\"conditional\", editor_result, editor_condition, editor_true, editor_false, NULL, 0)");
    wrap("ast-node-arg.bas", "astNewARG", "\tdim editor_before as FBEDITORAST = editorAstSource(arg)", "\teditorEmitArgument(parent, editor_result, editor_before)");
    wrap("ast-helper.bas", "astBuildCall", "\tdim editor_first as FBEDITORAST = editorAstSource(arg1)\n\tdim editor_second as FBEDITORAST = editorAstSource(arg2)\n\tdim editor_third as FBEDITORAST = editorAstSource(arg3)", "\tdim editor_arguments as FBEDITORAST = editorAstSource(editor_result)\n\tif( editor_arguments.identity <> 0 ) then editor_third = editor_arguments\n\teditorEmitTransform(\"call\", editor_result, editor_first, editor_second, editor_third, proc, 0)");
    routine("ast-helper.bas", "astBuildImplicitCtorCall", (source) => {
        source = replaceOnce(source, "\tdim as integer err_num = FB_ERRMSG_OK", "\tdim editor_input as FBEDITORAST = editorAstSource(expr)\n\tdim editor_empty as FBEDITORAST\n\tdim as integer err_num = FB_ERRMSG_OK");
        return replaceOnce(source, "\tis_ctorcall = TRUE\n\tfunction = procexpr", "\tdim editor_arguments as FBEDITORAST = editorAstSource(procexpr)\n\teditorEmitTransform(\"call\", procexpr, editor_input, editor_empty, editor_arguments, proc, 0)\n\tis_ctorcall = TRUE\n\tfunction = procexpr");
    });

    /* Repeated '*' is parsed in one pass, then applied from right to left.
       Pass a value-only location array to that existing loop so every native
       intermediate type has its own written range. Other compiler callers
       omit the optional array and retain their original behavior. Sixteen
       initial entries avoid repeated allocation for normal expressions; the
       geometric growth also covers long chains of overloaded dereferences. */
    const derefHeader = result["ast.bi"].match(/declare function astBuildMultiDeref _[\s\S]*?\) as ASTNODE ptr/)?.[0];
    if (!derefHeader) throw new Error("Compiler multi-dereference declaration changed.");
    result["ast.bi"] = replaceOnce(result["ast.bi"], derefHeader, replaceOnce(derefHeader, "byval subtype as FBSYMBOL ptr _", "byval subtype as FBSYMBOL ptr, _\n\t\tbyval editor_sites as FBEDITORAST ptr = NULL _"));
    routine("ast-helper.bas", "astBuildMultiDeref", (source) => {
        source = replaceOnce(source, "byval subtype as FBSYMBOL ptr _", "byval subtype as FBSYMBOL ptr, _\n\t\tbyval editor_sites as FBEDITORAST ptr _");
        return replaceOnce(source, "\t\tcnt -= 1", "\t\tif( editor_sites <> NULL ) then\n\t\t\tdim editor_site as FBEDITORLOCATION\n\t\t\teditor_site.output_line = editor_sites[cnt-1].start_serial\n\t\t\teditor_site.byte_column = editor_sites[cnt-1].start_byte\n\t\t\teditorEmitExpression(editor_site, expr)\n\t\tend if\n\t\tcnt -= 1");
    });
    routine("parser-expr-unary.bas", "editorOriginal_cDerefExpression", (source) => {
        source = replaceOnce(source, "\t'' DREF+\n", "\tdim editor_sites() as FBEDITORAST\n\tdim editor_count as integer\n\tdim editor_locations as FBEDITORAST ptr\n\t'' DREF+\n");
        source = replaceOnce(source, "\tdo\n\t\tlexSkipToken( )", "\tdo\n\t\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\t\tif( editor_site.output_line > 0 ) then\n\t\t\tif( derefcnt = editor_count ) then\n\t\t\t\tif( editor_count = 0 ) then\n\t\t\t\t\teditor_count = 16\n\t\t\t\telse\n\t\t\t\t\teditor_count *= 2\n\t\t\t\tend if\n\t\t\t\tredim preserve editor_sites(0 to editor_count-1)\n\t\t\tend if\n\t\t\teditor_sites(derefcnt).start_serial = editor_site.output_line\n\t\t\teditor_sites(derefcnt).start_byte = editor_site.byte_column\n\t\tend if\n\t\tlexSkipToken( )");
        const multiDerefAssignments = [
            "\texpr = astBuildMultiDeref( derefcnt, expr, astGetFullType( expr ), astGetSubType( expr ) )",
            "\tfunction = astBuildMultiDeref( derefcnt, expr, astGetFullType( expr ), astGetSubType( expr ) )"
        ];
        const assignment = multiDerefAssignments.find((anchor) => source.includes(anchor));
        if (!assignment) throw new Error("Compiler multi-dereference source hook changed.");
        return replaceOnce(source, assignment,
            "\tif( editor_count > 0 ) then editor_locations = @editor_sites(0)\n" +
            assignment.replace("astGetSubType( expr ) )", "astGetSubType( expr ), editor_locations )"));
    });

    // Statement calls can bypass cHighestPrecExpr, particularly in QB mode.
    wrap("parser-proccall.bas", "cProcCallOrAssign", "\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\tdim editor_previous as FBEDITORLOCATION = editorExchangePrefix(editor_site)", "\teditorExchangePrefix(editor_previous)");
    routine("parser-proccall.bas", "cProcCall", (source) => {
        source = replaceOnce(source, "\tdim as FBEDITORLOCATION editor_site = editorLastToken()", "\tdim as FBEDITORLOCATION editor_site = editorLastToken()\n\tdim editor_start as FBEDITORLOCATION = editorExpressionPrefix()\n\tdim editor_callee as FBEDITORAST = editorAstSource(thisexpr)\n\tif( thisexpr <> NULL ) then editor_start = editorAstStart(thisexpr)\n\tif( ptrexpr <> NULL ) then\n\t\teditor_start = editorAstStart(ptrexpr)\n\t\teditor_callee = editorAstSource(ptrexpr)\n\tend if");
        return replaceOnce(source, "\tif( is_propset = FALSE ) then", "\tif( ptrexpr <> NULL ) then editor_target = NULL\n\teditorEmitCall(editor_start, procexpr, editor_target, editor_callee.identity)\n\tdim editor_previous_family as string = editorExchangeExpressionFamily(\"cProcCall\")\n\teditorTagExpressionFamily(procexpr)\n\teditorExchangeExpressionFamily(editor_previous_family)\n\tif( is_propset = FALSE ) then");
    });
    routine("parser-expr-variable.bas", "cVariableEx", (source) => {
        source = replaceOnce(source, "editor_variable as FBEDITORLOCATION = editorNextToken()", "editor_variable as FBEDITORLOCATION = editorExpressionPrefix()");
        source = replaceOnce(source, "\teditorEmitType(editor_variable, symbGetFullType(sym), symbGetSubType(sym))", "\tdim editor_leaf as FBEDITORAST = editorEmitLeaf(editor_variable, symbGetFullType(sym), symbGetSubType(sym), 0)");
        source = replaceOnce(source, "\tvarexpr = astNewVAR( sym )", "\tvarexpr = astNewVAR( sym )\n\tvarexpr->editor_source = editor_leaf");
        return replaceOnce(source, "\tassert( varexpr->dtype = sym->typ )", "\teditorEmitExpression(editor_variable, varexpr)\n\tassert( varexpr->dtype = sym->typ )");
    });
    routine("parser-expr-variable.bas", "cUdtMember", (source) => {
        source = replaceOnce(source, "\t'' note: assuming a pointer", "\tdim editor_start as FBEDITORLOCATION = editorAstStart(varexpr)\n\t'' note: assuming a pointer");
        source = replaceOnce(source, "\t\t\tvarexpr = hFieldAccess( varexpr, fld, dtype, subtype, check_array )", "\t\t\tdim editor_leaf as FBEDITORAST = editorEmitLeaf(editor_start, dtype, subtype, varexpr->editor_source.identity)\n\t\t\tvarexpr = hFieldAccess( varexpr, fld, dtype, subtype, check_array )\n\t\t\tif( varexpr <> NULL ) then varexpr->editor_source = editor_leaf\n\t\t\tif( symbFieldIsBitfield(fld) ) then\n\t\t\t\t'' Bit-field FIELD nodes carry the compiler's unsigned remap type,\n\t\t\t\t'' which can differ from the declared storage type emitted above.\n\t\t\t\teditorEmitExpression(editor_start, varexpr, astGetFullType(varexpr), astGetSubtype(varexpr), TRUE)\n\t\t\telse\n\t\t\t\teditorEmitExpression(editor_start, varexpr)\n\t\t\tend if");
        source = replaceOnce(source,
            "\t\t\tvarexpr = astBuildConst( fld )\n\t\t\tfbSemanticModelConstantExpression(varexpr, fld, semantic_member_site, semantic_member_nonphysical)\n\t\t\tif( export_semantics ) then\n\t\t\t\tfbSemanticModelExportCurrentExpressionPrefix(varexpr)\n\t\t\tend if\n\t\t\treturn varexpr",
            "\t\t\tvarexpr = astBuildConst( fld )\n\t\t\tfbSemanticModelConstantExpression(varexpr, fld, semantic_member_site, semantic_member_nonphysical)\n\t\t\tif( export_semantics ) then\n\t\t\t\tfbSemanticModelExportCurrentExpressionPrefix(varexpr)\n\t\t\tend if\n\t\t\teditorEmitExpression(editor_start, varexpr)\n\t\t\treturn varexpr");
        source = replaceOnce(source, "\t\t\tvarexpr = cVariableEx( fld, check_array )", "\t\t\tvarexpr = cVariableEx( fld, check_array )\n\t\t\teditorEmitExpression(editor_start, varexpr)");
        return replaceOnce(source,
            "\t\t\tvarexpr = cMethodCall( fld, varexpr, options )\n\t\t\tif( export_semantics ) then\n\t\t\t\tfbSemanticModelExportCurrentExpressionPrefix(varexpr)\n\t\t\tend if\n\t\t\treturn varexpr",
            "\t\t\teditorSetAstStart(varexpr, editor_start)\n\t\t\tvarexpr = cMethodCall( fld, varexpr, options )\n\t\t\tif( export_semantics ) then\n\t\t\t\tfbSemanticModelExportCurrentExpressionPrefix(varexpr)\n\t\t\tend if\n\t\t\teditorEmitExpression(editor_start, varexpr)\n\t\t\treturn varexpr");
    });
    routine("parser-expr-variable.bas", "cMemberDeref", (source) => {
        source = replaceOnce(source, "\tdim as integer derefcnt = any", "\tdim editor_start as FBEDITORLOCATION = editorAstStart(varexpr)\n\tdim as integer derefcnt = any");
        source = replaceOnce(source, "\tdo\n\t\tidxexpr = NULL", "\tdo\n\t\tdim editor_receiver as FBEDITORAST = editorAstSource(varexpr)\n\t\tidxexpr = NULL");
        source = replaceOnce(source, "\n\tloop\n", "\n\t\teditorEmitExpression(editor_start, varexpr)\n\tloop\n");
        const overloadedIndex = "\t\t\t\t'' '.'?\n\t\t\t\tif( lexGetToken( ) = CHAR_DOT ) then\n\t\t\t\t\tlexSkipToken( LEXCHECK_NOPERIOD )";
        source = replaceOnce(source, overloadedIndex, "\t\t\t\teditorEmitExpression(editor_start, varexpr)\n" + overloadedIndex);
        const pointerIndex = "\t\t\t\t'' '.'?\n\t\t\t\tif( lexGetToken( ) = CHAR_DOT ) then\n\t\t\t\t\t'' A . member";
        /* Before the compiler adds DEREF, its temporary is still a pointer.
           The written index expression already has the element's dtype. */
        source = replaceOnce(source, pointerIndex, "\t\t\t\tvarexpr->editor_source = editorEmitLeaf(editor_start, dtype, subtype, editor_receiver.identity)\n" + pointerIndex);
        return source;
    });
    routine("parser-expr-variable.bas", "cMemberAccess", (source) => {
        source = replaceOnce(source, "\t'' proc call?", "\tdim editor_start as FBEDITORLOCATION = editorAstStart(expr)\n\t'' proc call?");
        return replaceOnce(source, "\t'' build: cast( udt ptr", "\teditorSetAstStart(expr, editor_start)\n\t'' build: cast( udt ptr");
    });
    routine("parser-expr-variable.bas", "hImpField", (source) => replaceOnce(source, "\tvarexpr = cUdtMember(", "\tdim editor_start as FBEDITORLOCATION = editorExpressionPrefix()\n\teditorSetAstStart(varexpr, editor_start)\n\tvarexpr = cUdtMember("));
    routine("parser-expr-function.bas", "cFunctionCall", (source) => {
        source = replaceOnce(source, "\tdim as FBEDITORLOCATION editor_site = editorLastToken()", "\tdim as FBEDITORLOCATION editor_site = editorLastToken()\n\tdim editor_start as FBEDITORLOCATION = editorExpressionPrefix()\n\tdim editor_callee as FBEDITORAST = editorAstSource(thisexpr)\n\tif( thisexpr <> NULL ) then editor_start = editorAstStart(thisexpr)\n\tif( ptrexpr <> NULL ) then\n\t\teditor_start = editorAstStart(ptrexpr)\n\t\teditor_callee = editorAstSource(ptrexpr)\n\tend if");
        // A pointer's anonymous prototype describes its signature, not a known
        // runtime procedure. Retain the callee expression as the dependency.
        return replaceOnce(source, "\tif( ptrexpr = NULL ) then editorEmitType(editor_site, astGetFullType(funcexpr), astGetSubType(funcexpr))", "\tif( ptrexpr <> NULL ) then editor_target = NULL\n\teditorEmitCall(editor_start, funcexpr, editor_target, editor_callee.identity)\n\t'' Keep the caller family on the committed syntax node, then append the\n\t'' exceptional call-parser owner as a second route tag.\n\tdim editor_previous_family as string = editorExchangeExpressionFamily(\"cFunctionCall\")\n\teditorTagExpressionFamily(funcexpr)\n\teditorExchangeExpressionFamily(editor_previous_family)");
    });
    routine("parser-expr-function.bas", "cCtorCall", (source) => {
        source = replaceOnce(source, "\tdim as FB_CALL_ARG_LIST arg_list = ( 0, NULL, NULL )", "\tdim as FB_CALL_ARG_LIST arg_list = ( 0, NULL, NULL )\n\tdim editor_start as FBEDITORLOCATION = editorExpressionPrefix()\n\tdim as FBSYMBOL ptr editor_target = NULL");
        source = replaceOnce(source, "\t                         iif( isprnt = FALSE, FB_PARSEROPT_OPTONLY, FB_PARSEROPT_NONE ) )", "\t                         iif( isprnt = FALSE, FB_PARSEROPT_OPTONLY, FB_PARSEROPT_NONE ), @editor_target )");
        return replaceOnce(source, "\tfunction = astNewCALLCTOR( procexpr, astNewVAR( tmp ) )", "\tprocexpr = astNewCALLCTOR( procexpr, astNewVAR( tmp ) )\n\t'' UDT construction begins with a type name, not a callable AST receiver.\n\t'' Commit the complete written TYPE(...) span only after cProcArgList() has\n\t'' selected the constructor and the optional closing parenthesis is consumed.\n\t'' TYPE<UDT>(...) can bypass cProcArgList()'s output parameter, but the\n\t'' completed CALLCTOR still carries the compiler-selected constructor.\n\tdim editor_source as FBEDITORAST = editorAstSource(procexpr)\n\tif( editor_target = NULL ) then editor_target = editor_source.target\n\teditorEmitCall(editor_start, procexpr, editor_target, 0)\n\t'' Retain the enclosing family (for example, cAnonType) and add this route\n\t'' after the complete source syntax identity has been committed.\n\tdim editor_previous_family as string = editorExchangeExpressionFamily(\"cCtorCall\")\n\teditorTagExpressionFamily(procexpr)\n\teditorExchangeExpressionFamily(editor_previous_family)\n\tfunction = procexpr");
    });
    if (!nativeSemanticMemoryOperations) {
        routine("parser-quirk-mem.bas", "cOperatorNew", (source) => {
            source = replaceOnce(source, "\tdim as ASTNODE ptr expr = any\n\tdim as AST_OP op = any", "\tdim as ASTNODE ptr expr = any\n\tdim as AST_OP op = any\n\tdim as FBEDITORLOCATION editor_start = editorNextToken()\n\tdim as FBSYMBOL ptr editor_target = NULL\n\tdim editor_elements as FBEDITORAST");
            source = replaceOnce(source, "\t\telementsexpr = cExpression(  )\n\t\tif( elementsexpr = NULL ) then", "\t\telementsexpr = cExpression(  )\n\t\teditor_elements = editorAstSource(elementsexpr)\n\t\tif( elementsexpr = NULL ) then");
            source = replaceOnce(source, "\texpr = astBuildNewOp( op, tmp, elementsexpr, initexpr, _\n\t                      dtype, subtype, do_clear, placementexpr )", "\texpr = astBuildNewOp( op, tmp, elementsexpr, initexpr, _\n\t                      dtype, subtype, do_clear, placementexpr, @editor_target )");
            source = replaceOnce(source, "\t'' return the pointer\n\tfunction = astNewLINK( expr, astNewVAR( tmp ), AST_LINK_RETURN_RIGHT )", "\t'' return the pointer\n\texpr = astNewLINK( expr, astNewVAR( tmp ), AST_LINK_RETURN_RIGHT )\n\tif( editor_elements.identity <> 0 ) then expr->editor_source = editor_elements\n\tif( editor_target <> NULL ) then\n\t\t'' NEW's element count is the only written argument to an allocation\n\t\t'' operator. Keep it when the expression parser has already committed it.\n\t\teditorEmitCall(editor_start, expr, editor_target, 0, TRUE, typeAddrOf(dtype), subtype, TRUE)\n\telse\n\t\t'' The LINK returns the allocated pointer, even though its first operand\n\t\t'' retains the element type for construction and initialization.\n\t\teditorEmitExpression(editor_start, expr, typeAddrOf(dtype), subtype, TRUE)\n\tend if\n\tfunction = expr");
            return source;
        });
        result["parser-quirk-mem.bas"] = replaceOnce(result["parser-quirk-mem.bas"], "\t'' DELETE\n\tlexSkipToken( LEXCHECK_POST_SUFFIX )", "\t'' DELETE\n\tdim as FBEDITORLOCATION editor_start = editorNextToken()\n\tdim as FBSYMBOL ptr editor_target = NULL, editor_dtor_target = NULL\n\tdim editor_pointer as FBEDITORAST\n\tdim editor_empty as FBEDITORAST\n\tdim as ASTNODE ptr editor_result\n\tlexSkipToken( LEXCHECK_POST_SUFFIX )");
        result["parser-quirk-mem.bas"] = replaceOnce(result["parser-quirk-mem.bas"], "\tastAdd( astBuildDeleteOp( op, ptrexpr ) )", "\teditor_pointer = editorAstSource(ptrexpr)\n\teditor_result = astBuildDeleteOp( op, ptrexpr, @editor_target, @editor_dtor_target )\n\tif( editor_dtor_target <> NULL andalso editor_result <> NULL ) then\n\t\t'' The compiler lowers destruction before the deallocator. Keep that\n\t\t'' selected relationship on the written pointer, even for virtual dtors.\n\t\teditorEmitTransform(\"call\", editor_result, editor_pointer, editor_empty, editor_empty, editor_dtor_target, 2)\n\t\teditor_result->editor_source = editor_pointer\n\tend if\n\tif( editor_target <> NULL andalso editor_result <> NULL ) then\n\t\t'' DELETE's overloaded deallocator has no written callee.\n\t\teditor_result->editor_source = editor_pointer\n\t\teditorEmitCall(editor_start, editor_result, editor_target, 0, TRUE)\n\tend if\n\tastAdd( editor_result )");
    } else {
        /* Newer compilers already return the compiler-selected operator CALL
           through semantic_operator. Use that exact node for the bridge trace,
           and let the same path expose NEW's result type when allocation stays
           on the built-in fallback. */
        routine("parser-quirk-mem.bas", "cOperatorNew", (source) => {
            source = replaceOnce(source, "\tdim as ASTNODE ptr expr = any", "\tdim as ASTNODE ptr expr = any\n\tdim as FBEDITORLOCATION editor_start = editorNextToken()\n\tdim editor_elements as FBEDITORAST");
            source = replaceOnce(source, "\t\telementsexpr = cExpression(  )\n\t\tif( elementsexpr = NULL ) then", "\t\telementsexpr = cExpression(  )\n\t\teditor_elements = editorAstSource(elementsexpr)\n\t\tif( elementsexpr = NULL ) then");
            return replaceOnce(source, "\t'' return the pointer\n\tfunction = astNewLINK( expr, astNewVAR( tmp ), AST_LINK_RETURN_RIGHT )", "\t'' return the pointer\n\texpr = astNewLINK( expr, astNewVAR( tmp ), AST_LINK_RETURN_RIGHT )\n\tif( editor_elements.identity <> 0 ) then expr->editor_source = editor_elements\n\tif( semantic_operator <> NULL ) then\n\t\teditorEmitCall(editor_start, expr, semantic_operator->sym, 0, TRUE, typeAddrOf(dtype), subtype, TRUE)\n\telse\n\t\t'' The lowered allocation tree retains the element type; NEW returns a pointer.\n\t\teditorEmitExpression(editor_start, expr, typeAddrOf(dtype), subtype, TRUE)\n\tend if\n\tfunction = expr");
        });
        result["parser-quirk-mem.bas"] = replaceOnce(result["parser-quirk-mem.bas"], "\t'' DELETE\n\tlexSkipToken( LEXCHECK_POST_SUFFIX )", "\t'' DELETE\n\tdim as FBEDITORLOCATION editor_start = editorNextToken()\n\tdim editor_pointer as FBEDITORAST\n\tdim editor_empty as FBEDITORAST\n\tlexSkipToken( LEXCHECK_POST_SUFFIX )");
        result["parser-quirk-mem.bas"] = replaceOnce(result["parser-quirk-mem.bas"], "\tdelete_expr = astBuildDeleteOp( op, ptrexpr, semantic_operator )\n\tif( semantic_operator <> NULL ) then", "\teditor_pointer = editorAstSource(ptrexpr)\n\tdelete_expr = astBuildDeleteOp( op, ptrexpr, semantic_operator )\n\tif( (dtor <> NULL) andalso (delete_expr <> NULL) ) then\n\t\teditorEmitTransform(\"call\", delete_expr, editor_pointer, editor_empty, editor_empty, dtor, 2)\n\t\tdelete_expr->editor_source = editor_pointer\n\tend if\n\tif( (semantic_operator <> NULL) andalso (delete_expr <> NULL) ) then\n\t\tdelete_expr->editor_source = editor_pointer\n\t\teditorEmitCall(editor_start, delete_expr, semantic_operator->sym, 0, TRUE)\n\tend if\n\tif( semantic_operator <> NULL ) then");
    }
    routine("parser-quirk-thread.bas", "cThreadCallFunc", (source) => {
        source = replaceOnce(source, "\tdim as ASTNODE ptr childcall", "\tdim as ASTNODE ptr childcall\n\tdim as ASTNODE ptr editor_result\n\tdim as FBEDITORLOCATION editor_start = editorExpressionPrefix()\n\tdim as FBEDITORLOCATION editor_callee_start\n\tdim as FBEDITORAST editor_callee");
        source = replaceOnce(source, "\t'' THREADCALL\n\tlexSkipToken( LEXCHECK_POST_SUFFIX )", "\t'' THREADCALL\n\tlexSkipToken( LEXCHECK_POST_SUFFIX )\n\teditor_callee_start = editorNextToken()");
        source = replaceOnce(source, "\tchildcall = cProcArgList( NULL, sym, NULL, @arg_list, 0 )", "\tchildcall = cProcArgList( NULL, sym, NULL, @arg_list, 0 )");
        return replaceOnce(source, "\t'' transform the call into a threadcall\n\tthreadcall_expr = rtlThreadCall( childcall )\n\tfunction = threadcall_expr", "\t'' cProcArgList() bypasses the ordinary call parser for this quirk.\n\t'' Its closing parenthesis has now been consumed, so its source span is complete.\n\teditorEmitCall(editor_callee_start, childcall, sym, 0)\n\teditor_callee = editorAstSource(childcall)\n\n\t'' rtlThreadCall() replaces the source CALL with FB_THREADCALL and an\n\t'' argument-marshalling link. Preserve both relationships before the old\n\t'' call tree is deleted by the runtime helper.\n\teditor_result = rtlThreadCall( childcall )\n\tthreadcall_expr = editor_result\n\tfunction = threadcall_expr\n\teditorEmitCall(editor_start, editor_result, PROCLOOKUP( THREADCALL ), editor_callee.identity, TRUE)");
    });
    /* Graphics functions construct runtime calls after consuming several
       grammar-specific argument forms. Commit their call only here, where the
       source keyword and closing parenthesis delimit a real written expression.
       This intentionally excludes graphics statements and generated drawing work. */
    routine("parser-quirk-gfx.bas", "cGfxFunct", (source) => {
        source = replaceOnce(source, "\tdim as ASTNODE ptr expr = NULL", "\tdim as ASTNODE ptr expr = NULL\n\tdim as FBEDITORLOCATION editor_start = editorNextToken()");
        return replaceOnce(source, "\tfunction = expr", "\tdim editor_source as FBEDITORAST = editorAstSource(expr)\n\teditorEmitCall(editor_start, expr, editor_source.target, 0, TRUE)\n\tfunction = expr");
    });
    /* CVA_ARG is a compiler intrinsic, rather than a call to an FBSYMBOL.
       Its result is either a backend macro node or a pointer-based tree,
       depending on the target ABI. Preserve the written cva_list operand at
       the parser boundary so both lowerings retain the same source edge. */
    routine("parser-quirk-vafirst.bas", "cVALISTFunct", (source) => {
        source = replaceOnce(source, "\tdim as FBSYMBOL ptr subtype", "\tdim as FBSYMBOL ptr subtype\n\tdim editor_input as FBEDITORAST\n\tdim editor_empty as FBEDITORAST");
        source = replaceOnce(source, "\texpr = cVarOrDeref()", "\texpr = cVarOrDeref()\n\teditor_input = editorAstSource(expr)");
        return replaceOnce(source,
            "\thExportValistOperation(result, semantic_operands, AST_OP_VA_ARG, _\n\t\tsource_start, source_end, nonphysical_tokens_at_start, _\n\t\tnonphysical_tokens_at_end, has_closing_parenthesis)\n\tfunction = result",
            "\thExportValistOperation(result, semantic_operands, AST_OP_VA_ARG, _\n\t\tsource_start, source_end, nonphysical_tokens_at_start, _\n\t\tnonphysical_tokens_at_end, has_closing_parenthesis)\n\t'' Keep the intrinsic dependency distinct from direct and runtime calls.\n\teditorEmitTransform(\"call\", result, editor_input, editor_empty, editor_empty, NULL, 0)\n\tfunction = result");
    });
    for (const [file, name] of QUIRK_EXPRESSION_HOOKS) wrapParserFamily(file, name);
    return result;
}

module.exports = { EXPRESSION_FILES, QUIRK_EXPRESSION_HOOKS, QUIRK_EXPRESSION_FAMILIES, QUIRK_EXPRESSION_FOCUSED_FAMILIES, EXCEPTIONAL_EXPRESSION_FAMILY_HOOKS, TYPE_LAYOUT_EXPRESSION_HOOKS, instrumentExpressionGraph };

/* end of compiler-expression-hooks.js */
