'' Project: FreeBASIC language extension tests
'' File: compiler-delete-operator-hierarchy.bas
'' Purpose: Exercise custom UDT deallocator operations.
'' Responsibilities: define and invoke scalar and array deallocators.
'' Does not contain: destructor or allocation-failure assertions.
''

Type DeleteOperatorHierarchyValue
    value As Long
    Declare Operator Delete(ByVal buffer As Any Ptr)
    Declare Operator Delete[](ByVal buffer As Any Ptr)
End Type

Operator DeleteOperatorHierarchyValue.Delete(ByVal buffer As Any Ptr)
    Deallocate buffer
End Operator

Operator DeleteOperatorHierarchyValue.Delete[](ByVal buffer As Any Ptr)
    Deallocate buffer
End Operator

Dim deletedValues As DeleteOperatorHierarchyValue Ptr = New DeleteOperatorHierarchyValue[2]
Dim deletedValue As DeleteOperatorHierarchyValue Ptr = New DeleteOperatorHierarchyValue
Delete deletedValue
Delete[] deletedValues

'' end of compiler-delete-operator-hierarchy.bas
