import { describe, expect, it } from 'vitest';
import { describeCodexFailure, describeCodexRetry, describeThrownTurnError, readableCodexErrorText } from './codexFailureText';

// Exact turn/completed error shape from codex 0.150.0 with a ChatGPT sign-in (2026-09-24).
const CHATGPT_400 = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account."}}';
// Exact turn.error.message from codex 0.154.0 when the model gateway answers 504 (probed 2026-10-18).
const GATEWAY_504 = 'unexpected status 504 Gateway Timeout: <html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n<center><h1>504 Gateway Time-out</h1></center>\r\n</body>\r\n</html>, url: http://gateway.test/v1/responses';
// The same page wrapped in a JSON error envelope (llm-hub, Wei FANG 2026-10-18).
const HUB_504 = 'unexpected status 504 Gateway Timeout: {"error":{"code":"api_error","message":"<html>\\r\\n<head><title>504 Gateway Time-out</title></head>\\r\\n<body>\\r\\n<center><h1>504 Gateway Time-out</h1></center>\\r\\n</body>\\r\\n</html>","param":null,"type":"api_error"}}, url: https://hub.test/v1/responses';

describe('describeCodexFailure', () => {
    it('unwraps the backend error body Codex puts in turn.error.message', () => {
        expect(describeCodexFailure({ type: 'task_complete', status: 'failed', error: { message: CHATGPT_400, codexErrorInfo: 'other' } }))
            .toBe("The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.");
    });

    it('B-622: reduces a gateway error page to its status line and url', () => {
        expect(describeCodexFailure({ type: 'task_complete', status: 'failed', error: { message: GATEWAY_504, codexErrorInfo: 'other' } }))
            .toBe('HTTP 504 Gateway Timeout from the model API (http://gateway.test/v1/responses)');
        expect(describeCodexFailure({ type: 'task_complete', status: 'failed', error: { message: HUB_504, codexErrorInfo: 'other' } }))
            .toBe('HTTP 504 Gateway Timeout from the model API (https://hub.test/v1/responses)');
    });

    it('B-622: keeps a body that says more than the status line', () => {
        expect(readableCodexErrorText('unexpected status 429 Too Many Requests: {"error":{"message":"Rate limit reached for gpt-6 in org-123, retry after 20s"}}, url: https://hub.test/v1/responses'))
            .toBe('HTTP 429 Too Many Requests from the model API: Rate limit reached for gpt-6 in org-123, retry after 20s (https://hub.test/v1/responses)');
        expect(readableCodexErrorText('unexpected status 502 Bad Gateway: upstream connect error or disconnect/reset before headers'))
            .toBe('HTTP 502 Bad Gateway from the model API: upstream connect error or disconnect/reset before headers');
    });
});

describe('describeCodexRetry', () => {
    it('B-622: names the status Codex is retrying after and keeps its own counter', () => {
        expect(describeCodexRetry({ type: 'turn_retry', message: 'Reconnecting... 1/5', http_status: 504 }))
            .toBe('Codex is retrying after HTTP 504 from the model API (Reconnecting... 1/5)');
        expect(describeCodexRetry({ type: 'turn_retry', message: 'Reconnecting... 2/5' }))
            .toBe('Codex is retrying after a model API error (Reconnecting... 2/5)');
        expect(describeCodexRetry({ type: 'turn_retry', message: '' })).toBe('Codex is retrying after a model API error');
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
