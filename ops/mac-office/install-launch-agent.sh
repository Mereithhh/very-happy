#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/share/very-happy/ops"
WRAPPER="$INSTALL_DIR/happy-daemon-launch.sh"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/com.mereith.happy-daemon.plist"
LABEL="com.mereith.happy-daemon"

# Installation is a supervision change. Refuse to race an existing daemon.
python3 - "$HOME/.happy/daemon.state.json" <<'CHECK'
import json, os, sys
try:
    state = json.load(open(sys.argv[1]))
except FileNotFoundError:
    state = {}
pid = state.get("pid")
if isinstance(pid, int) and pid > 0:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass
    else:
        sys.exit("Daemon is alive. Use the documented handover/re-adopt procedure and explicitly stop it before reinstalling launchd support.")
CHECK
# Pin Node's real bin directory, never an ephemeral fnm_multishells path.
NODE_BIN=$(command -v node)
STABLE_NODE_DIR=$(python3 -c 'import os,sys; print(os.path.dirname(os.path.realpath(sys.argv[1])))' "$NODE_BIN")
mkdir -p "$INSTALL_DIR"
install -m 755 "$SCRIPT_DIR/happy-daemon-launch.sh" "$WRAPPER"
printf '%s\n' "$STABLE_NODE_DIR" > "$INSTALL_DIR/node-bin-dir"
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
launchctl kickstart "gui/$(id -u)/$LABEL"
launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state = |last exit' || true
