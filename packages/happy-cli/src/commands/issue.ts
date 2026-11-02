import { randomUUID } from 'node:crypto';
import { ISSUE_ASSIGNABLE_AGENTS, ISSUE_PRIORITIES, ISSUE_STATUSES, parseIssueRef, type IssueAssignee, type IssueCreate, type IssueUpdate, type IssueView } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readSettings } from '@/persistence';
import { readTeamScope, teamScopePath } from '@/teams/context';
import { importLegacyTodosOnce, sharedIssuesClient, type IssuesClient } from '@/issues/client';
import { describeIssueError, formatIssueDetail, formatIssueLine } from '@/issues/format';

export const ISSUE_HELP = `very-happy issue — account Issues (spec 2026-11-issues)
  very-happy issue list [--status todo,in_progress] [--project ID] [--mine] [--unassigned] [--all] [--limit N] [--json]
  very-happy issue show VH-N [--json]
  very-happy issue create --title TEXT [--desc TEXT] [--assign AGENT[@MACHINE_ID]|self|none] [--dir PATH] [--mode M] [--model ID]
                          [--project ID] [--priority P] [--label L]... [--status S] [--json]
  very-happy issue update VH-N [--status S] [--assign …] [--dir PATH] [--mode M] [--model ID] [--title TEXT] [--desc TEXT]
                          [--priority P] [--label L]... [--project ID|none] [--comment TEXT] [--json]
  very-happy issue comment VH-N TEXT [--mention AGENT[@MACHINE_ID]]... [--json]

AGENT is ${ISSUE_ASSIGNABLE_AGENTS.join(' | ')}; without @MACHINE_ID it runs on this machine.
Assigning an agent on a runnable status (todo / in_progress / in_review / blocked)
starts a run; backlog only records the assignee. A comment starting with /note
never wakes an agent.

Inside a Very Happy session (HAPPY_SESSION_ID set) update and comment act as the
agent on the issue this session works on: status only in_progress / in_review /
blocked (in_review and blocked need --comment), never done or cancelled; create
is not available. Use --title=TEXT for values starting with --.`;

type Action = 'list' | 'show' | 'create' | 'update' | 'comment' | 'help';
const MULTI = new Set(['--label', '--mention']);
const BOOL = new Set(['--json', '--mine', '--unassigned', '--all']);
const ALLOWED: Record<Exclude<Action, 'help'>, string[]> = {
    list: ['--status', '--project', '--mine', '--unassigned', '--all', '--limit', '--json'],
    show: ['--json'],
    create: ['--title', '--desc', '--assign', '--dir', '--mode', '--model', '--project', '--priority', '--label', '--status', '--json'],
    update: ['--status', '--assign', '--dir', '--mode', '--model', '--title', '--desc', '--priority', '--label', '--project', '--comment', '--json'],
    comment: ['--mention', '--json'],
};

export interface IssueCommand {
    action: Action;
    positional: string[];
    flags: Record<string, string>;
    multi: Record<string, string[]>;
    bools: Set<string>;
}

