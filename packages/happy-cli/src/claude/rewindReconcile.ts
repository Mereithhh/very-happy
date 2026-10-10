/**
 * B-544: the agent's conversation must equal the server log's VISIBLE user
 * messages. A `conversation-rewind` RPC ack is only a fast path — when it is
 * lost the wrapper has already switched Claude to the rewound copy while the
 * web never wrote its `transcript-drop` tombstone (nor sent the edited text).
 *
 * So a rewind is provisional until the durable log confirms it:
 *
 *   - the wrapper records `metadata.rewind = { requestId, ..., state: 'pending' }`
 *     before it acks (metadata is versioned server state, not an RPC ack);
 *   - a tombstone carrying the same `requestId` → `confirmed`;
 *   - none by `at + REWIND_CONFIRM_MS` → switch back to the source
 *     conversation (its JSONL is never modified) → `reverted`.
 *
 * Old web (no requestId) keeps the B-528 semantics: no pending, no revert.
 *
 * Startup (wrapper restart, including sessions split by a CLI before B-544):
 * a pending record is decided the same way; with no pending record, a
 * conversation file that lacks visible prompts its source file still has is an
 * unconfirmed rewound copy → switch back to the source.
 *
 * Everything here is pure; I/O lives in rewindReconciler.ts.
 */

import { transcriptPromptText, transcriptSourceId } from './utils/claudeTranscriptRewind';

export const REWIND_CONFIRM_MS = 120_000;

export type RewindState = 'pending' | 'confirmed' | 'reverted' | 'superseded';

/** `metadata.rewind`. Every field is plain JSON; old web/CLI ignore it. */
export type RewindRecord = {
    requestId: string;
    action: 'edit' | 'delete';
    /** The conversation the agent had BEFORE this rewind (revert target). */
    sourceClaudeSessionId: string;
    /** The rewound conversation (null = nothing remained → fresh conversation). */
    claudeSessionId: string | null;
    at: number;
    state: RewindState | string;
};

export function parseRewindRecord(raw: unknown): RewindRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.requestId !== 'string' || !r.requestId) return null;
    if (r.action !== 'edit' && r.action !== 'delete') return null;
    if (typeof r.sourceClaudeSessionId !== 'string' || !r.sourceClaudeSessionId) return null;
    if (r.claudeSessionId !== null && typeof r.claudeSessionId !== 'string') return null;
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
    if (typeof r.state !== 'string') return null;
    return {
        requestId: r.requestId,
        action: r.action,
        sourceClaudeSessionId: r.sourceClaudeSessionId,
        claudeSessionId: r.claudeSessionId as string | null,
        at: r.at,
        state: r.state,
    };
}

/**
 * The conversation a restarted wrapper is about to resume: before the first
 * spawn `Session.sessionId` is still null and the id only lives in the
 * `--resume <id>` arg (consumed after that spawn). Same rule as claudeRemote.
 */
export function pendingResumeId(claudeArgs: readonly string[] | undefined): string | null {
    if (!claudeArgs) return null;
    const index = claudeArgs.indexOf('--resume');
    const next = index >= 0 ? claudeArgs[index + 1] : undefined;
    return next && !next.startsWith('-') && next.includes('-') ? next : null;
}

export type RewindDecision =
    | { kind: 'none' }
    | { kind: 'confirm' }
    | { kind: 'wait'; ms: number }
    /** Switch the agent back to `to`. */
    | { kind: 'revert'; to: string }
    /** Unconfirmed, but the agent already moved on to another conversation: just close the record. */
    | { kind: 'supersede' };

/**
 * Confirm / revert / wait for one rewind record.
 * `currentClaudeSessionId` is the conversation the agent is on now.
 */
export function decideRewind(
    record: RewindRecord | null,
    confirmedRequestIds: ReadonlySet<string>,
    now: number,
    currentClaudeSessionId: string | null,
): RewindDecision {
    if (!record || record.state !== 'pending') return { kind: 'none' };
    if (confirmedRequestIds.has(record.requestId)) return { kind: 'confirm' };
    const deadline = record.at + REWIND_CONFIRM_MS;
    if (now < deadline) return { kind: 'wait', ms: deadline - now };
    if (currentClaudeSessionId !== record.claudeSessionId) return { kind: 'supersede' };
    return { kind: 'revert', to: record.sourceClaudeSessionId };
}

/**
 * A new rewind while an earlier one is still pending: the earlier copy was
 * never confirmed, so reverting the new one must go back to the last
 * CONFIRMED conversation, not to the unconfirmed copy.
 */
