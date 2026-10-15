'' Project: FreeBASIC language extension tests
'' File: compiler-implicit-quirk-matrix.bas
'' Purpose: Verify compiler-selected quirk results across dialects and targets.
'' Responsibilities: exercise conversion, runtime, console, graphics, and string routes.
'' Does not contain: runtime assertions or types inferred outside compiler output.

#Include Once "fbgfx.bi"

Dim encoded As String
Dim number As Long
Dim values(0 To 2) As Integer
encoded = "x"
number = 1

Print CVL(encoded)
Print CVI(encoded)
Print CVSHORT(encoded)
Print Str$(number)
Print Sqr(number)
Print LBound(values)
Print Seek(1)
Print Err
Print Color()
Print View Print()
Print Width()
Print ImageCreate(1, 1)
Print IIf(number > 0, number, 0)
Print Mid$(encoded, 1)
Print InStr(encoded, "x")
Print Timer
Print Inkey$

'' end of compiler-implicit-quirk-matrix.bas
