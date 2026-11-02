/**
 * btwStore — per-session side-question ("/btw") state (B-283).
 *
 * Independent zustand store (assistantStore precedent). The store — not the
 * panel — owns the ask→poll loop, so closing the panel never abandons a
 * running question (the CLI's "panel torn down; question handed on"
 * semantics) and reopening shows the answer.
 *
 * B-861: each session's side chat is kept in this browser's localStorage, so
 * a reload keeps it; a question still running at reload resumes polling by
 * its request id (the CLI keeps the slot, and 5 min after it finishes).
 * Other devices do not see it — nothing goes to the server. Storage that
 * throws or is full degrades to the old memory-only behaviour.
 *
 * Transport is injectable (`createBtwStore(deps)`) so the loop is unit-tested
 * without sockets or real timers.
 */
import { useLayoutEffect } from 'react';
import { create } from 'zustand';
// type-only: a static value import of ./ops would drag the whole sync graph
// (storage/localStorage) into every consumer, incl. unit tests of this store.
import type { SideQuestionAskResponse, SideQuestionPollResponse, SideQuestionStatus } from './ops';

export interface BtwExchange {
    id: string;
    question: string;
    answer: string;
    status: SideQuestionStatus;
    error?: string;
    startedAt: number;
    finishedAt?: number;
    requestId?: string;
    /** false = answered without the main conversation's context (asked before its first turn) */
    hadContext: boolean;
}

export interface BtwSessionState {
    exchanges: BtwExchange[];
    draft: string;
}

interface BtwStoreState {
    sessions: Record<string, BtwSessionState>;
    ask: (sessionId: string, question: string) => Promise<void>;
    cancel: (sessionId: string) => Promise<void>;
    setDraft: (sessionId: string, draft: string) => void;
    clear: (sessionId: string) => void;
    /** B-861: load the stored side chat once per session (in-memory state wins). */
    hydrate: (sessionId: string) => void;
}

/** Where a session's side chat is kept between page loads (B-861). */
export interface BtwPersistence {
    load: (sessionId: string) => unknown;
    save: (sessionId: string, state: BtwSessionState | null) => void;
}

export interface BtwStoreDeps {
    ask: (sessionId: string, question: string, history: { question: string; answer: string }[]) => Promise<SideQuestionAskResponse>;
    poll: (sessionId: string, requestId: string) => Promise<SideQuestionPollResponse>;
    cancel: (sessionId: string, requestId: string) => Promise<boolean>;
    delay: (ms: number) => Promise<void>;
    now: () => number;
    pollMs?: number;
    persistence?: BtwPersistence;
}

export const EMPTY_BTW_SESSION: BtwSessionState = Object.freeze({ exchanges: [], draft: '' }) as BtwSessionState;
const HISTORY_FOR_PROMPT = 12;
/** Same clip the CLI applies before building the prompt — no point shipping more (RPC payload cap). */
export const HISTORY_CLIP_CHARS = 2000;
const MAX_POLL_FAILURES = 5;
const clip = (text: string) => (text.length > HISTORY_CLIP_CHARS ? `${text.slice(0, HISTORY_CLIP_CHARS)}…` : text);

/** Newest exchanges kept in storage, each answer clipped. */
export const MAX_STORED_EXCHANGES = 50;
const MAX_STORED_ANSWER_CHARS = 20_000;
const STATUSES: readonly SideQuestionStatus[] = ['running', 'done', 'error', 'cancelled'];

/** Validate what storage gave back; anything malformed is dropped, never thrown. */
export function parseStoredBtwSession(raw: unknown): BtwSessionState | null {
    if (!raw || typeof raw !== 'object') return null;
    const { exchanges, draft } = raw as { exchanges?: unknown; draft?: unknown };
    const list = Array.isArray(exchanges) ? exchanges.flatMap((e): BtwExchange[] => {
        if (!e || typeof e !== 'object') return [];
        const x = e as Record<string, unknown>;
        if (typeof x.id !== 'string' || typeof x.question !== 'string' || typeof x.answer !== 'string'
            || !STATUSES.includes(x.status as SideQuestionStatus) || typeof x.startedAt !== 'number') return [];
        return [{
            id: x.id, question: x.question, answer: x.answer, status: x.status as SideQuestionStatus, startedAt: x.startedAt,
            hadContext: x.hadContext !== false,
            ...(typeof x.error === 'string' ? { error: x.error } : {}),
            ...(typeof x.finishedAt === 'number' ? { finishedAt: x.finishedAt } : {}),
            ...(typeof x.requestId === 'string' ? { requestId: x.requestId } : {}),
        }];
    }) : [];
    const text = typeof draft === 'string' ? draft : '';
    return list.length || text ? { exchanges: list, draft: text } : null;
}

