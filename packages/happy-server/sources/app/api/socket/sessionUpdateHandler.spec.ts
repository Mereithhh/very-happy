import { describe, expect, it } from 'vitest';
import { ownsSessionLifecycle } from './sessionUpdateHandler';

describe('session lifecycle socket scope', () => {
    const socket = {} as any;

    it('allows only the exact authenticated session socket to author presence', () => {
        expect(ownsSessionLifecycle({
            connectionType: 'session-scoped', userId: 'u', sessionId: 's1', socket,
        }, 's1')).toBe(true);
        expect(ownsSessionLifecycle({
            connectionType: 'session-scoped', userId: 'u', sessionId: 's1', socket,
        }, 's2')).toBe(false);
        expect(ownsSessionLifecycle({ connectionType: 'user-scoped', userId: 'u', socket }, 's1')).toBe(false);
        expect(ownsSessionLifecycle({
            connectionType: 'machine-scoped', userId: 'u', machineId: 'm1', socket,
        }, 's1')).toBe(false);
    });
});
