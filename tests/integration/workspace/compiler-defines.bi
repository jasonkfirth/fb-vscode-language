'' Project: FreeBASIC editor tests
'' File: compiler-defines.bi
'' Purpose: Verify tracking of includes which emit no declarations themselves.
'' Responsibilities: provide a declaration macro for the context fixture.
'' Does not contain: ordinary parser-visible source or runtime behavior.

#define DECLARE_VALUE(name) Dim Shared name As SelectedType

'' end of compiler-defines.bi
