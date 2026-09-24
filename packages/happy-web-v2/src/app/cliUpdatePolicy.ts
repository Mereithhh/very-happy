export type CliUpdateSeverity = 'available' | 'required';

export interface CliUpdateStateLike {
  currentVersion?: unknown;
  recommendedVersion?: unknown;
  minimumVersion?: unknown;
  status?: unknown;
  checkedAt?: unknown;
  autoUpdateVersion?: unknown;
  autoUpdate?: unknown;
  handoverHold?: unknown;
  manualUpdateSupported?: unknown;
}

export interface CliUpdateMachineLike {
  id: string;
  active?: boolean;
  metadata?: { host?: string; displayName?: string; happyCliVersion?: string } | null;
  daemonState?: { cliUpdate?: CliUpdateStateLike } | null;
}

export interface CliUpdateMachineNotice {
  machineId: string;
  machineName: string;
  currentVersion: string;
  targetVersion: string;
  minimumVersion: string | null;
  automaticVersion: string | null;
  severity: CliUpdateSeverity;
  delivery: 'automatic' | 'pending' | 'attention' | 'unknown';
  /** B-489: why an 'attention' notice needs a person, when it is an install-location problem. */
  problem: CliUpdateProblem | null;
}

/**
 * B-489: the automatic update could not reach the copy the daemon runs.
 * - installed_elsewhere: a new daemon saw npm succeed without changing its own package.
 * - install_location: a new daemon refused to install (unwritable / unrecognised layout).
 * - installed_not_running: an OLD daemon reported `installed` long ago and still runs
 *   the previous version. Old daemons cannot tell us more, and `installed` is
 *   terminal for them, so without this the Web keeps saying "no action needed"
 *   forever (the SageMaker case: 0.2.144 for two days after installing 0.2.149).
 */
export type CliUpdateProblem = 'installed_elsewhere' | 'install_location' | 'installed_not_running';

/**
 * Past this, `installed` without a handover is not "switching shortly". The
 * handover waits for no agent turn in flight, so a long turn can hold it; the
 * copy says so rather than asserting the npm-tree cause.
 */
export const INSTALLED_NOT_RUNNING_GRACE_MS = 30 * 60_000;

type Version = { exact: string; core: [number, number, number]; pre: Array<number | string> | null };

function version(value: unknown): Version | null {
  if (typeof value !== 'string') return null;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  const preParts = match[4]?.split('.') ?? null;
  const buildParts = match[5]?.split('.') ?? null;
  if (preParts?.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null;
  if (buildParts?.some((part) => !part)) return null;
  const suffix = `${match[4] ? `-${match[4]}` : ''}${match[5] ? `+${match[5]}` : ''}`;
  return {
    exact: `${match[1]}.${match[2]}.${match[3]}${suffix}`,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: preParts?.map((part) => /^\d+$/.test(part) ? Number(part) : part) ?? null,
  };
}

function below(left: Version, right: Version): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index];
  }
  if (left.pre === null || right.pre === null) return left.pre !== right.pre && left.pre !== null;
  const count = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < count; index += 1) {
    const a = left.pre[index];
    const b = right.pre[index];
    if (a === undefined || b === undefined) return a === undefined && b !== undefined;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'string') return true;
    if (typeof a === 'string' && typeof b === 'number') return false;
    if (typeof a === 'number' && typeof b === 'number') return a < b;
    return String(a) < String(b);
  }
  return false;
}

export function isCliVersionBelow(currentVersion: string, targetVersion: string): boolean {
  const current = version(currentVersion);
  const target = version(targetVersion);
  return Boolean(current && target && below(current, target));
}

export function cliUpdateInstallCommand(targetVersion: string): string | null {
  const target = version(targetVersion);
  return target
    ? `npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@${target.exact} && very-happy daemon start`
    : null;
}

export function cliUpdateProblem(update: CliUpdateStateLike | null | undefined, now = Date.now()): CliUpdateProblem | null {
  const auto = update?.autoUpdate && typeof update.autoUpdate === 'object'
    ? update.autoUpdate as Record<string, unknown> : {};
  if (auto.state === 'failed' && auto.detail === 'installed_elsewhere') return 'installed_elsewhere';
  if (auto.state === 'manual_required' && typeof auto.detail === 'string' && auto.detail.startsWith('install_location_')) return 'install_location';
  const current = version(update?.currentVersion);
  const installed = version(auto.version);
  if (auto.state === 'installed' && current && installed && below(current, installed)
    && typeof auto.at === 'number' && now - auto.at > INSTALLED_NOT_RUNNING_GRACE_MS) return 'installed_not_running';
  return null;
}

/**
 * B-489: the manual command for an update that landed in another npm tree. It
 * installs into the prefix of the `very-happy` the shell runs (the one the
 * daemon was started from), so a second node/npm on PATH cannot capture it.
 */
export function cliUpdateRunningInstallCommand(targetVersion: string): string | null {
  const target = version(targetVersion);
  return target
    ? `P=$(readlink -f "$(command -v very-happy)") && npm install -g --prefix "\${P%/lib/node_modules/very-happy-cli/*}" --allow-scripts=very-happy-cli,node-pty very-happy-cli@${target.exact} && very-happy daemon start`
    : null;
}

