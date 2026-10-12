/**
 * B-547: hook-driven Claude status for web terminals — pure logic, no I/O.
 *
 * A `claude` command the DAEMON types into a vh tmux terminal (startup
 * command, resume, auto-restore, restore-closed) gets `--settings <file>`
 * with managed hooks; scripts/terminal_status_forwarder.cjs posts each hook
 * to the daemon, and this module turns those events into a per-terminal
 * record that is FUSED with the existing screen classifier (agentStatus.ts).
 * The screen classifier stays the fallback: no record, a dead record, or a
 * hook plan that lacks an event all degrade to today's behaviour.
 *
 * Spec: specs/2026-10-terminal-hook-status.md.
 */

import type { AgentObservation, AgentState } from './agentStatus';

// ── Version → event plan ─────────────────────────────────────────────────────

/** Below this (or unresolved) nothing is injected — screen scraping only. */
export const MIN_HOOK_CLAUDE_VERSION = '2.0.0';

/**
 * First Claude Code release whose settings schema knows each event. Claude
 * 1.0.23–2.1.100 discard the WHOLE settings file on one unknown event name
 * (Orca pins this against each release's packed enum), so an event is only
 * written for a Claude that knows it. All of these are in the locked
 * agent-sdk 0.3.296 / Claude Code 2.1.296 `HOOK_EVENTS`.
 */
const EVENT_FIRST_VERSIONS: ReadonlyArray<readonly [TerminalHookEventName, string]> = [
    ['SessionStart', '2.0.0'],
    ['UserPromptSubmit', '2.0.0'],
    ['Stop', '2.0.0'],
    ['Notification', '2.0.0'],
    ['PostToolUse', '2.0.0'],
    ['SessionEnd', '2.0.0'],
    ['PermissionRequest', '2.0.45'],
    ['PostCompact', '2.1.76'],
    ['StopFailure', '2.1.78'],
];

export type TerminalHookEventName =
    | 'SessionStart'
    | 'UserPromptSubmit'
    | 'Stop'
    | 'StopFailure'
    | 'Notification'
    | 'PermissionRequest'
    | 'PostToolUse'
    | 'PostCompact'
    | 'SessionEnd';

const KNOWN_EVENTS = new Set<string>(EVENT_FIRST_VERSIONS.map(([name]) => name));

/** Events whose matcher field selects a tool name. */
const TOOL_MATCHER_EVENTS = new Set<TerminalHookEventName>(['PostToolUse', 'PermissionRequest']);

function parseVersion(v: string | null | undefined): [number, number, number] | null {
    const m = typeof v === 'string' ? v.trim().match(/^(\d+)\.(\d+)\.(\d+)$/) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(version: string | null | undefined, floor: string): boolean {
    const a = parseVersion(version);
    const b = parseVersion(floor);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return true;
}

/** Events to install for a resolved Claude version; null = do not inject. */
export function terminalHookEventPlan(claudeVersion: string | null | undefined): TerminalHookEventName[] | null {
    if (!versionAtLeast(claudeVersion, MIN_HOOK_CLAUDE_VERSION)) return null;
    return EVENT_FIRST_VERSIONS.filter(([, first]) => versionAtLeast(claudeVersion, first)).map(([name]) => name);
}

// ── Settings file + command injection ───────────────────────────────────────

/** Per-hook timeout in seconds (B-137: SessionStart defaults to 600 s). */
export const TERMINAL_HOOK_TIMEOUT_SECONDS = 10;

/** Characters that are inert inside single quotes in sh/bash/zsh/fish. */
const SAFE_PATH_RE = /^[A-Za-z0-9_./@:+ -]+$/;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The hook command, identical for every event. `[ -f … ] && … || true`
 * keeps a removed/moved CLI silent (B-137); `"$PPID"` inside Claude's
 * `sh -c` is the claude process itself (verified on 2.1.296), which the
 * daemon uses to tell a live record from a dead one. Null when a path or id
 * would need escaping.
 */
export function terminalHookCommand(opts: { forwarderPath: string; terminalId: string; happyHome: string }): string | null {
    const { forwarderPath, terminalId, happyHome } = opts;
    if (!SAFE_PATH_RE.test(forwarderPath) || !SAFE_PATH_RE.test(happyHome) || !SAFE_ID_RE.test(terminalId)) return null;
    return `[ -f '${forwarderPath}' ] && node '${forwarderPath}' '${terminalId}' '${happyHome}' "$PPID" || true`;
}

/** The `--settings` file body: only the planned events, nothing else. */
export function buildTerminalHookSettings(events: readonly TerminalHookEventName[], command: string): { hooks: Record<string, unknown[]> } {
    const hooks: Record<string, unknown[]> = {};
    for (const event of events) {
        const entry = { type: 'command', command, timeout: TERMINAL_HOOK_TIMEOUT_SECONDS };
        hooks[event] = [TOOL_MATCHER_EVENTS.has(event) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] }];
    }
    return { hooks };
}

