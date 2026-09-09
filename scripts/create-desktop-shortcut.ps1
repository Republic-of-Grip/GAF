#Requires -Version 5.1
<#
  Creates a Desktop shortcut: "Helium GAF Debug"
#>
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = Join-Path $ScriptDir "helium-gaf-debug.cmd"
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "Helium GAF Debug.lnk"

$Wsh = New-Object -ComObject WScript.Shell
$Sc = $Wsh.CreateShortcut($ShortcutPath)
$Sc.TargetPath = $Target
$Sc.WorkingDirectory = $ScriptDir
$Sc.WindowStyle = 1
$Sc.Description = "Helium with separate profile + full CDP for GAF testing (port 9333)"
# Prefer Helium icon if present
$icon = "$env:LOCALAPPDATA\imput\Helium\Application\chrome.exe"
if (Test-Path $icon) { $Sc.IconLocation = "$icon,0" }
$Sc.Save()

Write-Host "Created: $ShortcutPath" -ForegroundColor Green
