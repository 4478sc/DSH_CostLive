' Windowless launcher for the CostLive host->VM sync chain (2026-11-16).
'
' Usage: wscript.exe //nologo //B launch-hidden.vbs "<repo>\tools\ensure-host-sync.ps1" [arg ...]
'
' wscript.exe is a GUI-subsystem host, so it owns no console, and
' WScript.Shell.Run(cmd, 0, False) starts powershell.exe with a hidden console.
' This is what the scheduled tasks run; the scripts it starts use
' tools\hidden-launch.ps1 (CREATE_NO_WINDOW) for their own console children.
' A/B measurement and deployment/rollback notes: docs/host-sync-windowless.md
Option Explicit
Dim sh, exe, cmd, i, target
If WScript.Arguments.Count < 1 Then
  WScript.Echo "usage: launch-hidden.vbs <script.ps1> [arg ...]"
  WScript.Quit 2
End If
Set sh = CreateObject("WScript.Shell")
exe = sh.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
target = WScript.Arguments(0)
cmd = Chr(34) & exe & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & target & Chr(34)
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & Chr(34) & WScript.Arguments(i) & Chr(34)
Next
sh.Run cmd, 0, False
