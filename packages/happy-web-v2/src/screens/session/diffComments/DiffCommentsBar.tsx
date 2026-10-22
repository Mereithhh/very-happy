/**
 * B-554: files-panel top bar — "N comments · Send to agent".
 *
 * Send = compose one message and hand it to the session composer through the
 * existing restoreToComposer channel (B-513), NOT a parallel sendMessage: the
 * composer owns queue/steer/attachments/pending-session/server-queue routing,
 * and the user can add a summary before sending. The composer's own draft is
 * persisted, so clearing the comment drafts right after the hand-off loses
 * nothing on reload.
 */
import { Send, Trash2 } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, toast } from '@/ui';
import { Modal } from '@/modal';
import { restoreToComposer, useHasComposer } from '../composerRestore';
import { composeDiffCommentsMessage } from './diffComments';
import { clearDiffComments, getDiffComments, useDiffComments } from './diffCommentsStore';
import './diffComments.css';

export function DiffCommentsBar({ sessionId, onSent }: { sessionId: string; onSent?: () => void }) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const comments = useDiffComments(sessionId);
    const hasComposer = useHasComposer(sessionId);
    if (comments.length === 0) return null;
    const stale = comments.filter((c) => c.stale).length;

    const send = () => {
        const message = composeDiffCommentsMessage(getDiffComments(sessionId), zh ? 'zh' : 'en');
        if (!message) return;
        if (!restoreToComposer(sessionId, message)) {
            toast.show(zh ? '输入框不可用，批注已保留' : 'No composer here; comments kept', 'error');
            return;
        }
        if (clearDiffComments(sessionId) !== 'ok') {
            toast.show(zh ? '已放入输入框，但批注草稿未能清除，请手动清空' : 'Added to the composer, but the drafts could not be cleared', 'error');
            onSent?.();
            return;
        }
        toast.show(zh ? '已放入输入框，确认后发送' : 'Added to the composer — review and send', 'success');
        onSent?.();
    };
    const clear = async () => {
        const ok = await Modal.confirm(
            zh ? '清空批注' : 'Clear comments',
            zh ? `删除本会话全部 ${comments.length} 条批注？` : comments.length === 1 ? 'Delete the 1 comment in this session?' : `Delete all ${comments.length} comments in this session?`,
            { destructive: true, confirmText: zh ? '清空' : 'Clear' },
        );
        if (ok && clearDiffComments(sessionId) !== 'ok') toast.show(zh ? '清空失败：浏览器存储不可用' : 'Could not clear: browser storage is unavailable', 'error');
    };

    return (
        <div className="dcb" role="region" aria-label={zh ? '代码批注' : 'Review comments'}>
            <span className="dcb-count">
                {zh ? `${comments.length} 条批注` : `${comments.length} comment${comments.length === 1 ? '' : 's'}`}
                {stale > 0 && <span className="dcb-stale">{zh ? ` · ${stale} 条已过期` : ` · ${stale} stale`}</span>}
            </span>
            <span className="dcb-actions">
                <button type="button" className="fp-icon" onClick={() => void clear()} aria-label={zh ? '清空批注' : 'Clear comments'} title={zh ? '清空批注' : 'Clear comments'}><Trash2 size={14}/></button>
                {hasComposer && (
                    <Button size="sm" variant="primary" leftIcon={<Send size={13}/>} onClick={send}>
                        {zh ? '发送给 agent' : 'Send to agent'}
                    </Button>
                )}
            </span>
        </div>
    );
}
