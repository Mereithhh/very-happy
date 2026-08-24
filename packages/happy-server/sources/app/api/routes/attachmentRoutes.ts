/**
 * Attachment upload/download routes for image attachments in chat sessions.
 *
 * Two storage modes:
 * - S3: Returns presigned PUT/GET URLs. Server never touches file bytes.
 * - Local: Server accepts/serves encrypted blobs directly.
 *
 * Upload reservations are database-backed for account byte/count quotas.
 * Completed rows live with the session; abandoned reservations are reclaimed.
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Fastify } from '../types';
import { db } from '@/storage/db';
import { s3client, s3bucket, isLocalStorage, getLocalFilesDir, putLocalFile, deleteStoredFile } from '@/storage/files';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { assertAccountResourceQuota, configuredResourceLimit, isAccountResourceLimitError, lockAccountResources } from '../resourceLimits';
import { inTx } from '@/storage/inTx';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const PRESIGNED_TTL_SECONDS = 15 * 60; // 15 minutes (design spec)

const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 60;
const ATTACHMENT_ID_MAX_BYTES = 256;
const ATTACHMENT_RESERVATION_DEFAULT_TTL_MINUTES = 60;
const ATTACHMENT_CLEANUP_BATCH = 100;
const RESERVATION_STATUS = 'attachment-reserved';
const UPLOADING_STATUS = 'attachment-uploading';
const COMPLETE_STATUS = 'attachment-complete';
const CLEANING_STATUS = 'attachment-cleaning';

type AttachmentSqlClient = Pick<typeof db, '$queryRawUnsafe' | '$executeRawUnsafe'>;

async function uploadedFileUsage(client: AttachmentSqlClient, accountId: string): Promise<{ count: number; bytes: number }> {
    const rows = await client.$queryRawUnsafe<Array<{ count: bigint | number | string; bytes: bigint | number | string }>>(
        `SELECT COUNT(*) AS "count",
                COALESCE(SUM(CASE WHEN "path" LIKE 'sessions/%' THEN "size" ELSE 0 END), 0) AS "bytes"
         FROM "UploadedFile" WHERE "accountId" = $1`,
        accountId,
    );
    return { count: Number(rows[0]?.count ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
}

async function reserveAttachment(
    client: AttachmentSqlClient,
    accountId: string,
    ref: string,
    size: number,
): Promise<void> {
    // Raw SQL is deliberate: hw-sg bind-mount deploys sources and migrations
    // onto a stable image, so the generated Prisma Client may predate `size`.
    await client.$executeRawUnsafe(
        `INSERT INTO "UploadedFile" ("id", "accountId", "path", "size", "reuseKey", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, now())`,
        crypto.randomUUID(),
        accountId,
        ref,
        size,
        RESERVATION_STATUS,
    );
}

async function attachmentReservationSize(
    client: AttachmentSqlClient,
    accountId: string,
    ref: string,
): Promise<{ size: number | null; reuseKey: string | null } | null> {
    const rows = await client.$queryRawUnsafe<Array<{ size: number | null; reuseKey: string | null }>>(
        `SELECT "size", "reuseKey" FROM "UploadedFile" WHERE "accountId" = $1 AND "path" = $2 LIMIT 1`,
        accountId,
        ref,
    );
    return rows[0] ?? null;
}

async function claimExpiredReservations(accountId: string): Promise<Array<{ id: string; path: string }>> {
    const ttlMinutes = configuredResourceLimit(
        'ATTACHMENT_RESERVATION_TTL_MINUTES',
        ATTACHMENT_RESERVATION_DEFAULT_TTL_MINUTES,
    );
    if (ttlMinutes === 0) return [];
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000);
    return inTx(async (tx) => {
        await lockAccountResources(tx, accountId);
        return tx.$queryRawUnsafe<Array<{ id: string; path: string }>>(
            `UPDATE "UploadedFile" SET "reuseKey" = $3, "updatedAt" = now()
             WHERE "id" IN (
                 SELECT "id" FROM "UploadedFile"
                 WHERE "accountId" = $1
                   AND "reuseKey" IN ($4, $5)
                   AND "updatedAt" < $2
                 ORDER BY "updatedAt" ASC
                 LIMIT $6
             )
             RETURNING "id", "path"`,
            accountId,
            cutoff,
            CLEANING_STATUS,
            RESERVATION_STATUS,
            UPLOADING_STATUS,
            ATTACHMENT_CLEANUP_BATCH,
        );
    });
}

async function pruneAbandonedReservations(accountId: string): Promise<void> {
    const claimed = await claimExpiredReservations(accountId);
    for (const row of claimed) {
        try {
            await deleteStoredFile(row.path);
            await db.uploadedFile.deleteMany({
                where: { id: row.id, accountId, reuseKey: CLEANING_STATUS },
            });
        } catch {
            await db.uploadedFile.updateMany({
                where: { id: row.id, accountId, reuseKey: CLEANING_STATUS },
                data: { reuseKey: RESERVATION_STATUS, updatedAt: new Date(0) },
            });
        }
    }
}

async function markAttachmentStatus(accountId: string, ref: string, from: string[], to: string): Promise<boolean> {
    return inTx(async (tx) => {
        await lockAccountResources(tx, accountId);
        const result = await tx.uploadedFile.updateMany({
            where: { accountId, path: ref, reuseKey: { in: from } },
            data: { reuseKey: to, updatedAt: new Date() },
        });
        if (result.count > 0) return true;
        // Legacy rows predate reservation status. Preserve their availability.
        return await tx.uploadedFile.count({ where: { accountId, path: ref, reuseKey: null } }) > 0;
    });
}

async function storedAttachmentExists(ref: string): Promise<boolean> {
    if (isLocalStorage()) {
        return fs.existsSync(path.join(getLocalFilesDir(), ref));
    }
    try {
        await s3client.statObject(s3bucket, ref);
        return true;
    } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : '';
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
            ? Number(error.statusCode)
            : 0;
        if (statusCode === 404 || ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(code)) {
            return false;
        }
        throw error;
    }
}

/**
 * Build the base URL the client should use to reach our local-mode upload /
 * download endpoints. Prefer an explicit PUBLIC_URL, then x-forwarded-* (for
 * deployments behind a proxy), then the Host header the request itself
 * arrived on. Falling back to localhost would make any non-localhost client
 * (a phone, another LAN device, a desktop pointing at a dev IP) fail with a
 * generic Network request failed when it tries to follow the URL.
 */
function resolveBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    const xfHost = request.headers['x-forwarded-host'];
    const xfProto = request.headers['x-forwarded-proto'];
    const host = (Array.isArray(xfHost) ? xfHost[0] : xfHost) ?? request.headers.host;
    const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto) ?? 'http';
    if (typeof host === 'string' && host.length > 0) {
        return `${proto}://${host}`;
    }
    return `http://localhost:${process.env.PORT || '3005'}`;
}

export function attachmentRoutes(app: Fastify) {

    /**
     * Request an upload URL for an attachment.
     * Returns a ref (storage path) and an uploadUrl to PUT the encrypted blob to.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-upload', {
        schema: {
            params: z.object({
                sessionId: z.string().min(1).max(ATTACHMENT_ID_MAX_BYTES),
            }).strict(),
            body: z.object({
                filename: z.string().min(1).max(ATTACHMENT_ID_MAX_BYTES),
                size: z.number().int().min(1).max(MAX_FILE_SIZE),
            }).strict(),
            response: {
                200: z.object({
                    ref: z.string(),
                    uploadUrl: z.string(),
                    method: z.enum(['PUT', 'POST']),
                    formFields: z.record(z.string(), z.string()).optional(),
                }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
                429: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { size } = request.body;
        const userId = request.userId;

        if (!(await allowAuthRequest(`attachment-upload:${userId}`, { max: UPLOAD_RATE_MAX, windowMs: UPLOAD_RATE_WINDOW_MS }))) {
            return reply.code(429).send({ error: 'Too many upload requests. Try again in a minute.' });
        }

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        await pruneAbandonedReservations(userId);

        if (size > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        // Always .enc — encrypted opaque blobs, never trust client filename for path.
        const attachmentId = crypto.randomUUID();
        const attachmentFile = `${attachmentId}.enc`;
        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        try {
            await inTx(async (tx) => {
                await lockAccountResources(tx, userId);
                const usage = await uploadedFileUsage(tx, userId);
                assertAccountResourceQuota({
                    resource: 'attachment',
                    current: usage,
                    delta: { count: 1, bytes: size },
                    limits: {
                        count: configuredResourceLimit('MAX_UPLOADED_FILES_PER_ACCOUNT', 2_000),
                        bytes: configuredResourceLimit('MAX_ATTACHMENT_BYTES_PER_ACCOUNT', 100 * 1024 * 1024),
                    },
                });
                await reserveAttachment(tx, userId, ref, size);
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                return reply.code(error.statusCode).send({ error: error.code });
            }
            throw error;
        }

        try {
        if (isLocalStorage()) {
            // Local mode: client uploads to our own PUT endpoint (the server
            // enforces the size limit by inspecting the request body before
            // it hits disk, so PUT is fine here).
            const baseUrl = resolveBaseUrl(request);
            const uploadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ ref, uploadUrl, method: 'PUT' });
        } else {
            // S3 mode: presigned POST policy with content-length-range so S3
            // itself rejects oversize uploads — a presigned PUT cannot enforce
            // size and would let a client honest about size in the auth call
            // PUT 500MB at the URL afterwards.
            const policy = s3client.newPostPolicy();
            policy.setBucket(s3bucket);
            policy.setKey(ref);
            policy.setExpires(new Date(Date.now() + PRESIGNED_TTL_SECONDS * 1000));
            policy.setContentLengthRange(1, size);
            const { postURL, formData } = await s3client.presignedPostPolicy(policy);
            return reply.send({
                ref,
                uploadUrl: postURL,
                method: 'POST',
                formFields: formData as Record<string, string>,
            });
        }
        } catch (error) {
            await db.uploadedFile.deleteMany({ where: { accountId: userId, path: ref } });
            throw error;
        }
    });

    /**
     * Local storage: accept encrypted blob upload via PUT.
     * Only active when S3 is not configured.
     */
    app.put('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        bodyLimit: MAX_FILE_SIZE,
        schema: {
            params: z.object({
                sessionId: z.string().min(1).max(ATTACHMENT_ID_MAX_BYTES),
                attachmentFile: z.string().min(1).max(ATTACHMENT_ID_MAX_BYTES),
            }).strict(),
            response: {
                200: z.object({ ok: z.boolean() }),
                404: z.object({ error: z.string() }),
                413: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        if (!isLocalStorage()) {
            return reply.code(404).send({ error: 'Direct upload not available in S3 mode' });
        }

        const { sessionId, attachmentFile } = request.params;
        const userId = request.userId;

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (attachmentFile.includes('..') || attachmentFile.includes('/')) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const body = request.body as Buffer;
        if (body.length > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
        const reservation = await attachmentReservationSize(db, userId, ref);
        if (!reservation || reservation.reuseKey === CLEANING_STATUS || body.length > (reservation.size ?? MAX_FILE_SIZE)) {
            return reply.code(413).send({ error: 'Upload exceeds its reserved size' });
        }
        if (!await markAttachmentStatus(
            userId,
            ref,
            [RESERVATION_STATUS, UPLOADING_STATUS, COMPLETE_STATUS],
            UPLOADING_STATUS,
        )) return reply.code(413).send({ error: 'Upload exceeds its reserved size' });
        try {
            await putLocalFile(ref, body);
            await markAttachmentStatus(userId, ref, [UPLOADING_STATUS], COMPLETE_STATUS);
        } catch (error) {
            await markAttachmentStatus(userId, ref, [UPLOADING_STATUS], RESERVATION_STATUS);
            throw error;
        }

        return reply.send({ ok: true });
    });

    /**
     * Request a download URL for an attachment by ref. The client follows the
     * returned URL with a normal HTTP GET — in local mode it points back at
     * this server (auth-required), in S3 mode it is a presigned GET URL.
     * Pairs with /request-upload as the design-spec endpoint.
     */
    app.post('/v1/sessions/:sessionId/attachments/request-download', {
        schema: {
            params: z.object({
                sessionId: z.string().min(1).max(ATTACHMENT_ID_MAX_BYTES),
            }).strict(),
            body: z.object({
                ref: z.string().min(1).max(1024),
            }).strict(),
            response: {
                200: z.object({
                    downloadUrl: z.string(),
                }),
                400: z.object({ error: z.string() }),
                404: z.object({ error: z.string() }),
            },
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const { ref } = request.body;
        const userId = request.userId;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // ref must live strictly under this session's attachments prefix —
        // otherwise a member of session A could craft a ref pointing into
        // session B and ride this endpoint's auth to read it.
        const expectedPrefix = `sessions/${sessionId}/attachments/`;
        if (!ref.startsWith(expectedPrefix)) {
            return reply.code(400).send({ error: 'Ref does not belong to this session' });
        }
        const attachmentFile = ref.slice(expectedPrefix.length);
        if (!attachmentFile || attachmentFile.includes('/') || attachmentFile.includes('..')) {
            return reply.code(400).send({ error: 'Invalid attachment ref' });
        }
        // Do not let an empty S3/local reservation become permanent merely by
        // requesting a download URL. Completion requires the object to exist.
        if (!await storedAttachmentExists(ref)) {
            return reply.code(404).send({ error: 'Attachment not found' });
        }
        // Mark modern reservations complete. A missing row is allowed here for
        // read compatibility with attachments created before reservations were
        // introduced; upload endpoints still require a live reservation.
        await markAttachmentStatus(
            userId,
            ref,
            [RESERVATION_STATUS, UPLOADING_STATUS, COMPLETE_STATUS],
            COMPLETE_STATUS,
        );

        if (isLocalStorage()) {
            const baseUrl = resolveBaseUrl(request);
            const downloadUrl = `${baseUrl}/v1/sessions/${sessionId}/attachments/${attachmentFile}`;
            return reply.send({ downloadUrl });
        }
        const downloadUrl = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
        return reply.send({ downloadUrl });
    });

    /**
     * Download an attachment. Returns the encrypted blob directly (local)
     * or a presigned GET URL redirect (S3). Backs the URL returned by
     * /request-download in local mode; clients can also call this directly.
     */
    app.get('/v1/sessions/:sessionId/attachments/:attachmentFile', {
        schema: {
            params: z.object({
                sessionId: z.string().min(1).max(ATTACHMENT_ID_MAX_BYTES),
                attachmentFile: z.string().min(1).max(ATTACHMENT_ID_MAX_BYTES),
            }).strict(),
        },
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { sessionId, attachmentFile } = request.params;
        const userId = request.userId;

        // Verify session ownership
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Path traversal protection
        if (attachmentFile.includes('..') || attachmentFile.includes('/')) {
            return reply.code(404).send({ error: 'Invalid attachment file' });
        }

        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;
        if (!await storedAttachmentExists(ref)) {
            return reply.code(404).send({ error: 'Attachment not found' });
        }
        await markAttachmentStatus(
            userId,
            ref,
            [RESERVATION_STATUS, UPLOADING_STATUS, COMPLETE_STATUS],
            COMPLETE_STATUS,
        );

        if (isLocalStorage()) {
            const fullPath = path.join(getLocalFilesDir(), ref);
            reply.header('Content-Type', 'application/octet-stream');
            return reply.type('application/octet-stream').send(fs.readFileSync(fullPath));
        } else {
            // S3 mode: redirect to presigned GET URL (15 min, per design).
            const url = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
            return reply.redirect(url);
        }
    });
}
