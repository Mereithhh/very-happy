/**
 * B-719 — Install / Update a coding-agent CLI on a machine, only when the
 * owner clicks it. The Web sends a harness id and nothing else; the daemon
 * owns the package list (happy-cli/src/harness/installCatalog.ts).
 */
import { HarnessInstallStateSchema, HARNESS_INSTALL_CAPABILITY_VERSION, isHarnessInstallId, type HarnessInstallId } from '@slopus/happy-wire';
import { apiSocket } from '@/sync/apiSocket';

export type HarnessInstallView = { harness: HarnessInstallId; state: 'installing' | 'installed' | 'failed'; detail: string | null; at: number };

/** npm can take minutes; past this an `installing` that never reported back is shown as failed. */
export const HARNESS_INSTALL_STALE_MS = 15 * 60_000;

export function machineCanInstallHarness(metadata: { harnessInstallVersion?: number } | null | undefined, online: boolean): boolean {
    return online && (metadata?.harnessInstallVersion ?? 0) >= HARNESS_INSTALL_CAPABILITY_VERSION;
}

export function readHarnessInstall(daemonState: unknown, now = Date.now()): HarnessInstallView | null {
    const raw = daemonState && typeof daemonState === 'object' ? (daemonState as { harnessInstall?: unknown }).harnessInstall : undefined;
    const parsed = HarnessInstallStateSchema.safeParse(raw);
    if (!parsed.success || !isHarnessInstallId(parsed.data.harness)) return null;
    const { harness, state, detail, at, startedAt } = parsed.data;
    if (state === 'installing') {
        return now - startedAt > HARNESS_INSTALL_STALE_MS
            ? { harness, state: 'failed', detail: 'stale', at }
            : { harness, state: 'installing', detail: null, at };
    }
    return { harness, state: state === 'installed' ? 'installed' : 'failed', detail: detail ?? null, at };
}

/** Error codes the daemon answers with; anything else is shown generically. */
export const HARNESS_INSTALL_ERRORS = ['install_location_not_writable', 'install_location_unverified', 'install_in_progress', 'cli_update_in_progress', 'unknown_harness'] as const;
export type HarnessInstallError = (typeof HARNESS_INSTALL_ERRORS)[number] | 'request_failed';

export async function requestHarnessInstall(machineId: string, harness: HarnessInstallId): Promise<{ ok: true } | { ok: false; error: HarnessInstallError }> {
    try {
        const result = await apiSocket.machineRPC<unknown, { harness: HarnessInstallId }>(machineId, 'harness-install', { harness });
        if (result && typeof result === 'object' && (result as { accepted?: unknown }).accepted === true) return { ok: true };
        const code = result && typeof result === 'object' ? (result as { error?: unknown }).error : undefined;
        return { ok: false, error: (HARNESS_INSTALL_ERRORS as readonly unknown[]).includes(code) ? code as HarnessInstallError : 'request_failed' };
    } catch {
        return { ok: false, error: 'request_failed' };
    }
}
