<#
  Agents Hub installer for Hermes Agent (Windows PowerShell 5.1+ / PowerShell 7).

    irm https://raw.githubusercontent.com/mynamezxc/hermes-agent-hub/main/install.ps1 | iex

  Options: -Repo <owner/repo | git url | file:///path>  -Force  -Restart
  (or env vars AGENTS_HUB_REPO, AGENTS_HUB_FORCE=1, AGENTS_HUB_RESTART=1 when piped through iex)
#>
param(
  [string]$Repo = $(if ($env:AGENTS_HUB_REPO) { $env:AGENTS_HUB_REPO } else { 'mynamezxc/hermes-agent-hub' }),
  [switch]$Force = ($env:AGENTS_HUB_FORCE -eq '1'),
  [switch]$Restart = ($env:AGENTS_HUB_RESTART -eq '1')
)
$ErrorActionPreference = 'Stop'
$Name = 'agents-hub'

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "xx $m" -ForegroundColor Red; exit 1 }

# 1. Hermes must already be installed.
$Hermes = $env:HERMES_BIN
if (-not $Hermes) {
  $cmd = Get-Command hermes -ErrorAction SilentlyContinue
  if ($cmd) { $Hermes = $cmd.Source }
}
if (-not $Hermes) {
  foreach ($c in @("$env:LOCALAPPDATA\hermes\bin\hermes.exe", "$env:USERPROFILE\.hermes\bin\hermes.exe")) {
    if (Test-Path $c) { $Hermes = $c; break }
  }
}
if (-not $Hermes) { Die 'Hermes Agent was not found. Install it first: https://hermes-agent.nousresearch.com/docs (then re-run this script).' }

$Version = (& $Hermes --version 2>$null | Select-Object -First 1)
if (-not $Version) { Die "'hermes --version' failed. Is the Hermes install healthy? Try 'hermes doctor'." }
Say "Found $Version"

# 2. Install, or update an existing git install.
$Listing = (& $Hermes plugins list 2>$null) -join "`n"
$Row = ($Listing -split "`n" | Where-Object { $_ -match "[│| ]$([regex]::Escape($Name))[ │|]" } | Select-Object -First 1)

if (-not $Row) {
  Say "Installing $Name from $Repo"
  & $Hermes plugins install $Repo --enable --yes-deps
  if ($LASTEXITCODE -ne 0) { Die 'Install failed (see the output above).' }
} elseif ($Row -match 'git') {
  Say "$Name is already installed from git: updating"
  & $Hermes plugins update $Name
  if ($LASTEXITCODE -ne 0) { Die 'Update failed. Re-run with -Force to reinstall.' }
  & $Hermes plugins enable $Name *> $null
} elseif ($Force) {
  Say "Replacing the existing $Name with $Repo (-Force)"
  & $Hermes plugins install $Repo --enable --yes-deps --force
  if ($LASTEXITCODE -ne 0) { Die 'Install failed (see the output above).' }
} else {
  Warn "$Name is already installed but not from git (a local copy). Left untouched."
  Warn "Re-run with -Force to replace it with $Repo."
  exit 0
}

# 3. Verify.
$After = (& $Hermes plugins list 2>$null) -join "`n"
$Ok = $After -split "`n" | Where-Object { $_ -match "[│| ]$([regex]::Escape($Name))[ │|]" -and $_ -match 'enabled' }
if (-not $Ok) { Die "$Name did not end up enabled. Check: hermes plugins list" }
Say "$Name is installed and enabled"

# 4. Restart the gateway so the dashboard routes load.
if ($Restart) {
  Say 'Restarting the Hermes gateway'
  & $Hermes gateway restart
  if ($LASTEXITCODE -ne 0) { Warn 'Gateway restart failed; restart it yourself (Desktop: Ctrl+K, Restart gateway).' }
} else {
  Say 'Next: restart the gateway (Desktop: Ctrl+K, "Restart gateway"; CLI: hermes gateway restart).'
}
Say 'Hermes Desktop loads the page by itself. Open Agents Hub from the sidebar or press Ctrl+Alt+H.'
