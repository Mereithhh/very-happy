/**
 * SubagentPanel — the sub-agent drawer (B-317). Lives in the session aside,
 * the same slot (and therefore the same mobile full-screen overlay + scrim) as
 * FilesPanel and BtwPanel.
 *
 * Why a drawer and not an inline disclosure: a sub-agent is a whole second
 * conversation. Its prompt and its 10–50 line tool log were being rendered
 * inside the transcript, between two of the main agent's paragraphs, which is
 * what made the card read as broken. Moving it out gives it room to scroll and
 * leaves the transcript a one-line pointer.
 */
import { useMemo } from 'react';
import { Bot, X } from 'lucide-react';
import { useMessage, useSessionMessages } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { currentTurnMessages } from '@/sync/agentLiveness';
import { SubagentDetail } from './SubagentDetail';
import { buildSubagentSummary } from './subagentSummary';
import { userAbortedAt } from './subagentAbort';
import './subagent.css';

export function SubagentPanel({
    sessionId,
    messageId,
    onClose,
}: {
    sessionId: string;
    messageId: string;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const message = useMessage(sessionId, messageId);
    // The drawer must tell the same story as the row it was opened from, so it
    // derives the abort marker the same way ChatList does (B-317). Storage
    // keeps messages newest-first; every helper here wants ascending.
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const abortedAt = useMemo(
        () => userAbortedAt(currentTurnMessages([...messages].reverse())),
        [messages],
    );
    const card = message?.kind === 'tool-call' ? message : null;
    const title = card ? buildSubagentSummary(card).title : null;

    return (
        <div className="sap">
            <div className="sap-head">
                <Bot size={14} className="sap-head-icon" aria-hidden />
                <span className="sap-title">{title ?? t('session.chat.subagentPanelTitle')}</span>
                <button type="button" className="sap-icon" onClick={onClose} aria-label={t('common.close')}>
                    <X size={16} />
                </button>
            </div>
            <div className="sap-body">
                {card
                    ? <SubagentDetail message={card} abortedAt={abortedAt} />
                    // "Not here" and "not here YET" are different answers. A
                    // reload with `?panel=agent&sub=…` in the URL mounts this
                    // before the transcript has been fetched; claiming the card
                    // is gone during that window is simply wrong.
                    : !isLoaded
                        ? <div className="sa-empty">{t('session.chat.loadingMessages')}</div>
                        : <div className="sa-empty">{t('session.chat.subagentGone')}</div>}
            </div>
        </div>
    );
}
