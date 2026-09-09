import { ExternalLink } from 'lucide-react';
import { Button } from '@/ui';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { ConnectMachineGuide } from './ConnectMachineGuide';
import './firstRun.css';
import { TeamGettingStarted } from './TeamGettingStarted';

export function FirstRunScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <main className="fr-page">
      <section className="fr-hero">
        <div className="eyebrow">{t('onboarding.eyebrow')}</div>
        <h1>{t('onboarding.title')}</h1>
        <p>{t('onboarding.intro')}</p>
      </section>

      {/* B-296: the copyable command sequence lives in ConnectMachineGuide so
          this screen and /machine/connect cannot drift apart. */}
      <ConnectMachineGuide />
      <TeamGettingStarted />

      <div className="fr-note">
        {t('onboarding.trustNote')}
      </div>
      <div className="fr-recovery" aria-label={t('onboarding.recoveryTitle')}>
        <h2>{t('onboarding.recoveryTitle')}</h2>
        <ul>
          <li>{t('onboarding.recoverySameServer')}</li>
          <li>{t('onboarding.recoveryDaemon')}</li>
          <li>{t('onboarding.recoveryApproval')}</li>
        </ul>
      </div>
      <div className="fr-actions">
        <Button variant="secondary" rightIcon={<ExternalLink size={14} />} onClick={() => navigate('/docs/quickstart')}>
          {t('onboarding.readQuickStart')}
        </Button>
        <Button variant="secondary" onClick={() => navigate('/docs/troubleshooting')}>{t('onboarding.troubleshooting')}</Button>
      </div>
    </main>
  );
}
