'' Project: FreeBASIC language extension tests
'' File: compiler-operator-concepts-extended.bas
'' Purpose: Verify stable concepts for operators, conversions, and math intrinsics.
'' Responsibilities: cover parser operations unavailable in QB syntax and AST lowering.
'' Does not contain: overloaded operators or runtime assertions.

Dim pointerValue As Integer
Dim modePointer As Integer Ptr = @pointerValue
Dim realValue As Double = 3.5
Dim integerValue As Integer = 3

Print pointerValue Shl 1
Print pointerValue Shr 1
Print @pointerValue
Print *modePointer
Print modePointer[0]
Print Abs(realValue)
Print Sgn(realValue)
Print Int(realValue)
Print Fix(realValue)
Print Frac(realValue)
Print Sin(realValue)
Print Atan2(realValue, integerValue)
Print Int(integerValue)
Print Fix(integerValue)
Print Frac(integerValue)
Print CInt(realValue)
Print CSng(integerValue)
Print CBool(integerValue)
Print Cast(Double, realValue)

'' end of compiler-operator-concepts-extended.bas
