' Project: FreeBASIC VS Code Language Extension Tests
' File: procedure-pointer-signatures.bas
' Purpose: Exercise native signatures of callable values rather than call targets.
' Responsibilities: Cover aliases, inferred values, factories, parameters, fields, arrays, and addresses.
' Does not contain: Editor commands or calls that execute outside the test compiler.

Function Compute(ByVal value As Long, ByVal scale As Double) As Double
    Return value * scale
End Function

Type CallbackType As Function(ByVal value As Long, ByVal scale As Double) As Double
Namespace CallbackScope
    Function ComputeScoped(ByVal value As Long, ByVal scale As Double) As Double
        Return value * scale
    End Function
End Namespace
Dim scopedCallback As CallbackType = @CallbackScope.ComputeScoped
Dim globalCallback As CallbackType = @.CallbackScope.ComputeScoped
Dim directGlobalCallback As CallbackType = @.Compute

Type Handlers
    invoke As CallbackType
End Type

Function GetCallback(ByVal seed As Long) As CallbackType
    Return @Compute
End Function

Dim callback As CallbackType = @Compute
Var inferred = @Compute
Var produced = GetCallback(1)
Dim callbackPointer As CallbackType Ptr = @callback
Dim handlersValue As Handlers
handlersValue.invoke = @Compute
With handlersValue
    Dim withGlobalCallback As CallbackType = @..CallbackScope.ComputeScoped
End With

Sub Exercise(ByVal injected As CallbackType)
    Print injected(1, 2)
End Sub

Sub ExerciseArray(callbackValues() As CallbackType)
    Print callbackValues(0)(1, 2)
End Sub

Print callback(1, 2)
Print inferred(1, 2)
Print produced(1, 2)
Print GetCallback(1)(1, 2)
Print (*callbackPointer)(1, 2)
Print (callback)(1, 2)
Print handlersValue.invoke(1, 2)

Dim callbackArray(0 To 1) As CallbackType
callbackArray(0) = @Compute
Print callbackArray(0)(1, 2)

Sub SetValue(ByRef value As Long)
    value = 42
End Sub
Dim action As Sub(ByRef value As Long) = @SetValue
Dim resultValue As Long
action(resultValue)

' end of procedure-pointer-signatures.bas
