import { createHash } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TEAM_SKILL } from './resources';
export type TeamSkillHost = 'claude' | 'codex' | 'pi';
const roots = { claude: ['.claude', 'skills'], codex: ['.codex', 'skills'], pi: ['.pi', 'agent', 'skills'] } as const;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function read(path: string): Promise<string | null> {
    try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing non-regular managed file'); return await readFile(path, 'utf8'); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function installTeamSkill(options: { host: TeamSkillHost; home: string; apply?: boolean; uninstall?: boolean }) {
    const directory = join(resolve(options.home), ...roots[options.host], 'very-happy-teams');
    const file = join(directory, 'SKILL.md');
    const manifest = join(directory, '.very-happy-managed.json');
    const current = await read(file);
    const managed = await read(manifest);
    const previous = managed ? JSON.parse(managed) : null;
    if (current !== null && (!previous || previous.owner !== 'very-happy' || previous.sha256 !== digest(current))) {
        throw new Error('Existing skill is not owned by Very Happy or was edited; preserve it and resolve manually');
    }
    const action = options.uninstall ? (current === null ? 'unchanged' : 'remove') : current === TEAM_SKILL ? 'unchanged' : 'write';
    if (options.apply && action !== 'unchanged') {
        if (options.uninstall) { await unlink(file); await unlink(manifest); await rmdir(directory).catch(() => {}); }
        else {
            await mkdir(directory, { recursive: true });
            await writeFile(file, TEAM_SKILL);
            await writeFile(manifest, JSON.stringify({ owner: 'very-happy', sha256: digest(TEAM_SKILL), version: 1 }));
        }
    }
    return { host: options.host, path: file, action, applied: !!options.apply, managedSessions: 'Team tools are injected by Very Happy. Standalone agents require a managed session connection.' };
}
