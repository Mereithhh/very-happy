// @vitest-environment happy-dom
/**
 * B-915: the 收尾 / 交接 card as rendered on the 汇报板 — running, a result
 * with 待确认 checkboxes (tick → owner-respond check, undone on failure), and
 * a failed handoff in red that offers no archive of its own.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';

const h = vi.hoisted(() => ({
    respond: vi.fn(),
    applied: [] as unknown[],
    session: { id: 's', archivedAt: null, active: true, metadata: null } as Record<string, unknown> | undefined,
    confirm: vi.fn(async () => false),
    toastError: vi.fn(),
    startWrapup: vi.fn(async () => 'sent'),
    openHandoff: vi.fn(),
}));
vi.mock('@/app/sessionWrapup', () => ({ startWrapup: h.startWrapup, openHandoffDialog: h.openHandoff }));
vi.mock('@/sync/storage', () => ({
    useMessage: () => undefined,
    useSession: () => h.session,
    storage: { getState: () => ({ sessions: { s: h.session } }) },
}));
vi.mock('@/sync/apiAttention', () => ({ respondToAttentionItem: h.respond }));
vi.mock('@/sync/attentionStore', () => ({
    useAttentionStore: { getState: () => ({ apply: (item: unknown) => h.applied.push(item) }) },
    loadAttentionItems: vi.fn(async () => {}),
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { confirm: h.confirm } }));
vi.mock('@/ui/Toast', () => ({ toast: { error: h.toastError, show: vi.fn(), success: vi.fn() } }));
vi.mock('../Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock('../messageQuote', () => ({ quoteMessage: vi.fn() }));
const { BoardCard } = await import('./BoardCard');
const { boardCopy } = await import('./boardCopy');
const { archiveFromWrapupCard } = await import('./WrapupCard');

const base: AttentionItem = {
    id: 'w1', sessionId: 's', teamId: null, projectId: null, source: 'agent', kind: 'wrapup', key: 'wrapup', title: 'raw title',
    bodyMd: null, options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true,
    state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1,
    resolvedAt: null, pushedAt: null, version: 3,
    payload: {
        v: 1, mode: 'wrapup', status: 'done', summary: 'Fixed the login bug.', canClose: true,
        files: ['src/a.ts', 'src/b.ts'], commits: [{ sha: 'a1b2c3d4e5', subject: 'fix login', repo: 'owner/repo' }, { sha: 'ffffff1', subject: 'docs' }],
        pending: [{ id: 'p1', label: 'publish npm?', checked: false }],
    },
};
const noop = { onToggle: () => {}, onChoose: () => {}, onResolve: () => {}, onLocate: () => {}, onFollowUp: () => {} };

let root: Root | null = null;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    h.respond.mockReset();
    h.applied.length = 0;
    h.session = { id: 's', archivedAt: null, active: true, metadata: null };
    h.confirm.mockClear();
    h.toastError.mockClear();
    h.startWrapup.mockClear();
    h.openHandoff.mockClear();
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

describe('收尾 card (B-915)', () => {
    it('running: titled 收尾中…, a 在做 chip, no archive yet', async () => {
        const host = await render({ ...base, needsOwner: false, payload: { v: 1, mode: 'wrapup', status: 'running' } });
        expect(host.querySelector('.brf-kind')?.textContent).toBe('收尾');
        expect(host.querySelector('.brf-title')?.textContent).toBe('收尾中…');
        expect(host.querySelector('.brf-status')?.textContent).toBe('在做');
        expect(host.querySelector('.wrp-archive-btn')).toBeNull();
    });

    it('result: unconfirmed count in the title, summary, files folded, GitHub commit link, checkbox, archive', async () => {
        const host = await render(base);
        expect(host.querySelector('.brf-title')?.textContent).toBe('1 项待确认');
        expect(host.querySelector('.wrp-summary')?.textContent).toBe('Fixed the login bug.');
        expect(host.querySelector('.wrp-fold')?.textContent).toBe('文件（2）');
        expect(host.querySelector('.wrp-paths')).toBeNull();
        await act(async () => (host.querySelector('.wrp-fold') as HTMLButtonElement).click());
        expect([...host.querySelectorAll('.wrp-paths code')].map((c) => c.textContent)).toEqual(['src/a.ts', 'src/b.ts']);
        const shas = [...host.querySelectorAll('.wrp-sha')];
        expect(shas.map((s) => s.textContent)).toEqual(['a1b2c3d', 'ffffff1']);
        expect((shas[0] as HTMLAnchorElement).href).toBe('https://github.com/owner/repo/commit/a1b2c3d4e5');
        expect(shas[1].tagName).toBe('CODE');
        expect(host.querySelector('.wrp-check')?.textContent).toContain('publish npm?');
        expect(host.querySelector('.wrp-archive-btn')?.textContent).toBe('归档会话');
        // 知道了 sets the card aside without archiving
        expect([...host.querySelectorAll('.brf-acts button')].map((b) => b.textContent)).toContain('知道了');
    });

    it('all confirmed + can close → 可以关闭', async () => {
        const host = await render({ ...base, payload: { ...(base.payload as object), pending: [{ id: 'p1', label: 'x', checked: true }] } });
        expect(host.querySelector('.brf-title')?.textContent).toBe('可以关闭');
    });

    it('tick: owner-respond check with the new state; a failure puts the card back and says so', async () => {
        const host = await render(base);
        h.respond.mockResolvedValueOnce({ item: { ...base, version: 4 } });
        const box = host.querySelector('.wrp-check input') as HTMLInputElement;
        await act(async () => box.click());
        expect(h.respond).toHaveBeenCalledWith('w1', { action: 'check', checkId: 'p1', checked: true });
        const optimistic = h.applied[0] as AttentionItem;
        expect((optimistic.payload as { pending: { checked: boolean }[] }).pending[0].checked).toBe(true);
        expect((h.applied[1] as AttentionItem).version).toBe(4);

        h.applied.length = 0;
        h.respond.mockRejectedValueOnce(new Error('409'));
        await act(async () => box.click());
        expect(h.applied.at(-1)).toBe(base); // rolled back to the item as it was
        expect(h.toastError).toHaveBeenCalledWith(boardCopy(true).wrapup.checkFailed);
    });

    it('handoff failed: red card, the error, the target link, no archive', async () => {
        const host = await render({ ...base, payload: { v: 1, mode: 'handoff', status: 'failed', summary: 's', handoff: { to: 'T9', toTitle: 'Target', delivery: 'failed', error: 'target machine offline', archiveAfter: true } } });
        expect(host.querySelector('.brf-card')?.classList.contains('is-failed')).toBe(true);
        expect(host.querySelector('.brf-title')?.textContent).toBe('交接给 Target 失败');
        expect(host.querySelector('.wrp-error')?.textContent).toBe('target machine offline');
        expect(host.querySelector('.wrp-delivery--failed')?.textContent).toBe('未送达');
        expect((host.querySelector('.wrp-target-link') as HTMLAnchorElement).getAttribute('href')).toBe('/session/T9');
        expect(host.querySelector('.wrp-archive-btn')).not.toBeNull(); // the owner may still archive by hand
    });

    it('handoff delivered + auto-archived: says so and offers no archive', async () => {
        h.session = { id: 's', archivedAt: 9, active: false, metadata: null };
        const host = await render({ ...base, payload: { v: 1, mode: 'handoff', status: 'done', handoff: { to: 'T9', toTitle: 'Target', delivery: 'delivered', archived: true } } });
        expect(host.querySelector('.brf-title')?.textContent).toBe('已交接给 Target');
        expect(host.querySelector('.brf-card')?.classList.contains('is-failed')).toBe(false);
        expect(host.querySelector('.wrp-note')?.textContent).toBe('已自动归档本会话');
        expect(host.querySelector('.wrp-archive-btn')).toBeNull();
    });

    it('B-915b incomplete wrap-up: 收尾未完成 + hint, 重试 sends the wrap-up again, archive still offered', async () => {
        const host = await render({ ...base, payload: { v: 1, mode: 'wrapup', status: 'incomplete', localId: 'wrapup-n1', startedAt: 1 } });
        expect(host.querySelector('.brf-title')?.textContent).toBe('收尾未完成');
        expect(host.querySelector('.wrp-incomplete .wrp-note')?.textContent).toBe('这一轮结束了，但会话没有提交收尾结果。');
        const retry = host.querySelector('.wrp-retry-btn') as HTMLButtonElement;
        expect(retry.textContent).toBe('重试');
        await act(async () => retry.click());
        expect(h.startWrapup).toHaveBeenCalledWith('s');
        expect(h.openHandoff).not.toHaveBeenCalled();
        expect(host.querySelector('.wrp-archive-btn')).not.toBeNull();
    });

    it('B-915b incomplete handoff: 交接未完成, 重试 reopens 交接给… for this session', async () => {
        const host = await render({ ...base, key: 'handoff', payload: { v: 1, mode: 'handoff', status: 'incomplete', localId: 'handoff-h1', startedAt: 1 } });
        expect(host.querySelector('.brf-title')?.textContent).toBe('交接未完成');
        await act(async () => (host.querySelector('.wrp-retry-btn') as HTMLButtonElement).click());
        expect(h.openHandoff).toHaveBeenCalledWith('s');
        expect(h.startWrapup).not.toHaveBeenCalled();
    });

    it('B-915b: no 重试 on a done / running card, nor once the session is archived', async () => {
        expect((await render(base)).querySelector('.wrp-retry-btn')).toBeNull();
        await act(async () => root!.unmount()); root = null;
        expect((await render({ ...base, payload: { v: 1, mode: 'wrapup', status: 'running' } })).querySelector('.wrp-retry-btn')).toBeNull();
        await act(async () => root!.unmount()); root = null;
        h.session = { id: 's', archivedAt: 9, active: false, metadata: null };
        expect((await render({ ...base, payload: { v: 1, mode: 'wrapup', status: 'incomplete' } })).querySelector('.wrp-retry-btn')).toBeNull();
    });

    it('archive from the card: one confirm naming the unconfirmed items; cancel archives nothing', async () => {
        const copy = boardCopy(true).wrapup;
        expect(await archiveFromWrapupCard('s', 2, copy)).toBe(false);
        expect(h.confirm).toHaveBeenCalledWith('还有 2 项未确认，仍要归档这个会话？', undefined, { confirmText: '归档会话', destructive: true });
        await archiveFromWrapupCard('s', 0, copy);
        expect(h.confirm).toHaveBeenLastCalledWith('归档这个会话？', undefined, { confirmText: '归档会话', destructive: true });
        h.session = { id: 's', archivedAt: 5, active: false, metadata: null };
        h.confirm.mockClear();
        expect(await archiveFromWrapupCard('s', 0, copy)).toBe(false);
        expect(h.confirm).not.toHaveBeenCalled();
    });
});
