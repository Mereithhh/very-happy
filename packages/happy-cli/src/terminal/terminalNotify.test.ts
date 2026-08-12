/**
 * Unit tests for TerminalNotifyTracker — the pure state machine that turns
 * per-tick agentState observations into webhook notification events
 * (eligibility, 2-tick stability, cooldown, shell/undefined suppression,
 * kick-burst sample gap, cleanup).
 */
import { describe, it, expect } from 'vitest';
import {
    TerminalNotifyTracker,
    NOTIFY_COOLDOWN_MS,
    NOTIFY_MIN_SAMPLE_GAP_MS,
    terminalNotifyLink,
    terminalNotifyMessage,
} from './terminalNotify';
import type { AgentState } from './webTerminal';

const TICK = 10_000; // matches LIST_TRACK_INTERVAL_MS

/** Drive one terminal through a sequence of tick observations (TICK apart),
 *  returning the events fired at each step. */
function run(tracker: TerminalNotifyTracker, id: string, states: Array<AgentState | undefined>, startAt = 0, stepMs = TICK) {
    return states.map((s, i) => tracker.observe(id, s, startAt + i * stepMs));
}

describe('TerminalNotifyTracker', () => {
    it('working → idle (2 ticks stable) fires completed exactly once', () => {
        const tr = new TerminalNotifyTracker();
        const events = run(tr, 't1', ['working', 'working', 'idle', 'idle', 'idle', 'idle']);
        // idle needs 2 stable ticks: sighting at i=2 (count 1), i=3 (count 2 → fire).
        expect(events).toEqual([null, null, null, 'completed', null, null]);
    });

    it('working → needs_input (2 ticks stable) fires permission', () => {
        const tr = new TerminalNotifyTracker();
        const events = run(tr, 't1', ['working', 'needs_input', 'needs_input', 'needs_input']);
        expect(events).toEqual([null, null, 'permission', null]);
    });

    it('idle → needs_input fires permission when armed by an earlier working sighting', () => {
        const tr = new TerminalNotifyTracker();
        // Baseline idle → a single working blip (arms, never confirms) → back
        // to idle → dialog appears.
        const events = run(tr, 't1', ['idle', 'working', 'idle', 'needs_input', 'needs_input']);
        expect(events).toEqual([null, null, null, null, 'permission']);
    });

    it('never fires before working has been seen at least once (daemon startup)', () => {
        const tr = new TerminalNotifyTracker();
        // First observations of an already-idle claude, then a dialog: silent.
        const events = run(tr, 't1', ['idle', 'idle', 'needs_input', 'needs_input', 'idle', 'idle']);
        expect(events).toEqual([null, null, null, null, null, null]);
    });

    it('a single-tick idle blip during working does not fire (stability gate)', () => {
        const tr = new TerminalNotifyTracker();
        const events = run(tr, 't1', ['working', 'idle', 'working', 'working', 'idle', 'idle']);
        // The lone idle at i=1 never reaches 2 ticks; the real turn end at
        // i=4..5 fires (cooldown irrelevant: nothing was sent before).
        expect(events).toEqual([null, null, null, null, null, 'completed']);
    });

    it('candidate switching resets the stability count', () => {
        const tr = new TerminalNotifyTracker();
        // idle(1) → needs_input(1) → idle(1) → … alternating never stabilizes.
        const events = run(tr, 't1', ['working', 'idle', 'needs_input', 'idle', 'needs_input']);
        expect(events).toEqual([null, null, null, null, null]);
    });

    it('after firing, eligibility resets: a second idle arrival without new working is silent', () => {
        const tr = new TerminalNotifyTracker({ cooldownMs: 0 });
        const events = run(tr, 't1', [
            'working', 'idle', 'idle',            // → completed (disarms)
            'needs_input', 'needs_input',         // idle→needs_input but NOT armed
        ]);
        expect(events).toEqual([null, null, 'completed', null, null]);
    });

    it('re-arms on the next working and fires again', () => {
        const tr = new TerminalNotifyTracker({ cooldownMs: 0 });
        const events = run(tr, 't1', [
            'working', 'idle', 'idle',            // completed #1
            'working', 'working', 'idle', 'idle', // completed #2
        ]);
        expect(events).toEqual([null, null, 'completed', null, null, null, 'completed']);
    });

    it('per-terminal cooldown suppresses a second event within 60s and allows it after', () => {
        const tr = new TerminalNotifyTracker();
        expect(run(tr, 't1', ['working', 'idle', 'idle'], 0)).toEqual([null, null, 'completed']); // fired at t=20s
        // Full re-arm + confirmed working→idle again, ending inside the 60s
        // window (qualifies at t=60s; 60s−20s < 60s → suppressed).
        expect(run(tr, 't1', ['working', 'working', 'idle', 'idle'], 3 * TICK)).toEqual([null, null, null, null]);
        // Same cycle after the cooldown has passed (fires at t=120s; 120s−20s > 60s).
        expect(run(tr, 't1', ['working', 'working', 'idle', 'idle'], 9 * TICK)).toEqual([null, null, null, 'completed']);
        expect(NOTIFY_COOLDOWN_MS).toBe(60_000);
    });

    it('transitions involving shell or undefined never fire', () => {
        const tr = new TerminalNotifyTracker();
        // working → shell (claude exited to the shell prompt): silent.
        expect(run(tr, 't1', ['working', 'shell', 'shell'])).toEqual([null, null, null]);
        // working → undefined → idle: both hops involve undefined → silent.
        expect(run(tr, 't2', ['working', undefined, undefined, 'idle', 'idle'])).toEqual([null, null, null, null, null]);
        // shell → needs_input (a dialog quoted in some non-claude TUI): silent
        // even after a working sighting on ANOTHER terminal (state is per-id).
        expect(run(tr, 't3', ['shell', 'needs_input', 'needs_input'])).toEqual([null, null, null]);
    });

    it('undefined → idle after working+undefined phases stays silent (baseline advanced)', () => {
        const tr = new TerminalNotifyTracker();
        const events = run(tr, 't1', ['working', 'working', undefined, undefined, 'idle', 'idle', 'idle']);
        expect(events).toEqual([null, null, null, null, null, null, null]);
    });

    it('kick-burst observations within the sample gap do not fake stability', () => {
        const tr = new TerminalNotifyTracker();
        expect(tr.observe('t1', 'working', 0)).toBeNull();
        expect(tr.observe('t1', 'working', TICK)).toBeNull();
        // Tick sees idle, then a debounced event kick re-observes 250ms later:
        // the second sighting is inside NOTIFY_MIN_SAMPLE_GAP_MS → not counted.
        expect(tr.observe('t1', 'idle', 2 * TICK)).toBeNull();
        expect(tr.observe('t1', 'idle', 2 * TICK + 250)).toBeNull();
        expect(NOTIFY_MIN_SAMPLE_GAP_MS).toBeGreaterThan(250);
        // The NEXT full tick is a real second sighting → fires.
        expect(tr.observe('t1', 'idle', 3 * TICK)).toBe('completed');
    });

    it('terminals are tracked independently', () => {
        const tr = new TerminalNotifyTracker();
        run(tr, 'a', ['working', 'working']);
        // b never saw working → its dialog is silent while a still fires.
        expect(run(tr, 'b', ['idle', 'needs_input', 'needs_input'])).toEqual([null, null, null]);
        expect(run(tr, 'a', ['idle', 'idle'], 2 * TICK)).toEqual([null, 'completed']);
    });

    it('remove() forgets a terminal: re-observation is a fresh baseline', () => {
        const tr = new TerminalNotifyTracker();
        run(tr, 't1', ['working', 'working']);
        tr.remove('t1');
        // Fresh baseline idle → nothing pending, no event ever fired.
        expect(run(tr, 't1', ['idle', 'idle', 'idle'], 2 * TICK)).toEqual([null, null, null]);
    });

    it('prune() drops terminals missing from the live list and keeps the rest', () => {
        const tr = new TerminalNotifyTracker();
        run(tr, 'keep', ['working', 'working']);
        run(tr, 'gone', ['working', 'working']);
        tr.prune(['keep']);
        // 'gone' was forgotten: its idle arrival is a fresh baseline (silent).
        expect(run(tr, 'gone', ['idle', 'idle', 'idle'], 2 * TICK)).toEqual([null, null, null]);
        // 'keep' retained its armed/working state and fires normally.
        expect(run(tr, 'keep', ['idle', 'idle'], 2 * TICK)).toEqual([null, 'completed']);
    });

    it('cooldown suppression does not consume eligibility (fires once allowed)', () => {
        const tr = new TerminalNotifyTracker();
        expect(run(tr, 't1', ['working', 'needs_input', 'needs_input'])).toEqual([null, null, 'permission']); // t=20s
        // Dialog answered → working → turn ends quickly: the working→idle at
        // t=60s qualifies but is inside the cooldown → suppressed, and the
        // terminal stays armed…
        expect(run(tr, 't1', ['working', 'working', 'idle', 'idle'], 3 * TICK)).toEqual([null, null, null, null]);
        // …so a dialog appearing later (idle→needs_input, t=100s) still fires.
        expect(run(tr, 't1', ['needs_input', 'needs_input'], 9 * TICK)).toEqual([null, 'permission']);
    });
});

describe('notification copy & link', () => {
    it('maps events to the fixed message lines', () => {
        expect(terminalNotifyMessage('completed')).toBe('Claude 等待下一步指令');
        expect(terminalNotifyMessage('permission')).toBe('Claude 请求确认/需要输入');
    });

    it('builds the web-app terminal path', () => {
        expect(terminalNotifyLink('machine-1', 'abc123')).toBe('/terminal/machine-1?tid=abc123');
    });
});
