#!/usr/bin/env bash
# B-820: build Dockerfile.relay, require its dependencies to match
# pnpm-lock.yaml, and prove the image boots under the production compose
# hardening (read-only root, no capabilities) and answers /health.
set -euo pipefail

IMAGE="${VH_RELAY_IMAGE:-very-happy-relay:ci-smoke}"
NAME="vh-relay-smoke-${RANDOM}-$$"

cleanup() {
  local status=$?
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker build -f Dockerfile.relay -t "$IMAGE" .
docker run --rm --entrypoint sh "$IMAGE" -c \
  'test ! -e /repo/node_modules/electron && test ! -e /repo/node_modules/node-pty'
node scripts/ci/check-image-lockfile.mjs --image "$IMAGE"

docker run -d --name "$NAME" -p 127.0.0.1::3010 \
  --read-only --tmpfs /tmp:size=16m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true \
  -e RELAY_ID=ci-smoke -e RELAY_REGION=CI -e RELAY_VERSION=ci-smoke \
  -e RELAY_TOKEN_SECRET='relay-smoke-token-secret-not-production-0123456789' \
  "$IMAGE" >/dev/null
port="$(docker port "$NAME" 3010/tcp | sed -n 's/.*://p' | head -1)"
for _ in $(seq 1 60); do
  if body="$(curl -fsS "http://127.0.0.1:${port}/health" 2>/dev/null)"; then
    echo "relay /health: $body"
    grep -q '"relayId":"ci-smoke"' <<<"$body"
    exit 0
  fi
  if ! docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true; then
    docker logs "$NAME" >&2
    exit 1
  fi
  sleep 1
done
docker logs "$NAME" >&2
echo "relay did not become healthy" >&2
exit 1
