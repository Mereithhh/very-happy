/**
 * Settings → 发送反馈 (B-836, specs/2026-10-feedback.md): the feedback form
 * for everyone, plus 收到的反馈 for the accounts this server lists in
 * VH_FEEDBACK_ADMIN_ACCOUNT_IDS (the server answers /admin/access).
 *
 * Separate file on purpose: SettingsRoutes.tsx is a declared conflict
 * hot-zone — it only gains an import and two <Route> lines.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { SettingsPage as Page, SettingsHeader as Header } from './SettingsLayout';
import { ItemList, ItemGroup, Item, Button, Segmented } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { FeedbackForm } from '@/app/feedback/FeedbackForm';
import { fetchFeedbackAdminAccess, listFeedback, markFeedbackRead, type FeedbackAdminItem } from '@/sync/apiFeedback';
import type { FeedbackRating } from '@/app/feedback/feedbackPolicy';
import '@/app/feedback/feedback.css';

function useFeedbackAdmin(): boolean {
    const [admin, setAdmin] = useState(false);
    useEffect(() => {
        let alive = true;
        void fetchFeedbackAdminAccess().then((value) => { if (alive) setAdmin(value); });
        return () => { alive = false; };
    }, []);
    return admin;
}

export function FeedbackSettings() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const admin = useFeedbackAdmin();
    const [unread, setUnread] = useState(0);
    useEffect(() => {
        if (!admin) return;
        listFeedback({ unread: true, limit: 1 }).then((r) => setUnread(r.unreadCount), () => undefined);
    }, [admin]);
    return (
        <Page>
            <Header title={t('feedback.title')} subtitle={t('feedback.subtitle')} />
            <ItemList>
                <ItemGroup settingId="feedback.form" title={t('feedback.title')}>
                    <FeedbackForm />
                </ItemGroup>
                {admin && (
                    <ItemGroup>
                        <Item left={<Inbox size={16} />} title={t('feedback.inboxEntry', { count: unread })} onClick={() => navigate('/settings/feedback/inbox')} />
                    </ItemGroup>
                )}
            </ItemList>
        </Page>
    );
}

const RATING_KEY = { good: 'feedback.ratingGood', ok: 'feedback.ratingOk', bad: 'feedback.ratingBad' } as const;

function formatTime(ms: number, lang: string): string {
    return new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

function FeedbackRow({ item, onToggleRead }: { item: FeedbackAdminItem; onToggleRead: (item: FeedbackAdminItem) => Promise<void> }) {
    const { t, lang } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    // Name plus whatever tells two people apart: email, else the @handle when it is not already the name.
    const handle = item.account.username && item.account.username !== item.account.displayName ? `@${item.account.username}` : null;
    const who = [item.account.displayName, item.account.email ?? handle].filter(Boolean).join(' · ');
    return (
        <article className="fb-inbox-row" data-read={item.readAt !== null} data-rating={item.rating}>
            <header className="fb-inbox-head">
                <span className="fb-inbox-rating">{t(RATING_KEY[item.rating])}</span>
                <span className="fb-inbox-who" title={item.account.id}>{who}</span>
                <span className="fb-inbox-meta">{formatTime(item.createdAt, lang)}{item.source === 'prompt' ? ` · ${t('feedback.fromPrompt')}` : ''}</span>
            </header>
            <p className="fb-inbox-text">{item.text ?? t('feedback.noText')}</p>
            <div className="fb-inbox-actions">
                {item.diagnostics && (
                    <button type="button" className="fb-diag-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{t('feedback.diagnostics')}</button>
                )}
                <Button type="button" variant="ghost" size="sm" loading={busy} onClick={async () => { setBusy(true); try { await onToggleRead(item); } finally { setBusy(false); } }}>
                    {item.readAt === null ? t('feedback.markRead') : t('feedback.markUnread')}
                </Button>
            </div>
            {open && item.diagnostics && <pre className="fb-diag-json mono">{JSON.stringify(item.diagnostics, null, 2)}</pre>}
        </article>
    );
}

/** 未读 / 全部 and the rating filter stack: both go to the server in one query (QA16 P2-2). */
export function feedbackInboxQuery(filter: 'all' | 'unread', rating: FeedbackRating | 'all', cursor: string | null) {
    return { cursor, unread: filter === 'unread', rating: rating === 'all' ? null : rating };
}

/** Settings → 发送反馈 → 收到的反馈: admin-only list, newest first. Non-admins get the server's 404. */
export function FeedbackInbox() {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<'all' | 'unread'>('unread');
    const [rating, setRating] = useState<FeedbackRating | 'all'>('all');
    const [items, setItems] = useState<FeedbackAdminItem[] | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const [unread, setUnread] = useState(0);
    const [error, setError] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    const load = useCallback(async (from: string | null) => {
        const page = await listFeedback(feedbackInboxQuery(filter, rating, from));
        setItems((prev) => (from && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setUnread(page.unreadCount);
        setError(false);
    }, [filter, rating]);
    useEffect(() => { setItems(null); load(null).catch(() => setError(true)); }, [load]);

    const toggleRead = async (item: FeedbackAdminItem) => {
        const { feedback } = await markFeedbackRead(item.id, item.readAt === null);
        setItems((prev) => prev?.map((row) => (row.id === item.id ? { ...row, readAt: feedback.readAt } : row)) ?? prev);
        setUnread((n) => Math.max(0, n + (feedback.readAt === null ? 1 : -1)));
    };

    return (
        <Page>
            <Header title={t('feedback.inboxTitle')} subtitle={t('feedback.inboxEntry', { count: unread })} />
            <div className="fb-inbox">
                <div className="fb-inbox-filters">
                    <Segmented label={t('feedback.filterReadLabel')} value={filter} onChange={setFilter}
                        options={[{ value: 'unread', label: t('feedback.filterUnread') }, { value: 'all', label: t('feedback.filterAll') }]} />
                    <Segmented label={t('feedback.filterRatingLabel')} value={rating} onChange={setRating}
                        options={[{ value: 'all', label: t('feedback.filterAllRatings') }, ...(['good', 'ok', 'bad'] as const).map((value) => ({ value, label: t(RATING_KEY[value]) }))]} />
                </div>
                {error ? <p className="fb-inbox-empty">{t('feedback.loadFailed')}</p>
                    : items === null ? <p className="fb-inbox-empty">{t('common.loading')}</p>
                    : items.length === 0 ? <p className="fb-inbox-empty">{t('feedback.inboxEmpty')}</p>
                    : items.map((item) => <FeedbackRow key={item.id} item={item} onToggleRead={toggleRead} />)}
                {cursor && (
                    <Button type="button" variant="secondary" loading={loadingMore} onClick={async () => { setLoadingMore(true); try { await load(cursor); } catch { setError(true); } finally { setLoadingMore(false); } }}>
                        {t('feedback.loadMore')}
                    </Button>
                )}
            </div>
        </Page>
    );
}
