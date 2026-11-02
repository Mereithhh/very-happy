import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { buildIssueCommentPrompt, isIssueRunActive, type IssueDispatchPollResponse, type IssueDispatchView, type IssueWorkersResponse } from '@slopus/happy-wire';
import { inTx, type Tx } from '@/storage/inTx';
import { log } from '@/utils/log';
import {
    CLAIM_LEASE_MS, commentView, dispatchView, issuesEnabled, issueView, MAX_DISPATCH_ATTEMPTS, requireIssue,
    type DispatchRow, type MessagePayload, type RunRow,
} from './rules';
import { buildRunPrompt, emitRun, failRunTx, onRunStartedTx, respawnForCommentTx, runIssueTx } from './store';

/**
 * B-872 daemon side (`specs/2026-11-issues.md` §3.2): the server never calls
 * a daemon; each machine's issue worker polls `GET /v1/issues/dispatch`
 * (every 5 s), claims one dispatch at a time (a conditional update — only
 * one claimer wins), then completes or fails it. A claim not completed within
 * the 120 s lease goes back to the queue; the third expiry fails the run.
 */

const POLL_LIMIT = 20;

async function requireMachine(tx: Tx, accountId: string, machineId: string) {
    requireIssue(await tx.machine.findFirst({ where: { id: machineId, accountId }, select: { id: true } }), 'issue_machine_not_found', 404, { machineId });
}

/** Expired claims of this machine: back to the queue, or — at the attempt limit — the run fails. */
async function reclaimExpired(tx: Tx, accountId: string, machineId: string) {
    const expired = await tx.issueDispatch.findMany({ where: { accountId, machineId, status: 'claimed', claimedAt: { lt: new Date(Date.now() - CLAIM_LEASE_MS) } } });
    for (const d of expired) {
        const attempts = d.attempts + 1;
        const run = await tx.issueRun.findUnique({ where: { id: d.runId } });
        if (attempts >= MAX_DISPATCH_ATTEMPTS) {
            await tx.issueDispatch.update({ where: { id: d.id }, data: { status: 'failed', attempts, error: 'claim lease expired', doneAt: new Date() } });
            if (run && d.kind === 'spawn') await failRunTx(tx, run, 'claim lease expired 3 times');
            continue;
        }
        // The prompt frozen by the expired claim goes with it: the poll preview is then rebuilt like the next claim's (QA42 P2-3).
        const { prompt: _expired, ...payload } = (d.payload ?? {}) as Prisma.JsonObject;
        await tx.issueDispatch.update({ where: { id: d.id }, data: { status: 'queued', attempts, claimId: null, claimedAt: null, ...(d.kind === 'spawn' ? { payload } : {}) } });
        if (run && d.kind === 'spawn' && run.status === 'claimed') emitRun(tx, await tx.issueRun.update({ where: { id: run.id }, data: { status: 'queued', claimedAt: null } }));
    }
}

async function spawnView(tx: Tx, row: DispatchRow): Promise<IssueDispatchView> {
    const payload = row.payload as { prompt?: string } | null;
    if (row.kind !== 'spawn' || payload?.prompt) return dispatchView(row);
    const run = await tx.issueRun.findUniqueOrThrow({ where: { id: row.runId } });
    const issue = await tx.issue.findUniqueOrThrow({ where: { id: row.issueId } });
    return dispatchView(row, await buildRunPrompt(tx, issue, run));
}

/**
 * Poll: records the worker as seen, recycles expired claims, and lists this
 * machine's queued dispatches. A spawn's prompt here is a preview built now;
 * the prompt the run gets is the one its claim freezes (spec §3.2).
 */
