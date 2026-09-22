#!/usr/bin/env bash
# Deploy the complete happy-server image (including Web V2) to the active
# production host. The legacy filename and HWSG_* secret names are retained so
# existing GitHub configuration does not need a disruptive rename.

set -euo pipefail

TARGET="${1:-all}"
ROLLOUT_MODE="${2:-switch}"
# Keepalives: the drain wait used to sit silent for up to 10 minutes and the
# runner->host session was cut in the middle of it (B-479/B-483).
SSH_OPTS="-i ${SSH_KEY} -p ${HWSG_PORT} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8"
REMOTE="${HWSG_USER}@${HWSG_HOST}"

# Print new log bytes each round; stop when the result file appears. Echoes the
# remote exit code on stdout (7 = gave up waiting, 8 = unreadable result).
poll_remote_deploy() {
    local log="$1" result="$2" offset=0 chunk size marker deadline
    deadline=$(( $(date +%s) + ${VH_DEPLOY_POLL_SECONDS:-1500} ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        chunk=$(ssh ${SSH_OPTS} "${REMOTE}" "size=\$(stat -c %s '$log' 2>/dev/null || echo 0); tail -c +$((offset + 1)) '$log' 2>/dev/null | head -c \$((size - $offset)); printf '\n__VH_SIZE=%s\n' \"\$size\"; [ -f '$result' ] && printf '__VH_RESULT=%s\n' \"\$(head -1 '$result')\"" 2>/dev/null) || { sleep 5; continue; }
        printf '%s\n' "$chunk" | grep -v '^__VH_' >&2
        size=$(printf '%s\n' "$chunk" | sed -n 's/^__VH_SIZE=//p' | tail -1)
        [[ "$size" =~ ^[0-9]+$ ]] && offset="$size"
        marker=$(printf '%s\n' "$chunk" | sed -n 's/^__VH_RESULT=//p' | tail -1)
        if [ -n "$marker" ]; then
            echo "remote: $marker" >&2
            case "$marker" in exit=*) marker="${marker#exit=}"; echo "${marker%% *}"; return 0 ;; esac
            echo 8; return 0
        fi
        sleep 10
    done
    echo 'gave up waiting for the remote deployment; it may still be running on the host (check /opt/happy/release/deploy.lock and the log)' >&2
    echo 7
}

deploy_complete_image() {
    local deploy_sha image remote_dir
    deploy_sha="${DEPLOY_RELEASE_SHA:-${GITHUB_SHA:-$(git rev-parse HEAD)}}"
    [[ "$deploy_sha" =~ ^[0-9a-f]{40}$ ]]

    case "$ROLLOUT_MODE" in groundwork|shadow|switch) ;; *) echo "invalid rollout mode: $ROLLOUT_MODE" >&2; exit 2 ;; esac

    case "${REUSE_SHADOW_IMAGE:-false}" in true|false) ;; *) echo 'invalid shadow reuse flag' >&2; exit 2 ;; esac

    if [ "$ROLLOUT_MODE" = switch ] && [ "${REUSE_SHADOW_IMAGE:-false}" = true ]; then
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
        # Every normal post-activation switch validates and cuts over the image
        # built by this run. Shadow reuse is deliberately opt-in above: after
        # blue-green activation, production no longer accepts another shadow.
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
    # B-483: run the remote script detached from this SSH session and poll its
    # log and result file over short-lived connections. A session that dies
    # mid-drain no longer decides anything: the host finishes the release on
    # its own and the verdict is read from the result file.
    local log="$remote_dir/deploy.log" result="$remote_dir/deploy.result"
    ssh ${SSH_OPTS} "${REMOTE}" \
        "rm -f '$result'; VH_RELEASE_RESULT_FILE='$result' setsid nohup bash '$remote_dir/scripts/ci/deploy-blue-green-remote.sh' '$image' '$deploy_sha' '$ROLLOUT_MODE' > '$log' 2>&1 < /dev/null & echo \"remote deploy pid \$!\""
    local status
    status=$(poll_remote_deploy "$log" "$result")
    ssh ${SSH_OPTS} "${REMOTE}" "rm -rf '$remote_dir'" || true
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
