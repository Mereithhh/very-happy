import type { Metadata } from '@/api/types';

/** Adopt a persisted PID only when current process inventory independently
 * confirms that PID still belongs to a Happy CLI process. This avoids killing
 * an unrelated process after PID reuse. */
export function recoverableSessionPid(metadata: Metadata | undefined, liveHappyPids: ReadonlySet<number>): number | null {
    const pid = metadata?.hostPid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && liveHappyPids.has(pid)
        ? pid
        : null;
}
