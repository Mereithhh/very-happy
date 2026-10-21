/**
 * B-718 — what the machine page says about this machine's automatic CLI update:
 * on/off, the version it runs, the version it will move to, when it last
 * checked, the last update it completed, and whether "Update now" can be
 * offered. Pure: reads the daemon's `cliUpdate` defensively (daemonState is
 * untyped on the Web) and old daemons simply omit what they do not report.
 */
import { isCliVersionBelow } from './cliUpdatePolicy';

export interface MachineAutoUpdateSummary {
  /** null = the daemon does not report it (older CLI). */
  enabled: boolean | null;
  current: string | null;
  /** The version automatic update is heading to; null when already there or nothing is approved. */
  target: string | null;
  checkedAt: number | null;
  lastInstall: { from: string; to: string; at: number; auto: boolean } | null;
  /** The exact version "Update now" requests (B-442 RPC), or null when it must not be offered. */
  updateNowVersion: string | null;
}

const EXACT = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const str = (value: unknown) => typeof value === 'string' && EXACT.test(value) ? value : null;

export function machineAutoUpdateSummary(cliUpdate: unknown, fallbackCurrent: unknown, online: boolean): MachineAutoUpdateSummary {
  const raw = cliUpdate && typeof cliUpdate === 'object' ? cliUpdate as Record<string, unknown> : {};
  const auto = raw.autoUpdate && typeof raw.autoUpdate === 'object' ? raw.autoUpdate as Record<string, unknown> : {};
  const current = str(raw.currentVersion) ?? str(fallbackCurrent);
  const approved = str(raw.autoUpdateVersion);
  const recommended = str(raw.recommendedVersion);
  const ahead = (a: string | null, b: string | null) => !!a && !!b && isCliVersionBelow(b, a);
  const target = ahead(approved, current) ? approved : null;
  const rawLast = raw.lastInstall && typeof raw.lastInstall === 'object' ? raw.lastInstall as Record<string, unknown> : null;
  const lastFrom = str(rawLast?.from); const lastTo = str(rawLast?.to);
  const lastInstall = lastFrom && lastTo && typeof rawLast?.at === 'number'
    ? { from: lastFrom, to: lastTo, at: rawLast.at, auto: rawLast.source !== 'manual' } : null;
  const busy = ['installing', 'installed'].includes(String(auto.state)) || !!raw.handoverHold;
  const updateNowVersion = online && raw.manualUpdateSupported === true && !busy && ahead(recommended, current) ? recommended : null;
  return {
    enabled: typeof raw.autoUpdateEnabled === 'boolean' ? raw.autoUpdateEnabled : null,
    current,
    target,
    checkedAt: typeof raw.checkedAt === 'number' && Number.isFinite(raw.checkedAt) ? raw.checkedAt : null,
    lastInstall,
    updateNowVersion,
  };
}
