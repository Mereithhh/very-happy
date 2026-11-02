import type { IssueView } from '@slopus/happy-wire';
import { closeIssueItemsTx, postIssueItemTx } from '@/app/attention/store';
import type { Tx } from '@/storage/inTx';
import { attentionClosedByStatus, blockedItem, ISSUE_ATTENTION_KEYS, mentionItem, reviewItem, runFailedItem, type RunRow } from './rules';

/**
 * B-872 → 「需要我决策」 (`specs/2026-11-issues.md` §7). Every function runs
 * inside the issue transaction and goes through the attention store's
 * internal API (source `issue`, link `{type:'issue'}`), so it inherits the
 * board switch (`VH_OWNER_BOARD_ENABLED`), dedupe by key and push-at-most-once.
 * An item needs a session (`AttentionItem.sessionId` is required): run
 * failures without one are merged by the Web from the run table instead.
 */

/** The agent moved the issue to in_review / blocked: one item per issue key; a repeat reopens the same item. */
export async function bridgeAgentStatus(tx: Tx, accountId: string, issue: IssueView, sessionId: string, to: string, comment: { id: string; body: string } | null): Promise<void> {
    const requestId = `issue-status-${issue.id}-${issue.version}`;
    if (to === 'in_review') await postIssueItemTx(tx, accountId, sessionId, reviewItem(issue, comment?.body ?? null), requestId, { projectId: issue.projectId });
    else if (to === 'blocked') await postIssueItemTx(tx, accountId, sessionId, blockedItem(issue, comment?.body ?? null), requestId, { projectId: issue.projectId });
}

/**
 * The issue left a status (any actor). Leaving in_review / blocked resolves
 * that item (`issue-status`); done / cancelled / delete dismisses every open
 * item of the issue. `owner` = the board's「完成」/「退回」button, recorded as
 * the owner's choice on the review item.
 */
export async function bridgeStatusLeft(tx: Tx, accountId: string, input: {
    issueId: string; from: string; to: string; deleted?: boolean;
    runIds: string[]; mentionCommentIds: string[];
    owner?: { choice: string; note: string | null };
}): Promise<void> {
    const closed = input.deleted ? { review: true, blocked: true, all: true } : attentionClosedByStatus(input.from, input.to);
    if (closed.review && input.owner) {
        await closeIssueItemsTx(tx, accountId, [ISSUE_ATTENTION_KEYS.review(input.issueId)], { state: 'resolved', resolvedBy: 'owner', ownerChoice: input.owner.choice, ownerNote: input.owner.note });
    }
    const state = closed.all ? 'dismissed' : 'resolved';
    const keys = [
        ...(closed.review && !input.owner ? [ISSUE_ATTENTION_KEYS.review(input.issueId)] : []),
        ...(closed.blocked ? [ISSUE_ATTENTION_KEYS.blocked(input.issueId)] : []),
        ...(closed.all ? [...input.runIds.map(ISSUE_ATTENTION_KEYS.runFailed), ...input.mentionCommentIds.map(ISSUE_ATTENTION_KEYS.mention)] : []),
    ];
    await closeIssueItemsTx(tx, accountId, keys, { state, resolvedBy: 'issue-status' });
}

/** A run with a session failed (wrapper crash): a blocked item in that session. */
export async function bridgeRunFailed(tx: Tx, accountId: string, issue: IssueView, run: RunRow): Promise<void> {
    if (!run.sessionId) return;
    await postIssueItemTx(tx, accountId, run.sessionId, runFailedItem(issue, run), `issue-run-failed-${run.id}`, { projectId: issue.projectId });
}

/** A new run started / the owner acknowledged: the earlier failures' items close. */
export async function bridgeRunFailuresCleared(tx: Tx, accountId: string, runIds: string[], by: 'owner' | 'issue-status'): Promise<void> {
    await closeIssueItemsTx(tx, accountId, runIds.map(ISSUE_ATTENTION_KEYS.runFailed), { state: 'resolved', resolvedBy: by });
}

/** An agent comment with `mention_owner`: 「@你」 todo item. */
export async function bridgeOwnerMention(tx: Tx, accountId: string, issue: IssueView, sessionId: string, comment: { id: string; body: string }): Promise<void> {
    await postIssueItemTx(tx, accountId, sessionId, mentionItem(issue, comment), `issue-mention-${comment.id}`, { projectId: issue.projectId });
}

/** The owner commented on the issue (or pressed 知道了): its open @我 items are handled. */
export async function bridgeOwnerMentionsHandled(tx: Tx, accountId: string, commentIds: string[]): Promise<void> {
    await closeIssueItemsTx(tx, accountId, commentIds.map(ISSUE_ATTENTION_KEYS.mention), { state: 'resolved', resolvedBy: 'owner-replied' });
}