/**
 * Add `--settings '<path>'` to a daemon-typed command when — and only when —
 * its first token is exactly `claude` and it does not already pass
 * `--settings`. Anything else (`cd x && claude`, an alias, `pi`, a user's own
 * `--settings`) is returned unchanged and simply keeps screen scraping.
 */
export function injectClaudeSettingsFlag(command: string, settingsPath: string): string {
    if (!SAFE_PATH_RE.test(settingsPath) || !isInjectableClaudeCommand(command)) return command;
    const m = command.match(/^(\s*)claude/)!;
    return `${m[1]}claude --settings '${settingsPath}'${command.slice(m[0].length)}`;
}

/** First token exactly `claude`, and no `--settings` of its own. */
export function isInjectableClaudeCommand(command: string): boolean {
    return /^\s*claude(?=\s|$)/.test(command) && !/(^|\s)--settings(=|\s|$)/.test(command);
}

// ── Hook events ──────────────────────────────────────────────────────────────

export interface TerminalAgentHookEvent {
    event: TerminalHookEventName;
    terminalId: string;
    claudeSessionId: string;
    claudePid?: number;
    /** `prompt_id` or the forwarder's prompt hash (UserPromptSubmit). */
    turnId?: string;
    /** Present ⇒ the hook fired inside a subagent. */
    agentId?: string;
    notificationType?: string;
    /** Notification fallback when an older Claude omits the type. */
    permissionHint?: boolean;
    trigger?: string;
    source?: string;
    transcriptPath?: string;
}

const str = (v: unknown, max = 256): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

/** Parse a forwarded payload; null for anything we cannot attribute. */
export function parseTerminalAgentHook(body: unknown): TerminalAgentHookEvent | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const raw = body as Record<string, unknown>;
    const event = raw.hook_event_name;
    if (typeof event !== 'string' || !KNOWN_EVENTS.has(event)) return null;
    const terminalId = str(raw.terminalId, 64);
    if (!terminalId || !SAFE_ID_RE.test(terminalId)) return null;
    const claudeSessionId = str(raw.session_id, 128);
    if (!claudeSessionId) return null;
    const pid = typeof raw.claudePid === 'number' ? raw.claudePid
        : typeof raw.claudePid === 'string' && /^\d{1,10}$/.test(raw.claudePid) ? Number(raw.claudePid) : undefined;
    const turnId = str(raw.prompt_id, 128) ?? str(raw.promptHash, 64);
    return {
        event: event as TerminalHookEventName,
        terminalId,
        claudeSessionId,
        ...(pid !== undefined && Number.isInteger(pid) && pid > 1 ? { claudePid: pid } : {}),
        ...(turnId ? { turnId } : {}),
        ...(str(raw.agent_id, 128) ? { agentId: str(raw.agent_id, 128) } : {}),
        ...(str(raw.notification_type, 64) ? { notificationType: str(raw.notification_type, 64) } : {}),
        ...(raw.permissionHint === true ? { permissionHint: true } : {}),
        ...(str(raw.trigger, 32) ? { trigger: str(raw.trigger, 32) } : {}),
        ...(str(raw.source, 32) ? { source: str(raw.source, 32) } : {}),
        ...(str(raw.transcript_path, 4096) ? { transcriptPath: str(raw.transcript_path, 4096) } : {}),
    };
}

// ── Record reducer ───────────────────────────────────────────────────────────

export type HookPhase = 'working' | 'needs_input' | 'done';

export interface TerminalHookRecord {
    claudeSessionId: string;
    claudePid?: number;
    phase: HookPhase;
    /** Bumped on every phase-relevant event; the interrupt baseline. */
    seq: number;
    phaseStartedAt: number;
    /** Last accepted hook receipt (any event, including renewals). */
    updatedAt: number;
    turnId?: string;
    /** A UserPromptSubmit was seen for this turn in THIS daemon runtime. */
    confirmedTurn: boolean;
    interrupted?: boolean;
    transcriptPath?: string;
}

const NEEDS_INPUT_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

function phaseTo(prev: TerminalHookRecord, phase: HookPhase, now: number, extra: Partial<TerminalHookRecord> = {}): TerminalHookRecord {
    const { interrupted: _drop, ...rest } = prev;
    return { ...rest, phase, seq: prev.seq + 1, phaseStartedAt: now, updatedAt: now, ...extra };
}

