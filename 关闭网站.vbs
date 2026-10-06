' Silent stop entry — no console window.
' Double-click this (or 关闭网站.bat) to stop the hub in the background.
Option Explicit
Dim sh, root, ps1, cmd
Set sh = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
ps1 = root & "\runtime\hub-lifecycle.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -Action stop -Quiet"
sh.Run cmd, 0, False
