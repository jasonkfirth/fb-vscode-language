''
'' Project: FreeBASIC language extension tests
'' File: compiler-expression-surface.bas
'' Purpose: Exercise source forms that enter the expression parser before atom lookup.
'' Responsibilities: cover address, conversion, allocation, math, and file/runtime forms.
'' Does not contain: runtime assertions or a JavaScript type oracle.
''

Function NumberFunction() As Long
    Return 1
End Function

Dim number As Long = 1
Dim encoded As String = "text"
Dim ptrValue As Long Ptr = VarPtr(number)
Dim fixedName As ZString * (2 + 3)

Print Len(encoded)
Print SizeOf(number)
Print SAdd(encoded)
Print StrPtr(encoded)
Print VarPtr(number)
Print ProcPtr(NumberFunction)
Print Cast(Double, number)
Print CPtr(Long Ptr, ptrValue)
Print CInt<16>(number)
Print CUInt<32>(number)
Print *CPtr(Long Ptr, ptrValue)
Print New Long
Print New Long[2]
Print Abs(number)
Print Int(number)
Print Fix(number)
Print Frac(number)
Print Rnd()
Print Command()
Print Environ("PATH")
Print Dir()
Print Exepath()
Print CurDir()
Print Date()
Print Time()

'' end of compiler-expression-surface.bas
