''
'' Project: FreeBASIC editor bridge
'' File: editor-trace.bi
'' Purpose: Attach origins and committed procedure bindings to -pp output.
'' Responsibilities: retain expanded coordinates and canonical procedure IDs.
'' Does not contain: overload selection, compiler options, or editor UI.
''

'' This file is included after lex and pponly_ln in the private compiler copy.
'' The compiler is single-threaded. One output line owns this pending origin.
dim shared as string editor_source_file
dim shared as integer editor_source_line, editor_generated
dim shared as integer editor_output_line, editor_next_proc
dim shared as FBEDITORLOCATION editor_last_token
dim shared as integer editor_reached_end
'' Successful source opens are remembered until the output snapshot is complete.
'' Logical #line names are kept separate from physical dependency identity.
dim shared as integer editor_dependency_count
dim shared as string editor_dependency_files(1 to 5000)
dim shared as string editor_open_source_files(0 to 5000)
dim shared as integer editor_open_source_depth
constructor FBEDITORQUERYSCOPE()
	this.active = FALSE
end constructor

sub FBEDITORQUERYSCOPE.enter(byval token as integer)
	if( this.active ) then exit sub
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( (token <> FB_TK_TYPEOF) and (token <> FB_TK_SIZEOF) ) then exit sub
	this.first = editorNextToken()
	'' Preprocessor expression contexts have no expanded output token.
	if( this.first.output_line <= 0 ) then exit sub
	this.active = TRUE
end sub

destructor FBEDITORQUERYSCOPE()
	if( this.active ) then
		dim as FBEDITORLOCATION last = editorLastToken()
		if( last.output_line < this.first.output_line ) then exit destructor
		if( (last.output_line = this.first.output_line) and _
		    (last.byte_end <= this.first.byte_column) ) then exit destructor
		'' Keep all name/type facts. This range classifies runtime hierarchy
		'' sites in expanded coordinates, including implicit calls and macros.
		print #env.ppfile_num, "''@fb-editor-unevaluated " & _
			this.first.output_line & " " & this.first.byte_column & " " & _
			last.output_line & " " & last.byte_end
	end if
end destructor

private function editorHex( byref value as const string ) as string

	dim as string encoded
	for index as integer = 1 to len(value)
		encoded += hex(asc(value, index), 2)
	next
	return encoded

end function

function editorLastToken() as FBEDITORLOCATION

	return editor_last_token

end function

function editorNextToken() as FBEDITORLOCATION
	dim site as FBEDITORLOCATION
	if( env.ppfile_num <= 0 ) then return site
	if( environ("FB_VSCODE_TRACE") <> "1" ) then return site
	if( lex.ctx->reclevel <> 0 ) then return site
	lexGetToken()
	site.output_line = editor_output_line + 1
	site.byte_column = len(pponly_ln) + abs(lex.ctx->head->after_space <> 0)
	site.spelling = *lexGetText()
	return site
end function

sub editorEmitType( byref site as FBEDITORLOCATION, byval dtype as integer, byval subtype as FBSYMBOL ptr )
	if( site.output_line <= 0 ) then exit sub
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( lex.ctx->reclevel <> 0 ) then exit sub
	if( editor_last_token.output_line < site.output_line ) then exit sub
	if( (editor_last_token.output_line = site.output_line) and (editor_last_token.byte_end <= site.byte_column) ) then exit sub
	dim type_name as string = editorTypeName(dtype, subtype)
	if( len(type_name) = 0 ) then exit sub
	static previous as string
	if( subtype <> NULL ) then
		if( subtype->editor_exported = FALSE ) then editorExportSymbol(subtype)
	end if
	dim record as string = "''@fb-editor-type " & site.output_line & " " & site.byte_column & " " & _
		editor_last_token.output_line & " " & editor_last_token.byte_end & " " & editorHex(type_name) & " " & dtype & " " & editorSymbolId(subtype)
	'' Precedence levels often return the same expression unchanged.
	if( record <> previous ) then print #env.ppfile_num, record
	previous = record
