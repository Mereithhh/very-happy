# Getting started

This path uses the maintainer-operated Cloud. For your own relay, first follow
[Self-hosting](deployment.md), then substitute your server URL below.

## 1. Prepare the machine

Install Node.js 20+ and the CLI for each agent you plan to run. Claude Code is
the default and deepest integration; Codex is also supported, while Gemini and
custom compatible commands run through the beta ACP backend when they expose a
compatible Agent Client Protocol endpoint over stdio. OpenClaw uses its own
local gateway adapter, not ACP. The optional coordinating meta-agent currently
requires Claude Code, and voice entry also requires a configured compatible
voice service. Confirm each chosen command works in the
same shell account that will run Very Happy.

```bash
npm install -g very-happy-cli
very-happy --version
```

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
HAPPY_SERVER_URL=https://happy.example.com \
HAPPY_WEBAPP_URL=https://happy.example.com \
very-happy auth login
```

## 4. Start the machine daemon

```bash
very-happy daemon start
```

This starts a detached background process. The machine appears in Web while its
daemon is connected. Run the command again after a reboot unless your service
manager starts it automatically. Confirm it is online with
`very-happy daemon status`.

## 5. Start the first session

```bash
cd /path/to/project
very-happy          # Claude Code
very-happy codex    # Codex
very-happy gemini   # Gemini through ACP (beta)
very-happy acp opencode
very-happy openclaw # OpenClaw through its local gateway
```

Return to the Web UI. When the machine is online, choose **New session**, select
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
