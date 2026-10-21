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

/** The daemon serves `harness-install` (regardless of whether it is reachable right now). */
export function harnessInstallSupported(metadata: { harnessInstallVersion?: number } | null | undefined): boolean {
    return (metadata?.harnessInstallVersion ?? 0) >= HARNESS_INSTALL_CAPABILITY_VERSION;
}

export function machineCanInstallHarness(metadata: { harnessInstallVersion?: number } | null | undefined, online: boolean): boolean {
    return online && harnessInstallSupported(metadata);
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
export const HARNESS_INSTALL_ERRORS = ['install_location_not_writable', 'install_location_unverified', 'install_in_progress', 'cli_update_in_progress', 'installer_blocked', 'node_too_old', 'unknown_harness'] as const;
export type HarnessInstallError = (typeof HARNESS_INSTALL_ERRORS)[number] | 'request_failed';
export type HarnessInstallRefusal = { ok: false; error: HarnessInstallError; required?: string; current?: string };

const NODE_VERSION = /^v?\d+\.\d+\.\d+$/;

export async function requestHarnessInstall(machineId: string, harness: HarnessInstallId): Promise<{ ok: true } | HarnessInstallRefusal> {
    try {
        const result = await apiSocket.machineRPC<unknown, { harness: HarnessInstallId }>(machineId, 'harness-install', { harness });
        if (result && typeof result === 'object' && (result as { accepted?: unknown }).accepted === true) return { ok: true };
        const raw = result && typeof result === 'object' ? result as { error?: unknown; required?: unknown; current?: unknown } : {};
        const error = (HARNESS_INSTALL_ERRORS as readonly unknown[]).includes(raw.error) ? raw.error as HarnessInstallError : 'request_failed';
        if (error === 'node_too_old') {
            const required = typeof raw.required === 'string' && NODE_VERSION.test(raw.required) ? raw.required : '?';
            const current = typeof raw.current === 'string' && NODE_VERSION.test(raw.current) ? raw.current : '?';
            return { ok: false, error, required, current };
        }
        return { ok: false, error };
    } catch {
        return { ok: false, error: 'request_failed' };
    }
}