export function parseIssueArgs(args: string[]): IssueCommand {
    if (args.length === 0 || args[0] === '--help' || args[0] === 'help') return { action: 'help', positional: [], flags: {}, multi: {}, bools: new Set() };
    const action = args[0] as Action;
    if (!(action in ALLOWED)) throw new Error('Unknown issue command; use issue --help');
    const cmd: IssueCommand = { action, positional: [], flags: {}, multi: {}, bools: new Set() };
    if (args.includes('--help')) return { ...cmd, action: 'help' };
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith('--')) { cmd.positional.push(arg); continue; }
        const eq = arg.indexOf('=');
        const flag = eq === -1 ? arg : arg.slice(0, eq);
        if (!ALLOWED[action as Exclude<Action, 'help'>].includes(flag)) throw new Error(`${flag} is not supported for issue ${action}`);
        if (BOOL.has(flag)) { if (eq !== -1) throw new Error(`${flag} takes no value`); cmd.bools.add(flag); continue; }
        const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
        if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Error(`Missing value for ${flag}`);
        if (MULTI.has(flag)) (cmd.multi[flag] ??= []).push(value);
        else {
            if (Object.hasOwn(cmd.flags, flag)) throw new Error(`Duplicate option: ${flag}`);
            cmd.flags[flag] = value;
        }
    }
    const wantRef = action === 'show' || action === 'update' || action === 'comment';
    if (wantRef && !cmd.positional[0]) throw new Error(`issue ${action} needs an issue (VH-N)`);
    if (wantRef && !parseIssueRef(cmd.positional[0])) throw new Error(`Not an issue reference: ${cmd.positional[0]}`);
    if (action === 'comment' && cmd.positional.length !== 2) throw new Error('issue comment needs VH-N and one TEXT argument (quote it)');
    if ((action === 'show' || action === 'update') && cmd.positional.length !== 1) throw new Error('Unexpected argument');
    if ((action === 'list' || action === 'create') && cmd.positional.length) throw new Error('Unexpected argument');
    if (action === 'create' && !cmd.flags['--title']?.trim()) throw new Error('create needs --title');
    for (const f of ['--dir', '--mode', '--model']) if (cmd.flags[f] !== undefined && !cmd.flags['--assign']) throw new Error(`${f} goes with --assign AGENT`);
    for (const key of ['--status']) if (cmd.flags[key] !== undefined && action !== 'list' && !(ISSUE_STATUSES as readonly string[]).includes(cmd.flags[key])) throw new Error(`Unknown status "${cmd.flags[key]}" (${ISSUE_STATUSES.join(', ')})`);
    if (cmd.flags['--priority'] !== undefined && !(ISSUE_PRIORITIES as readonly string[]).includes(cmd.flags['--priority'])) throw new Error(`Unknown priority (${ISSUE_PRIORITIES.join(', ')})`);
    if (cmd.flags['--limit'] !== undefined && !/^[1-9][0-9]{0,2}$/.test(cmd.flags['--limit'])) throw new Error('--limit must be 1–500');
    return cmd;
}

/** `codex`, `codex@<machineId>`, `self`, `none` → assignee (no @ = this machine). */
export function parseAssign(value: string, localMachineId: string | null, directory?: string, run: { permissionMode?: string; model?: string } = {}): IssueAssignee {
    if (value === 'self' || value === 'none') return { kind: value };
    const [agent, machine] = value.split('@', 2);
    if (!(ISSUE_ASSIGNABLE_AGENTS as readonly string[]).includes(agent)) throw new Error(`Unknown agent "${agent}" (${ISSUE_ASSIGNABLE_AGENTS.join(', ')}, self, none)`);
    const machineId = machine || localMachineId;
    if (!machineId) throw new Error('This machine has no id yet (start the daemon once), or pass AGENT@MACHINE_ID');
    return {
        kind: 'agent', agent: agent as (typeof ISSUE_ASSIGNABLE_AGENTS)[number], machineId,
        ...(directory ? { directory } : {}), ...(run.permissionMode ? { permissionMode: run.permissionMode } : {}), ...(run.model ? { model: run.model } : {}),
    };
}

export function parseMention(value: string, localMachineId: string | null): { kind: 'agent'; agent: string; machineId?: string } {
    const [agent, machine] = value.split('@', 2);
    if (!(ISSUE_ASSIGNABLE_AGENTS as readonly string[]).includes(agent)) throw new Error(`Unknown agent "${agent}" for --mention`);
    // No machine: the server routes to the assignee's machine for that agent, else this one.
    void localMachineId;
    return { kind: 'agent', agent, ...(machine ? { machineId: machine } : {}) };
}

async function localMachineId(): Promise<string | null> {
    try { return (await readSettings())?.machineId ?? null; } catch { return null; }
}

