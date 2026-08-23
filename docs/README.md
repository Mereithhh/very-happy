# Very Happy documentation

Start with the path that matches what you are doing.

## Use the product

- [Getting started](getting-started.md): install, sign in, connect a machine, and
  create the first session.
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
- [Wire protocol](protocol.md), [API](api.md), [realtime/RPC](realtime-sync-and-rpc.md),
  and [encryption formats](encryption.md)
- [Shared wire schemas](happy-wire.md)

The production frontend is `packages/happy-web-v2`; `packages/happy-app` is an
unsupported upstream Expo artifact. Where old architecture notes disagree with
current source, the package code and current specs win.

## Maintainer internals

`PROCESS.md`, `backlog.md`, `verify-queue.md`, `operations.md`, and `../specs/`
record the Owner's release process and production topology. They are useful to
contributors but are not generic self-hosting instructions. Files under
`docs/plans/` are upstream archives; new designs belong in `specs/`.
