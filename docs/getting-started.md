# Getting started

This path uses the maintainer-operated Cloud. For your own relay, first follow
[Self-hosting](deployment.md), then substitute your server URL below.

## 1. Prepare the machine

Install the required runtime and decide which optional capabilities this machine
needs:

| Dependency | Status | What changes if it is missing |
|---|---|---|
| Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+, with npm | Required | The CLI and daemon cannot run |
| Provider credentials and, where applicable, a local agent command | Required for that agent path | Structured Claude uses the bundled Agent SDK; native Claude terminal/mirror, Codex, Gemini, OpenCode, and OpenClaw need their local command or gateway |
| `tmux` | Recommended | Web terminals fall back to a non-durable direct shell. A brief browser reconnect may recover it while the same daemon still holds the PTY, but it is not discoverable for durable/cross-device reattach and ends after daemon restart or idle cleanup |
| `tmux` 3.2+ | Required only for the optional Claude terminal mirror | Durable terminal basics still work on older tmux, but the terminal-to-structured binding is unavailable |

Claude Code is the default and deepest integration. Its structured path ships
inside the CLI through the Agent SDK and needs valid Claude provider credentials,
not a separate `claude` command on `PATH`. The native Claude TUI/mirror does need
that command. Codex is also supported,
while Gemini and custom compatible commands run through the beta ACP backend
when they expose a compatible Agent Client Protocol endpoint over stdio.
OpenClaw uses its own local gateway adapter, not ACP. The optional coordinating
meta-agent currently requires Claude Code, and voice entry requires a configured
compatible voice service. Agent credentials remain in that provider's local
configuration or environment by default. The optional `very-happy connect`
command instead uploads a selected OAuth credential to the trusted relay; it is
not needed for this quick start and is currently used primarily by the Gemini
path. Confirm the agent runs normally as the same OS user and with the same
environment that will run the daemon.

Common tmux installs:

```bash
brew install tmux             # macOS
sudo apt install tmux         # Debian / Ubuntu / WSL
sudo dnf install tmux         # Fedora / RHEL family
tmux -V
```

Native Windows uses the direct-shell fallback; use WSL when you need tmux-backed
terminal persistence. The CLI bundles `ripgrep` and `difftastic` on supported
platforms, so do not install them just for Very Happy.

```bash
npm install -g very-happy-cli
very-happy --version
very-happy doctor
```

`very-happy doctor` shows the actual relay and approval UI, Node version, tmux
capability, visible agent commands, authentication, and daemon status. Before
pairing, “not authenticated” and “daemon not started yet” are expected next
steps. Fix unsupported Node or endpoint errors; yellow optional items describe
the exact degradation.

### Configure Claude for structured sessions

Very Happy bundles the Claude Agent SDK, but it does not bundle Claude usage or
broker a Claude account. For a public/third-party integration, configure one of
Anthropic's supported machine credentials for the **same OS user and startup
environment as the daemon**:

- `ANTHROPIC_API_KEY` from the Claude Console (the simplest first run), or
- Amazon Bedrock, Google Vertex AI, or Microsoft Foundry with its normal cloud
  credentials and `CLAUDE_CODE_USE_BEDROCK=true`,
  `CLAUDE_CODE_USE_VERTEX=true`, or `CLAUDE_CODE_USE_FOUNDRY=true`.

For an interactive first run, avoid placing a key in shell history:

```bash
read -rsp "Anthropic API key: " ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY
echo
very-happy doctor
```

`doctor` reports only the credential **category**, never its value. Existing
Claude `apiKeyHelper` or local Claude credential files are also detected when
available, but OS-keychain credentials cannot be verified by Doctor. Very Happy
does not ask users to sign in to Claude.ai and does not transmit Claude provider
credentials to the relay in this normal flow. The optional `very-happy connect`
flow is separate, uploads the selected credential to the trusted relay, and is
not required for structured Claude.

If a service manager starts the daemon, put the credential in that service's
secret store or a mode-`0600` environment file; exporting it in an unrelated
terminal will not reach an already-running service. After any credential change,
restart and verify what the daemon actually inherited:

```bash
very-happy daemon stop
very-happy daemon start
very-happy daemon status   # shows the non-secret Claude source seen at startup
```