/** The session this command runs in (agent routes), or null outside a session. */
export function agentSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
    const sid = env.HAPPY_SESSION_ID;
    return sid && /^[A-Za-z0-9_-]{1,128}$/.test(sid) ? sid : null;
}

async function scoped(sessionId: string | null): Promise<boolean> {
    if (process.env.VH_TEAM_SCOPE_FILE !== undefined) return true;
    return !!sessionId && !!(await readTeamScope(teamScopePath(sessionId)));
}


function print(json: boolean, value: unknown, text: string) {
    console.log(json ? JSON.stringify({ serverUrl: configuration.serverUrl, result: value }) : text);
}

export async function runIssueCommand(cmd: IssueCommand, deps: { client?: IssuesClient; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
    if (cmd.action === 'help') { console.log(ISSUE_HELP); return; }
    const client = deps.client ?? sharedIssuesClient();
    const json = cmd.bools.has('--json');
    const sessionId = agentSessionId(deps.env ?? process.env);
    const isScoped = await scoped(sessionId);

    if (cmd.action === 'update' || cmd.action === 'comment') {
        if (sessionId) {
            // Agent route (spec §4/§11): only this session's issue; the server enforces the status rules.
            const ctx = await client.session(sessionId);
            const ref = parseIssueRef(cmd.positional[0])!;
            if (!ctx.issue || ('number' in ref ? ref.number !== ctx.issue.number : ref.id !== ctx.issue.id)) {
                throw new Error('issue_not_bound: Inside a session you can only update or comment on the issue this session works on.');
            }
            if (cmd.action === 'comment') {
                if (cmd.multi['--mention']?.length) throw new Error('--mention is for the owner; an agent comment never wakes another agent');
                const result = await client.agentComment({ sessionId, body: cmd.positional[1], requestId: randomUUID() });
                print(json, result, `commented on ${result.issue.key}`);
                return;
            }
            const extra = Object.keys(cmd.flags).filter(f => f !== '--status' && f !== '--comment');
            if (extra.length || cmd.multi['--label']?.length) throw new Error(`Inside a session only --status and --comment can be changed (not ${[...extra, ...(cmd.multi['--label']?.length ? ['--label'] : [])].join(', ')})`);
            const result = await client.agentUpdate({ sessionId, requestId: randomUUID(), ...(cmd.flags['--status'] ? { status: cmd.flags['--status'] } : {}), ...(cmd.flags['--comment'] ? { comment: cmd.flags['--comment'] } : {}) });
            print(json, result, `${result.issue.key} is ${result.issue.status}`);
            return;
        }
    }
    if (isScoped && cmd.action !== 'show') throw new Error('Scoped Teams sessions cannot access account Issues; ask the owner session.');
    if (sessionId && cmd.action === 'create') throw new Error('Agents cannot create issues; ask the owner.');

    if (cmd.action === 'list') {
        if (!sessionId) await importLegacyTodosOnce(client);
        const status = cmd.flags['--status'] ?? (cmd.bools.has('--all') ? undefined : ISSUE_STATUSES.filter(s => s !== 'done' && s !== 'cancelled').join(','));
        const list = await client.list({
            ...(status ? { status } : {}), ...(cmd.flags['--project'] ? { projectId: cmd.flags['--project'] } : {}),
            ...(cmd.bools.has('--mine') ? { assigneeKind: 'self' } : cmd.bools.has('--unassigned') ? { assigneeKind: 'none' } : {}),
            limit: cmd.flags['--limit'] ? Number(cmd.flags['--limit']) : 100,
        });
        print(json, list, list.issues.length ? list.issues.map(formatIssueLine).join('\n') : 'no issues');
        return;
    }
    if (cmd.action === 'show') {
        if (isScoped) {
            const ctx = sessionId ? await client.session(sessionId) : null;
            const ref = parseIssueRef(cmd.positional[0])!;
            if (!ctx?.issue || ('number' in ref ? ref.number !== ctx.issue.number : ref.id !== ctx.issue.id)) throw new Error('Scoped Teams sessions can read only the issue they are working on.');
        }
        if (!sessionId) await importLegacyTodosOnce(client);
        const detail = await client.get(cmd.positional[0]);
        print(json, detail, formatIssueDetail({ issue: detail.issue, comments: detail.comments, runs: detail.runs }));
        return;
    }
    const machine = await localMachineId();
    if (cmd.action === 'create') {
        const input: IssueCreate = {
            title: cmd.flags['--title'].trim(), requestId: randomUUID(),
            ...(cmd.flags['--desc'] !== undefined ? { description: cmd.flags['--desc'] } : {}),
            ...(cmd.flags['--assign'] ? { assignee: parseAssign(cmd.flags['--assign'], machine, cmd.flags['--dir'], { permissionMode: cmd.flags['--mode'], model: cmd.flags['--model'] }) } : {}),
            ...(cmd.flags['--project'] ? { projectId: cmd.flags['--project'] } : {}),
            ...(cmd.flags['--priority'] ? { priority: cmd.flags['--priority'] as IssueCreate['priority'] } : {}),
            ...(cmd.multi['--label']?.length ? { labels: cmd.multi['--label'] } : {}),
            ...(cmd.flags['--status'] ? { status: cmd.flags['--status'] as IssueCreate['status'] } : {}),
        };
        const result = await client.create(input);
        print(json, result, `created ${formatIssueLine(result.issue)}${result.runs?.length ? `\nrun #${result.runs[0].seq} queued on ${result.runs[0].agent}` : ''}`);
        return;
    }
    const target = (await client.get(cmd.positional[0])).issue;
    if (cmd.action === 'comment') {
        const mentions = (cmd.multi['--mention'] ?? []).map(m => parseMention(m, machine));
        const result = await client.comment(target.id, { body: cmd.positional[1], requestId: randomUUID(), ...(mentions.length ? { mentions: mentions as never } : {}) });
        print(json, result, `commented on ${result.issue.key}${result.comment?.routedRunIds.length ? ' (delivered to the agent)' : ''}`);
        return;
    }
    const patch: IssueUpdate = {
        ...(cmd.flags['--status'] ? { status: cmd.flags['--status'] as IssueUpdate['status'] } : {}),
        ...(cmd.flags['--assign'] ? { assignee: parseAssign(cmd.flags['--assign'], machine, cmd.flags['--dir'], { permissionMode: cmd.flags['--mode'], model: cmd.flags['--model'] }) } : {}),
        ...(cmd.flags['--title'] !== undefined ? { title: cmd.flags['--title'].trim() } : {}),
        ...(cmd.flags['--desc'] !== undefined ? { description: cmd.flags['--desc'] } : {}),
        ...(cmd.flags['--priority'] ? { priority: cmd.flags['--priority'] as IssueUpdate['priority'] } : {}),
        ...(cmd.multi['--label'] ? { labels: cmd.multi['--label'] } : {}),
        ...(cmd.flags['--project'] ? { projectId: cmd.flags['--project'] === 'none' ? null : cmd.flags['--project'] } : {}),
    };
    let issue: IssueView = target;
    if (Object.keys(patch).length) issue = (await client.update(target.id, patch)).issue;
    if (cmd.flags['--comment']) await client.comment(target.id, { body: cmd.flags['--comment'], requestId: randomUUID() });
    if (!Object.keys(patch).length && !cmd.flags['--comment']) throw new Error('Nothing to update');
    print(json, issue, `updated ${formatIssueLine(issue)}`);
}

export async function handleIssueCommand(args: string[]): Promise<void> {
    const cmd = parseIssueArgs(args);
    try { await runIssueCommand(cmd); }
    catch (error) { throw new Error(describeIssueError(error)); }
}
