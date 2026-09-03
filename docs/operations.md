# Production operations

This is the repository source of truth for the maintainer-operated
`veryhappy.dev` deployment. It records topology and procedures, never secret
values. Generic self-hosting remains in [`deployment.md`](deployment.md).

The canonical source and release repository is the public
[`Mereithhh/very-happy`](https://github.com/Mereithhh/very-happy). The former
`very-happy-private-archive-20260825` repository is archive-only: do not push
commits or tags to it and do not use it as a deployment source.

## Topology and trust boundary

| Role | Runtime |
|---|---|
| Web + server | `vh-us`; legacy `happy-server:3005` during groundwork, then fixed `happy-server-blue:3101` / `happy-server-green:3102` slots |
| Public endpoint | `https://veryhappy.dev`; Caddy imports `/opt/happy/release/active-upstream.caddy` and switches it atomically |
| Production artifact | Complete `ghcr.io/mereithhh/very-happy-server@sha256:<digest>` image, including Web V2 |
| Database | External PostgreSQL in the colocated `happy-postgres` container |
| Daemon | published `very-happy-cli` on `mac-office` |
| Singapore relay | `sg-hw`, `https://relay-sg.veryhappy.dev`, Docker + Caddy on `hw-sg` |
| US relay | `us-fb`, `https://relay-us.veryhappy.dev`, k3s + Traefik on `fb-us`/`k8sus` |

The hosted service is server-trusted, not E2E. The server can recover account
secrets and relay remote execution to a user's connected daemon. Treat access to
vh-us, its environment, backups and deploy key as high impact.

Production has completed the explicit groundwork and shadow gates and now uses
the fixed-slot blue-green topology. `/opt/happy/release/state.env` is the
authority for the active/rollback slot, image digest and release; never infer
the current slot from repository support or a historical release note.

Production secret values live only on vh-us in `/opt/happy/.env`. Documentation and
Git contain variable names only. Relevant variables include
`HANDY_MASTER_SECRET`, signup policy/capacity, VAPID credentials, Google Client ID
and Origin allowlist. Never copy the environment file into an agent transcript.

## Supported deployment paths

The normal path is the manual GitHub workflow:

```bash
test "$(git remote get-url origin)" = "https://github.com/Mereithhh/very-happy.git"
test "$(gh repo view Mereithhh/very-happy --json visibility --jq .visibility)" = PUBLIC
git push origin main
# Wait at least 20 seconds for GitHub's ref to settle.
gh workflow run deploy-hwsg.yml -f target=all -f rollout=switch
gh run list --workflow=deploy-hwsg.yml --limit 3
gh run view <run-id> --json headSha,status,conclusion,url
```

Wait at least 20 seconds after pushing, then confirm `headSha` is the intended
commit. The workflow calls [`scripts/ci/deploy-hwsg.sh`](../scripts/ci/deploy-hwsg.sh).

The first package publication is a one-time two-phase bootstrap because GHCR
creates a new package as private. Run the workflow with `target=publish`, make
`very-happy-server` public in GitHub package settings, verify an anonymous pull,
then run `target=all`. Later releases build, push and deploy in one run.

The emergency local path, rollback details and self-hosted runner fallback live
in [`PROCESS.md`](PROCESS.md#ci-不可用时的本地部署应急路径). Do not maintain a
second copy of those command sequences here.

### Complete-image blue-green deployment contract

Server source, Prisma schema, generated Prisma Client, migrations and Web V2 are
one versioned artifact. Production must not bind-mount any of them from the host.
The workflow publishes a commit-SHA tag, deploys its resolved manifest digest,
and promotes that same digest to the convenience `latest` tag only after public
health and Web asset verification. Production Compose always stores the digest.

The workflow has three explicit `rollout` phases:

1. `groundwork` is the one final legacy recreation. It requires `REDIS_URL`, an
   explicit PostgreSQL `connection_limit`, Caddy ≥2.10.2 and host headroom; it
   installs release identity/readiness while the legacy container remains the
   blue slot on port 3005.
2. `shadow` starts the exact candidate digest on the inactive fixed slot, waits
   for DB/Redis/adapter/Web readiness, runs the cross-slot canary in both
   directions, verifies a continuous public HTTP probe, then stops candidate.
   It never changes Caddy or promotes `latest`.
3. `switch` requires the initial shadow evidence, repeats readiness/canary,
   emits a drain notice, atomically swaps the Caddy include and gracefully
   reloads Caddy. Supported clients connect to `?vh_slot=blue|green`, resync and
   register every RPC before closing old. Old clients retain a compatibility
   grace, then use the existing reconnect + durable resync fallback.

Before starting candidate, the helper verifies the packaged Prisma schema
matches the generated Client schema. Before drain, any failure stops only the
candidate. After drain, rollback first cancels the old slot's drain state; if an
active-include write may have happened, it also restores and reloads the old
include while retaining both slots. If old was already stopped, rollback starts
it before changing the include. Database migrations remain expand/contract and
rollback never runs a destructive down migration.

Production prerequisites are intentionally fail-closed and checked without
printing secret values: `/opt/happy/.env` must contain `REDIS_URL`; its
`DATABASE_URL` must have an explicit `connection_limit`; Caddy must be at least
2.10.2. Release state and the generated admin token live mode 0600 under
`/opt/happy/release/`; the token is not a public API credential.

If the candidate's packaged migration tree differs from the active digest, the
operator must first review it as expand-compatible and set
`VH_RELEASE_MIGRATIONS_REVIEWED=<target-commit>` in `/opt/happy/.env`; a stale or
missing acknowledgement fails before candidate start. The image runs migration
connections with a 5s lock timeout and 60s statement timeout by default
(`MIGRATION_PGOPTIONS` may be reviewed/overridden); the serving process does not
inherit those migration-only timeouts.

### Standalone PGlite process exclusivity and incident recovery

The maintainer Cloud uses external PostgreSQL. This section applies only to
standalone/self-host deployments that omit `DATABASE_URL`; do not use PGlite
recovery commands against the production `happy-postgres` service.

Never open a live PGlite directory from a second Node/Bun/PGlite process—not even
for a read-only integrity query. PGlite's PostgreSQL `postmaster.pid` is not a
host-process lock; concurrent filesystem backends can corrupt `pg_control` or WAL.
The server holds a kernel advisory lock keyed to the canonical embedded-database
directory for its complete lifetime and rejects another repository-owned process.
The kernel releases it on crash, `SIGKILL`, or container exit; no PID/TTL/stale-file
guessing is involved. Do not bypass the lock while its owner is live.

For database diagnosis:

1. Stop `happy-server` and confirm no PGlite/PostgreSQL process remains.
2. Copy the complete named-volume data directory, preserving permissions and WAL.
3. Run every inspection or recovery command against that copy only.
4. Preserve an untouched snapshot before `pg_resetwal`, restore, or other mutation.
5. Validate all public tables, indexes/constraints, migrations, and key aggregate
   invariants on the recovered copy before an atomic, recoverable directory swap.

Do not treat moving `postmaster.pid` as a generic repair. A startup panic such as
`could not locate a valid checkpoint record` requires snapshot-first recovery and
an explicit incident record. External PostgreSQL is the recommended backend when
operators need multi-process tooling or mature point-in-time recovery.
Keep PGlite on a local Docker volume; network/NFS storage is unsupported because
its advisory-lock and durability semantics are outside this deployment contract.

### Environment changes

`docker compose restart` keeps the old container environment. Before the one-time
groundwork, an env edit still requires the legacy recreation below. Once release
state exists, run a normal `rollout=switch` of merged `main`; candidate reads the
new env while active remains available.

```bash
# Before blue-green groundwork only:
ssh vh-us 'cd /opt/happy && docker compose up -d --force-recreate happy-server'
```

`vh-us` is the operator's local alias for the active production origin. The
legacy `hw-sg` alias is not a control-server deployment target.

For the official Google login configuration, also confirm the exact Web origin
in Google Cloud Console. See [`deployment.md`](deployment.md#environment-variables).

### Regional relay rollout

Regional relays are independent `happy-server relay` processes. They must not
receive the control server's database URL, storage credentials, or
`HANDY_MASTER_SECRET`. Each needs only its public id/region, bind address, and the
dedicated `RELAY_TOKEN_SECRET` shared with control.

Roll out in this order:

1. Generate/store one dedicated relay signing secret outside Git.
2. Start every planned relay behind HTTPS with `RELAY_ID`, `RELAY_REGION`,
   `RELAY_TOKEN_SECRET`, `HOST`, and `PORT`.
3. Verify each public `/health` returns the exact configured id and region; then
   run the repository relay Socket.IO integration test against the release SHA.
4. Add only those verified origins to control `HAPPY_RELAYS_JSON`, add the same
   `RELAY_TOKEN_SECRET`, and recreate—not merely restart—the control container.
5. Update Web, then CLI/daemon. Confirm the terminal header shows the expected
   relay id and RTT, and verify terminal input/output plus machine RPC.

The emergency rollback is to clear `HAPPY_RELAYS_JSON` and recreate control;
new clients then use the compatibility path. Relay processes can be stopped only
after that configuration is live. The current in-memory assignment registry is
for a single control replica; do not claim control-plane HA until the registry is
moved to shared storage.

Relay images are deployed from merged `main` with the manual GitHub-hosted
`deploy-relays.yml` workflow (`all | sg | us`). The workflow builds
[`Dockerfile.relay`](../Dockerfile.relay), pushes the immutable
`ghcr.io/mereithhh/very-happy-relay:<commit-sha>` image with `GITHUB_TOKEN`, and
deploys Singapore and the US in parallel for an `all` rollout. Each remote pulls
from GHCR directly, so unchanged layers remain cached instead of sending a full
`docker save` archive through SSH. The GHCR package must be public; newly created
GHCR packages default to private, so make it public once in the package settings
before the first deploy. Do not put a package token on either relay node unless
the package is intentionally changed back to private.

The workflow uses a dedicated deploy key and never creates or rotates
`RELAY_TOKEN_SECRET`. The one-time secret and reverse-proxy setup must already
exist. `hw-sg` binds the container on `127.0.0.1:3011` because port 3010 belongs
to another service; k3s keeps the relay's container port at 3010. Post-deploy
health checks require both the configured relay id and the exact commit SHA in
`version`; a healthy old pod is not accepted as a successful rollout.

### Web cache safety

Web V2 ships inside the complete server image and changes atomically with the
server container. After deployment, still verify that the entry asset has a
JavaScript content type; browsers with an older service worker may need a hard
refresh or service-worker unregister before diagnosing a mixed-version failure.

## mac-office daemon

The machine runs the public npm package, not a source checkout. Normal upgrade:

```bash
vh-update
# Repository-owned equivalent/fallback:
bash scripts/update-daemon.sh
```

`vh-update` performs a daemon handover; it deliberately does not kill agent
session wrapper processes that were already running. Those wrappers and their
active SDK Query keep the CLI code loaded at their own start time. Verify a new
CLI capability with a session started after the upgrade, or explicitly stop and
resume the target session when interrupting it is acceptable; daemon version
alone is not evidence that an existing session hot-loaded the new capability.

A CLI upgrade's handover leaves the new daemon outside launchd. `very-happy
daemon start` (and `vh-update`, which wraps it) hands over by starting the new
daemon from the calling shell, so `launchctl print gui/$(id -u)/com.mereith.happy-daemon`
reports `state = not running` afterwards and KeepAlive will not restart the
daemon if it dies (verified 2026-09-03 upgrading to 0.2.103). Re-adopt it as the
last step of every upgrade, and check the state, not just `daemon status`:

```bash
very-happy daemon stop
launchctl kickstart gui/$(id -u)/com.mereith.happy-daemon
launchctl print gui/$(id -u)/com.mereith.happy-daemon | grep 'state = '   # must say running
very-happy daemon status                                                  # running daemon = installed CLI
```

Use `kickstart` without `-k` after an explicit `daemon stop`. Sending `-k` while
a same-version daemon is still alive makes the relaunch script yield to it, both
processes exit, and `KeepAlive SuccessfulExit=false` does not restart them —
leaving the machine with no daemon at all.

The daemon needs `~/.local/bin` in PATH to find Claude Code. SSH and launchd do
not source interactive `.zshrc`, so the LaunchAgent wrapper sets PATH explicitly.
Install or refresh repository-owned launchd support with:

```bash
bash ops/mac-office/install-launch-agent.sh
```

Detailed behavior is documented in
[`ops/mac-office/README.md`](../ops/mac-office/README.md).

Do not use `sudo very-happy daemon install`: the upstream macOS installer is dead
code for this fork, targets a root LaunchDaemon, cannot see the user's home/keychain,
and invokes a nonexistent command.

## Diagnosis

Public endpoint:

```bash
curl -fsS https://veryhappy.dev/health
VH_MAIN=$(curl -fsS https://veryhappy.dev/ | grep -oE '/assets/[^" ]+\.js' | head -1)
curl -fsSI "https://veryhappy.dev${VH_MAIN}" | grep -i '^content-type:.*javascript'
```

Daemon:

```bash
very-happy daemon status
launchctl print gui/$(id -u)/com.mereith.happy-daemon | grep -E 'state = |last exit'
tail -20 ~/.local/state/happy/daemon-launchd.log
tail -50 ~/.happy/logs/$(ls -t ~/.happy/logs | head -1)
```

If `lastHeartbeat` stopped at a machine reboot, verify the user logged into the
GUI session: a LaunchAgent starts only after login. Tailscale returning while
Happy remains offline does not prove a network problem; they use different
startup mechanisms.

Web terminals are tmux processes and do not survive a Mac reboot. Persisted chat
sessions may return while terminal tabs are gone; that is expected.

## Rollback

- Web/server after blue-green activation: read the validated rollback slot/image
  from `/opt/happy/release/state.env`, start that stopped slot with the release
  Compose, verify its authenticated readiness, atomically restore its recorded
  port in `active-upstream.caddy`, validate/reload Caddy, then verify public
  release and asset. Keep the failed slot until its sockets drain and incident
  evidence is captured.
- Groundwork-only rollback: use the exact Compose and Caddy snapshot printed in
  `/opt/happy-rollbacks/<sha>.groundwork.*`; this is the only path that recreates
  legacy `happy-server:3005`.
- Never restore source, migrations or Web independently, and never invent a
  destructive down migration during an incident.
- CLI: install the previous `very-happy-cli` version and restart through launchd.
- Environment: restore the prior `.env` value from the password manager, then
  recreate the container.

Every release report records the deployed SHA/version, verification evidence and
the rollback point.
