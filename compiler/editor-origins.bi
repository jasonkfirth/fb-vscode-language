''
'' Project: FreeBASIC editor bridge
'' File: editor-origins.bi
'' Purpose: Retain physical source ranges independently of logical #line state.
'' Responsibilities: follow character lookahead and export consumed token spans.
'' Does not contain: macro substitution, source reads, or editor edit policy.
''

'' The lexer is single-threaded. These values live in each lexer context, so
'' includes, preprocessor evaluation, and isolated probes cannot advance the
'' parent source cursor. Character lookahead has already moved the input
'' pointer; its saved origin must move with the cached character instead.
private sub editorReadSourceChar( byval char as uinteger )

	lex.ctx->editor_read.direct = FALSE
	lex.ctx->editor_read.map_root = 0
	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( lex.ctx->kind = LEX_TKCTX_CONTEXT_EVAL ) then exit sub
	if( lex.ctx->deflen > 0 ) then
		lex.ctx->editor_read.map_root = lex.ctx->editor_macro_map
		lex.ctx->editor_read.map_position = lex.ctx->editor_macro_position
		exit sub
	end if
	if( len(lex.ctx->editor_physical_file) = 0 ) then
		lex.ctx->editor_physical_file = env.inf.name
	end if
	'' Offsets exclude the encoding marker, as VS Code's document text does.
	'' UTF-16/32 source needs a separate decoding contract before projection.
	if( (env.inf.format <> FBFILE_FORMAT_ASCII) and (env.inf.format <> FBFILE_FORMAT_UTF8) ) then exit sub
	lex.ctx->editor_read.byte_start = lex.ctx->editor_physical_byte
	lex.ctx->editor_read.character_offset = lex.ctx->editor_physical_character
	lex.ctx->editor_read.byte_end = lex.ctx->editor_physical_byte
	if( char <> 0 ) then
		dim byte_count as integer = 1
		if( env.inf.format = FBFILE_FORMAT_UTF8 ) then
			'' The native Linux compiler uses UTF-32 WSTRING characters here.
			if( char >= &h80 ) then byte_count = 2
			if( char >= &h800 ) then byte_count = 3
			if( char >= &h10000 ) then byte_count = 4
		end if
		lex.ctx->editor_read.byte_end += byte_count
	end if
	lex.ctx->editor_read.direct = TRUE

end sub

private sub editorConsumeChar()

	lex.ctx->editor_consumed = lex.ctx->editor_current
	if( lex.ctx->editor_current.direct = FALSE ) then
		lex.ctx->editor_indirect_chars += 1
	end if

end sub

private sub editorBeginSourceToken( byval token as FBTOKEN ptr )

	token->editor_macro_epoch = editorMacroEpoch()
	token->editor_cached_map = 0
	token->editor_physical_file = lex.ctx->editor_physical_file
	if( len(token->editor_physical_file) = 0 ) then token->editor_physical_file = env.inf.name
	token->editor_physical_start = lex.ctx->editor_current.byte_start
	token->editor_physical_direct = lex.ctx->editor_current.direct
	token->editor_physical_start_line = lex.ctx->physical_linenum
	token->editor_physical_start_column = lex.ctx->column
	token->editor_physical_end_line = 0
	token->editor_physical_end_column = 0
	token->editor_indirect_chars = lex.ctx->editor_indirect_chars
	token->editor_map_root = lex.ctx->editor_current.map_root
	token->editor_map_start = lex.ctx->editor_current.map_position
	token->editor_character_start = lex.ctx->editor_current.character_offset

end sub

private sub editorEndSourceToken( byval token as FBTOKEN ptr )

	token->editor_cached_map = 0
	token->editor_physical_end = lex.ctx->editor_consumed.byte_end
	token->editor_physical_end_line = lex.ctx->physical_linenum
	token->editor_physical_end_column = lex.ctx->column
	token->editor_map_end_root = lex.ctx->editor_consumed.map_root
	token->editor_map_end = lex.ctx->editor_consumed.map_position + 1
	token->editor_character_end = lex.ctx->editor_consumed.character_offset + 1
	if( (lex.ctx->editor_consumed.direct = FALSE) or _
		(token->editor_indirect_chars <> lex.ctx->editor_indirect_chars) or _
		(token->editor_physical_end <= token->editor_physical_start) ) then
		token->editor_physical_direct = FALSE
	end if

end sub

'' The macro lexer consumes source arguments before expression parsing. Keep
'' the parser-visible token range beside its immutable origin map so a later
'' AST range can be projected without guessing from macro spelling.
type FBEDITORORIGINTOKEN
	serial as integer
	start_byte as integer
	end_byte as integer
	map_identity as integer
	file_index as integer
	start_line as integer
	start_column as integer
	end_line as integer
	end_column as integer
end type

dim shared editor_origin_tokens() as FBEDITORORIGINTOKEN
dim shared as integer editor_origin_token_count, editor_origin_token_capacity
declare function editorMapArgumentRange( byval identity as integer ) as LEX_LOCATION

sub editorResetOriginTokens()
	editor_origin_token_count = 0
end sub

