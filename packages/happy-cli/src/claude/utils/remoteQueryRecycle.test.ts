import { describe, expect, it } from 'vitest';
import { queryRecycleReason } from './remoteQueryRecycle';

describe('queryRecycleReason', () => {
    it('recycles after an assistant frame flagged authentication_failed', () => {
        expect(queryRecycleReason({ subtype: 'success', is_error: true, result: 'x' }, 'authentication_failed'))
            .toBe('authentication_failed');
    });

    it('falls back to the result text when the assistant frame carried no error field', () => {
        expect(queryRecycleReason({
            subtype: 'success',
            is_error: true,
            result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        }, undefined)).toBe('authentication_failed');
    });

    it('keeps the Query for successful turns', () => {
        expect(queryRecycleReason({ subtype: 'success', is_error: false, result: 'done' }, undefined)).toBeNull();
    });

    it('keeps the Query for other API errors (they are per-request, not cached by the process)', () => {
        expect(queryRecycleReason({ subtype: 'success', is_error: true, result: 'Rate limited' }, 'rate_limit')).toBeNull();
        expect(queryRecycleReason({ subtype: 'error_during_execution', is_error: true, result: 'boom' }, 'server_error')).toBeNull();
    });

    it('ignores auth wording in a non-error result', () => {
        expect(queryRecycleReason({
            subtype: 'success',
            is_error: false,
            result: 'The error was "Failed to authenticate" — fixed by re-login.',
        }, undefined)).toBeNull();
    });
});
