# Production operations

This is the repository source of truth for the maintainer-operated
`happy.mereith.com` deployment. It records topology and procedures, never secret
values. Generic self-hosting remains in [`deployment.md`](deployment.md).

## Topology and trust boundary

| Role | Runtime |
|---|---|
| Web + server | `hw-sg`, `/opt/happy/docker-compose.yml`, container `happy-server` |
| Public endpoint | `https://happy.mereith.com`, Caddy TLS proxy to `127.0.0.1:3005` |
| Production Web | `packages/happy-web-v2`, served from `/opt/happy/webapp` |
| Server source overlay | `/opt/happy-src/packages/happy-server/{sources,prisma/migrations}` |
| Database | PGlite in a Docker named volume |
| Daemon | published `very-happy-cli` on `mac-office` |

The hosted service is server-trusted, not E2E. The server can recover account
secrets and relay remote execution to a user's connected daemon. Treat access to
hw-sg, its environment, backups and deploy key as high impact.

Production secret values live only in hw-sg `/opt/happy/.env`. Documentation and
Git contain variable names only. Relevant variables include
`HANDY_MASTER_SECRET`, signup policy/capacity, VAPID credentials, Google Client ID
and Origin allowlist. Never copy the environment file into an agent transcript.

## Supported deployment paths

The normal path is the manual GitHub workflow:

```bash
gh workflow run deploy-hwsg.yml -f target=all   # all | server | web
gh run list --workflow=deploy-hwsg.yml --limit 3
gh run view <run-id> --json headSha,status,conclusion,url
```

Wait at least 20 seconds after pushing, then confirm `headSha` is the intended
commit. The workflow calls [`scripts/ci/deploy-hwsg.sh`](../scripts/ci/deploy-hwsg.sh).

The emergency local path, rollback details and self-hosted runner fallback live
in [`PROCESS.md`](PROCESS.md#ci-不可用时的本地部署应急路径). Do not maintain a
second copy of those command sequences here.

### Server overlay constraints

Only `sources` and `prisma/migrations` are bind-mounted. Mounting the whole package
would hide image `node_modules`. Consequently:

- ordinary source/migration changes can be synced and the container restarted;
- new server npm dependencies require rebuilding/replacing the image;
- migrations must stay compatible with the currently deployed image and old
  clients according to the feature spec.

The image and production Compose command both apply pending migrations before
starting the server. The deploy script verifies that contract before syncing any
schema-dependent source and fails closed if a hand-edited deployment has removed
it. After a server deployment, run `vh-update` on mac-office until B-001 is fixed;
a half-open daemon connection may otherwise fail to re-register RPCs.

### Environment changes

`docker compose restart` keeps the old container environment. After editing
`/opt/happy/.env`, recreate the service:

```bash
ssh hw-sg 'cd /opt/happy && docker compose up -d happy-server'
```

For the official Google login configuration, also confirm the exact Web origin
in Google Cloud Console. See [`deployment.md`](deployment.md#environment-variables).

### Web static swap and cache safety

`@fastify/static` discovers hashed asset routes at server startup. A Web deploy
must build with a fresh `VH_VERSION`, stage files, swap them, restart the server,
and verify that the main asset has a JavaScript content type. Serving SPA HTML
for an asset path with immutable caching can poison a browser for a year.

The deploy script keeps the immediately previous Web tree in
`/opt/happy/webapp.prev` and retains recent hashed assets so already-open clients
can finish lazy loading. Do not simplify its copy/swap ordering casually.

## mac-office daemon

The machine runs the public npm package, not a source checkout. Normal upgrade:

```bash
vh-update
# Repository-owned equivalent/fallback:
bash scripts/update-daemon.sh
```

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
curl -fsS https://happy.mereith.com/health
VH_MAIN=$(curl -fsS https://happy.mereith.com/ | grep -oE '/assets/[^" ]+\.js' | head -1)
curl -fsSI "https://happy.mereith.com${VH_MAIN}" | grep -i '^content-type:.*javascript'
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

- Web: restore `/opt/happy/webapp.prev` and restart, or redeploy the previous SHA.
- Server: revert and redeploy the previous source; do not invent destructive down
  migrations during an incident.
- CLI: install the previous `very-happy-cli` version and restart through launchd.
- Environment: restore the prior `.env` value from the password manager, then
  recreate the container.

Every release report records the deployed SHA/version, verification evidence and
the rollback point.
