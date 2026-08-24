import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    state,
    dbMock,
    filesMock,
    fsMock,
    resetState,
    seedSession
} = vi.hoisted(() => {
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        uploads: new Map<string, Buffer>(),
        reservations: new Map<string, { id?: string; accountId: string; size: number; reuseKey?: string | null; updatedAt?: Date }>(),
        useLocalStorage: true,
        s3PostUrl: "https://s3.test/post-url",
        s3GetUrl: "https://s3.test/get-url",
        s3PolicyMaxLength: 0,
    };

    const resetState = () => {
        state.sessions = [];
        state.uploads = new Map();
        state.reservations = new Map();
        state.useLocalStorage = true;
        state.s3PolicyMaxLength = 0;
    };

    const seedSession = (id: string, accountId: string) => {
        state.sessions.push({ id, accountId });
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        return state.sessions.find((s) =>
            s.id === args?.where?.id && s.accountId === args?.where?.accountId,
        ) ?? null;
    });

    const dbMock = {
        $queryRawUnsafe: vi.fn(async (sql: string, accountId: string, ...args: any[]) => {
            if (sql.includes('UPDATE "UploadedFile" SET "reuseKey"')) {
                const [cutoff, cleaningStatus, reservedStatus, uploadingStatus, limit] = args;
                const claimed: Array<{ id: string; path: string }> = [];
                for (const [ref, row] of state.reservations) {
                    if (claimed.length >= limit) break;
                    if (row.accountId === accountId &&
                        [reservedStatus, uploadingStatus].includes(row.reuseKey) &&
                        (row.updatedAt ?? new Date()) < cutoff) {
                        row.reuseKey = cleaningStatus;
                        row.updatedAt = new Date();
                        claimed.push({ id: row.id!, path: ref });
                    }
                }
                return claimed;
            }
            if (sql.includes('COUNT(*) AS "count"')) {
                const rows = [...state.reservations.values()].filter((r) => r.accountId === accountId);
                const used = rows
                    .filter((r) => r.accountId === accountId)
                    .reduce((n, r) => n + r.size, 0);
                return [{ count: BigInt(rows.length), bytes: BigInt(used) }];
            }
            if (sql.includes('SELECT "size"')) {
                const filePath = args[0];
                const row = filePath ? state.reservations.get(filePath) : undefined;
                return row?.accountId === accountId ? [{ size: row.size, reuseKey: row.reuseKey ?? null }] : [];
            }
            return [{ id: accountId }];
        }),
        $executeRawUnsafe: vi.fn(async (sql: string, id: string, accountId: string, filePath: string, size: number, reuseKey: string) => {
            if (sql.includes('INSERT INTO "UploadedFile"')) {
                state.reservations.set(filePath, { id, accountId, size, reuseKey, updatedAt: new Date() });
            }
            return 1;
        }),
        session: { findFirst: sessionFindFirst },
        uploadedFile: {
            deleteMany: vi.fn(async ({ where }: any) => {
                let count = 0;
                for (const [ref, row] of [...state.reservations]) {
                    if ((where.path === undefined || where.path === ref) &&
                        (where.id === undefined || where.id === row.id) &&
                        (where.accountId === undefined || where.accountId === row.accountId) &&
                        (where.reuseKey === undefined || where.reuseKey === row.reuseKey)) {
                        state.reservations.delete(ref);
                        count++;
                    }
                }
                return { count };
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                let count = 0;
                for (const [ref, row] of state.reservations) {
                    const reuseMatches = where.reuseKey === undefined || where.reuseKey === null
                        ? where.reuseKey === undefined || (row.reuseKey ?? null) === null
                        : typeof where.reuseKey === 'object'
                            ? where.reuseKey.in.includes(row.reuseKey)
                            : row.reuseKey === where.reuseKey;
                    if ((where.path === undefined || where.path === ref) &&
                        (where.accountId === undefined || where.accountId === row.accountId) && reuseMatches) {
                        Object.assign(row, data);
                        count++;
                    }
                }
                return { count };
            }),
            count: vi.fn(async ({ where }: any) => [...state.reservations.entries()].filter(([ref, row]) =>
                (where.path === undefined || where.path === ref) &&
                (where.accountId === undefined || where.accountId === row.accountId) &&
                (where.reuseKey === undefined || (row.reuseKey ?? null) === where.reuseKey),
            ).length),
        },
    };

    const filesMock = {
        s3client: {
            newPostPolicy: () => {
                const policy = {
                    bucket: "",
                    key: "",
                    expires: new Date(),
                    minLen: 0,
                    maxLen: 0,
                    setBucket(b: string) { policy.bucket = b; },
                    setKey(k: string) { policy.key = k; },
                    setExpires(d: Date) { policy.expires = d; },
                    setContentLengthRange(min: number, max: number) {
                        policy.minLen = min;
                        policy.maxLen = max;
                        state.s3PolicyMaxLength = max;
                    },
                };
                return policy;
            },
            presignedPostPolicy: vi.fn(async (_policy: any) => ({
                postURL: state.s3PostUrl,
                formData: { key: _policy.key, policy: "stub-policy" },
            })),
            presignedGetObject: vi.fn(async (_bucket: string, _key: string, _ttl: number) => state.s3GetUrl),
            statObject: vi.fn(async (_bucket: string, key: string) => {
                if (!state.uploads.has(key)) {
                    throw Object.assign(new Error('missing'), { code: 'NoSuchKey', statusCode: 404 });
                }
                return { size: state.uploads.get(key)!.length };
            }),
        },
        s3bucket: "test-bucket",
        isLocalStorage: vi.fn(() => state.useLocalStorage),
        getLocalFilesDir: vi.fn(() => "/tmp/test-files"),
        putLocalFile: vi.fn(async (filePath: string, data: Buffer) => {
            state.uploads.set(filePath, data);
        }),
        deleteStoredFile: vi.fn(async (filePath: string) => {
            state.uploads.delete(filePath);
        }),
    };

    const fsMock = {
        existsSync: vi.fn((p: string) => {
            const rel = p.replace(/^\/tmp\/test-files\//, "");
            return state.uploads.has(rel);
        }),
        readFileSync: vi.fn((p: string) => {
            const rel = p.replace(/^\/tmp\/test-files\//, "");
            return state.uploads.get(rel) ?? Buffer.alloc(0);
        }),
    };

    return { state, dbMock, filesMock, fsMock, resetState, seedSession };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/inTx", () => ({ inTx: async (fn: any) => fn(dbMock) }));
vi.mock("@/app/auth/authRateLimiter", () => ({ allowAuthRequest: vi.fn(async () => true) }));
vi.mock("@/storage/files", () => filesMock);
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return { ...actual, existsSync: fsMock.existsSync, readFileSync: fsMock.readFileSync };
});

