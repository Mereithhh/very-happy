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

## End-to-end against a real daemon (local, disposable)

For changes that span CLI + Web (a real Claude/Codex turn, an RPC, a tombstone):

1. `SIGNUP_MODE=open pnpm -C packages/happy-server standalone:dev` — standalone
   defaults to `closed`, and the login form never creates accounts; register at
   `/signup` (B-528, 2026-10-03).
2. Web as above (`VH_SERVER_URL=http://127.0.0.1:3005 … dev --port <free port>`).
3. `HAPPY_HOME_DIR=<tmp> HAPPY_SERVER_URL=… HAPPY_WEBAPP_URL=… node packages/happy-cli/dist/index.mjs auth login`,
   approve the printed `/terminal/connect#key=…` link in the logged-in browser,
   then `daemon start` with the same env. Rebuild `dist` first — the daemon runs
   the built CLI, not your sources. A daemon started before login holds the lock:
   kill it before starting again.
4. `node … spawn --dir <dir> --permission-mode default --json` gives a session URL.
5. In Vite dev the app's own module instances are importable from the page, so
   state can be inspected without debug hooks:
   `const {storage} = await import('/src/sync/storage.ts'); storage.getState().sessionMessages[id]`.
   Programmatic reload past the tab-close guard:
   `(await import('/src/app/programmaticReload.ts')).markProgrammaticReload(); location.reload()`.
6. Claude transcripts land in `~/.claude/projects/<dir-slug>/*.jsonl` (the real
   home, not `HAPPY_HOME_DIR`) — check what the agent actually holds there.

Stop the daemon, server and Vite when done; the account lives only in the
standalone PGlite store.

## Checking narrow / mobile viewports in the local browser

The Chrome automation tools ignore `resize_window` on this machine. Load the
screen or harness in same-origin iframes of the target size instead — media
queries resolve against the iframe viewport, so `@media (max-width: 520px)`
branches render for real:

```js
document.body.innerHTML = `<div style="display:flex;gap:24px;padding:12px;background:#333">
  <iframe src="/dev/changelog" style="width:390px;height:780px;border:2px solid #999"></iframe>
  <iframe src="/dev/changelog" style="width:360px;height:640px;border:2px solid #999"></iframe>
</div>`;
```

Then measure overflow inside each frame (`contentDocument.documentElement.scrollWidth`
vs `contentWindow.innerWidth`) and toggle `data-theme="dark"` on the iframe's
`documentElement` for the dark palette. Dev harnesses live under `/dev/*`
(`ChangelogHarness` has a "last seen release" picker).

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

### 终端输出节奏诊断

用 `node scripts/dev/term-burst.mjs '<命令>'` 在隔离 socket 下观察块数、中位块大小和停顿分段。
不要用首尾总跨度判断传输速度，它包含进程启动时间。
