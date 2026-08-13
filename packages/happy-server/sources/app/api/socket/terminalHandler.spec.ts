import { describe, expect, it } from 'vitest';
import { terminalHandler, sanitizeTerminalActivity } from './terminalHandler';

/** Minimal socket.io stand-ins: capture the handlers and the room emits. */
function makeFakes() {
    const handlers = new Map<string, (data: any) => void>();
    const emitted: Array<{ room: string; event: string; data: any }> = [];
    const socket = {
        on: (event: string, handler: (data: any) => void) => {
            handlers.set(event, handler);
        },
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

describe('sanitizeTerminalActivity', () => {
    it('keeps well-formed pairs', () => {
        expect(sanitizeTerminalActivity([{ id: 'a', activityAt: 100 }]))
            .toEqual([{ id: 'a', activityAt: 100 }]);
    });

    it('rebuilds each item, so unknown fields cannot be smuggled through', () => {
        const out = sanitizeTerminalActivity([{ id: 'a', activityAt: 1, cwd: '/secret', extra: 1 }]);
        expect(out).toEqual([{ id: 'a', activityAt: 1 }]);
    });

    it('drops malformed items but keeps the good ones', () => {
        const out = sanitizeTerminalActivity([
            null,
            'nope',
            { id: '', activityAt: 5 },
            { id: 'a' },
            { id: 'b', activityAt: 'x' },
            { id: 'c', activityAt: NaN },
            { id: 'd', activityAt: Infinity },
            { id: 'e', activityAt: 0 },
            { id: 'f', activityAt: -1 },
            { id: 'good', activityAt: 9 },
        ]);
        expect(out).toEqual([{ id: 'good', activityAt: 9 }]);
    });

    it('rejects times implausibly far in the FUTURE (fast machine clock)', () => {
        const now = 1_700_000_000_000;
        const skew = 5 * 60 * 1000;
        // Clients sort by max() and never decay, so a host whose clock is ahead
        // would otherwise pin all of ITS terminals to the top forever.
        expect(sanitizeTerminalActivity([{ id: 'a', activityAt: now + skew + 1 }], now)).toEqual([]);
        expect(sanitizeTerminalActivity([{ id: 'a', activityAt: now + 24 * 3600_000 }], now)).toEqual([]);
        // Real drift is seconds, not hours — that must still pass.
        expect(sanitizeTerminalActivity([{ id: 'a', activityAt: now + 5_000 }], now))
            .toEqual([{ id: 'a', activityAt: now + 5_000 }]);
        // ...and a skewed item must not take the whole batch down with it.
        expect(sanitizeTerminalActivity([
            { id: 'bad', activityAt: now + skew + 1 },
            { id: 'good', activityAt: now - 1000 },
        ], now)).toEqual([{ id: 'good', activityAt: now - 1000 }]);
    });

    it('returns [] for anything that is not an array', () => {
        for (const junk of [undefined, null, {}, 'x', 42]) {
            expect(sanitizeTerminalActivity(junk)).toEqual([]);
        }
    });

    it('bounds the batch length (one frame must not fan out unbounded)', () => {
        const raw = Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, activityAt: 1 }));
        expect(sanitizeTerminalActivity(raw)).toHaveLength(200);
    });
});

describe('terminalHandler — terminal-activity relay', () => {
    it('forwards a machine batch to the account user-scoped room', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        terminalHandler('user1', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });

        handlers.get('terminal-activity')!({ terminals: [{ id: 't1', activityAt: 1234 }] });

        expect(emitted).toEqual([{
            room: 'user:user1:user-scoped',
            event: 'terminal-activity',
            data: { machineId: 'm1', terminals: [{ id: 't1', activityAt: 1234 }] },
        }]);
    });

    it('stamps machineId from the AUTHENTICATED connection, never the body', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        terminalHandler('user1', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });

        handlers.get('terminal-activity')!({
            machineId: 'someone-elses-machine',
            terminals: [{ id: 't1', activityAt: 1 }],
        });

        expect(emitted[0].data.machineId).toBe('m1');
    });

    it('sends NOTHING for an empty or all-junk batch (idle machines cost zero)', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        terminalHandler('u', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });

        handlers.get('terminal-activity')!(undefined);
        handlers.get('terminal-activity')!({});
        handlers.get('terminal-activity')!({ terminals: [] });
        handlers.get('terminal-activity')!({ terminals: [{ id: '', activityAt: 0 }] });

        expect(emitted).toHaveLength(0);
    });

    it('is not registered for user/web sockets (machine → web only)', () => {
        const { handlers, socket, io } = makeFakes();
        terminalHandler('u', socket, io, { connectionType: 'user-scoped' });
        expect(handlers.has('terminal-activity')).toBe(false);
        // ...and the web→machine direction is still wired.
        expect(handlers.has('terminal-input')).toBe(true);
    });

    it('is not registered for a machine connection missing machineId', () => {
        const { handlers, socket, io } = makeFakes();
        terminalHandler('u', socket, io, { connectionType: 'machine-scoped' });
        expect(handlers.has('terminal-activity')).toBe(false);
    });

    it('does not disturb the existing byte-stream relay', () => {
        const { handlers, emitted, socket, io } = makeFakes();
        terminalHandler('user1', socket, io, { connectionType: 'machine-scoped', machineId: 'm1' });

        handlers.get('terminal-output')!({ terminalId: 't1', data: 'b64', seq: 7, enc: true });

        expect(emitted).toEqual([{
            room: 'user:user1:user-scoped',
            event: 'terminal-output',
            data: { terminalId: 't1', machineId: 'm1', data: 'b64', seq: 7, enc: true },
        }]);
    });
});