import { attachmentRoutes } from "./attachmentRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    // Octet-stream parser is normally registered in api.ts startApi() — mirror
    // that here so PUT bodies arrive as Buffer in the handler.
    app.addContentTypeParser(
        "application/octet-stream",
        { parseAs: "buffer" },
        (_req, body, done) => done(null, body),
    );

    attachmentRoutes(typed);
    await typed.ready();
    return typed;
}

describe("attachmentRoutes — request-upload", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        delete process.env.MAX_UPLOADED_FILES_PER_ACCOUNT;
        delete process.env.ATTACHMENT_RESERVATION_TTL_MINUTES;
    });
    afterEach(async () => {
        if (app) await app.close();
        delete process.env.MAX_UPLOADED_FILES_PER_ACCOUNT;
        delete process.env.ATTACHMENT_RESERVATION_TTL_MINUTES;
    });

    it("returns 200 with .enc ref + method=PUT in local mode for the session owner", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "screenshot.exe", size: 1024 },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.method).toBe("PUT");
        expect(body.ref).toMatch(/^sessions\/s1\/attachments\/[A-Fa-f0-9-]+\.enc$/);
        expect(body.uploadUrl).toContain("/v1/sessions/s1/attachments/");
        expect(body.uploadUrl).toMatch(/\.enc$/);
    });

    it("returns 200 with method=POST + formFields and a content-length-range policy in S3 mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "img.jpg", size: 1024 },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.method).toBe("POST");
        expect(body.uploadUrl).toBe("https://s3.test/post-url");
        expect(body.formFields).toBeDefined();
        expect(state.s3PolicyMaxLength).toBe(1024);
    });

    it("returns 404 when the requesting user is not the session owner", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u2" },
            payload: { filename: "x.png", size: 100 },
        });
        expect(res.statusCode).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            payload: { filename: "x.png", size: 100 },
        });
        expect(res.statusCode).toBe(401);
    });

    it("returns 413 when the declared size exceeds the 10MB limit", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "huge.bin", size: 10 * 1024 * 1024 + 1 },
        });
        // Zod schema rejects size > 10MB at validation stage with 400.
        expect([400, 413]).toContain(res.statusCode);
    });

    it("serializes attachment row capacity independently from the byte quota", async () => {
        seedSession("s1", "u1");
        process.env.MAX_UPLOADED_FILES_PER_ACCOUNT = "1";
        app = await createApp();

        expect((await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "one", size: 1 },
        })).statusCode).toBe(200);
        const full = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "two", size: 1 },
        });
        expect(full.statusCode).toBe(429);
        expect(full.json()).toEqual({ error: "attachment_count_quota_exceeded" });
    });

    it("reclaims expired uncompleted reservations and their stored objects before reserving", async () => {
        seedSession("s1", "u1");
        process.env.ATTACHMENT_RESERVATION_TTL_MINUTES = "1";
        state.reservations.set("sessions/s1/attachments/old.enc", {
            id: "old-row",
            accountId: "u1",
            size: 1,
            reuseKey: "attachment-reserved",
            updatedAt: new Date(Date.now() - 120_000),
        });
        state.uploads.set("sessions/s1/attachments/old.enc", Buffer.from("orphan"));
        state.reservations.set("sessions/s1/attachments/complete.enc", {
            id: "complete-row",
            accountId: "u1",
            size: 1,
            reuseKey: "attachment-complete",
            updatedAt: new Date(Date.now() - 120_000),
        });
        state.uploads.set("sessions/s1/attachments/complete.enc", Buffer.from("kept"));
        app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-upload",
            headers: { "x-user-id": "u1" },
            payload: { filename: "replacement", size: 1 },
        });
        expect(response.statusCode).toBe(200);
        expect(state.reservations.has("sessions/s1/attachments/old.enc")).toBe(false);
        expect(state.uploads.has("sessions/s1/attachments/old.enc")).toBe(false);
        expect(state.reservations.has("sessions/s1/attachments/complete.enc")).toBe(true);
        expect(state.uploads.get("sessions/s1/attachments/complete.enc")).toEqual(Buffer.from("kept"));
    });
});

