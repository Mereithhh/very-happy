# Automations

Automations let an agent start on a schedule or on an event, on one computer
you choose, and report back so you only look at what needs a decision. One
automation is **one trigger + one action + one machine**; every execution is a
**run** with a status, a session link, a summary and an attention flag.

The feature is gated per server (`VH_AUTOMATIONS_ENABLED=true`); once on, every
account can use it, and each account holds at most `MAX_AUTOMATIONS_PER_ACCOUNT`
automations (default 100, active and paused together — a create beyond that is
refused with `automation_count_quota_exceeded`). When it is off, the sidebar entry stays hidden,
`very-happy auto` prints a one-line hint, and ordinary chats, terminals and
teams keep working. The wire/REST contract lives in
[channels.md](channels.md#automations-scheduled-and-triggered-runs-feature-gated);
the design in [`specs/2026-09-automations.md`](../specs/2026-09-automations.md).

## Prerequisites

- An account on a server with the gate on, and at least one connected
  computer running a daemon that understands automations (CLI ≥ 0.2.152).
- The agent you want to spawn (Claude Code, Codex, pi, Gemini or OpenClaw)
  installed on that computer. Scripts need nothing beyond the command itself.
- The executing computer online. While it is offline, runs queue and are
  flagged after ten minutes; they execute when it comes back.

## Create one in the app

Open **Automations** in the sidebar (below **Teams**) and choose **New
automation**.

1. **Basics** — a name (`[a-z0-9][a-z0-9-_.]{0,63}`; this is what you fire by),
   the machine (online state is shown), an optional description.
2. **Trigger** — one of:
   - **Schedule (cron)**: five fields plus an IANA time zone (`0 9 * * 1-5`,
     `Asia/Singapore`). The field previews its wording as you type; shapes the
     preview cannot state honestly are shown as the raw expression.
   - **Every interval**: `15m`, `1h30m`, `1d` (minimum one minute).
   - **Once**: a date and time in your browser's zone.
   - **Trigger only**: no schedule — an event fires it (see below).
3. **Action** — one of:
   - **Spawn a session**: agent, directory on the machine, optional model and
     permission mode, optional git worktree, optional **sticky key** template,
     optional **project**, and the prompt. With a project, every session the
     automation starts joins it before its first message in quiet mode: it gets
     the project instructions but is not prompted to message other sessions or
     write project notes (see [Projects](projects.md)). The project is set in the
     app (or through `projectId` on the REST API); `very-happy auto create` and the
     `automation_*` tools do not take it yet.
   - **Send to a session**: an existing session id on that machine and the
     prompt.
   - **Run a script**: the command as argv (shell-style quoting, no expansion),
     optional working directory.
4. **Precheck (optional)** — a cheap check the machine runs before the action
   (see [Precheck](#precheck-only-run-when-there-is-something-to-do)).
5. **Limits** — what to do when the previous run is still going (skip this run
   or queue it) and the maximum runtime (default 6h, scripts 30m).

The list groups automations into **Scheduled** and **Triggers**, and shows the
trigger in words, the machine, the next run and the last result. Each row can
**Run now**, **Pause / Resume**, **Edit** and **Delete**. Run now queues a run
without a payload and works on paused automations too.

Prompts, argv and sticky keys accept templates: `{{payload}}`,
`{{payload.field}}` (when the payload is JSON), `{{run.id}}`,
`{{automation.name}}` and `{{now}}`.

## Create one from a terminal or a session

The same automations are managed from the CLI on any connected computer:

```bash
very-happy auto create --name daily-inventory --cron '0 9 * * 1-5' --tz Asia/Singapore \
  --spawn-dir ~/work --prompt-file prompts/inventory.md
very-happy auto create --name backup --every 6h --script -- /usr/bin/env bash -lc 'restic backup ~/notes'
very-happy auto create --name on-mention --manual --spawn-dir ~/work/ops \
  --prompt 'Reply to: {{payload.text}}' --sticky-key 'conv-{{payload.conversationId}}'
very-happy auto list; very-happy auto show daily-inventory
very-happy auto pause daily-inventory; very-happy auto resume daily-inventory
very-happy auto runs --attention; very-happy auto ack <runId>
```

Managed Claude, Codex and pi sessions carry the `automation_*` MCP tools
(`automation_list`, `automation_get`, `automation_create`, `automation_update`,
`automation_pause`, `automation_resume`, `automation_delete`, `automation_run`,
`automation_fire`, `automation_runs`, `automation_report`, `automation_ack`)
with the account's permissions, so you can ask a session to set one up. An agent
started from a plain terminal can read the official skill:

```bash
very-happy auto skill                       # print the skill
very-happy teams install --host claude --apply   # installs the Teams and Automations skills together
```

## Precheck: only run when there is something to do

A schedule that spawns an agent every five minutes burns quota even when there
is nothing new. Give the automation a **precheck**: a command the executing
machine runs first. Exit code `0` runs the action; any other exit records the
run as **skipped** and nothing is spawned or sent.

```bash
# only start a session when the inbox file is non-empty; pass the check's output to the agent
very-happy auto create --name inbox-triage --every 5m --spawn-dir ~/work/ops \
  --prompt 'Triage the new messages below.' \
  --precheck-shell 'test -s ~/inbox/new.json && jq -r ".[].subject" ~/inbox/new.json' --precheck-output
very-happy auto edit inbox-triage --precheck-timeout 2m     # adjust the existing check
very-happy auto edit inbox-triage --no-precheck             # remove it
```

- **Command** — either one shell line (`--precheck-shell`, run by the
  machine's shell) or an argv (`--precheck-argv '["./has-new","--since","5m"]'`,
  no shell). A shell line is not template-rendered — read the payload from
  `$VH_AUTOMATION_PAYLOAD`; argv accepts the same templates as scripts.
- **Directory** — `--precheck-cwd`; by default the spawn directory or the
  script's working directory, otherwise the home directory.
- **Timeout** — `--precheck-timeout` (default 60s, at most 10m). On timeout the
  whole process group is killed.
- **Output** — the last 4,000 characters are kept. With `--precheck-output`
  ("Append the check's output to the prompt" in the app) its stdout is added to
  the end of the spawn/send prompt under `[precheck output]`; a script action
  always gets it as `$VH_AUTOMATION_PRECHECK_OUTPUT`.
- **Skips** — a non-zero exit is skipped quietly (`precheck: nothing to do`).
  A timeout or a check that cannot start is skipped **and** shown in *Needs my
  decision*. Consecutive scheduled skips for the same reason fold into one row
  marked **×N** in the run history (fired and manual runs always keep their own
  row, so every event's payload stays traceable) (a run in between, or a different reason, starts a
  new count), so the history and the decision list do not fill up; a repeated
  reason asks for your decision only once.
- **Older CLIs** — a machine whose very-happy CLI predates prechecks never runs
  the action of an automation that has one: those runs are skipped as *CLI too
  old for the precheck* and flagged once. Upgrade the CLI on that machine.
- In the app the check lives in its own **Precheck (optional)** section of the
  form; MCP tools take `precheck: { shell | command, cwd?, timeoutMs?,
  includeOutput? }` on `automation_create` / `automation_update` (`null`
  removes it).
- A one-time (`--at`) automation created with a precheck in the past will not
  fire: it is created paused and resumed after the server confirms the check
  was stored, and resuming never replays a past time.

## Triggers: fire an automation from an event

A **trigger only** automation has no schedule. Anything that can run a command
on a connected computer fires it — an IM bot, a file watcher, a systemd unit,
another agent. `fire` is the only event entry point; there is no inbound
webhook. The automation's detail page shows these commands ready to copy.

```bash
very-happy auto fire on-mention                                        # no payload
very-happy auto fire on-mention --payload-json '{"conversationId":"c9","text":"hi"}' \
  --dedupe-key msg-123 --wait                                          # JSON payload, idempotent, wait for the run
```

- The payload reaches the prompt as `{{payload}}` / `{{payload.field}}`;
  scripts get it as `VH_AUTOMATION_PAYLOAD`.
- The same `--dedupe-key` within 24 hours returns the original run.
- With a **sticky key** (for example `conv-{{payload.conversationId}}`), events
  whose rendered key matches continue the same conversation instead of
  spawning a new session; a dead session is replaced automatically.
- `--wait` exits `0` done, `2` timed out, `3` failed / expired / cancelled /
  skipped. Inside a managed session use the `automation_fire` tool.
- A paused automation refuses `fire`; **Run now** / `very-happy auto run`
  still works as an explicit choice.

## Needs my decision

The top of the **task board** (`/board`) lists runs that need you, most urgent
first: an agent waiting for input, a failed or expired run, a run nobody picked
up because the machine is offline. Each row starts with a round check —
tap it to acknowledge — and can open the session, run the automation again, or
cancel a run that is still open; the header offers **Acknowledge all**. The band
renders nothing when nothing needs you; the sidebar's Automations entry carries the count (on a short window or the phone it sits under **More features ▾** / **More ▾**, which shows the total).

A flagged run is tied to the sessions it is about: its own session plus the
ones a JSON payload names (`sessions[].id`, `sessions[]`, `sessionId`,
`sessionIds[]`). Those sessions show a strip under the chat header (automation,
reason, **Acknowledge**) and a marker on their sidebar row. The flag also clears
itself — the run records who or what did (`ackedBy`):

- `owner-replied` — you sent a message in a linked session (web, app, or
  `very-happy send`; messages an automation, Teams or a peer session sent do
  not count);
- `run-done` — the run later reported `done` without asking for attention;
- `session-archived` — you archived a linked session;
- `owner` — you acknowledged it by hand (`very-happy auto ack <runId>` or
  `auto ack --all [--name <automation>]`).

How a run ends:

- The agent reports it — `automation_report` from inside the session or
  `very-happy auto report --status done|failed --summary …` (inside a run's
  session `--run` defaults to `$VH_AUTOMATION_RUN_ID`; in a continued sticky
  session pass the run id from the latest prompt header).
- Without a report, the session's turn ends and the daemon confirms it on the
  session log; the last assistant text (4 KB) becomes the summary.
- Scripts end on exit: `0` is done, anything else is failed, with the output
  tail as the summary. Timeouts get SIGTERM, then SIGKILL.
- A precheck that does not pass ends the run as **skipped** before the action
  starts; the check's output tail is the summary.
- Runs whose daemon stops reporting, or that exceed the maximum runtime, are
  marked **expired** and flagged. A daemon restart before the outcome is known
  reports **failed** with attention instead of retrying.

The automation page shows each automation's last result and next run; the
detail page keeps the recent run timeline with source (schedule / fire /
manual), duration, summary or error, and session links.

## Validation boundary

- Each automation runs on exactly the machine it names. There is no automatic
  cross-machine routing; change the machine in the editor if you move it.
- Creation from the web, the CLI and MCP share the same account permission —
  no narrower permission model exists for automations.
- A run marked done means the agent's turn ended or the agent reported; it is
  not proof that the work is correct. Review summaries and sessions.
- The web view polls while open (list 15s, detail 10s, board 20s, sidebar
  60s); it is not a realtime feed.
