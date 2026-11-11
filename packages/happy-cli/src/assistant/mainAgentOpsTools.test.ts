import { describe, expect, it } from 'vitest'
import type { AttentionItem } from '@slopus/happy-wire'
import type { AssistantToolRegistrar } from './assistantTools'
import { registerMainAgentOpsTools, sessionMatches, tickedSessions, wrapupCardRefusal, type MainAgentOpsDeps, type SearchSession } from './mainAgentOpsTools'
import { installSessionLifecycle, registerMainAgentTools, type MainAgentDeps } from './mainAgentTools'
import { withToolOutputCaps, MAIN_AGENT_CAP_RULES } from './toolCaps'
import { classifyTurnSource } from './turnSource'

type Handler = (args: any) => Promise<any>
function recorder() {
    const tools = new Map<string, Handler>()
    const server = { registerTool: ((name: string, _config: unknown, handler: Handler) => { tools.set(name, handler); return {} as never }) } as unknown as AssistantToolRegistrar
    return { tools, server }
}
const text = (r: any) => r.content[0].text as string
const SELF = 'main-agent-session'

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
    id: 'card-1', sessionId: SELF, teamId: null, projectId: null, source: 'agent', kind: 'decision', key: 'main-agent-wrapup:2026-11-11T23:30',
    title: '可以收尾的会话（3 个）', bodyMd: null, options: [{ id: 'wrapup', label: '收尾所选' }, { id: 'skip', label: '这次不用' }], links: null, anchor: null, firstReply: null,
    replyToId: null, inferred: false, needsOwner: true, state: 'resolved', ownerChoice: 'wrapup', ownerNote: null, resolvedBy: 'owner', resolveNote: null,
    repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: 2, pushedAt: null, version: 3,
    payload: { v: 1, type: 'select', items: [
        { id: 's1', label: 'A', ref: 'sess-a', checked: false },
        { id: 's2', label: 'B', ref: 'sess-b', checked: true },
        { id: 's3', label: 'C', ref: 'sess-c', checked: false },
    ] },
    ...over,
})

function opsDeps(over: Partial<Omit<MainAgentOpsDeps, 'sessions'>> & { items?: AttentionItem[]; sessions?: SearchSession[] } = {}) {
    const calls: any[] = []
    const { items: givenItems, sessions: givenSessions, ...rest } = over
    const items = givenItems ?? []
    const deps: MainAgentOpsDeps = {
        sessionId: () => SELF,
        now: () => 10 * 3_600_000,
        board: {
            list: async (query) => { calls.push({ op: 'board.list', query }); return { items: query.sessionId ? items.filter(i => i.sessionId === query.sessionId) : items } },
            post: async (input) => { calls.push({ op: 'board.post', input }); return { item: item({ id: 'new-card', key: input.key ?? null, state: 'open', ownerChoice: null, resolvedBy: null, payload: input.payload }), created: true } },
            resolve: async (id, input) => { calls.push({ op: 'board.resolve', id, input }); return { item: item({ id }) } },
        },
        listTeams: async () => [
            { id: 'team-1', name: 'Dev', bots: [{ id: 'lead', name: 'Lead', root: true, sessionId: 'sess-lead' }] },
            { id: 'team-2', name: 'Gone', archivedAt: 5, bots: [] },
        ],
        sessions: async () => givenSessions ?? [],
        projectSessionIds: async () => ['s-in-project'],
        wrapup: () => async (input) => { calls.push({ op: 'wrapup', ...input }); return { ok: true, sessionId: input.sessionId, state: 'queued' } },
        ...rest,
    }
    const { tools, server } = recorder()
    registerMainAgentOpsTools(server, deps)
    return { tools, calls }
}

