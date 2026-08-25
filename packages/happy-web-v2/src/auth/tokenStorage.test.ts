import { describe, expect, it } from 'vitest';
import { isE2eeAuthCredentials, parseStoredAuthCredentials } from './tokenStorage';

const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const signature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('persisted auth credentials', () => {
    it('accepts the legacy two-field record unchanged', () => {
        expect(parseStoredAuthCredentials(JSON.stringify({ token: 'legacy-token', secret: key }))).toEqual({
            token: 'legacy-token',
            secret: key,
        });
    });

    it('accepts a public-only E2EE bearer record', () => {
        const credentials = parseStoredAuthCredentials(JSON.stringify({
            version: 2,
            token: 'e2ee-token',
            origin: 'https://happy.example',
            accountId: 'account_1',
            deviceId: 'device_1',
            cryptoMode: 'e2ee-v1',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 1,
            recoveryAuthorityPublicKey: key,
            contentPublicKey: key,
            contentKeySignature: signature,
        }));
        expect(credentials && isE2eeAuthCredentials(credentials)).toBe(true);
        expect(credentials).not.toHaveProperty('secret');
        expect(credentials).not.toHaveProperty('legacySecret');
    });

    it.each([
        { token: 'x', secret: key, extra: true },
        { token: 'x', secret: 'not-a-key' },
        { version: 2, token: 'x', cryptoMode: 'e2ee-v1', secret: key },
        {
            version: 2,
            token: 'x',
            origin: 'http://relay.example',
            accountId: 'account_1',
            deviceId: 'device_1',
            cryptoMode: 'e2ee-v1',
            e2eeProtocol: 'vh-e2ee-1',
            cryptoEpoch: 1,
            recoveryAuthorityPublicKey: key,
            contentPublicKey: key,
            contentKeySignature: signature,
        },
    ])('rejects malformed or secret-bearing records %#', (value) => {
        expect(parseStoredAuthCredentials(JSON.stringify(value))).toBeNull();
    });
});
