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

UI 工作同时读取 `.agents/skills/design/SKILL.md`，遵循项目统一设计契约并验证真实功能完整性。

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

视觉/CSS 改动要在真实浏览器里量（AGENTS「验收」是硬要求），别现搭 harness：

```bash
# 真实 CSS + 真 Chromium；scenario 里写 measure()，需要时写 pixels() 采像素
node scripts/dev/css-probe.mjs path/to/scenario.mjs --out ~/code/github/skills/tmp/ui-review/shots
```

手机验证必须读取实际 `matchMedia('(pointer: coarse)').matches`，不能仅凭 `hasTouch`/窗口宽度认定触屏生效。当前锁定 Playwright 与缓存 Chromium 的长页截图会重置触屏模拟；`css-probe.mjs` 已在 page 创建后显式启用原生触屏，手机通过 CDP 只截真实视口，并核验截图后仍为 coarse。长内容另验滚动和可达性，不能把手机视口截图当全页截图。自定义浏览器脚本也要在导航/截图后核验媒体查询，截图与交互必须采用同一指针模式。

「这个功能该不该做」先量语料再决定：

```bash
node scripts/dev/corpus-stats.mjs                # 本机 transcript 里 agent 输出的 markdown 形态
node scripts/dev/corpus-stats.mjs --samples math # 看命中样本（数学那一项几乎全是假阳性）
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
