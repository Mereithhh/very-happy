import { describe, expect, it } from 'vitest';
import { TerminalAgentHookStore } from './agentHookStore';

const T0 = 5_000_000;
const claudeIdle = { agentKind: 'claude' as const, agentState: 'idle' as const };
const hook = (event: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: event, session_id: 'sess-1', terminalId: 'term1', claudePid: 4321, ...extra,
});

describe('TerminalAgentHookStore (B-547)', () => {
    it('reports list-relevant changes only', () => {
        const store = new TerminalAgentHookStore(() => true);
        expect(store.applyHook({ nope: true }, T0)).toBeNull();
        expect(store.applyHook(hook('SessionStart', { source: 'startup' }), T0)).toEqual({ terminalId: 'term1', changed: true });
        expect(store.applyHook(hook('UserPromptSubmit', { prompt_id: 'p1' }), T0 + 1)?.changed).toBe(true);
        expect(store.applyHook(hook('PostToolUse'), T0 + 2)?.changed).toBe(false);
        expect(store.applyHook(hook('Stop'), T0 + 3)?.changed).toBe(true);
    });

    it('fuses with the screen and falls back once the claude process is gone', () => {
        let alive = true;
        const store = new TerminalAgentHookStore(() => alive);
        store.applyHook(hook('UserPromptSubmit'), T0);
        expect(store.fuse('term1', claudeIdle, T0 + 1)).toEqual({ agentKind: 'claude', agentState: 'working', source: 'hook' });
        alive = false;
        expect(store.fuse('term1', claudeIdle, T0 + 2)).toEqual({ ...claudeIdle, source: 'screen' });
        expect(store.has('term1')).toBe(false);
    });

    it('SessionEnd removes the record; other terminals are untouched', () => {
        const store = new TerminalAgentHookStore(() => true);
        store.applyHook(hook('UserPromptSubmit'), T0);
        store.applyHook(hook('UserPromptSubmit', { terminalId: 'term2' }), T0);
        store.applyHook(hook('SessionEnd'), T0 + 1);
        expect(store.has('term1')).toBe(false);
        expect(store.fuse('term2', claudeIdle, T0 + 2).agentState).toBe('working');
    });

    it('Esc during a confirmed turn + idle screen → synthesized done', () => {
        const store = new TerminalAgentHookStore(() => true);
        store.applyHook(hook('UserPromptSubmit', { prompt_id: 'p1' }), T0);
        expect(store.noteInput('term1', 'x', T0 + 1)).toBe(false);
        expect(store.noteInput('term1', '\x1b', T0 + 1)).toBe(true);
        expect(store.checkInterrupt('term1', { agentKind: 'claude', agentState: 'working' }, T0 + 600)).toBe('wait');
        expect(store.checkInterrupt('term1', claudeIdle, T0 + 2000)).toBe('synthesized');
        expect(store.fuse('term1', claudeIdle, T0 + 2001).agentState).toBe('idle');
        expect(store.checkInterrupt('term1', claudeIdle, T0 + 3000)).toBe('none');
    });

    it('a hook that lands after the keypress cancels the inference', () => {
        const store = new TerminalAgentHookStore(() => true);
        store.applyHook(hook('UserPromptSubmit', { prompt_id: 'p1' }), T0);
        store.noteInput('term1', '\x03', T0 + 1);
        store.applyHook(hook('UserPromptSubmit', { prompt_id: 'p2' }), T0 + 100);
        expect(store.checkInterrupt('term1', claudeIdle, T0 + 600)).toBe('none');
        expect(store.fuse('term1', claudeIdle, T0 + 601).agentState).toBe('working');
    });

    it('no inference for a turn this daemon never saw start', () => {
        const store = new TerminalAgentHookStore(() => true);
        store.applyHook(hook('PostToolUse'), T0);
        expect(store.noteInput('term1', '\x1b', T0 + 1)).toBe(false);
        expect(store.fuse('term1', claudeIdle, T0 + 2).agentState).toBe('working');
    });

    it('forget / prune drop records and pending checks', () => {
        const store = new TerminalAgentHookStore(() => true);
        store.applyHook(hook('UserPromptSubmit'), T0);
        store.applyHook(hook('UserPromptSubmit', { terminalId: 'term2' }), T0);
        store.noteInput('term2', '\x1b', T0 + 1);
        store.prune(['term1']);
        expect(store.has('term2')).toBe(false);
        expect(store.checkInterrupt('term2', claudeIdle, T0 + 600)).toBe('none');
        store.forget('term1');
        expect(store.has('term1')).toBe(false);
    });
});
