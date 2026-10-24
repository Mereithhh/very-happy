/**
 * promptQueue — the server-side prompt queue as the web sees it (B-509,
 * specs/2026-09-server-prompt-queue.md).
 *
 * Before B-509 a prompt typed while the agent was busy lived only in the tab
 * (AgentInput state + localStorage) and was released by that tab watching
 * `isWorking` flip — close the tab and the rest of the queue never went out.
 * Now the composer stores it on the server (`/v1/sessions/:id/prompt-queue`)
 * as the encrypted record it would have sent, and the session's wrapper pops
 * the head into an ordinary message when its own input queue is idle. This
 * store only mirrors, edits, deletes and reorders what the server holds; it
 * never releases anything.
 *
 * Independent zustand store (btwStore precedent) with injectable transport so
 * the decision logic is unit-tested without sockets or encryption.
 */
import { create } from 'zustand';
import type { MessageModeMeta } from './messageMeta';
import type { Metadata } from './storageTypes';
import { readOutboundUserRecord } from './outboundUserRecord';
import { SYNC_READ_TIMEOUT_MS } from './requestDeadline';
import { isNetworkOffline } from './networkStatus';
import type { ApiPromptQueueUpdate } from './apiTypes';

export const PROMPT_QUEUE_CAPABILITY = 'prompt-queue-v1';

export type PromptQueueEntry = {
    id: string;
    localId: string;
    position: number;
    text: string;
    modeMeta: MessageModeMeta;
    createdAt: number;
};

export type PromptQueueStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

/**
 * B-722: a prompt the composer submitted that the server has not confirmed
 * yet. Shown in the queue dock at once (it used to appear only after the
 * POST answered); dropped the moment a server snapshot lists its localId.
 * `waiting`: the device is offline — retried automatically when it is back.
 */
export type PendingPrompt = {
    localId: string;
    text: string;
    modeMeta: MessageModeMeta;
    createdAt: number;
    state: 'sending' | 'waiting' | 'failed';
};

/**
 * B-804: a queue item the wrapper took (it left the server snapshot without
 * this tab removing it) whose message is not in the transcript yet. The dock
 * keeps it as 「执行中」 so the prompt is never in neither place.
 */
export type DispatchedPrompt = {
    localId: string;
    text: string;
};

export type PromptQueueSessionState = {
    items: PromptQueueEntry[];
    status: PromptQueueStatus;
    /** B-722: optimistic rows, oldest first; absent = none. */
    pending?: PendingPrompt[];
    /** B-804: hand-off rows, oldest first; absent = none. */
    dispatched?: DispatchedPrompt[];
    /** Highest socket-update seq applied; snapshots arriving out of order are dropped. */
    snapshotSeq?: number;
};

export type PromptQueueWireItem = ApiPromptQueueUpdate['items'][number];

export type PromptQueueDeps = {
    request: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;
    encrypt: (sessionId: string, text: string, modeMeta: MessageModeMeta) => Promise<string | null>;
    decrypt: (sessionId: string, encrypted: string) => Promise<unknown | null>;
    newLocalId: () => string;
    /** B-722: false while the device reports offline (a failure then waits instead of failing). */
    isOnline?: () => boolean;
    now?: () => number;
    /** B-804: the session's transcript already holds a message with this localId. */
    inTranscript?: (sessionId: string, localId: string) => boolean;
    /** B-804: new hand-off rows appeared — fetch the transcript, then settleDispatched with what was asked. */
    onDispatched?: (sessionId: string, localIds: string[]) => void;
};

