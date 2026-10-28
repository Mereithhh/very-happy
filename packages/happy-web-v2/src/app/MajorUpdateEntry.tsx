/**
 * B-715: a persistent way back to unread release notes. Rendered just above
 * the sidebar footer (desktop sidebar, the phone's list screen) and as an icon
 * in the collapsed rail; gone once every release is read. A deep-link load
 * never pops the notes on its own (B-697) — this is how they are reached there.
 * B-842: minor releases count too (a quiet 「更新说明」 row); only a major one
 * gets the filled 「大更新」 row.
 */
import { Sparkles } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { changelogEntry } from './changelogPager';
import { requestChangelogOpen, usePendingChangelog } from './changelogReadStore';
import './majorBadge.css';

export function MajorUpdateEntry({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const entry = changelogEntry(usePendingChangelog());
  if (!entry) return null;
  const { count } = entry;
  const major = entry.kind === 'major';
  const label = major ? t('changelog.entryLabel', { count }) : t('changelog.notesEntryLabel', { count });
  if (compact) {
    return (
      <button type="button" className="app-rail-btn vh-major-rail" data-kind={entry.kind} onClick={requestChangelogOpen} aria-label={label} title={label}>
        <Sparkles size={18} aria-hidden="true" />
        <span className="vh-major-rail-dot" aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className="vh-major-entry-row">
      <button type="button" className="vh-major-entry" data-kind={entry.kind} onClick={requestChangelogOpen} aria-label={label}>
        <Sparkles size={15} aria-hidden="true" />
        <span className="vh-major-entry-label">{major ? t('changelog.entryShort') : t('changelog.notesEntryShort')}</span>
        <span className="vh-major-entry-count">{t('changelog.entryCount', { count })}</span>
      </button>
    </div>
  );
}
