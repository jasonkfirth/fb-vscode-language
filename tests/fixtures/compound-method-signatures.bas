' Project: FreeBASIC VS Code Language Extension Tests
' File: compound-method-signatures.bas
' Purpose: Exercise native method signatures on compound receivers.
' Responsibilities: Cover overload selection, access, properties, and receiver forms.
' Does not contain: Runtime method bodies or editor commands.

Type MethodService
    value As Long
    Declare Function Measure Overload(ByVal amount As Long, ByVal scale As Double = 1) As Double
    Declare Function Measure Overload(ByVal amount As Double, ByVal scale As Double = 2) As Double
    Declare Sub Apply(ByVal amount As Long, ByVal scale As Double)
    Declare Property Item(ByVal index As Long) As Double
    Declare Property Item(ByVal index As Double) As Double
    Declare Property Item(ByVal index As Long, ByVal assignedValue As Double)
Private:
    Declare Function Measure Overload(ByVal amount As String, ByVal scale As Double = 3) As Double
    Declare Function HiddenMethod(ByVal secret As Long) As Double
End Type

Declare Function MakeService() As MethodService
Declare Function MakeServicePointer() As MethodService Ptr
Dim services(0 To 1) As MethodService
Dim servicePointer As MethodService Ptr = @services(0)

Print MakeService().Measure(CLng(1), 2)
Print MakeService().Measure(CDbl(1), 2)
Print services(0).Measure(CLng(1), 2)
Print (*servicePointer).Measure(CDbl(1), 2)
Print MakeServicePointer()->Measure(CDbl(1), 2)
Print MakeService().Item(CLng(1))
Print MakeService().Item(CDbl(1))
MakeService().Apply(1, 2)

MakeService().Measure CLng(1), 2
services(0).Measure CDbl(1), 2
(*servicePointer).Apply 1, 2
MakeServicePointer()->Apply 1, 2
With services(0)
    .Measure CLng(1), 2
    .Measure CDbl(1), 2
    .Apply 1, 2
    If 1 Then .Apply 1, 2
    .Apply 1, _
        2
End With

' end of compound-method-signatures.bas
