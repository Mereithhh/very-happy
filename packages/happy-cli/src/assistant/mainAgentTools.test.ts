import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IssueView, ProjectDetailResponse } from '@slopus/happy-wire'
import type { AssistantToolRegistrar } from './assistantTools'
import { detailAsContext, installSessionLifecycle, leadDelegationText, MAIN_AGENT_TOOL_NAMES, registerMainAgentTools, teamLead, type MainAgentDeps } from './mainAgentTools'

type Handler = (args: any) => Promise<any>
function recorder() {
    const tools = new Map<string, Handler>()
    const server = { registerTool: ((name: string, _config: unknown, handler: Handler) => { tools.set(name, handler); return {} as never }) } as unknown as AssistantToolRegistrar
    return { tools, server }
}
const text = (r: any) => r.content[0].text as string

const issue = (over: Partial<IssueView> = {}): IssueView => ({
    id: 'iss-1', key: 'VH-7', number: 7, title: 'Fix login', description: '', status: 'todo', priority: 'none', labels: [], assignee: { kind: 'none' },
    projectId: null, parentId: null, dueAt: null, sortOrder: 0, version: 1, createdAt: 0, updatedAt: 0, deletedAt: null, ...over,
} as unknown as IssueView)

function deps(over: Partial<MainAgentDeps> = {}): MainAgentDeps & { calls: any[] } {
    const calls: any[] = []
    const base: MainAgentDeps = {
        listTeams: async () => [{
            id: 'team-1', name: 'Dev', projectId: 'p1',
            bots: [
                { id: 'member', name: 'Dev-A', root: false, sessionId: 'sess-member', activity: 'active' },
                { id: 'old-root', name: 'Old Lead', root: true, sessionId: 'sess-old', activity: 'inactive' },
                { id: 'lead', name: 'Lead', root: true, sessionId: 'sess-lead', activity: 'active' },
            ],
            tasks: [{ status: 'running' }, { status: 'done' }],
        }, { id: 'team-2', name: 'Gone', archivedAt: 5, bots: [], tasks: [] }],
        deliver: async (sessionId, body) => { calls.push({ op: 'deliver', sessionId, body }); return { delivered: true } },
        issues: {
            list: async (params) => { calls.push({ op: 'issues.list', params }); return { issues: [issue()], nextCursor: null } },
            get: async (ref) => { calls.push({ op: 'issues.get', ref }); return { issue: issue() } },
            create: async (input) => { calls.push({ op: 'issues.create', input }); return { issue: issue({ title: input.title, status: 'todo' }), runs: input.assignee?.kind === 'agent' ? [{ seq: 1, agent: input.assignee.agent }] : [] } },
            update: async (id, input) => { calls.push({ op: 'issues.update', id, input }); return { issue: issue({ assignee: input.assignee }), runs: [{ seq: 2, agent: input.assignee.agent }] } },
            comment: async (id, input) => { calls.push({ op: 'issues.comment', id, input }); return { issue: issue() } },
        },
        projects: {
            list: async () => ({ projects: [{ id: 'p1', name: 'VH', goal: 'ship', teamIds: ['team-1'], archivedAt: null, folders: [{ machineId: 'm1', path: '/repo/vh' }, { machineId: 'm2', path: '/other' }] }, { id: 'p2', name: 'old', goal: null, teamIds: [], archivedAt: 1 }] }),
            get: async (projectId) => { calls.push({ op: 'projects.get', projectId }); return projectDetail() },
            note: async (projectId, input) => { calls.push({ op: 'projects.note', projectId, input }); return { entry: { seq: 71, supersedes: null } } },
        },
        todo: async (command) => {
            calls.push({ op: 'todo', command })
            if (command.action === 'list') return { records: [{ id: 'u1', key: 'VH-3', title: 'Buy milk', status: 'open', version: 4 }, { id: 'u2', title: 'Old', status: 'done', version: 1 }] }
            if (command.action === 'get') return { id: 'u1', key: 'VH-3', title: 'Buy milk', status: 'open', version: 4 }
            if (command.action === 'add') return { id: command.id, key: 'VH-9', title: command.title, status: 'open', version: 1 }
            return { id: command.id, key: 'VH-3', status: 'done', version: (command.version ?? 0) + 1 }
        },
        machineId: async () => 'machine-1',
        sessionId: () => 'main-agent-session',
    }
    return Object.assign({ ...base, ...over }, { calls })
}

