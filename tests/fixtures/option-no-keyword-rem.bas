' Project: FreeBASIC VS Code Language Extension
' File: tests/fixtures/option-no-keyword-rem.bas
' Purpose: Verify conditional REM identifiers survive compiler-backed editor features.
' Responsibilities: exercise parser and editor comment-boundary state in procedure scope.
' Does not contain: compiler model assertions or editor provider logic.

#if 1
Option NoKeyword REM
#endif
Sub RemIdentifierProbe()
    Dim REM As Integer
    REM = (1 + 2)
    Print REM
End Sub
Sub OtherIdentifierProbe()
    Dim otherValue As Integer
    Print otherValue
End Sub

' end of option-no-keyword-rem.bas
