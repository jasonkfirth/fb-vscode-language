' Project: FreeBASIC language extension integration fixtures
' File: compiler-macro-origins.bas
' Purpose: Exercise source relationships in native macro replacement text.
' Responsibilities: cover copying, duplication, nesting, and constructed tokens.
' Does not contain: filesystem access or external dependencies.

#define CopyValue(value) value
#define TwiceValue(value) ((value) + (value))
#define NestedValue(value) CopyValue(TwiceValue(value))
#define DeclareValue(name) Dim name As Double
#define ReadMember(item, member) item.member
#define JoinName(first, second) first##second
#define QuoteValue(value) #value
#define DirectValue sourceValue

Type Container
    amount As Double
End Type
Dim item As Container
Dim sourceValue As Double
DeclareValue(createdValue)
Print CopyValue(sourceValue)
Print TwiceValue(sourceValue)
Print NestedValue(sourceValue)
Print ReadMember(item, amount)
Print JoinName(source, Value)
Print QuoteValue(sourceValue)
Print DirectValue
Print createdValue

' end of compiler-macro-origins.bas
