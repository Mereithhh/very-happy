#!/usr/bin/env bash

set -Eeuo pipefail

VH_RELEASE_LIBRARY_ONLY="${VH_RELEASE_LIBRARY_ONLY:-0}"
IMAGE="${1:-}"
VERSION="${2:-}"
ROLLOUT="${3:-}"
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RELEASE_DIR=/opt/happy/release
STATE_FILE="$RELEASE_DIR/state.env"
SLOT_ENV="$RELEASE_DIR/slots.env"
RELEASE_COMPOSE="$RELEASE_DIR/docker-compose.yml"
LEGACY_OVERRIDE="$RELEASE_DIR/legacy-release.override.yml"
CADDY_FILE=/etc/caddy/Caddyfile
ACTIVE_INCLUDE="$RELEASE_DIR/active-upstream.caddy"
PUBLIC_ORIGIN=https://veryhappy.dev
PUBLIC_HOST=${PUBLIC_ORIGIN#https://}
PRODUCTION_ENV_FILE="${VH_PRODUCTION_ENV_FILE:-/opt/happy/.env}"
PROBE_FAILURES=""
PROBE_PID=""
PROBE_ORIGIN_FAILURES=""
PROBE_ORIGIN_PID=""
# B-307: a release fails on this many CONSECUTIVE failed samples, not on one
# failed sample anywhere in the window. See start_http_probe.
PROBE_MAX_STREAK="${VH_RELEASE_PROBE_MAX_STREAK:-3}"
PROBE_INTERVAL_SECONDS="${VH_RELEASE_PROBE_INTERVAL:-0.2}"
PHASE=before-switch
CANDIDATE_STARTED=false

if [ "$VH_RELEASE_LIBRARY_ONLY" != 1 ]; then
    [[ "$IMAGE" =~ ^ghcr\.io/mereithhh/very-happy-server@sha256:[0-9a-f]{64}$ ]]
    [[ "$VERSION" =~ ^[0-9a-f]{40}$ ]]
    case "$ROLLOUT" in groundwork|shadow|switch) ;; *) echo "invalid rollout mode: $ROLLOUT" >&2; exit 2 ;; esac

    for command in curl docker caddy systemctl awk sed grep mktemp od sort head df sha256sum wc tr install seq find xargs cut; do
        command -v "$command" >/dev/null 2>&1 || { echo "missing production dependency: $command" >&2; exit 2; }
    done
fi

version_at_least() {
    local current="$1" required="$2"
    [ "$(printf '%s\n%s\n' "$required" "$current" | sort -V | head -1)" = "$required" ]
}

