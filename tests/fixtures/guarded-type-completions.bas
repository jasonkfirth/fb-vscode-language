' Project: FreeBASIC VS Code Language Extension Tests
' File: guarded-type-completions.bas
' Purpose: Exercise compiler-selected type names inside conditional branches.
' Responsibilities: Distinguish same-name types and keep inactive names absent.
' Does not contain: Editor APIs or intentionally invalid declarations.

#lang "fblite"
Option NoKeyword REM, WHILE
#ifdef FIRST_TYPE
Type REM
    firstValue As Long
End Type
Type WHILE
    value As Long
End Type
#else
Type REM
    secondValue As Double
End Type
#endif
Dim selected As REM

' end of guarded-type-completions.bas
