' Project: FreeBASIC VS Code Language Extension Tests
' File: type-completions.bas
' Purpose: Exercise type-position completion using real compiler declarations.
' Responsibilities: Cover aliases, qualification, macros, and expression boundaries.
' Does not contain: Editor APIs or intentionally invalid declarations.

Namespace TypeSpace
    Type SampleType
        value As Long
    End Type
    Type SampleAlias As SampleType
    Enum SampleEnum
        SampleFirst
    End Enum
    Union SampleUnion
        whole As Long
        fraction As Single
    End Union
    Dim unrelatedVariable As Long
    Function unrelatedFactory() As Long
        Return 1
    End Function
    Namespace Nested
        Type InnerType
            value As Long
        End Type
    End Namespace
End Namespace
Using TypeSpace

Type DerivedType Extends Object
    payload As SampleAlias
End Type

#define TypeMacro(element) element
Const lengthValue = 8
Dim ordinaryValue As Long
Function BuildValue(ByVal amount As Long) As Long
    Return amount
End Function

Dim selected As SampleType
Dim qualified As TypeSpace.SampleAlias
Dim macroValue As TypeMacro(SampleType)
Dim continued As _
    SampleAlias
Declare Sub AcceptType(ByVal value As SampleType)
Declare Function SupplyType() As SampleAlias
Type GlobalAlias As SampleType
Dim queried As Typeof(ordinaryValue)
Dim fixedText As String * lengthValue
Dim initialized As Long = BuildValue(1)
Dim callback As Function Cdecl(ByVal value As Long) As Long

' end of type-completions.bas
