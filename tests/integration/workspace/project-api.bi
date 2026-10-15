''
'' Project: FreeBASIC language extension tests
'' File: project-api.bi
'' Purpose: Share a procedure declaration across project translation units.
'' Responsibilities: exercise conditional signature types and shared identity.
'' Does not contain: implementations or test-runner logic.
''
#ifdef PROJECT_DOUBLE
Type ProjectNumber As Double
#else
Type ProjectNumber As Long
#endif
Declare Function AdjustProjectValue(ByVal value As ProjectNumber) As ProjectNumber
'' end of project-api.bi
