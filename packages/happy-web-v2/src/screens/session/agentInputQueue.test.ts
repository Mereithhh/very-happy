import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');

describe('AgentInput queue controls', () => {
    it('keeps Queue, Steer, and Stop as separate actions while working', () => {
        expect(source).toContain("aria-label={t('session.chat.stop')}");
        expect(source).toContain('onClick={() => void doAbort()}');
        expect(source).toContain("metadata?.capabilities?.includes('claude-steer-v1')");
        expect(source).toContain("aria-label={t('session.chat.queueIntervene')}");
        expect(source).toContain("await sendQueuedItem(item, 'steer')");
        expect(source).toContain("aria-label={isWorking ? t('session.chat.queueSend') : t('session.chat.send')}");
        expect(source).toContain("onClick={() => void doSend('queue')}");
        expect(source).toContain("delivery: 'queue' | 'steer' = 'queue'");
        expect(source).not.toContain('sessionSteer');
    });
});
