/**
 * B-616 — how much of a session's history the web loads, and when.
 *
 * Opening a session fetches the newest page only. Older history is fetched
 * one page at a time when the reader parks the top of the loaded history in
 * view (ChatList) or presses 「加载更早」 — never by a background loop.
 *
 * Why: the previous background prefetch inserted a page above the reader
 * every ~0.5s until the whole history was in (Xu CHEN's Toolathon session:
 * ~13k messages ≈ 134 pages ≈ a minute of top inserts after every open), each
 * compensated by a scrollTop write. iOS WebKit drops those writes while a
 * momentum scroll is running, and the un-virtualised list re-derives every
 * row per page, so on an iPhone the view kept jumping to much earlier content
 * (B-603's "hold while moving" narrowed it; the 2026-10-16 recording still
 * jumped). The only insert that is always safe is one the reader asked for
 * while standing still.
 */
import type { NormalizedMessage } from './typesRaw';

/** Page size for every history request (server default and max are 100 / 500). */
export const HISTORY_PAGE_SIZE = 100;

/**
 * Extra pages the initial load may fetch, before first paint, so the loaded
 * window starts at a turn opener instead of in the middle of a run of tool
 * calls. Bounded: a turn with hundreds of tool calls still paints after
 * 1 + INITIAL_TURN_START_PAGES requests; the rest loads on demand.
 */
export const INITIAL_TURN_START_PAGES = 2;

/**
 * A raw user prompt (not a sub-agent sidechain) opens a turn. Hidden inputs
 * (slash-command echoes, duplicate attachment echoes) also count here — the
 * transcript filters those later; over-counting only costs one fewer extra
 * page, never a wrong window.
 */
export function windowHasTurnStart(messages: readonly NormalizedMessage[]): boolean {
    return messages.some((message) => message.role === 'user' && !message.isSidechain);
}

/** Fetch one more page before the first paint? */
export function shouldExtendInitialWindow(input: {
    hasMore: boolean;
    hasTurnStart: boolean;
    extraPagesFetched: number;
}): boolean {
    if (!input.hasMore || input.hasTurnStart) return false;
    return input.extraPagesFetched < INITIAL_TURN_START_PAGES;
}
