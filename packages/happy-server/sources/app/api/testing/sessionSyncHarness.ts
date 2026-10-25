/**
 * B-811 test harness: a real database (PGlite by default, a real Postgres when
 * VH_TEST_DATABASE_URL is set), real socket.io servers wired the way
 * `startSocket` wires them, and the four production `new-message` writers
 * (v3 POST, CLI socket `message`, prompt-queue dispatch, share driver).
 *
 * Test-only. Import it lazily from a spec AFTER `prepareSyncTestDatabase`,
 * because `@/storage/db` binds its provider at import time.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server, Socket } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';

export interface SyncTestDatabase {
    provider: 'pglite' | 'postgres';
    cleanup: () => void;
}

/** Must run before anything imports `@/storage/db`. */
export async function prepareSyncTestDatabase(label: string): Promise<SyncTestDatabase> {
    process.env.HANDY_MASTER_SECRET = `${label}-integration-test-only`;
    process.env.MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE = '1000000';
    await (await import('@/modules/encrypt')).initEncrypt();
    const url = process.env.VH_TEST_DATABASE_URL;
    if (url) {
        process.env.DB_PROVIDER = 'postgres';
        process.env.DATABASE_URL = url;
        execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'ignore' });
        return { provider: 'postgres', cleanup: () => {} };
    }
    const parent = join(homedir(), 'code/github/skills/tmp', `${label}-tests`);
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    process.env.DB_PROVIDER = 'pglite';
    process.env.PGLITE_DIR = join(root, 'db');
    const { runMigrations } = await import('@/standalone');
    await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
    return { provider: 'pglite', cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- fixtures

export interface SharedSessionFixture {
    ownerId: string;
    granteeId: string;
    strangerId: string;
    sessionId: string;
    grantId: string;
}

async function createAccount(name: string) {
    const { db } = await import('@/storage/db');
    const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
    const secretBytes = randomBytes(32);
    const account = await db.account.create({ data: { publicKey: randomBytes(16).toString('hex'), username: name, firstName: name } });
    await upsertAccountSecret(db, account.id, secretBytes.toString('base64url'));
    await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email', providerSubject: `${name}@example.com`, email: `${name}@example.com` } });
    return { id: account.id, secret: new Uint8Array(secretBytes) };
}

/** A DEK session (as the CLI creates it) with an ACCEPTED driver grant, so every writer works. */
export async function createSharedSession(prefix: string): Promise<SharedSessionFixture> {
    const { db } = await import('@/storage/db');
    const crypto = await import('@/app/session/sessionCrypto');
    const shares = await import('@/app/session/sessionShares');
    const tag = randomBytes(4).toString('hex');
    const owner = await createAccount(`${prefix}owner${tag}`);
    const grantee = await createAccount(`${prefix}grantee${tag}`);
    const stranger = await createAccount(`${prefix}stranger${tag}`);
    const dek = new Uint8Array(randomBytes(32));
    const ownerKeys = crypto.contentKeyPairFromSecret(owner.secret);
    const session = await db.session.create({ data: {
        accountId: owner.id,
        tag: randomBytes(8).toString('hex'),
        metadata: Buffer.from(crypto.encryptWithDataKey({ path: '/repo' }, dek)).toString('base64'),
        dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(dek, ownerKeys.publicKey)),
    } });
    const grant = await shares.createSessionGrant({ ownerId: owner.id, sessionId: session.id, granteeAccountId: grantee.id, role: 'driver' });
    await shares.respondToSessionGrant(grantee.id, grant.id, true);
    return { ownerId: owner.id, granteeId: grantee.id, strangerId: stranger.id, sessionId: session.id, grantId: grant.id };
}

// ---------------------------------------------------------------- servers

export interface SyncTestServer {
    io: Server;
    url: string;
    close: () => Promise<void>;
}

export interface SyncServerOptions {
    /**
     * 'prod': join rooms at connect exactly like startSocket (eventRouter.addConnection).
     * 'lazy': a web socket is NOT put in its user-scoped room at connect, so
     * the handler's own ensure-join is the only thing standing between a
     * snapshot and a lost push — the harder condition the atomicity property
     * runs under (and what the mutation check breaks).
     */
    joinMode: 'prod' | 'lazy';
    syncDeps?: import('@/app/api/socket/sessionSyncHandler').SessionSyncDeps;
    adapter?: (io: Server) => void;
    /** Bind eventRouter / share fan-out to this server (the slot that writes). */
    routeEvents: boolean;
}

