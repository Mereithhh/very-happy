/**
 * B-512: which startup steps a Claude wrapper runs before it reports the session
 * to the daemon. Pure so the decisions are unit-tested apart from runClaude.
 *
 * - A daemon-spawned wrapper skips `getOrCreateMachine` and `ensureDaemonRunning`:
 *   the daemon that spawned it has registered the machine and is, by
 *   definition, running. Session rows carry no machine foreign key, and the
 *   machine response was never used. Terminal launches keep both steps.
 * - A fresh session creates its session socket right after the single-writer
 *   claim, before the daemon webhook, so the socket connects while the webhook
 *   and the post-webhook setup run. A reconnect (resume / restart) keeps the
 *   original order: reactivate → snapshot → webhook → socket.
 */
export type ClaudeStartupPlan = {
    registerMachine: boolean;
    ensureDaemonRunning: boolean;
    sessionClientBeforeWebhook: boolean;
};

export function planClaudeStartup(input: {
    startedBy?: 'daemon' | 'terminal';
    reconnect: boolean;
}): ClaudeStartupPlan {
    const daemonSpawned = input.startedBy === 'daemon';
    return {
        registerMachine: !daemonSpawned,
        ensureDaemonRunning: !daemonSpawned,
        sessionClientBeforeWebhook: !input.reconnect,
    };
}
