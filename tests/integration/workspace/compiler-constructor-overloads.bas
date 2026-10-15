'' Project: FreeBASIC language extension tests
'' File: compiler-constructor-overloads.bas
'' Purpose: Exercise compiler-selected constructor and destructor relationships.
'' Responsibilities: verify call hierarchy and overload identity through sidecar data.
'' Does not contain: runtime output assertions or source-side overload scoring.
''

Type ConstructorChoice
    value As Long
    Declare Constructor()
    Declare Constructor(ByVal source As Long)
    Declare Constructor(ByVal source As Double)
    Declare Destructor()
End Type

Constructor ConstructorChoice()
    This.value = 0
End Constructor

Constructor ConstructorChoice(ByVal source As Long)
    This.value = source
End Constructor

Constructor ConstructorChoice(ByVal source As Double)
    This.value = CLng(source)
End Constructor

Destructor ConstructorChoice()
End Destructor

Dim integerChoice As ConstructorChoice Ptr = New ConstructorChoice(5)
Dim doubleChoice As ConstructorChoice Ptr = New ConstructorChoice(CDbl(5))
Dim defaultChoice As ConstructorChoice Ptr = New ConstructorChoice
Dim disposedChoice As ConstructorChoice Ptr = New ConstructorChoice
Delete disposedChoice
Dim disposedChoices As ConstructorChoice Ptr = New ConstructorChoice[2]
Delete[] disposedChoices

Function makeReturnedChoice() As ConstructorChoice
    Dim localChoice As ConstructorChoice
    Dim initializedChoice As ConstructorChoice = CLng(5)
    Return ConstructorChoice()
End Function

Sub scopeDisposeChoice()
    Dim exitChoice As ConstructorChoice
    Exit Sub
End Sub

Function makeTemporaryChoice() As ConstructorChoice
    Return ConstructorChoice()
End Function

Sub inspectTemporaryChoice()
    Dim marker As Long = makeTemporaryChoice().value
End Sub


'' end of compiler-constructor-overloads.bas
