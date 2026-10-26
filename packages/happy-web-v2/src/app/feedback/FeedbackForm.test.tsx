// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B-836: what the form shows under 查看具体发送内容 is exactly what it sends,
// and unticking 附带诊断信息 sends none.
const state = vi.hoisted(() => ({ post: vi.fn(), applied: [] as Array<Record<string, unknown>>, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, p?: { server?: string }) => (p?.server ? `${key}:${p.server}` : key), lang: 'en' }) }));
vi.mock('@/ui', () => ({
    Button: ({ children, onClick, disabled, type }: { children: unknown; onClick?: () => void; disabled?: boolean; type?: 'submit' | 'button' }) => <button type={type} disabled={disabled} onClick={onClick}>{children as string}</button>,
    Checkbox: ({ checked, onCheckedChange, children }: { checked: boolean; onCheckedChange: (v: boolean) => void; children: unknown }) => <label><input type="checkbox" checked={checked} onChange={(e) => onCheckedChange(e.target.checked)} />{children as string}</label>,
    useToast: () => state.toast,
}));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => [{ metadata: { happyCliVersion: '0.2.190' } }, { metadata: { happyCliVersion: '0.2.188' } }] }));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: (p: Record<string, unknown>) => state.applied.push(p) } }));
vi.mock('@/sync/serverConfig', () => ({ getServerInfo: () => ({ hostname: 'relay.example' }) }));
vi.mock('@/sync/apiFeedback', () => ({
    postFeedback: state.post,
    FeedbackApiError: class FeedbackApiError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } },
}));
vi.mock('./feedbackDiagnostics', async (importOriginal) => ({ ...(await importOriginal<typeof import('./feedbackDiagnostics')>()), feedbackLastRoute: () => '/projects/42?tab=x' }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/settings/feedback' }) }));
vi.mock('./feedback.css', () => ({}));

import { FeedbackForm } from './FeedbackForm';
import { FeedbackApiError } from '@/sync/apiFeedback';
import { EXTERNAL_LINK, NEW_ISSUE_URL } from '@/app/attribution';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __APP_VERSION__: '2.1.0' });
    state.post.mockReset().mockResolvedValue({ feedback: { id: 'x' }, deduped: false });
    state.applied = [];
    state.toast.success.mockReset(); state.toast.error.mockReset();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const typeText = async (value: string) => {
    const textarea = host.querySelector('textarea')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const submit = async () => { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await flush(); };

describe('FeedbackForm (B-836)', () => {
    it('needs a rating; sends text and the diagnostics exactly as shown', async () => {
        await act(async () => root.render(<FeedbackForm />));
        expect(button('feedback.submit').disabled).toBe(true);
        await act(async () => button('feedback.ratingOk').click());
        await typeText('  The diff panel is slow  ');
        await act(async () => button('feedback.showDiagnostics').click());
        const shown = JSON.parse(host.querySelector('.fb-diag-json')!.textContent!);
        expect(shown).toMatchObject({ webVersion: '2.1.0', cliVersions: ['0.2.188', '0.2.190'], route: '/projects/:id' });
        expect(Object.keys(shown).sort()).toEqual(['cliVersions', 'language', 'pointer', 'route', 'timeZone', 'ts', 'userAgent', 'viewport', 'webVersion']);
        await submit();
        expect(state.post).toHaveBeenCalledWith({ rating: 'ok', text: 'The diff panel is slow', diagnostics: shown, source: 'manual' });
        expect(state.applied).toContainEqual({ feedbackLastSubmittedAt: expect.any(Number) });
        expect(state.toast.success).toHaveBeenCalledWith('feedback.sent');
    });

    it('unticked diagnostics are not sent', async () => {
        await act(async () => root.render(<FeedbackForm />));
        await act(async () => button('feedback.ratingGood').click());
        const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        expect(box.checked).toBe(true);
        await act(async () => box.click());
        await submit();
        expect(state.post).toHaveBeenCalledWith({ rating: 'good', text: null, diagnostics: null, source: 'manual' });
    });

    it('rate limited: says so and keeps what was typed', async () => {
        state.post.mockRejectedValue(new FeedbackApiError('feedback_rate_limited', 429));
        await act(async () => root.render(<FeedbackForm />));
        await act(async () => button('feedback.ratingBad').click());
        await typeText('again');
        await submit();
        expect(state.toast.error).toHaveBeenCalledWith('feedback.rateLimited');
        expect(host.querySelector('textarea')!.value).toBe('again');
    });

    it('links to GitHub issues and names the server the feedback stays on', async () => {
        await act(async () => root.render(<FeedbackForm />));
        const github = host.querySelector<HTMLAnchorElement>('a.fb-github')!;
        expect(github.href).toBe(NEW_ISSUE_URL);
        expect(github.target).toBe(EXTERNAL_LINK.target);
        expect(github.rel).toBe(EXTERNAL_LINK.rel);
        expect(host.querySelector('.fb-privacy')!.textContent).toBe('feedback.privacy:relay.example');
    });
});
