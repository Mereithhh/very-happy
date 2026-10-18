import { describe, expect, it } from 'vitest';
import { createClaudeTurnTracker, readClaudeSessionState } from './claudeTurnEnd';

describe('Claude turn tracker (B-631)', () => {
    it('an idle after the result is the same end, not a second one', () => {
        const turn = createClaudeTurnTracker();
        turn.begin();
        expect(turn.onResult()).toBe(true);
        expect(turn.onSessionState('idle')).toBe('duplicate');
        expect(turn.isOpen).toBe(false);
    });

    it('an idle with no result ends the turn once', () => {
        const turn = createClaudeTurnTracker();
        turn.begin();
        turn.onSessionState('running');
        expect(turn.onSessionState('idle')).toBe('end');
        expect(turn.isOpen).toBe(false);
        // A result that still arrives afterwards must not end it a second time.
        expect(turn.onResult()).toBe(false);
        expect(turn.onSessionState('idle')).toBe('ignore');
    });

    it('a late idle of the previous turn does not end the turn pushed meanwhile', () => {
        const turn = createClaudeTurnTracker();
        turn.begin();
        expect(turn.onResult()).toBe(true);     // result(N)
        turn.begin();                           // wrapper pushed N+1 before reading idle(N)
        expect(turn.onSessionState('idle')).toBe('duplicate');
        expect(turn.isOpen).toBe(true);         // N+1 still runs
        expect(turn.onSessionState('running')).toBe('ignore');
        expect(turn.onSessionState('idle')).toBe('end'); // N+1 died without a result
    });

    it('a running clears an idle still owed by a result that had none (pre-empted turn)', () => {
        const turn = createClaudeTurnTracker();
        turn.begin();
        expect(turn.onResult()).toBe(true);     // pre-empted: success/aborted_streaming, no idle follows
        expect(turn.onSessionState('running')).toBe('ignore');
        expect(turn.isOpen).toBe(true);
        expect(turn.onSessionState('idle')).toBe('end');
    });

    it('requires_action and a startup idle are not ends', () => {
        const turn = createClaudeTurnTracker();
        expect(turn.onSessionState('idle')).toBe('ignore');
        turn.begin();
        expect(turn.onSessionState('requires_action')).toBe('ignore');
        expect(turn.isOpen).toBe(true);
    });

    it('reads only the session_state_changed system frame', () => {
        expect(readClaudeSessionState({ type: 'system', subtype: 'session_state_changed', state: 'idle' })).toBe('idle');
        expect(readClaudeSessionState({ type: 'system', subtype: 'session_state_changed', state: 'running' })).toBe('running');
        expect(readClaudeSessionState({ type: 'system', subtype: 'session_state_changed', state: 'later' })).toBeNull();
        expect(readClaudeSessionState({ type: 'system', subtype: 'status', status: 'requesting' })).toBeNull();
        expect(readClaudeSessionState({ type: 'result', subtype: 'success' })).toBeNull();
        expect(readClaudeSessionState(null)).toBeNull();
    });
});
