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

# npm i -g can fail with EEXIST on the bin symlinks IT created itself: when
# cleanup of the previous global tree fails first, the old links survive and
# npm refuses to overwrite them. Observed on mac-office 2026-09-04 upgrading
# 0.2.115 -> 0.2.116 — `ENOTEMPTY: rmdir .../very-happy-cli/tools` (the
# tool-unpack postinstall writes files npm does not track), then EEXIST on
# `very-happy`, twice in a row; removing the two links made the very same
# command succeed. So clear them first: only links that resolve INTO our own
# tree, so a same-named binary someone else owns is never touched. Idempotent —
# npm recreates them, and a missing link is the normal first-install state.
NPM_BIN_DIR="$(npm prefix -g)/bin"
for b in very-happy very-happy-mcp; do
    link="$NPM_BIN_DIR/$b"
    [ -L "$link" ] || continue
    target="$(readlink "$link")"
    case "$target" in
        *very-happy-cli/bin/*) echo "==> unlink $link (npm will relink it)"; rm -f "$link" ;;
        *) echo "==> leaving $link alone (points at $target)" ;;
    esac
done

echo "==> npm i -g very-happy-cli@$LATEST_VERSION"
# npm 11 blocks previously unseen install scripts unless they are allowlisted.
# These are the package's reviewed tool-unpack hook and node-pty's native
# prebuild hook; allowing only these two preserves the default deny posture.
install_cli() {
    npm i -g --allow-scripts=very-happy-cli,node-pty "very-happy-cli@$LATEST_VERSION"
}

# B-348: npm leaves a half-written tree often enough that recovering from it by
# hand has become routine — twice on 2026-09-03 alone, once as
# `ENOTEMPTY: rmdir .../node_modules/@modelcontextprotocol` and once as a
# postinstall that could not find a script npm had not written yet. Retrying npm
# on top of that tree fails the same way every time; the documented recovery
# (docs/operations.md) is to delete the package and install it fresh, which is
# what this now does on its own instead of stopping and waiting for a person.
#
# The removal is deliberately narrow: one package directory under the global
# root, only after an install has already failed, and never the root itself.
if ! install_cli; then
    PACKAGE_DIR="$(npm root -g)/very-happy-cli"
    echo "==> install failed; removing $PACKAGE_DIR and retrying once" >&2
    case "$PACKAGE_DIR" in
        */node_modules/very-happy-cli) rm -rf "$PACKAGE_DIR" ;;
        *) echo "refusing to remove unexpected path: $PACKAGE_DIR" >&2; exit 1 ;;
    esac
    install_cli
fi

INSTALLED_VERSION=$(very-happy --version)
case "$INSTALLED_VERSION" in
    *"$LATEST_VERSION"*) ;;
    *) echo "version verification failed: expected $LATEST_VERSION, got $INSTALLED_VERSION" >&2; exit 1 ;;
esac

echo "==> hand over to the new daemon"
# B-321: `daemon start` is the idempotent, version- and endpoint-aware handover:
# it stops a mismatched daemon itself and exits quietly if one already matches.
# The old `stop` + `rm lock` + `start` sequence is what iron rule 7 warns
# against — it takes the machine offline first, so any failure after that point
# leaves it offline, and a handed-over daemon runs outside launchd where nothing
# will restart it. Removing the lock file by hand was part of the same pattern:
# it exists to stop two daemons racing, and deleting it defeats that.
very-happy daemon start

echo "==> status"
very-happy daemon status
