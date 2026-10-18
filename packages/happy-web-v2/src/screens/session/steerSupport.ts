import { normalizeAgentKey } from '@/sync/agentDefaults';

/** Claude's wrapper injects a `delivery: 'steer'` message into its live query. */
export const CLAUDE_STEER_CAPABILITY = 'claude-steer-v1';
/** B-628: the Codex wrapper sends it into the running turn (`turn/steer`). */
export const CODEX_STEER_CAPABILITY = 'codex-steer-v1';

/**
 * Whether the wrapper behind a session takes a message into the turn that is running,
 * so the composer may offer「Steer」on a queued message. Decided per agent by the
 * capability its wrapper advertises (AGENTS #14), never by flavor alone: a Codex session
 * on a CLI before 0.2.176 shows no Steer, exactly as before.
 */
export function wrapperSupportsSteer(flavor: string | null | undefined, capabilities: readonly string[] | null | undefined): boolean {
    const caps = capabilities ?? [];
    switch (normalizeAgentKey(flavor)) {
        case 'claude':
            return caps.includes(CLAUDE_STEER_CAPABILITY);
        case 'codex':
            return caps.includes(CODEX_STEER_CAPABILITY);
        default:
            return false;
    }
}
