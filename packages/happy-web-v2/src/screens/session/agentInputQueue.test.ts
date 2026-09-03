import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');

describe('AgentInput queue controls', () => {
    it('keeps Queue, Steer, and Stop as separate actions while working', () => {
        expect(source).toContain("aria-label={t('session.chat.stop')}");
        // B-320: the Stop button's outcome is CONSUMED. `void doAbort()` (what
        // this used to assert) made every failed stop invisible — the user's
        // report was "点停止也无法停止" with no error anywhere.
        expect(source).toContain('void doAbort().then((outcome) =>');
        expect(source).not.toContain('void doAbort()}');
        expect(source).toContain("metadata?.capabilities?.includes('claude-steer-v1')");
        expect(source).toContain("aria-label={t('session.chat.queueIntervene')}");
        expect(source).toContain("await sendQueuedItem(item, 'steer')");
        expect(source).toContain("aria-label={gate === 'restore-first' ? t('restore.restoreAndSend') : isWorking ? t('session.chat.queueSend') : t('session.chat.send')}");
        expect(source).toContain("onClick={() => void doSend('queue')}");
        expect(source).toContain("delivery: 'queue' | 'steer' = 'queue'");
        expect(source).not.toContain('sessionSteer');
    });
});
