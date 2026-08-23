#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$SCRIPT_DIR/happy-daemon-launch.sh"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/com.mereith.happy-daemon.plist"
LABEL="com.mereith.happy-daemon"

[ -x "$WRAPPER" ] || chmod +x "$WRAPPER"
mkdir -p "$PLIST_DIR" "$HOME/.local/state/happy"

python3 - "$PLIST" "$WRAPPER" "$HOME" <<'PY'
import plistlib
import sys

target, wrapper, home = sys.argv[1:]
payload = {
    "Label": "com.mereith.happy-daemon",
    "ProgramArguments": ["/bin/bash", wrapper],
    "RunAtLoad": True,
    "KeepAlive": {"SuccessfulExit": False},
    "ThrottleInterval": 30,
    "WorkingDirectory": home,
    "StandardOutPath": f"{home}/.local/state/happy/daemon-launchd.log",
    "StandardErrorPath": f"{home}/.local/state/happy/daemon-launchd.log",
}
with open(target, "wb") as stream:
    plistlib.dump(payload, stream, sort_keys=False)
PY

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state = |last exit' || true
