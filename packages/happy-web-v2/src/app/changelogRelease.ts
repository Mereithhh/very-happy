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
  release: ChangelogRelease = CURRENT_CHANGELOG,
): ChangelogCliNotice[] {
  if (!release.cliVersion) return [];
  return machines.flatMap((machine) => {
    const currentVersion = machine.metadata?.happyCliVersion;
    if (machine.active !== true || !currentVersion || !isCliVersionBelow(currentVersion, release.cliVersion!)) return [];
    return [{
      machineId: machine.id,
      machineName: machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8),
      currentVersion,
      targetVersion: release.cliVersion!,
    }];
  });
}

export function shouldShowChangelog(seen: string | null, releaseId = CURRENT_CHANGELOG.id): boolean {
  if (seen === releaseId) return false;
  // Migrate the first implementation's `${releaseId}:${buildVersion}` receipt
  // without making every timestamp-salted Web deploy reopen the same notes.
  return !seen?.startsWith(`${releaseId}:`);
}

export function changelogSeenValue(releaseId = CURRENT_CHANGELOG.id): string {
  return releaseId;
}
