import { PI_ADAPTER_INSTALL_HINT } from '@/agent/acp/piRunnerArgs';
import type { CLIAvailability } from '@/utils/detectCLI';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

/**
 * Fail a `/spawn-session` for pi up front when the daemon's own CLI
 * availability says pi cannot run here (`pi` or `pi-acp` missing).
 *
 * Without this the wrapper spawns, logs `spawn pi-acp ENOENT` to its own log
 * file (the daemon starts wrappers with stdio 'ignore', so the terminal hint in
 * index.ts never reaches anyone) and `spawn --json` exits 0 with
 * promptDelivered:true. The availability is the same value the machine
 * metadata advertises (detectCLI.ts, re-probed by the keep-alive) — no extra
 * probe. Only pi is gated: the other agents are exec'd by name and fail loudly
 * in their own terminal/tmux window.
 */
export function spawnAgentUnavailableError(
    agent: SpawnSessionOptions['agent'],
    availability: Pick<CLIAvailability, 'pi'>,
): Extract<SpawnSessionResult, { type: 'error' }> | null {
    if (agent === 'pi' && !availability.pi) {
        return { type: 'error', errorMessage: PI_ADAPTER_INSTALL_HINT };
    }
    return null;
}
