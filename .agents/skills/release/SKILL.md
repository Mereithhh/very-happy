---
name: release
description: >-
  Release and deploy very-happy: publish the very-happy-cli npm package from v* tags, deploy happy-web-v2 and happy-server to the active production host, update the daemon hosts (mac-office, dev-sg), verify production, and roll back. Use when asked to release, publish, deploy, ship, roll back, or update production.
---

# very-happy release

Production is `veryhappy.dev`: server + Web V2 on vh-sg (AWS Singapore), published CLI on
npm, daemons on mac-office (launchd) and dev-sg (systemd user unit).
`docs/operations.md` is the topology/runbook source;
`docs/PROCESS.md` is the gate/process source.

The only canonical source and release repository is the public GitHub repository
`Mereithhh/very-happy`. A private archive is read-only history: never push a
release commit or tag to it, and never trigger a deployment from it.

## Establish the target

Release targets are:

- `server`: publish and deploy the complete server image, including Web V2.
- `web`: deploy the same complete image; Web is not a host-mounted artifact.
- `cli`: publish `very-happy-cli` from a `vX.Y.Z` tag.
- `daemon`: install the published CLI on the daemon hosts: mac-office via
  `vh-update` + launchd re-adopt, dev-sg per `ops/dev-sg/README.md`.
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

### Changelog coverage (run locally BEFORE tagging or dispatching)

Every release must carry its `CHANGELOG_RELEASES` entry
(`packages/happy-web-v2/src/app/changelogRelease.ts` + text keys). CI enforces
it — `deploy-hwsg.yml` and `publish.yml` both fail without it — but a failed
`v*` tag burns a version number, so run the same script first:

```bash
# Server/Web: diff the target SHA against the release currently live
# (read from the public entry asset name, no credentials needed).
node scripts/changelog/check-release.mjs --mode web --live https://veryhappy.dev --sha <sha>
# CLI: user-facing commits under packages/happy-cli|happy-wire since the
# previous v* tag require an entry with cliVersion '<X.Y.Z>'.
node scripts/changelog/check-release.mjs --mode cli --version X.Y.Z --sha <sha>
```

Keep `id` and `cliVersion` on their own lines in each release entry: the current
release scanner matches those fields at line starts. Verify both release modes
before the merge that will be tagged.

`FAIL` prints the conventional-commit draft: write the entry (id, title,
summary, items; `cliVersion` when a CLI ships), merge it, re-lock the SHA.
Escape hatches are explicit and logged — deploy input `changelog=skip` with a
mandatory `changelog_skip_reason`, or for CLI an annotated tag whose message
contains `[changelog-skip: <reason>]`. Use them only for changes with no
user-visible effect; the rollback path (live SHA not an ancestor of the
target) always needs the explicit skip.

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
shadow never does. A switch reloads Caddy, which reconnects every WebSocket at
once; B-494 bounds the socket.io recovery that follows (operations §socket.io
Redis stream and recovery bounds). Do not reload Caddy outside a release casually. The remote state machine requires Redis, an explicit Prisma
connection limit, Caddy ≥2.10.2 and host headroom. Candidate readiness includes
DB, Redis, adapter warmup and exact Web asset. A bidirectional cross-slot canary
is mandatory before Caddy changes. Never bypass these gates by restoring the old
single-container helper for a normal release.

If the packaged migration tree changed, review it for expand compatibility and
set `VH_RELEASE_MIGRATIONS_REVIEWED=<target commit>` in production before the
candidate run. The acknowledgement is commit-bound; never reuse a stale value.
Migration lock/statement timeouts fail candidate without changing active traffic.

Automatic rollback exists only before the switch commits: before drain, stop
candidate only; after drain, cancel the old slot's drain state; after an include
write, restore/reload the old Caddy include (only if the old slot answers
`/health`) and retain both slots. Once public verification passes after the Caddy
reload, the switch is committed (`state.env` written, B-483); draining the old
slot is best-effort and an undrained old slot is left running off the upstream
with a printed stop command. A workflow reported failed or cancelled after that
point did not roll back: establish reality per operations §A switch that dies
after the Caddy reload. Never delete the retained candidate while it may own
connections.

Environment changes: `docker compose restart` does not reread `env_file`. Deploy
the active merged `main` with `rollout=switch`, so candidate reads the new env
while old remains available.

