import type { NoticeView } from '@slopus/happy-wire';
import type { NoticeConfig } from '@/app/instance/instanceConfig';

/** Who is asking: the account id, plus the username when the caller looked it up. */
export interface NoticeViewer {
    accountId: string;
    username?: string | null;
}

/** True when any notice names accounts, i.e. the username is worth a lookup. */
export function noticesNeedUsername(notices: readonly NoticeConfig[]): boolean {
    return notices.some(n => n.audience !== 'all');
}

export function noticeAddressedTo(notice: NoticeConfig, viewer: NoticeViewer): boolean {
    if (notice.audience === 'all') return true;
    return notice.audience.accounts.some(a => a === viewer.accountId || (!!viewer.username && a === viewer.username));
}

/** From `startsAt` (inclusive) until `endsAt` (exclusive); either bound may be absent. */
export function noticeActiveAt(notice: Pick<NoticeConfig, 'startsAt' | 'endsAt'>, now: number): boolean {
    if (notice.startsAt && now < Date.parse(notice.startsAt)) return false;
    if (notice.endsAt && now >= Date.parse(notice.endsAt)) return false;
    return true;
}

/**
 * Pure: the notices `viewer` should see at `now`, newest first. Newest = the
 * later `startsAt`; notices without one come after those that have one, and
 * among equals the one listed later in the file comes first. Audience is never
 * echoed back.
 */
export function visibleNotices(notices: readonly NoticeConfig[], viewer: NoticeViewer, now: number): NoticeView[] {
    return notices
        .map((notice, index) => ({ notice, index }))
        .filter(({ notice }) => noticeAddressedTo(notice, viewer) && noticeActiveAt(notice, now))
        .sort((a, b) => {
            const sa = a.notice.startsAt ? Date.parse(a.notice.startsAt) : -Infinity;
            const sb = b.notice.startsAt ? Date.parse(b.notice.startsAt) : -Infinity;
            if (sa !== sb) return sb - sa;
            return b.index - a.index;
        })
        .map(({ notice: n }) => ({
            id: n.id,
            title: n.title,
            body: n.body,
            level: n.level,
            dismissible: n.dismissible,
            ...(n.startsAt ? { startsAt: n.startsAt } : {}),
            ...(n.endsAt ? { endsAt: n.endsAt } : {}),
        }));
}
