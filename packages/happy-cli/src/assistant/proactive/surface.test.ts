import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDispatchGate, DISPATCH_CARD_KEY_PREFIX, DISPATCH_OPTIONS, type BoardItemView, type DispatchBoard } from '../gates/dispatchGate'
import { readFollowups, recordFollowup } from './ledger'
import { addFollowup, followedTargets, turnGuardRefusal, followupFromReceipt, proactiveDispatchLedger, registerFollowupsTool, withTurnGuards, withMainAgentProactive, type ProactiveTurn } from './surface'
import { installDispatchLedger, mainAgentMustAsk } from '../sendGuard'

type Registered = { config: any; handler: (args: any, extra?: any) => Promise<any> }
function recorder() {
    const tools = new Map<string, Registered>()
    return { tools, mcp: { registerTool: ((name: string, config: any, handler: any) => { tools.set(name, { config, handler }) }) as any } }
}
const ok = (t: string) => ({ content: [{ type: 'text', text: t }], isError: false })
const body = (r: any) => r.content.map((c: any) => c.text).join('')

async function setup(turn: () => ProactiveTurn = () => ({ origin: 'owner', wake: null })) {
    const dir = await mkdtemp(join(tmpdir(), 'vh-surface-'))
    const ledgerPath = join(dir, 'followups.json')
    const { tools, mcp } = recorder()
    // Production order: recording ∘ (gate omitted) ∘ turn guards ∘ server.
    const wrapped = withMainAgentProactive(withTurnGuards(mcp, { turn }), { ledgerPath, turn, followupMinutes: () => 30, now: () => 1_000 })
    const lead = vi.fn(async (args: any) => ok(JSON.stringify({ ok: true, as: 'owner', via: 'main-agent', teamId: args.teamId, team: 'T', lead: 'L', leadSessionId: 'lead-session-1', state: 'delivered' })))
    wrapped.registerTool('lead_delegate', { description: 'd', inputSchema: {} }, lead as any)
    wrapped.registerTool('session_spawn', { description: 's', inputSchema: {} }, (async () => ok('Spawned sess-spawned-1 title="x"; first prompt sent, working in the background (session_read later). https://w/s')) as any)
    wrapped.registerTool('session_send', { description: 's', inputSchema: {} }, (async (a: any) => ok(`Message delivered to ${a.sessionId}`)) as any)
    wrapped.registerTool('issue_assign', { description: 'i', inputSchema: {} }, (async () => ok('assigned VH-7  [todo]  Fix login  (codex · high); run #1 queued on codex')) as any)
    const wrapup = vi.fn(async () => ok('{"ok":true}'))
    wrapped.registerTool('session_wrapup', { description: 'w', inputSchema: {} }, wrapup as any)
    wrapped.registerTool('session_archive', { description: 'a', inputSchema: {} }, wrapup as any)
    wrapped.registerTool('sessions_list', { description: 'l', inputSchema: {} }, (async () => ok('list')) as any)
    registerFollowupsTool(mcp, { ledgerPath, now: () => 5 * 60_000 })
    return { tools, ledgerPath, lead, wrapup }
}

