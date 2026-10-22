import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
    attentionKindNeedsOwner, attentionResolveState, isAttentionActive, isAttentionBoardLocalId,
    type AttentionItem, type AttentionItemListQuery, type AttentionItemOwnerRespond, type AttentionItemPatch, type AttentionItemPost,
    type AttentionItemResolve, type TeamState,
} from '@slopus/happy-wire';
import { configuredResourceLimit } from '@/app/api/resourceLimits';
import { isOwnerAuthoredMessage, type MessageOrigin } from '@/app/automations/attentionLifecycle';
import { buildAttentionItemUpdate, buildSessionEventEphemeral, eventRouter } from '@/app/events/eventRouter';
import { dispatchSessionEventPush } from '@/app/push/pushDispatch';
import { db } from '@/storage/db';
import { afterTx, inTx, isRetryableTransactionConflict, type Tx } from '@/storage/inTx';
import { allocateUserSeq } from '@/storage/seq';
import { log } from '@/utils/log';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import {
    AttentionError, attentionEnabled, capAnswered, itemView, ownerRepliedTarget, planPost, postKey, pushPresentation, replyTargetState,
    requireAttention, rootTaskTransitions, TEAM_SUBMIT_CHOICES, TEAM_SUBMIT_KEY_PREFIX, teamSubmitItem, teamSubmitKey, type AttentionRow,
} from './rules';

/**
 * B-766 briefing-board store (`specs/2026-10-owner-briefing.md`). Every
 * mutation runs in a SERIALIZABLE `inTx` (P2034 / P2010+40001 retried there,
 * AGENTS rule 12); a racing first insert of one `(sessionId, key)` loses on
 * the unique index (P2002) and is retried here, finding the winner's row.
 * After commit each mutation emits one `attention-item` update and, for a
 * pushable item, claims `pushedAt` with a conditional UPDATE so the device
 * push goes out at most once.
 */

const DEFAULT_MAX_ACTIVE_PER_ACCOUNT = 500;
const LIST_DEFAULT = 100;
const ACTIVE_STATES = ['open', 'in_progress'];

export function assertAttentionEnabled() {
    requireAttention(attentionEnabled(), 'owner_board_disabled', 404);
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    assertAttentionEnabled();
    for (let attempt = 0; ; attempt++) {
        try { return await inTx(fn); }
        catch (error) {
            if (isUniqueViolation(error) && attempt < 3) continue;
            if (isRetryableTransactionConflict(error) || isUniqueViolation(error)) throw new AttentionError('transaction_conflict', 409);
            throw error;
        }
    }
}

const json = <T>(value: T | null | undefined): T | typeof Prisma.DbNull | undefined => value === undefined ? undefined : value === null ? Prisma.DbNull : value;

/** Emits the item to the account's user-scoped connections and, once, its push. */
function announce(tx: Tx, row: AttentionRow) {
    const item = itemView(row);
    afterTx(tx, () => { void emitItem(row.accountId, item); void pushOnce(row); });
}
async function emitItem(accountId: string, item: AttentionItem) {
    try {
        const seq = await allocateUserSeq(accountId);
        eventRouter.emitUpdate({ userId: accountId, payload: buildAttentionItemUpdate(item, seq, randomKeyNaked(12)), recipientFilter: { type: 'user-scoped-only' } });
    } catch (error) {
        log({ module: 'attention', level: 'warn', error }, 'attention-item update emit failed');
    }
}

/**
 * At most one push per item: the conditional UPDATE on `pushedAt IS NULL`
 * is the claim, so concurrent reposts / retries / server replicas race on one
 * row and only the winner dispatches. Closed items never push.
 */
export async function pushOnce(row: Pick<AttentionRow, 'id' | 'accountId' | 'sessionId' | 'kind' | 'title' | 'replyToId' | 'state' | 'inferred'>): Promise<boolean> {
    const presentation = pushPresentation(row);
    if (!presentation || !isAttentionActive(row.state)) return false;
    try {
        const claimed = await db.attentionItem.updateMany({ where: { id: row.id, pushedAt: null, inferred: false, state: { in: ACTIVE_STATES } }, data: { pushedAt: new Date() } });
        if (claimed.count !== 1) return false;
        const url = `/session/${row.sessionId}?panel=board&item=${encodeURIComponent(row.id)}`;
        eventRouter.emitEphemeral({
            userId: row.accountId,
            payload: buildSessionEventEphemeral(row.sessionId, presentation.kind, presentation.title, presentation.body, url),
            recipientFilter: { type: 'all-interested-in-session', sessionId: row.sessionId },
        });
        await dispatchSessionEventPush({ userId: row.accountId, sessionId: row.sessionId, title: presentation.title, body: presentation.body, data: { kind: presentation.kind, itemId: row.id, url } });
        return true;
    } catch (error) {
        log({ module: 'attention', level: 'warn', error }, 'attention push failed');
        return false;
    }
}

