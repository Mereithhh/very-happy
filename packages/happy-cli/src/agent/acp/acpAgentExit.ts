/**
 * B-629: the error an in-flight ACP request rejects with when the agent process is gone — its
 * exit code/signal and last stderr lines, so the runner can say why instead of hanging (the ACP
 * SDK never rejects pending responses when the stream closes; it only aborts its signal).
 * Kept apart from AcpBackend so the runners' failure texts can be tested without it.
 */
export type AgentExitError = Error & {
    agentExited: true;
    agentExitCode: number | null;
    agentExitSignal: NodeJS.Signals | null;
    agentStderrTail: string;
};

export function isAgentExitError(error: unknown): error is AgentExitError {
    return error instanceof Error && (error as { agentExited?: unknown }).agentExited === true;
}

export function agentExitError(agentName: string, code: number | null, signal: NodeJS.Signals | null, tail: string): AgentExitError {
    const exited = `${agentName} process exited (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`;
    return Object.assign(new Error(tail ? `${exited}: ${tail}` : exited), {
        agentExited: true as const,
        agentExitCode: code,
        agentExitSignal: signal,
        agentStderrTail: tail,
    });
}
