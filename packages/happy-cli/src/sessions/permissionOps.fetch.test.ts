import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeBase64, getRandomBytes } from '@/api/encryption'
import type { PersistedSession } from '@/persistence'

const { mockAxiosGet } = vi.hoisted(() => ({ mockAxiosGet: vi.fn() }))

vi.mock('axios', () => ({
    default: { get: mockAxiosGet },
}))

import { resolvePermissionRequest } from './permissionOps'

const SID = 'cmtl3c0x7001vqr29o8nmclno'

const persisted: PersistedSession = {
    encryptionKey: encodeBase64(getRandomBytes(32)),
    encryptionVariant: 'dataKey',
    savedAt: 1,
} as unknown as PersistedSession

/**
 * The real agentState fetcher (not injectable) maps the server's 404 to a
 * readable refusal instead of letting axios's "Request failed with status
 * code 404" through (review item 2).
 */
describe('resolvePermissionRequest — real fetcher, session unknown to the account', () => {
    // Braces matter: vitest treats a beforeEach return value as a cleanup
    // hook, and mockReset() returns the mock itself.
    beforeEach(() => { mockAxiosGet.mockReset() })

    it('turns a 404 from /v1/sessions/:id into "not found on this account" before any RPC', async () => {
        mockAxiosGet.mockImplementation(async (_url: string, config?: { validateStatus?: (s: number) => boolean }) => {
            // Mirror axios: a status the caller does not accept becomes a throw.
            if (!config?.validateStatus?.(404)) throw new Error('Request failed with status code 404')
            return { status: 404, data: { error: 'Session not found' } }
        })
        const openTransport = vi.fn()
        await expect(resolvePermissionRequest(SID, 'req-1', { kind: 'approve' }, {
            readPersisted: () => ({ [SID]: persisted }),
            bearerToken: async () => 'tok',
            openTransport,
        })).rejects.toThrow(/Session cmtl3c0x7001vqr29o8nmclno was not found on this account/)
        expect(openTransport).not.toHaveBeenCalled()
        expect(mockAxiosGet).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/sessions\/cmtl3c0x7001vqr29o8nmclno$/), expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }))
    })

    it('still lets other HTTP failures surface as-is (only 404 is a business answer)', async () => {
        mockAxiosGet.mockImplementation(async (_url: string, config?: { validateStatus?: (s: number) => boolean }) => {
            if (!config?.validateStatus?.(500)) throw new Error('Request failed with status code 500')
            return { status: 500, data: {} }
        })
        await expect(resolvePermissionRequest(SID, 'req-1', { kind: 'approve' }, {
            readPersisted: () => ({ [SID]: persisted }),
            bearerToken: async () => 'tok',
            openTransport: vi.fn(),
        })).rejects.toThrow(/status code 500/)
    })
})
