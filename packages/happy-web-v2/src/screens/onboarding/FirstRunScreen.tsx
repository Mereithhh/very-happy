import { Check, Copy, ExternalLink, LogIn, PackagePlus, Power } from 'lucide-react';
import { useState } from 'react';
import { Button, useToast } from '@/ui';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { getServerUrl } from '@/sync/serverConfig';
import { firstMachineBootstrapCommand, firstMachineCommands } from './firstMachineCommands';
import './firstRun.css';

const INSTALL_COMMAND = 'npm install -g very-happy-cli';

function Command({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const { t } = useTranslation();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('onboarding.copyFailed'));
    }
  }
  return (
    <div className="fr-command">
      <code>{value}</code>
      <button type="button" onClick={copy} aria-label={`Copy ${value}`}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

function ShellCommands({ posix, powershell }: { posix: string; powershell?: string }) {
  if (!powershell) return <Command value={posix} />;
  return <div className="fr-command-set">
    <span>macOS / Linux</span><Command value={posix} />
    <span>Windows PowerShell</span><Command value={powershell} />
  </div>;
}

export function FirstRunScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const serverUrl = getServerUrl();
  const commands = firstMachineCommands(serverUrl, window.location.origin);
  const bootstrapCommand = firstMachineBootstrapCommand(serverUrl, window.location.origin);
  return (
    <main className="fr-page">
      <section className="fr-hero">
        <div className="eyebrow">{t('onboarding.eyebrow')}</div>
        <h1>{t('onboarding.title')}</h1>
        <p>{t('onboarding.intro')}</p>
      </section>

      <section className="fr-fast-path" aria-labelledby="fr-fast-path-title">
        <div className="eyebrow">{t('onboarding.fastPathEyebrow')}</div>
        <h2 id="fr-fast-path-title">{t('onboarding.fastPathTitle')}</h2>
        <p>{t('onboarding.fastPathDescription')}</p>
        <Command value={bootstrapCommand} />
        <p className="fr-runtime-help">
          {t('onboarding.runtimeHelpBefore')}{' '}
          <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">{t('onboarding.runtimeHelpLink')}</a>
          {' '}{t('onboarding.runtimeHelpAfter')}
        </p>
      </section>

      <ol className="fr-steps">
        <li>
          <div className="fr-step-icon"><PackagePlus size={19} /></div>
          <div><h2>{t('onboarding.installTitle')}</h2><p>{t('onboarding.installDescription')}</p><Command value={INSTALL_COMMAND} /></div>
        </li>
        <li>
          <div className="fr-step-icon"><LogIn size={19} /></div>
          <div><h2>{t('onboarding.linkTitle')}</h2><p>{t('onboarding.linkDescription')}</p><ShellCommands posix={commands.login} powershell={commands.loginPowerShell} /></div>
        </li>
        <li>
          <div className="fr-step-icon"><Power size={19} /></div>
          <div><h2>{t('onboarding.daemonTitle')}</h2><p>{t('onboarding.daemonDescription')}</p><ShellCommands posix={commands.daemon} powershell={commands.daemonPowerShell} /></div>
        </li>
      </ol>

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
