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
#   web     build happy-web-v2 (Vite) → stage → swap → restart → verify JS
#
# The web app is the pure-React v2 (packages/happy-web-v2), which serves at the
# root of veryhappy.dev via happy-server's /webapp static dir. It is a plain
# Vite app: index.html already carries the title / viewport-fit / apple-meta /
# splash, and vite-plugin-pwa emits the manifest + service worker — so NO
# index.html post-patch is needed (unlike the old expo happy-app).
#
# NOTE: changing .env (e.g. VAPID/invite/secrets) still needs a manual
# `docker compose up -d` on the box — restart doesn't re-read env_file.

set -euo pipefail
TARGET="${1:-all}"
SSH_OPTS="-i ${SSH_KEY} -p ${HWSG_PORT} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
REMOTE="${HWSG_USER}@${HWSG_HOST}"
ssh_x() { ssh ${SSH_OPTS} "${REMOTE}" "$@"; }

WEB="packages/happy-web-v2"
SERVER="packages/happy-server"
# Salt asset filenames per deploy so a poisoned cache can't survive a redeploy.
WEB_VERSION="${VH_VERSION:-$(date +%Y%m%d%H%M)}"
# Self-hosted runners retain their login environment between jobs. Pin the
# production origin explicitly so a stale runner-level VH_SERVER_URL cannot be
# baked into index.html and silently route a new shell back to an old domain.
WEB_SERVER_URL="https://veryhappy.dev"

wait_health() {
    local c=000
    for _ in $(seq 1 20); do
        c=$(curl -s -o /dev/null -w "%{http_code}" https://veryhappy.dev/health 2>/dev/null || echo 000)
        [ "$c" = "200" ] && break; sleep 3
    done
    echo "  health: $c"
    [ "$c" = "200" ]
}

deploy_server() {
    echo "== server: verify migration-on-start contract =="
    local container_cmd
    container_cmd=$(ssh_x 'docker inspect happy-server --format "{{json .Config.Cmd}}"')
    case "$container_cmd" in
        *migrate*) ;;
        *)
            echo "  ERROR: happy-server startup command does not run migrations: $container_cmd" >&2
            echo "  Refusing to sync schema-dependent source." >&2
            exit 1
            ;;
    esac
    echo "== server: sync source → /opt/happy-src =="
    tar czf - -C "$SERVER" sources prisma/migrations \
        | ssh_x 'tar xzf - -C /opt/happy-src/packages/happy-server'
    echo "== server: restart (migrate, then serve) =="
    ssh_x 'cd /opt/happy && docker compose restart happy-server >/dev/null 2>&1'
    wait_health
}

deploy_web() {
    # happy-wire's dist is gitignored, so build it first — happy-web-v2 imports
    # @slopus/happy-wire via its package entry (dist), not source.
    echo "== web: build @slopus/happy-wire =="
    pnpm --filter @slopus/happy-wire build >/dev/null
    echo "== web: vite build (version=$WEB_VERSION) =="
    ( cd "$WEB" && rm -rf dist && VH_VERSION="$WEB_VERSION" VH_SERVER_URL="$WEB_SERVER_URL" pnpm exec vite build >/dev/null )
    [ -f "$WEB/dist/index.html" ] || { echo "  ERROR: no dist/index.html"; exit 1; }
    # CRITICAL ordering: happy-server's @fastify/static globs /webapp at STARTUP
    # (wildcard:false), so newly-hashed assets have no route until a restart. If
    # a browser loads during the swap→restart window, Caddy serves index.html for
    # /assets/* WITH immutable headers → HTML-as-JS cached for a year. Mitigations:
    # (1) version-salted filenames (above); (2) stage → swap → restart → verify.
    echo "== web: stage → swap → restart → verify =="
    ssh_x 'rm -rf /opt/happy/webapp.new && mkdir -p /opt/happy/webapp.new'
    tar czf - -C "$WEB/dist" . | ssh_x 'tar xzf - -C /opt/happy/webapp.new'
    # rm before cp: with an existing webapp.prev DIRECTORY, `cp -a webapp webapp.prev`
    # copies INTO it (webapp.prev/webapp/...), so the top level stays the FIRST deploy
    # forever — the rollback material PROCESS.md points at was garbage. Backup failure
    # aborts the swap (&&): better a failed deploy than no rollback path.
    ssh_x 'cd /opt/happy && rm -rf webapp.prev && cp -a webapp webapp.prev && find webapp -mindepth 1 -delete && cp -a webapp.new/. webapp/ && rm -rf webapp.new && docker compose restart happy-server >/dev/null 2>&1'
    wait_health
    local main ct
    main=$(curl -s https://veryhappy.dev/ | grep -oE '/assets/[^"]+\.js' | head -1)
    ct=$(curl -s -o /dev/null -w '%{content_type}' "https://veryhappy.dev$main")
    echo "  main asset $main → $ct"
    case "$ct" in
        *javascript*) echo "  ✓ web live at https://veryhappy.dev/" ;;
        *) echo "  ✗ assets not serving as JS — check happy-server"; exit 1 ;;
    esac
}

case "$TARGET" in
    server) deploy_server ;;
    web)    deploy_web ;;
    all)    deploy_server; deploy_web ;;
    *) echo "usage: deploy-hwsg.sh {web|server|all}"; exit 1 ;;
esac
echo "done: $TARGET"
