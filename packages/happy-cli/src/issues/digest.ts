import type { IssueCommentView, IssueView } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { prependToMessage } from '@/projects/prompt';
import { IssuesUnsupportedError, sharedIssuesClient, type IssuesClient } from './client';
import { readSessionIssueMetadata } from './sessionMetadata';
import { configuration } from '@/configuration';
import { join } from 'node:path';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';

/**
 * B-874 next-turn issue digest (spec §5, third layer). Before a turn that is
 * already going to run (the owner typed into the session), an issue session
 * gets ≤1 line when the owner changed the issue's status / assignee / fields
 * since the last turn: `[Issue VH-12 now todo (in_review → todo by owner); description updated]`.
 * Comments are not digested: a routed comment arrives as its own message.
 *
 * Never starts a turn; every failure (old server, timeout, unbound yet) sends
 * the message unchanged. The first turn only sets the cursor: that turn is the
 * issue prompt itself.
 */

export function buildIssueDigestLine(issue: Pick<IssueView, 'key' | 'status'>, entries: readonly IssueCommentView[]): string | null {
    const human = entries.filter(e => e.author.kind === 'user' && !e.deletedAt);
    const statuses = human.filter(e => e.kind === 'status');
    const parts: string[] = [];
    if (statuses.length) {
        const from = (statuses[0].data as { from?: unknown } | null)?.from;
        parts.push(`now ${issue.status}${typeof from === 'string' ? ` (${from} → ${issue.status} by owner)` : ' (changed by owner)'}`);
    }
    if (human.some(e => e.kind === 'assign')) parts.push('assignee changed');
    const fields = new Set<string>();
    for (const e of human) if (e.kind === 'field') for (const f of ((e.data as { fields?: unknown } | null)?.fields as unknown[] | undefined) ?? []) if (typeof f === 'string') fields.add(f);
    if (fields.size) parts.push(`${[...fields].join(', ')} updated`);
    if (!parts.length) return null;
    return `[Issue ${issue.key} ${parts.join('; ')}]`;
}

export type IssueDigestDeps = {
    sessionId: () => string | null | undefined;
    /** Session metadata (server copy after a reconnect): `metadata.issue` marks an issue session. */
    metadata?: () => unknown;
    /** Only issue sessions call the server; default = VH_ISSUE_ID in env or `metadata.issue`. */
    enabled?: () => boolean;
    client?: IssuesClient;
    timeoutMs?: number;
    /** Cursor store that outlives the wrapper (relaunch); default = a file per session under HAPPY_HOME_DIR. */
    cursorStore?: IssueDigestCursorStore | null;
};

export type IssueDigestCursorStore = {
    read(sessionId: string): number | null;
    write(sessionId: string, asOf: number): void;
};

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Cursor files untouched this long are pruned (the session is long gone). */
export const ISSUE_DIGEST_CURSOR_TTL_MS = 30 * 24 * 3600_000;

/**
 * B-874c: the digest cursor (server `asOf`, so no clock skew) in
 * `<home>/issues/digest/<sessionId>.json`. A relaunched wrapper (auto-restart,
 * Restart, account switch, crash restart, wake) continues from the last turn
 * of the previous one instead of silently skipping the changes in between.
 */
export function fileIssueDigestCursorStore(home: string, now = Date.now): IssueDigestCursorStore {
    const dir = join(home, 'issues', 'digest');
    let pruned = false;
    return {
        read(sessionId) {
            if (!SESSION_ID.test(sessionId)) return null;
            try {
                const asOf = (JSON.parse(readFileSync(join(dir, `${sessionId}.json`), 'utf8')) as { asOf?: unknown }).asOf;
                return typeof asOf === 'number' && Number.isFinite(asOf) ? asOf : null;
            } catch { return null; }
        },
        write(sessionId, asOf) {
            if (!SESSION_ID.test(sessionId)) return;
            try {
                ensurePrivateDirectorySync(dir);
                writePrivateFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ asOf }));
                if (!pruned) {
                    pruned = true;
                    for (const file of readdirSync(dir)) {
                        const path = join(dir, file);
                        try { if (now() - statSync(path).mtimeMs > ISSUE_DIGEST_CURSOR_TTL_MS) unlinkSync(path); } catch { /* raced */ }
                    }
                }
            } catch (error) { logger.debug(`[issues] digest cursor not saved: ${String(error)}`); }
        },
    };
}

export function createIssueDigest(deps: IssueDigestDeps) {
    const client = deps.client ?? sharedIssuesClient();
    // B-874c (QA43 P1-1): a relaunched wrapper may lack VH_ISSUE_* — metadata.issue (server-owned, kept across reconnects) still marks it.
    const enabled = deps.enabled ?? (() => !!process.env.VH_ISSUE_ID || readSessionIssueMetadata(deps.metadata?.()) !== null);
    const timeoutMs = deps.timeoutMs ?? 1500;
    const store = deps.cursorStore === undefined ? fileIssueDigestCursorStore(configuration.happyHomeDir) : deps.cursorStore;
    let cursor: number | null = null;
    let loadedFor: string | null = null;
    const advance = (sid: string, asOf: number) => { cursor = asOf; store?.write(sid, asOf); };
    return {
        cursor: () => cursor,
        async decorate(message: string): Promise<string> {
            const sid = deps.sessionId();
            if (!sid || !enabled() || client.isDisabled()) return message;
            if (loadedFor !== sid) { loadedFor = sid; cursor = store?.read(sid) ?? null; }
            try {
                if (cursor === null) {
                    const ctx = await client.session(sid, undefined, timeoutMs);
                    // Not bound yet (the daemon completes the dispatch after this first message): try next turn.
                    if (ctx.issue) advance(sid, ctx.asOf);
                    return message;
                }
                const ctx = await client.session(sid, cursor, timeoutMs);
                if (!ctx.issue) return message;
                advance(sid, ctx.asOf);
                return prependToMessage(message, buildIssueDigestLine(ctx.issue, ctx.comments));
            } catch (error) {
                if (!(error instanceof IssuesUnsupportedError)) logger.debug(`[issues] digest skipped: ${String(error)}`);
                return message;
            }
        },
    };
}
export type IssueDigest = ReturnType<typeof createIssueDigest>;
