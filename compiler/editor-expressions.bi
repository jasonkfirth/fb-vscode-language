'' Project: FreeBASIC editor bridge
'' File: editor-expressions.bi
'' Purpose: Retain source expressions across destructive AST transformations.
'' Responsibilities: preserve prefixes and export typed syntax/conversion/call/index edges.
'' Does not contain: type inference, AST ownership, or physical macro projection.

'' The compiler is single-threaded. Parser wrappers exchange the active prefix
'' on their call stack, including every early return and nested argument parse.
'' AST annotations contain values, never borrowed pointers to parser locals.
dim shared as FBEDITORLOCATION editor_expression_prefix
dim shared as integer editor_next_expression
dim shared as string editor_expression_family
dim shared as string editor_recorded_expression_families
dim shared as FBEDITORAST editor_last_syntax

sub editorResetExpressions()
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	editor_expression_prefix.output_line = 0
	editor_expression_prefix.byte_column = 0
	editor_expression_prefix.byte_end = 0
	editor_expression_prefix.spelling = ""
	editor_next_expression = 0
	editor_expression_family = ""
	editor_recorded_expression_families = ""
	editor_last_syntax.identity = 0
	editor_last_syntax.kind = 0
	editor_last_syntax.start_serial = 0
	editor_last_syntax.start_byte = 0
	editor_last_syntax.end_serial = 0
	editor_last_syntax.end_byte = 0
	editor_last_syntax.dtype = 0
	editor_last_syntax.subtype = 0
	editor_last_syntax.target = NULL
end sub

function editorExchangePrefix( byref site as FBEDITORLOCATION ) as FBEDITORLOCATION
	dim previous as FBEDITORLOCATION = editor_expression_prefix
	editor_expression_prefix = site
	return previous
end function

function editorExpressionPrefix() as FBEDITORLOCATION
	if( editor_expression_prefix.output_line > 0 ) then return editor_expression_prefix
	return editorNextToken()
end function

'' Parser wrappers exchange this value around nested entry points. The resulting
'' trace names the compiler path that committed a source expression without
'' adding editor policy or a second expression parser to the bridge.
function editorExchangeExpressionFamily( byref family as const string ) as string
	dim previous as string = editor_expression_family
	editor_expression_family = family
	return previous
end function

private sub editorEmitExpressionFamily( byval identity as integer )
	if( identity <= 0 or len(editor_expression_family) = 0 ) then exit sub
	dim delimiter as string = chr(10) & editor_expression_family & chr(10)
	if( instr(editor_recorded_expression_families, delimiter) > 0 ) then exit sub
	editor_recorded_expression_families &= delimiter
	print #env.ppfile_num, "''@fb-editor-expression-family " & identity & " " & editorHex(editor_expression_family)
end sub

'' Some parser helpers return an expression committed by a deeper parser.
'' Keep their route on that existing source node instead of inventing a second
'' syntax range solely for coverage accounting.
sub editorTagExpressionFamily( byval expr as ASTNODE ptr )
	if( expr = NULL ) then exit sub
	editorEmitExpressionFamily(expr->editor_source.identity)
end sub

function editorAstSource( byval expr as ASTNODE ptr ) as FBEDITORAST
	dim source as FBEDITORAST
	if( expr <> NULL ) then source = expr->editor_source
	return source
end function

function editorAstStart( byval expr as ASTNODE ptr ) as FBEDITORLOCATION
	dim site as FBEDITORLOCATION = editorExpressionPrefix()
	if( expr <> NULL ) then
		if( expr->editor_source.start_serial > 0 ) then
			site.output_line = expr->editor_source.start_serial
			site.byte_column = expr->editor_source.start_byte
		end if
	end if
	return site
end function

sub editorSetAstStart( byval expr as ASTNODE ptr, byref site as FBEDITORLOCATION )
	if( expr = NULL ) then exit sub
	expr->editor_source.start_serial = site.output_line
	expr->editor_source.start_byte = site.byte_column
end sub

