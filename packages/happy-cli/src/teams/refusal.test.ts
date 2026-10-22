import { describe, expect, it } from 'vitest';
import { teamRefusalMessage } from './client';

describe('B-775 team refusal messages', () => {
    it('names the 409 reason and explains a failed member cleanup', () => {
        expect(teamRefusalMessage(409, { error: 'bot_busy' })).toBe('Teams request failed (HTTP 409: bot_busy)');
        const text = teamRefusalMessage(409, { error: 'bot_cleanup_failed', botName: 'Worker\u0007', cleanupError: 'Unmerged work retained', operationId: 'op' });
        expect(text).toContain('bot_cleanup_failed');
        expect(text).toContain('"Worker "');
        expect(text).toContain('(Unmerged work retained)');
        expect(text).toContain('Delegate to another member');
    });
    it('never echoes anything but an allow-listed code', () => {
        expect(teamRefusalMessage(409, { error: 'Bearer abc.def' })).toBe('Teams request failed (HTTP 409)');
        expect(teamRefusalMessage(500, null)).toBe('Teams request failed (HTTP 500)');
    });
});