validate_host_contract() {
    local caddy_version
    caddy_version=$(caddy version | sed -E 's/^v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
    version_at_least "$caddy_version" 2.10.2 || {
        echo "Caddy >= 2.10.2 is required; found $caddy_version" >&2
        exit 3
    }
    grep -Eq '^REDIS_URL=.+$' "$PRODUCTION_ENV_FILE" || { echo 'REDIS_URL is required for blue-green releases' >&2; exit 3; }
    grep -Eq '^DATABASE_URL=.*connection_limit=[0-9]+' "$PRODUCTION_ENV_FILE" || {
        echo 'DATABASE_URL must declare an explicit connection_limit before two slots may run' >&2
        exit 3
    }
    [ "$(df -Pk /opt/happy | awk 'NR==2 {print $4}')" -ge 5242880 ] || { echo 'less than 5 GiB free disk' >&2; exit 3; }
    [ "$(awk '/MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)" -ge 1024 ] || { echo 'less than 1 GiB available memory' >&2; exit 3; }
}

rewrite_compose_image() {
    local compose_file="$1" image="$2" next_file
    next_file=$(mktemp "${compose_file}.XXXXXX")
    sed -E \
        -e "s#^([[:space:]]*image:)[[:space:]]*(very-happy-server|ghcr.io/mereithhh/very-happy-server)(:[^[:space:]]+|@sha256:[0-9a-f]{64})#\\1 $image#" \
        -e '\#/opt/happy/webapp:/repo/packages/happy-server/webapp:ro#d' \
        -e '\#/opt/happy-src/packages/happy-server/sources:/repo/packages/happy-server/sources:ro#d' \
        -e '\#/opt/happy-src/packages/happy-server/prisma/migrations:/repo/packages/happy-server/prisma/migrations:ro#d' \
        "$compose_file" > "$next_file"
    mv "$next_file" "$compose_file"
    grep -Fq "image: $image" "$compose_file"
}

verify_image() {
    docker pull "$IMAGE" >/dev/null
    docker run --rm --entrypoint sh "$IMAGE" -c '
      package_schema=$(sha256sum /repo/packages/happy-server/prisma/schema.prisma | cut -d " " -f 1)
      client_schema=$(sha256sum /repo/node_modules/.prisma/client/schema.prisma | cut -d " " -f 1)
      test "$package_schema" = "$client_schema"
    '
}

migration_tree_digest() {
    local image="$1"
    docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
    docker run --rm --entrypoint sh "$image" -c '
      find /repo/packages/happy-server/prisma/migrations -type f -print0 \
        | sort -z \
        | xargs -0 sha256sum \
        | sha256sum \
        | cut -d " " -f 1
    '
}

verify_migration_contract() {
    local active_digest candidate_digest
    active_digest=$(migration_tree_digest "$ACTIVE_IMAGE")
    candidate_digest=$(migration_tree_digest "$IMAGE")
    if [ "$active_digest" = "$candidate_digest" ]; then return 0; fi
    grep -Fqx "VH_RELEASE_MIGRATIONS_REVIEWED=$VERSION" "$PRODUCTION_ENV_FILE" || {
        echo "migration tree changed; set VH_RELEASE_MIGRATIONS_REVIEWED to the reviewed target commit" >&2
        return 1
    }
}

initialize_release_files() {
    # Caddy's systemd service runs as the unprivileged `caddy` user and must
    # traverse this directory to import active-upstream.caddy. Sensitive files
    # inside remain 0600; only the generated include is 0644.
    install -d -m 755 "$RELEASE_DIR"
    install -m 600 "$REPO_ROOT/ops/production/docker-compose.blue-green.yml" "$RELEASE_COMPOSE"
    install -m 600 "$REPO_ROOT/ops/production/legacy-release.override.yml" "$LEGACY_OVERRIDE"
    if [ ! -f "$RELEASE_DIR/admin-token" ]; then
        umask 077
        od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$RELEASE_DIR/admin-token"
    fi
    [ "$(wc -c < "$RELEASE_DIR/admin-token" | tr -d ' ')" -ge 64 ]
}

load_state() {
    test -f "$STATE_FILE"
    # shellcheck disable=SC1090
    source "$STATE_FILE"
    [[ "${ACTIVE_SLOT:-}" =~ ^(blue|green)$ ]]
    [[ "${ACTIVE_PORT:-}" =~ ^(3005|3101|3102)$ ]]
    [[ "${ACTIVE_IMAGE:-}" =~ ^ghcr\.io/mereithhh/very-happy-server@sha256:[0-9a-f]{64}$ ]]
    [[ "${ACTIVE_RELEASE:-}" =~ ^[0-9a-f]{40}$ ]]
    [[ "${MODE:-}" =~ ^(legacy|bluegreen)$ ]]
    RELEASE_GENERATION="${RELEASE_GENERATION:-0}"
    [[ "$RELEASE_GENERATION" =~ ^[0-9]+$ ]]
}

write_state() {
    local next
    next=$(mktemp "$RELEASE_DIR/state.env.XXXXXX")
    {
        printf 'MODE=%s\n' "$MODE"
        printf 'ACTIVE_SLOT=%s\n' "$ACTIVE_SLOT"
        printf 'ACTIVE_PORT=%s\n' "$ACTIVE_PORT"
        printf 'ACTIVE_IMAGE=%s\n' "$ACTIVE_IMAGE"
        printf 'ACTIVE_RELEASE=%s\n' "$ACTIVE_RELEASE"
        printf 'ROLLBACK_SLOT=%s\n' "${ROLLBACK_SLOT:-}"
        printf 'ROLLBACK_PORT=%s\n' "${ROLLBACK_PORT:-}"
        printf 'ROLLBACK_IMAGE=%s\n' "${ROLLBACK_IMAGE:-}"
        printf 'ROLLBACK_RELEASE=%s\n' "${ROLLBACK_RELEASE:-}"
        printf 'SHADOW_IMAGE=%s\n' "${SHADOW_IMAGE:-}"
        printf 'SHADOW_RELEASE=%s\n' "${SHADOW_RELEASE:-}"
        printf 'RELEASE_GENERATION=%s\n' "${RELEASE_GENERATION:-0}"
    } > "$next"
    chmod 600 "$next"
    mv "$next" "$STATE_FILE"
}

slot_port() {
    case "$1" in blue) echo 3101 ;; green) echo 3102 ;; *) return 1 ;; esac
}

