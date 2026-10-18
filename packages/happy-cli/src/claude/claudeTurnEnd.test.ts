import { describe, expect, it } from 'vitest';
import { createClaudeTurnTracker, readClaudeSessionState } from './claudeTurnEnd';

describe('Claude turn tracker (B-631)', () => {
    it('an idle after the result is the same end, not a second one', () => {
        const turn = createClaudeTurnTracker();
        turn.pushed();
        turn.onSessionState('running');
        turn.announced();
        expect(turn.onResult()).toBe(true);
        expect(turn.onSessionState('idle')).toBe('duplicate');
        expect(turn.isOpen).toBe(false);
    });

    it('an idle with no result ends an announced turn once', () => {
        const turn = createClaudeTurnTracker();
        turn.pushed();
        turn.onSessionState('running');
        expect(turn.onSessionState('idle')).toBe('end');
        expect(turn.isOpen).toBe(false);
        // A result that still arrives afterwards must not end it a second time.
        expect(turn.onResult()).toBe(false);
        expect(turn.onSessionState('idle')).toBe('ignore');
    });

    it('a pushed prompt the CLI has not announced is not ended by a stray idle (review: pushed ≠ announced)', () => {
        const turn = createClaudeTurnTracker();
        turn.pushed();
        turn.announced();
        expect(turn.onResult()).toBe(true);     // result(N)
        turn.pushed();                          // wrapper pushed N+1; the CLI has not dequeued it
        expect(turn.onSessionState('idle')).toBe('duplicate');  // idle(N), owed to the result
        expect(turn.onSessionState('idle')).toBe('ignore');     // a stray idle: nothing announced is running
        expect(turn.isPending).toBe(true);
        expect(turn.isOpen).toBe(false);
        expect(turn.onSessionState('running')).toBe('ignore');  // the CLI picked N+1 up
        expect(turn.isOpen).toBe(true);
        expect(turn.isPending).toBe(false);
        expect(turn.onSessionState('idle')).toBe('end');        // N+1 died without a result
    });

    it('a running clears an idle still owed by a result that had none (pre-empted turn)', () => {
        const turn = createClaudeTurnTracker();
        turn.pushed();
        turn.announced();
        expect(turn.onResult()).toBe(true);     // pre-empted: success/aborted_streaming, no idle follows
        expect(turn.onSessionState('running')).toBe('ignore');
        expect(turn.isOpen).toBe(true);
        expect(turn.onSessionState('idle')).toBe('end');
    });

    it('a result for a pushed prompt counts even when no announcement was seen (a CLI without session_state frames)', () => {
        const turn = createClaudeTurnTracker();
        turn.pushed();
        turn.announced();                       // init still comes from every CLI
        expect(turn.onResult()).toBe(true);
        turn.pushed();
        expect(turn.onResult()).toBe(true);     // tolerated: a result with neither running nor init
        expect(turn.onResult()).toBe(false);
    });

    it('requires_action and a startup idle are not ends', () => {
        const turn = createClaudeTurnTracker();
        expect(turn.onSessionState('idle')).toBe('ignore');
        turn.pushed();
        turn.announced();
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
