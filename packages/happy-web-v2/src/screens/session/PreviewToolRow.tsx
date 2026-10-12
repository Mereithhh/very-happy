/**
 * Chat row for a completed `open_preview` call (B-131 row, B-562 actions).
 *
 * "Open" re-opens the preview; "Download" fetches the file straight from the
 * session's machine. Both use the call's own `path` argument + this session's
 * `metadata.machineId`, so they work while scrolling history and for calls made
 * by CLIs that predate `download` (pure web). Only completed calls get here —
 * a call the CLI refused (credential path gate) is an error row without actions.
 */
import { Download, FileText } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { openFsPreview } from '@/sync/filePreviewOpen';
import { FileDownloadAction } from '../files/FileDownloadAction';
import { FilePathLink } from './FilePathLink';
import { resolveAgainstCwd } from './toolFilePath';
import type { PreviewToolCall } from './previewTools';

export function PreviewToolRow({ call, sessionId, title }: { call: PreviewToolCall; sessionId: string; title?: string }) {
    const { t, lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const session = useSession(sessionId);
    const machineId = session?.metadata?.machineId ?? null;
    const path = resolveAgainstCwd(call.path, session?.metadata?.path);
    const noMachine = machineId ? null : (zh ? '这个会话没有关联机器，无法读取文件。' : 'This session has no machine, so the file cannot be read.');
    return (
        <div className="tg-preview-row" title={title}>
            {call.download ? <Download size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
            <span className="tg-tool-label">{call.download ? (zh ? '发送文件' : 'Sent file') : t('filePreview.title')}</span>
            <FilePathLink path={call.path} sessionId={sessionId} className="tg-preview-path" />
            <span className="tg-preview-actions">
                <button
                    type="button"
                    className="fdl-btn"
                    disabled={!machineId}
                    title={noMachine ?? (zh ? '在预览中打开' : 'Open in preview')}
                    onClick={() => machineId && openFsPreview({ sessionId, machineId, path, mode: 'file' })}
                >
                    {zh ? '打开' : 'Open'}
                </button>
                <FileDownloadAction variant="inline" machineId={machineId} path={path} disabledReason={noMachine} />
            </span>
        </div>
    );
}
