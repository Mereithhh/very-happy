import { describe, expect, it } from 'vitest';
import { describeGeminiFailure, describeGeminiRetry, isRetryableGeminiError } from '../utils/turnFailure';

const exited = Object.assign(new Error('gemini process exited (code=137, signal=null): FATAL ERROR: Reached heap limit'), {
    agentExited: true, agentExitCode: 137, agentExitSignal: null, agentStderrTail: 'FATAL ERROR: Reached heap limit',
});

describe('isRetryableGeminiError (B-630)', () => {
    it('retries only transient failures', () => {
        expect(isRetryableGeminiError({ code: -32603, message: 'Internal error', data: { details: 'Model stream ended without a response' } })).toBe(true);
        expect(isRetryableGeminiError({ code: -32603, message: 'empty response from model' })).toBe(true);
        expect(isRetryableGeminiError({ code: -32603, message: 'The model is overloaded. Please try again later.' })).toBe(true);
    });

    it('does not retry what will fail the same way again', () => {
        expect(isRetryableGeminiError({ code: -32603, message: 'Internal error', data: { details: 'Requested entity was not found. (404)' } })).toBe(false);
        expect(isRetryableGeminiError({ code: -32603, message: 'quota exhausted. Your quota will reset after 3h20m35s.' })).toBe(false);
        expect(isRetryableGeminiError({ code: -32000, message: 'Authentication required' })).toBe(false);
        expect(isRetryableGeminiError(exited)).toBe(false);
    });
});

describe('describeGeminiFailure (B-630)', () => {
    const ctx = { model: 'gemini-2.5-pro' };

    it('names the dead process with its last words', () => {
        expect(describeGeminiFailure(exited, ctx)).toEqual({ kind: 'exited', message: 'Process exited unexpectedly: gemini process exited (code=137, signal=null): FATAL ERROR: Reached heap limit' });
    });

    it('classifies the known shapes', () => {
        expect(describeGeminiFailure({ code: 404, message: 'Not found' }, ctx).kind).toBe('not-found');
        expect(describeGeminiFailure({ code: -32603, message: 'empty response' }, ctx).kind).toBe('empty');
        expect(describeGeminiFailure({ code: 429, message: 'Resource exhausted' }, ctx).kind).toBe('rate-limit');
        const quota = describeGeminiFailure({ message: 'Your quota will reset after 3h20m35s.' }, ctx);
        expect(quota.kind).toBe('quota');
        expect(quota.message).toContain('Quota resets in 3h20m35s');
        expect(describeGeminiFailure({ code: -32000, message: 'Authentication required' }, ctx).message).toContain('very-happy gemini project set');
        expect(describeGeminiFailure({}, ctx).kind).toBe('not-installed');
    });

    it('otherwise repeats what Gemini said, on one line, bounded', () => {
        const long = 'x'.repeat(500);
        const failure = describeGeminiFailure({ code: -32603, message: 'Internal error', data: { details: `boom\n  ${long}` } }, ctx);
        expect(failure.kind).toBe('other');
        expect(failure.message.startsWith('Gemini error: boom x')).toBe(true);
        expect(failure.message.length).toBeLessThanOrEqual('Gemini error: '.length + 400);
        expect(describeGeminiFailure(new Error('stdin not writable'), ctx).message).toBe('Gemini error: stdin not writable');
    });

    it('phrases the retry notice by cause', () => {
        expect(describeGeminiRetry(1, 3, { message: 'Model stream ended' })).toBe('Gemini is retrying after an empty response (attempt 1/3)');
        expect(describeGeminiRetry(2, 3, { message: 'overloaded' })).toBe('Gemini is retrying after a transient API error (attempt 2/3)');
    });
});
