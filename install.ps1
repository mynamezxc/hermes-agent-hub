# Agents Hub installer for Hermes Agent (Windows PowerShell 5.1+ / PowerShell 7).
#
#   irm https://raw.githubusercontent.com/mynamezxc/hermes-agent-hub/main/install.ps1 | iex
#
# Options when run as a file:  .\install.ps1 [-Repo owner/repo|git-url|file://C:/path] [-Force] [-NoRestart]
# Options when piped into iex: $env:AGENTS_HUB_REPO, $env:AGENTS_HUB_FORCE='1', $env:AGENTS_HUB_RESTART='0'
# By default the gateway is restarted after an install or update so the backend loads (running agents are
# interrupted); opt out with -NoRestart / $env:AGENTS_HUB_RESTART='0'.
#
# Kept iex-safe on purpose: ASCII only, no BOM, no top-level param() block, and no 'exit'
# (under iex 'exit' would close the user's PowerShell window).

function Install-AgentsHub {
  param(
    [string]$Repo = 'mynamezxc/hermes-agent-hub',
    [switch]$Force,
    [bool]$Restart = $true
  )
  $ErrorActionPreference = 'Stop'
  $Name = 'agents-hub'
  $Bar = [string][char]0x2502   # the box-drawing column separator in 'hermes plugins list'

  function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
  function Warn($m) { Write-Host "!! $m" -ForegroundColor Yellow }
  function Fail($m) { Write-Host "xx $m" -ForegroundColor Red }
  function Find-Row($text) {
    $pattern = "[$Bar| ]$([regex]::Escape($Name))[ $Bar|]"
    $text -split "`n" | Where-Object { $_ -match $pattern } | Select-Object -First 1
  }

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
  if (-not $Hermes) {
    Fail 'Hermes Agent was not found. Install it first: https://hermes-agent.nousresearch.com/docs (then re-run this script).'
    return $false
  }

  $Version = (& $Hermes --version 2>$null | Select-Object -First 1)
  if (-not $Version) {
    Fail "'hermes --version' failed. Is the Hermes install healthy? Try 'hermes doctor'."
    return $false
  }
  Say "Found $Version"

  # 2. Install, or update an existing git install.
  $Row = Find-Row ((& $Hermes plugins list 2>$null) -join "`n")

  if (-not $Row) {
    Say "Installing $Name from $Repo"
    & $Hermes plugins install $Repo --enable --yes-deps
    if ($LASTEXITCODE -ne 0) { Fail 'Install failed (see the output above).'; return $false }
  } elseif ($Row -match 'git') {
    Say "$Name is already installed from git: updating"
    & $Hermes plugins update $Name
    if ($LASTEXITCODE -ne 0) { Fail 'Update failed. Re-run with -Force (or $env:AGENTS_HUB_FORCE=''1'') to reinstall.'; return $false }
    & $Hermes plugins enable $Name *> $null
  } elseif ($Force) {
    Say "Replacing the existing $Name with $Repo (-Force)"
    & $Hermes plugins install $Repo --enable --yes-deps --force
    if ($LASTEXITCODE -ne 0) { Fail 'Install failed (see the output above).'; return $false }
  } else {
    Warn "$Name is already installed but not from git (a local copy). Left untouched."
    Warn "Re-run with -Force (or `$env:AGENTS_HUB_FORCE='1') to replace it with $Repo."
    return $true
  }

  # 3. Verify.
  $Ok = Find-Row ((& $Hermes plugins list 2>$null) -join "`n")
  if (-not $Ok -or $Ok -notmatch 'enabled') {
    Fail "$Name did not end up enabled. Check: hermes plugins list"
    return $false
  }
  Say "$Name is installed and enabled"

  # 4. Restart the gateway so the new backend loads (the page reloads by itself, the backend does not).
  if ($Restart) {
    Say 'Restarting the Hermes gateway so the Agents Hub backend loads (running agents are interrupted)'
    & $Hermes gateway restart
    if ($LASTEXITCODE -ne 0) { Warn 'Gateway restart failed; restart it yourself (Desktop: Ctrl+K, Restart gateway).' } else { Say 'Gateway restarted' }
  } else {
    Say 'Next: restart the gateway (Desktop: Ctrl+K, "Restart gateway"; CLI: hermes gateway restart).'
  }
  Say 'Then, ONCE, turn on the desktop half: Hermes Desktop > Settings > Plugins (or Capabilities > Plugins) > Agents Hub > Desktop on.'
  Say '  (Desktop keeps a package''s desktop half off until you enable it; --enable only covers the agent half.'
  Say '   Installing from Hermes Desktop itself - Plugins > Install from Git - switches both halves on.)'
  Say 'Open Agents Hub from the sidebar or press Ctrl+Alt+H. Not there? Ctrl+K > Reload desktop plugins.'
  return $true
}

# Options: script arguments when run as a file, environment variables when piped into iex.
$AhOpts = @{}
if ($env:AGENTS_HUB_REPO) { $AhOpts.Repo = $env:AGENTS_HUB_REPO }
if ($env:AGENTS_HUB_FORCE -eq '1') { $AhOpts.Force = $true }
if ($env:AGENTS_HUB_RESTART -eq '0') { $AhOpts.Restart = $false }
$AhArgs = @($args)
for ($i = 0; $i -lt $AhArgs.Count; $i++) {
  switch -Regex ([string]$AhArgs[$i]) {
    '^-Repo$' { $i++; if ($i -lt $AhArgs.Count) { $AhOpts.Repo = [string]$AhArgs[$i] } }
    '^-Force$' { $AhOpts.Force = $true }
    '^-Restart$' { $AhOpts.Restart = $true }
    '^-NoRestart$' { $AhOpts.Restart = $false }
    default { Write-Host "!! Unknown option: $($AhArgs[$i])" -ForegroundColor Yellow }
  }
}
$null = Install-AgentsHub @AhOpts
