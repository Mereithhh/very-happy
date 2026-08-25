---
name: release
description: Release and deploy very-happy: publish the very-happy-cli npm package from v* tags, deploy happy-web-v2 and happy-server to the active production host, update the mac-office daemon, verify production, and roll back. Use when asked to release, publish, deploy, ship, roll back, or update production.
---

# very-happy release

Production is `veryhappy.dev`: server + Web V2 on vh-us, published CLI on
npm, daemon on mac-office. `docs/operations.md` is the topology/runbook source;
`docs/PROCESS.md` is the gate/process source.

The only canonical source and release repository is the public GitHub repository
`Mereithhh/very-happy`. A private archive is read-only history: never push a
release commit or tag to it, and never trigger a deployment from it.

## Establish the target

Release targets are:

- `server`: publish and deploy the complete server image, including Web V2.
- `web`: deploy the same complete image; Web is not a host-mounted artifact.
- `cli`: publish `very-happy-cli` from a `vX.Y.Z` tag.
- `daemon`: install the published CLI and restart mac-office via `vh-update`.
- `all`: normally server → web → CLI → daemon, modified only by a spec's
  compatibility matrix.

Before any external mutation, show the intended commit/version, dirty-worktree
state, target and rollback point. Do not deploy unrelated local edits.

## Mandatory preflight

```bash
git status --short
git branch --show-current
git log -1 --oneline
RELEASE_ORIGIN=$(git remote get-url origin)
case "$RELEASE_ORIGIN" in
  https://github.com/Mereithhh/very-happy.git|git@github.com:Mereithhh/very-happy.git) ;;
  *) echo "refusing release from non-canonical origin: $RELEASE_ORIGIN" >&2; exit 1 ;;
esac
test "$(gh repo view Mereithhh/very-happy --json visibility --jq .visibility)" = PUBLIC
```

Run the exact gates in `AGENTS.md`. For CLI also run the built artifact:

```bash
HAPPY_HOME_DIR=$(mktemp -d) node packages/happy-cli/dist/index.mjs --version
```

Never release from a failing gate unless the user explicitly authorizes an
emergency exception after seeing the failure and rollback plan.

## Deploy server/Web

Preferred path:

```bash
git push origin main
# Wait at least 20 seconds for GitHub's ref to settle.
gh workflow run deploy-hwsg.yml --ref main -f target=all   # or web/server
gh run list --workflow=deploy-hwsg.yml --limit 3
gh run view <run-id> --json headSha,status,conclusion,url
```

`headSha` must equal the intended pushed commit. The workflow is deliberately
manual and deploys only checked-out repository state. Release from merged
`main`; do not assume pushing a feature branch changes the workflow's checkout.

The workflow publishes `ghcr.io/mereithhh/very-happy-server:<commit-sha>`, resolves
its manifest digest, and the remote host pulls that immutable digest. It promotes
the verified digest to `latest` only after production acceptance. Never restore
the old source-only overlay deployment: source, migrations, Prisma
schema/generated Client and Web must move together. The remote helper checks
Prisma consistency and force-recreates the container with a rollback copy of
Compose.

Environment changes are different: `docker compose restart` does not reread
`env_file`. Apply them through the verified `vh-us` local alias with:

```bash
ssh vh-us 'cd /opt/happy && docker compose up -d --force-recreate happy-server'
```

The legacy `hw-sg` SSH alias is not the control origin and must never be used
for production deployment. If `vh-us` is absent or does not resolve to the
current `veryhappy.dev` origin, stop and establish the exact target first.

After any server deploy, run `vh-update` on mac-office until backlog B-001 is
fixed, because a half-open daemon socket may fail to re-register RPCs.

## Publish CLI

The tag is the version source; do not hand-edit package.json for the normal CI
path:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
gh run list --workflow=publish.yml --limit 3
```

The tag also launches hosted cross-platform smoke jobs. npm publication and
smoke run concurrently, so npm availability is not sufficient release evidence.
Verify both:

```bash
npm view very-happy-cli@X.Y.Z version
gh run list --workflow=cli-smoke-test.yml --commit=<tag-sha>
```

Then update mac-office with `vh-update` (repository fallback:
`bash scripts/update-daemon.sh`) and confirm the running daemon version,
not only npm metadata. Never use `npm publish`, bare `npx`, `--ignore-scripts`,
or move/force an existing tag.

## Production verification

```bash
curl -fsS https://veryhappy.dev/health
VH_MAIN=$(curl -fsS https://veryhappy.dev/ | grep -oE '/assets/[^" ]+\.js' | head -1)
curl -fsSI "https://veryhappy.dev${VH_MAIN}" | grep -i '^content-type:.*javascript'
```

For browser acceptance, hard-refresh or unregister the service worker before
declaring a mixed-version failure. Complete relevant items in
`docs/verify-queue.md`.

## Rollback

- Web/server: redeploy the prior immutable image/commit, then update the daemon.
- CLI/daemon: `npm i -g very-happy-cli@<previous>` and restart the daemon.
- Database: migrations must be forward-compatible; never improvise a destructive
  down migration during an incident.

Report what was published/deployed, exact versions/SHAs, verification evidence,
and remaining manual acceptance. A successful build alone is not a release.
