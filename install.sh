#!/usr/bin/env bash
# Agents Hub installer for Hermes Agent (macOS, Linux, WSL, Git Bash).
#
#   curl -fsSL https://raw.githubusercontent.com/mynamezxc/hermes-agent-hub/main/install.sh | bash
#
# Options (env vars or flags):
#   --repo <owner/repo|git url|file://path>   AGENTS_HUB_REPO   source (default mynamezxc/hermes-agent-hub)
#   --force                                   AGENTS_HUB_FORCE=1 reinstall over a copy that was not installed from git
#   --no-restart                              AGENTS_HUB_RESTART=0 do not restart the Hermes gateway when done
#                                             (by default it restarts after an install or update so the backend loads;
#                                             a restart interrupts agents that are running at that moment)
set -euo pipefail

REPO="${AGENTS_HUB_REPO:-mynamezxc/hermes-agent-hub}"
FORCE="${AGENTS_HUB_FORCE:-0}"
RESTART="${AGENTS_HUB_RESTART:-1}"
NAME="agents-hub"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --restart) RESTART=1; shift ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Hermes must already be installed.
HERMES="${HERMES_BIN:-$(command -v hermes || true)}"
if [ -z "$HERMES" ]; then
  for cand in "$HOME/.hermes/bin/hermes" "$HOME/.local/bin/hermes" "${LOCALAPPDATA:-}/hermes/bin/hermes.exe"; do
    [ -n "$cand" ] && [ -x "$cand" ] && HERMES="$cand" && break
  done
fi
[ -n "$HERMES" ] || die "Hermes Agent was not found. Install it first: https://hermes-agent.nousresearch.com/docs (then re-run this script)."

VERSION="$("$HERMES" --version 2>/dev/null | head -n 1 || true)"
[ -n "$VERSION" ] || die "'$HERMES --version' failed. Is the Hermes install healthy? Try 'hermes doctor'."
say "Found $VERSION"

# 2. Install, or update an existing git install.
LISTING="$("$HERMES" plugins list 2>/dev/null || true)"
ROW="$(printf '%s\n' "$LISTING" | grep -E "[│| ]$NAME[ │|]" | head -n 1 || true)"

if [ -z "$ROW" ]; then
  say "Installing $NAME from $REPO"
  "$HERMES" plugins install "$REPO" --enable --yes-deps
elif printf '%s' "$ROW" | grep -q "git"; then
  say "$NAME is already installed from git: updating"
  "$HERMES" plugins update "$NAME" || die "Update failed. Re-run with --force to reinstall."
  "$HERMES" plugins enable "$NAME" >/dev/null 2>&1 || true
elif [ "$FORCE" = "1" ]; then
  say "Replacing the existing $NAME with $REPO (--force)"
  "$HERMES" plugins install "$REPO" --enable --yes-deps --force
else
  warn "$NAME is already installed but not from git (a local copy). Left untouched."
  warn "Re-run with --force to replace it with $REPO."
  exit 0
fi

# 3. Verify.
"$HERMES" plugins list 2>/dev/null | grep -E "[│| ]$NAME[ │|]" | grep -q "enabled" \
  || die "$NAME did not end up enabled. Check: hermes plugins list"
say "$NAME is installed and enabled"

# 4. Restart the gateway so the new backend loads (the page reloads by itself, the backend does not).
if [ "$RESTART" = "1" ]; then
  say "Restarting the Hermes gateway so the Agents Hub backend loads (running agents are interrupted)"
  if "$HERMES" gateway restart; then
    say "Gateway restarted"
  else
    warn "Gateway restart failed; restart it yourself (Desktop: Ctrl+K, Restart gateway)."
  fi
else
  say "Next: restart the gateway (Desktop: Ctrl+K, \"Restart gateway\"; CLI: hermes gateway restart)."
fi
say "Then, ONCE, turn on the desktop half: Hermes Desktop > Settings > Plugins (or Capabilities > Plugins) > Agents Hub > Desktop on."
say "  (Desktop keeps a package's desktop half off until you enable it; --enable only covers the agent half."
say "   Installing from Hermes Desktop itself - Plugins > Install from Git - switches both halves on.)"
say "Open Agents Hub from the sidebar or press Ctrl+Alt+H. Not there? Ctrl+K > Reload desktop plugins."
