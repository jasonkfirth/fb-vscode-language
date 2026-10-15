/'
    Project: FreeBASIC VS Code extension integration fixtures
    ---------------------------------------------

    File: compiler-type-inlay-hints.bas

    Purpose:

        Verify compiler-selected types are shown only when the declaration
        leaves its type implicit or inferred.

    Responsibilities:

        - include implicit and inferred declarations
        - include explicit and suffix-typed declarations as negative cases

    This file intentionally does NOT contain:

        - a runnable program
        - project configuration
'/

#lang "fblite"
Dim implicitValue
Dim explicitValue As Long
Const inferredValue = 2 + 3
Const suffixValue% = 7
Function inferredFunction()
    Return 7
End Function
Function explicitFunction() As Double
    Return 2
End Function
Sub mixedParameters(implicitParameter, explicitParameter As Long)
End Sub

' end of compiler-type-inlay-hints.bas
