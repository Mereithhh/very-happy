#!/usr/bin/env bash
# Deploy happy-web-v2 to hw-sg.
#   deploy.sh root     → build (base=/) and serve at happy.mereith.com/ (production, via happy-server /webapp)
#   deploy.sh staging  → build (base=/v2/) and serve at happy.mereith.com/v2/ (Caddy file_server)
#
# CRITICAL ORDERING (learned the hard way): happy-server's @fastify/static globs
# the webapp dir at STARTUP (wildcard:false), so newly-hashed asset files have no
# route until a restart. If a browser loads during the swap→restart window, Caddy
# serves index.html for /assets/* WITH immutable cache headers → the browser caches
# HTML-as-JS for a year and the app is permanently broken for that client.
# Mitigations baked in: (1) bump VH_VERSION every release so asset URLs are salted
# and a poisoned cache can't survive a redeploy; (2) swap → restart → VERIFY assets
# serve as JS before anyone loads.
set -euo pipefail

HOST=hw-sg
MODE="${1:-root}"
VERSION="${VH_VERSION:-$(date +%Y%m%d%H%M)}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

if [ "$MODE" = "staging" ]; then
  VH_BASE=/v2/ VH_VERSION="$VERSION" pnpm exec vite build
  ssh "$HOST" 'rm -rf /opt/happy-v2.new && mkdir -p /opt/happy-v2.new'
  tar -C dist -czf - . | ssh "$HOST" 'tar -C /opt/happy-v2.new -xzf - 2>/dev/null'
  ssh "$HOST" 'cd /opt && find happy-v2 -mindepth 1 -delete 2>/dev/null; cp -a happy-v2.new/. happy-v2/ && rm -rf happy-v2.new'
  echo "staged at https://happy.mereith.com/v2/ (Caddy file_server, no restart needed)"
else
  VH_VERSION="$VERSION" pnpm exec vite build
  echo "[deploy] version=$VERSION — staging files"
  ssh "$HOST" 'rm -rf /opt/happy/webapp.new && mkdir -p /opt/happy/webapp.new'
  tar -C dist -czf - . | ssh "$HOST" 'tar -C /opt/happy/webapp.new -xzf - 2>/dev/null'
  echo "[deploy] swap + restart (re-globs @fastify/static)"
  ssh "$HOST" 'cd /opt/happy && cp -a webapp webapp.prev 2>/dev/null; find webapp -mindepth 1 -delete && cp -a webapp.new/. webapp/ && rm -rf webapp.new && docker compose restart happy-server >/dev/null 2>&1'
  echo "[deploy] waiting for happy-server…"
  for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' https://happy.mereith.com/health || true)
    [ "$code" = "200" ] && break; sleep 1
  done
  main=$(curl -s https://happy.mereith.com/ | grep -oE '/assets/[^"]+\.js' | head -1)
  ct=$(curl -s -o /dev/null -w '%{content_type}' "https://happy.mereith.com$main")
  echo "[deploy] main asset $main → $ct"
  case "$ct" in
    *javascript*) echo "[deploy] ✓ live at https://happy.mereith.com/" ;;
    *) echo "[deploy] ✗ assets not serving as JS — check happy-server"; exit 1 ;;
  esac
fi
