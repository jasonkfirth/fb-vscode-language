'' Project: FreeBASIC editor bridge
'' File: editor-scopes.bi
'' Purpose: Export committed lexical regions and declaration inventory.
'' Responsibilities: distinguish source scope instances from native ownership.
'' Does not contain: name resolution, editor visibility policy, or source edits.

type FBEDITORSCOPESLOT
	identity as integer
	symbol as integer
	start_serial as integer
	start_byte as integer
end type

'' The parser is single-threaded. Reopened namespaces share a symbol but have
'' separate source regions. The stack stores integer identities, not pointers
'' to symbols that the compiler can free while unwinding a failed scope.
dim shared editor_scope_stack() as FBEDITORSCOPESLOT
dim shared as integer editor_scope_count, editor_scope_capacity, editor_next_scope

sub editorResetScopes()
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	editor_scope_count = 0
	editor_next_scope = 0
end sub

private function editorScopeEnabled() as integer
	if( env.ppfile_num <= 0 ) then return FALSE
	if( environ("FB_VSCODE_TRACE") <> "1" ) then return FALSE
	return (lex.ctx->reclevel = 0)
end function

function editorCurrentScope() as integer
	if( editor_scope_count = 0 ) then return 0
	return editor_scope_stack(editor_scope_count-1).identity
end function

sub editorOpenScope( byref site as FBEDITORLOCATION, byval sym as FBSYMBOL ptr, byref kind as const string )
	if( editorScopeEnabled() = FALSE or site.output_line <= 0 or sym = NULL ) then exit sub
	editorExportSymbol(sym)
	dim parent as integer = editorCurrentScope()
	if( editor_scope_count = editor_scope_capacity ) then
		'' Geometric growth avoids repeated copying for deeply nested blocks.
		if( editor_scope_capacity = 0 ) then
			editor_scope_capacity = 32
		else
			editor_scope_capacity *= 2
		end if
		redim preserve editor_scope_stack(0 to editor_scope_capacity-1)
	end if
	editor_next_scope += 1
	with editor_scope_stack(editor_scope_count)
		.identity = editor_next_scope
		.symbol = editorSymbolId(sym)
		.start_serial = site.output_line
		.start_byte = site.byte_column
		print #env.ppfile_num, "''@fb-editor-scope begin " & .identity & " " & parent & " " & .symbol & " " & .start_serial & " " & .start_byte & " " & kind
	end with
	editor_scope_count += 1
end sub

sub editorCloseScope( byval sym as FBSYMBOL ptr, byval recovered as integer )
	if( editorScopeEnabled() = FALSE or sym = NULL ) then exit sub
	dim identity as integer = editorSymbolId(sym)
	dim found as integer = editor_scope_count-1
	while( found >= 0 )
		if( editor_scope_stack(found).symbol = identity ) then exit while
		found -= 1
	wend
	if( found < 0 ) then exit sub
	dim ending as FBEDITORLOCATION = editorLastToken()
	while( editor_scope_count > found )
		editor_scope_count -= 1
		with editor_scope_stack(editor_scope_count)
			dim end_serial as integer = ending.output_line
			dim end_byte as integer = ending.byte_end
			if( end_serial < .start_serial or (end_serial = .start_serial and end_byte < .start_byte) ) then
				end_serial = .start_serial
				end_byte = .start_byte
			end if
			'' A container parser may return after diagnosing a missing or wrong
			'' terminator. Its declarations are still useful for completion, but
			'' their extent is not compiler-confirmed and must stay provisional.
			print #env.ppfile_num, "''@fb-editor-scope end " & .identity & " " & end_serial & " " & end_byte & " " & abs((editor_scope_count <> found) or (recovered <> 0))
		end with
	wend
end sub

sub editorDeclareSymbol( byref site as FBEDITORLOCATION, byval sym as FBSYMBOL ptr, byval flags as integer )
	if( editorScopeEnabled() = FALSE or sym = NULL or site.output_line <= 0 ) then exit sub
	if( len(site.spelling) = 0 ) then exit sub
	editorExportSymbol(sym)
	dim ending as FBEDITORLOCATION = editorLastToken()
	if( ending.output_line < site.output_line or (ending.output_line = site.output_line and ending.byte_end < site.byte_column + len(site.spelling)) ) then
		ending.output_line = site.output_line
		ending.byte_end = site.byte_column + len(site.spelling)
	end if
	print #env.ppfile_num, "''@fb-editor-declaration " & editorSymbolId(sym) & " " & editorCurrentScope() & " " & _
		site.output_line & " " & site.byte_column & " " & ending.output_line & " " & ending.byte_end & " " & flags & " " & editorHex(site.spelling)
end sub

sub editorExportShape( byval sym as FBSYMBOL ptr )
	dim as FBSYMBOL ptr base_type = NULL, anonymous_parent = NULL
	dim as integer options = 0, mode = 0, optional_ = 0, dimensions = 0
	select case sym->class
	case FB_SYMBCLASS_STRUCT
		if( sym->udt.base <> NULL ) then base_type = sym->udt.base->subtype
		anonymous_parent = sym->udt.anonparent
		options = sym->udt.options
	case FB_SYMBCLASS_PARAM
		mode = sym->param.mode
		optional_ = abs(symbParamIsOptional(sym) <> 0)
		dimensions = sym->param.bydescdimensions
	case FB_SYMBCLASS_VAR, FB_SYMBCLASS_FIELD
		dimensions = sym->var_.array.dimensions
	end select
	if( base_type <> NULL ) then
		if( base_type->editor_exported = FALSE ) then editorExportSymbol(base_type)
	end if
	if( anonymous_parent <> NULL ) then
		if( anonymous_parent->editor_exported = FALSE ) then editorExportSymbol(anonymous_parent)
	end if
	print #env.ppfile_num, "''@fb-editor-shape " & editorSymbolId(sym) & " " & editorSymbolId(base_type) & " " & editorSymbolId(anonymous_parent) & " " & options & " " & mode & " " & optional_ & " " & dimensions
end sub

sub editorImportNamespace( byval source as FBSYMBOL ptr, byval destination as FBSYMBOL ptr )
	if( editorScopeEnabled() = FALSE ) then exit sub
	dim site as FBEDITORLOCATION = editorLastToken()
	if( site.output_line <= 0 ) then exit sub
	editorExportSymbol(source)
	editorExportSymbol(destination)
	print #env.ppfile_num, "''@fb-editor-import " & editorSymbolId(source) & " " & editorSymbolId(destination) & " " & site.output_line & " " & site.byte_end
end sub

sub editorReset()
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	editorResetTrace()
	editorResetOriginTokens()
	editorResetSymbols()
	editorResetExpressions()
	editorResetScopes()
	editorResetMacroMaps()
	editorResetPreprocessor()
end sub

'' end of editor-scopes.bi
