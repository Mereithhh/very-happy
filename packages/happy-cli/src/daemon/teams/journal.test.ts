import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { receiptPath, readReceipt, writeReceipt } from './journal';

describe('team effect receipts', () => {
    it('persists uncertain spawn rather than allowing a restart to repeat it', () => {
        const root = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        mkdirSync(root, { recursive: true });
        const home = mkdtempSync(join(root, 'receipt-'));
        try {
            expect(readReceipt(home, 'op1')).toBeNull();
            const receipt = { operationId: 'op1', teamId: 'team1', claimId: 'claim1', phase: 'spawning' as const };
            writeReceipt(home, receipt);
            expect(readReceipt(home, 'op1')).toEqual(receipt);
            writeFileSync(receiptPath(home, 'op1'), '{broken');
            expect(() => readReceipt(home, 'op1')).toThrow();
            expect(() => receiptPath(home, '../elsewhere')).toThrow();
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