async function requireSession(tx: Tx, accountId: string, sessionId: string) {
    requireAttention(await tx.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } }), 'session_not_found', 404);
}

/** Team and project the session belongs to (live team binding first, then the project member row). */
async function sessionContext(tx: Tx, accountId: string, sessionId: string): Promise<{ teamId: string | null; projectId: string | null }> {
    const teams = await tx.$queryRaw<{ id: string; projectId: string | null }[]>`
        SELECT "id", "projectId" FROM "AgentTeam" WHERE "accountId"=${accountId} AND "state"->>'archivedAt' IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE("state"->'bots', '[]'::jsonb)) b WHERE b->>'sessionId'=${sessionId})
        ORDER BY "createdAt" DESC LIMIT 1`;
    const member = await tx.projectMember.findFirst({ where: { sessionId, accountId }, select: { projectId: true } });
    return { teamId: teams[0]?.id ?? null, projectId: teams[0]?.projectId ?? member?.projectId ?? null };
}

async function loadItem(tx: Tx, accountId: string, id: string): Promise<AttentionRow> {
    const row = await tx.attentionItem.findFirst({ where: { id, accountId } });
    requireAttention(row, 'attention_item_not_found', 404);
    return row;
}

async function enforceActiveLimit(tx: Tx, accountId: string) {
    const max = configuredResourceLimit('VH_ATTENTION_MAX_ACTIVE', DEFAULT_MAX_ACTIVE_PER_ACCOUNT);
    const active = await tx.attentionItem.count({ where: { accountId, state: { in: ACTIVE_STATES } } });
    requireAttention(active < max, 'attention_item_limit', 429, { max });
}

const reopenData = { state: 'open', resolvedBy: null, resolvedAt: null, ownerChoice: null, ownerNote: null, resolveNote: null, pushedAt: null };

/** Insert-or-repost by `(sessionId, key)` inside an open transaction (shared by the REST post and the root-task hook). */
async function upsertTx(tx: Tx, accountId: string, input: AttentionItemPost & { inferred?: boolean }, context?: { teamId: string | null; projectId: string | null }): Promise<{ row: AttentionRow; created: boolean }> {
    const key = postKey(input);
    const existing = key ? await tx.attentionItem.findUnique({ where: { sessionId_key: { sessionId: input.sessionId, key } } }) : null;
    requireAttention(!existing || existing.accountId === accountId, 'attention_item_not_found', 404);
    const plan = planPost(existing, input);
    if (plan.action === 'noop') return { row: existing!, created: false };
    const now = new Date();
    const content = {
        title: input.title,
        bodyMd: input.bodyMd ?? null,
        options: json(input.options ?? null),
        links: json(input.links ?? null),
        anchor: json(input.anchor ?? null),
        replyToId: input.replyToId ?? null,
        lastRequestId: input.requestId ?? null,
    };
    const inferred = input.inferred === true;
    let row: AttentionRow;
    if (plan.action === 'repost') {
        // D5: the lead posting a drafted key confirms it (then pushes once); a draft never downgrades a confirmed item.
        row = await tx.attentionItem.update({
            where: { id: existing!.id },
            data: { ...content, ...(plan.reopened ? reopenData : {}), ...(existing!.inferred && !inferred ? { inferred: false } : {}), repostCount: { increment: 1 }, version: { increment: 1 }, updatedAt: now },
        });
    } else {
        await enforceActiveLimit(tx, accountId);
        const ctx = context ?? await sessionContext(tx, accountId, input.sessionId);
        row = await tx.attentionItem.create({
            data: {
                ...content, id: randomUUID(), accountId, sessionId: input.sessionId, teamId: ctx.teamId, projectId: ctx.projectId,
                source: input.source, kind: input.kind, key, inferred, needsOwner: attentionKindNeedsOwner(input.kind), state: 'open', createdAt: now, updatedAt: now,
            },
        });
    }
    announce(tx, row);
    if (input.replyToId) await settleReplyTarget(tx, accountId, input.replyToId, input.kind, now);
    return { row, created: plan.action === 'create' };
}

