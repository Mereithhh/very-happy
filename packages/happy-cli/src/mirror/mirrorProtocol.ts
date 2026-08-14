/**
 * Terminal mirror (B-105) — pure decision logic, no I/O.
 *
 * A claude TUI hand-typed inside a vh web terminal is mirrored into a
 * read-only "shadow session" on the server. The daemon receives global
 * SessionStart/SessionEnd hooks (forwarded by scripts/terminal_mirror_forwarder.cjs,
 * which only fires when the terminal carries the VH_TERMINAL_ID env marker and
 * the claude process is NOT happy-managed), and this module decides — purely —
 * what each hook means for the per-terminal binding.
 *
 * Everything here is unit-tested; the I/O lives in mirrorManager/mirrorScanner.
 * Spec: specs/2026-08-terminal-mirror.md (Final v3 + 实施回流修正).
 */

import type { RawJSONLines } from '@/claude/types';

// ── Hook payload ─────────────────────────────────────────────────────────────

export interface TerminalHookEvent {
    event: 'SessionStart' | 'SessionEnd';
    claudeSessionId: string;
    terminalId: string;
    transcriptPath?: string;
    cwd?: string;
    /** SessionStart: 'startup' | 'resume' | 'clear' | 'compact' | unknown. */
    source?: string;
}

/**
 * Parse a forwarded hook payload (claude's hook JSON + the forwarder-appended
 * `terminalId`). Tolerant: unknown fields ignored, snake_case and camelCase
 * session ids both accepted. Returns null when the payload cannot identify
 * an event + session + terminal (the endpoint then just 200s and drops it).
 */
export function parseTerminalHookPayload(body: unknown): TerminalHookEvent | null {
    if (!body || typeof body !== 'object') return null;
    const raw = body as Record<string, unknown>;
    const eventName = raw.hook_event_name;
    if (eventName !== 'SessionStart' && eventName !== 'SessionEnd') return null;
    const claudeSessionId = typeof raw.session_id === 'string' && raw.session_id.length > 0
        ? raw.session_id
        : (typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : null);
    if (!claudeSessionId) return null;
    const terminalId = typeof raw.terminalId === 'string' && raw.terminalId.length > 0 ? raw.terminalId : null;
    if (!terminalId) return null;
    return {
        event: eventName,
        claudeSessionId,
        terminalId,
        transcriptPath: typeof raw.transcript_path === 'string' && raw.transcript_path.length > 0 ? raw.transcript_path : undefined,
        cwd: typeof raw.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : undefined,
        source: typeof raw.source === 'string' && raw.source.length > 0 ? raw.source : undefined,
    };
}

// ── Binding state machine ────────────────────────────────────────────────────

export interface MirrorBindingSnapshot {
    /** 'active' = scanner running; 'ended' = claude exited but the shadow
     *  session is still revivable by a resume/compact in the same terminal. */
    status: 'active' | 'ended';
    claudeSessionId: string;
}

export type MirrorBindingAction =
    /** No binding for this terminal (or a fresh conversation replaces it) →
     *  create a brand-new shadow session. `replaces` carries the superseded
     *  binding when a startup/clear lands on a terminal that already has one. */
    | { action: 'create'; replaces?: MirrorBindingSnapshot }
    /** resume/compact (or unknown non-startup source) continuing the same
     *  terminal's conversation → reuse the existing shadow session, follow the
     *  new transcript file from EOF (treatExistingAsProcessed ≙ start@EOF). */
    | { action: 'continue' }
    /** SessionEnd for the currently-bound claude session → stop the scanner,
     *  deactivate; binding stays revivable. */
    | { action: 'end' }
    | { action: 'ignore'; reason: string };

/** Sources that mean "a brand-new conversation history" (spec 实施回流：
 *  clear 归 startup 类 — /clear starts a fresh id with empty history). */
const FRESH_CONVERSATION_SOURCES = new Set(['startup', 'clear']);

