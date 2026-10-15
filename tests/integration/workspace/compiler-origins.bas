' Project: FreeBASIC language extension integration fixtures
' File: compiler-origins.bas
' Purpose: Exercise physical origins through continuations and logical remapping.
' Responsibilities: provide direct identifiers beside expanded or rewritten text.
' Does not contain: filesystem writes or external dependencies.

Dim originValue As _
    Double
Dim _secondValue As Double
Print originValue + _
    2
Print &h10, originValue
Print "café 🌍", originValue
#define GENERATED_NUMBER 3
Print GENERATED_NUMBER, originValue
/' A multiline comment.
   /' Nested comment. '/
'/ Print originValue
Print .5, _secondValue, originValue
#line 600 "logical-origin.bas"
Print originValue * 3
#line 600 "logical-origin.bas"
Print originValue * 4

' end of compiler-origins.bas
