// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B-836: the prompt card — when it asks, that it queues as a notice, that one
// tap is a full submission, and that every answer lands in synced settings.
const state = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    settingsVersion: 3 as number | null,
    applied: [] as Array<Record<string, unknown>>,
    post: vi.fn(),
    amend: vi.fn(),
    pending: [] as unknown[],
    deepLink: false,
}));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({
    Button: ({ children, onClick, disabled }: { children: unknown; onClick: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children as string}</button>,
    Checkbox: ({ checked, onCheckedChange, children }: { checked: boolean; onCheckedChange: (v: boolean) => void; children: unknown }) => <label><input type="checkbox" checked={checked} onChange={(e) => onCheckedChange(e.target.checked)} />{children as string}</label>,
    useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/session/cmvph7gqg03ifrz2uk2cweyto', search: '', hash: '' }) }));
vi.mock('@/sync/storage', () => ({
    useSetting: (name: string) => state.settings[name],
    storage: (select: (s: { settingsVersion: number | null }) => unknown) => select({ settingsVersion: state.settingsVersion }),
    useAllMachines: () => [{ metadata: { happyCliVersion: '0.2.190', host: 'mac-office' } }],
}));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: (patch: Record<string, unknown>) => { state.applied.push(patch); Object.assign(state.settings, patch); } } }));
vi.mock('@/sync/apiFeedback', () => ({ postFeedback: state.post, amendFeedback: state.amend, FeedbackApiError: class extends Error {} }));
vi.mock('@/sync/serverConfig', () => ({ getServerInfo: () => ({ hostname: 'localhost' }) }));
vi.mock('../changelogReadStore', () => ({ usePendingChangelog: () => state.pending }));
vi.mock('../entryKind', () => ({ enteredByDeepLink: () => state.deepLink }));
vi.mock('./feedback.css', () => ({}));
vi.mock('../floatingCards.css', () => ({}));

import { FeedbackPrompt, FEEDBACK_PROMPT_DELAY_MS } from './FeedbackPrompt';
import { OVERLAY_PRIORITY, requestOverlay, resetOverlayQueueForTest } from '../overlayQueue';
import { localDay } from './feedbackPolicy';

const DAY = 24 * 60 * 60 * 1000;
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __APP_VERSION__: '2.1.0' });
    resetOverlayQueueForTest();
    state.settings = {
        feedbackActiveDays: 5,
        feedbackLastActiveDay: localDay(Date.now()),
        feedbackPromptShownAt: null,
        feedbackPromptOptOut: false,
        feedbackLastSubmittedAt: null,
    };
    state.settingsVersion = 3;
    state.applied = [];
    state.pending = [];
    state.deepLink = false;
    state.post.mockReset().mockResolvedValue({ feedback: { id: 'fb1' }, deduped: false });
    state.amend.mockReset().mockResolvedValue({ feedback: { id: 'fb1' } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetOverlayQueueForTest(); vi.useRealTimers(); });

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async () => { await act(async () => root.render(<FeedbackPrompt />)); };
const wait = async (ms = FEEDBACK_PROMPT_DELAY_MS) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };
const card = () => host.querySelector('.fb-prompt');
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

