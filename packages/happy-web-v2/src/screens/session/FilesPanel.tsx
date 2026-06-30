/**
 * FilesPanel — project file tree + changed-files view for a session. Desktop
 * renders it as a right sidebar; mobile as a full-screen overlay (controlled by
 * the parent). Selecting a file opens it inline via FileView.
 */
import { useMemo, useState } from 'react';
import { ChevronRight, FileText, RefreshCw, X } from 'lucide-react';
import type { GitFileStatus } from '@/sync/gitStatusFiles';
import type { ProjectFile } from '@/sync/projectFiles';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { FileView } from './FileView';
import { useSessionFiles } from './useFiles';
import './files.css';

type Tab = 'changed' | 'all';

type TreeNode = {
    name: string;
    path: string;
    children: Map<string, TreeNode>;
    file?: ProjectFile;
};

function buildTree(files: ProjectFile[]): TreeNode {
    const root: TreeNode = { name: '', path: '', children: new Map() };
    for (const f of files) {
        const parts = f.fullPath.split('/');
        let node = root;
        let acc = '';
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            acc = acc ? `${acc}/${part}` : part;
            let child = node.children.get(part);
            if (!child) {
                child = { name: part, path: acc, children: new Map() };
                node.children.set(part, child);
            }
            if (i === parts.length - 1) child.file = f;
            node = child;
        }
    }
    return root;
}

function TreeRow({
    node,
    depth,
    onPick,
    selected,
}: {
    node: TreeNode;
    depth: number;
    onPick: (path: string) => void;
    selected: string | null;
}) {
    const isDir = node.children.size > 0 && !node.file;
    const [open, setOpen] = useState(depth < 1);

    if (isDir) {
        const kids = [...node.children.values()].sort(sortNodes);
        return (
            <>
                <button
                    type="button"
                    className="fp-row fp-row--dir"
                    style={{ paddingLeft: depth * 12 + 8 }}
                    onClick={() => setOpen((v) => !v)}
                >
                    <ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} />
                    <span className="fp-name">{node.name}</span>
                </button>
                {open && kids.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} onPick={onPick} selected={selected} />)}
            </>
        );
    }
    return (
        <button
            type="button"
            className={`fp-row${selected === node.path ? ' fp-row--active' : ''}`}
            style={{ paddingLeft: depth * 12 + 8 }}
            onClick={() => onPick(node.path)}
        >
            <FileText size={13} className="fp-file-icon" />
            <span className="fp-name">{node.name}</span>
        </button>
    );
}

function sortNodes(a: TreeNode, b: TreeNode): number {
    const aDir = a.children.size > 0 && !a.file;
    const bDir = b.children.size > 0 && !b.file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
}

const STATUS_CLASS: Record<GitFileStatus['status'], string> = {
    modified: 'fp-st--mod',
    added: 'fp-st--add',
    deleted: 'fp-st--del',
    renamed: 'fp-st--ren',
    untracked: 'fp-st--unt',
};

export function FilesPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const { t } = useTranslation();
    const { projectFiles, gitStatusFiles, isLoading, isFetching, refresh } = useSessionFiles(sessionId, true);
    const [tab, setTab] = useState<Tab>('changed');
    const [selected, setSelected] = useState<string | null>(null);

    const tree = useMemo(() => buildTree(projectFiles?.files ?? []), [projectFiles]);

    const changed: GitFileStatus[] = useMemo(() => {
        if (!gitStatusFiles) return [];
        const seen = new Set<string>();
        const out: GitFileStatus[] = [];
        for (const f of [...gitStatusFiles.unstagedFiles, ...gitStatusFiles.stagedFiles]) {
            if (seen.has(f.fullPath)) continue;
            seen.add(f.fullPath);
            out.push(f);
        }
        return out;
    }, [gitStatusFiles]);

    // default to "all" tab if there are no changes
    const effectiveTab: Tab = tab === 'changed' && changed.length === 0 ? 'all' : tab;

    return (
        <div className="fp">
            <div className="fp-head">
                <div className="fp-tabs">
                    <button
                        type="button"
                        className={`fp-tab${effectiveTab === 'changed' ? ' is-active' : ''}`}
                        onClick={() => setTab('changed')}
                    >
                        {t('session.chat.changedFiles' as any)}
                        {changed.length > 0 && <span className="fp-tab-count">{changed.length}</span>}
                    </button>
                    <button
                        type="button"
                        className={`fp-tab${effectiveTab === 'all' ? ' is-active' : ''}`}
                        onClick={() => setTab('all')}
                    >
                        {t('session.chat.fileTree' as any)}
                    </button>
                </div>
                <button type="button" className="fp-icon" onClick={() => void refresh()} aria-label={t('session.chat.refresh' as any)} title={t('session.chat.refresh' as any)}>
                    <RefreshCw size={14} className={isFetching ? 'fp-spin' : undefined} />
                </button>
                <button type="button" className="fp-icon" onClick={onClose} aria-label={t('session.chat.closeFiles' as any)} title={t('session.chat.closeFiles' as any)}>
                    <X size={16} />
                </button>
            </div>

            <div className="fp-body">
                <div className="fp-list">
                    {isLoading ? (
                        <div className="fp-empty"><Spinner size={16} /></div>
                    ) : effectiveTab === 'changed' ? (
                        changed.length === 0 ? (
                            <div className="fp-empty">{t('session.chat.noFiles' as any)}</div>
                        ) : (
                            changed.map((f) => (
                                <button
                                    key={f.fullPath}
                                    type="button"
                                    className={`fp-row${selected === f.fullPath ? ' fp-row--active' : ''}`}
                                    onClick={() => setSelected(f.fullPath)}
                                    title={f.fullPath}
                                >
                                    <span className={`fp-status ${STATUS_CLASS[f.status]}`}>{f.status[0].toUpperCase()}</span>
                                    <span className="fp-name">{f.fileName}</span>
                                    {(f.linesAdded > 0 || f.linesRemoved > 0) && (
                                        <span className="fp-diffstat">
                                            <span className="fp-add">+{f.linesAdded}</span>
                                            <span className="fp-del">-{f.linesRemoved}</span>
                                        </span>
                                    )}
                                </button>
                            ))
                        )
                    ) : (projectFiles?.files.length ?? 0) === 0 ? (
                        <div className="fp-empty">{t('session.chat.noFiles' as any)}</div>
                    ) : (
                        [...tree.children.values()].sort(sortNodes).map((c) => (
                            <TreeRow key={c.path} node={c} depth={0} onPick={setSelected} selected={selected} />
                        ))
                    )}
                </div>
                {selected && (
                    <div className="fp-viewer">
                        <div className="fp-viewer-head">
                            <span className="fp-viewer-path">{selected}</span>
                            <button type="button" className="fp-icon" onClick={() => setSelected(null)} aria-label={t('common.back' as any)}>
                                <X size={14} />
                            </button>
                        </div>
                        <FileView sessionId={sessionId} fullPath={selected} />
                    </div>
                )}
            </div>
        </div>
    );
}