end sub

sub editorEmitReceiver( byval dtype as integer, byval subtype as FBSYMBOL ptr )
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( lex.ctx->reclevel <> 0 ) then exit sub
	dim site as FBEDITORLOCATION = editorNextToken()
	dim type_name as string = editorTypeName(dtype, subtype)
	if( len(type_name) = 0 ) then exit sub
	if( subtype <> NULL ) then
		if( subtype->editor_exported = FALSE ) then editorExportSymbol(subtype)
	end if
	print #env.ppfile_num, "''@fb-editor-receiver " & site.output_line & " " & site.byte_column & " " & editorHex(type_name) & " " & dtype & " " & editorSymbolId(subtype)
end sub

private sub editorRecordToken()

	editor_last_token.output_line = editor_output_line + 1
	editor_last_token.byte_column = len(pponly_ln)
	editor_last_token.spelling = *lexGetText()

end sub

sub editorEmitProcedure( byref site as FBEDITORLOCATION, byval proc as FBSYMBOL ptr, byval is_declaration as integer )

	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( proc = NULL ) then exit sub
	if( symbIsProc(proc) = FALSE ) then exit sub
	if( symbGetName(proc) = NULL ) then exit sub
	if( site.output_line <= 0 ) then exit sub
	'' Constructors/operators and implicit calls need different source anchors.
	'' Never attach one to an unrelated token that happened to be consumed last.
	if( ucase(site.spelling) <> ucase(*symbGetName(proc)) ) then exit sub

	if( is_declaration and (proc->proc.editor_id = 0) ) then
		editor_next_proc += 1
		proc->proc.editor_id = editor_next_proc
	end if
	if( is_declaration ) then
		'' ABI aliases and exported entry points may have callers outside this
		'' project. Virtual families are validated through native dispatch edges.
		if( (symbGetMangling(proc) <> FB_MANGLING_BASIC) or _
			(proc->stats and FB_SYMBSTATS_HASALIAS) or _
			(proc->attrib and FB_SYMBATTRIB_EXPORT) ) then
			print #env.ppfile_num, "''@fb-editor-norename " & proc->proc.editor_id
		end if
	end if
	'' Zero means the compiler selected a proc without an exported declaration.
	'' The editor must not replace that decision with a same-spelling guess.
	print #env.ppfile_num, "''@fb-editor-bind " & _
		iif(is_declaration, "declaration", "call") & " " & _
		site.output_line & " " & site.byte_column & " " & _
	proc->proc.editor_id & " " & editorHex(site.spelling)
	editorEmitSymbol(site, proc, is_declaration)

end sub

private sub editorRememberFileDependency( byref filename as const string )

	if( len(filename) = 0 ) then exit sub
	for index as integer = 1 to editor_dependency_count
		if( editor_dependency_files(index) = filename ) then exit sub
	next
	if( editor_dependency_count >= 5000 ) then exit sub
	editor_dependency_count += 1
	editor_dependency_files(editor_dependency_count) = filename

end sub

sub editorRememberSourcePath( byref filename as const string )

	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( (env.includerec < 0) or (env.includerec > 5000) ) then exit sub
	editor_open_source_files(env.includerec) = filename
	if( env.includerec > editor_open_source_depth ) then editor_open_source_depth = env.includerec
	editorRememberFileDependency(filename)

end sub

function editorCurrentPhysicalSource() as string

	if( (env.includerec < 0) or (env.includerec > 5000) ) then return ""
	for depth as integer = env.includerec to 0 step -1
		if( len(editor_open_source_files(depth)) > 0 ) then return editor_open_source_files(depth)
	next
	return ""

end function

function editorIsSourceDependency( byref filename as const string ) as integer

	for index as integer = 1 to editor_dependency_count
		if( editor_dependency_files(index) = filename ) then return TRUE
	next
	return FALSE

