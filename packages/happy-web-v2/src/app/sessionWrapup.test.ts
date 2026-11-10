// @vitest-environment happy-dom
/**
 * B-915: the built-in 收尾 / 交接 turn — one sender for the header ⋯, the
 * sidebar ⋯ and `/wrapup`. What reaches the session, the idempotency gate,
 * the old-wrapper notice (not a failure) and the restore-first path.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_WRAPUP_TEMPLATE, WRAPUP_KV_KEY, WRAPUP_PROTOCOL_TAIL, WRAPUP_SESSION_CAPABILITY, builtinActionOfLocalId, decodeWrapupConfig,
    encodeWrapupConfig, type AttentionItem,
} from '@slopus/happy-wire';

const kv = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn() }));
vi.mock('@/sync/apiKv', () => ({ kvGet: kv.get, kvMutate: kv.mutate }));
vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't' } }) }));
vi.mock('@/i18n/useTranslation', () => ({ t: (key: string) => key }));

const { runBuiltinAction, loadWrapupConfig, saveWrapupConfig, supportsWrapupCard, wrapupLangOf } = await import('./sessionWrapup');
type Deps = NonNullable<Parameters<typeof runBuiltinAction>[2]>;

const session = (capabilities: string[] = [WRAPUP_SESSION_CAPABILITY]) => ({ id: 's1', active: true, metadata: { capabilities } }) as never;
const running = (mode: 'wrapup' | 'handoff', startedAt: number): AttentionItem => ({
    id: 'w1', sessionId: 's1', teamId: null, projectId: null, source: 'agent', kind: 'wrapup', key: mode, title: 'x', bodyMd: null,
    options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: false, state: 'open',
    ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: startedAt, updatedAt: startedAt,
    resolvedAt: null, pushedAt: null, version: 1, payload: { v: 1, mode, status: 'running', startedAt },
});

function deps(over: Partial<Deps> = {}) {
    const send = vi.fn(async () => 'local');
    const notify = vi.fn();
    const base: Deps = {
        getSession: () => session(),
        items: async () => [],
        loadConfig: async () => ({ config: { template: 'MY TEMPLATE' }, version: 3 }),
        gate: () => 'send',
        restore: vi.fn(async () => true),
        waitLive: vi.fn(async () => true),
        send,
        notify,
        lang: () => 'zh',
        now: () => 1_000_000,
        nonce: () => 'n1',
        ...over,
    };
    return { d: base, send: base.send as typeof send, notify: base.notify as typeof notify };
}

describe('runBuiltinAction (B-915)', () => {
    it('wrap-up: the account template + protocol tail, a wrapup- localId and a short chat label', async () => {
        const { d, send, notify } = deps();
        expect(await runBuiltinAction('s1', null, d)).toBe('sent');
        const [, text, options] = send.mock.calls[0] as unknown as [string, string, { localId: string; displayText: string }];
        expect(text).toBe(`MY TEMPLATE\n\n${WRAPUP_PROTOCOL_TAIL}`);
        expect(builtinActionOfLocalId(options.localId)).toBe('wrapup');
        expect(options.displayText).toBe('收尾');
        expect(notify).toHaveBeenCalledWith('success', 'wrapup.sent');
    });

    it('no stored template → the built-in default in the UI language', async () => {
        const { d, send } = deps({ loadConfig: async () => ({ config: { template: null }, version: -1 }), lang: () => 'en' });
        await runBuiltinAction('s1', null, d);
        expect((send.mock.calls[0] as unknown as string[])[1]).toContain(DEFAULT_WRAPUP_TEMPLATE.en);
    });

    it('idempotent: a fresh running card of the same mode → nothing sent, says so', async () => {
        const { d, send, notify } = deps({ items: async () => [running('wrapup', 999_000)] });
        expect(await runBuiltinAction('s1', null, d)).toBe('already');
        expect(send).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith('info', 'wrapup.already');
        // a running HANDOFF does not block a wrap-up, and vice versa
        const other = deps({ items: async () => [running('handoff', 999_000)] });
        expect(await runBuiltinAction('s1', null, other.d)).toBe('sent');
    });

    it('old wrapper (no wrapup-v1): still sent, with the upgrade notice instead of success', async () => {
        const { d, send, notify } = deps({ getSession: () => session([]) });
        expect(await runBuiltinAction('s1', null, d)).toBe('sent');
        expect(send).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('info', 'wrapup.upgradeHint');
        expect(notify).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('handoff: names the target, a handoff- localId; archive_after only when the wrapper can confirm delivery', async () => {
        const req = { to: { id: 'T9', title: 'Target', machineId: 'm2' }, note: 'cover the API', archiveAfter: true };
        const { d, send, notify } = deps();
        expect(await runBuiltinAction('s1', req, d)).toBe('sent');
        const [, text, options] = send.mock.calls[0] as unknown as [string, string, { localId: string; displayText: string }];
        expect(text).toContain('to: "T9", machine_id: "m2"');
        expect(text).toContain('archive_after: true');
        expect(text).toContain('Note from the user: cover the API');
        expect(builtinActionOfLocalId(options.localId)).toBe('handoff');
        expect(options.displayText).toBe('交接给「Target」');
        expect(notify).toHaveBeenCalledWith('success', 'wrapup.handoffSent');
        const old = deps({ getSession: () => session([]) });
        await runBuiltinAction('s1', req, old.d);
        expect((old.send.mock.calls[0] as unknown as string[])[1]).toContain('archive_after: false');
    });

    it('offline / hibernated: restore first, wait until live, then send; failures send nothing', async () => {
        const ok = deps({ gate: () => 'restore-first' });
        expect(await runBuiltinAction('s1', null, ok.d)).toBe('sent');
        expect(ok.d.restore).toHaveBeenCalledWith('s1');
        expect(ok.d.waitLive).toHaveBeenCalledWith('s1');
        const failed = deps({ gate: () => 'restore-first', restore: vi.fn(async () => false) });
        expect(await runBuiltinAction('s1', null, failed.d)).toBe('restore-failed');
        expect(failed.send).not.toHaveBeenCalled();
        const slow = deps({ gate: () => 'restore-first', waitLive: vi.fn(async () => false) });
        expect(await runBuiltinAction('s1', null, slow.d)).toBe('not-live');
        expect(slow.send).not.toHaveBeenCalled();
    });

    it('a send failure is reported; an unknown session sends nothing', async () => {
        const boom = deps({ send: vi.fn(async () => { throw new Error('x'); }) });
        expect(await runBuiltinAction('s1', null, boom.d)).toBe('failed');
        expect(boom.notify).toHaveBeenCalledWith('error', 'wrapup.sendFailed');
        const none = deps({ getSession: () => undefined });
        expect(await runBuiltinAction('s1', null, none.d)).toBe('missing');
        expect(none.send).not.toHaveBeenCalled();
    });

    it('helpers', () => {
        expect(wrapupLangOf('zh-Hans')).toBe('zh');
        expect(wrapupLangOf('en')).toBe('en');
        expect(wrapupLangOf(undefined)).toBe('en');
        expect(supportsWrapupCard({ metadata: { capabilities: [WRAPUP_SESSION_CAPABILITY] } } as never)).toBe(true);
        expect(supportsWrapupCard({ metadata: null } as never)).toBe(false);
    });
});

describe('account template in KV (B-915)', () => {
    it('loads the stored template with its version; missing / failing → defaults at version -1', async () => {
        kv.get.mockResolvedValueOnce({ key: WRAPUP_KV_KEY, value: encodeWrapupConfig({ template: '收尾！', lang: 'zh' }), version: 4 });
        expect(await loadWrapupConfig()).toEqual({ config: { template: '收尾！', lang: 'zh' }, version: 4 });
        expect(kv.get).toHaveBeenLastCalledWith({ token: 't' }, WRAPUP_KV_KEY);
        kv.get.mockResolvedValueOnce(null);
        expect(await loadWrapupConfig()).toEqual({ config: { template: null }, version: -1 });
        kv.get.mockRejectedValueOnce(new Error('net'));
        expect(await loadWrapupConfig()).toEqual({ config: { template: null }, version: -1 });
    });

    it('saves with optimistic concurrency; a version mismatch hands back the other device’s value', async () => {
        kv.mutate.mockResolvedValueOnce({ success: true, results: [{ key: WRAPUP_KV_KEY, version: 5 }] });
        expect(await saveWrapupConfig({ template: 'mine', lang: 'en' }, 4)).toEqual({ ok: true, version: 5 });
        const [, mutations] = kv.mutate.mock.calls[0] as [unknown, { key: string; value: string; version: number }[]];
        expect(mutations[0].key).toBe(WRAPUP_KV_KEY);
        expect(mutations[0].version).toBe(4);
        expect(decodeWrapupConfig(mutations[0].value)).toEqual({ template: 'mine', lang: 'en' });
        kv.mutate.mockResolvedValueOnce({ success: false, errors: [{ key: WRAPUP_KV_KEY, error: 'version-mismatch', version: 7, value: encodeWrapupConfig({ template: 'theirs' }) }] });
        expect(await saveWrapupConfig({ template: 'mine' }, 4)).toEqual({ ok: false, conflict: { config: { template: 'theirs' }, version: 7 } });
    });
});
