import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MAIN_AGENT_AUTOMATION_KINDS, mainAgentAutomationCreate, AutomationCreateSchema, type Automation, type AttentionItem } from '@slopus/happy-wire'
import { fileLedger, newKeys, runMainAgentPrecheck, PRECHECK_SKIP_EXIT, SEEN_TTL_MS, type LedgerIo, type SeenLedger } from './precheck'
import { findStuckSessions, findWrapupCandidates, formatBrief, briefSnapshot, type ScanDeps, type ScanSession } from './scan'
import { ensureDefaultAutomations, installDefaultAutomations, listDefaultAutomations, setDefaultAutomation, writeDefaultQuietHours, type DefaultsApi } from './defaultAutomations'
import type { LogEntry } from '@/sessions/turnState'

const H = 3_600_000
const NOW = 1_000 * H
const prompt = (seq: number, at: number): LogEntry => ({ seq, body: { role: 'user', content: { type: 'text', text: 'go' } }, createdAt: at })
const reply = (seq: number, at: number): LogEntry => ({ seq, body: { role: 'session', content: { role: 'agent', ev: { t: 'turn-start' } } }, createdAt: at })
const ended = (seq: number, at: number): LogEntry => ({ seq, body: { role: 'session', content: { role: 'agent', ev: { t: 'turn-end', status: 'completed' } } }, createdAt: at })

function session(id: string, over: Partial<ScanSession> = {}): ScanSession {
    return { id, title: `T ${id}`, archived: false, active: false, readable: true, attention: false, updatedAt: NOW, ...over }
}

function deps(over: Partial<ScanDeps> & { logs?: Record<string, LogEntry[]> } = {}): ScanDeps {
    const { logs = {}, ...rest } = over
    return {
        now: () => NOW,
        mainAgentSessionId: async () => 'main',
        sessions: async () => [],
        recentLog: async (id) => logs[id] ?? null,
        teams: async () => [],
        boardItems: async () => [],
        failedRuns: async () => [],
        ...rest,
    }
}

function memoryLedger(): LedgerIo & { store: Record<string, SeenLedger> } {
    const store: Record<string, SeenLedger> = {}
    return { store, read: async (k) => ({ ...(store[k] ?? {}) }), write: async (k, l) => { store[k] = l } }
}

