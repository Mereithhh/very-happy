# Channels — integrating Happy with external tools and chat apps

Happy deliberately keeps integrations *outside* the core: the server and CLI
expose a small set of stable public surfaces, and external adapters (bots,
IM bridges, schedulers) compose them. This document is the contract for those
surfaces. The in-app summary lives at **Settings → Channels**.

There are two directions:

- **Outbound** — the server calls *your* HTTPS endpoint when a session needs
  attention (account webhook).
- **Inbound** — external automation drives sessions through the CLI on the
  machine that runs your daemon (`very-happy spawn` / `very-happy send`), plus
  an optional stdio MCP server (`very-happy mcp`) that gives a plain `claude`
  a `copy_to_clipboard` tool.

## Architecture

```
                        OUTBOUND (notifications)
  ┌──────────┐  session events   ┌─────────────┐  POST {"title","message"}
  │ sessions │ ────────────────► │ happy-server│ ─────────────────────────►┐
  └──────────┘  done/permission/ └─────────────┘   (account webhook,       │
                question                            last line `session: <id>`)
                                                                           ▼
                                                              ┌────────────────────┐
                                                              │  your adapter /    │
                                                              │  notify gateway    │
                                                              │  (e.g. Tanka bot)  │
                                                              └─────────┬──────────┘
                                                                        │ forwards to group chat;
                        INBOUND (control)                               │ user quote-replies
  ┌──────────┐  spawn-session /  ┌─────────────┐   very-happy spawn     │
  │  daemon  │ ◄──────────────── │ very-happy  │ ◄──────────────────────┤
  │ (per     │  clipboard        │    CLI      │   very-happy send      │
  │  machine)│                   └─────────────┘   (adapter shells out) │
  └────┬─────┘                                                          │
       │ persists session keys                    parses `session: <id>`┘
       ▼                                          from the quoted notification
  ~/.happy/sessions.json
```

The reference adapter is our Tanka IM integration: webhook notifications land
in a group chat, a `[happy] <task>` message spawns a new session, and a
quote-reply to any notification is piped straight back into that session.

---

## Outbound: account webhook

One webhook per account. When a session event fires — agent turn finished,
permission request, or clarifying question — the server POSTs a small generic
JSON to your endpoint. Designed for notify-gateway style receivers, but any
HTTPS endpoint accepting the JSON works.

Web terminals (bare tmux claude, no session channel) feed the same webhook:
the daemon watches each terminal's agent state at list-track cadence and, on a
stable working→idle / →needs_input transition (2-tick debounce, ≥60s
per-terminal cooldown, only after the terminal has been seen working), POSTs
`/v1/webhook/notify` with `event` + a `/terminal/<machineId>?tid=<id>` link —
so the account's `events` toggles gate these exactly like session events.
Terminal notifications carry no `session:` trailer (there is no session).

### Management API

All three endpoints require the account bearer token
(`Authorization: Bearer <token>`).