See [Configuration](configuration.md#claude-credentials-for-structured-sessions)
for provider and recovery details.

## 2. Create or sign in to an account

Open [happy.mereith.com](https://happy.mereith.com). Choose Google or a username
and password. New registration can be open, invite-only, closed, or temporarily
full; an existing account can still sign in in every mode.

The hosted relay is [server-trusted](security.md). Do not continue with a machine
whose contents or remote-control capability you are unwilling to expose to the
server operator.

## 3. Connect the machine

```bash
very-happy auth login
```

Open the generated HTTPS link and approve only if you initiated it on the machine
in front of you. Pairing links expire; generate a new one instead of forwarding
or reusing an old link.

For a self-hosted relay:

```bash
export HAPPY_HOME_DIR="$HOME/.very-happy-happy.example.com"
export HAPPY_SERVER_URL=https://happy.example.com
export HAPPY_WEBAPP_URL=https://happy.example.com
very-happy auth login
```

PowerShell equivalent for self-hosting:

```powershell
$env:HAPPY_HOME_DIR="$HOME/.very-happy-happy.example.com"
$env:HAPPY_SERVER_URL='https://happy.example.com'
$env:HAPPY_WEBAPP_URL='https://happy.example.com'
very-happy auth login
```

Use a separate `HAPPY_HOME_DIR` for each relay so an existing Cloud or other
self-hosted machine identity is not overwritten. If you intentionally switch an
existing home, use `very-happy auth login --force`. Both endpoint variables must
remain set for `very-happy daemon start` and later CLI
commands: `HAPPY_SERVER_URL` selects API/WebSocket traffic, while
`HAPPY_WEBAPP_URL` is the browser origin opened for machine approval. They may be
different origins in an advanced deployment, but both must belong to the same
relay/account environment. Persist them in `$HAPPY_HOME_DIR/settings.json` only
if you do not want to export them for every daemon start; see
[Configuration](configuration.md).
Changing either endpoint and running `very-happy daemon start` restarts a daemon
that is still connected to the previous relay. `very-happy doctor` shows both
configured and running daemon endpoints.

## 4. Start the machine daemon

```bash
very-happy daemon start
```

This starts a detached background process. The machine appears in Web while its
daemon is connected. Run the command again after a reboot unless your service
manager starts it automatically. Confirm it is online with
`very-happy daemon status`.

## 5. Start the first session

Return to the Web UI, choose **New session**, select the connected machine and a
directory, then choose Claude. This Web-created structured path uses the bundled
Agent SDK and your Claude provider credentials.

A fresh browser starts new sessions in **Review Changes First** mode. Keep it on
until you are comfortable with the relay and machine boundary; change it under
**Settings → Agents → New sessions** when you intentionally want auto-apply.
Existing devices preserve their saved behavior, so check the toggle when using
an older Very Happy browser profile.

To start a local agent process from a terminal instead, install that command
first:

```bash
cd /path/to/project
very-happy          # local Claude TUI; requires external claude
very-happy codex    # Codex
very-happy gemini   # Gemini through ACP (beta)
very-happy acp opencode
very-happy openclaw # OpenClaw through its local gateway
```

When the machine is online, you can also choose **New session**, select
the machine, project directory, and agent, then start. A generic compatible
command can also run with `very-happy acp -- your-agent --agent-specific-acp-flag`. Use
`very-happy daemon status` and [Troubleshooting](troubleshooting.md) if the
machine stays offline.

### Optional: mirror hand-started Claude terminals

Very Happy supports two Claude paths. SDK-backed conversations are structured
by default. When `tmux` is installed, the terminal path keeps the real Claude
Code TUI running inside a durable session and relays that terminal stream to the
browser. Without `tmux`, Web terminals use a non-persistent direct-shell
fallback. If you have `tmux` 3.2 or newer and want a hand-started `claude`
process inside a Very Happy Web terminal to also gain the
terminal-to-structured toggle, install the optional hooks explicitly:

```bash
very-happy install-terminal-hooks
# rollback
very-happy install-terminal-hooks --remove
```

The command merges Very Happy's SessionStart/SessionEnd entries into
`~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) without
removing foreign hooks. The binding exists only for Claude started inside a
Very Happy terminal while the daemon is running. This structured mirror is a
Claude-specific capability; other agent terminals keep their native TUI but do
not automatically gain the same structured view.

## Next

- [CLI and daemon](cli-architecture.md)
- [Public Cloud](public-server.md)
- [Configuration](configuration.md)
- [Security and privacy](security.md)
