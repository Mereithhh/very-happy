import { describe, expect, it } from 'vitest';
import { mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './sessionProtocolMapper';

function agentToolUse(state: ClaudeSessionProtocolState, callId = 'toolu_agent_1') {
    return mapClaudeLogMessageToSessionEnvelopes({
        type: 'assistant',
        uuid: 'a-1',
        message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: callId, name: 'Agent', input: { description: 'Review the diff', prompt: 'Review the diff carefully', subagent_type: 'general-purpose' } }],
        },
    } as any, state);
}

function stubResult(state: ClaudeSessionProtocolState, callId = 'toolu_agent_1') {
    return mapClaudeLogMessageToSessionEnvelopes({
        type: 'user',
        uuid: 'u-stub',
        tool_use_result: { status: 'async_launched', agentId: 'abc' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'Async agent launched successfully…' }] },
    } as any, state);
}

describe('sub-agent lifecycle mapping (B-260-P2)', () => {
    it('background agent: stub tool_result keeps the sub-agent running; task_notification stops it with status + usage', () => {
        const state: ClaudeSessionProtocolState = { currentTurnId: null, now: () => 1_000 };
        const start = agentToolUse(state);
        const toolCall = start.envelopes.find((e) => e.ev.t === 'tool-call-start');
        expect(toolCall?.ev).toMatchObject({ name: 'Agent', args: expect.objectContaining({ sessionSubagent: expect.any(String) }) });
        const subagent = String((toolCall!.ev as any).args.sessionSubagent);

        const stub = stubResult(state);
        expect(stub.envelopes.map((e) => e.ev.t)).toEqual(['tool-call-end']); // no stop

        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_agent_1', description: 'Review the diff', subagent_type: 'general-purpose', uuid: 's-1',
        } as any, state);
        expect(started.envelopes.map((e) => e.ev.t)).toEqual(['start']);
        expect(started.envelopes[0].subagent).toBe(subagent);
        expect(started.envelopes[0].ev).toMatchObject({ t: 'start', description: 'Review the diff', subagentType: 'general-purpose' });

        const progress = mapClaudeLogMessageToSessionEnvelopes({
            type: 'system', subtype: 'task_progress', task_id: 't1', tool_use_id: 'toolu_agent_1', description: 'Review the diff',
            usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 }, last_tool_name: 'Read', uuid: 's-2',
        } as any, state);
        expect(progress.envelopes.map((e) => e.ev.t)).toEqual(['progress']);
        expect(progress.envelopes[0].ev).toEqual({ t: 'progress', toolUses: 3, lastTool: 'Read', totalTokens: 1200, durationMs: 4000 });

        // throttled: same tool count within 5s → nothing
        const throttled = mapClaudeLogMessageToSessionEnvelopes({
            type: 'system', subtype: 'task_progress', task_id: 't1', tool_use_id: 'toolu_agent_1', description: 'x', usage: { total_tokens: 1300, tool_uses: 3, duration_ms: 4500 }, uuid: 's-3',
        } as any, state);
        expect(throttled.envelopes).toEqual([]);

        const done = mapClaudeLogMessageToSessionEnvelopes({
            type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_agent_1', status: 'completed', output_file: '/tmp/x', summary: 'Agent "Review the diff" finished',
            usage: { total_tokens: 5000, tool_uses: 9, duration_ms: 60_000 }, uuid: 's-4',
        } as any, state);
        expect(done.envelopes.map((e) => e.ev.t)).toEqual(['stop']);
        expect(done.envelopes[0].subagent).toBe(subagent);
        expect(done.envelopes[0].ev).toEqual({ t: 'stop', status: 'completed', usage: { toolUses: 9, totalTokens: 5000, durationMs: 60_000 } });
    });

    it('the task-notification user message re-emits stop with the <result> report, then stays a turn boundary', () => {
        const state: ClaudeSessionProtocolState = { currentTurnId: null };
        const start = agentToolUse(state);
        const subagent = String((start.envelopes.find((e) => e.ev.t === 'tool-call-start')!.ev as any).args.sessionSubagent);
        stubResult(state);
        const text = '<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_agent_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Review the diff" finished</summary>\n<result>\nThe diff is fine.\n</result>\n</task-notification>';
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user', uuid: 'u-notif', origin: { kind: 'task-notification' },
            message: { role: 'user', content: text },
        } as any, state);
        expect(result.envelopes.map((e) => e.ev.t)).toEqual(['stop', 'turn-end', 'text']);
        expect(result.envelopes[0].subagent).toBe(subagent);
        expect(result.envelopes[0].ev).toEqual({ t: 'stop', status: 'completed', result: { text: 'The diff is fine.' } });
        expect(result.envelopes[2].role).toBe('user');
    });

    it('foreground agent: tool_use_result carries the report into tool-call-end.result and a completed stop', () => {
        const state: ClaudeSessionProtocolState = { currentTurnId: null };
        agentToolUse(state, 'toolu_fg');
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user', uuid: 'u-fg',
            tool_use_result: { status: 'completed', content: [{ type: 'text', text: 'Final report' }], totalToolUseCount: 4, totalDurationMs: 2500, totalTokens: 800, toolStats: { readCount: 2 } },
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'Final report\n\nagentId: x' }] },
        } as any, state);
        expect(result.envelopes.map((e) => e.ev.t)).toEqual(['stop', 'tool-call-end']);
        expect(result.envelopes[0].ev).toEqual({ t: 'stop', status: 'completed', result: { text: 'Final report' }, usage: { toolUses: 4, totalTokens: 800, durationMs: 2500 } });
        expect(result.envelopes[1].ev).toMatchObject({ t: 'tool-call-end', call: 'toolu_fg', result: { text: 'Final report', stats: { toolUses: 4, toolStats: { readCount: 2 } } } });
    });

    it('lifecycle survives the launching turn: child messages after turn-end still map to the same subagent', () => {
        const state: ClaudeSessionProtocolState = { currentTurnId: null };
        const start = agentToolUse(state);
        const subagent = String((start.envelopes.find((e) => e.ev.t === 'tool-call-start')!.ev as any).args.sessionSubagent);
        stubResult(state);
        mapClaudeLogMessageToSessionEnvelopes({ type: 'result', subtype: 'success', uuid: 'r-1' } as any, state); // turn ends
        const child = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant', uuid: 'a-child', parent_tool_use_id: 'toolu_agent_1',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_child_read', name: 'Read', input: { file_path: '/a' } }] },
        } as any, state);
        const toolStart = child.envelopes.find((e) => e.ev.t === 'tool-call-start');
        expect(toolStart?.subagent).toBe(subagent); // not buffered, not orphaned
        const done = mapClaudeLogMessageToSessionEnvelopes({
            type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_agent_1', status: 'failed', output_file: '/tmp/x', summary: 'x', uuid: 's-9',
        } as any, state);
        expect(done.envelopes.at(-1)?.ev).toEqual({ t: 'stop', status: 'failed' });
        expect(done.envelopes.at(-1)?.subagent).toBe(subagent);
    });

    it('ignores task frames that are not Agent calls this process saw (Bash background tasks, monitors, unknown ids)', () => {
        const state: ClaudeSessionProtocolState = { currentTurnId: 'turn-1' };
        const bash = mapClaudeLogMessageToSessionEnvelopes({ type: 'system', subtype: 'task_started', task_id: 'b1', description: 'pnpm test', task_type: 'local_bash', uuid: 's-b' } as any, state);
        expect(bash.envelopes).toEqual([]);
        const unknown = mapClaudeLogMessageToSessionEnvelopes({ type: 'system', subtype: 'task_notification', task_id: 'z', tool_use_id: 'toolu_never_seen', status: 'completed', output_file: '/x', summary: 's', uuid: 's-z' } as any, state);
        expect(unknown.envelopes).toEqual([]);
        const skipped = mapClaudeLogMessageToSessionEnvelopes({ type: 'system', subtype: 'task_started', task_id: 'h', tool_use_id: 'toolu_agent_1', description: 'housekeeping', skip_transcript: true, uuid: 's-h' } as any, state);
        expect(skipped.envelopes).toEqual([]);
    });
});
