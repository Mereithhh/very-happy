import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

/**
 * Shape of the encrypted password-unlock blob.
 * The server stores/returns it opaquely; only clients that know the password
 * can derive the account secret key from it.
 */
const PasswordBlobSchema = z.object({
    v: z.number(),
    kdf: z.string(),
    iterations: z.number(),
    salt: z.string(),
    iv: z.string(),
    ct: z.string()
});

/**
 * Simple in-memory, per-IP fixed-window rate limiter.
 * Used to protect the unauthenticated GET /v1/account/unlock endpoint.
 * (No @fastify/rate-limit dependency present in this server.)
 */
function createIpRateLimiter(opts: { max: number; windowMs: number }) {
    const hits = new Map<string, { count: number; resetAt: number }>();

    // Periodic sweep to avoid unbounded growth.
    const sweep: ReturnType<typeof setInterval> = setInterval(() => {
        const now = Date.now();
        for (const [ip, rec] of hits) {
            if (rec.resetAt <= now) {
                hits.delete(ip);
            }
        }
    }, opts.windowMs);
    // Don't keep the process alive just for the sweeper.
    if (typeof (sweep as any).unref === 'function') {
        (sweep as any).unref();
    }

    return function allow(ip: string): boolean {
        const now = Date.now();
        const rec = hits.get(ip);
        if (!rec || rec.resetAt <= now) {
            hits.set(ip, { count: 1, resetAt: now + opts.windowMs });
            return true;
        }
        if (rec.count >= opts.max) {
            return false;
        }
        rec.count += 1;
        return true;
    };
}

export function unlockRoutes(app: Fastify) {
    // 10 requests / minute / IP for the public unlock-blob fetch.
    const allowUnlockGet = createIpRateLimiter({ max: 10, windowMs: 60_000 });

    // GET /v1/account/unlock — PUBLIC (no account auth: a fresh browser has no key yet).
    // Single-user deployment: return the one account's unlock blob, or { exists: false }.
    // Leaks nothing beyond the (already-encrypted) blob.
    app.get('/v1/account/unlock', {
        schema: {
            response: {
                200: z.union([
                    z.object({ exists: z.literal(true), blob: PasswordBlobSchema }),
                    z.object({ exists: z.literal(false) })
                ]),
                429: z.object({ error: z.literal('Too many requests') })
            }
        }
    }, async (request, reply) => {
        const ip = request.ip;
        if (!allowUnlockGet(ip)) {
            return reply.code(429).send({ error: 'Too many requests' as const });
        }

        // Single-user: pick the single account deterministically.
        const account = await db.account.findFirst({
            orderBy: { createdAt: 'asc' },
            select: { id: true }
        });
        if (!account) {
            return reply.send({ exists: false as const });
        }

        // Raw SQL (not the Prisma model accessor) so the deploy can bind-mount
        // updated source without regenerating the Prisma client for the new table.
        const rows = await db.$queryRawUnsafe<{ blob: unknown }[]>(
            'SELECT "blob" FROM "AccountUnlock" WHERE "accountId" = $1 LIMIT 1',
            account.id
        );
        const raw = rows[0]?.blob;
        if (raw === undefined || raw === null) {
            return reply.send({ exists: false as const });
        }
        const blob = (typeof raw === 'string' ? JSON.parse(raw) : raw) as z.infer<typeof PasswordBlobSchema>;
        return reply.send({ exists: true as const, blob });
    });

    // PUT /v1/account/unlock — AUTHENTICATED. Set/replace the unlock blob (set/change password).
    app.put('/v1/account/unlock', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                blob: PasswordBlobSchema
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                500: z.object({ error: z.literal('Failed to store unlock blob') })
            }
        }
    }, async (request, reply) => {
        const accountId = request.userId;
        const { blob } = request.body;

        try {
            await db.$executeRawUnsafe(
                `INSERT INTO "AccountUnlock" ("accountId", "blob", "updatedAt")
                 VALUES ($1, $2::jsonb, now())
                 ON CONFLICT ("accountId") DO UPDATE SET "blob" = EXCLUDED."blob", "updatedAt" = now()`,
                accountId,
                JSON.stringify(blob)
            );
            return reply.send({ success: true as const });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to upsert account unlock blob: ${error}`);
            return reply.code(500).send({ error: 'Failed to store unlock blob' as const });
        }
    });
}