export function decideMirrorBinding(
    event: TerminalHookEvent,
    binding: MirrorBindingSnapshot | null,
): MirrorBindingAction {
    if (event.event === 'SessionEnd') {
        if (!binding) return { action: 'ignore', reason: 'no binding for terminal' };
        if (binding.claudeSessionId !== event.claudeSessionId) {
            return { action: 'ignore', reason: 'stale SessionEnd for a superseded claude session' };
        }
        if (binding.status === 'ended') return { action: 'ignore', reason: 'already ended' };
        return { action: 'end' };
    }
    // SessionStart
    if (!binding) return { action: 'create' };
    if (binding.status === 'active' && binding.claudeSessionId === event.claudeSessionId) {
        return { action: 'ignore', reason: 'duplicate SessionStart for the bound session' };
    }
    if (FRESH_CONVERSATION_SOURCES.has(event.source ?? 'startup')) {
        return { action: 'create', replaces: binding };
    }
    // resume / compact / anything unknown that isn't a fresh conversation:
    // one shadow session ≈ one continuous conversation history (spec M4②).
    return { action: 'continue' };
}

// ── localId derivation (M1 idempotency) ──────────────────────────────────────

/**
 * Stable per-line key for localId derivation. user/assistant/system lines use
 * their uuid (v4 — globally unique across files, PRESERVED by resume's
 * sessionId rewrite). summary lines have no uuid → leafUuid. 'result' lines
 * never occur in transcripts (SDK stream only) → null, caller falls back to a
 * random localId (delivered once, never replayed by the mirror path).
 */
export function mirrorLineKey(message: RawJSONLines): string | null {
    if (message.type === 'summary') return `summary-${message.leafUuid}`;
    if (message.type === 'user' || message.type === 'assistant' || message.type === 'system') {
        return message.uuid;
    }
    return null;
}

/**
 * Deterministic localId for the i-th envelope mapped from one transcript line:
 * `mirror:<lineKey>:<i>`. The envelope index is REQUIRED — one line maps to
 * 0..N envelopes (turn-start + per-block text/tool-call), and the server's
 * @@unique([sessionId, localId]) would swallow every envelope after the first
 * under a per-line-only id. Replays of the same line dedupe per position.
 */
export function mirrorLocalId(lineKey: string, envelopeIndex: number): string {
    return `mirror:${lineKey}:${envelopeIndex}`;
}

// ── Byte-accurate line extraction (offset tail, M2) ─────────────────────────

/**
 * Split a freshly-read byte region into complete lines + the number of bytes
 * safely consumed. Only complete ('\n'-terminated) lines are returned; a
 * partial trailing line (claude mid-write) stays on disk for the next read —
 * the caller advances its offset by `consumedBytes` only. Splitting on the
 * BYTE 0x0a is UTF-8-safe (never part of a multibyte sequence), so a read
 * that lands mid-character can never corrupt a returned line.
 */
export function extractCompleteLines(buf: Buffer): { lines: string[]; consumedBytes: number } {
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return { lines: [], consumedBytes: 0 };
    const text = buf.subarray(0, lastNl).toString('utf-8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    return { lines, consumedBytes: lastNl + 1 };
}

// ── Backfill truncation (M2) ─────────────────────────────────────────────────

export const MIRROR_BACKFILL_LINES_DEFAULT = 500;

/**
 * First-bind backfill decision: replay only the last `maxLines` parsed
 * messages (44MB/万行 full replays are the disaster case), and tell the
 * caller whether a "更早内容看终端" notice belongs above them.
 */
export function decideBackfill<T>(messages: T[], maxLines: number): { replay: T[]; truncated: boolean } {
    const cap = Math.max(0, Math.floor(maxLines));
    if (messages.length <= cap) return { replay: messages, truncated: false };
    return { replay: messages.slice(messages.length - cap), truncated: true };
}
