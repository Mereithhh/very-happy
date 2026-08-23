/**
 * Attachment upload/download routes for image attachments in chat sessions.
 *
 * Two storage modes:
 * - S3: Returns presigned PUT/GET URLs. Server never touches file bytes.
 * - Local: Server accepts/serves encrypted blobs directly.
 *
 * No database records — attachments are identified by their ref path.
 * Cleanup happens when sessions are deleted (Phase 8).
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Fastify } from '../types';
import { db } from '@/storage/db';
import { s3client, s3bucket, isLocalStorage, getLocalFilesDir, putLocalFile } from '@/storage/files';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { configuredResourceLimit, lockAccountResources, withinByteQuota } from '../resourceLimits';
import { inTx } from '@/storage/inTx';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const PRESIGNED_TTL_SECONDS = 15 * 60; // 15 minutes (design spec)

const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 60;

type AttachmentSqlClient = Pick<typeof db, '$queryRawUnsafe' | '$executeRawUnsafe'>;

async function reservedAttachmentBytes(client: AttachmentSqlClient, accountId: string): Promise<number> {
    const rows = await client.$queryRawUnsafe<Array<{ used: bigint | number | string }>>(
        `SELECT COALESCE(SUM("size"), 0) AS "used"
         FROM "UploadedFile" WHERE "accountId" = $1 AND "path" LIKE 'sessions/%'`,
        accountId,
    );
    return Number(rows[0]?.used ?? 0);
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
        `INSERT INTO "UploadedFile" ("id", "accountId", "path", "size", "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        crypto.randomUUID(),
        accountId,
        ref,
        size,
    );
}

async function attachmentReservationSize(
    client: AttachmentSqlClient,
    accountId: string,
    ref: string,
): Promise<number | null> {
    const rows = await client.$queryRawUnsafe<Array<{ size: number | null }>>(
        `SELECT "size" FROM "UploadedFile" WHERE "accountId" = $1 AND "path" = $2 LIMIT 1`,
        accountId,
        ref,
    );
    return rows[0]?.size ?? null;
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
                sessionId: z.string(),
            }),
            body: z.object({
                filename: z.string(),
                size: z.number().int().min(1).max(MAX_FILE_SIZE),
            }),
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

        if (size > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'File too large (max 10MB)' });
        }

        // Always .enc — encrypted opaque blobs, never trust client filename for path.
        const attachmentId = crypto.randomUUID();
        const attachmentFile = `${attachmentId}.enc`;
        const ref = `sessions/${sessionId}/attachments/${attachmentFile}`;

        const maxAccountBytes = configuredResourceLimit('MAX_ATTACHMENT_BYTES_PER_ACCOUNT', 100 * 1024 * 1024);
        const reserved = await inTx(async (tx) => {
            await lockAccountResources(tx, userId);
            const used = await reservedAttachmentBytes(tx, userId);
            if (!withinByteQuota(used, size, maxAccountBytes)) return false;
            await reserveAttachment(tx, userId, ref, size);
            return true;
        });
        if (!reserved) return reply.code(413).send({ error: 'Account attachment storage limit reached' });

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
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
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
        const reservationSize = await attachmentReservationSize(db, userId, ref);
        if (reservationSize === null || body.length > reservationSize) {
            return reply.code(413).send({ error: 'Upload exceeds its reserved size' });
        }
        await putLocalFile(ref, body);

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
                sessionId: z.string(),
            }),
            body: z.object({
                ref: z.string(),
            }),
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
                sessionId: z.string(),
                attachmentFile: z.string(),
            }),
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

        if (isLocalStorage()) {
            const fullPath = path.join(getLocalFilesDir(), ref);
            if (!fs.existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Attachment not found' });
            }
            reply.header('Content-Type', 'application/octet-stream');
            return reply.type('application/octet-stream').send(fs.readFileSync(fullPath));
        } else {
            // S3 mode: redirect to presigned GET URL (15 min, per design).
            const url = await s3client.presignedGetObject(s3bucket, ref, PRESIGNED_TTL_SECONDS);
            return reply.redirect(url);
        }
    });
}
