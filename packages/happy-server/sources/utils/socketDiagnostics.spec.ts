import { createServer } from 'node:http';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { describe, expect, it } from 'vitest';
import { attachSocketDiagnostics, diagnosticClient, disconnectCode } from './socketDiagnostics';
import { sanitizeLogValue, stableLogRef } from './logSafety';

describe('default socket diagnostics', () => {
    it.each(['websocket', 'relay'] as const)('preserves correlated lifecycle metadata through sanitizer for %s', async (module) => {
        const http = createServer();
        const io = new Server(http);
        const records: any[] = [];
        let serverSocket: ServerSocket;
        let clock = 10;
        io.on('connection', (socket) => {
            serverSocket = socket;
            attachSocketDiagnostics(socket, {
                module, userId: 'private-account', machineId: 'private-machine', sessionId: 'private-session',
                clientType: 'machine-scoped', happyClient: 'cli-daemon/0.2.150',
            }, (metadata) => records.push(sanitizeLogValue(metadata)), () => clock);
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const port = (http.address() as { port: number }).port;
        const client = connect(`http://127.0.0.1:${port}`, {
            transports: ['websocket'], auth: { token: 'secret-credential', payload: 'private-command' },
        });
        try {
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('connect_error', reject);
            });
            const socketId = serverSocket!.id;
            clock = 2510;
            const disconnected = new Promise<void>((resolve) => client.once('disconnect', () => resolve()));
            serverSocket!.disconnect(true);
            await disconnected;
            expect(records).toHaveLength(2);
            expect(records[0]).toMatchObject({
                module, event: 'socket-connected', userId: stableLogRef('userId', 'private-account'),
                machineId: stableLogRef('machineId', 'private-machine'),
                sessionId: stableLogRef('sessionId', 'private-session'), socketId: stableLogRef('socketId', socketId),
                client: 'cli-daemon/0.2.150', connectionType: 'websocket', recovered: false,
            });
            expect(records[1]).toMatchObject({
                event: 'socket-disconnected', socketId: records[0].socketId, durationMs: 2500, code: 'server-disconnect',
            });
            for (const privateValue of ['private-account', 'private-machine', 'private-session', socketId, 'secret-credential', 'private-command']) {
                expect(JSON.stringify(records)).not.toContain(privateValue);
            }
        } finally {
            client.close();
            await new Promise<void>((resolve) => io.close(() => resolve()));
        }
    });

    it('preserves Web build SHA identities but does not widen other client versions', () => {
        for (const raw of ['web/78086a260de67fcfbecff904fa5f02ec18f1822a', 'desktop/48099ff']) {
            expect(sanitizeLogValue({ client: diagnosticClient(raw) })).toEqual({ client: raw });
        }
        for (const raw of ['web/abcdef', `web/${'a'.repeat(41)}`, 'web/private-build', 'cli-daemon/abcdef123']) {
            expect(diagnosticClient(raw)).toBe('unknown');
        }
    });

    it('keeps bounded disconnect categories and rejects arbitrary content', () => {
        for (const [reason, code] of [
            ['transport close', 'transport-close'], ['transport error', 'transport-error'],
            ['ping timeout', 'ping-timeout'], ['client namespace disconnect', 'client-disconnect'],
            ['server shutting down', 'server-shutdown'], ['parse error', 'parse-error'],
        ]) {
            expect(sanitizeLogValue({ code: disconnectCode(reason) })).toEqual({ code });
        }
        for (const value of ['Bearer private-token', '__proto__', 'constructor', undefined, { reason: 'private-command' }]) {
            expect(disconnectCode(value)).toBe('unknown');
        }
        for (const value of ['cli-daemon/private-token', 'private-host/0.2.150', 'web/1.2.3\nsecret', ['web/1.2.3'], 'Bearer private-token']) {
            expect(sanitizeLogValue({ client: diagnosticClient(value) })).toEqual({ client: 'unknown' });
        }
        // No new generic string allowance: raw reason/version remain summarized.
        expect(sanitizeLogValue({ reason: 'transport close', version: 'private-content' })).toEqual({
            reason: '[content:15B]', version: '[content:15B]',
        });
    });
});