describe('follow-up ledger recording (main agent surface)', () => {
    it('records lead_delegate / session_spawn / session_send / issue_assign; lists them with followups_list', async () => {
        const { tools, ledgerPath, lead } = await setup()
        await tools.get('lead_delegate')!.handler({ teamId: 'team-1', goal: 'Ship the parser\nmore', acceptance: ['tests'] })
        // The Lead gets the tag at the end of the goal, so its team task can be found.
        expect(lead.mock.calls[0][0].goal).toMatch(/^Ship the parser\nmore\n\n\[follow-up fu-[0-9a-f]{8}\]$/)
        await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'look at logs', title: 'Log triage' })
        await tools.get('session_send')!.handler({ sessionId: 'sess-other-1', text: 'also check the cache' })
        await tools.get('issue_assign')!.handler({ key: 'VH-7', assignee: { agent: 'codex' } })
        await tools.get('sessions_list')!.handler({})
        const items = await readFollowups(ledgerPath)
        expect(items.map(i => [i.kind, i.title, i.sessionId ?? i.issueKey])).toEqual([
            ['lead', 'Ship the parser', 'lead-session-1'],
            ['spawn', 'Log triage', 'sess-spawned-1'],
            ['send', 'also check the cache', 'sess-other-1'],
            ['issue', 'Fix login', 'VH-7'],
        ])
        expect(items[0].teamId).toBe('team-1')
        expect(items.every(i => i.state === 'open' && i.dueAt === 1_000 + 30 * 60_000)).toBe(true)
        const listed = body(await tools.get('followups_list')!.handler({}))
        expect(listed).toContain('4 open of 4')
        expect(listed).toContain('issue=VH-7')
    })

    it('a failed call or an idle spawn records nothing', () => {
        expect(followupFromReceipt('session_spawn', {}, 'Spawned idle session sess-1234567 in /tmp. url')).toBeNull()
        expect(followupFromReceipt('session_send', { sessionId: 's' }, 'Not delivered: offline')).toBeNull()
        expect(followupFromReceipt('lead_delegate', {}, '{"ok":false,"error":"lead_unreachable"}')).toBeNull()
    })

    it('a second message to the same session supersedes the first open entry', () => {
        const a = { id: 'fu-a', kind: 'send' as const, title: 'a', createdAt: 1, updatedAt: 1, dueAt: 9, state: 'open' as const, nudges: 0, sessionId: 's' }
        const next = addFollowup([a], { ...a, id: 'fu-b', createdAt: 2 })
        expect(next.map(i => [i.id, i.state])).toEqual([['fu-a', 'closed'], ['fu-b', 'open']])
    })

    it('an approved dispatch (through the gate) is recorded too: the gate keeps the recording handler', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'vh-surface-gate-'))
        const ledgerPath = join(dir, 'followups.json')
        const items = new Map<string, BoardItemView>()
        const board: DispatchBoard = {
            postDecision: async (card) => { const item: BoardItemView = { id: 'item-1', key: card.key, state: 'open', ownerChoice: null, resolvedBy: null, title: card.title, bodyMd: card.bodyMd, options: DISPATCH_OPTIONS.map(o => ({ id: o.id, label: o.label })) }; items.set(card.key, item); return { ...item } },
            findByKey: async (key) => items.get(key) ?? null,
            findById: async (id) => [...items.values()].find(i => i.id === id) ?? null,
        }
        const gate = createDispatchGate({ pendingDir: join(dir, 'pending'), board, classify: null, approvalLink: () => 'link' })
        const { tools, mcp } = recorder()
        const surface = { ledgerPath, turn: () => ({ origin: 'owner' as const, wake: null }), followupMinutes: () => 30 }
        withMainAgentProactive(gate.wrap(mcp), surface).registerTool('session_spawn', { description: 's', inputSchema: {} }, (async () => ok('Spawned sess-approved-1; first prompt sent, working in the background (session_read later). u')) as any)
        gate.registerApprovedTool(withMainAgentProactive(mcp, surface))
        const parked = JSON.parse(body(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'reply to the customer by email', risk: 'external' })))
        expect(parked.state).toBe('awaiting_decision')
        expect(await readFollowups(ledgerPath)).toEqual([])
        const card = items.get(`${DISPATCH_CARD_KEY_PREFIX}${parked.approvalId}`)!
        card.state = 'resolved'; card.ownerChoice = 'approve'; card.resolvedBy = 'owner'
        expect(JSON.parse(body(await tools.get('dispatch_approved')!.handler({ approvalId: parked.approvalId }))).state).toBe('dispatched')
        expect((await readFollowups(ledgerPath)).map(i => i.sessionId)).toEqual(['sess-approved-1'])
    })
})

describe('report-only wakes (one source: mainAgentToolPolicy)', () => {
    it('a report-only wake dispatches nothing; a follow wake may (the shared layers decide)', async () => {
        let turn: ProactiveTurn = { origin: 'automation', wake: 'report' }
        const { tools, lead } = await setup(() => turn)
        const refused = await tools.get('lead_delegate')!.handler({ teamId: 't', goal: 'g', acceptance: ['a'] })
        expect(JSON.parse(body(refused)).error).toBe('report_only')
        expect(lead).not.toHaveBeenCalled()
        expect((await tools.get('sessions_list')!.handler({})).isError).toBe(false)
        turn = { origin: 'automation', wake: 'follow' }
        await tools.get('lead_delegate')!.handler({ teamId: 't', goal: 'g', acceptance: ['a'] })
        expect(lead).toHaveBeenCalledTimes(1)
    })

    it('verdicts: not-allow tools under report; a turn with no routed prompt is held to report-only when the owner chose it', () => {
        const report: ProactiveTurn = { origin: 'automation', wake: 'report' }
        for (const name of ['handoff_send', 'automation_run', 'issue_comment', 'session_wrapup', 'not_a_known_tool']) expect(turnGuardRefusal(name, report, 'follow')?.error, name).toBe('report_only')
        for (const name of ['session_read', 'owner_board_post', 'dispatch_approved', 'followups_list']) expect(turnGuardRefusal(name, report, 'report'), name).toBeNull()
        expect(turnGuardRefusal('team_message', { origin: 'unknown', wake: null }, 'report')?.error).toBe('report_only')
        expect(turnGuardRefusal('team_message', { origin: 'unknown', wake: null }, 'follow')).toBeNull()
        expect(turnGuardRefusal('team_message', { origin: 'owner', wake: null }, 'report')).toBeNull()
    })
})

