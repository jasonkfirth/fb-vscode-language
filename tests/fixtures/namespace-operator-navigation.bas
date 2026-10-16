'' Project: FreeBASIC VS Code Language Extension tests
'' File: namespace-operator-navigation.bas
'' Purpose: Exercise operator ownership inside an enclosing namespace.
'' Responsibilities: provide valid prototypes, qualified bodies, and selected uses.
'' Does not contain: project settings, runtime assertions, or namespace-level execution.

Namespace OperatorScope
    Type NamespacedRecord
        value As Long
        Declare Operator Cast() As Long
        Declare Operator [](ByVal index As Long) ByRef As Long
    End Type

    Sub ObserveNamespacedOperator()
    End Sub

    Operator NamespacedRecord.Cast() As Long
        ObserveNamespacedOperator()
        Return value
    End Operator

    Operator NamespacedRecord.[](ByVal index As Long) ByRef As Long
        ObserveNamespacedOperator()
        Return value
    End Operator
End Namespace

Dim instance As OperatorScope.NamespacedRecord
Print CLng(instance)
Print instance[1]

'' end of namespace-operator-navigation.bas
