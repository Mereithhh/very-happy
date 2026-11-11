import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readMainAgentProactive } from '@slopus/happy-wire'
import {
    applyFollowupSignal, followupNudgeText, followupTag, formatFollowupLine, mutateFollowups, parseFollowups, pruneFollowups, readFollowups, recordFollowup, tickFollowup,
    type Followup,
} from './ledger'
import { keywordRisk } from '../gates/risk'

const W = 30 * 60_000
const base = (over: Partial<Followup> = {}): Followup => ({
    id: 'fu-00000001', kind: 'spawn', title: 'fix the flaky test', createdAt: 1_000, updatedAt: 1_000, dueAt: 1_000 + W, state: 'open', nudges: 0, sessionId: 'sess-aaaaaaaa', ...over,
})

describe('follow-up transitions', () => {
    it('a spawned / sent session ending its turn is done; another session is not', () => {
        expect(applyFollowupSignal(base(), { type: 'turn_ended', sessionId: 'other-session', at: 5_000 }, W).event).toBeUndefined()
        const step = applyFollowupSignal(base(), { type: 'turn_ended', sessionId: 'sess-aaaaaaaa', at: 5_000 }, W)
        expect(step.event).toBe('followup_done')
        expect(step.item.state).toBe('done')
        expect(applyFollowupSignal(base({ kind: 'send' }), { type: 'turn_ended', sessionId: 'sess-aaaaaaaa', at: 5_000 }, W).event).toBe('followup_done')
    })

    it('a turn that ended before the dispatch does not count', () => {
        expect(applyFollowupSignal(base(), { type: 'turn_ended', sessionId: 'sess-aaaaaaaa', at: 900 }, W).item.state).toBe('open')
    })

    it('a Lead ending its turn only delegated it: activity, not done; its tagged team task decides', () => {
        const lead = base({ kind: 'lead', teamId: 'team-1', sessionId: 'lead-session' })
        const turn = applyFollowupSignal(lead, { type: 'turn_ended', sessionId: 'lead-session', at: 5_000 }, W)
        expect(turn.event).toBeUndefined()
        expect(turn.item.dueAt).toBe(5_000 + W)
        const tasks = (status: string) => ({ type: 'team_tasks' as const, teamId: 'team-1', at: 9_000, tasks: [{ id: 'unrelated', goal: 'other', status: 'done' }, { id: 't-2', goal: `do X\n\n${followupTag(lead.id)}`, status }] })
        expect(applyFollowupSignal(lead, tasks('running'), W).event).toBeUndefined()
        expect(applyFollowupSignal(lead, tasks('submitted'), W).event).toBe('followup_done')
        expect(applyFollowupSignal(lead, tasks('cancelled'), W).event).toBe('followup_stuck')
        expect(applyFollowupSignal(lead, { ...tasks('done'), teamId: 'team-2' }, W).event).toBeUndefined()
    })

    it('QA P2-2 (fu-34cf5d54): the Lead rewrote the goal (tag gone) — its new task counts, untagged or not', () => {
        const lead = base({ id: 'fu-34cf5d54', kind: 'lead', teamId: 'team-1', sessionId: 'lead-session', baselineTaskIds: ['t-old'] })
        const bots = [{ id: 'bot-lead', sessionId: 'lead-session' }, { id: 'bot-member', sessionId: 'member-session' }]
        const tasks = (status: string, extra: Array<{ id: string; goal: string; status: string; ownerBotId?: string | null }> = []) => ({ type: 'team_tasks' as const, teamId: 'team-1', bots, at: 9_000, tasks: [
            { id: 't-old', goal: 'old work', status: 'done', ownerBotId: 'bot-lead' },
            { id: 't-new', goal: 'Rewritten by the Lead: ship the parser', status, ownerBotId: 'bot-lead' },
            ...extra,
        ] })
        const moving = applyFollowupSignal(lead, tasks('running'), W)
        expect(moving.event).toBeUndefined()
        expect(moving.item.dueAt).toBe(9_000 + W)
        expect(moving.item.result).toContain('t-new running')
        const done = applyFollowupSignal(lead, tasks('submitted'), W)
        expect(done.event).toBe('followup_done')
        expect(done.item.result).toContain('t-new submitted')
        // the old (baseline) done task and a task another bot owns do not count
        const onlyOthers = { type: 'team_tasks' as const, teamId: 'team-1', bots, at: 9_000, tasks: [{ id: 't-old', goal: 'x', status: 'done', ownerBotId: 'bot-lead' }, { id: 't-m', goal: 'x', status: 'done', ownerBotId: 'bot-member' }] }
        expect(applyFollowupSignal(lead, onlyOthers, W)).toEqual({ item: lead })
        // an entry recorded before baselines existed only trusts the tag
        expect(applyFollowupSignal({ ...lead, baselineTaskIds: undefined }, tasks('submitted'), W).event).toBeUndefined()
    })

    it('QA P2-2: report level, a Lead that was active but shows no matching task gets one more window, then stuck', () => {
        const lead = base({ kind: 'lead', teamId: 't', sessionId: 'lead', lastActivityAt: 2_000 })
        const first = tickFollowup(lead, lead.dueAt, { level: 'report', windowMs: W, busy: false })
        expect(first.event).toBeUndefined()
        expect(first.item.extended).toBe(true)
        expect(tickFollowup(first.item, first.item.dueAt, { level: 'report', windowMs: W, busy: false }).event).toBe('followup_stuck')
        // a silent Lead (never active) is reported at once
        expect(tickFollowup(base({ kind: 'lead', teamId: 't', sessionId: 'lead' }), lead.dueAt, { level: 'report', windowMs: W, busy: false }).event).toBe('followup_stuck')
    })

    it('issue states: done / in_review done, blocked stuck', () => {
        const issue = base({ kind: 'issue', sessionId: undefined, issueId: 'iss-1', issueKey: 'VH-3' })
        expect(applyFollowupSignal(issue, { type: 'issue', issueId: 'iss-1', status: 'in_progress', at: 2_000 }, W).event).toBeUndefined()
        expect(applyFollowupSignal(issue, { type: 'issue', issueId: 'iss-1', status: 'in_review', at: 2_000 }, W).event).toBe('followup_done')
        expect(applyFollowupSignal(issue, { type: 'issue', issueId: 'iss-1', status: 'blocked', at: 2_000 }, W).event).toBe('followup_stuck')
    })

    it('needs input is reported once; an error exit is stuck; a normal exit waits', () => {
        const blocked = applyFollowupSignal(base(), { type: 'needs_input', sessionId: 'sess-aaaaaaaa', at: 2_000 }, W)
        expect(blocked.event).toBe('followup_blocked')
        expect(applyFollowupSignal(blocked.item, { type: 'needs_input', sessionId: 'sess-aaaaaaaa', at: 3_000 }, W).event).toBeUndefined()
        expect(applyFollowupSignal(base(), { type: 'session_exit', sessionId: 'sess-aaaaaaaa', at: 2_000, error: true }, W).event).toBe('followup_stuck')
        expect(applyFollowupSignal(base(), { type: 'session_exit', sessionId: 'sess-aaaaaaaa', at: 2_000, error: false }, W).item.state).toBe('open')
    })

    it('the clock: follow nudges once, then stuck; report goes straight to stuck; off does nothing; busy is moving', () => {
        const due = base().dueAt + 1
        const first = tickFollowup(base(), due, { level: 'follow', windowMs: W, busy: false })
        expect(first.nudge).toBe(true)
        expect(first.item.nudges).toBe(1)
        expect(first.item.state).toBe('open')
        expect(tickFollowup(first.item, due + 1, { level: 'follow', windowMs: W, busy: false }).event).toBeUndefined()
        const second = tickFollowup(first.item, first.item.dueAt, { level: 'follow', windowMs: W, busy: false })
        expect(second.nudge).toBeUndefined()
        expect(second.event).toBe('followup_stuck')
        expect(tickFollowup(base(), due, { level: 'report', windowMs: W, busy: false }).event).toBe('followup_stuck')
        expect(tickFollowup(base(), due, { level: 'report', windowMs: W, busy: false }).nudge).toBeUndefined()
        expect(tickFollowup(base(), due, { level: 'off', windowMs: W, busy: false })).toEqual({ item: base() })
        const busy = tickFollowup(base(), due, { level: 'follow', windowMs: W, busy: true })
        expect(busy.nudge).toBeUndefined()
        expect(busy.item.dueAt).toBe(due + W)
    })

    it('closed entries never move again', () => {
        const done = { ...base(), state: 'done' as const }
        expect(tickFollowup(done, 10 ** 12, { level: 'follow', windowMs: W, busy: false })).toEqual({ item: done })
        expect(applyFollowupSignal(done, { type: 'turn_ended', sessionId: 'sess-aaaaaaaa', at: 10 ** 12 }, W)).toEqual({ item: done })
    })

    it('the nudge texts stay VH-internal: the gate keyword rules rate them none', () => {
        for (const kind of ['lead', 'spawn', 'send', 'issue'] as const) {
            expect(keywordRisk(followupNudgeText(base({ kind, title: 'refactor the parser' })))).toBe('none')
        }
    })

    it('list line names the target and state', () => {
        expect(formatFollowupLine(base(), 1_000 + 5 * 60_000)).toMatch(/^fu-00000001 open spawn 5m session=sess-aaaaaaaa "fix the flaky test" due=25m$/)
    })
})

