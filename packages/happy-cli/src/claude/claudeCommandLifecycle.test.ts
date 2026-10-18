import { describe, expect, it } from 'vitest';
import { createClaudeSteerTracker, readClaudeCommandLifecycle } from './claudeCommandLifecycle';

/** The frame Claude Code 2.1.296 emits (probe 2026-10-19). */
const frame = (state: string, command_uuid = 'steer-1') => ({
    type: 'command_lifecycle', command_uuid, state, uuid: 'f-1', session_id: 's-1',
});

describe('readClaudeCommandLifecycle (B-631)', () => {
    it('reads the top-level command_lifecycle frame and tolerates a system subtype spelling', () => {
        expect(readClaudeCommandLifecycle(frame('cancelled'))).toEqual({ uuid: 'steer-1', state: 'cancelled' });
        expect(readClaudeCommandLifecycle({ type: 'system', subtype: 'command_lifecycle', command_uuid: 'x', state: 'started' }))
            .toEqual({ uuid: 'x', state: 'started' });
    });

    it('ignores other frames, unknown states and missing uuids', () => {
        expect(readClaudeCommandLifecycle({ type: 'system', subtype: 'init' })).toBeNull();
        expect(readClaudeCommandLifecycle(frame('exploded'))).toBeNull();
        expect(readClaudeCommandLifecycle({ type: 'command_lifecycle', state: 'cancelled' })).toBeNull();
        expect(readClaudeCommandLifecycle(null)).toBeNull();
    });
});

describe('Claude steer tracker (B-631)', () => {
    it('a cancelled/discarded/refused steer that never started is reported once', () => {
        const tracker = createClaudeSteerTracker();
        tracker.track('a'); tracker.track('b'); tracker.track('c');
        expect(tracker.observe({ uuid: 'a', state: 'queued' })).toEqual([]);
        expect(tracker.observe({ uuid: 'a', state: 'cancelled' })).toEqual(['a']);
        expect(tracker.observe({ uuid: 'a', state: 'cancelled' })).toEqual([]);
        expect(tracker.observe({ uuid: 'b', state: 'discarded' })).toEqual(['b']);
        expect(tracker.observe({ uuid: 'c', state: 'refused' })).toEqual(['c']);
        expect(tracker.isTracked('a')).toBe(false);
    });

    it('a steer the CLI started is settled silently whatever ends it (the model may have read it)', () => {
        const tracker = createClaudeSteerTracker();
        tracker.track('a');
        expect(tracker.observe({ uuid: 'a', state: 'started' })).toEqual([]);
        expect(tracker.observe({ uuid: 'a', state: 'cancelled' })).toEqual([]);
        expect(tracker.isTracked('a')).toBe(false);
        tracker.track('b');
        tracker.observe({ uuid: 'b', state: 'started' });
        expect(tracker.observe({ uuid: 'b', state: 'completed' })).toEqual([]);
        expect(tracker.isTracked('b')).toBe(false);
    });

    it('frames for uuids it never tracked (the web prompt, cron triggers) are not its business', () => {
        const tracker = createClaudeSteerTracker();
        expect(tracker.observe({ uuid: 'prompt-1', state: 'cancelled' })).toEqual([]);
    });

    it('the interrupt receipt: cancelled members are dropped, still_queued members handed back for cancel_async_message', () => {
        const tracker = createClaudeSteerTracker();
        tracker.track('a'); tracker.track('b');
        expect(tracker.onInterruptReceipt({ still_queued: ['b', 'not-ours'], cancelled: ['a', 'not-ours-either'] }))
            .toEqual({ dropped: ['a'], stillQueued: ['b'] });
        // The frame for the same sweep does not report a second time.
        expect(tracker.observe({ uuid: 'a', state: 'cancelled' })).toEqual([]);
        expect(tracker.onInterruptReceipt(undefined)).toEqual({ dropped: [], stillQueued: [] });
        expect(tracker.onInterruptReceipt({ still_queued: 'nope', cancelled: [42] } as any)).toEqual({ dropped: [], stillQueued: [] });
    });

    it('cancel_async_message: only a confirmed withdrawal is a drop; false means it ran', () => {
        const tracker = createClaudeSteerTracker();
        tracker.track('a'); tracker.track('b');
        expect(tracker.onCancelResponse('a', true)).toEqual(['a']);
        expect(tracker.onCancelResponse('b', false)).toEqual([]);
        expect(tracker.isTracked('b')).toBe(true);
        // …and its own lifecycle settles it later.
        tracker.observe({ uuid: 'b', state: 'started' });
        expect(tracker.observe({ uuid: 'b', state: 'completed' })).toEqual([]);
        expect(tracker.isTracked('b')).toBe(false);
    });
});
