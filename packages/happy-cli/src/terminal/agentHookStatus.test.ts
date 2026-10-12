import { describe, expect, it } from 'vitest';
import { TerminalNotifyTracker } from './terminalNotify';
import {
    HOOK_WORKING_STALE_MS,
    armsInterruptCheck,
    INTERRUPT_CONFIRM_WINDOW_MS,
    INTERRUPT_CHECK_DELAYS_MS,
    buildTerminalHookSettings,
    decideInterrupt,
    fuseAgentState,
    injectClaudeSettingsFlag,
    isInterruptInput,
    parseTerminalAgentHook,
    pendingInterruptFor,
    reduceHookRecord,
    synthesizeInterruptDone,
    terminalHookCommand,
    terminalHookEventPlan,
    type TerminalAgentHookEvent,
    type TerminalHookRecord,
} from './agentHookStatus';

const T0 = 1_000_000;

function ev(event: TerminalAgentHookEvent['event'], extra: Partial<TerminalAgentHookEvent> = {}): TerminalAgentHookEvent {
    return { event, terminalId: 'term1', claudeSessionId: 'sess-a', ...extra };
}

function run(events: Array<[TerminalAgentHookEvent, number]>, start?: TerminalHookRecord): TerminalHookRecord | undefined {
    let record = start;
    for (const [e, at] of events) record = reduceHookRecord(record, e, at).record;
    return record;
}

describe('terminalHookEventPlan (B-547)', () => {
    it('does not inject for an unknown or too-old claude', () => {
        expect(terminalHookEventPlan(null)).toBeNull();
        expect(terminalHookEventPlan(undefined)).toBeNull();
        expect(terminalHookEventPlan('garbage')).toBeNull();
        expect(terminalHookEventPlan('1.0.99')).toBeNull();
    });

    it('adds events only from the version that knows them', () => {
        expect(terminalHookEventPlan('2.0.0')).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'PostToolUse', 'SessionEnd']);
        expect(terminalHookEventPlan('2.0.45')).toContain('PermissionRequest');
        expect(terminalHookEventPlan('2.0.44')).not.toContain('PermissionRequest');
        expect(terminalHookEventPlan('2.1.75')).not.toContain('PostCompact');
        expect(terminalHookEventPlan('2.1.76')).toContain('PostCompact');
        expect(terminalHookEventPlan('2.1.77')).not.toContain('StopFailure');
        // The repo-locked Claude Code (agent-sdk 0.3.296 → 2.1.296) gets the full set.
        expect(terminalHookEventPlan('2.1.296')).toEqual([
            'SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'PostToolUse', 'SessionEnd',
            'PermissionRequest', 'PostCompact', 'StopFailure',
        ]);
    });
});

describe('hook command + settings file (B-547)', () => {
    const forwarderPath = '/opt/vh/scripts/terminal_status_forwarder.cjs';

    it('guards the script, passes the terminal, home and claude pid', () => {
        expect(terminalHookCommand({ forwarderPath, terminalId: 't_1-A', happyHome: '/home/u/.happy' })).toBe(
            `[ -f '${forwarderPath}' ] && node '${forwarderPath}' 't_1-A' '/home/u/.happy' "$PPID" || true`,
        );
    });

    it('refuses anything that would need shell escaping', () => {
        expect(terminalHookCommand({ forwarderPath: "/o'pt/x.cjs", terminalId: 't1', happyHome: '/h' })).toBeNull();
        expect(terminalHookCommand({ forwarderPath, terminalId: 't1', happyHome: '/h/$(x)' })).toBeNull();
        expect(terminalHookCommand({ forwarderPath, terminalId: 'a b', happyHome: '/h' })).toBeNull();
    });

    it('writes only the planned events, with a timeout, matchers only on tool events', () => {
        const settings = buildTerminalHookSettings(['Stop', 'PostToolUse'], 'CMD');
        expect(Object.keys(settings)).toEqual(['hooks']);
        expect(settings.hooks).toEqual({
            Stop: [{ hooks: [{ type: 'command', command: 'CMD', timeout: 10 }] }],
            PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'CMD', timeout: 10 }] }],
        });
    });
});

