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
                    unread: e.unread && !readIds.has(e.id),
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
            unread: !e.read,
        }));
        return filterByRetention(mergeInbox(feedEntries, localUi), Date.now(), retentionDays);
    }, [feed, readIds, localEntries, retentionDays]);

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
        },
    };
}
