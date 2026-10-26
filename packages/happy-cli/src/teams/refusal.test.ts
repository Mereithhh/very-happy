import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEAM_LIMIT_EXPLANATION, teamRefusalMessage, teamRequest } from './client';

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
    it('B-822: a full team is a capacity refusal with its code and usage, whether the server says 409 or (older) 429', () => {
        for (const status of [409, 429]) {
            const text = teamRefusalMessage(status, { error: 'team_size_limit', used: 2_030_000, limit: 2_000_000, hint: 'server text' });
            expect(text).toContain('Teams request refused (team_size_limit: 2030000/2000000)');
            expect(text).toContain('not rate limiting');
            expect(text).not.toContain('server text');
        }
        expect(teamRefusalMessage(429, { error: 'team_message_limit' })).toBe(`Teams request refused (team_message_limit): ${TEAM_LIMIT_EXPLANATION}`);
        expect(teamRefusalMessage(409, { error: 'team_task_limit', used: '1e9', limit: Infinity })).toContain('(team_task_limit):');
    });
    afterEach(() => { vi.unstubAllGlobals(); });
    it('B-822: teamRequest reads the code of a 429 too (it used to surface only「HTTP 429」)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'team_size_limit', used: 2_030_000, limit: 2_000_000 }), { status: 429 })));
        await expect(teamRequest('/v1/teams/t/agent', 'POST', 'token', true, {})).rejects.toThrow('Teams request refused (team_size_limit: 2030000/2000000): a team capacity limit');
    });
});
