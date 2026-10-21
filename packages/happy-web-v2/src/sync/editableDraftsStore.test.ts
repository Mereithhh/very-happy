import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const kvMutate = vi.fn();
const kvGetByPrefix = vi.fn();
vi.mock('@/sync/apiKv', () => ({ kvMutate: (...a: unknown[]) => kvMutate(...a), kvGetByPrefix: (...a: unknown[]) => kvGetByPrefix(...a) }));
vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't', secret: 's' } }) }));
vi.mock('@/auth/authLatch', () => ({ isAuthLatched: () => false }));

const { dispatchKvChanges } = await import('./kvUpdates');
const store = await import('./editableDraftsStore');
const { draftKeyFor, draftKvKey, isDraftPending } = await import('./editableDrafts');

const b64 = (v: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v))));
const decode = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));

const SESSION = 'sess1';
const ORIGINAL = 'Hi Alex,\nSee you Monday.';
const KEY = draftKeyFor(4, ORIGINAL);
const KV_KEY = draftKvKey(SESSION, KEY);

beforeAll(async () => {
    await store.__loadIoForTests();
});

beforeEach(() => {
    vi.useFakeTimers();
    kvMutate.mockReset();
    kvGetByPrefix.mockReset();
    store.__resetEditableDraftsForTests();
});
afterEach(() => vi.useRealTimers());

const get = () => store.useEditableDrafts.getState().drafts[KV_KEY];

describe('editableDraftsStore', () => {
    it('stores nothing until the text actually differs from the original', () => {
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, text: ORIGINAL });
        expect(get()).toBeUndefined();
        vi.runAllTimers();
        expect(kvMutate).not.toHaveBeenCalled();
    });

    it('debounces keystrokes into one CAS create', async () => {
        kvMutate.mockResolvedValue({ success: true, results: [{ key: KV_KEY, version: 0 }] });
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, title: 'Reply', text: 'Hi Alex,\nSee you T' });
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, title: 'Reply', text: 'Hi Alex,\nSee you Tuesday.' });
        await vi.runAllTimersAsync();
        expect(kvMutate).toHaveBeenCalledTimes(1);
        const [, [mutation]] = kvMutate.mock.calls[0];
        expect(mutation.key).toBe(KV_KEY);
        expect(mutation.version).toBe(-1);
        const saved = decode(mutation.value);
        expect(saved).toMatchObject({ v: 1, sessionId: SESSION, key: KEY, title: 'Reply', original: ORIGINAL, base: ORIGINAL, text: 'Hi Alex,\nSee you Tuesday.' });
        expect(store.selectPendingDrafts(store.useEditableDrafts.getState().drafts, SESSION).map((d) => d.kvKey)).toEqual([KV_KEY]);
        expect(store.selectPendingDrafts(store.useEditableDrafts.getState().drafts, 'other')).toEqual([]);
    });

    it('marking attached moves the model-seen base, so the chip goes away until the next edit', async () => {
        kvMutate.mockResolvedValue({ success: true, results: [{ key: KV_KEY, version: 0 }] });
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'v1' });
        store.markDraftsAttached([{ kvKey: KV_KEY, text: 'v1' }]);
        expect(isDraftPending(get())).toBe(false);
        expect(get().base).toBe('v1');
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'v2' });
        expect(isDraftPending(get())).toBe(true);
    });

    it('dismiss keeps the edit but stops attaching it', () => {
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'v1' });
        store.dismissDraft(KV_KEY);
        expect(get().text).toBe('v1');
        expect(isDraftPending(get())).toBe(false);
    });

    it('a CAS conflict with a newer remote adopts the remote', async () => {
        const remote = { v: 1, sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'from phone', base: ORIGINAL, updatedAt: Date.now() + 60_000 };
        kvMutate.mockResolvedValue({ success: false, errors: [{ key: KV_KEY, error: 'version-mismatch', version: 3, value: b64(remote) }] });
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'from laptop' });
        await vi.runAllTimersAsync();
        expect(get().text).toBe('from phone');
    });

    it('absorbs live kv-batch-update pushes from another device and skips stale echoes', async () => {
        kvGetByPrefix.mockResolvedValue([]);
        await store.refreshDrafts(SESSION, true);
        const remote = { v: 1, sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'other tab', base: ORIGINAL, updatedAt: 100 };
        dispatchKvChanges([{ key: KV_KEY, value: b64(remote), version: 2 }]);
        expect(get().text).toBe('other tab');
        dispatchKvChanges([{ key: KV_KEY, value: b64({ ...remote, text: 'stale' }), version: 1 }]);
        expect(get().text).toBe('other tab');
        dispatchKvChanges([{ key: 'vh.note.v1.x', value: b64({}), version: 9 }]);
        expect(Object.keys(store.useEditableDrafts.getState().drafts)).toEqual([KV_KEY]);
    });

    it('loads a session prefix on refresh (reload / other device)', async () => {
        const saved = { v: 1, sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'saved', base: ORIGINAL, updatedAt: 5 };
        kvGetByPrefix.mockResolvedValue([{ key: KV_KEY, value: b64(saved), version: 7 }]);
        await store.refreshDrafts(SESSION, true);
        expect(kvGetByPrefix.mock.calls[0][1]).toBe(`vh.draft.v1.${SESSION}.`);
        expect(get().text).toBe('saved');
        expect(store.useEditableDrafts.getState().loaded[SESSION]).toBe(true);
    });
});

describe('B-722 draft save state', () => {
    const save = () => store.useEditableDrafts.getState().saves[KV_KEY];

    it('an edit reads 保存中 at once, 已保存 after the CAS write, then clears by itself', async () => {
        let answer!: (value: unknown) => void;
        kvMutate.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'edited' });
        expect(save()).toBe('saving');
        await vi.advanceTimersByTimeAsync(1000); // debounce fired, request in flight
        expect(kvMutate).toHaveBeenCalledTimes(1);
        expect(save()).toBe('saving');
        answer({ success: true, results: [{ key: KV_KEY, version: 0 }] });
        await vi.advanceTimersByTimeAsync(0);
        expect(save()).toBe('saved');
        await vi.advanceTimersByTimeAsync(store.DRAFT_SAVED_VISIBLE_MS);
        expect(save()).toBeUndefined();
    });

    it('a failed write reads 未保存 and Retry saves it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        kvMutate.mockRejectedValueOnce(new Error('offline'));
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'edited' });
        await vi.runAllTimersAsync();
        expect(save()).toBe('failed');
        kvMutate.mockResolvedValue({ success: true, results: [{ key: KV_KEY, version: 0 }] });
        store.retryDraftSave(KV_KEY);
        expect(save()).toBe('saving');
        await vi.advanceTimersByTimeAsync(1000);
        expect(kvMutate).toHaveBeenCalledTimes(2);
        expect(save()).toBe('saved');
    });

    it('a remote edit that wins the conflict also settles the save (no stuck 保存中)', async () => {
        const remote = { v: 1, sessionId: SESSION, key: KEY, original: ORIGINAL, base: ORIGINAL, text: 'theirs', updatedAt: Date.now() + 60_000 };
        kvMutate.mockResolvedValue({ success: false, errors: [{ key: KV_KEY, version: 3, value: b64(remote) }] });
        store.editDraft({ sessionId: SESSION, key: KEY, original: ORIGINAL, text: 'mine' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(get()?.text).toBe('theirs');
        expect(save()).toBe('saved');
    });
});
