import type { SimpleTranslationKey } from '@/text';
import { isCliVersionBelow } from './cliUpdatePolicy';

export const CHANGELOG_STORAGE_KEY = 'vh.changelog.seen';

export interface ChangelogRelease {
  id: string;
  date: string;
  buildVersion?: string;
  cliVersion?: string;
  titleKey: SimpleTranslationKey;
  summaryKey: SimpleTranslationKey;
  itemKeys: readonly SimpleTranslationKey[];
}

export const CHANGELOG_RELEASES: readonly ChangelogRelease[] = [
  {
    id: '2026-09-03-terminal-mirror-bind-retry',
    date: '2026-09-03',
    buildVersion: __APP_VERSION__,
    // NOT 0.2.109: that tag was already published from 598bc632 (B-303/B-304)
    // while this was still in review, and a published tag is immutable
    // (AGENTS 铁律 6). This ships in the next one.
    cliVersion: '0.2.110',
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
