import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from './session';

/**
 * Layer 2 of the "点终止就 archive" fix: a user-initiated abort opens a short
 * window during which the process-level crash handlers must NOT treat a stray
 * teardown rejection as a fatal crash (which force-archived the whole session).
 * The window logic itself is what these tests pin.
 */
function makeSession(): Session {
    const client = {
        sessionId: 'srv-1',
        keepAlive: vi.fn(),
        getMetadata: vi.fn(() => ({})),
    } as any;
    const api = { notificationProducer: vi.fn(() => { throw new Error('no notifications in test'); }) } as any;
    return new Session({
        api,
        client,
        path: '/tmp',
        logPath: '/tmp/log',
        sessionId: null,
        mcpServers: {},
        messageQueue: {} as any,
        onModeChange: () => {},
        hookSettingsPath: '/tmp/hook',
    });
}

describe('Session abort window', () => {
    let session: Session;
    beforeEach(() => { vi.useFakeTimers(); session = makeSession(); });
    afterEach(() => { session.cleanup(); vi.useRealTimers(); });

    it('is closed by default', () => {
        expect(session.isAborting()).toBe(false);
    });

    it('opens on markAborting and self-expires after the window', () => {
        session.markAborting(1000);
        expect(session.isAborting()).toBe(true);
        vi.advanceTimersByTime(999);
        expect(session.isAborting()).toBe(true);
        vi.advanceTimersByTime(2);
        expect(session.isAborting()).toBe(false); // a genuine later crash still archives
    });

    it('uses a non-trivial default window', () => {
        session.markAborting();
        vi.advanceTimersByTime(5000);
        expect(session.isAborting()).toBe(true);
    });
});
