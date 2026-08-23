# Architecture and data flow

## Components

```text
Web V2 / PWA
    │ HTTPS + Socket.IO
    ▼
trusted happy-server ── database / files / optional Redis
    │ account-scoped realtime + RPC
    ▼
very-happy CLI daemon ── PTY / Claude Agent SDK ── Claude Code
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
to the account's machine daemon. The daemon starts Claude Code through the Agent
SDK or attaches a local/terminal-backed path, and sends normalized updates back
through the relay. The server persists sync state needed by other browsers.

## Encryption boundary

Wire envelopes inherited from Happy are still encrypted. Very Happy's account
login requires the server to recover account secrets, so the application server
is inside the confidentiality and control boundary. See [security.md](security.md)
and [encryption.md](encryption.md) for exact formats and limitations.
