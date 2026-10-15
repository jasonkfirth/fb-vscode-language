''
'' Project: FreeBASIC language extension tests
'' File: compiler-labels.bas
'' Purpose: Exercise compiler-backed label navigation and rename.
'' Responsibilities: cover direct, GOSUB, ON-branch, and error-handler labels.
'' Does not contain: runtime test assertions.
''

Option Gosub

&H10 Print "numeric label"
&H20: Print "numeric label with colon"
Gosub &H10
On 1 Goto &H10, &H20
On 2 Gosub &H10, &H20
If 1 Then &H10 Else &H20

&H30 Print "numeric label with a direct named conversion"
Goto &H30
&H40: Print "numeric label with a direct named conversion and colon"
Goto &H40

errorHandler:
On Error Goto errorHandler

dataMarker:
Data 1
Restore dataMarker

'' end of compiler-labels.bas
