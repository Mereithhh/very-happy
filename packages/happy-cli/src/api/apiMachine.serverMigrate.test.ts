import { describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';

/** B-635: the notice reaches the daemon's handler only from the live control socket. */
describe('server-migrate notice dispatch', () => {
    function fakeSocket() {
        const handlers: Record<string, Array<(...args: any[]) => void>> = {};
        const socket: any = {
            connected: true,
            on: vi.fn((event: string, handler: (...args: any[]) => void) => { (handlers[event] ||= []).push(handler); return socket; }),
            io: { on: vi.fn() },
            emit: vi.fn(),
            handlers,
        };
        return socket;
    }
    it('forwards the raw notice to the registered handler and ignores a stale socket', () => {
        const client = new ApiMachineClient('token', { id: 'machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any);
        const handler = vi.fn();
        client.setServerMigrateHandler(handler);
        const live = fakeSocket();
        (client as any).socket = live;
        (client as any).bindControlDataHandlers(live);
        const notice = { url: 'https://api.new.test', webappUrl: 'https://new.test', handoff: 'vh1.x.y', issuedAt: 1 };
        live.handlers['server-migrate'][0](notice);
        expect(handler).toHaveBeenCalledExactlyOnceWith(notice);

        const stale = fakeSocket();
        (client as any).bindControlDataHandlers(stale);
        stale.handlers['server-migrate'][0](notice);
        expect(handler).toHaveBeenCalledTimes(1);

        client.setServerMigrateHandler(null);
        live.handlers['server-migrate'][0](notice);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