export async function startSyncServer(options: SyncServerOptions): Promise<SyncTestServer> {
    const { Server } = await import('socket.io');
    const { eventRouter } = await import('@/app/events/eventRouter');
    const { installSessionShareFanout } = await import('@/app/session/sessionShares');
    const { sessionUpdateHandler } = await import('@/app/api/socket/sessionUpdateHandler');
    const { sessionSyncHandler } = await import('@/app/api/socket/sessionSyncHandler');
    const http: HttpServer = createServer();
    const io = new Server(http);
    options.adapter?.(io);
    if (options.routeEvents) {
        eventRouter.init(io);
        installSessionShareFanout();
    }
    io.on('connection', (socket: Socket) => {
        const { userId, clientType, sessionId } = socket.handshake.auth as { userId: string; clientType?: string; sessionId?: string };
        socket.data.userId = userId;
        socket.data.clientType = clientType ?? 'user-scoped';
        const connection: any = clientType === 'session-scoped'
            ? { connectionType: 'session-scoped', socket, userId, sessionId }
            : { connectionType: 'user-scoped', socket, userId };
        if (options.joinMode === 'prod' || connection.connectionType !== 'user-scoped') {
            eventRouter.addConnection(userId, connection);
        } else {
            void socket.join(`user:${userId}`);
        }
        sessionUpdateHandler(userId, socket, connection);
        sessionSyncHandler(userId, socket, connection, options.syncDeps);
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    return {
        io,
        url,
        close: async () => {
            await new Promise<void>((resolve) => io.close(() => resolve()));
            if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
        },
    };
}

export interface TestClient {
    socket: ClientSocket;
    /** new-message pushes seen on this socket: sid → seqs. */
    pushes: Map<string, number[]>;
    updates: any[];
}

export function connectClient(url: string, auth: Record<string, unknown>): Promise<TestClient> {
    const socket = connect(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
    const pushes = new Map<string, number[]>();
    const updates: any[] = [];
    socket.on('update', (update: any) => {
        updates.push(update);
        if (update?.body?.t !== 'new-message') return;
        const sid = update.body.sid as string;
        pushes.set(sid, [...(pushes.get(sid) ?? []), update.body.message.seq as number]);
    });
    return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve({ socket, pushes, updates }));
        socket.once('connect_error', reject);
    });
}

export function emitWithAck<T = any>(socket: ClientSocket, event: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
    return socket.timeout(timeoutMs).emitWithAck(event, payload) as Promise<T>;
}

// ---------------------------------------------------------------- writers

export type WriterKind = 'v3-post' | 'socket-message' | 'prompt-queue' | 'share-driver';
export const WRITER_KINDS: WriterKind[] = ['v3-post', 'socket-message', 'prompt-queue', 'share-driver'];

export interface Writers {
    write(kind: WriterKind): Promise<void>;
    close(): Promise<void>;
}

let localCounter = 0;
const nextLocalId = (kind: string) => `${kind}-${process.pid}-${++localCounter}`;

/**
 * The four production emit sources, against one session. `socket-message`
 * resolves only once the row is visible, since the CLI path has no ack.
 */
export async function createWriters(url: string, fixture: SharedSessionFixture): Promise<Writers> {
    const fastify = (await import('fastify')).default;
    const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
    const { v3SessionRoutes } = await import('@/app/api/routes/v3SessionRoutes');
    const { enqueuePrompt, dispatchPromptQueueHead } = await import('@/app/promptQueue/store');
    const { postSharedMessage } = await import('@/app/session/sessionShares');
    const { db } = await import('@/storage/db');

    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider() as any;
    typed.decorate('authenticate', async (request: any) => { request.userId = request.headers['x-test-user']; });
    v3SessionRoutes(typed);
    await typed.ready();

    const cli = await connectClient(url, { userId: fixture.ownerId, clientType: 'session-scoped', sessionId: fixture.sessionId });

    const waitForLocalId = async (localId: string) => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
            if (await db.sessionMessage.findFirst({ where: { sessionId: fixture.sessionId, localId }, select: { id: true } })) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`socket message ${localId} never landed`);
    };

    return {
        async write(kind) {
            const localId = nextLocalId(kind);
            switch (kind) {
                case 'v3-post': {
                    const response = await typed.inject({
                        method: 'POST',
                        url: `/v3/sessions/${fixture.sessionId}/messages`,
                        headers: { 'x-test-user': fixture.ownerId },
                        payload: { messages: [{ localId, content: `c-${localId}` }] },
                    });
                    if (response.statusCode !== 200) throw new Error(`v3 POST ${response.statusCode}: ${response.body}`);
                    return;
                }
                case 'socket-message':
                    cli.socket.emit('message', { sid: fixture.sessionId, message: `c-${localId}`, localId });
                    await waitForLocalId(localId);
                    return;
                case 'prompt-queue':
                    await enqueuePrompt(fixture.ownerId, fixture.sessionId, { localId, content: Buffer.from(localId).toString('base64') });
                    await dispatchPromptQueueHead(fixture.ownerId, fixture.sessionId);
                    return;
                case 'share-driver':
                    await postSharedMessage({ granteeAccountId: fixture.granteeId, sessionId: fixture.sessionId, text: localId, localId });
                    return;
            }
        },
        async close() {
            cli.socket.close();
            await typed.close();
        },
    };
}

export async function committedSeqs(sessionId: string, afterSeq: number): Promise<number[]> {
    const { db } = await import('@/storage/db');
    const rows = await db.sessionMessage.findMany({ where: { sessionId, seq: { gt: afterSeq } }, select: { seq: true }, orderBy: { seq: 'asc' } });
    return rows.map((row) => row.seq);
}

export async function sessionHead(sessionId: string): Promise<number> {
    const { db } = await import('@/storage/db');
    return (await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { seq: true } })).seq;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic PRNG so a failing round can be replayed from its seed. */
export function seededRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
