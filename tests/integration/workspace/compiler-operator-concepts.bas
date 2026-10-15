'' Project: FreeBASIC language extension tests
'' File: compiler-operator-concepts.bas
'' Purpose: Verify stable semantic operator concepts across language modes.
'' Responsibilities: exercise built-in operators including parser-lowered forms.
'' Does not contain: user-defined operators or mode-specific language extensions.

Dim modeValue As Integer
Dim modeText As String
modeValue = 3

Print modeValue + 2
Print modeValue - 2
Print modeValue * 2
Print modeValue / 2
Print modeValue \ 2
Print modeValue Mod 2
Print modeValue ^ 2
Print modeValue And 2
Print modeValue Or 2
Print modeValue AndAlso modeValue
Print modeValue OrElse modeValue
Print modeValue AndAlso modeValue OrElse modeValue
Print modeValue Xor 2
Print modeValue Eqv 2
Print modeValue Imp 2
Print modeText & "x"
Print modeValue = 2
Print modeValue > 0
Print modeValue < 2
Print modeValue <> 2
Print modeValue >= 2
Print modeValue <= 2
Print Not modeValue
Print +modeValue
Print -modeValue
Print Not (modeValue > 0)
Print CInt(modeValue + 0.5)
Print CSng(modeValue)

Dim modeArray(0 To 1) As Integer
Print modeArray(0)

'' end of compiler-operator-concepts.bas
