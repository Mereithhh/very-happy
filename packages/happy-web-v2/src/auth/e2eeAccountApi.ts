import axios from 'axios';
import * as z from 'zod';
import {
    E2EE_SUITE_V1,
    RecoveryKeyringCapsuleV1Schema,
} from '@slopus/happy-wire';
import { getHappyClientId } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import type { E2eeAuthCredentials, TrustedAuthCredentials } from './tokenStorage';
import { E2eeIndexedDbKeyVault } from './e2eeVault';
import { generateControlDeviceKeyPairs } from './e2eeDeviceEnvelope';
import {
    E2EE_CONTROL_CAPABILITY,
    E2EE_UNLOCK_CAPABILITY,
    disposeControlDeviceKeys,
    disposePreparedE2eeSignup,
    prepareE2eeDeviceActivation,
    type E2eeSignupChallenge,
    type PendingE2eeDeviceLogin,
    type PreparedE2eePasswordSignup,
} from './e2eeAccountSetup';
import { randomUUID } from 'expo-crypto';
import { encodeBase64UrlCanonical } from '@/sync/encryption/e2eeEncoding';

export type E2eeAccountAuthErrorCode =
    | 'invalid-credentials'
    | 'username-taken'
    | 'rate-limited'
    | 'signup-disabled'
    | 'signup-closed'
    | 'invite-required'
    | 'capacity-reached'
    | 'recovery-invalid'
    | 'same-origin-required'
    | 'server-response-invalid'
    | 'network';

export class E2eeAccountAuthError extends Error {
    constructor(readonly code: E2eeAccountAuthErrorCode, message: string = code) {
        super(message);
        this.name = 'E2eeAccountAuthError';
    }
}

const canonicalKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const canonicalSignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const deviceSchema = z.strictObject({
    id: z.string().uuid(),
    type: z.literal('web'),
    encryptionPublicKey: canonicalKeySchema,
    signingPublicKey: canonicalKeySchema,
});
const authV2Schema = z.strictObject({
    token: z.string().min(1).max(16 * 1024),
    expiresAt: z.string().optional(),
    accountId: z.string().min(1).max(200),
    deviceId: z.string().uuid().optional(),
    capabilities: z.array(z.string()).max(16),
    cryptoMode: z.enum(['trusted-v1', 'e2ee-migrating', 'e2ee-v1']),
    cryptoEpoch: z.number().int().min(0),
    e2eeOrigin: z.string().optional(),
    recoveryAuthorityPublicKey: canonicalKeySchema.optional(),
    contentPublicKey: canonicalKeySchema.optional(),
    contentKeySignature: canonicalSignatureSchema.optional(),
    recoveryCapsule: RecoveryKeyringCapsuleV1Schema.optional(),
    legacySecret: canonicalKeySchema.optional(),
});

function endpoint(): string {
    return getServerUrl();
}

function browserOrigin(options: { requireSameRelayOrigin: boolean }): string {
    if (typeof window === 'undefined') throw new E2eeAccountAuthError('same-origin-required');
    const origin = window.location.origin;
    const relayOrigin = new URL(endpoint(), origin).origin;
    if (options.requireSameRelayOrigin && relayOrigin !== origin) {
        throw new E2eeAccountAuthError(
            'same-origin-required',
            'E2EE v1 requires the Web app and relay API to share one origin',
        );
    }
    return origin;
}

