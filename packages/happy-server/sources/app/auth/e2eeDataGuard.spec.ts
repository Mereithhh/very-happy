import { describe, expect, it, vi } from 'vitest';
import { canonicalizeE2eeJson, type StoredE2eeEnvelopeV1 } from '@slopus/happy-wire';
import {
    E2eeDataGuardError,
    e2eeDomainForKvKey,
    lockAndValidateE2eeWriter,
    parseCanonicalStoredE2eeEnvelope,
    validateE2eeKvValue,
    validateE2eeSettingsValue,
    type AccountCryptoState,
} from './e2eeDataGuard';

const origin = 'https://happy.example.com';
const account: AccountCryptoState = {
    id: 'account-1',
    cryptoMode: 'e2ee-v1',
    cryptoEpoch: 7,
    cryptoWriteState: 'active',
    e2eeOrigin: origin,
};

function envelope(overrides: Partial<StoredE2eeEnvelopeV1> = {}): StoredE2eeEnvelopeV1 {
    return {
        v: 1,
        suite: 'vh-e2ee-1',
        origin,
        accountId: account.id,
        epoch: account.cryptoEpoch,
        domain: 'settings',
        objectId: account.id,
        field: 'settings',
        nonce: Buffer.alloc(12, 1).toString('base64url'),
        ciphertext: Buffer.alloc(16, 2).toString('base64url'),
        ...overrides,
    };
}

function serialized(value: StoredE2eeEnvelopeV1): string {
    return canonicalizeE2eeJson(value);
}

function expected() {
    return {
        origin,
        accountId: account.id,
        epoch: account.cryptoEpoch,
        domain: 'settings' as const,
        objectId: account.id,
        field: 'settings',
        maxSerializedBytes: 4096,
    };
}

function expectGuardError(fn: () => unknown, code: E2eeDataGuardError['code'], statusCode: number) {
    try {
        fn();
        throw new Error('expected guard error');
    } catch (error) {
        expect(error).toBeInstanceOf(E2eeDataGuardError);
        expect(error).toMatchObject({ code, statusCode });
    }
}

describe('canonical stored E2EE envelope guard', () => {
    it('accepts the exact canonical settings envelope', () => {
        const value = serialized(envelope());
        expect(parseCanonicalStoredE2eeEnvelope(value, expected())).toEqual(envelope());
        expect(validateE2eeSettingsValue(value, account, 4096)).toEqual(envelope());
    });

    it.each([
        ['origin', { origin: 'https://other.example.com' }],
        ['account', { accountId: 'account-2' }],
        ['epoch', { epoch: 6 }],
        ['domain', { domain: 'kv' as const }],
        ['object', { objectId: 'different' }],
        ['field', { field: 'value' }],
    ])('rejects wrong %s context', (_label, override) => {
        expectGuardError(
            () => parseCanonicalStoredE2eeEnvelope(serialized(envelope(override)), expected()),
            'invalid_e2ee_envelope',
            400,
        );
    });

    it('rejects plaintext, unknown fields, duplicate/noncanonical JSON and oversize input', () => {
        expectGuardError(
            () => parseCanonicalStoredE2eeEnvelope('legacy plaintext', expected()),
            'invalid_e2ee_envelope',
            400,
        );
        const withExtra = { ...envelope(), extra: true };
        expectGuardError(
            () => parseCanonicalStoredE2eeEnvelope(canonicalizeE2eeJson(withExtra), expected()),
            'invalid_e2ee_envelope',
            400,
        );
        const noncanonical = JSON.stringify(envelope());
        expect(noncanonical).not.toBe(serialized(envelope()));
        expectGuardError(
            () => parseCanonicalStoredE2eeEnvelope(noncanonical, expected()),
            'invalid_e2ee_envelope',
            400,
        );
        const duplicate = serialized(envelope()).replace('{', '{"v":1,');
        expectGuardError(
            () => parseCanonicalStoredE2eeEnvelope(duplicate, expected()),
            'invalid_e2ee_envelope',
            400,
        );
        expectGuardError(
            () => parseCanonicalStoredE2eeEnvelope(serialized(envelope()), {
                ...expected(),
                maxSerializedBytes: Buffer.byteLength(serialized(envelope())) - 1,
            }),
            'invalid_e2ee_envelope',
            400,
        );
    });

    it('maps protected KV namespaces and validates their base64 carrier', () => {
        expect(e2eeDomainForKvKey('vh.board-tasks.v1')).toBe('tasks');
        expect(e2eeDomainForKvKey('vh.note.v1.note-1')).toBe('notes');
        expect(e2eeDomainForKvKey('other')).toBe('kv');

        for (const [key, domain] of [
            ['vh.board-tasks.v1', 'tasks'],
            ['vh.note.v1.note-1', 'notes'],
            ['other', 'kv'],
        ] as const) {
            const kvEnvelope = envelope({ domain, objectId: key, field: 'value' });
            const carrier = Buffer.from(serialized(kvEnvelope), 'utf8').toString('base64');
            expect(validateE2eeKvValue(carrier, key, account, 4096)).toEqual(kvEnvelope);
        }
    });

    it('uses a stable conflict for invalid ciphertext already stored by the server', () => {
        expectGuardError(
            () => validateE2eeSettingsValue('legacy plaintext', account, 4096, 'e2ee_data_invalid'),
            'e2ee_data_invalid',
            409,
        );
    });

    it('accepts historical epochs only for existing reads, never for new writes or future data', () => {
        const historical = serialized(envelope({ epoch: account.cryptoEpoch - 1 }));
        expect(validateE2eeSettingsValue(
            historical,
            account,
            4096,
            'e2ee_data_invalid',
            'read-existing',
        ).epoch).toBe(account.cryptoEpoch - 1);

        expectGuardError(
            () => validateE2eeSettingsValue(historical, account, 4096),
            'invalid_e2ee_envelope',
            400,
        );

        const future = serialized(envelope({ epoch: account.cryptoEpoch + 1 }));
        expectGuardError(
            () => validateE2eeSettingsValue(
                future,
                account,
                4096,
                'e2ee_data_invalid',
                'read-existing',
            ),
            'e2ee_data_invalid',
            409,
        );
    });
});

