/**
 * B-961: `conversation-rewind` on a Codex session — edit, delete or retry one
 * of the user's prompts IN PLACE, the Codex twin of claude/conversationRewind.ts.
 *
 * Codex app-server (`thread/revert {threadId, beforeTurnId}`, 0.171) replaces
 * the thread's persisted history with the prefix before that turn; the loaded
 * thread forgets it at once (verified: no resume needed). It does NOT revert
 * file changes. The web hides the dropped range with the same `transcript-drop`
 * tombstone as Claude, and an edit / retry sends the text as the next prompt.
 *
 * A prompt maps to the turn it started:
 *   1. `sourceId` (the web message's localId) → the turn `turn/start` returned
 *      for the batch that carried it (recorded live by the wrapper);
 *   2. `codexItemId` (prompts mirrored from Codex) → the turn whose FIRST item it is;
 *   3. otherwise (wrapper restarted, or a prompt steered into a running turn)
 *      the turn whose first user message carries `text`; more than one match
 *      is refused rather than guessed, a steered prompt is refused.
 * A prompt that is not the first item of its turn (steered into a running
 * turn, or batched behind another) cannot be cut alone and is refused.
 *
 * `thread/revert` drops the chosen turn AND every later one, so a delete in
 * the middle forgets the turns after it too (verified e2e). The ack says so
 * (`dropsLater: true`) and the web hides from this prompt to the end — never a
 * screen that shows turns the agent no longer has.
 *
 * Unlike Claude (B-544) the rewind cannot be switched back, so there is no
 * pending window: the wrapper records `metadata.rewind` (same requestId,
 * state `applied`) before it acks, so a web whose ack was lost still confirms
 * through that record.
 */

import type { ThreadItem, ThreadTurn } from './codexAppServerTypes';
import { attachmentGoneMessage, parseRewindAttachments, type RewindAttachmentRef, type RewindAttachmentResult } from '@/utils/attachmentReuse';

export type CodexRewindAction = 'edit' | 'delete';

export type CodexRewindResult =
    | { ok: true; action: CodexRewindAction; freshConversation: boolean; dropsLater: true }
    | { ok: false; code: 'invalid' | 'busy' | 'running' | 'no-conversation' | 'not-found' | 'ambiguous' | 'unsafe' | 'codex-outdated' | 'attachment-gone'; error: string; missing?: string[] };

/** What the wrapper remembers about a turn it started: the prompts (sourceIds) it carried, in order. */
export type CodexTurnSources = { turnId: string; sourceIds: string[] };

export type CodexRewindRecord = {
    requestId: string;
    action: CodexRewindAction;
    /** Plain-string fields shared with the Claude record (B-544); both hold the Codex thread id. */
    sourceClaudeSessionId: string;
    claudeSessionId: string;
    at: number;
    state: 'applied';
    /** B-961: which prompt — a web that missed the ack hides from it on (its own reconcile). */
    sourceId?: string;
    codexItemId?: string;
};

export type CodexRewindDeps = {
    threadId: () => string | null;
    /** A turn runs, or an active /goal is about to start one. */
    isBusy: () => boolean;
    /** The Stop button's path (pauses an active goal first, B-953). */
    stopTurn: () => Promise<void>;
    /** Resolves true once nothing runs, false after `ms`. */
    waitIdle: (ms: number) => Promise<boolean>;
    /** The live turn a web prompt started, if this wrapper process started it. */
    turnOfSource: (sourceId: string) => CodexTurnSources | null;
    /** The thread's turns (thread/read); only asked when the live map does not know the prompt. */
    readTurns: () => Promise<ThreadTurn[]>;
    revert: (beforeTurnId: string) => Promise<void>;
    /** Forget the live map from `turnId` on (those turns no longer exist). */
    dropTurnsFrom: (turnId: string) => void;
    /** Persist `metadata.rewind`; awaited before the ack. */
    record: (record: CodexRewindRecord) => Promise<void>;
    /** Holds the next prompt until the returned release runs. */
    holdPrompts: () => () => void;
    /** B-961b: resolve the files an edit / retry re-sends before anything is rewound. */
    ensureAttachments?: (refs: readonly RewindAttachmentRef[]) => Promise<RewindAttachmentResult>;
    now?: () => number;
};

const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const STOP_WAIT_MS = 8000;
/** app-server answers this way when it has no such method (Codex older than thread/revert). */
const OUTDATED = /method not found|unknown method|unknown variant|-32601/i;

export class CodexRewindError extends Error {
    constructor(public readonly code: Exclude<CodexRewindResult, { ok: true }>['code'], message: string) {
        super(message);
        this.name = 'CodexRewindError';
    }
}

