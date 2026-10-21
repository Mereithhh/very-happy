/**
 * Reconnect-in-place helpers (B-265). A resumed process reattaches to an
 * EXISTING happy session (HAPPY_RECONNECT_*). Two truths must not be mixed up:
 *
 *   - the server owns the conversation-level metadata (summary, tags,
 *     claudeSessionId, board, …) and the message `seq`;
 *   - the new process owns its own identity (pid, version, capabilities, …).
 *
 * Everything here is pure so the merge rules are unit-tested; the network
 * side is `api.getSession` and the wiring lives in runClaude / runCodex.
 */
import type { AgentState, Metadata, Session } from '@/api/types';
import { hibernationReplaySeq } from '@/hibernation/hibernationPolicy';

/** Metadata keys a freshly started process has authority over. Anything else
 *  comes from the server copy. */
export const PROCESS_IDENTITY_FIELDS = [
    'hostPid',
    'version',
    'startedBy',
    'startedFromDaemon',
    'happyHomeDir',
    'happyLibDir',
    'happyToolsDir',
    'capabilities',
    'attachmentKinds',
    'queueCancellation',
    'sandbox',
    'dangerouslySkipPermissions',
    'os',
    'host',
    'homeDir',
    'permissionMode',
] as const satisfies readonly (keyof Metadata)[];

/** The identity slice of a locally built metadata object. Keys the local
 *  object leaves undefined are NOT copied — writing `undefined` would delete
 *  the server's key on serialisation (codex builds fewer fields than claude). */
export function processIdentityFields(local: Metadata): Partial<Metadata> {
    const out: Partial<Metadata> = {};
    for (const key of PROCESS_IDENTITY_FIELDS) {
        const value = local[key];
        if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
    return out;
}

/** The first metadata write of a reconnected process: server truth + this
 *  process's identity + lifecycle back to running. `server` is the handler's
 *  argument (on a version mismatch the client re-runs the handler with the
 *  newest server copy); `local` is the closure's locally built metadata. */
export function mergeReconnectMetadata(server: Metadata, local: Metadata, now: number): Metadata {
    return {
        ...server,
        ...processIdentityFields(local),
        lifecycleState: 'running',
        lifecycleStateSince: now,
        archivedBy: undefined,
        archiveReason: undefined,
        // B-587: awake again — the hibernation stamp no longer describes us.
        hibernation: undefined,
        // B-679: likewise the previous wrapper's offline-exit cursor.
        exitCursor: undefined,
    };
}

export interface ServerSessionSnapshot {
    seq: number;
    metadata: Metadata;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
}

/** Seed the reconnecting `Session` with the server snapshot: message cursor,
 *  metadata + version, agent state + version. Encryption material stays. */
export function applyServerSnapshot(response: Session, snapshot: ServerSessionSnapshot): Session {
    return {
        ...response,
        seq: snapshot.seq,
        metadata: snapshot.metadata,
        metadataVersion: snapshot.metadataVersion,
        agentState: snapshot.agentState,
        agentStateVersion: snapshot.agentStateVersion,
    };
}

/** Without a server snapshot the process must NOT trust the daemon's env
 *  versions (they are the webhook-time values, possibly current): force the
 *  first metadata / agent-state write into a version mismatch so the client
 *  pulls the server copy before applying the merge. */
export function withoutServerSnapshot(response: Session): Session {
    return { ...response, metadataVersion: 0, agentStateVersion: 0 };
}

/**
 * B-587: waking a HIBERNATED session. The previous wrapper exited with an
 * empty input queue and stamped its message cursor; anything stored after it
 * (a message sent to the "offline" session from an old web, a peer notice, a
 * message that raced the hibernation) was never routed. Start the cursor at
 * the stamp so those records are routed now, and tell the caller to skip the
 * B-332 undelivered-queue scan — there was no in-memory queue to lose, and the
 * scan would tombstone the very messages being replayed.
 */
export function applyHibernationReplay(response: Session): { response: Session; replaying: boolean } {
    const replaySeq = hibernationReplaySeq(response.metadata, response.seq);
    if (replaySeq === null) return { response, replaying: false };
    return { response: { ...response, seq: replaySeq }, replaying: true };
}

export type ExitCursor = NonNullable<Metadata['exitCursor']>;

export function readExitCursor(metadata: unknown): ExitCursor | null {
    const raw = (metadata as { exitCursor?: unknown } | null | undefined)?.exitCursor;
    if (!raw || typeof raw !== 'object') return null;
    const { at, seq } = raw as { at?: unknown; seq?: unknown };
    if (typeof at !== 'number' || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
    return { at, seq, v: 1 };
}

/** The stamp an offline exit writes: the cursor of a wrapper whose inbound is
 *  frozen from here on, so nothing above `seq` was routed into it. */
export function exitCursorStamp(seq: number, now: number): ExitCursor {
    return { at: now, seq, v: 1 };
}

export type ReconnectReplay = { source: 'hibernation' | 'offline-exit'; seq: number };

/**
 * B-679: resuming a session whose previous wrapper went OFFLINE. Same rule as
 * the B-587 hibernation wake (which wins when both are present): a message
 * typed into the offline session (web composer, `sessions send`, a peer) got a
 * seq above the server cursor's previous position but was never routed — the
 * seeded cursor (= the server's latest seq) skipped it, the new wrapper sat at
 * 「Waiting for messages」 and the message was shelved for good. Start the
 * cursor at the exit stamp so those records are routed now, in seq order;
 * `routedInboundLocalIds` + the frozen-inbound exit keep it single-delivery.
 * A stamp at/after the server cursor means nothing arrived (or it is corrupt):
 * keep the server cursor.
 */
export function applyReconnectReplay(response: Session): { response: Session; replay: ReconnectReplay | null } {
    const wake = applyHibernationReplay(response);
    if (wake.replaying) return { response: wake.response, replay: { source: 'hibernation', seq: wake.response.seq } };
    const cursor = readExitCursor(response.metadata);
    if (!cursor || cursor.seq >= response.seq) return { response, replay: null };
    return { response: { ...response, seq: cursor.seq }, replay: { source: 'offline-exit', seq: cursor.seq } };
}