/**
 * Apply one hook event. Returns the next record (undefined = delete) and
 * whether anything list-relevant changed. Events from a different Claude
 * session than the record's are late arrivals of a previous process and are
 * ignored (SessionStart is the only event that may replace the session).
 */
export function reduceHookRecord(
    prev: TerminalHookRecord | undefined,
    ev: TerminalAgentHookEvent,
    now: number,
): { record: TerminalHookRecord | undefined; changed: boolean } {
    if (ev.event === 'SessionStart') {
        if (prev && prev.claudeSessionId === ev.claudeSessionId && ev.source !== 'clear' && ev.source !== 'compact') {
            return { record: { ...prev, updatedAt: now, ...(ev.claudePid ? { claudePid: ev.claudePid } : {}) }, changed: false };
        }
        return {
            record: {
                claudeSessionId: ev.claudeSessionId,
                ...(ev.claudePid ? { claudePid: ev.claudePid } : prev?.claudePid ? { claudePid: prev.claudePid } : {}),
                phase: 'done',
                seq: (prev?.seq ?? 0) + 1,
                phaseStartedAt: now,
                updatedAt: now,
                confirmedTurn: false,
                ...(ev.transcriptPath ? { transcriptPath: ev.transcriptPath } : {}),
            },
            changed: prev?.phase !== 'done',
        };
    }
    // Any other event without a record: start one from this evidence (the
    // daemon restarted mid-session). It is NOT a confirmed turn, so it can
    // never back an inferred interrupt.
    if (prev && prev.claudeSessionId !== ev.claudeSessionId) return { record: prev, changed: false };
    const base: TerminalHookRecord = prev ?? {
        claudeSessionId: ev.claudeSessionId,
        ...(ev.claudePid ? { claudePid: ev.claudePid } : {}),
        phase: 'done',
        seq: 0,
        phaseStartedAt: now,
        updatedAt: now,
        confirmedTurn: false,
    };
    const withPid = ev.claudePid && !base.claudePid ? { ...base, claudePid: ev.claudePid } : base;
    const fresh = !prev;
    const renew = (): { record: TerminalHookRecord; changed: boolean } => ({ record: { ...withPid, updatedAt: now }, changed: fresh });

    switch (ev.event) {
        case 'SessionEnd':
            return { record: undefined, changed: !!prev };
        case 'UserPromptSubmit':
            return { record: phaseTo(withPid, 'working', now, { confirmedTurn: true, turnId: ev.turnId }), changed: true };
        case 'PostToolUse':
            if (withPid.phase === 'working') return renew();
            return { record: phaseTo(withPid, 'working', now), changed: true };
        case 'PermissionRequest':
            return { record: phaseTo(withPid, 'needs_input', now), changed: withPid.phase !== 'needs_input' || fresh };
        case 'Notification': {
            const needsInput = ev.notificationType ? NEEDS_INPUT_NOTIFICATIONS.has(ev.notificationType) : ev.permissionHint === true;
            if (!needsInput) return renew();
            return { record: phaseTo(withPid, 'needs_input', now), changed: withPid.phase !== 'needs_input' || fresh };
        }
        case 'Stop':
        case 'StopFailure':
            if (ev.agentId) return renew(); // a subagent's stop is not the lead turn's
            return { record: phaseTo(withPid, 'done', now), changed: withPid.phase !== 'done' || fresh };
        case 'PostCompact':
            if (ev.trigger !== 'manual') return renew();
            return { record: phaseTo(withPid, 'done', now), changed: withPid.phase !== 'done' || fresh };
        default:
            return renew();
    }
}

// ── Fusion with the screen classifier ───────────────────────────────────────

/** A hook-`working` older than this no longer outvotes a confident idle screen. */
export const HOOK_WORKING_STALE_MS = 10 * 60_000;

export interface FusedAgentState extends AgentObservation {
    source: 'hook' | 'screen';
}

/**
 * Combine the screen observation (undefined = probe failed) with a VALID
 * hook record (caller already checked liveness). See the spec's fusion
 * table: hook `working` is never downgraded by a screen that merely cannot
 * see the spinner, but positive screen evidence (spinner, dialog, shell,
 * another agent) is always taken.
 */
