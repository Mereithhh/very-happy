# very-happy-cli

A self-hosted remote client for **Claude Code (CLI)**. Run a Claude Code
session on your machine and drive it remotely from a web browser through a relay
server.

`very-happy-cli` is a rebranded fork of [slopus/happy](https://github.com/slopus/happy)
(MIT). It changes only the default server endpoint and the command name — the
agent runtime is unchanged.

By default it connects to **https://happy.mereith.com**. You can point it at any
compatible Happy server (including your own) via `HAPPY_SERVER_URL`.

## ⚠️ Security notice — read this before using

This is **not end-to-end encrypted against the server**. It is a
**server-trusted relay**: the server operator can decrypt and read the contents
of your sessions (prompts, code, tool output). The default server
`happy.mereith.com` is operated by the maintainer of this fork.

**Only use a server you trust with your session contents.** If you don't trust
the operator of `happy.mereith.com`, run your own Happy server and set
`HAPPY_SERVER_URL` to it, or don't use this tool.

## Prerequisites

1. **Node.js >= 20**.
2. **Claude Code CLI installed and logged in.** `very-happy` drives the real
   `claude` binary, so `claude` must be on your `PATH` and already authenticated.
   Install it from Anthropic's instructions and run `claude` once to log in
   before using `very-happy`.

## Install

```bash
npm install -g very-happy-cli
```

The package runs a `postinstall` step that unpacks platform-specific helper
binaries (ripgrep, difftastic) for your OS/arch. Supported platforms:
darwin/linux/win32 on x64/arm64.

## Usage

```bash
very-happy            # start a Claude Code session and connect to the relay
very-happy claude     # same, explicit
```

This starts a Claude Code session locally and registers it with the relay so you
can control it from the web client at your server's origin.

### Pointing at a different server

```bash
# one-off
HAPPY_SERVER_URL=https://your-happy-server.example.com very-happy

# or persist it in settings.json (see `very-happy server --help`)
```

The web client URL follows the same precedence (`HAPPY_WEBAPP_URL`, then
`settings.webappUrl`, then the default). Defaults for both point at
`https://happy.mereith.com`.

### MCP bridge

```bash
very-happy-mcp        # stdio MCP bridge (for Codex / MCP hosts)
```

## Configuration precedence

For both the API server and the web app URL:

1. environment variable (`HAPPY_SERVER_URL` / `HAPPY_WEBAPP_URL`)
2. `settings.json` (`serverUrl` / `webappUrl`) in the Happy home dir
3. built-in default (`https://happy.mereith.com`)

## License

MIT. This is a fork of [slopus/happy](https://github.com/slopus/happy) by Kirill
Dubovitskiy and Happy Coder Contributors. See [LICENSE](./LICENSE) for the full
text and original copyright notice, which is preserved.
