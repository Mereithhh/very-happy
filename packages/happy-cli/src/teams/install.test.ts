import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { installTeamSkill } from './install';

describe('official skill installation', () => {
    it('never traverses shared host roots, and rejects redirected owned destinations', async () => {
        const base = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
        await mkdir(base, { recursive: true });
        const home = await mkdtemp(join(base, 'shared-install-'));
        try {
            const shared = join(home, 'shared-14-roots');
            await mkdir(shared);
            await mkdir(join(home, '.claude'));
            await symlink(shared, join(home, '.claude', 'skills'));
            const result = await installTeamSkill({ host: 'claude', home, apply: true });
            expect(await readdir(shared)).toEqual([]);
            expect(result.path).toBe(join(home, '.local/share/very-happy/skills/very-happy-teams/SKILL.md'));
            await installTeamSkill({ host: 'pi', home, apply: true, uninstall: true });
            expect(await readdir(shared)).toEqual([]);
            await rm(join(home, '.local'), { recursive: true });
            await symlink(shared, join(home, '.local'));
            for (const apply of [false, true]) {
                await expect(installTeamSkill({ host: 'codex', home, apply })).rejects.toThrow('symlink');
                await expect(installTeamSkill({ host: 'codex', home, apply, uninstall: true })).rejects.toThrow('symlink');
            }
            expect(await readdir(shared)).toEqual([]);
        } finally { await rm(home, { recursive: true, force: true }); }
    });

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
