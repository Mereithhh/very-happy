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
  <a href="https://happy.mereith.com">Try Very Happy Cloud</a> ·
  <a href="docs/getting-started.md">Quick start</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/deployment.md">Self-host</a>
</p>

Very Happy keeps agent work running on computers you control while making it
available from a laptop, phone, tablet, or installed PWA. It is not merely a
remote shell: it preserves the conversation, tool activity, files, tasks,
permissions, and machine context around the work, so an interruption does not
mean reconstructing everything in your head.

Claude Code is the deepest integration today. Codex is supported, Gemini runs
through ACP, and a generic ACP runner connects compatible agent commands. The
direction is deliberately multi-agent; no single model vendor should own the
workspace around your work.

> [!IMPORTANT]
> **Very Happy is server-trusted, not end-to-end encrypted.** The server operator,
> or an attacker controlling the server, can recover account secrets, read relayed
> content, and act toward connected machines with the account's remote-control
> capabilities. Use only an operator you trust. Self-host if you need to control
> that boundary; use upstream Happy if you require its E2E design.

<img src="docs/screenshots/workspace.png" width="100%" alt="A privacy-safe reconstruction of Very Happy showing a Codex terminal, session list, and file browser in one workspace">

## Why Very Happy

Most remote-agent products solve one piece of the problem: reach a terminal,
enter a vendor cloud, or choose a different model. Very Happy is for the work
around the agent.

The name is a promise, not a mood pasted onto the UI: let the workspace carry
the monitoring, context rebuilding, and handoff overhead so you have more
attention for the decisions only you can make. The work keeps moving; you get to
be Very Happy.

| Need | What Very Happy does |
|---|---|
| Continue from anywhere | Responsive Web/PWA with touch-friendly conversation and terminal controls |
| Stay out of terminal chrome | Structured messages, tools, diffs, permissions, usage, and context |
| Keep full machine access | Durable tmux terminals, reconnect, history, files, preview, and resume |
| Use more than one agent | Claude Code and Codex today; Gemini and custom commands through ACP |
| Remember the surrounding work | Task board, notes, file context, notifications, and session organization |
| Reduce coordination overhead | An optional Claude-powered meta-agent can understand sessions and dispatch work on connected machines |
| Own the operating boundary | Use the capacity-limited community Cloud or run the same trusted relay yourself |

The design principle is simple: stay high-level when that is faster, drop to the
raw machine when it is necessary, and do not lose the thread when switching
devices or interfaces.

## Quick start

Prerequisites: Node.js 20 or newer and the CLI for each agent you plan to run.
Claude Code is the default mode and is also required for the coordinating
meta-agent. Voice additionally requires a configured compatible voice service.

```bash
npm install -g very-happy-cli
very-happy auth login
very-happy daemon start

# Start from a project directory
very-happy            # Claude Code
very-happy codex      # Codex
very-happy gemini     # Gemini via ACP
```

`very-happy auth login` opens a short-lived approval link. Sign in or create an
account, approve only the machine in front of you, then open
[happy.mereith.com](https://happy.mereith.com) to create or continue work.

The hosted Cloud has a configurable global account capacity and no uptime or
support SLA. Existing accounts can still sign in when new registrations are
closed or full. Do not connect a sensitive machine until you accept the hosted
operator's trust boundary. See [Public Cloud](docs/public-server.md).

## What ships today

- Structured Claude Code conversations with tool calls, diffs, permissions,
  usage, attachments, resume, and a terminal-to-conversation mirror.
- Codex sessions; Gemini and compatible custom commands through the Agent Client
  Protocol (ACP).
- Durable `tmux` browser terminals with reconnect, local scrollback, mobile input,
  search, archived sessions, and automatic recovery.
- Machine file browser and rich previews for text, Markdown, images, and PDFs;
  clickable files from agent output.
- Task board, todo-provider commands, notes, notifications, Web Push, and HTTPS
  webhooks.
- A Claude-powered coordinating assistant with text entry, session awareness,
  and machine-side dispatch; voice entry is available when a compatible voice
  service is configured.
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
                                                              └─> Gemini / ACP agent
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
