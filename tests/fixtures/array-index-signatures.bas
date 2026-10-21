' Project: FreeBASIC VS Code Language Extension Tests
' File: array-index-signatures.bas
' Purpose: Exercise compiler-backed array index assistance.
' Responsibilities: Cover fixed, compound-field, callback, dynamic, and descriptor arrays.
' Does not contain: Editor APIs or overloaded procedure calls.

Dim matrix(-1 To 4, 1 To 3) As Long
Print matrix(0, 2)

Type ArrayHolder
    values(-2 To 2) As Long
    callbacks(-1 To 1) As Function(ByVal eventCode As Long) As Double
End Type
Dim holder As ArrayHolder
Print holder.values(0)

Function GetHolder() As ArrayHolder
    Dim result As ArrayHolder
    Return result
End Function
Dim holders(0 To 1) As ArrayHolder
Dim holderPointer As ArrayHolder Ptr = @holder
Print GetHolder().values(0)
Print holders(0).values(0)
Print (*holderPointer).values(0)
Print GetHolder().callbacks(0)(1)

ReDim dynamicValues(0 To 2, 1 To 3) As Long
Print dynamicValues(0, 2)

Sub InspectDescriptor(values() As Long)
    Print values(0, 2)
End Sub

' end of array-index-signatures.bas
