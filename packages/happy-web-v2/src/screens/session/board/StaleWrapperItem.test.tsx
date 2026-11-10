// @vitest-environment happy-dom
/**
 * B-911: the daemon's 「会话停在旧版本」 card — worded in the reader's language
 * from the facts in its title; 「本轮结束后重启」 only for a daemon that queues
 * `whenIdle` (an older one would restart at once), and it sends exactly that.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';

const state = vi.hoisted(() => ({
    session: { id: 's1', metadata: { machineId: 'm1', version: '0.2.181' } } as unknown,
    machine: { id: 'm1', active: true, daemonState: { autoRestart: { idleRestart: true } } } as unknown,
    restart: vi.fn(async () => ({ type: 'success', sessionId: 's1', queued: true }) as unknown),
    applied: [] as unknown[],
    toasts: [] as string[],
}));
vi.mock('@/sync/storage', () => ({ useMessage: () => undefined, useSession: () => state.session, useMachine: () => state.machine }));
vi.mock('@/sync/ops', () => ({ machineRestartSession: state.restart }));
vi.mock('@/sync/attentionStore', () => ({ useAttentionStore: { getState: () => ({ apply: (item: unknown) => state.applied.push(item) }) } }));
vi.mock('@/ui', () => ({ toast: { success: (m: string) => state.toasts.push(`ok:${m}`), error: (m: string) => state.toasts.push(`err:${m}`) } }));
vi.mock('../Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
const { BoardCard } = await import('./BoardCard');
const { boardCopy } = await import('./boardCopy');
const { daemonQueuesIdleRestart, staleWrapperItemFacts, staleWrapperRestartError, isStaleWrapperItem } = await import('./StaleWrapperItem');

const card: AttentionItem = {
    id: 'i1', sessionId: 's1', teamId: null, projectId: null, source: 'automation', kind: 'todo', key: 'stale-wrapper',
    title: '会话「Docs Lead」还在用 CLI 0.2.181，没法自动升级到 0.2.210', bodyMd: '本机已经装了 CLI 0.2.210…',
    options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open',
    ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: 1, version: 1,
};
const noop = { onToggle: () => {}, onChoose: () => {}, onResolve: () => {}, onLocate: () => {}, onFollowUp: () => {} };
let root: Root | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.restart.mockClear(); state.applied.length = 0; state.toasts.length = 0; });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ''; });
async function render(item: AttentionItem) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<BoardCard item={item} all={[item]} copy={boardCopy(false)} expanded selected={false} unread={false} actions={noop} />));
    return host;
}

describe('B-911 stale-wrapper card', () => {
    it('facts come from the daemon title; other items are not this card', () => {
        expect(staleWrapperItemFacts(card)).toEqual({ name: 'Docs Lead', from: '0.2.181', target: '0.2.210' });
        expect(isStaleWrapperItem({ ...card, source: 'lead' })).toBe(false);
        expect(staleWrapperItemFacts({ ...card, title: 'something else' })).toBeNull();
        expect(daemonQueuesIdleRestart({ autoRestart: { idleRestart: true, idleGuard: true } })).toBe(true);
        expect(daemonQueuesIdleRestart({ autoRestart: { idleGuard: true } })).toBe(false);
        expect(daemonQueuesIdleRestart(null)).toBe(false);
        expect(staleWrapperRestartError('idle-restart:not-live')).toMatch(/not running/);
        expect(staleWrapperRestartError('idle-restart:whatever')).toMatch(/whatever/);
    });

    it('reads in the reader\'s language and queues the restart with whenIdle', async () => {
        const host = await render(card);
        expect(host.querySelector('.brf-title')!.textContent).toBe('"Docs Lead" is still on CLI 0.2.181 and cannot update itself to 0.2.210');
        expect(host.textContent).toContain('Restart after this turn');
        expect(host.querySelector('.brf-r2')!.textContent).toMatch(/^This machine · /);
        const button = host.querySelector<HTMLButtonElement>('[data-testid="stale-wrapper-restart"]')!;
        await act(async () => { button.click(); });
        expect(state.restart).toHaveBeenCalledWith({ machineId: 'm1', sessionId: 's1', whenIdle: true });
        expect(state.applied).toEqual([expect.objectContaining({ id: 'i1', state: 'in_progress' })]);
        expect(state.toasts).toEqual(['ok:Queued: the session restarts once it is idle']);
    });

    it('no button for a daemon that would restart at once, an offline machine, or a closed card; queued shows the wait', async () => {
        state.machine = { id: 'm1', active: true, daemonState: { autoRestart: { idleGuard: true } } };
        expect((await render(card)).querySelector('[data-testid="stale-wrapper-restart"]')).toBeNull();
        await act(async () => root!.unmount()); root = null;
        state.machine = { id: 'm1', active: false, daemonState: { autoRestart: { idleRestart: true } } };
        expect((await render(card)).querySelector('[data-testid="stale-wrapper-restart"]')).toBeNull();
        await act(async () => root!.unmount()); root = null;
        state.machine = { id: 'm1', active: true, daemonState: { autoRestart: { idleRestart: true } } };
        expect((await render({ ...card, state: 'resolved' })).querySelector('[data-testid="stale-wrapper-restart"]')).toBeNull();
        await act(async () => root!.unmount()); root = null;
        const queued = await render({ ...card, state: 'in_progress' });
        expect(queued.querySelector('[data-testid="stale-wrapper-restart"]')).toBeNull();
        expect(queued.querySelector('[data-testid="stale-wrapper-queued"]')!.textContent).toBe('Queued: restarts once this turn ends and the session is idle');
    });

    it('a refusal is shown, nothing is marked queued', async () => {
        state.restart.mockResolvedValueOnce({ type: 'error', errorMessage: 'idle-restart:not-resumable' });
        const host = await render(card);
        await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="stale-wrapper-restart"]')!.click(); });
        expect(state.applied).toEqual([]);
        expect(state.toasts).toEqual(['err:This conversation cannot be resumed on its machine, so it was not restarted']);
    });
});
