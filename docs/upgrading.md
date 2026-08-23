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
