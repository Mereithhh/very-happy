import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refreshAgentHomes, resetAgentHomesCache, locateClaudeConversation, agentHomeSpawnEnv } from './index';

// These run against the real ~/.happy settings of the test user only through
// readSettings(); the shell is always a fake so the host's rc files never matter.
function fakeShell(exports: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'vh-b478-shell-'));
    const shell = join(dir, 'shell');
    writeFileSync(shell, `#!/bin/sh\n${exports}\nexec /bin/sh "$@"\n`);
    chmodSync(shell, 0o755);
    return shell;
}

const saved = { SHELL: process.env.SHELL, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };

describe.skipIf(process.platform === 'win32')('refreshAgentHomes (daemon glue)', () => {
    beforeEach(() => {
        resetAgentHomesCache();
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CODEX_HOME;
    });
    afterEach(() => {
        resetAgentHomesCache();
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    it('a shell that exports nothing leaves the defaults and process.env untouched', async () => {
        process.env.SHELL = fakeShell('');
        const homes = await refreshAgentHomes();
        expect(homes.claudeConfigDir.source).toBe('default');
        expect(homes.codexHome.source).toBe('default');
        expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
        expect(process.env.CODEX_HOME).toBeUndefined();
    });

    it('a broken shell falls back to the daemon env exactly as before', async () => {
        process.env.SHELL = '/nonexistent/shell-b478';
        process.env.CLAUDE_CONFIG_DIR = '/from/daemon';
        const homes = await refreshAgentHomes();
        expect(homes.claudeConfigDir).toEqual({ path: '/from/daemon', source: 'daemon-env' });
        expect(process.env.CLAUDE_CONFIG_DIR).toBe('/from/daemon');
    });

    it('an export in the login shell reaches process.env and the transcript lookup', async () => {
        const persist = mkdtempSync(join(tmpdir(), 'vh-b478-persist-'));
        process.env.SHELL = fakeShell(`export CLAUDE_CONFIG_DIR=${persist}`);
        const homes = await refreshAgentHomes();
        expect(homes.claudeConfigDir).toEqual({ path: persist, source: 'login-shell' });
        expect(process.env.CLAUDE_CONFIG_DIR).toBe(persist);

        const cwd = '/tmp/b478-proj';
        const id = '0d6f2b6e-1111-4222-8333-444455556666';
        const projectDir = join(persist, 'projects', '-tmp-b478-proj');
        require('node:fs').mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, `${id}.jsonl`), '{"uuid":"x"}\n');
        expect(locateClaudeConversation(cwd, id)?.resolved).toBe(true);
        // resolved dir holds it → nothing to override for the spawn
        expect(agentHomeSpawnEnv({ workingDirectory: cwd, claudeSessionId: id })).toEqual({});
    });

    it('a transcript left in the default dir is still found after the shell moved the config dir', async () => {
        const persist = mkdtempSync(join(tmpdir(), 'vh-b478-persist-'));
        const oldDefault = mkdtempSync(join(tmpdir(), 'vh-b478-old-'));
        // simulate: daemon was started with the old dir, shell now exports the new one
        process.env.CLAUDE_CONFIG_DIR = oldDefault;
        process.env.SHELL = fakeShell(`export CLAUDE_CONFIG_DIR=${persist}`);
        await refreshAgentHomes();
        const cwd = '/tmp/b478-proj2';
        const id = '0d6f2b6e-2222-4222-8333-444455556666';
        const projectDir = join(oldDefault, 'projects', '-tmp-b478-proj2');
        require('node:fs').mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, `${id}.jsonl`), '{"uuid":"x"}\n');
        expect(agentHomeSpawnEnv({ workingDirectory: cwd, claudeSessionId: id })).toEqual({ CLAUDE_CONFIG_DIR: oldDefault });
    });
});
