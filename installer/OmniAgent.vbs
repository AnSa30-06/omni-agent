' Omni Agent - the desktop launcher.
'
' The shortcuts point here rather than at a .cmd so that starting the app does
' not park a black console window on the user's desktop for the whole session.
' WshShell.Run with an intWindowStyle of 0 starts the Node process with no
' window at all; the app's own window is what the user sees and closes, and
' closing it stops everything (see src/ui/launch.mjs).
'
' Errors are still reachable: everything is written to the log directory, and
' "Omni Agent in a terminal" in the Start Menu runs the same thing visibly.
Option Explicit

Dim shell, fso, here, node, entry
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
node = here & "\node\node.exe"
entry = here & "\app\bin\omni-agent.mjs"

If Not fso.FileExists(node) Then
  MsgBox "Omni Agent could not find its Node runtime at:" & vbCrLf & node & vbCrLf & vbCrLf & _
         "Reinstall Omni Agent, or run ""Omni Agent in a terminal"" to see the error.", _
         vbCritical, "Omni Agent"
  WScript.Quit 1
End If

' 0 = no window, False = do not wait for it to finish.
shell.Run """" & node & """ """ & entry & """ ui", 0, False
