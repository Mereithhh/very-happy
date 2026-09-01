import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    it('can opt in to a later live bypass without starting in bypass mode', () => {
        query({ prompt: 'hello', options: { permissionMode: 'plan', allowDangerouslySkipPermissions: true } });
        expect(sdkQuery.mock.calls[0][0].options).toEqual(expect.objectContaining({
            permissionMode: 'plan',
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

    it('grants the SDK access to staged attachment directories', () => {
        query({ prompt: 'hello', options: { additionalDirectories: ['/private/chat-files'] } });
        expect(sdkQuery.mock.calls[0][0].options.additionalDirectories).toEqual(['/private/chat-files']);
    });

    describe('root sandbox assertion (--dangerously-skip-permissions under root)', () => {
        const realGetuid = process.getuid;
        afterEach(() => {
            if (realGetuid) process.getuid = realGetuid;
            else delete (process as { getuid?: () => number }).getuid;
            delete process.env.IS_SANDBOX;
        });

        it('sets IS_SANDBOX=1 when running as root with the dangerous opt-in on', () => {
            process.getuid = () => 0;
            delete process.env.IS_SANDBOX;
            query({ prompt: 'hi', options: { permissionMode: 'default', allowDangerouslySkipPermissions: true } });
            expect(sdkQuery.mock.calls[0][0].options.env.IS_SANDBOX).toBe('1');
        });

        it('does not set IS_SANDBOX when not root', () => {
            process.getuid = () => 1000;
            delete process.env.IS_SANDBOX;
            query({ prompt: 'hi', options: { permissionMode: 'default', allowDangerouslySkipPermissions: true } });
            expect(sdkQuery.mock.calls[0][0].options.env.IS_SANDBOX).toBeUndefined();
        });

        it('does not set IS_SANDBOX when the dangerous opt-in is off', () => {
            process.getuid = () => 0;
            delete process.env.IS_SANDBOX;
            query({ prompt: 'hi', options: { permissionMode: 'plan' } });
            expect(sdkQuery.mock.calls[0][0].options.env.IS_SANDBOX).toBeUndefined();
        });

        it('never overrides an explicit IS_SANDBOX (operator may forbid with "0")', () => {
            process.getuid = () => 0;
            process.env.IS_SANDBOX = '0';
            query({ prompt: 'hi', options: { permissionMode: 'bypassPermissions' } });
            expect(sdkQuery.mock.calls[0][0].options.env.IS_SANDBOX).toBe('0');
        });
    });
});
