import { describe, expect, it } from 'vitest';
import { MAX_STREAM_PAYLOAD_BYTES, sessionStreamHandler } from './sessionStreamHandler';
import { AccountTerminalRateLimiter } from './terminalRateLimit';

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
            emit: (event: string, data: any) => emitted.push({ room, event, data }),
        }),
    } as any;
    return { handlers, emitted, socket, io };
}

describe('sessionStreamHandler', () => {
    it('forwards a frame to the user room stamped with the CONNECTION sessionId', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        sessionStreamHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });

        handlers.get('session-stream')!({ payload: 'cipher-b64', enc: true });

        expect(emitted).toEqual([{
            room: 'user:user1:user-scoped',
            event: 'session-stream',
            data: { sessionId: 's1', payload: 'cipher-b64', enc: true },
        }]);
    });

    it('ignores the sessionId in the event body so one session cannot impersonate another', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        sessionStreamHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });

        handlers.get('session-stream')!({ payload: 'p', enc: true, sessionId: 'victim' } as any);

        expect(emitted[0]!.data.sessionId).toBe('s1');
    });

    it('registers nothing for a machine or web connection', () => {
        for (const connection of [
            { connectionType: 'machine-scoped', machineId: 'm1' },
            { connectionType: 'user-scoped' },
            { connectionType: 'session-scoped' },
        ]) {
            const { handlers, socket, io } = makeFakes();
            sessionStreamHandler('user1', socket, io, connection);
            expect(handlers.has('session-stream')).toBe(false);
        }
    });

    it('drops malformed and oversized frames', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        sessionStreamHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });
        const push = handlers.get('session-stream')!;

        push(null as any);
        push({} as any);
        push({ payload: 42 } as any);
        push({ payload: 'p', enc: 'yes' } as any);
        push({ payload: 'x'.repeat(MAX_STREAM_PAYLOAD_BYTES + 1) });

        expect(emitted).toEqual([]);
    });

    it('is inert when an operator disables the relay', () => {
        const { handlers, socket, io } = makeFakes();
        const previous = process.env.SESSION_STREAM_RELAY_DISABLED;
        process.env.SESSION_STREAM_RELAY_DISABLED = '1';
        try {
            sessionStreamHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' });
            expect(handlers.has('session-stream')).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.SESSION_STREAM_RELAY_DISABLED;
            else process.env.SESSION_STREAM_RELAY_DISABLED = previous;
        }
    });

    it('charges an oversized frame against the budget instead of decoding it for free', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 1_000_000, burstBytes: 1_000_000, eventsPerSecond: 2, burstEvents: 2,
        });
        sessionStreamHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' }, limiter);
        const push = handlers.get('session-stream')!;

        // Two oversized frames exhaust the 2-event burst; a third — this one
        // perfectly valid — must now be throttled. Validating before charging
        // would have let the junk through for free.
        push({ payload: 'x'.repeat(MAX_STREAM_PAYLOAD_BYTES + 1) });
        push({ payload: 'x'.repeat(MAX_STREAM_PAYLOAD_BYTES + 1) });
        push({ payload: 'legit', enc: true });

        expect(emitted).toEqual([]);
    });

    it('DROPS over-budget frames instead of disconnecting the session socket', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        // Zero allowance with a non-zero rate: every consume() fails.
        const limiter = new AccountTerminalRateLimiter({
            bytesPerSecond: 1, burstBytes: 0, eventsPerSecond: 1, burstEvents: 0,
        });
        sessionStreamHandler('user1', socket, io, { connectionType: 'session-scoped', sessionId: 's1' }, limiter);

        handlers.get('session-stream')!({ payload: 'p', enc: true });

        // No relay, and critically no 'limit-reached' + disconnect: the real
        // message path must survive a burst of disposable drafts.
        expect(emitted).toEqual([]);
    });
});
