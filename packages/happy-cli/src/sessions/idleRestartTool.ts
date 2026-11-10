/**
 * B-911 — `request_idle_restart`: the agent asks Very Happy to restart its OWN
 * session in place once it is idle (after the current turn). New wrappers only
 * (the tool ships with them); it takes no session id — the daemon matches the
 * calling wrapper by `{ sessionId, pid }` (`/session-restart-request`), queues
 * it, and restarts it when idle exactly like the owner's 「本轮结束后重启」.
 *
 * Abuse limits (daemon side, `update/idleRestartPolicy.ts`): one pending
 * request per session; at most 3 accepted per rolling 24 h; none within 10 min
 * of the session's last restart; a request not idle within 6 h is dropped.
 */
import type { AssistantToolRegistrar } from '@/assistant/assistantTools';
import type { IdleRestartReply } from '@/daemon/controlServer';

export const IDLE_RESTART_TOOL_NAME = 'request_idle_restart';
export const IDLE_RESTART_TOOL_NAMES = [IDLE_RESTART_TOOL_NAME] as const;

export const IDLE_RESTART_TOOL_DESCRIPTION = 'Ask Very Happy to restart THIS session in place once it is idle: after the current turn ends and nothing is running. '
    + 'Use it when this session runs an outdated Very Happy wrapper (a fix or tool it should have is missing) or the user asks you to restart. '
    + 'History, model, effort and permission mode are kept; the turn you are in is not interrupted, and the next message is answered by the restarted session. '
    + 'It can only restart this session. Limits: one pending request at a time, at most 3 accepted requests per 24 hours, none within 10 minutes of this session\'s last restart.';

const minutes = (ms: number | undefined) => Math.max(1, Math.ceil((ms ?? 0) / 60_000));

/** The text the model reads for a daemon reply (refusals name their code first). */
export function idleRestartToolResult(reply: IdleRestartReply): { text: string; isError: boolean } {
    if (reply.ok) {
        return {
            text: reply.state === 'already-queued'
                ? 'Already queued: this session will be restarted in place once it is idle. Finish your turn normally; do not call this again.'
                : 'Queued: Very Happy will restart this session in place once this turn ends and the session is idle (history, model, effort and permission mode are kept). Finish your turn normally; do not call this again.',
            isError: false,
        };
    }
    const why: Record<string, string> = {
        'rate-limited': `this session already asked 3 times in the last 24 hours; try again in about ${minutes(reply.retryAfterMs)} min, or ask the user to restart it`,
        'cooldown': `this session was restarted less than 10 minutes ago; try again in about ${minutes(reply.retryAfterMs)} min`,
        'local-terminal': 'this session runs in the user\'s own terminal, which Very Happy never restarts; ask the user',
        'not-live': 'the Very Happy daemon does not track this session\'s wrapper; ask the user to restart it from the session menu',
        'not-caller': 'the Very Happy daemon does not track this session\'s wrapper; ask the user to restart it from the session menu',
        'not-resumable': 'this conversation cannot be resumed from disk, so a restart would lose it',
        'assistant': 'assistant sessions are not restarted this way',
        'unsupported-flavor': 'this agent cannot be restarted in place',
        'no-turn-reports': 'this wrapper cannot report when it is idle',
        'daemon-too-old': 'the running Very Happy daemon predates this tool; ask the user to update Very Happy',
        'daemon-unreachable': 'the Very Happy daemon is not reachable',
    };
    return { text: `Restart refused (${reply.code}): ${why[reply.code] ?? 'the daemon could not queue it'}.`, isError: true };
}

export function registerIdleRestartTool(server: AssistantToolRegistrar, execute: () => Promise<{ text: string; isError: boolean }>): void {
    server.registerTool(IDLE_RESTART_TOOL_NAME, {
        description: IDLE_RESTART_TOOL_DESCRIPTION,
        title: 'Restart this session when idle',
        inputSchema: {},
    }, async () => {
        try {
            const result = await execute();
            return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
        } catch (error) {
            return { content: [{ type: 'text' as const, text: `Restart request failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    });
}
