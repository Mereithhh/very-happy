/**
 * B-850c (wire v2): the wrapper's account events in the transcript —
 * `agent-profile-unavailable` (turn refused), `agent-profile-auth-failed`
 * (401 mid-run) and `agent-profile-warning` (~/.claude/settings.json overrides
 * the account). The first two offer 重新登录 / 换个账号; the warning opens the
 * machine config. Words come from the session's account, not the CLI's English line.
 */
import { useState } from 'react';
import { AlertTriangle, LogIn, Repeat, Settings2 } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useMachine, useSession } from '@/sync/storage';
import { accountKindTag } from '@/sync/agentProfiles';
import { SwitchAccountDialog } from './AccountUnavailableBanner';
import { useSessionAccount, type AccountEventKind } from './sessionAccount';

export function AccountEventBlock({ sessionId, kind, message }: { sessionId: string; kind: AccountEventKind; message: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const machine = useMachine(session?.metadata?.machineId ?? '');
    const { facts, openSettings, openMachine } = useSessionAccount(sessionId, machine);
    const [switching, setSwitching] = useState(false);
    const profile = facts?.profile;
    const label = profile?.label ?? '';
    const text = !profile ? message
        : kind === 'warning' ? t('accounts.eventWarning', { label })
        : kind === 'auth-failed' ? t('accounts.eventAuthFailed', { label })
        : t('accounts.eventUnavailable', { label });
    const subscription = !!profile && accountKindTag(profile.kind) === 'subscription';
    return (
        <div className="msg msg--event" data-testid="account-event" data-kind={kind}>
            <span className={`msg-event-line ${kind === 'warning' ? 'msg-event-line--warn' : 'msg-event-line--error'}`}><AlertTriangle size={13} />{text}</span>
            {facts && <span className="msg-event-restart">
                {kind === 'warning'
                    ? <button type="button" className="msg-event-restart-btn" onClick={() => openSettings()}><Settings2 size={12} /> {t('accounts.localConfigGroup')}</button>
                    : <>
                        {subscription && <button type="button" className="msg-event-restart-btn" onClick={() => openSettings(profile!.id)}><LogIn size={12} /> {t('accounts.relogin')}</button>}
                        <button type="button" className="msg-event-restart-btn" onClick={() => setSwitching(true)}><Repeat size={12} /> {t('accounts.bannerSwitch')}</button>
                    </>}
            </span>}
            {switching && facts && <SwitchAccountDialog sessionId={sessionId} facts={facts} onClose={() => setSwitching(false)} openSettings={openSettings} openMachine={openMachine} />}
        </div>
    );
}