describe('follow-up ledger file', () => {
    it('survives a restart (read back from disk) and is 0600', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'vh-fu-'))
        const path = join(dir, 'followups.json')
        await recordFollowup(path, base())
        await recordFollowup(path, base({ id: 'fu-00000002', kind: 'lead', teamId: 't', sessionId: 'lead' }))
        const again = await readFollowups(path)
        expect(again.map(i => i.id)).toEqual(['fu-00000001', 'fu-00000002'])
        const { statSync } = await import('node:fs')
        expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(JSON.parse(await readFile(path, 'utf8')).v).toBe(1)
    })

    it('concurrent writers do not lose entries (lock file)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'vh-fu-'))
        const path = join(dir, 'followups.json')
        await Promise.all(Array.from({ length: 20 }, (_, i) => recordFollowup(path, base({ id: `fu-${String(i).padStart(8, '0')}` }))))
        expect((await readFollowups(path)).length).toBe(20)
        await mutateFollowups(path, items => items.map(i => ({ ...i, state: 'done' as const, closedAt: 2_000 })), 3_000)
        expect((await readFollowups(path)).every(i => i.state === 'done')).toBe(true)
    })

    it('a broken file reads as empty; bad entries are dropped one by one', () => {
        expect(parseFollowups('{not json')).toEqual([])
        expect(parseFollowups(JSON.stringify({ items: [{ id: 'x' }, base()] })).map(i => i.id)).toEqual(['fu-00000001'])
    })

    it('prunes closed entries after two weeks, never open ones', () => {
        const now = 30 * 24 * 60 * 60_000
        const kept = pruneFollowups([base({ id: 'fu-open' }), base({ id: 'fu-old', state: 'done', closedAt: 1 }), base({ id: 'fu-new', state: 'done', closedAt: now - 1 })], now)
        expect(kept.map(i => i.id)).toEqual(['fu-open', 'fu-new'])
    })
})

describe('proactive settings (wire)', () => {
    it('defaults to follow and falls back field by field', () => {
        expect(readMainAgentProactive(null).level).toBe('follow')
        const read = readMainAgentProactive({ proactive: { level: 'report', dailyWakes: 3, dailyTokens: -1, debounceSec: 1 } })
        expect(read.level).toBe('report')
        expect(read.dailyWakes).toBe(3)
        expect(read.dailyTokens).toBe(300_000)
        expect(read.debounceSec).toBe(90)
        expect(readMainAgentProactive({ proactive: { level: 'loud' } }).level).toBe('follow')
    })
})
