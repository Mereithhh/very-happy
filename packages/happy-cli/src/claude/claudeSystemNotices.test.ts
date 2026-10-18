import { describe, expect, it } from 'vitest';
import {
    createClaudeApiRetryGate,
    describeClaudeApiRetry,
    describeClaudeInformational,
    INFORMATIONAL_MAX_CHARS,
} from './claudeSystemNotices';

/** The frame as sdk.d.ts SDKAPIRetryMessage describes it. */
const retry = (attempt: number, fields: Record<string, unknown> = {}) => ({
    type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 8000, error_status: 529, error: 'overloaded',
    uuid: `u-${attempt}`, session_id: 's', ...fields,
});

describe('describeClaudeApiRetry (B-631)', () => {
    it('names the status, the error kind, the attempt and the wait', () => {
        expect(describeClaudeApiRetry(retry(2))).toBe('Claude is retrying after HTTP 529 overloaded (attempt 2/10, next retry in 8s)');
        expect(describeClaudeApiRetry(retry(1, { error_status: 429, error: 'rate_limit', retry_delay_ms: 622 })))
            .toBe('Claude is retrying after HTTP 429 rate limit (attempt 1/10, next retry in 622ms)');
        expect(describeClaudeApiRetry(retry(3, { retry_delay_ms: 1500, error: 'unknown' })))
            .toBe('Claude is retrying after HTTP 529 (attempt 3/10, next retry in 1.5s)');
    });

    it('calls a null status a connection error and copes with missing counters', () => {
        expect(describeClaudeApiRetry(retry(1, { error_status: null, error: 'unknown' })))
            .toBe('Claude is retrying after a connection error (attempt 1/10, next retry in 8s)');
        expect(describeClaudeApiRetry({ error_status: 500 })).toBe('Claude is retrying after HTTP 500');
        expect(describeClaudeApiRetry({})).toBe('Claude is retrying after a connection error');
    });
});

describe('api_retry notice gate (B-631)', () => {
    it('persists the first attempt of a run and then at most one per interval', () => {
        const gate = createClaudeApiRetryGate({ minIntervalMs: 60_000 });
        expect(gate.observe(retry(1), 0)).toBe(true);
        expect(gate.observe(retry(2), 500)).toBe(false);
        expect(gate.observe(retry(3), 1_500)).toBe(false);
        expect(gate.observe(retry(4), 59_999)).toBe(false);
        expect(gate.observe(retry(5), 60_000)).toBe(true);
        expect(gate.observe(retry(6), 90_000)).toBe(false);
    });

    it('an attempt that does not follow the last starts a new run, and so does a turn end', () => {
        const gate = createClaudeApiRetryGate({ minIntervalMs: 60_000 });
        expect(gate.observe(retry(1), 0)).toBe(true);
        expect(gate.observe(retry(2), 100)).toBe(false);
        expect(gate.observe(retry(1), 200)).toBe(true);   // a new request started retrying
        expect(gate.observe(retry(2), 300)).toBe(false);
        gate.reset();
        expect(gate.observe(retry(2), 400)).toBe(true);
    });

    it('frames without an attempt counter are throttled by time only', () => {
        const gate = createClaudeApiRetryGate({ minIntervalMs: 1_000 });
        expect(gate.observe({}, 0)).toBe(true);
        expect(gate.observe({}, 10)).toBe(false);
        expect(gate.observe({}, 1_000)).toBe(true);
    });
});

describe('describeClaudeInformational (B-631)', () => {
    it('only a warning with words becomes a row', () => {
        expect(describeClaudeInformational({ level: 'warning', content: '  UserPromptSubmit hook blocked the prompt:\n no secrets ' }))
            .toBe('UserPromptSubmit hook blocked the prompt: no secrets');
        expect(describeClaudeInformational({ level: 'info', content: 'loaded 3 skills' })).toBeNull();
        expect(describeClaudeInformational({ level: 'notice', content: 'hook says hi' })).toBeNull();
        expect(describeClaudeInformational({ level: 'suggestion', content: 'try /compact' })).toBeNull();
        expect(describeClaudeInformational({ level: 'warning', content: '   ' })).toBeNull();
        expect(describeClaudeInformational({ level: 'warning' })).toBeNull();
    });

    it('bounds a long warning', () => {
        const text = describeClaudeInformational({ level: 'warning', content: 'x'.repeat(2_000) });
        expect(text).toHaveLength(INFORMATIONAL_MAX_CHARS);
        expect(text?.endsWith('…')).toBe(true);
    });
});
