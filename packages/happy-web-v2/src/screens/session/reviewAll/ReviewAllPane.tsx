/**
 * B-572: 「审阅改动」 workspace tab — every changed file's diff (vs HEAD) in
 * one scroll, with a file navigator, per-file "viewed" marks (device-local,
 * invalidated when the change changes), expand/collapse all, wrap and
 * ignore-whitespace. Line comments are the B-554 ones (same drafts, same
 * send bar). Sections mount their diff only once scrolled near.
 *
 * Toolbar/navigator idea from Orca's CombinedDiffViewer + combined-diff
 * toolbar (MIT); implementation is ours. Spec:
 * specs/2026-10-change-review-surfaces.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff, ListTree, Space, WrapText } from 'lucide-react';
import { useMediaQuery } from '@/app/useMediaQuery';
import { useSetting } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/ui';
import { Checkbox } from '@/ui/Checkbox';
import { ReviewDiffBody } from '../diffComments/ReviewDiffPane';
import { useGitFileDiff } from '../diffComments/useGitFileDiff';
import { useDiffComments } from '../diffComments/diffCommentsStore';
import { diffRowsHash, estimateSectionBodyPx, isViewedCurrent, pruneViewed, type ReviewFile, type ViewedEntry } from './reviewAllModel';
import { useViewedMap, writeViewedMap, getViewedMap } from './reviewViewedStore';
import { useWorktreeIds } from './useWorktreeIds';
import '../diff.css';
import '../../files/fsbrowser.css';
import '../diffComments/diffComments.css';
import './reviewAll.css';

function copyFor(zh: boolean) {
    return zh ? {
        viewed: '已看', viewedOf: (k: number, n: number) => `已看 ${k}/${n}`, expandAll: '全部展开', collapseAll: '全部折叠',
        wrap: '换行', ignoreWs: '忽略空白', files: '文件', openDiff: '在单独标签打开', noChanges: '工作区没有改动',
        toggle: '展开或折叠', saveFailed: '无法保存「已看」：浏览器存储不可用', comments: (n: number) => `${n} 条批注`,
        status: { modified: '修改', added: '新增', deleted: '删除', renamed: '重命名', untracked: '未跟踪' } as Record<ReviewFile['status'], string>,
    } : {
        viewed: 'Viewed', viewedOf: (k: number, n: number) => `${k}/${n} viewed`, expandAll: 'Expand all', collapseAll: 'Collapse all',
        wrap: 'Wrap', ignoreWs: 'Ignore whitespace', files: 'Files', openDiff: 'Open in its own tab', noChanges: 'No changes in the working tree',
        toggle: 'Expand or collapse', saveFailed: 'Could not save “viewed”: browser storage is unavailable', comments: (n: number) => `${n} comment${n === 1 ? '' : 's'}`,
        status: { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked' } as Record<ReviewFile['status'], string>,
    };
}
type Copy = ReturnType<typeof copyFor>;

const STATUS_CLASS: Record<ReviewFile['status'], string> = {
    modified: 'fp-st--mod', added: 'fp-st--add', deleted: 'fp-st--del', renamed: 'fp-st--ren', untracked: 'fp-st--unt',
};

function ReviewSection({ sessionId, file, copy, root, collapsed, onToggle, viewed, onViewed, wrap, ignoreWs, tabActive, contentId, idsSettled, onLoadedHash, onOpenDiff, commentCount, register }: {
    sessionId: string; file: ReviewFile; copy: Copy; root: HTMLElement | null;
    collapsed: boolean; onToggle: () => void; viewed: boolean; onViewed: (next: boolean, hash: string | null) => void;
    wrap: boolean; ignoreWs: boolean; tabActive: boolean;
    /** working-tree content id (undefined = unknown) and whether the id query for this refresh has settled */
    contentId: string | undefined; idsSettled: boolean;
    onLoadedHash: (path: string, hash: string | null) => void; onOpenDiff: (path: string) => void;
    commentCount: number; register: (path: string, el: HTMLElement | null) => void;
}) {
    const ref = useRef<HTMLElement | null>(null);
    // Mounted once it has come within a screen of the viewport; stays mounted.
    const [near, setNear] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (near || !el) return;
        if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
        }, { root, rootMargin: '600px 0px' });
        io.observe(el);
        return () => io.disconnect();
    }, [near, root]);
    // Wait for the content ids so the first fetch is not repeated when they land;
    // afterwards only THIS file's signature/content change refetches (review 低4).
    const load = near && !collapsed && idsSettled;
    const { state, reload } = useGitFileDiff(sessionId, file.path, file.status === 'untracked', load, `${file.sig}:${contentId ?? ''}`, ignoreWs);
    const hash = useMemo(() => (state.phase === 'ready' && !state.ignoreWhitespace ? diffRowsHash(state.rows) : null), [state]);
    useEffect(() => { onLoadedHash(file.path, hash); }, [file.path, hash, onLoadedHash]);
    const setRef = (el: HTMLElement | null) => { ref.current = el; register(file.path, el); };
    const name = file.path.split('/').pop() || file.path;
    const dir = file.path.slice(0, file.path.length - name.length);
    return (
        <section ref={setRef} className={`rva-section${viewed ? ' is-viewed' : ''}`} data-path={file.path} aria-label={file.path}>
            <div className="rva-section-head">
                <button type="button" className="rva-toggle" aria-expanded={!collapsed} onClick={onToggle} title={copy.toggle}>
                    <ChevronRight size={13} className={`tg-chevron${collapsed ? '' : ' is-open'}`} aria-hidden/>
                    <span className={`fp-status ${STATUS_CLASS[file.status]}`} title={copy.status[file.status]}>{file.status[0].toUpperCase()}</span>
                    <span className="rva-path mono" title={file.path}>
                        {dir && <span className="rva-dir">{dir}</span>}<span className="rva-name">{name}</span>
                    </span>
                    {(file.added > 0 || file.removed > 0) && (
                        <span className="fp-diffstat"><span className="fp-add">+{file.added}</span><span className="fp-del">-{file.removed}</span></span>
                    )}
                    {commentCount > 0 && <span className="rva-comments">{copy.comments(commentCount)}</span>}
                </button>
                <Checkbox className="rva-viewed" checked={viewed} onCheckedChange={(next) => onViewed(next, hash)}>
                    {copy.viewed}
                </Checkbox>
                <button type="button" className="fsb-iconbtn rva-open" onClick={() => onOpenDiff(file.path)} aria-label={copy.openDiff} title={copy.openDiff}><FileDiff size={14}/></button>
            </div>
            {!collapsed && (
                <div className="rva-section-body">
                    {near
                        ? <ReviewDiffBody sessionId={sessionId} path={file.path} state={state} reload={reload} active={tabActive} wrap={wrap} reanchor={!ignoreWs}/>
                        : <div className="rva-placeholder" style={{ height: estimateSectionBodyPx(file) }} aria-hidden/>}
                </div>
            )}
        </section>
    );
}

