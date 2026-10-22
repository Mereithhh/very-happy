/**
 * B-510: "needs you" strip — an agent called `request_human` in this session.
 * Shows the reason and, when it pointed at a machine web panel, opens it.
 * Same strip family as AutomationAttentionBanner (mirror.css, --danger =
 * needs a decision; no --accent).
 *
 * B-766 W-2: where the server has the 汇报板, the strip reads the session's
 * open `blocked` item (request_human is an item now) — it survives a refresh,
 * has no 30-minute TTL, and closes when the item does. Decisions and to-dos
 * live on the board, so their `attention` events no longer raise this strip
 * (one signal per thing). Without a board (flag off / older server) it keeps
 * the B-510 ephemeral behaviour.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hand, MonitorPlay, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { isAttentionFresh, useHumanAttention } from '@/sync/humanAttention';
import { useBoardItems } from '@/sync/attentionStore';
import { blockedBanner } from './board/boardModel';
import './mirror.css';

export function HumanAttentionBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const attention = useHumanAttention((s) => s.bySession[sessionId]);
    const dismiss = useHumanAttention((s) => s.dismiss);
    const items = useBoardItems(sessionId);
    const [dismissedItem, setDismissedItem] = useState<string | null>(null);
    const fromItem = items ? blockedBanner(items, sessionId) : null;
    const shown = items
        ? (fromItem && fromItem.id !== dismissedItem ? fromItem : null)
        : (isAttentionFresh(attention, Date.now()) ? { id: null, reason: attention.reason, url: attention.url } : null);
    if (!shown) return null;
    return (
        <div className="mrb" data-testid="human-attention-banner" data-kind="human-attention">
            <div className="mrb-note mrb-note--decision" role="status">
                <Hand size={13} />
                <span className="mrb-note-text">
                    <strong>{t('webPanels.attentionTitle')}</strong>
                    <span className="mrb-note-sep" aria-hidden> · </span>
                    <span>{shown.reason}</span>
                </span>
                {shown.url && (
                    <button type="button" className="mrb-term-btn mono" onClick={() => navigate(shown.url!)}>
                        <MonitorPlay size={13} />
                        <span>{t('webPanels.attentionOpenPanel')}</span>
                    </button>
                )}
                <button type="button" className="mrb-dismiss" onClick={() => (shown.id ? setDismissedItem(shown.id) : dismiss(sessionId))}
                    aria-label={t('webPanels.attentionDismiss') as string} title={t('webPanels.attentionDismiss') as string}>
                    <X size={13} />
                </button>
            </div>
        </div>
    );
}