interface PromptQueueStoreState {
    sessions: Record<string, PromptQueueSessionState>;
    load: (sessionId: string) => Promise<void>;
    /** `localId` (optional) makes a retry / a second tab's migration of the same item idempotent on the server. */
    enqueue: (sessionId: string, text: string, modeMeta: MessageModeMeta, localId?: string) => Promise<'queued' | 'unsupported'>;
    /**
     * B-722: the composer's enqueue — the row is visible before this returns
     * its promise (sending → dropped on the server snapshot; failed/waiting on
     * error, kept for Retry). Rejects like `enqueue`; the row stays.
     */
    submit: (sessionId: string, text: string, modeMeta: MessageModeMeta) => Promise<'queued' | 'unsupported'>;
    /** B-722: re-send a failed/waiting row with its own localId (idempotent on the server). */
    retryPending: (sessionId: string, localId: string) => Promise<'queued' | 'unsupported' | 'gone'>;
    /** B-722: drop a failed/waiting row (delete, or 放回输入框); returns it. */
    discardPending: (sessionId: string, localId: string) => PendingPrompt | null;
    updateText: (sessionId: string, id: string, text: string) => Promise<boolean>;
    remove: (sessionId: string, id: string) => Promise<boolean>;
    move: (sessionId: string, id: string, delta: -1 | 1) => Promise<void>;
    /** `seq` = the socket update's account seq; an older snapshot than one already applied is ignored. */
    applySnapshot: (sessionId: string, items: PromptQueueWireItem[], seq?: number) => Promise<void>;
    /**
     * B-804: drop hand-off rows whose message reached the transcript; with
     * `verified`, also those localIds a transcript fetch started after the
     * hand-off did not find (deleted on another device, not run).
     */
    settleDispatched: (sessionId: string, verified?: readonly string[]) => void;
}

export const EMPTY_PROMPT_QUEUE: PromptQueueSessionState = Object.freeze({ items: [], status: 'idle' }) as PromptQueueSessionState;

/** Web gates the server queue on the wrapper's advertised capability, never on a version (AGENTS #14). */
export function supportsServerPromptQueue(metadata: Pick<Metadata, 'capabilities'> | null | undefined): boolean {
    return metadata?.capabilities?.includes(PROMPT_QUEUE_CAPABILITY) === true;
}

