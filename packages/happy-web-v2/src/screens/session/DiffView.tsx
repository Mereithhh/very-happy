/**
 * DiffView — +/- line diff for Edit/MultiEdit/Write tool views and turn diffs.
 * Lines are syntax-highlighted (lazy shiki tokens) so the diff isn't a flat
 * wall of one color; +/- backgrounds are kept subtle so token colors show.
 *
 * B-613: unified (default) or side-by-side. Split exists only when the diff's
 * own box is ≥720px wide — a container query on `.dv--cq` shows the toggle and
 * the split body; narrower containers always get unified and no toggle. The
 * choice is a device-local setting (localSettings.diffLayout).
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Columns2, Rows2 } from 'lucide-react';
import { useLocalSettingMutable, useSetting } from '@/sync/storage';
import { useMediaQuery } from '@/app/useMediaQuery';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { lineDiff, diffStats, pairSplitRows, unifiedPatchText, type DiffRow } from './diff';
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

type Side = 'old' | 'new';

/**
 * B-613: the text a split-view selection should copy — only the code cells
 * (`.dv-text`) of ONE side, each clipped to the selection range, one line per
 * real row (pad cells skipped). Line numbers, +/− signs and the other column never get in, whatever
 * the browser's own serialization of a range that crosses the columns does.
 */
export function splitSelectionText(body: Element, side: Side, range: Range): string {
    const lines: string[] = [];
    for (const cell of body.querySelectorAll(`[data-side='${side}'] .dv-text`)) {
        if (!range.intersectsNode(cell)) continue;
        const r = document.createRange();
        r.selectNodeContents(cell);
        if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
        // pad cells are not part of this side's text; a blank source line
        // renders as ' ' (so the row keeps its height) but copies as ''
        if (cell.hasAttribute('data-pad')) continue;
        lines.push(cell.hasAttribute('data-blank') ? '' : r.toString());
    }
    return lines.join('\n');
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
    const { lang: uiLang } = useTranslation();
    const zh = uiLang.startsWith('zh');
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

    // Side-by-side only means something when both sides have text: a Write /
    // NotebookEdit (old = '') would render an empty left column.
    const [layout, setLayout] = useLocalSettingMutable('diffLayout');
    const canSplit = (oldText ?? '') !== '' && (newText ?? '') !== '';
    const split = canSplit && layout === 'split';
    const pairs = useMemo(() => (split ? pairSplitRows(rows) : null), [split, rows]);

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
    // Split cells: each side is highlighted from ITS OWN text (a context line
    // on the left uses the old-side tokens), same token colors as unified.
    const sideContent = (r: DiffRow, side: Side) => {
        const no = side === 'old' ? r.oldNo : r.newNo;
        return no != null ? renderLine(r.text, side === 'old' ? oldHi : newHi, no - 1) : r.text === '' ? ' ' : r.text;
    };

    // Selecting in split view stays on the side the drag started in: the
    // other side turns user-select:none for the duration (diff.css).
    const splitRef = useRef<HTMLDivElement>(null);
    const onSplitPointerDown = (e: ReactPointerEvent) => {
        const side = (e.target as Element).closest?.('[data-side]')?.getAttribute('data-side');
        if (splitRef.current && side) splitRef.current.dataset.selectSide = side;
    };
    const onSplitCopy = (e: ReactClipboardEvent) => {
        const body = splitRef.current;
        const side = body?.dataset.selectSide as Side | undefined;
        const sel = window.getSelection();
        if (!body || !side || !sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        e.clipboardData.setData('text/plain', splitSelectionText(body, side, sel.getRangeAt(0)));
        e.preventDefault();
    };

    const cell = (r: DiffRow | null, side: Side, key: number) => {
        if (!r) {
            return (
                <div key={key} className="dv-row dv-row--empty" data-side={wrap ? side : undefined}>
                    {showLineNumbers && <span className="dv-no" />}
                    <span className="dv-sign"> </span>
                    <span className="dv-text" data-pad=""> </span>
                </div>
            );
        }
        const sign = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ';
        return (
            <div key={key} className={`dv-row dv-row--${r.type}`} data-side={wrap ? side : undefined}>
                {showLineNumbers && <span className="dv-no">{(side === 'old' ? r.oldNo : r.newNo) ?? ''}</span>}
                <span className="dv-sign">{sign}</span>
                <span className="dv-text" data-blank={r.text === '' ? '' : undefined}>{sideContent(r, side)}</span>
            </div>
        );
    };

    const copy = zh
        ? { unified: '统一视图', split: '左右对比', label: '差异布局' }
        : { unified: 'Unified view', split: 'Side-by-side view', label: 'Diff layout' };

    return (
        <div className={`dv dv--cq vh-copyhost${wrap ? ' dv--wrap' : ''}${split ? ' dv--split' : ''}${showLineNumbers ? ' dv--ln' : ''}`}>
            {/* copies a minimal unified patch built from the SAME rows rendered
             * below (single hunk, no file headers — Edit inputs don't reliably
             * carry paths), so the clipboard matches what's on screen. */}
            <CopyButton text={() => unifiedPatchText(rows)} className="vh-copy--overlay vh-hit" />
            <div className="dv-stat">
                <span className="dv-add">+{stats.added}</span>
                <span className="dv-del">−{stats.removed}</span>
                {canSplit && (
                    <span className="dv-layout" role="group" aria-label={copy.label}>
                        <button type="button" className="dv-layout-btn" aria-pressed={!split} aria-label={copy.unified} title={copy.unified}
                            onClick={() => setLayout('unified')}>
                            <Rows2 size={13} aria-hidden />
                        </button>
                        <button type="button" className="dv-layout-btn" aria-pressed={split} aria-label={copy.split} title={copy.split}
                            onClick={() => setLayout('split')}>
                            <Columns2 size={13} aria-hidden />
                        </button>
                    </span>
                )}
            </div>
            <div className="dv-body dv-body--unified">
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
            {pairs && (
                <div ref={splitRef} className="dv-body dv-body--split" onPointerDown={onSplitPointerDown} onCopy={onSplitCopy}>
                    {wrap
                        // wrap (coarse pointer): one grid row per pair so wrapped
                        // lines keep both sides aligned
                        ? pairs.map((p, i) => (
                            <div key={i} className="dv-srow">
                                {cell(p.old, 'old', 0)}
                                {cell(p.new, 'new', 1)}
                            </div>
                        ))
                        // no-wrap: two columns, each its own horizontal scroller;
                        // rows are single-line so they stay aligned
                        : (['old', 'new'] as const).map((side) => (
                            <div key={side} className={`dv-side dv-side--${side}`} data-side={side}>
                                {pairs.map((p, i) => cell(side === 'old' ? p.old : p.new, side, i))}
                            </div>
                        ))}
                </div>
            )}
        </div>
    );
}
