/**
 * B-510: "needs you" strip — an agent called `request_human` in this session.
 * Shows the reason and, when it pointed at a machine web panel, opens it.
 * Same strip family as AutomationAttentionBanner (mirror.css, --danger =
 * needs a decision; no --accent).
 */
import { useNavigate } from 'react-router-dom';
import { Hand, MonitorPlay, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { isAttentionFresh, useHumanAttention } from '@/sync/humanAttention';
import './mirror.css';

export function HumanAttentionBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const attention = useHumanAttention((s) => s.bySession[sessionId]);
    const dismiss = useHumanAttention((s) => s.dismiss);
    if (!isAttentionFresh(attention, Date.now())) return null;
    return (
        <div className="mrb" data-testid="human-attention-banner" data-kind="human-attention">
            <div className="mrb-note mrb-note--decision" role="status">
                <Hand size={13} />
                <span className="mrb-note-text">
                    <strong>{t('webPanels.attentionTitle')}</strong>
                    <span className="mrb-note-sep" aria-hidden> · </span>
                    <span>{attention.reason}</span>
                </span>
                {attention.url && (
                    <button type="button" className="mrb-term-btn mono" onClick={() => navigate(attention.url!)}>
                        <MonitorPlay size={13} />
                        <span>{t('webPanels.attentionOpenPanel')}</span>
                    </button>
                )}
                <button type="button" className="mrb-dismiss" onClick={() => dismiss(sessionId)}
                    aria-label={t('webPanels.attentionDismiss') as string} title={t('webPanels.attentionDismiss') as string}>
                    <X size={13} />
                </button>
            </div>
        </div>
    );
}
