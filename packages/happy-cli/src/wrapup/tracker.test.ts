import { describe, expect, it, vi } from 'vitest'
import type { AttentionItemPost } from '@slopus/happy-wire'
import { AttentionUnsupportedError } from '@/attention/client'
import { createWrapupTracker, handoffDelivery, WRAPUP_CARD_NOT_WRITTEN, type WrapupTrackerDeps } from './tracker'
import type { SendPeerMessageResult } from '@/sessions/peerTools'

function setup(over: Partial<WrapupTrackerDeps> = {}) {
    const posts: AttentionItemPost[] = []
    const archived: string[] = []
    let n = 0
    const sendPeer = vi.fn(async (): Promise<SendPeerMessageResult> => ({ delivered: true, stored: true, status: 'live', messageId: 'm1', to: 's2', url: 'u' }))
    const tracker = createWrapupTracker({
        sessionId: () => 's1',
        client: { post: async (input) => { posts.push(input); return { item: { id: `i${posts.length}` } as never, created: true } } },
        boardReady: async () => true,
        sendPeer,
        archiveSelf: async (id) => { archived.push(id) },
        now: () => 1000,
        requestId: () => `r${++n}`,
        ...over,
    })
    return { tracker, posts, archived, sendPeer }
}

describe('B-915 wrapup tracker', () => {
    it('a routed wrapup- / handoff- turn posts a running card; other messages do not', async () => {
        const { tracker, posts } = setup()
        tracker.onUserMessage({ localId: 'plain-uuid' })
        tracker.onUserMessage({ localId: null })
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        tracker.onUserMessage({ localId: 'handoff-n2' })
        await tracker.idle()
        expect(posts.map((p) => [p.key, (p.payload as { status: string }).status, (p.payload as { localId: string }).localId])).toEqual([
            ['wrapup', 'running', 'wrapup-n1'], ['handoff', 'running', 'handoff-n2'],
        ])
    })

    it('no board → no running card, and the report says to answer in text', async () => {
        const { tracker, posts } = setup({
            boardReady: async () => false,
            client: { post: async () => { throw new AttentionUnsupportedError() } },
        })
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        await tracker.idle()
        expect(posts).toEqual([])
        expect(await tracker.report({ summary: 'done', can_close: true })).toEqual({ posted: false, note: WRAPUP_CARD_NOT_WRITTEN })
    })

    it('the report reposts the running card with the result and clears the running turn', async () => {
        const { tracker, posts } = setup()
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        await tracker.idle()
        const result = await tracker.report({ summary: 'done', pending: ['ship?'], can_close: false })
        expect(result).toMatchObject({ posted: true, itemId: 'i2' })
        expect(posts[1]).toMatchObject({ key: 'wrapup', anchor: { localId: 'wrapup-n1' }, payload: { status: 'done', localId: 'wrapup-n1', pending: [{ id: 'p1', checked: false }] } })
        expect(tracker.runningAction('wrapup')).toBeNull()
    })

    it('confirmed delivery + archive_after: card, then archive once when the turn ends', async () => {
        const { tracker, posts, archived, sendPeer } = setup()
        tracker.onUserMessage({ localId: 'handoff-n1' })
        await tracker.idle()
        const result = await tracker.handoff({ to: 's2', to_title: 'Target', summary: 'state', artifacts: ['a.md'], archive_after: true, machine_id: 'm2' })
        expect(sendPeer).toHaveBeenCalledWith({ to: 's2', body: 'state\n\nArtifacts:\n- a.md', purpose: 'handoff', machineId: 'm2' })
        expect(result).toMatchObject({ delivery: 'delivered', card: true, archive: 'scheduled' })
        expect(posts[1]).toMatchObject({ key: 'handoff', payload: { status: 'done', localId: 'handoff-n1', handoff: { delivery: 'delivered', archiveAfter: true } } })
        expect(archived).toEqual([])
        await tracker.onTurnEnd()
        await tracker.onTurnEnd()
        expect(archived).toEqual(['s1'])
        expect(posts[2]).toMatchObject({ key: 'handoff', payload: { handoff: { archived: true } } })
    })

    for (const [label, send, delivery] of [
        ['offline-stored', async () => ({ delivered: false, stored: true, status: 'offline-stored', messageId: 'x', to: 's2', url: 'u' }), 'offline-stored'],
        ['wrapper gone after the POST', async () => ({ delivered: false, stored: true, status: 'offline', messageId: 'x', to: 's2', url: 'u', error: 'went offline' }), 'failed'],
        ['a throw (not reachable)', async () => { throw new Error('not located') }, 'failed'],
    ] as const) {
        it(`never archives on ${label}`, async () => {
            const { tracker, posts, archived } = setup({ sendPeer: send as never })
            const result = await tracker.handoff({ to: 's2', summary: 'state', archive_after: true })
            expect(result).toMatchObject({ delivery, archive: 'skipped-unconfirmed' })
            expect((posts[0].payload as { status: string }).status).toBe(delivery === 'failed' ? 'failed' : 'done')
            await tracker.onTurnEnd()
            expect(archived).toEqual([])
        })
    }

    it('without archive_after a delivered handoff stays open', async () => {
        const { tracker, archived } = setup()
        expect(await tracker.handoff({ to: 's2', summary: 'state' })).toMatchObject({ delivery: 'delivered', archive: 'not-requested' })
        await tracker.onTurnEnd()
        expect(archived).toEqual([])
    })

    it('handoffDelivery maps peer results', () => {
        expect(handoffDelivery({ delivered: true, status: 'live' })).toBe('delivered')
        expect(handoffDelivery({ delivered: false, status: 'offline-stored' })).toBe('offline-stored')
        expect(handoffDelivery({ delivered: false, status: 'archived' })).toBe('failed')
    })
})
