/**
 * B-715: a persistent way back to unread big updates. Rendered just above the
 * sidebar footer (desktop sidebar, the phone's list screen) and as an icon in
 * the collapsed rail; gone once every major release is read. A deep-link load
 * never pops the notes on its own (B-697) — this is how they are reached there.
 */
import { Sparkles } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { unreadMajorCount } from './changelogPager';
import { requestChangelogOpen, usePendingChangelog } from './changelogReadStore';
import './majorBadge.css';

export function MajorUpdateEntry({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const count = unreadMajorCount(usePendingChangelog());
  if (count === 0) return null;
  const label = t('changelog.entryLabel', { count });
  if (compact) {
    return (
      <button type="button" className="app-rail-btn vh-major-rail" onClick={requestChangelogOpen} aria-label={label} title={label}>
        <Sparkles size={18} aria-hidden="true" />
        <span className="vh-major-rail-dot" aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className="vh-major-entry-row">
      <button type="button" className="vh-major-entry" onClick={requestChangelogOpen} aria-label={label}>
        <Sparkles size={15} aria-hidden="true" />
        <span className="vh-major-entry-label">{t('changelog.entryShort')}</span>
        <span className="vh-major-entry-count">{t('changelog.entryCount', { count })}</span>
      </button>
    </div>
  );
}
