/**
 * /whats-new — the shareable long page for the newest big release (2026-10-21:
 * Owner asked for a release note people can forward that shows at a glance how
 * big the update is). Data comes from CHANGELOG_RELEASES, so the page, the
 * in-app notice and /changelog never disagree; looping captures play here only,
 * and fall back to stills under reduced motion.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowRight, Check, Clipboard, PackageOpen } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { usePublicI18n } from '@/i18n/publicI18n';
import { ChangelogShotImage, ChangelogTopics } from '@/app/ChangelogHighlights';
import { whatsNewReleases } from '@/app/changelogRelease';
import { cliUpdateInstallCommand } from '@/app/cliUpdatePolicy';
import { PublicFooter, PublicHeader } from '@/screens/public/PublicShell';
import './whatsNew.css';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function WhatsNewScreen() {
  const { t, lang } = useTranslation();
  const { copy } = usePublicI18n();
  const c = copy.whatsNew;
  const pair = whatsNewReleases();
  const [copied, setCopied] = useState(false);
  useEffect(() => { document.title = c.pageTitle; }, [c.pageTitle]);
  if (!pair) return null;
  const { web, cli } = pair;
  const cliVersion = cli?.cliVersion ?? web.cliVersion;
  const command = cliVersion ? cliUpdateInstallCommand(cliVersion) : null;
  const date = new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${web.date}T00:00:00`));
  const copyCommand = async () => {
    if (!command) return;
    try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="pub-page wnp-page">
      <PublicHeader />
      <main id="main-content">
        <section className="wnp-hero" aria-labelledby="wnp-title">
          <div className="eyebrow">{c.eyebrow} · <time dateTime={web.date}>{date}</time></div>
          <h1 id="wnp-title">{t(web.titleKey)}</h1>
          <p>{t(web.summaryKey)}</p>
          <div className="pub-actions">
            <a className="pub-button is-primary" href={`${BASE}/`}>{c.openApp} <ArrowRight size={16} aria-hidden="true" /></a>
            {command && <a className="pub-button" href="#upgrade">{c.updateCli} <ArrowDown size={16} aria-hidden="true" /></a>}
          </div>
          <div className="pub-meta mono"><span>{c.heroMeta}</span>{cliVersion && <span>CLI {cliVersion}</span>}<span>{c.example}</span></div>
          {web.hero && <div className="wnp-hero-shot"><ChangelogShotImage image={web.hero} motion eager /></div>}
        </section>

        <section className="wnp-section" aria-labelledby="wnp-highlights">
          <div className="eyebrow">{c.highlightsEyebrow}</div>
          <h2 id="wnp-highlights">{c.highlightsTitle}</h2>
          <ol className="wnp-highlights">
            {(web.highlights ?? []).map((h, i) => (
              <li key={h.key} className="wnp-highlight">
                <div className="wnp-highlight-copy">
                  <span className="wnp-num mono">{String(i + 1).padStart(2, '0')}</span>
                  <h3>{t(h.titleKey)}</h3>
                  <p>{t(h.bodyKey)}</p>
                  {h.docsHref && <a className="wnp-link" href={`${BASE}${h.docsHref}`}>{c.docs} <ArrowRight size={14} aria-hidden="true" /></a>}
                </div>
                {h.image && <div className="wnp-shot"><ChangelogShotImage image={h.image} motion /></div>}
              </li>
            ))}
          </ol>
        </section>

        {(web.topics?.length ?? 0) > 0 && (
          <section className="wnp-section wnp-topics" aria-labelledby="wnp-topics">
            <div className="eyebrow">{c.topicsEyebrow}</div>
            <h2 id="wnp-topics">{c.topicsTitle}</h2>
            <ChangelogTopics topics={web.topics!} headingLevel={3} />
          </section>
        )}

        <section className="wnp-section" aria-labelledby="wnp-rest">
          <div className="eyebrow">{c.restEyebrow}</div>
          <div className="wnp-rest" id="wnp-rest">
            <div>
              <h3>{c.webList}</h3>
              <ul className="wnp-list">{web.itemKeys.map((key) => <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>)}</ul>
            </div>
            {cli && (
              <div>
                <h3>{c.cliList} {cli.cliVersion}</h3>
                <ul className="wnp-list">{cli.itemKeys.map((key) => <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>)}</ul>
              </div>
            )}
          </div>
        </section>

        {command && (
          <section className="wnp-section wnp-upgrade" id="upgrade" aria-labelledby="wnp-upgrade">
            <PackageOpen size={22} aria-hidden="true" />
            <div>
              <div className="eyebrow">{c.upgradeEyebrow}</div>
              <h2 id="wnp-upgrade">{c.upgradeTitle}</h2>
              <p>{c.upgradeBody}</p>
              <button type="button" className="wnp-command" onClick={() => void copyCommand()} aria-label={c.copy}>
                <code>{command}</code>
                <span>{copied ? <Check size={14} aria-hidden="true" /> : <Clipboard size={14} aria-hidden="true" />}{copied ? c.copied : c.copy}</span>
              </button>
              <Link className="wnp-link" to="/changelog">{c.allReleases} <ArrowRight size={14} aria-hidden="true" /></Link>
            </div>
          </section>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
