/**
 * Unit tests for the assistant spawn helpers (B-051 review fixes C2/C3):
 * singleton detection, sessions.json selection, --resume id resolution and
 * the in-flight spawn gate semantics.
 */

import { describe, expect, it } from 'vitest'
import type { TrackedSession } from '@/daemon/types'
import type { PersistedSession } from '@/persistence'
import type { Metadata } from '@/api/types'
import {
    createSpawnGate,
    findLiveAssistant,
    isAssistantTracked,
    listPersistedAssistantIds,
    pickLatestAssistantEntry,
    resolveAssistantClaudeSessionId,
} from './assistantSpawn'

function tracked(partial: Partial<TrackedSession> & { pid: number }): TrackedSession {
    return { startedBy: 'daemon', ...partial }
}

function meta(partial: Partial<Metadata>): Metadata {
    return { path: '/tmp', host: 'h', homeDir: '/', happyHomeDir: '/', happyLibDir: '/', happyToolsDir: '/', ...partial }
}

function persisted(partial: Partial<PersistedSession>): PersistedSession {
    return {
        encryptionKey: 'a2V5',
        encryptionVariant: 'dataKey',
        seq: 0,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: meta({}),
        savedAt: 0,
        ...partial,
    }
}

describe('isAssistantTracked / findLiveAssistant', () => {
    it('recognizes a session tagged at spawn time, BEFORE the webhook lands (C2b)', () => {
        const t = tracked({ pid: 100, variant: 'assistant' }) // no webhook metadata yet
        expect(isAssistantTracked(t)).toBe(true)
        expect(findLiveAssistant([t], () => true)).toBe(t)
    })

    it('recognizes a session tagged via webhook metadata (externally started assistant)', () => {
        const t = tracked({
            pid: 100,
            happySessionId: 's1',
            happySessionMetadataFromLocalWebhook: meta({ variant: 'assistant' }),
        })
        expect(findLiveAssistant([t], () => true)).toBe(t)
    })

    it('ignores non-assistant sessions and dead assistant processes', () => {
        const normal = tracked({ pid: 1, happySessionId: 's1', happySessionMetadataFromLocalWebhook: meta({}) })
        const dead = tracked({ pid: 2, variant: 'assistant' })
        expect(findLiveAssistant([normal, dead], (pid) => pid !== 2)).toBeUndefined()
    })

    it('returns the alive assistant among stale entries', () => {
        const stale = tracked({ pid: 2, variant: 'assistant' })
        const alive = tracked({ pid: 3, variant: 'assistant', happySessionId: 's3' })
        expect(findLiveAssistant([stale, alive], (pid) => pid === 3)).toBe(alive)
    })
})

describe('persisted assistant entries', () => {
    const sessions: Record<string, PersistedSession> = {
        'norm': persisted({ savedAt: 50 }),
        'old-assistant': persisted({ metadata: meta({ variant: 'assistant' }), savedAt: 10 }),
        'new-assistant': persisted({ metadata: meta({ variant: 'assistant' }), savedAt: 20 }),
    }

    it('listPersistedAssistantIds returns only assistant-variant ids', () => {
        expect(listPersistedAssistantIds(sessions).sort()).toEqual(['new-assistant', 'old-assistant'])
        expect(listPersistedAssistantIds({})).toEqual([])
    })

    it('pickLatestAssistantEntry picks the most recently saved assistant entry', () => {
        const entry = pickLatestAssistantEntry(sessions)
        expect(entry?.[0]).toBe('new-assistant')
        expect(pickLatestAssistantEntry({ norm: sessions['norm'] })).toBeUndefined()
    })
})

describe('resolveAssistantClaudeSessionId (C3)', () => {
    it('prefers the fresh server metadata over the stale sessions.json snapshot', () => {
        expect(resolveAssistantClaudeSessionId(
            meta({ claudeSessionId: 'stale-id' }),
            meta({ claudeSessionId: 'fresh-id' }),
        )).toBe('fresh-id')
    })

    it('uses the server metadata even when the snapshot has none (the actual bug: id assigned after the webhook)', () => {
        expect(resolveAssistantClaudeSessionId(
            meta({}), // webhook snapshot: Claude id not assigned yet
            meta({ claudeSessionId: 'fresh-id' }),
        )).toBe('fresh-id')
    })

    it('does NOT fall back to the snapshot when the server copy exists but has no id', () => {
        expect(resolveAssistantClaudeSessionId(
            meta({ claudeSessionId: 'stale-id' }),
            meta({}),
        )).toBeUndefined()
    })

    it('falls back to the snapshot only when the server fetch failed', () => {
        expect(resolveAssistantClaudeSessionId(meta({ claudeSessionId: 'stale-id' }), null)).toBe('stale-id')
        expect(resolveAssistantClaudeSessionId(undefined, null)).toBeUndefined()
    })
})

describe('createSpawnGate (C2a)', () => {
    it('collapses concurrent joins into a single run', async () => {
        const gate = createSpawnGate<string>()
        let calls = 0
        let release!: (v: string) => void
        const fn = () => {
            calls++
            return new Promise<string>((resolve) => { release = resolve })
        }
        const p1 = gate.join(fn)
        const p2 = gate.join(fn)
        expect(gate.inFlight()).toBe(true)
        release('session-1')
        await expect(p1).resolves.toBe('session-1')
        await expect(p2).resolves.toBe('session-1')
        expect(calls).toBe(1)
        expect(gate.inFlight()).toBe(false)
    })

    it('runs again after the previous run settled', async () => {
        const gate = createSpawnGate<number>()
        expect(await gate.join(async () => 1)).toBe(1)
        expect(await gate.join(async () => 2)).toBe(2)
    })

    it('propagates a rejection to all joiners and clears the in-flight slot', async () => {
        const gate = createSpawnGate<string>()
        let reject!: (e: Error) => void
        const p1 = gate.join(() => new Promise<string>((_r, rej) => { reject = rej }))
        const p2 = gate.join(async () => 'never-called')
        reject(new Error('boom'))
        await expect(p1).rejects.toThrow('boom')
        await expect(p2).rejects.toThrow('boom')
        expect(gate.inFlight()).toBe(false)
        // The gate recovers: the next join starts a fresh run.
        expect(await gate.join(async () => 'ok')).toBe('ok')
    })

    it('replace waits for the in-flight run to settle, then runs its own fn (forceNew)', async () => {
        const gate = createSpawnGate<string>()
        const order: string[] = []
        let releaseFirst!: (v: string) => void
        const first = gate.join(() => new Promise<string>((resolve) => {
            order.push('first-started')
            releaseFirst = resolve
        }))
        const second = gate.replace(async () => {
            order.push('second-started')
            return 'fresh'
        })
        // replace must not have started while the first run is in flight.
        await new Promise((r) => setTimeout(r, 10))
        expect(order).toEqual(['first-started'])
        releaseFirst('old')
        await expect(first).resolves.toBe('old')
        await expect(second).resolves.toBe('fresh')
        expect(order).toEqual(['first-started', 'second-started'])
    })

    it('replace ignores the in-flight run failing — it still starts fresh', async () => {
        const gate = createSpawnGate<string>()
        let rejectFirst!: (e: Error) => void
        const first = gate.join(() => new Promise<string>((_r, rej) => { rejectFirst = rej }))
        const second = gate.replace(async () => 'fresh')
        rejectFirst(new Error('spawn failed'))
        await expect(first).rejects.toThrow('spawn failed')
        await expect(second).resolves.toBe('fresh')
    })
})
