/**
 * B-915 — the body of a 收尾 / 交接 card on the 汇报板 (BoardCard renders it
 * for `kind: 'wrapup'`). Summary (3 lines, expandable), files / artifacts
 * (folded, copyable), commits (GitHub links when the repo is known), the
 * 待确认 checkboxes (owner-respond `check`) and 归档会话. A handoff card also
 * names the target session and its delivery; a failed delivery is red and
 * never offers to archive by itself.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArrowUpRight, RotateCcw } from 'lucide-react';
import type { AttentionItem } from '@slopus/happy-wire';
import { Modal } from '@/modal';
import { storage, useSession } from '@/sync/storage';
import { Checkbox, CopyButton } from '@/ui';
import { toast } from '@/ui/Toast';
import { Markdown } from '../Markdown';
import type { BoardCopy, WrapupCopy } from './boardCopy';
import { checkWrapupItem } from './boardActions';
import { commitUrl, shortSha, type WrapupView } from './wrapupModel';

export function wrapupHeadlineText(view: WrapupView, copy: WrapupCopy): string {
    const h = view.headline;
    switch (h.key) {
        case 'running': return h.mode === 'handoff' ? copy.handoffRunning(h.target) : copy.running;
        case 'incomplete': return h.mode === 'handoff' ? copy.handoffIncomplete : copy.incomplete;
        case 'canClose': return copy.canClose;
        case 'pending': return copy.pending(h.count);
        case 'notYet': return copy.notYet;
        case 'delivered': return copy.delivered(h.target);
        case 'stored': return copy.stored(h.target);
        case 'handoffFailed': return copy.handoffFailed(h.target);
    }
}

/**
 * B-915b 重试 on an 未完成 card: a wrap-up sends the request again (the account
 * template, same gate as the menu); a handoff reopens 交接给… for this session
 * (the target is chosen again — the card never knew it).
 */
export async function retryFromWrapupCard(sessionId: string, mode: 'wrapup' | 'handoff'): Promise<void> {
    const { openHandoffDialog, startWrapup } = await import('@/app/sessionWrapup');
    if (mode === 'handoff') openHandoffDialog(sessionId);
    else await startWrapup(sessionId);
}

/** 归档会话 from the card: one confirm (it names the unconfirmed items when there are any). */
export async function archiveFromWrapupCard(sessionId: string, uncheckedCount: number, copy: WrapupCopy): Promise<boolean> {
    const session = storage.getState().sessions[sessionId];
    if (!session || session.archivedAt != null) return false;
    const ok = await Modal.confirm(uncheckedCount > 0 ? copy.archivePendingConfirm(uncheckedCount) : copy.archiveConfirm, undefined, {
        confirmText: copy.archive,
        destructive: true,
    });
    if (!ok) return false;
    try {
        // Loaded on use: rowActions pulls the sidebar / team navigation graph the board itself never needs.
        const { archiveSessionNow } = await import('@/app/rowActions');
        await archiveSessionNow(session);
        return true;
    } catch {
        toast.error(copy.archiveFailed);
        return false;
    }
}

function PathList({ title, paths, copy }: { title: string; paths: readonly string[]; copy: WrapupCopy }) {
    const [open, setOpen] = useState(false);
    if (paths.length === 0) return null;
    return (
        <div className="wrp-sec">
            <div className="wrp-sec-head">
                <button type="button" className="wrp-fold" aria-expanded={open} onClick={() => setOpen(!open)}>{title}</button>
                <CopyButton text={paths.join('\n')} label={copy.copyPaths} className="wrp-copy" />
            </div>
            {open && <ul className="wrp-paths">{paths.map((p) => <li key={p}><code>{p}</code></li>)}</ul>}
        </div>
    );
}

