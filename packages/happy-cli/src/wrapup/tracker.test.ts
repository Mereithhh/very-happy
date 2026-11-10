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

describe('B-915b: a taken request left unanswered turns the card incomplete at turn end', () => {
    const statuses = (posts: AttentionItemPost[]) => posts.map((p) => [p.key, (p.payload as { status: string }).status, (p.payload as { localId?: string }).localId])

    it('wrap-up turn ends without wrapup_report → incomplete card (keyed, anchored, idempotent request id), running cleared', async () => {
        const { tracker, posts } = setup()
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        tracker.onTurnStart(['wrapup-n1'])
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts)).toEqual([['wrapup', 'running', 'wrapup-n1'], ['wrapup', 'incomplete', 'wrapup-n1']])
        expect(posts[1]).toMatchObject({ kind: 'wrapup', key: 'wrapup', anchor: { localId: 'wrapup-n1' }, requestId: 'incomplete-wrapup-n1', payload: { mode: 'wrapup', startedAt: 1000 } })
        expect(tracker.runningAction('wrapup')).toBeNull()
        // A second turn end posts nothing more.
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(posts).toHaveLength(2)
    })

    it('handoff turn ends without handoff_send → incomplete handoff card', async () => {
        const { tracker, posts } = setup()
        tracker.onUserMessage({ localId: 'handoff-h1' })
        tracker.onTurnStart(['handoff-h1'])
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts).at(-1)).toEqual(['handoff', 'incomplete', 'handoff-h1'])
    })

    it('the tool was called → no incomplete card', async () => {
        const { tracker, posts } = setup()
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        tracker.onUserMessage({ localId: 'handoff-h1' })
        tracker.onTurnStart(['wrapup-n1', 'handoff-h1'])
        await tracker.report({ summary: 'done', can_close: true })
        await tracker.handoff({ to: 's2', summary: 'over' })
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts).map(([, s]) => s)).not.toContain('incomplete')
    })

    it('a wrap-up_report that fails to post still counts as answered (no incomplete over the agent\'s text fallback)', async () => {
        let fail = false
        const posts: AttentionItemPost[] = []
        const { tracker } = setup({ client: { post: async (input) => { if (fail) throw new Error('500'); posts.push(input); return { item: { id: 'x' } as never, created: true } } } })
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        tracker.onTurnStart(['wrapup-n1'])
        await tracker.idle()
        fail = true
        expect((await tracker.report({ summary: 'done', can_close: true })).posted).toBe(false)
        fail = false
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts)).toEqual([['wrapup', 'running', 'wrapup-n1']])
    })

    it('a request routed while another turn runs is not marked by THAT turn\'s end, only by its own', async () => {
        const { tracker, posts } = setup()
        tracker.onTurnStart(['plain-1'])
        tracker.onUserMessage({ localId: 'wrapup-n1' }) // queued behind the running turn
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts)).toEqual([['wrapup', 'running', 'wrapup-n1']])
        tracker.onTurnStart(['plain-2']) // another queued turn ahead of it
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts)).toHaveLength(1)
        tracker.onTurnStart(['wrapup-n1'])
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts).at(-1)).toEqual(['wrapup', 'incomplete', 'wrapup-n1'])
    })

    it('a turn start without batch ids (parked replay) takes every routed request', async () => {
        const { tracker, posts } = setup()
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        tracker.onTurnStart()
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts).at(-1)).toEqual(['wrapup', 'incomplete', 'wrapup-n1'])
    })

    it('no turn start at all (runners without one) keeps today\'s behaviour: stays running', async () => {
        const { tracker, posts } = setup()
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(statuses(posts)).toEqual([['wrapup', 'running', 'wrapup-n1']])
        expect(tracker.runningAction('wrapup')).not.toBeNull()
    })

    it('a late wrapup_report after incomplete reposts the card done, still anchored to the request', async () => {
        const { tracker, posts } = setup()
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        tracker.onTurnStart(['wrapup-n1'])
        await tracker.onTurnEnd()
        await tracker.report({ summary: 'late', can_close: true })
        await tracker.idle()
        expect(statuses(posts).at(-1)).toEqual(['wrapup', 'done', 'wrapup-n1'])
    })

    it('no board → no incomplete post', async () => {
        const { tracker, posts } = setup({ boardReady: async () => false })
        tracker.onUserMessage({ localId: 'wrapup-n1' })
        tracker.onTurnStart(['wrapup-n1'])
        await tracker.onTurnEnd()
        await tracker.idle()
        expect(posts).toEqual([])
    })
})
