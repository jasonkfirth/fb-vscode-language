/*
    Project: FreeBASIC VS Code Language Extension
    File: tools/build-compiler-bridge.js
    Purpose: Build an optional instrumented compiler without editing upstream.
    Responsibilities: copy compiler sources, apply checked hooks, bootstrap fbc.
    Does not contain: runtime editor integration or system-wide installation.
*/

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
    listCompilerSourceFiles,
    readFreeBasicVersion,
    resolveCompilerSourcePath,
    resolveFreeBasicRoot
} = require("./audit-freebasic-coverage");
const { auditExpressionRoutes } = require("./audit-compiler-expression-routes");
const { auditCallRoutes } = require("./audit-compiler-call-routes");
const { EXPRESSION_PARSER_HOOKS } = require("./compiler-expression-parser-hooks");
const { SYMBOL_FILES, instrumentSymbols } = require("./compiler-symbol-hooks");
const { EXPRESSION_FILES, instrumentExpressionGraph } = require("./compiler-expression-hooks");
const { SCOPE_FILES, instrumentScopes } = require("./compiler-scope-hooks");
const { instrumentOrigins } = require("./compiler-origin-hooks");
const { MACRO_FILES, instrumentMacros } = require("./compiler-macro-hooks");
const { PREPROCESSOR_FILES, instrumentPreprocessor } = require("./compiler-preprocessor-hooks");

function replaceOnce(source, before, after) {
    if (source.split(before).length !== 2) throw new Error(`Compiler bridge hook changed: ${before.slice(0, 80)}`);
    return source.replace(before, after);
}

function instrumentFunction(source, name, transform) {
    const start = source.search(new RegExp(`^(?:private )?function ${name}\\b`, "m"));
    const terminator = "\nend function";
    const endStart = source.indexOf(terminator, start);
    if (start < 0 || endStart < 0) throw new Error(`Compiler bridge function changed: ${name}`);
    const end = endStart + terminator.length;
    return source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
}

function instrumentSub(source, name, transform) {
    const start = source.search(new RegExp(`^(?:private )?sub ${name}\\b`, "m"));
    const terminator = "\nend sub";
    const endStart = source.indexOf(terminator, start);
    if (start < 0 || endStart < 0) throw new Error(`Compiler bridge subroutine changed: ${name}`);
    const end = endStart + terminator.length;
    return source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
}

function compilerCopyPath(freeBasicRoot, compilerDirectory, sourceName) {
    const originalRoot = path.join(freeBasicRoot, "src", "compiler");
    const originalPath = resolveCompilerSourcePath(originalRoot, sourceName);
    return path.join(compilerDirectory, path.relative(originalRoot, originalPath));
}

function readCompilerCopyFiles(freeBasicRoot, compilerDirectory, fileNames) {
    return Object.fromEntries(fileNames.map((name) => [
        name,
        fs.readFileSync(compilerCopyPath(freeBasicRoot, compilerDirectory, name), "utf8").replace(/\r\n/g, "\n")
    ]));
}

function writeCompilerCopyFiles(freeBasicRoot, compilerDirectory, files) {
    for (const [name, source] of Object.entries(files)) {
        fs.writeFileSync(compilerCopyPath(freeBasicRoot, compilerDirectory, name), source);
    }
}

function compilerBuildSourceFiles(freeBasicRoot) {
    const compilerRoot = path.join(freeBasicRoot, "src", "compiler");
    const genericFiles = listCompilerSourceFiles(compilerRoot);
    const hostDirectoryName = process.platform === "win32" ? "win32" : process.platform;
    const hostDirectory = path.join(compilerRoot, "platform", hostDirectoryName);
    const hostFiles = fs.existsSync(hostDirectory)
        ? fs.readdirSync(hostDirectory)
            .filter((name) => name.endsWith(".bas"))
            .map((name) => path.relative(compilerRoot, path.join(hostDirectory, name)).split(path.sep).join("/"))
        : [];
    const hostNames = new Set(hostFiles.map((name) => path.basename(name)));

    return [
        ...genericFiles.filter((name) => !hostNames.has(path.basename(name))),
        ...hostFiles
    ].sort();
}

