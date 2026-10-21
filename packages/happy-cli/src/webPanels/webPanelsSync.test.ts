import { describe, expect, it, vi } from 'vitest'
import { startWebPanelsSync } from './webPanelsSync'

function harness(initial: { mtime: number | null; raw: unknown }) {
    const state = { ...initial }
    const publish = vi.fn()
    const logProblems = vi.fn()
    const sync = startWebPanelsSync({
        statMtime: async () => state.mtime,
        readRaw: async () => state.raw,
        publish, logProblems, intervalMs: 60_000,
    })
    return { state, publish, logProblems, sync }
}

describe('B-510 web panels sync', () => {
    it('publishes on start and again only when the file changes', async () => {
        const h = harness({ mtime: 1, raw: [{ id: 'a', url: 'https://a.example.com' }] })
        await h.sync.tick(); await h.sync.tick()
        expect(h.publish).toHaveBeenCalledTimes(1)
        expect(h.publish.mock.calls[0][0]).toEqual([{ id: 'a', title: 'a', url: 'https://a.example.com/', embed: true }])
        h.state.mtime = 2; h.state.raw = []
        await h.sync.tick()
        expect(h.publish).toHaveBeenCalledTimes(2)
        expect(h.publish.mock.calls[1][0]).toEqual([])
        h.sync.stop()
    })

    it('a deleted file publishes an empty list; problems are logged once per distinct set', async () => {
        const h = harness({ mtime: 1, raw: [{ id: 'x', url: 'http://10.0.0.2/' }] })
        await h.sync.tick()
        h.state.mtime = 2
        await h.sync.tick()
        expect(h.logProblems).toHaveBeenCalledTimes(1)
        h.state.mtime = null
        await h.sync.tick()
        expect(h.publish.mock.calls.at(-1)![0]).toEqual([])
        h.sync.stop()
    })

    it('a read error mid-write is retried on the next tick', async () => {
        const h = harness({ mtime: 1, raw: [] })
        await h.sync.tick()
        let fail = true
        h.state.mtime = 2
        const readRaw = vi.fn(async () => { if (fail) throw new Error('partial'); return [{ id: 'b', url: 'https://b.example.com' }] })
        const s2 = startWebPanelsSync({ statMtime: async () => h.state.mtime, readRaw, publish: h.publish, logProblems: h.logProblems, intervalMs: 60_000 })
        await s2.tick()
        fail = false
        await s2.tick()
        expect(h.publish.mock.calls.at(-1)![0][0].id).toBe('b')
        s2.stop(); h.sync.stop()
    })
})
