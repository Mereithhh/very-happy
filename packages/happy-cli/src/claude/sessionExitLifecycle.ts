/**
 * B-505 — what a Claude wrapper tells the server about its session on the way
 * out, decided by WHY it is exiting.
 *
 * Two exits look identical from the process's point of view (cleanup, flush,
 * exit 0) but mean opposite things to the user:
 *
 *   - `archive`: the session is over on purpose — the user pressed Archive /
 *     kill in the web (`killSession` RPC), the server already archived the row
 *     (`session-archive` command), or the wrapper crashed and cannot go on.
 *     The row gets the server-owned `archivedAt` tombstone (POST `/archive`),
 *     the metadata is stamped `lifecycleState: 'archived'`, and the web offers
 *     "Restore".
 *
 *   - `offline`: the PROCESS is being taken down but the session is not —
 *     SIGTERM / SIGINT from a daemon stop, a supervisor restart (systemd
 *     `KillMode=control-group` signals every wrapper when the daemon exits),
 *     a machine shutdown, a user's Ctrl-C. The row must end up exactly where
 *     a dropped network link leaves it: `active=false`, `archivedAt` untouched
 *     (POST `/deactivate`), metadata untouched, so the web shows it offline
 *     and the next daemon (or the user) can resume it in place.
 *
 * Until 2026-09-25 the `offline` path posted to `/archive` as a "belt and
 * braces" for `session-end`, written when that route only flipped `active`.
 * B-265 made `/archive` the tombstone writer, so every dev-sg upgrade
 * (`daemon stop` → systemd kills the cgroup → wrappers get SIGTERM) archived
 * the sessions that were mid-turn, and the server's `session-archive` answer
 * then re-entered cleanup as `archive`. The intent is decided ONCE
 * (`SessionExitGate`): the first reason wins, later ones are logged and
 * ignored, so an `offline` exit can never be escalated to `archive` by the
 * server's echo or by teardown noise from the dying SDK child.
 */
import type { Metadata } from '@/api/types';

export type SessionExitIntent = 'archive' | 'offline';

export interface SessionExitDeps {
    updateMetadata: (handler: (metadata: Metadata) => Metadata) => void;
    sendSessionDeath: () => void;
    /** POST /archive — tombstone. */
    archiveSession: (sessionId: string) => Promise<boolean>;
    /** POST /deactivate — active=false only. */
    deactivateSession: (sessionId: string) => Promise<boolean>;
    log?: (message: string, ...args: unknown[]) => void;
}

/** The lifecycle side of cleanup: metadata stamp, socket death, HTTP fallback. */
export async function settleSessionOnExit(sessionId: string, intent: SessionExitIntent, deps: SessionExitDeps): Promise<void> {
    if (intent === 'archive') {
        deps.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'cli',
            archiveReason: 'User terminated',
        }));
    }

    // Socket path first: the server flips active=false on `session-end`
    // without touching `archivedAt` (sessionUpdateHandler.ts).
    deps.sendSessionDeath();

    // HTTP fallback in case the socket emit does not drain before exit. The
    // route is chosen by intent — never `/archive` for an `offline` exit.
    try {
        if (intent === 'archive') await deps.archiveSession(sessionId);
        else await deps.deactivateSession(sessionId);
    } catch (error) {
        deps.log?.(`[START] ${intent === 'archive' ? 'archiveSession' : 'deactivateSession'} during cleanup failed:`, error);
    }
}

/** First exit reason wins; every later request is reported and dropped. */
export class SessionExitGate {
    private decided: SessionExitIntent | null = null;

    /** Returns the intent to act on, or null when cleanup already started. */
    claim(intent: SessionExitIntent): SessionExitIntent | null {
        if (this.decided !== null) return null;
        this.decided = intent;
        return intent;
    }

    get current(): SessionExitIntent | null {
        return this.decided;
    }
}

export function exitIntentFromArchiveFlag(archive: boolean | undefined): SessionExitIntent {
    return (archive ?? true) ? 'archive' : 'offline';
}
