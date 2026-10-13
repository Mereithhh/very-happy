import { describe, expect, it } from 'vitest';
import { createScheduledWakeupTracker, SCHEDULE_WAKEUP_GRACE_MS } from './scheduledWakeups';
import { evaluateWrapperIdle } from './hibernationPolicy';

const toolUse = (name: string, id: string, input: unknown = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } });
const toolError = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true }] } });

describe('B-587 review P3-4: scheduled work inside the Claude process keeps it awake', () => {
    it('CronCreate counts until a CronDelete', () => {
        const t = createScheduledWakeupTracker();
        t.observe(toolUse('CronCreate', 'c1', { cron: '*/5 * * * *', prompt: 'x' }));
        expect(t.pending()).toBe(1);
        t.observe(toolUse('CronDelete', 'd1', { id: 'job' }));
        expect(t.pending()).toBe(0);
    });
    it('a failed CronCreate does not count', () => {
        const t = createScheduledWakeupTracker();
        t.observe(toolUse('CronCreate', 'c1'));
        t.observe(toolError('c1'));
        expect(t.pending()).toBe(0);
    });
    it('ScheduleWakeup counts until its delay (+ grace) passed', () => {
        const t = createScheduledWakeupTracker();
        t.observe(toolUse('ScheduleWakeup', 'w1', { delaySeconds: 600 }), 0);
        expect(t.pending(599_000)).toBe(1);
        expect(t.pending(600_000 + SCHEDULE_WAKEUP_GRACE_MS)).toBe(0);
    });
    it('the wrapper rule refuses while anything is scheduled', () => {
        const snapshot = { flavor: 'claude', resumable: true, uiSession: true, keepAwake: false, thinking: false, queuedInputs: 0, waitingForInput: true, pendingRequests: 0, backgroundTasks: 0, lastActivityAt: 0 };
        expect(evaluateWrapperIdle({ ...snapshot, scheduledWakeups: 1 }, 1, 10)).toEqual({ ok: false, reason: 'scheduled-wakeup' });
        expect(evaluateWrapperIdle(snapshot, 1, 10)).toEqual({ ok: true });
    });
});
