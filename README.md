<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-light.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-dark.png">
    <img src="/.github/logotype-dark.png" width="360" alt="Very Happy">
  </picture>
</div>

<h1 align="center">Work anywhere. Keep the thread.</h1>

<p align="center">
  An open agent workspace for your machines: structured conversations, real
  terminals, files, tasks, and agent coordination in one responsive Web UI.
</p>

<p align="center">
  <a href="https://happy.mereith.com/welcome">Explore Very Happy</a> ·
  <a href="docs/getting-started.md">Quick start</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/deployment.md">Self-host</a>
</p>

Very Happy keeps agent work running on computers you control while making it
available from a laptop, phone, tablet, or installed PWA. It is not merely a
remote shell: it preserves the conversation, tool activity, files, tasks,
permissions, and machine context around the work, so an interruption does not
mean reconstructing everything in your head.

**Structured when you want it. The real TUI when you need it.** Very Happy
keeps SDK-backed Claude sessions and adds a tmux-backed path for the actual
agent terminal interface.

<img src="docs/screenshots/workspace.png" width="100%" alt="Very Happy's production session sidebar, running terminal, and file browser rendered with sanitized example data">

Claude Code is the deepest integration today. Codex is supported. A beta Agent
Client Protocol (ACP) backend runs Gemini and OpenCode presets, while a generic
runner can connect commands that expose a compatible ACP stdio endpoint.
OpenClaw connects through its own local gateway protocol rather than ACP. The
direction is deliberately multi-agent; no single model vendor should own the
workspace around your work.

> [!IMPORTANT]
> **Very Happy is server-trusted, not end-to-end encrypted.** The server operator,
> or an attacker controlling the server, can recover account secrets, read relayed
> content, and act toward connected machines with the account's remote-control
> capabilities. Use only an operator you trust. Self-host if you need to control
> that boundary; use upstream Happy if you require its E2E design.

## Why Very Happy

Most remote-agent products solve one piece of the problem: reach a terminal,
enter a vendor cloud, or choose a different model. Very Happy is for the work
around the agent.

The name is a promise, not a mood pasted onto the UI: let the workspace carry
the monitoring, context rebuilding, and handoff overhead so you have more
attention for the decisions only you can make. The work keeps moving; you get to
be Very Happy.

Upstream Happy's core Claude experience is an SDK-backed structured session.
Very Happy keeps that path and adds a second one: when `tmux` is available, the
actual agent CLI/TUI runs inside a durable session on your machine, and xterm
renders its terminal stream rather than recreating agent-specific UI. With
`tmux` 3.2 or newer, optional hooks can add a structured mirror to Claude
started by hand inside that Web terminal and let you move back to the same TUI.
That mirror is Claude-specific; terminal support for another agent does not
imply equivalent structured events. Without `tmux`, Web terminals fall back to
a non-persistent direct shell.

| Need | What Very Happy does |
|---|---|
| Continue from anywhere | Responsive Web/PWA with touch-friendly conversation and terminal controls |
| Stay out of terminal chrome | Structured messages, tools, diffs, permissions, usage, and context |
| Keep the real agent interface | Durable tmux-backed TTY/TUI transport, reconnect, history, files, preview, and resume |
| Use more than one agent | Claude Code, Codex, and OpenClaw today; beta Gemini, OpenCode, and compatible custom commands through ACP |
| Remember the surrounding work | Task board, notes, file context, notifications, and session organization |
| Reduce coordination overhead | An optional Claude-powered meta-agent can understand sessions and dispatch Claude work on its selected machine |
| Own the operating boundary | Use the capacity-limited community Cloud or run the same trusted relay yourself |

The design principle is simple: stay high-level when that is faster, drop to the
raw machine when it is necessary, and do not lose the thread when switching
devices or interfaces.

## Quick start

| On the machine | Required? | Why |
|---|---:|---|
| Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+, with npm | Yes | Runs the CLI and daemon |
| Agent provider/runtime | For that agent path | Structured Claude uses the bundled Agent SDK plus provider credentials; native Claude terminals and other adapters need their local command or gateway |
| `tmux` | Recommended | Keeps real Web terminals alive across browser disconnects; without it, terminals are non-persistent direct shells |
| `tmux` 3.2+ | For the optional Claude mirror | Adds create-time environment markers used by terminal → structured conversation handoff |

Provider credentials stay local by default. The optional `very-happy connect`
flow explicitly uploads the selected OpenAI, Anthropic, or Gemini OAuth
credential to the trusted relay; it is not an end-to-end encrypted vault and is
currently used primarily by the Gemini path.

For the first structured Claude session, set `ANTHROPIC_API_KEY` or a supported
Bedrock, Vertex AI, or Foundry configuration in the environment that starts the
daemon. `very-happy doctor` reports only the detected source category; restart
the daemon after changing it. The full source and service-manager guide is in
[Configuration](docs/configuration.md#claude-credentials-for-structured-sessions).

The Cloud path needs no relay configuration: the CLI defaults to
`https://happy.mereith.com`. Claude Code is the default and deepest integration
and is required for the coordinating meta-agent. Voice additionally requires a
configured compatible voice service. `ripgrep` and `difftastic` are bundled for
supported CLI platforms; they do not need a separate install.

```bash
npm install -g very-happy-cli
very-happy doctor
very-happy auth login
```

After approving the machine in your browser, start its detached background
daemon so the machine remains available in Web:

```bash
very-happy daemon start
```

In Web, choose **New session** on the connected machine to start the bundled
structured Claude path. It needs Claude provider credentials but no standalone
`claude` executable. Local agent commands are optional and require their own
installed runtime:

```bash
very-happy            # local Claude TUI; requires external claude
very-happy codex      # Codex
very-happy gemini     # Gemini via the beta ACP backend
very-happy acp opencode
very-happy openclaw   # OpenClaw through its local gateway
```

Optional: to mirror a hand-started `claude` process from a Very Happy Web
terminal into the structured conversation view, explicitly install the
SessionStart/SessionEnd hooks:

```bash
very-happy install-terminal-hooks
# later, to remove only Very Happy's hook entries:
very-happy install-terminal-hooks --remove
```

This modifies `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`),
does not touch foreign hooks, and only binds Claude started inside a Very Happy
terminal while the daemon is running. Normal SDK-backed Claude conversations do
not require these hooks.

