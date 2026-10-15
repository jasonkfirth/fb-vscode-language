/'
    Project: FreeBASIC VS Code Language Extension
    File: macro-diagnostic-root.bas
    Purpose: Exercise diagnostics from a compiler-resolved macro include.
    Responsibilities: include a header through a preprocessor replacement.
    This file intentionally does NOT contain a runnable program.
'/

#define DIAGNOSTIC_HEADER "macro-diagnostic-header.bi"
#include DIAGNOSTIC_HEADER

' end of macro-diagnostic-root.bas
