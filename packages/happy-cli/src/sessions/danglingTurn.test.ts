import { describe, expect, it, vi } from 'vitest'
import { closeDanglingTurn, danglingTurnVerdict, findDanglingTurn } from './danglingTurn'
import { analyzeLatestTurn, type LogEntry } from './turnState'
import { decodeBase64, decrypt, encodeBase64 } from '@/api/encryption'

const user = (seq: number, text: string): LogEntry => ({ seq, body: { role: 'user', content: { type: 'text', text } }, localId: `u${seq}` })
const marker = (seq: number, t: 'turn-start' | 'turn-end', turn: string, extra: Record<string, unknown> = {}): LogEntry =>
    ({ seq, body: { role: 'session', content: { id: `e${seq}`, time: seq, role: 'agent', turn, ...extra, ev: { t, ...(t === 'turn-end' ? { status: 'completed' } : {}) } } } })
const text = (seq: number, turn: string, value: string): LogEntry =>
    ({ seq, body: { role: 'session', content: { id: `e${seq}`, time: seq, role: 'agent', turn, ev: { t: 'text', text: value } } } })

describe('B-942 findDanglingTurn', () => {
    it('the turn a killed wrapper left open', () => {
        expect(findDanglingTurn([user(1, 'q'), marker(2, 'turn-start', 'T1'), text(3, 'T1', 'working')])).toEqual({ turn: 'T1' })
    })

    it('nothing when the last turn ended', () => {
        expect(findDanglingTurn([user(1, 'q'), marker(2, 'turn-start', 'T1'), marker(3, 'turn-end', 'T1')])).toBeNull()
        expect(findDanglingTurn([])).toBeNull()
    })

    it('a newer turn (a resumed wrapper) is not ours to end — only the last turn counts', () => {
        expect(findDanglingTurn([marker(1, 'turn-start', 'T1'), user(2, 'again'), marker(3, 'turn-start', 'T2'), marker(4, 'turn-end', 'T2')])).toBeNull()
    })

    it('a sub-agent lifecycle inside the turn is not the session turn', () => {
        expect(findDanglingTurn([marker(1, 'turn-start', 'T1'), marker(2, 'turn-start', 'child', { subagent: 'sa1' })])).toEqual({ turn: 'T1' })
    })
})

describe('B-942 danglingTurnVerdict', () => {
    it('a kill or crash is a failed turn that says what happened; a stop asked for is cancelled', () => {
        expect(danglingTurnVerdict({ code: null, signal: 'SIGKILL' }, false)).toEqual({ status: 'failed', error: 'The session process was killed (SIGKILL) before this turn ended. Send a message to continue.' })
        expect(danglingTurnVerdict({ code: 1, signal: null }, false).error).toContain('exited (code 1)')
        expect(danglingTurnVerdict(undefined, false).error).toContain('process exited before')
        expect(danglingTurnVerdict({ code: null, signal: 'SIGTERM' }, true)).toEqual({ status: 'cancelled', error: 'The session was stopped before this turn ended.' })
    })
})

describe('B-942 closeDanglingTurn', () => {
    const persisted = { encryptionKey: encodeBase64(new Uint8Array(32)), encryptionVariant: 'legacy' as const } as any

    it('writes the turn-end the wrapper owed; `sessions read` then sees the turn ended with the reason', async () => {
        const log = [user(1, 'run hang.sh'), marker(2, 'turn-start', 'T1'), text(3, 'T1', 'running it now')]
        expect(analyzeLatestTurn(log).ended).toBe(false)
        const post = vi.fn(async () => undefined)
        const turn = await closeDanglingTurn('s1', persisted, danglingTurnVerdict({ code: null, signal: 'SIGKILL' }, false), { readLog: async () => log, post })
        expect(turn).toBe('T1')
        expect(post).toHaveBeenCalledTimes(1)
        const [sessionId, content, localId] = post.mock.calls[0] as unknown as [string, string, string]
        expect(sessionId).toBe('s1')
        expect(localId).toBe('turn-end-after-exit-T1')
        const body = decrypt(new Uint8Array(32), 'legacy', decodeBase64(content)) as any
        expect(body).toMatchObject({ role: 'session', content: { role: 'agent', turn: 'T1', ev: { t: 'turn-end', status: 'failed' } } })
        const after = analyzeLatestTurn([...log, { seq: 4, body }])
        expect(after).toMatchObject({ ended: true, status: 'failed', error: expect.stringContaining('killed (SIGKILL)') })
    })

    it('a prompt steered into the dead turn ends with it; one queued behind it stays open for the next wrapper', async () => {
        const steered = { seq: 4, body: { role: 'user', content: { type: 'text', text: 'and?' }, meta: { delivery: 'steer' } }, localId: 'u4' }
        const base = [user(1, 'q'), marker(2, 'turn-start', 'T1'), text(3, 'T1', 'x')]
        let body: unknown
        const capture = async (_s: string, content: string) => { body = decrypt(new Uint8Array(32), 'legacy', decodeBase64(content)) }
        await closeDanglingTurn('s1', persisted, danglingTurnVerdict(undefined, false), { readLog: async () => [...base, steered], post: capture })
        expect(analyzeLatestTurn([...base, steered, { seq: 5, body }]).ended).toBe(true)
        await closeDanglingTurn('s1', persisted, danglingTurnVerdict(undefined, false), { readLog: async () => [...base, user(4, 'next')], post: capture })
        expect(analyzeLatestTurn([...base, user(4, 'next'), { seq: 5, body }]).ended).toBe(false)
    })

    it('writes nothing when the wrapper ended its turn itself', async () => {
        const post = vi.fn(async () => undefined)
        expect(await closeDanglingTurn('s1', persisted, danglingTurnVerdict(undefined, false), { readLog: async () => [marker(1, 'turn-start', 'T1'), marker(2, 'turn-end', 'T1')], post })).toBeNull()
        expect(post).not.toHaveBeenCalled()
    })
})
