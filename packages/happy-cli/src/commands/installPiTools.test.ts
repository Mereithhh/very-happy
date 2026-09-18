import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { handleInstallPiTools, installPiTools, piToolsLoader } from './installPiTools';

describe('native Pi extension installation', () => {
    afterEach(() => vi.unstubAllEnvs());
    it('installs idempotently and removes only the owned loader without changing Pi settings or other extensions', async () => {
        const base = join(homedir(), 'code/github/skills/tmp/pi-terminal-session-tools/tests');
        await mkdir(base, { recursive: true });
        const agentDir = await mkdtemp(join(base, 'pi-'));
        vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
        try {
            const extensions = join(agentDir, 'extensions');
            await mkdir(extensions);
            await writeFile(join(agentDir, 'settings.json'), '{"model":"keep-me"}');
            await writeFile(join(extensions, 'mine.js'), '// mine');
            const target = await installPiTools();
            const original = await readFile(target, 'utf8');
            expect(target).toBe(join(extensions, 'very-happy-terminal-tools.js'));
            await installPiTools();
            expect(await readFile(target, 'utf8')).toBe(original);
            await writeFile(target, piToolsLoader(join(agentDir, 'old-install/dist/piExtension.mjs')));
            await installPiTools();
            expect(await readFile(target, 'utf8')).toBe(original);
            await writeFile(target, original + '// custom changes\n');
            await expect(installPiTools()).rejects.toThrow('custom extension');
            await expect(installPiTools(true)).rejects.toThrow('custom extension');
            await rm(target);
            await symlink(join(extensions, 'mine.js'), target);
            await expect(installPiTools()).rejects.toThrow('custom extension');
            await rm(target);
            await installPiTools();
            await installPiTools(true);
            await installPiTools(true);
            expect(await readdir(extensions)).toEqual(['mine.js']);
            expect(await readFile(join(extensions, 'mine.js'), 'utf8')).toBe('// mine');
            expect(await readFile(join(agentDir, 'settings.json'), 'utf8')).toBe('{"model":"keep-me"}');
        } finally { await rm(agentDir, { recursive: true, force: true }); }
    });
    it('rejects unknown options before touching disk', async () => {
        await expect(handleInstallPiTools(['--dry-run'])).rejects.toThrow('Unknown');
    });
});
