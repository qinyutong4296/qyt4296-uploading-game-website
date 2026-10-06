' Run a command with no console window (window style 0).
' Usage: wscript //nologo run-hidden.vbs <exe> [args...]
Option Explicit
If WScript.Arguments.Count < 1 Then WScript.Quit 1

Dim sh, cmd, i, arg
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If InStr(arg, " ") > 0 Or InStr(arg, """") > 0 Then
    cmd = cmd & " """ & Replace(arg, """", """""") & """"
  Else
    cmd = cmd & " " & arg
  End If
Next
' 0 = hidden, True = wait until finished
sh.Run Trim(cmd), 0, True
WScript.Quit 0