end function

sub editorResetTrace()

	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	editor_source_file = ""
	editor_source_line = 0
	editor_generated = FALSE
	editor_output_line = 0
	editor_next_proc = 0
	editor_last_token.output_line = 0
	editor_last_token.byte_column = 0
	editor_last_token.byte_end = 0
	editor_last_token.spelling = ""
	editor_reached_end = FALSE
	for index as integer = 1 to editor_dependency_count
		editor_dependency_files(index) = ""
	next
	editor_dependency_count = 0
	for depth as integer = 0 to editor_open_source_depth
		editor_open_source_files(depth) = ""
	next
	editor_open_source_depth = 0

end sub

private sub editorStartLine()

	if( len(pponly_ln) = 0 ) then
		editor_source_file = lex.ctx->head->editor_file
		editor_source_line = lex.ctx->head->editor_line
		editor_generated = FALSE
	end if
	if( lex.ctx->head->editor_expanded or _
		lex.ctx->head->editor_line <> editor_source_line or _
		lex.ctx->head->editor_file <> editor_source_file ) then
		editor_generated = TRUE
	end if

end sub

private sub editorEmitOrigin()

	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	editor_output_line += 1
	'' The serial links earlier call records to the eventual buffered line.
	'' Hex encoding makes paths unambiguous without JSON escaping.
	print #env.ppfile_num, "''@fb-editor-v2 " & editor_output_line & " " & _
		editor_source_line & " " & abs(editor_generated <> 0) & " " & _
		editorHex(editor_source_file)

end sub

sub editorInvalidateRegion( byref site as FBEDITORLOCATION, byval errors_before as integer )
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( errGetCount() = errors_before ) then exit sub
	if( site.output_line <= 0 ) then exit sub
	'' A failed statement may return an invented zero or repaired declaration.
	'' Invalidate the whole parsed region, including records emitted before the
	'' error. Retain the original text for the read-only expanded view.
	dim last_line as integer = editor_last_token.output_line
	if( last_line < site.output_line ) then last_line = site.output_line
	print #env.ppfile_num, "''@fb-editor-invalid " & site.output_line & " " & last_line
end sub

sub editorEmitError( byval error_code as integer, byval source_line as integer )
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	'' Errors in directives or final label checks need an origin even when no
	'' cStatement() frame is active. Error reporting can occur while fetching a
	'' token, so the parser lookahead position is optional. When available, it
	'' lets the editor retain completed child expressions before the failing token.
	if( source_line > 0 ) then
		dim as FBEDITORLOCATION site = editorNextToken()
		dim as string record = "''@fb-editor-error " & source_line & " " & editorHex(env.inf.name) & " " & error_code
		if( site.output_line > 0 ) then
			record += " " & site.output_line & " " & site.byte_column
		end if
		print #env.ppfile_num, record
	end if
end sub

sub editorReachedEnd()
	if( env.includerec = 0 ) then editor_reached_end = TRUE
end sub

sub editorFinish()
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	'' An error-limit stop can leave the final expanded line buffered. Flush
	'' only that text, without advancing the parser or reading a closed file.
	if( len(pponly_ln) > 0 ) then
		editorEmitOrigin()
		print #env.ppfile_num, pponly_ln
		pponly_ln = ""
	end if
	'' Declare only files successfully opened as source. #line names are logical
	'' locations and must not become project dependencies.
	print #env.ppfile_num, "''@fb-editor-protocol 15"
	for index as integer = 1 to editor_dependency_count
		dim filename as string = editor_dependency_files(index)
		print #env.ppfile_num, "''@fb-editor-file-v10 " & editorFileIdentity(filename) & " " & editorHex(filename)
	next
	print #env.ppfile_num, "''@fb-editor-end " & errGetCount() & " " & abs(editor_reached_end <> 0)
end sub

'' end of editor-trace.bi
