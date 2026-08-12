/**
 * useNotificationGenerator — the LOCAL producer lane of the notification
 * center. Mounted once at AppLayout level (always alive while authed), it
 * watches the board's lifecycle classification (useBoardItems — the same
 * derivation the sidebar/status view consumes, so the inbox can never
 * disagree with the board) and turns TRANSITIONS into notification entries:
 *
 *   running → waiting(permission/review/blocked/needsInput)  →  "需要干预"
 *   running → waiting(idle)                                   →  "回合完成"
 *
 * The diff itself is pure (notificationInbox.deriveLocalNotifications);
 * this hook only owns the baseline rule — the FIRST snapshot after mount is
 * recorded, not diffed, so items that were already waiting when the app
 * loaded don't fire a notification storm.
 *
 * Each appended entry also rings the chime through the shared gate
 * (notificationChime.ts), which handles self-view suppression, quiet hours
 * and the cross-lane cooldown against the feed producer in sync.ts.
 */

import { useEffect, useRef } from 'react';
import { useBoardItems } from '@/screens/board/useBoardItems';
import {
    deriveLocalNotifications,
    toSnapshotMap,
    soundEventOfLocalKind,
    type LifecycleSnapshot,
} from '@/sync/notificationInbox';
import { appendLocalEntries } from '@/sync/localNotificationStore';
import { maybePlayNotificationSound } from '@/sync/notificationChime';
import { installAudioUnlock } from '@/utils/chimes';

export function useNotificationGenerator(): void {
    const items = useBoardItems();
    const prevRef = useRef<ReadonlyMap<string, LifecycleSnapshot> | null>(null);

    // Arm the autoplay unlock as early as possible so the first user gesture
    // (any click/keypress) makes the chime audible.
    useEffect(() => {
        installAudioUnlock();
    }, []);

    useEffect(() => {
        const prev = prevRef.current;
        prevRef.current = toSnapshotMap(items);
        if (!prev) return; // baseline — never diff against nothing
        const events = deriveLocalNotifications(prev, items, Date.now());
        if (events.length === 0) return;
        const appended = appendLocalEntries(events);
        for (const e of appended) {
            maybePlayNotificationSound({
                event: soundEventOfLocalKind(e.kind),
                key: e.key,
                href: e.href,
            });
        }
    }, [items]);
}
