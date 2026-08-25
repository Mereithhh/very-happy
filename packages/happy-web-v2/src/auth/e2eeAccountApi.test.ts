import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    post: vi.fn(),
    storeKeyring: vi.fn(async () => undefined),
    storeDeviceKeys: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
}));

vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.example' }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'web/test' }));
vi.mock('./e2eeVault', () => ({
    E2eeIndexedDbKeyVault: class {
        storeKeyring = mocks.storeKeyring;
        storeControlDevicePrivateKeys = mocks.storeDeviceKeys;
        remove = mocks.remove;
    },
}));

import {
    E2eeAccountAuthError,
    commitE2eePasswordSignup,
    requestE2eeSignupChallenge,
    startPasswordLoginV2,
} from './e2eeAccountApi';
import { prepareE2eePasswordSignup } from './e2eeAccountSetup';
import { encodeBase64UrlCanonical } from '@/sync/encryption/e2eeEncoding';

const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const signature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('E2EE account API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', { location: { origin: 'https://happy.example' } });
    });

    it('requests a same-origin, short-lived signup reservation', async () => {
        mocks.post.mockResolvedValueOnce({ data: {
            accountId: 'c0a80101-0000-4000-8000-000000000001',
            nonce: encodeBase64UrlCanonical(new Uint8Array(32).fill(1)),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            suite: 'vh-e2ee-1',
        } });
        await expect(requestE2eeSignupChallenge()).resolves.toMatchObject({
            origin: 'https://happy.example',
            challenge: { suite: 'vh-e2ee-1' },
        });
        expect(mocks.post).toHaveBeenCalledWith(
            'https://happy.example/v2/account/signup/challenge',
            {},
            expect.any(Object),
        );
    });

    it('stores local keys before signup and never includes the recovery code in the request', async () => {
        const prepared = await prepareE2eePasswordSignup({
            origin: 'https://happy.example',
            challenge: {
                accountId: 'c0a80101-0000-4000-8000-000000000002',
                nonce: encodeBase64UrlCanonical(new Uint8Array(32).fill(2)),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                suite: 'vh-e2ee-1',
            },
            username: 'alice',
        });
        mocks.post.mockImplementationOnce(async (_url: string, body: Record<string, unknown>) => {
            expect(mocks.storeKeyring).toHaveBeenCalledOnce();
            expect(mocks.storeDeviceKeys).toHaveBeenCalledOnce();
            expect(JSON.stringify(body)).not.toContain(prepared.recoveryCode);
            return { data: {
                token: 'control-token', accountId: prepared.accountId,
                deviceId: prepared.device.id, capabilities: ['e2ee:control'],
                cryptoMode: 'e2ee-v1', cryptoEpoch: 1, e2eeOrigin: prepared.origin,
                recoveryAuthorityPublicKey: prepared.recoveryAuthorityPublicKey,
                contentPublicKey: prepared.contentPublicKey,
                contentKeySignature: prepared.contentKeySignature,
                recoveryCapsule: prepared.recoveryCapsule,
            } };
        });
        await expect(commitE2eePasswordSignup({
            prepared, password: 'correct horse battery staple',
        })).resolves.toMatchObject({
            version: 2, token: 'control-token', cryptoMode: 'e2ee-v1',
        });
        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it('rejects substituted server key material and removes the staged local vault', async () => {
        const prepared = await prepareE2eePasswordSignup({
            origin: 'https://happy.example',
            challenge: {
                accountId: 'c0a80101-0000-4000-8000-000000000003',
                nonce: encodeBase64UrlCanonical(new Uint8Array(32).fill(3)),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                suite: 'vh-e2ee-1',
            },
            username: 'alice',
        });
        mocks.post.mockResolvedValueOnce({ data: {
            token: 'control-token', accountId: prepared.accountId,
            deviceId: prepared.device.id, capabilities: ['e2ee:control'],
            cryptoMode: 'e2ee-v1', cryptoEpoch: 1, e2eeOrigin: prepared.origin,
            recoveryAuthorityPublicKey: key,
            contentPublicKey: prepared.contentPublicKey,
            contentKeySignature: prepared.contentKeySignature,
        } });
        await expect(commitE2eePasswordSignup({ prepared, password: 'password123' }))
            .rejects.toMatchObject({ code: 'server-response-invalid' });
        expect(mocks.remove).toHaveBeenCalledOnce();
    });

    it('keeps trusted-v1 login compatible and rejects an E2EE response carrying escrow', async () => {
        mocks.post.mockResolvedValueOnce({ data: {
            token: 'legacy-token', accountId: 'legacy-account', capabilities: [],
            cryptoMode: 'trusted-v1', cryptoEpoch: 0, legacySecret: key,
        } });
        await expect(startPasswordLoginV2('owner', 'password')).resolves.toEqual({
            kind: 'trusted', credentials: { token: 'legacy-token', secret: key },
        });

        mocks.post.mockImplementationOnce(async (_url: string, body: {
            device: { id: string };
        }) => ({ data: {
            token: 'unlock-token', accountId: 'account-1',
            deviceId: body.device.id,
            capabilities: ['e2ee:unlock'], cryptoMode: 'e2ee-v1', cryptoEpoch: 1,
            e2eeOrigin: 'https://happy.example', recoveryAuthorityPublicKey: key,
            contentPublicKey: key, contentKeySignature: signature,
            recoveryCapsule: {
                v: 1, domain: 'very-happy/vh-e2ee-1/recovery-capsule', suite: 'vh-e2ee-1',
                origin: 'https://happy.example', accountId: 'account-1', currentEpoch: 1,
                recoveryAuthorityPublicKey: key, nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA', signature,
            },
            legacySecret: key,
        } }));
        await expect(startPasswordLoginV2('alice', 'password')).rejects.toBeInstanceOf(E2eeAccountAuthError);
    });
});
