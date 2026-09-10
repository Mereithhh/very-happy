import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { MachineTerminal, TerminalAgentState } from '@/sync/ops';

let useTerminalAgentStates: typeof import('./terminalAgentState').useTerminalAgentStates;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ useTerminalAgentStates } = await import('./terminalAgentState'));
});

const MACHINE = 'm1';
let observedAt = 1;

function push(id: string, agentState: TerminalAgentState) {
    useTerminalAgentStates.getState().ingest(MACHINE, [
        { id, agentState, agentKind: 'claude', agentObservedAt: ++observedAt, title: 'term' } as unknown as MachineTerminal,
    ]);
}

function unread(): string[] {
    return [...useTerminalAgentStates.getState().unread];
}

describe('B-330 terminal 未读红点', () => {
    beforeEach(() => {
        useTerminalAgentStates.setState({ states: {}, unread: new Set(), viewingTerminalId: null });
    });

    it('marks a terminal whose agent stopped running while the user was elsewhere', () => {
        push('t1', 'working');
        expect(unread()).toEqual([]);
        push('t1', 'idle');
        expect(unread()).toEqual(['t1']);
    });

    it('counts claude exiting to the shell as a finished run', () => {
        push('t1', 'working');
        push('t1', 'shell');
        expect(unread()).toEqual(['t1']);
    });

    it('the FIRST observation is not a transition — reopening the app marks nothing', () => {
        // Without this, every idle terminal lights up red on load.
        push('t1', 'idle');
        expect(unread()).toEqual([]);
    });

    it('does not mark the terminal the user currently has open', () => {
        useTerminalAgentStates.getState().setViewingTerminal('t1');
        push('t1', 'working');
        push('t1', 'idle');
        expect(unread()).toEqual([]);
    });

    it('needs_input is attention, not unread — rowSignalOf already outranks it', () => {
        push('t1', 'working');
        push('t1', 'needs_input');
        expect(unread()).toEqual([]);
    });

    it('opening the terminal clears it', () => {
        push('t1', 'working');
        push('t1', 'idle');
        expect(unread()).toEqual(['t1']);
        useTerminalAgentStates.getState().markTerminalRead('t1');
        expect(unread()).toEqual([]);
    });

    it('a later idle→idle push does not re-mark a terminal the user just read', () => {
        push('t1', 'working');
        push('t1', 'idle');
        useTerminalAgentStates.getState().markTerminalRead('t1');
        push('t1', 'idle');
        expect(unread()).toEqual([]);
    });
});

/**
 * B-360 — when a host ends up with two machine rows (a rotated machine id), the
 * retired row's frozen snapshot and the live row's push carry the SAME terminal
 * ids. `states` is keyed by terminal id, so the retired row's last state would
 * otherwise read as "the previous state of this terminal" and fake a
 * transition on every load.
 */
describe('B-360 the same terminal id arriving from two machine rows', () => {
    beforeEach(() => {
        useTerminalAgentStates.setState({ states: {}, unread: new Set(), viewingTerminalId: null });
    });

    function pushFrom(machineId: string, id: string, agentState: TerminalAgentState) {
        useTerminalAgentStates.getState().ingest(machineId, [
            { id, agentState, agentKind: 'claude', agentObservedAt: ++observedAt, title: 'term' } as unknown as MachineTerminal,
        ]);
    }

    it('a change of owning machine is a first observation, not a finished run', () => {
        pushFrom('old-mid', 't1', 'working');   // frozen snapshot of the retired row
        pushFrom('new-mid', 't1', 'idle');      // live daemon's first push
        expect(unread()).toEqual([]);
    });

    it('once the live row owns it, its own transitions still mark unread', () => {
        pushFrom('old-mid', 't1', 'working');
        pushFrom('new-mid', 't1', 'working');
        pushFrom('new-mid', 't1', 'idle');
        expect(unread()).toEqual(['t1']);
    });

    it('the entry ends up owned by the machine that pushed last', () => {
        pushFrom('old-mid', 't1', 'idle');
        pushFrom('new-mid', 't1', 'working');
        expect(useTerminalAgentStates.getState().states['t1'].machineId).toBe('new-mid');
    });

    it('does not replay a needs_input notification when the owner changes', () => {
        // Same rule as the unread dot: the retired row's frozen state is not a
        // previous state of the live owner, so the live row's first push is a
        // first observation — not a transition INTO needs_input.
        const g = globalThis as Record<string, any>;
        const raised: string[] = [];
        const savedNotification = g.Notification;
        const savedHasFocus = g.document.hasFocus;
        g.document.hasFocus = () => false;           // unfocused tab, or nothing fires
        g.Notification = class {
            static permission = 'granted';
            onclick: (() => void) | null = null;
            constructor(title: string) { raised.push(title); }
            close() {}
        };
        try {
            pushFrom('old-mid', 't1', 'idle');
            pushFrom('new-mid', 't1', 'needs_input');
            expect(raised).toEqual([]);
            // The live owner's OWN transition still notifies.
            pushFrom('new-mid', 't1', 'idle');
            pushFrom('new-mid', 't1', 'needs_input');
            expect(raised).toHaveLength(1);
        } finally {
            g.Notification = savedNotification;
            g.document.hasFocus = savedHasFocus;
        }
    });
});

