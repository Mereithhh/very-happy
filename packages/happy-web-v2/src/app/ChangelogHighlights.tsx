/**
 * B-677: a release's highlight cards — screenshot, title, one sentence, and
 * optional "Try it" / docs links — plus the collapsed "Other improvements".
 * Shared by the post-release notice and the /changelog page so both render the
 * same format (specs/2026-10-whats-new.md). Releases without highlights keep
 * the plain checklist, rendered by the callers as before.
 */
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useTheme } from '@/ui';
import { openSessionSearch } from '@/screens/search/sessionSearchEvents';
import { changelogImageSrc, type ChangelogHighlight, type ChangelogRelease } from './changelogRelease';
import './changelogHighlights.css';

interface Props {
  release: ChangelogRelease;
  /** Called before a "Try it" / docs link leaves the surface (the notice acknowledges and closes). */
  onNavigate?: () => void;
  /** Heading level of each card title, so the outline stays valid on both surfaces. */
  headingLevel?: 3 | 4;
  /**
   * False on the /changelog page: it renders outside AppLayout, so actions without
   * a URL (opening session search) have nothing to talk to; only path links remain.
   */
  inApp?: boolean;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function ChangelogHighlights({ release, onNavigate, headingLevel = 3, inApp = true }: Props) {
  const { t } = useTranslation();
  const highlights = release.highlights ?? [];
  return (
    <>
      <div className="wnh-grid">
        {highlights.map((highlight) => (
          <HighlightCard key={highlight.key} highlight={highlight} onNavigate={onNavigate} headingLevel={headingLevel} inApp={inApp} />
        ))}
      </div>
      {release.itemKeys.length > 0 && (
        <details className="wnh-more">
          <summary>
            <ChevronRight size={15} aria-hidden="true" />
            {t('changelog.otherImprovements', { count: release.itemKeys.length })}
          </summary>
          <ul className="wn-list">
            {release.itemKeys.map((key) => (
              <li key={key}><Check size={15} aria-hidden="true" />{t(key)}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function HighlightCard({ highlight, onNavigate, headingLevel, inApp }: { highlight: ChangelogHighlight; onNavigate?: () => void; headingLevel: 3 | 4; inApp: boolean }) {
  const { t, lang } = useTranslation();
  const { resolved } = useTheme();
  const navigate = useNavigate();
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const { image, docsHref } = highlight;
  const action = highlight.action && (inApp || highlight.action.kind === 'link') ? highlight.action : undefined;

  const tryIt = () => {
    if (!action) return;
    onNavigate?.();
    if (action.kind === 'sessionSearch') openSessionSearch();
    else navigate(action.href);
  };

  return (
    <article className="wnh-card">
      {image && (
        <div className="wnh-shot">
          <img
            src={changelogImageSrc(image, lang, resolved)}
            width={image.width}
            height={image.height}
            alt={t(image.altKey)}
            style={{ aspectRatio: `${image.width} / ${image.height}` }}
            loading="lazy"
            decoding="async"
          />
        </div>
      )}
      <div className="wnh-body">
        <Heading>{t(highlight.titleKey)}</Heading>
        <p>{t(highlight.bodyKey)}</p>
        {(action || docsHref) && (
          <div className="wnh-actions">
            {action && (
              <button type="button" className="wnh-try" onClick={tryIt}>
                {t('changelog.tryIt')}<ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
            {docsHref && <a className="wnh-docs" href={`${BASE}${docsHref}`} onClick={onNavigate}>{t('changelog.learnMore')}</a>}
          </div>
        )}
      </div>
    </article>
  );
}
