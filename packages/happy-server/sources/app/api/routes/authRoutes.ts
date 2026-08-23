import { z } from 'zod';
import { type Fastify } from '../types';
import * as privacyKit from 'privacy-kit';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { log } from '@/utils/log';
import { SignupPolicyError, withSignupGate } from '@/app/auth/signupPolicy';
import { signupRejectionsCounter } from '@/app/monitoring/metrics2';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { allowPairingRate, claimSecretHash, claimSecretMatches, decodeFixedBase64, decodePairingPublicKey, hashPairingValue, legacyPairingAllowed, pairingExpired } from '@/app/auth/pairingSecurity';
import { approvePairingRow, createPairing, deletePairing, findPairing, type PairingKind } from '@/app/auth/pairingStore';

const publicKeySchema = z.string().min(40).max(48);
const claimSecretSchema = z.string().min(43).max(48);
const responseSchema = z.string().min(1).max(4096);
const pairingRequestSchema = z.object({
    publicKey: publicKeySchema,
    claimSecret: claimSecretSchema.optional(),
    supportsClaimSecret: z.literal(true).optional(),
    pairingAction: z.enum(['create', 'poll']).optional(),
}).strict();

function pairingError(reply: any, status: number, error: string) {
    return reply.code(status).send({ error });
}

async function authorizePairing(
    kind: PairingKind,
    publicKeyHex: string,
    claimSecret: string | undefined,
): Promise<{ response: string; accountId: string; id: string } | null | 'invalid-claim' | 'upgrade-required' | 'expired'> {
    return db.$transaction(async (tx) => {
        const row = await findPairing(kind, publicKeyHex, tx);
        if (!row) return null;
        if (pairingExpired(row.createdAt)) {
            await deletePairing(kind, row.id, tx);
            return 'expired';
        }
        if (row.claimSecretHash) {
            if (!claimSecret || !claimSecretMatches(claimSecret, row.claimSecretHash)) return 'invalid-claim';
        } else if (!legacyPairingAllowed()) {
            return 'upgrade-required';
        }
        if (!row.response || !row.responseAccountId) return null;
        const deleted = await deletePairing(kind, row.id, tx);
        if (deleted !== 1) return null;
        return { response: row.response, accountId: row.responseAccountId, id: row.id };
    });
}

export function authRoutes(app: Fastify) {
    app.post('/v1/auth', {
        schema: { body: z.object({
            publicKey: publicKeySchema,
            challenge: z.string().min(40).max(48),
            signature: z.string().min(84).max(92),
            inviteCode: z.string().trim().max(256).optional(),
        }).strict() },
    }, async (request, reply) => {
        const tweetnacl = (await import('tweetnacl')).default;
        const publicKey = decodeFixedBase64(request.body.publicKey, tweetnacl.sign.publicKeyLength);
        const challenge = decodeFixedBase64(request.body.challenge, 32);
        const signature = decodeFixedBase64(request.body.signature, tweetnacl.sign.signatureLength);
        if (!publicKey || !challenge || !signature || !tweetnacl.sign.detached.verify(challenge, signature, publicKey)) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        const publicKeyHex = privacyKit.encodeHex(Uint8Array.from(publicKey));
        let user = await db.account.findUnique({ where: { publicKey: publicKeyHex } });
        if (!user) {
            if (process.env.ALLOW_LEGACY_KEY_SIGNUP !== 'true') return reply.code(403).send({ error: 'legacy-key-signup-disabled' });
            const ipAllowed = await allowAuthRequest(`key-signup:ip:${hashPairingValue(request.ip).slice(0, 32)}`, { max: 10, windowMs: 60_000 });
            const globalAllowed = await allowAuthRequest('key-signup:global', { max: 50, windowMs: 60_000 });
            if (!ipAllowed || !globalAllowed) return reply.code(429).send({ error: 'rate-limit' });
            try {
                const result = await withSignupGate({
                    provider: 'key', inviteCode: request.body.inviteCode,
                    findExisting: (tx) => tx.account.findUnique({ where: { publicKey: publicKeyHex } }),
                    create: (tx) => tx.account.create({ data: { publicKey: publicKeyHex } }),
                    onRejected: (reason, provider) => signupRejectionsCounter.inc({ reason, provider }),
                });
                user = result.value;
            } catch (error) {
                if (error instanceof SignupPolicyError) {
                    log({ module: 'auth' }, `Legacy key signup blocked (${error.reason})`);
                    return reply.code(403).send({ error: error.reason });
                }
                throw error;
            }
        } else {
            await db.account.update({ where: { id: user.id }, data: { updatedAt: new Date() } });
        }
        return reply.send({ success: true, token: await auth.createToken(user.id) });
    });

    app.post('/v1/auth/request', {
        schema: { body: pairingRequestSchema.extend({ supportsV2: z.boolean().optional() }).strict() },
    }, async (request, reply) => handlePairingRequest('terminal', request, reply));

    app.get('/v1/auth/request/status', {
        schema: { querystring: z.object({ publicKey: publicKeySchema }).strict() },
    }, async (request, reply) => {
        const publicKey = decodePairingPublicKey(request.query.publicKey);
        if (!publicKey) return reply.send({ status: 'not_found', supportsV2: false });
        const publicKeyHex = privacyKit.encodeHex(Uint8Array.from(publicKey));
        if (!await allowPairingRate({ action: 'status', ip: request.ip, publicKeyHex })) return pairingError(reply, 429, 'rate-limit');
        const row = await findPairing('terminal', publicKeyHex);
        if (!row) return reply.send({ status: 'not_found', supportsV2: false });
        if (pairingExpired(row.createdAt)) return reply.send({ status: 'expired', supportsV2: row.supportsV2 });
        return reply.send({ status: row.response && row.responseAccountId ? 'authorized' : 'pending', supportsV2: row.supportsV2 });
    });

    app.post('/v1/auth/response', {
        preHandler: app.authenticate,
        schema: { body: z.object({ response: responseSchema, publicKey: publicKeySchema }).strict() },
    }, async (request, reply) => approvePairing('terminal', request, reply));

    app.post('/v1/auth/account/request', {
        schema: { body: pairingRequestSchema },
    }, async (request, reply) => handlePairingRequest('account', request, reply));

    app.post('/v1/auth/account/response', {
        preHandler: app.authenticate,
        schema: { body: z.object({ response: responseSchema, publicKey: publicKeySchema }).strict() },
    }, async (request, reply) => approvePairing('account', request, reply));
}

