# Channels — integrating Happy with external tools and chat apps

Very Happy owns Agent Teams coordination; organization-specific integrations remain *outside* the core: the server and CLI
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

## Choose a path

| You want to… | Configure here |
|---|---|
| Receive completion / permission notifications | [Account webhook](#outbound-account-webhook), or **Settings → Channels** |
| Show an external task list in the Todo panel | [Todo provider](#inbound-todo-provider-external-task-lists-in-the-web-ui), in `~/.happy/settings.json` on that machine |
| Dispatch work from a script, scheduler, or IM bridge | [`very-happy spawn` / `very-happy send`](#inbound-daemon-control-via-the-cli) |
| Let that script see and steer what it dispatched | [`very-happy sessions`](#very-happy-sessions--inspect-and-control-what-is-running) |
| See every session on the account, and which ones are waiting on a human | [`very-happy sessions list --all`](#sessions-list---all--the-whole-account-with-an-honest-limit) |
| Approve or deny a pending permission request from a script | [`very-happy sessions approve` / `deny`](#sessions-approve--deny--answer-a-permission-request) |
| Let Very Happy's coordinator dispatch Claude sessions | [Web Assistant / meta-agent](#inbound-web-assistant--meta-agent) |
| Add clipboard handoff to a plain local Claude | [`very-happy mcp`](#very-happy-mcp--clipboard-tool-for-a-plain-claude) |
| Organize Claude, Codex, and managed pi as a team | [Agent Teams getting started and migration](agent-teams.md) |
| Run something on a schedule, or start / continue a session from an external event | [`very-happy auto` — Automations](#automations-scheduled-and-triggered-runs-feature-gated) |

## MCP capability matrix

MCP is a handoff surface into the Web workspace, not a claim that every runner
has the same tool set:

| Runtime path | Tool surface |
|---|---|
| Base managed Claude session | `change_title`, `copy_to_clipboard`, `open_preview`, `report_progress` |
| Managed Codex / Gemini / ACP bridge | `change_title`, `copy_to_clipboard`, `open_preview` |
| Managed Claude (in-process), Codex / Gemini / ACP (the stdio bridge forwards them) and pi (`HAPPY_MCP_URL`, discovered via `tools/list`) additionally | `team_*` (Agent Teams) and the B-496 Automations tools: `automation_list`, `automation_get`, `automation_create`, `automation_update`, `automation_pause`, `automation_resume`, `automation_delete`, `automation_run`, `automation_fire`, `automation_runs`, `automation_report`, `automation_ack` — account authority, same trust level as the session; and the B-497 session peer tools `session_message`, `session_peers` (message / list the other sessions on this machine — and, since B-506, on the account's other machines: `session_message` to a foreign session is routed to its machine, `session_peers` takes `machineId`; see [`very-happy sessions peers` / `message`](#sessions-peers--message--talk-to-the-other-sessions-on-this-machine)) |
| Voice Assistant / legacy assistant variant additions (Claude, in-process) | `sessions_list`, `session_read`, `session_send` (both follow the B-506 route for sessions another machine spawned; optional `machineId`), `session_spawn`, `session_kill`, `session_archive`, `terminals_list`, `terminal_read`, `terminal_send`, `memory_update`, `journal_append` |
| User-scoped `very-happy mcp` (plain `claude`, pi, …) | `copy_to_clipboard` only |
| User-scoped `very-happy mcp` **inside a vh web terminal** (`VH_TERMINAL_ID` set by the daemon's tmux terminal) | + `change_title`, `open_preview` (titles/previews for that terminal via authenticated daemon IPC) |
| User-scoped `very-happy mcp` **inside a meta-agent session of a non-Claude runner** (`HAPPY_SESSION_VARIANT=assistant`, legacy compatibility only) | `copy_to_clipboard` + `sessions_list`, `session_read`, `session_send`, `session_spawn`, `session_kill`, `session_archive` |

The first two paths are injected by their managed runners. The assistant-only
additions can read and mutate sessions, terminals, memory, and journals; treat
that variant and its prompt/tool permissions as a high-privilege machine
control surface. The standalone `very-happy mcp` command is narrower: outside a
meta-agent session it is clipboard-only, and even inside one it never exposes
terminal management, memory, journal, provider routing, or progress
tools. A terminal context additionally enables title and file-preview tools. It also stays clipboard-only under a happy-managed Claude
(`HAPPY_MANAGED=1`), so a Claude assistant that happens to have the user-scoped
registration too does not see the session tools twice. External automation
should use the explicit CLI contracts below.

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

One deployment adapter pattern is an IM bridge: webhook notifications land
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
very-happy spawn --dir <path> [--prompt <text> | --prompt-file <file>] \
  [--spawned-by <name>] [--permission-mode <mode>] [--agent <name>] \
  [--model <id>] [--env KEY=VALUE]... [--json]
very-happy spawn --fork <sessionId> [--prompt …] [--permission-mode <mode>] \
  [--model <id>] [--spawned-by <name>] [--json]
```

**Defaults match the Web launcher (B-492).** Permission mode and the first
message's model come from the same table the launcher uses
(`AGENT_CODE_DEFAULTS` in `packages/happy-wire/src/agentCodeDefaults.ts`):
claude / codex / pi start in yolo, gemini / openclaw in `default`; a claude
session's first message pins `claude-opus-5-5` (or the machine default when
the wrapper does not advertise `claude-opus-5-5-v1`) with `effort: null`,
exactly as `resolveMessageModeMeta` does for a fresh Web session. Account-level
overrides from the Web settings page are **not** applied: they are encrypted
with the account content key, which `dataKey` CLI credentials do not hold.

- `--dir, -d <path>` — working directory for the new session (required; must
  already exist — spawn refuses to create directories).
- `--prompt, -p <text>` / `--prompt-file <file>` — optional first user message
  (mutually exclusive; file is read as UTF-8). Without either, the session is
  spawned idle.
- `--spawned-by <name>` — the spawn origin. The session is **born carrying it
  as its tag**: a chip in the Web list, searchable as `#<name>`, so dispatched
  work stays distinguishable from sessions the user opened by hand. The value
  must read as a tag — 1-24 chars of `[a-z0-9]` plus `-`/`_`, starting with a
  letter or digit — and the CLI rejects anything else up front rather than
  handing an unattended adapter a healthy but silently untagged session. Omit
  it and the session is simply untagged. A daemon predating the field strips it
  and still spawns, so **a missing tag is not a spawn failure**.
- `--permission-mode <mode>` — `default`, `acceptEdits`, `plan`, `yolo` or
  `bypassPermissions`. **Omitting it gives the launcher default** (yolo for
  claude / codex / pi — before B-492 it was `default`); a fork keeps its
  source's mode. A `default` session stops at the first tool that is not
  already allowed, waiting for a human to approve in the Web UI. For an
  unattended dispatcher that is a hang, not a prompt: watch for the `permission`
  webhook / poll `sessions list --all` and answer with `sessions approve` / `deny`.
  The CLI rejects an unknown mode instead of passing it on, because
  the daemon's own behaviour for an invalid mode is to drop it and spawn
  without the flag — silently giving you `default` again.
- `--agent <name>` — `claude` (default), `codex`, `gemini`, `openclaw` or
  `pi`. `pi` runs through the [pi-acp](https://www.npmjs.com/package/pi-acp)
  adapter (`very-happy pi` = the generic ACP runner with `pi-acp`), so the
  daemon machine needs both `pi` and `pi-acp` on the daemon's PATH
  (`npm install -g @earendil-works/pi-coding-agent pi-acp@0.0.33`). The daemon
  reports that as `cliAvailability.pi`; the Web launcher offers pi only when a
  daemon reports the field, and enables it only when it is `true`, and the
  daemon's `/spawn-session` refuses `agent: 'pi'` while it is `false` — `spawn
  --agent pi` then exits 1 with the install hint instead of starting a wrapper
  that dies on `spawn pi-acp ENOENT` (invisible from the daemon). pi has no
  permission layer of its own and pi-acp exposes no ACP mode selector, so
  `--permission-mode` never reaches pi-acp; the runner sanitizes it (`default |
  acceptEdits | plan | bypassPermissions`, `yolo` → `bypassPermissions`, anything
  else dropped) and hands it to the pi side out-of-band: **`HAPPY_PERMISSION_MODE`**
  in the pi-acp child env at spawn, and for live switches (Web picker / `send`
  meta) **`<happy home>/session-modes/<HAPPY_SESSION_ID>.json`**
  (`{ "permissionMode": "...", "updatedAt": ms }`, 0600, atomic rename; written
  on start and on every switch, removed when the wrapper exits). The Web picker
  switches through the same file whether the session is idle (message `meta`)
  or working (`set-permission-mode` RPC). What is written there is also
  published as `metadata.permissionMode`, so the Web shows the effective value.
  Enforcement is provided by the CLI's official pi runtime extension, which
  re-reads the mode file before each tool call. `default` asks for non-read-only
  tools; `plan` blocks writes; `acceptEdits` permits edit/write but still asks for
  shell and other mutations; `bypassPermissions` is honored only when explicitly
  selected. User-installed extensions may enforce additional rules. The runtime
  does not remove them or require a private supervisor wrapper.
  pi's approvals surface as ACP `request_permission` cards in the
  Web UI (a pi extension calling `ctx.ui.confirm()` produces one), and
  `PI_ACP_PI_COMMAND` in the daemon's environment lets you point the adapter
  at a user wrapper. The official launcher preserves this override, so private
  wrappers and user-configured extensions can still impose extra permissions or
  models. Run `very-happy teams doctor --host pi` in the daemon environment to
  inspect the command source before migration. Remove obsolete private bindings
  deliberately after auditing their settings; the installer never removes them. pi-acp prints pi's startup banner
  (version, skills, extensions) as the first assistant message of every
  session; set `quietStartup: true` in `~/.pi/agent/settings.json` on the
  daemon machine to silence it.
  **What a pi tool call carries in the Web (B-353):** the `tool-call` event's
  `toolName` is still the ACP `kind` (`execute`/`read`/`edit`/`other`, so older
  Web builds render as before), and its `args` additionally carry the ACP
  `acpTitle`, `acpKind`, the pass-through `rawInput` (pi's tool arguments; dropped
  with `rawInputTruncated: true` above 64 KiB) and a derived `piTool`
  (`execute` → `bash` with `command` = the title; otherwise the title when it is
  a plain tool identifier such as `read`, `edit`, `write`, `session_spawn`).
  `acpTitle` / `acpKind` / `rawInput` are generic ACP passthrough (Gemini, OpenCode,
  `acp -- <cmd>` get them too); `piTool` / `command` are only derived when the
  agent is `pi`, so the Web may treat `piTool` as evidence that a session is pi.
  bash output streamed via pi-acp's `_meta.terminal_output` is accumulated and
  sent as the `tool-call-end` `result.text` (`isError` + `[exit code N]` suffix
  when non-zero, last 64 KiB kept). The permission request's `arguments` gain
  `acpTitle` / `acpKind` / `message` from the gate's confirm payload so the ask
  card can show the rule id and reason instead of a bare `other`. All of these
  fields are optional; a Web build that does not know them ignores them.
- `--model, -m <id>` — model for the session, carried by the first message
  (so it needs `--prompt` / `--prompt-file`; for an idle spawn pass it on the
  first `send --model`). `default` = the machine's own default.
- `--fork <sessionId>` — the Web's "fork session" from the CLI: copies the
  source conversation (Claude JSONL copy / Codex app-server `thread/fork`) and
  continues it in a new session with `parentSessionId` lineage, in the source's
  directory and agent (`--dir` / `--agent` are then optional and must match).
  The source must be a session this machine's daemon spawned; its current
  metadata is read from the server (the spawn-time copy in `sessions.json`
  lacks the provider id). The daemon must be B-492 or newer: it answers
  `resumed: true` from `/spawn-session`; an older daemon strips the resume
  fields and starts a fresh session, which `spawn --fork` then stops and
  reports as an error (the copied conversation file stays behind).
- `--env KEY=VALUE` — extra environment for the session process; repeatable.
  A `${VAR}` reference is expanded against the daemon's own environment, and an
  unresolved reference fails the spawn rather than starting a session with a
  literal `${VAR}` in its environment. Useful because a spawned session inherits
  the **daemon's** environment, not the dispatcher's.
- `--json` — machine-readable output: `{"sessionId", "url", "permissionMode"}`
  (the effective mode), plus `"spawnedBy"`, `"agent"`, `"forkedFrom"` and the
  `"model"` actually sent when they apply. Without it, a human-readable line with a clickable session URL is
  printed.

Requires the daemon to be running (same semantics as spawning from the web:
an offline machine cannot spawn). It will **not** auto-start the daemon.

Exit codes:

| Code | Meaning |
|------|---------|
| `0`  | success |
| `1`  | spawn failed — no session was created |
| `2`  | session created, but sending the first message failed (the session exists; the URL is still printed) |

### `very-happy sessions` — inspect and control what is running

```bash
very-happy sessions list [--all [--include-archived]] [--machine <id>] [--tag <name>] [--limit <n>] [--json]
very-happy sessions read <id> [--machine <id>] [--limit <n>] [--full] [--answer] [--wait [--timeout <s>]] [--json]
very-happy sessions stop <id> [--json]
very-happy sessions archive <id> [--json]
very-happy sessions approve <id> <requestId> [--for-session] [--json]
very-happy sessions deny <id> <requestId> [--reason <text>] [--json]
very-happy sessions peers [--scope repo|cwd|machine] [--cwd <dir>] [--machine <id>] [--json]
very-happy sessions message <id> <text> [--reply-to <msgId>] [--machine <id>] [--json]
```

**Across machines (B-506, CLI ≥ 0.2.157 on both sides;
[spec](../specs/2026-09-cross-machine-session-ops.md)).** `read`, `message`,
`list --all` and `peers --machine` reach sessions another machine of the
account spawned: the CLI asks the machine that holds the session to run the
operation with *its* keys and returns the plaintext result. The calling
machine never receives the account content key or another machine's session
key — that is the deliberate alternative to B-337. Mechanics: one short-lived
user-scoped socket, an `rpc-call` to `<machineId>:sessions.list|read|send|peers|message`
(the same channel the web uses for spawn / resume), answered by the owning
daemon as a plaintext JSON method (`RpcHandlerManager.registerPlainHandler`).
Same-account isolation is the server's room routing (`rpc:<userId>:<method>`),
so another account's daemon is unreachable by construction. The target daemon
whitelists exactly those five methods, checks the request shape, caps text at
64 KB, transcripts at 200 KB and `turn.answer` at 64 KB, allows 60 read
(list / read / peers) and 30 write (send / message) calls per minute in total,
abandons any call at 25 s with a `timeout` code (a send refuses to POST after
18 s, so an ambiguous failure never turns into a late duplicate; the CLI
retries once with the same `localId`, which the server deduplicates),
writes one audit line per call to its daemon log
(`[REMOTE SESSION OPS] <method> from machine=… host=… cli=… → ok|<code>`), and
refuses everything with `remoteSessionOps: "off"` in its `~/.happy/settings.json`.
Without `--machine` the online machines are asked newest-active first which
one holds the session (`sessions.list { ids }`); offline machines are skipped
(no daemon = no plaintext source; their sessions are unreachable until they
come back), and machines whose daemon reports a CLI older than 0.2.157 are
skipped or refused up front (the server exposes `lastHappyClient` on
`GET /v1/machines`). A daemon that does not answer surfaces as
"did not answer: its daemon is offline, restarting, or runs a CLI older than
0.2.157" rather than a silent 30 s hang. `approve` / `deny` / `stop` /
`archive` stay local-only.

**Ask and collect (B-492).** `read` reports where the latest turn stands:
`turn` in `--json` = `{ userSeq, ended, status, error, answer, lastSeq }`, where
`answer` is the agent's reply to the latest prompt — the text it wrote after its
last tool call, untruncated. `--wait` polls (every 3 s, window of the newest 500
messages) until a `turn-end` follows the latest prompt, then reads; it exits `2`
when `--timeout` (default 600 s) runs out, still printing the partial state.
`--answer` prints only that reply; `--full` lifts the 500-char per-line cap of
the transcript. A dispatcher's whole loop is therefore:

```bash
id=$(very-happy spawn --dir "$WORKDIR" --prompt-file task.md --spawned-by bot --json | jq -r .sessionId)
very-happy sessions read "$id" --wait --timeout 1800 --answer > reply.md
very-happy send --session "$id" --prompt "follow-up"   # then read --wait again
```

A prompt sent while a turn is running only counts as answered after its own
`turn-start` … `turn-end`, so the previous turn ending does not end the wait.

**Background tasks (B-507).** A turn ending is not the session going quiet:
an async-launched sub-agent, a `run_in_background` command or a Monitor keeps
running and wakes the session with a notification later. Every `list` row and
the `summary` of `read` carry `backgroundTasks` = `{ count, tasks[], reportedAt?,
stale? }`, each task `{ id, type, description, startedAt }` (`type` is the SDK
task type: `local_bash`, `local_agent`, `monitor`, …). The wrapper reports the
set on every change and renews it every 60 s; the local `list` reads it from
the daemon (lease 150 s, cleared when the wrapper exits), `--all` from the
session's agentState (same lease, plus the server's `active` flag; `stale:
true` means a set was reported but its lease ran out — count is 0). The field
is **absent** on a daemon or CLI too old to report it: absent means unknown,
not zero. Rules for a supervisor or an auto-archiver: `count > 0` → the
session is busy even though `turn.ended` is true; do not archive it, do not
call the work done. `read --wait` still returns on `turn-end` — check
`summary.backgroundTasks.count` afterwards if the task may fan out. Only the
Claude runner has this notion; Codex and pi rows never carry the field.
Automations runs (`very-happy auto`) apply the same rule: a spawn/send run
whose turn ended with background tasks still running stays `running` until
they finish and the wake-up turn ends (a never-ending Monitor therefore holds
the run until the server's `maxRuntimeMs`).

`spawn` and `send` start work; these let an external agent layer *see* it and
intervene — the same four operations the built-in assistant has over MCP, now
reachable without being the assistant.

- `list` — running sessions first (in daemon order), then the most recently
  seen. `--limit` caps only the not-running tail; running sessions are never
  cut. `--tag <name>` keeps the sessions born with that origin tag, which is
  how an adapter finds its own work among everything else on the machine.
  Terminal-mirror shadow sessions are never listed: they mirror what the user
  is already doing in a terminal and are not dispatchable work.
- `read` — the tail of a session as a role-tagged transcript (`--limit`
  messages, default 20, max 100).
- `stop` — SIGTERM the session's process via the local daemon.
- `archive` — mark the session inactive server-side; it stays resumable.

Scope: `list` (without flags) / `stop` / `archive` ask the local daemon;
`read` needs the session key, which is in `~/.happy/sessions.json` for
sessions this machine's daemon spawned (pruned after 14 days) — any other
session of the account is read through its own machine as described above.
`list --all` widens the listing to the account over REST (newest 150) and, for
rows this machine cannot decrypt, asks the online machines to fill them in:
every row carries `decryptable` (this machine's own key), `readable`
(decrypted here or by its machine), and for proxied rows `via` (the answering
machine id) and `machine: { id, host }`; the text form shows `via=<host>` and
`[running on <host>]`. `--json` adds `machines: { asked, skipped }` saying
which machines were consulted and which were skipped (offline / too old).
Rows no online machine holds keep only the server's plaintext columns.

Exit codes: `0` success, `1` anything else. Note that `stop` on a session the
daemon is not running exits `1` — a caller asking to stop something must be
able to distinguish "stopped it" from "there was nothing to stop".

#### `sessions list --all` — the whole account, with an honest limit

`list --all` asks the server (`GET /v1/sessions`, newest 150) instead of the
local daemon, so it sees sessions on **every** machine of the account — but it
can only *read* the ones this machine holds a key for. The server stores each
session's `metadata` and `agentState` encrypted with that session's key, and
a CLI holds only the keys it persisted itself in `~/.happy/sessions.json`.
Every row therefore carries `decryptable`:

- `decryptable: true` — spawned by this machine's daemon (≤14 days ago). The
  row has `title`, `cwd`, `machineId`, `flavor`, `tags`, and `pending`: the
  permission / question requests currently waiting on a human, oldest first,
  each with `id`, `tool`, `createdAt` and `waitingMs`. `attention` is `true`
  when `pending` is non-empty — this is the "needs me" signal a supervisor
  polls for.
- `decryptable: false` — belongs to another machine. Only the server's
  plaintext columns are present: `active` (a wrapper is attached), `archived`,
  `activeAt`, `updatedAt`, `url`. `title`/`cwd`/`pending` are *unreadable*,
  not empty; do not infer "no pending requests" from their absence.

Ordering: attention rows first (longest-waiting request first), then sessions
running under this daemon (`live`), then the rest newest-first. `--limit`
caps only that idle tail. `--tag` can only match decryptable rows. Archived
rows are hidden unless `--include-archived`. `--json` adds fields to the
local `list` shape and never renames one.

Making the foreign rows full-fidelity (and making `read` / `approve` work on
them) is a **credentials change** — the CLI would need to hold the account
content key the way the web does — not a flag on this command. Until then,
run the poller on each machine that dispatches work.

#### `sessions approve` / `deny` — answer a permission request

A `default`-mode session stops at the first tool that is not already allowed
and waits for a human. `approve`/`deny` send the wrapper exactly what the web
permission card sends — a session RPC `permission` with
`{ id, approved, decision }` (`approved`, `approved_for_session` with
`--for-session`, or `denied` plus an optional `reason`) — over a short-lived
user-scoped socket authenticated with the CLI's account token. A plain tool
approval carries no `mode` and no `allowTools`, on purpose.

Two facts the caller should know:

- The RPC payload is **encrypted with the session key**, so like `read` this
  works only for sessions in this machine's `~/.happy/sessions.json`. Same
  scope limit, same fix (above).
- The wrapper **ignores an unknown request id silently** (it logs "already
  resolved" and returns success). The CLI therefore reads the session's
  `agentState` first and refuses to send unless `<requestId>` is actually
  pending (exit 1 listing the ids that are), then re-reads for up to 5s after
  the ack and reports `settled: true|false` in `--json` — `false` means the
  wrapper acknowledged but had not yet written the request out of the pending
  set when we stopped waiting, not that it refused.

Exit `1` with a precise reason when: no local key; the session is not on
this account (404); the request is not pending; no wrapper is online for the
session (`RPC method not available`, or it disconnected mid-call); the RPC
timed out (30s); the wrapper's handler returned an `{error}` envelope. With
`--json`, every one of these still prints a record on stdout
(`{sessionId, requestId, error}` for the pre-RPC refusals, the full result
with `outcome.status` for the RPC-level ones), so a poller never has to parse
an empty string. Find `<requestId>` in `sessions list --all` (`pending[].id`)
or in the `permission` webhook.

#### `sessions peers` / `message` — talk to the other sessions on this machine

B-497. Several sessions (Claude, Codex, pi, and a `claude` typed into a Very
Happy web terminal) often work in the same repository at once. `peers` shows
who else is live here and what each touched lately; `message` puts a note into
one of them. The same two operations are the `session_peers` /
`session_message` MCP tools every managed session gets, so two agents can
coordinate directly — no lock, no permission change.

- `peers` — live sessions on this machine, excluding the caller. Scope
  `repo` (default): same git repository, **including its other worktrees**
  (`sameWorktree` says whether a row shares your checkout); `cwd`: the same
  directory; `machine`: everything. Each row carries `edits`: the real paths
  the session called an edit tool on in the last 30 minutes (Claude
  Edit/Write/MultiEdit/NotebookEdit, Codex patches, pi write/edit — and, for
  a terminal `claude` with the mirror hooks installed, its transcript).
  Terminal mirrors are listed with `kind: "mirror"`.
- `message <id> <text>` — the text lands in that session's chat as a user
  message headed `[Very Happy session message <msgId> from "<title>" <sessionId>; agent …; cwd …]`
  and ending with how to reply. The sender is the session named by
  `VH_PEER_SESSION_ID` when the command runs from a managed session's shell
  (every managed runner — Claude, Codex, pi — sets it for its child; it is a
  dedicated variable so `very-happy teams …` in that shell keeps behaving as
  before), otherwise `cli <user>@<host>` (then the footer says there is no
  session to reply to). `--reply-to` quotes the peer's message id. Refused,
  exit 1, with the reason on stderr (and `{delivered:false,error}` on stdout
  under `--json`) when the target is not running, or is a terminal mirror
  (nothing reads a mirror's queue; the person at that terminal does). A
  target another machine spawned is delivered through that machine's daemon
  (B-506): the header gains `; machine <host>` naming the sender's host, the
  footer says the message came from a session *on machine <host>* and that
  `session_message` back to it is routed automatically; `--json` adds
  `machine: { id, host }`. `--machine <id>` skips the lookup. `peers
  --machine <id>` lists that machine's live sessions instead (scope `machine`
  unless `--cwd` names a directory there; repo identity is computed on the
  target). `delivered` follows `very-happy send`
  (B-501): the message goes through `deliverToSession`, so `true` means a
  wrapper was attached before and after the POST; otherwise `--json` carries
  `delivered:false`, `stored` (it is on the server, unread) and `status`.
- **Reply-loop guard.** Inside a session, `session_message` refuses the 9th
  message to the same target within 10 minutes with an error that tells the
  agent to stop replying (the footer already says not to reply just to
  acknowledge). The CLI form has no budget: a person is typing.

**Edit conflicts.** The daemon keeps a 30-minute table of real path → sessions
that edited it. When a second live session edits a path another one touched in
the window, **both** get a notice headed
`[Very Happy edit conflict <id>; file <path>; peer "<title>" <sessionId>; …; peer edited <n>s ago]`
that names the other session and suggests `session_message` — once per pair
of sessions per file per window, delivered as a steer into a running turn
(queued otherwise). Conflicts on several files between the same two sessions
within 10 s are coalesced into ONE notice listing every file (`; more <n>` in
the header, `Files:` in the body), and a pair gets at most 5 notices per
window. Each edit report carries the time the runner saw the call; the daemon
ignores anything older than the window, so replayed transcript history (a
terminal mirror's backfill, a re-read after the file was replaced, a daemon
restart re-adopting a terminal) never produces a notice. Nothing is blocked:
it is a heads-up, and the Web shows it as a card linking to the other session.

### `very-happy send` — message an existing session

```bash
very-happy send --session <id> (--prompt <text> | --prompt-file <file>) [--model <id>] [--resume] [--machine <id>] [--json]
```

`--model` switches the session's model with this message (`default` = machine
default); without it the session keeps its current model.

Pushes one user message into a session that is already running. A session
spawned by **this machine's** daemon (key in `~/.happy/sessions.json`) is sent
to directly; any other session of the account is sent through the daemon of
the machine that spawned it (B-506, see `sessions` above — that machine must
be online and on CLI ≥ 0.2.157; `--machine <id>` names it, `--resume` then
resumes on **that** machine; `--json` adds `machine: { id, host }`).
The POST itself rides the server REST outbox, but the server stores a
message for **any** session — archived or dead included — so a 2xx never
meant a wrapper would read it (B-501). `send` therefore classifies the
session first, from the local daemon's `/list` and `GET /v1/sessions/:id`:

| `status` | meaning | `send` does |
| --- | --- | --- |
| `live` | a wrapper is attached: tracked by this daemon, or server `active` with `activeAt` within 15 min (another machine) | send, then re-check |
| `archived` | `archivedAt` set (Ctrl-C, `sessions archive`, web archive) | refuse (exit 3) unless `--resume` |
| `offline` | not archived, no live wrapper (exited, or presence timed out after 10 min) | refuse (exit 3) unless `--resume` |
| `not_found` | server 404 — not on this account | refuse (exit 3); cannot be resumed |

`--resume` brings an archived / offline session back on **this machine** the
same way the web's Restore does: unarchive (archived only) → daemon
`/resume-session` (the local twin of the `resume-happy-session` RPC; `resume-precheck:*`
reasons are passed through) → wait up to 30 s until it is live → send. If the
daemon refuses, an unarchived session is re-archived again; a merely offline
one is left alone. A daemon older than this route answers "daemon too old to
resume sessions" — upgrade `very-happy-cli` and `very-happy daemon start`.

After a successful POST the state is re-checked; a wrapper that vanished in
between is reported as not delivered with `stored: true` (the message sits on
the server, unread). The same logic backs the assistant's `session_send`
(`resume: true` there).

`--json` on stdout:

```json
{"sessionId":"…","url":"…","delivered":true,"status":"live","resumed":false}
{"sessionId":"…","url":"…","delivered":false,"status":"archived","resumed":false,"stored":false,"error":"Session … is archived — …"}
{"sessionId":"…","url":"…","delivered":false,"status":"archived","resumed":false,"stored":false,"error":"…","resume":{"ok":false,"error":"resume-precheck:cwd-missing: …"}}
{"sessionId":"…","url":"…","delivered":false,"status":"offline","resumed":false,"stored":true,"error":"Session … went offline while sending: …"}
```

Exit codes: `0` delivered to a live wrapper, `1` bad args / unknown session
(no machine of the account holds it, or its machine is offline / too old) /
transport failure, `3` session not live (archived, offline, not found) or
resume failed — nothing was delivered.

## Inbound: Web Assistant / meta-agent

The Web Assistant is the built-in path for asking one Claude coordinator to
inspect and dispatch other Very Happy sessions. It is separate from an external
IM adapter and currently spawns **Claude sessions on one selected machine**.

1. Connect a machine whose daemon can start Claude structured sessions.
2. Open **Settings → Voice & Assistant** and select the Assistant machine.
3. Review **Skip permission approvals**. It is convenient for dispatch, but it
   grants the coordinator a high-privilege machine-control surface.
4. Open **Assistant** (or `/assistant`) and ask with an absolute workspace path,
   for example: `在 /srv/project 派一个会话修复登录测试，然后汇报结果。`

The assistant uses `session_spawn` to return a new session immediately; it does
not wait for that worker to finish. Use `sessions_list`, `session_read`, and
`session_send` to follow up (`session_send` refuses an archived / offline
session unless `resume: true`, same rules as `very-happy send` above). `~` may be expanded, but explicit absolute paths
are the least ambiguous. Automatic cross-machine or cross-provider routing is
not shipped today.

### `very-happy mcp` — clipboard tool for a plain `claude`

Remote SDK sessions get the happy MCP server injected automatically, but a
plain `claude` loads only the OS user's normal MCP config. Register once for
that OS user:

```bash
claude mcp add --scope user very-happy-clipboard -- very-happy mcp
```

Because this uses `--scope user`, it gives every Claude session for that OS user
a `copy_to_clipboard` tool; it is not bound to a Very Happy terminal. Text is
forwarded to the local daemon over its 127.0.0.1 control server
(`POST /clipboard`), relayed
over the authenticated machine socket, and fanned out to the clipboard of
every web client the user has open. Payloads over 256KB are truncated.

### Legacy assistant variants and managed pi

The new-session dialog no longer offers **Meta agent**. Ordinary managed
Claude, Codex, and pi sessions use official `team_*` tools for team work;
see [Agent Teams](agent-teams.md). The `/assistant` voice interface and
existing `variant: assistant` sessions remain compatible. The variant is not
a team identity and does not import historical work into Teams.

Legacy `HAPPY_SESSION_VARIANT=assistant` subprocesses may still expose the
older `sessions_*` tools. Those tools operate on local sessions and lack the
Teams task/attempt/acceptance model. Keep them for existing voice/history
compatibility, not as the recommended way to start a new coordinator.

Managed pi receives the official bridge and permission gate from the CLI
through `HAPPY_MCP_URL`; a private supervisor wrapper or `.mcp.json` is not
required for Teams. Use `very-happy pi` for this path. Installing the shared
skill does not attach a bare pi process or provide its background inbox.

A plain Web-terminal MCP registration remains a separate clipboard/title/preview
handoff. `VH_TERMINAL_ID` identifies that terminal; when both it and
`HAPPY_MCP_URL` exist, the managed session endpoint takes precedence to avoid
duplicate title tools. `very-happy mcp` discovers the daemon using
`HAPPY_HOME_DIR`; use the correct isolated home when testing a dev daemon.

---

## Built-in My todos: official agent skill

In **Todos → My todos**, choose **Let AI use my todos** to copy the complete
[official skill](../packages/happy-web-v2/public/skills/very-happy-todos/SKILL.md)
and the current server address. Paste it into your coding agent. Clipboard failure
shows selectable instructions. The copied content contains no login credentials.
The public document is served at `/skills/very-happy-todos/SKILL.md`.

Use a CLI with `very-happy todo --help` support. `very-happy todo skill` prints the
same instructions without requiring authentication. The agent verifies the existing
CLI login and expected server, then reads `todo list`; setup never writes test tasks.
Existing external providers remain separate.

Commands: `todo list`, `todo get ID`, `todo add --id UUID --title TEXT [--note TEXT]`,
`todo edit ID --version N [--title TEXT] [--note TEXT]`, and
`todo complete|reopen|delete ID --version N`. Use `--title=VALUE` / `--note=VALUE`
for text beginning with `--`. Successful data commands output `{serverUrl, result}`;
list results include `records`, `truncated`, and `invalidCount`. Mutations require
the version returned by a read. Retry uncertain creation with the same UUID and
content; reconcile other uncertain writes by reading, never by blind overwrite.
Deleted IDs cannot be reused. CLI and Web share the same account KV schema and CAS.

Managed Claude, new Codex threads, and pi/ACP sessions receive a short discovery
hint. Resumed existing Codex threads do not receive a new first-turn hint; run
`very-happy todo skill` explicitly there. Host skill directories are not modified.
Scoped Teams sessions cannot use account-wide Todo commands. Task text is data,
not authorization to execute its contents or complete tasks automatically.

For maintainers, edit `packages/happy-wire/src/builtinTodoSkill.ts` as the text
source; Web clipboard and CLI output import it. Update the public Markdown copy
together and run `pnpm -C packages/happy-wire exec vitest run src/builtinTodoSkill.test.ts`
to verify exact equality. Compare installed `todo skill` output while allowing
only its extra printing newline, not arbitrary whitespace normalization.

Verify three separate paths: the deployed Markdown body equals the source (an
HTTP 200 alone can be an SPA fallback); the page copies the complete instructions
and exposes manual copy on failure; the installed CLI reads the intended account
on the expected server. Do not infer that an installer makes a skill discoverable
in every runner: verify prompt injection at each runner's actual first/resume
boundary. Creation retry tests must cross client/process boundaries, since an
in-memory retry map alone cannot protect separate CLI invocations.

## Inbound: todo provider (external task lists in the web UI)

**No setup is required for Todos → My todos.** The built-in list belongs to your
account and syncs without an online machine. It supports editing, completion,
reopening, deletion and manual order. The following optional integration appears
under **Todos → External source**; it does not replace or import the built-in list.

For AI-assisted setup, give your agent the [provider skill](../packages/happy-web-v2/public/skills/very-happy-todo-provider/SKILL.md)
(published at `/skills/very-happy-todo-provider/SKILL.md`). Official OAuth connectors
are not included yet. External create/complete actions write to the selected
provider, and task execution by an agent does not automatically complete a Todo.


Happy can show an external todo system in its web **Todo panel** (`/todos`) and
let you tick items off and add new ones, without Happy knowing anything about
that system. You supply a command; Happy runs it on the machine its daemon
lives on and speaks a small text contract to it.

Nothing is stored on the Happy server: the panel reads through the machine at
view time and writes straight back out. There is no sync, no cache, and no
second copy of your tasks.

### Quick start: local file provider

There is **no bundled account connector** for Dida365/TickTick, Todoist or
Linear, and installing the CLI does not connect a task account. The repository
includes a local JSON-file reference provider; it is a demo task source, not
an integration with those services.

1. On the machine selected in the Todo panel, save
   [`todo-provider-jsonfile.mjs`](../packages/happy-cli/examples/todo-provider-jsonfile.mjs)
   to a permanent location (for example `/Users/you/tools/todo-provider-jsonfile.mjs`).
   Install Node.js if it is not already available. Run `command -v node` to get
   its absolute path; use that path so the daemon does not depend on your shell's PATH.
2. Run the example with a dedicated file. Replace the paths below with your
   own absolute paths. This creates only a demo task:

   ```sh
   /absolute/path/to/node /absolute/path/to/todo-provider-jsonfile.mjs --file /absolute/path/to/demo-todos.json create "Try Todo"
   /absolute/path/to/node /absolute/path/to/todo-provider-jsonfile.mjs --file /absolute/path/to/demo-todos.json list
   ```

3. **Merge** this property into the existing settings file; do not replace
   its other fields. Use `~/.happy/settings.json` for the default daemon, or
   `$HAPPY_HOME_DIR/settings.json` for a daemon started with an isolated home.

   ```json
   {
     "todoProvider": {
       "command": "/absolute/path/to/node",
       "args": ["/absolute/path/to/todo-provider-jsonfile.mjs", "--file", "/absolute/path/to/demo-todos.json"]
     }
   }
   ```

4. Return to Todo → External source, select the same machine, and choose **Retry** or **Refresh**.
   Settings are read for each request, so no daemon restart is needed. Confirm
   the demo task appears, create another task in the panel, and complete it.
   The next `list` command should reflect both changes.

To connect a real task system, supply an adapter implementing the contract
below and complete that system's authentication on the daemon machine. Test
all three operations with a disposable task before changing the provider
configuration. Keep credentials in the provider's local credential store or
environment, never in command arguments or provider stdout.

If setup fails, check that the selected machine is online, the absolute paths
exist for the daemon user, and `list` writes only the expected JSON to stdout
(send logs to stderr). An empty list means the provider returned no tasks;
“not configured” means this daemon's settings have no provider.

### Enabling it

Add a `todoProvider` block to that machine's local `~/.happy/settings.json`:

```jsonc
{
  "todoProvider": {
    "command": "/absolute/path/to/your-provider",  // required
    "args": ["--source", "work"],                  // optional, fixed prefix args
    "cwd": "/optional/working/dir",                // optional
    "timeoutMs": 20000                             // optional, default 20s
  }
}
```

> **Why this is machine-local and cannot be set from the web UI:** the command
> runs as arbitrary code on that machine. The daemon already exposes `bash`, so
> this is not new capability — but *who gets to choose the command* would be a
> new attack surface. Keeping it in the local settings file means a hijacked web
> session cannot turn it into remote code execution.

With no `todoProvider` configured the panel simply reports that the machine has
no provider; nothing is spawned.

### The contract

Happy invokes your command three ways. Arguments are passed as a real argv list
— **no shell is involved**, so quotes and semicolons in a task title are just
characters, never syntax.

```text
<command> [args...] list             # → JSON on stdout
<command> [args...] complete <id>    # → exit code is the result
<command> [args...] create <title>   # → exit code is the result
```

**Exit 0 means success.** On failure, exit non-zero and write something useful
to stderr: Happy shows that text to the user verbatim, so `permission denied for
project X` is far more helpful than a silent failure.

`list` must print JSON shaped like this:

```jsonc
{ "items": [
    { "id": "abc",          // REQUIRED — what `complete` will be called with
      "title": "Write the weekly report",  // REQUIRED
      "status": "open",     // optional: "open" | "done"  (default "open")
      "due": "2026-08-20",  // optional, shown as-is
      "priority": "high",   // optional: "none" | "low" | "medium" | "high"
      "group": "Work",      // optional, used to group rows
      "note": "…" }         // optional
] }
```

Only `id` and `title` are required. **Unknown fields are ignored**, so you can
return whatever else your system produces and add fields later without breaking
older Happy clients. Items missing `id` or `title` are dropped (the panel tells
the user how many); at most 500 items are shown.

The output of `complete` and `create` is **not parsed** — only the exit code is.
Different backends return wildly different bodies, and parsing them would weld
one backend's shape into Happy. After either call the panel re-runs `list`, so
what you see is always the external system's real state rather than an
optimistic guess.

### Reference implementation

`packages/happy-cli/examples/todo-provider-jsonfile.mjs` implements the whole
contract against a plain JSON file. It has no dependencies and talks to no
service, so you can point `todoProvider` at it to see the panel work end to end,
then copy its shape for your own system:

```sh
happy_dir=~/.happy
"$PWD/packages/happy-cli/examples/todo-provider-jsonfile.mjs" \
  --file "$happy_dir/todos.example.json" create "Try the todo panel"
"$PWD/packages/happy-cli/examples/todo-provider-jsonfile.mjs" \
  --file "$happy_dir/todos.example.json" list
```

A real provider is usually a thin shim over an existing CLI or HTTP API — the
author's own is ~40 lines wrapping two personal task tools.

---

## Adapter example (IM bridge)

Pseudocode for a quote-reply IM adapter — a pattern that
implements:

```text
# One-time setup:
#   POST /v1/webhook  {url: "<gateway ingest URL that forwards to the group>",
#                      events: ["completed", "permission"]}
#   Server-side: set HAPPY_WEB_URL for clickable links (optional).

on im_message(msg):
    # Fail closed before treating chat text as remote-machine input.
    if not allowed_sender(msg.sender) or not allowed_chat(msg.chat):
        audit("rejected", msg)
        return
    if duplicate(msg.id) or rate_limited(msg.sender):
        return

    # 1) New task from chat: "[happy] fix the flaky test"
    if msg.text.startswith("[happy] "):
        prompt = msg.text.removeprefix("[happy] ")
        workdir = allowed_workdir(msg.chat)  # fixed map; never take a path from msg
        out = run(["very-happy", "spawn",
                   "--dir", workdir,
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

- Authenticate and authorize the sender **and** chat before parsing commands.
  The `session:` trailer is a routing key, not authentication. Use allowlists,
  deduplication, rate limits, and an audit log; reject by default when identity
  cannot be verified.
- Map chats to fixed, allowlisted workspace roots. Never accept an arbitrary
  working directory or command from the message. Keep normal agent permission
  prompts unless your threat model explicitly allows otherwise.
- Parse the `session:` trailer from the **quoted text**, not from stored
  state — it makes the adapter stateless and restart-safe.
- Use `--prompt-file` for long or multi-line replies to avoid shell-quoting
  issues.
- The adapter must run on the same machine as the daemon that spawned the
  sessions (that is where the session keys live).
- Run the adapter with the least-privileged OS user that can reach those
  workspaces. Never expose the daemon's loopback control server to a network.
- Webhook delivery is best-effort; treat notifications as hints, not a queue.


## Automations: scheduled and triggered runs (feature gated)

User guide (web, CLI, MCP, triggers, the board's decision band): [automations.md](automations.md).

Account-level automations (B-496, [spec](../specs/2026-09-automations.md)): a
trigger — cron with time zone, fixed interval, one time, or manual only — and an
action on one machine: spawn a session (optionally *sticky*: repeated events with
the same rendered key continue one conversation), send into a fixed session, or
run a script (argv, no shell). Every execution is an `AutomationRun` with a
status, session link, summary and attention flag. The server must enable
`VH_AUTOMATIONS_ENABLED=true` (server-wide; no per-account allowlist since
B-502). Each account holds at most `MAX_AUTOMATIONS_PER_ACCOUNT` automations
(default 100, active + paused): a create beyond that answers 429
`{ error: 'automation_count_quota_exceeded', limit, count }`, which the CLI and
Web explain in one line. A daemon talking to an old or gated server logs one
debug line per ten minutes and does nothing else, and the CLI says so in one line.

```bash
very-happy auto create --name daily-tanka --cron '0 9 * * 1-5' --tz Asia/Singapore \
  --spawn-dir ~/work/ops --prompt-file prompts/tanka.md          # spawn claude, web-launcher defaults
very-happy auto create --name on-mention --manual \
  --spawn-dir ~/work/ops --prompt 'Reply to: {{payload.text}}' --agent codex \
  --sticky-key '{{payload.conversationId}}'                      # same conversation → same session
very-happy auto create --name backup --every 6h --script -- /usr/bin/env bash -lc 'restic backup ~/notes'
very-happy auto fire on-mention --payload-json '{"conversationId":"c9","text":"hi"}' --dedupe-key msg-123 --wait
very-happy auto runs --attention; very-happy auto ack <runId>
very-happy auto report --status done --summary 'synced 12 items'   # inside a run's session: --run defaults to $VH_AUTOMATION_RUN_ID
```

Fire is the only event entry point (no inbound webhook): an IM bot, watcher or
systemd unit shells out to `very-happy auto fire <name>` with a payload; the same
`--dedupe-key` within 24h returns the original run. Prompts, argv and sticky keys
take `{{payload}}`, `{{payload.a.b}}` (JSON payload), `{{run.id}}`,
`{{automation.name}}` and `{{now}}`. Spawned sessions carry the `#automation`
tag and `VH_AUTOMATION_RUN_ID` / `VH_AUTOMATION_NAME` in their environment;
scripts also get `VH_AUTOMATION_PAYLOAD`. A run finishes when the agent calls
`automation_report` (exact; in a continued sticky session pass the runId from
the latest prompt header — `VH_AUTOMATION_RUN_ID` is the run that started the
session), or — without one — when the wrapper's turn ends (B-466 heartbeat) and
the daemon confirms it on the session log anchored on that run's own prompt,
taking the last assistant text (4KB) as the summary. Scripts finish on exit (tail 4KB of output;
timeout SIGTERM → SIGKILL). The daemon keeps `~/.happy/automation-receipts.json`
so a run id is never spawned twice across restarts; an unknown launch outcome is
reported `failed` with attention instead of retried. Exit codes of `fire --wait`:
`0` done, `2` wait timed out, `3` failed / expired / cancelled / skipped.

`very-happy auto skill` prints the official skill; `very-happy teams install
--host … --apply` materializes it next to the Teams skill at
`~/.local/share/very-happy/skills/very-happy-automations/SKILL.md` (`very-happy
auto install` does only this one), with the same ownership checks.

## Agent Teams (local development; feature gated)

Teams use the same `team_*` tools in managed Claude HTTP MCP, Codex stdio MCP,
and the official pi runtime bridge. No assistant session variant is required.
The server must enable `VH_AGENT_TEAMS_ENABLED=true` (server-wide; no
per-account allowlist since B-502). A new daemon advertises `teamsVersion:1`; the Web
Teams page disables dispatch when that capability or a live machine is absent.

`very-happy teams install --host claude|codex|pi` previews the official skill at
`~/.local/share/very-happy/skills/very-happy-teams/SKILL.md`; add `--apply` to
materialize it there. All hosts use this same Very Happy-owned copy. The installer
never writes host discovery directories (`.claude/skills`, `.agents/skills`, or
`.pi/agent/skills`), which may point to shared repositories. It rejects symlinks
in the destination ancestry. Ask the managed agent to read the returned absolute
path; installation does not imply host auto-discovery. `uninstall` uses the same ownership
check and preserves user edits. A standalone terminal still needs a managed
Very Happy session identity; skill installation is not a transport or auth grant.

The server owns tasks, attempts, credentials and persistent operations. The
daemon starts isolated worktrees and delivers messages through existing session
queues. Acceptance is separate from process activity and resource cleanup.
Unknown launch outcomes require verification, not blind retry. See the
[Teams contract](../specs/2026-09-agent-teams.md) for scope, limits, rollback and
legacy ledger migration preview. This feature has not been deployed by the
implementation task.


### Native Pi terminal tools

Install the native Pi extension once, then launch Pi directly in a Very Happy
tmux terminal:

```sh
very-happy install-pi-tools
pi
# Existing Pi in that terminal can use /reload; normal Pi arguments still work:
pi --continue
# Remove only the installed Very Happy extension:
very-happy install-pi-tools --remove
```

Installation adds `~/.pi/agent/extensions/very-happy-terminal-tools.js` (or under
`$PI_CODING_AGENT_DIR/extensions`); it preserves Pi settings and other extensions,
and refuses to overwrite an edited loader. The loader points to the installed
CLI, so rerun installation if you move the CLI installation. For explicit loading,
use `pi -e ~/.pi/agent/extensions/very-happy-terminal-tools.js` after installation.

The extension also names the terminal tab (B-500). Claude Code writes its task
summary to the terminal title itself; pi only writes `π - <dir>` until the pi
session has a name, and never names one. So on the first prompt of an unnamed
pi session the extension asks its bridge (`very-happy mcp --terminal-tools`,
a custom JSON-RPC method, not a tool the model sees) for a title — the same
`claude -p --model haiku` one-shot that titles managed sessions — and sets it
as the pi session name (`/name`). Pi rewrites its title as `π - <name> - <dir>`
and the daemon follows the name into the tab title. A tab renamed in the
sidebar, a session named with `/name`, or a title set through `change_title`
is never overwritten. The one-shot runs with `HAPPY_MANAGED=1`, so the
terminal-mirror hook ignores it. `very-happy pi --terminal` behaves the same.
For temporary loading without installation, `very-happy pi --terminal [pi args]`
is also available.

The extension provides `change_title`, `copy_to_clipboard`, and `open_preview`
only when the process has a valid `VH_TERMINAL_ID`. New Very Happy tmux terminals
provide this context; an existing external tmux pane may need a new Very Happy
terminal. It starts its CLI bridge on Pi session start and closes it on shutdown
or `/reload`, without adding a native permission gate. `change_title` changes the
Very Happy terminal name; `open_preview` accepts absolute, `~/…`, or cwd-relative
paths and uses the existing file viewer and path checks. The machine must run the
matching CLI/daemon. `very-happy pi` still starts a managed ACP conversation;
managed `HAPPY_MCP_URL` and the temporary launcher's `HAPPY_TERMINAL_MCP_URL` take
priority, so the auto-discovered extension does not register duplicate tools.

**Copy and preview history** appears inside conversations and terminal sessions.
Records are isolated by session or machine plus terminal ID and saved in account
KV, so a browser need not be open when a call arrives. Viewing history does not
automatically copy or open anything. Click **Copy again** or **Open preview**.
Each scope retains up to 50 recent calls within a 240 KiB storage budget; repeated
calls remain separate. Clipboard history retains up to 32 KiB per text (less for
JSON-escaped content), explicitly marked when truncated. Live clipboard delivery
still accepts up to 256 KiB. Saving history is best effort under server storage
failures or overload, and a record confirms only receipt of a valid push, not
that a device copied it or a person viewed it. Preview reopening requires the
source machine and file to remain available. Older chat transcripts can supply
previous clipboard calls and preview paths; old terminal calls lacking a terminal
ID cannot be reconstructed. The separate device-local clipboard panel is unchanged.