describe('B-924 stuck scan', () => {
    it('finds API-error sessions and sessions silent ≥ 3h mid-turn; skips the main agent, assistants, archived, background work', async () => {
        const d = deps({
            sessions: async () => [
                session('err', { turnFailure: { at: NOW - 2 * H, summary: 'API Error: 529 overloaded' } }),
                session('main', { turnFailure: { at: NOW, summary: 'x' } }),
                session('helper', { variant: 'assistant', turnFailure: { at: NOW, summary: 'x' } }),
                session('gone', { archived: true, turnFailure: { at: NOW, summary: 'x' } }),
                session('silent', { active: true }),
                session('busy', { active: true, backgroundTasks: { count: 2 } }),
                session('fresh', { active: true }),
                session('done', { active: true }),
            ],
            logs: {
                silent: [prompt(1, NOW - 5 * H), reply(2, NOW - 4 * H)],
                busy: [prompt(1, NOW - 5 * H)],
                fresh: [prompt(1, NOW - 1 * H)],
                done: [prompt(1, NOW - 9 * H), ended(2, NOW - 8 * H)],
            },
        })
        const list = await findStuckSessions(d)
        expect(list.map(s => [s.sessionId, s.reason])).toEqual([['err', 'api_error'], ['silent', 'silent']])
    })

    it('precheck: passes for new stuck sessions only; the same set again is skipped (exit ≠ 0, nothing to wake)', async () => {
        const ledger = memoryLedger()
        let sessions = [session('err', { turnFailure: { at: NOW - H, summary: 'API Error: 500' } })]
        const d = deps({ sessions: async () => sessions })
        const first = await runMainAgentPrecheck('stuck', d, ledger, { record: true })
        expect(first.exitCode).toBe(0)
        expect(first.stdout).toContain('err | T err | API error 1h ago: API Error: 500')
        const again = await runMainAgentPrecheck('stuck', d, ledger, { record: true })
        expect(again).toEqual({ exitCode: PRECHECK_SKIP_EXIT, stdout: 'no change: 1 stuck session(s), all reported before' })
        sessions = [...sessions, session('err2', { turnFailure: { at: NOW, summary: 'API Error: 400' } })]
        const third = await runMainAgentPrecheck('stuck', d, ledger, { record: true })
        expect(third.exitCode).toBe(0)
        expect(third.stdout).toContain('err2')
        expect(third.stdout).not.toContain('- err |')
        expect((await runMainAgentPrecheck('stuck', deps(), memoryLedger())).exitCode).toBe(PRECHECK_SKIP_EXIT)
    })

    it('thresholds: defaults 3h / 12h; the env override is clamped', async () => {
        const { scanHours } = await import('./scan')
        expect(scanHours('stuck', {})).toBe(3)
        expect(scanHours('idle', {})).toBe(12)
        expect(scanHours('idle', { VH_MAIN_AGENT_IDLE_HOURS: '0.05' })).toBe(0.05)
        expect(scanHours('idle', { VH_MAIN_AGENT_IDLE_HOURS: '0' })).toBe(12)
        expect(scanHours('stuck', { VH_MAIN_AGENT_STUCK_HOURS: 'x' })).toBe(3)
    })

    it('(QA P3-6) a manual precheck (no --record) shows what is new but remembers nothing', async () => {
        const ledger = memoryLedger()
        const d = deps({ sessions: async () => [session('err', { turnFailure: { at: NOW - H, summary: 'API Error: 500' } })] })
        expect((await runMainAgentPrecheck('stuck', d, ledger)).exitCode).toBe(0)
        expect(ledger.store).toEqual({})
        expect((await runMainAgentPrecheck('stuck', d, ledger, { record: true })).exitCode).toBe(0)
        expect((await runMainAgentPrecheck('stuck', d, ledger, { record: true })).exitCode).toBe(PRECHECK_SKIP_EXIT)
    })

    it('the seen ledger forgets after the TTL', () => {
        const { fresh } = newKeys({ a: NOW - SEEN_TTL_MS - 1, b: NOW - 1 }, ['a', 'b', 'c'], NOW)
        expect([...fresh].sort()).toEqual(['a', 'c'])
    })
})

describe('B-924 wrap-up scan', () => {
    const board = (over: Partial<AttentionItem>): AttentionItem => ({ id: 'i', sessionId: 'main', teamId: null, projectId: null, source: 'agent', kind: 'decision', key: null, title: 't', bodyMd: null, options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 0, updatedAt: 0, resolvedAt: null, pushedAt: null, version: 1, ...over })
    it('idle ≥ 12h, not a team bot / main agent / assistant / waiting on the owner / already carded', async () => {
        const idle = [prompt(1, NOW - 30 * H), ended(2, NOW - 20 * H)]
        const d = deps({
            sessions: async () => ['a', 'lead', 'member', 'main', 'asst', 'ask', 'carded', 'own-card', 'recent', 'other-machine'].map(id => session(id, {
                ...(id === 'asst' ? { variant: 'assistant' } : {}), ...(id === 'ask' ? { attention: true } : {}), ...(id === 'other-machine' ? { readable: false } : {}),
            })),
            teams: async () => [{ id: 't', name: 'T', bots: [{ id: 'b1', name: 'L', root: true, sessionId: 'lead' }, { id: 'b2', name: 'M', root: false, sessionId: 'member' }] }],
            boardItems: async () => [
                board({ key: 'main-agent-wrapup:x', payload: { v: 1, type: 'select', items: [{ id: 's1', label: 'c', ref: 'carded', checked: false }] } }),
                board({ kind: 'wrapup', sessionId: 'own-card' }),
            ],
            logs: Object.fromEntries(['a', 'lead', 'member', 'main', 'asst', 'ask', 'carded', 'own-card', 'other-machine'].map(id => [id, idle]).concat([['recent', [prompt(1, NOW - H)]]])),
        })
        expect((await findWrapupCandidates(d)).map(c => [c.sessionId, c.idleHours])).toEqual([['a', 20]])
        const ledger = memoryLedger()
        expect((await runMainAgentPrecheck('wrapup', d, ledger, { record: true })).exitCode).toBe(0)
        expect((await runMainAgentPrecheck('wrapup', d, ledger, { record: true })).exitCode).toBe(PRECHECK_SKIP_EXIT)
    })
})

