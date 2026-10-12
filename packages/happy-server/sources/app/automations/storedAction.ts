import type { AutomationAction, AutomationPrecheck } from '@slopus/happy-wire';

/**
 * B-548: what the `Automation.action` JSON column holds, without a migration.
 *
 * - No precheck: the plain action, byte-for-byte what it was before B-548
 *   (plus an optional private `skipCounts` key that old readers ignore).
 * - With a precheck: a GATE wrapper `{ kind: 'precheck', command: [hint],
 *   precheck, then: <action> }`. Views always decode it, so new clients never
 *   see the wrapper. It exists for the rollback path: an older server returns
 *   the column verbatim, and an older daemon treats the unknown kind as an
 *   invalid action (failed + attention) — it can never run the action without
 *   its precheck. Older web renders it as a script showing the hint argv.
 *
 * `skipCounts[runId]` is the folded occurrence count of a consecutive-skip run
 * (≥ 2; absent = 1), kept for the newest `MAX_SKIP_COUNTS` heads.
 */
export const GATED_ACTION_KIND = 'precheck';
export const GATED_ACTION_HINT = ['very-happy: this action is gated by a precheck; upgrade the server and very-happy-cli to run it'];
export const MAX_SKIP_COUNTS = 50;

export type SkipCounts = Record<string, number>;
export interface StoredAction {
    action: AutomationAction;
    precheck: AutomationPrecheck | null;
    skipCounts: SkipCounts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSkipCounts(raw: unknown): SkipCounts {
    if (!isRecord(raw)) return {};
    const out: SkipCounts = {};
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'number' && Number.isInteger(value) && value > 1) out[key] = value;
    return out;
}

export function decodeStoredAction(raw: unknown): StoredAction {
    const record = isRecord(raw) ? raw : {};
    const skipCounts = readSkipCounts(record.skipCounts);
    if (record.kind === GATED_ACTION_KIND && isRecord(record.then)) {
        const { skipCounts: _ignored, ...action } = record.then;
        return { action: action as AutomationAction, precheck: isRecord(record.precheck) ? (record.precheck as AutomationPrecheck) : null, skipCounts };
    }
    const { skipCounts: _ignored, ...action } = record;
    return { action: action as AutomationAction, precheck: null, skipCounts };
}

export function encodeStoredAction(stored: StoredAction): Record<string, unknown> {
    const base: Record<string, unknown> = stored.precheck
        ? { kind: GATED_ACTION_KIND, command: GATED_ACTION_HINT, precheck: stored.precheck, then: { ...stored.action } }
        : { ...stored.action };
    if (Object.keys(stored.skipCounts).length > 0) base.skipCounts = stored.skipCounts;
    return base;
}

/** Occurrence count of one run (1 when it never folded anything). */
export function occurrenceOf(skipCounts: SkipCounts, runId: string): number {
    return skipCounts[runId] ?? 1;
}

/**
 * Folds `fromRunId` (the older skip, about to be deleted) into `toRunId` (the
 * newest skip): the newest carries the previous count + 1. Insertion order is
 * age order, so the oldest heads fall off past `max`.
 */
export function foldSkipCount(skipCounts: SkipCounts, fromRunId: string, toRunId: string, max: number = MAX_SKIP_COUNTS): SkipCounts {
    const next: SkipCounts = { ...skipCounts };
    const total = occurrenceOf(next, fromRunId) + 1;
    delete next[fromRunId];
    delete next[toRunId];
    next[toRunId] = total;
    const keys = Object.keys(next);
    for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete next[key];
    return next;
}

export interface SkipCandidate { status: string; error: string | null; source: string }
/**
 * Consecutive-skip folding rule (B-548, after Orca's `occurrenceCount`): the
 * run right before this one is a skip of the same source for the same reason.
 * Only `schedule` runs fold: a manual run is explicit user intent, and a fired
 * run is one external event whose payload / dedupeKey must stay traceable (and
 * whose payload-linked sessions must not leak into another event's attention).
 */
export const FOLDABLE_SKIP_SOURCES: readonly string[] = ['schedule'];
export function shouldMergeSkip(prev: SkipCandidate | null | undefined, next: { source: string; reason: string }): boolean {
    return !!prev && prev.status === 'skipped' && prev.error === next.reason && prev.source === next.source && FOLDABLE_SKIP_SOURCES.includes(next.source);
}
