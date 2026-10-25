import type { SimpleTranslationKey } from '@/text';
import { isCliVersionBelow } from './cliUpdatePolicy';

export const CHANGELOG_STORAGE_KEY = 'vh.changelog.seen';

/** One screenshot; `dark` is shown when the app resolves to the dark theme. */
export interface ChangelogShot {
  light: string;
  dark?: string;
}

/**
 * A highlight's screenshot (B-677, specs/2026-10-whats-new.md). Files live in
 * `src/app/whats-new/<date>/` and are imported so Vite fingerprints them
 * (immutable cache) — never under public/. Every variant shares `width`/`height`
 * so the frame reserves its space before the lazy image arrives.
 */
export interface ChangelogImage {
  width: number;
  height: number;
  altKey: SimpleTranslationKey;
  en: ChangelogShot;
  /** Chinese-UI capture; falls back to `en` when absent. */
  zh?: ChangelogShot;
  /**
   * Short looping capture (animated webp, same size) of the same scene. Only
   * surfaces that opt in (the What's new page) play it, and only when the
   * viewer has not asked for reduced motion; the still stays the fallback.
   */
  motion?: { en: ChangelogShot; zh?: ChangelogShot };
}

/** "Try it": an in-app path, or an action that has no URL of its own. */
export type ChangelogHighlightAction =
  | { kind: 'link'; href: string }
  | { kind: 'sessionSearch' };

/**
 * Format rule (spec): at most 4 per release; title + one sentence of what you
 * can now do + one screenshot + optional try/docs links. Named `key`, not `id`:
 * scripts/changelog/check-release.mjs reads release ids with a line regex.
 */
export interface ChangelogHighlight {
  key: string;
  titleKey: SimpleTranslationKey;
  bodyKey: SimpleTranslationKey;
  image?: ChangelogImage;
  action?: ChangelogHighlightAction;
  /** Public docs path, e.g. `/docs/projects`. */
  docsHref?: string;
}

export const CHANGELOG_MAX_HIGHLIGHTS = 4;

/**
 * A themed group of smaller changes (2026-10-21 big update): one title, one
 * sentence and a small capture. Shown below the highlights; `itemKeys` stays
 * the collapsed long tail.
 */
export interface ChangelogTopic {
  key: string;
  titleKey: SimpleTranslationKey;
  bodyKey: SimpleTranslationKey;
  image?: ChangelogImage;
}

export const CHANGELOG_MAX_TOPICS = 4;

export interface ChangelogRelease {
  id: string;
  date: string;
  buildVersion?: string;
  cliVersion?: string;
  featured?: boolean;
  /**
   * B-715: a big update — 「大更新」 badge everywhere, its own page in the
   * notice pager (which cannot be dismissed before the last page), and the
   * sidebar entry until read. Needs `highlights` (check-release.mjs enforces).
   */
  major?: boolean;
  /** Line under the brand on a featured notice; defaults to the 2026-09 redesign wording. */
  featuredTaglineKey?: SimpleTranslationKey;
  titleKey: SimpleTranslationKey;
  summaryKey: SimpleTranslationKey;
  /** Shown as cards above the list; with highlights, `itemKeys` becomes the collapsed "Other improvements". */
  highlights?: readonly ChangelogHighlight[];
  /** Wide capture at the top of the /whats-new page (usually with a looping `motion`). */
  hero?: ChangelogImage;
  /** Themed groups with a small capture each, between the highlights and the long tail. */
  topics?: readonly ChangelogTopic[];
  itemKeys: readonly SimpleTranslationKey[];
}

