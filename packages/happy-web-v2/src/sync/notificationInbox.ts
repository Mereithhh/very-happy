/**
 * notificationInbox — PURE logic for the in-app notification center (bell +
 * panel). No store imports, no i18n, no DOM: everything unit-testable
 * (notificationInbox.test.ts).
 *
 * Two data sources feed the inbox (see useInbox.ts for the wiring):
 *
 *  1. FEED — server feed items of kind 'notification' produced by the daemon
 *     (permission_request / reply_done / input_needed / error), decrypted by
 *     useNotificationFeed. Rich text (title + snippet), but only covers chat
 *     sessions whose daemon emits feed notifications.
 *  2. LOCAL — entries generated client-side from BOARD lifecycle transitions
 *     (boardItems.lifecycleOf): a session/terminal flipping into an urgent
 *     wait state (permission / review / blocked / needsInput) or finishing a
 *     turn (running → waiting:idle). Covers what the feed can't see —
 *     terminals, LLM review/blocked verdicts — and doubles as a fallback when
 *     the feed lane is missing.
 *
 * The same event can arrive on both lanes (e.g. a session permission request
 * = feed permission_request + board transition to waitReason 'permission').
 * mergeInbox dedupes: a local entry is dropped when a feed entry with the
 * same target key + category exists within a small time window (the feed
 * entry wins — it carries the daemon's human-written title/snippet).
 */

import type { NotifType } from './feedTypes';
import type { BoardItem, WaitReason } from '@/screens/board/boardItems';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Display category of an inbox entry (icon + label + sound routing). */
export type InboxCategory = 'permission' | 'question' | 'done' | 'error';

/** The three user-facing sound toggles (settings): 权限请求 / 提问 / 完成.
 *  'error' folds into 'question' — both mean "the agent needs a human". */
export type SoundEvent = 'permission' | 'question' | 'done';

/** Kinds of locally generated entries (board lifecycle transitions). */
export type LocalNotifKind = 'permission' | 'review' | 'blocked' | 'needsInput' | 'turnDone';

export function categoryOfNotifType(type: NotifType): InboxCategory {
    switch (type) {
        case 'permission_request': return 'permission';
        case 'input_needed': return 'question';
        case 'error': return 'error';
        case 'reply_done': return 'done';
    }
}

export function categoryOfLocalKind(kind: LocalNotifKind): InboxCategory {
    switch (kind) {
        case 'permission': return 'permission';
        case 'review':
        case 'blocked':
        case 'needsInput': return 'question';
        case 'turnDone': return 'done';
    }
}

export function soundEventOfCategory(category: InboxCategory): SoundEvent {
    return category === 'error' ? 'question' : category;
}

export function soundEventOfNotifType(type: NotifType): SoundEvent {
    return soundEventOfCategory(categoryOfNotifType(type));
}

export function soundEventOfLocalKind(kind: LocalNotifKind): SoundEvent {
    return soundEventOfCategory(categoryOfLocalKind(kind));
}

// ---------------------------------------------------------------------------
// Local entries: derivation from board lifecycle transitions
// ---------------------------------------------------------------------------

/** The board facts the generator diffs — a snapshot row per board item. */
export type LifecycleSnapshot = Pick<
    BoardItem,
    'key' | 'kind' | 'lifecycle' | 'waitReason' | 'href' | 'title'
>;

/** A locally generated notification entry (persisted in MMKV). */
export interface LocalNotifEntry {
    id: string;
    /** board key — session id or `t:<terminalId>` */
    key: string;
    kind: LocalNotifKind;
    href: string;
    /** raw title at capture time — may be '' (render a fallback) */
    title: string;
    createdAt: number;
    read: boolean;
}

const URGENT_KIND_BY_REASON: Partial<Record<WaitReason, LocalNotifKind>> = {
    permission: 'permission',
    review: 'review',
    blocked: 'blocked',
    needsInput: 'needsInput',
};

export function toSnapshotMap(items: ReadonlyArray<LifecycleSnapshot>): Map<string, LifecycleSnapshot> {
    const map = new Map<string, LifecycleSnapshot>();
    for (const it of items) {
        if (!map.has(it.key)) map.set(it.key, it);
    }
    return map;
}

/**
 * Diff two board snapshots into notification events. Transition-based, so
 * a state that PERSISTS never re-fires (inherent dedup):
 *
 *  - an item enters an URGENT wait state (permission/review/blocked/
 *    needsInput) — from running, from a different wait reason, or by
 *    appearing on the board already urgent → one entry of that kind;
 *  - an item goes running → waiting:idle (the agent finished its turn and
 *    is waiting to be collected) → one 'turnDone' entry. A NEW item that
 *    appears idle (freshly spawned session) is NOT a notification.
 *
 * The caller owns the baseline: the first snapshot after mount must not be
 * diffed against an empty map (everything already-waiting would fire) — pass
 * prev=null → no events (handled by the hook, not here).
 */
