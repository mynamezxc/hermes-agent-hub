#!/usr/bin/env bash
# Agents Hub installer for Hermes Agent (macOS, Linux, WSL, Git Bash).
#
#   curl -fsSL https://raw.githubusercontent.com/mynamezxc/hermes-agent-hub/main/install.sh | bash
#
# Options (env vars or flags):
#   --repo <owner/repo|git url|file://path>   AGENTS_HUB_REPO   source (default mynamezxc/hermes-agent-hub)
#   --force                                   AGENTS_HUB_FORCE=1 reinstall over a copy that was not installed from git
#   --restart                                 AGENTS_HUB_RESTART=1 restart the Hermes gateway when done
set -euo pipefail

REPO="${AGENTS_HUB_REPO:-mynamezxc/hermes-agent-hub}"
FORCE="${AGENTS_HUB_FORCE:-0}"
RESTART="${AGENTS_HUB_RESTART:-0}"
NAME="agents-hub"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --restart) RESTART=1; shift ;;
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

# 4. Restart the gateway so the dashboard routes load.
if [ "$RESTART" = "1" ]; then
  say "Restarting the Hermes gateway"
  "$HERMES" gateway restart || warn "Gateway restart failed; restart it yourself (Desktop: Ctrl+K, Restart gateway)."
else
  say "Next: restart the gateway (Desktop: Ctrl+K, \"Restart gateway\"; CLI: hermes gateway restart)."
fi
say "Hermes Desktop loads the page by itself. Open Agents Hub from the sidebar or press Ctrl+Alt+H."
