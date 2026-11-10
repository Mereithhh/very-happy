// @vitest-environment happy-dom
/**
 * B-914: the 「发送」 button on a ```draft card — shown only where a composer
 * can send (not in a read-only shared view), sends 「发」 + the title once,
 * then stays 「已请求发送」 (also after a remount).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({
    useTranslation: () => ({ t: (key: string, args?: { title?: string }) => (args?.title !== undefined ? `${key}|${args.title}` : key) }),
}));
vi.mock('@/sync/editableDraftsStore', async () => {
    const { create } = await import('zustand');
    const useEditableDrafts = create(() => ({ drafts: {} as Record<string, unknown>, loaded: {}, saves: {} as Record<string, unknown> }));
    return { useEditableDrafts, editDraft: vi.fn(), ensureDraftsLoaded: vi.fn(), retryDraftSave: vi.fn() };
});

import { DraftBlock, DraftScopeProvider } from './DraftBlock';
import { __resetDraftSendForTests, onDraftSendRequest } from './draftSendRequest';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    __resetDraftSendForTests();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

function render(seq = 4) {
    act(() => root.render(
        <DraftScopeProvider sessionId="s1" seq={seq}><DraftBlock code={'Hi Alex,\nSee you Monday.'} title="Reply to Alex" /></DraftScopeProvider>,
    ));
}
const button = () => host.querySelector<HTMLButtonElement>('.dft-send');

describe('draft card 「发送」', () => {
    it('is hidden when no composer can send for this session (read-only shared view)', () => {
        render();
        expect(host.querySelector('.dft')).not.toBeNull();
        expect(button()).toBeNull();
    });

    it('sends 「发」 with the draft title once, then shows 「已请求发送」 and ignores repeat clicks', async () => {
        const sender = vi.fn(async () => true);
        const off = onDraftSendRequest('s1', sender);
        render();
        expect(button()?.textContent).toBe('session.chat.draft.send');
        await act(async () => { button()!.click(); });
        expect(sender).toHaveBeenCalledExactlyOnceWith('session.chat.draft.sendMessage|Reply to Alex');
        expect(button()!.disabled).toBe(true);
        expect(button()!.textContent).toBe('session.chat.draft.sendRequested');
        await act(async () => { button()!.click(); });
        expect(sender).toHaveBeenCalledTimes(1);
        // The transcript virtualizes: a remounted card still remembers.
        act(() => root.unmount());
        root = createRoot(host);
        render();
        expect(button()!.textContent).toBe('session.chat.draft.sendRequested');
        expect(button()!.disabled).toBe(true);
        act(() => { off(); });
    });

    it('a refused send gives the button back', async () => {
        const off = onDraftSendRequest('s1', async () => false);
        render();
        await act(async () => { button()!.click(); });
        expect(button()!.disabled).toBe(false);
        expect(button()!.textContent).toBe('session.chat.draft.send');
        act(() => { off(); });
    });

    it('another draft (different message) is independent', async () => {
        const off = onDraftSendRequest('s1', async () => true);
        render(4);
        await act(async () => { button()!.click(); });
        act(() => root.unmount());
        root = createRoot(host);
        render(5);
        expect(button()!.textContent).toBe('session.chat.draft.send');
        act(() => { off(); });
    });
});