inactive_slot() {
    case "$1" in blue) echo green ;; green) echo blue ;; *) return 1 ;; esac
}

release_epoch() {
    local generation="$1" release="$2"
    [[ "$generation" =~ ^[0-9]+$ ]]
    [[ "$release" =~ ^[0-9a-f]{40}$ ]]
    printf 'release-%020d-%s' "$generation" "${release:0:12}"
}

write_slot_env() {
    local target_slot="$1" target_image="$2" target_release="$3"
    local blue_image="$ACTIVE_IMAGE" blue_sha="$ACTIVE_RELEASE" green_image="$ACTIVE_IMAGE" green_sha="$ACTIVE_RELEASE"
    if [ "$ACTIVE_SLOT" = green ]; then green_image="$ACTIVE_IMAGE"; green_sha="$ACTIVE_RELEASE"; fi
    if [ "$target_slot" = blue ]; then blue_image="$target_image"; blue_sha="$target_release"; else green_image="$target_image"; green_sha="$target_release"; fi
    local next
    next=$(mktemp "$RELEASE_DIR/slots.env.XXXXXX")
    {
        printf 'VH_BLUE_IMAGE=%s\n' "$blue_image"
        printf 'VH_BLUE_SHA=%s\n' "$blue_sha"
        printf 'VH_GREEN_IMAGE=%s\n' "$green_image"
        printf 'VH_GREEN_SHA=%s\n' "$green_sha"
        printf 'VH_RELEASE_ADMIN_TOKEN=%s\n' "$(<"$RELEASE_DIR/admin-token")"
    } > "$next"
    chmod 600 "$next"
    mv "$next" "$SLOT_ENV"
}

admin_curl() {
    local port="$1" method="$2" path="$3" body="${4:-}"
    local args=(-fsS --max-time 15 -X "$method" -H "X-VH-Release-Token: $(<"$RELEASE_DIR/admin-token")")
    if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
    curl "${args[@]}" "http://127.0.0.1:${port}${path}"
}

wait_ready() {
    local port="$1" slot="$2" release="$3" body ready=false
    for _ in $(seq 1 60); do
        body=$(admin_curl "$port" GET /_vh/release/ready 2>/dev/null || true)
        if printf '%s' "$body" | grep -Fq '"status":"ready"' \
            && printf '%s' "$body" | grep -Fq "\"slot\":\"$slot\"" \
            && printf '%s' "$body" | grep -Fq "\"release\":\"$release\"" \
            && printf '%s' "$body" | grep -Fq -- "-$release.js"; then
            ready=true
            break
        fi
        sleep 2
    done
    [ "$ready" = true ]
}

verify_direct_asset() {
    local port="$1" release="$2" asset content_type
    asset=$(curl -fsS "http://127.0.0.1:${port}/" | grep -oE '/assets/[^\"]+\.js' | head -1)
    case "$asset" in *-"$release".js) ;; *) echo "candidate asset mismatch: $asset" >&2; return 1 ;; esac
    content_type=$(curl -fsS -o /dev/null -w '%{content_type}' "http://127.0.0.1:${port}${asset}")
    case "$content_type" in *javascript*) ;; *) return 1 ;; esac
}