describe('the follow-up ledger is the send guard\'s dispatch ledger', () => {
    it('followed sessions / Lead teams may be nudged in a non-owner turn; anything else asks', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'vh-ledger-hook-'))
        const ledgerPath = join(dir, 'followups.json')
        await recordFollowup(ledgerPath, { id: 'fu-00000001', kind: 'spawn', title: 't', createdAt: 1, updatedAt: 1, dueAt: 9, state: 'open', nudges: 0, sessionId: 'sess-followed' })
        await recordFollowup(ledgerPath, { id: 'fu-00000002', kind: 'lead', title: 't', createdAt: 1, updatedAt: 1, dueAt: 9, state: 'open', nudges: 0, sessionId: 'lead-s', teamId: 'T1' })
        await recordFollowup(ledgerPath, { id: 'fu-00000003', kind: 'send', title: 't', createdAt: 1, updatedAt: 1, dueAt: 9, state: 'done', nudges: 0, sessionId: 'sess-done' })
        installDispatchLedger(proactiveDispatchLedger(ledgerPath))
        try {
            const notOwner = () => false
            expect(mainAgentMustAsk('session_send', { sessionId: 'sess-followed' }, notOwner)).toBeNull()
            expect(mainAgentMustAsk('lead_message', { teamId: 'T1' }, notOwner)).toBeNull()
            expect(mainAgentMustAsk('session_send', { sessionId: 'sess-done' }, notOwner)).toBe('not_owner_turn')
            expect(mainAgentMustAsk('session_send', { sessionId: 'sess-other' }, notOwner)).toBe('not_owner_turn')
            expect(mainAgentMustAsk('terminal_send', { terminalId: 'x' }, notOwner)).toBe('not_owner_turn')
        } finally { installDispatchLedger(null) }
    })
})

