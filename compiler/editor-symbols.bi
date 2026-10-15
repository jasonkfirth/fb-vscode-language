''
'' Project: FreeBASIC editor bridge
'' File: editor-symbols.bi
'' Purpose: Export compiler-owned symbol identities and relationships.
'' Responsibilities: identify pooled symbols, record committed uses and aliases.
'' Does not contain: name lookup, overload selection, or editor refactoring policy.
''

'' IDs are assigned by deterministic parser visits, not by symbol addresses.
'' The private compiler initializes the two fields at both pool allocation sites.
'' The global namespace is the distinguished root, ID zero.
dim shared as integer editor_next_symbol

sub editorResetSymbols()
	if( environ("FB_VSCODE_TRACE") = "1" ) then editor_next_symbol = 0
end sub

function editorSymbolId( byval sym as FBSYMBOL ptr ) as integer
	if( sym = NULL ) then return 0
	if( sym = @symbGetGlobalNamespc() ) then return 0
	if( sym->editor_symbol_id = 0 ) then
		editor_next_symbol += 1
		sym->editor_symbol_id = editor_next_symbol
	end if
	return sym->editor_symbol_id
end function

function editorTypeName( byval dtype as integer, byval subtype as FBSYMBOL ptr ) as string
	dim datatype as integer = dtype and FB_DT_TYPEMASK
	dim pointer_count as integer = (dtype and FB_DT_PTRMASK) shr FB_DT_PTRPOS
	if( (dtype and FB_DATATYPE_INVALID) <> 0 ) then return ""
	if( datatype > FB_DATATYPE_XMMWORD ) then return ""
	if( pointer_count > FB_DT_PTRLEVELS ) then return ""
	select case datatype
	case FB_DATATYPE_STRUCT, FB_DATATYPE_ENUM, FB_DATATYPE_FWDREF, FB_DATATYPE_FUNCTION
		if( (subtype = NULL) or (subtype = cast(FBSYMBOL ptr, INVALID)) ) then return ""
	end select
	return symbTypeToStr(dtype, subtype)
end function

sub editorExportSymbol( byval sym as FBSYMBOL ptr )
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	dim identity as integer = editorSymbolId(sym)
	if( identity = 0 ) then exit sub
	sym->editor_exported = TRUE
	dim owner as FBSYMBOL ptr = NULL
	dim namespc as FBSYMBOL ptr = NULL
	if( sym->symtb <> NULL ) then owner = sym->symtb->owner
	if( sym->hash.tb <> NULL ) then namespc = sym->hash.tb->owner
	'' Recursive types and owner links form cycles. Mark before visiting edges.
	'' Re-export the directly used symbol so forward patches and final parameter
	'' types replace their earlier metadata, without recursively walking old edges.
	for edge as integer = 0 to 2
		dim related as FBSYMBOL ptr
		select case edge
		case 0: related = owner
		case 1: related = namespc
		case 2: related = sym->subtype
		end select
		if( related <> NULL ) then
			if( related->editor_exported = FALSE ) then editorExportSymbol(related)
		end if
	next
	dim name_hex as string = "-"
	dim type_hex as string = "-"
	dim full_type as integer = symbGetFullType(sym)
	dim type_name as string
	if( symbGetName(sym) <> NULL ) then
		if( len(*symbGetName(sym)) ) then name_hex = editorHex(*symbGetName(sym))
	end if
	select case symbGetClass(sym)
	case FB_SYMBCLASS_STRUCT, FB_SYMBCLASS_ENUM
		type_hex = name_hex
	case FB_SYMBCLASS_VAR, FB_SYMBCLASS_CONST, FB_SYMBCLASS_FIELD, FB_SYMBCLASS_PARAM, FB_SYMBCLASS_PROC, FB_SYMBCLASS_TYPEDEF
		type_name = editorTypeName(full_type, symbGetSubtype(sym))
		if( len(type_name) > 0 ) then type_hex = editorHex(type_name)
	end select
	dim procedure_id as integer = 0
	if( symbIsProc(sym) ) then procedure_id = sym->proc.editor_id
	print #env.ppfile_num, "''@fb-editor-symbol " & identity & " " & sym->class & " " & sym->typ & " " & _
		editorSymbolId(sym->subtype) & " " & editorSymbolId(owner) & " " & editorSymbolId(namespc) & " " & _
		sym->attrib & " " & sym->pattrib & " " & sym->scope & " " & procedure_id & " " & name_hex & " " & type_hex
	editorExportShape(sym)
	if( symbIsProc(sym) ) then
		dim overridden as FBSYMBOL ptr = symbProcGetOverridden(sym)
		if( overridden <> NULL ) then
			if( overridden->editor_exported = FALSE ) then editorExportSymbol(overridden)
		end if
		'' Zero is an ordinary nonvirtual procedure. Slots zero and one in an
		'' actual vtable are reserved for the compiler's runtime type metadata.
		print #env.ppfile_num, "''@fb-editor-dispatch " & identity & " " & editorSymbolId(overridden) & " " & symbProcGetVtableIndex(sym)
	end if
	if( (sym->mangling <> FB_MANGLING_BASIC) or (sym->stats and FB_SYMBSTATS_HASALIAS) or (sym->attrib and FB_SYMBATTRIB_EXPORT) ) then
		print #env.ppfile_num, "''@fb-editor-symbol-norename " & identity
	end if
