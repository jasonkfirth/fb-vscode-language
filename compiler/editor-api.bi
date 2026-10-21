''
'' Project: FreeBASIC editor bridge
'' File: editor-api.bi
'' Purpose: Share committed parser locations with the trace writer.
'' Responsibilities: define expanded-token coordinates and procedure exports.
'' Does not contain: editor policy, speculative lookup, or AST traversal.
''

'' Coordinates address nonempty preprocessed lines, not physical source lines.
'' Columns are zero-based bytes in the compiler's emitted text. Keeping the
'' last consumed token in a value lets nested calls retain independent sites.
type FBEDITORLOCATION
	output_line as integer
	byte_column as integer
	byte_end as integer
	spelling as zstring * FB_MAXNAMELEN+1
end type

type FBEDITORMACROFRAME
	site as integer
	target as integer
end type

'' Parser-scoped guard: local destruction records each unevaluated interval
'' on every return path without relying on source-text matching.
type FBEDITORQUERYSCOPE
	active as integer
	first as FBEDITORLOCATION
	declare constructor()
	declare sub enter(byval token as integer)
	declare destructor()
end type

declare function editorMapLength( byval identity as integer ) as integer
declare function editorFileIdentity( byref filename as const string ) as integer
declare function editorFileName( byval identity as integer ) as string
declare function editorCurrentPhysicalSource() as string
declare function editorIsSourceDependency( byref filename as const string ) as integer
declare sub editorRememberSourcePath( byref filename as const string )
declare sub editorReset()
declare function editorUnknownMap( byval length as integer ) as integer
declare function editorJoinMap( byval first as integer, byval second as integer ) as integer
declare function editorSliceMap( byval identity as integer, byval first as integer, byval length as integer ) as integer
declare function editorTokenMap( byval token_pointer as any ptr ) as integer
declare function editorPhysicalRangeFromTokens _
	( _
		byval start_serial as integer, _
		byval start_byte as integer, _
		byval end_serial as integer, _
		byval end_byte as integer _
	) as FBEDITORPHYSICALRANGE
declare sub editorResetOriginTokens()
declare function editorWrapMap( byval kind as integer, byval identity as integer, byval length as integer, byval parameter_index as integer = 0 ) as integer
declare sub editorAppendMap( byref identity as integer, byval value as integer, byval length as integer )
declare sub editorPrependMap( byval identity as integer, byval length as integer )
declare function editorEnterMacro( byval site as integer, byval sym as FBSYMBOL ptr ) as FBEDITORMACROFRAME
declare sub editorLeaveMacro( byref previous as FBEDITORMACROFRAME )
declare sub editorExportMap( byval identity as integer )
declare function editorMacroEpoch() as integer
declare sub editorMacroReference( byval sym as FBSYMBOL ptr, byval site as integer, byref role as const string, byval spelling as const zstring ptr )
declare sub editorMacroDeclaration( byval sym as FBSYMBOL ptr, byval site as integer, byval paramhead as FB_DEFPARAM ptr, byval tokhead as FB_DEFTOK ptr )

declare function editorLastToken() as FBEDITORLOCATION
declare function editorNextToken() as FBEDITORLOCATION
declare sub editorEmitType( byref site as FBEDITORLOCATION, byval dtype as integer, byval subtype as FBSYMBOL ptr )
declare sub editorEmitReceiver( byval dtype as integer, byval subtype as FBSYMBOL ptr )
declare sub editorEmitProcedure( byref site as FBEDITORLOCATION, byval proc as FBSYMBOL ptr, byval is_declaration as integer )
declare sub editorInvalidateRegion( byref site as FBEDITORLOCATION, byval errors_before as integer )
declare sub editorEmitError( byval error_code as integer, byval source_line as integer )
declare sub editorReachedEnd()
declare sub editorFinish()
declare function editorSymbolId( byval sym as FBSYMBOL ptr ) as integer
declare function editorTypeName( byval dtype as integer, byval subtype as FBSYMBOL ptr ) as string
declare sub editorExportSymbol( byval sym as FBSYMBOL ptr )
declare sub editorEmitSymbol( byref site as FBEDITORLOCATION, byval sym as FBSYMBOL ptr, byval is_declaration as integer )
declare sub editorReference( byval sym as FBSYMBOL ptr )
declare sub editorAliasSymbol( byval source as FBSYMBOL ptr, byval canonical as FBSYMBOL ptr )
declare function editorExchangePrefix( byref site as FBEDITORLOCATION ) as FBEDITORLOCATION
declare function editorExpressionPrefix() as FBEDITORLOCATION
declare function editorExchangeExpressionFamily( byref family as const string ) as string
declare sub editorTagExpressionFamily( byval expr as ASTNODE ptr )
declare function editorAstSource( byval expr as ASTNODE ptr ) as FBEDITORAST
declare function editorAstStart( byval expr as ASTNODE ptr ) as FBEDITORLOCATION
declare sub editorSetAstStart( byval expr as ASTNODE ptr, byref site as FBEDITORLOCATION )
declare sub editorEmitExpression( byref site as FBEDITORLOCATION, byval expr as ASTNODE ptr, byval result_dtype as integer = 0, byval result_subtype as FBSYMBOL ptr = NULL, byval override_result_type as integer = FALSE )
declare function editorEmitLeaf( byref site as FBEDITORLOCATION, byval dtype as integer, byval subtype as FBSYMBOL ptr, byval receiver as integer ) as FBEDITORAST
declare sub editorEmitTransform( byref kind as const string, byval expr as ASTNODE ptr, byref first as FBEDITORAST, byref second as FBEDITORAST, byref third as FBEDITORAST, byval target as FBSYMBOL ptr, byval options as integer )
declare sub editorEmitIndex( byval expr as ASTNODE ptr, byref receiver as FBEDITORAST, byref indexexpr as FBEDITORAST )
declare sub editorEmitCall( byref site as FBEDITORLOCATION, byval expr as ASTNODE ptr, byval target as FBSYMBOL ptr, byval callee as integer, byval generated as integer = FALSE, byval result_dtype as integer = 0, byval result_subtype as FBSYMBOL ptr = NULL, byval override_result_type as integer = FALSE )
declare sub editorEmitImplicitDeclarationCall( byref site as FBEDITORLOCATION, byval dtype as integer, byval subtype as FBSYMBOL ptr, byval target as FBSYMBOL ptr )
declare sub editorEmitArgument( byval parent as ASTNODE ptr, byval arg as ASTNODE ptr, byref before as FBEDITORAST )
declare function editorCurrentScope() as integer
declare sub editorOpenScope( byref site as FBEDITORLOCATION, byval sym as FBSYMBOL ptr, byref kind as const string )
declare sub editorCloseScope( byval sym as FBSYMBOL ptr, byval recovered as integer = FALSE )
declare sub editorDeclareSymbol( byref site as FBEDITORLOCATION, byval sym as FBSYMBOL ptr, byval flags as integer )
declare sub editorExportShape( byval sym as FBSYMBOL ptr )
declare sub editorImportNamespace( byval source as FBSYMBOL ptr, byval destination as FBSYMBOL ptr )

'' end of editor-api.bi
