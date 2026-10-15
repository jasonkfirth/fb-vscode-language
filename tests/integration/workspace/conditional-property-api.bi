''
'' Project: FreeBASIC VS Code language extension tests
'' File: conditional-property-api.bi
'' Purpose: Declare build-dependent property accessors for packaged rename tests.
'' Responsibilities: expose getter and setter signatures in alternate builds.
'' Does not contain: implementations or test-runner logic.
''
Type Meter
    storedValue As Long
#ifdef ALTERNATE
    Declare Property CurrentValue() As Double
    Declare Property CurrentValue(ByVal newValue As Double)
#else
    Declare Property CurrentValue() As Long
    Declare Property CurrentValue(ByVal newValue As Long)
#endif
End Type

'' end of conditional-property-api.bi
