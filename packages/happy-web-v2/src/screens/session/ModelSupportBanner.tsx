/**
 * ModelSupportBanner (B-487) — strip under the chat header when this
 * session's wrapper (Claude) or agent CLI (Codex) is too old for the model the
 * user wants. Claude silently falls back to the machine default there; Codex
 * with a ChatGPT sign-in gets a backend 400. Says which, and offers the fix:
 * the existing CLI update request / command (CliUpdateBanner) for Very Happy,
 * the npm command for Codex, and the B-264 restart for either — an upgrade
 * never hot-replaces a running wrapper (AGENTS.md rule 7).
 *
 * Rules are pure in app/modelSupportPolicy.ts. Same strip and token
 * discipline as StaleWrapperBanner: bg ladder + --warn-dim, never --accent.
 */
import { useState } from 'react';
import { Copy, Download, PackageOpen, RotateCcw, X } from 'lucide-react';
import { storage, useLocalSettingMutable, useSession, useSetting } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { restartBrokenSession, useRestartState } from '@/app/sessionRestartAction';
import { cliUpdateInstallCommand } from '@/app/cliUpdatePolicy';
import { requestMachineUpdate } from '@/app/cliUpdateRecovery';
import {
    CODEX_UPDATE_COMMAND,
    isModelSupportNoticeVisible,
    modelSupportHintKey,
    modelSupportNotice,
    type ModelSupportNotice,
} from '@/app/modelSupportPolicy';
import './mirror.css';

type UpdateState = 'sending' | 'accepted' | 'failed' | 'copied' | 'copyFailed' | null;

/** The notice this session would show, honoring a dismissal. Shared with
 *  StaleWrapperBanner so the two never stack for the same restart. */
export function useVisibleModelSupportNotice(sessionId: string): { notice: ModelSupportNotice; hintKey: string } | null {
    const session = useSession(sessionId);
    const machine = storage((s) => {
        const id = session?.metadata?.machineId;
        return id ? s.machines[id] : undefined;
    });
    const overrides = useSetting('agentDefaultOverrides');
    const [dismissedHints] = useLocalSettingMutable('dismissedHints');
    const notice = modelSupportNotice(session, machine as any, overrides);
    if (!notice) return null;
    const hintKey = modelSupportHintKey(sessionId, notice);
    return isModelSupportNoticeVisible(hintKey, dismissedHints) ? { notice, hintKey } : null;
}

function noticeText(notice: ModelSupportNotice, t: ReturnType<typeof useTranslation>['t']): string {
    if (notice.kind === 'claude-opus-55') {
        if (notice.action === 'restart') {
            return t('modelSupport.opusRestart', { sessionVersion: notice.wrapperVersion ?? '?', machineVersion: notice.machineVersion ?? '?' });
        }
        const current = notice.machineVersion ?? notice.wrapperVersion;
        return current
            ? t('modelSupport.opusUpdate', { current, target: notice.targetVersion })
            : t('modelSupport.opusUpdateUnknown', { target: notice.targetVersion });
    }
    if (notice.action === 'restart') return t('modelSupport.codexRestart', { model: notice.model });
    return notice.installedVersion
        ? t('modelSupport.codexUpdate', { model: notice.model, installed: notice.installedVersion, min: notice.minVersion })
        : t('modelSupport.codexUpdateUnknown', { model: notice.model, min: notice.minVersion });
}

