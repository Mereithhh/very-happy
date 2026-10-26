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

### 2026-10-26: `TRUST_PROXY` no longer accepts a hop count (B-820)

Self-host breaking change. `TRUST_PROXY` no longer accepts a number (hop count,
e.g. `TRUST_PROXY=1`). Since Fastify 5.12 a hop count trusts no proxy at all, so
every user would appear as the proxy's IP and share one rate-limit bucket. The
server now refuses to start with a numeric value and logs how to fix it. Set the
IP/CIDR your reverse proxy connects from instead, e.g. `TRUST_PROXY=172.18.0.1`
(Caddy via the Docker gateway), `TRUST_PROXY=10.0.0.0/8,192.168.1.10`, or the
named ranges `TRUST_PROXY=loopback,uniquelocal`. Deployments without
`TRUST_PROXY`, or already using an IP list, are unaffected (veryhappy.dev already
uses `172.18.0.1`).

To find the address, look at the peer your reverse proxy connects from (for a
Docker-published port this is usually the network gateway, e.g.
`docker network inspect <network> --format '{{(index .IPAM.Config 0).Gateway}}'`).
Change `.env` before deploying the new image and recreate the container; a
plain restart keeps the old environment.

中文：自托管 breaking：`TRUST_PROXY` 不再接受数字（跳数，例如 `TRUST_PROXY=1`）。
Fastify 5.12 起按跳数信任已不再生效（直接视为不信任任何代理），所有用户会被算成代理的
IP、共用同一个限流桶。现在配置成数字时服务端会拒绝启动，并在日志里给出改法。请改为反向
代理连到服务端时的 IP/CIDR，例如 `TRUST_PROXY=172.18.0.1`（经 Docker 网关的 Caddy）、
`TRUST_PROXY=10.0.0.0/8,192.168.1.10`，或命名网段 `TRUST_PROXY=loopback,uniquelocal`。
未设置 `TRUST_PROXY` 或已经使用 IP 列表的部署不受影响（官方 veryhappy.dev 已使用
`172.18.0.1`）。请在部署新镜像前改好 `.env` 并重建容器，单纯 restart 不会重新读取环境。

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
