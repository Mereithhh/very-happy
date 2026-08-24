import { describe, expect, it } from 'vitest';
import { clipboardHandler } from './clipboardHandler';
import { filePreviewHandler } from './filePreviewHandler';
import { AccountTerminalRateLimiter } from './terminalRateLimit';

/** Minimal socket.io stand-ins: capture the handler and room emits. */
function makeFakes() {
    const handlers = new Map<string, (data: any) => void>();
    const emitted: Array<{ room: string; event: string; data: any }> = [];
    const socket = {
        on: (event: string, handler: (data: any) => void) => {
            handlers.set(event, handler);
        },
        emit: (event: string, data: any) => emitted.push({ room: 'sender', event, data }),
        disconnect: () => emitted.push({ room: 'sender', event: 'disconnect', data: true }),
    } as any;
    const io = {
        to: (room: string) => ({
            emit: (event: string, data: any) => {
                emitted.push({ room, event, data });
            },
        }),
    } as any;
    return { handlers, emitted, socket, io };
}

describe('clipboardHandler', () => {
    it('forwards a machine push to the user room with ALL fields intact', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        clipboardHandler('user1', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });

        handlers.get('clipboard-push')!({
            payload: 'ciphertext-b64',
            enc: true,
            truncated: true,
            totalBytes: 300000,
        });

        expect(emitted).toEqual([{
            room: 'user:user1:user-scoped',
            event: 'clipboard-push',
            // The relay rebuilds the payload — every client-decoded field must
            // survive the rebuild (the terminal-output `enc`-drop bug class).
            data: {
                sourceType: 'machine',
                machineId: 'm1',
                payload: 'ciphertext-b64',
                enc: true,
                truncated: true,
                totalBytes: 300000,
            },
        }]);
    });

    it('forwards a session push stamped with the CONNECTION sessionId', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        clipboardHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });

        // Body tries to spoof identity fields — the relay must use the
        // authenticated connection's identity, not the body's.
        handlers.get('clipboard-push')!({
            payload: 'p',
            enc: true,
            sessionId: 'someone-elses-session',
            machineId: 'spoofed-machine',
            sourceType: 'machine',
        });

        expect(emitted).toHaveLength(1);
        expect(emitted[0].data.sourceType).toBe('session');
        expect(emitted[0].data.sessionId).toBe('s1');
        expect(emitted[0].data.machineId).toBeUndefined();
    });

    it('defaults optional flags instead of dropping them undefinedly-typed', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        clipboardHandler('u', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });
        handlers.get('clipboard-push')!({ payload: 'plain text' });
        expect(emitted[0].data.enc).toBe(false);
        expect(emitted[0].data.truncated).toBe(false);
    });

    it('ignores pushes from user-scoped (web) sockets', () => {
        const { handlers, socket, io } = makeFakes();
        clipboardHandler('u', socket, io, { connectionType: 'user-scoped' });
        expect(handlers.has('clipboard-push')).toBe(false);
    });

    it('drops malformed payloads', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        clipboardHandler('u', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });
        handlers.get('clipboard-push')!(undefined);
        handlers.get('clipboard-push')!({});
        handlers.get('clipboard-push')!({ payload: 42 });
        expect(emitted).toHaveLength(0);
    });

    it('drops oversized payloads (relay hard cap)', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        clipboardHandler('u', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });
        handlers.get('clipboard-push')!({ payload: 'x'.repeat(1024 * 1024 + 1) });
        expect(emitted).toHaveLength(0);
        // ...but a payload at the cap passes.
        handlers.get('clipboard-push')!({ payload: 'x'.repeat(1024 * 1024) });
        expect(emitted).toHaveLength(1);
    });

    it('ignores machine-scoped connections missing machineId', () => {
        const { handlers, socket, io } = makeFakes();
        clipboardHandler('u', socket, io, { connectionType: 'machine-scoped' });
        expect(handlers.has('clipboard-push')).toBe(false);
    });

    it('disconnects repeated 1MiB clipboard pushes at the shared event allowance', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 1,
            burstBytes: 2 * 1024 * 1024,
            eventsPerSecond: 1,
            burstEvents: 1,
        });
        clipboardHandler('u', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' }, limiter);
        const payload = { payload: 'x'.repeat(1024 * 1024) };

        handlers.get('clipboard-push')!(payload);
        handlers.get('clipboard-push')!(payload);

        expect(emitted[0]).toMatchObject({ room: 'user:u:user-scoped', event: 'clipboard-push' });
        expect(emitted.slice(1)).toEqual([
            { room: 'sender', event: 'limit-reached', data: { resource: 'clipboard-relay' } },
            { room: 'sender', event: 'disconnect', data: true },
        ]);
    });

    it('shares one account allowance across clipboard and file-preview event names', () => {
        const clipboard = makeFakes();
        const preview = makeFakes();
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 1024 * 1024,
            burstBytes: 1024 * 1024,
            eventsPerSecond: 1,
            burstEvents: 1,
        });
        clipboardHandler('u', clipboard.socket, clipboard.io, { connectionType: 'session-scoped', sessionId: 's1' }, limiter);
        filePreviewHandler('u', preview.socket, preview.io, { connectionType: 'session-scoped', sessionId: 's1' }, limiter);

        clipboard.handlers.get('clipboard-push')!({ payload: 'first' });
        preview.handlers.get('file-preview-push')!({ payload: 'second' });

        expect(clipboard.emitted).toHaveLength(1);
        expect(preview.emitted).toEqual([
            { room: 'sender', event: 'limit-reached', data: { resource: 'file-preview-relay' } },
            { room: 'sender', event: 'disconnect', data: true },
        ]);
    });
});
