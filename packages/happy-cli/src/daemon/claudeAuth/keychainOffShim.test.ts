import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shim = resolve(__dirname, '../../../scripts/shims/keychain-off/security');

function makeFakeSecurity(): { bin: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'vh-shim-'));
    const log = join(dir, 'calls.log');
    const bin = join(dir, 'security');
    writeFileSync(bin, `#!/bin/bash\nprintf 'ARGS:%s\\n' "$*" >> "${log}"\nif [ "\${1:-}" = "-i" ]; then printf 'STDIN:%s\\n' "$(cat)" >> "${log}"; fi\nexit 0\n`);
    chmodSync(bin, 0o755);
    writeFileSync(log, '');
    return { bin, log };
}

function run(args: string[], stdin?: string, env?: Record<string, string>) {
    const fake = makeFakeSecurity();
    const r = spawnSync(shim, args, { input: stdin, env: { PATH: '/usr/bin:/bin', HAPPY_SECURITY_BIN: fake.bin, ...env }, encoding: 'utf8' });
    return { code: r.status, log: readFileSync(fake.log, 'utf8') };
}

describe.skipIf(process.platform === 'win32')('keychain-off security shim (D8)', () => {
    it('is executable and bash', () => {
        expect(execFileSync('head', ['-1', shim], { encoding: 'utf8' }).trim()).toBe('#!/bin/bash');
    });
    it('blocks Claude Code items in argv form (all service suffixes) with exit 36', () => {
        for (const service of ['Claude Code-credentials', 'Claude Code-credentials-ab12cd34', 'Claude Code-custom-oauth-credentials']) {
            for (const cmd of ['find-generic-password', 'add-generic-password', 'delete-generic-password']) {
                const r = run([cmd, '-a', 'jojo', '-w', '-s', service]);
                expect(r.code, `${cmd} ${service}`).toBe(36);
                expect(r.log).toBe('');
            }
        }
    });
    it('blocks show-keychain-info', () => {
        expect(run(['show-keychain-info']).code).toBe(36);
    });
    it('passes other services and other subcommands through', () => {
        const a = run(['find-generic-password', '-s', 'other-service', '-w']);
        expect(a.code).toBe(0); expect(a.log).toContain('ARGS:find-generic-password -s other-service -w');
        const b = run(['list-keychains']);
        expect(b.code).toBe(0); expect(b.log).toContain('ARGS:list-keychains');
    });
    it('blocks the -i/stdin write form used by Claude Code without calling the real binary', () => {
        const r = run(['-i'], 'add-generic-password -U -a jojo -s "Claude Code-credentials" -X 00\n');
        expect(r.code).toBe(36);
        expect(r.log).toBe('');
    });
    it('passes -i/stdin for other services through with the same stdin', () => {
        const r = run(['-i'], 'add-generic-password -U -a jojo -s "other" -X 00\n');
        expect(r.code).toBe(0);
        expect(r.log).toContain('ARGS:-i');
        expect(r.log).toContain('STDIN:add-generic-password -U -a jojo -s "other" -X 00');
    });
});
