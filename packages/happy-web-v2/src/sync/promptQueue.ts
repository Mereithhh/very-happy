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

export type PromptQueueSessionState = {
    items: PromptQueueEntry[];
    status: PromptQueueStatus;
    /** Highest socket-update seq applied; snapshots arriving out of order are dropped. */
    snapshotSeq?: number;
};

export type PromptQueueWireItem = ApiPromptQueueUpdate['items'][number];

export type PromptQueueDeps = {
    request: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;
    encrypt: (sessionId: string, text: string, modeMeta: MessageModeMeta) => Promise<string | null>;
    decrypt: (sessionId: string, encrypted: string) => Promise<unknown | null>;
    newLocalId: () => string;
};

interface PromptQueueStoreState {
    sessions: Record<string, PromptQueueSessionState>;
    load: (sessionId: string) => Promise<void>;
    /** `localId` (optional) makes a retry / a second tab's migration of the same item idempotent on the server. */
    enqueue: (sessionId: string, text: string, modeMeta: MessageModeMeta, localId?: string) => Promise<'queued' | 'unsupported'>;
    updateText: (sessionId: string, id: string, text: string) => Promise<boolean>;
    remove: (sessionId: string, id: string) => Promise<boolean>;
    move: (sessionId: string, id: string, delta: -1 | 1) => Promise<void>;
    /** `seq` = the socket update's account seq; an older snapshot than one already applied is ignored. */
    applySnapshot: (sessionId: string, items: PromptQueueWireItem[], seq?: number) => Promise<void>;
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
        const applyItems = async (sessionId: string, raw: unknown) => {
            const items = Array.isArray(raw) ? raw.filter(isWireItem) : [];
            patch(sessionId, { items: await decode(sessionId, items), status: 'ready' });
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
                try {
                    const body = await call(sessionId, '');
                    if (body) await applyItems(sessionId, body.items);
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
            updateText: async (sessionId, id, text) => {
                const entry = get().sessions[sessionId]?.items.find((item) => item.id === id);
                if (!entry) return false;
                const content = await deps.encrypt(sessionId, text, entry.modeMeta);
                if (!content) throw new Error('Session encryption is not ready');
                try {
                    const body = await call(sessionId, `/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) });
                    if (!body) return false;
                    await applyItems(sessionId, body.items);
                    return true;
                } catch (error) {
                    if (error instanceof Error && error.message === 'prompt_queue_item_gone') { await get().load(sessionId); return false; }
                    throw error;
                }
            },
            remove: async (sessionId, id) => {
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
        };
    });
}

export const promptQueueStore = createPromptQueueStore({
    request: async (path, init) => {
        const { apiSocket } = await import('./apiSocket');
        const response = await apiSocket.request(path, {
            ...init,
            headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        });
        return response;
    },
    encrypt: (sessionId, text, modeMeta) => import('./sync').then(({ sync }) => sync.encryptQueuedPrompt(sessionId, text, modeMeta)),
    decrypt: (sessionId, encrypted) => import('./sync').then(({ sync }) => sync.decryptQueuedPrompt(sessionId, encrypted)),
    newLocalId: () => crypto.randomUUID(),
});

export function usePromptQueue(sessionId: string): PromptQueueSessionState {
    return promptQueueStore((state) => state.sessions[sessionId] ?? EMPTY_PROMPT_QUEUE);
}

export const loadPromptQueue = (sessionId: string) => promptQueueStore.getState().load(sessionId);
export const enqueuePrompt = (sessionId: string, text: string, modeMeta: MessageModeMeta, localId?: string) => promptQueueStore.getState().enqueue(sessionId, text, modeMeta, localId);
export const updatePromptText = (sessionId: string, id: string, text: string) => promptQueueStore.getState().updateText(sessionId, id, text);
export const removePrompt = (sessionId: string, id: string) => promptQueueStore.getState().remove(sessionId, id);
export const movePrompt = (sessionId: string, id: string, delta: -1 | 1) => promptQueueStore.getState().move(sessionId, id, delta);

/** Socket `update` `t:'prompt-queue'` → this session's mirror. */
export function applyPromptQueueUpdate(body: { sid: string; items: PromptQueueWireItem[] }, seq?: number): void {
    void promptQueueStore.getState().applySnapshot(body.sid, body.items, seq);
}
