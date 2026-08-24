# Contributing to Very Happy

Thanks for helping improve the project. Keep changes focused, explain the user
impact first, and provide evidence proportionate to risk.

## Before coding

- Search existing issues, `docs/backlog.md`, and `specs/` for related work.
- Open a discussion before changing authentication, storage semantics, wire
  protocols, remote execution, or the sync engine.
- Never include credentials, session dumps, private logs, or production data in
  an issue, fixture, commit, screenshot, or PR.

## Set up

Prerequisites: Git, Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+,
and pnpm 10.11.0.
The optional compiled standalone-server build additionally uses Bun 1.2.21;
normal development, tests, and the Docker self-host path do not require Bun.

```bash
git clone https://github.com/Mereithhh/very-happy.git
cd very-happy
pnpm install --frozen-lockfile
pnpm -C packages/happy-wire build
```

Run the production Web client and standalone server:

```bash
# terminal 1
pnpm -C packages/happy-server standalone:dev

# terminal 2
VH_SERVER_URL=http://127.0.0.1:3005 pnpm -C packages/happy-web-v2 dev
```

Do not use the legacy Expo `happy-app` as proof of the product Web path. See
[development.md](development.md) for isolated CLI homes and package details.

## Required gates

```bash
pnpm -C packages/happy-web-v2 exec vitest run
pnpm -C packages/happy-web-v2 exec vite build
pnpm -C packages/happy-web-v2 exec tsc --noEmit

pnpm -C packages/happy-cli test
HAPPY_HOME_DIR=$(mktemp -d) node packages/happy-cli/dist/index.mjs --version

pnpm -C packages/happy-server exec tsc --noEmit
pnpm -C packages/happy-server exec vitest run
node scripts/ci/check-public-pr-isolation.mjs
node scripts/ci/check-trust-model.mjs
```

Build `happy-wire` first on a clean checkout. Repository tools run with
`pnpm exec`, never an unpinned `npx` download.

## Pull requests

- Lead with the problem and the exact outcome.
- One coherent fix/feature per PR; include tests for regressions and important
  failure states.
- For UI, include desktop/mobile evidence and keyboard/accessibility behavior.
- For protocols, include old/new compatibility and release/rollback order.
- Redact logs and screenshots. Replace identifiers rather than blurring over
  live secrets.

Fork PRs run only on GitHub-hosted ephemeral runners. They cannot access private
self-hosted runners, production hosts, or release secrets. Maintainers must not
work around that boundary by copying fork code into a privileged workflow.

## Style and product constraints

The Console UI uses tokens from
`packages/happy-web-v2/src/styles/tokens.css`; do not add raw component colors.
The single teal accent represents live/focused/connected state, not decoration.
Public descriptions must say **server-trusted**, never E2E or zero-knowledge.

By contributing, you agree that your contribution is licensed under the root
MIT license and that upstream attribution remains intact. Follow the
[Code of Conduct](../CODE_OF_CONDUCT.md) and report vulnerabilities through
[SECURITY.md](../SECURITY.md), not a public issue.