export function ReviewAllPane({ sessionId, files, active, refreshToken, onOpenDiff }: {
    sessionId: string; files: ReviewFile[]; active: boolean; refreshToken: unknown; onOpenDiff: (path: string) => void;
}) {
    const { lang } = useTranslation();
    const copy = copyFor(lang.startsWith('zh'));
    const coarse = useMediaQuery('(pointer: coarse)');
    const wrapSetting = useSetting('wrapLinesInDiffs');
    const [wrap, setWrap] = useState(() => coarse && wrapSetting);
    const [ignoreWs, setIgnoreWs] = useState(false);
    const [overrides, setOverrides] = useState<Record<string, boolean>>({});
    const [hashes, setHashes] = useState<Record<string, string | null>>({});
    const [navOpen, setNavOpen] = useState(false);
    const viewedMap = useViewedMap(sessionId);
    const comments = useDiffComments(sessionId);
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    const sections = useRef(new Map<string, HTMLElement>());

    const { ids, settled: idsSettled } = useWorktreeIds(sessionId, files, active, refreshToken);
    const viewedOf = (f: ReviewFile) => isViewedCurrent(viewedMap[f.path], f.sig, hashes[f.path] ?? null, ids[f.path]);
    const viewedCount = files.filter(viewedOf).length;
    // Viewed files start collapsed; the user's own toggle wins.
    const collapsedOf = (f: ReviewFile) => overrides[f.path] ?? viewedOf(f);
    const commentCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const c of comments) m.set(c.filePath, (m.get(c.filePath) ?? 0) + 1);
        return m;
    }, [comments]);

    const onLoadedHash = useCallback((path: string, hash: string | null) => {
        setHashes((h) => (h[path] === hash ? h : { ...h, [path]: hash }));
    }, []);
    const register = useCallback((path: string, el: HTMLElement | null) => {
        if (el) sections.current.set(path, el); else sections.current.delete(path);
    }, []);

    const setViewed = (f: ReviewFile, next: boolean, hash: string | null) => {
        const map = { ...getViewedMap(sessionId) };
        if (next) map[f.path] = { sig: f.sig, hash, at: Date.now(), cid: ids[f.path] ?? null } satisfies ViewedEntry;
        else delete map[f.path];
        if (!writeViewedMap(sessionId, pruneViewed(map, files))) { toast.show(copy.saveFailed, 'error'); return; }
        // marking viewed folds the file away (GitHub-style); un-marking opens it again
        setOverrides((o) => ({ ...o, [f.path]: next }));
    };
    const setAll = (collapsed: boolean) => setOverrides(Object.fromEntries(files.map((f) => [f.path, collapsed])));
    const jumpTo = (path: string) => {
        setNavOpen(false);
        setOverrides((o) => ({ ...o, [path]: false }));
        const el = sections.current.get(path);
        // Scroll only our own container (never scrollIntoView: it moves ancestors too).
        if (el && scroller) scroller.scrollTo({ top: el.offsetTop, behavior: "auto" });
    };
    useEffect(() => { if (!active) setNavOpen(false); }, [active]);

    if (files.length === 0) return <div className="rva"><div className="fp-empty">{copy.noChanges}</div></div>;

    const nav = (
        <ul className="rva-nav-list">
            {files.map((f) => {
                const name = f.path.split('/').pop() || f.path;
                return (
                    <li key={f.path}>
                        <button type="button" className={`rva-nav-item${viewedOf(f) ? ' is-viewed' : ''}`} onClick={() => jumpTo(f.path)} title={f.path}>
                            <span className={`fp-status ${STATUS_CLASS[f.status]}`}>{f.status[0].toUpperCase()}</span>
                            <span className="rva-nav-name">{name}</span>
                            {viewedOf(f) && <span className="rva-nav-check" aria-label={copy.viewed}>✓</span>}
                        </button>
                    </li>
                );
            })}
        </ul>
    );

    return (
        <div className="rva">
            <div className="rva-toolbar" role="toolbar" aria-label={copy.files}>
                <button type="button" className={`rva-tool rva-nav-toggle${navOpen ? ' is-active' : ''}`} aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}>
                    <ListTree size={14} aria-hidden/><span>{copy.files}</span>
                </button>
                <span className="rva-progress mono">{copy.viewedOf(viewedCount, files.length)}</span>
                <span className="rva-tools">
                    <button type="button" className="rva-tool" onClick={() => setAll(false)} title={copy.expandAll} aria-label={copy.expandAll}><ChevronsUpDown size={14} aria-hidden/><span className="rva-tool-label">{copy.expandAll}</span></button>
                    <button type="button" className="rva-tool" onClick={() => setAll(true)} title={copy.collapseAll} aria-label={copy.collapseAll}><ChevronsDownUp size={14} aria-hidden/><span className="rva-tool-label">{copy.collapseAll}</span></button>
                    <button type="button" className={`rva-tool${wrap ? ' is-active' : ''}`} aria-pressed={wrap} onClick={() => setWrap((v) => !v)} title={copy.wrap}><WrapText size={14} aria-hidden/><span className="rva-tool-label">{copy.wrap}</span></button>
                    <button type="button" className={`rva-tool${ignoreWs ? ' is-active' : ''}`} aria-pressed={ignoreWs} onClick={() => setIgnoreWs((v) => !v)} title={copy.ignoreWs}><Space size={14} aria-hidden/><span className="rva-tool-label">{copy.ignoreWs}</span></button>
                </span>
            </div>
            <div className="rva-main">
                <nav className={`rva-nav${navOpen ? ' is-open' : ''}`} aria-label={copy.files}>{nav}</nav>
                <div className="rva-scroll" ref={setScroller}>
                    {files.map((f) => (
                        <ReviewSection key={f.path} sessionId={sessionId} file={f} copy={copy} root={scroller}
                            collapsed={collapsedOf(f)} onToggle={() => setOverrides((o) => ({ ...o, [f.path]: !collapsedOf(f) }))}
                            viewed={viewedOf(f)} onViewed={(next, hash) => setViewed(f, next, hash)}
                            wrap={wrap} ignoreWs={ignoreWs} tabActive={active} contentId={ids[f.path]} idsSettled={idsSettled}
                            onLoadedHash={onLoadedHash} onOpenDiff={onOpenDiff} commentCount={commentCounts.get(f.path) ?? 0}
                            register={register}/>
                    ))}
                </div>
            </div>
        </div>
    );
}