# The canary rides the socket.io Redis adapter; a slot that just booted can
# answer /_vh/release/ready before its peers see it, and the first
# serverSideEmitWithAck then times out (503 after ~5s — 2026-09-02 run
# 33605152182 failed before-switch exactly this way while a retry moments later
# was fine). Retry a bounded number of times; both directions must succeed in
# the same attempt.
verify_cross_slot() {
    local first_port="$1" second_port="$2" first second attempt
    local attempts="${VH_RELEASE_CANARY_ATTEMPTS:-6}"
    for attempt in $(seq 1 "$attempts"); do
        first=$(admin_curl "$first_port" POST /_vh/release/canary 2>/dev/null || true)
        second=$(admin_curl "$second_port" POST /_vh/release/canary 2>/dev/null || true)
        if printf '%s' "$first" | grep -Fq '"status":"ok"' \
            && printf '%s' "$second" | grep -Fq '"status":"ok"'; then
            return 0
        fi
        echo "cross-slot canary attempt $attempt/$attempts failed; retrying" >&2
        sleep 3
    done
    echo "cross-slot canary failed after $attempts attempts" >&2
    return 1
}

write_active_upstream() {
    local port="$1" next
    [[ "$port" =~ ^(3005|3101|3102)$ ]]
    next=$(mktemp "$RELEASE_DIR/active-upstream.caddy.XXXXXX")
    printf 'reverse_proxy 127.0.0.1:%s\n' "$port" > "$next"
    chmod 644 "$next"
    mv "$next" "$ACTIVE_INCLUDE"
}

reload_caddy() {
    caddy validate --config "$CADDY_FILE"
    systemctl reload caddy
}

verify_public_release() {
    local release="$1" healthy=false asset
    for _ in $(seq 1 30); do
        if curl -fsS --max-time 3 "$PUBLIC_ORIGIN/health" >/dev/null 2>&1; then healthy=true; break; fi
        sleep 1
    done
    [ "$healthy" = true ]
    asset=$(curl -fsS "$PUBLIC_ORIGIN/" | grep -oE '/assets/[^\"]+\.js' | head -1)
    case "$asset" in *-"$release".js) ;; *) echo "public asset mismatch: $asset" >&2; return 1 ;; esac
}

# B-307 — why this probe is not zero tolerance any more.
#
# `veryhappy.dev` resolves to Cloudflare from this host, not to the host itself,
# so every sample traverses host -> Cloudflare edge -> origin -> back. Measured
# on an idle production host with nothing deploying: 6 failures in 2400 samples
# over the public path (all `curl (28) ... 0 bytes received`, while p99 latency
# was 0.30s against a 2s timeout — dropped requests, not slow ones), against 0
# failures in 1800 samples over the same Caddy and slots with Cloudflare taken
# out of the path. Failures arrive in bursts and predominantly over IPv6.
#
# A window running at 5 samples/s for minutes therefore fails a coin toss, and
# four releases died that way (2026-09-01/02/03). Two of those four failed on a
# sample recorded BEFORE the Caddy include was even written — public traffic was
# still being served by the old, untouched slot, so the candidate could not have
# been responsible.
#
# A genuinely broken switch does not drop one request; it is continuously
# unavailable. So the verdict is now the longest run of CONSECUTIVE failures:
# `PROBE_MAX_STREAK` samples at `PROBE_INTERVAL_SECONDS` apart is 600ms of
# uninterrupted unavailability by default, which still catches a real outage
# inside a second, while every one of the four historical false failures (three
# isolated samples, one pair 2.24s apart) passes.
#
# A second probe runs against the origin directly, bypassing Cloudflare, because
# that is the part a release actually controls. Both records name their path, so
# triage no longer means correlating bare timestamps against the workflow log.
_probe_loop() {
    local record="$1"; shift
    local sample=0 rc err
    while true; do
        sample=$((sample + 1))
        rc=0
        err=$(curl "$@" -fsS --max-time 2 -o /dev/null "$PUBLIC_ORIGIN/health" 2>&1) || rc=$?
        if [ "$rc" -ne 0 ]; then
            printf '%s %s %s %s\n' "$sample" "$(date +%s%3N)" "$rc" \
                "$(printf '%s' "$err" | tr '\n\t' '  ')" >> "$record"
        fi
        sleep "$PROBE_INTERVAL_SECONDS"
    done
}

