# Architecture and data flow

## Components

```text
Web V2 / PWA
    │ HTTPS + Socket.IO
    ▼
trusted happy-server ── database / files / optional Redis
    │ account-scoped realtime + RPC
    ▼
very-happy CLI daemon ── agent runners / PTY ──┬─ Claude Code
                                               ├─ Codex
                                               ├─ Gemini / compatible ACP agent
                                               └─ OpenClaw gateway
```

- `packages/happy-web-v2`: production React/Vite browser client.
- `packages/happy-server`: identity, persistence, realtime routing, files,
  notifications, and static Web hosting.
- `packages/happy-cli`: local daemon, agent launcher, terminal bridge, and RPC
  implementation.
- `packages/happy-wire`: shared compatibility schemas.

The legacy Expo `packages/happy-app` is retained from upstream history and is not
a supported production client in this fork.

## Identity and connection

Password and verified Google identities map to an `Account`. Web logins receive
expiring, revocable login sessions. Existing CLI tokens remain compatible. A new
machine begins a short-lived pairing request; the signed-in user approves it in
the browser, then the daemon establishes an account-scoped socket.

## Session path

The browser creates or opens a session through the relay. The relay routes RPC
to the account's machine daemon. The daemon selects a provider runner: the
Claude Agent SDK path, the Codex integration, an ACP backend such as Gemini, a
generic ACP command, an OpenClaw gateway adapter, or a local terminal-backed
path. Each runner maps its native events into the shared session protocol and
sends normalized updates back through the relay. The server persists sync state
needed by other browsers.

Provider parity is not implied. Claude currently has the richest structured and
terminal-mirroring experience; Codex, ACP providers, and OpenClaw reuse the
common workspace but expose only the capabilities their runners normalize. See
[session-protocol.md](session-protocol.md) for the provider envelope contract.

### Two Claude interaction paths

Upstream Happy's core Claude flow wraps the Claude Agent SDK to provide a
structured conversation. Very Happy retains that flow and adds a terminal path
whose source of truth is the real agent process:

| Path | Process and transport | Browser experience |
|---|---|---|
| SDK-backed Claude | The daemon calls the Claude Agent SDK and normalizes its events. | Structured messages, tools, diffs, permissions, usage, and resume. |
| tmux-backed terminal | `tmux` owns the long-lived TTY/TUI on the user's machine. A daemon control-mode client carries pane output and input through the trusted relay; xterm renders it in the browser. | The actual Claude Code or other agent CLI/TUI, including reconnect, local scrollback, search, and mobile input. |

The terminal is not a screenshot or a browser reimplementation of the agent UI.
The process continues in `tmux` when the browser disconnects. If `tmux` is not
available, the daemon can fall back to a direct shell, but durable background
survival is then unavailable.

The terminal mirror is opt-in and requires `tmux` 3.2 or newer so the daemon can
inject the terminal binding into a newly created session. `very-happy
install-terminal-hooks` merges a SessionStart/SessionEnd pair into Claude's user
settings; it binds only a hand-started Claude process inside a Very Happy
terminal while the daemon is running. `very-happy install-terminal-hooks
--remove` removes Very Happy's entries without removing foreign hooks.
SDK-backed Claude conversations do not depend on this hook pair. The structured
mirror is a Claude integration, not a promise that every terminal-backed agent
exposes equivalent structured events.

## Encryption boundary

Wire envelopes inherited from Happy are still encrypted. Very Happy's account
login requires the server to recover account secrets, so the application server
is inside the confidentiality and control boundary. See [security.md](security.md)
and [encryption.md](encryption.md) for exact formats and limitations.
