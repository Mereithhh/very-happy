/**
 * FilesPanel — project file tree + changed-files view for a session. Desktop
 * renders it as a right sidebar; mobile as a full-screen overlay (controlled by
 * the parent). Selecting a file opens it inline via FileView. The third tab
 * ("Browse") is the machine file browser (fs-list / fs-read RPCs), rooted at
 * the session's working directory.
 */
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ChevronRight, FileText, RefreshCw, X } from 'lucide-react';
import type { GitFileStatus } from '@/sync/gitStatusFiles';
import type { ProjectFile } from '@/sync/projectFiles';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { FsBrowser } from '../files/FsBrowser';
import { FileView } from './FileView';
import { useSessionFiles } from './useFiles';
import { WorkspacePane } from '../workspace/WorkspacePane';
import { WorkspaceTabs, WorkspaceTabsSlot } from '../workspace/WorkspaceTabs';
import { closeWorkspaceTab, moveWorkspaceTab, openWorkspaceTab } from '../workspace/workspaceTabModel';
import { useWorkspaceView } from '../workspace/workspaceViewStore';
import './files.css';

export type FilesPanelTab = 'changed' | 'all' | 'browse';

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

function FilesPanelContent({
    sessionId,
    viewIdentity,
    refreshOnMount = true,
    active = true,
    renderTabs,
    children,
    onClose,
    tab: controlledTab,
    onTabChange,
}: {
    sessionId: string;
    viewIdentity: string;
    refreshOnMount?: boolean;
    active?: boolean;
    renderTabs?: (props: ComponentProps<typeof WorkspaceTabs>) => ReactNode;
    children?: ReactNode;
    onClose: () => void;
    tab?: FilesPanelTab;
    onTabChange?: (tab: FilesPanelTab) => void;
}) {
    const { t } = useTranslation();
    const { projectFiles, gitStatusFiles, isLoading, isFetching, refresh } = useSessionFiles(sessionId, refreshOnMount);
    const session = useSession(sessionId);
    const [localTab, setLocalTab] = useState<FilesPanelTab>('changed');
    const tab = controlledTab ?? localTab;
    const selectTab = (next: FilesPanelTab) => {
        if (controlledTab === undefined) setLocalTab(next);
        onTabChange?.(next);
    };
    const [fileTabs, setFileTabs] = useWorkspaceView(viewIdentity);
    const selected = fileTabs.active;
    const setSelected = (path: string) => setFileTabs(state => openWorkspaceTab(state, { id: path, title: path.split('/').pop() || path, description: path }));
    const previousControlledTab = useRef(controlledTab);
    useEffect(() => {
        if (previousControlledTab.current !== controlledTab) {
            previousControlledTab.current = controlledTab;
            setFileTabs(state => ({ ...state, active: null }));
        }
    }, [controlledTab]);

    // Machine + working directory for the Browse tab (missing while metadata
    // is still syncing, or on legacy sessions without a machineId).
    const browseMachineId = session?.metadata?.machineId ?? null;
    const browsePath = session?.metadata?.path ?? null;

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
    const effectiveTab: FilesPanelTab = controlledTab === undefined && tab === 'changed' && changed.length === 0 ? 'all' : tab;

    return (
        <div className="fp">
            <WorkspaceTabsSlot render={renderTabs}
                tabs={[
                    { id: 'tool:changed', title: t('session.chat.changedFiles') + (changed.length ? ` (${changed.length})` : ''), closable: false, movable: false },
                    { id: 'tool:all', title: t('session.chat.fileTree'), closable: false, movable: false },
                    { id: 'tool:browse', title: t('fsBrowser.browseTab'), closable: false, movable: false },
                    ...fileTabs.tabs.map(file => ({ ...file, id: `file:${file.id}`, group: 'files' })),
                ]}
                active={selected ? `file:${selected}` : `tool:${effectiveTab}`}
                onSelect={id => {
                    if (id.startsWith('file:')) setFileTabs(state => ({ ...state, active: id.slice(5) }));
                    else { setFileTabs(state => ({ ...state, active: null })); selectTab(id.slice(5) as FilesPanelTab); }
                }}
                onClose={id => setFileTabs(state => closeWorkspaceTab(state, id.slice(5)))}
                onMove={(id, target) => setFileTabs(state => moveWorkspaceTab(state, id.slice(5), target.slice(5)))}
                actions={<>
                    {active && effectiveTab !== 'browse' && <button type="button" className="fp-icon" onClick={() => void refresh()} aria-label={t('session.chat.refresh')} title={t('session.chat.refresh')}><RefreshCw size={14} className={isFetching ? 'fp-spin' : undefined}/></button>}
                    <button type="button" className="fp-icon" onClick={onClose} aria-label={t('session.chat.closeFiles')} title={t('session.chat.closeFiles')}><X size={16}/></button>
                </>}
            />

            <div className="fp-body" hidden={!active || selected !== null}>
                {effectiveTab === 'browse' ? (
                    browseMachineId && browsePath ? (
                        <FsBrowser active={active && selected === null} viewKey={viewIdentity} machineId={browseMachineId} initialPath={browsePath} />
                    ) : (
                        <div className="fp-empty">{t('session.chat.noFiles')}</div>
                    )
                ) : (
                    <>
                        <div className="fp-list">
                            {isLoading ? (
                                <div className="fp-empty"><Spinner size={16} /></div>
                            ) : effectiveTab === 'changed' ? (
                                changed.length === 0 ? (
                                    <div className="fp-empty">{t('session.chat.noFiles')}</div>
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
                                <div className="fp-empty">{t('session.chat.noFiles')}</div>
                            ) : (
                                [...tree.children.values()].sort(sortNodes).map((c) => (
                                    <TreeRow key={c.path} node={c} depth={0} onPick={setSelected} selected={selected} />
                                ))
                            )}
                        </div>

                    </>
                )}
            </div>
            {fileTabs.tabs.map(file => <WorkspacePane className="fp-viewer" key={file.id} active={active && selected === file.id} order={fileTabs.tabs.map(tab => tab.id).join("\n")}>
                <div className="fp-viewer-head"><span className="fp-viewer-path" title={file.id}>{file.id}</span></div>
                <FileView sessionId={sessionId} fullPath={file.id}/>
            </WorkspacePane>)}
            {children}
        </div>
    );
}


/** Reset all path-specific state before rendering a different workspace. */
export function FilesPanel(props: Omit<Parameters<typeof FilesPanelContent>[0], 'viewIdentity'>) {
    const session = useSession(props.sessionId);
    const identity = JSON.stringify([props.sessionId, session?.metadata?.machineId, session?.metadata?.path]);
    return <FilesPanelContent key={identity} viewIdentity={identity} {...props}/>;
}
