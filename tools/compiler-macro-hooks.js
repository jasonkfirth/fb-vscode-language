/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/compiler-macro-hooks.js
    Purpose: Attach immutable provenance maps to native macro text operations.
    Responsibilities: instrument argument copying, definitions, and substitutions.
    Does not contain: macro evaluation or editor projection/refactoring policy.
*/

const MACRO_FILES = ["pp.bi", "pp.bas", "pp-define.bas", "symb.bi", "symb-define.bas"];

function routine(source, name, transform) {
    const match = new RegExp(`^(?:private )?(function|sub) ${name}\\b`, "m").exec(source);
    if (!match) throw new Error(`Compiler macro routine changed: ${name}`);
    const marker = `\nend ${match[1]}`;
    const end = source.indexOf(marker, match.index);
    if (end < 0) throw new Error(`Compiler macro routine terminator changed: ${name}`);
    return source.slice(0, match.index) + transform(source.slice(match.index, end + marker.length)) + source.slice(end + marker.length);
}

function instrumentMacroLexer(source, header, replaceOnce) {
    header = replaceOnce(header, "type FBEDITORCHAR\n", "type FBEDITORCHAR\n\tmap_root as integer\n\tmap_position as integer\n\tcharacter_offset as integer\n");
    header = replaceOnce(header, "type FBTOKEN\n", "type FBTOKEN\n\teditor_cached_map as integer\n\teditor_map_root as integer\n\teditor_map_start as integer\n\teditor_map_end_root as integer\n\teditor_map_end as integer\n\teditor_character_start as integer\n\teditor_character_end as integer\n");
    header = replaceOnce(header, "type LEX_TKCTX\n", "type LEX_TKCTX\n\teditor_macro_map as integer\n\teditor_macro_position as integer\n\teditor_physical_character as integer\n");
    header = replaceOnce(header, "type LEXPP_ARG\n", "type LEXPP_ARG\n\teditor_map as integer\n");
    source = replaceOnce(source, '#include once "editor-origins.bi"\n', '#include once "editor-origins.bi"\n#include once "editor-macro-maps.bi"\n#include once "editor-preprocessor.bi"\n');
    header = replaceOnce(header, "type FBTOKEN\n", "type FBTOKEN\n\teditor_macro_epoch as integer\n");
    source = replaceOnce(source, "\tlex.ctx->editor_physical_byte = 0\n", "\tlex.ctx->editor_physical_byte = 0\n\tlex.ctx->editor_physical_character = 0\n\tlex.ctx->editor_macro_map = 0\n\tlex.ctx->editor_macro_position = 0\n");
    source = replaceOnce(source, "\t\tlex.ctx->deflen -= 1\n", "\t\tlex.ctx->deflen -= 1\n\t\tlex.ctx->editor_macro_position += 1\n");
    source = replaceOnce(source, "\t\tlex.ctx->editor_physical_byte = lex.ctx->editor_read.byte_end\n", "\t\tlex.ctx->editor_physical_byte = lex.ctx->editor_read.byte_end\n\t\tlex.ctx->editor_physical_character = lex.ctx->editor_read.character_offset + 1\n");
    const macroCallAnchors = [
        {
            before: "\t\t\tif( ppDefineLoad( t.sym_chain->sym, currmacro, macrodepth, @macrostack(0), @macroresume(0) ) ) then",
            after: "\t\t\tif( ppDefineLoad( t.sym_chain->sym, currmacro, macrodepth, @macrostack(0), @macroresume(0), editorTokenMap(@t) ) ) then"
        },
        {
            before: "\t\t\tif( ppDefineLoad( t.sym_chain->sym, currmacro, macrodepth, @macrostack(0), @macroresume(0), @t.source ) ) then",
            after: "\t\t\tif( ppDefineLoad( t.sym_chain->sym, currmacro, macrodepth, @macrostack(0), @macroresume(0), @t.source, editorTokenMap(@t) ) ) then"
        }
    ];
    const macroCall = macroCallAnchors.find((anchor) => source.includes(anchor.before));
    if (!macroCall) throw new Error("Compiler macro call hook changed: ppDefineLoad");
    source = replaceOnce(source, macroCall.before, "\t\t\teditorEndSourceToken(@t)\n" + macroCall.after);
    return { source, header };
}

