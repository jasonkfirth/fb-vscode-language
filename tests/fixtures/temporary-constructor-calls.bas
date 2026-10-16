'' Project: FreeBASIC VS Code Language Extension tests
'' File: temporary-constructor-calls.bas
'' Purpose: Exercise selected constructors of written UDT temporaries.
'' Responsibilities: separate overloads and procedure/module call ownership.
'' Does not contain: implicit storage construction or nontrivial cleanup.

Type TemporaryValue
    number As Long
    Declare Constructor(ByVal initialValue As Long = 0)
    Declare Constructor(ByVal initialValue As Double)
End Type

Constructor TemporaryValue(ByVal initialValue As Long)
    number = initialValue
End Constructor

Constructor TemporaryValue(ByVal initialValue As Double)
    number = CLng(initialValue)
End Constructor

Sub ConsumeTemporary(ByRef item As TemporaryValue)
End Sub

Sub MakeTemporary()
    ConsumeTemporary(TemporaryValue(CLng(1)))
End Sub

MakeTemporary()
ConsumeTemporary(TemporaryValue(CDbl(2)))

'' end of temporary-constructor-calls.bas
