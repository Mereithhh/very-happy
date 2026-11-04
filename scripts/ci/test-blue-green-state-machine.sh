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

# A release SHA can make the asset suffix begin with a grep option (for
# example "-d..."). Readiness must treat it as data, never as CLI flags.
option_like_release=d35ba62af335e7006243ecd35ba62af335e700624
admin_curl() {
    printf '{"status":"ready","slot":"green","release":"%s","asset":"/assets/index-%s.js"}' \
        "$option_like_release" "$option_like_release"
}
sleep() { :; }
wait_ready 3102 green "$option_like_release" \
    || fail 'readiness asset match must accept option-like release suffixes'
unset -f admin_curl sleep

# Cross-slot canary: a freshly booted peer may not answer the first
# serverSideEmitWithAck; the check retries and only fails when every attempt
# fails. Both directions must be ok within the same attempt.
canary_counter=$(mktemp)
canary_calls() { wc -l < "$canary_counter" | tr -d ' '; }
admin_curl() {
    # runs inside $(...): count through a file, not a shell variable
    echo x >> "$canary_counter"
    if [ "$(canary_calls)" -le 3 ]; then printf '{"status":"failed","peers":[]}'; return 22; fi
    printf '{"status":"ok","peers":[{"slot":"blue"}]}'
}
sleep() { :; }
verify_cross_slot 3102 3101 2>/dev/null || fail 'canary must pass once both slots answer within the retry budget'
# attempt 1: calls 1,2 fail; attempt 2: call 3 fails, 4 ok (same-attempt rule); attempt 3: 5,6 ok
[ "$(canary_calls)" -eq 6 ] || fail "canary retried unexpectedly ($(canary_calls) calls)"
: > "$canary_counter"
admin_curl() { echo x >> "$canary_counter"; printf '{"status":"failed","peers":[]}'; return 22; }
if VH_RELEASE_CANARY_ATTEMPTS=2 verify_cross_slot 3102 3101 2>/dev/null; then fail 'canary must fail when no attempt succeeds'; fi
[ "$(canary_calls)" -eq 4 ] || fail "canary attempt budget not honoured ($(canary_calls) calls)"
rm -f "$canary_counter"
unset -f admin_curl sleep

migration_review_file=$(mktemp)
ACTIVE_IMAGE=active-image
IMAGE=candidate-image
VERSION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PRODUCTION_ENV_FILE="$migration_review_file"
# Runtime transaction pooling cannot carry Prisma's session advisory lock.
# Exercise the real host preflight; only unrelated host probes are stubbed.
caddy() { echo v2.10.2; }
df() { echo unused; }
awk() { echo 20971520; }
docker() { echo "docker $*" >> "$prune_log"; }
prune_log=$(mktemp)
printf 'REDIS_URL=redis://redis\nDATABASE_URL=postgresql://pool/happy?connection_limit=16\n' > "$migration_review_file"
if (validate_host_contract) >/dev/null 2>&1; then fail 'production must require a separate migration endpoint'; fi
printf 'DATABASE_MIGRATION_URL=postgresql://pool/happy_migrations\n' >> "$migration_review_file"
(validate_host_contract) || fail 'configured migration endpoint must pass preflight'
[ ! -s "$prune_log" ] || fail 'preflight must not prune images while disk is plentiful'
# Low disk: preflight prunes old unreferenced images before the 5 GiB gate.
awk() { echo 10485760; }
(validate_host_contract) >/dev/null 2>&1 || fail 'low but sufficient disk must still pass preflight'
grep -qx "docker image prune -af --filter until=72h" "$prune_log" || fail 'low disk must prune images older than 72h'
rm -f "$prune_log"
unset -f caddy df awk docker
: > "$migration_review_file"
migration_tree_digest() { if [ "$1" = active-image ]; then echo old; else echo new; fi; }
if verify_migration_contract >/dev/null 2>&1; then fail 'changed migrations require commit-bound review'; fi
printf 'VH_RELEASE_MIGRATIONS_REVIEWED=%s\n' "$VERSION" > "$migration_review_file"
verify_migration_contract || fail 'exact migration review commit must pass'