export async function pollDispatches(accountId: string, machineId: string, workerVersion: number): Promise<IssueDispatchPollResponse> {
    return runIssueTx(async tx => {
        await requireMachine(tx, accountId, machineId);
        await tx.issueWorker.upsert({
            where: { accountId_machineId: { accountId, machineId } },
            create: { accountId, machineId, workerVersion, lastSeenAt: new Date() },
            update: { workerVersion, lastSeenAt: new Date() },
        });
        await reclaimExpired(tx, accountId, machineId);
        const rows = await tx.issueDispatch.findMany({ where: { accountId, machineId, status: 'queued' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: POLL_LIMIT });
        const dispatches: IssueDispatchView[] = [];
        for (const row of rows) dispatches.push(await spawnView(tx, row));
        return { dispatches };
    });
}

/**
 * Claim: `queued → claimed` with a fresh claimId, conditional on still being
 * queued (concurrent claimers: one wins, the rest get 409). A spawn freezes
 * its prompt now — every claim rebuilds it, so a re-claim after an expired
 * lease sees the latest title / comments — and moves the run to `claimed`.
 */
export async function claimDispatch(accountId: string, dispatchId: string, machineId: string): Promise<{ dispatch: IssueDispatchView }> {
    return runIssueTx(async tx => {
        const row = await tx.issueDispatch.findFirst({ where: { id: dispatchId, accountId, machineId } });
        requireIssue(row, 'issue_dispatch_not_found', 404);
        const run = await tx.issueRun.findUniqueOrThrow({ where: { id: row.runId } });
        requireIssue(row.status !== 'queued' || isIssueRunActive(run.status), 'issue_run_not_current', 409);
        const claimId = randomUUID();
        const now = new Date();
        let payload = row.payload as Prisma.JsonObject;
        if (row.kind === 'spawn') {
            const issue = await tx.issue.findUniqueOrThrow({ where: { id: row.issueId } });
            payload = { ...payload, prompt: await buildRunPrompt(tx, issue, run) };
        }
        const won = await tx.issueDispatch.updateMany({ where: { id: row.id, status: 'queued' }, data: { status: 'claimed', claimId, claimedAt: now, payload } });
        requireIssue(won.count === 1, 'issue_dispatch_claim_mismatch', 409);
        if (row.kind === 'spawn' && run.status === 'queued') emitRun(tx, await tx.issueRun.update({ where: { id: run.id }, data: { status: 'claimed', claimedAt: now } }));
        const claimed = await tx.issueDispatch.findUniqueOrThrow({ where: { id: row.id } });
        return { dispatch: dispatchView(claimed) };
    });
}

async function loadClaimed(tx: Tx, accountId: string, dispatchId: string, machineId: string, claimId: string): Promise<DispatchRow & { status: string }> {
    const row = await tx.issueDispatch.findFirst({ where: { id: dispatchId, accountId, machineId } });
    requireIssue(row, 'issue_dispatch_not_found', 404);
    requireIssue(row.claimId === claimId, 'issue_dispatch_claim_mismatch', 409);
    return row;
}

/**
 * Complete. spawn: the run gets its session and goes `running` (todo →
 * in_progress, §3.4); comments the run absorbed after its prompt was frozen
 * are delivered as messages. A superseded run still records its session, so
 * that session's writes are refused (§3.6). Idempotent per claimId.
 */
export async function completeDispatch(accountId: string, dispatchId: string, input: { machineId: string; claimId: string; sessionId: string }): Promise<{ ok: true }> {
    return runIssueTx(async tx => {
        const row = await loadClaimed(tx, accountId, dispatchId, input.machineId, input.claimId);
        if (row.status === 'done') return { ok: true };
        requireIssue(row.status === 'claimed', 'issue_dispatch_claim_mismatch', 409);
        await tx.issueDispatch.update({ where: { id: row.id }, data: { status: 'done', doneAt: new Date() } });
        if (row.kind !== 'spawn') return { ok: true };
        const session = await tx.session.findFirst({ where: { id: input.sessionId }, select: { accountId: true } });
        requireIssue(!session || session.accountId === accountId, 'session_not_found', 404);
        const run = await tx.issueRun.findUniqueOrThrow({ where: { id: row.runId } });
        const active = run.status === 'claimed' || run.status === 'queued';
        const now = new Date();
        const updated = await tx.issueRun.update({ where: { id: run.id }, data: { sessionId: input.sessionId, ...(active ? { status: 'running', startedAt: now } : {}) } });
        emitRun(tx, updated);
        if (!active) return { ok: true };
        const issue = await tx.issue.findUniqueOrThrow({ where: { id: run.issueId } });
        if (!issue.deletedAt) await onRunStartedTx(tx, issue, updated);
        await deliverAbsorbed(tx, updated, row.claimedAt ?? now);
        return { ok: true };
    });
}

/** Comments routed to this run after its prompt froze (between claim and complete) go in as queued messages. */
async function deliverAbsorbed(tx: Tx, run: RunRow, frozenAt: Date) {
    const late = await tx.issueComment.findMany({ where: { issueId: run.issueId, kind: 'comment', deletedAt: null, routedRunIds: { has: run.id }, createdAt: { gte: frozenAt } }, orderBy: { createdAt: 'asc' } });
    if (late.length === 0) return;
    const issue = await tx.issue.findUniqueOrThrow({ where: { id: run.issueId } });
    for (const c of late) {
        const payload: MessagePayload = { sessionId: run.sessionId!, commentId: c.id, text: buildIssueCommentPrompt({ issue: issueView(issue), comment: commentView(c) }) };
        await tx.issueDispatch.create({ data: { id: randomUUID(), accountId: run.accountId, runId: run.id, issueId: run.issueId, machineId: run.machineId, kind: 'message', payload: payload as unknown as Prisma.InputJsonValue, status: 'queued' } });
    }
}

/**
 * Fail. spawn: `unknown` keeps the run `claimed` for an owner retry (the
 * session may exist, B-689); otherwise the run fails (§3.7). message: the
 * session is not live — that run is over and the comment starts a new run.
 */
export async function failDispatch(accountId: string, dispatchId: string, input: { machineId: string; claimId: string; error: string; unknown?: boolean }): Promise<{ ok: true }> {
    return runIssueTx(async tx => {
        const row = await loadClaimed(tx, accountId, dispatchId, input.machineId, input.claimId);
        if (row.status === 'failed') return { ok: true };
        requireIssue(row.status === 'claimed', 'issue_dispatch_claim_mismatch', 409);
        await tx.issueDispatch.update({ where: { id: row.id }, data: { status: 'failed', error: input.error.slice(0, 4000), doneAt: new Date() } });
        const run = await tx.issueRun.findUniqueOrThrow({ where: { id: row.runId } });
        if (row.kind === 'spawn') {
            if (!input.unknown) await failRunTx(tx, run, input.error);
            return { ok: true };
        }
        const payload = row.payload as unknown as MessagePayload;
        await respawnForCommentTx(tx, run, payload);
        return { ok: true };
    });
}

/**
 * Daemon view of a run's session: running / idle (turn state), exited (the
 * session ended — B-505 infrastructure exits included — never a failure),
 * crashed (wrapper crash → failed with a 「需要我决策」 item).
 */
export async function runSessionEvent(accountId: string, runId: string, input: { machineId: string; sessionId: string; event: 'running' | 'idle' | 'exited' | 'crashed' }): Promise<{ ok: true }> {
    return runIssueTx(async tx => {
        const run = await tx.issueRun.findFirst({ where: { id: runId, accountId, machineId: input.machineId, sessionId: input.sessionId } });
        requireIssue(run, 'issue_run_not_found', 404);
        if (!isIssueRunActive(run.status)) return { ok: true };
        if (input.event === 'crashed') {
            await failRunTx(tx, run, 'wrapper crashed');
            return { ok: true };
        }
        const next = input.event === 'exited' ? 'ended' : input.event;
        if (next === run.status) return { ok: true };
        emitRun(tx, await tx.issueRun.update({ where: { id: run.id }, data: { status: next, ...(next === 'ended' ? { endedAt: new Date() } : {}) } }));
        return { ok: true };
    });
}

export async function listWorkers(accountId: string): Promise<IssueWorkersResponse> {
    return runIssueTx(async tx => {
        const rows = await tx.issueWorker.findMany({ where: { accountId }, orderBy: { lastSeenAt: 'desc' } });
        return { workers: rows.map(r => ({ machineId: r.machineId, workerVersion: r.workerVersion, lastSeenAt: r.lastSeenAt.getTime() })) };
    });
}

/** Archive hook (user intent, B-505): the session's active run ends. Never throws into the archive route. */
export async function noteIssueSessionArchived(accountId: string, sessionId: string): Promise<void> {
    if (!issuesEnabled()) return;
    try {
        await inTx(async tx => {
            const run = await tx.issueRun.findFirst({ where: { sessionId, accountId } });
            if (!run || !isIssueRunActive(run.status)) return;
            emitRun(tx, await tx.issueRun.update({ where: { id: run.id }, data: { status: 'ended', endedAt: new Date() } }));
            await tx.issueDispatch.updateMany({ where: { runId: run.id, status: 'queued' }, data: { status: 'cancelled', doneAt: new Date() } });
        });
    } catch (error) {
        log({ module: 'issues', level: 'warn', error }, 'issue session-archived hook failed');
    }
}
