// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// QA16 P2-2: the inbox filters by rating in the UI, and 未读 / 全部 stacks with it.
const state = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('./SettingsLayout', () => ({
    SettingsPage: ({ children }: { children: unknown }) => <div>{children as string}</div>,
    SettingsHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@/app/feedback/FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('@/app/feedback/feedback.css', () => ({}));
vi.mock('@/sync/apiFeedback', () => ({ listFeedback: state.list, markFeedbackRead: vi.fn(), fetchFeedbackAdminAccess: vi.fn() }));

import { FeedbackInbox, feedbackInboxQuery } from './FeedbackSettings';

const row = (id: string, rating: string) => ({ id, rating, text: id, diagnostics: null, source: 'manual', createdAt: 0, readAt: null, account: { id: 'a', displayName: 'A', username: 'a', email: null } });

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    state.list.mockReset().mockImplementation(async (q: { rating: string | null }) => ({ items: [row(`r-${q.rating ?? 'any'}`, q.rating ?? 'good')], nextCursor: null, unreadCount: 1 }));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const group = (label: string) => host.querySelector(`[role="group"][aria-label="${label}"]`)!;
const press = async (label: string, option: string) => {
    const button = [...group(label).querySelectorAll('button')].find((b) => b.textContent === option)!;
    await act(async () => { button.click(); });
    await flush();
};

describe('feedbackInboxQuery', () => {
    it('maps 全部评分 to no rating and keeps the read filter', () => {
        expect(feedbackInboxQuery('unread', 'all', null)).toEqual({ cursor: null, unread: true, rating: null });
        expect(feedbackInboxQuery('all', 'bad', 'c1')).toEqual({ cursor: 'c1', unread: false, rating: 'bad' });
    });
});

describe('FeedbackInbox filters', () => {
    it('offers 全部 / 好用 / 一般 / 不好用 and stacks it with 未读 / 全部', async () => {
        await act(async () => root.render(<FeedbackInbox />));
        await flush();
        expect([...group('feedback.filterRatingLabel').querySelectorAll('button')].map((b) => b.textContent))
            .toEqual(['feedback.filterAllRatings', 'feedback.ratingGood', 'feedback.ratingOk', 'feedback.ratingBad']);
        expect(state.list).toHaveBeenLastCalledWith({ cursor: null, unread: true, rating: null });

        await press('feedback.filterRatingLabel', 'feedback.ratingBad');
        expect(state.list).toHaveBeenLastCalledWith({ cursor: null, unread: true, rating: 'bad' });
        expect(host.querySelector('.fb-inbox-row')?.getAttribute('data-rating')).toBe('bad');

        await press('feedback.filterReadLabel', 'feedback.filterAll');
        expect(state.list).toHaveBeenLastCalledWith({ cursor: null, unread: false, rating: 'bad' });

        await press('feedback.filterRatingLabel', 'feedback.filterAllRatings');
        expect(state.list).toHaveBeenLastCalledWith({ cursor: null, unread: false, rating: null });
        expect(group('feedback.filterReadLabel').querySelector('[aria-pressed="true"]')?.textContent).toBe('feedback.filterAll');
    });
});
