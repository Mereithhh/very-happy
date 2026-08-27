import { Check, PackageOpen } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { CHANGELOG_RELEASES } from '@/app/changelogRelease';
import { useTranslation } from '@/i18n/useTranslation';
import './changelog.css';

export function ChangelogScreen() {
  const { t, lang } = useTranslation();
  const formatDate = (date: string) => new Intl.DateTimeFormat(lang, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00`));

  return (
    <main className="chg-page">
      <header className="chg-header">
        <BackButton />
        <div>
          <span>{t('changelog.eyebrow')}</span>
          <h1>{t('changelog.historyTitle')}</h1>
        </div>
      </header>
      <div className="chg-timeline">
        {CHANGELOG_RELEASES.map((release, index) => (
          <article className="chg-release" key={release.id} data-latest={index === 0 || undefined}>
            <div className="chg-meta">
              <time dateTime={release.date}>{formatDate(release.date)}</time>
              {release.buildVersion && <span>{t('changelog.webBuild', { version: release.buildVersion })}</span>}
            </div>
            <h2>{t(release.titleKey)}</h2>
            <p>{t(release.summaryKey)}</p>
            <ul>
              {release.itemKeys.map((key) => (
                <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
              ))}
            </ul>
            {release.cliVersion && (
              <div className="chg-cli">
                <PackageOpen size={17} aria-hidden="true" />
                <span>{t('changelog.companionCli', { version: release.cliVersion })}</span>
              </div>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}
