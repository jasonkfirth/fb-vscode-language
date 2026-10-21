' Project: FreeBASIC VS Code Language Extension Tests
' File: stock-type-completions.bas
' Purpose: Exercise binding-backed type completion for disabled keywords.
' Responsibilities: Cover aggregates, aliases, enums, and qualified namespaces.
' Does not contain: Editor APIs or intentionally invalid declarations.

#lang "fblite"
Option NoKeyword REM, IF, WHILE, PRINT

Type REM
    value As Long
End Type
Type IF As REM
Enum WHILE
    LoopValue
End Enum
Namespace PRINT
    Type Payload
        value As Long
    End Type
End Namespace

Dim directValue As REM
Dim aliasValue As IF
Dim enumValue As WHILE
Dim qualifiedValue As PRINT.Payload

' end of stock-type-completions.bas
