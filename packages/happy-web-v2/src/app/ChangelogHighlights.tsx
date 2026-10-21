/**
 * B-677: a release's highlight cards — screenshot, title, one sentence, and
 * optional "Try it" / docs links — plus the collapsed "Other improvements".
 * Shared by the post-release notice and the /changelog page so both render the
 * same format (specs/2026-10-whats-new.md). Releases without highlights keep
 * the plain checklist, rendered by the callers as before.
 */
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useTheme } from '@/ui';
import { Summary } from '@/ui/Summary';
import { openSessionSearch } from '@/screens/search/sessionSearchEvents';
import { changelogImageSrc, changelogMotionSrc, type ChangelogHighlight, type ChangelogImage, type ChangelogRelease, type ChangelogTopic } from './changelogRelease';
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
  /** Play looping captures where a highlight has one (What's new page); the notice keeps stills. */
  motion?: boolean;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function ChangelogHighlights({ release, onNavigate, headingLevel = 3, inApp = true, motion = false }: Props) {
  const { t } = useTranslation();
  const highlights = release.highlights ?? [];
  const topics = release.topics ?? [];
  return (
    <>
      <div className="wnh-grid">
        {highlights.map((highlight) => (
          <HighlightCard key={highlight.key} highlight={highlight} onNavigate={onNavigate} headingLevel={headingLevel} inApp={inApp} motion={motion} />
        ))}
      </div>
      {topics.length > 0 && <ChangelogTopics topics={topics} headingLevel={headingLevel} />}
      {release.itemKeys.length > 0 && (
        <details className="wnh-more">
          <Summary>
            {t('changelog.otherImprovements', { count: release.itemKeys.length })}
          </Summary>
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

/** Themed groups of smaller changes: a small capture, a title and one sentence each. */
export function ChangelogTopics({ topics, headingLevel = 3 }: { topics: readonly ChangelogTopic[]; headingLevel?: 3 | 4 }) {
  const { t } = useTranslation();
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return (
    <div className="wnh-topics"><div className="wnh-topics-grid">
      {topics.map((topic) => (
        <article className="wnh-topic" key={topic.key}>
          {topic.image && <div className="wnh-topic-shot"><ChangelogShotImage image={topic.image} motion={false} /></div>}
          <div className="wnh-topic-body">
            <Heading>{t(topic.titleKey)}</Heading>
            <p>{t(topic.bodyKey)}</p>
          </div>
        </article>
      ))}
    </div></div>
  );
}

/**
 * The capture for the viewer's language and resolved theme. With `motion`, a
 * looping capture plays unless the viewer prefers reduced motion — the
 * `<source>` media query keeps the still as the fallback without JS.
 */
export function ChangelogShotImage({ image, motion, eager = false }: { image: ChangelogImage; motion: boolean; eager?: boolean }) {
  const { t, lang } = useTranslation();
  const { resolved } = useTheme();
  const still = changelogImageSrc(image, lang, resolved);
  const moving = motion ? changelogMotionSrc(image, lang, resolved) : null;
  const img = (
    <img
      src={still}
      width={image.width}
      height={image.height}
      alt={t(image.altKey)}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  );
  if (!moving) return img;
  return (
    <picture>
      <source media="(prefers-reduced-motion: no-preference)" srcSet={moving} />
      {img}
    </picture>
  );
}

function HighlightCard({ highlight, onNavigate, headingLevel, inApp, motion }: { highlight: ChangelogHighlight; onNavigate?: () => void; headingLevel: 3 | 4; inApp: boolean; motion: boolean }) {
  const { t } = useTranslation();
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
          <ChangelogShotImage image={image} motion={motion} />
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
