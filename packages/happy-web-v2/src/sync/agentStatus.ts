import { isAgentWorkLive } from './agentLiveness';

export type AgentExecution = 'running' | 'input' | 'idle' | 'unknown' | 'offline';
export function sessionExecution(input: {
    online: boolean; active: boolean; fresh: boolean; thinking: boolean;
    needsInput: boolean; runningSubagents?: number;
}): AgentExecution {
    if (!input.online || !input.active) return 'offline';
    if (input.fresh && input.needsInput) return 'input';
    const running = isAgentWorkLive({ presence: 'online', thinking: input.thinking,
        heartbeatFresh: input.fresh, runningSubagentsInTurn: input.runningSubagents ?? 0 });
    return running ? 'running' : input.fresh ? 'idle' : 'unknown';
}
export function terminalExecution(input: { online: boolean; fresh: boolean; state?: string }): AgentExecution {
    if (!input.online) return 'offline';
    if (!input.fresh) return 'unknown';
    return input.state === 'working' ? 'running' : input.state === 'needs_input' ? 'input'
        : input.state === 'idle' || input.state === 'shell' ? 'idle' : 'unknown';
}
export function agentStatusSignal(execution: AgentExecution, unread: boolean): AgentExecution | 'unread' | null {
    if (execution === 'running' || execution === 'input') return execution;
    // Offline/unknown must not hide output the user has not read (B-312).
    return unread ? 'unread' : execution === 'idle' ? null : execution;
}
export function codingAgentLabel(kind: string | null | undefined): string {
    return kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex'
        : kind === 'pi' || kind === 'pi-acp' ? 'Pi' : 'Agent';
}
