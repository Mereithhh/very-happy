<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <a href="https://veryhappy.dev/welcome">
    <img src=".github/readme-hero.svg" width="100%" alt="Very Happy — one command panel for every connected machine and agent">
  </a>
</div>

<p align="center">
  <strong>One panel. Every machine. Every agent. You get to be Very Happy.</strong>
</p>

<p align="center">
  <img alt="Open source" src="https://img.shields.io/badge/open_source-public-111820?style=flat-square&labelColor=070a0e&color=2d3b42">
  <img alt="Web and installable PWA" src="https://img.shields.io/badge/client-Web_%2F_PWA-34e2c4?style=flat-square&labelColor=070a0e&color=238b7b">
  <img alt="Node 20, 22 and 24" src="https://img.shields.io/badge/Node-20_%7C_22_%7C_24-34e2c4?style=flat-square&labelColor=070a0e&color=238b7b">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-34e2c4?style=flat-square&labelColor=070a0e&color=238b7b">
  <img alt="Cloud or self-hosted deployment" src="https://img.shields.io/badge/deploy-Cloud_%2F_self--hosted-788784?style=flat-square&labelColor=070a0e&color=38464d">
</p>

<p align="center">
  <a href="https://veryhappy.dev/welcome"><strong>Explore the live workspace</strong></a>
  &nbsp;·&nbsp;
  <a href="#one-command-to-your-first-machine">Connect a machine</a>
  &nbsp;·&nbsp;
  <a href="docs/README.md">Read the docs</a>
  &nbsp;·&nbsp;
  <a href="docs/deployment.md">Self-host</a>
</p>

Very Happy is one open command panel for the computers and agents you control.
Its responsive Web UI gathers sessions from every connected machine, shows what
is running or waiting, lets you choose the machine and agent for new work, and
opens the corresponding structured conversation, real terminal, files, tasks,
notes, or notifications from a laptop, phone, tablet, or installed PWA.

It is not a browser repaint of one vendor's CLI and it is not merely a remote
shell. Very Happy preserves the surrounding thread: what is running, what the
agent changed, which machine owns the work, what needs your decision, and how to
continue after an interruption.

```text
build server  ─┐
workstation   ─┼─>  ONE WEB / PWA PANEL  ─> choose machine + agent
field laptop  ─┘      sessions · status · tasks · files · terminals
```

Today, dispatch is explicit: you select the target machine and agent for each
new session. Provider-neutral automatic routing is roadmap, not a shipped claim.

> [!TIP]
> **Use the Web/PWA as your daily workspace.** Install the CLI once to pair a
> machine and start its background daemon. Return to the CLI for diagnostics,
> automation, recovery, or an intentional local launch—not because you need to
> live in a second interface. The daemon remains required: Web-first is a UX
> choice, not a browser-only architecture.

> [!NOTE]
> **Choose the deployment that fits your work.** Very Happy Cloud gives you the
> fastest multi-device setup; self-hosting gives you control of the operator,
> access policy, storage, and backups. See the [privacy and security
> model](docs/security.md) for sensitive environments.

## One workspace. Three layers that do different jobs.

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>STRUCTURED</h3>
      Follow messages, tools, diffs, permissions, usage, and resume state without
      living inside terminal chrome. Claude Code is the deepest structured
      integration today.
    </td>
    <td width="33%" valign="top">
      <h3>UNIVERSAL TTY</h3>
      Run ordinary xterm-256color-compatible text processes inside a tmux-owned
      TTY. Reconnect to the same process, keep scrollback, search it, browse
      files, and use touch-first terminal controls. A coding agent is optional.
    </td>
    <td width="33%" valign="top">
      <h3>WEB-FIRST</h3>
      Use the responsive Web/PWA as the default surface. Start at a desk, check
      progress on a phone, and return without rebuilding the project state in
      your head. An optional Claude-only mirror can move
      between a hand-started TUI and structured conversation.
    </td>
  </tr>
</table>

```text
Claude Agent SDK ──────────────> structured conversation

shell / vim / lazygit / ssh / text TUI ─> tmux TTY ──> Web / PWA
agent CLI ──────────────────────────────> tmux TTY ──> Web / PWA
                                                  ╰─> optional Claude mirror
```

The terminal is the compatibility layer. It forwards a real TTY and does not
care which brand—or category—of process is on the other side. A tool working in
a terminal does not automatically expose Claude-style structured events.
Durable terminals require
`tmux`; the optional Claude mirror requires `tmux` 3.2 or newer. Without tmux,
Web terminals use a non-persistent direct-shell fallback.

The browser terminal advertises `TERM=xterm-256color` and renders through
xterm.js. Common text TUIs are the compatibility target; sixel/Kitty graphics
and other terminal-specific extensions are not guaranteed.