describe('B-924 wrapup_selected: nothing is wrapped up unless the owner ticked it and chose 收尾所选', () => {
    it.each([
        ['open card', { state: 'open', resolvedBy: null, ownerChoice: null }, 'owner_has_not_chosen'],
        ['owner chose 这次不用', { ownerChoice: 'skip' }, 'owner_chose_not_to'],
        ['closed by the agent', { resolvedBy: 'lead' }, 'owner_has_not_chosen'],
        ['superseded', { state: 'dismissed', resolvedBy: 'lead', ownerChoice: null }, 'owner_has_not_chosen'],
        ['another session\'s card', { sessionId: 'someone-else' }, 'card_not_found'],
        ['not a wrap-up key (e.g. a dispatch card)', { key: 'main-agent-dispatch:abc' }, 'not_a_wrapup_card'],
        ['no checklist', { payload: null }, 'not_a_checklist'],
        ['a wrap-up card of a session (kind wrapup)', { kind: 'wrapup' }, 'not_a_wrapup_card'],
    ] as const)('refuses: %s', async (_label, over, error) => {
        const { tools, calls } = opsDeps({ items: [item(over as Partial<AttentionItem>)] })
        const result = await tools.get('wrapup_selected')!({ boardItemId: 'card-1' })
        expect(result.isError).toBe(true)
        expect(JSON.parse(text(result))).toMatchObject({ ok: false, error })
        expect(calls.filter(c => c.op === 'wrapup')).toEqual([])
    })

    it('unknown card id: refused, nothing called', async () => {
        const { tools, calls } = opsDeps({ items: [item()] })
        expect(JSON.parse(text(await tools.get('wrapup_selected')!({ boardItemId: 'nope' })))).toMatchObject({ error: 'card_not_found' })
        expect(calls.some(c => c.op === 'wrapup')).toBe(false)
    })

    it('wraps up exactly the ticked session (1 of 3), once per (card, session)', async () => {
        const { tools, calls } = opsDeps({ items: [item()] })
        const result = await tools.get('wrapup_selected')!({ boardItemId: 'card-1' })
        expect(result.isError).toBe(false)
        expect(JSON.parse(text(result))).toMatchObject({ ok: true, boardItemId: 'card-1', queued: 1 })
        expect(calls.filter(c => c.op === 'wrapup')).toEqual([{ op: 'wrapup', sessionId: 'sess-b', requestId: 'card-1:sess-b' }])
    })

    it('none ticked: nothing wrapped up', async () => {
        const none = item({ payload: { v: 1, type: 'select', items: [{ id: 's1', label: 'A', ref: 'sess-a', checked: false }] } })
        const { tools, calls } = opsDeps({ items: [none] })
        expect(JSON.parse(text(await tools.get('wrapup_selected')!({ boardItemId: 'card-1' })))).toMatchObject({ ok: true, queued: 0 })
        expect(calls.some(c => c.op === 'wrapup')).toBe(false)
    })

    it('no backend: not_available, nothing called', async () => {
        const { tools } = opsDeps({ items: [item()], wrapup: () => undefined })
        expect(JSON.parse(text(await tools.get('wrapup_selected')!({ boardItemId: 'card-1' })))).toMatchObject({ error: 'not_available' })
    })

    it('pure helpers agree', () => {
        expect(wrapupCardRefusal(item(), SELF)).toBeNull()
        expect(tickedSessions(item())).toEqual(['sess-b'])
        expect(tickedSessions(item({ payload: { v: 1, type: 'select', items: [{ id: 's1', label: 'x', ref: 'bad id!', checked: true }] } }))).toEqual([])
    })
})

describe('B-924 wrapup_suggest only posts a card', () => {
    it('posts one unticked checklist under the wrap-up key, supersedes the older open one, wraps nothing up', async () => {
        const older = item({ id: 'old-card', state: 'open', resolvedBy: null, ownerChoice: null })
        const { tools, calls } = opsDeps({ items: [older] })
        const result = await tools.get('wrapup_suggest')!({ sessions: [
            { sessionId: 'sess-a', title: 'Fix login', reason: 'merged yesterday' },
            { sessionId: SELF, reason: 'never the main agent itself' },
            { sessionId: 'sess-a', reason: 'duplicate' },
            { sessionId: 'sess-b', reason: 'idle 2 days' },
        ], requestId: 'run-7' })
        expect(JSON.parse(text(result))).toMatchObject({ ok: true, boardItemId: 'new-card', state: 'awaiting_owner' })
        const post = calls.find(c => c.op === 'board.post').input
        expect(post).toMatchObject({ sessionId: SELF, kind: 'decision', key: 'main-agent-wrapup:run-7', options: [{ id: 'wrapup' }, { id: 'skip' }] })
        expect(post.payload.items).toEqual([
            { id: 's1', label: 'Fix login', detail: 'merged yesterday', ref: 'sess-a', checked: false },
            { id: 's2', label: 'sess-b', detail: 'idle 2 days', ref: 'sess-b', checked: false },
        ])
        expect(calls.filter(c => c.op === 'board.resolve').map(c => [c.id, c.input.outcome])).toEqual([['old-card', 'superseded']])
        expect(calls.some(c => c.op === 'wrapup')).toBe(false)
    })
})

