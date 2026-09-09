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

## MCP capability matrix

MCP is a handoff surface into the Web workspace, not a claim that every runner
has the same tool set:

| Runtime path | Tool surface |
|---|---|
| Base managed Claude session | `change_title`, `copy_to_clipboard`, `open_preview`, `report_progress` |
| Managed Codex / Gemini / ACP bridge | `change_title`, `copy_to_clipboard`, `open_preview` |
| Voice Assistant / legacy assistant variant additions (Claude, in-process) | `sessions_list`, `session_read`, `session_send`, `session_spawn`, `session_kill`, `session_archive`, `terminals_list`, `terminal_read`, `terminal_send`, `memory_update`, `journal_append` |
| User-scoped `very-happy mcp` (plain `claude`, pi, …) | `copy_to_clipboard` only |
| User-scoped `very-happy mcp` **inside a vh web terminal** (`VH_TERMINAL_ID` set by the daemon's tmux terminal) | + `change_title` (titles that terminal via the daemon's `/terminal-title`) |
| User-scoped `very-happy mcp` **inside a meta-agent session of a non-Claude runner** (`HAPPY_SESSION_VARIANT=assistant`, legacy compatibility only) | `copy_to_clipboard` + `sessions_list`, `session_read`, `session_send`, `session_spawn`, `session_kill`, `session_archive` |

The first two paths are injected by their managed runners. The assistant-only
additions can read and mutate sessions, terminals, memory, and journals; treat
that variant and its prompt/tool permissions as a high-privilege machine
control surface. The standalone `very-happy mcp` command is narrower: outside a
meta-agent session it is clipboard-only, and even inside one it never exposes
terminal, memory, journal, provider routing, preview, title, or progress
tools. It also stays clipboard-only under a happy-managed Claude
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
  [--env KEY=VALUE]... [--json]
```

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
  `bypassPermissions`. **Omitting it means `default`**, and a `default` session
  stops at the first tool that is not already allowed, waiting for a human to
  approve in the Web UI. For an unattended dispatcher that is a hang, not a
  prompt: pass `bypassPermissions`, or watch for the `permission` webhook /
  poll `sessions list --all` and answer with `sessions approve` / `deny`.
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
- `--env KEY=VALUE` — extra environment for the session process; repeatable.
  A `${VAR}` reference is expanded against the daemon's own environment, and an
  unresolved reference fails the spawn rather than starting a session with a
  literal `${VAR}` in its environment. Useful because a spawned session inherits
  the **daemon's** environment, not the dispatcher's.
- `--json` — machine-readable output: `{"sessionId": "...", "url": "..."}`,
  plus `"spawnedBy"`, `"permissionMode"` and `"agent"` when those flags were
  given. Without it, a human-readable line with a clickable session URL is
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
very-happy sessions list [--all [--include-archived]] [--tag <name>] [--limit <n>] [--json]
very-happy sessions read <id> [--limit <n>] [--json]
very-happy sessions stop <id> [--json]
very-happy sessions archive <id> [--json]
very-happy sessions approve <id> <requestId> [--for-session] [--json]
very-happy sessions deny <id> <requestId> [--reason <text>] [--json]
```

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

Scope is **this machine**: `list`/`stop` ask the local daemon, and `read`,
`approve` and `deny` need the session key from `~/.happy/sessions.json`, which
exists only for sessions this machine's daemon spawned and is pruned after 14
days. A session belonging to another machine cannot be read, stopped or
answered from here — that is a scope limit, not a permission error. `list
--all` (below) widens the *listing* to the account and says per row whether it
could be read.

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
`session_send` to follow up. `~` may be expanded, but explicit absolute paths
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

A plain Web-terminal MCP registration remains a separate clipboard/title
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


## Agent Teams (local development; feature gated)

Teams use the same `team_*` tools in managed Claude HTTP MCP, Codex stdio MCP,
and the official pi runtime bridge. No assistant session variant is required.
The server must enable `VH_AGENT_TEAMS_ENABLED=true`; optionally restrict it via
`VH_AGENT_TEAMS_ACCOUNT_IDS`. A new daemon advertises `teamsVersion:1`; the Web
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
