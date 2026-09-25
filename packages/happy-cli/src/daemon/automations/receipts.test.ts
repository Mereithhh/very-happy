import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RECEIPT_MAX_ENTRIES, RECEIPT_RETENTION_MS, readReceipt, readReceipts, receiptsPath, writeReceipt } from './receipts';

let home: string;
beforeEach(() => {
    const root = join(homedir(), 'code/github/skills/tmp/vh-automation/tests');
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, 'receipts-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('automation receipts', () => {
    it('round-trips phases atomically and rejects bad ids', () => {
        expect(readReceipts(home)).toEqual({});
        writeReceipt(home, { runId: 'r1', automationId: 'a1', kind: 'spawn', phase: 'starting', claimId: 'c1' }, 10);
        writeReceipt(home, { runId: 'r1', automationId: 'a1', kind: 'spawn', phase: 'running', claimId: 'c1', sessionId: 's1' }, 20);
        expect(readReceipt(home, 'r1')).toEqual({ runId: 'r1', automationId: 'a1', kind: 'spawn', phase: 'running', claimId: 'c1', sessionId: 's1', updatedAt: 20 });
        expect(() => writeReceipt(home, { runId: '../x', automationId: 'a', kind: 'script', phase: 'starting', claimId: 'c' })).toThrow('Invalid');
    });
    it('prunes old finished receipts but never unfinished ones', () => {
        const now = 1_000_000_000_000;
        // Seed the ledger directly: one fsynced write per entry would take seconds.
        const seeded: Record<string, unknown> = {
            'old-done': { runId: 'old-done', automationId: 'a', kind: 'script', phase: 'finished', claimId: 'c', updatedAt: now - RECEIPT_RETENTION_MS - 1 },
            'old-open': { runId: 'old-open', automationId: 'a', kind: 'spawn', phase: 'starting', claimId: 'c', updatedAt: now - RECEIPT_RETENTION_MS - 1 },
        };
        for (let i = 0; i < RECEIPT_MAX_ENTRIES + 5; i++) seeded[`done-${i}`] = { runId: `done-${i}`, automationId: 'a', kind: 'script', phase: 'finished', claimId: 'c', updatedAt: now - 1000 + i };
        writeFileSync(receiptsPath(home), JSON.stringify({ version: 1, receipts: seeded }));
        writeReceipt(home, { runId: 'fresh', automationId: 'a', kind: 'send', phase: 'running', claimId: 'c' }, now);
        const receipts = readReceipts(home);
        expect(receipts['old-done']).toBeUndefined();
        expect(receipts['old-open']).toBeDefined();
        expect(receipts.fresh).toBeDefined();
        expect(Object.keys(receipts).filter((k) => k.startsWith('done-'))).toHaveLength(RECEIPT_MAX_ENTRIES);
    });
    it('treats a corrupt file as a hard error, never as an empty ledger', () => {
        writeFileSync(receiptsPath(home), '{"nope":1}');
        expect(() => readReceipts(home)).toThrow('Invalid automation receipts');
        writeFileSync(receiptsPath(home), 'not json');
        expect(() => readReceipt(home, 'r')).toThrow();
        expect(JSON.parse(readFileSync(receiptsPath(home), 'utf8').length ? '1' : '0')).toBe(1);
    });
});
