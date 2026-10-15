'' Project: FreeBASIC language extension tests
'' File: compiler-iterator-hierarchy.bas
'' Purpose: Exercise compiler-selected UDT iterator operators.
'' Responsibilities: declare and call FOR, STEP, and NEXT overloads.
'' Does not contain: runtime output assertions or iterator scoring logic.
''

Type IteratorHierarchyValue
    value As Long
    Declare Constructor(ByVal initial As Long = 0)
    Declare Operator For(ByRef stepValue As IteratorHierarchyValue)
    Declare Operator Step(ByRef stepValue As IteratorHierarchyValue)
    Declare Operator Next(ByRef finish As IteratorHierarchyValue, ByRef stepValue As IteratorHierarchyValue) As Integer
End Type

Constructor IteratorHierarchyValue(ByVal initial As Long)
    This.value = initial
End Constructor

Operator IteratorHierarchyValue.For(ByRef stepValue As IteratorHierarchyValue)
End Operator

Operator IteratorHierarchyValue.Step(ByRef stepValue As IteratorHierarchyValue)
    This.value += stepValue.value
End Operator

Operator IteratorHierarchyValue.Next(ByRef finish As IteratorHierarchyValue, ByRef stepValue As IteratorHierarchyValue) As Integer
    Operator = This.value <= finish.value
End Operator

Dim iteratorValue As IteratorHierarchyValue
For iteratorValue = IteratorHierarchyValue(0) To IteratorHierarchyValue(2) Step IteratorHierarchyValue(1)
Next

'' end of compiler-iterator-hierarchy.bas
