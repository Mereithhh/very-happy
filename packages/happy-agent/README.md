# Internal control-plane prototype

`packages/happy-agent` is an unpublished, source-only prototype for dispatching
and inspecting Very Happy sessions. It is retained for contributor experiments
and future meta-agent work; it is **not** part of the public installation or
first-user journey.

Do not run `npm install happy-agent`. That unscoped npm name is owned by an
unrelated third party and this repository does not publish to it. `private: true`
and a failing `prepublishOnly` guard make accidental publication from this
workspace fail closed.

## Current limitations

- Its separate `agent.key` account-linking flow needs an account client capable
  of approving account-device QR requests. Production Very Happy Web V2 does not
  currently expose that prototype approval UI.
- The public `very-happy-cli` pairing credential is deliberately not copied into
  `agent.key`; the modern data-key shape does not contain the account private key
  needed to decrypt arbitrary historical sessions.
- `very-happy resume <id>` retains a hidden compatibility path for environments
  that already have a valid, relay-bound `agent.key`, but it is not advertised as
  a public workflow. Normal users should resume and control sessions in Web.
- This tool does not change the security model: Very Happy is server-trusted,
  not end-to-end encrypted or zero-knowledge. The relay operator can access
  relayed content and connected-machine capabilities.

## Contributor use

Use an isolated home and run only from this monorepo:

```bash
export HAPPY_HOME_DIR="$(mktemp -d)"
export HAPPY_SERVER_URL=http://127.0.0.1:3005
pnpm -C packages/happy-agent build
node packages/happy-agent/bin/happy-agent.mjs --help
```

The implemented prototype commands include `auth`, `list`, `machines`, `spawn`,
`status`, `create`, `send`, `history`, `stop`, and `wait`. Their contracts and
tests live next to the implementation; they are not a stability promise.

## Development gates

```bash
pnpm -C packages/happy-agent test
```

Never add a public publishing workflow for this package under the `happy-agent`
name. If it becomes a supported product, first choose a fork-owned package name,
design Web approval and migration, document the trust boundary, add a clean-home
end-to-end test, and release it independently.

## License and attribution

MIT. This fork retains upstream authorship and attribution in package metadata
and the repository license history.
