import { describe, expect, it } from 'vitest';
import type { Message, SubagentLifecycle, ToolCallMessage } from '@/sync/typesMessage';
import { presentedSubagentStatus, userAbortedAt } from './subagentAbort';
import { countRunningSubagentCards } from './subagentPills';

const T0 = 1_700_000_000_000;

function card(createdAt: number, subagent?: Partial<SubagentLifecycle>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: `card-${createdAt}`,
        localId: null,
        createdAt,
        children: [],
        tool: {
            name: 'Task',
            state: 'running',
            input: { sessionSubagent: 's1', description: 'Review' },
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: null,
        },
        ...(subagent ? { subagent: { status: 'running', updatedAt: createdAt, ...subagent } as SubagentLifecycle } : {}),
    };
}

function serviceEvent(createdAt: number, message: string): Message {
    return {
        kind: 'agent-event',
        id: `ev-${createdAt}`,
        createdAt,
        event: { type: 'message', message },
    };
}

describe('B-317 user abort ends the sub-agents of the turn it interrupted', () => {
    it('finds the newest stop marker and ignores ordinary service events', () => {
        expect(userAbortedAt([])).toBeNull();
        expect(userAbortedAt([serviceEvent(T0, 'Compaction completed')])).toBeNull();
        expect(userAbortedAt([
            serviceEvent(T0, 'Aborted by user'),
            serviceEvent(T0 + 10, 'Compaction completed'),
            serviceEvent(T0 + 20, 'Turn aborted'),
        ])).toBe(T0 + 20);
    });

    it('a card still marked running reads as stopped after the abort', () => {
        expect(presentedSubagentStatus(card(T0, { status: 'running' }), T0 + 5)).toBe('stopped');
    });

    it("the CLI's bare stop — which normalizes to `completed` — is not a completion", () => {
        // claudeRemoteLauncher's interrupted tool_result carries no
        // tool_use_result, so the mapper emits a bare stop and the web reads it
        // as `completed`. Without this rule an aborted sub-agent shows ✓ done.
        expect(presentedSubagentStatus(card(T0, { status: 'completed' }), T0 + 5)).toBe('stopped');
    });

    it('a sub-agent that really reported keeps its own status', () => {
        const reported = card(T0, { status: 'completed', result: { text: 'done' } });
        expect(presentedSubagentStatus(reported, T0 + 5)).toBe('completed');
        const measured = card(T0, { status: 'completed', usage: { toolUses: 3 } });
        expect(presentedSubagentStatus(measured, T0 + 5)).toBe('completed');
        expect(presentedSubagentStatus(card(T0, { status: 'failed' }), T0 + 5)).toBe('failed');
    });

    it('a card started after the abort is a new turn and is untouched', () => {
        expect(presentedSubagentStatus(card(T0 + 100, { status: 'running' }), T0)).toBe('running');
    });

    it('no CLI lifecycle stays no claim, abort or not', () => {
        expect(presentedSubagentStatus(card(T0), null)).toBeUndefined();
        expect(presentedSubagentStatus(card(T0), T0 + 5)).toBeUndefined();
    });

    it('an aborted sub-agent stops voting for session liveness', () => {
        const running = card(T0, { status: 'running' });
        expect(countRunningSubagentCards([running])).toBe(1);
        expect(countRunningSubagentCards([running, serviceEvent(T0 + 5, 'Aborted by user')])).toBe(0);
    });
});
