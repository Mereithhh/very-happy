import { join } from 'node:path';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';

/**
 * B-874 local receipts for issue dispatches (spec §11 "本地 journal 防重复",
 * same idea as Teams receipts). The server owns state; a receipt only fences
 * this machine's side effects: once a spawn has begun, a re-claim of the same
 * dispatch (lease expiry, daemon restart) never spawns a second session — it
 * recovers the session or reports the outcome as unknown. No issue text is
 * written here (the prompt stays in memory).
 */

export type IssueReceiptPhase = 'claimed' | 'spawning' | 'spawned' | 'delivered' | 'completed' | 'failed';

export type IssueReceipt = {
    dispatchId: string;
    kind: 'spawn' | 'message';
    runId: string;
    issueId: string;
    claimId: string;
    phase: IssueReceiptPhase;
    sessionId?: string;
    /** Run session that has exited (no more session events for it). */
    ended?: boolean;
    updatedAt: number;
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Receipts older than this are pruned (the server's lease and run state long since settled). */
export const ISSUE_RECEIPT_TTL_MS = 7 * 24 * 3600_000;

function dir(home: string) { return join(home, 'issues', 'receipts'); }

export function readIssueReceipt(home: string, dispatchId: string): IssueReceipt | null {
    if (!ID.test(dispatchId)) return null;
    try { return JSON.parse(readFileSync(join(dir(home), `${dispatchId}.json`), 'utf8')) as IssueReceipt; }
    catch { return null; }
}

export function writeIssueReceipt(home: string, receipt: IssueReceipt): void {
    if (!ID.test(receipt.dispatchId)) throw new Error('Invalid dispatch id');
    ensurePrivateDirectorySync(dir(home));
    writePrivateFileSync(join(dir(home), `${receipt.dispatchId}.json`), JSON.stringify({ ...receipt, updatedAt: Date.now() }));
}

/** All receipts; expired ones are deleted on the way. */
export function listIssueReceipts(home: string, now = Date.now()): IssueReceipt[] {
    let files: string[];
    try { files = readdirSync(dir(home)); } catch { return []; }
    const out: IssueReceipt[] = [];
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const path = join(dir(home), file);
        try {
            const receipt = JSON.parse(readFileSync(path, 'utf8')) as IssueReceipt;
            const at = typeof receipt.updatedAt === 'number' ? receipt.updatedAt : statSync(path).mtimeMs;
            if (now - at > ISSUE_RECEIPT_TTL_MS) { unlinkSync(path); continue; }
            out.push(receipt);
        } catch { /* unreadable: leave it for a human */ }
    }
    return out;
}