`very-happy auth login` opens a short-lived approval link. Sign in or create an
account, approve only the machine in front of you, then open
[happy.mereith.com](https://happy.mereith.com) to create or continue work.

The hosted Cloud has a configurable global account capacity and no uptime or
support SLA. Existing accounts can still sign in when new registrations are
closed or full. Do not connect a sensitive machine until you accept the hosted
operator's trust boundary. See [Public Cloud](docs/public-server.md).

For self-hosting, deploy the relay first, then set both client endpoints so the
API/socket connection and browser approval use the same deployment:

```bash
export HAPPY_HOME_DIR="$HOME/.very-happy-happy.example.com"
export HAPPY_SERVER_URL=https://happy.example.com
export HAPPY_WEBAPP_URL=https://happy.example.com
very-happy auth login
very-happy daemon start
```

Use a separate `HAPPY_HOME_DIR` for each relay. Tokens and machine IDs belong to
the relay that issued them; this preserves an existing Cloud setup. If you
intentionally repoint an existing home, run `very-happy auth login --force`.

Self-host using the documented Docker image, explicit signup policy, persistent
storage, and HTTPS. Do not install the upstream-owned `happy-server-self-host`
package. The supported public self-host path is the repository's pinned Docker
build; `very-happy-server` remains a private workspace package until its Prisma
runtime can be shipped without unsafe transitive production dependencies. See
[Self-hosting](docs/deployment.md).

## What ships today

- Structured Claude Code conversations with tool calls, diffs, permissions,
  usage, attachments, and resume. An explicitly installed optional hook pair
  mirrors hand-started Claude inside Very Happy terminals into that view.
- Codex sessions; a beta Agent Client Protocol backend with Gemini and OpenCode
  presets plus compatible custom commands over ACP stdio; and OpenClaw through
  its own local gateway protocol.
- Durable `tmux` browser terminals with reconnect, local scrollback, mobile input,
  search, archived sessions, and automatic recovery.
- Machine file browser and rich previews for text, Markdown, images, and PDFs;
  clickable files from agent output.
- Task board, todo-provider commands, notes, notifications, Web Push, and HTTPS
  webhooks.
- A Claude-powered coordinating assistant with text entry, session awareness,
  and dispatch on its selected machine; voice entry is available when a
  compatible voice service is configured.
- Public account/password and Google sign-in, configurable registration and
  capacity controls, plus one-container or production-scale self-hosting.

## Direction, not marketing fiction

We are building toward a provider-aware coordination layer: more agent adapters
(Pi is a candidate), cross-provider subtask routing, durable project and task
memory, and a meta-agent that brings the user decisions rather than activity.

The long-term visual concept is a multi-agent virtual office—possibly pixel-art—
where work, handoffs, and requests for attention are spatially legible. That is a
roadmap concept, not a shipped feature. The non-negotiable philosophy behind it
already guides the product: **work anywhere and make the interface carry as much
operational overhead as possible.** See the [roadmap](docs/roadmap.md).

### Compose it into a larger agent system

Very Happy is an execution surface, not a closed automation platform. Generic
webhooks plus [`very-happy spawn` and `very-happy send`](docs/channels.md) let a
carefully scoped adapter connect an issue tracker, scheduler, chat system, or
future provider-aware coordinator. The adapter must own sender authorization,
fixed workspace policy, and least-privilege execution; incoming messages are
never authorization by themselves. Cross-provider routing is roadmap, not a
shipped gateway.

## Architecture and trust

```text
browser ── HTTPS/WebSocket ──> trusted relay ── WebSocket ──> CLI daemon
                                                              │
                                                              ├─> Claude Code
                                                              ├─> Codex
                                                              ├─> Gemini / ACP agent
                                                              └─> OpenClaw gateway
```

The relay synchronizes conversations and workspace state, routes RPCs, and
connects browsers to daemons on your machines. The wire format still contains
encrypted envelopes inherited from Happy, but the Very Happy server can recover
account keys. Transport and storage encryption are defense in depth; they do not
make the relay zero-knowledge. Read the [architecture](docs/architecture.md) and
[security model](docs/security.md) before operating a public instance.

## Run it and contribute

- [Self-hosting](docs/deployment.md)
- [Configuration](docs/configuration.md)
- [Upgrading and rollback](docs/upgrading.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Security policy](SECURITY.md)

The production frontend is `packages/happy-web-v2`. The upstream Expo
`packages/happy-app` remains for history and is not a supported Very Happy client;
it is intentionally excluded from the pnpm workspace and security support scope.

## Attribution and license

Very Happy is a friendly, deeply modified fork of
[slopus/happy](https://github.com/slopus/happy) and retains upstream copyright
and MIT terms. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Claude Code, Codex,
Gemini, OpenCode, and other named agents are products or projects of their
respective owners. Very Happy is independent and is not affiliated with them.
