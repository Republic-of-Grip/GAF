#Requires -Version 5.1
<#
.SYNOPSIS
  Launch Helium in GAF Debug mode — separate profile + full Chrome DevTools Protocol (CDP).

.DESCRIPTION
  Daily Helium stays untouched (default User Data).
  This starts a second instance with:
    - dedicated user-data-dir
    - --remote-debugging-port (real /json/version CDP)
    - --load-extension for unpacked GAF

.PARAMETER Port
  CDP port (default 9333).

.PARAMETER Url
  Optional start URL.

.PARAMETER NoExtension
  Skip --load-extension.

.PARAMETER KillExisting
  Stop processes using this debug user-data-dir, then relaunch.

.PARAMETER ProbeOnly
  Only check whether CDP responds.
#>

[CmdletBinding()]
param(
  [int]$Port = 9333,
  [string]$Url = 'helium://extensions',
  [switch]$NoExtension,
  [switch]$KillExisting,
  [switch]$ProbeOnly
)

$ErrorActionPreference = 'Stop'

function Find-HeliumExe {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'imput\Helium\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Helium\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles} 'Helium\Application\chrome.exe')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) {
      return (Resolve-Path -LiteralPath $p).Path
    }
  }
  $proc = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -match 'Helium|imput' } |
    Select-Object -First 1
  if ($proc -and $proc.ExecutablePath -and (Test-Path -LiteralPath $proc.ExecutablePath)) {
    return $proc.ExecutablePath
  }
  return $null
}

function Test-CdpAlive {
  param([int]$CdpPort)
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/json/version" -f $CdpPort) -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200 -and $r.Content -match 'webSocketDebuggerUrl|Browser')
  } catch {
    return $false
  }
}

function Get-CdpVersion {
  param([int]$CdpPort)
  try {
    return (Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/json/version" -f $CdpPort) -UseBasicParsing -TimeoutSec 2).Content
  } catch {
    return $null
  }
}

function Write-EnvHelper {
  param([int]$CdpPort, [string]$Path)
  $lines = @(
    '# Dot-source before browser-use:'
    '#   . $env:LOCALAPPDATA\Helium-GAF-Debug\set-cdp-env.ps1'
    ('$env:BU_CDP_URL = ''http://127.0.0.1:{0}''' -f $CdpPort)
    ('$env:PATH = ''{0};'' + $env:PATH' -f (Join-Path $env:USERPROFILE '.local\bin'))
    'Write-Host (''BU_CDP_URL='' + $env:BU_CDP_URL)'
  )
  Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

# --- paths ---
$HeliumExe = Find-HeliumExe
if (-not $HeliumExe) {
  Write-Error 'Helium chrome.exe not found. Install Helium or edit Find-HeliumExe.'
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GafRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$UserData = Join-Path $env:LOCALAPPDATA 'Helium-GAF-Debug\User Data'
$LogDir = Join-Path $env:LOCALAPPDATA 'Helium-GAF-Debug\logs'
New-Item -ItemType Directory -Force -Path $UserData | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host ''
Write-Host '  Helium GAF Debug launcher' -ForegroundColor Cyan
Write-Host '  =========================' -ForegroundColor Cyan
Write-Host ('  Binary     : {0}' -f $HeliumExe)
Write-Host ('  Profile    : {0}' -f $UserData)
Write-Host ('  GAF path   : {0}' -f $GafRoot)
Write-Host ('  CDP port   : {0}' -f $Port)
Write-Host ('  Start URL  : {0}' -f $Url)
Write-Host ''

if ($ProbeOnly) {
  if (Test-CdpAlive -CdpPort $Port) {
    Write-Host ('  CDP OK on :{0}' -f $Port) -ForegroundColor Green
    Write-Host (Get-CdpVersion -CdpPort $Port)
    exit 0
  }
  Write-Host ('  CDP not responding on :{0}' -f $Port) -ForegroundColor Yellow
  exit 1
}

# Already running with real CDP?
if (Test-CdpAlive -CdpPort $Port) {
  Write-Host ('  CDP already alive on :{0} - reusing instance.' -f $Port) -ForegroundColor Green
  Write-Host (Get-CdpVersion -CdpPort $Port)
  Write-Host ''
  Write-Host '  Connect browser-use with:' -ForegroundColor Cyan
  Write-Host ('    $env:BU_CDP_URL = "http://127.0.0.1:{0}"' -f $Port)
  Write-Host '    browser-use'
  Write-Host ''
  if ($Url -and $Url.Trim().Length -gt 0) {
    $escaped = [uri]::EscapeDataString($Url)
    $newUrl = 'http://127.0.0.1:{0}/json/new?{1}' -f $Port, $escaped
    try {
      Invoke-WebRequest -Uri $newUrl -UseBasicParsing -TimeoutSec 3 -Method Put | Out-Null
      Write-Host ('  Opened: {0}' -f $Url) -ForegroundColor Green
    } catch {
      try {
        Invoke-WebRequest -Uri $newUrl -UseBasicParsing -TimeoutSec 3 | Out-Null
        Write-Host ('  Opened: {0}' -f $Url) -ForegroundColor Green
      } catch {
        Write-Host '  Could not open URL via CDP; navigate manually in the debug window.' -ForegroundColor Yellow
      }
    }
  }
  exit 0
}

if ($KillExisting) {
  Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like ('*{0}*' -f $UserData)) } |
    ForEach-Object {
      Write-Host ('  Stopping PID {0} (debug profile)...' -f $_.ProcessId) -ForegroundColor Yellow
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Seconds 1
}

# Seed Preferences for extension developer mode (first run only)
$defaultDir = Join-Path $UserData 'Default'
New-Item -ItemType Directory -Force -Path $defaultDir | Out-Null
$prefsPath = Join-Path $defaultDir 'Preferences'
if (-not (Test-Path -LiteralPath $prefsPath)) {
  $seedObj = [ordered]@{
    extensions   = @{ ui = @{ developer_mode = $true } }
    browser      = @{ has_seen_welcome_page = $true; check_default_browser = $false }
    distribution = @{ import_bookmarks = $false; skip_first_run_ui = $true }
  }
  $seedObj | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $prefsPath -Encoding UTF8
}

$argList = New-Object System.Collections.Generic.List[string]
$argList.Add(('--user-data-dir={0}' -f $UserData))
$argList.Add(('--remote-debugging-port={0}' -f $Port))
$argList.Add('--no-first-run')
$argList.Add('--no-default-browser-check')
$argList.Add('--disable-features=TranslateUI')
$argList.Add('--password-store=basic')

if (-not $NoExtension) {
  $manifest = Join-Path $GafRoot 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifest)) {
    Write-Error ("GAF manifest.json not found at {0}" -f $GafRoot)
  }
  # Load GAF unpacked. Do NOT use --disable-extensions-except: it strips Helium's
  # bundled blockers and has been flaky when daily Helium is also running.
  $argList.Add(('--load-extension={0}' -f $GafRoot))
}

