import { describe, it, expect } from 'vitest';
import {
    categoryOfNotifType,
    categoryOfLocalKind,
    soundEventOfCategory,
    soundEventOfNotifType,
    deriveLocalNotifications,
    toSnapshotMap,
    dedupeAppend,
    pruneLocalEntries,
    mergeInbox,
    filterByRetention,
    countUnread,
    isSameTarget,
    type LifecycleSnapshot,
    type LocalNotifEntry,
    type InboxEntry,
} from './notificationInbox';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function snap(over: Partial<LifecycleSnapshot> & { key: string }): LifecycleSnapshot {
    return {
        kind: 'session',
        lifecycle: 'running',
        waitReason: undefined,
        href: `/session/${over.key}`,
        title: `title-${over.key}`,
        ...over,
    };
}

function local(over: Partial<LocalNotifEntry> & { id: string }): LocalNotifEntry {
    return {
        key: 's1',
        kind: 'permission',
        href: '/session/s1',
        title: 't',
        createdAt: 1000,
        read: false,
        ...over,
    };
}

function inbox(over: Partial<InboxEntry> & { id: string }): InboxEntry {
    return {
        source: 'feed',
        category: 'permission',
        key: 's1',
        href: '/session/s1',
        title: 't',
        detail: '',
        createdAt: 1000,
        unread: true,
        ...over,
    };
}

// ---------------------------------------------------------------------------
// category / sound-event mapping
// ---------------------------------------------------------------------------

describe('category mapping', () => {
    it('maps feed notif types to categories', () => {
        expect(categoryOfNotifType('permission_request')).toBe('permission');
        expect(categoryOfNotifType('input_needed')).toBe('question');
        expect(categoryOfNotifType('error')).toBe('error');
        expect(categoryOfNotifType('reply_done')).toBe('done');
    });

    it('maps local kinds to categories', () => {
        expect(categoryOfLocalKind('permission')).toBe('permission');
        expect(categoryOfLocalKind('review')).toBe('question');
        expect(categoryOfLocalKind('blocked')).toBe('question');
        expect(categoryOfLocalKind('needsInput')).toBe('question');
        expect(categoryOfLocalKind('turnDone')).toBe('done');
    });

    it('folds error into the question sound toggle', () => {
        expect(soundEventOfCategory('error')).toBe('question');
        expect(soundEventOfCategory('permission')).toBe('permission');
        expect(soundEventOfCategory('done')).toBe('done');
        expect(soundEventOfNotifType('error')).toBe('question');
    });
});

// ---------------------------------------------------------------------------
// deriveLocalNotifications
// ---------------------------------------------------------------------------

