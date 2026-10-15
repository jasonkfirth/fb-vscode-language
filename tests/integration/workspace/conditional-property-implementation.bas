''
'' Project: FreeBASIC VS Code language extension tests
'' File: conditional-property-implementation.bas
'' Purpose: Implement the conditional property accessors for packaged rename tests.
'' Responsibilities: provide matching getter and setter bodies in each build.
'' Does not contain: executable application startup or test assertions.
''
#include once "conditional-property-api.bi"
#ifdef ALTERNATE
Property Meter.CurrentValue() As Double
    Return 2.5
End Property
Property Meter.CurrentValue(ByVal newValue As Double)
    storedValue = CLng(newValue)
End Property
#else
Property Meter.CurrentValue() As Long
    Return 2
End Property
Property Meter.CurrentValue(ByVal newValue As Long)
    storedValue = newValue
End Property
#endif

'' end of conditional-property-implementation.bas
