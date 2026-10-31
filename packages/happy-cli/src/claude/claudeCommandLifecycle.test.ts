import { describe, expect, it } from 'vitest';
import { createClaudeCommandTracker, planUndeliveredMessage, planUnconfirmedCommands, readClaudeCommandLifecycle } from './claudeCommandLifecycle';

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

describe('Claude command tracker (B-631)', () => {
    it('a cancelled/discarded/refused command that never started is reported once', () => {
        const tracker = createClaudeCommandTracker();
        tracker.track('a'); tracker.track('b'); tracker.track('c');
        expect(tracker.observe({ uuid: 'a', state: 'queued' })).toEqual([]);
        expect(tracker.observe({ uuid: 'a', state: 'cancelled' })).toEqual(['a']);
        expect(tracker.observe({ uuid: 'a', state: 'cancelled' })).toEqual([]);
        expect(tracker.observe({ uuid: 'b', state: 'discarded' })).toEqual(['b']);
        expect(tracker.observe({ uuid: 'c', state: 'refused' })).toEqual(['c']);
        expect(tracker.isTracked('a')).toBe(false);
    });

    it('a command the CLI started is settled silently whatever ends it (the model may have read it)', () => {
        const tracker = createClaudeCommandTracker();
        tracker.track('a');
        expect(tracker.observe({ uuid: 'a', state: 'started' })).toEqual([]);
        expect(tracker.observe({ uuid: 'a', state: 'cancelled' })).toEqual([]);
        expect(tracker.isTracked('a')).toBe(false);
        tracker.track('b');
        tracker.observe({ uuid: 'b', state: 'started' });
        expect(tracker.observe({ uuid: 'b', state: 'completed' })).toEqual([]);
        expect(tracker.isTracked('b')).toBe(false);
    });

    it('frames for uuids it never tracked (another client, cron triggers) are not its business', () => {
        const tracker = createClaudeCommandTracker();
        expect(tracker.observe({ uuid: 'prompt-1', state: 'cancelled' })).toEqual([]);
    });

    it('the interrupt receipt: cancelled members are dropped, still_queued members handed back for cancel_async_message', () => {
        const tracker = createClaudeCommandTracker();
        tracker.track('a'); tracker.track('b');
        expect(tracker.onInterruptReceipt({ still_queued: ['b', 'not-ours'], cancelled: ['a', 'not-ours-either'] }))
            .toEqual({ dropped: ['a'], stillQueued: ['b'] });
        // The frame for the same sweep does not report a second time.
        expect(tracker.observe({ uuid: 'a', state: 'cancelled' })).toEqual([]);
        expect(tracker.onInterruptReceipt(undefined)).toEqual({ dropped: [], stillQueued: [] });
        expect(tracker.onInterruptReceipt({ still_queued: 'nope', cancelled: [42] } as any)).toEqual({ dropped: [], stillQueued: [] });
    });

    it('cancel_async_message: only a confirmed withdrawal is a drop; false means it ran', () => {
        const tracker = createClaudeCommandTracker();
        tracker.track('a'); tracker.track('b');
        expect(tracker.onCancelResponse('a', true)).toEqual(['a']);
        expect(tracker.onCancelResponse('b', false)).toEqual([]);
        expect(tracker.isTracked('b')).toBe(true);
        // …and its own lifecycle settles it later.
        tracker.observe({ uuid: 'b', state: 'started' });
        expect(tracker.observe({ uuid: 'b', state: 'completed' })).toEqual([]);
        expect(tracker.isTracked('b')).toBe(false);
    });

    it('a CLI that never settles anything cannot make the tracked set grow without bound', () => {
        const tracker = createClaudeCommandTracker();
        for (let i = 0; i < 300; i += 1) tracker.track(`u-${i}`);
        expect(tracker.isTracked('u-0')).toBe(false);
        expect(tracker.isTracked('u-43')).toBe(false);
        expect(tracker.isTracked('u-44')).toBe(true);
        expect(tracker.isTracked('u-299')).toBe(true);
        // Re-tracking a known uuid evicts nothing.
        tracker.track('u-299');
        expect(tracker.isTracked('u-44')).toBe(true);
    });
});

describe('unconfirmed commands (B-634 ②)', () => {
    it('takeUnconfirmed returns tracked messages that never started, once, in send order', () => {
        const tracker = createClaudeCommandTracker<string>();
        tracker.track('a', 'A');
        tracker.track('b', 'B');
        tracker.track('c', 'C');
        tracker.track('untracked-payload');
        tracker.observe({ uuid: 'a', state: 'started' });
        tracker.observe({ uuid: 'c', state: 'cancelled' }); // reported as dropped already
        expect(tracker.takeUnconfirmed()).toEqual([{ uuid: 'b', payload: 'B' }]);
        expect(tracker.takeUnconfirmed()).toEqual([]);
    });

    it('plan: an abort tombstones everything; a fault re-sends the first one once, tombstones the rest', () => {
        const cmds = [{ uuid: 'x', payload: 1 }, { uuid: 'y', payload: 2 }];
        expect(planUnconfirmedCommands(cmds, { aborted: true, parkFree: true, redelivered: new Set() }))
            .toEqual({ redeliver: null, tombstone: ['x', 'y'] });
        expect(planUnconfirmedCommands(cmds, { aborted: false, parkFree: true, redelivered: new Set() }))
            .toEqual({ redeliver: cmds[0], tombstone: ['y'] });
        // x already had its second chance: y gets it instead.
        expect(planUnconfirmedCommands(cmds, { aborted: false, parkFree: true, redelivered: new Set(['x']) }))
            .toEqual({ redeliver: cmds[1], tombstone: ['x'] });
        expect(planUnconfirmedCommands([cmds[0]], { aborted: false, parkFree: true, redelivered: new Set(['x']) }))
            .toEqual({ redeliver: null, tombstone: ['x'] });
        // Something else is parked for the next launch (a mode change): never overwrite it.
        expect(planUnconfirmedCommands(cmds, { aborted: false, parkFree: false, redelivered: new Set() }))
            .toEqual({ redeliver: null, tombstone: ['x', 'y'] });
    });
});

describe('planUndeliveredMessage (B-853)', () => {
    const message = { message: 'hi', mode: { permissionMode: 'default' }, uuid: 'u-1' };

    it('parks a message that never reached Claude Code, marked finalized so it is not decorated twice', () => {
        expect(planUndeliveredMessage(message, { parkFree: true, exiting: false })).toEqual({ ...message, finalized: true });
    });

    it('returns null (caller tombstones) when leaving remote mode or the park slot is taken', () => {
        expect(planUndeliveredMessage(message, { parkFree: true, exiting: true })).toBeNull();
        expect(planUndeliveredMessage(message, { parkFree: false, exiting: false })).toBeNull();
    });
});
