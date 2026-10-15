'' Project: FreeBASIC language extension tests
'' File: compiler-new-operator-hierarchy.bas
'' Purpose: Exercise compiler-selected scalar and array allocators.
'' Responsibilities: define and invoke custom UDT NEW operators.
'' Does not contain: destructor or allocation-failure assertions.
''

Type NewOperatorHierarchyValue
    value As Long
    Declare Operator New(ByVal size As UInteger) As Any Ptr
    Declare Operator New[](ByVal size As UInteger) As Any Ptr
End Type

Operator NewOperatorHierarchyValue.New(ByVal size As UInteger) As Any Ptr
    Return Allocate(size)
End Operator

Operator NewOperatorHierarchyValue.New[](ByVal size As UInteger) As Any Ptr
    Return Allocate(size)
End Operator

Dim allocatedValue As NewOperatorHierarchyValue Ptr = New NewOperatorHierarchyValue
Dim allocatedValues As NewOperatorHierarchyValue Ptr = New NewOperatorHierarchyValue[2]

'' end of compiler-new-operator-hierarchy.bas
