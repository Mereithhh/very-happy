import { describe, expect, it } from 'vitest'
import { createRpcHandlerManager } from './RpcHandlerManager'
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from '@/api/encryption'

/** B-506: plaintext RPC methods next to the encrypted ones, in one manager. */
describe('RpcHandlerManager.registerPlainHandler', () => {
    const key = getRandomBytes(32)
    const manager = createRpcHandlerManager({ scopePrefix: 'machine-B', encryptionKey: key, encryptionVariant: 'dataKey', logger: () => undefined })
    manager.registerHandler('spawn-happy-session', async (params: any) => ({ type: 'success', sessionId: `spawned-${params.directory}` }))
    manager.registerPlainHandler('sessions.list', async (params: any) => ({ ok: true, result: { got: params } }))
    manager.registerPlainHandler('sessions.read', async () => { throw new Error('boom') })

    it('parses JSON params and returns a JSON string, without touching the machine key', async () => {
        const response = await manager.handleRequest({ method: 'machine-B:sessions.list', params: JSON.stringify({ v: 1, args: { ids: ['s1'] } }) })
        expect(JSON.parse(response)).toEqual({ ok: true, result: { got: { v: 1, args: { ids: ['s1'] } } } })
        expect(manager.isPlainMethod('machine-B:sessions.list')).toBe(true)
        expect(manager.isPlainMethod('machine-B:spawn-happy-session')).toBe(false)
    })

    it('answers malformed JSON and handler throws as plain {error} envelopes', async () => {
        expect(JSON.parse(await manager.handleRequest({ method: 'machine-B:sessions.list', params: '{not json' }))).toEqual({ error: 'Invalid JSON params' })
        expect(JSON.parse(await manager.handleRequest({ method: 'machine-B:sessions.read', params: '{}' }))).toEqual({ error: 'boom' })
    })

    it('keeps encrypted methods encrypted: ciphertext in, ciphertext out', async () => {
        const params = encodeBase64(encrypt(key, 'dataKey', { directory: '/w' }))
        const response = await manager.handleRequest({ method: 'machine-B:spawn-happy-session', params })
        expect(decrypt(key, 'dataKey', decodeBase64(response))).toEqual({ type: 'success', sessionId: 'spawned-/w' })
        // A plaintext request against an encrypted method is not silently accepted.
        const bad = await manager.handleRequest({ method: 'machine-B:spawn-happy-session', params: '{"directory":"/w"}' })
        expect(decrypt(key, 'dataKey', decodeBase64(bad))).toMatchObject({ error: expect.any(String) })
    })

    it('unregister drops the plain flag too', () => {
        manager.unregisterHandler('sessions.list')
        expect(manager.isPlainMethod('machine-B:sessions.list')).toBe(false)
        expect(manager.hasHandler('sessions.list')).toBe(false)
    })
})
