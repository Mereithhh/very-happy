import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from './typesRaw';

const SUB = 'ck9x2q1y8000001lbwx7f7q1a';

function envelope(ev: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return normalizeRawMessage('m1', null, 1000, {
        role: 'session',
        content: { type: 'session', data: { id: 'e1', time: 1000, role: 'agent', turn: 'turn-1', subagent: SUB, ...extra, ev } },
    } as any);
}

describe('B-260-P2 lifecycle envelopes → normalized messages', () => {
    it('start carries identity', () => {
        const m = envelope({ t: 'start', title: 'Review', description: 'Review the diff', subagentType: 'general-purpose' });
        expect(m?.role).toBe('event');
        expect((m as any).content).toMatchObject({ type: 'subagent', id: SUB, status: 'running', title: 'Review', description: 'Review the diff', subagentType: 'general-purpose' });
    });
    it('progress is a running subagent event with progress payload', () => {
        const m = envelope({ t: 'progress', toolUses: 3, lastTool: 'Read', totalTokens: 120, durationMs: 4000 });
        expect((m as any).content).toEqual({ type: 'subagent', id: SUB, status: 'running', progress: { toolUses: 3, lastTool: 'Read', totalTokens: 120, durationMs: 4000 } });
    });
    it('stop carries status/result/usage; a bare stop from an old CLI is a plain completed', () => {
        const m = envelope({ t: 'stop', status: 'failed', result: { text: 'boom', truncated: true }, usage: { toolUses: 9 } });
        expect((m as any).content).toEqual({ type: 'subagent', id: SUB, status: 'failed', result: { text: 'boom', truncated: true }, usage: { toolUses: 9 } });
        expect((envelope({ t: 'stop' }) as any).content).toEqual({ type: 'subagent', id: SUB, status: 'completed' });
    });
    it('tool-call-end result lands in tool-result content', () => {
        const m = normalizeRawMessage('m2', null, 1000, {
            role: 'session',
            content: { type: 'session', data: { id: 'e2', time: 1000, role: 'agent', turn: 'turn-1', ev: { t: 'tool-call-end', call: 'c1', result: { text: 'Final report', stats: { toolUses: 2 } } } } },
        } as any);
        expect(m?.role).toBe('agent');
        expect((m as any).content[0]).toMatchObject({ type: 'tool-result', tool_use_id: 'c1', content: 'Final report', is_error: false });
    });
    it('an unknown event type is dropped alone (old-web behaviour for future additions)', () => {
        const m = envelope({ t: 'progress-v9', x: 1 });
        expect(m).toBeNull();
    });
});
