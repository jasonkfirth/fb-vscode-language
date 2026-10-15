''
'' Project: FreeBASIC editor bridge
'' File: editor-macro-maps.bi
'' Purpose: Preserve native preprocessor text provenance across substitutions.
'' Responsibilities: own bounded immutable maps and export their relationships.
'' Does not contain: macro evaluation, source rewriting, or refactoring policy.
''

'' Maps address native lexer characters, not emitted bytes. Narrow input uses
'' bytes; the Linux wide lexer uses UTF-32 characters. Source leaves also keep
'' physical UTF-8 byte ranges. A copied identifier is affine in both domains;
'' a converted literal can retain its whole source span without inventing an
'' interior byte position. IDs, not pointers, survive array growth and probes.
type FBEDITORMAPNODE
	kind as integer
	length as integer
	height as integer
	first as integer
	second as integer
	offset as integer
	file_index as integer
	byte_start as integer
	byte_end as integer
	start_line as integer
	start_column as integer
	end_line as integer
	end_column as integer
	target as integer
	parameter_index as integer
	emitted as integer
end type

type FBEDITORMAPBUILDER
	chunks(0 to 31) as integer
	length as integer
	result as integer
end type

dim shared editor_maps() as FBEDITORMAPNODE
dim shared editor_map_builders() as FBEDITORMAPBUILDER
dim shared editor_map_files() as string
dim shared as integer editor_map_count, editor_map_capacity, editor_map_file_count
dim shared as integer editor_map_failed
dim shared as integer editor_builder_count, editor_builder_capacity
dim shared as FBEDITORMACROFRAME editor_macro_frame
'' Open addressing stays below one-half load at the arena's million-node
'' bound. Interning avoids allocating the same immutable slice repeatedly.
const EDITOR_MAP_HASH_MASK = (1 shl 21) - 1
dim shared editor_map_hash(0 to EDITOR_MAP_HASH_MASK) as integer

declare function editorSealMap( byval identity as integer ) as integer

sub editorResetMacroMaps()
	if( environ("FB_VSCODE_TRACE") <> "1" ) then exit sub
	editor_map_count = 0
	editor_map_file_count = 0
	editor_map_failed = FALSE
	editor_builder_count = 0
	editor_macro_frame.site = 0
	editor_macro_frame.target = 0
	for index as integer = 0 to EDITOR_MAP_HASH_MASK
		editor_map_hash(index) = 0
	next
end sub

private function editorMapEnabled() as integer
	if( env.ppfile_num <= 0 ) then return FALSE
	if( environ("FB_VSCODE_TRACE") <> "1" ) then return FALSE
	if( lex.ctx = NULL ) then return FALSE
	'' Evaluation buffers are synthesized callback input, with no character
	'' origins. The enclosing callback retains its invocation provenance.
	if( lex.ctx->kind = LEX_TKCTX_CONTEXT_EVAL ) then return FALSE
	return (lex.ctx->editor_probe = FALSE) and (editor_map_failed = FALSE)
end function

private function editorNewMap( byref node as FBEDITORMAPNODE ) as integer
	if( editorMapEnabled() = FALSE ) then return 0
	if( node.length <= 0 ) then return 0
	'' FNV-1a over integer fields. Unsigned arithmetic gives defined wrapping;
	'' equality below, rather than the hash, determines map identity.
	dim code as uinteger = 14695981039346656037ull
	code = (code xor node.kind) * 1099511628211ull
	code = (code xor node.length) * 1099511628211ull
	code = (code xor node.first) * 1099511628211ull
	code = (code xor node.second) * 1099511628211ull
	code = (code xor node.offset) * 1099511628211ull
	code = (code xor node.file_index) * 1099511628211ull
	code = (code xor node.byte_start) * 1099511628211ull
	code = (code xor node.byte_end) * 1099511628211ull
	code = (code xor node.target) * 1099511628211ull
	code = (code xor node.parameter_index) * 1099511628211ull
	dim slot as integer = code and EDITOR_MAP_HASH_MASK
	while( editor_map_hash(slot) )
		dim previous as integer = editor_map_hash(slot)
		with editor_maps(previous)
			if( (.kind = node.kind) and (.length = node.length) and (.first = node.first) and _
				(.second = node.second) and (.offset = node.offset) and (.file_index = node.file_index) and _
				(.byte_start = node.byte_start) and (.byte_end = node.byte_end) and _
				(.target = node.target) and (.parameter_index = node.parameter_index) ) then return previous
		end with
		slot = (slot + 1) and EDITOR_MAP_HASH_MASK
	wend
	'' Keep native map memory bounded independently of the emitted trace limit.
	'' Persistent AVL updates allocate short-lived intermediate nodes too. The
	'' million-node arena is at most about 100 MiB on the native 64-bit build;
	'' the decoder separately bounds reachable, emitted maps to 200,000.
	if( (editor_map_count >= 1000000) or (node.length > 32 * 1024 * 1024) ) then
		editor_map_failed = TRUE
		print #env.ppfile_num, "''@fb-editor-map-overflow"
		return 0
	end if
	if( editor_map_count + 1 >= editor_map_capacity ) then
		if( editor_map_capacity = 0 ) then
			editor_map_capacity = 256
		else
			editor_map_capacity *= 2
		end if
		redim preserve editor_maps(0 to editor_map_capacity - 1)
	end if
	editor_map_count += 1
	editor_maps(editor_map_count) = node
	editor_map_hash(slot) = editor_map_count
	return editor_map_count