function activeWriterRow(overrides: Record<string, unknown> = {}) {
    return {
        id: account.id,
        cryptoMode: 'e2ee-v1',
        cryptoEpoch: account.cryptoEpoch,
        cryptoWriteState: 'active',
        e2eeOrigin: origin,
        sessionId: 'session-1',
        sessionDeviceId: 'device-1',
        sessionCapabilities: ['e2ee:control'],
        sessionProtocol: 'vh-e2ee-1',
        sessionExpiresAt: new Date(Date.now() + 60_000),
        sessionRevokedAt: null,
        deviceId: 'device-1',
        deviceStatus: 'active',
        deviceKeyEpoch: account.cryptoEpoch,
        deviceRevokedAt: null,
        ...overrides,
    };
}

const activeAuth = {
    loginSessionId: 'session-1',
    deviceId: 'device-1',
    capabilities: ['e2ee:control'],
    e2eeProtocol: 'vh-e2ee-1',
} as const;

describe('transactional E2EE writer authorization', () => {
    it('locks the account row and accepts a current active device session', async () => {
        const query = vi.fn(async () => [activeWriterRow()]);
        const result = await lockAndValidateE2eeWriter({ $queryRawUnsafe: query } as any, account.id, activeAuth);
        expect(result).toEqual(account);
        expect(query).toHaveBeenCalled();
        expect(String((query.mock.calls as unknown[][])[0]?.[0] ?? '')).toContain('FOR UPDATE OF a');
    });

    it('leaves trusted-v1 behavior compatible without a device-bound session', async () => {
        const row = activeWriterRow({
            cryptoMode: 'trusted-v1', cryptoEpoch: 0, e2eeOrigin: null,
            sessionId: null, sessionDeviceId: null, sessionCapabilities: null,
            sessionProtocol: null, sessionExpiresAt: null, deviceId: null,
            deviceStatus: null, deviceKeyEpoch: null,
            deviceRevokedAt: null,
        });
        const result = await lockAndValidateE2eeWriter({ $queryRawUnsafe: async () => [row] } as any, account.id, {});
        expect(result.cryptoMode).toBe('trusted-v1');
    });

    it('rejects rekey-required before any write', async () => {
        await expect(lockAndValidateE2eeWriter(
            { $queryRawUnsafe: async () => [activeWriterRow({ cryptoWriteState: 'rekey-required' })] } as any,
            account.id,
            activeAuth,
        )).rejects.toMatchObject({ statusCode: 409, code: 'e2ee_rekey_required' });
    });

    it.each([
        ['legacy bearer', {}, {
            loginSessionId: undefined,
            deviceId: undefined,
            capabilities: undefined,
            e2eeProtocol: undefined,
        }],
        ['wrong protocol', { sessionProtocol: 'vh-e2ee-0' }, {}],
        ['revoked session', { sessionRevokedAt: new Date() }, {}],
        ['expired session', { sessionExpiresAt: new Date(Date.now() - 1) }, {}],
        ['pending device', { deviceStatus: 'pending' }, {}],
        ['revoked device timestamp', { deviceRevokedAt: new Date() }, {}],
        ['stale device epoch', { deviceKeyEpoch: account.cryptoEpoch - 1 }, {}],
        ['wrong request device', {}, { deviceId: 'device-2' }],
        ['wrong capability', {}, { capabilities: ['e2ee:runner'] }],
    ])('rejects %s with the stable upgrade response', async (_label, rowOverride, authOverride) => {
        await expect(lockAndValidateE2eeWriter(
            { $queryRawUnsafe: async () => [activeWriterRow(rowOverride)] } as any,
            account.id,
            { ...activeAuth, ...authOverride },
        )).rejects.toMatchObject({ statusCode: 426, code: 'e2ee_client_required' });
    });
});
