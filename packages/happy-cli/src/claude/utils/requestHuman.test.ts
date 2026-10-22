import { describe, expect, it, vi } from 'vitest'
import { createRequestHuman, requestHumanResultText } from './requestHuman'

function setup(over: Partial<Parameters<typeof createRequestHuman>[0]> = {}) {
    let t = 1_000_000
    const reportBlocked = vi.fn(async (_reason: string) => undefined)
    const sendAttention = vi.fn(async (_input: { sessionId: string; reason: string; url: string }) => ({ sent: true, kind: 'attention' }))
    const fn = createRequestHuman({
        sessionId: 's1', machineId: () => 'm1',
        readPanels: async () => [{ id: 'desktop', url: 'https://dev.example.ts.net/vnc.html' }],
        reportBlocked, sendAttention, now: () => t, ...over,
    })
    return { fn, reportBlocked, sendAttention, advance: (ms: number) => { t += ms } }
}

describe('B-510 request_human', () => {
    it('marks the board blocked and pushes with the panel deep link when the panel is declared', async () => {
        const h = setup()
        const r = await h.fn('  captcha on   login page ', 'desktop')
        expect(h.reportBlocked).toHaveBeenCalledWith('captcha on login page')
        expect(h.sendAttention).toHaveBeenCalledWith({ sessionId: 's1', reason: 'captcha on login page', url: '/machine/m1/panel/desktop' })
        expect(r).toMatchObject({ notified: true, url: '/machine/m1/panel/desktop' })
    })

    it('an undeclared panel falls back to the session link and says so', async () => {
        const h = setup()
        const r = await h.fn('2FA code', 'nope')
        expect(h.sendAttention.mock.calls[0][0].url).toBe('/session/s1')
        expect(r.unknownPanel).toBe('nope')
        expect(requestHumanResultText(r)).toContain('not declared')
    })

    it('the same reason within 60 s refreshes the board but does not push again; later or different reasons do', async () => {
        const h = setup()
        await h.fn('scan the QR code')
        h.advance(30_000)
        expect(await h.fn('scan the QR code')).toMatchObject({ deduped: true })
        expect(h.reportBlocked).toHaveBeenCalledTimes(2)
        expect(h.sendAttention).toHaveBeenCalledTimes(1)
        await h.fn('approve OAuth consent')
        h.advance(61_000)
        await h.fn('approve OAuth consent')
        expect(h.sendAttention).toHaveBeenCalledTimes(3)
    })

    it('rejects an empty reason and caps a long one at 200 chars', async () => {
        const h = setup()
        expect((await h.fn('   ')).error).toMatch(/non-empty/)
        await h.fn('x'.repeat(500))
        expect(h.sendAttention.mock.calls[0][0].reason).toHaveLength(200)
    })

    it('a failed push is reported and not remembered for dedupe', async () => {
        const send = vi.fn(async (_input: { sessionId: string; reason: string; url: string }) => ({ sent: false, error: 'offline' }))
        const h = setup({ sendAttention: send })
        expect(requestHumanResultText(await h.fn('need you'))).toContain('Could not notify')
        await h.fn('need you')
        expect(send).toHaveBeenCalledTimes(2)
    })

    // B-766: a server with the briefing board takes the ask as a `blocked` item and pushes once itself.
    it('posts a blocked board item instead of pushing when the server has the board, keeping the metadata write', async () => {
        const postBlocked = vi.fn(async (_reason: string, _panel?: string) => true)
        const h = setup({ postBlocked })
        const r = await h.fn('scan the QR code', 'desktop')
        expect(h.reportBlocked).toHaveBeenCalledWith('scan the QR code')
        expect(postBlocked).toHaveBeenCalledWith('scan the QR code', 'desktop')
        expect(h.sendAttention).not.toHaveBeenCalled()
        expect(r).toMatchObject({ notified: true, board: true })
        expect(requestHumanResultText(r)).toContain('briefing board')
        // An undeclared panel is not linked on the item.
        await h.fn('2FA code', 'nope')
        expect(postBlocked).toHaveBeenLastCalledWith('2FA code', undefined)
    })

    it('falls back to the push path when the server has no board or the post fails', async () => {
        for (const postBlocked of [vi.fn(async () => false), vi.fn(async () => { throw new Error('offline') })]) {
            const h = setup({ postBlocked })
            expect(await h.fn('need you')).toMatchObject({ notified: true, url: '/session/s1' })
            expect(h.sendAttention).toHaveBeenCalledTimes(1)
        }
    })
})