async function settleReplyTarget(tx: Tx, accountId: string, targetId: string, kind: string, now: Date) {
    const next = replyTargetState(kind);
    if (!next) return;
    const target = await tx.attentionItem.findFirst({ where: { id: targetId, accountId } });
    if (!target || (!isAttentionActive(target.state) && target.state !== 'answered') || target.state === next.state) return;
    const row = await tx.attentionItem.update({
        where: { id: target.id },
        data: next.state === 'resolved'
            ? { state: 'resolved', resolvedBy: next.resolvedBy, resolvedAt: now, version: { increment: 1 }, updatedAt: now }
            : { state: 'answered', version: { increment: 1 }, updatedAt: now },
    });
    announce(tx, row);
}

/** POST /v1/attention-items. */
export async function postItem(accountId: string, input: AttentionItemPost): Promise<{ item: AttentionItem; created: boolean }> {
    return run(async tx => {
        await requireSession(tx, accountId, input.sessionId);
        const { row, created } = await upsertTx(tx, accountId, input);
        return { item: itemView(row), created };
    });
}

/** PATCH /v1/attention-items/:id — content edits always; state only while the item is not closed. */
export async function patchItem(accountId: string, id: string, patch: AttentionItemPatch): Promise<{ item: AttentionItem }> {
    return run(async tx => {
        const row = await loadItem(tx, accountId, id);
        if (patch.requestId && row.lastRequestId === patch.requestId) return { item: itemView(row) };
        if (patch.state) requireAttention(isAttentionActive(row.state) || row.state === 'answered', 'attention_item_closed', 409);
        if (patch.kind) requireAttention(row.kind === 'question' || row.kind === 'request', 'attention_kind_change_refused', 409, { kind: row.kind });
        const bodyMd = patch.appendMd !== undefined ? `${row.bodyMd ? `${row.bodyMd}\n\n` : ''}${patch.appendMd}` : patch.bodyMd;
        if (bodyMd) requireAttention(new TextEncoder().encode(bodyMd).length <= 8 * 1024, 'attention_body_too_large', 413);
        const updated = await tx.attentionItem.update({
            where: { id: row.id },
            data: {
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...(bodyMd !== undefined ? { bodyMd } : {}),
                ...(patch.options !== undefined ? { options: json(patch.options) } : {}),
                ...(patch.links !== undefined ? { links: json(patch.links) } : {}),
                ...(patch.kind ? { kind: patch.kind, needsOwner: attentionKindNeedsOwner(patch.kind) } : {}),
                ...(patch.state ? { state: patch.state } : {}),
                ...(patch.firstReply ? { firstReply: json(patch.firstReply) } : {}),
                ...(patch.requestId ? { lastRequestId: patch.requestId } : {}),
                version: { increment: 1 }, updatedAt: new Date(),
            },
        });
        announce(tx, updated);
        return { item: itemView(updated) };
    });
}

/** POST /v1/attention-items/:id/resolve — the lead (or CLI auto-attach) closes an item. Idempotent on an already-closed item. */
export async function resolveItem(accountId: string, id: string, input: AttentionItemResolve): Promise<{ item: AttentionItem }> {
    return run(async tx => {
        const row = await loadItem(tx, accountId, id);
        const state = attentionResolveState(input.outcome);
        if (row.state === state || (!isAttentionActive(row.state) && row.state !== 'answered')) return { item: itemView(row) };
        const now = new Date();
        const updated = await tx.attentionItem.update({
            where: { id: row.id },
            data: {
                state, resolvedBy: input.by ?? 'lead', resolvedAt: now, resolveNote: input.note ?? null,
                ...(input.requestId ? { lastRequestId: input.requestId } : {}),
                version: { increment: 1 }, updatedAt: now,
            },
        });
        announce(tx, updated);
        return { item: itemView(updated) };
    });
}

/**
 * POST /v1/attention-items/:id/owner-respond — the board buttons. A root-task
 * submit item runs the team accept / return first (its own transaction; the
 * team hook below then closes the item), so a refused team action leaves the
 * item open.
 */
