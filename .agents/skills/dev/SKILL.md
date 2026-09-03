---
name: dev
description: Local development guide for the very-happy monorepo: production Web V2, standalone server, CLI/daemon, wire schemas, isolated homes, builds, tests, and troubleshooting. Use when asked to build, install locally, start dev, run a package, or debug the local stack. The legacy Expo happy-app is not the production Web client.
---

# very-happy local development

The repository uses pnpm workspaces. The production client is
`packages/happy-web-v2`; do not route Web work to the legacy `happy-app`.

## First setup

```bash
pnpm install --frozen-lockfile
pnpm -C packages/happy-wire build
```

`happy-wire/dist` is gitignored but consumed through the package entrypoint, so a
clean checkout must build it before packages that import wire.

## Fast package loops

Web V2 (defaults to port 8082 and proxies API/socket traffic):

```bash
pnpm -C packages/happy-web-v2 dev
pnpm -C packages/happy-web-v2 exec vitest run
pnpm -C packages/happy-web-v2 exec tsc --noEmit
pnpm -C packages/happy-web-v2 exec vite build
```

Verify a test actually pins the line it claims to (source-assertion tests can
pass after the asserted string is deleted — see `docs/PROCESS.md`):

```bash
node scripts/dev/mutation-check.mjs --pkg happy-web-v2 \
  --test src/screens/onboarding/connectMachine.test.ts \
  --mutate "packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:key: 'connect-machine'"
```

Vitest runs happy-web-v2 in the **node** environment, so a test that renders a
real component must call `installBrowserTestGlobals()` from
`@/testing/browserTestGlobals` before importing it (dynamically — static imports
hoist above the setup). Pure-function modules need nothing.

Standalone server (PGlite, no Postgres/Redis/S3 required):

```bash
pnpm -C packages/happy-server standalone:dev
pnpm -C packages/happy-server exec vitest run
pnpm -C packages/happy-server exec tsc --noEmit
```

CLI/daemon:

```bash
pnpm -C packages/happy-cli test
node packages/happy-cli/dist/index.mjs --version
```

For a disposable CLI home, never reuse the production daemon state:

```bash
VH_DEV_HOME=$(mktemp -d)
HAPPY_HOME_DIR="$VH_DEV_HOME" HAPPY_SERVER_URL=http://127.0.0.1:3005 \
  node packages/happy-cli/dist/index.mjs daemon start
```

`packages/happy-cli`'s `cli:install` deliberately replaces the global binary and
restarts the real daemon using `~/.happy`; use it only when that side effect is
intended.

## Full local Web V2 + server

Terminal 1:

```bash
pnpm -C packages/happy-server standalone:dev
```

Terminal 2:

```bash
VH_SERVER_URL=http://127.0.0.1:3005 pnpm -C packages/happy-web-v2 dev
```

The Vite server uses the configured target for `/v1`, `/v2`, `/v3`, `/health`
and WebSocket proxying, preserving the production same-origin shape.

The root `pnpm env:*` manager still contains upstream Expo assumptions. Until it
is migrated to Web V2, do not use `pnpm env:web` as proof of the production Web
path; prefer the two-terminal loop above.

## Logs and daemon recovery

```bash
ls -t ~/.happy/logs | head
tail -f ~/.happy/logs/$(ls -t ~/.happy/logs | head -1)
very-happy daemon status
```

If a dev daemon is stuck, resolve the exact `HAPPY_HOME_DIR` first, then stop it
and remove only that home's `daemon.state.json.lock`. Never broadly delete
`~/.happy`.

The daemon resolves `claude` through PATH. Non-interactive shells and launchd do
not source `.zshrc`, so PATH must explicitly include `~/.local/bin`.

## Cross-package rules

- Protocol/schema changes: update `happy-wire`, build its dist, and document the
  old/new compatibility matrix in a spec.
- Server changes must add no npm dependency unless the production image/bind-mount
  deployment is changed deliberately.
- Synced setting fields never receive Zod `.default()` values; defaults live in
  the settings defaults layer.
- Repository tools run through `pnpm exec`, never bare `npx`.
- The merge gates and known exception are canonical in `AGENTS.md` and
  `docs/PROCESS.md`; do not invent a lighter package-specific gate here.

## Production is not a dev environment

Do not test local changes by mutating hw-sg or mac-office unless the user asked
for a deployment. Production topology and recovery commands live in
`docs/operations.md`.
