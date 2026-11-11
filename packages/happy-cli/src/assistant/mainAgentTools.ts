/**
 * B-916b: tools only the main agent gets (assistant variant, outside any team
 * scope — see startHappyServer). It has no shell (B-063 dispatcher denylist),
 * so everything the owner does with `very-happy issue / todo / spawn` and the
 * project pages needs a tool here:
 *
 *  - teams_list / lead_delegate — work for a team goes to its Lead, never to
 *    a member (main agent spec §7): lead_delegate puts the request into the
 *    Lead's session and the Lead delegates it with team_delegate.
 *  - issue_list / issue_create / issue_assign / issue_comment — account-level
 *    (the shared issue_* tools only act on the issue a session runs for).
 *  - todo_list / todo_add / todo_complete — the `very-happy todo` operations.
 *  - project_list / project_context / project_note — with an explicit
 *    projectId (the shared ones only see the caller's own project).
 *  - session_wrapup / session_handoff / session_restart — adapters for the
 *    wrap-up / handoff (B-915) and restart (B-911) backends, installed by
 *    startHappyServer (mainAgentLifecycle.ts, B-919); without a backend they
 *    answer `not_available`. Only on the owner's explicit request: nothing
 *    calls them on a schedule or by itself.
 *
 * Interface: specs/2026-11-main-agent.md §3.2. Every answer goes through
 * the main agent's caps (toolCaps.ts). `risk` is not handled here: B-916c's
 * gate wrapper adds it to the dispatch tools and intercepts them (spec §7);
 * dispatch payloads keep the field names its table names (goal / acceptance).
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ISSUE_ASSIGNABLE_AGENTS, ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueView, type ProjectDetailResponse, type ProjectSessionContext } from '@slopus/happy-wire'
import type { AssistantToolRegistrar } from './assistantTools'
import { isValidSessionId } from './ids'
import { MAIN_AGENT_OPS_TOOL_NAMES, registerMainAgentOpsTools, type MainAgentOpsDeps } from './mainAgentOpsTools'
import { formatIssueLine, describeIssueError } from '@/issues/format'
import { formatContextForTool } from '@/projects/prompt'

export const MAIN_AGENT_TOOL_NAMES = [
    'teams_list', 'lead_delegate', 'lead_message',
    'issue_list', 'issue_create', 'issue_assign', 'issue_comment',
    'todo_list', 'todo_add', 'todo_complete',
    'project_list', 'project_context', 'project_note',
    'session_wrapup', 'session_handoff', 'session_restart',
    // B-924 (mainAgentOpsTools.ts)
    ...MAIN_AGENT_OPS_TOOL_NAMES,
] as const

/** Names that replace the shared session-scoped tool of the same name on the main agent's surface. */
// (issue_get stays the shared one: it already reads any issue by key outside a team scope.)
export const MAIN_AGENT_REPLACES = ['issue_list', 'issue_comment', 'project_context', 'project_note'] as const

// ─── lifecycle adapters (B-915 / B-911) ──────────────────────────────────────

/** A refusal: one line, never the target session's content. */
export type LifecycleError = { ok: false; error: string }
/** `deduped`: this requestId was already sent — nothing was sent again; `state` is that earlier request's. */
export type WrapupReceipt = { ok: true; sessionId: string; state: 'queued' | 'running' | 'done'; deduped?: true } | (LifecycleError & { sessionId: string })
export type HandoffReceipt = { ok: true; from: string; to: string; state: 'queued' | 'running' | 'done'; deduped?: true } | (LifecycleError & { from: string; to: string })
/** `already`: a restart was already queued for it (nothing new queued). */
export type RestartReceipt = { ok: true; sessionId: string; scheduled: 'idle' | 'now'; already?: true; targetVersion?: string } | (LifecycleError & { sessionId: string })