export async function ownerRespond(accountId: string, id: string, input: AttentionItemOwnerRespond): Promise<{ item: AttentionItem }> {
    assertAttentionEnabled();
    if (input.action === 'choose') {
        const row = await db.attentionItem.findFirst({ where: { id, accountId } });
        requireAttention(row, 'attention_item_not_found', 404);
        if (row.source === 'team' && row.key?.startsWith(TEAM_SUBMIT_KEY_PREFIX) && row.teamId && isAttentionActive(row.state)) {
            await settleRootTask(accountId, row, input.choice, input.note);
        }
    }
    return run(async tx => {
        const row = await loadItem(tx, accountId, id);
        const now = new Date();
        let data: Prisma.AttentionItemUpdateInput;
        if (input.action === 'reopen') {
            if (isAttentionActive(row.state)) return { item: itemView(row) };
            data = { state: 'open', resolvedBy: null, resolvedAt: null, ownerChoice: null, ownerNote: input.note ?? null };
        } else if (input.action === 'choose') {
            const options = Array.isArray(row.options) ? row.options as { id: string }[] : [];
            requireAttention(options.some(o => o.id === input.choice), 'attention_unknown_choice', 400);
            // Already settled with this choice (retry, or the team hook closed it): unchanged. A different choice on a
            // closed item is refused — the lead already acted on the first one; 追问 (reopen) comes first.
            if (!isAttentionActive(row.state)) {
                requireAttention(row.ownerChoice === input.choice, row.source === 'team' ? 'attention_item_stale' : 'attention_item_closed', 409);
                return { item: itemView(row) };
            }
            data = { state: 'resolved', resolvedBy: 'owner', resolvedAt: row.resolvedAt ?? now, ownerChoice: input.choice, ownerNote: input.note ?? null };
        } else {
            if (row.state === 'resolved' && row.resolvedBy === 'owner') return { item: itemView(row) };
            data = { state: 'resolved', resolvedBy: 'owner', resolvedAt: now, ownerNote: input.note ?? null };
        }
        const updated = await tx.attentionItem.update({ where: { id: row.id }, data: { ...data, version: { increment: 1 }, updatedAt: now } });
        announce(tx, updated);
        return { item: itemView(updated) };
    });
}

async function settleRootTask(accountId: string, row: AttentionRow, choice: string, note?: string) {
    const taskId = row.key!.slice(TEAM_SUBMIT_KEY_PREFIX.length);
    const teams = await import('@/app/teams/store');
    const team = await teams.readTeam(row.teamId!, { accountId });
    const task = team.tasks.find(t => t.id === taskId);
    requireAttention(task && task.status === 'submitted', 'attention_item_stale', 409);
    const base = { taskId: task.id, attemptId: task.currentAttemptId, goalVersion: task.goalVersion };
    const requestId = `board-${row.id}-${task.currentAttemptId}`;
    if (choice === TEAM_SUBMIT_CHOICES.accept) await teams.actOnTeam(row.teamId!, { accountId }, { requestId, action: { type: 'accept', ...base } });
    else if (choice === TEAM_SUBMIT_CHOICES.return) await teams.actOnTeam(row.teamId!, { accountId }, { requestId, action: { type: 'return', ...base, reason: note?.trim() || 'Returned from the briefing board.' } });
    else throw new AttentionError('attention_unknown_choice', 400);
}

