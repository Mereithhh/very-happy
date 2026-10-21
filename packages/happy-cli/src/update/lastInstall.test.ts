import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lastInstallStore, parseLastInstall } from './lastInstall';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('last CLI install record (B-718)', () => {
    it('round-trips through the home directory', () => {
        const dir = mkdtempSync(join(tmpdir(), 'b718-')); dirs.push(dir);
        const store = lastInstallStore(dir);
        expect(store.read()).toBeNull();
        store.write({ from: '0.2.179', to: '0.2.180', at: 1, source: 'auto' });
        expect(store.read()).toEqual({ from: '0.2.179', to: '0.2.180', at: 1, source: 'auto' });
    });
    it('rejects malformed or tampered records', () => {
        expect(parseLastInstall({ from: '0.2.179', to: 'latest', at: 1, source: 'auto' })).toBeNull();
        expect(parseLastInstall({ from: '0.2.179', to: '0.2.180', at: '1', source: 'auto' })).toBeNull();
        expect(parseLastInstall({ from: '0.2.179', to: '0.2.180', at: 1, source: 'root' })).toBeNull();
        const dir = mkdtempSync(join(tmpdir(), 'b718-')); dirs.push(dir);
        writeFileSync(join(dir, 'cli-update-last.json'), '{not json');
        expect(lastInstallStore(dir).read()).toBeNull();
    });
});