# B-308: the release verdict is the longest run of CONSECUTIVE failed samples,
# not the presence of any failure. Fixtures below are the four real production
# records that killed a release on 2026-09-01/02/03 plus a synthetic outage.
probe_case() {
    local name="$1" expect="$2" body="$3" record got
    record=$(mktemp)
    printf '%b' "$body" > "$record"
    got=$(probe_longest_streak "$record")
    [ "$got" = "$expect" ] || fail "probe streak for $name: expected $expect, got $got"
    rm -f "$record"
}

probe_case 'clean window' 0 ''
# 2026-09-01, 2026-09-03 00:48 and 2026-09-03 06:07 each recorded one sample.
probe_case 'single dropped sample' 1 '148 1788263969543 28 curl: (28) Operation timed out\n'
# 2026-09-02 recorded two samples 2.24s apart — 11 good samples between them.
probe_case 'two samples seconds apart' 1 '92 1788335002017 28 timeout\n103 1788335004258 28 timeout\n'
# A real outage drops every sample until it recovers.
probe_case 'continuous outage' 4 '41 1 28 t\n42 2 28 t\n43 3 28 t\n44 4 28 t\n'
# The longest run wins even when isolated noise surrounds it.
probe_case 'outage among noise' 3 '5 1 28 t\n40 2 28 t\n41 3 28 t\n42 4 28 t\n90 5 28 t\n'

probe_verdict_case() {
    local name="$1" expect_rc="$2" body="$3" record rc=0
    record=$(mktemp)
    printf '%b' "$body" > "$record"
    PROBE_MAX_STREAK=3 probe_verdict "$record" test >/dev/null 2>&1 || rc=$?
    [ "$rc" = "$expect_rc" ] || fail "probe verdict for $name: expected rc $expect_rc, got $rc"
    rm -f "$record"
}

# Every historical false failure now passes; a real outage still fails.
probe_verdict_case 'isolated drops pass' 0 '10 1 28 t\n40 2 28 t\n99 3 28 t\n'
probe_verdict_case 'streak at the limit fails' 1 '10 1 28 t\n11 2 28 t\n12 3 28 t\n'
probe_verdict_case 'streak below the limit passes' 0 '10 1 28 t\n11 2 28 t\n'

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
        slot_healthy() { [ "${OLD_SLOT_HEALTHY:-1}" = 1 ]; }
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
# B-483: an old slot that does not answer /health must never be put back in
# front — that is how a stopped slot became a 15-minute 502. The include is
# left alone; the candidate that already passed verification keeps serving.
OLD_SLOT_HEALTHY=0 run_rollback_case after-switch stop-probe write-active
OLD_SLOT_HEALTHY=0 run_rollback_case after-switch-write stop-probe write-active

