# very-happy-cli

The machine-side CLI and daemon for **Very Happy**, an open agent workspace.
Run Claude Code, Codex, Gemini through ACP, compatible custom ACP commands, or a
real terminal on your machine and continue from a responsive Web UI.

`very-happy-cli` is a deeply modified fork of [slopus/happy](https://github.com/slopus/happy)
(MIT). It keeps the compatible session wire model while adding the Very Happy
daemon, Web Terminal, Codex and Gemini modes, MCP/automation commands, account
pairing, and a configurable relay endpoint. Review the release notes when
mixing CLI and server versions.

By default it connects to **https://happy.mereith.com**. You can point it at any
compatible Happy server (including your own) via `HAPPY_SERVER_URL`.

## ⚠️ Security notice — read this before using

This is **not end-to-end encrypted against the server**. It is a
**server-trusted relay**: the server operator can decrypt and read session
contents (prompts, code, tool output), recover account secrets, and exercise the
remote-control capabilities exposed by an online daemon. The default server
`happy.mereith.com` is operated by the maintainer of this fork.

**Only use a server you trust with your session contents and connected
machines.** If you don't trust the operator of `happy.mereith.com`, run your own
Very Happy server and set `HAPPY_SERVER_URL` to it, or don't use this tool.

## Prerequisites

1. **Node.js >= 20**.
2. **The CLI for each agent you plan to use**, installed, authenticated, and on
   the daemon's `PATH`. Bare `very-happy` uses Claude Code; `very-happy codex`
   uses Codex; `very-happy gemini` uses Gemini through ACP; `very-happy acp -- …`
   starts a compatible custom ACP command.

The optional text/voice coordinating meta-agent currently requires Claude Code.
Voice also requires the selected server or user settings to provide a compatible
voice service.

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
very-happy codex      # start a Codex session
very-happy gemini     # start Gemini through ACP
very-happy acp opencode  # start OpenCode through its built-in ACP adapter
```

Each mode starts its agent locally and registers a normalized session with the
relay so you can continue it from the web client at your server's origin.
Provider capabilities are not identical: Claude currently has the richest
structured and terminal-mirroring experience.

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
