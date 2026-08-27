import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkQuery = vi.hoisted(() => vi.fn((_params: any) => ({ async *[Symbol.asyncIterator]() {} })));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
    query: sdkQuery,
}));

import { query } from './query';

describe('Claude SDK query adapter', () => {
    beforeEach(() => sdkQuery.mockClear());

    it('sets the SDK safety acknowledgement for bypassPermissions', () => {
        query({ prompt: 'hello', options: { permissionMode: 'bypassPermissions' } });
        expect(sdkQuery.mock.calls[0][0].options).toEqual(expect.objectContaining({
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
        }));
    });

    it('latches a source signal that was already aborted', () => {
        const source = new AbortController();
        source.abort('already stopped');
        query({ prompt: 'hello', options: { abort: source.signal } });
        const target = sdkQuery.mock.calls[0][0].options.abortController;
        expect(target?.signal.aborted).toBe(true);
        expect(target?.signal.reason).toBe('already stopped');
    });

    it('forwards blocking interaction callbacks and declared dialog kinds', () => {
        const onElicitation = vi.fn();
        const onUserDialog = vi.fn();
        query({
            prompt: 'hello',
            options: { onElicitation, onUserDialog, supportedDialogKinds: ['refusal_fallback_prompt'] },
        });
        expect(sdkQuery.mock.calls[0][0].options).toEqual(expect.objectContaining({
            onElicitation,
            onUserDialog,
            supportedDialogKinds: ['refusal_fallback_prompt'],
        }));
    });
});
