# Development

The production development path is Web V2 + standalone server + CLI. The
Expo/Tauri `happy-app` is retained as an experimental seed for a possible future
desktop client, but it is not the current product frontend. It remains outside
the pnpm workspace, production, and the supported security scope.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm -C packages/happy-wire build
```

Wire dist is gitignored, so clean checkouts must build it before consumers.

## Run Web V2 against production

```bash
pnpm -C packages/happy-web-v2 dev
```

Open `http://localhost:8082`. Vite proxies API/socket traffic to
`https://veryhappy.dev`, preserving a same-origin browser shape.

## Run Web V2 against a local standalone server

Terminal 1:

```bash
pnpm -C packages/happy-server standalone:dev
```

Terminal 2:

```bash
VH_SERVER_URL=http://127.0.0.1:3005 pnpm -C packages/happy-web-v2 dev
```

The standalone server uses PGlite and local files, so no Postgres, Redis or S3
is required. Its development environment file contains placeholders only.

For local Google login, create/use a Web OAuth client that authorizes the actual
Vite origin and configure the server with matching `GOOGLE_CLIENT_ID` and
`GOOGLE_ALLOWED_ORIGINS`. Do not reuse the production Client ID for localhost
unless that origin was deliberately authorized in the same Google project.

## CLI development

Build and gate:

```bash
pnpm -C packages/happy-cli test
node packages/happy-cli/dist/index.mjs --version
```

Run against the local server in a disposable home:

```bash
VH_DEV_HOME=$(mktemp -d)
HAPPY_HOME_DIR="$VH_DEV_HOME" \
HAPPY_SERVER_URL=http://127.0.0.1:3005 \
HAPPY_WEBAPP_URL=http://localhost:8082 \
node packages/happy-cli/dist/index.mjs daemon start
```

Keep the variable available so stop/status target the same home. Do not delete or
reuse the production `~/.happy` while testing.

`pnpm -C packages/happy-cli cli:install` replaces the global binary and restarts
the real daemon. It is useful for intentional local installation, not an isolated
test command.

## Package gates

The authoritative commands are in [`AGENTS.md`](../AGENTS.md) and
[`PROCESS.md`](PROCESS.md). In particular, a CLI build is not enough: run the
built `dist/index.mjs` because CJS/ESM dependency failures can appear only at
runtime.

## Legacy environment manager

[`dev-environments.md`](dev-environments.md) documents the root `pnpm env:*`
manager. Its Web launcher and authenticated URL seeding still target upstream
Expo assumptions, so it is not currently a production Web V2 acceptance path.
Use the explicit two-terminal loop above until B-150 is resolved.
