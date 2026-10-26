// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B-825: a confirmed auth failure signs the browser out locally (account key +
// vh-sync-* cache) — at once with nothing unsent, after showing the unsent
// inputs otherwise; anything that is not a latch never gets here.
const state = vi.hoisted(() => ({ unsent: [] as Array<{ sessionId: string; localId: string; text: string | null }>, logout: vi.fn(async () => {}) }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, params?: { count?: number }) => params?.count !== undefined ? `${key}:${params.count}` : key, lang: 'en' }) }));
vi.mock('@/ui', () => ({
    Button: ({ children, onClick, disabled }: { children: unknown; onClick: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children as string}</button>,
    CopyButton: ({ text, label }: { text: string; label: string }) => <button data-copy={text}>{label}</button>,
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ logout: state.logout }) }));
vi.mock('@/app/authReturnTarget', () => ({ persistAuthReturnTarget: vi.fn() }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/session/s1', search: '', hash: '' }) }));
vi.mock('@/sync/sync', () => ({ sync: { unsentOutboxMessages: async () => state.unsent } }));
vi.mock('./authExpiredNotice.css', () => ({}));

import { AuthExpiredNotice } from './AuthExpiredNotice';
import { resetAuthLatch, tripAuthLatch } from '@/auth/authLatch';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    resetAuthLatch();
    state.unsent = [];
    state.logout.mockClear();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetAuthLatch(); });

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);

describe('AuthExpiredNotice (B-825)', () => {
    it('renders nothing and signs nobody out while the latch is open', async () => {
        await act(async () => root.render(<AuthExpiredNotice />));
        await flush();
        expect(host.innerHTML).toBe('');
        expect(state.logout).not.toHaveBeenCalled();
    });

    it('nothing unsent: a tripped latch signs out locally right away (key + cache wipe, back to login)', async () => {
        await act(async () => root.render(<AuthExpiredNotice />));
        await act(async () => tripAuthLatch({ status: 401, path: '/v1/kv' }));
        await flush();
        expect(state.logout).toHaveBeenCalledTimes(1);
    });

    it('unsent inputs: listed with a copy action, and the wipe waits for the user', async () => {
        state.unsent = [
            { sessionId: 's1', localId: 'l1', text: 'first draft' },
            { sessionId: 's1', localId: 'l2', text: null },
            { sessionId: 's2', localId: 'l3', text: 'second' },
        ];
        await act(async () => root.render(<AuthExpiredNotice />));
        await act(async () => tripAuthLatch({ status: 401, path: '/v1/kv' }));
        await flush();
        expect(state.logout).not.toHaveBeenCalled();
        expect(host.textContent).toContain('authExpired.unsentBody:3');
        const items = [...host.querySelectorAll('[data-testid="auth-expired-unsent"] li')].map((li) => li.textContent);
        expect(items).toEqual(['first draft', 'authExpired.unsentNoText', 'second']);
        expect(button('authExpired.copyUnsent')?.getAttribute('data-copy')).toBe('first draft\n\nsecond');

        await act(async () => button('authExpired.discardAndSignIn')!.click());
        await act(async () => button('authExpired.discardAndSignIn')?.click());
        expect(state.logout).toHaveBeenCalledTimes(1);
    });
});
