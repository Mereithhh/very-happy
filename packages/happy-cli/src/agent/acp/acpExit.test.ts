import { describe, expect, it } from 'vitest';
import { acpExitIntent } from './acpExit';

describe('acpExitIntent (B-854 / AGENTS 7)', () => {
    it('only a user kill / archive archives', () => {
        expect(acpExitIntent({ intent: 'archive', reason: 'aborted' })).toBe('archive');
    });

    it('a signal, a backend that never started, or an unexplained end go offline', () => {
        expect(acpExitIntent({ intent: 'offline', reason: 'restarted' })).toBe('offline');
        expect(acpExitIntent({ intent: 'offline', reason: 'failed' })).toBe('offline');
        expect(acpExitIntent(null)).toBe('offline');
    });
});
