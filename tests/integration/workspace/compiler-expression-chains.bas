'' Project: FreeBASIC VS Code Language Extension
'' File: compiler-expression-chains.bas
'' Purpose: Exercise each written prefix of compound native expressions.
'' Responsibilities: cover arrays, pointers, methods, returns, and qualification.
'' Does not contain: heuristic expected-type calculations or runtime pointer tests.

Namespace TreeTypes
    Type Leaf
        amount As Double
    End Type
    Type Branch
        leaves(0 To 1) As Leaf
        Declare Function GetLeaf(ByVal index As Long) ByRef As Leaf
    End Type
    Type Root
        child As Branch
    End Type
    Dim Shared globalRoot As Root
End Namespace

Function TreeTypes.Branch.GetLeaf(ByVal index As Long) ByRef As TreeTypes.Leaf
    Return leaves(index)
End Function

Function MakeRoot() As TreeTypes.Root
    Dim result As TreeTypes.Root
    Return result
End Function

Function MakeRootPointer() As TreeTypes.Root Ptr
    Return @TreeTypes.globalRoot
End Function

Dim roots(0) As TreeTypes.Root
Dim rootPointer As TreeTypes.Root Ptr = @roots(0)
Dim doublePointer As TreeTypes.Root Ptr Ptr = @rootPointer
Dim callback As Function() As TreeTypes.Root Ptr = @MakeRootPointer
Dim chainIndex As Long
Print roots(0).child.leaves(1).amount
Print rootPointer[0].child.leaves(1).amount
Print rootPointer->child.GetLeaf(0).amount
Print MakeRoot().child.leaves(0).amount
Print CPtr(TreeTypes.Root Ptr, rootPointer)->child.GetLeaf(0).amount
Print (*rootPointer).child.GetLeaf(0).amount
Print callback()->child.leaves(0).amount
Print (**doublePointer).child.leaves(0).amount
Print TreeTypes.globalRoot.child.leaves(0).amount

With roots(0).child.leaves(0)
    Print .amount
End With

For chainIndex = 0 To 0
    Print roots(chainIndex).child.leaves(0).amount
Next

'' end of compiler-expression-chains.bas