start_http_probe() {
    PROBE_FAILURES=$(mktemp "$RELEASE_DIR/http-probe.public.XXXXXX")
    PROBE_ORIGIN_FAILURES=$(mktemp "$RELEASE_DIR/http-probe.origin.XXXXXX")
    _probe_loop "$PROBE_FAILURES" &
    PROBE_PID=$!
    _probe_loop "$PROBE_ORIGIN_FAILURES" --resolve "$PUBLIC_HOST:443:127.0.0.1" &
    PROBE_ORIGIN_PID=$!
}

stop_http_probe() {
    if [ -n "$PROBE_PID" ]; then kill "$PROBE_PID" 2>/dev/null || true; wait "$PROBE_PID" 2>/dev/null || true; PROBE_PID=""; fi
    if [ -n "$PROBE_ORIGIN_PID" ]; then kill "$PROBE_ORIGIN_PID" 2>/dev/null || true; wait "$PROBE_ORIGIN_PID" 2>/dev/null || true; PROBE_ORIGIN_PID=""; fi
}

# Longest run of consecutive sample numbers in a probe record (0 when clean).
probe_longest_streak() {
    local record="$1"
    [ -s "$record" ] || { echo 0; return 0; }
    awk '{ if ($1 == prev + 1) run++; else run = 1; prev = $1; if (run > max) max = run } END { print max + 0 }' "$record"
}

probe_verdict() {
    local record="$1" label="$2" streak
    streak=$(probe_longest_streak "$record")
    if [ "$streak" -ge "$PROBE_MAX_STREAK" ]; then
        echo "HTTP probe observed a release-window failure ($label path: $streak consecutive failed samples)" >&2
        return 1
    fi
    if [ -s "$record" ]; then
        echo "note: $label path recorded $(wc -l < "$record") isolated failed sample(s), longest streak $streak (limit $PROBE_MAX_STREAK); not a release failure" >&2
    fi
    return 0
}

probe_release_verdict() {
    probe_verdict "$PROBE_FAILURES" public || return 1
    probe_verdict "$PROBE_ORIGIN_FAILURES" origin || return 1
}

slot_compose() {
    docker compose -f "$RELEASE_COMPOSE" --env-file "$SLOT_ENV" "$@"
}

start_candidate() {
    CANDIDATE_SLOT=$(inactive_slot "$ACTIVE_SLOT")
    CANDIDATE_PORT=$(slot_port "$CANDIDATE_SLOT")
    CANDIDATE_SERVICE="happy-server-$CANDIDATE_SLOT"
    verify_migration_contract
    write_slot_env "$CANDIDATE_SLOT" "$IMAGE" "$VERSION"
    slot_compose up -d --force-recreate "$CANDIDATE_SERVICE"
    CANDIDATE_STARTED=true
    wait_ready "$CANDIDATE_PORT" "$CANDIDATE_SLOT" "$VERSION"
    verify_direct_asset "$CANDIDATE_PORT" "$VERSION"
    verify_cross_slot "$ACTIVE_PORT" "$CANDIDATE_PORT"
}

stop_candidate() {
    [ "$CANDIDATE_STARTED" = true ] || return 0
    slot_compose stop "$CANDIDATE_SERVICE" >/dev/null 2>&1 || true
    CANDIDATE_STARTED=false
}

start_old_slot() {
    if [ "$MODE" = legacy ]; then
        docker compose -f /opt/happy/docker-compose.yml -f "$LEGACY_OVERRIDE" --env-file "$SLOT_ENV" up -d --no-deps happy-server
    else
        slot_compose up -d "happy-server-$ACTIVE_SLOT"
    fi
    wait_ready "$ACTIVE_PORT" "$ACTIVE_SLOT" "$ACTIVE_RELEASE"
}

stop_old_slot() {
    if [ "$MODE" = legacy ]; then
        docker compose -f /opt/happy/docker-compose.yml -f "$LEGACY_OVERRIDE" --env-file "$SLOT_ENV" stop happy-server
    else
        slot_compose stop "happy-server-$ACTIVE_SLOT"
    fi
}

