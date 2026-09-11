#Requires -Version 5.1
<#
.SYNOPSIS
  Restart Helium GAF Debug with latest unpacked GAF from disk.
  Prints reminder to Reload GAF in daily Helium too.
#>
param([string]$Url = 'about:blank')
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GafRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$Port = 9333
$HeliumExe = Join-Path $env:LOCALAPPDATA 'imput\Helium\Application\chrome.exe'
$UserData = Join-Path $env:LOCALAPPDATA 'Helium-GAF-Debug\User Data'

if (-not (Test-Path $HeliumExe)) { throw "Helium not found: $HeliumExe" }
$ver = (Get-Content (Join-Path $GafRoot 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Host "  GAF dual-browser update" -ForegroundColor Cyan
Write-Host "  =======================" -ForegroundColor Cyan
Write-Host "  Version    : $ver"
Write-Host "  Source     : $GafRoot"
Write-Host ""

Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like '*Helium-GAF-Debug*') } |
  ForEach-Object {
    Write-Host ("  Stopping debug PID {0}" -f $_.ProcessId) -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 1

New-Item -ItemType Directory -Force -Path $UserData | Out-Null
$args = @(
  "--user-data-dir=$UserData",
  "--remote-debugging-port=$Port",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
  "--load-extension=$GafRoot",
  $Url
)
$p = Start-Process -FilePath $HeliumExe -ArgumentList $args -PassThru
Write-Host ("  Debug Helium started PID {0} (always latest files)" -f $p.Id) -ForegroundColor Green
Write-Host ""
Write-Host "  Daily Helium (required after every GAF change):" -ForegroundColor Yellow
Write-Host "    1. Open helium://extensions"
Write-Host "    2. Developer mode ON"
Write-Host "    3. GAF card -> Reload  (version must be $ver)"
Write-Host "    4. Open GAF popup, toggle master switch — icon must change green <-> grey/slash"
Write-Host ""