# B-483: once the public release is verified the switch is committed — state
# is written first, and a drain that never completes must neither roll back
# nor stop an undrained slot.
switch_case() {
    local name="$1" drain_answer="$2" expected="$3" forbidden="$4" action_log
    action_log=$(mktemp)
    (
        set -e
        ACTIVE_SLOT=blue ACTIVE_PORT=3101 ACTIVE_IMAGE=old-image ACTIVE_RELEASE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        CANDIDATE_SLOT=green CANDIDATE_PORT=3102 IMAGE=new-image VERSION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        RELEASE_COMPOSE=/x SLOT_ENV=/y PHASE=after-switch
        write_state() { echo "write-state:$ACTIVE_SLOT:$ROLLBACK_SLOT" >> "$action_log"; }
        admin_curl() { echo "admin:$1:$2:$3" >> "$action_log"; printf '{"state":"%s","localSockets":3}' "$drain_answer"; }
        stop_old_slot() { echo "stop-old:$1" >> "$action_log"; }
        write_active_upstream() { echo "write-active:$1" >> "$action_log"; }
        reload_caddy() { echo reload-caddy >> "$action_log"; }
        verify_public_release() { echo "verify:$1" >> "$action_log"; }
        stop_http_probe() { echo stop-probe >> "$action_log"; }
        probe_release_verdict() { echo probe-verdict >> "$action_log"; }
        sleep() { :; }
        commit_switch >/dev/null
        [ "$PHASE" = committed ] || exit 90
        [ "$ACTIVE_SLOT" = green ] && [ "$ROLLBACK_SLOT" = blue ] && [ "$OLD_PORT" = 3101 ] || exit 91
        # deadline already in the past: straight to disconnect + grace loop
        finish_switch "$(( ($(date +%s) - 1) * 1000 ))" 2>/dev/null
        echo "finish-rc:$?" >> "$action_log"
        echo "phase:$PHASE" >> "$action_log"
    ) || fail "$name: switch flow aborted ($?)"
    head -1 "$action_log" | grep -Fq 'write-state:green:blue' || fail "$name: state must be committed before any drain work"
    grep -Fq "$expected" "$action_log" || fail "$name missing action $expected"
    if [ -n "$forbidden" ] && grep -Fq "$forbidden" "$action_log"; then fail "$name unexpectedly ran $forbidden"; fi
    grep -Fq 'finish-rc:0' "$action_log" || fail "$name: housekeeping must not fail the release"
    rm -f "$action_log"
}
switch_case 'drain never completes' draining 'phase:old-slot-retained' 'stop-old'
switch_case 'drain never completes keeps upstream' draining 'admin:3101:POST:/_vh/release/disconnect' 'write-active'
switch_case 'drained old slot is stopped' drained 'stop-old:blue' 'write-active'

# B-886: per-slot release admin tokens, rotated for the candidate on every
# release. The fake host below models what matters: a slot answers the admin
# API only with the token it was (re)created with (compose reads it from
# slots.env at `up`), and a stopped slot answers nothing.
token_case_dir=$(mktemp -d)
token_case() {
    local name="$1" rc; shift
    # Not under `||`: that would switch off errexit and the ERR trap the
    # rollback depends on for everything inside.
    set +e
    (
        # Earlier cases replaced or unset helpers (admin_curl among them).
        # shellcheck disable=SC1091
        source "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh"
        set -Eeuo pipefail
        RELEASE_DIR="$token_case_dir/release"
        STATE_FILE="$RELEASE_DIR/state.env" SLOT_ENV="$RELEASE_DIR/slots.env"
        ACTIVE_INCLUDE="$RELEASE_DIR/active-upstream.caddy"
        HOST="$token_case_dir/host" CALLS="$token_case_dir/calls.log"
        export VH_RELEASE_DRAIN_SECONDS=30 VH_RELEASE_PRE_SWITCH_SECONDS=2
        IMAGE=ghcr.io/mereithhh/very-happy-server@sha256:$(printf 'c%.0s' $(seq 64))
        slot_compose() {
            local action="$1" service="${*: -1}" slot
            slot=${service#happy-server-}
            case "$action" in
                up) sed -n "s/^VH_$(printf '%s' "$slot" | tr a-z A-Z)_ADMIN_TOKEN=//p" "$SLOT_ENV" > "$HOST/$slot.token" ;;
                stop) rm -f "$HOST/$slot.token" ;;
            esac
        }
        curl() {
            local url="${*: -1}" header="" method=GET port path slot arg prev="" known
            for arg in "$@"; do
                for known in "$RELEASE_DIR"/admin-token-blue "$RELEASE_DIR"/admin-token-green; do
                    case "$arg" in *"$(<"$known")"*) echo "token in argv" >> "$CALLS"; return 99 ;; esac
                done
                if [ "$prev" = -H ] && [ "${arg:0:1}" = @ ]; then header=$(cat "${arg:1}"); fi
                if [ "$prev" = -X ]; then method="$arg"; fi
                prev="$arg"
            done
            port=${url#http://127.0.0.1:}; path=/${port#*/}; port=${port%%/*}
            slot=$(port_slot "$port")
            if [ ! -f "$HOST/$slot.token" ] || [ "$header" != "X-VH-Release-Token: $(<"$HOST/$slot.token")" ]; then
                echo "$slot $method $path 404" >> "$CALLS"; return 22
            fi
            echo "$slot $method $path ok" >> "$CALLS"
            case "$path" in
                /_vh/release/ready) printf '{"status":"ready","slot":"%s","release":"%s","asset":"/assets/index-%s.js"}' "$slot" "$(<"$HOST/$slot.release")" "$(<"$HOST/$slot.release")" ;;
                /_vh/release/canary) printf '{"status":"ok"}' ;;
                /_vh/release/status) printf '{"state":"drained"}' ;;
                *) printf '{}' ;;
            esac
        }
        # Readiness reports the slot's own release; recorded at write_slot_env.
        real_write_slot_env=$(declare -f write_slot_env)
        eval "${real_write_slot_env/write_slot_env/_real_write_slot_env}"
        write_slot_env() { _real_write_slot_env "$@"; echo "$3" > "$HOST/$1.release"; }
        verify_migration_contract() { :; }
        verify_direct_asset() { :; }
        start_http_probe() { :; }
        stop_http_probe() { :; }
        probe_release_verdict() { :; }
        reload_caddy() { :; }
        sync_caddyfile() { :; }
        slot_healthy() { [ -f "$HOST/$(port_slot "$1").token" ]; }
        verify_public_release() { [ "${FAIL_PUBLIC_RELEASE:-}" != "$1" ]; }
        sleep() { :; }
        tok() { cat "$RELEASE_DIR/admin-token-$1"; }
        "$@"
    )
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || fail "$name ($rc)"
}