end sub

sub editorEmitSymbol( byref site as FBEDITORLOCATION, byval sym as FBSYMBOL ptr, byval is_declaration as integer )
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( sym = NULL ) then exit sub
	if( site.output_line <= 0 ) then exit sub
	if( len(site.spelling) = 0 ) then exit sub
	'' Parser helpers can return internal operator symbols for assignment forms.
	'' Only source spellings that can name a declaration belong in the binding graph.
	dim first_character as integer = asc(site.spelling)
	dim is_numeric_label as integer = FALSE
	if( symbGetClass(sym) = FB_SYMBCLASS_LABEL ) then
		is_numeric_label = ((first_character >= asc("0")) and (first_character <= asc("9"))) or _
			(ucase(left(site.spelling, 2)) = "&H") or _
			(ucase(left(site.spelling, 2)) = "&O") or _
			(ucase(left(site.spelling, 2)) = "&B")
	end if
	if( ((first_character < asc("A")) or (first_character > asc("Z"))) and _
		((first_character < asc("a")) or (first_character > asc("z"))) and _
		(first_character <> asc("_")) and (first_character < &h80) ) then
		if( is_numeric_label = FALSE ) then exit sub
	end if
	if( lex.ctx->reclevel <> 0 ) then exit sub
	if( symbGetName(sym) <> NULL ) then
		if( ucase(site.spelling) <> ucase(*symbGetName(sym)) ) then exit sub
	else
		'' Prototype parameter names are intentionally discarded by fbc. Their
		'' committed parser site still names the parameter at this ordinal.
		if( (sym->class <> FB_SYMBCLASS_PARAM) or (is_declaration = FALSE) ) then exit sub
	end if
	editorExportSymbol(sym)
	print #env.ppfile_num, "''@fb-editor-use " & iif(is_declaration, "declaration", "reference") & " " & _
		site.output_line & " " & site.byte_column & " " & editorSymbolId(sym) & " " & editorHex(site.spelling)
	if( is_declaration ) then editorDeclareSymbol(site, sym, 0)
end sub

sub editorReference( byval sym as FBSYMBOL ptr )
	dim site as FBEDITORLOCATION = editorNextToken()
	editorEmitSymbol(site, sym, FALSE)
end sub

sub editorAliasSymbol( byval source as FBSYMBOL ptr, byval canonical as FBSYMBOL ptr )
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( (source = NULL) or (canonical = NULL) ) then exit sub
	editorExportSymbol(source)
	editorExportSymbol(canonical)
	if( source <> canonical ) then print #env.ppfile_num, "''@fb-editor-alias " & editorSymbolId(source) & " " & editorSymbolId(canonical)
end sub

'' end of editor-symbols.bi
