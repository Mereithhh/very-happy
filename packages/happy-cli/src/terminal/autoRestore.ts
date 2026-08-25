/**
 * Terminal auto-restore selection (B-150) — pure decisions, no I/O.
 *
 * B-149 made a machine reboot leave TRACES (archive rows with cwd + the claude
 * session id). This module answers the next question: which of those should the
 * daemon bring back BY ITSELF, so that logging in and opening happy shows the
 * terminals already running in their old directories, with their conversations
 * resumed, without the user clicking anything.
 *
 * The whole risk of auto-restore is resource blast: a claude TUI measures ~400MB
 * RSS, and the 2026-08-23 working set was 22 terminals — 9.1GB on a 24GB machine
 * that also hosts a CI runner. Restoring "everything that was alive" is an
 * incident, not a feature, so selection is deliberately conservative:
 *
 *   1. only terminals seen alive inside the recency window (default 24h) —
 *      a reboot also CLEANS UP forgotten sessions and auto-restore must not
 *      undo that (half of that 22 were leaked, not wanted);
 *   2. only terminals whose cwd still exists — never silently substitute
 *      another directory;
 *   3. only terminals with a known claude conversation — a bare shell is cheap
 *      to open by hand and not worth spending the budget on;
 *   4. newest first, hard-capped (default 6 ≈ 2.5GB); everything beyond the cap
 *      stays in the archive with its one-click ↻ (B-149) intact;
 *   5. never anything already alive — restore is not resurrection of a running
 *      terminal, and this is what keeps repeated daemon restarts idempotent.
 *
 * Every rejection is REPORTED (with its reason) rather than dropped, because a
 * silent cap reads as "everything was restored" when it was not.
 */

import { isClaudeSessionId } from './liveTerminals';

/** Machine-local config (see Settings.terminalAutoRestore* in persistence.ts).
 *  Machine-local because the CLI cannot read the client-encrypted synced
 *  settings blob (same reason as `boardLlm`), and because a memory budget is a
 *  property of THIS machine — syncing it across machines would be wrong. */
export interface AutoRestoreConfig {
    enabled: boolean;
    /** Hard cap on terminals brought back in one daemon start. */
    max: number;
    /** Only terminals last seen alive within this window qualify. */
    windowMs: number;
}

export const AUTO_RESTORE_DEFAULT_MAX = 6;
export const AUTO_RESTORE_DEFAULT_WINDOW_HOURS = 24;
/** Refuses to go beyond this even if configured higher — 20 claude processes is
 *  already ~8GB; a typo like 200 must not be able to take the machine down. */
export const AUTO_RESTORE_HARD_MAX = 20;

export const AUTO_RESTORE_DEFAULTS: AutoRestoreConfig = {
    enabled: true,
    max: AUTO_RESTORE_DEFAULT_MAX,
    windowMs: AUTO_RESTORE_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000,
};

/** Tolerant read of the three machine-local settings keys. Anything malformed
 *  falls back to the default rather than disabling the feature silently. */
export function resolveAutoRestoreConfig(raw: {
    terminalAutoRestore?: unknown;
    terminalAutoRestoreMax?: unknown;
    terminalAutoRestoreWindowHours?: unknown;
} | null | undefined): AutoRestoreConfig {
    const enabled = typeof raw?.terminalAutoRestore === 'boolean'
        ? raw.terminalAutoRestore
        : AUTO_RESTORE_DEFAULTS.enabled;
    const rawMax = raw?.terminalAutoRestoreMax;
    const max = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 0
        ? Math.min(Math.floor(rawMax), AUTO_RESTORE_HARD_MAX)
        : AUTO_RESTORE_DEFAULTS.max;
    const rawHours = raw?.terminalAutoRestoreWindowHours;
    const windowMs = typeof rawHours === 'number' && Number.isFinite(rawHours) && rawHours > 0
        ? Math.floor(rawHours * 60 * 60 * 1000)
        : AUTO_RESTORE_DEFAULTS.windowMs;
    return { enabled, max, windowMs };
}

/** One candidate as the persisted snapshot + mirror lookup describe it. */
export interface AutoRestoreCandidate {
    id: string;
    title?: string;
    cwd?: string;
    /** Last time the terminal was observed alive (ms epoch). */
    seenAt: number;
    /** Claude conversation to resume, if the mirror metadata knew one. */
    claudeSessionId?: string;
}

/** What the daemon executes for one accepted candidate. */
export interface AutoRestorePlan {
    terminalId: string;
    cwd: string;
    title?: string;
    claudeSessionId: string;
    /** The exact command injected into the fresh session. */
    command: string;
}

