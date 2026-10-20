/**
 * B-627: signed, short-lived proof that "account X on the old relay belongs to
 * the bearer". Both relays share MIGRATION_HANDOFF_SECRET; the old one signs,
 * the new one verifies. Shape: `vh1.<base64url(json)>.<base64url(hmac-sha256)>`.
 * Nonces are single-use on the verifying side (handoffUse.ts).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';

export const MIGRATION_HANDOFF_TTL_MS = 10 * 60_000;

const payloadSchema = z.object({
    v: z.literal(1),
    kind: z.enum(['web', 'daemon']),
    accountId: z.string().min(1).max(64),
    machineId: z.string().min(1).max(128).optional(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
}).strict();

export type MigrationHandoffPayload = z.infer<typeof payloadSchema>;

const TOKEN = /^vh1\.([A-Za-z0-9_-]{16,2048})\.([A-Za-z0-9_-]{43})$/;

function mac(secret: string, body: string): Buffer {
    return createHmac('sha256', secret).update(`vh1.${body}`).digest();
}

export function signMigrationHandoff(secret: string, payload: MigrationHandoffPayload): string {
    const body = Buffer.from(JSON.stringify(payloadSchema.parse(payload))).toString('base64url');
    return `vh1.${body}.${mac(secret, body).toString('base64url')}`;
}

export function issueMigrationHandoff(
    secret: string,
    subject: { kind: 'web' | 'daemon'; accountId: string; machineId?: string },
    nowMs = Date.now(),
): string {
    const iat = Math.floor(nowMs / 1000);
    return signMigrationHandoff(secret, {
        v: 1,
        kind: subject.kind,
        accountId: subject.accountId,
        ...(subject.machineId ? { machineId: subject.machineId } : {}),
        nonce: randomBytes(32).toString('base64url'),
        iat,
        exp: iat + Math.floor(MIGRATION_HANDOFF_TTL_MS / 1000),
    });
}

/** Null on any defect: shape, signature, clock. Never throws. */
export function verifyMigrationHandoff(secret: string, token: string, nowMs = Date.now()): MigrationHandoffPayload | null {
    const match = TOKEN.exec(token);
    if (!match) return null;
    const [, body, signature] = match;
    const expected = mac(secret, body);
    const given = Buffer.from(signature, 'base64url');
    // B-656: base64url's last char carries padding bits the decoder ignores, so
    // several spellings decode to the same MAC. Only the canonical one is valid.
    if (given.toString('base64url') !== signature) return null;
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    const payload = payloadSchema.safeParse(parsed);
    if (!payload.success) return null;
    const now = Math.floor(nowMs / 1000);
    if (payload.data.exp <= now || payload.data.iat > now + 60) return null;
    if (payload.data.exp - payload.data.iat > Math.floor(MIGRATION_HANDOFF_TTL_MS / 1000) + 60) return null;
    return payload.data;
}
