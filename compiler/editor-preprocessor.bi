''
'' Project: FreeBASIC editor bridge
'' File: editor-preprocessor.bi
'' Purpose: Export committed preprocessor declarations and lookup decisions.
'' Responsibilities: retain parameter slots, definition instances, and epochs.
'' Does not contain: symbol lookup, macro evaluation, or editor rename policy.
''

'' The preprocessor is single-threaded. A definition instance owns its parameter
'' names even when an equivalent redefinition reuses an existing DEFINE symbol.
'' Epochs advance only when the active macro environment changes; lexer tokens
'' capture that epoch before lookahead can process a later directive.
dim shared as integer editor_macro_declarations, editor_macro_epoch
dim shared as integer editor_preprocessor_records

sub editorResetPreprocessor()
	editor_macro_declarations = 0
	editor_macro_epoch = 0
	editor_preprocessor_records = 0
end sub

function editorMacroEpoch() as integer

	return editor_macro_epoch

end function

private function editorPreprocessorRecord() as integer

	if( editorMapEnabled() = FALSE ) then return FALSE
	editor_preprocessor_records += 1
	if( editor_preprocessor_records > 200000 ) then
		editor_map_failed = TRUE
		print #env.ppfile_num, "''@fb-editor-preprocessor-overflow"
		return FALSE
	end if
	return TRUE

end function

sub editorPreprocessorContext( byval site as integer )

	'' Conditional directives disappear from preprocessed output. Their source
	'' map therefore anchors an editor query to the environment the compiler had
	'' before it evaluates that condition, including definitions from includes.
	if( site = 0 ) then exit sub
	if( editorPreprocessorRecord() = FALSE ) then exit sub
	editorExportMap(site)
	print #env.ppfile_num, "''@fb-editor-macro-context " & site & " " & editor_macro_epoch

end sub

sub editorMacroReference( byval sym as FBSYMBOL ptr, byval site as integer, byref role as const string, byval spelling as const zstring ptr )

	if( editorPreprocessorRecord() = FALSE ) then exit sub
	if( spelling = NULL ) then exit sub
	if( len(*spelling) = 0 ) then exit sub
	if( role = "undef" ) then
		if( sym <> NULL ) then
			if( symbIsDefine(sym) ) then editor_macro_epoch += 1
		end if
	end if
	if( sym <> NULL ) then
		if( (sym->editor_exported = FALSE) or (symbIsDefine(sym) = FALSE) ) then editorExportSymbol(sym)
	end if
	editorExportMap(site)
	print #env.ppfile_num, "''@fb-editor-macro-reference " & editorSymbolId(sym) & " " & site & " " & _
		editor_macro_epoch & " " & role & " " & editorHex(*spelling)

end sub

sub editorMacroDeclaration( byval sym as FBSYMBOL ptr, byval site as integer, byval paramhead as FB_DEFPARAM ptr, byval tokhead as FB_DEFTOK ptr )

	if( sym = NULL ) then exit sub
	if( symbIsDefine(sym) = FALSE ) then exit sub
	if( editorPreprocessorRecord() = FALSE ) then exit sub
	editor_macro_epoch += 1
	editor_macro_declarations += 1
	dim instance as integer = editor_macro_declarations
	if( sym->editor_exported = FALSE ) then editorExportSymbol(sym)
	editorExportMap(site)
	'' Compiler macro counts can use the last zero-based ordinal. The sidecar
	'' schema reports actual slots so readers can validate the full parameter list.
	dim parameter_count as integer = 0
	dim parameter_cursor as FB_DEFPARAM ptr = paramhead
	while( parameter_cursor <> NULL )
		parameter_count += 1
		parameter_cursor = parameter_cursor->next
	wend
	print #env.ppfile_num, "''@fb-editor-macro-declaration " & instance & " " & editorSymbolId(sym) & " " & _
		site & " " & editor_macro_epoch & " " & parameter_count & " " & symbGetDefineFlags(sym) & " " & abs(symbGetDefineIsArgless(sym) <> 0)

	'' Parameter/token storage is pooled. Export scalar IDs and spelling while
	'' it is still owned by this definition, before a matching redefinition frees it.
	dim param as FB_DEFPARAM ptr = paramhead
	while( param <> NULL )
		if( editorPreprocessorRecord() = FALSE ) then exit sub
		editorExportMap(param->editor_map)
		print #env.ppfile_num, "''@fb-editor-macro-parameter " & instance & " " & param->num & " declaration " & _
			param->editor_map & " " & editorHex(*param->name)
		param = param->next
	wend
	dim dt as FB_DEFTOK ptr = tokhead
	while( dt <> NULL )
		'' Replacement identifiers are expanded in the invocation environment,
		'' not necessarily the definition environment. Export their physical
		'' spelling as explicitly deferred rather than attaching a speculative
		'' DEFINE identity that could make validated rename unsafe.
		if( dt->type = FB_DEFTOK_TYPE_TEX ) then
			editorMacroReference(NULL, dt->editor_map, "deferred", dt->text)
		end if
		if( (dt->type = FB_DEFTOK_TYPE_PARAM) or (dt->type = FB_DEFTOK_TYPE_PARAMSTR) ) then
			param = paramhead
			while( param <> NULL )
				if( param->num = dt->paramnum ) then exit while
				param = param->next
			wend
			if( param <> NULL ) then
				if( editorPreprocessorRecord() = FALSE ) then exit sub
				editorExportMap(dt->editor_map)
				print #env.ppfile_num, "''@fb-editor-macro-parameter " & instance & " " & param->num & " reference " & _
					dt->editor_map & " " & editorHex(*param->name)
			end if
		end if
		dt = dt->next
	wend

end sub

'' end of editor-preprocessor.bi
