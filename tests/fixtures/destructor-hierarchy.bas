'' Project: FreeBASIC VS Code Language Extension tests
'' File: destructor-hierarchy.bas
'' Purpose: Exercise compiler-selected cleanup through a destructor caller.
'' Responsibilities: cover DELETE, scope/temporary cleanup, and unrelated types.
'' Does not contain: invalid programs or compiler-private identity assumptions.

Dim Shared cleanupCount As Long

Sub RecordCleanup()
    cleanupCount += 1
End Sub

Type CleanupValue
    value As Long
    Declare Constructor(ByVal initialValue As Long = 0)
    Declare Destructor()
End Type

Constructor CleanupValue(ByVal initialValue As Long)
    This.value = initialValue
End Constructor

Destructor CleanupValue()
    RecordCleanup()
End Destructor

Sub ReleaseOne()
    Dim allocated As CleanupValue Ptr = New CleanupValue
    Delete allocated
End Sub

Sub LeaveScope()
    Dim localValue As CleanupValue
End Sub

Sub LeaveEarly()
    Dim earlyValue As CleanupValue
    Return
End Sub

Sub UseTemporary(ByRef temporaryValue As CleanupValue)
End Sub

Type OtherCleanupValue
    value As Long
    Declare Destructor()
End Type

Destructor OtherCleanupValue()
End Destructor

Sub ReleaseOther()
    Dim otherValue As OtherCleanupValue
End Sub

ReleaseOne()
LeaveScope()
LeaveEarly()
UseTemporary(CleanupValue(9))
ReleaseOther()
If cleanupCount <> 4 Then End 1

'' end of destructor-hierarchy.bas
