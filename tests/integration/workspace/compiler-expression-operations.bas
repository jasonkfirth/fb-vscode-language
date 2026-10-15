'' Project: FreeBASIC language extension tests
'' File: compiler-expression-operations.bas
'' Purpose: Preserve source operations and compiler-selected special members.
'' Responsibilities: exercise folded operations, calls, copy construction, conditional construction, and chaining.
'' Does not contain: guessed types or platform-specific runtime dependencies.

Function Combine Cdecl(ByVal first As Double, ByVal second As Long, ByRef third As Long, ByVal fourth As Double = 4.5, ByVal fifth As Long = 5) As Double
    Return first + second + third + fourth + fifth
End Function

Sub Observe(ByVal first As Double, ByVal second As Double, ByRef third As Long)
    Print first; second; third
End Sub

Sub ObserveCast(ByVal value As Long)
End Sub

Type NegativeValue
    value As Long
End Type

Operator - (ByRef item As NegativeValue) As NegativeValue
    Dim result As NegativeValue
    result.value = -item.value
    Return result
End Operator

Type Chain
    value As Long
End Type

Operator *(ByRef item As Chain) As Chain
    Return item
End Operator

Type Castable
    value As Long
    Declare Operator Cast() As Long
End Type

Operator Castable.Cast() As Long
    Return 7
End Operator

Type Printable
    value As Long
    Declare Operator Cast() As String
End Type

Operator Printable.Cast() As String
    Return "printable"
End Operator

Type Assignable
    value As Long
    Declare Operator Let(ByRef source As Assignable)
End Type

Operator Assignable.Let(ByRef source As Assignable)
    This.value = source.value
End Operator

Type IndexedResult
    value As Long
End Type

Type IndexedValue
    values(0 To 1) As Double
    Declare Operator [](ByVal index As Long) As Double
    Declare Operator [](ByVal index As Double) As Double
    Declare Operator [](ByVal index As String) As IndexedResult
End Type

Operator IndexedValue.[](ByVal index As Long) As Double
    Operator = values(index)
End Operator

Operator IndexedValue.[](ByVal index As Double) As Double
    Operator = values(CLng(index))
End Operator

Operator IndexedValue.[](ByVal index As String) As IndexedResult
    Dim result As IndexedResult
    result.value = Len(index)
    Operator = result
End Operator

Type SmartValue
    amount As Double
End Type

Operator ->(ByRef item As SmartValue) As SmartValue
    Operator = item
End Operator

Type AddressableValue
    amount As Double
    Declare Operator @() As AddressableValue Ptr
End Type

Operator AddressableValue.@() As AddressableValue Ptr
    Operator = @This
End Operator

Type CopiedValue
    value As Long
    Declare Constructor()
    Declare Constructor(ByRef source As CopiedValue)
End Type

Constructor CopiedValue()
    This.value = 0
End Constructor

Constructor CopiedValue(ByRef source As CopiedValue)
    This.value = source.value
End Constructor

Function CopyIntoResult(ByRef source As CopiedValue) As CopiedValue
    Return source
End Function

Sub ObserveCopiedValue(ByVal item As CopiedValue)
    Print item.value
End Sub

Type ByRefConstructed
    value As Long
    Declare Constructor(ByVal number As Long)
End Type

Constructor ByRefConstructed(ByVal number As Long)
    This.value = number
End Constructor

Sub ObserveByRefConstructed(ByRef item As ByRefConstructed)
    Print item.value
End Sub

Type ChainedValue
    value As Long
    Declare Constructor()
    Declare Constructor(ByVal initial As Long)
End Type

Constructor ChainedValue()
    This.value = 0
End Constructor

Constructor ChainedValue(ByVal initial As Long)
    Constructor()
    This.value = initial
End Constructor

Type BaseChain
    value As Long
    Declare Constructor()
End Type

Constructor BaseChain()
    This.value = 1
End Constructor

Type DerivedChain Extends BaseChain
    Declare Constructor()
End Type

Constructor DerivedChain()
    Base()
End Constructor

Type RuntimeBase Extends Object
End Type

Type RuntimeChild Extends RuntimeBase
End Type

Const operationConstant As Long = 1
Dim value As Long = 3
Dim callback As Function Cdecl(ByVal As Double, ByVal As Long, ByRef As Long, ByVal As Double, ByVal As Long) As Double = @Combine
Dim numberPointer As Long Ptr = @value
Dim doublePointer As Long Ptr Ptr = @numberPointer
Dim chainValue As Chain
Dim negativeInstance As NegativeValue
Dim castableValue As Castable
Dim printableValue As Printable
Dim firstAssignable As Assignable
Dim secondAssignable As Assignable
Dim indexedInstance As IndexedValue
Dim indexedResult As IndexedResult = indexedInstance["slot"]
Dim smartInstance As SmartValue
Dim addressableInstance As AddressableValue
Dim sourceCopy As CopiedValue
Dim initializedCopy As CopiedValue = sourceCopy
Dim allocatedValue As Long Ptr = New Long
Dim allocatedValues As Long Ptr = New Long[value]
Dim runtimeValue As RuntimeBase = RuntimeChild()

Print 1 + 2 * 3
Print value + 2
Print operationConstant
Print 7 Mod 3
Print 7 \ 3
Print 2 ^ 3
Print 1 Shl 2
Print 1 And 3
Print 1 Or 3
Print 1 Xor 3
Print 1 Eqv 1
Print 0 Imp 1
Print 1 AndAlso 0
Print 1 Orelse 0
Print runtimeValue Is RuntimeChild
Print -(1 + 2)
Print Not (value > 0)
Print IIf(value > 0, 1, 2.5)
Print IIf(1, 2, 3.5)
Print Combine(CLng(1) + 2, 3, value, 4)
Print callback(1, 2, value, 4, 5)
Observe 2.5, Combine(1, 2, value), value
Print **doublePointer
Print (********************chainValue).value
Print CLng(castableValue)
Print printableValue
firstAssignable = secondAssignable
Print indexedInstance[0]
Print indexedInstance[0.5]
Print smartInstance->amount
Print (@addressableInstance)->amount
Print CPtr(AddressableValue Ptr, VarPtr(addressableInstance))->amount
ObserveCopiedValue sourceCopy
ObserveByRefConstructed 9
Print CopyIntoResult(sourceCopy).value
Print (IIf(value > 0, sourceCopy, sourceCopy)).value
Print allocatedValue = allocatedValues
Print (-negativeInstance).value
ObserveCast castableValue
Delete allocatedValue
Delete[] allocatedValues

'' end of compiler-expression-operations.bas
