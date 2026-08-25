#!/usr/bin/env bash
# Deploy the complete happy-server image (including Web V2) to the active
# production host. The legacy filename and HWSG_* secret names are retained so
# existing GitHub configuration does not need a disruptive rename.

set -euo pipefail

TARGET="${1:-all}"
SSH_OPTS="-i ${SSH_KEY} -p ${HWSG_PORT} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
REMOTE="${HWSG_USER}@${HWSG_HOST}"

deploy_complete_image() {
    local deploy_sha image
    deploy_sha="${GITHUB_SHA:-$(git rev-parse HEAD)}"
    [[ "$deploy_sha" =~ ^[0-9a-f]{40}$ ]]
    test "$(git rev-parse HEAD)" = "$deploy_sha"
    image="${SERVER_IMAGE:?SERVER_IMAGE digest is required}"
    [[ "$image" =~ ^ghcr\.io/mereithhh/very-happy-server@sha256:[0-9a-f]{64}$ ]]

    echo "== server + web: deploy $image =="
    ssh ${SSH_OPTS} "${REMOTE}" bash -s -- "$image" "$deploy_sha" \
        < scripts/ci/deploy-server-remote.sh
}

case "$TARGET" in
    server|web|all) deploy_complete_image ;;
    *) echo "usage: deploy-hwsg.sh {web|server|all}" >&2; exit 1 ;;
esac

echo "done: $TARGET"