function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function userText(item: ThreadItem | undefined): string | null {
    if (!item || item.type !== 'userMessage') return null;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const text = content
        .filter((part): part is { type: 'text'; text: string } => !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    return text.trim() ? text : null;
}

/**
 * The turn to revert before, from the thread itself. Pure.
 * `codexItemId` must be a turn's first item; else `text` must identify exactly
 * one turn's opening prompt (an exact match wins over a containing one — the
 * wrapper adds the project header / title instruction around the user text).
 */
export function findCodexRewindTurn(turns: readonly ThreadTurn[], target: { codexItemId?: string; text?: string }): string {
    if (target.codexItemId) {
        const index = turns.findIndex((turn) => (turn.items ?? []).some((item) => item.id === target.codexItemId));
        if (index < 0) throw new CodexRewindError('not-found', 'This message is no longer in the Codex conversation');
        if (turns[index].items?.[0]?.id !== target.codexItemId) {
            throw new CodexRewindError('unsafe', 'This message was sent into a running turn and cannot be changed on its own');
        }
        return turns[index].id;
    }
    const wanted = normalize(target.text ?? '');
    if (!wanted) throw new CodexRewindError('invalid', 'Invalid rewind request');
    const openings = turns.flatMap((turn) => {
        const text = userText(turn.items?.[0]);
        return text ? [{ turnId: turn.id, text: normalize(text) }] : [];
    });
    const exact = openings.filter((opening) => opening.text === wanted);
    const matches = exact.length > 0 ? exact : openings.filter((opening) => opening.text.includes(wanted));
    if (matches.length === 0) {
        // Steered into a running turn: inside a turn, never its opening — cutting there would drop the turn's own prompt.
        const inside = turns.some((turn) => (turn.items ?? []).slice(1).some((item) => normalize(userText(item) ?? '') === wanted));
        if (inside) throw new CodexRewindError('unsafe', 'This message was sent into a running turn and cannot be changed on its own');
        throw new CodexRewindError('not-found', 'This message is no longer in the Codex conversation');
    }
    if (matches.length > 1) throw new CodexRewindError('ambiguous', 'The same message was sent more than once; it cannot be told apart after the session restarted');
    return matches[0].turnId;
}

/** The live map's answer for a prompt, or null to fall back on the thread. Pure. */
export function liveRewindTurn(entry: CodexTurnSources | null, sourceId: string): string | null {
    if (!entry) return null;
    // A prompt batched behind another or steered into the turn: cutting there would also drop
    // the earlier prompt of the same turn, which the web keeps showing.
    if (entry.sourceIds[0] !== sourceId) {
        throw new CodexRewindError('unsafe', 'This message was sent into a running turn and cannot be changed on its own');
    }
    return entry.turnId;
}

export function createCodexConversationRewind(deps: CodexRewindDeps) {
    let inFlight = false;
    return async (input: unknown): Promise<CodexRewindResult> => {
        const request = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
        const action = request.action;
        const sourceId = typeof request.sourceId === 'string' && request.sourceId.length > 0 && request.sourceId.length <= 200 ? request.sourceId : undefined;
        const codexItemId = typeof request.codexItemId === 'string' && request.codexItemId.length > 0 && request.codexItemId.length <= 200 ? request.codexItemId : undefined;
        const text = typeof request.text === 'string' && request.text.length <= 200_000 ? request.text : undefined;
        const requestId = typeof request.requestId === 'string' && REQUEST_ID.test(request.requestId) ? request.requestId : undefined;
        if ((action !== 'edit' && action !== 'delete') || (!sourceId && !codexItemId && !text?.trim())) {
            return { ok: false, code: 'invalid', error: 'Invalid rewind request' };
        }
        if (inFlight) return { ok: false, code: 'busy', error: 'Another edit is still being applied' };
        const attachments = parseRewindAttachments(request.attachments);
        inFlight = true;
        const release = deps.holdPrompts();
        try {
            // B-961b: thread/revert cannot be switched back, so a file that
            // cannot be resolved must refuse here, before anything is dropped.
            if (attachments.length > 0 && deps.ensureAttachments) {
                const resolved = await deps.ensureAttachments(attachments);
                if (!resolved.ok) {
                    return { ok: false, code: 'attachment-gone', error: attachmentGoneMessage(resolved.missing), missing: resolved.missing };
                }
            }
            if (deps.isBusy()) {
                await deps.stopTurn();
                if (!await deps.waitIdle(STOP_WAIT_MS)) {
                    return { ok: false, code: 'running', error: 'The agent did not stop; try again after it finishes' };
                }
            }
            const threadId = deps.threadId();
            if (!threadId) return { ok: false, code: 'no-conversation', error: 'The agent has no conversation to change yet' };
            const live = sourceId ? liveRewindTurn(deps.turnOfSource(sourceId), sourceId) : null;
            const turnId = live ?? findCodexRewindTurn(await deps.readTurns(), { codexItemId, text });
            try {
                await deps.revert(turnId);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (OUTDATED.test(message)) {
                    return { ok: false, code: 'codex-outdated', error: 'This Codex version cannot rewind a conversation; update Codex and restart the session' };
                }
                if (/turn not found/i.test(message)) {
                    return { ok: false, code: 'not-found', error: 'This message is no longer in the Codex conversation' };
                }
                throw error;
            }
            deps.dropTurnsFrom(turnId);
            if (requestId) {
                await deps.record({
                    requestId, action, sourceClaudeSessionId: threadId, claudeSessionId: threadId, at: (deps.now ?? Date.now)(), state: 'applied',
                    ...(sourceId ? { sourceId } : {}), ...(codexItemId ? { codexItemId } : {}),
                });
            }
            return { ok: true, action, freshConversation: false, dropsLater: true };
        } catch (error) {
            if (error instanceof CodexRewindError) return { ok: false, code: error.code, error: error.message };
            throw error;
        } finally {
            release();
            inFlight = false;
        }
    };
}

/**
 * Write `metadata.rewind` and wait (bounded) until the session holds it — the
 * web's lost-ack fallback reads it. A newer rewind always replaces an older one.
 */
export async function persistCodexRewindRecord(
    client: { getMetadata: () => { rewind?: unknown } | null; updateMetadata: (handler: (metadata: any) => any) => unknown },
    record: CodexRewindRecord,
    opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
    client.updateMetadata((metadata) => ({ ...metadata, rewind: record }));
    const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
    while (Date.now() < deadline) {
        const current = client.getMetadata()?.rewind as { requestId?: unknown } | null | undefined;
        if (current?.requestId === record.requestId) return;
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 100));
    }
}

