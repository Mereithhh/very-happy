/**
 * One feedback path for every session the user starts without being taken
 * into it (Owner 10-27: 「我看到创建出来了，就是不明显，对话太多了」 — a big
 * account's sidebar swallowed the new row).
 *
 * `announceDispatched` does three things:
 *   - a toast 「已创建 <名字> 的会话 · 打开」 whose button opens the session;
 *   - a one-shot sidebar reveal: the Sidebar unfolds the row's groups for this
 *     route only, scrolls it into its own list and highlights it ~3 s;
 *   - a 「新」 mark that stays (device-local, survives a reload) until the
 *     session is opened once; a folded group's header counts them.
 * `announceDispatchFailed` is the error toast with the reason.
 *
 * Entries whose meaning is "click and go in" (new chat, fork, team start)
 * navigate as before and do not call this.
 */
import { useSyncExternalStore } from 'react';
import { toast } from '@/ui/Toast';
import { t } from '@/text';

/** How long the sidebar keeps the row highlighted after revealing it. */
export const DISPATCH_HIGHLIGHT_MS = 3_000;
/** The toast stays long enough to read and reach (the default success toast is 1.8 s). */
export const DISPATCH_TOAST_MS = 8_000;
/** A reveal nobody could show (sidebar unmounted, row never arrived) lapses. */
export const DISPATCH_REVEAL_TTL_MS = 2 * 60_000;
/** 「新」 marks are pruned after a week, and at most this many are kept. */
export const FRESH_TTL_MS = 7 * 24 * 60 * 60_000;
export const FRESH_MAX = 50;
const STORAGE_KEY = 'vh.dispatch.fresh.v1';

export interface DispatchReveal { sessionId: string; seq: number; at: number }
export interface DispatchFeedbackState {
    /** sessionId → when it was announced; cleared when the session is opened */
    fresh: Readonly<Record<string, number>>;
    reveal: DispatchReveal | null;
    highlight: { sessionId: string; until: number } | null;
}

/** Drop expired marks and keep the newest FRESH_MAX. Pure. */
export function pruneFresh(fresh: Readonly<Record<string, number>>, now: number): Record<string, number> {
    const kept = Object.entries(fresh)
        .filter(([id, at]) => typeof id === 'string' && id.length > 0 && Number.isFinite(at) && now - at < FRESH_TTL_MS)
        .sort((a, b) => b[1] - a[1])
        .slice(0, FRESH_MAX);
    return Object.fromEntries(kept);
}

/** The session a route opens (`/session/<id>` and its sub-pages), or null. Pure. */
export function sessionIdOfPath(pathname: string): string | null {
    const m = /^\/session\/([^/?#]+)/.exec(pathname);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** The reveal still waiting to be shown, or null once consumed / lapsed. Pure. */
export function liveReveal(reveal: DispatchReveal | null, now: number): DispatchReveal | null {
    return reveal && now - reveal.at < DISPATCH_REVEAL_TTL_MS ? reveal : null;
}

function readStored(): Record<string, number> {
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return pruneFresh(parsed as Record<string, number>, Date.now());
    } catch { return {}; }
}
function writeStored(fresh: Record<string, number>): void {
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(fresh)); } catch { /* private mode: memory only */ }
}

let state: DispatchFeedbackState = { fresh: readStored(), reveal: null, highlight: null };
let seq = 0;
const listeners = new Set<() => void>();
function set(next: Partial<DispatchFeedbackState>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getDispatchFeedbackState(): DispatchFeedbackState { return state; }
export function useDispatchFeedback<T>(select: (s: DispatchFeedbackState) => T): T {
    return useSyncExternalStore(subscribe, () => select(state), () => select(state));
}

let navigator: ((to: string) => void) | null = null;
/** Mounted once in AppLayout so the toast's 打开 can route. */
export function setDispatchNavigator(navigate: ((to: string) => void) | null): () => void {
    navigator = navigate;
    return () => { if (navigator === navigate) navigator = null; };
}
let currentPath = typeof location !== 'undefined' ? location.pathname : '';
/** The route on screen is this session's page (as of the last route change). */
export function isViewingSession(sessionId: string): boolean {
    return sessionIdOfPath(currentPath) === sessionId;
}
export function sessionHref(sessionId: string): string {
    return `/session/${encodeURIComponent(sessionId)}`;
}

/**
 * A session the user started without entering it. `name` is who/what it is
 * for (the member, the folder); `kind: 'delivered'` is a task handed to a
 * member's existing session — same toast and reveal, no 「新」 mark.
 */
export function announceDispatched(opts: { sessionId: string; name?: string | null; kind?: 'created' | 'delivered'; now?: number }): void {
    const now = opts.now ?? Date.now();
    const { sessionId } = opts;
    const name = opts.name?.trim();
    const delivered = opts.kind === 'delivered';
    const alreadyHere = sessionIdOfPath(currentPath) === sessionId;
    set({
        fresh: delivered || alreadyHere ? state.fresh : pruneFresh({ ...state.fresh, [sessionId]: now }, now),
        reveal: { sessionId, seq: ++seq, at: now },
    });
    writeStored(state.fresh as Record<string, number>);
    const message = delivered ? t('dispatch.delivered', { name: name || '—' })
        : name ? t('dispatch.created', { name }) : t('dispatch.createdUnnamed');
    toast.show(message, 'success', {
        button: { label: t('dispatch.open'), onClick: () => navigator?.(sessionHref(sessionId)) },
        durationMs: DISPATCH_TOAST_MS,
    });
}

/** Several sessions at once (batch import): 「新」 marks only — the caller's own toast reports the batch. */
export function markFresh(sessionIds: readonly string[], now = Date.now()): void {
    const ids = sessionIds.filter((id) => id && !isViewingSession(id));
    if (!ids.length) return;
    set({ fresh: pruneFresh({ ...state.fresh, ...Object.fromEntries(ids.map((id) => [id, now])) }, now) });
    writeStored(state.fresh as Record<string, number>);
}

export function announceDispatchFailed(opts: { name?: string | null; reason?: string | null }): void {
    const name = opts.name?.trim();
    const reason = opts.reason?.trim() || 'unknown_error';
    toast.error(name ? t('dispatch.failed', { name, reason }) : t('dispatch.failedUnnamed', { reason }));
}

/** The Sidebar showed the row: start the highlight and drop the reveal. */
export function consumeDispatchReveal(revealSeq: number, now = Date.now()): void {
    const reveal = state.reveal;
    if (!reveal || reveal.seq !== revealSeq) return;
    set({ reveal: null, highlight: { sessionId: reveal.sessionId, until: now + DISPATCH_HIGHLIGHT_MS } });
    setTimeout(() => {
        if (state.highlight?.sessionId === reveal.sessionId && Date.now() >= state.highlight.until - 50) set({ highlight: null });
    }, DISPATCH_HIGHLIGHT_MS);
}

/** Route bridge: opening a session once clears its 「新」 mark. */
export function noteDispatchRoute(pathname: string): void {
    currentPath = pathname;
    const id = sessionIdOfPath(pathname);
    if (!id || !(id in state.fresh)) return;
    const { [id]: _opened, ...rest } = state.fresh;
    set({ fresh: rest });
    writeStored(rest);
}

/** Tests only. */
export function resetDispatchFeedbackForTests(fresh: Record<string, number> = {}): void {
    seq = 0;
    currentPath = '';
    state = { fresh, reveal: null, highlight: null };
}