private sub editorWriteExpression _
	( byref source as FBEDITORAST, byref kind as const string, byval dtype as integer, byval subtype as FBSYMBOL ptr, _
	  byval first as integer, byval second as integer, byval third as integer, _
	  byval target as FBSYMBOL ptr, byval options as integer )
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( lex.ctx->reclevel <> 0 ) then exit sub
	if( source.start_serial <= 0 ) then exit sub
	if( source.end_serial < source.start_serial ) then exit sub
	if( (source.end_serial = source.start_serial) and (source.end_byte <= source.start_byte) ) then exit sub
	dim type_name as string = editorTypeName(dtype, subtype)
	if( len(type_name) = 0 ) then exit sub
	if( subtype <> NULL ) then
		if( subtype->editor_exported = FALSE ) then editorExportSymbol(subtype)
	end if
	if( target <> NULL ) then editorExportSymbol(target)
	source.dtype = dtype
	source.subtype = editorSymbolId(subtype)
	editor_next_expression += 1
	source.identity = editor_next_expression
	print #env.ppfile_num, "''@fb-editor-expression " & source.identity & " " & kind & " " & _
		source.start_serial & " " & source.start_byte & " " & source.end_serial & " " & source.end_byte & " " & _
		source.dtype & " " & source.subtype & " " & first & " " & second & " " & third & " " & _
		editorSymbolId(target) & " " & options & " " & editorHex(type_name)
	if( kind = "syntax" ) then editor_last_syntax = source
end sub

function editorEmitLeaf( byref site as FBEDITORLOCATION, byval dtype as integer, byval subtype as FBSYMBOL ptr, byval receiver as integer ) as FBEDITORAST
	dim source as FBEDITORAST
	dim ending as FBEDITORLOCATION = editorLastToken()
	source.start_serial = site.output_line
	source.start_byte = site.byte_column
	source.end_serial = ending.output_line
	source.end_byte = ending.byte_end
	source.kind = 1
	editorEmitType(site, dtype, subtype)
	editorWriteExpression(source, "syntax", dtype, subtype, receiver, 0, 0, NULL, 0)
	return source
end function

sub editorEmitExpression( byref site as FBEDITORLOCATION, byval expr as ASTNODE ptr, byval result_dtype as integer = 0, byval result_subtype as FBSYMBOL ptr = NULL, byval override_result_type as integer = FALSE )
	if( expr = NULL ) then exit sub
	if( site.output_line <= 0 ) then exit sub
	if( override_result_type = FALSE ) then
		result_dtype = astGetFullType(expr)
		result_subtype = astGetSubtype(expr)
	end if
	dim ending as FBEDITORLOCATION = editorLastToken()
	dim previous as FBEDITORAST = expr->editor_source
	if( previous.kind = 1 and previous.start_serial = site.output_line and previous.start_byte = site.byte_column and _
		previous.end_serial = ending.output_line and previous.end_byte = ending.byte_end and _
		previous.dtype = result_dtype and previous.subtype = editorSymbolId(result_subtype) ) then exit sub
	if( editor_last_syntax.kind = 1 and editor_last_syntax.start_serial = site.output_line and _
		editor_last_syntax.start_byte = site.byte_column and editor_last_syntax.end_serial = ending.output_line and _
		editor_last_syntax.end_byte = ending.byte_end ) then
		if( override_result_type and (editor_last_syntax.dtype <> result_dtype or _
			editor_last_syntax.subtype <> editorSymbolId(result_subtype)) ) then
			'' A caller with an explicit compiler-known result type can refine an
			'' intermediate syntax node at the same span, as NEW does after its
			'' constructor has been parsed.
			'' Continue below and commit the final result type.
		else
		'' Initializer lowering can wrap a written expression in a target-typed
		'' temporary. Keep the already committed source type; its conversion and
		'' selected constructor have separate graph edges.
			expr->editor_source = editor_last_syntax
			exit sub
		end if
	end if
	dim source as FBEDITORAST
	source.start_serial = site.output_line
	source.start_byte = site.byte_column
	source.end_serial = ending.output_line
	source.end_byte = ending.byte_end
	source.kind = 1
	editorEmitType(site, result_dtype, result_subtype)
	'' The generic runtime and intrinsic parsers construct an AST CALL before
	'' adding its arguments. astNewCALL records its selected target, while
	'' astNewARG carries that marker through the argument chain. This parser
	'' boundary is the first point with the complete written call range.
	''
	'' Ordinary source calls already emit their own record after overload
	'' resolution, so editorEmitCall clears the marker before arriving here.
	if( previous.target <> NULL ) then
		editorWriteExpression(source, "call", result_dtype, result_subtype, previous.identity, 0, 0, previous.target, 2)
		previous = source
	end if
	editorWriteExpression(source, "syntax", result_dtype, result_subtype, previous.identity, 0, 0, NULL, 0)
	if( source.identity ) then
		'' Family records deliberately follow only completed parser-boundary
		'' syntax, once per parser family in one compiler invocation. Tagging
		'' every lowering node would turn large compiler tests into substantially
		'' larger traces without improving grammar coverage.
		editorEmitExpressionFamily(source.identity)
		expr->editor_source = source
	end if
