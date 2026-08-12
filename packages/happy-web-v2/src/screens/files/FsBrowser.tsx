/**
 * FsBrowser — machine directory browser shared by the terminal drawer and the
 * session FilesPanel's "browse" tab. Breadcrumb navigation + dirs-first
 * listing (size / mtime, hidden-file toggle) + built-in file viewer
 * (FsFileViewer). Data comes from the machine-level fs-list / fs-read RPCs;
 * an old daemon (or offline machine) surfaces a friendly upgrade hint instead
 * of a raw error (see fsOps 'unsupported').
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, FileText, Folder, Link as LinkIcon, RefreshCw } from 'lucide-react';
import { machineFsList, type FsEntry, type FsFailure } from '@/sync/fsOps';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { FsFileViewer } from './FsFileViewer';
import { fsFailureText } from './fsFailureText';
import {
    formatFsSize,
    fsBreadcrumbs,
    joinFsPath,
    sortFsEntries,
    visibleFsEntries,
} from './fsBrowseModel';
import './fsbrowser.css';

function formatMtime(mtimeMs: number | undefined): string {
    if (!mtimeMs) return '';
    return new Date(mtimeMs).toLocaleString(undefined, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
}

function entryIcon(type: FsEntry['type']) {
    if (type === 'dir') return <Folder size={13} className="fsb-icon fsb-icon--dir" />;
    if (type === 'symlink') return <LinkIcon size={13} className="fsb-icon" />;
    return <FileText size={13} className="fsb-icon" />;
}

export function FsBrowser({ machineId, initialPath }: { machineId: string; initialPath: string }) {
    const { t } = useTranslation();
    // `path` is the last successfully listed directory (normalized by the
    // daemon — so a '~' initialPath becomes the real home path once loaded).
    const [path, setPath] = useState(initialPath);
    const [entries, setEntries] = useState<FsEntry[] | null>(null);
    const [truncated, setTruncated] = useState(false);
    const [loading, setLoading] = useState(true);
    const [failure, setFailure] = useState<FsFailure | null>(null);
    const [showHidden, setShowHidden] = useState(false);
    const [file, setFile] = useState<string | null>(null);
    // Monotonic request id: only the LATEST navigation may apply its result
    // (rapid clicking must not let a slow older response overwrite a newer one).
    const reqSeq = useRef(0);

    const load = useCallback(async (target: string) => {
        const seq = ++reqSeq.current;
        setLoading(true);
        const res = await machineFsList(machineId, target);
        if (seq !== reqSeq.current) return;
        setLoading(false);
        if (!res.ok) {
            // A symlink row can point at a FILE — the probe-list answers
            // 'not-a-directory'; open it in the viewer instead of erroring.
            if (res.code === 'not-a-directory') {
                setFile(target);
                setFailure(null);
                return;
            }
            setFailure(res);
            return;
        }
        setFailure(null);
        setPath(res.path);
        setEntries(res.entries);
        setTruncated(res.truncated);
    }, [machineId]);

    useEffect(() => {
        void load(initialPath);
        // initialPath is only the STARTING point — later prop changes don't
        // reset an in-progress navigation (the component remounts per open).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]);

    const openEntry = (entry: FsEntry) => {
        const full = joinFsPath(path, entry.name);
        if (entry.type === 'file') {
            setFile(full);
        } else {
            // dir — and symlink, whose target kind the probe-list resolves.
            void load(full);
        }
    };

    if (file) {
        return <FsFileViewer machineId={machineId} path={file} onClose={() => setFile(null)} />;
    }

    const rows = entries ? visibleFsEntries(sortFsEntries(entries), showHidden) : null;
    const crumbs = fsBreadcrumbs(path);

    return (
        <div className="fsb">
            <div className="fsb-bar">
                <nav className="fsb-crumbs mono" aria-label={t('fsBrowser.breadcrumbs')}>
                    {crumbs.map((c, i) => (
                        <span key={c.path} className="fsb-crumb-seg">
                            {i > 1 && <span className="fsb-crumb-sep" aria-hidden>/</span>}
                            <button
                                type="button"
                                className={`fsb-crumb${i === crumbs.length - 1 ? ' is-current' : ''}`}
                                onClick={() => void load(c.path)}
                            >
                                {c.label}
                            </button>
                        </span>
                    ))}
                </nav>
                <button
                    type="button"
                    className={`fsb-iconbtn${showHidden ? ' is-active' : ''}`}
                    aria-pressed={showHidden}
                    aria-label={showHidden ? t('fsBrowser.hideHidden') : t('fsBrowser.showHidden')}
                    title={showHidden ? t('fsBrowser.hideHidden') : t('fsBrowser.showHidden')}
                    onClick={() => setShowHidden((v) => !v)}
                >
                    {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button
                    type="button"
                    className="fsb-iconbtn"
                    aria-label={t('session.chat.refresh')}
                    title={t('session.chat.refresh')}
                    onClick={() => void load(path)}
                >
                    <RefreshCw size={14} className={loading ? 'fsb-spin' : undefined} />
                </button>
            </div>

            <div className="fsb-list">
                {failure ? (
                    <div className="fsb-center">
                        <span>{fsFailureText(t, failure)}</span>
                        <button type="button" className="fsb-retry" onClick={() => void load(path)}>
                            {t('fsBrowser.retry')}
                        </button>
                    </div>
                ) : rows == null ? (
                    <div className="fsb-center"><Spinner size={16} /></div>
                ) : rows.length === 0 ? (
                    <div className="fsb-center">{t('fsBrowser.empty')}</div>
                ) : (
                    <>
                        {rows.map((entry) => (
                            <button
                                key={entry.name}
                                type="button"
                                className="fsb-row"
                                onClick={() => openEntry(entry)}
                                title={entry.name}
                            >
                                {entryIcon(entry.type)}
                                <span className="fsb-name">{entry.name}</span>
                                <span className="fsb-meta mono">
                                    {entry.type !== 'dir' ? formatFsSize(entry.size) : ''}
                                </span>
                                <span className="fsb-meta fsb-meta--time mono">{formatMtime(entry.mtimeMs)}</span>
                            </button>
                        ))}
                        {truncated && (
                            <div className="fsb-notice">{t('fsBrowser.listTruncated', { count: 2000 })}</div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
