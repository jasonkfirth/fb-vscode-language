' Project: FreeBASIC VS Code Language Extension Tests
' File: contextual-thread.bas
' Purpose: Distinguish contextual THREAD identifiers from THREAD LOCAL storage.
' Responsibilities: Exercise fields, namespace variables and modifier syntax.
' Does not contain: Thread creation or editor commands.

Thread Local Dim Shared perThread As Long
Type ThreadHolder
    Thread As Long
End Type
Dim holder As ThreadHolder
holder.Thread = 2
Print holder.Thread
Namespace LocalNames
    Dim Thread As Long = 3
End Namespace
Print LocalNames.Thread

' end of contextual-thread.bas