rollback_switch() {
    local original_status=$?
    trap - ERR
    set +e
    stop_http_probe
    echo "deployment failed in phase $PHASE; restoring active upstream" >&2
    if [ "$PHASE" = after-old-stop ]; then start_old_slot; fi
    if [ "$PHASE" != before-switch ]; then
        # Reset the old slot's drain state before it becomes the default again.
        # after-old-stop already restarted the process, so this is idempotent.
        admin_curl "$ACTIVE_PORT" POST /_vh/release/cancel >/dev/null || true
    fi
    if [ "$PHASE" = after-switch-write ] || [ "$PHASE" = after-switch ] || [ "$PHASE" = after-old-stop ]; then
        write_active_upstream "$ACTIVE_PORT"
        reload_caddy
        verify_public_release "$ACTIVE_RELEASE"
        echo 'rollback upstream verified; both slots retained for inspection' >&2
    else
        stop_candidate
    fi
    exit "$original_status"
}

groundwork() {
    [ ! -f "$STATE_FILE" ] || { echo 'groundwork already initialized' >&2; exit 4; }
    local rollback_dir old_image
    install -d -m 700 /opt/happy-rollbacks
    rollback_dir=$(mktemp -d "/opt/happy-rollbacks/${VERSION}.groundwork.XXXXXX")
    cp -a /opt/happy/docker-compose.yml "$rollback_dir/docker-compose.yml"
    cp -a "$CADDY_FILE" "$rollback_dir/Caddyfile"
    old_image=$(docker inspect happy-server --format '{{.Config.Image}}')
    ACTIVE_IMAGE="$old_image"
    verify_migration_contract
    rewrite_compose_image /opt/happy/docker-compose.yml "$IMAGE"
    MODE=legacy ACTIVE_SLOT=blue ACTIVE_PORT=3005 ACTIVE_IMAGE="$IMAGE" ACTIVE_RELEASE="$VERSION"
    ROLLBACK_SLOT=blue ROLLBACK_PORT=3005 ROLLBACK_IMAGE="$old_image" ROLLBACK_RELEASE=""
    SHADOW_IMAGE="" SHADOW_RELEASE=""
    RELEASE_GENERATION=0
    write_slot_env blue "$IMAGE" "$VERSION"
    local failed=true
    rollback_groundwork() {
        local status=$?
        trap - ERR
        if [ "$failed" = true ]; then
            cp -a "$rollback_dir/docker-compose.yml" /opt/happy/docker-compose.yml
            cp -a "$rollback_dir/Caddyfile" "$CADDY_FILE"
            # The database and Redis are shared infrastructure. Recreating
            # either during rollback extends the outage and is unnecessary.
            docker compose -f /opt/happy/docker-compose.yml up -d --no-deps --force-recreate happy-server || true
            reload_caddy || true
        fi
        exit "$status"
    }
    trap rollback_groundwork ERR
    # Groundwork intentionally recreates the legacy server once, but never its
    # PostgreSQL/Redis dependencies.
    docker compose -f /opt/happy/docker-compose.yml -f "$LEGACY_OVERRIDE" --env-file "$SLOT_ENV" up -d --no-deps --force-recreate happy-server
    wait_ready 3005 blue "$VERSION"
    verify_direct_asset 3005 "$VERSION"
    write_active_upstream 3005
    install -m 644 "$REPO_ROOT/ops/production/Caddyfile.blue-green" "$CADDY_FILE"
    reload_caddy
    verify_public_release "$VERSION"
    write_state
    failed=false
    trap - ERR
    echo "groundwork live: blue legacy $IMAGE"
    echo "rollback snapshot: $rollback_dir"
}

shadow() {
    load_state
    [ "$MODE" = legacy ] || { echo 'shadow is only required for initial legacy transition' >&2; exit 4; }
    trap 'stop_http_probe; stop_candidate' ERR
    start_http_probe
    start_candidate
    stop_candidate
    stop_http_probe
    probe_release_verdict || exit 5
    SHADOW_IMAGE="$IMAGE" SHADOW_RELEASE="$VERSION"
    write_state
    trap - ERR
    echo "shadow verified: $IMAGE"
}