function projectDetail(): ProjectDetailResponse {
    const entry = (seq: number, kind: string, title: string, extra: Record<string, unknown> = {}) => ({ id: `e${seq}`, seq, projectId: 'p1', kind, title, body: '', authorSessionId: null, authorUser: true, supersedes: null, supersededBy: null, revokedAt: null, createdAt: seq, ...extra })
    return {
        project: { id: 'p1', name: 'VH', goal: 'ship fast', instructions: 'Read AGENTS.md', instructionsVersion: 2, folders: [{ machineId: 'm1', path: '/repo' }, { machineId: 'm2', path: '/srv' }] } as any,
        members: [], presence: [],
        log: [
            entry(1, 'decision', 'use pnpm'),
            entry(2, 'decision', 'old rule', { supersededBy: 'e3' }),
            entry(3, 'decision', 'new rule'),
            ...Array.from({ length: 12 }, (_, i) => entry(10 + i, 'finding', `finding ${10 + i}`)),
        ] as any,
    }
}

const run = async (d: MainAgentDeps, name: string, args: any = {}) => {
    const { tools, server } = recorder()
    registerMainAgentTools(server, d)
    const handler = tools.get(name)
    if (!handler) throw new Error(`not registered: ${name}`)
    return handler(args)
}

afterEach(() => { installSessionLifecycle(null) })

describe('registerMainAgentTools', () => {
    it('registers exactly the main agent tool names', () => {
        const { tools, server } = recorder()
        registerMainAgentTools(server, deps())
        expect([...tools.keys()]).toEqual([...MAIN_AGENT_TOOL_NAMES])
    })
})

describe('teams / Lead dispatch', () => {
    it('teamLead prefers an active root bot and never a member', () => {
        expect(teamLead({ id: 't', name: 'n', bots: [{ id: 'm', name: 'M', root: false, sessionId: 's', activity: 'active' }] })).toBeNull()
        expect(teamLead({ id: 't', name: 'n', bots: [{ id: 'r', name: 'R', root: true, sessionId: 's1', activity: 'inactive' }] })).toEqual({ id: 'r', name: 'R', sessionId: 's1' })
    })

    it('teams_list leaves archived teams out and names the Lead session', async () => {
        const r = text(await run(deps(), 'teams_list'))
        expect(r).toContain('team-1 "Dev" lead=Lead bot=lead session=sess-lead open=1 project=p1')
        expect(r).not.toContain('team-2')
    })

    it('lead_delegate delivers the goal and acceptance into the Lead\'s session, never a member\'s', async () => {
        const d = deps()
        const r = await run(d, 'lead_delegate', { teamId: 'team-1', goal: 'Ship B-1', acceptance: ['tests green', 'PR open'], risk: 'none' })
        expect(r.isError).toBe(false)
        expect(JSON.parse(text(r))).toEqual({ ok: true, as: 'owner', via: 'main-agent', teamId: 'team-1', team: 'Dev', lead: 'Lead', leadSessionId: 'sess-lead', state: 'delivered' })
        const delivered = d.calls.filter(c => c.op === 'deliver')
        expect(delivered).toHaveLength(1)
        expect(delivered[0].sessionId).toBe('sess-lead')
        expect(delivered[0].body).toBe(leadDelegationText({ goal: 'Ship B-1', acceptance: ['tests green', 'PR open'] }))
        expect(delivered[0].body).toContain('team_delegate')
    })

    it('lead_delegate refuses an unknown or archived team and a team without a Lead session', async () => {
        expect((await run(deps(), 'lead_delegate', { teamId: 'nope', goal: 'g', acceptance: ['a'] })).isError).toBe(true)
        expect((await run(deps(), 'lead_delegate', { teamId: 'team-2', goal: 'g', acceptance: ['a'] })).isError).toBe(true)
        const noLead = deps({ listTeams: async () => [{ id: 'team-3', name: 'x', bots: [{ id: 'm', name: 'M', root: false, sessionId: 's', activity: 'active' }] }] })
        expect(JSON.parse(text(await run(noLead, 'lead_delegate', { teamId: 'team-3', goal: 'g', acceptance: ['a'] })))).toMatchObject({ ok: false, error: 'lead_unreachable' })
        expect(noLead.calls.filter(c => c.op === 'deliver')).toEqual([])
        const offline = deps({ deliver: async () => ({ delivered: false, error: 'session is offline' }) })
        const r = await run(offline, 'lead_delegate', { teamId: 'team-1', goal: 'g', acceptance: ['a'] })
        expect(r.isError).toBe(true)
        expect(JSON.parse(text(r))).toEqual({ ok: false, error: 'lead_unreachable', detail: 'session is offline' })
    })

    it('lead_message delivers the body to the Lead, naming the task', async () => {
        const d = deps()
        const r = await run(d, 'lead_message', { teamId: 'team-1', body: 'Ship it today', taskId: 'task-9' })
        expect(JSON.parse(text(r))).toMatchObject({ ok: true, via: 'main-agent', leadSessionId: 'sess-lead' })
        expect(d.calls.find(c => c.op === 'deliver')).toEqual({ op: 'deliver', sessionId: 'sess-lead', body: '[Very Happy main agent → Lead] A message from the owner about task task-9:\nShip it today' })
    })
})

