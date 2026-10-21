import { describe, expect, it, vi } from 'vitest';
import { eventRouter, MACHINES_ROOM } from './eventRouter';

function fakeSocket() {
    const rooms: string[] = [];
    return { rooms, join: (room: string) => { rooms.push(room); } };
}

describe('relay-wide CLI policy announcement room (B-718)', () => {
    it('only machine-scoped sockets join the machines room', () => {
        const machine = fakeSocket(); const user = fakeSocket(); const session = fakeSocket();
        eventRouter.addConnection('u1', { connectionType: 'machine-scoped', machineId: 'm1', socket: machine } as never);
        eventRouter.addConnection('u1', { connectionType: 'user-scoped', socket: user } as never);
        eventRouter.addConnection('u1', { connectionType: 'session-scoped', sessionId: 's1', socket: session } as never);
        expect(machine.rooms).toContain(MACHINES_ROOM);
        expect(user.rooms).not.toContain(MACHINES_ROOM);
        expect(session.rooms).not.toContain(MACHINES_ROOM);
    });
    it('emits cli-update-policy to that room with only the version', () => {
        const emit = vi.fn();
        const to = vi.fn(() => ({ emit }));
        eventRouter.init({ to } as never);
        eventRouter.emitCliUpdatePolicy({ autoUpdateVersion: '0.2.180' });
        expect(to).toHaveBeenCalledWith(MACHINES_ROOM);
        expect(emit).toHaveBeenCalledWith('cli-update-policy', { autoUpdateVersion: '0.2.180' });
    });
});
