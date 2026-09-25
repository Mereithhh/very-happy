import { isAgentWorkLive } from './agentLiveness';

/** B-507: `background` = the turn ended but the wrapper reports background
 *  tasks (async sub-agents, backgrounded commands) still in flight — not idle,
 *  not "waiting for you"; the session will wake itself when they finish. */
export type AgentExecution = 'running' | 'background' | 'input' | 'idle' | 'unknown' | 'offline';
export function sessionExecution(input: {
    online: boolean; active: boolean; fresh: boolean; thinking: boolean;
    needsInput: boolean; runningSubagents?: number;
    /** B-507: heartbeat-reported in-flight background tasks (0 when unknown / lease expired). */
    backgroundTasks?: number;
}): AgentExecution {
    if (!input.online || !input.active) return 'offline';
    if (input.fresh && input.needsInput) return 'input';
    const running = isAgentWorkLive({ presence: 'online', thinking: input.thinking,
        heartbeatFresh: input.fresh, runningSubagentsInTurn: input.runningSubagents ?? 0 });
    if (running) return 'running';
    if (input.fresh && (input.backgroundTasks ?? 0) > 0) return 'background';
    return input.fresh ? 'idle' : 'unknown';
}
/** B-465: daemons before 0.2.134 report `agentState` without an observation
 *  stamp, so their receipt lease is never fresh and every terminal read as
 *  "unknown" — a Claude mid-turn landed in 等我看 with a question mark. Those
 *  daemons still push state CHANGES and tmux activity, and an agent in a turn
 *  keeps its spinner moving, so recent activity is the honest "still working"
 *  signal for them; a pending dialog is silent, so needs_input is taken as
 *  reported (that is what the old classifier already did, and offline still
 *  gates it). Nothing here applies once the daemon stamps observations. */
export const LEGACY_TERMINAL_ACTIVITY_TTL_MS = 60_000;
export function terminalExecution(input: {
    online: boolean; fresh: boolean; state?: string;
    /** Set only for an entry with NO `agentObservedAt` (old daemon). */
    legacy?: { activityAt?: number; now: number };
}): AgentExecution {
    if (!input.online) return 'offline';
    if (!input.fresh) {
        const legacy = input.legacy;
        if (!legacy) return 'unknown';
        if (input.state === 'needs_input') return 'input';
        if (input.state === 'working') {
            return legacy.activityAt !== undefined && legacy.now - legacy.activityAt <= LEGACY_TERMINAL_ACTIVITY_TTL_MS ? 'running' : 'unknown';
        }
        return input.state === 'idle' || input.state === 'shell' ? 'idle' : 'unknown';
    }
    return input.state === 'working' ? 'running' : input.state === 'needs_input' ? 'input'
        : input.state === 'idle' || input.state === 'shell' ? 'idle' : 'unknown';
}
export function agentStatusSignal(execution: AgentExecution, unread: boolean): AgentExecution | 'unread' | null {
    if (execution === 'running' || execution === 'background' || execution === 'input') return execution;
    // Offline/unknown must not hide output the user has not read (B-312).
    return unread ? 'unread' : execution === 'idle' ? null : execution;
}
export function codingAgentLabel(kind: string | null | undefined): string {
    return kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex'
        : kind === 'pi' || kind === 'pi-acp' ? 'Pi' : 'Agent';
}
