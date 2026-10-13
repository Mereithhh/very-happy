/**
 * B-554: one changed file's diff against HEAD, with line comments.
 *
 * Desktop (fine pointer): hover a row → "+" in the gutter; Shift+"+" on
 * another row extends the range being written. Touch (coarse): tap a row →
 * bottom sheet (range can be extended up/down there). Comments render under
 * their last line; ones whose code is gone are flagged stale. Spec:
 * specs/2026-10-diff-line-comments.md
 */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useMediaQuery } from '@/app/useMediaQuery';
import { useSetting } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, Spinner, toast } from '@/ui';
import { highlightToLines, type HiLines } from '../highlighter';
import { langForPath } from '../langForPath';
import { REVIEW_DIFF_MAX_ROWS, type ReviewRow } from './gitDiff';
import {
    buildAnchor,
    commentRowIndex,
    formatLineRange,
    reanchorFile,
    sideOfRow,
    type CommentSide,
    type DiffComment,
} from './diffComments';
import {
    addDiffComment,
    applyReanchored,
    deleteDiffComment,
    getDiffComments,
    updateDiffComment,
    useDiffComments,
    type WriteResult,
} from './diffCommentsStore';
import { useGitFileDiff, type DiffLoadRefusal, type GitFileDiffState } from './useGitFileDiff';
import { FOCUSABLE_SELECTOR, isActivationKey, trapFocusTarget } from './focusTrap';
import '../diff.css';
import '../../files/fsbrowser.css';
import './diffComments.css';

type Draft =
    | { kind: 'new'; side: CommentSide; pivot: number; start: number; end: number; body: string }
    | { kind: 'edit'; id: string; side: CommentSide; start: number; end: number; body: string };

function lineOf(row: ReviewRow, side: CommentSide): number | null {
    return side === 'new' ? row.newNo : row.oldNo;
}

function copyFor(zh: boolean) {
    return zh ? {
        add: '添加批注', edit: '编辑', del: '删除', save: '保存', cancel: '取消',
        placeholder: '写下要 agent 修改的地方…', stale: '已过期', staleHint: '这段代码已变化，发送时附原片段',
        notInDiff: '以下批注的代码已不在当前 diff 中', refresh: '刷新 diff', openFile: '打开文件',
        noChanges: '与 HEAD 相比没有差异', binary: '二进制文件，无法批注', failed: 'diff 获取失败',
        retry: '重试', truncated: (n: number) => `diff 过长，只显示前 ${n} 行`, up: '向上扩展', down: '向下扩展',
        shiftHint: 'Shift+点「+」扩展范围 · ⌘/Ctrl+Enter 保存', full: '批注存储已满：先发送或清空一些批注', deleted: '删除前',
        writeFailed: '保存失败：浏览器存储不可用', refused: {
            control: '文件名含控制字符，无法安全地传给 shell', quote: '文件名含 " ，在 Windows 上无法安全引用',
            'unknown-platform': '还不知道这台机器的系统，文件名含特殊字符时暂不获取；稍后重试',
        } as Record<DiffLoadRefusal, string>,
        rangeFail: '无法扩展到该行（跨越 hunk 或删除/新增侧不同）',
    } : {
        add: 'Add comment', edit: 'Edit', del: 'Delete', save: 'Save', cancel: 'Cancel',
        placeholder: 'What should the agent change here…', stale: 'Stale', staleHint: 'This code changed; the original snippet is sent',
        notInDiff: 'These comments point at code no longer in this diff', refresh: 'Refresh diff', openFile: 'Open file',
        noChanges: 'No differences from HEAD', binary: 'Binary file — cannot comment', failed: 'Could not load diff',
        retry: 'Retry', truncated: (n: number) => `Diff is long; showing the first ${n} rows`, up: 'Extend up', down: 'Extend down',
        shiftHint: 'Shift+click “+” to extend · ⌘/Ctrl+Enter to save', full: 'Comment storage is full — send or clear some comments first', deleted: 'old',
        writeFailed: 'Could not save: browser storage is unavailable', refused: {
            control: 'The file name has control characters and cannot be passed to the shell safely', quote: 'The file name contains " and cannot be quoted safely on Windows',
            'unknown-platform': 'This machine’s OS is not known yet; special-character file names are not fetched until it is. Retry shortly',
        } as Record<DiffLoadRefusal, string>,
        rangeFail: 'Cannot extend to that line (crosses a hunk or a different side)',
    };
}
type Copy = ReturnType<typeof copyFor>;