describe('deriveLocalNotifications', () => {
    const NOW = 50_000;

    it('emits when an item flips running → waiting:permission', () => {
        const prev = toSnapshotMap([snap({ key: 's1', lifecycle: 'running' })]);
        const next = [snap({ key: 's1', lifecycle: 'waiting', waitReason: 'permission' })];
        const out = deriveLocalNotifications(prev, next, NOW);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ key: 's1', kind: 'permission', createdAt: NOW, read: false });
    });

    it('emits for a NEW item that appears already urgent', () => {
        const prev = toSnapshotMap([]);
        const next = [
            snap({ key: 't:x', kind: 'terminal', lifecycle: 'waiting', waitReason: 'needsInput', href: '/terminal/m1?tid=x' }),
        ];
        const out = deriveLocalNotifications(prev, next, NOW);
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('needsInput');
        expect(out[0].href).toBe('/terminal/m1?tid=x');
    });

    it('emits when the wait reason CHANGES (idle → permission)', () => {
        const prev = toSnapshotMap([snap({ key: 's1', lifecycle: 'waiting', waitReason: 'idle' })]);
        const next = [snap({ key: 's1', lifecycle: 'waiting', waitReason: 'permission' })];
        expect(deriveLocalNotifications(prev, next, NOW)).toHaveLength(1);
    });

    it('does NOT re-emit while the same urgent state persists', () => {
        const prev = toSnapshotMap([snap({ key: 's1', lifecycle: 'waiting', waitReason: 'review' })]);
        const next = [snap({ key: 's1', lifecycle: 'waiting', waitReason: 'review' })];
        expect(deriveLocalNotifications(prev, next, NOW)).toHaveLength(0);
    });

    it('emits turnDone ONLY for running → waiting:idle', () => {
        const prev = toSnapshotMap([
            snap({ key: 's1', lifecycle: 'running' }),
            snap({ key: 's2', lifecycle: 'waiting', waitReason: 'permission' }),
        ]);
        const next = [
            snap({ key: 's1', lifecycle: 'waiting', waitReason: 'idle' }),
            snap({ key: 's2', lifecycle: 'waiting', waitReason: 'idle' }), // permission → idle: answered, no event
            snap({ key: 's3', lifecycle: 'waiting', waitReason: 'idle' }), // brand-new idle session: no event
        ];
        const out = deriveLocalNotifications(prev, next, NOW);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ key: 's1', kind: 'turnDone' });
    });

    it('stays silent on waiting → running and on ended/machineOffline', () => {
        const prev = toSnapshotMap([
            snap({ key: 's1', lifecycle: 'waiting', waitReason: 'permission' }),
            snap({ key: 's2', lifecycle: 'running' }),
        ]);
        const next = [
            snap({ key: 's1', lifecycle: 'running' }),
            snap({ key: 's2', lifecycle: 'waiting', waitReason: 'ended' }),
            snap({ key: 't:y', kind: 'terminal', lifecycle: 'waiting', waitReason: 'machineOffline' }),
        ];
        expect(deriveLocalNotifications(prev, next, NOW)).toHaveLength(0);
    });

    it('gives every emitted entry a unique id', () => {
        const prev = toSnapshotMap([]);
        const next = [
            snap({ key: 's1', lifecycle: 'waiting', waitReason: 'permission' }),
            snap({ key: 's2', lifecycle: 'waiting', waitReason: 'blocked' }),
        ];
        const out = deriveLocalNotifications(prev, next, NOW);
        expect(new Set(out.map((e) => e.id)).size).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// dedupeAppend
// ---------------------------------------------------------------------------

describe('dedupeAppend', () => {
    it('drops an incoming entry repeating key+kind within the window', () => {
        const existing = [local({ id: 'a', key: 's1', kind: 'permission', createdAt: 1000 })];
        const incoming = [local({ id: 'b', key: 's1', kind: 'permission', createdAt: 30_000 })];
        expect(dedupeAppend(existing, incoming, 60_000)).toHaveLength(0);
    });

    it('keeps it outside the window, and keeps different key/kind inside it', () => {
        const existing = [local({ id: 'a', key: 's1', kind: 'permission', createdAt: 1000 })];
        const incoming = [
            local({ id: 'b', key: 's1', kind: 'permission', createdAt: 70_000 }), // outside window
            local({ id: 'c', key: 's1', kind: 'turnDone', createdAt: 2000 }), // different kind
            local({ id: 'd', key: 's2', kind: 'permission', createdAt: 2000 }), // different key
        ];
        expect(dedupeAppend(existing, incoming, 60_000).map((e) => e.id)).toEqual(['b', 'c', 'd']);
    });

    it('dedupes within the incoming batch itself', () => {
        const incoming = [
            local({ id: 'a', key: 's1', kind: 'permission', createdAt: 1000 }),
            local({ id: 'b', key: 's1', kind: 'permission', createdAt: 1500 }),
        ];
        expect(dedupeAppend([], incoming, 60_000).map((e) => e.id)).toEqual(['a']);
    });
});

// ---------------------------------------------------------------------------
// pruneLocalEntries / retention
// ---------------------------------------------------------------------------

describe('pruneLocalEntries', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('drops entries older than the retention horizon', () => {
        const now = 10 * DAY;
        const entries = [
            local({ id: 'old', createdAt: now - 8 * DAY }),
            local({ id: 'new', createdAt: now - 1 * DAY }),
        ];
        expect(pruneLocalEntries(entries, now, 7, 200).map((e) => e.id)).toEqual(['new']);
    });

    it('caps to the newest N entries', () => {
        const now = 1000_000;
        const entries = Array.from({ length: 5 }, (_, i) =>
            local({ id: `e${i}`, createdAt: now - i * 1000 }),
        );
        const out = pruneLocalEntries(entries, now, 7, 3);
        expect(out.map((e) => e.id)).toEqual(['e0', 'e1', 'e2']);
    });
});

describe('filterByRetention', () => {
    it('filters the merged timeline by age', () => {
        const DAY = 24 * 60 * 60 * 1000;
        const now = 10 * DAY;
        const entries = [
            inbox({ id: 'a', createdAt: now - 2 * DAY }),
            inbox({ id: 'b', createdAt: now - 5 * DAY }),
        ];
        expect(filterByRetention(entries, now, 3).map((e) => e.id)).toEqual(['a']);
    });
});

// ---------------------------------------------------------------------------
// mergeInbox / countUnread
// ---------------------------------------------------------------------------

describe('mergeInbox', () => {
    it('drops a local entry duplicated by a feed entry (same key+category, close in time)', () => {
        const feed = [inbox({ id: 'f1', source: 'feed', key: 's1', category: 'permission', createdAt: 10_000 })];
        const localE = [inbox({ id: 'l1', source: 'local', key: 's1', category: 'permission', createdAt: 15_000 })];
        const out = mergeInbox(feed, localE);
        expect(out.map((e) => e.id)).toEqual(['f1']);
    });

    it('is order-independent (local recorded BEFORE the feed item lands)', () => {
        const feed = [inbox({ id: 'f1', source: 'feed', key: 's1', category: 'done', createdAt: 20_000 })];
        const localE = [inbox({ id: 'l1', source: 'local', key: 's1', category: 'done', createdAt: 8_000 })];
        expect(mergeInbox(feed, localE).map((e) => e.id)).toEqual(['f1']);
    });

    it('keeps local entries outside the window or with a different key/category', () => {
        const feed = [inbox({ id: 'f1', key: 's1', category: 'permission', createdAt: 100_000 })];
        const localE = [
            inbox({ id: 'l1', source: 'local', key: 's1', category: 'permission', createdAt: 200_000 }), // far away
            inbox({ id: 'l2', source: 'local', key: 's1', category: 'question', createdAt: 100_000 }), // other category
            inbox({ id: 'l3', source: 'local', key: 't:z', category: 'permission', createdAt: 100_000 }), // other key
        ];
        const out = mergeInbox(feed, localE);
        expect(out.map((e) => e.id).sort()).toEqual(['f1', 'l1', 'l2', 'l3']);
    });

    it('sorts newest-first with a stable id tiebreak', () => {
        const out = mergeInbox(
            [inbox({ id: 'b', createdAt: 1000 }), inbox({ id: 'a', createdAt: 1000 })],
            [inbox({ id: 'c', source: 'local', key: 's9', createdAt: 5000 })],
        );
        expect(out.map((e) => e.id)).toEqual(['c', 'a', 'b']);
    });
});

describe('countUnread', () => {
    it('counts unread entries', () => {
        expect(
            countUnread([
                inbox({ id: 'a', unread: true }),
                inbox({ id: 'b', unread: false }),
                inbox({ id: 'c', unread: true }),
            ]),
        ).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// isSameTarget (self-view suppression)
// ---------------------------------------------------------------------------

describe('isSameTarget', () => {
    it('matches a session route by pathname', () => {
        expect(isSameTarget('/session/abc', '/session/abc', '')).toBe(true);
        expect(isSameTarget('/session/abc', '/session/xyz', '')).toBe(false);
        expect(isSameTarget('/session/abc', '/', '')).toBe(false);
    });

    it('matches a terminal route only when tid matches too', () => {
        expect(isSameTarget('/terminal/m1?tid=t1', '/terminal/m1', '?tid=t1')).toBe(true);
        expect(isSameTarget('/terminal/m1?tid=t1', '/terminal/m1', '?tid=t2')).toBe(false);
        expect(isSameTarget('/terminal/m1?tid=t1', '/terminal/m1', '')).toBe(false);
        expect(isSameTarget('/terminal/m1?tid=t1', '/terminal/m2', '?tid=t1')).toBe(false);
    });
});
