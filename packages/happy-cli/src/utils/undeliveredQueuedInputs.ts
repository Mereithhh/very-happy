/**
 * B-332 site ③ — which of the session's stored messages is user input that no
 * wrapper ever consumed.
 *
 * A restarted / taken-over wrapper starts its cursor at the server's latest seq
 * (or skips the history wholesale), so anything the previous wrapper still held
 * in its in-memory MessageQueue2 is destroyed without a trace. The web paints
 * such a message as「排队中」until the next turn-end with a higher seq arrives —
 * and then as delivered, which it never was.
 *
 * This mirrors the web's own judgement (`sync/queuedInput.ts`
 * `firstTurnEndForQueuedInput`): an input carrying `meta.queuedAt` is queued
 * iff no `turn-end` exists at or after its seq. So we scan NEWEST → OLDEST and
 * stop at the first turn-end: every queued input above it is undelivered.
 * Anything below the boundary the web already shows as delivered, so it is
 * not ours to touch here — replaying it is a separate decision (see spec).
 *
 * Pure so it can be tested without a server; the fetch + decrypt loop lives in
 * `ApiSessionClient.cancelUndeliveredQueuedInputs`.
 */

export type StoredRecord = {
    seq: number;
    localId: string | null;
    /** Decrypted message body (RawRecord shape as stored by the web / CLI). */
    body: unknown;
};

export type UndeliveredScan = {
    /** localIds of queued inputs with no turn-end at/after them, newest first. */
    undeliveredLocalKeys: string[];
    /** true once a turn-end was seen — the caller can stop paging. */
    reachedBoundary: boolean;
};

type Envelope = { ev?: { t?: unknown; targetLocalKeys?: unknown } };

/** Both envelope shapes the CLI ever wrote: bare and `{type:'session', data}`. */
function sessionEnvelopeOf(body: unknown): Envelope | null {
    if (!body || typeof body !== 'object') return null;
    const record = body as { role?: unknown; content?: unknown };
    if (record.role !== 'session' || !record.content || typeof record.content !== 'object') return null;
    const content = record.content as { type?: unknown; data?: unknown; ev?: unknown };
    if (content.type === 'session' && content.data && typeof content.data === 'object') {
        return content.data as Envelope;
    }
    if (content.ev !== undefined) return content as Envelope;
    return null;
}

function isQueuedUserText(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    const record = body as { role?: unknown; content?: { type?: unknown }; meta?: { queuedAt?: unknown } };
    return record.role === 'user'
        && record.content?.type === 'text'
        && typeof record.meta?.queuedAt === 'number';
}

/**
 * @param records newest first (the order `before_seq` paging returns). May be
 *   fed incrementally: pass `prior` to continue a scan across pages.
 */
export function scanUndeliveredQueuedInputs(
    records: readonly StoredRecord[],
    prior?: { canceled?: Set<string> },
): UndeliveredScan & { canceled: Set<string> } {
    const canceled = prior?.canceled ?? new Set<string>();
    const undelivered: string[] = [];
    let reachedBoundary = false;

    for (const record of records) {
        const envelope = sessionEnvelopeOf(record.body);
        if (envelope) {
            const t = envelope.ev?.t;
            if (t === 'turn-end') {
                reachedBoundary = true;
                break;
            }
            // A tombstone (web cancel button, or an earlier run of this scan)
            // sits ABOVE its target in seq order, so we always see it first.
            if (t === 'queue-cancel' && Array.isArray(envelope.ev?.targetLocalKeys)) {
                for (const key of envelope.ev.targetLocalKeys) {
                    if (typeof key === 'string') canceled.add(key);
                }
            }
            continue;
        }
        if (isQueuedUserText(record.body) && record.localId && !canceled.has(record.localId)) {
            undelivered.push(record.localId);
        }
    }

    // Newest first, same as the input; the caller reverses once after paging.
    return { undeliveredLocalKeys: undelivered, reachedBoundary, canceled };
}
