'' Project: FreeBASIC VS Code Language Extension tests
'' File: qualified-temporary-constructor-calls.bas
'' Purpose: Exercise constructor calls through namespaces and type aliases.
'' Responsibilities: separate overloads and keep namespace tokens independent.
'' Does not contain: implicit storage construction or nontrivial cleanup.

Namespace ConstructionScope
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
End Namespace

Type TemporaryAlias As ConstructionScope.TemporaryValue

Sub ConsumeTemporary(ByRef item As TemporaryAlias)
End Sub

Sub MakeTemporary()
    ConsumeTemporary(TemporaryAlias(CLng(1)))
End Sub

MakeTemporary()
ConsumeTemporary(ConstructionScope.TemporaryValue(CDbl(2)))

'' end of qualified-temporary-constructor-calls.bas
