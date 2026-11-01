/**
 * B-850c (design F6, Q3): the wrapper reports `metadata.agentProfile.status =
 * 'unavailable'` and refuses turns — it never falls back to the machine login.
 * Say why and offer the fix: 「重新登录」 (subscription) / 「修 key」 (API), and
 * 「换个账号」 (bind another one; the session restarts in place). Same strip as
 * ModelSupportBanner (.mrb, --warn-dim / --danger, never --accent).
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Check, KeyRound, LogIn, Repeat, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { accountKindTag } from '@/sync/agentProfiles';
import { unavailableReasonKey } from '@/components/accounts/accountText';
import { MACHINE_LOGIN_KEY, buildAccountSection, switchSessionAccount, useSessionAccount, type SessionAccountFacts } from './sessionAccount';
import './mirror.css';
import '@/screens/session/sessionOptionsDialog.css';
import '@/components/accounts/accounts.css';

export function AccountUnavailableBanner({ sessionId, machine }: { sessionId: string; machine: Parameters<typeof useSessionAccount>[1] }) {
    const { t } = useTranslation();
    const { facts, openSettings, openMachine } = useSessionAccount(sessionId, machine);
    const [switching, setSwitching] = useState(false);
    const profile = facts?.profile;
    if (!facts || !profile || profile.status !== 'unavailable') return null;
    const reason = unavailableReasonKey(profile.reason);
    const args = { label: profile.label, machine: facts.machineName };
    const text = reason === 'expired' ? t('accounts.bannerExpired', args)
        : reason === 'invalid' ? t('accounts.bannerInvalid', args)
        : reason === 'missing-secret' ? t('accounts.bannerMissingSecret', args)
        : t('accounts.bannerMissing', args);
    const subscription = accountKindTag(profile.kind) === 'subscription';
    const exists = reason !== 'missing';
    return <div className="mrb" data-testid="account-unavailable-banner" data-kind="model-support" data-reason={reason}>
        <div className="mrb-note mrb-note--failed" role="status">
            <ShieldAlert size={13} />
            <span className="mrb-note-text">{text}</span>
            <span className="mrb-note-actions">
                {exists && (subscription
                    ? <button type="button" className="mrb-term-btn" data-testid="account-banner-relogin" onClick={() => openSettings(profile.id)}><LogIn size={13} /><span>{t('accounts.relogin')}</span></button>
                    : <button type="button" className="mrb-term-btn" onClick={() => openSettings()}><KeyRound size={13} /><span>{t('accounts.bannerFixKey')}</span></button>)}
                <button type="button" className="mrb-term-btn" data-testid="account-banner-switch" onClick={() => setSwitching(true)}><Repeat size={13} /><span>{t('accounts.bannerSwitch')}</span></button>
            </span>
        </div>
        {switching && <SwitchAccountDialog sessionId={sessionId} facts={facts} onClose={() => setSwitching(false)} openSettings={openSettings} openMachine={openMachine} />}
    </div>;
}

function SwitchAccountDialog({ sessionId, facts, onClose, openSettings, openMachine }: {
    sessionId: string;
    facts: SessionAccountFacts;
    onClose: () => void;
    openSettings: (relogin?: string) => void;
    openMachine: () => void;
}) {
    const { t } = useTranslation();
    const section = buildAccountSection(facts, t, { openSettings, openMachine });
    const choose = async (key: string) => {
        const target = key === MACHINE_LOGIN_KEY ? null : facts.state?.accounts.find((a) => a.id === key);
        if (target === undefined) return;
        onClose();
        // An unavailable account runs no turns, so there is none to interrupt.
        await switchSessionAccount({ sessionId, facts, target, working: false }, t);
    };
    return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
        <Dialog.Portal>
            <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
            <Dialog.Content className="vh-dialog so-dialog acc-dialog" aria-describedby="acc-switch-desc" data-testid="switch-account-dialog">
                <div className="vh-dialog-head so-head">
                    <div>
                        <Dialog.Title className="vh-dialog-title so-title">{t('accounts.switchDialogTitle')}</Dialog.Title>
                        <p id="acc-switch-desc" className="so-description">{t('accounts.switchDialogDescription')}</p>
                    </div>
                    <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')}><X size={18} /></Dialog.Close>
                </div>
                <div className="so-fields me-models me-accounts" role="radiogroup" aria-label={t('accounts.sectionLabel')}>
                    {section.rows.map((row) => {
                        const selected = row.key === section.value;
                        const off = !section.switchable || !!row.disabled || selected;
                        return <button key={row.key} type="button" role="radio" aria-checked={selected} aria-disabled={off || undefined} data-account-key={row.key}
                            className={`me-model${selected ? ' me-model--on' : ''}${off && !selected ? ' me-model--off' : ''}`}
                            onClick={off ? undefined : () => void choose(row.key)}>
                            <span className="me-model-text">
                                <span className="me-model-name">{row.name}{row.tag && <span className="me-account-tag"> · {row.tag}</span>}</span>
                                {row.status && <span className="me-model-desc me-account-status" data-tone={row.status.tone}>{row.status.text}</span>}
                            </span>
                            {selected && <Check size={15} className="me-model-check" aria-hidden="true" />}
                        </button>;
                    })}
                    {section.note && <p className="mce-note">{section.note.text}</p>}
                </div>
            </Dialog.Content>
        </Dialog.Portal>
    </Dialog.Root>;
}