/** What is written: the newest exchanges, long answers clipped; null = nothing to keep. */
export function storableBtwSession(state: BtwSessionState | undefined): BtwSessionState | null {
    if (!state || (!state.exchanges.length && !state.draft)) return null;
    return {
        draft: state.draft,
        exchanges: state.exchanges.slice(-MAX_STORED_EXCHANGES).map((e) => (
            e.answer.length > MAX_STORED_ANSWER_CHARS ? { ...e, answer: `${e.answer.slice(0, MAX_STORED_ANSWER_CHARS)}…` } : e
        )),
    };
}

const STORAGE_PREFIX = 'vh.btw.v1:';
export const localBtwPersistence: BtwPersistence = {
    load: (sessionId) => {
        try {
            const raw = localStorage.getItem(STORAGE_PREFIX + sessionId);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    },
    save: (sessionId, state) => {
        try {
            if (state) localStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(state));
            else localStorage.removeItem(STORAGE_PREFIX + sessionId);
        } catch { /* private mode / quota: memory-only for this page */ }
    },
};

let seq = 0;
const nextId = () => `btw-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function createBtwStore(deps: BtwStoreDeps) {
    const pollMs = deps.pollMs ?? 1000;
    const persistence = deps.persistence;
    const hydrated = new Set<string>();
    const store = create<BtwStoreState>((set, get) => {
        const patch = (sessionId: string, id: string, update: Partial<BtwExchange>) => {
            set((state) => {
                const current = state.sessions[sessionId] ?? EMPTY_BTW_SESSION;
                return {
                    sessions: {
                        ...state.sessions,
                        [sessionId]: {
                            ...current,
                            exchanges: current.exchanges.map((e) => (e.id === id ? { ...e, ...update } : e)),
                        },
                    },
                };
            });
        };
        const find = (sessionId: string, id: string) => get().sessions[sessionId]?.exchanges.find((e) => e.id === id);

        const pollUntilSettled = async (sessionId: string, id: string, requestId: string) => {
            let failures = 0;
            for (;;) {
                await deps.delay(pollMs);
                const live = find(sessionId, id);
                if (!live || live.status !== 'running') return; // cancelled/cleared locally
                try {
                    const snapshot = await deps.poll(sessionId, requestId);
                    failures = 0;
                    if (snapshot.status === 'running') {
                        if (snapshot.text !== live.answer) patch(sessionId, id, { answer: snapshot.text });
                        continue;
                    }
                    patch(sessionId, id, {
                        status: snapshot.status,
                        answer: snapshot.text,
                        error: snapshot.error,
                        finishedAt: snapshot.finishedAt ?? deps.now(),
                        ...(typeof snapshot.hadContext === 'boolean' ? { hadContext: snapshot.hadContext } : {}),
                    });
                    return;
                } catch (error) {
                    failures += 1;
                    if (failures >= MAX_POLL_FAILURES) {
                        patch(sessionId, id, {
                            status: 'error',
                            error: error instanceof Error ? error.message : String(error),
                            finishedAt: deps.now(),
                        });
                        // Giving up locally must not leave the CLI slot busy.
                        try { await deps.cancel(sessionId, requestId); } catch { /* best effort */ }
                        return;
                    }
                }
            }
        };

        return {
            sessions: {},
            setDraft: (sessionId, draft) => {
                // Hydrate first: a draft written into an unloaded session would
                // otherwise be saved over the stored chat.
                get().hydrate(sessionId);
                set((state) => ({
                    sessions: { ...state.sessions, [sessionId]: { ...(state.sessions[sessionId] ?? EMPTY_BTW_SESSION), draft } },
                }));
            },
            clear: (sessionId) => set((state) => {
                const { [sessionId]: _dropped, ...rest } = state.sessions;
                return { sessions: rest };
            }),
            hydrate: (sessionId) => {
                if (!persistence || hydrated.has(sessionId)) return;
                hydrated.add(sessionId);
                if (get().sessions[sessionId]) return;
                const stored = parseStoredBtwSession(persistence.load(sessionId));
                if (!stored) return;
                // Running at reload: resume the poll by request id (the CLI
                // still has it, or says "Unknown side question" → error after
                // a few polls). Without an id the ask never came back.
                const exchanges = stored.exchanges.map((e) => (
                    e.status === 'running' && !e.requestId ? { ...e, status: 'cancelled' as const, finishedAt: e.finishedAt ?? deps.now() } : e
                ));
                set((state) => ({ sessions: { ...state.sessions, [sessionId]: { ...stored, exchanges } } }));
                for (const e of exchanges) {
                    if (e.status === 'running' && e.requestId) void pollUntilSettled(sessionId, e.id, e.requestId);
                }
            },
            ask: async (sessionId, rawQuestion) => {
                const question = rawQuestion.trim();
                if (!question) return;
                get().hydrate(sessionId);
                const current = get().sessions[sessionId] ?? EMPTY_BTW_SESSION;
                if (current.exchanges.some((e) => e.status === 'running')) return;
                const history = current.exchanges
                    .filter((e) => e.status === 'done' && e.answer.trim())
                    .slice(-HISTORY_FOR_PROMPT)
                    .map((e) => ({ question: clip(e.question), answer: clip(e.answer) }));
                const id = nextId();
                const exchange: BtwExchange = {
                    id, question, answer: '', status: 'running', startedAt: deps.now(), hadContext: true,
                };
                set((state) => ({
                    sessions: {
                        ...state.sessions,
                        [sessionId]: { ...current, draft: '', exchanges: [...current.exchanges, exchange] },
                    },
                }));

                let requestId: string;
                try {
                    const ack = await deps.ask(sessionId, question, history);
                    requestId = ack.requestId;
                    patch(sessionId, id, { requestId, hadContext: ack.hadContext });
                    // Stop pressed during the ask round-trip: the CLI slot is
                    // live but nobody told it — release it now.
                    if (find(sessionId, id)?.status !== 'running') {
                        try { await deps.cancel(sessionId, requestId); } catch { /* best effort */ }
                        return;
                    }
                } catch (error) {
                    patch(sessionId, id, {
                        status: 'error',
                        error: error instanceof Error ? error.message : String(error),
                        finishedAt: deps.now(),
                    });
                    return;
                }
                await pollUntilSettled(sessionId, id, requestId);
            },
            cancel: async (sessionId) => {
                const running = get().sessions[sessionId]?.exchanges.find((e) => e.status === 'running');
                if (!running) return;
                patch(sessionId, running.id, { status: 'cancelled', finishedAt: deps.now() });
                if (running.requestId) {
                    try { await deps.cancel(sessionId, running.requestId); } catch { /* wrapper gone: local state already final */ }
                }
            },
        };
    });
    if (persistence) {
        // Write each session whose state object changed (patch/set always
        // replace it); `clear` drops the key.
        store.subscribe((state, prev) => {
            if (state.sessions === prev.sessions) return;
            for (const id of new Set([...Object.keys(state.sessions), ...Object.keys(prev.sessions)])) {
                if (state.sessions[id] !== prev.sessions[id]) persistence.save(id, storableBtwSession(state.sessions[id]));
            }
        });
    }
    return store;
}

export const btwStore = createBtwStore({
    ask: (sessionId, question, history) => import('./ops').then((ops) => ops.sessionBtwAsk(sessionId, question, history)),
    poll: (sessionId, requestId) => import('./ops').then((ops) => ops.sessionBtwPoll(sessionId, requestId)),
    cancel: (sessionId, requestId) => import('./ops').then((ops) => ops.sessionBtwCancel(sessionId, requestId)),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    persistence: localBtwPersistence,
});

export function useBtwSession(sessionId: string): BtwSessionState {
    // Before paint: a reopened panel shows the stored chat, not a flash of the empty state.
    useLayoutEffect(() => { btwStore.getState().hydrate(sessionId); }, [sessionId]);
    return btwStore((state) => state.sessions[sessionId] ?? EMPTY_BTW_SESSION);
}
