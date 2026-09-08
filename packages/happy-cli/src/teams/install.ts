import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile, unlink, rmdir, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { TEAM_SKILL } from './resources';
export type TeamSkillHost = 'claude' | 'codex' | 'pi';
// Never write host discovery roots: they can be symlinks to shared skill repositories.
async function assertPrivateDestination(directory: string): Promise<void> {
    for (let path = directory; ; path = dirname(path)) {
        try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Refusing symlink or non-directory in managed skill destination: ' + path);
        } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        if (dirname(path) === path) break;
    }
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function read(path: string): Promise<string | null> {
    try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing non-regular managed file'); return await readFile(path, 'utf8'); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
async function publish(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.new`;
    try {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
}
export async function installTeamSkill(options: { host: TeamSkillHost; home: string; apply?: boolean; uninstall?: boolean }) {
    const directory = join(resolve(options.home), '.local', 'share', 'very-happy', 'skills', 'very-happy-teams');
    await assertPrivateDestination(directory);
    const file = join(directory, 'SKILL.md');
    const manifest = join(directory, '.very-happy-managed.json');
    const current = await read(file);
    const managed = await read(manifest);
    const previous = managed ? JSON.parse(managed) : null;
    if (previous && previous.owner !== 'very-happy') throw new Error('Existing manifest is not owned by Very Happy');
    if (current !== null && (!previous || previous.owner !== 'very-happy' || (previous.sha256 !== digest(current) && previous.pendingSha256 !== digest(current)))) {
        throw new Error('Existing skill is not owned by Very Happy or was edited; preserve it and resolve manually');
    }
    const action = options.uninstall ? (current === null && managed === null ? 'unchanged' : 'remove') : current === TEAM_SKILL && !previous?.pendingSha256 ? 'unchanged' : 'write';
    if (options.apply && action !== 'unchanged') {
        await assertPrivateDestination(directory);
        if (options.uninstall) { if (current !== null) await unlink(file); if (managed !== null) await unlink(manifest); await rmdir(directory).catch(() => {}); }
        else {
            await mkdir(directory, { recursive: true });
            // Publish recoverable ownership first. Atomic replacement means the skill is
            // always either the verified old bytes or the declared new bytes, never partial.
            const nextHash = digest(TEAM_SKILL);
            await publish(manifest, JSON.stringify({ owner: 'very-happy', sha256: current === null ? null : digest(current), pendingSha256: nextHash, version: 1 }));
            await publish(file, TEAM_SKILL);
            await publish(manifest, JSON.stringify({ owner: 'very-happy', sha256: nextHash, version: 1 }));
        }
    }
    return { host: options.host, path: file, action, applied: !!options.apply, discovery: 'No host skill directories are modified. Read this absolute skill path in a managed session.', managedSessions: 'Team tools are injected by Very Happy. Standalone agents require a managed session connection.' };
}
