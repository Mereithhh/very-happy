import { Copy, FileSearch } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { openFsPreview } from '@/sync/filePreviewOpen';
import { clipboardPreview } from '@/sync/clipboardHistory';
import { useToolHistory } from '@/sync/useToolHistory';
import { mergeToolHistory, type ToolHistoryEntry, type ToolHistoryScope } from '@/sync/toolHistory';
import './toolHistory.css';

export function ToolHistory({scope, machineId, transcript = []}: {scope: ToolHistoryScope; machineId?: string; transcript?: ToolHistoryEntry[]}) {
    const {entries, failed, retry} = useToolHistory(scope);
    return <ToolHistoryView entries={mergeToolHistory(entries, transcript)} machineId={machineId}
        sessionId={'sessionId' in scope ? scope.sessionId : undefined} failed={failed} onRetry={retry} />;
}

/** Real component also used by the local browser fixture; viewing never writes the clipboard. */
export function ToolHistoryView({entries, machineId, sessionId, failed = false, onRetry}: {
    entries: ToolHistoryEntry[]; machineId?: string; sessionId?: string; failed?: boolean; onRetry?: () => void;
}) {
    const {lang} = useTranslation();
    const zh = lang.startsWith('zh');
    return <details className="tool-history">
        <summary>{zh ? '复制与预览记录' : 'Copy and preview history'}{entries.length > 0 && ` · ${entries.length}`}</summary>
        <div className="tool-history-body">
            <p className="tool-history-note">{zh ? '保留最近调用；记录不代表设备已复制或用户已查看。' : 'Recent calls. A record does not confirm a device copied or viewed it.'}</p>
            {failed && <p role="status">{zh ? '记录加载失败。' : 'Could not load history.'} <button type="button" onClick={onRetry}>{zh ? '重试' : 'Retry'}</button></p>}
            {!entries.length && !failed && <p>{zh ? '暂无调用记录' : 'No recorded calls yet'}</p>}
            <ol className="tool-history-list">{entries.map(entry => <li key={entry.id} className="tool-history-entry">
                <div className="tool-history-row">
                    {entry.kind === 'clipboard' ? <Copy size={14} aria-hidden="true" /> : <FileSearch size={14} aria-hidden="true" />}
                    <span className="tool-history-kind">{entry.kind === 'clipboard' ? (zh ? '复制' : 'Copy') : (zh ? '预览' : 'Preview')}</span>
                    {entry.createdAt > 0 && (<time dateTime={new Date(entry.createdAt).toISOString()} title={new Date(entry.createdAt).toLocaleString(lang)}>{new Date(entry.createdAt).toLocaleString(lang, {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time>)}
                    {entry.state === 'error' && <span>{zh ? '调用失败' : 'Call failed'}</span>}
                    {entry.state === 'running' && <span>{zh ? '调用中' : 'In progress'}</span>}
                    {entry.text !== null && (entry.kind === 'clipboard'
                        ? <CopyButton text={entry.text} showLabel label={entry.truncated ? (zh ? '复制节选' : 'Copy excerpt') : (zh ? '再次复制' : 'Copy again')} />
                        : <button type="button" className="tool-history-open" disabled={!machineId}
                            onClick={() => machineId && openFsPreview({machineId, sessionId, path: entry.text!, mode: entry.mode ?? 'file'})}>{zh ? '打开预览' : 'Open preview'}</button>)}
                </div>
                {entry.text === null ? <p>{zh ? '正文未保存或暂时无法解密' : 'Content was not saved or cannot be decrypted yet'} {onRetry && <button type="button" onClick={onRetry}>{zh ? '重试' : 'Retry'}</button>}</p>
                    : entry.kind === 'preview' ? <p className="tool-history-path">{entry.text}</p>
                    : <details className="tool-history-content"><summary>{clipboardPreview(entry.text, 100) || (zh ? '空文本' : 'Empty text')}</summary><pre>{entry.text}</pre></details>}
                {entry.truncated && <p className="tool-history-note">{zh ? '内容过长，仅保留节选。' : 'Long content: only an excerpt is retained.'}</p>}
            </li>)}</ol>
        </div>
    </details>;
}