/** Where the live map survives a wrapper restart (one small JSON file per session). */
export type CodexTurnStore = { load: () => CodexTurnSources[]; save: (turns: CodexTurnSources[]) => void };

/** Keep the newest turns only; older prompts fall back on the thread text. */
const MAX_TURNS = 500;
/** Web prompts that are not the first of their turn, newest last (metadata.codexTurnFollowers). */
const MAX_FOLLOWERS = 200;

export function fileCodexTurnStore(path: string, fs: {
    readFileSync: (p: string, e: 'utf8') => string; writeFileSync: (p: string, d: string, o?: { mode?: number }) => void;
    renameSync: (a: string, b: string) => void; mkdirSync: (p: string, o: { recursive: true }) => unknown;
}, dirname: (p: string) => string): CodexTurnStore {
    return {
        load: () => {
            try {
                const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as { v?: unknown; turns?: unknown };
                if (raw?.v !== 1 || !Array.isArray(raw.turns)) return [];
                return raw.turns.flatMap((turn: any) => typeof turn?.turnId === 'string' && Array.isArray(turn.sourceIds) && turn.sourceIds.every((id: unknown) => typeof id === 'string')
                    ? [{ turnId: turn.turnId, sourceIds: turn.sourceIds as string[] }] : []);
            } catch { return []; }
        },
        save: (turns) => {
            try {
                fs.mkdirSync(dirname(path), { recursive: true });
                const tmp = `${path}.${process.pid}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify({ v: 1, turns }), { mode: 0o600 });
                fs.renameSync(tmp, path);
            } catch { /* best effort: the thread text is the fallback */ }
        },
    };
}

/**
 * The live map: turn/start's turn id for each batch the wrapper sent, keyed by
 * the batch's prompts (B-961). Insertion order = thread order, so a revert
 * drops the reverted turn and every later one. Persisted per session so a
 * restarted wrapper still knows its turns; the prompts that are not the first
 * of their turn (batched behind another, steered in) are published so the web
 * offers no edit / delete on them.
 */
export class CodexTurnSourceMap {
    private readonly turns: CodexTurnSources[];
    private lastFollowers = '';

    constructor(private readonly store?: CodexTurnStore, private readonly publishFollowers?: (ids: string[]) => void) {
        this.turns = store?.load() ?? [];
    }

    started(turnId: string, sourceIds: readonly string[] | undefined): void {
        if (!turnId || !sourceIds?.length) return;
        this.turns.push({ turnId, sourceIds: [...sourceIds] });
        this.changed();
    }

    /** A prompt steered into the running turn joins it (never its opening prompt). */
    steered(turnId: string | null, sourceId: string | undefined): void {
        if (!turnId || !sourceId) return;
        const entry = this.turns.find((turn) => turn.turnId === turnId);
        if (entry) entry.sourceIds.push(sourceId);
        // A turn Codex opened itself (goal continuation): no web prompt opens it.
        else this.turns.push({ turnId, sourceIds: ['', sourceId] });
        this.changed();
    }

    of(sourceId: string): CodexTurnSources | null {
        return this.turns.find((turn) => turn.sourceIds.includes(sourceId)) ?? null;
    }

    followers(): string[] {
        return this.turns.flatMap((turn) => turn.sourceIds.slice(1).filter(Boolean)).slice(-MAX_FOLLOWERS);
    }

    dropFrom(turnId: string): void {
        const index = this.turns.findIndex((turn) => turn.turnId === turnId);
        if (index < 0) return;
        this.turns.splice(index);
        this.changed();
    }

    clear(): void {
        if (this.turns.length === 0) return;
        this.turns.length = 0;
        this.changed();
    }

    /** Publish the current followers (wrapper start: a restarted wrapper republishes what it loaded). */
    publish(): void {
        const followers = this.followers();
        const key = followers.join('\n');
        if (key === this.lastFollowers) return;
        this.lastFollowers = key;
        this.publishFollowers?.(followers);
    }

    private changed(): void {
        if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
        this.store?.save(this.turns);
        this.publish();
    }
}