describe('Lead dispatch text', () => {
    it('names the main agent and keeps goal, acceptance and note verbatim', () => {
        const body = leadDelegationText({ goal: ' Ship B-1 ', acceptance: ['green'], note: 'owner asked' })
        expect(body.split('\n')).toEqual([
            expect.stringMatching(/^\[Very Happy main agent → Lead\] .*team_delegate/),
            'Goal: Ship B-1', 'Acceptance:', '- green', 'Note: owner asked',
        ])
    })
})

describe('issues', () => {
    it('issue_list defaults to open statuses and 20, and passes filters through', async () => {
        const d = deps()
        expect(text(await run(d, 'issue_list', {}))).toContain('VH-7')
        expect(d.calls[0].params).toEqual({ status: 'backlog,todo,in_progress,in_review,blocked', limit: 20 })
        await run(d, 'issue_list', { status: ['done'], projectId: 'p1', assignee: 'none', q: 'login', limit: 5 })
        expect(d.calls[1].params).toEqual({ status: 'done', projectId: 'p1', assigneeKind: 'none', q: 'login', limit: 5 })
    })

    it('issue_assign key=VH-N + codex assigns the agent on this machine and reports the run', async () => {
        const d = deps()
        const r = text(await run(d, 'issue_assign', { key: 'VH-7', assignee: { agent: 'codex' } }))
        expect(d.calls.find(c => c.op === 'issues.get').ref).toBe('VH-7')
        expect(d.calls.find(c => c.op === 'issues.update')).toEqual({ op: 'issues.update', id: 'iss-1', input: { assignee: { kind: 'agent', agent: 'codex', machineId: 'machine-1' } } })
        expect(r).toContain('run #2 queued on codex')
        expect(r.length).toBeLessThanOrEqual(400)
    })

    it('issue_assign takes issueId and the run options, and needs one of issueId / key', async () => {
        const d = deps()
        await run(d, 'issue_assign', { issueId: 'iss-1', assignee: { agent: 'claude', machineId: 'm2', directory: '/repo', model: 'opus' } })
        expect(d.calls.find(c => c.op === 'issues.update').input).toEqual({ assignee: { kind: 'agent', agent: 'claude', machineId: 'm2', directory: '/repo', model: 'opus' } })
        expect((await run(deps(), 'issue_assign', { assignee: { agent: 'pi' } })).isError).toBe(true)
        expect((await run(deps({ machineId: async () => null }), 'issue_assign', { key: 'VH-7', assignee: { agent: 'pi' } })).isError).toBe(true)
    })

    it('issue_create sends a requestId and starts unassigned', async () => {
        const d = deps()
        await run(d, 'issue_create', { title: ' Fix it ', projectId: 'p1', labels: ['cli'], requestId: 'r1' })
        expect(d.calls.find(c => c.op === 'issues.create').input).toEqual({ title: 'Fix it', requestId: 'r1', projectId: 'p1', labels: ['cli'] })
    })

    it('issue_comment needs an issue on the main agent', async () => {
        expect((await run(deps(), 'issue_comment', { body: 'hi' })).isError).toBe(true)
        const d = deps()
        expect(text(await run(d, 'issue_comment', { issue: 'VH-7', body: 'hi' }))).toBe('commented on VH-7')
    })
})