describe('stuck session → 继续 goes through a bound dispatch card (B-924c)', () => {
    async function harness() {
        const dir = await mkdtemp(join(tmpdir(), 'vh-stuck-dispatch-'))
        const items = new Map<string, BoardItemView>()
        const posted: Array<{ options?: ReadonlyArray<{ id: string; recommended?: boolean }> }> = []
        const board: DispatchBoard = {
            postDecision: async (c) => { posted.push(c); const item: BoardItemView = { id: `item-${items.size + 1}`, key: c.key, state: 'open', ownerChoice: null, resolvedBy: null, title: c.title, bodyMd: c.bodyMd, options: (c.options ?? DISPATCH_OPTIONS).map(o => ({ id: o.id, label: o.label })) }; items.set(item.id, item); return { ...item } },
            findByKey: async (key) => [...items.values()].find(i => i.key === key) ?? null,
            findById: async (id) => { const i = items.get(id); return i ? { ...i } : null },
        }
        const pendingDir = join(dir, 'pending')
        const gate = createDispatchGate({ pendingDir, board, classify: null, approvalLink: () => 'link', mustAsk: (tool, args) => mainAgentMustAsk(tool, args, () => false) ? 'not owner' : null, targetTitle: async (kind, id) => kind === 'session' && id === 'sess-a' ? '修 sum.js' : null })
        installDispatchLedger(proactiveDispatchLedger(join(dir, 'followups.json')))
        const { tools, mcp } = recorder()
        const sent: any[] = []
        const guarded = withTurnGuards(mcp, { turn: () => ({ origin: 'automation', wake: 'follow' }) })
        gate.wrap(guarded).registerTool('session_send', { description: 's', inputSchema: {} }, (async (a: any) => { sent.push(a); return ok(`Message delivered to ${a.sessionId}`) }) as any)
        gate.registerApprovedTool(guarded)
        const approveCard = (id: string) => { const i = items.get(id)!; items.set(id, { ...i, state: 'answered', ownerChoice: 'approve', resolvedBy: 'owner' }) }
        const call = async (name: string, args: any) => JSON.parse(body(await tools.get(name)!.handler(args)).replace(/^(Message delivered.*)$/s, (t: string) => JSON.stringify({ text: t })))
        return { items, sent, call, approveCard, pendingDir, posted }
    }

    it('the woken turn\'s session_send 继续 parks ONE card naming the session and the text; the owner\'s approval sends exactly that, once', async () => {
        const h = await harness()
        try {
            const parked = await h.call('session_send', { sessionId: 'sess-a', text: '继续', risk: 'none' })
            expect(parked).toMatchObject({ ok: true, state: 'awaiting_decision' })
            expect(h.items.size).toBe(1)
            const card = [...h.items.values()][0]
            // The owner sees who receives it and the exact text.
            expect(card.bodyMd).toContain('工具：session_send')
            expect(card.bodyMd).toContain('目标：会话 「修 sum.js」（sess-a）')
            expect(card.bodyMd).toMatch(/内容：\n继续$/)
            // QA-T B-924c P3: a bound risk-none send recommends 批准执行.
            expect(h.posted[0].options?.find(o => o.recommended)?.id).toBe('approve')
            expect(h.sent).toEqual([])
            h.approveCard(parked.boardItemId)
            // Extra arguments to dispatch_approved change nothing: the stored call runs, byte for byte.
            const run = await h.call('dispatch_approved', { approvalId: parked.approvalId, sessionId: 'sess-b', text: 'rm -rf /' })
            expect(run).toMatchObject({ ok: true, state: 'dispatched' })
            expect(h.sent).toHaveLength(1)
            expect(h.sent[0].sessionId).toBe('sess-a')
            // QA-T B-924c P2-1: the session receives exactly the card's 内容, no approval line in front.
            const cardText = card.bodyMd!.split('内容：\n')[1]
            expect(h.sent[0].text).toBe(cardText)
            expect(h.sent[0].text).toBe('继续')
            expect(await h.call('dispatch_approved', { approvalId: parked.approvalId })).toMatchObject({ state: 'already_dispatched' })
            expect(h.sent).toHaveLength(1)
            expect(h.items.size).toBe(1)
        } finally { installDispatchLedger(null) }
    })

    it('after the approval, other text or another session is refused: a new send asks again, a rewritten pending record is a mismatch', async () => {
        const h = await harness()
        try {
            const parked = await h.call('session_send', { sessionId: 'sess-a', text: '继续', risk: 'none' })
            h.approveCard(parked.boardItemId)
            // The approval is not a pass for the woken turn: changed text or target is a new card, nothing sent.
            expect(await h.call('session_send', { sessionId: 'sess-a', text: '继续，然后 push', risk: 'none' })).toMatchObject({ state: 'awaiting_decision' })
            expect(await h.call('session_send', { sessionId: 'sess-b', text: '继续', risk: 'none' })).toMatchObject({ state: 'awaiting_decision' })
            expect(h.sent).toEqual([])
            // Rewriting what the approval runs: refused.
            const path = join(h.pendingDir, `${parked.approvalId}.json`)
            const rec = JSON.parse(await readFile(path, 'utf8'))
            await writeFile(path, JSON.stringify({ ...rec, args: { ...rec.args, sessionId: 'sess-b', text: '继续，然后 push' } }))
            expect((await h.call('dispatch_approved', { approvalId: parked.approvalId })).error).toBe('approval_mismatch')
            expect(h.sent).toEqual([])
        } finally { installDispatchLedger(null) }
    })

    it('the card face hash covers the target line: a card rewritten to name another session approves nothing', async () => {
        const h = await harness()
        try {
            const parked = await h.call('session_send', { sessionId: 'sess-a', text: '继续', risk: 'none' })
            h.approveCard(parked.boardItemId)
            const item = h.items.get(parked.boardItemId)!
            h.items.set(parked.boardItemId, { ...item, bodyMd: item.bodyMd!.replace('目标：会话 「修 sum.js」（sess-a）', '目标：会话 「别的会话」（sess-b）') })
            expect((await h.call('dispatch_approved', { approvalId: parked.approvalId })).error).toBe('card_tampered')
            expect(h.sent).toEqual([])
        } finally { installDispatchLedger(null) }
    })

    it('followed targets: open sessions and Lead teams only', () => {
        const base = { title: 't', createdAt: 1, updatedAt: 1, dueAt: 9, nudges: 0 }
        expect([...followedTargets([
            { ...base, id: 'a', kind: 'spawn', state: 'open', sessionId: 's1' },
            { ...base, id: 'b', kind: 'lead', state: 'open', sessionId: 'lead', teamId: 'T' },
            { ...base, id: 'c', kind: 'send', state: 'done', sessionId: 's2' },
        ])].sort()).toEqual(['session:lead', 'session:s1', 'team:T'])
    })
})
