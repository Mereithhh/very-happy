#!/usr/bin/env bash
# Runs on fb-us after the GitHub-hosted runner uploads the manifest.
set -euo pipefail

IMAGE="${1:?image is required}"
VERSION="${2:?version is required}"
K8S_HOST="${K8S_HOST:-root@100.100.3.2}"

[[ "$IMAGE" =~ ^ghcr\.io/mereithhh/very-happy-relay:[0-9a-f]{40}$ ]]
[[ "$VERSION" =~ ^[0-9a-f]{40}$ ]]
[[ "$IMAGE" == "ghcr.io/mereithhh/very-happy-relay:${VERSION}" ]]
test -s /tmp/very-happy-relay-k8s.yaml

ssh "$K8S_HOST" \
  'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n very-happy-relay get secret relay-token >/dev/null'
sed -e "s|__RELAY_IMAGE__|$IMAGE|g" -e "s|__RELAY_VERSION__|$VERSION|g" \
  /tmp/very-happy-relay-k8s.yaml | ssh "$K8S_HOST" 'cat > /tmp/relay-k8s.yaml'
ssh "$K8S_HOST" "set -e; k3s ctr images pull '$IMAGE' >/dev/null; KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl apply -f /tmp/relay-k8s.yaml; KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n very-happy-relay rollout status deployment/relay-us --timeout=180s; rm -- /tmp/relay-k8s.yaml"
rm -- /tmp/very-happy-relay-k8s.yaml /tmp/deploy-relay-k8s-remote.sh
