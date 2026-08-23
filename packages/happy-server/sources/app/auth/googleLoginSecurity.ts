import { createHash, randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';

const GOOGLE_CHALLENGE_TTL_MS = 5 * 60 * 1000;

type SqlClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

export interface GoogleLoginConfig {
    clientId: string | null;
    allowedOrigins: ReadonlySet<string>;
}

function normalizeOrigin(value: string): string {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Google allowed origins must use http or https');
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (parsed.protocol === 'http:' && !loopback) {
        throw new Error('Google allowed origins must use https except for loopback development origins');
    }
    if (
        parsed.origin === 'null'
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
    ) {
        throw new Error('Google allowed origins must be plain origins without credentials, path, query, or fragment');
    }
    return parsed.origin;
}

export function resolveGoogleLoginConfig(env: NodeJS.ProcessEnv = process.env): GoogleLoginConfig {
    const clientId = env.GOOGLE_CLIENT_ID?.trim() || null;
    const origins = (env.GOOGLE_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
        .map(normalizeOrigin);
    if (clientId && origins.length === 0) {
        throw new Error('GOOGLE_ALLOWED_ORIGINS is required when GOOGLE_CLIENT_ID is configured');
    }
    return { clientId, allowedOrigins: new Set(origins) };
}

export function isGoogleOriginAllowed(origin: string | undefined, config: GoogleLoginConfig): boolean {
    if (!origin) return false;
    try {
        return config.allowedOrigins.has(normalizeOrigin(origin));
    } catch {
        return false;
    }
}

export function hashGoogleLoginNonce(nonce: string): string {
    return createHash('sha256').update(nonce).digest('hex');
}

export async function issueGoogleLoginChallenge(
    client: SqlClient = db,
    nowMs = Date.now(),
): Promise<{ nonce: string; expiresAt: Date }> {
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(nowMs + GOOGLE_CHALLENGE_TTL_MS);
    await client.$executeRawUnsafe(
        'DELETE FROM "GoogleLoginChallenge" WHERE "expiresAt" <= now() OR "consumedAt" IS NOT NULL',
    );
    await client.$executeRawUnsafe(
        `INSERT INTO "GoogleLoginChallenge" ("nonceHash", "expiresAt", "createdAt")
         VALUES ($1, $2, now())`,
        hashGoogleLoginNonce(nonce),
        expiresAt,
    );
    return { nonce, expiresAt };
}

/** Atomically consumes an unexpired nonce. Exactly one concurrent caller wins. */
export async function consumeGoogleLoginChallenge(client: SqlClient, nonce: string): Promise<boolean> {
    const rows = await client.$queryRawUnsafe<Array<{ nonceHash: string }>>(
        `UPDATE "GoogleLoginChallenge"
         SET "consumedAt" = now()
         WHERE "nonceHash" = $1 AND "consumedAt" IS NULL AND "expiresAt" > now()
         RETURNING "nonceHash"`,
        hashGoogleLoginNonce(nonce),
    );
    return rows.length === 1;
}
