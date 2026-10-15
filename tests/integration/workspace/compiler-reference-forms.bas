'' Project: FreeBASIC VS Code Language Extension
'' File: compiler-reference-forms.bas
'' Purpose: Exercise committed namespace, address, and result references.
'' Responsibilities: distinguish overloads outside ordinary call expressions.
'' Does not contain: external libraries or compiler extensions.

Namespace Functions
    Function Pick Overload(ByVal value As Long) As Long
        Pick = value
    End Function
    Function Pick Overload(ByVal value As Double) As Double
        Pick = value
    End Function
    Namespace Nested
        Const Tag = 1
    End Namespace
End Namespace

Using Functions, Functions.Nested
Dim longCallback As Function(ByVal As Long) As Long = @Functions.Pick
Dim doubleCallback As Function(ByVal As Double) As Double = ProcPtr(Functions.Pick, Function(ByVal As Double) As Double)
Dim inferredCallback As Function(ByVal As Long) As Long = ProcPtr(Pick)
Print longCallback(1), doubleCallback(2.0), inferredCallback(3)
Print Pick(1), Pick(2.0), Tag

'' end of compiler-reference-forms.bas
