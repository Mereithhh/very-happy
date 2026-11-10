import { beforeEach, describe, expect, it, vi } from 'vitest'

const post = vi.hoisted(() => vi.fn())
vi.mock('axios', () => ({ default: { post } }))

import { PushNotificationClient } from './pushNotifications'

const client = () => new PushNotificationClient('tok', 'https://relay.example')

describe('B-510 sendAttention (compat matrix)', () => {
    beforeEach(() => { post.mockReset() })

    it('sends kind attention with the reason as body and the deep link as data.url', async () => {
        post.mockResolvedValueOnce({ data: { success: true } })
        expect(await client().sendAttention({ sessionId: 's1', reason: 'scan QR', url: '/machine/m/panel/p', sessionTitle: 'deploy' })).toEqual({ sent: true, kind: 'attention' })
        const [url, body] = post.mock.calls[0]
        expect(url).toBe('https://relay.example/v1/sessions/s1/push-event')
        expect(body).toMatchObject({ kind: 'attention', title: 'Needs you', body: 'scan QR', data: { kind: 'attention', url: '/machine/m/panel/p', sessionTitle: 'deploy' } })
    })

    it('an old server (400 on the new kind) gets the same push as a question', async () => {
        post.mockRejectedValueOnce({ response: { status: 400 } }).mockResolvedValueOnce({ data: { success: true } })
        expect(await client().sendAttention({ sessionId: 's1', reason: 'r', url: '/session/s1' })).toEqual({ sent: true, kind: 'question' })
        expect(post.mock.calls[1][1]).toMatchObject({ kind: 'question', body: 'r', data: { url: '/session/s1' } })
    })

    it('any other failure is reported, not retried as question', async () => {
        post.mockRejectedValueOnce({ response: { status: 404 } })
        expect(await client().sendAttention({ sessionId: 's1', reason: 'r', url: '/session/s1' })).toEqual({ sent: false, error: 'HTTP 404' })
        expect(post).toHaveBeenCalledTimes(1)
    })
})

describe('B-913 sendTurnFailedNotification', () => {
    beforeEach(() => { post.mockReset() })

    it('rides the done kind with its own words and data.type turn-failed', async () => {
        post.mockResolvedValueOnce({ data: { success: true } })
        client().sendTurnFailedNotification({ sessionId: 's1', metadata: { path: '/w/repo' } as any, provider: 'claude', summary: 'API Error: 400 bad request' })
        await new Promise((r) => setTimeout(r, 0))
        expect(post).toHaveBeenCalledTimes(1)
        const [url, body] = post.mock.calls[0]
        expect(url).toBe('https://relay.example/v1/sessions/s1/push-event')
        expect(body).toMatchObject({ kind: 'done', title: 'Turn failed', body: 'repo · API Error: 400 bad request', data: { kind: 'done', type: 'turn-failed', provider: 'claude', error: 'API Error: 400 bad request', sessionId: 's1', url: '/session/s1' } })
    })

    it('keeps the body within the server limit', async () => {
        post.mockResolvedValueOnce({ data: { success: true } })
        client().sendTurnFailedNotification({ sessionId: 's1', metadata: null, provider: 'codex', summary: 'x'.repeat(800) })
        await new Promise((r) => setTimeout(r, 0))
        expect(post.mock.calls[0][1].body.length).toBeLessThanOrEqual(500)
    })
})
