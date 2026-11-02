/**
 * B-873 (spec §7): 汇报板 items the issue bridge writes (`source: 'issue'`,
 * `links[{ type: 'issue', ref: issueId, label: 'VH-12' }]`). Every such item
 * gets 「打开 VH-12」; the in-review item (`key: issue-review:<issueId>`) also
 * gets 「完成」 / 「退回」: owner-respond `choose done|return` (退回 asks for
 * a note first — the server writes it as my comment and routes it back to the
 * agent). They replace the generic option buttons for this item, which would
 * send the choice without a note.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check, CornerUpLeft } from 'lucide-react';
import type { AttentionItem } from '@slopus/happy-wire';
import { Modal } from '@/modal';
import { toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { respondToAttentionItem } from '@/sync/apiAttention';
import { applyAttentionItem } from '@/sync/attentionStore';
import { loadIssueDetail } from '@/sync/issuesStore';
import { issuesCopyFor } from '@/screens/issues/issuesCopy';
import { issueErrorText } from '@/screens/issues/issueErrors';

type ItemFields = Pick<AttentionItem, 'id' | 'key' | 'links' | 'state'>;

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
    const choose = async (choice: 'done' | 'return', note?: string) => {
        const { item: next } = await respondToAttentionItem(item.id, { action: 'choose', choice, ...(note?.trim() ? { note: note.trim() } : {}) });
        applyAttentionItem(next);
        void loadIssueDetail(link.issueId);
    };
    const run = async (work: () => Promise<boolean | void>, done: string) => {
        if (busy) return;
        setBusy(true);
        try { if ((await work()) !== false) toast.success(done); } catch (e) { toast.error(issueErrorText(e, copy)); } finally { setBusy(false); }
    };
    return <>
        <button type="button" onClick={() => navigate(`/issues/${encodeURIComponent(link.label)}`)}><ArrowUpRight size={13} aria-hidden />{copy.openIssue(link.label)}</button>
        {live && isIssueReviewItem(item) && <>
            <button type="button" disabled={busy} data-testid="board-issue-accept" onClick={() => void run(() => choose('done'), copy.accepted)}><Check size={13} aria-hidden />{copy.accept}</button>
            <button type="button" disabled={busy} data-testid="board-issue-return" onClick={() => void run(async () => {
                const note = await Modal.prompt(copy.rejectTitle, copy.rejectBody, { placeholder: copy.rejectPh, multiline: true, confirmText: copy.reject, cancelText: copy.cancel });
                if (note === null) return false;
                await choose('return', note);
            }, copy.rejected)}><CornerUpLeft size={13} aria-hidden />{copy.reject}</button>
        </>}
    </>;
}