describe('injectClaudeSettingsFlag (B-547)', () => {
    const path = '/home/u/.happy/tmp/terminal-hooks/t1.json';

    it('rewrites a bare claude command, keeping its arguments', () => {
        expect(injectClaudeSettingsFlag('claude', path)).toBe(`claude --settings '${path}'`);
        expect(injectClaudeSettingsFlag('claude --resume 0b5c7c0e-1111-2222-3333-444455556666', path))
            .toBe(`claude --settings '${path}' --resume 0b5c7c0e-1111-2222-3333-444455556666`);
        expect(injectClaudeSettingsFlag('  claude --dangerously-skip-permissions', path))
            .toBe(`  claude --settings '${path}' --dangerously-skip-permissions`);
    });

    it('leaves everything else alone', () => {
        for (const cmd of ['cd x && claude', 'claudex', 'pi', 'npx claude', 'echo claude', 'claude --settings /mine.json', 'claude --settings=/mine.json']) {
            expect(injectClaudeSettingsFlag(cmd, path)).toBe(cmd);
        }
        expect(injectClaudeSettingsFlag('claude', "/we'ird/path.json")).toBe('claude');
    });
});

describe('parseTerminalAgentHook (B-547)', () => {
    it('accepts the forwarder payload and keeps only typed fields', () => {
        expect(parseTerminalAgentHook({
            hook_event_name: 'UserPromptSubmit', session_id: 's1', terminalId: 't1', claudePid: 4242,
            prompt_id: 'p-1', transcript_path: '/x/s1.jsonl', extra: { big: true },
        })).toEqual({ event: 'UserPromptSubmit', terminalId: 't1', claudeSessionId: 's1', claudePid: 4242, turnId: 'p-1', transcriptPath: '/x/s1.jsonl' });
        expect(parseTerminalAgentHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', terminalId: 't1', promptHash: 'abcd' })?.turnId).toBe('abcd');
    });

    it('drops unknown events and unattributable payloads', () => {
        expect(parseTerminalAgentHook(null)).toBeNull();
        expect(parseTerminalAgentHook([])).toBeNull();
        expect(parseTerminalAgentHook({ hook_event_name: 'PreToolUse', session_id: 's1', terminalId: 't1' })).toBeNull();
        expect(parseTerminalAgentHook({ hook_event_name: 'Stop', terminalId: 't1' })).toBeNull();
        expect(parseTerminalAgentHook({ hook_event_name: 'Stop', session_id: 's1' })).toBeNull();
        expect(parseTerminalAgentHook({ hook_event_name: 'Stop', session_id: 's1', terminalId: '../x' })).toBeNull();
        expect(parseTerminalAgentHook({ hook_event_name: 'Stop', session_id: 's1', terminalId: 't1', claudePid: 1 })?.claudePid).toBeUndefined();
    });
});

describe('reduceHookRecord (B-547)', () => {
    it('walks a normal turn: start → prompt → permission → tool → stop', () => {
        let r = run([[ev('SessionStart', { claudePid: 77, source: 'startup' }), T0]]);
        expect(r).toMatchObject({ phase: 'done', claudePid: 77, confirmedTurn: false });
        r = run([[ev('UserPromptSubmit', { turnId: 'p1' }), T0 + 1]], r);
        expect(r).toMatchObject({ phase: 'working', confirmedTurn: true, turnId: 'p1', phaseStartedAt: T0 + 1 });
        const workingSeq = r!.seq;
        r = run([[ev('PostToolUse'), T0 + 2]], r);
        expect(r).toMatchObject({ phase: 'working', seq: workingSeq, updatedAt: T0 + 2, phaseStartedAt: T0 + 1 });
        r = run([[ev('PermissionRequest'), T0 + 3]], r);
        expect(r?.phase).toBe('needs_input');
        r = run([[ev('PostToolUse'), T0 + 4]], r);
        expect(r?.phase).toBe('working');
        r = run([[ev('Stop'), T0 + 5]], r);
        expect(r?.phase).toBe('done');
        expect(reduceHookRecord(r, ev('SessionEnd'), T0 + 6)).toEqual({ record: undefined, changed: true });
    });

    it('maps notifications by type; idle prompts only renew', () => {
        const working = run([[ev('UserPromptSubmit'), T0]])!;
        expect(reduceHookRecord(working, ev('Notification', { notificationType: 'permission_prompt' }), T0 + 1).record?.phase).toBe('needs_input');
        expect(reduceHookRecord(working, ev('Notification', { notificationType: 'elicitation_dialog' }), T0 + 1).record?.phase).toBe('needs_input');
        expect(reduceHookRecord(working, ev('Notification', { permissionHint: true }), T0 + 1).record?.phase).toBe('needs_input');
        const other = reduceHookRecord(working, ev('Notification', { notificationType: 'auth_success' }), T0 + 1);
        expect(other).toMatchObject({ changed: false, record: { phase: 'working', updatedAt: T0 + 1 } });
    });

    it('idle_prompt (Claude idle at its prompt, no dialog, no loading) settles to done', () => {
        const working = run([[ev('UserPromptSubmit'), T0]])!;
        expect(reduceHookRecord(working, ev('Notification', { notificationType: 'idle_prompt' }), T0 + 60_000))
            .toMatchObject({ changed: true, record: { phase: 'done' } });
        const asking = reduceHookRecord(working, ev('PermissionRequest'), T0 + 1).record!;
        expect(reduceHookRecord(asking, ev('Notification', { notificationType: 'idle_prompt' }), T0 + 60_000).record?.phase).toBe('done');
        const done = reduceHookRecord(working, ev('Stop'), T0 + 2).record!;
        expect(reduceHookRecord(done, ev('Notification', { notificationType: 'idle_prompt' }), T0 + 60_000))
            .toMatchObject({ changed: false, record: { phase: 'done', seq: done.seq } });
    });

    it('ignores a subagent Stop and an auto compaction', () => {
        const working = run([[ev('UserPromptSubmit'), T0]])!;
        expect(reduceHookRecord(working, ev('Stop', { agentId: 'sub-1' }), T0 + 1).record?.phase).toBe('working');
        expect(reduceHookRecord(working, ev('PostCompact', { trigger: 'auto' }), T0 + 1).record?.phase).toBe('working');
        expect(reduceHookRecord(working, ev('PostCompact', { trigger: 'manual' }), T0 + 1).record?.phase).toBe('done');
        expect(reduceHookRecord(working, ev('StopFailure'), T0 + 1).record?.phase).toBe('done');
    });

    it('ignores late events from a superseded claude session; SessionStart replaces it', () => {
        const working = run([[ev('UserPromptSubmit'), T0]])!;
        expect(reduceHookRecord(working, ev('Stop', { claudeSessionId: 'old' }), T0 + 1)).toEqual({ record: working, changed: false });
        const cleared = reduceHookRecord(working, ev('SessionStart', { claudeSessionId: 'sess-b', source: 'clear' }), T0 + 2).record;
        expect(cleared).toMatchObject({ claudeSessionId: 'sess-b', phase: 'done', confirmedTurn: false });
        expect(cleared!.seq).toBeGreaterThan(working.seq);
    });

    it('an event without a record starts an UNCONFIRMED one (daemon restarted mid-turn)', () => {
        const r = reduceHookRecord(undefined, ev('PostToolUse', { claudePid: 9 }), T0);
        expect(r).toMatchObject({ changed: true, record: { phase: 'working', confirmedTurn: false, claudePid: 9 } });
        expect(pendingInterruptFor(r.record, T0)).toBeNull();
    });
});

describe('fuseAgentState (B-547)', () => {
    const rec = (phase: TerminalHookRecord['phase'], updatedAt = T0): TerminalHookRecord => ({
        claudeSessionId: 's', phase, seq: 1, phaseStartedAt: updatedAt, updatedAt, confirmedTurn: true,
    });
    const claude = (agentState?: 'working' | 'needs_input' | 'idle') => ({ agentKind: 'claude' as const, agentState });

    it('without a record the screen decides, unchanged', () => {
        expect(fuseAgentState(claude('idle'), undefined, T0)).toEqual({ agentKind: 'claude', agentState: 'idle', source: 'screen' });
        expect(fuseAgentState(undefined, undefined, T0)).toEqual({ source: 'screen' });
    });

    it('a shell or another agent on screen always wins', () => {
        expect(fuseAgentState({ agentState: 'shell' }, rec('working'), T0).source).toBe('screen');
        expect(fuseAgentState({ agentKind: 'codex', agentState: 'idle' }, rec('working'), T0).source).toBe('screen');
    });

    it('hook working is not downgraded by a screen that cannot see the spinner', () => {
        expect(fuseAgentState(claude('idle'), rec('working'), T0 + 1)).toEqual({ agentKind: 'claude', agentState: 'working', source: 'hook' });
        expect(fuseAgentState(claude(), rec('working'), T0 + 1).agentState).toBe('working');
        expect(fuseAgentState(undefined, rec('working'), T0 + 1).agentState).toBe('working');
    });

    it('a stale hook working / needs_input yields to the screen entirely (incl. no state)', () => {
        const later = T0 + HOOK_WORKING_STALE_MS + 1;
        expect(fuseAgentState(claude('idle'), rec('working'), later)).toEqual({ agentKind: 'claude', agentState: 'idle', source: 'screen' });
        expect(fuseAgentState(claude(), rec('working'), later)).toEqual({ agentKind: 'claude', agentState: undefined, source: 'screen' });
        expect(fuseAgentState(undefined, rec('working'), later)).toEqual({ source: 'screen' });
        expect(fuseAgentState(claude(), rec('needs_input'), later).source).toBe('screen');
        // Fresh: still the hook.
        expect(fuseAgentState(claude(), rec('working'), T0 + 1)).toEqual({ agentKind: 'claude', agentState: 'working', source: 'hook' });
    });

    it('positive screen evidence is taken as the SCREEN\'s verdict (keeps its debounce)', () => {
        expect(fuseAgentState(claude('needs_input'), rec('working'), T0)).toEqual({ agentKind: 'claude', agentState: 'needs_input', source: 'screen' });
        expect(fuseAgentState(claude('working'), rec('needs_input'), T0)).toEqual({ agentKind: 'claude', agentState: 'working', source: 'screen' });
        expect(fuseAgentState(claude('working'), rec('done'), T0)).toEqual({ agentKind: 'claude', agentState: 'working', source: 'screen' });
        expect(fuseAgentState(claude('needs_input'), rec('done'), T0)).toEqual({ agentKind: 'claude', agentState: 'needs_input', source: 'screen' });
    });

    it('regression: a done record + one misread needs_input frame does not notify immediately', () => {
        const tracker = new TerminalNotifyTracker();
        const observe = (screen: ReturnType<typeof claude>, record: TerminalHookRecord, at: number) => {
            const f = fuseAgentState(screen, record, at);
            return tracker.observe('t', f.agentState, at, f.agentKind, { authoritative: f.source === 'hook' });
        };
        // Armed: the hook says the turn is running.
        expect(observe(claude('idle'), rec('working', T0), T0)).toBeNull();
        // The turn ended (hook done) but one frame misreads as a dialog:
        // screen-sourced → needs a second sighting, no permission push now.
        expect(observe(claude('needs_input'), rec('done', T0 + 500), T0 + 1_000)).toBeNull();
    });

    it('hook needs_input holds even on an idle-looking screen (mode line under a dialog) until stale', () => {
        expect(fuseAgentState(claude(), rec('needs_input'), T0).agentState).toBe('needs_input');
        expect(fuseAgentState(undefined, rec('needs_input'), T0).agentState).toBe('needs_input');
        expect(fuseAgentState(claude('idle'), rec('needs_input'), T0 + 1).agentState).toBe('needs_input');
        expect(fuseAgentState(claude('idle'), rec('needs_input'), T0 + HOOK_WORKING_STALE_MS + 1).agentState).toBe('idle');
    });

    it('hook done reads as idle even when the screen is unrecognizable', () => {
        expect(fuseAgentState(claude(), rec('done'), T0)).toEqual({ agentKind: 'claude', agentState: 'idle', source: 'hook' });
    });
});

describe('interrupt inference (B-547, Orca rule)', () => {
    const turn = run([[ev('UserPromptSubmit', { turnId: 'p1' }), T0]])!;
    const idleScreen = { agentKind: 'claude' as const, agentState: 'idle' as const };

    it('recognizes only a bare Esc press or Ctrl+C', () => {
        expect(isInterruptInput('\x1b')).toBe(true);
        expect(isInterruptInput('\x03')).toBe(true);
        expect(isInterruptInput('\x1b[27u')).toBe(true);
        expect(isInterruptInput('\x1b[27;1:3u')).toBe(false); // kitty release
        expect(isInterruptInput('\x1b[A')).toBe(false);
        expect(isInterruptInput('\x1b\x1b')).toBe(false);
        expect(isInterruptInput('q')).toBe(false);
    });

    it('Enter arms a check only while a dialog is up', () => {
        expect(armsInterruptCheck('\r', 'needs_input')).toBe(true);
        expect(armsInterruptCheck('\x1b', 'needs_input')).toBe(true);
        expect(armsInterruptCheck('\r', 'working')).toBe(false);
        expect(armsInterruptCheck('\x03', 'working')).toBe(true);
        expect(armsInterruptCheck('\x1b', 'done')).toBe(false);
        expect(armsInterruptCheck('y', 'needs_input')).toBe(false);
    });

    it('arms only on a confirmed working / needs_input turn', () => {
        expect(pendingInterruptFor(undefined, T0)).toBeNull();
        expect(pendingInterruptFor({ ...turn, phase: 'done' }, T0)).toBeNull();
        expect(pendingInterruptFor({ ...turn, confirmedTurn: false }, T0)).toBeNull();
        expect(pendingInterruptFor(turn, T0 + 5)).toEqual({ claudeSessionId: 'sess-a', seq: turn.seq, phaseStartedAt: T0, turnId: 'p1', at: T0 + 5 });
    });

    it('synthesizes done when baseline, freshness and an idle screen all agree', () => {
        const pending = pendingInterruptFor(turn, T0 + 10)!;
        expect(decideInterrupt(turn, pending, idleScreen, T0 + 700)).toBe('synthesize');
        const done = synthesizeInterruptDone(turn, T0 + 700);
        expect(done).toMatchObject({ phase: 'done', interrupted: true, seq: turn.seq + 1 });
        expect(fuseAgentState(idleScreen, done, T0 + 700).agentState).toBe('idle');
    });

    it('waits while the screen still shows work or a dialog, or is unrecognizable', () => {
        const pending = pendingInterruptFor(turn, T0 + 10)!;
        expect(decideInterrupt(turn, pending, { agentKind: 'claude', agentState: 'working' }, T0 + 700)).toBe('wait');
        expect(decideInterrupt(turn, pending, { agentKind: 'claude', agentState: 'needs_input' }, T0 + 700)).toBe('wait');
        expect(decideInterrupt(turn, pending, { agentKind: 'claude' }, T0 + 700)).toBe('wait');
        expect(decideInterrupt(turn, pending, undefined, T0 + 700)).toBe('wait');
    });

    it('drops on any baseline change, staleness, an expired window or an unconfirmed turn', () => {
        const pending = pendingInterruptFor(turn, T0 + 10)!;
        const next = reduceHookRecord(turn, ev('UserPromptSubmit', { turnId: 'p2' }), T0 + 20).record!;
        expect(decideInterrupt(next, pending, idleScreen, T0 + 700)).toBe('drop');
        expect(decideInterrupt({ ...turn, seq: turn.seq + 1 }, pending, idleScreen, T0 + 700)).toBe('drop');
        expect(decideInterrupt({ ...turn, phaseStartedAt: T0 + 1 }, pending, idleScreen, T0 + 700)).toBe('drop');
        expect(decideInterrupt({ ...turn, turnId: 'other' }, pending, idleScreen, T0 + 700)).toBe('drop');
        expect(decideInterrupt({ ...turn, claudeSessionId: 'sess-b' }, pending, idleScreen, T0 + 700)).toBe('drop');
        expect(decideInterrupt({ ...turn, phase: 'done' }, pending, idleScreen, T0 + 700)).toBe('drop');
        expect(decideInterrupt({ ...turn, confirmedTurn: false }, pending, idleScreen, T0 + 700)).toBe('drop');
        expect(decideInterrupt(undefined, pending, idleScreen, T0 + 700)).toBe('drop');
        expect(decideInterrupt(turn, pending, idleScreen, T0 + 10 + INTERRUPT_CONFIRM_WINDOW_MS + 1)).toBe('drop');
        expect(decideInterrupt(turn, { ...pending, at: T0 + HOOK_WORKING_STALE_MS + 10 }, idleScreen, T0 + HOOK_WORKING_STALE_MS + 20)).toBe('drop');
    });

    it('the third re-check (5 s after the key, timer a bit late) can still synthesize', () => {
        const pending = pendingInterruptFor(turn, T0 + 10)!;
        const working = { agentKind: 'claude' as const, agentState: 'working' as const };
        const delays = INTERRUPT_CHECK_DELAYS_MS;
        expect(decideInterrupt(turn, pending, working, pending.at + delays[0])).toBe('wait');
        expect(decideInterrupt(turn, pending, working, pending.at + delays[1])).toBe('wait');
        expect(decideInterrupt(turn, pending, idleScreen, pending.at + delays[2] + 200)).toBe('synthesize');
        expect(INTERRUPT_CONFIRM_WINDOW_MS).toBeGreaterThan(delays[delays.length - 1]);
    });

    it('a renewal (PostToolUse) does not break the baseline', () => {
        const pending = pendingInterruptFor(turn, T0 + 10)!;
        const renewed = reduceHookRecord(turn, ev('PostToolUse'), T0 + 20).record!;
        expect(decideInterrupt(renewed, pending, idleScreen, T0 + 700)).toBe('synthesize');
    });
});
