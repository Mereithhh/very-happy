/**
 * notificationUnreadMarks — PURE logic for "mark as unread" (B-559).
 * Spec: specs/2026-10-pwa-app-badge.md §D1. Store half: notificationUnreadMarksStore.ts.
 *
 * Why an overlay and not a write to the seen map: the cross-device seen map
 * (notificationSeen.ts) is a per-target MONOTONIC timestamp merged by max —
 * by design nothing can move it backwards, so "unread again" cannot be
 * expressed there. Instead a device-local mark `entryId → markedAt` sits on
 * top, and it is ANDed with the seen rule:
 *
 *   unread = baseUnread  OR  (marked AND target not seen since markedAt)
 *
 * so visiting the target on ANY device after marking retires the mark exactly
 * like it retires a fresh notification. An empty/unavailable seen map leaves
 * a mark in force (degrades to "marked ⇒ unread").
 */

import { isSeenAt, type SeenMap } from './notificationSeen';

/** entry id → wall-clock ms when the user marked it unread */
export type UnreadMarks = Readonly<Record<string, number>>;

/** Bounded: the oldest marks are evicted first. */
export const UNREAD_MARKS_CAP = 200;

export function parseUnreadMarks(input: unknown): UnreadMarks {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(input as Record<string, unknown>)) {
        if (!id || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
        out[id] = at;
    }
    return out;
}

/**
 * Final unread verdict for one inbox entry. `baseUnread` is the existing
 * verdict (per-device legacy flag AND cross-device seen — isEntryUnread).
 */
export function isUnreadWithMarks(
    baseUnread: boolean,
    entry: { id: string; key: string },
    marks: UnreadMarks,
    seen: SeenMap,
): boolean {
    if (baseUnread) return true;
    const markedAt = marks[entry.id];
    if (markedAt === undefined) return false;
    return !isSeenAt(seen, entry.key, markedAt);
}

export function withMark(marks: UnreadMarks, id: string, at: number, cap: number = UNREAD_MARKS_CAP): UnreadMarks {
    const next: Record<string, number> = { ...marks, [id]: at };
    const ids = Object.keys(next);
    if (ids.length <= cap) return next;
    ids.sort((a, b) => next[a] - next[b] || (a < b ? -1 : a > b ? 1 : 0));
    for (const drop of ids.slice(0, ids.length - cap)) delete next[drop];
    return next;
}

/** Returns the same object when there is nothing to remove (cheap no-op detection). */
export function withoutMark(marks: UnreadMarks, id: string): UnreadMarks {
    if (!(id in marks)) return marks;
    const next: Record<string, number> = { ...marks };
    delete next[id];
    return next;
}

/**
 * Which read-state action the entry menu offers. "Mark unread" is NOT offered
 * for the target the user is looking at right now: the seen tracker re-stamps
 * the open target (dwell/heartbeat), which would silently retire the mark
 * within a minute — a control that visibly undoes itself.
 */
export function entryReadAction(
    entry: { unread: boolean; key: string },
    currentTargetKey: string | null,
): 'markRead' | 'markUnread' | null {
    if (entry.unread) return 'markRead';
    if (currentTargetKey !== null && entry.key === currentTargetKey) return null;
    return 'markUnread';
}
