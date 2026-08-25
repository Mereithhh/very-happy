#!/usr/bin/env bash
# Deploy the immutable relay image to hw-sg Docker and/or fb-us k3s.
set -euo pipefail

TARGET="${1:-all}"
IMAGE="very-happy-relay:${GITHUB_SHA:?GITHUB_SHA is required}"
VERSION="${GITHUB_SHA}"
SSH_OPTS=(-i "${SSH_KEY:?SSH_KEY is required}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

deploy_sg() {
    local remote="${RELAY_SG_USER}@${RELAY_SG_HOST}"
    local ssh_opts=("${SSH_OPTS[@]}" -p "${RELAY_SG_PORT}")
    local scp_opts=("${SSH_OPTS[@]}" -P "${RELAY_SG_PORT}")
    ssh "${ssh_opts[@]}" "$remote" \
        'install -d -m 700 /opt/very-happy-relay; test -s /opt/very-happy-relay/.env'
    echo "== relay-sg: upload immutable image =="
    docker save "$IMAGE" | gzip -1 | ssh "${ssh_opts[@]}" "$remote" 'gzip -dc | docker load >/dev/null'
    scp "${scp_opts[@]}" ops/relay/docker-compose.sg.yml "$remote:/opt/very-happy-relay/docker-compose.yml"
    ssh "${ssh_opts[@]}" "$remote" \
        "cd /opt/very-happy-relay && RELAY_IMAGE='$IMAGE' RELAY_VERSION='$VERSION' docker compose up -d --wait"
}

deploy_us() {
    local remote="${RELAY_US_USER}@${RELAY_US_HOST}"
    local ssh_opts=("${SSH_OPTS[@]}" -p "${RELAY_US_PORT}")
    local scp_opts=("${SSH_OPTS[@]}" -P "${RELAY_US_PORT}")
    local archive="/tmp/very-happy-relay-${GITHUB_SHA}.tar.gz"
    echo "== relay-us: upload image through fb-us to k3s =="
    docker save "$IMAGE" | gzip -1 | ssh "${ssh_opts[@]}" "$remote" "umask 077; cat > '$archive'"
    scp "${scp_opts[@]}" ops/relay/k8s-us.yaml "$remote:/tmp/very-happy-relay-k8s.yaml"
    ssh "${ssh_opts[@]}" "$remote" "IMAGE='$IMAGE' VERSION='$VERSION' ARCHIVE='$archive' bash -s" <<'REMOTE'
set -euo pipefail
K8S_HOST=root@100.100.3.2
ssh "$K8S_HOST" 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n very-happy-relay get secret relay-token >/dev/null'
scp -q "$ARCHIVE" "$K8S_HOST:/tmp/relay-image.tar.gz"
sed -e "s|__RELAY_IMAGE__|$IMAGE|g" -e "s|__RELAY_VERSION__|$VERSION|g" \
  /tmp/very-happy-relay-k8s.yaml | ssh "$K8S_HOST" 'cat > /tmp/relay-k8s.yaml'
ssh "$K8S_HOST" 'set -e; gzip -dc /tmp/relay-image.tar.gz | k3s ctr images import - >/dev/null; KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl apply -f /tmp/relay-k8s.yaml; KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n very-happy-relay rollout status deployment/relay-us --timeout=180s; rm -f /tmp/relay-image.tar.gz /tmp/relay-k8s.yaml'
rm -f "$ARCHIVE" /tmp/very-happy-relay-k8s.yaml
REMOTE
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
      if jq -e --arg id "$expected" '.ok == true and .relayId == $id' <<<"$body" >/dev/null 2>&1; then
        echo "healthy: $expected"
        break
      fi
      sleep 3
    done
    jq -e --arg id "$expected" '.ok == true and .relayId == $id' <<<"${body:-}" >/dev/null
done
