/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/compiler-symbol-hooks.js
    Purpose: Instrument committed compiler symbol declarations and references.
    Responsibilities: preserve identifier sites and native canonical relationships.
    Does not contain: compiler building, name resolution, or editor policy.
*/

const SYMBOL_FILES = ["symb.bi", "symb.bas", "symb-proc.bas", "symb-label.bas", "symb-typedef.bas", "parser.bi", "parser-decl-var.bas", "parser-decl-const.bas", "parser-decl-struct.bas", "parser-decl-enum.bas", "parser-decl-typedef.bas", "parser-decl-proc-params.bas", "parser-decl-symbtype.bas", "parser-compound-namespace.bas", "parser-compound-if.bas", "parser-identifier.bas", "parser-expr-variable.bas", "parser-expr-constant.bas", "parser-expr-unary.bas", "parser-proccall.bas", "parser-proc.bas", "parser-quirk-data.bas", "parser-quirk-goto-return.bas", "parser-quirk-on.bas"];

function instrumentSymbols(files, replaceOnce) {
    const result = { ...files };
    function routine(file, name, transform) {
        const source = result[file];
        const match = source.match(new RegExp(`^(?:private )?(function|sub) ${name}\\b`, "m"));
        if (!match) throw new Error(`Compiler symbol hook changed: ${file}: ${name}`);
        const end = source.indexOf(`\nend ${match[1]}`, match.index);
        if (end < 0) throw new Error(`Unterminated compiler routine: ${name}`);
        const limit = end + `\nend ${match[1]}`.length;
        result[file] = source.slice(0, match.index) + transform(source.slice(match.index, limit)) + source.slice(limit);
    }
    function referenceBefore(file, name, before, symbol) {
        routine(file, name, (source) => replaceOnce(source, before, `\teditorReference(${symbol})\n` + before));
    }
    function instrumentTypedefRead(source, indent, declareTypeSite) {
        const callAnchors = [
            `${indent}var pfwdname = hReadType( dtype, subtype, lgt, is_fixlenstr )`,
            `${indent}var pfwdname = hReadType( dtype, subtype, lgt, is_fixlenstr, forward_site )`
        ];
        const callAnchor = callAnchors.find((anchor) => source.includes(anchor));
        if (!callAnchor) throw new Error("Compiler typedef type-read hook changed.");
        const hasForwardSite = callAnchor.includes("forward_site");
        const typeSiteDeclaration = declareTypeSite ? `${indent}dim editor_type_site as FBEDITORLOCATION\n` : "";
        const typeSiteArguments = hasForwardSite ? "editor_type_site, forward_site" : "editor_type_site";
        const callReplacement = `${typeSiteDeclaration}${indent}var pfwdname = hReadType( dtype, subtype, lgt, is_fixlenstr, ${typeSiteArguments} )`;
        return replaceOnce(source, callAnchor, callReplacement);
    }
    function instrumentTypedefCall(source) {
        const callAnchors = [
            "\t\t             semantic_site, has_site, forward_site )",
            "\t\t             semantic_site, has_site )"
        ];
        const callAnchor = callAnchors.find((anchor) => source.includes(anchor));
        if (!callAnchor) throw new Error("Compiler typedef creation call changed.");
        const callArguments = callAnchor.includes("forward_site")
            ? "\t\t             semantic_site, has_site, editor_site, editor_type_site, forward_site )"
            : "\t\t             semantic_site, has_site, editor_site, editor_type_site )";
        return replaceOnce(source, callAnchor, callArguments);
    }
    result["symb.bi"] = replaceOnce(result["symb.bi"], "type FBSYMBOL\n", "type FBSYMBOL\n\teditor_symbol_id as integer\n\teditor_exported as integer\n");
    for (const [file, variable] of [["symb.bas", "s"], ["symb-proc.bas", "proc"]]) {
        result[file] = replaceOnce(result[file], `${variable} = listNewNode( @symb.symlist )`, `${variable} = listNewNode( @symb.symlist )\n\t${variable}->editor_symbol_id = 0\n\t${variable}->editor_exported = FALSE`);
    }
    result["symb.bas"] = replaceOnce(result["symb.bas"], "\tsymb.globnspc.class = FB_SYMBCLASS_NAMESPACE", "\tsymb.globnspc.editor_symbol_id = 0\n\tsymb.globnspc.editor_exported = TRUE\n\tsymb.globnspc.class = FB_SYMBCLASS_NAMESPACE");

    /* Capture before consuming the declared identifier. Types, bounds, and
       initializers may recursively parse other occurrences of the same name. */
    routine("parser-decl-var.bas", "cVarDecl", (source) => {
        source = replaceOnce(source, "\t\t'' Parse symbol identifier,", "\t\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\t\t'' Parse symbol identifier,");
        source = replaceOnce(source, "\t\tsym = hAddVar(", "\t\tdim editor_declaration as integer = (token <> FB_TK_REDIM) or (sym = NULL)\n\t\tsym = hAddVar(");
        return replaceOnce(source, "\t\tif( hEmitVarDecl(", "\t\teditorEmitSymbol(editor_site, sym, editor_declaration)\n\t\tif( hEmitVarDecl(");
    });
    routine("parser-decl-var.bas", "cAutoVarDecl", (source) => {
        source = replaceOnce(source, "\t\t'' get id\n", "\t\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\t\t'' get id\n");
        return replaceOnce(source, "\t\tif( sym <> NULL ) then", "\t\teditorEmitSymbol(editor_site, sym, TRUE)\n\t\tif( sym <> NULL ) then");
    });
    referenceBefore("parser-expr-variable.bas", "cVariableEx", "\tassert( symbIsVar( sym ) )", "sym");
    routine("parser-expr-variable.bas", "hVarAddUndecl", (source) => {
        source = replaceOnce(source, "\tdim as FBSYMBOL ptr s = any", "\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\tdim as FBSYMBOL ptr s = any");
        return replaceOnce(source, "\tfunction = s", "\teditorEmitSymbol(editor_site, s, TRUE)\n\tfunction = s");
    });
    routine("parser-expr-variable.bas", "hMemberId", (source) => replaceOnce(source, "\treturn sym\n", "\tif( symbIsProc(sym) = FALSE ) then editorReference(sym)\n\treturn sym\n"));
    result["parser-expr-constant.bas"] = replaceOnce(result["parser-expr-constant.bas"], "\t'' Check visibility of constant", "\teditorReference(sym)\n\t'' Check visibility of constant");

    routine("parser-decl-const.bas", "cConstAssign", (source) => {
        source = replaceOnce(source, "\tid = *lexGetText( )", "\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\tdim editor_symbol as FBSYMBOL ptr\n\tid = *lexGetText( )");
        const calls = /\t\tsymbol = (symbReuseOrAddConst\([^\n]+\))\n\t\tif\( symbol = NULL \) then/g;
        if ([...source.matchAll(calls)].length !== 2) throw new Error("Constant declaration hooks changed.");
        source = source.replace(calls, "\t\tsymbol = $1\n\t\teditor_symbol = symbol\n\t\teditorEmitSymbol(editor_site, editor_symbol, TRUE)\n\t\tif( symbol = NULL ) then");
        return source;
    });

    routine("parser-decl-struct.bas", "hAddAndInitField", (source) => {
        source = replaceOnce(source,
            "\t\tbyval attrib as FB_SYMBATTRIB, _\n\t\tbyref semantic_site as LEX_LOCATION _",
            "\t\tbyval attrib as FB_SYMBATTRIB, _\n\t\tbyref editor_site as FBEDITORLOCATION, _\n\t\tbyref semantic_site as LEX_LOCATION _");
        return replaceOnce(source, "\t'' Initializer?\n", "\teditorEmitSymbol(editor_site, sym, TRUE)\n\t'' Initializer?\n");
    });
    for (const [name, attrib] of [["hTypeMultElementDecl", "fieldattrib"], ["hTypeElementDecl", "attrib"]]) {
        routine("parser-decl-struct.bas", name, (source) => {
            source = replaceOnce(source,
                "id = hFieldId( parent, semantic_site )",
                "dim editor_site as FBEDITORLOCATION = editorNextToken()\n\t\tid = hFieldId( parent, semantic_site )");
            return replaceOnce(source,
                `lgt, bits, ${attrib}, semantic_site )`,
                `lgt, bits, ${attrib}, editor_site, semantic_site )`);
        });
    }
    routine("parser-decl-struct.bas", "cTypeDecl", (source) => {
        source = replaceOnce(source, "\tdim as FB_CMPSTMTSTK ptr stk = any",
            "\tdim as FB_CMPSTMTSTK ptr stk = any\n\tdim editor_site as FBEDITORLOCATION\n\tdim editor_type_site as FBEDITORLOCATION");
        source = replaceOnce(source, "\t\tlexEatToken( @id )", "\t\teditor_site = editorNextToken()\n\t\tlexEatToken( @id )");
        source = replaceOnce(source, "cTypedefSingleDecl( attrib, id, semantic_site, checkid )",
            "cTypedefSingleDecl( attrib, id, semantic_site, checkid, editor_site, editor_type_site )");
        return replaceOnce(source, "\t'' restore the context", "\teditorEmitSymbol(editor_site, sym, TRUE)\n\n\t'' restore the context");
    });
    const typedefDeclaration = result["parser.bi"].match(/declare sub cTypedefSingleDecl _[\s\S]*?\n\t\)/);
    if (!typedefDeclaration) throw new Error("Compiler typedef declaration hook changed.");
    result["parser.bi"] = replaceOnce(result["parser.bi"], typedefDeclaration[0],
        replaceOnce(typedefDeclaration[0], "\t\tbyval has_site as integer _",
            "\t\tbyval has_site as integer, _\n\t\tbyref editor_site as FBEDITORLOCATION, _\n\t\tbyref editor_type_site as FBEDITORLOCATION _"));
    routine("parser-decl-enum.bas", "cEnumDecl", (source) => {
        source = replaceOnce(source, "\t'' ID?\n", "\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\t'' ID?\n");
        return replaceOnce(source, "\t'' Comment? SttSeparator\n", "\teditorEmitSymbol(editor_site, e, TRUE)\n\t'' Comment? SttSeparator\n");
    });
    routine("parser-decl-enum.bas", "cEnumBody", (source) => {
        source = replaceOnce(source, "\t\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )", "\t\t\t\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\t\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )");
        return replaceOnce(source,
            "\t\t\t\tdim as FBSYMBOL ptr enum_element = symbAddEnumElement( s, @id, value, attrib )",
            "\t\t\t\tdim as FBSYMBOL ptr enum_element = symbAddEnumElement( s, @id, value, attrib )\n\t\t\t\teditorEmitSymbol(editor_site, enum_element, TRUE)");
    });
    routine("parser-decl-typedef.bas", "hAddTypedef", (source) => {
        const signatureAnchors = [
            "\t\tbyval has_site as integer _",
            "\t\tbyval has_site as integer, _\n\t\tbyref forward_site as LEX_LOCATION _"
        ];
        const signatureAnchor = signatureAnchors.find((anchor) => source.includes(anchor));
        if (!signatureAnchor) throw new Error("Compiler typedef editor parameters changed.");
        const editorParameters = signatureAnchor.includes("forward_site")
            ? "\t\tbyval has_site as integer, _\n\t\tbyref editor_site as FBEDITORLOCATION, _\n\t\tbyref editor_type_site as FBEDITORLOCATION, _\n\t\tbyref forward_site as LEX_LOCATION _"
            : "\t\tbyval has_site as integer, _\n\t\tbyref editor_site as FBEDITORLOCATION, _\n\t\tbyref editor_type_site as FBEDITORLOCATION _";
        source = replaceOnce(source, signatureAnchor, editorParameters);
        source = replaceOnce(source,
            "hAddForwardRef( pid, pfwdname, dtype, subtype, lgt, is_fixlenstr, attrib )",
            "hAddForwardRef( pid, pfwdname, dtype, subtype, lgt, is_fixlenstr, attrib, editor_type_site )");
        source = replaceOnce(source, "\t\t\tfbSemanticModelExportBinding(typedef, semantic_site, TRUE)",
            "\t\t\tfbSemanticModelExportBinding(typedef, semantic_site, TRUE)\n\t\t\tif( has_site ) then editorEmitSymbol(editor_site, typedef, TRUE)");
        source = replaceOnce(source, "\t\tif( has_site ) then editorEmitSymbol(editor_site, typedef, TRUE)",
            "\t\tif( has_site ) then editorEmitSymbol(editor_site, typedef, TRUE)\n\t\tif( pfwdname <> NULL ) then editorEmitSymbol(editor_type_site, typedef, FALSE)");
        return replaceOnce(source, "\t\tif( isdup ) then",
            "\t\tif( isdup = FALSE and has_site ) then editorEmitSymbol(editor_site, sym, TRUE)\n\t\tif( isdup ) then");
    });
    routine("parser-decl-typedef.bas", "cTypedefMultDecl", (source) => {
        source = replaceOnce(source, "\t\tvar pid = hReadId( semantic_site, has_site )",
            "\t\tvar pid = hReadId( semantic_site, has_site )\n\t\tdim editor_site as FBEDITORLOCATION = editorLastToken()");
        source = instrumentTypedefRead(source, "\t", true);
        return instrumentTypedefCall(source);
    });
    routine("parser-decl-typedef.bas", "cTypedefSingleDecl", (source) => {
        source = replaceOnce(source, "\t\tbyval has_site as integer _",
            "\t\tbyval has_site as integer, _\n\t\tbyref editor_site as FBEDITORLOCATION, _\n\t\tbyref editor_type_site as FBEDITORLOCATION _");
        source = replaceOnce(source, "\t\tpid = hReadId( semantic_site, has_site )",
            "\t\tpid = hReadId( semantic_site, has_site )\n\t\teditor_site = editorLastToken()");
        source = instrumentTypedefRead(source, "\t\t", false);
        return instrumentTypedefCall(source);
    });
    /* Forward references are temporary symbols, deleted when their real type
       arrives. Export the compiler's replacement edge before that deletion;
       a pointer address retained after backpatching would identify a reused
       pool node. The typedef spelling and its forward target remain distinct. */
    routine("parser-decl-typedef.bas", "hReadType", (source) => {
        const signatureAnchors = [
            "\t\tbyref is_fixlenstr as integer _",
            "\t\tbyref is_fixlenstr as integer, _\n\t\tbyref forward_site as LEX_LOCATION _"
        ];
        const signatureAnchor = signatureAnchors.find((anchor) => source.includes(anchor));
        if (!signatureAnchor) throw new Error("Compiler forward-type location hook changed.");
        const editorParameters = signatureAnchor.includes("forward_site")
            ? "\t\tbyref is_fixlenstr as integer, _\n\t\tbyref editor_type_site as FBEDITORLOCATION, _\n\t\tbyref forward_site as LEX_LOCATION _"
            : "\t\tbyref is_fixlenstr as integer, _\n\t\tbyref editor_type_site as FBEDITORLOCATION _";
        source = replaceOnce(source, signatureAnchor, editorParameters);
        return replaceOnce(source, "\t\ttname = *lexGetText( )", "\t\teditor_type_site = editorNextToken()\n\t\ttname = *lexGetText( )");
    });
    routine("parser-decl-typedef.bas", "hAddForwardRef", (source) => {
        source = replaceOnce(source, "\t\tbyval attrib as FB_SYMBATTRIB _", "\t\tbyval attrib as FB_SYMBATTRIB, _\n\t\tbyref editor_type_site as FBEDITORLOCATION _");
        return replaceOnce(source, "\t'' Restore the PTR's", "\teditorEmitSymbol(editor_type_site, subtype, FALSE)\n\t'' Restore the PTR's");
    });
    routine("symb-typedef.bas", "hFixForwardRef", (source) => replaceOnce(source, "\t'' Cycle through the forward ref's list of users", "\teditorAliasSymbol(fwd, sym)\n\t'' Cycle through the forward ref's list of users"));
    routine("symb-typedef.bas", "symbReplaceForwardRef", (source) => replaceOnce(source, "\tsymbSetType( s, dtype, subtype )", "\tsymbSetType( s, dtype, subtype )\n\tif( s->editor_exported ) then editorExportSymbol(s)"));
    routine("parser-compound-namespace.bas", "cNamespaceStmtBegin", (source) => {
        source = replaceOnce(source, "\t\t'' skip ID\n", "\t\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\t\t'' skip ID\n");
        return replaceOnce(source, "\t\tnamespaceBegin(stk, sym)", "\t\teditorEmitSymbol(editor_site, sym, TRUE)\n\t\tnamespaceBegin(stk, sym)");
    });
    for (const name of ["cIdentifier", "cParentId"]) {
        routine("parser-identifier.bas", name, (source) => replaceOnce(source, "\n\t\t'' skip id\n", "\n\t\teditorReference(chain_->sym)\n\t\t'' skip id\n"));
    }
    routine("parser-identifier.bas", "cParentId", (source) => replaceOnce(source, "\t\t\t'' skip id\n", "\t\t\teditorReference(chain_->sym)\n\t\t\t'' skip id\n"));
    routine("parser-decl-symbtype.bas", "hParseUserDefinedType", (source) => {
        const before = "\t\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )";
        if (source.split(before).length !== 4) throw new Error("Type reference hooks changed.");
        return source.split(before).join("\t\t\t\teditorReference(sym)\n" + before);
    });

    routine("parser-decl-proc-params.bas", "hParamDecl", (source) => {
        source = replaceOnce(source, "\t'' ID (or keyword used as ID)", "\tdim editor_site as FBEDITORLOCATION\n\t'' ID (or keyword used as ID)");
        source = replaceOnce(source, "\t\t*id = *lexGetText( )", "\t\teditor_site = editorNextToken()\n\t\t*id = *lexGetText( )");
        return replaceOnce(source, "\tfunction = param", "\teditorEmitSymbol(editor_site, param, TRUE)\n\tfunction = param");
    });
    routine("symb-proc.bas", "symbAddVarForParam", (source) => replaceOnce(source, "\tfunction = s", "\teditorAliasSymbol(s, param)\n\tfunction = s"));
    routine("parser-proc.bas", "hCheckPrototype", (source) => replaceOnce(source, "\t\tproto_param = proto_param->next\n\t\tparam = param->next", "\t\teditorAliasSymbol(param, proto_param)\n\t\tproto_param = proto_param->next\n\t\tparam = param->next"));
    result["parser-proc.bas"] = replaceOnce(result["parser-proc.bas"], "\t\t\thCheckPrototype( head_proc, proc, palias, dtype, subtype, mode )", "\t\t\thCheckPrototype( head_proc, proc, palias, dtype, subtype, mode )\n\t\t\teditorAliasSymbol(proc, head_proc)");

    /* An address expression selects its overload after consuming the name and
       optional signature. Keep the original site across that nested parse.
       Function-result assignments bind to the active body, not the overload
       head returned by name lookup. Neither form is a procedure call. */
    routine("parser-expr-unary.bas", "hProcPtrBody", (source) => {
        source = replaceOnce(source, "\t\tbyref semantic_site as LEX_LOCATION _", "\t\tbyref semantic_site as LEX_LOCATION, _\n\t\tbyref editor_site as FBEDITORLOCATION _");
        return replaceOnce(source, "\t'' Check visibility of the proc", "\teditorEmitSymbol(editor_site, proc, FALSE)\n\t'' Check visibility of the proc");
    });
    routine("parser-expr-unary.bas", "cProcPtrBody", (source) => {
        source = replaceOnce(source, "\tsym = cIdentifierOrUDTMember( base_parent, chain_ )", "\tsym = cIdentifierOrUDTMember( base_parent, chain_ )\n\tdim editor_site as FBEDITORLOCATION = editorLastToken()");
        for (const exact of ["is_exact", "FALSE"]) source = replaceOnce(source, `hProcPtrBody( base_parent, sym, ${exact}, is_vtable_index, semantic_site )`, `hProcPtrBody( base_parent, sym, ${exact}, is_vtable_index, semantic_site, editor_site )`);
        return source;
    });
    // Expression instrumentation wraps this routine before symbol hooks run.
    const addressRoutine = result["parser-expr-unary.bas"].includes("function editorOriginal_cAddrOfExpression") ? "editorOriginal_cAddrOfExpression" : "cAddrOfExpression";
    routine("parser-expr-unary.bas", addressRoutine, (source) => {
        source = replaceOnce(source, "\t\tif( sym <> NULL ) then", "\t\tif( sym <> NULL ) then\n\t\t\tdim editor_site as FBEDITORLOCATION = editorNextToken()");
        return replaceOnce(source, "hProcPtrBody( base_parent, sym, FALSE, FALSE, semantic_site )", "hProcPtrBody( base_parent, sym, FALSE, FALSE, semantic_site, editor_site )");
    });
    routine("parser-proccall.bas", "hProcSymbol", (source) => {
        source = replaceOnce(source, "\tlexSkipToken( LEXCHECK_POST_LANG_SUFFIX )", "\tdim editor_site as FBEDITORLOCATION = editorNextToken()\n\tlexSkipToken( LEXCHECK_POST_LANG_SUFFIX )");
        return replaceOnce(source, "\t'' skip the '='", "\teditorEmitSymbol(editor_site, parser.currproc, FALSE)\n\t'' skip the '='");
    });

    routine("symb-label.bas", "symbAddLabel", (source) => {
        const header = source.match(/^function[\s\S]*?\) as FBSYMBOL ptr/)[0];
        const original = header.replace("symbAddLabel", "editorOriginal_AddLabel");
        const wrapper = `${header}\n\tdim editor_site as FBEDITORLOCATION\n\tif( (symbol <> NULL) and ((options and (FB_SYMBOPT_DECLARING or FB_SYMBOPT_CREATEALIAS)) <> 0) ) then editor_site = editorNextToken()\n\tdim result as FBSYMBOL ptr = editorOriginal_AddLabel(symbol, options)\n\teditorEmitSymbol(editor_site, result, (options and FB_SYMBOPT_DECLARING) <> 0)\n\treturn result\nend function\n\n`;
        return "declare " + original + "\n\n" + wrapper + source.replace(header, original);
    });
    /* hGetLabelId() resolves both numeric and named direct branch labels. The
       identifier path uses a declaration-oriented lookup and therefore does
       not commit a normal reference record. Keep the selected label before
       lexSkipToken() removes its only written token, so GOTO name and GOTO 10
       share one native relationship. */
    routine("parser-quirk-goto-return.bas", "hGetLabelId", (source) => {
        return replaceOnce(source, "\tlexSkipToken( LEXCHECK_POST_SUFFIX )", "\teditorReference(sym)\n\tlexSkipToken( LEXCHECK_POST_SUFFIX )");
    });
    /* ON branches resolve each target in their own parser loop, rather than
       through hGetLabelId(). Capture after symbFindByClass()/symbAddLabel()
       commits the selected alias and before the label spelling is consumed.
       ON ERROR uses the same lookup shape for its single handler label. */
    routine("parser-quirk-on.bas", "cGOTBStmt", (source) => {
        return replaceOnce(source, "\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )", "\t\t\teditorReference(labels(l))\n\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )");
    });
    routine("parser-quirk-on.bas", "cOnStmt", (source) => {
        return replaceOnce(source, "\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )", "\t\t\teditorReference(label)\n\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )");
    });
    /* Single-line IF branches accept numeric labels as a compact form of
       conditional GOTO. Both THEN and ELSE parse the label locally, so emit
       their resolved aliases before consuming each numeric spelling. */
    routine("parser-compound-if.bas", "hIfSingleLine", (source) => {
        const before = "\t\tlexSkipToken( )";
        if (source.split(before).length !== 3) throw new Error("Single-line IF label hooks changed.");
        return source.split(before).join("\t\teditorReference(l)\n" + before);
    });
    /* RESTORE selects a DATA label through the same symbol table, but its
       parser is separate from ordinary control-flow branches. The selected
       label is authoritative for navigation and validated project rename. */
    routine("parser-quirk-data.bas", "cDataStmt", (source) => {
        return replaceOnce(source, "\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )\n\t\tend select\n\n\t\tfunction = rtlDataRestore( sym )", "\t\t\teditorReference(sym)\n\t\t\tlexSkipToken( LEXCHECK_POST_SUFFIX )\n\t\tend select\n\n\t\tfunction = rtlDataRestore( sym )");
    });
    return result;
}

module.exports = { SYMBOL_FILES, instrumentSymbols };

/* end of tools/compiler-symbol-hooks.js */
