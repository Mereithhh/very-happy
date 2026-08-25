import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eeRuntimeKeys } from '@/auth/e2eeRuntime';
import type { E2eeAuthCredentials } from '@/auth/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { bindAccountEncryption, clearAccountEncryption } from './accountEncryptionRuntime';
import { Encryption } from './encryption/encryption';
import { parseAccountEnvelope } from './encryption/e2eeAccountEnvelope';
import { utf8String } from './encryption/e2eeEncoding';
import { kvGet, kvMutate } from './apiKv';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://wrong-relay.example' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'web/test' }));

const publicKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const signature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const credentials: E2eeAuthCredentials = {
    version: 2,
    token: 'e2ee-bearer',
    origin: 'https://account-relay.example',
    accountId: 'account_1',
    deviceId: 'device_1',
    cryptoMode: 'e2ee-v1',
    e2eeProtocol: 'vh-e2ee-1',
    cryptoEpoch: 1,
    recoveryAuthorityPublicKey: publicKey,
    contentPublicKey: publicKey,
    contentKeySignature: signature,
};

function runtime(): E2eeRuntimeKeys {
    return {
        credentials,
        keyring: { currentEpoch: 1, epochs: [{ epoch: 1, secret: new Uint8Array(32).fill(31) }] },
        deviceKeys: {
            encryptionPrivateKey: new Uint8Array(32).fill(1),
            signingPrivateKey: new Uint8Array(64).fill(2),
        },
    };
}

describe('E2EE account KV transport', () => {
    let encryption: Encryption;

    beforeEach(async () => {
        encryption = await Encryption.createE2ee(runtime());
        bindAccountEncryption(encryption);
    });

    afterEach(() => {
        clearAccountEncryption(encryption);
        encryption.destroy();
        vi.unstubAllGlobals();
    });

    it('uses the credential-bound origin and sends only a context-bound tasks envelope', async () => {
        const logical = btoa(JSON.stringify({ tasks: [{ id: 'task-1', title: 'private launch' }] }));
        let carried = '';
        const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { mutations: Array<{ value: string }> };
            carried = body.mutations[0].value;
            return new Response(JSON.stringify({ success: true, results: [{ key: 'vh.board-tasks.v1', version: 0 }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(kvMutate(credentials, [{
            key: 'vh.board-tasks.v1', value: logical, version: -1,
        }])).resolves.toMatchObject({ success: true });

        expect(String(fetchMock.mock.calls[0][0])).toBe('https://account-relay.example/v1/kv');
        expect(carried).not.toContain(logical);
        const serialized = utf8String(decodeBase64(carried, 'base64'));
        expect(serialized).not.toContain('private launch');
        expect(parseAccountEnvelope(serialized)).toMatchObject({
            domain: 'tasks', objectId: 'vh.board-tasks.v1', field: 'value', epoch: 1,
        });
    });

    it('decrypts reads and conflict winners before account stores see them', async () => {
        const key = 'vh.note.v1.note-1';
        const logical = btoa(JSON.stringify({ id: 'note-1', content: 'relay cannot read this' }));
        const carried = await encryption.encryptKvValue(key, logical);
        const responses = [
            new Response(JSON.stringify({ key, value: carried, version: 3 }), {
                status: 200, headers: { 'content-type': 'application/json' },
            }),
            new Response(JSON.stringify({
                success: false,
                errors: [{ key, error: 'version-mismatch', version: 3, value: carried }],
            }), { status: 409, headers: { 'content-type': 'application/json' } }),
        ];
        vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));

        await expect(kvGet(credentials, key)).resolves.toEqual({ key, value: logical, version: 3 });
        await expect(kvMutate(credentials, [{ key, value: logical, version: 2 }])).resolves.toEqual({
            success: false,
            errors: [{ key, error: 'version-mismatch', version: 3, value: logical }],
        });
    });

    it('fails closed while locked and never sends plaintext', async () => {
        clearAccountEncryption(encryption);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(kvMutate(credentials, [{
            key: 'vh.board-tasks.v1', value: btoa('secret'), version: -1,
        }])).rejects.toThrow(/locked|another account/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('preserves the trusted-v1 carrier and configured endpoint', async () => {
        const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { mutations: Array<{ value: string }> };
            expect(body.mutations[0].value).toBe('cGxhaW4=');
            return new Response(JSON.stringify({ success: true, results: [{ key: 'legacy', version: 0 }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(kvMutate({ token: 'legacy', secret: publicKey }, [
            { key: 'legacy', value: 'cGxhaW4=', version: -1 },
        ])).resolves.toMatchObject({ success: true });
        expect(String(fetchMock.mock.calls[0][0])).toBe('https://wrong-relay.example/v1/kv');
    });
});
