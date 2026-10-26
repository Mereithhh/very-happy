#!/usr/bin/env bash
set -euo pipefail

IMAGE="${VH_SERVER_IMAGE:-very-happy-server:ci-smoke}"
SUFFIX="${RANDOM}-$$"
APP="vh-app-${SUFFIX}"
PG_APP="vh-pg-app-${SUFFIX}"
PG="vh-pg-${SUFFIX}"
TP_APP="vh-tp-app-${SUFFIX}"
TP_PROXY="vh-tp-proxy-${SUFFIX}"
TP_HOPS="vh-tp-hops-${SUFFIX}"
TP_NET="vh-tp-net-${SUFFIX}"
NET="vh-net-${SUFFIX}"
DATA_DIR="$(mktemp -d)"
ENV_SENTINEL_FILE="packages/happy-server/.env.container-smoke-secret"
DATA_SENTINEL_DIR="packages/happy-server/.docker-smoke/data"
ENV_SENTINEL='VH_DOCKER_CONTEXT_SECRET_SENTINEL_20260824'

cleanup() {
  local status=$?
  # Cleanup must never turn a successful smoke into a failure. The server runs
  # as root in the container and can leave root-owned PGlite files in the bind
  # mount, so delete those contents through the already-built image first.
  set +e
  docker rm -f "$APP" "$PG_APP" "$PG" "$TP_APP" "$TP_PROXY" "$TP_HOPS" >/dev/null 2>&1 || true
  docker network rm "$NET" "$TP_NET" >/dev/null 2>&1 || true
  if docker image inspect "$IMAGE" >/dev/null 2>&1 && [[ -d "$DATA_DIR" ]]; then
    docker run --rm --entrypoint sh -v "$DATA_DIR:/cleanup" "$IMAGE" -c \
      'find /cleanup -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +' \
      >/dev/null 2>&1 || true
  fi
  rm -f "$ENV_SENTINEL_FILE"
  rm -rf "packages/happy-server/.docker-smoke"
  rm -rf "$DATA_DIR" || true
  exit "$status"
}
trap cleanup EXIT

if [[ "${VH_SERVER_SKIP_BUILD:-0}" != "1" ]]; then
  printf '%s\n' "$ENV_SENTINEL" >"$ENV_SENTINEL_FILE"
  mkdir -p "$DATA_SENTINEL_DIR"
  printf '%s\n' "$ENV_SENTINEL" >"$DATA_SENTINEL_DIR/pglite-session-sentinel"
  docker build -f Dockerfile.server -t "$IMAGE" .
  docker run --rm --entrypoint sh "$IMAGE" -c \
    "! grep -R '$ENV_SENTINEL' /repo >/dev/null 2>&1"
  docker run --rm --entrypoint sh "$IMAGE" -c \
    'test ! -e /repo/node_modules/electron && test ! -e /repo/node_modules/node-pty'
  # B-820: every installed package must be a version pnpm-lock.yaml pins.
  node scripts/ci/check-image-lockfile.mjs --image "$IMAGE"
  # The Prisma Client the server resolves at runtime must be the generated one
  # for the packaged schema (an uninitialized stub ships no schema.prisma).
  # Same file the production preflight runs (deploy-blue-green-remote.sh).
  docker run --rm -i --entrypoint sh -w /repo/packages/happy-server "$IMAGE" -s \
    < scripts/ci/image-prisma-client-check.sh
  docker run --rm --entrypoint sh "$IMAGE" -c \
    'test -s /repo/LICENSE && test -s /repo/NOTICE && grep -q "slopus/happy" /repo/NOTICE'
  IMAGE_SIZE="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
  if (( IMAGE_SIZE > 2000000000 )); then
    echo "Server image is unexpectedly large: ${IMAGE_SIZE} bytes" >&2
    exit 1
  fi
  rm -f "$ENV_SENTINEL_FILE"
  rm -rf "packages/happy-server/.docker-smoke"
fi

