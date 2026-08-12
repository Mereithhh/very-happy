/**
 * FsFileViewer — renders one machine file fetched via the fs-read machine RPC.
 * Text goes through CodeView (shiki highlight + copy); binary files get a
 * type/size placeholder, except browser-renderable images within the read cap
 * which render as an inline data-URI preview. The head shows the full path
 * with a copy-path button.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { machineFsRead, type FsFailure } from '@/sync/fsOps';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { CopyButton } from '@/ui/CopyButton';
import { CodeView } from '../session/CodeView';
import { langForPath } from '../session/langForPath';
import { formatFsSize, imageMimeOf } from './fsBrowseModel';
import { fsFailureText } from './fsFailureText';

type ViewerData = {
    path: string;
    size: number;
    binary: boolean;
    truncated: boolean;
    text: string | null;
    /** data: URI for the inline image preview (binary + image ext + complete). */
    imageSrc: string | null;
};

function decodeUtf8(b64: string): string {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function FsFileViewer({ machineId, path, onClose }: {
    machineId: string;
    path: string;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [data, setData] = useState<ViewerData | null>(null);
    const [failure, setFailure] = useState<FsFailure | null>(null);

    useEffect(() => {
        let cancelled = false;
        setData(null);
        setFailure(null);
        const mime = imageMimeOf(path);
        (async () => {
            // Ask for binary bytes only when we could actually preview them.
            const res = await machineFsRead(machineId, path, { allowBinary: mime != null });
            if (cancelled) return;
            if (!res.ok) {
                setFailure(res);
                return;
            }
            // Image preview only for COMPLETE reads (≤ the 512KB cap) — a
            // truncated image payload would just render as a broken picture.
            const imageSrc =
                res.binary && mime && res.content && !res.truncated
                    ? `data:${mime};base64,${res.content}`
                    : null;
            setData({
                path: res.path,
                size: res.size,
                binary: res.binary,
                truncated: res.truncated,
                text: !res.binary && res.content != null ? decodeUtf8(res.content) : null,
                imageSrc,
            });
        })();
        return () => {
            cancelled = true;
        };
    }, [machineId, path]);

    return (
        <div className="fsb-viewer">
            <div className="fsb-viewer-head">
                <span className="fsb-viewer-path" title={path}>{path}</span>
                <CopyButton text={path} label={t('fsBrowser.copyPath')} className="fsb-iconbtn" size={14} />
                <button type="button" className="fsb-iconbtn" onClick={onClose} aria-label={t('common.back')} title={t('common.back')}>
                    <X size={15} />
                </button>
            </div>
            {failure ? (
                <div className="fsb-center">{fsFailureText(t, failure)}</div>
            ) : !data ? (
                <div className="fsb-center"><Spinner size={16} /></div>
            ) : data.imageSrc ? (
                <div className="fsb-viewer-body fsb-viewer-body--img">
                    <img className="fsb-img" src={data.imageSrc} alt={data.path} />
                    <span className="fsb-caption mono">{formatFsSize(data.size)}</span>
                </div>
            ) : data.binary ? (
                <div className="fsb-center">
                    {t('fsBrowser.binaryFile', { size: formatFsSize(data.size) })}
                </div>
            ) : (
                <div className="fsb-viewer-body">
                    {data.truncated && (
                        <div className="fsb-notice">
                            {t('fsBrowser.fileTruncated', { size: formatFsSize(data.size) })}
                        </div>
                    )}
                    <CodeView code={data.text ?? ''} lang={langForPath(data.path)} />
                </div>
            )}
        </div>
    );
}
