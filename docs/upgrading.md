# Upgrading and rollback

## Before upgrading

1. Read release notes/spec compatibility notes.
2. Back up the database/files and record the current server SHA, Web SHA, and CLI
   version.
3. Run the package gates in `AGENTS.md` from a clean checkout.
4. Keep migrations forward-compatible; do not rely on destructive down migration.

## Order

The default order is server → Web → CLI/daemon. Protocol specs can override this
with an explicit compatibility matrix. After a server upgrade, restart/reconnect
daemons so RPC registrations are current. After a Web swap, restart the static
server and verify the hashed JS asset returns JavaScript, not SPA HTML.

### Pairing claim-secret rollout

The claim-secret protocol is fail-closed and older CLIs cannot create a new
pairing when `AUTH_ALLOW_LEGACY_PAIRING=false`. Existing tokens, sessions and
already-connected daemons continue to work. For a mixed-version fleet:

1. Deploy the server with `AUTH_ALLOW_LEGACY_PAIRING=true` only for the rollout.
2. Publish/install the new CLI and restart every daemon.
3. Prove a fresh `very-happy auth login` approval succeeds with the new CLI.
4. Remove the compatibility flag, recreate the server (a restart does not reload
   environment files), and verify an old client receives `426 upgrade-required`.

New public installs should leave the flag unset and deploy server → Web → CLI as
one release; the Web explains the required CLI upgrade when pairing is rejected.

## CLI and daemon update notices

The relay publishes a recommended version and an optional minimum version at
`GET /v1/version/cli`. A daemon checks on startup and every six hours. Web shows
an available/required notice per machine, while `very-happy daemon status`
shows the installed CLI and running daemon separately.

The notice deliberately copies an exact-version command instead of executing
remote code or following a moving tag:

```bash
npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@<exact-version>
```

The existing daemon bundle-mtime watcher normally hands over to the new bundle
within 60 seconds. Run `very-happy daemon start` to request that handoff
immediately. This is not a zero-interruption promise for direct-shell PTYs;
durable tmux terminals can be re-adopted, while in-process work should be allowed
to finish before a planned upgrade.

## Verification

```bash
curl -fsS https://happy.example.com/health
VH_ASSET=$(curl -fsS https://happy.example.com/ | grep -oE '/assets/[^" ]+\.js' | head -1)
curl -fsSI "https://happy.example.com${VH_ASSET}" | grep -i '^content-type:.*javascript'
```

Then sign in, confirm an existing machine remains online, create a disposable
session/terminal, and check logs/metrics for new errors.

## Rollback

- Web: restore the previous static tree and restart the server.
- Server: redeploy the previous commit, leaving additive migrations in place.
- CLI: install the previous `very-happy-cli` version and restart the daemon.

Never delete production data or improvise a destructive schema rollback during
an incident. Maintainer-specific commands live in [operations.md](operations.md).
