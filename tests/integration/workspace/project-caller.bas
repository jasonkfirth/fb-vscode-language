''
'' Project: FreeBASIC language extension tests
'' File: project-caller.bas
'' Purpose: Reference a procedure implemented in another translation unit.
'' Responsibilities: supply an independently compiled call site.
'' Does not contain: procedure implementations or test assertions.
''
#include once "project-api.bi"
Print AdjustProjectValue(1)
'' end of project-caller.bas
