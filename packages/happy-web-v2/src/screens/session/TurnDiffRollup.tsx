/**
 * B-571: one neutral line at the end of a finished turn — 「改了 3 个文件 · +40 −12」.
 * Expands to the files; a file expands in place to THIS turn's edits of it
 * (the same DiffView the tool cards use). 「审阅全部」 opens the workspace
 * review tab (B-572). Spec: specs/2026-10-change-review-surfaces.md
 */
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { DiffView } from './DiffView';
import { langForPath } from './langForPath';
import { displayPath, type TurnDiff, type TurnDiffFile } from './turnDiffs';
import { withSessionPanel } from './sessionPanelState';
import { REVIEW_ALL_PARAM } from './reviewAll/reviewAllModel';
import { useFeatureTipAnchor } from '@/components/featureTips/FeatureTips';
import './diff.css';
import './turnDiff.css';

function copyFor(zh: boolean) {
    return zh ? {
        files: (n: number) => `改了 ${n} 个文件`,
        changed: '已改',
        partial: '部分未计',
        reviewAll: '审阅全部',
        basis: '按本轮记录的编辑统计（不含终端命令写入）',
        noDiff: '这次改动没有可显示的 diff',
        edits: (n: number) => `${n} 次编辑`,
    } : {
        files: (n: number) => `Changed ${n} file${n === 1 ? '' : 's'}`,
        changed: 'changed',
        partial: 'partly uncounted',
        reviewAll: 'Review all',
        basis: 'From the edits recorded in this turn (shell writes not included)',
        noDiff: 'No diff to show for this change',
        edits: (n: number) => `${n} edits`,
    };
}

function Counts({ added, removed, fallback }: { added: number | null; removed: number | null; fallback: string }) {
    if (added === null || removed === null) return <span className="tdr-unknown">{fallback}</span>;
    return <span className="tdr-counts"><span className="dv-add">+{added}</span><span className="dv-del">−{removed}</span></span>;
}

function FileRow({ file, cwd, copy }: { file: TurnDiffFile; cwd: string | null | undefined; copy: ReturnType<typeof copyFor> }) {
    const [open, setOpen] = useState(false);
    const shown = displayPath(file.path, cwd);
    const lang = langForPath(file.path);
    return (
        <li className="tdr-file">
            <button type="button" className="tdr-file-row" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={file.path}>
                <ChevronRight size={12} className={`tg-chevron${open ? ' is-open' : ''}`} aria-hidden/>
                <span className="tdr-path mono">{shown}</span>
                {file.edits > 1 && <span className="tdr-edits">{copy.edits(file.edits)}</span>}
                <Counts added={file.added} removed={file.removed} fallback={copy.changed}/>
            </button>
            {open && (
                <div className="tdr-diffs">
                    {file.renders.length === 0
                        ? <div className="tdr-note">{copy.noDiff}</div>
                        : file.renders.map((r, i) => <DiffView key={i} oldText={r.oldText} newText={r.newText} lang={lang}/>)}
                </div>
            )}
        </li>
    );
}

export function TurnDiffRollup({ sessionId, diff }: { sessionId: string; diff: TurnDiff }) {
    const { lang } = useTranslation();
    const copy = copyFor(lang.startsWith('zh'));
    const session = useSession(sessionId);
    const [, setParams] = useSearchParams();
    const [open, setOpen] = useState(false);
    const cwd = session?.metadata?.path;
    const canReview = Boolean(session?.metadata?.machineId && cwd);
    // B-588: one-time tip next to 「审阅全部」 (the host picks the lowest = newest turn's button)
    const reviewRef = useRef<HTMLButtonElement | null>(null);
    useFeatureTipAnchor('review-all', reviewRef, canReview);
    const reviewAll = () => setParams((prev) => {
        const next = withSessionPanel(prev, 'changed');
        next.set(REVIEW_ALL_PARAM, '1');
        return next;
    });
    return (
        <div className="tdr" data-testid="turn-diff">
            <div className="tdr-head">
                <button type="button" className="tdr-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                    <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} aria-hidden/>
                    <span className="tdr-summary">{copy.files(diff.files.length)}</span>
                    {(diff.added > 0 || diff.removed > 0 || !diff.partial) && (
                        <span className="tdr-counts"><span className="dv-add">+{diff.added}</span><span className="dv-del">−{diff.removed}</span></span>
                    )}
                    {diff.partial && <span className="tdr-unknown">{diff.added > 0 || diff.removed > 0 ? copy.partial : copy.changed}</span>}
                </button>
                {canReview && <button ref={reviewRef} type="button" className="tdr-review" onClick={reviewAll}>{copy.reviewAll}</button>}
            </div>
            {open && (
                <div className="tdr-body">
                    <ul className="tdr-files">
                        {diff.files.map((file) => <FileRow key={file.path} file={file} cwd={cwd} copy={copy}/>)}
                    </ul>
                    <div className="tdr-note">{copy.basis}</div>
                </div>
            )}
        </div>
    );
}
