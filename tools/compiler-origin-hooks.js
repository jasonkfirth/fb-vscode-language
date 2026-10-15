/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/compiler-origin-hooks.js
    Purpose: Add physical character and token provenance to the private lexer.
    Responsibilities: keep source cursors aligned with buffering and lookahead.
    Does not contain: editor projection, source rewriting, or macro expansion.
*/

const { instrumentMacroLexer } = require("./compiler-macro-hooks");

function instrumentOrigins(source, header, replaceOnce) {
    const location = "type FBEDITORCHAR\n\tbyte_start as integer\n\tbyte_end as integer\n\tdirect as integer\nend type\n\n";
    header = replaceOnce(header, "type FBTOKEN\n", location + "type FBTOKEN\n\teditor_physical_file as zstring * FB_MAXPATHLEN\n\teditor_physical_start as integer\n\teditor_physical_end as integer\n\teditor_physical_start_line as integer\n\teditor_physical_start_column as integer\n\teditor_physical_end_line as integer\n\teditor_physical_end_column as integer\n\teditor_physical_direct as integer\n\teditor_indirect_chars as integer\n");
    header = replaceOnce(header, "type LEX_TKCTX\n", "type LEX_TKCTX\n\teditor_physical_file as zstring * FB_MAXPATHLEN\n\teditor_physical_byte as integer\n\teditor_read as FBEDITORCHAR\n\teditor_current as FBEDITORCHAR\n\teditor_lookahead1 as FBEDITORCHAR\n\teditor_lookahead2 as FBEDITORCHAR\n\teditor_consumed as FBEDITORCHAR\n\teditor_indirect_chars as integer\n\teditor_probe as integer\n");
    source = replaceOnce(source, '#include once "editor-trace.bi"\n', '#include once "editor-trace.bi"\n#include once "editor-origins.bi"\n');
    source = replaceOnce(source, "\tprobe.ctx = *parent\n", "\tprobe.ctx = *parent\n\tprobe.ctx.editor_probe = TRUE\n");
    source = replaceOnce(source, "\tlex.ctx->kind = ctx_kind\n", "\tlex.ctx->kind = ctx_kind\n\tlex.ctx->editor_physical_file = \"\"\n\tlex.ctx->editor_physical_byte = 0\n\tlex.ctx->editor_read.direct = FALSE\n\tlex.ctx->editor_current.direct = FALSE\n\tlex.ctx->editor_lookahead1.direct = FALSE\n\tlex.ctx->editor_lookahead2.direct = FALSE\n\tlex.ctx->editor_consumed.direct = FALSE\n\tlex.ctx->editor_indirect_chars = 0\n\tlex.ctx->editor_probe = FALSE\n");
    source = replaceOnce(source, "\tfunction = char\n", "\teditorReadSourceChar(char)\n\tfunction = char\n");
    source = replaceOnce(source, "sub lexEatChar( )\n", "sub lexEatChar( )\n\teditorConsumeChar()\n");
    const shift = "\t\tlex.ctx->currchar = lex.ctx->lahdchar1\n";
    if (source.split(shift).length !== 3) throw new Error("Compiler bridge character lookahead changed.");
    source = source.replaceAll(shift, shift + "\t\tlex.ctx->editor_current = lex.ctx->editor_lookahead1\n");
    source = replaceOnce(source, "\t\tlex.ctx->lahdchar1 = lex.ctx->lahdchar2\n", "\t\tlex.ctx->lahdchar1 = lex.ctx->lahdchar2\n\t\tlex.ctx->editor_lookahead1 = lex.ctx->editor_lookahead2\n");
    source = replaceOnce(source, "\telseif( lex.ctx->currchar <> 0 ) then\n", "\telseif( lex.ctx->currchar <> 0 ) then\n\t\tlex.ctx->editor_physical_byte = lex.ctx->editor_read.byte_end\n");
    for (const [character, origin] of [["currchar", "editor_current"], ["lahdchar1", "editor_lookahead1"], ["lahdchar2", "editor_lookahead2"]]) {
        const read = `\t\tlex.ctx->${character} = hReadChar( )\n`;
        source = replaceOnce(source, read, read + `\t\tlex.ctx->${origin} = lex.ctx->editor_read\n`);
    }
    source = replaceOnce(source, "\tt->editor_file = env.inf.name\n", "\teditorBeginSourceToken(t)\n\tt->editor_file = env.inf.name\n");
    source = replaceOnce(source, "\tloop while( reread )\n", "\t\tif( reread = FALSE ) then editorEndSourceToken(t)\n\tloop while( reread )\n");
    source = replaceOnce(source, "\teditor_last_token.byte_end = len(pponly_ln)", "\teditor_last_token.byte_end = len(pponly_ln)\n\teditorEmitSourceToken()");
    return instrumentMacroLexer(source, header, replaceOnce);
}

module.exports = { instrumentOrigins };

/* end of tools/compiler-origin-hooks.js */
