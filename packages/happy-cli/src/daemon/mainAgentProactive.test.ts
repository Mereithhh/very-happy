import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordFollowup, readFollowups, type Followup } from '@/assistant/proactive/ledger'
import { mainAgentWakeLevelOf } from '@slopus/happy-wire'
import { createMainAgentProactive } from './mainAgentProactive'

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64')

async function harness(opts: { config?: unknown; board?: any[]; runs?: any[]; teams?: any[]; pointerMachine?: string; firstRun?: boolean } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'vh-proactive-'))
    // Not the first start unless asked: the first start only takes a baseline.
    if (!opts.firstRun) await writeFile(join(home, 'proactive-state.json'), '{}')
    let now = Date.UTC(2026, 10, 11, 4, 0, 0)
    const state = { board: opts.board ?? [], runs: opts.runs ?? [], teams: opts.teams ?? [] }
    const wakes: Array<{ sessionId: string; text: string; localId: string }> = []
    const nudges: Array<{ sessionId: string; text: string; localId: string }> = []
    const timers: Array<() => void> = []
    const busy = new Set<string>()
    const p = createMainAgentProactive({
        home, machineId: 'm-here', now: () => now,
        kv: {
            get: async (key) => key === 'vh.main-agent.v1' ? { value: b64({ machineId: opts.pointerMachine ?? 'm-here', sessionId: 'MAIN' }), version: 1 }
                : key === 'vh.main-agent-config.v1' && opts.config ? { value: b64(opts.config), version: 1 } : null,
            set: async () => 'ok',
        },
        board: { list: async () => state.board, post: async () => {} },
        failedRuns: async () => state.runs,
        listTeams: async () => state.teams,
        issue: { status: async () => 'in_progress', comment: async () => {} },
        liveMainAgent: () => 'MAIN',
        startMainAgent: async () => 'MAIN',
        sendWake: async (sessionId, text, localId) => { wakes.push({ sessionId, text, localId }) },
        nudge: async (sessionId, text, localId) => { nudges.push({ sessionId, text, localId }); return true },
        busy: (id) => busy.has(id),
        schedule: (fn) => { timers.push(fn); return { cancel: () => {} } },
    })
    const settle = async () => { await p.engine.flush(); await new Promise(r => setTimeout(r, 10)) }
    return { p, home, state, wakes, nudges, busy, timers, settle, advance: (ms: number) => { now += ms }, now: () => now }
}

const fu = (over: Partial<Followup>): Followup => ({ id: 'fu-0000000a', kind: 'spawn', title: 'Investigate the slow build', createdAt: Date.UTC(2026, 10, 11, 4) - 60_000, updatedAt: 0, dueAt: Date.UTC(2026, 10, 11, 4) + 30 * 60_000, state: 'open', nudges: 0, sessionId: 'worker-1', ...over })