/** The contract of main agent spec §3 (B-915 wrap-up / handoff, B-911 restart). A missing member = not available yet. */
export type SessionLifecycle = {
    wrapup?: (input: { sessionId: string; requestId: string }) => Promise<WrapupReceipt>
    handoff?: (input: { from: string; to: string | 'new'; note?: string; requestId: string }) => Promise<HandoffReceipt>
    restart?: (input: { sessionId: string; when: 'idle' | 'now'; requestId: string }) => Promise<RestartReceipt>
}

let lifecycle: SessionLifecycle = {}
/** The backends (B-919: mainAgentLifecycle.ts, from startHappyServer); members left out keep the previous one. `null` clears. */
export function installSessionLifecycle(next: SessionLifecycle | null): void {
    lifecycle = next === null ? {} : { ...lifecycle, ...next }
}

// ─── dependencies (injected for tests) ───────────────────────────────────────

type TeamLike = { id: string; name: string; archivedAt?: number; projectId?: string | null; bots?: Array<{ id: string; name: string; root: boolean; sessionId: string | null; activity?: string }>; tasks?: Array<{ status: string }> }

export type MainAgentDeps = {
    /** The account's teams (GET /v1/teams). */
    listTeams: () => Promise<TeamLike[]>
    /** Deliver a user message into a session (local or another machine's); never waits for the answer. */
    deliver: (sessionId: string, text: string) => Promise<{ delivered: boolean; error?: string }>
    issues: {
        list: (params: { status?: string; projectId?: string; assigneeKind?: string; q?: string; limit?: number }) => Promise<{ issues: IssueView[]; nextCursor?: string | null }>
        get: (ref: string) => Promise<{ issue: IssueView }>
        create: (input: any) => Promise<{ issue: IssueView; runs?: Array<{ seq: number; agent: string }> }>
        update: (id: string, input: any) => Promise<{ issue: IssueView; runs?: Array<{ seq: number; agent: string }> }>
        comment: (id: string, input: any) => Promise<{ issue: IssueView }>
    }
    projects: {
        list: () => Promise<{ projects: Array<{ id: string; name: string; goal: string | null; teamIds: string[]; archivedAt: number | null; folders?: Array<{ machineId: string; path: string }> }> }>
        get: (projectId: string) => Promise<ProjectDetailResponse>
        note: (projectId: string, input: { kind: string; title: string; body?: string; supersedes?: string; authorSessionId: string }) => Promise<{ entry: { seq: number; supersedes: string | null } }>
    }
    /** `very-happy todo` (runTodoCommand). */
    todo: (command: { action: 'list' | 'get' | 'add' | 'complete'; id?: string; version?: number; title?: string; note?: string }) => Promise<unknown>
    machineId: () => Promise<string | null>
    /** This (main agent) session. */
    sessionId: () => string
    /**
     * B-924: who started the current turn — `automation` when every prompt of
     * it came from an automation run (localId `automation-…`). Wrap-up and
     * handoff refuse such a turn: they need the owner's words.
     */
    turnSource?: () => 'owner' | 'automation' | 'unknown'
    /** B-924 board / session readers for boards_read, sessions_search, wrapup_suggest / wrapup_selected; absent = they answer not_available. */
    ops?: Omit<MainAgentOpsDeps, 'sessionId' | 'wrapup' | 'listTeams'>
}

type Result = { content: Array<{ type: 'text'; text: string }>; isError: boolean }
const ok = (text: string): Result => ({ content: [{ type: 'text', text }], isError: false })
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true })
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const oneLine = (text: string, max: number) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }

const id = z.string().min(1).max(128)
const requestId = z.string().min(1).max(128).optional().describe('Unique operation id; reuse it with the same arguments after an uncertain answer')
const OPEN_STATUSES = ISSUE_STATUSES.filter(s => s !== 'done' && s !== 'cancelled')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The Lead of a team: its first root bot bound to a session, an active one preferred. */
export function teamLead(team: TeamLike): { id: string; name: string; sessionId: string } | null {
    const roots = (team.bots ?? []).filter(b => b.root && b.sessionId)
    const lead = roots.find(b => b.activity && b.activity !== 'inactive') ?? roots[0]
    return lead ? { id: lead.id, name: lead.name, sessionId: lead.sessionId! } : null
}

