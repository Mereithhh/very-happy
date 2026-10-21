/**
 * B-701 share-link viewer — pure pieces of the anonymous `/s/:linkId#secret`
 * page (spec specs/2026-10-session-sharing-tiers.md §2.2, §4.3). The page
 * never holds a key: the server returns projected, masked plaintext records
 * that go through the normal normalize → reducer pipeline.
 */
import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import type { Message } from '@/sync/typesMessage';
import type { PublicLinkMessages, ShareLinkScope } from '@/sync/sessionShareTypes';

/** What the page shows. `gone` covers revoked AND expired: one sentence for both (Lead review). */
export type SharedLinkPhase = 'loading' | 'ready' | 'invalid' | 'gone' | 'rateLimited' | 'error';

/** Secret from the URL fragment (`#<secret>`); tolerates a `#s=` / `#t=` prefix. */
export function secretFromHash(hash: string): string | null {
    const raw = hash.replace(/^#/, '').replace(/^[st]=/, '').trim();
    return /^[A-Za-z0-9_-]{20,128}$/.test(raw) ? raw : null;
}

/** Map an HTTP status to the page phase. Any 410 (revoked or expired) clears the transcript. */
export function phaseForStatus(status: number): SharedLinkPhase {
    if (status === 404) return 'invalid';
    if (status === 410) return 'gone';
    if (status === 429) return 'rateLimited';
    return 'error';
}

/**
 * A failed poll only clears an open transcript when the server said the link
 * is gone or invalid. A network blip, throttling (429) or 5xx keeps what is shown and
 * the next poll retries — the revoke bound still holds because revoke answers 410.
 */
export function pollFailureClears(status: number | null): boolean {
    return status === 404 || status === 410;
}

/** Live pages poll for new messages every 3 s; snapshots re-check validity every 5 s (spec §2.2). */
export function pollIntervalMs(scope: ShareLinkScope): number {
    return scope === 'live' ? 3_000 : 5_000;
}

export type SharedLinkRecord = PublicLinkMessages['messages'][number];

/** Merge a new page into what we have (dedupe by seq, keep order). */
export function mergeRecords(current: SharedLinkRecord[], incoming: SharedLinkRecord[]): SharedLinkRecord[] {
    if (incoming.length === 0) return current;
    const bySeq = new Map(current.map((r) => [r.seq, r]));
    for (const record of incoming) bySeq.set(record.seq, record);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Records → render-ready messages, exactly like the logged-in transcript. */
export function messagesFromRecords(records: SharedLinkRecord[]): Message[] {
    const normalized: NormalizedMessage[] = [];
    for (const record of records) {
        const message = normalizeRawMessage(record.id, null, record.createdAt, record.content as any);
        if (message) normalized.push({ ...message, seq: record.seq });
    }
    return reducer(createReducer(), normalized).messages;
}
