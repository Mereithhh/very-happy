import { describe, expect, it, vi } from 'vitest'
import { waitForModelCatalog } from './spawn'
import { fetchLatestModelTable } from '@/api/latestModels'
import { BUNDLED_LATEST_MODELS } from '@slopus/happy-wire'

// B-844: Codex publishes its catalog after connecting; spawn waits (bounded).
function clock() {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('waitForModelCatalog', () => {
    it('returns at once when the persisted metadata already has a catalog', async () => {
        const read = vi.fn()
        const initial = { models: [{ code: 'gpt-6.1-sol', value: 'gpt-6.1-sol' }] }
        expect(await waitForModelCatalog(read, initial, clock())).toBe(initial)
        expect(read).not.toHaveBeenCalled()
    })

    it('polls until the wrapper publishes its catalog', async () => {
        const reads = [null, { capabilities: [] }, { models: [{ code: 'gpt-6.1-sol', value: 'x' }] }]
        const read = vi.fn(async () => reads.shift() ?? null)
        const result = await waitForModelCatalog(read, undefined, { ...clock(), pollMs: 100, timeoutMs: 5_000 })
        expect(result?.models?.[0]?.code).toBe('gpt-6.1-sol')
        expect(read).toHaveBeenCalledTimes(3)
    })

    it('a reported machine config ends the wait even without a catalog', async () => {
        const read = vi.fn(async () => ({ configuredModel: 'gpt-5.6-sol' }))
        const result = await waitForModelCatalog(read, undefined, { ...clock(), pollMs: 100, timeoutMs: 5_000 })
        expect(result?.configuredModel).toBe('gpt-5.6-sol')
        expect(read).toHaveBeenCalledTimes(1)
    })

    it('gives up at the deadline and keeps the last metadata (no model is sent)', async () => {
        const read = vi.fn(async () => { throw new Error('flaky') })
        const initial = { capabilities: ['x'] }
        const result = await waitForModelCatalog(read, initial, { ...clock(), pollMs: 1_000, timeoutMs: 3_000 })
        expect(result).toBe(initial)
        expect(read).toHaveBeenCalledTimes(3)
    })
})

describe('fetchLatestModelTable', () => {
    it('reads the server table', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ table: BUNDLED_LATEST_MODELS, source: 'bundled' })))
        expect(await fetchLatestModelTable('https://relay', fetcher as unknown as typeof fetch)).toEqual(BUNDLED_LATEST_MODELS)
        expect(fetcher).toHaveBeenCalledWith('https://relay/v1/models/latest', expect.anything())
    })

    it('an old server (404), a bad body or a network error → null (bundled fallback)', async () => {
        expect(await fetchLatestModelTable('https://relay', (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch)).toBeNull()
        expect(await fetchLatestModelTable('https://relay', (async () => new Response(JSON.stringify({ table: { version: 1 } }))) as unknown as typeof fetch)).toBeNull()
        expect(await fetchLatestModelTable('https://relay', (async () => { throw new Error('down') }) as unknown as typeof fetch)).toBeNull()
    })
})
