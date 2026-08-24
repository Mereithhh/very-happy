import { describe, expect, it } from 'vitest';
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

describe('filePreviewHandler', () => {
    it('forwards a session push to the user room, stamped with the CONNECTION sessionId', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        filePreviewHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });

        handlers.get('file-preview-push')!({
            payload: 'encrypted-path-b64',
            enc: true,
            mode: 'file',
        });

        expect(emitted).toEqual([{
            room: 'user:user1:user-scoped',
            event: 'file-preview-push',
            // The relay rebuilds the payload — every client-decoded field must
            // survive the rebuild (the terminal-output `enc`-drop bug class).
            data: {
                sourceType: 'session',
                sessionId: 's1',
                payload: 'encrypted-path-b64',
                enc: true,
                mode: 'file',
            },
        }]);
    });

    it('forwards a machine push stamped with the CONNECTION machineId', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        filePreviewHandler('user1', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });

        handlers.get('file-preview-push')!({ payload: 'p', enc: true, mode: 'diff' });

        expect(emitted).toEqual([{
            room: 'user:user1:user-scoped',
            event: 'file-preview-push',
            data: {
                sourceType: 'machine',
                machineId: 'm1',
                payload: 'p',
                enc: true,
                mode: 'diff',
            },
        }]);
    });

    it('SECURITY: never adopts identity fields from the event body', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        filePreviewHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });

        // A compromised/malicious session tries to impersonate another session
        // and another machine — the relay must ignore all of it and stamp only
        // what the authenticated connection says.
        handlers.get('file-preview-push')!({
            payload: 'p',
            enc: true,
            sourceType: 'machine',
            sessionId: 'someone-elses-session',
            machineId: 'spoofed-machine',
            userId: 'someone-else',
        });

        expect(emitted).toHaveLength(1);
        expect(emitted[0].room).toBe('user:user1:user-scoped');
        expect(emitted[0].data.sourceType).toBe('session');
        expect(emitted[0].data.sessionId).toBe('s1');
        expect(emitted[0].data.machineId).toBeUndefined();
        // No object spread of the body: nothing extra rides along.
        expect(Object.keys(emitted[0].data).sort()).toEqual(
            ['enc', 'mode', 'payload', 'sessionId', 'sourceType'],
        );
        expect('userId' in emitted[0].data).toBe(false);
    });

    it('SECURITY: a machine source cannot be turned into a session source by the body', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        filePreviewHandler('user1', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });

        handlers.get('file-preview-push')!({
            payload: 'p',
            sourceType: 'session',
            sessionId: 'spoofed-session',
            machineId: 'other-machine',
        });

        expect(emitted[0].data.sourceType).toBe('machine');
        expect(emitted[0].data.machineId).toBe('m1');
        expect(emitted[0].data.sessionId).toBeUndefined();
    });

    it('ignores pushes from user-scoped (web) sockets', () => {
        const { handlers, socket, io } = makeFakes();
        filePreviewHandler('u', socket, io, { connectionType: 'user-scoped' });
        expect(handlers.has('file-preview-push')).toBe(false);
    });

    it('ignores scoped connections missing their id', () => {
        const a = makeFakes();
        filePreviewHandler('u', a.socket, a.io, { connectionType: 'machine-scoped' });
        expect(a.handlers.has('file-preview-push')).toBe(false);

        const b = makeFakes();
        filePreviewHandler('u', b.socket, b.io, { connectionType: 'session-scoped' });
        expect(b.handlers.has('file-preview-push')).toBe(false);
    });

    it('drops oversized payloads (path cap far below the clipboard 1MB ceiling)', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        filePreviewHandler('u', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });

        handlers.get('file-preview-push')!({ payload: 'x'.repeat(8 * 1024 + 1) });
        expect(emitted).toHaveLength(0);
        // ...but a payload exactly at the cap passes.
        handlers.get('file-preview-push')!({ payload: 'x'.repeat(8 * 1024) });
        expect(emitted).toHaveLength(1);
    });

    it('normalizes unknown / missing modes to file instead of passing them through', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        filePreviewHandler('u', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });

        handlers.get('file-preview-push')!({ payload: 'p' });
        handlers.get('file-preview-push')!({ payload: 'p', mode: 'evil-mode' });
        handlers.get('file-preview-push')!({ payload: 'p', mode: 42 });
        handlers.get('file-preview-push')!({ payload: 'p', mode: null });
        handlers.get('file-preview-push')!({ payload: 'p', mode: 'diff' });

        expect(emitted.map(e => e.data.mode)).toEqual(['file', 'file', 'file', 'file', 'diff']);
    });

    it('defaults enc to false rather than leaking undefined', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        filePreviewHandler('u', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });
        handlers.get('file-preview-push')!({ payload: '/tmp/plain/path' });
        expect(emitted[0].data.enc).toBe(false);
    });

    it('drops malformed payloads without throwing', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        filePreviewHandler('u', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });
        const push = handlers.get('file-preview-push')!;

        expect(() => {
            push(undefined);
            push(null);
            push({});
            push({ payload: 42 });
            push({ payload: { path: '/etc/passwd' } });
            push({ payload: '' });
            push('a raw string event');
        }).not.toThrow();
        expect(emitted).toHaveLength(0);
    });

    it('disconnects a file-preview event burst instead of fanning it out indefinitely', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 1024,
            burstBytes: 1024,
            eventsPerSecond: 1,
            burstEvents: 1,
        });
        filePreviewHandler('u', socket, io, { connectionType: 'session-scoped', sessionId: 's1' }, limiter);

        handlers.get('file-preview-push')!({ payload: 'first' });
        handlers.get('file-preview-push')!({ payload: 'second' });

        expect(emitted[0]).toMatchObject({ room: 'user:u:user-scoped', event: 'file-preview-push' });
        expect(emitted.slice(1)).toEqual([
            { room: 'sender', event: 'limit-reached', data: { resource: 'file-preview-relay' } },
            { room: 'sender', event: 'disconnect', data: true },
        ]);
    });
});