| Method   | Path          | Body                                            | Semantics |
|----------|---------------|-------------------------------------------------|-----------|
| `GET`    | `/v1/webhook` | —                                               | `{"webhook": {"url", "events"} \| null}` |
| `POST`   | `/v1/webhook` | `{"url": "...", "events": ["completed","permission"]}` | Create **or replace** (an account has at most one webhook). `events` optional; defaults to both. 400 with `{"error": "..."}` on invalid URL. |
| `DELETE` | `/v1/webhook` | —                                               | Remove the webhook. |
| `POST`   | `/v1/webhook/notify` | `{"title": "...", "message"?: "...", "sessionId"?: "...", "taskId"?: "...", "event"?: "completed"\|"permission", "link"?: "/<web path>"}` | Notification forwarder: the server pushes `{title, message}` through the account's webhook. Without `event` it is a MANUAL notification (the web's "mark done" ✓ uses this — `✅ 已完成 · <名>`), not gated by `events` (an explicit user action is always wanted). With `event` it is an AUTOMATIC one (the daemon's web-terminal agent-state notifications use this) and IS filtered by the webhook config's `events` — unsubscribed events return `delivered:false` without sending. Returns `{"ok": true, "delivered": bool}`; `delivered:false` when no webhook is configured, the event is unsubscribed, or delivery failed. Rate-limited per account (30/min → 429). `sessionId` adds the link line + `session: <id>` trailer; `taskId` adds a `task: <id>` line **before** the session trailer; `link` (a web-app path starting with `/`, ≤300 chars, e.g. `/terminal/<machineId>?tid=<terminalId>`) appends a `链接：<HAPPY_WEB_URL><link>` line right after the message (omitted when `HAPPY_WEB_URL` is unset). Old clients send neither new field and keep the legacy behavior. |

Event categories:

- `completed` — the agent finished its turn and the session is idle
  (push kind `done`).
- `permission` — needs attention: permission requests **and** clarifying
  questions (push kinds `permission` and `question`).

URL validation (SSRF guard, enforced on save *and* re-checked at send time):
`https://` only, max 2048 chars, no userinfo, and literal
loopback / private / link-local / CGNAT hosts are rejected. Redirects are
refused at delivery time.

Delivery is **best-effort**: 5s timeout, no retry, failures only logged. Never
build anything that depends on guaranteed delivery.

### Delivery payload

```json
{
  "title": "✅ 任务完成 · <session title, ≤60 chars>",
  "message": "<headline>\n会话：<session title>\nAgent：<provider>\n链接：<web url>/session/<id>\nsession: <id>",
  "sessionId": "<id>"
}
```

- `title` — heading, prefixed by event emoji: `✅ 任务完成` (completed),
  `⏸ 需要确认` (permission), `❓ 等待回答` (question).
- `message` — plain-text lines. The `Agent：` line only appears when the event
  carries a provider; the `链接：` line only appears when the server has
  `HAPPY_WEB_URL` set (see below).
- `sessionId` — duplicated as a top-level field for receivers that parse JSON.
  Generic text-only gateways drop it — which is exactly why the id is ALSO
  embedded in the message text:

**The `session:` trailer (stable contract).** When the event has a session id,
the **last line** of `message` is always exactly:

```
session: <sessionId>
```

This line is fixed and machine-parseable, and it survives any text-only relay
(gateway → IM → quoted reply). Adapters should extract the session id from
this trailer, not from the JSON field. Regex: `/^session: (\S+)$/m` (take the
last match).

### `HAPPY_WEB_URL`

The server does not reliably know its own public web origin, so clickable
session links are an explicit opt-in: set the env var `HAPPY_WEB_URL` (e.g.
`https://happy.example.com`) on **happy-server** to get a
`链接：<base>/session/<id>` line in every webhook message. Unset, the message
still carries the bare `session: <id>` trailer.

---

## Inbound: daemon control via the CLI

External automation talks to sessions through two CLI subcommands
(v0.2.28+), running **on the machine where the Happy daemon runs**. No extra
credentials — the CLI reuses the daemon's. Under the hood, `spawn` rides the
daemon's local control server (`POST /spawn-session` on 127.0.0.1), and
message delivery encrypts the user envelope with the session key from
`~/.happy/sessions.json` and POSTs it to the server's
`/v3/sessions/:id/messages` outbox — the exact same path the web client uses.

### `very-happy spawn` — start a session

```bash
very-happy spawn --dir <path> [--prompt <text> | --prompt-file <file>] [--json]
```

- `--dir, -d <path>` — working directory for the new session (required; must
  already exist — spawn refuses to create directories).
- `--prompt, -p <text>` / `--prompt-file <file>` — optional first user message
  (mutually exclusive; file is read as UTF-8). Without either, the session is
  spawned idle.
- `--json` — machine-readable output: `{"sessionId": "...", "url": "..."}`.
  Without it, a human-readable line with a clickable session URL is printed.

Requires the daemon to be running (same semantics as spawning from the web:
an offline machine cannot spawn). It will **not** auto-start the daemon.

Exit codes:

| Code | Meaning |
|------|---------|
| `0`  | success |
| `1`  | spawn failed — no session was created |
| `2`  | session created, but sending the first message failed (the session exists; the URL is still printed) |

### `very-happy send` — message an existing session

```bash
very-happy send --session <id> (--prompt <text> | --prompt-file <file>) [--json]
```

Pushes one user message into a session that is already running. The session
key must be present in `~/.happy/sessions.json`, i.e. the session must have
been spawned by **this machine's** daemon (recent enough to persist keys).
Unlike spawn, `send` does not need the daemon to be alive — delivery goes
through the server REST outbox directly.

Exit codes: `0` delivered, `1` anything else (bad args, unknown session /
missing key, send failed).

### `very-happy mcp` — clipboard tool for a plain `claude`

Remote SDK sessions get the happy MCP server injected automatically, but a
plain `claude` running inside a Happy web terminal (tmux) only loads the
user's normal MCP config. Register once per machine:

```bash
claude mcp add --scope user very-happy-clipboard -- very-happy mcp
```

This gives that `claude` a `copy_to_clipboard` tool: text is forwarded to the
local daemon over its 127.0.0.1 control server (`POST /clipboard`), relayed
over the authenticated machine socket, and fanned out to the clipboard of
every web client the user has open. Payloads over 256KB are truncated.

---

## Adapter example (IM bridge, Tanka-style)

Pseudocode for a quote-reply IM adapter — the pattern our Tanka integration
implements:

```text
# One-time setup:
#   POST /v1/webhook  {url: "<gateway ingest URL that forwards to the group>",
#                      events: ["completed", "permission"]}
#   Server-side: set HAPPY_WEB_URL for clickable links (optional).

on im_message(msg):
    # 1) New task from chat: "[happy] fix the flaky test"
    if msg.text.startswith("[happy] "):
        prompt = msg.text.removeprefix("[happy] ")
        out = run(["very-happy", "spawn",
                   "--dir", DEFAULT_WORKDIR,
                   "--prompt", prompt,
                   "--json"])
        if out.exit_code in (0, 2):          # 2 = session exists, msg failed
            reply(msg, f"session started: {json.loads(out.stdout)['url']}")
        else:
            reply(msg, "spawn failed")
        return

    # 2) Reply routed back into a session: quote-reply to a notification
    if msg.quoted_message is not None:
        m = last_match(r"^session: (\S+)$", msg.quoted_message.text)
        if m:
            out = run(["very-happy", "send",
                       "--session", m.group(1),
                       "--prompt", msg.text])
            react(msg, "✅" if out.exit_code == 0 else "❌")
```

Design notes:

- Parse the `session:` trailer from the **quoted text**, not from stored
  state — it makes the adapter stateless and restart-safe.
- Use `--prompt-file` for long or multi-line replies to avoid shell-quoting
  issues.
- The adapter must run on the same machine as the daemon that spawned the
  sessions (that is where the session keys live).
- Webhook delivery is best-effort; treat notifications as hints, not a queue.
