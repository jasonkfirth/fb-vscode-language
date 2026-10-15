'' Project: FreeBASIC language extension tests
'' File: compiler-overloaded-operator-bridge.bas
'' Purpose: Exercise compiler-selected overloaded operator receipts.
'' Responsibilities: distinguish binary overloads and resolve word, compound assignment, CAST, and ABS operators.
'' Does not contain: source-side overload scoring or runtime output checks.
''

Type BridgeOperatorValue
    value As Long
End Type

Operator +(ByRef first As BridgeOperatorValue, ByVal second As Long) As BridgeOperatorValue
    Dim result As BridgeOperatorValue
    Return result
End Operator

Operator +(ByRef first As BridgeOperatorValue, ByVal second As Double) As BridgeOperatorValue
    Dim result As BridgeOperatorValue
    Return result
End Operator

Operator And(ByRef first As BridgeOperatorValue, ByRef second As BridgeOperatorValue) As BridgeOperatorValue
    Dim result As BridgeOperatorValue
    Return result
End Operator

Type BridgeEqualityValue
    value As Long
End Type

Operator =(ByRef first As BridgeEqualityValue, ByRef second As BridgeEqualityValue) As Integer
    Return first.value = second.value
End Operator

Type BridgeAssignableValue
    value As Long
    Declare Operator Let(ByRef source As BridgeAssignableValue)
End Type

Operator BridgeAssignableValue.Let(ByRef source As BridgeAssignableValue)
    This.value = source.value
End Operator

Type BridgeAssignmentHolder
    value As BridgeAssignableValue
End Type

Type BridgeCompoundValue
    value As Long
    Declare Operator +=(ByVal amount As Long)
End Type

Operator BridgeCompoundValue.+=(ByVal amount As Long)
    This.value += amount
End Operator

Type BridgeModuloValue
    value As Long
    Declare Operator Mod=(ByVal divisor As Long)
End Type

Operator BridgeModuloValue.Mod=(ByVal divisor As Long)
    This.value = This.value Mod divisor
End Operator

Type BridgeCastValue
    value As Long
    Declare Operator Cast() As Long
End Type

Operator BridgeCastValue.Cast() As Long
    Return value
End Operator

Type BridgeAbsValue
    value As Long
End Type

Declare Operator Abs(ByRef value As BridgeAbsValue) As Long
Operator Abs(ByRef value As BridgeAbsValue) As Long
    Return value.value
End Operator

Type BridgeLengthValue
    value As Long
End Type

Declare Operator Len(ByRef value As BridgeLengthValue) As Long
Operator Len(ByRef value As BridgeLengthValue) As Long
    Return value.value
End Operator

Dim bridgeValue As BridgeOperatorValue
Dim leftEquality As BridgeEqualityValue
Dim rightEquality As BridgeEqualityValue
Dim leftAssignable As BridgeAssignableValue
Dim rightAssignable As BridgeAssignableValue
Dim assignmentHolder As BridgeAssignmentHolder
Dim assignableValues(0 To 1) As BridgeAssignableValue
Dim compoundValue As BridgeCompoundValue
Dim compoundModulo As BridgeModuloValue
Dim bridgeCast As BridgeCastValue
Dim bridgeAbs As BridgeAbsValue
Dim bridgeLength As BridgeLengthValue
leftAssignable = rightAssignable
leftAssignable => rightAssignable
assignmentHolder.value = rightAssignable
assignableValues(0) = rightAssignable
compoundValue += 1
compoundValue +=> 2
compoundModulo Mod= 2
compoundModulo Mod=> 3
If leftEquality = rightEquality Then Print 1
Print (bridgeValue + CLng(1)).value
Print (bridgeValue + CDbl(1)).value
Print (bridgeValue And bridgeValue).value
Print CLng(bridgeCast)
Print Abs(bridgeAbs)
Print Len(bridgeLength)

'' end of compiler-overloaded-operator-bridge.bas
