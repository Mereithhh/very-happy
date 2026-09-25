/** Official shared skill for B-496 Automations. Identical bytes for every host installation. */
export const AUTOMATION_SKILL = `---
name: very-happy-automations
description: Create and operate Very Happy automations — cron / interval / one-shot / manual triggers that spawn an agent session, continue a sticky session, or run a script on a chosen machine, with tracked runs. Use when asked to schedule recurring work, react to external events with an agent session, or inspect why an automated run failed.
---

# Very Happy Automations

An automation is account-level: a trigger (cron with time zone, fixed interval, one time, or manual only), an action (spawn a session, continue a sticky session, send into a fixed session, or run a script), and one machine that executes it. Every execution is a run with a status (queued → claimed → running → done | failed | skipped | expired | cancelled), an optional session link, a summary and an attention flag.

## Surfaces

- Managed sessions (Claude, Codex, pi): the \`automation_*\` MCP tools — \`automation_list\`, \`automation_get\`, \`automation_create\`, \`automation_update\`, \`automation_pause\`, \`automation_resume\`, \`automation_delete\`, \`automation_run\`, \`automation_fire\`, \`automation_runs\`, \`automation_report\`, \`automation_ack\`.
- Terminal: \`very-happy auto --help\` (same operations; \`--json\` for scripts). Fire from any local process with \`very-happy auto fire <name> [--payload-json …] [--dedupe-key …] [--wait]\`.
- The machine defaults to the one you are running on. If the tools answer that automations are not enabled, the server gate is off; do not work around it.

## Creating one

Pick the trigger, then the action. \`spawn\` takes an agent (claude / codex / pi / gemini / openclaw), an absolute directory and a prompt; defaults match the web launcher (yolo for claude / codex / pi). \`script\` takes an argv array (no shell): quote nothing, pass arguments as separate items. Prompts and argv may use \`{{payload}}\`, \`{{payload.field.path}}\` (JSON payload), \`{{run.id}}\`, \`{{automation.name}}\` and \`{{now}}\`.

Use \`sticky: { key }\` on a spawn action when repeated events about the same subject should continue one conversation: the key is a template (for example \`{{payload.conversationId}}\`). A run whose rendered key matches a live session sends the prompt into that session; otherwise it spawns a new one and remembers it. A dead or archived session is replaced on the next run.

\`concurrency: skip\` (default) records a run as skipped while the previous one is still running; \`queue\` waits. \`maxRuntimeMs\` bounds a run (default 6h; scripts 30m).

## Event triggers

There is no inbound webhook. A private adapter (an IM bot, a watcher, a systemd unit) calls \`very-happy auto fire <name>\` with a payload and a dedupe key; the same key within 24h returns the original run instead of starting another. Prefer \`manual\` triggers for automations that only ever fire this way.

## Finishing a run

When you are the session an automation started (\`VH_AUTOMATION_RUN_ID\` is set) or continued, finish by calling \`automation_report\` with \`status: done\` and a short summary, or \`status: failed\` with the error. Without an explicit report the daemon marks the run done when your turn ends and uses your last message as the summary — explicit reports are exact, so prefer them for long or multi-turn work. Set \`needsAttention\` with a reason when a human must look (blocked, ambiguous input, partial result).

## Operating

Inspect \`automation_runs\` (or \`very-happy auto runs --attention\`) before changing anything. Runs stuck in queued mean the machine's daemon is offline; expired means the lease or the runtime bound lapsed. Acknowledge attention with \`automation_ack\` after handling it. Updates need the current \`version\` from \`automation_get\`; read again on a conflict. Do not create automations that spawn other automations, and never put credentials into prompts, payloads or script arguments — scripts inherit the daemon's environment.
`;