describe('B-924 brief precheck', () => {
    it('always passes with a snapshot under the 4,000-char precheck tail', async () => {
        const d = deps({
            teams: async () => Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, name: `Team ${i} ${'n'.repeat(80)}`, tasks: [{ id: 'k', goal: 'g'.repeat(300), status: 'submitted' }] })),
            sessions: async () => [session('err', { turnFailure: { at: NOW - H, summary: 'API Error: 529' } })],
        })
        const out = await runMainAgentPrecheck('brief', d, memoryLedger())
        expect(out.exitCode).toBe(0)
        expect(out.stdout.length).toBeLessThanOrEqual(3_900)
        expect(out.stdout).toContain('Snapshot for the morning brief')
        expect(formatBrief(await briefSnapshot(deps()), NOW)).toContain('Teams (0)')
    })

    it('a file ledger round-trips', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'b924-'))
        try {
            const io = fileLedger(dir)
            await io.write('stuck', { a: 1 })
            expect(await io.read('stuck')).toEqual({ a: 1 })
            expect(JSON.parse(readFileSync(join(dir, 'precheck-stuck.json'), 'utf8'))).toMatchObject({ v: 1 })
            expect(await io.read('wrapup')).toEqual({})
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
})

describe('B-924 default automations', () => {
    function api(existing: Automation[] = []): DefaultsApi & { all: Automation[]; ops: string[] } {
        const all = [...existing]
        const ops: string[] = []
        const view = (input: any): Automation => ({ id: `id-${input.name}`, name: input.name, description: null, machineId: input.machineId, status: input.status ?? 'active', trigger: input.trigger, action: input.action, concurrency: 'skip', maxRuntimeMs: 1, nextRunAt: 1, version: 1, lastRunAt: null, lastRunStatus: null, createdAt: 1, updatedAt: 1, precheck: input.precheck })
        return {
            all, ops,
            list: async () => all,
            create: async (input) => { ops.push(`create:${input.name}:${input.status}`); const a = view(input); all.push(a); return a },
            pause: async (id) => { ops.push(`pause:${id}`); const a = all.find(x => x.id === id)!; a.status = 'paused'; return a },
            resume: async (id) => { ops.push(`resume:${id}`); const a = all.find(x => x.id === id)!; a.status = 'active'; return a },
        }
    }
    const target = { machineId: 'm1', tz: 'Asia/Tokyo' }

    it('every definition is a valid create: a send to the main agent behind a very-happy precheck (never a script, never a wrap-up)', () => {
        for (const kind of MAIN_AGENT_AUTOMATION_KINDS) {
            const body = mainAgentAutomationCreate(kind, target)
            expect(AutomationCreateSchema.safeParse(body).success).toBe(true)
            expect(body.action).toMatchObject({ kind: 'send', target: 'main-agent' })
            expect(body.precheck).toMatchObject({ command: ['very-happy', 'main-agent', 'precheck', kind, '--record'], includeOutput: true })
        }
        expect(mainAgentAutomationCreate('brief', target).trigger).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' })
        expect(mainAgentAutomationCreate('stuck', target).trigger).toEqual({ kind: 'interval', everyMs: 3_600_000 })
        const wrap = mainAgentAutomationCreate('wrapup', target)
        expect(wrap.trigger).toEqual({ kind: 'cron', expr: '30 23 * * *', tz: 'Asia/Tokyo' })
        expect((wrap.action as { prompt: string }).prompt).toMatch(/Never call session_wrapup/)
    })

    it('install creates only the missing ones and leaves a paused one paused; on/off pause / resume / create', async () => {
        const a = api()
        expect(await installDefaultAutomations(a, target)).toEqual(['main-agent-brief', 'main-agent-stuck', 'main-agent-wrapup'])
        await setDefaultAutomation(a, 'stuck', false, target)
        expect(await installDefaultAutomations(a, target)).toEqual([])
        expect((await listDefaultAutomations(a)).map(s => `${s.kind}:${s.state}`)).toEqual(['brief:on', 'stuck:off', 'wrapup:on'])
        expect((await setDefaultAutomation(a, 'stuck', true, target)).state).toBe('on')
        const b = api()
        expect((await setDefaultAutomation(b, 'brief', false, target)).state).toBe('missing')
        expect((await setDefaultAutomation(b, 'brief', true, target)).state).toBe('on')
        expect(b.ops).toEqual(['create:main-agent-brief:active'])
    })

    it('the daemon installs them once per machine (marker), never again after the owner deleted one', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'b924-'))
        try {
            const a = api()
            expect(await ensureDefaultAutomations(a, { ...target, assistantHome: dir })).toHaveLength(3)
            a.all.splice(0, 1)
            expect(await ensureDefaultAutomations(a, { ...target, assistantHome: dir })).toBeNull()
            expect(a.all).toHaveLength(2)
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
})

