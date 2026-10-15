''
'' Project: FreeBASIC language extension tests
'' File: compiler-macro-procedure.bas
'' Purpose: Exercise procedure references in continued macro replacement text.
'' Responsibilities: provide one compiler-bound replacement-list occurrence.
'' Does not contain: macro-generated declarations or test-runner assertions.
''
Function SelectedProcedure(ByVal value As Long) As Long
	Return value
End Function

#define CALL_SELECTED(value) _
	SelectedProcedure(value)

Print CALL_SELECTED(1)
Print SelectedProcedure(2)

'' end of compiler-macro-procedure.bas
