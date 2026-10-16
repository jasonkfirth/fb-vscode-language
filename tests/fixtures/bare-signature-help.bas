'' Project: FreeBASIC VS Code Language Extension tests
'' File: bare-signature-help.bas
'' Purpose: Exercise declared procedures called without argument parentheses.
'' Responsibilities: cover qualified calls, methods, continuations, and overloads.
'' Does not contain: incomplete programs, editor settings, or runtime assertions.

Namespace BareCalls
    Sub AcceptValues(ByVal first As Long, ByVal second As String, ByVal third As Long = 0)
    End Sub

    Sub SelectValues Overload(ByVal first As Long, ByVal second As String)
    End Sub

    Sub SelectValues Overload(ByVal first As Double, ByVal second As String)
    End Sub
End Namespace

Type BareReceiver
    value As Long
    Declare Sub SetValues(ByVal first As Long, ByVal second As String)
End Type

Sub BareReceiver.SetValues(ByVal first As Long, ByVal second As String)
End Sub

Dim receiver As BareReceiver
Dim receiverPointer As BareReceiver Ptr = @receiver
BareCalls.AcceptValues CLng(1), "a,b", 3
BareCalls.AcceptValues 1, _
    "continued,argument", _
    3
BareCalls.SelectValues CDbl(2), "selected"
receiver.SetValues 1, "member"
receiverPointer->SetValues 2, "pointer"
If 1 Then BareCalls.AcceptValues 1, "inline", 2 Else BareCalls.AcceptValues 2, "else", 3

'' end of bare-signature-help.bas
