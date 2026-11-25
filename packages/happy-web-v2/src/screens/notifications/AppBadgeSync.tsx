/**
 * Mounted ONCE in AppLayout (B-559): mirrors the inbox unread count to the PWA
 * app-icon badge. Not inside NotificationBell — the bell is mounted twice
 * (sidebar footer + collapsed rail). Renders nothing.
 */
import { useEffect, useRef } from 'react';
import { useInbox } from './useInbox';
import { usePluginInstallMap } from '@/sync/pluginStore';
import { pluginAttentionTotal } from '@/plugins/pluginModel';
import { createBadgeSyncer, installVisibleResync, type BadgeNavigatorLike } from './appBadge';

const getNav = (): BadgeNavigatorLike | undefined =>
    typeof navigator !== 'undefined' ? (navigator as unknown as BadgeNavigatorLike) : undefined;

export function AppBadgeSync() {
    const { unreadCount: inboxUnread } = useInbox();
    // B-974d (DESIGN B-973 §11 Q5): `tone: attention` plugin badges count toward the app badge, unless muted.
    const pluginInstalls = usePluginInstallMap();
    const unreadCount = inboxUnread + pluginAttentionTotal(Object.values(pluginInstalls));
    const syncer = useRef(createBadgeSyncer(getNav)).current;
    const countRef = useRef(unreadCount);
    countRef.current = unreadCount;

    useEffect(() => {
        syncer.sync(unreadCount);
    }, [syncer, unreadCount]);

    // Back from hidden: replace any SW push estimate with the exact count.
    useEffect(() => {
        if (typeof document === 'undefined') return;
        return installVisibleResync(document, syncer, () => countRef.current);
    }, [syncer]);

    // A NEW service worker took control (update / first install): it has no
    // count yet — re-send the current one.
    useEffect(() => {
        const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
        if (!sw) return;
        const onChange = () => { syncer.reset(); syncer.sync(countRef.current); };
        sw.addEventListener('controllerchange', onChange);
        return () => sw.removeEventListener('controllerchange', onChange);
    }, [syncer]);

    return null;
}
