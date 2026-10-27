import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ArrowRight, Check, Clipboard, PackageOpen, Sparkles, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllMachines } from '@/sync/storage';
import { useToast } from '@/ui';
import { cliUpdateInstallCommand } from './cliUpdatePolicy';
import {
  type ChangelogRelease,
  changelogCliNotices,
  changelogCliTarget,
} from './changelogRelease';
import { changelogPages, pageReleaseIds, pendingChangelogReleases, type ChangelogPage } from './changelogPager';
import { acknowledgeAllChangelog, changelogReadState, markChangelogReleasesRead, onChangelogOpenRequest } from './changelogReadStore';
import { enteredByDeepLink } from './entryKind';
import { userHasInteracted } from './afterFirstScreen';
import './changelogNotice.css';
import { BRAND } from './brand';
import { ChangelogHighlights, ChangelogShotImage } from './ChangelogHighlights';
import { MajorBadge } from './MajorBadge';
import { OVERLAY_PRIORITY, useOverlayTurn } from './overlayQueue';

const NO_PAGES: readonly ChangelogPage[] = [];
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * Release notes since the last visit (B-315 receipt, B-320 stacking), one page
 * at a time (B-715, specs/2026-10-whats-new.md §B-715): every major release
 * gets its own page, minor ones share a final page, oldest first. Until the
 * last page the dialog cannot be dismissed — no ✕, Esc and the backdrop do
 * nothing — and each finished page is recorded, so a reload resumes at the
 * first unread one. Deep-link loads never open it on their own (B-697); the
 * sidebar entry (MajorUpdateEntry) opens it on request.
 */
