/**
 * useInbox — assembles the notification-center timeline from its two lanes
 * (see notificationInbox.ts header for the data-source design):
 *
 *   feed  = useNotificationFeed (daemon-produced, decrypted feed items),
 *           unread = counter above the read watermark AND not individually
 *           marked read (notificationReadState overlay);
 *   local = localNotificationStore (board lifecycle transitions),
 *           unread = the entry's own read flag.
 *
 * mergeInbox dedupes cross-lane duplicates and sorts newest-first;
 * filterByRetention applies the user's retention window (settings).
 *
 * On TOP of both lanes sits the SYNCED read state (notificationSeenStore): a
 * lastSeenAt timestamp per target, so an entry whose target was opened on ANY
 * device is read here too. It is ANDed with the per-device flags above, never
 * substituted for them — an empty/unavailable map (old client, first run, KV
 * fetch failure) therefore degrades to exactly the device-local behavior.
 */

import { useEffect, useMemo } from 'react';
import { useNotificationFeed } from '@/sync/useNotificationFeed';
import {
    baselineWatermarkIfUnset,
    markReadUpTo,
    markFeedItemRead,
    useReadFeedIds,
} from '@/sync/notificationReadState';
import {
    useLocalEntries,
    useRetentionDays,
    markLocalRead,
    markAllLocalRead,
} from '@/sync/localNotificationStore';
import {
    mergeInbox,
    filterByRetention,
    countUnread,
    categoryOfNotifType,
    categoryOfLocalKind,
    type InboxEntry,
} from '@/sync/notificationInbox';
import { isEntryUnread } from '@/sync/notificationSeen';
import { useNotificationSeen, useSeenMap } from '@/sync/notificationSeenStore';

export interface Inbox {
    entries: InboxEntry[];
    unreadCount: number;
    markEntryRead: (entry: InboxEntry) => void;
    markAllRead: () => void;
}

export function useInbox(): Inbox {
    const feed = useNotificationFeed();
    const readIds = useReadFeedIds();
    const localEntries = useLocalEntries();
    const retentionDays = useRetentionDays();
    const seen = useSeenMap();

    // First-run: baseline an unset watermark to the feed head so pre-feature
    // history doesn't open as a wall of unread (see notificationReadState).
    useEffect(() => {
        if (feed.maxCounter > 0) baselineWatermarkIfUnset(feed.maxCounter);
    }, [feed.maxCounter]);

    const entries = useMemo(() => {
        const feedEntries: InboxEntry[] = [];
        for (const group of feed.groups) {
            for (const e of group.entries) {
                feedEntries.push({
                    id: e.id,
                    source: 'feed',
                    category: categoryOfNotifType(e.notifType),
                    key: e.sessionId,
                    href: `/session/${e.sessionId}`,
                    title: e.title,
                    detail: e.snippet,
                    createdAt: e.createdAt,
                    unread: isEntryUnread(
                        e.unread && !readIds.has(e.id),
                        { key: e.sessionId, createdAt: e.createdAt },
                        seen,
                    ),
                });
            }
        }
        const localUi: InboxEntry[] = localEntries.map((e) => ({
            id: e.id,
            source: 'local' as const,
            category: categoryOfLocalKind(e.kind),
            key: e.key,
            href: e.href,
            title: e.title,
            detail: '', // rendered as the translated kind label
            localKind: e.kind,
            createdAt: e.createdAt,
            unread: isEntryUnread(!e.read, e, seen),
        }));
        return filterByRetention(mergeInbox(feedEntries, localUi), Date.now(), retentionDays);
    }, [feed, readIds, localEntries, retentionDays, seen]);

    const unreadCount = useMemo(() => countUnread(entries), [entries]);

    return {
        entries,
        unreadCount,
        markEntryRead: (entry) => {
            if (entry.source === 'feed') markFeedItemRead(entry.id);
            else markLocalRead(entry.id);
        },
        markAllRead: () => {
            if (feed.maxCounter > 0) markReadUpTo(feed.maxCounter);
            markAllLocalRead();
            // Cross-device half: stamp every currently visible target as seen
            // now, so the other devices retire the same entries. (Entries
            // outside the retention window aren't listed and don't need it.)
            const keys = [...new Set(entries.map((e) => e.key).filter(Boolean))];
            if (keys.length > 0) useNotificationSeen.getState().markSeen(keys);
        },
    };
}
