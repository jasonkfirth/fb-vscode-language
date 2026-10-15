'' Project: FreeBASIC VS Code Language Extension tests
'' File: compiler-call-hierarchy.bas
'' Purpose: Exercise incoming and outgoing procedure-call hierarchy.
'' Responsibilities: cover direct, macro-argument, and top-level call sites.
'' Does not contain: overload ambiguity or replacement-generated callees.

#define InvokeValue(target, value) target(value)

Function LeafValue(ByVal value As Long) As Long
    Return value
End Function

Function MiddleValue(ByVal value As Long) As Long
    Return LeafValue(value)
End Function

Function RootValue() As Long
    Return MiddleValue(LeafValue(2))
End Function

Function MacroCallerValue(ByVal value As Long) As Long
    Return InvokeValue(LeafValue, value)
End Function

Sub BareTarget()
End Sub

Sub BareCaller()
    BareTarget
End Sub

Function BareFunctionTarget() As Long
    Return 17
End Function

Function BareFunctionCaller() As Long
    Return BareFunctionTarget
End Function

Type BarePropertyOwner
    storedValue As Long
    Declare Property BareValue() As Long
End Type

Property BarePropertyOwner.BareValue() As Long
    Return 23
End Property

Function BarePropertyCaller(ByRef bareOwnerInstance As BarePropertyOwner) As Long
    Return bareOwnerInstance.BareValue
End Function

Print RootValue()

'' end of compiler-call-hierarchy.bas