end sub

sub editorEmitTransform _
	( byref kind as const string, byval expr as ASTNODE ptr, _
	  byref first as FBEDITORAST, byref second as FBEDITORAST, byref third as FBEDITORAST, _
	  byval target as FBSYMBOL ptr, byval options as integer )
	if( expr = NULL ) then exit sub
	dim source as FBEDITORAST
	for index as integer = 0 to 2
		dim operand as FBEDITORAST
		select case index
		case 0: operand = first
		case 1: operand = second
		case 2: operand = third
		end select
		if( operand.identity = 0 ) then continue for
		if( (source.start_serial = 0) or (operand.start_serial < source.start_serial) or _
			((operand.start_serial = source.start_serial) and (operand.start_byte < source.start_byte)) ) then
			source.start_serial = operand.start_serial
			source.start_byte = operand.start_byte
		end if
		if( (operand.end_serial > source.end_serial) or _
			((operand.end_serial = source.end_serial) and (operand.end_byte > source.end_byte)) ) then
			source.end_serial = operand.end_serial
			source.end_byte = operand.end_byte
		end if
	next
	'' Transform ranges identify contributing source, not additional written
	'' syntax. In particular, implicit conversions must not replace hover types
	'' for the operand at the same span.
	source.kind = 2
	editorWriteExpression(source, kind, astGetFullType(expr), astGetSubtype(expr), first.identity, second.identity, third.identity, target, options)
	if( source.identity ) then expr->editor_source = source
end sub

sub editorEmitIndex _
	( byval expr as ASTNODE ptr, byref receiver as FBEDITORAST, byref indexexpr as FBEDITORAST )
	if( expr = NULL ) then exit sub
	dim empty as FBEDITORAST
	dim source as FBEDITORAST
	for position as integer = 0 to 1
		dim operand as FBEDITORAST
		if( position = 0 ) then operand = receiver else operand = indexexpr
		if( operand.identity = 0 ) then continue for
		if( (source.start_serial = 0) or (operand.start_serial < source.start_serial) or _
			((operand.start_serial = source.start_serial) and (operand.start_byte < source.start_byte)) ) then
			source.start_serial = operand.start_serial
			source.start_byte = operand.start_byte
		end if
		if( (operand.end_serial > source.end_serial) or _
			((operand.end_serial = source.end_serial) and (operand.end_byte > source.end_byte)) ) then
			source.end_serial = operand.end_serial
			source.end_byte = operand.end_byte
		end if
	next
	if( source.start_serial = 0 ) then exit sub
	'' astNewIDX is called after the parser consumes the closing delimiter.
	'' The two operand spans alone stop at the index literal, so retain that
	'' completed physical delimiter without inferring a source range elsewhere.
	dim ending as FBEDITORLOCATION = editorLastToken()
	if( (ending.output_line > source.end_serial) or _
		((ending.output_line = source.end_serial) and (ending.byte_end > source.end_byte)) ) then
		source.end_serial = ending.output_line
		source.end_byte = ending.byte_end
	end if
	source.kind = 2
	editorWriteExpression(source, "index", astGetFullType(expr), astGetSubtype(expr), receiver.identity, indexexpr.identity, empty.identity, NULL, 0)
	if( source.identity ) then expr->editor_source = source
