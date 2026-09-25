import { beforeEach, describe, expect, it, vi } from 'vitest';

const { emitEphemeral, queueSessionUpdate } = vi.hoisted(() => ({
    emitEphemeral: vi.fn(),
    queueSessionUpdate: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findUnique: vi.fn(async () => ({ id: 's1' })),
            update: vi.fn(async () => ({})),
        },
    },
}));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitEphemeral, emitUpdate: vi.fn() },
    buildNewMessageUpdate: vi.fn(() => ({})),
    buildSessionActivityEphemeral: vi.fn((id: string, active: boolean, activeAt: number, thinking?: boolean) =>
        ({ type: 'activity', id, active, activeAt, thinking })),
    buildUpdateSessionUpdate: vi.fn(() => ({})),
}));
vi.mock('@/app/monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: () => ({}),
    sessionAliveEventsCounter: { inc: vi.fn() },
    sessionAliveRelayCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: { isSessionValid: vi.fn(async () => true), queueSessionUpdate },
}));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { sessionUpdateHandler } from './sessionUpdateHandler';
import { sessionActivityRelayGate } from '@/app/presence/sessionActivityRelayGate';

function connect(sid = 's1') {
    const handlers = new Map<string, (...args: any[]) => any>();
    const socket = { on: (event: string, fn: any) => handlers.set(event, fn) } as any;
    sessionUpdateHandler('u1', socket, { connectionType: 'session-scoped', userId: 'u1', sessionId: sid, socket });
    return handlers;
}

describe('session-alive fan-out is coalesced (B-484)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        emitEphemeral.mockClear();
        queueSessionUpdate.mockClear();
        sessionActivityRelayGate.forget('s1');
    });

    it('broadcasts one idle beat, keeps recording every beat for presence', async () => {
        const h = connect();
        for (let i = 0; i < 5; i++) {
            await h.get('session-alive')!({ sid: 's1', time: Date.now(), thinking: false });
            vi.advanceTimersByTime(2_000);
        }
        expect(queueSessionUpdate).toHaveBeenCalledTimes(5);
        expect(emitEphemeral).toHaveBeenCalledTimes(1);
    });

    it('broadcasts a thinking edge immediately', async () => {
        const h = connect();
        await h.get('session-alive')!({ sid: 's1', time: Date.now(), thinking: false });
        vi.advanceTimersByTime(2_000);
        await h.get('session-alive')!({ sid: 's1', time: Date.now(), thinking: true });
        expect(emitEphemeral).toHaveBeenCalledTimes(2);
        expect(emitEphemeral.mock.calls[1][0].payload.thinking).toBe(true);
    });

    it('broadcasts the first beat after session-end even inside the idle window', async () => {
        const h = connect();
        await h.get('session-alive')!({ sid: 's1', time: Date.now(), thinking: false });
        vi.advanceTimersByTime(1_000);
        await h.get('session-end')!({ sid: 's1', time: Date.now() });
        vi.advanceTimersByTime(1_000);
        await h.get('session-alive')!({ sid: 's1', time: Date.now(), thinking: false });
        const actives = emitEphemeral.mock.calls.map((c) => c[0].payload.active);
        expect(actives).toEqual([true, false, true]);
    });
});
