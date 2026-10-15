'' Project: FreeBASIC VS Code Language Extension Tests
'' File: ambiguous-context.bas
'' Purpose: Exercise repeated header inclusion under distinct macro states.
'' Responsibilities: provide the translation unit for contextual type hover.
'' This file intentionally does NOT contain: editor interaction assertions.
#define AMBIGUOUS_INTEGER_CONTEXT
#include "ambiguous-context.bi"
#undef AMBIGUOUS_INTEGER_CONTEXT
#include "ambiguous-context.bi"
'' end of ambiguous-context.bas
