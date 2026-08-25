import fastify from 'fastify';
import { Server, type Socket } from 'socket.io';
import { AccountTerminalRateLimiter, relayPayloadBytes, resolveRpcRelayLimit, resolveTerminalRelayLimit } from './app/api/socket/terminalRateLimit';
import { verifyRelayToken, type RelayTokenClaims } from './app/relay/relayToken';

type RelaySocket = Socket & { data: { relayClaims?: RelayTokenClaims } };

const MAX_ID_BYTES = 256;
const MAX_DIMENSION = 10_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_ACTIVITY_ITEMS = 200;
const MAX_ACTIVITY_SKEW_MS = 5 * 60 * 1000;

function boundedId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES;
}

function safeDimension(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_DIMENSION;
}

function optionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
}

function optionalSequence(value: unknown): value is number | undefined {
    return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function sanitizeActivity(value: unknown, now = Date.now()): Array<{ id: string; activityAt: number }> {
    if (!Array.isArray(value)) return [];
    const result: Array<{ id: string; activityAt: number }> = [];
    for (const item of value) {
        if (result.length >= MAX_ACTIVITY_ITEMS) break;
        const id = item && typeof item === 'object' ? (item as any).id : undefined;
        const activityAt = item && typeof item === 'object' ? (item as any).activityAt : undefined;
        if (!boundedId(id) || typeof activityAt !== 'number' || !Number.isFinite(activityAt) || activityAt <= 0 || activityAt > now + MAX_ACTIVITY_SKEW_MS) continue;
        result.push({ id, activityAt });
    }
    return result;
}

function machineRoom(machineId: string): string { return `relay:${machineId}:machine`; }
function webRoom(machineId: string): string { return `relay:${machineId}:web`; }

export function relayRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
    const relayId = env.RELAY_ID?.trim();
    const region = env.RELAY_REGION?.trim();
    const secret = env.RELAY_TOKEN_SECRET?.trim();
    if (!relayId || !region || !secret) throw new Error('RELAY_ID, RELAY_REGION and RELAY_TOKEN_SECRET are required');
    if (Buffer.byteLength(relayId, 'utf8') > 64 || Buffer.byteLength(region, 'utf8') > 64) throw new Error('RELAY_ID and RELAY_REGION must be at most 64 bytes');
    if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('RELAY_TOKEN_SECRET must be at least 32 bytes');
    const port = env.PORT ? Number.parseInt(env.PORT, 10) : 3010;
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('PORT must be an integer from 0 to 65535');
    return {
        relayId,
        region,
        secret,
        port,
        host: env.HOST?.trim() || '127.0.0.1',
        version: env.RELAY_VERSION?.trim() || 'dev',
    };
}

