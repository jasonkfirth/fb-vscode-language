/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/compiler-preprocessor-hooks.js
    Purpose: Instrument committed macro declarations and preprocessor lookups.
    Responsibilities: preserve pooled parameter sites and actual lookup results.
    Does not contain: preprocessing, compiler builds, or editor refactoring rules.
*/

const PREPROCESSOR_FILES = ["symb.bi", "symb-define.bas", "pp-define.bas", "pp.bas", "pp-cond.bas", "parser.bi", "parser-identifier.bas", "parser-expr-unary.bas"];

function instrumentPreprocessor(files, replaceOnce) {
    const result = { ...files };
    function routine(file, name, transform) {
        const source = result[file];
        const match = new RegExp(`^(?:private )?(function|sub) ${name}\\b`, "m").exec(source);
        if (!match) throw new Error(`Compiler preprocessor routine changed: ${name}`);
        const marker = `\nend ${match[1]}`;
        const end = source.indexOf(marker, match.index);
        if (end < 0) throw new Error(`Compiler preprocessor terminator changed: ${name}`);
        result[file] = source.slice(0, match.index) + transform(source.slice(match.index, end + marker.length)) + source.slice(end + marker.length);
    }
    result["symb.bi"] = replaceOnce(result["symb.bi"], "type FB_DEFPARAM\n", "type FB_DEFPARAM\n\teditor_map as integer\n");
    routine("symb-define.bas", "symbAddDefineParam", (source) => replaceOnce(source, "\tparam = listNewNode( @symb.def.paramlist )", "\tparam = listNewNode( @symb.def.paramlist )\n\tparam->editor_map = 0"));
    routine("pp-define.bas", "hReadMacroText", (source) => replaceOnce(source, "\t\t\t\tsymbSetDefTokParamNum( toktail, symbGetDefParamNum( param ) )", "\t\t\t\ttoktail->editor_map = editorTokenMap(lex.ctx->head)\n\t\t\t\tsymbSetDefTokParamNum( toktail, symbGetDefParamNum( param ) )"));
    routine("pp-define.bas", "hReadDefineText", (source) => {
        // Return the committed symbol through the existing local. This changes
        // no compiler decision; the caller previously discarded that identity.
        source = replaceOnce(source, "\t\tbyval sym as FBSYMBOL ptr, _", "\t\tbyref sym as FBSYMBOL ptr, _");
        const created = /\t\t\tif\( added <> NULL \) then added->def\.editor_map = editor_result\n\t\t\tsym = added\n/g;
        if ([...source.matchAll(created)].length !== 2) throw new Error("Compiler literal definition hooks changed.");
        return source;
    });
    routine("pp-define.bas", "ppDefine", (source) => {
        source = replaceOnce(source, "\t'' note: using the PP hashtb here", "\tdim editor_errors as integer = errGetCount()\n\t'' note: using the PP hashtb here");
        source = replaceOnce(source, "\tlexEatToken( @defname, flags )", "\tdim editor_site as integer = editorTokenMap(lex.ctx->head)\n\tlexEatToken( @defname, flags )");
        const parameter = "\t\t\t\t\tlastparam = symbAddDefineParam( lastparam, lexGetText( ) )";
        source = replaceOnce(source, parameter, parameter + "\n\t\t\t\t\tif( lastparam <> NULL ) then lastparam->editor_map = editorTokenMap(lex.ctx->head)");
        const literal = "\t\thReadDefineText( sym, @defname, isargless, ismultiline, define_flags )";
        source = replaceOnce(source, literal, literal + "\n\t\tif( errGetCount() = editor_errors ) then editorMacroDeclaration(sym, editor_site, NULL, NULL)");
        source = replaceOnce(source, "\t\tsymbDelDefineMacroData( tokhead, paramhead )\n\telse", "\t\tif( errGetCount() = editor_errors ) then editorMacroDeclaration(sym, editor_site, paramhead, tokhead)\n\t\tsymbDelDefineMacroData( tokhead, paramhead )\n\telse");
        const create = "\t\tsym = symbAddDefineMacro( @defname, tokhead, params, paramhead, define_flags )";
        const legacyCreate = "\t\tif( symbAddDefineMacro( @defname, tokhead, params, paramhead, define_flags ) = NULL ) then";
        if (source.includes(create)) {
            return replaceOnce(source, create,
                `${create}\n\t\tif( (sym <> NULL) and (errGetCount() = editor_errors) ) then editorMacroDeclaration(sym, editor_site, paramhead, tokhead)`);
        }
        return replaceOnce(source, legacyCreate,
            `${legacyCreate.replace("if( symbAddDefineMacro( @defname, tokhead, params, paramhead, define_flags ) = NULL ) then", "sym = symbAddDefineMacro( @defname, tokhead, params, paramhead, define_flags )")}\n\t\tif( (sym <> NULL) and (errGetCount() = editor_errors) ) then editorMacroDeclaration(sym, editor_site, paramhead, tokhead)\n\t\tif( sym = NULL ) then`);
    });
    routine("pp-define.bas", "ppDefineLoad", (source) => replaceOnce(source, "\t'' recursion?\n", "\teditorMacroReference(s, editor_site, \"invoke\", symbGetName(s))\n\t'' recursion?\n"));
    result["pp.bas"] = replaceOnce(result["pp.bas"], "\t\t\t\t\tsymbDelFromHash( sym )", "\t\t\t\t\teditorMacroReference(sym, editorTokenMap(lex.ctx->head), \"undef\", lexGetText())\n\t\t\t\t\tsymbDelFromHash( sym )");
    /* pp-cond.bas is compiled as a separate module. Declare the bridge hook
       there instead of depending on source-file order during the compiler
       bridge build. The definition remains in editor-preprocessor.bi. */
    result["pp-cond.bas"] = replaceOnce(result["pp-cond.bas"], "declare sub ppSkip( )", "declare sub ppSkip( )\ndeclare sub editorPreprocessorContext( byval site as integer )");

    // Query the exact result chosen by cIdentifierOrUDTMember. Its caller
    // opts in for #ifdef/#ifndef/defined(); procedure-address lookup does not.
    const signature = "\t\tbyval chain_ as FBSYMCHAIN ptr = NULL _\n\t) as FBSYMBOL ptr";
    const changed = "\t\tbyval chain_ as FBSYMCHAIN ptr = NULL, _\n\t\tbyval editor_query as integer = FALSE _\n\t) as FBSYMBOL ptr";
    const declaration = result["parser.bi"].match(/declare function cIdentifierOrUDTMember _[\s\S]*?\) as FBSYMBOL ptr/);
    if (!declaration) throw new Error("Compiler identifier query declaration changed.");
    result["parser.bi"] = replaceOnce(result["parser.bi"], declaration[0], replaceOnce(declaration[0], signature, changed));
    routine("parser-identifier.bas", "cIdentifierOrUDTMember", (source) => {
        source = replaceOnce(source, signature, changed);
        return replaceOnce(source, "\t'' not defined if symbol was not found", "\tif( editor_query ) then\n\t\t'' cIdentifier() has consumed every namespace prefix. At this point\n\t\t'' chain_ and the lexer head both name the final queried member.\n\t\tdim editor_symbol as FBSYMBOL ptr\n\t\tif( chain_ <> NULL ) then editor_symbol = chain_->sym\n\t\teditorMacroReference(editor_symbol, editorTokenMap(lex.ctx->head), \"query\", lexGetText())\n\tend if\n\n\t'' not defined if symbol was not found");
    });
    for (const [file, count] of [["pp-cond.bas", 1], ["parser-expr-unary.bas", 1]]) {
        const call = /cIdentifierOrUDTMember\( \)/g;
        if ([...result[file].matchAll(call)].length !== count) throw new Error(`Compiler preprocessor queries changed: ${file}`);
        result[file] = result[file].replace(call, "cIdentifierOrUDTMember( , , TRUE )");
    }
    /* A preprocessed file has no conditional directive tokens. Capture the
       compiler's current macro epoch against the directive's own physical map
       before its operand is read, rather than extrapolating from output text. */
    routine("pp-cond.bas", "ppCondIf", (source) => {
        const signature = "sub ppCondIf( )\n";
        return replaceOnce(source, signature, `${signature}\tdim as integer editor_context = editorTokenMap(lex.ctx->head)\n\teditorPreprocessorContext(editor_context)\n`);
    });
    routine("pp-cond.bas", "ppCondElse", (source) => replaceOnce(source,
        "case FB_TK_PP_ELSEIF, FB_TK_PP_ELSEIFDEF, FB_TK_PP_ELSEIFNDEF\n",
        "case FB_TK_PP_ELSEIF, FB_TK_PP_ELSEIFDEF, FB_TK_PP_ELSEIFNDEF\n\t\tdim as integer editor_context = editorTokenMap(lex.ctx->head)\n\t\teditorPreprocessorContext(editor_context)\n"));
    routine("pp-cond.bas", "ppSkip", (source) => {
        /* A nested condition inside an already skipped branch is not parsed,
           but the compiler's unchanged macro epoch is still authoritative.
           The matching ELSEIF is delegated to ppCondElse(), which records its
           own context after it resumes normal conditional processing. */
        source = replaceOnce(source,
            "case FB_TK_PP_IF, FB_TK_PP_IFDEF, FB_TK_PP_IFNDEF\n\t\t\t\tdim as LEX_LOCATION source",
            "case FB_TK_PP_IF, FB_TK_PP_IFDEF, FB_TK_PP_IFNDEF\n\t\t\t\teditorPreprocessorContext(editorTokenMap(lex.ctx->head))\n\t\t\t\tdim as LEX_LOCATION source");
        return replaceOnce(source,
            "case FB_TK_PP_ELSE, FB_TK_PP_ELSEIF, _\n\t\t\t     FB_TK_PP_ELSEIFDEF, FB_TK_PP_ELSEIFNDEF\n\t\t\t\tselect case( iflevel )",
            "case FB_TK_PP_ELSE, FB_TK_PP_ELSEIF, _\n\t\t\t     FB_TK_PP_ELSEIFDEF, FB_TK_PP_ELSEIFNDEF\n\t\t\t\tif( iflevel > pp.level ) then\n\t\t\t\t\tselect case as const lexGetToken( LEXCHECK_KWDNAMESPC )\n\t\t\t\t\tcase FB_TK_PP_ELSEIF, FB_TK_PP_ELSEIFDEF, FB_TK_PP_ELSEIFNDEF\n\t\t\t\t\t\teditorPreprocessorContext(editorTokenMap(lex.ctx->head))\n\t\t\t\t\tend select\n\t\t\t\tend if\n\t\t\t\tselect case( iflevel )");
    });
    return result;
}

module.exports = { PREPROCESSOR_FILES, instrumentPreprocessor };

/* end of compiler-preprocessor-hooks.js */
