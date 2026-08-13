/**
 * NotificationBell — the notification-center entry point: a bell button with
 * an unread badge + the notification panel. Self-contained so it can sit in
 * the sidebar header AND the collapsed desktop rail.
 *
 * Panel form factor: desktop = a floating panel anchored under the bell
 * (portal + fixed positioning, click-outside/Escape closes); mobile
 * (<980px, the AppLayout breakpoint) = fullscreen overlay via CSS — same
 * pattern as the app's other mobile-fullscreen surfaces.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
    Bell,
    CheckCheck,
    KeyRound,
    MessageCircleQuestion,
    CheckCircle2,
    AlertTriangle,
    Settings,
    X,
} from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import type { SimpleTranslationKey } from '@/text';
import { useInbox } from './useInbox';
import type { InboxEntry, InboxCategory, LocalNotifKind } from '@/sync/notificationInbox';
import './notifications.css';

const CATEGORY_ICON: Record<InboxCategory, typeof Bell> = {
    permission: KeyRound,
    question: MessageCircleQuestion,
    done: CheckCircle2,
    error: AlertTriangle,
};

const LOCAL_KIND_LABEL: Record<LocalNotifKind, SimpleTranslationKey> = {
    permission: 'notifications.evtPermission',
    review: 'notifications.evtReview',
    blocked: 'notifications.evtBlocked',
    needsInput: 'notifications.evtNeedsInput',
    turnDone: 'notifications.evtTurnDone',
};

/** compact mono age — machine-layer identity, deliberately not localized */
function ago(at: number, now: number): string {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

const PANEL_W = 380;

export function NotificationBell({ className }: { className?: string }) {
    const { t } = useTranslation();
    const { entries, unreadCount, markEntryRead, markAllRead } = useInbox();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<{ top: number | null; bottom: number | null; left: number } | null>(null);
    const btnRef = useRef<HTMLButtonElement | null>(null);

    const toggle = useCallback(() => {
        setOpen((was) => {
            if (!was && btnRef.current && typeof window !== 'undefined') {
                const r = btnRef.current.getBoundingClientRect();
                // The bell lives in the sidebar FOOTER now (B-065): a panel
                // dropped downward from there overflows the screen edge. Flip
                // upward whenever the bell sits in the lower half.
                const flipUp = r.bottom > window.innerHeight / 2;
                setAnchor({
                    top: flipUp ? null : r.bottom + 8,
                    bottom: flipUp ? window.innerHeight - r.top + 8 : null,
                    left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)),
                });
            }
            return !was;
        });
    }, []);

    const close = useCallback(() => setOpen(false), []);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open, close]);

    const openEntry = (entry: InboxEntry) => {
        markEntryRead(entry);
        close();
        navigate(entry.href);
    };

    const now = Date.now();

    return (
        <>
            <button
                ref={btnRef}
                className={`sb-icon-btn nc-bell-btn${className ? ` ${className}` : ''}`}
                title={t('notifications.inboxTitle')}
                aria-label={t('notifications.inboxTitle')}
                aria-expanded={open}
                onClick={toggle}
            >
                <Bell size={17} />
                {unreadCount > 0 && (
                    <span className="nc-bell-badge mono">{unreadCount > 9 ? '9+' : unreadCount}</span>
                )}
            </button>
            {open &&
                typeof document !== 'undefined' &&
                createPortal(
                    <div className="nc-layer">
                        <div className="nc-backdrop" onClick={close} />
                        <div
                            className="nc-panel"
                            role="dialog"
                            aria-label={t('notifications.inboxTitle')}
                            data-up={anchor?.bottom != null || undefined}
                            style={anchor ? ({
                                ...(anchor.top != null ? { '--nc-top': `${anchor.top}px` } : {}),
                                ...(anchor.bottom != null ? { '--nc-bottom': `${anchor.bottom}px` } : {}),
                                '--nc-left': `${anchor.left}px`,
                            } as React.CSSProperties) : undefined}
                        >
                            <header className="nc-head">
                                <span className="nc-head-title">{t('notifications.inboxTitle')}</span>
                                <span className="nc-head-actions">
                                    {unreadCount > 0 && (
                                        <button className="nc-head-btn" onClick={markAllRead} title={t('notifications.inboxMarkAllRead')}>
                                            <CheckCheck size={15} />
                                            <span className="nc-head-btn-label">{t('notifications.inboxMarkAllRead')}</span>
                                        </button>
                                    )}
                                    <button
                                        className="nc-head-btn nc-head-btn--icon"
                                        title={t('notifications.title')}
                                        aria-label={t('notifications.title')}
                                        onClick={() => {
                                            close();
                                            navigate('/settings/notifications');
                                        }}
                                    >
                                        <Settings size={15} />
                                    </button>
                                    <button className="nc-head-btn nc-head-btn--icon nc-close" onClick={close} aria-label={t('common.back')}>
                                        <X size={16} />
                                    </button>
                                </span>
                            </header>
                            <div className="nc-list">
                                {entries.length === 0 ? (
                                    <div className="nc-empty">{t('notifications.inboxEmpty')}</div>
                                ) : (
                                    entries.map((e) => {
                                        const Icon = CATEGORY_ICON[e.category];
                                        const detail =
                                            e.detail || (e.localKind ? t(LOCAL_KIND_LABEL[e.localKind]) : '');
                                        return (
                                            <button
                                                key={e.id}
                                                className={`nc-row${e.unread ? ' is-unread' : ''}`}
                                                onClick={() => openEntry(e)}
                                            >
                                                <span className={`nc-row-icon nc-cat-${e.category}`}>
                                                    <Icon size={15} />
                                                </span>
                                                <span className="nc-row-text">
                                                    <span className="nc-row-title">
                                                        {e.title || t('notifications.unknownSession')}
                                                    </span>
                                                    {detail && <span className="nc-row-detail">{detail}</span>}
                                                </span>
                                                <span className="nc-row-meta">
                                                    <span className="nc-row-time mono">{ago(e.createdAt, now)}</span>
                                                    {e.unread && <span className="nc-row-dot" aria-hidden />}
                                                </span>
                                            </button>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>,
                    document.body,
                )}
        </>
    );
}
