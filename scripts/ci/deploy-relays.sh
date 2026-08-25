#!/usr/bin/env bash
# Deploy the immutable relay image to hw-sg Docker and/or fb-us k3s.
set -euo pipefail

TARGET="${1:-all}"
IMAGE="${RELAY_IMAGE:-ghcr.io/mereithhh/very-happy-relay:${GITHUB_SHA:?GITHUB_SHA is required}}"
VERSION="${GITHUB_SHA}"
SSH_OPTS=(-i "${SSH_KEY:?SSH_KEY is required}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

[[ "$IMAGE" == "ghcr.io/mereithhh/very-happy-relay:${VERSION}" ]]
[[ "$VERSION" =~ ^[0-9a-f]{40}$ ]]

deploy_sg() {
    local remote="${RELAY_SG_USER}@${RELAY_SG_HOST}"
    local ssh_opts=("${SSH_OPTS[@]}" -p "${RELAY_SG_PORT}")
    local scp_opts=("${SSH_OPTS[@]}" -P "${RELAY_SG_PORT}")
    ssh "${ssh_opts[@]}" "$remote" \
        'install -d -m 700 /opt/very-happy-relay; test -s /opt/very-happy-relay/.env'
    echo "== relay-sg: pull immutable image from GHCR =="
    ssh "${ssh_opts[@]}" "$remote" "docker pull '$IMAGE' >/dev/null"
    scp "${scp_opts[@]}" ops/relay/docker-compose.sg.yml "$remote:/opt/very-happy-relay/docker-compose.yml"
    ssh "${ssh_opts[@]}" "$remote" \
        "cd /opt/very-happy-relay && RELAY_IMAGE='$IMAGE' RELAY_VERSION='$VERSION' docker compose up -d --wait"
}

deploy_us() {
    local remote="${RELAY_US_USER}@${RELAY_US_HOST}"
    local ssh_opts=("${SSH_OPTS[@]}" -p "${RELAY_US_PORT}")
    local scp_opts=("${SSH_OPTS[@]}" -P "${RELAY_US_PORT}")
    echo "== relay-us: let k3s pull immutable image from GHCR =="
    scp "${scp_opts[@]}" ops/relay/k8s-us.yaml "$remote:/tmp/very-happy-relay-k8s.yaml"
    scp "${scp_opts[@]}" scripts/ci/deploy-relay-k8s-remote.sh "$remote:/tmp/deploy-relay-k8s-remote.sh"
    ssh "${ssh_opts[@]}" "$remote" \
        "chmod 700 /tmp/deploy-relay-k8s-remote.sh && /tmp/deploy-relay-k8s-remote.sh '$IMAGE' '$VERSION'"
}

case "$TARGET" in
    sg) deploy_sg ;;
    us) deploy_us ;;
    all) deploy_sg; deploy_us ;;
    *) echo "usage: deploy-relays.sh {sg|us|all}" >&2; exit 2 ;;
esac

for endpoint in \
  'https://relay-sg.veryhappy.dev/health|sg-hw' \
  'https://relay-us.veryhappy.dev/health|us-fb'; do
    case "$TARGET:$endpoint" in
      sg:*relay-us*|us:*relay-sg*) continue ;;
    esac
    url=${endpoint%%|*}; expected=${endpoint##*|}
    echo "== verify $url =="
    for _ in $(seq 1 40); do
      body=$(curl -fsS --connect-timeout 5 --max-time 10 "$url" 2>/dev/null || true)
      if jq -e --arg id "$expected" --arg version "$VERSION" \
        '.ok == true and .relayId == $id and .version == $version' <<<"$body" >/dev/null 2>&1; then
        echo "healthy: $expected at $VERSION"
        break
      fi
      sleep 3
    done
    jq -e --arg id "$expected" --arg version "$VERSION" \
      '.ok == true and .relayId == $id and .version == $version' <<<"${body:-}" >/dev/null
done
