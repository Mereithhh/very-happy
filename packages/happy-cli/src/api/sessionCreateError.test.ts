/**
 * B-305: a mirror bind failure used to reach the daemon log as nothing but
 * "Request failed with status code 429", which does not distinguish the
 * account session CAP (permanent) from the shared write-rate bucket (clears
 * within the minute). The server's documented `error` code must survive into
 * the message — and nothing else from the body may.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn() } }));

import { describeSessionCreateError } from './api';

function axiosLike(status: number, data: unknown) {
    const error = Object.assign(new Error(`Request failed with status code ${status}`), {
        isAxiosError: true,
        response: { status, data },
    });
    return error;
}

describe('describeSessionCreateError', () => {
    it('appends the server error code so the two 429s are told apart', () => {
        expect(describeSessionCreateError(axiosLike(429, { error: 'session_state_rate_quota_exceeded' })))
            .toBe('Request failed with status code 429 (session_state_rate_quota_exceeded)');
        expect(describeSessionCreateError(axiosLike(429, { error: 'limit-reached', resource: 'sessions', limit: 500 })))
            .toBe('Request failed with status code 429 (limit-reached)');
    });

    it('copies ONLY the error code — never the rest of the body', () => {
        const described = describeSessionCreateError(axiosLike(429, { error: 'limit-reached', resource: 'sessions', limit: 500 }));
        expect(described).not.toContain('sessions');
        expect(described).not.toContain('500');
    });

    it('falls back to the plain message when there is no usable code', () => {
        expect(describeSessionCreateError(axiosLike(500, 'gateway blew up')))
            .toBe('Request failed with status code 500');
        expect(describeSessionCreateError(new Error('socket hang up'))).toBe('socket hang up');
        expect(describeSessionCreateError('not an error at all')).toBe('Unknown error');
    });
});
