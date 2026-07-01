/**
 * useNotificationFeed — derives decrypted session-notification items from the
 * feed store, grouped by session and sorted newest-first, with unread flags.
 *
 * Decryption is memoized per feed-item id (the ciphertext is immutable for a
 * given id), so re-renders don't re-run libsodium. The account secret seed is
 * read once from credentials.
 */

import * as React from 'react';
import { useFeedItems } from './storage';
import { sync } from './sync';
import { decodeBase64 } from '@/encryption/base64';
import { decryptNotificationEnc, type NotificationPayload } from './encryption/notificationDecrypt';
import { useReadWatermark } from './notificationReadState';
import type { FeedItem, NotifType } from './feedTypes';

export interface NotificationEntry {
    id: string;
    counter: number;
    createdAt: number;
    sessionId: string;
    notifType: NotifType;
    title: string;
    snippet: string;
    unread: boolean;
}

export interface NotificationSessionGroup {
    sessionId: string;
    latestAt: number;
    unreadCount: number;
    entries: NotificationEntry[];
}

// Module-level decryption cache keyed by feed-item id (ciphertext is immutable).
const decryptCache = new Map<string, NotificationPayload | null>();

function getSeed(): Uint8Array | null {
    const credentials = sync.getCredentials?.();
    if (!credentials) return null;
    try {
        return decodeBase64(credentials.secret, 'base64url');
    } catch {
        return null;
    }
}

function toEntry(item: FeedItem, seed: Uint8Array | null, watermark: number): NotificationEntry | null {
    if (!item.body || item.body.kind !== 'notification') return null;
    if (!seed) return null;

    let payload: NotificationPayload | null | undefined = decryptCache.get(item.id);
    if (payload === undefined) {
        payload = decryptNotificationEnc(item.body.enc, seed);
        decryptCache.set(item.id, payload);
    }
    if (!payload) return null;

    return {
        id: item.id,
        counter: item.counter,
        createdAt: item.createdAt,
        sessionId: item.body.sessionId,
        notifType: item.body.notifType,
        title: payload.title,
        snippet: payload.snippet ?? '',
        unread: item.counter > watermark,
    };
}

export interface NotificationFeed {
    groups: NotificationSessionGroup[];
    totalUnread: number;
    maxCounter: number;
    isEmpty: boolean;
}

export function useNotificationFeed(): NotificationFeed {
    const feedItems = useFeedItems();
    const watermark = useReadWatermark();
    const seed = React.useMemo(() => getSeed(), []);

    return React.useMemo<NotificationFeed>(() => {
        const entries: NotificationEntry[] = [];
        for (const item of feedItems) {
            const entry = toEntry(item, seed, watermark);
            if (entry) entries.push(entry);
        }

        const bySession = new Map<string, NotificationEntry[]>();
        for (const e of entries) {
            const arr = bySession.get(e.sessionId);
            if (arr) arr.push(e);
            else bySession.set(e.sessionId, [e]);
        }

        const groups: NotificationSessionGroup[] = [];
        let totalUnread = 0;
        let maxCounter = 0;
        for (const [sessionId, list] of bySession) {
            list.sort((a, b) => b.createdAt - a.createdAt);
            const unreadCount = list.filter((e) => e.unread).length;
            totalUnread += unreadCount;
            const latestAt = list[0]?.createdAt ?? 0;
            for (const e of list) maxCounter = Math.max(maxCounter, e.counter);
            groups.push({ sessionId, latestAt, unreadCount, entries: list });
        }
        groups.sort((a, b) => b.latestAt - a.latestAt);

        return { groups, totalUnread, maxCounter, isEmpty: groups.length === 0 };
    }, [feedItems, watermark, seed]);
}
