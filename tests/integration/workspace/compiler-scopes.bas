'' Project: FreeBASIC language extension tests
'' File: compiler-scopes.bas
'' Purpose: Exercise native lexical regions and declaration ownership.
'' Responsibilities: cover branch isolation, imports, anonymous fields, and access.
'' Does not contain: a heuristic scope oracle or editor-driven source writes.

Namespace Catalog
    Dim Shared sharedValue As Long
    Dim moduleOnly As Long
    Type Parent Extends Object
        publicValue As Long
        Protected:
        protectedValue As Double
        Private:
        privateValue As Long
    End Type
    Type Child Extends Parent
        ownValue As Long
        Union
            anonymousLong As Long
            anonymousDouble As Double
        End Union
        Declare Function ReadValue(ByVal amount As Long) As Double
    End Type
End Namespace

Namespace Catalog
    Const reopenedValue = 7
End Namespace

Function Catalog.Child.ReadValue(ByVal amount As Long) As Double
    Dim localValue As Long
    Dim ownValue As Double
    If amount Then
        Dim branchValue As Long
        Print branchValue
    Else
        Dim branchValue As Double
        Print branchValue
    End If
    For index As Long = 0 To 1
        Dim loopValue As Long
        Print loopValue
    Next
    Print localValue
    Print This.protectedValue
    Return protectedValue + amount
End Function

Using Catalog
Dim instance As Child
Print instance.publicValue
Print instance.ownValue
Print sharedValue

'' end of compiler-scopes.bas
