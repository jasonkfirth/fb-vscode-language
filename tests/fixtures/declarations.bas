Option Explicit

Namespace Demo

Const APP_NAME As String = "fb-test"

Type Person
    name As String
End Type

Enum ColorMode
    ColorModeMono = 0
End Enum

Declare Sub PrintMessage(ByRef text As String)
Function BuildPerson(ByRef inputName As String) As Person
    Dim As Person resultPerson
    resultPerson.name = inputName
    Return resultPerson
End Function

Dim As Integer counter, total
Dim Shared workerHandle As Any Ptr
Extern externalFlag As Long

End Namespace
