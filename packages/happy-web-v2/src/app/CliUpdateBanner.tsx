import { ArrowRight, PackageOpen, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { visibleCliUpdateNotices } from './cliUpdatePolicy';
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
  const lead = notices[0];
  if (!lead) return null;

  const required = lead.severity === 'required';
  const dismissible = !required && lead.delivery !== 'attention';
  const automatic = lead.delivery === 'automatic';
  const pending = lead.delivery === 'pending';
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
          <button type="button" onClick={() => navigate(`/machine/${encodeURIComponent(lead.machineId)}`)}>{t('cliUpdate.details')}<ArrowRight size={15} /></button>
        </div>
      </div>
    </aside>
  );
}
