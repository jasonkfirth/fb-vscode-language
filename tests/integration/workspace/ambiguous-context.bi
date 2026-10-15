'' Project: FreeBASIC VS Code Language Extension Tests
'' File: ambiguous-context.bi
'' Purpose: Give one physical expression different compiler types per include.
'' Responsibilities: preserve the same expression range in both namespaces.
'' This file intentionally does NOT contain: an include-once guard.
#if defined(AMBIGUOUS_INTEGER_CONTEXT)
Namespace IntegerContext
Dim As Integer context_value
#else
Namespace StringContext
Dim As String context_value
#endif
Sub ShowContextValue()
Print context_value
End Sub
End Namespace
'' end of ambiguous-context.bi
