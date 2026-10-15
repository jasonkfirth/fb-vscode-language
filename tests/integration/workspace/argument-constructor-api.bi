''
'' Project: FreeBASIC language extension tests
'' File: argument-constructor-api.bi
'' Purpose: Share a UDT parameter with compiler-selected conversions.
'' Responsibilities: declare the argument type and consuming procedure.
'' Does not contain: constructor bodies or project test-runner logic.
''
Type ArgumentTarget
	marker As Long
	Declare Constructor(ByVal value As Long)
	Declare Constructor(ByVal value As Double)
End Type

Declare Sub consumeArgument(ByVal item As ArgumentTarget)

'' end of argument-constructor-api.bi
