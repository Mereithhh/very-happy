import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Redis } from "ioredis";
import { log } from "@/utils/log";
import { auth, type VerifiedAuthExtras } from "@/app/auth/auth";
import { getMetricsLabelsFromSocket, redisStreamLagMsGauge, websocketConnectionsGauge, websocketEventsCounter } from "../monitoring/metrics2";
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
import { E2eeSocketIdentityV1Schema, e2eeCapabilitySchema } from '@slopus/happy-wire';

function configuredLimit(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * E2EE sockets are control-plane connections, never password-only unlock
 * sessions.  `auth.verifyToken` has already checked that the bound device is
 * active; this additionally binds the handshake and capability before any
 * RPC/terminal/clipboard handler is installed.
 */
export function socketAuthAllowsConnection(
    extras: VerifiedAuthExtras | undefined,
    handshake: {
        cryptoMode?: unknown;
        deviceId?: unknown;
        e2eeProtocol?: unknown;
        cryptoEpoch?: unknown;
    },
    clientType: 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined,
): boolean {
    if (extras?.cryptoMode !== 'e2ee-v1') {
        // A trusted token cannot opt into the E2EE identity namespace using
        // untrusted handshake fields.
        return handshake.cryptoMode !== 'e2ee-v1' && handshake.e2eeProtocol === undefined;
    }
    const identity = E2eeSocketIdentityV1Schema.safeParse({
        cryptoMode: handshake.cryptoMode,
        e2eeProtocol: handshake.e2eeProtocol,
        deviceId: handshake.deviceId,
        cryptoEpoch: handshake.cryptoEpoch,
    });
    const capabilities = extras.capabilities?.map((capability) => e2eeCapabilitySchema.safeParse(capability));
    if (!identity.success
        || identity.data.deviceId !== extras.deviceId
        || identity.data.e2eeProtocol !== extras.e2eeProtocol
        || identity.data.cryptoEpoch !== extras.cryptoEpoch
        || capabilities?.length !== 1
        || !capabilities[0].success) {
        return false;
    }
    const capability = capabilities[0].data;
    return (capability === 'e2ee:control' && (clientType === undefined || clientType === 'user-scoped'))
        || (capability === 'e2ee:runner' && (clientType === 'machine-scoped' || clientType === 'session-scoped'));
}

export function startSocket(app: Fastify) {
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
        // Brief-disconnect event replay. Currently OFF to preserve parity with
        // pre-multi-process prod behavior — clients fall through to the full
        // REST re-fetch path on every reconnect (apiSocket.ts onReconnected
        // listener). Enabling this lets socket.io replay missed events from
        // the streams adapter (which implements restoreSession via the Redis
        // stream) so the client can skip the heavy refetch when
        // socket.recovered === true. Verified working cross-replica via
        // deploy/integration-tests/missed-events.mjs (event #2 fired during a
        // forced engine.close() arrived after auto-reconnect, recovered=true).
        // Ship parity first; turn this on as a follow-up.
        // connectionStateRecovery: {
        //     maxDisconnectionDuration: 2 * 60 * 1000,
        // },
    });
    const terminalRateLimiter = new AccountTerminalRateLimiter(resolveTerminalRelayLimit());
    const rpcRateLimiter = new AccountTerminalRateLimiter(resolveRpcRelayLimit());

    // Multi-process support: attach Redis streams adapter when REDIS_URL is set
    if (process.env.REDIS_URL) {
        const streamClient = new Redis(process.env.REDIS_URL);
        io.adapter(createAdapter(streamClient, { maxLen: 200000, readCount: 2000 }));
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
        setInterval(async () => {
            try {
                const info = await streamClient.xinfo("STREAM", "socket.io") as any[];
                const headId = String(info[info.indexOf("last-generated-id") + 1]);
                const headMs = parseInt(headId.split("-")[0]);
                const readMs = parseInt(lastReadOffset.split("-")[0]);
                redisStreamLagMsGauge.set(headMs - readMs);
            } catch { /* stream may not exist yet */ }
        }, 5000);
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

        if (!socketAuthAllowsConnection(verified.extras, socket.handshake.auth, clientType)) {
            log({ module: 'websocket' }, 'E2EE socket authentication context rejected');
            next(new Error('E2EE device activation required'));
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
        socket.data.authExtras = verified.extras;
        socket.data.authDeviceId = verified.extras?.deviceId;
        socket.data.authCapabilities = verified.extras?.capabilities ?? [];
        socket.data.authE2eeProtocol = verified.extras?.e2eeProtocol;
        socket.data.accountCryptoMode = verified.extras?.cryptoMode;
        socket.data.accountCryptoEpoch = verified.extras?.cryptoEpoch;
        socket.data.accountCryptoWriteState = verified.extras?.cryptoWriteState;
        socket.data.accountE2eeOrigin = verified.extras?.e2eeOrigin;
        socket.data.happyClient = socket.handshake.auth.happyClient as string
            || socket.handshake.headers['x-happy-client'] as string
            || undefined;
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
        if (connectionLimit > 0 && active >= connectionLimit) {
            socket.emit('limit-reached', { resource: 'connections' });
            socket.disconnect(true);
            return;
        }
        activeByUser.set(userId, active + 1);

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

        socket.on('disconnect', () => {
            const remaining = (activeByUser.get(userId) ?? 1) - 1;
            if (remaining > 0) activeByUser.set(userId, remaining);
            else activeByUser.delete(userId);
            websocketEventsCounter.inc({ event_type: 'disconnect', ...labels });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            websocketConnectionsGauge.dec({ type: connection.connectionType, ...labels });

            log({ module: 'websocket', userId, clientType: connection.connectionType }, 'Socket disconnected');

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, Date.now());
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }
        });

        // Handlers
        rpcHandler(
            userId,
            socket,
            io,
            connection.connectionType === 'machine-scoped' ? connection.machineId : undefined,
            rpcRateLimiter,
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
        await io.close();
    });
}
