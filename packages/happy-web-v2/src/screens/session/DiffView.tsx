/**
 * DiffView — unified +/- line diff for Edit/MultiEdit/Write tool views.
 * Lines are syntax-highlighted (lazy shiki tokens) so the diff isn't a flat
 * wall of one color; +/- backgrounds are kept subtle so token colors show.
 */
import { useEffect, useMemo, useState } from 'react';
import { lineDiff, diffStats, type DiffRow } from './diff';
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
        <div className="dv">
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
