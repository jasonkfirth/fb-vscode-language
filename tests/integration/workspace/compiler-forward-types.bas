'' Project: FreeBASIC VS Code Language Extension
'' File: compiler-forward-types.bas
'' Purpose: Exercise temporary forward-type identities and compiler backpatching.
'' Responsibilities: cover shared targets, pointer aliases, and opaque types.
'' Does not contain: runtime dereferences of uninitialized pointers.

Type Link As Node
Type As Element Ptr FirstPointer, SecondPointer
Type Opaque As Opaque
Dim Shared earlyNode As Link Ptr
Type Node
    nextNode As Link Ptr
    value As Long
End Type
Type Element As Long
Dim root As Node, other As Link
Dim first As FirstPointer, second As SecondPointer
Dim handle As Opaque Ptr
Print SizeOf(*earlyNode), root.value, other.value

'' end of compiler-forward-types.bas
