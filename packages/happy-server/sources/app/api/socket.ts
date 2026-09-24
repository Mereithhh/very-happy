import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server } from "socket.io";
import { Redis, type RedisOptions } from "ioredis";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { log, warn } from "@/utils/log";
import { attachSocketDiagnostics } from "@/utils/socketDiagnostics";
import { auth } from "@/app/auth/auth";
import { getMetricsLabelsFromSocket, redisClientErrorsCounter, redisStreamLagMsGauge, socketRecoveryCounter, socketRecoveryScannedEntries, socketStreamHeadAgeSeconds, socketStreamLengthGauge, releaseHandoverCounter, releaseHandoverDuration, websocketConnectionsGauge, websocketEventsCounter } from "../monitoring/metrics2";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { terminalHandler } from "./socket/terminalHandler";
import { clipboardHandler } from "./socket/clipboardHandler";
import { sessionStreamHandler } from "./socket/sessionStreamHandler";
import { filePreviewHandler } from "./socket/filePreviewHandler";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { parseSocketClientType, validateSocketOwnership } from './socket/socketIdentity';
import { recordClientVersion } from './socket/clientVersion';
import { AccountTerminalRateLimiter, resolveRpcRelayLimit, resolveSessionStreamRelayLimit, resolveTerminalRelayLimit } from './socket/terminalRateLimit';
import { resolveSocketConnectionLimit } from './socket/socketConnectionLimit';
import { resolveReleaseConfig } from '@/app/release/releaseConfig';
import { ReleaseCoordinator } from '@/app/release/releaseCoordinator';
import { closeCoordinationRedis, initializeCoordinationRedis } from '@/app/release/redisCoordination';
import { DistributedSocketConnectionLimiter } from './socket/distributedSocketLimit';
import { createBoundedStreamsAdapter, defaultRecoveryLimits, SOCKET_STREAM_MAX_LEN, type AdapterConnections } from './socket/boundedStreamsAdapter';

export const SOCKET_STREAM_NAME = 'vh:socket.io';
export const SOCKET_RECOVERY_WINDOW_MS = 30_000;

const REDIS_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']);

/** Bounded label for redis_client_errors_total; also replaces ioredis' "Unhandled error event" log. */
export function redisErrorCode(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && REDIS_ERROR_CODES.has(code)) return code;
    const message = error instanceof Error ? error.message : String(error);
    if (/^OOM\b/.test(message)) return 'OOM';
    if (/timed? ?out/i.test(message)) return 'timeout';
    return 'other';
}

function recordRedisError(client: string, error: unknown) {
    const code = redisErrorCode(error);
    redisClientErrorsCounter.inc({ client, code });
    warn({ module: 'redis' }, `[${client}] Redis error ${code}: ${error instanceof Error ? error.message : String(error)}`);
}

