/**
 * Import a Codex thread that was never started through very-happy (B-464).
 *
 * Import = copy, never move: the wrapper asks the app-server to `thread/fork`
 * the source thread (a new rollout with its own id; the original stays with
 * the tool that wrote it), makes the fork this session's active thread, and
 * replays the fork's turns into the Happy session so the chat shows the full
 * history. From here on the session behaves exactly like one that resumed the
 * fork: `metadata.codexThreadId` is the fork, so a daemon restart resumes it;
 * `importedFromCodexThreadId` is the original, so the import picker hides it.
 *
 * Why the wrapper forks and not the daemon (unlike `claude-import-session`,
 * which copies the JSONL before spawning): forking needs a live app-server,
 * and a fork made before the spawn has no owner to discard it when the spawn
 * is refused (missing cwd, machine dropped) — Codex keeps the sqlite row even
 * if the rollout file is deleted. Forking inside the spawned wrapper means a
 * refused spawn creates nothing at all; a fork that fails here surfaces as a
 * failed session, the same way a failed `--resume` does.
 */
import type { Thread } from './codexAppServerTypes';
import { mapCodexThreadToSessionEnvelopes } from './utils/sessionProtocolMapper';
import { trimIdent } from '@/utils/trimIdent';

type ImportThreadClient = {
    forkThread: (opts: {
        threadId: string;
        cwd: string;
        mcpServers: Record<string, unknown>;
    }) => Promise<{ threadId: string; model: string; thread: Thread }>;
    readThread: (opts: { threadId: string; includeTurns: boolean }) => Promise<{ thread: Thread }>;
};

type ImportThreadSession = {
    updateMetadata: (handler: (currentMetadata: any) => any) => void;
    sendSessionEvent: (event: { type: 'message'; message: string }) => void;
    sendSessionProtocolMessage: (envelope: any) => void;
};

type ImportThreadMessageBuffer = {
    addMessage: (message: string, type: 'status') => void;
};

export const IMPORT_CODEX_THREAD_ENV = 'HAPPY_IMPORT_CODEX_THREAD_ID';

export async function importCodexThread(opts: {
    client: ImportThreadClient;
    session: ImportThreadSession;
    messageBuffer: ImportThreadMessageBuffer;
    /** The original thread (the one Codex CLI / desktop wrote). */
    threadId: string;
    cwd: string;
    mcpServers: Record<string, unknown>;
}): Promise<{ threadId: string; model: string; replayed: number }> {
    let forked: { threadId: string; model: string; thread: Thread };
    try {
        forked = await opts.client.forkThread({
            threadId: opts.threadId,
            cwd: opts.cwd,
            mcpServers: opts.mcpServers,
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to import Codex thread ${opts.threadId}: ${reason}`);
    }
    if (!forked.threadId || forked.threadId === opts.threadId) {
        throw new Error(`Failed to import Codex thread ${opts.threadId}: Codex did not create an independent copy`);
    }

    // Record the lineage before replaying: a crash mid-replay must still leave
    // a session that resumes the fork, not one that re-forks on restart.
    opts.session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        codexThreadId: forked.threadId,
        importedFromCodexThreadId: opts.threadId,
    }));

    // `thread/fork` answers with the forked thread; older app-servers may omit
    // its turns, in which case read the fork explicitly (never the original —
    // what the chat shows must be what this session continues).
    let thread: Thread = forked.thread;
    if (!Array.isArray(thread?.turns)) {
        thread = (await opts.client.readThread({ threadId: forked.threadId, includeTurns: true })).thread;
    }
    const envelopes = mapCodexThreadToSessionEnvelopes(thread);
    for (const envelope of envelopes) {
        opts.session.sendSessionProtocolMessage(envelope);
    }

    opts.messageBuffer.addMessage(`Imported thread ${trimIdent(opts.threadId)} as ${trimIdent(forked.threadId)}`, 'status');
    opts.session.sendSessionEvent({
        type: 'message',
        message: `Imported Codex thread ${opts.threadId} (continuing as ${forked.threadId})`,
    });
    return { threadId: forked.threadId, model: forked.model, replayed: envelopes.length };
}