end function

function editorFileIdentity( byref filename as const string ) as integer
	if( len(filename) = 0 ) then return 0
	for index as integer = 1 to editor_map_file_count
		if( editor_map_files(index) = filename ) then return index
	next
	if( editor_map_file_count >= 5000 ) then
		if( editor_map_failed = FALSE ) then print #env.ppfile_num, "''@fb-editor-map-overflow"
		editor_map_failed = TRUE
		return 0
	end if
	editor_map_file_count += 1
	redim preserve editor_map_files(0 to editor_map_file_count)
	editor_map_files(editor_map_file_count) = filename
	return editor_map_file_count
end function

function editorFileName( byval identity as integer ) as string
	if( (identity <= 0) or (identity > editor_map_file_count) ) then return ""
	return editor_map_files(identity)
end function

function editorMapLength( byval identity as integer ) as integer
	if( identity = 0 ) then return 0
	if( identity < 0 ) then
		if( identity < -editor_builder_count ) then return 0
		return editor_map_builders(-identity).length
	end if
	if( identity > editor_map_count ) then return 0
	return editor_maps(identity).length
end function

function editorSealMap( byval identity as integer ) as integer
	if( identity >= 0 ) then
		if( identity > editor_map_count ) then return 0
		return identity
	end if
	if( identity < -editor_builder_count ) then return 0
	dim index as integer = -identity
	if( editor_map_builders(index).result ) then return editor_map_builders(index).result
	dim result as integer
	for slot as integer = 31 to 0 step -1
		result = editorJoinMap(result, editor_map_builders(index).chunks(slot))
	next
	editor_map_builders(index).result = result
	return result
end function

private function editorNewMapBuilder() as integer
	if( editor_builder_count >= 200000 ) then
		editor_map_failed = TRUE
		print #env.ppfile_num, "''@fb-editor-map-overflow"
		return 0
	end if
	if( editor_builder_count + 1 >= editor_builder_capacity ) then
		if( editor_builder_capacity = 0 ) then
			editor_builder_capacity = 256
		else
			editor_builder_capacity *= 2
		end if
		redim preserve editor_map_builders(0 to editor_builder_capacity - 1)
	end if
	editor_builder_count += 1
	dim item as FBEDITORMAPBUILDER
	editor_map_builders(editor_builder_count) = item
	return -editor_builder_count
end function

private sub editorBuildMap( byval identity as integer, byval value as integer )
	if( value = 0 ) then exit sub
	dim index as integer = -identity
	if( editorMapLength(value) > 32 * 1024 * 1024 - editor_map_builders(index).length ) then
		editor_map_failed = TRUE
		print #env.ppfile_num, "''@fb-editor-map-overflow"
		exit sub
	end if
	editor_map_builders(index).length += editorMapLength(value)
	'' Binary carrying joins equal-sized groups once. Rebalancing an immutable
	'' prefix after every append would retain O(n log n) intermediate nodes.
	'' Negative handles are private append builders; every published edge is
	'' sealed to a positive immutable map ID. Sealed builders remain valid.
	for slot as integer = 0 to 31
		if( editor_map_builders(index).chunks(slot) = 0 ) then
			editor_map_builders(index).chunks(slot) = value
			exit sub
		end if
		value = editorJoinMap(editor_map_builders(index).chunks(slot), value)
		editor_map_builders(index).chunks(slot) = 0
	next
	'' The arena limit makes 2^32 appended pieces unreachable in valid input.
	editor_map_failed = TRUE
	print #env.ppfile_num, "''@fb-editor-map-overflow"
end sub

function editorUnknownMap( byval length as integer ) as integer
	dim node as FBEDITORMAPNODE
	node.kind = 1
	node.length = length
	node.height = 1
	return editorNewMap(node)
end function