switch_release() {
    load_state
    if [ "$MODE" = legacy ]; then
        [ "${SHADOW_IMAGE:-}" = "$IMAGE" ] && [ "${SHADOW_RELEASE:-}" = "$VERSION" ] || {
            echo 'initial blue-green activation requires a successful shadow run of the same image' >&2
            exit 4
        }
    fi
    # Allocate and persist an attempt generation before any candidate work.
    # Failed attempts consume a generation, so a retained failed candidate can
    # never outrank a later retry in rpcHandler's lexical epoch ordering.
    RELEASE_GENERATION=$((RELEASE_GENERATION + 1))
    write_state
    trap rollback_switch ERR
    start_http_probe
    start_candidate
    local epoch deadline drain_seconds pre_switch_seconds body status drained=false
    # rpcHandler compares epochs lexicographically. A persisted, zero-padded
    # generation is monotonic across retries and immune to wall-clock rollback.
    epoch=$(release_epoch "$RELEASE_GENERATION" "$VERSION")
    drain_seconds="${VH_RELEASE_DRAIN_SECONDS:-600}"
    [[ "$drain_seconds" =~ ^[0-9]+$ ]] && [ "$drain_seconds" -ge 30 ] && [ "$drain_seconds" -le 1800 ]
    deadline=$(( ($(date +%s) + drain_seconds) * 1000 ))
    body=$(printf '{"epoch":"%s","toRelease":"%s","candidateSlot":"%s","deadline":%s}' "$epoch" "$VERSION" "$CANDIDATE_SLOT" "$deadline")
    admin_curl "$ACTIVE_PORT" POST /_vh/release/drain "$body" >/dev/null
    PHASE=after-drain
    pre_switch_seconds="${VH_RELEASE_PRE_SWITCH_SECONDS:-10}"
    [[ "$pre_switch_seconds" =~ ^[0-9]+$ ]] && [ "$pre_switch_seconds" -ge 2 ] && [ "$pre_switch_seconds" -le 60 ]
    sleep "$pre_switch_seconds"

    write_active_upstream "$CANDIDATE_PORT"
    PHASE=after-switch-write
    reload_caddy
    PHASE=after-switch
    verify_public_release "$VERSION"

    while [ "$(date +%s)" -lt "$((deadline / 1000))" ]; do
        status=$(admin_curl "$ACTIVE_PORT" GET /_vh/release/status || true)
        if printf '%s' "$status" | grep -Fq '"state":"drained"'; then drained=true; break; fi
        sleep 2
    done
    if [ "$drained" != true ]; then
        admin_curl "$ACTIVE_PORT" POST /_vh/release/disconnect >/dev/null
        for _ in $(seq 1 30); do
            status=$(admin_curl "$ACTIVE_PORT" GET /_vh/release/status || true)
            if printf '%s' "$status" | grep -Fq '"state":"drained"'; then drained=true; break; fi
            sleep 1
        done
    fi
    [ "$drained" = true ]

    stop_old_slot
    PHASE=after-old-stop
    verify_public_release "$VERSION"
    stop_http_probe
    probe_release_verdict

    ROLLBACK_SLOT="$ACTIVE_SLOT" ROLLBACK_PORT="$ACTIVE_PORT" ROLLBACK_IMAGE="$ACTIVE_IMAGE" ROLLBACK_RELEASE="$ACTIVE_RELEASE"
    MODE=bluegreen ACTIVE_SLOT="$CANDIDATE_SLOT" ACTIVE_PORT="$CANDIDATE_PORT" ACTIVE_IMAGE="$IMAGE" ACTIVE_RELEASE="$VERSION"
    SHADOW_IMAGE="" SHADOW_RELEASE=""
    write_state
    CANDIDATE_STARTED=false
    trap - ERR
    echo "blue-green live: $ACTIVE_SLOT $IMAGE"
    echo "rollback slot: $ROLLBACK_SLOT $ROLLBACK_IMAGE"
}

if [ "$VH_RELEASE_LIBRARY_ONLY" != 1 ]; then
    validate_host_contract
    verify_image
    initialize_release_files

    case "$ROLLOUT" in
        groundwork) groundwork ;;
        shadow) shadow ;;
        switch) switch_release ;;
    esac
fi
