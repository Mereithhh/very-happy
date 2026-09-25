import { describe, expect, it, vi } from 'vitest'
import type { PersistedSession } from '@/persistence'
import type { SessionServerState } from '@/sessions/sessionOps'
import {
    ACTIVE_FRESH_WINDOW_MS,
    classifySessionState,
    deliverToSession,
    explainNotLive,
    type DeliveryDeps,
} from './sessionDelivery'

// B-501: `POST /v3/sessions/:id/messages` stores a message for ANY session,
// so a 2xx never meant a wrapper would read it. Delivery must classify first,
// refuse when nothing is attached, optionally resume, and re-check afterwards.

const NOW = 1_700_000_000_000
const SID = 'sess-1'
const persisted: PersistedSession = {
    encryptionKey: 'AAAA', encryptionVariant: 'dataKey', seq: 0, metadataVersion: 1, agentStateVersion: 1,
    metadata: { path: '/w', host: 'h' } as PersistedSession['metadata'], savedAt: NOW,
}

const found = (over: Partial<SessionServerState> = {}): SessionServerState =>
    ({ found: true, active: false, archivedAt: null, activeAt: NOW - 60_000, ...over })

describe('classifySessionState', () => {
    it('live when the local daemon tracks a wrapper', () => {
        expect(classifySessionState({ liveHere: true, server: found(), now: NOW })).toBe('live')
    })

    it('live when the server says active with a fresh activeAt (wrapper on another machine)', () => {
        expect(classifySessionState({ liveHere: false, server: found({ active: true, activeAt: NOW - 5 * 60_000 }), now: NOW })).toBe('live')
        expect(classifySessionState({ liveHere: false, server: found({ active: true, activeAt: NOW - ACTIVE_FRESH_WINDOW_MS }), now: NOW })).toBe('live')
    })

    it('offline when active is stale (beyond the 15-minute /v2/sessions/active window) or cleared', () => {
        expect(classifySessionState({ liveHere: false, server: found({ active: true, activeAt: NOW - ACTIVE_FRESH_WINDOW_MS - 1 }), now: NOW })).toBe('offline')
        expect(classifySessionState({ liveHere: false, server: found({ active: false, activeAt: NOW - 1000 }), now: NOW })).toBe('offline')
        // active without any activeAt cannot prove freshness
        expect(classifySessionState({ liveHere: false, server: { found: true, active: true, archivedAt: null }, now: NOW })).toBe('offline')
    })

    it('archived whenever archivedAt is set — even over a lingering local process (its socket is rejected)', () => {
        expect(classifySessionState({ liveHere: false, server: found({ archivedAt: NOW - 1 }), now: NOW })).toBe('archived')
        expect(classifySessionState({ liveHere: true, server: found({ archivedAt: NOW - 1, active: true, activeAt: NOW }), now: NOW })).toBe('archived')
    })

    it('not_found on a server 404, regardless of local state', () => {
        expect(classifySessionState({ liveHere: true, server: { found: false, active: false }, now: NOW })).toBe('not_found')
    })
})

describe('explainNotLive', () => {
    it('names the state and carries the caller-specific resume hint', () => {
        expect(explainNotLive(SID, 'archived', 'Use --resume.')).toBe('Session sess-1 is archived — no live wrapper will receive this message. Use --resume.')
        expect(explainNotLive(SID, 'offline', 'Pass resume:true.')).toMatch(/is offline .* Pass resume:true\.$/)
        expect(explainNotLive(SID, 'not_found', 'x')).toMatch(/not found .* cannot be messaged or resumed/)
    })
})

/** Scripted deps: `states` is consumed one readState per call; `liveIds` per listLive call. */
function makeDeps(script: {
    states: SessionServerState[]
    live?: string[][]
    resume?: { success: boolean; error?: string }
}) {
    let clock = NOW
    const states = [...script.states]
    const lives = [...(script.live ?? [])]
    const last = <T,>(arr: T[], fallback: T): T => (arr.length > 0 ? arr.shift()! : fallback)
    let lastState: SessionServerState = script.states[0]
    let lastLive: string[] = script.live?.[0] ?? []
    const deps: DeliveryDeps = {
        listLive: vi.fn(async () => {
            lastLive = last(lives, lastLive)
            return lastLive.map((id) => ({ happySessionId: id, pid: 1 }))
        }),
        readState: vi.fn(async () => {
            lastState = last(states, lastState)
            return lastState
        }),
        send: vi.fn(async () => {}),
        unarchive: vi.fn(async () => {}),
        archive: vi.fn(async () => {}),
        resume: vi.fn(async () => script.resume ?? { success: true }),
        sleep: vi.fn(async (ms: number) => { clock += ms }),
        now: () => clock,
    }
    return deps
}