export function cliUpdateCommandForNotice(notice: Pick<CliUpdateMachineNotice, 'targetVersion' | 'problem'>): string | null {
  return notice.problem === 'installed_elsewhere' || notice.problem === 'installed_not_running'
    ? cliUpdateRunningInstallCommand(notice.targetVersion)
    : cliUpdateInstallCommand(notice.targetVersion);
}

export function machineCliUpdateNotice(machine: CliUpdateMachineLike, now = Date.now()): CliUpdateMachineNotice | null {
  const update = machine.daemonState?.cliUpdate;
  const current = version(update?.currentVersion ?? machine.metadata?.happyCliVersion);
  const recommended = version(update?.recommendedVersion);
  const minimum = version(update?.minimumVersion);
  if (!current) return null;
  const required = minimum ? below(current, minimum) : false;
  const available = recommended ? below(current, recommended) : false;
  if (!required && !available) return null;
  const target = minimum && (!recommended || below(recommended, minimum)) ? minimum : recommended;
  if (!target) return null;
  const auto = update?.autoUpdate && typeof update.autoUpdate === 'object'
    ? update.autoUpdate as Record<string, unknown> : {};
  const fresh = machine.active === true && typeof update?.checkedAt === 'number'
    && now - update.checkedAt <= 65 * 60_000 && update.checkedAt <= now + 60_000;
  const autoTarget = version(update?.autoUpdateVersion);
  const reportedTarget = version(auto.version);
  const coversTarget = autoTarget && reportedTarget && autoTarget.exact === reportedTarget.exact && !below(autoTarget, target);
  const manualTarget = auto.source === 'manual' && reportedTarget?.exact === target.exact ? reportedTarget : null;
  const problem = cliUpdateProblem(update ? { ...update, currentVersion: current.exact } : update, now);
  const delivery: CliUpdateMachineNotice['delivery'] =
    machine.active === true && (auto.state === 'manual_required' || update?.handoverHold || problem) ? 'attention'
    : !fresh ? 'unknown'
    : ['failed', 'disabled'].includes(String(auto.state)) ? 'attention'
    : (coversTarget || manualTarget) && ['waiting_idle', 'installing', 'installed'].includes(String(auto.state)) ? 'automatic'
    : !required && (auto.state === 'unapproved' || (autoTarget && reportedTarget && autoTarget.exact === reportedTarget.exact && below(autoTarget, target) && ['current', 'waiting_idle', 'installing', 'installed'].includes(String(auto.state)))) ? 'pending'
    : 'unknown';
  return {
    delivery,
    problem: machine.active === true ? problem : null,
    automaticVersion: delivery === 'automatic' ? (manualTarget ?? autoTarget)!.exact : null,
    machineId: machine.id,
    machineName: machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8),
    currentVersion: current.exact,
    targetVersion: target.exact,
    minimumVersion: minimum?.exact ?? null,
    severity: required ? 'required' : 'available',
  };
}

export function hasValidCliUpdatePolicy(machine: CliUpdateMachineLike): boolean {
  const update = machine.daemonState?.cliUpdate;
  return Boolean(version(update?.currentVersion ?? machine.metadata?.happyCliVersion)
    && (version(update?.recommendedVersion) || version(update?.minimumVersion)));
}

/**
 * B-470: what a dismissal remembers. A plain target version hides the ordinary
 * "update available / will update itself" notice but NOT an 'attention' one
 * (a failed automatic install after the user waved the progress away still
 * deserves a card). An attention notice the user closed explicitly is
 * remembered with a `!` suffix and hides every state for that target; a newer
 * target re-surfaces the card either way. Required updates never hide.
 */
export function cliUpdateAcknowledgement(notice: Pick<CliUpdateMachineNotice, 'targetVersion' | 'delivery'>): string {
  return notice.delivery === 'attention' ? `${notice.targetVersion}!` : notice.targetVersion;
}

export function isCliUpdateNoticeVisible(notice: Pick<CliUpdateMachineNotice, 'severity' | 'targetVersion' | 'delivery'>, acknowledged: string | undefined): boolean {
  if (notice.severity === 'required') return true;
  if (acknowledged === `${notice.targetVersion}!`) return false;
  return notice.delivery === 'attention' || acknowledged !== notice.targetVersion;
}

export function visibleCliUpdateNotices(
  machines: readonly CliUpdateMachineLike[],
  acknowledged: Readonly<Record<string, string>>,
  now = Date.now(),
): CliUpdateMachineNotice[] {
  return machines
    .filter((machine) => machine.active === true)
    .map((machine) => machineCliUpdateNotice(machine, now))
    .filter((notice): notice is CliUpdateMachineNotice => Boolean(notice))
    .filter((notice) => isCliUpdateNoticeVisible(notice, acknowledged[notice.machineId]))
    .sort((left, right) => {
      if (left.severity !== right.severity) return left.severity === 'required' ? -1 : 1;
      if (left.delivery !== right.delivery) {
        const rank = { attention: 0, unknown: 1, automatic: 2, pending: 3 };
        return rank[left.delivery] - rank[right.delivery];
      }
      return left.machineName.localeCompare(right.machineName);
    });
}
