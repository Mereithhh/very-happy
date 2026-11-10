/**
 * B-914: the 「发送」 button on a ```draft card. Clicking it is the same as the
 * user typing 「发」 for that draft: the web sends ONE ordinary user message to
 * the session it is reading, through the mounted composer (so queue / steer /
 * restore and the B-642 `<edited_drafts>` attachment all behave exactly as
 * for a typed reply). The web never sends anything anywhere else — the agent
 * still performs (or refuses) the actual send under its own rules.
 *
 * Same registration pattern as composerRestore.ts: the composer registers
 * while mounted, so a read-only view (a shared session without a composer)
 * has nobody to hand the request to and the card hides the button.
 */
import { useSyncExternalStore } from 'react';

/** Resolves true once the composer accepted the message (sent or queued). */
type Sender = (text: string) => Promise<boolean>;

const senders = new Map<string, Sender>();
const watchers = new Set<() => void>();

function notify() {
    for (const watcher of [...watchers]) watcher();
}

/** Composer side: accept send requests while mounted. The latest mount wins. */
export function onDraftSendRequest(sessionId: string, sender: Sender): () => void {
    senders.set(sessionId, sender);
    notify();
    return () => {
        if (senders.get(sessionId) === sender) senders.delete(sessionId);
        notify();
    };
}

export function canRequestDraftSend(sessionId: string): boolean {
    return senders.has(sessionId);
}

/** Card side. False when no composer is mounted or the composer refused. */
export async function requestDraftSend(sessionId: string, text: string): Promise<boolean> {
    const sender = senders.get(sessionId);
    if (!sender) return false;
    try { return await sender(text); } catch { return false; }
}

function subscribe(callback: () => void) {
    watchers.add(callback);
    return () => { watchers.delete(callback); };
}

export function useCanRequestDraftSend(sessionId: string): boolean {
    return useSyncExternalStore(subscribe, () => canRequestDraftSend(sessionId), () => false);
}

/* ── 「已请求发送」 survives remounts (the transcript virtualizes) and reloads ── */

const REQUESTED_KEY = 'vh.draft.sendRequested.v1';
const REQUESTED_MAX = 200;
let requested: string[] | null = null;

function loadRequested(): string[] {
    if (requested) return requested;
    try {
        const raw = JSON.parse(localStorage.getItem(REQUESTED_KEY) ?? '[]');
        requested = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
    } catch {
        requested = [];
    }
    return requested;
}

/** `draftKvKey` of a draft whose send was already requested from this browser. */
export function isDraftSendRequested(kvKey: string): boolean {
    return loadRequested().includes(kvKey);
}

export function markDraftSendRequested(kvKey: string): void {
    const list = loadRequested().filter((k) => k !== kvKey);
    list.push(kvKey);
    requested = list.slice(-REQUESTED_MAX);
    try { localStorage.setItem(REQUESTED_KEY, JSON.stringify(requested)); } catch { /* private mode: this tab still remembers */ }
}

export function __resetDraftSendForTests(): void {
    senders.clear();
    requested = null;
    notify();
}
