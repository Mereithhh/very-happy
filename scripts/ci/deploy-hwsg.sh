#!/usr/bin/env bash
# Deploy the complete happy-server image (including Web V2) to the active
# production host. The legacy filename and HWSG_* secret names are retained so
# existing GitHub configuration does not need a disruptive rename.

set -euo pipefail

TARGET="${1:-all}"
ROLLOUT_MODE="${2:-switch}"
SSH_OPTS="-i ${SSH_KEY} -p ${HWSG_PORT} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
REMOTE="${HWSG_USER}@${HWSG_HOST}"

deploy_complete_image() {
    local deploy_sha image remote_dir
    deploy_sha="${DEPLOY_RELEASE_SHA:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"
    [[ "$deploy_sha" =~ ^[0-9a-f]{40}$ ]]

    case "$ROLLOUT_MODE" in groundwork|shadow|switch) ;; *) echo "invalid rollout mode: $ROLLOUT_MODE" >&2; exit 2 ;; esac

    if [ "$ROLLOUT_MODE" = switch ]; then
        # Switch the exact immutable artifact that passed shadow. Rebuilding the
        # same commit can still produce a different OCI manifest digest because
        # build provenance is regenerated for every invocation.
        local -a shadow_state
        mapfile -t shadow_state < <(
            ssh ${SSH_OPTS} "${REMOTE}" \
                "sed -n 's/^SHADOW_IMAGE=//p; s/^SHADOW_RELEASE=//p' /opt/happy/release/state.env"
        )
        [ "${#shadow_state[@]}" -eq 2 ] || { echo 'invalid production shadow state' >&2; exit 4; }
        image="${shadow_state[0]}"
        [ "${shadow_state[1]}" = "$deploy_sha" ] || {
            echo "shadow release does not match requested release $deploy_sha" >&2
            exit 4
        }
    else
        test "$(git rev-parse HEAD)" = "$deploy_sha"
        image="${SERVER_IMAGE:?SERVER_IMAGE digest is required}"
    fi
    [[ "$image" =~ ^ghcr\.io/mereithhh/very-happy-server@sha256:[0-9a-f]{64}$ ]]

    echo "== server + web: deploy $image =="
    remote_dir="/tmp/vh-deploy-$deploy_sha"
    ssh ${SSH_OPTS} "${REMOTE}" "install -d -m 700 '$remote_dir'"
    tar -czf - \
        scripts/ci/deploy-blue-green-remote.sh \
        ops/production/docker-compose.blue-green.yml \
        ops/production/legacy-release.override.yml \
        ops/production/Caddyfile.blue-green \
        | ssh ${SSH_OPTS} "${REMOTE}" "tar -xzf - -C '$remote_dir'"
    set +e
    ssh ${SSH_OPTS} "${REMOTE}" \
        "bash '$remote_dir/scripts/ci/deploy-blue-green-remote.sh' '$image' '$deploy_sha' '$ROLLOUT_MODE'"
    local status=$?
    set -e
    ssh ${SSH_OPTS} "${REMOTE}" "rm -rf '$remote_dir'"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
        printf 'image=%s\nrelease=%s\n' "$image" "$deploy_sha" >> "$GITHUB_OUTPUT"
    fi
    return "$status"
}

case "$TARGET" in
    server|web|all) deploy_complete_image ;;
    *) echo "usage: deploy-hwsg.sh {web|server|all} {groundwork|shadow|switch}" >&2; exit 1 ;;
esac

echo "done: $TARGET"