end sub

sub editorEmitCall( byref site as FBEDITORLOCATION, byval expr as ASTNODE ptr, byval target as FBSYMBOL ptr, byval callee as integer, byval generated as integer = FALSE, byval result_dtype as integer = 0, byval result_subtype as FBSYMBOL ptr = NULL, byval override_result_type as integer = FALSE )
	if( expr = NULL ) then exit sub
	if( override_result_type = FALSE ) then
		result_dtype = astGetFullType(expr)
		result_subtype = astGetSubtype(expr)
	end if
	dim ending as FBEDITORLOCATION = editorLastToken()
	dim source as FBEDITORAST
	source.start_serial = site.output_line
	source.start_byte = site.byte_column
	source.end_serial = ending.output_line
	source.end_byte = ending.byte_end
	source.kind = 2
	'' Option one identifies a direct source call. Option two identifies a
	'' language construct whose parser creates a runtime call after consuming
	'' its source syntax, such as THREADCALL.
	'' Some lowered constructs retain an intermediate AST type. Callers may
	'' supply the compiler-known result type without changing that AST.
	editorWriteExpression(source, "call", result_dtype, result_subtype, callee, expr->editor_source.identity, 0, target, iif(generated, 2, 1))
	if( source.identity ) then expr->editor_source = source
	editorEmitExpression(site, expr, result_dtype, result_subtype, TRUE)
end sub

sub editorEmitImplicitDeclarationCall _
	( _
		byref site as FBEDITORLOCATION, _
		byval dtype as integer, _
		byval subtype as FBSYMBOL ptr, _
		byval target as FBSYMBOL ptr _
	)
	if( site.output_line <= 0 or len(site.spelling) = 0 ) then exit sub
	if( target = NULL or symbIsProc(target) = FALSE ) then exit sub

	'' A default constructor has no call spelling or argument syntax in source.
	'' Anchor the selected compiler call to the declared identifier, and leave
	'' its operands empty instead of fabricating a source expression.
	dim source as FBEDITORAST
	source.start_serial = site.output_line
	source.start_byte = site.byte_column
	source.end_serial = site.output_line
	source.end_byte = site.byte_column + len(site.spelling)
	source.kind = 2
	editorWriteExpression(source, "call", dtype, subtype, 0, 0, 0, target, 2)
end sub

sub editorEmitArgument( byval parent as ASTNODE ptr, byval arg as ASTNODE ptr, byref before as FBEDITORAST )
	if( parent = NULL or arg = NULL ) then exit sub
	if( arg->l = NULL ) then exit sub
	dim previous as FBEDITORAST = editorAstSource(parent)
	dim target as FBSYMBOL ptr = previous.target
	dim converted as FBEDITORAST = editorAstSource(arg->l)
	'' astNewARG links arguments in backend push order. The insertion ordinal
	'' is the source parameter order on all calling conventions. A persistent
	'' chain records arbitrary arity without borrowing nodes later freed by fbc.
	'' Inputs are previous argument, written value, and converted value. Defaults
	'' can refer to their declaration expression instead of a fabricated call span.
	editorEmitTransform("argument", arg->l, previous, before, converted, NULL, parent->call.args)
	'' A nested lexer context can suppress an export. Do not replace the chain
	'' with an old conversion annotation when no argument record was committed.
	if( arg->l->editor_source.identity <> converted.identity ) then parent->editor_source = arg->l->editor_source
	'' The call's target was known before its arguments had source ranges.
	'' Preserve it across the transient argument node until cAtom commits it.
	if( target <> NULL ) then parent->editor_source.target = target
end sub

'' end of editor-expressions.bi