describe('todos', () => {
    it('todo_list lists open first with key and version', async () => {
        expect(text(await run(deps(), 'todo_list'))).toBe('1 open, 1 done:\nVH-3 [open] Buy milk v4 id=u1\nu2 [done] Old v1')
    })

    it('todo_add uses the given UUID (retry-safe) or a fresh one', async () => {
        const d = deps()
        const id = '0b7e2b8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
        expect(text(await run(d, 'todo_add', { title: 'Call Bob', requestId: id }))).toBe('added todo VH-9 "Call Bob" v1')
        expect(d.calls[0].command).toEqual({ action: 'add', id, title: 'Call Bob' })
        await run(d, 'todo_add', { title: 'x' })
        expect(d.calls[1].command.id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('todo_complete reads the current version when none is given', async () => {
        const d = deps()
        expect(text(await run(d, 'todo_complete', { id: 'VH-3' }))).toBe('todo VH-3 is done v5')
        expect(d.calls.map(c => c.command)).toEqual([{ action: 'get', id: 'VH-3' }, { action: 'complete', id: 'VH-3', version: 4 }])
    })
})

describe('projects by projectId', () => {
    it('project_list leaves archived projects out', async () => {
        const r = text(await run(deps(), 'project_list'))
        expect(r).toContain('p1 "VH" folder=m1:/repo/vh ship teams=1')
        expect(r).not.toContain('p2')
    })

    it('project_context(projectId) shows instructions, decisions in effect and the last 10 entries', async () => {
        const r = text(await run(deps(), 'project_context', { projectId: 'p1' }))
        expect(r).toContain('Project "VH"')
        expect(r).toContain('Read AGENTS.md')
        expect(r).toContain('#1 use pnpm')
        expect(r).toContain('#3 new rule')
        expect(r).not.toMatch(/Decisions in effect:[^]*#2 old rule[^]*Log/)
        expect(r).toContain('finding 21')
        expect(r).toContain('Folders (machineId:path): m1:/repo, m2:/srv')
        expect(r).not.toContain('finding 11')
        const ctx = detailAsContext(projectDetail(), true)
        expect(ctx.log).toHaveLength(15)
    })

    it('project_note(projectId) writes in the main agent\'s own name', async () => {
        const d = deps()
        expect(text(await run(d, 'project_note', { projectId: 'p1', kind: 'finding', title: 'Lead idle', body: 'details' }))).toBe('recorded #71')
        expect(d.calls[0]).toEqual({ op: 'projects.note', projectId: 'p1', input: { kind: 'finding', title: 'Lead idle', authorSessionId: 'main-agent-session', body: 'details' } })
    })

    it('project_note answers project_not_member on a server that refuses the main agent — never retries as the owner', async () => {
        const calls: any[] = []
        const refusing = deps({ projects: { ...deps().projects, note: async (projectId, input) => { calls.push(input); throw Object.assign(new Error('Project request failed'), { code: 'not_a_project_member' }) } } })
        const r = await run(refusing, 'project_note', { projectId: 'p1', kind: 'finding', title: 't' })
        expect(JSON.parse(text(r))).toMatchObject({ ok: false, error: 'project_not_member' })
        expect(calls).toHaveLength(1)
        expect(calls[0].authorSessionId).toBe('main-agent-session')
        const failing = deps({ projects: { ...deps().projects, note: async () => { throw Object.assign(new Error('quota'), { code: 'project_note_quota_exceeded' }) } } })
        expect((await run(failing, 'project_note', { projectId: 'p1', kind: 'finding', title: 't' })).isError).toBe(true)
    })
})

describe('lifecycle adapters', () => {
    it('B-919: not installed → every lifecycle tool answers not_available (no guard-free restart fallback)', async () => {
        const d = deps()
        expect(JSON.parse(text(await run(d, 'session_wrapup', { sessionId: 'abc' })))).toMatchObject({ ok: false, error: 'not_available' })
        expect(JSON.parse(text(await run(d, 'session_handoff', { from: 'abc' })))).toMatchObject({ ok: false, error: 'not_available' })
        expect(JSON.parse(text(await run(d, 'session_restart', { sessionId: 'abc' })))).toMatchObject({ ok: false, error: 'not_available' })
        expect(JSON.parse(text(await run(d, 'session_restart', { sessionId: 'abc', when: 'now' })))).toMatchObject({ ok: false, error: 'not_available' })
        expect(d.calls).toEqual([])
    })

    it('B-919: installed → forward to the backends with a requestId; a refusal is a tool error with the short receipt', async () => {
        const wrapup = vi.fn(async (input: any) => ({ ok: true as const, sessionId: input.sessionId, state: 'queued' as const }))
        const handoff = vi.fn(async (input: any) => ({ ok: true as const, from: input.from, to: 'new-sess', state: 'queued' as const }))
        const restart = vi.fn(async (input: any) => ({ ok: true as const, sessionId: input.sessionId, scheduled: input.when, targetVersion: '0.2.300' }))
        installSessionLifecycle({ wrapup, handoff })
        installSessionLifecycle({ restart })
        const d = deps()
        const r = await run(d, 'session_wrapup', { sessionId: 'abc', requestId: 'r1' })
        expect(r.isError).toBe(false)
        expect(JSON.parse(text(r))).toEqual({ ok: true, sessionId: 'abc', state: 'queued' })
        expect(wrapup).toHaveBeenCalledWith({ sessionId: 'abc', requestId: 'r1' })
        await run(d, 'session_handoff', { from: 'abc', note: 'n' })
        expect(handoff.mock.calls[0][0]).toMatchObject({ from: 'abc', to: 'new', note: 'n' })
        expect(handoff.mock.calls[0][0].requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(JSON.parse(text(await run(d, 'session_restart', { sessionId: 'abc' })))).toEqual({ ok: true, sessionId: 'abc', scheduled: 'idle', targetVersion: '0.2.300' })
        expect(restart.mock.calls[0][0]).toMatchObject({ sessionId: 'abc', when: 'idle' })
        expect(d.calls).toEqual([])

        installSessionLifecycle({ wrapup: async () => ({ ok: false as const, sessionId: 'abc', error: 'Session abc is archived' }) })
        const refused = await run(d, 'session_wrapup', { sessionId: 'abc' })
        expect(refused.isError).toBe(true)
        expect(JSON.parse(text(refused))).toEqual({ ok: false, sessionId: 'abc', error: 'Session abc is archived' })
    })

    it('B-919: the descriptions say owner-only, one named session, never on a schedule', async () => {
        const descriptions = new Map<string, string>()
        registerMainAgentTools({ registerTool: ((name: string, config: any) => { descriptions.set(name, config.description) }) } as never, deps())
        for (const name of ['session_wrapup', 'session_handoff', 'session_restart']) {
            expect(descriptions.get(name)).toContain('Only when the owner explicitly asks for it')
            expect(descriptions.get(name)).toContain('never on your own initiative, on a schedule, or in batches')
        }
        expect(descriptions.get('session_restart')).toContain('a busy session is refused, never interrupted')
    })

    it('reject malformed session ids before any backend', async () => {
        expect((await run(deps(), 'session_wrapup', { sessionId: '../x' })).isError).toBe(true)
        expect((await run(deps(), 'session_handoff', { from: 'abc', to: 'a b' })).isError).toBe(true)
    })
})
