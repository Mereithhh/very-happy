/**
 * B-296 `/machine/connect` — the same guide FirstRunScreen shows, reachable
 * once the account already has machines (settings → machines, and every
 * "no machine available" dead end in the new-session / new-terminal /
 * attach-tmux / import dialogs).
 */
import { ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { BackButton } from '@/app/BackButton';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { ConnectMachineGuide } from './ConnectMachineGuide';
import './firstRun.css';

export function ConnectMachineScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <main className="fr-page">
      <section className="fr-hero">
        <div className="fr-hero-back"><BackButton /></div>
        <div className="eyebrow">{t('connectMachine.eyebrow')}</div>
        <h1>{t('connectMachine.title')}</h1>
        <p>{t('connectMachine.intro')}</p>
      </section>

      <ConnectMachineGuide />

      <div className="fr-note">{t('onboarding.trustNote')}</div>
      <div className="fr-actions">
        <Button variant="secondary" rightIcon={<ExternalLink size={14} />} onClick={() => navigate('/docs/quickstart')}>
          {t('onboarding.readQuickStart')}
        </Button>
        <Button variant="secondary" onClick={() => navigate('/docs/troubleshooting')}>{t('onboarding.troubleshooting')}</Button>
      </div>
    </main>
  );
}
