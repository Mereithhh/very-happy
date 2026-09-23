import { describe, expect, it } from 'vitest';
import { describeCodexFailure, describeThrownTurnError, readableCodexErrorText } from './codexFailureText';

// Exact turn/completed error shape from codex 0.150.0 with a ChatGPT sign-in (2026-09-24).
const CHATGPT_400 = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account."}}';

describe('describeCodexFailure', () => {
    it('unwraps the backend error body Codex puts in turn.error.message', () => {
        expect(describeCodexFailure({ type: 'task_complete', status: 'failed', error: { message: CHATGPT_400, codexErrorInfo: 'other' } }))
            .toBe("The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.");
    });

    it('keeps plain messages and reports success as null', () => {
        expect(describeCodexFailure({ status: 'failed', error: 'stream closed' })).toBe('stream closed');
        expect(describeCodexFailure({ status: 'failed' })).toBe('Unknown error');
        expect(describeCodexFailure({ status: 'completed' })).toBeNull();
    });
});

describe('describeThrownTurnError', () => {
    it('surfaces request rejections and pre-flight refusals instead of a generic crash line', () => {
        expect(describeThrownTurnError(new Error('Reasoning effort "ultra" is not supported by gpt-5.5. Choose a supported level.')))
            .toBe('Reasoning effort "ultra" is not supported by gpt-5.5. Choose a supported level.');
        expect(describeThrownTurnError(new Error('turn/start: Invalid request (code=-32600)'))).toBe('turn/start: Invalid request (code=-32600)');
    });

    it('leaves real process / transport loss to the generic line', () => {
        expect(describeThrownTurnError(new Error('Codex process exited (code=1) while waiting for turn/start'))).toBeNull();
        expect(describeThrownTurnError(new Error('Codex process disconnected while waiting for turn/start'))).toBeNull();
        expect(describeThrownTurnError(new Error('Cannot send turn/start: stdin not writable'))).toBeNull();
        expect(describeThrownTurnError(new Error('turn/start timed out after 30000ms (id=4)'))).toBeNull();
        expect(describeThrownTurnError(undefined)).toBeNull();
    });

    it('never throws on malformed JSON', () => {
        expect(readableCodexErrorText('{not json')).toBe('{not json');
        expect(readableCodexErrorText('{"type":"error"}')).toBe('{"type":"error"}');
    });
});
