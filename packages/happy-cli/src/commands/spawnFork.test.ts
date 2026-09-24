import { describe, expect, it, vi } from 'vitest'
vi.mock('@/codex/codexAppServerClient', () => ({ CodexAppServerClient: class {} }))
import { resolveForkSource } from './spawnFork'
import type { PersistedSession } from '@/persistence'

function persisted(metadata: Record<string, unknown>): PersistedSession {
    return { encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0, savedAt: Date.now(), metadata: metadata as any }
}

describe('resolveForkSource (B-492 spawn --fork)', () => {
    it('forks a claude session from its conversation id, keeping directory and mode', () => {
        expect(resolveForkSource('s1', persisted({ path: '/w', claudeSessionId: 'c-1', permissionMode: 'plan' })))
            .toEqual({ agent: 'claude', directory: '/w', claudeSessionId: 'c-1', permissionMode: 'plan', parentSessionId: 's1' })
    })

    it('forks a codex session from its thread id', () => {
        expect(resolveForkSource('s2', persisted({ path: '/w', flavor: 'codex', codexThreadId: 't-1' })))
            .toEqual({ agent: 'codex', directory: '/w', codexThreadId: 't-1', permissionMode: undefined, parentSessionId: 's2' })
    })

    it('refuses what cannot be forked, with a reason', () => {
        expect(() => resolveForkSource('s3', undefined)).toThrow(/no local record/)
        expect(() => resolveForkSource('s4', persisted({ path: '/w' }))).toThrow(/never ran a turn/)
        expect(() => resolveForkSource('s5', persisted({ path: '/w', flavor: 'codex' }))).toThrow(/never ran a turn/)
        expect(() => resolveForkSource('s6', persisted({ path: '/w', flavor: 'gemini', claudeSessionId: 'x' }))).toThrow(/only claude and codex/)
        expect(() => resolveForkSource('s7', persisted({ claudeSessionId: 'x' }))).toThrow(/working directory/)
    })
})
