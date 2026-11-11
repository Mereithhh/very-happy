/**
 * B-867 operator file panel — browse and read files of THIS session's project
 * folder through session RPCs (`listDirectory` / `readFile`), which the
 * daemon confines to the session cwd (validatePath) and the broker re-checks.
 * The owner's machine-wide `fs-*` browser is never offered to an operator
 * (spec §3.2, §8 Lead decision 8).
 */
import * as Dialog from '@radix-ui/react-dialog';
import { DialogContent } from '@/ui/DialogContent';
import { ChevronLeft, File, Folder, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { operatorCall, onOperatorEvent } from '@/sync/operatorTransport';
import { operatorErrorCode, operatorErrorCopy } from './operatorCopy';
import { joinWithin, parentWithin } from './operatorFilesPath';
import './operatorFiles.css';

type Entry = { name: string; type: 'file' | 'directory' | 'other'; size?: number };

const MAX_PREVIEW_BYTES = 512 * 1024;

function decodeText(b64: string): string | null {
    try {
        const bin = atob(b64);
        if (bin.length > MAX_PREVIEW_BYTES) return null;
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (bytes.includes(0)) return null; // binary
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return null;
    }
}

export function OperatorFilesDialog({ sessionId, root, open, onOpenChange }: { sessionId: string; root: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { t } = useTranslation();
    const [dir, setDir] = useState(root);
    const [entries, setEntries] = useState<Entry[] | null>(null);
    const [file, setFile] = useState<{ path: string; text: string | null } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (path: string) => {
        setError(null); setEntries(null);
        try {
            const res = await operatorCall<{ success: boolean; entries?: Entry[]; error?: string }>(sessionId, 'listDirectory', { path });
            if (!res?.success) throw new Error(res?.error ?? 'list failed');
            const sorted = [...(res.entries ?? [])].sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
            setEntries(sorted);
            setDir(path);
        } catch (e) {
            setError(operatorErrorCopy(t, operatorErrorCode(e)));
            setEntries([]);
        }
    }, [sessionId, t]);

    useEffect(() => { if (open) { setFile(null); void load(root); } }, [open, root, load]);
    useEffect(() => onOperatorEvent('revoked', (e) => {
        if (e.sessionId !== sessionId) return;
        setEntries(null); setFile(null);
        onOpenChange(false);
    }), [sessionId, onOpenChange]);

    const openFile = async (path: string) => {
        setError(null);
        try {
            const res = await operatorCall<{ success: boolean; content?: string; error?: string }>(sessionId, 'readFile', { path });
            if (!res?.success || typeof res.content !== 'string') throw new Error(res?.error ?? 'read failed');
            setFile({ path, text: decodeText(res.content) });
        } catch (e) {
            setError(operatorErrorCopy(t, operatorErrorCode(e)));
        }
    };

    const up = parentWithin(root, dir);
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
                <DialogContent className="vh-dialog so-dialog opf" aria-describedby={undefined}>
                    <div className="vh-dialog-head so-head">
                        <div>
                            <Dialog.Title className="vh-dialog-title so-title">{t('session.chat.files')}</Dialog.Title>
                            <p className="so-description">{t('share.operator.filesScope')}</p>
                        </div>
                        <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                    </div>
                    <div className="opf-path">
                        {(file || up !== null) && (
                            <button type="button" className="opf-up" aria-label={t('common.back')} onClick={() => file ? setFile(null) : up !== null && void load(up)}>
                                <ChevronLeft size={16} />
                            </button>
                        )}
                        <span className="opf-path-text" title={file?.path ?? dir}>{file?.path ?? dir}</span>
                    </div>
                    {error && <p className="shd-error" role="alert">{error}</p>}
                    {file ? (
                        file.text === null
                            ? <p className="opf-empty">—</p>
                            : <pre className="opf-preview">{file.text}</pre>
                    ) : (
                        <ul className="opf-list">
                            {entries === null && <li className="opf-empty">{t('common.loading')}</li>}
                            {entries?.map((entry) => (
                                <li key={entry.name}>
                                    <button type="button" className="opf-row" onClick={() => {
                                        const next = joinWithin(root, dir, entry.name);
                                        if (!next) return;
                                        if (entry.type === 'directory') void load(next);
                                        else if (entry.type === 'file') void openFile(next);
                                    }}>
                                        {entry.type === 'directory' ? <Folder size={14} aria-hidden /> : <File size={14} aria-hidden />}
                                        <span className="opf-name">{entry.name}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </DialogContent>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
