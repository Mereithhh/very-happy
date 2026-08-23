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

echo "==> resolve latest very-happy-cli version"
# Install the resolved version, not the moving @latest specifier. npm may cache
# a dist-tag lookup across an immediately-following install and otherwise report
# success while leaving the previous daemon version in place.
LATEST_VERSION=$(npm view very-happy-cli@latest version)
case "$LATEST_VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "invalid registry version: $LATEST_VERSION" >&2; exit 1 ;;
esac

echo "==> npm i -g very-happy-cli@$LATEST_VERSION"
# npm 11 blocks previously unseen install scripts unless they are allowlisted.
# These are the package's reviewed tool-unpack hook and node-pty's native
# prebuild hook; allowing only these two preserves the default deny posture.
npm i -g --allow-scripts=very-happy-cli,node-pty "very-happy-cli@$LATEST_VERSION"

INSTALLED_VERSION=$(very-happy --version)
case "$INSTALLED_VERSION" in
    *"$LATEST_VERSION"*) ;;
    *) echo "version verification failed: expected $LATEST_VERSION, got $INSTALLED_VERSION" >&2; exit 1 ;;
esac

echo "==> restart daemon"
very-happy daemon stop 2>/dev/null || true
rm -f "$HOME/.happy/daemon.state.json.lock" 2>/dev/null || true
very-happy daemon start

echo "==> status"
very-happy daemon status
