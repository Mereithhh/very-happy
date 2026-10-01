import { describe, expect, it } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { backgroundTaskEntries, formatTaskAge } from './backgroundTaskDock';

const card = (description: string) => ({ kind: 'tool-call', id: 'c', tool: { name: 'Agent', input: { description } } } as unknown as ToolCallMessage);
const tasks = [
    { id: 'b2', type: 'local_bash', description: 'Wait for remaining test results', startedAt: 2000 },
    { id: 'b1', type: 'local_bash', description: 'Wait for all test runs to finish', startedAt: 1000 },
];

describe('B-518 background task dock entries', () => {
    it('lists the reported tasks oldest first when the heartbeat says they run (kimi session repro)', () => {
        expect(backgroundTaskEntries(tasks, 2, []).map((t) => [t.id, t.kind])).toEqual([['b1', 'command'], ['b2', 'command']]);
    });
    it('lists nothing once the heartbeat count is 0, whatever agentState still holds', () => {
        expect(backgroundTaskEntries(tasks, 0, [])).toEqual([]);
        expect(backgroundTaskEntries(null, 3, [])).toEqual([]);
    });
    it('shows a background sub-agent once — as its card when the card is in the dock', () => {
        const reported = [{ id: 'a1', type: 'local_agent', description: 'Audit logs', startedAt: 1 }, { id: 'm1', type: 'monitor', description: 'Watch CI', startedAt: 2 }];
        expect(backgroundTaskEntries(reported, 2, [card('Audit logs')]).map((t) => t.id)).toEqual(['m1']);
        expect(backgroundTaskEntries(reported, 2, []).map((t) => [t.id, t.kind])).toEqual([['a1', 'agent'], ['m1', 'monitor']]);
    });
    it('formats ages compactly', () => {
        expect(formatTaskAge(0, 45_000)).toBe('45s');
        expect(formatTaskAge(0, 12 * 60_000)).toBe('12m');
        expect(formatTaskAge(0, 34 * 3600_000)).toBe('1d');
        expect(formatTaskAge(null, 1)).toBeNull();
    });
});
