''
'' Project: FreeBASIC language extension tests
'' File: compiler-expression-declarations.bas
'' Purpose: Check compiler-selected construction at variable declarations.
'' Responsibilities: cover default construction for scalars, fixed arrays, and dynamic arrays.
'' Does not contain: expression parsing or editor type inference.
''

Type ConstructedValue
	value As Long
	Declare Constructor()
End Type

Constructor ConstructedValue()
	value = 1
End Constructor

Sub ExerciseDefaultConstruction()
	Dim scalar As ConstructedValue
	Dim items(0 To 1) As ConstructedValue
	Dim deferred() As ConstructedValue
End Sub

'' end of compiler-expression-declarations.bas
