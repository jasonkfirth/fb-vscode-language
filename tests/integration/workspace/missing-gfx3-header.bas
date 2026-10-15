/'
    Project: FreeBASIC VS Code extension integration fixtures
    ---------------------------------------------

    File: missing-gfx3-header.bas

    Purpose:

        Provide a focused missing-header quick-fix case.

    Responsibilities:

        - reference one API declared in fbgfx3.bi
        - omit the include and namespace import deliberately

    This file intentionally does NOT contain:

        - project configuration
        - runtime image loading
'/

#lang "fb"
Dim surface As Any Ptr = Gfx3SurfaceLoad("missing.png")

' end of missing-gfx3-header.bas
