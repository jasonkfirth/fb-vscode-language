''
'' Project: FreeBASIC language extension tests
'' File: project-implementation.bas
'' Purpose: Implement the shared project procedure for rename validation.
'' Responsibilities: provide a body matching both configured signature types.
'' Does not contain: application startup or a test harness.
''
#include once "project-api.bi"
Function AdjustProjectValue(ByVal value As ProjectNumber) As ProjectNumber
    Return value
End Function
'' end of project-implementation.bas