export type AutoRestoreSkipReason =
    | 'disabled'
    | 'still-live'
    | 'stale'
    | 'missing-cwd'
    | 'no-conversation'
    | 'over-limit';

export interface AutoRestoreSkip {
    id: string;
    reason: AutoRestoreSkipReason;
}

export interface AutoRestoreSelection {
    plans: AutoRestorePlan[];
    skipped: AutoRestoreSkip[];
}

/** Overlay the one-daemon-life "restored while you were away" marker.
 *
 * This is intentionally a read-only transformation. A tmux list probe may
 * transiently return no rows immediately after `new-session`; treating that
 * observation as garbage collection consumed the badge before the next good
 * poll. The bounded marks map is cleared only when the terminal is opened. */
export function markAutoRestored<T extends { id: string }>(
    list: readonly T[],
    marks: ReadonlyMap<string, number>,
): Array<T & { restoredAt?: number }> {
    if (marks.size === 0) return [...list];
    return list.map((item) => {
        const restoredAt = marks.get(item.id);
        return restoredAt ? { ...item, restoredAt } : item;
    });
}

/** The ONE place the auto-restore command is built (uuid-validated). */
export function autoResumeCommand(claudeSessionId: string): string {
    if (!isClaudeSessionId(claudeSessionId)) throw new Error('autoResumeCommand: not a claude session id');
    return `claude --resume ${claudeSessionId}`;
}

export interface SelectAutoRestoreOptions {
    now: number;
    config: AutoRestoreConfig;
    /** Terminals alive right now — never restored, never reported as skipped
     *  beyond `still-live` (they are simply not this feature's business). */
    liveIds: ReadonlySet<string>;
    /** Injected so selection stays pure and testable. */
    cwdExists: (cwd: string) => boolean;
}

/**
 * Decide what to bring back. Deterministic: newest-first by `seenAt`, and the
 * cap is applied AFTER every other filter so a stale/unusable entry can never
 * consume a slot that a good one deserved.
 */
export function selectAutoRestore(
    candidates: readonly AutoRestoreCandidate[],
    opts: SelectAutoRestoreOptions,
): AutoRestoreSelection {
    const { now, config, liveIds, cwdExists } = opts;
    if (!config.enabled || config.max <= 0) {
        return { plans: [], skipped: candidates.map((c) => ({ id: c.id, reason: 'disabled' as const })) };
    }

    const plans: AutoRestorePlan[] = [];
    const skipped: AutoRestoreSkip[] = [];
    const ordered = [...candidates].sort((a, b) => b.seenAt - a.seenAt);

    for (const c of ordered) {
        if (liveIds.has(c.id)) { skipped.push({ id: c.id, reason: 'still-live' }); continue; }
        if (now - c.seenAt > config.windowMs) { skipped.push({ id: c.id, reason: 'stale' }); continue; }
        if (!c.cwd || !cwdExists(c.cwd)) { skipped.push({ id: c.id, reason: 'missing-cwd' }); continue; }
        if (!isClaudeSessionId(c.claudeSessionId)) { skipped.push({ id: c.id, reason: 'no-conversation' }); continue; }
        if (plans.length >= config.max) { skipped.push({ id: c.id, reason: 'over-limit' }); continue; }
        plans.push({
            terminalId: c.id,
            cwd: c.cwd,
            title: c.title,
            claudeSessionId: c.claudeSessionId,
            command: autoResumeCommand(c.claudeSessionId),
        });
    }
    return { plans, skipped };
}

/** Reasons worth telling the user about: 'still-live' and 'disabled' are not
 *  losses, the other three are things they might expect to see and won't. */
const REPORTABLE: Record<AutoRestoreSkipReason, string | null> = {
    disabled: null,
    'still-live': null,
    stale: 'too old',
    'missing-cwd': 'directory gone',
    'no-conversation': 'no conversation',
    'over-limit': 'over limit',
};

/**
 * One-line summary for the log and the account notification. Names what was
 * NOT restored and why — a cap that reports nothing reads as "all restored".
 * Returns null when there is nothing worth saying (nothing restored, nothing
 * lost), so the daemon stays quiet on an ordinary restart.
 */
export function autoRestoreSummary(selection: AutoRestoreSelection): string | null {
    const counts = new Map<string, number>();
    for (const s of selection.skipped) {
        const label = REPORTABLE[s.reason];
        if (!label) continue;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const restored = selection.plans.length;
    if (restored === 0 && counts.size === 0) return null;
    const head = `Restored ${restored} terminal${restored === 1 ? '' : 's'}`;
    if (counts.size === 0) return head;
    const detail = [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(', ');
    const skippedTotal = [...counts.values()].reduce((a, b) => a + b, 0);
    return `${head}, skipped ${skippedTotal} (${detail})`;
}