# Production's TRUST_PROXY (Caddy via the Docker gateway, docs/operations.md).
PROD_TRUST_PROXY='172.18.0.1'

start_pglite() {
  docker run -d --name "$APP" -p 127.0.0.1::3005 \
    -v "$DATA_DIR:/data" \
    -e TRUST_PROXY="$PROD_TRUST_PROXY" \
    -e HANDY_MASTER_SECRET='container-smoke-master-secret-not-production' \
    -e SIGNUP_MODE=open -e SIGNUP_MAX_ACCOUNTS=2 \
    "$IMAGE" >/dev/null
}

wait_for_health() {
  local container="$1"
  local port
  port="$(docker port "$container" 3005/tcp | sed -n 's/.*://p' | head -1)"
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      printf '%s' "$port"
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
      docker logs "$container" >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$container" >&2
  return 1
}

wait_for_postgres() {
  local container="$1"
  for _ in $(seq 1 60); do
    if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
      docker logs "$container" >&2
      return 1
    fi

    # The official image briefly starts a temporary server while running its
    # init scripts, then stops it before launching the final server. A plain
    # pg_isready can observe that temporary server and race the restart.
    if docker logs "$container" 2>&1 | grep -q 'PostgreSQL init process complete; ready for start up.' \
      && docker exec "$container" psql -U postgres -d happy -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then
      return 0
    fi
    sleep 1
  done

  docker logs "$container" >&2
  return 1
}

start_pglite
PORT="$(wait_for_health "$APP")"
curl -fsS -o "$DATA_DIR/landing.html" "http://127.0.0.1:${PORT}/"
curl -fsS -o "$DATA_DIR/docs.html" "http://127.0.0.1:${PORT}/docs"
curl -fsS -o "$DATA_DIR/signup.html" "http://127.0.0.1:${PORT}/signup"
grep -qi 'very happy' "$DATA_DIR/landing.html"
grep -qi 'very happy' "$DATA_DIR/docs.html"
for html in landing docs signup; do
  grep -q 'window.__HAPPY_CONFIG__ = {"serverUrl":"same-origin"}' "$DATA_DIR/${html}.html"
done
curl -fsS -H 'content-type: application/json' \
  -d '{"username":"smoke-user","password":"correct horse battery staple","secret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' \
  -o "$DATA_DIR/signup.json" "http://127.0.0.1:${PORT}/v1/account/signup/password"
grep -q '"token"' "$DATA_DIR/signup.json"

# Recreate the container, not merely restart it: the account must live in the
# mounted /data directory rather than the disposable container layer.
docker rm -f "$APP" >/dev/null
start_pglite
PORT="$(wait_for_health "$APP")"
curl -fsS -H 'content-type: application/json' \
  -d '{"username":"smoke-user","password":"correct horse battery staple"}' \
  -o "$DATA_DIR/login.json" "http://127.0.0.1:${PORT}/v1/account/login"
grep -q '"token"' "$DATA_DIR/login.json"

# B-820b: password login allows 20 attempts per client IP bucket (10 per
# username, so usernames rotate). Prints the HTTP status of the 21st attempt.
login_status_after_burst() {
  local send="$1" client="$2" tag="$3" status=''
  for i in $(seq 1 21); do
    status="$("$send" "$client" "${tag}-${i}")"
  done
  printf '%s' "$status"
}
direct_login() {
  curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
    -H "x-real-client-ip: $1" -d "{\"username\":\"$2\",\"password\":\"wrong password\"}" \
    "http://127.0.0.1:${PORT}/v1/account/login"
}
# Under the production TRUST_PROXY the published port's peer (the default
# bridge gateway) is not the proxy: rotating spoofed X-Real-Client-IP values
# must all land in that one peer bucket.
spoof_ip() { printf '198.51.100.%s' "$(( ${2##*-} ))"; }
spoof_login() { direct_login "$(spoof_ip "$@")" "$2"; }
status="$(login_status_after_burst spoof_login unused spoof)"
[[ "$status" == 429 ]] || { echo "spoofed X-Real-Client-IP escaped the peer rate-limit bucket (21st login: $status)" >&2; exit 1; }