private function editorConcatNode( byval first as integer, byval second as integer ) as integer
	dim node as FBEDITORMAPNODE
	node.kind = 3
	node.first = first
	node.second = second
	node.length = editorMapLength(first) + editorMapLength(second)
	node.height = iif(editor_maps(first).height > editor_maps(second).height, editor_maps(first).height, editor_maps(second).height) + 1
	return editorNewMap(node)
end function

private function editorBalanceMap( byval first as integer, byval second as integer ) as integer
	'' Persistent AVL concatenation bounds lookup depth for long replacement
	'' lists. Capture child IDs before allocating: REDIM can move the pool.
	if( editor_maps(first).height > editor_maps(second).height + 1 ) then
		dim a as integer = editor_maps(first).first
		dim b as integer = editor_maps(first).second
		if( editor_maps(a).height >= editor_maps(b).height ) then
			return editorConcatNode(a, editorConcatNode(b, second))
		end if
		dim c as integer = editor_maps(b).first
		dim d as integer = editor_maps(b).second
		return editorConcatNode(editorConcatNode(a, c), editorConcatNode(d, second))
	end if
	if( editor_maps(second).height > editor_maps(first).height + 1 ) then
		dim a as integer = editor_maps(second).first
		dim b as integer = editor_maps(second).second
		if( editor_maps(b).height >= editor_maps(a).height ) then
			return editorConcatNode(editorConcatNode(first, a), b)
		end if
		dim c as integer = editor_maps(a).first
		dim d as integer = editor_maps(a).second
		return editorConcatNode(editorConcatNode(first, c), editorConcatNode(d, b))
	end if
	return editorConcatNode(first, second)
end function

function editorJoinMap( byval first as integer, byval second as integer ) as integer
	first = editorSealMap(first)
	second = editorSealMap(second)
	if( first = 0 ) then return second
	if( second = 0 ) then return first
	if( editorMapEnabled() = FALSE ) then return 0
	if( editor_maps(first).height > editor_maps(second).height + 1 ) then
		dim a as integer = editor_maps(first).first
		dim b as integer = editor_maps(first).second
		return editorBalanceMap(a, editorJoinMap(b, second))
	end if
	if( editor_maps(second).height > editor_maps(first).height + 1 ) then
		dim a as integer = editor_maps(second).first
		dim b as integer = editor_maps(second).second
		return editorBalanceMap(editorJoinMap(first, a), b)
	end if
	return editorConcatNode(first, second)
end function

function editorSliceMap( byval identity as integer, byval first as integer, byval length as integer ) as integer
	identity = editorSealMap(identity)
	if( length <= 0 ) then return 0
	if( (first < 0) or (first + length > editorMapLength(identity)) ) then return editorUnknownMap(length)
	if( (first = 0) and (length = editorMapLength(identity)) ) then return identity
	if( editor_maps(identity).kind = 4 ) then
		first += editor_maps(identity).offset
		identity = editor_maps(identity).first
	end if
	'' Trim concatenations before exporting a token. A slice of the active
	'' replacement buffer must not retain every already-consumed replacement
	'' and every pending token in that buffer as unrelated provenance.
	if( editor_maps(identity).kind = 3 ) then
		dim a as integer = editor_maps(identity).first
		dim b as integer = editor_maps(identity).second
		dim boundary as integer = editorMapLength(a)
		if( first >= boundary ) then return editorSliceMap(b, first - boundary, length)
		if( first + length <= boundary ) then return editorSliceMap(a, first, length)
		return editorJoinMap(editorSliceMap(a, first, boundary - first), editorSliceMap(b, 0, first + length - boundary))
	end if
	if( (editor_maps(identity).kind = 5) or (editor_maps(identity).kind = 6) ) then
		dim input_id as integer = editor_maps(identity).first
		if( input_id andalso (editorMapLength(input_id) = editorMapLength(identity)) ) then
			dim copy_node as FBEDITORMAPNODE = editor_maps(identity)
			copy_node.first = editorSliceMap(input_id, first, length)
			copy_node.length = length
			copy_node.emitted = FALSE
			return editorNewMap(copy_node)
		end if
	end if
	dim node as FBEDITORMAPNODE
	node.kind = 4
	node.first = identity
	node.offset = first
	node.length = length
	node.height = 1
	return editorNewMap(node)
end function

