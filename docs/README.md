# Very Happy documentation

Start with the path that matches what you are doing.

## Use the product

- [Getting started](getting-started.md): install, sign in, connect a machine, and
  create the first session.
- [Keyboard and touch](keyboard-shortcuts.md): command palette, fast navigation,
  PWA/browser shortcut boundaries, and mobile equivalents.
- [Public Cloud](public-server.md): hosted-instance trust, registration, capacity,
  and service expectations.
- [CLI architecture and operation](cli-architecture.md)
- [Troubleshooting](troubleshooting.md)

## Operate your own instance

- [Self-hosting](deployment.md)
- [Configuration](configuration.md)
- [Architecture and data flow](architecture.md)
- [Security and privacy model](security.md)
- [Accounts and quotas](accounts-and-quotas.md)
- [Upgrading and rollback](upgrading.md)

## Build and contribute

- [Development](development.md)
- [Contributing](CONTRIBUTING.md)
- [Product roadmap and north star](roadmap.md)
- [Wire protocol](protocol.md), [API](api.md), [realtime/RPC](realtime-sync-and-rpc.md),
  and [encryption formats](encryption.md)
- [Shared wire schemas](happy-wire.md)

The production frontend is `packages/happy-web-v2`; `packages/happy-app` is an
experimental upstream Expo/Tauri seed for a possible future desktop client. It
is intentionally excluded from the pnpm workspace, production, and current
security support scope. Where old architecture notes disagree with current
source, current package code and specs win.

## Maintainer internals

`PROCESS.md`, `backlog.md`, `verify-queue.md`, `operations.md`, and `../specs/`
record the Owner's release process and production topology. They are useful to
contributors but are not generic self-hosting instructions. Files under
`docs/plans/` are upstream archives; new designs belong in `specs/`.
