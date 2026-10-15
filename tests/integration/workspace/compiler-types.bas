''
'' Project: FreeBASIC language extension tests
'' File: compiler-types.bas
'' Purpose: Exercise native expression types beyond declared-name lookup.
'' Responsibilities: cover promotions, operators, casts, pointers, arrays, and runtime helpers.
'' Does not contain: a JavaScript type oracle or runtime output assertions.
''

Type Packet
    amount As Long
End Type

Type WrappedValue
    value As Long
    Declare Constructor(ByVal source As Long)
End Type

Constructor WrappedValue(ByVal source As Long)
    This.value = source
End Constructor

Sub ThreadWorker(ByVal value As Any Ptr)
End Sub

Operator +(ByRef first As Packet, ByRef second As Packet) As Packet
    Dim result As Packet
    Return result
End Operator

Dim packets(0) As Packet
Dim dynamicPackets() As Packet
Dim packetPtr As Packet Ptr = @packets(0)
Var inferred = CDbl(1)
Dim encoded As String = "\0\0\0\0"
Dim wrapped As WrappedValue = 3
Print (packets(0) + packets(0)).amount
ReDim dynamicPackets(0)
Print dynamicPackets(0).amount
Print CPtr(Packet Ptr, packetPtr)->amount
Print CLng(1) + CLng(2) + CDbl(3)
Print inferred * 2
Print Sin(inferred)
Print CVL(encoded)
Print wrapped.value
Print WrappedValue(5).value
Print Type<WrappedValue>(5).value
Dim allocated As WrappedValue Ptr = New WrappedValue(5)
Print allocated->value
Print IIf(inferred > 0, CLng(1), CDbl(2))
Print Not CLng(1)
Print "a" & "b"
Print ThreadCall ThreadWorker(0)

'' end of compiler-types.bas
