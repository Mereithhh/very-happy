import { Prisma, type ModelFeedback } from '@prisma/client';
import type { ModelFeedbackRecord, ModelFeedbackSubmit, ModelFeedbackView } from '@slopus/happy-wire';
import { enforceAccountWriteRate } from '@/app/api/resourceLimits';
import { isFeedbackAdmin } from '@/app/feedback/rules';
import { instanceConfig, type ModelFeedbackForward } from '@/app/instance/instanceConfig';
import { resolveSessionAccess } from '@/app/session/sessionShares';
import { displayNameOf, identityOf } from '@/app/social/accountDirectory';
import { db } from '@/storage/db';
import { log } from '@/utils/log';

/**
 * B-980 model-answer feedback (`specs/2026-11-model-feedback.md`).
 *
 * One row per (account, session, turn): a second tap replaces the rating, so
 * the PUT is idempotent and a retry after a lost response is harmless. Every
 * write is stored here first; when the instance config names a forward
 * target the row becomes `pending` and a best-effort POST sends the whole
 * record (receivers upsert by `id`). Failures are retried with backoff by
 * `forwardPendingModelFeedback` and never fail the user's write.
 */

export class ModelFeedbackError extends Error {
    constructor(readonly code: string, readonly status: number) {
        super(code);
    }
}

const MAX_FORWARD_ATTEMPTS = 8;
const ratingScore = { down: 1, up: 2 } as const;
const scoreRating = (score: number): 'up' | 'down' => (score >= 2 ? 'up' : 'down');

export function modelFeedbackEnabled(): boolean {
    return instanceConfig().modelFeedback?.enabled === true;
}

/** Feedback admins: `VH_FEEDBACK_ADMIN_ACCOUNT_IDS` (B-836) plus the instance config `admins`. */
export function isModelFeedbackAdmin(accountId: string): boolean {
    return isFeedbackAdmin(accountId) || instanceConfig().admins.includes(accountId);
}