describe("attachmentRoutes — PUT (local-mode upload)", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); });
    afterEach(async () => { if (app) await app.close(); });

    it("accepts the encrypted blob from the session owner and stores it under the session prefix", async () => {
        seedSession("s1", "u1");
        state.reservations.set("sessions/s1/attachments/abc.enc", { accountId: "u1", size: 1024 });
        state.useLocalStorage = true;
        app = await createApp();

        const blob = Buffer.from("encrypted-bytes");
        const res = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: blob,
        });

        expect(res.statusCode).toBe(200);
        expect(state.uploads.get("sessions/s1/attachments/abc.enc")).toEqual(blob);
    });

    it("rejects path traversal in attachment file segment", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const evil = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/..evil",
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(evil.statusCode).toBe(404);
    });

    it("rejects upload from a non-owner of the session", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u2", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PUT in S3 mode (direct upload not available)", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        app = await createApp();

        const res = await app.inject({
            method: "PUT",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1", "content-type": "application/octet-stream" },
            payload: Buffer.from("x"),
        });
        expect(res.statusCode).toBe(404);
    });
});

describe("attachmentRoutes — POST request-download", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); });
    afterEach(async () => { if (app) await app.close(); });

    it("returns a server-relative downloadUrl for the session owner in local mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s1/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.downloadUrl).toContain("/v1/sessions/s1/attachments/abc.enc");
    });

    it("returns a presigned S3 GET URL in S3 mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s1/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().downloadUrl).toBe("https://s3.test/get-url");
    });

    it.each([true, false])("does not complete a missing reserved object (local=%s)", async (local) => {
        seedSession("s1", "u1");
        state.useLocalStorage = local;
        const ref = "sessions/s1/attachments/missing.enc";
        state.reservations.set(ref, {
            id: "reservation-1",
            accountId: "u1",
            size: 1024,
            reuseKey: "attachment-reserved",
            updatedAt: new Date("2026-08-24T00:00:00Z"),
        });
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref },
        });

        expect(res.statusCode).toBe(404);
        expect(state.reservations.get(ref)?.reuseKey).toBe("attachment-reserved");
    });

    it("rejects a ref that does not belong to the requested session (cross-session attack)", async () => {
        seedSession("s1", "u1");
        seedSession("s2", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s2/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(400);
    });

    it("rejects path traversal inside the ref", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u1" },
            payload: { ref: "sessions/s1/attachments/../escape" },
        });

        expect(res.statusCode).toBe(400);
    });

    it("returns 404 for a non-owner of the session", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            headers: { "x-user-id": "u2" },
            payload: { ref: "sessions/s1/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
        seedSession("s1", "u1");
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/sessions/s1/attachments/request-download",
            payload: { ref: "sessions/s1/attachments/abc.enc" },
        });

        expect(res.statusCode).toBe(401);
    });
});

describe("attachmentRoutes — GET (download)", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); });
    afterEach(async () => { if (app) await app.close(); });

    it("serves the encrypted blob to the session owner in local mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1" },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("application/octet-stream");
        expect(res.rawPayload).toEqual(Buffer.from("payload"));
    });

    it("redirects to a presigned GET URL in S3 mode for the session owner", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = false;
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u1" },
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("https://s3.test/get-url");
    });

    it("returns 404 for non-owner", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        state.uploads.set("sessions/s1/attachments/abc.enc", Buffer.from("payload"));
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/abc.enc",
            headers: { "x-user-id": "u2" },
        });
        expect(res.statusCode).toBe(404);
    });

    it("rejects path traversal", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/..evil",
            headers: { "x-user-id": "u1" },
        });
        expect(res.statusCode).toBe(404);
    });

    it("returns 404 when the attachment file is missing in local mode", async () => {
        seedSession("s1", "u1");
        state.useLocalStorage = true;
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/v1/sessions/s1/attachments/missing.enc",
            headers: { "x-user-id": "u1" },
        });
        expect(res.statusCode).toBe(404);
    });
});