The legacy `hw-sg` SSH alias is not the control origin and must never be used
for production deployment. If `vh-sg` is absent or does not resolve to the
current `veryhappy.dev` origin, stop and establish the exact target first.

After publishing a CLI that changes handover behavior, update the daemon hosts.
A normal blue-green Server/Web switch does not require restarting daemons: it
opens candidate, waits for every `rpc-registered` acknowledgement, then closes
old.

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

The relay's recommended version **advances by itself** (B-348): `publish.yml`
publishes the main package under `next` and its `promote` job moves the `latest`
dist-tag only after the same repository/tag/SHA push smoke run has all six
Linux/macOS/Windows × Node 20/24 jobs completed successfully in its current
attempt. A green workflow with skipped or missing jobs is rejected; tag pushes
run Windows as well as macOS. The relay follows
`latest` via `CLI_VERSION_REGISTRY_LOOKUP=true`, cached one minute (failed refresh backs off five minutes). The promote job waits
up to ten minutes for npm and the public relay to advertise the exact release;
timeout or a mismatching explicit pin fails verification without undoing npm or
overwriting the pin. Rerun after resolving the cause. So there is no
per-release env edit. `CLI_RECOMMENDED_VERSION` must be unset for the registry
to drive recommendations; reserve that pin for an explicit hold or rollback.
Production's `CLI_AUTO_UPDATE_VERSION=latest` (B-503) follows the same promoted
tag, so promotion is also the moment idle machines are allowed to install it.
Confirm it landed:

```sh
curl -fsS https://veryhappy.dev/v1/version/cli   # source:"registry", recommendedVersion = autoUpdateVersion = X.Y.Z, autoUpdatePolicy:"latest"
npm view very-happy-cli version                  # the promoted latest
npm view very-happy-cli dist-tags                # `next` may be ahead if smoke failed
```

`latest` still sitting on the previous version means the `promote` job did not
promote — read its log before doing anything by hand; the usual cause is a red
smoke run, and that is the gate working.

**Recommending a release and installing it for people are two variables**
(B-351) **with one default since B-503: both follow the promoted `latest`.**
The Owner's standing decision (2026-09-25) is that the fleet always runs the
newest promoted CLI, so a release needs no second env edit: once `promote`
moves `latest`, `/v1/version/cli` reports `autoUpdateVersion = X.Y.Z` within
a minute and idle daemons install it on their next policy check (hourly).
`npm publish` alone still reaches nobody — `next` is never followed, and a red
smoke run leaves `latest` (and therefore the fleet) where it was.

Holding or rolling back the automatic install is the only time the variable
is touched by hand:

```sh
scripts/release/advance-auto-update.sh X.Y.Z            # pin: hold the fleet at / roll back to X.Y.Z
scripts/release/advance-auto-update.sh latest           # return to the default
# add --dry-run to only print the plan
```

For an exact version it refuses unless npm `latest` already is `X.Y.Z` (never
pin an unpromoted tarball); it backs up `/opt/happy/.env` on vh-sg, dispatches
`deploy-hwsg.yml rollout=switch` on `main` (a `restart` would not reread
`env_file`), waits for that exact headSha, and fails unless `/v1/version/cli`
then reports the expected `autoUpdateVersion` / `autoUpdatePolicy`. It prints
the backup path — rollback is restoring it and running the same deploy. A pin
older than what machines already run does not downgrade them (the daemon never
installs backwards); it stops them advancing. The script needs an `ssh vh-sg`
alias; from a workstation without one, run it on dev-sg or do its steps by hand
through `ssh dev-sg 'ssh vh-sg "…"'`.

To **hold or roll back the recommendation** without touching npm, pin it (the
pin always beats the lookup), then deploy so the candidate reads the new env
(`restart` does not reread `env_file`):

```sh
ssh vh-sg
sed -i 's|^CLI_RECOMMENDED_VERSION=.*|CLI_RECOMMENDED_VERSION=X.Y.Z|' /opt/happy/.env
gh workflow run deploy-hwsg.yml --ref main -f target=all -f rollout=switch
curl -fsS https://veryhappy.dev/v1/version/cli   # must not be source:"unavailable"
```