export function fuseAgentState(
    screen: AgentObservation | undefined,
    record: TerminalHookRecord | undefined,
    now: number,
): FusedAgentState {
    const screenOnly: FusedAgentState = { ...(screen ?? {}), source: 'screen' };
    if (!record) return screenOnly;
    const s = screen?.agentState;
    if (s === 'shell') return screenOnly;
    if (screen?.agentKind && screen.agentKind !== 'claude') return screenOnly;
    const hook = (agentState: AgentState): FusedAgentState => ({ agentKind: 'claude', agentState, source: 'hook' });
    if (s === 'needs_input') return hook('needs_input');
    if (s === 'working') return hook('working');
    switch (record.phase) {
        case 'working':
            if (s === 'idle' && now - record.updatedAt > HOOK_WORKING_STALE_MS) return hook('idle');
            return hook('working');
        case 'needs_input':
            // Not cleared by an idle-looking screen: Claude's mode line
            // (`⏵⏵ …`, `bypass permissions on`) can stay visible under an
            // unrecognized dialog. A keypress-armed check, a later hook or
            // staleness clears it.
            if (s === 'idle' && now - record.updatedAt > HOOK_WORKING_STALE_MS) return hook('idle');
            return hook('needs_input');
        case 'done':
            return hook('idle');
    }
}

// ── Interrupt inference (Esc / Ctrl+C never fire Stop) ──────────────────────

/** Window in which the screen must confirm the interrupt. */
export const INTERRUPT_CONFIRM_WINDOW_MS = 5_000;
/** When to re-probe after the keypress (ms after it). */
export const INTERRUPT_CHECK_DELAYS_MS: readonly number[] = [600, 2_000, 5_000];

// eslint-disable-next-line no-control-regex
const KITTY_ESCAPE_PRESS_RE = /^\x1b\[27(?:;1(?::1)?)?u$/;

/** Is this whole input chunk a bare Esc press or a Ctrl+C? */
export function isInterruptInput(text: string): boolean {
    return text === '\x1b' || text === '\x03' || KITTY_ESCAPE_PRESS_RE.test(text);
}

/** Enter — answers a permission/question dialog. "No" (or "tell Claude what
 *  to do instead") ends the turn without a Stop hook, just like Esc. */
export function isDialogAnswerInput(text: string): boolean {
    return text === '\r' || text === '\n' || text === '\r\n';
}

/** Should this keypress arm an inference check for a record in `phase`? */
export function armsInterruptCheck(text: string, phase: HookPhase): boolean {
    if (phase === 'working') return isInterruptInput(text);
    if (phase === 'needs_input') return isInterruptInput(text) || isDialogAnswerInput(text);
    return false;
}

export interface PendingInterrupt {
    claudeSessionId: string;
    seq: number;
    phaseStartedAt: number;
    turnId?: string;
    at: number;
}

/** Baseline captured at keypress time, or null when nothing could be interrupted. */
export function pendingInterruptFor(record: TerminalHookRecord | undefined, now: number): PendingInterrupt | null {
    if (!record || !record.confirmedTurn) return null;
    if (record.phase !== 'working' && record.phase !== 'needs_input') return null;
    return {
        claudeSessionId: record.claudeSessionId,
        seq: record.seq,
        phaseStartedAt: record.phaseStartedAt,
        ...(record.turnId ? { turnId: record.turnId } : {}),
        at: now,
    };
}

/**
 * Orca's rule: synthesize `done` ONLY for a turn confirmed in this runtime,
 * whose baseline is byte-for-byte unchanged, that has not gone stale, and
 * that the screen now shows as an idle Claude prompt. Anything newer (a hook
 * arrived), anything ambiguous (spinner/dialog still up, unknown screen) or
 * anything late keeps the current state.
 */
export function decideInterrupt(
    record: TerminalHookRecord | undefined,
    pending: PendingInterrupt,
    screen: AgentObservation | undefined,
    now: number,
): 'synthesize' | 'wait' | 'drop' {
    if (!record || !record.confirmedTurn) return 'drop';
    if (record.phase !== 'working' && record.phase !== 'needs_input') return 'drop';
    if (record.claudeSessionId !== pending.claudeSessionId
        || record.seq !== pending.seq
        || record.phaseStartedAt !== pending.phaseStartedAt
        || record.turnId !== pending.turnId) return 'drop';
    if (now - record.updatedAt > HOOK_WORKING_STALE_MS) return 'drop';
    if (now - pending.at > INTERRUPT_CONFIRM_WINDOW_MS) return 'drop';
    if (screen?.agentKind === 'claude' && screen.agentState === 'idle') return 'synthesize';
    return 'wait';
}

export function synthesizeInterruptDone(record: TerminalHookRecord, now: number): TerminalHookRecord {
    return { ...phaseTo(record, 'done', now), interrupted: true };
}
