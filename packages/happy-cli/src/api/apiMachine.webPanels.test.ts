import { describe, expect, it, vi } from 'vitest'
import { ApiMachineClient } from './apiMachine'

/** setWebPanels against a minimal `this` (the socket/CAS machinery is not under test). */
function fakeClient() {
    const writes: any[] = []
    const self: any = {
        socket: { connected: true },
        cliUpdatePushChain: Promise.resolve(),
        webPanels: null,
        webPanelsSignatureSent: null,
        updateDaemonState: vi.fn(async (handler: (s: any) => any) => { writes.push(handler({ status: 'running', other: 1 })) }),
    }
    return { self, writes, set: (panels: any[]) => (ApiMachineClient.prototype as any).setWebPanels.call(self, panels) }
}

const A = [{ id: 'a', title: 'A', url: 'https://a.example.com/', embed: true }]

describe('B-510 ApiMachineClient.setWebPanels', () => {
    it('writes daemonState.webPanels once and skips an unchanged list (no CAS / DB write / broadcast)', async () => {
        const c = fakeClient()
        await c.set(A)
        await c.set(A.map((p) => ({ ...p })))
        expect(c.self.updateDaemonState).toHaveBeenCalledTimes(1)
        expect(c.writes[0]).toMatchObject({ status: 'running', other: 1, webPanels: { panels: A } })
        await c.set([])
        expect(c.self.updateDaemonState).toHaveBeenCalledTimes(2)
        expect(c.writes[1].webPanels.panels).toEqual([])
    })

    it('offline: remembers the list for the connect snapshot but writes nothing', async () => {
        const c = fakeClient()
        c.self.socket.connected = false
        await c.set(A)
        expect(c.self.updateDaemonState).not.toHaveBeenCalled()
        expect(c.self.webPanels).toEqual(A)
    })
})