if ($Url -and $Url.Trim().Length -gt 0) {
  $argList.Add($Url)
}

Write-Host '  Starting Helium GAF Debug...' -ForegroundColor Cyan
$proc = Start-Process -FilePath $HeliumExe -ArgumentList $argList.ToArray() -PassThru
Write-Host ('  PID {0}' -f $proc.Id) -ForegroundColor Green

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-CdpAlive -CdpPort $Port) {
    $ok = $true
    break
  }
}

Write-Host ''
if ($ok) {
  Write-Host ('  CDP READY  http://127.0.0.1:{0}' -f $Port) -ForegroundColor Green
  $ver = Get-CdpVersion -CdpPort $Port
  if ($ver) { Write-Host ('  {0}' -f $ver) }
  Write-Host ''
  Write-Host '  Daily Helium  : normal profile (untouched)' -ForegroundColor DarkGray
  Write-Host '  Debug Helium  : this window (GAF + CDP)' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  browser-use:' -ForegroundColor Cyan
  Write-Host ('    $env:PATH = "{0};$env:PATH"' -f (Join-Path $env:USERPROFILE '.local\bin'))
  Write-Host ('    $env:BU_CDP_URL = "http://127.0.0.1:{0}"' -f $Port)
  Write-Host '    browser-use --doctor'
  Write-Host ''
  Write-Host '  First load: confirm GAF on helium://extensions (Developer mode).' -ForegroundColor Yellow
  Write-Host ('  If missing: Load unpacked -> {0}' -f $GafRoot) -ForegroundColor Yellow
  Write-Host ''
  $envHelper = Join-Path $env:LOCALAPPDATA 'Helium-GAF-Debug\set-cdp-env.ps1'
  Write-EnvHelper -CdpPort $Port -Path $envHelper
  Write-Host ('  Env helper : {0}' -f $envHelper) -ForegroundColor DarkGray
  exit 0
}

Write-Host ('  CDP did not come up on :{0} within ~10s.' -f $Port) -ForegroundColor Red
Write-Host '  Check the port is free and Helium started a window.' -ForegroundColor Yellow
Write-Host ('  Probe later: .\helium-gaf-debug.ps1 -ProbeOnly -Port {0}' -f $Port) -ForegroundColor Yellow
exit 1
