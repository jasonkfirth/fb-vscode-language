/'
    Project: FreeBASIC VS Code Language Extension
    File: main.bas
    Purpose: Provide valid source for editor integration tests.
    Responsibilities: Exercise calls, scopes, includes, and member access.
    This file intentionally does NOT contain a runnable test harness.
'/

#include once "types.bi"
Using Geometry

Sub Geometry.Point.SetX(ByVal newValue As Long)
    x = newValue
End Sub

Dim Shared origin As Geometry.Point
origin.x = 10
origin.SetX (20)
Print Sin(0.5)

Sub Work(ByVal item As Geometry.Point)
    Dim x As Long = 5
    item.x = x
End Sub

' end of main.bas