# Production today: one shared admin-token, green active and started with it.
setup_upgrade_host() {
    rm -rf "$token_case_dir/release" "$token_case_dir/host"; : > "$token_case_dir/calls.log"
    mkdir -p "$token_case_dir/release" "$token_case_dir/host"
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$token_case_dir/release/admin-token"
    chmod 600 "$token_case_dir/release/admin-token"
    cp "$token_case_dir/release/admin-token" "$token_case_dir/legacy-token"
    cp "$token_case_dir/release/admin-token" "$token_case_dir/host/green.token"
    echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$token_case_dir/host/green.release"
    printf 'MODE=bluegreen\nACTIVE_SLOT=green\nACTIVE_PORT=3102\nACTIVE_IMAGE=ghcr.io/mereithhh/very-happy-server@sha256:%s\nACTIVE_RELEASE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nRELEASE_GENERATION=7\n' \
        "$(printf 'a%.0s' $(seq 64))" > "$token_case_dir/release/state.env"
}

upgrade_then_two_releases() {
    local legacy t1 t2
    legacy=$(<"$token_case_dir/legacy-token")
    prepare_admin_tokens
    [ ! -e "$RELEASE_DIR/admin-token" ] || exit 80
    [ "$(tok blue)" = "$legacy" ] && [ "$(tok green)" = "$legacy" ] || exit 81
    [ "$(stat -c %a "$RELEASE_DIR/admin-token-blue")" = 600 ] && [ "$(stat -c %a "$RELEASE_DIR/admin-token-green")" = 600 ] || exit 82
    admin_curl 3102 GET /_vh/release/status >/dev/null || exit 83   # running green still reachable
    prepare_admin_tokens; [ "$(tok green)" = "$legacy" ] || exit 84  # idempotent

    VERSION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    switch_release > "$token_case_dir/out1.log" 2>&1
    t1=$(tok blue)
    [ "$t1" != "$legacy" ] && [ "$(tok green)" = "$legacy" ] || exit 85
    grep -qx 'green POST /_vh/release/drain ok' "$CALLS" || exit 86     # old slot driven with the old token
    grep -qx 'blue GET /_vh/release/ready ok' "$CALLS" || exit 87       # candidate with its new token
    [ ! -f "$HOST/green.token" ] || exit 88                             # drained old slot stopped
    [ "$(<"$HOST/blue.token")" = "$t1" ] || exit 89
    grep -qx 'ACTIVE_SLOT=blue' "$STATE_FILE" || exit 90
    # The leaked token now opens nothing: green is gone, blue wants t1.
    printf '%s' "$legacy" > "$RELEASE_DIR/admin-token-blue"
    if admin_curl 3101 GET /_vh/release/status >/dev/null 2>&1; then exit 91; fi
    printf '%s' "$t1" > "$RELEASE_DIR/admin-token-blue"

    : > "$CALLS"
    VERSION=dddddddddddddddddddddddddddddddddddddddd
    switch_release > "$token_case_dir/out2.log" 2>&1
    t2=$(tok green)
    [ "$t2" != "$t1" ] && [ "$t2" != "$legacy" ] || exit 92
    grep -qx 'blue POST /_vh/release/drain ok' "$CALLS" || exit 93
    grep -qx 'green GET /_vh/release/ready ok' "$CALLS" || exit 94
    grep -qx 'ACTIVE_SLOT=green' "$STATE_FILE" || exit 95
    ! grep -q '404' "$CALLS" || exit 96
    ! grep -Fq "$legacy" "$token_case_dir"/out*.log && ! grep -Fq "$t1" "$token_case_dir"/out*.log && ! grep -Fq "$t2" "$token_case_dir"/out*.log || exit 97
    ! grep -q 'token in argv' "$CALLS" || exit 98
    [ "$(stat -c %a "$RELEASE_DIR/admin-token-green")" = 600 ] && [ "$(stat -c %a "$SLOT_ENV")" = 600 ] || exit 99
}
setup_upgrade_host
token_case 'upgrade from the shared token, then two releases rotate' upgrade_then_two_releases

