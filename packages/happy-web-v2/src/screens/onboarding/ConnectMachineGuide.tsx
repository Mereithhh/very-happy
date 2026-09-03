/**
 * B-296 —— 「怎么接一台新机器」的唯一事实源。
 *
 * 这套命令原来只长在 FirstRunScreen 里，而 FirstRunScreen 只在
 * `machineCount === 0` 时出现（firstRun.ts）——也就是说**接上第一台之后，
 * 「再接一台」的说明在产品里彻底消失**：新建会话/新建终端/接管 tmux/导入
 * 四个弹窗在没有在线机器时只甩一句「没有可用机器」，机器设置页也只列已有机器。
 * 抽成组件而不是复制一份，是为了让 env 前缀（自托管 origin）与命令顺序
 * 只有一处定义；FirstRunScreen 与 /machine/connect 都渲染它。
 */
import { useState } from 'react';
import { Check, Copy, LogIn, PackagePlus, Power } from 'lucide-react';
import { useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { getServerUrl } from '@/sync/serverConfig';
import { firstMachineBootstrapCommand, firstMachineCommands } from './firstMachineCommands';
import './firstRun.css';

const INSTALL_COMMAND = 'npm install -g very-happy-cli';

export function Command({ value }: { value: string }) {
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

export function ShellCommands({ posix, powershell }: { posix: string; powershell?: string }) {
  if (!powershell) return <Command value={posix} />;
  return <div className="fr-command-set">
    <span>macOS / Linux</span><Command value={posix} />
    <span>Windows PowerShell</span><Command value={powershell} />
  </div>;
}

/**
 * The copyable path to a connected machine: one-shot installer first, then the
 * three explicit steps for anyone who would rather not pipe an installer.
 */
export function ConnectMachineGuide() {
  const { t } = useTranslation();
  const serverUrl = getServerUrl();
  const commands = firstMachineCommands(serverUrl, window.location.origin);
  const bootstrapCommand = firstMachineBootstrapCommand(serverUrl, window.location.origin);
  return (
    <>
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
    </>
  );
}
