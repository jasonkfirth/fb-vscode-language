''
'' Project: FreeBASIC language extension tests
'' File: compiler-overloads.bas
'' Purpose: Supply real overload decisions for compiler and editor tests.
'' Responsibilities: cover nested, qualified, member, and generated calls.
'' Does not contain: an alternative overload resolver or a test harness.
''

#include once "compiler-overloads.bi"

Function Choices.SelectValue(ByVal value As Long) As Long
    Return 1
End Function

Function Choices.SelectValue(ByVal value As Double) As Long
    Return 2
End Function

Function Choices.MakeResult(ByVal value As Long) As Choices.IntegerResult
    Dim result As Choices.IntegerResult
    Return result
End Function

Function Choices.MakeResult(ByVal value As Double) As Choices.FloatingResult
    Dim result As Choices.FloatingResult
    Return result
End Function

Function Selector.SelectValue(ByVal value As Long) As Long
    Return 3
End Function

Function Selector.SelectValue(ByVal value As Double) As Long
    Return 4
End Function

Property Selector.CurrentValue() As Long
    Return 5
End Property

Property Selector.CurrentValue(ByVal value As Long)
End Property

Property Selector.IndexedValue(ByVal index As Long) As Double
    Return index
End Property

Using Choices
Print SelectValue(CLng(1)), SelectValue(CDbl(1))
Print SelectValue(CShort(1))
Print SelectValue(SelectValue(CDbl(1)))
Print Choices.SelectValue(CDbl(1))
Print "café", SelectValue(CDbl(1))
Print MakeResult(CDbl(1)).floatingValue

Dim instance As Selector
Print instance.SelectValue(CDbl(1))
instance.CurrentValue = SelectValue(CLng(1))
Print instance.CurrentValue
Print instance.IndexedValue(2)

#define SELECT_GENERATED(value) SelectValue(value)
Print SELECT_GENERATED(CDbl(1))
Print SelectValue( _
    CDbl(1))

'' end of compiler-overloads.bas
