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
