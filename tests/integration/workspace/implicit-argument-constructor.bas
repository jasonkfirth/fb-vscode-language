''
'' Project: FreeBASIC VS Code Language Extension tests
'' File: implicit-argument-constructor.bas
'' Purpose: Exercise compiler-selected constructors for implicitly converted arguments.
'' Responsibilities: define overloaded UDT constructors, physical conversion sites, and an outgoing call edge.
'' This file intentionally does NOT contain: project configuration or runtime assertions.
''

Type ArgumentValue
    value As Long
    Declare Constructor(ByVal initial As Long)
    Declare Constructor(ByVal initial As Double)
    Declare Destructor()
End Type

Sub recordArgumentValue(ByVal value As Long)
End Sub

Constructor ArgumentValue(ByVal initial As Long)
    recordArgumentValue(initial)
    This.value = initial
End Constructor

Constructor ArgumentValue(ByVal initial As Double)
    This.value = CInt(initial)
End Constructor

Destructor ArgumentValue()
    This.value = -1
End Destructor

Sub takeArgument(ByVal value As ArgumentValue)
End Sub

Sub exerciseArgumentValues()
    takeArgument(17)
    takeArgument(2.5)
End Sub

exerciseArgumentValues()

'' end of implicit-argument-constructor.bas
