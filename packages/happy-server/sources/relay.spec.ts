import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { startRelayServer } from './relay';
import { signRelayToken } from './app/relay/relayToken';

describe('database-free regional relay', () => {
    const clients: Socket[] = [];
    const servers: Array<Awaited<ReturnType<typeof startRelayServer>>> = [];
    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        for (const server of servers.splice(0)) {
            server.io.close();
            await server.app.close();
        }
    });

    it('relays scoped machine RPC and terminal bytes without a database', async () => {
        const secret = 'regional-relay-integration-secret';
        const server = await startRelayServer({
            RELAY_ID: 'sin', RELAY_REGION: 'Singapore', RELAY_TOKEN_SECRET: secret,
            HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'silent',
        } as NodeJS.ProcessEnv);
        servers.push(server);
        const origin = `http://127.0.0.1:${server.port}`;
        const machineToken = signRelayToken({ secret, accountId: 'a1', relayId: 'sin', machineId: 'm1', clientType: 'machine' }).token;
        const webToken = signRelayToken({ secret, accountId: 'a1', relayId: 'sin', machineId: 'm1', clientType: 'web' }).token;
        const otherWebToken = signRelayToken({ secret, accountId: 'a1', relayId: 'sin', machineId: 'm2', clientType: 'web' }).token;
        const machine = connect(origin, { path: '/v1/relay', transports: ['websocket'], auth: { token: machineToken } });
        const web = connect(origin, { path: '/v1/relay', transports: ['websocket'], auth: { token: webToken } });
        const otherWeb = connect(origin, { path: '/v1/relay', transports: ['websocket'], auth: { token: otherWebToken } });
        clients.push(machine, web, otherWeb);
        await Promise.all([once(machine, 'connect'), once(web, 'connect'), once(otherWeb, 'connect')]);

        machine.on('rpc-request', (data, callback) => callback(`reply:${data.params}`));
        const rpc = await web.timeout(2_000).emitWithAck('rpc-call', { method: 'm1:open-terminal', params: 'opaque' });
        expect(rpc).toEqual({ ok: true, result: 'reply:opaque' });

        const input = once(machine, 'terminal-input');
        web.emit('terminal-input', { machineId: 'm1', terminalId: 't1', data: 'aw==', enc: true });
        await expect(input).resolves.toMatchObject({ terminalId: 't1', data: 'aw==', enc: true });

        const output = once(web, 'terminal-output');
        machine.emit('terminal-output', { terminalId: 't1', data: 'bw==', seq: 7, enc: true });
        await expect(output).resolves.toMatchObject({ machineId: 'm1', terminalId: 't1', data: 'bw==', seq: 7, enc: true });

        const crossMachineRpc = await otherWeb.timeout(2_000).emitWithAck('rpc-call', {
            method: 'm1:open-terminal', params: 'opaque',
        });
        expect(crossMachineRpc).toEqual({ ok: false, error: 'Invalid RPC request' });

        const noCrossMachineInput = expectNoEvent(machine, 'terminal-input');
        otherWeb.emit('terminal-input', { machineId: 'm1', terminalId: 't1', data: 'aw==', enc: true });
        await noCrossMachineInput;
    });

    it('relays session messages and RPC only inside the token session and machine scope', async () => {
        const secret = 'regional-relay-integration-secret';
        const server = await startRelayServer({
            RELAY_ID: 'sin', RELAY_REGION: 'Singapore', RELAY_TOKEN_SECRET: secret,
            HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'silent',
        } as NodeJS.ProcessEnv);
        servers.push(server);
        const origin = `http://127.0.0.1:${server.port}`;
        const sessionToken = signRelayToken({
            secret, accountId: 'a1', relayId: 'sin', machineId: 'm1', sessionId: 's1', clientType: 'session',
        }).token;
        const webToken = signRelayToken({ secret, accountId: 'a1', relayId: 'sin', machineId: 'm1', clientType: 'web' }).token;
        const otherWebToken = signRelayToken({ secret, accountId: 'a1', relayId: 'sin', machineId: 'm2', clientType: 'web' }).token;
        const runner = connect(origin, { path: '/v1/relay', transports: ['websocket'], auth: { token: sessionToken } });
        const web = connect(origin, { path: '/v1/relay', transports: ['websocket'], auth: { token: webToken } });
        const otherWeb = connect(origin, { path: '/v1/relay', transports: ['websocket'], auth: { token: otherWebToken } });
        clients.push(runner, web, otherWeb);
        await Promise.all([once(runner, 'connect'), once(web, 'connect'), once(otherWeb, 'connect')]);

        runner.on('session-message-deliver', (data, callback) => callback({
            ok: true,
            messages: data.messages.map((message: any, index: number) => ({
                id: `stored-${index}`,
                seq: index + 1,
                localId: message.localId,
                createdAt: 1,
                updatedAt: 1,
            })),
        }));
        runner.on('rpc-request', (data, callback) => callback(`rpc:${data.params}`));

        const delivered = await web.timeout(2_000).emitWithAck('session-message-deliver', {
            sessionId: 's1', messages: [{ localId: 'l1', content: 'cipher' }],
        });
        expect(delivered).toMatchObject({ ok: true, messages: [{ id: 'stored-0', localId: 'l1' }] });

        const rpc = await web.timeout(2_000).emitWithAck('session-rpc-call', {
            sessionId: 's1', method: 's1:abort', params: 'cipher-rpc',
        });
        expect(rpc).toEqual({ ok: true, result: 'rpc:cipher-rpc' });

        const committed = once(web, 'session-message-committed');
        runner.emit('session-message-committed', {
            sessionId: 's1',
            messages: [{ id: 'stored-1', seq: 2, localId: 'l2', content: 'cipher-out', createdAt: 2, updatedAt: 2 }],
        });
        await expect(committed).resolves.toMatchObject({ machineId: 'm1', sessionId: 's1' });

        const crossScope = await otherWeb.timeout(2_000).emitWithAck('session-message-deliver', {
            sessionId: 's1', messages: [{ localId: 'l3', content: 'cipher' }],
        });
        expect(crossScope).toEqual({ ok: false, error: 'Session unavailable' });
    });
});

function once(socket: Socket, event: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 2_000);
        socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
        socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
    });
}

function expectNoEvent(socket: Socket, event: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        socket.once(event, (data) => {
            clearTimeout(timer);
            reject(new Error(`unexpected ${event}: ${JSON.stringify(data)}`));
        });
    });
}
