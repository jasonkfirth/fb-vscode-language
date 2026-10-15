''
'' Project: FreeBASIC language extension tests
'' File: compiler-dispatch.bas
'' Purpose: Check committed calls before virtual and BYREF lowering.
'' Responsibilities: exercise static dispatch targets and indirect-call safety.
'' Does not contain: runtime dispatch assertions or implicit-call analysis.
''

Type BaseSelector Extends Object
    Declare Virtual Function Choose(ByVal value As Long) As Long
End Type

Type DerivedSelector Extends BaseSelector
    Declare Function Choose(ByVal value As Long) As Long Override
End Type

Function BaseSelector.Choose(ByVal value As Long) As Long
    Return 1
End Function

Function DerivedSelector.Choose(ByVal value As Long) As Long
    Return 2
End Function

Function SharedValue(ByVal index As Long) ByRef As Long
    Static storage As Long
    Return storage
End Function

Function PlainCall(ByVal value As Long) As Long
    Return value
End Function

Sub ConsumeValue(ByVal value As Long, ByVal extra As Long = 0)
End Sub

Dim instance As DerivedSelector
Dim ByRef baseView As BaseSelector = instance
Print baseView.Choose(1)
Print instance.Choose(1)
SharedValue(1) = PlainCall(2)
ConsumeValue 1

Dim callback As Function(ByVal value As Long) As Long = @PlainCall
Print callback(1)

'' end of compiler-dispatch.bas