export function ChangelogNotice() {
  const { t, lang } = useTranslation();
  const toast = useToast();
  const machines = useAllMachines({ includeOffline: true });
  // Snapshot when opened: marking a page read must not reshuffle the pager under the reader.
  const [pages, setPages] = useState<readonly ChangelogPage[]>(NO_PAGES);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  // B-697: a dialog the person opened (e.g. a `?task=` deep link) goes first;
  // the notes wait, unread, and show once it closes.
  const turn = useOverlayTurn(open, OVERLAY_PRIORITY.notice);

  const start = useCallback(() => {
    const next = changelogPages(pendingChangelogReleases(changelogReadState()));
    if (next.length === 0) return;
    setPages(next);
    setIndex(0);
    setOpen(true);
  }, []);
  useEffect(() => {
    // B-823: mounted after the first screen now — if the person is already
    // typing or tapping, the notes wait (unread) for the next visit or the
    // sidebar entry instead of grabbing focus mid-sentence.
    if (!enteredByDeepLink() && !userHasInteracted()) start();
  }, [start]);
  useEffect(() => onChangelogOpenRequest(start), [start]);

  const releases = useMemo(() => pages.flatMap((page) => (page.kind === 'major' ? [page.release] : page.releases)), [pages]);
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

  const page = pages[Math.min(index, pages.length - 1)] as ChangelogPage | undefined;
  const total = pages.length;
  const last = index >= total - 1;
  const locked = !last;

  // B-315: only a deliberate acknowledgement marks releases read. On the last
  // page Esc and the backdrop still close without writing the receipt (earlier
  // pages are already recorded, so only that page comes back next time).
  const acknowledge = () => {
    acknowledgeAllChangelog();
    setOpen(false);
  };
  const next = () => {
    if (!page || last) return;
    markChangelogReleasesRead(pageReleaseIds(page));
    setIndex((i) => i + 1);
  };
  const previous = () => setIndex((i) => Math.max(0, i - 1));
  // "Try it" / docs on a page: that page counts as read; any later pages stay
  // unread (sidebar entry + next ordinary load) instead of being skipped.
  const leaveThroughLink = () => {
    if (last) { acknowledge(); return; }
    if (page) markChangelogReleasesRead(pageReleaseIds(page));
    setOpen(false);
  };
  const closeWithoutReading = () => { if (!locked) setOpen(false); };
  const keepOpenWhileLocked = (event: Event) => { if (locked) event.preventDefault(); };
  const copyCli = async () => {
    if (!cliCommand) return;
    try {
      await navigator.clipboard.writeText(cliCommand);
      toast.success(t('changelog.commandCopied'));
    } catch {
      toast.error(t('changelog.commandCopyFailed'));
    }
  };

  const major = page?.kind === 'major' ? page.release : null;
  const pageReleases = !page ? [] : page.kind === 'major' ? [page.release] : page.releases;
  const hasHighlights = pageReleases.some((release) => (release.highlights?.length ?? 0) > 0);
  const progress = total > 1 ? t('changelog.pageProgressLabel', { current: index + 1, total }) : null;

  return (
    <Dialog.Root open={open && turn} onOpenChange={(nextOpen) => nextOpen ? setOpen(true) : closeWithoutReading()}>
      <Dialog.Portal>
        <Dialog.Overlay className="wn-backdrop" />
        <Dialog.Content
          className="wn-card"
          // QA17 P2-3: a toast that would cover this card waits until it closes (Toast.tsx toastHeldByCard).
          data-toast-avoid
          aria-describedby="wn-description"
          data-multiple={(page?.kind === 'minor' && page.releases.length > 1) || undefined}
          data-featured={major?.featured || undefined}
          data-major={major ? true : undefined}
          data-highlights={hasHighlights || undefined}
          data-locked={locked || undefined}
          onEscapeKeyDown={keepOpenWhileLocked}
          onPointerDownOutside={keepOpenWhileLocked}
          onInteractOutside={keepOpenWhileLocked}
        >
          {!locked && (
            <button type="button" className="wn-close" aria-label={t('common.close')} onClick={acknowledge}>
              <X size={18} />
            </button>
          )}
          {major?.featured && <div className="wn-brand"><img src="/icon-192.png" width={44} height={44} alt=""/><span>{BRAND.name}<span>{major.featuredTaglineKey ? t(major.featuredTaglineKey) : lang.startsWith('zh') ? '全新工作台 · 重大界面更新' : 'A new workspace · Major UI update'}</span></span></div>}
          <div className="wn-top">
            <div className="wn-eyebrow"><Sparkles size={14} />{t('changelog.eyebrow')}{major && <MajorBadge />}</div>
            {total > 1 && (
              <div className="wn-progress" aria-hidden="true">
                <span className="mono">{t('changelog.pageProgress', { current: index + 1, total })}</span>
                <span className="wn-dots">{pages.map((p, i) => <span key={p.key} data-state={i < index ? 'done' : i === index ? 'current' : undefined} />)}</span>
              </div>
            )}
          </div>
          {/* Screen readers hear the position whenever the page changes. */}
          {progress && <p className="wn-sr" aria-live="polite">{progress}</p>}
          {page && (major ? (
            <MajorPage release={major} formatDate={formatDate} onNavigate={leaveThroughLink} />
          ) : page.kind === 'minor' && (
            <MinorPage releases={page.releases} paged={total > 1} formatDate={formatDate} onNavigate={leaveThroughLink} />
          ))}
          {last && cliNotices.length > 0 && cliCommand && cliTarget?.cliVersion && (
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
          {last && major?.featured && hasHighlights && <a className="wn-more is-full" href={`${BASE}/whats-new`} onClick={acknowledgeAllChangelog}>{t('changelog.fullPage')}</a>}
          {last && <a className="wn-more" href={`${BASE}/changelog`} onClick={acknowledgeAllChangelog}>{t('changelog.viewAll')}</a>}
          {locked && <p className="wn-locked-hint">{t('changelog.lockedHint', { total })}</p>}
          <div className="wn-nav" data-paged={total > 1 || undefined}>
            {total > 1 && index > 0 && (
              <button type="button" className="wn-prev" onClick={previous}>
                <ArrowLeft size={15} aria-hidden="true" />{t('changelog.previous')}
              </button>
            )}
            {locked ? (
              <button type="button" className="wn-done" onClick={next}>
                {t('changelog.next')}<ArrowRight size={15} aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className="wn-done" onClick={acknowledge}>{total > 1 ? t('changelog.doneAll') : t('changelog.done')}</button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MajorPage({ release, formatDate, onNavigate }: { release: ChangelogRelease; formatDate: (date: string) => string; onNavigate: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="wn-release-meta">
        <time dateTime={release.date}>{formatDate(release.date)}</time>
        {release.cliVersion && <span>CLI v{release.cliVersion}</span>}
      </div>
      <Dialog.Title>{t(release.titleKey)}</Dialog.Title>
      <Dialog.Description id="wn-description" className="wn-intro">{t(release.summaryKey)}</Dialog.Description>
      {release.hero && <div className="wn-hero"><ChangelogShotImage image={release.hero} motion={false} eager /></div>}
      {release.highlights?.length ? (
        <ChangelogHighlights release={release} onNavigate={onNavigate} />
      ) : (
        <ReleaseList release={release} />
      )}
    </>
  );
}

function MinorPage({ releases, paged, formatDate, onNavigate }: { releases: readonly ChangelogRelease[]; paged: boolean; formatDate: (date: string) => string; onNavigate: () => void }) {
  const { t } = useTranslation();
  const head = releases[0];
  if (releases.length === 1 && !paged) {
    return (
      <>
        <Dialog.Title>{t(head.titleKey)}</Dialog.Title>
        <Dialog.Description id="wn-description" className="wn-intro">{t(head.summaryKey)}</Dialog.Description>
        {head.highlights?.length ? <ChangelogHighlights release={head} onNavigate={onNavigate} /> : <ReleaseList release={head} />}
      </>
    );
  }
  const oldest = releases[releases.length - 1];
  return (
    <>
      <Dialog.Title>{paged ? t('changelog.minorPageTitle') : t('changelog.pendingTitle', { count: releases.length })}</Dialog.Title>
      <Dialog.Description id="wn-description" className="wn-intro">
        {paged ? t('changelog.minorPageSummary') : oldest.date === head.date
          ? t('changelog.pendingSummarySameDay', { date: formatDate(head.date) })
          : t('changelog.pendingSummary', { from: formatDate(oldest.date), to: formatDate(head.date) })}
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
            {release.highlights?.length ? <ChangelogHighlights release={release} onNavigate={onNavigate} headingLevel={4} /> : <ReleaseList release={release} />}
          </section>
        ))}
      </div>
    </>
  );
}

function ReleaseList({ release }: { release: ChangelogRelease }) {
  const { t } = useTranslation();
  return (
    <ul className="wn-list">
      {release.itemKeys.map((key) => (
        <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
      ))}
    </ul>
  );
}
