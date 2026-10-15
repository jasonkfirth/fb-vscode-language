''
'' Project: FreeBASIC language extension tests
'' File: compiler-overloads.bi
'' Purpose: Declare overloads whose selection is owned by the compiler.
'' Responsibilities: exercise prototype identity, namespaces, and return types.
'' Does not contain: implementations or executable test assertions.
''

Namespace Choices
    Type IntegerResult
        integerValue As Long
    End Type
    Type FloatingResult
        floatingValue As Double
    End Type
    Declare Function SelectValue Overload(ByVal value As Long) As Long
    Declare Function SelectValue Overload(ByVal value As Double) As Long
    Declare Function MakeResult Overload(ByVal value As Long) As IntegerResult
    Declare Function MakeResult Overload(ByVal value As Double) As FloatingResult
End Namespace

Type Selector
    storedValue As Long
    Declare Function SelectValue Overload(ByVal value As Long) As Long
    Declare Function SelectValue Overload(ByVal value As Double) As Long
    Declare Property CurrentValue() As Long
    Declare Property CurrentValue(ByVal value As Long)
    Declare Property IndexedValue(ByVal index As Long) As Double
End Type

'' end of compiler-overloads.bi
