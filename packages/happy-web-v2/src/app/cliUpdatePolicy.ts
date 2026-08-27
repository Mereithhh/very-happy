export type CliUpdateSeverity = 'available' | 'required';

export interface CliUpdateStateLike {
  currentVersion?: unknown;
  recommendedVersion?: unknown;
  minimumVersion?: unknown;
  status?: unknown;
  checkedAt?: unknown;
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
  severity: CliUpdateSeverity;
}

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

export function machineCliUpdateNotice(machine: CliUpdateMachineLike): CliUpdateMachineNotice | null {
  const update = machine.daemonState?.cliUpdate;
  const current = version(update?.currentVersion ?? machine.metadata?.happyCliVersion);
  const recommended = version(update?.recommendedVersion);
  const minimum = version(update?.minimumVersion);
  if (!current) return null;
  const required = minimum ? below(current, minimum) : false;
  const available = recommended ? below(current, recommended) : false;
  if (!required && !available) return null;
  const target = recommended ?? minimum;
  if (!target) return null;
  return {
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

export function visibleCliUpdateNotices(
  machines: readonly CliUpdateMachineLike[],
  acknowledged: Readonly<Record<string, string>>,
): CliUpdateMachineNotice[] {
  return machines
    .filter((machine) => machine.active === true)
    .map(machineCliUpdateNotice)
    .filter((notice): notice is CliUpdateMachineNotice => Boolean(notice))
    .filter((notice) => notice.severity === 'required' || acknowledged[notice.machineId] !== notice.targetVersion)
    .sort((left, right) => {
      if (left.severity !== right.severity) return left.severity === 'required' ? -1 : 1;
      return left.machineName.localeCompare(right.machineName);
    });
}