function compileCompilerSupportSources(freeBasicRoot, compilerDirectory, outputDirectory) {
    const compilerRoot = path.join(freeBasicRoot, "src", "compiler");
    const cSources = listCompilerSourceFiles(compilerRoot, [".c"]);
    const compiler = process.env.FBC_CC || process.env.CC || "cc";
    const objects = [];

    for (const sourceName of cSources) {
        const sourcePath = path.join(compilerDirectory, sourceName);
        const objectPath = path.join(outputDirectory, `bridge-${path.basename(sourceName, ".c")}.o`);
        const result = spawnSync(compiler, ["-c", sourcePath, "-o", objectPath], {
            cwd: outputDirectory,
            stdio: "inherit",
            timeout: 120000
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Compiler support source failed: ${sourceName}`);
        objects.push(objectPath);
    }

    return objects;
}

function instrumentLexer(source, header) {
    header = replaceOnce(header, "type FBTOKEN\n", "type FBTOKEN\n\teditor_file as zstring * FB_MAXPATHLEN\n\teditor_line as integer\n\teditor_expanded as integer\n");
    header += '\n#include once "editor-api.bi"\n';
    source = replaceOnce(source, 'dim shared as string pponly_ln\n', 'dim shared as string pponly_ln\n#include once "editor-trace.bi"\n#include once "editor-symbols.bi"\n#include once "editor-expressions.bi"\n#include once "editor-scopes.bi"\n');
    source = replaceOnce(source, "\tselect case as const char\n\t'' '.'?", "\tt->editor_file = env.inf.name\n\tt->editor_line = lex.ctx->linenum\n\tt->editor_expanded = (lex.ctx->deflen > 0)\n\n\tselect case as const char\n\t'' '.'?");
    source = replaceOnce(source, "\t\t\tprint #env.ppfile_num, pponly_ln", "\t\t\teditorEmitOrigin()\n\t\t\tprint #env.ppfile_num, pponly_ln");
    source = replaceOnce(source, "\t'' Everything else...\n", "\teditorStartLine()\n\n\t'' Everything else...\n");
    source = replaceOnce(source, '\t\tpponly_ln += " "\n\tend if\n', '\t\tpponly_ln += " "\n\tend if\n\teditorRecordToken()\n');
    source = replaceOnce(source, '\t\tpponly_ln += *lexGetText( )\n\tend select', '\t\tpponly_ln += *lexGetText( )\n\tend select\n\teditor_last_token.byte_end = len(pponly_ln)');
    source = replaceOnce(source, "\tpponly_ln += s\n", "\teditorStartLine()\n\tpponly_ln += s\n");
    return instrumentOrigins(source, header, replaceOnce);
}

function instrumentProcedures(files) {
    const result = { ...files };
    result["symb.bi"] = replaceOnce(files["symb.bi"], "type FBS_PROC\n", "type FBS_PROC\n\teditor_id as integer\n");
    /* Symbols come from the compiler's node pool, not zeroed JS-style objects.
       Initialize the field both for preliminary and finalized procedures. */
    result["symb-proc.bas"] = instrumentFunction(files["symb-proc.bas"], "symbPreAddProc", (source) =>
        replaceOnce(source, "\tproc->proc.params = 0", "\tproc->proc.editor_id = 0\n\tproc->proc.params = 0"));
    result["symb-proc.bas"] = replaceOnce(result["symb-proc.bas"], "\tproc->proc.mode = mode\n\n\t'' An EXTERN compound", "\tproc->proc.editor_id = 0\n\tproc->proc.mode = mode\n\n\t'' An EXTERN compound");
    const signature = "\t\tbyval options as FB_PARSEROPT, _\n\t\tbyval semantic_site as LEX_LOCATION ptr";
    const declaration = files["parser.bi"].match(/declare function cProcArgList _[\s\S]*?\) as ASTNODE ptr/);
    if (!declaration) throw new Error("Compiler bridge declaration changed: cProcArgList");
    result["parser.bi"] = replaceOnce(files["parser.bi"], declaration[0], replaceOnce(declaration[0],
        "\t\tbyval semantic_site as LEX_LOCATION ptr = NULL _",
        "\t\tbyval editor_target as FBSYMBOL ptr ptr = NULL, _\n\t\tbyval semantic_site as LEX_LOCATION ptr = NULL _"));
    let argumentsSource = files["parser-proccall-args.bas"];
    for (const name of ["hOvlProcArgList", "cProcArgList"]) {
        argumentsSource = instrumentFunction(argumentsSource, name, (source) => {
            source = replaceOnce(source, signature, "\t\tbyval options as FB_PARSEROPT, _\n\t\tbyval editor_target as FBSYMBOL ptr ptr, _\n\t\tbyval semantic_site as LEX_LOCATION ptr");
            const call = name === "hOvlProcArgList" ? "\tprocexpr = astNewCALL( proc, procexpr )" : "\tprocexpr = astNewCALL( proc, ptrexpr )";
            source = replaceOnce(source, call, "\tif( editor_target <> NULL ) then *editor_target = proc\n" + call);
            if (name === "cProcArgList") source = replaceOnce(source,
                "return hOvlProcArgList( base_parent, proc, arg_list, options, semantic_site )",
                "return hOvlProcArgList( base_parent, proc, arg_list, options, editor_target, semantic_site )");
            return source;
        });
    }
    result["parser-proccall-args.bas"] = argumentsSource;
    for (const [file, name] of [["parser-expr-function.bas", "cFunctionCall"], ["parser-proccall.bas", "cProcCall"]]) {
        result[file] = instrumentFunction(files[file], name, (source) => {
            source = replaceOnce(source, "\n\tfunction = NULL\n", "\n\tdim as FBEDITORLOCATION editor_site = editorLastToken()\n\tdim as FBSYMBOL ptr editor_target = NULL\n\n\tfunction = NULL\n");
            /* Only these parser entry points have just consumed a source callee.
               The optional out parameter preserves selection before virtual-call
               lowering substitutes an anonymous function-pointer prototype. */
            const count = name === "cFunctionCall" ? 4 : 1;
            const calls = /cProcArgList\( base_parent, sym, ptrexpr, @arg_list, ([\s\S]*?), semantic_site \)/g;
            if ([...source.matchAll(calls)].length !== count) throw new Error(`Compiler bridge calls changed: ${name}`);
            source = source.replace(calls, "cProcArgList( base_parent, sym, ptrexpr, @arg_list, $1, @editor_target, semantic_site )");
            const before = name === "cFunctionCall" ? "\t'' is it really a function?" : "\tfbSetPrntOptional( FALSE )";
            return replaceOnce(source, before, "\tif( ptrexpr = NULL ) then editorEmitProcedure( editor_site, editor_target, FALSE )\n\n" + before);
        });
    }
    result["parser-proc.bas"] = instrumentFunction(files["parser-proc.bas"], "cProcHeader", (source) => {
        const before = "\tproc = hPreAddHeaderProc( tk, parent, is_memberproc, @id, head_proc, _";
        source = replaceOnce(source, before, "\tdim as FBEDITORLOCATION editor_site = editorNextToken()\n\n" + before);
        source = replaceOnce(source, "\t\tif( (proc <> NULL) and _", "\t\teditorEmitProcedure( editor_site, proc, TRUE )\n\t\tif( (proc <> NULL) and _");
        return replaceOnce(source, "\tfunction = proc\nend function", "\teditorEmitProcedure( editor_site, proc, TRUE )\n\tfunction = proc\nend function");
    });
    return result;
}

function instrumentSourceIO(source) {
    const objinfoInclude = ['#include once "objinfo.bi"', '#include once "driver/objinfo.bi"']
        .find((includeLine) => source.includes(includeLine));
    if (!objinfoInclude) throw new Error("Compiler source I/O include hook changed: objinfo.bi");
    source = replaceOnce(source, objinfoInclude, `${objinfoInclude}\ndeclare function editorSourcePath( byval filename as zstring ptr ) as string\ndeclare function editorSourceExists( byval filename as zstring ptr ) as integer`);
    source = replaceOnce(source, "\tenv.inf.name = pathNormalizeHost( *infname )", "\teditorReset()\n\tenv.inf.name = pathNormalizeHost( *infname )");
    const includeRoutineAnchors = [
        "sub fbIncludeFile(byval filename as zstring ptr, byval isonce as integer)",
        "sub fbIncludeFile(byval filename as zstring ptr, byval isonce as integer, _\n\tbyval directive as any ptr, byval is_preinclude as integer)"
    ];
    const includeRoutine = includeRoutineAnchors.find((anchor) => source.includes(anchor));
    if (!includeRoutine) throw new Error("Compiler include routine hook changed: fbIncludeFile");
    source = replaceOnce(source, includeRoutine, `#include once "editor-io.bi"\n\n${includeRoutine}`);
    for (const name of ["env.inf.name", "incfile"]) source = replaceOnce(source, `open( ${name}, for binary, access read`, `open( editorSourcePath(${name}), for binary, access read`);
    source = replaceOnce(source, "\tfbSemanticModelAddDependency(env.inf.name)", "\tfbSemanticModelAddDependency(env.inf.name)\n\teditorRememberSourcePath(env.inf.name)");
    source = replaceOnce(source, "\tfbSemanticModelAddDependency(incfile)", "\tfbSemanticModelAddDependency(incfile)\n\teditorRememberSourcePath(incfile)");
    const exists = /hFileExists\(\s*(env\.inf\.name|incfile|filename)\s*\)/g;
    if ([...source.matchAll(exists)].length !== 4) throw new Error("Compiler source existence hooks changed.");
    return source.replace(exists, "editorSourceExists($1)");
}

function instrumentExpressions(files) {
    const result = { ...files };
    for (const [file, names] of Object.entries(EXPRESSION_PARSER_HOOKS)) {
        for (const name of names) result[file] = instrumentFunction(result[file], name, (source) => {
            const header = source.match(/^function [\s\S]*?\) as ASTNODE ptr/)[0];
            const parameters = [...header.matchAll(/byval (\w+) as /g)].map((match) => match[1]);
            if (/byref|overload|=/i.test(header)) throw new Error(`Expression wrapper signature changed: ${name}`);
            const originalName = `editorOriginal_${name}`;
            const originalHeader = header.replace(name, originalName);
            if (name === "cHighestPrecExpr") {
                source = replaceOnce(source, header, header + "\n\tdim editor_prefix as FBEDITORLOCATION = editorNextToken()\n");
                source = replaceOnce(source, "\texpr = cStrIdxOrMemberDeref( expr )", "\teditorEmitExpression(editor_prefix, expr)\n\texpr = cStrIdxOrMemberDeref( expr )");
            }
            if (file === "parser-expr-binary.bas" &&
                (source.includes("astNewBOP") || source.includes("hSourceBinaryOperation")) && source.includes("\n\tloop")) {
                const accumulator = [...source.matchAll(/\tfunction = (\w+)\s*\n/g)].at(-1)?.[1];
                if (!accumulator) throw new Error(`Expression accumulator changed: ${name}`);
                source = replaceOnce(source, header, header + "\n\tdim editor_prefix as FBEDITORLOCATION = editorNextToken()\n");
                source = replaceOnce(source, "\n\tloop", `\n\t\teditorEmitExpression(editor_prefix, ${accumulator})\n\tloop`);
            }
            const scoped = ["cAtom", "cHighestPrecExpr"].includes(name);
            const enter = scoped ? "\tdim editor_previous as FBEDITORLOCATION = editorExchangePrefix(editor_start)\n" : "";
            const leave = scoped ? "\teditorExchangePrefix(editor_previous)\n" : "";
            const familyEnter = `\tdim editor_previous_family as string = editorExchangeExpressionFamily("${name}")\n`;
            const familyLeave = "\teditorExchangeExpressionFamily(editor_previous_family)\n";
            const start = name === "cMethodCall" ? "editorAstStart(thisexpr)" : name === "cFunctionEx" ? "editorExpressionPrefix()" : "editorNextToken()";
            /* Implicit-call facts exist only in full semantic-model output.
               Keep exact lexer ranges on ASTs only for that mode. */
            const physicalRangeStart = name === "cExpression"
                ? "\tdim editor_semantic_range_enabled as integer = FALSE\n\tif( fbSemanticModelEnabled( ) ) then\n\t\tif( fbSemanticModelExpressionsOnlyEnabled( ) = FALSE ) then editor_semantic_range_enabled = TRUE\n\tend if\n\tdim editor_physical_start as LEX_LOCATION\n\tdim editor_nonphysical_start as longint = 0\n\tif( editor_semantic_range_enabled ) then\n\t\tlexGetToken( )\n\t\teditor_physical_start = lexGetCurrentLocation( )\n\t\teditor_nonphysical_start = lexGetNonphysicalTokenCount( )\n\tend if\n"
                : "";
            const physicalRangeEnd = name === "cExpression"
                ? "\tif( editor_result <> NULL ) then\n\t\tif( editor_semantic_range_enabled andalso (editor_physical_start.is_physical) andalso _\n\t\t\t(lexGetNonphysicalTokenCount( ) = editor_nonphysical_start) ) then\n\t\t\tdim editor_physical_end as LEX_LOCATION = lexGetLastLocation( )\n\t\t\tif( (editor_physical_end.is_physical) and _\n\t\t\t\t(editor_physical_start.source_file = editor_physical_end.source_file) and _\n\t\t\t\t(editor_physical_end.end_line > editor_physical_start.start_line or _\n\t\t\t\t (editor_physical_end.end_line = editor_physical_start.start_line and _\n\t\t\t\t  editor_physical_end.end_column > editor_physical_start.start_column)) ) then\n\t\t\t\teditor_result->editor_physical_source.source_file = editor_physical_start.source_file\n\t\t\t\teditor_result->editor_physical_source.start_line = editor_physical_start.start_line\n\t\t\t\teditor_result->editor_physical_source.start_column = editor_physical_start.start_column\n\t\t\t\teditor_result->editor_physical_source.end_line = editor_physical_end.end_line\n\t\t\t\teditor_result->editor_physical_source.end_column = editor_physical_end.end_column\n\t\t\t\teditor_result->editor_physical_source.valid = TRUE\n\t\t\tend if\n\t\tend if\n\tend if\n"
                : "";
            const physicalRangeFallback = name === "cExpression"
                ? "\tif( editor_result <> NULL ) then\n\t\tif( editor_semantic_range_enabled ) then\n\t\t\tif( editor_result->editor_physical_source.valid = FALSE ) then\n\t\t\t\tif( editor_result->editor_source.identity > 0 ) then\n\t\t\t\t\tdim editor_mapped_range as FBEDITORPHYSICALRANGE = editorPhysicalRangeFromTokens( _\n\t\t\t\t\t\teditor_result->editor_source.start_serial, editor_result->editor_source.start_byte, _\n\t\t\t\t\t\teditor_result->editor_source.end_serial, editor_result->editor_source.end_byte )\n\t\t\t\t\tif( editor_mapped_range.valid ) then editor_result->editor_physical_source = editor_mapped_range\n\t\t\t\tend if\n\t\t\tend if\n\t\tend if\n\tend if\n"
                : "";
            const wrapper = `${header}\n\tdim editor_start as FBEDITORLOCATION = ${start}\n${physicalRangeStart}${enter}${familyEnter}\tdim editor_result as ASTNODE ptr = ${originalName}(${parameters.join(", ")})\n\teditorEmitExpression(editor_start, editor_result)\n${physicalRangeEnd}${physicalRangeFallback}\teditorTagExpressionFamily(editor_result)\n${familyLeave}${leave}\treturn editor_result\nend function\n\n`;
            /* Wrapping preserves every early return and recursive parser call.
               The original parser still owns and mutates its returned AST. */
            return "declare " + originalHeader + "\n\n" + wrapper + source.replace(header, originalHeader);
        });
    }
    result["parser-expr-variable.bas"] = replaceOnce(result["parser-expr-variable.bas"],
        "\t\tdim as FBSYMBOL ptr fld = hMemberId( subtype, FALSE )", "\t\teditorEmitReceiver(dtype, subtype)\n\t\tdim as FBSYMBOL ptr fld = hMemberId( subtype, FALSE )");
    result["parser-expr-variable.bas"] = replaceOnce(result["parser-expr-variable.bas"], "\tassert( symbIsVar( sym ) )", "\tdim editor_variable as FBEDITORLOCATION = editorNextToken()\n\tassert( symbIsVar( sym ) )");
    result["parser-expr-variable.bas"] = replaceOnce(result["parser-expr-variable.bas"], "\tis_byref = symbIsParamVarByRef( sym )", "\teditorEmitType(editor_variable, symbGetFullType(sym), symbGetSubType(sym))\n\tis_byref = symbIsParamVarByRef( sym )");
    result["parser-expr-function.bas"] = replaceOnce(result["parser-expr-function.bas"], "\tfunction = cStrIdxOrMemberDeref( funcexpr )", "\tif( ptrexpr = NULL ) then editorEmitType(editor_site, astGetFullType(funcexpr), astGetSubType(funcexpr))\n\tfunction = cStrIdxOrMemberDeref( funcexpr )");
    return result;
}

function instrumentRecovery(files) {
    const result = { ...files };
    function routine(file, name, transform) {
        const source = result[file];
        const start = source.search(new RegExp(`^(?:private )?function ${name}\\b`, "m"));
        const endStart = source.indexOf("\nend function", start);
        if (start < 0 || endStart < 0) throw new Error(`Compiler recovery hook changed: ${file}: ${name}`);
        const end = endStart + "\nend function".length;
        result[file] = source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
    }
    let top = files["parser-toplevel.bas"];
    top = replaceOnce(top, "\t\t'' Label?\n", "\t\tdim editor_region as FBEDITORLOCATION = editorNextToken()\n\t\tdim editor_errors as integer = errGetCount()\n\n\t\t'' Label?\n");
    top = replaceOnce(top, "\t\t'' Emit the current line in text form", "\t\teditorInvalidateRegion(editor_region, editor_errors)\n\n\t\t'' Emit the current line in text form");
    top = replaceOnce(top, "\t\t'' line end\n", "\t\teditorInvalidateRegion(editor_region, editor_errors)\n\n\t\t'' line end\n");
    top = replaceOnce(top, "\t\tcCompStmtCheck()\n\tend if\nend sub", "\t\tcCompStmtCheck()\n\tend if\n\teditorReachedEnd()\nend sub");
    result["parser-toplevel.bas"] = top;
    result["error.bas"] = replaceOnce(files["error.bas"], "\thPrintErrMsg( errnum, msgex, options, linenum, env.clopt.showerror, customText )", "\teditorEmitError(errnum, linenum)\n\thPrintErrMsg( errnum, msgex, options, linenum, env.clopt.showerror, customText )");
    let statement = files["parser-statement.bas"];
    const legacyStatementStart = "\tdo\n\t\tif( cDeclaration";
    if (statement.includes(legacyStatementStart)) {
        statement = replaceOnce(statement, legacyStatementStart,
            "\tdo\n\t\tdim editor_region as FBEDITORLOCATION = editorNextToken()\n\t\tdim editor_errors as integer = errGetCount()\n\t\tif( cDeclaration");
    } else {
        const currentStatementAnchor = '\t\tdim as string route = "unmatched"\n';
        statement = replaceOnce(statement, currentStatementAnchor,
            `${currentStatementAnchor}\t\tdim editor_region as FBEDITORLOCATION = editorNextToken()\n\t\tdim editor_errors as integer = errors_before\n`);
    }
    statement = replaceOnce(statement, "\t\t'' ':'?\n", "\t\teditorInvalidateRegion(editor_region, editor_errors)\n\n\t\t'' ':'?\n");
    result["parser-statement.bas"] = statement;

    /* TYPEOF() is a declaration-side type parser. With an opening parenthesis
       at a physical line ending, the ordinary compiler keeps looking for an
       expression and can consume the following editor statement. An explicit
       continuation is already folded by the lexer and never reaches this
       branch as EOL. Trace mode can therefore preserve the next statement by
       reporting the incomplete type immediately and returning the compiler's
       ordinary recovery type. The normal compiler path is unchanged. */
    result["parser-decl-symbtype.bas"] = replaceOnce(files["parser-decl-symbtype.bas"],
        "\t\t'' datatype\n\t\tcTypeOf( dtype, subtype, lgt, is_fixlenstr )\n\n\t\t'' ')'\n\t\tif( hMatch( CHAR_RPRNT ) = FALSE ) then",
        "\t\t'' datatype\n\t\tif( environ(\"FB_VSCODE_TRACE\") = \"1\" ) andalso (lexGetToken( ) = FB_TK_EOL) then\n\t\t\t'' An explicit continuation is not an EOL token here. Keep the\n\t\t\t'' next physical editor statement out of TYPEOF() recovery.\n\t\t\terrReport( FB_ERRMSG_EXPECTEDEXPRESSION )\n\t\t\tdtype = FB_DATATYPE_INTEGER\n\t\t\tsubtype = NULL\n\t\t\tlgt = typeGetSize( dtype )\n\t\t\treturn TRUE\n\t\tend if\n\t\tcTypeOf( dtype, subtype, lgt, is_fixlenstr )\n\n\t\t'' ')'\n\t\tif( hMatch( CHAR_RPRNT ) = FALSE ) then");

    result["parser-decl-symbtype.bas"] = instrumentFunction(result["parser-decl-symbtype.bas"], "cTypeOrExpression", (source) =>
        replaceOnce(source, "\tdim as ASTNODE ptr expr = any\n",
            "\tdim editor_query_scope as FBEDITORQUERYSCOPE\n\teditor_query_scope.enter(tk)\n\tdim as ASTNODE ptr expr = any\n"));

    /* LEN() and SIZEOF() share the type-or-expression parser. At a physical
       line ending after the opening parenthesis, that parser can otherwise
       consume the next editor statement while looking for an expression. An
       explicit continuation is folded before this point. Preserve the next
       statement only in trace mode and return the parser's ordinary constant
       recovery shape; the trace-disabled compiler path is unchanged. */
    result["parser-quirk-math.bas"] = replaceOnce(files["parser-quirk-math.bas"],
        "\t'' Type or an Expression\n\texpr = cTypeOrExpression( tk, dtype, subtype, lgt )",
        "\tif( environ(\"FB_VSCODE_TRACE\") = \"1\" ) andalso (lexGetToken( ) = FB_TK_EOL) then\n\t\t'' Do not let incomplete LEN()/SIZEOF() consume the next source line.\n\t\terrReport( FB_ERRMSG_EXPECTEDEXPRESSION )\n\t\treturn astNewCONSTi( 0 )\n\tend if\n\n\t'' Type or an Expression\n\texpr = cTypeOrExpression( tk, dtype, subtype, lgt )");

    /* PEEK's optional type helper invokes cTypeOrExpression(), then attempts
       a normal expression when no type was found. At an opening parenthesis
       followed by physical EOL, that two-stage decision can consume the next
       editor statement. Its trace-only recovery value is already the PEEK
       result type, so returning it directly preserves the next statement
       without changing explicit continuations or the ordinary compiler. */
    const peekRoutine = files["parser-quirk-peekpoke.bas"].includes("function editorOriginal_cPeekFunct") ? "editorOriginal_cPeekFunct" : "cPeekFunct";
    routine("parser-quirk-peekpoke.bas", peekRoutine, (source) => replaceOnce(source,
        "\t'' '('\n\thMatchLPRNT( )\n\n\t'' (SymbolType ',')? Expression",
        "\t'' '('\n\thMatchLPRNT( )\n\n\tif( environ(\"FB_VSCODE_TRACE\") = \"1\" ) andalso (lexGetToken( ) = FB_TK_EOL) then\n\t\t'' Keep an incomplete PEEK() from consuming the following source line.\n\t\terrReport( FB_ERRMSG_EXPECTEDEXPRESSION )\n\t\treturn astNewCONSTi( 0, FB_DATATYPE_UBYTE )\n\tend if\n\n\t'' (SymbolType ',')? Expression"));

    /* PROCPTR() delegates the source procedure name to cProcPtrBody(). When
       its opening parenthesis ends a physical line, identifier recovery can
       read the first token of the next editor statement. Trace mode reports
       the missing identifier at the caller and returns a normal fake node;
       an explicit continuation and normal compiler mode take the original
       parser path unchanged. */
    const addressRoutine = files["parser-expr-unary.bas"].includes("function editorOriginal_cAddrOfExpression") ? "editorOriginal_cAddrOfExpression" : "cAddrOfExpression";
    routine("parser-expr-unary.bas", addressRoutine, (source) => replaceOnce(source,
        "\t\texpr = cProcPtrBody( 0, NULL )",
        "\t\tif( environ(\"FB_VSCODE_TRACE\") = \"1\" ) andalso (lexGetToken( ) = FB_TK_EOL) then\n\t\t\t'' Do not let incomplete PROCPTR() consume the next source line.\n\t\t\terrReport( FB_ERRMSG_EXPECTEDIDENTIFIER )\n\t\t\treturn astNewCONSTi( 0 )\n\t\tend if\n\n\t\texpr = cProcPtrBody( 0, NULL )"));

    const ppStart = files["pp.bas"].indexOf("private sub ppInclude()");
    const ppEnd = files["pp.bas"].indexOf("\nend sub", ppStart);
    if (ppStart < 0 || ppEnd < 0) throw new Error("Compiler include recovery hook changed.");
    const ppInclude = files["pp.bas"].slice(ppStart, ppEnd + "\nend sub".length);
    const patchedInclude = replaceOnce(ppInclude,
        "\t\terrReport( FB_ERRMSG_SYNTAXERROR )\n\t\t'' error recovery: skip\n\t\tlexSkipToken( )\n\t\treturn",
        "\t\terrReport( FB_ERRMSG_SYNTAXERROR )\n\t\t'' An incomplete include is common while its filename is being typed.\n\t\t'' The ordinary recovery consumes one token, which can be the first\n\t\t'' token of the next source line. Keep the editor trace synchronized\n\t\t'' at this directive's EOL without changing normal compiler behavior.\n\t\tif( environ(\"FB_VSCODE_TRACE\") = \"1\" ) then\n\t\t\thSkipUntil( FB_TK_EOL )\n\t\telse\n\t\t\tlexSkipToken( )\n\t\tend if\n\t\treturn");
    result["pp.bas"] = files["pp.bas"].slice(0, ppStart) + patchedInclude + files["pp.bas"].slice(ppEnd + "\nend sub".length);
    let main = files["fb.bas"];
    const close = "\tif( env.ppfile_num > 0 ) then\n\t\tclose #env.ppfile_num\n\tend if\n";
    main = replaceOnce(main, close, "");
    main = replaceOnce(main, "\t\tsymbCheckLabels(symbGetGlobalTbHead())\n\tend if\nend sub", "\t\tsymbCheckLabels(symbGetGlobalTbHead())\n\tend if\n\n\teditorFinish()\n" + close + "end sub");
    result["fb.bas"] = main;
    return result;
}

function instrumentSemanticCoordinates(source) {
    source = replaceOnce(source,
        '#include once "file.bi"\n',
        '#include once "file.bi"\n\ndeclare function fbSemanticModelExpressionsOnly( ) as integer\n');
    source = instrumentSub(source, "fbSemanticModelExportCoordinates", (routine) => replaceOnce(routine,
        "\tdim as string coordinates = fbSemanticModelCoordinateFact(first, last)\n",
        "\t'' E records carry their own expression ranges, but statements and constructs\n" +
        "\t'' still need LOC ranges in expression-only models.\n" +
        "\tif( fbSemanticModelExpressionsOnly( ) andalso (domain = \"expression\") ) then exit sub\n" +
        "\tdim as string coordinates = fbSemanticModelCoordinateFact(first, last)\n"));
    return instrumentFunction(source, "hResolveColumn", (routine) => {
        const before = [
            "\t\t\t\tdim as integer trailing = 0",
            "\t\t\t\tselect case codepoint",
            "\t\t\t\tcase &hC2 to &hDF: trailing = 1",
            "\t\t\t\tcase &hE0 to &hEF: trailing = 2",
            "\t\t\t\tcase &hF0 to &hF4: trailing = 3",
            "\t\t\t\tcase else: return FALSE",
            "\t\t\t\tend select",
            "\t\t\t\tif( index + trailing >= len(coordinate_text) ) then return FALSE",
            "\t\t\t\tfor extra as integer = 1 to trailing",
            "\t\t\t\t\tdim as integer next_byte = coordinate_text[index + extra]",
            "\t\t\t\t\tif( (next_byte < &h80) or (next_byte > &hBF) ) then return FALSE",
            "\t\t\t\t\tif( extra = 1 ) then",
            "\t\t\t\t\t\tif( (codepoint = &hE0) and (next_byte < &hA0) ) then return FALSE",
            "\t\t\t\t\t\tif( (codepoint = &hED) and (next_byte > &h9F) ) then return FALSE",
            "\t\t\t\t\t\tif( (codepoint = &hF0) and (next_byte < &h90) ) then return FALSE",
            "\t\t\t\t\t\tif( (codepoint = &hF4) and (next_byte > &h8F) ) then return FALSE",
            "\t\t\t\t\tend if",
            "\t\t\t\t\tnext",
            "\t\t\t\tunits = trailing + 1",
            "\t\t\t\tcolumns = iif(trailing = 3, 2, 1)"
        ].join("\n");
        const after = [
            "\t\t\t\tdim as integer trailing = 0",
            "\t\t\t\tdim as integer valid_utf8 = TRUE",
            "\t\t\t\tselect case codepoint",
            "\t\t\t\tcase &hC2 to &hDF: trailing = 1",
            "\t\t\t\tcase &hE0 to &hEF: trailing = 2",
            "\t\t\t\tcase &hF0 to &hF4: trailing = 3",
            "\t\t\t\tcase else: valid_utf8 = FALSE",
            "\t\t\t\tend select",
            "\t\t\t\tif( valid_utf8 ) then",
            "\t\t\t\t\tif( index + trailing >= len(coordinate_text) ) then",
            "\t\t\t\t\t\tvalid_utf8 = FALSE",
            "\t\t\t\t\telse",
            "\t\t\t\t\t\tfor extra as integer = 1 to trailing",
            "\t\t\t\t\t\t\tdim as integer next_byte = coordinate_text[index + extra]",
            "\t\t\t\t\t\t\tif( (next_byte < &h80) or (next_byte > &hBF) ) then",
            "\t\t\t\t\t\t\t\tvalid_utf8 = FALSE",
            "\t\t\t\t\t\t\t\texit for",
            "\t\t\t\t\t\t\tend if",
            "\t\t\t\t\t\t\tif( extra = 1 ) then",
            "\t\t\t\t\t\t\t\tif( (codepoint = &hE0) and (next_byte < &hA0) ) then valid_utf8 = FALSE",
            "\t\t\t\t\t\t\t\tif( (codepoint = &hED) and (next_byte > &h9F) ) then valid_utf8 = FALSE",
            "\t\t\t\t\t\t\t\tif( (codepoint = &hF0) and (next_byte < &h90) ) then valid_utf8 = FALSE",
            "\t\t\t\t\t\t\t\tif( (codepoint = &hF4) and (next_byte > &h8F) ) then valid_utf8 = FALSE",
            "\t\t\t\t\t\t\t\tif( valid_utf8 = FALSE ) then exit for",
            "\t\t\t\t\t\t\tend if",
            "\t\t\t\t\t\tnext",
            "\t\t\t\t\tend if",
            "\t\t\t\tend if",
            "\t\t\t\tif( valid_utf8 ) then",
            "\t\t\t\t\tunits = trailing + 1",
            "\t\t\t\t\tcolumns = iif(trailing = 3, 2, 1)",
            "\t\t\t\telse",
            "\t\t\t\t\treturn FALSE",
            "\t\t\t\tend if"
        ].join("\n");
        return replaceOnce(routine, before, after);
    });
}

function instrumentSemanticSourceFilter(source) {
    const declarations = [
        "private dim shared as integer editor_semantic_source_filter_enabled",
        "private dim shared as integer editor_semantic_source_filter_count",
        "private dim shared as string editor_semantic_source_filter_files(0 to SEMANTIC_MODEL_MAX_DEPENDENCIES - 1)"
    ].join("\n");
    source = replaceOnce(source,
        "dim shared as integer semantic_model_expressions_only\n",
        "dim shared as integer semantic_model_expressions_only\n" + declarations + "\n");

    const helpers = [
        "",
        "private sub hSemanticModelLoadSourceFilter()",
        "\teditor_semantic_source_filter_enabled = FALSE",
        "\teditor_semantic_source_filter_count = 0",
        "\tif( semantic_model_expressions_only = FALSE ) then exit sub",
        "\tdim as string filter_path = environ(\"FB_VSCODE_SEMANTIC_SOURCE_FILTER\")",
        "\tif( len(filter_path) = 0 ) then exit sub",
        "\tif( len(dir(filter_path)) = 0 ) then",
        "\t\tfbSemanticModelFailAt(\"semantic source filter file is missing\")",
        "\t\texit sub",
        "\tend if",
        "\tdim as integer filter_file = freefile()",
        "\topen filter_path for input as #filter_file",
        "\tdo until eof(filter_file)",
        "\t\tdim as string source_path",
        "\t\tline input #filter_file, source_path",
        "\t\tif( len(source_path) > 0 ) then",
        "\t\t\tif( (len(source_path) > FB_MAXPATHLEN) or (instr(source_path, chr(0)) > 0) or _",
        "\t\t\t\t(instr(source_path, chr(9)) > 0) or (instr(source_path, chr(13)) > 0) ) then",
        "\t\t\t\tclose #filter_file",
        "\t\t\t\tfbSemanticModelFailAt(\"invalid semantic source filter record\")",
        "\t\t\t\texit sub",
        "\t\t\tend if",
        "\t\t\tif( editor_semantic_source_filter_count >= SEMANTIC_MODEL_MAX_DEPENDENCIES ) then",
        "\t\t\t\tclose #filter_file",
        "\t\t\t\tfbSemanticModelFailAt(\"semantic source filter exceeded its file limit\")",
        "\t\t\t\texit sub",
        "\t\t\tend if",
        "\t\t\teditor_semantic_source_filter_files(editor_semantic_source_filter_count) = source_path",
        "\t\t\teditor_semantic_source_filter_count += 1",
        "\t\tend if",
        "\tloop",
        "\tclose #filter_file",
        "\teditor_semantic_source_filter_enabled = TRUE",
        "end sub",
        "",
        "private function hSemanticModelSourceAllowed(byref source_file as const string) as integer",
        "\tif( editor_semantic_source_filter_enabled = FALSE ) then return TRUE",
        "\tfor index as integer = 0 to editor_semantic_source_filter_count - 1",
        "\t\tif( editor_semantic_source_filter_files(index) = source_file ) then return TRUE",
        "\tnext",
        "\treturn FALSE",
        "end function",
        "",
        "function fbSemanticModelExpressionsOnly( ) as integer",
        "\treturn abs(semantic_model_file_open and semantic_model_expressions_only)",
        "end function"
    ].join("\n");
    source = instrumentFunction(source, "hSemanticModelEscape", (routine) => routine + "\n" + helpers);
    source = instrumentFunction(source, "hSemanticModelRangeFitsCurrentSourceLine", (routine) => replaceOnce(routine,
        "\tif( source_end.source_file <> env.inf.name ) then return TRUE\n",
        [
            "\t'' The editor model checks exported columns against the requested source snapshot.",
            "\t'' Avoid reopening a large source file for every filtered expression fact.",
            "\tif( semantic_model_expressions_only ) then",
            "\t\tif( editor_semantic_source_filter_enabled ) then return TRUE",
            "\t\tif( len(environ(\"FB_VSCODE_SEMANTIC_SOURCE_FILTER\")) > 0 ) then return TRUE",
            "\tend if",
            "\tif( source_end.source_file <> env.inf.name ) then return TRUE",
            ""
        ].join("\n")));
    source = instrumentFunction(source, "fbSemanticModelBegin", (routine) => replaceOnce(routine,
        "\tsemantic_model_dependencies_complete = TRUE\n",
        "\tsemantic_model_dependencies_complete = TRUE\n\thSemanticModelLoadSourceFilter()\n"));
    source = instrumentSub(source, "fbSemanticModelAppendDetail", (routine) => routine + "\n" + [
        "private sub hSemanticModelSkipFilteredExpression()",
        "\tif( len(semantic_model_pending_expression_value) > 0 ) then",
        "\t\tdim as string filtered_expression_value = semantic_model_pending_expression_value",
        "\t\tsemantic_model_pending_expression_value = \"\"",
        "\t\tfbSemanticModelAppendDetail(filtered_expression_value)",
        "\tend if",
        "\tif( len(semantic_model_pending_expression_type) > 0 ) then",
        "\t\tdim as string filtered_expression_type = semantic_model_pending_expression_type",
        "\t\tsemantic_model_pending_expression_type = \"\"",
        "\t\tfbSemanticModelAppendDetail(filtered_expression_type)",
        "\tend if",
        "\tsemantic_model_last_expression_fact = \"\"",
        "\tsemantic_model_last_expression_shape = \"\"",
        "\tsemantic_model_last_expression_had_operator_override = FALSE",
        "\tsemantic_model_last_expression_buffer_start = 0",
        "\tsemantic_model_pending_operator_override = -1",
        "end sub"
    ].join("\n"));
    source = instrumentSub(source, "fbSemanticModelExportExpression", (routine) => {
        routine = replaceOnce(routine,
            "\tdim as LEX_LOCATION observed_start = source_start\n",
            [
                "\tif( semantic_model_expressions_only andalso editor_semantic_source_filter_enabled ) then",
                "\t\tif( (hSemanticModelSourceAllowed(source_start.source_file) = FALSE) and _",
                "\t\t\t(hSemanticModelSourceAllowed(source_end.source_file) = FALSE) ) then",
                "\t\t\tif( source_start.is_physical and source_end.is_physical and _",
                "\t\t\t\t(nonphysical_tokens_at_start = nonphysical_tokens_at_end) and _",
                "\t\t\t\t(source_start.source_file = source_end.source_file) ) then",
                "\t\t\t\thSemanticModelSkipFilteredExpression()",
                "\t\t\t\texit sub",
                "\t\t\tend if",
                "\t\t\tdim as LEX_LOCATION filtered_invocation",
                "\t\t\tif( fbSemanticModelMacroExpressionLocation(source_start, source_end, _",
                "\t\t\t\tnonphysical_tokens_at_start, nonphysical_tokens_at_end, filtered_invocation) = FALSE ) then",
                "\t\t\t\thSemanticModelSkipFilteredExpression()",
                "\t\t\t\texit sub",
                "\t\t\tend if",
                "\t\t\tif( hSemanticModelSourceAllowed(filtered_invocation.source_file) = FALSE ) then",
                "\t\t\t\thSemanticModelSkipFilteredExpression()",
                "\t\t\t\texit sub",
                "\t\t\tend if",
                "\t\tend if",
                "\tend if",
                "",
                "\tdim as LEX_LOCATION observed_start = source_start"
            ].join("\n") + "\n");
        return replaceOnce(routine,
        "\tdim as string sourcefile = observed_start.source_file\n",
        [
            "\tdim as string sourcefile = observed_start.source_file",
            "\tif( semantic_model_expressions_only andalso editor_semantic_source_filter_enabled ) then",
            "\t\tif( (physical_range = FALSE) or (hSemanticModelSourceAllowed(sourcefile) = FALSE) ) then",
            "\t\t\thSemanticModelSkipFilteredExpression()",
            "\t\t\texit sub",
            "\t\tend if",
            "\tend if",
            ""
        ].join("\n"));
    });
    return source;
}

function main() {
    if (process.platform !== "linux") throw new Error("The optional compiler bridge builder currently supports native Linux only.");
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const routeAudit = auditExpressionRoutes({ root, parserHooks: EXPRESSION_PARSER_HOOKS });
    const routeFailures = [
        ["unowned", routeAudit.unowned],
        ["duplicate ownership", routeAudit.duplicateOwnership],
        ["stale generic hooks", routeAudit.staleGeneric],
        ["stale explicit owners", routeAudit.staleOwners],
        ["parser definition drift", routeAudit.definitionDrift]
    ].filter(([, routes]) => routes.length);
    if (routeFailures.length) throw new Error(`Compiler expression route audit failed: ${routeFailures.map(([kind, routes]) => `${kind}: ${routes.join(", ")}`).join("; ")}`);
    const callAudit = auditCallRoutes({ root });
    const callFailures = [
        ["unowned", callAudit.unowned],
        ["stale owners", callAudit.staleOwners],
        ["stale files", callAudit.staleFiles],
        ["changed call sites", callAudit.drift],
        ["unclassified source occurrences", callAudit.unclassified],
        ["stale source-occurrence classifications", callAudit.staleClassifications]
    ].filter(([, routes]) => routes.length);
    if (callFailures.length) throw new Error(`Compiler selected-call audit failed: ${callFailures.map(([kind, routes]) => `${kind}: ${routes.join(", ")}`).join("; ")}`);
    const bootstrap = process.env.FBC_EXECUTABLE || path.join(root, "bin/fbc");
    const outputRoot = path.resolve(__dirname, "../dist");
    fs.mkdirSync(outputRoot, { recursive: true });
    const build = fs.mkdtempSync(path.join(outputRoot, "compiler-bridge-"));
    const compilerDirectory = path.join(build, "compiler");
    const originalCompilerRoot = path.join(root, "src", "compiler");
    fs.cpSync(path.join(root, "src/compiler"), compilerDirectory, {
        recursive: true,
        filter: (file) => fs.statSync(file).isDirectory() ? path.basename(file) !== "obj" : /\.(?:bas|bi|c)$/.test(file)
    });
    const lexer = compilerCopyPath(root, compilerDirectory, "lex.bas");
    const lexerHeader = compilerCopyPath(root, compilerDirectory, "lex.bi");
    const patched = instrumentLexer(fs.readFileSync(lexer, "utf8").replace(/\r\n/g, "\n"), fs.readFileSync(lexerHeader, "utf8").replace(/\r\n/g, "\n"));
    fs.writeFileSync(lexer, patched.source);
    fs.writeFileSync(lexerHeader, patched.header);
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-trace.bi"), path.join(compilerDirectory, "editor-trace.bi"));
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-api.bi"), path.join(compilerDirectory, "editor-api.bi"));
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-expressions.bi"), path.join(compilerDirectory, "editor-expressions.bi"));
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-io.bi"), path.join(compilerDirectory, "editor-io.bi"));
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-symbols.bi"), path.join(compilerDirectory, "editor-symbols.bi"));
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-scopes.bi"), path.join(compilerDirectory, "editor-scopes.bi"));
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-origins.bi"), path.join(compilerDirectory, "editor-origins.bi"));
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-macro-maps.bi"), path.join(compilerDirectory, "editor-macro-maps.bi"));
    fs.copyFileSync(path.resolve(__dirname, "../compiler/editor-preprocessor.bi"), path.join(compilerDirectory, "editor-preprocessor.bi"));
    const semanticCoordinates = compilerCopyPath(root, compilerDirectory, "tooling/semantic-coordinates.bas");
    fs.writeFileSync(semanticCoordinates, instrumentSemanticCoordinates(fs.readFileSync(semanticCoordinates, "utf8").replace(/\r\n/g, "\n")));
    const semanticModel = compilerCopyPath(root, compilerDirectory, "tooling/semantic-model.bas");
    fs.writeFileSync(semanticModel, instrumentSemanticSourceFilter(fs.readFileSync(semanticModel, "utf8").replace(/\r\n/g, "\n")));
    const mainSource = compilerCopyPath(root, compilerDirectory, "fb.bas");
    fs.writeFileSync(mainSource, instrumentSourceIO(fs.readFileSync(mainSource, "utf8").replace(/\r\n/g, "\n")));
    const procedureFiles = ["symb.bi", "symb-proc.bas", "parser.bi", "parser-proccall-args.bas", "parser-expr-function.bas", "parser-proccall.bas", "parser-proc.bas"];
    const procedureSources = readCompilerCopyFiles(root, compilerDirectory, procedureFiles);
    writeCompilerCopyFiles(root, compilerDirectory, instrumentProcedures(procedureSources));
    const expressionFiles = [...new Set(listCompilerSourceFiles(originalCompilerRoot)
        .map((name) => path.basename(name))
        .filter((name) => /^parser-expr-.*\.bas$/.test(name)))].sort();
    const expressionSources = readCompilerCopyFiles(root, compilerDirectory, expressionFiles);
    writeCompilerCopyFiles(root, compilerDirectory, instrumentExpressions(expressionSources));
    const graphSources = readCompilerCopyFiles(root, compilerDirectory, EXPRESSION_FILES);
    writeCompilerCopyFiles(root, compilerDirectory, instrumentExpressionGraph(graphSources, replaceOnce));
    const recoveryFiles = ["fb.bas", "error.bas", "parser-toplevel.bas", "parser-statement.bas", "parser-decl-symbtype.bas", "parser-expr-unary.bas", "parser-quirk-math.bas", "parser-quirk-peekpoke.bas", "pp.bas"];
    const recoverySources = readCompilerCopyFiles(root, compilerDirectory, recoveryFiles);
    writeCompilerCopyFiles(root, compilerDirectory, instrumentRecovery(recoverySources));
    const symbolSources = readCompilerCopyFiles(root, compilerDirectory, SYMBOL_FILES);
    writeCompilerCopyFiles(root, compilerDirectory, instrumentSymbols(symbolSources, replaceOnce));
    const scopeSources = readCompilerCopyFiles(root, compilerDirectory, SCOPE_FILES);
    writeCompilerCopyFiles(root, compilerDirectory, instrumentScopes(scopeSources, replaceOnce));
    const macroSources = readCompilerCopyFiles(root, compilerDirectory, MACRO_FILES);
    writeCompilerCopyFiles(root, compilerDirectory, instrumentMacros(macroSources, replaceOnce));
    const preprocessorSources = readCompilerCopyFiles(root, compilerDirectory, PREPROCESSOR_FILES);
    writeCompilerCopyFiles(root, compilerDirectory, instrumentPreprocessor(preprocessorSources, replaceOnce));
    const version = readFreeBasicVersion(root).split(".");
    const executable = path.join(build, "fbc-editor");
    const sources = compilerBuildSourceFiles(root).map((name) => path.join(compilerDirectory, name));
    const cObjects = compileCompilerSupportSources(root, compilerDirectory, build);
    const arguments_ = ["-m", "fbc", "-e", "-i", path.join(root, "inc"), "-i", compilerDirectory];
    for (const [index, component] of ["MAJOR", "MINOR", "PATCH"].entries()) arguments_.push("-d", `BUILD_FB_VER_${component}=${version[index]}`);
    arguments_.push(...sources, ...cObjects, "-x", executable);
    if (process.env.FBC_BRIDGE_VERBOSE === "1") {
        console.log(`Compiler support objects: ${cObjects.join(", ") || "none"}`);
        arguments_.push("-v");
    }
    console.log(`Building ${sources.length} compiler modules in ${build}`);
    const result = spawnSync(bootstrap, arguments_, { cwd: build, stdio: "inherit", timeout: 300000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Compiler bridge build failed (${result.status}); sources retained at ${build}`);
    const currentBridge = path.join(outputRoot, "fbc-editor-current");
    try {
        if (fs.existsSync(currentBridge) && !fs.lstatSync(currentBridge).isSymbolicLink()) {
            throw new Error(`Refusing to replace non-link compiler bridge path: ${currentBridge}`);
        }
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const temporaryLink = `${currentBridge}.${process.pid}.${Date.now()}`;
    fs.symlinkSync(path.relative(outputRoot, executable), temporaryLink);
    try {
        fs.renameSync(temporaryLink, currentBridge);
    } catch (error) {
        fs.unlinkSync(temporaryLink);
        throw error;
    }
    console.log(`Compiler bridge build: ${executable}`);
    console.log(`Current compiler bridge: ${currentBridge}`);
    console.log(`Configure freebasic.analysis.compilerPath with this path and includePaths with ${path.join(root, "inc")}.`);
}

if (require.main === module) main();
module.exports = { EXPRESSION_PARSER_HOOKS, instrumentLexer, instrumentProcedures, instrumentSourceIO, instrumentExpressions, instrumentRecovery, instrumentSemanticCoordinates, instrumentSemanticSourceFilter, replaceOnce };

/* end of tools/build-compiler-bridge.js */
