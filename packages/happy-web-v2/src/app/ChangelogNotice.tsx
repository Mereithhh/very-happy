import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Clipboard, PackageOpen, Sparkles, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllMachines } from '@/sync/storage';
import { useToast } from '@/ui';
import { cliUpdateInstallCommand } from './cliUpdatePolicy';
import {
  CHANGELOG_STORAGE_KEY,
  type ChangelogRelease,
  changelogCliNotices,
  changelogCliTarget,
  changelogSeenValue,
  unseenChangelogReleases,
} from './changelogRelease';
import './changelogNotice.css';

function readSeen(): string | null {
  try { return localStorage.getItem(CHANGELOG_STORAGE_KEY); } catch { return null; }
}

function writeSeen(): void {
  try { localStorage.setItem(CHANGELOG_STORAGE_KEY, changelogSeenValue()); } catch { /* private mode */ }
}

const NO_RELEASES: readonly ChangelogRelease[] = [];

export function ChangelogNotice() {
  const { t, lang } = useTranslation();
  const toast = useToast();
  const machines = useAllMachines({ includeOffline: true });
  // Everything shipped since the receipt in localStorage, newest first. Computed
  // once on mount so acknowledging does not collapse the list mid-animation.
  const [releases, setReleases] = useState<readonly ChangelogRelease[]>(NO_RELEASES);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unseen = unseenChangelogReleases(readSeen());
    setReleases(unseen);
    setOpen(unseen.length > 0);
  }, []);

  const cliTarget = useMemo(() => changelogCliTarget(releases), [releases]);
  const cliNotices = useMemo(
    () => (cliTarget ? changelogCliNotices(machines, cliTarget) : []),
    [machines, cliTarget],
  );
  const cliCommand = cliTarget?.cliVersion ? cliUpdateInstallCommand(cliTarget.cliVersion) : null;
  const formatDate = (date: string) => new Intl.DateTimeFormat(lang, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00`));

  // B-315: only a deliberate acknowledgement marks releases read. Esc and a
  // click on the backdrop close the dialog without writing the receipt —
  // previously either one silently marked every release seen, and since the
  // receipt is what suppresses the dialog, one stray Esc meant no viewer ever
  // saw another release note.
  const acknowledge = () => {
    writeSeen();
    setOpen(false);
  };
  const closeWithoutReading = () => setOpen(false);
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
  const multiple = releases.length > 1;
  const head = releases[0];

  return (
    <Dialog.Root open={open} onOpenChange={(next) => next ? setOpen(true) : closeWithoutReading()}>
      <Dialog.Portal>
        <Dialog.Overlay className="wn-backdrop" />
        <Dialog.Content className="wn-card" aria-describedby="wn-description" data-multiple={multiple || undefined}>
          <button type="button" className="wn-close" aria-label={t('common.close')} onClick={acknowledge}>
            <X size={18} />
          </button>
          <div className="wn-eyebrow"><Sparkles size={14} />{t('changelog.eyebrow')}</div>
          {head && (multiple ? (
            <>
              <Dialog.Title>{t('changelog.pendingTitle', { count: releases.length })}</Dialog.Title>
              <Dialog.Description id="wn-description" className="wn-intro">
                {releases[releases.length - 1].date === head.date
                  ? t('changelog.pendingSummarySameDay', { date: formatDate(head.date) })
                  : t('changelog.pendingSummary', { from: formatDate(releases[releases.length - 1].date), to: formatDate(head.date) })}
              </Dialog.Description>
              <div className="wn-releases">
                {releases.map((release) => (
                  <section className="wn-release" key={release.id} aria-labelledby={`wn-release-${release.id}`}>
                    <div className="wn-release-meta">
                      <time dateTime={release.date}>{formatDate(release.date)}</time>
                      {release.cliVersion && <span>CLI v{release.cliVersion}</span>}
                    </div>
                    <h3 id={`wn-release-${release.id}`}>{t(release.titleKey)}</h3>
                    <p>{t(release.summaryKey)}</p>
                    <ul className="wn-list">
                      {release.itemKeys.map((key) => (
                        <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          ) : (
            <>
              <Dialog.Title>{t(head.titleKey)}</Dialog.Title>
              <Dialog.Description id="wn-description" className="wn-intro">
                {t(head.summaryKey)}
              </Dialog.Description>
              <ul className="wn-list">
                {head.itemKeys.map((key) => (
                  <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
                ))}
              </ul>
            </>
          ))}
          {cliNotices.length > 0 && cliCommand && cliTarget?.cliVersion && (
            <div className="wn-cli">
              <PackageOpen size={18} aria-hidden="true" />
              <div>
                <strong>{t('changelog.cliTitle')}</strong>
                <p>{t('changelog.cliBody', {
                  count: cliNotices.length,
                  version: cliTarget.cliVersion,
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
          <button type="button" className="wn-done" onClick={acknowledge}>{t('changelog.done')}</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