describe('FeedbackPrompt (B-836)', () => {
    it('asks after the quiet delay once due, and records the showing in synced settings', async () => {
        await mount();
        expect(card()).toBeNull();
        await wait(FEEDBACK_PROMPT_DELAY_MS - 1);
        expect(card()).toBeNull();
        await wait(1);
        expect(card()?.textContent).toContain('feedback.promptTitle');
        expect(state.applied).toContainEqual({ feedbackPromptShownAt: expect.any(Number) });
    });

    it('never asks a new user, a deep-link load, or while release notes are unread', async () => {
        for (const setup of [
            () => { state.settings.feedbackActiveDays = 4; },
            () => { state.deepLink = true; },
            () => { state.pending = [{ id: 'oct27a' }]; },
            () => { state.settings.feedbackPromptShownAt = Date.now() - 29 * DAY; },
            () => { state.settings.feedbackPromptOptOut = true; },
        ]) {
            resetOverlayQueueForTest();
            await act(async () => root.unmount());
            root = createRoot(host);
            setup();
            await mount();
            await wait();
            expect(card()).toBeNull();
            state.settings.feedbackActiveDays = 5; state.deepLink = false; state.pending = [];
            state.settings.feedbackPromptShownAt = null; state.settings.feedbackPromptOptOut = false;
        }
    });

    it('counts today once, and only after server settings loaded', async () => {
        state.settings.feedbackLastActiveDay = '2020-01-01';
        state.settingsVersion = null;
        await mount();
        expect(state.applied).toEqual([]);
        state.settingsVersion = 3;
        await mount();
        expect(state.applied).toContainEqual({ feedbackActiveDays: 6, feedbackLastActiveDay: localDay(Date.now()) });
    });

    it('is a notice: waits behind an interaction overlay and steps aside for a critical one', async () => {
        const release = requestOverlay('task-dialog', OVERLAY_PRIORITY.interaction);
        await mount();
        await wait();
        expect(card()).toBeNull();
        await act(async () => release());
        expect(card()).not.toBeNull();
        const releaseCritical = requestOverlay('auth', OVERLAY_PRIORITY.critical);
        await flush();
        expect(card()).toBeNull();
        await act(async () => releaseCritical());
        expect(card()).not.toBeNull();
    });

    it('one tap submits (no diagnostics until seen); details are optional and amend that row', async () => {
        await mount();
        await wait();
        await act(async () => button('feedback.ratingBad')!.click());
        await flush();
        expect(state.post).toHaveBeenCalledWith({ rating: 'bad', source: 'prompt' });
        expect(state.applied).toContainEqual({ feedbackLastSubmittedAt: expect.any(Number) });
        expect(card()?.textContent).toContain('feedback.promptThanks');

        const textarea = host.querySelector('textarea')!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(textarea, 'Sidebar jumps');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => button('feedback.promptSendDetails')!.click());
        await flush();
        expect(state.amend).toHaveBeenCalledTimes(1);
        const [id, body] = state.amend.mock.calls[0];
        expect(id).toBe('fb1');
        expect(body.text).toBe('Sidebar jumps');
        // the payload the card showed: route as a pattern, CLI version only — no machine name
        expect(body.diagnostics).toMatchObject({ route: '/session/:id', cliVersions: ['0.2.190'], webVersion: '2.1.0' });
        expect(JSON.stringify(body.diagnostics)).not.toContain('mac-office');
        expect(card()).toBeNull();
    });

    it('完成 after a tap closes without a second request', async () => {
        await mount();
        await wait();
        await act(async () => button('feedback.ratingGood')!.click());
        await flush();
        await act(async () => button('feedback.promptDone')!.click());
        expect(card()).toBeNull();
        expect(state.amend).not.toHaveBeenCalled();
    });

    it('以后再说 only closes; 不再提示 opts out on every device', async () => {
        await mount();
        await wait();
        await act(async () => button('feedback.promptLater')!.click());
        expect(card()).toBeNull();
        expect(state.applied.some((p) => 'feedbackPromptOptOut' in p)).toBe(false);

        await act(async () => root.unmount());
        root = createRoot(host);
        resetOverlayQueueForTest();
        state.settings.feedbackPromptShownAt = null;
        await mount();
        await wait();
        await act(async () => button('feedback.promptNever')!.click());
        expect(card()).toBeNull();
        expect(state.applied).toContainEqual({ feedbackPromptOptOut: true });
    });

    it('waits while an onboarding card owns the corner instead of showing hidden behind it', async () => {
        const optIn = document.createElement('aside');
        optIn.className = 'notif-optin';
        document.body.append(optIn);
        await mount();
        await wait();
        expect(card()).toBeNull();
        expect(state.applied.some((p) => 'feedbackPromptShownAt' in p)).toBe(false);
        optIn.remove();
        await wait(5_000);
        expect(card()).not.toBeNull();
    });

    it('waits while the person is typing, then asks', async () => {
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
        await mount();
        await wait();
        expect(card()).toBeNull();
        input.blur();
        input.remove();
        await wait(5_000);
        expect(card()).not.toBeNull();
    });
});
