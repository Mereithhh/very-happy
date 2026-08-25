# very-happy-cli

The machine-side CLI and daemon for **Very Happy**, an open agent workspace.
The responsive Web UI or installable PWA is the recommended daily interface;
this package pairs the machine, runs its background bridge, provides diagnostics
and automation, and offers intentional local launch commands. Run Claude Code,
Codex, a shell, or an ordinary xterm-compatible text TUI on your machine and
continue from the Web. A beta Agent Client Protocol backend also supports Gemini,
OpenCode, and custom commands that expose a compatible ACP stdio endpoint.
OpenClaw uses a separate adapter to its local gateway protocol.

`very-happy-cli` is a deeply modified fork of [slopus/happy](https://github.com/slopus/happy)
(MIT). It keeps the compatible session wire model while adding the Very Happy
daemon, Web Terminal, Codex and Gemini modes, MCP/automation commands, account
pairing, and a configurable relay endpoint. Review the release notes when
mixing CLI and server versions.

By default it connects to **https://veryhappy.dev**. You can point it at any
compatible Happy server (including your own) by setting both
`HAPPY_SERVER_URL` and `HAPPY_WEBAPP_URL`.

## ⚠️ Security notice — read this before using

This is **not end-to-end encrypted against the server**. It is a
**server-trusted relay**: the server operator can decrypt and read session
contents (prompts, code, tool output), recover account secrets, and exercise the
remote-control capabilities exposed by an online daemon. The default server
`veryhappy.dev` is operated by the maintainer of this fork.

**Only use a server you trust with your session contents and connected
machines.** If you don't trust the operator of `veryhappy.dev`, run your own
Very Happy server and set both client endpoint variables to it, or don't use
this tool.

## Prerequisites

1. **Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+**.
2. **Provider credentials and the runtime required by each path.** Structured
   Claude uses the Agent SDK bundled in this package, so it needs working Claude
   provider credentials but not a separate `claude` command on `PATH`. Native
   Claude terminal/mirror use does need that command. Codex, Gemini, OpenCode,
   custom ACP commands, and OpenClaw need their local command or gateway installed,
   authenticated, and visible to the daemon user.
3. **`tmux` for durable Web terminals.** Version 3.2 or newer is required for
   the optional hand-started Claude mirror. On Windows or another environment
   without `tmux`, Web terminals use a non-persistent direct-shell fallback.

The optional text/voice coordinating meta-agent currently requires Claude Code.
Voice also requires the selected server or user settings to provide a compatible
voice service.

Provider credentials remain local by default. `very-happy connect
codex|claude|gemini` is an explicit opt-in that uploads the selected OAuth
credential to the configured trusted relay; this is not an end-to-end encrypted
vault and is currently used primarily by the Gemini path.

For structured Claude, set `ANTHROPIC_API_KEY` or configure Amazon Bedrock,
Google Vertex AI, or Microsoft Foundry in the environment that actually starts
the daemon. `very-happy doctor` reports the current non-secret source category;
`very-happy daemon status` reports what the daemon saw at startup. Restart the
daemon after changing credentials. See
[`docs/configuration.md`](../../docs/configuration.md#claude-credentials-for-structured-sessions)
for supported sources and service-manager persistence.

For OpenClaw, set `OPENCLAW_GATEWAY_URL` plus either
`OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD`, or let Very Happy query
an already configured local `openclaw` command. Its generated device identity
and paired device token stay locally under `$HAPPY_HOME_DIR/openclaw/` with
private permissions.

## Install

```bash
npm install -g very-happy-cli
very-happy doctor
```

`very-happy doctor` reports the active relay and approval UI, Node version,
tmux capability, visible agent commands, authentication, and daemon state. A
missing tmux is an explicit degraded mode, not an authentication failure.

The package runs a `postinstall` step that unpacks platform-specific helper
binaries (ripgrep, difftastic) for your OS/arch. Supported platforms:
darwin/linux/win32 on x64/arm64.

## Usage

Pair the machine, then start its detached background daemon so the Web UI can
reach it:

```bash
very-happy auth login
very-happy daemon start
```

```bash
very-happy            # local Claude TUI; requires the external claude command
very-happy claude     # same, explicit
very-happy codex      # start a Codex session
very-happy gemini     # start Gemini through the beta ACP backend
very-happy acp opencode  # start OpenCode through its built-in ACP adapter
very-happy openclaw   # connect through the local OpenClaw gateway
```

Alternatively, choose **New session** in Web to start structured Claude through
the bundled Agent SDK; that path needs Claude provider credentials but not a
standalone `claude` command.

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
# Keep these in the environment that starts both auth and the daemon.
# A home per relay preserves credentials for any other deployment.
export HAPPY_HOME_DIR="$HOME/.very-happy-your-happy-server"
export HAPPY_SERVER_URL=https://your-happy-server.example.com
export HAPPY_WEBAPP_URL=https://your-happy-server.example.com
very-happy auth login
very-happy daemon start

# or persist it in settings.json (see `very-happy server --help`)
```

Credentials and machine IDs are relay-specific. If you intentionally reuse a
home after changing endpoints, `very-happy auth login --force` clears the old
credentials, machine ID, and daemon state before pairing again.

The web client URL follows the same precedence (`HAPPY_WEBAPP_URL`, then
`settings.webappUrl`, then the default). Defaults for both point at
`https://veryhappy.dev`.

### MCP handoffs

Base managed Claude sessions receive `change_title`, `copy_to_clipboard`,
`open_preview`, and `report_progress`. The managed Codex, Gemini, and ACP bridge
exposes the first three except progress. For a plain `claude`, the standalone
command is intentionally clipboard-only:

```bash
claude mcp add --scope user very-happy-clipboard -- very-happy mcp
```

The assistant/meta-agent Claude variant additionally receives `sessions_list`,
`session_read`, `session_send`, `session_spawn`, `session_kill`,
`session_archive`, `terminals_list`, `terminal_read`, `terminal_send`,
`memory_update`, and `journal_append`. These can read and mutate local work;
treat that variant and its prompt/tool permissions as a high-privilege machine
control surface.

The `--scope user` registration applies to every Claude session for that OS
user, not only a process inside a Very Happy terminal, and it needs the local
daemon. The standalone command still exposes only `copy_to_clipboard`.

The separate `very-happy-mcp` binary launches that managed stdio bridge; its
presence does not make every listed tool available to every runner.

## Configuration precedence

For both the API server and the web app URL:

1. environment variable (`HAPPY_SERVER_URL` / `HAPPY_WEBAPP_URL`)
2. `settings.json` (`serverUrl` / `webappUrl`) in the Happy home dir
3. built-in default (`https://veryhappy.dev`)

## License

MIT. This is a fork of [slopus/happy](https://github.com/slopus/happy) by Kirill
Dubovitskiy and Happy Coder Contributors. See [LICENSE](./LICENSE) for the full
text and original copyright notice, which is preserved.
