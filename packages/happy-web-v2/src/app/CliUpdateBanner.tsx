import { ArrowRight, PackageOpen, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { cliUpdateInstallCommand, visibleCliUpdateNotices } from './cliUpdatePolicy';
import { requestMachineUpdate } from './cliUpdateRecovery';
import './cliUpdateBanner.css';

export function CliUpdateBanner() {
  const machines = useAllMachines({ includeOffline: false });
  const [acknowledged, setAcknowledged] = useLocalSettingMutable('acknowledgedCliVersions');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const notices = useMemo(() => visibleCliUpdateNotices(machines, acknowledged, now), [machines, acknowledged, now]);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [action, setAction] = useState<{ key: string; state: 'sending' | 'accepted' | 'failed' | 'command' | 'copied' | 'copyFailed' } | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (action?.state !== 'accepted') return;
    // The daemon may restart before publishing progress. Allow an explicit,
    // idempotent retry rather than leaving an acknowledged request disabled forever.
    const timer = window.setTimeout(() => setAction(current => current === action ? null : current), 30_000);
    return () => window.clearTimeout(timer);
  }, [action]);
  const lead = notices[0];
  if (!lead) return null;

  const required = lead.severity === 'required';
  const dismissible = !required && lead.delivery !== 'attention';
  const automatic = lead.delivery === 'automatic';
  const pending = lead.delivery === 'pending';
  const key = `${lead.machineId}:${lead.targetVersion}`;
  const actionState = action?.key === key ? action.state : null;
  const supported = machines.find(machine => machine.id === lead.machineId)?.daemonState?.cliUpdate?.manualUpdateSupported === true;
  const command = cliUpdateInstallCommand(lead.targetVersion);
  const showCommand = ['command', 'copied', 'copyFailed'].includes(actionState ?? '');
  const update = async () => {
    if (inFlight.current) return;
    if (!supported) { setAction({ key, state: 'command' }); return; }
    inFlight.current = true;
    setAction({ key, state: 'sending' });
    try {
      await requestMachineUpdate(lead.machineId, lead.targetVersion);
      setAction({ key, state: 'accepted' });
    } catch { setAction({ key, state: 'failed' }); }
    finally { inFlight.current = false; }
  };
  const copy = async () => {
    if (!command) return;
    try { await navigator.clipboard.writeText(command); setAction({ key, state: 'copied' }); }
    catch { setAction({ key, state: 'copyFailed' }); }
  };
  const dismiss = () => {
    if (!dismissible) return;
    const next = { ...acknowledged };
    for (const notice of notices) {
      if (notice.severity === 'available' && notice.delivery !== 'attention' && notice.targetVersion === lead.targetVersion) {
        next[notice.machineId] = notice.targetVersion;
      }
    }
    setAcknowledged(next);
  };

  return (
    <aside className="cli-update" data-severity={lead.severity} data-delivery={lead.delivery} role="region" aria-live="polite" aria-labelledby="cli-update-title" aria-describedby="cli-update-summary">
      {dismissible && (
        <button className="cli-update__close" type="button" onClick={dismiss} aria-label={t('cliUpdate.later')}>
          <X size={17} />
        </button>
      )}
      <PackageOpen className="cli-update__icon" size={22} aria-hidden="true" />
      <div className="cli-update__body">
        <div className="cli-update__eyebrow mono">{required ? t('cliUpdate.requiredEyebrow') : t('cliUpdate.availableEyebrow')}</div>
        <strong id="cli-update-title">{automatic ? t('cliUpdate.automaticTitle') : pending ? t('cliUpdate.pendingTitle') : required ? t('cliUpdate.requiredTitle') : t('cliUpdate.availableTitle')}</strong>
        <p id="cli-update-summary">{t(automatic ? 'cliUpdate.automaticSummary' : pending ? 'cliUpdate.pendingSummary' : 'cliUpdate.summary', { machine: lead.machineName, current: lead.currentVersion, target: lead.automaticVersion ?? lead.targetVersion, count: notices.length })}</p>
        <div className="cli-update__actions">
          {pending && <button type="button" disabled={actionState === 'sending' || actionState === 'accepted'} aria-busy={actionState === 'sending'} onClick={update}>{t(actionState === 'sending' ? 'cliUpdate.requesting' : actionState === 'accepted' ? 'cliUpdate.requested' : supported ? 'cliUpdate.updateNow' : 'cliUpdate.manualUpdate')}</button>}
          <button type="button" onClick={() => navigate(`/machine/${encodeURIComponent(lead.machineId)}`)}>{t('cliUpdate.details')}<ArrowRight size={15} /></button>
        </div>
        {pending && actionState === 'accepted' && <p role="status">{t('cliUpdate.requestAccepted')}</p>}
        {pending && actionState === 'failed' && <p role="alert">{t('cliUpdate.requestFailed')}</p>}
        {pending && showCommand && command && <div className="cli-update__manual">
          <p>{t('cliUpdate.legacyManualHelp')}</p>
          <code className="mono">{command}</code>
          <div className="cli-update__actions"><button type="button" onClick={copy}>{t(actionState === 'copied' ? 'cliUpdate.copied' : 'cliUpdate.copyCommand')}</button></div>
          {actionState === 'copyFailed' && <p role="alert">{t('cliUpdate.copyFailed')}</p>}
        </div>}
      </div>
    </aside>
  );
}