function view(row: ModelFeedback): ModelFeedbackView {
    return { id: row.id, sessionId: row.sessionId, turnId: row.turnId, rating: scoreRating(row.rating), comment: row.comment, updatedAt: row.updatedAt.getTime() };
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function profileOf(value: unknown): ModelFeedbackRecord['accountProfile'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string') return null;
    return { id: v.id, ...(typeof v.label === 'string' ? { label: v.label } : {}), ...(typeof v.kind === 'string' ? { kind: v.kind } : {}) };
}

/** Pure: the exported / forwarded shape. */
export function modelFeedbackRecord(row: ModelFeedback, account?: ModelFeedbackRecord['account']): ModelFeedbackRecord {
    return {
        id: row.id,
        accountId: row.accountId,
        ...(account ? { account } : {}),
        sessionId: row.sessionId,
        turnId: row.turnId,
        rating: scoreRating(row.rating),
        comment: row.comment,
        requestIds: stringArray(row.requestIds),
        model: row.model,
        reportedModel: row.reportedModel,
        agent: row.agent,
        accountProfile: profileOf(row.accountProfile),
        messageSeq: row.messageSeq,
        answeredAt: row.answeredAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

async function accountSummary(accountId: string): Promise<NonNullable<ModelFeedbackRecord['account']>> {
    const [account, identity] = await Promise.all([
        db.account.findUnique({ where: { id: accountId }, select: { firstName: true, lastName: true, username: true } }),
        identityOf(accountId),
    ]);
    return {
        username: account?.username ?? identity.handle,
        displayName: account ? displayNameOf(account, identity) : null,
        email: identity.email,
    };
}

/** Requests carrying ids beyond what one turn plausibly sends are trimmed, never rejected. */
function cleanRequestIds(ids: readonly string[]): string[] {
    return [...new Set(ids.map(s => s.trim()).filter(Boolean))].slice(0, 200);
}

export async function submitModelFeedback(accountId: string, input: ModelFeedbackSubmit): Promise<{ feedback: ModelFeedbackView }> {
    if (!modelFeedbackEnabled()) throw new ModelFeedbackError('model_feedback_disabled', 404);
    // Anyone who can read the session may rate it (owner or grantee); others learn nothing about it.
    const access = await resolveSessionAccess(accountId, input.sessionId);
    if (!access) throw new ModelFeedbackError('session_not_found', 404);
    await enforceAccountWriteRate({ accountId, resource: 'model_feedback', envName: 'MAX_MODEL_FEEDBACK_PER_ACCOUNT_PER_MINUTE', fallback: 30 });
    const forward = instanceConfig().modelFeedback?.forward ?? null;
    const data = {
        rating: ratingScore[input.rating],
        comment: input.comment?.trim() || null,
        requestIds: cleanRequestIds(input.requestIds),
        model: input.model ?? null,
        reportedModel: input.reportedModel ?? null,
        agent: input.agent ?? null,
        accountProfile: input.accountProfile ? (input.accountProfile as Prisma.InputJsonValue) : Prisma.JsonNull,
        messageSeq: input.messageSeq ?? null,
        answeredAt: input.answeredAt ? new Date(input.answeredAt) : null,
        forwardStatus: forward ? 'pending' : 'off',
        forwardAttempts: 0,
        forwardError: null,
    };
    const row = await db.modelFeedback.upsert({
        where: { accountId_sessionId_turnId: { accountId, sessionId: input.sessionId, turnId: input.turnId } },
        create: { accountId, sessionId: input.sessionId, turnId: input.turnId, ...data },
        update: data,
    });
    if (forward) void forwardOne(row, forward);
    return { feedback: view(row) };
}

export async function deleteModelFeedback(accountId: string, sessionId: string, turnId: string): Promise<{ deleted: boolean }> {
    const result = await db.modelFeedback.deleteMany({ where: { accountId, sessionId, turnId } });
    return { deleted: result.count > 0 };
}

/** The caller's own ratings in one session (so the buttons show what was chosen, on any device). */
export async function listSessionModelFeedback(accountId: string, sessionId: string): Promise<{ items: ModelFeedbackView[] }> {
    const rows = await db.modelFeedback.findMany({ where: { accountId, sessionId }, orderBy: { updatedAt: 'desc' }, take: 1000 });
    return { items: rows.map(view) };
}

// ---------------------------------------------------------------- forward

/** Pure: delay before retry `attempts` (1-based): 30 s, 1 m, 2 m … capped at 1 h. */
export function forwardBackoffMs(attempts: number): number {
    return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

type ForwardFetch = (url: string, init: RequestInit) => Promise<Response>;
let forwardFetch: ForwardFetch = (url, init) => fetch(url, init);
/** Test hook. */
export function setModelFeedbackForwardFetch(fn: ForwardFetch | null): void {
    forwardFetch = fn ?? ((url, init) => fetch(url, init));
}

async function forwardOne(row: ModelFeedback, target: ModelFeedbackForward): Promise<void> {
    // Claim: only the writer that bumps `forwardAttempts` from the value it read sends, so two replicas never double-send one version.
    const claimed = await db.modelFeedback.updateMany({
        where: { id: row.id, forwardStatus: 'pending', forwardAttempts: row.forwardAttempts, updatedAt: row.updatedAt },
        // `updatedAt` pinned: it identifies the rating version, and Prisma would otherwise bump it.
        data: { forwardAttempts: row.forwardAttempts + 1, updatedAt: row.updatedAt },
    }).catch(() => ({ count: 0 }));
    if (claimed.count !== 1) return;
    const attempts = row.forwardAttempts + 1;
    let error: string | null = null;
    try {
        const record = modelFeedbackRecord(row, await accountSummary(row.accountId));
        const res = await forwardFetch(target.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...target.headers },
            body: JSON.stringify({ type: 'model-feedback', record }),
            redirect: 'error',
            signal: AbortSignal.timeout(target.timeoutMs),
        });
        if (!res.ok) error = `http ${res.status}`;
        await res.body?.cancel().catch(() => undefined);
    } catch (e) {
        error = e instanceof Error ? e.name === 'TimeoutError' ? 'timeout' : e.message.slice(0, 200) : 'error';
    }
    // `updatedAt` is pinned so a newer rating written meanwhile keeps its own `pending` state.
    await db.modelFeedback.updateMany({
        where: { id: row.id, updatedAt: row.updatedAt },
        data: error
            ? { forwardStatus: attempts >= MAX_FORWARD_ATTEMPTS ? 'failed' : 'pending', forwardError: error, updatedAt: row.updatedAt }
            : { forwardStatus: 'sent', forwardedAt: new Date(), forwardError: null, updatedAt: row.updatedAt },
    }).catch(e => log({ module: 'model-feedback', level: 'warn', error: e }, 'forward state update failed'));
    if (error) log({ module: 'model-feedback', level: 'warn' }, `forward failed (attempt ${attempts}): ${error}`);
}

/**
 * Retry sweep: rows still `pending` whose backoff has passed. `updatedAt` is
 * kept equal to the rating's write time, so the backoff is measured from the
 * last attempt via `forwardAttempts` and the sweep's own clock.
 */
const lastAttemptAt = new Map<string, number>();
export async function forwardPendingModelFeedback(now = Date.now()): Promise<number> {
    const target = instanceConfig().modelFeedback?.forward;
    if (!target) return 0;
    const rows = await db.modelFeedback.findMany({ where: { forwardStatus: 'pending' }, orderBy: { updatedAt: 'asc' }, take: 50 });
    let sent = 0;
    for (const row of rows) {
        const last = lastAttemptAt.get(row.id);
        if (row.forwardAttempts > 0 && last !== undefined && now - last < forwardBackoffMs(row.forwardAttempts)) continue;
        lastAttemptAt.set(row.id, now);
        await forwardOne(row, target);
        sent++;
    }
    if (lastAttemptAt.size > 5000) lastAttemptAt.clear();
    return sent;
}

/** Pending rows written before forwarding was configured stay `off`; a newly configured target picks up only new writes. */
export function startModelFeedbackForwarder(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
        forwardPendingModelFeedback().catch(error => log({ module: 'model-feedback', level: 'warn', error }, 'forward sweep failed'));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

// ---------------------------------------------------------------- export

export interface ModelFeedbackExportQuery {
    since?: number;
    until?: number;
    model?: string;
    rating?: 'up' | 'down';
    limit: number;
}

export async function exportModelFeedback(accountId: string, query: ModelFeedbackExportQuery): Promise<ModelFeedbackRecord[]> {
    if (!isModelFeedbackAdmin(accountId)) throw new ModelFeedbackError('not_found', 404);
    const rows = await db.modelFeedback.findMany({
        where: {
            ...(query.since || query.until ? { updatedAt: { ...(query.since ? { gte: new Date(query.since) } : {}), ...(query.until ? { lt: new Date(query.until) } : {}) } } : {}),
            ...(query.model ? { OR: [{ model: query.model }, { reportedModel: query.model }] } : {}),
            ...(query.rating ? { rating: ratingScore[query.rating] } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
    });
    const accounts = new Map<string, NonNullable<ModelFeedbackRecord['account']>>();
    for (const id of new Set(rows.map(r => r.accountId))) accounts.set(id, await accountSummary(id));
    return rows.map(row => modelFeedbackRecord(row, accounts.get(row.accountId)));
}

const CSV_COLUMNS = ['id', 'updatedAt', 'rating', 'comment', 'sessionId', 'turnId', 'requestIds', 'model', 'reportedModel', 'agent', 'accountProfileId', 'accountProfileLabel', 'accountId', 'username', 'email', 'messageSeq', 'answeredAt', 'createdAt'] as const;

function csvCell(value: unknown): string {
    const s = value === null || value === undefined ? '' : String(value);
    // Leading = + - @ would run as a formula in spreadsheet apps.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Pure: records → CSV (request ids joined with spaces). */
export function modelFeedbackCsv(records: readonly ModelFeedbackRecord[]): string {
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of records) {
        const row: Record<(typeof CSV_COLUMNS)[number], unknown> = {
            id: r.id, updatedAt: r.updatedAt, rating: r.rating, comment: r.comment, sessionId: r.sessionId, turnId: r.turnId,
            requestIds: r.requestIds.join(' '), model: r.model, reportedModel: r.reportedModel, agent: r.agent,
            accountProfileId: r.accountProfile?.id, accountProfileLabel: r.accountProfile?.label, accountId: r.accountId,
            username: r.account?.username, email: r.account?.email, messageSeq: r.messageSeq, answeredAt: r.answeredAt, createdAt: r.createdAt,
        };
        lines.push(CSV_COLUMNS.map(c => csvCell(row[c])).join(','));
    }
    return lines.join('\n') + '\n';
}
