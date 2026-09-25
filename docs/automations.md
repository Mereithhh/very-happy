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
     and the prompt.
   - **Send to a session**: an existing session id on that machine and the
     prompt.
   - **Run a script**: the command as argv (shell-style quoting, no expansion),
     optional working directory.
4. **Limits** — what to do when the previous run is still going (skip this run
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
up because the machine is offline. Each row can open the session, acknowledge
the run, run the automation again, or cancel a run that is still open. The band
renders nothing when nothing needs you; the sidebar entry carries the count.

How a run ends:

- The agent reports it — `automation_report` from inside the session or
  `very-happy auto report --status done|failed --summary …` (inside a run's
  session `--run` defaults to `$VH_AUTOMATION_RUN_ID`; in a continued sticky
  session pass the run id from the latest prompt header).
- Without a report, the session's turn ends and the daemon confirms it on the
  session log; the last assistant text (4 KB) becomes the summary.
- Scripts end on exit: `0` is done, anything else is failed, with the output
  tail as the summary. Timeouts get SIGTERM, then SIGKILL.
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
