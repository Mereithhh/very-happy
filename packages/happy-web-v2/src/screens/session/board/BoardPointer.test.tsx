// @vitest-environment happy-dom
/**
 * B-915c (QA81 P3): the transcript pointer for a 收尾 / 交接 item is titled
 * in the reader's language from kind + payload status, like its board card —
 * never the English title the CLI stored.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';

const h = vi.hoisted(() => ({ lang: 'zh-Hans' }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: h.lang }) }));
vi.mock('@/sync/attentionStore', () => ({ useAttentionStore: { getState: () => ({ focusItem: vi.fn() }) } }));
vi.mock('@/sync/storage', () => ({ useSession: () => undefined, storage: { getState: () => ({ sessions: {} }) } }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));
vi.mock('@/ui/Toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../Markdown', () => ({ Markdown: () => null }));
const { BoardPointer, boardPointerTitle } = await import('./BoardPointer');
const { boardCopy } = await import('./boardCopy');

const base: AttentionItem = {
    id: 'w1', sessionId: 's', teamId: null, projectId: null, source: 'agent', kind: 'wrapup', key: 'wrapup', title: 'Wrapping up…',
    bodyMd: null, options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: false,
    state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1,
    resolvedAt: null, pushedAt: null, version: 1,
    payload: { v: 1, mode: 'wrapup', status: 'running' },
} as AttentionItem;

describe('boardPointerTitle', () => {
    const zh = boardCopy(true);
    const en = boardCopy(false);
    it('a running wrap-up reads 收尾中… in zh-CN, not the stored English title', () => {
        expect(boardPointerTitle(base, zh)).toBe('收尾中…');
        expect(boardPointerTitle(base, en)).toBe(en.wrapup.running);
    });
    it('an incomplete wrap-up / handoff reads 收尾未完成 / its handoff copy', () => {
        expect(boardPointerTitle({ ...base, title: 'Wrap-up incomplete', payload: { v: 1, mode: 'wrapup', status: 'incomplete' } }, zh)).toBe('收尾未完成');
        expect(boardPointerTitle({ ...base, payload: { v: 1, mode: 'handoff', status: 'incomplete' } }, zh)).toBe(zh.wrapup.handoffIncomplete);
    });
    it('a finished wrap-up follows the board card headline', () => {
        expect(boardPointerTitle({ ...base, title: 'Can close', payload: { v: 1, mode: 'wrapup', status: 'done', canClose: true } }, zh)).toBe(zh.wrapup.canClose);
    });
    it('other kinds keep their own title', () => {
        expect(boardPointerTitle({ ...base, kind: 'report', title: 'Shipped', payload: null }, zh)).toBe('Shipped');
    });
});

describe('BoardPointer', () => {
    let root: Root | null = null;
    afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });
    it('renders the localized wrap-up title in the transcript', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => root!.render(<BoardPointer item={base} onOpen={() => {}} />));
        expect(host.querySelector('.brf-ptr-title')?.textContent).toBe('收尾中…');
        expect(host.textContent).not.toContain('Wrapping up');
    });
});