function headers(token?: string): Record<string, string> {
    return {
        'X-Happy-Client': getHappyClientId(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
}

function mapRequestError(error: any): E2eeAccountAuthError {
    if (error instanceof E2eeAccountAuthError) return error;
    const status = error?.response?.status;
    const reason = error?.response?.data?.error;
    if (status === 401 || reason === 'invalid_credentials') {
        return new E2eeAccountAuthError('invalid-credentials');
    }
    if (status === 409 || reason === 'username_taken') {
        return new E2eeAccountAuthError('username-taken');
    }
    if (status === 429 || reason === 'too_many_requests' || reason === 'too_many_pending_devices') {
        return new E2eeAccountAuthError('rate-limited');
    }
    if (reason === 'e2ee_signup_disabled') return new E2eeAccountAuthError('signup-disabled');
    if (reason === 'signup-closed') return new E2eeAccountAuthError('signup-closed');
    if (reason === 'invite-required') return new E2eeAccountAuthError('invite-required');
    if (reason === 'capacity-reached') return new E2eeAccountAuthError('capacity-reached');
    if (reason === 'invalid_crypto_proof' || reason === 'invalid_unlock_session') {
        return new E2eeAccountAuthError('recovery-invalid');
    }
    return new E2eeAccountAuthError('network');
}

function parseE2eeControlCredentials(
    value: unknown,
    expected: { origin: string; accountId: string; deviceId: string },
): E2eeAuthCredentials {
    const parsed = authV2Schema.safeParse(value);
    if (!parsed.success) throw new E2eeAccountAuthError('server-response-invalid');
    const response = parsed.data;
    if (response.cryptoMode !== 'e2ee-v1'
        || response.cryptoEpoch < 1
        || response.e2eeOrigin !== expected.origin
        || response.accountId !== expected.accountId
        || response.deviceId !== expected.deviceId
        || response.capabilities.length !== 1
        || response.capabilities[0] !== E2EE_CONTROL_CAPABILITY
        || !response.recoveryAuthorityPublicKey
        || !response.contentPublicKey
        || !response.contentKeySignature
        || response.legacySecret !== undefined) {
        throw new E2eeAccountAuthError('server-response-invalid');
    }
    return {
        version: 2,
        token: response.token,
        origin: response.e2eeOrigin,
        accountId: response.accountId,
        deviceId: response.deviceId,
        cryptoMode: 'e2ee-v1',
        e2eeProtocol: E2EE_SUITE_V1,
        cryptoEpoch: response.cryptoEpoch,
        recoveryAuthorityPublicKey: response.recoveryAuthorityPublicKey,
        contentPublicKey: response.contentPublicKey,
        contentKeySignature: response.contentKeySignature,
    };
}

export async function requestE2eeSignupChallenge(): Promise<{
    origin: string;
    challenge: E2eeSignupChallenge;
}> {
    const origin = browserOrigin({ requireSameRelayOrigin: true });
    try {
        const response = await axios.post<unknown>(
            `${endpoint()}/v2/account/signup/challenge`,
            {},
            { headers: headers() },
        );
        const challenge = z.strictObject({
            accountId: z.string().uuid(),
            nonce: canonicalKeySchema,
            expiresAt: z.string(),
            suite: z.literal(E2EE_SUITE_V1),
        }).parse(response.data);
        return { origin, challenge };
    } catch (error) {
        if (error instanceof z.ZodError) throw new E2eeAccountAuthError('server-response-invalid');
        throw mapRequestError(error);
    }
}

export async function commitE2eePasswordSignup(input: {
    prepared: PreparedE2eePasswordSignup;
    password: string;
    inviteCode?: string;
}): Promise<E2eeAuthCredentials> {
    const context = {
        origin: input.prepared.origin,
        accountId: input.prepared.accountId,
        deviceId: input.prepared.device.id,
    };
    const vault = new E2eeIndexedDbKeyVault();
    try {
        await vault.storeKeyring(context, input.prepared.keyring);
        await vault.storeControlDevicePrivateKeys(context, {
            encryptionPrivateKey: input.prepared.deviceKeys.encryptionPrivateKey,
            signingPrivateKey: input.prepared.deviceKeys.signingPrivateKey,
        });
        const response = await axios.post<unknown>(
            `${endpoint()}/v2/account/signup/password`,
            {
                accountId: input.prepared.accountId,
                nonce: input.prepared.signupNonce,
                username: input.prepared.normalizedUsername,
                password: input.password,
                recoveryAuthorityPublicKey: input.prepared.recoveryAuthorityPublicKey,
                contentPublicKey: input.prepared.contentPublicKey,
                contentKeySignature: input.prepared.contentKeySignature,
                recoveryCapsule: input.prepared.recoveryCapsule,
                device: input.prepared.device,
                rootEnvelope: input.prepared.rootEnvelope,
                signupProof: input.prepared.signupProof,
                e2eeProtocol: E2EE_SUITE_V1,
                ...(input.inviteCode?.trim() ? { inviteCode: input.inviteCode.trim() } : {}),
            },
            { headers: headers() },
        );
        const credentials = parseE2eeControlCredentials(response.data, context);
        if (credentials.recoveryAuthorityPublicKey !== input.prepared.recoveryAuthorityPublicKey
            || credentials.contentPublicKey !== input.prepared.contentPublicKey
            || credentials.contentKeySignature !== input.prepared.contentKeySignature
            || credentials.cryptoEpoch !== 1) {
            throw new E2eeAccountAuthError('server-response-invalid');
        }
        return credentials;
    } catch (error) {
        await vault.remove(context).catch(() => undefined);
        throw mapRequestError(error);
    } finally {
        disposePreparedE2eeSignup(input.prepared);
    }
}

export type PasswordLoginStart =
    | { kind: 'trusted'; credentials: TrustedAuthCredentials }
    | { kind: 'e2ee-recovery'; pending: PendingE2eeDeviceLogin };

export async function startPasswordLoginV2(username: string, password: string): Promise<PasswordLoginStart> {
    const origin = browserOrigin({ requireSameRelayOrigin: false });
    const deviceKeys = await generateControlDeviceKeyPairs();
    const device = deviceSchema.parse({
        id: randomUUID(),
        type: 'web',
        encryptionPublicKey: encodeBase64UrlCanonical(deviceKeys.encryptionPublicKey),
        signingPublicKey: encodeBase64UrlCanonical(deviceKeys.signingPublicKey),
    });
    try {
        const response = await axios.post<unknown>(
            `${endpoint()}/v2/account/login`,
            {
                username: username.trim().toLowerCase(),
                password,
                device,
                e2eeProtocol: E2EE_SUITE_V1,
            },
            { headers: headers() },
        );
        const parsed = authV2Schema.safeParse(response.data);
        if (!parsed.success) throw new E2eeAccountAuthError('server-response-invalid');
        const data = parsed.data;
        if (data.cryptoMode === 'trusted-v1') {
            if (!data.legacySecret) throw new E2eeAccountAuthError('server-response-invalid');
            disposeControlDeviceKeys(deviceKeys);
            return { kind: 'trusted', credentials: { token: data.token, secret: data.legacySecret } };
        }
        if (data.cryptoMode !== 'e2ee-v1'
            || data.e2eeOrigin !== origin
            || data.deviceId !== device.id
            || data.cryptoEpoch < 1
            || data.capabilities.length !== 1
            || data.capabilities[0] !== E2EE_UNLOCK_CAPABILITY
            || !data.recoveryAuthorityPublicKey
            || !data.contentPublicKey
            || !data.contentKeySignature
            || !data.recoveryCapsule
            || data.legacySecret !== undefined) {
            throw new E2eeAccountAuthError('server-response-invalid');
        }
        if (new URL(endpoint(), origin).origin !== origin) {
            throw new E2eeAccountAuthError('same-origin-required');
        }
        return {
            kind: 'e2ee-recovery',
            pending: {
                token: data.token,
                accountId: data.accountId,
                deviceId: device.id,
                origin,
                cryptoEpoch: data.cryptoEpoch,
                recoveryAuthorityPublicKey: data.recoveryAuthorityPublicKey,
                contentPublicKey: data.contentPublicKey,
                contentKeySignature: data.contentKeySignature,
                recoveryCapsule: data.recoveryCapsule,
                device,
                deviceKeys,
            },
        };
    } catch (error) {
        disposeControlDeviceKeys(deviceKeys);
        throw mapRequestError(error);
    }
}

export async function activateE2eePasswordLogin(
    pending: PendingE2eeDeviceLogin,
    recoveryCode: string,
): Promise<E2eeAuthCredentials> {
    let activation;
    try {
        activation = await prepareE2eeDeviceActivation({ pending, recoveryCode });
    } catch {
        throw new E2eeAccountAuthError('recovery-invalid');
    }
    const context = {
        origin: pending.origin,
        accountId: pending.accountId,
        deviceId: pending.deviceId,
    };
    const vault = new E2eeIndexedDbKeyVault();
    try {
        await vault.storeKeyring(context, activation.keyring);
        await vault.storeControlDevicePrivateKeys(context, {
            encryptionPrivateKey: pending.deviceKeys.encryptionPrivateKey,
            signingPrivateKey: pending.deviceKeys.signingPrivateKey,
        });
        const response = await axios.post<unknown>(
            `${endpoint()}/v2/account/device/activate`,
            {
                deviceId: pending.deviceId,
                e2eeProtocol: E2EE_SUITE_V1,
                rootEnvelope: activation.rootEnvelope,
                activationProof: activation.activationProof,
            },
            { headers: headers(pending.token) },
        );
        const credentials = parseE2eeControlCredentials(response.data, context);
        if (credentials.recoveryAuthorityPublicKey !== pending.recoveryAuthorityPublicKey
            || credentials.contentPublicKey !== pending.contentPublicKey
            || credentials.contentKeySignature !== pending.contentKeySignature
            || credentials.cryptoEpoch !== pending.cryptoEpoch) {
            throw new E2eeAccountAuthError('server-response-invalid');
        }
        disposeControlDeviceKeys(pending.deviceKeys);
        return credentials;
    } catch (error) {
        await vault.remove(context).catch(() => undefined);
        throw mapRequestError(error);
    } finally {
        activation.keyring.epochs.forEach((item) => item.secret.fill(0));
    }
}

export function disposePendingE2eeLogin(pending: PendingE2eeDeviceLogin): void {
    disposeControlDeviceKeys(pending.deviceKeys);
}
