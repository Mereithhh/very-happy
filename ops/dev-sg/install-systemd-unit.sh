#!/usr/bin/env bash
# Install or refresh the very-happy daemon systemd USER unit on a Linux daemon
# host (dev-sg). Idempotent; safe while the daemon is running — the new unit
# settings apply on the next start/restart. Does NOT restart the daemon.
#
#   bash ops/dev-sg/install-systemd-unit.sh            # install + daemon-reload
#   bash ops/dev-sg/install-systemd-unit.sh --check    # diff only, exit 1 if stale
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/very-happy-daemon.service"
DST="$HOME/.config/systemd/user/very-happy-daemon.service"

if [ "${1:-}" = "--check" ]; then
    if [ -f "$DST" ] && cmp -s "$SRC" "$DST"; then
        echo "unit up to date: $DST"; exit 0
    fi
    echo "unit differs from $SRC:" >&2
    diff -u "$DST" "$SRC" >&2 || true
    exit 1
fi

command -v systemctl >/dev/null || { echo "systemctl not found; this host is not systemd-managed" >&2; exit 1; }
[ -x /usr/bin/very-happy ] || echo "warning: /usr/bin/very-happy missing — install very-happy-cli globally first" >&2
mkdir -p "$(dirname "$DST")" "$HOME/.local/state/happy"
install -m 0644 "$SRC" "$DST"
systemctl --user daemon-reload
systemctl --user enable very-happy-daemon >/dev/null
echo "installed $DST"
systemctl --user show very-happy-daemon -p KillMode -p Restart -p RestartUSec -p ActiveState
echo "apply to the running daemon with: systemctl --user restart very-happy-daemon (wrappers survive; see ops/dev-sg/README.md)"
