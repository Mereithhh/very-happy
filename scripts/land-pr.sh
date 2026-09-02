#!/bin/bash
# land-pr.sh <pr-number> [--no-merge] — wait for CI on a PR's CURRENT head and
# squash-merge it when green. Extracted from a session that hand-rolled this
# loop eight times (B-269..B-282); encodes the gotchas so agents stop
# rediscovering them:
#   * a PR with merge conflicts (mergeable_state=dirty) NEVER triggers the
#     pull_request workflows — waiting for CI there hangs forever; this exits
#     and tells you to rebase instead;
#   * `gh pr checks --watch` can bind to a STALE head right after a push —
#     runs are looked up by the head COMMIT, never by the PR;
#   * run-id lists must be iterated line-wise (zsh does not word-split
#     unquoted vars);
#   * branch protection re-checks lag after CI turns green — the merge is
#     retried a few times before giving up.
set -u
PR="${1:?usage: land-pr.sh <pr-number> [--no-merge]}"
NO_MERGE="${2:-}"
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

head_sha() { gh api "repos/$REPO/pulls/$PR" --jq .head.sha; }
state() { gh api "repos/$REPO/pulls/$PR" --jq .mergeable_state; }

H=$(head_sha)
echo "PR #$PR head ${H:0:8} state=$(state)"
case "$(state)" in
  dirty)
    echo "✗ merge conflict with base — rebase and push first (conflicted PRs never trigger CI)." >&2
    exit 2 ;;
  behind)
    # Strict required checks: an out-of-date branch cannot merge even with
    # green CI — rebasing (which re-runs CI) is the only way forward.
    echo "✗ branch is behind base — rebase and push first (strict status checks refuse stale heads)." >&2
    exit 2 ;;
esac

# Runs can take ~1 min to appear after a push.
RUNS=""
for _ in $(seq 1 12); do
  RUNS=$(gh run list --commit "$H" --json databaseId --jq '.[].databaseId')
  [ -n "$RUNS" ] && break
  sleep 10
done
if [ -z "$RUNS" ]; then
  echo "✗ no CI runs for ${H:0:8} (state=$(state)) — push again or check triggers." >&2
  exit 2
fi

FAILED=0
echo "$RUNS" | while read -r id; do
  [ -z "$id" ] && continue
  for _ in $(seq 1 90); do
    [ "$(gh run view "$id" --json status --jq .status)" = "completed" ] && break
    sleep 20
  done
  echo "run $id $(gh run view "$id" --json workflowName,conclusion --jq '.workflowName+" "+.conclusion')"
done
for id in $(echo "$RUNS"); do
  c=$(gh run view "$id" --json conclusion --jq .conclusion)
  if [ "$c" != "success" ] && [ "$c" != "skipped" ]; then
    FAILED=1
    echo "== failed log ($id)"
    gh run view "$id" --log-failed 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' \
      | grep -E "×|→ |error TS|AssertionError|FAIL" | cut -c1-400 | head -12
  fi
done
[ "$FAILED" = 1 ] && exit 1
[ "$NO_MERGE" = "--no-merge" ] && { echo "✓ CI green (merge skipped)"; exit 0; }

for _ in 1 2 3 4 5 6; do
  OUT=$(gh pr merge "$PR" --squash --delete-branch 2>&1 | tail -1)
  echo "merge: $OUT"
  echo "$OUT" | grep -qiE "admin|blocked|unable|not mergeable" || break
  sleep 30
done
sleep 5
M=$(gh api "repos/$REPO/pulls/$PR" --jq .merge_commit_sha)
S=$(gh api "repos/$REPO/pulls/$PR" --jq .state)
echo "merge=${M:0:8} state=$S"
[ "$S" = "closed" ] || exit 1
