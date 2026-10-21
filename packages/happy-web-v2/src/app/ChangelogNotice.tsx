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
import { BRAND } from './brand';
import { ChangelogHighlights } from './ChangelogHighlights';
import { OVERLAY_PRIORITY, useOverlayTurn } from './overlayQueue';

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
  // B-697: a dialog the person opened (e.g. a `?task=` deep link) goes first;
  // the notes wait, unread, and show once it closes.
  const turn = useOverlayTurn(open, OVERLAY_PRIORITY.notice);

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
  const hasHighlights = releases.some((release) => (release.highlights?.length ?? 0) > 0);

  return (
    <Dialog.Root open={open && turn} onOpenChange={(next) => next ? setOpen(true) : closeWithoutReading()}>
      <Dialog.Portal>
        <Dialog.Overlay className="wn-backdrop" />
        <Dialog.Content className="wn-card" aria-describedby="wn-description" data-multiple={multiple || undefined} data-featured={head?.featured || undefined} data-highlights={hasHighlights || undefined}>
          <button type="button" className="wn-close" aria-label={t('common.close')} onClick={acknowledge}>
            <X size={18} />
          </button>
          {head?.featured && <div className="wn-brand"><img src="/icon-192.png" width={44} height={44} alt=""/><span>{BRAND.name}<span>{head.featuredTaglineKey ? t(head.featuredTaglineKey) : lang.startsWith('zh') ? '全新工作台 · 重大界面更新' : 'A new workspace · Major UI update'}</span></span></div>}
          <div className="wn-eyebrow"><Sparkles size={14} />{t('changelog.eyebrow')}</div>
          {head && (multiple ? (
            <>
              <Dialog.Title>{head.featured ? t(head.titleKey) : t('changelog.pendingTitle', { count: releases.length })}</Dialog.Title>
              <Dialog.Description id="wn-description" className="wn-intro">
                {head.featured ? t(head.summaryKey) : releases[releases.length - 1].date === head.date
                  ? t('changelog.pendingSummarySameDay', { date: formatDate(head.date) })
                  : t('changelog.pendingSummary', { from: formatDate(releases[releases.length - 1].date), to: formatDate(head.date) })}
              </Dialog.Description>
              <div className="wn-releases">
                {releases.map((release, index) => {
                  // A featured head already owns the dialog title and intro; repeating them here reads as a glitch.
                  const titled = !(index === 0 && release.featured);
                  return (
                  <section className="wn-release" key={release.id} aria-labelledby={titled ? `wn-release-${release.id}` : undefined} aria-label={titled ? undefined : t(release.titleKey)}>
                    <div className="wn-release-meta">
                      <time dateTime={release.date}>{formatDate(release.date)}</time>
                      {release.cliVersion && <span>CLI v{release.cliVersion}</span>}
                    </div>
                    {titled && <h3 id={`wn-release-${release.id}`}>{t(release.titleKey)}</h3>}
                    {titled && <p>{t(release.summaryKey)}</p>}
                    {release.highlights?.length ? (
                      <ChangelogHighlights release={release} onNavigate={acknowledge} headingLevel={4} />
                    ) : (
                      <ul className="wn-list">
                        {release.itemKeys.map((key) => (
                          <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
                        ))}
                      </ul>
                    )}
                  </section>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <Dialog.Title>{t(head.titleKey)}</Dialog.Title>
              <Dialog.Description id="wn-description" className="wn-intro">
                {t(head.summaryKey)}
              </Dialog.Description>
              {head.highlights?.length ? (
                <ChangelogHighlights release={head} onNavigate={acknowledge} />
              ) : (
                <ul className="wn-list">
                  {head.itemKeys.map((key) => (
                    <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
                  ))}
                </ul>
              )}
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
          {head?.featured && hasHighlights && <a className="wn-more is-full" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/whats-new`} onClick={writeSeen}>{t('changelog.fullPage')}</a>}
          <a className="wn-more" href={changelogHref} onClick={writeSeen}>{t('changelog.viewAll')}</a>
          <button type="button" className="wn-done" onClick={acknowledge}>{t('changelog.done')}</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
