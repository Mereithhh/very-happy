/**
 * B-819: the anchor probe of a cached run (B-813, spec B-807 §5.4.2) as its
 * own request, so it can go out the moment the run is read.
 *
 * Before: a cache hit first decrypted and rendered the run, and only then
 * asked `after_seq = lastRowSeq - 1` — the newest message came one round
 * trip later than without the cache (QA8 F2: 3051 vs 2788ms desktop, 2850 vs
 * 2450ms phone). The probe needs nothing but the run's newest row, so it now
 * overlaps the session list (the key wait) and the render; its page is still
 * merged only after the run rendered, under the session lock, so the
 * transcript stays a server prefix and applied seqs only go up (B1).
 */
import type { ApiMessage } from './apiTypes';
import type { CacheHit } from './cache/syncCache';

/** An early probe older than this is asked again: the live updates buffered since then are bounded (ANCHOR_BUFFER_LIMIT). */
export const CACHE_PROBE_FRESH_MS = 10_000;

export type CacheProbe = {
    hit: CacheHit;
    page: Promise<{ messages: ApiMessage[]; hasMore: boolean }>;
    controller: AbortController;
    startedAt: number;
    /** The page once it answered (set from `page`); a render that finds it here merges it in the same commit. */
    answer?: { messages: ApiMessage[]; hasMore: boolean } | null;
};

/** The probe asks from the row before the cached newest one, so the server's first row must be that row. */
export function cacheProbeAfterSeq(hit: Pick<CacheHit, 'lastRowSeq'>): number {
    return Math.max(0, hit.lastRowSeq - 1);
}

/** An early probe serves the catch-up only for the very run it was asked for, while fresh and not aborted. */
export function isUsableCacheProbe(probe: Pick<CacheProbe, 'hit' | 'controller' | 'startedAt'>, hit: CacheHit, now: number): boolean {
    return probe.hit === hit && !probe.controller.signal.aborted && now - probe.startedAt <= CACHE_PROBE_FRESH_MS;
}
