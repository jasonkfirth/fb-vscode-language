/'
    Project: FreeBASIC VS Code extension integration fixtures
    ---------------------------------------------

    File: compiler-inactive-brackets.bas

    Purpose:

        Verify compiler-selected inactive ranges do not produce bracket
        warnings when a current semantic model is available.

    Responsibilities:

        - place one unmatched opener in an inactive preprocessor branch
        - keep the selected branch syntactically balanced

    This file intentionally does NOT contain:

        - a runnable program
        - project configuration
'/

#if 0
Print (
#else
Dim activeValue As Integer = 1
#endif

' end of compiler-inactive-brackets.bas