export function leadMessageText(input: { body: string; taskId?: string }): string {
    return [`[Very Happy main agent → Lead] A message from the owner${input.taskId ? ` about task ${input.taskId}` : ''}:`, input.body.trim()].join('\n')
}

export function leadDelegationText(input: { goal: string; acceptance: string[]; note?: string }): string {
    return [
        '[Very Happy main agent → Lead] The owner asked for this work for your team. Delegate it with team_delegate (goal and acceptance below, as written) unless it is clearly yours to do; report back through the usual channel.',
        `Goal: ${input.goal.trim()}`,
        'Acceptance:',
        ...input.acceptance.map(a => `- ${a.trim()}`),
        ...(input.note ? [`Note: ${input.note.trim()}`] : []),
    ].join('\n')
}

/** The server's answer when an author is not a member (and, B-916b, not the account's main agent). */
function isNotMember(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'not_a_project_member'
}

function runNote(result: { runs?: Array<{ seq: number; agent: string }> }): string {
    return result.runs?.length ? `; run #${result.runs[0].seq} queued on ${result.runs[0].agent}` : ''
}

/** ProjectDetailResponse → the shape `project_context` prints for one's own project. */
export function detailAsContext(detail: ProjectDetailResponse, full: boolean): ProjectSessionContext {
    const log = detail.log ?? []
    const decisions = log.filter(e => e.kind === 'decision' && !e.revokedAt && !e.supersededBy).map(e => ({ id: e.id, seq: e.seq, title: e.title, createdAt: e.createdAt }))
    return {
        project: { id: detail.project.id, name: detail.project.name, goal: detail.project.goal, instructions: detail.project.instructions, instructionsVersion: detail.project.instructionsVersion },
        via: null, team: null, decisions,
        log: full ? log : log.filter(e => !e.revokedAt).slice(-10),
        sessions: detail.presence ?? [], unread: [], asOf: Date.now(), previousReadAt: 0,
    }
}

