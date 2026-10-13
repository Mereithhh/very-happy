import { describe, expect, it } from 'vitest';
import {
    globSegmentToRegExp, isSafeRelativePattern, parseWorktreeConfig, selectSetupScript, setupScriptHash, EMPTY_CONFIG,
} from './config';

describe('B-585 worktree config', () => {
    it('accepts only provably repo-relative patterns', () => {
        for (const ok of ['.env', '.env*', 'apps/web/.env.local', 'config/*.json', 'node_modules']) expect(isSafeRelativePattern(ok)).toBe(true);
        for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a/./b', 'a//b', 'C:/x', 'c:x', '..\\x', 'a\\b', '~/x', 'a\0b', './x']) {
            expect(isSafeRelativePattern(bad), bad).toBe(false);
        }
    });

    it('globs stay inside one segment', () => {
        const re = globSegmentToRegExp('.env*');
        expect(re.test('.env')).toBe(true);
        expect(re.test('.env.local')).toBe(true);
        expect(re.test('x.env')).toBe(false);
        expect(globSegmentToRegExp('a?c').test('abc')).toBe(true);
        expect(globSegmentToRegExp('a.c').test('abc')).toBe(false);
    });

    it('no file: web gets the .env* default, teams/automation get nothing', () => {
        expect(parseWorktreeConfig(null, 'web')).toMatchObject({ source: 'default', config: { copy: ['.env*'], link: [], setup: null } });
        expect(parseWorktreeConfig(null, 'teams')).toMatchObject({ source: 'none', config: { copy: [], link: [], setup: null } });
        expect(parseWorktreeConfig(null, 'automation').config.copy).toEqual([]);
    });

    it('invalid JSON or a non-object ignores the whole file', () => {
        expect(parseWorktreeConfig('{', 'web')).toMatchObject({ source: 'invalid', config: EMPTY_CONFIG });
        expect(parseWorktreeConfig('[]', 'web').source).toBe('invalid');
    });

    it('drops unsafe entries, globbed links and clamps the timeout', () => {
        const parsed = parseWorktreeConfig(JSON.stringify({
            copy: ['.env', '../secret', '/abs'], link: ['node_modules', 'pkgs/*'], setup: 'pnpm i', setupTimeoutMinutes: 999,
        }), 'teams');
        expect(parsed.source).toBe('file');
        expect(parsed.config.copy).toEqual(['.env']);
        expect(parsed.config.link).toEqual(['node_modules']);
        expect(parsed.config.setupTimeoutMinutes).toBe(60);
        expect(parsed.errors.join('\n')).toContain('../secret');
        expect(parsed.errors.join('\n')).toContain('globs are not allowed');
    });

    it('selects the runner per platform; Windows refuses #! scripts', () => {
        const config = { ...EMPTY_CONFIG, setup: '#!/bin/bash\nmake' };
        expect(selectSetupScript(config, 'darwin')).toMatchObject({ kind: 'script', runner: 'shebang' });
        expect(selectSetupScript({ ...config, setup: 'pnpm i' }, 'linux')).toMatchObject({ kind: 'script', runner: 'posix-sh' });
        expect(selectSetupScript(config, 'win32')).toMatchObject({ kind: 'unsupported' });
        expect(selectSetupScript({ ...config, setupWindows: 'pnpm i' }, 'win32')).toMatchObject({ kind: 'script', runner: 'cmd', script: 'pnpm i' });
        expect(selectSetupScript(EMPTY_CONFIG, 'linux')).toEqual({ kind: 'none' });
    });

    it('the hash binds the runner and every byte', () => {
        expect(setupScriptHash('posix-sh', 'pnpm i')).not.toBe(setupScriptHash('cmd', 'pnpm i'));
        expect(setupScriptHash('posix-sh', 'pnpm i')).not.toBe(setupScriptHash('posix-sh', 'pnpm i '));
        expect(setupScriptHash('posix-sh', 'pnpm i')).toBe(setupScriptHash('posix-sh', 'pnpm i'));
    });
});
