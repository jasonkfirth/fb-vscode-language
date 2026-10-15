/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/compiler-scope-hooks.js
    Purpose: Connect source scopes to committed compiler parser regions.
    Responsibilities: hook native blocks, containers, procedure bodies, and imports.
    Does not contain: compiler execution or a substitute scope parser.
*/

const SCOPE_FILES = ["ast-node-scope.bas", "parser-proc.bas", "parser-decl-struct.bas", "parser-decl-enum.bas", "parser-compound-namespace.bas", "symb-namespace.bas", "symb-struct.bas"];

function instrumentScopes(files, replaceOnce) {
    const result = { ...files };
    function routine(file, name, transform) {
        const source = result[file];
        const match = source.match(new RegExp(`^(?:private )?(function|sub) ${name}\\b`, "m"));
        if (!match) throw new Error(`Compiler scope hook changed: ${file}: ${name}`);
        const end = source.indexOf(`\nend ${match[1]}`, match.index);
        if (end < 0) throw new Error(`Unterminated compiler scope routine: ${name}`);
        const limit = end + `\nend ${match[1]}`.length;
        result[file] = source.slice(0, match.index) + transform(source.slice(match.index, limit)) + source.slice(limit);
    }
    for (const file of ["ast-node-scope.bas", "symb-namespace.bas", "symb-struct.bas"]) {
        const includeLine = ['#include once "fbint.bi"', '#include once "core/fbint.bi"']
            .find((candidate) => result[file].includes(candidate));
        if (!includeLine) throw new Error(`Compiler scope include hook changed: ${file}`);
        result[file] = replaceOnce(result[file], includeLine, `${includeLine}\n#include once "editor-api.bi"`);
    }
    routine("ast-node-scope.bas", "astScopeBegin", (source) => replaceOnce(source, "\tfunction = n", "\tdim editor_site as FBEDITORLOCATION = editorLastToken()\n\teditorOpenScope(editor_site, s, \"scope\")\n\tfunction = n"));
    routine("ast-node-scope.bas", "astScopeEnd", (source) => replaceOnce(source, "\ts = n->sym", "\ts = n->sym\n\teditorCloseScope(s)"));
    routine("parser-proc.bas", "cProcStmtBegin", (source) => {
        source = replaceOnce(source, "\tdim as integer tkn = any", "\tdim editor_start as FBEDITORLOCATION = editorNextToken()\n\tdim as integer tkn = any");
        return replaceOnce(source, "\tastProcBegin( proc, FALSE )", "\tastProcBegin( proc, FALSE )\n\teditorOpenScope(editor_start, proc, \"procedure\")");
    });
    routine("parser-proc.bas", "cProcStmtEnd", (source) => replaceOnce(source, "\tastProcEnd( FALSE )", "\teditorCloseScope(parser.currproc)\n\tastProcEnd( FALSE )"));
    routine("parser-proc.bas", "cProcHeader", (source) => {
        source = replaceOnce(source, "\tif( hResolveProcParent(", "\tdim editor_keyword as FBEDITORLOCATION = editorLastToken()\n\tif( hResolveProcParent(");
        source = replaceOnce(source, "\tdim as FBEDITORLOCATION editor_site = editorNextToken()", "\tdim as FBEDITORLOCATION editor_site = editorNextToken()\n\tif( tk = FB_TK_CONSTRUCTOR or tk = FB_TK_DESTRUCTOR ) then editor_site = editor_keyword");
        const emit = "editorEmitProcedure( editor_site, proc, TRUE )";
        if (source.split(emit).length !== 3) throw new Error("Compiler procedure inventory hooks changed.");
        return source.split(emit).join(emit + "\n\teditorDeclareSymbol(editor_site, proc, abs((options and FB_PROCOPT_ISPROTO) <> 0))");
    });
    routine("parser-decl-struct.bas", "hTypeAdd", (source) => {
        source = replaceOnce(source, "\tdim as FBSYMBOL ptr s = any\n", "\tdim as FBSYMBOL ptr s = any\n\tdim editor_recovered as integer = FALSE\n");
        source = replaceOnce(source, "\t'' Comment? SttSeparator", "\tdim editor_site as FBEDITORLOCATION = editorLastToken()\n\teditorOpenScope(editor_site, s, iif(isunion, \"union\", \"type\"))\n\t'' Comment? SttSeparator");
        source = replaceOnce(source, "\tif( lexGetToken( ) <> FB_TK_END ) then\n\t\terrReport( FB_ERRMSG_EXPECTEDENDTYPE )", "\tif( lexGetToken( ) <> FB_TK_END ) then\n\t\teditor_recovered = TRUE\n\t\terrReport( FB_ERRMSG_EXPECTEDENDTYPE )");
        source = replaceOnce(source, "\t\tif( lexGetToken( ) <> iif( isunion, FB_TK_UNION, FB_TK_TYPE ) ) then\n\t\t\terrReport( FB_ERRMSG_EXPECTEDENDTYPE )", "\t\tif( lexGetToken( ) <> iif( isunion, FB_TK_UNION, FB_TK_TYPE ) ) then\n\t\t\teditor_recovered = TRUE\n\t\t\terrReport( FB_ERRMSG_EXPECTEDENDTYPE )");
        return replaceOnce(source, "\tfunction = s", "\teditorCloseScope(s, editor_recovered)\n\tfunction = s");
    });
    routine("parser-decl-enum.bas", "cEnumDecl", (source) => {
        source = replaceOnce(source, "\tdim as FBSYMBOL ptr e = any\n", "\tdim as FBSYMBOL ptr e = any\n\tdim editor_recovered as integer = FALSE\n");
        source = replaceOnce(source, "\t'' Comment? SttSeparator", "\tdim editor_start as FBEDITORLOCATION = editorLastToken()\n\teditorOpenScope(editor_start, e, \"enum\")\n\t'' Comment? SttSeparator");
        source = replaceOnce(source, "\tif( lexGetToken( ) <> FB_TK_END ) then\n\t\terrReport( FB_ERRMSG_EXPECTEDENDENUM )", "\tif( lexGetToken( ) <> FB_TK_END ) then\n\t\teditor_recovered = TRUE\n\t\terrReport( FB_ERRMSG_EXPECTEDENDENUM )");
        source = replaceOnce(source, "\t\tif( lexGetToken( ) <> FB_TK_ENUM ) then\n\t\t\terrReport( FB_ERRMSG_EXPECTEDENDENUM )", "\t\tif( lexGetToken( ) <> FB_TK_ENUM ) then\n\t\t\teditor_recovered = TRUE\n\t\t\terrReport( FB_ERRMSG_EXPECTEDENDENUM )");
        return replaceOnce(source, "\nend sub", "\n\teditorCloseScope(e, editor_recovered)\nend sub");
    });
    routine("parser-compound-namespace.bas", "namespaceBegin", (source) => replaceOnce(source, "\tsymbNestBegin( sym, FALSE )", "\tdim editor_site as FBEDITORLOCATION = editorLastToken()\n\teditorOpenScope(editor_site, sym, \"namespace\")\n\tsymbNestBegin( sym, FALSE )"));
    routine("parser-compound-namespace.bas", "cNamespaceStmtEnd", (source) => replaceOnce(source, "\t\tsymbNestEnd( FALSE )", "\t\teditorCloseScope(stk->nspc.sym)\n\t\tsymbNestEnd( FALSE )"));
    routine("symb-namespace.bas", "symbNamespaceImportEx", (source) => replaceOnce(source, "\tfunction = TRUE", "\teditorImportNamespace(ns, to_ns)\n\tfunction = TRUE"));
    /* Top-level UDT symbols can reuse pooled nodes whose anonymous-parent
       field still contains an old value. Initialize it before exporting the
       relationship; anonymous UDTs assign their real parent in this routine. */
    routine("symb-struct.bas", "symbStructBegin", (source) => replaceOnce(source,
        "\tsymbSymbTbInit( s->udt.ns.symtb, s )\n\n\t'' not anon? create a new hash tb",
        "\tsymbSymbTbInit( s->udt.ns.symtb, s )\n\n\t'' Clear the optional link on reused top-level UDT symbols.\n\ts->udt.anonparent = NULL\n\n\t'' not anon? create a new hash tb"));
    // Anonymous union fields move to the enclosing UDT's symbol table. Refresh
    // their ownership after that native move, even when no later use exports it.
    routine("symb-struct.bas", "symbInsertInnerUDT", (source) => replaceOnce(source, "\t\tfld->symtb = symtb", "\t\tfld->symtb = symtb\n\t\tif( fld->editor_exported ) then editorExportSymbol(fld)"));
    return result;
}

module.exports = { SCOPE_FILES, instrumentScopes };

/* end of compiler-scope-hooks.js */
