/**
 * Which metadata a daemon resume / restart relaunches from.
 *
 * The webhook snapshot is taken once, when the wrapper starts. Everything the
 * wrapper changes afterwards — `claudeSessionId` after an in-place edit/delete
 * (B-528/B-544 switch the conversation to a rewound copy), a `/clear`, a new
 * Codex thread — only reaches the server. Relaunching from the snapshot
 * resumed the PRE-edit conversation: the agent got back the turns the chat had
 * dropped (found 2026-10-11 restarting the token360 session). The server copy
 * is authoritative; the snapshot is only the offline fallback.
 */
export async function resolveRelaunchMetadata<M>(
    snapshot: M,
    fetchServer: () => Promise<M | null>,
): Promise<{ metadata: M; source: 'server' | 'snapshot' }> {
    try {
        const server = await fetchServer();
        if (server) return { metadata: server, source: 'server' };
    } catch {
        // fall through to the snapshot
    }
    return { metadata: snapshot, source: 'snapshot' };
}
