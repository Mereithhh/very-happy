/**
 * B-587 review P3-2 / AGENTS 7 — what a Codex wrapper tells the server on the
 * way out, by WHY it exits (the Codex twin of claude/sessionExitLifecycle):
 *   - `archive`: the user archived / killed it → stamp lifecycleState archived;
 *   - `offline`: SIGTERM / SIGINT (daemon stop, upgrade, shutdown) → only
 *     session-end + POST /deactivate, never an archived stamp.
 */
import type { Metadata } from '@/api/types';
import { OFFLINE_EXIT_STAMP_TIMEOUT_MS } from '@/claude/sessionExitLifecycle';

export interface CodexTerminationSession {
    readonly sessionId: string;
    updateMetadata(handler: (metadata: Metadata) => Metadata): void;
    /** B-679: awaited write for the offline exit cursor (false on timeout). */
    updateMetadataAndWait?(handler: (metadata: Metadata) => Metadata, timeoutMs?: number): Promise<boolean>;
    sendSessionDeath(): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export async function settleCodexSession(
    session: CodexTerminationSession,
    intent: 'archive' | 'offline',
    deactivate: (sessionId: string) => Promise<unknown>,
    log: (message: string, error?: unknown) => void = () => {},
    /** B-679: offline exit cursor (inbound already frozen) — see claude/sessionExitLifecycle. */
    exitCursor?: NonNullable<Metadata['exitCursor']>,
): Promise<void> {
    if (intent === 'offline' && exitCursor && session.updateMetadataAndWait) {
        const landed = await session.updateMetadataAndWait((currentMetadata) => ({ ...currentMetadata, exitCursor }), OFFLINE_EXIT_STAMP_TIMEOUT_MS);
        if (!landed) log('[Codex] offline exit cursor not confirmed before going offline');
    }
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
