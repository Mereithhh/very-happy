/**
 * B-917: the `very-happy` skill — what Very Happy can do and how an agent
 * operates it. Progressive disclosure: the only always-on text is
 * VERY_HAPPY_DISCOVERY (./discovery.ts); `very-happy skill` prints SKILL_MD (the
 * capability map) and `very-happy skill <area>` one reference page.
 *
 * Single source: command syntax is not copied by hand where a help constant
 * exists — those pages embed the live help text. `content.test.ts` fails CI when
 * a top-level CLI command or an agent-facing MCP tool is missing from the skill,
 * when a page outgrows its budget, or when an example uses a flag its
 * command's help does not document. Product-generic content only (public repo).
 */
import { AUTO_HELP } from '@/commands/auto';
import { ISSUE_HELP } from '@/commands/issue';
import { TODO_HELP } from '@/commands/todo';
import { ACCOUNT_HELP } from '@/commands/account';
import { AGENT_HOME_HELP } from '@/commands/agentHome';

export const SKILL_NAME = 'very-happy';

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');
const block = (text: string) => '```text\n' + stripAnsi(text).trim() + '\n```';

export type SkillArea = { id: string; title: string; summary: string; body: () => string };

export const SKILL_AREAS: readonly SkillArea[] = [
    {
        id: 'sessions',
        title: 'Sessions',
        summary: 'start, message, read, stop, archive, fork or resume agent sessions; approve permission requests',
        body: () => `# Sessions

An agent session is a Claude / Codex / pi / Gemini / OpenClaw process run by a machine's daemon and mirrored to the Web.

## CLI
- \`very-happy spawn --dir <path> --prompt <text> [--agent claude|codex|pi] [--model <id>] [--permission-mode <m>] [--project <id>] [--json]\`: new session through this machine's daemon; \`--fork <sessionId>\` copies an existing one.
- \`very-happy send --session <id> --prompt <text> [--resume]\`: message an existing session; exit 3 when it is not live.
- \`very-happy sessions list [--all]\`, \`sessions read <id> [--answer] [--wait]\`, \`sessions stop|archive <id>\`.
- \`very-happy sessions approve|deny <id> <requestId>\`: answer a pending permission card (only sessions this machine's daemon spawned).
- \`very-happy sessions peers\` / \`sessions message <id> <text>\`: sessions working on the same repo and messaging them.
- \`very-happy resume <sessionId>\`: resume a previous session in this terminal.
- \`very-happy\` (Claude), \`very-happy codex\`, \`very-happy pi\`, \`very-happy gemini\`, \`very-happy acp\`, \`very-happy openclaw\`: start an interactive session in this terminal, mirrored to the Web.
- \`very-happy session provider …\`: per-session provider override (see \`very-happy session provider --help\`).

## MCP tools in managed sessions
- \`change_title\` names this session; \`report_progress\` updates the tracked task's board status; \`open_preview\` shows a file in the user's client; \`copy_to_clipboard\` hands text to the user's clipboard.
- \`session_peers\` / \`session_message\`: see and message sessions on the same work.
- \`request_human\`: block on a human decision when you cannot proceed.

Full flags: \`very-happy spawn --help\`, \`very-happy send --help\`, \`very-happy sessions --help\`.`,
    },
    {
        id: 'terminals',
        title: 'Terminals',
        summary: 'Web terminals on a machine, mirror hooks, clipboard / preview tools for hand-run agents',
        body: () => `# Terminals

The Web opens shell terminals on any online machine through its daemon (tmux-backed when available, so they survive daemon restarts). Creating, renaming and sharing terminals is done in the Web.

## CLI
- \`very-happy install-terminal-hooks [--remove]\`: optional Claude hooks that mirror a hand-run \`claude\` in a terminal as a read-only session.
- \`very-happy pi --terminal\`: native pi with title, clipboard and preview tools inside a Very Happy terminal; \`very-happy install-pi-tools [--remove]\` installs those tools for directly launched pi.
- \`very-happy mcp\`: stdio MCP server for a plain agent CLI (\`copy_to_clipboard\`; inside a Web terminal also \`open_preview\` and \`change_title\`). Register once: \`claude mcp add --scope user very-happy-clipboard -- very-happy mcp\`.

## MCP tools
- \`copy_to_clipboard\`, \`open_preview\`, \`change_title\` (titles the terminal tab when run inside one).
- Main agent only: \`terminals_list\`, \`terminal_read\`, \`terminal_send\`.`,
    },
    {
        id: 'projects',
        title: 'Projects',
        summary: 'shared instructions, decisions and log across sessions; project membership',
        body: () => `# Projects

A project groups sessions around one goal: instructions, decisions in effect, a log (decision / finding / handoff) and messages between member sessions. Its defaults (agent, model, permission mode, worktree) and instructions are edited in the Web.

## MCP tools in project sessions
- \`project_context\`: the project id, instructions, decisions, recent log, other sessions and unread messages (changes since your last read; \`full\` for everything).
- \`project_note\`: record a decision, finding or handoff others will need. Not progress.

## Putting work into a project from the CLI
- \`very-happy spawn … --project <id>\` (a session spawned from a project session joins it unless \`--no-project\`).
- \`very-happy auto create … --project current\` (or a project id): sessions an automation spawns join that project; \`auto edit <name> --no-project\` detaches.
- \`very-happy issue create … --project <id>\`, \`very-happy issue list --project <id>\`.

Project ids appear in \`project_context\` output and in the Web URL of the project. \`current\` resolves the project of the managed session running the command. The server checks the project belongs to the account.`,
    },
    {
        id: 'teams',
        title: 'Agent Teams',
        summary: 'a lead delegates tasks to member agents with tracked attempts, review and schedules',
        body: () => `# Agent Teams

Team sessions already receive the full team skill in their first prompt. Elsewhere:

- MCP tools (managed sessions): \`team_create\`, \`team_join\`, \`team_inspect\`, \`team_delegate\`, \`team_message\`, \`team_submit\`, \`team_accept\`, \`team_return\`, \`team_cancel\`, \`team_handoff\`, \`team_schedule_create\`, \`team_schedule_pause\`, \`team_schedule_resume\`, \`team_schedule_cancel\`.
- \`very-happy teams inspect\`, \`teams create|join\`, \`teams action\`, \`teams permissions\`, \`teams exit\`, \`teams doctor --host pi\`; \`very-happy teams install --host claude|codex|pi --apply\` materializes the team skill file.
- \`very-happy teams install --host claude --apply\` writes the official team skill to \`~/.local/share/very-happy/skills/very-happy-teams/SKILL.md\`; team sessions get it in their first prompt.

Restricted team workers keep to their assignment and worktree; never clear scope variables or borrow another credential.`,
    },
    {
        id: 'automations',
        title: 'Automations',
        summary: 'cron / interval / one-shot / manual triggers that spawn a session, continue a sticky session or run a script',
        body: () => `# Automations

Account-level jobs executed by one machine's daemon, with tracked runs. Full skill: \`very-happy auto skill\`. MCP tools in managed sessions: \`automation_list\`, \`automation_get\`, \`automation_create\`, \`automation_update\`, \`automation_pause\`, \`automation_resume\`, \`automation_delete\`, \`automation_run\`, \`automation_fire\`, \`automation_runs\`, \`automation_ack\`, \`automation_report\`. \`automation_create\` / \`automation_update\` take \`projectId\` (a project id or \`current\`, like \`--project\`; \`null\` on update detaches); an older server ignores it and the result carries \`notices\`.

## Recipes
- Every day at 09:00 in this project: \`very-happy auto create --name daily-review --cron '0 9 * * *' --tz <IANA zone> --spawn-dir <repo path> --prompt "<what to do>" --project current\`. Ask for (or read from the user's context) the time zone; do not assume UTC.
- Every 30 minutes, only when a check passes: add \`--every 30m --precheck-shell '<command>'\` instead of \`--cron\`.
- Continue the same session each time: add \`--sticky-key <template>\`.
- Try it now: \`very-happy auto run <name> --wait\`; inspect: \`very-happy auto runs --name <name>\`.
- Change later: \`very-happy auto edit <name> --cron '0 10 * * 1-5' --tz <zone>\`; \`auto pause|resume|rm <name>\`.

Confirm with the user before creating jobs that run unattended with broad permissions.

## Reference (\`very-happy auto --help\`)
${block(AUTO_HELP)}`,
    },
    {
        id: 'issues-todos',
        title: 'Issues and My todos',
        summary: 'account Issues (assign to an agent, comment) and the built-in My todos list',
        body: () => `# Issues and My todos

My todos are the user's personal list; Issues add assignees (an agent on a machine), status, comments and projects. On a server with Issues a todo is an issue without an assignee.

- **My todos: read the official skill first: \`very-happy todo skill\`.** Do not confuse account todos with your own execution plan.
- MCP tools in an issue's session: \`issue_get\`, \`issue_list\`, \`issue_update\`, \`issue_comment\`.
- Inside a session working on an issue, \`issue update\`/\`comment\` act as that agent: status only in_progress / in_review / blocked.

## \`very-happy issue --help\`
${block(ISSUE_HELP)}

## \`very-happy todo --help\`
${block(TODO_HELP)}`,
    },
    {
        id: 'accounts-models',
        title: 'Accounts and models',
        summary: 'sign-in, per-machine Claude / Codex accounts and API keys, default account, models, vendor keys',
        body: () => `# Accounts and models

- \`very-happy auth status\` shows which Very Happy account and server this machine uses; \`auth login\` / \`very-happy logout\` change it. Never switch servers or log out as a side effect; ask first.
- Claude / Codex accounts belong to one machine (tokens stay local): list, add, sign in, set the default, bind a session. Adding keys or signing in needs the user.
- \`very-happy connect codex|claude|gemini|status\`: store a vendor credential on the relay.
- \`very-happy agent-home\`: where Claude Code / Codex keep their conversations on this machine.
- Model per session: \`spawn --model\`, \`send --model\`, \`auto create --model\`. \`latest\` follows the newest model of the agent's tier. New-session defaults per agent are a Web setting.

## \`very-happy account --help\`
${block(ACCOUNT_HELP)}

## \`very-happy agent-home --help\`
${block(AGENT_HOME_HELP)}`,
    },
    {
        id: 'machines-daemon',
        title: 'Machines, daemon and sandbox',
        summary: 'the background daemon, diagnostics, self-hosted server, OS sandbox',
        body: () => `# Machines, daemon and sandbox

Each machine runs one daemon that spawns sessions and Web terminals and keeps them connected.

- \`very-happy daemon status|list\`: is it running, which sessions it holds. \`daemon start|stop\` affects every session on the machine; ask the user before stopping or restarting it.
- \`very-happy doctor\`: diagnostics; \`doctor clean\` kills runaway Very Happy processes (ask first).
- \`very-happy sandbox status|configure|disable\`: OS-level sandbox for sessions. Disabling or widening it is a user decision.
- \`very-happy server\`: run a self-hosted server + Web locally.
- Machine settings live in \`$HAPPY_HOME_DIR/settings.json\` (default \`~/.happy\`). Hibernation, auto-update and terminal auto-restore: \`very-happy settings --scope machine\` or the Web machine page. \`webPanels\` and \`todoProvider\` are only ever edited by the user by hand.
- Use a separate \`HAPPY_HOME_DIR\` for experiments; never point tests at the user's real home.`,
    },
    {
        id: 'sharing',
        title: 'Sharing',
        summary: 'share a session, a read-only link, a terminal or a whole project with another account',
        body: () => `# Sharing

Sharing is configured in the Web (session menu / project page), not by agents:

- Share a session with another account (view or operate), or create a read-only link.
- Share a terminal (view, or operate when granted).
- Share a project: members see its sessions; existing terminals can be granted operate in one step.

Sharing exposes the user's work to other people. Do not create, widen or revoke shares on your own; tell the user where to do it in the Web.`,
    },
    {
        id: 'notifications-attention',
        title: 'Notifications and attention',
        summary: 'push notifications, ask a person to step in, the decision board',
        body: () => `# Notifications and attention

- \`very-happy notify -p <message> [-t <title>]\`: push a notification to the user's devices.
- \`very-happy attention "<reason>" [--panel <id>] [--session <id>]\`: ask a person to step in (shown in the Web, optionally pointing at a panel).
- MCP \`request_human\`: block the current turn on a human answer.
- Decision board ("needs my decision" cards) for the user: \`owner_board_post\`, \`owner_board_update\`, \`owner_board_resolve\`, \`owner_board_list\`. Post a card instead of acting when the decision belongs to the user.

Notify only when the user needs to act or asked to be told; do not notify for routine progress.`,
    },
    {
        id: 'panels',
        title: 'Web panels',
        summary: 'embed a machine-local web page (desktop, dashboard) as a panel in the Web',
        body: () => `# Web panels

A machine declares panels in \`webPanels\` of its settings.json (\`[{ "id", "title", "url", "embed"? }]\`); the Web shows them for that machine.

- \`very-happy panels list\`: declared panels and skipped entries.
- \`very-happy panels check\`: fetch each URL from this machine; reports whether it is reachable and embeddable.
- \`very-happy attention "<reason>" --panel <id>\` points a person at a panel.

\`webPanels\` is never written remotely or by an agent on its own: suggest the JSON and let the user add it.`,
    },
    {
        id: 'settings',
        title: 'Settings',
        summary: '`very-happy settings`: read and change settings; loosening changes need the owner\'s decision card',
        body: () => `# Settings

\`very-happy settings\` reads and changes Very Happy settings (JSON output; \`very-happy settings --help\`):

- \`very-happy settings list [--scope account|machine|project]\`: the writable keys with their current values.
- \`very-happy settings get <key>\` / \`very-happy settings set <key> <json-value> [--reason "…"]\`. A bare key picks its scope; \`--project <id>\` (default: this session's project).
- Scopes: \`account\` (synced settings: display, language, voice, new-session agent / model / effort per agent, \`claudeLongContextOptOut\`), \`machine\` (this machine: hibernation, auto-update, terminal auto-restore; written through the daemon when it runs), \`project\` (\`defaults.agent|model|worktree|permissionMode\`).
- Only listed keys are writable; values are checked against the same schema the Web uses. \`todoProvider\`, \`webPanels\`, \`machineId\` and credential files are never written by it.

Owner decision: loosening a permission mode (toward acceptEdits / bypass / yolo), turning on \`assistantSkipPermissions\`, disabling or widening the sandbox, server URLs, credential store, API keys, and commands that run by themselves (terminal startup commands, run-on-select shortcuts) exit 2 with \`needs_owner_decision\` and a \`cardId\` on this session's board. Tell the user, wait for their choice (it arrives as a chat message), then rerun the same command with \`--approved <cardId>\`. One card approves exactly one value once; 放弃 writes nothing. Tightening is written directly.

Limits, stated plainly: the card governs this command only. It is not a sandbox or a permission mode, and it does not stop the same user's processes from forging approval on purpose:
- An agent with a shell can still edit local files such as \`settings.json\` or the local approval records.
- The daemon's \`/machine-setting\` route is protected by loopback plus its control token, not by an approval: a process of this user that reads the token can write any machine key.
- Until the server enforces it, a machine token can still change project defaults (including the permission mode) directly through the projects API; this command's card does not stop that.
Single use and the card-face binding stop mistakes and in-session bypasses. They are not a defence against deliberate forgery. Do none of the above, and never work around a refusal.

- \`settings_key_unavailable\` (account scope): this machine is paired without the account key. Give the user the returned Web settings link; there is no other path.
- \`scope_denied\`: restricted team members only read settings.
- Elsewhere: accounts \`very-happy account\`, sandbox \`very-happy sandbox\`, automations \`auto\`, per session \`spawn --permission-mode/--model\`. Project instructions, sharing, notification devices and sign-in stay in the Web.`,
    },
    {
        id: 'main-agent',
        title: 'Main agent',
        summary: 'the per-account assistant session that dispatches work across projects',
        body: () => `# Main agent

One assistant session per account, opened from the Web sidebar. It reads and dispatches; work is done by team leads, sessions and automations. Its own rules are in the main-agent skill named in its prompt.

Its extra MCP tools: \`sessions_list\`, \`session_read\`, \`session_send\`, \`session_spawn\`, \`session_kill\`, \`session_archive\`, \`terminals_list\`, \`terminal_read\`, \`terminal_send\`, \`memory_update\`, \`journal_append\`. A plain agent CLI can get the session tools through \`very-happy mcp\` in an assistant session.`,
    },
];

