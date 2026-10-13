import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeStore } from './store';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'vh-wt-store-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

it('approvals are keyed by machine + repo + hash, stored 0600 in a 0700 dir', () => {
    const store = new WorktreeStore(home);
    store.approve({ machineId: 'm', repoRoot: '/r', hash: 'h1', runner: 'posix-sh', approvedAt: 1 });
    expect(store.isApproved('m', '/r', 'h1')).toBe(true);
    expect(store.isApproved('m2', '/r', 'h1')).toBe(false);
    expect(store.isApproved('m', '/r2', 'h1')).toBe(false);
    expect(store.hasOtherApproval('m', '/r', 'h2')).toBe(true);
    if (process.platform !== 'win32') {
        expect(statSync(store.dir).mode & 0o777).toBe(0o700);
        expect(statSync(join(store.dir, 'approvals.json')).mode & 0o777).toBe(0o600);
    }
});

it('prunes the oldest run dirs but keeps active ones', () => {
    const store = new WorktreeStore(home);
    for (let i = 0; i < 5; i++) mkdirSync(join(store.dir, 'runs', `r${i}`), { recursive: true });
    expect(store.pruneRuns(new Set(['r0']), 2)).toBe(2);
    expect(readdirSync(join(store.dir, 'runs')).sort()).toEqual(['r0', 'r3', 'r4']);
});