describe('B-924 default quiet hours', () => {
    const kv = (initial: object | null) => {
        let value = initial ? Buffer.from(JSON.stringify(initial)).toString('base64') : null
        let version = initial ? 3 : -1
        return {
            read: () => value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null,
            io: {
                get: async () => value === null ? null : { value, version },
                set: async (_k: string, v: string, expected: number) => { if (expected !== version) return 'conflict' as const; value = v; version = expected + 1; return 'ok' as const },
            },
        }
    }
    it('adds 00:30–08:30 in the machine zone, keeps other fields, never overwrites the owner\'s setting', async () => {
        const a = kv({ v: 1, skillRoots: ['~/s'] })
        expect(await writeDefaultQuietHours(a.io, 'Asia/Tokyo')).toBe('written')
        expect(a.read()).toEqual({ v: 1, skillRoots: ['~/s'], quietHours: { enabled: true, start: '00:30', end: '08:30', tz: 'Asia/Tokyo' } })
        const b = kv({ quietHours: { enabled: false, start: '22:00', end: '06:00', tz: 'Europe/Berlin' } })
        expect(await writeDefaultQuietHours(b.io, 'UTC')).toBe('present')
        expect(b.read()).toEqual({ quietHours: { enabled: false, start: '22:00', end: '06:00', tz: 'Europe/Berlin' } })
        // The owner's window without a zone keeps its times and gets the machine's zone.
        const z = kv({ quietHours: { enabled: false, start: '22:00' } })
        expect(await writeDefaultQuietHours(z.io, 'Asia/Tokyo')).toBe('written')
        expect(z.read()).toEqual({ quietHours: { enabled: false, start: '22:00', end: '08:30', tz: 'Asia/Tokyo' } })
        const c = kv(null)
        expect(await writeDefaultQuietHours(c.io, 'UTC')).toBe('written')
    })
    it('no quietHours = the default window, but with no zone the server checks nothing', async () => {
        const { readMainAgentQuietHours, isMainAgentQuietTime } = await import('@slopus/happy-wire')
        expect(isMainAgentQuietTime(readMainAgentQuietHours({}), Date.UTC(2026, 0, 1, 3, 0))).toBe(false)
        expect(isMainAgentQuietTime(readMainAgentQuietHours({ quietHours: { enabled: true, start: '00:30', end: '08:30', tz: 'UTC' } }), Date.UTC(2026, 0, 1, 3, 0))).toBe(true)
        expect(isMainAgentQuietTime(readMainAgentQuietHours({ quietHours: { enabled: true, start: '22:00', end: '07:00', tz: 'UTC' } }), Date.UTC(2026, 0, 1, 23, 0))).toBe(true)
        expect(isMainAgentQuietTime(readMainAgentQuietHours({ quietHours: { enabled: true, start: '22:00', end: '07:00', tz: 'UTC' } }), Date.UTC(2026, 0, 1, 12, 0))).toBe(false)
    })
})

describe('B-924 no path wraps a session up by itself', () => {
    it('the scans, prechecks and default automations never reach a wrap-up backend', () => {
        for (const file of ['scan.ts', 'precheck.ts', 'liveDeps.ts', 'defaultAutomations.ts', 'installOnce.ts']) {
            const source = readFileSync(join(__dirname, file), 'utf8')
            expect(source, file).not.toMatch(/wrapup\/request|requestWrapup|session_wrapup\(|lifecycle\.wrapup|installSessionLifecycle/)
        }
    })
})
