import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }))
vi.mock('socket.io-client', () => ({ io: mockIo }))

import { openUserScopedSocket } from './userSocket'
import { configuration } from '@/configuration'

type Handler = (...args: unknown[]) => void

function fakeSocket(behaviour: 'connect' | 'error' | 'hang') {
    const once = new Map<string, Handler>()
    const emitWithAck = vi.fn(async () => ({ ok: true, result: 'x' }))
    const timeout = vi.fn(() => ({ emitWithAck }))
    const socket = {
        once: vi.fn((event: string, handler: Handler) => { once.set(event, handler) }),
        connect: vi.fn(() => {
            if (behaviour === 'connect') queueMicrotask(() => once.get('connect')?.())
            if (behaviour === 'error') queueMicrotask(() => once.get('connect_error')?.(new Error('nope')))
        }),
        close: vi.fn(),
        timeout,
        emitWithAck,
    }
    return socket
}

afterEach(() => { mockIo.mockReset() })

describe('openUserScopedSocket', () => {
    it('opens a user-scoped, non-reconnecting websocket on /v1/updates with the account token', async () => {
        const socket = fakeSocket('connect')
        mockIo.mockReturnValue(socket)
        const transport = await openUserScopedSocket('tok-123')
        expect(mockIo).toHaveBeenCalledTimes(1)
        const [url, opts] = mockIo.mock.calls[0] as [string, Record<string, unknown>]
        expect(url).toBe(configuration.serverUrl)
        expect(opts).toMatchObject({
            auth: { token: 'tok-123', clientType: 'user-scoped' },
            path: '/v1/updates',
            transports: ['websocket'],
            reconnection: false,
            autoConnect: false,
        })
        expect((opts.auth as Record<string, unknown>).sessionId).toBeUndefined()
        expect((opts.auth as Record<string, unknown>).machineId).toBeUndefined()
        expect(String((opts.auth as Record<string, string>).happyClient)).toMatch(/^cli-session-ops\//)

        const ack = await transport.rpcCall({ method: 's:permission', params: 'enc' }, 1234)
        expect(socket.timeout).toHaveBeenCalledWith(1234)
        expect(socket.emitWithAck).toHaveBeenCalledWith('rpc-call', { method: 's:permission', params: 'enc' })
        expect(ack).toEqual({ ok: true, result: 'x' })
        transport.close()
        expect(socket.close).toHaveBeenCalled()
    })

    it('rejects with the server\'s reason on connect_error and closes the socket', async () => {
        const socket = fakeSocket('error')
        mockIo.mockReturnValue(socket)
        await expect(openUserScopedSocket('tok')).rejects.toThrow(/Could not connect .*nope/)
        expect(socket.close).toHaveBeenCalled()
    })

    it('gives up connecting after the bounded timeout instead of hanging the CLI', async () => {
        const socket = fakeSocket('hang')
        mockIo.mockReturnValue(socket)
        await expect(openUserScopedSocket('tok', { connectTimeoutMs: 5 })).rejects.toThrow(/Timed out connecting/)
        expect(socket.close).toHaveBeenCalled()
    })
})