function renderText(text: string, hi: HiLines, index: number | undefined) {
    const tokens = index === undefined ? undefined : hi?.[index];
    if (!tokens || tokens.length === 0) return text === '' ? ' ' : text;
    return tokens.map((tok, i) => <span key={i} style={tok.style as React.CSSProperties}>{tok.content}</span>);
}

function CommentEditor({ copy, body, onBody, onSave, onCancel, onDelete, hint, autoFocus = true }: {
    copy: Copy; body: string; onBody: (v: string) => void; onSave: () => void; onCancel: () => void;
    onDelete?: () => void; hint?: string; autoFocus?: boolean;
}) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        if (!autoFocus) return;
        const ta = ref.current;
        if (!ta) return;
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(ta.value.length, ta.value.length);
    }, [autoFocus]);
    const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    };
    return (
        <div className="rdv-editor">
            <textarea ref={ref} className="rdv-textarea" value={body} rows={3} placeholder={copy.placeholder}
                onChange={(e) => onBody(e.target.value)} onKeyDown={onKey} aria-label={copy.add}/>
            <div className="rdv-editor-actions">
                {hint && <span className="rdv-hint">{hint}</span>}
                {onDelete && <Button size="sm" variant="ghost" onClick={onDelete}>{copy.del}</Button>}
                <Button size="sm" variant="ghost" onClick={onCancel}>{copy.cancel}</Button>
                <Button size="sm" variant="primary" disabled={!body.trim()} onClick={onSave}>{copy.save}</Button>
            </div>
        </div>
    );
}

/**
 * aria-modal sheet: Tab/Shift+Tab stay inside, Escape cancels, and focus goes
 * back to whatever opened it (the tapped row) when it closes.
 */
