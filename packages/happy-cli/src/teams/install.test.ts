import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { installTeamSkill } from './install';

describe('official skill installation', () => {
    it('previews, installs idempotently, refuses edited files, and removes only owned files', async () => {
        const base = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        await mkdir(base, { recursive: true });
        const home = await mkdtemp(join(base, 'install-'));
        try {
            const preview = await installTeamSkill({ host: 'codex', home });
            await expect(readFile(preview.path)).rejects.toThrow();
            await installTeamSkill({ host: 'codex', home, apply: true });
            expect((await installTeamSkill({ host: 'codex', home, apply: true })).action).toBe('unchanged');
            const original = await readFile(preview.path, 'utf8');
            await writeFile(preview.path, 'User edits');
            await expect(installTeamSkill({ host: 'codex', home, apply: true, uninstall: true })).rejects.toThrow('edited');
            await writeFile(preview.path, original);
            await writeFile(join(preview.path, '..', 'my-note.md'), 'keep');
            await installTeamSkill({ host: 'codex', home, apply: true, uninstall: true });
            expect(await readFile(join(preview.path, '..', 'my-note.md'), 'utf8')).toBe('keep');
        } finally { await rm(home, { recursive: true, force: true }); }
    });
});
