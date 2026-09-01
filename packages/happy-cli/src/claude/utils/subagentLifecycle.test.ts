import { describe, expect, it } from 'vitest';
import {
    capSubagentText,
    parseTaskNotificationText,
    shouldEmitProgress,
    SUBAGENT_RESULT_MAX_CHARS,
    toolUseResultStats,
    toolUseResultStatus,
    toolUseResultToText,
} from './subagentLifecycle';

describe('subagentLifecycle helpers (B-260-P2)', () => {
    it('caps result text at 16KB and flags truncation', () => {
        const long = 'x'.repeat(SUBAGENT_RESULT_MAX_CHARS + 10);
        expect(capSubagentText(long)).toEqual({ text: 'x'.repeat(SUBAGENT_RESULT_MAX_CHARS), truncated: true });
        expect(capSubagentText('  short  ')).toEqual({ text: 'short' });
    });

    it('reads AgentOutput content/status/stats', () => {
        const out = {
            status: 'completed',
            content: [{ type: 'text', text: 'Report line 1' }, { type: 'image' }, { type: 'text', text: 'line 2' }],
            totalToolUseCount: 7, totalDurationMs: 1234, totalTokens: 999, toolStats: { readCount: 3 },
        };
        expect(toolUseResultToText(out)).toBe('Report line 1\nline 2');
        expect(toolUseResultStatus(out)).toBe('completed');
        expect(toolUseResultStats(out)).toEqual({ toolUses: 7, totalTokens: 999, durationMs: 1234, toolStats: { readCount: 3 } });
        expect(toolUseResultStatus({ status: 'async_launched' })).toBe('async_launched');
        expect(toolUseResultStatus(undefined)).toBe('unknown');
        expect(toolUseResultToText('plain')).toBeNull();
    });

    it('parses a task notification: tool-use-id, status, summary, <result> with preamble/usage stripped', () => {
        const text = `<task-notification>
<task-id>t1</task-id>
<tool-use-id>toolu_abc</tool-use-id>
<status>completed</status>
<summary>Agent "review" finished</summary>
<result>[harness: subagent output matched instruction-shaped pattern(s): x]
Final report here.
<usage>tokens: 1</usage>
</result>
</task-notification>`;
        expect(parseTaskNotificationText(text)).toEqual({
            toolUseId: 'toolu_abc', taskId: 't1', status: 'completed', summary: 'Agent "review" finished',
            result: { text: 'Final report here.' },
        });
    });

    it('degrades on missing fields and ignores non-notifications', () => {
        expect(parseTaskNotificationText('<task-notification><summary>Background command "x" completed</summary></task-notification>'))
            .toEqual({ toolUseId: null, taskId: null, status: null, summary: 'Background command "x" completed', result: null });
        expect(parseTaskNotificationText('hello')).toBeNull();
    });

    it('throttles progress: first always, then only when tool count changed and ≥5s passed', () => {
        expect(shouldEmitProgress(undefined, 1, 0)).toBe(true);
        expect(shouldEmitProgress({ lastAt: 0, lastToolUses: 1 }, 1, 10_000)).toBe(false);
        expect(shouldEmitProgress({ lastAt: 0, lastToolUses: 1 }, 2, 3_000)).toBe(false);
        expect(shouldEmitProgress({ lastAt: 0, lastToolUses: 1 }, 2, 5_000)).toBe(true);
    });
});
