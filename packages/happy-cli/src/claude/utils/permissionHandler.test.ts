import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@/api/types';
import type { Session } from '../session';
import { PermissionHandler } from './permissionHandler';

function fixture() {
    let state: AgentState = { requests: {}, completedRequests: {} };
    let rpc: ((message: any) => Promise<void>) | undefined;
    const sendSessionNotification = vi.fn();
    const session = {
        client: {
            sessionId: 'session-1',
            getMetadata: () => ({}),
            updateAgentState: (updater: (old: AgentState) => AgentState) => { state = updater(state); },
            rpcHandlerManager: {
                registerHandler: (_name: string, handler: (message: any) => Promise<void>) => { rpc = handler; },
            },
        },
        api: { push: () => ({ sendSessionNotification }) },
        notificationProducer: { permissionRequest: vi.fn() },
        reportEventToDaemon: vi.fn(),
    } as unknown as Session;
    const handler = new PermissionHandler(session);
    return {
        handler,
        getState: () => state,
        respond: async (message: any) => {
            if (!rpc) throw new Error('RPC handler missing');
            await rpc(message);
        },
    };
}

describe('PermissionHandler SDK protocol', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the SDK permission suggestions for approve-for-session', async () => {
        const { handler, getState, respond } = fixture();
        const suggestions = [{
            type: 'addRules' as const,
            behavior: 'allow' as const,
            destination: 'session' as const,
            rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
        }];
        const pending = handler.handleToolCall('Bash', { command: 'git status' }, { permissionMode: 'default' }, {
            signal: new AbortController().signal,
            toolUseID: 'tool-1',
            requestId: 'request-tool-1',
            suggestions,
        });
        expect(getState().requests?.['tool-1']?.permissionSuggestions).toEqual(suggestions);
        await respond({ id: 'tool-1', approved: true, decision: 'approved_for_session', allowTools: ['Bash'] });
        await expect(pending).resolves.toEqual({
            behavior: 'allow',
            updatedInput: { command: 'git status' },
            updatedPermissions: suggestions,
        });
    });

    it('allows ExitPlanMode without issuing a nested SDK mode switch', async () => {
        const { handler, getState, respond } = fixture();
        const setPermissionMode = vi.fn(async () => undefined);
        handler.setPermissionModeUpdater(setPermissionMode);
        const pending = handler.handleToolCall('ExitPlanMode', { plan: 'ship it' }, { permissionMode: 'plan' }, {
            signal: new AbortController().signal,
            toolUseID: 'plan-1',
            requestId: 'request-plan-1',
        });
        await respond({ id: 'plan-1', approved: true, mode: 'default', decision: 'approved' });
        await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'ship it' } });
        expect(setPermissionMode).not.toHaveBeenCalled();
        expect(getState().completedRequests?.['plan-1']?.status).toBe('approved');
    });

    it('rejects an already-aborted permission without publishing it', async () => {
        const { handler, getState } = fixture();
        const abort = new AbortController();
        abort.abort();
        await expect(handler.handleToolCall('Bash', { command: 'pwd' }, { permissionMode: 'default' }, {
            signal: abort.signal,
            toolUseID: 'tool-aborted',
            requestId: 'request-tool-aborted',
        })).rejects.toThrow('Permission request aborted');
        expect(getState().requests).toEqual({});
    });

    it('clears a published request when its signal aborts', async () => {
        const { handler, getState } = fixture();
        const abort = new AbortController();
        const pending = handler.handleToolCall('Bash', { command: 'pwd' }, { permissionMode: 'default' }, {
            signal: abort.signal,
            toolUseID: 'tool-inflight',
            requestId: 'request-tool-inflight',
        });
        expect(getState().requests?.['tool-inflight']).toBeDefined();
        const rejected = expect(pending).rejects.toThrow('Permission request aborted');
        abort.abort();
        await rejected;
        expect(getState().requests).toEqual({});
        expect(getState().completedRequests?.['tool-inflight']?.status).toBe('canceled');
    });

    it('live bypass resolves an already-pending ordinary tool and updates the SDK query', async () => {
        const { handler, getState } = fixture();
        const setPermissionMode = vi.fn(async () => undefined);
        handler.setPermissionModeUpdater(setPermissionMode);
        const pending = handler.handleToolCall('Write', { file_path: '/tmp/a', content: 'x' }, { permissionMode: 'default' }, {
            signal: new AbortController().signal,
            toolUseID: 'write-1',
            requestId: 'request-write-1',
        });

        await handler.setLivePermissionMode('bypassPermissions');

        await expect(pending).resolves.toEqual({
            behavior: 'allow',
            updatedInput: { file_path: '/tmp/a', content: 'x' },
        });
        expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
        expect(getState().requests).toEqual({});
        expect(getState().completedRequests?.['write-1']?.status).toBe('approved');
    });

    it('does not auto-resolve ExitPlanMode or interaction requests during live bypass', async () => {
        const { handler, getState, respond } = fixture();
        const setPermissionMode = vi.fn(async () => undefined);
        handler.setPermissionModeUpdater(setPermissionMode);
        const plan = handler.handleToolCall('ExitPlanMode', { plan: 'ship it' }, { permissionMode: 'plan' }, {
            signal: new AbortController().signal,
            toolUseID: 'plan-live',
            requestId: 'request-plan-live',
        });
        const interaction = handler.handleElicitation({
            serverName: 'calendar', message: 'Choose', mode: 'form', requestedSchema: { type: 'object' },
        }, { signal: new AbortController().signal, requestId: 'elicit-live' });

        await handler.setLivePermissionMode('bypassPermissions');

        expect(getState().requests?.['plan-live']).toBeDefined();
        expect(getState().requests?.['elicit-live']).toBeDefined();
        expect(setPermissionMode).not.toHaveBeenCalled();
        await respond({ id: 'plan-live', approved: false, reason: 'stop' });
        await respond({ id: 'elicit-live', approved: false });
        await expect(plan).resolves.toEqual({ behavior: 'deny', message: 'stop' });
        await expect(interaction).resolves.toEqual({ action: 'decline' });
        await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions'));
    });

    it('rolls the handler back when the SDK rejects a live mode change', async () => {
        const { handler } = fixture();
        handler.setPermissionModeUpdater(vi.fn(async () => { throw new Error('sdk failed'); }));
        await expect(handler.setLivePermissionMode('bypassPermissions')).rejects.toThrow('sdk failed');

        const pending = handler.handleToolCall('Bash', { command: 'pwd' }, { permissionMode: 'default' }, {
            signal: new AbortController().signal,
            toolUseID: 'after-failure',
            requestId: 'request-after-failure',
        });
        let settled = false;
        void pending.then(() => { settled = true; }, () => undefined);
        await Promise.resolve();
        expect(settled).toBe(false);
        const rejected = expect(pending).rejects.toThrow('Session reset');
        handler.reset();
        await rejected;
    });

    it('serializes rapid live mode updates in request order', async () => {
        const { handler } = fixture();
        const first = createDeferred<void>();
        const calls: string[] = [];
        handler.setPermissionModeUpdater(vi.fn(async (mode) => {
            calls.push(mode);
            if (mode === 'acceptEdits') await first.promise;
        }));

        const one = handler.setLivePermissionMode('acceptEdits');
        const two = handler.setLivePermissionMode('bypassPermissions');
        await vi.waitFor(() => expect(calls).toEqual(['acceptEdits']));
        first.resolve();
        await Promise.all([one, two]);
        expect(calls).toEqual(['acceptEdits', 'bypassPermissions']);
    });

    it('does not let a deferred interaction update overwrite a newer live mode', async () => {
        const { handler, respond } = fixture();
        const calls: string[] = [];
        handler.setPermissionModeUpdater(vi.fn(async (mode) => { calls.push(mode); }));
        const interaction = handler.handleElicitation({
            serverName: 'calendar', message: 'Choose', mode: 'form', requestedSchema: { type: 'object' },
        }, { signal: new AbortController().signal, requestId: 'elicit-race' });

        await handler.setLivePermissionMode('acceptEdits');
        await respond({ id: 'elicit-race', approved: false });
        await handler.setLivePermissionMode('bypassPermissions');
        await expect(interaction).resolves.toEqual({ action: 'decline' });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(calls).toEqual(['bypassPermissions']);
    });

    it('round-trips MCP elicitation form content', async () => {
        const { handler, getState, respond } = fixture();
        const pending = handler.handleElicitation({
            serverName: 'calendar', message: 'Choose a name', mode: 'form',
            requestedSchema: { type: 'object' },
        }, { signal: new AbortController().signal, requestId: 'elicit-1' });
        expect(getState().requests?.['elicit-1']?.kind).toBe('elicitation');
        expect(getState().requests?.['elicit-1']?.tool).toBe('AskUserQuestion');
        await respond({ id: 'elicit-1', approved: true, updatedInput: { name: 'Ada' } });
        await expect(pending).resolves.toEqual({ action: 'accept', content: { name: 'Ada' } });
    });

    it('cancels unknown user dialog kinds without advertising a request', async () => {
        const { handler, getState } = fixture();
        await expect(handler.handleUserDialog({ dialogKind: 'future_kind', payload: {} }, {
            signal: new AbortController().signal,
            requestId: 'dialog-1',
        })).resolves.toEqual({ behavior: 'cancelled' });
        expect(getState().requests).toEqual({});
    });

    it('answers the declared refusal fallback dialog with the CLI choice token', async () => {
        const { handler, getState, respond } = fixture();
        const pending = handler.handleUserDialog({
            dialogKind: 'refusal_fallback_prompt', payload: { fallbackModel: 'fallback-model' },
        }, { signal: new AbortController().signal, requestId: 'dialog-2' });
        expect(getState().requests?.['dialog-2']?.kind).toBe('user_dialog');
        expect(getState().requests?.['dialog-2']?.tool).toBe('AskUserQuestion');
        await respond({ id: 'dialog-2', approved: true, decision: 'approved' });
        await expect(pending).resolves.toEqual({ behavior: 'completed', result: 'retry_fallback' });
    });
});

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}
