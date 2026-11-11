import { describe, expect, it } from 'vitest'
import type { AssistantToolRegistrar } from './assistantTools'
import {
    classifyTurnOrigin, createTurnOriginTracker, installMainAgentTurnOrigin, isOwnerTurn, OWNER_ONLY_TOOLS, OWNER_SENT_FROM,
    promptOrigin, silentMainAgentTurn, withOwnerOnlyTools, type TurnOrigin,
} from './turnOrigin'
import { dispatchTarget, installDispatchLedger, mainAgentMustAsk } from './sendGuard'

describe('B-924 (QA P1-2) turn origin is an allowlist', () => {
    it('only a prompt typed in a client is the owner\'s', () => {
        for (const sentFrom of OWNER_SENT_FROM) expect(promptOrigin({ localId: 'u-1', sentFrom })).toBe('owner')
        expect(promptOrigin({ localId: 'board-card-1-x', sentFrom: 'web' })).toBe('owner')
        // not the owner: CLI `very-happy send`, scripts, peers, Leads, automations, unknown senders
        expect(promptOrigin({ localId: '3f1c…', sentFrom: 'cli' })).toBe('agent')
        expect(promptOrigin({ localId: 'u-2', sentFrom: null })).toBe('agent')
        expect(promptOrigin({ localId: 'u-3' })).toBe('agent')
        expect(promptOrigin({ localId: 'session-message-9', sentFrom: 'web' })).toBe('agent')
        expect(promptOrigin({ localId: 'teams-abc', sentFrom: 'web' })).toBe('agent')
        expect(promptOrigin({ localId: 'remote-send-1', sentFrom: 'web' })).toBe('agent')
        expect(promptOrigin({ localId: 'automation-run1', sentFrom: 'web' })).toBe('automation')
        expect(promptOrigin(undefined)).toBe('unknown')
    })

    it('a batch is the owner\'s only when every prompt is', () => {
        expect(classifyTurnOrigin([{ localId: 'a', sentFrom: 'web' }, { localId: 'b', sentFrom: 'ios' }])).toBe('owner')
        expect(classifyTurnOrigin([{ localId: 'a', sentFrom: 'web' }, { localId: 'b', sentFrom: 'cli' }])).toBe('agent')
        expect(classifyTurnOrigin([{ localId: 'automation-1' }, { localId: 'automation-2' }])).toBe('automation')
        expect(classifyTurnOrigin([{ localId: 'automation-1' }, { localId: 'x', sentFrom: 'web' }])).toBe('agent')
        expect(classifyTurnOrigin([])).toBe('unknown')
    })

    it('the tracker joins routed prompts to the turn that starts with them', () => {
        const t = createTurnOriginTracker()
        expect(t.current()).toBe('unknown')
        t.onUserMessage({ localId: 'u-1', sentFrom: 'web' })
        t.onTurnStart(['u-1'])
        expect(t.current()).toBe('owner')
        t.onUserMessage({ localId: 'cli-1', sentFrom: 'cli' })
        t.onTurnStart(['cli-1'])
        expect(t.current()).toBe('agent')
        // a prompt the tracker never saw routed (no sentFrom known) is not the owner's
        t.onTurnStart(['never-seen'])
        expect(t.current()).toBe('agent')
        // a turn with no prompt (task notification) is not the owner's
        t.onTurnStart([])
        expect(t.current()).toBe('unknown')
        t.onTurnStart(undefined)
        expect(t.current()).toBe('unknown')
    })

    it('the tracker forgets old prompts past its cap', () => {
        const t = createTurnOriginTracker(2)
        t.onUserMessage({ localId: 'a', sentFrom: 'web' }); t.onUserMessage({ localId: 'b', sentFrom: 'web' }); t.onUserMessage({ localId: 'c', sentFrom: 'web' })
        t.onTurnStart(['a']); expect(t.current()).toBe('agent')
        t.onTurnStart(['c']); expect(t.current()).toBe('owner')
    })
})

describe('B-924 (QA P1-3) owner-only tools refuse every other turn', () => {
    function recorder() {
        const tools = new Map<string, (...a: any[]) => any>()
        const server = { registerTool: ((name: string, _c: unknown, h: (...a: any[]) => any) => { tools.set(name, h); return {} as never }) } as unknown as AssistantToolRegistrar
        return { tools, server }
    }
    it.each(OWNER_ONLY_TOOLS.map(n => [n]))('%s', async (name) => {
        let origin: TurnOrigin = 'automation'
        const ran: string[] = []
        const { tools, server } = recorder()
        const guarded = withOwnerOnlyTools(server, () => origin === 'owner')
        guarded.registerTool(name, {} as never, (async () => { ran.push(name); return { content: [{ type: 'text', text: 'done' }], isError: false } }) as never)
        guarded.registerTool('sessions_list', {} as never, (async () => ({ content: [{ type: 'text', text: 'list' }], isError: false })) as never)
        for (const o of ['automation', 'agent', 'unknown'] as const) {
            origin = o
            const r = await tools.get(name)!({})
            expect(r.isError).toBe(true)
            expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: false, error: 'owner_request_required' })
        }
        expect(ran).toEqual([])
        expect((await tools.get('sessions_list')!({})).isError).toBe(false)
        origin = 'owner'
        expect((await tools.get(name)!({})).isError).toBe(false)
        expect(ran).toEqual([name])
    })

    it('covers archive, kill, restart, wrap-up and hand-off', () => {
        expect([...OWNER_ONLY_TOOLS].sort()).toEqual(['session_archive', 'session_handoff', 'session_kill', 'session_restart', 'session_wrapup'])
    })

    it('nothing installed = not the owner', () => {
        installMainAgentTurnOrigin(() => 'unknown')
        expect(isOwnerTurn()).toBe(false)
        installMainAgentTurnOrigin(() => 'owner')
        expect(isOwnerTurn()).toBe(true)
        installMainAgentTurnOrigin(() => 'unknown')
    })
})