export function WrapupDetails({ item, view, copy }: { item: AttentionItem; view: WrapupView; copy: BoardCopy }) {
    const w = copy.wrapup;
    const { payload } = view;
    const session = useSession(item.sessionId);
    const [full, setFull] = useState(false);
    const summary = payload.summary?.trim() ?? '';
    const long = summary.split('\n').length > 3 || summary.length > 280;
    const handoff = payload.handoff;
    const delivery = handoff?.delivery === 'delivered' || handoff?.delivery === 'offline-stored' || handoff?.delivery === 'failed' ? handoff.delivery : null;
    const live = item.state === 'open' || item.state === 'in_progress';
    const archived = session?.archivedAt != null;
    const canArchive = !view.running && live && !!session && !archived && !session.share;
    return (
        <div className={`wrp${view.failed ? ' is-failed' : ''}`}>
            {handoff && (
                <div className="wrp-target">
                    <span className="wrp-label">{w.target}</span>
                    <Link to={`/session/${encodeURIComponent(handoff.to)}`} className="wrp-target-link" title={handoff.to}>
                        {handoff.toTitle?.trim() || handoff.to}<ArrowUpRight size={13} aria-hidden />
                    </Link>
                    {delivery && <span className={`wrp-delivery wrp-delivery--${delivery}`}>{w.deliveryLabel[delivery]}</span>}
                </div>
            )}
            {view.failed && handoff?.error && <div className="wrp-error" role="alert">{handoff.error}</div>}
            {handoff?.archived && <div className="wrp-note">{w.autoArchived}</div>}
            {view.incomplete && (
                <div className="wrp-incomplete">
                    <div className="wrp-note">{view.mode === 'handoff' ? w.handoffIncompleteHint : w.incompleteHint}</div>
                    {live && !archived && (
                        <button type="button" className="wrp-retry-btn" onClick={() => void retryFromWrapupCard(item.sessionId, view.mode)}>
                            <RotateCcw size={13} aria-hidden />{w.retry}
                        </button>
                    )}
                </div>
            )}
            {summary && (
                <div className="wrp-sec">
                    <div className={`brf-body wrp-summary${long && !full ? ' is-clamped' : ''}`}><Markdown text={summary} /></div>
                    {long && <button type="button" className="wrp-fold wrp-more" aria-expanded={full} onClick={() => setFull(!full)}>{full ? w.less : w.more}</button>}
                </div>
            )}
            <PathList title={w.files(payload.files?.length ?? 0)} paths={payload.files ?? []} copy={w} />
            <PathList title={w.artifacts(payload.artifacts?.length ?? 0)} paths={payload.artifacts ?? []} copy={w} />
            {payload.commits && payload.commits.length > 0 && (
                <div className="wrp-sec">
                    <div className="wrp-label">{w.commits(payload.commits.length)}</div>
                    <ul className="wrp-commits">
                        {payload.commits.map((c) => {
                            const url = commitUrl(c.repo, c.sha);
                            return (
                                <li key={c.sha}>
                                    {url ? <a href={url} target="_blank" rel="noreferrer" className="wrp-sha">{shortSha(c.sha)}</a> : <code className="wrp-sha">{shortSha(c.sha)}</code>}
                                    {c.subject && <span className="wrp-subject">{c.subject}</span>}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
            {payload.pending && payload.pending.length > 0 && (
                <div className="wrp-sec">
                    <div className="wrp-label">{w.pendingTitle}</div>
                    <div className="wrp-checks">
                        {payload.pending.map((p) => (
                            <Checkbox key={p.id} className="wrp-check" checked={p.checked} disabled={!live}
                                onCheckedChange={(checked) => void checkWrapupItem(item, p.id, checked, copy)}>
                                {p.label}
                            </Checkbox>
                        ))}
                    </div>
                </div>
            )}
            {archived && !handoff?.archived && <div className="wrp-note">{w.archived}</div>}
            {canArchive && (
                <div className="wrp-archive">
                    <button type="button" className="wrp-archive-btn" onClick={() => void archiveFromWrapupCard(item.sessionId, view.uncheckedCount, w)}>
                        <Archive size={13} aria-hidden />{w.archive}
                    </button>
                </div>
            )}
        </div>
    );
}
