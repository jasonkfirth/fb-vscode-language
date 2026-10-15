''
'' Project: FreeBASIC language extension tests
'' File: compiler-quirk-expressions.bas
'' Purpose: Exercise expression forms dispatched through compiler quirk parsers.
'' Responsibilities: cover representative string, math, array, file, console,
''                   SFX, error, serialization, conditional, casting, pointer,
''                   and vararg forms.
'' Does not contain: runtime assertions or a JavaScript type oracle.
''

#include once "fbserialize.bi"

Dim encoded As String = "x"
Dim number As Long = 1
Dim values(0 To 2) As Integer

Sub ReadVarArg Cdecl(ByVal fixed As Integer, ...)
    Dim arguments As cva_list = Any
    cva_start(arguments, fixed)
    Print cva_arg(arguments, Integer)
    cva_end(arguments)
End Sub

Print CVL(encoded)
Print CVD(number)
Print CVS(number)
Print CVI(number)
Print CVL(number)
Print CVLONGINT(number)
Print CVSHORT(encoded)
Print CVD(encoded)
Print CVS(encoded)
Print CVI(encoded)
Print CVI<16>(encoded)
Print CVI<32>(encoded)
Print CVI<64>(encoded)
Print CVLONGINT(encoded)
Print MKL(number)
Print MKD(number)
Print MKS(number)
Print MKI(number)
Print MKI<16>(number)
Print MKI<32>(number)
Print MKI<64>(number)
Print MKSHORT(number)
Print MKLONGINT(number)
Print Str(number)
Print Sqr(number)
Print LBound(values)
Print Seek(1)
Print Err
Print Color()
Print View Print()
Print Width()
Print Screen(0, 0)
Print Point(0, 0)
Print ImageCreate(1, 1)
Print Music Status()
Print Capture Available()
Print Device Select(0)
Print IIf(number > 0, number, 0)
Print Asc(encoded)
Print Asc(encoded, 1)
Print Chr(number)
Print WChr(number)
Print String(2, number)
Print String(2, "x")
Print CByte(number)
Print Peek(UByte, 0)
Print Serialize(number)
Print Mid(encoded, 1, 1)
Print Mid(encoded, 1)
Print Instr(encoded, "x")
Print Instr(1, encoded, "x")
Print Instr(1, encoded, Any "x")
Print InStrRev(encoded, "x")
Print InStrRev(encoded, Any "x", 1)
Print Trim(encoded)
Print Trim(encoded, Any "x")
Print LTrim(encoded)
Print LTrim(encoded, Any "x")
Print RTrim(encoded)
Print RTrim(encoded, Any "x")
Print LCase(encoded)
Print LCase(encoded, 1)
Print UCase(encoded)
Print UCase(encoded, 1)
Print WStr(encoded)
Print WStr(number)
Print WString(2, number)
Print Atan2(number, number)
Print UBound(values)
Print Timer
Print Inkey

'' end of compiler-quirk-expressions.bas
