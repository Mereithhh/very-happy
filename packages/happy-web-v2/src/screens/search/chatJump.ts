/**
 * B-650 — "open the session and land on the hit".
 *
 * The search panel navigates to `/session/<id>` and leaves a pending jump
 * here; the session's ChatList picks it up once it has messages (it may
 * mount after the navigation, so this is a store, not an event). The target is
 * resolved in two steps:
 *   1. which MESSAGE — the cached hit's id, else the message whose raw text
 *      holds the snippet (daemon hits carry no very-happy id), else older
 *      pages are loaded a bounded number of times;
 *   2. which DOM node — done by `useChatJump` (text search inside the
 *      transcript, falling back to that turn's prompt).
 * Pure parts are unit-tested; no React here.
 */
import type { Message } from '@/sync/typesMessage';
import { messageSearchText } from './sessionSearch';

export interface ChatJumpRequest {
    /** Lower-cased query terms (for highlighting and the fallback match). */
    terms: string[];
    /** Exact target (cached hit, or a 汇报板 anchor — B-766). */
    messageId?: string;
    /** B-766: an Owner message anchored by its client localId (the server id is not known when the item is written). */
    localId?: string;
    /** Snippet text (daemon hit) — locates the message by content. */
    snippet?: string;
    /** Daemon snippet timestamp — breaks ties between equal candidates. */
    at?: number;
    /** B-766: tint the landed element briefly (a jump with no terms to paint, e.g. 「已答 ↗」). */
    flash?: boolean;
}

/** Older pages loaded at most while looking for a daemon hit. */
export const MAX_JUMP_OLDER_PAGES = 6;

const pending = new Map<string, ChatJumpRequest>();
type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function requestChatJump(sessionId: string, req: ChatJumpRequest): void {
    pending.set(sessionId, req);
    for (const l of listeners.get(sessionId) ?? []) l();
}

export function peekChatJump(sessionId: string): ChatJumpRequest | undefined {
    return pending.get(sessionId);
}

/** Consume the request only if it is still the one being handled (a newer click wins). */
export function finishChatJump(sessionId: string, req: ChatJumpRequest): void {
    if (pending.get(sessionId) === req) pending.delete(sessionId);
}

export function onChatJumpRequest(sessionId: string, listener: Listener): () => void {
    let set = listeners.get(sessionId);
    if (!set) listeners.set(sessionId, (set = new Set()));
    set.add(listener);
    return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(sessionId);
    };
}

/** Normalise for comparison: drop ellipses, markdown punctuation and collapse whitespace. */
export function normalizeForMatch(text: string): string {
    return text.replace(/…/g, ' ').replace(/[`*_#>~|[\]()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The most distinctive piece of a snippet: the longest run between its
 * ellipses, cut to ≤ 48 chars around the first term occurrence.
 */
export function snippetNeedle(snippet: string, terms: readonly string[]): string {
    const flat = normalizeForMatch(snippet);
    if (!flat) return '';
    const term = terms.find((t) => flat.includes(t));
    if (!term) return flat.slice(0, 48);
    const at = flat.indexOf(term);
    const start = Math.max(0, at - 16);
    return flat.slice(start, Math.min(flat.length, start + Math.max(48, term.length))).trim();
}

/**
 * Pick the message a jump lands on. Candidates contain every term (else any
 * term); the snippet needle wins outright; then the one closest to `at`; then
 * the newest. `chronological` is old → new.
 */
export function findJumpMessage(chronological: readonly Message[], req: ChatJumpRequest): string | null {
    if (req.messageId) {
        const found = deepFind(chronological, (m) => m.id === req.messageId);
        if (found) return found;
    }
    if (req.localId) {
        const found = deepFind(chronological, (m) => 'localId' in m && m.localId === req.localId);
        if (found) return found;
    }
    if (req.terms.length === 0) return null;
    const needle = req.snippet ? snippetNeedle(req.snippet, req.terms) : '';
    type C = { id: string; all: boolean; needle: boolean; createdAt: number };
    const cands: C[] = [];
    walk(chronological, (m, topId) => {
        const st = messageSearchText(m);
        if (!st) return;
        const norm = normalizeForMatch(st.text);
        const hits = req.terms.filter((t) => norm.includes(t)).length;
        if (hits === 0) return;
        cands.push({ id: topId, all: hits === req.terms.length, needle: !!needle && norm.includes(needle), createdAt: m.createdAt });
    });
    if (cands.length === 0) return null;
    const score = (c: C) => (c.needle ? 4 : 0) + (c.all ? 2 : 0);
    cands.sort((a, b) => {
        const d = score(b) - score(a);
        if (d) return d;
        if (req.at !== undefined) return Math.abs(a.createdAt - req.at) - Math.abs(b.createdAt - req.at);
        return b.createdAt - a.createdAt;
    });
    return cands[0].id;
}

/** Visit every message; children report the TOP-LEVEL id (what the transcript renders). */
function walk(list: readonly Message[], visit: (m: Message, topId: string) => void, topId?: string): void {
    for (const m of list) {
        const id = topId ?? m.id;
        visit(m, id);
        if (m.kind === 'tool-call' && m.children.length) walk(m.children, visit, id);
    }
}

function deepFind(list: readonly Message[], pred: (m: Message) => boolean): string | null {
    let out: string | null = null;
    walk(list, (m, topId) => { if (!out && pred(m)) out = topId; });
    return out;
}

/** The user prompt that opens the turn containing `messageId` (old → new list). */
export function promptForMessage(chronological: readonly Message[], messageId: string): string | null {
    let prompt: string | null = null;
    for (const m of chronological) {
        if (m.kind === 'user-text') prompt = m.id;
        if (m.id === messageId) return prompt;
    }
    return null;
}
