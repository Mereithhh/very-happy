/**
 * DiffView — unified +/- line diff for Edit/MultiEdit/Write tool views.
 * Lines are syntax-highlighted (lazy shiki tokens) so the diff isn't a flat
 * wall of one color; +/- backgrounds are kept subtle so token colors show.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSetting } from '@/sync/storage';
import { useMediaQuery } from '@/app/useMediaQuery';
import { CopyButton } from '@/ui/CopyButton';
import { lineDiff, diffStats, unifiedPatchText, type DiffRow } from './diff';
import { highlightToLines, type HiLines } from './highlighter';
import './diff.css';

function renderLine(text: string, hi: HiLines, lineIndex: number) {
    const tokens = hi?.[lineIndex];
    if (!tokens || tokens.length === 0) {
        return text === '' ? ' ' : text;
    }
    return tokens.map((tok, i) => (
        <span key={i} style={tok.style as React.CSSProperties}>
            {tok.content}
        </span>
    ));
}

export function DiffView({
    oldText,
    newText,
    lang,
    showLineNumbers = false,
}: {
    oldText: string;
    newText: string;
    lang?: string | null;
    showLineNumbers?: boolean;
}) {
    const rows = useMemo(() => lineDiff(oldText ?? '', newText ?? ''), [oldText, newText]);
    const stats = useMemo(() => diffStats(rows), [rows]);

    // Line wrapping is a TOUCH-ONLY behavior: on phones horizontal panning
    // inside a diff is miserable, so wrap by default (setting default = true)
    // and let `wrapLinesInDiffs` turn it back off. Fine-pointer/desktop keeps
    // the historical no-wrap + horizontal scroll regardless of the setting —
    // synced blobs already carry wrapLinesInDiffs:true from the years it was
    // a dead setting, so honoring it on desktop would flip PCs overnight.
    const wrapSetting = useSetting('wrapLinesInDiffs');
    const coarsePointer = useMediaQuery('(pointer: coarse)');
    const wrap = coarsePointer && wrapSetting;

    // Highlight old and new sides separately, then map rows onto them by their
    // per-side line numbers (1-based → index).
    const [oldHi, setOldHi] = useState<HiLines>(null);
    const [newHi, setNewHi] = useState<HiLines>(null);

    useEffect(() => {
        let cancelled = false;
        setOldHi(null);
        setNewHi(null);
        if (!lang) return;
        if ((oldText?.length ?? 0) + (newText?.length ?? 0) > 60_000) return;
        if (oldText) highlightToLines(oldText, lang).then((r) => !cancelled && setOldHi(r));
        if (newText) highlightToLines(newText, lang).then((r) => !cancelled && setNewHi(r));
        return () => {
            cancelled = true;
        };
    }, [oldText, newText, lang]);

    const content = (r: DiffRow) => {
        if (r.type === 'del' && r.oldNo != null) return renderLine(r.text, oldHi, r.oldNo - 1);
        if ((r.type === 'add' || r.type === 'ctx') && r.newNo != null) return renderLine(r.text, newHi, r.newNo - 1);
        return r.text === '' ? ' ' : r.text;
    };

    return (
        <div className={`dv vh-copyhost${wrap ? ' dv--wrap' : ''}`}>
            {/* copies a minimal unified patch built from the SAME rows rendered
             * below (single hunk, no file headers — Edit inputs don't reliably
             * carry paths), so the clipboard matches what's on screen. */}
            <CopyButton text={() => unifiedPatchText(rows)} className="vh-copy--overlay" />
            <div className="dv-stat">
                <span className="dv-add">+{stats.added}</span>
                <span className="dv-del">−{stats.removed}</span>
            </div>
            <div className="dv-body">
                {rows.map((r, idx) => (
                    <div key={idx} className={`dv-row dv-row--${r.type}`}>
                        {showLineNumbers && (
                            <>
                                <span className="dv-no">{r.oldNo ?? ''}</span>
                                <span className="dv-no">{r.newNo ?? ''}</span>
                            </>
                        )}
                        <span className="dv-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
                        <span className="dv-text">{content(r)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