describe('deliverToSession', () => {
    it('sends to a session live on this machine and reports delivered / live / not resumed', async () => {
        const deps = makeDeps({ states: [found()], live: [[SID]] })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', { model: null, sentFrom: 'tanka' }, deps)
        expect(result).toMatchObject({ sessionId: SID, delivered: true, status: 'live', resumed: false, stored: true })
        expect(deps.send).toHaveBeenCalledWith(SID, persisted, 'hi', 'cli-send', { model: null, sentFrom: 'tanka' })
        expect(deps.resume).not.toHaveBeenCalled()
        expect(deps.unarchive).not.toHaveBeenCalled()
    })

    it('sends to a session active on another machine', async () => {
        const deps = makeDeps({ states: [found({ active: true, activeAt: NOW - 1000 })], live: [[]] })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', {}, deps)
        expect(result).toMatchObject({ delivered: true, status: 'live' })
        expect(deps.send).toHaveBeenCalledOnce()
    })

    it.each(['archived', 'offline', 'not_found'] as const)('refuses without sending when the session is %s and resume was not asked', async (status) => {
        const server = status === 'archived' ? found({ archivedAt: NOW }) : status === 'offline' ? found() : { found: false, active: false }
        const deps = makeDeps({ states: [server], live: [[]] })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', {}, deps)
        expect(result).toMatchObject({ delivered: false, status, resumed: false, stored: false })
        expect(result.error).toContain(`Session ${SID}`)
        expect(result.error).toContain(status === 'not_found' ? 'not found' : 'no live wrapper')
        if (status !== 'not_found') expect(result.error).toContain('--resume')
        expect(deps.send).not.toHaveBeenCalled()
        expect(deps.resume).not.toHaveBeenCalled()
    })

    it('uses the surface-specific hint (MCP: resume:true)', async () => {
        const deps = makeDeps({ states: [found({ archivedAt: NOW })], live: [[]] })
        const result = await deliverToSession(SID, persisted, 'hi', 'assistant-mcp', { resumeHint: 'Pass resume:true to bring it back.' }, deps)
        expect(result.error).toMatch(/Pass resume:true to bring it back\.$/)
    })

    it('does not try to resume a session the server does not know', async () => {
        const deps = makeDeps({ states: [{ found: false, active: false }], live: [[]] })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', { resume: true }, deps)
        expect(result).toMatchObject({ delivered: false, status: 'not_found', resumed: false })
        expect(deps.unarchive).not.toHaveBeenCalled()
        expect(deps.resume).not.toHaveBeenCalled()
    })

    it('resume on an archived session: unarchive → daemon resume → wait until live here → send, resumed: true', async () => {
        const deps = makeDeps({
            // pre-check archived; after unarchive the server row is not archived
            // but inactive; the wrapper appears on the daemon's /list on the
            // third poll.
            states: [found({ archivedAt: NOW }), found(), found(), found({ active: true, activeAt: NOW + 3000 })],
            live: [[], [], [], [SID]],
        })
        const calls: string[] = []
        for (const name of ['unarchive', 'resume', 'send', 'archive'] as const) {
            ;(deps[name] as ReturnType<typeof vi.fn>).mockImplementation(async () => { calls.push(name); return name === 'resume' ? { success: true } : undefined })
        }
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', { resume: true, model: 'claude-opus-5-5', waitMs: 10_000, pollMs: 1_000 }, deps)
        expect(result).toMatchObject({ delivered: true, status: 'live', resumed: true, stored: true, resume: { ok: true } })
        expect(calls).toEqual(['unarchive', 'resume', 'send'])
        expect(deps.resume).toHaveBeenCalledWith(SID, { model: 'claude-opus-5-5' })
        expect(deps.send).toHaveBeenCalledWith(SID, persisted, 'hi', 'cli-send', { model: 'claude-opus-5-5' })
        expect(deps.sleep).toHaveBeenCalled()
    })

    it('resume on an offline (not archived) session skips the archive dance', async () => {
        const deps = makeDeps({ states: [found(), found()], live: [[], [SID]] })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', { resume: true, waitMs: 5_000 }, deps)
        expect(result).toMatchObject({ delivered: true, resumed: true })
        expect(deps.unarchive).not.toHaveBeenCalled()
        expect(deps.archive).not.toHaveBeenCalled()
        expect(deps.resume).toHaveBeenCalledWith(SID, {})
    })

    it('resume failure on an archived session re-archives and passes the daemon precheck error through', async () => {
        const deps = makeDeps({
            states: [found({ archivedAt: NOW })],
            live: [[]],
            resume: { success: false, error: 'resume-precheck:cwd-missing: /w does not exist' },
        })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', { resume: true }, deps)
        expect(result).toMatchObject({
            delivered: false, status: 'archived', resumed: false, stored: false,
            resume: { ok: false, error: 'resume-precheck:cwd-missing: /w does not exist' },
        })
        expect(deps.unarchive).toHaveBeenCalledOnce()
        expect(deps.archive).toHaveBeenCalledOnce()
        expect(deps.send).not.toHaveBeenCalled()
    })

    it('resume failure on an offline session does not archive a healthy session', async () => {
        const deps = makeDeps({ states: [found()], live: [[]], resume: { success: false, error: 'daemon too old to resume sessions (no /resume-session route); upgrade very-happy-cli and run `very-happy daemon start`' } })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', { resume: true }, deps)
        expect(result).toMatchObject({ delivered: false, status: 'offline', resume: { ok: false } })
        expect(result.resume?.error).toContain('daemon too old')
        expect(deps.archive).not.toHaveBeenCalled()
    })

    it('reports a failed re-archive alongside the resume error', async () => {
        const deps = makeDeps({ states: [found({ archivedAt: NOW })], live: [[]], resume: { success: false, error: 'boom' } })
        ;(deps.archive as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'))
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', { resume: true }, deps)
        expect(result.resume).toEqual({ ok: false, error: 'boom; failed to restore archive state: 500' })
    })

    it('resume succeeded but nothing came up within the wait: not delivered, not sent', async () => {
        const deps = makeDeps({ states: [found({ archivedAt: NOW }), found()], live: [[]] })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', { resume: true, waitMs: 3_000, pollMs: 1_000 }, deps)
        expect(result).toMatchObject({ delivered: false, status: 'offline', resumed: true, stored: false, resume: { ok: true } })
        expect(result.error).toMatch(/no live wrapper showed up within 3s/)
        expect(deps.send).not.toHaveBeenCalled()
        expect(deps.sleep).toHaveBeenCalledTimes(3)
    })

    it('detects a wrapper that dropped during the send: stored server-side, delivered: false', async () => {
        const deps = makeDeps({ states: [found(), found({ archivedAt: NOW + 1 })], live: [[SID], []] })
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', {}, deps)
        expect(deps.send).toHaveBeenCalledOnce()
        expect(result).toMatchObject({ delivered: false, status: 'archived', stored: true, resumed: false })
        expect(result.error).toMatch(/went archived while sending: the message is stored server-side/)
    })

    it('a failed post-send re-check does not turn a delivery into a drop', async () => {
        const deps = makeDeps({ states: [found()], live: [[SID]] })
        ;(deps.readState as ReturnType<typeof vi.fn>).mockResolvedValueOnce(found()).mockRejectedValueOnce(new Error('network'))
        const result = await deliverToSession(SID, persisted, 'hi', 'cli-send', {}, deps)
        expect(result).toMatchObject({ delivered: true, status: 'live' })
    })

    it('propagates a send failure (transport error) instead of reporting a state', async () => {
        const deps = makeDeps({ states: [found()], live: [[SID]] })
        ;(deps.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('HTTP 502'))
        await expect(deliverToSession(SID, persisted, 'hi', 'cli-send', {}, deps)).rejects.toThrow('HTTP 502')
    })
})