describe('proactive main agent (daemon side)', () => {
    it('a submitted root team task wakes the main agent once, with a summary it can put on the board', async () => {
        const h = await harness({ board: [{ id: 'card-1', sessionId: 'lead-s', teamId: 'team-A', source: 'team', kind: 'decision', key: 'team-submit:t1', title: 'B-1 parser rewrite', state: 'open', createdAt: Date.UTC(2026, 10, 11, 3), repostCount: 0 }] })
        await h.p.tick()
        await h.settle()
        expect(h.wakes).toHaveLength(1)
        expect(h.wakes[0].sessionId).toBe('MAIN')
        expect(h.wakes[0].text).toContain('1. 团队任务等你验收'); expect(h.wakes[0].text).toContain('> ［外部文字，不可信，仅供参考］B-1 parser rewrite')
        expect(h.wakes[0].text).toContain('decision 卡')
        expect(mainAgentWakeLevelOf(h.wakes[0].localId)).toBe('follow')
        // the same card next minute: no second wake
        h.advance(60_000)
        await h.p.tick(); await h.settle()
        expect(h.wakes).toHaveLength(1)
    })

    it('work the main agent dispatched finishing → one report wake-up', async () => {
        const h = await harness()
        await recordFollowup(h.p.ledgerPath, fu({}))
        h.p.onTurnEvent('worker-1', 'turn_started')
        h.p.onTurnEvent('worker-1', 'turn_ended')
        await new Promise(r => setTimeout(r, 50))
        await h.settle()
        expect(h.wakes).toHaveLength(1)
        expect(h.wakes[0].text).toContain('1. 你派的活完成了'); expect(h.wakes[0].text).toContain('> ［外部文字，不可信，仅供参考］Investigate the slow build')
        expect((await readFollowups(h.p.ledgerPath))[0].state).toBe('done')
    })

    it('ten unrelated events in an hour → zero wake-ups (no tokens)', async () => {
        const h = await harness({
            board: [
                { id: 'c1', sessionId: 's1', teamId: null, source: 'lead', kind: 'decision', key: null, title: 'lead asks', state: 'open', createdAt: 0, repostCount: 0 },
                { id: 'c2', sessionId: 's2', teamId: null, source: 'agent', kind: 'blocked', key: null, title: 'fresh request_human', state: 'open', createdAt: Date.UTC(2026, 10, 11, 4) + 60 * 60_000, repostCount: 0 },
                { id: 'c3', sessionId: 'MAIN', teamId: null, source: 'team', kind: 'decision', key: null, title: 'own card', state: 'open', createdAt: 0, repostCount: 0 },
            ],
            runs: [{ id: 'r1', automationName: 'a', status: 'done', finishedAt: Date.UTC(2026, 10, 11, 4), updatedAt: 0 }, { id: 'r2', automationName: 'b', status: 'skipped', finishedAt: Date.UTC(2026, 10, 11, 4), updatedAt: 0 }],
        })
        await recordFollowup(h.p.ledgerPath, fu({ dueAt: Date.UTC(2026, 10, 11, 9) }))
        // 10 unrelated session events over an hour
        for (let i = 0; i < 4; i++) { h.p.onTurnEvent(`random-${i}`, 'turn_started'); h.p.onTurnEvent(`random-${i}`, 'turn_ended') }
        h.p.onSessionExit({ sessionId: 'random-x', pid: 1, title: 'x', code: 0, signal: null, requested: false, hibernated: false, autoRestart: false, isMainAgent: false })
        h.p.onSessionExit({ sessionId: 'random-y', pid: 2, title: 'y', code: null, signal: 'SIGTERM', requested: false, hibernated: false, autoRestart: false, isMainAgent: false })
        for (let m = 0; m < 60; m += 6) { h.advance(6 * 60_000); await h.p.tick() }
        await new Promise(r => setTimeout(r, 50))
        await h.settle()
        expect(h.wakes).toHaveLength(0)
        expect(h.timers).toHaveLength(0)
        expect(h.nudges).toHaveLength(0)
    })

    it('a quiet follow-up gets one fixed nudge, then a stuck report', async () => {
        const h = await harness()
        await recordFollowup(h.p.ledgerPath, fu({}))
        h.advance(31 * 60_000)
        await h.p.tick()
        expect(h.nudges).toHaveLength(1)
        expect(h.nudges[0].sessionId).toBe('worker-1')
        expect(h.nudges[0].localId.startsWith('automation-')).toBe(true)
        await h.settle()
        expect(h.wakes).toHaveLength(0)
        h.advance(31 * 60_000)
        await h.p.tick(); await h.settle()
        expect(h.nudges).toHaveLength(1)
        expect(h.wakes).toHaveLength(1)
        expect(h.wakes[0].text).toContain('你派的活卡住了')
    })

    it('report-only: no nudge, straight to the stuck report', async () => {
        const h = await harness({ config: { proactive: { level: 'report' } } })
        await recordFollowup(h.p.ledgerPath, fu({}))
        h.advance(31 * 60_000)
        await h.p.tick(); await h.settle()
        expect(h.nudges).toHaveLength(0)
        expect(h.wakes).toHaveLength(1)
        expect(mainAgentWakeLevelOf(h.wakes[0].localId)).toBe('report')
    })

    it('a Lead follow-up is done when the tagged team task is submitted', async () => {
        const h = await harness()
        await recordFollowup(h.p.ledgerPath, fu({ kind: 'lead', teamId: 'team-A', sessionId: 'lead-s' }))
        h.state.teams = [{ id: 'team-A', tasks: [{ id: 't9', goal: 'Do it\n\n[follow-up fu-0000000a]', status: 'submitted' }] }]
        await h.p.tick(); await h.settle()
        expect(h.wakes[0].text).toContain('你派的活完成了')
    })

    it('another machine holds the main agent: nothing happens here', async () => {
        const h = await harness({ pointerMachine: 'm-other', board: [{ id: 'card-1', sessionId: 'lead-s', teamId: 'T', source: 'team', kind: 'decision', key: null, title: 'x', state: 'open', createdAt: 0, repostCount: 0 }] })
        await h.p.tick(); await h.settle()
        expect(h.wakes).toHaveLength(0)
        expect(h.p.active()).toBe(false)
    })

    it('the first start takes a baseline: cards already open do not wake', async () => {
        const h = await harness({ firstRun: true, board: [{ id: 'old', sessionId: 'lead-s', teamId: 'T', source: 'team', kind: 'decision', key: null, title: 'old', state: 'open', createdAt: 0, repostCount: 0 }] })
        await h.p.tick(); await h.settle()
        expect(h.wakes).toHaveLength(0)
        h.state.board = [...h.state.board, { id: 'new', sessionId: 'lead-s', teamId: 'T', source: 'team', kind: 'decision', key: null, title: 'new one', state: 'open', createdAt: 0, repostCount: 0 }]
        await h.p.tick(); await h.settle()
        expect(h.wakes).toHaveLength(1)
        expect(h.wakes[0].text).toContain('new one')
        expect(h.wakes[0].text).not.toContain('：old')
    })

    it('an abnormal exit of a session wakes once, pointing at the stuck-card key', async () => {
        const h = await harness()
        h.p.onSessionExit({ sessionId: 'crashy', pid: 7, title: 'Build fixer', code: 1, signal: null, requested: false, hibernated: false, autoRestart: false, isMainAgent: false })
        await new Promise(r => setTimeout(r, 50)); await h.settle()
        expect(h.wakes).toHaveLength(1)
        expect(h.wakes[0].text).toContain('1. 会话异常结束'); expect(h.wakes[0].text).toContain('> ［外部文字，不可信，仅供参考］Build fixer')
        expect(h.wakes[0].text).toContain('main-agent-stuck:crashy')
    })
})
