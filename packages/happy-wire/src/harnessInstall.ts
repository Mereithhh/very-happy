import { z } from 'zod';

/**
 * B-719 — the coding-agent CLIs a daemon may install or update when the owner
 * clicks Install / Update. The Web and the relay only ever pass one of these
 * ids; which npm packages and versions that means is hardcoded in the CLI
 * (`happy-cli/src/harness/installCatalog.ts`), never sent over the wire.
 */
export const HARNESS_INSTALL_IDS = ['claude', 'codex', 'gemini', 'pi'] as const;
export type HarnessInstallId = (typeof HARNESS_INSTALL_IDS)[number];

export function isHarnessInstallId(value: unknown): value is HarnessInstallId {
    return typeof value === 'string' && (HARNESS_INSTALL_IDS as readonly string[]).includes(value);
}

/** Machine metadata capability: the daemon serves the `harness-install` RPC. */
export const HARNESS_INSTALL_CAPABILITY_VERSION = 1;

/** Published in daemonState.harnessInstall — the last install the owner asked for. */
export const HarnessInstallStateSchema = z.object({
    harness: z.string(),
    state: z.string(), // 'installing' | 'installed' | 'failed' (open: older Web shows unknown states as failed)
    detail: z.string().optional(),
    startedAt: z.number(),
    at: z.number(),
});
export type HarnessInstallState = z.infer<typeof HarnessInstallStateSchema>;
