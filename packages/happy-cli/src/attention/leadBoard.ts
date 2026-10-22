import { createHash, randomUUID } from 'node:crypto';
import {
    ATTENTION_LIMITS, isAttentionBoardLocalId, ownerBoardPostToRest,
    type AttentionAnchor, type AttentionItem, type OwnerBoardListInput, type OwnerBoardListOutput, type OwnerBoardPostInput,
    type OwnerBoardPostOutput, type OwnerBoardResolveInput, type OwnerBoardResolveOutput, type OwnerBoardUpdateInput, type OwnerBoardUpdateOutput,
} from '@slopus/happy-wire';
import { readTeamScope, teamScopePath } from '@/teams/context';
import { teamRequest } from '@/teams/client';
import { AttentionUnsupportedError, type AttentionClient } from './client';
import { inferOwnerDecision } from './inferDecision';

/**
 * B-766 C-1: the wrapper side of the owner briefing board
 * (`specs/2026-10-owner-briefing.md`, DESIGN §4.3–§5.2).
 *
 * One per session process. It decides whether this session is a team lead on
 * a server with the board, runs the `owner_board_*` tools and the
 * `request_human` item path, and keeps the fallbacks that need no model help:
 *
 *  - every owner message in the lead session becomes a `question` item (D2);
 *  - the lead's first text reply in the turn that handles it is attached as
 *    `firstReply` and the question settles as answered (auto-first-reply),
 *    unless the lead already moved it (in_progress / answered / closed);
 *  - a turn that asks the owner to decide in prose without a board tool call
 *    drafts an `inferred` decision (D5, `ownerBoardAutoDetect`);
 *  - every turn's prompt gets a ≤2-line digest of the open items.
 *
 * Every failure degrades to the pre-board behaviour; a turn is never blocked
 * longer than the digest timeout.
 */

export const OWNER_BOARD_DIGEST_TIMEOUT_MS = 1_500;
const QUESTION_TITLE_CHARS = 60;
const DIGEST_TITLE_CHARS = 40;
const DIGEST_MAX_CHARS = 480;
/** Re-check team membership at most this often while not a lead (a session adopted into a team mid-run). */
const LEAD_RECHECK_MS = 60_000;

/** `meta.sentFrom` of a person typing in a Very Happy client. Automated senders use their own tags. */
const OWNER_SENT_FROM = ['web', 'mobile', 'ios', 'android'] as const;
/** localId prefixes automated senders stamp (mirror of the server's owner-replied rule). */
const AUTOMATED_LOCAL_ID_PREFIXES = ['automation-', 'teams-', 'remote-send-', 'session-message-', 'edit-conflict-'] as const;

/** True when a routed user message is the owner speaking (not a board button, teammate, automation or peer). */
export function isOwnerMessage(input: { localId?: string | null; sentFrom?: string | null }): boolean {
    const localId = input.localId ?? '';
    if (isAttentionBoardLocalId(localId)) return false;
    if (AUTOMATED_LOCAL_ID_PREFIXES.some(prefix => localId.startsWith(prefix))) return false;
    return typeof input.sentFrom === 'string' && (OWNER_SENT_FROM as readonly string[]).includes(input.sentFrom);
}

function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Board title for an owner message: its first non-empty line, ≤60 chars. Null for empty text and slash commands. */
export function ownerQuestionTitle(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('/')) return null;
    const first = trimmed.split('\n').find(line => line.trim()) ?? '';
    return clip(first, QUESTION_TITLE_CHARS) || null;
}

