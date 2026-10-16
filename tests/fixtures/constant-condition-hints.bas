/'
    Project: FreeBASIC VS Code Language Extension Tests
    File: constant-condition-hints.bas
    Purpose: Exercise compiler-selected constant and runtime IF predicates.
    Responsibilities: Cover ELSEIF, single-line and continued conditions.
    Does not contain: a second evaluator or intentionally invalid code.
'/

Dim Shared conditionValue As Long
If 0 Then
    conditionValue = 1
ElseIf 2 + 2 = 4 Then
    conditionValue = 2
End If
If conditionValue Then conditionValue += 1
If 1 Then conditionValue += 1
/' Unicode prefix: π '/ If 3 <> 3 Then conditionValue += 1
If _
    4 = 4 Then
    conditionValue += 1
End If
#if 0
If 0 Then conditionValue += 1
#endif

'' end of constant-condition-hints.bas
