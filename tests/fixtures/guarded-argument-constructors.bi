''
'' Project: FreeBASIC VS Code Language Extension tests
'' File: guarded-argument-constructors.bi
'' Purpose: Exercise physical constructor targets through include and build guards.
'' Responsibilities: provide identical-signature prototypes and bodies in alternate branches.
'' Does not contain: project settings, callers, or runtime assertions.
''

#ifndef FB_VSCODE_GUARDED_ARGUMENT_CONSTRUCTORS_BI
#define FB_VSCODE_GUARDED_ARGUMENT_CONSTRUCTORS_BI

Type GuardedArgumentValue
    value As Long
#ifdef ALTERNATE
    Declare Constructor(ByVal initial As Long)
    Declare Constructor(ByVal initial As String)
#else
    Declare Constructor(ByVal initial As Long)
    Declare Constructor(ByVal initial As String)
#endif
End Type

#ifdef ALTERNATE
Constructor GuardedArgumentValue(ByVal initial As Long)
    This.value = initial
End Constructor
Constructor GuardedArgumentValue(ByVal initial As String)
    This.value = Len(initial)
End Constructor
#else
Constructor GuardedArgumentValue(ByVal initial As Long)
    This.value = initial
End Constructor
Constructor GuardedArgumentValue(ByVal initial As String)
    This.value = Len(initial)
End Constructor
#endif

#endif

'' end of guarded-argument-constructors.bi
