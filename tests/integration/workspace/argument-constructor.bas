''
'' Project: FreeBASIC language extension tests
'' File: argument-constructor.bas
'' Purpose: Exercise implicit argument conversion in a project callsite.
'' Responsibilities: call a shared declaration with overloaded constructors.
'' Does not contain: the shared type declaration or constructor implementation.
''
#include once "argument-constructor-api.bi"

Sub exerciseArgumentConstructors()
	consumeArgument(13)
	consumeArgument( _
		2.5)
End Sub

'' end of argument-constructor.bas
