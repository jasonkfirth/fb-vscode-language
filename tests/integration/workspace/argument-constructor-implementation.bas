''
'' Project: FreeBASIC language extension tests
'' File: argument-constructor-implementation.bas
'' Purpose: Implement overloads selected for implicit procedure arguments.
'' Responsibilities: define constructors and the shared procedure body.
'' Does not contain: caller syntax or test-runner assertions.
''
#include once "argument-constructor-api.bi"

Constructor ArgumentTarget(ByVal value As Long)
	This.marker = value
End Constructor

Constructor ArgumentTarget(ByVal value As Double)
	This.marker = CInt(value)
End Constructor

Sub consumeArgument(ByVal item As ArgumentTarget)
End Sub

'' end of argument-constructor-implementation.bas
