import { describe, expect, it } from 'vitest';
import { parseTaskNotification, stripHarnessBlocks } from './harness';

const AGENT_NOTIFICATION = `<task-notification>
<task-id>abc123</task-id>
<tool-use-id>toolu_01XYZ</tool-use-id>
<output-file>/tmp/tasks/abc123.output</output-file>
<status>completed</status>
<summary>Agent "code-review" finished</summary>
</task-notification>`;

const BASH_NOTIFICATION = `<task-notification>
<task-id>b1</task-id>
<status>failed</status>
<summary>Background command "pnpm test" failed with exit code 1</summary>
</task-notification>`;

const MONITOR_NOTIFICATION = `<task-notification>
<task-id>m1</task-id>
<event>file changed</event>
</task-notification>`;

describe('parseTaskNotification (B-260)', () => {
    it('parses an Agent completion notification', () => {
        expect(parseTaskNotification(AGENT_NOTIFICATION)).toEqual({
            summary: 'Agent "code-review" finished',
            status: 'completed',
        });
    });

    it('parses a Bash failure notification', () => {
        expect(parseTaskNotification(BASH_NOTIFICATION)).toEqual({
            summary: 'Background command "pnpm test" failed with exit code 1',
            status: 'failed',
        });
    });

    it('degrades: Monitor notification without summary/status still parses', () => {
        expect(parseTaskNotification(MONITOR_NOTIFICATION)).toEqual({ summary: null, status: null });
    });

    it('ignores ordinary user text and text that merely CONTAINS a notification', () => {
        expect(parseTaskNotification('please fix the bug')).toBeNull();
        expect(parseTaskNotification(`look at this:\n${AGENT_NOTIFICATION}`)).toBeNull();
    });

    it('rejects unknown status values instead of inventing states', () => {
        const weird = AGENT_NOTIFICATION.replace('completed', 'exploded');
        expect(parseTaskNotification(weird)?.status).toBeNull();
    });

    it('stays consistent with stripHarnessBlocks (a pure notification strips to empty)', () => {
        expect(stripHarnessBlocks(AGENT_NOTIFICATION)).toBe('');
    });
});
