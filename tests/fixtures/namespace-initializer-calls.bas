'' Project: FreeBASIC VS Code Language Extension tests
'' File: namespace-initializer-calls.bas
'' Purpose: Exercise runtime initialization of namespace-owned shared values.
'' Responsibilities: distinguish module initialization from procedure calls.
'' Does not contain: executable statements directly inside a namespace.

Dim Shared initializationCount As Long

Function RecordInitialization(ByVal initialValue As Long) As Long
    initializationCount += 1
    Return initialValue
End Function

Type TrackedValue
    value As Long
    Declare Constructor(ByVal initialValue As Long)
End Type

Constructor TrackedValue(ByVal initialValue As Long)
    This.value = RecordInitialization(initialValue)
End Constructor

Sub ModuleAction()
End Sub

Namespace InitializerScope
    Dim Shared firstValue As TrackedValue = TrackedValue(11)
    Namespace Nested
        Dim Shared secondValue As TrackedValue = TrackedValue(22)
        Sub BuildLocal()
            Dim localValue As TrackedValue = TrackedValue(44)
        End Sub
    End Namespace
End Namespace

Dim Shared rootValue As TrackedValue = TrackedValue(33)
ModuleAction()

If initializationCount <> 3 Then End 1
If InitializerScope.firstValue.value <> 11 Then End 2
If InitializerScope.Nested.secondValue.value <> 22 Then End 3
If rootValue.value <> 33 Then End 4

'' end of namespace-initializer-calls.bas