export async function startRelayServer(env: NodeJS.ProcessEnv = process.env) {
    const config = relayRuntimeConfig(env);
    const app = fastify({ logger: true });
    await app.register(import('@fastify/cors'), {
        origin: '*',
        methods: ['GET', 'OPTIONS'],
    });
    app.get('/health', async () => ({ ok: true, relayId: config.relayId, region: config.region, version: config.version }));

    const payloadLimit = Number.parseInt(env.SOCKET_MAX_PAYLOAD_BYTES || '', 10);
    const io = new Server(app.server, {
        path: '/v1/relay',
        transports: ['websocket'],
        serveClient: false,
        cors: { origin: '*', methods: ['GET', 'OPTIONS'] },
        pingTimeout: 45_000,
        pingInterval: 15_000,
        maxHttpBufferSize: Number.isFinite(payloadLimit) && payloadLimit > 0 ? payloadLimit : 1024 * 1024,
    });
    const terminalLimiter = new AccountTerminalRateLimiter(resolveTerminalRelayLimit(env));
    const rpcLimiter = new AccountTerminalRateLimiter(resolveRpcRelayLimit(env));

    io.use((socket: RelaySocket, next) => {
        const token = socket.handshake.auth.token;
        if (typeof token !== 'string') return next(new Error('Missing relay token'));
        const claims = verifyRelayToken({ token, secret: config.secret, relayId: config.relayId });
        if (!claims) return next(new Error('Invalid relay token'));
        socket.data.relayClaims = claims;
        next();
    });

    io.on('connection', (socket: RelaySocket) => {
        const claims = socket.data.relayClaims!;
        const { machineId, clientType, sub: accountId } = claims;
        socket.on('relay-ping', (_data: unknown, callback?: (response: { serverAt: number }) => void) => {
            callback?.({ serverAt: Date.now() });
        });
        if (clientType === 'machine') {
            socket.join(machineRoom(machineId));
            const registered = new Set<string>();

            socket.on('rpc-register', (data: unknown) => {
                const method = (data as { method?: unknown } | null)?.method;
                if (!boundedId(method) || !method.startsWith(`${machineId}:`) || registered.size >= 256) return;
                registered.add(method);
                socket.emit('rpc-registered', { method });
            });
            socket.on('rpc-unregister', (data: unknown) => {
                const method = (data as { method?: unknown } | null)?.method;
                if (!boundedId(method) || !method.startsWith(`${machineId}:`)) return;
                registered.delete(method);
                socket.emit('rpc-unregistered', { method });
            });

            socket.on('terminal-output', (data: any) => {
                if (!terminalLimiter.consume(accountId, relayPayloadBytes(data))) return socket.disconnect(true);
                if (!data || !boundedId(data.terminalId) || typeof data.data !== 'string' || !optionalSequence(data.seq) || !optionalBoolean(data.enc)) return;
                io.to(webRoom(machineId)).emit('terminal-output', {
                    machineId,
                    terminalId: data.terminalId,
                    data: data.data,
                    seq: data.seq,
                    enc: data.enc,
                });
            });
            socket.on('terminal-exit', (data: any) => {
                if (!terminalLimiter.consume(accountId, relayPayloadBytes(data))) return socket.disconnect(true);
                if (!data || !boundedId(data.terminalId) || !Number.isSafeInteger(data.exitCode) || data.exitCode < -1 || data.exitCode > 65_535) return;
                io.to(webRoom(machineId)).emit('terminal-exit', { machineId, terminalId: data.terminalId, exitCode: data.exitCode });
            });
            socket.on('terminal-activity', (data: any) => {
                if (!terminalLimiter.consume(accountId, relayPayloadBytes(data))) return socket.disconnect(true);
                const terminals = sanitizeActivity(data?.terminals);
                if (terminals.length === 0) return;
                io.to(webRoom(machineId)).emit('terminal-activity', { machineId, terminals });
            });
            void io.in(machineRoom(machineId)).fetchSockets().then((existing) => {
                for (const old of existing) if (old.id !== socket.id) old.disconnect(true);
            });
            return;
        }

        socket.join(webRoom(machineId));
        socket.on('rpc-call', async (data: any, callback?: (response: any) => void) => {
            if (!rpcLimiter.consume(accountId, relayPayloadBytes(data))) {
                callback?.({ ok: false, error: 'RPC account rate limit reached' });
                return;
            }
            if (!data || !boundedId(data.method) || !data.method.startsWith(`${machineId}:`) || typeof data.params !== 'string') {
                callback?.({ ok: false, error: 'Invalid RPC request' });
                return;
            }
            try {
                const responses = await io.to(machineRoom(machineId)).timeout(RPC_TIMEOUT_MS).emitWithAck('rpc-request', {
                    method: data.method,
                    params: data.params,
                });
                if (responses.length !== 1) {
                    callback?.({ ok: false, error: responses.length === 0 ? 'Machine unavailable' : 'Multiple machine connections' });
                    return;
                }
                callback?.({ ok: true, result: responses[0] });
            } catch {
                callback?.({ ok: false, error: 'Machine unavailable' });
            }
        });

        socket.on('terminal-input', (data: any) => {
            if (!terminalLimiter.consume(accountId, relayPayloadBytes(data))) return socket.disconnect(true);
            if (!data || data.machineId !== machineId || !boundedId(data.terminalId) || typeof data.data !== 'string' || !optionalBoolean(data.enc)) return;
            io.to(machineRoom(machineId)).emit('terminal-input', { terminalId: data.terminalId, data: data.data, enc: data.enc });
        });
        socket.on('terminal-resize', (data: any) => {
            if (!terminalLimiter.consume(accountId, relayPayloadBytes(data))) return socket.disconnect(true);
            if (!data || data.machineId !== machineId || !boundedId(data.terminalId) || !safeDimension(data.cols) || !safeDimension(data.rows)) return;
            io.to(machineRoom(machineId)).emit('terminal-resize', { terminalId: data.terminalId, cols: data.cols, rows: data.rows });
        });
        socket.on('terminal-close', (data: any) => {
            if (!terminalLimiter.consume(accountId, relayPayloadBytes(data))) return socket.disconnect(true);
            if (!data || data.machineId !== machineId || !boundedId(data.terminalId)) return;
            io.to(machineRoom(machineId)).emit('terminal-close', { terminalId: data.terminalId });
        });
    });

    await app.listen({ port: config.port, host: config.host });
    const address = app.server.address();
    const actualPort = address && typeof address === 'object' ? address.port : config.port;
    return { app, io, port: actualPort, host: config.host };
}
