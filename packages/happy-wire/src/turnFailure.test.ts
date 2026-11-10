import { describe, expect, it } from 'vitest';
import { readTurnFailure, summarizeTurnError, turnErrorStatus, TURN_FAILURE_SUMMARY_MAX } from './turnFailure';

describe('B-913 turn failure summary', () => {
    it('keeps the readable API error line (the 11-05 Lead case)', () => {
        expect(summarizeTurnError('API Error: 400 Anthropic Claude bad request: advisor_20260301 requires request field model'))
            .toBe('API Error: 400 Anthropic Claude bad request: advisor_20260301 requires request field model');
    });

    it('reduces a trailing JSON error body to its message', () => {
        expect(summarizeTurnError('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'))
            .toBe('API Error: 529: Overloaded');
    });

    it('removes keys, bearer tokens, e-mails, query strings and long blobs', () => {
        const out = summarizeTurnError('API Error: 401 key sk-ant-api03-abcdefghijklmnop rejected for a.b@example.com at https://gw.example/v1?sig=zzz Bearer abc.def.ghi api_key=hunter22 ' + 'x'.repeat(60));
        expect(out).not.toMatch(/sk-ant|abcdefghijklmnop|a\.b@example|sig=zzz|gw\.example|abc\.def\.ghi|hunter22|xxxxxxxxxx/);
        expect(out).toContain('API Error: 401');
    });

    it('B-913: no gateway address leaves the machine (Claude Code names it on a 529)', () => {
        const out = summarizeTurnError('API Error: 529 Overloaded. If it persists, check your inference gateway (127.0.0.1:6923).');
        expect(out).toBe('API Error: 529 Overloaded. If it persists, check your inference gateway ([host]).');
        expect(summarizeTurnError('connect ECONNREFUSED llm-gw.corp.internal:8443 via https://llm-gw.corp.internal/v1/messages?beta=true'))
            .toBe('connect ECONNREFUSED [host] via [url]');
        expect(summarizeTurnError('unexpected status 400 from api.openai.example.com')).toBe('unexpected status 400 from [host]');
        // ordinary prose / versions / ids stay readable
        expect(summarizeTurnError('API Error: 400 advisor_20260301 requires request field model (claude-opus-5-5, v2.1.322)'))
            .toBe('API Error: 400 advisor_20260301 requires request field model (claude-opus-5-5, v2.1.322)');
    });

    it('first line only, clipped, never empty', () => {
        expect(summarizeTurnError('\n\n  boom\nstack trace')).toBe('boom');
        expect(summarizeTurnError('y '.repeat(400)).length).toBeLessThanOrEqual(TURN_FAILURE_SUMMARY_MAX);
        expect(summarizeTurnError('')).toBe('Unknown error');
        expect(summarizeTurnError(undefined)).toBe('Unknown error');
    });

    it('reads the HTTP status', () => {
        expect(turnErrorStatus('API Error: 529 Overloaded')).toBe(529);
        expect(turnErrorStatus('unexpected status 400 Bad Request')).toBe(400);
        expect(turnErrorStatus('no status here 123')).toBeNull();
    });

    it('lenient read: malformed is no failure', () => {
        expect(readTurnFailure({ at: 1, summary: 's', provider: 'claude', status: 400 })).toEqual({ at: 1, summary: 's', provider: 'claude', status: 400 });
        expect(readTurnFailure({ at: 'x' })).toBeNull();
        expect(readTurnFailure(null)).toBeNull();
    });
});
