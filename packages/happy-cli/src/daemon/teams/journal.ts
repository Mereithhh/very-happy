import { readFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';

/** Local effect receipt, not a second task database. Never forget an uncertain spawn. */
export interface TeamEffectReceipt {
    operationId: string;
    teamId: string;
    claimId: string;
    phase: 'prepared' | 'spawning' | 'spawned' | 'delivered' | 'completed';
    sessionId?: string;
    directory?: string;
    repository?: string;
    branch?: string;
    scopeFile?: string;
}
export function receiptPath(home: string, operationId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)) throw new Error('Invalid team operation id');
    return join(home, 'teams', 'effects', `${operationId}.json`);
}
export function readReceipt(home: string, id: string): TeamEffectReceipt | null {
    try {
        const value = JSON.parse(readFileSync(receiptPath(home, id), 'utf8'));
        if (value.operationId !== id || typeof value.claimId !== 'string' || !['prepared', 'spawning', 'spawned', 'delivered', 'completed'].includes(value.phase)) throw new Error('Invalid team effect receipt');
        return value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error; // corruption must never turn into permission to spawn again
    }
}
export function writeReceipt(home: string, receipt: TeamEffectReceipt): void {
    ensurePrivateDirectorySync(join(home, 'teams', 'effects'));
    const target = receiptPath(home, receipt.operationId);
    const tmp = `${target}.${process.pid}.tmp`;
    writePrivateFileSync(tmp, JSON.stringify(receipt));
    const file = openSync(tmp, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(tmp, target);
    // Persist the rename before a process launch can make the effect irreversible.
    if (process.platform !== 'win32') {
        const directory = openSync(join(home, 'teams', 'effects'), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
    }
}
