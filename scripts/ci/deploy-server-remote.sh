#!/usr/bin/env bash

set -euo pipefail

rewrite_compose_image() {
    local compose_file="$1" image="$2" next_file
    [[ "$image" =~ ^ghcr\.io/mereithhh/very-happy-server@sha256:[0-9a-f]{64}$ ]]
    next_file=$(mktemp "${compose_file}.XXXXXX")
    sed -E \
        -e "s#^([[:space:]]*image:)[[:space:]]*(very-happy-server|ghcr.io/mereithhh/very-happy-server)(:[^[:space:]]+|@sha256:[0-9a-f]{64})#\\1 $image#" \
        -e '\#/opt/happy/webapp:/repo/packages/happy-server/webapp:ro#d' \
        -e '\#/opt/happy-src/packages/happy-server/sources:/repo/packages/happy-server/sources:ro#d' \
        -e '\#/opt/happy-src/packages/happy-server/prisma/migrations:/repo/packages/happy-server/prisma/migrations:ro#d' \
        "$compose_file" > "$next_file"
    mv "$next_file" "$compose_file"
    grep -Fq "image: $image" "$compose_file"
    ! grep -Fq '/opt/happy/webapp:/repo/packages/happy-server/webapp:ro' "$compose_file"
    ! grep -Fq '/opt/happy-src/packages/happy-server/sources:/repo/packages/happy-server/sources:ro' "$compose_file"
    ! grep -Fq '/opt/happy-src/packages/happy-server/prisma/migrations:/repo/packages/happy-server/prisma/migrations:ro' "$compose_file"
}

if [ "${1:-}" = "--rewrite-compose-test" ]; then
    rewrite_compose_image "${2:?compose fixture is required}" "${3:?image digest is required}"
    exit 0
fi

IMAGE="${1:?server image is required}"
VERSION="${2:?40-character commit SHA is required}"
COMPOSE_DIR=/opt/happy
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
PUBLIC_ORIGIN=https://veryhappy.dev

[[ "$VERSION" =~ ^[0-9a-f]{40}$ ]]
[[ "$IMAGE" =~ ^ghcr\.io/mereithhh/very-happy-server@sha256:[0-9a-f]{64}$ ]]
test -f "$COMPOSE_FILE"

OLD_IMAGE=$(docker inspect happy-server --format '{{.Config.Image}}')
test -n "$OLD_IMAGE"
docker image inspect "$OLD_IMAGE" >/dev/null
echo "== server: pull immutable image =="
docker pull "$IMAGE"

echo "== server: verify packaged Prisma schema matches generated client =="
docker run --rm --entrypoint sh "$IMAGE" -c '
  package_schema=$(sha256sum /repo/packages/happy-server/prisma/schema.prisma | cut -d " " -f 1)
  client_schema=$(sha256sum /repo/node_modules/.prisma/client/schema.prisma | cut -d " " -f 1)
  test "$package_schema" = "$client_schema"
'

mkdir -p /opt/happy-rollbacks
ROLLBACK_DIR=$(mktemp -d "/opt/happy-rollbacks/${VERSION}.XXXXXX")
cp -a "$COMPOSE_FILE" "$ROLLBACK_DIR/docker-compose.yml"
echo "rollback compose prepared: $ROLLBACK_DIR/docker-compose.yml (previous image: $OLD_IMAGE)"

rollback() {
    local status=$?
    trap - ERR
    echo "ERROR: deployment failed; restoring previous Compose definition" >&2
    set +e
    cp -a "$ROLLBACK_DIR/docker-compose.yml" "$COMPOSE_FILE"
    (cd "$COMPOSE_DIR" && docker compose up -d --force-recreate happy-server)
    local restore_status=$?
    local restored_image
    restored_image=$(docker inspect happy-server --format '{{.Config.Image}}' 2>/dev/null)
    local restored_healthy=false
    for _ in $(seq 1 20); do
        if curl -fsS http://127.0.0.1:3005/health >/dev/null 2>&1; then
            restored_healthy=true
            break
        fi
        sleep 3
    done
    local restored_public=false
    for _ in $(seq 1 20); do
        if curl -fsS "$PUBLIC_ORIGIN/health" >/dev/null 2>&1; then
            restored_public=true
            break
        fi
        sleep 3
    done
    if [ "$restore_status" -ne 0 ] || [ "$restored_image" != "$OLD_IMAGE" ] \
        || [ "$restored_healthy" != true ] || [ "$restored_public" != true ]; then
        echo "FATAL: rollback verification failed (compose=$restore_status image=$restored_image local=$restored_healthy public=$restored_public)" >&2
        exit 70
    fi
    echo "rollback verified: $OLD_IMAGE" >&2
    exit "$status"
}
trap rollback ERR

echo "== server: switch Compose to the complete image =="
rewrite_compose_image "$COMPOSE_FILE" "$IMAGE"

(cd "$COMPOSE_DIR" && docker compose up -d --force-recreate happy-server)

echo "== server: wait for migration + local health =="
healthy=false
for _ in $(seq 1 40); do
    if curl -fsS http://127.0.0.1:3005/health >/dev/null 2>&1; then
        healthy=true
        break
    fi
    sleep 3
done
test "$healthy" = true
test "$(docker inspect happy-server --format '{{.Config.Image}}')" = "$IMAGE"

echo "== server: verify public health + Web asset =="
public_healthy=false
for _ in $(seq 1 20); do
    if curl -fsS "$PUBLIC_ORIGIN/health" >/dev/null 2>&1; then
        public_healthy=true
        break
    fi
    sleep 3
done
test "$public_healthy" = true
main_asset=$(curl -fsS "$PUBLIC_ORIGIN/" | grep -oE '/assets/[^\"]+\.js' | head -1)
test -n "$main_asset"
case "$main_asset" in
    *-"$VERSION".js) ;;
    *) echo "ERROR: public Web asset is not release $VERSION: $main_asset" >&2; false ;;
esac
content_type=$(curl -fsS -o /dev/null -w '%{content_type}' "$PUBLIC_ORIGIN$main_asset")
case "$content_type" in
    *javascript*) ;;
    *) echo "ERROR: public main asset is not JavaScript: $content_type" >&2; false ;;
esac

trap - ERR
echo "server live: $IMAGE"
echo "rollback compose: $ROLLBACK_DIR/docker-compose.yml (previous image: $OLD_IMAGE)"
