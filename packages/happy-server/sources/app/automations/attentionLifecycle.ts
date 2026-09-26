import { db } from '@/storage/db';
import { log } from '@/utils/log';

/**
 * B-508 attention lifecycle — the pure rules for「需要我决策」resolving itself,
 * plus the two best-effort hooks the message / archive ingress calls.
 *
 * A run is *about* `sessionId` plus whatever sessions its payload names
 * (`linkedSessionIds`). When the owner speaks in one of those sessions the
 * decision has been taken; the flag clears with `ackedBy = owner-replied`.
 * Message bodies are encrypted with the account key, so "the owner spoke" is
 * judged on plaintext only: the socket connection type, the `X-Happy-Client`
 * tag and the localId prefix every automated sender stamps.
 */

/** localId prefixes stamped by automated senders (daemon automations, Teams, cross-machine send, peer messages, conflict notices). */
export const AUTOMATED_LOCAL_ID_PREFIXES = ['automation-', 'teams-', 'remote-send-', 'session-message-', 'edit-conflict-'] as const;
/** `X-Happy-Client` tags (the part before `/`) of automated senders. */
export const AUTOMATED_CLIENT_TAGS = ['automation', 'teams', 'cli-spawn', 'assistant-mcp', 'session-message', 'daemon-auto'] as const;
/** The wrapper's own tag: it persists BOTH its agent output and relay-delivered client messages through `POST /v3/…/messages`, so it only counts as the owner when it says so. */
export const WRAPPER_CLIENT_TAG = 'cli-coding-session';
/** `X-Happy-Message-Origin` value a wrapper (CLI ≥ 0.2.158) stamps on messages a client delivered through the relay. */
export const RELAY_CLIENT_ORIGIN = 'relay-client';
const LINKED_SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_LINKED_SESSIONS = 64;

export interface MessageOrigin {
    localId: string | null | undefined;
    /** `X-Happy-Client` header (HTTP) or handshake tag; `null` when unknown. */
    client?: string | null;
    /** socket ingress only: `session-scoped` is the wrapper itself. */
    connectionType?: string | null;
    /** `X-Happy-Message-Origin` header (HTTP): `relay-client` marks a client message the wrapper persisted on the relay path. */
    origin?: string | null;
}

export function clientTag(client: string | null | undefined): string | null {
    if (typeof client !== 'string' || client.length === 0) return null;
    const slash = client.indexOf('/');
    return (slash < 0 ? client : client.slice(0, slash)).trim().toLowerCase() || null;
}

/** True when a stored user message counts as the owner (a person) speaking in the session. */
export function isOwnerAuthoredMessage(origin: MessageOrigin): boolean {
    if (origin.connectionType === 'session-scoped') return false;
    const localId = typeof origin.localId === 'string' ? origin.localId : '';
    if (AUTOMATED_LOCAL_ID_PREFIXES.some((prefix) => localId.startsWith(prefix))) return false;
    const tag = clientTag(origin.client);
    if (tag !== null && (AUTOMATED_CLIENT_TAGS as readonly string[]).includes(tag)) return false;
    // The wrapper persists its own agent output with the same tag as the messages the web sent it via the relay;
    // only the latter carry the origin header (older wrappers: neither — the web acks from its side, B-508 banner).
    if (tag === WRAPPER_CLIENT_TAG) return origin.origin === RELAY_CLIENT_ORIGIN;
    return true;
}

function collectIds(value: unknown, out: Set<string>): void {
    if (out.size >= MAX_LINKED_SESSIONS) return;
    if (typeof value === 'string') {
        if (LINKED_SESSION_ID.test(value)) out.add(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            if (out.size >= MAX_LINKED_SESSIONS) return;
            if (typeof item === 'string') collectIds(item, out);
            else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') collectIds((item as { id: string }).id, out);
        }
    }
}

/** Sessions a run is about: its own session plus `sessions[]` / `sessionId` / `sessionIds[]` from a JSON payload. Pure; malformed payloads yield only the run's session. */
export function linkedSessionIds(run: { sessionId: string | null; payload: string | null }): string[] {
    const out = new Set<string>();
    if (run.sessionId) out.add(run.sessionId);
    if (run.payload && run.payload.length <= 65_536 && run.payload.trimStart().startsWith('{')) {
        try {
            const parsed = JSON.parse(run.payload) as Record<string, unknown>;
            if (parsed && typeof parsed === 'object') {
                collectIds(parsed.sessions, out);
                collectIds(parsed.sessionId, out);
                collectIds(parsed.sessionIds, out);
            }
        } catch { /* not JSON: nothing to link */ }
    }
    return [...out];
}

export function automationsEnabled(): boolean {
    return process.env.VH_AUTOMATIONS_ENABLED === 'true';
}

/** Clears every flagged run of the account that is about `sessionId`. Returns the run ids cleared. */
export async function resolveAttentionForSession(accountId: string, sessionId: string, by: string, now = new Date()): Promise<string[]> {
    const flagged = await db.automationRun.findMany({ where: { accountId, needsAttention: true }, select: { id: true, sessionId: true, payload: true } });
    const hits = flagged.filter((run) => linkedSessionIds(run).includes(sessionId)).map((run) => run.id);
    if (hits.length === 0) return [];
    await db.automationRun.updateMany({ where: { id: { in: hits }, needsAttention: true }, data: { needsAttention: false, ackedAt: now, ackedBy: by, updatedAt: now } });
    return hits;
}

/** Message ingress hook (socket `message` and `POST /v3/sessions/:id/messages`): never throws, never awaited by the caller's response. */
export async function noteSessionMessage(input: { accountId: string; sessionId: string } & MessageOrigin): Promise<string[]> {
    if (!automationsEnabled() || !isOwnerAuthoredMessage(input)) return [];
    try {
        const cleared = await resolveAttentionForSession(input.accountId, input.sessionId, 'owner-replied');
        if (cleared.length > 0) log({ module: 'automations', sessionId: input.sessionId, runs: cleared.length }, 'Attention cleared: owner replied');
        return cleared;
    } catch (error) {
        log({ module: 'automations', level: 'warn', error }, 'Attention owner-replied hook failed');
        return [];
    }
}

/** Archive hook (`POST /v1/sessions/:id/archive` — user intent, B-505): never throws. */
export async function noteSessionArchived(accountId: string, sessionId: string): Promise<string[]> {
    if (!automationsEnabled()) return [];
    try {
        const cleared = await resolveAttentionForSession(accountId, sessionId, 'session-archived');
        if (cleared.length > 0) log({ module: 'automations', sessionId, runs: cleared.length }, 'Attention cleared: session archived');
        return cleared;
    } catch (error) {
        log({ module: 'automations', level: 'warn', error }, 'Attention session-archived hook failed');
        return [];
    }
}
