#!/bin/bash
# advance-auto-update.sh <X.Y.Z> [--dry-run]
#
# Advance the fleet's unattended-install version (`CLI_AUTO_UPDATE_VERSION`, B-351)
# to an already-promoted CLI release, and make production actually read it.
# This is the second of the two release decisions in the release skill —
# "recommend" moves by itself via npm `latest`; "install for people" is this
# script, invoked by a human on purpose. It does not publish anything.
#
# Steps (each one was hand-typed for 0.2.134 → 0.2.138 before this existed):
#   1. refuse unless npm `latest` already equals <X.Y.Z> (promote ran, smoke green);
#   2. on vh-sg: back up /opt/happy/.env, set CLI_AUTO_UPDATE_VERSION=<X.Y.Z>;
#   3. dispatch deploy-hwsg.yml rollout=switch on main (restart does not reread
#      env_file; only a candidate reads the new value), wait, check headSha;
#   4. verify https://veryhappy.dev/v1/version/cli reports autoUpdateVersion=<X.Y.Z>.
#
# Rollback: ssh vh-sg 'cp /opt/happy/.env.bak-<stamp> /opt/happy/.env' and run
# the same deploy again — the backup path is printed below.
set -euo pipefail

VERSION="${1:?usage: advance-auto-update.sh <X.Y.Z> [--dry-run]}"
DRY_RUN=""
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=1
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a X.Y.Z version: $VERSION" >&2; exit 2; }

HOST="${VH_SSH_HOST:-vh-sg}"
ENV_FILE=/opt/happy/.env
REPO="Mereithhh/very-happy"
API="https://veryhappy.dev/v1/version/cli"

say() { printf '%s\n' "$*"; }

say "== 1/4 npm latest must already be $VERSION"
LATEST=$(npm view very-happy-cli dist-tags.latest 2>/dev/null)
if [[ "$LATEST" != "$VERSION" ]]; then
  say "refusing: npm latest is '$LATEST', not $VERSION. promote has not moved the tag (smoke red, or still running) — read the publish run first." >&2
  exit 1
fi
CURRENT=$(curl -fsS "$API")
say "   live: $CURRENT"

say "== 2/4 pin CLI_AUTO_UPDATE_VERSION=$VERSION on $HOST:$ENV_FILE"
STAMP=$(date +%Y%m%d%H%M%S)
BACKUP="$ENV_FILE.bak-$STAMP"
if [[ -n "$DRY_RUN" ]]; then
  say "   [dry-run] would: cp -p $ENV_FILE $BACKUP && sed -i CLI_AUTO_UPDATE_VERSION=$VERSION"
else
  ssh "$HOST" "cp -p $ENV_FILE $BACKUP && sed -i 's|^#* *CLI_AUTO_UPDATE_VERSION=.*|CLI_AUTO_UPDATE_VERSION=$VERSION|' $ENV_FILE && grep -q '^CLI_AUTO_UPDATE_VERSION=$VERSION\$' $ENV_FILE"
  say "   pinned; backup: $HOST:$BACKUP"
fi

say "== 3/4 deploy main with rollout=switch so the candidate reads the new env"
MAIN_SHA=$(gh api "repos/$REPO/commits/main" --jq .sha)
if [[ -n "$DRY_RUN" ]]; then
  say "   [dry-run] would dispatch deploy-hwsg.yml on main ($MAIN_SHA)"
  exit 0
fi
gh workflow run deploy-hwsg.yml -R "$REPO" --ref main -f target=all -f rollout=switch >/dev/null
sleep 25
RUN_ID=""
for _ in $(seq 1 12); do
  RUN_ID=$(gh run list -R "$REPO" --workflow=deploy-hwsg.yml --limit 5 --json databaseId,headSha,createdAt \
    --jq "[.[] | select(.headSha==\"$MAIN_SHA\")] | sort_by(.createdAt) | last | .databaseId // empty")
  [[ -n "$RUN_ID" ]] && break
  sleep 10
done
[[ -n "$RUN_ID" ]] || { say "could not find the dispatched run for $MAIN_SHA; check gh run list" >&2; exit 1; }
say "   run $RUN_ID (headSha $MAIN_SHA) — waiting"
for _ in $(seq 1 120); do
  STATUS=$(gh run view -R "$REPO" "$RUN_ID" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null || echo "api-error")
  case "$STATUS" in completed*) break;; esac
  sleep 15
done
say "   deploy: $STATUS"
[[ "$STATUS" == "completed success" ]] || { say "deploy did not succeed; production env is pinned but not re-read. Inspect run $RUN_ID; rollback = restore $BACKUP and redeploy." >&2; exit 1; }

say "== 4/4 verify the relay advertises it"
AFTER=$(curl -fsS "$API")
say "   live: $AFTER"
echo "$AFTER" | grep -q "\"autoUpdateVersion\":\"$VERSION\"" || { say "autoUpdateVersion is not $VERSION after deploy" >&2; exit 1; }
say "done: machines will install $VERSION when idle. Running session wrappers are not replaced (铁律 7)."
