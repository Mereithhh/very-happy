/**
 * Pure helpers for the daemon's assistant (meta-agent) spawn path — B-051.
 *
 * Everything here is decidable without I/O so the singleton semantics are
 * unit-testable in isolation: live-singleton detection over tracked sessions,
 * sessions.json entry selection/purge listing, `--resume` id resolution, and
 * the in-flight spawn gate that serializes concurrent assistant spawns.
 * daemon/run.ts wires these into the actual process/RPC machinery.
 */

import type { TrackedSession } from '@/daemon/types';
import type { PersistedSession } from '@/persistence';
import type { Metadata } from '@/api/types';
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

/**
 * What `variant: 'assistant'` means for a given spawn request.
 *
 *  - `claude-singleton`: the B-051 voice assistant — cwd forced to
 *    ~/.happy/assistant, per-machine singleton (live check + sessions.json
 *    re-attach), TrackedSession tagged at spawn time. Only Claude has the
 *    in-process assistant tool surface and the CLAUDE.md charter that home
 *    bootstraps, and the re-attach path spawns `claude` by name, so only a
 *    Claude request may enter it.
 *  - `env-only`: any other runner (pi over ACP, codex, …). The request gets
 *    HAPPY_SESSION_VARIANT=assistant on the child — which the runner passes to
 *    its agent and the agent to its MCP servers, so `very-happy mcp` exposes the
 *    session tools — and NOTHING else: the requested directory is honoured and
 *    the TrackedSession is not tagged. Tagging it would let a pi meta-agent
 *    satisfy `findLiveAssistant` and be handed back to the /assistant screen
 *    the next time it asks for its Claude singleton.
 *  - `none`: not an assistant request.
 */
export type AssistantSpawnMode = 'claude-singleton' | 'env-only' | 'none';

export function assistantSpawnMode(options: Pick<SpawnSessionOptions, 'variant' | 'agent'>): AssistantSpawnMode {
    if (options.variant !== 'assistant') return 'none';
    return options.agent === undefined || options.agent === 'claude' ? 'claude-singleton' : 'env-only';
}

/**
 * A tracked session counts as the assistant if it was tagged at spawn time
 * (`variant` on the TrackedSession itself) OR reported itself as assistant
 * via the session webhook metadata. Spawn-time tagging closes the window
 * where the process is already alive but its webhook hasn't landed yet —
 * with webhook-only tagging a second spawn request in that window saw no
 * live assistant and double-spawned.
 */
export function isAssistantTracked(
    tracked: Pick<TrackedSession, 'variant' | 'happySessionMetadataFromLocalWebhook'>,
): boolean {
    return tracked.variant === 'assistant'
        || tracked.happySessionMetadataFromLocalWebhook?.variant === 'assistant';
}

/** First alive tracked assistant session, if any (`isAlive` injected for testability). */
export function findLiveAssistant(
    sessions: Iterable<TrackedSession>,
    isAlive: (pid: number) => boolean,
): TrackedSession | undefined {
    for (const tracked of sessions) {
        if (isAssistantTracked(tracked) && isAlive(tracked.pid)) {
            return tracked;
        }
    }
    return undefined;
}

/** All persisted (sessions.json) session ids marked as the assistant variant. */
export function listPersistedAssistantIds(sessions: Record<string, PersistedSession>): string[] {
    return Object.entries(sessions)
        .filter(([, session]) => session.metadata?.variant === 'assistant')
        .map(([id]) => id);
}

/** Most recently saved persisted assistant entry (re-attach candidate). */
export function pickLatestAssistantEntry(
    sessions: Record<string, PersistedSession>,
): [string, PersistedSession] | undefined {
    return Object.entries(sessions)
        .filter(([, session]) => session.metadata?.variant === 'assistant')
        .sort((a, b) => b[1].savedAt - a[1].savedAt)[0];
}

/**
 * C3: pick the Claude conversation id to `--resume` when re-attaching.
 * sessions.json holds a webhook-time snapshot of the metadata — Claude
 * assigns its session id AFTER that webhook fires and the update only
 * reaches the server — so the server copy wins whenever we managed to fetch
 * it (including "server copy has none": trusting the stale snapshot instead
 * would risk a dangling --resume). The snapshot is only a fallback for
 * "server unreachable".
 */
export function resolveAssistantClaudeSessionId(
    persistedMetadata: Metadata | undefined,
    serverMetadata: Metadata | null,
): string | undefined {
    if (serverMetadata) {
        return serverMetadata.claudeSessionId ?? undefined;
    }
    return persistedMetadata?.claudeSessionId ?? undefined;
}

/**
 * C2a: in-flight gate for assistant spawns.
 *
 *  - `join`   — if a spawn is already in flight, return the SAME promise
 *               (concurrent spawn requests collapse into one; no double
 *               spawn race). Otherwise start one.
 *  - `replace`— wait for any in-flight spawn to settle (its outcome belongs
 *               to its own caller), then start a fresh run. Used by
 *               `forceNew`, which must never reuse an in-flight result.
 */
export interface SpawnGate<T> {
    join(fn: () => Promise<T>): Promise<T>;
    replace(fn: () => Promise<T>): Promise<T>;
    inFlight(): boolean;
}

export function createSpawnGate<T>(): SpawnGate<T> {
    let current: Promise<T> | null = null;

    const start = (fn: () => Promise<T>): Promise<T> => {
        let run: Promise<T>;
        try {
            run = fn();
        } catch (error) {
            run = Promise.reject(error);
        }
        current = run;
        const clear = () => {
            if (current === run) {
                current = null;
            }
        };
        run.then(clear, clear);
        return run;
    };

    return {
        join(fn: () => Promise<T>): Promise<T> {
            if (current) {
                return current;
            }
            return start(fn);
        },
        async replace(fn: () => Promise<T>): Promise<T> {
            while (current) {
                try {
                    await current;
                } catch {
                    // The in-flight run's failure is reported to its own
                    // caller; replace only needs it to be finished.
                }
            }
            return start(fn);
        },
        inFlight(): boolean {
            return current !== null;
        },
    };
}
