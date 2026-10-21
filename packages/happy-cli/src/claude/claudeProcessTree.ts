/**
 * B-634 ①: Claude Code's process tree outlives a hard abort today. The SDK
 * stops only the root it spawned (stdin EOF, SIGTERM after 2 s, SIGKILL 5 s
 * later — sdk.mjs ProcessTransport.close); MCP servers, Bash tool commands and
 * background tasks under it re-parent to init and keep running unowned.
 *
 * The SDK's own spawn reports the child's pid through the `onProcessSpawned`
 * option (0.3.296 sdk.mjs spawnLocalProcess; not in sdk.d.ts — pinned by
 * claudeProcessTree.test.ts so an SDK bump that drops it fails loudly). Using
 * it instead of a custom `spawnClaudeCodeProcess` keeps the SDK's stderr tail
 * that B-631's exit reasons are built from.
 *
 * On abort the tree (root included) is snapshotted at once — while the root
 * is still alive — and whatever of it is still the same process after the
 * SDK's own kill window is SIGKILLed.
 */
import { logger } from '@/ui/logger';
import { killSurvivors, snapshotTree, type ProcessEntry, type ReapDeps } from '@/utils/processTreeSnapshot';

/** SDK close(): 2 s to exit on stdin EOF, then SIGTERM, then SIGKILL 5 s later — plus a margin. */
export const CLAUDE_TREE_REAP_DELAY_MS = 8_000;

export type ClaudeTreeReapDeps = ReapDeps & {
    snapshot?: (pid: number) => ProcessEntry[];
    schedule?: (callback: () => void, delayMs: number) => void;
};

/** Snapshot `pid`'s tree now; SIGKILL what is left of it after the SDK's kill window. */
export function scheduleClaudeTreeReap(pid: number, deps: ClaudeTreeReapDeps = {}): ProcessEntry[] {
    const snapshot = (deps.snapshot ?? ((root) => snapshotTree(root, { includeRoot: true, read: deps.read })))(pid);
    if (snapshot.length === 0) return snapshot;
    const schedule = deps.schedule ?? ((callback, delayMs) => { setTimeout(callback, delayMs).unref?.(); });
    schedule(() => {
        const killed = killSurvivors(snapshot, deps);
        if (killed.length > 0) logger.debug(`[claude] Reaped ${killed.length} process(es) left from aborted Claude Code ${pid}: ${killed.join(', ')}`);
    }, CLAUDE_TREE_REAP_DELAY_MS);
    return snapshot;
}