export function registerMainAgentTools(mcp: AssistantToolRegistrar, deps: MainAgentDeps): void {
    const register = (name: typeof MAIN_AGENT_TOOL_NAMES[number], description: string, inputSchema: Record<string, z.ZodTypeAny>, readOnly: boolean, run: (args: any) => Promise<Result>) => {
        mcp.registerTool(name, {
            description, inputSchema,
            annotations: { readOnlyHint: readOnly, idempotentHint: readOnly, openWorldHint: false, destructiveHint: false },
        }, async (args: any) => {
            try { return await run(args ?? {}) }
            catch (error) { return fail(name.startsWith('issue_') ? describeIssueError(error) : message(error)) }
        })
    }

    // ── teams ────────────────────────────────────────────────────────────────
    register('teams_list', 'List this account\'s Very Happy teams: id, name, Lead (bot and session), open tasks and project. Archived teams are left out.', {}, true, async () => {
        const teams = (await deps.listTeams()).filter(t => t.archivedAt === undefined || t.archivedAt === null)
        if (!teams.length) return ok('no teams')
        return ok([`${teams.length} team(s) — id name lead open-tasks project:`, ...teams.map(t => {
            const lead = teamLead(t)
            const open = (t.tasks ?? []).filter(task => task.status !== 'done' && task.status !== 'cancelled').length
            return [t.id, `"${oneLine(t.name, 40)}"`, lead ? `lead=${lead.name} bot=${lead.id} session=${lead.sessionId}` : 'lead=none', `open=${open}`, t.projectId ? `project=${t.projectId}` : ''].filter(Boolean).join(' ')
        })].join('\n'))
    })

    /** Resolve a team's Lead, or the refusal receipt. */
    const leadOf = async (teamId: string): Promise<{ team: TeamLike; lead: { id: string; name: string; sessionId: string } } | Result> => {
        const team = (await deps.listTeams()).find(t => t.id === teamId)
        if (!team) return fail(`Team ${teamId} not found (teams_list shows the account's teams).`)
        if (team.archivedAt !== undefined && team.archivedAt !== null) return fail(`Team "${oneLine(team.name, 60)}" is archived.`)
        const lead = teamLead(team)
        if (!lead) return fail(JSON.stringify({ ok: false, error: 'lead_unreachable', detail: `Team "${oneLine(team.name, 60)}" has no Lead session` }))
        return { team, lead }
    }
    const deliverToLead = async (teamId: string, body: string): Promise<Result> => {
        const found = await leadOf(teamId)
        if ('content' in found) return found
        const { team, lead } = found
        const sent = await deps.deliver(lead.sessionId, body)
        if (!sent.delivered) return fail(JSON.stringify({ ok: false, error: 'lead_unreachable', detail: oneLine(sent.error ?? 'not delivered', 200) }))
        // As the owner's request, via the main agent (the delivered text says so on its first line).
        return ok(JSON.stringify({ ok: true, as: 'owner', via: 'main-agent', teamId: team.id, team: oneLine(team.name, 60), lead: lead.name, leadSessionId: lead.sessionId, state: 'delivered' }))
    }

    register('lead_delegate', 'Give work to a team: the request goes to that team\'s Lead, who delegates it to members (you never assign members yourself). Returns once it is delivered to the Lead\'s session; the Lead reports through the board.', {
        teamId: id.describe('From teams_list'),
        goal: z.string().min(1).max(32_000),
        acceptance: z.array(z.string().min(1).max(32_000)).min(1).max(32).describe('Checkable acceptance criteria, one per item'),
        note: z.string().max(4000).optional().describe('Context for the Lead (owner\'s words, links)'),
        requestId,
    }, false, async (args) => deliverToLead(args.teamId, leadDelegationText({ goal: args.goal, acceptance: args.acceptance, note: args.note })))

    register('lead_message', 'Tell a team\'s Lead something (a follow-up, an answer, a change of plan). Delivered into the Lead\'s session; taskId only names the task it is about.', {
        teamId: id.describe('From teams_list'),
        body: z.string().min(1).max(32_000),
        taskId: id.optional().describe('Team task this is about (quoted in the message)'),
        requestId,
    }, false, async (args) => deliverToLead(args.teamId, leadMessageText({ body: args.body, taskId: args.taskId })))

    // ── issues (account level) ───────────────────────────────────────────────
    register('issue_list', 'List this account\'s issues, newest first (open ones unless status is given). Filter by project, assignee or text.', {
        scope: z.enum(['account']).optional().describe('account (the only scope on the main agent)'),
        status: z.array(z.enum(ISSUE_STATUSES)).max(ISSUE_STATUSES.length).optional().describe('Only these statuses (default: every open status)'),
        projectId: id.optional(),
        assignee: z.enum(['none', 'self', 'agent']).optional().describe('none = todos, self = the owner\'s, agent = an agent\'s'),
        q: z.string().min(1).max(200).optional().describe('Text search'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
    }, true, async (args) => {
        const list = await deps.issues.list({
            status: (args.status?.length ? args.status : OPEN_STATUSES).join(','),
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.assignee ? { assigneeKind: args.assignee } : {}),
            ...(args.q ? { q: args.q } : {}),
            limit: args.limit ?? 20,
        })
        return ok(list.issues.length ? list.issues.map(formatIssueLine).join('\n') + (list.nextCursor ? '\n(more: narrow the filter or raise limit)' : '') : 'no issues')
    })

    register('issue_create', 'Create an issue (it starts unassigned: give it to an agent with issue_assign).', {
        title: z.string().min(1).max(500),
        description: z.string().max(60_000).optional(),
        projectId: id.optional(),
        priority: z.enum(ISSUE_PRIORITIES).optional(),
        labels: z.array(z.string().min(1).max(64)).max(20).optional(),
        requestId,
    }, false, async (args) => {
        const result = await deps.issues.create({
            title: args.title.trim(), requestId: args.requestId ?? randomUUID(),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.priority ? { priority: args.priority } : {}),
            ...(args.labels?.length ? { labels: args.labels } : {}),
        })
        return ok(`created ${formatIssueLine(result.issue)}${runNote(result)}`)
    })

    register('issue_assign', 'Give an issue to an agent (claude | codex | pi); a runnable issue starts a run at once — on this machine unless assignee.machineId.', {
        issueId: id.optional().describe('Issue id'),
        key: z.string().regex(/^VH-[1-9][0-9]{0,8}$/i).optional().describe('Issue key, e.g. VH-12 (instead of issueId)'),
        assignee: z.object({
            agent: z.enum(ISSUE_ASSIGNABLE_AGENTS),
            machineId: id.optional(),
            directory: z.string().min(1).max(4096).optional().describe('Working directory of the run'),
            model: z.string().trim().min(1).max(256).optional(),
        }),
        requestId,
    }, false, async (args) => {
        const ref = args.issueId ?? args.key
        if (!ref) return fail('Pass issueId or key (VH-N).')
        const target = (await deps.issues.get(ref)).issue
        const machineId = args.assignee.machineId ?? await deps.machineId()
        if (!machineId) return fail('This machine has no Very Happy id yet; pass assignee.machineId.')
        const result = await deps.issues.update(target.id, { assignee: {
            kind: 'agent', agent: args.assignee.agent, machineId,
            ...(args.assignee.directory ? { directory: args.assignee.directory } : {}),
            ...(args.assignee.model ? { model: args.assignee.model } : {}),
        } })
        return ok(`assigned ${formatIssueLine(result.issue)}${runNote(result)}`)
    })

    register('issue_comment', 'Comment on an issue (VH-12 or id) as the owner. Without issue it comments on the issue this session runs for.', {
        issue: id.optional().describe('Issue key (VH-12) or id'),
        body: z.string().min(1).max(60_000),
    }, false, async (args) => {
        if (!args.issue) return fail('Pass issue="VH-N": the main agent does not run for an issue.')
        const target = (await deps.issues.get(args.issue)).issue
        const result = await deps.issues.comment(target.id, { body: args.body, requestId: randomUUID() })
        return ok(`commented on ${result.issue.key}`)
    })

    // ── todos ────────────────────────────────────────────────────────────────
    register('todo_list', 'List the owner\'s todos (open first): key or id, state, title, version.', {}, true, async () => {
        const result = await deps.todo({ action: 'list' }) as { records?: Array<{ id: string; key?: string; title: string; status: string; version: number }>; truncated?: boolean }
        const records = result?.records ?? []
        if (!records.length) return ok('no todos')
        const open = records.filter(r => r.status !== 'done')
        const done = records.filter(r => r.status === 'done')
        return ok([`${open.length} open, ${done.length} done:`, ...[...open, ...done].map(r => `${r.key ?? r.id} [${r.status}] ${oneLine(r.title, 100)} v${r.version}${r.key ? ` id=${r.id}` : ''}`)].join('\n'))
    })

    register('todo_add', 'Add a todo for the owner.', {
        title: z.string().min(1).max(500),
        note: z.string().max(8000).optional(),
        requestId: z.string().regex(UUID).optional().describe('A UUID; reuse it with the same arguments after an uncertain answer'),
    }, false, async (args) => {
        const record = await deps.todo({ action: 'add', id: args.requestId ?? randomUUID(), title: args.title, ...(args.note !== undefined ? { note: args.note } : {}) }) as { id: string; key?: string; title: string; version: number }
        return ok(`added todo ${record.key ?? record.id} "${oneLine(record.title, 120)}" v${record.version}`)
    })

    register('todo_complete', 'Mark a todo done (key VH-12 or id from todo_list). version defaults to the current one.', {
        id: z.string().min(1).max(128),
        version: z.number().int().min(0).optional(),
    }, false, async (args) => {
        let version = args.version
        if (version === undefined) {
            const current = await deps.todo({ action: 'get', id: args.id }) as { version: number } | null
            if (!current) return fail('Todo not found; it may have been deleted.')
            version = current.version
        }
        const record = await deps.todo({ action: 'complete', id: args.id, version }) as { id: string; key?: string; status: string; version: number }
        return ok(`todo ${record.key ?? record.id} is ${record.status} v${record.version}`)
    })

    // ── projects (any project of the account) ────────────────────────────────
    register('project_list', 'List this account\'s Very Happy projects: id, name, goal, teams.', {}, true, async () => {
        const { projects } = await deps.projects.list()
        const live = projects.filter(p => !p.archivedAt)
        if (!live.length) return ok('no projects')
        return ok([`${live.length} project(s) — id name folder goal:`, ...live.map(p => `${p.id} "${oneLine(p.name, 40)}"${p.folders?.[0] ? ` folder=${p.folders[0].machineId}:${p.folders[0].path}` : ''}${p.goal ? ` ${oneLine(p.goal, 60)}` : ''}${p.teamIds.length ? ` teams=${p.teamIds.length}` : ''}`)].join('\n'))
    })

    register('project_context', 'Read a Very Happy project of this account: instructions, decisions in effect, recent log entries (last 10; full=true for all), sessions.', {
        projectId: id.describe('From project_list'),
        section: z.enum(['instructions', 'log', 'sessions', 'messages']).optional().describe('Only this part'),
        full: z.boolean().optional().describe('Everything'),
    }, true, async (args) => {
        const detail = await deps.projects.get(args.projectId)
        const folders = (detail.project.folders ?? []).map(f => `${f.machineId}:${f.path}`)
        const text = formatContextForTool(detailAsContext(detail, args.full === true), { full: args.full === true, section: args.section })
        // The folders tell the main agent where to spawn work for this project.
        return ok(folders.length ? `${text}\nFolders (machineId:path): ${folders.join(', ')}` : text)
    })

    register('project_note', 'Append to a project\'s log in your own name (the main agent): kind decision (changes how its sessions work) | finding (they would otherwise redo it) | handoff. Not progress.', {
        projectId: id.describe('From project_list'),
        kind: z.enum(['decision', 'finding', 'handoff']),
        title: z.string().min(1).max(200),
        body: z.string().max(4000).optional(),
        supersedes: z.string().min(1).max(128).optional().describe('Entry it replaces: "#12" or its id'),
    }, false, async (args) => {
        // The main agent is a member of none of the projects it notes into; a
        // server with B-916b takes it as the author because the account's KV
        // pointer names it. An older server refuses — never written as the owner.
        try {
            const { entry } = await deps.projects.note(args.projectId, {
                kind: args.kind, title: args.title, authorSessionId: deps.sessionId(),
                ...(args.body ? { body: args.body } : {}), ...(args.supersedes ? { supersedes: args.supersedes } : {}),
            })
            return ok(`recorded #${entry.seq}${entry.supersedes ? ' (supersedes an earlier entry)' : ''}`)
        } catch (error) {
            if (isNotMember(error)) return ok(JSON.stringify({ ok: false, error: 'project_not_member', detail: 'This server does not take project notes from the main agent yet' }))
            throw error
        }
    })

    // ── session lifecycle (B-915 / B-911 adapters, B-919 backends) ──────────
    // Owner-only (main agent spec decision 6: no automatic wrap-up): each call names one session the owner named.
    const ONLY_ON_REQUEST = 'Only when the owner explicitly asks for it, for the session they named — never on your own initiative, on a schedule, or in batches over sessions they did not name.'
    const DEDUPED = 'deduped: true = this requestId was already used, so nothing was sent again (for to = new: the same new session is returned); use a new requestId for a new request.'
    const notAvailable = (what: string) => ok(JSON.stringify({ ok: false, error: 'not_available', detail: `${what} is not available on this Very Happy version yet` }))
    const receipt = (r: { ok: boolean }) => r.ok ? ok(JSON.stringify(r)) : fail(JSON.stringify(r))
    // B-924: a turn an automation started (morning brief, stuck / wrap-up checks) never wraps up or hands off by itself.
    const automationTurn = () => deps.turnSource?.() === 'automation'
    const OWNER_REQUIRED = JSON.stringify({ ok: false, error: 'owner_request_required', note: 'This turn was started by an automation, not the owner: suggest it instead (wrapup_suggest) and let the owner choose.' })
    register('session_wrapup', `Ask one session of the account to wrap up (the same as the owner pressing 收尾 in it): it gets one turn to write its wrap-up and the board gets a card. Never closes or archives anything. Receipt: { ok, sessionId, state: queued | running (already wrapping up, nothing sent) | done, deduped? }. ${DEDUPED} ${ONLY_ON_REQUEST}`, {
        sessionId: id, requestId,
    }, false, async (args) => {
        if (!isValidSessionId(args.sessionId)) return fail('Invalid sessionId')
        if (automationTurn()) return fail(OWNER_REQUIRED)
        if (!lifecycle.wrapup) return notAvailable('Wrap-up')
        return receipt(await lifecycle.wrapup({ sessionId: args.sessionId, requestId: args.requestId ?? randomUUID() }))
    })
    register('session_handoff', `Ask session \`from\` to hand its progress over (the same as the owner's 交接给…): to = an existing session's id, or "new" / omitted for a new session started in from's directory (from must be on this machine). from writes the handoff itself — do not copy its progress. Neither from nor to can be you (the main agent). Receipt: { ok, from, to, state, deduped? }. ${DEDUPED} ${ONLY_ON_REQUEST}`, {
        from: id, to: id.optional().describe('Session id; omit (or "new") for a new session'), note: z.string().max(4000).optional(), requestId,
    }, false, async (args) => {
        const to = args.to ?? 'new'
        if (!isValidSessionId(args.from) || (to !== 'new' && !isValidSessionId(to))) return fail('Invalid session id')
        if (automationTurn()) return fail(OWNER_REQUIRED)
        if (!lifecycle.handoff) return notAvailable('Handoff')
        return receipt(await lifecycle.handoff({ from: args.from, to, ...(args.note ? { note: args.note } : {}), requestId: args.requestId ?? randomUUID() }))
    })
    register('session_restart', `Restart a session of this machine onto the installed Very Happy version, keeping its conversation: when = idle (default; queued until its current turn and background tasks end) or now (only if it is idle right now — a busy session is refused, never interrupted). The owner's own terminal sessions are never restarted. ${ONLY_ON_REQUEST}`, {
        sessionId: id, when: z.enum(['idle', 'now']).optional(), requestId,
    }, false, async (args) => {
        if (!isValidSessionId(args.sessionId)) return fail('Invalid sessionId')
        const when = args.when ?? 'idle'
        if (!lifecycle.restart) return notAvailable(when === 'idle' ? 'Restart when idle' : 'Restart')
        return receipt(await lifecycle.restart({ sessionId: args.sessionId, when, requestId: args.requestId ?? randomUUID() }))
    })

    // ── B-924: boards / session search / wrap-up suggestions ────────────────
    // Always registered (a fixed tool list); without readers (tests, older hosts) they answer not_available.
    const unavailable = async (): Promise<never> => { throw new Error('not_available: this tool has no backend in this session') }
    const ops = deps.ops ?? { board: { list: unavailable, post: unavailable, resolve: unavailable }, sessions: unavailable, projectSessionIds: unavailable }
    registerMainAgentOpsTools(mcp, { ...ops, sessionId: deps.sessionId, listTeams: deps.listTeams, wrapup: () => lifecycle.wrapup })
}
