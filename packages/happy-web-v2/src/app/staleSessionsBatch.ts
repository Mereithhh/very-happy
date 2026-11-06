/**
 * staleSessionsBatch (B-894) — the machine page's 「旧版会话」 group: every live
 * session on this machine whose wrapper still runs older CLI code than the
 * daemon (staleWrapperPolicy), and the one-click 「重启空闲的旧会话」.
 *
 * Why: sessions the daemon can never prove idle (pre-auto-restart wrappers,
 * `manual / no-report | no-check-in`) stay on old code until someone opens
 * each one and clicks its banner — long-lived team leads ran a 15-day-old CLI.
 * The daemon still never restarts these by itself; the owner does, in one
 * place, and only idle ones:
 *  - skipped (with the reason shown): a turn running, an approval / question
 *    waiting, background tasks, or a restart already under way — from what
 *    the Web sees AND the daemon's own per-session wait reason;
 *  - team sessions are listed but not pre-selected (restarting a lead or
 *    member interrupts its team's flow);
 *  - the restart itself always asks the daemon `ifIdle`, so a turn that
 *    started after this snapshot is refused rather than killed. A daemon
 *    without `daemonState.autoRestart.idleGuard` (older CLI) cannot refuse,
 *    so the batch is disabled there (「升级 CLI 后可用」, B-894c); the
 *    single-session restart on each banner is unchanged.
 *
 * Pure rules only (no store / network imports).
 */
import { staleWrapperNotice, type StaleWrapperMachineLike, type StaleWrapperNotice } from './staleWrapperPolicy';
import type { MachineAutoRestart } from './autoRestartPolicy';

export type StaleSessionSkip = 'turn-active' | 'pending-request' | 'background-tasks' | 'restarting';
export const STALE_SESSION_SKIPS: readonly StaleSessionSkip[] = ['turn-active', 'pending-request', 'background-tasks', 'restarting'];

export interface StaleBatchSessionLike {
    id: string;
    active?: boolean;
    archivedAt?: number | null;
    thinking?: boolean;
    metadata?: {
        machineId?: string;
        version?: string;
        flavor?: string | null;
        tags?: string[] | null;
    } | null;
    agentState?: {
        requests?: Record<string, unknown> | null;
        backgroundTasks?: { tasks?: unknown[] | null } | null;
    } | null;
}

export interface StaleSessionEntry {
    id: string;
    notice: StaleWrapperNotice;
    team: boolean;
    /** Why the batch will not restart it now; null = restartable. */
    skip: StaleSessionSkip | null;
    /** Pre-checked in the list: restartable and not a team session. */
    defaultSelected: boolean;
}

export function isTeamSession(session: StaleBatchSessionLike): boolean {
    return (session.metadata?.tags ?? []).includes('teams');
}

/** Daemon wait reasons that mean "busy right now" (same words as the batch's skips). */
const DAEMON_BUSY: Record<string, StaleSessionSkip> = {
    'turn-active': 'turn-active',
    'pending-request': 'pending-request',
    'background-tasks': 'background-tasks',
};

export function staleSessionSkip(
    session: StaleBatchSessionLike,
    input: { backgroundTasks: number; autoRestart: MachineAutoRestart | null; restarting: boolean },
): StaleSessionSkip | null {
    if (input.restarting || input.autoRestart?.sessions[session.id]?.state === 'restarting') return 'restarting';
    if (session.thinking === true) return 'turn-active';
    if (Object.keys(session.agentState?.requests ?? {}).length > 0) return 'pending-request';
    if (input.backgroundTasks > 0 || (session.agentState?.backgroundTasks?.tasks?.length ?? 0) > 0) return 'background-tasks';
    const daemonReason = input.autoRestart?.sessions[session.id]?.reason;
    return daemonReason ? DAEMON_BUSY[daemonReason] ?? null : null;
}

/** This machine's live sessions on an older CLI than its daemon, restartable first. */
export function staleSessionsForMachine(
    machineId: string,
    machine: StaleWrapperMachineLike | null | undefined,
    sessions: readonly StaleBatchSessionLike[],
    input: { backgroundTasks: (sessionId: string) => number; autoRestart: MachineAutoRestart | null; restarting: (sessionId: string) => boolean },
): StaleSessionEntry[] {
    const entries: StaleSessionEntry[] = [];
    for (const session of sessions) {
        if (session.metadata?.machineId !== machineId || session.active !== true) continue;
        const notice = staleWrapperNotice(session, machine);
        if (!notice) continue;
        const team = isTeamSession(session);
        const skip = staleSessionSkip(session, {
            backgroundTasks: input.backgroundTasks(session.id),
            autoRestart: input.autoRestart,
            restarting: input.restarting(session.id),
        });
        entries.push({ id: session.id, notice, team, skip, defaultSelected: skip === null && !team });
    }
    return entries.sort((a, b) => Number(a.skip !== null) - Number(b.skip !== null) || Number(a.team) - Number(b.team));
}

/** The ids the batch restarts: checked AND still restartable (a skip that appeared after checking wins). */
export function batchRestartIds(entries: readonly StaleSessionEntry[], selected: ReadonlySet<string>): string[] {
    return entries.filter((e) => e.skip === null && selected.has(e.id)).map((e) => e.id);
}

/** Whether the daemon refuses a busy session on `restart-session { ifIdle }` (B-894). */
export function daemonHasIdleGuard(daemonState: unknown): boolean {
    const ar = (daemonState as { autoRestart?: { idleGuard?: unknown } } | null | undefined)?.autoRestart;
    return ar?.idleGuard === true;
}

/** Why 「重启空闲的旧会话」 is unavailable, or null when it can run. Without the
 *  daemon's idle guard the Web snapshot is the only protection, so a batch
 *  could kill a turn that began after it (QA56 P1, Web ships before CLI). */
export type BatchRestartBlock = 'offline' | 'needs-cli-upgrade' | 'none-selected' | 'running';
export function batchRestartBlock(input: { online: boolean; daemonState: unknown; count: number; running: boolean }): BatchRestartBlock | null {
    if (!input.online) return 'offline';
    if (!daemonHasIdleGuard(input.daemonState)) return 'needs-cli-upgrade';
    if (input.running) return 'running';
    if (input.count === 0) return 'none-selected';
    return null;
}

/** `busy:<reason>` — the daemon's ifIdle refusal → the skip it means. */
export function busyRefusal(message: string | undefined): StaleSessionSkip | null {
    const m = /^busy:([a-z-]+)/.exec((message ?? '').trim());
    return m && (STALE_SESSION_SKIPS as readonly string[]).includes(m[1]) ? m[1] as StaleSessionSkip : null;
}