export function ModelSupportBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const machineId = session?.metadata?.machineId;
    const machine = storage((s) => (machineId ? s.machines[machineId] : undefined));
    const [dismissedHints, setDismissedHints] = useLocalSettingMutable('dismissedHints');
    const restart = useRestartState(sessionId);
    const [update, setUpdate] = useState<UpdateState>(null);
    const [showCommand, setShowCommand] = useState(false);
    const visible = useVisibleModelSupportNotice(sessionId);
    const busy = restart?.phase === 'spawning' || restart?.phase === 'awaiting-online';
    const failed = restart?.phase === 'failed';
    if (!visible) return null;
    const { notice, hintKey } = visible;

    const needsUpdate = notice.action === 'update';
    const command = notice.kind === 'codex-gpt6'
        ? CODEX_UPDATE_COMMAND
        : cliUpdateInstallCommand(notice.targetVersion);
    const canRequest = notice.kind === 'claude-opus-55' && needsUpdate && !!machineId
        && (machine?.daemonState as { cliUpdate?: { manualUpdateSupported?: unknown } } | undefined)?.cliUpdate?.manualUpdateSupported === true;

    const copy = async () => {
        if (!command) return;
        try { await navigator.clipboard.writeText(command); setUpdate('copied'); }
        catch { setUpdate('copyFailed'); }
    };
    const onUpdate = async () => {
        if (!canRequest) { setShowCommand(true); return; }
        setUpdate('sending');
        try { await requestMachineUpdate(machineId!, (notice as Extract<ModelSupportNotice, { kind: 'claude-opus-55' }>).targetVersion); setUpdate('accepted'); }
        catch { setUpdate('failed'); setShowCommand(true); }
    };

    const status = busy ? t('session.chat.restarting')
        : failed ? (restart?.reason === 'daemon-too-old' ? t('session.chat.restartDaemonTooOld') : t('session.chat.restartFailed'))
        : update === 'accepted' ? t('modelSupport.updateRequested')
        : update === 'failed' ? t('modelSupport.updateFailed')
        : null;

    return (
        <div className="mrb" data-testid="model-support-banner" data-kind="model-support" data-notice={notice.kind} data-action={notice.action}>
            <div className={`mrb-note${failed || update === 'failed' ? ' mrb-note--failed' : ''}`} role="status">
                <PackageOpen size={13} />
                <span className="mrb-note-text">{status ?? noticeText(notice, t)}</span>
                <span className="mrb-note-actions">
                    {needsUpdate && (notice.kind === 'claude-opus-55' ? (
                        <button
                            type="button"
                            className="mrb-term-btn"
                            data-testid="model-support-update"
                            onClick={() => { void onUpdate(); }}
                            disabled={update === 'sending' || update === 'accepted'}
                            aria-busy={update === 'sending'}
                        >
                            {update === 'sending' ? <Spinner size={13} /> : <Download size={13} />}
                            <span>{t(update === 'accepted' ? 'modelSupport.updateRequestedShort' : 'modelSupport.updateCli')}</span>
                        </button>
                    ) : (
                        <button type="button" className="mrb-term-btn" data-testid="model-support-command" onClick={() => setShowCommand((open) => !open)} aria-expanded={showCommand}>
                            <Download size={13} />
                            <span>{t('modelSupport.updateCodex')}</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        className="mrb-term-btn"
                        data-testid="model-support-restart"
                        onClick={() => { void restartBrokenSession(sessionId); }}
                        disabled={busy}
                        aria-busy={busy}
                    >
                        {busy ? <Spinner size={13} /> : <RotateCcw size={13} />}
                        <span>{t(failed ? 'restore.retry' : 'session.chat.restart')}</span>
                    </button>
                    <button
                        type="button"
                        className="mrb-dismiss"
                        data-testid="model-support-dismiss"
                        onClick={() => setDismissedHints({ ...(dismissedHints ?? {}), [hintKey]: Date.now() })}
                        aria-label={t('modelSupport.dismiss')}
                        title={t('modelSupport.dismiss')}
                    >
                        <X size={13} />
                    </button>
                </span>
                {showCommand && command && (
                    <span className="mrb-cmd">
                        <code className="mono">{command}</code>
                        <button type="button" className="mrb-term-btn" data-testid="model-support-copy" onClick={() => { void copy(); }}>
                            <Copy size={13} />
                            <span>{t(update === 'copied' ? 'modelSupport.copied' : 'modelSupport.copyCommand')}</span>
                        </button>
                        {update === 'copyFailed' && <span role="alert">{t('modelSupport.copyFailed')}</span>}
                    </span>
                )}
            </div>
        </div>
    );
}