function minutesAgo(ms: number, now: number): string {
    const m = Math.max(0, Math.round((now - ms) / 60_000));
    return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/**
 * The per-turn digest: one line of open items (title + key, else id), one line
 * of how to act on them. Null when nothing is open.
 */
export function formatBoardDigest(items: readonly Pick<AttentionItem, 'id' | 'kind' | 'title' | 'key' | 'createdAt' | 'source'>[], now: number, opts: { tools: boolean }): string | null {
    if (items.length === 0) return null;
    const parts: string[] = [];
    let used = 0;
    let shown = 0;
    for (const item of items) {
        // `req:` keys are server-made from a request id: the id is the useful handle.
        const handle = item.key && !item.key.startsWith('req:') ? `key=${item.key}` : `id=${item.id}`;
        const part = `${item.source === 'owner' ? 'owner ' : ''}${item.kind} 「${clip(item.title, DIGEST_TITLE_CHARS)}」 ${handle} ${minutesAgo(item.createdAt, now)}`;
        if (shown > 0 && used + part.length > DIGEST_MAX_CHARS) break;
        parts.push(part);
        used += part.length + 2;
        shown++;
    }
    const more = items.length - shown;
    const line1 = `[Briefing board] ${items.length} open: ${parts.join('; ')}${more > 0 ? `; +${more} more` : ''}`;
    const line2 = opts.tools
        ? '[Briefing board] Answer owner items in this turn or settle them with owner_board_update / owner_board_resolve (owner_board_list shows ids); do not repeat open decisions in chat.'
        : null;
    return line2 ? `${line1}\n${line2}` : line1;
}

/** `since` of `owner_board_list`: ISO-8601 or epoch ms. */
export function parseSince(since: string | undefined): number | undefined {
    if (since === undefined) return undefined;
    if (/^\d+$/.test(since)) return Number(since);
    const parsed = Date.parse(since);
    if (Number.isNaN(parsed)) throw new Error('since must be ISO-8601 or epoch milliseconds');
    return parsed;
}

/** This session is the root bot (team lead) of its team. Any failure means "not a lead". */
export async function resolveTeamLead(sessionId: string): Promise<boolean> {
    try {
        const scope = await readTeamScope(teamScopePath(sessionId));
        if (!scope) return false;
        const inspected = await teamRequest(`/v1/teams/${encodeURIComponent(scope.teamId)}/agent`, 'GET', scope.scopeToken, true);
        const bots: Array<{ id?: unknown; root?: unknown }> = Array.isArray(inspected?.team?.bots) ? inspected.team.bots : [];
        return bots.some(bot => bot.id === scope.botId && bot.root === true);
    } catch {
        return false;
    }
}

export type LeadBoardDeps = {
    sessionId: () => string;
    client: AttentionClient;
    isLead: () => Promise<boolean>;
    /** D5 switch (machine settings `ownerBoardAutoDetect`, default on). */
    autoDetect: () => Promise<boolean>;
    /** Called once when the server serves the board: advertise `owner-board-v1`. */
    onSupported?: () => void;
    log?: (message: string) => void;
    now?: () => number;
};

type PendingQuestion = { localId: string; itemId: Promise<string | null> };
type Turn = { promptLocalId: string | null; questions: PendingQuestion[]; texts: string[]; boardTools: Set<string> };

export function createLeadBoard(deps: LeadBoardDeps) {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? (() => {});
    let supported = false;
    let lead = false;
    let leadCheckedAt = 0;
    let toolsFrozen: boolean | null = null;
    let initPromise: Promise<void> | null = null;
    let initDone = false;
    let lastLocalId: string | null = null;
    let pending: PendingQuestion[] = [];
    let turn: Turn | null = null;
    // Turn-end follow-ups run in order and never overlap (tests await `idle()`).
    let work: Promise<void> = Promise.resolve();

    const queue = (task: () => Promise<void>) => {
        work = work.then(task).catch(error => log(`[ownerBoard] ${error instanceof Error ? error.message : String(error)}`));
        return work;
    };

    async function refreshLead(): Promise<boolean> {
        if (lead || now() - leadCheckedAt < LEAD_RECHECK_MS) return lead;
        leadCheckedAt = now();
        lead = await deps.isLead().catch(() => false);
        return lead;
    }

    function init(): Promise<void> {
        return initPromise ??= (async () => {
            try {
                supported = await deps.client.probe(deps.sessionId());
            } catch (error) {
                log(`[ownerBoard] probe failed: ${error instanceof Error ? error.message : String(error)}`);
                supported = false;
            }
            if (supported) {
                deps.onSupported?.();
                await refreshLead();
            }
            initDone = true;
        })();
    }

    /** Lead fallbacks run only while the server still serves the board to a lead session. */
    async function active(): Promise<boolean> {
        await init();
        return supported && !deps.client.isDisabled() && await refreshLead();
    }

    function thisTurnAnchor(): AttentionAnchor | undefined {
        const localId = turn?.promptLocalId ?? lastLocalId;
        if (!localId) return undefined;
        const text = turn?.texts.at(-1);
        return { localId, ...(text ? { snippet: clip(text, ATTENTION_LIMITS.snippetChars) } : {}) };
    }

    const noteBoardTool = (name: string) => { turn?.boardTools.add(name); };

    async function settleQuestions(questions: PendingQuestion[], reply: string) {
        for (const question of questions) {
            const id = await question.itemId;
            if (!id) continue;
            const anchor: AttentionAnchor = { localId: question.localId, snippet: clip(reply, ATTENTION_LIMITS.snippetChars) };
            const { item } = await deps.client.patch(id, { firstReply: anchor, requestId: `first-reply-${question.localId}`.slice(0, 128) });
            // The lead already moved it (in_progress, answered by a post, closed): keep that.
            if (item.state === 'open') {
                await deps.client.resolve(id, { outcome: 'answered', by: 'auto-first-reply', requestId: `auto-answered-${question.localId}`.slice(0, 128) });
            }
        }
    }

    async function draftDecision(text: string, anchor: AttentionAnchor | undefined) {
        if (!(await deps.autoDetect().catch(() => true))) return;
        const draft = inferOwnerDecision(text);
        if (!draft) return;
        await deps.client.post({
            sessionId: deps.sessionId(), source: 'lead', kind: 'decision', inferred: true,
            title: draft.title, bodyMd: draft.bodyMd, options: draft.options, key: draft.key,
            ...(anchor ? { anchor } : {}), requestId: randomUUID(),
        });
    }

    return {
        init,
        /** Waits (bounded) for the first probe so the first `tools/list` sees the final tool set. */
        async ready(timeoutMs: number): Promise<void> {
            await Promise.race([init(), new Promise<void>(resolve => setTimeout(resolve, timeoutMs).unref?.())]);
        },
        /** Server serves the board (any session: request_human items, `owner-board-v1`). */
        supported: () => supported && !deps.client.isDisabled(),
        /**
         * `owner_board_*` exposure, decided once per process: the tool list must
         * not change under a running agent. A session adopted into a team later
         * gets the tools on its next relaunch; the fallbacks start at once.
         */
        toolsExposed(): boolean {
            if (toolsFrozen === null && initDone) toolsFrozen = supported && lead;
            return toolsFrozen ?? false;
        },

        // ─── tools ──────────────────────────────────────────────────────────
        async post(input: OwnerBoardPostInput): Promise<OwnerBoardPostOutput> {
            noteBoardTool('owner_board_post');
            const anchor = input.anchor === undefined || input.anchor === 'this_turn' ? thisTurnAnchor() : { localId: input.anchor.localId };
            const { item, created } = await deps.client.post(ownerBoardPostToRest(deps.sessionId(), input, anchor));
            return { id: item.id, created };
        },
        async update(input: OwnerBoardUpdateInput): Promise<OwnerBoardUpdateOutput> {
            noteBoardTool('owner_board_update');
            return deps.client.patch(input.id, {
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.body_md !== undefined ? { bodyMd: input.body_md } : {}),
                ...(input.append_md !== undefined ? { appendMd: input.append_md } : {}),
                ...(input.options !== undefined ? { options: input.options } : {}),
                ...(input.links !== undefined ? { links: input.links } : {}),
                ...(input.state !== undefined ? { state: input.state } : {}),
                requestId: input.request_id,
            });
        },
        async resolve(input: OwnerBoardResolveInput): Promise<OwnerBoardResolveOutput> {
            noteBoardTool('owner_board_resolve');
            return deps.client.resolve(input.id, { outcome: input.outcome, ...(input.note !== undefined ? { note: input.note } : {}), by: 'lead', requestId: input.request_id });
        },
        async list(input: OwnerBoardListInput): Promise<OwnerBoardListOutput> {
            const since = parseSince(input.since);
            return deps.client.list({ sessionId: deps.sessionId(), state: input.state === 'all' ? 'all' : 'open', limit: 50, ...(since !== undefined ? { since } : {}) });
        },

        /**
         * `request_human` as a `blocked` item (server dedupes by key and pushes
         * once). False when this server has no board: the caller keeps the old
         * metadata + push path.
         */
        async postBlocked(reason: string, panel?: string): Promise<boolean> {
            noteBoardTool('request_human');
            await init();
            if (!supported || deps.client.isDisabled()) return false;
            try {
                await deps.client.post({
                    sessionId: deps.sessionId(), source: 'agent', kind: 'blocked',
                    title: clip(reason, ATTENTION_LIMITS.titleChars),
                    ...(reason.length > ATTENTION_LIMITS.titleChars ? { bodyMd: reason } : {}),
                    key: `request-human-${createHash('sha256').update(reason).digest('hex').slice(0, 16)}`,
                    ...(panel ? { links: [{ type: 'panel' as const, ref: panel }] } : {}),
                    ...(thisTurnAnchor() ? { anchor: thisTurnAnchor() } : {}),
                    requestId: randomUUID(),
                });
                return true;
            } catch (error) {
                if (!(error instanceof AttentionUnsupportedError)) log(`[ownerBoard] request_human item failed: ${error instanceof Error ? error.message : String(error)}`);
                return false;
            }
        },

        // ─── message taps ───────────────────────────────────────────────────
        /** Every routed user message (any runner). Owner messages in a lead session become `question` items. */
        onUserMessage(message: { localId?: string | null; text?: string | null; sentFrom?: string | null; delivery?: string | null }): void {
            if (message.localId) lastLocalId = message.localId;
            if (!message.localId || !isOwnerMessage(message)) return;
            const title = ownerQuestionTitle(message.text ?? '');
            if (!title) return;
            const localId = message.localId;
            const itemId = (async () => {
                if (!(await active())) return null;
                const { item } = await deps.client.post({
                    sessionId: deps.sessionId(), source: 'owner', kind: 'question', title,
                    anchor: { localId, snippet: clip(message.text ?? '', ATTENTION_LIMITS.snippetChars) },
                    // No key: the server keys it by request id, so a replay after a restart is a no-op.
                    requestId: `owner-q-${localId}`.slice(0, 128),
                });
                return item.id;
            })().catch(error => {
                log(`[ownerBoard] owner question not posted: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            });
            const question = { localId, itemId };
            // A steer joins the running turn; anything else waits for the next one.
            if (message.delivery === 'steer' && turn) turn.questions.push(question);
            else pending.push(question);
        },
        /**
         * The agent takes queued input (Claude remote launcher, right before the
         * prompt goes to the SDK). `sourceIds` = the batch's message localIds when
         * known: only those questions belong to this turn. When none match (an
         * id scheme we do not recognise) every waiting question does.
         */
        onTurnStart(sourceIds?: readonly string[]): void {
            const ids = new Set(sourceIds ?? []);
            const mine = pending.filter(q => ids.has(q.localId));
            const questions = ids.size && mine.length ? mine : pending;
            pending = pending.filter(q => !questions.includes(q));
            turn = { promptLocalId: sourceIds?.at(-1) ?? lastLocalId, questions, texts: [], boardTools: new Set() };
        },
        onAssistantText(text: string): void {
            if (!turn || !text.trim() || turn.texts.at(-1) === text) return;
            turn.texts.push(text);
        },
        onTurnEnd(): Promise<void> {
            const ended = turn;
            turn = null;
            if (!ended) return work;
            const anchor = ended.promptLocalId ? { localId: ended.promptLocalId } : undefined;
            return queue(async () => {
                const reply = ended.texts.join('\n\n').trim();
                if (!reply || !(await active())) return;
                if (ended.questions.length) await settleQuestions(ended.questions, ended.texts[0]);
                if (!ended.boardTools.has('owner_board_post') && !ended.boardTools.has('request_human')) {
                    await draftDecision(reply, anchor ? { ...anchor, snippet: clip(ended.texts.at(-1) ?? reply, ATTENTION_LIMITS.snippetChars) } : undefined);
                }
            });
        },
        /** Prefix the turn's prompt with the open-items digest (lead sessions only; unchanged on any failure). */
        async decorate<T>(message: T): Promise<T> {
            if (typeof message !== 'string') return message;
            try {
                const result = await Promise.race([
                    (async () => {
                        if (!(await active())) return null;
                        const fresh = new Set(turn?.questions.map(q => q.localId) ?? []);
                        const { items } = await deps.client.list({ sessionId: deps.sessionId(), state: 'open', limit: 20 }, OWNER_BOARD_DIGEST_TIMEOUT_MS);
                        // The question this very message just created is not news to the lead.
                        return formatBoardDigest(items.filter(item => !(item.anchor?.localId && fresh.has(item.anchor.localId) && item.source === 'owner')), now(), { tools: toolsFrozen === true });
                    })(),
                    new Promise<null>(resolve => setTimeout(() => resolve(null), OWNER_BOARD_DIGEST_TIMEOUT_MS).unref?.()),
                ]);
                return (result ? `${result}\n${message}` : message) as T;
            } catch (error) {
                log(`[ownerBoard] digest skipped: ${error instanceof Error ? error.message : String(error)}`);
                return message;
            }
        },
        /** Settles once queued turn-end follow-ups are done (tests, shutdown). */
        idle: () => work,
    };
}
export type LeadBoard = ReturnType<typeof createLeadBoard>;

// Session processes host one ApiSessionClient; launchers reach the board through it.
const boards = new WeakMap<object, LeadBoard>();
export function attachLeadBoard(client: object, board: LeadBoard): void { boards.set(client, board); }
export function leadBoardFor(client: object): LeadBoard | undefined { return boards.get(client); }