function instrumentMacros(files, replaceOnce) {
    const result = { ...files };
    result["symb.bi"] = replaceOnce(result["symb.bi"], "type FB_DEFTOK\n", "type FB_DEFTOK\n\teditor_map as integer\n");
    result["symb.bi"] = replaceOnce(result["symb.bi"], "type FBS_DEFINE\n", "type FBS_DEFINE\n\teditor_map as integer\n");
    for (const name of ["symbAddDefine", "symbAddDefineW", "symbAddDefineMacro"]) result["symb-define.bas"] = routine(result["symb-define.bas"], name, (source) => replaceOnce(source, "\tfunction = sym\n", "\tsym->def.editor_map = 0\n\tfunction = sym\n"));
    result["symb-define.bas"] = routine(result["symb-define.bas"], "symbAddDefineTok", (source) => replaceOnce(source, "\tt->prev = lasttok\n", "\tt->editor_map = 0\n\tt->prev = lasttok\n"));
    const macroLoadParameters = [
        {
            before: "\t\tbyval macroresume as integer ptr _\n\t) as integer",
            after: "\t\tbyval macroresume as integer ptr, _\n\t\tbyval editor_site as integer _\n\t) as integer"
        },
        {
            before: "\t\tbyval macroresume as integer ptr, _\n\t\tbyval source as LEX_LOCATION ptr _\n\t) as integer",
            after: "\t\tbyval macroresume as integer ptr, _\n\t\tbyval source as LEX_LOCATION ptr, _\n\t\tbyval editor_site as integer _\n\t) as integer"
        }
    ];
    const macroLoadParameter = macroLoadParameters.find((candidate) =>
        result["pp.bi"].includes(candidate.before) && result["pp-define.bas"].includes(candidate.before));
    if (!macroLoadParameter) throw new Error("Compiler macro loader signature changed: ppDefineLoad");
    result["pp.bi"] = replaceOnce(result["pp.bi"], macroLoadParameter.before, macroLoadParameter.after);
    let define = result["pp-define.bas"];
    define = routine(define, "ppDefineLoad", (source) => {
        source = replaceOnce(source, macroLoadParameter.before, macroLoadParameter.after);
        source = replaceOnce(source, "\tvar olddeflen = lex.ctx->deflen\n", "\tvar olddeflen = lex.ctx->deflen\n\tdim editor_previous as FBEDITORMACROFRAME = editorEnterMacro(editor_site, s)\n");
        /* A macro argument is collected from the character stream, before the
           ordinary statement parser can recover. An opening parenthesis at a
           physical line ending therefore used to consume the next editor
           statement while looking for the first argument. Explicit line
           continuation has already been folded before this test. Trace mode
           substitutes one generated recovery value for the invalid invocation
           and leaves the next source line for normal compiler analysis. */
        const loadVariants = [
            "\tif( env.inf.format = FBFILE_FORMAT_ASCII ) then\n\t\tloaded = hLoadDefine( s )\n\telse\n\t\tloaded = hLoadDefineW( s )\n\tend if",
            "\tif( env.inf.format = FBFILE_FORMAT_ASCII ) then\n\t\tloaded = hLoadDefine( s, observation, replacement_units, argument_count, ending, outcome )\n\telse\n\t\tloaded = hLoadDefineW( s, observation, replacement_units, argument_count, ending, outcome )\n\tend if"
        ];
        const load = loadVariants.find((candidate) => source.includes(candidate));
        if (!load) throw new Error("Compiler macro expansion hook changed: hLoadDefine");
        const recovered = "\tif( environ(\"FB_VSCODE_TRACE\") = \"1\" ) andalso _\n\t   (symbGetDefineParams( s ) > 0) andalso _\n\t   (lexCurrentChar( ) = CHAR_LPRNT) andalso _\n\t   (lexGetLookAheadChar( ) = CHAR_LF) then\n\t\t'' Do not let an incomplete macro invocation consume the next statement.\n\t\terrReport( FB_ERRMSG_EXPECTEDEXPRESSION )\n\t\tlexEatChar( )\n\t\tif( lex.ctx->deflen = 0 ) then\n\t\t\tDWstrAssignA( lex.ctx->deftextw, \"0\" )\n\t\telse\n\t\t\tDWstrAssign( lex.ctx->deftextw, wstr(\"0\") + *lex.ctx->defptrw )\n\t\tend if\n\t\tlex.ctx->defptrw = lex.ctx->deftextw.data\n\t\tlex.ctx->deflen += 1\n\t\tloaded = TRUE\n\telse\n" + load.replace(/^/gm, "\t") + "\n\tend if";
        const recoveredLoad = load.includes("outcome")
            ? recovered.replace("\t\tloaded = TRUE\n", "\t\tloaded = TRUE\n\t\toutcome = \"not-invoked\"\n")
            : recovered;
        source = replaceOnce(source, load, recoveredLoad);
        return replaceOnce(source, "\tfunction = loaded\n", "\teditorLeaveMacro(editor_previous)\n\tfunction = loaded\n");
    });

    // Argument storage is pooled with NOCLEAR. Reset the sidecar everywhere
    // the native reader resets text, including missing optional variadics.
    const clear = /(\t+)(D[ZW]strZero\( argtb->tb\(num\)\.textw? \))/g;
    if ([...define.matchAll(clear)].length !== 4) throw new Error("Compiler macro argument initialization changed.");
    define = define.replace(clear, "$1argtb->tb(num).editor_map = 0\n$1$2");
    define = routine(define, "hTrimMacroArg", (source) => {
        source = replaceOnce(source, "\twith( argtb->tb(num) )\n", "\twith( argtb->tb(num) )\n\t\tdim editor_leading as integer\n\t\tif( is_wide ) then\n\t\t\tif( .textw.data ) then editor_leading = len(*.textw.data) - len(ltrim(*.textw.data, any wchr(CHAR_SPACE, CHAR_TAB)))\n\t\telse\n\t\t\tif( .text.data ) then editor_leading = len(*.text.data) - len(ltrim(*.text.data, any chr(CHAR_SPACE, CHAR_TAB)))\n\t\tend if\n");
        return replaceOnce(source, "\tend with\n", "\t\tdim editor_length as integer\n\t\tif( is_wide ) then\n\t\t\tif( .textw.data ) then editor_length = len(*.textw.data)\n\t\telse\n\t\t\tif( .text.data ) then editor_length = len(*.text.data)\n\t\tend if\n\t\t.editor_map = editorSliceMap(.editor_map, editor_leading, editor_length)\n\tend with\n");
    });

    for (const wide of [false, true]) define = routine(define, wide ? "hLoadMacroW" : "hLoadMacro", (source) => {
        const buffer = wide ? "text" : "expanded";
        const argument = wide ? "textw" : "text";
        source = replaceOnce(source, "\tfunction = -1\n", "\tdim as integer editor_result, editor_inputs\n\tfunction = -1\n");
        // Builtin callbacks own their argument table and may release it while
        // evaluating nested text. Capture immutable input edges before entry.
        const callback = "\tif( symbGetMacroCallbackZ( s ) <> NULL ) then\n";
        source = replaceOnce(source, callback, callback + `\t\tif( argtb <> NULL ) then
\t\t\tfor editor_arg as integer = 0 to argtb->count - 1
\t\t\t\tdim editor_map as integer = argtb->tb(editor_arg).editor_map
\t\t\t\tdim editor_length as integer = editorMapLength(editor_map)
\t\t\t\tdim editor_piece as integer = editorWrapMap(5, editor_map, editor_length, editor_arg)
\t\t\t\teditorAppendMap(editor_inputs, editor_piece, editor_length)
\t\t\tnext
\t\tend if
`);
        const appendStart = `\t\t\tif( argtb <> NULL ) then\n\t\t\t\tif( t.dtype`;
        const appendStartVariants = [
            appendStart,
            "\t\t\tif( argtb <> NULL ) then\n\t\t\t\thObserveMacroSource(@argtb->tb(num), t.source)"
        ];
        const appendAnchor = appendStartVariants.find((candidate) => source.includes(candidate));
        if (!appendAnchor) throw new Error(`Compiler macro argument hook changed: ${wide ? "hLoadMacroW" : "hLoadMacro"}`);
        const [outerCondition, innerCondition] = appendAnchor.split("\n");
        const editorStart = `\t\t\t\tdim editor_before as integer = argtb->tb(num).${argument}.len`;
        source = replaceOnce(source, appendAnchor, `${outerCondition}\n${editorStart}\n${innerCondition}`);
        const appended = `\t\t\t\tend if\n\t\t\tend if\n\t\tloop\n\n\t\thTrimMacroArg`;
        source = replaceOnce(source, appended, `\t\t\t\tend if\n\t\t\t\teditorAppendMap(argtb->tb(num).editor_map, editorTokenMap(@t), argtb->tb(num).${argument}.len - editor_before)\n\t\t\tend if\n\t\tloop\n\n\t\thTrimMacroArg`);
        source = replaceOnce(source, "\t\t\tdo while( dt )\n", `\t\t\tdo while( dt )\n\t\t\t\tdim editor_before as integer = ${buffer}.len\n`);
        const advance = "\t\t\t\t'' next\n\t\t\t\tdt = symbGetDefTokNext( dt )";
        source = replaceOnce(source, advance, `\t\t\t\tdim editor_piece as integer\n\t\t\t\tdim editor_length as integer = ${buffer}.len - editor_before\n\t\t\t\tselect case symbGetDefTokType(dt)\n\t\t\t\tcase FB_DEFTOK_TYPE_PARAM\n\t\t\t\t\teditor_piece = editorWrapMap(5, argtb->tb(symbGetDefTokParamNum(dt)).editor_map, editor_length, symbGetDefTokParamNum(dt))\n\t\t\t\tcase FB_DEFTOK_TYPE_PARAMSTR\n\t\t\t\t\teditor_piece = editorWrapMap(7, argtb->tb(symbGetDefTokParamNum(dt)).editor_map, editor_length, symbGetDefTokParamNum(dt))\n\t\t\t\tcase else\n\t\t\t\t\teditor_piece = editorWrapMap(6, dt->editor_map, editor_length)\n\t\t\t\tend select\n\t\t\t\teditorAppendMap(editor_result, editor_piece, editor_length)\n\n` + advance);
        const prepend = "\tif( lex.ctx->deflen = 0 ) then\n";
        const length = wide ? "len(*text.data)" : "len(text)";
        source = replaceOnce(source, prepend, `\tif( symbGetMacroCallbackZ(s) <> NULL ) then editor_result = editorWrapMap(8, editor_inputs, ${length})\n\tif( editorMapLength(editor_result) < ${length} ) then editorAppendMap(editor_result, 0, ${length} - editorMapLength(editor_result))\n\teditorPrependMap(editor_result, ${length})\n` + prepend);
        return source;
    });
    for (const wide of [false, true]) define = routine(define, wide ? "hLoadDefineW" : "hLoadDefine", (source) => {
        const before = wide ? "\tlex.ctx->defptrw = lex.ctx->deftextw.data\n" : "\tlex.ctx->defptr = lex.ctx->deftext.data\n";
        return replaceOnce(source, before, "\tif( symbGetDefineParams(s) = 0 ) then\n\t\tdim editor_kind as integer = iif(symbGetDefineCallback(s) = NULL, 6, 8)\n\t\teditorPrependMap(editorWrapMap(editor_kind, s->def.editor_map, lgt), lgt)\n\tend if\n" + before);
    });
    // Replacement-list tokens retain their source before lexSkipToken changes
    // the current token. Condensed spaces/newlines keep explicit unknown maps.
    define = routine(define, "hReadMacroText", (source) => {
        const assignment = /(\t+)((?:ZstrAssign|WstrAssign)\( @toktail->textw?, lexGetTextW?\( \) \))/g;
        if ([...source.matchAll(assignment)].length !== 4) throw new Error("Compiler replacement-list token assignments changed.");
        return source.replace(assignment, "$1toktail->editor_map = editorTokenMap(lex.ctx->head)\n$1$2");
    });
    define = routine(define, "hReadDefineText", (source) => {
        source = replaceOnce(source, "\tdim as zstring ptr text = any\n", "\tdim as integer editor_result\n\tdim as zstring ptr text = any\n");
        for (const wide of [false, true]) {
            const suffix = wide ? "W" : "";
            const text = wide ? "textw" : "text";
            source = replaceOnce(source, `${text} = ppReadLiteral${suffix}( ismultiline, @numeric_head )`, `${text} = ppReadLiteral${suffix}( ismultiline, @numeric_head, @editor_result )`);
            const call = `symbAddDefine${suffix}( defname, ${text}, len( *${text} ), isargless, , flags )`;
            const added = `\t\t\tdim as FBSYMBOL ptr added = ${call}\n`;
            source = replaceOnce(source, added,
                `${added}\t\t\tif( added <> NULL ) then added->def.editor_map = editor_result\n\t\t\tsym = added\n`);
        }
        return source;
    });
    for (const wide of [false, true]) {
        const name = wide ? "ppReadLiteralW" : "ppReadLiteral";
        const type = wide ? "wstring" : "zstring";
        result["pp.bi"] = replaceOnce(result["pp.bi"], `\t\tbyval numeric_head as integer ptr = NULL _\n\t) as ${type} ptr`, `\t\tbyval numeric_head as integer ptr = NULL, _\n\t\tbyval editor_map as integer ptr = NULL _\n\t) as ${type} ptr`);
        result["pp.bas"] = routine(result["pp.bas"], name, (source) => {
            source = replaceOnce(source, `\t\tbyval numeric_head as integer ptr _\n\t) as ${type} ptr`, `\t\tbyval numeric_head as integer ptr, _\n\t\tbyval editor_map as integer ptr _\n\t) as ${type} ptr`);
            source = replaceOnce(source, "\tdim as integer nestedcnt = 0\n", "\tdim as integer nestedcnt = 0\n\tdim as integer editor_result\n");
            const append = /(\t+)(D[ZW]strConcatAssign(?:A)?\( text, (?:wstr\( )?(?:LFCHAR|" "|"##")(?: \))? \))/g;
            if ([...source.matchAll(append)].length !== 3) throw new Error(`Compiler literal whitespace operations changed: ${name}`);
            source = source.replace(append, (match, indent, statement) => `${indent}${statement}\n${indent}editorAppendMap(editor_result, 0, text.len - editorMapLength(editor_result))`);
            const anything = "\t\t'' anything else..\n";
            source = replaceOnce(source, anything, anything + "\t\tdim editor_before as integer = text.len\n");
            source = replaceOnce(source, "\t\tend if\n\n\t\tlexSkipToken( LEX_FLAGS )\n\n\tloop", "\t\tend if\n\t\teditorAppendMap(editor_result, editorTokenMap(lex.ctx->head), text.len - editor_before)\n\n\t\tlexSkipToken( LEX_FLAGS )\n\n\tloop");
            source = replaceOnce(source, "\t\t\texit do\n\n\t\tend select", "\t\t\teditorAppendMap(editor_result, 0, text.len - editorMapLength(editor_result))\n\t\t\texit do\n\n\t\tend select");
            return replaceOnce(source, "\tfunction = text.data\n", "\tif( editor_map <> NULL ) then *editor_map = editorSliceMap(editor_result, 0, text.len)\n\tfunction = text.data\n");
        });
    }
    result["pp-define.bas"] = define;
    return result;
}

module.exports = { MACRO_FILES, instrumentMacros, instrumentMacroLexer };

/* end of tools/compiler-macro-hooks.js */
