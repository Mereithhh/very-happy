import type { CliUpdateState, DaemonState } from '@/api/types';

export interface CliVersionPolicyResponse {
  recommendedVersion: string | null;
  minimumVersion: string | null;
  checkedAt: number;
  source: 'configured' | 'registry' | 'unavailable';
}

export const DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MIN_CLI_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function withCurrentCliUpdateState(current: DaemonState | null, state: CliUpdateState | null): DaemonState {
  const { cliUpdate: _staleCliUpdate, ...rest } = current ?? {};
  return {
    ...rest,
    status: current?.status ?? 'running',
    ...(state ? { cliUpdate: state } : {}),
  };
}

export function resolveCliUpdateCheckInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= MIN_CLI_UPDATE_CHECK_INTERVAL_MS
    ? value
    : DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS;
}

type ParsedVersion = { exact: string; core: [number, number, number]; pre: Array<number | string> | null };

export function parseExactVersion(value: string): ParsedVersion | null {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  const preParts = match[4]?.split('.') ?? null;
  const buildParts = match[5]?.split('.') ?? null;
  if (preParts?.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null;
  if (buildParts?.some((part) => !part)) return null;
  const pre = preParts?.map((part) => /^\d+$/.test(part) ? Number(part) : part) ?? null;
  const suffix = `${match[4] ? `-${match[4]}` : ''}${match[5] ? `+${match[5]}` : ''}`;
  return { exact: `${match[1]}.${match[2]}.${match[3]}${suffix}`, core: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

export function compareExactVersions(left: string, right: string): number | null {
  const a = parseExactVersion(left);
  const b = parseExactVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  const count = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < count; index += 1) {
    const av = a.pre[index];
    const bv = b.pre[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'string') return -1;
    if (typeof av === 'string' && typeof bv === 'number') return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function deriveCliUpdateState(
  currentVersion: string,
  policy: CliVersionPolicyResponse,
): CliUpdateState | null {
  if (!parseExactVersion(currentVersion)) return null;
  const recommended = policy.recommendedVersion && parseExactVersion(policy.recommendedVersion)
    ? policy.recommendedVersion.replace(/^v/, '')
    : null;
  const minimum = policy.minimumVersion && parseExactVersion(policy.minimumVersion)
    ? policy.minimumVersion.replace(/^v/, '')
    : null;
  if (!recommended && !minimum) return null;
  const belowMinimum = minimum ? compareExactVersions(currentVersion, minimum) === -1 : false;
  const belowRecommended = recommended ? compareExactVersions(currentVersion, recommended) === -1 : false;
  return {
    currentVersion: currentVersion.replace(/^v/, ''),
    recommendedVersion: recommended ? parseExactVersion(recommended)!.exact : null,
    minimumVersion: minimum ? parseExactVersion(minimum)!.exact : null,
    status: belowMinimum ? 'required' : belowRecommended ? 'available' : 'current',
    checkedAt: policy.checkedAt,
  };
}

export function cliInstallCommand(version: string): string | null {
  const parsed = parseExactVersion(version);
  if (!parsed) return null;
  return `npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@${parsed.exact}`;
}

export interface LocalCliUpdateSummary {
  daemonMismatch: boolean;
  installedStatus: 'current' | 'available' | 'required' | 'unknown';
  targetVersion: string | null;
  installCommand: string | null;
}

export function deriveLocalCliUpdateSummary(
  installedVersion: string,
  runningDaemonVersion: string | null,
  policy: CliUpdateState | null | undefined,
): LocalCliUpdateSummary {
  const daemonComparison = runningDaemonVersion
    ? compareExactVersions(runningDaemonVersion, installedVersion)
    : 0;
  const minimumComparison = policy?.minimumVersion
    ? compareExactVersions(installedVersion, policy.minimumVersion)
    : 0;
  const recommendedComparison = policy?.recommendedVersion
    ? compareExactVersions(installedVersion, policy.recommendedVersion)
    : 0;
  const installedStatus = minimumComparison === -1
    ? 'required'
    : recommendedComparison === -1
      ? 'available'
      : minimumComparison === null || recommendedComparison === null
        ? 'unknown'
        : 'current';
  const targetVersion = installedStatus === 'required'
    ? (policy?.recommendedVersion ?? policy?.minimumVersion ?? null)
    : installedStatus === 'available'
      ? (policy?.recommendedVersion ?? null)
      : null;
  return {
    daemonMismatch: daemonComparison !== 0,
    installedStatus,
    targetVersion,
    installCommand: targetVersion ? cliInstallCommand(targetVersion) : null,
  };
}

export async function fetchCliUpdateState(
  serverUrl: string,
  currentVersion: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 2_000,
): Promise<CliUpdateState | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${serverUrl}/v1/version/cli`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const raw = await response.json() as Partial<CliVersionPolicyResponse>;
    if (!Number.isFinite(raw.checkedAt)) return null;
    if (!['configured', 'registry', 'unavailable'].includes(String(raw.source))) return null;
    if (raw.recommendedVersion !== null && raw.recommendedVersion !== undefined && typeof raw.recommendedVersion !== 'string') return null;
    if (raw.minimumVersion !== null && raw.minimumVersion !== undefined && typeof raw.minimumVersion !== 'string') return null;
    return deriveCliUpdateState(currentVersion, {
      recommendedVersion: raw.recommendedVersion ?? null,
      minimumVersion: raw.minimumVersion ?? null,
      checkedAt: raw.checkedAt!,
      source: raw.source as CliVersionPolicyResponse['source'],
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
