' Project: FreeBASIC language extension integration fixtures
' File: compiler-preprocessor.bas
' Purpose: Exercise native preprocessor symbols and physical source identities.
' Responsibilities: cover macro lifetimes, qualified lookups, and empty macros.
' Does not contain: external dependencies or runtime filesystem access.

#ifndef PREPROCESSOR_INCLUDED
#define PREPROCESSOR_INCLUDED 1
#define SCALE_VALUE(value) ((value) * 2)
#define SCALE_VALUE(item) ((item) * 2)
#define MULTILINE_VALUE(value) _
    ((value) + 2)
#define NESTED_SCALE(argument) SCALE_VALUE(argument)
#define STRING_VALUE(value) #value
#define EMPTY_VALUE()
#define CURRENT_STATE 1
#endif

Dim inputValue As Double
Namespace MacroQuery
    Const qualifiedValue As Long = 3
End Namespace
#if defined(MacroQuery.qualifiedValue)
Print MacroQuery.qualifiedValue
#endif
#if defined(SCALE_VALUE)
Print SCALE_VALUE(inputValue)
#endif
Print MULTILINE_VALUE(inputValue)
Print NESTED_SCALE(inputValue)
Print STRING_VALUE(inputValue)
EMPTY_VALUE()
#ifdef CURRENT_STATE
Print CURRENT_STATE
#endif
#undef CURRENT_STATE
#ifndef CURRENT_STATE
#define CURRENT_STATE 2
#endif
Print CURRENT_STATE

' end of compiler-preprocessor.bas
