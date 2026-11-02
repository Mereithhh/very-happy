/**
 * B-873 (spec §7): 汇报板 items the issue bridge writes (`source: 'issue'`,
 * `links[{ type: 'issue', ref: issueId, label: 'VH-12' }]`). Every such item
 * gets 「打开 VH-12」; the in-review item (`key: issue-review:<issueId>`) also
 * gets 「完成」 / 「退回」, which act on the issue itself (PATCH status; the
 * server resolves the item when the issue leaves in_review), so they work
 * whatever the server does with the generic option buttons — those are hidden
 * for this item to avoid two pairs of the same choice.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check, CornerUpLeft } from 'lucide-react';
import type { AttentionItem } from '@slopus/happy-wire';
import { Modal } from '@/modal';
import { toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { acceptIssue, returnIssue } from '@/sync/issuesStore';
import { issuesCopyFor } from '@/screens/issues/issuesCopy';
import { issueErrorText } from '@/screens/issues/issueErrors';

type ItemFields = Pick<AttentionItem, 'key' | 'links' | 'state'>;

export function issueLinkOf(item: Pick<AttentionItem, 'links'>): { issueId: string; label: string } | null {
    const link = item.links?.find((l) => l.type === 'issue');
    return link ? { issueId: link.ref, label: link.label ?? link.ref } : null;
}

/** The in-review decision item: its done / return options are rendered by IssueItemActions instead. */
export function isIssueReviewItem(item: Pick<AttentionItem, 'key' | 'links'>): boolean {
    return !!item.key?.startsWith('issue-review:') && issueLinkOf(item) !== null;
}

export function IssueItemActions({ item }: { item: ItemFields }) {
    const { lang } = useTranslation();
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const link = issueLinkOf(item);
    if (!link) return null;
    const copy = issuesCopyFor(lang);
    const live = item.state === 'open' || item.state === 'in_progress';
    const run = async (work: () => Promise<boolean | void>, done: string) => {
        if (busy) return;
        setBusy(true);
        try { if ((await work()) !== false) toast.success(done); } catch (e) { toast.error(issueErrorText(e, copy)); } finally { setBusy(false); }
    };
    return <>
        <button type="button" onClick={() => navigate(`/issues/${encodeURIComponent(link.label)}`)}><ArrowUpRight size={13} aria-hidden />{copy.openIssue(link.label)}</button>
        {live && isIssueReviewItem(item) && <>
            <button type="button" disabled={busy} data-testid="board-issue-accept" onClick={() => void run(() => acceptIssue(link.issueId), copy.accepted)}><Check size={13} aria-hidden />{copy.accept}</button>
            <button type="button" disabled={busy} data-testid="board-issue-return" onClick={() => void run(async () => {
                const note = await Modal.prompt(copy.rejectTitle, copy.rejectBody, { placeholder: copy.rejectPh, multiline: true, confirmText: copy.reject, cancelText: copy.cancel });
                if (note === null) return false;
                await returnIssue(link.issueId, note);
            }, copy.rejected)}><CornerUpLeft size={13} aria-hidden />{copy.reject}</button>
        </>}
    </>;
}
