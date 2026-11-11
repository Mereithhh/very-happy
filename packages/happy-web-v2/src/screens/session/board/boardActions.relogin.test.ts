// @vitest-environment happy-dom
/**
 * B-921 (QA-S P1): the real request path. A 403 `owner_login_required` from
 * owner-respond reaches the board as「请重新登录」(sticky, opens Account) for every
 * owner action, and never trips the sign-out latch; other failures keep the
 * generic toast. Only fetch, auth and the stores are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';
import { getAuthLatch, isAuthLatched, resetAuthLatch } from '@/auth/authLatch';
import { boardCopy } from './boardCopy';

const h = vi.hoisted(() => ({ action: vi.fn(), error: vi.fn(), apply: vi.fn(), load: vi.fn(), send: vi.fn() }));
vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 'old-web-token' } }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'http://server.test' }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'web-test' }));
vi.mock('@/sync/attentionStore', () => ({ useAttentionStore: { getState: () => ({ apply: h.apply }) }, loadAttentionItems: h.load }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: h.send } }));
vi.mock('@/ui/Toast', () => ({ toast: { action: h.action, error: h.error, show: vi.fn(), success: vi.fn() } }));
vi.mock('../messageQuote', () => ({ quoteMessage: vi.fn() }));

const { chooseOption, resolveItem, followUp, checkWrapupItem } = await import('./boardActions');

const copy = boardCopy(true);
const base = {
    id: 'card-1', sessionId: 's', teamId: null, projectId: null, source: 'agent', kind: 'decision', key: 'k', title: 't', bodyMd: null,
    options: [{ id: 'approve', label: '批准' }, { id: 'drop', label: '放弃' }], links: null, anchor: null, firstReply: null, replyToId: null,
    inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null,
    repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: null, version: 1,
} as unknown as AttentionItem;
const wrapup = { ...base, kind: 'wrapup', options: null, payload: { v: 1, mode: 'wrapup', status: 'done', summary: 'done', canClose: true, pending: [{ id: 'p1', label: 'publish?', checked: false }] } } as unknown as AttentionItem;

let calls: Array<{ url: string; body: unknown }>;
function serverAnswers(status: number, body: unknown) {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }));
}

beforeEach(() => { vi.clearAllMocks(); resetAuthLatch(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('owner_login_required through the real request path', () => {
    const actions: Array<[string, () => Promise<void>, string]> = [
        ['choose', () => chooseOption(base, 'approve', copy), 'choose'],
        ['resolve', () => resolveItem(base, copy), 'resolve'],
        ['reopen', () => followUp({ ...base, state: 'resolved' } as AttentionItem, copy), 'reopen'],
        ['check', () => checkWrapupItem(wrapup, 'p1', true, copy), 'check'],
    ];
    for (const [name, run, action] of actions) {
        it(`${name}: sticky sign-in-again notice that opens Account, no sign-out, no generic toast`, async () => {
            serverAnswers(403, { error: 'owner_login_required' });
            await run();
            expect(calls).toHaveLength(1);
            expect(calls[0]!.url).toBe('http://server.test/v1/attention-items/card-1/owner-respond');
            expect((calls[0]!.body as { action: string }).action).toBe(action);
            expect(h.action).toHaveBeenCalledTimes(1);
            expect(h.action.mock.calls[0]![0]).toBe(copy.reloginRequired);
            const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
            h.action.mock.calls[0]![1]();
            expect(assign).toHaveBeenCalledWith('/settings/account');
            expect(h.error).not.toHaveBeenCalled();
            expect(h.send).not.toHaveBeenCalled();
            expect(isAuthLatched()).toBe(false);
            expect(getAuthLatch()).toBeNull();
        });
    }

    it('another 403 stays the generic failure (and still does not sign out)', async () => {
        serverAnswers(403, { error: 'forbidden' });
        await chooseOption(base, 'approve', copy);
        expect(h.action).not.toHaveBeenCalled();
        expect(h.error).toHaveBeenCalledWith(copy.actionFailed);
        expect(isAuthLatched()).toBe(false);
    });
});
