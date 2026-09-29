import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileCacheDir, happyHomeDirFromEnv, pruneStaleCompileCaches } from './compileCache';

describe('compile cache (B-512)', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    it('lives under the happy home, one directory per CLI version', () => {
        expect(happyHomeDirFromEnv({ HAPPY_HOME_DIR: '~/x' }, '/home/u')).toBe('/home/u/x');
        expect(happyHomeDirFromEnv({}, '/home/u')).toBe('/home/u/.happy');
        expect(compileCacheDir('/h', '0.2.160')).toBe('/h/cache/compile/0.2.160');
        expect(compileCacheDir('/h', '1.0.0/../x')).toBe('/h/cache/compile/1.0.0_.._x');
    });

    it('prunes the caches of other versions and keeps the current one', async () => {
        const home = mkdtempSync(join(tmpdir(), 'vh-cc-'));
        dirs.push(home);
        for (const v of ['0.2.158', '0.2.159', '0.2.160']) {
            mkdirSync(compileCacheDir(home, v), { recursive: true });
            writeFileSync(join(compileCacheDir(home, v), 'entry'), 'x');
        }
        const removed = await pruneStaleCompileCaches(home, '0.2.160');
        expect(removed.sort()).toEqual(['0.2.158', '0.2.159']);
        expect(existsSync(compileCacheDir(home, '0.2.160'))).toBe(true);
        expect(existsSync(compileCacheDir(home, '0.2.159'))).toBe(false);
    });

    it('is a no-op without a cache directory', async () => {
        expect(await pruneStaleCompileCaches(join(tmpdir(), 'vh-cc-missing-home'), '1.0.0')).toEqual([]);
    });
});
