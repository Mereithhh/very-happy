#!/bin/bash
# Foreground wrapper used by the per-user launchd job.
set -u

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

STATE="$HOME/.happy/daemon.state.json"
LOG="$HOME/.local/state/happy/daemon-launchd.log"
mkdir -p "$(dirname "$LOG")"

# launchd appends forever. Bound this wrapper log; daemon logs have their own
# rotation under ~/.happy/logs.
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then
  : > "$LOG"
fi

if [ -f "$STATE" ]; then
  PID=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$STATE" | head -1)
  if [ -n "${PID:-}" ] && ps -p "$PID" -o command= 2>/dev/null | grep -q 'very-happy-cli'; then
    BIN=$(command -v very-happy 2>/dev/null || true)
    INSTALLED=""
    if [ -n "$BIN" ]; then
      BIN_REAL=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$BIN")
      PKG="$(dirname "$(dirname "$BIN_REAL")")/package.json"
      [ -f "$PKG" ] && INSTALLED=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PKG" | head -1)
    fi
    RUNNING=$(sed -n 's/.*"startedWithCliVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE" | head -1)
    if [ -n "$INSTALLED" ] && [ -n "$RUNNING" ] && [ "$INSTALLED" != "$RUNNING" ]; then
      echo "$(date '+%Y-%m-%dT%H:%M:%S%z') installed $INSTALLED differs from running $RUNNING; taking ownership"
      very-happy daemon stop >/dev/null 2>&1 || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        ps -p "$PID" >/dev/null 2>&1 || break
        sleep 1
      done
      ps -p "$PID" >/dev/null 2>&1 && kill "$PID" 2>/dev/null || true
    else
      echo "$(date '+%Y-%m-%dT%H:%M:%S%z') daemon already running (pid $PID, version ${RUNNING:-unknown}); leaving it alone"
      exit 0
    fi
  fi
fi

rm -f "$STATE.lock"
echo "$(date '+%Y-%m-%dT%H:%M:%S%z') starting very-happy daemon start-sync"
exec very-happy daemon start-sync
