/**
 * B-587 review P3-2 / AGENTS 7 — what a Codex wrapper tells the server on the
 * way out, by WHY it exits (the Codex twin of claude/sessionExitLifecycle):
 *   - `archive`: the user archived / killed it → stamp lifecycleState archived;
 *   - `offline`: SIGTERM / SIGINT (daemon stop, upgrade, shutdown) → only
 *     session-end + POST /deactivate, never an archived stamp.
 */
import type { Metadata } from '@/api/types';

export interface CodexTerminationSession {
    readonly sessionId: string;
    updateMetadata(handler: (metadata: Metadata) => Metadata): void;
    sendSessionDeath(): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export async function settleCodexSession(
    session: CodexTerminationSession,
    intent: 'archive' | 'offline',
    deactivate: (sessionId: string) => Promise<unknown>,
    log: (message: string, error?: unknown) => void = () => {},
): Promise<void> {
    if (intent === 'archive') {
        session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'cli',
            archiveReason: 'User terminated',
        }));
    }
    session.sendSessionDeath();
    await session.flush();
    if (intent === 'offline') {
        try { await deactivate(session.sessionId); } catch (error) { log('[Codex] deactivate on signal failed', error); }
    }
    await session.close();
}