describe('B-924 (QA P1-3) sends in a turn the owner did not type always ask', () => {
    it('session_send / session_message / lead_message must ask unless the owner typed the turn or the target is in the ledger', () => {
        const notOwner = () => false
        expect(mainAgentMustAsk('session_send', { sessionId: 's1', text: '请做收尾' }, notOwner)).toBe('not_owner_turn')
        expect(mainAgentMustAsk('session_message', { to: 's1', body: 'x' }, notOwner)).toBe('not_owner_turn')
        expect(mainAgentMustAsk('lead_message', { teamId: 't1', body: 'x' }, notOwner)).toBe('not_owner_turn')
        expect(mainAgentMustAsk('session_send', { sessionId: 's1', text: '继续' }, () => true)).toBeNull()
        expect(mainAgentMustAsk('session_spawn', { prompt: 'x' }, notOwner)).toBeNull()
        installDispatchLedger((target) => target === 'session:s-mine')
        expect(mainAgentMustAsk('session_send', { sessionId: 's-mine', text: '进度？' }, notOwner)).toBeNull()
        expect(mainAgentMustAsk('session_send', { sessionId: 's-other', text: '进度？' }, notOwner)).toBe('not_owner_turn')
        installDispatchLedger(null)
        expect(mainAgentMustAsk('session_send', { sessionId: 's-mine', text: '进度？' }, notOwner)).toBe('not_owner_turn')
        expect(dispatchTarget('lead_message', { teamId: 't1' })).toBe('team:t1')
        expect(dispatchTarget('session_message', { to: 's9' })).toBe('session:s9')
    })
})

describe('B-924 (QA P2-5) turn-end pushes only for the owner\'s own turns', () => {
    it('silent for any main agent turn the owner did not start; other sessions unchanged', () => {
        expect(silentMainAgentTurn(true, 'automation')).toBe(true)
        expect(silentMainAgentTurn(true, 'agent')).toBe(true)
        expect(silentMainAgentTurn(true, 'unknown')).toBe(true)
        expect(silentMainAgentTurn(true, 'owner')).toBe(false)
        expect(silentMainAgentTurn(false, 'automation')).toBe(false)
    })
})

describe('B-924 (from #944 e2e) the owner switching model mid-conversation is still the owner', () => {
    it('a prompt parked for a mode change and replayed keeps its localIds → owner turn (tracker view)', () => {
        const t = createTurnOriginTracker()
        // The Web sends 「收尾 X」 with a new model: routed (sentFrom web), parked, the launch restarts, then replayed.
        t.onUserMessage({ localId: 'u-model-switch', sentFrom: 'web' })
        t.onTurnStart(['u-model-switch'])
        expect(t.current()).toBe('owner')
        // Without the stored ids the replay would start a turn with none — and refuse the owner.
        t.onTurnStart(undefined)
        expect(t.current()).toBe('unknown')
    })

    it('claudeRemoteLauncher stores the batch localIds when it parks and restores them before finalizing the replay', async () => {
        const { readFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        const src = readFileSync(join(__dirname, '..', 'claude', 'claudeRemoteLauncher.ts'), 'utf8')
        const replay = src.slice(src.indexOf('const parked = modeGate.takeParked();'), src.indexOf('await rewindReconciler.settled('))
        expect(replay).toMatch(/if \(parked\) \{\s*\/\/[^\n]*\n\s*batchSourceIds = parked\.sourceIds;/)
        // restored before the replay is finalized (finalize emits turn-started with batchSourceIds)
        expect(replay.indexOf('batchSourceIds = parked.sourceIds;')).toBeLessThan(replay.indexOf('await finalize(parked.message)'))
        const park = src.slice(src.indexOf("logger.debug('[remote]: mode has changed, pending message');"), src.indexOf('modeGate.adopt(msg.mode);'))
        expect(park).toMatch(/modeGate\.park\(\{[\s\S]*uuid: promptUuidFor\(msg\.sourceIds\),\s*sourceIds: msg\.sourceIds,\s*\}\);/)
        expect(src).toContain("onTurnStart: (ids) => session.client.emit('turn-started', ids),\n                                sourceIds: batchSourceIds,")
    })
})