async function handlePairingRequest(kind: PairingKind, request: any, reply: any) {
    const publicKey = decodePairingPublicKey(request.body.publicKey);
    if (!publicKey) return pairingError(reply, 401, 'invalid-public-key');
    const publicKeyHex = privacyKit.encodeHex(Uint8Array.from(publicKey));
    const secretHash = claimSecretHash(request.body.claimSecret);
    if (request.body.supportsClaimSecret && !secretHash) return pairingError(reply, 400, 'invalid-claim-secret');
    const existing = await findPairing(kind, publicKeyHex);
    const action = request.body.pairingAction ?? (existing ? 'poll' : 'create');
    if (!await allowPairingRate({ action, ip: request.ip, publicKeyHex })) return pairingError(reply, 429, 'rate-limit');
    if (!existing && action === 'poll') return pairingError(reply, 404, 'not-found');
    if (!existing && !secretHash && !legacyPairingAllowed()) return pairingError(reply, 426, 'upgrade-required');
    if (existing && pairingExpired(existing.createdAt)) {
        await deletePairing(kind, existing.id);
        return pairingError(reply, 410, 'expired');
    }
    if (existing?.claimSecretHash && (!request.body.claimSecret || !claimSecretMatches(request.body.claimSecret, existing.claimSecretHash))) return pairingError(reply, 403, 'invalid-claim');
    if (existing && !existing.claimSecretHash && !legacyPairingAllowed()) return pairingError(reply, 426, 'upgrade-required');
    if (!existing) {
        await createPairing(kind, { publicKey: publicKeyHex, claimSecretHash: secretHash, supportsV2: request.body.supportsV2 });
        return reply.send({ state: 'requested', protocolVersion: 3, claimSecretRequired: true });
    }
    if (existing.response && existing.responseAccountId) {
        const claimed = await authorizePairing(kind, publicKeyHex, request.body.claimSecret);
        if (!claimed || typeof claimed === 'string') return pairingError(reply, claimed === 'expired' ? 410 : 404, claimed || 'not-found');
        return reply.send({
            state: 'authorized', protocolVersion: 3, claimSecretRequired: true,
            token: await auth.createToken(claimed.accountId, kind === 'terminal' ? { session: claimed.id } : undefined),
            response: claimed.response,
        });
    }
    return reply.send({ state: 'requested', protocolVersion: 3, claimSecretRequired: true });
}

async function approvePairing(kind: PairingKind, request: any, reply: any) {
    const publicKey = decodePairingPublicKey(request.body.publicKey);
    if (!publicKey) return pairingError(reply, 401, 'invalid-public-key');
    const publicKeyHex = privacyKit.encodeHex(Uint8Array.from(publicKey));
    if (!await allowPairingRate({ action: 'approve', ip: request.ip, publicKeyHex, accountId: request.userId })) return pairingError(reply, 429, 'rate-limit');
    const row = await findPairing(kind, publicKeyHex);
    if (!row || pairingExpired(row.createdAt)) return pairingError(reply, 404, row ? 'expired' : 'not-found');
    if (!row.response) await approvePairingRow(kind, row.id, request.body.response, request.userId);
    return reply.send({ success: true });
}
