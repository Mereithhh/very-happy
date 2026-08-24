# very-happy-cli

The machine-side CLI and daemon for **Very Happy**, an open agent workspace.
Run Claude Code, Codex, or a real terminal on your machine and continue from a
responsive Web UI. A beta Agent Client Protocol backend also supports Gemini,
OpenCode, and custom commands that expose a compatible ACP stdio endpoint.
OpenClaw uses a separate adapter to its local gateway protocol.

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
   uses Codex; `very-happy gemini` uses the beta ACP backend; `very-happy acp -- …`
   starts a custom command that must expose a compatible ACP stdio endpoint;
   `very-happy openclaw` connects to a configured local OpenClaw gateway.
3. **`tmux` for durable Web terminals.** Version 3.2 or newer is required for
   the optional hand-started Claude mirror. On Windows or another environment
   without `tmux`, Web terminals use a non-persistent direct-shell fallback.

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
very-happy gemini     # start Gemini through the beta ACP backend
very-happy acp opencode  # start OpenCode through its built-in ACP adapter
very-happy openclaw   # connect through the local OpenClaw gateway
```

Each mode starts or connects to its agent locally and registers a normalized
session with the relay so you can continue it from the web client at your
server's origin. OpenClaw connects to an already configured local gateway.
Provider capabilities are not identical: Claude currently has the richest
structured and terminal-mirroring experience.

For Claude, Very Happy deliberately supports two paths. SDK-backed sessions
produce structured messages and tool events directly. When `tmux` is available,
Web terminals instead keep the actual agent CLI/TUI inside it on this machine
and relay its terminal stream; they do not imitate the agent interface in the
browser. With `tmux` 3.2 or newer, the optional mirror below connects those
paths for hand-started Claude terminals. It does not make structured parity a
promise for every terminal-backed agent.

### Optional Claude terminal mirror

Normal Very Happy Claude sessions do not require extra setup. To mirror a
hand-started `claude` process inside a Very Happy Web terminal into a structured
conversation, explicitly install the SessionStart/SessionEnd hooks:

```bash
very-happy install-terminal-hooks
very-happy install-terminal-hooks --remove # uninstall only Very Happy's entries
```

The install command merges into `~/.claude/settings.json` (or
`$CLAUDE_CONFIG_DIR/settings.json`) without touching foreign hooks. It applies
only to Claude started inside a Very Happy terminal while the daemon is running.

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