/** Pure: the id order after moving `id` by `delta`; unchanged when it cannot move. */
export function movedOrder(ids: string[], id: string, delta: -1 | 1): string[] {
    const index = ids.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return ids;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

/** Error codes the prompt-queue routes themselves answer with (store.ts PromptQueueError). */
export function isPromptQueueErrorCode(code: string | null): boolean {
    return code !== null && (code.startsWith('prompt_queue_') || code === 'session_not_found');
}

/**
 * B-804, pure: the items that left the server list without this tab removing
 * them and whose message the transcript does not hold yet — the wrapper took
 * them, the dock keeps them as 「执行中」.
 */
export function handOffRows(
    previous: readonly PromptQueueEntry[],
    listed: ReadonlySet<string>,
    removedHere: ReadonlySet<string>,
    inTranscript: (localId: string) => boolean,
): DispatchedPrompt[] {
    return previous
        .filter((item) => !listed.has(item.localId) && !removedHere.has(item.id) && !inTranscript(item.localId))
        .map((item) => ({ localId: item.localId, text: item.text }));
}

function isWireItem(value: unknown): value is PromptQueueWireItem {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    const content = item.content as { t?: unknown; c?: unknown } | undefined;
    return typeof item.id === 'string' && typeof item.localId === 'string' && typeof item.position === 'number'
        && typeof item.createdAt === 'number' && !!content && content.t === 'encrypted' && typeof content.c === 'string';
}

export function createPromptQueueStore(deps: PromptQueueDeps) {
    return create<PromptQueueStoreState>((set, get) => {
        const patch = (sessionId: string, update: Partial<PromptQueueSessionState>) => set((state) => ({
            sessions: { ...state.sessions, [sessionId]: { ...(state.sessions[sessionId] ?? EMPTY_PROMPT_QUEUE), ...update } },
        }));
        const decode = async (sessionId: string, items: PromptQueueWireItem[]): Promise<PromptQueueEntry[]> => {
            const sorted = [...items].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
            const entries: PromptQueueEntry[] = [];
            for (const item of sorted) {
                const record = await deps.decrypt(sessionId, item.content.c);
                const read = readOutboundUserRecord(record);
                // An item this client cannot read still occupies its slot; show it as such
                // rather than hiding a prompt the wrapper is about to run.
                entries.push({
                    id: item.id,
                    localId: item.localId,
                    position: item.position,
                    text: read?.text ?? '',
                    modeMeta: read?.modeMeta ?? {},
                    createdAt: item.createdAt,
                });
            }
            return entries;
        };
        // B-804: every applied list bumps its session's epoch; a GET that started
        // before an apply answers with an older view and is dropped (load()).
        const epochs = new Map<string, number>();
        // Item ids this tab removed itself (delete, send now, intervene): not a hand-off.
        const removedHere = new Set<string>();
        const applyItems = async (sessionId: string, raw: unknown, guard?: () => boolean) => {
            const items = Array.isArray(raw) ? raw.filter(isWireItem) : [];
            const decoded = await decode(sessionId, items);
            if (guard && !guard()) return;
            epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
            // B-722: the server row replaces its optimistic one in the same update — never both, never a gap.
            const listed = new Set(decoded.map((item) => item.localId));
            const current = get().sessions[sessionId];
            const pending = current?.pending;
            const handedOff = handOffRows(current?.items ?? [], listed, removedHere, (localId) => deps.inTranscript?.(sessionId, localId) === true);
            const dispatched = [...(current?.dispatched ?? []).filter((row) => !listed.has(row.localId)), ...handedOff];
            patch(sessionId, {
                items: decoded,
                status: 'ready',
                ...(pending?.some((row) => listed.has(row.localId)) ? { pending: pending.filter((row) => !listed.has(row.localId)) } : {}),
                ...(dispatched.length !== (current?.dispatched?.length ?? 0) ? { dispatched: dispatched.length > 0 ? dispatched : undefined } : {}),
            });
            if (handedOff.length > 0) deps.onDispatched?.(sessionId, handedOff.map((row) => row.localId));
        };
        const setPending = (sessionId: string, update: (rows: PendingPrompt[]) => PendingPrompt[]) => {
            const next = update(get().sessions[sessionId]?.pending ?? []);
            patch(sessionId, { pending: next.length > 0 ? next : undefined });
        };
        const sendPending = async (sessionId: string, row: PendingPrompt): Promise<'queued' | 'unsupported'> => {
            try {
                const result = await get().enqueue(sessionId, row.text, row.modeMeta, row.localId);
                // 'unsupported': the caller moves it to the tab-local queue; 'queued': the
                // snapshot already dropped it (kept defensively for a snapshot without it).
                setPending(sessionId, (rows) => rows.filter((other) => other.localId !== row.localId));
                return result;
            } catch (error) {
                const state = deps.isOnline && !deps.isOnline() ? 'waiting' : 'failed';
                setPending(sessionId, (rows) => rows.map((other) => other.localId === row.localId ? { ...other, state } : other));
                throw error;
            }
        };
        const call = async (sessionId: string, path: string, init?: { method?: string; body?: string }) => {
            const response = await deps.request(`/v1/sessions/${sessionId}/prompt-queue${path}`, init);
            if (response.status < 200 || response.status >= 300) {
                let code: string | null = null;
                try { const body = await response.json() as { error?: unknown }; if (typeof body?.error === 'string') code = body.error; } catch { /* no body */ }
                // A 404 that is not one of OUR codes is an old server without the
                // route (production's SPA fallback answers `{error:'Not found'}`,
                // a bare Fastify 404 answers `Not Found`): this session falls
                // back to the tab-local queue. Our own 404s (item gone, session
                // gone) are ordinary errors the caller handles.
                if (response.status === 404 && !isPromptQueueErrorCode(code)) {
                    patch(sessionId, { status: 'unsupported' });
                    return null;
                }
                throw new Error(code ?? `HTTP ${response.status}`);
            }
            return response.json() as Promise<{ items?: unknown; removed?: boolean }>;
        };
        return {
            sessions: {},
            load: async (sessionId) => {
                const current = get().sessions[sessionId];
                if (current?.status === 'unsupported') return;
                if (!current || current.status === 'idle' || current.status === 'error') patch(sessionId, { status: 'loading' });
                const startEpoch = epochs.get(sessionId) ?? 0;
                try {
                    const body = await call(sessionId, '');
                    // B-804: a snapshot (or a newer load) applied meanwhile is newer than this answer.
                    if (body) await applyItems(sessionId, body.items, () => (epochs.get(sessionId) ?? 0) === startEpoch);
                } catch {
                    patch(sessionId, { status: get().sessions[sessionId]?.items.length ? 'ready' : 'error' });
                }
            },
            enqueue: async (sessionId, text, modeMeta, localId) => {
                if (get().sessions[sessionId]?.status === 'unsupported') return 'unsupported';
                const content = await deps.encrypt(sessionId, text, modeMeta);
                if (!content) throw new Error('Session encryption is not ready');
                const body = await call(sessionId, '', { method: 'POST', body: JSON.stringify({ localId: localId ?? deps.newLocalId(), content }) });
                if (!body) return 'unsupported';
                await applyItems(sessionId, body.items);
                return 'queued';
            },
            submit: (sessionId, text, modeMeta) => {
                if (get().sessions[sessionId]?.status === 'unsupported') return Promise.resolve('unsupported');
                const row: PendingPrompt = { localId: deps.newLocalId(), text, modeMeta, createdAt: deps.now?.() ?? Date.now(), state: 'sending' };
                setPending(sessionId, (rows) => [...rows, row]);
                return sendPending(sessionId, row);
            },
            retryPending: async (sessionId, localId) => {
                const row = get().sessions[sessionId]?.pending?.find((other) => other.localId === localId);
                if (!row || row.state === 'sending') return 'gone';
                setPending(sessionId, (rows) => rows.map((other) => other.localId === localId ? { ...other, state: 'sending' } : other));
                return sendPending(sessionId, { ...row, state: 'sending' });
            },
            discardPending: (sessionId, localId) => {
                const row = get().sessions[sessionId]?.pending?.find((other) => other.localId === localId) ?? null;
                if (!row || row.state === 'sending') return null;
                setPending(sessionId, (rows) => rows.filter((other) => other.localId !== localId));
                return row;
            },
            updateText: async (sessionId, id, text) => {
                const entry = get().sessions[sessionId]?.items.find((item) => item.id === id);
                if (!entry) return false;
                // B-722: the row shows the new text at once; a failure puts the old one back
                // (the composer keeps the edit for Retry).
                const setText = (next: string) => patch(sessionId, {
                    items: (get().sessions[sessionId]?.items ?? []).map((item) => item.id === id ? { ...item, text: next } : item),
                });
                setText(text);
                try {
                    const content = await deps.encrypt(sessionId, text, entry.modeMeta);
                    if (!content) throw new Error('Session encryption is not ready');
                    const body = await call(sessionId, `/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) });
                    if (!body) { setText(entry.text); return false; }
                    await applyItems(sessionId, body.items);
                    return true;
                } catch (error) {
                    if (error instanceof Error && error.message === 'prompt_queue_item_gone') { await get().load(sessionId); return false; }
                    setText(entry.text);
                    throw error;
                }
            },
            remove: async (sessionId, id) => {
                removedHere.add(id);
                const body = await call(sessionId, `/${id}`, { method: 'DELETE' });
                if (!body) return false;
                await applyItems(sessionId, body.items);
                return body.removed === true;
            },
            move: async (sessionId, id, delta) => {
                const ids = (get().sessions[sessionId]?.items ?? []).map((item) => item.id);
                const next = movedOrder(ids, id, delta);
                if (next === ids) return;
                const body = await call(sessionId, '/order', { method: 'PUT', body: JSON.stringify({ ids: next }) });
                if (body) await applyItems(sessionId, body.items);
            },
            applySnapshot: async (sessionId, items, seq) => {
                const current = get().sessions[sessionId];
                if (current?.status === 'unsupported') return;
                if (typeof seq === 'number') {
                    if (typeof current?.snapshotSeq === 'number' && seq < current.snapshotSeq) return;
                    patch(sessionId, { snapshotSeq: seq });
                }
                await applyItems(sessionId, items);
            },
            settleDispatched: (sessionId, verified) => {
                const rows = get().sessions[sessionId]?.dispatched;
                if (!rows) return;
                const gone = new Set(verified ?? []);
                const next = rows.filter((row) => !gone.has(row.localId) && deps.inTranscript?.(sessionId, row.localId) !== true);
                if (next.length !== rows.length) patch(sessionId, { dispatched: next.length > 0 ? next : undefined });
            },
        };
    });
}

/**
 * B-804: the transcript side of the dock hand-off, set by sync.ts (which owns
 * the messages; importing storage here would close an import cycle).
 */
export const promptQueueTranscript: {
    has: (sessionId: string, localId: string) => boolean;
    verify: (sessionId: string, localIds: string[]) => void;
} = { has: () => false, verify: () => {} };

export const promptQueueStore = createPromptQueueStore({
    request: async (path, init) => {
        const { apiSocket } = await import('./apiSocket');
        const response = await apiSocket.request(path, {
            ...init,
            headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
            // B-803: reads are bounded; writes keep their own handling.
            timeoutMs: !init?.method || init.method === 'GET' ? SYNC_READ_TIMEOUT_MS : undefined,
        });
        return response;
    },
    encrypt: (sessionId, text, modeMeta) => import('./sync').then(({ sync }) => sync.encryptQueuedPrompt(sessionId, text, modeMeta)),
    decrypt: (sessionId, encrypted) => import('./sync').then(({ sync }) => sync.decryptQueuedPrompt(sessionId, encrypted)),
    newLocalId: () => crypto.randomUUID(),
    // B-799: the app's offline judgment counts too (socket gone with navigator.onLine still true).
    isOnline: () => (typeof navigator === 'undefined' || navigator.onLine !== false) && !isNetworkOffline(),
    inTranscript: (sessionId, localId) => promptQueueTranscript.has(sessionId, localId),
    onDispatched: (sessionId, localIds) => promptQueueTranscript.verify(sessionId, localIds),
});

/** B-722: rows that waited for the network go out as soon as the device is back online. */
export function retryWaitingPrompts(store: ReturnType<typeof createPromptQueueStore> = promptQueueStore): void {
    for (const [sessionId, state] of Object.entries(store.getState().sessions)) {
        for (const row of state.pending ?? []) {
            if (row.state === 'waiting') void store.getState().retryPending(sessionId, row.localId).catch(() => {});
        }
    }
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => retryWaitingPrompts());
}

export function usePromptQueue(sessionId: string): PromptQueueSessionState {
    return promptQueueStore((state) => state.sessions[sessionId] ?? EMPTY_PROMPT_QUEUE);
}

export const loadPromptQueue = (sessionId: string) => promptQueueStore.getState().load(sessionId);
/**
 * B-804: resume / reconnect / recovered — re-read a queue this tab already
 * mirrors (a snapshot sent into a dead link is gone for good). A session whose
 * dock never loaded (or has no server queue) is left alone.
 */
export function reloadPromptQueue(sessionId: string, store: ReturnType<typeof createPromptQueueStore> = promptQueueStore): Promise<void> {
    const status = store.getState().sessions[sessionId]?.status;
    if (status !== 'ready' && status !== 'error') return Promise.resolve();
    return store.getState().load(sessionId);
}
export const settleDispatchedPrompts = (sessionId: string, verified?: readonly string[]) => promptQueueStore.getState().settleDispatched(sessionId, verified);
export const enqueuePrompt = (sessionId: string, text: string, modeMeta: MessageModeMeta, localId?: string) => promptQueueStore.getState().enqueue(sessionId, text, modeMeta, localId);
export const submitPrompt = (sessionId: string, text: string, modeMeta: MessageModeMeta) => promptQueueStore.getState().submit(sessionId, text, modeMeta);
export const retryPendingPrompt = (sessionId: string, localId: string) => promptQueueStore.getState().retryPending(sessionId, localId);
export const discardPendingPrompt = (sessionId: string, localId: string) => promptQueueStore.getState().discardPending(sessionId, localId);
export const updatePromptText = (sessionId: string, id: string, text: string) => promptQueueStore.getState().updateText(sessionId, id, text);
export const removePrompt = (sessionId: string, id: string) => promptQueueStore.getState().remove(sessionId, id);
export const movePrompt = (sessionId: string, id: string, delta: -1 | 1) => promptQueueStore.getState().move(sessionId, id, delta);

/** Socket `update` `t:'prompt-queue'` → this session's mirror. */
export function applyPromptQueueUpdate(body: { sid: string; items: PromptQueueWireItem[] }, seq?: number): void {
    void promptQueueStore.getState().applySnapshot(body.sid, body.items, seq);
}
