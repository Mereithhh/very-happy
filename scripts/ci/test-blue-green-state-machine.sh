#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export VH_RELEASE_LIBRARY_ONLY=1
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh"

fail() { echo "blue-green state-machine test failed: $*" >&2; exit 1; }

[ "$(inactive_slot blue)" = green ] || fail 'blue must switch to green'
[ "$(inactive_slot green)" = blue ] || fail 'green must switch to blue'
[ "$(slot_port blue)" = 3101 ] || fail 'blue port changed'
[ "$(slot_port green)" = 3102 ] || fail 'green port changed'
old_epoch=$(release_epoch 9 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
new_epoch=$(release_epoch 10 0000000000000000000000000000000000000000)
[[ "$new_epoch" > "$old_epoch" ]] || fail 'release generation must sort ahead of commit digest'

migration_review_file=$(mktemp)
ACTIVE_IMAGE=active-image
IMAGE=candidate-image
VERSION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PRODUCTION_ENV_FILE="$migration_review_file"
migration_tree_digest() { if [ "$1" = active-image ]; then echo old; else echo new; fi; }
if verify_migration_contract >/dev/null 2>&1; then fail 'changed migrations require commit-bound review'; fi
printf 'VH_RELEASE_MIGRATIONS_REVIEWED=%s\n' "$VERSION" > "$migration_review_file"
verify_migration_contract || fail 'exact migration review commit must pass'

run_rollback_case() {
    local phase="$1" expected="$2" forbidden="${3:-}" action_log status
    action_log=$(mktemp)
    set +e
    (
        PHASE="$phase"
        ACTIVE_PORT=3005
        ACTIVE_RELEASE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        stop_http_probe() { echo stop-probe >> "$action_log"; }
        stop_candidate() { echo stop-candidate >> "$action_log"; }
        admin_curl() { echo "admin:$1:$2:$3" >> "$action_log"; }
        start_old_slot() { echo start-old >> "$action_log"; }
        write_active_upstream() { echo "write-active:$1" >> "$action_log"; }
        reload_caddy() { echo reload-caddy >> "$action_log"; }
        verify_public_release() { echo "verify:$1" >> "$action_log"; }
        false
        rollback_switch
    ) >/dev/null 2>&1
    status=$?
    set -e
    [ "$status" -ne 0 ] || fail "$phase rollback must preserve the original failure"
    grep -Fq "$expected" "$action_log" || fail "$phase missing action $expected"
    if [ -n "$forbidden" ] && grep -Fq "$forbidden" "$action_log"; then fail "$phase unexpectedly ran $forbidden"; fi
}

# Candidate readiness, Redis, and migration failures all happen before switch:
# candidate is removed and the active upstream is untouched.
run_rollback_case before-switch stop-candidate write-active
# Once drain has started, rollback cancels it before stopping candidate.
run_rollback_case after-drain admin:3005:POST:/_vh/release/cancel write-active
# An include write is already externally mutable even if reload itself failed.
run_rollback_case after-switch-write write-active:3005 stop-candidate
# Caddy/post-switch/drain failures restore the old include but retain candidate.
run_rollback_case after-switch write-active:3005 stop-candidate
# A failure after old shutdown first restores old capacity, then switches back.
run_rollback_case after-old-stop start-old stop-candidate

VH_BLUE_IMAGE=ghcr.io/mereithhh/very-happy-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
VH_GREEN_IMAGE=ghcr.io/mereithhh/very-happy-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
VH_BLUE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
VH_GREEN_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
VH_RELEASE_ADMIN_TOKEN=cccccccccccccccccccccccccccccccc \
VH_PRODUCTION_ENV_FILE=/dev/null \
docker compose -f "$REPO_ROOT/ops/production/docker-compose.blue-green.yml" config --quiet

bash -n "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh" "$REPO_ROOT/scripts/ci/deploy-hwsg.sh"

# Production bootstrap contracts: Caddy must be able to traverse the release
# directory, while both the forward path and rollback recreate only the server.
grep -Fq 'install -d -m 755 "$RELEASE_DIR"' "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh" \
    || fail 'release directory must be traversable by the caddy service user'
[ "$(grep -Fc -- 'up -d --no-deps' "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh")" -ge 3 ] \
    || fail 'legacy start, groundwork, and rollback must not recreate dependencies'
# Normal post-activation switches build current main. An explicit release_sha
# is the only shadow-reuse path; rebuilding that case is unsafe because BuildKit
# provenance makes OCI manifest digests invocation-bound.
grep -Fq "if: inputs.target == 'publish' || inputs.rollout != 'switch' || inputs.release_sha == ''" "$REPO_ROOT/.github/workflows/deploy-hwsg.yml" \
    || fail 'normal switch must build current main while explicit shadow reuse skips rebuild'
grep -Fq "REUSE_SHADOW_IMAGE: \${{ inputs.rollout == 'switch' && inputs.release_sha != '' }}" "$REPO_ROOT/.github/workflows/deploy-hwsg.yml" \
    || fail 'workflow must make shadow reuse explicit'
grep -Fq 'if [ "$ROLLOUT_MODE" = switch ] && [ "${REUSE_SHADOW_IMAGE:-false}" = true ]; then' "$REPO_ROOT/scripts/ci/deploy-hwsg.sh" \
    || fail 'deploy helper must reuse shadow only when explicitly requested'
grep -Fq '${{ steps.deploy.outputs.image }}' "$REPO_ROOT/.github/workflows/deploy-hwsg.yml" \
    || fail 'latest must promote the image actually deployed'
grep -Fq 'SHADOW_IMAGE=//p; s/^SHADOW_RELEASE=//p' "$REPO_ROOT/scripts/ci/deploy-hwsg.sh" \
    || fail 'switch must resolve the immutable image from production shadow state'
echo 'blue-green state-machine fixtures: ok'
