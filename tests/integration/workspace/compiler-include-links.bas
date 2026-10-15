/'
    Project: FreeBASIC VS Code Language Extension
    File: compiler-include-links.bas
    Purpose: Exercise compiler-selected include links.
    Responsibilities: distinguish active, inactive, and macro-expanded includes.
    This file intentionally does NOT contain a runnable program.
'/

#define GENERATED_HEADER "types.bi"
#if 0
#include once "invalid.bi"
#endif
#include once "compiler-defines.bi"
#include once GENERATED_HEADER

' end of compiler-include-links.bas
