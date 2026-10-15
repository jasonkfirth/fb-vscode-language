''
'' Project: FreeBASIC VS Code language extension tests
'' File: conditional-property-caller.bas
'' Purpose: Exercise conditional property getter and setter references.
'' Responsibilities: provide shared read/write uses for packaged rename tests.
'' Does not contain: property implementations or test-runner logic.
''
#include once "conditional-property-api.bi"
Dim currentMeter As Meter
Print currentMeter.CurrentValue
currentMeter.CurrentValue = 2

'' end of conditional-property-caller.bas
