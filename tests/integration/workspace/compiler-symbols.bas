''
'' Project: FreeBASIC language extension tests
'' File: compiler-symbols.bas
'' Purpose: Exercise native identities across source symbol classes.
'' Responsibilities: cover shadowing, parameter reconciliation, and type links.
'' Does not contain: simulated lookup or generated compiler output.
''

Namespace Catalog
    Type Record
        value As Double
    End Type
    Type RecordAlias As Record
    Const Factor = 2
    Enum Choice
        One = 1
    End Enum
    Declare Function ReadValue(ByRef declared As RecordAlias) As Double
End Namespace

Function Catalog.ReadValue(ByRef actual As Catalog.RecordAlias) As Double
    Dim value As Double = actual.value
    Scope
        Dim value As Long = Catalog.One
        Print value
    End Scope
    Return value * Catalog.Factor
End Function

Dim recordValue As Catalog.RecordAlias
recordValue.value = 1
Print Catalog.ReadValue(recordValue)
Goto complete
complete:

'' end of compiler-symbols.bas
