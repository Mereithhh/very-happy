import { describe, expect, it } from 'vitest'
import { mergeSessionSummaries, type LiveSessionLike } from './sessionOps'
import type { PersistedSession } from '@/persistence'

function persisted(overrides: Partial<PersistedSession['metadata']> = {}, savedAt = 1_000): PersistedSession {
    return {
        encryptionKey: 'a'.repeat(44),
        encryptionVariant: 'legacy',
        seq: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        savedAt,
        metadata: { path: '/tmp/p', flavor: 'claude', ...overrides } as PersistedSession['metadata'],
    }
}

const NO_LIVE: LiveSessionLike[] = []

describe('mergeSessionSummaries (B-304)', () => {
    it('puts running sessions first, then the most recently saved', () => {
        const live: LiveSessionLike[] = [{ happySessionId: 'running-1', pid: 42 }]
        const out = mergeSessionSummaries(live, {
            'running-1': persisted({}, 10),
            'old': persisted({}, 20),
            'newer': persisted({}, 30),
        })
        expect(out.map((s) => s.id)).toEqual(['running-1', 'newer', 'old'])
        expect(out[0]).toMatchObject({ live: true, pid: 42 })
        expect(out[1]).toMatchObject({ live: false })
        expect(out[1].pid).toBeUndefined()
    })

    it('never lists a running session twice', () => {
        const live: LiveSessionLike[] = [{ happySessionId: 'dup' }, { happySessionId: 'dup' }]
        expect(mergeSessionSummaries(live, { dup: persisted() }).map((s) => s.id)).toEqual(['dup'])
    })

    it('excludes terminal-mirror shadows (B-105) from the recent list', () => {
        const out = mergeSessionSummaries(NO_LIVE, {
            real: persisted({ flavor: 'claude' }, 20),
            shadow: persisted({ flavor: 'terminal-mirror' }, 30),
        })
        expect(out.map((s) => s.id)).toEqual(['real'])
    })

    it('a running session is reported even without a persisted entry', () => {
        const out = mergeSessionSummaries([{ happySessionId: 'ghost' }], {})
        expect(out).toHaveLength(1)
        expect(out[0]).toMatchObject({ id: 'ghost', live: true })
        expect(out[0].cwd).toBeUndefined()
        expect(out[0].url).toContain('ghost')
    })

    it('ignores daemon entries with no usable session id', () => {
        const live = [{ pid: 7 }, { happySessionId: 42 }] as unknown as LiveSessionLike[]
        expect(mergeSessionSummaries(live, {})).toEqual([])
    })

    it('recentLimit caps the not-running tail but never the running ones', () => {
        const live: LiveSessionLike[] = [{ happySessionId: 'r1' }, { happySessionId: 'r2' }]
        const out = mergeSessionSummaries(live, {
            a: persisted({}, 1), b: persisted({}, 2), c: persisted({}, 3),
        }, { recentLimit: 1 })
        expect(out.map((s) => s.id)).toEqual(['r1', 'r2', 'c'])
    })

    it('recentLimit 0 keeps only running sessions', () => {
        const out = mergeSessionSummaries([{ happySessionId: 'r1' }], { a: persisted() }, { recentLimit: 0 })
        expect(out.map((s) => s.id)).toEqual(['r1'])
    })

    it('surfaces the origin tag so --tag can filter on it (B-303)', () => {
        const out = mergeSessionSummaries(NO_LIVE, {
            tanka: persisted({ tags: ['tanka'] }, 20),
            manual: persisted({}, 10),
        })
        expect(out.find((s) => s.id === 'tanka')?.tags).toEqual(['tanka'])
        expect(out.find((s) => s.id === 'manual')?.tags).toBeUndefined()
    })

    it('the tag filter keeps only sessions carrying that exact tag', () => {
        const sessions = {
            tanka: persisted({ tags: ['tanka'] }, 30),
            assistant: persisted({ tags: ['assistant'] }, 20),
            manual: persisted({}, 10),
        }
        expect(mergeSessionSummaries(NO_LIVE, sessions, { tag: 'tanka' }).map((s) => s.id)).toEqual(['tanka'])
        expect(mergeSessionSummaries(NO_LIVE, sessions, { tag: 'nope' })).toEqual([])
    })

    it('the tag filter applies to running sessions too', () => {
        const out = mergeSessionSummaries([{ happySessionId: 'r1' }], {
            r1: persisted({ tags: ['tanka'] }),
        }, { tag: 'tanka' })
        expect(out.map((s) => s.id)).toEqual(['r1'])
    })

    it('carries the assistant variant through so the meta-agent is recognisable', () => {
        const out = mergeSessionSummaries(NO_LIVE, {
            meta: persisted({ variant: 'assistant' } as never),
        })
        expect(out[0].variant).toBe('assistant')
    })
})
