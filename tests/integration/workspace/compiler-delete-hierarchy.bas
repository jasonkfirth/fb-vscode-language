'' Project: FreeBASIC language extension tests
'' File: compiler-delete-hierarchy.bas
'' Purpose: Exercise destructor and custom deallocator Call Hierarchy.
'' Responsibilities: define an array deallocator and a UDT destructor.
'' Does not contain: runtime or allocation-failure assertions.
''

Type DeleteHierarchyValue
    value As Long
    Declare Destructor()
    Declare Operator Delete[](ByVal buffer As Any Ptr)
End Type

Destructor DeleteHierarchyValue()
End Destructor

Operator DeleteHierarchyValue.Delete[](ByVal buffer As Any Ptr)
    Deallocate buffer
End Operator

Dim deletedValues As DeleteHierarchyValue Ptr = New DeleteHierarchyValue[2]
Delete[] deletedValues

'' end of compiler-delete-hierarchy.bas
