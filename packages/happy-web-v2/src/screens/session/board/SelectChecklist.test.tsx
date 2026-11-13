// @vitest-environment happy-dom
/**
 * B-924: a decision card with a select checklist — ticks go through
 * owner-respond check (undone on failure), only while the card is open;
 * a closed card shows what was ticked, read-only.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';

const h = vi.hoisted(() => ({
    respond: vi.fn(),
    applied: [] as unknown[],
    toastError: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({
    useMessage: () => undefined,
    useSession: () => undefined,
    storage: { getState: () => ({ sessions: {} }) },
}));
vi.mock('@/sync/apiAttention', () => ({ respondToAttentionItem: h.respond }));
vi.mock('@/sync/attentionStore', () => ({
    useAttentionStore: { getState: () => ({ apply: (item: unknown) => h.applied.push(item) }) },
    loadAttentionItems: vi.fn(async () => {}),
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: vi.fn() } }));
vi.mock('@/ui/Toast', () => ({ toast: { error: h.toastError, show: vi.fn(), success: vi.fn() } }));
vi.mock('../Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock('../messageQuote', () => ({ quoteMessage: vi.fn() }));
const { BoardCard } = await import('./BoardCard');
const { boardCopy } = await import('./boardCopy');

const base: AttentionItem = {
    id: 'd1', sessionId: 'main', teamId: null, projectId: null, source: 'agent', kind: 'decision', key: 'main-agent-wrapup:2026-11-11',
    title: '可以收尾的会话', bodyMd: null, options: [{ id: 'wrapup', label: '收尾所选' }, { id: 'skip', label: '这次不用' }], links: null,
    anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null,
    resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: null, version: 2,
    payload: {
        v: 1, type: 'select', items: [
            { id: 'a', label: 'Fix login', detail: 'idle 14h', ref: 's-a', checked: false },
            { id: 'b', label: 'Docs pass', checked: true },
        ],
    },
};
const noop = { onToggle: () => {}, onChoose: () => {}, onResolve: () => {}, onLocate: () => {}, onFollowUp: () => {} };

let root: Root | null = null;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    h.respond.mockReset();
    h.applied.length = 0;
    h.toastError.mockClear();
});
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = '';
});
async function render(item: AttentionItem) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<MemoryRouter><BoardCard item={item} all={[item]} copy={boardCopy(true)} expanded selected={false} unread={false} actions={noop} /></MemoryRouter>));
    return host;
}

describe('decision checklist (B-924)', () => {
    it('open: label + detail above the options, editable', async () => {
        const host = await render(base);
        const checks = [...host.querySelectorAll('.sel-check')];
        expect(checks.map((c) => c.querySelector('.sel-text > span')?.textContent)).toEqual(['Fix login', 'Docs pass']);
        expect(host.querySelector('.sel-detail')?.textContent).toBe('idle 14h');
        expect(host.querySelector('.sel .wrp-label')?.textContent).toBe(boardCopy(true).select.title);
        // the checklist comes before the option buttons
        const sel = host.querySelector('.sel')!;
        const opts = host.querySelector('.brf-opts')!;
        expect(sel.compareDocumentPosition(opts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect((checks[0].querySelector('input') as HTMLInputElement).disabled).toBe(false);
        expect((checks[1].querySelector('input') as HTMLInputElement).checked).toBe(true);
    });

    it('tick: owner-respond check, optimistic; a failure puts the card back and says so', async () => {
        const host = await render(base);
        h.respond.mockResolvedValueOnce({ item: { ...base, version: 3 } });
        const box = host.querySelector('.sel-check input') as HTMLInputElement;
        await act(async () => box.click());
        expect(h.respond).toHaveBeenCalledWith('d1', { action: 'check', checkId: 'a', checked: true });
        expect((h.applied[0] as { payload: { items: { checked: boolean }[] } }).payload.items[0].checked).toBe(true);
        expect((h.applied[1] as AttentionItem).version).toBe(3);

        h.applied.length = 0;
        h.respond.mockRejectedValueOnce(new Error('409'));
        await act(async () => box.click());
        expect(h.applied.at(-1)).toBe(base);
        expect(h.toastError).toHaveBeenCalledWith(boardCopy(true).select.checkFailed);
    });

    it('closed: read-only result with the ticked count', async () => {
        const host = await render({ ...base, state: 'resolved', ownerChoice: 'wrapup', resolvedBy: 'owner', resolvedAt: 5 });
        expect(host.querySelector('.sel')?.classList.contains('is-readonly')).toBe(true);
        expect(host.querySelector('.sel .wrp-label')?.textContent).toBe('已勾选 1 / 2');
        expect([...host.querySelectorAll('.sel-check input')].every((i) => (i as HTMLInputElement).disabled)).toBe(true);
    });

    it('a decision without a select payload renders no checklist', async () => {
        const host = await render({ ...base, payload: undefined });
        expect(host.querySelector('.sel')).toBeNull();
    });
});
