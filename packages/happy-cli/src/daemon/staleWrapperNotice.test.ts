import { describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';
import { createStaleWrapperNotices, staleWrapperItem, STALE_WRAPPER_ITEM_KEY } from './staleWrapperNotice';
import { AttentionUnsupportedError, type AttentionClient } from '@/attention/client';

function fakeClient() {
    const items: AttentionItem[] = [];
    let n = 0;
    const item = (over: Partial<AttentionItem>): AttentionItem => ({
        id: `i${++n}`, accountId: 'a', sessionId: 's', teamId: null, projectId: null, source: 'automation', kind: 'todo', key: null, title: '', bodyMd: null, options: null, links: null,
        anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null,
        repostCount: 0, createdAt: 0, updatedAt: 0, resolvedAt: null, pushedAt: null, version: 1, ...over,
    } as AttentionItem);
    const client = {
        list: vi.fn(async (q: { sessionId?: string }) => ({ items: items.filter(i => i.sessionId === q.sessionId) })),
        post: vi.fn(async (body: { sessionId: string; key?: string; title: string; bodyMd?: string }) => {
            const existing = items.find(i => i.sessionId === body.sessionId && i.key === body.key);
            if (existing) { Object.assign(existing, { state: 'open', title: body.title, repostCount: existing.repostCount + 1 }); return { item: existing, created: false }; }
            const created = item({ sessionId: body.sessionId, key: body.key ?? null, title: body.title, bodyMd: body.bodyMd ?? null, pushedAt: 1 });
            items.push(created);
            return { item: created, created: true };
        }),
        patch: vi.fn(async (id: string, patch: Partial<AttentionItem> & { appendMd?: string }) => {
            const target = items.find(i => i.id === id)!;
            Object.assign(target, { ...(patch.state ? { state: patch.state } : {}), ...(patch.title ? { title: patch.title } : {}) });
            return { item: target };
        }),
        resolve: vi.fn(async (id: string, input: { outcome: string; note?: string }) => {
            const target = items.find(i => i.id === id)!;
            Object.assign(target, { state: input.outcome === 'superseded' ? 'dismissed' : 'resolved', resolvedBy: 'lead', resolveNote: input.note ?? null });
            return { item: target };
        }),
    };
    return { client: client as unknown as AttentionClient & typeof client, items };
}
const facts = { name: 'Docs Lead', from: '0.2.181', target: '0.2.209', reason: 'no-report' };

describe('B-911 stale-wrapper card', () => {
    it('the posted item: todo from automation, keyed, names the session and both versions', () => {
        const body = staleWrapperItem('s', facts);
        expect(body).toMatchObject({ sessionId: 's', source: 'automation', kind: 'todo', key: STALE_WRAPPER_ITEM_KEY });
        expect(body.title).toBe('会话「Docs Lead」还在用 CLI 0.2.181，没法自动升级到 0.2.209');
        expect(body.title.length).toBeLessThanOrEqual(120);
        expect(body.bodyMd).toContain('本轮结束后重启');
        expect(staleWrapperItem('s', { ...facts, name: 'x'.repeat(200) }).title.length).toBeLessThanOrEqual(120);
    });

    it('posts once per (session, target) — a second stuck, or a daemon restart re-announcing it, does not post again', async () => {
        const { client, items } = fakeClient();
        const notices = createStaleWrapperNotices({ client: () => client });
        await notices.stuck('s', facts);
        await notices.stuck('s', facts);
        expect(client.post).toHaveBeenCalledTimes(1);
        // A new daemon run (fresh memory) finds the open card and does not repost it (no second push).
        const again = createStaleWrapperNotices({ client: () => client });
        await again.stuck('s', facts);
        expect(client.post).toHaveBeenCalledTimes(1);
        // A newer target refreshes the open card's title in place.
        await again.stuck('s', { ...facts, target: '0.2.210' });
        expect(client.post).toHaveBeenCalledTimes(1);
        expect(items[0].title).toContain('0.2.210');
    });

    it('an item the owner closed is the owner\'s decision: never reposted', async () => {
        const { client, items } = fakeClient();
        const notices = createStaleWrapperNotices({ client: () => client });
        await notices.stuck('s', facts);
        Object.assign(items[0], { state: 'resolved', resolvedBy: 'owner' });
        const log = vi.fn();
        await createStaleWrapperNotices({ client: () => client, log }).stuck('s', { ...facts, target: '0.2.210' });
        expect(client.post).toHaveBeenCalledTimes(1);
        expect(client.patch).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        expect(items[0].state).toBe('resolved');
    });

    it('queued → in_progress; failed → open again; settled → resolved; then a later episode posts again', async () => {
        const { client, items } = fakeClient();
        const notices = createStaleWrapperNotices({ client: () => client });
        await notices.stuck('s', facts);
        await notices.queued('s');
        expect(items[0].state).toBe('in_progress');
        await notices.failed('s', 'restart-precheck:cwd-missing');
        expect(items[0].state).toBe('open');
        await notices.settle('s', 'done', 'restarted');
        expect(items[0].state).toBe('resolved');
        await notices.stuck('s', { ...facts, target: '0.2.220' });
        expect(client.post).toHaveBeenCalledTimes(2);
    });

    it('a server without the board (or a failing one) is silent', async () => {
        const log = vi.fn();
        const unsupported = { list: vi.fn(async () => { throw new AttentionUnsupportedError(); }) } as unknown as AttentionClient;
        await createStaleWrapperNotices({ client: () => unsupported, log }).stuck('s', facts);
        expect(log).not.toHaveBeenCalled();
        const broken = { list: vi.fn(async () => { throw new Error('boom'); }) } as unknown as AttentionClient;
        await createStaleWrapperNotices({ client: () => broken, log }).stuck('s', facts);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
});