# A switch that fails publicly after the Caddy reload rolls back to the old
# slot; rollback's cancel must reach it with the old slot's (unrotated) token.
failed_switch_rolls_back() {
    local legacy status=0
    legacy=$(<"$token_case_dir/legacy-token")
    prepare_admin_tokens
    VERSION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    set +e
    (set -e; FAIL_PUBLIC_RELEASE=$VERSION switch_release) > "$token_case_dir/out3.log" 2>&1
    status=$?
    set -e
    [ "$status" -ne 0 ] || exit 70
    [ "$(tok green)" = "$legacy" ] && [ "$(tok blue)" != "$legacy" ] || exit 71
    grep -qx 'green POST /_vh/release/cancel ok' "$CALLS" || exit 72
    grep -qx 'reverse_proxy 127.0.0.1:3102' "$ACTIVE_INCLUDE" || exit 73
    grep -qx 'ACTIVE_SLOT=green' "$STATE_FILE" || exit 74
    [ -f "$HOST/green.token" ] && [ -f "$HOST/blue.token" ] || exit 75   # both retained
    ! grep -Fq "$legacy" "$token_case_dir/out3.log" || exit 76
}
setup_upgrade_host
token_case 'failed switch rolls back with the old slot token' failed_switch_rolls_back

# A fresh host (no token at all) gets two distinct 0600 tokens.
fresh_host() {
    prepare_admin_tokens
    [ "$(tok blue)" != "$(tok green)" ] || exit 60
    [ "$(wc -c < "$RELEASE_DIR/admin-token-blue")" -eq 64 ] || exit 61
    [ "$(stat -c %a "$RELEASE_DIR/admin-token-blue")" = 600 ] || exit 62
}
rm -rf "$token_case_dir/release"; mkdir -p "$token_case_dir/release"
token_case 'fresh host gets two tokens' fresh_host

