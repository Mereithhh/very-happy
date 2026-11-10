import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { installManagedSkill } from '@/teams/install';
import { installVeryHappySkill, refreshVeryHappySkillOnDaemonStart } from './install';
import { handleSkillCommand } from '@/commands/skill';
import { renderReference, renderSkill } from './content';

const base = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
async function withHome(run: (home: string) => Promise<void>) {
    await mkdir(base, { recursive: true });
    const home = await mkdtemp(join(base, 'vh-skill-'));
    try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

describe('B-917 very-happy skill installation', () => {
    it('writes SKILL.md + references, is idempotent, and removes only what it owns', () => withHome(async (home) => {
        const preview = await installVeryHappySkill({ host: 'claude', home });
        expect(preview.action).toBe('write');
        await expect(readFile(preview.path)).rejects.toThrow();
        await installVeryHappySkill({ host: 'codex', home, apply: true });
        const dir = join(preview.path, '..');
        expect(await readFile(preview.path, 'utf8')).toBe(renderSkill());
        expect(await readFile(join(dir, 'references/automations.md'), 'utf8')).toBe(renderReference('automations'));
        expect((await installVeryHappySkill({ host: 'pi', home, apply: true })).action).toBe('unchanged');
        await writeFile(join(dir, 'my-note.md'), 'keep');
        await installVeryHappySkill({ host: 'claude', home, apply: true, uninstall: true });
        expect(await readdir(dir)).toEqual(['my-note.md']);
    }));

    it('never overwrites an edited reference file and leaves the install untouched', () => withHome(async (home) => {
        const result = await installVeryHappySkill({ host: 'claude', home, apply: true });
        const edited = join(result.path, '..', 'references/sessions.md');
        await writeFile(edited, 'my own notes');
        await expect(installVeryHappySkill({ host: 'claude', home, apply: true })).rejects.toThrow('references/sessions.md');
        await expect(installVeryHappySkill({ host: 'claude', home, apply: true, uninstall: true })).rejects.toThrow('edited');
        expect(await readFile(edited, 'utf8')).toBe('my own notes');
    }));

    it('updates changed files and drops a reference that no longer exists', () => withHome(async (home) => {
        const v1 = { name: 'vh-probe', content: 'one', managedSessions: '', files: { 'references/a.md': 'A1', 'references/old.md': 'O' } };
        const first = await installManagedSkill(v1, { host: 'claude', home, apply: true });
        const dir = join(first.path, '..');
        const v2 = { ...v1, files: { 'references/a.md': 'A2' } };
        expect((await installManagedSkill(v2, { host: 'claude', home, apply: true })).action).toBe('write');
        expect(await readFile(join(dir, 'references/a.md'), 'utf8')).toBe('A2');
        expect(await readdir(join(dir, 'references'))).toEqual(['a.md']);
        expect((await installManagedSkill(v2, { host: 'claude', home, apply: true })).action).toBe('unchanged');
        await expect(installManagedSkill({ ...v1, files: { '../escape.md': 'x' } }, { host: 'claude', home })).rejects.toThrow('Invalid managed skill file');
    }));

    it('a user file that collides with a new reference is refused, not overwritten', () => withHome(async (home) => {
        const v1 = { name: 'vh-probe', content: 'one', managedSessions: '', files: { 'references/a.md': 'A' } };
        const first = await installManagedSkill(v1, { host: 'claude', home, apply: true });
        await writeFile(join(first.path, '..', 'references/b.md'), 'mine');
        await expect(installManagedSkill({ ...v1, files: { ...v1.files, 'references/b.md': 'B' } }, { host: 'claude', home, apply: true })).rejects.toThrow('references/b.md');
    }));

    it('daemon refresh: only for the default HAPPY_HOME_DIR, and an edited copy is logged, not forced', () => withHome(async (home) => {
        const logs: string[] = [];
        expect(await refreshVeryHappySkillOnDaemonStart({ happyHomeDir: join(home, 'isolated'), home, log: (m) => logs.push(m) })).toBe('skipped');
        await expect(readdir(join(home, '.local'))).rejects.toThrow();
        expect(await refreshVeryHappySkillOnDaemonStart({ happyHomeDir: join(home, '.happy'), home, log: (m) => logs.push(m) })).toBe('write');
        expect(await refreshVeryHappySkillOnDaemonStart({ happyHomeDir: join(home, '.happy'), home, log: (m) => logs.push(m) })).toBe('unchanged');
        const skill = join(home, '.local/share/very-happy/skills/very-happy/SKILL.md');
        await writeFile(skill, 'edited');
        expect(await refreshVeryHappySkillOnDaemonStart({ happyHomeDir: join(home, '.happy'), home, log: (m) => logs.push(m) })).toBe('refused');
        expect(await readFile(skill, 'utf8')).toBe('edited');
        expect(logs).toHaveLength(1);
    }));
});

describe('B-917 very-happy skill command', () => {
    const run = async (args: string[]) => { const out: string[] = []; await handleSkillCommand(args, (text) => out.push(text)); return out.join('\n'); };
    it('prints the map, one area, a JSON listing, and refuses an unknown area', async () => {
        expect(await run([])).toBe(renderSkill());
        expect(await run(['automations'])).toBe(renderReference('automations'));
        const listing = JSON.parse(await run(['--json']));
        expect(listing.areas.map((area: { id: string }) => area.id)).toContain('issues-todos');
        expect(await run(['--help'])).toContain('very-happy skill <area>');
        await expect(run(['nope'])).rejects.toThrow('Unknown area "nope"');
    });
});
