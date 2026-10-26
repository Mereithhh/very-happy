#!/usr/bin/env bash
# B-827: every production compose file rotates its container logs, and the
# deploy gate rejects each way of dropping that rotation.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CHECK="$REPO_ROOT/scripts/ci/check-log-rotation.sh"
PRODUCTION=(
    ops/production/docker-compose.blue-green.yml
    ops/production/docker-compose.base.yml
    ops/relay/docker-compose.us.yml
    ops/relay/docker-compose.sg.yml
)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "log rotation test failed: $*" >&2; exit 1; }

cd "$REPO_ROOT"
bash "$CHECK" "${PRODUCTION[@]}" >/dev/null || fail 'production compose files must pass'

# expect_reject <case> <file> <sed script> <service names reported>
expect_reject() {
    local name="$1" file="$2" script="$3" expected="$4" mutated="$work/$1.yml" out
    sed -E "$script" "$file" > "$mutated"
    cmp -s "$file" "$mutated" && fail "$name: mutation did not change $file"
    if out=$(bash "$CHECK" "$mutated" 2>&1); then fail "$name: gate accepted $file"; fi
    grep -Fq ": $expected" <<<"$out" || fail "$name: expected '$expected' in: $out"
}

expect_reject server-no-logging ops/production/docker-compose.blue-green.yml \
    '/^  logging:/,/max-file/d' 'happy-server-blue happy-server-green'
expect_reject server-no-max-size ops/production/docker-compose.blue-green.yml '/max-size:/d' 'happy-server-blue happy-server-green'
expect_reject pgbouncer-no-max-file ops/production/docker-compose.base.yml '/max-file:/d' 'vh-pgbouncer'
expect_reject pgbouncer-driver-none ops/production/docker-compose.base.yml 's/driver: json-file/driver: none/' 'vh-pgbouncer'
expect_reject relay-us-no-logging ops/relay/docker-compose.us.yml '/^    logging:/,/max-file/d' 'relay-us'
expect_reject relay-sg-bad-size ops/relay/docker-compose.sg.yml 's/max-size: 50m/max-size: unlimited/' 'relay-sg'

# The release script installs the repo's base compose (vh-pgbouncer) without
# applying it, keeps the replaced copy, and leaves the legacy layout alone.
export VH_RELEASE_LIBRARY_ONLY=1
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/ci/deploy-blue-green-remote.sh"
set +E; trap - ERR
RELEASE_DIR="$work/release" STATE_FILE="$work/release/state.env" BASE_COMPOSE="$work/base.yml"
mkdir -p "$RELEASE_DIR"
printf 'services: {}\n' > "$BASE_COMPOSE"
echo MODE=legacy > "$STATE_FILE"
sync_base_compose 2>/dev/null
grep -qx 'services: {}' "$BASE_COMPOSE" || fail 'legacy mode must not replace the base compose'
echo MODE=bluegreen > "$STATE_FILE"
sync_base_compose 2>/dev/null
cmp -s ops/production/docker-compose.base.yml "$BASE_COMPOSE" || fail 'blue-green mode must install the base compose'
backups=("$RELEASE_DIR"/base-compose-backups/*.yml)
[ "${#backups[@]}" -eq 1 ] && grep -qx 'services: {}' "${backups[0]}" || fail 'replaced base compose must be kept'
sync_base_compose 2>/dev/null
backups=("$RELEASE_DIR"/base-compose-backups/*.yml)
[ "${#backups[@]}" -eq 1 ] && grep -qx 'services: {}' "${backups[0]}" \
    || fail 'an unchanged base compose must not be backed up or reinstalled again'

# Wiring: each deploy path runs the gate before it touches a container.
sed -n '/flock -n 9/,/case "\$ROLLOUT"/p' scripts/ci/deploy-blue-green-remote.sh | grep -qx '    check_log_rotation' \
    || fail 'release script must run check_log_rotation after taking the deploy lock'
grep -q 'check-log-rotation.sh ops/production/docker-compose.blue-green.yml ops/production/docker-compose.base.yml' scripts/ci/deploy-hwsg.sh \
    || fail 'deploy-hwsg must gate both production compose files before shipping'
for shipped in scripts/ci/check-log-rotation.sh scripts/ci/log-rotation.jq ops/production/docker-compose.base.yml; do
    grep -Eq "^ +$shipped \\\\$" scripts/ci/deploy-hwsg.sh || fail "deploy-hwsg must ship $shipped to the host"
done
sed -n '/^deploy_docker()/,/^}/p' scripts/ci/deploy-relays.sh | grep -Fq 'check-log-rotation.sh "ops/relay/docker-compose.$region.yml"' \
    || fail 'deploy-relays must gate the relay compose before pulling'

echo 'log rotation gate ok'
