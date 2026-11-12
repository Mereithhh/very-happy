import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_RESTART_LANDINGS_FILE, autoRestartLandingStore } from './autoRestartLandingStore';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('B-931 restart records survive a daemon restart', () => {
    it('writes atomically (0600) and reads back; a missing or corrupt file reads as empty', () => {
        const home = mkdtempSync(join(tmpdir(), 'vh-b931-')); dirs.push(home);
        const store = autoRestartLandingStore(home, () => 5000);
        expect(store.read()).toEqual({});
        store.write({ s: { kind: 'agent', from: '0.154.0', target: '0.167.2', at: 4000, noEffect: true } });
        const file = join(home, AUTO_RESTART_LANDINGS_FILE);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(autoRestartLandingStore(home, () => 5000).read()).toEqual({ s: { kind: 'agent', from: '0.154.0', target: '0.167.2', at: 4000, noEffect: true } });
        expect(JSON.parse(readFileSync(file, 'utf8')).s.from).toBe('0.154.0');
        writeFileSync(file, '{not json');
        expect(store.read()).toEqual({});
    });
});
