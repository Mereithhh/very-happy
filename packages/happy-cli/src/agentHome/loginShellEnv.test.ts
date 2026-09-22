import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loginShellProbeScript, parseLoginShellEnv, probeLoginShellEnv, LOGIN_SHELL_ENV_MARKER } from './loginShellEnv';

const NAMES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;

describe('loginShellProbeScript', () => {
    it('prints one marker line per variable with a single printf', () => {
        expect(loginShellProbeScript(NAMES))
            .toBe(`printf '${LOGIN_SHELL_ENV_MARKER}%s=%s\\n' CLAUDE_CONFIG_DIR "$CLAUDE_CONFIG_DIR" CODEX_HOME "$CODEX_HOME"`);
    });
});

describe('parseLoginShellEnv', () => {
    it('ignores banners and prompts around the marker lines', () => {
        const out = [
            'Welcome to the box',
            `${LOGIN_SHELL_ENV_MARKER}CLAUDE_CONFIG_DIR=/mnt/data/.claude`,
            `wei@box:~$ ${LOGIN_SHELL_ENV_MARKER}CODEX_HOME=`,
            `${LOGIN_SHELL_ENV_MARKER}PATH=/should/be/ignored`,
        ].join('\n');
        expect(parseLoginShellEnv(out, NAMES)).toEqual({ CLAUDE_CONFIG_DIR: '/mnt/data/.claude', CODEX_HOME: undefined });
    });

    it('returns an empty object when nothing matched', () => {
        expect(parseLoginShellEnv('', NAMES)).toEqual({});
    });
});

describe('probeLoginShellEnv', () => {
    it('is null on Windows', async () => {
        expect(await probeLoginShellEnv(NAMES, { platform: 'win32' })).toBeNull();
    });

    it('is null when the shell does not exist', async () => {
        expect(await probeLoginShellEnv(NAMES, { platform: 'linux', shell: '/nonexistent/shell-b478' })).toBeNull();
    });

    it.skipIf(process.platform === 'win32')('reads what /bin/sh exports', async () => {
        const env = await probeLoginShellEnv(NAMES, {
            platform: 'linux',
            shell: '/bin/sh',
            // ENV is how a POSIX sh finds its interactive rc; point it nowhere
            // so the host's real rc files cannot interfere with the assertion.
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ENV: '/dev/null', CLAUDE_CONFIG_DIR: '/from/parent' },
        });
        expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/from/parent', CODEX_HOME: undefined });
    });

    it.skipIf(process.platform === 'win32')('gives up on a shell that hangs', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'vh-b478-'));
        const shell = join(dir, 'hanging-shell');
        writeFileSync(shell, '#!/bin/sh\nsleep 30\n');
        chmodSync(shell, 0o755);
        const started = Date.now();
        const env = await probeLoginShellEnv(NAMES, { platform: 'linux', shell, timeoutMs: 200 });
        expect(env).toBeNull();
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});
