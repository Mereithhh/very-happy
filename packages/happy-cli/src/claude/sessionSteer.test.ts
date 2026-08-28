import { describe, expect, it, vi } from 'vitest';
import { Session, type ClaudeSteerInput } from './session';

const input: ClaudeSteerInput = {
    message: 'adjust direction',
    mode: { permissionMode: 'default' },
};

function sessionWithoutConstructor(): Session {
    return new Session({
        api: { notificationProducer: () => null } as any,
        client: { sessionId: 'test', keepAlive: vi.fn() } as any,
        path: '/tmp',
        logPath: '/tmp/test.log',
        sessionId: null,
        mcpServers: {},
        messageQueue: {} as any,
        onModeChange: vi.fn(),
        hookSettingsPath: '/tmp/happy-test-settings.json',
    });
}

describe('Session Steer dispatch', () => {
    it('only accepts Steer while a live remote turn is thinking', async () => {
        const session = sessionWithoutConstructor();
        const handler = vi.fn(async () => true);
        session.setSteerHandler(handler);

        session.thinking = false;
        await expect(session.trySteer(input)).resolves.toBe(false);
        expect(handler).not.toHaveBeenCalled();

        session.thinking = true;
        await expect(session.trySteer(input)).resolves.toBe(true);
        expect(handler).toHaveBeenCalledWith(input);
        session.cleanup();
    });

    it('falls back when no current query sink is registered', async () => {
        const session = sessionWithoutConstructor();
        session.thinking = true;
        session.setSteerHandler(null);

        await expect(session.trySteer(input)).resolves.toBe(false);
        session.cleanup();
    });
});