const SHOT_URLS = import.meta.glob('./whats-new/*/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/**
 * Screenshots by convention: `whats-new/<dir>/<name>-<en|zh>-<light|dark>.webp`,
 * plus an optional looping `…-<light|dark>-motion.webp`. Only URL strings land
 * in the bundle. A missing still yields an empty `light`, which
 * changelogRelease.test.ts reports by name.
 */
export function changelogShots(dir: string, name: string, size: { width: number; height: number }, altKey: SimpleTranslationKey): ChangelogImage {
  const url = (lang: 'en' | 'zh', theme: 'light' | 'dark', suffix = '') => SHOT_URLS[`./whats-new/${dir}/${name}-${lang}-${theme}${suffix}.webp`];
  const shot = (lang: 'en' | 'zh', suffix = '') => ({ light: url(lang, 'light', suffix) ?? '', dark: url(lang, 'dark', suffix) });
  const motion = url('en', 'light', '-motion')
    ? { en: shot('en', '-motion'), zh: url('zh', 'light', '-motion') ? shot('zh', '-motion') : undefined }
    : undefined;
  return { ...size, altKey, en: shot('en'), zh: url('zh', 'light') ? shot('zh') : undefined, motion };
}

const SHOT_SIZE = { width: 960, height: 600 }; // 480×300 CSS px crops at 2×
const TOPIC_SIZE = { width: 640, height: 400 }; // 320×200 CSS px crops at 2×

function pickShot(set: { en: ChangelogShot; zh?: ChangelogShot }, lang: string, theme: 'light' | 'dark'): string {
  const shot = lang.toLowerCase().startsWith('zh') && set.zh ? set.zh : set.en;
  return theme === 'dark' && shot.dark ? shot.dark : shot.light;
}

/**
 * The release the /whats-new page tells: the newest featured release with
 * highlights, plus the CLI release that shipped beside it (same date).
 */
export function whatsNewReleases(releases: readonly ChangelogRelease[] = CHANGELOG_RELEASES): { web: ChangelogRelease; cli: ChangelogRelease | null } | null {
  const web = releases.find((r) => r.featured && (r.highlights?.length ?? 0) > 0) ?? releases.find((r) => (r.highlights?.length ?? 0) > 0);
  if (!web) return null;
  const cli = web.cliVersion ? null : releases.find((r) => r.cliVersion && r.date === web.date && r.id !== web.id) ?? null;
  return { web, cli };
}

/** Which capture to load for the viewer's language and resolved theme. */
export function changelogImageSrc(image: ChangelogImage, lang: string, theme: 'light' | 'dark'): string {
  return pickShot(image, lang, theme);
}

/** The looping capture for the same language/theme, or null when the image has none. */
export function changelogMotionSrc(image: ChangelogImage, lang: string, theme: 'light' | 'dark'): string | null {
  return image.motion ? pickShot(image.motion, lang, theme) || null : null;
}

export const CHANGELOG_RELEASES: readonly ChangelogRelease[] = [
  {
    id: '2026-10-25-cli-no-missed-messages',
    cliVersion: '0.2.185',
    date: '2026-10-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct25r.title',
    summaryKey: 'changelog.releases.oct25r.summary',
    itemKeys: ['changelog.releases.oct25r.missed', 'changelog.releases.oct25r.echo'],
  },
  {
    id: '2026-10-25-faster-catch-up',
    date: '2026-10-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct25d.title',
    summaryKey: 'changelog.releases.oct25d.summary',
    itemKeys: ['changelog.releases.oct25d.catchUp', 'changelog.releases.oct25d.retry'],
  },
  {
    id: '2026-10-25-messages-unstuck',
    date: '2026-10-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct25c.title',
    summaryKey: 'changelog.releases.oct25c.summary',
    highlights: [
      {
        key: 'sync',
        titleKey: 'changelog.releases.oct25c.syncTitle',
        bodyKey: 'changelog.releases.oct25c.syncBody',
        image: changelogShots('2026-10-25c', 'sync', SHOT_SIZE, 'changelog.releases.oct25c.syncAlt'),
      },
    ],
    itemKeys: [
      'changelog.releases.oct25c.queue',
      'changelog.releases.oct25c.resend',
      'changelog.releases.oct25c.requests',
    ],
  },
  {
    id: '2026-10-25-offline-gestures-draft',
    date: '2026-10-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct25b.title',
    summaryKey: 'changelog.releases.oct25b.summary',
    highlights: [
      {
        key: 'offline',
        titleKey: 'changelog.releases.oct25b.offlineTitle',
        bodyKey: 'changelog.releases.oct25b.offlineBody',
        image: changelogShots('2026-10-25b', 'offline', SHOT_SIZE, 'changelog.releases.oct25b.offlineAlt'),
      },
      {
        key: 'drawer',
        titleKey: 'changelog.releases.oct25b.drawerTitle',
        bodyKey: 'changelog.releases.oct25b.drawerBody',
        image: changelogShots('2026-10-25b', 'drawer', SHOT_SIZE, 'changelog.releases.oct25b.drawerAlt'),
      },
      {
        key: 'draft',
        titleKey: 'changelog.releases.oct25b.draftTitle',
        bodyKey: 'changelog.releases.oct25b.draftBody',
        image: changelogShots('2026-10-25b', 'draft', SHOT_SIZE, 'changelog.releases.oct25b.draftAlt'),
      },
    ],
    itemKeys: [
      'changelog.releases.oct25b.browserBack',
      'changelog.releases.oct25b.attachments',
      'changelog.releases.oct25b.draftFail',
    ],
  },
  {
    id: '2026-10-25-mobile-touch',
    date: '2026-10-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct25a.title',
    summaryKey: 'changelog.releases.oct25a.summary',
    highlights: [
      {
        key: 'touch',
        titleKey: 'changelog.releases.oct25a.touchTitle',
        bodyKey: 'changelog.releases.oct25a.touchBody',
        image: changelogShots('2026-10-25', 'touch', SHOT_SIZE, 'changelog.releases.oct25a.touchAlt'),
      },
      {
        key: 'sheet',
        titleKey: 'changelog.releases.oct25a.sheetTitle',
        bodyKey: 'changelog.releases.oct25a.sheetBody',
        image: changelogShots('2026-10-25', 'sheet', SHOT_SIZE, 'changelog.releases.oct25a.sheetAlt'),
      },
    ],
    itemKeys: [
      'changelog.releases.oct25a.back',
      'changelog.releases.oct25a.targets',
      'changelog.releases.oct25a.sessionPage',
      'changelog.releases.oct25a.session',
      'changelog.releases.oct25a.missing',
      'changelog.releases.oct25a.teams',
      'changelog.releases.oct25a.terminal',
    ],
  },
  {
    id: '2026-10-24-foldable-safe-area',
    date: '2026-10-24',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct24a.title',
    summaryKey: 'changelog.releases.oct24a.summary',
    highlights: [
      {
        key: 'duo',
        titleKey: 'changelog.releases.oct24a.duoTitle',
        bodyKey: 'changelog.releases.oct24a.duoBody',
        image: changelogShots('2026-10-24', 'duo', SHOT_SIZE, 'changelog.releases.oct24a.duoAlt'),
      },
      {
        key: 'safeArea',
        titleKey: 'changelog.releases.oct24a.safeAreaTitle',
        bodyKey: 'changelog.releases.oct24a.safeAreaBody',
        image: changelogShots('2026-10-24', 'safearea', SHOT_SIZE, 'changelog.releases.oct24a.safeAreaAlt'),
      },
    ],
    itemKeys: [
      'changelog.releases.oct24a.targets',
      'changelog.releases.oct24a.header',
      'changelog.releases.oct24a.diag',
      'changelog.releases.oct24a.todos',
    ],
  },
  {
    id: '2026-10-24-cli-session-provider',
    cliVersion: '0.2.184',
    date: '2026-10-24',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct24r.title',
    summaryKey: 'changelog.releases.oct24r.summary',
    itemKeys: ['changelog.releases.oct24r.provider', 'changelog.releases.oct24r.compact', 'changelog.releases.oct24r.deepseek', 'changelog.releases.oct24r.cleanup'],
  },
  {
    id: '2026-10-23-briefing-board',
    date: '2026-10-23',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct23b.title',
    summaryKey: 'changelog.releases.oct23b.summary',
    highlights: [
      {
        key: 'board',
        titleKey: 'changelog.releases.oct23b.boardTitle',
        bodyKey: 'changelog.releases.oct23b.boardBody',
        image: changelogShots('2026-10-23b', 'board', SHOT_SIZE, 'changelog.releases.oct23b.boardAlt'),
        docsHref: '/docs/agent-teams',
      },
      {
        key: 'phone',
        titleKey: 'changelog.releases.oct23b.phoneTitle',
        bodyKey: 'changelog.releases.oct23b.phoneBody',
        image: changelogShots('2026-10-23b', 'phone', SHOT_SIZE, 'changelog.releases.oct23b.phoneAlt'),
        docsHref: '/docs/agent-teams',
      },
    ],
    itemKeys: [
      'changelog.releases.oct23b.asked',
      'changelog.releases.oct23b.autoDetect',
      'changelog.releases.oct23b.signOff',
      'changelog.releases.oct23b.push',
      'changelog.releases.oct23b.restart',
    ],
  },
  {
    id: '2026-10-23-project-tree-lead-view',
    date: '2026-10-23',
    buildVersion: __APP_VERSION__,
    featured: true,
    major: true,
    featuredTaglineKey: 'changelog.releases.oct23a.tagline',
    titleKey: 'changelog.releases.oct23a.title',
    summaryKey: 'changelog.releases.oct23a.summary',
    hero: changelogShots('2026-10-23a', 'hero', { width: 1280, height: 640 }, 'changelog.releases.oct23a.heroAlt'),
    highlights: [
      {
        key: 'tree',
        titleKey: 'changelog.releases.oct23a.treeTitle',
        bodyKey: 'changelog.releases.oct23a.treeBody',
        image: changelogShots('2026-10-23a', 'tree', SHOT_SIZE, 'changelog.releases.oct23a.treeAlt'),
        docsHref: '/docs/projects',
      },
      {
        key: 'leadView',
        titleKey: 'changelog.releases.oct23a.leadViewTitle',
        bodyKey: 'changelog.releases.oct23a.leadViewBody',
        image: changelogShots('2026-10-23a', 'leadview', SHOT_SIZE, 'changelog.releases.oct23a.leadViewAlt'),
        docsHref: '/docs/agent-teams',
      },
      {
        key: 'toolResults',
        titleKey: 'changelog.releases.oct23a.toolResultsTitle',
        bodyKey: 'changelog.releases.oct23a.toolResultsBody',
        image: changelogShots('2026-10-23a', 'toolresults', SHOT_SIZE, 'changelog.releases.oct23a.toolResultsAlt'),
        docsHref: '/docs/sessions',
      },
      {
        key: 'quiet',
        titleKey: 'changelog.releases.oct23a.quietTitle',
        bodyKey: 'changelog.releases.oct23a.quietBody',
        image: changelogShots('2026-10-23a', 'quiet', SHOT_SIZE, 'changelog.releases.oct23a.quietAlt'),
        docsHref: '/docs/agent-teams',
      },
    ],
    topics: [
      { key: 'trail', titleKey: 'changelog.releases.oct23a.trailTitle', bodyKey: 'changelog.releases.oct23a.trailBody', image: changelogShots('2026-10-23a', 'trail', TOPIC_SIZE, 'changelog.releases.oct23a.trailAlt') },
      { key: 'moveTeam', titleKey: 'changelog.releases.oct23a.moveTeamTitle', bodyKey: 'changelog.releases.oct23a.moveTeamBody', image: changelogShots('2026-10-23a', 'moveteam', TOPIC_SIZE, 'changelog.releases.oct23a.moveTeamAlt') },
      { key: 'lenses', titleKey: 'changelog.releases.oct23a.lensesTitle', bodyKey: 'changelog.releases.oct23a.lensesBody', image: changelogShots('2026-10-23a', 'lenses', TOPIC_SIZE, 'changelog.releases.oct23a.lensesAlt') },
      { key: 'linkConfirm', titleKey: 'changelog.releases.oct23a.linkConfirmTitle', bodyKey: 'changelog.releases.oct23a.linkConfirmBody', image: changelogShots('2026-10-23a', 'linkconfirm', TOPIC_SIZE, 'changelog.releases.oct23a.linkConfirmAlt') },
    ],
    itemKeys: [
      'changelog.releases.oct23a.previewPush',
      'changelog.releases.oct23a.treeKeys',
      'changelog.releases.oct23a.notInProject',
      'changelog.releases.oct23a.plurals',
      'changelog.releases.oct23a.instructions',
    ],
  },
  {
    id: '2026-10-23-cli-supervised-auto-update',
    cliVersion: '0.2.183',
    date: '2026-10-23',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct23r.title',
    summaryKey: 'changelog.releases.oct23r.summary',
    itemKeys: ['changelog.releases.oct23r.toolResults', 'changelog.releases.oct23r.autoReport', 'changelog.releases.oct23r.launchd', 'changelog.releases.oct23r.lineage'],
  },
  {
    id: '2026-10-22-projects-tool-cards',
    date: '2026-10-22',
    buildVersion: __APP_VERSION__,
    featured: true,
    major: true,
    featuredTaglineKey: 'changelog.releases.oct22c.tagline',
    titleKey: 'changelog.releases.oct22c.title',
    summaryKey: 'changelog.releases.oct22c.summary',
    hero: changelogShots('2026-10-22c', 'hero', { width: 1280, height: 640 }, 'changelog.releases.oct22c.heroAlt'),
    highlights: [
      {
        key: 'projects',
        titleKey: 'changelog.releases.oct22c.projectsTitle',
        bodyKey: 'changelog.releases.oct22c.projectsBody',
        image: changelogShots('2026-10-22c', 'projects', SHOT_SIZE, 'changelog.releases.oct22c.projectsAlt'),
        action: { kind: 'link', href: '/projects' },
        docsHref: '/docs/projects',
      },
      {
        key: 'tools',
        titleKey: 'changelog.releases.oct22c.toolsTitle',
        bodyKey: 'changelog.releases.oct22c.toolsBody',
        image: changelogShots('2026-10-22c', 'tools', SHOT_SIZE, 'changelog.releases.oct22c.toolsAlt'),
        docsHref: '/docs/sessions',
      },
      {
        key: 'backdrop',
        titleKey: 'changelog.releases.oct22c.backdropTitle',
        bodyKey: 'changelog.releases.oct22c.backdropBody',
        image: changelogShots('2026-10-22c', 'backdrop', SHOT_SIZE, 'changelog.releases.oct22c.backdropAlt'),
      },
      {
        key: 'menu',
        titleKey: 'changelog.releases.oct22c.menuTitle',
        bodyKey: 'changelog.releases.oct22c.menuBody',
        image: changelogShots('2026-10-22c', 'menu', SHOT_SIZE, 'changelog.releases.oct22c.menuAlt'),
        docsHref: '/docs/sessions',
      },
    ],
    topics: [
      { key: 'folder', titleKey: 'changelog.releases.oct22c.folderTitle', bodyKey: 'changelog.releases.oct22c.folderBody', image: changelogShots('2026-10-22c', 'folder', TOPIC_SIZE, 'changelog.releases.oct22c.folderAlt') },
      { key: 'hint', titleKey: 'changelog.releases.oct22c.hintTitle', bodyKey: 'changelog.releases.oct22c.hintBody', image: changelogShots('2026-10-22c', 'hint', TOPIC_SIZE, 'changelog.releases.oct22c.hintAlt') },
      { key: 'teams', titleKey: 'changelog.releases.oct22c.teamsTitle', bodyKey: 'changelog.releases.oct22c.teamsBody', image: changelogShots('2026-10-22c', 'teams', TOPIC_SIZE, 'changelog.releases.oct22c.teamsAlt') },
      { key: 'sharePage', titleKey: 'changelog.releases.oct22c.sharePageTitle', bodyKey: 'changelog.releases.oct22c.sharePageBody', image: changelogShots('2026-10-22c', 'sharepage', TOPIC_SIZE, 'changelog.releases.oct22c.sharePageAlt') },
    ],
    itemKeys: [
      'changelog.releases.oct22c.worktree',
      'changelog.releases.oct22c.teamProject',
      'changelog.releases.oct22c.shareDialog',
      'changelog.releases.oct22c.motion',
      'changelog.releases.oct22c.finished',
      'changelog.releases.oct22c.teamState',
    ],
  },
  {
    id: '2026-10-22-cli-project-folders',
    cliVersion: '0.2.182',
    date: '2026-10-22',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct22d.title',
    summaryKey: 'changelog.releases.oct22d.summary',
    itemKeys: ['changelog.releases.oct22d.mkdir', 'changelog.releases.oct22d.worktree'],
  },
  {
    id: '2026-10-22-share-replies-fix',
    date: '2026-10-22',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct22b.title',
    summaryKey: 'changelog.releases.oct22b.summary',
    itemKeys: ['changelog.releases.oct22b.share', 'changelog.releases.oct22b.teamCards'],
  },
  {
    id: '2026-10-22-big-update',
    date: '2026-10-22',
    buildVersion: __APP_VERSION__,
    featured: true,
    major: true,
    featuredTaglineKey: 'changelog.releases.oct22.tagline',
    titleKey: 'changelog.releases.oct22.title',
    summaryKey: 'changelog.releases.oct22.summary',
    hero: changelogShots('2026-10-22', 'hero', { width: 1280, height: 640 }, 'changelog.releases.oct22.heroAlt'),
    highlights: [
      {
        key: 'look',
        titleKey: 'changelog.releases.oct22.lookTitle',
        bodyKey: 'changelog.releases.oct22.lookBody',
        image: changelogShots('2026-10-22', 'look', SHOT_SIZE, 'changelog.releases.oct22.lookAlt'),
      },
      {
        key: 'share',
        titleKey: 'changelog.releases.oct22.shareTitle',
        bodyKey: 'changelog.releases.oct22.shareBody',
        image: changelogShots('2026-10-22', 'share', SHOT_SIZE, 'changelog.releases.oct22.shareAlt'),
        action: { kind: 'link', href: '/settings/shared' },
        docsHref: '/docs/sessions',
      },
      {
        key: 'teams',
        titleKey: 'changelog.releases.oct22.teamsTitle',
        bodyKey: 'changelog.releases.oct22.teamsBody',
        image: changelogShots('2026-10-22', 'teams', SHOT_SIZE, 'changelog.releases.oct22.teamsAlt'),
        action: { kind: 'link', href: '/teams' },
        docsHref: '/docs/projects',
      },
      {
        key: 'updates',
        titleKey: 'changelog.releases.oct22.updatesTitle',
        bodyKey: 'changelog.releases.oct22.updatesBody',
        image: changelogShots('2026-10-22', 'updates', SHOT_SIZE, 'changelog.releases.oct22.updatesAlt'),
        docsHref: '/docs/upgrades',
      },
    ],
    topics: [
      { key: 'sidebar', titleKey: 'changelog.releases.oct22.sidebarTitle', bodyKey: 'changelog.releases.oct22.sidebarBody', image: changelogShots('2026-10-22', 'sidebar', TOPIC_SIZE, 'changelog.releases.oct22.sidebarAlt') },
      { key: 'chat', titleKey: 'changelog.releases.oct22.chatTitle', bodyKey: 'changelog.releases.oct22.chatBody', image: changelogShots('2026-10-22', 'chat', TOPIC_SIZE, 'changelog.releases.oct22.chatAlt') },
      { key: 'polish', titleKey: 'changelog.releases.oct22.polishTitle', bodyKey: 'changelog.releases.oct22.polishBody', image: changelogShots('2026-10-22', 'polish', TOPIC_SIZE, 'changelog.releases.oct22.polishAlt') },
      { key: 'claude', titleKey: 'changelog.releases.oct22.claudeTitle', bodyKey: 'changelog.releases.oct22.claudeBody', image: changelogShots('2026-10-22', 'claude', TOPIC_SIZE, 'changelog.releases.oct22.claudeAlt') },
    ],
    itemKeys: [
      'changelog.releases.oct22.major',
      'changelog.releases.oct22.shared',
      'changelog.releases.oct22.teamCards',
      'changelog.releases.oct22.teamSessions',
      'changelog.releases.oct22.fixes',
    ],
  },
  {
    id: '2026-10-22-cli-teams-updates-harness',
    cliVersion: '0.2.181',
    date: '2026-10-22',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct22a.title',
    summaryKey: 'changelog.releases.oct22a.summary',
    itemKeys: [
      'changelog.releases.oct22a.claude',
      'changelog.releases.oct22a.autoUpdate',
      'changelog.releases.oct22a.harness',
      'changelog.releases.oct22a.playbook',
      'changelog.releases.oct22a.project',
      'changelog.releases.oct22a.scope',
      'changelog.releases.oct22a.pi',
    ],
  },
  {
    id: '2026-10-21-big-update',
    date: '2026-10-21',
    buildVersion: __APP_VERSION__,
    featured: true,
    major: true,
    featuredTaglineKey: 'changelog.releases.oct21b.tagline',
    titleKey: 'changelog.releases.oct21b.title',
    summaryKey: 'changelog.releases.oct21b.summary',
    hero: changelogShots('2026-10-21b', 'hero', { width: 1280, height: 640 }, 'changelog.releases.oct21b.heroAlt'),
    highlights: [
      {
        key: 'projects',
        titleKey: 'changelog.releases.oct21b.projectsTitle',
        bodyKey: 'changelog.releases.oct21b.projectsBody',
        image: changelogShots('2026-10-21b', 'projects', SHOT_SIZE, 'changelog.releases.oct21b.projectsAlt'),
        docsHref: '/docs/projects',
      },
      {
        key: 'models',
        titleKey: 'changelog.releases.oct21b.modelsTitle',
        bodyKey: 'changelog.releases.oct21b.modelsBody',
        image: changelogShots('2026-10-21b', 'models', SHOT_SIZE, 'changelog.releases.oct21b.modelsAlt'),
        action: { kind: 'link', href: '/settings/models' },
      },
      {
        key: 'search',
        titleKey: 'changelog.releases.oct21b.searchTitle',
        bodyKey: 'changelog.releases.oct21b.searchBody',
        image: changelogShots('2026-10-21b', 'search', SHOT_SIZE, 'changelog.releases.oct21b.searchAlt'),
        action: { kind: 'sessionSearch' },
        docsHref: '/docs/sessions',
      },
      {
        key: 'drafts',
        titleKey: 'changelog.releases.oct21b.draftsTitle',
        bodyKey: 'changelog.releases.oct21b.draftsBody',
        image: changelogShots('2026-10-21b', 'drafts', SHOT_SIZE, 'changelog.releases.oct21b.draftsAlt'),
        docsHref: '/docs/sessions',
      },
    ],
    topics: [
      { key: 'teams', titleKey: 'changelog.releases.oct21b.teamsTitle', bodyKey: 'changelog.releases.oct21b.teamsBody', image: changelogShots('2026-10-21b', 'teams', TOPIC_SIZE, 'changelog.releases.oct21b.teamsAlt') },
      { key: 'sidebar', titleKey: 'changelog.releases.oct21b.sidebarTitle', bodyKey: 'changelog.releases.oct21b.sidebarBody', image: changelogShots('2026-10-21b', 'sidebar', TOPIC_SIZE, 'changelog.releases.oct21b.sidebarAlt') },
      { key: 'mobile', titleKey: 'changelog.releases.oct21b.mobileTitle', bodyKey: 'changelog.releases.oct21b.mobileBody', image: changelogShots('2026-10-21b', 'mobile', TOPIC_SIZE, 'changelog.releases.oct21b.mobileAlt') },
      { key: 'reliability', titleKey: 'changelog.releases.oct21b.reliabilityTitle', bodyKey: 'changelog.releases.oct21b.reliabilityBody', image: changelogShots('2026-10-21b', 'reliability', TOPIC_SIZE, 'changelog.releases.oct21b.reliabilityAlt') },
    ],
    itemKeys: [
      'changelog.releases.oct21b.mentions',
      'changelog.releases.oct21b.panels',
      'changelog.releases.oct21b.tide',
      'changelog.releases.oct21b.focus',
      'changelog.releases.oct21b.keys',
      'changelog.releases.oct21b.i18n',
      'changelog.releases.oct21b.fixes',
    ],
  },
  {
    id: '2026-10-21-cli-models-offline-teams',
    cliVersion: '0.2.180',
    date: '2026-10-21',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct21c.title',
    summaryKey: 'changelog.releases.oct21c.summary',
    itemKeys: [
      'changelog.releases.oct21c.models',
      'changelog.releases.oct21c.offline',
      'changelog.releases.oct21c.empty',
      'changelog.releases.oct21c.launch',
      'changelog.releases.oct21c.cleanup',
      'changelog.releases.oct21c.wake',
    ],
  },
  {
    id: '2026-10-21-projects-drafts-search',
    date: '2026-10-21',
    buildVersion: __APP_VERSION__,
    major: true,
    titleKey: 'changelog.releases.oct21.title',
    summaryKey: 'changelog.releases.oct21.summary',
    highlights: [
      {
        key: 'projects',
        titleKey: 'changelog.releases.oct21.projectsTitle',
        bodyKey: 'changelog.releases.oct21.projectsBody',
        image: changelogShots('2026-10-21', 'projects', SHOT_SIZE, 'changelog.releases.oct21.projectsAlt'),
        docsHref: '/docs/projects',
      },
      {
        key: 'drafts',
        titleKey: 'changelog.releases.oct21.draftsTitle',
        bodyKey: 'changelog.releases.oct21.draftsBody',
        image: changelogShots('2026-10-21', 'drafts', SHOT_SIZE, 'changelog.releases.oct21.draftsAlt'),
        docsHref: '/docs/sessions',
      },
      {
        key: 'search',
        titleKey: 'changelog.releases.oct21.searchTitle',
        bodyKey: 'changelog.releases.oct21.searchBody',
        image: changelogShots('2026-10-21', 'search', SHOT_SIZE, 'changelog.releases.oct21.searchAlt'),
        action: { kind: 'sessionSearch' },
        docsHref: '/docs/sessions',
      },
      {
        key: 'mentions',
        titleKey: 'changelog.releases.oct21.mentionsTitle',
        bodyKey: 'changelog.releases.oct21.mentionsBody',
        image: changelogShots('2026-10-21', 'mentions', SHOT_SIZE, 'changelog.releases.oct21.mentionsAlt'),
        docsHref: '/docs/sessions',
      },
    ],
    itemKeys: [
      'changelog.releases.oct21.projects',
      'changelog.releases.oct21.panels',
      'changelog.releases.oct21.mobile',
      'changelog.releases.oct21.keys',
      'changelog.releases.oct21.fixes',
    ],
  },
  {
    id: '2026-10-21-cli-projects-pi',
    cliVersion: '0.2.179',
    date: '2026-10-21',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct21a.title',
    summaryKey: 'changelog.releases.oct21a.summary',
    highlights: [
      {
        key: 'context',
        titleKey: 'changelog.releases.oct21a.contextTitle',
        bodyKey: 'changelog.releases.oct21a.contextBody',
        image: changelogShots('2026-10-21', 'context', SHOT_SIZE, 'changelog.releases.oct21a.contextAlt'),
        docsHref: '/docs/projects',
      },
      {
        key: 'panels',
        titleKey: 'changelog.releases.oct21a.panelsTitle',
        bodyKey: 'changelog.releases.oct21a.panelsBody',
        image: changelogShots('2026-10-21', 'panels', SHOT_SIZE, 'changelog.releases.oct21a.panelsAlt'),
        docsHref: '/docs/configuration',
      },
    ],
    itemKeys: [
      'changelog.releases.oct21a.spawn',
      'changelog.releases.oct21a.pi',
      'changelog.releases.oct21a.stop',
      'changelog.releases.oct21a.reliability',
    ],
  },
  {
    id: '2026-10-19-daemon-follows-relay',
    cliVersion: '0.2.178',
    date: '2026-10-19',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct19b.title',
    summaryKey: 'changelog.releases.oct19b.summary',
    itemKeys: ['changelog.releases.oct19b.follow', 'changelog.releases.oct19b.refuse'],
  },
  {
    id: '2026-10-19-agent-wrappers-orca-align',
    cliVersion: '0.2.177',
    date: '2026-10-19',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct19a.title',
    summaryKey: 'changelog.releases.oct19a.summary',
    itemKeys: ['changelog.releases.oct19a.death', 'changelog.releases.oct19a.turns', 'changelog.releases.oct19a.failures', 'changelog.releases.oct19a.claude'],
  },
  {
    id: '2026-10-18-codex-steer-subagents',
    cliVersion: '0.2.176',
    date: '2026-10-18',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct18c.title',
    summaryKey: 'changelog.releases.oct18c.summary',
    itemKeys: ['changelog.releases.oct18c.steer', 'changelog.releases.oct18c.children', 'changelog.releases.oct18c.stop'],
  },
  {
    id: '2026-10-18-relay-migration',
    date: '2026-10-18',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct18f.title',
    summaryKey: 'changelog.releases.oct18f.summary',
    itemKeys: ['changelog.releases.oct18f.banner', 'changelog.releases.oct18f.daemons'],
  },
  {
    id: '2026-10-18-sso-link-by-email',
    date: '2026-10-18',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct18e.title',
    summaryKey: 'changelog.releases.oct18e.summary',
    itemKeys: ['changelog.releases.oct18e.link'],
  },
  {
    id: '2026-10-18-codex-threads-and-exits',
    cliVersion: '0.2.175',
    date: '2026-10-18',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct18d.title',
    summaryKey: 'changelog.releases.oct18d.summary',
    itemKeys: ['changelog.releases.oct18d.children', 'changelog.releases.oct18d.exits'],
  },
  {
    id: '2026-10-18-sso-self-serve',
    date: '2026-10-18',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct18b.title',
    summaryKey: 'changelog.releases.oct18b.summary',
    itemKeys: ['changelog.releases.oct18b.selfServe', 'changelog.releases.oct18b.name'],
  },
  {
    id: '2026-10-18-codex-turn-liveness',
    cliVersion: '0.2.174',
    date: '2026-10-18',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct18a.title',
    summaryKey: 'changelog.releases.oct18a.summary',
    itemKeys: ['changelog.releases.oct18a.spinner', 'changelog.releases.oct18a.errors', 'changelog.releases.oct18a.long'],
  },
  {
    id: '2026-10-18-session-sharing',
    date: '2026-10-18',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct18.title',
    summaryKey: 'changelog.releases.oct18.summary',
    itemKeys: [
      'changelog.releases.oct18.share',
      'changelog.releases.oct18.driver',
      'changelog.releases.oct18.revoke',
      'changelog.releases.oct18.oidc',
      'changelog.releases.oct18.people',
      'changelog.releases.oct18.profile',
    ],
  },
  {
    id: '2026-10-16-reading-images-diffs',
    date: '2026-10-16',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct16.title',
    summaryKey: 'changelog.releases.oct16.summary',
    itemKeys: [
      'changelog.releases.oct16.scroll',
      'changelog.releases.oct16.history',
      'changelog.releases.oct16.images',
      'changelog.releases.oct16.diff',
      'changelog.releases.oct16.panel',
      'changelog.releases.oct16.smooth',
      'changelog.releases.oct16.look',
    ],
  },
  {
    id: '2026-10-15-cli-import-recent',
    cliVersion: '0.2.173',
    date: '2026-10-15',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct15b.title',
    summaryKey: 'changelog.releases.oct15b.summary',
    itemKeys: ['changelog.releases.oct15b.recent'],
  },
  {
    id: '2026-10-15-reading-while-history-loads',
    date: '2026-10-15',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct15.title',
    summaryKey: 'changelog.releases.oct15.summary',
    itemKeys: ['changelog.releases.oct15.scroll'],
  },
  {
    id: '2026-10-14-side-panel-history',
    date: '2026-10-14',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct14c.title',
    summaryKey: 'changelog.releases.oct14c.summary',
    itemKeys: ['changelog.releases.oct14c.panel', 'changelog.releases.oct14c.actions'],
  },
  {
    id: '2026-10-14-paste-fix',
    date: '2026-10-14',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct14b.title',
    summaryKey: 'changelog.releases.oct14b.summary',
    itemKeys: ['changelog.releases.oct14b.scroll', 'changelog.releases.oct14b.importAgain', 'changelog.releases.oct14b.iosBar', 'changelog.releases.oct14b.paste'],
  },
  {
    id: '2026-10-14-pi-install-hints',
    cliVersion: '0.2.169',
    date: '2026-10-14',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct14.title',
    summaryKey: 'changelog.releases.oct14.summary',
    itemKeys: ['changelog.releases.oct14.cli', 'changelog.releases.oct14.web'],
  },
  {
    id: '2026-10-13-scroll-and-strip-fixes',
    date: '2026-10-13',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct13e.title',
    summaryKey: 'changelog.releases.oct13e.summary',
    itemKeys: ['changelog.releases.oct13e.scroll'],
  },
  {
    id: '2026-10-13-help-and-safer-archive',
    date: '2026-10-13',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct13d.title',
    summaryKey: 'changelog.releases.oct13d.summary',
    itemKeys: ['changelog.releases.oct13d.help', 'changelog.releases.oct13d.archive', 'changelog.releases.oct13d.clipboard'],
  },
  {
    id: '2026-10-13-worktrees-and-hibernation',
    cliVersion: '0.2.168',
    date: '2026-10-13',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct13c.title',
    summaryKey: 'changelog.releases.oct13c.summary',
    itemKeys: ['changelog.releases.oct13c.worktree', 'changelog.releases.oct13c.setup', 'changelog.releases.oct13c.hibernate', 'changelog.releases.oct13c.cli'],
  },
  {
    id: '2026-10-13-review-and-reading',
    date: '2026-10-13',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct13b.title',
    summaryKey: 'changelog.releases.oct13b.summary',
    itemKeys: ['changelog.releases.oct13b.review', 'changelog.releases.oct13b.git', 'changelog.releases.oct13b.approvals', 'changelog.releases.oct13b.reading', 'changelog.releases.oct13b.navigate', 'changelog.releases.oct13b.terminal', 'changelog.releases.oct13b.notify', 'changelog.releases.oct13b.undo', 'changelog.releases.oct13b.fontSize'],
  },
  {
    id: '2026-10-13-web-workbench',
    date: '2026-10-13',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct13a.title',
    summaryKey: 'changelog.releases.oct13a.summary',
    itemKeys: ['changelog.releases.oct13a.palette', 'changelog.releases.oct13a.board', 'changelog.releases.oct13a.diff', 'changelog.releases.oct13a.termSearch', 'changelog.releases.oct13a.status', 'changelog.releases.oct13a.badge', 'changelog.releases.oct13a.subagents'],
  },
  {
    id: '2026-10-13-agent-files-and-automations',
    cliVersion: '0.2.166',
    date: '2026-10-13',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct13.title',
    summaryKey: 'changelog.releases.oct13.summary',
    itemKeys: ['changelog.releases.oct13.download', 'changelog.releases.oct13.search', 'changelog.releases.oct13.precheck', 'changelog.releases.oct13.limits', 'changelog.releases.oct13.hooks', 'changelog.releases.oct13.scrollback', 'changelog.releases.oct13.progress', 'changelog.releases.oct13.cli'],
  },
  {
    id: '2026-10-11-restart-keeps-edits',
    cliVersion: '0.2.165',
    date: '2026-10-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct11b.title',
    summaryKey: 'changelog.releases.oct11b.summary',
    itemKeys: ['changelog.releases.oct11b.restart'],
  },
  {
    id: '2026-10-11-edit-stays-in-sync',
    cliVersion: '0.2.164',
    date: '2026-10-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct11a.title',
    summaryKey: 'changelog.releases.oct11a.summary',
    itemKeys: ['changelog.releases.oct11a.edit', 'changelog.releases.oct11a.sdk'],
  },
  {
    id: '2026-10-11-rpc-duplicate-socket',
    cliVersion: '0.2.164',
    date: '2026-10-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct11.title',
    summaryKey: 'changelog.releases.oct11.summary',
    itemKeys: ['changelog.releases.oct11.rpc'],
  },
  {
    id: '2026-10-10-ios-home-screen-height',
    date: '2026-10-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct10a.title',
    summaryKey: 'changelog.releases.oct10a.summary',
    itemKeys: ['changelog.releases.oct10a.height'],
  },
  {
    id: '2026-10-10-unseen-badge',
    date: '2026-10-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct10.title',
    summaryKey: 'changelog.releases.oct10.summary',
    itemKeys: ['changelog.releases.oct10.badge'],
  },
  {
    id: '2026-10-07-compact-boundary',
    date: '2026-10-07',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct07.title',
    summaryKey: 'changelog.releases.oct07.summary',
    itemKeys: ['changelog.releases.oct07.compact'],
  },
  {
    id: '2026-10-06-preview-side-panel',
    date: '2026-10-06',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct06.title',
    summaryKey: 'changelog.releases.oct06.summary',
    itemKeys: ['changelog.releases.oct06.dock'],
  },
  {
    id: '2026-10-05-composer-keys-and-status',
    date: '2026-10-05',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct05.title',
    summaryKey: 'changelog.releases.oct05.summary',
    itemKeys: ['changelog.releases.oct05.enter', 'changelog.releases.oct05.presets', 'changelog.releases.oct05.notifications', 'changelog.releases.oct05.background'],
  },
  {
    id: '2026-10-04-fork-first-message-order',
    cliVersion: '0.2.163',
    date: '2026-10-04',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct04.title',
    summaryKey: 'changelog.releases.oct04.summary',
    itemKeys: ['changelog.releases.oct04.order', 'changelog.releases.oct04.timeout'],
  },
  {
    id: '2026-10-03-context-window-1m',
    date: '2026-10-03',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct03a.title',
    summaryKey: 'changelog.releases.oct03a.summary',
    itemKeys: ['changelog.releases.oct03a.window'],
  },
  {
    id: '2026-10-03-edit-delete-in-place',
    cliVersion: '0.2.162',
    date: '2026-10-03',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct03.title',
    summaryKey: 'changelog.releases.oct03.summary',
    itemKeys: ['changelog.releases.oct03.edit', 'changelog.releases.oct03.delete', 'changelog.releases.oct03.limits', 'changelog.releases.oct03.codexImport'],
  },
  {
    id: '2026-10-02-stop-background-task',
    date: '2026-10-02',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct02a.title',
    summaryKey: 'changelog.releases.oct02a.summary',
    itemKeys: ['changelog.releases.oct02a.stop', 'changelog.releases.oct02a.route'],
  },
  {
    id: '2026-10-02-chat-order-and-background-tasks',
    date: '2026-10-02',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.oct02.title',
    summaryKey: 'changelog.releases.oct02.summary',
    itemKeys: ['changelog.releases.oct02.background', 'changelog.releases.oct02.order', 'changelog.releases.oct02.queue', 'changelog.releases.oct02.suggestions', 'changelog.releases.oct02.priority', 'changelog.releases.oct02.date', 'changelog.releases.oct02.chime', 'changelog.releases.oct02.preview'],
  },
  {
    id: '2026-09-30-optimistic-new-session',
    date: '2026-09-30',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep30b.title',
    summaryKey: 'changelog.releases.sep30b.summary',
    itemKeys: ['changelog.releases.sep30b.instant', 'changelog.releases.sep30b.queue', 'changelog.releases.sep30b.mode', 'changelog.releases.sep30b.failure'],
  },
  {
    id: '2026-09-30-claude-prewarm',
    cliVersion: '0.2.161',
    date: '2026-09-30',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep30a.title',
    summaryKey: 'changelog.releases.sep30a.summary',
    itemKeys: ['changelog.releases.sep30a.prewarm', 'changelog.releases.sep30a.fallback', 'changelog.releases.sep30a.off', 'changelog.releases.sep30a.start'],
  },
  {
    id: '2026-09-30-fast-session-and-send',
    cliVersion: '0.2.160',
    date: '2026-09-30',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep30.title',
    summaryKey: 'changelog.releases.sep30.summary',
    itemKeys: ['changelog.releases.sep30.start', 'changelog.releases.sep30.sending', 'changelog.releases.sep30.failed', 'changelog.releases.sep30.hover'],
  },
  {
    id: '2026-09-27-server-prompt-queue',
    cliVersion: '0.2.159',
    date: '2026-09-27',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep27b.title',
    summaryKey: 'changelog.releases.sep27b.summary',
    itemKeys: ['changelog.releases.sep27b.server', 'changelog.releases.sep27b.order', 'changelog.releases.sep27b.offline', 'changelog.releases.sep27b.compat'],
  },
  {
    id: '2026-09-27-attention-lifecycle',
    cliVersion: '0.2.158',
    date: '2026-09-27',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep27.title',
    summaryKey: 'changelog.releases.sep27.summary',
    itemKeys: ['changelog.releases.sep27.auto', 'changelog.releases.sep27.session', 'changelog.releases.sep27.band', 'changelog.releases.sep27.cli'],
  },
  {
    id: '2026-09-25-background-task-state',
    cliVersion: '0.2.157',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25o.title',
    summaryKey: 'changelog.releases.sep25o.summary',
    itemKeys: ['changelog.releases.sep25o.status', 'changelog.releases.sep25o.cli', 'changelog.releases.sep25o.automations', 'changelog.releases.sep25o.update'],
  },
  {
    id: '2026-09-25-cross-machine-session-ops',
    cliVersion: '0.2.157',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25n.title',
    summaryKey: 'changelog.releases.sep25n.summary',
    itemKeys: ['changelog.releases.sep25n.reach', 'changelog.releases.sep25n.list', 'changelog.releases.sep25n.tools', 'changelog.releases.sep25n.keys', 'changelog.releases.sep25n.guard'],
  },
  {
    id: '2026-09-25-infra-exit-never-archives',
    cliVersion: '0.2.156',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25m.title',
    summaryKey: 'changelog.releases.sep25m.summary',
    itemKeys: ['changelog.releases.sep25m.offline', 'changelog.releases.sep25m.systemd', 'changelog.releases.sep25m.list'],
  },
  {
    id: '2026-09-25-automations-entry-always-there',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25l.title',
    summaryKey: 'changelog.releases.sep25l.summary',
    itemKeys: ['changelog.releases.sep25l.entry', 'changelog.releases.sep25l.recheck', 'changelog.releases.sep25l.teams'],
  },
  {
    id: '2026-09-25-session-peer-messaging',
    cliVersion: '0.2.155',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25k.title',
    summaryKey: 'changelog.releases.sep25k.summary',
    itemKeys: ['changelog.releases.sep25k.message', 'changelog.releases.sep25k.peers', 'changelog.releases.sep25k.conflict', 'changelog.releases.sep25k.cards'],
  },
  {
    id: '2026-09-25-send-status-open-gates-auto-latest',
    cliVersion: '0.2.154',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25j.title',
    summaryKey: 'changelog.releases.sep25j.summary',
    itemKeys: ['changelog.releases.sep25j.send', 'changelog.releases.sep25j.resume', 'changelog.releases.sep25j.open', 'changelog.releases.sep25j.cap', 'changelog.releases.sep25j.auto'],
  },
  {
    id: '2026-09-25-builtin-tool-cards',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25i.title',
    summaryKey: 'changelog.releases.sep25i.summary',
    itemKeys: ['changelog.releases.sep25i.rows', 'changelog.releases.sep25i.cards', 'changelog.releases.sep25i.runners'],
  },
  {
    id: '2026-09-25-pi-terminal-tabs-name-themselves',
    cliVersion: '0.2.153',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25h.title',
    summaryKey: 'changelog.releases.sep25h.summary',
    itemKeys: ['changelog.releases.sep25h.name', 'changelog.releases.sep25h.manual'],
  },
  {
    id: '2026-09-25-automations-in-the-web-app',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25g.title',
    summaryKey: 'changelog.releases.sep25g.summary',
    itemKeys: ['changelog.releases.sep25g.decide', 'changelog.releases.sep25g.manage', 'changelog.releases.sep25g.docs'],
  },
  {
    id: '2026-09-25-automations-scheduled-and-triggered-runs',
    cliVersion: '0.2.152',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25f.title',
    summaryKey: 'changelog.releases.sep25f.summary',
    itemKeys: ['changelog.releases.sep25f.triggers', 'changelog.releases.sep25f.cli', 'changelog.releases.sep25f.agents', 'changelog.releases.sep25f.runs'],
  },
  {
    id: '2026-09-25-quieter-heartbeats-cached-assets',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25e.title',
    summaryKey: 'changelog.releases.sep25e.summary',
    itemKeys: ['changelog.releases.sep25e.heartbeat', 'changelog.releases.sep25e.assets'],
  },
  {
    id: '2026-09-25-live-updates-survive-reconnect-storm',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25d.title',
    summaryKey: 'changelog.releases.sep25d.summary',
    itemKeys: ['changelog.releases.sep25d.relay'],
  },
  {
    id: '2026-09-25-cli-spawn-fork-and-leaner-prompt',
    cliVersion: '0.2.151',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25c.title',
    summaryKey: 'changelog.releases.sep25c.summary',
    itemKeys: ['changelog.releases.sep25c.prompt', 'changelog.releases.sep25c.commit', 'changelog.releases.sep25c.spawn', 'changelog.releases.sep25c.read'],
  },
  {
    id: '2026-09-25-per-visitor-sign-in-limits',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25b.title',
    summaryKey: 'changelog.releases.sep25b.summary',
    itemKeys: ['changelog.releases.sep25b.limits'],
  },
  {
    id: '2026-09-25-signed-out-stops-sync',
    date: '2026-09-25',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep25a.title',
    summaryKey: 'changelog.releases.sep25a.summary',
    itemKeys: ['changelog.releases.sep25a.prompt', 'changelog.releases.sep25a.retries'],
  },
  {
    id: '2026-09-24-update-into-running-copy',
    cliVersion: '0.2.150',
    date: '2026-09-24',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep24b.title',
    summaryKey: 'changelog.releases.sep24b.summary',
    itemKeys: ['changelog.releases.sep24b.install', 'changelog.releases.sep24b.notice', 'changelog.releases.sep24b.doctor'],
  },
  {
    id: '2026-09-24-opus-5-5-default',
    cliVersion: '0.2.149',
    date: '2026-09-24',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep24a.title',
    summaryKey: 'changelog.releases.sep24a.summary',
    itemKeys: ['changelog.releases.sep24a.opus', 'changelog.releases.sep24a.codex', 'changelog.releases.sep24a.notice'],
  },
  {
    id: '2026-09-23-terminals-without-tmux',
    cliVersion: '0.2.148',
    date: '2026-09-23',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep23a.title',
    summaryKey: 'changelog.releases.sep23a.summary',
    itemKeys: ['changelog.releases.sep23a.listed', 'changelog.releases.sep23a.install'],
  },
  {
    id: '2026-09-22-side-question-in-process',
    cliVersion: '0.2.147',
    date: '2026-09-22',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep22b.title',
    summaryKey: 'changelog.releases.sep22b.summary',
    itemKeys: ['changelog.releases.sep22b.live', 'changelog.releases.sep22b.fallback'],
  },
  {
    id: '2026-09-22-side-question-answers-as-itself',
    cliVersion: '0.2.146',
    date: '2026-09-22',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep22a.title',
    summaryKey: 'changelog.releases.sep22a.summary',
    itemKeys: ['changelog.releases.sep22a.answer', 'changelog.releases.sep22a.retry'],
  },
  {
    id: '2026-09-22-agent-home-dirs',
    cliVersion: '0.2.144',
    date: '2026-09-22',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep22.title',
    summaryKey: 'changelog.releases.sep22.summary',
    itemKeys: ['changelog.releases.sep22.shell', 'changelog.releases.sep22.pin'],
  },
  {
    id: '2026-09-20-stale-wrapper-notice',
    date: '2026-09-20',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep20a.title',
    summaryKey: 'changelog.releases.sep20a.summary',
    itemKeys: ['changelog.releases.sep20a.delivery', 'changelog.releases.sep20a.dismiss'],
  },
  {
    id: '2026-09-20-daemon-crash-recovery',
    cliVersion: '0.2.143',
    date: '2026-09-20',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep20.title',
    summaryKey: 'changelog.releases.sep20.summary',
    itemKeys: ['changelog.releases.sep20.ack', 'changelog.releases.sep20.restart'],
  },
  {
    id: '2026-09-18-pi-terminal-tools-history',
    cliVersion: '0.2.142',
    date: '2026-09-18',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep18.title',
    summaryKey: 'changelog.releases.sep18.summary',
    itemKeys: ['changelog.releases.sep18.pi', 'changelog.releases.sep18.history'],
  },
  {
    id: '2026-09-15-hover-time-and-offline-terminals',
    date: '2026-09-15',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep15d.title',
    summaryKey: 'changelog.releases.sep15d.summary',
    itemKeys: ['changelog.releases.sep15d.time', 'changelog.releases.sep15d.offline'],
  },
  {
    id: '2026-09-15-stop-background-tasks',
    cliVersion: '0.2.141',
    date: '2026-09-15',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep15c.title',
    summaryKey: 'changelog.releases.sep15c.summary',
    itemKeys: ['changelog.releases.sep15c.tasks', 'changelog.releases.sep15c.attach'],
  },
  {
    id: '2026-09-15-cli-update-banner-dismiss',
    date: '2026-09-15',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep15b.title',
    summaryKey: 'changelog.releases.sep15b.summary',
    itemKeys: ['changelog.releases.sep15b.dismiss'],
  },
  {
    id: '2026-09-15-voice-packs',
    date: '2026-09-15',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep15a.title',
    summaryKey: 'changelog.releases.sep15a.summary',
    itemKeys: ['changelog.releases.sep15a.packs', 'changelog.releases.sep15a.fallback'],
  },
  {
    id: '2026-09-15-stopped-turn-marker',
    cliVersion: '0.2.140',
    date: '2026-09-15',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep15.title',
    summaryKey: 'changelog.releases.sep15.summary',
    itemKeys: ['changelog.releases.sep15.marker'],
  },
  {
    id: '2026-09-14-chat-scroll-over-command-output',
    date: '2026-09-14',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep14a.title',
    summaryKey: 'changelog.releases.sep14a.summary',
    itemKeys: ['changelog.releases.sep14a.scroll'],
  },
  {
    id: '2026-09-14-codex-history-import',
    cliVersion: '0.2.139',
    date: '2026-09-14',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep14.title',
    summaryKey: 'changelog.releases.sep14.summary',
    itemKeys: ['changelog.releases.sep14.codex', 'changelog.releases.sep14.todos', 'changelog.releases.sep14.status', 'changelog.releases.sep14.update'],
  },
  {
    id: '2026-09-13-codex-idle-release',
    cliVersion: '0.2.138',
    date: '2026-09-13',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep13a.title',
    summaryKey: 'changelog.releases.sep13a.summary',
    itemKeys: ['changelog.releases.sep13a.release', 'changelog.releases.sep13a.resume'],
  },
  {
    id: '2026-09-13-relay-message-never-dropped',
    cliVersion: '0.2.137',
    date: '2026-09-13',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep13.title',
    summaryKey: 'changelog.releases.sep13.summary',
    itemKeys: ['changelog.releases.sep13.echo', 'changelog.releases.sep13.log'],
  },
  {
    id: '2026-09-12-abort-keeps-session',
    cliVersion: '0.2.136',
    date: '2026-09-12',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep12a.title',
    summaryKey: 'changelog.releases.sep12a.summary',
    itemKeys: ['changelog.releases.sep12a.stop', 'changelog.releases.sep12a.restore'],
  },
  {
    id: '2026-09-12-edit-message-inline-resend',
    date: '2026-09-12',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep12b.title',
    summaryKey: 'changelog.releases.sep12b.summary',
    itemKeys: ['changelog.releases.sep12b.resend'],
  },
  {
    id: '2026-09-12-faster-new-chat-html-preview',
    date: '2026-09-12',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep12.title',
    summaryKey: 'changelog.releases.sep12.summary',
    itemKeys: ['changelog.releases.sep12.background', 'changelog.releases.sep12.html'],
  },
  {
    id: '2026-09-11-send-relay-effort',
    date: '2026-09-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep11e.title',
    summaryKey: 'changelog.releases.sep11e.summary',
    itemKeys: ['changelog.releases.sep11e.send', 'changelog.releases.sep11e.relay', 'changelog.releases.sep11e.effort'],
  },
  {
    id: '2026-09-11-in-app-media-preview',
    date: '2026-09-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep11d.title',
    summaryKey: 'changelog.releases.sep11d.summary',
    itemKeys: ['changelog.releases.sep11d.images', 'changelog.releases.sep11d.skills'],
  },
  {
    id: '2026-09-11-visible-message-actions',
    date: '2026-09-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep11c.title',
    summaryKey: 'changelog.releases.sep11c.summary',
    itemKeys: ['changelog.releases.sep11c.actions', 'changelog.releases.sep11c.time'],
  },
  {
    id: '2026-09-11-conversation-row-alignment',
    date: '2026-09-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep11b.title',
    summaryKey: 'changelog.releases.sep11b.summary',
    itemKeys: ['changelog.releases.sep11b.alignment', 'changelog.releases.sep11b.thinking'],
  },
  {
    id: '2026-09-11-inline-status-message-time',
    date: '2026-09-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep11a.title',
    summaryKey: 'changelog.releases.sep11a.summary',
    itemKeys: ['changelog.releases.sep11a.activity', 'changelog.releases.sep11a.timestamps'],
  },
  {
    id: '2026-09-11-subagents-runtime-controls',
    cliVersion: '0.2.135',
    date: '2026-09-11',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep11.title',
    summaryKey: 'changelog.releases.sep11.summary',
    itemKeys: ['changelog.releases.sep11.subagents', 'changelog.releases.sep11.previews', 'changelog.releases.sep11.controls', 'changelog.releases.sep11.updates', 'changelog.releases.sep11.polish'],
  },
  {
    id: '2026-09-10-chat-polish-recovery',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10r.title',
    summaryKey: 'changelog.releases.sep10r.summary',
    itemKeys: ['changelog.releases.sep10r.activity', 'changelog.releases.sep10r.polish', 'changelog.releases.sep10r.recovery'],
  },
  {
    id: '2026-09-10-unified-agent-status',
    cliVersion: '0.2.134',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10q.title',
    summaryKey: 'changelog.releases.sep10q.summary',
    itemKeys: ['changelog.releases.sep10q.sidebar', 'changelog.releases.sep10q.detection'],
  },
  {
    id: '2026-09-10-right-workspace-polish',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10p.title',
    summaryKey: 'changelog.releases.sep10p.summary',
    itemKeys: ['changelog.releases.sep10p.workspace', 'changelog.releases.sep10p.motion'],
  },
  {
    id: '2026-09-10-sidebar-status-alignment',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10o.title',
    summaryKey: 'changelog.releases.sep10o.summary',
    itemKeys: ['changelog.releases.sep10o.alignment'],
  },
  {
    id: '2026-09-10-file-code-surface',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10n.title',
    summaryKey: 'changelog.releases.sep10n.summary',
    itemKeys: ['changelog.releases.sep10n.surface'],
  },
  {
    id: '2026-09-10-workspace-seam',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10m.title',
    summaryKey: 'changelog.releases.sep10m.summary',
    itemKeys: ['changelog.releases.sep10m.surface'],
  },
  {
    id: '2026-09-10-file-preview-actions',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10l.title',
    summaryKey: 'changelog.releases.sep10l.summary',
    itemKeys: ['changelog.releases.sep10l.files', 'changelog.releases.sep10l.workbooks'],
  },
  {
    id: '2026-09-10-contextual-new-chat',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10k.title',
    summaryKey: 'changelog.releases.sep10k.summary',
    itemKeys: ['changelog.releases.sep10k.workspace', 'changelog.releases.sep10k.context'],
  },
  {
    id: '2026-09-10-sidebar-harmony',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10j.title',
    summaryKey: 'changelog.releases.sep10j.summary',
    itemKeys: ['changelog.releases.sep10j.layout', 'changelog.releases.sep10j.details'],
  },
  {
    id: '2026-09-10-workspace-typography',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10i.title',
    summaryKey: 'changelog.releases.sep10i.summary',
    itemKeys: ['changelog.releases.sep10i.density', 'changelog.releases.sep10i.mobile'],
  },
  {
    id: '2026-09-10-loading-cli-recommendation',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10h.title',
    summaryKey: 'changelog.releases.sep10h.summary',
    itemKeys: ['changelog.releases.sep10h.spacing', 'changelog.releases.sep10h.release'],
  },
  {
    id: '2026-09-10-cli-manual-update',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.133',
    titleKey: 'changelog.releases.sep10g.title',
    summaryKey: 'changelog.releases.sep10g.summary',
    itemKeys: ['changelog.releases.sep10g.action', 'changelog.releases.sep10g.compatibility'],
  },
  {
    id: '2026-09-10-transcript-activity',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10f.title',
    summaryKey: 'changelog.releases.sep10f.summary',
    itemKeys: ['changelog.releases.sep10f.alignment', 'changelog.releases.sep10f.activity'],
  },
  {
    id: '2026-09-10-team-default-permissions',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10e.title',
    summaryKey: 'changelog.releases.sep10e.summary',
    itemKeys: ['changelog.releases.sep10e.default', 'changelog.releases.sep10e.control'],
  },
  {
    id: '2026-09-10-user-message-polish',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10d.title',
    summaryKey: 'changelog.releases.sep10d.summary',
    itemKeys: ['changelog.releases.sep10d.bubbles', 'changelog.releases.sep10d.mobile'],
  },
  {
    id: '2026-09-10-team-start-recovery',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.132',
    titleKey: 'changelog.releases.sep10c.title', summaryKey: 'changelog.releases.sep10c.summary',
    itemKeys: ['changelog.releases.sep10c.start', 'changelog.releases.sep10c.members', 'changelog.releases.sep10c.chat'],
  },
  {
    id: '2026-09-10-onboarding-feedback',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10b.title',
    summaryKey: 'changelog.releases.sep10b.summary',
    itemKeys: ['changelog.releases.sep10b.guide', 'changelog.releases.sep10b.mobile', 'changelog.releases.sep10b.feedback'],
  },
  {
    id: '2026-09-10-workspace-polish',
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.131',
    titleKey: 'changelog.releases.sep10a.title',
    summaryKey: 'changelog.releases.sep10a.summary',
    itemKeys: ['changelog.releases.sep10a.layout', 'changelog.releases.sep10a.files', 'changelog.releases.sep10a.teams', 'changelog.releases.sep10a.context'],
  },
  {
    id: '2026-09-10-compact-workspace',
    featured: true,
    date: '2026-09-10',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep10.title',
    summaryKey: 'changelog.releases.sep10.summary',
    itemKeys: ['changelog.releases.sep10.workspace', 'changelog.releases.sep10.tabs', 'changelog.releases.sep10.progress', 'changelog.releases.sep10.mobile', 'changelog.releases.sep10.stability'],
  },
  {
    id: '2026-09-09-inline-edit-composer',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09k.title',
    summaryKey: 'changelog.releases.sep09k.summary',
    itemKeys: ['changelog.releases.sep09k.composer', 'changelog.releases.sep09k.queue', 'changelog.releases.sep09k.edit', 'changelog.releases.sep09k.actions'],
  },
  {
    id: '2026-09-09-live-status-usage',
    cliVersion: '0.2.130',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09j.title',
    summaryKey: 'changelog.releases.sep09j.summary',
    itemKeys: ['changelog.releases.sep09j.usage', 'changelog.releases.sep09j.motion'],
  },
  {
    id: '2026-09-09-chat-reading-polish',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09i.title',
    summaryKey: 'changelog.releases.sep09i.summary',
    itemKeys: ['changelog.releases.sep09i.reading', 'changelog.releases.sep09i.controls'],
  },
  {
    id: '2026-09-09-compact-model-effort',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09y.title',
    summaryKey: 'changelog.releases.sep09y.summary',
    itemKeys: ['changelog.releases.sep09y.controls'],
  },
  {
    id: '2026-09-09-agent-chat-inputs',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.129',
    titleKey: 'changelog.releases.sep09x.title',
    summaryKey: 'changelog.releases.sep09x.summary',
    itemKeys: ['changelog.releases.sep09x.attachments', 'changelog.releases.sep09x.reasoning', 'changelog.releases.sep09x.defaults'],
  },
  {
    id: '2026-09-09-hub-and-teams',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09w.title',
    summaryKey: 'changelog.releases.sep09w.summary',
    itemKeys: ['changelog.releases.sep09w.hub', 'changelog.releases.sep09w.teams'],
  },
  {
    id: '2026-09-09-teams-brand',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09v.title',
    summaryKey: 'changelog.releases.sep09v.summary',
    itemKeys: ['changelog.releases.sep09v.story', 'changelog.releases.sep09v.naming'],
  },
  {
    id: '2026-09-09-team-launch-recovery',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.128',
    titleKey: 'changelog.releases.sep09u.title',
    summaryKey: 'changelog.releases.sep09u.summary',
    itemKeys: ['changelog.releases.sep09u.recovery'],
  },
  {
    id: '2026-09-09-optional-team-first-use',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.127',
    titleKey: 'changelog.releases.sep09t.title',
    summaryKey: 'changelog.releases.sep09t.summary',
    itemKeys: ['changelog.releases.sep09t.start', 'changelog.releases.sep09t.history', 'changelog.releases.sep09t.results'],
  },
  {
    id: '2026-09-09-todo-agent-skill',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.127',
    titleKey: 'changelog.releases.sep09h.title',
    summaryKey: 'changelog.releases.sep09h.summary',
    itemKeys: ['changelog.releases.sep09h.copy', 'changelog.releases.sep09h.commands'],
  },
  {
    id: '2026-09-09-cli-auto-update-notice',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09g.title',
    summaryKey: 'changelog.releases.sep09g.summary',
    itemKeys: ['changelog.releases.sep09g.automatic', 'changelog.releases.sep09g.recovery'],
  },
  {
    id: '2026-09-09-happy-bot-workspace',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09f.title',
    summaryKey: 'changelog.releases.sep09f.summary',
    itemKeys: ['changelog.releases.sep09f.workspace', 'changelog.releases.sep09f.navigation', 'changelog.releases.sep09f.onboarding'],
  },
  {
    id: '2026-09-09-teams-execution-and-messages',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.126',
    titleKey: 'changelog.releases.sep09e.title',
    summaryKey: 'changelog.releases.sep09e.summary',
    itemKeys: ['changelog.releases.sep09e.permissions', 'changelog.releases.sep09e.messages'],
  },
  {
    id: '2026-09-09-todo-skill-navigation',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09d.title',
    summaryKey: 'changelog.releases.sep09d.summary',
    itemKeys: ['changelog.releases.sep09d.document'],
  },
  {
    id: '2026-09-09-builtin-todos',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09a.title',
    summaryKey: 'changelog.releases.sep09a.summary',
    itemKeys: ['changelog.releases.sep09a.builtin', 'changelog.releases.sep09a.sources', 'changelog.releases.sep09a.safety'],
  },
  {
    id: '2026-09-09-migration-session-recovery',
    date: '2026-09-09',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09c.title',
    summaryKey: 'changelog.releases.sep09c.summary',
    itemKeys: ['changelog.releases.sep09c.connection'],
  },
  {
    id: '2026-09-09-official-agent-teams',
    date: '2026-09-09',
    cliVersion: '0.2.125',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09b.title',
    summaryKey: 'changelog.releases.sep09b.summary',
    itemKeys: ['changelog.releases.sep09b.teams', 'changelog.releases.sep09b.recovery', 'changelog.releases.sep09b.schedules', 'changelog.releases.sep09b.setup'],
  },
  {
    id: '2026-09-09-message-actions-and-discovery',
    date: '2026-09-09',
    cliVersion: '0.2.124',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep09.title',
    summaryKey: 'changelog.releases.sep09.summary',
    itemKeys: ['changelog.releases.sep09.messages', 'changelog.releases.sep09.ordering', 'changelog.releases.sep09.setup', 'changelog.releases.sep09.symbols'],
  },
  {
    id: '2026-09-08-connection-recovery-and-update-status',
    date: '2026-09-08',
    cliVersion: '0.2.123',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep08k.title',
    summaryKey: 'changelog.releases.sep08k.summary',
    itemKeys: ['changelog.releases.sep08k.resume', 'changelog.releases.sep08k.updates', 'changelog.releases.sep08k.metrics'],
  },
  {
    id: '2026-09-08-connection-diagnostics',
        cliVersion: '0.2.122',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep08j.title',
    summaryKey: 'changelog.releases.sep08j.summary',
    itemKeys: ['changelog.releases.sep08j.fallback', 'changelog.releases.sep08j.diagnostics'],
  },
  {
    id: '2026-09-08-pi-agent-defaults',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    // web-only: the pi runner already speaks Claude's permission keys and
    // publishes its own model list; only the web was filing pi under claude.
    titleKey: 'changelog.releases.sep08a.title',
    summaryKey: 'changelog.releases.sep08a.summary',
    itemKeys: [
      'changelog.releases.sep08a.settings',
      'changelog.releases.sep08a.selectors',
    ],
  },
  {
    id: '2026-09-08-pi-sessions-stream-live',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    // CLI-only fix (B-371): the web's live-draft receiver shipped with B-309
    // and needs no change; the ACP runner simply never sent frames. The
    // version is the CLI release that carries it.
    cliVersion: '0.2.121',
    titleKey: 'changelog.releases.sep08b.title',
    summaryKey: 'changelog.releases.sep08b.summary',
    itemKeys: [
      'changelog.releases.sep08b.text',
      'changelog.releases.sep08b.thinking',
    ],
  },
  {
    id: '2026-09-08-terminal-stays-on-last-line',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    // web-only: the daemon and tmux were fine; xterm in the browser misread a
    // layout-induced scroll clamp as the user scrolling up (B-374).
    titleKey: 'changelog.releases.sep08d.title',
    summaryKey: 'changelog.releases.sep08d.summary',
    itemKeys: [
      'changelog.releases.sep08d.follow',
      'changelog.releases.sep08d.history',
    ],
  },
  {
    id: '2026-09-08-queued-message-tombstones',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    // Both halves: the CLI now reports queued input it destroyed; the web shows
    // the message with the reason instead of losing it. cliVersion is filled
    // in by the release that ships the CLI half (B-332).
    titleKey: 'changelog.releases.sep08g.title',
    summaryKey: 'changelog.releases.sep08g.summary',
    itemKeys: [
      'changelog.releases.sep08g.tombstone',
      'changelog.releases.sep08g.restart',
    ],
  },
  {
    id: '2026-09-08-idle-cpu-compositor-probe',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    // Web half (ui.css pulse) ships with this web build; the CLI half
    // (keep-alive probe throttle) lands in the next CLI release — the
    // publish workflow sets cliVersion then, as with other two-part entries.
    titleKey: 'changelog.releases.sep08c.title',
    summaryKey: 'changelog.releases.sep08c.summary',
    itemKeys: ['changelog.releases.sep08c.pulse', 'changelog.releases.sep08c.probe'],
  },
  {
    id: '2026-09-08-pi-session-stays-live',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    // CLI-only fix (B-376): the web's liveness channel is the two-second
    // keepAlive, and the ACP runner used to release it mid-turn whenever the
    // backend's text-gap heuristic reported idle — so the web folded the turn
    // and dropped the running bar while pi was still working. Ships in the
    // same CLI release as B-371 below; bump this if it is released separately.
    cliVersion: '0.2.121',
    titleKey: 'changelog.releases.sep08e.title',
    summaryKey: 'changelog.releases.sep08e.summary',
    itemKeys: [
      'changelog.releases.sep08e.running',
    ],
  },
  {
    id: '2026-09-08-rpc-rate-limit-backoff',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    // The CLI half is `sessions approve/deny` honouring retryAfterMs; rides
    // the next CLI tag after 0.2.120. If a sibling branch publishes 0.2.121
    // first, bump this at landing (AGENTS 铁律 6: published tags are immutable).
    cliVersion: '0.2.121',
    titleKey: 'changelog.releases.sep08f.title',
    summaryKey: 'changelog.releases.sep08f.summary',
    itemKeys: [
      'changelog.releases.sep08f.source',
      'changelog.releases.sep08f.backoff',
      'changelog.releases.sep08f.server',
    ],
  },
  {
    id: '2026-09-08-undefined-css-tokens',
    date: '2026-09-08',
    buildVersion: __APP_VERSION__,
    // web-only: CSS tokens, no CLI half.
    titleKey: 'changelog.releases.sep08.title',
    summaryKey: 'changelog.releases.sep08.summary',
    itemKeys: [
      'changelog.releases.sep08.states',
      'changelog.releases.sep08.guard',
    ],
  },
  {
    id: '2026-09-07-terminal-keyboard-keeps-columns',
    date: '2026-09-07',
    buildVersion: __APP_VERSION__,
    // web-only: the daemon/tmux side was behaving correctly; the phone was
    // sending it a different column count on every keyboard open/close.
    titleKey: 'changelog.releases.sep07a.title',
    summaryKey: 'changelog.releases.sep07a.summary',
    itemKeys: [
      'changelog.releases.sep07a.columns',
      'changelog.releases.sep07a.seam',
    ],
  },
  {
    id: '2026-09-07-acp-model-selector-truth',
    date: '2026-09-07',
    buildVersion: __APP_VERSION__,
    // web-only: the CLI already publishes the running model for ACP sessions.
    titleKey: 'changelog.releases.sep07.title',
    summaryKey: 'changelog.releases.sep07.summary',
    itemKeys: [
      'changelog.releases.sep07.model',
    ],
  },
  {
    id: '2026-09-06-replaced-machine-entries',
    date: '2026-09-06',
    buildVersion: __APP_VERSION__,
    // web-only: no CLI half. The rule reads metadata only the client can
    // decrypt, so it works for every machine whatever CLI it runs.
    titleKey: 'changelog.releases.sep06a.title',
    summaryKey: 'changelog.releases.sep06a.summary',
    itemKeys: [
      'changelog.releases.sep06a.hidden',
      'changelog.releases.sep06a.safety',
    ],
  },
  {
    id: '2026-09-05-terminals-listed-twice',
    date: '2026-09-05',
    buildVersion: __APP_VERSION__,
    // The Web half stops the duplicate being SHOWN on every existing machine
    // (iron rule 14: a daemon that already lost its id will not get it back).
    // The CLI half stops a machine losing its identity in the first place.
    cliVersion: '0.2.120',
    titleKey: 'changelog.releases.sep05a.title',
    summaryKey: 'changelog.releases.sep05a.summary',
    itemKeys: [
      'changelog.releases.sep05a.duplicates',
      'changelog.releases.sep05a.identity',
    ],
  },
  {
    id: '2026-09-04-tables-and-mermaid',
    date: '2026-09-04',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep04e.title',
    summaryKey: 'changelog.releases.sep04e.summary',
    itemKeys: [
      'changelog.releases.sep04e.tables',
      'changelog.releases.sep04e.mermaid',
    ],
  },
  {
    id: '2026-09-04-update-actually-updates',
    date: '2026-09-04',
    buildVersion: __APP_VERSION__,
    // web-only: no CLI half.
    titleKey: 'changelog.releases.sep04d.title',
    summaryKey: 'changelog.releases.sep04d.summary',
    itemKeys: [
      'changelog.releases.sep04d.shell',
      'changelog.releases.sep04d.retry',
    ],
  },
  {
    id: '2026-09-04-markdown-and-attachments',
    date: '2026-09-04',
    buildVersion: __APP_VERSION__,
    // The Web half shipped in e38b8602; 0.2.119 carries the CLI half of the same
    // fix — the JSONL scanner's dedupe key. The Web already hides the duplicate
    // for every CLI version (iron rule 14), so this only stops it being produced.
    cliVersion: '0.2.119',
    titleKey: 'changelog.releases.sep04c.title',
    summaryKey: 'changelog.releases.sep04c.summary',
    itemKeys: [
      'changelog.releases.sep04c.tables',
      'changelog.releases.sep04c.gfm',
      'changelog.releases.sep04c.attachments',
    ],
  },
  {
    id: '2026-09-04-role-aware-session-cards',
    date: '2026-09-04',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.118',
    titleKey: 'changelog.releases.sep04b.title',
    summaryKey: 'changelog.releases.sep04b.summary',
    itemKeys: [
      'changelog.releases.sep04b.tools',
      'changelog.releases.sep04b.cards',
    ],
  },
  {
    id: '2026-09-04-auto-update-forward-only',
    date: '2026-09-04',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.117',
    titleKey: 'changelog.releases.sep04a.title',
    summaryKey: 'changelog.releases.sep04a.summary',
    itemKeys: [
      'changelog.releases.sep04a.forward',
    ],
  },
  {
    id: '2026-09-04-pi-and-supervisor-surface',
    date: '2026-09-04',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.117',
    titleKey: 'changelog.releases.sep03ae.title',
    summaryKey: 'changelog.releases.sep03ae.summary',
    itemKeys: [
      'changelog.releases.sep03ae.pi',
      'changelog.releases.sep03ae.approve',
      'changelog.releases.sep03ae.meta',
      'changelog.releases.sep03ae.titles',
      'changelog.releases.sep03ae.yolo',
    ],
  },
  {
    id: '2026-09-03-cli-auto-update',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.116',
    titleKey: 'changelog.releases.sep03ad.title',
    summaryKey: 'changelog.releases.sep03ad.summary',
    itemKeys: [
      'changelog.releases.sep03ad.idle',
      'changelog.releases.sep03ad.safety',
    ],
  },
  {
    id: '2026-09-03-terminal-output-coalescing',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.116',
    titleKey: 'changelog.releases.sep03ag.title',
    summaryKey: 'changelog.releases.sep03ag.summary',
    itemKeys: [
      'changelog.releases.sep03ag.frames',
      'changelog.releases.sep03ag.latency',
    ],
  },
  {
    id: '2026-09-03-refresh-never-hangs',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only: no CLI half
    titleKey: 'changelog.releases.sep03ac.title',
    summaryKey: 'changelog.releases.sep03ac.summary',
    itemKeys: [
      'changelog.releases.sep03ac.hang',
    ],
  },
  {
    id: '2026-09-03-terminal-launch-presets',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only: no protocol change — the daemon has always taken cwd and a
    // startup command on the create-open (B-334).
    titleKey: 'changelog.releases.sep03ab.title',
    summaryKey: 'changelog.releases.sep03ab.summary',
    itemKeys: [
      'changelog.releases.sep03ab.command',
      'changelog.releases.sep03ab.recents',
    ],
  },
  {
    id: '2026-09-03-terminal-unread-dot',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only: the daemon already reports the terminal's agent state.
    titleKey: 'changelog.releases.sep03aa.title',
    summaryKey: 'changelog.releases.sep03aa.summary',
    itemKeys: [
      'changelog.releases.sep03aa.dot',
      'changelog.releases.sep03aa.rules',
    ],
  },
  {
    id: '2026-09-03-liveness-lease',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only: 版本无关，对存量 wrapper 立即生效（B-322）
    titleKey: 'changelog.releases.sep03z.title',
    summaryKey: 'changelog.releases.sep03z.summary',
    itemKeys: [
      'changelog.releases.sep03z.lease',
      'changelog.releases.sep03z.queue',
    ],
  },
  {
    id: '2026-09-03-handover-preflight',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.115',
    titleKey: 'changelog.releases.sep03y.title',
    summaryKey: 'changelog.releases.sep03y.summary',
    itemKeys: [
      'changelog.releases.sep03y.preflight',
    ],
  },
  {
    id: '2026-09-03-stop-feedback',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only: 版本无关，对存量 wrapper 立即生效（B-320）
    titleKey: 'changelog.releases.sep03x.title',
    summaryKey: 'changelog.releases.sep03x.summary',
    itemKeys: [
      'changelog.releases.sep03x.stop',
      'changelog.releases.sep03x.rpc',
    ],
  },
  {
    id: '2026-09-03-update-prompt',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only: no CLI half
    titleKey: 'changelog.releases.sep03w.title',
    summaryKey: 'changelog.releases.sep03w.summary',
    itemKeys: [
      'changelog.releases.sep03w.prompt',
    ],
  },
  {
    id: '2026-09-03-terminal-cell-width',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only. Entry written by the releasing agent — B-316 (#219) landed
    // without one, and every user-facing change in a release needs coverage
    // (AGENTS 「每次发布必须带 changelog」).
    titleKey: 'changelog.releases.sep03v.title',
    summaryKey: 'changelog.releases.sep03v.summary',
    itemKeys: [
      'changelog.releases.sep03v.width',
    ],
  },
  {
    id: '2026-09-03-subagent-drawer',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only: the CLI half (publishing `stopped` for an interrupted
    // sub-agent) is B-318, deliberately not in this release.
    titleKey: 'changelog.releases.sep03u.title',
    summaryKey: 'changelog.releases.sep03u.summary',
    itemKeys: [
      'changelog.releases.sep03u.drawer',
      'changelog.releases.sep03u.stop',
    ],
  },
  {
    id: '2026-09-03-update-path',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.114',
    titleKey: 'changelog.releases.sep03t.title',
    summaryKey: 'changelog.releases.sep03t.summary',
    itemKeys: [
      'changelog.releases.sep03t.stall',
      'changelog.releases.sep03t.notice',
      'changelog.releases.sep03t.draft',
      'changelog.releases.sep03t.cli',
    ],
  },
  {
    id: '2026-09-03-unread-dot',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // web-only: no CLI half
    titleKey: 'changelog.releases.sep03s.title',
    summaryKey: 'changelog.releases.sep03s.summary',
    itemKeys: [
      'changelog.releases.sep03s.color',
      'changelog.releases.sep03s.persist',
    ],
  },
  {
    id: '2026-09-03-rate-limit-self-lock',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // NOT 0.2.112: that tag was published from 249a0639 while this was still in
    // review, and a published tag is immutable (AGENTS 铁律 6).
    cliVersion: '0.2.113',
    titleKey: 'changelog.releases.sep03r.title',
    summaryKey: 'changelog.releases.sep03r.summary',
    itemKeys: [
      'changelog.releases.sep03r.refusal',
      'changelog.releases.sep03r.backoff',
    ],
  },
  {
    id: '2026-09-03-answers-arrive-as-they-are-written',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // NOT 0.2.109/110/111: all three were already published while this was
    // in review (AGENTS 铁律 6 — published tags are immutable). Rides 0.2.112
    // as the next one.
    cliVersion: '0.2.112',
    titleKey: 'changelog.releases.sep03q.title',
    summaryKey: 'changelog.releases.sep03q.summary',
    itemKeys: [
      'changelog.releases.sep03q.streaming',
      'changelog.releases.sep03q.status',
      'changelog.releases.sep03q.perf',
    ],
  },
  {
    id: '2026-09-03-spawn-permission-mode',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // 0.2.110 was tagged from e71fe597 (the mirror-bind retry) while this was
    // still in review, so B-306 ships in the next one.
    cliVersion: '0.2.111',
    titleKey: 'changelog.releases.sep03p.title',
    summaryKey: 'changelog.releases.sep03p.summary',
    itemKeys: [
      'changelog.releases.sep03p.mode',
      'changelog.releases.sep03p.agentEnv',
    ],
  },
  {
    id: '2026-09-03-terminal-mirror-bind-retry',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // NOT 0.2.109: that tag was already published from 598bc632 (B-303/B-304)
    // while this was still in review, and a published tag is immutable
    // (AGENTS 铁律 6). This ships in the next one.
    cliVersion: '0.2.112',
    titleKey: 'changelog.releases.sep03o.title',
    summaryKey: 'changelog.releases.sep03o.summary',
    itemKeys: [
      'changelog.releases.sep03o.retry',
    ],
  },
  {
    id: '2026-09-03-sessions-cli',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // Ships with B-303 in the same CLI release.
    cliVersion: '0.2.109',
    titleKey: 'changelog.releases.sep03n.title',
    summaryKey: 'changelog.releases.sep03n.summary',
    itemKeys: [
      'changelog.releases.sep03n.sessions',
      'changelog.releases.sep03n.scope',
    ],
  },
  {
    id: '2026-09-03-spawn-origin-tag',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.109',
    titleKey: 'changelog.releases.sep03m.title',
    summaryKey: 'changelog.releases.sep03m.summary',
    itemKeys: [
      'changelog.releases.sep03m.tag',
      'changelog.releases.sep03m.flag',
    ],
  },
  {
    id: '2026-09-03-machine-name-follows-rename',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.108',
    titleKey: 'changelog.releases.sep03l.title',
    summaryKey: 'changelog.releases.sep03l.summary',
    itemKeys: [
      'changelog.releases.sep03l.rename',
    ],
  },
  {
    id: '2026-09-03-launcher-tells-the-truth',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep03k.title',
    summaryKey: 'changelog.releases.sep03k.summary',
    itemKeys: [
      'changelog.releases.sep03k.picker',
      'changelog.releases.sep03k.cost',
    ],
  },
  {
    id: '2026-09-03-connect-machine-in-plus-menu',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep03j.title',
    summaryKey: 'changelog.releases.sep03j.summary',
    itemKeys: [
      'changelog.releases.sep03j.plus',
    ],
  },
  {
    id: '2026-09-03-auth-failure-diagnosis',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // v0.2.106 shipped B-294 (the entry below) while this was still in review;
    // the CLI half of B-297/B-298 lands in the next one.
    cliVersion: '0.2.107',
    titleKey: 'changelog.releases.sep03i.title',
    summaryKey: 'changelog.releases.sep03i.summary',
    itemKeys: [
      'changelog.releases.sep03i.card',
      'changelog.releases.sep03i.rejected',
      'changelog.releases.sep03i.copied',
      'changelog.releases.sep03i.store',
    ],
  },
  {
    id: '2026-09-03-stalled-tools-and-connect-guide',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep03h.title',
    summaryKey: 'changelog.releases.sep03h.summary',
    itemKeys: [
      'changelog.releases.sep03h.stalled',
      'changelog.releases.sep03h.connect',
    ],
  },
  {
    id: '2026-09-03-import-batch-and-titles',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.106',
    titleKey: 'changelog.releases.sep03g.title',
    summaryKey: 'changelog.releases.sep03g.summary',
    itemKeys: [
      'changelog.releases.sep03g.titles',
      'changelog.releases.sep03g.batch',
    ],
  },
  {
    id: '2026-09-03-model-switch-and-mobile-headers',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.105',
    titleKey: 'changelog.releases.sep03f.title',
    summaryKey: 'changelog.releases.sep03f.summary',
    itemKeys: [
      'changelog.releases.sep03f.model',
      'changelog.releases.sep03f.effort',
      'changelog.releases.sep03f.header',
      'changelog.releases.sep03f.chatHeader',
    ],
  },
  {
    id: '2026-09-03-import-hides-owned-conversations',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.104',
    titleKey: 'changelog.releases.sep03e.title',
    summaryKey: 'changelog.releases.sep03e.summary',
    itemKeys: [
      'changelog.releases.sep03e.tracked',
    ],
  },
  {
    id: '2026-09-03-fable-51-claude-history-import',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.103',
    titleKey: 'changelog.releases.sep03d.title',
    summaryKey: 'changelog.releases.sep03d.summary',
    itemKeys: [
      'changelog.releases.sep03d.models',
      'changelog.releases.sep03d.import',
      'changelog.releases.sep03d.docs',
      'changelog.releases.sep03d.cli',
    ],
  },
  {
    id: '2026-09-03-terminal-font-maple',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep03c.title',
    summaryKey: 'changelog.releases.sep03c.summary',
    itemKeys: [
      'changelog.releases.sep03c.font',
      'changelog.releases.sep03c.loading',
    ],
  },
  {
    id: '2026-09-03-tmux-cjk-locale',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.102',
    titleKey: 'changelog.releases.sep03b.title',
    summaryKey: 'changelog.releases.sep03b.summary',
    itemKeys: [
      'changelog.releases.sep03b.locale',
    ],
  },
  {
    id: '2026-09-03-terminal-cjk-font',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep03a.title',
    summaryKey: 'changelog.releases.sep03a.summary',
    itemKeys: [
      'changelog.releases.sep03a.overlap',
      'changelog.releases.sep03a.logo',
    ],
  },
  {
    id: '2026-09-02-terminal-logo-seamless',
    date: '2026-09-02',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep02g.title',
    summaryKey: 'changelog.releases.sep02g.summary',
    itemKeys: [
      'changelog.releases.sep02g.blocks',
    ],
  },
  {
    id: '2026-09-02-terminal-width-reclaim',
    date: '2026-09-02',
    buildVersion: __APP_VERSION__,
    titleKey: 'changelog.releases.sep02f.title',
    summaryKey: 'changelog.releases.sep02f.summary',
    itemKeys: [
      'changelog.releases.sep02f.reclaim',
      'changelog.releases.sep02f.button',
    ],
  },
  {
    id: '2026-09-02-terminal-render',
    date: '2026-09-02',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.101',
    titleKey: 'changelog.releases.sep02e.title',
    summaryKey: 'changelog.releases.sep02e.summary',
    itemKeys: [
      'changelog.releases.sep02e.geometry',
      'changelog.releases.sep02e.font',
      'changelog.releases.sep02e.green',
      'changelog.releases.sep02e.cli',
    ],
  },
  {
    id: '2026-09-02-btw-side-question',
    date: '2026-09-02',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.100',
    titleKey: 'changelog.releases.sep02d.title',
    summaryKey: 'changelog.releases.sep02d.summary',
    itemKeys: [
      'changelog.releases.sep02d.btw',
      'changelog.releases.sep02d.context',
      'changelog.releases.sep02d.unseen',
      'changelog.releases.sep02d.cli',
    ],
  },
  {
    id: '2026-09-02-claude-auth-preflight',
    date: '2026-09-02',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.97',
    titleKey: 'changelog.releases.sep02c.title',
    summaryKey: 'changelog.releases.sep02c.summary',
    itemKeys: [
      'changelog.releases.sep02c.recycle',
      'changelog.releases.sep02c.preflight',
      'changelog.releases.sep02c.store',
      'changelog.releases.sep02c.cli',
    ],
  },
  {
    id: '2026-09-02-session-single-writer',
    date: '2026-09-02',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.96',
    titleKey: 'changelog.releases.sep02b.title',
    summaryKey: 'changelog.releases.sep02b.summary',
    itemKeys: [
      'changelog.releases.sep02b.lock',
      'changelog.releases.sep02b.restart',
      'changelog.releases.sep02b.cli',
    ],
  },
  {
    id: '2026-09-02-archive-restore',
    date: '2026-09-02',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.92',
    titleKey: 'changelog.releases.sep02.title',
    summaryKey: 'changelog.releases.sep02.summary',
    itemKeys: [
      'changelog.releases.sep02.restore',
      'changelog.releases.sep02.compose',
      'changelog.releases.sep02.terminal',
      'changelog.releases.sep02.cli',
    ],
  },
  {
    id: '2026-09-01-subagent-lifecycle-cli-yolo',
    date: '2026-09-01',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.91',
    titleKey: 'changelog.releases.sep01b.title',
    summaryKey: 'changelog.releases.sep01b.summary',
    itemKeys: [
      'changelog.releases.sep01b.lifecycle',
      'changelog.releases.sep01b.report',
      'changelog.releases.sep01b.turn',
      'changelog.releases.sep01b.cli',
    ],
  },
  {
    id: '2026-09-01-yolo-enforcement-subagents',
    date: '2026-09-01',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.90',
    titleKey: 'changelog.releases.sep01.title',
    summaryKey: 'changelog.releases.sep01.summary',
    itemKeys: [
      'changelog.releases.sep01.yolo',
      'changelog.releases.sep01.honest',
      'changelog.releases.sep01.subagents',
      'changelog.releases.sep01.history',
    ],
  },
  {
    id: '2026-08-31-web-resume-sync',
    date: '2026-08-31',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.90',
    titleKey: 'changelog.releases.aug31b.title',
    summaryKey: 'changelog.releases.aug31b.summary',
    itemKeys: [
      'changelog.releases.aug31b.resume',
      'changelog.releases.aug31b.liveness',
      'changelog.releases.aug31b.terminal',
      'changelog.releases.aug31b.desktop',
    ],
  },
  {
    id: '2026-08-31-permission-mode-truth',
    date: '2026-08-31',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.90',
    titleKey: 'changelog.releases.aug31.title',
    summaryKey: 'changelog.releases.aug31.summary',
    itemKeys: [
      'changelog.releases.aug31.truth',
      'changelog.releases.aug31.live',
      'changelog.releases.aug31.plan',
      'changelog.releases.aug31.cli',
    ],
  },
  {
    id: '2026-08-28-claude-queue-steer',
    date: '2026-08-28',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.87',
    titleKey: 'changelog.releases.aug28.title',
    summaryKey: 'changelog.releases.aug28.summary',
    itemKeys: [
      'changelog.releases.aug28.queue',
      'changelog.releases.aug28.plan',
      'changelog.releases.aug28.reliability',
      'changelog.releases.aug28.cli',
    ],
  },
  {
    id: '2026-08-27-any-file-attachments',
    date: '2026-08-27',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.84',
    titleKey: 'changelog.releases.aug27c.title',
    summaryKey: 'changelog.releases.aug27c.summary',
    itemKeys: [
      'changelog.releases.aug27c.files',
      'changelog.releases.aug27c.delivery',
      'changelog.releases.aug27c.queue',
    ],
  },
  {
    id: '2026-08-27-continuity-and-documents',
    date: '2026-08-27',
    buildVersion: __APP_VERSION__,
    cliVersion: '0.2.82',
    titleKey: 'changelog.releases.aug27b.title',
    summaryKey: 'changelog.releases.aug27b.summary',
    itemKeys: [
      'changelog.releases.aug27b.continuity',
      'changelog.releases.aug27b.documents',
      'changelog.releases.aug27b.agents',
      'changelog.releases.aug27b.loading',
    ],
  },
  {
    id: '2026-08-27-session-control',
    date: '2026-08-27',
    cliVersion: '0.2.81',
    titleKey: 'changelog.releases.aug27.title',
    summaryKey: 'changelog.releases.aug27.summary',
    itemKeys: [
      'changelog.releases.aug27.composer',
      'changelog.releases.aug27.queue',
      'changelog.releases.aug27.questions',
      'changelog.releases.aug27.terminal',
      'changelog.releases.aug27.visuals',
    ],
  },
  {
    id: '2026-08-26-relay-and-reliability',
    date: '2026-08-26',
    cliVersion: '0.2.80',
    titleKey: 'changelog.releases.aug26.title',
    summaryKey: 'changelog.releases.aug26.summary',
    itemKeys: [
      'changelog.releases.aug26.relay',
      'changelog.releases.aug26.release',
      'changelog.releases.aug26.mobile',
      'changelog.releases.aug26.usage',
    ],
  },
  {
    id: '2026-08-24-public-workspace',
    date: '2026-08-24',
    cliVersion: '0.2.62',
    titleKey: 'changelog.releases.aug24.title',
    summaryKey: 'changelog.releases.aug24.summary',
    itemKeys: [
      'changelog.releases.aug24.onboarding',
      'changelog.releases.aug24.workspace',
      'changelog.releases.aug24.security',
    ],
  },
  {
    id: '2026-08-15-terminal-mirror',
    date: '2026-08-15',
    cliVersion: '0.2.43',
    titleKey: 'changelog.releases.aug15.title',
    summaryKey: 'changelog.releases.aug15.summary',
    itemKeys: [
      'changelog.releases.aug15.mirror',
      'changelog.releases.aug15.files',
      'changelog.releases.aug15.models',
    ],
  },
  {
    id: '2026-08-12-remote-workflows',
    date: '2026-08-12',
    cliVersion: '0.2.28',
    titleKey: 'changelog.releases.aug12.title',
    summaryKey: 'changelog.releases.aug12.summary',
    itemKeys: [
      'changelog.releases.aug12.channels',
      'changelog.releases.aug12.input',
      'changelog.releases.aug12.mobile',
    ],
  },
  {
    id: '2026-08-04-message-reliability',
    date: '2026-08-04',
    cliVersion: '0.2.20',
    titleKey: 'changelog.releases.aug04.title',
    summaryKey: 'changelog.releases.aug04.summary',
    itemKeys: [
      'changelog.releases.aug04.ordering',
      'changelog.releases.aug04.terminal',
      'changelog.releases.aug04.navigation',
    ],
  },
  {
    id: '2026-06-30-web-v2',
    date: '2026-06-30',
    titleKey: 'changelog.releases.jun30.title',
    summaryKey: 'changelog.releases.jun30.summary',
    itemKeys: [
      'changelog.releases.jun30.workspace',
      'changelog.releases.jun30.chat',
      'changelog.releases.jun30.terminal',
    ],
  },
] as const;

export const CURRENT_CHANGELOG = CHANGELOG_RELEASES[0];

export interface ChangelogMachineLike {
  id: string;
  active?: boolean;
  metadata?: { host?: string; displayName?: string; happyCliVersion?: string } | null;
}

export interface ChangelogCliNotice {
  machineId: string;
  machineName: string;
  currentVersion: string;
  targetVersion: string;
}

export function changelogCliNotices(
  machines: readonly ChangelogMachineLike[],
  // Default to the newest release that actually shipped a companion CLI, not
  // blindly the newest release: a web-only latest release (no cliVersion) must
  // still advertise the last published CLI to machines behind it, never drop
  // the notice to nothing. The production caller (ChangelogNotice) already
  // passes changelogCliTarget(unseen) explicitly; this only fixes the default.
  release: ChangelogRelease | null = changelogCliTarget(CHANGELOG_RELEASES),
): ChangelogCliNotice[] {
  if (!release?.cliVersion) return [];
  const targetVersion = release.cliVersion; // captured non-null for the closure
  return machines.flatMap((machine) => {
    const currentVersion = machine.metadata?.happyCliVersion;
    if (machine.active !== true || !currentVersion || !isCliVersionBelow(currentVersion, targetVersion)) return [];
    return [{
      machineId: machine.id,
      machineName: machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8),
      currentVersion,
      targetVersion,
    }];
  });
}

/**
 * The receipt is a release id. The first implementation stored
 * `${releaseId}:${buildVersion}`; strip the salt so those visitors are diffed
 * against the release they actually acknowledged instead of re-shown everything.
 */
export function normalizeChangelogSeen(seen: string | null): string | null {
  if (!seen) return null;
  const salt = seen.indexOf(':');
  return salt === -1 ? seen : seen.slice(0, salt);
}

/**
 * Every release the visitor has not acknowledged yet, newest first — the diff
 * between the receipt in localStorage and `CHANGELOG_RELEASES[0]`, so a few
 * releases shipped in quick succession are all shown, not just the newest.
 *
 * - No receipt (fresh browser) → only the current release; a first visit should
 *   not be greeted with the whole history.
 * - Receipt that names an id no longer in the list → same as no receipt.
 * - Receipt === current → nothing.
 */
export function unseenChangelogReleases(
  seen: string | null,
  releases: readonly ChangelogRelease[] = CHANGELOG_RELEASES,
): ChangelogRelease[] {
  if (releases.length === 0) return [];
  const seenId = normalizeChangelogSeen(seen);
  if (seenId === null) return [releases[0]];
  const index = releases.findIndex((release) => release.id === seenId);
  if (index === -1) return [releases[0]];
  return releases.slice(0, index);
}

/** Newest companion CLI among the given releases (the one the machines should be on). */
export function changelogCliTarget(releases: readonly ChangelogRelease[]): ChangelogRelease | null {
  let best: ChangelogRelease | null = null;
  for (const release of releases) {
    if (!release.cliVersion) continue;
    if (!best || isCliVersionBelow(best.cliVersion!, release.cliVersion)) best = release;
  }
  return best;
}

export function shouldShowChangelog(seen: string | null, releaseId = CURRENT_CHANGELOG.id): boolean {
  if (releaseId === CURRENT_CHANGELOG.id) return unseenChangelogReleases(seen).length > 0;
  return normalizeChangelogSeen(seen) !== releaseId;
}

export function changelogSeenValue(releaseId = CURRENT_CHANGELOG.id): string {
  return releaseId;
}
