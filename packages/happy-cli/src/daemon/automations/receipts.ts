/**
 * Local execution receipts for automation runs (B-496): `~/.happy/automation-receipts.json`.
 *
 * The server owns run state; this file only fences OS side effects. A run id
 * recorded here is never spawned twice, whatever the server says after a
 * daemon restart. `starting` means a spawn / script launch was attempted and
 * its outcome is unknown until the next phase is written; a restart that finds
 * it reports `failed` + attention instead of trying again (spec: 未知结果报
 * failed + attention，不重试).
 */
import { readFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';

export type AutomationReceiptPhase = 'starting' | 'running' | 'finished';
export interface AutomationReceipt {
    runId: string;
    automationId: string;
    kind: 'spawn' | 'send' | 'script';
    phase: AutomationReceiptPhase;
    claimId: string;
    sessionId?: string;
    stickyKey?: string;
    /** Worktree created for this run (never removed automatically). */
    directory?: string;
    updatedAt: number;
}

/** Keep the file bounded; finished receipts older than this are pruned on write. */
export const RECEIPT_RETENTION_MS = 7 * 86_400_000;
export const RECEIPT_MAX_ENTRIES = 2000;

export function receiptsPath(home: string): string { return join(home, 'automation-receipts.json'); }

export function readReceipts(home: string): Record<string, AutomationReceipt> {
    let raw: string;
    try { raw = readFileSync(receiptsPath(home), 'utf8'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
    }
    // Corruption must never turn into permission to spawn again.
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.receipts !== 'object') throw new Error('Invalid automation receipts file');
    return parsed.receipts;
}

export function readReceipt(home: string, runId: string): AutomationReceipt | null {
    return readReceipts(home)[runId] ?? null;
}

export function writeReceipt(home: string, receipt: Omit<AutomationReceipt, 'updatedAt'>, now: number = Date.now()): AutomationReceipt {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.runId)) throw new Error('Invalid automation run id');
    const all = readReceipts(home);
    const next: AutomationReceipt = { ...receipt, updatedAt: now };
    all[receipt.runId] = next;
    // Prune old finished entries; unfinished ones stay until they are resolved.
    const entries = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);
    const kept: Record<string, AutomationReceipt> = {};
    let finished = 0;
    for (const entry of entries) {
        if (entry.phase === 'finished') {
            if (now - entry.updatedAt > RECEIPT_RETENTION_MS || finished >= RECEIPT_MAX_ENTRIES) continue;
            finished++;
        }
        kept[entry.runId] = entry;
    }
    const target = receiptsPath(home);
    ensurePrivateDirectorySync(dirname(target));
    const tmp = `${target}.${process.pid}.tmp`;
    writePrivateFileSync(tmp, JSON.stringify({ version: 1, receipts: kept }));
    const file = openSync(tmp, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(tmp, target);
    // Persist the rename before a process launch can make the effect irreversible.
    if (process.platform !== 'win32') {
        const directory = openSync(dirname(target), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return next;
}