# Caddyfile sync (B-886): identical is a no-op; a new file is installed with a
# backup; one that breaks reload or the public check is put back.
caddy_sync_case() {
    local name="$1" reload_rc="$2" expect_rc="$3" expect_content="$4" rc=0
    (
        RELEASE_DIR="$token_case_dir/caddy-release" CADDY_FILE="$token_case_dir/Caddyfile"
        REPO_ROOT="$token_case_dir/repo" ACTIVE_RELEASE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        mkdir -p "$RELEASE_DIR" "$REPO_ROOT/ops/production"
        echo old > "$CADDY_FILE"; echo "${REPO_CADDY:-new}" > "$REPO_ROOT/ops/production/Caddyfile.blue-green"
        caddy() { :; }
        reload_caddy() { return "$reload_rc"; }
        verify_public_release() { :; }
        sync_caddyfile 2>/dev/null || exit $?
    ) || rc=$?
    [ "$rc" = "$expect_rc" ] || fail "caddy sync $name: rc $rc"
    [ "$(<"$token_case_dir/Caddyfile")" = "$expect_content" ] || fail "caddy sync $name: content"
}
caddy_sync_case 'new file installs' 0 0 new
ls "$token_case_dir"/caddy-release/caddyfile-backups/Caddyfile.* >/dev/null || fail 'caddy sync must keep a backup'
caddy_sync_case 'failed reload restores' 1 1 old
REPO_CADDY=old caddy_sync_case 'identical is a no-op' 1 0 old
rm -rf "$token_case_dir"

# The public edge never forwards the release admin API (B-886): the block is
# the first thing inside the route, before any proxying handle.
caddy_route=$(sed -n '/^veryhappy.dev, happy.mereith.com {/,$p' "$REPO_ROOT/ops/production/Caddyfile.blue-green" | grep -vE '^\s*(#|$)')
[ "$(printf '%s\n' "$caddy_route" | sed -n 3p | tr -d '\t')" = '@vh_internal path /_vh /_vh/*' ] \
    && [ "$(printf '%s\n' "$caddy_route" | sed -n 4p | tr -d '\t')" = 'respond @vh_internal 404' ] \
    || fail 'Caddy must answer public /_vh/* with 404 before anything else in the route'

VH_BLUE_IMAGE=ghcr.io/mereithhh/very-happy-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
VH_GREEN_IMAGE=ghcr.io/mereithhh/very-happy-server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
VH_BLUE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
VH_GREEN_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
VH_BLUE_ADMIN_TOKEN=cccccccccccccccccccccccccccccccc \
VH_GREEN_ADMIN_TOKEN=dddddddddddddddddddddddddddddddd \
VH_PRODUCTION_ENV_FILE=/dev/null \
docker compose -f "$REPO_ROOT/ops/production/docker-compose.blue-green.yml" config --quiet

bash -n "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh" "$REPO_ROOT/scripts/ci/deploy-hwsg.sh"

# B-483 contracts: one deployment per host, the runner learns the verdict from
# the result file over keepalive'd short SSH calls, and the remote run is
# detached from the runner's session.
grep -Fq 'flock -n 9' "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh" || fail 'remote deploy must hold the host lock'
grep -Fq 'VH_RELEASE_RESULT_FILE' "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh" || fail 'remote deploy must write a result marker'
grep -Fq 'ServerAliveInterval=15' "$REPO_ROOT/scripts/ci/deploy-hwsg.sh" || fail 'runner ssh must send keepalives'
grep -Fq 'setsid nohup bash' "$REPO_ROOT/scripts/ci/deploy-hwsg.sh" || fail 'remote deploy must be detached from the runner session'
grep -Fq 'poll_remote_deploy "$log" "$result"' "$REPO_ROOT/scripts/ci/deploy-hwsg.sh" || fail 'runner must poll the result file'

# 2026-09-24: an early failure (a ghcr pull reset) exited before the result
# trap was armed, so the runner polled for 25 minutes. Any exit must leave a
# marker, and registry pulls retry.
result_probe=$(mktemp)
rm -f "$result_probe"
VH_RELEASE_LIBRARY_ONLY=0 VH_RELEASE_RESULT_FILE="$result_probe" bash "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh" not-a-digest 0 switch >/dev/null 2>&1 || true
grep -Eq '^exit=[1-9][0-9]* phase=preflight$' "$result_probe" 2>/dev/null || fail 'an early remote failure must still write the result marker'
rm -f "$result_probe"
grep -Fq 'pull_image "$IMAGE"' "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh" || fail 'image pulls must go through the retrying pull_image'

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
