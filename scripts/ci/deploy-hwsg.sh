#!/usr/bin/env bash
# CI deploy to hw-sg (web + server). Ported from the local deploy.sh so GitHub
# Actions can run it. Triggered manually (workflow_dispatch).
#
# Env (provided by the workflow from repo secrets):
#   HWSG_HOST HWSG_PORT HWSG_USER   SSH target
#   SSH_KEY                         path to the private key file
# Arg: target = web | server | all
#
# Targets:
#   server  sync packages/happy-server/{sources,prisma/migrations} to
#           /opt/happy-src → docker compose restart (bind-mount + migrations)
#   web     expo export → patch index.html → push /opt/happy/webapp → restart
#
# NOTE: changing .env (e.g. VAPID/invite/secrets) still needs a manual
# `docker compose up -d` on the box — restart doesn't re-read env_file.

set -euo pipefail
TARGET="${1:-all}"
SSH_OPTS="-i ${SSH_KEY} -p ${HWSG_PORT} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
REMOTE="${HWSG_USER}@${HWSG_HOST}"
ssh_x() { ssh ${SSH_OPTS} "${REMOTE}" "$@"; }

APP="packages/happy-app"
SERVER="packages/happy-server"

wait_health() {
    local c=000
    for _ in $(seq 1 20); do
        c=$(curl -s -o /dev/null -w "%{http_code}" https://happy.mereith.com/health 2>/dev/null || echo 000)
        [ "$c" = "200" ] && break; sleep 3
    done
    echo "  health: $c"
    [ "$c" = "200" ]
}

deploy_server() {
    echo "== server: sync source → /opt/happy-src =="
    tar czf - -C "$SERVER" sources prisma/migrations \
        | ssh_x 'tar xzf - -C /opt/happy-src/packages/happy-server'
    echo "== server: restart =="
    ssh_x 'cd /opt/happy && docker compose restart happy-server >/dev/null 2>&1'
    wait_health
}

deploy_web() {
    echo "== web: export =="
    ( cd "$APP" && rm -rf dist && APP_ENV=production pnpm exec expo export -p web >/dev/null )
    [ -f "$APP/dist/index.html" ] || { echo "  ERROR: no dist/index.html"; exit 1; }
    node scripts/ci/patch-index.mjs "$APP/dist/index.html"
    echo "== web: push → /opt/happy/webapp =="
    ssh_x 'rm -rf /opt/happy/webapp && mkdir -p /opt/happy/webapp'
    tar czf - -C "$APP/dist" . | ssh_x 'tar xzf - -C /opt/happy/webapp'
    ssh_x 'cd /opt/happy && docker compose restart happy-server >/dev/null 2>&1'
    wait_health
}

case "$TARGET" in
    server) deploy_server ;;
    web)    deploy_web ;;
    all)    deploy_server; deploy_web ;;
    *) echo "usage: deploy-hwsg.sh {web|server|all}"; exit 1 ;;
esac
echo "done: $TARGET"
