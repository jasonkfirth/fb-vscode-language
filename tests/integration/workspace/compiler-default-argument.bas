/'
    Project: FreeBASIC VS Code extension integration fixtures
    ---------------------------------------------

    File: compiler-default-argument.bas

    Purpose:

        Verify compiler signature help retains the written default expression.

    Responsibilities:

        - define an optional parameter with a visible source default
        - provide a call site for signature help

    This file intentionally does NOT contain:

        - project configuration
        - generated compiler output
'/

Declare Sub ApplyScale(ByVal value As Long, ByVal scale As Double = 1.5)
Sub ApplyScale(ByVal value As Long, ByVal scaleFactor As Double)
End Sub

ApplyScale(2, 3.0)

' end of compiler-default-argument.bas