export function deriveLocalNotifications(
    prev: ReadonlyMap<string, LifecycleSnapshot>,
    next: ReadonlyArray<LifecycleSnapshot>,
    now: number,
): LocalNotifEntry[] {
    const out: LocalNotifEntry[] = [];
    let seq = 0;
    for (const item of next) {
        if (item.lifecycle !== 'waiting' || !item.waitReason) continue;
        const before = prev.get(item.key);
        const urgentKind = URGENT_KIND_BY_REASON[item.waitReason];
        let kind: LocalNotifKind | null = null;
        if (urgentKind) {
            const wasSameState =
                before?.lifecycle === 'waiting' && before.waitReason === item.waitReason;
            if (!wasSameState) kind = urgentKind;
        } else if (item.waitReason === 'idle') {
            if (before?.lifecycle === 'running') kind = 'turnDone';
        }
        // 'ended' / 'machineOffline' are deliberately silent: the process died
        // or the machine went away — reap-band housekeeping, not intervention.
        if (!kind) continue;
        out.push({
            id: `l:${item.key}:${kind}:${now}:${seq++}`,
            key: item.key,
            kind,
            href: item.href,
            title: item.title,
            createdAt: now,
            read: false,
        });
    }
    return out;
}

/** Suppress repeats: an incoming entry is dropped when an entry with the same
 *  key+kind already exists within `windowMs` (covers rapid state flapping,
 *  e.g. a permission request re-posted while the user is answering). Returns
 *  only the entries that should actually be appended. */
export function dedupeAppend(
    existing: ReadonlyArray<LocalNotifEntry>,
    incoming: ReadonlyArray<LocalNotifEntry>,
    windowMs: number,
): LocalNotifEntry[] {
    const lastAt = new Map<string, number>();
    for (const e of existing) {
        const k = `${e.key}:${e.kind}`;
        const cur = lastAt.get(k);
        if (cur === undefined || e.createdAt > cur) lastAt.set(k, e.createdAt);
    }
    const out: LocalNotifEntry[] = [];
    for (const e of incoming) {
        const k = `${e.key}:${e.kind}`;
        const last = lastAt.get(k);
        if (last !== undefined && e.createdAt - last < windowMs) continue;
        lastAt.set(k, e.createdAt);
        out.push(e);
    }
    return out;
}

/** Retention + cap for the persisted local list: entries older than
 *  `retentionDays` fall off; at most `cap` newest entries are kept. */
export function pruneLocalEntries(
    entries: ReadonlyArray<LocalNotifEntry>,
    now: number,
    retentionDays: number,
    cap: number,
): LocalNotifEntry[] {
    const horizon = now - retentionDays * 24 * 60 * 60 * 1000;
    const kept = entries.filter((e) => e.createdAt >= horizon);
    kept.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return kept.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Unified inbox entries (what the panel renders)
// ---------------------------------------------------------------------------

export interface InboxEntry {
    id: string;
    source: 'feed' | 'local';
    category: InboxCategory;
    /** dedup + self-view key: session id or `t:<terminalId>` */
    key: string;
    href: string;
    /** raw title — may be '' (render a fallback) */
    title: string;
    /** feed: the daemon's snippet; local: '' (render the kind label) */
    detail: string;
    /** local entries only — drives the translated detail label */
    localKind?: LocalNotifKind;
    createdAt: number;
    unread: boolean;
}

/** Window inside which a local entry duplicates a feed entry for the same
 *  target + category (the two lanes observe the same underlying event). */
export const MERGE_WINDOW_MS = 30_000;

/**
 * Merge the two lanes into one timeline, newest first. A LOCAL entry is
 * dropped when a FEED entry with the same key + category sits within
 * `windowMs` of it — the feed entry carries the daemon's richer text.
 * (Order-independent: works whichever lane landed first.)
 */
export function mergeInbox(
    feed: ReadonlyArray<InboxEntry>,
    local: ReadonlyArray<InboxEntry>,
    windowMs: number = MERGE_WINDOW_MS,
): InboxEntry[] {
    const out: InboxEntry[] = [...feed];
    for (const l of local) {
        const dup = feed.some(
            (f) =>
                f.key === l.key &&
                f.category === l.category &&
                Math.abs(f.createdAt - l.createdAt) <= windowMs,
        );
        if (!dup) out.push(l);
    }
    out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return out;
}

export function filterByRetention(
    entries: ReadonlyArray<InboxEntry>,
    now: number,
    retentionDays: number,
): InboxEntry[] {
    const horizon = now - retentionDays * 24 * 60 * 60 * 1000;
    return entries.filter((e) => e.createdAt >= horizon);
}

export function countUnread(entries: ReadonlyArray<InboxEntry>): number {
    let n = 0;
    for (const e of entries) if (e.unread) n++;
    return n;
}

// ---------------------------------------------------------------------------
// Self-view check (pure part — the chime gate feeds it window.location)
// ---------------------------------------------------------------------------

/**
 * Does `href` point at the view the user is currently on? Sessions compare by
 * pathname; terminals additionally require the `tid` query param to match
 * (one terminal screen hosts many tabs).
 */
export function isSameTarget(href: string, currentPath: string, currentSearch: string): boolean {
    const [path, query = ''] = href.split('?');
    if (path !== currentPath) return false;
    const tid = new URLSearchParams(query).get('tid');
    if (tid !== null) return new URLSearchParams(currentSearch).get('tid') === tid;
    return true;
}
