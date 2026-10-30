import { describe, expect, it, vi } from 'vitest';
import { Session } from './session';

function makeSession(): Session {
    return new Session({
        api: { notificationProducer: () => null } as any,
        client: { sessionId: 'test', keepAlive: vi.fn(), getMetadata: () => null } as any,
        path: '/tmp',
        logPath: '/tmp/test.log',
        sessionId: 'claude-1',
        mcpServers: {},
        messageQueue: {} as any,
        onModeChange: vi.fn(),
        hookSettingsPath: '/tmp/happy-test-settings.json',
    });
}

describe('B-845 /clear starts a conversation that needs the full project prefix', () => {
    it('clearSessionId resets the project injector', () => {
        const session = makeSession();
        const reset = vi.spyOn(session.projectInjector, 'reset');
        session.clearSessionId();
        expect(session.sessionId).toBeNull();
        expect(reset).toHaveBeenCalledTimes(1);
        session.cleanup();
    });

    it('a session that never injected anything has nothing to reset', () => {
        const session = makeSession();
        expect(() => session.clearSessionId()).not.toThrow();
        session.cleanup();
    });
});
