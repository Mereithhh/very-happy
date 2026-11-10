import { describe, expect, it } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { backgroundTaskChipText, backgroundTaskEntries, formatTaskAge } from './backgroundTaskDock';

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

describe('B-913 chip detail: command, age, launching turn', () => {
    it('a newer CLI: the command line is the title (mono), the turn prompt the detail', () => {
        const [entry] = backgroundTaskEntries([{ id: 'b', type: 'local_bash', description: 'wait for CI', startedAt: 5, command: 'gh run watch 123', turn: { startedAt: 1, prompt: 'merge when green' } }], 1, []);
        expect(entry).toMatchObject({ command: 'gh run watch 123', turn: { startedAt: 1, prompt: 'merge when green' } });
        expect(backgroundTaskChipText(entry)).toEqual({ title: 'gh run watch 123', mono: true, turnPrompt: 'merge when green', detailed: true });
    });
    it('an agent keeps its description as the title, still with the turn', () => {
        const [entry] = backgroundTaskEntries([{ id: 'a', type: 'local_agent', description: 'Explore repo', turn: { startedAt: 1, prompt: 'look around' } }], 1, []);
        expect(backgroundTaskChipText(entry)).toEqual({ title: 'Explore repo', mono: false, turnPrompt: 'look around', detailed: true });
    });
    it('an older CLI (no command / turn): the one-line chip as before', () => {
        const [entry] = backgroundTaskEntries([{ id: 'b', type: 'local_bash', description: 'sleep 300', startedAt: 5 }], 1, []);
        expect(entry).toMatchObject({ command: null, turn: null });
        expect(backgroundTaskChipText(entry)).toEqual({ title: 'sleep 300', mono: false, turnPrompt: null, detailed: false });
    });
});
