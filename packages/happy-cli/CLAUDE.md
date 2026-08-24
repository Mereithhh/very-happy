# Very Happy CLI contributor notes

This package is the public `very-happy-cli` daemon and command-line client. It
connects local coding agents and terminals to the production Web V2 client
through a trusted relay. The legacy Expo package is not a production client.

Read the repository root `AGENTS.md`, `CLAUDE.md`, `docs/PROCESS.md`, the `dev`
skill, and relevant specs before editing this package. The root instructions and
nearby source/tests are the facts of record if this file becomes stale.

## Product paths

- Web-created structured Claude sessions use the bundled
  `@anthropic-ai/claude-agent-sdk` and the daemon user's provider credentials.
- Bare `very-happy` starts the native Claude terminal path and requires the
  external `claude` command.
- Codex, beta ACP-compatible agents, OpenClaw, Web terminals, file operations,
  board RPC, notifications, and machine control are separate adapters or daemon
  capabilities. Do not describe every agent as ACP.
- `tmux` is recommended for durable terminal reattach and required for the
  optional native-Claude terminal mirror. Without tmux, Web terminals use a
  non-durable direct PTY fallback.
- The daemon must be started explicitly with `very-happy daemon start` after
  pairing unless an OS service manager starts it.

## Security boundary

Very Happy is **server-trusted, not end-to-end encrypted or zero-knowledge**.
Encrypted wire envelopes are defense in depth against passive storage or
transport exposure; the relay can recover account material, access relayed
content, and influence requests to an online daemon. Never add comments, docs,
or UI that exclude the relay operator from the trust boundary.

`$HAPPY_HOME_DIR/access.key`, machine IDs, daemon state, and settings are scoped
to one relay. Bearer credentials must be checked against their recorded
`authServerUrl` before network use. Use a distinct `HAPPY_HOME_DIR` per relay.
Legacy `agent.key` credentials without an issuer are ambiguous and must fail
closed; that internal control-plane prototype is not a public npm package.

Remote terminal, spawn, file, webhook, MCP, and provider-token features execute
or disclose data with the daemon OS user's authority. Preserve explicit approval
and validation boundaries, avoid logging tokens/content, and add regression tests
for auth or remote-execution incidents.

## Implementation conventions

- TypeScript is strict; prefer named exports, explicit types, and the `@/` alias.
- Keep daemon logs out of interactive terminal output. User-facing CLI output may
  use the console; sensitive values may not.
- Keep wire changes backward compatible with old clients and update the relevant
  spec/compatibility matrix first.
- Synced setting schemas must not add Zod `.default()` values (see root iron rule).
- Pure-JS CJS daemon dependencies belong in `devDependencies` so pkgroll inlines
  them; always run the built artifact, not only TypeScript tests.
- Prefer pure helpers with colocated Vitest tests for state, parsing, and policy.

## Quality gate

```bash
pnpm -C packages/happy-wire build
pnpm -C packages/happy-cli test
HAPPY_HOME_DIR="$(mktemp -d)" node packages/happy-cli/dist/index.mjs --version
```

For interactive prompt/TUI changes, also use the repository terminal-emulator
skill. For release or daemon updates, follow the release skill and verify the
exact published version in an isolated home before touching mac-office.
