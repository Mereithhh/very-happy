/**
 * Mounted ONCE in AppLayout (B-559): mirrors the inbox unread count to the PWA
 * app-icon badge. Not inside NotificationBell — the bell is mounted twice
 * (sidebar footer + collapsed rail). Renders nothing.
 */
import { useEffect, useRef } from 'react';
import { useInbox } from './useInbox';
import { createBadgeSyncer, type BadgeNavigatorLike } from './appBadge';

const getNav = (): BadgeNavigatorLike | undefined =>
    typeof navigator !== 'undefined' ? (navigator as unknown as BadgeNavigatorLike) : undefined;

export function AppBadgeSync() {
    const { unreadCount } = useInbox();
    const syncer = useRef(createBadgeSyncer(getNav)).current;
    const countRef = useRef(unreadCount);
    countRef.current = unreadCount;

    useEffect(() => {
        syncer.sync(unreadCount);
    }, [syncer, unreadCount]);

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