sub editorRememberOriginToken _
	( _
		byref site as FBEDITORLOCATION, _
		byval map_identity as integer, _
		byval token as FBTOKEN ptr, _
		byref source_file as const string _
	)
	if( (site.output_line <= 0) or (site.byte_end <= site.byte_column) ) then exit sub
	if( editor_origin_token_count >= 200000 ) then exit sub
	if( editor_origin_token_count >= editor_origin_token_capacity ) then
		if( editor_origin_token_capacity = 0 ) then
			editor_origin_token_capacity = 256
		else
			editor_origin_token_capacity *= 2
		end if
		if( editor_origin_token_capacity > 200000 ) then editor_origin_token_capacity = 200000
		redim preserve editor_origin_tokens(0 to editor_origin_token_capacity - 1)
	end if
	with editor_origin_tokens(editor_origin_token_count)
		.serial = site.output_line
		.start_byte = site.byte_column
		.end_byte = site.byte_end
		.map_identity = map_identity
		if( token->editor_physical_direct ) then
			.file_index = editorFileIdentity(source_file)
			.start_line = token->editor_physical_start_line
			.start_column = token->editor_physical_start_column
			.end_line = token->editor_physical_end_line
			.end_column = token->editor_physical_end_column
		end if
	end with
	editor_origin_token_count += 1
end sub

function editorPhysicalRangeFromTokens _
	( _
		byval start_serial as integer, _
		byval start_byte as integer, _
		byval end_serial as integer, _
		byval end_byte as integer _
	) as FBEDITORPHYSICALRANGE

	dim result as FBEDITORPHYSICALRANGE
	if( environ("FB_VSCODE_TRACE") <> "1" ) then return result
	if( (start_serial <= 0) or (start_byte < 0) or _
		(end_serial < start_serial) or (end_byte < 0) or _
		((start_serial = end_serial) and (end_byte <= start_byte)) ) then return result

	'' Registry entries are appended in emitted-token order. Binary search keeps
	'' range lookup bounded even for the largest accepted trace snapshot.
	dim as integer low = 0, high = editor_origin_token_count
	while( low < high )
		dim middle as integer = low + (high - low) \ 2
		with editor_origin_tokens(middle)
			if( (.serial < start_serial) or _
				((.serial = start_serial) and (.start_byte < start_byte)) ) then
				low = middle + 1
			else
				high = middle
			end if
		end with
	wend

	dim found as integer = FALSE
	dim previous as LEX_LOCATION
	for index as integer = low to editor_origin_token_count - 1
		with editor_origin_tokens(index)
			if( (.serial > end_serial) or _
				((.serial = end_serial) and (.start_byte >= end_byte)) ) then exit for
			if( (.serial < start_serial) or _
				((.serial = start_serial) and (.start_byte < start_byte)) or _
				(.serial > end_serial) or _
				((.serial = end_serial) and (.end_byte > end_byte)) ) then return result
			if( found = FALSE ) then
				if( (.serial <> start_serial) or (.start_byte <> start_byte) ) then return result
			end if
			dim physical as LEX_LOCATION
			if( .file_index ) then
				physical.source_file = editorFileName(.file_index)
				if( len(physical.source_file) = 0 ) then return result
				physical.start_line = .start_line
				physical.start_column = .start_column
				physical.end_line = .end_line
				physical.end_column = .end_column
				physical.is_physical = TRUE
			else
				physical = editorMapArgumentRange(.map_identity)
			end if
			if( physical.is_physical = FALSE ) then return result
			if( found = FALSE ) then
				result.source_file = physical.source_file
				result.start_line = physical.start_line
				result.start_column = physical.start_column
			elseif( result.source_file <> physical.source_file ) then
				return result
			end if
			if( found ) then
				if( physical.start_line < previous.end_line or _
					((physical.start_line = previous.end_line) and _
					 (physical.start_column < previous.end_column)) ) then return result
			end if
			result.end_line = physical.end_line
			result.end_column = physical.end_column
			previous = physical
			found = TRUE
			if( (.serial = end_serial) and (.end_byte = end_byte) ) then
				result.valid = TRUE
				return result
			end if
		end with
	next
	result.valid = FALSE
	return result
end function

private sub editorEmitSourceToken()

	if( env.ppfile_num <= 0 ) then exit sub
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	if( lex.ctx->reclevel <> 0 ) then exit sub
	if( lex.ctx->editor_probe ) then exit sub
	dim token as FBTOKEN ptr = lex.ctx->head
	dim token_file as string = token->editor_physical_file
	if( editor_last_token.byte_end <= editor_last_token.byte_column ) then exit sub
	'' Context-evaluation tokens can inherit a logical #line filename instead of
	'' the file that owns the current input cursor. Resolve those through opens.
	if( editorIsSourceDependency(token_file) = FALSE ) then token_file = editorCurrentPhysicalSource()
	if( len(token_file) = 0 ) then token_file = token->editor_file
	if( len(token_file) = 0 ) then exit sub
	dim kind as string = "generated"
	dim first_byte as integer, last_byte as integer
	dim source_map as integer
	if( token->editor_physical_direct ) then
		kind = "source"
		first_byte = token->editor_physical_start
		last_byte = token->editor_physical_end
	end if
	if( token->editor_physical_direct = FALSE ) then
		source_map = editorTokenMap(token)
		editorExportMap(source_map)
	end if
	dim origin_site as FBEDITORLOCATION = editor_last_token
	editorRememberOriginToken(origin_site, source_map, token, token_file)
	'' Generated tokens carry no editable span. Keeping an explicit record
	'' prevents a consumer from mistaking an absent mapping for direct text.
	print #env.ppfile_num, "''@fb-editor-token-v11 " & editor_last_token.output_line & " " & _
		editor_last_token.byte_column & " " & editor_last_token.byte_end & " " & kind & " " & _
		first_byte & " " & last_byte & " " & editorFileIdentity(token_file) & " " & source_map & " " & token->editor_macro_epoch

end sub

'' end of editor-origins.bi
