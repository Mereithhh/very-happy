import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import {
    E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN,
    E2EE_RECOVERY_CAPSULE_DOMAIN,
    E2EE_SUITE_V1,
    canonicalizeE2eeJson,
    controlDeviceRootEnvelopeSignatureTranscript,
    encodeCanonicalE2eeJson,
    type ControlDeviceRootEnvelopeV1,
    type RecoveryKeyringCapsuleV1,
} from '@slopus/happy-wire';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '@/app/api/types';

describe('E2EE account auth on PGlite', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-e2ee-auth-'));
    const pgliteDir = join(root, 'db');
    const origin = 'http://localhost:4173';
    let db: PrismaClient;
    let app: ReturnType<typeof fastify>;
    let auth: typeof import('./auth').auth;
    let helpers: typeof import('./e2eeAuth');

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = 'e2ee-auth-integration-master';
        process.env.SIGNUP_MODE = 'open';
        process.env.E2EE_SIGNUP_ENABLED = 'true';
        process.env.E2EE_SIGNUP_REQUIRED = 'false';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir, migrationsDir: join(process.cwd(), 'prisma', 'migrations') });
        ({ db } = await import('../../storage/db'));
        ({ auth } = await import('./auth'));
        helpers = await import('./e2eeAuth');
        const { initEncrypt } = await import('../../modules/encrypt');
        await initEncrypt();
        await auth.init();

        app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app as unknown as Fastify;
        const { enableAuthentication } = await import('../api/utils/enableAuthentication');
        enableAuthentication(typed);
        const { accountAuthRoutes } = await import('../api/routes/accountAuthRoutes');
        accountAuthRoutes(typed);
        const { accountRoutes } = await import('../api/routes/accountRoutes');
        const { kvRoutes } = await import('../api/routes/kvRoutes');
        const { eventRouter } = await import('../events/eventRouter');
        eventRouter.init({ to: () => ({ emit: () => undefined }) } as any);
        accountRoutes(typed);
        kvRoutes(typed);
        typed.get('/test/authenticated', { preHandler: typed.authenticate }, async () => ({ ok: true }));
        await app.ready();
    });

    afterAll(async () => {
        delete process.env.SIGNUP_MODE;
        delete process.env.E2EE_SIGNUP_ENABLED;
        delete process.env.E2EE_SIGNUP_REQUIRED;
        await app?.close();
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
    });

    function signature(keyPair: tweetnacl.SignKeyPair, transcript: Record<string, string | number | boolean | null>): string {
        return Buffer.from(tweetnacl.sign.detached(
            helpers.canonicalizeE2eeTranscript(transcript),
            keyPair.secretKey,
        )).toString('base64url');
    }

    function bytesSignature(keyPair: tweetnacl.SignKeyPair, transcript: Uint8Array): string {
        return Buffer.from(tweetnacl.sign.detached(transcript, keyPair.secretKey)).toString('base64url');
    }

    function recoveryCapsule(input: {
        keyPair: tweetnacl.SignKeyPair;
        publicKey: string;
        accountId: string;
        ciphertextByte?: number;
    }): RecoveryKeyringCapsuleV1 {
        const unsigned = {
            v: 1 as const,
            domain: E2EE_RECOVERY_CAPSULE_DOMAIN,
            suite: E2EE_SUITE_V1,
            origin,
            accountId: input.accountId,
            currentEpoch: 1,
            recoveryAuthorityPublicKey: input.publicKey,
            nonce: Buffer.alloc(24, 3).toString('base64url'),
            ciphertext: Buffer.alloc(96, input.ciphertextByte ?? 4).toString('base64url'),
        };
        return { ...unsigned, signature: bytesSignature(input.keyPair, encodeCanonicalE2eeJson(unsigned)) };
    }

    function rootEnvelope(input: {
        keyPair: tweetnacl.SignKeyPair;
        accountId: string;
        deviceId: string;
        ciphertextByte: number;
    }): ControlDeviceRootEnvelopeV1 {
        const unsigned = {
            v: 1 as const,
            domain: E2EE_CONTROL_DEVICE_ROOT_ENVELOPE_DOMAIN,
            suite: E2EE_SUITE_V1,
            origin,
            accountId: input.accountId,
            deviceId: input.deviceId,
            keyEpoch: 1,
            ephemeralPublicKey: Buffer.alloc(32, input.ciphertextByte + 1).toString('base64url'),
            nonce: Buffer.alloc(24, input.ciphertextByte + 2).toString('base64url'),
            ciphertext: Buffer.alloc(96, input.ciphertextByte).toString('base64url'),
            authorizer: { kind: 'recovery' as const },
        };
        return {
            ...unsigned,
            signature: bytesSignature(input.keyPair, controlDeviceRootEnvelopeSignatureTranscript(unsigned)),
        };
    }

    it('creates an E2EE account without escrow, rejects v1 downgrade, and activates a recovered device', async () => {
        const challengeResponse = await app.inject({
            method: 'POST', url: '/v2/account/signup/challenge', headers: { origin },
        });
        expect(challengeResponse.statusCode).toBe(200);
        const challenge = challengeResponse.json() as { accountId: string; nonce: string };

        const authority = tweetnacl.sign.keyPair();
        const recoveryAuthorityPublicKey = Buffer.from(authority.publicKey).toString('base64url');
        const contentPublicKey = Buffer.alloc(32, 2).toString('base64url');
        const device = {
            id: crypto.randomUUID(), type: 'web' as const,
            encryptionPublicKey: Buffer.alloc(32, 5).toString('base64url'),
            signingPublicKey: Buffer.alloc(32, 6).toString('base64url'),
        };
        const recovery = recoveryCapsule({
            keyPair: authority, publicKey: recoveryAuthorityPublicKey, accountId: challenge.accountId,
        });
        const initialRootEnvelope = rootEnvelope({
            keyPair: authority, accountId: challenge.accountId, deviceId: device.id, ciphertextByte: 4,
        });
        const signupProof = signature(authority, helpers.passwordSignupTranscript({
            origin, accountId: challenge.accountId, nonce: challenge.nonce, username: 'alice',
            recoveryAuthorityPublicKey, contentPublicKey, recoveryCapsule: recovery,
            rootEnvelope: initialRootEnvelope, device,
        }));
        const contentKeySignature = signature(authority, helpers.contentKeyTranscript({
            origin, accountId: challenge.accountId, epoch: 1, contentPublicKey,
        }));
        const signup = await app.inject({
            method: 'POST', url: '/v2/account/signup/password', headers: { origin },
            payload: {
                accountId: challenge.accountId,
                nonce: challenge.nonce,
                username: 'alice',
                password: 'correct horse battery staple',
                recoveryAuthorityPublicKey,
                contentPublicKey,
                contentKeySignature,
                recoveryCapsule: recovery,
                device,
                rootEnvelope: initialRootEnvelope,
                signupProof,
                e2eeProtocol: helpers.E2EE_PROTOCOL,
            },
        });
        expect(signup.statusCode, signup.body).toBe(200);
        expect(signup.json()).not.toHaveProperty('secret');
        expect(signup.json()).not.toHaveProperty('legacySecret');
        const account = await db.account.findUniqueOrThrow({ where: { id: challenge.accountId } });
        expect(account).toMatchObject({
            publicKey: null, cryptoMode: 'e2ee-v1', cryptoEpoch: 1, e2eeOrigin: origin,
        });
        expect(await db.accountSecret.count({ where: { accountId: challenge.accountId } })).toBe(0);
        expect((await db.accountCredential.findUniqueOrThrow({ where: { username: 'alice' } })).secretEnc).toBeNull();
        expect(account.recoveryCiphertext).toBe(canonicalizeE2eeJson(recovery));
        expect(signup.json().recoveryCapsule).toEqual(recovery);
        expect(signup.json().e2eeOrigin).toBe(origin);
        const storedRootEnvelope = await db.controlDeviceRootEnvelope.findFirstOrThrow({
            where: { accountId: challenge.accountId, deviceId: device.id, keyEpoch: 1 },
        });
        expect(storedRootEnvelope.ciphertext).toBe(canonicalizeE2eeJson(initialRootEnvelope));

        const replayProof = signature(authority, helpers.passwordSignupTranscript({
            origin, accountId: challenge.accountId, nonce: challenge.nonce, username: 'bob',
            recoveryAuthorityPublicKey, contentPublicKey, recoveryCapsule: recovery,
            rootEnvelope: initialRootEnvelope, device,
        }));
        const replay = await app.inject({
            method: 'POST', url: '/v2/account/signup/password', headers: { origin },
            payload: {
                accountId: challenge.accountId, nonce: challenge.nonce,
                username: 'bob', password: 'correct horse battery staple',
                recoveryAuthorityPublicKey, contentPublicKey, contentKeySignature,
                recoveryCapsule: recovery, device,
                rootEnvelope: initialRootEnvelope,
                signupProof: replayProof, e2eeProtocol: helpers.E2EE_PROTOCOL,
            },
        });
        expect(replay.statusCode).toBe(400);
        expect(replay.json()).toEqual({ error: 'invalid_reservation' });

        const legacyLogin = await app.inject({
            method: 'POST', url: '/v1/account/login',
            payload: { username: 'alice', password: 'correct horse battery staple' },
        });
        expect(legacyLogin.statusCode).toBe(426);
        expect(legacyLogin.json()).toEqual({ error: 'e2ee_client_required' });
        await expect(db.$executeRawUnsafe(
            `INSERT INTO "AccountSecret" ("accountId", "secretEnc", "updatedAt") VALUES ($1, 'forbidden', now())`,
            challenge.accountId,
        )).rejects.toThrow(/e2ee_account_escrow_forbidden/);
        await expect(db.$executeRawUnsafe(
            `UPDATE "AccountCredential" SET "secretEnc" = 'forbidden' WHERE "accountId" = $1`,
            challenge.accountId,
        )).rejects.toThrow(/e2ee_credential_escrow_forbidden/);
        const daemonId = crypto.randomUUID();
        await db.$executeRawUnsafe(
            `INSERT INTO "CryptoDevice"
             ("id", "accountId", "type", "encryptionPublicKey", "signingPublicKey", "status", "keyEpoch", "updatedAt")
             VALUES ($1, $2, 'daemon', $3, $4, 'active', 1, now())`,
            daemonId, challenge.accountId,
            Buffer.alloc(32, 15).toString('base64url'),
            Buffer.alloc(32, 16).toString('base64url'),
        );
        const runnerSession = await auth.createLoginToken(challenge.accountId, undefined, {
            deviceId: daemonId,
            capabilities: ['e2ee:runner'],
            e2eeProtocol: helpers.E2EE_PROTOCOL,
        });
        await expect(auth.verifyToken(runnerSession.token)).resolves.toMatchObject({
            userId: challenge.accountId,
            extras: { deviceId: daemonId, capabilities: ['e2ee:runner'], e2eeOrigin: origin },
        });
        const daemonControlSession = await auth.createLoginToken(challenge.accountId, undefined, {
            deviceId: daemonId,
            capabilities: [helpers.E2EE_CONTROL_CAPABILITY],
            e2eeProtocol: helpers.E2EE_PROTOCOL,
        });
        await expect(auth.verifyToken(daemonControlSession.token)).resolves.toBeNull();
        await expect(db.$executeRawUnsafe(
            `INSERT INTO "ControlDeviceRootEnvelope"
             ("id", "accountId", "deviceId", "keyEpoch", "suite", "ciphertext",
              "authorizerKind", "signature", "updatedAt")
             VALUES ($1, $2, $3, 1, 'vh-e2ee-1', $4, 'recovery', $5, now())`,
            crypto.randomUUID(), challenge.accountId, daemonId,
            canonicalizeE2eeJson(initialRootEnvelope), initialRootEnvelope.signature,
        )).rejects.toThrow(/control_root_envelope_recipient_must_be_web/);

        const recoveredDevice = {
            id: crypto.randomUUID(), type: 'web' as const,
            encryptionPublicKey: Buffer.alloc(32, 7).toString('base64url'),
            signingPublicKey: Buffer.alloc(32, 8).toString('base64url'),
        };
        const login = await app.inject({
            method: 'POST', url: '/v2/account/login',
            payload: {
                username: 'alice', password: 'correct horse battery staple',
                device: recoveredDevice, e2eeProtocol: helpers.E2EE_PROTOCOL,
            },
        });
        expect(login.statusCode, login.body).toBe(200);
        const pending = login.json() as {
            token: string;
            capabilities: string[];
            cryptoEpoch: number;
            recoveryCapsule: RecoveryKeyringCapsuleV1;
        };
        expect(pending.capabilities).toEqual([helpers.E2EE_UNLOCK_CAPABILITY]);
        expect((login.json() as { e2eeOrigin: string }).e2eeOrigin).toBe(origin);
        const pendingDataAccess = await app.inject({
            method: 'GET', url: '/test/authenticated', headers: { authorization: `Bearer ${pending.token}` },
        });
        expect(pendingDataAccess.statusCode).toBe(426);
        expect(pending.recoveryCapsule).toEqual(recovery);
        const recoveredRootEnvelope = rootEnvelope({
            keyPair: authority, accountId: challenge.accountId,
            deviceId: recoveredDevice.id, ciphertextByte: 9,
        });
        const recoveredActivationProof = signature(authority, helpers.rootEnvelopeTranscript({
            origin,
            accountId: challenge.accountId,
            epoch: pending.cryptoEpoch,
            challenge: helpers.sha256Base64Url(pending.token),
            device: recoveredDevice,
            envelope: recoveredRootEnvelope,
        }));
        const activated = await app.inject({
            method: 'POST', url: '/v2/account/device/activate',
            headers: { origin, authorization: `Bearer ${pending.token}` },
            payload: {
                deviceId: recoveredDevice.id,
                e2eeProtocol: helpers.E2EE_PROTOCOL,
                rootEnvelope: recoveredRootEnvelope,
                activationProof: recoveredActivationProof,
            },
        });
        expect(activated.statusCode, activated.body).toBe(200);
        const active = activated.json() as { token: string; capabilities: string[] };
        expect(active.capabilities).toEqual([helpers.E2EE_CONTROL_CAPABILITY]);
        await expect(auth.verifyToken(pending.token)).resolves.toBeNull();
        await expect(auth.verifyToken(active.token)).resolves.toMatchObject({
            userId: challenge.accountId,
            extras: {
                deviceId: recoveredDevice.id,
                capabilities: [helpers.E2EE_CONTROL_CAPABILITY],
                e2eeOrigin: origin,
            },
        });
        const activeDataAccess = await app.inject({
            method: 'GET', url: '/test/authenticated', headers: { authorization: `Bearer ${active.token}` },
        });
        expect(activeDataAccess.statusCode).toBe(200);

        const settingsEnvelope = canonicalizeE2eeJson({
            accountId: challenge.accountId,
            ciphertext: Buffer.alloc(16, 31).toString('base64url'),
            domain: 'settings',
            epoch: 1,
            field: 'settings',
            nonce: Buffer.alloc(12, 30).toString('base64url'),
            objectId: challenge.accountId,
            origin,
            suite: E2EE_SUITE_V1,
            v: 1,
        });
        const settingsWrite = await app.inject({
            method: 'POST', url: '/v1/account/settings',
            headers: { authorization: `Bearer ${active.token}` },
            payload: { settings: settingsEnvelope, expectedVersion: 0 },
        });
        expect(settingsWrite.statusCode, settingsWrite.body).toBe(200);
        const settingsRead = await app.inject({
            method: 'GET', url: '/v1/account/settings',
            headers: { authorization: `Bearer ${active.token}` },
        });
        expect(settingsRead.json()).toEqual({ settings: settingsEnvelope, settingsVersion: 1 });

        const boardKey = 'vh.board-tasks.v1';
        const boardEnvelope = canonicalizeE2eeJson({
            accountId: challenge.accountId,
            ciphertext: Buffer.alloc(16, 33).toString('base64url'),
            domain: 'tasks',
            epoch: 1,
            field: 'value',
            nonce: Buffer.alloc(12, 32).toString('base64url'),
            objectId: boardKey,
            origin,
            suite: E2EE_SUITE_V1,
            v: 1,
        });
        const boardValue = Buffer.from(boardEnvelope, 'utf8').toString('base64');
        const boardWrite = await app.inject({
            method: 'POST', url: '/v1/kv',
            headers: { authorization: `Bearer ${active.token}` },
            payload: { mutations: [{ key: boardKey, value: boardValue, version: -1 }] },
        });
        expect(boardWrite.statusCode, boardWrite.body).toBe(200);
        const boardRead = await app.inject({
            method: 'GET', url: `/v1/kv/${boardKey}`,
            headers: { authorization: `Bearer ${active.token}` },
        });
        expect(boardRead.json()).toEqual({ key: boardKey, value: boardValue, version: 0 });

        const rejectedDevice = {
            id: crypto.randomUUID(), type: 'web' as const,
            encryptionPublicKey: Buffer.alloc(32, 10).toString('base64url'),
            signingPublicKey: Buffer.alloc(32, 11).toString('base64url'),
        };
        const rejectedLogin = await app.inject({
            method: 'POST', url: '/v2/account/login',
            payload: {
                username: 'alice', password: 'correct horse battery staple',
                device: rejectedDevice, e2eeProtocol: helpers.E2EE_PROTOCOL,
            },
        });
        const rejectedPending = rejectedLogin.json() as { token: string };
        const rejectedActivation = await app.inject({
            method: 'POST', url: '/v2/account/device/activate',
            headers: { origin, authorization: `Bearer ${rejectedPending.token}` },
            payload: {
                deviceId: rejectedDevice.id,
                e2eeProtocol: helpers.E2EE_PROTOCOL,
                rootEnvelope: rootEnvelope({
                    keyPair: authority, accountId: challenge.accountId,
                    deviceId: rejectedDevice.id, ciphertextByte: 13,
                }),
                activationProof: Buffer.alloc(64, 14).toString('base64url'),
            },
        });
        expect(rejectedActivation.statusCode).toBe(400);
        expect(await db.cryptoDevice.findUnique({ where: { id: rejectedDevice.id } })).toBeNull();
        await expect(auth.verifyToken(rejectedPending.token)).resolves.toBeNull();
    }, 20_000);

    it('keeps trusted-v1 password signup compatible while E2EE is not required', async () => {
        const secret = Buffer.alloc(32, 12).toString('base64url');
        const response = await app.inject({
            method: 'POST', url: '/v1/account/signup/password',
            payload: { username: 'legacy-user', password: 'legacy password', secret },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ secret });
        const credential = await db.accountCredential.findUniqueOrThrow({
            where: { username: 'legacy-user' }, include: { account: true },
        });
        expect(credential.account.cryptoMode).toBe('trusted-v1');
        expect(credential.secretEnc).not.toBeNull();

        await expect(db.$executeRawUnsafe(
            `UPDATE "Account"
                 SET "publicKey" = NULL,
                     "cryptoMode" = 'e2ee-v1',
                     "cryptoEpoch" = 1,
                     "e2eeOrigin" = $2,
                     "recoveryAuthorityPublicKey" = $3,
                     "e2eeContentPublicKey" = $4,
                     "e2eeContentKeySignature" = $5,
                     "recoveryCiphertext" = $6
             WHERE "id" = $1`,
            credential.accountId,
            origin,
            Buffer.alloc(32, 20).toString('base64url'),
            Buffer.alloc(32, 21).toString('base64url'),
            Buffer.alloc(64, 22).toString('base64url'),
            '{}',
        )).rejects.toThrow(/e2ee_activation_requires_escrow_removal/);
        expect((await db.account.findUniqueOrThrow({ where: { id: credential.accountId } })).cryptoMode)
            .toBe('trusted-v1');
    });

    it('serializes E2EE activation against a concurrent escrow write', async () => {
        const account = await db.account.create({
            data: { publicKey: Buffer.alloc(32, 23).toString('base64url') },
        });
        let activationUpdated!: () => void;
        let releaseActivation!: () => void;
        const updated = new Promise<void>((resolve) => { activationUpdated = resolve; });
        const release = new Promise<void>((resolve) => { releaseActivation = resolve; });

        const activation = db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
                `UPDATE "Account"
                 SET "publicKey" = NULL,
                     "cryptoMode" = 'e2ee-v1',
                     "cryptoEpoch" = 1,
                     "e2eeOrigin" = $2,
                     "recoveryAuthorityPublicKey" = $3,
                     "e2eeContentPublicKey" = $4,
                     "e2eeContentKeySignature" = $5,
                     "recoveryCiphertext" = $6
                 WHERE "id" = $1`,
                account.id,
                origin,
                Buffer.alloc(32, 24).toString('base64url'),
                Buffer.alloc(32, 25).toString('base64url'),
                Buffer.alloc(64, 26).toString('base64url'),
                '{}',
            );
            activationUpdated();
            await release;
        });
        await updated;

        let escrowSettled = false;
        const escrow = db.$executeRawUnsafe(
            `INSERT INTO "AccountSecret" ("accountId", "secretEnc", "updatedAt")
             VALUES ($1, 'racing-secret', now())`,
            account.id,
        ).then(
            () => ({ ok: true as const, error: null }),
            (error: unknown) => ({ ok: false as const, error }),
        ).finally(() => { escrowSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(escrowSettled).toBe(false);

        releaseActivation();
        await activation;
        const result = await escrow;
        expect(result.ok).toBe(false);
        expect(String(result.error)).toMatch(/e2ee_account_escrow_forbidden/);
        expect(await db.accountSecret.findUnique({ where: { accountId: account.id } })).toBeNull();
    });
});
