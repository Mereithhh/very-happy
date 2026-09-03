import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { MachineTerminal, TerminalAgentState } from '@/sync/ops';

let useTerminalAgentStates: typeof import('./terminalAgentState').useTerminalAgentStates;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ useTerminalAgentStates } = await import('./terminalAgentState'));
});

const MACHINE = 'm1';

function push(id: string, agentState: TerminalAgentState) {
    useTerminalAgentStates.getState().ingest(MACHINE, [
        { id, agentState, title: 'term' } as unknown as MachineTerminal,
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
