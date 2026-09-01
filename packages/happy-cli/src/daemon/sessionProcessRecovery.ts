import type { Metadata } from '@/api/types';
import { processIdentityFields } from '@/utils/reconnectSession';

/** Adopt a persisted PID only when current process inventory independently
 * confirms that PID still belongs to a Happy CLI process. This avoids killing
 * an unrelated process after PID reuse. */
export function recoverableSessionPid(metadata: Metadata | undefined, liveHappyPids: ReadonlySet<number>): number | null {
    const pid = metadata?.hostPid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && liveHappyPids.has(pid)
        ? pid
        : null;
}

/** One row of `findAllHappyProcesses()` — pid plus the full command line. */
export type LiveHappyProcess = { pid: number; command: string };

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The agent conversation id a session wrapper is resumed with. */
export function sessionAgentConversationId(metadata: Metadata | undefined): string | null {
    if (!metadata) return null;
    if (metadata.flavor === 'codex') return metadata.codexThreadId ?? null;
    return metadata.claudeSessionId ?? metadata.codexThreadId ?? null;
}

/**
 * B-272: does this command line belong to a DAEMON-SPAWNED wrapper that
 * resumes the given agent conversation? Only `--started-by daemon` wrappers
 * qualify — a user's own `happy claude --resume <id>` terminal is a different
 * happy session (local mode, fresh row) and must never be adopted or killed
 * by the daemon. The SDK child (`claude … --resume=<id>`) carries no
 * `--started-by` and is excluded the same way.
 */
export function isDaemonWrapperForConversation(command: string, conversationId: string): boolean {
    if (!command || !conversationId) return false;
    const startedByDaemon = /(?:^|\s)--started-by\s+daemon(?:\s|$)/.test(command);
    if (!startedByDaemon) return false;
    const resume = new RegExp(`(?:^|\\s)--resume(?:\\s+|=)${escapeRegExp(conversationId)}(?:\\s|$)`);
    return resume.test(command);
}

/**
 * B-272: every live wrapper that belongs to this session, persisted-pid first.
 *
 * `hostPid` alone is not enough: the post-spawn restore record used to be
 * written from the pre-spawn (server / on-disk) metadata and clobbered the
 * webhook's fresh `hostPid` with the previous wrapper's dead pid. A daemon
 * restarted afterwards could not re-adopt the wrapper, `restart-session` then
 * found nothing to stop and spawned a SECOND wrapper onto the same session —
 * two SDK runs on one conversation (every user message shown 3×, thinking and
 * permission-mode ping-pong). Matching the daemon-spawned `--resume <id>`
 * command line recovers such orphans (and exposes duplicates) regardless of
 * what the record says.
 */
export function findSessionWrapperPids(
    metadata: Metadata | undefined,
    liveHappyProcesses: readonly LiveHappyProcess[],
    options: { excludePid?: number } = {},
): number[] {
    const out: number[] = [];
    const livePids = new Set(liveHappyProcesses.map((p) => p.pid));
    const persisted = recoverableSessionPid(metadata, livePids);
    if (persisted !== null && persisted !== options.excludePid) out.push(persisted);

    const conversationId = sessionAgentConversationId(metadata);
    if (conversationId) {
        for (const proc of liveHappyProcesses) {
            if (proc.pid === options.excludePid || out.includes(proc.pid)) continue;
            if (isDaemonWrapperForConversation(proc.command, conversationId)) out.push(proc.pid);
        }
    }
    return out;
}

/**
 * B-272: the metadata to persist after a resume/restart spawn succeeded.
 * `stale` is what the spawn was built from (server or on-disk copy: has
 * `claudeSessionId` / `codexThreadId` / `path`); `reported` is what the new
 * wrapper just webhooked (its own `hostPid`, `version`, capabilities…). The
 * identity slice of the new process wins so the next daemon restart can adopt
 * the wrapper by pid instead of leaving it orphaned.
 */
export function mergeRestoreMetadata(stale: Metadata, reported: Metadata | undefined): Metadata {
    if (!reported) return stale;
    return { ...stale, ...processIdentityFields(reported) };
}