export function chainRewindRecord(next: RewindRecord, pending: RewindRecord | null): RewindRecord {
    if (!pending || pending.state !== 'pending') return next;
    return { ...next, sourceClaudeSessionId: pending.sourceClaudeSessionId };
}

// ---------------------------------------------------------------------------
// Server log (decrypted session records)
// ---------------------------------------------------------------------------

export type LogRecord = { seq: number; localId: string | null; body: unknown };

type TranscriptDrop = { seq: number; fromSeq: number; toSeq?: number; requestId?: string };

/** The `transcript-drop` tombstone inside a raw session record, if it is one. */
export function transcriptDropOf(body: unknown): Omit<TranscriptDrop, 'seq'> | null {
    const b = body as any;
    if (b?.role !== 'session' || b.content?.type !== 'session') return null;
    const ev = b.content.data?.ev;
    if (ev?.t !== 'transcript-drop' || typeof ev.fromSeq !== 'number') return null;
    return {
        fromSeq: ev.fromSeq,
        ...(typeof ev.toSeq === 'number' ? { toSeq: ev.toSeq } : {}),
        ...(typeof ev.requestId === 'string' && ev.requestId ? { requestId: ev.requestId } : {}),
    };
}

export function tombstoneRequestIds(records: readonly LogRecord[]): Set<string> {
    const ids = new Set<string>();
    for (const record of records) {
        const drop = transcriptDropOf(record.body);
        if (drop?.requestId) ids.add(drop.requestId);
    }
    return ids;
}

/**
 * localIds of the user prompts the web still SHOWS: every user-role record
 * not inside a tombstone range [fromSeq, toSeq ?? tombstone seq). A window of
 * the newest records is enough for the records inside it — a tombstone never
 * hides anything after its own seq.
 */
export function visibleUserLocalIds(records: readonly LogRecord[]): string[] {
    const drops: TranscriptDrop[] = [];
    for (const record of records) {
        const drop = transcriptDropOf(record.body);
        if (drop) drops.push({ seq: record.seq, ...drop });
    }
    const hidden = (seq: number) => drops.some((drop) => seq >= drop.fromSeq && seq < (drop.toSeq ?? drop.seq));
    return records
        .filter((record) => (record.body as any)?.role === 'user' && typeof record.localId === 'string' && record.localId)
        .filter((record) => !hidden(record.seq))
        .map((record) => record.localId as string);
}

// ---------------------------------------------------------------------------
// Claude transcript lineage
// ---------------------------------------------------------------------------

export type TranscriptLineage = {
    /** `uuid`s of the top-level user prompts in this file. */
    promptUuids: Set<string>;
    /**
     * The file this one was copied from: rewound copies keep every copied
     * row's `sessionId`, so the newest row naming another id is the source.
     */
    sourceClaudeSessionId: string | null;
};

export function transcriptLineage(lines: readonly string[], claudeSessionId: string): TranscriptLineage {
    const promptUuids = new Set<string>();
    for (const line of lines) {
        if (!line) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (typeof parsed?.uuid === 'string' && transcriptPromptText(parsed) !== null) promptUuids.add(parsed.uuid);
    }
    return { promptUuids, sourceClaudeSessionId: transcriptSourceId(lines, claudeSessionId) };
}

export type LineageRepair =
    | { kind: 'none' }
    | { kind: 'revert'; to: string; missing: string[]; onlyInCurrent: string[] };

/**
 * Legacy split (no pending record): a visible prompt whose uuid is in the
 * source file but not in the current one means the current file is a rewound
 * copy the web never confirmed. Only prompts that carry a uuid (B-528+, uuid =
 * web localId) count; the rest cannot be told apart and are ignored.
 * `onlyInCurrent` = visible prompts the agent got after the split; reverting
 * forgets them (reported, not a veto: the visible log is the source of truth
 * and it still shows the missing turns before them).
 */
export function decideLineageRepair(input: {
    visibleLocalIds: readonly string[];
    current: TranscriptLineage;
    source: { claudeSessionId: string; promptUuids: ReadonlySet<string> } | null;
}): LineageRepair {
    if (!input.source) return { kind: 'none' };
    const missing = input.visibleLocalIds.filter((id) => !input.current.promptUuids.has(id) && input.source!.promptUuids.has(id));
    if (missing.length === 0) return { kind: 'none' };
    const onlyInCurrent = input.visibleLocalIds.filter((id) => input.current.promptUuids.has(id) && !input.source!.promptUuids.has(id));
    return { kind: 'revert', to: input.source.claudeSessionId, missing, onlyInCurrent };
}
