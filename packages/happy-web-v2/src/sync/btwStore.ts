/**
 * btwStore — per-session side-question ("/btw") state (B-283).
 *
 * Independent zustand store (assistantStore precedent), memory only: like
 * Claude Code's own `btwHistory` the exchanges live as long as the page. The
 * store — not the panel — owns the ask→poll loop, so closing the panel never
 * abandons a running question (the CLI's "panel torn down; question handed
 * on" semantics) and reopening shows the answer.
 *
 * Transport is injectable (`createBtwStore(deps)`) so the loop is unit-tested
 * without sockets or real timers.
 */
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
}

export interface BtwStoreDeps {
    ask: (sessionId: string, question: string, history: { question: string; answer: string }[]) => Promise<SideQuestionAskResponse>;
    poll: (sessionId: string, requestId: string) => Promise<SideQuestionPollResponse>;
    cancel: (sessionId: string, requestId: string) => Promise<boolean>;
    delay: (ms: number) => Promise<void>;
    now: () => number;
    pollMs?: number;
}

export const EMPTY_BTW_SESSION: BtwSessionState = Object.freeze({ exchanges: [], draft: '' }) as BtwSessionState;
const HISTORY_FOR_PROMPT = 12;
/** Same clip the CLI applies before building the prompt — no point shipping more (RPC payload cap). */
export const HISTORY_CLIP_CHARS = 2000;
const MAX_POLL_FAILURES = 5;
const clip = (text: string) => (text.length > HISTORY_CLIP_CHARS ? `${text.slice(0, HISTORY_CLIP_CHARS)}…` : text);

let seq = 0;
const nextId = () => `btw-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function createBtwStore(deps: BtwStoreDeps) {
    const pollMs = deps.pollMs ?? 1000;
    return create<BtwStoreState>((set, get) => {
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

        return {
            sessions: {},
            setDraft: (sessionId, draft) => set((state) => ({
                sessions: { ...state.sessions, [sessionId]: { ...(state.sessions[sessionId] ?? EMPTY_BTW_SESSION), draft } },
            })),
            clear: (sessionId) => set((state) => {
                const { [sessionId]: _dropped, ...rest } = state.sessions;
                return { sessions: rest };
            }),
            ask: async (sessionId, rawQuestion) => {
                const question = rawQuestion.trim();
                if (!question) return;
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
}

export const btwStore = createBtwStore({
    ask: (sessionId, question, history) => import('./ops').then((ops) => ops.sessionBtwAsk(sessionId, question, history)),
    poll: (sessionId, requestId) => import('./ops').then((ops) => ops.sessionBtwPoll(sessionId, requestId)),
    cancel: (sessionId, requestId) => import('./ops').then((ops) => ops.sessionBtwCancel(sessionId, requestId)),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
});

export function useBtwSession(sessionId: string): BtwSessionState {
    return btwStore((state) => state.sessions[sessionId] ?? EMPTY_BTW_SESSION);
}
