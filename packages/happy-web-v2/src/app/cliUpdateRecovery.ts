import { apiSocket } from '@/sync/apiSocket';

const states = new Set(['waiting_idle', 'installing', 'installed', 'failed', 'disabled', 'current', 'unapproved', 'policy_stale', 'manual_required']);
export function readUpdateRecovery(value: unknown, online: boolean, now = Date.now()) {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const auto = raw.autoUpdate && typeof raw.autoUpdate === 'object' ? raw.autoUpdate as Record<string, unknown> : {};
  const stale = !online || typeof raw.checkedAt !== 'number' || now - raw.checkedAt > 65 * 60_000 || raw.checkedAt > now + 60_000;
  const known = typeof auto.state === 'string' && states.has(auto.state);
  const version = typeof auto.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(auto.version) ? auto.version : null;
  return {
    // A fenced installer cannot refresh its policy. Keep its manual-recovery
    // instruction visible while online instead of hiding it after 65 minutes.
    state: online && auto.state === 'manual_required' ? 'manual_required' : stale ? 'stale' : known ? auto.state as string : 'manual',
    version,
    canRetry: !stale && raw.retrySupported === true && auto.state === 'failed' && !!version,
  };
}

export async function retryMachineUpdate(machineId: string, version: string): Promise<void> {
  const result = await apiSocket.machineRPC<unknown, { version: string }>(machineId, 'cli-update-retry', { version });
  if (!result || typeof result !== 'object' || 'error' in result || (result as { accepted?: unknown }).accepted !== true) {
    throw new Error('Update retry was not accepted');
  }
}

/** Explicit request for one machine; an accepted RPC only schedules the update. */
export async function requestMachineUpdate(machineId: string, version: string): Promise<void> {
  const result = await apiSocket.machineRPC<unknown, { version: string }>(machineId, 'cli-update-request', { version });
  if (!result || typeof result !== 'object' || 'error' in result || (result as { accepted?: unknown }).accepted !== true) {
    throw new Error('Update request was not accepted');
  }
}
