/'
    Project: FreeBASIC VS Code Language Extension
    File: types.bi
    Purpose: Define types for editor integration tests.
    Responsibilities: Exercise namespace, member, and inheritance lookup.
    This file intentionally does NOT contain executable test assertions.
'/

Namespace Geometry
    Type Point
        x As Long
        y As Long
        Declare Sub SetX(ByVal newValue As Long)
    End Type

    Type ColoredPoint Extends Point
        colorValue As ULong
    End Type
End Namespace

' end of types.bi