function editorTokenMap( byval token_pointer as any ptr ) as integer
	if( editorMapEnabled() = FALSE ) then return 0
	dim token as FBTOKEN ptr = token_pointer
	if( token->editor_cached_map ) then return token->editor_cached_map
	if( (token->editor_map_root <> 0) and (token->editor_map_root = token->editor_map_end_root) ) then
		token->editor_cached_map = editorSliceMap(token->editor_map_root, token->editor_map_start, token->editor_map_end - token->editor_map_start)
		return token->editor_cached_map
	end if
	if( token->editor_physical_direct = FALSE ) then return 0
	dim node as FBEDITORMAPNODE
	node.kind = 2
	dim physical_file as string = token->editor_physical_file
	if( editorIsSourceDependency(physical_file) = FALSE ) then physical_file = editorCurrentPhysicalSource()
	node.file_index = editorFileIdentity(physical_file)
	node.byte_start = token->editor_physical_start
	node.byte_end = token->editor_physical_end
	node.start_line = token->editor_physical_start_line
	node.start_column = token->editor_physical_start_column
	node.end_line = token->editor_physical_end_line
	node.end_column = token->editor_physical_end_column
	node.length = token->editor_character_end - token->editor_character_start
	node.height = 1
	token->editor_cached_map = editorNewMap(node)
	return token->editor_cached_map
end function

private type FBEDITORMAPCOLLECTOR
	physical as LEX_LOCATION
	last_byte as integer
	has_range as integer
	failed as integer
	visits as integer
end type

private sub editorCollectArgumentRange _
	( _
		byval identity as integer, _
		byval first as integer, _
		byval length as integer, _
		byref collector as FBEDITORMAPCOLLECTOR, _
		byval depth as integer _
	)

	if( collector.failed ) then exit sub
	collector.visits += 1
	'' Macro depth is compiler-bounded; these tighter limits protect the editor
	'' trace path from corrupt or unexpectedly shared provenance graphs.
	if( (depth > 512) or (collector.visits > 8192) or _
		(identity <= 0) or (identity > editor_map_count) or (length <= 0) ) then
		collector.failed = TRUE
		exit sub
	end if

	dim node as FBEDITORMAPNODE = editor_maps(identity)
	if( (first < 0) or (first + length > node.length) ) then
		collector.failed = TRUE
		exit sub
	end if

	select case node.kind
	case 2
		'' Only a complete source token is affine in the editor coordinates.
		'' Partial UTF-8 character slices are deliberately not made editable.
		if( (first <> 0) or (length <> node.length) or _
			(node.file_index <= 0) or (node.file_index > editor_map_file_count) or _
			(node.byte_end <= node.byte_start) or (node.start_line <= 0) or _
			(node.end_line < node.start_line) or (node.end_column < 0) or _
			((node.end_line = node.start_line) and (node.end_column <= node.start_column)) ) then
			collector.failed = TRUE
			exit sub
		end if
		if( collector.has_range = FALSE ) then
			collector.physical.source_file = editor_map_files(node.file_index)
			collector.physical.start_line = node.start_line
			collector.physical.start_column = node.start_column
			collector.physical.end_line = node.end_line
			collector.physical.end_column = node.end_column
			collector.last_byte = node.byte_end
			collector.has_range = TRUE
		else
			if( (collector.physical.source_file <> editor_map_files(node.file_index)) or _
				(node.byte_start <> collector.last_byte) or _
				(node.start_line < collector.physical.end_line) or _
				((node.start_line = collector.physical.end_line) and _
				 (node.start_column < collector.physical.end_column)) ) then
				collector.failed = TRUE
				exit sub
			end if
			collector.physical.end_line = node.end_line
			collector.physical.end_column = node.end_column
			collector.last_byte = node.byte_end
		end if
	case 3
		'' Concats are accepted only when every leaf remains a physically ordered
		'' part of the same source expression. Stringification/callback maps never
		'' reach this branch as source leaves.
		dim left_id as integer = node.first
		dim right_id as integer = node.second
		if( (left_id <= 0) or (right_id <= 0) ) then
			collector.failed = TRUE
			exit sub
		end if
		dim split as integer = editorMapLength(left_id)
		if( first < split ) then
			dim left_length as integer = iif(first + length <= split, length, split - first)
			editorCollectArgumentRange(left_id, first, left_length, collector, depth + 1)
		end if
		if( (first + length > split) and (collector.failed = FALSE) ) then
			dim right_first as integer = iif(first > split, first - split, 0)
			dim right_length as integer = first + length - split - right_first
			editorCollectArgumentRange(right_id, right_first, right_length, collector, depth + 1)
		end if
	case 4
		editorCollectArgumentRange(node.first, node.offset + first, length, collector, depth + 1)
	case 5
		'' Only copied actual parameters preserve the exact user-written token.
		'' Definition text, stringification, and callback output fail closed.
		if( (node.first <= 0) or (editorMapLength(node.first) <> node.length) ) then
			collector.failed = TRUE
			exit sub
		end if
		editorCollectArgumentRange(node.first, first, length, collector, depth + 1)
	case else
		collector.failed = TRUE
	end select
