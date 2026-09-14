import { describe, expect, it } from 'vitest';
import { agentStatusSignal, sessionExecution, terminalExecution, codingAgentLabel, LEGACY_TERMINAL_ACTIVITY_TTL_MS } from './agentStatus';
const ready = { online:true, active:true, fresh:true, thinking:false, needsInput:false };
describe('one status vocabulary for all agent transports', () => {
    it.each(['claude','codex','pi'])('%s UI and terminal have equivalent transitions', kind => {
        expect(codingAgentLabel(kind)).not.toBe('Agent');
        for (const [thinking, needsInput, state, expected] of [
            [false,false,'idle','idle'], [true,false,'working','running'],
            [true,true,'needs_input','input'], [false,false,'idle','idle'],
        ] as const) {
            expect(sessionExecution({ ...ready, thinking, needsInput })).toBe(expected);
            expect(terminalExecution({ online:true, fresh:true, state })).toBe(expected);
        }
    });
    it('stale work/requests are unknown, and disconnected owners are offline', () => {
        expect(sessionExecution({ ...ready, fresh:false, thinking:true, needsInput:true })).toBe('unknown');
        expect(terminalExecution({ online:true, fresh:false, state:'working' })).toBe('unknown');
        expect(sessionExecution({ ...ready, online:false, thinking:true })).toBe('offline');
        expect(terminalExecution({ online:false, fresh:true, state:'needs_input' })).toBe('offline');
        expect(terminalExecution({ online:true, fresh:true, state:'future' })).toBe('unknown');
    });
    it('B-465: an old daemon (no observation stamp) is estimated from its state + terminal activity', () => {
        const now = 1_000_000;
        const legacy = (activityAgo: number | undefined) => ({ activityAt: activityAgo === undefined ? undefined : now - activityAgo, now });
        // working + recent output = the spinner is still moving
        expect(terminalExecution({ online:true, fresh:false, state:'working', legacy: legacy(5_000) })).toBe('running');
        expect(terminalExecution({ online:true, fresh:false, state:'working', legacy: legacy(LEGACY_TERMINAL_ACTIVITY_TTL_MS) })).toBe('running');
        // working but silent for too long: not manufactured into work
        expect(terminalExecution({ online:true, fresh:false, state:'working', legacy: legacy(LEGACY_TERMINAL_ACTIVITY_TTL_MS + 1) })).toBe('unknown');
        expect(terminalExecution({ online:true, fresh:false, state:'working', legacy: legacy(undefined) })).toBe('unknown');
        // a dialog is silent by nature: taken as reported (offline still gates it)
        expect(terminalExecution({ online:true, fresh:false, state:'needs_input', legacy: legacy(undefined) })).toBe('input');
        expect(terminalExecution({ online:false, fresh:false, state:'needs_input', legacy: legacy(1_000) })).toBe('offline');
        expect(terminalExecution({ online:true, fresh:false, state:'idle', legacy: legacy(undefined) })).toBe('idle');
        expect(terminalExecution({ online:true, fresh:false, state:'shell', legacy: legacy(undefined) })).toBe('idle');
        expect(terminalExecution({ online:true, fresh:false, state:undefined, legacy: legacy(1_000) })).toBe('unknown');
        // the estimate never overrides a fresh (stamped) observation
        expect(terminalExecution({ online:true, fresh:true, state:'idle', legacy: legacy(1_000) })).toBe('idle');
        // and a stamped-but-stale observation stays unknown (no legacy input)
        expect(terminalExecution({ online:true, fresh:false, state:'working' })).toBe('unknown');
    });
    it('counts live background subagents using the main transcript rule', () => {
        expect(sessionExecution({ ...ready, runningSubagents:1 })).toBe('running');
    });
    it('renders only one slot without destroying the independent unread bit', () => {
        for (const state of ['running','input'] as const) expect(agentStatusSignal(state,true)).toBe(state);
        expect(agentStatusSignal('offline',true)).toBe('unread');
        expect(agentStatusSignal('unknown',true)).toBe('unread');
        expect(agentStatusSignal('idle',true)).toBe('unread');
        expect(agentStatusSignal('idle',false)).toBeNull();
    });
});
