#!/usr/bin/env sh
# Update the very-happy daemon to the latest published CLI and restart it.
#
# Run this on a machine that hosts a daemon (e.g. mac-office) after a new
# very-happy-cli release. Idempotent.
#
#   curl -fsSL .../update-daemon.sh | sh      # or just run the file
#
# PATH note: the daemon must be able to find `claude` (and node) when it spawns
# remote sessions, so we prepend ~/.local/bin (where Claude Code installs) and
# leave the rest of the login PATH intact.

set -eu
export PATH="$HOME/.local/bin:$PATH"

echo "==> npm i -g very-happy-cli@latest"
npm i -g very-happy-cli@latest

echo "==> restart daemon"
very-happy daemon stop 2>/dev/null || true
rm -f "$HOME/.happy/daemon.state.json.lock" 2>/dev/null || true
very-happy daemon start

echo "==> status"
very-happy daemon status
