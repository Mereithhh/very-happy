import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    FORK_BACKFILL_CAPABILITY,
    ForkBackfillTimeoutError,
    publishForkBackfillWhenCommitted,
    readForkBackfillMarker,
    waitForForkBackfill,
} from './forkBackfill'
import type { Metadata } from '@/api/types'

/** Strip comments so a source assertion cannot be satisfied by the comment explaining it. */
const code = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

function fakeClock() {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('B-531 readForkBackfillMarker', () => {
    it('accepts only done:true', () => {
        expect(readForkBackfillMarker(null)).toBeNull()
        expect(readForkBackfillMarker({})).toBeNull()
        expect(readForkBackfillMarker({ forkBackfill: { done: false, count: 3 } })).toBeNull()
        expect(readForkBackfillMarker({ forkBackfill: 'done' })).toBeNull()
        expect(readForkBackfillMarker({ forkBackfill: { done: true, count: 95, completedAt: 7 } })).toEqual({ done: true, count: 95, completedAt: 7 })
        expect(readForkBackfillMarker({ forkBackfill: { done: true, failed: true } })).toEqual({ done: true, count: 0, failed: true, completedAt: 0 })
    })
})

describe('B-531 waitForForkBackfill (CLI side)', () => {
    it('a wrapper without the capability is not waited for (old wrapper → old behaviour, no hang)', async () => {
        const readMetadata = vi.fn()
        await expect(waitForForkBackfill({ capabilities: ['claude-steer-v1'], readMetadata })).resolves.toEqual({ kind: 'legacy-wrapper' })
        await expect(waitForForkBackfill({ capabilities: null, readMetadata })).resolves.toEqual({ kind: 'legacy-wrapper' })
        expect(readMetadata).not.toHaveBeenCalled()
    })

    it('polls until the marker appears, retrying read errors', async () => {
        const clock = fakeClock()
        const readMetadata = vi.fn()
            .mockResolvedValueOnce({ path: '/x' })
            .mockRejectedValueOnce(new Error('502'))
            .mockResolvedValueOnce({ path: '/x', forkBackfill: { done: true, count: 4, completedAt: 1 } })
        const gate = await waitForForkBackfill({ capabilities: [FORK_BACKFILL_CAPABILITY], readMetadata, pollMs: 100, ...clock })
        expect(gate).toEqual({ kind: 'confirmed', marker: { done: true, count: 4, completedAt: 1 } })
        expect(readMetadata).toHaveBeenCalledTimes(3)
    })

    it('a capable wrapper that never confirms is a timeout error, not a send', async () => {
        const clock = fakeClock()
        const readMetadata = vi.fn().mockResolvedValue({ path: '/x' })
        await expect(waitForForkBackfill({ capabilities: [FORK_BACKFILL_CAPABILITY], readMetadata, timeoutMs: 1_000, pollMs: 100, ...clock }))
            .rejects.toBeInstanceOf(ForkBackfillTimeoutError)
        expect(readMetadata.mock.calls.length).toBeGreaterThanOrEqual(10)
    })
})

describe('B-531 publishForkBackfillWhenCommitted (wrapper side)', () => {
    it('writes the marker only after the outbox drained', async () => {
        let release!: (ok: boolean) => void
        const updates: Array<(m: Metadata) => Metadata> = []
        const session = {
            drainOutbox: () => new Promise<boolean>((resolve) => { release = resolve }),
            updateMetadata: (handler: (m: Metadata) => Metadata) => { updates.push(handler) },
        }
        const published = publishForkBackfillWhenCommitted(session, { count: 95 }, () => 42)
        await Promise.resolve()
        expect(updates).toHaveLength(0)
        release(true)
        await expect(published).resolves.toBe(true)
        expect(updates).toHaveLength(1)
        expect(updates[0]({ path: '/x' } as Metadata).forkBackfill).toEqual({ done: true, count: 95, completedAt: 42 })
    })

    it('no marker when the client closed before the server confirmed', async () => {
        const updateMetadata = vi.fn()
        await expect(publishForkBackfillWhenCommitted({ drainOutbox: async () => false, updateMetadata }, { count: 3 })).resolves.toBe(false)
        await expect(publishForkBackfillWhenCommitted({ drainOutbox: async () => { throw new Error('x') }, updateMetadata }, { count: 3 })).resolves.toBe(false)
        expect(updateMetadata).not.toHaveBeenCalled()
    })
})

describe('B-531 wiring (source assertions, verified with mutation-check)', () => {
    it('both runners advertise the capability', () => {
        expect(code('claude/runClaude.ts')).toContain("PROMPT_QUEUE_CAPABILITY, FORK_BACKFILL_CAPABILITY],")
        expect(code('codex/runCodex.ts')).toContain('capabilities: [PROMPT_QUEUE_CAPABILITY, FORK_BACKFILL_CAPABILITY],')
    })

    it('Claude fork replay publishes the marker after the replay loop and on a failed read', () => {
        const source = code('claude/runClaude.ts')
        const loop = source.indexOf('session.sendClaudeSessionMessage(result.data as RawJSONLines);')
        const ok = source.indexOf('void publishForkBackfillWhenCommitted(session, { count: backfilled })')
        const failed = source.indexOf('void publishForkBackfillWhenCommitted(session, { count: 0, failed: true });')
        expect(loop).toBeGreaterThan(-1)
        expect(ok).toBeGreaterThan(loop)
        expect(failed).toBeGreaterThan(ok)
    })

    it('Codex fork replay publishes the marker after the replay loop and on a failed read', () => {
        const source = code('codex/runCodex.ts')
        const loop = source.indexOf('const envelopes = mapCodexThreadToSessionEnvelopes(thread);')
        const ok = source.indexOf('void publishForkBackfillWhenCommitted(session, { count: envelopes.length });')
        const failed = source.indexOf('void publishForkBackfillWhenCommitted(session, { count: 0, failed: true });')
        expect(loop).toBeGreaterThan(-1)
        expect(ok).toBeGreaterThan(loop)
        expect(failed).toBeGreaterThan(ok)
    })

    it('spawn gates the first message of a fork (and only of a fork)', () => {
        const source = code('commands/spawn.ts')
        expect(source).toContain('}), { fork: forkSource !== null })')
        const gate = source.indexOf('if (opts.fork) {')
        const wait = source.indexOf('const gate = await waitForForkBackfill({')
        const send = source.indexOf("await deps.sendUserMessage(sessionId, persisted, text, 'cli-spawn', meta)")
        expect(gate).toBeGreaterThan(-1)
        expect(wait).toBeGreaterThan(gate)
        expect(send).toBeGreaterThan(wait)
    })
})
