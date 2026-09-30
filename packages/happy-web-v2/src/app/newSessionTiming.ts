/**
 * newSessionTiming (B-512) — cheap instrumentation of "click new → composer
 * usable", the path the spec's ≤1.5 s target is measured on.
 *
 *   click → rpcSent → rpcReturned → inStore → composer
 *
 * Each stage drops a `performance.mark('vh:new-session:<stage>')` (visible in
 * the DevTools Performance panel), and when the composer mounts ONE summary
 * line is logged — only in dev builds or with the existing Debug mode local
 * setting on. At most one trace is live; a new click replaces it, and a trace
 * older than a minute is dropped instead of reported.
 *
 * `inStore` can happen BEFORE the RPC returns (the `new-session` update often
 * beats the spawn RPC response), when the session id is not known yet, so
 * store arrivals are remembered per id while a trace is open and matched once
 * the RPC names the session.
 */
import { storage } from '@/sync/storage';

export type NewSessionStage = 'click' | 'rpcSent' | 'rpcReturned' | 'inStore' | 'composer';

interface Trace {
    source: string;
    sessionId: string | null;
    at: Partial<Record<NewSessionStage, number>>;
    storeSeen: Map<string, number>;
}

const MAX_AGE_MS = 60_000;
let trace: Trace | null = null;

type Reporter = (line: string) => void;
let reporter: Reporter | null = (line) => console.log(line);
let shouldReport: () => boolean = () =>
    import.meta.env.DEV || storage.getState().localSettings.debugMode === true;

/** Wire the output (done once at startup, and by tests). */
export function configureNewSessionTiming(options: { report: Reporter; enabled: () => boolean }): void {
    reporter = options.report;
    shouldReport = options.enabled;
}

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function mark(stage: NewSessionStage): number {
    const t = now();
    try { performance.mark(`vh:new-session:${stage}`); } catch { /* no User Timing */ }
    return t;
}

function live(): Trace | null {
    if (trace && trace.at.click !== undefined && now() - trace.at.click > MAX_AGE_MS) trace = null;
    return trace;
}

/** The user asked for a new chat (quick "+" or the dialog's Create). */
export function newSessionTimingStart(source: string): void {
    trace = { source, sessionId: null, at: {}, storeSeen: new Map() };
    trace.at.click = mark('click');
}

export function newSessionTimingRpcSent(): void {
    const t = live();
    if (t && t.at.rpcSent === undefined) t.at.rpcSent = mark('rpcSent');
}

export function newSessionTimingRpcReturned(sessionId: string): void {
    const t = live();
    if (!t || t.sessionId) return;
    t.at.rpcReturned = mark('rpcReturned');
    t.sessionId = sessionId;
    const seen = t.storeSeen.get(sessionId);
    if (seen !== undefined) t.at.inStore = seen;
    t.storeSeen.clear();
}

/** The spawn failed / was handed to the dialog — nothing to report. */
export function newSessionTimingCancel(): void {
    trace = null;
}

export function newSessionTimingInStore(sessionId: string): void {
    const t = live();
    if (!t) return;
    if (t.sessionId === null) {
        if (!t.storeSeen.has(sessionId)) t.storeSeen.set(sessionId, mark('inStore'));
        return;
    }
    if (t.sessionId === sessionId && t.at.inStore === undefined) t.at.inStore = mark('inStore');
}

/** The session page rendered its composer for `sessionId`. Ends the trace. */
export function newSessionTimingComposerMounted(sessionId: string): void {
    const t = live();
    if (!t || t.sessionId !== sessionId) return;
    t.at.composer = mark('composer');
    if (t.at.inStore === undefined) t.at.inStore = t.at.composer;
    trace = null;
    try { performance.measure('vh:new-session', 'vh:new-session:click', 'vh:new-session:composer'); } catch { /* ignore */ }
    if (reporter && shouldReport()) reporter(formatNewSessionTiming(t.source, sessionId, t.at));
}

const ms = (a?: number, b?: number) => (a === undefined || b === undefined ? '?' : `${Math.round(b - a)}ms`);

/** One line: total plus each stage's delta from the click. */
export function formatNewSessionTiming(source: string, sessionId: string, at: Partial<Record<NewSessionStage, number>>): string {
    return `[new-session timing] ${source} ${sessionId} total=${ms(at.click, at.composer)}`
        + ` rpcSent=${ms(at.click, at.rpcSent)} rpc=${ms(at.rpcSent, at.rpcReturned)}`
        + ` inStore=${ms(at.click, at.inStore)} composer=${ms(at.click, at.composer)}`;
}
