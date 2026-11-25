/**
 * B-974e: a session row without a data key (legacy CLI credentials) is marked
 * `legacyKey`, so the session header can explain why plugin widgets are refused.
 */
import { describe, expect, it, vi } from 'vitest';
import { decodeSessionRows, type SessionCrypto } from './sessionDecode';

const crypto = {
    decryptEncryptionKey: vi.fn(async () => new Uint8Array([1])),
    initializeSessions: vi.fn(async () => {}),
    getSessionEncryption: () => ({ decryptMetadata: async () => ({}), decryptAgentState: async () => null }),
} as unknown as SessionCrypto;
const row = (id: string, dataEncryptionKey: string | null) => ({ id, seq: 0, metadata: '{}', metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey, active: true, activeAt: 1, createdAt: 1, updatedAt: 1 });

describe('decodeSessionRows legacyKey', () => {
    it('is true only for rows without a data key', async () => {
        const out = await decodeSessionRows(crypto, [row('legacy', null), row('keyed', 'a2V5')]);
        expect(out.map((s) => [s.id, s.legacyKey])).toEqual([['legacy', true], ['keyed', false]]);
    });
});
