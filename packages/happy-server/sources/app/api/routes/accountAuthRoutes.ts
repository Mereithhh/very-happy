import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

/**
 * Classic username/password login bound to an existing happy Account.
 *
 * Server-trusted model (web-only, multi-tenant): the account's opaque `secret`
 * (the key happy clients use for encryption/sync) is stored server-side and
 * handed back on login. Anyone with username+password logs in on any browser
 * and gets the same account — no QR pairing. Uses raw SQL so the server can be
 * deployed by bind-mounting source (no Prisma client regen for the new table).
 */

// --- password hashing (node scrypt, no extra deps) ---
function hashPassword(pw: string): string {
    const salt = randomBytes(16);
    const dk = scryptSync(pw, salt, 64);
    return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
function verifyPassword(pw: string, stored: string): boolean {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const dk = scryptSync(pw, salt, expected.length);
    return expected.length === dk.length && timingSafeEqual(expected, dk);
}

// --- per-IP fixed-window rate limiter (protect public login) ---
function createIpRateLimiter(opts: { max: number; windowMs: number }) {
    const hits = new Map<string, { count: number; resetAt: number }>();
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [ip, rec] of hits) if (rec.resetAt <= now) hits.delete(ip);
    }, opts.windowMs);
    if (typeof (sweep as any).unref === 'function') (sweep as any).unref();
    return function allow(ip: string): boolean {
        const now = Date.now();
        const rec = hits.get(ip);
        if (!rec || rec.resetAt <= now) { hits.set(ip, { count: 1, resetAt: now + opts.windowMs }); return true; }
        if (rec.count >= opts.max) return false;
        rec.count += 1;
        return true;
    };
}

export function accountAuthRoutes(app: Fastify) {
    const allowLogin = createIpRateLimiter({ max: 10, windowMs: 60_000 });

    // POST /v1/account/credentials — AUTHENTICATED.
    // Attach/replace username+password for the *current* account and store its secret.
    // The authenticated client uploads the secret it already holds.
    app.post('/v1/account/credentials', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                username: z.string().min(3).max(64),
                password: z.string().min(8).max(256),
                secret: z.string().min(1)
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                409: z.object({ error: z.literal('username_taken') }),
                500: z.object({ error: z.literal('failed') })
            }
        }
    }, async (request, reply) => {
        const accountId = request.userId;
        const username = request.body.username.trim().toLowerCase();
        try {
            const existing = await db.$queryRawUnsafe<{ accountId: string }[]>(
                'SELECT "accountId" FROM "AccountCredential" WHERE "username" = $1 LIMIT 1',
                username
            );
            if (existing[0] && existing[0].accountId !== accountId) {
                return reply.code(409).send({ error: 'username_taken' as const });
            }
            const passwordHash = hashPassword(request.body.password);
            // One credential per account: drop any prior row, then insert fresh.
            await db.$executeRawUnsafe('DELETE FROM "AccountCredential" WHERE "accountId" = $1', accountId);
            await db.$executeRawUnsafe(
                'INSERT INTO "AccountCredential" ("username", "accountId", "passwordHash", "secretEnc", "updatedAt") VALUES ($1, $2, $3, $4, now())',
                username, accountId, passwordHash, request.body.secret
            );
            return reply.send({ success: true as const });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `account credentials upsert failed: ${error}`);
            return reply.code(500).send({ error: 'failed' as const });
        }
    });

    // POST /v1/account/login — PUBLIC + rate-limited.
    app.post('/v1/account/login', {
        schema: {
            body: z.object({ username: z.string(), password: z.string() }),
            response: {
                200: z.object({ token: z.string(), secret: z.string() }),
                401: z.object({ error: z.literal('invalid_credentials') }),
                429: z.object({ error: z.literal('too_many_requests') })
            }
        }
    }, async (request, reply) => {
        if (!allowLogin(request.ip)) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        const username = request.body.username.trim().toLowerCase();
        const rows = await db.$queryRawUnsafe<{ accountId: string; passwordHash: string; secretEnc: string }[]>(
            'SELECT "accountId", "passwordHash", "secretEnc" FROM "AccountCredential" WHERE "username" = $1 LIMIT 1',
            username
        );
        const row = rows[0];
        if (!row || !verifyPassword(request.body.password, row.passwordHash)) {
            return reply.code(401).send({ error: 'invalid_credentials' as const });
        }
        const token = await auth.createToken(row.accountId);
        return reply.send({ token, secret: row.secretEnc });
    });
}
