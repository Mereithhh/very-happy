import { describe, expect, it } from 'vitest';
import { agentStatusSignal, sessionExecution, terminalExecution, codingAgentLabel } from './agentStatus';
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
