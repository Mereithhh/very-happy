import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { installAutomationSkill } from './install';
import { installTeamSkill } from '@/teams/install';
import { AUTOMATION_SKILL } from './resources';

describe('automations skill installation', () => {
    it('materializes next to the Teams skill through the same owned-file mechanism', async () => {
        const base = join(homedir(), 'code/github/skills/tmp/vh-automation/tests');
        await mkdir(base, { recursive: true });
        const home = await mkdtemp(join(base, 'install-'));
        try {
            const preview = await installAutomationSkill({ host: 'claude', home });
            expect(preview.action).toBe('write');
            expect(preview.path).toBe(join(home, '.local/share/very-happy/skills/very-happy-automations/SKILL.md'));
            await expect(readFile(preview.path)).rejects.toThrow();
            const applied = await installAutomationSkill({ host: 'claude', home, apply: true });
            expect(applied.skill).toBe('very-happy-automations');
            expect(await readFile(applied.path, 'utf8')).toBe(AUTOMATION_SKILL);
            expect(AUTOMATION_SKILL).toContain('name: very-happy-automations');
            expect((await installAutomationSkill({ host: 'codex', home, apply: true })).action).toBe('unchanged');
            const teams = await installTeamSkill({ host: 'pi', home, apply: true });
            expect(teams.path).toBe(join(home, '.local/share/very-happy/skills/very-happy-teams/SKILL.md'));
            expect(await readFile(applied.path, 'utf8')).toBe(AUTOMATION_SKILL);
            await installAutomationSkill({ host: 'claude', home, apply: true, uninstall: true });
            await expect(readFile(applied.path)).rejects.toThrow();
            expect(await readFile(teams.path, 'utf8')).toContain('name: very-happy-teams');
        } finally { await rm(home, { recursive: true, force: true }); }
    });
});