The publish workflow's `promote` job checks this for you after it moves the
dist-tag, and prints a loud notice in the run summary when the fleet still will
not be offered the release — a pin holding it back, or a `latest` that never
moved because smoke was red. It does not fail the run, because holding a release
back is legitimate, but you will not silently forget again.

`CLI_MINIMUM_VERSION` is separate: it makes the update banner non-dismissible.
Raise it only when older clients are actually incompatible. With registry lookup
working, removing `CLI_RECOMMENDED_VERSION` does not silence recommendations;
pinning it also caps `CLI_AUTO_UPDATE_VERSION=latest` (the brake stops installs,
not only banners). Removing `CLI_AUTO_UPDATE_VERSION` disables unattended
installation only.

Daemon hosts still need their supervised handover: with `latest` in force they
install by themselves when idle, but confirm the running version and the
supervisor afterwards (or update them at once). Update mac-office with `vh-update` (repository fallback:
`bash scripts/update-daemon.sh`) and confirm the running daemon version,
not only npm metadata. On mac-office, handover starts the replacement outside
launchd. Complete the existing re-adoption procedure in
[docs/operations.md](../../../docs/operations.md) (search “Re-adopt”), then verify
launchd is `running`, the daemon has the expected version, and a read-only RPC
works. Do not use `kickstart -k` against a live same-version daemon: the launcher
can yield and leave neither process supervised. This host-specific re-adoption
is not the generic user update command. dev-sg (systemd user unit) is
`sudo npm i -g …` → `systemctl --user restart very-happy-daemon` (B-505: the
unit's `KillMode=process` restarts the daemon only — session wrappers, their
turns and tmux terminals survive and are re-adopted; `daemon stop` + `start` or
a shell `daemon start` are no longer the path, and the CLI refuses the latter
while the daemon is unit-owned). Check `very-happy daemon list` (`turnActive`
for every session) if you want to know what is mid-turn first; see
[ops/dev-sg/README.md](../../../ops/dev-sg/README.md).

Never use `npm publish`, bare `npx`, `--ignore-scripts`,
or move/force an existing tag.

`vh-update` replaces the daemon but intentionally leaves already-running agent
session wrappers alive. A wrapper and its active SDK Query keep the CLI code
loaded when that wrapper started. Verify CLI session features with a session
started after the upgrade; do not claim an older live session hot-loaded the new
package. Stopping/resuming a business session is a separate interrupting action,
not an implicit release step.

## Production verification

```bash
curl -fsS https://veryhappy.dev/health
VH_MAIN=$(curl -fsS https://veryhappy.dev/ | grep -oE '/assets/[^" ]+\.js' | head -1)
curl -fsSI "https://veryhappy.dev${VH_MAIN}" | grep -i '^content-type:.*javascript'
```

A green health check and a matching SHA only prove the right image is serving.
`AGENTS.md` also requires proof that THIS release's change is in it — grep the
shipped assets for a string only the new code contains (a CSS rule, a storage
key, a socket event name). Do not hand-roll that curl; it has been wrong three
times in three releases, and every one of those failure modes reads as the
opposite of the truth:

```bash
node scripts/dev/check-shipped.mjs --needle '.tg-subagent-open' --needle 'vh:subagent-open'
```

It reads the live SHA off the served entry, walks the chunk graph transitively,
rejects the SPA's HTML fallback (a made-up /assets path returns 200, not 404),
and exits non-zero on a miss. The traps it exists to absorb are written up in
its header. When a needle is missing, check ancestry before concluding a
regression — another session deploying on top of you is the common case:

```bash
git merge-base --is-ancestor <your-sha> <live-sha> && echo "yours is in"
```

For browser acceptance, record the loaded entry/CSS and controlling service
worker before refreshing. Verify takeover via `controllerchange` and the actual
loaded entry; reload alone does not prove a version migration. Complete relevant items in
`docs/verify-queue.md`.

## Rollback

- Web/server: use the phase-aware rollback above; do not update daemons for a server-only rollback.
- CLI/daemon: install the fixed previous version with the reviewed script allowlist, use `daemon start` handover, then hand the daemon back to launchd (mac-office) or systemd (dev-sg).
- Database: migrations must be forward-compatible; never improvise a destructive
  down migration during an incident.

Report what was published/deployed, exact versions/SHAs, verification evidence,
and remaining manual acceptance. A successful build alone is not a release.
