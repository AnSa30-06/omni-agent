<#
.SYNOPSIS
  Set up Omni Agent from the portable distribution, or from a source checkout.

.DESCRIPTION
  Does what the EXE installer does, without installing anything system-wide:
  verifies a usable Node, installs this app's dependencies if they are missing,
  fetches the model gateway and agent into a private prefix, then runs setup.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
#>
[CmdletBinding()]
param([switch]$SkipSetup)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m) { Write-Host $m }
function Fail($m) { Write-Host ""; Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# The portable zip ships a Node runtime beside the app; a source checkout does not.
$BundledNode = Join-Path $Here 'node\node.exe'
$AppDir = if (Test-Path (Join-Path $Here 'app\bin\omni-agent.mjs')) { Join-Path $Here 'app' } else { $Here }

if (Test-Path $BundledNode) {
  $Node = $BundledNode
  Say "Using the bundled Node runtime."
} else {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Fail "Node.js is not installed and this copy has no bundled runtime.`nInstall Node 22 or newer from https://nodejs.org and run this again." }
  $Node = $cmd.Source
  $v = (& $Node --version).TrimStart('v').Split('.')[0]
  if ([int]$v -lt 22) { Fail "Node $v is too old. Omni Agent needs Node 22 or newer." }
  Say "Using Node $(& $Node --version) at $Node"
}

if (-not (Test-Path (Join-Path $AppDir 'bin\omni-agent.mjs'))) {
  Fail "Could not find the application at $AppDir. Extract the whole zip, keeping its folder structure."
}

if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) {
  Say "Installing application dependencies..."
  Push-Location $AppDir
  try { & npm install --omit=dev --no-fund --no-audit; if ($LASTEXITCODE -ne 0) { Fail "npm install failed." } }
  finally { Pop-Location }
}

Say ""
Say "Fetching the model gateway and agent (about 3 GB, one time)..."
& $Node (Join-Path $AppDir 'scripts\bootstrap.mjs')
if ($LASTEXITCODE -ne 0) { Fail "Could not download the required components. Check your network connection and disk space, then run this again." }

if (-not $SkipSetup) {
  Say ""
  & $Node (Join-Path $AppDir 'bin\omni-agent.mjs') setup
}

Say ""
Say "Done. Start it with:  .\start.bat"
