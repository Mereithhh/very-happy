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

export function unlockRoutes(app: Fastify) {
    // Legacy authenticated write remains temporarily for old clients. The
    // unauthenticated GET was intentionally removed: selecting the first
    // Account is invalid and unsafe on a multi-tenant Cloud server.
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
