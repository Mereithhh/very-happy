import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fsMkdir, mkdirTarget } from './fsMkdir';

describe('B-755 fs-mkdir path policy', () => {
    const home = '/home/u';
    it('accepts folders strictly inside home, with ~ and trailing slashes', () => {
        expect(mkdirTarget('~/projects/demo', home)).toBe('/home/u/projects/demo');
        expect(mkdirTarget('/home/u/projects/demo/', home)).toBe('/home/u/projects/demo');
    });
    it('refuses .., relative paths, home itself and anything outside home', () => {
        expect(() => mkdirTarget('~/projects/../../etc', home)).toThrow('invalid-path');
        expect(() => mkdirTarget('/home/u/a/..', home)).toThrow('invalid-path');
        expect(() => mkdirTarget('projects/demo', home)).toThrow('invalid-path');
        expect(() => mkdirTarget('', home)).toThrow('invalid-path');
        expect(() => mkdirTarget('~', home)).toThrow('outside-home');
        expect(() => mkdirTarget('/etc/demo', home)).toThrow('outside-home');
        expect(() => mkdirTarget('/home/u2/demo', home)).toThrow('outside-home');
    });
});

describe('B-755 fs-mkdir on disk', () => {
    const base = join(homedir(), 'code/github/skills/tmp/fs-mkdir-tests');
    const fresh = async () => { await mkdir(base, { recursive: true }); return mkdtemp(join(base, 'home-')); };
    it('creates nested folders, runs git init on request, never reuses an existing path', async () => {
        const home = await fresh();
        try {
            const inits: string[] = [];
            const made = await fsMkdir('~/projects/demo', { gitInit: true }, home, async d => { inits.push(d); });
            expect(made).toEqual({ path: join(home, 'projects/demo'), created: true, git: true });
            expect((await stat(made.path)).isDirectory()).toBe(true);
            expect(inits).toEqual([made.path]);
            await expect(fsMkdir('~/projects/demo', {}, home)).rejects.toThrow('exists');
            const gitFails = await fsMkdir('~/projects/other', { gitInit: true }, home, async () => { throw new Error('no git'); });
            expect(gitFails.git).toBe(false);
            expect(existsSync(gitFails.path)).toBe(true);
            await writeFile(join(home, 'file'), 'x');
            await expect(fsMkdir('~/file/sub', {}, home)).rejects.toThrow('not-a-directory');
        } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('a symlink inside home that points outside it is refused', async () => {
        const home = await fresh(); const outside = await fresh();
        try {
            await symlink(outside, join(home, 'escape'));
            await expect(fsMkdir('~/escape/demo', {}, home)).rejects.toThrow('outside-home');
            expect(existsSync(join(outside, 'demo'))).toBe(false);
        } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
    });
});