function ModalSheet({ label, onEscape, children }: { label: string; onEscape: () => void; children: React.ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    // Captured during the first render: child effects (the textarea's
    // autofocus) run before this component's own, so an effect would already
    // see focus inside the sheet.
    const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    useEffect(() => () => { opener?.focus?.({ preventScroll: true }); }, [opener]);
    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
        if (e.key !== 'Tab' || !ref.current) return;
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
        const target = trapFocusTarget(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (target !== null) { e.preventDefault(); items[target].focus(); }
    };
    return <div ref={ref} className="rdv-sheet" role="dialog" aria-modal="true" aria-label={label} onKeyDown={onKeyDown}>{children}</div>;
}

function CommentCard({ comment, copy, onEdit, onDelete }: { comment: DiffComment; copy: Copy; onEdit: () => void; onDelete: () => void }) {
    return (
        <div className={`rdv-card${comment.stale ? ' is-stale' : ''}`} data-comment-id={comment.id}>
            <div className="rdv-card-head">
                <span className="rdv-card-range mono">{comment.side === 'old' ? `${copy.deleted} ` : ''}{formatLineRange(comment)}</span>
                {comment.stale && <span className="rdv-stale" title={copy.staleHint}>{copy.stale}</span>}
                <span className="rdv-card-actions">
                    <button type="button" className="rdv-icon" onClick={onEdit} aria-label={copy.edit} title={copy.edit}><Pencil size={13}/></button>
                    <button type="button" className="rdv-icon" onClick={onDelete} aria-label={copy.del} title={copy.del}><Trash2 size={13}/></button>
                </span>
            </div>
            <div className="rdv-card-body">{comment.body}</div>
        </div>
    );
}

export function ReviewDiffPane({ sessionId, path, untracked, active, onOpenFile, refreshToken }: {
    sessionId: string; path: string; untracked: boolean; active: boolean; onOpenFile: () => void;
    /** changes when the panel's git status is refreshed → refetch the diff */
    refreshToken?: unknown;
}) {
    const { lang } = useTranslation();
    const copy = copyFor(lang.startsWith('zh'));
    const { state, reload } = useGitFileDiff(sessionId, path, untracked, active, refreshToken);
    const rows = state.phase === 'ready' ? state.rows.slice(0, REVIEW_DIFF_MAX_ROWS) : null;
    const added = rows?.filter((r) => r.type === 'add').length ?? 0;
    const removed = rows?.filter((r) => r.type === 'del').length ?? 0;

    return (
        <div className="rdv-pane">
            <div className="fsb-viewer-head rdv-head">
                <span className="fsb-viewer-path" title={path}>{path}</span>
                {rows && <span className="fp-diffstat"><span className="fp-add">+{added}</span><span className="fp-del">-{removed}</span></span>}
                <div className="fsb-viewer-actions">
                    <button type="button" className="fsb-iconbtn" onClick={() => void reload()} aria-label={copy.refresh} title={copy.refresh}><RefreshCw size={14}/></button>
                    <button type="button" className="fsb-iconbtn" onClick={onOpenFile} aria-label={copy.openFile} title={copy.openFile}><FileText size={14}/></button>
                </div>
            </div>
            <div className="rdv-scroll">
                <ReviewDiffBody sessionId={sessionId} path={path} state={state} reload={reload} active={active}/>
            </div>
        </div>
    );
}

/**
 * One file's diff rows with comments, the inline editor and the touch sheet —
 * shared by the single-file diff tab and the review-all tab (B-572), so both
 * write the same comment drafts sent by the same DiffCommentsBar.
 */
export function ReviewDiffBody({ sessionId, path, state, reload, active, wrap: wrapOverride, reanchor = true }: {
    sessionId: string; path: string; state: GitFileDiffState; reload: () => Promise<void> | void; active: boolean;
    /** undefined → the diff tab's rule (wrap only on touch, per setting) */
    wrap?: boolean;
    /** false → do not persist re-anchoring (ignore-whitespace view) */
    reanchor?: boolean;
}) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const copy = copyFor(zh);
    const all = useDiffComments(sessionId);
    const comments = useMemo(() => all.filter((c) => c.filePath === path), [all, path]);
    const coarse = useMediaQuery('(pointer: coarse)');
    const wrapSetting = useSetting('wrapLinesInDiffs');
    const wrap = wrapOverride ?? (coarse && wrapSetting);
    const [draft, setDraft] = useState<Draft | null>(null);

    const allRows = state.phase === 'ready' ? state.rows : null;
    const rows = useMemo(() => allRows?.slice(0, REVIEW_DIFF_MAX_ROWS) ?? null, [allRows]);

    // Re-anchor this file's comments every time a fresh diff arrives.
    useEffect(() => {
        // B-572: an ignore-whitespace diff hides lines on purpose; re-anchoring
        // against it would mark good comments stale, so it is read-only.
        if (state.phase !== 'ready' || !reanchor) return;
        applyReanchored(sessionId, reanchorFile(getDiffComments(sessionId), path, state.rows));
    }, [state, sessionId, path, reanchor]);
    // A refreshed diff invalidates an unsaved new-comment range.
    useEffect(() => { setDraft((d) => (d?.kind === 'new' ? null : d)); }, [allRows]);

    // Syntax highlight each side as one text (hunks concatenated: close enough
    // for token colours), then index rows into it.
    const [hi, setHi] = useState<{ old: HiLines; new: HiLines }>({ old: null, new: null });
    const sideIndex = useMemo(() => {
        const idx = new Map<number, number>();
        const old: string[] = [];
        const neu: string[] = [];
        rows?.forEach((r, i) => {
            if (r.type === 'del') { idx.set(i, old.length); old.push(r.text); }
            else if (r.type !== 'hunk') { idx.set(i, neu.length); neu.push(r.text); }
        });
        return { idx, oldText: old.join('\n'), newText: neu.join('\n') };
    }, [rows]);
    useEffect(() => {
        let cancelled = false;
        setHi({ old: null, new: null });
        const language = langForPath(path);
        if (!language || sideIndex.oldText.length + sideIndex.newText.length > 60_000) return;
        if (sideIndex.newText) void highlightToLines(sideIndex.newText, language).then((r) => !cancelled && setHi((h) => ({ ...h, new: r })));
        if (sideIndex.oldText) void highlightToLines(sideIndex.oldText, language).then((r) => !cancelled && setHi((h) => ({ ...h, old: r })));
        return () => { cancelled = true; };
    }, [sideIndex, path]);

    const placement = useMemo(() => {
        const at = new Map<number, DiffComment[]>();
        const orphans: DiffComment[] = [];
        if (!rows) return { at, orphans: comments };
        for (const c of comments) {
            const i = commentRowIndex(c, rows);
            if (i === null) orphans.push(c);
            else at.set(i, [...(at.get(i) ?? []), c]);
        }
        return { at, orphans };
    }, [comments, rows]);

    const draftEndRow = useMemo(() => {
        if (!draft || !rows) return null;
        return commentRowIndex({ side: draft.side, endLine: draft.end }, rows);
    }, [draft, rows]);
    const inDraft = (row: ReviewRow) => {
        if (!draft) return false;
        const no = lineOf(row, draft.side);
        return no !== null && no >= draft.start && no <= draft.end && !(draft.side === 'new' && row.type === 'del') && !(draft.side === 'old' && row.type === 'add');
    };
    const commentedLines = useMemo(() => {
        const set = new Set<string>();
        for (const c of comments) for (let n = c.startLine; n <= c.endLine; n++) set.add(`${c.side}:${n}`);
        return set;
    }, [comments]);

    const startNew = (rowIndex: number, extend: boolean) => {
        if (!rows) return;
        const row = rows[rowIndex];
        const side = sideOfRow(row);
        if (!side) return;
        const line = lineOf(row, side)!;
        if (extend && draft?.kind === 'new') {
            if (draft.side === side && buildAnchor(rows, side, draft.pivot, line)) {
                setDraft({ ...draft, start: Math.min(draft.pivot, line), end: Math.max(draft.pivot, line) });
            } else {
                toast.show(copy.rangeFail, 'info');
            }
            return;
        }
        setDraft({ kind: 'new', side, pivot: line, start: line, end: line, body: draft?.kind === 'new' ? draft.body : '' });
    };
    const extendBy = (dir: -1 | 1) => {
        if (!draft || draft.kind !== 'new' || !rows) return;
        const start = dir < 0 ? draft.start - 1 : draft.start;
        const end = dir > 0 ? draft.end + 1 : draft.end;
        if (start < 1 || !buildAnchor(rows, draft.side, start, end)) { toast.show(copy.rangeFail, 'info'); return; }
        setDraft({ ...draft, start, end });
    };
    const save = () => {
        if (!draft || !rows || !draft.body.trim()) return;
        let result: WriteResult;
        if (draft.kind === 'edit') {
            result = updateDiffComment(sessionId, draft.id, { body: draft.body.trim() });
        } else {
            const anchor = buildAnchor(rows, draft.side, draft.start, draft.end);
            if (!anchor) { toast.show(copy.rangeFail, 'info'); return; }
            result = addDiffComment(sessionId, path, anchor, draft.body.trim());
        }
        // keep the editor (and the typed text) open when the write did not land
        if (result !== 'ok') { toast.show(result === 'quota' ? copy.full : copy.writeFailed, 'error'); return; }
        setDraft(null);
    };
    const edit = (c: DiffComment) => setDraft({ kind: 'edit', id: c.id, side: c.side, start: c.startLine, end: c.endLine, body: c.body });
    const remove = (id: string) => {
        if (deleteDiffComment(sessionId, id) !== 'ok') { toast.show(copy.writeFailed, 'error'); return; }
        if (draft?.kind === 'edit' && draft.id === id) setDraft(null);
    };

    const editor = draft && (
        <CommentEditor copy={copy} body={draft.body} onBody={(body) => setDraft({ ...draft, body })}
            onSave={save} onCancel={() => setDraft(null)}
            onDelete={draft.kind === 'edit' ? () => remove(draft.id) : undefined}
            hint={!coarse && draft.kind === 'new' ? copy.shiftHint : undefined}/>
    );
    const draftLabel = draft ? `${draft.side === 'old' ? `${copy.deleted} ` : ''}${formatLineRange({ startLine: draft.start, endLine: draft.end })}` : '';
    const draftSnippet = useMemo(() => {
        if (!draft || !rows) return [] as string[];
        return rows.filter((r) => r.type !== 'hunk' && inDraft(r)).map((r) => r.text).slice(0, 8);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- inDraft reads draft
    }, [draft, rows]);

    const body = () => {
        if (state.phase === 'loading') return <div className="fp-empty"><Spinner size={16}/></div>;
        if (state.phase === 'error') return (
            <div className="fp-empty rdv-error">
                <span>{copy.failed}</span>
                <span className="rdv-error-detail mono">{state.message}</span>
                <Button size="sm" onClick={() => void reload()}>{copy.retry}</Button>
            </div>
        );
        if (state.phase === 'refused') return (
            <div className="fp-empty rdv-error">
                <span>{copy.refused[state.reason]}</span>
                <Button size="sm" onClick={() => void reload()}>{copy.retry}</Button>
            </div>
        );
        if (state.phase === 'binary') return <div className="fp-empty">{copy.binary}</div>;
        if (!rows || rows.length === 0) return <div className="fp-empty">{copy.noChanges}</div>;
        return (
            <div className={`dv rdv${wrap ? ' dv--wrap' : ''}${coarse ? ' rdv--touch' : ''}`}>
                {(allRows?.length ?? 0) > REVIEW_DIFF_MAX_ROWS && <div className="rdv-notice">{copy.truncated(REVIEW_DIFF_MAX_ROWS)}</div>}
                <div className="rdv-rows">
                    {rows.map((r, i) => {
                        if (r.type === 'hunk') return <div key={i} className="rdv-hunk mono">{r.text}</div>;
                        const side = sideOfRow(r)!;
                        const no = lineOf(r, side)!;
                        const cls = `dv-row dv-row--${r.type} rdv-row${inDraft(r) ? ' is-selected' : ''}${commentedLines.has(`${side}:${no}`) ? ' has-comment' : ''}`;
                        const cards = placement.at.get(i);
                        return (
                            <Fragment key={i}>
                                <div className={cls} data-row={i}
                                    {...(coarse ? {
                                        role: 'button',
                                        tabIndex: 0,
                                        'aria-label': `${copy.add} ${side === 'old' ? `${copy.deleted} ` : ''}L${no}`,
                                        onClick: () => { if (window.getSelection()?.isCollapsed !== false) startNew(i, false); },
                                        onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
                                            if (e.target === e.currentTarget && isActivationKey(e.key)) { e.preventDefault(); startNew(i, false); }
                                        },
                                    } : {})}>
                                    <span className="rdv-gutter">
                                        <span className="rdv-no">{r.oldNo ?? ''}</span>
                                        <span className="rdv-no">{r.newNo ?? ''}</span>
                                        {!coarse && (
                                            <button type="button" className="rdv-plus" aria-label={`${copy.add} ${formatLineRange({ startLine: no, endLine: no })}`}
                                                title={copy.add} onClick={(e) => { e.stopPropagation(); startNew(i, e.shiftKey); }}>
                                                <Plus size={12}/>
                                            </button>
                                        )}
                                    </span>
                                    <span className="dv-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
                                    <span className="dv-text">{renderText(r.text, r.type === 'del' ? hi.old : hi.new, sideIndex.idx.get(i))}</span>
                                </div>
                                {cards?.map((c) => (!coarse && draft?.kind === 'edit' && draft.id === c.id)
                                    ? <div key={c.id} className="rdv-inline">{editor}</div>
                                    : <div key={c.id} className="rdv-inline"><CommentCard comment={c} copy={copy} onEdit={() => edit(c)} onDelete={() => remove(c.id)}/></div>)}
                                {!coarse && draft?.kind === 'new' && draftEndRow === i && <div className="rdv-inline">{editor}</div>}
                            </Fragment>
                        );
                    })}
                </div>
            </div>
        );
    };

    return (
        <>
            {placement.orphans.length > 0 && (
                <div className="rdv-orphans">
                    <div className="rdv-orphans-title">{copy.notInDiff}</div>
                    {placement.orphans.map((c) => (!coarse && draft?.kind === 'edit' && draft.id === c.id)
                        ? <Fragment key={c.id}>{editor}</Fragment>
                        : <CommentCard key={c.id} comment={c} copy={copy} onEdit={() => edit(c)} onDelete={() => remove(c.id)}/>)}
                </div>
            )}
            {body()}
            {coarse && draft && active && createPortal(
                <div className="rdv-sheet-root">
                    <div className="rdv-sheet-scrim" onClick={() => { if (!draft.body.trim()) setDraft(null); }} aria-hidden/>
                    <ModalSheet label={copy.add} onEscape={() => setDraft(null)}>
                        <div className="rdv-sheet-head">
                            <span className="rdv-sheet-path mono" title={path}>{path.split('/').pop()}</span>
                            <span className="rdv-card-range mono">{draftLabel}</span>
                        </div>
                        {draftSnippet.length > 0 && <pre className="rdv-sheet-snippet mono">{draftSnippet.join('\n')}</pre>}
                        {draft.kind === 'new' && (
                            <div className="rdv-sheet-extend">
                                <Button size="sm" leftIcon={<ChevronUp size={14}/>} onClick={() => extendBy(-1)}>{copy.up}</Button>
                                <Button size="sm" leftIcon={<ChevronDown size={14}/>} onClick={() => extendBy(1)}>{copy.down}</Button>
                            </div>
                        )}
                        {editor}
                    </ModalSheet>
                </div>,
                document.body,
            )}
        </>
    );
}
