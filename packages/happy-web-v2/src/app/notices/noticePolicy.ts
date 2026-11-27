import type { NoticeView } from '@slopus/happy-wire';

/** Dismissed ids kept in synced settings; the oldest fall off first. */
export const DISMISSED_NOTICES_MAX = 100;
/** How often the notices are asked for again while the app is open. */
export const NOTICES_POLL_MS = 10 * 60_000;

/** Still inside its window at `now`? The server filtered at fetch time; this catches an `endsAt` passing between polls. */
export function noticeOpenAt(notice: Pick<NoticeView, 'startsAt' | 'endsAt'>, now: number): boolean {
    const starts = notice.startsAt ? Date.parse(notice.startsAt) : NaN;
    const ends = notice.endsAt ? Date.parse(notice.endsAt) : NaN;
    if (!Number.isNaN(starts) && now < starts) return false;
    if (!Number.isNaN(ends) && now >= ends) return false;
    return true;
}

/**
 * Pure: the notice to show — the first (the server sends newest first) that
 * is open now, not dismissed on any device, and not closed for this page
 * load. A notice that cannot be dismissed ignores the dismissed list.
 */
export function pickNotice(
    notices: readonly NoticeView[],
    dismissed: readonly string[] | null | undefined,
    closedThisLoad: ReadonlySet<string>,
    now: number,
): NoticeView | null {
    const gone = new Set(dismissed ?? []);
    for (const n of notices) {
        if (closedThisLoad.has(n.id) || !noticeOpenAt(n, now)) continue;
        if (n.dismissible && gone.has(n.id)) continue;
        return n;
    }
    return null;
}

/** Pure: the dismissed list with `id` added last (moved there if present), capped at the newest `max`. */
export function withDismissed(dismissed: readonly string[] | null | undefined, id: string, max = DISMISSED_NOTICES_MAX): string[] {
    const next = (Array.isArray(dismissed) ? dismissed : []).filter((d) => typeof d === 'string' && d !== id);
    next.push(id);
    return next.slice(-max);
}

export type NoticeBodyPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"。，；：！？）」』]+$/;

/** Pure: splits plain text into text and http(s) links (trailing punctuation stays text). */
export function splitNoticeBody(body: string): NoticeBodyPart[] {
    const parts: NoticeBodyPart[] = [];
    let last = 0;
    for (const match of body.matchAll(URL_RE)) {
        const start = match.index ?? 0;
        const trail = match[0].match(TRAILING_PUNCT)?.[0] ?? '';
        const href = match[0].slice(0, match[0].length - trail.length);
        if (start > last) parts.push({ kind: 'text', text: body.slice(last, start) });
        parts.push({ kind: 'link', href });
        last = start + href.length;
    }
    if (last < body.length) parts.push({ kind: 'text', text: body.slice(last) });
    return parts;
}
