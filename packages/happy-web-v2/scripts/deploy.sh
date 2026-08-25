#!/usr/bin/env bash
# Deploy happy-web-v2 to hw-sg.
#   deploy.sh root     → build (base=/) and serve at veryhappy.dev/ (production, via happy-server /webapp)
#   deploy.sh staging  → build (base=/v2/) and serve at veryhappy.dev/v2/ (Caddy file_server)
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
SERVER_URL="${VH_SERVER_URL:-https://veryhappy.dev}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

if [ "$MODE" = "staging" ]; then
  VH_BASE=/v2/ VH_VERSION="$VERSION" VH_SERVER_URL="$SERVER_URL" pnpm exec vite build
  ssh "$HOST" 'rm -rf /opt/happy-v2.new && mkdir -p /opt/happy-v2.new'
  tar -C dist -czf - . | ssh "$HOST" 'tar -C /opt/happy-v2.new -xzf - 2>/dev/null'
  ssh "$HOST" 'cd /opt && find happy-v2 -mindepth 1 -delete 2>/dev/null; cp -a happy-v2.new/. happy-v2/ && rm -rf happy-v2.new'
  echo "staged at https://veryhappy.dev/v2/ (Caddy file_server, no restart needed)"
else
  VH_VERSION="$VERSION" VH_SERVER_URL="$SERVER_URL" pnpm exec vite build
  echo "[deploy] version=$VERSION — staging files"
  ssh "$HOST" 'rm -rf /opt/happy/webapp.new && mkdir -p /opt/happy/webapp.new'
  tar -C dist -czf - . | ssh "$HOST" 'tar -C /opt/happy/webapp.new -xzf - 2>/dev/null'
  echo "[deploy] swap + restart (re-globs @fastify/static)"
  # Swap in the new build, then merge the PREVIOUS build's hashed assets back in
  # (no-clobber; hashed names never collide) so clients still running the old
  # shell keep lazy-loading their chunks instead of hitting "Failed to fetch
  # dynamically imported module" mid-session. Prune merged assets >14d old so
  # the dir doesn't grow forever. index.html/sw.js always come from the new build.
  # (rm -rf webapp.prev first: `cp -a webapp webapp.prev` with an EXISTING prev
  # dir would nest a webapp/ subdir inside it and silently break the merge.)
  ssh "$HOST" 'cd /opt/happy && rm -rf webapp.prev && cp -a webapp webapp.prev 2>/dev/null; find webapp -mindepth 1 -delete && cp -a webapp.new/. webapp/ && rm -rf webapp.new && { cp -an webapp.prev/assets/. webapp/assets/ 2>/dev/null || true; } && find webapp/assets -type f -mtime +14 -delete 2>/dev/null; docker compose restart happy-server >/dev/null 2>&1'
  echo "[deploy] waiting for happy-server…"
  for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' https://veryhappy.dev/health || true)
    [ "$code" = "200" ] && break; sleep 1
  done
  main=$(curl -s https://veryhappy.dev/ | grep -oE '/assets/[^"]+\.js' | head -1)
  ct=$(curl -s -o /dev/null -w '%{content_type}' "https://veryhappy.dev$main")
  echo "[deploy] main asset $main → $ct"
  case "$ct" in
    *javascript*) echo "[deploy] ✓ live at https://veryhappy.dev/" ;;
    *) echo "[deploy] ✗ assets not serving as JS — check happy-server"; exit 1 ;;
  esac
fi