describe('B-924 boards_read / sessions_search are capped, read-only lists', () => {
    const boardItem = (i: number, teamId: string | null, needsOwner = false) => item({ id: `it-${i}`, sessionId: `lead-${teamId}`, teamId, kind: needsOwner ? 'decision' : 'report', title: `Item ${i} ${'x'.repeat(300)}`, needsOwner, state: 'open', updatedAt: 9 * 3_600_000, key: null, payload: null })

    it('groups open items by live team (newest perTeam), the rest under other; fits the 4K list cap', async () => {
        const items = [...Array.from({ length: 40 }, (_, i) => boardItem(i, 'team-1', i % 3 === 0)), boardItem(99, null), boardItem(98, 'team-2')]
        const { tools } = opsDeps({ items })
        const out = text(await tools.get('boards_read')!({}))
        expect(out).toContain('## Dev (team-1) lead=Lead: 40 open, newest 10')
        expect(out.split('\n').filter(l => l.startsWith('- ')).length).toBe(12)
        expect(out).toContain('## other: 2 open')
        const capped = recorder()
        registerMainAgentOpsTools(withToolOutputCaps(capped.server), {
            sessionId: () => SELF, now: () => 10 * 3_600_000,
            board: { list: async () => ({ items }), post: async () => { throw new Error('x') }, resolve: async () => { throw new Error('x') } },
            listTeams: async () => [{ id: 'team-1', name: 'Dev' }], sessions: async () => [], projectSessionIds: async () => [], wrapup: () => undefined,
        })
        const big = text(await capped.tools.get('boards_read')!({ perTeam: 25 }))
        expect(big.length).toBeLessThanOrEqual(4_000 + 200)
        expect(MAIN_AGENT_CAP_RULES.boards_read).toBe('list')
    })

    it('boards_read teamId filters; an unknown team is an error', async () => {
        const { tools, calls } = opsDeps({ items: [boardItem(1, 'team-1', true)] })
        expect(text(await tools.get('boards_read')!({ teamId: 'team-1', needsOwner: true }))).toContain('[decision·owner]')
        expect(calls.find(c => c.op === 'board.list').query).toMatchObject({ state: 'open', needsOwner: 'true' })
        expect((await tools.get('boards_read')!({ teamId: 'nope' })).isError).toBe(true)
    })

    const s = (id: string, over: Partial<SearchSession> = {}): SearchSession => ({ id, title: `T ${id}`, cwd: `/repo/${id}`, flavor: 'claude', archived: false, active: false, attention: false, readable: true, updatedAt: 1, ...over })
    it('sessions_search filters by project, state, flavor and text; never lists the main agent', async () => {
        const sessions = [
            s('s-in-project', { active: true, updatedAt: 5 }), s('s-err', { turnFailure: { at: 1, summary: 'API Error 529', provider: 'claude', status: 529 } as any }),
            s('s-ask', { attention: true }), s('s-arch', { archived: true }), s(SELF, { active: true }), s('s-codex', { flavor: 'codex', title: 'Release notes' }),
        ]
        const { tools } = opsDeps({ sessions })
        const ids = async (args: any) => text(await tools.get('sessions_search')!(args)).split('\n').slice(1).map(l => l.split(' ')[0])
        expect(await ids({ projectId: 'p1' })).toEqual(['s-in-project'])
        expect(await ids({ state: 'api_error' })).toEqual(['s-err'])
        expect(await ids({ state: 'needs_owner' })).toEqual(['s-ask'])
        expect(await ids({ state: 'archived' })).toEqual(['s-arch'])
        expect(await ids({ state: 'active' })).toEqual(['s-in-project'])
        expect(await ids({ flavor: 'codex' })).toEqual(['s-codex'])
        expect(await ids({ q: 'release' })).toEqual(['s-codex'])
        expect((await ids({ limit: 2 })).length).toBe(2)
        expect(sessionMatches(s('x', { archived: true }), {})).toBe(false)
    })
})

describe('B-924 session_wrapup / session_handoff refuse a turn an automation started', () => {
    it('automation turn: owner_request_required, the backend is never called; an owner turn goes through', async () => {
        const called: string[] = []
        installSessionLifecycle({
            wrapup: async (input) => { called.push(`wrapup:${input.sessionId}`); return { ok: true, sessionId: input.sessionId, state: 'queued' } },
            handoff: async (input) => { called.push(`handoff:${input.from}`); return { ok: true, from: input.from, to: 'x', state: 'queued' } },
        })
        let source: 'owner' | 'automation' | 'unknown' = 'automation'
        const { tools, server } = recorder()
        registerMainAgentTools(server, { sessionId: () => SELF, turnSource: () => source } as unknown as MainAgentDeps)
        for (const [name, args] of [['session_wrapup', { sessionId: 'sess-a' }], ['session_handoff', { from: 'sess-a', to: 'sess-b' }]] as const) {
            const r = await tools.get(name)!(args)
            expect(r.isError).toBe(true)
            expect(JSON.parse(text(r))).toMatchObject({ ok: false, error: 'owner_request_required' })
        }
        expect(called).toEqual([])
        source = 'owner'
        expect((await tools.get('session_wrapup')!({ sessionId: 'sess-a' })).isError).toBe(false)
        expect(called).toEqual(['wrapup:sess-a'])
        installSessionLifecycle(null)
    })

    it('classifies a turn by its prompts\' localIds', () => {
        expect(classifyTurnSource(['automation-run1'])).toBe('automation')
        expect(classifyTurnSource(['automation-run1', 'automation-run2'])).toBe('automation')
        expect(classifyTurnSource(['automation-run1', 'board-card-1-abc'])).toBe('owner')
        expect(classifyTurnSource(['u-123'])).toBe('owner')
        expect(classifyTurnSource([])).toBe('unknown')
    })
})