end sub

function editorMapArgumentRange( byval identity as integer ) as LEX_LOCATION
	dim result as LEX_LOCATION
	if( editorMapEnabled() = FALSE ) then return result
	identity = editorSealMap(identity)
	if( (identity <= 0) or (identity > editor_map_count) ) then return result
	dim collector as FBEDITORMAPCOLLECTOR
	editorCollectArgumentRange(identity, 0, editorMapLength(identity), collector, 0)
	if( collector.failed or collector.has_range = FALSE ) then return result
	if( collector.physical.end_line < collector.physical.start_line or _
		((collector.physical.end_line = collector.physical.start_line) and _
		 (collector.physical.end_column <= collector.physical.start_column)) ) then return result
	collector.physical.is_physical = TRUE
	return collector.physical
end function

function editorWrapMap( byval kind as integer, byval identity as integer, byval length as integer, byval parameter_index as integer ) as integer
	dim node as FBEDITORMAPNODE
	node.kind = kind
	node.length = length
	node.height = 1
	node.first = editorSealMap(identity)
	node.second = editor_macro_frame.site
	node.target = editor_macro_frame.target
	node.parameter_index = parameter_index
	return editorNewMap(node)
end function

sub editorAppendMap( byref identity as integer, byval value as integer, byval length as integer )
	if( editorMapEnabled() = FALSE ) then exit sub
	if( length <= 0 ) then exit sub
	if( editorMapLength(value) <> length ) then value = editorUnknownMap(length)
	value = editorSealMap(value)
	if( identity < 0 ) then
		if( editor_map_builders(-identity).result ) then identity = editor_map_builders(-identity).result
	end if
	if( identity >= 0 ) then
		dim previous as integer = identity
		identity = editorNewMapBuilder()
		if( identity = 0 ) then exit sub
		editorBuildMap(identity, previous)
	end if
	editorBuildMap(identity, value)
end sub

sub editorPrependMap( byval identity as integer, byval length as integer )
	if( editorMapEnabled() = FALSE ) then exit sub
	identity = editorSealMap(identity)
	if( editorMapLength(identity) <> length ) then identity = editorUnknownMap(length)
	dim remaining as integer = editorSliceMap(lex.ctx->editor_macro_map, lex.ctx->editor_macro_position, lex.ctx->deflen)
	lex.ctx->editor_macro_map = editorJoinMap(identity, remaining)
	lex.ctx->editor_macro_position = 0
end sub

function editorEnterMacro( byval site as integer, byval sym as FBSYMBOL ptr ) as FBEDITORMACROFRAME
	dim previous as FBEDITORMACROFRAME = editor_macro_frame
	if( editorMapEnabled() ) then
		editor_macro_frame.site = site
		'' DEFINE metadata is immutable after creation. Unlike forward types,
		'' expanding the same macro again cannot update its native symbol shape.
		if( sym->editor_exported = FALSE ) then editorExportSymbol(sym)
		editor_macro_frame.target = editorSymbolId(sym)
	end if
	return previous
end function

sub editorLeaveMacro( byref previous as FBEDITORMACROFRAME )
	editor_macro_frame = previous
end sub

sub editorExportMap( byval identity as integer )
	if( identity = 0 ) then exit sub
	if( editorMapEnabled() = FALSE ) then exit sub
	identity = editorSealMap(identity)
	'' Reachable maps only. Iteration also handles deeply nested expansion and
	'' slice relationships without depending on the native call stack size.
	dim pending() as integer
	dim count as integer = 1, capacity as integer = 32
	redim pending(0 to capacity - 1)
	pending(0) = identity
	while( count > 0 )
		count -= 1
		identity = pending(count)
		if( identity = 0 ) then continue while
		if( editor_maps(identity).emitted ) then continue while
		editor_maps(identity).emitted = TRUE
		dim node as FBEDITORMAPNODE = editor_maps(identity)
		print #env.ppfile_num, "''@fb-editor-map " & identity & " " & node.kind & " " & node.length & " " & _
			node.first & " " & node.second & " " & node.offset & " " & node.byte_start & " " & node.byte_end & " " & _
			node.target & " " & node.parameter_index & " " & node.file_index
		if( count + 2 > capacity ) then
			capacity *= 2
			redim preserve pending(0 to capacity - 1)
		end if
		pending(count) = node.first
		pending(count + 1) = node.second
		count += 2
	wend
end sub

'' end of editor-macro-maps.bi