# A hop-count TRUST_PROXY must refuse to serve, with the fix in the message.
if timeout 300 docker run --name "$TP_HOPS" -e TRUST_PROXY=1 \
    -e HANDY_MASTER_SECRET='container-smoke-master-secret-not-production' "$IMAGE" >/dev/null 2>&1; then
  echo 'TRUST_PROXY=1 started the server' >&2; exit 1
fi
HOPS_LOGS="$(docker logs "$TP_HOPS" 2>&1)"
grep -q 'is a hop count, which is no longer supported' <<<"$HOPS_LOGS" && grep -q 'e.g. TRUST_PROXY=172.18.0.1' <<<"$HOPS_LOGS" \
  || { docker logs "$TP_HOPS" >&2; echo 'TRUST_PROXY=1 did not explain the fix' >&2; exit 1; }

# Production shape: one trusted proxy IP in front of the server. Requests the
# proxy forwards are bucketed per real client: client A is throttled, client B
# behind the same proxy is not.
docker network create "$TP_NET" >/dev/null
docker run -d --name "$TP_PROXY" --network "$TP_NET" --entrypoint sleep "$IMAGE" infinity >/dev/null
PROXY_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$TP_PROXY")"
docker run -d --name "$TP_APP" --network "$TP_NET" -p 127.0.0.1::3005 \
  -e HANDY_MASTER_SECRET='container-smoke-master-secret-not-production' \
  -e TRUST_PROXY="$PROXY_IP" "$IMAGE" >/dev/null
wait_for_health "$TP_APP" >/dev/null
proxy_login() {
  docker exec "$TP_PROXY" node -e '
    const [client, username, host] = process.argv.slice(1);
    fetch(`http://${host}:3005/v1/account/login`, { method: "POST",
      headers: { "content-type": "application/json", "x-real-client-ip": client },
      body: JSON.stringify({ username, password: "wrong password" }) })
      .then((r) => process.stdout.write(String(r.status)), () => process.stdout.write("000"));' "$1" "$2" "$TP_APP"
}
status="$(login_status_after_burst proxy_login 203.0.113.9 client-a)"
[[ "$status" == 429 ]] || { echo "client A behind the trusted proxy was not throttled (21st login: $status)" >&2; exit 1; }
status="$(proxy_login 203.0.113.10 client-b-1)"
[[ "$status" == 401 ]] || { echo "client B shared client A's bucket behind the trusted proxy (login: $status)" >&2; exit 1; }

# The same image must migrate and serve an external PostgreSQL database.
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=happy postgres:16-alpine >/dev/null
wait_for_postgres "$PG"
docker run -d --name "$PG_APP" --network "$NET" -p 127.0.0.1::3005 \
  -e HANDY_MASTER_SECRET='container-smoke-master-secret-not-production' \
  -e SIGNUP_MODE=open -e SIGNUP_MAX_ACCOUNTS=2 \
  -e DB_PROVIDER=postgres \
  -e DATABASE_URL="postgresql://postgres:postgres@${PG}:5432/happy?schema=public" \
  "$IMAGE" >/dev/null
PG_PORT="$(wait_for_health "$PG_APP")"
curl -fsS -H 'content-type: application/json' \
  -d '{"username":"postgres-smoke","password":"correct horse battery staple","secret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' \
  -o "$DATA_DIR/postgres-signup.json" "http://127.0.0.1:${PG_PORT}/v1/account/signup/password"
grep -q '"token"' "$DATA_DIR/postgres-signup.json"
PG_LOGS="$(docker logs "$PG_APP" 2>&1)"
grep -q 'Migrating external PostgreSQL database' <<<"$PG_LOGS"

echo 'Server container migration, persistence, Web, and Postgres smoke passed.'
