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
gh workflow run deploy-hwsg.yml --ref main -f target=all -f rollout=switch
gh run list --workflow=deploy-hwsg.yml --limit 3
gh run view <run-id> --json headSha,status,conclusion,url
```

`headSha` must equal the intended pushed commit. The workflow is deliberately
manual and deploys only checked-out repository state. Release from merged
`main`; do not assume pushing a feature branch changes the workflow's checkout.

The workflow publishes `ghcr.io/mereithhh/very-happy-server:<commit-sha>`, resolves
its manifest digest, and the remote host pulls that immutable digest. Source,
migrations, Prisma schema/generated Client and Web move together. Choose the
rollout phase explicitly:

```bash
# One final interrupting bootstrap; only when /opt/happy/release/state.env is absent
gh workflow run deploy-hwsg.yml --ref main -f target=all -f rollout=groundwork
# Initial candidate proof; does not switch traffic or promote latest
gh workflow run deploy-hwsg.yml --ref main -f target=all -f rollout=shadow
# Initial switch of the same shadowed digest, then every normal later release
gh workflow run deploy-hwsg.yml --ref main -f target=all -f rollout=switch
```

Groundwork and switch promote only the verified active digest to `latest`;
shadow never does. The remote state machine requires Redis, an explicit Prisma
connection limit, Caddy ≥2.10.2 and host headroom. Candidate readiness includes
DB, Redis, adapter warmup and exact Web asset. A bidirectional cross-slot canary
is mandatory before Caddy changes. Never bypass these gates by restoring the old
single-container helper for a normal release.

If the packaged migration tree changed, review it for expand compatibility and
set `VH_RELEASE_MIGRATIONS_REVIEWED=<target commit>` in production before the
candidate run. The acknowledgement is commit-bound; never reuse a stale value.
Migration lock/statement timeouts fail candidate without changing active traffic.

Rollback is phase-aware: before drain, stop candidate only; after drain, cancel
the old slot's drain state; after an include write, restore/reload the old Caddy
include and retain both slots; after old shutdown, start old before switching
back. Never delete the retained candidate while it may own connections.

Environment changes are different: `docker compose restart` does not reread
`env_file`. Before groundwork only, the legacy command is:

```bash
ssh vh-us 'cd /opt/happy && docker compose up -d --force-recreate happy-server'
```

After groundwork, never use that command: deploy the active merged `main` with
`rollout=switch`, so candidate reads the new env while old remains available.

The legacy `hw-sg` SSH alias is not the control origin and must never be used
for production deployment. If `vh-us` is absent or does not resolve to the
current `veryhappy.dev` origin, stop and establish the exact target first.

After publishing a CLI that changes handover behavior, run `vh-update` on
mac-office. A normal blue-green Server/Web switch no longer requires restarting
the daemon: it opens candidate, waits for every `rpc-registered` acknowledgement,
then closes old. During the initial groundwork rollout, retain the old
`vh-update` safeguard until the new CLI is installed.

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
The publish workflow releases all six `very-happy-tools-<arch>-<os>` packages
before the main CLI, with one exact shared version. It is safe to rerun after a
partial publish; never publish the main package manually ahead of its platform
artifacts. Verify the main package, the platform artifact for the deployment
machine, and the smoke run:

```bash
npm view very-happy-cli@X.Y.Z version
npm view very-happy-tools-arm64-darwin@X.Y.Z version
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
