import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Clipboard, PackageOpen, Sparkles, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllMachines } from '@/sync/storage';
import { useToast } from '@/ui';
import { cliUpdateInstallCommand } from './cliUpdatePolicy';
import {
  CHANGELOG_STORAGE_KEY,
  CURRENT_CHANGELOG,
  changelogCliNotices,
  changelogSeenValue,
  shouldShowChangelog,
} from './changelogRelease';
import './changelogNotice.css';

function readSeen(): string | null {
  try { return localStorage.getItem(CHANGELOG_STORAGE_KEY); } catch { return null; }
}

function writeSeen(): void {
  try { localStorage.setItem(CHANGELOG_STORAGE_KEY, changelogSeenValue()); } catch { /* private mode */ }
}

export function ChangelogNotice() {
  const { t } = useTranslation();
  const toast = useToast();
  const machines = useAllMachines({ includeOffline: true });
  const cliNotices = useMemo(() => changelogCliNotices(machines), [machines]);
  const cliCommand = CURRENT_CHANGELOG.cliVersion
    ? cliUpdateInstallCommand(CURRENT_CHANGELOG.cliVersion)
    : null;
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(shouldShowChangelog(readSeen())), []);

  const dismiss = () => {
    writeSeen();
    setOpen(false);
  };
  const copyCli = async () => {
    if (!cliCommand) return;
    try {
      await navigator.clipboard.writeText(cliCommand);
      toast.success(t('changelog.commandCopied'));
    } catch {
      toast.error(t('changelog.commandCopyFailed'));
    }
  };
  const changelogHref = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/changelog`;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => next ? setOpen(true) : dismiss()}>
      <Dialog.Portal>
        <Dialog.Overlay className="wn-backdrop" />
        <Dialog.Content className="wn-card" aria-describedby="wn-description">
          <Dialog.Close asChild>
            <button type="button" className="wn-close" aria-label={t('common.close')}>
              <X size={18} />
            </button>
          </Dialog.Close>
          <div className="wn-eyebrow"><Sparkles size={14} />{t('changelog.eyebrow')}</div>
          <Dialog.Title>{t(CURRENT_CHANGELOG.titleKey)}</Dialog.Title>
          <Dialog.Description id="wn-description" className="wn-intro">
            {t(CURRENT_CHANGELOG.summaryKey)}
          </Dialog.Description>
          <ul className="wn-list">
            {CURRENT_CHANGELOG.itemKeys.map((key) => (
              <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
            ))}
          </ul>
          {cliNotices.length > 0 && cliCommand && CURRENT_CHANGELOG.cliVersion && (
            <div className="wn-cli">
              <PackageOpen size={18} aria-hidden="true" />
              <div>
                <strong>{t('changelog.cliTitle')}</strong>
                <p>{t('changelog.cliBody', {
                  count: cliNotices.length,
                  version: CURRENT_CHANGELOG.cliVersion,
                  machines: cliNotices.map((notice) => notice.machineName).join(', '),
                })}</p>
                <button type="button" onClick={() => void copyCli()}>
                  <code>{cliCommand}</code>
                  <Clipboard size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
          <a className="wn-more" href={changelogHref} onClick={writeSeen}>{t('changelog.viewAll')}</a>
          <Dialog.Close asChild>
            <button type="button" className="wn-done">{t('changelog.done')}</button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
