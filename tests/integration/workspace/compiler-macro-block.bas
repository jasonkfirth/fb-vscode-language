/'
    Project: FreeBASIC VS Code extension integration fixtures
    ---------------------------------------------

    File: compiler-macro-block.bas

    Purpose:

        Verify hover previews retain a physical #macro body.

    Responsibilities:

        - define one multiline preprocessor macro
        - keep a source use for compiler preprocessing

    This file intentionally does NOT contain:

        - project configuration
        - generated compiler output
'/

#macro BLOCK_VALUE
    42
#endmacro

Print BLOCK_VALUE

' end of compiler-macro-block.bas
