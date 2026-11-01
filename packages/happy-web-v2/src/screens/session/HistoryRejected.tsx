/**
 * B-850c2 (wire v3): 「这个会话的历史无法在新账号上继续，请新开会话」 —
 * 【新开会话】 opens a draft in the same directory on the same account,
 * 【换回原账号】 re-binds what ran before the switch (remembered on this device;
 * otherwise the switch dialog). Banner above the composer + the transcript row.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Plus, Undo2 } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { storage, useSession } from '@/sync/storage';
import type { Message } from '@/sync/typesMessage';
import { resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import { previousAccountFor, switchSessionAccount, useSessionAccount, type SessionAccountFacts } from './sessionAccount';
import { SwitchAccountDialog } from './AccountUnavailableBanner';
import { historyRejectedFor, historyRejectedLabel, newSessionAccountFor } from './historyRejected';
import './mirror.css';

const NO_MESSAGES: Message[] = [];

type Nav = { openSettings: (relogin?: string) => void; openMachine: () => void };

function HistoryRejectedButtons({ sessionId, facts, variant, nav, rejectedLabel }: { sessionId: string; facts: SessionAccountFacts; variant: 'banner' | 'event'; nav: Nav; rejectedLabel: string | null }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const session = useSession(sessionId);
    const [choosing, setChoosing] = useState(false);
    const previous = previousAccountFor(sessionId, facts.profile);
    const previousAccount = previous === null ? null : previous ? facts.state?.accounts.find((a) => a.id === previous.id) : undefined;
    const btn = variant === 'banner' ? 'mrb-term-btn' : 'msg-event-restart-btn';
    const size = variant === 'banner' ? 13 : 12;

    const newSession = async () => {
        const path = (session?.metadata as { path?: string } | null | undefined)?.path;
        if (!path || !facts.machineId) return;
        const { pendingSessions } = await import('@/sync/pendingSessionsRuntime');
        const state = storage.getState();
        const record = pendingSessions.create({
            machineId: facts.machineId,
            path,
            agent: facts.agent as Parameters<typeof pendingSessions.create>[0]['agent'],
            permissionMode: resolveNewSessionPermissionMode(state.settings.agentDefaultOverrides, facts.agent, state.localSettings.newSessionReviewFirst),
            source: 'history-rejected',
            draft: true,
            agentProfileId: newSessionAccountFor(rejectedLabel, facts.state?.accounts ?? [], facts.agent, facts.profile),
        });
        navigate(`/session/${record.pendingId}`);
    };
    const switchBack = () => {
        if (previousAccount === undefined) { setChoosing(true); return; }
        void switchSessionAccount({ sessionId, facts, target: previousAccount, working: false }, t);
    };
    return <>
        <button type="button" className={btn} data-testid="history-rejected-new" onClick={() => void newSession()}><Plus size={size} /><span>{t('accounts.historyNewSession')}</span></button>
        <button type="button" className={btn} data-testid="history-rejected-back" onClick={switchBack}
            title={previousAccount !== undefined ? t('accounts.historySwitchBackTo', { label: previousAccount ? previousAccount.label : t('accounts.machineLogin') }) : undefined}>
            <Undo2 size={size} /><span>{t('accounts.historySwitchBack')}</span>
        </button>
        {choosing && <SwitchAccountDialog sessionId={sessionId} facts={facts} onClose={() => setChoosing(false)} openSettings={nav.openSettings} openMachine={nav.openMachine} />}
    </>;
}

/** Above the composer while the refusal is the latest word for the session's current account. */
export function AccountHistoryRejectedBanner({ sessionId, machine }: { sessionId: string; machine: Parameters<typeof useSessionAccount>[1] }) {
    const { t } = useTranslation();
    const { facts, openSettings, openMachine } = useSessionAccount(sessionId, machine);
    const messages = storage((state) => state.sessionMessages?.[sessionId]?.messages ?? NO_MESSAGES);
    const rejected = facts ? historyRejectedFor(messages, facts.profile) : null;
    if (!facts || !rejected) return null;
    return <div className="mrb" data-testid="account-history-rejected-banner" data-kind="model-support">
        <div className="mrb-note mrb-note--failed" role="status">
            <AlertTriangle size={13} />
            <span className="mrb-note-text">{t('accounts.eventHistoryRejected')}</span>
            <span className="mrb-note-actions"><HistoryRejectedButtons sessionId={sessionId} facts={facts} variant="banner" nav={{ openSettings, openMachine }} rejectedLabel={rejected.label} /></span>
        </div>
    </div>;
}

/** The transcript row for the event. */
export function HistoryRejectedEventRow({ sessionId, facts, message, nav }: { sessionId: string; facts: SessionAccountFacts | null; message: string; nav: Nav }) {
    const { t } = useTranslation();
    return <div className="msg msg--event" data-testid="account-event" data-kind="history-rejected">
        <span className="msg-event-line msg-event-line--error"><AlertTriangle size={13} />{facts ? t('accounts.eventHistoryRejected') : message}</span>
        {facts && <span className="msg-event-restart"><HistoryRejectedButtons sessionId={sessionId} facts={facts} variant="event" nav={nav} rejectedLabel={historyRejectedLabel(message)} /></span>}
    </div>;
}
