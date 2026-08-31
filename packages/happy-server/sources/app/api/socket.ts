import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Redis } from "ioredis";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { getMetricsLabelsFromSocket, redisStreamLagMsGauge, releaseHandoverCounter, releaseHandoverDuration, websocketConnectionsGauge, websocketEventsCounter } from "../monitoring/metrics2";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { terminalHandler } from "./socket/terminalHandler";
import { clipboardHandler } from "./socket/clipboardHandler";
import { filePreviewHandler } from "./socket/filePreviewHandler";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { parseSocketClientType, validateSocketOwnership } from './socket/socketIdentity';
import { AccountTerminalRateLimiter, resolveRpcRelayLimit, resolveTerminalRelayLimit } from './socket/terminalRateLimit';
import { resolveSocketConnectionLimit } from './socket/socketConnectionLimit';
import { resolveReleaseConfig } from '@/app/release/releaseConfig';
import { ReleaseCoordinator } from '@/app/release/releaseCoordinator';
import { closeCoordinationRedis, initializeCoordinationRedis } from '@/app/release/redisCoordination';
import { DistributedSocketConnectionLimiter } from './socket/distributedSocketLimit';

export const SOCKET_STREAM_NAME = 'vh:socket.io';

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
        connectionStateRecovery: {
            maxDisconnectionDuration: 30_000,
            skipMiddlewares: false,
        },
    });
    const terminalRateLimiter = new AccountTerminalRateLimiter(resolveTerminalRelayLimit());
    const rpcRateLimiter = new AccountTerminalRateLimiter(resolveRpcRelayLimit());

    const releaseConfig = resolveReleaseConfig();
    if (releaseConfig && !process.env.REDIS_URL) {
        throw new Error('REDIS_URL is required when release coordination is enabled');
    }

    let releaseCoordinator: ReleaseCoordinator | null = null;
    let distributedConnectionLimiter: DistributedSocketConnectionLimiter | null = null;
    let adapterClient: Redis | null = null;
    let streamLagTimer: NodeJS.Timeout | null = null;

    // Multi-process support: attach Redis streams adapter when REDIS_URL is set.
    // Use a dedicated adapter connection because its blocking stream reads must
    // never hold up coordination commands such as readiness and relay leases.
    if (process.env.REDIS_URL) {
        const coordinationRedis = await initializeCoordinationRedis(process.env.REDIS_URL);
        adapterClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            enableReadyCheck: true,
            maxRetriesPerRequest: null,
        });
        await adapterClient.connect();
        if (await adapterClient.ping() !== 'PONG') throw new Error('Socket adapter Redis PING failed');
        io.adapter(createAdapter(adapterClient, {
            streamName: SOCKET_STREAM_NAME,
            sessionKeyPrefix: 'vh:sio:session:',
            maxLen: 200000,
            readCount: 2000,
            heartbeatInterval: 5_000,
            heartbeatTimeout: 10_000,
        }));
        log({ module: 'websocket' }, 'Redis streams adapter enabled for multi-process support');

        // Track stream reader lag: wrap onRawMessage to capture last-read offset,
        // then periodically compare against stream HEAD.
        let lastReadOffset = "0-0";
        const adapter = io.of("/").adapter as any;
        const origOnRawMessage = adapter.onRawMessage.bind(adapter);
        adapter.onRawMessage = (msg: any, offset: string) => {
            lastReadOffset = offset;
            return origOnRawMessage(msg, offset);
        };
        streamLagTimer = setInterval(async () => {
            try {
                const info = await adapterClient!.xinfo("STREAM", SOCKET_STREAM_NAME) as any[];
                const headId = String(info[info.indexOf("last-generated-id") + 1]);
                const headMs = parseInt(headId.split("-")[0]);
                const readMs = parseInt(lastReadOffset.split("-")[0]);
                redisStreamLagMsGauge.set(headMs - readMs);
            } catch { /* stream may not exist yet */ }
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

        log({
            module: 'websocket',
            userId,
            clientType: clientType || 'user-scoped',
            client: labels.client,
            sessionId,
            machineId,
            socketId: socket.id,
        }, 'Socket token verified');

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId, machineId };
        const happyClient = socket.data.happyClient as string | undefined;
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

            log({ module: 'websocket', userId, clientType: connection.connectionType }, 'Socket disconnected');

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
        filePreviewHandler(userId, socket, io, connection, terminalRateLimiter);

        // Ready
        log({ module: 'websocket', userId, clientType: connection.connectionType }, 'Socket connected');
    });

    onShutdown('api', async () => {
        if (streamLagTimer) clearInterval(streamLagTimer);
        await io.close();
        if (adapterClient) {
            try { await adapterClient.quit(); } catch { adapterClient.disconnect(); }
        }
        await closeCoordinationRedis();
    });
    return releaseCoordinator;
}
