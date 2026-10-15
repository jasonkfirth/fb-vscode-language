'' Project: FreeBASIC editor tests
'' File: compiler-context.bas
'' Purpose: Exercise real conditional selection and generated declarations.
'' Responsibilities: compile both configurations; expose an inspectable member.
'' Does not contain: runtime side effects or external dependencies.

#ifndef ALTERNATE
Type SelectedType
    primaryValue As Long
End Type
#else
Type SelectedType
    alternateValue As Long
End Type
#endif

#include once "compiler-defines.bi"
DECLARE_VALUE(selected)

#ifndef ALTERNATE
Print selected.primaryValue
#else
Print selected.alternateValue
#endif

'' end of compiler-context.bas
