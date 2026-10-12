import { describe, expect, it, vi } from 'vitest';
import { GeminiPermissionHandler } from '../utils/permissionHandler';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

function createSessionMock() {
    let state: Record<string, any> = {};
    return {
        session: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateAgentState: vi.fn((updater: (s: Record<string, any>) => Record<string, any>) => { state = updater(state); return state; }),
        },
        getState: () => state,
    };
}

describe('GeminiPermissionHandler (B-556 report_progress)', () => {
    it('auto-approves report_progress in every naming form and by ID prefix, in default mode', async () => {
        const { session } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);
        handler.setPermissionMode('default');
        for (const name of ['report_progress', 'happy__report_progress', 'mcp__happy__report_progress']) {
            await expect(handler.handleToolCall(`id-${name}`, name, {})).resolves.toEqual({ decision: 'approved' });
        }
        await expect(handler.handleToolCall('report_progress-1765385846663', 'other', {})).resolves.toEqual({ decision: 'approved' });
    });

    it('look-alike names and IDs still wait for approval', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);
        handler.setPermissionMode('default');
        const a = handler.handleToolCall('call_1', 'report_progress_and_exec', {});
        const b = handler.handleToolCall('x_report_progress_y', 'shell', {});
        const c = handler.handleToolCall('call_2', 'other__report_progress', {});
        expect(Object.keys(getState().requests)).toEqual(['call_1', 'x_report_progress_y', 'call_2']);
        handler.abortAll();
        for (const p of [a, b, c]) await expect(p).resolves.toEqual({ decision: 'abort' });
    });
});