export function renderSkill(): string {
    const rows = SKILL_AREAS.map((area) => `| \`${area.id}\` | ${area.title}: ${area.summary} |`).join('\n');
    return `---
name: ${SKILL_NAME}
description: What Very Happy can do and how to operate it from an agent (sessions, terminals, projects, teams, automations, Issues and todos, accounts, machines, sharing, notifications, panels, settings). Use when asked about or asked to change Very Happy itself.
---

# Very Happy

Very Happy runs coding agents (Claude, Codex, pi, Gemini, OpenClaw) on the user's machines through a daemon and mirrors them to a Web client. You operate it through the \`very-happy\` CLI (any shell on a signed-in machine) and the MCP tools injected into managed sessions.

## Capability map

Read one area when you need it: \`very-happy skill <area>\` (\`very-happy skill --json\` lists them).

| area | what |
|---|---|
${rows}

## Rules
1. Check before use: \`very-happy <command> --help\`. A missing command means an older CLI: say so; do not work around it by reading credential or state files.
2. Prefer \`--json\` and the exit code over parsing text. A nonzero exit is a failure; report it.
3. Read before you write: fetch the current object (version) and act on it; for creates keep the same id / request id when retrying after a timeout. A timeout does not prove nothing happened.
4. Permissions are enforced by the CLI and the server. Never clear scope variables (team workers), switch accounts or servers, or borrow credentials to get past a refusal.
5. Ask the user first for anything that loosens permissions, disables the sandbox, shares with others, signs in or out, changes notification recipients, stops the daemon, or runs unattended jobs with broad permissions.
6. Use a separate \`HAPPY_HOME_DIR\` for experiments.
`;
}

/** Exact id, else the one area whose id starts with it or has it as a word (`automation`, `todos`); ambiguous → null. */
export function resolveArea(name: string): SkillArea | null {
    const exact = SKILL_AREAS.find((candidate) => candidate.id === name);
    if (exact) return exact;
    const needle = name.trim().toLowerCase();
    if (needle.length < 3) return null;
    const matches = SKILL_AREAS.filter((candidate) => candidate.id.startsWith(needle) || candidate.id.split('-').some((word) => word.startsWith(needle)));
    return matches.length === 1 ? matches[0] : null;
}

export function renderReference(id: string): string | null {
    const area = resolveArea(id);
    return area ? area.body().trim() + '\n' : null;
}

/** Files materialized by `very-happy skill install` / the daemon: SKILL.md + references/<area>.md. */
export function skillFiles(): { skill: string; files: Record<string, string> } {
    return { skill: renderSkill(), files: Object.fromEntries(SKILL_AREAS.map((area) => [`references/${area.id}.md`, renderReference(area.id)!])) };
}
