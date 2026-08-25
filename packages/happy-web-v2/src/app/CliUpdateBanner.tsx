import { ArrowRight, Copy, PackageOpen, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { cliUpdateInstallCommand, visibleCliUpdateNotices } from './cliUpdatePolicy';
import './cliUpdateBanner.css';

export function CliUpdateBanner() {
  const machines = useAllMachines({ includeOffline: false });
  const [acknowledged, setAcknowledged] = useLocalSettingMutable('acknowledgedCliVersions');
  const notices = useMemo(() => visibleCliUpdateNotices(machines, acknowledged), [machines, acknowledged]);
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();
  const lead = notices[0];
  if (!lead) return null;

  const required = lead.severity === 'required';
  const command = cliUpdateInstallCommand(lead.targetVersion);
  const dismiss = () => {
    if (required) return;
    const next = { ...acknowledged };
    for (const notice of notices) {
      if (notice.severity === 'available' && notice.targetVersion === lead.targetVersion) {
        next[notice.machineId] = notice.targetVersion;
      }
    }
    setAcknowledged(next);
  };
  const copy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t('cliUpdate.copied'));
    } catch {
      toast.error(t('cliUpdate.copyFailed'));
    }
  };

  return (
    <aside className="cli-update" data-severity={lead.severity} role="region" aria-live="polite" aria-labelledby="cli-update-title" aria-describedby="cli-update-summary">
      {!required && (
        <button className="cli-update__close" type="button" onClick={dismiss} aria-label={t('cliUpdate.later')}>
          <X size={17} />
        </button>
      )}
      <PackageOpen className="cli-update__icon" size={22} aria-hidden="true" />
      <div className="cli-update__body">
        <div className="cli-update__eyebrow mono">{required ? t('cliUpdate.requiredEyebrow') : t('cliUpdate.availableEyebrow')}</div>
        <strong id="cli-update-title">{required ? t('cliUpdate.requiredTitle') : t('cliUpdate.availableTitle')}</strong>
        <p id="cli-update-summary">{t('cliUpdate.summary', { machine: lead.machineName, current: lead.currentVersion, target: lead.targetVersion, count: notices.length })}</p>
        <div className="cli-update__actions">
          <button type="button" onClick={() => void copy()}><Copy size={15} />{t('cliUpdate.copyCommand')}</button>
          <button type="button" onClick={() => navigate('/settings/diagnostics')}>{t('cliUpdate.details')}<ArrowRight size={15} /></button>
          {!required && <button type="button" onClick={dismiss}>{t('cliUpdate.later')}</button>}
        </div>
      </div>
    </aside>
  );
}
