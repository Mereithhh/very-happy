import { describe, expect, it } from 'vitest';
import { createOfflineSessionStub } from './offlineSessionStub';

describe('createOfflineSessionStub', () => {
    it('absorbs agent usage while the relay is offline', () => {
        const session = createOfflineSessionStub('usage-test');
        expect(session.sendAgentUsageSnapshot('codex', { totalTokens: 10 })).toBe(false);
    });
});