/** GET /v1/attention-items, newest `updatedAt` first. */
export async function listItems(accountId: string, query: AttentionItemListQuery): Promise<{ items: AttentionItem[] }> {
    assertAttentionEnabled();
    const state = query.state ?? 'open';
    const needsOwner = query.needsOwner === undefined ? undefined : query.needsOwner === '1' || query.needsOwner === 'true';
    const rows = await db.attentionItem.findMany({
        where: {
            accountId,
            ...(query.sessionId ? { sessionId: query.sessionId } : {}),
            ...(state === 'open' ? { state: { in: ACTIVE_STATES } } : state === 'active' ? { state: { in: [...ACTIVE_STATES, 'answered'] } } : {}),
            ...(needsOwner !== undefined ? { needsOwner } : {}),
            ...(query.since !== undefined ? { updatedAt: { gt: new Date(query.since) } } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: query.limit ?? LIST_DEFAULT,
    });
    return { items: (state === 'active' ? capAnswered(rows) : rows).map(itemView) };
}

// ─── Hooks (never throw into the caller) ─────────────────────────────────────

/**
 * Called inside `actOnTeam`'s transaction after the reducer ran. The reducer
 * has no recipient for a root task's submit (`ownerBotId === null`,
 * reducer.ts `msg()`), so the person never heard of it; here it becomes a
 * 「待你验收」decision in the lead's session. Leaving `submitted` (accept /
 * return / cancel, always the owner for a root task) closes it.
 */
export async function applyTeamTransitionsTx(tx: Tx, accountId: string, before: TeamState, after: TeamState): Promise<void> {
    if (!attentionEnabled()) return;
    const { submitted, settled } = rootTaskTransitions(before, after);
    for (const task of submitted) {
        const sessionId = after.bots.find(b => b.id === task.assigneeBotId)?.sessionId;
        if (!sessionId || !await tx.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } })) continue;
        const item = teamSubmitItem(after, task);
        // A resubmit after「退回」is a new attempt: same key, new request id → the closed item reopens and may push again.
        await upsertTx(tx, accountId, { sessionId, ...item, bodyMd: item.bodyMd ?? undefined, requestId: `team-submit-${task.currentAttemptId}` },
            { teamId: after.id, projectId: after.projectId ?? null });
    }
    const now = new Date();
    for (const task of settled) {
        const sessionId = after.bots.find(b => b.id === task.assigneeBotId)?.sessionId;
        if (!sessionId) continue;
        const row = await tx.attentionItem.findUnique({ where: { sessionId_key: { sessionId, key: teamSubmitKey(task.id) } } });
        if (!row || row.accountId !== accountId || !isAttentionActive(row.state)) continue;
        const choice = task.status === 'done' ? TEAM_SUBMIT_CHOICES.accept : task.status === 'running' ? TEAM_SUBMIT_CHOICES.return : null;
        const updated = await tx.attentionItem.update({
            where: { id: row.id },
            data: { state: choice ? 'resolved' : 'dismissed', resolvedBy: 'owner', resolvedAt: now, ownerChoice: choice, version: { increment: 1 }, updatedAt: now },
        });
        announce(tx, updated);
    }
}

async function closeActive(accountId: string, sessionId: string, select: (rows: AttentionRow[]) => string[], data: { state: string; resolvedBy: string }): Promise<string[]> {
    return inTx(async tx => {
        const rows = await tx.attentionItem.findMany({ where: { accountId, sessionId, state: { in: ACTIVE_STATES } } });
        const ids = select(rows);
        const now = new Date();
        for (const id of ids) {
            const updated = await tx.attentionItem.update({ where: { id }, data: { ...data, resolvedAt: now, version: { increment: 1 }, updatedAt: now } });
            announce(tx, updated);
        }
        return ids;
    });
}

/**
 * Message ingress hook beside B-508's `noteSessionMessage`: the owner speaking
 * in a session settles its only open decision (`owner-replied`). A message the
 * board itself sent (localId `board-…`) is skipped — that button already
 * settled its own item through `owner-respond`.
 */
export async function noteAttentionOwnerMessage(input: { accountId: string; sessionId: string } & MessageOrigin): Promise<string[]> {
    if (!attentionEnabled() || !isOwnerAuthoredMessage(input) || isAttentionBoardLocalId(input.localId)) return [];
    try {
        return await closeActive(input.accountId, input.sessionId, rows => { const id = ownerRepliedTarget(rows); return id ? [id] : []; }, { state: 'resolved', resolvedBy: 'owner-replied' });
    } catch (error) {
        log({ module: 'attention', level: 'warn', error }, 'attention owner-replied hook failed');
        return [];
    }
}

/** Archive hook (user intent, B-505): every open item of the session is dismissed. */
export async function noteAttentionSessionArchived(accountId: string, sessionId: string): Promise<string[]> {
    if (!attentionEnabled()) return [];
    try {
        return await closeActive(accountId, sessionId, rows => rows.map(r => r.id), { state: 'dismissed', resolvedBy: 'session-archived' });
    } catch (error) {
        log({ module: 'attention', level: 'warn', error }, 'attention session-archived hook failed');
        return [];
    }
}