describe('B-452 terminal observation freshness and identity', () => {
    it('a replay cannot extend a lease or fake a finished run after expiry', async () => {
        const { vi } = await import('vitest');
        const { resetHeartbeatLeaseForTest } = await import('./heartbeatLease');
        const { isTerminalStatusFresh } = await import('./terminalAgentState');
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        resetHeartbeatLeaseForTest();
        useTerminalAgentStates.setState({ states:{}, unread:new Set(), viewingTerminalId:null });
        const sample = { id:'lease', agentKind:'pi', agentState:'working', agentObservedAt:50 } as MachineTerminal;
        try {
            useTerminalAgentStates.getState().ingest(MACHINE,[sample]);
            expect(isTerminalStatusFresh('lease',useTerminalAgentStates.getState().states.lease)).toBe(true);
            vi.advanceTimersByTime(30_000);
            useTerminalAgentStates.getState().ingest(MACHINE,[sample]);
            vi.advanceTimersByTime(15_001);
            expect(isTerminalStatusFresh('lease',useTerminalAgentStates.getState().states.lease)).toBe(false);
            useTerminalAgentStates.getState().ingest(MACHINE,[{ ...sample, agentState:'idle', agentObservedAt:51 }]);
            expect(unread()).toEqual([]);
            expect(isTerminalStatusFresh('lease',useTerminalAgentStates.getState().states.lease)).toBe(true);
        } finally { resetHeartbeatLeaseForTest(); vi.useRealTimers(); }
    });
    it('switching agent is a new observation, not the old agent completing', () => {
        useTerminalAgentStates.setState({ states:{}, unread:new Set(), viewingTerminalId:null });
        const sample = { id:'switch', agentKind:'claude', agentState:'working', agentObservedAt:70 } as MachineTerminal;
        useTerminalAgentStates.getState().ingest(MACHINE,[sample]);
        useTerminalAgentStates.getState().ingest(MACHINE,[{ ...sample, agentKind:'codex', agentState:'idle', agentObservedAt:71 }]);
        expect(unread()).toEqual([]);
        useTerminalAgentStates.getState().ingest(MACHINE,[sample]);
        expect(useTerminalAgentStates.getState().states.switch.agentKind).toBe('codex');
    });
    it('old daemons and unknown future states do not become idle', async () => {
        const { isTerminalStatusFresh } = await import('./terminalAgentState');
        useTerminalAgentStates.setState({ states:{}, unread:new Set(), viewingTerminalId:null });
        useTerminalAgentStates.getState().ingest(MACHINE,[{ id:'old', agentState:'working' } as MachineTerminal]);
        expect(isTerminalStatusFresh('old',useTerminalAgentStates.getState().states.old)).toBe(false);
        useTerminalAgentStates.getState().ingest(MACHINE,[{ id:'future',agentKind:'future-agent',agentState:'future-state',agentObservedAt:80 } as unknown as MachineTerminal]);
        expect(useTerminalAgentStates.getState().states.future.state).toBeUndefined();
        expect(useTerminalAgentStates.getState().states.future.agentKind).toBeUndefined();
    });
});