<a href="https://veryhappy.dev/welcome">
  <img src="docs/screenshots/workspace.png" width="100%" alt="Very Happy production UI with a session sidebar, real running terminal, and file preview using sanitized data">
</a>

<p align="center"><sub>AUTHENTIC PRODUCT UI CONTRACTS · SANITIZED DATA · SIDEBAR + TERMINAL + FILE PREVIEW</sub></p>

### Clipboard → target machine, without the detour

Paste a screenshot or drag a file straight into a Very Happy browser terminal.
The daemon receives it on the selected machine under
`~/.happy/uploads/terminal/`, then Very Happy pastes a path quoted for the
daemon's default shell at the terminal cursor. The chosen Cloud or self-hosted
server is the trusted relay for this bounded transfer.
It never presses Enter for you.
Native Windows insertion requires the current daemon so the Web client can
distinguish cmd from PowerShell.

```text
phone / laptop clipboard  ── chosen deployment ──>  selected machine
dragged file or screenshot                     ~/.happy/uploads/terminal/…
                                                        │
                                                        ╰─> shell-quoted path at cursor
```

<a href="https://veryhappy.dev/welcome#proofs">
  <img src="docs/screenshots/file-handoff.png" width="100%" alt="Very Happy terminal file handoff using the production terminal UI contract with sanitized local demo data">
</a>

<p align="center"><sub>PASTE OR DROP · BOUNDED MACHINE RPC · ATOMIC TARGET FILE · NO AUTO-RUN</sub></p>

Terminal handoffs are capped at 8 MB, transferred in bounded chunks, and shown
with progress/error feedback. Older daemons retain the previous small-file
path; update the CLI and restart the daemon for larger files. Files pass through
the selected deployment on their way to the machine; choose Cloud or self-hosting
according to your environment.

## Why choose Very Happy?

| The friction | What carries it for you |
|---|---|
| “My agents and terminals are scattered across several machines.” | One account sidebar and task board aggregate their sessions and attention state; start new work on the machine and agent you choose. |
| “I left my desk, so the work stopped being legible.” | A responsive Web/PWA workspace with mobile conversation, terminal, files, tasks, notifications, and Home Screen installation. |
| “Structured chat is pleasant, but sometimes I need the actual tool.” | Keep SDK-backed Claude and drop into a durable, unmodified agent TTY/TUI when necessary. |
| “Every session is another pile of context to remember.” | Session organization, file context, task board, todos, notes, status, and an optional coordinating meta-agent. |
| “One model vendor should not own my whole workspace.” | Claude Code and Codex today; beta Gemini/OpenCode through Agent Client Protocol; OpenClaw through its own local gateway. |
| “My useful terminal workflow is not a coding agent.” | The tmux/TTY path also carries shells, editors, Git clients, SSH, database consoles, and ordinary xterm-compatible text TUIs; structured agent features are additive, not required. |
| “Remote control must fit my operating model.” | Use the community Cloud for the fastest start, or deploy the same open-source stack under your control. |
| “Keyboard speed disappears on the Web.” | A production command palette plus shortcuts for switching work, saved prompts, notes, new terminals, and navigation—with touch equivalents. |
| “The file I need is on the device in my hand, not the machine doing the work.” | Paste a screenshot or drop a file into the browser terminal; its shell-quoted path appears on the selected machine without auto-running a command. |

The philosophy is straightforward: stay high-level when that is faster, drop to
the raw machine when it is necessary, and make the interface carry as much
operational overhead as possible.

## One command to your first machine

On macOS or Linux, the hosted Cloud path can install the CLI, run diagnostics,
open the one-time browser approval, and start the detached daemon in one command:

```bash
(
  set -eu
  vh_installer=$(mktemp)
  trap 'rm -f "$vh_installer"' \
    EXIT HUP INT TERM
  curl -fsSL \
    https://veryhappy.dev/install.sh \
    -o "$vh_installer"
  sh "$vh_installer"
)
```

The bootstrap is intentionally boring where trust matters. It:

1. verifies a supported Node.js runtime;
2. resolves the npm `latest` tag once, validates it, and installs that exact
   `very-happy-cli` version;
3. runs `very-happy doctor` without intentionally reading provider credential
   values (review all diagnostic output before sharing it);
4. opens the normal short-lived Web approval flow; and
5. runs `very-happy daemon start` so the machine actually appears online.

The command downloads the complete script to a random temporary file before it
runs and removes it afterward. It never invokes `sudo`, installs tmux, writes
provider credentials, enables Claude hooks, or hides the trusted-relay warning.
Hosted bytes can change with a Web release: for the auditable path, download the
[version-controlled script](packages/happy-web-v2/public/install.sh), compare it,
then run the local file. Its offline no-mutation preview is:

```bash
sh ./install.sh --dry-run
```

The script can connect terminal-based agents without a Claude credential. For
structured Claude, configure a supported provider credential in the daemon's
startup environment. If you add it after the bootstrap has started the daemon,
reload that environment with:

```bash
very-happy daemon stop && very-happy daemon start
```

<details>
<summary><strong>Prefer the fully manual path?</strong></summary>

```bash
npm install --global very-happy-cli
very-happy doctor
very-happy auth login
very-happy daemon start
```

Approve only a machine request you just initiated. Then open
[veryhappy.dev](https://veryhappy.dev), choose the connected machine,
and create your first session.

</details>

### Machine requirements

| Requirement | Status | Why |
|---|---:|---|
| Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+, with npm | Required | Runs the CLI and daemon |
| Agent provider/runtime | Per agent | Structured Claude uses the bundled Agent SDK plus provider credentials; native terminals and other adapters need their local command or gateway |
| `tmux` | Recommended | Keeps real Web terminals alive across browser disconnects |
| `tmux` 3.2+ | Optional Claude mirror | Provides the create-time environment markers used by terminal → structured handoff |

For the first structured Claude session, configure `ANTHROPIC_API_KEY` or a
supported Bedrock, Vertex AI, or Foundry environment for the same OS user and
startup environment that runs the daemon. `very-happy doctor` reports only the
credential source category. See
[configuration](docs/configuration.md#claude-credentials-for-structured-sessions).

Provider credentials stay local by default. `very-happy connect` is a separate,
explicit flow that stores a selected OpenAI, Anthropic, or Gemini OAuth
credential on your chosen deployment so Web-launched integrations can use it;
it is currently used primarily by the Gemini path.

### Self-hosted first connection

Deploy the relay first, use HTTPS, then keep all three endpoint variables in the
environment that starts the daemon:

```bash
export HAPPY_HOME_DIR="$HOME/.very-happy-relay.example.com"
export HAPPY_SERVER_URL=https://relay.example.com
export HAPPY_WEBAPP_URL=https://relay.example.com

npm install --global very-happy-cli
very-happy doctor
very-happy auth login
very-happy daemon start
```

Use a separate `HAPPY_HOME_DIR` for each relay. Tokens and machine IDs belong to
the relay that issued them. The supported public self-host path is the pinned
repository Docker build—not the upstream-owned `happy-server-self-host` npm
package. See [Self-hosting](docs/deployment.md).

## Move at thought speed

<p>
  <kbd>⌘ K</kbd> / <kbd>Ctrl K</kbd>
  &nbsp; command palette &nbsp;·&nbsp;
  <kbd>⌘ 1–9</kbd> / <kbd>Ctrl 1–9</kbd>
  &nbsp; switch visible work &nbsp;·&nbsp;
  <kbd>⌘ J</kbd> / <kbd>Ctrl J</kbd>
  &nbsp; notes
</p>

The production command palette searches actions, chats, and terminals. Saved
prompts use `Command/Ctrl+.`; mobile users open the same command surface from
the sidebar Search control.

Very Happy preserves terminal muscle memory: on macOS, `Ctrl+K/J/N/R` stay with
readline and the real TUI. Browser-reserved new/close chords work only where the
platform delivers them to an installed PWA; normal tabs use the explicit
`Alt+N` and `Alt+W` fallbacks. See the precise
[keyboard and touch reference](docs/keyboard-shortcuts.md).

## Agent surface

| Adapter | Status | Experience |
|---|---|---|
| Claude Code | Shipped · deepest integration | Bundled Agent SDK structured sessions; native Claude TUI; optional Claude-only terminal mirror |
| Codex | Shipped | Dedicated Codex session path plus native terminal access |
| Gemini | Beta · implemented | Agent Client Protocol backend and preset |
| OpenCode | Beta · implemented | ACP-compatible preset over local stdio |
| Custom ACP command | Beta · implemented | Generic runner for a compatible Agent Client Protocol stdio endpoint |
| OpenClaw | Shipped | Its own local gateway adapter—not ACP |
| Pi / provider-aware routing | Roadmap | Candidate adapters and cross-provider subtask coordination, not shipped claims |

Agent Client Protocol is distinct from the older Agent Communication Protocol
that shares the ACP acronym. Support for a terminal-backed agent does not imply
structured parity with Claude.

## What ships today

- Structured Claude conversations with tool calls, diffs, permissions, usage,
  attachments, and resume.
- Real tmux browser terminals with reconnect, scrollback, search, mobile input,
  archived sessions, file access, and automatic recovery.
- A machine file browser with rich previews for text, Markdown, images, and PDFs,
  plus clickable files from agent output.
- Clipboard and drag/drop handoff into a target-machine terminal, with an 8 MB
  limit, bounded chunking, upload feedback, and quoted-path insertion without
  auto-execution.
- Task board, todo-provider commands, notes, notifications, Web Push, and HTTPS
  webhooks.
- A Claude-powered coordinator with text entry, session awareness, and dispatch
  on its selected machine; voice entry is available when a compatible voice
  service is configured.
- Passwordless email-code and Google sign-in, optional password compatibility,
  configurable signup/capacity controls, a hosted
  public relay, and production-oriented self-hosting.
- A mobile-friendly, proactively installable PWA—no app store required.

Optional Claude terminal mirroring is explicit and reversible:

```bash
very-happy install-terminal-hooks
# Remove only Very Happy's entries later:
very-happy install-terminal-hooks --remove
```

This modifies `~/.claude/settings.json` (or
`$CLAUDE_CONFIG_DIR/settings.json`) without deleting foreign hooks. Normal
SDK-backed Claude sessions do not require it.

### MCP handoffs: make local work visible where you are

Very Happy injects a small MCP surface into managed sessions so an agent can do
more than print another line: it can hand text to your browser clipboard, open
a produced file in the Web preview, keep the session title useful, and report
progress. The exact tools deliberately follow the runner:

| Runtime path | MCP tools shipped today |
|---|---|
| Base managed Claude session | `change_title`, `copy_to_clipboard`, `open_preview`, `report_progress` |
| Managed Codex / Gemini / ACP bridge | `change_title`, `copy_to_clipboard`, `open_preview` |
| Assistant/meta-agent variant additions | `sessions_list`, `session_read`, `session_send`, `session_spawn`, `session_kill`, `session_archive`, `terminals_list`, `terminal_read`, `terminal_send`, `memory_update`, `journal_append` |
| User-scoped plain `claude`, after opt-in | `copy_to_clipboard` only |

Enable the narrow plain-terminal bridge with:

```bash
claude mcp add --scope user very-happy-clipboard -- very-happy mcp
```

That registration applies to every Claude session for the same OS user, not
only processes inside a Very Happy terminal. It needs the local daemon. The
assistant-only additions can read and mutate sessions, terminals, memory, and
journals; treat that variant and its prompt/tool permissions as a high-privilege
machine control surface. This is not a universal MCP or provider-routing claim.
See the exact [integration contracts](docs/channels.md).

## Compose it into a larger agent system

Very Happy is an execution surface, not a closed automation platform. Generic
webhooks plus [`very-happy spawn` and `very-happy send`](docs/channels.md) let a
carefully scoped adapter connect an issue tracker, scheduler, chat system, or
future provider-aware coordinator.

The adapter must own sender authorization, fixed workspace policy, deduplication,
rate limits, and least-privilege execution. Incoming messages are input, never
authorization by themselves.

```text
browser / PWA  ⇄  Cloud or self-hosted relay  ⇄  machine daemon
                                                   │
                         ┌─────────────────────────┼───────────────┐
                         ▼                         ▼               ▼
                  structured agent            real TTY       files / tasks
```

The relay synchronizes workspace state and routes RPC/socket traffic. Encrypted
envelopes inherited from Happy remain defense in depth, but the Very Happy server
can recover account keys. Transport/storage encryption does not make the relay
zero knowledge. Read [Architecture](docs/architecture.md) and
[Security](docs/security.md).

## Direction, not marketing fiction

The roadmap moves toward more agent adapters, provider-aware subtask routing,
durable project/task memory, and a meta-agent that brings users decisions rather
than activity. The long-term visual concept is a multi-agent virtual office—
possibly pixel-art—where work, handoffs, and requests for attention become
spatially legible.

Those are roadmap concepts, not shipped features. The philosophy already ships:
**work anywhere, keep the thread, and reduce the amount of operational state a
human has to hold.** See the [roadmap](docs/roadmap.md).

## Run it, understand it, improve it

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Self-hosting](docs/deployment.md)
- [Configuration](docs/configuration.md)
- [Upgrading and rollback](docs/upgrading.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Security policy](SECURITY.md)

The production frontend is `packages/happy-web-v2`. The upstream Expo/Tauri
`packages/happy-app` is retained as an experimental seed for a possible future
desktop client; it is currently excluded from the pnpm workspace, production,
and the supported Very Happy client/security scope.

## Attribution and license

Very Happy is a friendly, deeply modified fork of
[slopus/happy](https://github.com/slopus/happy) and retains upstream copyright
and MIT terms. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Claude Code, Codex,
Gemini, OpenCode, OpenClaw, and other named agents are products or projects of
their respective owners. Very Happy is independent and is not affiliated with
them.
