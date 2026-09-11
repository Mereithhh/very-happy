#!/usr/bin/env bash
# Deploy the immutable relay image to the hw-sg (sg) and dmit-la (us) Docker hosts.
set -euo pipefail

TARGET="${1:-all}"
IMAGE="${RELAY_IMAGE:-ghcr.io/mereithhh/very-happy-relay:${GITHUB_SHA:?GITHUB_SHA is required}}"
VERSION="${GITHUB_SHA}"
SSH_OPTS=(-i "${SSH_KEY:?SSH_KEY is required}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

[[ "$IMAGE" == "ghcr.io/mereithhh/very-happy-relay:${VERSION}" ]]
[[ "$VERSION" =~ ^[0-9a-f]{40}$ ]]

deploy_docker() {
    # $1 = region key (sg|us); the remote runs Docker + Caddy, compose file
    # lives in ops/relay/docker-compose.<region>.yml and the one-time .env
    # (RELAY_TOKEN_SECRET only) must already exist on the host.
    local region="$1" host port user
    case "$region" in
        sg) host="${RELAY_SG_HOST:?}"; port="${RELAY_SG_PORT:?}"; user="${RELAY_SG_USER:?}" ;;
        us) host="${RELAY_US_HOST:?}"; port="${RELAY_US_PORT:?}"; user="${RELAY_US_USER:?}" ;;
        *) echo "unknown region $region" >&2; return 2 ;;
    esac
    local remote="${user}@${host}"
    local ssh_opts=("${SSH_OPTS[@]}" -p "$port")
    local scp_opts=("${SSH_OPTS[@]}" -P "$port")
    ssh "${ssh_opts[@]}" "$remote" \
        'install -d -m 700 /opt/very-happy-relay; test -s /opt/very-happy-relay/.env'
    echo "== relay-$region: pull immutable image from GHCR =="
    ssh "${ssh_opts[@]}" "$remote" "docker pull '$IMAGE' >/dev/null"
    scp "${scp_opts[@]}" "ops/relay/docker-compose.$region.yml" "$remote:/opt/very-happy-relay/docker-compose.yml"
    ssh "${ssh_opts[@]}" "$remote" \
        "cd /opt/very-happy-relay && RELAY_IMAGE='$IMAGE' RELAY_VERSION='$VERSION' docker compose up -d --wait"
    # Relay images are ~1.5 GB and the hosts are 20 GB VPSes: drop every other
    # very-happy-relay tag once the new container is healthy.
    ssh "${ssh_opts[@]}" "$remote" \
        "docker images ghcr.io/mereithhh/very-happy-relay --format '{{.Repository}}:{{.Tag}}' | grep -vx '$IMAGE' | xargs -r docker rmi >/dev/null 2>&1 || true"
}

deploy_sg() { deploy_docker sg; }
deploy_us() { deploy_docker us; }

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