function configuredLimit(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function machinePresenceRoom(userId: string, machineId: string): string {
    return `presence:machine:${userId}:${machineId}`;
}

export async function startSocket(app: Fastify, staticDir?: string): Promise<ReleaseCoordinator | null> {
    const socketPayloadLimit = configuredLimit('SOCKET_MAX_PAYLOAD_BYTES', 1024 * 1024);
    const io = new Server(app.server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "OPTIONS"],
            credentials: true,
            allowedHeaders: ["*"]
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false, // Don't serve the client files
        maxHttpBufferSize: socketPayloadLimit === 0 ? Number.MAX_SAFE_INTEGER : socketPayloadLimit,
        // Brief-disconnect event replay — ON. socket.io replays events the
        // server knows it missed (streams adapter restoreSession via the
        // Redis stream) and the client reconnects with socket.recovered ===
        // true, skipping the full onReconnected refetch. Verified
        // cross-replica via deploy/integration-tests/missed-events.mjs.
        // Client-side caveat (web apiSocket.onRecovered): events emitted into
        // a half-dead link BEFORE the server noticed the disconnect are not in
        // the replay, so a recovered connect still triggers a bounded refetch
        // of the viewed session. Spec: specs/2026-08-web-resume-sync.md.
        // B-494: the adapter refuses recoveries that would scan too much
        // (see socket/boundedStreamsAdapter.ts); those clients get
        // recovered === false and take the full resync path instead.
        connectionStateRecovery: {
            maxDisconnectionDuration: SOCKET_RECOVERY_WINDOW_MS,
            skipMiddlewares: false,
        },
    });
    const terminalRateLimiter = new AccountTerminalRateLimiter(resolveTerminalRelayLimit());
    const rpcRateLimiter = new AccountTerminalRateLimiter(resolveRpcRelayLimit());
    // B-309: separate bucket — a burst of disposable drafts must not be able to
    // drain the allowance that disconnects the user's terminal socket.
    const sessionStreamRateLimiter = new AccountTerminalRateLimiter(resolveSessionStreamRelayLimit());

    const releaseConfig = resolveReleaseConfig();
    if (releaseConfig && !process.env.REDIS_URL) {
        throw new Error('REDIS_URL is required when release coordination is enabled');
    }

    let releaseCoordinator: ReleaseCoordinator | null = null;
    let distributedConnectionLimiter: DistributedSocketConnectionLimiter | null = null;
    let adapterConnections: AdapterConnections | null = null;
    let streamLagTimer: NodeJS.Timeout | null = null;

    // Multi-process support: attach Redis streams adapter when REDIS_URL is set.
    // Adapter connections are separate from coordination (readiness, relay
    // leases) and, since B-494, from each other: publish (XADD) / poll (XREAD
    // BLOCK) / restore (recovery XRANGE). See boundedStreamsAdapter.ts.
    if (process.env.REDIS_URL) {
        const coordinationRedis = await initializeCoordinationRedis(process.env.REDIS_URL);
        coordinationRedis.on('error', (error) => recordRedisError('coordination', error));
        const connect = async (role: string, extra: Partial<RedisOptions>) => {
            const client = new Redis(process.env.REDIS_URL!, {
                lazyConnect: true,
                enableReadyCheck: true,
                maxRetriesPerRequest: null,
                connectionName: `vh-adapter-${role}`,
                ...extra,
            });
            client.on('error', (error) => recordRedisError(`adapter_${role}`, error));
            await client.connect();
            if (await client.ping() !== 'PONG') throw new Error(`Socket adapter Redis PING failed (${role})`);
            return client;
        };
        adapterConnections = {
            // Broadcasts must not be dropped: keep queueing across reconnects.
            publish: await connect('publish', {}),
            poll: await connect('poll', {}),
            // A recovery read that cannot finish quickly is abandoned; the
            // client then falls back to its full resync instead of waiting.
            restore: await connect('restore', { maxRetriesPerRequest: 1, commandTimeout: 5_000 }),
        };
        const recoveryLimits = defaultRecoveryLimits(SOCKET_RECOVERY_WINDOW_MS);
        io.adapter(createBoundedStreamsAdapter(adapterConnections, {
            streamName: SOCKET_STREAM_NAME,
            sessionKeyPrefix: 'vh:sio:session:',
            maxLen: SOCKET_STREAM_MAX_LEN,
            readCount: 2000,
            heartbeatInterval: 5_000,
            heartbeatTimeout: 10_000,
            limits: recoveryLimits,
            // Sessions are persisted by the stock adapter (possibly on the
            // other slot) as base64 msgpack; decode with the adapter's own
            // msgpack package so both slots agree on the format.
            decodeSession: (raw) => msgpackDecode(Buffer.from(raw, 'base64')),
            observer: {
                onOutcome(outcome, scanned) {
                    socketRecoveryCounter.inc({ outcome });
                    if (outcome !== 'offset_too_old' && outcome !== 'invalid_offset' && outcome !== 'busy') {
                        socketRecoveryScannedEntries.observe(scanned);
                    }
                    if (outcome === 'scan_limit' || outcome === 'error' || outcome === 'busy' || outcome === 'timeout') {
                        warn({ module: 'websocket' }, `connection state recovery skipped: ${outcome} (scanned ${scanned})`);
                    }
                },
            },
        }));
        log({ module: 'websocket' }, `Redis streams adapter enabled (maxLen ~${SOCKET_STREAM_MAX_LEN}, recovery offset age ≤${recoveryLimits.maxOffsetAgeMs}ms, scan ≤${recoveryLimits.maxScanEntries})`);
        const adapterRedis = adapterConnections;

        // Track stream reader lag: wrap onRawMessage to capture last-read offset,
        // then periodically compare against stream HEAD.
        let lastReadOffset = "0-0";
        const adapter = io.of("/").adapter as any;
        const origOnRawMessage = adapter.onRawMessage.bind(adapter);
        adapter.onRawMessage = (msg: any, offset: string) => {
            lastReadOffset = offset;
            return origOnRawMessage(msg, offset);
        };
        // Sampled on the restore connection (it has a command timeout), so a
        // stalled publish connection shows up as a growing head age instead
        // of a frozen sample.
        let lastHeadMs = 0;
        streamLagTimer = setInterval(async () => {
            try {
                const info = await adapterRedis.restore.xinfo("STREAM", SOCKET_STREAM_NAME) as any[];
                const headId = String(info[info.indexOf("last-generated-id") + 1]);
                const headMs = parseInt(headId.split("-")[0]);
                const readMs = parseInt(lastReadOffset.split("-")[0]);
                redisStreamLagMsGauge.set(headMs - readMs);
                socketStreamLengthGauge.set(Number(info[info.indexOf("length") + 1]));
                lastHeadMs = headMs;
            } catch { /* stream may not exist yet, or Redis is unreachable */ }
            if (lastHeadMs > 0) socketStreamHeadAgeSeconds.set(Math.max(0, (Date.now() - lastHeadMs) / 1000));
        }, 5000);

        if (releaseConfig) {
            releaseCoordinator = new ReleaseCoordinator({
                app,
                io,
                config: releaseConfig,
                redis: coordinationRedis,
                adapterReadyAt: Date.now() + releaseConfig.adapterWarmupMs,
                staticDir,
            });
            releaseCoordinator.register();
            const perReplicaConnectionLimit = resolveSocketConnectionLimit();
            distributedConnectionLimiter = new DistributedSocketConnectionLimiter(
                coordinationRedis,
                // Preserve the pre-cluster aggregate budget (the old limiter
                // was process-local) and leave room for every supported client
                // to hold old + candidate sockets during make-before-break.
                perReplicaConnectionLimit === 0 ? 0 : perReplicaConnectionLimit * 2,
            );
        }
    }

    // Initialize event router with Socket.IO server instance
    eventRouter.init(io);

    // Auth runs in middleware so it completes BEFORE the client's `connect`
    // event fires. Without this, the async verifyToken in the connection
    // callback creates a window where client events (rpc-register, rpc-call)
    // arrive before handlers are attached — and get silently dropped.
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token as string;
        const parsedClientType = parseSocketClientType(socket.handshake.auth.clientType);
        if (parsedClientType === 'invalid') {
            next(new Error('Invalid client type'));
            return;
        }
        const clientType = parsedClientType;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;
        const machineId = socket.handshake.auth.machineId as string | undefined;

        if (!token) {
            log({ module: 'websocket' }, `No token provided`);
            next(new Error('Missing authentication token'));
            return;
        }

        const verified = await auth.verifyToken(token);
        if (!verified) {
            log({ module: 'websocket' }, `Invalid token provided`);
            next(new Error('Invalid authentication token'));
            return;
        }

        const ownershipError = await validateSocketOwnership({ userId: verified.userId, clientType, sessionId, machineId });
        if (ownershipError) {
            next(new Error(ownershipError));
            return;
        }

        socket.data.userId = verified.userId;
        socket.data.clientType = clientType;
        socket.data.sessionId = sessionId;
        socket.data.machineId = machineId;
        socket.data.happyClient = socket.handshake.auth.happyClient as string
            || socket.handshake.headers['x-happy-client'] as string
            || undefined;
        socket.data.handoverEpoch = typeof socket.handshake.auth.handoverEpoch === 'string'
            ? socket.handshake.auth.handoverEpoch
            : undefined;
        if (distributedConnectionLimiter) {
            try {
                if (!await distributedConnectionLimiter.acquire(verified.userId, `${releaseConfig!.slot}:${socket.id}`)) {
                    next(new Error('Socket connection limit reached'));
                    return;
                }
            } catch (error) {
                log({ module: 'websocket', userId: verified.userId, error }, 'Distributed socket admission failed closed');
                next(new Error('Socket admission unavailable'));
                return;
            }
        }
        next();
    });

    const activeByUser = new Map<string, number>();
    io.on("connection", (socket) => {
        const userId = socket.data.userId as string;
        const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.data.sessionId as string | undefined;
        const machineId = socket.data.machineId as string | undefined;
        const labels = getMetricsLabelsFromSocket(socket);

        const connectionLimit = resolveSocketConnectionLimit();
        const active = activeByUser.get(userId) ?? 0;
        if (!distributedConnectionLimiter) {
            if (connectionLimit > 0 && active >= connectionLimit) {
                socket.emit('limit-reached', { resource: 'connections' });
                socket.disconnect(true);
                return;
            }
            activeByUser.set(userId, active + 1);
        }
        const limiterMember = releaseConfig ? `${releaseConfig.slot}:${socket.id}` : null;
        const limiterRefresh = distributedConnectionLimiter && limiterMember
            ? setInterval(() => void distributedConnectionLimiter!.refresh(userId, limiterMember)
                .then((acquired) => {
                    if (acquired) return;
                    socket.emit('limit-reached', { resource: 'connections' });
                    socket.disconnect(true);
                })
                .catch((error) => {
                    log({ module: 'websocket', userId, error }, 'Socket connection lease refresh failed');
                }), 20_000)
            : null;
        limiterRefresh?.unref?.();

        attachSocketDiagnostics(socket, {
            module: 'websocket', userId, sessionId, machineId,
            clientType: clientType || 'user-scoped',
            happyClient: socket.data.happyClient,
        });

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId, machineId };
        const happyClient = socket.data.happyClient as string | undefined;
        // B-297: keep a plaintext, SQL-queryable copy of the client version.
        // Fire-and-forget and self-swallowing — never gate the connection on it.
        if (metadata.clientType === 'machine-scoped' && machineId) {
            void recordClientVersion(userId, { kind: 'machine', machineId }, happyClient);
        } else if (metadata.clientType === 'session-scoped' && sessionId) {
            void recordClientVersion(userId, { kind: 'session', sessionId }, happyClient);
        }
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId,
                happyClient
            };
        } else if (metadata.clientType === 'machine-scoped' && machineId) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId,
                happyClient
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId,
                happyClient
            };
        }
        eventRouter.addConnection(userId, connection);
        websocketConnectionsGauge.inc({ type: connection.connectionType, ...labels });

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            void socket.join(machinePresenceRoom(userId, machineId!));
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(machineId!, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        // Track app focus state for push notification routing.
        // State lives on socket.data — no external storage needed.
        // Read initial state from handshake to close the race window between
        // connect and the first async app-state event.
        const initialAppState = socket.handshake.auth.appState as string | undefined;
        if (initialAppState) {
            socket.data.appState = initialAppState === 'active' ? 'active' : 'background';
        }

        socket.on('app-state', (data: { state: string }) => {
            socket.data.appState = data?.state === 'active' ? 'active' : 'background';
        });

        socket.on('release-handover-result', (data: { result?: unknown; durationMs?: unknown }) => {
            const result = data?.result === 'success' ? 'success' : 'failed';
            const durationMs = typeof data?.durationMs === 'number' && Number.isFinite(data.durationMs)
                ? Math.max(0, Math.min(data.durationMs, 60_000))
                : 0;
            releaseHandoverCounter.inc({ client_type: labels.client_type, result });
            releaseHandoverDuration.observe({ client_type: labels.client_type, result }, durationMs / 1000);
        });

        socket.on('disconnect', () => {
            if (limiterRefresh) clearInterval(limiterRefresh);
            if (distributedConnectionLimiter && limiterMember) {
                void distributedConnectionLimiter.release(userId, limiterMember).catch((error) => {
                    log({ module: 'websocket', userId, error }, 'Socket connection lease release failed');
                });
            } else {
                const remaining = (activeByUser.get(userId) ?? 1) - 1;
                if (remaining > 0) activeByUser.set(userId, remaining);
                else activeByUser.delete(userId);
            }
            websocketEventsCounter.inc({ event_type: 'disconnect', ...labels });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            websocketConnectionsGauge.dec({ type: connection.connectionType, ...labels });


            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const timer = setTimeout(async () => {
                    try {
                        const peers = await io.in(machinePresenceRoom(userId, connection.machineId))
                            .timeout(2_000)
                            .fetchSockets();
                        if (peers.length > 0) return;
                        const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, Date.now());
                        eventRouter.emitEphemeral({
                            userId,
                            payload: machineActivity,
                            recipientFilter: { type: 'user-scoped-only' }
                        });
                    } catch (error) {
                        // During a coordination outage, fail toward a briefly
                        // stale online badge instead of flashing every daemon
                        // offline while another replica may still own it.
                        log({ module: 'websocket', machineId: connection.machineId, error }, 'Machine offline confirmation deferred');
                    }
                }, 15_000);
                timer.unref?.();
            }
        });

        // Handlers
        rpcHandler(
            userId,
            socket,
            io,
            connection.connectionType === 'machine-scoped'
                ? connection.machineId
                : connection.connectionType === 'session-scoped'
                    ? connection.sessionId
                    : undefined,
            rpcRateLimiter,
            releaseCoordinator ? { begin: () => releaseCoordinator!.beginRpc() } : undefined,
        );
        usageHandler(userId, socket);
        sessionUpdateHandler(userId, socket, connection);
        pingHandler(socket);
        machineUpdateHandler(userId, socket);
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket, terminalRateLimiter);
        terminalHandler(userId, socket, io, connection, terminalRateLimiter);
        clipboardHandler(userId, socket, io, connection, terminalRateLimiter);
        sessionStreamHandler(userId, socket, io, connection, sessionStreamRateLimiter);
        filePreviewHandler(userId, socket, io, connection, terminalRateLimiter);

    });

    onShutdown('api', async () => {
        if (streamLagTimer) clearInterval(streamLagTimer);
        await io.close();
        for (const client of adapterConnections ? Object.values(adapterConnections) : []) {
            try { await client.quit(); } catch { client.disconnect(); }
        }
        await closeCoordinationRedis();
    });
    return releaseCoordinator;
}
