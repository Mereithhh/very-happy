#!/usr/bin/env bash
# Release readiness of a server image, as the blue-green deploy sees it
# (deploy-blue-green-remote.sh):
#   - the first /assets/*.js in index.html ends in -<sha>.js
#     (verify_direct_asset / verify_public_release take `head -1`)
#   - a release slot (VH_RELEASE_SLOT/SHA/ADMIN_TOKEN + Postgres + Redis)
#     answers /_vh/release/ready 200 with status ready, its slot, release and
#     the -<sha>.js web asset (wait_ready).
# Release14: an image whose entry lost the -<sha> suffix (B-823) passed CI and
# then never became ready in production.
#
#   scripts/ci/smoke-release-readiness.sh <image> <40-hex release sha>
set -euo pipefail

IMAGE="${1:?image}"
SHA="${2:?release sha}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "release must be a 40-character commit SHA: $SHA" >&2; exit 2; }
SUFFIX="${RANDOM}-$$"
NET="vh-rr-net-${SUFFIX}"
PG="vh-rr-pg-${SUFFIX}"
REDIS="vh-rr-redis-${SUFFIX}"
APP="vh-rr-app-${SUFFIX}"
# Throwaway credentials for these containers only, minted per run.
PG_PASS="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
TOKEN="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
MASTER="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
failed=0

cleanup() {
  local status=$?
  set +e
  docker rm -f "$APP" "$PG" "$REDIS" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  exit "$status"
}
trap cleanup EXIT

first="$(docker run --rm --entrypoint cat "$IMAGE" /repo/packages/happy-server/webapp/index.html | grep -oE '/assets/[^"]+\.js' | head -1)"
case "$first" in
  *-"$SHA".js) echo "entry ok: $first" ;;
  *) echo "first web asset does not end in -${SHA}.js: ${first:-none} (verify_direct_asset / verify_public_release would fail)" >&2; failed=1 ;;
esac

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD="$PG_PASS" -e POSTGRES_DB=happy postgres:16-alpine >/dev/null
docker run -d --name "$REDIS" --network "$NET" redis:7-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker logs "$PG" 2>&1 | grep -q 'PostgreSQL init process complete; ready for start up.' \
    && docker exec "$PG" psql -U postgres -d happy -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then break; fi
  sleep 1
done
docker run -d --name "$APP" --network "$NET" -p 127.0.0.1::3005 \
  -e HANDY_MASTER_SECRET="$MASTER" \
  -e SIGNUP_MODE=closed \
  -e DB_PROVIDER=postgres \
  -e DATABASE_URL="postgresql://postgres:${PG_PASS}@${PG}:5432/happy?schema=public&connection_limit=4" \
  -e REDIS_URL="redis://${REDIS}:6379" \
  -e VH_RELEASE_SLOT=blue -e VH_RELEASE_SHA="$SHA" -e VH_RELEASE_ADMIN_TOKEN="$TOKEN" \
  -e VH_RELEASE_ADAPTER_WARMUP_MS=1000 \
  "$IMAGE" >/dev/null

port=""
body=""
for _ in $(seq 1 120); do
  if ! docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null | grep -q true; then
    docker logs "$APP" 2>&1 | tail -40 >&2
    echo "release slot exited before it became ready" >&2
    exit 1
  fi
  port="${port:-$(docker port "$APP" 3005/tcp 2>/dev/null | sed -n 's/.*://p' | head -1)}"
  if [[ -n "$port" ]]; then
    body="$(curl -sS --max-time 5 -H "X-VH-Release-Token: $TOKEN" "http://127.0.0.1:${port}/_vh/release/ready" 2>/dev/null || true)"
    # The same four conditions as deploy-blue-green-remote.sh wait_ready.
    if grep -Fq '"status":"ready"' <<<"$body" && grep -Fq '"slot":"blue"' <<<"$body" \
      && grep -Fq "\"release\":\"$SHA\"" <<<"$body" && grep -Fq -- "-$SHA.js" <<<"$body"; then
      echo "release ready: $body"
      exit "$failed"
    fi
  fi
  sleep 1
done
echo "release slot never became ready: ${body:-no response}" >&2
exit 1
