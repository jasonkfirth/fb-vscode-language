''
'' Project: FreeBASIC language extension tests
'' File: compiler-token-paste-rename.bas
'' Purpose: Exercise safe project rename through multi-argument token pasting.
'' Responsibilities: provide generated and token-pasted references to variables.
'' Does not contain: multiple-component rename cases or test-runner assertions.
''
#define DECLARE_VALUE(prefix, suffix) Dim prefix##suffix As Long
#define JOIN_NAME(first, second) first##second
DECLARE_VALUE(my, Value)

Print myValue

Dim sourceValue As Long
Print sourceValue
Print JOIN_NAME(source, Value)

'' end of compiler-token-paste-rename.bas
